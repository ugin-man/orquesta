use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::attachment_classification::{
    classify_reader, validate_declared_attachment, AttachmentClassification, AttachmentEncoding,
    AttachmentKind, MAX_ATTACHMENTS_PER_DISPATCH, MAX_IMAGE_BYTES, MAX_IMAGE_PREVIEW_BYTES,
    MAX_TEXT_BYTES_PER_DISPATCH,
};
use crate::attachment_guard::{open_sealed_attachment_guard, SealedAttachmentGuard};
use crate::dispatch_recovery::{DispatchPhase, DispatchRecoveryRecord};
use crate::error::{AppError, AppResult};
use crate::logging::now_ms;
use crate::storage::{
    atomic_write_json, load_primary_or_backup, materialize_sentinel, private_directory,
    sync_directory,
};
use crate::validation::canonical_uuid;

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

const MAX_ATTACHMENT_BYTES: u64 = MAX_IMAGE_BYTES;
const MAX_ATTACHMENT_PREVIEW_BYTES: u64 = MAX_IMAGE_PREVIEW_BYTES;
const MAX_DRAFT_ATTACHMENTS: usize = MAX_ATTACHMENTS_PER_DISPATCH;
const MAX_QUARANTINE_ATTACHMENTS: usize = 16;
const MAX_QUARANTINE_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentDescriptor {
    pub public_id: String,
    pub display_name: String,
    pub kind: AttachmentKind,
    pub media_type: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachmentPublicRef {
    pub selection_id: String,
    pub public_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachmentImportFile {
    pub slot_id: String,
    pub display_name: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttachmentUploadSlot {
    slot_id: String,
    display_name: String,
    declared_size_bytes: u64,
    record_handle: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttachmentRecord {
    handle: String,
    #[serde(default)]
    public_id: String,
    #[serde(default)]
    public_selection_id: String,
    display_name: String,
    #[serde(default)]
    kind: AttachmentKind,
    media_type: String,
    #[serde(default)]
    encoding: Option<AttachmentEncoding>,
    size_bytes: u64,
    content_sha256: String,
    staged_name: String,
    selection_id: Option<String>,
    dispatch_owner_message_id: Option<String>,
    created_at_ms: u64,
    #[serde(default)]
    cleanup_pending: bool,
}

impl AttachmentRecord {
    fn public(&self) -> AttachmentDescriptor {
        AttachmentDescriptor {
            public_id: self.public_id.clone(),
            display_name: self.display_name.clone(),
            kind: self.kind,
            media_type: self.media_type.clone(),
            size_bytes: self.size_bytes,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum SelectionPhase {
    Opening,
    Ready,
    CleanupPending,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SelectionBatch {
    selection_id: String,
    owner_session_id: String,
    owner_generation: u64,
    owner_window_label: String,
    phase: SelectionPhase,
    records: Vec<AttachmentRecord>,
    #[serde(default)]
    upload_slots: Vec<AttachmentUploadSlot>,
    updated_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SelectionDocument {
    schema_version: u32,
    batches: Vec<SelectionBatch>,
    retired_selection_ids: Vec<String>,
    #[serde(default)]
    retired_draft_handles: Vec<RetiredDraftHandle>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct RetiredDraftHandle {
    selection_id: String,
    handle: String,
    #[serde(default)]
    public_id: String,
    owner_session_id: String,
    owner_generation: u64,
    owner_window_label: String,
}

impl Default for SelectionDocument {
    fn default() -> Self {
        Self {
            schema_version: 5,
            batches: Vec::new(),
            retired_selection_ids: Vec::new(),
            retired_draft_handles: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QuarantineRecord {
    #[serde(flatten)]
    attachment: AttachmentRecord,
    runtime_generation: Option<String>,
    containment_kind: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QuarantineDocument {
    schema_version: u32,
    records: Vec<QuarantineRecord>,
}

impl Default for QuarantineDocument {
    fn default() -> Self {
        Self {
            schema_version: 3,
            records: Vec::new(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct ContainmentEvidence {
    pub runtime_generation: String,
    pub kind: String,
}

#[derive(Debug, Clone)]
pub struct AttachmentImportStatus {
    pub file_count: usize,
    pub staged_count: usize,
    pub attachments: Vec<AttachmentDescriptor>,
}

#[derive(Debug, Clone)]
pub struct AttachmentLease {
    pub attachments: Vec<SealedDispatchAttachment>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SealedDispatchAttachment {
    pub attachment_store_handle: String,
    pub kind: AttachmentKind,
    // Bounded presentation metadata only. Core must revalidate classification
    // and must never use either value as ownership or file-identity authority.
    pub display_name: String,
    pub media_type: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub sealed_absolute_path: String,
    pub encoding: Option<AttachmentEncoding>,
}

pub struct AttachmentStore {
    root: PathBuf,
    selection_path: PathBuf,
    quarantine_path: PathBuf,
    selections: SelectionDocument,
    quarantine: QuarantineDocument,
    records: HashMap<String, AttachmentRecord>,
    dispatch_guards: HashMap<String, Vec<SealedAttachmentGuard>>,
}

impl AttachmentStore {
    #[cfg(test)]
    pub fn open(
        root: PathBuf,
        selection_path: PathBuf,
        quarantine_path: PathBuf,
        recovery: Option<&DispatchRecoveryRecord>,
    ) -> AppResult<Self> {
        let recoveries = recovery.into_iter().cloned().collect::<Vec<_>>();
        Self::open_with_recoveries(root, selection_path, quarantine_path, &recoveries)
    }

    pub fn open_with_recoveries(
        root: PathBuf,
        selection_path: PathBuf,
        quarantine_path: PathBuf,
        recoveries: &[DispatchRecoveryRecord],
    ) -> AppResult<Self> {
        private_directory(&root)?;
        materialize_sentinel(&selection_path, &SelectionDocument::default())?;
        materialize_sentinel(&quarantine_path, &QuarantineDocument::default())?;
        let mut selections: SelectionDocument =
            load_primary_or_backup(&selection_path, "attachment_selection_identity_uncertain")?;
        let mut quarantine: QuarantineDocument =
            load_primary_or_backup(&quarantine_path, "attachment_quarantine_identity_uncertain")?;
        if !matches!(selections.schema_version, 1 | 2 | 3 | 4 | 5)
            || !matches!(quarantine.schema_version, 1 | 2 | 3)
        {
            return Err(AppError::new(
                "attachment_state_schema_unsupported",
                "Attachment state was written by a newer Desktop Next",
            )
            .outcome_unknown(true));
        }
        let migrate_selection_public_ids = selections.schema_version < 5;
        let migrate_quarantine_public_ids = quarantine.schema_version < 3;
        if migrate_selection_public_ids {
            for batch in &mut selections.batches {
                for record in &mut batch.records {
                    migrate_record_public_identity(record, &batch.selection_id)?;
                }
            }
            for retired in &mut selections.retired_draft_handles {
                if retired.public_id.is_empty() {
                    retired.public_id = fresh_public_id(&retired.handle);
                }
            }
        }
        let migrated_public_ids = selections
            .batches
            .iter()
            .flat_map(|batch| batch.records.iter())
            .map(|record| {
                (
                    record.handle.clone(),
                    (record.public_id.clone(), record.public_selection_id.clone()),
                )
            })
            .collect::<HashMap<_, _>>();
        if migrate_quarantine_public_ids {
            for item in &mut quarantine.records {
                if item.attachment.public_id.is_empty()
                    && item.attachment.public_selection_id.is_empty()
                {
                    if let Some((public_id, selection_id)) =
                        migrated_public_ids.get(&item.attachment.handle)
                    {
                        item.attachment.public_id = public_id.clone();
                        item.attachment.public_selection_id = selection_id.clone();
                    } else {
                        item.attachment.public_id = fresh_public_id(&item.attachment.handle);
                        item.attachment.public_selection_id =
                            uuid::Uuid::new_v4().hyphenated().to_string();
                    }
                } else if item.attachment.public_id.is_empty()
                    || item.attachment.public_selection_id.is_empty()
                {
                    return Err(AppError::new(
                        "attachment_public_identity_corrupt",
                        "Legacy attachment public identity is only partially present",
                    )
                    .outcome_unknown(true));
                }
            }
        }
        selections.schema_version = 5;
        quarantine.schema_version = 3;
        for retired in &selections.retired_draft_handles {
            canonical_uuid(&retired.selection_id, "selectionId")?;
            canonical_uuid(&retired.handle, "attachmentHandle")?;
            canonical_uuid(&retired.public_id, "attachmentPublicId")?;
            if retired.public_id == retired.handle {
                return Err(AppError::new(
                    "attachment_public_identity_corrupt",
                    "Retired attachment public identity aliases its store handle",
                )
                .outcome_unknown(true));
            }
            canonical_uuid(&retired.owner_session_id, "rendererSessionId")?;
            if retired.owner_generation == 0 || retired.owner_window_label.is_empty() {
                return Err(AppError::new(
                    "attachment_selection_corrupt",
                    "Retired attachment owner is invalid",
                )
                .outcome_unknown(true));
            }
        }
        let mut records = HashMap::new();
        for batch in &selections.batches {
            canonical_uuid(&batch.selection_id, "selectionId")?;
            canonical_uuid(&batch.owner_session_id, "rendererSessionId")?;
            if batch.owner_generation == 0 || batch.owner_window_label.is_empty() {
                return Err(AppError::new(
                    "attachment_selection_corrupt",
                    "Attachment selection owner is invalid",
                )
                .outcome_unknown(true));
            }
            validate_upload_slots(batch)?;
            for item in &batch.records {
                validate_attachment_record(item)?;
                if item.public_selection_id != batch.selection_id
                    || item.selection_id.as_deref() != Some(batch.selection_id.as_str())
                    || item.dispatch_owner_message_id.is_some()
                {
                    return Err(AppError::new(
                        "attachment_selection_corrupt",
                        "Draft attachment ownership is inconsistent",
                    )
                    .outcome_unknown(true));
                }
                insert_unique(&mut records, item.clone())?;
            }
        }
        let quarantined_handles = quarantine
            .records
            .iter()
            .map(|item| item.attachment.handle.clone())
            .collect::<HashSet<_>>();
        for item in &quarantine.records {
            validate_attachment_record(&item.attachment)?;
            if item.attachment.dispatch_owner_message_id.is_none()
                || item.attachment.selection_id.is_some()
            {
                return Err(AppError::new(
                    "attachment_quarantine_corrupt",
                    "Quarantined attachment ownership is inconsistent",
                )
                .outcome_unknown(true));
            }
            insert_quarantine_dominant(&mut records, item.attachment.clone())?;
        }
        // Crash prefix: quarantine commit succeeded but selection cleanup did not.
        // Quarantine ownership is the authoritative, safer phase and must never be
        // downgraded to a forgettable draft after restart.
        for batch in &mut selections.batches {
            remove_batch_handles(batch, &quarantined_handles);
        }
        selections
            .batches
            .retain(|batch| !(batch.phase == SelectionPhase::Ready && batch.records.is_empty()));
        for recovery in recoveries {
            validate_ordered_attachment_handles(&recovery.attachment_handles, true)?;
            for (index, handle) in recovery.attachment_handles.iter().enumerate() {
                let path = root.join(handle);
                let missing = match fs::symlink_metadata(&path) {
                    Ok(_) => false,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
                    Err(error) => return Err(AppError::io("inspect recovery attachment", error)),
                };
                if recovery.phase == DispatchPhase::CleanupPending {
                    let Some(record) = records.get(handle).cloned() else {
                        if missing {
                            continue;
                        }
                        return Err(AppError::new(
                            "dispatch_recovery_attachment_metadata_missing",
                            "A cleanup attachment exists without durable store metadata",
                        )
                        .outcome_unknown(true));
                    };
                    if record
                        .dispatch_owner_message_id
                        .as_deref()
                        .is_some_and(|owner| owner != recovery.message_id)
                    {
                        return Err(AppError::new(
                            "dispatch_recovery_attachment_owner_mismatch",
                            "A cleanup attachment belongs to another dispatch",
                        )
                        .outcome_unknown(true));
                    }
                    if record.dispatch_owner_message_id.is_none()
                        && !record.selection_id.as_ref().is_some_and(|selection_id| {
                            selections.batches.iter().any(|batch| {
                                batch.selection_id == *selection_id
                                    && batch.records.iter().any(|item| item.handle == *handle)
                            })
                        })
                    {
                        return Err(AppError::new(
                            "attachment_recovery_ownership_uncertain",
                            "A cleanup attachment no longer has exact durable ownership",
                        )
                        .outcome_unknown(true));
                    }
                    if missing {
                        // Terminal cleanup deletes bytes before committing metadata.
                        // A crash in that prefix is forward-complete after exact
                        // ownership has been re-established.
                        records.remove(handle);
                        quarantine
                            .records
                            .retain(|item| item.attachment.handle != *handle);
                        let removed = HashSet::from([handle.clone()]);
                        for batch in &mut selections.batches {
                            remove_batch_handles(batch, &removed);
                        }
                    }
                    continue;
                }
                if missing {
                    return Err(AppError::new(
                        "dispatch_recovery_attachment_missing",
                        "A sealed recovery attachment is missing",
                    )
                    .outcome_unknown(true));
                }
                let mut record = records.get(handle).cloned().ok_or_else(|| {
                    AppError::new(
                        "dispatch_recovery_attachment_metadata_missing",
                        "A sealed recovery attachment lost its durable store metadata",
                    )
                    .outcome_unknown(true)
                })?;
                let actual = hash_file(&root.join(&record.staged_name))?;
                if recovery.ordered_attachment_sha256.get(index) != Some(&actual)
                    || record.content_sha256 != actual
                {
                    return Err(AppError::new(
                        "dispatch_recovery_attachment_mismatch",
                        "A sealed recovery attachment does not match its durable digest",
                    )
                    .outcome_unknown(true));
                }
                if record
                    .dispatch_owner_message_id
                    .as_deref()
                    .is_some_and(|owner| owner != recovery.message_id)
                {
                    return Err(AppError::new(
                        "dispatch_recovery_attachment_owner_mismatch",
                        "A recovery attachment belongs to another dispatch",
                    )
                    .outcome_unknown(true));
                }
                record.selection_id = None;
                record.dispatch_owner_message_id = Some(recovery.message_id.clone());
                validate_attachment_record(&record)?;
                records.insert(handle.clone(), record.clone());
                if let Some(existing) = quarantine
                    .records
                    .iter_mut()
                    .find(|item| item.attachment.handle == *handle)
                {
                    existing.attachment = record;
                } else {
                    // Recovery prepare is durable before draft-to-quarantine commit.
                    // Promotion here closes that ordinary crash prefix without
                    // allowing stale renderer cleanup to delete the outbox payload.
                    quarantine.records.push(QuarantineRecord {
                        attachment: record,
                        runtime_generation: None,
                        containment_kind: None,
                    });
                }
            }
        }
        let protected_recovery_handles = recoveries
            .iter()
            .filter(|record| {
                matches!(
                    record.phase,
                    DispatchPhase::Prepared | DispatchPhase::OutcomeUnknown
                )
            })
            .flat_map(|record| record.attachment_handles.iter().cloned())
            .collect::<HashSet<_>>();
        let mut missing_quarantine_handles = HashSet::new();
        for item in &quarantine.records {
            let path = root.join(&item.attachment.staged_name);
            match fs::symlink_metadata(&path) {
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    if protected_recovery_handles.contains(&item.attachment.handle) {
                        return Err(AppError::new(
                            "dispatch_recovery_attachment_missing",
                            "A sealed outcome-unknown attachment is missing",
                        )
                        .outcome_unknown(true));
                    }
                    // File deletion precedes quarantine metadata commit.  With no
                    // live Prepared/OutcomeUnknown outbox claim, a missing byte
                    // payload is a forward-complete cleanup prefix; retaining its
                    // metadata would only consume quota forever.
                    missing_quarantine_handles.insert(item.attachment.handle.clone());
                }
                Err(error) => return Err(AppError::io("inspect quarantined attachment", error)),
            }
        }
        if !missing_quarantine_handles.is_empty() {
            quarantine
                .records
                .retain(|item| !missing_quarantine_handles.contains(&item.attachment.handle));
            for handle in &missing_quarantine_handles {
                records.remove(handle);
            }
            for batch in &mut selections.batches {
                remove_batch_handles(batch, &missing_quarantine_handles);
            }
        }
        let recovered_handles = quarantine
            .records
            .iter()
            .map(|item| item.attachment.handle.clone())
            .collect::<HashSet<_>>();
        for batch in &mut selections.batches {
            remove_batch_handles(batch, &recovered_handles);
        }
        selections
            .batches
            .retain(|batch| !(batch.phase == SelectionPhase::Ready && batch.records.is_empty()));
        let mut store = Self {
            root,
            selection_path,
            quarantine_path,
            selections,
            quarantine,
            records,
            dispatch_guards: HashMap::new(),
        };
        // Quarantine dominates selection cleanup.  Commit it first so a crash can
        // only replay the safe promotion direction.
        store.persist_quarantine()?;
        store.persist_selections()?;
        store.resume_draft_forgets()?;
        store.mark_all_renderer_sessions_cleanup_pending()?;
        // File/metadata cleanup is resumable.  Once cleanup_pending is durable it
        // may remain in memory after an ordinary I/O failure, but it is excluded
        // from bootstrap and dispatch and retried before any new selection.
        let _ = store.resume_cleanup_pending();
        store.remove_orphaned_staged_files()?;
        store.validate_budgets()?;
        Ok(store)
    }

    pub fn pending_for_session(
        &self,
        session_id: &str,
        generation: u64,
        window_label: &str,
    ) -> Vec<(String, Vec<AttachmentDescriptor>)> {
        self.selections
            .batches
            .iter()
            .filter(|batch| {
                batch.phase == SelectionPhase::Ready
                    && batch.owner_session_id == session_id
                    && batch.owner_generation == generation
                    && batch.owner_window_label == window_label
                    && batch.records.iter().any(|record| !record.cleanup_pending)
            })
            .map(|batch| {
                (
                    batch.selection_id.clone(),
                    batch
                        .records
                        .iter()
                        .filter(|record| !record.cleanup_pending)
                        .map(AttachmentRecord::public)
                        .collect(),
                )
            })
            .collect()
    }

    pub fn content_hashes(&self, handles: &[String]) -> AppResult<Vec<String>> {
        validate_ordered_attachment_handles(handles, false)?;
        if handles.len() > MAX_DRAFT_ATTACHMENTS {
            return Err(AppError::new(
                "attachment_send_limit",
                "At most four attachments may be sent in one action",
            ));
        }
        let mut text_bytes = 0_u64;
        handles
            .iter()
            .map(|handle| {
                canonical_uuid(handle, "attachmentHandle")?;
                if self.cleanup_pending_contains(handle) {
                    return Err(AppError::new(
                        "attachment_cleanup_pending",
                        "Attachment belongs to a retired renderer cleanup transaction",
                    )
                    .retryable(true));
                }
                let record = self.record_for_content(handle)?;
                if record.kind == AttachmentKind::Text {
                    text_bytes = text_bytes.saturating_add(record.size_bytes);
                    if text_bytes > MAX_TEXT_BYTES_PER_DISPATCH {
                        return Err(AppError::new(
                            "attachment_text_aggregate_limit",
                            "Text attachments may total at most 512 KiB",
                        ));
                    }
                }
                Ok(record.content_sha256.clone())
            })
            .collect()
    }

    pub fn resolve_public_dispatch_handles(
        &self,
        refs: &[AttachmentPublicRef],
        recovery: Option<&DispatchRecoveryRecord>,
    ) -> AppResult<Vec<String>> {
        if refs.is_empty() {
            return Ok(recovery
                .map(|record| record.attachment_handles.clone())
                .unwrap_or_default());
        }
        if refs.len() > MAX_DRAFT_ATTACHMENTS {
            return Err(AppError::new(
                "attachment_send_limit",
                "At most four attachments may be sent in one action",
            ));
        }
        let mut seen = HashSet::with_capacity(refs.len());
        let mut handles = Vec::with_capacity(refs.len());
        for public_ref in refs {
            canonical_uuid(&public_ref.selection_id, "attachmentSelectionId")?;
            canonical_uuid(&public_ref.public_id, "attachmentPublicId")?;
            if !seen.insert((
                public_ref.selection_id.as_str(),
                public_ref.public_id.as_str(),
            )) {
                return Err(AppError::new(
                    "attachment_public_id_duplicate",
                    "Attachment public references must be unique",
                ));
            }
            let mut matches = self.records.values().filter(|record| {
                record.public_id == public_ref.public_id
                    && record.public_selection_id == public_ref.selection_id
            });
            let record = matches.next().ok_or_else(|| {
                AppError::new(
                    "attachment_public_id_not_found",
                    "Attachment public reference is unavailable for this selection",
                )
            })?;
            if matches.next().is_some() {
                return Err(AppError::new(
                    "attachment_public_identity_corrupt",
                    "Attachment public reference resolves to more than one store record",
                )
                .outcome_unknown(true));
            }
            if record.cleanup_pending {
                return Err(AppError::new(
                    "attachment_cleanup_pending",
                    "Attachment cleanup is still pending",
                )
                .retryable(true));
            }
            if let Some(owner) = record.dispatch_owner_message_id.as_deref() {
                if recovery.is_none_or(|recovery| owner != recovery.message_id) {
                    return Err(AppError::new(
                        "attachment_in_use",
                        "Attachment belongs to another dispatch",
                    ));
                }
            } else {
                let draft = self.ready_draft_record(&record.handle)?;
                if draft.selection_id.as_deref() != Some(public_ref.selection_id.as_str()) {
                    return Err(AppError::new(
                        "attachment_selection_mismatch",
                        "Attachment public reference belongs to another selection",
                    ));
                }
            }
            handles.push(record.handle.clone());
        }
        if let Some(recovery) = recovery {
            if handles != recovery.attachment_handles {
                return Err(AppError::new(
                    "dispatch_recovery_attachment_mismatch",
                    "Exact retry cannot replace sealed attachment references",
                )
                .outcome_unknown(true));
            }
        }
        Ok(handles)
    }

    fn record_for_content(&self, handle: &str) -> AppResult<&AttachmentRecord> {
        let record = self
            .records
            .get(handle)
            .ok_or_else(|| AppError::new("attachment_not_found", "Attachment handle is unknown"))?;
        if record.dispatch_owner_message_id.is_some() {
            return Ok(record);
        }
        self.ready_draft_record(handle)
    }

    fn ready_draft_record(&self, handle: &str) -> AppResult<&AttachmentRecord> {
        let mut batches = self.selections.batches.iter().filter(|batch| {
            batch.phase == SelectionPhase::Ready
                && batch.records.iter().any(|record| record.handle == handle)
        });
        let batch = batches.next().ok_or_else(|| {
            AppError::new(
                "attachment_not_ready",
                "Attachment is not part of one complete ready selection",
            )
        })?;
        if batches.next().is_some() {
            return Err(AppError::new(
                "attachment_selection_corrupt",
                "Attachment belongs to more than one ready selection",
            )
            .outcome_unknown(true));
        }
        validate_upload_slots(batch)?;
        let batch_record = batch
            .records
            .iter()
            .find(|record| record.handle == handle)
            .expect("ready batch was selected by this exact handle");
        let record = self.records.get(handle).ok_or_else(|| {
            AppError::new(
                "attachment_selection_corrupt",
                "Ready attachment is missing from the central sealed record index",
            )
            .outcome_unknown(true)
        })?;
        if record.cleanup_pending
            || record.selection_id.as_deref() != Some(batch.selection_id.as_str())
            || record.dispatch_owner_message_id.is_some()
            || record.content_sha256 != batch_record.content_sha256
        {
            return Err(AppError::new(
                "attachment_selection_corrupt",
                "Ready attachment ownership is inconsistent",
            )
            .outcome_unknown(true));
        }
        Ok(record)
    }

    pub fn begin_import_selection(
        &mut self,
        selection_id: &str,
        session_id: &str,
        generation: u64,
        window_label: &str,
        files: &[AttachmentImportFile],
    ) -> AppResult<AttachmentImportStatus> {
        self.resume_cleanup_pending()?;
        canonical_uuid(selection_id, "selectionId")?;
        canonical_uuid(session_id, "rendererSessionId")?;
        validate_import_files(files)?;
        if generation == 0 || window_label.is_empty() {
            return Err(AppError::new(
                "attachment_selection_owner_invalid",
                "Attachment import owner is invalid",
            ));
        }
        if self
            .selections
            .retired_selection_ids
            .iter()
            .any(|id| id == selection_id)
        {
            return Err(AppError::new(
                "attachment_selection_cancelled",
                "Attachment selection was already cancelled",
            ));
        }
        if let Some(batch) = self
            .selections
            .batches
            .iter()
            .find(|batch| batch.selection_id == selection_id)
        {
            ensure_batch_owner(batch, session_id, generation, window_label)?;
            if !same_import_manifest(batch, files) {
                return Err(AppError::new(
                    "attachment_import_manifest_conflict",
                    "Attachment selection was already opened with a different file manifest",
                ));
            }
            return import_status(batch);
        }
        let reserved = self
            .selections
            .batches
            .iter()
            .filter(|batch| batch.phase != SelectionPhase::CleanupPending)
            .map(|batch| {
                if batch.upload_slots.is_empty() {
                    batch.records.len()
                } else {
                    batch.upload_slots.len()
                }
            })
            .sum::<usize>();
        if reserved + files.len() > MAX_DRAFT_ATTACHMENTS {
            return Err(AppError::new(
                "attachment_draft_quota",
                "At most four unsent image drafts are allowed",
            ));
        }
        let batch = SelectionBatch {
            selection_id: selection_id.into(),
            owner_session_id: session_id.into(),
            owner_generation: generation,
            owner_window_label: window_label.into(),
            phase: SelectionPhase::Opening,
            records: Vec::new(),
            upload_slots: files
                .iter()
                .map(|file| AttachmentUploadSlot {
                    slot_id: file.slot_id.clone(),
                    display_name: file.display_name.clone(),
                    declared_size_bytes: file.size_bytes,
                    record_handle: None,
                })
                .collect(),
            updated_at_ms: now_ms(),
        };
        self.selections.batches.push(batch);
        self.persist_selections()?;
        let batch = self
            .selections
            .batches
            .iter()
            .find(|batch| batch.selection_id == selection_id)
            .expect("attachment import batch was inserted before persistence");
        import_status(batch)
    }

    pub fn stage_import_slot(
        &mut self,
        selection_id: &str,
        slot_id: &str,
        session_id: &str,
        generation: u64,
        window_label: &str,
        bytes: &[u8],
    ) -> AppResult<()> {
        self.resume_cleanup_pending()?;
        canonical_uuid(selection_id, "selectionId")?;
        canonical_uuid(slot_id, "attachmentSlotId")?;
        canonical_uuid(session_id, "rendererSessionId")?;
        let batch_position = self
            .selections
            .batches
            .iter()
            .position(|batch| batch.selection_id == selection_id)
            .ok_or_else(|| {
                AppError::new(
                    "attachment_selection_not_found",
                    "Attachment selection is not open",
                )
            })?;
        let batch = &self.selections.batches[batch_position];
        ensure_batch_owner(batch, session_id, generation, window_label)?;
        if batch.phase != SelectionPhase::Opening || batch.upload_slots.is_empty() {
            return Err(AppError::new(
                "attachment_import_state_invalid",
                "Attachment bytes cannot be staged from the current selection state",
            ));
        }
        let slot_position = batch
            .upload_slots
            .iter()
            .position(|slot| slot.slot_id == slot_id)
            .ok_or_else(|| {
                AppError::new(
                    "attachment_import_slot_unknown",
                    "Attachment slot does not belong to this selection",
                )
            })?;
        let slot = batch.upload_slots[slot_position].clone();
        if bytes.is_empty()
            || bytes.len() as u64 > MAX_ATTACHMENT_BYTES
            || bytes.len() as u64 != slot.declared_size_bytes
        {
            return Err(AppError::new(
                "attachment_import_size_mismatch",
                "Attachment bytes do not match the exact declared non-empty size",
            ));
        }
        if let Some(handle) = slot.record_handle.as_deref() {
            let record = self.records.get(handle).ok_or_else(|| {
                AppError::new(
                    "attachment_import_state_corrupt",
                    "Staged attachment slot lost its durable record",
                )
                .outcome_unknown(true)
            })?;
            let digest = hash_bytes(bytes);
            if record.size_bytes != bytes.len() as u64 || record.content_sha256 != digest {
                return Err(AppError::new(
                    "attachment_import_replay_mismatch",
                    "Attachment slot replay does not match the bytes already staged",
                ));
            }
            return Ok(());
        }
        let record = self.stage_bytes_one(selection_id, &slot.display_name, bytes)?;
        if let Err(error) = ensure_public_identity_unique(&self.records, &record) {
            self.remove_file_idempotent(&record)?;
            return Err(error);
        }
        if record.kind == AttachmentKind::Text {
            let existing_text_bytes = self
                .selections
                .batches
                .iter()
                .flat_map(|batch| batch.records.iter())
                .filter(|candidate| {
                    !candidate.cleanup_pending && candidate.kind == AttachmentKind::Text
                })
                .map(|candidate| candidate.size_bytes)
                .sum::<u64>();
            if existing_text_bytes.saturating_add(record.size_bytes) > MAX_TEXT_BYTES_PER_DISPATCH {
                self.remove_file_idempotent(&record)?;
                return Err(AppError::new(
                    "attachment_text_aggregate_limit",
                    "Text attachments may total at most 512 KiB",
                ));
            }
        }
        let mut next = self.selections.clone();
        let next_batch = &mut next.batches[batch_position];
        next_batch.records.push(record.clone());
        next_batch.upload_slots[slot_position].record_handle = Some(record.handle.clone());
        next_batch.updated_at_ms = now_ms();
        if let Err(original) = atomic_write_json(&self.selection_path, &next) {
            self.selections = next;
            self.records.insert(record.handle.clone(), record.clone());
            return match self.cancel_selection(selection_id) {
                Ok(()) => Err(original),
                Err(cleanup_error) => Err(AppError::new(
                    "attachment_selection_cleanup_pending",
                    format!(
                        "{}; cleanup failed: {}",
                        original.message, cleanup_error.message
                    ),
                )
                .outcome_unknown(true)),
            };
        }
        self.selections = next;
        self.records.insert(record.handle.clone(), record.clone());
        Ok(())
    }

    pub fn finish_import_selection(
        &mut self,
        selection_id: &str,
        session_id: &str,
        generation: u64,
        window_label: &str,
    ) -> AppResult<AttachmentImportStatus> {
        self.resume_cleanup_pending()?;
        canonical_uuid(selection_id, "selectionId")?;
        let batch_position = self
            .selections
            .batches
            .iter()
            .position(|batch| batch.selection_id == selection_id)
            .ok_or_else(|| {
                AppError::new(
                    "attachment_selection_not_found",
                    "Attachment selection is not open",
                )
            })?;
        let batch = &self.selections.batches[batch_position];
        ensure_batch_owner(batch, session_id, generation, window_label)?;
        if batch.upload_slots.is_empty() {
            return Err(AppError::new(
                "attachment_import_state_invalid",
                "Selection was not opened by the binary attachment import",
            ));
        }
        if batch.phase == SelectionPhase::Ready {
            return import_status(batch);
        }
        if batch.phase != SelectionPhase::Opening
            || batch
                .upload_slots
                .iter()
                .any(|slot| slot.record_handle.is_none())
        {
            return Err(AppError::new(
                "attachment_import_incomplete",
                "Every declared attachment file must be staged before finishing",
            )
            .retryable(true));
        }
        let mut next = self.selections.clone();
        next.batches[batch_position].phase = SelectionPhase::Ready;
        next.batches[batch_position].updated_at_ms = now_ms();
        if let Err(original) = atomic_write_json(&self.selection_path, &next) {
            self.selections = next;
            return match self.cancel_selection(selection_id) {
                Ok(()) => Err(original),
                Err(cleanup_error) => Err(AppError::new(
                    "attachment_selection_cleanup_pending",
                    format!(
                        "{}; cleanup failed: {}",
                        original.message, cleanup_error.message
                    ),
                )
                .outcome_unknown(true)),
            };
        }
        self.selections = next;
        import_status(&self.selections.batches[batch_position])
    }

    pub fn read_preview(
        &self,
        selection_id: &str,
        public_id: &str,
        session_id: &str,
        generation: u64,
        window_label: &str,
    ) -> AppResult<Vec<u8>> {
        canonical_uuid(selection_id, "selectionId")?;
        canonical_uuid(public_id, "attachmentPublicId")?;
        canonical_uuid(session_id, "rendererSessionId")?;
        let batch = self
            .selections
            .batches
            .iter()
            .find(|batch| batch.selection_id == selection_id)
            .ok_or_else(|| {
                AppError::new(
                    "attachment_preview_not_found",
                    "Attachment preview is not available",
                )
            })?;
        ensure_batch_owner(batch, session_id, generation, window_label)?;
        if batch.phase != SelectionPhase::Ready {
            return Err(AppError::new(
                "attachment_preview_not_ready",
                "Attachment preview is available only for a ready draft",
            ));
        }
        let record = batch
            .records
            .iter()
            .find(|record| {
                record.public_id == public_id && record.public_selection_id == selection_id
            })
            .filter(|record| {
                !record.cleanup_pending
                    && record.selection_id.as_deref() == Some(selection_id)
                    && record.dispatch_owner_message_id.is_none()
            })
            .ok_or_else(|| {
                AppError::new(
                    "attachment_preview_not_found",
                    "Attachment preview is not available",
                )
            })?;
        if record.kind != AttachmentKind::Image {
            return Err(AppError::new(
                "attachment_preview_unsupported",
                "Text attachments do not expose their contents to the Renderer preview",
            ));
        }
        if record.size_bytes > MAX_ATTACHMENT_PREVIEW_BYTES {
            return Err(AppError::new(
                "attachment_preview_too_large",
                "Images larger than 5 MiB use the generic attachment chip",
            ));
        }
        let path = self.root.join(&record.staged_name);
        let (bytes, media_type, digest) = read_sealed_image(&path)?;
        if bytes.len() as u64 != record.size_bytes
            || media_type != record.media_type
            || digest != record.content_sha256
        {
            return Err(AppError::new(
                "attachment_preview_integrity_mismatch",
                "Sealed attachment bytes do not match their durable preview identity",
            )
            .outcome_unknown(true));
        }
        Ok(bytes)
    }

    pub fn cancel_selection(&mut self, selection_id: &str) -> AppResult<()> {
        canonical_uuid(selection_id, "selectionId")?;
        if self
            .selections
            .retired_selection_ids
            .iter()
            .any(|id| id == selection_id)
        {
            return Ok(());
        }
        if let Some(position) = self
            .selections
            .batches
            .iter()
            .position(|batch| batch.selection_id == selection_id)
        {
            let mut next = self.selections.clone();
            next.batches[position].phase = SelectionPhase::CleanupPending;
            next.batches[position].updated_at_ms = now_ms();
            atomic_write_json(&self.selection_path, &next)?;
            self.selections = next;
        } else {
            let mut next = self.selections.clone();
            push_bounded(
                &mut next.retired_selection_ids,
                selection_id.to_owned(),
                128,
            );
            atomic_write_json(&self.selection_path, &next)?;
            self.selections = next;
            return Ok(());
        }
        self.resume_cleanup_pending()
    }

    pub fn retire_renderer_session(
        &mut self,
        session_id: &str,
        generation: u64,
        window_label: &str,
    ) -> AppResult<()> {
        canonical_uuid(session_id, "rendererSessionId")?;
        let mut next = self.selections.clone();
        let mut changed = false;
        for batch in &mut next.batches {
            if batch.owner_session_id == session_id
                && batch.owner_generation == generation
                && batch.owner_window_label == window_label
            {
                batch.phase = SelectionPhase::CleanupPending;
                batch.updated_at_ms = now_ms();
                changed = true;
            }
        }
        if changed {
            atomic_write_json(&self.selection_path, &next)?;
            self.selections = next;
        }
        self.resume_cleanup_pending()
    }

    pub fn forget_draft(
        &mut self,
        public_id: &str,
        selection_id: &str,
        session_id: &str,
        generation: u64,
        window_label: &str,
    ) -> AppResult<()> {
        canonical_uuid(public_id, "attachmentPublicId")?;
        canonical_uuid(selection_id, "selectionId")?;
        if let Some(retired) = self
            .selections
            .retired_draft_handles
            .iter()
            .find(|candidate| candidate.public_id == public_id)
        {
            if retired.selection_id == selection_id
                && retired.owner_session_id == session_id
                && retired.owner_generation == generation
                && retired.owner_window_label == window_label
            {
                return Ok(());
            }
            return Err(AppError::new(
                "attachment_selection_owner_mismatch",
                "Retired attachment belongs to another selection owner",
            ));
        }
        if self
            .selections
            .retired_selection_ids
            .iter()
            .any(|candidate| candidate == selection_id)
        {
            return Ok(());
        }
        let batch_position = self
            .selections
            .batches
            .iter()
            .position(|batch| batch.selection_id == selection_id)
            .ok_or_else(|| {
                AppError::new(
                    "attachment_selection_not_found",
                    "Attachment selection is missing",
                )
            })?;
        let batch = &self.selections.batches[batch_position];
        if batch.owner_session_id != session_id
            || batch.owner_generation != generation
            || batch.owner_window_label != window_label
        {
            return Err(AppError::new(
                "attachment_selection_owner_mismatch",
                "Attachment belongs to another renderer session",
            ));
        }
        if batch.phase != SelectionPhase::Ready {
            return Err(AppError::new(
                "attachment_selection_state_invalid",
                "Attachment selection is not ready for draft changes",
            ));
        }
        let Some(record) = batch
            .records
            .iter()
            .find(|record| {
                record.public_id == public_id && record.public_selection_id == selection_id
            })
            .cloned()
        else {
            if self
                .records
                .values()
                .any(|record| record.public_id == public_id)
            {
                return Err(AppError::new(
                    "attachment_selection_mismatch",
                    "Attachment belongs to another selection",
                ));
            }
            // The exact command may be replayed after its response was lost.
            return Ok(());
        };
        let handle = record.handle.clone();
        if record.dispatch_owner_message_id.is_some() {
            return Err(AppError::new(
                "attachment_in_use",
                "Attachment is sealed for a runtime action",
            ));
        }
        let mut next = self.selections.clone();
        if let Some(record) = next.batches[batch_position]
            .records
            .iter_mut()
            .find(|record| record.handle == handle)
        {
            record.cleanup_pending = true;
        }
        atomic_write_json(&self.selection_path, &next)?;
        self.selections = next;
        if let Some(record) = self.records.get_mut(&handle) {
            record.cleanup_pending = true;
        }
        self.resume_draft_forget(&handle)
    }

    fn resume_draft_forgets(&mut self) -> AppResult<()> {
        let handles = self
            .records
            .values()
            .filter(|record| record.cleanup_pending)
            .map(|record| record.handle.clone())
            .collect::<Vec<_>>();
        for handle in handles {
            self.resume_draft_forget(&handle)?;
        }
        Ok(())
    }

    fn resume_draft_forget(&mut self, handle: &str) -> AppResult<()> {
        let record = self.records.get(handle).cloned().ok_or_else(|| {
            AppError::new(
                "attachment_not_found",
                "Attachment cleanup record is missing",
            )
            .outcome_unknown(true)
        })?;
        if !record.cleanup_pending || record.dispatch_owner_message_id.is_some() {
            return Err(AppError::new(
                "attachment_cleanup_ownership_uncertain",
                "Attachment is not an exact pending draft cleanup",
            )
            .outcome_unknown(true));
        }
        let selection_id = record.selection_id.clone().ok_or_else(|| {
            AppError::new(
                "attachment_cleanup_ownership_uncertain",
                "Pending draft cleanup lost its selection owner",
            )
            .outcome_unknown(true)
        })?;
        let batch_position = self
            .selections
            .batches
            .iter()
            .position(|batch| batch.selection_id == selection_id)
            .ok_or_else(|| {
                AppError::new(
                    "attachment_cleanup_ownership_uncertain",
                    "Pending draft cleanup lost its selection batch",
                )
                .outcome_unknown(true)
            })?;
        let owner = self.selections.batches[batch_position].clone();
        self.remove_file_idempotent(&record)?;
        let mut next = self.selections.clone();
        remove_batch_handles(
            &mut next.batches[batch_position],
            &HashSet::from([handle.to_owned()]),
        );
        if next.batches[batch_position].records.is_empty() {
            next.batches.remove(batch_position);
            push_bounded(&mut next.retired_selection_ids, selection_id.clone(), 128);
        }
        next.retired_draft_handles
            .retain(|candidate| candidate.handle != handle);
        next.retired_draft_handles.push(RetiredDraftHandle {
            selection_id,
            handle: handle.to_owned(),
            public_id: record.public_id.clone(),
            owner_session_id: owner.owner_session_id,
            owner_generation: owner.owner_generation,
            owner_window_label: owner.owner_window_label,
        });
        if next.retired_draft_handles.len() > 128 {
            next.retired_draft_handles
                .drain(0..next.retired_draft_handles.len() - 128);
        }
        atomic_write_json(&self.selection_path, &next)?;
        self.selections = next;
        self.records.remove(handle);
        Ok(())
    }

    pub fn resolve_for_dispatch(
        &mut self,
        message_id: &str,
        requested_handles: &[String],
        recovery: Option<&DispatchRecoveryRecord>,
        containment: &ContainmentEvidence,
    ) -> AppResult<AttachmentLease> {
        let handles = if let Some(recovery) = recovery {
            recovery.attachment_handles.clone()
        } else {
            requested_handles.to_vec()
        };
        validate_ordered_attachment_handles(&handles, recovery.is_some())?;
        if handles.is_empty() {
            return Ok(AttachmentLease {
                attachments: Vec::new(),
            });
        }
        if handles.len() > MAX_DRAFT_ATTACHMENTS {
            return Err(AppError::new(
                "attachment_send_limit",
                "At most four attachments may be sent in one action",
            ));
        }
        if let Some(recovery) = recovery {
            if !requested_handles.is_empty() && requested_handles != recovery.attachment_handles {
                return Err(AppError::new(
                    "dispatch_recovery_attachment_mismatch",
                    "Exact retry cannot replace sealed attachment handles",
                )
                .outcome_unknown(true));
            }
        }
        let mut records = Vec::new();
        for handle in &handles {
            let indexed = self.records.get(handle).cloned().ok_or_else(|| {
                AppError::new("attachment_not_found", "A sealed attachment is unavailable")
            })?;
            let record = if indexed.dispatch_owner_message_id.is_none() {
                self.ready_draft_record(handle)?.clone()
            } else {
                indexed
            };
            if record.cleanup_pending {
                return Err(AppError::new(
                    "attachment_cleanup_pending",
                    "Attachment draft removal is still pending",
                )
                .retryable(true));
            }
            let actual = hash_file(&self.root.join(&record.staged_name))?;
            if actual != record.content_sha256 {
                return Err(AppError::new(
                    "attachment_content_changed",
                    "Sealed attachment content changed",
                )
                .outcome_unknown(true));
            }
            if let Some(owner) = &record.dispatch_owner_message_id {
                if owner != message_id {
                    return Err(AppError::new(
                        "attachment_in_use",
                        "Attachment belongs to another dispatch",
                    ));
                }
            }
            records.push(record);
        }
        let text_bytes = records
            .iter()
            .filter(|record| record.kind == AttachmentKind::Text)
            .map(|record| record.size_bytes)
            .sum::<u64>();
        if text_bytes > MAX_TEXT_BYTES_PER_DISPATCH {
            return Err(AppError::new(
                "attachment_text_aggregate_limit",
                "Text attachments may total at most 512 KiB",
            ));
        }
        let already = records
            .iter()
            .all(|record| record.dispatch_owner_message_id.as_deref() == Some(message_id));
        if !already {
            let new_count = self.quarantine.records.len()
                + records
                    .iter()
                    .filter(|record| record.dispatch_owner_message_id.is_none())
                    .count();
            let new_bytes = self
                .quarantine
                .records
                .iter()
                .map(|item| item.attachment.size_bytes)
                .sum::<u64>()
                + records
                    .iter()
                    .filter(|record| record.dispatch_owner_message_id.is_none())
                    .map(|record| record.size_bytes)
                    .sum::<u64>();
            if new_count > MAX_QUARANTINE_ATTACHMENTS || new_bytes > MAX_QUARANTINE_BYTES {
                return Err(AppError::new("attachment_quarantine_quota", "Sealed attachment recovery storage is full; stop the runtime or resolve pending actions"));
            }
            for mut record in records.clone() {
                record.dispatch_owner_message_id = Some(message_id.into());
                record.selection_id = None;
                self.records.insert(record.handle.clone(), record.clone());
                if !self
                    .quarantine
                    .records
                    .iter()
                    .any(|item| item.attachment.handle == record.handle)
                {
                    self.quarantine.records.push(QuarantineRecord {
                        attachment: record,
                        runtime_generation: Some(containment.runtime_generation.clone()),
                        containment_kind: Some(containment.kind.clone()),
                    });
                }
            }
            let promoted_handles = handles.iter().cloned().collect::<HashSet<_>>();
            for batch in &mut self.selections.batches {
                remove_batch_handles(batch, &promoted_handles);
            }
            self.selections.batches.retain(|batch| {
                !(batch.phase == SelectionPhase::Ready && batch.records.is_empty())
            });
            self.persist_quarantine()?;
            self.persist_selections()?;
        }
        let final_records = handles
            .iter()
            .map(|handle| self.records.get(handle).expect("validated handle").clone())
            .collect::<Vec<_>>();
        let mut guards = Vec::with_capacity(final_records.len());
        let mut sealed = Vec::with_capacity(final_records.len());
        for record in &final_records {
            let (guard, classification) = open_sealed_attachment_guard(
                &self.root,
                &record.staged_name,
                &record.display_name,
                record.size_bytes,
                &record.content_sha256,
            )?;
            if classification.kind != record.kind
                || classification.media_type != record.media_type
                || classification.encoding != record.encoding
            {
                return Err(AppError::new(
                    "attachment_guard_classification_mismatch",
                    "Sealed attachment classification no longer matches its durable identity",
                )
                .outcome_unknown(true));
            }
            sealed.push(SealedDispatchAttachment {
                attachment_store_handle: record.handle.clone(),
                kind: record.kind,
                display_name: record.display_name.clone(),
                media_type: record.media_type.clone(),
                size_bytes: record.size_bytes,
                sha256: record.content_sha256.clone(),
                sealed_absolute_path: guard.absolute_path().to_string_lossy().into_owned(),
                encoding: record.encoding,
            });
            guards.push(guard);
        }
        self.dispatch_guards.insert(message_id.into(), guards);
        Ok(AttachmentLease {
            attachments: sealed,
        })
    }

    pub fn cleanup_dispatch_authoritative_failure(
        &mut self,
        message_id: &str,
        expected_handles: &[String],
    ) -> AppResult<()> {
        let expected_handles = expected_handles
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>();
        let expected_owned = expected_handles
            .iter()
            .map(|handle| (*handle).to_owned())
            .collect::<HashSet<_>>();
        let unexpected_dispatch_handle = self.records.values().any(|record| {
            record.dispatch_owner_message_id.as_deref() == Some(message_id)
                && !expected_handles.contains(record.handle.as_str())
        });
        if unexpected_dispatch_handle {
            return Err(AppError::new(
                "attachment_recovery_record_missing",
                "Exact sealed attachment cleanup records do not match durable recovery ownership",
            )
            .outcome_unknown(true));
        }
        let mut records = Vec::new();
        for handle in expected_handles.iter().copied() {
            let Some(record) = self.records.get(handle).cloned() else {
                match fs::symlink_metadata(self.root.join(handle)) {
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                    Ok(_) => {
                        return Err(AppError::new(
                            "attachment_recovery_record_missing",
                            "A cleanup attachment exists without durable store metadata",
                        )
                        .outcome_unknown(true));
                    }
                    Err(error) => return Err(AppError::io("inspect cleanup attachment", error)),
                }
            };
            let exact_draft_owner = record.dispatch_owner_message_id.is_none()
                && record.selection_id.as_ref().is_some_and(|selection_id| {
                    self.selections.batches.iter().any(|batch| {
                        batch.selection_id == *selection_id
                            && batch.records.iter().any(|item| item.handle == handle)
                    })
                });
            if record.dispatch_owner_message_id.as_deref() != Some(message_id) && !exact_draft_owner
            {
                return Err(AppError::new(
                    "attachment_recovery_record_missing",
                    "Exact sealed attachment cleanup records do not match durable recovery ownership",
                )
                .outcome_unknown(true));
            }
            records.push(record);
        }
        self.dispatch_guards.remove(message_id);
        for record in &records {
            self.remove_file_idempotent(record)?;
            self.records.remove(&record.handle);
        }
        self.quarantine
            .records
            .retain(|item| !expected_handles.contains(item.attachment.handle.as_str()));
        for batch in &mut self.selections.batches {
            remove_batch_handles(batch, &expected_owned);
        }
        self.selections
            .batches
            .retain(|batch| !(batch.phase == SelectionPhase::Ready && batch.records.is_empty()));
        self.persist_quarantine()?;
        self.persist_selections()
    }

    pub fn dispatch_owns_exact_handles(
        &self,
        message_id: &str,
        expected_handles: &[String],
    ) -> AppResult<bool> {
        let expected = expected_handles
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>();
        let owned = self
            .records
            .values()
            .filter(|record| record.dispatch_owner_message_id.as_deref() == Some(message_id))
            .map(|record| record.handle.as_str())
            .collect::<HashSet<_>>();
        if owned == expected {
            return Ok(true);
        }
        if !owned.is_empty() {
            return Err(AppError::new(
                "attachment_recovery_ownership_uncertain",
                "Dispatch attachment ownership only partially matches durable recovery",
            )
            .outcome_unknown(true));
        }
        let all_draft_owned = expected_handles.iter().all(|handle| {
            self.records.get(handle).is_some_and(|record| {
                record.dispatch_owner_message_id.is_none()
                    && record.selection_id.as_ref().is_some_and(|selection_id| {
                        self.selections.batches.iter().any(|batch| {
                            batch.selection_id == *selection_id
                                && batch.records.iter().any(|item| item.handle == *handle)
                        })
                    })
            })
        });
        if all_draft_owned {
            return Ok(false);
        }
        Err(AppError::new(
            "attachment_recovery_ownership_uncertain",
            "Attachment ownership does not match its durable recovery record",
        )
        .outcome_unknown(true))
    }

    pub fn release_after_confirmed_stop_with_recoveries(
        &mut self,
        recoveries: &[DispatchRecoveryRecord],
    ) -> AppResult<()> {
        self.dispatch_guards.clear();
        let preserve = recoveries
            .iter()
            .flat_map(|record| record.attachment_handles.iter().cloned())
            .collect::<HashSet<_>>();
        let candidates = self
            .records
            .values()
            .filter(|record| {
                record.dispatch_owner_message_id.is_some() && !preserve.contains(&record.handle)
            })
            .cloned()
            .collect::<Vec<_>>();
        for record in &candidates {
            self.remove_file_idempotent(record)?;
            self.records.remove(&record.handle);
        }
        self.quarantine
            .records
            .retain(|item| preserve.contains(&item.attachment.handle));
        for item in &mut self.quarantine.records {
            item.runtime_generation = None;
            item.containment_kind = None;
        }
        self.persist_quarantine()
    }

    fn mark_all_renderer_sessions_cleanup_pending(&mut self) -> AppResult<()> {
        if !self.selections.batches.is_empty() {
            let mut next = self.selections.clone();
            for batch in &mut next.batches {
                batch.phase = SelectionPhase::CleanupPending;
                batch.updated_at_ms = now_ms();
            }
            atomic_write_json(&self.selection_path, &next)?;
            self.selections = next;
        }
        Ok(())
    }

    fn cleanup_pending_contains(&self, handle: &str) -> bool {
        self.selections.batches.iter().any(|batch| {
            batch.phase == SelectionPhase::CleanupPending
                && batch.records.iter().any(|record| record.handle == handle)
        })
    }

    fn resume_cleanup_pending(&mut self) -> AppResult<()> {
        while let Some(position) = self
            .selections
            .batches
            .iter()
            .position(|batch| batch.phase == SelectionPhase::CleanupPending)
        {
            let batch = self.selections.batches[position].clone();
            for record in &batch.records {
                if record.dispatch_owner_message_id.is_some()
                    || self
                        .quarantine
                        .records
                        .iter()
                        .any(|item| item.attachment.handle == record.handle)
                {
                    return Err(AppError::new(
                        "attachment_cleanup_ownership_uncertain",
                        "Cleanup-pending draft was already promoted to dispatch quarantine",
                    )
                    .outcome_unknown(true));
                }
                self.remove_file_idempotent(record)?;
            }
            let mut next = self.selections.clone();
            next.batches.remove(position);
            push_bounded(
                &mut next.retired_selection_ids,
                batch.selection_id.clone(),
                128,
            );
            atomic_write_json(&self.selection_path, &next)?;
            self.selections = next;
            for record in &batch.records {
                self.records.remove(&record.handle);
            }
        }
        Ok(())
    }

    fn remove_orphaned_staged_files(&self) -> AppResult<()> {
        let referenced = self
            .records
            .values()
            .map(|record| record.staged_name.clone())
            .collect::<HashSet<_>>();
        let mut removed = false;
        for entry in fs::read_dir(&self.root)
            .map_err(|error| AppError::io("list attachment staging", error))?
        {
            let entry =
                entry.map_err(|error| AppError::io("read attachment staging entry", error))?;
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if referenced.contains(&name) || canonical_uuid(&name, "attachmentHandle").is_err() {
                continue;
            }
            let file_type = entry
                .file_type()
                .map_err(|error| AppError::io("inspect attachment staging entry", error))?;
            if file_type.is_file() || file_type.is_symlink() {
                remove_path_idempotent(&entry.path(), "remove orphaned staged attachment")?;
                removed = true;
            }
        }
        if removed {
            sync_directory(&self.root)?;
        }
        Ok(())
    }

    fn stage_bytes_one(
        &self,
        selection_id: &str,
        display_name: &str,
        bytes: &[u8],
    ) -> AppResult<AttachmentRecord> {
        if bytes.is_empty() || bytes.len() as u64 > MAX_ATTACHMENT_BYTES {
            return Err(AppError::new(
                "attachment_size_invalid",
                "Attachment must be a non-empty image no larger than 20 MiB",
            ));
        }
        let handle = uuid::Uuid::new_v4().hyphenated().to_string();
        let destination = self.root.join(&handle);
        let mut options = OpenOptions::new();
        options.create_new(true).read(true).write(true);
        #[cfg(unix)]
        options.mode(0o400);
        let mut output = options
            .open(&destination)
            .map_err(|error| AppError::io("create sealed attachment", error))?;
        let staged = (|| -> AppResult<(AttachmentClassification, String)> {
            output
                .write_all(bytes)
                .map_err(|error| AppError::io("stage attachment bytes", error))?;
            output
                .flush()
                .map_err(|error| AppError::io("flush attachment", error))?;
            output
                .sync_all()
                .map_err(|error| AppError::io("sync attachment", error))?;
            let metadata = output
                .metadata()
                .map_err(|error| AppError::io("inspect staged attachment", error))?;
            if !metadata.is_file() || metadata.len() != bytes.len() as u64 {
                return Err(AppError::new(
                    "attachment_stage_identity_invalid",
                    "Staged attachment is not the exact uploaded regular file",
                )
                .outcome_unknown(true));
            }
            output
                .seek(SeekFrom::Start(0))
                .map_err(|error| AppError::io("rewind staged attachment", error))?;
            output.seek(SeekFrom::Start(0)).map_err(|error| {
                AppError::io("rewind staged attachment for classification", error)
            })?;
            let classification = classify_reader(display_name, bytes.len() as u64, &mut output)?;
            output
                .seek(SeekFrom::Start(0))
                .map_err(|error| AppError::io("rewind staged attachment for digest", error))?;
            let content_sha256 = hash_reader(&mut output, "hash staged attachment")?;
            #[cfg(unix)]
            output
                .set_permissions(fs::Permissions::from_mode(0o400))
                .map_err(|error| AppError::io("seal attachment permissions", error))?;
            #[cfg(windows)]
            {
                let mut permissions = output
                    .metadata()
                    .map_err(|error| AppError::io("read attachment permissions", error))?
                    .permissions();
                permissions.set_readonly(true);
                output
                    .set_permissions(permissions)
                    .map_err(|error| AppError::io("seal attachment permissions", error))?;
                output
                    .sync_all()
                    .map_err(|error| AppError::io("sync sealed attachment", error))?;
            }
            sync_directory(&self.root)?;
            Ok((classification, content_sha256))
        })();
        let (classification, content_sha256) = match staged {
            Ok(value) => value,
            Err(original) => {
                drop(output);
                let cleanup =
                    remove_path_idempotent(&destination, "remove failed staged attachment")
                        .and_then(|_| sync_directory(&self.root));
                return match cleanup {
                    Ok(()) => Err(original),
                    Err(cleanup_error) => Err(AppError::new(
                        "attachment_selection_cleanup_pending",
                        format!(
                            "{}; failed staged-file cleanup: {}",
                            original.message, cleanup_error.message
                        ),
                    )
                    .outcome_unknown(true)),
                };
            }
        };
        Ok(AttachmentRecord {
            handle: handle.clone(),
            public_id: fresh_public_id(&handle),
            public_selection_id: selection_id.to_owned(),
            display_name: display_name.to_owned(),
            kind: classification.kind,
            media_type: classification.media_type,
            encoding: classification.encoding,
            size_bytes: bytes.len() as u64,
            content_sha256,
            staged_name: handle,
            selection_id: Some(selection_id.into()),
            dispatch_owner_message_id: None,
            created_at_ms: now_ms(),
            cleanup_pending: false,
        })
    }

    fn remove_file_idempotent(&self, record: &AttachmentRecord) -> AppResult<()> {
        validate_attachment_record(record)?;
        let path = self.root.join(&record.staged_name);
        remove_path_idempotent(&path, "remove sealed attachment")?;
        sync_directory(&self.root)
    }

    fn persist_selections(&self) -> AppResult<()> {
        atomic_write_json(&self.selection_path, &self.selections)
    }
    fn persist_quarantine(&self) -> AppResult<()> {
        atomic_write_json(&self.quarantine_path, &self.quarantine)
    }
    fn validate_budgets(&self) -> AppResult<()> {
        if self.quarantine.records.len() > MAX_QUARANTINE_ATTACHMENTS
            || self
                .quarantine
                .records
                .iter()
                .map(|item| item.attachment.size_bytes)
                .sum::<u64>()
                > MAX_QUARANTINE_BYTES
        {
            return Err(AppError::new(
                "attachment_quarantine_corrupt",
                "Attachment quarantine exceeds its hard safety budget",
            )
            .outcome_unknown(true));
        }
        let draft_text_bytes = self
            .selections
            .batches
            .iter()
            .filter(|batch| batch.phase != SelectionPhase::CleanupPending)
            .flat_map(|batch| batch.records.iter())
            .filter(|record| record.kind == AttachmentKind::Text && !record.cleanup_pending)
            .map(|record| record.size_bytes)
            .sum::<u64>();
        if draft_text_bytes > MAX_TEXT_BYTES_PER_DISPATCH {
            return Err(AppError::new(
                "attachment_selection_corrupt",
                "Draft text attachments exceed the 512 KiB aggregate limit",
            )
            .outcome_unknown(true));
        }
        let mut quarantine_text_bytes = HashMap::<&str, u64>::new();
        for item in &self.quarantine.records {
            if item.attachment.kind != AttachmentKind::Text {
                continue;
            }
            let owner = item
                .attachment
                .dispatch_owner_message_id
                .as_deref()
                .ok_or_else(|| {
                    AppError::new(
                        "attachment_quarantine_corrupt",
                        "Quarantined text attachment has no dispatch owner",
                    )
                    .outcome_unknown(true)
                })?;
            let total = quarantine_text_bytes.entry(owner).or_default();
            *total = total.saturating_add(item.attachment.size_bytes);
            if *total > MAX_TEXT_BYTES_PER_DISPATCH {
                return Err(AppError::new(
                    "attachment_quarantine_corrupt",
                    "One quarantined dispatch exceeds the text attachment budget",
                )
                .outcome_unknown(true));
            }
        }
        Ok(())
    }
}

fn remove_batch_handles(batch: &mut SelectionBatch, removed: &HashSet<String>) {
    batch
        .records
        .retain(|record| !removed.contains(&record.handle));
    batch.upload_slots.retain(|slot| {
        slot.record_handle
            .as_ref()
            .is_none_or(|handle| !removed.contains(handle))
    });
}

fn insert_unique(
    records: &mut HashMap<String, AttachmentRecord>,
    record: AttachmentRecord,
) -> AppResult<()> {
    ensure_public_identity_unique(records, &record)?;
    if let Some(existing) = records.get(&record.handle) {
        if existing.content_sha256 != record.content_sha256
            || existing.public_id != record.public_id
            || existing.public_selection_id != record.public_selection_id
        {
            return Err(AppError::new(
                "attachment_identity_conflict",
                "Attachment handle has conflicting content",
            )
            .outcome_unknown(true));
        }
    } else {
        records.insert(record.handle.clone(), record);
    }
    Ok(())
}

fn ensure_public_identity_unique(
    records: &HashMap<String, AttachmentRecord>,
    record: &AttachmentRecord,
) -> AppResult<()> {
    if records.values().any(|existing| {
        existing.handle != record.handle
            && existing.public_id == record.public_id
            && existing.public_selection_id == record.public_selection_id
    }) {
        return Err(AppError::new(
            "attachment_public_identity_corrupt",
            "Attachment public identity resolves to more than one store record",
        )
        .outcome_unknown(true));
    }
    Ok(())
}

fn validate_display_name(value: &str) -> AppResult<()> {
    if value.trim().is_empty() || value.chars().count() > 255 || value.chars().any(char::is_control)
    {
        return Err(AppError::new(
            "attachment_display_name_invalid",
            "Attachment display name must be non-empty printable text up to 255 characters",
        ));
    }
    Ok(())
}

fn validate_import_files(files: &[AttachmentImportFile]) -> AppResult<()> {
    if files.is_empty() || files.len() > MAX_DRAFT_ATTACHMENTS {
        return Err(AppError::new(
            "attachment_selection_limit",
            "Select between one and four supported files",
        ));
    }
    let mut slots = HashSet::with_capacity(files.len());
    let mut text_bytes = 0_u64;
    for file in files {
        canonical_uuid(&file.slot_id, "attachmentSlotId")?;
        validate_display_name(&file.display_name)?;
        if validate_declared_attachment(&file.display_name, file.size_bytes)?
            == AttachmentKind::Text
        {
            text_bytes = text_bytes.saturating_add(file.size_bytes);
            if text_bytes > MAX_TEXT_BYTES_PER_DISPATCH {
                return Err(AppError::new(
                    "attachment_text_aggregate_limit",
                    "Text attachments may total at most 512 KiB",
                ));
            }
        }
        if !slots.insert(file.slot_id.as_str()) {
            return Err(AppError::new(
                "attachment_import_slot_duplicate",
                "Attachment import slot IDs must be unique",
            ));
        }
    }
    Ok(())
}

fn validate_upload_slots(batch: &SelectionBatch) -> AppResult<()> {
    if batch.upload_slots.is_empty() {
        return Ok(());
    }
    if batch.upload_slots.len() > MAX_DRAFT_ATTACHMENTS {
        return Err(AppError::new(
            "attachment_selection_corrupt",
            "Attachment import reserves too many slots",
        )
        .outcome_unknown(true));
    }
    let mut slots = HashSet::with_capacity(batch.upload_slots.len());
    let mut handles = HashSet::with_capacity(batch.upload_slots.len());
    for slot in &batch.upload_slots {
        canonical_uuid(&slot.slot_id, "attachmentSlotId")?;
        validate_display_name(&slot.display_name)?;
        validate_declared_attachment(&slot.display_name, slot.declared_size_bytes).map_err(
            |_| {
                AppError::new(
                    "attachment_selection_corrupt",
                    "Attachment import slot has unsupported type or size",
                )
                .outcome_unknown(true)
            },
        )?;
        if !slots.insert(slot.slot_id.as_str()) {
            return Err(AppError::new(
                "attachment_selection_corrupt",
                "Attachment import slot IDs are not unique",
            )
            .outcome_unknown(true));
        }
        if let Some(handle) = slot.record_handle.as_deref() {
            canonical_uuid(handle, "attachmentHandle")?;
            if !handles.insert(handle) {
                return Err(AppError::new(
                    "attachment_selection_corrupt",
                    "Attachment import slots share one staged handle",
                )
                .outcome_unknown(true));
            }
            let record = batch
                .records
                .iter()
                .find(|record| record.handle == handle)
                .ok_or_else(|| {
                    AppError::new(
                        "attachment_selection_corrupt",
                        "Attachment import slot points to a missing staged record",
                    )
                    .outcome_unknown(true)
                })?;
            if record.display_name != slot.display_name
                || record.size_bytes != slot.declared_size_bytes
            {
                return Err(AppError::new(
                    "attachment_selection_corrupt",
                    "Attachment import slot metadata does not match its staged record",
                )
                .outcome_unknown(true));
            }
        }
    }
    if handles.len() != batch.records.len()
        || (batch.phase == SelectionPhase::Ready && handles.len() != batch.upload_slots.len())
    {
        return Err(AppError::new(
            "attachment_selection_corrupt",
            "Attachment import phase and staged records are inconsistent",
        )
        .outcome_unknown(true));
    }
    Ok(())
}

fn ensure_batch_owner(
    batch: &SelectionBatch,
    session_id: &str,
    generation: u64,
    window_label: &str,
) -> AppResult<()> {
    if batch.owner_session_id != session_id
        || batch.owner_generation != generation
        || batch.owner_window_label != window_label
    {
        return Err(AppError::new(
            "attachment_selection_owner_mismatch",
            "Selection belongs to a different renderer session or window",
        ));
    }
    Ok(())
}

fn same_import_manifest(batch: &SelectionBatch, files: &[AttachmentImportFile]) -> bool {
    batch.upload_slots.len() == files.len()
        && batch.upload_slots.iter().zip(files).all(|(slot, file)| {
            slot.slot_id == file.slot_id
                && slot.display_name == file.display_name
                && slot.declared_size_bytes == file.size_bytes
        })
}

fn import_status(batch: &SelectionBatch) -> AppResult<AttachmentImportStatus> {
    let mut attachments = Vec::new();
    for slot in &batch.upload_slots {
        let Some(handle) = slot.record_handle.as_deref() else {
            continue;
        };
        let record = batch
            .records
            .iter()
            .find(|record| record.handle == handle)
            .ok_or_else(|| {
                AppError::new(
                    "attachment_import_state_corrupt",
                    "Attachment import slot lost its staged record",
                )
                .outcome_unknown(true)
            })?;
        attachments.push(record.public());
    }
    Ok(AttachmentImportStatus {
        file_count: batch.upload_slots.len(),
        staged_count: attachments.len(),
        attachments,
    })
}

fn hash_bytes(bytes: &[u8]) -> String {
    let mut digest = Sha256::new();
    digest.update(bytes);
    format!("{:x}", digest.finalize())
}

fn fresh_public_id(store_handle: &str) -> String {
    loop {
        let candidate = uuid::Uuid::new_v4().hyphenated().to_string();
        if candidate != store_handle {
            return candidate;
        }
    }
}

fn migrate_record_public_identity(
    record: &mut AttachmentRecord,
    public_selection_id: &str,
) -> AppResult<()> {
    if record.public_id.is_empty() && record.public_selection_id.is_empty() {
        record.public_id = fresh_public_id(&record.handle);
        record.public_selection_id = public_selection_id.to_owned();
        return Ok(());
    }
    if record.public_id.is_empty() || record.public_selection_id.is_empty() {
        return Err(AppError::new(
            "attachment_public_identity_corrupt",
            "Legacy attachment public identity is only partially present",
        )
        .outcome_unknown(true));
    }
    Ok(())
}

fn validate_attachment_record(record: &AttachmentRecord) -> AppResult<()> {
    canonical_uuid(&record.handle, "attachmentHandle")?;
    canonical_uuid(&record.public_id, "attachmentPublicId")?;
    canonical_uuid(&record.public_selection_id, "attachmentPublicSelectionId")?;
    if validate_display_name(&record.display_name).is_err()
        || record.public_id == record.handle
        || record.staged_name != record.handle
        || record.size_bytes == 0
        || record.size_bytes > MAX_ATTACHMENT_BYTES
        || record.content_sha256.len() != 64
        || !record
            .content_sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
        || match record.kind {
            AttachmentKind::Image => {
                record.encoding.is_some()
                    || !matches!(
                        record.media_type.as_str(),
                        "image/png" | "image/jpeg" | "image/gif" | "image/webp"
                    )
            }
            AttachmentKind::Text => {
                record.encoding != Some(AttachmentEncoding::Utf8)
                    || !matches!(
                        record.media_type.as_str(),
                        "text/plain"
                            | "text/markdown"
                            | "application/json"
                            | "text/csv"
                            | "text/tab-separated-values"
                            | "application/yaml"
                            | "application/xml"
                            | "text/html"
                            | "text/css"
                            | "text/javascript"
                            | "text/typescript"
                            | "text/x-python"
                            | "text/x-rust"
                            | "text/x-go"
                            | "text/x-java-source"
                            | "text/x-kotlin"
                            | "text/x-c"
                            | "text/x-csharp"
                            | "text/x-ruby"
                            | "text/x-php"
                            | "text/x-shellscript"
                            | "text/x-powershell"
                            | "application/toml"
                            | "application/sql"
                            | "application/graphql"
                    )
                    || record.size_bytes > MAX_TEXT_BYTES_PER_DISPATCH
            }
        }
    {
        return Err(AppError::new(
            "attachment_record_corrupt",
            "Attachment record has an unsafe path or invalid immutable metadata",
        )
        .outcome_unknown(true));
    }
    if let Some(selection_id) = &record.selection_id {
        canonical_uuid(selection_id, "selectionId")?;
    }
    if record
        .dispatch_owner_message_id
        .as_ref()
        .is_some_and(|value| value.is_empty() || value.len() > 4096)
    {
        return Err(AppError::new(
            "attachment_record_corrupt",
            "Attachment dispatch owner is invalid",
        )
        .outcome_unknown(true));
    }
    Ok(())
}

fn validate_ordered_attachment_handles(handles: &[String], recovery_owned: bool) -> AppResult<()> {
    let mut unique = HashSet::with_capacity(handles.len());
    for handle in handles {
        canonical_uuid(handle, "attachmentHandle")?;
        if !unique.insert(handle) {
            let error = AppError::new(
                "attachment_handle_duplicate",
                "An attachment handle may appear only once in one action",
            );
            return Err(if recovery_owned {
                error.outcome_unknown(true)
            } else {
                error
            });
        }
    }
    Ok(())
}

fn remove_path_idempotent(path: &Path, operation: &str) -> AppResult<()> {
    #[cfg(windows)]
    {
        let file = match open_windows_delete_candidate(path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => {
                return Err(AppError::io(
                    "open staged attachment for handle-bound removal",
                    error,
                ))
            }
        };
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        let metadata = file
            .metadata()
            .map_err(|error| AppError::io("inspect opened staged attachment", error))?;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(AppError::new(
                "attachment_stage_identity_invalid",
                "Refusing to mutate a staged attachment reparse point",
            )
            .outcome_unknown(true));
        }
        return delete_open_windows_file(file, operation);
    }
    #[cfg(not(windows))]
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(AppError::io(operation, error)),
    }
}

pub(crate) fn remove_migrated_legacy_file(path: &Path) -> AppResult<()> {
    remove_path_idempotent(path, "remove migrated legacy attachment artifact")
}

#[cfg(windows)]
fn open_windows_delete_candidate(path: &Path) -> std::io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{
        DELETE, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE,
        FILE_SHARE_READ, FILE_SHARE_WRITE,
    };

    let mut options = OpenOptions::new();
    options
        .access_mode(DELETE | FILE_READ_ATTRIBUTES)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    options.open(path)
}

#[cfg(windows)]
fn delete_open_windows_file(file: File, operation: &str) -> AppResult<()> {
    use std::mem::size_of;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        FileDispositionInfoEx, SetFileInformationByHandle, FILE_DISPOSITION_FLAG_DELETE,
        FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE, FILE_DISPOSITION_FLAG_POSIX_SEMANTICS,
        FILE_DISPOSITION_INFO_EX,
    };

    let disposition = FILE_DISPOSITION_INFO_EX {
        Flags: FILE_DISPOSITION_FLAG_DELETE
            | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS
            | FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE,
    };
    let deleted = unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle() as _,
            FileDispositionInfoEx,
            (&disposition as *const FILE_DISPOSITION_INFO_EX).cast(),
            size_of::<FILE_DISPOSITION_INFO_EX>() as u32,
        )
    };
    if deleted == 0 {
        return Err(AppError::io(operation, std::io::Error::last_os_error()));
    }
    drop(file);
    Ok(())
}

fn insert_quarantine_dominant(
    records: &mut HashMap<String, AttachmentRecord>,
    record: AttachmentRecord,
) -> AppResult<()> {
    ensure_public_identity_unique(records, &record)?;
    if let Some(existing) = records.get(&record.handle) {
        if existing.content_sha256 != record.content_sha256
            || existing.size_bytes != record.size_bytes
            || existing.staged_name != record.staged_name
            || existing.public_id != record.public_id
            || existing.public_selection_id != record.public_selection_id
        {
            return Err(AppError::new(
                "attachment_identity_conflict",
                "Quarantined attachment conflicts with a draft record",
            )
            .outcome_unknown(true));
        }
    }
    records.insert(record.handle.clone(), record);
    Ok(())
}

fn push_bounded(values: &mut Vec<String>, value: String, maximum: usize) {
    values.retain(|item| item != &value);
    values.push(value);
    if values.len() > maximum {
        values.drain(0..values.len() - maximum);
    }
}

fn sniff_reader(file: &mut File) -> AppResult<String> {
    let mut header = [0u8; 16];
    let count = file
        .read(&mut header)
        .map_err(|error| AppError::io("read attachment signature", error))?;
    let data = &header[..count];
    let media = if data.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if data.starts_with(b"\xff\xd8\xff") {
        "image/jpeg"
    } else if data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a") {
        "image/gif"
    } else if data.len() >= 12 && &data[0..4] == b"RIFF" && &data[8..12] == b"WEBP" {
        "image/webp"
    } else {
        return Err(AppError::new(
            "attachment_type_invalid",
            "Only PNG, JPEG, GIF, and WebP images are supported",
        ));
    };
    Ok(media.into())
}

fn open_regular_nofollow(path: &Path, operation: &str) -> AppResult<File> {
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
        .map_err(|error| AppError::io(operation, error))?;
    let metadata = file
        .metadata()
        .map_err(|error| AppError::io("read attachment file identity", error))?;
    if !metadata.is_file() {
        return Err(AppError::new(
            "attachment_source_not_regular",
            "Attachment path is not a regular file",
        ));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        let attributes = metadata.file_attributes();
        if attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(AppError::new(
                "attachment_source_reparse_point",
                "Attachment source may not be a reparse point",
            ));
        }
    }
    Ok(file)
}

fn hash_file(path: &Path) -> AppResult<String> {
    let mut file = open_regular_nofollow(path, "open sealed attachment")?;
    hash_reader(&mut file, "hash sealed attachment")
}

fn read_sealed_image(path: &Path) -> AppResult<(Vec<u8>, String, String)> {
    let mut file = open_regular_nofollow(path, "open sealed attachment preview")?;
    let metadata = file
        .metadata()
        .map_err(|error| AppError::io("read sealed attachment preview", error))?;
    if metadata.len() == 0 || metadata.len() > MAX_ATTACHMENT_PREVIEW_BYTES {
        return Err(AppError::new(
            "attachment_preview_too_large",
            "Images larger than 5 MiB use the generic attachment chip",
        ));
    }
    let media_type = sniff_reader(&mut file)?;
    file.seek(SeekFrom::Start(0))
        .map_err(|error| AppError::io("rewind sealed attachment preview", error))?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    std::io::Read::by_ref(&mut file)
        .take(MAX_ATTACHMENT_PREVIEW_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| AppError::io("read sealed attachment preview", error))?;
    let after = file
        .metadata()
        .map_err(|error| AppError::io("recheck sealed attachment preview", error))?;
    if bytes.len() as u64 != metadata.len() || after.len() != metadata.len() {
        return Err(AppError::new(
            "attachment_preview_identity_changed",
            "Sealed attachment changed while its preview was read",
        )
        .outcome_unknown(true));
    }
    let digest = hash_bytes(&bytes);
    Ok((bytes, media_type, digest))
}

fn hash_reader(file: &mut File, operation: &str) -> AppResult<String> {
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| AppError::io(operation, error))?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(hex::encode(digest.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SESSION: &str = "11111111-1111-4111-8111-111111111111";
    const SELECTION: &str = "44444444-4444-4444-8444-444444444444";
    const OTHER_SELECTION: &str = "44444444-4444-4444-8444-444444444445";
    const SLOT_ONE: &str = "77777777-7777-4777-8777-777777777771";
    const SLOT_TWO: &str = "77777777-7777-4777-8777-777777777772";

    fn test_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "orquesta-attachment-{label}-{}",
            uuid::Uuid::new_v4()
        ))
    }

    fn open_test_store(root: &Path) -> AttachmentStore {
        AttachmentStore::open(
            root.join("sealed"),
            root.join("selection.json"),
            root.join("quarantine.json"),
            None,
        )
        .expect("open attachment test store")
    }

    fn png_bytes(marker: u8) -> Vec<u8> {
        let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
        bytes.extend([marker; 24]);
        bytes
    }

    fn import_file(slot_id: &str, name: &str, bytes: &[u8]) -> AttachmentImportFile {
        AttachmentImportFile {
            slot_id: slot_id.into(),
            display_name: name.into(),
            size_bytes: bytes.len() as u64,
        }
    }

    fn ready_import(
        store: &mut AttachmentStore,
        selection_id: &str,
        files: &[(&str, &str, &[u8])],
    ) -> Vec<AttachmentDescriptor> {
        let manifest = files
            .iter()
            .map(|(slot, name, bytes)| import_file(slot, name, bytes))
            .collect::<Vec<_>>();
        store
            .begin_import_selection(selection_id, SESSION, 7, "main", &manifest)
            .expect("begin byte import");
        for (slot, _, bytes) in files {
            store
                .stage_import_slot(selection_id, slot, SESSION, 7, "main", bytes)
                .expect("stage byte import");
        }
        store
            .finish_import_selection(selection_id, SESSION, 7, "main")
            .expect("finish byte import")
            .attachments
    }

    fn public_ref(selection_id: &str, descriptor: &AttachmentDescriptor) -> AttachmentPublicRef {
        AttachmentPublicRef {
            selection_id: selection_id.to_owned(),
            public_id: descriptor.public_id.clone(),
        }
    }

    fn store_handle(
        store: &AttachmentStore,
        selection_id: &str,
        descriptor: &AttachmentDescriptor,
    ) -> String {
        store
            .resolve_public_dispatch_handles(&[public_ref(selection_id, descriptor)], None)
            .expect("resolve test public attachment identity")
            .remove(0)
    }

    fn recovery_record(
        project_id: &str,
        message_id: &str,
        handle: String,
        phase: DispatchPhase,
    ) -> DispatchRecoveryRecord {
        DispatchRecoveryRecord {
            schema_version: 1,
            phase,
            message_id: message_id.into(),
            project_id: project_id.into(),
            runtime_project_id: project_id.into(),
            target_agent_id: "orchestrator".into(),
            action_fingerprint: "a".repeat(64),
            attachment_count: 1,
            attachment_handles: vec![handle],
            ordered_attachment_sha256: vec!["b".repeat(64)],
            selected_context_count: 0,
            created_at_ms: 1,
            updated_at_ms: 1,
            receipt: None,
        }
    }

    #[test]
    fn confirmed_stop_preserves_every_foreign_recovery_attachment() {
        let root = test_root("multi-project-stop-preservation");
        fs::create_dir_all(&root).expect("create attachment test root");
        let first_bytes = png_bytes(71);
        let second_bytes = png_bytes(72);
        let mut store = open_test_store(&root);
        let first = ready_import(
            &mut store,
            SELECTION,
            &[(SLOT_ONE, "first.png", &first_bytes)],
        )
        .remove(0);
        let second = ready_import(
            &mut store,
            OTHER_SELECTION,
            &[(SLOT_TWO, "second.png", &second_bytes)],
        )
        .remove(0);
        let first_handle = store_handle(&store, SELECTION, &first);
        let second_handle = store_handle(&store, OTHER_SELECTION, &second);
        let containment = ContainmentEvidence {
            runtime_generation: "33333333-3333-4333-8333-333333333333".into(),
            kind: "process_tree".into(),
        };
        store
            .resolve_for_dispatch(
                "message-a",
                std::slice::from_ref(&first_handle),
                None,
                &containment,
            )
            .expect("seal A");
        store
            .resolve_for_dispatch(
                "message-b",
                std::slice::from_ref(&second_handle),
                None,
                &containment,
            )
            .expect("seal B");
        let first_path = store.root.join(&store.records[&first_handle].staged_name);
        let second_path = store.root.join(&store.records[&second_handle].staged_name);
        let recoveries = vec![
            recovery_record(
                "project-a",
                "message-a",
                first_handle.clone(),
                DispatchPhase::Accepted,
            ),
            recovery_record(
                "project-b",
                "message-b",
                second_handle.clone(),
                DispatchPhase::OutcomeUnknown,
            ),
        ];

        store
            .release_after_confirmed_stop_with_recoveries(&recoveries)
            .expect("stop cleanup preserves all unresolved projects");
        assert!(store.records.contains_key(&first_handle));
        assert!(store.records.contains_key(&second_handle));
        assert!(first_path.exists());
        assert!(second_path.exists());
        assert_eq!(store.quarantine.records.len(), 2);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn public_attachment_ids_are_selection_scoped_and_never_alias_store_handles() {
        let root = test_root("public-id-scope");
        fs::create_dir_all(&root).expect("create attachment test root");
        let first_bytes = png_bytes(31);
        let second_bytes = png_bytes(32);
        let mut store = open_test_store(&root);
        let first = ready_import(
            &mut store,
            SELECTION,
            &[(SLOT_ONE, "first.png", &first_bytes)],
        )
        .remove(0);
        let _second = ready_import(
            &mut store,
            OTHER_SELECTION,
            &[(SLOT_TWO, "second.png", &second_bytes)],
        )
        .remove(0);
        let private_handle = store_handle(&store, SELECTION, &first);

        assert_ne!(first.public_id, private_handle);
        let cross_selection = AttachmentPublicRef {
            selection_id: OTHER_SELECTION.to_owned(),
            public_id: first.public_id.clone(),
        };
        assert_eq!(
            store
                .resolve_public_dispatch_handles(&[cross_selection], None)
                .expect_err("a public ID must not resolve outside its exact selection")
                .code,
            "attachment_public_id_not_found"
        );
        assert_eq!(
            store
                .read_preview(OTHER_SELECTION, &first.public_id, SESSION, 7, "main")
                .expect_err("cross-selection preview must be rejected")
                .code,
            "attachment_preview_not_found"
        );
        assert_eq!(
            store
                .forget_draft(&first.public_id, OTHER_SELECTION, SESSION, 7, "main")
                .expect_err("cross-selection removal must be rejected")
                .code,
            "attachment_selection_mismatch"
        );

        store
            .cancel_selection(SELECTION)
            .expect("clean first public-ID test selection");
        store
            .cancel_selection(OTHER_SELECTION)
            .expect("clean second public-ID test selection");
        drop(store);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn legacy_records_gain_public_identity_but_current_aliases_fail_closed() {
        let legacy_root = test_root("public-id-legacy-migration");
        fs::create_dir_all(&legacy_root).expect("create legacy migration root");
        let source = png_bytes(33);
        let mut legacy_store = open_test_store(&legacy_root);
        let _ = ready_import(
            &mut legacy_store,
            SELECTION,
            &[(SLOT_ONE, "legacy.png", &source)],
        );
        let mut legacy_document = legacy_store.selections.clone();
        legacy_document.schema_version = 4;
        legacy_document.batches[0].records[0].public_id.clear();
        legacy_document.batches[0].records[0]
            .public_selection_id
            .clear();
        atomic_write_json(&legacy_store.selection_path, &legacy_document)
            .expect("write legacy attachment record");
        drop(legacy_store);

        let migrated = open_test_store(&legacy_root);
        assert_eq!(migrated.selections.schema_version, 5);
        drop(migrated);
        let migrated_document: SelectionDocument =
            load_primary_or_backup(&legacy_root.join("selection.json"), "test")
                .expect("read migrated attachment document");
        assert_eq!(migrated_document.schema_version, 5);
        drop(migrated_document);
        let _ = fs::remove_dir_all(legacy_root);

        let corrupt_root = test_root("public-id-current-corrupt");
        fs::create_dir_all(&corrupt_root).expect("create corrupt identity root");
        let mut corrupt_store = open_test_store(&corrupt_root);
        let _ = ready_import(
            &mut corrupt_store,
            SELECTION,
            &[(SLOT_ONE, "corrupt.png", &source)],
        );
        let mut current_document = corrupt_store.selections.clone();
        let store_handle = current_document.batches[0].records[0].handle.clone();
        current_document.batches[0].records[0].public_id = store_handle;
        atomic_write_json(&corrupt_store.selection_path, &current_document)
            .expect("write current aliased attachment identity");
        drop(corrupt_store);

        let error = match AttachmentStore::open(
            corrupt_root.join("sealed"),
            corrupt_root.join("selection.json"),
            corrupt_root.join("quarantine.json"),
            None,
        ) {
            Ok(_) => panic!("current public ID aliases must fail closed"),
            Err(error) => error,
        };
        assert_eq!(error.code, "attachment_record_corrupt");
        assert!(error.outcome_unknown);
        let _ = fs::remove_dir_all(corrupt_root);
    }

    #[test]
    fn persisted_invalid_display_names_fail_closed_on_reopen() {
        let cases = [
            ("empty", String::new()),
            ("too-long", "a".repeat(256)),
            ("control", "unsafe\nname.txt".to_owned()),
        ];
        let source = png_bytes(34);

        for (label, invalid_display_name) in cases {
            let root = test_root(&format!("persisted-display-name-{label}"));
            fs::create_dir_all(&root).expect("create invalid display-name root");
            let mut store = open_test_store(&root);
            let _ = ready_import(&mut store, SELECTION, &[(SLOT_ONE, "valid.png", &source)]);
            let mut document = store.selections.clone();
            // Older selection schemas did not persist upload-slot metadata. Keep
            // the fixture on that valid migration path so this test reaches the
            // durable AttachmentRecord validator itself.
            document.batches[0].upload_slots.clear();
            document.batches[0].records[0].display_name = invalid_display_name;
            atomic_write_json(&store.selection_path, &document)
                .expect("write invalid persisted display name");
            drop(store);

            let error = match AttachmentStore::open(
                root.join("sealed"),
                root.join("selection.json"),
                root.join("quarantine.json"),
                None,
            ) {
                Ok(_) => panic!("invalid persisted display name must fail closed"),
                Err(error) => error,
            };
            assert_eq!(error.code, "attachment_record_corrupt");
            assert!(error.outcome_unknown);
            let _ = fs::remove_dir_all(root);
        }
    }

    #[test]
    fn exact_forget_removes_one_sibling_and_replays_without_leaking_a_draft() {
        let root = test_root("forget-one");
        fs::create_dir_all(&root).expect("create attachment test root");
        let first = png_bytes(1);
        let second = png_bytes(2);
        let mut store = open_test_store(&root);
        let descriptors = ready_import(
            &mut store,
            SELECTION,
            &[
                (SLOT_ONE, "first.png", &first),
                (SLOT_TWO, "second.png", &second),
            ],
        );
        let removed = descriptors[0].public_id.clone();
        let remaining = descriptors[1].public_id.clone();

        store
            .forget_draft(&removed, SELECTION, SESSION, 7, "main")
            .expect("forget one attachment");
        store
            .forget_draft(&removed, SELECTION, SESSION, 7, "main")
            .expect("replay exact forget after response loss");
        assert!(store
            .records
            .values()
            .all(|record| record.public_id != removed));
        assert_eq!(
            store.pending_for_session(SESSION, 7, "main")[0].1[0].public_id,
            remaining
        );

        let remaining_handle = store_handle(&store, SELECTION, &descriptors[1]);

        let lease = store
            .resolve_for_dispatch(
                "message-1",
                std::slice::from_ref(&remaining_handle),
                None,
                &ContainmentEvidence {
                    runtime_generation: "33333333-3333-4333-8333-333333333333".into(),
                    kind: "process_tree".into(),
                },
            )
            .expect("dispatch remaining attachment");
        assert_eq!(lease.attachments.len(), 1);
        assert_eq!(
            lease.attachments[0].attachment_store_handle,
            remaining_handle
        );
        assert!(store.pending_for_session(SESSION, 7, "main").is_empty());
        store
            .cleanup_dispatch_authoritative_failure("message-1", &[remaining_handle])
            .expect("clean test dispatch");
        drop(store);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn restart_finishes_a_durable_per_handle_forget_prefix() {
        let root = test_root("forget-restart");
        fs::create_dir_all(&root).expect("create attachment test root");
        let source = png_bytes(3);
        let mut store = open_test_store(&root);
        let descriptor =
            ready_import(&mut store, SELECTION, &[(SLOT_ONE, "source.png", &source)]).remove(0);
        let mut crash_prefix = store.selections.clone();
        crash_prefix.batches[0].records[0].cleanup_pending = true;
        atomic_write_json(&store.selection_path, &crash_prefix)
            .expect("persist cleanup-pending prefix");
        let record = store
            .records
            .values()
            .find(|record| record.public_id == descriptor.public_id)
            .unwrap()
            .clone();
        store
            .remove_file_idempotent(&record)
            .expect("simulate byte deletion before metadata finalize");
        drop(store);

        let mut reopened = open_test_store(&root);
        reopened
            .forget_draft(&descriptor.public_id, SELECTION, SESSION, 7, "main")
            .expect("exact replay observes completed tombstone");
        assert!(reopened.pending_for_session(SESSION, 7, "main").is_empty());
        drop(reopened);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn duplicate_handles_fail_before_a_dispatch_lease_is_created() {
        let root = test_root("duplicate-handle");
        fs::create_dir_all(&root).expect("create attachment test root");
        let source = png_bytes(4);
        let mut store = open_test_store(&root);
        let descriptor =
            ready_import(&mut store, SELECTION, &[(SLOT_ONE, "source.png", &source)]).remove(0);
        let handle = store_handle(&store, SELECTION, &descriptor);

        let duplicate = vec![handle.clone(), handle.clone()];
        let error = store
            .resolve_for_dispatch(
                "message-duplicate",
                &duplicate,
                None,
                &ContainmentEvidence {
                    runtime_generation: "33333333-3333-4333-8333-333333333333".into(),
                    kind: "process_tree".into(),
                },
            )
            .expect_err("duplicate handle must fail before dispatch sealing");
        assert_eq!(error.code, "attachment_handle_duplicate");
        assert_eq!(
            store.pending_for_session(SESSION, 7, "main")[0].1[0].public_id,
            descriptor.public_id
        );
        store
            .cancel_selection(SELECTION)
            .expect("cleanup duplicate test selection");
        drop(store);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn binary_import_is_reserved_idempotent_and_invisible_until_exact_finish() {
        let root = test_root("binary-import");
        fs::create_dir_all(&root).expect("create attachment test root");
        let first = png_bytes(1);
        let second = png_bytes(2);
        let files = vec![
            import_file(SLOT_ONE, "first.png", &first),
            import_file(SLOT_TWO, "second.png", &second),
        ];
        let mut store = open_test_store(&root);
        let opened = store
            .begin_import_selection(SELECTION, SESSION, 7, "main", &files)
            .expect("begin binary import");
        assert_eq!((opened.file_count, opened.staged_count), (2, 0));
        let replay = store
            .begin_import_selection(SELECTION, SESSION, 7, "main", &files)
            .expect("replay exact import manifest");
        assert_eq!((replay.file_count, replay.staged_count), (2, 0));
        let mut changed = files.clone();
        changed[0].display_name = "changed.png".into();
        assert_eq!(
            store
                .begin_import_selection(SELECTION, SESSION, 7, "main", &changed)
                .expect_err("different manifest must conflict")
                .code,
            "attachment_import_manifest_conflict"
        );

        store
            .stage_import_slot(SELECTION, SLOT_ONE, SESSION, 7, "main", &first)
            .expect("stage first slot");
        store
            .stage_import_slot(SELECTION, SLOT_ONE, SESSION, 7, "main", &first)
            .expect("same bytes replay after response loss");
        let first_handle = store.selections.batches[0].records[0].handle.clone();
        assert!(store.pending_for_session(SESSION, 7, "main").is_empty());
        assert_eq!(
            store
                .content_hashes(std::slice::from_ref(&first_handle))
                .expect_err("partial selection must not enter dispatch fingerprint")
                .code,
            "attachment_not_ready"
        );
        assert!(store
            .resolve_for_dispatch(
                "partial-message",
                std::slice::from_ref(&first_handle),
                None,
                &ContainmentEvidence {
                    runtime_generation: "33333333-3333-4333-8333-333333333333".into(),
                    kind: "process_tree".into(),
                },
            )
            .is_err());
        assert_eq!(
            store
                .finish_import_selection(SELECTION, SESSION, 7, "main")
                .expect_err("incomplete import must not become ready")
                .code,
            "attachment_import_incomplete"
        );
        let mut different = first.clone();
        different[10] ^= 1;
        assert_eq!(
            store
                .stage_import_slot(SELECTION, SLOT_ONE, SESSION, 7, "main", &different)
                .expect_err("different slot replay must conflict")
                .code,
            "attachment_import_replay_mismatch"
        );
        store
            .stage_import_slot(SELECTION, SLOT_TWO, SESSION, 7, "main", &second)
            .expect("stage second slot");
        let ready = store
            .finish_import_selection(SELECTION, SESSION, 7, "main")
            .expect("finish exact import");
        assert_eq!(ready.staged_count, 2);
        assert_eq!(ready.attachments[0].display_name, "first.png");
        assert_eq!(ready.attachments[1].display_name, "second.png");
        let replay = store
            .finish_import_selection(SELECTION, SESSION, 7, "main")
            .expect("finish response-loss replay");
        assert_eq!(replay.attachments, ready.attachments);
        assert_eq!(
            store
                .read_preview(
                    SELECTION,
                    &ready.attachments[0].public_id,
                    SESSION,
                    7,
                    "main",
                )
                .expect("read exact sealed preview"),
            first
        );
        drop(store);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn binary_import_rejects_every_wrong_owner_dimension_and_reserves_capacity() {
        let root = test_root("binary-authority");
        fs::create_dir_all(&root).expect("create attachment test root");
        let bytes = png_bytes(3);
        let files = vec![import_file(SLOT_ONE, "one.png", &bytes)];
        let mut store = open_test_store(&root);
        store
            .begin_import_selection(SELECTION, SESSION, 7, "main", &files)
            .expect("begin binary import");
        for (selection, slot, session, generation, window, code) in [
            (
                OTHER_SELECTION,
                SLOT_ONE,
                SESSION,
                7,
                "main",
                "attachment_selection_not_found",
            ),
            (
                SELECTION,
                SLOT_TWO,
                SESSION,
                7,
                "main",
                "attachment_import_slot_unknown",
            ),
            (
                SELECTION,
                SLOT_ONE,
                "11111111-1111-4111-8111-111111111112",
                7,
                "main",
                "attachment_selection_owner_mismatch",
            ),
            (
                SELECTION,
                SLOT_ONE,
                SESSION,
                8,
                "main",
                "attachment_selection_owner_mismatch",
            ),
            (
                SELECTION,
                SLOT_ONE,
                SESSION,
                7,
                "other",
                "attachment_selection_owner_mismatch",
            ),
        ] {
            assert_eq!(
                store
                    .stage_import_slot(selection, slot, session, generation, window, &bytes)
                    .expect_err("wrong authority must fail")
                    .code,
                code
            );
        }
        let three_more = vec![
            import_file("77777777-7777-4777-8777-777777777773", "two.png", &bytes),
            import_file("77777777-7777-4777-8777-777777777774", "three.png", &bytes),
            import_file("77777777-7777-4777-8777-777777777775", "four.png", &bytes),
        ];
        store
            .begin_import_selection(OTHER_SELECTION, SESSION, 7, "main", &three_more)
            .expect("reserve remaining three slots");
        assert_eq!(
            store
                .begin_import_selection(
                    "44444444-4444-4444-8444-444444444446",
                    SESSION,
                    7,
                    "main",
                    &[import_file(
                        "77777777-7777-4777-8777-777777777776",
                        "overflow.png",
                        &bytes,
                    )],
                )
                .expect_err("opening reservations must count against quota")
                .code,
            "attachment_draft_quota"
        );
        drop(store);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn import_slot_removal_keeps_ready_slot_record_bijection_restart_safe() {
        let root = test_root("binary-remove-restart");
        fs::create_dir_all(&root).expect("create attachment test root");
        let first = png_bytes(4);
        let second = png_bytes(5);
        let files = vec![
            import_file(SLOT_ONE, "first.png", &first),
            import_file(SLOT_TWO, "second.png", &second),
        ];
        let mut store = open_test_store(&root);
        store
            .begin_import_selection(SELECTION, SESSION, 7, "main", &files)
            .expect("begin import");
        store
            .stage_import_slot(SELECTION, SLOT_ONE, SESSION, 7, "main", &first)
            .expect("stage first");
        store
            .stage_import_slot(SELECTION, SLOT_TWO, SESSION, 7, "main", &second)
            .expect("stage second");
        let ready = store
            .finish_import_selection(SELECTION, SESSION, 7, "main")
            .expect("finish import");
        store
            .forget_draft(
                &ready.attachments[0].public_id,
                SELECTION,
                SESSION,
                7,
                "main",
            )
            .expect("forget one imported attachment");
        assert_eq!(store.selections.batches[0].upload_slots.len(), 1);
        assert_eq!(store.selections.batches[0].records.len(), 1);
        drop(store);
        let reopened = open_test_store(&root);
        assert!(reopened.pending_for_session(SESSION, 7, "main").is_empty());
        drop(reopened);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn text_attachment_is_private_core_wire_only_and_never_renderer_previewed() {
        let root = test_root("text-private-wire");
        fs::create_dir_all(&root).expect("create attachment test root");
        let source = "hello, 世界\r\n".as_bytes();
        let mut store = open_test_store(&root);
        let descriptor =
            ready_import(&mut store, SELECTION, &[(SLOT_ONE, "notes.txt", source)]).remove(0);
        assert_eq!(descriptor.kind, AttachmentKind::Text);
        assert_eq!(descriptor.media_type, "text/plain");
        assert_eq!(
            store
                .read_preview(SELECTION, &descriptor.public_id, SESSION, 7, "main")
                .expect_err("text contents must not cross the renderer preview boundary")
                .code,
            "attachment_preview_unsupported"
        );

        let handle = store_handle(&store, SELECTION, &descriptor);
        assert_ne!(descriptor.public_id, handle);
        let lease = store
            .resolve_for_dispatch(
                "message-text",
                std::slice::from_ref(&handle),
                None,
                &ContainmentEvidence {
                    runtime_generation: "33333333-3333-4333-8333-333333333333".into(),
                    kind: "process_tree".into(),
                },
            )
            .expect("seal text attachment for private Core input");
        assert_eq!(lease.attachments.len(), 1);
        let sealed = &lease.attachments[0];
        assert_eq!(sealed.attachment_store_handle, handle);
        assert_eq!(sealed.kind, AttachmentKind::Text);
        assert_eq!(sealed.encoding, Some(AttachmentEncoding::Utf8));
        assert_eq!(sealed.size_bytes, source.len() as u64);
        assert_eq!(sealed.sha256.len(), 64);
        assert_eq!(
            Path::new(&sealed.sealed_absolute_path)
                .file_name()
                .and_then(|value| value.to_str()),
            Some(sealed.attachment_store_handle.as_str())
        );
        assert_eq!(
            store
                .cleanup_dispatch_authoritative_failure("message-text", &[])
                .expect_err("mismatched cleanup authority must retain the sealed guard")
                .code,
            "attachment_recovery_record_missing"
        );
        assert!(store.dispatch_guards.contains_key("message-text"));
        assert!(Path::new(&sealed.sealed_absolute_path).is_file());
        store
            .cleanup_dispatch_authoritative_failure(
                "message-text",
                std::slice::from_ref(&sealed.attachment_store_handle),
            )
            .expect("clean text dispatch");
        drop(store);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn dispatch_text_aggregate_fails_before_promoting_a_new_draft() {
        let root = test_root("text-dispatch-aggregate");
        fs::create_dir_all(&root).expect("create attachment test root");
        let first_source = vec![b'a'; 300 * 1024];
        let second_source = vec![b'b'; 300 * 1024];
        let mut store = open_test_store(&root);
        let first = ready_import(
            &mut store,
            SELECTION,
            &[(SLOT_ONE, "first.txt", &first_source)],
        )
        .remove(0);
        let first_handle = store_handle(&store, SELECTION, &first);
        store
            .resolve_for_dispatch(
                "message-aggregate",
                std::slice::from_ref(&first_handle),
                None,
                &ContainmentEvidence {
                    runtime_generation: "33333333-3333-4333-8333-333333333333".into(),
                    kind: "process_tree".into(),
                },
            )
            .expect("quarantine first text attachment");
        let second = ready_import(
            &mut store,
            OTHER_SELECTION,
            &[(SLOT_TWO, "second.txt", &second_source)],
        )
        .remove(0);
        let second_handle = store_handle(&store, OTHER_SELECTION, &second);

        let requested = vec![first_handle.clone(), second_handle.clone()];
        assert_eq!(
            store
                .resolve_for_dispatch(
                    "message-aggregate",
                    &requested,
                    None,
                    &ContainmentEvidence {
                        runtime_generation: "33333333-3333-4333-8333-333333333333".into(),
                        kind: "process_tree".into(),
                    },
                )
                .expect_err("aggregate overflow must fail before draft promotion")
                .code,
            "attachment_text_aggregate_limit"
        );
        assert_eq!(
            store.pending_for_session(SESSION, 7, "main")[0].1[0].public_id,
            second.public_id
        );
        assert!(store
            .quarantine
            .records
            .iter()
            .all(|record| record.attachment.handle != second_handle));
        store
            .cleanup_dispatch_authoritative_failure(
                "message-aggregate",
                std::slice::from_ref(&first_handle),
            )
            .expect("clean first dispatch");
        store
            .cancel_selection(OTHER_SELECTION)
            .expect("clean second draft");
        drop(store);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn reopen_finishes_durable_renderer_cleanup_prefix() {
        let root = test_root("renderer-cleanup-reopen");
        fs::create_dir_all(&root).expect("create attachment test root");
        let mut store = open_test_store(&root);
        let descriptor = ready_import(
            &mut store,
            SELECTION,
            &[(SLOT_ONE, "source.txt", b"renderer draft")],
        )
        .remove(0);
        let handle = store_handle(&store, SELECTION, &descriptor);
        let staged_path = store.root.join(&store.records[&handle].staged_name);
        let mut durable = store.selections.clone();
        durable.batches[0].phase = SelectionPhase::CleanupPending;
        atomic_write_json(&store.selection_path, &durable)
            .expect("persist renderer cleanup admission");
        drop(store);

        let reopened = open_test_store(&root);
        assert!(reopened.selections.batches.is_empty());
        assert!(!reopened.records.contains_key(&handle));
        assert!(!staged_path.exists());
        drop(reopened);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn reopen_keeps_quarantine_authority_when_selection_cleanup_commit_was_lost() {
        let root = test_root("quarantine-before-selection-cleanup");
        fs::create_dir_all(&root).expect("create attachment test root");
        let mut store = open_test_store(&root);
        let descriptor = ready_import(
            &mut store,
            SELECTION,
            &[(SLOT_ONE, "source.txt", b"dispatch payload")],
        )
        .remove(0);
        let handle = store_handle(&store, SELECTION, &descriptor);
        let digest = store.records[&handle].content_sha256.clone();
        let stale_selection = store.selections.clone();
        store
            .resolve_for_dispatch(
                "message-crash-prefix",
                std::slice::from_ref(&handle),
                None,
                &ContainmentEvidence {
                    runtime_generation: "33333333-3333-4333-8333-333333333333".into(),
                    kind: "process_tree".into(),
                },
            )
            .expect("commit quarantine before selection cleanup");
        atomic_write_json(&store.selection_path, &stale_selection)
            .expect("restore simulated pre-cleanup selection prefix");
        drop(store);

        let mut recovery = recovery_record(
            "project-crash-prefix",
            "message-crash-prefix",
            handle.clone(),
            DispatchPhase::OutcomeUnknown,
        );
        recovery.ordered_attachment_sha256 = vec![digest];
        let reopened = AttachmentStore::open(
            root.join("sealed"),
            root.join("selection.json"),
            root.join("quarantine.json"),
            Some(&recovery),
        )
        .expect("reopen exact dispatch recovery");
        assert!(reopened.selections.batches.is_empty());
        let recovered = reopened
            .records
            .get(&handle)
            .expect("recovered quarantine record");
        assert_eq!(
            recovered.dispatch_owner_message_id.as_deref(),
            Some("message-crash-prefix")
        );
        assert!(reopened.root.join(&recovered.staged_name).exists());
        drop(reopened);
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    fn handle_bound_delete_does_not_follow_a_replacement_path() {
        let root = test_root("handle-delete");
        fs::create_dir_all(&root).expect("create attachment test root");
        let original = root.join("original");
        let moved = root.join("moved");
        fs::write(&original, b"owned").expect("write owned file");
        let opened = open_windows_delete_candidate(&original).expect("open deletion handle");
        fs::rename(&original, &moved).expect("move opened owned file");
        fs::write(&original, b"replacement").expect("write replacement file");

        delete_open_windows_file(opened, "delete handle-bound test file")
            .expect("delete opened object");

        assert_eq!(
            fs::read(&original).expect("read replacement"),
            b"replacement"
        );
        assert!(!moved.exists());
        let _ = fs::remove_dir_all(root);
    }
}
