use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::{oneshot, Mutex};

use crate::attachments::{AttachmentStore, ContainmentEvidence};
use crate::dispatch_recovery::{
    DispatchPhase, DispatchReceipt, DispatchRecoveryRecord, DispatchRecoveryStatus,
    DispatchRecoveryStore,
};
use crate::error::{AppError, AppResult};
use crate::logging::now_ms;
use crate::process_containment::{
    containment_definitively_gone_after_instance_lock, spawn_contained, ContainedProcessSpec,
    ContainedStdinMode, ProcessContainment,
};
use crate::projection_service::{DomainEventEnvelope, ProjectionService};
use crate::protocol::{
    RuntimeMethodPolicyDocument, SidecarRequest, SidecarResponse, MAX_FRAME_BYTES,
    NATIVE_BRIDGE_SCHEMA_VERSION,
};
use crate::storage::{atomic_write_json, load_primary_or_backup, materialize_sentinel};
use crate::validation::bounded_id;

pub const RUNTIME_STATUS_EVENT: &str = crate::protocol::GENERATED_NATIVE_EVENT_RUNTIME_STATUS;
pub const RUNTIME_EVENT_NAME: &str = crate::protocol::GENERATED_NATIVE_EVENT_RUNTIME_EVENT;
pub const DISPATCH_RECOVERY_CLEARED_EVENT: &str =
    crate::protocol::GENERATED_NATIVE_EVENT_DISPATCH_RECOVERY_CLEARED;
pub const PROJECTION_EVENT_NAME: &str = crate::protocol::GENERATED_NATIVE_EVENT_PROJECTION_CHANGED;
pub const PROJECTION_STATUS_EVENT: &str = crate::protocol::GENERATED_NATIVE_EVENT_PROJECTION_STATUS;
const BUSINESS_WORK_ORDERS_CAPABILITY: &str = "orquesta.business-work-orders.read";
const BUSINESS_WORK_ORDERS_REQUIRED_FEATURES: [&str; 5] = [
    "authoritative-lifecycle-mode.v1",
    "journal-prefix-continuity.v1",
    "provider-delivery-separate-from-acceptance.v1",
    "root-journal-all-business-project-refs.v1",
    "work-order-index.v1",
];

#[derive(Debug, Clone, Copy)]
pub(crate) enum DispatchAttemptKind {
    Initial { was_retry: bool },
    Reconcile,
}

pub(crate) struct DispatchSettlement {
    pub runtime_result: Value,
    pub dispatch_recovery: Option<DispatchRecoveryStatus>,
}

pub(crate) fn dispatch_error_with_status(
    mut error: AppError,
    status: Option<DispatchRecoveryStatus>,
) -> AppError {
    let mut details = error
        .details
        .take()
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    details.insert(
        "dispatchRecovery".into(),
        serde_json::to_value(status).unwrap_or(Value::Null),
    );
    error.details = Some(Value::Object(details));
    error
}

pub(crate) fn dispatch_receipt_from_runtime_result(
    runtime_result: &Value,
) -> AppResult<DispatchReceipt> {
    let thread_id = runtime_result
        .get("threadId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            AppError::new(
                "runtime_dispatch_receipt_invalid",
                "Runtime dispatch response did not contain a complete receipt",
            )
            .outcome_unknown(true)
        })?;
    let turn_id = runtime_result
        .get("turnId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            AppError::new(
                "runtime_dispatch_receipt_invalid",
                "Runtime dispatch response did not contain a complete receipt",
            )
            .outcome_unknown(true)
        })?;
    Ok(DispatchReceipt {
        thread_id: Some(bounded_id(thread_id, "receipt.threadId")?),
        turn_id: Some(bounded_id(turn_id, "receipt.turnId")?),
    })
}

pub(crate) fn preserve_unknown_dispatch(
    recovery: &mut DispatchRecoveryStore,
    message_id: &str,
    cause: AppError,
) -> AppError {
    let error = match recovery.mark_outcome_unknown(message_id) {
        Ok(_) => cause.outcome_unknown(true),
        Err(error) => AppError::recovery_lock(message_id, error.message),
    };
    dispatch_error_with_status(error, recovery.status_for_message(message_id))
}

fn node_environment_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let value = path.to_string_lossy();
        if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{}", rest));
        }
        if let Some(rest) = value.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }
    path.to_path_buf()
}

