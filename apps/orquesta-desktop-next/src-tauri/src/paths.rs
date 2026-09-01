use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};
use crate::instance_lock::InstanceLock;
use crate::storage::{atomic_write_json, backup_path, private_directory, sync_directory};

const ATTACHMENT_MIGRATION_SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum AttachmentMigrationPhase {
    PromotedPendingLegacyCleanup,
    Complete,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AttachmentMigrationReceipt {
    schema_version: u32,
    phase: AttachmentMigrationPhase,
    remaining_legacy_artifacts: Vec<LegacyAttachmentArtifact>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyAttachmentArtifact {
    key: String,
    sha256: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct LegacyAttachmentInventory {
    sealed_root_exists: bool,
    artifacts: Vec<LegacyAttachmentArtifact>,
}

impl LegacyAttachmentInventory {
    fn is_empty(&self) -> bool {
        !self.sealed_root_exists && self.artifacts.is_empty()
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacySelectionSentinel {
    schema_version: u32,
    batches: Vec<serde_json::Value>,
    retired_selection_ids: Vec<serde_json::Value>,
    #[serde(default)]
    retired_draft_handles: Vec<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyQuarantineSentinel {
    schema_version: u32,
    records: Vec<serde_json::Value>,
}

fn verified_measurement_temp_child(
    candidate: PathBuf,
    required_prefix: &str,
    field: &str,
) -> AppResult<PathBuf> {
    let normalized = candidate.to_string_lossy();
    let temp = std::fs::canonicalize(std::env::temp_dir())
        .map_err(|error| AppError::io("canonicalize measurement temp root", error))?;
    let candidate_parent = candidate
        .parent()
        .ok_or_else(|| AppError::new("measure_path_invalid", format!("{field} has no parent")))?;
    let canonical_parent = std::fs::canonicalize(candidate_parent)
        .map_err(|error| AppError::io("canonicalize measurement parent", error))?;
    if !candidate.is_absolute()
        || candidate
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
        || canonical_parent != temp
        || !candidate
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.starts_with(required_prefix))
    {
        return Err(AppError::new(
            "measure_path_invalid",
            format!("Refusing unsafe {field}: {normalized}"),
        ));
    }
    Ok(candidate)
}

pub fn measurement_project_selection() -> AppResult<Option<PathBuf>> {
    if std::env::var("ORQUESTA_MEASURE_MODE").ok().as_deref() != Some("1") {
        return Ok(None);
    }
    let candidate = match std::env::var("ORQUESTA_NEXT_MEASURE_PROJECT") {
        Ok(value) => PathBuf::from(value),
        Err(std::env::VarError::NotPresent) => return Ok(None),
        Err(error) => {
            return Err(AppError::new(
                "measure_path_invalid",
                format!("Measurement project path is not valid Unicode: {error}"),
            ))
        }
    };
    verified_measurement_temp_child(
        candidate,
        "orquesta-p2e-project-",
        "measurement project path",
    )
    .map(Some)
}

#[derive(Clone, Debug)]
pub struct NativePaths {
    pub root: PathBuf,
    pub projection_data_root: PathBuf,
    pub attachment_data_root: PathBuf,
    pub voice_data_root: PathBuf,
    pub state: PathBuf,
    pub logs: PathBuf,
    pub attachments: PathBuf,
    pub projection: PathBuf,
    pub runtime_dist: PathBuf,
}

impl NativePaths {
    pub fn resolve(app: &AppHandle) -> AppResult<Self> {
        let measure_mode = std::env::var("ORQUESTA_MEASURE_MODE").ok().as_deref() == Some("1");
        let root = if measure_mode {
            let candidate = std::env::var("ORQUESTA_NEXT_MEASURE_DATA")
                .map(PathBuf::from)
                .map_err(|_| {
                    AppError::new(
                        "measure_path_required",
                        "Measurement mode requires ORQUESTA_NEXT_MEASURE_DATA",
                    )
                })?;
            verified_measurement_temp_child(candidate, "orquesta-next-", "measurement data path")?
        } else {
            app.path()
                .app_data_dir()
                .map_err(|error| AppError::new("native_path_unavailable", error.to_string()))?
                .join("Orquesta Next")
        };
        let projection_data_root = if measure_mode {
            root.clone()
        } else {
            app.path()
                .app_local_data_dir()
                .map_err(|error| AppError::new("native_path_unavailable", error.to_string()))?
                .join("Orquesta Next")
        };
        let attachment_data_root = projection_data_root.join("attachments-v2");
        let voice_data_root = projection_data_root.join("voice-v1");
        let paths = Self {
            state: root.join("state").join("state-v1"),
            logs: root.join("logs"),
            attachments: attachment_data_root.join("sealed"),
            projection: projection_data_root.join("projection"),
            runtime_dist: app
                .path()
                .resource_dir()
                .map_err(|error| AppError::new("resource_path_unavailable", error.to_string()))?
                .join("runtime-dist"),
            projection_data_root,
            attachment_data_root,
            voice_data_root,
            root,
        };
        // Only the shared instance-lock parent may be materialized before the
        // lock is owned. Attachment/projection mutation starts after acquire.
        private_directory(&paths.root)?;
        private_directory(&paths.state)?;
        Ok(paths)
    }

    pub fn ensure(&self) -> AppResult<()> {
        private_directory(&self.root)?;
        private_directory(&self.projection_data_root)?;
        private_directory(&self.attachment_data_root)?;
        private_directory(&self.voice_data_root)?;
        private_directory(&self.attachment_state_root())?;
        private_directory(&self.state)?;
        private_directory(&self.logs)?;
        private_directory(&self.attachments)?;
        private_directory(&self.projection)
    }

    pub fn registry(&self) -> PathBuf {
        self.state.join("projects.v1.json")
    }
    pub fn settings(&self) -> PathBuf {
        self.state.join("settings.v1.json")
    }
    pub fn dispatch_recovery(&self) -> PathBuf {
        self.state.join("dispatch-recovery.v1.json")
    }
    pub fn attachment_quarantine(&self) -> PathBuf {
        self.attachment_state_root()
            .join("attachment-quarantine.v1.json")
    }
    pub fn attachment_selections(&self) -> PathBuf {
        self.attachment_state_root()
            .join("attachment-selections.v1.json")
    }
    pub fn runtime_owner(&self) -> PathBuf {
        self.state.join("runtime-owner.v1.json")
    }
    pub fn renderer_sessions(&self) -> PathBuf {
        self.state.join("renderer-sessions.v1.json")
    }
    pub fn projection_root(&self) -> PathBuf {
        self.projection.clone()
    }

    pub fn prepare_voice_authority(&self, instance_lock: &InstanceLock) -> AppResult<()> {
        instance_lock.require_state_root(&self.state)?;
        private_directory(&self.projection_data_root)?;
        verify_direct_local_child(
            &self.projection_data_root,
            &self.voice_data_root,
            "voice-v1",
            "voice_local_path_invalid",
            "Voice data root",
        )?;
        private_directory(&self.voice_data_root)
    }

    fn attachment_state_root(&self) -> PathBuf {
        self.attachment_data_root.join("state")
    }

    fn attachment_migration_receipt(&self) -> PathBuf {
        self.attachment_data_root.join("migration.v1.json")
    }

    fn legacy_attachment_root(&self) -> PathBuf {
        self.root.join("attachments")
    }

    fn legacy_attachment_selections(&self) -> PathBuf {
        self.state.join("attachment-selections.v1.json")
    }

    fn legacy_attachment_quarantine(&self) -> PathBuf {
        self.state.join("attachment-quarantine.v1.json")
    }

    pub fn prepare_attachment_authority(&self, instance_lock: &InstanceLock) -> AppResult<()> {
        instance_lock.require_state_root(&self.state)?;
        private_directory(&self.root)?;
        private_directory(&self.projection_data_root)?;
        verify_direct_local_child(
            &self.projection_data_root,
            &self.attachment_data_root,
            "attachments-v2",
            "attachment_local_path_invalid",
            "Attachment data root",
        )?;
        reject_partial_attachment_migrations(&self.projection_data_root)?;
        let local_authority_exists = match fs::symlink_metadata(&self.attachment_data_root) {
            Ok(_) => true,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(error) => return Err(AppError::io("inspect local attachment authority", error)),
        };
        if local_authority_exists {
            verify_existing_directory_no_reparse(
                &self.attachment_data_root,
                "Local attachment authority",
            )?;
            if !self.attachment_migration_receipt().is_file() {
                return Err(AppError::new(
                    "attachment_local_migration_partial",
                    "Local attachment storage exists without its migration receipt",
                )
                .outcome_unknown(true));
            }
            verify_existing_directory_no_reparse(
                &self.attachment_state_root(),
                "Local attachment state",
            )?;
            verify_existing_directory_no_reparse(&self.attachments, "Local sealed attachments")?;
            let receipt = read_migration_receipt(&self.attachment_migration_receipt())?;
            validate_migration_receipt(&receipt)?;
            let legacy = self.scan_legacy_attachment_inventory()?;
            match receipt.phase {
                AttachmentMigrationPhase::Complete => {
                    self.reconcile_completed_legacy_inventory(&legacy)?;
                }
                AttachmentMigrationPhase::PromotedPendingLegacyCleanup => {
                    verify_pending_legacy_inventory(&receipt, &legacy)?;
                }
            }
            return Ok(());
        }

        let mut legacy = self.scan_legacy_attachment_inventory()?;
        if !legacy.is_empty() && self.is_semantically_empty_legacy_scaffold(&legacy)? {
            self.cleanup_empty_legacy_scaffold(&legacy)?;
            legacy = self.scan_legacy_attachment_inventory()?;
        }
        if legacy.is_empty() {
            private_directory(&self.attachment_data_root)?;
            private_directory(&self.attachment_state_root())?;
            private_directory(&self.attachments)?;
            atomic_write_json(
                &self.attachment_migration_receipt(),
                &AttachmentMigrationReceipt {
                    schema_version: ATTACHMENT_MIGRATION_SCHEMA_VERSION,
                    phase: AttachmentMigrationPhase::Complete,
                    remaining_legacy_artifacts: Vec::new(),
                },
            )?;
            return Ok(());
        }
        if !legacy.sealed_root_exists
            || !legacy
                .artifacts
                .iter()
                .any(|artifact| artifact.key == "state/attachment-selections.v1.json")
            || !legacy
                .artifacts
                .iter()
                .any(|artifact| artifact.key == "state/attachment-quarantine.v1.json")
        {
            return Err(AppError::new(
                "attachment_legacy_migration_incomplete",
                "Legacy attachment state is partial; refusing to merge it into local storage",
            )
            .outcome_unknown(true));
        }

        let temporary = self.projection_data_root.join(format!(
            ".attachments-v2-migration-{}",
            uuid::Uuid::new_v4()
        ));
        private_directory(&temporary)?;
        let temporary_state = temporary.join("state");
        let temporary_sealed = temporary.join("sealed");
        private_directory(&temporary_state)?;
        private_directory(&temporary_sealed)?;
        for artifact in &legacy.artifacts {
            let source = self.legacy_path_for_key(&artifact.key)?;
            let destination = temporary.join(&artifact.key);
            copy_migration_file(&source, &destination, &artifact.sha256)?;
        }
        atomic_write_json(
            &temporary.join("migration.v1.json"),
            &AttachmentMigrationReceipt {
                schema_version: ATTACHMENT_MIGRATION_SCHEMA_VERSION,
                phase: AttachmentMigrationPhase::PromotedPendingLegacyCleanup,
                remaining_legacy_artifacts: legacy.artifacts,
            },
        )?;
        // Persist the nested directory entries before making the temporary
        // authority visible. On Windows sync_directory is intentionally a
        // no-op until the separate directory-flush durability gate is closed.
        sync_directory(&temporary_state)?;
        sync_directory(&temporary_sealed)?;
        sync_directory(&temporary)?;
        fs::rename(&temporary, &self.attachment_data_root)
            .map_err(|error| AppError::io("promote local attachment migration", error))?;
        sync_directory(&self.projection_data_root)?;
        Ok(())
    }

    pub fn finalize_attachment_migration(&self, instance_lock: &InstanceLock) -> AppResult<()> {
        instance_lock.require_state_root(&self.state)?;
        let receipt_path = self.attachment_migration_receipt();
        let mut receipt = read_migration_receipt(&receipt_path)?;
        validate_migration_receipt(&receipt)?;
        if matches!(receipt.phase, AttachmentMigrationPhase::Complete) {
            let legacy = self.scan_legacy_attachment_inventory()?;
            self.reconcile_completed_legacy_inventory(&legacy)?;
            return Ok(());
        }

        let actual = self.scan_legacy_attachment_inventory()?;
        verify_pending_legacy_inventory(&receipt, &actual)?;
        if receipt.remaining_legacy_artifacts != actual.artifacts {
            // A prior process may have deleted an artifact and crashed before
            // shrinking the receipt. Missing receipt members are the only
            // permitted drift and are committed before cleanup resumes.
            receipt.remaining_legacy_artifacts = actual.artifacts;
            atomic_write_json(&receipt_path, &receipt)?;
        }

        while let Some(artifact) = receipt.remaining_legacy_artifacts.first().cloned() {
            let path = self.legacy_path_for_key(&artifact.key)?;
            let current = hash_regular_migration_file(&path)?;
            if current.as_deref() != Some(artifact.sha256.as_str()) {
                return Err(AppError::new(
                    "attachment_legacy_migration_conflict",
                    "Legacy attachment data changed during cleanup; refusing deletion",
                )
                .outcome_unknown(true));
            }
            crate::attachments::remove_migrated_legacy_file(&path)?;
            receipt.remaining_legacy_artifacts.remove(0);
            atomic_write_json(&receipt_path, &receipt)?;
        }
        match fs::remove_dir(self.legacy_attachment_root()) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(AppError::io("remove empty legacy attachment root", error)),
        }
        if !self.scan_legacy_attachment_inventory()?.is_empty() {
            return Err(AppError::new(
                "attachment_legacy_migration_conflict",
                "Legacy attachment data changed while cleanup completed",
            )
            .outcome_unknown(true));
        }
        receipt.phase = AttachmentMigrationPhase::Complete;
        atomic_write_json(&receipt_path, &receipt)
    }

    fn scan_legacy_attachment_inventory(&self) -> AppResult<LegacyAttachmentInventory> {
        let legacy_root = self.legacy_attachment_root();
        let sealed_root_exists = match fs::symlink_metadata(&legacy_root) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(AppError::new(
                        "attachment_legacy_migration_unsafe",
                        "Legacy attachment staging is not a regular directory",
                    )
                    .outcome_unknown(true));
                }
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
                    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                        return Err(AppError::new(
                            "attachment_legacy_migration_unsafe",
                            "Legacy attachment staging is a reparse point",
                        )
                        .outcome_unknown(true));
                    }
                }
                true
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(error) => return Err(AppError::io("inspect legacy attachment staging", error)),
        };

        let mut artifacts = Vec::new();
        if sealed_root_exists {
            for entry in fs::read_dir(&legacy_root)
                .map_err(|error| AppError::io("list legacy attachment staging", error))?
            {
                let entry =
                    entry.map_err(|error| AppError::io("read legacy attachment entry", error))?;
                let name = entry
                    .file_name()
                    .to_str()
                    .ok_or_else(|| {
                        AppError::new(
                            "attachment_legacy_migration_unsafe",
                            "Legacy attachment handle is not valid Unicode",
                        )
                    })?
                    .to_owned();
                crate::validation::canonical_uuid(&name, "attachmentHandle")?;
                let key = format!("sealed/{name}");
                artifacts.push(LegacyAttachmentArtifact {
                    sha256: hash_required_regular_migration_file(&entry.path())?,
                    key,
                });
            }
        }

        for key in [
            "state/attachment-selections.v1.json",
            "state/attachment-selections.v1.json.bak",
            "state/attachment-quarantine.v1.json",
            "state/attachment-quarantine.v1.json.bak",
        ] {
            let path = self.legacy_path_for_key(key)?;
            if let Some(sha256) = hash_regular_migration_file(&path)? {
                artifacts.push(LegacyAttachmentArtifact {
                    key: key.to_owned(),
                    sha256,
                });
            }
        }
        artifacts.sort_by(|left, right| left.key.cmp(&right.key));
        Ok(LegacyAttachmentInventory {
            sealed_root_exists,
            artifacts,
        })
    }

    fn reconcile_completed_legacy_inventory(
        &self,
        legacy: &LegacyAttachmentInventory,
    ) -> AppResult<()> {
        if legacy.is_empty() {
            return Ok(());
        }
        if self.is_semantically_empty_legacy_scaffold(legacy)? {
            return self.cleanup_empty_legacy_scaffold(legacy);
        }
        Err(AppError::new(
            "attachment_legacy_resurrected",
            "Material legacy attachment data reappeared after Local migration completed",
        )
        .outcome_unknown(true))
    }

    fn is_semantically_empty_legacy_scaffold(
        &self,
        legacy: &LegacyAttachmentInventory,
    ) -> AppResult<bool> {
        if legacy.is_empty() {
            return Ok(false);
        }
        if legacy
            .artifacts
            .iter()
            .any(|artifact| artifact.key.starts_with("sealed/"))
        {
            return Ok(false);
        }
        for artifact in &legacy.artifacts {
            let path = self.legacy_path_for_key(&artifact.key)?;
            let Some(bytes) = read_regular_migration_bytes(&path)? else {
                return Ok(false);
            };
            if sha256_bytes(&bytes) != artifact.sha256
                || !legacy_state_sentinel_is_empty(&artifact.key, &bytes)
            {
                return Ok(false);
            }
        }
        Ok(true)
    }

    fn cleanup_empty_legacy_scaffold(&self, expected: &LegacyAttachmentInventory) -> AppResult<()> {
        // The caller owns the instance lock. Re-read every artifact and its
        // meaning immediately before the first mutation so an inventory change
        // cannot turn this narrow empty-scaffold recovery into data deletion.
        let current = self.scan_legacy_attachment_inventory()?;
        if &current != expected || !self.is_semantically_empty_legacy_scaffold(&current)? {
            return Err(AppError::new(
                "attachment_legacy_migration_conflict",
                "Legacy attachment scaffold changed before cleanup; refusing deletion",
            )
            .outcome_unknown(true));
        }
        for artifact in &current.artifacts {
            let path = self.legacy_path_for_key(&artifact.key)?;
            if hash_regular_migration_file(&path)?.as_deref() != Some(artifact.sha256.as_str()) {
                return Err(AppError::new(
                    "attachment_legacy_migration_conflict",
                    "Legacy attachment scaffold changed during cleanup; refusing deletion",
                )
                .outcome_unknown(true));
            }
        }
        for artifact in &current.artifacts {
            crate::attachments::remove_migrated_legacy_file(
                &self.legacy_path_for_key(&artifact.key)?,
            )?;
        }
        if current.sealed_root_exists {
            match fs::remove_dir(self.legacy_attachment_root()) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(AppError::io(
                        "remove empty legacy attachment scaffold",
                        error,
                    ))
                }
            }
        }
        if !self.scan_legacy_attachment_inventory()?.is_empty() {
            return Err(AppError::new(
                "attachment_legacy_migration_conflict",
                "Legacy attachment scaffold changed while cleanup completed",
            )
            .outcome_unknown(true));
        }
        Ok(())
    }

    fn legacy_path_for_key(&self, key: &str) -> AppResult<PathBuf> {
        if let Some(handle) = key.strip_prefix("sealed/") {
            crate::validation::canonical_uuid(handle, "attachmentHandle")?;
            return Ok(self.legacy_attachment_root().join(handle));
        }
        match key {
            "state/attachment-selections.v1.json" => Ok(self.legacy_attachment_selections()),
            "state/attachment-selections.v1.json.bak" => {
                backup_path(&self.legacy_attachment_selections())
            }
            "state/attachment-quarantine.v1.json" => Ok(self.legacy_attachment_quarantine()),
            "state/attachment-quarantine.v1.json.bak" => {
                backup_path(&self.legacy_attachment_quarantine())
            }
            _ => Err(AppError::new(
                "attachment_migration_receipt_invalid",
                "Attachment migration receipt contains an unknown legacy artifact",
            )),
        }
    }
}

