use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, RwLock, RwLockReadGuard, RwLockWriteGuard};
use std::time::Duration;

use rusqlite::{
    params, Connection, OpenFlags, OptionalExtension, Row, Transaction, TransactionBehavior,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::storage::private_directory;

const PROJECTION_SCHEMA_VERSION: u32 = 1;
const PROJECTION_DATABASE_SCHEMA_VERSION: u32 = 16;
const MAX_ID_BYTES: usize = 512;
const MAX_TEXT_BYTES: usize = 256 * 1024;
const MAX_STREAM_DELTA_BYTES: usize = 64 * 1024;
const MAX_PAGE_SIZE: u32 = 200;
const MAX_BATCH_EVENTS: usize = 100_000;
const MAX_BACKFILL_RECORDS: usize = 10_000;
const HISTORY_SEARCH_ROW_BUDGET: usize = 4_096;
const HISTORY_SEARCH_TEXT_BUDGET: usize = 4 * 1024 * 1024;
const PENDING_REQUEST_CURSOR_SCHEMA_VERSION: u32 = 1;

fn is_supported_desktop_approval_decision(value: &str) -> bool {
    matches!(value, "accept" | "acceptForSession" | "decline" | "cancel")
}

fn has_supported_desktop_approval_decision(values: &[String]) -> bool {
    values
        .iter()
        .any(|value| is_supported_desktop_approval_decision(value))
}

fn approval_method_matches_effect(method: Option<&str>, effect: Option<&str>) -> bool {
    matches!(
        (method, effect),
        (Some("item/fileChange/requestApproval"), Some("file_change"))
            | (
                Some("item/commandExecution/requestApproval"),
                Some("command_execution")
            )
    )
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PendingRequestCursorToken {
    schema_version: u32,
    recovery_rank: u8,
    before_created_at: String,
    before_request_key: String,
    authority_fingerprint: String,
}

#[derive(Debug, Clone)]
struct PendingRequestPage {
    items: Vec<PendingRequest>,
    next_cursor: Option<String>,
}

#[derive(Clone, Debug)]
pub struct ProjectionService {
    root: PathBuf,
    trusted_app_data_root: PathBuf,
    operation_lock: Arc<RwLock<()>>,
    verified_databases: Arc<Mutex<HashSet<PathBuf>>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DomainEventOwner {
    pub kind: String,
    pub agent_id: Option<String>,
    pub execution_id: Option<String>,
    pub system_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DomainEventEnvelope {
    pub domain_event_version: u32,
    pub source_event_id: String,
    pub source_runtime: String,
    pub source_cursor: Option<String>,
    pub owner: DomainEventOwner,
    pub agent_id: Option<String>,
    pub task_id: Option<String>,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub item_id: Option<String>,
    pub kind: String,
    pub phase: String,
    pub occurred_at: String,
    pub payload: Value,
    pub evidence_ref: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectionEvent {
    pub schema_version: u32,
    #[serde(default)]
    pub domain_event_version: Option<u32>,
    #[serde(default)]
    pub source_event_id: Option<String>,
    #[serde(default)]
    pub owner: Option<DomainEventOwner>,
    pub stream_id: String,
    pub journal_sequence: i64,
    pub event_id: String,
    pub source_runtime: String,
    pub source_cursor: Option<String>,
    pub project_id: String,
    pub agent_id: Option<String>,
    pub task_id: Option<String>,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub item_id: Option<String>,
    pub kind: String,
    pub phase: String,
    pub occurred_at: String,
    pub payload: Value,
    pub evidence_ref: Option<String>,
    pub storage: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderMessageRecord {
    pub message_id: String,
    pub thread_id: String,
    pub turn_id: Option<String>,
    pub target_agent_id: Option<String>,
    pub role: String,
    pub text: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderActivityRecord {
    pub event_type: String,
    pub thread_id: String,
    pub turn_id: String,
    pub item_id: Option<String>,
    pub target_agent_id: String,
    pub occurred_at: String,
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderPage {
    pub page_id: String,
    pub thread_id: String,
    pub requested_cursor: Option<String>,
    pub next_cursor: Option<String>,
    pub is_complete: bool,
    pub records: Vec<ProviderMessageRecord>,
    #[serde(default)]
    pub activities: Vec<ProviderActivityRecord>,
    #[serde(default)]
    pub turns: Vec<ProviderTurnRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderTurnRecord {
    pub thread_id: String,
    pub turn_id: String,
    pub state: String,
    #[serde(default)]
    pub item_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectionCursor {
    pub before_created_at: String,
    pub before_message_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectionActivityCursor {
    pub before_created_at: String,
    pub before_activity_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectionMessage {
    pub message_id: String,
    pub thread_id: String,
    pub turn_id: Option<String>,
    pub target_agent_id: Option<String>,
    pub role: String,
    pub text: String,
    pub created_at: String,
    pub journal_sequence: Option<i64>,
    pub origin: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StreamingProjectionMessage {
    pub message_id: String,
    pub thread_id: String,
    pub turn_id: String,
    pub item_id: String,
    pub target_agent_id: String,
    pub role: String,
    pub text: String,
    pub created_at: String,
    pub updated_at: String,
    pub last_journal_sequence: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectedActivity {
    pub activity_id: String,
    pub thread_id: String,
    pub turn_id: String,
    pub item_id: Option<String>,
    pub target_agent_id: String,
    pub kind: String,
    pub state: String,
    pub title: String,
    pub details: Value,
    pub created_at: String,
    pub updated_at: String,
    pub last_journal_sequence: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedActivityPage {
    pub items: Vec<ProjectedActivity>,
    pub next_cursor: Option<ProjectionActivityCursor>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActiveTurnProjection {
    pub thread_id: String,
    pub turn_id: String,
    pub target_agent_id: String,
    pub state: String,
    pub last_journal_sequence: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnMutationKind {
    Stop,
    Steer,
}

impl TurnMutationKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Stop => "stop",
            Self::Steer => "steer",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnMutationClaimResult {
    Acquired,
    Duplicate,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovalResponseClaim {
    pub identity: String,
    pub provider_connection_id: String,
    pub provider_request_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApprovalResponseClaimResult {
    Acquired(ApprovalResponseClaim),
    Duplicate { decision: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectionPage {
    pub items: Vec<ProjectionMessage>,
    pub next_cursor: Option<ProjectionCursor>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PendingRequest {
    pub request_key: String,
    pub agent_id: Option<String>,
    pub request_kind: String,
    pub response_options: Vec<String>,
    pub prompt: Option<String>,
    pub created_at: String,
    pub requested_effect_kind: Option<String>,
    pub response_phase: Option<String>,
    pub recovery_state: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolvedRequest {
    pub request_key: String,
    pub agent_id: Option<String>,
    pub request_kind: String,
    pub response_options: Vec<String>,
    pub created_at: String,
    pub resolved_at: String,
    pub requested_effect_kind: Option<String>,
    pub response_decision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TurnProjection {
    pub thread_id: String,
    pub turn_id: String,
    pub state: String,
    pub item_count: i64,
    pub last_journal_sequence: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectionSnapshot {
    pub project_id: String,
    pub stream_id: Option<String>,
    pub applied_journal_sequence: i64,
    pub projection_revision: i64,
    pub event_count: i64,
    pub message_count: i64,
    pub pending_request_count: i64,
    pub turns: Vec<TurnProjection>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectionApplyReceipt {
    pub status: String,
    pub stream_id: String,
    pub applied_journal_sequence: i64,
    pub projection_revision: i64,
    pub event_count: usize,
    pub message_count: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectionConversationInput {
    pub schema_version: u32,
    pub project_id: String,
    pub target_agent_id: String,
    pub expected_stream_id: Option<String>,
    pub after_journal_sequence: i64,
    pub expected_projection_revision: i64,
    pub cursor: Option<ProjectionCursor>,
    pub activity_cursor: Option<ProjectionActivityCursor>,
    #[serde(default)]
    pub pending_request_cursor: Option<String>,
    pub limit: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectionHistoryCursor {
    pub before_updated_at: String,
    pub before_message_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectionHistoryIndexInput {
    pub schema_version: u32,
    pub project_id: String,
    pub cursor: Option<ProjectionHistoryCursor>,
    pub limit: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectionConversationSummary {
    pub target_agent_id: String,
    pub updated_at: String,
    pub last_message_id: String,
    pub last_role: String,
    pub preview: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectionHistoryIndexPage {
    pub project_id: String,
    pub items: Vec<ProjectionConversationSummary>,
    pub next_cursor: Option<ProjectionHistoryCursor>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectionHistoryPageInput {
    pub schema_version: u32,
    pub project_id: String,
    pub target_agent_id: String,
    pub query: Option<String>,
    pub cursor: Option<ProjectionCursor>,
    pub limit: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectionHistoryPage {
    pub project_id: String,
    pub target_agent_id: String,
    pub query: Option<String>,
    pub items: Vec<ProjectionMessage>,
    pub next_cursor: Option<ProjectionCursor>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectionConversationSnapshot {
    pub project_id: String,
    pub target_agent_id: String,
    pub stream_id: Option<String>,
    pub applied_journal_sequence: i64,
    pub projection_revision: i64,
    pub sync_state: String,
    pub items: Vec<ProjectionMessage>,
    pub streaming_items: Vec<StreamingProjectionMessage>,
    pub activities: Vec<ProjectedActivity>,
    pub active_turns: Vec<ActiveTurnProjection>,
    pub latest_turn: Option<ActiveTurnProjection>,
    pub older_cursor: Option<ProjectionCursor>,
    pub activity_older_cursor: Option<ProjectionActivityCursor>,
    pub pending_request_older_cursor: Option<String>,
    pub pending_requests: Vec<PendingRequest>,
    pub resolved_requests: Vec<ResolvedRequest>,
}

fn projection_error(code: &str, message: impl Into<String>) -> AppError {
    AppError::new(code, message)
}

fn sqlite_error(context: &str, error: rusqlite::Error) -> AppError {
    projection_error("projection_sqlite_failed", format!("{context}: {error}"))
}

fn io_error(context: &str, error: std::io::Error) -> AppError {
    projection_error("projection_io_failed", format!("{context}: {error}"))
}

fn validate_schema(version: u32) -> AppResult<()> {
    if version != PROJECTION_SCHEMA_VERSION {
        return Err(projection_error(
            "projection_contract_unsupported",
            format!("Unsupported projection schemaVersion: {version}"),
        ));
    }
    Ok(())
}

fn validate_id(value: &str, field: &str) -> AppResult<()> {
    if value.trim().is_empty() || value.len() > MAX_ID_BYTES || value.chars().any(char::is_control)
    {
        return Err(projection_error(
            "projection_input_invalid",
            format!("{field} is invalid"),
        ));
    }
    Ok(())
}

fn validate_optional_id(value: Option<&str>, field: &str) -> AppResult<()> {
    if let Some(value) = value {
        validate_id(value, field)?;
    }
    Ok(())
}

fn validate_cursor(value: Option<&str>, field: &str) -> AppResult<()> {
    if let Some(value) = value {
        if value.trim().is_empty() || value.len() > 2_048 || value.chars().any(char::is_control) {
            return Err(projection_error(
                "projection_input_invalid",
                format!("{field} is invalid"),
            ));
        }
    }
    Ok(())
}

fn validate_timestamp(value: &str, field: &str) -> AppResult<()> {
    let bytes = value.as_bytes();
    let structural = bytes.len() == 24
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[10] == b'T'
        && bytes[13] == b':'
        && bytes[16] == b':'
        && bytes[19] == b'.'
        && bytes[23] == b'Z'
        && bytes.iter().enumerate().all(|(index, byte)| {
            matches!(index, 4 | 7 | 10 | 13 | 16 | 19 | 23) || byte.is_ascii_digit()
        });
    let number = |start: usize, end: usize| value[start..end].parse::<u32>().ok();
    let year = number(0, 4);
    let month = number(5, 7);
    let day = number(8, 10);
    let days_in_month = match (year, month) {
        (Some(year), Some(2)) if year % 400 == 0 || (year % 4 == 0 && year % 100 != 0) => 29,
        (Some(_), Some(2)) => 28,
        (Some(_), Some(4 | 6 | 9 | 11)) => 30,
        (Some(_), Some(1 | 3 | 5 | 7 | 8 | 10 | 12)) => 31,
        _ => 0,
    };
    if !structural
        || days_in_month == 0
        || !day.is_some_and(|day| (1..=days_in_month).contains(&day))
        || !matches!(number(11, 13), Some(0..=23))
        || !matches!(number(14, 16), Some(0..=59))
        || !matches!(number(17, 19), Some(0..=59))
    {
        return Err(projection_error(
            "projection_input_invalid",
            format!("{field} must be a bounded UTC timestamp"),
        ));
    }
    Ok(())
}

fn validate_text(value: &str, field: &str) -> AppResult<()> {
    if value.trim().is_empty() || value.len() > MAX_TEXT_BYTES {
        return Err(projection_error(
            "projection_input_invalid",
            format!("{field} is empty or too large"),
        ));
    }
    Ok(())
}

fn validate_stream_text(value: &str, field: &str, maximum: usize) -> AppResult<()> {
    // Provider deltas may consist only of whitespace. Trimming them would
    // remove meaningful spacing between streamed answer tokens.
    if value.is_empty() || value.len() > maximum || value.chars().any(|character| character == '\0')
    {
        return Err(projection_error(
            "projection_stream_invalid",
            format!("{field} is empty, unsafe, or too large"),
        ));
    }
    Ok(())
}

fn validate_limit(limit: u32) -> AppResult<usize> {
    if limit == 0 || limit > MAX_PAGE_SIZE {
        return Err(projection_error(
            "projection_input_invalid",
            format!("limit must be from 1 to {MAX_PAGE_SIZE}"),
        ));
    }
    Ok(limit as usize)
}

fn project_hash(project_id: &str) -> String {
    hex::encode(Sha256::digest(project_id.as_bytes()))
}

fn path_is_onedrive(path: &Path) -> bool {
    path.components().any(|component| match component {
        Component::Normal(value) => value
            .to_string_lossy()
            .to_ascii_lowercase()
            .starts_with("onedrive"),
        _ => false,
    })
}

fn db_sidecars(path: &Path) -> [PathBuf; 3] {
    let text = path.as_os_str().to_string_lossy();
    [
        path.to_path_buf(),
        PathBuf::from(format!("{text}-wal")),
        PathBuf::from(format!("{text}-shm")),
    ]
}

fn validate_database_artifacts(path: &Path) -> AppResult<()> {
    for artifact in db_sidecars(path).into_iter().filter(|item| item.exists()) {
        let metadata = fs::symlink_metadata(&artifact)
            .map_err(|error| io_error("inspect projection database artifact", error))?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(projection_error(
                "projection_path_identity_invalid",
                format!(
                    "Projection database artifact is a link, reparse point, or non-file: {}",
                    artifact.display()
                ),
            ));
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
            if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                return Err(projection_error(
                    "projection_path_identity_invalid",
                    "Projection database artifact is a reparse point",
                ));
            }
        }
    }
    Ok(())
}

fn validate_provider_page(page: &ProviderPage) -> AppResult<()> {
    validate_id(&page.page_id, "pageId")?;
    validate_id(&page.thread_id, "threadId")?;
    validate_cursor(page.requested_cursor.as_deref(), "requestedCursor")?;
    validate_cursor(page.next_cursor.as_deref(), "nextCursor")?;
    if page.is_complete != page.next_cursor.is_none() {
        return Err(projection_error(
            "projection_page_invalid",
            "Provider page completion and next cursor contradict each other",
        ));
    }
    if page.records.len() > MAX_BACKFILL_RECORDS
        || page.activities.len() > MAX_BACKFILL_RECORDS
        || page.turns.len() > MAX_BACKFILL_RECORDS
    {
        return Err(projection_error(
            "projection_page_too_large",
            "Provider page exceeds its bounded record limit",
        ));
    }
    for record in &page.activities {
        if record.thread_id != page.thread_id {
            return Err(projection_error(
                "projection_page_invalid",
                "Provider activity is not bound to its page thread",
            ));
        }
        provider_activity_from_record(record)?;
    }
    Ok(())
}

impl ProjectionService {
    pub(crate) fn open(paths: &crate::paths::NativePaths) -> AppResult<Self> {
        Self::open_trusted(paths.projection_root(), paths.projection_data_root.clone())
    }

    pub(crate) fn open_trusted(root: PathBuf, trusted_app_data_root: PathBuf) -> AppResult<Self> {
        if !root.is_absolute()
            || !trusted_app_data_root.is_absolute()
            || path_is_onedrive(&root)
            || path_is_onedrive(&trusted_app_data_root)
            || root != trusted_app_data_root.join("projection")
        {
            return Err(projection_error(
                "projection_root_untrusted",
                "Projection storage must be the dedicated child of the trusted local AppData root",
            ));
        }
        private_directory(&trusted_app_data_root)?;
        private_directory(&root)?;
        let trusted_app_data_root = fs::canonicalize(&trusted_app_data_root)
            .map_err(|error| io_error("canonicalize trusted AppData root", error))?;
        let root = fs::canonicalize(&root)
            .map_err(|error| io_error("canonicalize projection root", error))?;
        if root.parent() != Some(trusted_app_data_root.as_path()) {
            return Err(projection_error(
                "projection_root_untrusted",
                "Projection storage resolves outside the trusted local AppData root",
            ));
        }
        Ok(Self {
            root,
            trusted_app_data_root,
            operation_lock: Arc::new(RwLock::new(())),
            verified_databases: Arc::new(Mutex::new(HashSet::new())),
        })
    }

    fn read_operation(&self) -> AppResult<RwLockReadGuard<'_, ()>> {
        self.operation_lock.read().map_err(|_| {
            projection_error(
                "projection_lock_poisoned",
                "Projection read lock was poisoned; restart Desktop Next before retrying",
            )
        })
    }

    fn write_operation(&self) -> AppResult<RwLockWriteGuard<'_, ()>> {
        self.operation_lock.write().map_err(|_| {
            projection_error(
                "projection_lock_poisoned",
                "Projection write lock was poisoned; restart Desktop Next before retrying",
            )
        })
    }

    fn verified(&self) -> AppResult<MutexGuard<'_, HashSet<PathBuf>>> {
        self.verified_databases.lock().map_err(|_| {
            projection_error(
                "projection_lock_poisoned",
                "Projection verification lock was poisoned; restart Desktop Next before retrying",
            )
        })
    }

    fn project_directory_path(&self, project_id: &str) -> AppResult<PathBuf> {
        validate_id(project_id, "projectId")?;
        Ok(self.root.join(project_hash(project_id)))
    }

    fn trusted_project_directory(&self, directory: &Path) -> AppResult<PathBuf> {
        let canonical = fs::canonicalize(directory)
            .map_err(|error| io_error("canonicalize project projection directory", error))?;
        if canonical.parent() != Some(self.root.as_path())
            || !canonical.starts_with(&self.trusted_app_data_root)
        {
            return Err(projection_error(
                "projection_root_untrusted",
                "Project projection directory resolves outside trusted AppData",
            ));
        }
        Ok(canonical)
    }

    fn project_directory_for_initialization(&self, project_id: &str) -> AppResult<PathBuf> {
        let directory = self.project_directory_path(project_id)?;
        private_directory(&directory)?;
        self.trusted_project_directory(&directory)
    }

    fn existing_project_directory(&self, project_id: &str) -> AppResult<PathBuf> {
        let directory = self.project_directory_path(project_id)?;
        if !directory.exists() {
            return Err(projection_error(
                "projection_database_missing",
                "Durable project SQLite is unavailable; the project is fail-closed until the database is restored or repaired",
            ));
        }
        private_directory(&directory)?;
        self.trusted_project_directory(&directory)
    }

    fn database_path_for_initialization(&self, project_id: &str) -> AppResult<PathBuf> {
        Ok(self
            .project_directory_for_initialization(project_id)?
            .join("projection.sqlite3"))
    }

    fn existing_database_path(&self, project_id: &str) -> AppResult<PathBuf> {
        let path = self
            .existing_project_directory(project_id)?
            .join("projection.sqlite3");
        if !path.exists() {
            return Err(projection_error(
                "projection_database_missing",
                "Durable project SQLite is unavailable; the project is fail-closed until the database is restored or repaired",
            ));
        }
        Ok(path)
    }

    fn initialization_connection(&self, project_id: &str) -> AppResult<Connection> {
        let path = self.database_path_for_initialization(project_id)?;
        validate_database_artifacts(&path)?;
        let verify = !self.verified()?.contains(&path);
        let connection = open_database_for_initialization(&path, project_id, verify)?;
        validate_database_artifacts(&path)?;
        if verify {
            self.verified()?.insert(path);
        }
        Ok(connection)
    }

    fn connection(&self, project_id: &str) -> AppResult<Connection> {
        let path = self.existing_database_path(project_id)?;
        validate_database_artifacts(&path)?;
        let verify = !self.verified()?.contains(&path);
        let connection = open_existing_database(&path, project_id, verify)?;
        validate_database_artifacts(&path)?;
        if verify {
            self.verified()?.insert(path);
        }
        Ok(connection)
    }

    fn read_connection(&self, project_id: &str) -> AppResult<Connection> {
        self.connection(project_id)
    }

    pub fn ingest_domain_events_for_connection(
        &self,
        project_id: &str,
        runtime_connection_id: Option<&str>,
        events: &[DomainEventEnvelope],
    ) -> AppResult<ProjectionApplyReceipt> {
        let _operation = self.write_operation()?;
        if let Some(connection_id) = runtime_connection_id {
            validate_id(connection_id, "runtimeConnectionId")?;
        }
        let mut connection = self.connection(project_id)?;
        ingest_domain_events_to_connection(
            &mut connection,
            project_id,
            runtime_connection_id,
            events,
        )
    }

    #[cfg(test)]
    fn ingest_domain_events(
        &self,
        project_id: &str,
        events: &[DomainEventEnvelope],
    ) -> AppResult<ProjectionApplyReceipt> {
        self.ingest_domain_events_for_connection(project_id, None, events)
    }

    pub fn initialize_project(&self, project_id: &str) -> AppResult<ProjectionSnapshot> {
        let _operation = self.write_operation()?;
        validate_id(project_id, "projectId")?;
        let mut connection = self.initialization_connection(project_id)?;
        initialize_project_connection(&mut connection, project_id)
    }

    pub fn require_existing_project(&self, project_id: &str) -> AppResult<ProjectionSnapshot> {
        let _operation = self.write_operation()?;
        validate_id(project_id, "projectId")?;
        let mut connection = self.connection(project_id)?;
        require_existing_project_connection(&mut connection, project_id)
    }

    #[cfg(test)]
    fn database_path_for_test(&self, project_id: &str) -> PathBuf {
        self.database_path_for_initialization(project_id)
            .expect("test project path")
    }
}

fn initialize_project_connection(
    connection: &mut Connection,
    project_id: &str,
) -> AppResult<ProjectionSnapshot> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| sqlite_error("begin durable project initialization", error))?;
    transaction
        .execute(
            "INSERT OR IGNORE INTO projection_meta(project_id, stream_id, applied_sequence, projection_revision, updated_at)
                  VALUES(?1, ?2, 0, 0, ?3)",
            params![
                project_id,
                format!("stream_{}", Uuid::new_v4()),
                "1970-01-01T00:00:00.000Z"
            ],
        )
        .map_err(|error| sqlite_error("initialize durable project stream", error))?;
    recover_interrupted_native_lifetime(&transaction)?;
    transaction
        .commit()
        .map_err(|error| sqlite_error("commit durable project initialization", error))?;
    require_registered_project_identity(connection, project_id)?;
    snapshot_from_connection(connection, project_id)
}

fn require_existing_project_connection(
    connection: &mut Connection,
    project_id: &str,
) -> AppResult<ProjectionSnapshot> {
    require_registered_project_identity(connection, project_id)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| sqlite_error("begin durable project recovery", error))?;
    recover_interrupted_native_lifetime(&transaction)?;
    transaction
        .commit()
        .map_err(|error| sqlite_error("commit durable project recovery", error))?;
    snapshot_from_connection(connection, project_id)
}

fn recover_interrupted_native_lifetime(transaction: &Transaction<'_>) -> AppResult<()> {
    // An in-flight mutation can survive only when the prior native
    // lifetime ended before the provider acknowledgement became durable.
    // Opening a project for a new native lifetime is the recovery
    // boundary, so preserve the claim but make the uncertainty explicit.
    transaction
        .execute(
            "UPDATE turns SET mutation_phase = 'outcome_unknown'
                  WHERE mutation_phase = 'in_flight'",
            [],
        )
        .map_err(|error| sqlite_error("recover in-flight turn mutations", error))?;
    transaction
        .execute(
            "UPDATE pending_requests SET response_phase = 'outcome_unknown'
                  WHERE response_phase = 'in_flight'",
            [],
        )
        .map_err(|error| sqlite_error("recover in-flight approval responses", error))?;
    Ok(())
}

impl ProjectionService {
    pub fn claim_turn_mutation(
        &self,
        project_id: &str,
        thread_id: &str,
        turn_id: &str,
        kind: TurnMutationKind,
        identity: &str,
    ) -> AppResult<TurnMutationClaimResult> {
        let _operation = self.write_operation()?;
        validate_id(project_id, "projectId")?;
        validate_id(thread_id, "threadId")?;
        validate_id(turn_id, "turnId")?;
        validate_id(identity, "turnMutationIdentity")?;
        let mut connection = self.connection(project_id)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| sqlite_error("begin exact-turn mutation claim", error))?;
        let row: Option<(String, Option<String>, Option<String>, Option<String>)> = transaction
            .query_row(
                "SELECT state, mutation_kind, mutation_identity, mutation_phase
                 FROM turns WHERE thread_id = ?1 AND turn_id = ?2",
                params![thread_id, turn_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()
            .map_err(|error| sqlite_error("read exact-turn mutation claim", error))?;
        let Some((state, existing_kind, existing_identity, existing_phase)) = row else {
            return Err(projection_error(
                "runtime_turn_not_projection_owned",
                "This action is allowed only for a currently projected provider turn",
            ));
        };
        if !matches!(state.as_str(), "accepted" | "in_progress" | "interrupting") {
            return Err(projection_error(
                "runtime_turn_not_projection_owned",
                "This action is allowed only for a currently active provider turn",
            ));
        }
        match (&existing_kind, &existing_identity, &existing_phase) {
            (None, None, None) => {
                transaction
                    .execute(
                        "UPDATE turns
                         SET mutation_kind = ?3, mutation_identity = ?4, mutation_phase = 'in_flight'
                         WHERE thread_id = ?1 AND turn_id = ?2
                           AND mutation_kind IS NULL AND mutation_identity IS NULL AND mutation_phase IS NULL",
                        params![thread_id, turn_id, kind.as_str(), identity],
                    )
                    .map_err(|error| sqlite_error("persist exact-turn mutation claim", error))?;
                transaction
                    .commit()
                    .map_err(|error| sqlite_error("commit exact-turn mutation claim", error))?;
                Ok(TurnMutationClaimResult::Acquired)
            }
            (Some(existing_kind), Some(existing_identity), Some(existing_phase)) => {
                if existing_phase == "in_flight" || existing_phase == "outcome_unknown" {
                    if existing_phase == "in_flight" {
                        transaction
                            .execute(
                                "UPDATE turns SET mutation_phase = 'outcome_unknown'
                                 WHERE thread_id = ?1 AND turn_id = ?2
                                   AND mutation_kind = ?3 AND mutation_identity = ?4
                                   AND mutation_phase = 'in_flight'",
                                params![thread_id, turn_id, existing_kind, existing_identity],
                            )
                            .map_err(|error| {
                                sqlite_error("preserve uncertain exact-turn mutation", error)
                            })?;
                        transaction.commit().map_err(|error| {
                            sqlite_error("commit uncertain exact-turn mutation", error)
                        })?;
                    }
                    return Err(projection_error(
                        "runtime_turn_mutation_outcome_unknown",
                        "A prior mutation of this exact turn has an unknown outcome; wait for terminal projection truth before retrying",
                    )
                    .outcome_unknown(true));
                }
                if existing_phase != "accepted" {
                    return Err(projection_error(
                        "runtime_turn_mutation_state_invalid",
                        "The durable exact-turn mutation phase is invalid",
                    )
                    .outcome_unknown(true));
                }
                if existing_kind == kind.as_str() && existing_identity == identity {
                    return Ok(TurnMutationClaimResult::Duplicate);
                }
                let (code, message) = match (existing_kind.as_str(), kind) {
                    ("stop", TurnMutationKind::Steer) => (
                        "runtime_turn_not_steerable",
                        "A turn cannot be steered after Stop has been accepted",
                    ),
                    ("steer", TurnMutationKind::Stop) => (
                        "runtime_turn_not_interruptible",
                        "A turn cannot be stopped after Steer has been accepted",
                    ),
                    ("steer", TurnMutationKind::Steer) => (
                        "runtime_turn_steer_identity_mismatch",
                        "An exact turn cannot be steered again with a different identity or content",
                    ),
                    _ => (
                        "runtime_turn_mutation_identity_mismatch",
                        "The exact-turn mutation identity changed after it was accepted",
                    ),
                };
                Err(projection_error(code, message))
            }
            _ => Err(projection_error(
                "runtime_turn_mutation_state_invalid",
                "The durable exact-turn mutation claim is incomplete",
            )
            .outcome_unknown(true)),
        }
    }

    pub fn mark_turn_mutation_accepted(
        &self,
        project_id: &str,
        thread_id: &str,
        turn_id: &str,
        identity: &str,
    ) -> AppResult<()> {
        self.transition_turn_mutation(project_id, thread_id, turn_id, identity, Some("accepted"))
    }

    pub fn mark_turn_mutation_outcome_unknown(
        &self,
        project_id: &str,
        thread_id: &str,
        turn_id: &str,
        identity: &str,
    ) -> AppResult<()> {
        self.transition_turn_mutation(
            project_id,
            thread_id,
            turn_id,
            identity,
            Some("outcome_unknown"),
        )
    }

    pub fn release_turn_mutation(
        &self,
        project_id: &str,
        thread_id: &str,
        turn_id: &str,
        identity: &str,
    ) -> AppResult<()> {
        self.transition_turn_mutation(project_id, thread_id, turn_id, identity, None)
    }

    fn transition_turn_mutation(
        &self,
        project_id: &str,
        thread_id: &str,
        turn_id: &str,
        identity: &str,
        next_phase: Option<&str>,
    ) -> AppResult<()> {
        let _operation = self.write_operation()?;
        validate_id(project_id, "projectId")?;
        validate_id(thread_id, "threadId")?;
        validate_id(turn_id, "turnId")?;
        validate_id(identity, "turnMutationIdentity")?;
        let mut connection = self.connection(project_id)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| sqlite_error("begin exact-turn mutation transition", error))?;
        let row: Option<(String, Option<String>, Option<String>)> = transaction
            .query_row(
                "SELECT state, mutation_identity, mutation_phase
                 FROM turns WHERE thread_id = ?1 AND turn_id = ?2",
                params![thread_id, turn_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|error| sqlite_error("read exact-turn mutation transition", error))?;
        let Some((state, existing_identity, existing_phase)) = row else {
            return Err(projection_error(
                "runtime_turn_mutation_claim_lost",
                "The durable exact-turn mutation claim no longer exists",
            )
            .outcome_unknown(true));
        };
        if is_terminal_turn_state(&state) && existing_identity.is_none() && existing_phase.is_none()
        {
            return Ok(());
        }
        if existing_identity.as_deref() != Some(identity) {
            return Err(projection_error(
                "runtime_turn_mutation_claim_lost",
                "The durable exact-turn mutation identity changed before acknowledgement",
            )
            .outcome_unknown(true));
        }
        if existing_phase.as_deref() == next_phase {
            return Ok(());
        }
        if existing_phase.as_deref() != Some("in_flight") {
            return Err(projection_error(
                "runtime_turn_mutation_claim_lost",
                "The durable exact-turn mutation phase changed before acknowledgement",
            )
            .outcome_unknown(true));
        }
        if let Some(next_phase) = next_phase {
            transaction
                .execute(
                    "UPDATE turns SET mutation_phase = ?4
                     WHERE thread_id = ?1 AND turn_id = ?2
                       AND mutation_identity = ?3 AND mutation_phase = 'in_flight'",
                    params![thread_id, turn_id, identity, next_phase],
                )
                .map_err(|error| sqlite_error("advance exact-turn mutation phase", error))?;
        } else {
            transaction
                .execute(
                    "UPDATE turns
                     SET mutation_kind = NULL, mutation_identity = NULL, mutation_phase = NULL
                     WHERE thread_id = ?1 AND turn_id = ?2
                       AND mutation_identity = ?3 AND mutation_phase = 'in_flight'",
                    params![thread_id, turn_id, identity],
                )
                .map_err(|error| sqlite_error("release exact-turn mutation claim", error))?;
        }
        transaction
            .commit()
            .map_err(|error| sqlite_error("commit exact-turn mutation transition", error))
    }

    pub fn claim_approval_response(
        &self,
        project_id: &str,
        runtime_connection_id: &str,
        current_provider_connection_id: &str,
        request_key: &str,
        decision: &str,
    ) -> AppResult<ApprovalResponseClaimResult> {
        let _operation = self.write_operation()?;
        for (value, field) in [
            (project_id, "projectId"),
            (runtime_connection_id, "runtimeConnectionId"),
            (
                current_provider_connection_id,
                "currentProviderConnectionId",
            ),
            (request_key, "requestKey"),
        ] {
            validate_id(value, field)?;
        }
        validate_text(decision, "approval.decision")?;
        if !is_supported_desktop_approval_decision(decision) {
            return Err(projection_error(
                "runtime_approval_decision_unsupported",
                "This approval decision requires a structured payload that Desktop does not support yet",
            ));
        }
        let mut connection = self.connection(project_id)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| sqlite_error("begin exact approval response claim", error))?;
        let row: Option<(
            String,
            Option<String>,
            Option<String>,
            String,
            Option<String>,
            String,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
        )> = transaction
            .query_row(
                "SELECT status, thread_id, turn_id, request_kind, method,
                        response_options_json, runtime_connection_id, provider_connection_id,
                        provider_request_id, requested_effect_kind,
                        response_identity, response_decision, response_phase
                 FROM pending_requests WHERE request_key = ?1",
                [request_key],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                        row.get(7)?,
                        row.get(8)?,
                        row.get(9)?,
                        row.get(10)?,
                        row.get(11)?,
                        row.get(12)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| sqlite_error("read exact approval response claim", error))?;
        let Some((
            status,
            stored_thread_id,
            stored_turn_id,
            request_kind,
            stored_method,
            options_json,
            stored_runtime_connection_id,
            provider_connection_id,
            provider_request_id,
            requested_effect_kind,
            existing_identity,
            existing_decision,
            existing_phase,
        )) = row
        else {
            return Err(projection_error(
                "runtime_approval_not_projection_owned",
                "This approval is not owned by the current durable projection",
            ));
        };
        if request_kind != "attention.approval_requested" {
            return Err(projection_error(
                "runtime_approval_binding_mismatch",
                "The approval response does not match its projected provider request",
            ));
        }
        let stored_thread_id = stored_thread_id.ok_or_else(|| {
            projection_error(
                "runtime_approval_binding_mismatch",
                "The approval response has no exact projected thread binding",
            )
        })?;
        let stored_turn_id = stored_turn_id.ok_or_else(|| {
            projection_error(
                "runtime_approval_binding_mismatch",
                "The approval response has no exact projected turn binding",
            )
        })?;
        let stored_method = stored_method.ok_or_else(|| {
            projection_error(
                "runtime_approval_binding_mismatch",
                "The approval response has no exact provider method binding",
            )
        })?;
        if !approval_method_matches_effect(
            Some(stored_method.as_str()),
            requested_effect_kind.as_deref(),
        ) {
            return Err(projection_error(
                "runtime_approval_effect_unsupported",
                "This approval method and effect cannot be answered from Desktop yet",
            ));
        }
        let requested_effect_kind = requested_effect_kind
            .expect("an approved method/effect pair has a requested effect kind");
        if stored_runtime_connection_id.as_deref() != Some(runtime_connection_id) {
            return Err(projection_error(
                "runtime_approval_stale_after_restart",
                "This approval belongs to a prior runtime connection and cannot be answered",
            ));
        }
        let provider_connection_id = provider_connection_id.ok_or_else(|| {
            projection_error(
                "runtime_approval_provider_connection_missing",
                "The approval has no exact live provider connection binding",
            )
        })?;
        if provider_connection_id != current_provider_connection_id {
            return Err(projection_error(
                "runtime_approval_stale_after_provider_reconnect",
                "This approval belongs to a prior provider connection and cannot be answered",
            ));
        }
        let provider_request_id = provider_request_id.ok_or_else(|| {
            projection_error(
                "runtime_approval_provider_request_missing",
                "The approval has no exact Provider request binding",
            )
        })?;
        let options: Vec<String> = serde_json::from_str(&options_json)
            .map_err(|error| projection_error("projection_request_invalid", error.to_string()))?;
        if !options.iter().any(|option| option == decision) {
            return Err(projection_error(
                "runtime_approval_decision_invalid",
                "The approval decision is not offered by the provider request",
            ));
        }
        let identity_material = serde_json::json!({
            "projectId": project_id,
            "runtimeConnectionId": runtime_connection_id,
            "providerConnectionId": current_provider_connection_id,
            "requestKey": request_key,
            "method": stored_method.as_str(),
            "requestedEffectKind": requested_effect_kind.as_str(),
            "threadId": stored_thread_id.as_str(),
            "turnId": stored_turn_id.as_str(),
            "decision": decision,
        });
        let identity = hex::encode(Sha256::digest(
            serde_json::to_vec(&identity_material).map_err(|error| {
                projection_error("projection_request_invalid", error.to_string())
            })?,
        ));
        match (existing_identity, existing_decision, existing_phase) {
            (None, None, None) if status == "pending" => {
                let changed = transaction
                    .execute(
                        "UPDATE pending_requests
                         SET response_identity = ?2, response_decision = ?3,
                             response_phase = 'in_flight'
                         WHERE request_key = ?1 AND status = 'pending'
                           AND response_identity IS NULL AND response_decision IS NULL
                           AND response_phase IS NULL
                           AND request_kind = 'attention.approval_requested'
                           AND runtime_connection_id = ?4
                           AND provider_connection_id = ?5
                           AND provider_request_id = ?6
                           AND method = ?7 AND requested_effect_kind = ?8
                           AND thread_id = ?9 AND turn_id = ?10",
                        params![
                            request_key,
                            identity,
                            decision,
                            runtime_connection_id,
                            current_provider_connection_id,
                            provider_request_id,
                            stored_method,
                            requested_effect_kind,
                            stored_thread_id,
                            stored_turn_id,
                        ],
                    )
                    .map_err(|error| {
                        sqlite_error("persist exact approval response claim", error)
                    })?;
                if changed != 1 {
                    return Err(projection_error(
                        "runtime_approval_claim_raced",
                        "The approval response was claimed concurrently",
                    )
                    .outcome_unknown(true));
                }
                transaction
                    .commit()
                    .map_err(|error| sqlite_error("commit exact approval response claim", error))?;
                Ok(ApprovalResponseClaimResult::Acquired(
                    ApprovalResponseClaim {
                        identity,
                        provider_connection_id: current_provider_connection_id.to_owned(),
                        provider_request_id,
                    },
                ))
            }
            (Some(existing_identity), Some(existing_decision), Some(existing_phase)) => {
                if existing_phase == "accepted"
                    && existing_identity == identity
                    && existing_decision == decision
                {
                    return Ok(ApprovalResponseClaimResult::Duplicate {
                        decision: existing_decision,
                    });
                }
                if existing_phase == "in_flight"
                    && existing_identity == identity
                    && existing_decision == decision
                {
                    return Err(projection_error(
                        "runtime_approval_response_in_progress",
                        "This exact approval response is already being sent",
                    ));
                }
                if existing_phase == "in_flight" {
                    return Err(projection_error(
                        "runtime_approval_response_conflict",
                        "This approval is already being answered with a different decision",
                    ));
                }
                if existing_phase == "outcome_unknown" {
                    return Err(projection_error(
                        "runtime_approval_response_outcome_unknown",
                        "A prior response may have reached the provider; wait for projection truth",
                    )
                    .outcome_unknown(true));
                }
                Err(projection_error(
                    "runtime_approval_already_answered",
                    "This approval was already answered with a different exact decision",
                ))
            }
            _ if status == "resolved" => Err(projection_error(
                "runtime_approval_not_pending",
                "This approval is already resolved",
            )),
            _ => Err(projection_error(
                "runtime_approval_claim_invalid",
                "The durable approval response claim is incomplete",
            )
            .outcome_unknown(true)),
        }
    }

    pub fn mark_approval_response_accepted(
        &self,
        project_id: &str,
        request_key: &str,
        identity: &str,
        decision: &str,
    ) -> AppResult<()> {
        self.transition_approval_response(
            project_id,
            request_key,
            identity,
            decision,
            Some("accepted"),
        )
    }

    pub fn mark_approval_response_outcome_unknown(
        &self,
        project_id: &str,
        request_key: &str,
        identity: &str,
        decision: &str,
    ) -> AppResult<()> {
        self.transition_approval_response(
            project_id,
            request_key,
            identity,
            decision,
            Some("outcome_unknown"),
        )
    }

    pub fn release_approval_response(
        &self,
        project_id: &str,
        request_key: &str,
        identity: &str,
        decision: &str,
    ) -> AppResult<()> {
        self.transition_approval_response(project_id, request_key, identity, decision, None)
    }

    fn transition_approval_response(
        &self,
        project_id: &str,
        request_key: &str,
        identity: &str,
        decision: &str,
        next_phase: Option<&str>,
    ) -> AppResult<()> {
        let _operation = self.write_operation()?;
        validate_id(project_id, "projectId")?;
        validate_id(request_key, "requestKey")?;
        validate_id(identity, "approvalResponseIdentity")?;
        validate_text(decision, "approval.decision")?;
        let mut connection = self.connection(project_id)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| sqlite_error("begin exact approval response transition", error))?;
        let row: Option<(String, Option<String>, Option<String>, Option<String>)> = transaction
            .query_row(
                "SELECT status, response_identity, response_decision, response_phase
                 FROM pending_requests WHERE request_key = ?1",
                [request_key],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()
            .map_err(|error| sqlite_error("read exact approval response transition", error))?;
        let Some((_status, stored_identity, stored_decision, stored_phase)) = row else {
            return Err(projection_error(
                "runtime_approval_claim_lost",
                "The durable approval response claim no longer exists",
            )
            .outcome_unknown(true));
        };
        if stored_identity.as_deref() != Some(identity)
            || stored_decision.as_deref() != Some(decision)
        {
            return Err(projection_error(
                "runtime_approval_claim_lost",
                "The durable approval response identity changed before acknowledgement",
            )
            .outcome_unknown(true));
        }
        if stored_phase.as_deref() == next_phase {
            return Ok(());
        }
        if stored_phase.as_deref() != Some("in_flight") {
            return Err(projection_error(
                "runtime_approval_claim_lost",
                "The durable approval response phase changed before acknowledgement",
            )
            .outcome_unknown(true));
        }
        let changed = if let Some(next_phase) = next_phase {
            transaction
                .execute(
                    "UPDATE pending_requests
                     SET response_phase = ?4,
                         status = CASE WHEN ?4 = 'accepted' THEN 'resolved' ELSE status END,
                         resolved_at = CASE WHEN ?4 = 'accepted' THEN COALESCE(resolved_at, CURRENT_TIMESTAMP) ELSE resolved_at END
                     WHERE request_key = ?1 AND response_identity = ?2
                       AND response_decision = ?3 AND response_phase = 'in_flight'",
                    params![request_key, identity, decision, next_phase],
                )
                .map_err(|error| sqlite_error("advance exact approval response phase", error))?
        } else {
            transaction
                .execute(
                    "UPDATE pending_requests
                     SET response_identity = NULL, response_decision = NULL, response_phase = NULL
                     WHERE request_key = ?1 AND response_identity = ?2
                       AND response_decision = ?3 AND response_phase = 'in_flight'",
                    params![request_key, identity, decision],
                )
                .map_err(|error| sqlite_error("release exact approval response claim", error))?
        };
        if changed != 1 {
            return Err(projection_error(
                "runtime_approval_claim_lost",
                "The durable approval response transition lost its exact row",
            )
            .outcome_unknown(true));
        }
        transaction
            .commit()
            .map_err(|error| sqlite_error("commit exact approval response transition", error))
    }

    pub fn refresh_provider_pages(
        &self,
        project_id: &str,
        provider_connection_id: &str,
        pages: &[ProviderPage],
    ) -> AppResult<(ProjectionSnapshot, usize)> {
        let _operation = self.write_operation()?;
        validate_id(project_id, "projectId")?;
        validate_id(provider_connection_id, "providerConnectionId")?;
        if pages.len() > 10_000 {
            return Err(projection_error(
                "projection_provider_refresh_too_large",
                "Provider refresh exceeds its bounded page limit",
            ));
        }
        let mut connection = self.connection(project_id)?;
        require_registered_project_identity(&connection, project_id)?;
        let mut changed = 0usize;
        for page in pages {
            changed += apply_provider_page_to_connection(&mut connection, project_id, page)?;
        }
        connection.execute(
            "INSERT OR REPLACE INTO provider_backfill_state(project_id, provider_connection_id, completed_at, page_count)
             VALUES(?1, ?2, ?3, ?4)",
            params![project_id, provider_connection_id, "1970-01-01T00:00:00.000Z", pages.len() as i64],
        ).map_err(|error| sqlite_error("mark provider refresh complete", error))?;
        Ok((snapshot_from_connection(&connection, project_id)?, changed))
    }

    pub fn provider_backfill_required(
        &self,
        project_id: &str,
        provider_connection_id: &str,
    ) -> AppResult<bool> {
        let _operation = self.read_operation()?;
        validate_id(project_id, "projectId")?;
        validate_id(provider_connection_id, "providerConnectionId")?;
        let connection = self.read_connection(project_id)?;
        require_registered_project_identity(&connection, project_id)?;
        let completed: Option<String> = connection
            .query_row(
                "SELECT provider_connection_id FROM provider_backfill_state WHERE project_id = ?1",
                [project_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| sqlite_error("read provider backfill state", error))?;
        Ok(completed.as_deref() != Some(provider_connection_id))
    }

    pub(crate) fn require_provider_project_identity(&self, project_id: &str) -> AppResult<()> {
        let _operation = self.read_operation()?;
        validate_id(project_id, "projectId")?;
        let connection = self.read_connection(project_id)?;
        require_registered_project_identity(&connection, project_id)
    }

    #[cfg(test)]
    pub fn snapshot(&self, project_id: &str) -> AppResult<ProjectionSnapshot> {
        let _operation = self.read_operation()?;
        let connection = self.read_connection(project_id)?;
        snapshot_from_connection(&connection, project_id)
    }

    pub fn history_index(
        &self,
        input: &ProjectionHistoryIndexInput,
    ) -> AppResult<ProjectionHistoryIndexPage> {
        let _operation = self.read_operation()?;
        validate_schema(input.schema_version)?;
        validate_id(&input.project_id, "projectId")?;
        if let Some(cursor) = input.cursor.as_ref() {
            validate_timestamp(&cursor.before_updated_at, "cursor.beforeUpdatedAt")?;
            validate_id(&cursor.before_message_id, "cursor.beforeMessageId")?;
        }
        let limit = validate_limit(input.limit)?;
        let connection = self.read_connection(&input.project_id)?;
        query_history_index(&connection, &input.project_id, input.cursor.as_ref(), limit)
    }

    pub fn history_page(
        &self,
        input: &ProjectionHistoryPageInput,
    ) -> AppResult<ProjectionHistoryPage> {
        let _operation = self.read_operation()?;
        validate_schema(input.schema_version)?;
        validate_id(&input.project_id, "projectId")?;
        validate_id(&input.target_agent_id, "targetAgentId")?;
        if let Some(cursor) = input.cursor.as_ref() {
            validate_timestamp(&cursor.before_created_at, "cursor.beforeCreatedAt")?;
            validate_id(&cursor.before_message_id, "cursor.beforeMessageId")?;
        }
        let limit = validate_limit(input.limit)?;
        let query = input
            .query
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        if let Some(query) = query {
            validate_text(query, "query")?;
        }
        let connection = self.read_connection(&input.project_id)?;
        let page = match query {
            Some(query) => search_agent_messages(
                &connection,
                &input.target_agent_id,
                query,
                input.cursor.as_ref(),
                limit,
            )?,
            None => query_agent_page(
                &connection,
                &input.target_agent_id,
                input.cursor.as_ref(),
                limit,
            )?,
        };
        Ok(ProjectionHistoryPage {
            project_id: input.project_id.clone(),
            target_agent_id: input.target_agent_id.clone(),
            query: query.map(str::to_owned),
            items: page.items,
            next_cursor: page.next_cursor,
        })
    }

    pub fn conversation(
        &self,
        input: &ProjectionConversationInput,
    ) -> AppResult<ProjectionConversationSnapshot> {
        self.conversation_for_runtime(input, None, None)
    }

    pub(crate) fn conversation_for_runtime(
        &self,
        input: &ProjectionConversationInput,
        current_runtime_generation: Option<&str>,
        current_provider_connection_id: Option<&str>,
    ) -> AppResult<ProjectionConversationSnapshot> {
        let _operation = self.read_operation()?;
        validate_schema(input.schema_version)?;
        validate_id(&input.project_id, "projectId")?;
        validate_id(&input.target_agent_id, "targetAgentId")?;
        validate_optional_id(input.expected_stream_id.as_deref(), "expectedStreamId")?;
        if input.after_journal_sequence < 0 {
            return Err(projection_error(
                "projection_input_invalid",
                "afterJournalSequence must be non-negative",
            ));
        }
        if input.expected_projection_revision < 0 {
            return Err(projection_error(
                "projection_input_invalid",
                "expectedProjectionRevision must be non-negative",
            ));
        }
        if let Some(cursor) = input.cursor.as_ref() {
            validate_timestamp(&cursor.before_created_at, "cursor.beforeCreatedAt")?;
            validate_id(&cursor.before_message_id, "cursor.beforeMessageId")?;
        }
        if let Some(cursor) = input.activity_cursor.as_ref() {
            validate_timestamp(&cursor.before_created_at, "activityCursor.beforeCreatedAt")?;
            validate_id(
                &cursor.before_activity_id,
                "activityCursor.beforeActivityId",
            )?;
        }
        if let Some(cursor) = input.pending_request_cursor.as_deref() {
            validate_text(cursor, "pendingRequestCursor")?;
        }
        let limit = validate_limit(input.limit)?;
        let connection = self.read_connection(&input.project_id)?;
        let snapshot = snapshot_from_connection(&connection, &input.project_id)?;
        let sync_state = match (
            input.expected_stream_id.as_deref(),
            snapshot.stream_id.as_deref(),
        ) {
            (Some(expected), Some(actual)) if expected != actual => "stream_reset",
            (Some(_), None) => "stream_reset",
            _ if input.after_journal_sequence > snapshot.applied_journal_sequence => "gap",
            _ if input.expected_projection_revision > snapshot.projection_revision => "gap",
            _ if input.expected_stream_id.is_some()
                && (input.after_journal_sequence < snapshot.applied_journal_sequence
                    || input.expected_projection_revision < snapshot.projection_revision) =>
            {
                "advanced"
            }
            _ => "current",
        };
        if sync_state == "stream_reset" || sync_state == "gap" {
            return Ok(ProjectionConversationSnapshot {
                project_id: input.project_id.clone(),
                target_agent_id: input.target_agent_id.clone(),
                stream_id: snapshot.stream_id,
                applied_journal_sequence: snapshot.applied_journal_sequence,
                projection_revision: snapshot.projection_revision,
                sync_state: sync_state.into(),
                items: Vec::new(),
                streaming_items: Vec::new(),
                activities: Vec::new(),
                active_turns: Vec::new(),
                latest_turn: None,
                older_cursor: None,
                activity_older_cursor: None,
                pending_request_older_cursor: None,
                pending_requests: Vec::new(),
                resolved_requests: Vec::new(),
            });
        }
        let is_older_page = input.cursor.is_some()
            || input.activity_cursor.is_some()
            || input.pending_request_cursor.is_some();
        let page = if is_older_page && input.cursor.is_none() {
            ProjectionPage {
                items: Vec::new(),
                next_cursor: None,
            }
        } else {
            query_agent_page(
                &connection,
                &input.target_agent_id,
                input.cursor.as_ref(),
                limit,
            )?
        };
        let mut activity_page = if is_older_page && input.activity_cursor.is_none() {
            ProjectedActivityPage {
                items: Vec::new(),
                next_cursor: None,
            }
        } else {
            query_agent_activity_page(
                &connection,
                &input.target_agent_id,
                input.activity_cursor.as_ref(),
                limit,
            )?
        };
        if sync_state == "advanced" && !is_older_page {
            let changed = match query_agent_activity_updates(
                &connection,
                &input.target_agent_id,
                input.after_journal_sequence,
                limit,
            )? {
                Some(items) => items,
                None => {
                    return Ok(ProjectionConversationSnapshot {
                        project_id: input.project_id.clone(),
                        target_agent_id: input.target_agent_id.clone(),
                        stream_id: snapshot.stream_id,
                        applied_journal_sequence: snapshot.applied_journal_sequence,
                        projection_revision: snapshot.projection_revision,
                        sync_state: "gap".into(),
                        items: Vec::new(),
                        streaming_items: Vec::new(),
                        activities: Vec::new(),
                        active_turns: Vec::new(),
                        latest_turn: None,
                        older_cursor: None,
                        activity_older_cursor: None,
                        pending_request_older_cursor: None,
                        pending_requests: Vec::new(),
                        resolved_requests: Vec::new(),
                    });
                }
            };
            let mut by_id = BTreeMap::new();
            for activity in changed {
                by_id.insert(activity.activity_id.clone(), activity);
            }
            for activity in activity_page.items {
                by_id.insert(activity.activity_id.clone(), activity);
            }
            if by_id.len() > limit {
                return Ok(ProjectionConversationSnapshot {
                    project_id: input.project_id.clone(),
                    target_agent_id: input.target_agent_id.clone(),
                    stream_id: snapshot.stream_id,
                    applied_journal_sequence: snapshot.applied_journal_sequence,
                    projection_revision: snapshot.projection_revision,
                    sync_state: "gap".into(),
                    items: Vec::new(),
                    streaming_items: Vec::new(),
                    activities: Vec::new(),
                    active_turns: Vec::new(),
                    latest_turn: None,
                    older_cursor: None,
                    activity_older_cursor: None,
                    pending_request_older_cursor: None,
                    pending_requests: Vec::new(),
                    resolved_requests: Vec::new(),
                });
            }
            activity_page.items = by_id.into_values().collect();
            activity_page.items.sort_by(|left, right| {
                left.created_at
                    .cmp(&right.created_at)
                    .then(left.last_journal_sequence.cmp(&right.last_journal_sequence))
                    .then(left.activity_id.cmp(&right.activity_id))
            });
        }
        let pending_page = if is_older_page && input.pending_request_cursor.is_none() {
            PendingRequestPage {
                items: Vec::new(),
                next_cursor: None,
            }
        } else {
            query_pending_requests(
                &connection,
                MAX_PAGE_SIZE as usize,
                current_runtime_generation,
                current_provider_connection_id,
                input.pending_request_cursor.as_deref(),
            )?
        };
        let resolved_requests = query_resolved_requests(&connection, MAX_PAGE_SIZE as usize)?;
        let streaming_items = query_streaming_messages(&connection, &input.target_agent_id)?;
        let active_turns = query_active_turns(&connection, &input.target_agent_id)?;
        let latest_turn = query_latest_turn(&connection, &input.target_agent_id)?;
        Ok(ProjectionConversationSnapshot {
            project_id: input.project_id.clone(),
            target_agent_id: input.target_agent_id.clone(),
            stream_id: snapshot.stream_id,
            applied_journal_sequence: snapshot.applied_journal_sequence,
            projection_revision: snapshot.projection_revision,
            sync_state: sync_state.into(),
            items: page.items,
            streaming_items,
            activities: activity_page.items,
            active_turns,
            latest_turn,
            older_cursor: page.next_cursor,
            activity_older_cursor: activity_page.next_cursor,
            pending_request_older_cursor: pending_page.next_cursor,
            pending_requests: pending_page.items,
            resolved_requests,
        })
    }

    /// Reads only the durable, exact turn identity needed by Native attachment
    /// recovery. This does not infer terminal state from a latest-turn summary:
    /// project, agent, thread, and turn must all match the same SQLite row.
    pub(crate) fn terminal_turn_state(
        &self,
        project_id: &str,
        target_agent_id: &str,
        thread_id: &str,
        turn_id: &str,
    ) -> AppResult<Option<String>> {
        let _operation = self.read_operation()?;
        validate_id(project_id, "projectId")?;
        validate_id(target_agent_id, "targetAgentId")?;
        validate_id(thread_id, "threadId")?;
        validate_id(turn_id, "turnId")?;
        let connection = self.read_connection(project_id)?;
        let state = connection
            .query_row(
                "SELECT t.state
                 FROM turns t
                 WHERE t.thread_id = ?1 AND t.turn_id = ?2
                   AND EXISTS (
                     SELECT 1 FROM events e
                     WHERE e.thread_id = t.thread_id AND e.turn_id = t.turn_id
                       AND e.agent_id = ?3
                   )
                 LIMIT 1",
                params![thread_id, turn_id, target_agent_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| sqlite_error("read exact terminal turn", error))?;
        Ok(state.filter(|value| is_terminal_turn_state(value)))
    }
}

fn open_database_for_initialization(
    path: &Path,
    project_id: &str,
    verify: bool,
) -> AppResult<Connection> {
    validate_database_artifacts(path)?;
    let existed = path.exists();
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| sqlite_error("initialize projection database", error))?;
    configure_initialization_database(path, connection, project_id, verify, existed)
}

fn open_existing_database(path: &Path, project_id: &str, _verify: bool) -> AppResult<Connection> {
    validate_database_artifacts(path)?;
    let connection = match Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) {
        Ok(connection) => connection,
        Err(_) if !path.exists() => {
            return Err(projection_error(
                "projection_database_missing",
                "Durable project SQLite is unavailable; the project is fail-closed until the database is restored or repaired",
            ));
        }
        Err(error) => return Err(sqlite_error("open existing projection database", error)),
    };
    configure_registered_database(path, connection, project_id)
}

fn configure_connection_durability(connection: &Connection) -> AppResult<()> {
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(|error| sqlite_error("enable projection foreign keys", error))?;
    connection
        .pragma_update(None, "synchronous", "FULL")
        .map_err(|error| sqlite_error("set projection durability", error))?;
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .map_err(|error| sqlite_error("set projection journal mode", error))?;
    Ok(())
}

fn configure_initialization_database(
    path: &Path,
    mut connection: Connection,
    project_id: &str,
    verify: bool,
    existed: bool,
) -> AppResult<Connection> {
    validate_database_artifacts(path)?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|error| sqlite_error("set projection busy timeout", error))?;
    if existed {
        verify_integrity(&connection)?;
        admit_pending_project_initialization(&connection, project_id)?;
    }
    migrate(&mut connection)?;
    if verify {
        verify_integrity(&connection)?;
    }
    configure_connection_durability(&connection)?;
    Ok(connection)
}

fn configure_registered_database(
    path: &Path,
    mut connection: Connection,
    project_id: &str,
) -> AppResult<Connection> {
    validate_database_artifacts(path)?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|error| sqlite_error("set projection busy timeout", error))?;
    verify_integrity(&connection)?;
    require_registered_project_identity(&connection, project_id)?;
    migrate(&mut connection)?;
    verify_integrity(&connection)?;
    require_registered_project_identity(&connection, project_id)?;
    configure_connection_durability(&connection)?;
    Ok(connection)
}

fn projection_meta_table_exists(connection: &Connection) -> AppResult<bool> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'projection_meta')",
            [],
            |row| row.get(0),
        )
        .map_err(|error| sqlite_error("inspect durable project identity table", error))
}

fn project_identity_counts(connection: &Connection, project_id: &str) -> AppResult<(i64, i64)> {
    if !projection_meta_table_exists(connection)? {
        return Err(projection_error(
            "projection_database_invalid",
            "Durable project SQLite does not expose the registered project identity",
        ));
    }
    connection
        .query_row(
            "SELECT COUNT(*), COUNT(CASE WHEN project_id = ?1 THEN 1 END) FROM projection_meta",
            [project_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| {
            projection_error(
                "projection_database_invalid",
                "Durable project SQLite project identity table is invalid",
            )
        })
}

fn pending_database_has_no_owned_rows(connection: &Connection) -> AppResult<bool> {
    for table in [
        "events",
        "messages",
        "conversation_index",
        "turns",
        "items",
        "pending_requests",
        "provider_pages",
        "provider_backfill_state",
        "streaming_messages",
        "activities",
    ] {
        let exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
                [table],
                |row| row.get(0),
            )
            .map_err(|error| sqlite_error("inspect pending projection table", error))?;
        if exists {
            let occupied: bool = connection
                .query_row(
                    &format!("SELECT EXISTS(SELECT 1 FROM {table})"),
                    [],
                    |row| row.get(0),
                )
                .map_err(|error| sqlite_error("inspect pending projection ownership", error))?;
            if occupied {
                return Ok(false);
            }
        }
    }
    Ok(true)
}

fn admit_pending_project_initialization(
    connection: &Connection,
    project_id: &str,
) -> AppResult<()> {
    if projection_meta_table_exists(connection)? {
        let (identities, exact) = project_identity_counts(connection, project_id)?;
        if identities == 1 && exact == 1 {
            return Ok(());
        }
        if identities > 0 {
            return Err(projection_error(
                "projection_database_invalid",
                "Pending project SQLite belongs to another or ambiguous project identity",
            ));
        }
        let version: u32 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(|error| sqlite_error("inspect pending projection schema version", error))?;
        if version == 0
            || version > PROJECTION_DATABASE_SCHEMA_VERSION
            || !pending_database_has_no_owned_rows(connection)?
        {
            return Err(projection_error(
                "projection_database_invalid",
                "Pending project SQLite contains durable ownership without a project identity",
            ));
        }
        return Ok(());
    }
    let version: u32 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|error| sqlite_error("inspect pending projection schema version", error))?;
    let user_tables: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%')",
            [],
            |row| row.get(0),
        )
        .map_err(|error| sqlite_error("inspect pending projection tables", error))?;
    if version != 0 || user_tables {
        return Err(projection_error(
            "projection_database_invalid",
            "Pending project SQLite is not an empty or recognizable interrupted initialization",
        ));
    }
    Ok(())
}

fn require_registered_project_identity(connection: &Connection, project_id: &str) -> AppResult<()> {
    let (identities, exact) = project_identity_counts(connection, project_id)?;
    if identities != 1 || exact != 1 {
        return Err(projection_error(
            "projection_database_invalid",
            "Durable project SQLite does not contain one exact registered project identity",
        ));
    }
    Ok(())
}

fn table_has_column(connection: &Connection, table: &str, column: &str) -> AppResult<bool> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|error| sqlite_error("inspect projection table columns", error))?;
    let mut rows = statement
        .query([])
        .map_err(|error| sqlite_error("read projection table columns", error))?;
    while let Some(row) = rows
        .next()
        .map_err(|error| sqlite_error("scan projection table columns", error))?
    {
        let name: String = row
            .get(1)
            .map_err(|error| sqlite_error("decode projection table column", error))?;
        if name == column {
            return Ok(true);
        }
    }
    Ok(false)
}

fn migrate(connection: &mut Connection) -> AppResult<()> {
    let version: u32 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|error| sqlite_error("read projection schema version", error))?;
    if version > PROJECTION_DATABASE_SCHEMA_VERSION {
        return Err(projection_error("projection_schema_newer", format!("Projection schema {version} is newer than supported schema {PROJECTION_DATABASE_SCHEMA_VERSION}")));
    }
    if version == PROJECTION_DATABASE_SCHEMA_VERSION {
        return Ok(());
    }
    if version == 15 {
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| sqlite_error("begin projection v16 approval authority migration", error))?;
        for (column, definition) in [
            ("provider_request_id", "provider_request_id TEXT"),
            (
                "requested_effect_kind",
                "requested_effect_kind TEXT CHECK(requested_effect_kind IN ('file_change', 'command_execution', 'other'))",
            ),
        ] {
            if !table_has_column(&transaction, "pending_requests", column)? {
                transaction
                    .execute_batch(&format!(
                        "ALTER TABLE pending_requests ADD COLUMN {definition};"
                    ))
                    .map_err(|error| {
                        sqlite_error("add projection v16 approval authority column", error)
                    })?;
            }
        }
        transaction
            .execute_batch("PRAGMA user_version = 16;")
            .map_err(|error| sqlite_error("apply projection v16 approval authority migration", error))?;
        transaction
            .commit()
            .map_err(|error| sqlite_error("commit projection v16 approval authority migration", error))?;
        return migrate(connection);
    }
    if version == 14 {
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| {
                sqlite_error("begin projection v15 conversation index migration", error)
            })?;
        transaction
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS conversation_index (
                    target_agent_id TEXT PRIMARY KEY,
                    last_message_id TEXT NOT NULL UNIQUE,
                    updated_at TEXT NOT NULL,
                    preview TEXT NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS idx_conversation_index_page
                 ON conversation_index(updated_at DESC, last_message_id DESC);",
            )
            .map_err(|error| {
                sqlite_error("apply projection v15 conversation index migration", error)
            })?;
        {
            let mut select = transaction
                .prepare(
                    "SELECT target_agent_id, message_id, created_at, substr(text, 1, 160)
                     FROM messages WHERE target_agent_id IS NOT NULL
                     ORDER BY target_agent_id, created_at DESC, message_id DESC",
                )
                .map_err(|error| {
                    sqlite_error("prepare projection v15 conversation rebuild", error)
                })?;
            let mut insert = transaction
                .prepare(
                    "INSERT INTO conversation_index(target_agent_id, last_message_id, updated_at, preview)
                     VALUES(?1, ?2, ?3, ?4)
                     ON CONFLICT(target_agent_id) DO UPDATE SET
                       last_message_id = excluded.last_message_id,
                       updated_at = excluded.updated_at,
                       preview = excluded.preview",
                )
                .map_err(|error| sqlite_error("prepare projection v15 conversation insert", error))?;
            let mut rows = select.query([]).map_err(|error| {
                sqlite_error("query projection v15 conversation rebuild", error)
            })?;
            let mut previous_agent_id: Option<String> = None;
            while let Some(row) = rows
                .next()
                .map_err(|error| sqlite_error("read projection v15 conversation rebuild", error))?
            {
                let target_agent_id = row.get::<_, String>(0).map_err(|error| {
                    sqlite_error("read projection v15 conversation agent", error)
                })?;
                if previous_agent_id.as_deref() == Some(target_agent_id.as_str()) {
                    continue;
                }
                let message_id = row.get::<_, String>(1).map_err(|error| {
                    sqlite_error("read projection v15 conversation message", error)
                })?;
                let updated_at = row.get::<_, String>(2).map_err(|error| {
                    sqlite_error("read projection v15 conversation time", error)
                })?;
                let preview = row.get::<_, String>(3).map_err(|error| {
                    sqlite_error("read projection v15 conversation preview", error)
                })?;
                insert
                    .execute(params![target_agent_id, message_id, updated_at, preview])
                    .map_err(|error| {
                        sqlite_error("rebuild projection v15 conversation index", error)
                    })?;
                previous_agent_id = Some(target_agent_id);
            }
        }
        transaction
            .execute_batch("PRAGMA user_version = 15;")
            .map_err(|error| sqlite_error("finish projection v15 conversation index migration", error))?;
        transaction.commit().map_err(|error| {
            sqlite_error("commit projection v15 conversation index migration", error)
        })?;
        return migrate(connection);
    }
    if version == 13 {
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| {
                sqlite_error("begin projection v14 approval claim migration", error)
            })?;
        for (column, definition) in [
            ("runtime_connection_id", "runtime_connection_id TEXT"),
            ("provider_connection_id", "provider_connection_id TEXT"),
            ("response_identity", "response_identity TEXT"),
            ("response_decision", "response_decision TEXT"),
            (
                "response_phase",
                "response_phase TEXT CHECK(response_phase IN ('in_flight', 'accepted', 'outcome_unknown'))",
            ),
        ] {
            if !table_has_column(&transaction, "pending_requests", column)? {
                transaction
                    .execute_batch(&format!(
                        "ALTER TABLE pending_requests ADD COLUMN {definition};"
                    ))
                    .map_err(|error| {
                        sqlite_error("add projection v14 approval claim column", error)
                    })?;
            }
        }
        transaction
            .execute_batch("PRAGMA user_version = 14;")
            .map_err(|error| sqlite_error("apply projection v14 approval claim migration", error))?;
        transaction.commit().map_err(|error| {
            sqlite_error("commit projection v14 approval claim migration", error)
        })?;
        return migrate(connection);
    }
    if version == 12 {
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| sqlite_error("begin projection v13 turn mutation migration", error))?;
        for (column, definition) in [
            (
                "mutation_kind",
                "mutation_kind TEXT CHECK(mutation_kind IN ('stop', 'steer'))",
            ),
            ("mutation_identity", "mutation_identity TEXT"),
            (
                "mutation_phase",
                "mutation_phase TEXT CHECK(mutation_phase IN ('in_flight', 'accepted', 'outcome_unknown'))",
            ),
        ] {
            if !table_has_column(&transaction, "turns", column)? {
                transaction
                    .execute_batch(&format!("ALTER TABLE turns ADD COLUMN {definition};"))
                    .map_err(|error| {
                        sqlite_error("add projection v13 turn mutation column", error)
                    })?;
            }
        }
        transaction
            .execute_batch("PRAGMA user_version = 13;")
            .map_err(|error| sqlite_error("apply projection v13 turn mutation migration", error))?;
        transaction.commit().map_err(|error| {
            sqlite_error("commit projection v13 turn mutation migration", error)
        })?;
        return migrate(connection);
    }
    if version == 11 {
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| {
                sqlite_error("begin projection v12 activity state migration", error)
            })?;
        transaction.execute_batch(
            "DROP INDEX IF EXISTS idx_activities_target_page;
             DROP INDEX IF EXISTS idx_activities_turn_sequence;
             DROP INDEX IF EXISTS idx_activities_target_changes;
             ALTER TABLE activities RENAME TO activities_v11;
             CREATE TABLE activities (
                activity_id TEXT PRIMARY KEY,
                thread_id TEXT NOT NULL,
                turn_id TEXT NOT NULL,
                item_id TEXT,
                target_agent_id TEXT NOT NULL,
                kind TEXT NOT NULL CHECK(kind IN ('tool', 'command', 'file_change', 'diff', 'plan')),
                state TEXT NOT NULL CHECK(state IN ('running', 'completed', 'failed', 'declined', 'updated', 'unknown')),
                title TEXT NOT NULL,
                details_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                first_sequence INTEGER NOT NULL CHECK(first_sequence >= 0),
                last_sequence INTEGER NOT NULL CHECK(last_sequence >= first_sequence)
             );
             INSERT INTO activities SELECT * FROM activities_v11;
             DROP TABLE activities_v11;
             CREATE INDEX idx_activities_target_page
             ON activities(target_agent_id, created_at DESC, activity_id DESC);
             CREATE INDEX idx_activities_turn_sequence
             ON activities(thread_id, turn_id, first_sequence, activity_id);
             CREATE INDEX idx_activities_target_changes
             ON activities(target_agent_id, last_sequence, activity_id);
             PRAGMA user_version = 12;",
        ).map_err(|error| sqlite_error("apply projection v12 activity state migration", error))?;
        transaction.commit().map_err(|error| {
            sqlite_error("commit projection v12 activity state migration", error)
        })?;
        return migrate(connection);
    }
    if version == 10 {
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| sqlite_error("begin projection v11 migration", error))?;
        transaction
            .execute_batch("PRAGMA user_version = 11;")
            .map_err(|error| sqlite_error("apply projection v11 migration", error))?;
        transaction
            .commit()
            .map_err(|error| sqlite_error("commit projection v11 migration", error))?;
        return migrate(connection);
    }
    if version == 9 {
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| sqlite_error("begin projection v10 migration", error))?;
        if !table_has_column(&transaction, "projection_meta", "projection_revision")? {
            transaction
                .execute_batch(
                    "ALTER TABLE projection_meta ADD COLUMN projection_revision INTEGER NOT NULL DEFAULT 0 CHECK(projection_revision >= 0);",
                )
                .map_err(|error| sqlite_error("add projection v10 revision column", error))?;
        }
        transaction
            .execute_batch("PRAGMA user_version = 10;")
            .map_err(|error| sqlite_error("apply projection v10 revision migration", error))?;
        transaction
            .commit()
            .map_err(|error| sqlite_error("commit projection v10 revision migration", error))?;
        return migrate(connection);
    }
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| sqlite_error("begin projection migration", error))?;
    if version == 8 {
        for (column, definition) in [
            ("domain_event_version", "domain_event_version INTEGER"),
            ("source_event_id", "source_event_id TEXT"),
            ("owner_kind", "owner_kind TEXT"),
            ("owner_id", "owner_id TEXT"),
        ] {
            if !table_has_column(&transaction, "events", column)? {
                transaction
                    .execute_batch(&format!("ALTER TABLE events ADD COLUMN {definition};"))
                    .map_err(|error| sqlite_error("add projection domain-event column", error))?;
            }
        }
        transaction
            .execute_batch(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_events_source_event_id
                 ON events(source_event_id) WHERE source_event_id IS NOT NULL;
                 PRAGMA user_version = 9;",
            )
            .map_err(|error| sqlite_error("apply projection v9 domain-event migration", error))?;
        transaction
            .commit()
            .map_err(|error| sqlite_error("commit projection v9 domain-event migration", error))?;
        return migrate(connection);
    }
    if version == 7 {
        transaction.execute_batch(
            "DROP INDEX IF EXISTS idx_activities_target_page;
             DROP INDEX IF EXISTS idx_activities_turn_sequence;
             DROP INDEX IF EXISTS idx_activities_target_changes;
             ALTER TABLE activities RENAME TO activities_v7;
             CREATE TABLE activities (
                activity_id TEXT PRIMARY KEY,
                thread_id TEXT NOT NULL,
                turn_id TEXT NOT NULL,
                item_id TEXT,
                target_agent_id TEXT NOT NULL,
                kind TEXT NOT NULL CHECK(kind IN ('tool', 'command', 'file_change', 'diff', 'plan')),
                state TEXT NOT NULL CHECK(state IN ('running', 'completed', 'failed', 'declined', 'updated', 'unknown')),
                title TEXT NOT NULL,
                details_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                first_sequence INTEGER NOT NULL CHECK(first_sequence >= 0),
                last_sequence INTEGER NOT NULL CHECK(last_sequence >= first_sequence)
             );
             INSERT INTO activities SELECT * FROM activities_v7;
             DROP TABLE activities_v7;
             CREATE INDEX idx_activities_target_page
             ON activities(target_agent_id, created_at DESC, activity_id DESC);
             CREATE INDEX idx_activities_turn_sequence
             ON activities(thread_id, turn_id, first_sequence, activity_id);
             CREATE INDEX idx_activities_target_changes
             ON activities(target_agent_id, last_sequence, activity_id);
             PRAGMA user_version = 8;",
        ).map_err(|error| sqlite_error("apply projection v8 activity backfill migration", error))?;
        transaction.commit().map_err(|error| {
            sqlite_error("commit projection v8 activity backfill migration", error)
        })?;
        return migrate(connection);
    }
    if version == 6 {
        transaction.execute_batch(
            "CREATE TABLE IF NOT EXISTS activities (
                activity_id TEXT PRIMARY KEY,
                thread_id TEXT NOT NULL,
                turn_id TEXT NOT NULL,
                item_id TEXT,
                target_agent_id TEXT NOT NULL,
                kind TEXT NOT NULL CHECK(kind IN ('tool', 'command', 'file_change', 'diff', 'plan')),
                state TEXT NOT NULL CHECK(state IN ('running', 'completed', 'failed', 'declined', 'updated', 'unknown')),
                title TEXT NOT NULL,
                details_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                first_sequence INTEGER NOT NULL CHECK(first_sequence > 0),
                last_sequence INTEGER NOT NULL CHECK(last_sequence >= first_sequence)
            );
            CREATE INDEX IF NOT EXISTS idx_activities_target_page
            ON activities(target_agent_id, created_at DESC, activity_id DESC);
            CREATE INDEX IF NOT EXISTS idx_activities_turn_sequence
            ON activities(thread_id, turn_id, first_sequence, activity_id);
             PRAGMA user_version = 7;",
        ).map_err(|error| sqlite_error("apply projection v7 activity migration", error))?;
        transaction
            .commit()
            .map_err(|error| sqlite_error("commit projection v7 activity migration", error))?;
        return migrate(connection);
    }
    if version == 5 {
        transaction.execute_batch(
            "CREATE TABLE IF NOT EXISTS streaming_messages (
                message_id TEXT PRIMARY KEY,
                thread_id TEXT NOT NULL,
                turn_id TEXT NOT NULL,
                item_id TEXT NOT NULL,
                target_agent_id TEXT NOT NULL,
                text TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                first_sequence INTEGER NOT NULL CHECK(first_sequence > 0),
                last_sequence INTEGER NOT NULL CHECK(last_sequence >= first_sequence)
            );
            CREATE INDEX IF NOT EXISTS idx_streaming_messages_target ON streaming_messages(target_agent_id, last_sequence);
            PRAGMA user_version = 6;",
        ).map_err(|error| sqlite_error("apply projection v6 streaming migration", error))?;
        transaction
            .commit()
            .map_err(|error| sqlite_error("commit projection v6 streaming migration", error))?;
        return migrate(connection);
    }
    if version == 4 {
        transaction.execute_batch(
            "ALTER TABLE provider_backfill_state ADD COLUMN provider_connection_id TEXT NOT NULL DEFAULT 'legacy-unverified';
             CREATE INDEX IF NOT EXISTS idx_messages_provider_semantic
             ON messages(thread_id, turn_id, role, target_agent_id, text) WHERE origin = 'provider_page';
             PRAGMA user_version = 5;",
        ).map_err(|error| sqlite_error("apply projection v5 provider-connection migration", error))?;
        transaction.commit().map_err(|error| {
            sqlite_error("commit projection v5 provider-connection migration", error)
        })?;
        return migrate(connection);
    }
    if version == 1 {
        transaction.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_messages_target_page
             ON messages(target_agent_id, created_at DESC, message_id DESC);
             ALTER TABLE pending_requests ADD COLUMN method TEXT;
             ALTER TABLE pending_requests ADD COLUMN response_options_json TEXT NOT NULL DEFAULT '[]';
             CREATE TABLE provider_backfill_state (
                 project_id TEXT PRIMARY KEY,
                 provider_connection_id TEXT NOT NULL,
                 completed_at TEXT NOT NULL,
                 page_count INTEGER NOT NULL CHECK(page_count >= 0)
             );
             CREATE INDEX idx_messages_provider_semantic
             ON messages(thread_id, turn_id, role, target_agent_id, text) WHERE origin = 'provider_page';
             PRAGMA user_version = 5;",
        ).map_err(|error| sqlite_error("apply projection v4 migration from v1", error))?;
        transaction
            .commit()
            .map_err(|error| sqlite_error("commit projection v4 migration from v1", error))?;
        return migrate(connection);
    }
    if version == 2 {
        transaction.execute_batch(
            "ALTER TABLE pending_requests ADD COLUMN method TEXT;
             ALTER TABLE pending_requests ADD COLUMN response_options_json TEXT NOT NULL DEFAULT '[]';
             CREATE TABLE provider_backfill_state (
                 project_id TEXT PRIMARY KEY,
                 provider_connection_id TEXT NOT NULL,
                 completed_at TEXT NOT NULL,
                 page_count INTEGER NOT NULL CHECK(page_count >= 0)
             );
             CREATE INDEX idx_messages_provider_semantic
             ON messages(thread_id, turn_id, role, target_agent_id, text) WHERE origin = 'provider_page';
             PRAGMA user_version = 5;",
        ).map_err(|error| sqlite_error("apply projection v4 migration from v2", error))?;
        transaction
            .commit()
            .map_err(|error| sqlite_error("commit projection v4 migration from v2", error))?;
        return migrate(connection);
    }
    if version == 3 {
        transaction.execute_batch(
            "CREATE TABLE provider_backfill_state (
                 project_id TEXT PRIMARY KEY,
                 provider_connection_id TEXT NOT NULL,
                 completed_at TEXT NOT NULL,
                 page_count INTEGER NOT NULL CHECK(page_count >= 0)
             );
             CREATE INDEX idx_messages_provider_semantic
             ON messages(thread_id, turn_id, role, target_agent_id, text) WHERE origin = 'provider_page';
             PRAGMA user_version = 5;",
        ).map_err(|error| sqlite_error("apply projection v4 backfill-state migration", error))?;
        transaction.commit().map_err(|error| {
            sqlite_error("commit projection v4 backfill-state migration", error)
        })?;
        return migrate(connection);
    }
    transaction.execute_batch(
        "CREATE TABLE projection_meta (
            project_id TEXT PRIMARY KEY,
            stream_id TEXT NOT NULL,
            applied_sequence INTEGER NOT NULL CHECK(applied_sequence >= 0),
            projection_revision INTEGER NOT NULL DEFAULT 0 CHECK(projection_revision >= 0),
            updated_at TEXT NOT NULL
        );
        CREATE TABLE events (
            event_id TEXT PRIMARY KEY,
            stream_id TEXT NOT NULL,
            journal_sequence INTEGER NOT NULL UNIQUE CHECK(journal_sequence > 0),
            domain_event_version INTEGER,
            source_event_id TEXT,
            owner_kind TEXT,
            owner_id TEXT,
            source_cursor TEXT,
            agent_id TEXT,
            task_id TEXT,
            thread_id TEXT,
            turn_id TEXT,
            item_id TEXT,
            kind TEXT NOT NULL,
            phase TEXT NOT NULL,
            occurred_at TEXT NOT NULL,
            event_fingerprint TEXT NOT NULL CHECK(length(event_fingerprint) = 64)
        );
        CREATE INDEX idx_events_thread_sequence ON events(thread_id, journal_sequence);
        CREATE UNIQUE INDEX idx_events_source_event_id
        ON events(source_event_id) WHERE source_event_id IS NOT NULL;
        CREATE TABLE messages (
            message_id TEXT PRIMARY KEY,
            event_id TEXT UNIQUE,
            journal_sequence INTEGER UNIQUE,
            thread_id TEXT NOT NULL,
            turn_id TEXT,
            target_agent_id TEXT,
            role TEXT NOT NULL CHECK(role IN ('user', 'agent')),
            text TEXT NOT NULL,
            created_at TEXT NOT NULL,
            origin TEXT NOT NULL CHECK(origin IN ('journal', 'provider_page'))
        );
        CREATE INDEX idx_messages_page ON messages(thread_id, target_agent_id, created_at DESC, message_id DESC);
        CREATE INDEX idx_messages_thread_page ON messages(thread_id, created_at DESC, message_id DESC);
        CREATE INDEX idx_messages_target_page ON messages(target_agent_id, created_at DESC, message_id DESC);
        CREATE VIRTUAL TABLE message_fts USING fts5(message_id UNINDEXED, thread_id UNINDEXED, text, tokenize='trigram');
        CREATE TABLE conversation_index (
            target_agent_id TEXT PRIMARY KEY,
            last_message_id TEXT NOT NULL UNIQUE,
            updated_at TEXT NOT NULL,
            preview TEXT NOT NULL
        );
        CREATE INDEX idx_conversation_index_page
        ON conversation_index(updated_at DESC, last_message_id DESC);
        CREATE TABLE turns (
            thread_id TEXT NOT NULL,
            turn_id TEXT NOT NULL,
            state TEXT NOT NULL,
            last_sequence INTEGER NOT NULL,
            mutation_kind TEXT CHECK(mutation_kind IN ('stop', 'steer')),
            mutation_identity TEXT,
            mutation_phase TEXT CHECK(mutation_phase IN ('in_flight', 'accepted', 'outcome_unknown')),
            PRIMARY KEY(thread_id, turn_id)
        );
        CREATE TABLE items (
            thread_id TEXT NOT NULL,
            turn_id TEXT NOT NULL,
            item_id TEXT NOT NULL,
            PRIMARY KEY(thread_id, turn_id, item_id)
        );
        CREATE TABLE pending_requests (
            request_key TEXT PRIMARY KEY,
            event_id TEXT NOT NULL UNIQUE,
            thread_id TEXT,
            turn_id TEXT,
            agent_id TEXT,
            request_kind TEXT NOT NULL,
            method TEXT,
            response_options_json TEXT NOT NULL DEFAULT '[]',
            prompt TEXT,
            status TEXT NOT NULL CHECK(status IN ('pending', 'resolved')),
            created_at TEXT NOT NULL,
            resolved_at TEXT,
            runtime_connection_id TEXT,
            provider_connection_id TEXT,
            provider_request_id TEXT,
            requested_effect_kind TEXT
              CHECK(requested_effect_kind IN ('file_change', 'command_execution', 'other')),
            response_identity TEXT,
            response_decision TEXT,
            response_phase TEXT CHECK(response_phase IN ('in_flight', 'accepted', 'outcome_unknown'))
        );
        CREATE INDEX idx_pending_status ON pending_requests(status, created_at, request_key);
        CREATE TABLE provider_pages (
            page_id TEXT PRIMARY KEY,
            thread_id TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            next_cursor TEXT,
            is_complete INTEGER NOT NULL CHECK(is_complete IN (0, 1))
        );
        CREATE TABLE provider_backfill_state (
            project_id TEXT PRIMARY KEY,
            provider_connection_id TEXT NOT NULL,
            completed_at TEXT NOT NULL,
            page_count INTEGER NOT NULL CHECK(page_count >= 0)
        );
        CREATE INDEX idx_messages_provider_semantic
        ON messages(thread_id, turn_id, role, target_agent_id, text) WHERE origin = 'provider_page';
        CREATE TABLE streaming_messages (
            message_id TEXT PRIMARY KEY,
            thread_id TEXT NOT NULL,
            turn_id TEXT NOT NULL,
            item_id TEXT NOT NULL,
            target_agent_id TEXT NOT NULL,
            text TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            first_sequence INTEGER NOT NULL CHECK(first_sequence > 0),
            last_sequence INTEGER NOT NULL CHECK(last_sequence >= first_sequence)
        );
        CREATE INDEX idx_streaming_messages_target ON streaming_messages(target_agent_id, last_sequence);
        CREATE TABLE activities (
            activity_id TEXT PRIMARY KEY,
            thread_id TEXT NOT NULL,
            turn_id TEXT NOT NULL,
            item_id TEXT,
            target_agent_id TEXT NOT NULL,
            kind TEXT NOT NULL CHECK(kind IN ('tool', 'command', 'file_change', 'diff', 'plan')),
            state TEXT NOT NULL CHECK(state IN ('running', 'completed', 'failed', 'declined', 'updated', 'unknown')),
            title TEXT NOT NULL,
            details_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            first_sequence INTEGER NOT NULL CHECK(first_sequence >= 0),
            last_sequence INTEGER NOT NULL CHECK(last_sequence >= first_sequence)
        );
        CREATE INDEX idx_activities_target_page
        ON activities(target_agent_id, created_at DESC, activity_id DESC);
        CREATE INDEX idx_activities_turn_sequence
        ON activities(thread_id, turn_id, first_sequence, activity_id);
        CREATE INDEX idx_activities_target_changes
        ON activities(target_agent_id, last_sequence, activity_id);",
    ).map_err(|error| sqlite_error("apply projection schema migration", error))?;
    transaction
        .execute_batch("PRAGMA user_version = 16;")
        .map_err(|error| sqlite_error("finish projection v16 schema migration", error))?;
    transaction
        .commit()
        .map_err(|error| sqlite_error("commit projection migration", error))
}

fn verify_integrity(connection: &Connection) -> AppResult<()> {
    let result: String = connection
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(|error| sqlite_error("verify projection integrity", error))?;
    if result != "ok" {
        return Err(projection_error("projection_integrity_failed", "SQLite quick_check rejected the durable project database; the database was preserved for diagnosis"));
    }
    Ok(())
}

fn domain_owner_parts<'a>(
    owner: &'a DomainEventOwner,
    agent_id: Option<&str>,
) -> AppResult<(&'a str, &'a str)> {
    let owner_id = match owner.kind.as_str() {
        "agent"
            if owner.agent_id.is_some()
                && owner.execution_id.is_none()
                && owner.system_id.is_none() =>
        {
            if agent_id != owner.agent_id.as_deref() {
                return Err(projection_error(
                    "projection_batch_invalid",
                    "agentId disagrees with the domain event owner",
                ));
            }
            owner.agent_id.as_deref()
        }
        "ephemeral"
            if owner.agent_id.is_none()
                && owner.execution_id.is_some()
                && owner.system_id.is_none() =>
        {
            if agent_id.is_some() {
                return Err(projection_error(
                    "projection_batch_invalid",
                    "Ephemeral domain events cannot claim a persistent agentId",
                ));
            }
            owner.execution_id.as_deref()
        }
        "system"
            if owner.agent_id.is_none()
                && owner.execution_id.is_none()
                && owner.system_id.is_some() =>
        {
            if agent_id.is_some() {
                return Err(projection_error(
                    "projection_batch_invalid",
                    "System domain events cannot claim a persistent agentId",
                ));
            }
            owner.system_id.as_deref()
        }
        _ => {
            return Err(projection_error(
                "projection_batch_invalid",
                "Domain event owner must be exactly agent, ephemeral, or system",
            ));
        }
    };
    let owner_id = owner_id.expect("matched owner has its identity");
    validate_id(owner_id, "ownerId")?;
    Ok((owner.kind.as_str(), owner_id))
}

fn domain_owner_identity(
    owner: &DomainEventOwner,
    agent_id: Option<&str>,
) -> AppResult<BTreeMap<String, Value>> {
    let (owner_kind, owner_id) = domain_owner_parts(owner, agent_id)?;
    Ok(match owner_kind {
        "agent" => BTreeMap::from([
            ("agentId".to_owned(), Value::String(owner_id.to_owned())),
            ("kind".to_owned(), Value::String(owner_kind.to_owned())),
        ]),
        "ephemeral" => BTreeMap::from([
            ("executionId".to_owned(), Value::String(owner_id.to_owned())),
            ("kind".to_owned(), Value::String(owner_kind.to_owned())),
        ]),
        "system" => BTreeMap::from([
            ("kind".to_owned(), Value::String(owner_kind.to_owned())),
            ("systemId".to_owned(), Value::String(owner_id.to_owned())),
        ]),
        _ => unreachable!("validated domain owner kind"),
    })
}

fn expected_source_event_id(event: &ProjectionEvent) -> AppResult<String> {
    let owner = event.owner.as_ref().ok_or_else(|| {
        projection_error(
            "projection_batch_invalid",
            "Domain event identity requires an owner",
        )
    })?;
    let owner_identity = domain_owner_identity(owner, event.agent_id.as_deref())?;
    let identity = BTreeMap::from([
        ("domainEventVersion".to_owned(), Value::from(1)),
        ("itemId".to_owned(), nullable_json(&event.item_id)),
        ("kind".to_owned(), Value::String(event.kind.clone())),
        (
            "owner".to_owned(),
            serde_json::to_value(owner_identity).expect("owner identity is serializable"),
        ),
        ("phase".to_owned(), Value::String(event.phase.clone())),
        (
            "projectId".to_owned(),
            Value::String(event.project_id.clone()),
        ),
        (
            "sourceCursor".to_owned(),
            nullable_json(&event.source_cursor),
        ),
        (
            "sourceRuntime".to_owned(),
            Value::String(event.source_runtime.clone()),
        ),
        ("taskId".to_owned(), nullable_json(&event.task_id)),
        ("threadId".to_owned(), nullable_json(&event.thread_id)),
        ("turnId".to_owned(), nullable_json(&event.turn_id)),
    ]);
    let encoded = serde_json::to_vec(&identity)
        .map_err(|error| projection_error("projection_batch_invalid", error.to_string()))?;
    Ok(format!("src_{}", hex::encode(Sha256::digest(encoded))))
}

fn expected_ingestion_event_id(event: &ProjectionEvent) -> AppResult<String> {
    let owner = event.owner.as_ref().ok_or_else(|| {
        projection_error(
            "projection_batch_invalid",
            "Domain event identity requires an owner",
        )
    })?;
    let identity = BTreeMap::from([
        ("agentId".to_owned(), nullable_json(&event.agent_id)),
        (
            "domainEventVersion".to_owned(),
            Value::from(event.domain_event_version.unwrap_or_default()),
        ),
        ("itemId".to_owned(), nullable_json(&event.item_id)),
        ("kind".to_owned(), Value::String(event.kind.clone())),
        (
            "owner".to_owned(),
            serde_json::to_value(domain_owner_identity(owner, event.agent_id.as_deref())?)
                .expect("owner identity is serializable"),
        ),
        ("phase".to_owned(), Value::String(event.phase.clone())),
        (
            "projectId".to_owned(),
            Value::String(event.project_id.clone()),
        ),
        (
            "sourceCursor".to_owned(),
            nullable_json(&event.source_cursor),
        ),
        (
            "sourceEventId".to_owned(),
            event
                .source_event_id
                .clone()
                .map_or(Value::Null, Value::String),
        ),
        (
            "sourceRuntime".to_owned(),
            Value::String(event.source_runtime.clone()),
        ),
        ("taskId".to_owned(), nullable_json(&event.task_id)),
        ("threadId".to_owned(), nullable_json(&event.thread_id)),
        ("turnId".to_owned(), nullable_json(&event.turn_id)),
    ]);
    let encoded = serde_json::to_vec(&identity)
        .map_err(|error| projection_error("projection_batch_invalid", error.to_string()))?;
    Ok(format!("evt_{}", hex::encode(Sha256::digest(encoded))))
}

fn projection_event_from_domain(
    project_id: &str,
    stream_id: &str,
    journal_sequence: i64,
    event: &DomainEventEnvelope,
) -> AppResult<ProjectionEvent> {
    let mut projected = ProjectionEvent {
        schema_version: PROJECTION_SCHEMA_VERSION,
        domain_event_version: Some(event.domain_event_version),
        source_event_id: Some(event.source_event_id.clone()),
        owner: Some(event.owner.clone()),
        stream_id: stream_id.to_owned(),
        journal_sequence,
        event_id: format!("evt_{:064x}", 0),
        source_runtime: event.source_runtime.clone(),
        source_cursor: event.source_cursor.clone(),
        project_id: project_id.to_owned(),
        agent_id: event.agent_id.clone(),
        task_id: event.task_id.clone(),
        thread_id: event.thread_id.clone(),
        turn_id: event.turn_id.clone(),
        item_id: event.item_id.clone(),
        kind: event.kind.clone(),
        phase: event.phase.clone(),
        occurred_at: event.occurred_at.clone(),
        payload: event.payload.clone(),
        evidence_ref: event.evidence_ref.clone(),
        storage: serde_json::json!({ "truncated": false, "blob_ref": null }),
    };
    projected.event_id = expected_ingestion_event_id(&projected)?;
    Ok(projected)
}

fn nullable_json(value: &Option<String>) -> Value {
    value.clone().map_or(Value::Null, Value::String)
}

fn validate_projection_event(
    project_id: &str,
    stream_id: &str,
    journal_sequence: i64,
    event: &ProjectionEvent,
) -> AppResult<()> {
    validate_id(project_id, "projectId")?;
    validate_id(stream_id, "streamId")?;
    if journal_sequence <= 0
        || event.schema_version != PROJECTION_SCHEMA_VERSION
        || event.stream_id != stream_id
        || event.project_id != project_id
        || event.journal_sequence != journal_sequence
    {
        return Err(projection_error(
            "projection_batch_invalid",
            "Projection event is not bound to its project, stream, and sequence",
        ));
    }
    validate_id(&event.event_id, "eventId")?;
    if event.event_id.len() != 68
        || !event.event_id.starts_with("evt_")
        || !event.event_id[4..]
            .chars()
            .all(|value| value.is_ascii_hexdigit() && !value.is_ascii_uppercase())
    {
        return Err(projection_error(
            "projection_batch_invalid",
            "eventId is not a canonical ingestion event identity",
        ));
    }
    validate_id(&event.source_runtime, "sourceRuntime")?;
    validate_cursor(event.source_cursor.as_deref(), "sourceCursor")?;
    validate_optional_id(event.agent_id.as_deref(), "agentId")?;
    let domain_field_count = usize::from(event.domain_event_version.is_some())
        + usize::from(event.source_event_id.is_some())
        + usize::from(event.owner.is_some());
    if domain_field_count != 0 {
        if domain_field_count != 3 || event.domain_event_version != Some(1) {
            return Err(projection_error(
                "projection_batch_invalid",
                "Domain event identity is incomplete or has an unsupported version",
            ));
        }
        let source_event_id = event
            .source_event_id
            .as_deref()
            .expect("complete domain event");
        if source_event_id.len() != 68
            || !source_event_id.starts_with("src_")
            || !source_event_id[4..]
                .chars()
                .all(|value| value.is_ascii_hexdigit() && !value.is_ascii_uppercase())
        {
            return Err(projection_error(
                "projection_batch_invalid",
                "sourceEventId is not a canonical domain source identity",
            ));
        }
        let owner = event.owner.as_ref().expect("complete domain event");
        domain_owner_parts(owner, event.agent_id.as_deref())?;
        if event.source_cursor.is_none() && event.item_id.is_none() {
            return Err(projection_error(
                "projection_batch_invalid",
                "Cursorless domain events require a stable itemId",
            ));
        }
        if !event.payload.is_object() {
            return Err(projection_error(
                "projection_batch_invalid",
                "Domain event payload must be an object",
            ));
        }
        if source_event_id != expected_source_event_id(event)? {
            return Err(projection_error(
                "projection_batch_invalid",
                "sourceEventId does not match the immutable domain event identity",
            ));
        }
    }
    validate_optional_id(event.task_id.as_deref(), "taskId")?;
    validate_optional_id(event.thread_id.as_deref(), "threadId")?;
    validate_optional_id(event.turn_id.as_deref(), "turnId")?;
    validate_optional_id(event.item_id.as_deref(), "itemId")?;
    validate_id(&event.kind, "kind")?;
    validate_id(&event.phase, "phase")?;
    validate_timestamp(&event.occurred_at, "occurredAt")?;
    validate_public_json(&event.payload, "payload")?;
    validate_public_json(&event.storage, "storage")?;
    if serde_json::to_vec(&event.payload)
        .map_err(|error| projection_error("projection_batch_invalid", error.to_string()))?
        .len()
        > 1024 * 1024
        || serde_json::to_vec(&event.storage)
            .map_err(|error| projection_error("projection_batch_invalid", error.to_string()))?
            .len()
            > 1024 * 1024
    {
        return Err(projection_error(
            "projection_batch_invalid",
            "Event payload exceeds the projection boundary",
        ));
    }
    Ok(())
}

fn validate_public_json(value: &Value, field: &str) -> AppResult<()> {
    let mut pending = vec![value];
    let mut visited = 0usize;
    while let Some(value) = pending.pop() {
        visited += 1;
        if visited > 100_000 {
            return Err(projection_error(
                "projection_batch_invalid",
                format!("{field} is too structurally complex"),
            ));
        }
        match value {
            Value::Object(object) => {
                for (key, child) in object {
                    let normalized: String = key
                        .chars()
                        .filter(|value| value.is_ascii_alphanumeric())
                        .flat_map(char::to_lowercase)
                        .collect();
                    if normalized.starts_with("raw")
                        || normalized.starts_with("private")
                        || normalized.starts_with("providerresponse")
                        || normalized.starts_with("providerframe")
                        || normalized.starts_with("providerbody")
                        || normalized.starts_with("providerenvelope")
                        || matches!(
                            normalized.as_str(),
                            "analysis"
                                | "reasoning"
                                | "thought"
                                | "thoughts"
                                | "chainofthought"
                                | "reasoningcontent"
                                | "hiddenreasoning"
                                | "hiddenthoughts"
                                | "cot"
                        )
                    {
                        return Err(projection_error(
                            "projection_private_payload_rejected",
                            format!("{field} contains a forbidden private or raw field"),
                        ));
                    }
                    pending.push(child);
                }
            }
            Value::Array(items) => pending.extend(items),
            _ => {}
        }
    }
    Ok(())
}

fn current_meta(
    transaction: &Transaction<'_>,
    project_id: &str,
) -> AppResult<Option<(String, i64, i64)>> {
    transaction
        .query_row(
            "SELECT stream_id, applied_sequence, projection_revision FROM projection_meta WHERE project_id = ?1",
            [project_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|error| sqlite_error("read projection watermark", error))
}

fn ingest_domain_events_to_connection(
    connection: &mut Connection,
    project_id: &str,
    runtime_connection_id: Option<&str>,
    events: &[DomainEventEnvelope],
) -> AppResult<ProjectionApplyReceipt> {
    validate_id(project_id, "projectId")?;
    if events.is_empty() || events.len() > MAX_BATCH_EVENTS {
        return Err(projection_error(
            "projection_batch_invalid",
            "Domain event batch is empty or exceeds its bounded limit",
        ));
    }
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| sqlite_error("begin domain event transaction", error))?;
    let current = current_meta(&transaction, project_id)?;
    let existing_event_count: i64 = transaction
        .query_row("SELECT COUNT(*) FROM events", [], |row| row.get(0))
        .map_err(|error| sqlite_error("inspect domain event history", error))?;
    if current.is_none() && existing_event_count != 0 {
        return Err(projection_error(
            "projection_meta_missing",
            "Durable events exist without their project stream watermark",
        ));
    }
    let stream_id = current
        .as_ref()
        .map(|entry| entry.0.clone())
        .unwrap_or_else(|| format!("stream_{}", Uuid::new_v4()));
    let mut applied = current.as_ref().map_or(0, |entry| entry.1);
    let mut projection_revision = current.as_ref().map_or(0, |entry| entry.2);
    let reconcile_provider_messages: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM messages WHERE origin = 'provider_page' LIMIT 1)",
            [],
            |row| row.get(0),
        )
        .map_err(|error| sqlite_error("inspect provider message reconciliation state", error))?;
    let mut inserted = 0usize;
    let mut messages = 0usize;
    let mut latest_occurred_at = None;
    for domain_event in events {
        let source_event_id = &domain_event.source_event_id;
        let stored: Option<(i64, String, String)> = transaction
            .query_row(
                "SELECT journal_sequence, stream_id, event_fingerprint FROM events WHERE source_event_id = ?1",
                [source_event_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(|error| sqlite_error("read durable domain event identity", error))?;
        if let Some((stored_sequence, stored_stream, stored_fingerprint)) = stored {
            let replayed = projection_event_from_domain(
                project_id,
                &stored_stream,
                stored_sequence,
                domain_event,
            )?;
            validate_projection_event(project_id, &stored_stream, stored_sequence, &replayed)?;
            if event_fingerprint(&replayed)? != stored_fingerprint {
                return Err(projection_error(
                    "projection_event_conflict",
                    "A repeated sourceEventId changed its immutable persisted content",
                ));
            }
            continue;
        }

        let sequence = applied + 1;
        let projected =
            projection_event_from_domain(project_id, &stream_id, sequence, domain_event)?;
        validate_projection_event(project_id, &stream_id, sequence, &projected)?;
        messages += insert_event(
            &transaction,
            &projected,
            reconcile_provider_messages,
            runtime_connection_id,
        )?;
        applied = sequence;
        inserted += 1;
        latest_occurred_at = Some(projected.occurred_at);
    }

    if inserted > 0 {
        let updated_at = latest_occurred_at.expect("inserted domain event has a timestamp");
        projection_revision += 1;
        if current.is_some() {
            transaction
                .execute(
                    "UPDATE projection_meta SET applied_sequence = ?2, projection_revision = ?3, updated_at = ?4 WHERE project_id = ?1",
                    params![project_id, applied, projection_revision, updated_at],
                )
                .map_err(|error| sqlite_error("advance durable domain event watermark", error))?;
        } else {
            transaction
                .execute(
                    "INSERT INTO projection_meta(project_id, stream_id, applied_sequence, projection_revision, updated_at) VALUES(?1, ?2, ?3, ?4, ?5)",
                    params![project_id, stream_id, applied, projection_revision, updated_at],
                )
                .map_err(|error| sqlite_error("initialize durable domain event watermark", error))?;
        }
    }
    transaction
        .commit()
        .map_err(|error| sqlite_error("commit domain event transaction", error))?;
    Ok(ProjectionApplyReceipt {
        status: if inserted == 0 {
            "idempotent".into()
        } else {
            "applied".into()
        },
        stream_id,
        applied_journal_sequence: applied,
        projection_revision,
        event_count: inserted,
        message_count: messages,
    })
}

fn insert_event(
    transaction: &Transaction<'_>,
    event: &ProjectionEvent,
    reconcile_provider_messages: bool,
    runtime_connection_id: Option<&str>,
) -> AppResult<usize> {
    let duplicate_sequence: Option<String> = transaction
        .query_row(
            "SELECT event_id FROM events WHERE journal_sequence = ?1",
            [event.journal_sequence],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| sqlite_error("check projection sequence", error))?;
    let duplicate_event: Option<i64> = transaction
        .query_row(
            "SELECT journal_sequence FROM events WHERE event_id = ?1",
            [&event.event_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| sqlite_error("check projection event identity", error))?;
    let duplicate_source_event: Option<String> = match event.source_event_id.as_deref() {
        Some(source_event_id) => transaction
            .query_row(
                "SELECT event_id FROM events WHERE source_event_id = ?1",
                [source_event_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| sqlite_error("check domain source event identity", error))?,
        None => None,
    };
    if duplicate_sequence.is_some() || duplicate_event.is_some() || duplicate_source_event.is_some()
    {
        return Err(projection_error(
            "projection_event_conflict",
            "New projection batch reuses an event, source-event, or journal identity",
        ));
    }
    let (owner_kind, owner_id) = match event.owner.as_ref() {
        Some(owner) => {
            let (kind, id) = domain_owner_parts(owner, event.agent_id.as_deref())?;
            (Some(kind), Some(id))
        }
        None => (None, None),
    };
    let event_fingerprint = event_fingerprint(event)?;
    transaction.execute(
        "INSERT INTO events(event_id, stream_id, journal_sequence, domain_event_version, source_event_id, owner_kind, owner_id, source_cursor, agent_id, task_id, thread_id, turn_id, item_id, kind, phase, occurred_at, event_fingerprint)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
        params![event.event_id, event.stream_id, event.journal_sequence, event.domain_event_version, event.source_event_id,
            owner_kind, owner_id, event.source_cursor, event.agent_id, event.task_id, event.thread_id, event.turn_id,
            event.item_id, event.kind, event.phase, event.occurred_at, event_fingerprint],
    ).map_err(|error| sqlite_error("insert projection event", error))?;
    update_turn_and_item(transaction, event)?;
    update_pending_request(transaction, event, runtime_connection_id)?;
    update_activity(transaction, event)?;
    let streaming_change = update_streaming_message(transaction, event)?;
    match message_from_event(event)? {
        Some(message) => {
            insert_message(
                transaction,
                &message,
                Some(&event.event_id),
                reconcile_provider_messages,
            )?;
            transaction
                .execute(
                    "DELETE FROM streaming_messages WHERE message_id = ?1",
                    [&message.message_id],
                )
                .map_err(|error| sqlite_error("clear completed streaming message", error))?;
            Ok(1)
        }
        None => Ok(usize::from(streaming_change)),
    }
}

fn event_fingerprint(event: &ProjectionEvent) -> AppResult<String> {
    let encoded = serde_json::to_vec(event)
        .map_err(|error| projection_error("projection_batch_invalid", error.to_string()))?;
    Ok(hex::encode(Sha256::digest(encoded)))
}

fn payload_map(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

fn string_field<'a>(
    primary: &'a Map<String, Value>,
    fallback: &'a Map<String, Value>,
    names: &[&str],
) -> Option<&'a str> {
    names
        .iter()
        .find_map(|name| primary.get(*name).and_then(Value::as_str))
        .or_else(|| {
            names
                .iter()
                .find_map(|name| fallback.get(*name).and_then(Value::as_str))
        })
}

fn message_from_event(event: &ProjectionEvent) -> AppResult<Option<ProjectionMessage>> {
    let payload = match payload_map(&event.payload) {
        Some(value) => value,
        None => return Ok(None),
    };
    if payload
        .get("visibility")
        .and_then(Value::as_str)
        .is_some_and(|value| value != "public")
    {
        return Ok(None);
    }
    let message = match event.kind.as_str() {
        "item.completed" | "message.completed" => {
            match payload.get("message").and_then(Value::as_object) {
                Some(message) => message,
                None => return Ok(None),
            }
        }
        "conversation.message" => payload
            .get("message")
            .and_then(Value::as_object)
            .unwrap_or(payload),
        _ => return Ok(None),
    };
    if message
        .get("visibility")
        .and_then(Value::as_str)
        .is_some_and(|value| value != "public")
    {
        return Ok(None);
    }
    let role = match string_field(message, payload, &["role"]) {
        Some("user") => "user",
        Some("agent" | "assistant") => "agent",
        _ => return Ok(None),
    };
    if role == "agent" && !matches!(event.phase.as_str(), "completed" | "final" | "final_answer") {
        return Ok(None);
    }
    let text = match string_field(message, payload, &["text", "content"]) {
        Some(value) if !value.trim().is_empty() => value,
        _ => return Ok(None),
    };
    validate_text(text, "message.text")?;
    let thread_id = if let Some(value) = event.thread_id.as_ref() {
        value.clone()
    } else if let Some(value) = string_field(message, payload, &["threadId", "thread_id"]) {
        value.to_owned()
    } else {
        return Ok(None);
    };
    validate_id(&thread_id, "message.threadId")?;
    let message_id = string_field(message, payload, &["messageId", "message_id", "id"])
        .map(str::to_owned)
        .or_else(|| event.item_id.clone())
        .unwrap_or_else(|| event.event_id.clone());
    validate_id(&message_id, "message.messageId")?;
    let target_agent_id = string_field(message, payload, &["targetAgentId", "target_agent_id"])
        .map(str::to_owned)
        .or_else(|| {
            if role == "agent" {
                event.agent_id.clone()
            } else {
                None
            }
        });
    validate_optional_id(target_agent_id.as_deref(), "message.targetAgentId")?;
    Ok(Some(ProjectionMessage {
        message_id,
        thread_id,
        turn_id: event.turn_id.clone(),
        target_agent_id,
        role: role.into(),
        text: text.into(),
        created_at: event.occurred_at.clone(),
        journal_sequence: Some(event.journal_sequence),
        origin: "journal".into(),
    }))
}

fn update_streaming_message(
    transaction: &Transaction<'_>,
    event: &ProjectionEvent,
) -> AppResult<bool> {
    if event.kind != "message.agent.delta" {
        return Ok(false);
    }
    if event.phase != "streaming" {
        return Err(projection_error(
            "projection_stream_invalid",
            "Agent answer deltas must use the streaming phase",
        ));
    }
    let payload = payload_map(&event.payload).ok_or_else(|| {
        projection_error(
            "projection_stream_invalid",
            "Agent answer delta payload is not an object",
        )
    })?;
    if payload.get("visibility").and_then(Value::as_str) != Some("public")
        || payload.get("role").and_then(Value::as_str) != Some("agent")
    {
        return Err(projection_error(
            "projection_stream_invalid",
            "Agent answer delta is not an explicitly public agent message",
        ));
    }
    let thread_id = event.thread_id.as_deref().ok_or_else(|| {
        projection_error(
            "projection_stream_invalid",
            "Agent answer delta has no thread ownership",
        )
    })?;
    let turn_id = event.turn_id.as_deref().ok_or_else(|| {
        projection_error(
            "projection_stream_invalid",
            "Agent answer delta has no turn ownership",
        )
    })?;
    let item_id = event.item_id.as_deref().ok_or_else(|| {
        projection_error(
            "projection_stream_invalid",
            "Agent answer delta has no item identity",
        )
    })?;
    let message_id = payload
        .get("messageId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            projection_error(
                "projection_stream_invalid",
                "Agent answer delta has no stable message identity",
            )
        })?;
    let target_agent_id = payload
        .get("targetAgentId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            projection_error(
                "projection_stream_invalid",
                "Agent answer delta has no target agent",
            )
        })?;
    let delta = payload
        .get("delta")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            projection_error("projection_stream_invalid", "Agent answer delta is empty")
        })?;
    if event.agent_id.as_deref() != Some(target_agent_id) {
        return Err(projection_error(
            "projection_stream_invalid",
            "Agent answer delta target disagrees with its event owner",
        ));
    }
    validate_id(thread_id, "stream.threadId")?;
    validate_id(turn_id, "stream.turnId")?;
    validate_id(item_id, "stream.itemId")?;
    validate_id(message_id, "stream.messageId")?;
    validate_id(target_agent_id, "stream.targetAgentId")?;
    validate_stream_text(delta, "stream.delta", MAX_STREAM_DELTA_BYTES)?;
    validate_timestamp(&event.occurred_at, "stream.occurredAt")?;

    let turn_is_terminal: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM turns WHERE thread_id = ?1 AND turn_id = ?2
         AND state IN ('completed', 'failed', 'interrupted', 'cancelled'))",
            params![thread_id, turn_id],
            |row| row.get(0),
        )
        .map_err(|error| sqlite_error("check terminal turn before stream append", error))?;
    if turn_is_terminal {
        return Ok(false);
    }

    let final_exists: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM messages WHERE message_id = ?1)",
            [message_id],
            |row| row.get(0),
        )
        .map_err(|error| sqlite_error("check completed message before stream append", error))?;
    if final_exists {
        return Ok(false);
    }
    let existing: Option<(String, String, String, String, String)> = transaction.query_row(
        "SELECT thread_id, turn_id, item_id, target_agent_id, text FROM streaming_messages WHERE message_id = ?1",
        [message_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
    ).optional().map_err(|error| sqlite_error("read streaming message identity", error))?;
    if let Some(existing) = existing {
        if existing.0 != thread_id
            || existing.1 != turn_id
            || existing.2 != item_id
            || existing.3 != target_agent_id
        {
            return Err(projection_error(
                "projection_stream_conflict",
                "Streaming message identity changed thread, turn, item, or target ownership",
            ));
        }
        let next_text = format!("{}{}", existing.4, delta);
        validate_stream_text(&next_text, "stream.text", MAX_TEXT_BYTES)?;
        transaction.execute(
            "UPDATE streaming_messages SET text = ?2, updated_at = ?3, last_sequence = ?4 WHERE message_id = ?1",
            params![message_id, next_text, event.occurred_at, event.journal_sequence],
        ).map_err(|error| sqlite_error("append streaming message delta", error))?;
        return Ok(true);
    }
    transaction.execute(
        "INSERT INTO streaming_messages(message_id, thread_id, turn_id, item_id, target_agent_id, text, created_at, updated_at, first_sequence, last_sequence)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8, ?8)",
        params![message_id, thread_id, turn_id, item_id, target_agent_id, delta, event.occurred_at, event.journal_sequence],
    ).map_err(|error| sqlite_error("insert streaming message", error))?;
    Ok(true)
}

