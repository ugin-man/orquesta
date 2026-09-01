use std::fs;
use std::path::{Path, PathBuf};

#[cfg(windows)]
use sha2::{Digest, Sha256};

use crate::error::{AppError, AppResult};
use crate::logging::now_ms;
use crate::registry::{
    root_identity_snapshot, starter_creation_request_sha256, ProjectRecord, ProjectRegistry,
    StarterCreationClaim, StarterCreationPhase,
};
use crate::validation::{
    canonical_path_string, canonical_uuid, normalized_project_name, platform_name_eq,
    platform_path_eq,
};

#[derive(Debug, Clone)]
pub struct StarterProjectInput {
    pub operation_ref: String,
    pub project_name: String,
}

struct CheckedParent {
    canonical_path: PathBuf,
    stable_identity: String,
    mutation_guard: ParentMutationGuard,
}

#[cfg(windows)]
struct ParentMutationGuard(Vec<windows_sys::Win32::Foundation::HANDLE>);

#[cfg(windows)]
impl ParentMutationGuard {
    fn open(path: &Path) -> AppResult<Self> {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
        use windows_sys::Win32::Storage::FileSystem::{
            CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
            FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
            FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
        };
        let mut handles = Vec::new();
        let mut current = PathBuf::new();
        for component in path.components() {
            current.push(component.as_os_str());
            if matches!(component, std::path::Component::Prefix(_)) || !current.has_root() {
                continue;
            }
            let volume_root = current.parent().is_none();
            let wide: Vec<u16> = current
                .as_os_str()
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();
            let desired_access = if platform_path_eq(&current, path) && !volume_root {
                0x0001_0000 | 0x0080
            } else {
                0x0080
            };
            let handle = unsafe {
                CreateFileW(
                    wide.as_ptr(),
                    desired_access,
                    FILE_SHARE_READ | FILE_SHARE_WRITE,
                    std::ptr::null(),
                    OPEN_EXISTING,
                    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                    std::ptr::null_mut(),
                )
            };
            if handle == INVALID_HANDLE_VALUE {
                close_handles(&mut handles);
                return Err(AppError::io(
                    "open Starter parent mutation guard chain",
                    std::io::Error::last_os_error(),
                ));
            }
            let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
            let information_ok =
                unsafe { GetFileInformationByHandle(handle, &mut information) } != 0;
            if !information_ok
                || information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
                || (!volume_root && information.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0)
            {
                unsafe { windows_sys::Win32::Foundation::CloseHandle(handle) };
                close_handles(&mut handles);
                return Err(AppError::new(
                    "project_creation_reparse_rejected",
                    format!(
                        "Starter parent component is non-directory, unreadable, or reparse: {} (attrs={:#x}, info={information_ok})",
                        current.display(),
                        information.dwFileAttributes
                    ),
                ));
            }
            handles.push(handle);
        }
        let guard = Self(handles);
        guard.stable_identity()?;
        Ok(guard)
    }

    fn stable_identity(&self) -> AppResult<String> {
        stable_directory_identity(*self.0.last().ok_or_else(|| {
            AppError::new(
                "project_creation_parent_invalid",
                "Starter parent handle chain is empty",
            )
        })?)
    }
}

#[cfg(windows)]
fn close_handles(handles: &mut Vec<windows_sys::Win32::Foundation::HANDLE>) {
    for handle in handles.drain(..).rev() {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(handle) };
    }
}

#[cfg(windows)]
impl Drop for ParentMutationGuard {
    fn drop(&mut self) {
        close_handles(&mut self.0);
    }
}

#[cfg(not(windows))]
struct ParentMutationGuard;

#[cfg(not(windows))]
impl ParentMutationGuard {
    fn open(_path: &Path) -> AppResult<Self> {
        Err(AppError::new(
            "project_creation_platform_unsupported",
            "Starter creation requires a no-follow parent lease",
        ))
    }

    fn stable_identity(&self) -> AppResult<String> {
        Err(AppError::new(
            "project_creation_platform_unsupported",
            "Starter creation requires a no-follow parent lease",
        ))
    }
}

#[cfg(windows)]
struct OwnedChildGuard {
    handle: windows_sys::Win32::Foundation::HANDLE,
    stable_identity: String,
    path: PathBuf,
}

#[cfg(windows)]
impl OwnedChildGuard {
    fn create_new(parent: &CheckedParent, path: &Path) -> AppResult<Self> {
        verify_direct_child(parent, path)?;
        fs::create_dir(path)
            .map_err(|error| AppError::io("atomically create Starter project root", error))?;
        failpoint("final_create_completed")?;
        let child = Self::open_existing(parent, path)?;
        failpoint("child_handle_acquired")?;
        Ok(child)
    }