fn read_regular_migration_bytes(path: &Path) -> AppResult<Option<Vec<u8>>> {
    let Some(mut file) = open_regular_migration_file(path)? else {
        return Ok(None);
    };
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| AppError::io("read attachment migration state", error))?;
    Ok(Some(bytes))
}

fn sha256_bytes(bytes: &[u8]) -> String {
    let mut digest = Sha256::new();
    digest.update(bytes);
    hex::encode(digest.finalize())
}

fn legacy_state_sentinel_is_empty(key: &str, bytes: &[u8]) -> bool {
    if key.starts_with("state/attachment-selections.v1.json") {
        return serde_json::from_slice::<LegacySelectionSentinel>(bytes).is_ok_and(|document| {
            matches!(document.schema_version, 1 | 2 | 3)
                && document.batches.is_empty()
                && document.retired_selection_ids.is_empty()
                && document.retired_draft_handles.is_empty()
        });
    }
    if key.starts_with("state/attachment-quarantine.v1.json") {
        return serde_json::from_slice::<LegacyQuarantineSentinel>(bytes)
            .is_ok_and(|document| document.schema_version == 1 && document.records.is_empty());
    }
    false
}

fn verify_existing_directory_no_reparse(path: &Path, label: &str) -> AppResult<()> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| AppError::io("inspect attachment data directory", error))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(AppError::new(
            "attachment_local_migration_partial",
            format!("{label} is not a regular directory"),
        )
        .outcome_unknown(true));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(AppError::new(
                "attachment_local_migration_partial",
                format!("{label} is a reparse point"),
            )
            .outcome_unknown(true));
        }
    }
    Ok(())
}