fn insert_message(
    transaction: &Transaction<'_>,
    message: &ProjectionMessage,
    event_id: Option<&str>,
    reconcile_provider_messages: bool,
) -> AppResult<bool> {
    validate_provider_record(message)?;
    let existing: Option<(
        String,
        String,
        Option<String>,
        String,
        String,
        Option<String>,
        Option<String>,
        Option<i64>,
        String,
    )> = transaction.query_row(
        "SELECT role, text, target_agent_id, created_at, thread_id, turn_id, event_id, journal_sequence, origin FROM messages WHERE message_id = ?1",
        [&message.message_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?, row.get(8)?)),
    ).optional().map_err(|error| sqlite_error("check projected message identity", error))?;
    if let Some(existing) = existing {
        let same_display_semantics = existing.0 == message.role
            && existing.1 == message.text
            && existing.2 == message.target_agent_id
            && existing.4 == message.thread_id;
        let same_visible_semantics = same_display_semantics && existing.5 == message.turn_id;
        let same_semantics = same_visible_semantics && existing.3 == message.created_at;
        let provider_turn_upgrade = message.origin == "journal"
            && existing.8 == "provider_page"
            && existing.5.is_none()
            && message.turn_id.is_some();
        if message.origin == "journal"
            && existing.8 == "provider_page"
            && same_display_semantics
            && (same_visible_semantics || provider_turn_upgrade)
        {
            transaction.execute(
                "UPDATE messages SET event_id = ?2, journal_sequence = ?3, created_at = ?4, turn_id = ?5, origin = 'journal' WHERE message_id = ?1 AND origin = 'provider_page'",
                params![message.message_id, event_id, message.journal_sequence, message.created_at, message.turn_id],
            ).map_err(|error| sqlite_error("bind provider message to canonical journal event", error))?;
            if let Some(target_agent_id) = message.target_agent_id.as_deref() {
                refresh_conversation_index(transaction, target_agent_id)?;
            }
            return Ok(false);
        }
        if !same_semantics {
            return Err(projection_error(
                "projection_message_conflict",
                "Message identity has different visible content or turn ownership",
            ));
        }
        if message.origin == "journal"
            && existing.8 == "journal"
            && (existing.6.as_deref() != event_id || existing.7 != message.journal_sequence)
        {
            return Err(projection_error(
                "projection_message_conflict",
                "Journal message identity has different immutable source linkage",
            ));
        }
        return Ok(false);
    }
    if reconcile_provider_messages && message.origin == "journal" && message.turn_id.is_some() {
        let mut statement = transaction
            .prepare(
                "SELECT message_id, event_id, journal_sequence, origin, turn_id FROM messages
             WHERE thread_id = ?1 AND (turn_id = ?2 OR turn_id IS NULL) AND role = ?3 AND text = ?4
               AND target_agent_id IS ?5 AND origin = 'provider_page'
             ORDER BY CASE WHEN turn_id = ?2 THEN 0 ELSE 1 END, message_id LIMIT 3",
            )
            .map_err(|error| sqlite_error("prepare semantic projected message lookup", error))?;
        let candidates = statement
            .query_map(
                params![
                    message.thread_id,
                    message.turn_id,
                    message.role,
                    message.text,
                    message.target_agent_id
                ],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<i64>>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                    ))
                },
            )
            .map_err(|error| sqlite_error("query semantic projected message identity", error))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| sqlite_error("read semantic projected message identity", error))?;
        drop(statement);
        let exact = candidates
            .iter()
            .filter(|candidate| candidate.4 == message.turn_id)
            .collect::<Vec<_>>();
        let missing_turn = candidates
            .iter()
            .filter(|candidate| candidate.4.is_none())
            .collect::<Vec<_>>();
        let candidate = if exact.len() == 1 {
            Some(exact[0])
        } else if exact.is_empty() && missing_turn.len() == 1 {
            Some(missing_turn[0])
        } else {
            None
        };
        if let Some(candidate) = candidate {
            if candidate.3 == "provider_page" {
                transaction.execute(
                    "UPDATE messages SET event_id = ?2, journal_sequence = ?3, created_at = ?4, turn_id = ?5, origin = 'journal' WHERE message_id = ?1 AND origin = 'provider_page'",
                    params![candidate.0, event_id, message.journal_sequence, message.created_at, message.turn_id],
                ).map_err(|error| sqlite_error("merge semantic provider message with canonical journal event", error))?;
                if let Some(target_agent_id) = message.target_agent_id.as_deref() {
                    refresh_conversation_index(transaction, target_agent_id)?;
                }
                return Ok(false);
            }
            if candidate.3 == "journal"
                && candidate.1.as_deref() == event_id
                && candidate.2 == message.journal_sequence
            {
                return Ok(false);
            }
            return Err(projection_error(
                "projection_message_conflict",
                "Semantic message identity has different immutable journal linkage",
            ));
        }
    }
    if reconcile_provider_messages
        && message.origin == "provider_page"
        && message.role == "user"
        && message.turn_id.is_some()
    {
        let journal_equivalent_exists: bool = transaction
            .query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM messages
                    WHERE thread_id = ?1 AND turn_id = ?2 AND role = 'user' AND text = ?3
                      AND target_agent_id IS ?4 AND origin = 'journal'
                )",
                params![
                    message.thread_id,
                    message.turn_id,
                    message.text,
                    message.target_agent_id
                ],
                |row| row.get(0),
            )
            .map_err(|error| sqlite_error("check canonical journal user message", error))?;
        if journal_equivalent_exists {
            return Ok(false);
        }
    }
    transaction.execute(
        "INSERT INTO messages(message_id, event_id, journal_sequence, thread_id, turn_id, target_agent_id, role, text, created_at, origin)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![message.message_id, event_id, message.journal_sequence, message.thread_id, message.turn_id,
            message.target_agent_id, message.role, message.text, message.created_at, message.origin],
    ).map_err(|error| sqlite_error("insert projected message", error))?;
    transaction
        .execute(
            "INSERT INTO message_fts(message_id, thread_id, text) VALUES(?1, ?2, ?3)",
            params![message.message_id, message.thread_id, message.text],
        )
        .map_err(|error| sqlite_error("index projected message", error))?;
    if let Some(target_agent_id) = message.target_agent_id.as_deref() {
        refresh_conversation_index(transaction, target_agent_id)?;
    }
    Ok(true)
}