fn validate_sidecar_ready(response: &SidecarResponse) -> AppResult<()> {
    let expected_policy_digest = RuntimeMethodPolicyDocument::source_sha256();
    let capability = response
        .business_work_orders_capability
        .as_ref()
        .ok_or_else(|| {
            AppError::new(
                "runtime_capability_mismatch",
                "Runtime ready response is missing Business Work Order capability",
            )
        })?;
    let supports_required = BUSINESS_WORK_ORDERS_REQUIRED_FEATURES
        .iter()
        .all(|required| {
            capability
                .features
                .iter()
                .any(|feature| feature == required)
        });
    if response.policy_schema_version != Some(1)
        || response.policy_digest_sha256.as_deref() != Some(expected_policy_digest.as_str())
        || capability.name != BUSINESS_WORK_ORDERS_CAPABILITY
        || capability.major != 1
        || !supports_required
    {
        return Err(AppError::new(
            "runtime_capability_mismatch",
            "Runtime policy or Business Work Order capability does not match Desktop Next",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod ready_handshake_tests {
    use super::*;

    fn ready_response() -> SidecarResponse {
        SidecarResponse {
            protocol_version: NATIVE_BRIDGE_SCHEMA_VERSION,
            id: None,
            ok: None,
            result: None,
            error: None,
            event_type: Some("sidecar.ready".to_owned()),
            event: None,
            policy_schema_version: Some(1),
            policy_digest_sha256: Some(RuntimeMethodPolicyDocument::source_sha256()),
            business_work_orders_capability: Some(crate::protocol::BusinessWorkOrdersCapability {
                name: BUSINESS_WORK_ORDERS_CAPABILITY.to_owned(),
                major: 1,
                _minor: 99,
                features: BUSINESS_WORK_ORDERS_REQUIRED_FEATURES
                    .iter()
                    .map(|feature| (*feature).to_owned())
                    .chain(std::iter::once("forward-compatible-extra.v1".to_owned()))
                    .collect(),
            }),
        }
    }

    #[test]
    fn ready_handshake_accepts_only_the_current_policy_and_required_capabilities() {
        assert!(validate_sidecar_ready(&ready_response()).is_ok());

        let invalid_cases: [(&str, fn(&mut SidecarResponse)); 5] = [
            ("missing capability", |response| {
                response.business_work_orders_capability = None;
            }),
            ("wrong policy schema", |response| {
                response.policy_schema_version = Some(2);
            }),
            ("wrong policy digest", |response| {
                response.policy_digest_sha256 = Some("0".repeat(64));
            }),
            ("wrong capability name", |response| {
                response
                    .business_work_orders_capability
                    .as_mut()
                    .expect("capability")
                    .name = "orquesta.business-work-orders.write".to_owned();
            }),
            ("wrong capability major", |response| {
                response
                    .business_work_orders_capability
                    .as_mut()
                    .expect("capability")
                    .major = 2;
            }),
        ];
        for (case, mutate) in invalid_cases {
            let mut response = ready_response();
            mutate(&mut response);
            let error = validate_sidecar_ready(&response).expect_err(case);
            assert_eq!(error.code, "runtime_capability_mismatch", "{case}");
        }

        for missing in BUSINESS_WORK_ORDERS_REQUIRED_FEATURES {
            let mut response = ready_response();
            response
                .business_work_orders_capability
                .as_mut()
                .expect("capability")
                .features
                .retain(|feature| feature != missing);
            let error = validate_sidecar_ready(&response)
                .expect_err("missing required feature must fail closed");
            assert_eq!(
                error.code, "runtime_capability_mismatch",
                "missing {missing}"
            );
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuntimePhase {
    Stopped,
    Starting,
    Ready,
    Stopping,
    Faulted,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeAuthority {
    pub project_id: String,
    pub activation_token: String,
    pub renderer_session_id: String,
    pub renderer_generation: u64,
    pub window_label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub phase: RuntimePhase,
    pub runtime_generation: Option<String>,
    pub status_revision: u64,
    /// On Windows this is the containment-root launcher PID, not the nested
    /// runtime PID. The named Job remains the recovery authority.
    pub pid: Option<u32>,
    pub started_at_ms: Option<u64>,
    pub active_project_id: Option<String>,
    pub authority_activation_token: Option<String>,
    pub authority_renderer_session_id: Option<String>,
    pub authority_renderer_generation: Option<u64>,
    pub process_termination_confirmed: bool,
    pub last_error: Option<AppError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatusEventEnvelope {
    pub schema_version: u32,
    pub renderer_session_id: String,
    pub renderer_generation: u64,
    pub runtime_generation: Option<String>,
    pub status_revision: u64,
    pub status: RuntimeStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEventEnvelope {
    pub schema_version: u32,
    pub runtime_generation: String,
    pub status_revision: u64,
    pub renderer_session_id: String,
    pub renderer_generation: u64,
    pub project_id: String,
    pub activation_token: String,
    pub event: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeOwnerRecord {
    runtime_generation: String,
    /// Direct containment-root PID. On Windows the actual runtime is its child.
    pid: u32,
    containment_kind: String,
    containment_id: String,
    started_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeOwnerDocument {
    schema_version: u32,
    owner: Option<RuntimeOwnerRecord>,
}

impl Default for RuntimeOwnerDocument {
    fn default() -> Self {
        Self {
            schema_version: 1,
            owner: None,
        }
    }
}

#[derive(Clone)]
struct ProcessHandle {
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<ChildStdin>>,
    containment: ProcessContainment,
}

struct SupervisorState {
    phase: RuntimePhase,
    runtime_generation: Option<String>,
    provider_connection_id: Option<String>,
    revision: u64,
    pid: Option<u32>,
    started_at_ms: Option<u64>,
    authority: Option<RuntimeAuthority>,
    process: Option<ProcessHandle>,
    termination_confirmed: bool,
    last_error: Option<AppError>,
}

impl Default for SupervisorState {
    fn default() -> Self {
        Self {
            phase: RuntimePhase::Stopped,
            runtime_generation: None,
            provider_connection_id: None,
            revision: 0,
            pid: None,
            started_at_ms: None,
            authority: None,
            process: None,
            termination_confirmed: true,
            last_error: None,
        }
    }
}

impl SupervisorState {
    // Connection identity is an observation of this exact sidecar process, not
    // persisted history. Reading it never starts or probes the Provider.
    fn observed_provider_connection_id(&self) -> Option<String> {
        (self.phase == RuntimePhase::Ready)
            .then(|| self.provider_connection_id.clone())
            .flatten()
    }

    fn observe_provider_connection(&mut self, generation: &str, event: &Value) {
        if self.phase != RuntimePhase::Ready
            || self.runtime_generation.as_deref() != Some(generation)
            || event.get("type").and_then(Value::as_str) != Some("runtime.notification")
        {
            return;
        }
        let Some(notification) = event.get("notification") else {
            return;
        };
        if notification.get("kind").and_then(Value::as_str) != Some("provider_connection") {
            return;
        }
        let Some(id) = notification
            .get("providerConnectionId")
            .and_then(Value::as_str)
        else {
            return;
        };
        let Ok(id) = bounded_id(id, "providerConnectionId") else {
            return;
        };
        match notification.get("state").and_then(Value::as_str) {
            Some("connected") => self.provider_connection_id = Some(id),
            Some("disconnected") if self.provider_connection_id.as_ref() == Some(&id) => {
                self.provider_connection_id = None;
            }
            _ => {}
        }
    }

    fn revise(&mut self) {
        self.revision = self.revision.saturating_add(1);
    }
    fn status(&self) -> RuntimeStatus {
        RuntimeStatus {
            phase: self.phase,
            runtime_generation: self.runtime_generation.clone(),
            status_revision: self.revision,
            pid: self.pid,
            started_at_ms: self.started_at_ms,
            active_project_id: self
                .authority
                .as_ref()
                .map(|value| value.project_id.clone()),
            authority_activation_token: self
                .authority
                .as_ref()
                .map(|value| value.activation_token.clone()),
            authority_renderer_session_id: self
                .authority
                .as_ref()
                .map(|value| value.renderer_session_id.clone()),
            authority_renderer_generation: self
                .authority
                .as_ref()
                .map(|value| value.renderer_generation),
            process_termination_confirmed: self.termination_confirmed,
            last_error: self.last_error.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStartResult {
    pub status: RuntimeStatus,
    pub runtime_generation: String,
    pub started_here: bool,
}

#[derive(Clone)]
pub struct SidecarSupervisor {
    inner: Arc<SupervisorInner>,
}

// A start owns the generation it minted until it has returned a successful
// RuntimeStartResult.  Dropping the future at any earlier await boundary must
// not strand a Ready process with no authority.  The conditional stop refuses
// to touch a generation that has since acquired writer authority.
struct UnownedStartRollback {
    supervisor: SidecarSupervisor,
    generation: String,
    armed: bool,
}

impl UnownedStartRollback {
    fn new(supervisor: SidecarSupervisor, generation: String) -> Self {
        Self {
            supervisor,
            generation,
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for UnownedStartRollback {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let supervisor = self.supervisor.clone();
        let generation = self.generation.clone();
        tauri::async_runtime::spawn(async move {
            let _ = supervisor.stop_unowned_generation_exact(&generation).await;
        });
    }
}

struct SupervisorInner {
    app: AppHandle,
    runtime_dist: PathBuf,
    projection_data_root: PathBuf,
    projection: ProjectionService,
    attachments: Arc<Mutex<AttachmentStore>>,
    dispatch_recovery: Arc<Mutex<DispatchRecoveryStore>>,
    dispatch_state_lock: Arc<Mutex<()>>,
    owner_path: PathBuf,
    state: Mutex<SupervisorState>,
    lifecycle_transition: Mutex<()>,
    projection_transition: Mutex<()>,
    pending: Mutex<HashMap<String, oneshot::Sender<AppResult<Value>>>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectionEventsFrame {
    project_id: String,
    runtime_generation: String,
    activation_token: String,
    renderer_session_id: String,
    renderer_generation: u64,
    expected_status_revision: u64,
    events: Vec<DomainEventEnvelope>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectionIngestBindAck {
    bound: bool,
    suspended: bool,
    project_id: String,
    runtime_generation: String,
    expected_status_revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProjectionAuthorityBinding {
    runtime_generation: String,
    status_revision: u64,
    authority: RuntimeAuthority,
}

impl ProjectionAuthorityBinding {
    pub(crate) fn authority(&self) -> &RuntimeAuthority {
        &self.authority
    }

    pub(crate) fn runtime_generation(&self) -> &str {
        &self.runtime_generation
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionChangedEvent {
    schema_version: u32,
    project_id: String,
    runtime_generation: String,
    activation_token: String,
    renderer_session_id: String,
    renderer_generation: u64,
    status_revision: u64,
    stream_id: String,
    applied_journal_sequence: i64,
    projection_revision: i64,
    event_count: usize,
    message_count: usize,
    status: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DispatchRecoveryClearedEvent {
    schema_version: u32,
    project_id: String,
    runtime_generation: String,
    activation_token: String,
    renderer_session_id: String,
    renderer_generation: u64,
    status_revision: u64,
    dispatch_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionFaultDetails {
    code: String,
    message: String,
    retryable: bool,
    outcome_unknown: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionFaultEvent {
    schema_version: u32,
    project_id: String,
    runtime_generation: String,
    activation_token: String,
    renderer_session_id: String,
    renderer_generation: u64,
    status_revision: u64,
    status: &'static str,
    error: ProjectionFaultDetails,
}

fn capture_projection_authority_from_state(
    state: &SupervisorState,
    expected_generation: Option<&str>,
    project_id: &str,
) -> AppResult<ProjectionAuthorityBinding> {
    let runtime_generation = state.runtime_generation.as_deref().ok_or_else(|| {
        AppError::new(
            "projection_runtime_generation_missing",
            "Projection work requires an exact runtime generation",
        )
    })?;
    let authority = state.authority.as_ref().ok_or_else(|| {
        AppError::new(
            "projection_authority_not_active",
            "Projection work requires an active runtime authority",
        )
    })?;
    if state.phase != RuntimePhase::Ready
        || expected_generation.is_some_and(|expected| expected != runtime_generation)
        || authority.project_id != project_id
    {
        return Err(AppError::new(
            "projection_authority_mismatch",
            "Projection work does not belong to the exact active runtime authority",
        ));
    }
    Ok(ProjectionAuthorityBinding {
        runtime_generation: runtime_generation.to_owned(),
        status_revision: state.revision,
        authority: authority.clone(),
    })
}

fn projection_authority_binding_is_current(
    state: &SupervisorState,
    binding: &ProjectionAuthorityBinding,
) -> bool {
    state.phase == RuntimePhase::Ready
        && state.runtime_generation.as_deref() == Some(binding.runtime_generation.as_str())
        && state.revision == binding.status_revision
        && state.authority.as_ref() == Some(&binding.authority)
}

fn authorize_projection_ingest_frame(
    state: &SupervisorState,
    reader_generation: &str,
    frame: &ProjectionEventsFrame,
) -> AppResult<ProjectionAuthorityBinding> {
    let binding =
        capture_projection_authority_from_state(state, Some(reader_generation), &frame.project_id)?;
    if frame.runtime_generation != binding.runtime_generation
        || frame.activation_token != binding.authority.activation_token
        || frame.renderer_session_id != binding.authority.renderer_session_id
        || frame.renderer_generation != binding.authority.renderer_generation
        || frame.expected_status_revision != binding.status_revision
    {
        return Err(AppError::new(
            "projection_ingest_authority_mismatch",
            "Projection ingest frame does not carry the exact current native authority",
        )
        .with_details(serde_json::json!({
            "projectId": frame.project_id,
            "frameRuntimeGeneration": frame.runtime_generation,
            "currentRuntimeGeneration": binding.runtime_generation,
            "frameActivationToken": frame.activation_token,
            "currentActivationToken": binding.authority.activation_token,
            "frameRendererSessionId": frame.renderer_session_id,
            "currentRendererSessionId": binding.authority.renderer_session_id,
            "frameRendererGeneration": frame.renderer_generation,
            "currentRendererGeneration": binding.authority.renderer_generation,
            "frameExpectedStatusRevision": frame.expected_status_revision,
            "currentStatusRevision": binding.status_revision,
        })));
    }
    Ok(binding)
}

fn stale_projection_authority_error(
    binding: &ProjectionAuthorityBinding,
    outcome_unknown: bool,
) -> AppError {
    AppError::new(
        "projection_authority_changed",
        "Projection authority changed while native work was in flight",
    )
    .outcome_unknown(outcome_unknown)
    .with_details(serde_json::json!({
        "projectId": binding.authority.project_id,
        "runtimeGeneration": binding.runtime_generation,
        "activationToken": binding.authority.activation_token,
        "rendererSessionId": binding.authority.renderer_session_id,
        "rendererGeneration": binding.authority.renderer_generation,
        "statusRevision": binding.status_revision,
    }))
}

async fn finalize_attachment_terminal_locked(
    attachments: &Arc<Mutex<AttachmentStore>>,
    recovery: &mut DispatchRecoveryStore,
    record: &DispatchRecoveryRecord,
    terminal_status: &str,
) -> AppResult<()> {
    if record.phase == DispatchPhase::Accepted {
        recovery.mark_cleanup_pending(&record.message_id)?;
    }
    attachments
        .lock()
        .await
        .cleanup_dispatch_authoritative_failure(&record.message_id, &record.attachment_handles)?;
    recovery.clear_after_cleanup(
        &record.message_id,
        &format!("exact_terminal_{terminal_status}"),
    )?;
    Ok(())
}

async fn exact_projected_terminal(
    projection: &ProjectionService,
    record: &DispatchRecoveryRecord,
) -> AppResult<Option<String>> {
    if !matches!(
        record.phase,
        DispatchPhase::Accepted | DispatchPhase::CleanupPending
    ) {
        return Ok(None);
    }
    let Some(receipt) = record.receipt.as_ref() else {
        return if record.phase == DispatchPhase::CleanupPending {
            Ok(None)
        } else {
            Err(AppError::new(
                "dispatch_recovery_corrupt",
                "Accepted attachment recovery is missing exact thread and turn identity",
            )
            .outcome_unknown(true))
        };
    };
    let (Some(thread_id), Some(turn_id)) =
        (receipt.thread_id.as_deref(), receipt.turn_id.as_deref())
    else {
        return Err(AppError::new(
            "dispatch_recovery_corrupt",
            "Accepted attachment recovery is missing exact thread and turn identity",
        )
        .outcome_unknown(true));
    };
    let projection = projection.clone();
    let project_id = record.project_id.clone();
    let target_agent_id = record.target_agent_id.clone();
    let thread_id = thread_id.to_owned();
    let turn_id = turn_id.to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        projection.terminal_turn_state(&project_id, &target_agent_id, &thread_id, &turn_id)
    })
    .await
    .map_err(|error| AppError::new("projection_operation_join_failed", error.to_string()))?
}

fn same_terminal_recovery_identity(
    current: &DispatchRecoveryRecord,
    expected: &DispatchRecoveryRecord,
) -> bool {
    current.message_id == expected.message_id
        && current.project_id == expected.project_id
        && current.runtime_project_id == expected.runtime_project_id
        && current.target_agent_id == expected.target_agent_id
        && current.action_fingerprint == expected.action_fingerprint
        && current.receipt == expected.receipt
        && matches!(
            current.phase,
            DispatchPhase::Accepted | DispatchPhase::CleanupPending
        )
}

pub(crate) async fn reconcile_attachment_terminal_from_projection_under_dispatch(
    projection: &ProjectionService,
    attachments: &Arc<Mutex<AttachmentStore>>,
    recovery_store: &Arc<Mutex<DispatchRecoveryStore>>,
    project_id: Option<&str>,
) -> AppResult<Vec<String>> {
    let records = {
        let recovery = recovery_store.lock().await;
        project_id
            .and_then(|project_id| recovery.current_private_for_project(project_id))
            .map(|record| vec![record])
            .unwrap_or_else(|| {
                if project_id.is_some() {
                    Vec::new()
                } else {
                    recovery.all_private()
                }
            })
    };
    let mut cleared_message_ids = Vec::new();
    for expected in records {
        let Some(terminal_status) = exact_projected_terminal(projection, &expected).await? else {
            continue;
        };
        let mut recovery = recovery_store.lock().await;
        let Some(current) = recovery.current_private_for_message(&expected.message_id) else {
            continue;
        };
        if !same_terminal_recovery_identity(&current, &expected) {
            return Err(AppError::new(
                "dispatch_recovery_changed_during_terminal_query",
                "Dispatch recovery changed while exact terminal state was being read",
            )
            .outcome_unknown(true));
        }
        finalize_attachment_terminal_locked(attachments, &mut recovery, &current, &terminal_status)
            .await?;
        cleared_message_ids.push(current.message_id);
    }
    Ok(cleared_message_ids)
}

impl SidecarSupervisor {
    pub fn new(
        app: AppHandle,
        runtime_dist: PathBuf,
        projection_data_root: PathBuf,
        owner_path: PathBuf,
        projection: ProjectionService,
        attachments: Arc<Mutex<AttachmentStore>>,
        dispatch_recovery: Arc<Mutex<DispatchRecoveryStore>>,
        dispatch_state_lock: Arc<Mutex<()>>,
    ) -> AppResult<Self> {
        materialize_sentinel(&owner_path, &RuntimeOwnerDocument::default())?;
        let owner: RuntimeOwnerDocument =
            load_primary_or_backup(&owner_path, "runtime_owner_identity_uncertain")?;
        if owner.schema_version != 1 {
            return Err(AppError::new(
                "runtime_owner_schema_unsupported",
                "Runtime ownership was written by a newer Desktop Next",
            )
            .outcome_unknown(true));
        }
        let mut state = SupervisorState::default();
        if let Some(record) = owner.owner {
            if containment_definitively_gone_after_instance_lock(
                &record.containment_kind,
                &record.containment_id,
                "runtime",
                &record.runtime_generation,
                record.pid,
            ) {
                atomic_write_json(&owner_path, &RuntimeOwnerDocument::default())?;
                state.runtime_generation = Some(record.runtime_generation);
            } else {
                state.phase = RuntimePhase::Faulted;
                state.runtime_generation = Some(record.runtime_generation);
                state.pid = Some(record.pid);
                state.started_at_ms = Some(record.started_at_ms);
                state.termination_confirmed = false;
                state.last_error = Some(AppError::new("runtime_prior_owner_unconfirmed", "A prior runtime process tree may still own this data directory; writer restart is blocked").outcome_unknown(true));
            }
        }
        Ok(Self {
            inner: Arc::new(SupervisorInner {
                app,
                runtime_dist,
                projection_data_root,
                projection,
                attachments,
                dispatch_recovery,
                dispatch_state_lock,
                owner_path,
                state: Mutex::new(state),
                lifecycle_transition: Mutex::new(()),
                projection_transition: Mutex::new(()),
                pending: Mutex::new(HashMap::new()),
            }),
        })
    }

    pub async fn status(&self) -> RuntimeStatus {
        self.inner.state.lock().await.status()
    }
    pub async fn authority(&self) -> Option<RuntimeAuthority> {
        self.inner.state.lock().await.authority.clone()
    }

    pub(crate) async fn current_provider_connection_id(&self) -> AppResult<String> {
        let info = self
            .call("runtime.info", serde_json::json!({ "probe": true }), 30_000)
            .await?;
        if info.get("status").and_then(Value::as_str) != Some("ready") {
            return Err(AppError::new(
                "projection_provider_unavailable",
                "Provider connection is not ready",
            ));
        }
        let connection_id = info
            .get("providerConnectionId")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                AppError::new(
                    "projection_provider_identity_missing",
                    "Provider connection did not report its exact identity",
                )
            })?;
        bounded_id(connection_id, "providerConnectionId")
    }

    pub(crate) async fn observed_provider_connection_id(&self) -> Option<String> {
        self.inner
            .state
            .lock()
            .await
            .observed_provider_connection_id()
    }

    pub(crate) async fn settle_dispatch_attempt(
        &self,
        record: &DispatchRecoveryRecord,
        call: AppResult<Value>,
        kind: DispatchAttemptKind,
    ) -> AppResult<DispatchSettlement> {
        let message_id = record.message_id.clone();
        let _dispatch = self.inner.dispatch_state_lock.lock().await;
        match call {
            Ok(runtime_result) => {
                let status = {
                    let mut recovery = self.inner.dispatch_recovery.lock().await;
                    let receipt =
                        dispatch_receipt_from_runtime_result(&runtime_result).map_err(|error| {
                            preserve_unknown_dispatch(&mut recovery, &message_id, error)
                        })?;
                    recovery
                        .mark_accepted(&message_id, receipt)
                        .map_err(|error| {
                            preserve_unknown_dispatch(&mut recovery, &message_id, error)
                        })?
                };
                let cleared_message_ids = match self
                    .reconcile_attachment_terminal_from_projection_under_dispatch(Some(
                        &record.project_id,
                    ))
                    .await
                {
                    Ok(cleared_message_ids) => cleared_message_ids,
                    Err(error) => {
                        let status = self
                            .inner
                            .dispatch_recovery
                            .lock()
                            .await
                            .status_for_message(&message_id);
                        return Err(dispatch_error_with_status(error, status));
                    }
                };
                Ok(DispatchSettlement {
                    runtime_result,
                    dispatch_recovery: if !cleared_message_ids.is_empty() {
                        self.inner
                            .dispatch_recovery
                            .lock()
                            .await
                            .status_for_message(&message_id)
                    } else {
                        Some(status)
                    },
                })
            }
            Err(error) => {
                let mut recovery = self.inner.dispatch_recovery.lock().await;
                if recovery.terminal_proof_matches(error.details.as_ref().unwrap_or(&Value::Null)) {
                    let cleanup = match recovery.mark_cleanup_pending(&message_id) {
                        Ok(_) => self
                            .inner
                            .attachments
                            .lock()
                            .await
                            .cleanup_dispatch_authoritative_failure(
                                &message_id,
                                &record.attachment_handles,
                            ),
                        Err(error) => Err(error),
                    }
                    .and_then(|_| {
                        recovery
                            .clear_after_cleanup(&message_id, "authoritative_terminal_failure")
                            .map(|_| ())
                    });
                    match cleanup {
                        Ok(()) => Err(dispatch_error_with_status(error, None)),
                        Err(cleanup_error) => Err(dispatch_error_with_status(
                            AppError::recovery_lock(
                                &message_id,
                                format!(
                                    "Terminal failure proved, but cleanup remains locked: {}",
                                    cleanup_error.message
                                ),
                            ),
                            recovery.status_for_message(&message_id),
                        )),
                    }
                } else if error.outcome_unknown
                    || matches!(kind, DispatchAttemptKind::Reconcile)
                    || matches!(kind, DispatchAttemptKind::Initial { was_retry: true })
                {
                    let status = recovery
                        .mark_outcome_unknown(&message_id)
                        .ok()
                        .or_else(|| recovery.status_for_message(&message_id));
                    Err(dispatch_error_with_status(
                        AppError::recovery_lock(&message_id, error.message),
                        status,
                    ))
                } else {
                    let cleanup = match recovery.mark_cleanup_pending(&message_id) {
                        Ok(_) => self
                            .inner
                            .attachments
                            .lock()
                            .await
                            .cleanup_dispatch_authoritative_failure(
                                &message_id,
                                &record.attachment_handles,
                            ),
                        Err(error) => Err(error),
                    }
                    .and_then(|_| {
                        recovery
                            .clear_after_cleanup(&message_id, "definitive_preaccept_failure")
                            .map(|_| ())
                    });
                    match cleanup {
                        Ok(()) => Err(dispatch_error_with_status(error, None)),
                        Err(cleanup_error) => Err(dispatch_error_with_status(
                            AppError::recovery_lock(
                                &message_id,
                                format!(
                                    "Definitive rejection cleanup failed: {}",
                                    cleanup_error.message
                                ),
                            ),
                            recovery.status_for_message(&message_id),
                        )),
                    }
                }
            }
        }
    }

    pub(crate) async fn reconcile_attachment_terminal_from_projection_under_dispatch(
        &self,
        project_id: Option<&str>,
    ) -> AppResult<Vec<String>> {
        reconcile_attachment_terminal_from_projection_under_dispatch(
            &self.inner.projection,
            &self.inner.attachments,
            &self.inner.dispatch_recovery,
            project_id,
        )
        .await
    }

    pub(crate) async fn capture_projection_authority(
        &self,
        expected_generation: Option<&str>,
        project_id: &str,
    ) -> AppResult<ProjectionAuthorityBinding> {
        let state = self.inner.state.lock().await;
        capture_projection_authority_from_state(&state, expected_generation, project_id)
    }

    pub(crate) async fn reverify_projection_authority(
        &self,
        binding: &ProjectionAuthorityBinding,
    ) -> AppResult<()> {
        let state = self.inner.state.lock().await;
        if projection_authority_binding_is_current(&state, binding) {
            Ok(())
        } else {
            Err(stale_projection_authority_error(binding, false))
        }
    }
    pub async fn process_termination_confirmed(&self) -> bool {
        self.inner.state.lock().await.termination_confirmed
    }
    pub async fn containment_evidence(&self) -> AppResult<ContainmentEvidence> {
        let state = self.inner.state.lock().await;
        let generation = state.runtime_generation.clone().ok_or_else(|| {
            AppError::new("runtime_not_started", "Runtime has no process generation")
        })?;
        let process = state.process.as_ref().ok_or_else(|| {
            AppError::new("runtime_not_started", "Runtime process is unavailable")
        })?;
        Ok(ContainmentEvidence {
            runtime_generation: generation,
            kind: process.containment.kind().into(),
        })
    }

    pub async fn start(&self) -> AppResult<RuntimeStartResult> {
        let transition = self.inner.lifecycle_transition.lock().await;
        {
            let state = self.inner.state.lock().await;
            if state.phase == RuntimePhase::Ready {
                let runtime_generation = state.runtime_generation.clone().ok_or_else(|| {
                    AppError::new(
                        "runtime_generation_missing",
                        "Ready runtime has no exact generation",
                    )
                    .outcome_unknown(true)
                })?;
                if state.process.is_none() {
                    return Err(AppError::new(
                        "runtime_process_missing",
                        "Ready runtime has no local process handle",
                    )
                    .outcome_unknown(true));
                }
                return Ok(RuntimeStartResult {
                    status: state.status(),
                    runtime_generation,
                    started_here: false,
                });
            }
            if !state.termination_confirmed {
                return Err(AppError::new(
                    "runtime_prior_owner_unconfirmed",
                    "Cannot start until the previous process tree is proven terminated",
                )
                .outcome_unknown(true));
            }
        }
        let generation = uuid::Uuid::new_v4().hyphenated().to_string();
        let starting = {
            let mut state = self.inner.state.lock().await;
            state.phase = RuntimePhase::Starting;
            state.runtime_generation = Some(generation.clone());
            state.provider_connection_id = None;
            state.authority = None;
            state.termination_confirmed = false;
            state.last_error = None;
            state.revise();
            state.status()
        };
        self.emit_status(&starting, None);
        let mut rollback = UnownedStartRollback::new(self.clone(), generation.clone());
        match self.spawn_generation(&generation).await {
            Ok(process) => {
                let pid = match process.child.lock().await.id() {
                    Some(value) => value,
                    None => {
                        let confirmed = process
                            .containment
                            .terminate_and_confirm(&process.child)
                            .await
                            .is_ok();
                        if confirmed {
                            let mut state = self.inner.state.lock().await;
                            if state.runtime_generation.as_deref() == Some(&generation) {
                                state.termination_confirmed = true;
                            }
                        }
                        return self
                            .fail_start(
                                generation,
                                AppError::new(
                                    "runtime_spawn_failed",
                                    "Node runtime has no process id",
                                ),
                            )
                            .await;
                    }
                };
                let started_at_ms = now_ms();
                let owner = RuntimeOwnerDocument {
                    schema_version: 1,
                    owner: Some(RuntimeOwnerRecord {
                        runtime_generation: generation.clone(),
                        pid,
                        containment_kind: process.containment.kind().into(),
                        containment_id: process.containment.id(),
                        started_at_ms,
                    }),
                };
                if let Err(error) = atomic_write_json(&self.inner.owner_path, &owner) {
                    let confirmed = process
                        .containment
                        .terminate_and_confirm(&process.child)
                        .await
                        .is_ok();
                    if confirmed {
                        let mut state = self.inner.state.lock().await;
                        if state.runtime_generation.as_deref() == Some(&generation) {
                            state.termination_confirmed = true;
                        }
                    }
                    return self
                        .fail_start(
                            generation,
                            AppError::new("runtime_owner_persist_failed", error.message)
                                .outcome_unknown(true),
                        )
                        .await;
                }
                {
                    let mut state = self.inner.state.lock().await;
                    if state.runtime_generation.as_deref() != Some(&generation)
                        || state.phase != RuntimePhase::Starting
                    {
                        let _ = process
                            .containment
                            .terminate_and_confirm(&process.child)
                            .await;
                        return Err(AppError::new(
                            "runtime_start_superseded",
                            "Runtime start was superseded",
                        )
                        .outcome_unknown(true));
                    }
                    state.pid = Some(pid);
                    state.started_at_ms = Some(started_at_ms);
                    state.process = Some(process.clone());
                    state.revise();
                }
                if let Err(original) = self.spawn_reader(generation.clone(), process.clone()).await
                {
                    drop(transition);
                    let cleanup = self.stop_unowned_generation_exact(&generation).await;
                    if cleanup.as_ref().is_ok_and(|(stopped, _)| *stopped) {
                        rollback.disarm();
                    }
                    return match cleanup {
                        Ok(_) => Err(original),
                        Err(stop_error) => Err(AppError::new("runtime_start_rollback_unconfirmed", format!("{}; stop failed: {}", original.message, stop_error.message))
                            .outcome_unknown(true)
                            .with_details(serde_json::json!({ "runtimeGeneration": generation, "stopCode": stop_error.code }))),
                    };
                }
                let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
                loop {
                    let status = self.status().await;
                    if status.phase == RuntimePhase::Ready {
                        rollback.disarm();
                        return Ok(RuntimeStartResult {
                            status,
                            runtime_generation: generation,
                            started_here: true,
                        });
                    }
                    if status.phase == RuntimePhase::Faulted {
                        let original = status.last_error.unwrap_or_else(|| {
                            AppError::new("runtime_start_failed", "Runtime faulted during startup")
                        });
                        drop(transition);
                        let cleanup = self.stop_unowned_generation_exact(&generation).await;
                        if cleanup.as_ref().is_ok_and(|(stopped, _)| *stopped) {
                            rollback.disarm();
                        }
                        return match cleanup {
                            Ok(_) => Err(original),
                            Err(stop_error) => Err(AppError::new("runtime_start_rollback_unconfirmed", format!("{}; stop failed: {}", original.message, stop_error.message))
                                .outcome_unknown(true)
                                .with_details(serde_json::json!({ "runtimeGeneration": generation, "stopCode": stop_error.code }))),
                        };
                    }
                    if tokio::time::Instant::now() >= deadline {
                        let error =
                            AppError::new("runtime_start_timeout", "Runtime did not become ready")
                                .outcome_unknown(true);
                        // Never recurse into stop_generation_reserved while holding
                        // lifecycle_transition: that deadlocked the timeout path.
                        drop(transition);
                        let cleanup = self.stop_unowned_generation_exact(&generation).await;
                        if cleanup.as_ref().is_ok_and(|(stopped, _)| *stopped) {
                            rollback.disarm();
                        }
                        return match cleanup {
                            Ok(_) => Err(error),
                            Err(stop_error) => Err(AppError::new("runtime_start_rollback_unconfirmed", format!("{}; stop failed: {}", error.message, stop_error.message))
                                .outcome_unknown(true)
                                .with_details(serde_json::json!({ "runtimeGeneration": generation, "stopCode": stop_error.code }))),
                        };
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            }
            Err(error) => {
                let original = error;
                let _ = self
                    .fail_start::<()>(generation.clone(), original.clone())
                    .await;
                // A spawn failure has no process to preserve.  Finish the exact
                // unowned rollback before returning so the renderer can never
                // reconcile the transient Stopping revision and remain there.
                drop(transition);
                let cleanup = self.stop_unowned_generation_exact(&generation).await;
                if cleanup.as_ref().is_ok_and(|(stopped, _)| *stopped) {
                    rollback.disarm();
                }
                match cleanup {
                    Ok(_) => Err(original),
                    Err(stop_error) => Err(AppError::new("runtime_start_rollback_unconfirmed", format!("{}; stop failed: {}", original.message, stop_error.message))
                        .outcome_unknown(true)
                        .with_details(serde_json::json!({ "runtimeGeneration": generation, "stopCode": stop_error.code }))),
                }
            }
        }
    }

    async fn fail_start<T>(&self, generation: String, error: AppError) -> AppResult<T> {
        let termination_confirmed = error
            .details
            .as_ref()
            .and_then(|value| value.get("terminationConfirmed"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let status = {
            let mut state = self.inner.state.lock().await;
            if state.runtime_generation.as_deref() == Some(&generation) {
                state.phase = RuntimePhase::Faulted;
                state.authority = None;
                if termination_confirmed {
                    state.termination_confirmed = true;
                }
                state.last_error = Some(error.clone());
                state.revise();
            }
            state.status()
        };
        self.emit_status(&status, None);
        Err(error)
    }

    async fn spawn_generation(&self, generation: &str) -> AppResult<ProcessHandle> {
        let executable = if cfg!(windows) {
            self.inner.runtime_dist.join("orquesta-runtime.exe")
        } else {
            self.inner.runtime_dist.join("orquesta-runtime")
        };
        let sidecar_script = self.inner.runtime_dist.join("sidecar.cjs");
        // `dunce::canonicalize` can return a Windows extended-length path.  The
        // packaged Node filesystem shim can launch from that path but cannot
        // realpath external node_modules through the `\\?\` form.  Pass ordinary
        // absolute paths to the child while retaining canonical paths internally.
        let runtime_dist_env = node_environment_path(&self.inner.runtime_dist);
        let resources_env = node_environment_path(
            self.inner
                .runtime_dist
                .parent()
                .unwrap_or(&self.inner.runtime_dist),
        );
        let schemas_env = node_environment_path(&self.inner.runtime_dist.join("schemas"));
        let mut spec = if executable.is_file() {
            ContainedProcessSpec::new(executable)
        } else if cfg!(debug_assertions) && sidecar_script.is_file() {
            let mut spec = ContainedProcessSpec::new("node");
            spec.arg(sidecar_script);
            spec
        } else {
            return Err(AppError::new("runtime_binary_missing", "Packaged Desktop Next runtime binary is missing; system Node is never used in production")
                .with_details(serde_json::json!({ "terminationConfirmed": true })));
        };
        spec.stdin_mode(ContainedStdinMode::ProtocolPipe)
            .env("NODE_ENV", "production")
            .env(
                "ORQUESTA_NEXT_PROJECTION_DATA_PATH",
                self.inner.projection_data_root.as_os_str(),
            )
            .env("ORQUESTA_NEXT_RUNTIME_DIST", runtime_dist_env.as_os_str())
            .env("ORQUESTA_NEXT_RESOURCES_PATH", resources_env.as_os_str())
            .env("ORQUESTA_CONTRACTS_SCHEMA_DIR", schemas_env.as_os_str())
            .env("ORQUESTA_RUNTIME_GENERATION", generation);
        let spawned = spawn_contained(spec, "runtime", generation).await?;
        let child = spawned.child;
        let containment = spawned.containment;
        let stdin = match spawned.stdin {
            Some(value) => value,
            None => {
                let child = Arc::new(Mutex::new(child));
                let cleanup = containment.terminate_and_confirm(&child).await;
                return Err(match cleanup {
                    Ok(()) => AppError::new("runtime_spawn_failed", "Runtime stdin is unavailable")
                        .with_details(serde_json::json!({ "terminationConfirmed": true })),
                    Err(error) => AppError::new(
                        "runtime_containment_unverified",
                        format!(
                            "Runtime stdin is unavailable and cleanup failed: {}",
                            error.message
                        ),
                    )
                    .outcome_unknown(true),
                });
            }
        };
        Ok(ProcessHandle {
            child: Arc::new(Mutex::new(child)),
            stdin: Arc::new(Mutex::new(stdin)),
            containment,
        })
    }

    async fn spawn_reader(&self, generation: String, process: ProcessHandle) -> AppResult<()> {
        let (stdout, stderr) = {
            let mut child = process.child.lock().await;
            let stdout = child.stdout.take().ok_or_else(|| {
                AppError::new("runtime_spawn_failed", "Runtime stdout is unavailable")
            })?;
            let stderr = child.stderr.take().ok_or_else(|| {
                AppError::new("runtime_spawn_failed", "Runtime stderr is unavailable")
            })?;
            (stdout, stderr)
        };
        tokio::spawn(async move {
            let mut stderr = stderr;
            let mut buffer = [0_u8; 8 * 1024];
            loop {
                match stderr.read(&mut buffer).await {
                    Ok(0) | Err(_) => return,
                    Ok(_) => {}
                }
            }
        });
        let supervisor = self.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.len() > MAX_FRAME_BYTES {
                    supervisor
                        .mark_faulted(
                            &generation,
                            AppError::new(
                                "runtime_frame_too_large",
                                "Runtime emitted an oversized protocol frame",
                            )
                            .outcome_unknown(true),
                        )
                        .await;
                    return;
                }
                let response: SidecarResponse = match serde_json::from_str::<SidecarResponse>(&line)
                {
                    Ok(value) if value.protocol_version == 1 => value,
                    _ => {
                        supervisor
                            .mark_faulted(
                                &generation,
                                AppError::new(
                                    "runtime_protocol_error",
                                    "Runtime emitted an invalid JSONL frame",
                                )
                                .outcome_unknown(true),
                            )
                            .await;
                        return;
                    }
                };
                if response.event_type.as_deref() == Some("sidecar.ready") {
                    if let Err(error) = validate_sidecar_ready(&response) {
                        supervisor.mark_faulted(&generation, error).await;
                        return;
                    }
                    let status = {
                        let mut state = supervisor.inner.state.lock().await;
                        if state.runtime_generation.as_deref() != Some(&generation)
                            || state.phase != RuntimePhase::Starting
                        {
                            continue;
                        }
                        state.phase = RuntimePhase::Ready;
                        state.revise();
                        state.status()
                    };
                    supervisor.emit_status(&status, None);
                } else if response.event_type.as_deref() == Some("runtime.event") {
                    if let Some(event) = response.event {
                        supervisor.emit_runtime_event(&generation, event).await;
                    }
                } else if response.event_type.as_deref() == Some("projection.events.ingest") {
                    let event = response.event.unwrap_or(Value::Null);
                    if let Err(error) = supervisor
                        .ingest_projection_events(&generation, event)
                        .await
                    {
                        supervisor.mark_faulted(&generation, error).await;
                        return;
                    }
                } else if response.event_type.as_deref() == Some("projection.fault") {
                    let event = response.event.unwrap_or(Value::Null);
                    let project_id = event
                        .get("projectId")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown");
                    let message = event
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("Projection journal fault");
                    if let Ok(binding) = supervisor
                        .capture_projection_authority(Some(&generation), project_id)
                        .await
                    {
                        let _ = supervisor
                            .emit_projection_fault(
                                &binding,
                                &AppError::new("projection_journal_fault", message),
                            )
                            .await;
                    }
                } else if let Some(id) = response.id {
                    if let Some(sender) = supervisor.inner.pending.lock().await.remove(&id) {
                        let result = if response.ok == Some(true) {
                            Ok(response.result.unwrap_or(Value::Null))
                        } else {
                            Err(response.error.map(AppError::from).unwrap_or_else(|| {
                                AppError::new(
                                    "runtime_protocol_error",
                                    "Runtime error response is missing details",
                                )
                                .outcome_unknown(true)
                            }))
                        };
                        let _ = sender.send(result);
                    }
                }
            }
            supervisor
                .mark_faulted(
                    &generation,
                    AppError::new(
                        "runtime_exited",
                        "Runtime protocol stream ended unexpectedly",
                    )
                    .outcome_unknown(true),
                )
                .await;
        });
        Ok(())
    }

    pub async fn call(&self, method: &str, params: Value, timeout_ms: u64) -> AppResult<Value> {
        let (process, generation) = {
            let state = self.inner.state.lock().await;
            if state.phase != RuntimePhase::Ready {
                return Err(
                    AppError::new("runtime_not_ready", "Runtime is not ready").retryable(true)
                );
            }
            (
                state.process.clone().ok_or_else(|| {
                    AppError::new("runtime_not_ready", "Runtime process is missing")
                })?,
                state.runtime_generation.clone().ok_or_else(|| {
                    AppError::new(
                        "runtime_generation_missing",
                        "Ready runtime has no exact generation",
                    )
                    .outcome_unknown(true)
                })?,
            )
        };
        let id = uuid::Uuid::new_v4().hyphenated().to_string();
        let bytes = serde_json::to_vec(&SidecarRequest {
            protocol_version: 1,
            id: &id,
            method,
            params: &params,
        })
        .map_err(|error| AppError::new("runtime_request_encode_failed", error.to_string()))?;
        if bytes.len() > MAX_FRAME_BYTES {
            return Err(AppError::new(
                "runtime_frame_too_large",
                "Runtime request exceeds the 4 MiB boundary",
            ));
        }
        let (sender, receiver) = oneshot::channel();
        self.inner.pending.lock().await.insert(id.clone(), sender);
        let write = async {
            let mut stdin = process.stdin.lock().await;
            stdin.write_all(&bytes).await?;
            stdin.write_all(b"\n").await?;
            stdin.flush().await
        }
        .await;
        if let Err(error) = write {
            self.inner.pending.lock().await.remove(&id);
            return Err(AppError::io("write runtime request", error)
                .outcome_unknown(true)
                .with_details(serde_json::json!({ "runtimeGeneration": generation })));
        }
        match tokio::time::timeout(Duration::from_millis(timeout_ms.min(600_000)), receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(AppError::new(
                "runtime_request_cancelled",
                "Runtime request channel closed",
            )
            .outcome_unknown(true)),
            Err(_) => {
                self.inner.pending.lock().await.remove(&id);
                Err(
                    AppError::new("runtime_request_timeout", "Runtime request timed out")
                        .outcome_unknown(true)
                        .with_details(serde_json::json!({ "runtimeGeneration": generation })),
                )
            }
        }
    }

    async fn ingest_projection_events(
        &self,
        expected_generation: &str,
        value: Value,
    ) -> AppResult<()> {
        let frame: ProjectionEventsFrame = serde_json::from_value(value)
            .map_err(|error| AppError::new("projection_events_decode_failed", error.to_string()))?;
        if frame.events.is_empty() || frame.events.len() > 100_000 {
            return Err(AppError::new(
                "projection_events_invalid",
                "Runtime emitted an empty or unbounded domain event batch",
            ));
        }
        let _transition = self.inner.projection_transition.lock().await;
        let binding = {
            let state = self.inner.state.lock().await;
            authorize_projection_ingest_frame(&state, expected_generation, &frame)?
        };
        let projection = self.inner.projection.clone();
        let ingest_project_id = frame.project_id;
        let ingest_runtime_connection_id = frame.runtime_generation;
        let events = frame.events;
        let receipt = tauri::async_runtime::spawn_blocking(move || {
            projection.ingest_domain_events_for_connection(
                &ingest_project_id,
                Some(&ingest_runtime_connection_id),
                &events,
            )
        })
        .await
        .map_err(|error| AppError::new("projection_ingest_join_failed", error.to_string()))??;
        let terminal_reconcile = {
            let _dispatch = self.inner.dispatch_state_lock.lock().await;
            self.reconcile_attachment_terminal_from_projection_under_dispatch(Some(
                &binding.authority.project_id,
            ))
            .await
        };
        match terminal_reconcile {
            Ok(dispatch_ids) => {
                for dispatch_id in dispatch_ids {
                    self.emit_dispatch_recovery_cleared(&binding, dispatch_id)
                        .await?;
                }
            }
            Err(error) => {
                // Projection durability is already committed. Report cleanup as a
                // recoverable Native fault without falsely rejecting or replaying
                // the provider's exact terminal journal batch.
                self.emit_projection_fault(&binding, &error).await?;
            }
        }
        self.emit_projection_changed(
            &binding,
            receipt.stream_id,
            receipt.applied_journal_sequence,
            receipt.projection_revision,
            receipt.event_count,
            receipt.message_count,
            receipt.status,
        )
        .await?;
        Ok(())
    }

    async fn emit_projection_changed(
        &self,
        binding: &ProjectionAuthorityBinding,
        stream_id: String,
        applied_journal_sequence: i64,
        projection_revision: i64,
        event_count: usize,
        message_count: usize,
        status: String,
    ) -> AppResult<()> {
        let state = self.inner.state.lock().await;
        if !projection_authority_binding_is_current(&state, binding) {
            return Err(stale_projection_authority_error(binding, true));
        }
        self.inner
            .app
            .emit_to(
                &binding.authority.window_label,
                PROJECTION_EVENT_NAME,
                ProjectionChangedEvent {
                    schema_version: NATIVE_BRIDGE_SCHEMA_VERSION,
                    project_id: binding.authority.project_id.clone(),
                    runtime_generation: binding.runtime_generation.clone(),
                    activation_token: binding.authority.activation_token.clone(),
                    renderer_session_id: binding.authority.renderer_session_id.clone(),
                    renderer_generation: binding.authority.renderer_generation,
                    status_revision: binding.status_revision,
                    stream_id,
                    applied_journal_sequence,
                    projection_revision,
                    event_count,
                    message_count,
                    status,
                },
            )
            .map_err(|error| AppError::new("projection_event_emit_failed", error.to_string()))
    }

    async fn emit_dispatch_recovery_cleared(
        &self,
        binding: &ProjectionAuthorityBinding,
        dispatch_id: String,
    ) -> AppResult<()> {
        let state = self.inner.state.lock().await;
        if !projection_authority_binding_is_current(&state, binding) {
            return Err(stale_projection_authority_error(binding, false));
        }
        self.inner
            .app
            .emit_to(
                &binding.authority.window_label,
                DISPATCH_RECOVERY_CLEARED_EVENT,
                DispatchRecoveryClearedEvent {
                    schema_version: NATIVE_BRIDGE_SCHEMA_VERSION,
                    project_id: binding.authority.project_id.clone(),
                    runtime_generation: binding.runtime_generation.clone(),
                    activation_token: binding.authority.activation_token.clone(),
                    renderer_session_id: binding.authority.renderer_session_id.clone(),
                    renderer_generation: binding.authority.renderer_generation,
                    status_revision: binding.status_revision,
                    dispatch_id,
                },
            )
            .map_err(|error| {
                AppError::new("dispatch_recovery_event_emit_failed", error.to_string())
            })
    }

    pub(crate) async fn emit_projection_fault(
        &self,
        binding: &ProjectionAuthorityBinding,
        error: &AppError,
    ) -> AppResult<()> {
        let state = self.inner.state.lock().await;
        if !projection_authority_binding_is_current(&state, binding) {
            return Err(stale_projection_authority_error(binding, false));
        }
        self.inner
            .app
            .emit_to(
                &binding.authority.window_label,
                PROJECTION_STATUS_EVENT,
                ProjectionFaultEvent {
                    schema_version: NATIVE_BRIDGE_SCHEMA_VERSION,
                    project_id: binding.authority.project_id.clone(),
                    runtime_generation: binding.runtime_generation.clone(),
                    activation_token: binding.authority.activation_token.clone(),
                    renderer_session_id: binding.authority.renderer_session_id.clone(),
                    renderer_generation: binding.authority.renderer_generation,
                    status_revision: binding.status_revision,
                    status: "faulted",
                    error: ProjectionFaultDetails {
                        code: error.code.clone(),
                        message: error.message.clone(),
                        retryable: error.retryable,
                        outcome_unknown: error.outcome_unknown,
                    },
                },
            )
            .map_err(|emit_error| {
                AppError::new("projection_status_emit_failed", emit_error.to_string())
            })
    }

    pub(crate) async fn emit_projection_refresh(
        &self,
        binding: &ProjectionAuthorityBinding,
        stream_id: String,
        applied_journal_sequence: i64,
        projection_revision: i64,
        changed_records: usize,
    ) -> AppResult<()> {
        self.emit_projection_changed(
            binding,
            stream_id,
            applied_journal_sequence,
            projection_revision,
            0,
            changed_records,
            if changed_records == 0 {
                "idempotent".to_owned()
            } else {
                "applied".to_owned()
            },
        )
        .await
    }

    pub async fn commit_authority_if_ready(
        &self,
        expected_generation: &str,
        authority: RuntimeAuthority,
    ) -> AppResult<RuntimeStatus> {
        let _transition = self.inner.projection_transition.lock().await;
        let status = {
            let mut state = self.inner.state.lock().await;
            if state.phase != RuntimePhase::Ready
                || state.runtime_generation.as_deref() != Some(expected_generation)
                || state.process.is_none()
            {
                return Err(AppError::new(
                    "runtime_authority_commit_stale",
                    "Runtime generation is no longer Ready; authority was not committed",
                )
                .outcome_unknown(true));
            }
            state.authority = Some(authority.clone());
            state.revise();
            state.status()
        };
        self.emit_status(&status, Some(&authority));
        Ok(status)
    }

    pub async fn bind_projection_ingest_authority(
        &self,
        status: &RuntimeStatus,
        authority: &RuntimeAuthority,
    ) -> AppResult<()> {
        self.update_projection_ingest_binding("projection.ingest.bind", false, status, authority)
            .await
    }

    async fn suspend_projection_ingest_authority(
        &self,
        status: &RuntimeStatus,
        authority: &RuntimeAuthority,
    ) -> AppResult<()> {
        self.update_projection_ingest_binding("projection.ingest.suspend", true, status, authority)
            .await
    }

    async fn update_projection_ingest_binding(
        &self,
        method: &str,
        expected_suspended: bool,
        status: &RuntimeStatus,
        authority: &RuntimeAuthority,
    ) -> AppResult<()> {
        let generation = status.runtime_generation.as_deref().ok_or_else(|| {
            AppError::new(
                "projection_ingest_binding_generation_missing",
                "Projection ingest binding requires an exact runtime generation",
            )
        })?;
        if status.phase != RuntimePhase::Ready
            || status.active_project_id.as_deref() != Some(authority.project_id.as_str())
            || status.authority_activation_token.as_deref()
                != Some(authority.activation_token.as_str())
            || status.authority_renderer_session_id.as_deref()
                != Some(authority.renderer_session_id.as_str())
            || status.authority_renderer_generation != Some(authority.renderer_generation)
        {
            return Err(AppError::new(
                "projection_ingest_binding_status_mismatch",
                "Projection ingest binding requires one committed native authority snapshot",
            ));
        }
        let binding = self
            .capture_projection_authority(Some(generation), &authority.project_id)
            .await?;
        if binding.status_revision != status.status_revision || binding.authority != *authority {
            return Err(AppError::new(
                "projection_ingest_binding_stale",
                "Projection ingest authority changed before the binding request",
            ));
        }
        let result = self
            .call(
                method,
                serde_json::json!({
                    "projectId": authority.project_id,
                    "runtimeGeneration": generation,
                    "activationToken": authority.activation_token,
                    "rendererSessionId": authority.renderer_session_id,
                    "rendererGeneration": authority.renderer_generation,
                    "expectedStatusRevision": status.status_revision,
                }),
                30_000,
            )
            .await?;
        let ack: ProjectionIngestBindAck = serde_json::from_value(result).map_err(|error| {
            AppError::new(
                "projection_ingest_binding_ack_invalid",
                format!("Projection ingest binding ACK is invalid: {error}"),
            )
            .outcome_unknown(true)
        })?;
        if !ack.bound
            || ack.suspended != expected_suspended
            || ack.project_id != authority.project_id
            || ack.runtime_generation != generation
            || ack.expected_status_revision != status.status_revision
        {
            return Err(AppError::new(
                "projection_ingest_binding_ack_mismatch",
                "Projection ingest binding ACK does not match the native authority",
            )
            .outcome_unknown(true));
        }
        self.reverify_projection_authority(&binding).await
    }

    pub async fn adopt_authority_renderer(
        &self,
        previous_session_id: &str,
        new_session_id: &str,
        generation: u64,
        window_label: &str,
    ) -> AppResult<Option<RuntimeAuthority>> {
        let (previous_status, previous_authority, previous_binding) = {
            let state = self.inner.state.lock().await;
            let Some(current) = state.authority.as_ref() else {
                return Ok(None);
            };
            if current.renderer_session_id == new_session_id
                && current.renderer_generation == generation
                && current.window_label == window_label
            {
                // A renderer-session admission persists its Native recovery
                // tuple before adopting the runtime. If the final registry
                // commit/response is lost, exact replay must be harmless.
                return Ok(Some(current.clone()));
            }
            if current.renderer_session_id != previous_session_id {
                return Err(AppError::new(
                    "runtime_authority_adoption_mismatch",
                    "Runtime authority is owned by another renderer session",
                ));
            }
            let status = state.status();
            let binding = capture_projection_authority_from_state(
                &state,
                state.runtime_generation.as_deref(),
                &current.project_id,
            )?;
            (status, current.clone(), binding)
        };
        let runtime_generation = previous_binding.runtime_generation.clone();
        if let Err(error) = self
            .suspend_projection_ingest_authority(&previous_status, &previous_authority)
            .await
        {
            self.mark_faulted(&runtime_generation, error.clone()).await;
            return Err(error);
        }

        let transition = self.inner.projection_transition.lock().await;
        let mutation: AppResult<(RuntimeStatus, RuntimeAuthority)> = {
            let mut state = self.inner.state.lock().await;
            if !projection_authority_binding_is_current(&state, &previous_binding) {
                Err(stale_projection_authority_error(&previous_binding, false))
            } else {
                let current = state.authority.as_mut().expect("verified authority");
                current.renderer_session_id = new_session_id.into();
                current.renderer_generation = generation;
                current.window_label = window_label.into();
                let authority = current.clone();
                state.revise();
                Ok((state.status(), authority))
            }
        };
        let (status, authority) = match mutation {
            Ok(value) => value,
            Err(error) => {
                drop(transition);
                self.mark_faulted(&runtime_generation, error.clone()).await;
                return Err(error);
            }
        };
        self.emit_status(&status, Some(&authority));
        let bind_result = self
            .bind_projection_ingest_authority(&status, &authority)
            .await;
        drop(transition);
        if let Err(error) = bind_result {
            self.mark_faulted(&runtime_generation, error.clone()).await;
            return Err(error);
        }
        Ok(Some(authority))
    }

    pub async fn stop_if_matches(
        &self,
        expected: Option<&RuntimeAuthority>,
        expected_generation: Option<&str>,
    ) -> AppResult<(bool, RuntimeStatus)> {
        let projection_transition = self.inner.projection_transition.lock().await;
        let generation = {
            let mut state = self.inner.state.lock().await;
            if matches!(state.phase, RuntimePhase::Stopped) {
                return Ok((false, state.status()));
            }
            if let Some(expected_generation) = expected_generation {
                if state.runtime_generation.as_deref() != Some(expected_generation) {
                    return Ok((false, state.status()));
                }
            }
            if let Some(expected) = expected {
                if state.authority.as_ref() != Some(expected) {
                    return Ok((false, state.status()));
                }
            }
            if state.process.is_none() && !state.termination_confirmed {
                return Err(AppError::new(
                    "runtime_termination_unconfirmed",
                    "Runtime process ownership exists without a terminable local handle",
                )
                .outcome_unknown(true));
            }
            if state.phase != RuntimePhase::Stopping {
                state.phase = RuntimePhase::Stopping;
                state.revise();
            }
            state.runtime_generation.clone()
        };
        drop(projection_transition);
        let Some(generation) = generation else {
            return Err(AppError::new(
                "runtime_generation_missing",
                "Runtime lifecycle state is inconsistent",
            )
            .outcome_unknown(true));
        };
        let result = self.stop_generation_reserved(&generation).await;
        result.map(|status| (true, status))
    }

    pub async fn stop_generation_exact(
        &self,
        expected_generation: &str,
    ) -> AppResult<RuntimeStatus> {
        self.stop_if_matches(None, Some(expected_generation))
            .await
            .map(|(_, status)| status)
    }

    pub async fn stop_unowned_generation_exact(
        &self,
        expected_generation: &str,
    ) -> AppResult<(bool, RuntimeStatus)> {
        let generation = {
            let mut state = self.inner.state.lock().await;
            if state.runtime_generation.as_deref() != Some(expected_generation)
                || state.authority.is_some()
                || state.phase == RuntimePhase::Stopped
            {
                return Ok((false, state.status()));
            }
            if state.process.is_none() && !state.termination_confirmed {
                return Err(AppError::new(
                    "runtime_termination_unconfirmed",
                    "Unowned runtime generation has no terminable local handle",
                )
                .outcome_unknown(true));
            }
            if state.phase != RuntimePhase::Stopping {
                state.phase = RuntimePhase::Stopping;
                state.revise();
            }
            state.runtime_generation.clone()
        };
        let Some(generation) = generation else {
            return Err(AppError::new(
                "runtime_generation_missing",
                "Runtime lifecycle state is inconsistent",
            )
            .outcome_unknown(true));
        };
        self.stop_generation_reserved(&generation)
            .await
            .map(|status| (true, status))
    }

    pub async fn stop(&self) -> AppResult<RuntimeStatus> {
        self.stop_if_matches(None, None)
            .await
            .map(|(_, status)| status)
    }

    async fn stop_generation_reserved(&self, generation: &str) -> AppResult<RuntimeStatus> {
        let _transition = self.inner.lifecycle_transition.lock().await;
        let (process, route_authority) = {
            let state = self.inner.state.lock().await;
            if state.runtime_generation.as_deref() != Some(generation) {
                return Err(AppError::new("runtime_stop_superseded", "Runtime generation changed before conditional stop acquired the lifecycle barrier").outcome_unknown(true));
            }
            if !matches!(state.phase, RuntimePhase::Stopping | RuntimePhase::Stopped) {
                return Err(AppError::new(
                    "runtime_stop_reservation_lost",
                    "Runtime is no longer reserved for this stop",
                )
                .outcome_unknown(true));
            }
            (state.process.clone(), state.authority.clone())
        };
        if let Some(process) = process {
            // The process containment boundary is authoritative for an explicit stop.
            // The sidecar keeps its internal stdin-EOF cleanup path; Native must not
            // send policy-external control frames that the sidecar will reject.
            if let Err(error) = process
                .containment
                .terminate_and_confirm(&process.child)
                .await
            {
                let status = {
                    let mut state = self.inner.state.lock().await;
                    state.phase = RuntimePhase::Faulted;
                    state.authority = None;
                    state.termination_confirmed = false;
                    state.last_error = Some(error.clone());
                    state.revise();
                    state.status()
                };
                self.fail_pending(
                    AppError::new("runtime_termination_unconfirmed", error.message.clone())
                        .outcome_unknown(true),
                )
                .await;
                self.emit_status(&status, route_authority.as_ref());
                return Err(error);
            }
        }
        if let Err(error) =
            atomic_write_json(&self.inner.owner_path, &RuntimeOwnerDocument::default())
        {
            let status = {
                let mut state = self.inner.state.lock().await;
                state.phase = RuntimePhase::Faulted;
                state.authority = None;
                state.termination_confirmed = false;
                state.last_error = Some(
                    AppError::new("runtime_owner_clear_failed", error.message.clone())
                        .outcome_unknown(true),
                );
                state.revise();
                state.status()
            };
            self.emit_status(&status, route_authority.as_ref());
            return Err(status.last_error.expect("owner error"));
        }
        // Complete pending request channels before publishing Stopped.  If this
        // future is cancelled while awaiting the pending map, phase remains
        // Stopping and the exact-generation stop can resume idempotently.
        self.fail_pending(
            AppError::new(
                "runtime_stopped",
                "Runtime stopped before the request completed",
            )
            .outcome_unknown(true),
        )
        .await;
        let status = {
            let mut state = self.inner.state.lock().await;
            if state.runtime_generation.as_deref() != Some(generation) {
                return Err(AppError::new(
                    "runtime_stop_superseded",
                    "Runtime generation changed during stop",
                )
                .outcome_unknown(true));
            }
            state.phase = RuntimePhase::Stopped;
            state.process = None;
            state.pid = None;
            state.authority = None;
            state.termination_confirmed = true;
            state.last_error = None;
            // Keep the last terminated generation. It is the barrier that lets the
            // renderer reject delayed events; only never-started Stopped is null.
            state.revise();
            state.status()
        };
        self.emit_status(&status, route_authority.as_ref());
        Ok(status)
    }

    async fn mark_faulted(&self, generation: &str, cause: AppError) {
        let projection_transition = self.inner.projection_transition.lock().await;
        let (process, route_authority) = {
            let mut state = self.inner.state.lock().await;
            if state.runtime_generation.as_deref() != Some(generation)
                || matches!(state.phase, RuntimePhase::Stopped | RuntimePhase::Stopping)
            {
                return;
            }
            let route_authority = state.authority.clone();
            state.phase = RuntimePhase::Faulted;
            state.authority = None;
            state.last_error = Some(cause.clone());
            state.revise();
            (state.process.clone(), route_authority)
        };
        drop(projection_transition);
        let confirmed = if let Some(process) = process {
            process
                .containment
                .terminate_and_confirm(&process.child)
                .await
                .is_ok()
        } else {
            false
        };
        if confirmed {
            let _ = atomic_write_json(&self.inner.owner_path, &RuntimeOwnerDocument::default());
        }
        let status = {
            let mut state = self.inner.state.lock().await;
            if state.runtime_generation.as_deref() != Some(generation) {
                return;
            }
            state.process = if confirmed {
                None
            } else {
                state.process.clone()
            };
            state.pid = if confirmed { None } else { state.pid };
            state.termination_confirmed = confirmed;
            // Authority/process clearing is a second externally visible mutation and
            // gets a distinct monotonic revision.
            state.revise();
            state.status()
        };
        self.fail_pending(cause).await;
        self.emit_status(&status, route_authority.as_ref());
    }

    async fn fail_pending(&self, error: AppError) {
        let pending = std::mem::take(&mut *self.inner.pending.lock().await);
        for (_, request) in pending {
            let _ = request.send(Err(error.clone()));
        }
    }

    async fn emit_runtime_event(&self, generation: &str, event: Value) {
        let (label, envelope) = {
            let mut state = self.inner.state.lock().await;
            if state.phase != RuntimePhase::Ready
                || state.runtime_generation.as_deref() != Some(generation)
            {
                return;
            }
            state.observe_provider_connection(generation, &event);
            let Some(authority) = &state.authority else {
                return;
            };
            (
                authority.window_label.clone(),
                RuntimeEventEnvelope {
                    schema_version: NATIVE_BRIDGE_SCHEMA_VERSION,
                    runtime_generation: generation.into(),
                    status_revision: state.revision,
                    renderer_session_id: authority.renderer_session_id.clone(),
                    renderer_generation: authority.renderer_generation,
                    project_id: authority.project_id.clone(),
                    activation_token: authority.activation_token.clone(),
                    event,
                },
            )
        };
        let _ = self.inner.app.emit_to(label, RUNTIME_EVENT_NAME, envelope);
    }

    fn emit_status(&self, status: &RuntimeStatus, route: Option<&RuntimeAuthority>) {
        if let Some(route) = route {
            let envelope = RuntimeStatusEventEnvelope {
                schema_version: NATIVE_BRIDGE_SCHEMA_VERSION,
                renderer_session_id: route.renderer_session_id.clone(),
                renderer_generation: route.renderer_generation,
                runtime_generation: status.runtime_generation.clone(),
                status_revision: status.status_revision,
                status: status.clone(),
            };
            let _ = self
                .inner
                .app
                .emit_to(&route.window_label, RUNTIME_STATUS_EVENT, envelope);
        }
    }
}

#[cfg(all(test, windows))]
mod containment_recovery_tests {
    use super::*;

    fn owner(containment_kind: &str, containment_id: &str) -> RuntimeOwnerRecord {
        RuntimeOwnerRecord {
            runtime_generation: "runtime-legacy".into(),
            pid: 42,
            containment_kind: containment_kind.into(),
            containment_id: containment_id.into(),
            started_at_ms: 1,
        }
    }

    #[test]
    fn unverified_legacy_containment_stays_fail_closed() {
        let owner = owner("unverified", "42");
        assert!(!containment_definitively_gone_after_instance_lock(
            &owner.containment_kind,
            &owner.containment_id,
            "runtime",
            &owner.runtime_generation,
            owner.pid,
        ));
    }
}

#[cfg(test)]
mod dispatch_settlement_tests {
    use super::*;
    use crate::dispatch_recovery::DispatchFingerprintInput;
    use crate::paths::NativePaths;
    use crate::projection_service::{DomainEventEnvelope, DomainEventOwner};

    #[test]
    fn runtime_dispatch_receipt_requires_both_bounded_ids() {
        let receipt = dispatch_receipt_from_runtime_result(&serde_json::json!({
            "threadId": "thread-a",
            "turnId": "turn-a",
        }))
        .expect("complete receipt");
        assert_eq!(receipt.thread_id.as_deref(), Some("thread-a"));
        assert_eq!(receipt.turn_id.as_deref(), Some("turn-a"));

        for invalid in [
            serde_json::json!({ "turnId": "turn-a" }),
            serde_json::json!({ "threadId": "thread-a" }),
            serde_json::json!({ "threadId": "", "turnId": "turn-a" }),
            serde_json::json!({ "threadId": "thread-a", "turnId": "x".repeat(129) }),
        ] {
            assert!(dispatch_receipt_from_runtime_result(&invalid).is_err());
        }
    }

    #[test]
    fn invalid_runtime_receipt_is_reported_as_durable_outcome_unknown() {
        let root = std::env::temp_dir().join(format!(
            "orquesta-invalid-runtime-receipt-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).expect("create temp root");
        let path = root.join("dispatch-recovery.json");
        let mut recovery = DispatchRecoveryStore::open(path).expect("open store");
        let message_id = "message-a";
        recovery
            .prepare(
                message_id,
                "project-a",
                &DispatchFingerprintInput {
                    runtime_project_id: "runtime-a".into(),
                    target_agent_id: "orchestrator".into(),
                    text: "hello".into(),
                    ordered_attachment_content_sha256: vec![],
                    selected_context_ids: vec![],
                    effort: None,
                    recommended_model: None,
                    requested_model: None,
                },
                vec![],
            )
            .expect("prepare dispatch");
        let cause = dispatch_receipt_from_runtime_result(&serde_json::json!({
            "threadId": "",
            "turnId": "turn-a",
        }))
        .expect_err("invalid receipt");
        assert!(!cause.outcome_unknown);

        let error = preserve_unknown_dispatch(&mut recovery, message_id, cause);

        assert!(error.outcome_unknown);
        assert_eq!(
            recovery
                .status_for_message(message_id)
                .expect("durable status")
                .phase,
            DispatchPhase::OutcomeUnknown
        );
        drop(recovery);
        let _ = std::fs::remove_dir_all(root);
    }

    fn attachment_terminal_test_paths(root: PathBuf) -> NativePaths {
        let app_data = root.join("app-data");
        NativePaths {
            root: app_data.clone(),
            projection_data_root: app_data.clone(),
            attachment_data_root: app_data.clone(),
            voice_data_root: app_data.join("voice-data"),
            state: app_data.join("state"),
            logs: app_data.join("logs"),
            attachments: app_data.join("attachments"),
            projection: app_data.join("projection"),
            runtime_dist: app_data.join("runtime-dist"),
        }
    }

    fn terminal_projection_event() -> DomainEventEnvelope {
        DomainEventEnvelope {
            domain_event_version: 1,
            source_event_id: "src_bb76eab108b03e935eea8c1275ddc611cea2f0aac9e22e4abd6c654f1b97aa5d"
                .into(),
            source_runtime: "codex_app_server".into(),
            source_cursor: Some("cursor:1".into()),
            owner: DomainEventOwner {
                kind: "agent".into(),
                agent_id: Some("orchestrator".into()),
                execution_id: None,
                system_id: None,
            },
            agent_id: Some("orchestrator".into()),
            task_id: Some("task-a".into()),
            thread_id: Some("thread-terminal-race".into()),
            turn_id: Some("turn-terminal-race".into()),
            item_id: None,
            kind: "turn.completed".into(),
            phase: "completed".into(),
            occurred_at: "2026-08-27T00:00:00.000Z".into(),
            payload: serde_json::json!({"status": "completed"}),
            evidence_ref: None,
        }
    }

    async fn run_terminal_before_accepted_recovery(reopen_before_reconcile: bool) {
        let root = std::env::temp_dir().join(format!(
            "orquesta-attachment-terminal-race-{}",
            uuid::Uuid::new_v4()
        ));
        let paths = attachment_terminal_test_paths(root.clone());
        let projection = ProjectionService::open(&paths).expect("open projection");
        projection
            .initialize_project("project-a")
            .expect("initialize registered projection");
        projection
            .ingest_domain_events_for_connection(
                "project-a",
                Some("runtime-connection-terminal-test"),
                &[terminal_projection_event()],
            )
            .expect("persist terminal before Accepted");
        let recovery_path = paths.dispatch_recovery();
        let mut recovery =
            DispatchRecoveryStore::open(recovery_path.clone()).expect("open recovery");
        let fingerprint = DispatchFingerprintInput {
            runtime_project_id: "project-a".into(),
            target_agent_id: "orchestrator".into(),
            text: "fast turn".into(),
            ordered_attachment_content_sha256: vec![],
            selected_context_ids: vec![],
            effort: None,
            recommended_model: None,
            requested_model: None,
        };
        recovery
            .prepare("message-terminal-race", "project-a", &fingerprint, vec![])
            .expect("persist Prepared");
        recovery
            .mark_accepted(
                "message-terminal-race",
                DispatchReceipt {
                    thread_id: Some("thread-terminal-race".into()),
                    turn_id: Some("turn-terminal-race".into()),
                },
            )
            .expect("persist Accepted after terminal");
        let recovery = if reopen_before_reconcile {
            drop(recovery);
            DispatchRecoveryStore::open(recovery_path).expect("reopen recovery")
        } else {
            recovery
        };
        let attachments = Arc::new(Mutex::new(
            AttachmentStore::open(
                paths.attachments.clone(),
                paths.attachment_selections(),
                paths.attachment_quarantine(),
                recovery.current_private_for_project("project-a").as_ref(),
            )
            .expect("open attachment authority"),
        ));
        let recovery = Arc::new(Mutex::new(recovery));
        assert_eq!(
            reconcile_attachment_terminal_from_projection_under_dispatch(
                &projection,
                &attachments,
                &recovery,
                Some("project-a"),
            )
            .await
            .expect("reconcile exact durable terminal"),
            vec!["message-terminal-race"]
        );
        assert!(recovery
            .lock()
            .await
            .current_private_for_project("project-a")
            .is_none());
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn terminal_projection_before_accepted_is_reconciled_after_acceptance() {
        run_terminal_before_accepted_recovery(false).await;
    }

    #[tokio::test]
    async fn restart_reconcile_clears_an_accepted_turn_already_terminal_in_sqlite() {
        run_terminal_before_accepted_recovery(true).await;
    }

    #[tokio::test]
    async fn terminal_cleanup_failure_remains_durable_and_is_not_reported_as_success() {
        let root = std::env::temp_dir().join(format!(
            "orquesta-attachment-terminal-cleanup-failure-{}",
            uuid::Uuid::new_v4()
        ));
        let paths = attachment_terminal_test_paths(root.clone());
        let projection = ProjectionService::open(&paths).expect("open projection");
        projection
            .initialize_project("project-a")
            .expect("initialize registered projection");
        projection
            .ingest_domain_events_for_connection(
                "project-a",
                Some("runtime-connection-terminal-test"),
                &[terminal_projection_event()],
            )
            .expect("persist terminal");
        let attachments = Arc::new(Mutex::new(
            AttachmentStore::open(
                paths.attachments.clone(),
                paths.attachment_selections(),
                paths.attachment_quarantine(),
                None,
            )
            .expect("open empty attachment authority"),
        ));
        let mut recovery =
            DispatchRecoveryStore::open(paths.dispatch_recovery()).expect("open recovery");
        recovery
            .prepare(
                "message-terminal-race",
                "project-a",
                &DispatchFingerprintInput {
                    runtime_project_id: "project-a".into(),
                    target_agent_id: "orchestrator".into(),
                    text: "fast turn".into(),
                    ordered_attachment_content_sha256: vec!["a".repeat(64)],
                    selected_context_ids: vec![],
                    effort: None,
                    recommended_model: None,
                    requested_model: None,
                },
                vec!["55555555-5555-4555-8555-555555555555".to_owned()],
            )
            .expect("persist Prepared");
        recovery
            .mark_accepted(
                "message-terminal-race",
                DispatchReceipt {
                    thread_id: Some("thread-terminal-race".into()),
                    turn_id: Some("turn-terminal-race".into()),
                },
            )
            .expect("persist Accepted");

        let recovery = Arc::new(Mutex::new(recovery));
        let error = reconcile_attachment_terminal_from_projection_under_dispatch(
            &projection,
            &attachments,
            &recovery,
            Some("project-a"),
        )
        .await
        .expect_err("missing sealed record must not become successful cleanup");
        assert_eq!(error.code, "attachment_recovery_record_missing");
        assert_eq!(
            recovery
                .lock()
                .await
                .current_private_for_project("project-a")
                .expect("recovery retained")
                .phase,
            DispatchPhase::CleanupPending
        );
        let _ = std::fs::remove_dir_all(root);
    }
}

#[cfg(test)]
mod projection_authority_tests {
    use super::*;

    #[test]
    fn provider_observation_tracks_only_the_current_process_without_rebinding_projection() {
        let mut state = ready_projection_state();
        let binding = capture_projection_authority_from_state(&state, None, "project-a").unwrap();
        let event = |id: &str, phase: &str| {
            serde_json::json!({
                "type": "runtime.notification",
                "notification": { "kind": "provider_connection", "providerConnectionId": id, "state": phase }
            })
        };
        assert_eq!(state.observed_provider_connection_id(), None);
        state.observe_provider_connection("old-runtime", &event("provider-old", "connected"));
        assert_eq!(state.observed_provider_connection_id(), None);
        state.observe_provider_connection("runtime-a", &event("provider-a", "connected"));
        assert_eq!(
            state.observed_provider_connection_id().as_deref(),
            Some("provider-a")
        );
        assert!(projection_authority_binding_is_current(&state, &binding));
        state.observe_provider_connection("runtime-a", &event("provider-b", "connected"));
        state.observe_provider_connection("runtime-a", &event("provider-a", "disconnected"));
        assert_eq!(
            state.observed_provider_connection_id().as_deref(),
            Some("provider-b")
        );
        state.observe_provider_connection("runtime-a", &event("provider-b", "disconnected"));
        assert_eq!(state.observed_provider_connection_id(), None);
        assert!(projection_authority_binding_is_current(&state, &binding));
        state.phase = RuntimePhase::Faulted;
        state.observe_provider_connection("runtime-a", &event("provider-b", "connected"));
        assert_eq!(state.observed_provider_connection_id(), None);
    }

    fn ready_projection_state() -> SupervisorState {
        let mut state = SupervisorState::default();
        state.phase = RuntimePhase::Ready;
        state.runtime_generation = Some("runtime-a".to_owned());
        state.revision = 7;
        state.authority = Some(RuntimeAuthority {
            project_id: "project-a".to_owned(),
            activation_token: "activation-a".to_owned(),
            renderer_session_id: "renderer-a".to_owned(),
            renderer_generation: 3,
            window_label: "main".to_owned(),
        });
        state
    }

    #[test]
    fn p2d_same_project_restart_cannot_pass_projection_emit_gate() {
        let mut state = ready_projection_state();
        let binding =
            capture_projection_authority_from_state(&state, Some("runtime-a"), "project-a")
                .expect("capture exact authority");
        assert!(projection_authority_binding_is_current(&state, &binding));

        state.runtime_generation = Some("runtime-b".to_owned());
        state.revision += 1;
        state.authority = Some(RuntimeAuthority {
            project_id: "project-a".to_owned(),
            activation_token: "activation-b".to_owned(),
            renderer_session_id: "renderer-a".to_owned(),
            renderer_generation: 4,
            window_label: "main".to_owned(),
        });
        assert!(!projection_authority_binding_is_current(&state, &binding));
    }

    #[test]
    fn p2d_projection_emit_gate_rejects_each_stale_authority_dimension() {
        let state = ready_projection_state();
        let binding = capture_projection_authority_from_state(&state, None, "project-a")
            .expect("capture exact authority");

        let mut changed = ready_projection_state();
        changed.revision += 1;
        assert!(!projection_authority_binding_is_current(&changed, &binding));

        let mut changed = ready_projection_state();
        changed.authority.as_mut().unwrap().activation_token = "activation-b".to_owned();
        assert!(!projection_authority_binding_is_current(&changed, &binding));

        let mut changed = ready_projection_state();
        changed.authority.as_mut().unwrap().renderer_session_id = "renderer-b".to_owned();
        assert!(!projection_authority_binding_is_current(&changed, &binding));

        let mut changed = ready_projection_state();
        changed.authority.as_mut().unwrap().renderer_generation += 1;
        assert!(!projection_authority_binding_is_current(&changed, &binding));
    }

    #[test]
    fn p2d_delayed_same_project_ingest_frame_is_rejected_by_the_current_validator() {
        let mut restarted = ready_projection_state();
        restarted.runtime_generation = Some("runtime-b".to_owned());
        restarted.revision = 11;
        restarted.authority = Some(RuntimeAuthority {
            project_id: "project-a".to_owned(),
            activation_token: "activation-b".to_owned(),
            renderer_session_id: "renderer-b".to_owned(),
            renderer_generation: 4,
            window_label: "main".to_owned(),
        });
        let delayed = ProjectionEventsFrame {
            project_id: "project-a".to_owned(),
            runtime_generation: "runtime-a".to_owned(),
            activation_token: "activation-a".to_owned(),
            renderer_session_id: "renderer-a".to_owned(),
            renderer_generation: 3,
            expected_status_revision: 7,
            events: Vec::new(),
        };

        let error = authorize_projection_ingest_frame(&restarted, "runtime-b", &delayed)
            .expect_err("old same-project frame must fail closed");
        assert_eq!(error.code, "projection_ingest_authority_mismatch");
    }

    #[test]
    fn p2d_projection_ingest_dto_requires_the_exact_native_authority_header() {
        let exact = serde_json::json!({
            "projectId": "project-a",
            "runtimeGeneration": "runtime-a",
            "activationToken": "activation-a",
            "rendererSessionId": "renderer-a",
            "rendererGeneration": 3,
            "expectedStatusRevision": 7,
            "events": [],
        });
        serde_json::from_value::<ProjectionEventsFrame>(exact.clone()).expect("exact ingest frame");
        let mut missing = exact.clone();
        missing
            .as_object_mut()
            .unwrap()
            .remove("expectedStatusRevision");
        assert!(serde_json::from_value::<ProjectionEventsFrame>(missing).is_err());
        let mut extra = exact;
        extra
            .as_object_mut()
            .unwrap()
            .insert("nativeComputedRevision".to_owned(), serde_json::json!(7));
        assert!(serde_json::from_value::<ProjectionEventsFrame>(extra).is_err());
    }

    #[test]
    fn p2d_projection_frames_serialize_the_exact_authority_header() {
        let cleared = serde_json::to_value(DispatchRecoveryClearedEvent {
            schema_version: 1,
            project_id: "project-a".to_owned(),
            runtime_generation: "runtime-a".to_owned(),
            activation_token: "activation-a".to_owned(),
            renderer_session_id: "renderer-a".to_owned(),
            renderer_generation: 3,
            status_revision: 7,
            dispatch_id: "message-a".to_owned(),
        })
        .expect("serialize dispatch recovery clear event");
        assert_eq!(
            cleared,
            serde_json::json!({
                "schemaVersion": 1,
                "projectId": "project-a",
                "runtimeGeneration": "runtime-a",
                "activationToken": "activation-a",
                "rendererSessionId": "renderer-a",
                "rendererGeneration": 3,
                "statusRevision": 7,
                "dispatchId": "message-a",
            })
        );

        let changed = serde_json::to_value(ProjectionChangedEvent {
            schema_version: 1,
            project_id: "project-a".to_owned(),
            runtime_generation: "runtime-a".to_owned(),
            activation_token: "activation-a".to_owned(),
            renderer_session_id: "renderer-a".to_owned(),
            renderer_generation: 3,
            status_revision: 7,
            stream_id: "stream-a".to_owned(),
            applied_journal_sequence: 11,
            projection_revision: 5,
            event_count: 2,
            message_count: 1,
            status: "applied".to_owned(),
        })
        .expect("serialize projection event");
        assert_eq!(
            changed,
            serde_json::json!({
                "schemaVersion": 1,
                "projectId": "project-a",
                "runtimeGeneration": "runtime-a",
                "activationToken": "activation-a",
                "rendererSessionId": "renderer-a",
                "rendererGeneration": 3,
                "statusRevision": 7,
                "streamId": "stream-a",
                "appliedJournalSequence": 11,
                "projectionRevision": 5,
                "eventCount": 2,
                "messageCount": 1,
                "status": "applied",
            })
        );
    }
}