fn verify_direct_local_child(
    parent: &Path,
    child: &Path,
    expected_name: &str,
    error_code: &str,
    label: &str,
) -> AppResult<()> {
    if !child.is_absolute()
        || child.parent() != Some(parent)
        || child.file_name().and_then(|value| value.to_str()) != Some(expected_name)
        || child
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(AppError::new(
            error_code,
            format!("{label} is not the expected direct Local AppData child"),
        ));
    }
    let canonical_parent = fs::canonicalize(parent)
        .map_err(|error| AppError::io("canonicalize local application data root", error))?;
    if canonical_parent
        != fs::canonicalize(child.parent().expect("checked parent"))
            .map_err(|error| AppError::io("canonicalize attachment data parent", error))?
    {
        return Err(AppError::new(
            error_code,
            format!("{label} parent does not match Local AppData"),
        ));
    }
    Ok(())
}

fn reject_partial_attachment_migrations(parent: &Path) -> AppResult<()> {
    for entry in fs::read_dir(parent)
        .map_err(|error| AppError::io("list local application data root", error))?
    {
        let entry = entry.map_err(|error| AppError::io("read local data entry", error))?;
        if entry
            .file_name()
            .to_str()
            .is_some_and(|name| name.starts_with(".attachments-v2-migration-"))
        {
            return Err(AppError::new(
                "attachment_local_migration_partial",
                "A partial attachment migration exists; refusing to merge storage roots",
            )
            .outcome_unknown(true));
        }
    }
    Ok(())
}