fn refresh_conversation_index(
    transaction: &Transaction<'_>,
    target_agent_id: &str,
) -> AppResult<()> {
    transaction
        .execute(
            "INSERT INTO conversation_index(target_agent_id, last_message_id, updated_at, preview)
             SELECT target_agent_id, message_id, created_at, substr(text, 1, 160)
             FROM messages
             WHERE target_agent_id = ?1
             ORDER BY created_at DESC, message_id DESC LIMIT 1
             ON CONFLICT(target_agent_id) DO UPDATE SET
               last_message_id = excluded.last_message_id,
               updated_at = excluded.updated_at,
               preview = excluded.preview",
            [target_agent_id],
        )
        .map_err(|error| sqlite_error("refresh conversation index", error))?;
    Ok(())
}

fn validate_provider_record(message: &ProjectionMessage) -> AppResult<()> {
    validate_id(&message.message_id, "messageId")?;
    validate_id(&message.thread_id, "threadId")?;
    validate_optional_id(message.turn_id.as_deref(), "turnId")?;
    validate_optional_id(message.target_agent_id.as_deref(), "targetAgentId")?;
    if !matches!(message.role.as_str(), "user" | "agent") {
        return Err(projection_error(
            "projection_input_invalid",
            "message role must be user or agent",
        ));
    }
    validate_text(&message.text, "text")?;
    validate_timestamp(&message.created_at, "createdAt")
}