    fn open_existing(parent: &CheckedParent, path: &Path) -> AppResult<Self> {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
        use windows_sys::Win32::Storage::FileSystem::{
            CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
            FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
            FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, OPEN_EXISTING,
        };
        verify_direct_child(parent, path)?;
        let wide: Vec<u16> = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let handle = unsafe {
            CreateFileW(
                wide.as_ptr(),
                0x0001 | 0x0080,
                FILE_SHARE_READ,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                std::ptr::null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(AppError::io(
                "open owned Starter project root",
                std::io::Error::last_os_error(),
            ));
        }
        let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(handle, &mut information) } == 0
            || information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
            || information.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
        {
            unsafe { windows_sys::Win32::Foundation::CloseHandle(handle) };
            return Err(recovery_error("owned_root_not_plain_directory"));
        }
        let stable_identity = stable_directory_identity(handle)?;
        Ok(Self {
            handle,
            stable_identity,
            path: path.to_path_buf(),
        })
    }

    fn prove_empty_identity(&self, expected: Option<&str>) -> AppResult<()> {
        let before = stable_directory_identity(self.handle)?;
        if before != self.stable_identity || expected.is_some_and(|value| value != before) {
            return Err(recovery_error("owned_root_handle_identity_mismatch"));
        }
        let snapshot = root_identity_snapshot(&self.path)?;
        if snapshot.stable.as_deref() != Some(before.as_str()) {
            return Err(recovery_error("owned_root_path_snapshot_mismatch"));
        }
        let empty = fs::read_dir(&self.path)
            .map_err(|error| AppError::io("inspect owned Starter root contents", error))?
            .next()
            .is_none();
        let after = stable_directory_identity(self.handle)?;
        if before != after {
            return Err(recovery_error(
                "owned_root_identity_changed_during_inspection",
            ));
        }
        if !empty {
            return Err(recovery_error("owned_root_not_empty_before_bootstrap"));
        }
        Ok(())
    }
}

#[cfg(windows)]
impl Drop for OwnedChildGuard {
    fn drop(&mut self) {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.handle) };
    }
}

#[cfg(not(windows))]
struct OwnedChildGuard {
    stable_identity: String,
}

#[cfg(not(windows))]
impl OwnedChildGuard {
    fn create_new(_parent: &CheckedParent, _path: &Path) -> AppResult<Self> {
        Err(AppError::new(
            "project_creation_platform_unsupported",
            "Starter creation requires a no-follow child lease",
        ))
    }

    fn open_existing(_parent: &CheckedParent, _path: &Path) -> AppResult<Self> {
        Err(AppError::new(
            "project_creation_platform_unsupported",
            "Starter creation requires a no-follow child lease",
        ))
    }

    fn prove_empty_identity(&self, _expected: Option<&str>) -> AppResult<()> {
        Err(AppError::new(
            "project_creation_platform_unsupported",
            "Starter creation requires a no-follow child lease",
        ))
    }
}

#[cfg(windows)]
fn stable_directory_identity(handle: windows_sys::Win32::Foundation::HANDLE) -> AppResult<String> {
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_REPARSE_POINT,
    };
    let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(handle, &mut information) } == 0 {
        return Err(AppError::io(
            "inspect Starter directory identity",
            std::io::Error::last_os_error(),
        ));
    }
    if information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(recovery_error("directory_identity_is_reparse_point"));
    }
    let file_index =
        (u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow);
    if information.dwVolumeSerialNumber == 0 || file_index == 0 {
        return Err(AppError::new(
            "project_creation_identity_unavailable",
            "Starter directory does not expose a stable identity",
        )
        .outcome_unknown(true));
    }
    let mut bytes = Vec::with_capacity(12);
    bytes.extend_from_slice(&information.dwVolumeSerialNumber.to_be_bytes());
    bytes.extend_from_slice(&file_index.to_be_bytes());
    Ok(format!("v2:{}", hex::encode(Sha256::digest(bytes))))
}