fn open_regular_migration_file(path: &Path) -> AppResult<Option<fs::File>> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = match options.open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(AppError::io("open attachment migration file", error)),
    };
    let metadata = file
        .metadata()
        .map_err(|error| AppError::io("inspect attachment migration file", error))?;
    if !metadata.is_file() {
        return Err(AppError::new(
            "attachment_legacy_migration_unsafe",
            "Attachment migration source is not a regular file",
        )
        .outcome_unknown(true));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(AppError::new(
                "attachment_legacy_migration_unsafe",
                "Attachment migration source is a reparse point",
            )
            .outcome_unknown(true));
        }
    }
    Ok(Some(file))
}

fn hash_open_migration_file(mut file: fs::File) -> AppResult<String> {
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| AppError::io("hash attachment migration file", error))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(hex::encode(digest.finalize()))
}

fn hash_regular_migration_file(path: &Path) -> AppResult<Option<String>> {
    open_regular_migration_file(path)?
        .map(hash_open_migration_file)
        .transpose()
}

fn hash_required_regular_migration_file(path: &Path) -> AppResult<String> {
    hash_regular_migration_file(path)?.ok_or_else(|| {
        AppError::new(
            "attachment_legacy_migration_conflict",
            "Legacy attachment disappeared while its inventory was read",
        )
        .outcome_unknown(true)
    })
}