fn projected_activity_kind(event_kind: &str) -> Option<&'static str> {
    match event_kind {
        "tool.started" | "tool.completed" | "tool.failed" => Some("tool"),
        "command.started" | "command.completed" | "command.failed" => Some("command"),
        "file.change.started" | "file.change.completed" | "file.change.failed" => {
            Some("file_change")
        }
        "diff.updated" => Some("diff"),
        "plan.updated" => Some("plan"),
        _ => None,
    }
}

fn activity_state_matches(event_kind: &str, state: &str) -> bool {
    if state == "unknown" {
        return true;
    }
    match event_kind {
        kind if kind.ends_with(".started") => state == "running",
        kind if kind.ends_with(".completed") => state == "completed",
        kind if kind.ends_with(".failed") => matches!(state, "failed" | "declined"),
        "diff.updated" => state == "updated",
        "plan.updated" => matches!(state, "running" | "completed" | "updated"),
        _ => false,
    }
}

fn activity_detail_fields(kind: &str) -> &'static [(&'static str, &'static str)] {
    match kind {
        "command" => &[
            ("command_name", "commandName"),
            ("action_types", "actionTypes"),
            ("action_types_truncated", "actionTypesTruncated"),
            ("exit_code", "exitCode"),
            ("duration_ms", "durationMs"),
            ("output_present", "outputPresent"),
            ("output_bytes", "outputBytes"),
            ("output_text", "outputText"),
            ("output_truncated", "outputTruncated"),
            ("output_redacted", "outputRedacted"),
            ("cwd_omitted", "cwdOmitted"),
            ("command_arguments_omitted", "commandArgumentsOmitted"),
            ("content_omitted", "contentOmitted"),
        ],
        "tool" => &[
            ("tool_kind", "toolKind"),
            ("tool_name", "toolName"),
            ("tool_namespace", "toolNamespace"),
            ("duration_ms", "durationMs"),
            ("success", "success"),
            ("arguments_omitted", "argumentsOmitted"),
            ("result_omitted", "resultOmitted"),
            ("content_omitted", "contentOmitted"),
        ],
        "file_change" => &[
            ("changes", "changes"),
            ("change_count", "changeCount"),
            ("changes_truncated", "changesTruncated"),
            ("content_omitted", "contentOmitted"),
        ],
        "diff" => &[
            ("original_bytes", "originalBytes"),
            ("added_lines", "addedLines"),
            ("removed_lines", "removedLines"),
            ("content_omitted", "contentOmitted"),
        ],
        "plan" => &[
            ("text", "text"),
            ("original_bytes", "originalBytes"),
            ("truncated", "truncated"),
            ("redacted", "redacted"),
            ("steps", "steps"),
            ("step_count", "stepCount"),
            ("steps_truncated", "stepsTruncated"),
            ("explanation", "explanation"),
            ("explanation_truncated", "explanationTruncated"),
            ("explanation_redacted", "explanationRedacted"),
        ],
        _ => &[],
    }
}

fn activity_required<'a>(payload: &'a Map<String, Value>, key: &str) -> AppResult<&'a Value> {
    payload.get(key).ok_or_else(|| {
        projection_error(
            "projection_activity_invalid",
            format!("Structured activity field {key} is missing"),
        )
    })
}

fn activity_bounded_text(value: &Value, maximum: usize) -> bool {
    value
        .as_str()
        .is_some_and(|text| !text.is_empty() && text.len() <= maximum && !text.contains('\0'))
}

fn activity_non_negative_integer(value: &Value) -> bool {
    value
        .as_u64()
        .is_some_and(|number| number <= 9_007_199_254_740_991)
}

fn activity_nullable_non_negative_integer(value: &Value) -> bool {
    value.is_null() || activity_non_negative_integer(value)
}

fn validate_activity_payload_shape(
    kind: &str,
    item_id: Option<&str>,
    payload: &Map<String, Value>,
) -> AppResult<()> {
    let invalid = |message: &str| Err(projection_error("projection_activity_invalid", message));
    match kind {
        "command" => {
            if !activity_bounded_text(activity_required(payload, "command_name")?, 256)
                || !activity_required(payload, "action_types")?
                    .as_array()
                    .is_some_and(|items| {
                        items.len() <= 16
                            && items.iter().all(|item| activity_bounded_text(item, 256))
                    })
                || !activity_required(payload, "action_types_truncated")?.is_boolean()
                || !activity_required(payload, "exit_code")?.is_null()
                    && activity_required(payload, "exit_code")?.as_i64().is_none()
                || !activity_nullable_non_negative_integer(activity_required(
                    payload,
                    "duration_ms",
                )?)
                || !activity_required(payload, "output_present")?.is_boolean()
                || !activity_non_negative_integer(activity_required(payload, "output_bytes")?)
                || !(activity_required(payload, "output_text")?.is_null()
                    || activity_required(payload, "output_text")?
                        .as_str()
                        .is_some_and(|text| text.len() <= 16_384 && !text.contains('\0')))
                || !activity_required(payload, "output_truncated")?.is_boolean()
                || !activity_required(payload, "output_redacted")?.is_boolean()
                || (activity_required(payload, "output_present")? == &Value::Bool(true)
                    && !activity_required(payload, "output_text")?.is_string())
                || (activity_required(payload, "output_present")? == &Value::Bool(false)
                    && (!activity_required(payload, "output_text")?.is_null()
                        || activity_required(payload, "output_bytes")?.as_u64() != Some(0)))
                || activity_required(payload, "cwd_omitted")? != &Value::Bool(true)
                || activity_required(payload, "command_arguments_omitted")? != &Value::Bool(true)
                || activity_required(payload, "content_omitted")? != &Value::Bool(true)
            {
                return invalid("Structured command activity has an invalid safe summary");
            }
        }
        "tool" => {
            let tool_kind = activity_required(payload, "tool_kind")?.as_str();
            if !matches!(
                tool_kind,
                Some("mcpToolCall" | "dynamicToolCall" | "collabAgentToolCall" | "webSearch")
            ) || !activity_bounded_text(activity_required(payload, "tool_name")?, 256)
                || !(activity_required(payload, "tool_namespace")?.is_null()
                    || activity_bounded_text(activity_required(payload, "tool_namespace")?, 256))
                || !activity_nullable_non_negative_integer(activity_required(
                    payload,
                    "duration_ms",
                )?)
                || !(activity_required(payload, "success")?.is_null()
                    || activity_required(payload, "success")?.is_boolean())
                || activity_required(payload, "arguments_omitted")? != &Value::Bool(true)
                || activity_required(payload, "result_omitted")? != &Value::Bool(true)
                || activity_required(payload, "content_omitted")? != &Value::Bool(true)
            {
                return invalid("Structured tool activity has an invalid safe summary");
            }
        }
        "file_change" => {
            let changes = activity_required(payload, "changes")?
                .as_array()
                .ok_or_else(|| {
                    projection_error(
                        "projection_activity_invalid",
                        "Structured file changes must be an array",
                    )
                })?;
            if changes.len() > 128
                || changes.iter().any(|change| {
                    let Some(change) = change.as_object() else {
                        return true;
                    };
                    !change
                        .get("path")
                        .is_some_and(|value| activity_bounded_text(value, 2_048))
                        || !change
                            .get("kind")
                            .is_some_and(|value| activity_bounded_text(value, 256))
                        || !change
                            .get("original_bytes")
                            .is_some_and(activity_non_negative_integer)
                        || !change
                            .get("added_lines")
                            .is_some_and(activity_non_negative_integer)
                        || !change
                            .get("removed_lines")
                            .is_some_and(activity_non_negative_integer)
                })
            {
                return invalid("Structured file activity has an invalid change summary");
            }
            let count = activity_required(payload, "change_count")?.as_u64();
            let truncated = activity_required(payload, "changes_truncated")?.as_bool();
            if count.is_none()
                || truncated.is_none()
                || count.is_some_and(|count| count > 9_007_199_254_740_991)
                || matches!((count, truncated), (Some(count), Some(false)) if count != changes.len() as u64)
                || matches!((count, truncated), (Some(count), Some(true)) if count <= changes.len() as u64)
                || activity_required(payload, "content_omitted")? != &Value::Bool(true)
            {
                return invalid("Structured file activity count or omission marker is invalid");
            }
        }
        "diff" => {
            if !activity_non_negative_integer(activity_required(payload, "original_bytes")?)
                || !activity_non_negative_integer(activity_required(payload, "added_lines")?)
                || !activity_non_negative_integer(activity_required(payload, "removed_lines")?)
                || activity_required(payload, "content_omitted")? != &Value::Bool(true)
            {
                return invalid("Structured diff activity has an invalid safe summary");
            }
        }
        "plan" if item_id.is_some() => {
            if !activity_required(payload, "text")?
                .as_str()
                .is_some_and(|text| text.len() <= 16_384 && !text.contains('\0'))
                || !activity_non_negative_integer(activity_required(payload, "original_bytes")?)
                || !activity_required(payload, "truncated")?.is_boolean()
                || !activity_required(payload, "redacted")?.is_boolean()
            {
                return invalid("Structured plan item has an invalid safe summary");
            }
        }
        "plan" => {
            let steps = activity_required(payload, "steps")?
                .as_array()
                .ok_or_else(|| {
                    projection_error(
                        "projection_activity_invalid",
                        "Structured plan steps must be an array",
                    )
                })?;
            if steps.len() > 64
                || steps.iter().any(|step| {
                    let Some(step) = step.as_object() else {
                        return true;
                    };
                    !matches!(
                        step.get("status").and_then(Value::as_str),
                        Some("pending" | "inProgress" | "completed")
                    ) || !step.get("text").is_some_and(|value| {
                        value
                            .as_str()
                            .is_some_and(|text| text.len() <= 2_048 && !text.contains('\0'))
                    }) || !step.get("truncated").is_some_and(Value::is_boolean)
                        || !step.get("redacted").is_some_and(Value::is_boolean)
                })
            {
                return invalid("Structured turn plan has an invalid step summary");
            }
            let count = activity_required(payload, "step_count")?.as_u64();
            let truncated = activity_required(payload, "steps_truncated")?.as_bool();
            let explanation = activity_required(payload, "explanation")?;
            if count.is_none()
                || truncated.is_none()
                || count.is_some_and(|count| count > 9_007_199_254_740_991)
                || matches!((count, truncated), (Some(count), Some(false)) if count != steps.len() as u64)
                || matches!((count, truncated), (Some(count), Some(true)) if count <= steps.len() as u64)
                || !(explanation.is_null()
                    || explanation
                        .as_str()
                        .is_some_and(|text| text.len() <= 4_096 && !text.contains('\0')))
                || !activity_required(payload, "explanation_truncated")?.is_boolean()
                || !activity_required(payload, "explanation_redacted")?.is_boolean()
            {
                return invalid("Structured turn plan count or explanation is invalid");
            }
        }
        _ => return invalid("Structured activity kind is unsupported"),
    }
    Ok(())
}

fn validate_activity_detail(value: &Value, depth: usize) -> AppResult<()> {
    if depth > 4 {
        return Err(projection_error(
            "projection_activity_invalid",
            "Activity detail nesting is too deep",
        ));
    }
    match value {
        Value::Null | Value::Bool(_) => Ok(()),
        Value::Number(number) if number.as_i64().is_some() || number.as_u64().is_some() => Ok(()),
        Value::String(text) => {
            if text.len() > MAX_TEXT_BYTES || text.chars().any(|value| value == '\0') {
                Err(projection_error(
                    "projection_activity_invalid",
                    "Activity detail text is invalid",
                ))
            } else {
                Ok(())
            }
        }
        Value::Array(items) if items.len() <= MAX_PAGE_SIZE as usize => {
            for item in items {
                validate_activity_detail(item, depth + 1)?;
            }
            Ok(())
        }
        Value::Object(object) if object.len() <= 16 => {
            for (key, child) in object {
                if !matches!(
                    key.as_str(),
                    "path"
                        | "kind"
                        | "original_bytes"
                        | "added_lines"
                        | "removed_lines"
                        | "status"
                        | "text"
                        | "truncated"
                        | "redacted"
                ) {
                    return Err(projection_error(
                        "projection_activity_invalid",
                        "Activity detail object has an unsupported field",
                    ));
                }
                validate_activity_detail(child, depth + 1)?;
            }
            Ok(())
        }
        _ => Err(projection_error(
            "projection_activity_invalid",
            "Activity detail value is unsupported",
        )),
    }
}

fn activity_from_event(event: &ProjectionEvent) -> AppResult<Option<ProjectedActivity>> {
    let expected_kind = match projected_activity_kind(&event.kind) {
        Some(kind) => kind,
        None => return Ok(None),
    };
    let payload = payload_map(&event.payload).ok_or_else(|| {
        projection_error(
            "projection_activity_invalid",
            "Structured activity payload must be an object",
        )
    })?;
    if payload.get("visibility").and_then(Value::as_str) != Some("public") {
        return Ok(None);
    }
    let payload_kind = payload
        .get("activity_kind")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            projection_error(
                "projection_activity_invalid",
                "Structured activity kind is missing",
            )
        })?;
    if payload_kind != expected_kind {
        return Err(projection_error(
            "projection_activity_invalid",
            "Structured activity kind contradicts the event kind",
        ));
    }
    let state = payload
        .get("activity_state")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            projection_error(
                "projection_activity_invalid",
                "Structured activity state is missing",
            )
        })?;
    if !activity_state_matches(&event.kind, state) {
        return Err(projection_error(
            "projection_activity_invalid",
            "Structured activity state contradicts its lifecycle event",
        ));
    }
    validate_activity_payload_shape(expected_kind, event.item_id.as_deref(), payload)?;
    let thread_id = event.thread_id.clone().ok_or_else(|| {
        projection_error(
            "projection_activity_invalid",
            "Structured activity has no thread",
        )
    })?;
    let turn_id = event.turn_id.clone().ok_or_else(|| {
        projection_error(
            "projection_activity_invalid",
            "Structured activity has no turn",
        )
    })?;
    let target_agent_id = event.agent_id.clone().ok_or_else(|| {
        projection_error(
            "projection_activity_invalid",
            "Structured activity has no owning agent",
        )
    })?;
    validate_id(&thread_id, "activity.threadId")?;
    validate_id(&turn_id, "activity.turnId")?;
    validate_id(&target_agent_id, "activity.targetAgentId")?;
    validate_optional_id(event.item_id.as_deref(), "activity.itemId")?;
    let title = payload
        .get("title")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            projection_error(
                "projection_activity_invalid",
                "Structured activity title is missing",
            )
        })?
        .to_owned();
    validate_text(&title, "activity.title")?;
    let mut details = Map::new();
    for (source, target) in activity_detail_fields(expected_kind) {
        if let Some(value) = payload.get(*source) {
            validate_activity_detail(value, 0)?;
            details.insert((*target).to_owned(), value.clone());
        }
    }
    let identity = format!(
        "orquesta.projection.activity.v1\0{}\0{}\0{}\0{}",
        thread_id,
        turn_id,
        expected_kind,
        event.item_id.as_deref().unwrap_or(expected_kind)
    );
    let activity_id = format!(
        "projection-activity-v1-{}",
        hex::encode(Sha256::digest(identity.as_bytes()))
    );
    Ok(Some(ProjectedActivity {
        activity_id,
        thread_id,
        turn_id,
        item_id: event.item_id.clone(),
        target_agent_id,
        kind: expected_kind.into(),
        state: state.into(),
        title,
        details: Value::Object(details),
        created_at: event.occurred_at.clone(),
        updated_at: event.occurred_at.clone(),
        last_journal_sequence: event.journal_sequence,
    }))
}

fn provider_activity_from_record(record: &ProviderActivityRecord) -> AppResult<ProjectedActivity> {
    validate_timestamp(&record.occurred_at, "providerActivity.occurredAt")?;
    let event = ProjectionEvent {
        schema_version: PROJECTION_SCHEMA_VERSION,
        domain_event_version: None,
        source_event_id: None,
        owner: None,
        stream_id: "provider-history".into(),
        journal_sequence: 0,
        event_id: "provider-history-activity".into(),
        source_runtime: "codex_app_server_history".into(),
        source_cursor: None,
        project_id: "provider-history".into(),
        agent_id: Some(record.target_agent_id.clone()),
        task_id: None,
        thread_id: Some(record.thread_id.clone()),
        turn_id: Some(record.turn_id.clone()),
        item_id: record.item_id.clone(),
        kind: record.event_type.clone(),
        phase: record
            .event_type
            .rsplit('.')
            .next()
            .unwrap_or("completed")
            .into(),
        occurred_at: record.occurred_at.clone(),
        payload: record.payload.clone(),
        evidence_ref: None,
        storage: Value::Object(Map::new()),
    };
    activity_from_event(&event)?.ok_or_else(|| {
        projection_error(
            "projection_page_invalid",
            "Provider activity kind is not projectable",
        )
    })
}

fn insert_provider_activity(
    transaction: &Transaction<'_>,
    record: &ProviderActivityRecord,
) -> AppResult<bool> {
    let activity = provider_activity_from_record(record)?;
    let details_json = serde_json::to_string(&activity.details)
        .map_err(|error| projection_error("projection_page_invalid", error.to_string()))?;
    let existing: Option<(String, String, Option<String>, String, String, String, String, String, String, i64)> = transaction.query_row(
        "SELECT thread_id, turn_id, item_id, target_agent_id, kind, state, title, details_json, created_at, last_sequence
         FROM activities WHERE activity_id = ?1",
        [&activity.activity_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?, row.get(8)?, row.get(9)?)),
    ).optional().map_err(|error| sqlite_error("read provider activity identity", error))?;
    if let Some(existing) = existing {
        if existing.0 != activity.thread_id
            || existing.1 != activity.turn_id
            || existing.2 != activity.item_id
            || existing.3 != activity.target_agent_id
            || existing.4 != activity.kind
        {
            return Err(projection_error(
                "projection_activity_conflict",
                "Provider activity identity changed",
            ));
        }
        if existing.9 > 0 {
            return Ok(false);
        }
        if existing.5 == activity.state
            && existing.6 == activity.title
            && existing.7 == details_json
            && existing.8 == activity.created_at
        {
            return Ok(false);
        }
        return Err(projection_error(
            "projection_activity_conflict",
            "Provider activity content changed",
        ));
    }
    transaction.execute(
        "INSERT INTO activities(activity_id, thread_id, turn_id, item_id, target_agent_id, kind, state, title, details_json, created_at, updated_at, first_sequence, last_sequence)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0, 0)",
        params![activity.activity_id, activity.thread_id, activity.turn_id, activity.item_id,
            activity.target_agent_id, activity.kind, activity.state, activity.title, details_json,
            activity.created_at, activity.updated_at],
    ).map_err(|error| sqlite_error("backfill provider activity", error))?;
    Ok(true)
}

fn update_activity(transaction: &Transaction<'_>, event: &ProjectionEvent) -> AppResult<()> {
    let activity = match activity_from_event(event)? {
        Some(activity) => activity,
        None => return Ok(()),
    };
    let existing: Option<(String, String, Option<String>, String, String, i64)> = transaction.query_row(
        "SELECT thread_id, turn_id, item_id, target_agent_id, kind, last_sequence FROM activities WHERE activity_id = ?1",
        [&activity.activity_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
    ).optional().map_err(|error| sqlite_error("read structured activity identity", error))?;
    let details_json = serde_json::to_string(&activity.details)
        .map_err(|error| projection_error("projection_activity_invalid", error.to_string()))?;
    if let Some(existing) = existing {
        if existing.0 != activity.thread_id
            || existing.1 != activity.turn_id
            || existing.2 != activity.item_id
            || existing.3 != activity.target_agent_id
            || existing.4 != activity.kind
            || event.journal_sequence <= existing.5
        {
            return Err(projection_error(
                "projection_activity_conflict",
                "Structured activity identity or chronology changed",
            ));
        }
        transaction.execute(
            "UPDATE activities SET state = ?2, title = ?3, details_json = ?4, updated_at = ?5, last_sequence = ?6 WHERE activity_id = ?1",
            params![activity.activity_id, activity.state, activity.title, details_json, activity.updated_at, event.journal_sequence],
        ).map_err(|error| sqlite_error("update structured activity", error))?;
        return Ok(());
    }
    transaction.execute(
        "INSERT INTO activities(activity_id, thread_id, turn_id, item_id, target_agent_id, kind, state, title, details_json, created_at, updated_at, first_sequence, last_sequence)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, ?11, ?11)",
        params![activity.activity_id, activity.thread_id, activity.turn_id, activity.item_id, activity.target_agent_id,
            activity.kind, activity.state, activity.title, details_json, activity.created_at, event.journal_sequence],
    ).map_err(|error| sqlite_error("insert structured activity", error))?;
    Ok(())
}

fn update_turn_and_item(transaction: &Transaction<'_>, event: &ProjectionEvent) -> AppResult<()> {
    if let (Some(thread_id), Some(turn_id)) = (&event.thread_id, &event.turn_id) {
        if let Some(state) = turn_lifecycle_state(event) {
            let existing = transaction
                .query_row(
                    "SELECT state, last_sequence FROM turns WHERE thread_id = ?1 AND turn_id = ?2",
                    params![thread_id, turn_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
                )
                .optional()
                .map_err(|error| sqlite_error("read projected turn lifecycle", error))?;
            let projected_state = reduce_turn_lifecycle_state(
                existing
                    .as_ref()
                    .map(|(current, sequence)| (current.as_str(), *sequence)),
                state,
                event.journal_sequence,
            );
            transaction.execute(
                "INSERT INTO turns(thread_id, turn_id, state, last_sequence) VALUES(?1, ?2, ?3, ?4)
                  ON CONFLICT(thread_id, turn_id) DO UPDATE SET state = excluded.state, last_sequence = MAX(turns.last_sequence, excluded.last_sequence)",
                params![thread_id, turn_id, projected_state, event.journal_sequence],
            ).map_err(|error| sqlite_error("update projected turn lifecycle", error))?;
            if is_terminal_turn_state(&projected_state) {
                transaction
                    .execute(
                        "UPDATE turns
                         SET mutation_kind = NULL, mutation_identity = NULL, mutation_phase = NULL
                         WHERE thread_id = ?1 AND turn_id = ?2",
                        params![thread_id, turn_id],
                    )
                    .map_err(|error| {
                        sqlite_error("clear terminal exact-turn mutation claim", error)
                    })?;
                transaction
                    .execute(
                        "DELETE FROM streaming_messages WHERE thread_id = ?1 AND turn_id = ?2",
                        params![thread_id, turn_id],
                    )
                    .map_err(|error| {
                        sqlite_error("clear terminal turn streaming messages", error)
                    })?;
                // A stopped or otherwise terminal turn may never receive an
                // item/completed frame for work that was in flight. Keeping
                // that card as `running` after the turn is terminal would be
                // false. Close only unresolved running activities as unknown;
                // a later, higher-sequence item event can still replace this
                // provisional state with completed or failed evidence.
                transaction
                    .execute(
                        "UPDATE activities
                         SET state = 'unknown', updated_at = ?3, last_sequence = ?4
                         WHERE thread_id = ?1 AND turn_id = ?2
                           AND state = 'running' AND last_sequence < ?4",
                        params![
                            thread_id,
                            turn_id,
                            event.occurred_at,
                            event.journal_sequence
                        ],
                    )
                    .map_err(|error| {
                        sqlite_error("close terminal turn running activities", error)
                    })?;
            }
        } else {
            transaction.execute(
                "INSERT INTO turns(thread_id, turn_id, state, last_sequence) VALUES(?1, ?2, 'unknown', ?3)
                 ON CONFLICT(thread_id, turn_id) DO UPDATE SET last_sequence = MAX(turns.last_sequence, excluded.last_sequence)",
                params![thread_id, turn_id, event.journal_sequence],
            ).map_err(|error| sqlite_error("update projected turn chronology", error))?;
        }
        if let Some(item_id) = &event.item_id {
            transaction
                .execute(
                    "INSERT OR IGNORE INTO items(thread_id, turn_id, item_id) VALUES(?1, ?2, ?3)",
                    params![thread_id, turn_id, item_id],
                )
                .map_err(|error| sqlite_error("update projected item", error))?;
        }
    }
    Ok(())
}

fn turn_lifecycle_state(event: &ProjectionEvent) -> Option<&str> {
    match event.kind.as_str() {
        "turn.accepted" => Some("accepted"),
        "turn.started" => Some("in_progress"),
        "turn.interrupt_accepted" => Some("interrupting"),
        "turn.completed" => event
            .payload
            .get("status")
            .and_then(Value::as_str)
            .filter(|status| {
                matches!(
                    *status,
                    "completed" | "failed" | "interrupted" | "cancelled"
                )
            })
            .or(Some("completed")),
        "turn.failed" => Some("failed"),
        _ => None,
    }
}

fn reduce_turn_lifecycle_state(
    existing: Option<(&str, i64)>,
    incoming: &str,
    incoming_sequence: i64,
) -> String {
    let Some((current, current_sequence)) = existing else {
        return incoming.to_owned();
    };
    if incoming_sequence < current_sequence || is_terminal_turn_state(current) {
        return current.to_owned();
    }
    if turn_lifecycle_rank(incoming) >= turn_lifecycle_rank(current) {
        incoming.to_owned()
    } else {
        current.to_owned()
    }
}

fn turn_lifecycle_rank(state: &str) -> u8 {
    match state {
        "accepted" => 1,
        "in_progress" => 2,
        "interrupting" => 3,
        "completed" | "failed" | "interrupted" | "cancelled" => 4,
        _ => 0,
    }
}

fn is_terminal_turn_state(state: &str) -> bool {
    matches!(state, "completed" | "failed" | "interrupted" | "cancelled")
}

fn request_key(event: &ProjectionEvent, payload: &Map<String, Value>) -> Option<String> {
    string_field(payload, payload, &["requestKey", "request_key"])
        .map(str::to_owned)
        .or_else(|| event.item_id.clone())
}

fn update_pending_request(
    transaction: &Transaction<'_>,
    event: &ProjectionEvent,
    runtime_connection_id: Option<&str>,
) -> AppResult<()> {
    let payload = match payload_map(&event.payload) {
        Some(value) => value,
        None => return Ok(()),
    };
    if event.kind == "attention.approval_requested"
        || event.kind == "attention.user_input_requested"
    {
        let key = request_key(event, payload).ok_or_else(|| {
            projection_error(
                "projection_request_invalid",
                "Pending request has no stable request key",
            )
        })?;
        validate_id(&key, "requestKey")?;
        let prompt = string_field(payload, payload, &["prompt", "label"]).map(str::to_owned);
        if let Some(prompt) = prompt.as_deref() {
            validate_text(prompt, "request.prompt")?;
        }
        let method = string_field(payload, payload, &["method"]).map(str::to_owned);
        if let Some(method) = method.as_deref() {
            validate_id(method, "request.method")?;
        }
        let response_options = payload
            .get("responseOptions")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if response_options.len() > 32 {
            return Err(projection_error(
                "projection_request_invalid",
                "Pending request has too many response options",
            ));
        }
        for option in &response_options {
            validate_text(option, "request.responseOption")?;
        }
        let response_options_json = serde_json::to_string(&response_options)
            .map_err(|error| projection_error("projection_request_invalid", error.to_string()))?;
        let provider_connection_id = string_field(
            payload,
            payload,
            &["providerConnectionId", "provider_connection_id"],
        )
        .map(str::to_owned);
        if let Some(provider_connection_id) = provider_connection_id.as_deref() {
            validate_id(provider_connection_id, "providerConnectionId")?;
        }
        let provider_request_id = string_field(payload, payload, &["requestId", "request_id"])
            .map(str::to_owned);
        if let Some(provider_request_id) = provider_request_id.as_deref() {
            validate_id(provider_request_id, "providerRequestId")?;
        }
        let requested_effect_kind = payload
            .get("requestedEffect")
            .and_then(Value::as_object)
            .and_then(|effect| effect.get("kind"))
            .and_then(Value::as_str)
            .map(|kind| match kind {
                "file_change" | "command_execution" => kind.to_owned(),
                _ => "other".to_owned(),
            });
        transaction
            .execute(
                "INSERT INTO pending_requests(
                 request_key, event_id, thread_id, turn_id, agent_id, request_kind,
                 method, response_options_json, prompt, status, created_at, resolved_at,
                 runtime_connection_id, provider_connection_id, provider_request_id,
                 requested_effect_kind,
                 response_identity, response_decision, response_phase)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'pending', ?10, NULL,
                    ?11, ?12, ?13, ?14, NULL, NULL, NULL)
             ON CONFLICT(request_key) DO NOTHING",
                params![
                    key,
                    event.event_id,
                    event.thread_id,
                    event.turn_id,
                    event.agent_id,
                    event.kind,
                    method,
                    response_options_json,
                    prompt,
                    event.occurred_at,
                    runtime_connection_id,
                    provider_connection_id,
                    provider_request_id,
                    requested_effect_kind,
                ],
            )
            .map_err(|error| sqlite_error("project pending request", error))?;
    } else if event.kind == "attention.response_submitted" {
        // Legacy journals may contain Core-owned response events. They can close
        // only rows that predate the exact Provider request binding introduced in
        // v16; current approvals are terminally transitioned by Native commands.
        if let Some(key) = request_key(event, payload) {
            transaction.execute(
                "UPDATE pending_requests SET status = 'resolved', resolved_at = COALESCE(resolved_at, ?2)
                 WHERE request_key = ?1 AND status = 'pending' AND provider_request_id IS NULL",
                params![key, event.occurred_at],
            ).map_err(|error| sqlite_error("resolve legacy projected request", error))?;
        }
    } else if event.kind == "attention.request_resolved" {
        let resolution = payload.get("resolution").and_then(Value::as_str);
        if resolution == Some("expired") {
            if let (Some(thread_id), Some(turn_id)) =
                (event.thread_id.as_deref(), event.turn_id.as_deref())
            {
                transaction.execute(
                    "UPDATE pending_requests
                     SET status = 'resolved', resolved_at = COALESCE(resolved_at, ?3)
                     WHERE thread_id = ?1 AND turn_id = ?2 AND status = 'pending'",
                    params![thread_id, turn_id, event.occurred_at],
                ).map_err(|error| sqlite_error("expire projected requests for turn", error))?;
            }
        } else if let Some(key) = request_key(event, payload) {
            transaction.execute(
                "UPDATE pending_requests SET status = 'resolved', resolved_at = COALESCE(resolved_at, ?2)
                 WHERE request_key = ?1 AND status = 'pending'
                   AND (request_kind != 'attention.approval_requested' OR provider_request_id IS NULL)",
                params![key, event.occurred_at],
            ).map_err(|error| sqlite_error("resolve projected request", error))?;
        }
    }
    Ok(())
}