pub fn create_or_reconcile_starter_project(
    registry: &mut ProjectRegistry,
    selected_parent: Option<PathBuf>,
    input: StarterProjectInput,
) -> AppResult<ProjectRecord> {
    let operation_ref = canonical_uuid(&input.operation_ref, "operationRef")?;
    let display_name = normalized_project_name(&input.project_name)?;
    let request_sha256 = starter_creation_request_sha256(&display_name);
    if let Some(record) = registry.committed_creation(&operation_ref, &request_sha256)? {
        return Ok(record);
    }

    let (mut claim, initial_parent) =
        if let Some(claim) = registry.starter_claim(&operation_ref, &request_sha256)? {
            (claim, None)
        } else {
            let selected_parent = selected_parent.ok_or_else(|| {
                AppError::new(
                    "project_creation_parent_required",
                    "A parent folder must be selected for a new Starter project",
                )
            })?;
            let parent = inspect_parent(&selected_parent)?;
            let final_child = parent.canonical_path.join(&display_name);
            if let Some(recovery) =
                registry.recovery_claim_for_target(&parent.canonical_path, &final_child)?
            {
                return Err(recovery_error(
                    recovery
                        .recovery_reason
                        .as_deref()
                        .unwrap_or("claim_marked_recovery_required"),
                ));
            }
            ensure_direct_child_absent(&parent.canonical_path, final_child.file_name().unwrap())?;
            let timestamp = now_ms();
            let claim = StarterCreationClaim {
                operation_ref: operation_ref.clone(),
                request_sha256: request_sha256.clone(),
                display_name: display_name.clone(),
                parent_canonical_path: canonical_path_string(&parent.canonical_path)?,
                parent_identity: parent.stable_identity.clone(),
                final_child_path: path_string(&final_child)?,
                phase: StarterCreationPhase::Planned,
                owned_root_identity: None,
                created_at_ms: timestamp,
                last_observed_at_ms: timestamp,
                recovery_reason: None,
            };
            failpoint("before_planned_persist")?;
            registry.persist_starter_claim(claim.clone())?;
            failpoint("planned_persisted")?;
            (claim, Some(parent))
        };

    if claim.display_name != display_name {
        return Err(AppError::new(
            "project_creation_operation_mismatch",
            "Starter creation operation resolved to a different project name",
        ));
    }
    if claim.phase == StarterCreationPhase::RecoveryRequired {
        return Err(recovery_error(
            claim
                .recovery_reason
                .as_deref()
                .unwrap_or("claim_marked_recovery_required"),
        ));
    }
    let parent = match initial_parent {
        Some(parent) => {
            verify_parent_identity(&claim, &parent)?;
            parent
        }
        None => verify_claim_parent(&claim)?,
    };
    let final_child = parent.canonical_path.join(&display_name);
    if !platform_path_eq(Path::new(&claim.final_child_path), &final_child) {
        return mark_recovery(registry, claim, "derived_child_path_mismatch");
    }

    let child = if claim.phase == StarterCreationPhase::Planned {
        if path_exists_no_follow(&final_child)? {
            return mark_recovery(
                registry,
                claim,
                "planned_final_path_exists_without_owned_identity",
            );
        }
        verify_parent_identity(&claim, &parent)?;
        ensure_direct_child_absent(&parent.canonical_path, final_child.file_name().unwrap())?;
        let child = match OwnedChildGuard::create_new(&parent, &final_child) {
            Ok(child) => child,
            Err(error) => {
                return Err(AppError::new(
                    "project_creation_recovery_required",
                    format!(
                        "Starter root creation could not be proven: {}",
                        error.message
                    ),
                )
                .outcome_unknown(true));
            }
        };
        verify_parent_identity(&claim, &parent)?;
        if let Err(_) = child.prove_empty_identity(None) {
            return mark_recovery(registry, claim, "new_root_identity_or_contents_unproven");
        }
        claim.phase = StarterCreationPhase::RootOwned;
        claim.owned_root_identity = Some(child.stable_identity.clone());
        claim.last_observed_at_ms = now_ms();
        if let Err(error) = registry.persist_starter_claim(claim.clone()) {
            return Err(AppError::new(
                "project_creation_recovery_required",
                format!(
                    "Created Starter root could not be durably claimed: {}",
                    error.message
                ),
            )
            .outcome_unknown(true));
        }
        failpoint("owned_identity_persisted")?;
        child
    } else {
        match OwnedChildGuard::open_existing(&parent, &final_child) {
            Ok(child) => child,
            Err(_) => return mark_recovery(registry, claim, "owned_root_unavailable"),
        }
    };

    let owned_identity = claim
        .owned_root_identity
        .clone()
        .ok_or_else(|| recovery_error("owned_identity_missing"))?;
    if child.stable_identity != owned_identity {
        return mark_recovery(registry, claim, "owned_root_identity_mismatch");
    }
    if child.prove_empty_identity(Some(&owned_identity)).is_err() {
        return mark_recovery(registry, claim, "owned_root_identity_or_contents_unproven");
    }
    verify_parent_identity(&claim, &parent)?;
    let canonical_final = fs::canonicalize(&final_child)
        .map_err(|error| AppError::io("canonicalize Starter project root", error))?;
    if !platform_path_eq(&canonical_final, &final_child) {
        return mark_recovery(registry, claim, "owned_root_canonical_path_mismatch");
    }
    let snapshot = root_identity_snapshot(&canonical_final)?;
    if snapshot.stable.as_deref() != Some(owned_identity.as_str()) {
        return mark_recovery(registry, claim, "registered_identity_mismatch");
    }
    if child.prove_empty_identity(Some(&owned_identity)).is_err() {
        return mark_recovery(
            registry,
            claim,
            "precommit_root_identity_or_contents_unproven",
        );
    }
    let root_path = canonical_path_string(&canonical_final)?;
    let legacy_identity = snapshot.legacy_for(&canonical_final);
    failpoint("before_registry_commit")?;
    let record =
        registry.commit_starter_project(&claim, root_path, legacy_identity, owned_identity)?;
    failpoint("registry_commit_response_lost")?;
    Ok(record)
}

