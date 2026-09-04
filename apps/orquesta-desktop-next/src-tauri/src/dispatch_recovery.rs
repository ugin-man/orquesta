use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::error::{AppError, AppResult};
use crate::logging::now_ms;
use crate::storage::{atomic_write_json, load_primary_or_backup, materialize_sentinel};
use crate::validation::{bounded_id, bounded_text, canonical_uuid};

const MAX_RECOVERY_RECORDS: usize = 512;
const MAX_RESOLUTION_TOMBSTONES: usize = 128;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DispatchPhase {
    Prepared,
    OutcomeUnknown,
    Accepted,
    #[serde(
        rename = "cleanup_pending",
        alias = "definitive_failure_cleanup_pending"
    )]
    CleanupPending,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DispatchReceipt {
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchRecoveryRecord {
    pub schema_version: u32,
    pub phase: DispatchPhase,
    pub message_id: String,
    pub project_id: String,
    pub runtime_project_id: String,
    pub target_agent_id: String,
    pub action_fingerprint: String,
    pub attachment_count: usize,
    pub attachment_handles: Vec<String>,
    pub ordered_attachment_sha256: Vec<String>,
    pub selected_context_count: usize,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub receipt: Option<DispatchReceipt>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolutionTombstone {
    message_id: String,
    decision: String,
    resolved_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DispatchRecoveryDocument {
    schema_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    current: Option<DispatchRecoveryRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_resolution: Option<ResolutionTombstone>,
    #[serde(default)]
    records: BTreeMap<String, DispatchRecoveryRecord>,
    #[serde(default)]
    resolutions: BTreeMap<String, ResolutionTombstone>,
}

impl Default for DispatchRecoveryDocument {
    fn default() -> Self {
        Self {
            schema_version: 2,
            current: None,
            last_resolution: None,
            records: BTreeMap::new(),
            resolutions: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchRecoveryStatus {
    pub phase: DispatchPhase,
    pub message_id: String,
    pub project_id: String,
    pub runtime_project_id: String,
    pub target_agent_id: String,
    pub action_fingerprint: String,
    pub attachment_count: usize,
    pub selected_context_count: usize,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub receipt: Option<DispatchReceipt>,
}

impl From<&DispatchRecoveryRecord> for DispatchRecoveryStatus {
    fn from(value: &DispatchRecoveryRecord) -> Self {
        Self {
            phase: value.phase,
            message_id: value.message_id.clone(),
            project_id: value.project_id.clone(),
            runtime_project_id: value.runtime_project_id.clone(),
            target_agent_id: value.target_agent_id.clone(),
            action_fingerprint: value.action_fingerprint.clone(),
            attachment_count: value.attachment_count,
            selected_context_count: value.selected_context_count,
            created_at_ms: value.created_at_ms,
            updated_at_ms: value.updated_at_ms,
            receipt: value.receipt.clone(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchFingerprintInput {
    pub runtime_project_id: String,
    pub target_agent_id: String,
    pub text: String,
    #[serde(default)]
    pub ordered_attachment_content_sha256: Vec<String>,
    #[serde(default)]
    pub selected_context_ids: Vec<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub recommended_model: Option<String>,
    #[serde(default)]
    pub requested_model: Option<String>,
    #[serde(default)]
    pub sandbox: Option<String>,
    #[serde(default)]
    pub approval_policy: Option<String>,
    #[serde(default)]
    pub service_tier: Option<String>,
}

#[derive(Debug, Clone)]
pub enum DispatchPreparation {
    Created(DispatchRecoveryRecord),
    Retry(DispatchRecoveryRecord),
    AlreadyAccepted(DispatchRecoveryRecord),
}

pub struct DispatchRecoveryStore {
    path: PathBuf,
    document: DispatchRecoveryDocument,
}

impl DispatchRecoveryStore {
    pub fn open(path: PathBuf) -> AppResult<Self> {
        materialize_sentinel(&path, &DispatchRecoveryDocument::default())?;
        let mut document: DispatchRecoveryDocument =
            load_primary_or_backup(&path, "dispatch_recovery_identity_uncertain")?;
        let migrated = document.schema_version == 1;
        if !matches!(document.schema_version, 1 | 2) {
            return Err(AppError::new(
                "dispatch_recovery_schema_unsupported",
                "Dispatch recovery was written by a newer Desktop Next",
            )
            .outcome_unknown(true));
        }
        if migrated {
            if let Some(record) = document.current.take() {
                document.records.insert(record.project_id.clone(), record);
            }
            if let Some(resolution) = document.last_resolution.take() {
                document
                    .resolutions
                    .insert(resolution.message_id.clone(), resolution);
            }
            document.schema_version = 2;
        } else if document.current.is_some() || document.last_resolution.is_some() {
            return Err(AppError::new(
                "dispatch_recovery_corrupt",
                "Recovery contains legacy fields in the current schema",
            )
            .outcome_unknown(true));
        }
        validate_document(&document)?;
        let store = Self { path, document };
        if migrated {
            store.persist_document(&store.document)?;
        }
        Ok(store)
    }

    pub fn status_for_project(&self, project_id: &str) -> Option<DispatchRecoveryStatus> {
        self.document
            .records
            .get(project_id)
            .map(DispatchRecoveryStatus::from)
    }

    pub fn status_for_message(&self, message_id: &str) -> Option<DispatchRecoveryStatus> {
        self.current_private_for_message(message_id)
            .as_ref()
            .map(DispatchRecoveryStatus::from)
    }

    pub fn current_private_for_project(&self, project_id: &str) -> Option<DispatchRecoveryRecord> {
        self.document.records.get(project_id).cloned()
    }

    pub fn current_private_for_message(&self, message_id: &str) -> Option<DispatchRecoveryRecord> {
        self.document
            .records
            .values()
            .find(|record| record.message_id == message_id)
            .cloned()
    }

    pub fn all_private(&self) -> Vec<DispatchRecoveryRecord> {
        self.document.records.values().cloned().collect()
    }

    pub fn prepare(
        &mut self,
        proposed_message_id: &str,
        project_id: &str,
        fingerprint: &DispatchFingerprintInput,
        attachment_handles: Vec<String>,
    ) -> AppResult<DispatchPreparation> {
        bounded_id(proposed_message_id, "messageId")?;
        bounded_id(project_id, "projectId")?;
        let action_fingerprint = action_fingerprint_v1(fingerprint)?;
        if let Some(current) = self.document.records.get(project_id) {
            if current.action_fingerprint != action_fingerprint
                || current.project_id != project_id
                || current.runtime_project_id != fingerprint.runtime_project_id
                || current.target_agent_id != fingerprint.target_agent_id
            {
                return Err(AppError::new("dispatch_recovery_action_mismatch", "An unresolved action with a different immutable fingerprint owns dispatch recovery")
                    .outcome_unknown(true)
                    .with_details(serde_json::json!({ "messageId": current.message_id, "recoveryLockRetained": true })));
            }
            if current.phase == DispatchPhase::CleanupPending {
                return Err(AppError::new("dispatch_recovery_cleanup_pending", "Definitive-failure cleanup must complete before dispatch can resume")
                    .outcome_unknown(true)
                    .with_details(serde_json::json!({ "messageId": current.message_id, "recoveryLockRetained": true })));
            }
            return Ok(if current.phase == DispatchPhase::Accepted {
                DispatchPreparation::AlreadyAccepted(current.clone())
            } else {
                DispatchPreparation::Retry(current.clone())
            });
        }
        let now = now_ms();
        let record = DispatchRecoveryRecord {
            schema_version: 1,
            phase: DispatchPhase::Prepared,
            message_id: proposed_message_id.to_owned(),
            project_id: project_id.to_owned(),
            runtime_project_id: fingerprint.runtime_project_id.clone(),
            target_agent_id: fingerprint.target_agent_id.clone(),
            action_fingerprint,
            attachment_count: attachment_handles.len(),
            attachment_handles,
            ordered_attachment_sha256: fingerprint.ordered_attachment_content_sha256.clone(),
            selected_context_count: fingerprint.selected_context_ids.len(),
            created_at_ms: now,
            updated_at_ms: now,
            receipt: None,
        };
        validate_record(&record)?;
        let mut next = self.document.clone();
        next.records.insert(project_id.to_owned(), record.clone());
        self.persist_document(&next)?;
        self.document = next;
        Ok(DispatchPreparation::Created(record))
    }

    pub fn mark_outcome_unknown(&mut self, message_id: &str) -> AppResult<DispatchRecoveryStatus> {
        self.transition(message_id, DispatchPhase::OutcomeUnknown, None)
    }

    pub fn mark_accepted(
        &mut self,
        message_id: &str,
        receipt: DispatchReceipt,
    ) -> AppResult<DispatchRecoveryStatus> {
        self.transition(message_id, DispatchPhase::Accepted, Some(receipt))
    }

    pub fn mark_cleanup_pending(&mut self, message_id: &str) -> AppResult<DispatchRecoveryRecord> {
        self.transition(message_id, DispatchPhase::CleanupPending, None)?;
        self.current_private_for_message(message_id).ok_or_else(|| {
            AppError::new(
                "dispatch_recovery_not_found",
                "Transitioned recovery record is missing",
            )
        })
    }

    fn transition(
        &mut self,
        message_id: &str,
        phase: DispatchPhase,
        receipt: Option<DispatchReceipt>,
    ) -> AppResult<DispatchRecoveryStatus> {
        let mut next = self.document.clone();
        let project_id = next
            .records
            .iter()
            .find_map(|(project_id, record)| {
                (record.message_id == message_id).then(|| project_id.clone())
            })
            .ok_or_else(|| {
                AppError::new(
                    "dispatch_recovery_not_found",
                    "No unresolved dispatch exists",
                )
            })?;
        let current = next
            .records
            .get_mut(&project_id)
            .expect("located recovery remains present");
        if let (Some(current_receipt), Some(next_receipt)) = (&current.receipt, &receipt) {
            if current_receipt != next_receipt {
                return Err(AppError::new(
                    "dispatch_recovery_receipt_conflict",
                    "Dispatch receipt conflicts with the durable receipt",
                )
                .outcome_unknown(true));
            }
        }
        if current.phase == DispatchPhase::Accepted && phase == DispatchPhase::Accepted {
            if current.receipt == receipt {
                return Ok(DispatchRecoveryStatus::from(&*current));
            }
            return Err(AppError::new(
                "dispatch_recovery_receipt_conflict",
                "Accepted dispatch receipt conflicts with the durable receipt",
            )
            .outcome_unknown(true));
        }
        if !matches!(
            (current.phase, phase),
            (DispatchPhase::Prepared, DispatchPhase::Prepared)
                | (DispatchPhase::Prepared, DispatchPhase::OutcomeUnknown)
                | (DispatchPhase::Prepared, DispatchPhase::Accepted)
                | (DispatchPhase::Prepared, DispatchPhase::CleanupPending)
                | (DispatchPhase::OutcomeUnknown, DispatchPhase::OutcomeUnknown)
                | (DispatchPhase::OutcomeUnknown, DispatchPhase::Accepted)
                | (DispatchPhase::OutcomeUnknown, DispatchPhase::CleanupPending)
                | (DispatchPhase::Accepted, DispatchPhase::OutcomeUnknown)
                | (DispatchPhase::Accepted, DispatchPhase::CleanupPending)
                | (DispatchPhase::CleanupPending, DispatchPhase::CleanupPending)
        ) {
            return Err(AppError::new(
                "dispatch_recovery_transition_invalid",
                "Dispatch recovery phase transition is invalid",
            )
            .outcome_unknown(true));
        }
        current.phase = phase;
        current.updated_at_ms = now_ms();
        if receipt.is_some() {
            current.receipt = receipt;
        }
        let status = DispatchRecoveryStatus::from(&*current);
        self.persist_document(&next)?;
        self.document = next;
        Ok(status)
    }

    pub fn clear_after_cleanup(
        &mut self,
        message_id: &str,
        decision: &str,
    ) -> AppResult<Option<DispatchRecoveryStatus>> {
        self.clear_resolved(
            message_id,
            decision,
            DispatchPhase::CleanupPending,
            "dispatch_recovery_cleanup_not_ready",
            "Recovery cannot be cleared before durable cleanup admission",
        )
    }

    pub fn clear_preflight_failure(
        &mut self,
        message_id: &str,
        decision: &str,
    ) -> AppResult<Option<DispatchRecoveryStatus>> {
        self.clear_resolved(
            message_id,
            decision,
            DispatchPhase::Prepared,
            "dispatch_recovery_preflight_not_ready",
            "Recovery cannot retain a draft after dispatch ownership changed",
        )
    }

    fn clear_resolved(
        &mut self,
        message_id: &str,
        decision: &str,
        required_phase: DispatchPhase,
        phase_error_code: &str,
        phase_error_message: &str,
    ) -> AppResult<Option<DispatchRecoveryStatus>> {
        let current_project = self
            .document
            .records
            .iter()
            .find_map(|(project_id, record)| {
                (record.message_id == message_id).then(|| project_id.clone())
            });
        if current_project.is_none()
            && self
                .document
                .resolutions
                .get(message_id)
                .is_some_and(|item| item.decision == decision)
        {
            return Ok(None);
        }
        let Some(project_id) = current_project else {
            return Err(AppError::new(
                "dispatch_recovery_resolution_mismatch",
                "Recovery was already resolved with a different message or decision",
            )
            .outcome_unknown(true));
        };
        if self
            .document
            .records
            .get(&project_id)
            .is_some_and(|record| record.phase != required_phase)
        {
            return Err(AppError::new(phase_error_code, phase_error_message).outcome_unknown(true));
        }
        let mut next = self.document.clone();
        next.records.remove(&project_id);
        next.resolutions.insert(
            message_id.to_owned(),
            ResolutionTombstone {
                message_id: message_id.to_owned(),
                decision: decision.to_owned(),
                resolved_at_ms: now_ms(),
            },
        );
        while next.resolutions.len() > MAX_RESOLUTION_TOMBSTONES {
            let oldest = next
                .resolutions
                .iter()
                .min_by_key(|(message_id, item)| (item.resolved_at_ms, *message_id))
                .map(|(message_id, _)| message_id.clone())
                .expect("oversized resolution map is non-empty");
            next.resolutions.remove(&oldest);
        }
        self.persist_document(&next)?;
        self.document = next;
        Ok(None)
    }

    pub fn terminal_proof_matches(&self, details: &Value) -> bool {
        let Some(message_id) = details.get("messageId").and_then(Value::as_str) else {
            return false;
        };
        let Some(current) = self
            .document
            .records
            .values()
            .find(|record| record.message_id == message_id)
        else {
            return false;
        };
        details.get("terminalOutcome").and_then(Value::as_str) == Some("failed")
            && details.get("actionFingerprint").and_then(Value::as_str)
                == Some(current.action_fingerprint.as_str())
    }

    fn persist_document(&self, document: &DispatchRecoveryDocument) -> AppResult<()> {
        validate_document(document)?;
        atomic_write_json(&self.path, document)
    }
}

fn validate_document(document: &DispatchRecoveryDocument) -> AppResult<()> {
    if document.schema_version != 2
        || document.current.is_some()
        || document.last_resolution.is_some()
        || document.records.len() > MAX_RECOVERY_RECORDS
        || document.resolutions.len() > MAX_RESOLUTION_TOMBSTONES
    {
        return Err(AppError::new(
            "dispatch_recovery_corrupt",
            "Recovery document shape is invalid",
        )
        .outcome_unknown(true));
    }
    let mut message_ids = BTreeSet::new();
    let mut attachment_handles = BTreeSet::new();
    for (project_id, record) in &document.records {
        validate_record(record)?;
        if project_id != &record.project_id || !message_ids.insert(record.message_id.clone()) {
            return Err(AppError::new(
                "dispatch_recovery_corrupt",
                "Recovery identity is inconsistent",
            )
            .outcome_unknown(true));
        }
        for handle in &record.attachment_handles {
            if !attachment_handles.insert(handle.clone()) {
                return Err(AppError::new(
                    "dispatch_recovery_corrupt",
                    "Recovery contains duplicate attachment ownership",
                )
                .outcome_unknown(true));
            }
        }
    }
    for (message_id, resolution) in &document.resolutions {
        bounded_id(message_id, "messageId")?;
        bounded_id(&resolution.message_id, "messageId")?;
        bounded_text(&resolution.decision, "decision", 128)?;
        if message_id != &resolution.message_id || message_ids.contains(message_id) {
            return Err(AppError::new(
                "dispatch_recovery_corrupt",
                "Recovery resolution identity is inconsistent",
            )
            .outcome_unknown(true));
        }
    }
    Ok(())
}

pub fn action_fingerprint_v1(input: &DispatchFingerprintInput) -> AppResult<String> {
    bounded_id(&input.runtime_project_id, "runtimeProjectId")?;
    bounded_id(&input.target_agent_id, "targetAgentId")?;
    bounded_text(
        &input.text,
        "text",
        crate::protocol::GENERATED_MESSAGE_TEXT_MAX_UTF8_BYTES,
    )?;
    if input.ordered_attachment_content_sha256.len()
        > crate::protocol::GENERATED_ATTACHMENT_MAX_PER_DISPATCH
        || input.selected_context_ids.len() > 512
    {
        return Err(AppError::new(
            "dispatch_fingerprint_input_invalid",
            "Fingerprint input exceeds limits",
        ));
    }
    for digest in &input.ordered_attachment_content_sha256 {
        if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(AppError::new(
                "dispatch_attachment_digest_invalid",
                "Attachment content digest is invalid",
            ));
        }
    }
    let mut options = BTreeMap::new();
    options.insert(
        "effort",
        input
            .effort
            .clone()
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    options.insert(
        "recommendedModel",
        input
            .recommended_model
            .clone()
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    options.insert(
        "requestedModel",
        input
            .requested_model
            .clone()
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    options.insert(
        "sandbox",
        input
            .sandbox
            .clone()
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    options.insert(
        "approvalPolicy",
        input
            .approval_policy
            .clone()
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    options.insert(
        "serviceTier",
        input
            .service_tier
            .clone()
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    let mut material = BTreeMap::new();
    material.insert(
        "additionalParams",
        serde_json::to_value(options).expect("serializable"),
    );
    material.insert(
        "orderedAttachmentContentSha256",
        serde_json::to_value(&input.ordered_attachment_content_sha256).expect("serializable"),
    );
    material.insert(
        "runtimeProjectId",
        Value::String(input.runtime_project_id.clone()),
    );
    material.insert("schemaVersion", Value::from(1));
    material.insert(
        "selectedContextIds",
        serde_json::to_value(&input.selected_context_ids).expect("serializable"),
    );
    material.insert(
        "targetAgentId",
        Value::String(input.target_agent_id.clone()),
    );
    material.insert("text", Value::String(input.text.clone()));
    let canonical = canonical_json(&serde_json::to_value(material).expect("serializable"));
    Ok(hex::encode(Sha256::digest(canonical.as_bytes())))
}

fn canonical_json(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => serde_json::to_string(value).expect("JSON string"),
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(values) => {
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort();
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|key| format!(
                        "{}:{}",
                        serde_json::to_string(key).expect("JSON key"),
                        canonical_json(&values[key])
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    }
}

fn validate_record(record: &DispatchRecoveryRecord) -> AppResult<()> {
    if record.schema_version != 1 {
        return Err(AppError::new(
            "dispatch_recovery_schema_unsupported",
            "Recovery record schema is unsupported",
        )
        .outcome_unknown(true));
    }
    bounded_id(&record.message_id, "messageId")?;
    bounded_id(&record.project_id, "projectId")?;
    bounded_id(&record.runtime_project_id, "runtimeProjectId")?;
    bounded_id(&record.target_agent_id, "targetAgentId")?;
    match (&record.phase, &record.receipt) {
        (DispatchPhase::Prepared, None) => {}
        (DispatchPhase::Prepared, Some(_)) => {
            return Err(AppError::new(
                "dispatch_recovery_corrupt",
                "Prepared recovery must not contain a dispatch receipt",
            )
            .outcome_unknown(true));
        }
        (DispatchPhase::Accepted, None) => {
            return Err(AppError::new(
                "dispatch_recovery_corrupt",
                "Accepted recovery must contain a dispatch receipt",
            )
            .outcome_unknown(true));
        }
        (_, None) => {}
        (_, Some(receipt)) => match (&receipt.thread_id, &receipt.turn_id) {
            (Some(thread_id), Some(turn_id)) => {
                bounded_id(thread_id, "receipt.threadId")?;
                bounded_id(turn_id, "receipt.turnId")?;
            }
            _ => {
                return Err(AppError::new(
                    "dispatch_recovery_corrupt",
                    "Dispatch receipt identity is incomplete",
                )
                .outcome_unknown(true));
            }
        },
    }
    if record.action_fingerprint.len() != 64
        || !record
            .action_fingerprint
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(
            AppError::new("dispatch_recovery_corrupt", "Action fingerprint is invalid")
                .outcome_unknown(true),
        );
    }
    if record.attachment_count != record.attachment_handles.len()
        || record.attachment_count != record.ordered_attachment_sha256.len()
        || record.attachment_count > crate::protocol::GENERATED_ATTACHMENT_MAX_PER_DISPATCH
    {
        return Err(AppError::new(
            "dispatch_recovery_corrupt",
            "Attachment recovery metadata is inconsistent",
        )
        .outcome_unknown(true));
    }
    for handle in &record.attachment_handles {
        canonical_uuid(handle, "attachmentHandle")?;
    }
    for digest in &record.ordered_attachment_sha256 {
        if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(
                AppError::new("dispatch_recovery_corrupt", "Attachment digest is invalid")
                    .outcome_unknown(true),
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_recovery_path(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "orquesta-dispatch-recovery-{label}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).expect("create recovery test root");
        root.join("dispatch-recovery.v1.json")
    }

    fn fingerprint(project_id: &str, text: &str) -> DispatchFingerprintInput {
        DispatchFingerprintInput {
            runtime_project_id: project_id.into(),
            target_agent_id: "orchestrator".into(),
            text: text.into(),
            ordered_attachment_content_sha256: vec![],
            selected_context_ids: vec![],
            effort: None,
            recommended_model: None,
            requested_model: None,
            sandbox: None,
            approval_policy: None,
            service_tier: None,
        }
    }

    fn valid_record(
        phase: DispatchPhase,
        receipt: Option<DispatchReceipt>,
    ) -> DispatchRecoveryRecord {
        DispatchRecoveryRecord {
            schema_version: 1,
            phase,
            message_id: "message-a".into(),
            project_id: "project-a".into(),
            runtime_project_id: "runtime-a".into(),
            target_agent_id: "orchestrator".into(),
            action_fingerprint: "a".repeat(64),
            attachment_count: 0,
            attachment_handles: vec![],
            ordered_attachment_sha256: vec![],
            selected_context_count: 0,
            created_at_ms: 1,
            updated_at_ms: 1,
            receipt,
        }
    }

    #[test]
    fn receipt_shape_is_validated_at_the_durable_boundary() {
        let complete_receipt = DispatchReceipt {
            thread_id: Some("thread-a".into()),
            turn_id: Some("turn-a".into()),
        };
        assert!(validate_record(&valid_record(DispatchPhase::Prepared, None)).is_ok());
        assert!(validate_record(&valid_record(
            DispatchPhase::Accepted,
            Some(complete_receipt.clone()),
        ))
        .is_ok());
        assert!(validate_record(&valid_record(
            DispatchPhase::OutcomeUnknown,
            Some(complete_receipt),
        ))
        .is_ok());

        let invalid = [
            valid_record(
                DispatchPhase::Prepared,
                Some(DispatchReceipt {
                    thread_id: Some("thread-a".into()),
                    turn_id: Some("turn-a".into()),
                }),
            ),
            valid_record(DispatchPhase::Accepted, None),
            valid_record(
                DispatchPhase::Accepted,
                Some(DispatchReceipt {
                    thread_id: Some("thread-a".into()),
                    turn_id: None,
                }),
            ),
            valid_record(
                DispatchPhase::OutcomeUnknown,
                Some(DispatchReceipt {
                    thread_id: None,
                    turn_id: Some("turn-a".into()),
                }),
            ),
            valid_record(
                DispatchPhase::CleanupPending,
                Some(DispatchReceipt {
                    thread_id: Some(String::new()),
                    turn_id: Some("turn-a".into()),
                }),
            ),
            valid_record(
                DispatchPhase::Accepted,
                Some(DispatchReceipt {
                    thread_id: Some("x".repeat(129)),
                    turn_id: Some("turn-a".into()),
                }),
            ),
        ];
        for record in invalid {
            assert!(
                validate_record(&record).is_err(),
                "invalid receipt was accepted"
            );
        }
    }

    #[test]
    fn fingerprint_is_stable_and_order_sensitive() {
        let input = DispatchFingerprintInput {
            runtime_project_id: "project-1".into(),
            target_agent_id: "orchestrator".into(),
            text: "Route this work".into(),
            ordered_attachment_content_sha256: vec!["a".repeat(64), "b".repeat(64)],
            selected_context_ids: vec!["context-b".into(), "context-a".into()],
            effort: None,
            recommended_model: None,
            requested_model: None,
            sandbox: None,
            approval_policy: None,
            service_tier: None,
        };
        assert_eq!(
            action_fingerprint_v1(&input).unwrap(),
            "8460f5ce538e2c63bb721bd59c33e8c8a4597bc976f0b2b44ca3097df73f4fe5"
        );
        let mut reversed = input.clone();
        reversed.selected_context_ids.reverse();
        assert_ne!(
            action_fingerprint_v1(&input).unwrap(),
            action_fingerprint_v1(&reversed).unwrap()
        );
    }

    #[test]
    fn unresolved_dispatches_are_isolated_per_project_and_survive_restart() {
        let path = temp_recovery_path("project-isolation");
        let mut store = DispatchRecoveryStore::open(path.clone()).expect("open store");
        store
            .prepare(
                "message-a",
                "project-a",
                &fingerprint("runtime-a", "A"),
                vec![],
            )
            .expect("prepare A");
        store
            .prepare(
                "message-b",
                "project-b",
                &fingerprint("runtime-b", "B"),
                vec![],
            )
            .expect("prepare B");
        store
            .mark_accepted(
                "message-a",
                DispatchReceipt {
                    thread_id: Some("thread-a".into()),
                    turn_id: Some("turn-a".into()),
                },
            )
            .expect("accept A");
        store
            .mark_outcome_unknown("message-b")
            .expect("mark B unknown");
        drop(store);

        let mut reopened = DispatchRecoveryStore::open(path.clone()).expect("reopen store");
        assert_eq!(
            reopened
                .status_for_project("project-a")
                .expect("A retained")
                .phase,
            DispatchPhase::Accepted
        );
        assert_eq!(
            reopened
                .status_for_project("project-b")
                .expect("B retained")
                .phase,
            DispatchPhase::OutcomeUnknown
        );
        reopened
            .mark_cleanup_pending("message-a")
            .expect("admit cleanup for A");
        reopened
            .clear_after_cleanup("message-a", "terminal")
            .expect("clear only A");
        assert!(reopened.status_for_project("project-a").is_none());
        assert!(reopened.status_for_project("project-b").is_some());
        let _ = std::fs::remove_dir_all(path.parent().expect("test root"));
    }

    #[test]
    fn duplicate_message_and_attachment_ownership_is_rejected_before_persist() {
        let path = temp_recovery_path("unique-ownership");
        let mut store = DispatchRecoveryStore::open(path.clone()).expect("open store");
        let shared_handle = "11111111-1111-4111-8111-111111111111".to_owned();
        let mut project_a = fingerprint("runtime-a", "A");
        project_a.ordered_attachment_content_sha256 = vec!["a".repeat(64)];
        store
            .prepare(
                "message-a",
                "project-a",
                &project_a,
                vec![shared_handle.clone()],
            )
            .expect("prepare A");
        assert_eq!(
            store
                .prepare(
                    "message-a",
                    "project-b",
                    &fingerprint("runtime-b", "B"),
                    vec![]
                )
                .err()
                .expect("duplicate message rejected")
                .code,
            "dispatch_recovery_corrupt"
        );
        let mut project_b = fingerprint("runtime-b", "B");
        project_b.ordered_attachment_content_sha256 = vec!["b".repeat(64)];
        assert_eq!(
            store
                .prepare("message-b", "project-b", &project_b, vec![shared_handle])
                .err()
                .expect("duplicate attachment rejected")
                .code,
            "dispatch_recovery_corrupt"
        );
        assert!(store.status_for_project("project-a").is_some());
        assert!(store.status_for_project("project-b").is_none());
        DispatchRecoveryStore::open(path.clone()).expect("persisted state stays readable");
        let _ = std::fs::remove_dir_all(path.parent().expect("test root"));
    }

    #[test]
    fn accepted_receipt_is_idempotent_but_cannot_be_replaced() {
        let path = temp_recovery_path("accepted-receipt");
        let mut store = DispatchRecoveryStore::open(path.clone()).expect("open store");
        store
            .prepare(
                "message-a",
                "project-a",
                &fingerprint("runtime-a", "A"),
                vec![],
            )
            .expect("prepare A");
        let receipt = DispatchReceipt {
            thread_id: Some("thread-a".into()),
            turn_id: Some("turn-a".into()),
        };
        store
            .mark_accepted("message-a", receipt.clone())
            .expect("accept A");
        store
            .mark_accepted("message-a", receipt.clone())
            .expect("same receipt is idempotent");
        store
            .mark_outcome_unknown("message-a")
            .expect("accepted response can become outcome unknown");
        store
            .mark_accepted("message-a", receipt.clone())
            .expect("the same receipt is accepted after outcome unknown");
        store
            .mark_outcome_unknown("message-a")
            .expect("second outcome-unknown transition");
        let conflict = store
            .mark_accepted(
                "message-a",
                DispatchReceipt {
                    thread_id: Some("thread-b".into()),
                    turn_id: Some("turn-b".into()),
                },
            )
            .err()
            .expect("conflicting receipt rejected");
        assert_eq!(conflict.code, "dispatch_recovery_receipt_conflict");
        assert_eq!(
            store
                .current_private_for_project("project-a")
                .expect("accepted record retained")
                .receipt,
            Some(receipt)
        );
        drop(store);
        let reopened = DispatchRecoveryStore::open(path.clone()).expect("accepted receipt reopens");
        assert_eq!(
            reopened
                .current_private_for_project("project-a")
                .expect("durable receipt retained after conflict")
                .receipt
                .as_ref()
                .and_then(|value| value.thread_id.as_deref()),
            Some("thread-a")
        );
        let _ = std::fs::remove_dir_all(path.parent().expect("test root"));
    }

    #[test]
    fn legacy_single_record_document_migrates_once_to_project_index() {
        let path = temp_recovery_path("v1-migration");
        let mut seed = DispatchRecoveryStore::open(path.clone()).expect("open seed");
        seed.prepare(
            "legacy-message",
            "legacy-project",
            &fingerprint("legacy-runtime", "legacy"),
            vec![],
        )
        .expect("seed record");
        let record = seed
            .current_private_for_project("legacy-project")
            .expect("seed record available");
        drop(seed);
        atomic_write_json(
            &path,
            &DispatchRecoveryDocument {
                schema_version: 1,
                current: Some(record),
                last_resolution: None,
                records: BTreeMap::new(),
                resolutions: BTreeMap::new(),
            },
        )
        .expect("write legacy document");

        let migrated = DispatchRecoveryStore::open(path.clone()).expect("migrate v1");
        assert!(migrated.status_for_project("legacy-project").is_some());
        drop(migrated);
        DispatchRecoveryStore::open(path.clone()).expect("reopen migrated v2");
        let _ = std::fs::remove_dir_all(path.parent().expect("test root"));
    }

    #[test]
    fn resolution_history_is_bounded() {
        let path = temp_recovery_path("bounded-history");
        let mut store = DispatchRecoveryStore::open(path.clone()).expect("open store");
        for index in 0..(MAX_RESOLUTION_TOMBSTONES + 2) {
            let message_id = format!("message-{index}");
            store
                .prepare(
                    &message_id,
                    "project-a",
                    &fingerprint("runtime-a", &format!("turn {index}")),
                    vec![],
                )
                .expect("prepare turn");
            store
                .mark_cleanup_pending(&message_id)
                .expect("admit cleanup");
            store
                .clear_after_cleanup(&message_id, "terminal")
                .expect("resolve turn");
        }
        assert_eq!(store.document.resolutions.len(), MAX_RESOLUTION_TOMBSTONES);
        drop(store);
        DispatchRecoveryStore::open(path.clone()).expect("bounded history reopens");
        let _ = std::fs::remove_dir_all(path.parent().expect("test root"));
    }
}