fn merge_provider_turn(
    transaction: &Transaction<'_>,
    page_thread_id: &str,
    turn: &ProviderTurnRecord,
) -> AppResult<()> {
    if turn.thread_id != page_thread_id {
        return Err(projection_error(
            "projection_page_invalid",
            "Provider turn is not bound to its page thread",
        ));
    }
    validate_id(&turn.thread_id, "providerTurn.threadId")?;
    validate_id(&turn.turn_id, "providerTurn.turnId")?;
    validate_id(&turn.state, "providerTurn.state")?;
    if turn.item_ids.len() > MAX_BACKFILL_RECORDS {
        return Err(projection_error(
            "projection_page_too_large",
            "Provider turn item list exceeds its bounded limit",
        ));
    }
    transaction
        .execute(
            "INSERT INTO turns(thread_id, turn_id, state, last_sequence) VALUES(?1, ?2, ?3, 0)
             ON CONFLICT(thread_id, turn_id) DO UPDATE SET
               state = CASE
                 WHEN turns.state IN ('completed', 'failed', 'interrupted', 'cancelled') THEN turns.state
                 WHEN excluded.state IN ('completed', 'failed', 'interrupted', 'cancelled') THEN excluded.state
                 ELSE turns.state
               END,
               mutation_kind = CASE
                 WHEN turns.state IN ('completed', 'failed', 'interrupted', 'cancelled')
                   OR excluded.state IN ('completed', 'failed', 'interrupted', 'cancelled')
                 THEN NULL ELSE turns.mutation_kind
               END,
               mutation_identity = CASE
                 WHEN turns.state IN ('completed', 'failed', 'interrupted', 'cancelled')
                   OR excluded.state IN ('completed', 'failed', 'interrupted', 'cancelled')
                 THEN NULL ELSE turns.mutation_identity
               END,
               mutation_phase = CASE
                 WHEN turns.state IN ('completed', 'failed', 'interrupted', 'cancelled')
                   OR excluded.state IN ('completed', 'failed', 'interrupted', 'cancelled')
                 THEN NULL ELSE turns.mutation_phase
               END",
            params![turn.thread_id, turn.turn_id, turn.state],
        )
        .map_err(|error| sqlite_error("backfill provider turn", error))?;
    for item_id in &turn.item_ids {
        validate_id(item_id, "providerTurn.itemId")?;
        transaction
            .execute(
                "INSERT OR IGNORE INTO items(thread_id, turn_id, item_id) VALUES(?1, ?2, ?3)",
                params![turn.thread_id, turn.turn_id, item_id],
            )
            .map_err(|error| sqlite_error("backfill provider turn item", error))?;
    }
    Ok(())
}

fn apply_provider_page_to_connection(
    connection: &mut Connection,
    project_id: &str,
    page: &ProviderPage,
) -> AppResult<usize> {
    validate_id(project_id, "projectId")?;
    validate_provider_page(page)?;
    let bytes = serde_json::to_vec(page)
        .map_err(|error| projection_error("projection_page_invalid", error.to_string()))?;
    let content_hash = hex::encode(Sha256::digest(&bytes));
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| sqlite_error("begin provider page projection", error))?;
    let existing: Option<String> = transaction
        .query_row(
            "SELECT content_hash FROM provider_pages WHERE page_id = ?1",
            [&page.page_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| sqlite_error("check provider page identity", error))?;
    if let Some(existing) = existing {
        if existing != content_hash {
            return Err(projection_error(
                "projection_page_conflict",
                "Provider page identity has different content",
            ));
        }
        for turn in &page.turns {
            merge_provider_turn(&transaction, &page.thread_id, turn)?;
        }
        transaction
            .commit()
            .map_err(|error| sqlite_error("close idempotent provider page", error))?;
        return Ok(0);
    }
    let mut inserted = 0usize;
    for record in &page.records {
        if record.thread_id != page.thread_id {
            return Err(projection_error(
                "projection_page_invalid",
                "Provider record is not bound to its page thread",
            ));
        }
        let message = ProjectionMessage {
            message_id: record.message_id.clone(),
            thread_id: record.thread_id.clone(),
            turn_id: record.turn_id.clone(),
            target_agent_id: record.target_agent_id.clone(),
            role: record.role.clone(),
            text: record.text.clone(),
            created_at: record.created_at.clone(),
            journal_sequence: None,
            origin: "provider_page".into(),
        };
        inserted += usize::from(insert_message(&transaction, &message, None, true)?);
    }
    for activity in &page.activities {
        inserted += usize::from(insert_provider_activity(&transaction, activity)?);
    }
    for turn in &page.turns {
        merge_provider_turn(&transaction, &page.thread_id, turn)?;
    }
    transaction.execute(
        "INSERT INTO provider_pages(page_id, thread_id, content_hash, next_cursor, is_complete) VALUES(?1, ?2, ?3, ?4, ?5)",
        params![page.page_id, page.thread_id, content_hash, page.next_cursor, i64::from(page.is_complete)],
    ).map_err(|error| sqlite_error("record provider page", error))?;
    let revised = transaction.execute(
        "UPDATE projection_meta SET projection_revision = projection_revision + 1, updated_at = ?2 WHERE project_id = ?1",
        params![project_id, page.records.last().map(|record| record.created_at.as_str()).unwrap_or("1970-01-01T00:00:00.000Z")],
    ).map_err(|error| sqlite_error("advance provider projection revision", error))?;
    if revised != 1 {
        return Err(projection_error(
            "projection_meta_missing",
            "Provider history cannot be imported before the durable project stream is initialized",
        ));
    }
    transaction
        .commit()
        .map_err(|error| sqlite_error("commit provider page projection", error))?;
    Ok(inserted)
}

fn message_row(row: &Row<'_>) -> rusqlite::Result<ProjectionMessage> {
    Ok(ProjectionMessage {
        message_id: row.get(0)?,
        thread_id: row.get(1)?,
        turn_id: row.get(2)?,
        target_agent_id: row.get(3)?,
        role: row.get(4)?,
        text: row.get(5)?,
        created_at: row.get(6)?,
        journal_sequence: row.get(7)?,
        origin: row.get(8)?,
    })
}

fn query_agent_page(
    connection: &Connection,
    target_agent_id: &str,
    cursor: Option<&ProjectionCursor>,
    limit: usize,
) -> AppResult<ProjectionPage> {
    let fetch = limit + 1;
    let mut statement = connection.prepare(match cursor {
        Some(_) => {
            "SELECT message_id, thread_id, turn_id, target_agent_id, role, text, created_at, journal_sequence, origin
             FROM messages WHERE target_agent_id = ?1
               AND (created_at < ?2 OR (created_at = ?2 AND message_id < ?3))
             ORDER BY created_at DESC, message_id DESC LIMIT ?4"
        }
        None => {
            "SELECT message_id, thread_id, turn_id, target_agent_id, role, text, created_at, journal_sequence, origin
             FROM messages WHERE target_agent_id = ?1
             ORDER BY created_at DESC, message_id DESC LIMIT ?2"
        }
    }).map_err(|error| sqlite_error("prepare agent conversation page", error))?;
    let rows = match cursor {
        Some(cursor) => statement.query_map(
            params![
                target_agent_id,
                cursor.before_created_at,
                cursor.before_message_id,
                fetch as i64
            ],
            message_row,
        ),
        None => statement.query_map(params![target_agent_id, fetch as i64], message_row),
    }
    .map_err(|error| sqlite_error("query agent conversation page", error))?;
    let mut items = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| sqlite_error("read agent conversation page", error))?;
    let has_more = items.len() > limit;
    if has_more {
        items.truncate(limit);
    }
    items.reverse();
    let next_cursor = if has_more {
        items.first().map(|item| ProjectionCursor {
            before_created_at: item.created_at.clone(),
            before_message_id: item.message_id.clone(),
        })
    } else {
        None
    };
    Ok(ProjectionPage { items, next_cursor })
}

fn query_history_index(
    connection: &Connection,
    project_id: &str,
    cursor: Option<&ProjectionHistoryCursor>,
    limit: usize,
) -> AppResult<ProjectionHistoryIndexPage> {
    fn summary_row(row: &Row<'_>) -> rusqlite::Result<ProjectionConversationSummary> {
        Ok(ProjectionConversationSummary {
            target_agent_id: row.get(0)?,
            updated_at: row.get(1)?,
            last_message_id: row.get(2)?,
            preview: row.get(3)?,
            last_role: row.get(4)?,
        })
    }
    let fetch = limit + 1;
    let mut statement = connection
        .prepare(match cursor {
            Some(_) => {
                "SELECT ci.target_agent_id, ci.updated_at, ci.last_message_id, ci.preview, m.role
                 FROM conversation_index ci
                 JOIN messages m ON m.message_id = ci.last_message_id
                 WHERE ci.updated_at < ?1 OR (ci.updated_at = ?1 AND ci.last_message_id < ?2)
                 ORDER BY ci.updated_at DESC, ci.last_message_id DESC LIMIT ?3"
            }
            None => {
                "SELECT ci.target_agent_id, ci.updated_at, ci.last_message_id, ci.preview, m.role
                 FROM conversation_index ci
                 JOIN messages m ON m.message_id = ci.last_message_id
                 ORDER BY ci.updated_at DESC, ci.last_message_id DESC LIMIT ?1"
            }
        })
        .map_err(|error| sqlite_error("prepare conversation history index", error))?;
    let rows = match cursor {
        Some(cursor) => statement.query_map(
            params![
                cursor.before_updated_at,
                cursor.before_message_id,
                fetch as i64
            ],
            summary_row,
        ),
        None => statement.query_map(params![fetch as i64], summary_row),
    }
    .map_err(|error| sqlite_error("query conversation history index", error))?;
    let mut items = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| sqlite_error("read conversation history index", error))?;
    let has_more = items.len() > limit;
    if has_more {
        items.truncate(limit);
    }
    let next_cursor = if has_more {
        items.last().map(|item| ProjectionHistoryCursor {
            before_updated_at: item.updated_at.clone(),
            before_message_id: item.last_message_id.clone(),
        })
    } else {
        None
    };
    Ok(ProjectionHistoryIndexPage {
        project_id: project_id.to_owned(),
        items,
        next_cursor,
    })
}

struct StoredActivity {
    activity_id: String,
    thread_id: String,
    turn_id: String,
    item_id: Option<String>,
    target_agent_id: String,
    kind: String,
    state: String,
    title: String,
    details_json: String,
    created_at: String,
    updated_at: String,
    last_journal_sequence: i64,
}

fn stored_activity_row(row: &Row<'_>) -> rusqlite::Result<StoredActivity> {
    Ok(StoredActivity {
        activity_id: row.get(0)?,
        thread_id: row.get(1)?,
        turn_id: row.get(2)?,
        item_id: row.get(3)?,
        target_agent_id: row.get(4)?,
        kind: row.get(5)?,
        state: row.get(6)?,
        title: row.get(7)?,
        details_json: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
        last_journal_sequence: row.get(11)?,
    })
}

fn project_stored_activity(value: StoredActivity) -> AppResult<ProjectedActivity> {
    let details: Value = serde_json::from_str(&value.details_json)
        .map_err(|error| projection_error("projection_activity_corrupt", error.to_string()))?;
    let detail_object = details.as_object().ok_or_else(|| {
        projection_error(
            "projection_activity_corrupt",
            "Stored activity details are not an object",
        )
    })?;
    for detail in detail_object.values() {
        validate_activity_detail(detail, 0)?;
    }
    Ok(ProjectedActivity {
        activity_id: value.activity_id,
        thread_id: value.thread_id,
        turn_id: value.turn_id,
        item_id: value.item_id,
        target_agent_id: value.target_agent_id,
        kind: value.kind,
        state: value.state,
        title: value.title,
        details,
        created_at: value.created_at,
        updated_at: value.updated_at,
        last_journal_sequence: value.last_journal_sequence,
    })
}

fn query_agent_activity_page(
    connection: &Connection,
    target_agent_id: &str,
    cursor: Option<&ProjectionActivityCursor>,
    limit: usize,
) -> AppResult<ProjectedActivityPage> {
    let fetch = limit + 1;
    let mut stored = if let Some(cursor) = cursor {
        let mut statement = connection.prepare(
            "SELECT activity_id, thread_id, turn_id, item_id, target_agent_id, kind, state, title, details_json, created_at, updated_at, last_sequence
             FROM activities WHERE target_agent_id = ?1
               AND (created_at < ?2 OR (created_at = ?2 AND activity_id < ?3))
             ORDER BY created_at DESC, activity_id DESC LIMIT ?4",
        ).map_err(|error| sqlite_error("prepare older structured activity page", error))?;
        let rows = statement
            .query_map(
                params![
                    target_agent_id,
                    cursor.before_created_at,
                    cursor.before_activity_id,
                    fetch as i64
                ],
                stored_activity_row,
            )
            .map_err(|error| sqlite_error("query older structured activity page", error))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| sqlite_error("read older structured activity page", error))?
    } else {
        let mut statement = connection.prepare(
            "SELECT activity_id, thread_id, turn_id, item_id, target_agent_id, kind, state, title, details_json, created_at, updated_at, last_sequence
             FROM activities WHERE target_agent_id = ?1
             ORDER BY created_at DESC, activity_id DESC LIMIT ?2",
        ).map_err(|error| sqlite_error("prepare latest structured activity page", error))?;
        let rows = statement
            .query_map(params![target_agent_id, fetch as i64], stored_activity_row)
            .map_err(|error| sqlite_error("query latest structured activity page", error))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| sqlite_error("read latest structured activity page", error))?
    };
    let has_more = stored.len() > limit;
    if has_more {
        stored.truncate(limit);
    }
    stored.reverse();
    let next_cursor = if has_more {
        stored.first().map(|item| ProjectionActivityCursor {
            before_created_at: item.created_at.clone(),
            before_activity_id: item.activity_id.clone(),
        })
    } else {
        None
    };
    let items = stored
        .into_iter()
        .map(project_stored_activity)
        .collect::<AppResult<Vec<_>>>()?;
    Ok(ProjectedActivityPage { items, next_cursor })
}

fn query_agent_activity_updates(
    connection: &Connection,
    target_agent_id: &str,
    after_journal_sequence: i64,
    limit: usize,
) -> AppResult<Option<Vec<ProjectedActivity>>> {
    let mut statement = connection.prepare(
        "SELECT activity_id, thread_id, turn_id, item_id, target_agent_id, kind, state, title, details_json, created_at, updated_at, last_sequence
         FROM activities WHERE target_agent_id = ?1 AND last_sequence > ?2
         ORDER BY last_sequence ASC, activity_id ASC LIMIT ?3",
    ).map_err(|error| sqlite_error("prepare changed structured activities", error))?;
    let rows = statement
        .query_map(
            params![target_agent_id, after_journal_sequence, (limit + 1) as i64],
            stored_activity_row,
        )
        .map_err(|error| sqlite_error("query changed structured activities", error))?;
    let mut stored = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| sqlite_error("read changed structured activities", error))?;
    if stored.len() > limit {
        return Ok(None);
    }
    let items = stored
        .drain(..)
        .map(project_stored_activity)
        .collect::<AppResult<Vec<_>>>()?;
    Ok(Some(items))
}

fn query_streaming_messages(
    connection: &Connection,
    target_agent_id: &str,
) -> AppResult<Vec<StreamingProjectionMessage>> {
    let mut statement = connection.prepare(
        "SELECT message_id, thread_id, turn_id, item_id, target_agent_id, text, created_at, updated_at, last_sequence
         FROM streaming_messages WHERE target_agent_id = ?1 ORDER BY first_sequence, message_id LIMIT ?2",
    ).map_err(|error| sqlite_error("prepare streaming conversation messages", error))?;
    let rows = statement
        .query_map(params![target_agent_id, MAX_PAGE_SIZE as i64], |row| {
            Ok(StreamingProjectionMessage {
                message_id: row.get(0)?,
                thread_id: row.get(1)?,
                turn_id: row.get(2)?,
                item_id: row.get(3)?,
                target_agent_id: row.get(4)?,
                role: "agent".into(),
                text: row.get(5)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
                last_journal_sequence: row.get(8)?,
            })
        })
        .map_err(|error| sqlite_error("query streaming conversation messages", error))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| sqlite_error("read streaming conversation messages", error))
}

fn query_active_turns(
    connection: &Connection,
    target_agent_id: &str,
) -> AppResult<Vec<ActiveTurnProjection>> {
    let mut statement = connection
        .prepare(
            "SELECT t.thread_id, t.turn_id, t.state, t.last_sequence
         FROM turns t
         WHERE t.state IN ('accepted', 'in_progress', 'interrupting')
           AND (SELECT e.agent_id FROM events e
                WHERE e.thread_id = t.thread_id AND e.turn_id = t.turn_id AND e.agent_id IS NOT NULL
                ORDER BY e.journal_sequence DESC LIMIT 1) = ?1
         ORDER BY t.last_sequence, t.thread_id, t.turn_id LIMIT ?2",
        )
        .map_err(|error| sqlite_error("prepare active agent turns", error))?;
    let rows = statement
        .query_map(params![target_agent_id, MAX_PAGE_SIZE as i64], |row| {
            Ok(ActiveTurnProjection {
                thread_id: row.get(0)?,
                turn_id: row.get(1)?,
                target_agent_id: target_agent_id.into(),
                state: row.get(2)?,
                last_journal_sequence: row.get(3)?,
            })
        })
        .map_err(|error| sqlite_error("query active agent turns", error))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| sqlite_error("read active agent turns", error))
}

fn query_latest_turn(
    connection: &Connection,
    target_agent_id: &str,
) -> AppResult<Option<ActiveTurnProjection>> {
    connection
        .query_row(
            "SELECT t.thread_id, t.turn_id, t.state, t.last_sequence
         FROM turns t
         WHERE (SELECT e.agent_id FROM events e
                WHERE e.thread_id = t.thread_id AND e.turn_id = t.turn_id AND e.agent_id IS NOT NULL
                ORDER BY e.journal_sequence DESC LIMIT 1) = ?1
         ORDER BY t.last_sequence DESC, t.thread_id DESC, t.turn_id DESC LIMIT 1",
            [target_agent_id],
            |row| {
                Ok(ActiveTurnProjection {
                    thread_id: row.get(0)?,
                    turn_id: row.get(1)?,
                    target_agent_id: target_agent_id.into(),
                    state: row.get(2)?,
                    last_journal_sequence: row.get(3)?,
                })
            },
        )
        .optional()
        .map_err(|error| sqlite_error("read latest agent turn", error))
}

const HISTORY_SEARCH_LATEST_SQL: &str =
    "SELECT message_id, thread_id, turn_id, target_agent_id, role, text, created_at, journal_sequence, origin
     FROM messages WHERE target_agent_id = ?1
     ORDER BY created_at DESC, message_id DESC LIMIT ?2";

const HISTORY_SEARCH_OLDER_SQL: &str =
    "SELECT message_id, thread_id, turn_id, target_agent_id, role, text, created_at, journal_sequence, origin
     FROM messages WHERE target_agent_id = ?1
       AND (created_at < ?2 OR (created_at = ?2 AND message_id < ?3))
     ORDER BY created_at DESC, message_id DESC LIMIT ?4";

fn ascii_fold(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii() {
                character.to_ascii_lowercase()
            } else {
                character
            }
        })
        .collect()
}

fn search_agent_messages(
    connection: &Connection,
    target_agent_id: &str,
    query: &str,
    cursor: Option<&ProjectionCursor>,
    limit: usize,
) -> AppResult<ProjectionPage> {
    let scan_fetch = HISTORY_SEARCH_ROW_BUDGET + 1;
    let mut statement = connection
        .prepare(if cursor.is_some() {
            HISTORY_SEARCH_OLDER_SQL
        } else {
            HISTORY_SEARCH_LATEST_SQL
        })
        .map_err(|error| sqlite_error("prepare bounded agent history search", error))?;
    let mut rows = match cursor {
        Some(cursor) => statement.query(params![
            target_agent_id,
            cursor.before_created_at,
            cursor.before_message_id,
            scan_fetch as i64
        ]),
        None => statement.query(params![target_agent_id, scan_fetch as i64]),
    }
    .map_err(|error| sqlite_error("query bounded agent history search", error))?;
    let folded_query = ascii_fold(query);
    let mut items = Vec::with_capacity(limit + 1);
    let mut scanned_rows = 0usize;
    let mut scanned_text_bytes = 0usize;
    let mut scan_boundary = None;
    let mut continuation_required = false;
    while let Some(row) = rows
        .next()
        .map_err(|error| sqlite_error("read bounded agent history search", error))?
    {
        if scanned_rows >= HISTORY_SEARCH_ROW_BUDGET {
            continuation_required = true;
            break;
        }
        let message = message_row(row)
            .map_err(|error| sqlite_error("decode bounded agent history search", error))?;
        let next_text_bytes = scanned_text_bytes.saturating_add(message.text.len());
        if scanned_rows > 0 && next_text_bytes > HISTORY_SEARCH_TEXT_BUDGET {
            continuation_required = true;
            break;
        }
        scanned_rows += 1;
        scanned_text_bytes = next_text_bytes;
        scan_boundary = Some(ProjectionCursor {
            before_created_at: message.created_at.clone(),
            before_message_id: message.message_id.clone(),
        });
        if ascii_fold(&message.text).contains(&folded_query) {
            items.push(message);
            if items.len() > limit {
                continuation_required = true;
                break;
            }
        }
    }
    let result_has_more = items.len() > limit;
    if result_has_more {
        items.truncate(limit);
    }
    items.reverse();
    let next_cursor = if result_has_more {
        items.first().map(|item| ProjectionCursor {
            before_created_at: item.created_at.clone(),
            before_message_id: item.message_id.clone(),
        })
    } else if continuation_required {
        scan_boundary
    } else {
        None
    };
    Ok(ProjectionPage { items, next_cursor })
}

fn pending_request_authority_fingerprint(
    current_runtime_generation: Option<&str>,
    current_provider_connection_id: Option<&str>,
) -> String {
    let mut digest = Sha256::new();
    for value in [current_runtime_generation, current_provider_connection_id] {
        let bytes = value.unwrap_or_default().as_bytes();
        digest.update((bytes.len() as u64).to_be_bytes());
        digest.update(bytes);
    }
    hex::encode(digest.finalize())
}

fn decode_pending_request_cursor(
    encoded: Option<&str>,
    authority_fingerprint: &str,
) -> AppResult<Option<PendingRequestCursorToken>> {
    let Some(encoded) = encoded else {
        return Ok(None);
    };
    let cursor = serde_json::from_str::<PendingRequestCursorToken>(encoded).map_err(|_| {
        projection_error(
            "projection_pending_request_cursor_invalid",
            "Pending request cursor is malformed",
        )
    })?;
    if cursor.schema_version != PENDING_REQUEST_CURSOR_SCHEMA_VERSION
        || cursor.recovery_rank > 1
    {
        return Err(projection_error(
            "projection_pending_request_cursor_invalid",
            "Pending request cursor has an unsupported schema or rank",
        ));
    }
    validate_timestamp(
        &cursor.before_created_at,
        "pendingRequestCursor.beforeCreatedAt",
    )?;
    validate_id(
        &cursor.before_request_key,
        "pendingRequestCursor.beforeRequestKey",
    )?;
    if cursor.authority_fingerprint != authority_fingerprint {
        return Err(projection_error(
            "projection_pending_request_cursor_stale",
            "Pending request authority changed; restart this bounded read",
        ));
    }
    Ok(Some(cursor))
}

fn encode_pending_request_cursor(
    recovery_rank: u8,
    before_created_at: &str,
    before_request_key: &str,
    authority_fingerprint: &str,
) -> AppResult<String> {
    serde_json::to_string(&PendingRequestCursorToken {
        schema_version: PENDING_REQUEST_CURSOR_SCHEMA_VERSION,
        recovery_rank,
        before_created_at: before_created_at.to_owned(),
        before_request_key: before_request_key.to_owned(),
        authority_fingerprint: authority_fingerprint.to_owned(),
    })
    .map_err(|error| {
        projection_error(
            "projection_pending_request_cursor_invalid",
            format!("Pending request cursor could not be encoded: {error}"),
        )
    })
}

fn query_pending_requests(
    connection: &Connection,
    limit: usize,
    current_runtime_generation: Option<&str>,
    current_provider_connection_id: Option<&str>,
    encoded_cursor: Option<&str>,
) -> AppResult<PendingRequestPage> {
    let authority_fingerprint = pending_request_authority_fingerprint(
        current_runtime_generation,
        current_provider_connection_id,
    );
    let cursor = decode_pending_request_cursor(encoded_cursor, &authority_fingerprint)?;
    let cursor_rank = cursor
        .as_ref()
        .map(|value| i64::from(value.recovery_rank));
    let cursor_created_at = cursor
        .as_ref()
        .map(|value| value.before_created_at.as_str());
    let cursor_request_key = cursor
        .as_ref()
        .map(|value| value.before_request_key.as_str());
    let mut statement = connection
        .prepare(
            "WITH classified AS (
               SELECT request_key, agent_id, request_kind, response_options_json, prompt,
                      created_at, requested_effect_kind, response_phase, status,
                      provider_request_id, provider_connection_id, runtime_connection_id,
                      method, thread_id, turn_id,
                      CASE WHEN request_kind = 'attention.approval_requested'
                             AND status = 'pending' AND response_phase IS NULL
                             AND provider_request_id IS NOT NULL AND provider_request_id != ''
                             AND provider_connection_id = ?2
                             AND runtime_connection_id = ?1
                             AND thread_id IS NOT NULL AND thread_id != ''
                             AND turn_id IS NOT NULL AND turn_id != ''
                             AND ((method = 'item/fileChange/requestApproval'
                                   AND requested_effect_kind = 'file_change')
                               OR (method = 'item/commandExecution/requestApproval'
                                   AND requested_effect_kind = 'command_execution'))
                             AND EXISTS (
                               SELECT 1
                               FROM json_each(
                                 CASE WHEN json_valid(response_options_json)
                                   THEN response_options_json ELSE '[]' END
                               ) AS offered
                               WHERE offered.type = 'text'
                                 AND offered.value IN ('accept', 'acceptForSession', 'decline', 'cancel')
                             )
                           THEN 0 ELSE 1 END AS recovery_rank
               FROM pending_requests
               WHERE status = 'pending' OR response_phase = 'outcome_unknown'
             )
             SELECT request_key, agent_id, request_kind, response_options_json, prompt,
                    created_at, requested_effect_kind, response_phase, status,
                    provider_request_id, provider_connection_id, runtime_connection_id,
                    method, thread_id, turn_id, recovery_rank
             FROM classified
             WHERE ?3 IS NULL
                OR recovery_rank > ?3
                OR (recovery_rank = ?3
                    AND (created_at > ?4 OR (created_at = ?4 AND request_key > ?5)))
             ORDER BY recovery_rank ASC, created_at ASC, request_key ASC
             LIMIT ?6",
        )
        .map_err(|error| sqlite_error("prepare bounded pending request page", error))?;
    let mut rows = statement
        .query(params![
            current_runtime_generation,
            current_provider_connection_id,
            cursor_rank,
            cursor_created_at,
            cursor_request_key,
            (limit + 1) as i64,
        ])
        .map_err(|error| sqlite_error("query bounded pending request page", error))?;
    let mut ranked = Vec::with_capacity(limit + 1);
    while let Some(row) = rows
        .next()
        .map_err(|error| sqlite_error("read bounded pending request page", error))?
    {
        let request_key = row
            .get::<_, String>(0)
            .map_err(|error| sqlite_error("decode pending request key", error))?;
        let request_kind = row
            .get::<_, String>(2)
            .map_err(|error| sqlite_error("decode pending request kind", error))?;
        let response_options = parse_response_options(
            row.get::<_, String>(3)
                .map_err(|error| sqlite_error("decode pending response options", error))?,
        )
        .map_err(|error| sqlite_error("parse pending response options", error))?;
        let created_at = row
            .get::<_, String>(5)
            .map_err(|error| sqlite_error("decode pending request time", error))?;
        let requested_effect_kind = row
            .get::<_, Option<String>>(6)
            .map_err(|error| sqlite_error("decode pending request effect", error))?;
        let response_phase = row
            .get::<_, Option<String>>(7)
            .map_err(|error| sqlite_error("decode pending response phase", error))?;
        let status = row
            .get::<_, String>(8)
            .map_err(|error| sqlite_error("decode pending request status", error))?;
        let provider_request_id = row
            .get::<_, Option<String>>(9)
            .map_err(|error| sqlite_error("decode pending provider request", error))?;
        let provider_connection_id = row
            .get::<_, Option<String>>(10)
            .map_err(|error| sqlite_error("decode pending provider connection", error))?;
        let runtime_connection_id = row
            .get::<_, Option<String>>(11)
            .map_err(|error| sqlite_error("decode pending runtime connection", error))?;
        let method = row
            .get::<_, Option<String>>(12)
            .map_err(|error| sqlite_error("decode pending request method", error))?;
        let thread_id = row
            .get::<_, Option<String>>(13)
            .map_err(|error| sqlite_error("decode pending request thread", error))?;
        let turn_id = row
            .get::<_, Option<String>>(14)
            .map_err(|error| sqlite_error("decode pending request turn", error))?;
        let sql_rank = row
            .get::<_, i64>(15)
            .map_err(|error| sqlite_error("decode pending recovery rank", error))?;
        let exact_live_binding = status == "pending"
            && response_phase.is_none()
            && request_kind == "attention.approval_requested"
            && provider_request_id
                .as_deref()
                .is_some_and(|value| !value.is_empty())
            && thread_id.as_deref().is_some_and(|value| !value.is_empty())
            && turn_id.as_deref().is_some_and(|value| !value.is_empty())
            && approval_method_matches_effect(method.as_deref(), requested_effect_kind.as_deref())
            && has_supported_desktop_approval_decision(&response_options)
            && current_runtime_generation.is_some_and(|current| {
                runtime_connection_id.as_deref() == Some(current)
            })
            && current_provider_connection_id.is_some_and(|current| {
                provider_connection_id.as_deref() == Some(current)
            });
        let recovery_rank = if exact_live_binding { 0 } else { 1 };
        if sql_rank != i64::from(recovery_rank) {
            return Err(projection_error(
                "projection_pending_request_classification_mismatch",
                "SQLite and Native disagreed about approval actionability",
            ));
        }
        ranked.push((
            PendingRequest {
                request_key: request_key.clone(),
                agent_id: row
                    .get(1)
                    .map_err(|error| sqlite_error("decode pending request agent", error))?,
                request_kind,
                response_options,
                prompt: row
                    .get(4)
                    .map_err(|error| sqlite_error("decode pending request prompt", error))?,
                created_at: created_at.clone(),
                requested_effect_kind,
                response_phase,
                recovery_state: if exact_live_binding {
                    "actionable"
                } else {
                    "stale"
                }
                .into(),
            },
            recovery_rank,
            created_at,
            request_key,
        ));
    }
    let has_more = ranked.len() > limit;
    if has_more {
        ranked.pop();
    }
    let next_cursor = if has_more {
        ranked
            .last()
            .map(|(_, rank, created_at, request_key)| {
                encode_pending_request_cursor(
                    *rank,
                    created_at,
                    request_key,
                    &authority_fingerprint,
                )
            })
            .transpose()?
    } else {
        None
    };
    Ok(PendingRequestPage {
        items: ranked.into_iter().map(|(item, _, _, _)| item).collect(),
        next_cursor,
    })
}

fn query_resolved_requests(connection: &Connection, limit: usize) -> AppResult<Vec<ResolvedRequest>> {
    let mut statement = connection.prepare(
        "SELECT request_key, agent_id, request_kind, response_options_json, created_at, resolved_at,
                requested_effect_kind, response_decision
         FROM pending_requests
         WHERE status = 'resolved' AND resolved_at IS NOT NULL
           AND request_kind = 'attention.approval_requested'
           AND response_phase = 'accepted' AND response_decision IS NOT NULL
         ORDER BY resolved_at DESC, request_key DESC LIMIT ?1",
    ).map_err(|error| sqlite_error("prepare resolved requests", error))?;
    let rows = statement
        .query_map([limit as i64], |row| {
            Ok(ResolvedRequest {
                request_key: row.get(0)?,
                agent_id: row.get(1)?,
                request_kind: row.get(2)?,
                response_options: parse_response_options(row.get::<_, String>(3)?)?,
                created_at: row.get(4)?,
                resolved_at: row.get(5)?,
                requested_effect_kind: row.get(6)?,
                response_decision: row.get(7)?,
            })
        })
        .map_err(|error| sqlite_error("query resolved requests", error))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| sqlite_error("read resolved requests", error))
}