pub fn reconcile_starter_creations_on_open(registry: &mut ProjectRegistry) -> AppResult<()> {
    for claim in registry.starter_claims() {
        if claim.phase == StarterCreationPhase::RecoveryRequired {
            continue;
        }
        let parent = match verify_claim_parent(&claim) {
            Ok(parent) => parent,
            Err(_) => {
                registry.mark_starter_recovery_required(claim, "restart_parent_unavailable")?;
                continue;
            }
        };
        let expected_final = parent.canonical_path.join(&claim.display_name);
        if !platform_path_eq(Path::new(&claim.final_child_path), &expected_final) {
            registry.mark_starter_recovery_required(claim, "restart_derived_path_mismatch")?;
            continue;
        }
        if claim.phase == StarterCreationPhase::Planned {
            if path_exists_no_follow(&expected_final)? {
                registry.mark_starter_recovery_required(
                    claim,
                    "restart_planned_final_exists_without_owned_identity",
                )?;
            } else {
                registry.retire_planned_claim(&claim.operation_ref)?;
            }
            continue;
        }
        // RootOwned recovery re-enters the normal creation state machine, which
        // acquires and retains its own parent lease through commit. Release the
        // startup preflight lease first so its deny-delete sharing cannot block
        // the same process from opening the authoritative lease.
        drop(parent);
        let input = StarterProjectInput {
            operation_ref: claim.operation_ref.clone(),
            project_name: claim.display_name.clone(),
        };
        if let Err(error) = create_or_reconcile_starter_project(registry, None, input) {
            if error.outcome_unknown {
                registry.reload_from_disk()?;
                if registry
                    .committed_creation(&claim.operation_ref, &claim.request_sha256)?
                    .is_some()
                {
                    continue;
                }
                if registry
                    .starter_claim(&claim.operation_ref, &claim.request_sha256)?
                    .is_some_and(|fresh| fresh.phase == StarterCreationPhase::RecoveryRequired)
                {
                    continue;
                }
            }
            // A durable RootOwned claim remains retryable. Only the production
            // state machine may write RecoveryRequired after proving a concrete
            // path/identity conflict; never overwrite from this stale loop copy.
            return Err(error);
        }
    }
    Ok(())
}

fn inspect_parent(path: &Path) -> AppResult<CheckedParent> {
    reject_reparse_components(path)?;
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| AppError::io("inspect Starter parent", error))?;
    reject_link_or_reparse(path, &metadata)?;
    if !metadata.is_dir() {
        return Err(AppError::new(
            "project_creation_parent_invalid",
            "Starter parent is not a directory",
        ));
    }
    let mutation_guard = ParentMutationGuard::open(path)?;
    let canonical = fs::canonicalize(path)
        .map_err(|error| AppError::io("canonicalize Starter parent", error))?;
    reject_reparse_components(&canonical)?;
    let stable_identity = mutation_guard.stable_identity()?;
    Ok(CheckedParent {
        canonical_path: canonical,
        stable_identity,
        mutation_guard,
    })
}

fn verify_claim_parent(claim: &StarterCreationClaim) -> AppResult<CheckedParent> {
    let parent = inspect_parent(Path::new(&claim.parent_canonical_path))?;
    if !platform_path_eq(
        &parent.canonical_path,
        Path::new(&claim.parent_canonical_path),
    ) || parent.stable_identity != claim.parent_identity
    {
        return Err(recovery_error("parent_identity_changed"));
    }
    Ok(parent)
}

fn verify_parent_identity(claim: &StarterCreationClaim, parent: &CheckedParent) -> AppResult<()> {
    if parent.mutation_guard.stable_identity()? != claim.parent_identity
        || parent.stable_identity != claim.parent_identity
        || !platform_path_eq(
            &parent.canonical_path,
            Path::new(&claim.parent_canonical_path),
        )
    {
        return Err(recovery_error("parent_identity_changed"));
    }
    Ok(())
}

fn verify_direct_child(parent: &CheckedParent, child: &Path) -> AppResult<()> {
    if child.parent().map_or(true, |candidate| {
        !platform_path_eq(candidate, &parent.canonical_path)
    }) {
        return Err(recovery_error("child_escaped_parent"));
    }
    Ok(())
}

fn path_exists_no_follow(path: &Path) -> AppResult<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(AppError::io("inspect Starter path", error)),
    }
}