fn copy_migration_file(source: &Path, destination: &Path, expected_sha256: &str) -> AppResult<()> {
    let mut source = open_regular_migration_file(source)?.ok_or_else(|| {
        AppError::new(
            "attachment_legacy_migration_conflict",
            "Legacy attachment disappeared while migration was copied",
        )
        .outcome_unknown(true)
    })?;
    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_CLOEXEC);
    }
    let mut destination_file = options
        .open(destination)
        .map_err(|error| AppError::io("create attachment migration destination", error))?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = source
            .read(&mut buffer)
            .map_err(|error| AppError::io("read attachment migration source", error))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
        destination_file
            .write_all(&buffer[..read])
            .map_err(|error| AppError::io("write attachment migration destination", error))?;
    }
    destination_file
        .sync_all()
        .map_err(|error| AppError::io("sync attachment migration file", error))?;
    if hex::encode(digest.finalize()) != expected_sha256 {
        return Err(AppError::new(
            "attachment_legacy_migration_conflict",
            "Legacy attachment changed while migration was copied",
        )
        .outcome_unknown(true));
    }
    Ok(())
}

fn read_migration_receipt(path: &Path) -> AppResult<AttachmentMigrationReceipt> {
    let primary = read_migration_receipt_file(path);
    if let Ok(Some(receipt)) = &primary {
        return Ok(receipt.clone());
    }
    let backup = backup_path(path)?;
    if let Ok(Some(receipt)) = read_migration_receipt_file(&backup) {
        return Ok(receipt);
    }
    Err(AppError::new(
        "attachment_migration_receipt_invalid",
        match primary {
            Ok(None) => format!("{} is missing", path.display()),
            Err(error) => error.message,
            Ok(Some(_)) => unreachable!(),
        },
    )
    .outcome_unknown(true))
}

fn read_migration_receipt_file(path: &Path) -> AppResult<Option<AttachmentMigrationReceipt>> {
    let Some(mut file) = open_regular_migration_file(path)? else {
        return Ok(None);
    };
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| AppError::io("read attachment migration receipt", error))?;
    serde_json::from_slice(&bytes).map(Some).map_err(|error| {
        AppError::new("attachment_migration_receipt_invalid", error.to_string())
            .outcome_unknown(true)
    })
}

fn validate_migration_receipt(receipt: &AttachmentMigrationReceipt) -> AppResult<()> {
    if receipt.schema_version != ATTACHMENT_MIGRATION_SCHEMA_VERSION {
        return Err(AppError::new(
            "attachment_migration_receipt_invalid",
            "Attachment migration receipt version is unsupported",
        ));
    }
    if matches!(receipt.phase, AttachmentMigrationPhase::Complete)
        && !receipt.remaining_legacy_artifacts.is_empty()
    {
        return Err(AppError::new(
            "attachment_migration_receipt_invalid",
            "A completed attachment migration cannot retain legacy artifacts",
        ));
    }
    let mut previous: Option<&str> = None;
    for artifact in &receipt.remaining_legacy_artifacts {
        validate_legacy_artifact_key(&artifact.key)?;
        if previous.is_some_and(|value| value >= artifact.key.as_str()) {
            return Err(AppError::new(
                "attachment_migration_receipt_invalid",
                "Attachment migration receipt artifacts are not strictly ordered",
            ));
        }
        if artifact.sha256.len() != 64
            || !artifact
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err(AppError::new(
                "attachment_migration_receipt_invalid",
                "Attachment migration receipt contains an invalid content digest",
            ));
        }
        previous = Some(&artifact.key);
    }
    Ok(())
}

fn validate_legacy_artifact_key(key: &str) -> AppResult<()> {
    if let Some(handle) = key.strip_prefix("sealed/") {
        crate::validation::canonical_uuid(handle, "attachmentHandle")?;
        return Ok(());
    }
    if matches!(
        key,
        "state/attachment-selections.v1.json"
            | "state/attachment-selections.v1.json.bak"
            | "state/attachment-quarantine.v1.json"
            | "state/attachment-quarantine.v1.json.bak"
    ) {
        return Ok(());
    }
    Err(AppError::new(
        "attachment_migration_receipt_invalid",
        "Attachment migration receipt contains an unknown legacy artifact",
    ))
}

