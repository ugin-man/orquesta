use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::error::{AppError, AppResult};
use crate::projection_service::{
    ProjectionActivityCursor, ProjectionConversationInput, ProjectionConversationSnapshot,
    ProjectionCursor, ProjectionHistoryCursor, ProjectionHistoryIndexInput,
    ProjectionHistoryIndexPage, ProjectionHistoryPage, ProjectionHistoryPageInput,
    ProjectionService, ProviderActivityRecord, ProviderMessageRecord, ProviderPage,
};
use crate::sidecar::{ProjectionAuthorityBinding, SidecarSupervisor};
use crate::validation::bounded_id;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectionConversationCommandInput {
    pub renderer_session_id: String,
    pub renderer_generation: u64,
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
pub struct ProjectionHistoryIndexCommandInput {
    pub renderer_session_id: String,
    pub renderer_generation: u64,
    pub project_id: String,
    pub cursor: Option<ProjectionHistoryCursor>,
    pub limit: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectionHistoryPageCommandInput {
    pub renderer_session_id: String,
    pub renderer_generation: u64,
    pub project_id: String,
    pub target_agent_id: String,
    pub query: Option<String>,
    pub cursor: Option<ProjectionCursor>,
    pub limit: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyConversationPage {
    items: Vec<LegacyConversationItem>,
    #[serde(default)]
    activities: Vec<LegacyConversationActivity>,
    #[serde(default)]
    structured_activities_complete: bool,
    next_cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyConversationActivity {
    event_type: String,
    thread_id: String,
    turn_id: String,
    item_id: Option<String>,
    target_agent_id: String,
    occurred_at: String,
    payload: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyConversationItem {
    id: String,
    source_message_id: Option<String>,
    role: String,
    target_agent_id: String,
    text: String,
    created_at: String,
    thread_id: Option<String>,
    turn_id: Option<String>,
    kind: Option<String>,
}

struct RawProviderPage {
    thread_id: String,
    requested_cursor: Option<String>,
    records: Vec<ProviderMessageRecord>,
    activities: Vec<ProviderActivityRecord>,
}

fn projection_message_id(thread_id: &str, source_message_id: &str) -> String {
    let material = format!("orquesta.projection.message.v1\0{thread_id}\0{source_message_id}");
    format!(
        "projection-message-v1-{}",
        hex::encode(Sha256::digest(material.as_bytes()))
    )
}

async fn collect_provider_pages(
    runtime: &SidecarSupervisor,
    project_id: &str,
    root_path: &str,
    target_agent_id: &str,
) -> AppResult<(Vec<ProviderPage>, Vec<String>)> {
    let mut cursor: Option<String> = None;
    let mut raw_pages = Vec::new();
    let mut record_count = 0usize;
    for _ in 0..2_000usize {
        let value = runtime
            .call(
                "runtime.conversation",
                serde_json::json!({
                    "projectId": project_id,
                    "rootPath": root_path,
                    "targetAgentId": target_agent_id,
                    "cursor": cursor,
                    "limit": 50,
                    "includeStructuredActivities": true,
                }),
                60_000,
            )
            .await?;
        let page: LegacyConversationPage = serde_json::from_value(value).map_err(|error| {
            AppError::new("projection_provider_page_invalid", error.to_string())
        })?;
        if !page.structured_activities_complete {
            return Err(AppError::new(
                "projection_provider_activity_incomplete",
                "Provider history did not prove complete structured activity extraction",
            ));
        }
        if page.items.len() > 200 {
            return Err(AppError::new(
                "projection_provider_page_invalid",
                "Legacy conversation page exceeds its bounded limit",
            ));
        }
        if page.activities.len() > 1_000 {
            return Err(AppError::new(
                "projection_provider_page_invalid",
                "Structured activity page exceeds its bounded limit",
            ));
        }
        let mut by_thread: BTreeMap<String, Vec<ProviderMessageRecord>> = BTreeMap::new();
        let mut activities_by_thread: BTreeMap<String, Vec<ProviderActivityRecord>> =
            BTreeMap::new();
        for item in page.items {
            if item.kind.as_deref() == Some("session_boundary") || item.role == "system" {
                continue;
            }
            if !matches!(item.role.as_str(), "user" | "agent") {
                return Err(AppError::new(
                    "projection_provider_page_invalid",
                    "Legacy conversation contains an unsupported message role",
                ));
            }
            let thread_id = item.thread_id.ok_or_else(|| {
                AppError::new(
                    "projection_provider_page_invalid",
                    "Legacy conversation message has no exact thread generation",
                )
            })?;
            if item.target_agent_id != target_agent_id {
                return Err(AppError::new(
                    "projection_provider_page_invalid",
                    "Legacy conversation message belongs to another agent",
                ));
            }
            let source_message_id = bounded_id(
                item.source_message_id.as_deref().unwrap_or(&item.id),
                "providerMessageId",
            )?;
            by_thread
                .entry(thread_id.clone())
                .or_default()
                .push(ProviderMessageRecord {
                    message_id: projection_message_id(&thread_id, &source_message_id),
                    thread_id,
                    turn_id: item.turn_id,
                    target_agent_id: Some(item.target_agent_id),
                    role: item.role,
                    text: item.text,
                    created_at: item.created_at,
                });
            record_count += 1;
            if record_count > 10_000 {
                return Err(AppError::new(
                    "projection_legacy_migration_too_large",
                    "Legacy conversation exceeds the bounded 10000-message migration limit",
                ));
            }
        }
        for activity in page.activities {
            if activity.target_agent_id != target_agent_id {
                return Err(AppError::new(
                    "projection_provider_page_invalid",
                    "Structured activity belongs to another agent",
                ));
            }
            let thread_id = bounded_id(&activity.thread_id, "providerActivity.threadId")?;
            let record = ProviderActivityRecord {
                event_type: bounded_id(&activity.event_type, "providerActivity.eventType")?,
                thread_id: thread_id.clone(),
                turn_id: bounded_id(&activity.turn_id, "providerActivity.turnId")?,
                item_id: activity
                    .item_id
                    .as_deref()
                    .map(|value| bounded_id(value, "providerActivity.itemId"))
                    .transpose()?,
                target_agent_id: bounded_id(
                    &activity.target_agent_id,
                    "providerActivity.targetAgentId",
                )?,
                occurred_at: activity.occurred_at,
                payload: activity.payload,
            };
            activities_by_thread
                .entry(thread_id)
                .or_default()
                .push(record);
            record_count += 1;
            if record_count > 20_000 {
                return Err(AppError::new(
                    "projection_legacy_migration_too_large",
                    "Provider history exceeds the bounded 20000-record migration limit",
                ));
            }
        }
        let page_threads = by_thread
            .keys()
            .chain(activities_by_thread.keys())
            .cloned()
            .collect::<BTreeSet<_>>();
        if page_threads.len() > 1 {
            return Err(AppError::new(
                "projection_provider_page_invalid",
                "One logical conversation page crossed thread generations",
            ));
        }
        if let Some(thread_id) = page_threads.into_iter().next() {
            raw_pages.push(RawProviderPage {
                records: by_thread.remove(&thread_id).unwrap_or_default(),
                activities: activities_by_thread.remove(&thread_id).unwrap_or_default(),
                thread_id,
                requested_cursor: cursor.clone(),
            });
        }
        let next = page.next_cursor;
        if next.is_none() {
            let mut grouped: BTreeMap<String, Vec<RawProviderPage>> = BTreeMap::new();
            for raw in raw_pages {
                grouped.entry(raw.thread_id.clone()).or_default().push(raw);
            }
            let expected_threads = grouped.keys().cloned().collect::<Vec<_>>();
            let mut pages = Vec::new();
            for (thread_id, chain) in grouped {
                for (index, raw) in chain.iter().enumerate() {
                    let requested_cursor = if index == 0 {
                        None
                    } else {
                        raw.requested_cursor.clone()
                    };
                    let next_cursor = chain
                        .get(index + 1)
                        .and_then(|next| next.requested_cursor.clone());
                    let material = serde_json::json!({
                        "threadId": thread_id,
                        "requestedCursor": requested_cursor,
                        "nextCursor": next_cursor,
                        "records": raw.records,
                        "activities": raw.activities,
                    });
                    let digest = hex::encode(Sha256::digest(
                        serde_json::to_vec(&material).map_err(|error| {
                            AppError::new("projection_provider_page_invalid", error.to_string())
                        })?,
                    ));
                    pages.push(ProviderPage {
                        page_id: format!("provider-page-{digest}"),
                        thread_id: thread_id.clone(),
                        requested_cursor,
                        next_cursor: next_cursor.clone(),
                        is_complete: next_cursor.is_none(),
                        records: raw.records.clone(),
                        activities: raw.activities.clone(),
                        turns: Vec::new(),
                    });
                }
            }
            return Ok((pages, expected_threads));
        }
        cursor = next;
    }
    Err(AppError::new(
        "projection_legacy_migration_too_large",
        "Legacy conversation cursor chain exceeds 2000 pages",
    ))
}

async fn collect_project_provider_pages(
    runtime: &SidecarSupervisor,
    project_id: &str,
    root_path: &str,
) -> AppResult<(Vec<ProviderPage>, Vec<String>)> {
    let snapshot = runtime
        .call("repository.get-snapshot", serde_json::json!({}), 30_000)
        .await?;
    let mut target_agent_ids = BTreeSet::new();
    let agents = snapshot
        .get("agents")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            AppError::new(
                "projection_provider_roster_invalid",
                "Repository snapshot has no typed agent roster",
            )
        })?;
    if agents.len() > 2_000 {
        return Err(AppError::new(
            "projection_provider_roster_too_large",
            "Repository snapshot exceeds the bounded 2000-agent migration limit",
        ));
    }
    for agent in agents {
        let id = agent.get("id").and_then(Value::as_str).ok_or_else(|| {
            AppError::new(
                "projection_provider_roster_invalid",
                "Repository snapshot contains an agent without an exact id",
            )
        })?;
        target_agent_ids.insert(bounded_id(id, "targetAgentId")?);
    }

    let mut pages = Vec::new();
    let mut expected_threads = BTreeSet::new();
    let mut total_records = 0usize;
    for target_agent_id in target_agent_ids {
        let (agent_pages, agent_threads) =
            collect_provider_pages(runtime, project_id, root_path, &target_agent_id).await?;
        total_records += agent_pages
            .iter()
            .map(|page| page.records.len() + page.activities.len())
            .sum::<usize>();
        if total_records > 100_000 || pages.len() + agent_pages.len() > 10_000 {
            return Err(AppError::new(
                "projection_legacy_migration_too_large",
                "Project provider history exceeds the bounded migration limit",
            ));
        }
        pages.extend(agent_pages);
        expected_threads.extend(agent_threads);
    }
    Ok((pages, expected_threads.into_iter().collect()))
}

async fn after_registered_provider_projection_preflight<T, F, Fut>(
    projection: &ProjectionService,
    project_id: &str,
    continuation: F,
) -> AppResult<T>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = AppResult<T>>,
{
    let preflight_projection = projection.clone();
    let preflight_project_id = project_id.to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        preflight_projection.require_provider_project_identity(&preflight_project_id)
    })
    .await
    .map_err(|error| AppError::new("projection_worker_failed", error.to_string()))??;
    continuation().await
}

pub(crate) async fn refresh_provider_projection(
    runtime: SidecarSupervisor,
    projection: ProjectionService,
    project_id: String,
    root_path: String,
    binding: &ProjectionAuthorityBinding,
) -> AppResult<()> {
    let preflight_projection = projection.clone();
    let preflight_project_id = project_id.clone();
    after_registered_provider_projection_preflight(
        &preflight_projection,
        &preflight_project_id,
        || async move {
            refresh_provider_projection_after_preflight(
                runtime, projection, project_id, root_path, binding,
            )
            .await
        },
    )
    .await
}

async fn refresh_provider_projection_after_preflight(
    runtime: SidecarSupervisor,
    projection: ProjectionService,
    project_id: String,
    root_path: String,
    binding: &ProjectionAuthorityBinding,
) -> AppResult<()> {
    let provider_connection_id = runtime.current_provider_connection_id().await?;
    let refresh_project_id = project_id.clone();
    let refresh_provider_connection_id = provider_connection_id.clone();
    let refresh_projection = projection.clone();
    let required = tauri::async_runtime::spawn_blocking(move || {
        refresh_projection
            .provider_backfill_required(&refresh_project_id, &refresh_provider_connection_id)
    })
    .await
    .map_err(|error| AppError::new("projection_worker_failed", error.to_string()))??;
    if !required {
        runtime.reverify_projection_authority(binding).await?;
        return Ok(());
    }
    let (pages, _) = collect_project_provider_pages(&runtime, &project_id, &root_path).await?;
    if runtime.current_provider_connection_id().await? != provider_connection_id {
        return Err(AppError::new(
            "projection_provider_generation_changed",
            "Provider connection changed during background history refresh",
        ));
    }
    runtime.reverify_projection_authority(binding).await?;
    let apply_project_id = project_id.clone();
    let apply_provider_connection_id = provider_connection_id;
    let (snapshot, changed) = tauri::async_runtime::spawn_blocking(move || {
        projection.refresh_provider_pages(&apply_project_id, &apply_provider_connection_id, &pages)
    })
    .await
    .map_err(|error| AppError::new("projection_worker_failed", error.to_string()))??;
    runtime
        .emit_projection_refresh(
            binding,
            snapshot
                .stream_id
                .unwrap_or_else(|| "stream_missing".to_owned()),
            snapshot.applied_journal_sequence,
            snapshot.projection_revision,
            changed,
        )
        .await?;
    Ok(())
}

pub(crate) async fn conversation(
    runtime: &SidecarSupervisor,
    projection: ProjectionService,
    input: ProjectionConversationCommandInput,
) -> AppResult<ProjectionConversationSnapshot> {
    let binding = runtime
        .capture_projection_authority(None, &input.project_id)
        .await?;
    let authority = binding.authority();
    if authority.project_id != input.project_id
        || authority.renderer_session_id != input.renderer_session_id
        || authority.renderer_generation != input.renderer_generation
    {
        return Err(AppError::new(
            "runtime_authority_mismatch",
            "Conversation projection belongs to another runtime authority",
        ));
    }
    let query = ProjectionConversationInput {
        schema_version: 1,
        project_id: input.project_id,
        target_agent_id: input.target_agent_id,
        expected_stream_id: input.expected_stream_id,
        after_journal_sequence: input.after_journal_sequence,
        expected_projection_revision: input.expected_projection_revision,
        cursor: input.cursor,
        activity_cursor: input.activity_cursor,
        pending_request_cursor: input.pending_request_cursor,
        limit: input.limit,
    };
    let current_runtime_generation = binding.runtime_generation().to_owned();
    let current_provider_connection_id = runtime.observed_provider_connection_id().await;
    let query_provider_connection_id = current_provider_connection_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        projection.conversation_for_runtime(
            &query,
            Some(&current_runtime_generation),
            query_provider_connection_id.as_deref(),
        )
    })
    .await
    .map_err(|error| AppError::new("projection_worker_failed", error.to_string()))??;
    if runtime.observed_provider_connection_id().await != current_provider_connection_id {
        return Err(AppError::new(
            "projection_provider_generation_changed",
            "Provider connection changed during the bounded conversation read",
        ));
    }
    runtime.reverify_projection_authority(&binding).await?;
    Ok(result)
}