fn ensure_direct_child_absent(parent: &Path, requested_name: &std::ffi::OsStr) -> AppResult<()> {
    for entry in
        fs::read_dir(parent).map_err(|error| AppError::io("enumerate Starter parent", error))?
    {
        let entry = entry.map_err(|error| AppError::io("read Starter parent entry", error))?;
        if platform_name_eq(&entry.file_name(), requested_name) {
            return Err(AppError::new(
                "project_creation_target_exists",
                "A project folder with that name already exists",
            ));
        }
    }
    Ok(())
}

fn reject_reparse_components(path: &Path) -> AppResult<()> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        if matches!(component, std::path::Component::Prefix(_))
            || !current.has_root()
            || current.parent().is_none()
        {
            continue;
        }
        let metadata = fs::symlink_metadata(&current).map_err(|error| {
            AppError::new(
                "native_io_failed",
                format!(
                    "inspect Starter path component {}: {error}",
                    current.display()
                ),
            )
        })?;
        reject_link_or_reparse(&current, &metadata)?;
    }
    Ok(())
}

fn reject_link_or_reparse(path: &Path, metadata: &fs::Metadata) -> AppResult<()> {
    if metadata.file_type().is_symlink() {
        return Err(AppError::new(
            "project_creation_reparse_rejected",
            format!("Starter path contains a link: {}", path.display()),
        ));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(AppError::new(
                "project_creation_reparse_rejected",
                format!("Starter path contains a reparse point: {}", path.display()),
            ));
        }
    }
    Ok(())
}

fn path_string(path: &Path) -> AppResult<String> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| AppError::new("project_path_not_utf8", "Project path is not valid UTF-8"))
}

fn mark_recovery(
    registry: &mut ProjectRegistry,
    claim: StarterCreationClaim,
    reason: &str,
) -> AppResult<ProjectRecord> {
    registry.mark_starter_recovery_required(claim, reason)?;
    Err(recovery_error(reason))
}

fn recovery_error(reason: &str) -> AppError {
    AppError::new(
        "project_creation_recovery_required",
        format!("Starter project creation requires recovery: {reason}"),
    )
    .outcome_unknown(true)
}

#[cfg(test)]
thread_local! {
    static TEST_FAILPOINT: std::cell::RefCell<Option<&'static str>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn failpoint(name: &'static str) -> AppResult<()> {
    let active = TEST_FAILPOINT.with(|current| *current.borrow());
    if active == Some(name) {
        return Err(AppError::new(
            "project_creation_test_failpoint",
            format!("Starter creation failpoint: {name}"),
        )
        .outcome_unknown(true));
    }
    Ok(())
}

#[cfg(test)]
fn set_failpoint(name: Option<&'static str>) {
    TEST_FAILPOINT.with(|current| *current.borrow_mut() = name);
}