fn parse_response_options(value: String) -> rusqlite::Result<Vec<String>> {
    serde_json::from_str::<Vec<String>>(&value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            value.len(),
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

fn snapshot_from_connection(
    connection: &Connection,
    project_id: &str,
) -> AppResult<ProjectionSnapshot> {
    let meta: Option<(String, i64, i64)> = connection
        .query_row(
            "SELECT stream_id, applied_sequence, projection_revision FROM projection_meta WHERE project_id = ?1",
            [project_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|error| sqlite_error("read projection snapshot watermark", error))?;
    let event_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM events", [], |row| row.get(0))
        .map_err(|error| sqlite_error("count projected events", error))?;
    let message_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM messages", [], |row| row.get(0))
        .map_err(|error| sqlite_error("count projected messages", error))?;
    let pending_request_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM pending_requests WHERE status = 'pending' OR response_phase = 'outcome_unknown'",
            [],
            |row| row.get(0),
        )
        .map_err(|error| sqlite_error("count pending requests", error))?;
    let mut statement = connection.prepare(
        "SELECT t.thread_id, t.turn_id, t.state, COUNT(i.item_id), t.last_sequence
         FROM turns t LEFT JOIN items i ON i.thread_id = t.thread_id AND i.turn_id = t.turn_id
         GROUP BY t.thread_id, t.turn_id, t.state, t.last_sequence ORDER BY t.thread_id, t.last_sequence, t.turn_id",
    ).map_err(|error| sqlite_error("prepare projected turns", error))?;
    let rows = statement
        .query_map([], |row| {
            Ok(TurnProjection {
                thread_id: row.get(0)?,
                turn_id: row.get(1)?,
                state: row.get(2)?,
                item_count: row.get(3)?,
                last_journal_sequence: row.get(4)?,
            })
        })
        .map_err(|error| sqlite_error("query projected turns", error))?;
    let turns = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| sqlite_error("read projected turns", error))?;
    Ok(ProjectionSnapshot {
        project_id: project_id.into(),
        stream_id: meta.as_ref().map(|value| value.0.clone()),
        applied_journal_sequence: meta.as_ref().map_or(0, |value| value.1),
        projection_revision: meta.map_or(0, |value| value.2),
        event_count,
        message_count,
        pending_request_count,
        turns,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        root: PathBuf,
        service: ProjectionService,
    }

    impl Fixture {
        fn uninitialized() -> Self {
            let root = std::env::temp_dir()
                .join(format!("orquesta-next-projection-test-{}", Uuid::new_v4()));
            let app_data = root.join("app-data");
            let service = ProjectionService::open_trusted(app_data.join("projection"), app_data)
                .expect("open projection fixture");
            Self { root, service }
        }

        fn new() -> Self {
            let fixture = Self::uninitialized();
            fixture
                .service
                .initialize_project("project-a")
                .expect("initialize registered projection fixture");
            fixture
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn new_project_initialization_is_idempotent_and_keeps_one_stream() {
        let fixture = Fixture::uninitialized();
        let first = fixture
            .service
            .initialize_project("project-a")
            .expect("initialize new project");
        let second = fixture
            .service
            .initialize_project("project-a")
            .expect("replay the same explicit initialization");
        assert_eq!(first.stream_id, second.stream_id);
        assert!(fixture
            .service
            .database_path_for_test("project-a")
            .is_file());
    }

    #[test]
    fn registered_project_with_missing_sqlite_fails_without_recreating_it() {
        let fixture = Fixture::new();
        let path = fixture.service.database_path_for_test("project-a");
        fs::remove_file(&path).expect("simulate missing durable SQLite");

        let error = fixture
            .service
            .require_existing_project("project-a")
            .expect_err("registered project must fail closed");
        assert_eq!(error.code, "projection_database_missing");
        assert!(!path.exists());
    }

    #[test]
    fn corrupt_registered_sqlite_fails_without_overwriting_evidence() {
        let fixture = Fixture::new();
        let path = fixture.service.database_path_for_test("project-a");
        let evidence = b"not a sqlite database";
        fs::write(&path, evidence).expect("write corrupt durable SQLite");

        assert!(fixture
            .service
            .require_existing_project("project-a")
            .is_err());
        assert_eq!(fs::read(path).expect("read retained evidence"), evidence);
    }

    #[test]
    fn existing_sqlite_without_registered_project_identity_is_not_reinitialized() {
        let fixture = Fixture::new();
        let path = fixture.service.database_path_for_test("project-a");
        let connection = Connection::open(&path).expect("open durable SQLite fixture");
        connection
            .execute(
                "DELETE FROM projection_meta WHERE project_id = 'project-a'",
                [],
            )
            .expect("remove registered project identity");
        drop(connection);

        let error = fixture
            .service
            .require_existing_project("project-a")
            .expect_err("missing project identity must fail closed");
        assert_eq!(error.code, "projection_database_invalid");
        let connection = Connection::open(path).expect("inspect retained SQLite fixture");
        let project_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM projection_meta", [], |row| row.get(0))
            .expect("count retained project identities");
        assert_eq!(project_count, 0);
    }

    #[test]
    fn provider_refresh_fails_fast_and_cannot_recreate_missing_durable_sqlite() {
        let fixture = Fixture::new();
        let path = fixture.service.database_path_for_test("project-a");
        fs::remove_file(&path).expect("simulate missing durable SQLite");

        let preflight = fixture
            .service
            .provider_backfill_required("project-a", "provider-a")
            .expect_err("provider preflight must fail before collecting pages");
        assert_eq!(preflight.code, "projection_database_missing");
        let refresh = fixture
            .service
            .refresh_provider_pages("project-a", "provider-a", &[])
            .expect_err("provider refresh must not recreate durable SQLite");
        assert_eq!(refresh.code, "projection_database_missing");
        assert!(!path.exists());
    }

    #[test]
    fn provider_identity_preflight_rejects_meta_loss_before_any_refresh_write() {
        let fixture = Fixture::new();
        let path = fixture.service.database_path_for_test("project-a");
        let connection = Connection::open(&path).expect("open durable SQLite fixture");
        connection
            .execute(
                "DELETE FROM projection_meta WHERE project_id = 'project-a'",
                [],
            )
            .expect("remove registered project identity");
        drop(connection);
        let page = ProviderPage {
            page_id: "provider-page-preflight".into(),
            thread_id: "thread-preflight".into(),
            requested_cursor: None,
            next_cursor: None,
            is_complete: true,
            records: Vec::new(),
            activities: Vec::new(),
            turns: Vec::new(),
        };

        for error in [
            fixture
                .service
                .provider_backfill_required("project-a", "provider-a")
                .expect_err("backfill preflight must reject missing identity"),
            fixture
                .service
                .refresh_provider_pages("project-a", "provider-a", &[])
                .expect_err("empty refresh must reject missing identity"),
            fixture
                .service
                .refresh_provider_pages("project-a", "provider-a", &[page])
                .expect_err("nonempty refresh must reject missing identity"),
        ] {
            assert_eq!(error.code, "projection_database_invalid");
        }
        let connection = Connection::open(path).expect("inspect retained SQLite fixture");
        let (pages, markers, messages): (i64, i64, i64) = connection
            .query_row(
                "SELECT (SELECT COUNT(*) FROM provider_pages),
                        (SELECT COUNT(*) FROM provider_backfill_state),
                        (SELECT COUNT(*) FROM messages WHERE origin = 'provider_page')",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("count provider writes");
        assert_eq!((pages, markers, messages), (0, 0, 0));
    }

    #[test]
    fn ready_empty_or_foreign_database_is_rejected_without_migration() {
        let empty = Fixture::uninitialized();
        let empty_path = empty.service.database_path_for_test("project-a");
        drop(Connection::open(&empty_path).expect("create empty SQLite"));
        let empty_before = fs::read(&empty_path).expect("read empty SQLite before");
        let empty_error = empty
            .service
            .require_existing_project("project-a")
            .expect_err("ready empty SQLite must fail closed");
        assert_eq!(empty_error.code, "projection_database_invalid");
        assert_eq!(
            fs::read(&empty_path).expect("read empty SQLite after"),
            empty_before
        );

        let foreign = Fixture::new();
        let foreign_path = foreign.service.database_path_for_test("project-a");
        let connection = Connection::open(&foreign_path).expect("open foreign fixture");
        connection
            .execute(
                "UPDATE projection_meta SET project_id = 'project-foreign' WHERE project_id = 'project-a'",
                [],
            )
            .expect("seed foreign identity");
        connection
            .pragma_update(None, "user_version", 14)
            .expect("seed old schema marker");
        drop(connection);
        let foreign_error = foreign
            .service
            .require_existing_project("project-a")
            .expect_err("wrong old-schema identity must fail before migration");
        assert_eq!(foreign_error.code, "projection_database_invalid");
        let connection = Connection::open(foreign_path).expect("inspect foreign fixture");
        let version: u32 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("read preserved schema marker");
        let identities: Vec<String> = connection
            .prepare("SELECT project_id FROM projection_meta ORDER BY project_id")
            .expect("prepare identity query")
            .query_map([], |row| row.get(0))
            .expect("query identities")
            .collect::<Result<Vec<_>, _>>()
            .expect("read identities");
        assert_eq!(version, 14);
        assert_eq!(identities, vec!["project-foreign"]);
    }

    #[test]
    fn pending_retry_rejects_foreign_identity_without_mixing_projects() {
        let fixture = Fixture::new();
        let path = fixture.service.database_path_for_test("project-a");
        let connection = Connection::open(&path).expect("open pending retry fixture");
        connection
            .execute(
                "UPDATE projection_meta SET project_id = 'project-foreign' WHERE project_id = 'project-a'",
                [],
            )
            .expect("seed foreign identity");
        let version_before: u32 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("read version before");
        drop(connection);

        let error = fixture
            .service
            .initialize_project("project-a")
            .expect_err("pending retry must reject foreign durable identity");
        assert_eq!(error.code, "projection_database_invalid");
        let connection = Connection::open(path).expect("inspect pending retry fixture");
        let version_after: u32 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("read version after");
        let identities: Vec<String> = connection
            .prepare("SELECT project_id FROM projection_meta ORDER BY project_id")
            .expect("prepare identities")
            .query_map([], |row| row.get(0))
            .expect("query identities")
            .collect::<Result<Vec<_>, _>>()
            .expect("read identities");
        assert_eq!(version_after, version_before);
        assert_eq!(identities, vec!["project-foreign"]);
    }

    #[test]
    fn pending_retry_rejects_identity_loss_when_owned_rows_remain() {
        let fixture = Fixture::new();
        let path = fixture.service.database_path_for_test("project-a");
        let connection = Connection::open(&path).expect("open pending ownership fixture");
        connection
            .execute(
                "INSERT INTO messages(message_id, thread_id, role, text, created_at, origin)
                 VALUES('message-owned', 'thread-owned', 'user', 'owned', '2026-08-30T00:00:00.000Z', 'provider_page')",
                [],
            )
            .expect("seed durable owned row");
        connection
            .execute("DELETE FROM projection_meta", [])
            .expect("remove project identity");
        let version_before: u32 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("read version before");
        drop(connection);

        let error = fixture
            .service
            .initialize_project("project-a")
            .expect_err("pending retry must not adopt identity-less owned rows");
        assert_eq!(error.code, "projection_database_invalid");
        let connection = Connection::open(path).expect("inspect retained ownership fixture");
        let (version_after, identities, messages): (u32, i64, i64) = connection
            .query_row(
                "SELECT (SELECT user_version FROM pragma_user_version),
                        (SELECT COUNT(*) FROM projection_meta),
                        (SELECT COUNT(*) FROM messages)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("read retained ownership state");
        assert_eq!(version_after, version_before);
        assert_eq!((identities, messages), (0, 1));
    }

    #[test]
    fn ready_identity_preflight_rejects_exact_plus_foreign_before_provider_writes() {
        let fixture = Fixture::new();
        let path = fixture.service.database_path_for_test("project-a");
        let connection = Connection::open(&path).expect("open ambiguous identity fixture");
        connection
            .execute(
                "INSERT INTO projection_meta(project_id, stream_id, applied_sequence, projection_revision, updated_at)
                 VALUES('project-foreign', 'stream-foreign', 0, 0, '1970-01-01T00:00:00.000Z')",
                [],
            )
            .expect("seed foreign identity beside exact identity");
        let version_before: u32 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("read version before");
        drop(connection);

        for error in [
            fixture
                .service
                .require_existing_project("project-a")
                .expect_err("ready open must reject ambiguous identities"),
            fixture
                .service
                .provider_backfill_required("project-a", "provider-a")
                .expect_err("provider preflight must reject ambiguous identities"),
            fixture
                .service
                .refresh_provider_pages("project-a", "provider-a", &[])
                .expect_err("provider refresh must reject ambiguous identities"),
        ] {
            assert_eq!(error.code, "projection_database_invalid");
        }
        let connection = Connection::open(path).expect("inspect ambiguous identity fixture");
        let (version_after, identities, markers, pages): (u32, i64, i64, i64) = connection
            .query_row(
                "SELECT (SELECT user_version FROM pragma_user_version),
                        (SELECT COUNT(*) FROM projection_meta),
                        (SELECT COUNT(*) FROM provider_backfill_state),
                        (SELECT COUNT(*) FROM provider_pages)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("read retained ambiguous state");
        assert_eq!(version_after, version_before);
        assert_eq!((identities, markers, pages), (2, 0, 0));
    }

    fn timestamp(sequence: i64) -> String {
        let millis = sequence.rem_euclid(1000);
        let seconds = (sequence / 1000).rem_euclid(60);
        let minutes = (sequence / 60_000).rem_euclid(60);
        format!("2026-08-16T10:{minutes:02}:{seconds:02}.{millis:03}Z")
    }

    fn event(sequence: i64, role: Option<&str>, text: Option<String>) -> ProjectionEvent {
        let item_id = format!("message-{sequence:06}");
        let payload = match (role, text) {
            (Some(role), Some(text)) => serde_json::json!({
                "message": {"messageId": item_id, "role": role, "text": text, "targetAgentId": "orchestrator"}
            }),
            _ => serde_json::json!({}),
        };
        ProjectionEvent {
            schema_version: 1,
            domain_event_version: None,
            source_event_id: None,
            owner: None,
            stream_id: "stream-a".into(),
            journal_sequence: sequence,
            event_id: format!("evt_{sequence:064x}"),
            source_runtime: "codex_app_server".into(),
            source_cursor: Some(format!("cursor:{sequence}")),
            project_id: "project-a".into(),
            agent_id: Some("orchestrator".into()),
            task_id: Some("task-a".into()),
            thread_id: Some("thread-a".into()),
            turn_id: Some("turn-a".into()),
            item_id: Some(item_id),
            kind: "item.completed".into(),
            phase: "completed".into(),
            occurred_at: timestamp(sequence),
            payload,
            evidence_ref: Some("test://projection".into()),
            storage: serde_json::json!({"truncated": false, "blob_ref": null}),
        }
    }

    fn domain_event(sequence: i64, role: Option<&str>, text: Option<String>) -> ProjectionEvent {
        let mut event = event(sequence, role, text);
        event.domain_event_version = Some(1);
        event.owner = Some(DomainEventOwner {
            kind: "agent".into(),
            agent_id: event.agent_id.clone(),
            execution_id: None,
            system_id: None,
        });
        event.source_event_id = Some(
            expected_source_event_id(&event).expect("construct canonical domain source identity"),
        );
        event
    }

    fn domain_envelope(
        sequence: i64,
        role: Option<&str>,
        text: Option<String>,
    ) -> DomainEventEnvelope {
        let event = domain_event(sequence, role, text);
        DomainEventEnvelope {
            domain_event_version: event.domain_event_version.expect("domain version"),
            source_event_id: event.source_event_id.expect("domain source identity"),
            source_runtime: event.source_runtime,
            source_cursor: event.source_cursor,
            owner: event.owner.expect("domain owner"),
            agent_id: event.agent_id,
            task_id: event.task_id,
            thread_id: event.thread_id,
            turn_id: event.turn_id,
            item_id: event.item_id,
            kind: event.kind,
            phase: event.phase,
            occurred_at: event.occurred_at,
            payload: event.payload,
            evidence_ref: event.evidence_ref,
        }
    }

    fn domain_envelope_from_projection(mut event: ProjectionEvent) -> DomainEventEnvelope {
        event.domain_event_version.get_or_insert(1);
        if event.owner.is_none() {
            event.owner = Some(match event.agent_id.clone() {
                Some(agent_id) => DomainEventOwner {
                    kind: "agent".into(),
                    agent_id: Some(agent_id),
                    execution_id: None,
                    system_id: None,
                },
                None => DomainEventOwner {
                    kind: "system".into(),
                    agent_id: None,
                    execution_id: None,
                    system_id: Some("orquesta-native".into()),
                },
            });
        }
        event.source_event_id = Some(
            expected_source_event_id(&event).expect("construct canonical domain source identity"),
        );
        DomainEventEnvelope {
            domain_event_version: event.domain_event_version.expect("domain version"),
            source_event_id: event.source_event_id.expect("domain source identity"),
            source_runtime: event.source_runtime,
            source_cursor: event.source_cursor,
            owner: event.owner.expect("domain owner"),
            agent_id: event.agent_id,
            task_id: event.task_id,
            thread_id: event.thread_id,
            turn_id: event.turn_id,
            item_id: event.item_id,
            kind: event.kind,
            phase: event.phase,
            occurred_at: event.occurred_at,
            payload: event.payload,
            evidence_ref: event.evidence_ref,
        }
    }

    fn approval_projection_event(sequence: i64, request_key: &str) -> ProjectionEvent {
        let mut event = domain_event(sequence, None, None);
        event.item_id = Some(request_key.into());
        event.kind = "attention.approval_requested".into();
        event.phase = "pending".into();
        event.payload = serde_json::json!({
            "requestKey": request_key,
            "method": "item/commandExecution/requestApproval",
            "providerConnectionId": "provider-a",
            "requestId": format!("provider-request-{request_key}"),
            "requestedEffect": {
                "kind": "command_execution",
                "itemId": format!("command-item-{request_key}"),
            },
            "responseOptions": ["accept", "decline"],
            "prompt": "Run command?",
            "visibility": "public",
        });
        event
    }

    fn approval_domain_envelope(sequence: i64, request_key: &str) -> DomainEventEnvelope {
        domain_envelope_from_projection(approval_projection_event(sequence, request_key))
    }

    fn batch(events: Vec<ProjectionEvent>) -> Vec<DomainEventEnvelope> {
        events
            .into_iter()
            .map(domain_envelope_from_projection)
            .collect()
    }

    fn turn_event(sequence: i64, turn_id: &str, state: &str) -> ProjectionEvent {
        let mut turn = event(sequence, None, None);
        turn.turn_id = Some(turn_id.into());
        turn.item_id = None;
        if state == "in_progress" {
            turn.kind = "turn.started".into();
            turn.phase = "started".into();
            turn.payload = serde_json::json!({"status": "in_progress"});
        } else {
            turn.kind = "turn.completed".into();
            turn.phase = "completed".into();
            turn.payload = serde_json::json!({"status": state});
        }
        turn
    }

    fn command_activity_event(
        sequence: i64,
        item_id: &str,
        turn_id: &str,
        state: &str,
    ) -> ProjectionEvent {
        let mut activity = event(sequence, None, None);
        activity.turn_id = Some(turn_id.into());
        activity.item_id = Some(item_id.into());
        activity.kind = match state {
            "running" => "command.started",
            "failed" => "command.failed",
            _ => "command.completed",
        }
        .into();
        activity.phase = match state {
            "running" => "started",
            "failed" => "failed",
            _ => "completed",
        }
        .into();
        activity.payload = serde_json::json!({
            "visibility": "public",
            "activity_kind": "command",
            "activity_state": state,
            "title": "powershell.exe command",
            "command_name": "powershell.exe",
            "action_types": ["read"],
            "action_types_truncated": false,
            "exit_code": if state == "running" { Value::Null } else { serde_json::json!(0) },
            "duration_ms": if state == "running" { Value::Null } else { serde_json::json!(25) },
            "output_present": false,
            "output_bytes": 0,
            "output_text": null,
            "output_truncated": false,
            "output_redacted": false,
            "cwd_omitted": true,
            "command_arguments_omitted": true,
            "content_omitted": true
        });
        activity
    }

    fn conversation_input(limit: u32) -> ProjectionConversationInput {
        ProjectionConversationInput {
            schema_version: 1,
            project_id: "project-a".into(),
            target_agent_id: "orchestrator".into(),
            expected_stream_id: None,
            after_journal_sequence: 0,
            expected_projection_revision: 0,
            cursor: None,
            activity_cursor: None,
            pending_request_cursor: None,
            limit,
        }
    }

    fn agent_message_event(sequence: i64, target_agent_id: &str, text: &str) -> ProjectionEvent {
        let mut message = event(sequence, Some("agent"), Some(text.into()));
        message.agent_id = Some(target_agent_id.into());
        message.thread_id = Some(format!("thread-{target_agent_id}"));
        message.payload = serde_json::json!({
            "message": {
                "messageId": format!("message-{sequence:06}"),
                "role": "agent",
                "text": text,
                "targetAgentId": target_agent_id
            }
        });
        message
    }

    fn assert_history_is_agent_partitioned_cursor_bounded_and_index_only(
        event_count: i64,
        rare_sequence: i64,
        expect_multiple_absent_pages: bool,
    ) {
        let fixture = Fixture::new();
        let events = (1..=event_count)
            .map(|sequence| {
                let agent = match sequence % 3 {
                    0 => "q",
                    1 => "qa",
                    _ => "orchestrator",
                };
                let rare = if sequence == rare_sequence {
                    " 希少語句 AbCd"
                } else if sequence == 3 {
                    " 最旧"
                } else {
                    ""
                };
                agent_message_event(
                    sequence,
                    agent,
                    &format!("日本語検索 共通履歴 {agent} {sequence}{rare}"),
                )
            })
            .collect::<Vec<_>>();
        fixture
            .service
            .ingest_domain_events("project-a", &batch(events))
            .expect("build a large multi-agent history");

        let first_index = fixture
            .service
            .history_index(&ProjectionHistoryIndexInput {
                schema_version: 1,
                project_id: "project-a".into(),
                cursor: None,
                limit: 2,
            })
            .expect("read bounded history index");
        assert_eq!(first_index.items.len(), 2);
        let second_index = fixture
            .service
            .history_index(&ProjectionHistoryIndexInput {
                schema_version: 1,
                project_id: "project-a".into(),
                cursor: first_index.next_cursor,
                limit: 2,
            })
            .expect("read older history index");
        assert_eq!(second_index.items.len(), 1);

        for (query, expected_minimum) in [
            ("日本語", 10usize),
            ("語", 10usize),
            ("日本", 10usize),
            ("bC", 1usize),
        ] {
            let started = std::time::Instant::now();
            let page = fixture
                .service
                .history_page(&ProjectionHistoryPageInput {
                    schema_version: 1,
                    project_id: "project-a".into(),
                    target_agent_id: "q".into(),
                    query: Some(format!("  {query}  ")),
                    cursor: None,
                    limit: 10,
                })
                .expect("search exact short agent partition");
            assert_eq!(page.query.as_deref(), Some(query));
            assert_eq!(page.items.len(), expected_minimum);
            assert!(page
                .items
                .iter()
                .all(|message| message.target_agent_id.as_deref() == Some("q")));
            assert!(started.elapsed() < std::time::Duration::from_secs(5));
        }
        let mut cursor = None;
        let mut oldest_match = Vec::new();
        let mut seen_boundaries = HashSet::new();
        for _ in 0..6 {
            let page = fixture
                .service
                .history_page(&ProjectionHistoryPageInput {
                    schema_version: 1,
                    project_id: "project-a".into(),
                    target_agent_id: "q".into(),
                    query: Some("旧".into()),
                    cursor,
                    limit: 10,
                })
                .expect("advance bounded short search to an old match");
            oldest_match.extend(page.items);
            let Some(next) = page.next_cursor else {
                break;
            };
            assert!(seen_boundaries.insert((
                next.before_created_at.clone(),
                next.before_message_id.clone()
            )));
            cursor = Some(next);
        }
        assert_eq!(oldest_match.len(), 1);
        assert!(oldest_match[0].text.contains("最旧"));

        let mut absent_cursor = None;
        let mut absent_pages = 0;
        loop {
            let page = fixture
                .service
                .history_page(&ProjectionHistoryPageInput {
                    schema_version: 1,
                    project_id: "project-a".into(),
                    target_agent_id: "q".into(),
                    query: Some("無".into()),
                    cursor: absent_cursor,
                    limit: 10,
                })
                .expect("advance bounded absent short search");
            assert!(page.items.is_empty());
            absent_pages += 1;
            absent_cursor = page.next_cursor;
            if absent_cursor.is_none() {
                break;
            }
            assert!(absent_pages < 8);
        }
        if expect_multiple_absent_pages {
            assert!(absent_pages > 1);
        } else {
            assert_eq!(absent_pages, 1);
        }
        let first_common = fixture
            .service
            .history_page(&ProjectionHistoryPageInput {
                schema_version: 1,
                project_id: "project-a".into(),
                target_agent_id: "q".into(),
                query: Some("共通履歴".into()),
                cursor: None,
                limit: 50,
            })
            .expect("read latest common-term search page");
        let second_common = fixture
            .service
            .history_page(&ProjectionHistoryPageInput {
                schema_version: 1,
                project_id: "project-a".into(),
                target_agent_id: "q".into(),
                query: Some("共通履歴".into()),
                cursor: first_common.next_cursor.clone(),
                limit: 50,
            })
            .expect("read older common-term search page");
        let first_ids = first_common
            .items
            .iter()
            .map(|message| message.message_id.as_str())
            .collect::<std::collections::HashSet<_>>();
        assert!(second_common
            .items
            .iter()
            .all(|message| !first_ids.contains(message.message_id.as_str())));
        for query in ["希少語句", "存在しない検索語"] {
            let started = std::time::Instant::now();
            let page = fixture
                .service
                .history_page(&ProjectionHistoryPageInput {
                    schema_version: 1,
                    project_id: "project-a".into(),
                    target_agent_id: "q".into(),
                    query: Some(query.into()),
                    cursor: None,
                    limit: 10,
                })
                .expect("search large history with rare or absent term");
            assert!(page
                .items
                .iter()
                .all(|message| message.target_agent_id.as_deref() == Some("q")));
            assert!(started.elapsed() < std::time::Duration::from_secs(5));
        }

        let connection = Connection::open(fixture.service.database_path_for_test("project-a"))
            .expect("inspect history query plans");
        let index_plan = connection
            .prepare(
                "EXPLAIN QUERY PLAN SELECT target_agent_id, updated_at, last_message_id, preview
                 FROM conversation_index
                 ORDER BY updated_at DESC, last_message_id DESC LIMIT 51",
            )
            .expect("prepare history index plan")
            .query_map([], |row| row.get::<_, String>(3))
            .expect("query history index plan")
            .collect::<Result<Vec<_>, _>>()
            .expect("read history index plan");
        assert!(index_plan
            .iter()
            .any(|detail| detail.contains("idx_conversation_index_page")));
        assert!(!index_plan
            .iter()
            .any(|detail| detail.contains("SCAN messages") || detail.contains("USE TEMP B-TREE")));

        let search_plan_sql = format!("EXPLAIN QUERY PLAN {HISTORY_SEARCH_LATEST_SQL}");
        let search_plan = connection
            .prepare(&search_plan_sql)
            .expect("prepare bounded history search plan")
            .query_map(
                params!["q", (HISTORY_SEARCH_ROW_BUDGET + 1) as i64],
                |row| row.get::<_, String>(3),
            )
            .expect("query bounded history search plan")
            .collect::<Result<Vec<_>, _>>()
            .expect("read bounded history search plan");
        assert!(search_plan
            .iter()
            .any(|detail| detail.contains("idx_messages_target_page")));
        assert!(!search_plan.iter().any(|detail| {
            detail.contains("SCAN messages") || detail.contains("USE TEMP B-TREE")
        }));
    }

    #[test]
    fn history_is_agent_partitioned_cursor_bounded_and_index_only() {
        assert_history_is_agent_partitioned_cursor_bounded_and_index_only(180, 177, false);
    }

    #[test]
    fn history_search_streams_maximum_messages_under_the_text_budget() {
        let fixture = Fixture::new();
        let maximum_text = "x".repeat(MAX_TEXT_BYTES);
        let events = (1..=20)
            .map(|sequence| agent_message_event(sequence, "large", &maximum_text))
            .collect::<Vec<_>>();
        fixture
            .service
            .ingest_domain_events("project-a", &batch(events))
            .expect("build maximum-sized search records");

        let first = fixture
            .service
            .history_page(&ProjectionHistoryPageInput {
                schema_version: 1,
                project_id: "project-a".into(),
                target_agent_id: "large".into(),
                query: Some("無".into()),
                cursor: None,
                limit: 10,
            })
            .expect("read first byte-bounded empty range");
        assert!(first.items.is_empty());
        assert!(first.next_cursor.is_some());

        let second = fixture
            .service
            .history_page(&ProjectionHistoryPageInput {
                schema_version: 1,
                project_id: "project-a".into(),
                target_agent_id: "large".into(),
                query: Some("無".into()),
                cursor: first.next_cursor,
                limit: 10,
            })
            .expect("read remaining byte-bounded empty range");
        assert!(second.items.is_empty());
        assert!(second.next_cursor.is_none());
    }

    #[test]
    fn rust_is_the_single_transactional_writer_for_live_domain_events() {
        let fixture = Fixture::new();
        let first = domain_envelope(1, Some("user"), Some("direct ingest".into()));
        assert_eq!(
            first.source_event_id,
            "src_f6710457ff04e582e345ada713aa76b774e38349db06a272e9a6b3e822344516"
        );
        let receipt = fixture
            .service
            .ingest_domain_events("project-a", std::slice::from_ref(&first))
            .expect("ingest live domain event");
        assert_eq!(receipt.status, "applied");
        assert_eq!(receipt.applied_journal_sequence, 1);
        assert_eq!(receipt.event_count, 1);
        assert_eq!(receipt.message_count, 1);

        let replay = fixture
            .service
            .ingest_domain_events("project-a", std::slice::from_ref(&first))
            .expect("deduplicate live domain event");
        assert_eq!(replay.status, "idempotent");
        assert_eq!(replay.applied_journal_sequence, 1);
        assert_eq!(replay.projection_revision, 1);
        assert_eq!(replay.event_count, 0);

        let second = domain_envelope(2, Some("agent"), Some("second event".into()));
        let appended = fixture
            .service
            .ingest_domain_events("project-a", std::slice::from_ref(&second))
            .expect("append next live domain event");
        assert_eq!(appended.applied_journal_sequence, 2);
        assert_eq!(appended.projection_revision, 2);

        let connection = Connection::open(fixture.service.database_path_for_test("project-a"))
            .expect("inspect live domain event database");
        let stored: (i64, i64, i64, i64) = connection
            .query_row(
                "SELECT (SELECT applied_sequence FROM projection_meta WHERE project_id = 'project-a'), (SELECT projection_revision FROM projection_meta WHERE project_id = 'project-a'), COUNT(*), COUNT(DISTINCT source_event_id) FROM events",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("read atomic event and watermark state");
        assert_eq!(stored, (2, 2, 2, 2));
        let stored_identity: (i64, String, String, String) = connection
            .query_row(
                "SELECT domain_event_version, source_event_id, owner_kind, owner_id FROM events WHERE journal_sequence = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("read persisted domain identity");
        assert_eq!(
            stored_identity,
            (
                1,
                first.source_event_id.clone(),
                "agent".into(),
                "orchestrator".into()
            )
        );
        let first_event_id: String = connection
            .query_row(
                "SELECT event_id FROM events WHERE journal_sequence = 1",
                [],
                |row| row.get(0),
            )
            .expect("read cross-runtime event identity");
        assert_eq!(
            first_event_id,
            "evt_0a529f985574a783a8c007dbfec536c8e5b122dba7950241f770204f7f1ba1bb"
        );
        drop(connection);

        let mut changed_duplicate = first;
        changed_duplicate.payload = serde_json::json!({"message": {
            "messageId": "message-000001",
            "role": "user",
            "text": "changed after persistence",
            "targetAgentId": "orchestrator"
        }});
        assert_eq!(
            fixture
                .service
                .ingest_domain_events("project-a", &[changed_duplicate])
                .expect_err("reject changed duplicate domain event")
                .code,
            "projection_event_conflict"
        );

        let other = Fixture::new();
        let mut forged = domain_envelope(1, Some("user"), Some("forged".into()));
        forged.source_event_id = format!("src_{:064x}", 0);
        assert_eq!(
            other
                .service
                .ingest_domain_events("project-a", &[forged])
                .expect_err("reject forged domain source identity")
                .code,
            "projection_batch_invalid"
        );
    }

    #[test]
    fn provider_refresh_is_additive_and_never_replaces_durable_live_events() {
        let fixture = Fixture::uninitialized();
        let initialized = fixture
            .service
            .initialize_project("project-a")
            .expect("initialize durable project stream");
        let stream_id = initialized.stream_id.expect("initialized stream identity");
        assert_eq!(initialized.applied_journal_sequence, 0);
        fixture
            .service
            .ingest_domain_events(
                "project-a",
                &[domain_envelope(
                    1,
                    Some("agent"),
                    Some("live answer".into()),
                )],
            )
            .expect("persist live event before provider refresh");
        let page = ProviderPage {
            page_id: "background-provider-page".into(),
            thread_id: "thread-history".into(),
            requested_cursor: None,
            next_cursor: None,
            is_complete: true,
            records: vec![ProviderMessageRecord {
                message_id: "history-message".into(),
                thread_id: "thread-history".into(),
                turn_id: None,
                target_agent_id: Some("orchestrator".into()),
                role: "user".into(),
                text: "older provider history".into(),
                created_at: "2026-08-16T09:00:00.000Z".into(),
            }],
            activities: Vec::new(),
            turns: Vec::new(),
        };
        let (refreshed, changed) = fixture
            .service
            .refresh_provider_pages(
                "project-a",
                "provider-generation-a",
                std::slice::from_ref(&page),
            )
            .expect("refresh provider history additively");
        assert_eq!(changed, 1);
        assert_eq!(refreshed.stream_id.as_deref(), Some(stream_id.as_str()));
        assert_eq!(refreshed.applied_journal_sequence, 1);
        assert_eq!(refreshed.projection_revision, 2);
        assert_eq!(refreshed.event_count, 1);
        assert_eq!(refreshed.message_count, 2);
        let (replayed, replayed_changes) = fixture
            .service
            .refresh_provider_pages(
                "project-a",
                "provider-generation-a",
                std::slice::from_ref(&page),
            )
            .expect("repeat provider refresh idempotently");
        assert_eq!(replayed_changes, 0);
        assert_eq!(replayed.projection_revision, 2);
        assert!(!fixture
            .service
            .provider_backfill_required("project-a", "provider-generation-a")
            .expect("refresh marker"));
    }

    #[test]
    fn read_commands_fail_closed_without_creating_missing_durable_sqlite() {
        let fixture = Fixture::uninitialized();
        let project_id = "missing-project";
        let directory = fixture.service.root.join(project_hash(project_id));
        let mut input = conversation_input(10);
        input.project_id = project_id.into();
        assert_eq!(
            fixture
                .service
                .conversation(&input)
                .expect_err("missing durable SQLite must fail closed")
                .code,
            "projection_database_missing"
        );
        assert!(!directory.exists());
    }

    #[test]
    fn product_events_serve_conversation_pages_and_snapshot() {
        let fixture = Fixture::new();
        let original = batch(vec![
            event(1, Some("user"), Some("履歴検索を確認する".into())),
            event(2, Some("agent"), Some("最終回答だけを保存する".into())),
            event(3, Some("user"), Some("追加の依頼".into())),
        ]);
        let receipt = fixture
            .service
            .ingest_domain_events("project-a", &original)
            .expect("apply batch");
        assert_eq!(receipt.applied_journal_sequence, 3);
        assert_eq!(receipt.message_count, 3);
        assert_eq!(
            fixture
                .service
                .ingest_domain_events("project-a", &original)
                .expect("idempotent batch")
                .status,
            "idempotent"
        );

        let latest = fixture
            .service
            .conversation(&conversation_input(2))
            .expect("latest conversation page");
        assert_eq!(
            latest
                .items
                .iter()
                .map(|item| item.message_id.as_str())
                .collect::<Vec<_>>(),
            ["message-000002", "message-000003"]
        );
        let cursor = latest.older_cursor.expect("older cursor");
        let mut older_input = conversation_input(2);
        older_input.cursor = Some(cursor);
        let older = fixture
            .service
            .conversation(&older_input)
            .expect("older conversation page");
        assert_eq!(
            older
                .items
                .iter()
                .map(|item| item.message_id.as_str())
                .collect::<Vec<_>>(),
            ["message-000001"]
        );
        let snapshot = fixture.service.snapshot("project-a").expect("snapshot");
        assert_eq!(snapshot.applied_journal_sequence, 3);
        assert_eq!(snapshot.event_count, 3);
        assert_eq!(snapshot.message_count, 3);
        assert_eq!(snapshot.turns[0].item_count, 3);
    }

    #[test]
    fn conversation_unifies_thread_generations_and_reports_reconnect_states() {
        let fixture = Fixture::new();
        let mut first_generation = event(1, Some("user"), Some("first generation".into()));
        first_generation.thread_id = Some("thread-generation-1".into());
        first_generation.turn_id = Some("turn-generation-1".into());
        let mut second_generation = event(2, Some("agent"), Some("second generation".into()));
        second_generation.thread_id = Some("thread-generation-2".into());
        second_generation.turn_id = Some("turn-generation-2".into());
        let mut newest = event(3, Some("user"), Some("newest generation".into()));
        newest.thread_id = Some("thread-generation-2".into());
        newest.turn_id = Some("turn-generation-3".into());
        fixture
            .service
            .ingest_domain_events(
                "project-a",
                &batch(vec![first_generation, second_generation, newest]),
            )
            .expect("apply multi-generation conversation");

        let current = fixture
            .service
            .conversation(&conversation_input(2))
            .expect("read current conversation snapshot");
        assert_eq!(current.sync_state, "current");
        assert!(current.stream_id.is_some());
        assert_eq!(current.applied_journal_sequence, 3);
        assert_eq!(
            current
                .items
                .iter()
                .map(|item| item.message_id.as_str())
                .collect::<Vec<_>>(),
            ["message-000002", "message-000003"]
        );

        let mut older_input = conversation_input(2);
        older_input.expected_stream_id = current.stream_id.clone();
        older_input.after_journal_sequence = current.applied_journal_sequence;
        older_input.expected_projection_revision = current.projection_revision;
        older_input.cursor = current.older_cursor.clone();
        let older = fixture
            .service
            .conversation(&older_input)
            .expect("read older generation");
        assert_eq!(older.sync_state, "current");
        assert_eq!(older.items.len(), 1);
        assert_eq!(older.items[0].message_id, "message-000001");
        assert_eq!(older.items[0].thread_id, "thread-generation-1");

        let mut advanced_input = conversation_input(50);
        advanced_input.expected_stream_id = current.stream_id.clone();
        advanced_input.after_journal_sequence = 1;
        let advanced = fixture
            .service
            .conversation(&advanced_input)
            .expect("report projection advance");
        assert_eq!(advanced.sync_state, "advanced");
        assert_eq!(advanced.items.len(), 3);

        let mut reset_input = conversation_input(50);
        reset_input.expected_stream_id = Some("old-stream".into());
        reset_input.after_journal_sequence = 3;
        let reset = fixture
            .service
            .conversation(&reset_input)
            .expect("report stream reset");
        assert_eq!(reset.sync_state, "stream_reset");
        assert!(reset.items.is_empty());

        let mut gap_input = conversation_input(50);
        gap_input.expected_stream_id = current.stream_id;
        gap_input.after_journal_sequence = 4;
        let gap = fixture
            .service
            .conversation(&gap_input)
            .expect("report sequence gap");
        assert_eq!(gap.sync_state, "gap");
        assert!(gap.items.is_empty());
    }

    #[test]
    fn older_conversation_pages_do_not_reopen_an_exhausted_activity_cursor() {
        let fixture = Fixture::new();
        let messages = (1..=3)
            .map(|sequence| {
                event(
                    sequence,
                    Some(if sequence % 2 == 0 { "agent" } else { "user" }),
                    Some(format!("message {sequence}")),
                )
            })
            .collect::<Vec<_>>();
        let mut activity = event(4, None, None);
        activity.kind = "diff.updated".into();
        activity.phase = "updated".into();
        activity.item_id = None;
        activity.payload = serde_json::json!({
            "visibility": "public",
            "activity_kind": "diff",
            "activity_state": "updated",
            "title": "Diff updated",
            "original_bytes": 40,
            "added_lines": 1,
            "removed_lines": 1,
            "content_omitted": true
        });
        let mut events = messages;
        events.push(activity);
        fixture
            .service
            .ingest_domain_events("project-a", &batch(events))
            .expect("apply unbalanced history");

        let current = fixture
            .service
            .conversation(&conversation_input(2))
            .expect("read latest history");
        assert!(current.older_cursor.is_some());
        assert_eq!(current.activities.len(), 1);
        assert!(current.activity_older_cursor.is_none());
        let mut older_input = conversation_input(2);
        older_input.expected_stream_id = current.stream_id.clone();
        older_input.after_journal_sequence = current.applied_journal_sequence;
        older_input.cursor = current.older_cursor.clone();
        let older = fixture
            .service
            .conversation(&older_input)
            .expect("read message-only older page");
        assert_eq!(older.items.len(), 1);
        assert!(older.activities.is_empty());
        assert!(older.activity_older_cursor.is_none());
    }

    #[test]
    fn projects_typed_activity_lifecycle_with_independent_bounded_paging() {
        let fixture = Fixture::new();
        let mut command_started = event(1, None, None);
        command_started.kind = "command.started".into();
        command_started.phase = "started".into();
        command_started.item_id = Some("command-a".into());
        command_started.payload = serde_json::json!({
            "visibility": "public",
            "activity_kind": "command",
            "activity_state": "running",
            "title": "Run powershell.exe",
            "command_name": "powershell.exe",
            "action_types": ["unknown"],
            "action_types_truncated": false,
            "exit_code": null,
            "duration_ms": null,
            "output_present": false,
            "output_bytes": 0,
            "output_text": null,
            "output_truncated": false,
            "output_redacted": false,
            "cwd_omitted": true,
            "command_arguments_omitted": true,
            "content_omitted": true
        });
        let mut command_completed = event(2, None, None);
        command_completed.kind = "command.completed".into();
        command_completed.phase = "completed".into();
        command_completed.item_id = Some("command-a".into());
        command_completed.payload = serde_json::json!({
            "visibility": "public",
            "activity_kind": "command",
            "activity_state": "completed",
            "title": "Run powershell.exe",
            "command_name": "powershell.exe",
            "action_types": ["unknown"],
            "action_types_truncated": false,
            "exit_code": 0,
            "duration_ms": 125,
            "output_present": true,
            "output_bytes": 64,
            "output_text": "safe output",
            "output_truncated": false,
            "output_redacted": false,
            "cwd_omitted": true,
            "command_arguments_omitted": true,
            "content_omitted": true
        });
        let mut file_change = event(3, None, None);
        file_change.kind = "file.change.completed".into();
        file_change.phase = "completed".into();
        file_change.item_id = Some("file-a".into());
        file_change.payload = serde_json::json!({
            "visibility": "public",
            "activity_kind": "file_change",
            "activity_state": "completed",
            "title": "Changed 1 file",
            "changes": [{
                "path": "%USERPROFILE%/project/src/main.ts",
                "kind": "update",
                "original_bytes": 80,
                "added_lines": 2,
                "removed_lines": 1
            }],
            "change_count": 1,
            "changes_truncated": false,
            "content_omitted": true
        });
        let mut plan = event(4, None, None);
        plan.kind = "plan.updated".into();
        plan.phase = "updated".into();
        plan.item_id = None;
        plan.payload = serde_json::json!({
            "visibility": "public",
            "activity_kind": "plan",
            "activity_state": "updated",
            "title": "Plan updated",
            "steps": [{"status": "completed", "text": "Inspect contract", "truncated": false, "redacted": false}],
            "step_count": 1,
            "steps_truncated": false,
            "explanation": null,
            "explanation_truncated": false,
            "explanation_redacted": false
        });
        let mut other_agent = event(5, None, None);
        other_agent.kind = "diff.updated".into();
        other_agent.phase = "updated".into();
        other_agent.item_id = None;
        other_agent.agent_id = Some("other-agent".into());
        other_agent.payload = serde_json::json!({
            "visibility": "public",
            "activity_kind": "diff",
            "activity_state": "updated",
            "title": "Diff updated",
            "original_bytes": 40,
            "added_lines": 1,
            "removed_lines": 1,
            "content_omitted": true
        });
        fixture
            .service
            .ingest_domain_events(
                "project-a",
                &batch(vec![
                    command_started,
                    command_completed,
                    file_change,
                    plan,
                    other_agent,
                ]),
            )
            .expect("apply structured activities");

        let current = fixture
            .service
            .conversation(&conversation_input(2))
            .expect("read latest activity page");
        assert!(current.items.is_empty());
        assert_eq!(current.activities.len(), 2);
        assert_eq!(
            current
                .activities
                .iter()
                .map(|item| item.kind.as_str())
                .collect::<Vec<_>>(),
            ["file_change", "plan"]
        );
        assert!(current.activity_older_cursor.is_some());

        let mut older_input = conversation_input(2);
        older_input.expected_stream_id = current.stream_id.clone();
        older_input.after_journal_sequence = current.applied_journal_sequence;
        older_input.activity_cursor = current.activity_older_cursor.clone();
        let older = fixture
            .service
            .conversation(&older_input)
            .expect("read older activity page");
        assert_eq!(older.activities.len(), 1);
        let command = &older.activities[0];
        assert_eq!(command.kind, "command");
        assert_eq!(command.state, "completed");
        assert_eq!(command.last_journal_sequence, 2);
        assert_eq!(command.details["commandName"], "powershell.exe");
        assert_eq!(command.details["exitCode"], 0);
        assert!(older.activity_older_cursor.is_none());
    }

    #[test]
    fn fails_closed_when_an_old_terminal_update_would_displace_the_latest_page() {
        let fixture = Fixture::new();
        let mut events = vec![command_activity_event(
            1,
            "old-command",
            "turn-old",
            "running",
        )];
        for sequence in 2..=51 {
            events.push(command_activity_event(
                sequence,
                &format!("new-command-{sequence}"),
                &format!("turn-{sequence}"),
                "completed",
            ));
        }
        fixture
            .service
            .ingest_domain_events("project-a", &batch(events))
            .expect("apply one old and fifty newer activities");

        let baseline = fixture
            .service
            .conversation(&conversation_input(50))
            .expect("read bounded latest activity page");
        assert_eq!(baseline.activities.len(), 50);
        assert!(!baseline
            .activities
            .iter()
            .any(|activity| activity.item_id.as_deref() == Some("old-command")));

        fixture
            .service
            .ingest_domain_events(
                "project-a",
                &batch(vec![command_activity_event(
                    52,
                    "old-command",
                    "turn-old",
                    "completed",
                )]),
            )
            .expect("complete the activity outside the latest page");

        let mut refresh_input = conversation_input(50);
        refresh_input.expected_stream_id = baseline.stream_id;
        refresh_input.after_journal_sequence = baseline.applied_journal_sequence;
        let refreshed = fixture
            .service
            .conversation(&refresh_input)
            .expect("refresh includes the changed old activity");
        assert_eq!(refreshed.sync_state, "gap");
        assert!(refreshed.activities.is_empty());

        let resynced = fixture
            .service
            .conversation(&conversation_input(50))
            .expect("gap recovery returns the complete latest page");
        assert_eq!(resynced.activities.len(), 50);
        assert!(resynced
            .activities
            .iter()
            .any(|activity| activity.item_id.as_deref() == Some("new-command-51")));
        assert!(!resynced
            .activities
            .iter()
            .any(|activity| activity.item_id.as_deref() == Some("old-command")));
        let mut older_input = conversation_input(50);
        older_input.expected_stream_id = resynced.stream_id;
        older_input.after_journal_sequence = resynced.applied_journal_sequence;
        older_input.activity_cursor = resynced.activity_older_cursor;
        let older = fixture
            .service
            .conversation(&older_input)
            .expect("page the activity displaced only by creation time");
        let old = older
            .activities
            .iter()
            .find(|activity| activity.item_id.as_deref() == Some("old-command"))
            .expect("terminal old activity remains reachable after fail-closed resync");
        assert_eq!(old.state, "completed");
        assert_eq!(old.last_journal_sequence, 52);
    }

    #[test]
    fn rejects_incomplete_or_raw_structured_activity_before_advancing_the_watermark() {
        let fixture = Fixture::new();
        let mut incomplete = event(1, None, None);
        incomplete.kind = "command.started".into();
        incomplete.phase = "started".into();
        incomplete.item_id = Some("command-a".into());
        incomplete.payload = serde_json::json!({
            "visibility": "public",
            "activity_kind": "command",
            "activity_state": "running",
            "title": "Run command",
            "command_name": "command",
            "action_types": [],
            "action_types_truncated": false,
            "exit_code": null,
            "duration_ms": null,
            "output_present": false,
            "output_bytes": 0,
            "output_text": null,
            "output_truncated": false,
            "output_redacted": false,
            "cwd_omitted": true,
            "command_arguments_omitted": true
        });
        assert_eq!(
            fixture
                .service
                .ingest_domain_events("project-a", &batch(vec![incomplete]))
                .expect_err("reject missing omission marker")
                .code,
            "projection_activity_invalid"
        );

        let mut raw = event(1, None, None);
        raw.kind = "diff.updated".into();
        raw.phase = "updated".into();
        raw.item_id = None;
        raw.payload = serde_json::json!({
            "visibility": "public",
            "activity_kind": "diff",
            "activity_state": "updated",
            "title": "Diff updated",
            "original_bytes": 10,
            "added_lines": 1,
            "removed_lines": 1,
            "content_omitted": true,
            "raw_diff": "private"
        });
        assert_eq!(
            fixture
                .service
                .ingest_domain_events("project-a", &batch(vec![raw]))
                .expect_err("reject raw diff content")
                .code,
            "projection_private_payload_rejected"
        );
        assert_eq!(
            fixture
                .service
                .snapshot("project-a")
                .expect("unchanged projection")
                .applied_journal_sequence,
            0
        );
    }

    #[test]
    fn persists_agent_answer_streams_and_replaces_them_with_the_final_message() {
        let fixture = Fixture::new();
        let mut accepted = event(1, None, None);
        accepted.item_id = None;
        accepted.kind = "turn.accepted".into();
        accepted.phase = "accepted".into();
        accepted.payload = serde_json::json!({"status": "accepted", "visibility": "public"});

        let mut first = event(2, None, None);
        first.item_id = Some("answer-item".into());
        first.kind = "message.agent.delta".into();
        first.phase = "streaming".into();
        first.payload = serde_json::json!({
            "messageId": "stable-answer",
            "role": "agent",
            "delta": "Hello",
            "targetAgentId": "orchestrator",
            "visibility": "public"
        });
        let mut second = first.clone();
        second.journal_sequence = 3;
        second.event_id = format!("evt_{:064x}", 3);
        second.source_cursor = Some("cursor:3".into());
        second.occurred_at = timestamp(3);
        second.payload["delta"] = Value::from(" ");
        let mut third = first.clone();
        third.journal_sequence = 4;
        third.event_id = format!("evt_{:064x}", 4);
        third.source_cursor = Some("cursor:4".into());
        third.occurred_at = timestamp(4);
        third.payload["delta"] = Value::from("world");
        fixture
            .service
            .ingest_domain_events("project-a", &batch(vec![accepted, first, second, third]))
            .expect("apply accepted turn and answer deltas");

        let streaming = fixture
            .service
            .conversation(&conversation_input(50))
            .expect("read durable streaming answer");
        assert_eq!(streaming.streaming_items.len(), 1);
        assert_eq!(streaming.streaming_items[0].message_id, "stable-answer");
        assert_eq!(streaming.streaming_items[0].text, "Hello world");
        assert_eq!(streaming.active_turns.len(), 1);
        assert_eq!(streaming.active_turns[0].state, "accepted");

        let reopened = ProjectionService::open_trusted(
            fixture.service.root.clone(),
            fixture.service.trusted_app_data_root.clone(),
        )
        .expect("reopen streaming projection");
        assert_eq!(
            reopened
                .conversation(&conversation_input(50))
                .expect("read stream after restart")
                .streaming_items[0]
                .text,
            "Hello world"
        );

        let mut final_message = event(5, Some("agent"), Some("Hello world.".into()));
        final_message.item_id = Some("answer-item".into());
        final_message.kind = "conversation.message".into();
        final_message.payload = serde_json::json!({
            "messageId": "stable-answer",
            "role": "agent",
            "text": "Hello world.",
            "targetAgentId": "orchestrator",
            "visibility": "public"
        });
        reopened
            .ingest_domain_events("project-a", &batch(vec![final_message]))
            .expect("replace stream with authoritative final");
        let completed = reopened
            .conversation(&conversation_input(50))
            .expect("read completed answer");
        assert!(completed.streaming_items.is_empty());
        assert_eq!(completed.items.len(), 1);
        assert_eq!(completed.items[0].message_id, "stable-answer");
        assert_eq!(completed.items[0].text, "Hello world.");

        let mut late_delta = event(6, None, None);
        late_delta.item_id = Some("answer-item".into());
        late_delta.kind = "message.agent.delta".into();
        late_delta.phase = "streaming".into();
        late_delta.payload = serde_json::json!({
            "messageId": "stable-answer",
            "role": "agent",
            "delta": "late",
            "targetAgentId": "orchestrator",
            "visibility": "public"
        });
        reopened
            .ingest_domain_events("project-a", &batch(vec![late_delta]))
            .expect("ignore late delta after final message");
        assert!(reopened
            .conversation(&conversation_input(50))
            .expect("read after late delta")
            .streaming_items
            .is_empty());
    }

    #[test]
    fn migrates_v1_projection_for_indexed_agent_conversation_reads() {
        let fixture = Fixture::new();
        fixture
            .service
            .ingest_domain_events(
                "project-a",
                &batch(vec![event(1, Some("user"), Some("migration seed".into()))]),
            )
            .expect("create v2 projection fixture");
        let path = fixture.service.database_path_for_test("project-a");
        let connection = Connection::open(&path).expect("open v1 migration fixture");
        connection
            .execute_batch(
                "DROP INDEX idx_messages_target_page;
                 DROP INDEX idx_messages_provider_semantic;
                 DROP TABLE provider_backfill_state;
                 ALTER TABLE turns DROP COLUMN mutation_phase;
                 ALTER TABLE turns DROP COLUMN mutation_identity;
                 ALTER TABLE turns DROP COLUMN mutation_kind;
                 ALTER TABLE pending_requests DROP COLUMN response_phase;
                 ALTER TABLE pending_requests DROP COLUMN response_decision;
                 ALTER TABLE pending_requests DROP COLUMN response_identity;
                 ALTER TABLE pending_requests DROP COLUMN provider_connection_id;
                 ALTER TABLE pending_requests DROP COLUMN runtime_connection_id;
                 ALTER TABLE pending_requests DROP COLUMN response_options_json;
                 ALTER TABLE pending_requests DROP COLUMN method;
                 DROP TABLE conversation_index;
                 PRAGMA user_version = 1;",
            )
            .expect("downgrade fixture metadata to v1");
        drop(connection);

        let reopened = ProjectionService::open_trusted(
            fixture.service.root.clone(),
            fixture.service.trusted_app_data_root.clone(),
        )
        .expect("reopen projection service");
        let page = reopened
            .conversation(&conversation_input(50))
            .expect("migrate and read agent conversation");
        assert_eq!(page.items.len(), 1);

        let connection = Connection::open(&path).expect("inspect migrated projection");
        let version: u32 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("read migrated schema version");
        assert_eq!(version, PROJECTION_DATABASE_SCHEMA_VERSION);
        let index_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_messages_target_page'",
                [],
                |row| row.get(0),
            )
            .expect("read migrated target index");
        assert_eq!(index_count, 1);

        let mut statement = connection
            .prepare(
                "EXPLAIN QUERY PLAN SELECT message_id FROM messages WHERE target_agent_id = ?1 ORDER BY created_at DESC, message_id DESC LIMIT 50",
            )
            .expect("prepare agent conversation query plan");
        let plan = statement
            .query_map(["orchestrator"], |row| row.get::<_, String>(3))
            .expect("query agent conversation plan")
            .collect::<Result<Vec<_>, _>>()
            .expect("read agent conversation plan")
            .join("\n");
        assert!(
            plan.contains("idx_messages_target_page"),
            "unexpected agent conversation query plan: {plan}"
        );
    }

    #[test]
    fn migrates_v4_backfill_markers_without_trusting_the_old_provider_generation() {
        let fixture = Fixture::new();
        fixture
            .service
            .ingest_domain_events(
                "project-a",
                &batch(vec![event(1, Some("user"), Some("migration seed".into()))]),
            )
            .expect("create projection fixture");
        let path = fixture.service.database_path_for_test("project-a");
        let connection = Connection::open(&path).expect("open v4 migration fixture");
        connection
            .execute_batch(
                "DROP INDEX idx_messages_provider_semantic;
             DROP TABLE provider_backfill_state;
             ALTER TABLE turns DROP COLUMN mutation_phase;
             ALTER TABLE turns DROP COLUMN mutation_identity;
             ALTER TABLE turns DROP COLUMN mutation_kind;
             ALTER TABLE pending_requests DROP COLUMN response_phase;
             ALTER TABLE pending_requests DROP COLUMN response_decision;
             ALTER TABLE pending_requests DROP COLUMN response_identity;
             ALTER TABLE pending_requests DROP COLUMN provider_connection_id;
             ALTER TABLE pending_requests DROP COLUMN runtime_connection_id;
             DROP TABLE conversation_index;
             CREATE TABLE provider_backfill_state (
                 project_id TEXT PRIMARY KEY,
                 completed_at TEXT NOT NULL,
                 page_count INTEGER NOT NULL CHECK(page_count >= 0)
             );
             INSERT INTO provider_backfill_state(project_id, completed_at, page_count)
             VALUES('project-a', '1970-01-01T00:00:00.000Z', 1);
             PRAGMA user_version = 4;",
            )
            .expect("downgrade provider marker to v4");
        drop(connection);

        let reopened = ProjectionService::open_trusted(
            fixture.service.root.clone(),
            fixture.service.trusted_app_data_root.clone(),
        )
        .expect("reopen projection service");
        assert!(reopened
            .provider_backfill_required("project-a", "provider-generation-current")
            .expect("legacy provider marker must be treated as stale"));
        let connection = Connection::open(&path).expect("inspect v5 migration");
        let version: u32 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("read v5 schema version");
        assert_eq!(version, PROJECTION_DATABASE_SCHEMA_VERSION);
        let provider_connection_id: String = connection.query_row(
            "SELECT provider_connection_id FROM provider_backfill_state WHERE project_id = 'project-a'",
            [],
            |row| row.get(0),
        ).expect("read migrated provider marker");
        assert_eq!(provider_connection_id, "legacy-unverified");
    }

    #[test]
    fn migrates_v6_projection_to_the_typed_activity_schema() {
        let fixture = Fixture::new();
        fixture
            .service
            .ingest_domain_events(
                "project-a",
                &batch(vec![event(1, Some("user"), Some("migration seed".into()))]),
            )
            .expect("create projection fixture");
        let path = fixture.service.database_path_for_test("project-a");
        let connection = Connection::open(&path).expect("open v6 migration fixture");
        connection
            .execute_batch(
                "DROP INDEX idx_activities_turn_sequence;
             DROP INDEX idx_activities_target_page;
             DROP INDEX idx_activities_target_changes;
             DROP TABLE activities;
             ALTER TABLE turns DROP COLUMN mutation_phase;
             ALTER TABLE turns DROP COLUMN mutation_identity;
             ALTER TABLE turns DROP COLUMN mutation_kind;
             ALTER TABLE pending_requests DROP COLUMN response_phase;
             ALTER TABLE pending_requests DROP COLUMN response_decision;
             ALTER TABLE pending_requests DROP COLUMN response_identity;
             ALTER TABLE pending_requests DROP COLUMN provider_connection_id;
             ALTER TABLE pending_requests DROP COLUMN runtime_connection_id;
             DROP TABLE conversation_index;
             PRAGMA user_version = 6;",
            )
            .expect("downgrade fixture metadata to v6");
        drop(connection);

        let reopened = ProjectionService::open_trusted(
            fixture.service.root.clone(),
            fixture.service.trusted_app_data_root.clone(),
        )
        .expect("reopen projection service");
        assert!(reopened
            .conversation(&conversation_input(50))
            .expect("read migrated conversation")
            .activities
            .is_empty());
        let connection = Connection::open(&path).expect("inspect v7 migration");
        let version: u32 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("read v7 schema version");
        assert_eq!(version, PROJECTION_DATABASE_SCHEMA_VERSION);
        let activity_table_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'activities'",
                [],
                |row| row.get(0),
            )
            .expect("read migrated activity table");
        assert_eq!(activity_table_count, 1);
    }

    #[test]
    fn filters_non_final_and_internal_messages() {
        let fixture = Fixture::new();
        let mut commentary = event(1, Some("agent"), Some("not final".into()));
        commentary.phase = "commentary".into();
        let mut internal = event(2, Some("user"), Some("private bootstrap".into()));
        internal.payload["message"]["visibility"] = Value::String("internal".into());
        fixture
            .service
            .ingest_domain_events("project-a", &batch(vec![commentary, internal]))
            .expect("apply filtered batch");
        assert_eq!(
            fixture
                .service
                .snapshot("project-a")
                .expect("snapshot")
                .message_count,
            0
        );
    }

    #[test]
    fn rejects_private_payload_fields_and_never_projects_operational_output_as_chat() {
        for forbidden_key in [
            "rawProviderResponseBody",
            "rawProviderResponse",
            "rawProviderPayload",
            "privateThoughts",
            "providerResponse",
            "analysis",
        ] {
            let private_fixture = Fixture::new();
            let mut private = event(1, Some("user"), Some("visible wrapper".into()));
            private.payload[forbidden_key] = serde_json::json!({"secret": "LEAK"});
            assert_eq!(
                private_fixture
                    .service
                    .ingest_domain_events("project-a", &batch(vec![private]))
                    .expect_err("reject private or raw provider field")
                    .code,
                "projection_private_payload_rejected"
            );
        }

        let operational_fixture = Fixture::new();
        let mut operational = event(1, None, None);
        operational.kind = "command.output".into();
        operational.payload = serde_json::json!({
            "role": "assistant",
            "text": "operational output must not become chat"
        });
        operational_fixture
            .service
            .ingest_domain_events("project-a", &batch(vec![operational]))
            .expect("store safe operational event");
        assert_eq!(
            operational_fixture
                .service
                .snapshot("project-a")
                .expect("snapshot")
                .message_count,
            0
        );
        let connection = operational_fixture
            .service
            .connection("project-a")
            .expect("open operational projection");
        let stored_fingerprint: String = connection
            .query_row("SELECT event_fingerprint FROM events", [], |row| row.get(0))
            .expect("read stored event fingerprint");
        assert_eq!(stored_fingerprint.len(), 64);
        assert!(stored_fingerprint
            .bytes()
            .all(|value| value.is_ascii_hexdigit()));
        assert!(!stored_fingerprint.contains("operational output"));
    }

    #[test]
    fn only_turn_lifecycle_events_change_turn_state() {
        let fixture = Fixture::new();
        let mut started = event(1, None, None);
        started.kind = "turn.started".into();
        started.phase = "started".into();
        let mut approval = event(2, None, None);
        approval.kind = "attention.approval_requested".into();
        approval.phase = "requested".into();
        approval.item_id = Some("approval-2".into());
        approval.payload = serde_json::json!({"requestKey": "approval-2"});
        fixture
            .service
            .ingest_domain_events("project-a", &batch(vec![started, approval]))
            .expect("apply active turn events");
        let active = fixture.service.snapshot("project-a").expect("active turn");
        assert_eq!(active.turns[0].state, "in_progress");

        let mut completed = event(3, None, None);
        completed.kind = "turn.completed".into();
        completed.phase = "completed".into();
        completed.payload = serde_json::json!({"status": "completed"});
        let mut later_item = event(4, None, None);
        later_item.kind = "item.completed".into();
        later_item.phase = "commentary".into();
        fixture
            .service
            .ingest_domain_events("project-a", &batch(vec![completed, later_item]))
            .expect("apply terminal turn and later item");
        let terminal = fixture
            .service
            .snapshot("project-a")
            .expect("terminal turn");
        assert_eq!(terminal.turns[0].state, "completed");
        assert_eq!(terminal.turns[0].last_journal_sequence, 4);
    }

    #[test]
    fn exact_terminal_turn_query_rejects_nonterminal_and_identity_mismatch() {
        let fixture = Fixture::new();
        let mut started = event(1, None, None);
        started.kind = "turn.started".into();
        started.phase = "started".into();
        fixture
            .service
            .ingest_domain_events("project-a", &batch(vec![started]))
            .expect("apply nonterminal turn");
        assert_eq!(
            fixture
                .service
                .terminal_turn_state("project-a", "orchestrator", "thread-a", "turn-a")
                .expect("query nonterminal exact turn"),
            None
        );

        let mut completed = event(2, None, None);
        completed.kind = "turn.completed".into();
        completed.phase = "completed".into();
        completed.payload = serde_json::json!({"status": "completed"});
        fixture
            .service
            .ingest_domain_events("project-a", &batch(vec![completed]))
            .expect("apply terminal turn");
        assert_eq!(
            fixture
                .service
                .terminal_turn_state("project-a", "orchestrator", "thread-a", "turn-a")
                .expect("query exact terminal turn")
                .as_deref(),
            Some("completed")
        );
        for (agent, thread, turn) in [
            ("different-agent", "thread-a", "turn-a"),
            ("orchestrator", "different-thread", "turn-a"),
            ("orchestrator", "thread-a", "different-turn"),
        ] {
            assert_eq!(
                fixture
                    .service
                    .terminal_turn_state("project-a", agent, thread, turn)
                    .expect("query mismatched turn identity"),
                None
            );
        }
    }

    #[test]
    fn terminal_turn_marks_unfinished_activity_unknown_until_later_evidence_arrives() {
        let fixture = Fixture::new();
        let mut command_started = event(1, None, None);
        command_started.kind = "command.started".into();
        command_started.phase = "started".into();
        command_started.item_id = Some("command-interrupted".into());
        command_started.payload = serde_json::json!({
            "visibility": "public",
            "activity_kind": "command",
            "activity_state": "running",
            "title": "Run pwsh.exe",
            "command_name": "pwsh.exe",
            "action_types": ["unknown"],
            "action_types_truncated": false,
            "exit_code": null,
            "duration_ms": null,
            "output_present": false,
            "output_bytes": 0,
            "output_text": null,
            "output_truncated": false,
            "output_redacted": false,
            "cwd_omitted": true,
            "command_arguments_omitted": true,
            "content_omitted": true
        });
        let mut interrupted = event(2, None, None);
        interrupted.kind = "turn.completed".into();
        interrupted.phase = "completed".into();
        interrupted.payload = serde_json::json!({"status": "interrupted"});
        fixture
            .service
            .ingest_domain_events("project-a", &batch(vec![command_started, interrupted]))
            .expect("apply interrupted command turn");

        let stopped = fixture
            .service
            .conversation(&conversation_input(50))
            .expect("read interrupted activity");
        assert_eq!(
            stopped.latest_turn.as_ref().map(|turn| turn.state.as_str()),
            Some("interrupted")
        );
        assert_eq!(stopped.activities.len(), 1);
        assert_eq!(stopped.activities[0].state, "unknown");
        assert_eq!(stopped.activities[0].last_journal_sequence, 2);

        let mut late_completion = event(3, None, None);
        late_completion.kind = "command.completed".into();
        late_completion.phase = "completed".into();
        late_completion.item_id = Some("command-interrupted".into());
        late_completion.payload = serde_json::json!({
            "visibility": "public",
            "activity_kind": "command",
            "activity_state": "completed",
            "title": "Run pwsh.exe",
            "command_name": "pwsh.exe",
            "action_types": ["unknown"],
            "action_types_truncated": false,
            "exit_code": 0,
            "duration_ms": 100,
            "output_present": true,
            "output_bytes": 4,
            "output_text": "done",
            "output_truncated": false,
            "output_redacted": false,
            "cwd_omitted": true,
            "command_arguments_omitted": true,
            "content_omitted": true
        });
        fixture
            .service
            .ingest_domain_events("project-a", &batch(vec![late_completion]))
            .expect("apply later exact completion evidence");
        let resolved = fixture
            .service
            .conversation(&conversation_input(50))
            .expect("read resolved activity");
        assert_eq!(resolved.activities[0].state, "completed");
        assert_eq!(resolved.activities[0].last_journal_sequence, 3);
    }

    #[test]
    fn turn_lifecycle_never_regresses_after_progress_or_terminal_state() {
        let fixture = Fixture::new();
        let mut started = event(1, None, None);
        started.kind = "turn.started".into();
        started.phase = "started".into();
        let mut late_accepted = event(2, None, None);
        late_accepted.kind = "turn.accepted".into();
        late_accepted.phase = "accepted".into();
        fixture
            .service
            .ingest_domain_events("project-a", &batch(vec![started, late_accepted]))
            .expect("apply started turn and late acceptance");

        let active = fixture
            .service
            .conversation(&conversation_input(50))
            .expect("read active turn after late acceptance");
        assert_eq!(active.active_turns.len(), 1);
        assert_eq!(active.active_turns[0].state, "in_progress");
        assert_eq!(active.active_turns[0].last_journal_sequence, 2);

        let mut completed = event(3, None, None);
        completed.kind = "turn.completed".into();
        completed.phase = "completed".into();
        completed.payload = serde_json::json!({"status": "completed"});
        let mut late_started = event(4, None, None);
        late_started.kind = "turn.started".into();
        late_started.phase = "started".into();
        let mut later_accepted = event(5, None, None);
        later_accepted.kind = "turn.accepted".into();
        later_accepted.phase = "accepted".into();
        fixture
            .service
            .ingest_domain_events(
                "project-a",
                &batch(vec![completed, late_started, later_accepted]),
            )
            .expect("apply terminal turn and late nonterminal lifecycle events");

        let terminal = fixture
            .service
            .conversation(&conversation_input(50))
            .expect("read terminal turn after late lifecycle events");
        assert!(terminal.active_turns.is_empty());
        let latest = terminal.latest_turn.expect("latest terminal turn");
        assert_eq!(latest.state, "completed");
        assert_eq!(latest.last_journal_sequence, 5);
    }

    #[test]
    fn conversation_reports_the_exact_latest_terminal_turn_state() {
        let fixture = Fixture::new();
        let mut started = event(1, None, None);
        started.kind = "turn.started".into();
        started.phase = "started".into();
        let mut delta = event(2, None, None);
        delta.item_id = Some("terminal-answer-item".into());
        delta.kind = "message.agent.delta".into();
        delta.phase = "streaming".into();
        delta.payload = serde_json::json!({
            "messageId": "terminal-answer",
            "role": "agent",
            "delta": "partial answer",
            "targetAgentId": "orchestrator",
            "visibility": "public"
        });
        fixture
            .service
            .ingest_domain_events("project-a", &batch(vec![started, delta]))
            .expect("apply started turn and partial answer");

        let active = fixture
            .service
            .conversation(&conversation_input(50))
            .expect("read active turn");
        assert_eq!(active.active_turns.len(), 1);
        assert_eq!(active.streaming_items.len(), 1);
        assert_eq!(
            active.latest_turn.as_ref().map(|turn| turn.state.as_str()),
            Some("in_progress")
        );

        let mut failed = event(3, None, None);
        failed.kind = "turn.completed".into();
        failed.phase = "completed".into();
        failed.payload = serde_json::json!({"status": "failed"});
        fixture
            .service
            .ingest_domain_events("project-a", &batch(vec![failed]))
            .expect("apply failed terminal turn");

        let terminal = fixture
            .service
            .conversation(&conversation_input(50))
            .expect("read failed terminal turn");
        assert!(terminal.active_turns.is_empty());
        assert!(terminal.streaming_items.is_empty());
        let latest = terminal.latest_turn.expect("latest terminal turn");
        assert_eq!(latest.thread_id, "thread-a");
        assert_eq!(latest.turn_id, "turn-a");
        assert_eq!(latest.target_agent_id, "orchestrator");
        assert_eq!(latest.state, "failed");
        assert_eq!(latest.last_journal_sequence, 3);

        let mut late_delta = event(4, None, None);
        late_delta.item_id = Some("terminal-answer-item".into());
        late_delta.kind = "message.agent.delta".into();
        late_delta.phase = "streaming".into();
        late_delta.payload = serde_json::json!({
            "messageId": "terminal-answer",
            "role": "agent",
            "delta": "late partial",
            "targetAgentId": "orchestrator",
            "visibility": "public"
        });
        fixture
            .service
            .ingest_domain_events("project-a", &batch(vec![late_delta]))
            .expect("ignore late delta after terminal turn");
        assert!(fixture
            .service
            .conversation(&conversation_input(50))
            .expect("read after late terminal delta")
            .streaming_items
            .is_empty());
    }

    #[test]
    fn provider_messages_upgrade_to_journal_only_when_turn_semantics_match() {
        let fixture = Fixture::uninitialized();
        let record = ProviderMessageRecord {
            message_id: "provider-history-message-000001".into(),
            thread_id: "thread-a".into(),
            turn_id: None,
            target_agent_id: Some("orchestrator".into()),
            role: "user".into(),
            text: "same semantic message".into(),
            created_at: timestamp(1),
        };
        fixture
            .service
            .initialize_project("project-a")
            .expect("initialize provider projection");
        fixture
            .service
            .refresh_provider_pages(
                "project-a",
                "provider-generation-upgrade",
                &[ProviderPage {
                    page_id: "page-upgrade".into(),
                    thread_id: "thread-a".into(),
                    requested_cursor: None,
                    next_cursor: None,
                    is_complete: true,
                    records: vec![record],
                    activities: vec![],
                    turns: vec![],
                }],
            )
            .expect("seed provider message");
        let live = event(1, Some("user"), Some("same semantic message".into()));
        fixture
            .service
            .ingest_domain_events("project-a", &batch(vec![live]))
            .expect("upgrade provider message to journal");
        let connection = fixture.service.connection("project-a").expect("connection");
        let linkage: (String, Option<String>, Option<i64>, Option<String>) = connection
            .query_row(
                "SELECT origin, event_id, journal_sequence, turn_id FROM messages WHERE message_id = 'provider-history-message-000001'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("read upgraded linkage");
        assert_eq!(linkage.0, "journal");
        assert!(linkage.1.is_some());
        assert_eq!(linkage.2, Some(1));
        assert_eq!(linkage.3.as_deref(), Some("turn-a"));

        let exact_id = Fixture::uninitialized();
        exact_id
            .service
            .initialize_project("project-a")
            .expect("initialize exact provider projection");
        exact_id
            .service
            .refresh_provider_pages(
                "project-a",
                "provider-generation-exact",
                &[ProviderPage {
                    page_id: "page-exact-upgrade".into(),
                    thread_id: "thread-a".into(),
                    requested_cursor: None,
                    next_cursor: None,
                    is_complete: true,
                    records: vec![ProviderMessageRecord {
                        message_id: "message-000001".into(),
                        thread_id: "thread-a".into(),
                        turn_id: None,
                        target_agent_id: Some("orchestrator".into()),
                        role: "user".into(),
                        text: "same exact identity".into(),
                        created_at: timestamp(0),
                    }],
                    activities: vec![],
                    turns: vec![],
                }],
            )
            .expect("seed exact provider identity without turn");
        exact_id
            .service
            .ingest_domain_events(
                "project-a",
                &batch(vec![event(
                    1,
                    Some("user"),
                    Some("same exact identity".into()),
                )]),
            )
            .expect("upgrade exact provider identity with canonical journal turn");
        let exact_connection = exact_id
            .service
            .connection("project-a")
            .expect("exact connection");
        let exact_linkage: (String, Option<String>) = exact_connection
            .query_row(
                "SELECT origin, turn_id FROM messages WHERE message_id = 'message-000001'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read exact upgraded linkage");
        assert_eq!(exact_linkage.0, "journal");
        assert_eq!(exact_linkage.1.as_deref(), Some("turn-a"));

        let conflict = Fixture::uninitialized();
        conflict
            .service
            .initialize_project("project-a")
            .expect("initialize conflicting provider projection");
        conflict
            .service
            .refresh_provider_pages(
                "project-a",
                "provider-generation-conflict",
                &[ProviderPage {
                    page_id: "page-conflict".into(),
                    thread_id: "thread-a".into(),
                    requested_cursor: None,
                    next_cursor: None,
                    is_complete: true,
                    records: vec![ProviderMessageRecord {
                        message_id: "message-000001".into(),
                        thread_id: "thread-a".into(),
                        turn_id: Some("different-turn".into()),
                        target_agent_id: Some("orchestrator".into()),
                        role: "user".into(),
                        text: "same semantic message".into(),
                        created_at: timestamp(1),
                    }],
                    activities: vec![],
                    turns: vec![],
                }],
            )
            .expect("seed conflicting provider message");
        assert_eq!(
            conflict
                .service
                .ingest_domain_events(
                    "project-a",
                    &batch(vec![event(
                        1,
                        Some("user"),
                        Some("same semantic message".into()),
                    )]),
                )
                .expect_err("reject same message id assigned to another turn")
                .code,
            "projection_message_conflict"
        );
    }

    #[test]
    fn provider_backfill_does_not_duplicate_an_existing_journal_user_message() {
        let fixture = Fixture::new();
        fixture
            .service
            .ingest_domain_events(
                "project-a",
                &batch(vec![event(
                    1,
                    Some("user"),
                    Some("same semantic message".into()),
                )]),
            )
            .expect("seed canonical journal user message");

        let provider_page = ProviderPage {
            page_id: "provider-page-after-journal".into(),
            thread_id: "thread-a".into(),
            requested_cursor: None,
            next_cursor: None,
            is_complete: true,
            records: vec![ProviderMessageRecord {
                message_id: "provider-message-after-journal".into(),
                thread_id: "thread-a".into(),
                turn_id: Some("turn-a".into()),
                target_agent_id: Some("orchestrator".into()),
                role: "user".into(),
                text: "same semantic message".into(),
                created_at: timestamp(0),
            }],
            activities: vec![],
            turns: vec![],
        };
        assert_eq!(
            fixture
                .service
                .refresh_provider_pages(
                    "project-a",
                    "provider-generation-late-history",
                    std::slice::from_ref(&provider_page),
                )
                .expect("merge late provider history")
                .1,
            0
        );

        let connection = fixture
            .service
            .connection("project-a")
            .expect("projection connection");
        let canonical_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM messages WHERE thread_id = 'thread-a' AND turn_id = 'turn-a' AND role = 'user' AND text = 'same semantic message'",
                [],
                |row| row.get(0),
            )
            .expect("count canonical user message");
        assert_eq!(canonical_count, 1);
        let origin: String = connection
            .query_row(
                "SELECT origin FROM messages WHERE thread_id = 'thread-a' AND turn_id = 'turn-a' AND role = 'user'",
                [],
                |row| row.get(0),
            )
            .expect("read canonical origin");
        assert_eq!(origin, "journal");

        let distinct_turn_page = ProviderPage {
            page_id: "provider-page-distinct-turn".into(),
            thread_id: "thread-a".into(),
            requested_cursor: None,
            next_cursor: None,
            is_complete: true,
            records: vec![ProviderMessageRecord {
                message_id: "provider-message-distinct-turn".into(),
                thread_id: "thread-a".into(),
                turn_id: Some("turn-b".into()),
                target_agent_id: Some("orchestrator".into()),
                role: "user".into(),
                text: "same semantic message".into(),
                created_at: timestamp(2),
            }],
            activities: vec![],
            turns: vec![],
        };
        assert_eq!(
            fixture
                .service
                .refresh_provider_pages(
                    "project-a",
                    "provider-generation-distinct-turn",
                    std::slice::from_ref(&distinct_turn_page),
                )
                .expect("preserve same text in a distinct turn")
                .1,
            1
        );
        let total_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM messages WHERE thread_id = 'thread-a' AND role = 'user' AND text = 'same semantic message'",
                [],
                |row| row.get(0),
            )
            .expect("count distinct-turn user messages");
        assert_eq!(total_count, 2);
    }

    #[test]
    fn provider_refresh_is_idempotent() {
        let fixture = Fixture::uninitialized();
        fixture
            .service
            .initialize_project("project-a")
            .expect("initialize project");
        let page = ProviderPage {
            page_id: "provider-page-1".into(),
            thread_id: "thread-legacy".into(),
            requested_cursor: None,
            next_cursor: None,
            is_complete: true,
            records: vec![
                ProviderMessageRecord {
                    message_id: "legacy-user".into(),
                    thread_id: "thread-legacy".into(),
                    turn_id: None,
                    target_agent_id: Some("orchestrator".into()),
                    role: "user".into(),
                    text: "以前の依頼".into(),
                    created_at: "2026-08-16T09:00:00.000Z".into(),
                },
                ProviderMessageRecord {
                    message_id: "legacy-agent".into(),
                    thread_id: "thread-legacy".into(),
                    turn_id: None,
                    target_agent_id: Some("orchestrator".into()),
                    role: "agent".into(),
                    text: "以前の最終回答".into(),
                    created_at: "2026-08-16T09:00:01.000Z".into(),
                },
            ],
            activities: vec![],
            turns: vec![ProviderTurnRecord {
                thread_id: "thread-legacy".into(),
                turn_id: "legacy-turn".into(),
                state: "completed".into(),
                item_ids: vec!["legacy-user".into(), "legacy-agent".into()],
            }],
        };
        let (snapshot, changed) = fixture
            .service
            .refresh_provider_pages(
                "project-a",
                "provider-generation-a",
                std::slice::from_ref(&page),
            )
            .expect("refresh provider page");
        assert_eq!(changed, 2);
        assert_eq!(snapshot.message_count, 2);
        assert_eq!(snapshot.turns[0].state, "completed");
        let (_, repeated) = fixture
            .service
            .refresh_provider_pages(
                "project-a",
                "provider-generation-a",
                std::slice::from_ref(&page),
            )
            .expect("repeat provider refresh");
        assert_eq!(repeated, 0);
    }

    #[test]
    fn provider_refresh_keeps_newest_turn_state_across_older_pages() {
        let fixture = Fixture::uninitialized();
        fixture
            .service
            .initialize_project("project-a")
            .expect("initialize project");
        let pages = vec![
            ProviderPage {
                page_id: "turn-root".into(),
                thread_id: "thread-history".into(),
                requested_cursor: None,
                next_cursor: Some("older".into()),
                is_complete: false,
                records: vec![],
                activities: vec![],
                turns: vec![ProviderTurnRecord {
                    thread_id: "thread-history".into(),
                    turn_id: "turn-shared".into(),
                    state: "completed".into(),
                    item_ids: vec!["item-new".into()],
                }],
            },
            ProviderPage {
                page_id: "turn-older".into(),
                thread_id: "thread-history".into(),
                requested_cursor: Some("older".into()),
                next_cursor: None,
                is_complete: true,
                records: vec![],
                activities: vec![],
                turns: vec![ProviderTurnRecord {
                    thread_id: "thread-history".into(),
                    turn_id: "turn-shared".into(),
                    state: "in_progress".into(),
                    item_ids: vec!["item-old".into()],
                }],
            },
        ];
        let (snapshot, _) = fixture
            .service
            .refresh_provider_pages("project-a", "provider-generation-a", &pages)
            .expect("refresh provider history");
        assert_eq!(snapshot.turns.len(), 1);
        assert_eq!(snapshot.turns[0].state, "completed");
        assert_eq!(snapshot.turns[0].item_count, 2);
    }

    #[test]
    fn preserves_corrupt_and_failed_migration_evidence() {
        let corrupt = Fixture::uninitialized();
        let corrupt_path = corrupt.service.database_path_for_test("project-a");
        fs::write(&corrupt_path, b"not a sqlite database").expect("write corrupt fixture");
        let before = fs::read(&corrupt_path).expect("read corrupt fixture");
        assert!(corrupt.service.snapshot("project-a").is_err());
        assert_eq!(
            fs::read(&corrupt_path).expect("corrupt evidence preserved"),
            before
        );

        let migration = Fixture::uninitialized();
        let migration_path = migration.service.database_path_for_test("project-a");
        let connection = Connection::open(&migration_path).expect("open migration fixture");
        connection
            .execute_batch("CREATE TABLE messages(broken TEXT); PRAGMA user_version=0;")
            .expect("create incompatible v0 schema");
        drop(connection);
        assert!(migration.service.snapshot("project-a").is_err());
        let connection = Connection::open(&migration_path).expect("reopen migration evidence");
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("read preserved version");
        assert_eq!(version, 0);
        let broken: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='messages'",
                [],
                |row| row.get(0),
            )
            .expect("read preserved table");
        assert_eq!(broken, 1);
    }

    #[test]
    fn rejects_onedrive_projection_roots() {
        let root = std::env::temp_dir()
            .join("OneDrive")
            .join(format!("projection-{}", Uuid::new_v4()));
        assert_eq!(
            ProjectionService::open_trusted(root.join("projection"), root)
                .expect_err("reject OneDrive storage")
                .code,
            "projection_root_untrusted"
        );
    }

    #[test]
    fn rejects_non_dedicated_projection_roots_and_impossible_calendar_dates() {
        let root = std::env::temp_dir().join(format!(
            "orquesta-next-untrusted-projection-test-{}",
            Uuid::new_v4()
        ));
        assert_eq!(
            ProjectionService::open_trusted(root.clone(), root.clone())
                .expect_err("projection root must be dedicated AppData child")
                .code,
            "projection_root_untrusted"
        );
        assert!(validate_timestamp("2026-02-31T10:00:00.000Z", "createdAt").is_err());
        assert!(validate_timestamp("2024-02-29T10:00:00.000Z", "createdAt").is_ok());
    }

    #[test]
    fn typed_renderer_inputs_reject_unknown_fields_and_newer_schemas() {
        let unknown = serde_json::from_value::<ProjectionConversationInput>(serde_json::json!({
            "schemaVersion": 1,
            "projectId": "project-a",
            "targetAgentId": "orchestrator",
            "expectedStreamId": null,
            "afterJournalSequence": 0,
            "expectedProjectionRevision": 0,
            "cursor": null,
            "activityCursor": null,
            "limit": 50,
            "sql": "DROP TABLE messages"
        }));
        assert!(unknown.is_err());
        let fixture = Fixture::new();
        let mut newer = conversation_input(50);
        newer.schema_version = 2;
        assert_eq!(
            fixture
                .service
                .conversation(&newer)
                .expect_err("reject newer command schema")
                .code,
            "projection_contract_unsupported"
        );
    }

    #[test]
    #[ignore = "explicit load test"]
    fn opens_latest_history_fifty_from_one_hundred_thousand_items() {
        assert_history_is_agent_partitioned_cursor_bounded_and_index_only(50_000, 49_998, true);
        let fixture = Fixture::new();
        let events = (1..=100_000)
            .map(|sequence| {
                let role = if sequence % 2 == 0 { "agent" } else { "user" };
                event(
                    sequence,
                    Some(role),
                    Some(format!("projected history item {sequence:06}")),
                )
            })
            .collect();
        let receipt = fixture
            .service
            .ingest_domain_events("project-a", &batch(events))
            .expect("apply 100k fixture");
        assert_eq!(receipt.event_count, 100_000);
        let page = fixture
            .service
            .history_page(&ProjectionHistoryPageInput {
                schema_version: 1,
                project_id: "project-a".into(),
                target_agent_id: "orchestrator".into(),
                query: None,
                cursor: None,
                limit: 50,
            })
            .expect("latest history fifty");
        assert_eq!(page.items.len(), 50);
        assert_eq!(
            page.items.first().expect("first latest item").message_id,
            "message-099951"
        );
        assert_eq!(
            page.items.last().expect("last latest item").message_id,
            "message-100000"
        );
    }

    #[test]
    fn durable_turn_mutation_claims_survive_reopen_and_block_reverse_order() {
        let stop_fixture = Fixture::new();
        stop_fixture
            .service
            .ingest_domain_events(
                "project-a",
                &batch(vec![turn_event(1, "turn-a", "in_progress")]),
            )
            .expect("seed active Stop turn");
        assert_eq!(
            stop_fixture
                .service
                .claim_turn_mutation(
                    "project-a",
                    "thread-a",
                    "turn-a",
                    TurnMutationKind::Stop,
                    "stop-identity-a",
                )
                .expect("claim Stop"),
            TurnMutationClaimResult::Acquired
        );
        stop_fixture
            .service
            .mark_turn_mutation_accepted("project-a", "thread-a", "turn-a", "stop-identity-a")
            .expect("accept durable Stop");
        let reopened_stop = ProjectionService::open_trusted(
            stop_fixture.service.root.clone(),
            stop_fixture.service.trusted_app_data_root.clone(),
        )
        .expect("reopen Stop projection");
        reopened_stop
            .require_existing_project("project-a")
            .expect("require reopened Stop project");
        assert_eq!(
            reopened_stop
                .claim_turn_mutation(
                    "project-a",
                    "thread-a",
                    "turn-a",
                    TurnMutationKind::Stop,
                    "stop-identity-a",
                )
                .expect("deduplicate accepted Stop after reopen"),
            TurnMutationClaimResult::Duplicate
        );
        assert_eq!(
            reopened_stop
                .claim_turn_mutation(
                    "project-a",
                    "thread-a",
                    "turn-a",
                    TurnMutationKind::Steer,
                    "steer-identity-a",
                )
                .expect_err("accepted Stop blocks Steer after reopen")
                .code,
            "runtime_turn_not_steerable"
        );

        let steer_fixture = Fixture::new();
        steer_fixture
            .service
            .ingest_domain_events(
                "project-a",
                &batch(vec![turn_event(1, "turn-a", "in_progress")]),
            )
            .expect("seed active Steer turn");
        steer_fixture
            .service
            .claim_turn_mutation(
                "project-a",
                "thread-a",
                "turn-a",
                TurnMutationKind::Steer,
                "steer-identity-a",
            )
            .expect("claim Steer");
        steer_fixture
            .service
            .mark_turn_mutation_accepted("project-a", "thread-a", "turn-a", "steer-identity-a")
            .expect("accept durable Steer");
        let reopened_steer = ProjectionService::open_trusted(
            steer_fixture.service.root.clone(),
            steer_fixture.service.trusted_app_data_root.clone(),
        )
        .expect("reopen Steer projection");
        reopened_steer
            .require_existing_project("project-a")
            .expect("require reopened Steer project");
        assert_eq!(
            reopened_steer
                .claim_turn_mutation(
                    "project-a",
                    "thread-a",
                    "turn-a",
                    TurnMutationKind::Stop,
                    "stop-identity-a",
                )
                .expect_err("accepted Steer blocks Stop after reopen")
                .code,
            "runtime_turn_not_interruptible"
        );
    }

    #[test]
    fn durable_steer_identity_and_known_failure_release_are_exact() {
        let fixture = Fixture::new();
        fixture
            .service
            .ingest_domain_events(
                "project-a",
                &batch(vec![turn_event(1, "turn-a", "in_progress")]),
            )
            .expect("seed active turn");
        fixture
            .service
            .claim_turn_mutation(
                "project-a",
                "thread-a",
                "turn-a",
                TurnMutationKind::Stop,
                "stop-identity-a",
            )
            .expect("claim Stop before known failure");
        fixture
            .service
            .release_turn_mutation("project-a", "thread-a", "turn-a", "stop-identity-a")
            .expect("release proven pre-accept failure");
        assert_eq!(
            fixture
                .service
                .claim_turn_mutation(
                    "project-a",
                    "thread-a",
                    "turn-a",
                    TurnMutationKind::Steer,
                    "steer-identity-a",
                )
                .expect("claim Steer after proven release"),
            TurnMutationClaimResult::Acquired
        );
        fixture
            .service
            .mark_turn_mutation_accepted("project-a", "thread-a", "turn-a", "steer-identity-a")
            .expect("accept Steer");
        assert_eq!(
            fixture
                .service
                .claim_turn_mutation(
                    "project-a",
                    "thread-a",
                    "turn-a",
                    TurnMutationKind::Steer,
                    "steer-identity-a",
                )
                .expect("deduplicate exact Steer"),
            TurnMutationClaimResult::Duplicate
        );
        assert_eq!(
            fixture
                .service
                .claim_turn_mutation(
                    "project-a",
                    "thread-a",
                    "turn-a",
                    TurnMutationKind::Steer,
                    "steer-identity-changed",
                )
                .expect_err("changed Steer identity must fail")
                .code,
            "runtime_turn_steer_identity_mismatch"
        );
    }

    #[test]
    fn unknown_and_crashed_in_flight_claims_block_both_mutations_after_reopen() {
        for explicit_unknown in [false, true] {
            let fixture = Fixture::new();
            fixture
                .service
                .ingest_domain_events(
                    "project-a",
                    &batch(vec![turn_event(1, "turn-a", "in_progress")]),
                )
                .expect("seed active uncertain turn");
            fixture
                .service
                .claim_turn_mutation(
                    "project-a",
                    "thread-a",
                    "turn-a",
                    TurnMutationKind::Steer,
                    "steer-identity-a",
                )
                .expect("claim uncertain Steer");
            if explicit_unknown {
                fixture
                    .service
                    .mark_turn_mutation_outcome_unknown(
                        "project-a",
                        "thread-a",
                        "turn-a",
                        "steer-identity-a",
                    )
                    .expect("persist explicit unknown outcome");
            }
            let reopened = ProjectionService::open_trusted(
                fixture.service.root.clone(),
                fixture.service.trusted_app_data_root.clone(),
            )
            .expect("reopen uncertain projection");
            reopened
                .require_existing_project("project-a")
                .expect("promote prior-lifetime in-flight mutation");
            for (kind, identity) in [
                (TurnMutationKind::Steer, "steer-identity-a"),
                (TurnMutationKind::Stop, "stop-identity-a"),
            ] {
                let error = reopened
                    .claim_turn_mutation("project-a", "thread-a", "turn-a", kind, identity)
                    .expect_err("uncertain claim blocks exact and reverse mutations");
                assert_eq!(error.code, "runtime_turn_mutation_outcome_unknown");
                assert!(error.outcome_unknown);
            }
            let connection = Connection::open(reopened.database_path_for_test("project-a"))
                .expect("inspect recovered mutation phase");
            let phase: String = connection
                .query_row(
                    "SELECT mutation_phase FROM turns WHERE thread_id = 'thread-a' AND turn_id = 'turn-a'",
                    [],
                    |row| row.get(0),
                )
                .expect("read recovered mutation phase");
            assert_eq!(phase, "outcome_unknown");
        }
    }

    #[test]
    fn terminal_journal_truth_clears_claim_and_allows_a_new_turn() {
        let fixture = Fixture::new();
        fixture
            .service
            .ingest_domain_events(
                "project-a",
                &batch(vec![turn_event(1, "turn-a", "in_progress")]),
            )
            .expect("seed active turn");
        fixture
            .service
            .claim_turn_mutation(
                "project-a",
                "thread-a",
                "turn-a",
                TurnMutationKind::Stop,
                "stop-identity-a",
            )
            .expect("claim Stop");
        fixture
            .service
            .mark_turn_mutation_outcome_unknown(
                "project-a",
                "thread-a",
                "turn-a",
                "stop-identity-a",
            )
            .expect("mark Stop unknown");
        fixture
            .service
            .ingest_domain_events(
                "project-a",
                &batch(vec![turn_event(2, "turn-a", "completed")]),
            )
            .expect("apply terminal journal truth");
        let connection = Connection::open(fixture.service.database_path_for_test("project-a"))
            .expect("inspect terminal claim clear");
        let stored: (String, Option<String>, Option<String>, Option<String>) = connection
            .query_row(
                "SELECT state, mutation_kind, mutation_identity, mutation_phase
                 FROM turns WHERE thread_id = 'thread-a' AND turn_id = 'turn-a'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("read terminal turn");
        assert_eq!(stored, ("completed".into(), None, None, None));
        drop(connection);
        assert_eq!(
            fixture
                .service
                .claim_turn_mutation(
                    "project-a",
                    "thread-a",
                    "turn-a",
                    TurnMutationKind::Stop,
                    "stop-identity-a",
                )
                .expect_err("terminal turn cannot be mutated")
                .code,
            "runtime_turn_not_projection_owned"
        );
        fixture
            .service
            .ingest_domain_events(
                "project-a",
                &batch(vec![turn_event(3, "turn-b", "in_progress")]),
            )
            .expect("start a distinct later turn");
        assert_eq!(
            fixture
                .service
                .claim_turn_mutation(
                    "project-a",
                    "thread-a",
                    "turn-b",
                    TurnMutationKind::Steer,
                    "steer-identity-b",
                )
                .expect("new turn has independent mutation ownership"),
            TurnMutationClaimResult::Acquired
        );
    }

    #[test]
    fn terminal_provider_truth_monotonically_closes_turn_and_claim() {
        let fixture = Fixture::new();
        fixture
            .service
            .ingest_domain_events(
                "project-a",
                &batch(vec![turn_event(1, "turn-a", "in_progress")]),
            )
            .expect("seed active provider turn");
        fixture
            .service
            .claim_turn_mutation(
                "project-a",
                "thread-a",
                "turn-a",
                TurnMutationKind::Steer,
                "steer-identity-a",
            )
            .expect("claim provider turn");
        fixture
            .service
            .mark_turn_mutation_accepted("project-a", "thread-a", "turn-a", "steer-identity-a")
            .expect("accept provider turn mutation");
        let terminal_page = ProviderPage {
            page_id: "terminal-turn-page".into(),
            thread_id: "thread-a".into(),
            requested_cursor: None,
            next_cursor: None,
            is_complete: true,
            records: Vec::new(),
            activities: Vec::new(),
            turns: vec![ProviderTurnRecord {
                thread_id: "thread-a".into(),
                turn_id: "turn-a".into(),
                state: "completed".into(),
                item_ids: Vec::new(),
            }],
        };
        fixture
            .service
            .refresh_provider_pages(
                "project-a",
                "provider-generation-terminal",
                std::slice::from_ref(&terminal_page),
            )
            .expect("apply terminal provider truth");
        let connection = Connection::open(fixture.service.database_path_for_test("project-a"))
            .expect("inspect provider terminal turn");
        let stored: (String, Option<String>, Option<String>, Option<String>) = connection
            .query_row(
                "SELECT state, mutation_kind, mutation_identity, mutation_phase
                 FROM turns WHERE thread_id = 'thread-a' AND turn_id = 'turn-a'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("read provider terminal turn");
        assert_eq!(stored, ("completed".into(), None, None, None));
        drop(connection);

        // Simulate the old provider-page implementation that recorded this
        // exact page but left an existing turn active. Replaying the same page
        // after upgrade must still reconcile terminal truth rather than return
        // before repairing the stale claim.
        let legacy_connection =
            Connection::open(fixture.service.database_path_for_test("project-a"))
                .expect("open legacy provider-page state");
        legacy_connection
            .execute(
                "UPDATE turns
                 SET state = 'in_progress', mutation_kind = 'steer',
                     mutation_identity = 'legacy-steer', mutation_phase = 'accepted'
                 WHERE thread_id = 'thread-a' AND turn_id = 'turn-a'",
                [],
            )
            .expect("simulate stale pre-fix provider projection");
        drop(legacy_connection);
        assert_eq!(
            fixture
                .service
                .refresh_provider_pages(
                    "project-a",
                    "provider-generation-terminal-replay",
                    std::slice::from_ref(&terminal_page),
                )
                .expect("replay identical terminal provider page")
                .1,
            0
        );
        let repaired = Connection::open(fixture.service.database_path_for_test("project-a"))
            .expect("inspect replay-repaired provider turn");
        let repaired_state: (String, Option<String>, Option<String>, Option<String>) = repaired
            .query_row(
                "SELECT state, mutation_kind, mutation_identity, mutation_phase
                 FROM turns WHERE thread_id = 'thread-a' AND turn_id = 'turn-a'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("read replay-repaired provider turn");
        assert_eq!(repaired_state, ("completed".into(), None, None, None));
        drop(repaired);
        assert_eq!(
            fixture
                .service
                .claim_turn_mutation(
                    "project-a",
                    "thread-a",
                    "turn-a",
                    TurnMutationKind::Stop,
                    "stop-identity-a",
                )
                .expect_err("provider-terminal turn fails closed")
                .code,
            "runtime_turn_not_projection_owned"
        );
    }

    #[test]
    fn durable_approval_claim_is_exact_once_and_restart_stale() {
        let fixture = Fixture::new();
        fixture
            .service
            .ingest_domain_events_for_connection(
                "project-a",
                Some("runtime-a"),
                &[approval_domain_envelope(1, "approval-a")],
            )
            .expect("project live approval");

        assert_eq!(
            fixture
                .service
                .claim_approval_response(
                    "project-a",
                    "runtime-a",
                    "provider-b",
                    "approval-a",
                    "accept",
                )
                .expect_err("a prior provider connection must never be claimable")
                .code,
            "runtime_approval_stale_after_provider_reconnect"
        );

        let acquired = fixture
            .service
            .claim_approval_response(
                "project-a",
                "runtime-a",
                "provider-a",
                "approval-a",
                "accept",
            )
            .expect("claim approval");
        let ApprovalResponseClaimResult::Acquired(claim) = acquired else {
            panic!("first response must acquire the durable claim")
        };
        assert_eq!(claim.provider_connection_id, "provider-a");
        assert_eq!(
            fixture
                .service
                .claim_approval_response(
                    "project-a",
                    "runtime-a",
                    "provider-a",
                    "approval-a",
                    "accept",
                )
                .expect_err("same decision must not race an in-flight send")
                .code,
            "runtime_approval_response_in_progress"
        );
        assert_eq!(
            fixture
                .service
                .claim_approval_response(
                    "project-a",
                    "runtime-a",
                    "provider-a",
                    "approval-a",
                    "decline",
                )
                .expect_err("different decision must conflict")
                .code,
            "runtime_approval_response_conflict"
        );
        fixture
            .service
            .mark_approval_response_accepted("project-a", "approval-a", &claim.identity, "accept")
            .expect("persist accepted response");
        assert_eq!(
            fixture
                .service
                .claim_approval_response(
                    "project-a",
                    "runtime-a",
                    "provider-a",
                    "approval-a",
                    "accept",
                )
                .expect("accepted exact duplicate"),
            ApprovalResponseClaimResult::Duplicate {
                decision: "accept".into()
            }
        );
        assert_eq!(
            fixture
                .service
                .claim_approval_response(
                    "project-a",
                    "runtime-a",
                    "provider-a",
                    "approval-a",
                    "decline",
                )
                .expect_err("accepted approval rejects another decision")
                .code,
            "runtime_approval_already_answered"
        );

        fixture
            .service
            .ingest_domain_events_for_connection(
                "project-a",
                Some("runtime-a"),
                &[approval_domain_envelope(2, "approval-b")],
            )
            .expect("project second live approval");
        fixture
            .service
            .claim_approval_response(
                "project-a",
                "runtime-a",
                "provider-a",
                "approval-b",
                "decline",
            )
            .expect("claim second approval");
        let reopened = ProjectionService::open_trusted(
            fixture.service.root.clone(),
            fixture.service.trusted_app_data_root.clone(),
        )
        .expect("reopen projection service");
        reopened
            .require_existing_project("project-a")
            .expect("recover prior native lifetime");
        let uncertain = reopened
            .claim_approval_response(
                "project-a",
                "runtime-a",
                "provider-a",
                "approval-b",
                "decline",
            )
            .expect_err("crashed response remains unknown after restart");
        assert_eq!(uncertain.code, "runtime_approval_response_outcome_unknown");
        assert!(uncertain.outcome_unknown);
        assert_eq!(
            reopened
                .claim_approval_response(
                    "project-a",
                    "runtime-b",
                    "provider-a",
                    "approval-b",
                    "decline",
                )
                .expect_err("prior runtime connection is stale")
                .code,
            "runtime_approval_stale_after_restart"
        );
    }

    #[test]
    fn approval_actionability_requires_exact_method_effect_and_both_live_connections() {
        let fixture = Fixture::new();
        let mut mismatched = approval_projection_event(1, "approval-mismatched");
        mismatched.payload["requestedEffect"]["kind"] = Value::String("file_change".into());
        fixture
            .service
            .ingest_domain_events_for_connection(
                "project-a",
                Some("runtime-a"),
                &[domain_envelope_from_projection(mismatched)],
            )
            .expect("project method/effect mismatch");

        let snapshot = fixture
            .service
            .conversation_for_runtime(
                &conversation_input(10),
                Some("runtime-a"),
                Some("provider-a"),
            )
            .expect("classify exact approval bindings");
        assert_eq!(snapshot.pending_requests.len(), 1);
        assert_eq!(snapshot.pending_requests[0].recovery_state, "stale");
        assert_eq!(
            fixture
                .service
                .claim_approval_response(
                    "project-a",
                    "runtime-a",
                    "provider-a",
                    "approval-mismatched",
                    "accept",
                )
                .expect_err("method/effect mismatch must fail closed")
                .code,
            "runtime_approval_effect_unsupported"
        );
    }

    #[test]
    fn live_approval_precedes_two_hundred_stale_rows_and_every_stale_row_is_cursor_reachable() {
        let fixture = Fixture::new();
        let mut events = Vec::new();
        for sequence in 1..=201 {
            let request_key = format!("stale-{sequence:03}");
            let mut event = approval_projection_event(sequence, &request_key);
            let payload = event.payload.as_object_mut().expect("approval payload");
            payload.remove("providerConnectionId");
            payload.remove("requestId");
            events.push(domain_envelope_from_projection(event));
        }
        events.push(approval_domain_envelope(202, "live-current"));
        fixture
            .service
            .ingest_domain_events_for_connection("project-a", Some("runtime-a"), &events)
            .expect("project mixed live and stale approvals");

        let mut input = conversation_input(MAX_PAGE_SIZE);
        let mut seen = HashSet::new();
        let mut page_index = 0;
        loop {
            let page = fixture
                .service
                .conversation_for_runtime(
                    &input,
                    Some("runtime-a"),
                    Some("provider-a"),
                )
                .expect("read bounded approval recovery page");
            if page_index == 0 {
                assert_eq!(page.pending_requests.len(), MAX_PAGE_SIZE as usize);
                assert_eq!(page.pending_requests[0].request_key, "live-current");
                assert_eq!(page.pending_requests[0].recovery_state, "actionable");
                let cursor = page
                    .pending_request_older_cursor
                    .as_deref()
                    .expect("stale continuation cursor");
                assert!(!cursor.contains("runtime-a"));
                assert!(!cursor.contains("provider-a"));
            }
            for request in page.pending_requests {
                assert!(seen.insert(request.request_key));
            }
            let Some(cursor) = page.pending_request_older_cursor else {
                break;
            };
            input.pending_request_cursor = Some(cursor);
            page_index += 1;
        }
        assert_eq!(page_index, 1);
        assert_eq!(seen.len(), 202);
        assert!(seen.contains("live-current"));
        assert_eq!(
            seen.iter().filter(|request| request.starts_with("stale-")).count(),
            201
        );
    }

    #[test]
    fn outcome_unknown_remains_visible_and_stale_after_expiry_wins_the_status_race() {
        let fixture = Fixture::new();
        fixture
            .service
            .ingest_domain_events_for_connection(
                "project-a",
                Some("runtime-a"),
                &[approval_domain_envelope(1, "approval-unknown")],
            )
            .expect("project live approval");
        let ApprovalResponseClaimResult::Acquired(claim) = fixture
            .service
            .claim_approval_response(
                "project-a",
                "runtime-a",
                "provider-a",
                "approval-unknown",
                "accept",
            )
            .expect("claim approval")
        else {
            panic!("approval must be acquired")
        };
        fixture
            .service
            .mark_approval_response_outcome_unknown(
                "project-a",
                "approval-unknown",
                &claim.identity,
                "accept",
            )
            .expect("persist unknown provider outcome");
        let mut expired = domain_event(2, None, None);
        expired.kind = "attention.request_resolved".into();
        expired.phase = "completed".into();
        expired.item_id = Some("approval-unknown".into());
        expired.payload = serde_json::json!({
            "requestKey": "approval-unknown",
            "resolution": "expired",
            "visibility": "public",
        });
        fixture
            .service
            .ingest_domain_events_for_connection(
                "project-a",
                Some("runtime-a"),
                &[domain_envelope_from_projection(expired)],
            )
            .expect("apply expiry after uncertain response");

        let snapshot = fixture
            .service
            .conversation_for_runtime(
                &conversation_input(10),
                Some("runtime-a"),
                Some("provider-a"),
            )
            .expect("read uncertain approval after expiry");
        assert_eq!(snapshot.pending_requests.len(), 1);
        assert_eq!(snapshot.pending_requests[0].request_key, "approval-unknown");
        assert_eq!(
            snapshot.pending_requests[0].response_phase.as_deref(),
            Some("outcome_unknown")
        );
        assert_eq!(snapshot.pending_requests[0].recovery_state, "stale");
    }

    #[test]
    fn resolved_approval_never_reopens_from_a_replayed_request() {
        let fixture = Fixture::new();
        let requested = approval_domain_envelope(1, "approval-a");
        fixture
            .service
            .ingest_domain_events_for_connection(
                "project-a",
                Some("runtime-a"),
                std::slice::from_ref(&requested),
            )
            .expect("project approval");
        let ApprovalResponseClaimResult::Acquired(claim) = fixture
            .service
            .claim_approval_response(
                "project-a",
                "runtime-a",
                "provider-a",
                "approval-a",
                "accept",
            )
            .expect("claim approval")
        else {
            panic!("first response must acquire the durable claim")
        };
        fixture
            .service
            .mark_approval_response_accepted("project-a", "approval-a", &claim.identity, "accept")
            .expect("persist accepted response");
        assert_eq!(
            fixture
                .service
                .snapshot("project-a")
                .expect("snapshot")
                .pending_request_count,
            0
        );

        let replay = approval_domain_envelope(3, "approval-a");
        fixture
            .service
            .ingest_domain_events_for_connection("project-a", Some("runtime-a"), &[replay])
            .expect("ingest repeated request key");
        assert_eq!(
            fixture
                .service
                .snapshot("project-a")
                .expect("snapshot")
                .pending_request_count,
            0
        );
    }

    #[test]
    fn v15_partial_schema_migrates_without_duplicate_columns_or_inventing_private_identity() {
        let fixture = Fixture::new();
        let path = fixture.service.database_path_for_test("project-a");
        let connection = Connection::open(&path).expect("open partial v15 fixture");
        connection
            .execute(
                "INSERT INTO pending_requests(
                   request_key, event_id, thread_id, turn_id, agent_id, request_kind,
                   method, response_options_json, prompt, status, created_at, resolved_at,
                   runtime_connection_id, provider_connection_id, provider_request_id,
                   requested_effect_kind, response_identity, response_decision, response_phase)
                 VALUES(
                   'legacy-approval', 'legacy-event', 'thread-a', 'turn-a', 'orchestrator',
                   'attention.approval_requested', 'item/commandExecution/requestApproval',
                   '[\"accept\",\"decline\"]', NULL, 'pending',
                   '2026-08-16T10:00:00.001Z', NULL, 'runtime-a', 'provider-a', NULL,
                   'command_execution', NULL, NULL, NULL)",
                [],
            )
            .expect("seed approval without v16 provider request identity");
        connection
            .pragma_update(None, "user_version", 15)
            .expect("downgrade metadata while retaining partially added columns");
        drop(connection);

        let reopened = ProjectionService::open_trusted(
            fixture.service.root.clone(),
            fixture.service.trusted_app_data_root.clone(),
        )
        .expect("reopen projection service");
        reopened
            .require_existing_project("project-a")
            .expect("migrate partial v15 schema idempotently");
        let migrated = Connection::open(path).expect("inspect migrated partial schema");
        let (version, provider_request_id): (u32, Option<String>) = migrated
            .query_row(
                "SELECT (SELECT user_version FROM pragma_user_version), provider_request_id
                 FROM pending_requests WHERE request_key = 'legacy-approval'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("read migrated legacy approval");
        assert_eq!(version, PROJECTION_DATABASE_SCHEMA_VERSION);
        assert_eq!(provider_request_id, None);
        drop(migrated);

        let snapshot = reopened
            .conversation_for_runtime(
                &conversation_input(10),
                Some("runtime-a"),
                Some("provider-a"),
            )
            .expect("read migrated legacy approval");
        assert_eq!(snapshot.pending_requests.len(), 1);
        assert_eq!(snapshot.pending_requests[0].recovery_state, "stale");
        assert_eq!(
            reopened
                .claim_approval_response(
                    "project-a",
                    "runtime-a",
                    "provider-a",
                    "legacy-approval",
                    "accept",
                )
                .expect_err("migration must not fabricate a provider request identity")
                .code,
            "runtime_approval_provider_request_missing"
        );
    }

    fn assert_current_history_schema(connection: &Connection) {
        let conversation_index_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'table' AND name = 'conversation_index'",
                [],
                |row| row.get(0),
            )
            .expect("inspect conversation history index table");
        assert_eq!(conversation_index_count, 1);
        let history_page_index_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'index' AND name = 'idx_conversation_index_page'",
                [],
                |row| row.get(0),
            )
            .expect("inspect conversation history page index");
        assert_eq!(history_page_index_count, 1);
        let message_fts_sql: String = connection
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'message_fts'",
                [],
                |row| row.get(0),
            )
            .expect("inspect legacy thread search FTS schema");
        assert!(!message_fts_sql.contains("agent_partition"));
    }

    #[test]
    fn new_and_direct_v12_databases_reach_current_projection_schema() {
        let current = Fixture::uninitialized();
        current
            .service
            .initialize_project("project-a")
            .expect("create current projection database");
        let current_connection =
            Connection::open(current.service.database_path_for_test("project-a"))
                .expect("inspect current projection database");
        let current_version: u32 = current_connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("read current schema version");
        assert_eq!(current_version, PROJECTION_DATABASE_SCHEMA_VERSION);
        assert_current_history_schema(&current_connection);
        for column in ["mutation_kind", "mutation_identity", "mutation_phase"] {
            assert!(table_has_column(&current_connection, "turns", column)
                .expect("inspect current turn mutation column"));
        }
        for column in [
            "runtime_connection_id",
            "provider_connection_id",
            "provider_request_id",
            "requested_effect_kind",
            "response_identity",
            "response_decision",
            "response_phase",
        ] {
            assert!(
                table_has_column(&current_connection, "pending_requests", column)
                    .expect("inspect current approval response column")
            );
        }

        let legacy = Fixture::uninitialized();
        let legacy_path = legacy.service.database_path_for_test("project-a");
        legacy
            .service
            .initialize_project("project-a")
            .expect("create migration fixture");
        let legacy_connection = Connection::open(&legacy_path).expect("open v12 database");
        legacy_connection
            .execute_batch(
                "ALTER TABLE turns DROP COLUMN mutation_phase;
                 ALTER TABLE turns DROP COLUMN mutation_identity;
                 ALTER TABLE turns DROP COLUMN mutation_kind;
                 ALTER TABLE pending_requests DROP COLUMN response_phase;
                 ALTER TABLE pending_requests DROP COLUMN response_decision;
                 ALTER TABLE pending_requests DROP COLUMN response_identity;
                 ALTER TABLE pending_requests DROP COLUMN provider_connection_id;
                 ALTER TABLE pending_requests DROP COLUMN runtime_connection_id;
                 DROP TABLE conversation_index;
                 DROP TABLE message_fts;
                 CREATE VIRTUAL TABLE message_fts USING fts5(
                   message_id UNINDEXED, thread_id UNINDEXED, text, tokenize='trigram'
                 );
                 PRAGMA user_version = 12;",
            )
            .expect("seed direct v12 database");
        drop(legacy_connection);
        let migrated =
            open_existing_database(&legacy_path, "project-a", true).expect("migrate v12 to v13");
        let migrated_version: u32 = migrated
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("read direct migration version");
        assert_eq!(migrated_version, PROJECTION_DATABASE_SCHEMA_VERSION);
        assert_current_history_schema(&migrated);
        for column in ["mutation_kind", "mutation_identity", "mutation_phase"] {
            assert!(table_has_column(&migrated, "turns", column)
                .expect("inspect migrated turn mutation column"));
        }
        for column in [
            "runtime_connection_id",
            "provider_connection_id",
            "provider_request_id",
            "requested_effect_kind",
            "response_identity",
            "response_decision",
            "response_phase",
        ] {
            assert!(table_has_column(&migrated, "pending_requests", column)
                .expect("inspect migrated approval response column"));
        }
    }

    #[test]
    fn projection_v9_migration_recurses_through_current_schema() {
        let fixture = Fixture::uninitialized();
        fixture
            .service
            .initialize_project("project-a")
            .expect("create current projection database");
        let path = fixture.service.database_path_for_test("project-a");
        let connection = Connection::open(&path).expect("open v9 migration fixture");
        connection
            .execute_batch(
                "ALTER TABLE turns DROP COLUMN mutation_phase;
                 ALTER TABLE turns DROP COLUMN mutation_identity;
                 ALTER TABLE turns DROP COLUMN mutation_kind;
                 ALTER TABLE pending_requests DROP COLUMN response_phase;
                 ALTER TABLE pending_requests DROP COLUMN response_decision;
                 ALTER TABLE pending_requests DROP COLUMN response_identity;
                 ALTER TABLE pending_requests DROP COLUMN provider_connection_id;
                 ALTER TABLE pending_requests DROP COLUMN runtime_connection_id;
                 DROP TABLE conversation_index;
                 DROP TABLE message_fts;
                 CREATE VIRTUAL TABLE message_fts USING fts5(
                   message_id UNINDEXED, thread_id UNINDEXED, text, tokenize='trigram'
                 );
                 PRAGMA user_version = 9;",
            )
            .expect("downgrade fixture to v9 boundary");
        drop(connection);

        let migrated = fixture
            .service
            .connection("project-a")
            .expect("migrate v9 through v13");
        let version: i64 = migrated
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("read migrated schema version");
        assert_eq!(version, PROJECTION_DATABASE_SCHEMA_VERSION as i64);
        assert_current_history_schema(&migrated);
        for column in ["mutation_kind", "mutation_identity", "mutation_phase"] {
            assert!(table_has_column(&migrated, "turns", column)
                .expect("inspect recursively migrated turn mutation column"));
        }
        let tables: i64 = migrated
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'table' AND name LIKE 'legacy_projection_%'",
                [],
                |row| row.get(0),
            )
            .expect("confirm retired legacy migration tables stay absent");
        assert_eq!(tables, 0);
    }
}