pub(crate) async fn history_index(
    runtime: &SidecarSupervisor,
    projection: ProjectionService,
    input: ProjectionHistoryIndexCommandInput,
) -> AppResult<ProjectionHistoryIndexPage> {
    let binding = runtime
        .capture_projection_authority(None, &input.project_id)
        .await?;
    let authority = binding.authority();
    if authority.project_id != input.project_id
        || authority.renderer_session_id != input.renderer_session_id
        || authority.renderer_generation != input.renderer_generation
    {
        return Err(AppError::new(
            "runtime_authority_mismatch",
            "History index belongs to another runtime authority",
        ));
    }
    let query = ProjectionHistoryIndexInput {
        schema_version: 1,
        project_id: input.project_id,
        cursor: input.cursor,
        limit: input.limit,
    };
    let result = tauri::async_runtime::spawn_blocking(move || projection.history_index(&query))
        .await
        .map_err(|error| AppError::new("projection_worker_failed", error.to_string()))??;
    runtime.reverify_projection_authority(&binding).await?;
    Ok(result)
}

pub(crate) async fn history_page(
    runtime: &SidecarSupervisor,
    projection: ProjectionService,
    input: ProjectionHistoryPageCommandInput,
) -> AppResult<ProjectionHistoryPage> {
    let binding = runtime
        .capture_projection_authority(None, &input.project_id)
        .await?;
    let authority = binding.authority();
    if authority.project_id != input.project_id
        || authority.renderer_session_id != input.renderer_session_id
        || authority.renderer_generation != input.renderer_generation
    {
        return Err(AppError::new(
            "runtime_authority_mismatch",
            "History page belongs to another runtime authority",
        ));
    }
    let query = ProjectionHistoryPageInput {
        schema_version: 1,
        project_id: input.project_id,
        target_agent_id: input.target_agent_id,
        query: input.query,
        cursor: input.cursor,
        limit: input.limit,
    };
    let result = tauri::async_runtime::spawn_blocking(move || projection.history_page(&query))
        .await
        .map_err(|error| AppError::new("projection_worker_failed", error.to_string()))??;
    runtime.reverify_projection_authority(&binding).await?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn p2d_provider_and_journal_message_ids_share_one_cross_runtime_identity() {
        assert_eq!(
            projection_message_id("thread-a", "message-a"),
            "projection-message-v1-ab8c0a1714b2bbca5a1f666a5232681dc577e315682a1449a29954412563c923"
        );
    }

    #[tokio::test]
    async fn bridge_identity_preflight_stops_before_provider_history_collection() {
        let base = std::env::temp_dir().join(format!(
            "orquesta-provider-bridge-preflight-{}",
            uuid::Uuid::new_v4()
        ));
        let app_data = base.join("app-data");
        let projection_root = app_data.join("projection");
        let projection = ProjectionService::open_trusted(projection_root.clone(), app_data)
            .expect("open projection fixture");
        projection
            .initialize_project("project-a")
            .expect("initialize projection fixture");
        let database = std::fs::read_dir(&projection_root)
            .expect("read projection root")
            .filter_map(Result::ok)
            .map(|entry| entry.path().join("projection.sqlite3"))
            .find(|path| path.is_file())
            .expect("projection SQLite fixture");
        let connection = rusqlite::Connection::open(database).expect("open projection SQLite");
        connection
            .execute("DELETE FROM projection_meta", [])
            .expect("remove registered identity");
        drop(connection);
        let collection_calls = std::sync::atomic::AtomicUsize::new(0);

        let error =
            after_registered_provider_projection_preflight(&projection, "project-a", || async {
                collection_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Ok(())
            })
            .await
            .expect_err("identity preflight must stop bridge collection");
        assert_eq!(error.code, "projection_database_invalid");
        assert_eq!(
            collection_calls.load(std::sync::atomic::Ordering::SeqCst),
            0
        );
        std::fs::remove_dir_all(base).expect("cleanup");
    }
}