#[cfg(not(test))]
fn failpoint(_name: &'static str) -> AppResult<()> {
    Ok(())
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    fn test_paths(label: &str) -> (PathBuf, PathBuf, PathBuf) {
        let base =
            std::env::temp_dir().join(format!("orquesta-starter-{label}-{}", uuid::Uuid::new_v4()));
        let parent = base.join("projects");
        let registry_path = base.join("state").join("projects.v1.json");
        std::fs::create_dir_all(&parent).expect("create project parent");
        (base, parent, registry_path)
    }

    fn input(name: &str) -> StarterProjectInput {
        StarterProjectInput {
            operation_ref: uuid::Uuid::new_v4().hyphenated().to_string(),
            project_name: name.to_owned(),
        }
    }

    #[test]
    fn creates_one_final_root_without_staging_and_replays_the_same_operation() {
        let (base, parent, registry_path) = test_paths("normal");
        let mut registry = ProjectRegistry::open(registry_path).expect("open registry");
        let request = input("顧客管理");
        let first = create_or_reconcile_starter_project(
            &mut registry,
            Some(parent.clone()),
            request.clone(),
        )
        .expect("create Starter project");
        let replay = create_or_reconcile_starter_project(&mut registry, None, request.clone())
            .expect("replay committed creation");

        assert_eq!(first, replay);
        assert_eq!(
            first.creation_operation_ref.as_deref(),
            Some(request.operation_ref.as_str())
        );
        assert!(parent.join("顧客管理").is_dir());
        assert!(registry.starter_claims().is_empty());
        assert!(std::fs::read_dir(&parent)
            .expect("read parent")
            .all(|entry| !entry
                .expect("entry")
                .file_name()
                .to_string_lossy()
                .starts_with(".orquesta-starter-")));
        drop(registry);
        std::fs::remove_dir_all(base).expect("cleanup");
    }

    #[test]
    fn planned_prewrite_failpoint_mutates_neither_registry_nor_filesystem() {
        let (base, parent, registry_path) = test_paths("before-planned");
        let mut registry = ProjectRegistry::open(registry_path).expect("open registry");
        let request = input("計画前停止");
        set_failpoint(Some("before_planned_persist"));
        create_or_reconcile_starter_project(&mut registry, Some(parent.clone()), request.clone())
            .expect_err("stop before planned persist");
        set_failpoint(None);
        assert!(registry.starter_claims().is_empty());
        assert!(!parent.join(request.project_name).exists());
        std::fs::remove_dir_all(base).expect("cleanup");
    }

    #[test]
    fn child_handle_boundary_keeps_planned_plus_unclaimed_final_for_recovery() {
        let (base, parent, registry_path) = test_paths("child-handle-boundary");
        let mut registry = ProjectRegistry::open(registry_path.clone()).expect("open registry");
        let request = input("ハンドル後停止");
        set_failpoint(Some("child_handle_acquired"));
        create_or_reconcile_starter_project(&mut registry, Some(parent.clone()), request.clone())
            .expect_err("stop after child handle acquisition");
        set_failpoint(None);
        assert!(parent.join(&request.project_name).is_dir());
        assert_eq!(
            registry.starter_claims()[0].phase,
            StarterCreationPhase::Planned
        );
        drop(registry);
        let mut reopened = ProjectRegistry::open(registry_path).expect("reopen registry");
        reconcile_starter_creations_on_open(&mut reopened).expect("classify unclaimed final");
        assert_eq!(
            reopened.starter_claims()[0].phase,
            StarterCreationPhase::RecoveryRequired
        );
        std::fs::remove_dir_all(base).expect("cleanup");
    }

    #[test]
    fn precommit_failpoint_leaves_root_owned_claim_retryable() {
        let (base, parent, registry_path) = test_paths("before-commit");
        let mut registry = ProjectRegistry::open(registry_path.clone()).expect("open registry");
        let request = input("コミット前停止");
        set_failpoint(Some("before_registry_commit"));
        create_or_reconcile_starter_project(&mut registry, Some(parent), request.clone())
            .expect_err("stop before registry commit");
        set_failpoint(None);
        assert_eq!(
            registry.starter_claims()[0].phase,
            StarterCreationPhase::RootOwned
        );
        assert!(registry.list().is_empty());
        drop(registry);
        let mut reopened = ProjectRegistry::open(registry_path).expect("reopen registry");
        let record = create_or_reconcile_starter_project(&mut reopened, None, request)
            .expect("retry exact RootOwned claim");
        assert_eq!(record.display_name, "コミット前停止");
        assert!(reopened.starter_claims().is_empty());
        std::fs::remove_dir_all(base).expect("cleanup");
    }

    #[test]
    fn response_loss_after_commit_replays_without_a_second_picker_or_folder() {
        let (base, parent, registry_path) = test_paths("response-loss");
        let mut registry = ProjectRegistry::open(registry_path.clone()).expect("open registry");
        let request = input("失応答復旧");
        set_failpoint(Some("registry_commit_response_lost"));
        let error = create_or_reconcile_starter_project(
            &mut registry,
            Some(parent.clone()),
            request.clone(),
        )
        .expect_err("inject response loss");
        set_failpoint(None);
        assert!(error.outcome_unknown);
        drop(registry);

        let mut reopened = ProjectRegistry::open(registry_path).expect("reopen registry");
        let replay = create_or_reconcile_starter_project(&mut reopened, None, request)
            .expect("replay exact committed operation");
        assert_eq!(replay.display_name, "失応答復旧");
        assert_eq!(reopened.list().len(), 1);
        assert_eq!(std::fs::read_dir(&parent).expect("read parent").count(), 1);
        drop(reopened);
        std::fs::remove_dir_all(base).expect("cleanup");
    }

    #[test]
    fn planned_without_a_child_is_retired_on_restart() {
        let (base, parent, registry_path) = test_paths("planned-restart");
        let mut registry = ProjectRegistry::open(registry_path.clone()).expect("open registry");
        let request = input("計画のみ");
        set_failpoint(Some("planned_persisted"));
        create_or_reconcile_starter_project(&mut registry, Some(parent), request)
            .expect_err("stop after planned claim");
        set_failpoint(None);
        drop(registry);

        let mut reopened = ProjectRegistry::open(registry_path).expect("reopen registry");
        assert_eq!(reopened.starter_claims().len(), 1);
        inspect_parent(Path::new(
            &reopened.starter_claims()[0].parent_canonical_path,
        ))
        .expect("reopen canonical parent lease");
        reconcile_starter_creations_on_open(&mut reopened).expect("retire planned claim");
        assert!(
            reopened.starter_claims().is_empty(),
            "remaining claims: {:?}",
            reopened.starter_claims()
        );
        drop(reopened);
        std::fs::remove_dir_all(base).expect("cleanup");
    }

    #[test]
    fn ambiguous_planned_persist_blocks_same_process_retry_before_picker_or_filesystem() {
        let (base, parent, registry_path) = test_paths("planned-poison");
        let mut registry = ProjectRegistry::open(registry_path.clone()).expect("open registry");
        let request = input("計画権限不明");
        crate::storage::set_atomic_write_failpoint(Some("after_replace"));
        crate::registry::set_commit_readback_failpoint(Some("fresh_open_error"));
        let first = create_or_reconcile_starter_project(
            &mut registry,
            Some(parent.clone()),
            request.clone(),
        )
        .expect_err("cannot refresh the durable planned claim");
        crate::storage::set_atomic_write_failpoint(None);
        crate::registry::set_commit_readback_failpoint(None);
        assert!(first.outcome_unknown);

        let retry = create_or_reconcile_starter_project(&mut registry, None, request.clone())
            .expect_err("poisoned authority stops before requiring another picker");
        assert_eq!(retry.code, "project_registry_reopen_required");
        assert!(!parent.join(&request.project_name).exists());

        let reopened = ProjectRegistry::open(registry_path).expect("reopen durable planned claim");
        assert_eq!(reopened.starter_claims().len(), 1);
        assert_eq!(
            reopened.starter_claims()[0].phase,
            StarterCreationPhase::Planned
        );
        std::fs::remove_dir_all(base).expect("cleanup");
    }

    #[test]
    fn ambiguous_root_owned_persist_blocks_same_process_retry_without_overwrite() {
        let (base, parent_path, registry_path) = test_paths("owned-poison");
        let parent = inspect_parent(&parent_path).expect("lease parent");
        let request = input("所有権不明");
        let display_name = normalized_project_name(&request.project_name).expect("name");
        let final_child = parent.canonical_path.join(&display_name);
        let timestamp = now_ms();
        let mut claim = StarterCreationClaim {
            operation_ref: request.operation_ref.clone(),
            request_sha256: starter_creation_request_sha256(&display_name),
            display_name,
            parent_canonical_path: canonical_path_string(&parent.canonical_path).expect("parent"),
            parent_identity: parent.stable_identity.clone(),
            final_child_path: path_string(&final_child).expect("child"),
            phase: StarterCreationPhase::Planned,
            owned_root_identity: None,
            created_at_ms: timestamp,
            last_observed_at_ms: timestamp,
            recovery_reason: None,
        };
        let mut registry = ProjectRegistry::open(registry_path.clone()).expect("open registry");
        registry
            .persist_starter_claim(claim.clone())
            .expect("persist planned");
        let child = OwnedChildGuard::create_new(&parent, &final_child).expect("create owned child");
        claim.phase = StarterCreationPhase::RootOwned;
        claim.owned_root_identity = Some(child.stable_identity.clone());
        claim.last_observed_at_ms = now_ms();

        crate::storage::set_atomic_write_failpoint(Some("after_replace"));
        crate::registry::set_commit_readback_failpoint(Some("fresh_open_error"));
        let first = registry
            .persist_starter_claim(claim.clone())
            .expect_err("cannot refresh durable RootOwned claim");
        crate::storage::set_atomic_write_failpoint(None);
        crate::registry::set_commit_readback_failpoint(None);
        assert!(first.outcome_unknown);

        let retry = create_or_reconcile_starter_project(&mut registry, None, request)
            .expect_err("poisoned authority prevents stale Planned recovery write");
        assert_eq!(retry.code, "project_registry_reopen_required");
        drop(child);
        drop(parent);
        let reopened =
            ProjectRegistry::open(registry_path).expect("reopen durable RootOwned claim");
        assert_eq!(reopened.starter_claims(), vec![claim]);
        assert!(reopened.list().is_empty());
        std::fs::remove_dir_all(base).expect("cleanup");
    }

    #[test]
    fn planned_with_an_unclaimed_final_root_becomes_recovery_required() {
        let (base, parent, registry_path) = test_paths("unclaimed-final");
        let mut registry = ProjectRegistry::open(registry_path.clone()).expect("open registry");
        let request = input("未証明ルート");
        set_failpoint(Some("final_create_completed"));
        create_or_reconcile_starter_project(&mut registry, Some(parent), request)
            .expect_err("stop after atomic create");
        set_failpoint(None);
        drop(registry);

        let mut reopened = ProjectRegistry::open(registry_path).expect("reopen registry");
        reconcile_starter_creations_on_open(&mut reopened).expect("classify claim");
        assert_eq!(
            reopened.starter_claims()[0].phase,
            StarterCreationPhase::RecoveryRequired
        );
        drop(reopened);
        std::fs::remove_dir_all(base).expect("cleanup");
    }

    #[test]
    fn root_owned_claim_commits_on_restart_without_the_renderer_operation_state() {
        let (base, parent, registry_path) = test_paths("root-owned-restart");
        let mut registry = ProjectRegistry::open(registry_path.clone()).expect("open registry");
        let request = input("再起動復旧");
        set_failpoint(Some("owned_identity_persisted"));
        create_or_reconcile_starter_project(&mut registry, Some(parent), request.clone())
            .expect_err("stop after RootOwned claim");
        set_failpoint(None);
        drop(registry);

        let mut reopened = ProjectRegistry::open(registry_path).expect("reopen registry");
        reconcile_starter_creations_on_open(&mut reopened).expect("commit RootOwned claim");
        assert!(
            reopened.starter_claims().is_empty(),
            "remaining claims: {:?}",
            reopened.starter_claims()
        );
        assert_eq!(reopened.list().len(), 1);
        assert_eq!(
            reopened.list()[0].creation_operation_ref.as_deref(),
            Some(request.operation_ref.as_str())
        );
        drop(reopened);
        std::fs::remove_dir_all(base).expect("cleanup");
    }

    #[test]
    fn missing_root_owned_child_is_visible_recovery_without_blocking_startup() {
        let (base, parent, registry_path) = test_paths("root-owned-missing-child");
        let mut registry = ProjectRegistry::open(registry_path.clone()).expect("open registry");
        let request = input("消失ルート");
        set_failpoint(Some("owned_identity_persisted"));
        create_or_reconcile_starter_project(&mut registry, Some(parent.clone()), request)
            .expect_err("stop after RootOwned claim");
        set_failpoint(None);
        drop(registry);
        std::fs::remove_dir(parent.join("消失ルート")).expect("simulate missing owned child");

        let mut reopened = ProjectRegistry::open(registry_path).expect("reopen registry");
        reconcile_starter_creations_on_open(&mut reopened)
            .expect("startup keeps terminal RecoveryRequired visible");
        assert_eq!(
            reopened.starter_claims()[0].phase,
            StarterCreationPhase::RecoveryRequired
        );
        assert_eq!(
            reopened.starter_claims()[0].recovery_reason.as_deref(),
            Some("owned_root_unavailable")
        );
        let retry =
            create_or_reconcile_starter_project(&mut reopened, Some(parent), input("消失ルート"))
                .expect_err("surface the durable recovery claim instead of generic target exists");
        assert_eq!(retry.code, "project_creation_recovery_required");
        assert!(retry.message.contains("owned_root_unavailable"));
        std::fs::remove_dir_all(base).expect("cleanup");
    }

    #[test]
    fn a_different_operation_cannot_claim_the_same_final_name() {
        let (base, parent, registry_path) = test_paths("different-operation");
        let mut registry = ProjectRegistry::open(registry_path).expect("open registry");
        create_or_reconcile_starter_project(&mut registry, Some(parent.clone()), input("同じ名前"))
            .expect("first creation");
        let error =
            create_or_reconcile_starter_project(&mut registry, Some(parent), input("同じ名前"))
                .expect_err("reject second operation");
        assert_eq!(error.code, "project_creation_target_exists");
        assert_eq!(registry.list().len(), 1);
        drop(registry);
        std::fs::remove_dir_all(base).expect("cleanup");
    }

    #[test]
    fn windows_casefold_collision_is_rejected_before_mutation() {
        let (base, parent, registry_path) = test_paths("unicode-collision");
        std::fs::create_dir(parent.join("ÅNGSTRÖM")).expect("create colliding folder");
        let mut registry = ProjectRegistry::open(registry_path).expect("open registry");
        let error =
            create_or_reconcile_starter_project(&mut registry, Some(parent), input("ångström"))
                .expect_err("reject Windows case collision");
        assert_eq!(error.code, "project_creation_target_exists");
        assert!(registry.starter_claims().is_empty());
        drop(registry);
        std::fs::remove_dir_all(base).expect("cleanup");
    }

    #[test]
    fn parent_lease_blocks_a_swap_while_creation_is_in_flight() {
        let (base, parent, _registry_path) = test_paths("parent-lease");
        let checked = inspect_parent(&parent).expect("lease parent");
        let moved = base.join("moved");
        assert!(std::fs::rename(&parent, &moved).is_err());
        drop(checked);
        std::fs::rename(&parent, &moved).expect("rename after lease release");
        std::fs::remove_dir_all(base).expect("cleanup");
    }

    #[test]
    fn parent_lease_can_identity_the_current_volume_root() {
        let temp = std::env::temp_dir();
        let root = temp.ancestors().last().expect("volume root");
        let guard = ParentMutationGuard::open(root).expect("open volume root lease");
        assert!(guard
            .stable_identity()
            .expect("volume identity")
            .starts_with("v2:"));
    }

    #[test]
    fn creation_source_contains_no_staging_rename_or_automatic_delete_path() {
        let source = include_str!("starter_creation.rs")
            .split("#[cfg(all(test, windows))]")
            .next()
            .expect("production source");
        assert!(!source.contains("staging_child"));
        assert!(!source.contains("rename_noreplace"));
        assert!(!source.contains("rollback_owned"));
        assert!(!source.contains("fs::remove_dir("));
    }
}