fn verify_pending_legacy_inventory(
    receipt: &AttachmentMigrationReceipt,
    actual: &LegacyAttachmentInventory,
) -> AppResult<()> {
    if !matches!(
        receipt.phase,
        AttachmentMigrationPhase::PromotedPendingLegacyCleanup
    ) {
        return Err(AppError::new(
            "attachment_migration_receipt_invalid",
            "Only a pending migration receipt may retain legacy artifacts",
        ));
    }
    let expected = receipt
        .remaining_legacy_artifacts
        .iter()
        .map(|artifact| (artifact.key.as_str(), artifact.sha256.as_str()))
        .collect::<std::collections::HashMap<_, _>>();
    for artifact in &actual.artifacts {
        if expected.get(artifact.key.as_str()).copied() != Some(artifact.sha256.as_str()) {
            return Err(AppError::new(
                "attachment_legacy_migration_conflict",
                "Legacy attachment inventory changed after Local promotion",
            )
            .outcome_unknown(true));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn measurement_children_must_be_direct_prefixed_temp_children() {
        let temp = std::fs::canonicalize(std::env::temp_dir()).expect("canonical temp");
        let valid = temp.join(format!("orquesta-p2e-project-{}", uuid::Uuid::new_v4()));
        assert_eq!(
            verified_measurement_temp_child(
                valid.clone(),
                "orquesta-p2e-project-",
                "measurement project path"
            )
            .expect("valid direct child"),
            valid
        );

        let wrong_prefix = temp.join(format!("unrelated-{}", uuid::Uuid::new_v4()));
        assert_eq!(
            verified_measurement_temp_child(
                wrong_prefix,
                "orquesta-p2e-project-",
                "measurement project path"
            )
            .expect_err("reject unrelated prefix")
            .code,
            "measure_path_invalid"
        );
    }

    fn migration_paths(root: &Path) -> NativePaths {
        let roaming = root.join("roaming").join("Orquesta Next");
        let local = root.join("local").join("Orquesta Next");
        fs::create_dir_all(&roaming).expect("create roaming root");
        fs::create_dir_all(&local).expect("create local root");
        NativePaths {
            state: roaming.join("state").join("state-v1"),
            logs: roaming.join("logs"),
            attachments: local.join("attachments-v2").join("sealed"),
            projection: local.join("projection"),
            runtime_dist: root.join("runtime-dist"),
            attachment_data_root: local.join("attachments-v2"),
            voice_data_root: local.join("voice-v1"),
            projection_data_root: local,
            root: roaming,
        }
    }

    fn seed_legacy_authority(paths: &NativePaths) -> &'static str {
        fs::create_dir_all(paths.legacy_attachment_root()).expect("create legacy sealed root");
        fs::create_dir_all(&paths.state).expect("create legacy state root");
        let handle = "55555555-5555-4555-8555-555555555555";
        fs::write(
            paths.legacy_attachment_root().join(handle),
            b"legacy orphan",
        )
        .expect("write legacy sealed file");
        for (path, bytes) in [
            (
                paths.legacy_attachment_selections(),
                br#"{"schemaVersion":1,"batches":[],"retiredSelectionIds":[]}"#.as_slice(),
            ),
            (
                backup_path(&paths.legacy_attachment_selections()).expect("selection backup"),
                br#"{"schemaVersion":1,"batches":[],"retiredSelectionIds":[]}"#.as_slice(),
            ),
            (
                paths.legacy_attachment_quarantine(),
                br#"{"schemaVersion":1,"records":[]}"#.as_slice(),
            ),
            (
                backup_path(&paths.legacy_attachment_quarantine()).expect("quarantine backup"),
                br#"{"schemaVersion":1,"records":[]}"#.as_slice(),
            ),
        ] {
            fs::write(path, bytes).expect("write legacy state artifact");
        }
        handle
    }

    fn seed_empty_legacy_scaffold(paths: &NativePaths) {
        fs::create_dir_all(paths.legacy_attachment_root()).expect("create empty legacy root");
        fs::create_dir_all(&paths.state).expect("create legacy state root");
        for (path, bytes) in [
            (
                paths.legacy_attachment_selections(),
                br#"{"schemaVersion":1,"batches":[],"retiredSelectionIds":[]}"#.as_slice(),
            ),
            (
                backup_path(&paths.legacy_attachment_selections()).expect("selection backup"),
                br#"{"schemaVersion":1,"batches":[],"retiredSelectionIds":[]}"#.as_slice(),
            ),
            (
                paths.legacy_attachment_quarantine(),
                br#"{"schemaVersion":1,"records":[]}"#.as_slice(),
            ),
            (
                backup_path(&paths.legacy_attachment_quarantine()).expect("quarantine backup"),
                br#"{"schemaVersion":1,"records":[]}"#.as_slice(),
            ),
        ] {
            fs::write(path, bytes).expect("write empty legacy sentinel");
        }
    }

    fn acquire_migration_lock(paths: &NativePaths) -> InstanceLock {
        private_directory(&paths.state).expect("create instance lock root");
        InstanceLock::acquire(&paths.state).expect("acquire instance lock")
    }

    fn open_promoted_store(paths: &NativePaths) {
        let store = crate::attachments::AttachmentStore::open(
            paths.attachments.clone(),
            paths.attachment_selections(),
            paths.attachment_quarantine(),
            None,
        )
        .expect("validate promoted attachment authority");
        drop(store);
    }

    #[test]
    fn legacy_attachment_authority_promotes_then_cleans_only_after_valid_open() {
        let root = std::env::temp_dir().join(format!(
            "orquesta-attachment-path-migration-{}",
            uuid::Uuid::new_v4()
        ));
        let paths = migration_paths(&root);
        let handle = seed_legacy_authority(&paths);
        let instance_lock = acquire_migration_lock(&paths);

        paths
            .prepare_attachment_authority(&instance_lock)
            .expect("promote legacy authority");
        assert!(paths.attachments.join(handle).is_file());
        assert!(paths.legacy_attachment_root().join(handle).is_file());
        let promoted = read_migration_receipt(&paths.attachment_migration_receipt())
            .expect("read promoted receipt");
        assert!(matches!(
            promoted.phase,
            AttachmentMigrationPhase::PromotedPendingLegacyCleanup
        ));
        assert_eq!(promoted.remaining_legacy_artifacts.len(), 5);

        open_promoted_store(&paths);
        paths
            .finalize_attachment_migration(&instance_lock)
            .expect("finalize legacy cleanup");
        assert!(!paths.legacy_attachment_root().exists());
        assert!(!paths.legacy_attachment_selections().exists());
        assert!(!backup_path(&paths.legacy_attachment_selections())
            .expect("selection backup")
            .exists());
        assert!(matches!(
            read_migration_receipt(&paths.attachment_migration_receipt())
                .expect("read complete receipt")
                .phase,
            AttachmentMigrationPhase::Complete
        ));
        drop(instance_lock);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn partial_local_attachment_authority_fails_closed() {
        let root = std::env::temp_dir().join(format!(
            "orquesta-attachment-path-partial-{}",
            uuid::Uuid::new_v4()
        ));
        let paths = migration_paths(&root);
        fs::create_dir_all(&paths.attachment_data_root).expect("create partial local root");
        let instance_lock = acquire_migration_lock(&paths);

        let error = paths
            .prepare_attachment_authority(&instance_lock)
            .expect_err("partial local authority must fail closed");
        assert_eq!(error.code, "attachment_local_migration_partial");
        drop(instance_lock);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn completed_receipt_cannot_retain_legacy_inventory() {
        let receipt = AttachmentMigrationReceipt {
            schema_version: ATTACHMENT_MIGRATION_SCHEMA_VERSION,
            phase: AttachmentMigrationPhase::Complete,
            remaining_legacy_artifacts: vec![LegacyAttachmentArtifact {
                key: "sealed/55555555-5555-4555-8555-555555555555".to_owned(),
                sha256: "a".repeat(64),
            }],
        };
        assert_eq!(
            validate_migration_receipt(&receipt)
                .expect_err("complete receipt cannot retain legacy artifacts")
                .code,
            "attachment_migration_receipt_invalid"
        );
    }

    #[test]
    fn changed_legacy_inventory_after_promotion_deletes_nothing() {
        let root = std::env::temp_dir().join(format!(
            "orquesta-attachment-path-changed-{}",
            uuid::Uuid::new_v4()
        ));
        let paths = migration_paths(&root);
        let handle = seed_legacy_authority(&paths);
        let instance_lock = acquire_migration_lock(&paths);
        paths
            .prepare_attachment_authority(&instance_lock)
            .expect("promote legacy authority");
        fs::write(
            paths.legacy_attachment_selections(),
            b"changed after promotion",
        )
        .expect("change legacy selection");

        let error = paths
            .finalize_attachment_migration(&instance_lock)
            .expect_err("changed legacy inventory must fail closed");
        assert_eq!(error.code, "attachment_legacy_migration_conflict");
        assert!(paths.legacy_attachment_root().join(handle).is_file());
        assert!(paths.legacy_attachment_selections().is_file());
        assert!(paths.legacy_attachment_quarantine().is_file());
        drop(instance_lock);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn pending_cleanup_resumes_after_delete_before_receipt_update() {
        let root = std::env::temp_dir().join(format!(
            "orquesta-attachment-path-resume-{}",
            uuid::Uuid::new_v4()
        ));
        let paths = migration_paths(&root);
        let handle = seed_legacy_authority(&paths);
        let instance_lock = acquire_migration_lock(&paths);
        paths
            .prepare_attachment_authority(&instance_lock)
            .expect("promote legacy authority");
        open_promoted_store(&paths);
        crate::attachments::remove_migrated_legacy_file(
            &paths.legacy_attachment_root().join(handle),
        )
        .expect("simulate delete before receipt update");

        paths
            .finalize_attachment_migration(&instance_lock)
            .expect("resume monotonic cleanup");
        let receipt = read_migration_receipt(&paths.attachment_migration_receipt())
            .expect("read complete receipt");
        assert!(matches!(receipt.phase, AttachmentMigrationPhase::Complete));
        assert!(receipt.remaining_legacy_artifacts.is_empty());
        assert!(paths.scan_legacy_attachment_inventory().unwrap().is_empty());
        drop(instance_lock);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn completed_migration_rejects_downgrade_resurrection_without_mutation() {
        let root = std::env::temp_dir().join(format!(
            "orquesta-attachment-path-resurrected-{}",
            uuid::Uuid::new_v4()
        ));
        let paths = migration_paths(&root);
        seed_legacy_authority(&paths);
        let instance_lock = acquire_migration_lock(&paths);
        paths
            .prepare_attachment_authority(&instance_lock)
            .expect("promote legacy authority");
        open_promoted_store(&paths);
        paths
            .finalize_attachment_migration(&instance_lock)
            .expect("complete migration");
        fs::create_dir_all(paths.legacy_attachment_root()).expect("resurrect legacy root");
        let resurrected = paths
            .legacy_attachment_root()
            .join("66666666-6666-4666-8666-666666666666");
        fs::write(&resurrected, b"downgrade write").expect("resurrect legacy byte");

        let error = paths
            .prepare_attachment_authority(&instance_lock)
            .expect_err("completed migration must reject legacy resurrection");
        assert_eq!(error.code, "attachment_legacy_resurrected");
        assert_eq!(fs::read(&resurrected).unwrap(), b"downgrade write");
        drop(instance_lock);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn completed_migration_removes_only_verified_empty_legacy_scaffold() {
        let root = std::env::temp_dir().join(format!(
            "orquesta-attachment-empty-scaffold-{}",
            uuid::Uuid::new_v4()
        ));
        let paths = migration_paths(&root);
        let instance_lock = acquire_migration_lock(&paths);
        paths
            .prepare_attachment_authority(&instance_lock)
            .expect("create Local authority");
        seed_empty_legacy_scaffold(&paths);

        paths
            .prepare_attachment_authority(&instance_lock)
            .expect("remove verified empty downgrade scaffold");

        assert!(paths.scan_legacy_attachment_inventory().unwrap().is_empty());
        assert!(matches!(
            read_migration_receipt(&paths.attachment_migration_receipt())
                .expect("read complete receipt")
                .phase,
            AttachmentMigrationPhase::Complete
        ));
        drop(instance_lock);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn empty_legacy_scaffold_is_retired_before_new_local_authority_is_created() {
        let root = std::env::temp_dir().join(format!(
            "orquesta-attachment-empty-first-start-{}",
            uuid::Uuid::new_v4()
        ));
        let paths = migration_paths(&root);
        seed_empty_legacy_scaffold(&paths);
        let instance_lock = acquire_migration_lock(&paths);

        paths
            .prepare_attachment_authority(&instance_lock)
            .expect("retire empty scaffold and create Local authority");

        assert!(paths.scan_legacy_attachment_inventory().unwrap().is_empty());
        assert!(paths.attachment_data_root.is_dir());
        assert!(matches!(
            read_migration_receipt(&paths.attachment_migration_receipt())
                .expect("read complete receipt")
                .phase,
            AttachmentMigrationPhase::Complete
        ));
        drop(instance_lock);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn completed_migration_rejects_nonempty_legacy_state_without_deleting_any_artifact() {
        let root = std::env::temp_dir().join(format!(
            "orquesta-attachment-nonempty-scaffold-{}",
            uuid::Uuid::new_v4()
        ));
        let paths = migration_paths(&root);
        let instance_lock = acquire_migration_lock(&paths);
        paths
            .prepare_attachment_authority(&instance_lock)
            .expect("create Local authority");
        seed_empty_legacy_scaffold(&paths);
        fs::write(
            paths.legacy_attachment_selections(),
            br#"{"schemaVersion":1,"batches":[{"material":true}],"retiredSelectionIds":[]}"#,
        )
        .expect("write material legacy selection");

        let error = paths
            .prepare_attachment_authority(&instance_lock)
            .expect_err("material legacy state must fail closed");

        assert_eq!(error.code, "attachment_legacy_resurrected");
        assert!(paths.legacy_attachment_root().is_dir());
        assert!(paths.legacy_attachment_selections().is_file());
        assert!(paths.legacy_attachment_quarantine().is_file());
        assert!(backup_path(&paths.legacy_attachment_selections())
            .expect("selection backup")
            .is_file());
        assert!(backup_path(&paths.legacy_attachment_quarantine())
            .expect("quarantine backup")
            .is_file());
        drop(instance_lock);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn changed_empty_scaffold_is_rejected_before_cleanup_mutates_any_artifact() {
        let root = std::env::temp_dir().join(format!(
            "orquesta-attachment-scaffold-race-{}",
            uuid::Uuid::new_v4()
        ));
        let paths = migration_paths(&root);
        seed_empty_legacy_scaffold(&paths);
        let instance_lock = acquire_migration_lock(&paths);
        let expected = paths
            .scan_legacy_attachment_inventory()
            .expect("capture empty scaffold inventory");
        fs::write(
            paths.legacy_attachment_selections(),
            br#"{"schemaVersion":1,"batches":[{"changed":true}],"retiredSelectionIds":[]}"#,
        )
        .expect("change scaffold before cleanup");

        let error = paths
            .cleanup_empty_legacy_scaffold(&expected)
            .expect_err("changed scaffold must fail before deletion");

        assert_eq!(error.code, "attachment_legacy_migration_conflict");
        assert!(paths.legacy_attachment_root().is_dir());
        assert!(paths.legacy_attachment_selections().is_file());
        assert!(paths.legacy_attachment_quarantine().is_file());
        assert!(backup_path(&paths.legacy_attachment_selections())
            .expect("selection backup")
            .is_file());
        assert!(backup_path(&paths.legacy_attachment_quarantine())
            .expect("quarantine backup")
            .is_file());
        drop(instance_lock);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn held_instance_lock_prevents_all_attachment_migration_mutation() {
        let root = std::env::temp_dir().join(format!(
            "orquesta-attachment-path-held-lock-{}",
            uuid::Uuid::new_v4()
        ));
        let paths = migration_paths(&root);
        let handle = seed_legacy_authority(&paths);
        let instance_lock = acquire_migration_lock(&paths);

        let error = InstanceLock::acquire(&paths.state)
            .err()
            .expect("second startup must not own migration lock");
        assert_eq!(error.code, "desktop_next_already_running");
        assert!(!paths.attachment_data_root.exists());
        assert_eq!(
            fs::read(paths.legacy_attachment_root().join(handle)).unwrap(),
            b"legacy orphan"
        );
        assert!(!fs::read_dir(&paths.projection_data_root)
            .unwrap()
            .any(|entry| entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".attachments-v2-migration-")));
        drop(instance_lock);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn concurrent_startups_produce_one_migration_without_leftovers() {
        let root = std::env::temp_dir().join(format!(
            "orquesta-attachment-path-concurrent-{}",
            uuid::Uuid::new_v4()
        ));
        let paths = migration_paths(&root);
        seed_legacy_authority(&paths);
        private_directory(&paths.state).expect("create instance lock root");
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let mut threads = Vec::new();
        for _ in 0..2 {
            let paths = paths.clone();
            let barrier = barrier.clone();
            threads.push(std::thread::spawn(move || {
                barrier.wait();
                let instance_lock = match InstanceLock::acquire(&paths.state) {
                    Ok(lock) => lock,
                    Err(error) => return error.code,
                };
                std::thread::sleep(std::time::Duration::from_millis(75));
                paths
                    .prepare_attachment_authority(&instance_lock)
                    .expect("winner promotes authority");
                paths.ensure().expect("winner ensures local roots");
                open_promoted_store(&paths);
                paths
                    .finalize_attachment_migration(&instance_lock)
                    .expect("winner finalizes authority");
                "ok".to_owned()
            }));
        }
        let mut results = threads
            .into_iter()
            .map(|thread| thread.join().expect("startup thread"))
            .collect::<Vec<_>>();
        results.sort();
        assert_eq!(results, ["desktop_next_already_running", "ok"]);
        assert!(matches!(
            read_migration_receipt(&paths.attachment_migration_receipt())
                .expect("read complete receipt")
                .phase,
            AttachmentMigrationPhase::Complete
        ));
        assert!(paths.scan_legacy_attachment_inventory().unwrap().is_empty());
        assert!(!fs::read_dir(&paths.projection_data_root)
            .unwrap()
            .any(|entry| entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".attachments-v2-migration-")));
        let _ = fs::remove_dir_all(root);
    }
}
