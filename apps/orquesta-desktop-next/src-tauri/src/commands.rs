use std::collections::{HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::{Mutex, OwnedMutexGuard, OwnedRwLockWriteGuard, RwLock};

use crate::attachments::{
    AttachmentDescriptor, AttachmentImportFile, AttachmentPublicRef, AttachmentStore,
};
use crate::dispatch_recovery::{
    DispatchFingerprintInput, DispatchPhase, DispatchPreparation, DispatchRecoveryStatus,
    DispatchRecoveryStore,
};
use crate::error::{AppError, AppResult};
use crate::instance_lock::InstanceLock;
use crate::paths::{measurement_project_selection, NativePaths};
use crate::projection_bridge::{
    ProjectionConversationCommandInput, ProjectionHistoryIndexCommandInput,
    ProjectionHistoryPageCommandInput,
};
use crate::projection_service::{
    ApprovalResponseClaimResult, ProjectionConversationInput, ProjectionConversationSnapshot,
    ProjectionHistoryIndexPage, ProjectionHistoryPage, ProjectionService, TurnMutationClaimResult,
    TurnMutationKind,
};
use crate::protocol::{
    MutationKind, ProjectRequirement, RecoveryStrategy, RuntimeMethodPolicyDocument,
    NATIVE_BRIDGE_SCHEMA_VERSION,
};
use crate::registry::{
    ProjectRecord, ProjectRegistry, ProjectionInitializationState, StarterRecoverySummary,
};
use crate::settings::{NativeSettings, SettingsStore, SettingsUpdate};
use crate::sidecar::{
    dispatch_error_with_status, DispatchAttemptKind, RuntimeAuthority, RuntimePhase,
    RuntimeStartResult, RuntimeStatus, SidecarSupervisor,
};
use crate::starter_creation::{
    create_or_reconcile_starter_project, reconcile_starter_creations_on_open, StarterProjectInput,
};
use crate::storage::{atomic_write_json, load_primary_or_backup, materialize_sentinel};
use crate::validation::{bounded_id, bounded_text, canonical_uuid};
use crate::voice::{
    validate_pcm_transport, VoiceComposerBinding, VoiceOperationStatus, VoiceService,
    VoiceSessionOwner, VoiceStatus,
};

#[derive(Debug, Clone, Copy)]
pub struct BridgeSchemaVersion;

#[derive(Debug, Clone)]
pub struct BridgeInput<T> {
    // Deserialization validates this marker before constructing BridgeInput.
    // The product path intentionally carries no second numeric version state.
    pub _schema_version: BridgeSchemaVersion,
    pub value: T,
}

impl<T> Serialize for BridgeInput<T>
where
    T: Serialize,
{
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let raw = serde_json::to_value(&self.value).map_err(serde::ser::Error::custom)?;
        let mut object = raw.as_object().cloned().ok_or_else(|| {
            serde::ser::Error::custom("native bridge value must serialize as an object")
        })?;
        object.insert(
            "schemaVersion".into(),
            Value::from(NATIVE_BRIDGE_SCHEMA_VERSION),
        );
        Value::Object(object).serialize(serializer)
    }
}

