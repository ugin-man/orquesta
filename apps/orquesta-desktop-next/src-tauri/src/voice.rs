use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use reqwest::header::{CONTENT_LENGTH, CONTENT_RANGE, RANGE};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;
use tokio::sync::{watch, Mutex, Notify, OwnedMutexGuard};

use crate::asset_catalog::{AssetCatalog, DesktopAsset, DesktopAssetKind};
use crate::error::{AppError, AppResult};
use crate::logging::now_ms;
use crate::process_containment::{
    containment_definitively_gone_after_instance_lock, spawn_contained,
};
use crate::storage::{
    atomic_write_json, load_primary_or_backup, materialize_sentinel, private_directory, read_json,
    sync_directory,
};

mod install;
mod transcription;

use install::{
    reconcile_document, recover_install_directories, remove_flat_asset_directory,
    remove_regular_file_if_exists, verify_install_receipt, verify_regular_metadata,
};
use transcription::{
    operation_paths, pcm_sha256, read_transcript, remove_operation_directory, stage_pcm_wav,
    validate_pcm, whisper_process_spec, OperationPaths,
};

const VOICE_STATE_SCHEMA_VERSION: u32 = 3;
const VOICE_STATUS_SCHEMA_VERSION: u32 = 2;
const DOWNLOAD_CHECKPOINT_BYTES: u64 = 4 * 1024 * 1024;
const MAX_REDIRECTS: usize = 5;
const HTTP_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const HTTP_READ_TIMEOUT: Duration = Duration::from_secs(30);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(35);
const INSTALL_RECEIPT_FILE: &str = "install-receipt.v1.json";
const TRANSCRIPTION_NAMESPACE: &str = "voice-transcription";
const TRANSCRIPTION_TIMEOUT: Duration = Duration::from_secs(150);
const MAX_RETAINED_OPERATIONS: usize = 32;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum VoiceAssetPhase {
    Absent,
    Paused,
    Downloading,
    Verifying,
    Installing,
    Deleting,
    Installed,
    Failed,
    RecoveryRequired,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VoiceAssetRecord {
    asset_id: String,
    kind: String,
    phase: VoiceAssetPhase,
    downloaded_bytes: u64,
    expected_bytes: u64,
    operation_ref: Option<String>,
    installed_source_sha256: Option<String>,
    installed_at_ms: Option<u64>,
    last_error_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VoiceStateDocument {
    schema_version: u32,
    revision: u64,
    assets: BTreeMap<String, VoiceAssetRecord>,
    #[serde(default)]
    operations: BTreeMap<String, VoiceOperationRecord>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VoiceStateDocumentV2 {
    schema_version: u32,
    revision: u64,
    assets: BTreeMap<String, VoiceAssetRecord>,
    #[serde(default)]
    operations: BTreeMap<String, VoiceOperationRecordV2>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum VoiceOperationPhase {
    Staging,
    Transcribing,
    Transcribed,
    Cancelled,
    Failed,
    RecoveryRequired,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "state",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum VoiceComposerBinding {
    Agent {
        project_id: String,
        agent_id: String,
        draft_sha256: String,
    },
    Launcher {
        draft_sha256: String,
    },
    LegacyUnbound,
}

impl VoiceOperationPhase {
    fn is_terminal(&self) -> bool {
        matches!(
            self,
            Self::Transcribed | Self::Cancelled | Self::Failed | Self::RecoveryRequired
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VoiceOperationRecord {
    operation_ref: String,
    renderer_session_id: String,
    renderer_generation: u64,
    window_label: String,
    composer_binding: VoiceComposerBinding,
    phase: VoiceOperationPhase,
    pcm_sha256: String,
    sample_count: u32,
    duration_ms: u64,
    transcript: Option<String>,
    last_error_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    recovery_target_phase: Option<VoiceOperationPhase>,
    containment_kind: Option<String>,
    containment_id: Option<String>,
    expected_pid: Option<u32>,
    created_at_ms: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VoiceOperationRecordV2 {
    operation_ref: String,
    renderer_session_id: String,
    renderer_generation: u64,
    window_label: String,
    phase: VoiceOperationPhase,
    pcm_sha256: String,
    sample_count: u32,
    duration_ms: u64,
    transcript: Option<String>,
    last_error_code: Option<String>,
    #[serde(default)]
    recovery_target_phase: Option<VoiceOperationPhase>,
    containment_kind: Option<String>,
    containment_id: Option<String>,
    expected_pid: Option<u32>,
    created_at_ms: u64,
}

impl From<VoiceOperationRecordV2> for VoiceOperationRecord {
    fn from(record: VoiceOperationRecordV2) -> Self {
        Self {
            operation_ref: record.operation_ref,
            renderer_session_id: record.renderer_session_id,
            renderer_generation: record.renderer_generation,
            window_label: record.window_label,
            composer_binding: VoiceComposerBinding::LegacyUnbound,
            phase: record.phase,
            pcm_sha256: record.pcm_sha256,
            sample_count: record.sample_count,
            duration_ms: record.duration_ms,
            transcript: record.transcript,
            last_error_code: record.last_error_code,
            recovery_target_phase: record.recovery_target_phase,
            containment_kind: record.containment_kind,
            containment_id: record.containment_id,
            expected_pid: record.expected_pid,
            created_at_ms: record.created_at_ms,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VoiceOperationStatus {
    pub(crate) operation_ref: String,
    pub(crate) composer_binding: VoiceComposerBinding,
    pub(crate) phase: VoiceOperationPhase,
    pub(crate) duration_ms: u64,
    pub(crate) transcript: Option<String>,
    pub(crate) last_error_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VoiceAssetStatus {
    pub(crate) asset_id: String,
    pub(crate) kind: String,
    pub(crate) phase: VoiceAssetPhase,
    pub(crate) downloaded_bytes: u64,
    pub(crate) expected_bytes: u64,
    pub(crate) operation_ref: Option<String>,
    pub(crate) last_error_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VoiceStatus {
    pub(crate) schema_version: u32,
    pub(crate) revision: u64,
    pub(crate) provider_id: String,
    pub(crate) binary_asset_id: String,
    pub(crate) initial_model_asset_id: String,
    pub(crate) comparison_model_asset_id: String,
    pub(crate) required_assets_ready: bool,
    pub(crate) assets: Vec<VoiceAssetStatus>,
    pub(crate) operations: Vec<VoiceOperationStatus>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VoiceStatusEvent {
    schema_version: u32,
    renderer_session_id: String,
    renderer_generation: u64,
    window_label: String,
    status: VoiceStatus,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct VoiceSessionOwner {
    renderer_session_id: String,
    renderer_generation: u64,
    window_label: String,
}

impl VoiceSessionOwner {
    pub(crate) fn new(
        renderer_session_id: String,
        renderer_generation: u64,
        window_label: String,
    ) -> Self {
        Self {
            renderer_session_id,
            renderer_generation,
            window_label,
        }
    }
}

#[derive(Clone)]
pub(crate) struct VoiceService {
    inner: Arc<VoiceServiceInner>,
}

struct VoiceServiceInner {
    emit_status: Arc<dyn Fn(VoiceSessionOwner, VoiceStatus) + Send + Sync>,
    catalog: AssetCatalog,
    transfers_root: PathBuf,
    installed_root: PathBuf,
    operations_root: PathBuf,
    state_path: PathBuf,
    client: reqwest::Client,
    asset_locks: HashMap<String, Arc<Mutex<()>>>,
    runtime: Mutex<VoiceRuntime>,
    changed: Notify,
    #[cfg(test)]
    acquisition_runner: Option<TestAcquisitionRunner>,
}

#[cfg(test)]
type TestAcquisitionFuture =
    std::pin::Pin<Box<dyn std::future::Future<Output = AppResult<InstallReceipt>> + Send>>;

#[cfg(test)]
type TestAcquisitionRunner =
    Arc<dyn Fn(DesktopAsset, String, watch::Receiver<bool>) -> TestAcquisitionFuture + Send + Sync>;

struct VoiceRuntime {
    document: VoiceStateDocument,
    active: HashMap<String, ActiveTransfer>,
    active_transcriptions: HashMap<String, ActiveTranscription>,
    leases: HashMap<String, usize>,
    recovery_required: HashSet<String>,
    transcription_recovery_required: HashSet<String>,
}

struct ActiveTransfer {
    operation_ref: String,
    owner: VoiceSessionOwner,
    cancel: watch::Sender<bool>,
}

struct ActiveTranscription {
    owner: VoiceSessionOwner,
    cancel: watch::Sender<bool>,
}

enum ProcessWaitOutcome {
    Exited(std::process::ExitStatus),
    Cancelled,
    TimedOut,
    PollFailed(AppError),
}

#[derive(Debug, Clone)]
struct TranscriptionProcessIdentity {
    containment_kind: String,
    containment_id: String,
    expected_pid: u32,
}

enum TranscriptionExecution {
    Terminal {
        result: AppResult<String>,
        identity: Option<TranscriptionProcessIdentity>,
    },
    RecoveryRequired {
        error: AppError,
        identity: TranscriptionProcessIdentity,
        target_phase: VoiceOperationPhase,
    },
}

#[derive(Debug)]
struct VerifiedLicense {
    file_name: String,
    bytes: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InstallReceipt {
    schema_version: u32,
    asset_id: String,
    source_sha256: String,
    operation_ref: String,
    installed_at_ms: u64,
    files: BTreeMap<String, InstalledFileReceipt>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InstalledFileReceipt {
    size_bytes: u64,
    sha256: String,
}

impl VoiceStateDocument {
    fn from_catalog(catalog: &AssetCatalog) -> Self {
        let assets = catalog
            .assets()
            .map(|asset| {
                (
                    asset.asset_id.clone(),
                    VoiceAssetRecord {
                        asset_id: asset.asset_id.clone(),
                        kind: asset.kind.as_str().to_owned(),
                        phase: VoiceAssetPhase::Absent,
                        downloaded_bytes: 0,
                        expected_bytes: asset.size_bytes,
                        operation_ref: None,
                        installed_source_sha256: None,
                        installed_at_ms: None,
                        last_error_code: None,
                    },
                )
            })
            .collect();
        Self {
            schema_version: VOICE_STATE_SCHEMA_VERSION,
            revision: 0,
            assets,
            operations: BTreeMap::new(),
        }
    }
}

impl VoiceService {
    pub(crate) fn open(app: AppHandle, root: PathBuf) -> AppResult<Self> {
        let emit_status = Arc::new(move |owner: VoiceSessionOwner, status: VoiceStatus| {
            let event = VoiceStatusEvent {
                schema_version: VOICE_STATUS_SCHEMA_VERSION,
                renderer_session_id: owner.renderer_session_id.clone(),
                renderer_generation: owner.renderer_generation,
                window_label: owner.window_label.clone(),
                status,
            };
            let _ = app.emit_to(
                owner.window_label,
                crate::protocol::GENERATED_NATIVE_EVENT_VOICE_STATUS,
                event,
            );
        });
        Self::open_with_components(root, emit_status)
    }

    fn open_with_components(
        root: PathBuf,
        emit_status: Arc<dyn Fn(VoiceSessionOwner, VoiceStatus) + Send + Sync>,
    ) -> AppResult<Self> {
        let catalog = AssetCatalog::load()?;
        private_directory(&root)?;
        let state_root = direct_child(&root, "state", "Voice state root")?;
        let transfers_root = direct_child(&root, "transfers", "Voice transfer root")?;
        let installed_root = direct_child(&root, "installed", "Voice installed root")?;
        let operations_root = direct_child(&root, "operations", "Voice operation root")?;
        private_directory(&state_root)?;
        private_directory(&transfers_root)?;
        private_directory(&installed_root)?;
        private_directory(&operations_root)?;
        let state_path = direct_child(&state_root, "voice-state.v1.json", "Voice state file")?;
        materialize_sentinel(&state_path, &VoiceStateDocument::from_catalog(&catalog))?;
        let document: serde_json::Value =
            load_primary_or_backup(&state_path, "voice_state_identity_uncertain")?;
        let mut document = migrate_voice_document(document)?;
        recover_install_directories(&catalog, &installed_root)?;
        reconcile_document(&catalog, &transfers_root, &installed_root, &mut document)?;
        reconcile_transcription_operations(&operations_root, &mut document)?;
        persist_voice_document(&state_path, &document)?;
        let transcription_recovery_required = document
            .operations
            .iter()
            .filter(|(_, record)| record.phase == VoiceOperationPhase::RecoveryRequired)
            .map(|(operation_ref, _)| operation_ref.clone())
            .collect();
        let client = reqwest::Client::builder()
            .https_only(true)
            .connect_timeout(HTTP_CONNECT_TIMEOUT)
            .read_timeout(HTTP_READ_TIMEOUT)
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() >= MAX_REDIRECTS {
                    return attempt.error("voice asset redirect limit exceeded");
                }
                if allowed_download_url(attempt.url()) {
                    attempt.follow()
                } else {
                    attempt.error("voice asset redirect target is not allowed")
                }
            }))
            .user_agent("Orquesta-Desktop-Next/0.5 local-voice")
            .build()
            .map_err(|error| AppError::new("voice_http_unavailable", error.to_string()))?;
        let asset_locks = catalog
            .assets()
            .map(|asset| (asset.asset_id.clone(), Arc::new(Mutex::new(()))))
            .collect();
        Ok(Self {
            inner: Arc::new(VoiceServiceInner {
                emit_status,
                catalog,
                transfers_root,
                installed_root,
                operations_root,
                state_path,
                client,
                asset_locks,
                runtime: Mutex::new(VoiceRuntime {
                    document,
                    active: HashMap::new(),
                    active_transcriptions: HashMap::new(),
                    leases: HashMap::new(),
                    recovery_required: HashSet::new(),
                    transcription_recovery_required,
                }),
                changed: Notify::new(),
                #[cfg(test)]
                acquisition_runner: None,
            }),
        })
    }

    #[cfg(test)]
    fn open_for_test(root: PathBuf, acquisition_runner: TestAcquisitionRunner) -> AppResult<Self> {
        let mut service = Self::open_with_components(root, Arc::new(|_, _| {}))?;
        Arc::get_mut(&mut service.inner)
            .expect("test service has one owner")
            .acquisition_runner = Some(acquisition_runner);
        Ok(service)
    }

    #[cfg(test)]
    pub(crate) async fn status(&self) -> VoiceStatus {
        let runtime = self.inner.runtime.lock().await;
        self.status_from(&runtime)
    }

    pub(crate) async fn status_for(&self, owner: &VoiceSessionOwner) -> VoiceStatus {
        let runtime = self.inner.runtime.lock().await;
        self.status_from_for(&runtime, Some(owner))
    }

    pub(crate) async fn start_asset_acquisition(
        &self,
        asset_id: &str,
        owner: VoiceSessionOwner,
    ) -> AppResult<VoiceStatus> {
        let asset = self.inner.catalog.asset(asset_id)?.clone();
        let _asset_operation = self.lock_asset_operation(asset_id).await?;
        let operation_ref = uuid::Uuid::new_v4().hyphenated().to_string();
        let (cancel, cancel_rx) = watch::channel(false);
        {
            let mut runtime = self.inner.runtime.lock().await;
            if runtime.recovery_required.contains(asset_id) {
                return Err(recovery_required_error());
            }
            if let Some(active) = runtime.active.get(asset_id) {
                if active.owner == owner {
                    return Ok(self.status_from_for(&runtime, Some(&owner)));
                }
                return Err(AppError::new(
                    "voice_asset_busy",
                    "Voice asset acquisition belongs to another active renderer session",
                )
                .retryable(true));
            }
            let previous_document = runtime.document.clone();
            let record = runtime.document.assets.get_mut(asset_id).ok_or_else(|| {
                AppError::new("voice_state_invalid", "Voice asset record is missing")
            })?;
            if matches!(
                record.phase,
                VoiceAssetPhase::Deleting | VoiceAssetPhase::RecoveryRequired
            ) {
                return Err(recovery_required_error());
            }
            if record.phase == VoiceAssetPhase::Installed
                && record.installed_source_sha256.as_deref() == Some(asset.sha256.as_str())
            {
                return Ok(self.status_from_for(&runtime, Some(&owner)));
            }
            record.phase = VoiceAssetPhase::Downloading;
            record.operation_ref = Some(operation_ref.clone());
            record.expected_bytes = asset.size_bytes;
            record.last_error_code = None;
            runtime.document.revision = runtime.document.revision.saturating_add(1);
            runtime.active.insert(
                asset_id.to_owned(),
                ActiveTransfer {
                    operation_ref: operation_ref.clone(),
                    owner: owner.clone(),
                    cancel,
                },
            );
            if let Err(error) = persist_voice_document(&self.inner.state_path, &runtime.document) {
                runtime.document = previous_document;
                runtime.active.remove(asset_id);
                return Err(error);
            }
        }
        self.emit_status().await;
        let service = self.clone();
        tauri::async_runtime::spawn(async move {
            let result = service
                .execute_asset_acquisition(&asset, &operation_ref, cancel_rx)
                .await;
            service
                .finish_asset_acquisition(&asset.asset_id, &operation_ref, result)
                .await;
        });
        Ok(self.status_for(&owner).await)
    }

    pub(crate) async fn cancel_asset_acquisition(
        &self,
        operation_ref: &str,
        owner: &VoiceSessionOwner,
    ) -> AppResult<VoiceStatus> {
        let mut found = false;
        {
            let runtime = self.inner.runtime.lock().await;
            for active in runtime.active.values() {
                if active.operation_ref == operation_ref {
                    if &active.owner != owner {
                        return Err(AppError::new(
                            "voice_operation_owner_mismatch",
                            "Voice asset operation belongs to another renderer session",
                        ));
                    }
                    let _ = active.cancel.send(true);
                    found = true;
                    break;
                }
            }
        }
        if !found {
            return Ok(self.status_for(owner).await);
        }
        Ok(self.status_for(owner).await)
    }

    pub(crate) async fn delete_asset(
        &self,
        asset_id: &str,
        owner: &VoiceSessionOwner,
    ) -> AppResult<VoiceStatus> {
        self.inner.catalog.asset(asset_id)?;
        let _asset_operation = self.lock_asset_operation(asset_id).await?;
        let final_root = direct_child(
            &self.inner.installed_root,
            asset_id,
            "Installed voice asset",
        )?;
        {
            let runtime = self.inner.runtime.lock().await;
            if runtime.recovery_required.contains(asset_id) {
                return Err(recovery_required_error());
            }
            if !runtime.transcription_recovery_required.is_empty() {
                return Err(transcription_recovery_required_error());
            }
            if let Some(active) = runtime.active.get(asset_id) {
                if &active.owner != owner {
                    return Err(AppError::new(
                        "voice_operation_owner_mismatch",
                        "Voice asset operation belongs to another renderer session",
                    ));
                }
                return Err(AppError::new(
                    "voice_asset_busy",
                    "Cancel the active acquisition before deleting this voice asset",
                )
                .retryable(true));
            }
            if runtime.leases.get(asset_id).copied().unwrap_or(0) != 0 {
                return Err(AppError::new(
                    "voice_asset_in_use",
                    "Voice asset cannot be deleted while a transcription lease is active",
                )
                .retryable(true));
            }
        }
        let deletion_ref = uuid::Uuid::new_v4().hyphenated().to_string();
        {
            let mut runtime = self.inner.runtime.lock().await;
            let previous_document = runtime.document.clone();
            let record = runtime.document.assets.get_mut(asset_id).ok_or_else(|| {
                AppError::new("voice_state_invalid", "Voice asset record is missing")
            })?;
            record.phase = VoiceAssetPhase::Deleting;
            record.operation_ref = Some(deletion_ref);
            record.last_error_code = None;
            runtime.document.revision = runtime.document.revision.saturating_add(1);
            if let Err(error) = persist_voice_document(&self.inner.state_path, &runtime.document) {
                runtime.document = previous_document;
                return Err(error);
            }
        }
        let part = transfer_part_path(&self.inner.transfers_root, asset_id)?;
        if remove_flat_asset_directory(&final_root).is_err()
            || remove_regular_file_if_exists(&part, "Voice partial transfer").is_err()
        {
            let mut runtime = self.inner.runtime.lock().await;
            if let Some(record) = runtime.document.assets.get_mut(asset_id) {
                record.phase = VoiceAssetPhase::RecoveryRequired;
                record.last_error_code = Some("voice_asset_delete_failed".into());
            }
            runtime.recovery_required.insert(asset_id.to_owned());
            return Err(recovery_required_error());
        }
        {
            let mut runtime = self.inner.runtime.lock().await;
            {
                let record = runtime.document.assets.get_mut(asset_id).ok_or_else(|| {
                    AppError::new("voice_state_invalid", "Voice asset record is missing")
                })?;
                record.phase = VoiceAssetPhase::Absent;
                record.downloaded_bytes = 0;
                record.operation_ref = None;
                record.installed_source_sha256 = None;
                record.installed_at_ms = None;
                record.last_error_code = None;
            }
            runtime.document.revision = runtime.document.revision.saturating_add(1);
            if persist_voice_document(&self.inner.state_path, &runtime.document).is_err() {
                if let Some(record) = runtime.document.assets.get_mut(asset_id) {
                    record.phase = VoiceAssetPhase::RecoveryRequired;
                    record.last_error_code = Some("voice_state_commit_failed".into());
                }
                runtime.recovery_required.insert(asset_id.to_owned());
                return Err(recovery_required_error());
            }
        }
        self.emit_status().await;
        Ok(self.status_for(owner).await)
    }

    pub(crate) async fn start_transcription(
        &self,
        operation_ref: &str,
        owner: VoiceSessionOwner,
        composer_binding: VoiceComposerBinding,
        pcm: Vec<u8>,
        sample_count: u32,
    ) -> AppResult<VoiceOperationStatus> {
        validate_new_composer_binding(&composer_binding)?;
        let duration_ms = validate_pcm(&pcm, sample_count)?;
        let digest = pcm_sha256(&pcm);
        let (cancel, cancel_rx) = watch::channel(false);
        {
            let mut runtime = self.inner.runtime.lock().await;
            if !runtime.transcription_recovery_required.is_empty() {
                return Err(transcription_recovery_required_error());
            }
            if let Some(existing) = runtime.document.operations.get(operation_ref) {
                if existing.renderer_session_id != owner.renderer_session_id
                    || existing.renderer_generation != owner.renderer_generation
                    || existing.window_label != owner.window_label
                {
                    return Err(AppError::new(
                        "voice_operation_owner_mismatch",
                        "Voice transcription belongs to another renderer session",
                    ));
                }
                if existing.pcm_sha256 != digest
                    || existing.sample_count != sample_count
                    || existing.composer_binding != composer_binding
                {
                    return Err(AppError::new(
                        "voice_operation_conflict",
                        "Voice operationRef was already claimed for different PCM or Composer binding",
                    )
                    .outcome_unknown(true));
                }
                return Ok(operation_status(existing));
            }
            if runtime.document.operations.len() >= MAX_RETAINED_OPERATIONS {
                return Err(AppError::new(
                    "voice_operation_capacity_reached",
                    "Acknowledge an earlier voice result before recording again",
                )
                .retryable(true));
            }
            let voice = self.inner.catalog.voice();
            if [&voice.binary_asset_id, &voice.initial_model_asset_id]
                .iter()
                .any(|asset_id| {
                    runtime
                        .document
                        .assets
                        .get(*asset_id)
                        .is_none_or(|record| record.phase != VoiceAssetPhase::Installed)
                })
            {
                return Err(AppError::new(
                    "voice_assets_required",
                    "Install the local voice runtime and Japanese model before recording",
                )
                .retryable(true));
            }
            if runtime
                .active
                .values()
                .any(|active| active.operation_ref == operation_ref)
            {
                return Err(AppError::new(
                    "voice_operation_conflict",
                    "Voice operationRef collides with an active asset transfer",
                )
                .outcome_unknown(true));
            }
            let previous = runtime.document.clone();
            runtime.document.operations.insert(
                operation_ref.to_owned(),
                VoiceOperationRecord {
                    operation_ref: operation_ref.to_owned(),
                    renderer_session_id: owner.renderer_session_id.clone(),
                    renderer_generation: owner.renderer_generation,
                    window_label: owner.window_label.clone(),
                    composer_binding,
                    phase: VoiceOperationPhase::Staging,
                    pcm_sha256: digest,
                    sample_count,
                    duration_ms,
                    transcript: None,
                    last_error_code: None,
                    recovery_target_phase: None,
                    containment_kind: None,
                    containment_id: None,
                    expected_pid: None,
                    created_at_ms: now_ms(),
                },
            );
            runtime.document.revision = runtime.document.revision.saturating_add(1);
            runtime.active_transcriptions.insert(
                operation_ref.to_owned(),
                ActiveTranscription { owner, cancel },
            );
            if let Err(error) = persist_voice_document(&self.inner.state_path, &runtime.document) {
                runtime.document = previous;
                runtime.active_transcriptions.remove(operation_ref);
                return Err(error);
            }
        }
        self.emit_status().await;
        let service = self.clone();
        let operation_ref = operation_ref.to_owned();
        let spawned_operation_ref = operation_ref.clone();
        tauri::async_runtime::spawn(async move {
            let result = service
                .execute_transcription(&spawned_operation_ref, pcm, sample_count, cancel_rx)
                .await;
            service
                .finish_transcription(&spawned_operation_ref, result)
                .await;
        });
        let runtime = self.inner.runtime.lock().await;
        Ok(operation_status(
            runtime
                .document
                .operations
                .get(operation_ref.as_str())
                .expect("durable transcription claim"),
        ))
    }

    pub(crate) async fn cancel_transcription(
        &self,
        operation_ref: &str,
        owner: &VoiceSessionOwner,
    ) -> AppResult<VoiceStatus> {
        let runtime = self.inner.runtime.lock().await;
        let record = runtime
            .document
            .operations
            .get(operation_ref)
            .ok_or_else(|| {
                AppError::new(
                    "voice_operation_unknown",
                    "Voice transcription does not exist",
                )
            })?;
        if record.renderer_session_id != owner.renderer_session_id
            || record.renderer_generation != owner.renderer_generation
            || record.window_label != owner.window_label
        {
            return Err(AppError::new(
                "voice_operation_owner_mismatch",
                "Voice transcription belongs to another renderer session",
            ));
        }
        if let Some(active) = runtime.active_transcriptions.get(operation_ref) {
            let _ = active.cancel.send(true);
        }
        Ok(self.status_from_for(&runtime, Some(owner)))
    }

    pub(crate) async fn acknowledge_transcription(
        &self,
        operation_ref: &str,
        owner: &VoiceSessionOwner,
    ) -> AppResult<VoiceStatus> {
        let mut runtime = self.inner.runtime.lock().await;
        let record = runtime
            .document
            .operations
            .get(operation_ref)
            .ok_or_else(|| {
                AppError::new(
                    "voice_operation_unknown",
                    "Voice transcription does not exist",
                )
            })?;
        if record.renderer_session_id != owner.renderer_session_id
            || record.renderer_generation != owner.renderer_generation
            || record.window_label != owner.window_label
        {
            return Err(AppError::new(
                "voice_operation_owner_mismatch",
                "Voice transcription belongs to another renderer session",
            ));
        }
        if !record.phase.is_terminal()
            || record.phase == VoiceOperationPhase::RecoveryRequired
            || runtime.active_transcriptions.contains_key(operation_ref)
        {
            return Err(AppError::new(
                "voice_operation_not_acknowledgeable",
                "Voice transcription has not reached a safely cleaned terminal state",
            )
            .retryable(true));
        }
        let previous = runtime.document.clone();
        runtime.document.operations.remove(operation_ref);
        runtime.document.revision = runtime.document.revision.saturating_add(1);
        if let Err(error) = persist_voice_document(&self.inner.state_path, &runtime.document) {
            runtime.document = previous;
            return Err(error);
        }
        let status = self.status_from_for(&runtime, Some(owner));
        drop(runtime);
        self.emit_status().await;
        Ok(status)
    }

    pub(crate) async fn retire_renderer_session(
        &self,
        owner: &VoiceSessionOwner,
        successor: Option<&VoiceSessionOwner>,
    ) -> AppResult<()> {
        {
            let runtime = self.inner.runtime.lock().await;
            for active in runtime.active.values() {
                if &active.owner == owner {
                    let _ = active.cancel.send(true);
                }
            }
            for active in runtime.active_transcriptions.values() {
                if &active.owner == owner {
                    let _ = active.cancel.send(true);
                }
            }
        }
        let deadline = tokio::time::Instant::now() + SHUTDOWN_TIMEOUT;
        loop {
            let notified = self.inner.changed.notified();
            let active = {
                let runtime = self.inner.runtime.lock().await;
                runtime.active.values().any(|active| &active.owner == owner)
                    || runtime
                        .active_transcriptions
                        .values()
                        .any(|active| &active.owner == owner)
            };
            if !active {
                let runtime = self.inner.runtime.lock().await;
                if has_owner_transcription_recovery(&runtime, owner) {
                    return Err(transcription_recovery_required_error());
                }
                drop(runtime);
                break;
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return Err(AppError::new(
                    "voice_session_retire_timeout",
                    "Voice asset operation did not stop before its renderer session retired",
                )
                .outcome_unknown(true));
            }
        }
        self.finalize_renderer_retirement(owner, successor).await
    }

    async fn finalize_renderer_retirement(
        &self,
        owner: &VoiceSessionOwner,
        successor: Option<&VoiceSessionOwner>,
    ) -> AppResult<()> {
        let mut runtime = self.inner.runtime.lock().await;
        let previous = runtime.document.clone();
        let owned = runtime
            .document
            .operations
            .iter()
            .filter(|(_, record)| {
                record.renderer_session_id == owner.renderer_session_id
                    && record.renderer_generation == owner.renderer_generation
                    && record.window_label == owner.window_label
            })
            .map(|(operation_ref, _)| operation_ref.clone())
            .collect::<Vec<_>>();
        let mut changed = false;
        for operation_ref in owned {
            let phase = runtime
                .document
                .operations
                .get(&operation_ref)
                .map(|record| record.phase.clone())
                .ok_or_else(|| {
                    AppError::new(
                        "voice_operation_stale",
                        "Voice operation changed during renderer retirement",
                    )
                })?;
            match phase {
                VoiceOperationPhase::Transcribed => {
                    if let Some(successor) = successor {
                        let record = runtime
                            .document
                            .operations
                            .get_mut(&operation_ref)
                            .expect("owned transcription remains present");
                        record.renderer_session_id = successor.renderer_session_id.clone();
                        record.renderer_generation = successor.renderer_generation;
                        record.window_label = successor.window_label.clone();
                        changed = true;
                    }
                    // A completed transcript is a durable pending user action.
                    // Normal window/app disposal must not turn retirement into
                    // acknowledgement or deletion. The next exact predecessor
                    // session adopts it, or the user explicitly acknowledges it.
                }
                VoiceOperationPhase::Cancelled | VoiceOperationPhase::Failed => {
                    runtime.document.operations.remove(&operation_ref);
                    changed = true;
                }
                VoiceOperationPhase::RecoveryRequired => {
                    return Err(transcription_recovery_required_error());
                }
                VoiceOperationPhase::Staging | VoiceOperationPhase::Transcribing => {
                    return Err(AppError::new(
                        "voice_session_retire_incomplete",
                        "Voice transcription remained nonterminal after renderer retirement wait",
                    )
                    .outcome_unknown(true));
                }
            }
        }
        if changed {
            runtime.document.revision = runtime.document.revision.saturating_add(1);
            if let Err(error) = persist_voice_document(&self.inner.state_path, &runtime.document) {
                runtime.document = previous;
                return Err(error);
            }
        }
        Ok(())
    }

    pub(crate) async fn shutdown(&self) -> AppResult<()> {
        {
            let runtime = self.inner.runtime.lock().await;
            for active in runtime.active.values() {
                let _ = active.cancel.send(true);
            }
            for active in runtime.active_transcriptions.values() {
                let _ = active.cancel.send(true);
            }
            if runtime.active.is_empty() && runtime.active_transcriptions.is_empty() {
                if !runtime.transcription_recovery_required.is_empty() {
                    return Err(transcription_recovery_required_error());
                }
                return Ok(());
            }
        }
        let deadline = tokio::time::Instant::now() + SHUTDOWN_TIMEOUT;
        loop {
            let notified = self.inner.changed.notified();
            let active = {
                let runtime = self.inner.runtime.lock().await;
                !runtime.active.is_empty() || !runtime.active_transcriptions.is_empty()
            };
            if !active {
                let runtime = self.inner.runtime.lock().await;
                if !runtime.transcription_recovery_required.is_empty() {
                    return Err(transcription_recovery_required_error());
                }
                return Ok(());
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return Err(AppError::new(
                    "voice_shutdown_timeout",
                    "Voice asset transfer did not reach a terminal state before shutdown",
                )
                .outcome_unknown(true));
            }
        }
    }

    #[cfg(test)]
    fn status_from(&self, runtime: &VoiceRuntime) -> VoiceStatus {
        self.status_from_for(runtime, None)
    }

    fn status_from_for(
        &self,
        runtime: &VoiceRuntime,
        owner: Option<&VoiceSessionOwner>,
    ) -> VoiceStatus {
        let voice = self.inner.catalog.voice();
        let required_assets_ready = [&voice.binary_asset_id, &voice.initial_model_asset_id]
            .iter()
            .all(|asset_id| {
                runtime
                    .document
                    .assets
                    .get(*asset_id)
                    .is_some_and(|record| record.phase == VoiceAssetPhase::Installed)
            });
        VoiceStatus {
            schema_version: VOICE_STATUS_SCHEMA_VERSION,
            revision: runtime.document.revision,
            provider_id: voice.provider_id.clone(),
            binary_asset_id: voice.binary_asset_id.clone(),
            initial_model_asset_id: voice.initial_model_asset_id.clone(),
            comparison_model_asset_id: voice.comparison_model_asset_id.clone(),
            required_assets_ready,
            assets: runtime
                .document
                .assets
                .values()
                .map(|record| VoiceAssetStatus {
                    asset_id: record.asset_id.clone(),
                    kind: record.kind.clone(),
                    phase: record.phase.clone(),
                    downloaded_bytes: record.downloaded_bytes,
                    expected_bytes: record.expected_bytes,
                    operation_ref: record.operation_ref.clone(),
                    last_error_code: record.last_error_code.clone(),
                })
                .collect(),
            operations: runtime
                .document
                .operations
                .values()
                .filter(|record| {
                    owner.is_none_or(|owner| {
                        record.renderer_session_id == owner.renderer_session_id
                            && record.renderer_generation == owner.renderer_generation
                            && record.window_label == owner.window_label
                    })
                })
                .map(operation_status)
                .collect(),
        }
    }

    async fn lock_asset_operation(&self, asset_id: &str) -> AppResult<OwnedMutexGuard<()>> {
        let lock = self
            .inner
            .asset_locks
            .get(asset_id)
            .cloned()
            .ok_or_else(|| {
                AppError::new(
                    "voice_asset_unknown",
                    "Voice asset ID is not present in the immutable catalog",
                )
            })?;
        Ok(lock.lock_owned().await)
    }

    async fn emit_status(&self) {
        let emissions = {
            let runtime = self.inner.runtime.lock().await;
            let mut owners = Vec::<VoiceSessionOwner>::new();
            for owner in runtime.active.values().map(|active| &active.owner).chain(
                runtime
                    .active_transcriptions
                    .values()
                    .map(|active| &active.owner),
            ) {
                if !owners.contains(owner) {
                    owners.push(owner.clone());
                }
            }
            for record in runtime.document.operations.values() {
                let owner = VoiceSessionOwner::new(
                    record.renderer_session_id.clone(),
                    record.renderer_generation,
                    record.window_label.clone(),
                );
                if !owners.contains(&owner) {
                    owners.push(owner);
                }
            }
            owners
                .into_iter()
                .map(|owner| {
                    let status = self.status_from_for(&runtime, Some(&owner));
                    (owner, status)
                })
                .collect::<Vec<_>>()
        };
        for (owner, status) in emissions {
            (self.inner.emit_status)(owner, status);
        }
    }

    async fn emit_status_to(&self, owner: &VoiceSessionOwner) {
        let status = self.status_for(owner).await;
        (self.inner.emit_status)(owner.clone(), status);
    }

    async fn execute_transcription(
        &self,
        operation_ref: &str,
        pcm: Vec<u8>,
        sample_count: u32,
        mut cancelled: watch::Receiver<bool>,
    ) -> TranscriptionExecution {
        let prepared = async {
            ensure_not_cancelled(&cancelled)?;
            let operations_root = self.inner.operations_root.clone();
            let operation = operation_ref.to_owned();
            let paths = tokio::task::spawn_blocking(move || {
                stage_pcm_wav(&operations_root, &operation, &pcm, sample_count)
            })
            .await
            .map_err(|error| AppError::new("voice_stage_failed", error.to_string()))??;
            ensure_not_cancelled(&cancelled)?;

            let voice = self.inner.catalog.voice();
            let binary_id = voice.binary_asset_id.clone();
            let model_id = voice.initial_model_asset_id.clone();
            let mut lock_ids = [binary_id.clone(), model_id.clone()];
            lock_ids.sort();
            let _first_asset_guard = self.lock_asset_operation(&lock_ids[0]).await?;
            let _second_asset_guard = self.lock_asset_operation(&lock_ids[1]).await?;
            ensure_not_cancelled(&cancelled)?;
            {
                let mut runtime = self.inner.runtime.lock().await;
                let required = [&binary_id, &model_id];
                if required.iter().any(|asset_id| {
                    runtime
                        .document
                        .assets
                        .get(*asset_id)
                        .is_none_or(|record| record.phase != VoiceAssetPhase::Installed)
                }) {
                    return Err(AppError::new(
                        "voice_assets_required",
                        "The local voice runtime changed before transcription began",
                    )
                    .retryable(true));
                }
                for asset_id in required {
                    *runtime.leases.entry(asset_id.clone()).or_default() += 1;
                }
            }
            let execution = self
                .run_transcription_process(
                    operation_ref,
                    &paths,
                    &binary_id,
                    &model_id,
                    &mut cancelled,
                )
                .await;
            self.release_transcription_assets(&binary_id, &model_id)
                .await;
            execution
        }
        .await;
        prepared.unwrap_or_else(|error| TranscriptionExecution::Terminal {
            result: Err(error),
            identity: None,
        })
    }

    async fn run_transcription_process(
        &self,
        operation_ref: &str,
        paths: &OperationPaths,
        binary_id: &str,
        model_id: &str,
        cancelled: &mut watch::Receiver<bool>,
    ) -> AppResult<TranscriptionExecution> {
        ensure_not_cancelled(cancelled)?;
        let binary_asset = self.inner.catalog.asset(binary_id)?.clone();
        let model_asset = self.inner.catalog.asset(model_id)?.clone();
        let installed_root = self.inner.installed_root.clone();
        let binary_root = direct_child(&installed_root, binary_id, "Installed voice binary")?;
        let model_root = direct_child(&installed_root, model_id, "Installed voice model")?;
        let executable = direct_child(&binary_root, "whisper-cli.exe", "Whisper executable")?;
        let model = direct_child(&model_root, &model_asset.file_name, "Whisper model")?;
        let binary_verify_root = binary_root.clone();
        let model_verify_root = model_root.clone();
        tokio::task::spawn_blocking(move || {
            verify_install_receipt(&binary_asset, &binary_verify_root)?;
            verify_install_receipt(&model_asset, &model_verify_root)?;
            Ok::<(), AppError>(())
        })
        .await
        .map_err(|error| AppError::new("voice_install_verify_failed", error.to_string()))??;
        ensure_not_cancelled(cancelled)?;

        let spec = whisper_process_spec(&executable, &model, &binary_root, &paths.wav);
        let mut spawned = spawn_contained(spec, TRANSCRIPTION_NAMESPACE, operation_ref).await?;
        let pid = spawned.child.id().ok_or_else(|| {
            AppError::new(
                "voice_process_identity_missing",
                "Contained voice process has no process identity",
            )
            .outcome_unknown(true)
        })?;
        let containment_kind = spawned.containment.kind().to_owned();
        let containment_id = spawned.containment.id();
        let identity = TranscriptionProcessIdentity {
            containment_kind,
            containment_id,
            expected_pid: pid,
        };
        let stdout = spawned.child.stdout.take();
        let stderr = spawned.child.stderr.take();
        let child = Arc::new(Mutex::new(spawned.child));
        let stdout_task =
            stdout.map(|reader| tauri::async_runtime::spawn(transcription::drain_bounded(reader)));
        let stderr_task =
            stderr.map(|reader| tauri::async_runtime::spawn(transcription::drain_bounded(reader)));
        let mark_result = self
            .mark_transcribing(
                operation_ref,
                &identity.containment_kind,
                &identity.containment_id,
                identity.expected_pid,
            )
            .await;
        let wait_outcome = match mark_result {
            Err(error) => ProcessWaitOutcome::PollFailed(error),
            Ok(()) => {
                let deadline = tokio::time::Instant::now() + TRANSCRIPTION_TIMEOUT;
                loop {
                    if *cancelled.borrow() {
                        break ProcessWaitOutcome::Cancelled;
                    }
                    if tokio::time::Instant::now() >= deadline {
                        break ProcessWaitOutcome::TimedOut;
                    }
                    match child.lock().await.try_wait() {
                        Ok(Some(status)) => break ProcessWaitOutcome::Exited(status),
                        Ok(None) => {}
                        Err(error) => {
                            break ProcessWaitOutcome::PollFailed(AppError::io(
                                "poll contained voice process",
                                error,
                            ));
                        }
                    }
                    tokio::select! {
                        _ = tokio::time::sleep(Duration::from_millis(25)) => {}
                        changed = cancelled.changed() => {
                            if changed.is_ok() && *cancelled.borrow() {
                                break ProcessWaitOutcome::Cancelled;
                            }
                        }
                    }
                }
            }
        };
        if let Err(error) = spawned.containment.terminate_and_confirm(&child).await {
            let target_phase = if matches!(wait_outcome, ProcessWaitOutcome::Cancelled) {
                VoiceOperationPhase::Cancelled
            } else {
                VoiceOperationPhase::Failed
            };
            return Ok(TranscriptionExecution::RecoveryRequired {
                error: AppError::new(
                    "voice_process_recovery_required",
                    "Contained voice process did not reach a confirmed terminal state",
                )
                .outcome_unknown(true)
                .with_details(serde_json::json!({ "causeCode": error.code })),
                identity,
                target_phase,
            });
        }
        let child_wait_error = child
            .lock()
            .await
            .wait()
            .await
            .err()
            .map(|error| AppError::io("reap contained voice process", error));
        let mut output_error = None;
        for task in [stdout_task, stderr_task].into_iter().flatten() {
            match tokio::time::timeout(Duration::from_secs(5), task).await {
                Ok(Ok(Ok(()))) => {}
                _ => {
                    output_error = Some(AppError::new(
                        "voice_process_output_failed",
                        "Contained voice process output did not close cleanly",
                    ));
                }
            }
        }
        let result = if let Some(error) = child_wait_error.or(output_error) {
            Err(error)
        } else {
            match wait_outcome {
                ProcessWaitOutcome::Cancelled => Err(cancelled_error()),
                ProcessWaitOutcome::TimedOut => Err(AppError::new(
                    "voice_transcription_timeout",
                    "Local voice transcription exceeded its bounded deadline",
                )),
                ProcessWaitOutcome::PollFailed(error) => Err(error),
                ProcessWaitOutcome::Exited(status) if !status.success() => Err(AppError::new(
                    "voice_transcription_failed",
                    "Local voice transcription exited unsuccessfully",
                )),
                ProcessWaitOutcome::Exited(_) => {
                    let json = paths.json.clone();
                    tokio::task::spawn_blocking(move || read_transcript(&json))
                        .await
                        .map_err(|error| {
                            AppError::new("voice_transcript_read_failed", error.to_string())
                        })?
                }
            }
        };
        Ok(TranscriptionExecution::Terminal {
            result,
            identity: Some(identity),
        })
    }

    async fn mark_transcribing(
        &self,
        operation_ref: &str,
        containment_kind: &str,
        containment_id: &str,
        expected_pid: u32,
    ) -> AppResult<()> {
        let mut runtime = self.inner.runtime.lock().await;
        let previous = runtime.document.clone();
        if !runtime.active_transcriptions.contains_key(operation_ref) {
            return Err(AppError::new(
                "voice_operation_stale",
                "Voice operation is no longer in its staging phase",
            ));
        }
        let record = runtime
            .document
            .operations
            .get_mut(operation_ref)
            .ok_or_else(|| {
                AppError::new(
                    "voice_operation_stale",
                    "Voice operation is no longer current",
                )
            })?;
        if record.phase != VoiceOperationPhase::Staging {
            return Err(AppError::new(
                "voice_operation_stale",
                "Voice operation is no longer in its staging phase",
            ));
        }
        record.phase = VoiceOperationPhase::Transcribing;
        record.containment_kind = Some(containment_kind.to_owned());
        record.containment_id = Some(containment_id.to_owned());
        record.expected_pid = Some(expected_pid);
        runtime.document.revision = runtime.document.revision.saturating_add(1);
        if let Err(error) = persist_voice_document(&self.inner.state_path, &runtime.document) {
            runtime.document = previous;
            return Err(error);
        }
        drop(runtime);
        self.emit_status().await;
        Ok(())
    }

    async fn release_transcription_assets(&self, binary_id: &str, model_id: &str) {
        let mut runtime = self.inner.runtime.lock().await;
        for asset_id in [binary_id, model_id] {
            if let Some(count) = runtime.leases.get_mut(asset_id) {
                *count = count.saturating_sub(1);
                if *count == 0 {
                    runtime.leases.remove(asset_id);
                }
            }
        }
    }

    async fn finish_transcription(&self, operation_ref: &str, execution: TranscriptionExecution) {
        let (target_phase, transcript, terminal_error, identity, process_confirmed) =
            match execution {
                TranscriptionExecution::Terminal { result, identity } => match result {
                    Ok(transcript) => (
                        VoiceOperationPhase::Transcribed,
                        Some(transcript),
                        None,
                        identity,
                        true,
                    ),
                    Err(error) if error.code == "voice_operation_cancelled" => {
                        (VoiceOperationPhase::Cancelled, None, None, identity, true)
                    }
                    Err(error) => (
                        VoiceOperationPhase::Failed,
                        None,
                        Some(error.code),
                        identity,
                        true,
                    ),
                },
                TranscriptionExecution::RecoveryRequired {
                    error,
                    identity,
                    target_phase,
                } => (target_phase, None, Some(error.code), Some(identity), false),
            };

        let recovery_error = terminal_error
            .clone()
            .unwrap_or_else(|| "voice_cleanup_pending".into());
        let recovery_persisted = self
            .persist_transcription_recovery(
                operation_ref,
                target_phase.clone(),
                transcript.clone(),
                recovery_error,
                identity.as_ref(),
            )
            .await
            .is_ok();
        let mut safely_settled = false;
        if recovery_persisted && process_confirmed {
            let cleanup_result = match operation_paths(&self.inner.operations_root, operation_ref) {
                Ok(paths) => {
                    match tokio::task::spawn_blocking(move || remove_operation_directory(&paths))
                        .await
                    {
                        Ok(result) => result,
                        Err(error) => Err(AppError::new(
                            "voice_operation_cleanup_join_failed",
                            error.to_string(),
                        )
                        .outcome_unknown(true)),
                    }
                }
                Err(error) => Err(error),
            };
            match cleanup_result {
                Ok(()) => {
                    safely_settled = self
                        .persist_transcription_terminal(
                            operation_ref,
                            target_phase,
                            transcript,
                            terminal_error,
                        )
                        .await
                        .is_ok();
                }
                Err(error) => {
                    let _ = self
                        .persist_transcription_recovery(
                            operation_ref,
                            target_phase,
                            transcript,
                            error.code,
                            identity.as_ref(),
                        )
                        .await;
                }
            }
        }
        let mut runtime = self.inner.runtime.lock().await;
        runtime.active_transcriptions.remove(operation_ref);
        if safely_settled {
            runtime
                .transcription_recovery_required
                .remove(operation_ref);
        } else {
            runtime
                .transcription_recovery_required
                .insert(operation_ref.to_owned());
        }
        drop(runtime);
        self.inner.changed.notify_waiters();
        self.emit_status().await;
    }

    async fn persist_transcription_recovery(
        &self,
        operation_ref: &str,
        target_phase: VoiceOperationPhase,
        transcript: Option<String>,
        error_code: String,
        identity: Option<&TranscriptionProcessIdentity>,
    ) -> AppResult<()> {
        let mut runtime = self.inner.runtime.lock().await;
        let previous = runtime.document.clone();
        let record = runtime
            .document
            .operations
            .get_mut(operation_ref)
            .ok_or_else(|| {
                AppError::new(
                    "voice_operation_stale",
                    "Voice operation is no longer current",
                )
            })?;
        record.phase = VoiceOperationPhase::RecoveryRequired;
        record.recovery_target_phase = Some(target_phase);
        record.transcript = transcript;
        record.last_error_code = Some(error_code);
        if let Some(identity) = identity {
            record.containment_kind = Some(identity.containment_kind.clone());
            record.containment_id = Some(identity.containment_id.clone());
            record.expected_pid = Some(identity.expected_pid);
        }
        runtime.document.revision = runtime.document.revision.saturating_add(1);
        if let Err(error) = persist_voice_document(&self.inner.state_path, &runtime.document) {
            runtime.document = previous;
            return Err(error);
        }
        Ok(())
    }

    async fn persist_transcription_terminal(
        &self,
        operation_ref: &str,
        target_phase: VoiceOperationPhase,
        transcript: Option<String>,
        error_code: Option<String>,
    ) -> AppResult<()> {
        let mut runtime = self.inner.runtime.lock().await;
        let previous = runtime.document.clone();
        let record = runtime
            .document
            .operations
            .get_mut(operation_ref)
            .ok_or_else(|| {
                AppError::new(
                    "voice_operation_stale",
                    "Voice operation is no longer current",
                )
            })?;
        if record.phase != VoiceOperationPhase::RecoveryRequired
            || record.recovery_target_phase.as_ref() != Some(&target_phase)
        {
            return Err(AppError::new(
                "voice_operation_stale",
                "Voice operation recovery target changed before cleanup completed",
            ));
        }
        record.phase = target_phase;
        record.recovery_target_phase = None;
        record.transcript = transcript;
        record.last_error_code = error_code;
        record.containment_kind = None;
        record.containment_id = None;
        record.expected_pid = None;
        runtime.document.revision = runtime.document.revision.saturating_add(1);
        if let Err(error) = persist_voice_document(&self.inner.state_path, &runtime.document) {
            runtime.document = previous;
            return Err(error);
        }
        Ok(())
    }

    async fn execute_asset_acquisition(
        &self,
        asset: &DesktopAsset,
        operation_ref: &str,
        cancelled: watch::Receiver<bool>,
    ) -> AppResult<InstallReceipt> {
        #[cfg(test)]
        if let Some(runner) = &self.inner.acquisition_runner {
            return runner(asset.clone(), operation_ref.to_owned(), cancelled).await;
        }
        self.run_asset_acquisition(asset, operation_ref, cancelled)
            .await
    }

    async fn run_asset_acquisition(
        &self,
        asset: &DesktopAsset,
        operation_ref: &str,
        mut cancelled: watch::Receiver<bool>,
    ) -> AppResult<InstallReceipt> {
        let part_path = transfer_part_path(&self.inner.transfers_root, &asset.asset_id)?;
        self.download_asset(asset, &part_path, &mut cancelled)
            .await?;
        self.set_phase(
            &asset.asset_id,
            operation_ref,
            VoiceAssetPhase::Verifying,
            None,
        )
        .await?;
        ensure_not_cancelled(&cancelled)?;
        let part_for_hash = part_path.clone();
        let expected_size = asset.size_bytes;
        let expected_hash = asset.sha256.clone();
        let verification = tokio::task::spawn_blocking(move || {
            verify_download_and_reject_mismatch(&part_for_hash, expected_size, &expected_hash)
        })
        .await
        .map_err(|error| AppError::new("voice_asset_verify_failed", error.to_string()))?;
        verification?;
        self.set_phase(
            &asset.asset_id,
            operation_ref,
            VoiceAssetPhase::Installing,
            None,
        )
        .await?;
        ensure_not_cancelled(&cancelled)?;
        let licenses = self.download_licenses(asset, &mut cancelled).await?;
        ensure_not_cancelled(&cancelled)?;
        let service = self.clone();
        let asset = asset.clone();
        let operation_ref = operation_ref.to_owned();
        let install_cancelled = cancelled.clone();
        tokio::task::spawn_blocking(move || {
            service.install_asset(
                &asset,
                &operation_ref,
                &part_path,
                &licenses,
                &install_cancelled,
            )
        })
        .await
        .map_err(|error| AppError::new("voice_asset_install_failed", error.to_string()))?
    }

    async fn download_licenses(
        &self,
        asset: &DesktopAsset,
        cancelled: &mut watch::Receiver<bool>,
    ) -> AppResult<Vec<VerifiedLicense>> {
        let mut verified = Vec::new();
        for (index, license) in asset.licenses().into_iter().enumerate() {
            ensure_not_cancelled(cancelled)?;
            let response = tokio::select! {
                _ = cancelled.changed() => return Err(cancelled_error()),
                value = self.inner.client.get(&license.source_url).send() => {
                    value.map_err(|_| AppError::new(
                        "voice_license_download_failed",
                        "Voice asset license download failed",
                    ).retryable(true))?
                },
            };
            if !response.status().is_success() || !allowed_download_url(response.url()) {
                return Err(AppError::new(
                    "voice_license_download_failed",
                    "Voice asset license source returned an invalid response",
                ));
            }
            if response
                .headers()
                .get(CONTENT_LENGTH)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<u64>().ok())
                .is_some_and(|length| length != license.size_bytes)
            {
                return Err(AppError::new(
                    "voice_license_size_mismatch",
                    "Voice asset license size does not match the immutable catalog",
                ));
            }
            let mut response = response;
            let mut bytes = Vec::with_capacity(license.size_bytes as usize);
            loop {
                let chunk = tokio::select! {
                    _ = cancelled.changed() => return Err(cancelled_error()),
                    value = response.chunk() => value.map_err(|_| AppError::new(
                        "voice_license_download_failed",
                        "Voice asset license download failed",
                    ).retryable(true))?,
                };
                let Some(chunk) = chunk else { break };
                if bytes.len().saturating_add(chunk.len()) > license.size_bytes as usize {
                    return Err(AppError::new(
                        "voice_license_size_mismatch",
                        "Voice asset license exceeded the immutable catalog size",
                    ));
                }
                bytes.extend_from_slice(&chunk);
            }
            if bytes.len() as u64 != license.size_bytes
                || format!("{:x}", Sha256::digest(&bytes)) != license.sha256
            {
                return Err(AppError::new(
                    "voice_license_hash_mismatch",
                    "Voice asset license does not match the immutable catalog",
                ));
            }
            verified.push(VerifiedLicense {
                file_name: format!("LICENSE-{:02}.txt", index + 1),
                bytes,
            });
        }
        Ok(verified)
    }

    async fn download_asset(
        &self,
        asset: &DesktopAsset,
        part_path: &Path,
        cancelled: &mut watch::Receiver<bool>,
    ) -> AppResult<()> {
        ensure_not_cancelled(cancelled)?;
        let existing = prepare_partial_transfer(part_path, asset.size_bytes)?;
        if existing == asset.size_bytes {
            self.update_download_progress(&asset.asset_id, existing)
                .await?;
            return Ok(());
        }
        let mut request = self.inner.client.get(&asset.source_url);
        if existing > 0 {
            request = request.header(RANGE, format!("bytes={existing}-"));
        }
        let response = tokio::select! {
            _ = cancelled.changed() => return Err(cancelled_error()),
            value = request.send() => value.map_err(|error| AppError::new("voice_asset_download_failed", error.to_string()).retryable(true))?,
        };
        if !allowed_download_url(response.url()) {
            return Err(AppError::new(
                "voice_asset_origin_rejected",
                "Voice asset response origin is not allowed",
            ));
        }
        let transfer = validate_transfer_response(
            existing,
            response.status(),
            response
                .headers()
                .get(CONTENT_RANGE)
                .and_then(|value| value.to_str().ok()),
        )?;
        let existing = transfer.offset;
        let remaining = asset.size_bytes.saturating_sub(existing);
        if response
            .headers()
            .get(CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok())
            .is_some_and(|length| length > remaining)
        {
            return Err(AppError::new(
                "voice_asset_size_mismatch",
                "Voice asset response exceeds the immutable catalog size",
            ));
        }
        let std_file = open_private_transfer_file(part_path, transfer.append)?;
        let mut file = tokio::fs::File::from_std(std_file);
        let mut response = response;
        let mut written = existing;
        let mut checkpoint = existing;
        self.update_download_progress(&asset.asset_id, written)
            .await?;
        loop {
            let chunk = tokio::select! {
                _ = cancelled.changed() => {
                    file.flush().await.map_err(|error| AppError::io("flush cancelled voice transfer", error))?;
                    return Err(cancelled_error());
                }
                value = response.chunk() => value.map_err(|error| AppError::new("voice_asset_download_failed", error.to_string()).retryable(true))?,
            };
            let Some(chunk) = chunk else { break };
            written = written.saturating_add(chunk.len() as u64);
            if written > asset.size_bytes {
                return Err(AppError::new(
                    "voice_asset_size_mismatch",
                    "Voice asset transfer exceeded the immutable catalog size",
                ));
            }
            file.write_all(&chunk)
                .await
                .map_err(|error| AppError::io("write voice partial transfer", error))?;
            if written.saturating_sub(checkpoint) >= DOWNLOAD_CHECKPOINT_BYTES {
                file.flush()
                    .await
                    .map_err(|error| AppError::io("flush voice partial transfer", error))?;
                self.update_download_progress(&asset.asset_id, written)
                    .await?;
                checkpoint = written;
            }
        }
        file.flush()
            .await
            .map_err(|error| AppError::io("flush voice partial transfer", error))?;
        file.sync_all()
            .await
            .map_err(|error| AppError::io("sync voice partial transfer", error))?;
        if written != asset.size_bytes {
            self.update_download_progress(&asset.asset_id, written)
                .await?;
            return Err(AppError::new(
                "voice_asset_size_mismatch",
                "Voice asset transfer ended before the immutable catalog size",
            )
            .retryable(true));
        }
        self.update_download_progress(&asset.asset_id, written)
            .await
    }

    async fn update_download_progress(&self, asset_id: &str, bytes: u64) -> AppResult<()> {
        let mut runtime = self.inner.runtime.lock().await;
        let record =
            runtime.document.assets.get_mut(asset_id).ok_or_else(|| {
                AppError::new("voice_state_invalid", "Voice asset record is missing")
            })?;
        record.downloaded_bytes = bytes;
        runtime.document.revision = runtime.document.revision.saturating_add(1);
        persist_voice_document(&self.inner.state_path, &runtime.document)?;
        drop(runtime);
        self.emit_status().await;
        Ok(())
    }

    async fn set_phase(
        &self,
        asset_id: &str,
        operation_ref: &str,
        phase: VoiceAssetPhase,
        error_code: Option<String>,
    ) -> AppResult<()> {
        let mut runtime = self.inner.runtime.lock().await;
        let record =
            runtime.document.assets.get_mut(asset_id).ok_or_else(|| {
                AppError::new("voice_state_invalid", "Voice asset record is missing")
            })?;
        if record.operation_ref.as_deref() != Some(operation_ref) {
            return Err(AppError::new(
                "voice_operation_stale",
                "Voice asset operation is no longer current",
            ));
        }
        record.phase = phase;
        record.last_error_code = error_code;
        runtime.document.revision = runtime.document.revision.saturating_add(1);
        persist_voice_document(&self.inner.state_path, &runtime.document)?;
        drop(runtime);
        self.emit_status().await;
        Ok(())
    }

    async fn finish_asset_acquisition(
        &self,
        asset_id: &str,
        operation_ref: &str,
        result: AppResult<InstallReceipt>,
    ) {
        let cancelled_partial = match &result {
            Err(error) if error.code == "voice_operation_cancelled" => Some(
                transfer_part_path(&self.inner.transfers_root, asset_id).and_then(|part| {
                    regular_file_len_or_zero(&part, "Cancelled voice partial transfer")
                }),
            ),
            _ => None,
        };
        let mut runtime = self.inner.runtime.lock().await;
        let is_current = runtime
            .active
            .get(asset_id)
            .is_some_and(|active| active.operation_ref == operation_ref);
        if !is_current {
            return;
        }
        let previous_document = runtime.document.clone();
        let mut cancel_recovery_required = false;
        if let Some(record) = runtime.document.assets.get_mut(asset_id) {
            match result {
                Ok(receipt) => {
                    let asset = self.inner.catalog.asset(asset_id).expect("catalog asset");
                    record.phase = VoiceAssetPhase::Installed;
                    record.downloaded_bytes = asset.size_bytes;
                    record.installed_source_sha256 = Some(receipt.source_sha256);
                    record.installed_at_ms = Some(receipt.installed_at_ms);
                    record.last_error_code = None;
                }
                Err(error) if error.code == "voice_operation_cancelled" => {
                    match cancelled_partial.as_ref().expect("cancel state") {
                        Ok(0) => {
                            record.phase = VoiceAssetPhase::Absent;
                            record.downloaded_bytes = 0;
                            record.last_error_code = None;
                        }
                        Ok(bytes) => {
                            record.phase = VoiceAssetPhase::Paused;
                            record.downloaded_bytes = *bytes;
                            record.last_error_code = None;
                        }
                        Err(error) => {
                            record.phase = VoiceAssetPhase::RecoveryRequired;
                            record.last_error_code = Some(error.code.clone());
                            cancel_recovery_required = true;
                        }
                    }
                }
                Err(error) => {
                    record.phase = VoiceAssetPhase::Failed;
                    record.last_error_code = Some(error.code);
                }
            }
            record.operation_ref = None;
            if cancel_recovery_required {
                runtime.recovery_required.insert(asset_id.to_owned());
            }
            runtime.document.revision = runtime.document.revision.saturating_add(1);
            if persist_voice_document(&self.inner.state_path, &runtime.document).is_err() {
                runtime.document = previous_document;
                if let Some(record) = runtime.document.assets.get_mut(asset_id) {
                    record.phase = VoiceAssetPhase::RecoveryRequired;
                    record.operation_ref = None;
                    record.last_error_code = Some("voice_state_commit_failed".into());
                }
                runtime.document.revision = runtime.document.revision.saturating_add(1);
                runtime.recovery_required.insert(asset_id.to_owned());
                let _ = persist_voice_document(&self.inner.state_path, &runtime.document);
            }
        }
        let event_owner = runtime
            .active
            .get(asset_id)
            .map(|active| active.owner.clone());
        runtime.active.remove(asset_id);
        drop(runtime);
        self.inner.changed.notify_waiters();
        if let Some(owner) = event_owner {
            self.emit_status_to(&owner).await;
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct TransferResponsePlan {
    offset: u64,
    append: bool,
}

fn prepare_partial_transfer(path: &Path, expected_size: u64) -> AppResult<u64> {
    let existing = regular_file_len_or_zero(path, "Voice partial transfer")?;
    if existing > expected_size {
        remove_regular_file_if_exists(path, "Oversized voice partial transfer")?;
        Ok(0)
    } else {
        Ok(existing)
    }
}

fn validate_transfer_response(
    existing: u64,
    status: reqwest::StatusCode,
    content_range: Option<&str>,
) -> AppResult<TransferResponsePlan> {
    if existing > 0 && status == reqwest::StatusCode::PARTIAL_CONTENT {
        let expected_prefix = format!("bytes {existing}-");
        if content_range.is_none_or(|value| !value.starts_with(&expected_prefix)) {
            return Err(AppError::new(
                "voice_asset_resume_rejected",
                "Voice asset server returned an invalid resume range",
            ));
        }
        return Ok(TransferResponsePlan {
            offset: existing,
            append: true,
        });
    }
    if status == reqwest::StatusCode::OK {
        return Ok(TransferResponsePlan {
            offset: 0,
            append: false,
        });
    }
    Err(AppError::new(
        "voice_asset_download_failed",
        format!("Voice asset server returned HTTP {status}"),
    )
    .retryable(true))
}

fn verify_download_and_reject_mismatch(
    path: &Path,
    expected_size: u64,
    expected_hash: &str,
) -> AppResult<()> {
    match verify_regular_file_exact(path, expected_size, expected_hash) {
        Ok(()) => Ok(()),
        Err(error)
            if matches!(
                error.code.as_str(),
                "voice_asset_size_mismatch" | "voice_asset_hash_mismatch"
            ) =>
        {
            remove_regular_file_if_exists(path, "Rejected voice transfer")?;
            Err(error)
        }
        Err(error) => Err(error),
    }
}

fn transfer_part_path(root: &Path, asset_id: &str) -> AppResult<PathBuf> {
    direct_child(root, &format!("{asset_id}.part"), "Voice partial transfer")
}

fn direct_child(parent: &Path, leaf: &str, label: &str) -> AppResult<PathBuf> {
    if leaf.is_empty()
        || leaf == "."
        || leaf == ".."
        || leaf.len() > 220
        || leaf.contains('/')
        || leaf.contains('\\')
        || leaf.as_bytes().contains(&0)
        || !parent.is_absolute()
    {
        return Err(AppError::new(
            "voice_path_invalid",
            format!("{label} is not a verified direct Local child"),
        ));
    }
    let child = parent.join(leaf);
    if child.parent() != Some(parent) {
        return Err(AppError::new(
            "voice_path_invalid",
            format!("{label} escaped its Native-owned parent"),
        ));
    }
    Ok(child)
}

fn allowed_download_url(url: &url::Url) -> bool {
    if url.scheme() != "https" || url.username() != "" || url.password().is_some() {
        return false;
    }
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    matches!(
        host.as_str(),
        "github.com"
            | "release-assets.githubusercontent.com"
            | "objects.githubusercontent.com"
            | "raw.githubusercontent.com"
            | "huggingface.co"
            | "cdn-lfs.huggingface.co"
            | "cas-bridge.xethub.hf.co"
            | "transfer.xethub.hf.co"
    ) || host.ends_with(".cdn.hf.co")
}

fn ensure_not_cancelled(cancelled: &watch::Receiver<bool>) -> AppResult<()> {
    if *cancelled.borrow() {
        Err(cancelled_error())
    } else {
        Ok(())
    }
}

fn cancelled_error() -> AppError {
    AppError::new("voice_operation_cancelled", "Voice operation was cancelled")
}

fn regular_file_len_or_zero(path: &Path, label: &str) -> AppResult<u64> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            verify_regular_metadata(&metadata, label)?;
            Ok(metadata.len())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(0),
        Err(error) => Err(AppError::io("inspect voice file", error)),
    }
}

fn open_private_transfer_file(path: &Path, append: bool) -> AppResult<File> {
    if path.exists() {
        let metadata = fs::symlink_metadata(path)
            .map_err(|error| AppError::io("inspect voice transfer", error))?;
        verify_regular_metadata(&metadata, "Voice partial transfer")?;
    }
    let mut options = OpenOptions::new();
    options
        .create(true)
        .write(true)
        .append(append)
        .truncate(!append);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options
        .open(path)
        .map_err(|error| AppError::io("open voice transfer", error))?;
    verify_regular_metadata(
        &file
            .metadata()
            .map_err(|error| AppError::io("inspect opened voice transfer", error))?,
        "Voice partial transfer",
    )?;
    Ok(file)
}

fn open_regular_read_nofollow(path: &Path, label: &str) -> AppResult<File> {
    let mut options = OpenOptions::new();
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
    let file = options
        .open(path)
        .map_err(|error| AppError::io("open voice regular file", error))?;
    let metadata = file
        .metadata()
        .map_err(|error| AppError::io("inspect opened voice regular file", error))?;
    verify_regular_metadata(&metadata, label)?;
    Ok(file)
}

fn verify_regular_file_exact(
    path: &Path,
    expected_size: u64,
    expected_hash: &str,
) -> AppResult<()> {
    let mut file = open_regular_read_nofollow(path, "Voice asset")?;
    let metadata = file
        .metadata()
        .map_err(|error| AppError::io("inspect voice asset", error))?;
    verify_regular_metadata(&metadata, "Voice asset")?;
    if metadata.len() != expected_size {
        return Err(AppError::new(
            "voice_asset_size_mismatch",
            "Voice asset size does not match the immutable catalog",
        ));
    }
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| AppError::io("hash voice asset", error))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    if format!("{:x}", digest.finalize()) != expected_hash {
        return Err(AppError::new(
            "voice_asset_hash_mismatch",
            "Voice asset SHA256 does not match the immutable catalog",
        ));
    }
    Ok(())
}

fn persist_voice_document(path: &Path, document: &VoiceStateDocument) -> AppResult<()> {
    atomic_write_json(path, document).map_err(|error| {
        eprintln!("Native voice state commit failed: {error}");
        AppError::new(
            "voice_state_commit_failed",
            "Voice state commit failed inside the Native Voice Service",
        )
        .outcome_unknown(true)
    })?;
    let readback: VoiceStateDocument = read_json(path)
        .map_err(|error| {
            eprintln!("Native voice state readback failed: {error}");
            AppError::new(
                "voice_state_commit_unconfirmed",
                "Voice state commit could not be read back",
            )
            .outcome_unknown(true)
        })?
        .ok_or_else(|| {
            AppError::new(
                "voice_state_commit_unconfirmed",
                "Voice state commit could not be read back",
            )
            .outcome_unknown(true)
        })?;
    if &readback != document {
        return Err(AppError::new(
            "voice_state_commit_unconfirmed",
            "Voice state readback did not match the committed document",
        )
        .outcome_unknown(true));
    }
    Ok(())
}

fn recovery_required_error() -> AppError {
    AppError::new(
        "voice_asset_recovery_required",
        "Voice asset state is fenced until Desktop restart reconciliation completes",
    )
    .outcome_unknown(true)
}

fn transcription_recovery_required_error() -> AppError {
    AppError::new(
        "voice_transcription_recovery_required",
        "Voice transcription state is fenced until Native recovery proves process exit and raw-audio cleanup",
    )
    .outcome_unknown(true)
}

fn has_owner_transcription_recovery(runtime: &VoiceRuntime, owner: &VoiceSessionOwner) -> bool {
    runtime
        .transcription_recovery_required
        .iter()
        .any(|operation_ref| {
            runtime
                .document
                .operations
                .get(operation_ref)
                .is_some_and(|record| {
                    record.renderer_session_id == owner.renderer_session_id
                        && record.renderer_generation == owner.renderer_generation
                        && record.window_label == owner.window_label
                })
        })
}

fn operation_status(record: &VoiceOperationRecord) -> VoiceOperationStatus {
    VoiceOperationStatus {
        operation_ref: record.operation_ref.clone(),
        composer_binding: record.composer_binding.clone(),
        phase: record.phase.clone(),
        duration_ms: record.duration_ms,
        transcript: record.transcript.clone(),
        last_error_code: record.last_error_code.clone(),
    }
}

pub(crate) fn validate_pcm_transport(pcm: &[u8], sample_count: u32) -> AppResult<u64> {
    validate_pcm(pcm, sample_count)
}

fn migrate_voice_document(value: serde_json::Value) -> AppResult<VoiceStateDocument> {
    let schema_version = value
        .get("schemaVersion")
        .and_then(serde_json::Value::as_u64)
        .and_then(|version| u32::try_from(version).ok())
        .ok_or_else(|| AppError::new("voice_state_invalid", "Voice state schema is missing"))?;
    match schema_version {
        VOICE_STATE_SCHEMA_VERSION => serde_json::from_value(value).map_err(|_| {
            AppError::new(
                "voice_state_invalid",
                "Current Voice state does not match schema v3",
            )
            .outcome_unknown(true)
        }),
        1 | 2 => {
            let legacy: VoiceStateDocumentV2 = serde_json::from_value(value).map_err(|_| {
                AppError::new(
                    "voice_state_invalid",
                    "Legacy Voice state does not match its declared schema",
                )
                .outcome_unknown(true)
            })?;
            if legacy.schema_version == 1 && !legacy.operations.is_empty() {
                return Err(AppError::new(
                    "voice_state_invalid",
                    "Legacy Voice state unexpectedly contains transcription operations",
                )
                .outcome_unknown(true));
            }
            Ok(VoiceStateDocument {
                schema_version: VOICE_STATE_SCHEMA_VERSION,
                revision: legacy.revision.saturating_add(1),
                assets: legacy.assets,
                operations: legacy
                    .operations
                    .into_iter()
                    .map(|(operation_ref, record)| (operation_ref, record.into()))
                    .collect(),
            })
        }
        _ => Err(AppError::new(
            "voice_state_schema_unsupported",
            "Voice state was written by a newer Desktop Next",
        )),
    }
}

fn reconcile_transcription_operations(
    operations_root: &Path,
    document: &mut VoiceStateDocument,
) -> AppResult<()> {
    for (operation_ref, record) in &document.operations {
        let canonical_renderer_session = uuid::Uuid::parse_str(&record.renderer_session_id)
            .ok()
            .map(|value| value.hyphenated().to_string());
        let recovery_target_valid = match record.phase {
            VoiceOperationPhase::RecoveryRequired => {
                record.recovery_target_phase.as_ref().is_some_and(|phase| {
                    matches!(
                        phase,
                        VoiceOperationPhase::Transcribed
                            | VoiceOperationPhase::Cancelled
                            | VoiceOperationPhase::Failed
                    )
                })
            }
            _ => record.recovery_target_phase.is_none(),
        };
        let transcript_allowed = match record.phase {
            VoiceOperationPhase::Transcribed => true,
            VoiceOperationPhase::RecoveryRequired => {
                record.recovery_target_phase == Some(VoiceOperationPhase::Transcribed)
            }
            _ => false,
        };
        if operation_ref != &record.operation_ref
            || uuid::Uuid::parse_str(operation_ref)
                .ok()
                .map(|value| value.hyphenated().to_string())
                .as_deref()
                != Some(operation_ref.as_str())
            || canonical_renderer_session.as_deref() != Some(record.renderer_session_id.as_str())
            || !stored_composer_binding_valid(&record.composer_binding)
            || record.pcm_sha256.len() != 64
            || !record
                .pcm_sha256
                .bytes()
                .all(|value| value.is_ascii_hexdigit() && !value.is_ascii_uppercase())
            || !(transcription::MIN_PCM_SAMPLES..=transcription::MAX_PCM_SAMPLES)
                .contains(&record.sample_count)
            || record.duration_ms
                != (record.sample_count as u64 * 1_000) / transcription::PCM_SAMPLE_RATE_HZ as u64
            || record.created_at_ms == 0
            || !recovery_target_valid
            || (record.phase == VoiceOperationPhase::Transcribed
                && record.transcript.as_deref().is_none_or(str::is_empty))
            || (!transcript_allowed && record.transcript.is_some())
            || (record.phase == VoiceOperationPhase::RecoveryRequired
                && record.recovery_target_phase == Some(VoiceOperationPhase::Transcribed)
                && record.transcript.as_deref().is_none_or(str::is_empty))
            || record.transcript.as_ref().is_some_and(|value| {
                value.len() > transcription::TRANSCRIPT_MAX_BYTES
                    || value.chars().any(|character| {
                        character.is_control() && !matches!(character, '\n' | '\r' | '\t')
                    })
            })
        {
            return Err(AppError::new(
                "voice_state_invalid",
                "Voice transcription state is invalid",
            )
            .outcome_unknown(true));
        }
    }
    let known = document.operations.keys().cloned().collect::<HashSet<_>>();
    for entry in fs::read_dir(operations_root)
        .map_err(|error| AppError::io("list voice operation root", error))?
    {
        let entry =
            entry.map_err(|error| AppError::io("read voice operation root entry", error))?;
        let name = entry.file_name().into_string().map_err(|_| {
            AppError::new("voice_state_invalid", "Voice operation name is not Unicode")
        })?;
        if !known.contains(&name) {
            return Err(AppError::new(
                "voice_recovery_uncertain",
                "Voice recovery found an operation directory without durable ownership",
            )
            .outcome_unknown(true));
        }
    }
    for record in document.operations.values_mut() {
        let paths = operation_paths(operations_root, &record.operation_ref)?;
        let original_phase = record.phase.clone();
        let cleanup = match original_phase {
            VoiceOperationPhase::Staging => {
                record.recovery_target_phase = Some(VoiceOperationPhase::Failed);
                true
            }
            VoiceOperationPhase::Transcribing => {
                let gone = match (
                    record.containment_kind.as_deref(),
                    record.containment_id.as_deref(),
                    record.expected_pid,
                ) {
                    (Some(kind), Some(id), Some(pid)) => {
                        containment_definitively_gone_after_instance_lock(
                            kind,
                            id,
                            TRANSCRIPTION_NAMESPACE,
                            &record.operation_ref,
                            pid,
                        )
                    }
                    _ => false,
                };
                if !gone {
                    record.phase = VoiceOperationPhase::RecoveryRequired;
                    record.recovery_target_phase = Some(VoiceOperationPhase::Failed);
                    record.last_error_code = Some("voice_process_recovery_required".into());
                }
                gone
            }
            VoiceOperationPhase::Transcribed
            | VoiceOperationPhase::Cancelled
            | VoiceOperationPhase::Failed => true,
            VoiceOperationPhase::RecoveryRequired => match (
                record.containment_kind.as_deref(),
                record.containment_id.as_deref(),
                record.expected_pid,
            ) {
                (Some(kind), Some(id), Some(pid)) => {
                    containment_definitively_gone_after_instance_lock(
                        kind,
                        id,
                        TRANSCRIPTION_NAMESPACE,
                        &record.operation_ref,
                        pid,
                    )
                }
                (None, None, None) => true,
                _ => false,
            },
        };
        if cleanup {
            if let Err(error) = remove_operation_directory(&paths) {
                let recovery_target = match original_phase {
                    VoiceOperationPhase::Transcribed => VoiceOperationPhase::Transcribed,
                    VoiceOperationPhase::Cancelled => VoiceOperationPhase::Cancelled,
                    VoiceOperationPhase::Failed
                    | VoiceOperationPhase::Staging
                    | VoiceOperationPhase::Transcribing => VoiceOperationPhase::Failed,
                    VoiceOperationPhase::RecoveryRequired => record
                        .recovery_target_phase
                        .clone()
                        .unwrap_or(VoiceOperationPhase::Failed),
                };
                record.phase = VoiceOperationPhase::RecoveryRequired;
                record.recovery_target_phase = Some(recovery_target);
                record.last_error_code = Some(error.code);
                continue;
            }
            match original_phase {
                VoiceOperationPhase::Staging | VoiceOperationPhase::Transcribing => {
                    record.phase = VoiceOperationPhase::Failed;
                    record.transcript = None;
                    record.last_error_code = Some("voice_operation_interrupted".into());
                }
                VoiceOperationPhase::RecoveryRequired => {
                    let target = record
                        .recovery_target_phase
                        .clone()
                        .unwrap_or(VoiceOperationPhase::Failed);
                    record.phase = target.clone();
                    if target != VoiceOperationPhase::Transcribed {
                        record.transcript = None;
                    }
                    if target == VoiceOperationPhase::Cancelled {
                        record.last_error_code = None;
                    }
                }
                VoiceOperationPhase::Transcribed
                | VoiceOperationPhase::Cancelled
                | VoiceOperationPhase::Failed => {}
            }
            record.recovery_target_phase = None;
            record.containment_kind = None;
            record.containment_id = None;
            record.expected_pid = None;
        }
    }
    Ok(())
}

fn draft_sha256_valid(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn bounded_binding_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

fn stored_composer_binding_valid(binding: &VoiceComposerBinding) -> bool {
    match binding {
        VoiceComposerBinding::Agent {
            project_id,
            agent_id,
            draft_sha256,
        } => {
            bounded_binding_id(project_id)
                && bounded_binding_id(agent_id)
                && draft_sha256_valid(draft_sha256)
        }
        VoiceComposerBinding::Launcher { draft_sha256 } => draft_sha256_valid(draft_sha256),
        VoiceComposerBinding::LegacyUnbound => true,
    }
}

fn validate_new_composer_binding(binding: &VoiceComposerBinding) -> AppResult<()> {
    if !stored_composer_binding_valid(binding)
        || matches!(binding, VoiceComposerBinding::LegacyUnbound)
    {
        return Err(AppError::new(
            "voice_composer_binding_invalid",
            "Voice transcription requires one exact current Composer binding",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIFECYCLE_ASSET_ID: &str = "whisper.cpp-model-base-multilingual";

    struct VoiceTestRoot(PathBuf);

    impl VoiceTestRoot {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "orquesta-voice-lifecycle-test-{}",
                uuid::Uuid::new_v4()
            ));
            fs::create_dir(&root).expect("create isolated voice lifecycle root");
            Self(root)
        }
    }

    impl Drop for VoiceTestRoot {
        fn drop(&mut self) {
            let temp = std::env::temp_dir();
            let is_owned_test_root = self.0.parent() == Some(temp.as_path())
                && self
                    .0
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("orquesta-voice-lifecycle-test-"));
            if is_owned_test_root {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
    }

    fn lifecycle_owner(session: &str, generation: u64) -> VoiceSessionOwner {
        VoiceSessionOwner::new(session.into(), generation, "main".into())
    }

    fn agent_composer_binding() -> VoiceComposerBinding {
        VoiceComposerBinding::Agent {
            project_id: "project-1".into(),
            agent_id: "orchestrator".into(),
            draft_sha256: "1".repeat(64),
        }
    }

    fn transcription_record(
        operation_ref: &str,
        owner: &VoiceSessionOwner,
        phase: VoiceOperationPhase,
        transcript: Option<&str>,
    ) -> VoiceOperationRecord {
        VoiceOperationRecord {
            operation_ref: operation_ref.into(),
            renderer_session_id: owner.renderer_session_id.clone(),
            renderer_generation: owner.renderer_generation,
            window_label: owner.window_label.clone(),
            composer_binding: agent_composer_binding(),
            phase,
            pcm_sha256: "0".repeat(64),
            sample_count: transcription::MIN_PCM_SAMPLES,
            duration_ms: (transcription::MIN_PCM_SAMPLES as u64 * 1_000)
                / transcription::PCM_SAMPLE_RATE_HZ as u64,
            transcript: transcript.map(str::to_owned),
            last_error_code: None,
            recovery_target_phase: None,
            containment_kind: None,
            containment_id: None,
            expected_pid: None,
            created_at_ms: 1,
        }
    }

    fn cancellation_only_runner() -> TestAcquisitionRunner {
        Arc::new(|_asset, _operation_ref, mut cancelled| {
            Box::pin(async move {
                loop {
                    if *cancelled.borrow() {
                        return Err(cancelled_error());
                    }
                    if cancelled.changed().await.is_err() {
                        return Err(cancelled_error());
                    }
                }
            })
        })
    }

    fn lifecycle_asset(status: &VoiceStatus) -> &VoiceAssetStatus {
        status
            .assets
            .iter()
            .find(|asset| asset.asset_id == LIFECYCLE_ASSET_ID)
            .expect("lifecycle asset status")
    }

    #[cfg(windows)]
    fn required_live_path(name: &str) -> PathBuf {
        let path = std::env::var_os(name)
            .map(PathBuf::from)
            .unwrap_or_else(|| panic!("{name} must point to the exact reviewed P2-007 asset"));
        assert!(path.is_absolute(), "{name} must be an absolute path");
        path
    }

    #[cfg(windows)]
    fn built_desktop_test_launcher() -> PathBuf {
        let current = std::env::current_exe().expect("resolve Cargo test executable");
        let deps = current.parent().expect("Cargo test deps directory");
        assert_eq!(deps.file_name(), Some(std::ffi::OsStr::new("deps")));
        let executable = deps
            .parent()
            .expect("Cargo target profile directory")
            .join("orquesta-desktop-next.exe");
        assert!(
            executable.is_file(),
            "build the real Desktop launcher first: cargo build --bin orquesta-desktop-next"
        );
        executable
    }

    #[cfg(windows)]
    fn seed_reviewed_asset_part(service: &VoiceService, asset_id: &str, source: &Path) {
        let asset = service
            .inner
            .catalog
            .asset(asset_id)
            .expect("reviewed live asset is present in the immutable catalog");
        verify_regular_file_exact(source, asset.size_bytes, &asset.sha256)
            .expect("live asset must match the immutable catalog exactly");
        let part = transfer_part_path(&service.inner.transfers_root, asset_id)
            .expect("bounded transfer part path");
        assert!(!part.exists(), "isolated transfer part must start absent");
        if fs::hard_link(source, &part).is_err() {
            fs::copy(source, &part).expect("seed exact reviewed asset into isolated transfer root");
        }
        assert_eq!(
            fs::metadata(&part).expect("seeded transfer metadata").len(),
            asset.size_bytes
        );
    }

    #[cfg(windows)]
    async fn wait_for_live_asset_install(
        service: &VoiceService,
        owner: &VoiceSessionOwner,
        asset_id: &str,
        timeout: Duration,
    ) {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let status = service.status_for(owner).await;
            let asset = status
                .assets
                .into_iter()
                .find(|asset| asset.asset_id == asset_id)
                .expect("live asset status");
            if asset.phase == VoiceAssetPhase::Installed {
                assert!(asset.operation_ref.is_none());
                assert!(asset.last_error_code.is_none());
                return;
            }
            if asset.operation_ref.is_none()
                && matches!(
                    asset.phase,
                    VoiceAssetPhase::Absent
                        | VoiceAssetPhase::Paused
                        | VoiceAssetPhase::Failed
                        | VoiceAssetPhase::RecoveryRequired
                )
            {
                panic!("live asset acquisition stopped before install: {asset:?}");
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "live asset acquisition exceeded its bounded timeout: {asset:?}"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    #[cfg(windows)]
    async fn wait_for_live_containment_gone(
        identity: Option<&(String, String, u32)>,
        operation_ref: &str,
        timeout: Duration,
    ) -> bool {
        let Some((kind, id, expected_pid)) = identity else {
            return false;
        };
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            if containment_definitively_gone_after_instance_lock(
                kind,
                id,
                TRANSCRIPTION_NAMESPACE,
                operation_ref,
                *expected_pid,
            ) {
                return true;
            }
            if tokio::time::Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    #[cfg(windows)]
    async fn fail_live_canary(
        service: VoiceService,
        root: VoiceTestRoot,
        owner: &VoiceSessionOwner,
        operation_ref: &str,
        reason: String,
        mut observed_identity: Option<(String, String, u32)>,
    ) -> ! {
        let (record_before, active_before, recovery_before, leases_before) = {
            let runtime = service.inner.runtime.lock().await;
            (
                runtime.document.operations.get(operation_ref).cloned(),
                runtime.active_transcriptions.contains_key(operation_ref),
                runtime
                    .transcription_recovery_required
                    .contains(operation_ref),
                runtime.leases.clone(),
            )
        };
        if observed_identity.is_none() {
            if let Some(record) = &record_before {
                if let (Some(kind), Some(id), Some(pid)) = (
                    record.containment_kind.clone(),
                    record.containment_id.clone(),
                    record.expected_pid,
                ) {
                    observed_identity = Some((kind, id, pid));
                }
            }
        }
        let paths = operation_paths(&service.inner.operations_root, operation_ref)
            .expect("bounded failed operation paths");
        let operation_root_existed_before_cleanup = paths.root.exists();
        let cancel = service.cancel_transcription(operation_ref, owner).await;
        let shutdown = tokio::time::timeout(Duration::from_secs(15), service.shutdown()).await;
        let containment_gone = wait_for_live_containment_gone(
            observed_identity.as_ref(),
            operation_ref,
            Duration::from_secs(2),
        )
        .await;
        let (record_after, active_after, recovery_after, leases_after) = {
            let runtime = service.inner.runtime.lock().await;
            (
                runtime.document.operations.get(operation_ref).cloned(),
                runtime.active_transcriptions.contains_key(operation_ref),
                runtime
                    .transcription_recovery_required
                    .contains(operation_ref),
                runtime.leases.clone(),
            )
        };
        let operation_root_exists_after_cleanup = paths.root.exists();
        let shutdown_clean = matches!(&shutdown, Ok(Ok(())));
        let preserve_diagnostic_root = !containment_gone || !shutdown_clean;
        let diagnostic_root = root.0.clone();
        drop(service);
        if preserve_diagnostic_root {
            eprintln!(
                "unsafe live-canary cleanup; preserving diagnostic root at {}",
                diagnostic_root.display()
            );
            std::mem::forget(root);
        }
        panic!(
            "{reason}: recordBefore={record_before:?}, activeBefore={active_before}, recoveryBefore={recovery_before}, leasesBefore={leases_before:?}, operationRootExistedBeforeCleanup={operation_root_existed_before_cleanup}, recordAfter={record_after:?}, activeAfter={active_after}, recoveryAfter={recovery_after}, leasesAfter={leases_after:?}, operationRootExistsAfterCleanup={operation_root_exists_after_cleanup}, observedProcessIdentity={observed_identity:?}, containmentGone={containment_gone}, cancel={cancel:?}, shutdown={shutdown:?}, diagnosticRoot={}, diagnosticRootPreserved={preserve_diagnostic_root}",
            diagnostic_root.display()
        );
    }

    #[cfg(windows)]
    fn reviewed_float_wav_as_pcm_s16le(path: &Path) -> (Vec<u8>, u32) {
        const REVIEWED_WAV_SHA256: &str =
            "4428db44a80abbbde2663b4acfe0db59b781f009dc41b15cf028293c834a4613";
        let wav = fs::read(path).expect("read reviewed public Japanese WAV");
        assert_eq!(
            format!("{:x}", Sha256::digest(&wav)),
            REVIEWED_WAV_SHA256,
            "public Japanese WAV must be the exact reviewed FLEURS sample"
        );
        assert!(wav.len() >= 12, "reviewed WAV is truncated");
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        let riff_size = u32::from_le_bytes(wav[4..8].try_into().unwrap()) as usize;
        assert_eq!(riff_size + 8, wav.len(), "reviewed RIFF size is exact");

        let mut format = None;
        let mut fact_samples = None;
        let mut data = None;
        let mut cursor = 12_usize;
        while cursor + 8 <= wav.len() {
            let chunk_id = &wav[cursor..cursor + 4];
            let chunk_size =
                u32::from_le_bytes(wav[cursor + 4..cursor + 8].try_into().unwrap()) as usize;
            let payload_start = cursor + 8;
            let payload_end = payload_start
                .checked_add(chunk_size)
                .expect("reviewed WAV chunk size does not overflow");
            assert!(payload_end <= wav.len(), "reviewed WAV chunk is truncated");
            match chunk_id {
                b"fmt " => {
                    assert!(chunk_size >= 16, "reviewed WAV fmt chunk is truncated");
                    format = Some((
                        u16::from_le_bytes(
                            wav[payload_start..payload_start + 2].try_into().unwrap(),
                        ),
                        u16::from_le_bytes(
                            wav[payload_start + 2..payload_start + 4]
                                .try_into()
                                .unwrap(),
                        ),
                        u32::from_le_bytes(
                            wav[payload_start + 4..payload_start + 8]
                                .try_into()
                                .unwrap(),
                        ),
                        u32::from_le_bytes(
                            wav[payload_start + 8..payload_start + 12]
                                .try_into()
                                .unwrap(),
                        ),
                        u16::from_le_bytes(
                            wav[payload_start + 12..payload_start + 14]
                                .try_into()
                                .unwrap(),
                        ),
                        u16::from_le_bytes(
                            wav[payload_start + 14..payload_start + 16]
                                .try_into()
                                .unwrap(),
                        ),
                    ));
                }
                b"fact" if chunk_size >= 4 => {
                    fact_samples = Some(u32::from_le_bytes(
                        wav[payload_start..payload_start + 4].try_into().unwrap(),
                    ));
                }
                b"data" => data = Some(&wav[payload_start..payload_end]),
                _ => {}
            }
            cursor = payload_end + (chunk_size & 1);
        }

        let (encoding, channels, sample_rate, byte_rate, block_align, bits_per_sample) =
            format.expect("reviewed WAV fmt chunk");
        assert_eq!(encoding, 3, "reviewed source uses IEEE float PCM");
        assert_eq!(channels, 1, "reviewed source is mono");
        assert_eq!(sample_rate, transcription::PCM_SAMPLE_RATE_HZ);
        assert_eq!(byte_rate, transcription::PCM_SAMPLE_RATE_HZ * 4);
        assert_eq!(block_align, 4);
        assert_eq!(bits_per_sample, 32);
        let float_pcm = data.expect("reviewed WAV data chunk");
        assert_eq!(float_pcm.len() % 4, 0);
        let sample_count = u32::try_from(float_pcm.len() / 4).expect("bounded sample count");
        assert_eq!(sample_count, 120_000);
        assert_eq!(fact_samples, Some(sample_count));

        let mut pcm_s16le = Vec::with_capacity(sample_count as usize * 2);
        for bytes in float_pcm.chunks_exact(4) {
            let sample = f32::from_le_bytes(bytes.try_into().unwrap());
            assert!(
                sample.is_finite(),
                "reviewed WAV contains a non-finite sample"
            );
            let sample = sample.clamp(-1.0, 1.0);
            let converted = if sample <= -1.0 {
                i16::MIN
            } else if sample >= 1.0 {
                i16::MAX
            } else {
                (sample * 32_768.0).round() as i16
            };
            pcm_s16le.extend_from_slice(&converted.to_le_bytes());
        }
        validate_pcm(&pcm_s16le, sample_count)
            .expect("converted public WAV meets the Native PCM contract");
        (pcm_s16le, sample_count)
    }

    #[cfg(windows)]
    fn assert_native_pcm_stage_evidence(service: &VoiceService, pcm: &[u8], sample_count: u32) {
        const EVIDENCE_OPERATION_REF: &str = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
        let paths = stage_pcm_wav(
            &service.inner.operations_root,
            EVIDENCE_OPERATION_REF,
            pcm,
            sample_count,
        )
        .expect("stage exact Native PCM evidence WAV");
        let wav = fs::read(&paths.wav).expect("read exact Native PCM evidence WAV");
        assert_eq!(wav.len(), 44 + pcm.len());
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[12..16], b"fmt ");
        assert_eq!(u32::from_le_bytes(wav[16..20].try_into().unwrap()), 16);
        assert_eq!(u16::from_le_bytes(wav[20..22].try_into().unwrap()), 1);
        assert_eq!(u16::from_le_bytes(wav[22..24].try_into().unwrap()), 1);
        assert_eq!(
            u32::from_le_bytes(wav[24..28].try_into().unwrap()),
            transcription::PCM_SAMPLE_RATE_HZ
        );
        assert_eq!(u32::from_le_bytes(wav[28..32].try_into().unwrap()), 32_000);
        assert_eq!(u16::from_le_bytes(wav[32..34].try_into().unwrap()), 2);
        assert_eq!(u16::from_le_bytes(wav[34..36].try_into().unwrap()), 16);
        assert_eq!(&wav[36..40], b"data");
        assert_eq!(
            u32::from_le_bytes(wav[40..44].try_into().unwrap()) as usize,
            pcm.len()
        );
        assert_eq!(&wav[44..], pcm);

        let mut peak = 0_u32;
        let mut square_sum = 0_f64;
        let mut nonzero_samples = 0_u32;
        for bytes in pcm.chunks_exact(2) {
            let sample = i16::from_le_bytes(bytes.try_into().unwrap());
            let magnitude = i32::from(sample).unsigned_abs();
            peak = peak.max(magnitude);
            if sample != 0 {
                nonzero_samples += 1;
            }
            square_sum += f64::from(sample) * f64::from(sample);
        }
        let rms = (square_sum / f64::from(sample_count)).sqrt();
        assert!(peak > 100, "converted public audio is unexpectedly silent");
        assert!(
            rms > 10.0,
            "converted public audio RMS is unexpectedly silent"
        );
        assert!(
            nonzero_samples > sample_count / 4,
            "converted public audio has too few nonzero frames"
        );
        eprintln!(
            "publicWavEncoding=ieee-float32; nativeWavEncoding=pcm-s16le; frames={sample_count}; pcmBytes={}; peak={peak}; rms={rms:.3}; nativeWavSha256={:x}",
            pcm.len(),
            Sha256::digest(&wav)
        );
        remove_operation_directory(&paths).expect("remove Native PCM evidence operation root");
        assert!(!paths.root.exists());
    }

    #[test]
    fn allowed_download_origins_are_https_and_bounded() {
        assert!(allowed_download_url(
            &url::Url::parse("https://huggingface.co/model").unwrap()
        ));
        assert!(allowed_download_url(
            &url::Url::parse("https://release-assets.githubusercontent.com/object").unwrap()
        ));
        assert!(allowed_download_url(
            &url::Url::parse("https://us.aws.cdn.hf.co/object").unwrap()
        ));
        assert!(!allowed_download_url(
            &url::Url::parse("http://huggingface.co/model").unwrap()
        ));
        assert!(!allowed_download_url(
            &url::Url::parse("https://example.com/model").unwrap()
        ));
        assert!(!allowed_download_url(
            &url::Url::parse("https://us.aws.cdn.hf.co.example.com/model").unwrap()
        ));
    }

    #[test]
    fn direct_child_rejects_traversal_and_separators() {
        let root = std::env::temp_dir();
        assert!(direct_child(&root, "asset.bin", "test").is_ok());
        assert!(direct_child(&root, "../asset.bin", "test").is_err());
        assert!(direct_child(&root, "folder/asset.bin", "test").is_err());
    }

    #[test]
    fn renderer_voice_status_excludes_native_paths_urls_and_hashes() {
        let status = VoiceStatus {
            schema_version: VOICE_STATUS_SCHEMA_VERSION,
            revision: 3,
            provider_id: "whisper.cpp-local".into(),
            binary_asset_id: "voice-binary".into(),
            initial_model_asset_id: "voice-small".into(),
            comparison_model_asset_id: "voice-base".into(),
            required_assets_ready: false,
            assets: vec![VoiceAssetStatus {
                asset_id: "voice-small".into(),
                kind: "model".into(),
                phase: VoiceAssetPhase::Downloading,
                downloaded_bytes: 4,
                expected_bytes: 8,
                operation_ref: Some("77777777-7777-4777-8777-777777777777".into()),
                last_error_code: None,
            }],
            operations: vec![],
        };
        let encoded = serde_json::to_string(&status).expect("serialize renderer voice status");
        for forbidden in [
            "rootPath",
            "localPath",
            "sourceUrl",
            "licenseUrl",
            "archiveAllowlist",
            "pcmSha256",
        ] {
            assert!(!encoded.contains(forbidden), "leaked field: {forbidden}");
        }
    }

    #[test]
    fn v2_transcripts_migrate_to_explicit_legacy_unbound_without_rebinding() {
        let catalog = AssetCatalog::load().expect("load voice catalog");
        let owner = lifecycle_owner("11111111-1111-4111-8111-111111111111", 7);
        let operation_ref = "44444444-4444-4444-8444-444444444444";
        let mut document = VoiceStateDocument::from_catalog(&catalog);
        document.revision = 9;
        document.operations.insert(
            operation_ref.into(),
            transcription_record(
                operation_ref,
                &owner,
                VoiceOperationPhase::Transcribed,
                Some("保持される文字起こし"),
            ),
        );

        let mut legacy = serde_json::to_value(document).expect("serialize legacy fixture");
        legacy["schemaVersion"] = serde_json::Value::from(2);
        legacy["operations"][operation_ref]
            .as_object_mut()
            .expect("legacy operation object")
            .remove("composerBinding");
        let migrated = migrate_voice_document(legacy).expect("migrate real v2 voice state");
        assert_eq!(migrated.schema_version, 3);
        assert_eq!(migrated.revision, 10);
        let record = migrated
            .operations
            .get(operation_ref)
            .expect("migrated operation");
        assert_eq!(record.composer_binding, VoiceComposerBinding::LegacyUnbound);
        assert_eq!(record.transcript.as_deref(), Some("保持される文字起こし"));
    }

    #[test]
    fn v3_missing_composer_binding_fails_closed() {
        let catalog = AssetCatalog::load().expect("load voice catalog");
        let owner = lifecycle_owner("11111111-1111-4111-8111-111111111111", 7);
        let operation_ref = "44444444-4444-4444-8444-444444444444";
        let mut document = VoiceStateDocument::from_catalog(&catalog);
        document.operations.insert(
            operation_ref.into(),
            transcription_record(
                operation_ref,
                &owner,
                VoiceOperationPhase::Transcribed,
                Some("欠落を拒否する文字起こし"),
            ),
        );
        let mut current = serde_json::to_value(document).expect("serialize v3 fixture");
        current["operations"][operation_ref]
            .as_object_mut()
            .expect("current operation object")
            .remove("composerBinding");

        let error = migrate_voice_document(current).expect_err("v3 binding is mandatory");
        assert_eq!(error.code, "voice_state_invalid");
        assert!(error.outcome_unknown);
    }

    #[tokio::test]
    async fn existing_operation_replay_requires_exact_immutable_composer_binding() {
        let root = VoiceTestRoot::new();
        let service = VoiceService::open_with_components(root.0.clone(), Arc::new(|_, _| {}))
            .expect("open voice service");
        let owner = lifecycle_owner("11111111-1111-4111-8111-111111111111", 7);
        let operation_ref = "44444444-4444-4444-8444-444444444444";
        let pcm = vec![0_u8; transcription::MIN_PCM_SAMPLES as usize * 2];
        let binding = agent_composer_binding();
        {
            let mut runtime = service.inner.runtime.lock().await;
            let mut record = transcription_record(
                operation_ref,
                &owner,
                VoiceOperationPhase::Transcribed,
                Some("完了済み"),
            );
            record.pcm_sha256 = pcm_sha256(&pcm);
            record.composer_binding = binding.clone();
            runtime
                .document
                .operations
                .insert(operation_ref.into(), record);
        }

        let replay = service
            .start_transcription(
                operation_ref,
                owner.clone(),
                binding,
                pcm.clone(),
                transcription::MIN_PCM_SAMPLES,
            )
            .await
            .expect("exact replay returns prior operation");
        assert_eq!(replay.phase, VoiceOperationPhase::Transcribed);

        let error = service
            .start_transcription(
                operation_ref,
                owner,
                VoiceComposerBinding::Agent {
                    project_id: "project-1".into(),
                    agent_id: "different-agent".into(),
                    draft_sha256: "1".repeat(64),
                },
                pcm,
                transcription::MIN_PCM_SAMPLES,
            )
            .await
            .expect_err("same operationRef cannot be rebound");
        assert_eq!(error.code, "voice_operation_conflict");
        assert!(error.outcome_unknown);
    }

    #[tokio::test]
    async fn status_events_are_owner_filtered_and_terminal_transcripts_adopt_exact_successor() {
        let root = VoiceTestRoot::new();
        let old = lifecycle_owner("11111111-1111-4111-8111-111111111111", 7);
        let successor = lifecycle_owner("22222222-2222-4222-8222-222222222222", 8);
        let foreign = lifecycle_owner("33333333-3333-4333-8333-333333333333", 9);
        let old_transcript = "44444444-4444-4444-8444-444444444444";
        let old_failed = "55555555-5555-4555-8555-555555555555";
        let foreign_transcript = "66666666-6666-4666-8666-666666666666";
        let emissions = Arc::new(std::sync::Mutex::new(
            Vec::<(VoiceSessionOwner, VoiceStatus)>::new(),
        ));
        let captured = emissions.clone();
        let service = VoiceService::open_with_components(
            root.0.clone(),
            Arc::new(move |owner, status| {
                captured
                    .lock()
                    .expect("capture voice event")
                    .push((owner, status));
            }),
        )
        .expect("open voice service with routed event capture");
        {
            let mut runtime = service.inner.runtime.lock().await;
            runtime.document.operations.insert(
                old_transcript.into(),
                transcription_record(
                    old_transcript,
                    &old,
                    VoiceOperationPhase::Transcribed,
                    Some("引き継ぐ文字起こし"),
                ),
            );
            let mut failed =
                transcription_record(old_failed, &old, VoiceOperationPhase::Failed, None);
            failed.last_error_code = Some("voice_transcription_failed".into());
            runtime
                .document
                .operations
                .insert(old_failed.into(), failed);
            runtime.document.operations.insert(
                foreign_transcript.into(),
                transcription_record(
                    foreign_transcript,
                    &foreign,
                    VoiceOperationPhase::Transcribed,
                    Some("他画面の文字起こし"),
                ),
            );
            runtime.document.revision += 1;
            persist_voice_document(&service.inner.state_path, &runtime.document)
                .expect("persist routed operation fixture");
        }

        service.emit_status().await;
        let captured = emissions.lock().expect("read captured voice events");
        assert_eq!(captured.len(), 2);
        for (owner, status) in captured.iter() {
            assert!(status.operations.iter().all(|operation| {
                if owner == &old {
                    operation.operation_ref == old_transcript
                        || operation.operation_ref == old_failed
                } else {
                    owner == &foreign && operation.operation_ref == foreign_transcript
                }
            }));
        }
        drop(captured);

        service
            .retire_renderer_session(&old, None)
            .await
            .expect("normal retirement preserves pending transcript");
        let retired_status = service.status_for(&old).await;
        assert_eq!(retired_status.operations.len(), 1);
        assert_eq!(
            retired_status.operations[0].transcript.as_deref(),
            Some("引き継ぐ文字起こし")
        );
        service
            .retire_renderer_session(&old, Some(&successor))
            .await
            .expect("exact predecessor adopts durable transcript");
        assert!(service.status_for(&old).await.operations.is_empty());
        let successor_status = service.status_for(&successor).await;
        assert_eq!(successor_status.operations.len(), 1);
        assert_eq!(
            successor_status.operations[0].transcript.as_deref(),
            Some("引き継ぐ文字起こし")
        );
        assert_eq!(
            successor_status.operations[0].composer_binding,
            agent_composer_binding(),
            "successor adoption must not rewrite the original Composer binding"
        );
        assert_eq!(service.status_for(&foreign).await.operations.len(), 1);
        assert_eq!(
            service
                .acknowledge_transcription(old_transcript, &old)
                .await
                .expect_err("retired owner cannot acknowledge adopted transcript")
                .code,
            "voice_operation_owner_mismatch"
        );
        service
            .acknowledge_transcription(old_transcript, &successor)
            .await
            .expect("successor explicitly acknowledges recovered transcript");
        assert!(service.status_for(&successor).await.operations.is_empty());

        let event = VoiceStatusEvent {
            schema_version: 1,
            renderer_session_id: successor.renderer_session_id.clone(),
            renderer_generation: successor.renderer_generation,
            window_label: successor.window_label.clone(),
            status: service.status_for(&successor).await,
        };
        let value = serde_json::to_value(event).expect("serialize routed voice event");
        assert_eq!(value["rendererSessionId"], successor.renderer_session_id);
        assert_eq!(value["rendererGeneration"], successor.renderer_generation);
        assert_eq!(value["windowLabel"], successor.window_label);
        assert!(value.get("status").is_some());
    }

    #[tokio::test]
    async fn asset_early_responses_never_include_another_renderer_transcript() {
        let root = VoiceTestRoot::new();
        let owner = lifecycle_owner("11111111-1111-4111-8111-111111111111", 7);
        let foreign = lifecycle_owner("22222222-2222-4222-8222-222222222222", 8);
        let foreign_operation = "33333333-3333-4333-8333-333333333333";
        let service = VoiceService::open_for_test(root.0.clone(), cancellation_only_runner())
            .expect("open test voice service");
        let (cancel, _cancelled) = watch::channel(false);
        {
            let mut runtime = service.inner.runtime.lock().await;
            runtime.document.operations.insert(
                foreign_operation.into(),
                transcription_record(
                    foreign_operation,
                    &foreign,
                    VoiceOperationPhase::Transcribed,
                    Some("他画面の文字起こし"),
                ),
            );
            runtime.active.insert(
                LIFECYCLE_ASSET_ID.into(),
                ActiveTransfer {
                    operation_ref: "44444444-4444-4444-8444-444444444444".into(),
                    owner: owner.clone(),
                    cancel,
                },
            );
        }
        let retry = service
            .start_asset_acquisition(LIFECYCLE_ASSET_ID, owner.clone())
            .await
            .expect("same-owner retry");
        assert!(retry.operations.is_empty());

        let asset_sha = service
            .inner
            .catalog
            .asset(LIFECYCLE_ASSET_ID)
            .expect("catalog asset")
            .sha256
            .clone();
        {
            let mut runtime = service.inner.runtime.lock().await;
            runtime.active.remove(LIFECYCLE_ASSET_ID);
            let asset = runtime
                .document
                .assets
                .get_mut(LIFECYCLE_ASSET_ID)
                .expect("voice asset record");
            asset.phase = VoiceAssetPhase::Installed;
            asset.installed_source_sha256 = Some(asset_sha);
        }
        let installed = service
            .start_asset_acquisition(LIFECYCLE_ASSET_ID, owner)
            .await
            .expect("already-installed response");
        assert!(installed.operations.is_empty());
        assert_eq!(service.status_for(&foreign).await.operations.len(), 1);
    }

    #[test]
    fn transfer_response_requires_an_exact_resume_origin_range() {
        assert_eq!(
            validate_transfer_response(
                4,
                reqwest::StatusCode::PARTIAL_CONTENT,
                Some("bytes 4-7/8")
            )
            .expect("valid resume"),
            TransferResponsePlan {
                offset: 4,
                append: true
            }
        );
        assert_eq!(
            validate_transfer_response(4, reqwest::StatusCode::OK, None)
                .expect("full response restarts from zero"),
            TransferResponsePlan {
                offset: 0,
                append: false
            }
        );
        assert_eq!(
            validate_transfer_response(
                4,
                reqwest::StatusCode::PARTIAL_CONTENT,
                Some("bytes 3-7/8")
            )
            .expect_err("wrong resume offset must fail closed")
            .code,
            "voice_asset_resume_rejected"
        );
        assert_eq!(
            validate_transfer_response(
                0,
                reqwest::StatusCode::PARTIAL_CONTENT,
                Some("bytes 0-7/8")
            )
            .expect_err("unsolicited partial response must fail closed")
            .code,
            "voice_asset_download_failed"
        );
    }

    #[test]
    fn oversized_and_hash_mismatched_partial_transfers_are_removed() {
        let path = std::env::temp_dir().join(format!(
            "orquesta-voice-part-test-{}.part",
            uuid::Uuid::new_v4()
        ));
        fs::write(&path, b"ninebytes").expect("write oversized partial");
        assert_eq!(
            prepare_partial_transfer(&path, 8).expect("normalize oversized partial"),
            0
        );
        assert!(!path.exists());

        fs::write(&path, b"12345678").expect("write hash-mismatch partial");
        let error = verify_download_and_reject_mismatch(
            &path,
            8,
            "0000000000000000000000000000000000000000000000000000000000000000",
        )
        .expect_err("hash mismatch must fail closed");
        assert_eq!(error.code, "voice_asset_hash_mismatch");
        assert!(!path.exists());
    }

    #[cfg(windows)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "requires exact P2-007 public WAV, pinned archive/model, and HTTPS license access"]
    async fn public_japanese_wav_traverses_actual_voice_service() {
        const OPERATION_REF: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        let wav_path = required_live_path("ORQUESTA_P2_008_JA_WAV");
        let binary_archive = required_live_path("ORQUESTA_P2_008_VOICE_BINARY_ARCHIVE");
        let small_model = required_live_path("ORQUESTA_P2_008_VOICE_SMALL_MODEL");
        let (pcm, sample_count) = reviewed_float_wav_as_pcm_s16le(&wav_path);
        let pcm_digest = pcm_sha256(&pcm);
        let pcm_prefix = hex::encode(&pcm[..pcm.len().min(64)]);

        let root = VoiceTestRoot::new();
        assert_eq!(root.0.parent(), Some(std::env::temp_dir().as_path()));
        let launcher = built_desktop_test_launcher();
        let launcher_sha256 = format!(
            "{:x}",
            Sha256::digest(fs::read(&launcher).expect("hash freshly built Desktop launcher"))
        );
        let launcher = crate::process_containment::set_test_windows_launcher_once(launcher).expect(
            "select the real Desktop executable once for this isolated live-canary process",
        );
        eprintln!(
            "containedLauncher={}; containedLauncherSha256={launcher_sha256}",
            launcher.display()
        );
        let service = VoiceService::open_with_components(root.0.clone(), Arc::new(|_, _| {}))
            .expect("open actual VoiceService in an isolated temporary root");
        assert!(service.inner.acquisition_runner.is_none());
        assert_native_pcm_stage_evidence(&service, &pcm, sample_count);
        let owner = lifecycle_owner("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 1);
        let (binary_id, model_id) = {
            let voice = service.inner.catalog.voice();
            (
                voice.binary_asset_id.clone(),
                voice.initial_model_asset_id.clone(),
            )
        };

        seed_reviewed_asset_part(&service, &binary_id, &binary_archive);
        service
            .start_asset_acquisition(&binary_id, owner.clone())
            .await
            .expect("start actual binary acquisition");
        wait_for_live_asset_install(&service, &owner, &binary_id, Duration::from_secs(90)).await;

        seed_reviewed_asset_part(&service, &model_id, &small_model);
        service
            .start_asset_acquisition(&model_id, owner.clone())
            .await
            .expect("start actual model acquisition");
        wait_for_live_asset_install(&service, &owner, &model_id, Duration::from_secs(120)).await;

        let started = service
            .start_transcription(
                OPERATION_REF,
                owner.clone(),
                VoiceComposerBinding::Launcher {
                    draft_sha256: "1".repeat(64),
                },
                pcm,
                sample_count,
            )
            .await
            .expect("start actual Native Voice Service transcription");
        assert_eq!(started.operation_ref, OPERATION_REF);
        assert!(matches!(
            started.phase,
            VoiceOperationPhase::Staging | VoiceOperationPhase::Transcribing
        ));

        let deadline = tokio::time::Instant::now() + Duration::from_secs(90);
        let mut process_identity = None;
        let terminal = loop {
            let (operation, active) = {
                let runtime = service.inner.runtime.lock().await;
                let record = runtime
                    .document
                    .operations
                    .get(OPERATION_REF)
                    .expect("durable live transcription record");
                if process_identity.is_none() {
                    if let (Some(kind), Some(id), Some(pid)) = (
                        record.containment_kind.clone(),
                        record.containment_id.clone(),
                        record.expected_pid,
                    ) {
                        process_identity = Some((kind, id, pid));
                    }
                }
                (
                    operation_status(record),
                    runtime.active_transcriptions.contains_key(OPERATION_REF),
                )
            };
            if operation.phase.is_terminal() && !active {
                break operation;
            }
            if tokio::time::Instant::now() >= deadline {
                fail_live_canary(
                    service,
                    root,
                    &owner,
                    OPERATION_REF,
                    format!(
                        "actual Native transcription exceeded its bounded test timeout; lastStatus={operation:?}"
                    ),
                    process_identity,
                )
                .await;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        };
        if terminal.phase != VoiceOperationPhase::Transcribed {
            fail_live_canary(
                service,
                root,
                &owner,
                OPERATION_REF,
                format!("actual Native transcription did not safely complete: {terminal:?}"),
                process_identity,
            )
            .await;
        }
        assert!(terminal.last_error_code.is_none());
        assert_eq!(terminal.duration_ms, 7_500);
        let transcript = terminal
            .transcript
            .as_deref()
            .expect("actual Native transcript");
        for stable_term in ["彼", "噂", "呼びました"] {
            assert!(
                transcript.contains(stable_term),
                "actual transcript omitted stable term {stable_term:?}: {transcript:?}"
            );
        }

        let public_status = service.status_for(&owner).await;
        let encoded = serde_json::to_string(&public_status).expect("serialize public voice status");
        let root_leaf = root
            .0
            .file_name()
            .and_then(|value| value.to_str())
            .expect("Unicode isolated root");
        for forbidden in [
            wav_path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap(),
            binary_archive
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap(),
            small_model
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap(),
            root_leaf,
            "input.wav",
            "pcmSha256",
            "sampleCount",
            "containmentId",
            "expectedPid",
            pcm_digest.as_str(),
            pcm_prefix.as_str(),
        ] {
            assert!(
                !encoded.contains(forbidden),
                "public Voice status leaked Native path or raw-audio evidence: {forbidden}"
            );
        }

        let paths = operation_paths(&service.inner.operations_root, OPERATION_REF)
            .expect("bounded operation paths");
        assert!(!paths.root.exists(), "raw-audio operation root was removed");
        {
            let runtime = service.inner.runtime.lock().await;
            assert!(!runtime.active_transcriptions.contains_key(OPERATION_REF));
            assert!(runtime.leases.is_empty());
            assert!(!runtime
                .transcription_recovery_required
                .contains(OPERATION_REF));
            let record = runtime
                .document
                .operations
                .get(OPERATION_REF)
                .expect("terminal operation remains pending explicit acknowledgement");
            assert!(record.containment_kind.is_none());
            assert!(record.containment_id.is_none());
            assert!(record.expected_pid.is_none());
        }

        let (containment_kind, containment_id, expected_pid) =
            process_identity.expect("actual contained whisper process identity was observed");
        assert!(
            wait_for_live_containment_gone(
                Some(&(containment_kind, containment_id, expected_pid)),
                OPERATION_REF,
                Duration::from_secs(2),
            )
            .await,
            "contained whisper process remained observable after terminal cleanup"
        );

        let acknowledged = service
            .acknowledge_transcription(OPERATION_REF, &owner)
            .await
            .expect("explicitly acknowledge safely cleaned transcript");
        assert!(acknowledged.operations.is_empty());
        tokio::time::timeout(Duration::from_secs(15), service.shutdown())
            .await
            .expect("isolated VoiceService shutdown is bounded")
            .expect("isolated VoiceService shutdown");
        assert_eq!(
            format!(
                "{:x}",
                Sha256::digest(
                    fs::read(&launcher).expect("rehash exact Desktop launcher after live canary")
                )
            ),
            launcher_sha256,
            "contained Desktop launcher changed during the live canary"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn async_lifecycle_enforces_exact_owner_retirement_shutdown_and_delete_leases() {
        let root = VoiceTestRoot::new();
        let owner = lifecycle_owner("11111111-1111-4111-8111-111111111111", 7);
        let foreign = lifecycle_owner("22222222-2222-4222-8222-222222222222", 8);
        let service = VoiceService::open_for_test(root.0.clone(), cancellation_only_runner())
            .expect("open test voice service");

        let started = service
            .start_asset_acquisition(LIFECYCLE_ASSET_ID, owner.clone())
            .await
            .expect("start acquisition");
        let operation_ref = lifecycle_asset(&started)
            .operation_ref
            .clone()
            .expect("active operation ref");
        assert_eq!(
            lifecycle_asset(&started).phase,
            VoiceAssetPhase::Downloading
        );

        let repeated = service
            .start_asset_acquisition(LIFECYCLE_ASSET_ID, owner.clone())
            .await
            .expect("same owner retry is idempotent");
        assert_eq!(
            lifecycle_asset(&repeated).operation_ref.as_deref(),
            Some(operation_ref.as_str())
        );
        assert_eq!(
            service
                .start_asset_acquisition(LIFECYCLE_ASSET_ID, foreign.clone())
                .await
                .expect_err("foreign start must not join the operation")
                .code,
            "voice_asset_busy"
        );

        let unknown_cancel = service
            .cancel_asset_acquisition("33333333-3333-4333-8333-333333333333", &owner)
            .await
            .expect("unknown exact operation is an idempotent no-op");
        assert_eq!(
            lifecycle_asset(&unknown_cancel).operation_ref.as_deref(),
            Some(operation_ref.as_str())
        );
        assert_eq!(
            service
                .cancel_asset_acquisition(&operation_ref, &foreign)
                .await
                .expect_err("foreign owner cannot cancel")
                .code,
            "voice_operation_owner_mismatch"
        );
        assert_eq!(
            service
                .delete_asset(LIFECYCLE_ASSET_ID, &foreign)
                .await
                .expect_err("foreign owner cannot delete an active transfer")
                .code,
            "voice_operation_owner_mismatch"
        );
        assert_eq!(
            service
                .delete_asset(LIFECYCLE_ASSET_ID, &owner)
                .await
                .expect_err("owner must cancel before delete")
                .code,
            "voice_asset_busy"
        );

        tokio::time::timeout(
            Duration::from_secs(2),
            service.retire_renderer_session(&foreign, None),
        )
        .await
        .expect("foreign retirement is bounded")
        .expect("foreign retirement is a no-op");
        assert_eq!(
            lifecycle_asset(&service.status().await)
                .operation_ref
                .as_deref(),
            Some(operation_ref.as_str())
        );
        tokio::time::timeout(
            Duration::from_secs(2),
            service.retire_renderer_session(&owner, None),
        )
        .await
        .expect("owner retirement reaches terminal state")
        .expect("owner retirement");
        let retired = service.status().await;
        assert_eq!(lifecycle_asset(&retired).phase, VoiceAssetPhase::Absent);
        assert!(lifecycle_asset(&retired).operation_ref.is_none());

        drop(service);
        let service = VoiceService::open_for_test(root.0.clone(), cancellation_only_runner())
            .expect("reopen test voice service");
        assert_eq!(
            lifecycle_asset(&service.status().await).phase,
            VoiceAssetPhase::Absent
        );

        {
            let mut runtime = service.inner.runtime.lock().await;
            runtime.leases.insert(LIFECYCLE_ASSET_ID.into(), 1);
        }
        assert_eq!(
            service
                .delete_asset(LIFECYCLE_ASSET_ID, &owner)
                .await
                .expect_err("active transcription lease blocks delete")
                .code,
            "voice_asset_in_use"
        );
        {
            let mut runtime = service.inner.runtime.lock().await;
            runtime.leases.remove(LIFECYCLE_ASSET_ID);
        }
        let deleted = service
            .delete_asset(LIFECYCLE_ASSET_ID, &owner)
            .await
            .expect("delete after lease release");
        assert_eq!(lifecycle_asset(&deleted).phase, VoiceAssetPhase::Absent);

        service
            .start_asset_acquisition(LIFECYCLE_ASSET_ID, owner)
            .await
            .expect("start acquisition before shutdown");
        tokio::time::timeout(Duration::from_secs(2), service.shutdown())
            .await
            .expect("shutdown reaches terminal state")
            .expect("shutdown");
        let shutdown = service.status().await;
        assert_eq!(lifecycle_asset(&shutdown).phase, VoiceAssetPhase::Absent);
        assert!(lifecycle_asset(&shutdown).operation_ref.is_none());
    }
}
