use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{AppError, AppResult};
use crate::logging::now_ms;
use crate::storage::{
    atomic_write_json, backup_path, materialize_sentinel, read_json, restore_failpoint,
    restore_primary_preserving_backup,
};
use crate::validation::{
    bounded_id, canonical_directory, canonical_path_string, normalized_project_name,
    platform_name_eq, platform_path_eq,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRecord {
    pub project_id: String,
    pub display_name: String,
    pub root_path: String,
    pub root_identity: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root_identity_v2: Option<String>,
    pub created_at_ms: u64,
    pub last_opened_at_ms: u64,
    #[serde(default)]
    pub hidden_from_recent: bool,
    #[serde(default)]
    pub last_work_agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub creation_operation_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub creation_request_sha256: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProjectionInitializationState {
    Pending,
    Ready,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StarterCreationPhase {
    Planned,
    RootOwned,
    RecoveryRequired,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StarterCreationClaim {
    pub operation_ref: String,
    pub request_sha256: String,
    pub display_name: String,
    pub parent_canonical_path: String,
    pub parent_identity: String,
    pub final_child_path: String,
    pub phase: StarterCreationPhase,
    pub owned_root_identity: Option<String>,
    pub created_at_ms: u64,
    pub last_observed_at_ms: u64,
    pub recovery_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StarterRecoverySummary {
    pub operation_ref: String,
    pub display_name: String,
    pub final_child_path: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectRegistrySnapshot {
    pub projects: Vec<ProjectRecord>,
    pub starter_creation_recoveries: Vec<StarterRecoverySummary>,
    pub selected_project_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct RegistryDocument {
    schema_version: u32,
    selected_project_id: Option<String>,
    projects: Vec<ProjectRecord>,
    #[serde(default)]
    projection_initialization: BTreeMap<String, ProjectionInitializationState>,
    #[serde(default)]
    starter_creation_claims: Vec<StarterCreationClaim>,
}

impl Default for RegistryDocument {
    fn default() -> Self {
        Self {
            schema_version: 3,
            selected_project_id: None,
            projects: Vec::new(),
            projection_initialization: BTreeMap::new(),
            starter_creation_claims: Vec::new(),
        }
    }
}

#[derive(Debug)]
pub struct ProjectRegistry {
    path: PathBuf,
    document: RegistryDocument,
    mutation_poisoned: bool,
}

impl ProjectRegistry {
    pub fn open(path: PathBuf) -> AppResult<Self> {
        let backup = backup_path(&path)?;
        let primary_exists = registry_state_file_exists(&path)?;
        let backup_exists = registry_state_file_exists(&backup)?;
        if !primary_exists && !backup_exists {
            materialize_sentinel(&path, &RegistryDocument::default())?;
        }
        let primary = match load_and_normalize_candidate(&path) {
            Err(error) if error.code == "project_registry_schema_unsupported" => return Err(error),
            result => result,
        };
        let (document, migrated, loaded_from_backup) = match primary {
            Ok(Some((document, migrated))) => (document, migrated, false),
            primary_result => match load_and_normalize_candidate(&backup) {
                Ok(Some((document, migrated))) => (document, migrated, true),
                Err(error) if error.code == "project_registry_schema_unsupported" => {
                    return Err(error);
                }
                _ => {
                    return Err(AppError::new(
                        "project_registry_identity_uncertain",
                        match primary_result {
                            Ok(None) => format!("{} is missing", path.display()),
                            Err(error) => error.message,
                            Ok(Some(_)) => unreachable!(),
                        },
                    )
                    .outcome_unknown(true));
                }
            },
        };
        let registry = Self {
            path,
            document,
            mutation_poisoned: false,
        };
        if loaded_from_backup {
            let write_result =
                restore_primary_preserving_backup(&registry.path, &registry.document);
            prove_exact_primary_write(&registry.path, &registry.document, write_result)?;
        } else if migrated {
            let write_result = atomic_write_json(&registry.path, &registry.document);
            prove_exact_primary_write(&registry.path, &registry.document, write_result)?;
        }
        Ok(registry)
    }

    #[cfg(test)]
    pub fn list(&self) -> Vec<ProjectRecord> {
        self.document.projects.clone()
    }

    pub fn visible_list(&self) -> Vec<ProjectRecord> {
        self.document
            .projects
            .iter()
            .filter(|project| !project.hidden_from_recent)
            .cloned()
            .collect()
    }

    pub fn archived_list(&self) -> Vec<ProjectRecord> {
        self.document
            .projects
            .iter()
            .filter(|project| project.hidden_from_recent)
            .cloned()
            .collect()
    }

    pub fn checked_snapshot(&self) -> AppResult<ProjectRegistrySnapshot> {
        self.ensure_current_authority()?;
        Ok(ProjectRegistrySnapshot {
            projects: self.visible_list(),
            starter_creation_recoveries: self.starter_recovery_summaries(),
            selected_project_id: self.selected_project_id(),
        })
    }
    pub fn starter_claims(&self) -> Vec<StarterCreationClaim> {
        self.document.starter_creation_claims.clone()
    }
    pub fn recovery_claim_for_target(
        &self,
        parent_path: &Path,
        final_path: &Path,
    ) -> AppResult<Option<StarterCreationClaim>> {
        self.ensure_current_authority()?;
        Ok(self
            .document
            .starter_creation_claims
            .iter()
            .find(|claim| {
                claim.phase == StarterCreationPhase::RecoveryRequired
                    && platform_path_eq(Path::new(&claim.parent_canonical_path), parent_path)
                    && platform_path_eq(Path::new(&claim.final_child_path), final_path)
            })
            .cloned())
    }
    pub fn starter_recovery_summaries(&self) -> Vec<StarterRecoverySummary> {
        self.document
            .starter_creation_claims
            .iter()
            .filter_map(|claim| {
                (claim.phase == StarterCreationPhase::RecoveryRequired).then(|| {
                    StarterRecoverySummary {
                        operation_ref: claim.operation_ref.clone(),
                        display_name: claim.display_name.clone(),
                        final_child_path: claim.final_child_path.clone(),
                        reason: claim
                            .recovery_reason
                            .clone()
                            .unwrap_or_else(|| "claim_marked_recovery_required".to_owned()),
                    }
                })
            })
            .collect()
    }
    pub fn selected_project_id(&self) -> Option<String> {
        self.document.selected_project_id.clone()
    }
    pub(crate) fn reload_from_disk(&mut self) -> AppResult<()> {
        *self = Self::open(self.path.clone())?;
        Ok(())
    }
    pub fn get(&self, project_id: &str) -> Option<ProjectRecord> {
        self.document
            .projects
            .iter()
            .find(|item| item.project_id == project_id)
            .cloned()
    }

    pub fn projection_initialization_state(
        &self,
        project_id: &str,
    ) -> AppResult<ProjectionInitializationState> {
        self.ensure_current_authority()?;
        self.document
            .projection_initialization
            .get(project_id)
            .copied()
            .ok_or_else(|| {
                AppError::new(
                    "project_registry_corrupt",
                    "Registered project has no projection initialization authority",
                )
            })
    }

    pub fn pending_projection_project_ids(&self) -> AppResult<Vec<String>> {
        self.ensure_current_authority()?;
        Ok(self
            .document
            .projection_initialization
            .iter()
            .filter_map(|(project_id, state)| {
                (*state == ProjectionInitializationState::Pending).then(|| project_id.clone())
            })
            .collect())
    }

    pub fn mark_projection_ready(&mut self, project_id: &str) -> AppResult<ProjectRecord> {
        let record = self.verify(project_id)?;
        match self.projection_initialization_state(project_id)? {
            ProjectionInitializationState::Ready => return Ok(record),
            ProjectionInitializationState::Pending => {}
        }
        let mut next = self.document.clone();
        next.projection_initialization
            .insert(project_id.to_owned(), ProjectionInitializationState::Ready);
        self.persist_document(&next)?;
        self.document = next;
        Ok(record)
    }

    pub fn register_read_only_named(
        &mut self,
        root: &str,
        display_name: Option<&str>,
    ) -> AppResult<ProjectRecord> {
        self.register_read_only_internal(root, display_name)
    }

    fn register_read_only_internal(
        &mut self,
        root: &str,
        requested_display_name: Option<&str>,
    ) -> AppResult<ProjectRecord> {
        let requested_display_name = normalized_display_name(requested_display_name)?;
        let requested_metadata_directory = Path::new(root)
            .file_name()
            .is_some_and(|name| platform_name_eq(name, std::ffi::OsStr::new(".orquesta")));
        let canonical = canonical_directory(root)?;
        if requested_metadata_directory
            || canonical
                .file_name()
                .is_some_and(|name| platform_name_eq(name, std::ffi::OsStr::new(".orquesta")))
        {
            return Err(AppError::new(
                "project_metadata_directory_selected",
                "The .orquesta metadata directory cannot be opened as a project; select its parent folder",
            ));
        }
        let root_path = canonical_path_string(&canonical)?;
        let snapshot = root_identity_snapshot(&canonical)?;
        let identity = snapshot.legacy_for(&canonical);
        let stable_identity = snapshot.stable.clone();
        let mut next = self.document.clone();

        let matching_index = next
            .projects
            .iter()
            .position(|item| {
                stable_identity.as_ref().is_some_and(|stable| {
                    item.root_identity_v2.as_ref() == Some(stable) || item.root_identity == *stable
                })
            })
            .or_else(|| {
                next.projects
                    .iter()
                    .position(|item| item.root_identity == identity)
            })
            .or_else(|| {
                next.projects.iter().position(|item| {
                    stable_identity.is_some()
                        && !item.root_identity.starts_with("v2:")
                        && snapshot.legacy_for(Path::new(&item.root_path)) == item.root_identity
                })
            });

        if let Some(index) = matching_index {
            let existing = &mut next.projects[index];
            existing.root_path = root_path;
            existing.root_identity = identity;
            existing.root_identity_v2 = stable_identity;
            existing.last_opened_at_ms = now_ms();
            existing.hidden_from_recent = false;
            let result = existing.clone();
            self.persist_document(&next)?;
            self.document = next;
            return Ok(result);
        }

        if stable_identity.is_none()
            && next.projects.iter().any(|item| {
                (item.root_identity.starts_with("v2:") || item.root_identity_v2.is_some())
                    && canonical_directory(&item.root_path).is_err()
            })
        {
            return Err(AppError::new(
                "project_identity_recovery_required",
                "A missing project has stable identity evidence, but this filesystem cannot prove whether the selected folder is that project",
            ));
        }
        let display_name = requested_display_name.unwrap_or_else(|| {
            canonical
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("Project")
                .to_owned()
        });
        let record = ProjectRecord {
            project_id: uuid::Uuid::new_v4().hyphenated().to_string(),
            display_name,
            root_path,
            root_identity: identity,
            root_identity_v2: stable_identity,
            created_at_ms: now_ms(),
            last_opened_at_ms: now_ms(),
            hidden_from_recent: false,
            last_work_agent_id: None,
            creation_operation_ref: None,
            creation_request_sha256: None,
        };
        next.projects.push(record.clone());
        next.projection_initialization.insert(
            record.project_id.clone(),
            ProjectionInitializationState::Pending,
        );
        self.persist_document(&next)?;
        self.document = next;
        Ok(record)
    }

    pub fn committed_creation(
        &self,
        operation_ref: &str,
        request_sha256: &str,
    ) -> AppResult<Option<ProjectRecord>> {
        self.ensure_current_authority()?;
        let record = self
            .document
            .projects
            .iter()
            .find(|project| project.creation_operation_ref.as_deref() == Some(operation_ref));
        if let Some(record) = record {
            if record.creation_request_sha256.as_deref() != Some(request_sha256) {
                return Err(AppError::new(
                    "project_creation_operation_mismatch",
                    "Starter creation operation was already used with different input",
                ));
            }
        }
        Ok(record.cloned())
    }

    pub fn starter_claim(
        &self,
        operation_ref: &str,
        request_sha256: &str,
    ) -> AppResult<Option<StarterCreationClaim>> {
        self.ensure_current_authority()?;
        let claim = self
            .document
            .starter_creation_claims
            .iter()
            .find(|claim| claim.operation_ref == operation_ref);
        if let Some(claim) = claim {
            if claim.request_sha256 != request_sha256 {
                return Err(AppError::new(
                    "project_creation_operation_mismatch",
                    "Starter creation operation was already used with different input",
                ));
            }
        }
        Ok(claim.cloned())
    }

    pub fn persist_starter_claim(&mut self, claim: StarterCreationClaim) -> AppResult<()> {
        validate_starter_claim(&claim)?;
        if self
            .committed_creation(&claim.operation_ref, &claim.request_sha256)?
            .is_some()
        {
            return Err(AppError::new(
                "project_creation_already_committed",
                "Starter creation is already committed",
            ));
        }
        let mut next = self.document.clone();
        if let Some(existing) = next
            .starter_creation_claims
            .iter_mut()
            .find(|existing| existing.operation_ref == claim.operation_ref)
        {
            if existing.request_sha256 != claim.request_sha256 {
                return Err(AppError::new(
                    "project_creation_operation_mismatch",
                    "Starter creation operation was already used with different input",
                ));
            }
            *existing = claim.clone();
        } else {
            next.starter_creation_claims.push(claim.clone());
        }
        validate_creation_uniqueness(&next)?;
        self.persist_document_reconciled(&next, |document| {
            document
                .starter_creation_claims
                .iter()
                .any(|candidate| candidate == &claim)
        })
    }

    pub fn retire_planned_claim(&mut self, operation_ref: &str) -> AppResult<()> {
        let mut next = self.document.clone();
        let before = next.starter_creation_claims.len();
        next.starter_creation_claims.retain(|claim| {
            claim.operation_ref != operation_ref || claim.phase != StarterCreationPhase::Planned
        });
        if before == next.starter_creation_claims.len() {
            return Ok(());
        }
        self.persist_document_reconciled(&next, |document| {
            document
                .starter_creation_claims
                .iter()
                .all(|claim| claim.operation_ref != operation_ref)
        })
    }

    pub fn mark_starter_recovery_required(
        &mut self,
        mut claim: StarterCreationClaim,
        reason: &str,
    ) -> AppResult<()> {
        claim.phase = StarterCreationPhase::RecoveryRequired;
        claim.recovery_reason = Some(reason.to_owned());
        claim.last_observed_at_ms = now_ms();
        self.persist_starter_claim(claim)
    }

    pub fn commit_starter_project(
        &mut self,
        claim: &StarterCreationClaim,
        root_path: String,
        root_identity: String,
        root_identity_v2: String,
    ) -> AppResult<ProjectRecord> {
        if let Some(record) =
            self.committed_creation(&claim.operation_ref, &claim.request_sha256)?
        {
            return Ok(record);
        }
        let pending = self
            .starter_claim(&claim.operation_ref, &claim.request_sha256)?
            .ok_or_else(|| {
                AppError::new(
                    "project_creation_claim_missing",
                    "Starter creation claim is missing",
                )
                .outcome_unknown(true)
            })?;
        if pending != *claim || pending.phase != StarterCreationPhase::RootOwned {
            return Err(AppError::new(
                "project_creation_recovery_required",
                "Starter creation claim is not in a committable phase",
            )
            .outcome_unknown(true));
        }
        if self.document.projects.iter().any(|project| {
            platform_path_eq(Path::new(&project.root_path), Path::new(&root_path))
                || project.root_identity_v2.as_deref() == Some(root_identity_v2.as_str())
        }) {
            return Err(AppError::new(
                "project_creation_target_conflict",
                "Starter project root is already registered",
            )
            .outcome_unknown(true));
        }
        let timestamp = now_ms();
        let record = ProjectRecord {
            project_id: uuid::Uuid::new_v4().hyphenated().to_string(),
            display_name: claim.display_name.clone(),
            root_path,
            root_identity,
            root_identity_v2: Some(root_identity_v2),
            created_at_ms: timestamp,
            last_opened_at_ms: timestamp,
            hidden_from_recent: false,
            last_work_agent_id: None,
            creation_operation_ref: Some(claim.operation_ref.clone()),
            creation_request_sha256: Some(claim.request_sha256.clone()),
        };
        let mut next = self.document.clone();
        next.starter_creation_claims
            .retain(|candidate| candidate.operation_ref != claim.operation_ref);
        next.projects.push(record.clone());
        next.projection_initialization.insert(
            record.project_id.clone(),
            ProjectionInitializationState::Pending,
        );
        validate_creation_uniqueness(&next)?;
        self.persist_document_reconciled(&next, |document| {
            document.projects.iter().any(|candidate| {
                candidate.creation_operation_ref.as_deref() == Some(claim.operation_ref.as_str())
                    && candidate.creation_request_sha256.as_deref()
                        == Some(claim.request_sha256.as_str())
                    && candidate.root_identity_v2 == record.root_identity_v2
            })
        })?;
        Ok(self
            .committed_creation(&claim.operation_ref, &claim.request_sha256)?
            .unwrap_or(record))
    }

    pub fn verify(&self, project_id: &str) -> AppResult<ProjectRecord> {
        let record = self
            .get(project_id)
            .ok_or_else(|| AppError::new("project_not_registered", "Project is not registered"))?;
        let canonical = canonical_directory(&record.root_path)?;
        let actual_path = canonical_path_string(&canonical)?;
        let snapshot = root_identity_snapshot(&canonical)?;
        let actual_identity = snapshot.legacy_for(&canonical);
        let actual_identity_v2 = snapshot.stable;
        if actual_path != record.root_path
            || actual_identity != record.root_identity
            || record
                .root_identity_v2
                .as_ref()
                .is_some_and(|expected| actual_identity_v2.as_ref() != Some(expected))
        {
            return Err(AppError::new(
                "project_identity_changed",
                "Project root identity changed; reselect it explicitly",
            ));
        }
        Ok(record)
    }

    pub fn select(&mut self, project_id: &str) -> AppResult<ProjectRecord> {
        let record = self.verify(project_id)?;
        let mut next = self.document.clone();
        next.selected_project_id = Some(project_id.to_owned());
        if let Some(item) = next
            .projects
            .iter_mut()
            .find(|item| item.project_id == project_id)
        {
            item.last_opened_at_ms = now_ms();
        }
        self.persist_document(&next)?;
        self.document = next;
        Ok(record)
    }

    pub fn archive(&mut self, project_id: &str) -> AppResult<()> {
        self.set_archived(project_id, true)
    }

    pub fn restore_archived(&mut self, project_id: &str) -> AppResult<()> {
        self.set_archived(project_id, false)
    }

    fn set_archived(&mut self, project_id: &str, archived: bool) -> AppResult<()> {
        bounded_id(project_id, "projectId")?;
        self.ensure_current_authority()?;
        let mut next = self.document.clone();
        let project = next
            .projects
            .iter_mut()
            .find(|item| item.project_id == project_id)
            .ok_or_else(|| AppError::new("project_not_registered", "Project is not registered"))?;
        if project.hidden_from_recent == archived {
            return Ok(());
        }
        project.hidden_from_recent = archived;
        if archived && next.selected_project_id.as_deref() == Some(project_id) {
            next.selected_project_id = None;
        }
        self.persist_document(&next)?;
        self.document = next;
        Ok(())
    }

    pub fn hide_from_recent(&mut self, project_id: &str) -> AppResult<Vec<ProjectRecord>> {
        self.archive(project_id)?;
        Ok(self.visible_list())
    }

    pub fn set_last_work_agent(
        &mut self,
        project_id: &str,
        target_agent_id: &str,
    ) -> AppResult<ProjectRecord> {
        bounded_id(project_id, "projectId")?;
        bounded_id(target_agent_id, "targetAgentId")?;
        self.verify(project_id)?;
        let mut next = self.document.clone();
        let project = next
            .projects
            .iter_mut()
            .find(|item| item.project_id == project_id)
            .ok_or_else(|| AppError::new("project_not_registered", "Project is not registered"))?;
        project.last_work_agent_id = Some(target_agent_id.to_owned());
        let record = project.clone();
        self.persist_document(&next)?;
        self.document = next;
        Ok(record)
    }

    fn persist_document(&mut self, document: &RegistryDocument) -> AppResult<()> {
        self.persist_document_reconciled(document, |candidate| candidate == document)
    }

    fn ensure_current_authority(&self) -> AppResult<()> {
        if self.mutation_poisoned {
            return Err(AppError::new(
                "project_registry_reopen_required",
                "Project registry authority must be reopened before another mutation",
            )
            .outcome_unknown(true));
        }
        Ok(())
    }

    fn persist_document_reconciled(
        &mut self,
        document: &RegistryDocument,
        committed: impl Fn(&RegistryDocument) -> bool,
    ) -> AppResult<()> {
        self.ensure_current_authority()?;
        let write_result = atomic_write_json(&self.path, document);
        let primary_result = read_commit_candidate(&self.path);
        let backup_result = backup_path(&self.path).and_then(|path| read_commit_candidate(&path));
        if let Ok(Some(primary)) = primary_result.as_ref() {
            if primary == document && committed(primary) {
                self.document = primary.clone();
                self.mutation_poisoned = false;
                return Ok(());
            }
        }
        let primary_uncommitted = primary_result
            .as_ref()
            .ok()
            .and_then(Option::as_ref)
            .is_some_and(|candidate| !committed(candidate));
        let backup_uncommitted = backup_result
            .as_ref()
            .ok()
            .and_then(Option::as_ref)
            .is_some_and(|candidate| !committed(candidate));
        if primary_uncommitted && backup_uncommitted {
            return Err(match write_result {
                Err(error) => error.outcome_unknown(false),
                Ok(()) => AppError::new(
                    "project_registry_commit_not_observed",
                    "Registry write returned successfully but neither durable generation contains the commit",
                )
                .outcome_unknown(false),
            });
        }
        match Self::open(self.path.clone()) {
            Ok(fresh) => {
                let exact = fresh.document == *document && committed(&fresh.document);
                *self = fresh;
                if exact {
                    return Ok(());
                }
            }
            Err(_) => {
                self.mutation_poisoned = true;
            }
        }
        Err(AppError::new(
            "project_registry_reopen_required",
            "Registry commit outcome cannot be proven by exact primary readback",
        )
        .outcome_unknown(true))
    }
}

fn prove_exact_primary_write(
    path: &Path,
    expected: &RegistryDocument,
    write_result: AppResult<()>,
) -> AppResult<()> {
    let readback = (|| {
        restore_failpoint("before_readback")?;
        let restored = read_exact_primary_candidate(path)?.ok_or_else(|| {
            AppError::new(
                "project_registry_identity_uncertain",
                "Project registry primary is missing after an authority write",
            )
            .outcome_unknown(true)
        })?;
        validate_document_integrity(&restored)?;
        if restored != *expected {
            return Err(AppError::new(
                "project_registry_identity_uncertain",
                "Project registry primary readback did not match the selected authority",
            )
            .outcome_unknown(true));
        }
        Ok(())
    })();
    match readback {
        Ok(()) => Ok(()),
        Err(read_error) => match write_result {
            Err(write_error) if !write_error.outcome_unknown => Err(write_error),
            _ => Err(read_error.outcome_unknown(true)),
        },
    }
}

fn read_exact_primary_candidate(path: &Path) -> AppResult<Option<RegistryDocument>> {
    #[cfg(test)]
    {
        let active = TEST_COMMIT_READBACK_FAILPOINT.with(|current| *current.borrow());
        if active == Some("exact_readback_error") {
            return Err(AppError::new(
                "project_registry_test_exact_readback_failed",
                "Injected exact project registry readback failure",
            )
            .outcome_unknown(true));
        }
        if active == Some("exact_readback_mismatch") {
            return Ok(Some(RegistryDocument {
                schema_version: 3,
                selected_project_id: Some("injected-nonexistent-project".to_owned()),
                projects: Vec::new(),
                projection_initialization: BTreeMap::new(),
                starter_creation_claims: Vec::new(),
            }));
        }
    }
    read_json(path)
}

#[cfg(test)]
thread_local! {
    static TEST_COMMIT_READBACK_FAILPOINT: std::cell::RefCell<Option<&'static str>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
pub(crate) fn set_commit_readback_failpoint(name: Option<&'static str>) {
    TEST_COMMIT_READBACK_FAILPOINT.with(|current| *current.borrow_mut() = name);
}

fn read_commit_candidate(path: &Path) -> AppResult<Option<RegistryDocument>> {
    #[cfg(test)]
    {
        let active = TEST_COMMIT_READBACK_FAILPOINT.with(|current| *current.borrow());
        if active == Some("readback_error") {
            return Err(AppError::new(
                "project_creation_test_readback_failed",
                "Injected registry commit readback failure",
            )
            .outcome_unknown(true));
        }
        if active == Some("fresh_open_error") {
            return Err(AppError::new(
                "project_creation_test_fresh_open_failed",
                "Injected registry authority refresh failure",
            )
            .outcome_unknown(true));
        }
        if active == Some("readback_mismatch") {
            return Ok(Some(RegistryDocument::default()));
        }
    }
    load_and_normalize_candidate(path).map(|candidate| candidate.map(|(document, _)| document))
}

fn load_and_normalize_candidate(path: &Path) -> AppResult<Option<(RegistryDocument, bool)>> {
    #[cfg(test)]
    {
        let active = TEST_COMMIT_READBACK_FAILPOINT.with(|current| *current.borrow());
        if active == Some("fresh_open_error") {
            return Err(AppError::new(
                "project_creation_test_fresh_open_failed",
                "Injected registry authority refresh failure",
            )
            .outcome_unknown(true));
        }
    }
    let Some(document) = read_json::<RegistryDocument>(path)? else {
        return Ok(None);
    };
    normalize_registry_document(document).map(Some)
}

fn normalize_registry_document(
    mut document: RegistryDocument,
) -> AppResult<(RegistryDocument, bool)> {
    let source_schema_version = document.schema_version;
    if matches!(source_schema_version, 1 | 2) {
        document.schema_version = 3;
        document.projection_initialization = document
            .projects
            .iter()
            .map(|project| {
                (
                    project.project_id.clone(),
                    ProjectionInitializationState::Ready,
                )
            })
            .collect();
    } else if source_schema_version != 3 {
        return Err(AppError::new(
            "project_registry_schema_unsupported",
            "Project registry was written by a newer Desktop Next",
        ));
    }
    let mut seen = std::collections::HashSet::new();
    let mut seen_v2 = std::collections::HashSet::new();
    let mut migrated = source_schema_version != 3;
    for project in &mut document.projects {
        bounded_id(&project.project_id, "projectId")?;
        if !seen.insert(&project.project_id) {
            return Err(AppError::new(
                "project_registry_corrupt",
                "Duplicate project id",
            ));
        }
        validate_primary_identity(&project.root_identity)?;
        if let Some(identity) = project.root_identity_v2.as_deref() {
            validate_v2_identity(identity)?;
        }
        if let Some(agent_id) = project.last_work_agent_id.as_deref() {
            bounded_id(agent_id, "lastWorkAgentId")?;
        }
        validate_creation_record_fields(project)?;
        if let Ok(canonical) = canonical_directory(&project.root_path) {
            let snapshot = root_identity_snapshot(&canonical)?;
            let legacy = snapshot.legacy_for(&canonical);
            let stable = snapshot.stable;
            if project.root_identity.starts_with("v2:") {
                if stable.as_deref() != Some(project.root_identity.as_str()) {
                    return Err(AppError::new(
                        "project_registry_corrupt",
                        "V2 project identity does not match its recorded root",
                    ));
                }
                project.root_identity = legacy;
                project.root_identity_v2 = stable;
                migrated = true;
            } else {
                if legacy != project.root_identity {
                    return Err(AppError::new(
                        "project_registry_corrupt",
                        "Legacy project identity does not match its recorded root",
                    ));
                }
                if project.root_identity_v2 != stable {
                    if let (Some(recorded), Some(actual)) =
                        (project.root_identity_v2.as_deref(), stable.as_deref())
                    {
                        if recorded != actual {
                            return Err(AppError::new(
                                "project_registry_corrupt",
                                "Stable project identity does not match its recorded root",
                            ));
                        }
                    }
                    project.root_identity_v2 = stable;
                    migrated = true;
                }
            }
        }
        let effective_v2 = project.root_identity_v2.as_deref().or_else(|| {
            project
                .root_identity
                .starts_with("v2:")
                .then_some(project.root_identity.as_str())
        });
        if let Some(identity) = effective_v2 {
            if !seen_v2.insert(identity.to_owned()) {
                return Err(AppError::new(
                    "project_registry_corrupt",
                    "Duplicate stable project identity",
                ));
            }
        }
    }
    let mut retained_claims = Vec::with_capacity(document.starter_creation_claims.len());
    for claim in document.starter_creation_claims.drain(..) {
        let committed = document.projects.iter().find(|project| {
            project.creation_operation_ref.as_deref() == Some(claim.operation_ref.as_str())
        });
        if let Some(project) = committed {
            if project.creation_request_sha256.as_deref() != Some(claim.request_sha256.as_str())
                || project.display_name != claim.display_name
                || !platform_path_eq(
                    Path::new(&project.root_path),
                    Path::new(&claim.final_child_path),
                )
                || project.root_identity_v2 != claim.owned_root_identity
            {
                return Err(AppError::new(
                    "project_creation_recovery_required",
                    "Committed Starter record conflicts with its pending claim",
                )
                .outcome_unknown(true));
            }
            migrated = true;
        } else {
            retained_claims.push(claim);
        }
    }
    document.starter_creation_claims = retained_claims;
    validate_creation_uniqueness(&document)?;
    validate_document_integrity(&document)?;
    Ok((document, migrated))
}

fn registry_state_file_exists(path: &Path) -> AppResult<bool> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(AppError::io("inspect project registry state file", error)),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(AppError::new(
            "project_registry_identity_uncertain",
            format!(
                "Project registry path is not a regular file: {}",
                path.display()
            ),
        )
        .outcome_unknown(true));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(AppError::new(
                "project_registry_identity_uncertain",
                format!(
                    "Project registry path is a reparse point: {}",
                    path.display()
                ),
            )
            .outcome_unknown(true));
        }
    }
    Ok(true)
}

fn validate_creation_record_fields(project: &ProjectRecord) -> AppResult<()> {
    match (
        project.creation_operation_ref.as_deref(),
        project.creation_request_sha256.as_deref(),
    ) {
        (None, None) => Ok(()),
        (Some(operation_ref), Some(request_sha256)) => {
            let canonical = uuid::Uuid::parse_str(operation_ref)
                .map_err(|_| {
                    AppError::new(
                        "project_registry_corrupt",
                        "Starter creation operation is invalid",
                    )
                })?
                .hyphenated()
                .to_string();
            let normalized_name = normalized_project_name(&project.display_name).map_err(|_| {
                AppError::new(
                    "project_registry_corrupt",
                    "Starter creation record name is invalid",
                )
            })?;
            if canonical != operation_ref
                || !valid_hex(request_sha256, 64)
                || starter_creation_request_sha256(&normalized_name) != request_sha256
                || normalized_name != project.display_name
                || project
                    .root_identity_v2
                    .as_deref()
                    .is_none_or(|identity| validate_v2_identity(identity).is_err())
                || !is_lexically_normal_absolute(Path::new(&project.root_path))
                || !Path::new(&project.root_path).is_absolute()
                || Path::new(&project.root_path)
                    .file_name()
                    .is_none_or(|name| !platform_name_eq(name, normalized_name.as_ref()))
            {
                return Err(AppError::new(
                    "project_registry_corrupt",
                    "Starter creation record digest is invalid",
                ));
            }
            Ok(())
        }
        _ => Err(AppError::new(
            "project_registry_corrupt",
            "Starter creation record is incomplete",
        )),
    }
}

fn validate_starter_claim(claim: &StarterCreationClaim) -> AppResult<()> {
    let canonical = uuid::Uuid::parse_str(&claim.operation_ref)
        .map_err(|_| {
            AppError::new(
                "project_registry_corrupt",
                "Starter creation claim operation is invalid",
            )
        })?
        .hyphenated()
        .to_string();
    let normalized_name = normalized_project_name(&claim.display_name).map_err(|_| {
        AppError::new(
            "project_registry_corrupt",
            "Starter creation claim name is invalid",
        )
    })?;
    let expected_final = Path::new(&claim.parent_canonical_path).join(&normalized_name);
    let recovery_reason_valid = match claim.phase {
        StarterCreationPhase::RecoveryRequired => claim
            .recovery_reason
            .as_deref()
            .is_some_and(valid_recovery_reason),
        StarterCreationPhase::Planned | StarterCreationPhase::RootOwned => {
            claim.recovery_reason.is_none()
        }
    };
    if canonical != claim.operation_ref
        || !valid_hex(&claim.request_sha256, 64)
        || starter_creation_request_sha256(&normalized_name) != claim.request_sha256
        || normalized_name != claim.display_name
        || !Path::new(&claim.parent_canonical_path).is_absolute()
        || !Path::new(&claim.final_child_path).is_absolute()
        || !is_lexically_normal_absolute(Path::new(&claim.parent_canonical_path))
        || !is_lexically_normal_absolute(Path::new(&claim.final_child_path))
        || !platform_path_eq(Path::new(&claim.final_child_path), &expected_final)
        || !claim.parent_identity.starts_with("v2:")
        || validate_v2_identity(&claim.parent_identity).is_err()
        || claim
            .owned_root_identity
            .as_deref()
            .is_some_and(|identity| validate_v2_identity(identity).is_err())
        || (claim.phase == StarterCreationPhase::RootOwned && claim.owned_root_identity.is_none())
        || (claim.phase == StarterCreationPhase::Planned && claim.owned_root_identity.is_some())
        || !recovery_reason_valid
    {
        return Err(AppError::new(
            "project_registry_corrupt",
            "Starter creation claim is invalid",
        ));
    }
    Ok(())
}

fn is_lexically_normal_absolute(path: &Path) -> bool {
    if !path.is_absolute() {
        return false;
    }
    let mut rebuilt = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::ParentDir | std::path::Component::CurDir => return false,
            _ => rebuilt.push(component.as_os_str()),
        }
    }
    platform_path_eq(path, &rebuilt)
}

fn valid_recovery_reason(reason: &str) -> bool {
    if bounded_id(reason, "recoveryReason").is_err() {
        return false;
    }
    matches!(
        reason,
        "derived_child_path_mismatch"
            | "planned_final_path_exists_without_owned_identity"
            | "new_root_identity_or_contents_unproven"
            | "owned_root_unavailable"
            | "owned_root_identity_mismatch"
            | "owned_root_identity_or_contents_unproven"
            | "owned_root_canonical_path_mismatch"
            | "registered_identity_mismatch"
            | "precommit_root_identity_or_contents_unproven"
            | "restart_parent_unavailable"
            | "restart_derived_path_mismatch"
            | "restart_planned_final_exists_without_owned_identity"
    )
}

fn validate_creation_uniqueness(document: &RegistryDocument) -> AppResult<()> {
    let mut operations = std::collections::HashSet::new();
    let mut paths: Vec<&Path> = Vec::new();
    let mut stable_identities = std::collections::HashSet::new();
    for project in &document.projects {
        validate_creation_record_fields(project)?;
        if let Some(operation_ref) = project.creation_operation_ref.as_deref() {
            if !operations.insert(operation_ref.to_owned()) {
                return Err(AppError::new(
                    "project_registry_corrupt",
                    "Duplicate Starter creation operation",
                ));
            }
        }
        let project_path = Path::new(&project.root_path);
        if paths
            .iter()
            .any(|existing| platform_path_eq(existing, project_path))
        {
            return Err(AppError::new(
                "project_registry_corrupt",
                "Duplicate registered project path",
            ));
        }
        paths.push(project_path);
        if let Some(identity) = project.root_identity_v2.as_deref() {
            if !stable_identities.insert(identity.to_owned()) {
                return Err(AppError::new(
                    "project_registry_corrupt",
                    "Duplicate registered project identity",
                ));
            }
        }
    }
    for claim in &document.starter_creation_claims {
        validate_starter_claim(claim)?;
        let final_path = Path::new(&claim.final_child_path);
        if !operations.insert(claim.operation_ref.clone())
            || paths
                .iter()
                .any(|existing| platform_path_eq(existing, final_path))
        {
            return Err(AppError::new(
                "project_creation_recovery_required",
                "Starter creation claim conflicts with another durable path or operation",
            )
            .outcome_unknown(true));
        }
        paths.push(final_path);
        if let Some(identity) = claim.owned_root_identity.as_deref() {
            if !stable_identities.insert(identity.to_owned()) {
                return Err(AppError::new(
                    "project_creation_recovery_required",
                    "Starter creation claim conflicts with a committed root identity",
                )
                .outcome_unknown(true));
            }
        }
    }
    Ok(())
}

pub(crate) fn starter_creation_request_sha256(normalized_project_name: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(b"starter-project-request\0schemaVersion=1\0normalizedProjectName=");
    digest.update(normalized_project_name.as_bytes());
    hex::encode(digest.finalize())
}

fn validate_document_integrity(document: &RegistryDocument) -> AppResult<()> {
    if document.schema_version != 3 {
        return Err(AppError::new(
            "project_registry_schema_unsupported",
            "Project registry schema is unsupported",
        ));
    }
    let mut project_ids = std::collections::HashSet::new();
    for project in &document.projects {
        bounded_id(&project.project_id, "projectId")?;
        validate_primary_identity(&project.root_identity)?;
        if let Some(identity) = project.root_identity_v2.as_deref() {
            validate_v2_identity(identity)?;
        }
        if !project_ids.insert(project.project_id.clone()) {
            return Err(AppError::new(
                "project_registry_corrupt",
                "Duplicate project id",
            ));
        }
    }
    let projection_ids = document
        .projection_initialization
        .keys()
        .cloned()
        .collect::<std::collections::HashSet<_>>();
    if projection_ids != project_ids {
        return Err(AppError::new(
            "project_registry_corrupt",
            "Projection initialization authority does not exactly match registered projects",
        ));
    }
    validate_creation_uniqueness(document)
}

fn normalized_display_name(value: Option<&str>) -> AppResult<Option<String>> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 160 || value.chars().any(char::is_control) {
        return Err(AppError::new(
            "project_display_name_invalid",
            "Project name is empty, too long, or contains control characters",
        ));
    }
    Ok(Some(value.to_owned()))
}

fn valid_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn validate_primary_identity(value: &str) -> AppResult<()> {
    if valid_hex(value, 64) || (value.starts_with("v2:") && valid_hex(&value[3..], 64)) {
        return Ok(());
    }
    Err(AppError::new(
        "project_registry_corrupt",
        "Project root identity is invalid",
    ))
}

fn validate_v2_identity(value: &str) -> AppResult<()> {
    if value.starts_with("v2:") && valid_hex(&value[3..], 64) {
        return Ok(());
    }
    Err(AppError::new(
        "project_registry_corrupt",
        "Stable project root identity is invalid",
    ))
}

pub(crate) struct RootIdentitySnapshot {
    legacy_physical_suffix: Vec<u8>,
    pub(crate) stable: Option<String>,
}

impl RootIdentitySnapshot {
    pub(crate) fn legacy_for(&self, identity_path: &Path) -> String {
        let mut digest = Sha256::new();
        digest.update(identity_path.as_os_str().as_encoded_bytes());
        digest.update(&self.legacy_physical_suffix);
        hex::encode(digest.finalize())
    }
}

pub(crate) fn root_identity_snapshot(path: &Path) -> AppResult<RootIdentitySnapshot> {
    #[cfg(not(windows))]
    let metadata =
        std::fs::metadata(path).map_err(|error| AppError::io("read project identity", error))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let mut suffix = Vec::with_capacity(16);
        suffix.extend_from_slice(&metadata.dev().to_be_bytes());
        suffix.extend_from_slice(&metadata.ino().to_be_bytes());
        let stable = if metadata.dev() == 0 && metadata.ino() == 0 {
            None
        } else {
            let mut digest = Sha256::new();
            digest.update(&suffix);
            Some(format!("v2:{}", hex::encode(digest.finalize())))
        };
        return Ok(RootIdentitySnapshot {
            legacy_physical_suffix: suffix,
            stable,
        });
    }
    #[cfg(windows)]
    {
        let components = windows_root_components(path)?;
        let (volume_serial, file_index) = components.unwrap_or((0, 0));
        let mut suffix = Vec::with_capacity(12);
        suffix.extend_from_slice(&volume_serial.to_be_bytes());
        suffix.extend_from_slice(&file_index.to_be_bytes());
        let stable = components.map(|_| {
            let mut digest = Sha256::new();
            digest.update(&suffix);
            format!("v2:{}", hex::encode(digest.finalize()))
        });
        return Ok(RootIdentitySnapshot {
            legacy_physical_suffix: suffix,
            stable,
        });
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = metadata;
        Ok(RootIdentitySnapshot {
            legacy_physical_suffix: Vec::new(),
            stable: None,
        })
    }
}

#[cfg(test)]
fn legacy_root_identity(path: &Path) -> AppResult<String> {
    Ok(root_identity_snapshot(path)?.legacy_for(path))
}

#[cfg(windows)]
fn windows_root_components(path: &Path) -> AppResult<Option<(u32, u64)>> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };

    struct HandleGuard(windows_sys::Win32::Foundation::HANDLE);
    impl Drop for HandleGuard {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Ok(None);
    }
    let handle = HandleGuard(handle);
    let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(handle.0, &mut information) } == 0 {
        return Ok(None);
    }
    if information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Ok(None);
    }
    let file_index =
        (u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow);
    if information.dwVolumeSerialNumber == 0 || file_index == 0 {
        return Ok(None);
    }
    Ok(Some((information.dwVolumeSerialNumber, file_index)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_v1_bytes() -> Vec<u8> {
        br#"{"schemaVersion":1,"selectedProjectId":null,"projects":[]}"#.to_vec()
    }

    fn unique_registry_base(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "orquesta-registry-{label}-{}",
            uuid::Uuid::new_v4()
        ))
    }

    #[test]
    fn both_missing_materializes_a_v3_primary_and_backup() {
        let base = unique_registry_base("both-missing");
        std::fs::create_dir_all(&base).expect("create base");
        let path = base.join("projects.v1.json");
        let registry = ProjectRegistry::open(path.clone()).expect("materialize registry");
        assert!(registry.list().is_empty());
        assert_eq!(
            read_json::<RegistryDocument>(&path)
                .expect("read primary")
                .expect("primary")
                .schema_version,
            3
        );
        assert_eq!(
            read_json::<RegistryDocument>(&backup_path(&path).expect("backup path"))
                .expect("read backup")
                .expect("backup")
                .schema_version,
            3
        );
        std::fs::remove_dir_all(base).expect("cleanup");
    }

    #[test]
    fn missing_primary_restores_a_valid_v1_backup_without_overwriting_it() {
        let base = unique_registry_base("missing-primary");
        std::fs::create_dir_all(&base).expect("create base");
        let path = base.join("projects.v1.json");
        let backup = backup_path(&path).expect("backup path");
        let v1 = empty_v1_bytes();
        std::fs::write(&backup, &v1).expect("write v1 backup");

        let registry = ProjectRegistry::open(path.clone()).expect("restore registry");

        assert!(registry.list().is_empty());
        assert_eq!(std::fs::read(&backup).expect("backup remains"), v1);
        assert_eq!(
            read_json::<RegistryDocument>(&path)
                .expect("read restored primary")
                .expect("restored primary")
                .schema_version,
            3
        );
        std::fs::remove_dir_all(base).expect("cleanup");
    }

    #[test]
    fn missing_primary_with_invalid_backup_fails_closed() {
        let base = unique_registry_base("invalid-backup");
        std::fs::create_dir_all(&base).expect("create base");
        let path = base.join("projects.v1.json");
        std::fs::write(backup_path(&path).expect("backup path"), b"not-json")
            .expect("write invalid backup");
        let error = ProjectRegistry::open(path).expect_err("reject invalid backup");
        assert_eq!(error.code, "project_registry_identity_uncertain");
        assert!(error.outcome_unknown);
        std::fs::remove_dir_all(base).expect("cleanup");
    }

    #[test]
    fn corrupt_primary_restores_a_valid_v1_backup_without_rotating_corruption() {
        let base = unique_registry_base("corrupt-primary");
        std::fs::create_dir_all(&base).expect("create base");
        let path = base.join("projects.v1.json");
        let backup = backup_path(&path).expect("backup path");
        let v1 = empty_v1_bytes();
        std::fs::write(&path, b"corrupt-primary").expect("write corrupt primary");
        std::fs::write(&backup, &v1).expect("write v1 backup");

        ProjectRegistry::open(path.clone()).expect("restore registry");

        assert_eq!(std::fs::read(&backup).expect("backup remains"), v1);
        assert_eq!(
            read_json::<RegistryDocument>(&path)
                .expect("read restored primary")
                .expect("restored primary")
                .schema_version,
            3
        );
        std::fs::remove_dir_all(base).expect("cleanup");
    }

    #[test]
    fn backup_restore_failpoints_preserve_at_least_one_reopenable_generation() {
        for failpoint in ["before_replace", "after_replace", "before_readback"] {
            let base = unique_registry_base(failpoint);
            std::fs::create_dir_all(&base).expect("create base");
            let path = base.join("projects.v1.json");
            let backup = backup_path(&path).expect("backup path");
            let v1 = empty_v1_bytes();
            std::fs::write(&path, b"corrupt-primary").expect("write corrupt primary");
            std::fs::write(&backup, &v1).expect("write v1 backup");
            crate::storage::set_restore_failpoint(Some(failpoint));
            let result = ProjectRegistry::open(path.clone());
            crate::storage::set_restore_failpoint(None);
            if failpoint == "after_replace" {
                result.expect("exact primary proves an after-replace response loss");
            } else {
                result.expect_err("inject restore failure");
            }

            let reopened = ProjectRegistry::open(path.clone()).expect("reopen after failure");
            assert!(reopened.list().is_empty());
            assert_eq!(std::fs::read(&backup).expect("backup remains"), v1);
            assert_eq!(
                read_json::<RegistryDocument>(&path)
                    .expect("read primary")
                    .expect("primary")
                    .schema_version,
                3
            );
            std::fs::remove_dir_all(base).expect("cleanup");
        }
    }

    #[test]
    fn backup_restore_rejects_a_valid_but_non_exact_primary_readback() {
        let base = unique_registry_base("restore-exact-mismatch");
        std::fs::create_dir_all(&base).expect("create base");
        let path = base.join("projects.v1.json");
        let backup = backup_path(&path).expect("backup path");
        let v1 = empty_v1_bytes();
        std::fs::write(&path, b"corrupt-primary").expect("write corrupt primary");
        std::fs::write(&backup, &v1).expect("write valid backup");
        set_commit_readback_failpoint(Some("exact_readback_mismatch"));
        let error = ProjectRegistry::open(path.clone()).expect_err("reject mismatching readback");
        set_commit_readback_failpoint(None);
        assert!(error.outcome_unknown);
        assert_eq!(std::fs::read(&backup).expect("backup remains"), v1);
        ProjectRegistry::open(path.clone()).expect("reopen exact restored primary");
        std::fs::remove_dir_all(base).expect("cleanup");
    }

    #[test]
    fn primary_v1_migration_has_exact_readback_and_reopenable_failpoints() {
        for failpoint in [
            "before_replace",
            "after_replace",
            "exact_readback_error",
            "exact_readback_mismatch",
        ] {
            let base = unique_registry_base(failpoint);
            std::fs::create_dir_all(&base).expect("create base");
            let path = base.join("projects.v1.json");
            std::fs::write(&path, empty_v1_bytes()).expect("write v1 primary");
            if matches!(failpoint, "before_replace" | "after_replace") {
                crate::storage::set_atomic_write_failpoint(Some(failpoint));
            } else {
                set_commit_readback_failpoint(Some(failpoint));
            }
            let result = ProjectRegistry::open(path.clone());
            crate::storage::set_atomic_write_failpoint(None);
            set_commit_readback_failpoint(None);
            if failpoint == "after_replace" {
                result.expect("exact primary proves migration after replace");
            } else {
                result.expect_err("fail closed until migration can be proven");
            }
            let reopened = ProjectRegistry::open(path.clone()).expect("retry or reopen migration");
            assert_eq!(
                read_json::<RegistryDocument>(&path)
                    .expect("read primary")
                    .expect("primary")
                    .schema_version,
                3
            );
            assert!(reopened.list().is_empty());
            std::fs::remove_dir_all(base).expect("cleanup");
        }
    }

    #[test]
    fn v2_project_records_migrate_to_ready_projection_authority() {
        let base = unique_registry_base("v2-projection-ready");
        let root = base.join("project");
        std::fs::create_dir_all(&root).expect("create project root");
        let path = base.join("projects.v1.json");
        let mut registry = ProjectRegistry::open(path.clone()).expect("open registry");
        let record = registry
            .register_read_only_named(root.to_str().expect("root utf8"), None)
            .expect("create record fixture");
        let mut legacy_record = serde_json::to_value(record.clone()).expect("serialize record");
        legacy_record
            .as_object_mut()
            .expect("record object")
            .remove("hiddenFromRecent");
        let legacy = serde_json::json!({
            "schemaVersion": 2,
            "selectedProjectId": null,
            "projects": [legacy_record],
            "starterCreationClaims": []
        });
        atomic_write_json(&path, &legacy).expect("write v2 registry fixture");

        let migrated = ProjectRegistry::open(path).expect("migrate v2 registry");
        assert_eq!(
            migrated
                .projection_initialization_state(&record.project_id)
                .expect("migrated state"),
            ProjectionInitializationState::Ready
        );
        assert!(!migrated.list()[0].hidden_from_recent);
        std::fs::remove_dir_all(base).expect("cleanup");
    }

    #[test]
    fn archived_project_keeps_identity_history_authority_and_restores_in_place() {
        let base = unique_registry_base("hidden-recent-reopen");
        let root = base.join("project");
        std::fs::create_dir_all(&root).expect("create project root");
        let history_sentinel = root.join("history-stays.txt");
        std::fs::write(&history_sentinel, b"durable history").expect("write history sentinel");
        let path = base.join("projects.v1.json");
        let mut registry = ProjectRegistry::open(path.clone()).expect("open registry");
        let record = registry
            .register_read_only_named(root.to_str().expect("root utf8"), None)
            .expect("register project");
        registry
            .mark_projection_ready(&record.project_id)
            .expect("mark projection ready");
        registry.select(&record.project_id).expect("select project");

        let visible = registry
            .hide_from_recent(&record.project_id)
            .expect("hide from recent list");
        assert!(visible.is_empty());
        assert_eq!(registry.list().len(), 1);
        assert!(registry.list()[0].hidden_from_recent);
        assert_eq!(registry.selected_project_id(), None);
        assert_eq!(
            registry
                .projection_initialization_state(&record.project_id)
                .expect("projection authority"),
            ProjectionInitializationState::Ready
        );
        assert_eq!(
            std::fs::read(&history_sentinel).expect("history remains"),
            b"durable history"
        );

        drop(registry);
        let mut reopened = ProjectRegistry::open(path).expect("reopen registry");
        assert!(reopened.visible_list().is_empty());
        assert_eq!(reopened.archived_list().len(), 1);
        assert_eq!(reopened.archived_list()[0].project_id, record.project_id);
        assert!(reopened.archived_list()[0].hidden_from_recent);
        reopened
            .restore_archived(&record.project_id)
            .expect("restore archived project");
        let restored = reopened.get(&record.project_id).expect("restored project");
        assert_eq!(restored.project_id, record.project_id);
        assert!(!restored.hidden_from_recent);
        assert!(reopened.archived_list().is_empty());
        assert_eq!(reopened.visible_list().len(), 1);
        assert_eq!(
            reopened
                .projection_initialization_state(&record.project_id)
                .expect("projection authority remains"),
            ProjectionInitializationState::Ready
        );
        assert!(history_sentinel.exists());
        drop(reopened);
        std::fs::remove_dir_all(base).expect("cleanup");
    }

    #[test]
    fn metadata_directory_is_rejected_but_its_parent_is_a_valid_project() {
        let base = unique_registry_base("metadata-directory");
        let root = base.join("project");
        let metadata = root.join(".orquesta");
        std::fs::create_dir_all(&metadata).expect("create metadata directory");
        let path = base.join("projects.v1.json");
        let mut registry = ProjectRegistry::open(path).expect("open registry");

        let error = registry
            .register_read_only_named(metadata.to_str().expect("metadata utf8"), None)
            .expect_err("metadata directory is not a project root");
        assert_eq!(error.code, "project_metadata_directory_selected");
        assert!(registry.list().is_empty());
        let parent = registry
            .register_read_only_named(root.to_str().expect("root utf8"), None)
            .expect("parent project root is accepted");
        assert_eq!(registry.visible_list(), vec![parent]);
        drop(registry);
        std::fs::remove_dir_all(base).expect("cleanup");
    }

    #[test]
    fn v3_registry_rejects_unknown_or_incomplete_projection_authority() {
        let base = unique_registry_base("v3-projection-invalid");
        std::fs::create_dir_all(&base).expect("create base");
        let path = base.join("projects.v1.json");
        let invalid = br#"{"schemaVersion":3,"selectedProjectId":null,"projects":[],"projectionInitialization":{"project-a":"unknown"},"starterCreationClaims":[]}"#;
        std::fs::write(&path, invalid).expect("write invalid primary");
        std::fs::write(backup_path(&path).expect("backup path"), invalid)
            .expect("write invalid backup");

        let error = ProjectRegistry::open(path).expect_err("reject unknown state");
        assert_eq!(error.code, "project_registry_identity_uncertain");
        std::fs::remove_dir_all(base).expect("cleanup");
    }

    #[test]
    fn claim_digest_and_rederived_final_path_are_integrity_bound() {
        let base = unique_registry_base("claim-binding");
        std::fs::create_dir_all(&base).expect("create base");
        let operation_ref = uuid::Uuid::new_v4().hyphenated().to_string();
        let display_name = "Ångström";
        let parent = canonical_path_string(&base).expect("parent path");
        let mut claim = StarterCreationClaim {
            operation_ref: operation_ref.clone(),
            request_sha256: starter_creation_request_sha256(display_name),
            display_name: display_name.to_owned(),
            parent_canonical_path: parent.clone(),
            parent_identity: format!("v2:{}", "1".repeat(64)),
            final_child_path: canonical_path_string(&base.join(display_name)).expect("final path"),
            phase: StarterCreationPhase::Planned,
            owned_root_identity: None,
            created_at_ms: 1,
            last_observed_at_ms: 1,
            recovery_reason: None,
        };
        let mut document = RegistryDocument {
            schema_version: 3,
            selected_project_id: None,
            projects: Vec::new(),
            projection_initialization: BTreeMap::new(),
            starter_creation_claims: vec![claim.clone()],
        };
        normalize_registry_document(document.clone()).expect("accept bound claim");

        claim.request_sha256 = "2".repeat(64);
        document.starter_creation_claims = vec![claim.clone()];
        assert_eq!(
            normalize_registry_document(document.clone())
                .expect_err("reject wrong digest")
                .code,
            "project_registry_corrupt"
        );

        claim.request_sha256 = starter_creation_request_sha256(display_name);
        claim.final_child_path =
            canonical_path_string(&base.join("different")).expect("wrong path");
        document.starter_creation_claims = vec![claim];
        assert_eq!(
            normalize_registry_document(document)
                .expect_err("reject wrong final path")
                .code,
            "project_registry_corrupt"
        );
        std::fs::remove_dir_all(base).expect("cleanup");
    }

    fn semantic_invalid_document(base: &Path) -> RegistryDocument {
        let operation_ref = uuid::Uuid::new_v4().hyphenated().to_string();
        let display_name = "Semantic Invalid";
        RegistryDocument {
            schema_version: 3,
            selected_project_id: None,
            projects: Vec::new(),
            projection_initialization: BTreeMap::new(),
            starter_creation_claims: vec![StarterCreationClaim {
                operation_ref,
                request_sha256: "f".repeat(64),
                display_name: display_name.to_owned(),
                parent_canonical_path: canonical_path_string(base).expect("parent path"),
                parent_identity: format!("v2:{}", "1".repeat(64)),
                final_child_path: canonical_path_string(&base.join(display_name))
                    .expect("final path"),
                phase: StarterCreationPhase::Planned,
                owned_root_identity: None,
                created_at_ms: 1,
                last_observed_at_ms: 1,
                recovery_reason: None,
            }],
        }
    }

    #[test]
    fn semantic_invalid_primary_falls_back_to_a_valid_backup() {
        let base = unique_registry_base("semantic-fallback");
        std::fs::create_dir_all(&base).expect("create base");
        let path = base.join("projects.v1.json");
        let backup = backup_path(&path).expect("backup path");
        std::fs::write(
            &path,
            serde_json::to_vec(&semantic_invalid_document(&base)).expect("encode invalid primary"),
        )
        .expect("write invalid primary");
        let v1 = empty_v1_bytes();
        std::fs::write(&backup, &v1).expect("write valid backup");

        let registry = ProjectRegistry::open(path.clone()).expect("fallback to backup");

        assert!(registry.list().is_empty());
        assert_eq!(std::fs::read(&backup).expect("backup remains"), v1);
        assert_eq!(
            read_json::<RegistryDocument>(&path)
                .expect("read restored primary")
                .expect("primary")
                .schema_version,
            3
        );
        std::fs::remove_dir_all(base).expect("cleanup");
    }

    #[test]
    fn both_semantically_invalid_generations_fail_closed() {
        let base = unique_registry_base("both-semantic-invalid");
        std::fs::create_dir_all(&base).expect("create base");
        let path = base.join("projects.v1.json");
        let invalid =
            serde_json::to_vec(&semantic_invalid_document(&base)).expect("encode invalid");
        std::fs::write(&path, &invalid).expect("write invalid primary");
        std::fs::write(backup_path(&path).expect("backup path"), &invalid)
            .expect("write invalid backup");

        let error = ProjectRegistry::open(path).expect_err("reject both invalid generations");
        assert_eq!(error.code, "project_registry_identity_uncertain");
        assert!(error.outcome_unknown);
        std::fs::remove_dir_all(base).expect("cleanup");
    }

    #[test]
    fn newer_primary_schema_is_not_downgraded_through_an_older_backup() {
        let base = unique_registry_base("newer-primary");
        std::fs::create_dir_all(&base).expect("create base");
        let path = base.join("projects.v1.json");
        std::fs::write(
            &path,
            br#"{"schemaVersion":4,"selectedProjectId":null,"projects":[],"projectionInitialization":{},"starterCreationClaims":[]}"#,
        )
        .expect("write newer primary");
        std::fs::write(backup_path(&path).expect("backup path"), empty_v1_bytes())
            .expect("write old backup");

        let error = ProjectRegistry::open(path).expect_err("reject downgrade");
        assert_eq!(error.code, "project_registry_schema_unsupported");
        std::fs::remove_dir_all(base).expect("cleanup");
    }

    fn root_owned_commit_fixture(
        label: &str,
    ) -> (
        PathBuf,
        PathBuf,
        ProjectRegistry,
        StarterCreationClaim,
        String,
        String,
        String,
    ) {
        let base = unique_registry_base(label);
        let parent = base.join("projects");
        let root = parent.join("Commit Matrix");
        std::fs::create_dir_all(&root).expect("create owned root");
        let registry_path = base.join("state").join("projects.v1.json");
        let mut registry = ProjectRegistry::open(registry_path.clone()).expect("open registry");
        let parent_canonical =
            canonical_directory(parent.to_str().expect("parent utf8")).expect("canonical parent");
        let root_canonical =
            canonical_directory(root.to_str().expect("root utf8")).expect("canonical root");
        let parent_snapshot = root_identity_snapshot(&parent_canonical).expect("parent identity");
        let root_snapshot = root_identity_snapshot(&root_canonical).expect("root identity");
        let stable = root_snapshot.stable.clone().expect("stable root identity");
        let operation_ref = uuid::Uuid::new_v4().hyphenated().to_string();
        let claim = StarterCreationClaim {
            operation_ref,
            request_sha256: starter_creation_request_sha256("Commit Matrix"),
            display_name: "Commit Matrix".to_owned(),
            parent_canonical_path: canonical_path_string(&parent_canonical).expect("parent path"),
            parent_identity: parent_snapshot.stable.expect("stable parent identity"),
            final_child_path: canonical_path_string(&root_canonical).expect("root path"),
            phase: StarterCreationPhase::RootOwned,
            owned_root_identity: Some(stable.clone()),
            created_at_ms: 1,
            last_observed_at_ms: 1,
            recovery_reason: None,
        };
        registry
            .persist_starter_claim(claim.clone())
            .expect("persist RootOwned claim");
        let root_path = canonical_path_string(&root_canonical).expect("root path");
        let legacy = root_snapshot.legacy_for(&root_canonical);
        (
            base,
            registry_path,
            registry,
            claim,
            root_path,
            legacy,
            stable,
        )
    }

    #[test]
    fn commit_before_replace_is_a_definitive_non_commit() {
        let (base, _path, mut registry, claim, root_path, legacy, stable) =
            root_owned_commit_fixture("commit-before-replace");
        crate::storage::set_atomic_write_failpoint(Some("before_replace"));
        let error = registry
            .commit_starter_project(&claim, root_path, legacy, stable)
            .expect_err("fail before replacement");
        crate::storage::set_atomic_write_failpoint(None);
        assert!(!error.outcome_unknown);
        assert!(registry.list().is_empty());
        assert_eq!(registry.starter_claims(), vec![claim]);
        drop(registry);
        std::fs::remove_dir_all(base).expect("cleanup");
    }

    #[test]
    fn starter_records_require_a_stable_owned_root_identity() {
        let (base, _path, mut registry, claim, root_path, legacy, stable) =
            root_owned_commit_fixture("record-stable-required");
        let mut record = registry
            .commit_starter_project(&claim, root_path, legacy, stable)
            .expect("commit fixture");
        record.root_identity_v2 = None;
        let error = validate_creation_record_fields(&record)
            .expect_err("reject committed Starter without stable identity");
        assert_eq!(error.code, "project_registry_corrupt");
        std::fs::remove_dir_all(base).expect("cleanup");
    }

    #[test]
    fn claim_recovery_reason_is_bound_to_the_state_machine_phase() {
        let (base, _path, _registry, mut claim, _root_path, _legacy, _stable) =
            root_owned_commit_fixture("claim-recovery-reason");
        claim.recovery_reason = Some("unexpected_reason".to_owned());
        assert!(validate_starter_claim(&claim).is_err());
        claim.phase = StarterCreationPhase::RecoveryRequired;
        claim.recovery_reason = None;
        assert!(validate_starter_claim(&claim).is_err());
        claim.recovery_reason = Some("owned_root_identity_mismatch".to_owned());
        validate_starter_claim(&claim).expect("bounded recovery code");
        claim.recovery_reason = Some("x".repeat(129));
        assert!(validate_starter_claim(&claim).is_err());
        std::fs::remove_dir_all(base).expect("cleanup");
    }

    #[test]
    fn stored_starter_authority_rejects_uppercase_operations_and_noncanonical_paths() {
        let (base, _path, mut registry, claim, root_path, legacy, stable) =
            root_owned_commit_fixture("stored-canonical-authority");
        let record = registry
            .commit_starter_project(&claim, root_path, legacy, stable)
            .expect("commit fixture");

        let mut uppercase_record = record.clone();
        uppercase_record.creation_operation_ref = uppercase_record
            .creation_operation_ref
            .map(|value| value.to_ascii_uppercase());
        assert!(validate_creation_record_fields(&uppercase_record).is_err());
        let mut uppercase_claim = claim.clone();
        uppercase_claim.operation_ref = uppercase_claim.operation_ref.to_ascii_uppercase();
        assert!(validate_starter_claim(&uppercase_claim).is_err());

        let root = Path::new(&record.root_path);
        let mut noncanonical_record = record.clone();
        noncanonical_record.root_path = format!(
            r"C:\orquesta-invalid\..\{}",
            root.file_name().expect("root name").to_string_lossy()
        );
        assert!(validate_creation_record_fields(&noncanonical_record).is_err());
        let mut noncanonical_claim = claim;
        noncanonical_claim.parent_canonical_path = r"C:\orquesta-invalid\child\..".to_owned();
        noncanonical_claim.final_child_path = format!(
            r"{}\{}",
            noncanonical_claim.parent_canonical_path, noncanonical_claim.display_name
        );
        assert!(validate_starter_claim(&noncanonical_claim).is_err());
        std::fs::remove_dir_all(base).expect("cleanup");
    }

    #[test]
    fn active_registry_mutations_reconcile_exact_primary_after_response_loss() {
        let base = unique_registry_base("generic-response-loss");
        let first_root = base.join("first");
        let second_root = base.join("second");
        std::fs::create_dir_all(&first_root).expect("create first root");
        std::fs::create_dir_all(&second_root).expect("create second root");
        let path = base.join("projects.v1.json");
        let mut registry = ProjectRegistry::open(path.clone()).expect("open registry");
        let first = registry
            .register_read_only_named(first_root.to_str().expect("first utf8"), None)
            .expect("register first");

        crate::storage::set_atomic_write_failpoint(Some("after_replace"));
        let second = registry
            .register_read_only_named(second_root.to_str().expect("second utf8"), None)
            .expect("exact primary proves registration");
        crate::storage::set_atomic_write_failpoint(None);
        let replay = registry
            .register_read_only_named(second_root.to_str().expect("second utf8"), None)
            .expect("same path replays same registration");
        assert_eq!(replay.project_id, second.project_id);

        set_commit_readback_failpoint(Some("readback_error"));
        registry
            .select(&second.project_id)
            .expect("fresh open proves selection");
        set_commit_readback_failpoint(None);
        crate::storage::set_atomic_write_failpoint(Some("after_replace"));
        registry
            .set_last_work_agent(&second.project_id, "orchestrator")
            .expect("exact primary proves agent update");
        crate::storage::set_atomic_write_failpoint(None);
        let reopened = ProjectRegistry::open(path).expect("reopen registry");
        assert_eq!(reopened.list().len(), 2);
        assert_eq!(reopened.list()[0].project_id, first.project_id);
        assert_eq!(
            reopened.selected_project_id().as_deref(),
            Some(second.project_id.as_str())
        );
        assert_eq!(
            reopened
                .get(&second.project_id)
                .expect("second project")
                .last_work_agent_id
                .as_deref(),
            Some("orchestrator")
        );
        std::fs::remove_dir_all(base).expect("cleanup");
    }

    #[test]
    fn generic_registry_before_replace_is_definitive_and_keeps_memory_exact() {
        let base = unique_registry_base("generic-before-replace");
        let root = base.join("project");
        std::fs::create_dir_all(&root).expect("create root");
        let path = base.join("projects.v1.json");
        let mut registry = ProjectRegistry::open(path.clone()).expect("open registry");
        crate::storage::set_atomic_write_failpoint(Some("before_replace"));
        let error = registry
            .register_read_only_named(root.to_str().expect("root utf8"), None)
            .expect_err("fail before replacement");
        crate::storage::set_atomic_write_failpoint(None);
        assert!(!error.outcome_unknown);
        assert!(registry.list().is_empty());
        assert!(ProjectRegistry::open(path)
            .expect("reopen old authority")
            .list()
            .is_empty());
        std::fs::remove_dir_all(base).expect("cleanup");
    }

    #[test]
    fn commit_after_replace_response_loss_is_proven_by_exact_primary_readback() {
        let (base, _path, mut registry, claim, root_path, legacy, stable) =
            root_owned_commit_fixture("commit-after-replace");
        crate::storage::set_atomic_write_failpoint(Some("after_replace"));
        let record = registry
            .commit_starter_project(&claim, root_path, legacy, stable)
            .expect("reconcile committed primary");
        crate::storage::set_atomic_write_failpoint(None);
        assert_eq!(
            record.creation_operation_ref.as_deref(),
            Some(claim.operation_ref.as_str())
        );
        assert!(registry.starter_claims().is_empty());
        drop(registry);
        std::fs::remove_dir_all(base).expect("cleanup");
    }

    #[test]
    fn commit_readback_failure_is_recovered_by_a_fresh_exact_open() {
        let (base, path, mut registry, claim, root_path, legacy, stable) =
            root_owned_commit_fixture("commit-readback-error");
        set_commit_readback_failpoint(Some("readback_error"));
        let record = registry
            .commit_starter_project(&claim, root_path, legacy, stable)
            .expect("fresh open proves exact commit");
        set_commit_readback_failpoint(None);
        assert_eq!(
            record.creation_operation_ref.as_deref(),
            Some(claim.operation_ref.as_str())
        );
        assert_eq!(registry.list().len(), 1);
        drop(registry);
        let reopened = ProjectRegistry::open(path).expect("reopen exact committed primary");
        assert_eq!(reopened.list().len(), 1);
        assert!(reopened.starter_claims().is_empty());
        drop(reopened);
        std::fs::remove_dir_all(base).expect("cleanup");
    }

    #[test]
    fn failed_fresh_authority_refresh_poisons_stale_creation_reads() {
        let (base, path, mut registry, claim, root_path, legacy, stable) =
            root_owned_commit_fixture("commit-refresh-poison");
        crate::storage::set_atomic_write_failpoint(Some("after_replace"));
        set_commit_readback_failpoint(Some("fresh_open_error"));
        let error = registry
            .commit_starter_project(&claim, root_path, legacy, stable)
            .expect_err("cannot refresh authority");
        crate::storage::set_atomic_write_failpoint(None);
        set_commit_readback_failpoint(None);
        assert!(error.outcome_unknown);
        let read_error = registry
            .committed_creation(&claim.operation_ref, &claim.request_sha256)
            .expect_err("poisoned memory cannot answer creation authority");
        assert_eq!(read_error.code, "project_registry_reopen_required");
        let reopened = ProjectRegistry::open(path).expect("reopen committed primary");
        assert_eq!(reopened.list().len(), 1);
        assert!(reopened.starter_claims().is_empty());
        std::fs::remove_dir_all(base).expect("cleanup");
    }

    #[test]
    fn mismatching_commit_readback_never_replaces_memory_with_an_unrelated_document() {
        let (base, _path, mut registry, claim, root_path, legacy, stable) =
            root_owned_commit_fixture("commit-readback-mismatch");
        set_commit_readback_failpoint(Some("readback_mismatch"));
        let error = registry
            .commit_starter_project(&claim, root_path, legacy, stable)
            .expect_err("reject mismatching readback");
        set_commit_readback_failpoint(None);
        assert!(!error.outcome_unknown);
        assert!(registry.list().is_empty());
        assert_eq!(registry.starter_claims(), vec![claim]);
        drop(registry);
        std::fs::remove_dir_all(base).expect("cleanup");
    }

    #[test]
    fn retire_claim_requires_the_entire_intended_document_on_readback() {
        let (base, _path, mut registry, claim, _root_path, _legacy, _stable) =
            root_owned_commit_fixture("retire-readback-mismatch");
        let mut planned = claim.clone();
        planned.operation_ref = uuid::Uuid::new_v4().hyphenated().to_string();
        planned.request_sha256 = starter_creation_request_sha256("Other Claim");
        planned.display_name = "Other Claim".to_owned();
        planned.final_child_path = Path::new(&planned.parent_canonical_path)
            .join("Other Claim")
            .to_string_lossy()
            .into_owned();
        planned.phase = StarterCreationPhase::Planned;
        planned.owned_root_identity = None;
        registry
            .persist_starter_claim(planned.clone())
            .expect("persist second claim");
        let mut intended = registry.document.clone();
        intended
            .starter_creation_claims
            .retain(|candidate| candidate.operation_ref != planned.operation_ref);
        set_commit_readback_failpoint(Some("readback_mismatch"));
        registry
            .retire_planned_claim(&planned.operation_ref)
            .expect("fresh exact open recovers from unrelated readback");
        set_commit_readback_failpoint(None);
        assert_eq!(registry.document, intended);
        assert_eq!(registry.starter_claims().len(), 1);
        drop(registry);
        std::fs::remove_dir_all(base).expect("cleanup");
    }

    #[test]
    fn explicit_registration_preserves_a_legacy_project_id_after_an_offline_rename() {
        let base = std::env::temp_dir().join(format!("orquesta-registry-{}", uuid::Uuid::new_v4()));
        let old_root = base.join("before");
        let new_root = base.join("after");
        std::fs::create_dir_all(&old_root).expect("create old project");
        let registry_path = base.join("projects.v1.json");
        let mut registry = ProjectRegistry::open(registry_path.clone()).expect("open registry");
        let original = registry
            .register_read_only_named(old_root.to_str().expect("utf8 path"), None)
            .expect("register project");
        let canonical_old = canonical_directory(old_root.to_str().expect("utf8 path"))
            .expect("canonical old project");
        registry.document.projects[0].root_identity =
            legacy_root_identity(&canonical_old).expect("legacy identity");
        registry.document.projects[0].root_identity_v2 = None;
        let persisted = registry.document.clone();
        atomic_write_json(&registry_path, &persisted).expect("persist legacy registry fixture");
        std::fs::rename(&old_root, &new_root).expect("rename while desktop is stopped");

        let mut reopened = ProjectRegistry::open(registry_path).expect("reopen legacy registry");
        let recovered = reopened
            .register_read_only_named(new_root.to_str().expect("utf8 path"), None)
            .expect("reselect renamed project");

        assert_eq!(recovered.project_id, original.project_id);
        assert_eq!(reopened.list().len(), 1);
        assert!(!recovered.root_identity.starts_with("v2:"));
        assert!(recovered
            .root_identity_v2
            .as_deref()
            .is_some_and(|value| value.starts_with("v2:")));
        std::fs::remove_dir_all(base).expect("cleanup");
    }

    #[test]
    fn registration_keeps_the_rollback_identity_primary() {
        let base = std::env::temp_dir().join(format!("orquesta-registry-{}", uuid::Uuid::new_v4()));
        let root = base.join("project");
        std::fs::create_dir_all(&root).expect("create project");
        let mut registry =
            ProjectRegistry::open(base.join("projects.v1.json")).expect("open registry");
        let record = registry
            .register_read_only_named(root.to_str().expect("utf8 path"), None)
            .expect("register project");
        assert!(valid_hex(&record.root_identity, 64));
        assert!(record
            .root_identity_v2
            .as_deref()
            .is_some_and(|value| value.starts_with("v2:")));
        std::fs::remove_dir_all(base).expect("cleanup");
    }

    #[test]
    fn named_registration_uses_the_explicit_name_only_for_a_new_project() {
        let base = std::env::temp_dir().join(format!("orquesta-registry-{}", uuid::Uuid::new_v4()));
        let root = base.join("folder-name");
        std::fs::create_dir_all(&root).expect("create project");
        let mut registry =
            ProjectRegistry::open(base.join("projects.v1.json")).expect("open registry");

        let created = registry
            .register_read_only_named(
                root.to_str().expect("utf8 path"),
                Some("  顧客管理プロジェクト  "),
            )
            .expect("register named project");
        assert_eq!(created.display_name, "顧客管理プロジェクト");

        let reopened = registry
            .register_read_only_named(root.to_str().expect("utf8 path"), Some("別の名前"))
            .expect("reopen existing project");
        assert_eq!(reopened.project_id, created.project_id);
        assert_eq!(reopened.display_name, "顧客管理プロジェクト");
        assert_eq!(registry.list().len(), 1);
        std::fs::remove_dir_all(base).expect("cleanup");
    }

    #[test]
    fn named_registration_rejects_an_invalid_name_without_persisting() {
        let base = std::env::temp_dir().join(format!("orquesta-registry-{}", uuid::Uuid::new_v4()));
        let root = base.join("project");
        std::fs::create_dir_all(&root).expect("create project");
        let registry_path = base.join("projects.v1.json");
        let mut registry = ProjectRegistry::open(registry_path.clone()).expect("open registry");
        let before = std::fs::read(&registry_path).expect("read before");

        let error = registry
            .register_read_only_named(root.to_str().expect("utf8 path"), Some("bad\nname"))
            .expect_err("reject control character");
        assert_eq!(error.code, "project_display_name_invalid");
        assert_eq!(std::fs::read(&registry_path).expect("read after"), before);
        assert!(registry.list().is_empty());
        std::fs::remove_dir_all(base).expect("cleanup");
    }

    #[test]
    fn repairs_the_problematic_v2_primary_without_changing_project_id() {
        let base = std::env::temp_dir().join(format!("orquesta-registry-{}", uuid::Uuid::new_v4()));
        let root = base.join("project");
        std::fs::create_dir_all(&root).expect("create project");
        let registry_path = base.join("projects.v1.json");
        let mut registry = ProjectRegistry::open(registry_path.clone()).expect("open registry");
        let original = registry
            .register_read_only_named(root.to_str().expect("utf8 path"), None)
            .expect("register project");
        registry.document.projects[0].root_identity =
            original.root_identity_v2.clone().expect("stable identity");
        registry.document.projects[0].root_identity_v2 = None;
        let persisted = registry.document.clone();
        atomic_write_json(&registry_path, &persisted)
            .expect("persist problematic registry fixture");

        let reopened = ProjectRegistry::open(registry_path).expect("repair registry");
        let repaired = reopened.get(&original.project_id).expect("same project");
        assert_eq!(repaired.project_id, original.project_id);
        assert!(valid_hex(&repaired.root_identity, 64));
        assert_eq!(repaired.root_identity_v2, original.root_identity_v2);
        std::fs::remove_dir_all(base).expect("cleanup");
    }

    #[test]
    fn repairs_the_problematic_v2_primary_after_an_offline_rename() {
        let base = std::env::temp_dir().join(format!("orquesta-registry-{}", uuid::Uuid::new_v4()));
        let old_root = base.join("before");
        let new_root = base.join("after");
        std::fs::create_dir_all(&old_root).expect("create project");
        let registry_path = base.join("projects.v1.json");
        let mut registry = ProjectRegistry::open(registry_path.clone()).expect("open registry");
        let original = registry
            .register_read_only_named(old_root.to_str().expect("utf8 path"), None)
            .expect("register project");
        registry.document.projects[0].root_identity =
            original.root_identity_v2.clone().expect("stable identity");
        registry.document.projects[0].root_identity_v2 = None;
        let persisted = registry.document.clone();
        atomic_write_json(&registry_path, &persisted)
            .expect("persist problematic registry fixture");
        std::fs::rename(&old_root, &new_root).expect("rename offline");

        let mut reopened = ProjectRegistry::open(registry_path).expect("open unresolved registry");
        let repaired = reopened
            .register_read_only_named(new_root.to_str().expect("utf8 path"), None)
            .expect("repair on reselect");
        assert_eq!(repaired.project_id, original.project_id);
        assert!(valid_hex(&repaired.root_identity, 64));
        assert_eq!(repaired.root_identity_v2, original.root_identity_v2);
        std::fs::remove_dir_all(base).expect("cleanup");
    }

    #[test]
    fn last_work_agent_hint_is_atomic_optional_and_reopens() {
        let base = std::env::temp_dir().join(format!("orquesta-registry-{}", uuid::Uuid::new_v4()));
        let root = base.join("project");
        std::fs::create_dir_all(&root).expect("create project");
        let registry_path = base.join("projects.v1.json");
        let mut registry = ProjectRegistry::open(registry_path.clone()).expect("open registry");
        let project = registry
            .register_read_only_named(root.to_str().expect("utf8 path"), None)
            .expect("register project");
        assert_eq!(project.last_work_agent_id, None);

        let updated = registry
            .set_last_work_agent(&project.project_id, "qa")
            .expect("persist last WORK agent");
        assert_eq!(updated.last_work_agent_id.as_deref(), Some("qa"));
        drop(registry);

        let reopened = ProjectRegistry::open(registry_path).expect("reopen registry");
        assert_eq!(
            reopened
                .get(&project.project_id)
                .expect("reopened project")
                .last_work_agent_id
                .as_deref(),
            Some("qa")
        );
        std::fs::remove_dir_all(base).expect("cleanup");
    }

    #[test]
    fn rejects_malformed_stable_identity() {
        let base = std::env::temp_dir().join(format!("orquesta-registry-{}", uuid::Uuid::new_v4()));
        let registry_path = base.join("projects.v1.json");
        std::fs::create_dir_all(&base).expect("create base");
        std::fs::write(&registry_path, r#"{"schemaVersion":1,"selectedProjectId":null,"projects":[{"projectId":"project-1","displayName":"Project","rootPath":"missing","rootIdentity":"v2:not-a-hash","createdAtMs":1,"lastOpenedAtMs":1}]}"#).expect("write registry");
        let error = ProjectRegistry::open(registry_path).expect_err("reject invalid identity");
        assert_eq!(error.code, "project_registry_identity_uncertain");
        std::fs::remove_dir_all(base).expect("cleanup");
    }

    #[test]
    fn checked_renderer_snapshot_never_exposes_poisoned_in_memory_authority() {
        let base = std::env::temp_dir().join(format!("orquesta-registry-{}", uuid::Uuid::new_v4()));
        let mut registry =
            ProjectRegistry::open(base.join("projects.v1.json")).expect("open registry");
        registry.mutation_poisoned = true;

        let error = registry
            .checked_snapshot()
            .expect_err("poisoned authority must fail closed");
        assert_eq!(error.code, "project_registry_reopen_required");
        std::fs::remove_dir_all(base).expect("cleanup");
    }

    #[test]
    fn checked_renderer_snapshot_projects_a_durable_recovery_summary() {
        let (base, _path, mut registry, claim, _root_path, _legacy, _stable) =
            root_owned_commit_fixture("recovery-summary");
        registry
            .mark_starter_recovery_required(claim.clone(), "owned_root_identity_mismatch")
            .expect("persist recovery claim");

        let snapshot = registry
            .checked_snapshot()
            .expect("checked renderer snapshot");
        assert_eq!(
            snapshot.starter_creation_recoveries,
            vec![StarterRecoverySummary {
                operation_ref: claim.operation_ref,
                display_name: claim.display_name,
                final_child_path: claim.final_child_path,
                reason: "owned_root_identity_mismatch".to_owned(),
            }]
        );
        std::fs::remove_dir_all(base).expect("cleanup");
    }
}