impl<'de, T> Deserialize<'de> for BridgeInput<T>
where
    T: serde::de::DeserializeOwned,
{
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let raw = Value::deserialize(deserializer)?;
        let mut object = raw
            .as_object()
            .cloned()
            .ok_or_else(|| serde::de::Error::custom("native bridge input must be an object"))?;
        let version = object
            .remove("schemaVersion")
            .and_then(|value| value.as_u64())
            .ok_or_else(|| {
                serde::de::Error::custom("native bridge input requires integer schemaVersion")
            })?;
        if version != u64::from(NATIVE_BRIDGE_SCHEMA_VERSION) {
            return Err(serde::de::Error::custom(format!(
                "unsupported native bridge schemaVersion: {version}"
            )));
        }
        let value =
            serde_json::from_value(Value::Object(object)).map_err(serde::de::Error::custom)?;
        Ok(Self {
            _schema_version: BridgeSchemaVersion,
            value,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BridgeResponse<T> {
    pub schema_version: u32,
    pub result: T,
}

impl<T> BridgeResponse<T> {
    fn new(result: T) -> Self {
        Self {
            schema_version: NATIVE_BRIDGE_SCHEMA_VERSION,
            result,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum SessionPhase {
    Active,
    Closing,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RendererSession {
    session_id: String,
    generation: u64,
    window_label: String,
    predecessor_id: Option<String>,
    phase: SessionPhase,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RendererSessionRegistryDocument {
    schema_version: u32,
    current: Option<RendererSession>,
    pending_open: Option<RendererSession>,
    recovery_predecessor: Option<RendererSession>,
    retired_order: VecDeque<String>,
    next_generation: u64,
}

impl Default for RendererSessionRegistryDocument {
    fn default() -> Self {
        Self {
            schema_version: 1,
            current: None,
            pending_open: None,
            recovery_predecessor: None,
            retired_order: VecDeque::new(),
            next_generation: 0,
        }
    }
}

#[derive(Debug, Clone)]
struct RendererSessionRegistry {
    state_path: PathBuf,
    current: Option<RendererSession>,
    pending_open: Option<RendererSession>,
    recovery_predecessor: Option<RendererSession>,
    retired_order: VecDeque<String>,
    retired: HashSet<String>,
    next_generation: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum RendererCancelTransition {
    Resolved {
        cancelled: bool,
    },
    Closing {
        session: RendererSession,
        authority: Option<RuntimeAuthority>,
    },
}

const MAX_RETIRED_RENDERER_SESSIONS: usize = 1024;

impl RendererSessionRegistry {
    fn open(state_path: PathBuf) -> AppResult<Self> {
        materialize_sentinel(&state_path, &RendererSessionRegistryDocument::default())?;
        let document: RendererSessionRegistryDocument =
            load_primary_or_backup(&state_path, "renderer_session_identity_uncertain")?;
        if document.schema_version != 1 {
            return Err(AppError::new(
                "renderer_session_schema_unsupported",
                "Renderer session authority was written by a newer Desktop Next",
            ));
        }
        if document.retired_order.len() > MAX_RETIRED_RENDERER_SESSIONS {
            return Err(AppError::new(
                "renderer_session_history_invalid",
                "Renderer session history exceeds its bounded capacity",
            )
            .outcome_unknown(true));
        }
        let retired = document
            .retired_order
            .iter()
            .cloned()
            .collect::<HashSet<_>>();
        if retired.len() != document.retired_order.len() {
            return Err(AppError::new(
                "renderer_session_history_invalid",
                "Renderer session history contains duplicate identities",
            )
            .outcome_unknown(true));
        }
        for session_id in &document.retired_order {
            canonical_uuid(session_id, "retiredRendererSessionId")?;
        }
        for session in [
            document.current.as_ref(),
            document.pending_open.as_ref(),
            document.recovery_predecessor.as_ref(),
        ]
        .into_iter()
        .flatten()
        {
            canonical_uuid(&session.session_id, "rendererSessionId")?;
            if let Some(predecessor_id) = session.predecessor_id.as_deref() {
                canonical_uuid(predecessor_id, "expectedPreviousSessionId")?;
            }
            if session.generation == 0
                || session.generation > document.next_generation
                || session.window_label.is_empty()
                || session.window_label.len() > 128
            {
                return Err(AppError::new(
                    "renderer_session_identity_invalid",
                    "Persisted renderer session metadata is invalid",
                )
                .outcome_unknown(true));
            }
        }
        if document
            .current
            .as_ref()
            .is_some_and(|session| retired.contains(&session.session_id))
            || document
                .pending_open
                .as_ref()
                .is_some_and(|session| retired.contains(&session.session_id))
        {
            return Err(AppError::new(
                "renderer_session_identity_invalid",
                "An active or pending renderer session is already retired",
            )
            .outcome_unknown(true));
        }
        if document.current.is_some() && document.recovery_predecessor.is_some() {
            return Err(AppError::new(
                "renderer_session_identity_invalid",
                "Renderer session authority has two simultaneous predecessors",
            )
            .outcome_unknown(true));
        }
        if let Some(pending) = document.pending_open.as_ref() {
            let trusted = document
                .current
                .as_ref()
                .or(document.recovery_predecessor.as_ref());
            if pending.predecessor_id.as_deref() != trusted.map(|value| value.session_id.as_str()) {
                return Err(AppError::new(
                    "renderer_session_identity_invalid",
                    "Pending renderer admission lost its exact native predecessor",
                )
                .outcome_unknown(true));
            }
        }
        Ok(Self {
            state_path,
            current: document.current,
            pending_open: document.pending_open,
            recovery_predecessor: document.recovery_predecessor,
            retired_order: document.retired_order,
            retired,
            next_generation: document.next_generation,
        })
    }

    fn document(&self) -> RendererSessionRegistryDocument {
        RendererSessionRegistryDocument {
            schema_version: 1,
            current: self.current.clone(),
            pending_open: self.pending_open.clone(),
            recovery_predecessor: self.recovery_predecessor.clone(),
            retired_order: self.retired_order.clone(),
            next_generation: self.next_generation,
        }
    }

    fn persist(&self) -> AppResult<()> {
        atomic_write_json(&self.state_path, &self.document())
    }

    fn transact<T>(&mut self, update: impl FnOnce(&mut Self) -> AppResult<T>) -> AppResult<T> {
        let previous = self.clone();
        let value = match update(self) {
            Ok(value) => value,
            Err(error) => {
                *self = previous;
                return Err(error);
            }
        };
        if let Err(error) = self.persist() {
            *self = previous;
            return Err(error);
        }
        Ok(value)
    }

    fn trusted_predecessor(&self) -> Option<&RendererSession> {
        self.current.as_ref().or(self.recovery_predecessor.as_ref())
    }

    fn recovery_previous_session_id(&self) -> Option<&str> {
        self.trusted_predecessor()
            .map(|session| session.session_id.as_str())
    }

    fn begin_cancel(
        &mut self,
        proposed: &str,
        expected_generation: Option<u64>,
        window_label: &str,
        runtime_authority: Option<&RuntimeAuthority>,
    ) -> AppResult<RendererCancelTransition> {
        if self.retired.contains(proposed)
            || self
                .pending_open
                .as_ref()
                .is_some_and(|pending| pending.session_id == proposed)
        {
            return Ok(RendererCancelTransition::Resolved { cancelled: false });
        }
        let Some(current) = self.current.clone() else {
            self.transact(|sessions| sessions.retire(proposed.to_owned()))?;
            return Ok(RendererCancelTransition::Resolved { cancelled: true });
        };
        if current.session_id != proposed {
            self.transact(|sessions| sessions.retire(proposed.to_owned()))?;
            return Ok(RendererCancelTransition::Resolved { cancelled: false });
        }
        if current.window_label != window_label
            || expected_generation.is_some_and(|value| value != current.generation)
            || runtime_authority.is_some_and(|value| {
                value.renderer_session_id != proposed
                    || value.renderer_generation != current.generation
                    || value.window_label != window_label
            })
        {
            return Ok(RendererCancelTransition::Resolved { cancelled: false });
        }
        let admitted = current.clone();
        self.transact(|sessions| {
            let current = sessions.current.as_mut().ok_or_else(|| {
                AppError::new(
                    "renderer_session_identity_uncertain",
                    "Renderer session disappeared before close admission",
                )
                .outcome_unknown(true)
            })?;
            if current.session_id != admitted.session_id
                || current.generation != admitted.generation
                || current.window_label != admitted.window_label
            {
                return Err(AppError::new(
                    "renderer_session_identity_uncertain",
                    "Renderer session changed before close admission",
                )
                .outcome_unknown(true));
            }
            current.phase = SessionPhase::Closing;
            Ok(())
        })?;
        Ok(RendererCancelTransition::Closing {
            session: admitted,
            authority: runtime_authority.cloned(),
        })
    }

    fn retire(&mut self, session_id: String) -> AppResult<()> {
        if self.retired.contains(&session_id) {
            return Ok(());
        }
        // A delayed open still carries its original predecessor and is rejected
        // by the durable current/recovery CAS. Therefore old tombstones may be
        // compacted once they are no longer referenced by any live Native
        // authority tuple. Ownership in Voice/attachments also includes the
        // monotonic generation, so reusing an ancient UUID cannot adopt data.
        while self.retired_order.len() >= MAX_RETIRED_RENDERER_SESSIONS {
            let protected = |candidate: &String| {
                self.current
                    .as_ref()
                    .is_some_and(|value| &value.session_id == candidate)
                    || self
                        .pending_open
                        .as_ref()
                        .is_some_and(|value| &value.session_id == candidate)
                    || self
                        .recovery_predecessor
                        .as_ref()
                        .is_some_and(|value| &value.session_id == candidate)
            };
            let position = self
                .retired_order
                .iter()
                .position(|candidate| !protected(candidate))
                .ok_or_else(|| {
                    AppError::new(
                        "renderer_session_history_invalid",
                        "Renderer session tombstones contain no compactable entry",
                    )
                    .outcome_unknown(true)
                })?;
            let removed = self
                .retired_order
                .remove(position)
                .expect("located retired renderer tombstone remains present");
            self.retired.remove(&removed);
        }
        self.retired.insert(session_id.clone());
        self.retired_order.push_back(session_id);
        Ok(())
    }
}

pub struct NativeState {
    pub paths: NativePaths,
    projection: crate::projection_service::ProjectionService,
    pub registry: Arc<Mutex<ProjectRegistry>>,
    settings: Arc<Mutex<SettingsStore>>,
    pub runtime: SidecarSupervisor,
    pub voice: VoiceService,
    pub attachments: Arc<Mutex<AttachmentStore>>,
    pub dispatch_recovery: Arc<Mutex<DispatchRecoveryStore>>,
    method_policy: RuntimeMethodPolicyDocument,
    renderer_sessions: Arc<Mutex<RendererSessionRegistry>>,
    pub runtime_operation_lock: Arc<RwLock<()>>,
    runtime_mutation_lock: Arc<Mutex<()>>,
    dispatch_state_lock: Arc<Mutex<()>>,
    attachment_selection_lock: Arc<Mutex<()>>,
    project_creation_lock: Arc<Mutex<()>>,
    pub exit_lifecycle_state: Arc<AtomicU8>,
    _instance_lock: InstanceLock,
}

struct RuntimeTransactionLease {
    operation: Option<OwnedRwLockWriteGuard<()>>,
    runtime: SidecarSupervisor,
    attachments: Arc<Mutex<AttachmentStore>>,
    recovery: Arc<Mutex<DispatchRecoveryStore>>,
    runtime_generation: String,
    started_here: bool,
    committed_authority: Option<RuntimeAuthority>,
    armed: bool,
}

impl RuntimeTransactionLease {
    fn new(
        operation: OwnedRwLockWriteGuard<()>,
        runtime: SidecarSupervisor,
        attachments: Arc<Mutex<AttachmentStore>>,
        recovery: Arc<Mutex<DispatchRecoveryStore>>,
        started: &RuntimeStartResult,
    ) -> Self {
        Self {
            operation: Some(operation),
            runtime,
            attachments,
            recovery,
            runtime_generation: started.runtime_generation.clone(),
            started_here: started.started_here,
            committed_authority: None,
            armed: true,
        }
    }

    fn authority_committed(&mut self, authority: RuntimeAuthority) {
        self.committed_authority = Some(authority);
    }

    fn disarm(&mut self) {
        self.armed = false;
        self.operation.take();
    }

    async fn rollback(&mut self) -> AppResult<()> {
        if !self.armed {
            return Ok(());
        }
        rollback_runtime_transaction(
            &self.runtime,
            &self.attachments,
            &self.recovery,
            &self.runtime_generation,
            self.started_here,
            self.committed_authority.as_ref(),
        )
        .await?;
        self.disarm();
        Ok(())
    }
}

impl Drop for RuntimeTransactionLease {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let operation = self.operation.take();
        let runtime = self.runtime.clone();
        let attachments = self.attachments.clone();
        let recovery = self.recovery.clone();
        let runtime_generation = self.runtime_generation.clone();
        let started_here = self.started_here;
        let authority = self.committed_authority.clone();
        tauri::async_runtime::spawn(async move {
            // Keep lifecycle admission serialized through panic/cancellation cleanup.
            let _operation = operation;
            let _ = rollback_runtime_transaction(
                &runtime,
                &attachments,
                &recovery,
                &runtime_generation,
                started_here,
                authority.as_ref(),
            )
            .await;
        });
    }
}

async fn rollback_runtime_transaction(
    runtime: &SidecarSupervisor,
    attachments: &Arc<Mutex<AttachmentStore>>,
    recovery: &Arc<Mutex<DispatchRecoveryStore>>,
    runtime_generation: &str,
    started_here: bool,
    committed_authority: Option<&RuntimeAuthority>,
) -> AppResult<()> {
    let outcome = if let Some(authority) = committed_authority {
        let first = runtime
            .stop_if_matches(Some(authority), Some(runtime_generation))
            .await?;
        if !first.0
            && first.1.runtime_generation.as_deref() == Some(runtime_generation)
            && runtime.authority().await.is_none()
        {
            Some(
                runtime
                    .stop_unowned_generation_exact(runtime_generation)
                    .await?,
            )
        } else {
            Some(first)
        }
    } else if started_here {
        Some(
            runtime
                .stop_unowned_generation_exact(runtime_generation)
                .await?,
        )
    } else {
        None
    };
    if let Some((_stopped, status)) = outcome {
        if is_exact_confirmed_stop(&status, runtime_generation) {
            cleanup_after_stop_parts(
                attachments,
                recovery,
                committed_authority.map(|authority| authority.project_id.as_str()),
            )
            .await?;
        }
    }
    Ok(())
}

fn is_exact_confirmed_stop(status: &RuntimeStatus, runtime_generation: &str) -> bool {
    status.phase == RuntimePhase::Stopped
        && status.runtime_generation.as_deref() == Some(runtime_generation)
        && status.process_termination_confirmed
}

fn prepare_registered_project_projection_sync(
    registry: &mut ProjectRegistry,
    projection: &ProjectionService,
    project_id: &str,
) -> AppResult<ProjectRecord> {
    let record = registry.verify(project_id)?;
    match registry.projection_initialization_state(project_id)? {
        ProjectionInitializationState::Pending => {
            projection.initialize_project(project_id)?;
            registry.mark_projection_ready(project_id)
        }
        ProjectionInitializationState::Ready => {
            projection.require_existing_project(project_id)?;
            Ok(record)
        }
    }
}

fn resume_pending_projection_initializations(
    registry: &mut ProjectRegistry,
    projection: &ProjectionService,
) -> AppResult<()> {
    for project_id in registry.pending_projection_project_ids()? {
        prepare_registered_project_projection_sync(registry, projection, &project_id)?;
    }
    Ok(())
}

impl NativeState {
    pub fn open(app: &AppHandle) -> AppResult<Self> {
        crate::protocol::validate_native_bridge_contract()?;
        let paths = NativePaths::resolve(app)?;
        let instance_lock = InstanceLock::acquire(&paths.state)?;
        paths.prepare_attachment_authority(&instance_lock)?;
        paths.prepare_voice_authority(&instance_lock)?;
        paths.ensure()?;
        let dispatch_recovery = DispatchRecoveryStore::open(paths.dispatch_recovery())?;
        let private_recoveries = dispatch_recovery.all_private();
        let attachments = AttachmentStore::open_with_recoveries(
            paths.attachments.clone(),
            paths.attachment_selections(),
            paths.attachment_quarantine(),
            &private_recoveries,
        )?;
        // Legacy Roaming attachment bytes are retained until the Local authority
        // has opened and validated every durable selection/quarantine record.
        paths.finalize_attachment_migration(&instance_lock)?;
        let settings = SettingsStore::open(paths.settings())?;
        let projection = crate::projection_service::ProjectionService::open(&paths)?;
        let voice = VoiceService::open(app.clone(), paths.voice_data_root.clone())?;
        let renderer_sessions = RendererSessionRegistry::open(paths.renderer_sessions())?;
        let mut registry = ProjectRegistry::open(paths.registry())?;
        reconcile_starter_creations_on_open(&mut registry)?;
        resume_pending_projection_initializations(&mut registry, &projection)?;
        let attachments = Arc::new(Mutex::new(attachments));
        let dispatch_recovery = Arc::new(Mutex::new(dispatch_recovery));
        let dispatch_state_lock = Arc::new(Mutex::new(()));
        Ok(Self {
            registry: Arc::new(Mutex::new(registry)),
            settings: Arc::new(Mutex::new(settings)),
            runtime: SidecarSupervisor::new(
                app.clone(),
                paths.runtime_dist.clone(),
                paths.projection_data_root.clone(),
                paths.runtime_owner(),
                projection.clone(),
                attachments.clone(),
                dispatch_recovery.clone(),
                dispatch_state_lock.clone(),
            )?,
            voice,
            projection,
            attachments,
            dispatch_recovery,
            method_policy: RuntimeMethodPolicyDocument::load()?,
            renderer_sessions: Arc::new(Mutex::new(renderer_sessions)),
            runtime_operation_lock: Arc::new(RwLock::new(())),
            runtime_mutation_lock: Arc::new(Mutex::new(())),
            dispatch_state_lock,
            attachment_selection_lock: Arc::new(Mutex::new(())),
            project_creation_lock: Arc::new(Mutex::new(())),
            exit_lifecycle_state: Arc::new(AtomicU8::new(0)),
            _instance_lock: instance_lock,
            paths,
        })
    }

    fn admit_commands(&self) -> AppResult<()> {
        if self.exit_lifecycle_state.load(Ordering::Acquire) != 0 {
            return Err(AppError::new(
                "desktop_shutdown_in_progress",
                "Desktop shutdown has closed command admission",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RendererSessionOpenInput {
    pub renderer_session_id: String,
    pub expected_previous_session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RendererSessionCancelInput {
    pub renderer_session_id: String,
    pub renderer_generation: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionInput {
    pub renderer_session_id: String,
    pub renderer_generation: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VoiceAssetInput {
    pub renderer_session_id: String,
    pub renderer_generation: u64,
    pub asset_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VoiceOperationInput {
    pub renderer_session_id: String,
    pub renderer_generation: u64,
    pub operation_ref: String,
}

#[derive(Debug, Clone)]
struct VoiceRawPcmInput {
    renderer_session_id: String,
    renderer_generation: u64,
    operation_ref: String,
    sample_count: u32,
    composer_binding: VoiceComposerBinding,
    runtime_authority: Option<AuthorityInput>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityInput {
    pub renderer_session_id: String,
    pub renderer_generation: u64,
    pub project_id: String,
    pub activation_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RendererSessionOpenResult {
    pub renderer_session_id: String,
    pub renderer_generation: u64,
    pub window_label: String,
    pub runtime_authority: Option<RuntimeAuthority>,
    pub runtime_status: RuntimeStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RendererSessionCancelResult {
    pub cancelled: bool,
    pub runtime_status: RuntimeStatus,
}

async fn current_session_guard(
    state: &NativeState,
    window: &WebviewWindow,
    input: &SessionInput,
) -> AppResult<OwnedMutexGuard<RendererSessionRegistry>> {
    state.admit_commands()?;
    canonical_uuid(&input.renderer_session_id, "rendererSessionId")?;
    let guard = state.renderer_sessions.clone().lock_owned().await;
    let current = guard.current.as_ref().ok_or_else(|| {
        AppError::new(
            "renderer_session_not_open",
            "Open a renderer session before invoking native mutations",
        )
    })?;
    if current.phase != SessionPhase::Active
        || current.session_id != input.renderer_session_id
        || current.generation != input.renderer_generation
        || current.window_label != window.label()
    {
        return Err(AppError::new(
            "renderer_session_stale",
            "Renderer session is stale, closing, or bound to another WebView",
        ));
    }
    Ok(guard)
}

fn voice_owner(input: &SessionInput, window: &WebviewWindow) -> VoiceSessionOwner {
    VoiceSessionOwner::new(
        input.renderer_session_id.clone(),
        input.renderer_generation,
        window.label().to_owned(),
    )
}

#[tauri::command]
pub async fn voice_status(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: BridgeInput<SessionInput>,
) -> AppResult<BridgeResponse<VoiceStatus>> {
    let _operation = state.runtime_operation_lock.read().await;
    let _session = current_session_guard(&state, &window, &input.value).await?;
    let owner = voice_owner(&input.value, &window);
    Ok(BridgeResponse::new(state.voice.status_for(&owner).await))
}

#[tauri::command]
pub async fn voice_asset_acquire(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: BridgeInput<VoiceAssetInput>,
) -> AppResult<BridgeResponse<VoiceStatus>> {
    let _operation = state.runtime_operation_lock.read().await;
    let session_input = SessionInput {
        renderer_session_id: input.value.renderer_session_id.clone(),
        renderer_generation: input.value.renderer_generation,
    };
    let _session = current_session_guard(&state, &window, &session_input).await?;
    let owner = voice_owner(&session_input, &window);
    Ok(BridgeResponse::new(
        state
            .voice
            .start_asset_acquisition(&input.value.asset_id, owner)
            .await?,
    ))
}

#[tauri::command]
pub async fn voice_asset_acquire_cancel(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: BridgeInput<VoiceOperationInput>,
) -> AppResult<BridgeResponse<VoiceStatus>> {
    let _operation = state.runtime_operation_lock.read().await;
    let session_input = SessionInput {
        renderer_session_id: input.value.renderer_session_id.clone(),
        renderer_generation: input.value.renderer_generation,
    };
    let _session = current_session_guard(&state, &window, &session_input).await?;
    let operation_ref = canonical_uuid(&input.value.operation_ref, "operationRef")?;
    let owner = voice_owner(&session_input, &window);
    Ok(BridgeResponse::new(
        state
            .voice
            .cancel_asset_acquisition(&operation_ref, &owner)
            .await?,
    ))
}

#[tauri::command]
pub async fn voice_asset_delete(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: BridgeInput<VoiceAssetInput>,
) -> AppResult<BridgeResponse<VoiceStatus>> {
    let _operation = state.runtime_operation_lock.read().await;
    let session_input = SessionInput {
        renderer_session_id: input.value.renderer_session_id.clone(),
        renderer_generation: input.value.renderer_generation,
    };
    let _session = current_session_guard(&state, &window, &session_input).await?;
    let owner = voice_owner(&session_input, &window);
    Ok(BridgeResponse::new(
        state
            .voice
            .delete_asset(&input.value.asset_id, &owner)
            .await?,
    ))
}

#[tauri::command]
pub async fn voice_transcribe_pcm(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    request: Request<'_>,
) -> AppResult<BridgeResponse<VoiceOperationStatus>> {
    let _operation = state.runtime_operation_lock.read().await;
    let metadata = parse_voice_raw_headers(request.headers())?;
    let pcm = raw_voice_body(request.body())?;
    validate_pcm_transport(pcm, metadata.sample_count)?;
    let session_input = SessionInput {
        renderer_session_id: metadata.renderer_session_id.clone(),
        renderer_generation: metadata.renderer_generation,
    };
    let _session = current_session_guard(&state, &window, &session_input).await?;
    if let Some(authority) = metadata.runtime_authority.as_ref() {
        require_authority(&state.runtime, authority, &window).await?;
    } else if state.runtime.authority().await.is_some() {
        return Err(AppError::new(
            "voice_composer_binding_mismatch",
            "Launcher voice input cannot be claimed while a project runtime is active",
        ));
    }
    let operation_ref = canonical_uuid(&metadata.operation_ref, "operationRef")?;
    let owner = voice_owner(&session_input, &window);
    Ok(BridgeResponse::new(
        state
            .voice
            .start_transcription(
                &operation_ref,
                owner,
                metadata.composer_binding,
                pcm.to_vec(),
                metadata.sample_count,
            )
            .await?,
    ))
}

#[tauri::command]
pub async fn voice_transcription_cancel(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: BridgeInput<VoiceOperationInput>,
) -> AppResult<BridgeResponse<VoiceStatus>> {
    let _operation = state.runtime_operation_lock.read().await;
    let session_input = SessionInput {
        renderer_session_id: input.value.renderer_session_id.clone(),
        renderer_generation: input.value.renderer_generation,
    };
    let _session = current_session_guard(&state, &window, &session_input).await?;
    let operation_ref = canonical_uuid(&input.value.operation_ref, "operationRef")?;
    let owner = voice_owner(&session_input, &window);
    Ok(BridgeResponse::new(
        state
            .voice
            .cancel_transcription(&operation_ref, &owner)
            .await?,
    ))
}

#[tauri::command]
pub async fn voice_transcription_ack(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: BridgeInput<VoiceOperationInput>,
) -> AppResult<BridgeResponse<VoiceStatus>> {
    let _operation = state.runtime_operation_lock.read().await;
    let session_input = SessionInput {
        renderer_session_id: input.value.renderer_session_id.clone(),
        renderer_generation: input.value.renderer_generation,
    };
    let _session = current_session_guard(&state, &window, &session_input).await?;
    let operation_ref = canonical_uuid(&input.value.operation_ref, "operationRef")?;
    let owner = voice_owner(&session_input, &window);
    Ok(BridgeResponse::new(
        state
            .voice
            .acknowledge_transcription(&operation_ref, &owner)
            .await?,
    ))
}

async fn require_authority(
    runtime: &SidecarSupervisor,
    input: &AuthorityInput,
    window: &WebviewWindow,
) -> AppResult<RuntimeAuthority> {
    bounded_id(&input.project_id, "projectId")?;
    canonical_uuid(&input.activation_token, "activationToken")?;
    let authority = runtime.authority().await.ok_or_else(|| {
        AppError::new(
            "runtime_authority_not_active",
            "Runtime has no writable project authority",
        )
    })?;
    if authority.project_id != input.project_id
        || authority.activation_token != input.activation_token
        || authority.renderer_session_id != input.renderer_session_id
        || authority.renderer_generation != input.renderer_generation
        || authority.window_label != window.label()
    {
        return Err(AppError::new("runtime_authority_mismatch", "Runtime authority belongs to another project, activation, renderer generation, or WebView"));
    }
    Ok(authority)
}

fn recovery_strategy_name(value: RecoveryStrategy) -> &'static str {
    match value {
        RecoveryStrategy::None => "none",
        RecoveryStrategy::NativeLifecycle => "native_lifecycle",
        RecoveryStrategy::DispatchOutbox => "dispatch_outbox",
        RecoveryStrategy::NativeExactApproval => "native_exact_approval",
        RecoveryStrategy::CoreInspectionOperation => "core_inspection_operation",
        RecoveryStrategy::ProjectBootstrapSaga => "project_bootstrap_saga",
        RecoveryStrategy::ProjectionInternal => "projection_internal",
        RecoveryStrategy::ExactTurnInterrupt => "exact_turn_interrupt",
        RecoveryStrategy::ExactTurnSteer => "exact_turn_steer",
        RecoveryStrategy::InternalUnavailable => "internal_unavailable",
    }
}

async fn reverify_runtime_project_authority(
    registry: &Arc<Mutex<ProjectRegistry>>,
    authority: &RuntimeAuthority,
    requirement: ProjectRequirement,
    params: &Value,
    expected: Option<&ProjectRecord>,
) -> AppResult<Option<ProjectRecord>> {
    if requirement == ProjectRequirement::None {
        return Ok(None);
    }
    if params
        .get("projectId")
        .and_then(Value::as_str)
        .is_some_and(|value| value != authority.project_id)
    {
        return Err(AppError::new(
            "runtime_project_mismatch",
            "Runtime params projectId does not match native authority",
        ));
    }
    let project = registry.lock().await.verify(&authority.project_id)?;
    if let Some(expected) = expected {
        if project.project_id != expected.project_id
            || project.root_path != expected.root_path
            || project.root_identity != expected.root_identity
            || project.root_identity_v2 != expected.root_identity_v2
        {
            return Err(AppError::new(
                "runtime_root_authority_mismatch",
                "Registered project root changed during the runtime call",
            ));
        }
    }
    if requirement == ProjectRequirement::InternalRoot && params.get("rootPath").is_some() {
        return Err(AppError::new(
            "runtime_renderer_root_forbidden",
            "rootPath for this method is supplied only by native project authority",
        ));
    }
    Ok(Some(project))
}

fn core_method_requires_selected_root(method: &str) -> bool {
    matches!(
        method,
        "runtime.conversation"
            | "runtime.dispatch.reconcile"
            | "inspection.start"
            | "inspection.cancel"
            | "workflow.catalog.read"
            | "workflow.definition.save"
            | "workflow.batch.start"
            | "workflow.batch.cancel"
            | "workflow.result.read"
    )
}

fn inject_selected_project_root(
    method: &str,
    params: &mut Value,
    selected_root: Option<&str>,
) -> AppResult<()> {
    if !core_method_requires_selected_root(method) {
        return Ok(());
    }
    let root = selected_root.ok_or_else(|| {
        AppError::new(
            "runtime_root_authority_missing",
            "Selected project authority is required for this runtime method",
        )
    })?;
    params
        .as_object_mut()
        .ok_or_else(|| {
            AppError::new(
                "runtime_request_params_invalid",
                "Runtime params must be an object",
            )
        })?
        .insert("rootPath".into(), Value::String(root.to_owned()));
    Ok(())
}

fn verify_runtime_compare(
    status: RuntimeStatus,
    expected_status_revision: u64,
    expected_runtime_generation: Option<&str>,
) -> AppResult<RuntimeStatus> {
    let generation_matches = expected_runtime_generation.map_or(true, |expected| {
        status.runtime_generation.as_deref() == Some(expected)
    });
    if status.status_revision != expected_status_revision || !generation_matches {
        return Err(AppError::new(
            "runtime_compare_failed",
            "Runtime status revision or exact generation changed before native admission",
        )
        .retryable(true)
        .with_details(serde_json::json!({ "currentStatus": status })));
    }
    Ok(status)
}

async fn require_runtime_compare(
    runtime: &SidecarSupervisor,
    expected_status_revision: u64,
    expected_runtime_generation: Option<&str>,
) -> AppResult<RuntimeStatus> {
    verify_runtime_compare(
        runtime.status().await,
        expected_status_revision,
        expected_runtime_generation,
    )
}

#[tauri::command]
pub async fn renderer_session_open(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: BridgeInput<RendererSessionOpenInput>,
) -> AppResult<BridgeResponse<RendererSessionOpenResult>> {
    Ok(BridgeResponse::new(
        renderer_session_open_impl(window, state, input.value).await?,
    ))
}

async fn renderer_session_open_impl(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: RendererSessionOpenInput,
) -> AppResult<RendererSessionOpenResult> {
    state.admit_commands()?;
    let proposed = canonical_uuid(&input.renderer_session_id, "rendererSessionId")?;
    let expected = input
        .expected_previous_session_id
        .as_deref()
        .map(|value| canonical_uuid(value, "expectedPreviousSessionId"))
        .transpose()?;
    let _operation = state.runtime_operation_lock.read().await;
    let mut sessions = state.renderer_sessions.lock().await;
    if let Some(pending) = sessions.pending_open.as_ref() {
        if pending.session_id != proposed
            || pending.predecessor_id != expected
            || pending.window_label != window.label()
        {
            return Err(AppError::new(
                "renderer_session_recovery_required",
                "Resume the exact native-owned renderer admission before opening another session",
            )
            .outcome_unknown(true)
            .with_details(serde_json::json!({
                "recoveryRendererSessionId": pending.session_id,
                "recoveryPreviousSessionId": pending.predecessor_id,
            })));
        }
    }
    if sessions.retired.contains(&proposed) {
        let recovery_previous_session_id =
            sessions.recovery_previous_session_id().map(str::to_owned);
        return Err(AppError::new(
            "renderer_session_retired",
            "A retired or cancelled renderer session cannot be reopened",
        )
        .with_details(serde_json::json!({
            "recoveryPreviousSessionId": recovery_previous_session_id
        })));
    }
    if let Some(current) = &sessions.current {
        if current.session_id == proposed {
            if current.phase != SessionPhase::Active {
                return Err(AppError::new(
                    "renderer_session_retired",
                    "A closing renderer session cannot be reopened",
                )
                .with_details(serde_json::json!({
                    "recoveryPreviousSessionId": current.session_id
                })));
            }
            if current.window_label != window.label() || current.predecessor_id != expected {
                return Err(AppError::new(
                    "renderer_session_binding_mismatch",
                    "Idempotent session retry did not match its original WebView/CAS tuple",
                ));
            }
            return Ok(RendererSessionOpenResult {
                renderer_session_id: proposed,
                renderer_generation: current.generation,
                window_label: current.window_label.clone(),
                runtime_authority: state.runtime.authority().await,
                runtime_status: state.runtime.status().await,
            });
        }
    }

    if sessions.pending_open.is_none() {
        let trusted_previous = sessions
            .trusted_predecessor()
            .map(|session| session.session_id.as_str());
        if expected.as_deref() != trusted_previous {
            return Err(AppError::new(
                "renderer_session_compare_failed",
                "Renderer session changed before this open request reached native admission",
            )
            .with_details(serde_json::json!({
                "recoveryPreviousSessionId": trusted_previous,
            })));
        }
        let generation = sessions.next_generation.checked_add(1).ok_or_else(|| {
            AppError::new(
                "renderer_session_generation_exhausted",
                "Renderer session generation exhausted; restart Desktop Next",
            )
        })?;
        let pending = RendererSession {
            session_id: proposed.clone(),
            generation,
            window_label: window.label().into(),
            predecessor_id: expected.clone(),
            phase: SessionPhase::Active,
        };
        sessions.transact(|sessions| {
            sessions.next_generation = generation;
            sessions.pending_open = Some(pending);
            Ok(())
        })?;
    }

    let pending = sessions
        .pending_open
        .clone()
        .expect("exact pending renderer admission was established");
    let generation = pending.generation;
    let previous = sessions.trusted_predecessor().cloned();
    if let Some(previous) = &previous {
        if state
            .runtime
            .authority()
            .await
            .as_ref()
            .is_some_and(|authority| {
                authority.renderer_session_id != previous.session_id
                    && (authority.renderer_session_id != proposed
                        || authority.renderer_generation != generation
                        || authority.window_label != window.label())
            })
        {
            return Err(AppError::new(
                "runtime_authority_adoption_mismatch",
                "Runtime authority is not owned by the renderer session being replaced",
            )
            .outcome_unknown(true));
        }
        // Retiring a renderer is a native transaction.  Persist cleanup_pending
        // before adoption so a failed file deletion cannot leave hidden drafts
        // owned by a session the renderer can no longer name.
        state
            .voice
            .retire_renderer_session(
                &VoiceSessionOwner::new(
                    previous.session_id.clone(),
                    previous.generation,
                    previous.window_label.clone(),
                ),
                Some(&VoiceSessionOwner::new(
                    proposed.clone(),
                    generation,
                    window.label().to_owned(),
                )),
            )
            .await?;
        state.attachments.lock().await.retire_renderer_session(
            &previous.session_id,
            previous.generation,
            &previous.window_label,
        )?;
        state
            .runtime
            .adopt_authority_renderer(&previous.session_id, &proposed, generation, window.label())
            .await?;
    }
    sessions.transact(|sessions| {
        let pending = sessions.pending_open.take().ok_or_else(|| {
            AppError::new(
                "renderer_session_identity_uncertain",
                "Pending renderer admission disappeared before native commit",
            )
            .outcome_unknown(true)
        })?;
        if pending.session_id != proposed
            || pending.generation != generation
            || pending.predecessor_id != expected
            || pending.window_label != window.label()
        {
            return Err(AppError::new(
                "renderer_session_identity_uncertain",
                "Pending renderer admission changed before native commit",
            )
            .outcome_unknown(true));
        }
        if let Some(previous) = previous.as_ref() {
            sessions.retire(previous.session_id.clone())?;
        }
        sessions.current = Some(pending);
        sessions.recovery_predecessor = None;
        Ok(())
    })?;
    Ok(RendererSessionOpenResult {
        renderer_session_id: proposed,
        renderer_generation: generation,
        window_label: window.label().into(),
        runtime_authority: state.runtime.authority().await,
        runtime_status: state.runtime.status().await,
    })
}

#[tauri::command]
pub async fn renderer_session_cancel(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: BridgeInput<RendererSessionCancelInput>,
) -> AppResult<BridgeResponse<RendererSessionCancelResult>> {
    Ok(BridgeResponse::new(
        renderer_session_cancel_impl(window, state, input.value).await?,
    ))
}

async fn renderer_session_cancel_impl(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: RendererSessionCancelInput,
) -> AppResult<RendererSessionCancelResult> {
    let proposed = canonical_uuid(&input.renderer_session_id, "rendererSessionId")?;
    let _operation = state.runtime_operation_lock.write().await;
    let runtime_authority = state.runtime.authority().await;
    let observed_status = state.runtime.status().await;
    let (authority, observed_status) = {
        let mut sessions = state.renderer_sessions.lock().await;
        match sessions.begin_cancel(
            &proposed,
            input.renderer_generation,
            window.label(),
            runtime_authority.as_ref(),
        )? {
            RendererCancelTransition::Resolved { cancelled } => {
                return Ok(RendererSessionCancelResult {
                    cancelled,
                    runtime_status: observed_status,
                });
            }
            RendererCancelTransition::Closing { session, authority } => {
                debug_assert_eq!(session.session_id, proposed);
                (authority, observed_status)
            }
        }
    };
    let expected_generation = observed_status.runtime_generation.clone();
    let observed_project_id = observed_status.active_project_id.clone();
    let stop_status = if let Some(authority) = authority.as_ref() {
        let first = state
            .runtime
            .stop_if_matches(Some(authority), expected_generation.as_deref())
            .await?;
        if !first.0
            && first.1.runtime_generation.as_deref() == expected_generation.as_deref()
            && state.runtime.authority().await.is_none()
        {
            if let Some(generation) = expected_generation.as_deref() {
                state
                    .runtime
                    .stop_unowned_generation_exact(generation)
                    .await?
                    .1
            } else {
                first.1
            }
        } else {
            first.1
        }
    } else {
        if let Some(generation) = expected_generation
            .as_deref()
            .filter(|_| observed_status.phase != RuntimePhase::Stopped)
        {
            let (_, status) = state
                .runtime
                .stop_unowned_generation_exact(generation)
                .await?;
            status
        } else {
            observed_status
        }
    };
    if stop_status.phase != RuntimePhase::Stopped || !stop_status.process_termination_confirmed {
        // Keep the session Closing.  A repeated cancel resumes the same exact
        // stop/cleanup transaction instead of deleting renderer drafts while a
        // process tree may still hold their paths.
        return Err(AppError::new(
            "renderer_session_close_unconfirmed",
            "Renderer session cannot retire until runtime process-tree termination is confirmed",
        )
        .outcome_unknown(true)
        .with_details(serde_json::json!({ "runtimeGeneration": expected_generation })));
    }
    // Also resumes cleanup when an earlier close stopped the process but its
    // attachment commit failed before the renderer session could retire.
    let current = state.renderer_sessions.lock().await.current.clone();
    if let Some(current) = current
        .as_ref()
        .filter(|value| value.session_id == proposed && value.phase == SessionPhase::Closing)
    {
        state
            .voice
            .retire_renderer_session(
                &VoiceSessionOwner::new(
                    current.session_id.clone(),
                    current.generation,
                    current.window_label.clone(),
                ),
                None,
            )
            .await?;
    }
    let stopped_project_id = authority
        .as_ref()
        .map(|value| value.project_id.as_str())
        .or(observed_project_id.as_deref());
    cleanup_after_stop_parts(
        &state.attachments,
        &state.dispatch_recovery,
        stopped_project_id,
    )
    .await?;
    if let Some(current) = current
        .as_ref()
        .filter(|value| value.session_id == proposed && value.phase == SessionPhase::Closing)
    {
        state.attachments.lock().await.retire_renderer_session(
            &current.session_id,
            current.generation,
            &current.window_label,
        )?;
    }
    let mut sessions = state.renderer_sessions.lock().await;
    if sessions.current.as_ref().is_some_and(|current| {
        current.session_id == proposed && current.phase == SessionPhase::Closing
    }) {
        sessions.transact(|sessions| {
            let current = sessions.current.take().ok_or_else(|| {
                AppError::new(
                    "renderer_session_identity_uncertain",
                    "Closing renderer session disappeared before retirement commit",
                )
                .outcome_unknown(true)
            })?;
            sessions.retire(current.session_id.clone())?;
            sessions.recovery_predecessor = Some(current);
            Ok(())
        })?;
    }
    Ok(RendererSessionCancelResult {
        cancelled: true,
        runtime_status: state.runtime.status().await,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingAttachmentSelection {
    pub selection_id: String,
    pub attachments: Vec<AttachmentDescriptor>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeBootstrap {
    pub renderer_session_id: String,
    pub renderer_generation: u64,
    pub settings: NativeSettings,
    pub projects: Vec<ProjectRecord>,
    pub starter_creation_recoveries: Vec<StarterRecoverySummary>,
    pub selected_project_id: Option<String>,
    pub runtime: RuntimeStatus,
    pub runtime_authority: Option<RuntimeAuthority>,
    pub dispatch_recovery: Option<DispatchRecoveryStatus>,
    pub pending_attachment_selections: Vec<PendingAttachmentSelection>,
    pub runtime_transition_in_progress: bool,
}

#[tauri::command]
pub async fn native_bootstrap(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: BridgeInput<SessionInput>,
) -> AppResult<BridgeResponse<NativeBootstrap>> {
    Ok(BridgeResponse::new(
        native_bootstrap_impl(window, state, input.value).await?,
    ))
}

async fn native_bootstrap_impl(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: SessionInput,
) -> AppResult<NativeBootstrap> {
    state.admit_commands()?;
    let operation = state.runtime_operation_lock.clone().try_read_owned();
    let transition = operation.is_err();
    let _dispatch = state.dispatch_state_lock.lock().await;
    let session = current_session_guard(&state, &window, &input).await?;
    let current = session
        .current
        .as_ref()
        .expect("validated current session")
        .clone();
    // Restart recovery reuses the same durable SQLite exact-turn query as the
    // post-Accepted race closure. The dispatch lock remains held while the
    // Sidecar owner releases the recovery mutex around the SQLite read.
    if let Err(error) = state
        .runtime
        .reconcile_attachment_terminal_from_projection_under_dispatch(None)
        .await
    {
        return Err(dispatch_error_with_status(error, None));
    }
    let registry = state.registry.lock().await;
    let registry_snapshot = registry.checked_snapshot()?;
    let pending = state
        .attachments
        .lock()
        .await
        .pending_for_session(
            &current.session_id,
            current.generation,
            &current.window_label,
        )
        .into_iter()
        .map(|(selection_id, attachments)| PendingAttachmentSelection {
            selection_id,
            attachments,
        })
        .collect();
    let runtime = state.runtime.status().await;
    let runtime_authority = state.runtime.authority().await;
    let recovery_project_id = runtime_authority
        .as_ref()
        .map(|authority| authority.project_id.as_str())
        .or(registry_snapshot.selected_project_id.as_deref());
    let dispatch_recovery = if let Some(project_id) = recovery_project_id {
        state
            .dispatch_recovery
            .lock()
            .await
            .status_for_project(project_id)
    } else {
        None
    };
    Ok(NativeBootstrap {
        renderer_session_id: current.session_id,
        renderer_generation: current.generation,
        settings: state.settings.lock().await.current(),
        projects: registry_snapshot.projects,
        starter_creation_recoveries: registry_snapshot.starter_creation_recoveries,
        selected_project_id: registry_snapshot.selected_project_id,
        runtime,
        runtime_authority,
        dispatch_recovery,
        pending_attachment_selections: pending,
        runtime_transition_in_progress: transition,
    })
}

#[tauri::command]
pub async fn runtime_session_reconcile(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: BridgeInput<SessionInput>,
) -> AppResult<BridgeResponse<NativeBootstrap>> {
    Ok(BridgeResponse::new(
        runtime_session_reconcile_impl(window, state, input.value).await?,
    ))
}

async fn runtime_session_reconcile_impl(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: SessionInput,
) -> AppResult<NativeBootstrap> {
    state.admit_commands()?;
    let _operation = state.runtime_operation_lock.read().await;
    let _dispatch = state.dispatch_state_lock.lock().await;
    let session = current_session_guard(&state, &window, &input).await?;
    let current = session
        .current
        .as_ref()
        .expect("validated current session")
        .clone();
    if let Err(error) = state
        .runtime
        .reconcile_attachment_terminal_from_projection_under_dispatch(None)
        .await
    {
        return Err(dispatch_error_with_status(error, None));
    }
    let registry = state.registry.lock().await;
    let registry_snapshot = registry.checked_snapshot()?;
    let pending = state
        .attachments
        .lock()
        .await
        .pending_for_session(
            &current.session_id,
            current.generation,
            &current.window_label,
        )
        .into_iter()
        .map(|(selection_id, attachments)| PendingAttachmentSelection {
            selection_id,
            attachments,
        })
        .collect();
    let runtime = state.runtime.status().await;
    let runtime_authority = state.runtime.authority().await;
    let recovery_project_id = runtime_authority
        .as_ref()
        .map(|authority| authority.project_id.as_str())
        .or(registry_snapshot.selected_project_id.as_deref());
    let dispatch_recovery = if let Some(project_id) = recovery_project_id {
        state
            .dispatch_recovery
            .lock()
            .await
            .status_for_project(project_id)
    } else {
        None
    };
    Ok(NativeBootstrap {
        renderer_session_id: current.session_id,
        renderer_generation: current.generation,
        settings: state.settings.lock().await.current(),
        projects: registry_snapshot.projects,
        starter_creation_recoveries: registry_snapshot.starter_creation_recoveries,
        selected_project_id: registry_snapshot.selected_project_id,
        runtime,
        runtime_authority,
        dispatch_recovery,
        pending_attachment_selections: pending,
        runtime_transition_in_progress: false,
    })
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsUpdateInput {
    pub renderer_session_id: String,
    pub renderer_generation: u64,
    pub expected_revision: u64,
    pub locale: String,
    pub theme: String,
    pub reduced_motion: bool,
    pub notifications_enabled: bool,
}

#[tauri::command]
pub async fn settings_update(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: BridgeInput<SettingsUpdateInput>,
) -> AppResult<BridgeResponse<NativeSettings>> {
    let input = input.value;
    let _operation = state.runtime_operation_lock.read().await;
    let session_input = SessionInput {
        renderer_session_id: input.renderer_session_id,
        renderer_generation: input.renderer_generation,
    };
    let _session = current_session_guard(&state, &window, &session_input).await?;
    let saved = state.settings.lock().await.update(SettingsUpdate {
        expected_revision: input.expected_revision,
        locale: input.locale,
        theme: input.theme,
        reduced_motion: input.reduced_motion,
        notifications_enabled: input.notifications_enabled,
    })?;
    Ok(BridgeResponse::new(saved))
}

#[tauri::command]
pub async fn projects_list(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: BridgeInput<SessionInput>,
) -> AppResult<BridgeResponse<Vec<ProjectRecord>>> {
    Ok(BridgeResponse::new(
        projects_list_impl(window, state, input.value).await?,
    ))
}

async fn projects_list_impl(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: SessionInput,
) -> AppResult<Vec<ProjectRecord>> {
    let _operation = state.runtime_operation_lock.read().await;
    let _session = current_session_guard(&state, &window, &input).await?;
    Ok(state.registry.lock().await.checked_snapshot()?.projects)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectRecentForgetInput {
    pub renderer_session_id: String,
    pub renderer_generation: u64,
    pub project_id: String,
}

fn ensure_recent_project_is_inactive(
    active_project_id: Option<&str>,
    target_project_id: &str,
) -> AppResult<()> {
    if active_project_id == Some(target_project_id) {
        return Err(AppError::new(
            "project_recent_forget_active",
            "Stop the active project before removing it from the recent-project list",
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn project_recent_forget(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: BridgeInput<ProjectRecentForgetInput>,
) -> AppResult<BridgeResponse<Vec<ProjectRecord>>> {
    state.admit_commands()?;
    let input = input.value;
    let _operation = state.runtime_operation_lock.write().await;
    let session_input = SessionInput {
        renderer_session_id: input.renderer_session_id,
        renderer_generation: input.renderer_generation,
    };
    let _session = current_session_guard(&state, &window, &session_input).await?;
    let status = state.runtime.status().await;
    ensure_recent_project_is_inactive(status.active_project_id.as_deref(), &input.project_id)?;
    let projects = state
        .registry
        .lock()
        .await
        .hide_from_recent(&input.project_id)?;
    Ok(BridgeResponse::new(projects))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectLastWorkAgentInput {
    pub renderer_session_id: String,
    pub renderer_generation: u64,
    pub project_id: String,
    pub activation_token: String,
    pub target_agent_id: String,
}

#[tauri::command]
pub async fn project_last_work_agent_set(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: BridgeInput<ProjectLastWorkAgentInput>,
) -> AppResult<BridgeResponse<ProjectRecord>> {
    let input = input.value;
    let _operation = state.runtime_operation_lock.read().await;
    let session_input = SessionInput {
        renderer_session_id: input.renderer_session_id.clone(),
        renderer_generation: input.renderer_generation,
    };
    let _session = current_session_guard(&state, &window, &session_input).await?;
    let authority = state.runtime.authority().await.ok_or_else(|| {
        AppError::new(
            "runtime_authority_missing",
            "Last WORK agent can only be recorded for the active project",
        )
    })?;
    if authority.project_id != input.project_id
        || authority.activation_token != input.activation_token
        || authority.renderer_session_id != input.renderer_session_id
        || authority.renderer_generation != input.renderer_generation
    {
        return Err(AppError::new(
            "runtime_authority_mismatch",
            "Last WORK agent belongs to another runtime authority",
        ));
    }
    let record = state
        .registry
        .lock()
        .await
        .set_last_work_agent(&input.project_id, &input.target_agent_id)?;
    Ok(BridgeResponse::new(record))
}

async fn project_open_folder_read_only(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: SessionInput,
) -> AppResult<Option<ProjectRecord>> {
    {
        let _operation = state.runtime_operation_lock.read().await;
        let _session = current_session_guard(&state, &window, &input).await?;
    }
    let path = if let Some(path) = measurement_project_selection()? {
        path
    } else {
        let chosen = window.app_handle().dialog().file().blocking_pick_folder();
        let Some(chosen) = chosen else {
            return Ok(None);
        };
        chosen
            .into_path()
            .map_err(|error| AppError::new("project_path_invalid", error.to_string()))?
    };
    let root = path
        .to_str()
        .ok_or_else(|| AppError::new("project_path_not_utf8", "Project path is not valid UTF-8"))?
        .to_owned();
    let _operation = state.runtime_operation_lock.write().await;
    let _session = current_session_guard(&state, &window, &input).await?;
    let record = {
        let mut registry = state.registry.lock().await;
        registry.register_read_only_named(&root, None)?
    };
    let record = prepare_registered_project_projection(
        state.registry.clone(),
        state.projection.clone(),
        record.project_id,
    )
    .await?;
    Ok(Some(record))
}

#[tauri::command]
pub async fn project_open_folder(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: BridgeInput<SessionInput>,
) -> AppResult<BridgeResponse<Option<ProjectRecord>>> {
    let value = project_open_folder_read_only(window, state, input.value).await?;
    Ok(BridgeResponse::new(value))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectCreateStarterInput {
    pub renderer_session_id: String,
    pub renderer_generation: u64,
    pub operation_ref: String,
    pub project_name: String,
}

async fn serialize_project_creation<T>(
    lock: &Mutex<()>,
    operation: impl std::future::Future<Output = T>,
) -> T {
    let _creation = lock.lock().await;
    operation.await
}

#[tauri::command]
pub async fn project_create_starter(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: BridgeInput<ProjectCreateStarterInput>,
) -> AppResult<BridgeResponse<Option<ProjectRecord>>> {
    state.admit_commands()?;
    serialize_project_creation(&state.project_creation_lock, async {
        let input = input.value;
        let session = SessionInput {
            renderer_session_id: input.renderer_session_id.clone(),
            renderer_generation: input.renderer_generation,
        };
        {
            let _operation = state.runtime_operation_lock.read().await;
            let _session = current_session_guard(&state, &window, &session).await?;
        }
        let starter_input = StarterProjectInput {
            operation_ref: input.operation_ref,
            project_name: input.project_name,
        };
        let committed = {
            let mut registry = state.registry.lock().await;
            match create_or_reconcile_starter_project(&mut registry, None, starter_input.clone()) {
                Ok(record) => Some(record),
                Err(error) if error.code == "project_creation_parent_required" => None,
                Err(error) => return Err(error),
            }
        };
        if let Some(record) = committed {
            let record = prepare_registered_project_projection(
                state.registry.clone(),
                state.projection.clone(),
                record.project_id,
            )
            .await?;
            return Ok(BridgeResponse::new(Some(record)));
        }
        let parent = if let Some(path) = measurement_project_selection()? {
            path
        } else {
            let chosen = window.app_handle().dialog().file().blocking_pick_folder();
            let Some(chosen) = chosen else {
                return Ok(BridgeResponse::new(None));
            };
            chosen
                .into_path()
                .map_err(|error| AppError::new("project_path_invalid", error.to_string()))?
        };
        let _operation = state.runtime_operation_lock.write().await;
        let _session = current_session_guard(&state, &window, &session).await?;
        let record = {
            let mut registry = state.registry.lock().await;
            create_or_reconcile_starter_project(&mut registry, Some(parent), starter_input)?
        };
        let record = prepare_registered_project_projection(
            state.registry.clone(),
            state.projection.clone(),
            record.project_id,
        )
        .await?;
        Ok(BridgeResponse::new(Some(record)))
    })
    .await
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachmentSelectionInput {
    pub renderer_session_id: String,
    pub renderer_generation: u64,
    pub selection_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachmentImportBeginInput {
    pub renderer_session_id: String,
    pub renderer_generation: u64,
    pub selection_id: String,
    pub files: Vec<AttachmentImportFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachmentImportFinishInput {
    pub renderer_session_id: String,
    pub renderer_generation: u64,
    pub selection_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentImportResult {
    pub selection_id: String,
    pub file_count: usize,
    pub staged_count: usize,
    pub attachments: Vec<AttachmentDescriptor>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentImportStageResult {
    pub selection_id: String,
    pub slot_id: String,
    pub staged: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachmentPreviewInput {
    pub renderer_session_id: String,
    pub renderer_generation: u64,
    pub selection_id: String,
    pub public_id: String,
}

#[derive(Debug, Clone)]
struct AttachmentRawStageInput {
    renderer_session_id: String,
    renderer_generation: u64,
    selection_id: String,
    slot_id: String,
}

fn attachment_import_result(
    selection_id: String,
    status: crate::attachments::AttachmentImportStatus,
) -> AttachmentImportResult {
    AttachmentImportResult {
        selection_id,
        file_count: status.file_count,
        staged_count: status.staged_count,
        attachments: status.attachments,
    }
}

fn exact_raw_header(
    headers: &tauri::http::HeaderMap,
    name: &'static str,
    error_code: &'static str,
    context: &'static str,
) -> AppResult<String> {
    let mut values = headers.get_all(name).iter();
    let value = values
        .next()
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty());
    if value.is_none() || values.next().is_some() {
        return Err(AppError::new(
            error_code,
            format!("{context} requires exactly one {name} metadata value"),
        ));
    }
    Ok(value
        .expect("one non-empty header value was validated")
        .to_owned())
}

fn parse_attachment_raw_headers(
    headers: &tauri::http::HeaderMap,
) -> AppResult<AttachmentRawStageInput> {
    const ALLOWED: [&str; 5] = [
        "x-orquesta-schema-version",
        "x-orquesta-renderer-session-id",
        "x-orquesta-renderer-generation",
        "x-orquesta-selection-id",
        "x-orquesta-slot-id",
    ];
    if headers.keys().any(|name| {
        let value = name.as_str();
        value.starts_with("x-orquesta-") && !ALLOWED.contains(&value)
    }) {
        return Err(AppError::new(
            "attachment_import_header_unknown",
            "Raw attachment import contains an unknown Orquesta authority header",
        ));
    }
    let header = |name| {
        exact_raw_header(
            headers,
            name,
            "attachment_import_header_invalid",
            "Raw attachment import",
        )
    };
    if header(ALLOWED[0])? != NATIVE_BRIDGE_SCHEMA_VERSION.to_string() {
        return Err(AppError::new(
            "attachment_import_schema_unsupported",
            "Raw attachment import schema version is unsupported",
        ));
    }
    let renderer_generation = header(ALLOWED[2])?
        .parse::<u64>()
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| {
            AppError::new(
                "attachment_import_header_invalid",
                "Raw attachment renderer generation must be a positive integer",
            )
        })?;
    Ok(AttachmentRawStageInput {
        renderer_session_id: header(ALLOWED[1])?,
        renderer_generation,
        selection_id: header(ALLOWED[3])?,
        slot_id: header(ALLOWED[4])?,
    })
}

fn parse_voice_raw_headers(headers: &tauri::http::HeaderMap) -> AppResult<VoiceRawPcmInput> {
    const ALLOWED: [&str; 13] = [
        "x-orquesta-schema-version",
        "x-orquesta-renderer-session-id",
        "x-orquesta-renderer-generation",
        "x-orquesta-operation-ref",
        "x-orquesta-sample-rate-hz",
        "x-orquesta-channel-count",
        "x-orquesta-sample-format",
        "x-orquesta-sample-count",
        "x-orquesta-composer-target",
        "x-orquesta-composer-draft-sha256",
        "x-orquesta-composer-project-id",
        "x-orquesta-composer-agent-id",
        "x-orquesta-runtime-activation-token",
    ];
    if headers.keys().any(|name| {
        let value = name.as_str();
        value.starts_with("x-orquesta-") && !ALLOWED.contains(&value)
    }) {
        return Err(AppError::new(
            "voice_pcm_header_unknown",
            "Raw voice PCM contains an unknown Orquesta authority header",
        ));
    }
    let header =
        |name| exact_raw_header(headers, name, "voice_pcm_header_invalid", "Raw voice PCM");
    if header(ALLOWED[0])? != NATIVE_BRIDGE_SCHEMA_VERSION.to_string() {
        return Err(AppError::new(
            "voice_pcm_schema_unsupported",
            "Raw voice PCM schema version is unsupported",
        ));
    }
    let renderer_generation = header(ALLOWED[2])?
        .parse::<u64>()
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| {
            AppError::new(
                "voice_pcm_header_invalid",
                "Raw voice renderer generation must be a positive integer",
            )
        })?;
    if header(ALLOWED[4])? != "16000"
        || header(ALLOWED[5])? != "1"
        || header(ALLOWED[6])? != "pcm-s16le"
    {
        return Err(AppError::new(
            "voice_pcm_format_unsupported",
            "Raw voice PCM must be 16 kHz mono signed 16-bit little-endian",
        ));
    }
    let sample_count = header(ALLOWED[7])?.parse::<u32>().map_err(|_| {
        AppError::new(
            "voice_pcm_header_invalid",
            "Raw voice sample count must be an unsigned integer",
        )
    })?;
    let draft_sha256 = header(ALLOWED[9])?;
    if draft_sha256.len() != 64
        || !draft_sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(AppError::new(
            "voice_composer_binding_invalid",
            "Voice Composer draft SHA-256 must be lowercase hexadecimal",
        ));
    }
    let renderer_session_id = header(ALLOWED[1])?;
    let (composer_binding, runtime_authority) = match header(ALLOWED[8])?.as_str() {
        "agent" => {
            let project_id = bounded_id(&header(ALLOWED[10])?, "projectId")?;
            let agent_id = bounded_id(&header(ALLOWED[11])?, "agentId")?;
            let activation_token = canonical_uuid(&header(ALLOWED[12])?, "activationToken")?;
            (
                VoiceComposerBinding::Agent {
                    project_id: project_id.clone(),
                    agent_id,
                    draft_sha256,
                },
                Some(AuthorityInput {
                    renderer_session_id: renderer_session_id.clone(),
                    renderer_generation,
                    project_id,
                    activation_token,
                }),
            )
        }
        "launcher" => {
            if [ALLOWED[10], ALLOWED[11], ALLOWED[12]]
                .iter()
                .any(|name| headers.contains_key(*name))
            {
                return Err(AppError::new(
                    "voice_composer_binding_invalid",
                    "Launcher voice input cannot carry project, agent, or activation authority",
                ));
            }
            (VoiceComposerBinding::Launcher { draft_sha256 }, None)
        }
        _ => {
            return Err(AppError::new(
                "voice_composer_binding_invalid",
                "Voice Composer target must be agent or launcher",
            ));
        }
    };
    Ok(VoiceRawPcmInput {
        renderer_session_id,
        renderer_generation,
        operation_ref: header(ALLOWED[3])?,
        sample_count,
        composer_binding,
        runtime_authority,
    })
}

fn raw_attachment_body(body: &InvokeBody) -> AppResult<&[u8]> {
    match body {
        InvokeBody::Raw(bytes) => Ok(bytes),
        InvokeBody::Json(_) => Err(AppError::new(
            "attachment_import_raw_required",
            "Attachment bytes must use the raw octet-stream bridge",
        )),
    }
}

fn raw_voice_body(body: &InvokeBody) -> AppResult<&[u8]> {
    match body {
        InvokeBody::Raw(bytes) => Ok(bytes),
        InvokeBody::Json(_) => Err(AppError::new(
            "voice_pcm_raw_required",
            "Voice PCM must use the raw octet-stream bridge",
        )),
    }
}

#[tauri::command]
pub async fn attachment_import_begin(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: BridgeInput<AttachmentImportBeginInput>,
) -> AppResult<BridgeResponse<AttachmentImportResult>> {
    let _operation = state.runtime_operation_lock.read().await;
    let session = SessionInput {
        renderer_session_id: input.value.renderer_session_id.clone(),
        renderer_generation: input.value.renderer_generation,
    };
    let _session = current_session_guard(&state, &window, &session).await?;
    let _selection = state.attachment_selection_lock.lock().await;
    let status = state.attachments.lock().await.begin_import_selection(
        &input.value.selection_id,
        &input.value.renderer_session_id,
        input.value.renderer_generation,
        window.label(),
        &input.value.files,
    )?;
    Ok(BridgeResponse::new(attachment_import_result(
        input.value.selection_id,
        status,
    )))
}

#[tauri::command]
pub async fn attachment_import_stage(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    request: Request<'_>,
) -> AppResult<BridgeResponse<AttachmentImportStageResult>> {
    let metadata = parse_attachment_raw_headers(request.headers())?;
    let bytes = raw_attachment_body(request.body())?;
    let _operation = state.runtime_operation_lock.read().await;
    let session = SessionInput {
        renderer_session_id: metadata.renderer_session_id.clone(),
        renderer_generation: metadata.renderer_generation,
    };
    let _session = current_session_guard(&state, &window, &session).await?;
    let _selection = state.attachment_selection_lock.lock().await;
    state.attachments.lock().await.stage_import_slot(
        &metadata.selection_id,
        &metadata.slot_id,
        &metadata.renderer_session_id,
        metadata.renderer_generation,
        window.label(),
        bytes,
    )?;
    Ok(BridgeResponse::new(AttachmentImportStageResult {
        selection_id: metadata.selection_id,
        slot_id: metadata.slot_id,
        staged: true,
    }))
}

#[tauri::command]
pub async fn attachment_import_finish(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: BridgeInput<AttachmentImportFinishInput>,
) -> AppResult<BridgeResponse<AttachmentImportResult>> {
    let _operation = state.runtime_operation_lock.read().await;
    let session = SessionInput {
        renderer_session_id: input.value.renderer_session_id.clone(),
        renderer_generation: input.value.renderer_generation,
    };
    let _session = current_session_guard(&state, &window, &session).await?;
    let _selection = state.attachment_selection_lock.lock().await;
    let status = state.attachments.lock().await.finish_import_selection(
        &input.value.selection_id,
        &input.value.renderer_session_id,
        input.value.renderer_generation,
        window.label(),
    )?;
    Ok(BridgeResponse::new(attachment_import_result(
        input.value.selection_id,
        status,
    )))
}

#[tauri::command]
pub async fn attachment_preview_read(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: BridgeInput<AttachmentPreviewInput>,
) -> AppResult<Response> {
    let _operation = state.runtime_operation_lock.read().await;
    let session = SessionInput {
        renderer_session_id: input.value.renderer_session_id.clone(),
        renderer_generation: input.value.renderer_generation,
    };
    let _session = current_session_guard(&state, &window, &session).await?;
    let bytes = state.attachments.lock().await.read_preview(
        &input.value.selection_id,
        &input.value.public_id,
        &input.value.renderer_session_id,
        input.value.renderer_generation,
        window.label(),
    )?;
    Ok(Response::new(bytes))
}

#[tauri::command]
pub async fn attachment_selection_cancel(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: BridgeInput<AttachmentSelectionInput>,
) -> AppResult<BridgeResponse<()>> {
    Ok(BridgeResponse::new(
        attachment_selection_cancel_impl(window, state, input.value).await?,
    ))
}

async fn attachment_selection_cancel_impl(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: AttachmentSelectionInput,
) -> AppResult<()> {
    let _operation = state.runtime_operation_lock.read().await;
    // Cancellation itself may tombstone a never-open id; stale/foreign current
    // sessions are not allowed to mutate another session's existing batch.
    let session = SessionInput {
        renderer_session_id: input.renderer_session_id,
        renderer_generation: input.renderer_generation,
    };
    let _session = current_session_guard(&state, &window, &session).await?;
    let _selection = state.attachment_selection_lock.lock().await;
    state
        .attachments
        .lock()
        .await
        .cancel_selection(&input.selection_id)
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachmentForgetInput {
    pub renderer_session_id: String,
    pub renderer_generation: u64,
    pub selection_id: String,
    pub public_id: String,
}

#[tauri::command]
pub async fn attachment_forget(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: BridgeInput<AttachmentForgetInput>,
) -> AppResult<BridgeResponse<()>> {
    Ok(BridgeResponse::new(
        attachment_forget_impl(window, state, input.value).await?,
    ))
}

async fn attachment_forget_impl(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: AttachmentForgetInput,
) -> AppResult<()> {
    let _operation = state.runtime_operation_lock.read().await;
    let session = SessionInput {
        renderer_session_id: input.renderer_session_id.clone(),
        renderer_generation: input.renderer_generation,
    };
    let _session = current_session_guard(&state, &window, &session).await?;
    let _selection = state.attachment_selection_lock.lock().await;
    state.attachments.lock().await.forget_draft(
        &input.public_id,
        &input.selection_id,
        &input.renderer_session_id,
        input.renderer_generation,
        window.label(),
    )
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeStopInput {
    pub renderer_session_id: String,
    pub renderer_generation: u64,
    pub expected_status_revision: u64,
    pub project_id: String,
    pub activation_token: String,
    pub runtime_generation: String,
}

#[tauri::command]
pub async fn runtime_stop(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: BridgeInput<RuntimeStopInput>,
) -> AppResult<BridgeResponse<RuntimeStatus>> {
    Ok(BridgeResponse::new(
        runtime_stop_impl(window, state, input.value).await?,
    ))
}

async fn runtime_stop_impl(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: RuntimeStopInput,
) -> AppResult<RuntimeStatus> {
    let operation = state.runtime_operation_lock.clone().write_owned().await;
    let session_input = SessionInput {
        renderer_session_id: input.renderer_session_id.clone(),
        renderer_generation: input.renderer_generation,
    };
    let session = current_session_guard(&state, &window, &session_input).await?;
    bounded_id(&input.project_id, "projectId")?;
    canonical_uuid(&input.activation_token, "activationToken")?;
    require_runtime_compare(
        &state.runtime,
        input.expected_status_revision,
        Some(&input.runtime_generation),
    )
    .await?;
    let current_authority = state.runtime.authority().await;
    if let Some(authority) = &current_authority {
        if input.project_id != authority.project_id
            || input.activation_token != authority.activation_token
            || authority.renderer_session_id != input.renderer_session_id
            || authority.renderer_generation != input.renderer_generation
            || authority.window_label != window.label()
        {
            return Err(AppError::new(
                "runtime_authority_mismatch",
                "Current authority must authorize runtime stop",
            ));
        }
    }
    // Faulted runtime with authority=None accepts the caller's stale exact
    // project/token tuple so recovery Stop remains idempotent.
    drop(session);
    let runtime = state.runtime.clone();
    let attachments = state.attachments.clone();
    let recovery = state.dispatch_recovery.clone();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let _operation = operation;
        let result = if let Some(authority) = current_authority.as_ref() {
            runtime
                .stop_if_matches(Some(authority), Some(&input.runtime_generation))
                .await
                .map(|(_, status)| status)
        } else {
            runtime
                .stop_generation_exact(&input.runtime_generation)
                .await
        };
        let result = match result {
            Ok(status) if is_exact_confirmed_stop(&status, &input.runtime_generation) => {
                cleanup_after_stop_parts(&attachments, &recovery, Some(&input.project_id))
                    .await
                    .map(|_| status)
            }
            Ok(status) => Ok(status),
            Err(error) => Err(error),
        };
        let _ = sender.send(result);
    });
    receiver.await.map_err(|_| {
        AppError::new(
            "runtime_stop_result_lost",
            "Native runtime stop task ended without a result",
        )
        .outcome_unknown(true)
    })?
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectActivateInput {
    pub renderer_session_id: String,
    pub renderer_generation: u64,
    pub expected_status_revision: u64,
    pub project_id: String,
    pub activation_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectActivationResult {
    pub project: ProjectRecord,
    pub activation_token: String,
    pub runtime: RuntimeStatus,
    pub snapshot: Value,
}

#[tauri::command]
pub async fn project_activate_runtime(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: BridgeInput<ProjectActivateInput>,
) -> AppResult<BridgeResponse<ProjectActivationResult>> {
    let value = project_activate_runtime_impl(window, state, input.value).await?;
    Ok(BridgeResponse::new(value))
}

async fn project_activate_runtime_impl(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: ProjectActivateInput,
) -> AppResult<ProjectActivationResult> {
    let operation = state.runtime_operation_lock.clone().write_owned().await;
    let session_input = SessionInput {
        renderer_session_id: input.renderer_session_id.clone(),
        renderer_generation: input.renderer_generation,
    };
    let session = current_session_guard(&state, &window, &session_input).await?;
    require_runtime_compare(&state.runtime, input.expected_status_revision, None).await?;
    let activation_token = canonical_uuid(&input.activation_token, "activationToken")?;
    bounded_id(&input.project_id, "projectId")?;
    if let Some(authority) = state.runtime.authority().await {
        if authority.project_id != input.project_id {
            return Err(AppError::new(
                "runtime_cross_project_activation_blocked",
                "Confirmed process-tree stop is required before activating another project",
            ));
        }
        if authority.renderer_session_id == input.renderer_session_id
            && authority.renderer_generation == input.renderer_generation
            && authority.activation_token == activation_token
        {
            let project = state.registry.lock().await.verify(&input.project_id)?;
            let require_projection = state.projection.clone();
            let require_project_id = project.project_id.clone();
            tauri::async_runtime::spawn_blocking(move || {
                require_projection.require_existing_project(&require_project_id)
            })
            .await
            .map_err(|error| AppError::new("projection_worker_failed", error.to_string()))??;
            let refresh_runtime = state.runtime.clone();
            let refresh_projection = state.projection.clone();
            let refresh_project_id = project.project_id.clone();
            let refresh_root_path = project.root_path.clone();
            tokio::spawn(async move {
                let binding = match refresh_runtime
                    .capture_projection_authority(None, &refresh_project_id)
                    .await
                {
                    Ok(binding) => binding,
                    Err(_) => return,
                };
                let notify_runtime = refresh_runtime.clone();
                if let Err(error) = crate::projection_bridge::refresh_provider_projection(
                    refresh_runtime,
                    refresh_projection,
                    refresh_project_id,
                    refresh_root_path,
                    &binding,
                )
                .await
                {
                    let _ = notify_runtime.emit_projection_fault(&binding, &error).await;
                }
            });
            return Ok(ProjectActivationResult {
                project,
                activation_token,
                runtime: state.runtime.status().await,
                snapshot: state
                    .runtime
                    .call("repository.get-snapshot", serde_json::json!({}), 30_000)
                    .await?,
            });
        }
        return Err(AppError::new(
            "runtime_activation_conflict",
            "An existing writer must be stopped before replacing its activation authority",
        ));
    }
    let project = state.registry.lock().await.verify(&input.project_id)?;
    let require_projection = state.projection.clone();
    let require_project_id = project.project_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        require_projection.require_existing_project(&require_project_id)
    })
    .await
    .map_err(|error| AppError::new("projection_worker_failed", error.to_string()))??;
    let window_label = window.label().to_owned();
    drop(session);
    let runtime = state.runtime.clone();
    let projection = state.projection.clone();
    let registry = state.registry.clone();
    let attachments = state.attachments.clone();
    let recovery = state.dispatch_recovery.clone();
    let attachment_sealed_root = state
        .paths
        .attachments
        .to_str()
        .ok_or_else(|| {
            AppError::new(
                "attachment_root_invalid",
                "Canonical attachment sealed root is not valid Unicode",
            )
            .outcome_unknown(true)
        })?
        .to_owned();
    let authority = RuntimeAuthority {
        project_id: project.project_id.clone(),
        activation_token: activation_token.clone(),
        renderer_session_id: input.renderer_session_id,
        renderer_generation: input.renderer_generation,
        window_label,
    };
    let (sender, receiver) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let started = match runtime.start().await {
            Ok(value) => value,
            Err(error) => {
                let _ = sender.send(Err(error));
                return;
            }
        };
        let mut lease = RuntimeTransactionLease::new(
            operation,
            runtime.clone(),
            attachments,
            recovery,
            &started,
        );
        let transaction: AppResult<ProjectActivationResult> = async {
            let snapshot = runtime
                .call(
                    "repository.select",
                    serde_json::json!({
                        "projectId": project.project_id,
                        "rootPath": project.root_path,
                        "attachmentSealedRoot": attachment_sealed_root
                    }),
                    180_000,
                )
                .await?;
            let status = runtime
                .commit_authority_if_ready(&started.runtime_generation, authority.clone())
                .await?;
            lease.authority_committed(authority.clone());
            runtime
                .bind_projection_ingest_authority(&status, &authority)
                .await?;
            registry.lock().await.select(&project.project_id)?;
            Ok(ProjectActivationResult {
                project: project.clone(),
                activation_token: authority.activation_token.clone(),
                runtime: status,
                snapshot,
            })
        }
        .await;
        let result = match transaction {
            Err(original) => {
                match lease.rollback().await {
                    Ok(()) => Err(original),
                    Err(stop_error) => Err(AppError::new("activation_rollback_unconfirmed", format!("{}; stop failed: {}", original.message, stop_error.message)).outcome_unknown(true)
                        .with_details(serde_json::json!({ "runtimeGeneration": started.runtime_generation, "stopCode": stop_error.code }))),
                }
            }
            Ok(value) => Ok(value),
        };
        let leave_runtime_running = result.is_ok();
        if sender.send(result).is_err() {
            // IPC response loss after success must not leave an undisclosed writer.
            let _ = lease.rollback().await;
        } else if leave_runtime_running {
            lease.disarm();
            let refresh_runtime = runtime.clone();
            let refresh_projection = projection.clone();
            let refresh_project_id = project.project_id.clone();
            let refresh_root_path = project.root_path.clone();
            tokio::spawn(async move {
                let binding = match refresh_runtime
                    .capture_projection_authority(None, &refresh_project_id)
                    .await
                {
                    Ok(binding) => binding,
                    Err(_) => return,
                };
                let notify_runtime = refresh_runtime.clone();
                if let Err(error) = crate::projection_bridge::refresh_provider_projection(
                    refresh_runtime,
                    refresh_projection,
                    refresh_project_id,
                    refresh_root_path,
                    &binding,
                )
                .await
                {
                    let _ = notify_runtime.emit_projection_fault(&binding, &error).await;
                }
            });
        }
    });
    receiver.await.map_err(|_| {
        AppError::new(
            "activation_result_lost",
            "Native activation task ended without a result",
        )
        .outcome_unknown(true)
    })?
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeSendAdditionalParams {
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub recommended_model: Option<String>,
    #[serde(default)]
    pub requested_model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeSendInput {
    pub renderer_session_id: String,
    pub renderer_generation: u64,
    pub project_id: String,
    pub activation_token: String,
    pub runtime_generation: String,
    pub expected_status_revision: u64,
    pub message_id: String,
    pub runtime_project_id: String,
    pub target_agent_id: String,
    pub text: String,
    #[serde(default)]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub thread_title: Option<String>,
    #[serde(default)]
    pub attachment_refs: Vec<AttachmentPublicRef>,
    #[serde(default)]
    pub selected_context_ids: Vec<String>,
    pub additional_params: RuntimeSendAdditionalParams,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSendResult {
    pub runtime_result: Value,
    pub dispatch_recovery: Option<DispatchRecoveryStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeTurnInterruptInput {
    pub renderer_session_id: String,
    pub renderer_generation: u64,
    pub project_id: String,
    pub activation_token: String,
    pub runtime_generation: String,
    pub expected_status_revision: u64,
    pub target_agent_id: String,
    pub thread_id: String,
    pub turn_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeTurnInterruptResult {
    pub status: String,
    pub target_agent_id: String,
    pub thread_id: String,
    pub turn_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeTurnSteerInput {
    pub renderer_session_id: String,
    pub renderer_generation: u64,
    pub project_id: String,
    pub activation_token: String,
    pub runtime_generation: String,
    pub expected_status_revision: u64,
    pub steer_id: String,
    pub target_agent_id: String,
    pub thread_id: String,
    pub turn_id: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeTurnSteerResult {
    pub status: String,
    pub steer_id: String,
    pub target_agent_id: String,
    pub thread_id: String,
    pub turn_id: String,
}

fn turn_mutation_identity(
    kind: &str,
    project_id: &str,
    thread_id: &str,
    turn_id: &str,
    extra: &[&str],
) -> String {
    let mut digest = Sha256::new();
    digest.update(b"orquesta.native.turn-mutation.v2\0");
    for value in [kind, project_id, thread_id, turn_id]
        .into_iter()
        .chain(extra.iter().copied())
    {
        digest.update(value.as_bytes());
        digest.update(b"\0");
    }
    format!("turn-mutation-v2-{:x}", digest.finalize())
}

fn interrupt_claim_identity(input: &RuntimeTurnInterruptInput) -> String {
    turn_mutation_identity(
        "stop",
        &input.project_id,
        &input.thread_id,
        &input.turn_id,
        &[],
    )
}

fn steer_claim_identity(input: &RuntimeTurnSteerInput) -> String {
    turn_mutation_identity(
        "steer",
        &input.project_id,
        &input.thread_id,
        &input.turn_id,
        &[&input.steer_id, &input.text],
    )
}

fn interrupting_result(input: &RuntimeTurnInterruptInput) -> RuntimeTurnInterruptResult {
    RuntimeTurnInterruptResult {
        status: "interrupting".into(),
        target_agent_id: input.target_agent_id.clone(),
        thread_id: input.thread_id.clone(),
        turn_id: input.turn_id.clone(),
    }
}

fn steer_accepted_result(input: &RuntimeTurnSteerInput) -> RuntimeTurnSteerResult {
    RuntimeTurnSteerResult {
        status: "accepted".into(),
        steer_id: input.steer_id.clone(),
        target_agent_id: input.target_agent_id.clone(),
        thread_id: input.thread_id.clone(),
        turn_id: input.turn_id.clone(),
    }
}

// Stop and Steer have different user-visible contracts, but they cross the
// same exactly-once boundary. Keep those differences typed here so the durable
// claim lifecycle cannot drift between two command implementations.
enum TurnMutationAction {
    Interrupt(RuntimeTurnInterruptInput),
    Steer(RuntimeTurnSteerInput),
}

#[derive(Debug)]
enum TurnMutationResponse {
    Interrupt(RuntimeTurnInterruptResult),
    Steer(RuntimeTurnSteerResult),
}

#[derive(Clone)]
struct TurnMutationClaim {
    project_id: String,
    thread_id: String,
    turn_id: String,
    identity: String,
}

impl TurnMutationAction {
    fn validate(&self) -> AppResult<()> {
        match self {
            Self::Interrupt(input) => {
                bounded_id(&input.target_agent_id, "targetAgentId")?;
                bounded_id(&input.thread_id, "threadId")?;
                bounded_id(&input.turn_id, "turnId")?;
                Ok(())
            }
            Self::Steer(input) => {
                bounded_id(&input.steer_id, "steerId")?;
                bounded_id(&input.target_agent_id, "targetAgentId")?;
                bounded_id(&input.thread_id, "threadId")?;
                bounded_id(&input.turn_id, "turnId")?;
                bounded_text(
                    &input.text,
                    "text",
                    crate::protocol::GENERATED_MESSAGE_TEXT_MAX_UTF8_BYTES,
                )?;
                Ok(())
            }
        }
    }

    fn session_input(&self) -> SessionInput {
        match self {
            Self::Interrupt(input) => SessionInput {
                renderer_session_id: input.renderer_session_id.clone(),
                renderer_generation: input.renderer_generation,
            },
            Self::Steer(input) => SessionInput {
                renderer_session_id: input.renderer_session_id.clone(),
                renderer_generation: input.renderer_generation,
            },
        }
    }

    fn authority_input(&self) -> AuthorityInput {
        match self {
            Self::Interrupt(input) => AuthorityInput {
                renderer_session_id: input.renderer_session_id.clone(),
                renderer_generation: input.renderer_generation,
                project_id: input.project_id.clone(),
                activation_token: input.activation_token.clone(),
            },
            Self::Steer(input) => AuthorityInput {
                renderer_session_id: input.renderer_session_id.clone(),
                renderer_generation: input.renderer_generation,
                project_id: input.project_id.clone(),
                activation_token: input.activation_token.clone(),
            },
        }
    }

    fn expected_status_revision(&self) -> u64 {
        match self {
            Self::Interrupt(input) => input.expected_status_revision,
            Self::Steer(input) => input.expected_status_revision,
        }
    }

    fn runtime_generation(&self) -> &str {
        match self {
            Self::Interrupt(input) => &input.runtime_generation,
            Self::Steer(input) => &input.runtime_generation,
        }
    }

    fn project_id(&self) -> &str {
        match self {
            Self::Interrupt(input) => &input.project_id,
            Self::Steer(input) => &input.project_id,
        }
    }

    fn target_agent_id(&self) -> &str {
        match self {
            Self::Interrupt(input) => &input.target_agent_id,
            Self::Steer(input) => &input.target_agent_id,
        }
    }

    fn thread_id(&self) -> &str {
        match self {
            Self::Interrupt(input) => &input.thread_id,
            Self::Steer(input) => &input.thread_id,
        }
    }

    fn turn_id(&self) -> &str {
        match self {
            Self::Interrupt(input) => &input.turn_id,
            Self::Steer(input) => &input.turn_id,
        }
    }

    fn claim_kind(&self) -> TurnMutationKind {
        match self {
            Self::Interrupt(_) => TurnMutationKind::Stop,
            Self::Steer(_) => TurnMutationKind::Steer,
        }
    }

    fn claim_identity(&self) -> String {
        match self {
            Self::Interrupt(input) => interrupt_claim_identity(input),
            Self::Steer(input) => steer_claim_identity(input),
        }
    }

    fn active_state_response(&self, active_state: &str) -> AppResult<Option<TurnMutationResponse>> {
        if active_state != "interrupting" {
            return Ok(None);
        }
        match self {
            Self::Interrupt(_) => Ok(Some(self.accepted_response())),
            Self::Steer(_) => Err(AppError::new(
                "runtime_turn_not_steerable",
                "A turn cannot be steered after Stop has been accepted",
            )),
        }
    }

    fn runtime_request(&self, root_path: &str) -> (&'static str, Value) {
        match self {
            Self::Interrupt(input) => (
                "runtime.turn.interrupt",
                serde_json::json!({
                    "projectId": input.project_id,
                    "rootPath": root_path,
                    "targetAgentId": input.target_agent_id,
                    "threadId": input.thread_id,
                    "turnId": input.turn_id,
                }),
            ),
            Self::Steer(input) => (
                "runtime.turn.steer",
                serde_json::json!({
                    "projectId": input.project_id,
                    "rootPath": root_path,
                    "steerId": input.steer_id,
                    "targetAgentId": input.target_agent_id,
                    "threadId": input.thread_id,
                    "turnId": input.turn_id,
                    "text": input.text,
                }),
            ),
        }
    }

    fn validate_runtime_response(&self, response: &Value) -> AppResult<()> {
        let target_agent_id = response.get("targetAgentId").and_then(Value::as_str);
        let thread_id = response.get("threadId").and_then(Value::as_str);
        let turn_id = response.get("turnId").and_then(Value::as_str);
        match self {
            Self::Interrupt(input)
                if target_agent_id == Some(input.target_agent_id.as_str())
                    && thread_id == Some(input.thread_id.as_str())
                    && turn_id == Some(input.turn_id.as_str()) =>
            {
                Ok(())
            }
            Self::Interrupt(_) => Err(AppError::new(
                "runtime_turn_interrupt_response_mismatch",
                "Runtime interrupt acknowledgement did not match the requested turn",
            )
            .outcome_unknown(true)),
            Self::Steer(input)
                if response.get("steerId").and_then(Value::as_str)
                    == Some(input.steer_id.as_str())
                    && target_agent_id == Some(input.target_agent_id.as_str())
                    && thread_id == Some(input.thread_id.as_str())
                    && turn_id == Some(input.turn_id.as_str()) =>
            {
                Ok(())
            }
            Self::Steer(_) => Err(AppError::new(
                "runtime_turn_steer_response_mismatch",
                "Runtime Steer acknowledgement did not match the requested turn",
            )
            .outcome_unknown(true)),
        }
    }

    fn accepted_response(&self) -> TurnMutationResponse {
        match self {
            Self::Interrupt(input) => TurnMutationResponse::Interrupt(interrupting_result(input)),
            Self::Steer(input) => TurnMutationResponse::Steer(steer_accepted_result(input)),
        }
    }
}

impl TurnMutationClaim {
    fn from_action(action: &TurnMutationAction) -> Self {
        Self {
            project_id: action.project_id().to_owned(),
            thread_id: action.thread_id().to_owned(),
            turn_id: action.turn_id().to_owned(),
            identity: action.claim_identity(),
        }
    }
}

async fn run_projection_operation<T, F>(operation: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> AppResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| AppError::new("projection_worker_failed", error.to_string()))?
}

async fn prepare_registered_project_projection(
    registry: Arc<Mutex<ProjectRegistry>>,
    projection: ProjectionService,
    project_id: String,
) -> AppResult<ProjectRecord> {
    let (record, initialization) = {
        let registry = registry.lock().await;
        (
            registry.verify(&project_id)?,
            registry.projection_initialization_state(&project_id)?,
        )
    };
    match initialization {
        ProjectionInitializationState::Pending => {
            let initialize_project_id = project_id.clone();
            run_projection_operation(move || projection.initialize_project(&initialize_project_id))
                .await?;
            registry.lock().await.mark_projection_ready(&project_id)
        }
        ProjectionInitializationState::Ready => {
            run_projection_operation(move || projection.require_existing_project(&project_id))
                .await?;
            Ok(record)
        }
    }
}

fn turn_mutation_persistence_error(error: AppError) -> AppError {
    // Once the provider call may have started, a failed durable transition can
    // no longer prove that a retry is safe. Preserve the original diagnostic
    // while forcing the command boundary to report an unknown outcome.
    error.outcome_unknown(true)
}

async fn projected_active_turn_state(
    state: &NativeState,
    project_id: &str,
    target_agent_id: &str,
    thread_id: &str,
    turn_id: &str,
) -> AppResult<String> {
    let projection = state.projection.clone();
    let query = ProjectionConversationInput {
        schema_version: 1,
        project_id: project_id.to_owned(),
        target_agent_id: target_agent_id.to_owned(),
        expected_stream_id: None,
        after_journal_sequence: 0,
        expected_projection_revision: 0,
        cursor: None,
        activity_cursor: None,
        pending_request_cursor: None,
        limit: 1,
    };
    let snapshot = run_projection_operation(move || projection.conversation(&query)).await?;
    snapshot
        .active_turns
        .iter()
        .find(|turn| {
            turn.thread_id == thread_id
                && turn.turn_id == turn_id
                && turn.target_agent_id == target_agent_id
        })
        .map(|turn| turn.state.clone())
        .ok_or_else(|| {
            AppError::new(
                "runtime_turn_not_projection_owned",
                "This action is allowed only for the selected agent's currently projected turn",
            )
        })
}

async fn mark_turn_mutation_outcome_unknown(
    projection: ProjectionService,
    claim: TurnMutationClaim,
) -> AppResult<()> {
    run_projection_operation(move || {
        projection.mark_turn_mutation_outcome_unknown(
            &claim.project_id,
            &claim.thread_id,
            &claim.turn_id,
            &claim.identity,
        )
    })
    .await
}

async fn release_turn_mutation_claim(
    projection: ProjectionService,
    claim: TurnMutationClaim,
) -> AppResult<()> {
    run_projection_operation(move || {
        projection.release_turn_mutation(
            &claim.project_id,
            &claim.thread_id,
            &claim.turn_id,
            &claim.identity,
        )
    })
    .await
}

async fn mark_turn_mutation_accepted(
    projection: ProjectionService,
    claim: TurnMutationClaim,
) -> AppResult<()> {
    run_projection_operation(move || {
        projection.mark_turn_mutation_accepted(
            &claim.project_id,
            &claim.thread_id,
            &claim.turn_id,
            &claim.identity,
        )
    })
    .await
}

async fn execute_turn_mutation(
    window: &WebviewWindow,
    state: &NativeState,
    action: TurnMutationAction,
) -> AppResult<TurnMutationResponse> {
    state.admit_commands()?;
    action.validate()?;
    let _operation = state.runtime_operation_lock.clone().read_owned().await;
    let _mutation = state.runtime_mutation_lock.clone().lock_owned().await;
    let session_input = action.session_input();
    let session = current_session_guard(state, window, &session_input).await?;
    require_runtime_compare(
        &state.runtime,
        action.expected_status_revision(),
        Some(action.runtime_generation()),
    )
    .await?;
    let authority_input = action.authority_input();
    require_authority(&state.runtime, &authority_input, window).await?;
    let project = state.registry.lock().await.verify(action.project_id())?;
    let active_state = projected_active_turn_state(
        state,
        action.project_id(),
        action.target_agent_id(),
        action.thread_id(),
        action.turn_id(),
    )
    .await?;
    if let Some(response) = action.active_state_response(&active_state)? {
        return Ok(response);
    }

    let claim = TurnMutationClaim::from_action(&action);
    let projection = state.projection.clone();
    let claim_for_projection = claim.clone();
    let claim_kind = action.claim_kind();
    let claim_result = run_projection_operation(move || {
        projection.claim_turn_mutation(
            &claim_for_projection.project_id,
            &claim_for_projection.thread_id,
            &claim_for_projection.turn_id,
            claim_kind,
            &claim_for_projection.identity,
        )
    })
    .await?;
    if claim_result == TurnMutationClaimResult::Duplicate {
        return Ok(action.accepted_response());
    }

    drop(session);
    let (method, params) = action.runtime_request(&project.root_path);
    let response = match state.runtime.call(method, params, 30_000).await {
        Ok(response) => response,
        Err(error) => {
            let transition = if error.outcome_unknown {
                mark_turn_mutation_outcome_unknown(state.projection.clone(), claim.clone()).await
            } else {
                release_turn_mutation_claim(state.projection.clone(), claim.clone()).await
            };
            transition.map_err(turn_mutation_persistence_error)?;
            return Err(error);
        }
    };
    if let Err(error) = action.validate_runtime_response(&response) {
        mark_turn_mutation_outcome_unknown(state.projection.clone(), claim.clone())
            .await
            .map_err(turn_mutation_persistence_error)?;
        return Err(error);
    }
    mark_turn_mutation_accepted(state.projection.clone(), claim)
        .await
        .map_err(turn_mutation_persistence_error)?;
    Ok(action.accepted_response())
}

#[tauri::command]
pub async fn runtime_send(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: BridgeInput<RuntimeSendInput>,
) -> AppResult<BridgeResponse<RuntimeSendResult>> {
    Ok(BridgeResponse::new(
        runtime_send_impl(window, state, input.value).await?,
    ))
}

async fn runtime_send_impl(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: RuntimeSendInput,
) -> AppResult<RuntimeSendResult> {
    state.admit_commands()?;
    bounded_text(
        &input.text,
        "text",
        crate::protocol::GENERATED_MESSAGE_TEXT_MAX_UTF8_BYTES,
    )?;
    let operation = state.runtime_operation_lock.clone().read_owned().await;
    let mutation = state.runtime_mutation_lock.clone().lock_owned().await;
    let dispatch_guard = state.dispatch_state_lock.clone().lock_owned().await;
    let session_input = SessionInput {
        renderer_session_id: input.renderer_session_id.clone(),
        renderer_generation: input.renderer_generation,
    };
    let session = current_session_guard(&state, &window, &session_input).await?;
    require_runtime_compare(
        &state.runtime,
        input.expected_status_revision,
        Some(&input.runtime_generation),
    )
    .await?;
    let authority_input = AuthorityInput {
        renderer_session_id: input.renderer_session_id.clone(),
        renderer_generation: input.renderer_generation,
        project_id: input.project_id.clone(),
        activation_token: input.activation_token.clone(),
    };
    let _authority = require_authority(&state.runtime, &authority_input, &window).await?;
    let containment = state.runtime.containment_evidence().await?; // pre-prepare await: cancellation cannot strand Prepared
    let project = state.registry.lock().await.verify(&input.project_id)?;
    let mut attachments = state.attachments.lock().await;
    let existing_recovery = state
        .dispatch_recovery
        .lock()
        .await
        .current_private_for_project(&input.project_id);
    let handles_for_dispatch = attachments
        .resolve_public_dispatch_handles(&input.attachment_refs, existing_recovery.as_ref())?;
    let content_hashes = attachments.content_hashes(&handles_for_dispatch)?;
    let fingerprint = DispatchFingerprintInput {
        runtime_project_id: input.runtime_project_id.clone(),
        target_agent_id: input.target_agent_id.clone(),
        text: input.text.clone(),
        ordered_attachment_content_sha256: content_hashes,
        selected_context_ids: input.selected_context_ids.clone(),
        effort: input.additional_params.effort.clone(),
        recommended_model: input.additional_params.recommended_model.clone(),
        requested_model: input.additional_params.requested_model.clone(),
    };
    let mut recovery = state.dispatch_recovery.lock().await;
    let preparation = recovery.prepare(
        &input.message_id,
        &input.project_id,
        &fingerprint,
        handles_for_dispatch.clone(),
    )?;
    if let DispatchPreparation::AlreadyAccepted(record) = &preparation {
        let status = Some(DispatchRecoveryStatus::from(record));
        let receipt = record.receipt.clone().ok_or_else(|| {
            AppError::new(
                "dispatch_recovery_corrupt",
                "Accepted recovery is missing its typed receipt",
            )
            .outcome_unknown(true)
        })?;
        return Ok(RuntimeSendResult {
            runtime_result: serde_json::json!({
                "threadId": receipt.thread_id, "turnId": receipt.turn_id, "replayed": true,
                "modelEvidence": { "recommendedModel": null, "requestedModel": null, "appliedModel": null, "actualModel": null, "actualModelEvidence": "unknown" }
            }),
            dispatch_recovery: status,
        });
    }
    let (record, was_retry) = match &preparation {
        DispatchPreparation::Created(record) => (record.clone(), false),
        DispatchPreparation::Retry(record) => (record.clone(), true),
        DispatchPreparation::AlreadyAccepted(_) => unreachable!(),
    };
    let lease = match attachments.resolve_for_dispatch(
        &record.message_id,
        &handles_for_dispatch,
        if was_retry { Some(&record) } else { None },
        &containment,
    ) {
        Ok(value) => value,
        Err(preflight) => {
            if was_retry {
                let status = recovery
                    .mark_outcome_unknown(&record.message_id)
                    .ok()
                    .or_else(|| recovery.status_for_message(&record.message_id));
                return Err(dispatch_error_with_status(
                    AppError::recovery_lock(&record.message_id, preflight.message),
                    status,
                ));
            }
            let dispatch_owned = match attachments
                .dispatch_owns_exact_handles(&record.message_id, &record.attachment_handles)
            {
                Ok(value) => value,
                Err(ownership_error) => {
                    let status = recovery
                        .mark_outcome_unknown(&record.message_id)
                        .ok()
                        .or_else(|| recovery.status_for_message(&record.message_id));
                    return Err(dispatch_error_with_status(
                        AppError::recovery_lock(
                            &record.message_id,
                            format!("{}; {}", preflight.message, ownership_error.message),
                        ),
                        status,
                    ));
                }
            };
            if !dispatch_owned {
                let result = recovery
                    .clear_preflight_failure(
                        &record.message_id,
                        "definitive_preflight_draft_retained",
                    )
                    .map(|_| ());
                if let Err(clear_error) = result {
                    return Err(dispatch_error_with_status(
                        AppError::recovery_lock(
                            &record.message_id,
                            format!(
                                "{}; recovery resolution failed: {}",
                                preflight.message, clear_error.message
                            ),
                        ),
                        recovery.status_for_message(&record.message_id),
                    ));
                }
                return Err(preflight);
            }
            // No sidecar boundary was crossed. Cleanup is still transactional: phase
            // first, idempotent per-dispatch reclaim, tombstone last.
            let result = recovery
                .mark_cleanup_pending(&record.message_id)
                .and_then(|_| {
                    attachments.cleanup_dispatch_authoritative_failure(
                        &record.message_id,
                        &record.attachment_handles,
                    )
                })
                .and_then(|_| {
                    recovery
                        .clear_after_cleanup(&record.message_id, "definitive_preflight")
                        .map(|_| ())
                });
            if let Err(clear_error) = result {
                return Err(dispatch_error_with_status(
                    AppError::recovery_lock(
                        &record.message_id,
                        format!(
                            "{}; recovery cleanup failed: {}",
                            preflight.message, clear_error.message
                        ),
                    ),
                    recovery.status_for_message(&record.message_id),
                ));
            }
            return Err(dispatch_error_with_status(preflight, None));
        }
    };
    let params = serde_json::json!({
        "projectId": input.runtime_project_id,
        "rootPath": project.root_path,
        "messageId": record.message_id,
        "actionFingerprint": record.action_fingerprint,
        "threadId": input.thread_id,
        "threadTitle": input.thread_title,
        "targetAgentId": input.target_agent_id,
        "text": input.text,
        "attachments": lease.attachments,
        "selectedContextIds": input.selected_context_ids,
        "effort": input.additional_params.effort,
        "recommendedModel": input.additional_params.recommended_model,
        "requestedModel": input.additional_params.requested_model
    });
    drop(recovery);
    drop(attachments);
    drop(session);
    drop(dispatch_guard);
    let runtime = state.runtime.clone();
    let settlement_record = record.clone();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let _operation = operation;
        let _mutation = mutation;
        let call = runtime.call("runtime.send", params, 180_000).await;
        let result = runtime
            .settle_dispatch_attempt(
                &settlement_record,
                call,
                DispatchAttemptKind::Initial { was_retry },
            )
            .await
            .map(|settlement| RuntimeSendResult {
                runtime_result: settlement.runtime_result,
                dispatch_recovery: settlement.dispatch_recovery,
            });
        let _ = sender.send(result);
    });
    match receiver.await {
        Ok(result) => result,
        Err(_) => {
            let status = state
                .dispatch_recovery
                .lock()
                .await
                .status_for_message(&record.message_id);
            Err(dispatch_error_with_status(
                AppError::recovery_lock(&record.message_id, "Native dispatch task result was lost"),
                status,
            ))
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeCallInput {
    pub renderer_session_id: String,
    pub renderer_generation: u64,
    pub project_id: String,
    pub activation_token: String,
    pub runtime_generation: String,
    pub expected_status_revision: u64,
    pub method: String,
    pub params: Value,
    pub timeout_ms: Option<u64>,
}

#[tauri::command]
pub async fn runtime_call(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: BridgeInput<RuntimeCallInput>,
) -> AppResult<BridgeResponse<Value>> {
    Ok(BridgeResponse::new(
        runtime_call_impl(window, state, input.value).await?,
    ))
}

#[tauri::command]
pub async fn runtime_turn_interrupt(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: BridgeInput<RuntimeTurnInterruptInput>,
) -> AppResult<BridgeResponse<RuntimeTurnInterruptResult>> {
    match execute_turn_mutation(&window, &state, TurnMutationAction::Interrupt(input.value)).await?
    {
        TurnMutationResponse::Interrupt(result) => Ok(BridgeResponse::new(result)),
        TurnMutationResponse::Steer(_) => unreachable!("interrupt action returned a steer result"),
    }
}

#[tauri::command]
pub async fn runtime_turn_steer(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: BridgeInput<RuntimeTurnSteerInput>,
) -> AppResult<BridgeResponse<RuntimeTurnSteerResult>> {
    match execute_turn_mutation(&window, &state, TurnMutationAction::Steer(input.value)).await? {
        TurnMutationResponse::Steer(result) => Ok(BridgeResponse::new(result)),
        TurnMutationResponse::Interrupt(_) => {
            unreachable!("steer action returned an interrupt result")
        }
    }
}

#[tauri::command]
pub async fn projection_conversation(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: BridgeInput<ProjectionConversationCommandInput>,
) -> AppResult<BridgeResponse<ProjectionConversationSnapshot>> {
    let input = input.value;
    let _operation = state.runtime_operation_lock.read().await;
    let session_input = SessionInput {
        renderer_session_id: input.renderer_session_id.clone(),
        renderer_generation: input.renderer_generation,
    };
    let session = current_session_guard(&state, &window, &session_input).await?;
    let result =
        crate::projection_bridge::conversation(&state.runtime, state.projection.clone(), input)
            .await?;
    drop(session);
    Ok(BridgeResponse::new(result))
}

#[tauri::command]
pub async fn projection_history_index(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: BridgeInput<ProjectionHistoryIndexCommandInput>,
) -> AppResult<BridgeResponse<ProjectionHistoryIndexPage>> {
    let input = input.value;
    let _operation = state.runtime_operation_lock.read().await;
    let session_input = SessionInput {
        renderer_session_id: input.renderer_session_id.clone(),
        renderer_generation: input.renderer_generation,
    };
    let session = current_session_guard(&state, &window, &session_input).await?;
    let result =
        crate::projection_bridge::history_index(&state.runtime, state.projection.clone(), input)
            .await?;
    drop(session);
    Ok(BridgeResponse::new(result))
}

#[tauri::command]
pub async fn projection_history_page(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: BridgeInput<ProjectionHistoryPageCommandInput>,
) -> AppResult<BridgeResponse<ProjectionHistoryPage>> {
    let input = input.value;
    let _operation = state.runtime_operation_lock.read().await;
    let session_input = SessionInput {
        renderer_session_id: input.renderer_session_id.clone(),
        renderer_generation: input.renderer_generation,
    };
    let session = current_session_guard(&state, &window, &session_input).await?;
    let result =
        crate::projection_bridge::history_page(&state.runtime, state.projection.clone(), input)
            .await?;
    drop(session);
    Ok(BridgeResponse::new(result))
}

async fn run_runtime_approval_response(
    runtime: &SidecarSupervisor,
    projection: crate::projection_service::ProjectionService,
    project_id: &str,
    runtime_connection_id: &str,
    params: &mut Value,
    timeout: u64,
) -> AppResult<Value> {
    let object = params.as_object_mut().ok_or_else(|| {
        AppError::new(
            "runtime_request_params_invalid",
            "Approval response params must be an object",
        )
    })?;
    let request_key = object
        .get("attentionId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            AppError::new(
                "runtime_approval_request_invalid",
                "Approval response requires attentionId",
            )
        })?
        .to_owned();
    let decision = object
        .get("decision")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            AppError::new(
                "runtime_approval_request_invalid",
                "Approval response requires decision",
            )
        })?
        .to_owned();
    let claim_projection = projection.clone();
    let claim_project_id = project_id.to_owned();
    let claim_runtime_connection_id = runtime_connection_id.to_owned();
    let current_provider_connection_id = runtime.current_provider_connection_id().await?;
    let claim_provider_connection_id = current_provider_connection_id.clone();
    let claim_request_key = request_key.clone();
    let claim_decision = decision.clone();
    let claim = run_projection_operation(move || {
        claim_projection.claim_approval_response(
            &claim_project_id,
            &claim_runtime_connection_id,
            &claim_provider_connection_id,
            &claim_request_key,
            &claim_decision,
        )
    })
    .await?;
    let ApprovalResponseClaimResult::Acquired(claim) = claim else {
        return Ok(serde_json::json!({
            "attentionId": request_key,
            "decision": decision,
        }));
    };
    object.insert(
        "providerConnectionId".into(),
        Value::String(claim.provider_connection_id.clone()),
    );
    object.insert(
        "requestId".into(),
        Value::String(claim.provider_request_id.clone()),
    );
    let call_result = runtime
        .call("runtime.approval.respond", params.clone(), timeout)
        .await;
    match call_result {
        Ok(value) => {
            let acknowledged = value.get("attentionId").and_then(Value::as_str)
                == Some(request_key.as_str())
                && value.get("requestId").and_then(Value::as_str)
                    == Some(claim.provider_request_id.as_str())
                && value.get("providerConnectionId").and_then(Value::as_str)
                    == Some(claim.provider_connection_id.as_str())
                && value.get("decision").and_then(Value::as_str) == Some(decision.as_str());
            if !acknowledged {
                let unknown_projection = projection.clone();
                let unknown_project_id = project_id.to_owned();
                let unknown_request_key = request_key.clone();
                let unknown_identity = claim.identity.clone();
                let unknown_decision = decision.clone();
                run_projection_operation(move || {
                    unknown_projection.mark_approval_response_outcome_unknown(
                        &unknown_project_id,
                        &unknown_request_key,
                        &unknown_identity,
                        &unknown_decision,
                    )
                })
                .await
                .map_err(turn_mutation_persistence_error)?;
                return Err(AppError::new(
                    "runtime_approval_response_mismatch",
                    "Runtime approval acknowledgement did not match the exact request",
                )
                .outcome_unknown(true));
            }
            let accepted_projection = projection.clone();
            let accepted_project_id = project_id.to_owned();
            let accepted_request_key = request_key.clone();
            let accepted_identity = claim.identity.clone();
            let accepted_decision = decision.clone();
            run_projection_operation(move || {
                accepted_projection.mark_approval_response_accepted(
                    &accepted_project_id,
                    &accepted_request_key,
                    &accepted_identity,
                    &accepted_decision,
                )
            })
            .await
            .map_err(turn_mutation_persistence_error)?;
            Ok(serde_json::json!({
                "attentionId": request_key,
                "decision": decision,
            }))
        }
        Err(core_error) if core_error.outcome_unknown => {
            let unknown_projection = projection.clone();
            let unknown_project_id = project_id.to_owned();
            let unknown_request_key = request_key.clone();
            let unknown_identity = claim.identity.clone();
            let unknown_decision = decision.clone();
            run_projection_operation(move || {
                unknown_projection.mark_approval_response_outcome_unknown(
                    &unknown_project_id,
                    &unknown_request_key,
                    &unknown_identity,
                    &unknown_decision,
                )
            })
            .await
            .map_err(turn_mutation_persistence_error)?;
            Err(core_error)
        }
        Err(core_error) => {
            let release_projection = projection.clone();
            let release_project_id = project_id.to_owned();
            let release_request_key = request_key.clone();
            let release_identity = claim.identity.clone();
            let release_decision = decision.clone();
            run_projection_operation(move || {
                release_projection.release_approval_response(
                    &release_project_id,
                    &release_request_key,
                    &release_identity,
                    &release_decision,
                )
            })
            .await
            .map_err(turn_mutation_persistence_error)?;
            Err(core_error)
        }
    }
}

async fn runtime_call_impl(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: RuntimeCallInput,
) -> AppResult<Value> {
    state.admit_commands()?;
    let policy = state.method_policy.renderer_method(&input.method)?.clone();
    if policy.attachments_allowed
        || input.params.get("localImagePaths").is_some()
        || input.params.get("attachmentHandles").is_some()
        || input.params.get("attachmentRefs").is_some()
    {
        return Err(AppError::new(
            "runtime_attachments_require_typed_send",
            "Attachments are accepted only by runtime_send",
        ));
    }
    let operation = state.runtime_operation_lock.clone().read_owned().await;
    let session_input = SessionInput {
        renderer_session_id: input.renderer_session_id.clone(),
        renderer_generation: input.renderer_generation,
    };
    let session = current_session_guard(&state, &window, &session_input).await?;
    require_runtime_compare(
        &state.runtime,
        input.expected_status_revision,
        Some(&input.runtime_generation),
    )
    .await?;
    let authority = AuthorityInput {
        renderer_session_id: input.renderer_session_id.clone(),
        renderer_generation: input.renderer_generation,
        project_id: input.project_id.clone(),
        activation_token: input.activation_token.clone(),
    };
    let runtime_authority = require_authority(&state.runtime, &authority, &window).await?;
    let registry = state.registry.clone();
    let project_binding = reverify_runtime_project_authority(
        &registry,
        &runtime_authority,
        policy.project_requirement,
        &input.params,
        None,
    )
    .await?;
    drop(session);
    let runtime = state.runtime.clone();
    let projection = state.projection.clone();
    let project_id = input.project_id.clone();
    let runtime_connection_id = input.runtime_generation.clone();
    let timeout = input
        .timeout_ms
        .unwrap_or(policy.default_timeout_ms)
        .min(600_000);
    let method = input.method;
    let mut params = input.params;
    inject_selected_project_root(
        &method,
        &mut params,
        project_binding
            .as_ref()
            .map(|project| project.root_path.as_str()),
    )?;
    let project_requirement = policy.project_requirement;
    let mutation_kind = policy.mutation_kind;
    let recovery_strategy = policy.recovery_strategy;
    let mutation = if policy.mutation_kind == MutationKind::ReadOnly {
        None
    } else {
        Some(state.runtime_mutation_lock.clone().lock_owned().await)
    };
    let (sender, receiver) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let _operation = operation;
        let _mutation = mutation;
        let call_result = if recovery_strategy == RecoveryStrategy::NativeExactApproval {
            run_runtime_approval_response(
                &runtime,
                projection,
                &project_id,
                &runtime_connection_id,
                &mut params,
                timeout,
            )
            .await
        } else {
            runtime.call(&method, params.clone(), timeout).await
        };
        let postcheck = reverify_runtime_project_authority(
            &registry,
            &runtime_authority,
            project_requirement,
            &params,
            project_binding.as_ref(),
        )
        .await;
        let result = combine_runtime_call_result(
            call_result,
            postcheck.map(|_| ()),
            mutation_kind,
            &method,
            recovery_strategy,
        );
        let _ = sender.send(result);
    });
    receiver.await.map_err(|_| {
        AppError::new(
            "runtime_call_result_lost",
            "Native runtime call task ended without a result",
        )
        .outcome_unknown(policy.mutation_kind != MutationKind::ReadOnly)
    })?
}

fn combine_runtime_call_result(
    call_result: AppResult<Value>,
    postcheck: AppResult<()>,
    mutation_kind: MutationKind,
    method: &str,
    recovery_strategy: RecoveryStrategy,
) -> AppResult<Value> {
    match (call_result, postcheck) {
        (Err(core_error), _) => Err(core_error),
        (Ok(value), Ok(())) => Ok(value),
        (Ok(_), Err(authority_error)) if mutation_kind == MutationKind::ReadOnly => {
            Err(authority_error)
        }
        (Ok(_), Err(authority_error)) => {
            let authority_error_code = authority_error.code.clone();
            Err(authority_error
                .outcome_unknown(true)
                .with_details(serde_json::json!({
                    "phase": "post_runtime_call_authority_check",
                    "method": method,
                    "recoveryStrategy": recovery_strategy_name(recovery_strategy),
                    "authorityErrorCode": authority_error_code,
                    "coreCompleted": true,
                })))
        }
    }
}

#[tauri::command]
pub async fn dispatch_recovery_status(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: BridgeInput<SessionInput>,
) -> AppResult<BridgeResponse<Option<DispatchRecoveryStatus>>> {
    Ok(BridgeResponse::new(
        dispatch_recovery_status_impl(window, state, input.value).await?,
    ))
}

async fn dispatch_recovery_status_impl(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: SessionInput,
) -> AppResult<Option<DispatchRecoveryStatus>> {
    let _operation = state.runtime_operation_lock.read().await;
    let _dispatch = state.dispatch_state_lock.lock().await;
    let _session = current_session_guard(&state, &window, &input).await?;
    let runtime = state.runtime.status().await;
    let selected_project_id = state
        .registry
        .lock()
        .await
        .checked_snapshot()?
        .selected_project_id;
    let project_id = runtime
        .active_project_id
        .as_deref()
        .or(selected_project_id.as_deref());
    let recovery = state.dispatch_recovery.lock().await;
    Ok(project_id.and_then(|project_id| recovery.status_for_project(project_id)))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DispatchReconcileInput {
    pub renderer_session_id: String,
    pub renderer_generation: u64,
    pub message_id: String,
    pub project_id: Option<String>,
    pub activation_token: Option<String>,
    pub runtime_generation: Option<String>,
    pub expected_status_revision: Option<u64>,
}

#[tauri::command]
pub async fn dispatch_recovery_reconcile(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: BridgeInput<DispatchReconcileInput>,
) -> AppResult<BridgeResponse<RuntimeSendResult>> {
    Ok(BridgeResponse::new(
        dispatch_recovery_reconcile_impl(window, state, input.value).await?,
    ))
}

async fn dispatch_recovery_reconcile_impl(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: DispatchReconcileInput,
) -> AppResult<RuntimeSendResult> {
    let operation = state.runtime_operation_lock.clone().read_owned().await;
    let mutation = state.runtime_mutation_lock.clone().lock_owned().await;
    let dispatch_guard = state.dispatch_state_lock.clone().lock_owned().await;
    let session_input = SessionInput {
        renderer_session_id: input.renderer_session_id.clone(),
        renderer_generation: input.renderer_generation,
    };
    let session = current_session_guard(&state, &window, &session_input).await?;
    let record = state
        .dispatch_recovery
        .lock()
        .await
        .current_private_for_message(&input.message_id)
        .ok_or_else(|| {
            AppError::new(
                "dispatch_recovery_not_found",
                "No unresolved dispatch exists",
            )
        })?;
    if record.message_id != input.message_id {
        return Err(AppError::new(
            "dispatch_recovery_message_mismatch",
            "messageId does not own dispatch recovery",
        )
        .outcome_unknown(true));
    }
    if record.phase == DispatchPhase::CleanupPending {
        let mut recovery = state.dispatch_recovery.lock().await;
        state
            .attachments
            .lock()
            .await
            .cleanup_dispatch_authoritative_failure(
                &record.message_id,
                &record.attachment_handles,
            )?;
        recovery.clear_after_cleanup(&record.message_id, "authoritative_terminal_failure")?;
        return Ok(RuntimeSendResult {
            runtime_result: Value::Null,
            dispatch_recovery: None,
        });
    }
    let expected_status_revision = input.expected_status_revision.ok_or_else(|| {
        AppError::new(
            "runtime_status_revision_required",
            "Ledger reconcile requires expectedStatusRevision outside cleanup-only recovery",
        )
    })?;
    let runtime_generation = input.runtime_generation.as_deref().ok_or_else(|| {
        AppError::new(
            "runtime_generation_required",
            "Ledger reconcile requires exact runtimeGeneration outside cleanup-only recovery",
        )
    })?;
    require_runtime_compare(
        &state.runtime,
        expected_status_revision,
        Some(runtime_generation),
    )
    .await?;
    let authority_input = AuthorityInput {
        renderer_session_id: input.renderer_session_id,
        renderer_generation: input.renderer_generation,
        project_id: input.project_id.ok_or_else(|| {
            AppError::new(
                "runtime_project_required",
                "Ledger reconcile requires active projectId",
            )
        })?,
        activation_token: input.activation_token.ok_or_else(|| {
            AppError::new(
                "runtime_authority_required",
                "Ledger reconcile requires activationToken",
            )
        })?,
    };
    require_authority(&state.runtime, &authority_input, &window).await?;
    if authority_input.project_id != record.project_id {
        return Err(AppError::new(
            "dispatch_recovery_project_mismatch",
            "Recovery belongs to another project",
        ));
    }
    let project = state.registry.lock().await.verify(&record.project_id)?;
    let params = serde_json::json!({
        "projectId": record.runtime_project_id,
        "rootPath": project.root_path,
        "messageId": record.message_id,
        "actionFingerprint": record.action_fingerprint
    });
    drop(session);
    drop(dispatch_guard);
    let runtime = state.runtime.clone();
    let settlement_record = record.clone();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let _operation = operation;
        let _mutation = mutation;
        let call = runtime
            .call("runtime.dispatch.reconcile", params, 180_000)
            .await;
        let result = runtime
            .settle_dispatch_attempt(&settlement_record, call, DispatchAttemptKind::Reconcile)
            .await
            .map(|settlement| RuntimeSendResult {
                runtime_result: settlement.runtime_result,
                dispatch_recovery: settlement.dispatch_recovery,
            });
        let _ = sender.send(result);
    });
    receiver.await.map_err(|_| {
        AppError::recovery_lock(
            &record.message_id,
            "Native ledger reconcile result was lost",
        )
    })?
}

async fn cleanup_after_stop_parts(
    attachments: &Arc<Mutex<AttachmentStore>>,
    recovery: &Arc<Mutex<DispatchRecoveryStore>>,
    stopped_project_id: Option<&str>,
) -> AppResult<()> {
    let recoveries = {
        let mut recovery = recovery.lock().await;
        if let Some(current) = stopped_project_id
            .and_then(|project_id| recovery.current_private_for_project(project_id))
        {
            if current.phase == DispatchPhase::Accepted {
                recovery.mark_outcome_unknown(&current.message_id)?;
            }
        }
        recovery.all_private()
    };
    attachments
        .lock()
        .await
        .release_after_confirmed_stop_with_recoveries(&recoveries)
}

async fn cleanup_after_confirmed_stop(
    state: &NativeState,
    stopped_project_id: Option<&str>,
) -> AppResult<()> {
    if !state.runtime.process_termination_confirmed().await {
        return Err(AppError::new(
            "runtime_termination_unconfirmed",
            "Attachment cleanup requires confirmed full process-tree termination",
        )
        .outcome_unknown(true));
    }
    cleanup_after_stop_parts(
        &state.attachments,
        &state.dispatch_recovery,
        stopped_project_id,
    )
    .await
}

pub async fn shutdown_for_exit(state: &NativeState) -> AppResult<()> {
    let _operation = state.runtime_operation_lock.write().await;
    state.voice.shutdown().await?;
    let status = state.runtime.status().await;
    let stopped_project_id = status.active_project_id.clone();
    if status.phase != RuntimePhase::Stopped || !status.process_termination_confirmed {
        state.runtime.stop().await?;
    }
    cleanup_after_confirmed_stop(state, stopped_project_id.as_deref()).await?;
    if let Some(current) = state.renderer_sessions.lock().await.current.clone() {
        state.attachments.lock().await.retire_renderer_session(
            &current.session_id,
            current.generation,
            &current.window_label,
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod bridge_contract_tests {
    use super::*;

    #[cfg(windows)]
    async fn invoke_starter_through_creation_lock(
        creation_lock: std::sync::Arc<Mutex<()>>,
        registry: std::sync::Arc<Mutex<ProjectRegistry>>,
        parent: PathBuf,
        input: StarterProjectInput,
        picker_count: std::sync::Arc<std::sync::atomic::AtomicUsize>,
        picker_probe: std::sync::Arc<PickerConcurrencyProbe>,
    ) -> AppResult<ProjectRecord> {
        serialize_project_creation(creation_lock.as_ref(), async {
            let precheck = {
                let mut registry = registry.lock().await;
                create_or_reconcile_starter_project(&mut registry, None, input.clone())
            };
            match precheck {
                Ok(record) => Ok(record),
                Err(error) if error.code == "project_creation_parent_required" => {
                    picker_count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    picker_probe.enter().await;
                    let mut registry = registry.lock().await;
                    create_or_reconcile_starter_project(&mut registry, Some(parent), input)
                }
                Err(error) => Err(error),
            }
        })
        .await
    }

    #[cfg(windows)]
    struct PickerConcurrencyProbe {
        active: std::sync::atomic::AtomicUsize,
        maximum: std::sync::atomic::AtomicUsize,
        hold_first: std::sync::atomic::AtomicBool,
        first_entered: tokio::sync::Notify,
        release_first: tokio::sync::Notify,
    }

    #[cfg(windows)]
    impl PickerConcurrencyProbe {
        fn new(hold_first: bool) -> Self {
            Self {
                active: std::sync::atomic::AtomicUsize::new(0),
                maximum: std::sync::atomic::AtomicUsize::new(0),
                hold_first: std::sync::atomic::AtomicBool::new(hold_first),
                first_entered: tokio::sync::Notify::new(),
                release_first: tokio::sync::Notify::new(),
            }
        }

        async fn enter(&self) {
            let active = self
                .active
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
                + 1;
            self.maximum
                .fetch_max(active, std::sync::atomic::Ordering::SeqCst);
            if self
                .hold_first
                .swap(false, std::sync::atomic::Ordering::SeqCst)
            {
                self.first_entered.notify_one();
                self.release_first.notified().await;
            }
            self.active
                .fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
        }
    }

    #[cfg(windows)]
    fn starter_lock_test_paths(label: &str) -> (PathBuf, PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!(
            "orquesta-command-starter-{label}-{}",
            uuid::Uuid::new_v4()
        ));
        let parent = base.join("projects");
        let registry_path = base.join("state").join("projects.v1.json");
        std::fs::create_dir_all(&parent).expect("create Starter command test parent");
        (base, parent, registry_path)
    }

    fn projection_test_service(base: &std::path::Path) -> ProjectionService {
        let app_data = base.join("app-data");
        ProjectionService::open_trusted(app_data.join("projection"), app_data)
            .expect("open projection test service")
    }

    #[cfg(windows)]
    #[test]
    fn starter_registry_commit_resumes_pending_projection_after_restart() {
        let (base, parent, registry_path) = starter_lock_test_paths("projection-resume");
        let input = StarterProjectInput {
            operation_ref: uuid::Uuid::new_v4().hyphenated().to_string(),
            project_name: "Projection Resume".to_owned(),
        };
        let mut registry = ProjectRegistry::open(registry_path.clone()).expect("open registry");
        let record = create_or_reconcile_starter_project(&mut registry, Some(parent), input)
            .expect("commit Starter registration");
        assert!(registry.starter_claims().is_empty());
        assert_eq!(
            registry
                .projection_initialization_state(&record.project_id)
                .expect("pending projection authority"),
            ProjectionInitializationState::Pending
        );
        drop(registry);

        let projection = projection_test_service(&base);
        let mut restarted = ProjectRegistry::open(registry_path.clone()).expect("restart registry");
        resume_pending_projection_initializations(&mut restarted, &projection)
            .expect("resume pending projection initialization");
        assert_eq!(
            restarted
                .projection_initialization_state(&record.project_id)
                .expect("ready projection authority"),
            ProjectionInitializationState::Ready
        );
        drop(restarted);
        let reopened = ProjectRegistry::open(registry_path).expect("reopen ready registry");
        assert_eq!(
            reopened
                .projection_initialization_state(&record.project_id)
                .expect("durable ready authority"),
            ProjectionInitializationState::Ready
        );
        projection
            .require_existing_project(&record.project_id)
            .expect("durable project identity exists after ready transition");
        std::fs::remove_dir_all(base).expect("cleanup");
    }

    #[test]
    fn folder_registration_retry_reuses_pending_then_ready_authority() {
        let base = std::env::temp_dir().join(format!(
            "orquesta-command-projection-retry-{}",
            uuid::Uuid::new_v4()
        ));
        let root = base.join("project");
        std::fs::create_dir_all(&root).expect("create project root");
        let registry_path = base.join("state").join("projects.v1.json");
        let mut registry = ProjectRegistry::open(registry_path).expect("open registry");
        let first = registry
            .register_read_only_named(root.to_str().expect("project utf8"), None)
            .expect("register project");
        let retry = registry
            .register_read_only_named(root.to_str().expect("project utf8"), None)
            .expect("retry project registration");
        assert_eq!(first.project_id, retry.project_id);
        assert_eq!(
            registry
                .projection_initialization_state(&first.project_id)
                .expect("pending state"),
            ProjectionInitializationState::Pending
        );

        let projection = projection_test_service(&base);
        prepare_registered_project_projection_sync(&mut registry, &projection, &first.project_id)
            .expect("initialize and commit ready state");
        let reopened = registry
            .register_read_only_named(root.to_str().expect("project utf8"), None)
            .expect("reopen ready registration");
        assert_eq!(reopened.project_id, first.project_id);
        prepare_registered_project_projection_sync(&mut registry, &projection, &first.project_id)
            .expect("ready registration requires existing SQLite");
        assert_eq!(
            registry
                .projection_initialization_state(&first.project_id)
                .expect("ready state"),
            ProjectionInitializationState::Ready
        );
        std::fs::remove_dir_all(base).expect("cleanup");
    }

    #[test]
    fn ready_registry_authority_fails_closed_when_durable_sqlite_disappears() {
        let base = std::env::temp_dir().join(format!(
            "orquesta-command-projection-missing-{}",
            uuid::Uuid::new_v4()
        ));
        let root = base.join("project");
        std::fs::create_dir_all(&root).expect("create project root");
        let mut registry = ProjectRegistry::open(base.join("state").join("projects.v1.json"))
            .expect("open registry");
        let record = registry
            .register_read_only_named(root.to_str().expect("project utf8"), None)
            .expect("register project");
        let projection = projection_test_service(&base);
        prepare_registered_project_projection_sync(&mut registry, &projection, &record.project_id)
            .expect("initialize project");
        let projection_root = base.join("app-data").join("projection");
        for entry in std::fs::read_dir(&projection_root).expect("read projection root") {
            let path = entry.expect("projection entry").path();
            if path.is_dir() {
                std::fs::remove_dir_all(path).expect("remove durable project SQLite directory");
            }
        }

        let error = prepare_registered_project_projection_sync(
            &mut registry,
            &projection,
            &record.project_id,
        )
        .expect_err("ready project must not recreate missing SQLite");
        assert_eq!(error.code, "projection_database_missing");
        assert_eq!(
            registry
                .projection_initialization_state(&record.project_id)
                .expect("ready remains authoritative"),
            ProjectionInitializationState::Ready
        );
        std::fs::remove_dir_all(base).expect("cleanup");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn creation_command_mutex_replays_same_operation_without_a_second_picker() {
        let (base, parent, registry_path) = starter_lock_test_paths("same-operation");
        let registry = std::sync::Arc::new(Mutex::new(
            ProjectRegistry::open(registry_path).expect("open registry"),
        ));
        let creation_lock = std::sync::Arc::new(Mutex::new(()));
        let picker_count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let picker_probe = std::sync::Arc::new(PickerConcurrencyProbe::new(false));
        let input = StarterProjectInput {
            operation_ref: uuid::Uuid::new_v4().hyphenated().to_string(),
            project_name: "並行作成".into(),
        };

        let first = tokio::spawn(invoke_starter_through_creation_lock(
            creation_lock.clone(),
            registry.clone(),
            parent.clone(),
            input.clone(),
            picker_count.clone(),
            picker_probe.clone(),
        ));
        let second = tokio::spawn(invoke_starter_through_creation_lock(
            creation_lock,
            registry.clone(),
            parent.clone(),
            input,
            picker_count.clone(),
            picker_probe.clone(),
        ));
        let first = first.await.expect("first task").expect("first create");
        let second = second
            .await
            .expect("second task")
            .expect("same operation replay");

        assert_eq!(first, second);
        assert_eq!(picker_count.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(
            picker_probe
                .maximum
                .load(std::sync::atomic::Ordering::SeqCst),
            1
        );
        assert_eq!(registry.lock().await.list().len(), 1);
        assert!(parent.join("並行作成").is_dir());
        std::fs::remove_dir_all(base).expect("cleanup");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn creation_command_mutex_serializes_different_operations_for_one_target() {
        let (base, parent, registry_path) = starter_lock_test_paths("different-operations");
        let registry = std::sync::Arc::new(Mutex::new(
            ProjectRegistry::open(registry_path).expect("open registry"),
        ));
        let creation_lock = std::sync::Arc::new(Mutex::new(()));
        let picker_count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let picker_probe = std::sync::Arc::new(PickerConcurrencyProbe::new(true));
        let input_for = || StarterProjectInput {
            operation_ref: uuid::Uuid::new_v4().hyphenated().to_string(),
            project_name: "同じ保存先".into(),
        };

        let first = tokio::spawn(invoke_starter_through_creation_lock(
            creation_lock.clone(),
            registry.clone(),
            parent.clone(),
            input_for(),
            picker_count.clone(),
            picker_probe.clone(),
        ));
        picker_probe.first_entered.notified().await;
        let second_attempted = std::sync::Arc::new(tokio::sync::Notify::new());
        let attempted = second_attempted.clone();
        let second_registry = registry.clone();
        let second_parent = parent.clone();
        let second_picker_count = picker_count.clone();
        let second_picker_probe = picker_probe.clone();
        let second_input = input_for();
        let second = tokio::spawn(async move {
            attempted.notify_one();
            invoke_starter_through_creation_lock(
                creation_lock,
                second_registry,
                second_parent,
                second_input,
                second_picker_count,
                second_picker_probe,
            )
            .await
        });
        second_attempted.notified().await;
        tokio::task::yield_now().await;
        assert_eq!(
            picker_probe
                .active
                .load(std::sync::atomic::Ordering::SeqCst),
            1
        );
        assert_eq!(
            picker_probe
                .maximum
                .load(std::sync::atomic::Ordering::SeqCst),
            1
        );
        picker_probe.release_first.notify_one();
        let results = [
            first.await.expect("first task"),
            second.await.expect("second task"),
        ];
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        let error = results
            .iter()
            .find_map(|result| result.as_ref().err())
            .expect("one explicit conflict");
        assert_eq!(error.code, "project_creation_target_exists");
        assert_eq!(picker_count.load(std::sync::atomic::Ordering::SeqCst), 2);
        assert_eq!(
            picker_probe
                .maximum
                .load(std::sync::atomic::Ordering::SeqCst),
            1
        );
        assert_eq!(registry.lock().await.list().len(), 1);
        assert_eq!(std::fs::read_dir(&parent).expect("read parent").count(), 1);
        std::fs::remove_dir_all(base).expect("cleanup");
    }

    struct RendererRegistryTestRoot(PathBuf);

    impl RendererRegistryTestRoot {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "orquesta-renderer-registry-test-{}",
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir(&root).expect("create renderer registry test root");
            Self(root)
        }

        fn state_path(&self) -> PathBuf {
            self.0.join("renderer-sessions.v1.json")
        }
    }

    impl Drop for RendererRegistryTestRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn renderer_session(id: &str, generation: u64, predecessor: Option<&str>) -> RendererSession {
        RendererSession {
            session_id: id.into(),
            generation,
            window_label: "main".into(),
            predecessor_id: predecessor.map(str::to_owned),
            phase: SessionPhase::Active,
        }
    }

    #[test]
    fn renderer_registry_persists_exact_pending_admission_and_terminal_predecessor() {
        let root = RendererRegistryTestRoot::new();
        let state_path = root.state_path();
        let first_id = "11111111-1111-4111-8111-111111111111";
        let second_id = "22222222-2222-4222-8222-222222222222";
        let mut registry = RendererSessionRegistry::open(state_path.clone()).unwrap();
        registry
            .transact(|registry| {
                registry.next_generation = 1;
                registry.current = Some(renderer_session(first_id, 1, None));
                Ok(())
            })
            .unwrap();
        registry
            .transact(|registry| {
                registry.next_generation = 2;
                registry.pending_open = Some(renderer_session(second_id, 2, Some(first_id)));
                Ok(())
            })
            .unwrap();
        drop(registry);

        let mut recovered = RendererSessionRegistry::open(state_path.clone()).unwrap();
        assert_eq!(
            recovered
                .pending_open
                .as_ref()
                .map(|value| value.session_id.as_str()),
            Some(second_id)
        );
        assert_eq!(recovered.recovery_previous_session_id(), Some(first_id));
        assert_eq!(
            recovered
                .begin_cancel(second_id, None, "main", None)
                .unwrap(),
            RendererCancelTransition::Resolved { cancelled: false }
        );
        recovered
            .transact(|registry| {
                let pending = registry.pending_open.take().unwrap();
                let predecessor = registry.current.take().unwrap();
                registry.retire(predecessor.session_id)?;
                registry.current = Some(pending);
                Ok(())
            })
            .unwrap();
        assert!(matches!(
            recovered
                .begin_cancel(second_id, None, "main", None)
                .unwrap(),
            RendererCancelTransition::Closing {
                session: RendererSession {
                    generation: 2,
                    phase: SessionPhase::Active,
                    ..
                },
                authority: None,
            }
        ));
        assert_eq!(
            recovered.current.as_ref().map(|value| value.phase),
            Some(SessionPhase::Closing)
        );
        recovered
            .transact(|registry| {
                let current = registry.current.take().unwrap();
                registry.retire(current.session_id.clone())?;
                registry.recovery_predecessor = Some(current);
                Ok(())
            })
            .unwrap();
        drop(recovered);

        let terminal = RendererSessionRegistry::open(state_path).unwrap();
        assert!(terminal.current.is_none());
        assert!(terminal.pending_open.is_none());
        assert_eq!(terminal.recovery_previous_session_id(), Some(second_id));
        assert!(terminal.retired.contains(first_id));
        assert!(terminal.retired.contains(second_id));
    }

    #[test]
    fn renderer_registry_rejects_pending_admission_without_exact_native_predecessor() {
        let root = RendererRegistryTestRoot::new();
        let state_path = root.state_path();
        let first_id = "11111111-1111-4111-8111-111111111111";
        let foreign_id = "99999999-9999-4999-8999-999999999999";
        let pending_id = "22222222-2222-4222-8222-222222222222";
        let document = RendererSessionRegistryDocument {
            schema_version: 1,
            current: Some(renderer_session(first_id, 1, None)),
            pending_open: Some(renderer_session(pending_id, 2, Some(foreign_id))),
            recovery_predecessor: None,
            retired_order: VecDeque::new(),
            next_generation: 2,
        };
        materialize_sentinel(&state_path, &document).unwrap();
        atomic_write_json(&state_path, &document).unwrap();
        let error = RendererSessionRegistry::open(state_path)
            .expect_err("foreign renderer hint must not become Native authority");
        assert_eq!(error.code, "renderer_session_identity_invalid");
        assert!(error.outcome_unknown);
    }

    #[test]
    fn renderer_registry_rolls_back_memory_when_a_transaction_update_fails() {
        let root = RendererRegistryTestRoot::new();
        let state_path = root.state_path();
        let first_id = "11111111-1111-4111-8111-111111111111";
        let mut registry = RendererSessionRegistry::open(state_path.clone()).unwrap();
        registry
            .transact(|registry| {
                registry.next_generation = 1;
                registry.current = Some(renderer_session(first_id, 1, None));
                Ok(())
            })
            .unwrap();
        let before = registry.document();

        let error = registry
            .transact(|registry| {
                registry.current.take();
                registry.next_generation = 99;
                Err::<(), _>(AppError::new(
                    "injected_renderer_transaction_failure",
                    "injected mutation failure",
                ))
            })
            .expect_err("failed transaction must not retain partial memory mutation");
        assert_eq!(error.code, "injected_renderer_transaction_failure");
        assert_eq!(
            serde_json::to_value(registry.document()).unwrap(),
            serde_json::to_value(before).unwrap()
        );
        drop(registry);
        let reopened = RendererSessionRegistry::open(state_path).unwrap();
        assert_eq!(
            reopened
                .current
                .as_ref()
                .map(|value| value.session_id.as_str()),
            Some(first_id)
        );
        assert_eq!(reopened.next_generation, 1);
    }

    #[test]
    fn renderer_registry_compacts_only_unreferenced_tombstones_without_bricking() {
        let root = RendererRegistryTestRoot::new();
        let state_path = root.state_path();
        let recovery_id = "11111111-1111-4111-8111-111111111111";
        let mut registry = RendererSessionRegistry::open(state_path.clone()).unwrap();
        let first_compactable = "00000001-0000-4000-8000-000000000001".to_owned();
        registry
            .transact(|registry| {
                registry.next_generation = 1;
                registry.recovery_predecessor = Some(renderer_session(recovery_id, 1, None));
                registry.retire(recovery_id.into())?;
                for index in 1..MAX_RETIRED_RENDERER_SESSIONS {
                    registry.retire(format!("{index:08x}-0000-4000-8000-{index:012x}"))?;
                }
                Ok(())
            })
            .unwrap();
        assert_eq!(registry.retired_order.len(), MAX_RETIRED_RENDERER_SESSIONS);

        let newest = "ffffffff-ffff-4fff-8fff-ffffffffffff".to_owned();
        registry
            .transact(|registry| registry.retire(newest.clone()))
            .unwrap();
        assert_eq!(registry.retired_order.len(), MAX_RETIRED_RENDERER_SESSIONS);
        assert!(registry.retired.contains(recovery_id));
        assert!(registry.retired.contains(&newest));
        assert!(!registry.retired.contains(&first_compactable));
        drop(registry);

        let reopened = RendererSessionRegistry::open(state_path).unwrap();
        assert_eq!(reopened.retired_order.len(), MAX_RETIRED_RENDERER_SESSIONS);
        assert!(reopened.retired.contains(recovery_id));
        assert!(reopened.retired.contains(&newest));
    }

    fn fixtures() -> Value {
        serde_json::from_str(include_str!(
            "../../../../packages/contracts/desktop/fixtures/native-bridge-fixtures.v1.json"
        ))
        .expect("native bridge fixtures JSON")
    }

    fn assert_input_round_trip<T>(fixture: &Value)
    where
        T: serde::de::DeserializeOwned + Serialize,
    {
        let golden = fixture
            .get("args")
            .and_then(|value| value.get("input"))
            .expect("command input fixture")
            .clone();
        let parsed: BridgeInput<T> = serde_json::from_value(golden.clone())
            .expect("fixture must deserialize through strict native input");
        assert_eq!(
            serde_json::to_value(parsed).expect("input serialization"),
            golden
        );
    }

    fn assert_response_round_trip<T>(fixture: &Value)
    where
        T: serde::de::DeserializeOwned + Serialize,
    {
        let golden = fixture
            .get("response")
            .expect("command response fixture")
            .clone();
        let parsed: BridgeResponse<T> = serde_json::from_value(golden.clone())
            .expect("fixture must deserialize through native response");
        assert_eq!(parsed.schema_version, NATIVE_BRIDGE_SCHEMA_VERSION);
        assert_eq!(
            serde_json::to_value(parsed).expect("response serialization"),
            golden
        );
    }

    #[test]
    fn all_command_fixtures_round_trip_exact_native_dtos() {
        let document = fixtures();
        let fixtures = document
            .pointer("/commands")
            .and_then(Value::as_object)
            .expect("command fixtures");
        macro_rules! contract {
            ($key:literal, $input:ty, $output:ty) => {{
                let fixture = fixtures.get($key).expect(concat!("missing fixture ", $key));
                assert_input_round_trip::<$input>(fixture);
                assert_response_round_trip::<$output>(fixture);
            }};
        }

        contract!(
            "openRendererSession",
            RendererSessionOpenInput,
            RendererSessionOpenResult
        );
        contract!(
            "cancelRendererSession",
            RendererSessionCancelInput,
            RendererSessionCancelResult
        );
        contract!("bootstrap", SessionInput, NativeBootstrap);
        contract!("updateSettings", SettingsUpdateInput, NativeSettings);
        contract!("reconcileRuntimeSession", SessionInput, NativeBootstrap);
        contract!("listProjects", SessionInput, Vec<ProjectRecord>);
        contract!(
            "recordLastWorkAgent",
            ProjectLastWorkAgentInput,
            ProjectRecord
        );
        contract!("openProjectFolder", SessionInput, Option<ProjectRecord>);
        contract!(
            "createStarterProject",
            ProjectCreateStarterInput,
            Option<ProjectRecord>
        );
        contract!(
            "activateProject",
            ProjectActivateInput,
            ProjectActivationResult
        );
        contract!("stopRuntime", RuntimeStopInput, RuntimeStatus);
        contract!("voiceStatus", SessionInput, VoiceStatus);
        contract!("acquireVoiceAsset", VoiceAssetInput, VoiceStatus);
        contract!(
            "cancelVoiceAssetAcquisition",
            VoiceOperationInput,
            VoiceStatus
        );
        contract!("deleteVoiceAsset", VoiceAssetInput, VoiceStatus);
        contract!(
            "beginAttachmentImport",
            AttachmentImportBeginInput,
            AttachmentImportResult
        );
        assert_response_round_trip::<AttachmentImportStageResult>(
            fixtures
                .get("stageAttachmentBytes")
                .expect("missing fixture stageAttachmentBytes"),
        );
        contract!(
            "finishAttachmentImport",
            AttachmentImportFinishInput,
            AttachmentImportResult
        );
        assert_input_round_trip::<AttachmentPreviewInput>(
            fixtures
                .get("readAttachmentPreview")
                .expect("missing fixture readAttachmentPreview"),
        );
        contract!("forgetAttachment", AttachmentForgetInput, ());
        contract!("abandonAttachmentSelection", AttachmentSelectionInput, ());
        contract!("runtimeSend", RuntimeSendInput, RuntimeSendResult);
        contract!(
            "interruptTurn",
            RuntimeTurnInterruptInput,
            RuntimeTurnInterruptResult
        );
        contract!("steerTurn", RuntimeTurnSteerInput, RuntimeTurnSteerResult);
        contract!("runtimeCall", RuntimeCallInput, Value);
        contract!(
            "projectionConversation",
            ProjectionConversationCommandInput,
            ProjectionConversationSnapshot
        );
        contract!(
            "projectionHistoryIndex",
            ProjectionHistoryIndexCommandInput,
            ProjectionHistoryIndexPage
        );
        contract!(
            "projectionHistoryPage",
            ProjectionHistoryPageCommandInput,
            ProjectionHistoryPage
        );
        contract!(
            "readDispatchRecovery",
            SessionInput,
            Option<DispatchRecoveryStatus>
        );
        contract!(
            "reconcileDispatchRecovery",
            DispatchReconcileInput,
            RuntimeSendResult
        );
        let cleanup = document
            .pointer("/scenarios/cleanupPendingReconcile")
            .expect("cleanup-only reconcile fixture");
        assert_input_round_trip::<DispatchReconcileInput>(cleanup);
        assert_response_round_trip::<RuntimeSendResult>(cleanup);

        let read_only_ready = document
            .pointer("/scenarios/readOnlyReadyStatus/status")
            .cloned()
            .expect("Ready/no-authority status fixture");
        let parsed: RuntimeStatus = serde_json::from_value(read_only_ready.clone())
            .expect("Ready/no-authority status must deserialize through the native DTO");
        assert_eq!(parsed.phase, RuntimePhase::Ready);
        assert!(parsed.runtime_generation.is_some());
        assert_eq!(
            serde_json::to_value(parsed).expect("status serialization"),
            read_only_ready
        );
    }

    #[test]
    fn attachment_forget_rejects_unknown_inner_fields() {
        let mut input = fixtures()
            .pointer("/commands/forgetAttachment/args/input")
            .cloned()
            .expect("attachment forget fixture");
        input
            .as_object_mut()
            .expect("attachment forget input object")
            .insert("unexpected".into(), Value::Bool(true));
        assert!(serde_json::from_value::<BridgeInput<AttachmentForgetInput>>(input).is_err());
    }

    #[test]
    fn bridge_inputs_reject_unknown_or_wrong_version_fields() {
        let document = fixtures();
        let mut golden = document
            .pointer("/commands/openRendererSession/args/input")
            .cloned()
            .expect("open input");
        golden
            .as_object_mut()
            .expect("object")
            .insert("unexpectedBypass".into(), Value::Bool(true));
        assert!(serde_json::from_value::<BridgeInput<RendererSessionOpenInput>>(golden).is_err());

        let mut wrong_version = document
            .pointer("/commands/openRendererSession/args/input")
            .cloned()
            .expect("open input");
        wrong_version
            .as_object_mut()
            .expect("object")
            .insert("schemaVersion".into(), Value::from(2));
        assert!(
            serde_json::from_value::<BridgeInput<RendererSessionOpenInput>>(wrong_version).is_err()
        );
    }

    #[test]
    fn raw_attachment_headers_require_one_exact_authority_value_and_json_body_is_rejected() {
        use tauri::http::{HeaderMap, HeaderValue};

        let mut headers = HeaderMap::new();
        headers.insert("x-orquesta-schema-version", HeaderValue::from_static("1"));
        headers.insert(
            "x-orquesta-renderer-session-id",
            HeaderValue::from_static("11111111-1111-4111-8111-111111111111"),
        );
        headers.insert(
            "x-orquesta-renderer-generation",
            HeaderValue::from_static("7"),
        );
        headers.insert(
            "x-orquesta-selection-id",
            HeaderValue::from_static("44444444-4444-4444-8444-444444444444"),
        );
        headers.insert(
            "x-orquesta-slot-id",
            HeaderValue::from_static("77777777-7777-4777-8777-777777777777"),
        );
        let parsed = parse_attachment_raw_headers(&headers).expect("exact raw headers");
        assert_eq!(parsed.renderer_generation, 7);

        headers.append(
            "x-orquesta-selection-id",
            HeaderValue::from_static("44444444-4444-4444-8444-444444444444"),
        );
        assert_eq!(
            parse_attachment_raw_headers(&headers)
                .expect_err("even a duplicate equal authority header must fail")
                .code,
            "attachment_import_header_invalid"
        );
        assert_eq!(
            raw_attachment_body(&InvokeBody::Json(Value::Array(vec![Value::from(1)])))
                .expect_err("JSON byte arrays must not enter the raw import")
                .code,
            "attachment_import_raw_required"
        );
        assert_eq!(
            raw_attachment_body(&InvokeBody::Raw(vec![1, 2, 3])).expect("raw bytes"),
            &[1, 2, 3]
        );
    }

    #[test]
    fn raw_voice_headers_bind_exact_agent_or_launcher_composer_identity() {
        use tauri::http::{HeaderMap, HeaderValue};

        let mut headers = HeaderMap::new();
        for (name, value) in [
            ("x-orquesta-schema-version", "1"),
            (
                "x-orquesta-renderer-session-id",
                "11111111-1111-4111-8111-111111111111",
            ),
            ("x-orquesta-renderer-generation", "7"),
            (
                "x-orquesta-operation-ref",
                "88888888-8888-4888-8888-888888888888",
            ),
            ("x-orquesta-sample-rate-hz", "16000"),
            ("x-orquesta-channel-count", "1"),
            ("x-orquesta-sample-format", "pcm-s16le"),
            ("x-orquesta-sample-count", "1600"),
            ("x-orquesta-composer-target", "agent"),
            (
                "x-orquesta-composer-draft-sha256",
                "1111111111111111111111111111111111111111111111111111111111111111",
            ),
            ("x-orquesta-composer-project-id", "project-1"),
            ("x-orquesta-composer-agent-id", "orchestrator"),
            (
                "x-orquesta-runtime-activation-token",
                "22222222-2222-4222-8222-222222222222",
            ),
        ] {
            headers.insert(
                name,
                HeaderValue::from_str(value).expect("valid header fixture"),
            );
        }
        let parsed = parse_voice_raw_headers(&headers).expect("exact agent binding headers");
        assert!(matches!(
            parsed.composer_binding,
            VoiceComposerBinding::Agent { ref project_id, ref agent_id, .. }
                if project_id == "project-1" && agent_id == "orchestrator"
        ));
        assert_eq!(
            parsed
                .runtime_authority
                .as_ref()
                .map(|value| value.project_id.as_str()),
            Some("project-1")
        );

        headers.append(
            "x-orquesta-composer-agent-id",
            HeaderValue::from_static("orchestrator"),
        );
        assert_eq!(
            parse_voice_raw_headers(&headers)
                .expect_err("duplicate equal agent binding must fail")
                .code,
            "voice_pcm_header_invalid"
        );
        headers.remove("x-orquesta-composer-agent-id");
        headers.insert(
            "x-orquesta-composer-target",
            HeaderValue::from_static("launcher"),
        );
        assert_eq!(
            parse_voice_raw_headers(&headers)
                .expect_err("launcher cannot carry project authority")
                .code,
            "voice_composer_binding_invalid"
        );
    }

    #[test]
    fn event_fixtures_round_trip_exact_routing_envelopes() {
        let document = fixtures();
        let status = document
            .pointer("/events/runtimeStatus")
            .cloned()
            .expect("status event");
        let parsed: crate::sidecar::RuntimeStatusEventEnvelope =
            serde_json::from_value(status.clone()).expect("status envelope");
        assert_eq!(
            serde_json::to_value(parsed).expect("status serialization"),
            status
        );

        let event = document
            .pointer("/events/runtimeEvent")
            .cloned()
            .expect("runtime event");
        let parsed: crate::sidecar::RuntimeEventEnvelope =
            serde_json::from_value(event.clone()).expect("runtime envelope");
        assert_eq!(
            serde_json::to_value(parsed).expect("event serialization"),
            event
        );
    }

    #[test]
    fn p2d_native_state_is_the_only_tauri_managed_facade() {
        let source = include_str!("lib.rs");
        assert!(source.contains("app.manage(native);"));
        assert!(!source.contains("manage(native.projection"));
        assert!(!source.contains("state::<ProjectionService>"));
    }

    #[test]
    fn rootless_bootstrap_keeps_the_project_path_inside_core_authority() {
        assert!(!core_method_requires_selected_root("project.bootstrap"));
        assert!(core_method_requires_selected_root("workflow.catalog.read"));
        assert!(!core_method_requires_selected_root(
            "repository.get-snapshot"
        ));

        let mut bootstrap = serde_json::json!({"projectId": "project-a"});
        inject_selected_project_root("project.bootstrap", &mut bootstrap, None).unwrap();
        assert!(bootstrap.get("rootPath").is_none());

        let mut workflow = serde_json::json!({"projectId": "project-a"});
        inject_selected_project_root(
            "workflow.catalog.read",
            &mut workflow,
            Some("C:/owned/project"),
        )
        .unwrap();
        assert_eq!(workflow["rootPath"], "C:/owned/project");
        assert_eq!(
            inject_selected_project_root("workflow.catalog.read", &mut workflow, None)
                .expect_err("selected-root methods fail closed without Native authority")
                .code,
            "runtime_root_authority_missing"
        );
    }

    fn runtime_status_for_test() -> RuntimeStatus {
        RuntimeStatus {
            phase: RuntimePhase::Ready,
            runtime_generation: Some("33333333-3333-4333-8333-333333333333".into()),
            status_revision: 7,
            pid: Some(42),
            started_at_ms: Some(1),
            active_project_id: Some("project-a".into()),
            authority_activation_token: None,
            authority_renderer_session_id: None,
            authority_renderer_generation: None,
            process_termination_confirmed: false,
            last_error: None,
        }
    }

    #[test]
    fn recent_project_forget_rejects_only_the_active_runtime_project() {
        assert_eq!(
            ensure_recent_project_is_inactive(Some("project-a"), "project-a")
                .expect_err("active runtime project must remain visible")
                .code,
            "project_recent_forget_active"
        );
        assert!(ensure_recent_project_is_inactive(Some("project-a"), "project-b").is_ok());
        assert!(ensure_recent_project_is_inactive(None, "project-a").is_ok());
    }

    #[test]
    fn runtime_compare_and_confirmed_stop_require_every_exact_axis() {
        let generation = "33333333-3333-4333-8333-333333333333";
        assert!(verify_runtime_compare(runtime_status_for_test(), 7, Some(generation)).is_ok());
        for (revision, candidate_generation) in [
            (8, Some(generation)),
            (7, Some("44444444-4444-4444-8444-444444444444")),
        ] {
            assert_eq!(
                verify_runtime_compare(runtime_status_for_test(), revision, candidate_generation)
                    .expect_err("every stale compare axis must fail")
                    .code,
                "runtime_compare_failed"
            );
        }

        let mut stopped = runtime_status_for_test();
        stopped.phase = RuntimePhase::Stopped;
        stopped.process_termination_confirmed = true;
        assert!(is_exact_confirmed_stop(&stopped, generation));
        for candidate in [
            RuntimeStatus {
                phase: RuntimePhase::Ready,
                ..stopped.clone()
            },
            RuntimeStatus {
                runtime_generation: Some("44444444-4444-4444-8444-444444444444".into()),
                ..stopped.clone()
            },
            RuntimeStatus {
                process_termination_confirmed: false,
                ..stopped.clone()
            },
        ] {
            assert!(!is_exact_confirmed_stop(&candidate, generation));
        }
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn runtime_project_reverify_uses_the_live_registry_identity() {
        let (base, project_root, registry_path) = starter_lock_test_paths("runtime-reverify");
        let record = ProjectRegistry::open(registry_path.clone())
            .and_then(|mut registry| {
                registry.register_read_only_named(&project_root.to_string_lossy(), Some("Live"))
            })
            .expect("register exact project root");
        let registry = Arc::new(Mutex::new(
            ProjectRegistry::open(registry_path).expect("reopen live registry"),
        ));
        let authority = RuntimeAuthority {
            project_id: record.project_id.clone(),
            activation_token: "11111111-1111-4111-8111-111111111111".into(),
            renderer_session_id: "22222222-2222-4222-8222-222222222222".into(),
            renderer_generation: 1,
            window_label: "main".into(),
        };
        let params = serde_json::json!({"projectId": record.project_id});
        assert_eq!(
            reverify_runtime_project_authority(
                &registry,
                &authority,
                ProjectRequirement::Activated,
                &params,
                Some(&record),
            )
            .await
            .expect("live registry identity matches"),
            Some(record.clone())
        );
        assert_eq!(
            reverify_runtime_project_authority(
                &registry,
                &authority,
                ProjectRequirement::InternalRoot,
                &serde_json::json!({
                    "projectId": authority.project_id.clone(),
                    "rootPath": project_root.to_string_lossy(),
                }),
                Some(&record),
            )
            .await
            .expect_err("renderer-supplied root must not compete with Native registry authority")
            .code,
            "runtime_renderer_root_forbidden"
        );
        let mut stale = record;
        stale.root_identity_v2 = Some("v2:stale".into());
        assert_eq!(
            reverify_runtime_project_authority(
                &registry,
                &authority,
                ProjectRequirement::Activated,
                &params,
                Some(&stale),
            )
            .await
            .expect_err("stale root snapshot must fail after the Core call")
            .code,
            "runtime_root_authority_mismatch"
        );
        std::fs::remove_dir_all(base).expect("cleanup runtime reverify root");
    }

    #[test]
    fn runtime_call_combiner_preserves_core_failure_and_marks_only_completed_mutation_unknown() {
        let core_error = AppError::new("core_failed", "core failed");
        let authority_error = || AppError::new("runtime_root_authority_mismatch", "stale root");
        assert_eq!(
            combine_runtime_call_result(
                Err(core_error),
                Err(authority_error()),
                MutationKind::Lifecycle,
                "project.bootstrap",
                RecoveryStrategy::ProjectBootstrapSaga,
            )
            .expect_err("Core failure is primary")
            .code,
            "core_failed"
        );
        assert_eq!(
            combine_runtime_call_result(
                Ok(serde_json::json!({"ok": true})),
                Err(authority_error()),
                MutationKind::ReadOnly,
                "workflow.catalog.read",
                RecoveryStrategy::None,
            )
            .expect_err("read-only postcheck failure stays ordinary")
            .outcome_unknown,
            false
        );
        let unknown = combine_runtime_call_result(
            Ok(serde_json::json!({"ok": true})),
            Err(authority_error()),
            MutationKind::Lifecycle,
            "project.bootstrap",
            RecoveryStrategy::ProjectBootstrapSaga,
        )
        .expect_err("completed mutation with stale authority is unknown");
        assert!(unknown.outcome_unknown);
        assert_eq!(unknown.details.as_ref().unwrap()["coreCompleted"], true);
        assert_eq!(
            combine_runtime_call_result(
                Ok(serde_json::json!({"ok": true})),
                Ok(()),
                MutationKind::ReadOnly,
                "workflow.catalog.read",
                RecoveryStrategy::None,
            )
            .unwrap()["ok"],
            true
        );
    }

    #[test]
    fn exact_turn_mutation_identities_ignore_runtime_generation() {
        let stop_a = RuntimeTurnInterruptInput {
            renderer_session_id: "renderer-a".into(),
            renderer_generation: 1,
            project_id: "project-a".into(),
            activation_token: "activation-a".into(),
            runtime_generation: "runtime-a".into(),
            expected_status_revision: 1,
            target_agent_id: "orchestrator".into(),
            thread_id: "thread-a".into(),
            turn_id: "turn-a".into(),
        };
        let mut stop_b = stop_a.clone();
        stop_b.runtime_generation = "runtime-b".into();
        assert_eq!(
            interrupt_claim_identity(&stop_a),
            interrupt_claim_identity(&stop_b)
        );

        let steer_a = RuntimeTurnSteerInput {
            renderer_session_id: "renderer-a".into(),
            renderer_generation: 1,
            project_id: "project-a".into(),
            activation_token: "activation-a".into(),
            runtime_generation: "runtime-a".into(),
            expected_status_revision: 1,
            steer_id: "steer-a".into(),
            target_agent_id: "orchestrator".into(),
            thread_id: "thread-a".into(),
            turn_id: "turn-a".into(),
            text: "first".into(),
        };
        let mut steer_b = steer_a.clone();
        steer_b.runtime_generation = "runtime-b".into();
        assert_eq!(
            steer_claim_identity(&steer_a),
            steer_claim_identity(&steer_b)
        );
        steer_b.text = "changed".into();
        assert_ne!(
            steer_claim_identity(&steer_a),
            steer_claim_identity(&steer_b)
        );
    }

    #[test]
    fn post_provider_persistence_failures_are_always_outcome_unknown() {
        let wrapped = turn_mutation_persistence_error(
            AppError::new("projection_sqlite_failed", "disk write failed")
                .retryable(true)
                .with_details(serde_json::json!({"operation": "markAccepted"})),
        );
        assert_eq!(wrapped.code, "projection_sqlite_failed");
        assert_eq!(wrapped.message, "disk write failed");
        assert!(wrapped.retryable);
        assert!(wrapped.outcome_unknown);
        assert_eq!(
            wrapped.details,
            Some(serde_json::json!({"operation": "markAccepted"}))
        );
    }

    #[test]
    fn turn_mutation_action_keeps_stop_replay_and_steer_rejection_distinct() {
        let stop = TurnMutationAction::Interrupt(RuntimeTurnInterruptInput {
            renderer_session_id: "renderer-a".into(),
            renderer_generation: 1,
            project_id: "project-a".into(),
            activation_token: "activation-a".into(),
            runtime_generation: "runtime-a".into(),
            expected_status_revision: 1,
            target_agent_id: "orchestrator".into(),
            thread_id: "thread-a".into(),
            turn_id: "turn-a".into(),
        });
        let TurnMutationResponse::Interrupt(replayed) = stop
            .active_state_response("interrupting")
            .expect("Stop replay stays successful")
            .expect("interrupting state has a stop response")
        else {
            panic!("Stop must preserve its interrupt response type");
        };
        assert_eq!(replayed.status, "interrupting");

        let steer = TurnMutationAction::Steer(RuntimeTurnSteerInput {
            renderer_session_id: "renderer-a".into(),
            renderer_generation: 1,
            project_id: "project-a".into(),
            activation_token: "activation-a".into(),
            runtime_generation: "runtime-a".into(),
            expected_status_revision: 1,
            steer_id: "steer-a".into(),
            target_agent_id: "orchestrator".into(),
            thread_id: "thread-a".into(),
            turn_id: "turn-a".into(),
            text: "change course".into(),
        });
        let error = steer
            .active_state_response("interrupting")
            .expect_err("Steer remains rejected after Stop");
        assert_eq!(error.code, "runtime_turn_not_steerable");
    }

    #[test]
    fn turn_mutation_action_response_validation_is_kind_specific_and_fail_closed() {
        let stop = TurnMutationAction::Interrupt(RuntimeTurnInterruptInput {
            renderer_session_id: "renderer-a".into(),
            renderer_generation: 1,
            project_id: "project-a".into(),
            activation_token: "activation-a".into(),
            runtime_generation: "runtime-a".into(),
            expected_status_revision: 1,
            target_agent_id: "orchestrator".into(),
            thread_id: "thread-a".into(),
            turn_id: "turn-a".into(),
        });
        stop.validate_runtime_response(&serde_json::json!({
            "targetAgentId": "orchestrator",
            "threadId": "thread-a",
            "turnId": "turn-a",
        }))
        .expect("exact Stop acknowledgement is accepted");
        let error = stop
            .validate_runtime_response(&serde_json::json!({
                "targetAgentId": "orchestrator",
                "threadId": "thread-a",
                "turnId": "foreign-turn",
            }))
            .expect_err("mismatched Stop acknowledgement is not retry-safe");
        assert_eq!(error.code, "runtime_turn_interrupt_response_mismatch");
        assert!(error.outcome_unknown);

        let steer = TurnMutationAction::Steer(RuntimeTurnSteerInput {
            renderer_session_id: "renderer-a".into(),
            renderer_generation: 1,
            project_id: "project-a".into(),
            activation_token: "activation-a".into(),
            runtime_generation: "runtime-a".into(),
            expected_status_revision: 1,
            steer_id: "steer-a".into(),
            target_agent_id: "orchestrator".into(),
            thread_id: "thread-a".into(),
            turn_id: "turn-a".into(),
            text: "change course".into(),
        });
        let error = steer
            .validate_runtime_response(&serde_json::json!({
                "steerId": "foreign-steer",
                "targetAgentId": "orchestrator",
                "threadId": "thread-a",
                "turnId": "turn-a",
            }))
            .expect_err("Steer must verify its exact identity as well");
        assert_eq!(error.code, "runtime_turn_steer_response_mismatch");
        assert!(error.outcome_unknown);
    }
}
