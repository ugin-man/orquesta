import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import executionKernel from '@orquesta/execution-kernel';
import { validateContract } from '@orquesta/contracts';
import { INSPECTION_TEMPLATE_DEFINITIONS, type
  AgentUiModel,
  AgentUiStatus,
  AttentionUiItem,
  EvidenceLevel,
  FailureOccurrenceUi,
  FailureUiModel,
  FailureUiResolution,
  FailureUiSeverity,
  InspectionRunStatus,
  InspectionRunUiModel,
  InspectionTemplateUiModel,
  OrganizationUiSnapshot,
  OrquestaUiSnapshot,
  ProjectParticipantUiModel,
  ProjectStructureIssueUi,
  ProjectStructureLifecycle,
  ProjectStructureSourceUi,
  ProjectStructureUiSnapshot,
  ProjectPhaseUiModel,
  RuntimeUiEvent,
  TaskUiModel,
  TaskUiState
} from '../contracts/orquesta-ui';
import { parseInspectionState } from './inspection-run-store';
import { portableBasename, portableResolve } from '../shared/portable-path';
import { LUCA_AGENT_ID, LUCA_DISPLAY_NAME, LUCA_ROLE_LABEL, LUCA_ROLE_SUMMARY } from '../contracts/luca';
import { PROJECT_STORAGE, projectStoragePath } from './project-storage-layout';
import { readRuntimeBindingEvidence } from './runtime-binding-store';
import { SessionBindingStore } from './session-binding-store';
import { PlacementTaskPort } from './placement-task-port';

type JsonObject = Record<string, unknown>;

export interface RepositoryDocuments {
  agents: unknown;
  tasks: unknown;
  roles?: unknown;
  organization?: unknown;
  formations?: unknown;
  sessions?: unknown;
  runtimeBinding?: unknown;
  questions?: unknown;
  userTasks?: unknown;
  userActions?: unknown;
  dashboardActions?: unknown;
  incidents?: unknown;
  incidentCandidates?: unknown;
  incidentClusters?: unknown;
  inspectionRuns?: unknown;
  structureInventory?: unknown;
  structureAudit?: unknown;
  initialContextView?: unknown;
  migrationPlan?: unknown;
  migrationResult?: unknown;
  events?: unknown[];
}

export interface SnapshotProjectionInput {
  rootPath: string;
  projectId?: string;
  documents: RepositoryDocuments;
  now?: Date;
}

const MAX_JSON_BYTES = 16 * 1024 * 1024;
const FRESH_RUNTIME_MS = 10 * 60 * 1000;
const TERMINAL_TASK_STATES = new Set(['accepted', 'retired', 'superseded', 'cancelled']);
const REVIEW_TASK_STATES = new Set(['completed', 'needs_orchestrator_review', 'needs_revision', 'changes_requested', 'report_ready', 'needs_review']);
const FALLBACK_CURRENT_TASK_STATES = new Set([
  'queued',
  'assigned',
  'dispatch_accepted',
  'turn_started',
  'in_progress',
  'active',
  'working',
  'blocked',
  'approval_wait'
]);
const PROJECT_STRUCTURE_ITEM_LIMIT = 64;
const PROJECT_STRUCTURE_CONTEXT_LIMIT = 32;
const PROJECT_STRUCTURE_READING_LIMIT = 64;
const PROJECT_STRUCTURE_TERMINAL_TASK_STATES = new Set([
  'accepted',
  'retired',
  'superseded',
  'cancelled',
  'completed',
  'failed'
]);

function object(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

function rows(document: unknown, key: string, required = false): JsonObject[] {
  const value = object(document)?.[key];
  if (!Array.isArray(value)) {
    if (required) throw new Error(`${key} must be an array`);
    return [];
  }
  return value.flatMap((item) => object(item) ?? []);
}

function string(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap((item) => string(item) ?? []) : [];
}

function integer(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isInteger(value) ? value : fallback;
}

function stringList(value: unknown): string[] {
  const single = string(value);
  return single ? [single] : stringArray(value);
}

function structureLifecycle(value: unknown): ProjectStructureLifecycle {
  const lifecycle = string(value);
  return lifecycle && ['current', 'superseded', 'archived', 'quarantined', 'delete_candidate'].includes(lifecycle)
    ? lifecycle as ProjectStructureLifecycle
    : 'unknown';
}

function structureSource(row: JsonObject): ProjectStructureSourceUi | null {
  const sourceRef = string(row.source_ref);
  if (!sourceRef) return null;
  return {
    sourceRef,
    componentId: string(row.component_id),
    lifecycle: structureLifecycle(row.lifecycle),
    authority: string(row.authority) ?? 'unknown',
    readPolicy: string(row.read_policy) ?? 'unknown'
  };
}

function projectStructure(documents: RepositoryDocuments): ProjectStructureUiSnapshot {
  const inventory = object(documents.structureInventory);
  const inventoryFiles = rows(documents.structureInventory, 'files');
  const audit = object(documents.structureAudit);
  const auditSummary = object(audit?.summary);
  const rawIssues = rows(documents.structureAudit, 'issues');
  const issues = rawIssues.slice(0, PROJECT_STRUCTURE_ITEM_LIMIT).map((issue): ProjectStructureIssueUi => {
    const rawSeverity = string(issue.severity);
    const severity = rawSeverity && ['error', 'warning', 'suggestion'].includes(rawSeverity)
      ? rawSeverity as ProjectStructureIssueUi['severity']
      : 'unknown';
    return {
      severity,
      code: string(issue.code) ?? 'unknown_issue',
      message: string(issue.message) ?? 'Structure issue details are unavailable.',
      sourceRefs: stringArray(issue.source_refs).slice(0, PROJECT_STRUCTURE_ITEM_LIMIT)
    };
  });
  const lifecycleCounts = inventoryFiles.reduce<ProjectStructureUiSnapshot['lifecycleCounts']>((counts, file) => {
    const lifecycle = structureLifecycle(file.lifecycle);
    if (lifecycle === 'current') counts.current += 1;
    else if (lifecycle === 'superseded') counts.superseded += 1;
    else if (lifecycle === 'archived') counts.archived += 1;
    else if (lifecycle === 'quarantined') counts.quarantined += 1;
    else if (lifecycle === 'delete_candidate') counts.deleteCandidate += 1;
    return counts;
  }, { current: 0, superseded: 0, archived: 0, quarantined: 0, deleteCandidate: 0 });
  const canonical = inventoryFiles.filter((file) => structureLifecycle(file.lifecycle) === 'current' && string(file.authority) === 'canonical');
  const retired = inventoryFiles.filter((file) => ['superseded', 'archived', 'quarantined', 'delete_candidate'].includes(structureLifecycle(file.lifecycle)));
  const issueCounts = {
    error: integer(auditSummary?.error),
    warning: integer(auditSummary?.warning),
    suggestion: integer(auditSummary?.suggestion)
  };
  const contexts = rows(documents.tasks, 'tasks')
    .flatMap((task) => {
      const requiredReading = stringArray(task.required_reading).slice(0, PROJECT_STRUCTURE_READING_LIMIT);
      const taskId = string(task.task_id);
      if (!taskId || !requiredReading.length) return [];
      const taskStatus = string(task.state) ?? string(task.status) ?? 'unknown';
      return [{
        taskId,
        taskTitle: string(task.title) ?? taskId,
        ownerAgentId: string(task.owner_agent_id),
        taskState: taskStatus,
        active: !PROJECT_STRUCTURE_TERMINAL_TASK_STATES.has(taskStatus),
        requiredReading,
        updatedAt: dateValue(task.updated_at)
      }];
    })
    .sort((left, right) => Number(right.active) - Number(left.active) || right.updatedAt - left.updatedAt)
    .slice(0, PROJECT_STRUCTURE_CONTEXT_LIMIT)
    .map(({ updatedAt: _updatedAt, ...context }) => context);
  const contextView = object(documents.initialContextView);
  const contextSources = object(contextView?.sources);
  const plan = object(documents.migrationPlan);
  const result = object(documents.migrationResult);
  const planOperations = rows(documents.migrationPlan, 'operations');
  const resultOperations = rows(documents.migrationResult, 'operations');
  const verification = object(result?.verification);
  const resultRollback = object(result?.rollback);
  const rollbackOperations = rows(resultRollback, 'reverse_operations');
  const applied = string(result?.status) === 'applied';
  const verificationWarning = verification?.runtime_ephemeral_warning === true
    || integer(object(verification?.remaining_audit_summary)?.error) > 0
    || integer(object(verification?.remaining_audit_summary)?.warning) > 0;
  const migration = plan || result ? {
    planId: string(result?.plan_id) ?? string(plan?.plan_id),
    resultId: string(result?.result_id),
    status: string(result?.status) ?? string(plan?.status) ?? 'unknown',
    operationCount: resultOperations.length || planOperations.length,
    destructiveOperationCount: (resultOperations.length ? resultOperations : planOperations).filter((operation) => operation.destructive === true || string(operation.action) === 'delete').length,
    approvalDecision: string(object(result?.approval)?.decision) ?? (object(plan?.approval)?.applied === true ? 'accepted' : null),
    appliedAt: string(result?.applied_at),
    verificationStatus: applied ? (verificationWarning ? 'warning' as const : 'passed' as const) : 'not_run' as const,
    rollbackStepCount: rollbackOperations.length || rows(object(plan?.rollback), 'steps').length
  } : null;
  const available = Boolean(inventory);
  const status = !available
    ? 'unavailable' as const
    : audit?.blocked === true || issueCounts.error > 0
      ? 'blocked' as const
      : issueCounts.warning > 0
        ? 'attention' as const
        : 'healthy' as const;
  return {
    available,
    status,
    generatedAt: string(inventory?.generated_at) ?? string(audit?.generated_at),
    indexedFileCount: integer(object(inventory?.stats)?.indexed_files, inventoryFiles.length),
    canonicalSourceCount: canonical.length,
    lifecycleCounts,
    issueCounts,
    canonicalSources: canonical.slice(0, PROJECT_STRUCTURE_ITEM_LIMIT).flatMap((file) => structureSource(file) ?? []),
    retiredSources: retired.slice(0, PROJECT_STRUCTURE_ITEM_LIMIT).flatMap((file) => structureSource(file) ?? []),
    issues,
    specialistContexts: contexts,
    contextOverview: {
      viewId: string(contextView?.view_id),
      candidateSourceCount: integer(contextSources?.candidate_count),
      excludedSourceCount: integer(contextSources?.excluded_count),
      warnings: stringArray(contextView?.warnings).slice(0, PROJECT_STRUCTURE_ITEM_LIMIT)
    },
    migration,
    limitation: available ? null : 'Project structure inventory is not available for this repository.'
  };
}

function groupRows(items: JsonObject[], keyOf: (item: JsonObject) => string): Map<string, JsonObject[]> {
  const grouped = new Map<string, JsonObject[]>();
  for (const item of items) {
    const key = keyOf(item);
    grouped.set(key, [...(grouped.get(key) ?? []), item]);
  }
  return grouped;
}

function dateValue(value: unknown): number {
  const parsed = string(value) ? Date.parse(String(value)) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function newestTimestamp(values: unknown[]): string | null {
  const newest = values.reduce<{ raw: string | null; time: number }>((current, value) => {
    const raw = string(value);
    const time = dateValue(raw);
    return time > current.time ? { raw, time } : current;
  }, { raw: null, time: 0 });
  return newest.raw;
}

function stableProjectId(rootPath: string): string {
  const normalized = portableResolve(rootPath).replaceAll('\\', '/').toLowerCase();
  return `repo-${createHash('sha256').update(normalized).digest('hex').slice(0, 16)}`;
}

function roleIcon(role: string): string {
  const normalized = role.toLowerCase();
  if (normalized.includes('orchestr')) return 'network';
  if (normalized.includes('implement') || normalized.includes('code')) return 'code';
  if (normalized.includes('review') || normalized.includes('protocol') || normalized.includes('qa')) return 'shield';
  if (normalized.includes('vision') || normalized.includes('design')) return 'pen';
  if (normalized.includes('error') || normalized.includes('test')) return 'flask';
  if (normalized.includes('dashboard')) return 'chart';
  if (normalized.includes('research')) return 'search';
  if (normalized.includes('doc')) return 'file';
  if (normalized.includes('admin') || normalized.includes('bootstrap')) return 'database';
  return 'scan';
}

function taskState(value: unknown): TaskUiState {
  switch (string(value)) {
    case 'queued': return 'queued';
    case 'assigned': return 'assigned';
    case 'dispatch_accepted': return 'dispatch_accepted';
    case 'turn_started': return 'turn_started';
    case 'in_progress':
    case 'active':
    case 'working': return 'in_progress';
    case 'blocked': return 'blocked';
    case 'approval_wait': return 'approval_wait';
    case 'completed':
    case 'report_ready': return 'report_ready';
    case 'needs_orchestrator_review':
    case 'needs_revision':
    case 'changes_requested':
    case 'needs_review': return 'needs_review';
    case 'accepted':
    case 'retired':
    case 'superseded':
    case 'cancelled': return 'accepted';
    case 'failed': return 'failed';
    default: return 'unknown';
  }
}

const FAILURE_SEVERITY_RANK: Record<FailureUiSeverity, number> = { unknown: 0, low: 1, medium: 2, high: 3, blocker: 4 };
const RESOLVED_FAILURE_STATUSES = new Set(['resolved', 'mitigated', 'wontfix', 'noise', 'retired', 'promoted', 'closed']);
const OPEN_FAILURE_STATUSES = new Set(['open', 'reopened', 'candidate', 'clustered', 'routed_codex', 'repair_card_ready', 'user_task_open', 'waiting']);

function failureSeverity(value: unknown): FailureUiSeverity {
  const normalized = string(value)?.toLowerCase();
  if (normalized === 'critical' || normalized === 'blocker') return 'blocker';
  if (normalized === 'high' || normalized === 'medium' || normalized === 'low') return normalized;
  return 'unknown';
}

function strongestFailureSeverity(rowsToCompare: JsonObject[]): FailureUiSeverity {
  return rowsToCompare.reduce<FailureUiSeverity>((strongest, row) => {
    const candidate = failureSeverity(row.severity);
    return FAILURE_SEVERITY_RANK[candidate] > FAILURE_SEVERITY_RANK[strongest] ? candidate : strongest;
  }, 'unknown');
}

function failureResolution(value: unknown): FailureUiResolution {
  const normalized = string(value)?.toLowerCase() ?? '';
  if (RESOLVED_FAILURE_STATUSES.has(normalized)) return 'resolved';
  if (OPEN_FAILURE_STATUSES.has(normalized)) return 'open';
  return 'unknown';
}

function failureOccurrence(raw: JsonObject, source: FailureOccurrenceUi['source']): FailureOccurrenceUi | null {
  const id = string(source === 'incident' ? raw.incident_id : raw.candidate_id);
  if (!id) return null;
  return {
    id,
    source,
    status: string(raw.status) ?? 'unknown',
    summary: string(raw.summary) ?? string(raw.title) ?? id,
    occurredAt: string(raw.detected_at) ?? string(raw.created_at) ?? null,
    taskId: string(raw.task_id),
    sourceAgentId: string(raw.source_agent_id),
    evidence: stringList(raw.evidence),
    attemptedFixes: [...stringList(raw.attempted_fixes), ...stringList(raw.cleanup_attempts)],
    outcome: string(raw.fix) ?? string(raw.current_action) ?? string(raw.resolution_evidence)
  };
}

function failureRecord(input: {
  id: string;
  source: FailureUiModel['source'];
  failureClass: string;
  rows: JsonObject[];
  occurrenceCount?: number;
  status?: string | null;
  repairStatus?: string | null;
  resolutionEvidence?: unknown;
}): FailureUiModel {
  const rowsByNewest = [...input.rows].sort((left, right) => dateValue(right.detected_at ?? right.created_at) - dateValue(left.detected_at ?? left.created_at));
  const latest = rowsByNewest[0] ?? {};
  const occurrences = rowsByNewest.flatMap((row) => failureOccurrence(row, string(row.incident_id) ? 'incident' : 'candidate') ?? []);
  const status = input.status ?? string(latest.status) ?? 'unknown';
  const rowResolutions = rowsByNewest.map((row) => failureResolution(row.status));
  const resolution = input.status
    ? failureResolution(input.status)
    : rowResolutions.length && rowResolutions.every((item) => item === 'resolved')
      ? 'resolved'
      : rowResolutions.some((item) => item === 'open') ? 'open' : 'unknown';
  const timestamps = occurrences.map((item) => item.occurredAt).filter((value): value is string => Boolean(value));
  const oldest = [...timestamps].sort((left, right) => dateValue(left) - dateValue(right))[0] ?? null;
  const newest = [...timestamps].sort((left, right) => dateValue(right) - dateValue(left))[0] ?? null;
  const firstIncident = rowsByNewest.find((row) => string(row.incident_id));
  const resolutionEvidence = stringList(input.resolutionEvidence);
  return {
    id: input.id,
    source: input.source,
    failureClass: input.failureClass,
    title: string(latest.title) ?? string(latest.summary) ?? input.failureClass,
    summary: string(latest.summary) ?? string(latest.current_action) ?? string(latest.title) ?? input.failureClass,
    severity: strongestFailureSeverity(rowsByNewest),
    status,
    resolution,
    occurrenceCount: Math.max(input.occurrenceCount ?? occurrences.length, occurrences.length),
    firstOccurredAt: oldest,
    lastOccurredAt: newest,
    taskIds: [...new Set(rowsByNewest.flatMap((row) => [string(row.task_id), ...stringArray(row.related_task_ids)].filter((value): value is string => Boolean(value))))].sort(),
    sourceAgentIds: [...new Set(rowsByNewest.flatMap((row) => string(row.source_agent_id) ?? []))].sort(),
    suspectedOwner: string(latest.suspected_owner) ?? string(firstIncident?.suspected_owner),
    repairStatus: input.repairStatus ?? string(latest.repair_status) ?? string(latest.status),
    cause: string(latest.confirmed_cause) ?? string(latest.suspected_cause) ?? string(firstIncident?.confirmed_cause) ?? string(firstIncident?.suspected_cause),
    fix: string(latest.fix) ?? string(latest.current_action) ?? resolutionEvidence[0] ?? null,
    prevention: [...new Set(rowsByNewest.flatMap((row) => [...stringList(row.prevention), ...stringList(row.prevention_candidates)]))],
    evidence: [...new Set([...rowsByNewest.flatMap((row) => stringList(row.evidence)), ...resolutionEvidence])],
    occurrences
  };
}

function projectFailures(documents: RepositoryDocuments): FailureUiModel[] {
  const incidents = rows(documents.incidents, 'incidents');
  const candidates = rows(documents.incidentCandidates, 'candidates').filter((row) => !['noise', 'retired'].includes(string(row.status) ?? ''));
  const clusters = rows(documents.incidentClusters, 'clusters');
  const incidentById = new Map(incidents.flatMap((row) => string(row.incident_id) ? [[string(row.incident_id)!, row] as const] : []));
  const candidateById = new Map(candidates.flatMap((row) => string(row.candidate_id) ? [[string(row.candidate_id)!, row] as const] : []));
  const consumedIncidentIds = new Set<string>();
  const consumedCandidateIds = new Set<string>();
  const records: FailureUiModel[] = [];

  for (const cluster of clusters) {
    const id = string(cluster.cluster_id);
    if (!id) continue;
    const incidentIds = [...stringArray(cluster.incident_ids), ...stringArray(cluster.source_incident_ids)];
    const candidateIds = stringArray(cluster.candidate_ids);
    const clusterRows = [
      ...incidentIds.flatMap((item) => incidentById.get(item) ?? []),
      ...candidateIds.flatMap((item) => candidateById.get(item) ?? [])
    ];
    incidentIds.forEach((item) => consumedIncidentIds.add(item));
    candidateIds.forEach((item) => consumedCandidateIds.add(item));
    records.push(failureRecord({
      id,
      source: 'cluster',
      failureClass: string(cluster.primary_class) ?? string(cluster.failure_class) ?? string(clusterRows[0]?.failure_class) ?? id,
      rows: clusterRows.length ? clusterRows : [cluster],
      occurrenceCount: typeof cluster.occurrence_count === 'number' && Number.isInteger(cluster.occurrence_count) ? cluster.occurrence_count : clusterRows.length,
      status: string(cluster.status),
      repairStatus: string(cluster.repair_status) ?? string(cluster.status),
      resolutionEvidence: cluster.resolution_evidence
    }));
  }

  const remainingIncidents = incidents.filter((row) => !consumedIncidentIds.has(string(row.incident_id) ?? ''));
  const incidentsByClass = groupRows(remainingIncidents, (row) => string(row.failure_class) ?? string(row.incident_id) ?? 'unknown');
  for (const [failureClass, grouped] of incidentsByClass) {
    records.push(failureRecord({ id: `failure-class:${failureClass}`, source: 'incident', failureClass, rows: grouped }));
  }

  const remainingCandidates = candidates.filter((row) => !consumedCandidateIds.has(string(row.candidate_id) ?? ''));
  const candidatesByFingerprint = groupRows(remainingCandidates, (row) => string(row.global_fingerprint) ?? string(row.fingerprint) ?? string(row.candidate_id) ?? 'unknown');
  for (const [fingerprint, grouped] of candidatesByFingerprint) {
    records.push(failureRecord({
      id: grouped.length === 1 ? string(grouped[0].candidate_id) ?? `candidate:${fingerprint}` : `candidate:${fingerprint}`,
      source: 'candidate',
      failureClass: string(grouped[0]?.failure_class) ?? fingerprint,
      rows: grouped
    }));
  }

  return records.sort((left, right) => {
    if (left.resolution !== right.resolution) return left.resolution === 'open' ? -1 : right.resolution === 'open' ? 1 : 0;
    const severityDifference = FAILURE_SEVERITY_RANK[right.severity] - FAILURE_SEVERITY_RANK[left.severity];
    return severityDifference || dateValue(right.lastOccurredAt) - dateValue(left.lastOccurredAt) || left.id.localeCompare(right.id);
  });
}

function evidenceLevel(value: unknown): EvidenceLevel {
  return ['proven', 'reported', 'inferred', 'unknown'].includes(String(value)) ? value as EvidenceLevel : 'unknown';
}

function mapTask(raw: JsonObject, progressEventObserved = false): TaskUiModel | null {
  const id = string(raw.task_id);
  if (!id) return null;
  const rawState = string(raw.state) ?? 'unknown';
  const handoffs = Array.isArray(raw.handoff_attempts) ? raw.handoff_attempts.flatMap((item) => object(item) ?? []) : [];
  const cycles = Array.isArray(raw.execution_cycles) ? raw.execution_cycles.flatMap((item) => object(item) ?? []) : [];
  const dispatchAccepted = ['dispatch_accepted', 'turn_started', 'in_progress', 'needs_orchestrator_review', 'needs_revision', 'accepted'].includes(rawState)
    || handoffs.some((item) => ['accepted', 'started', 'handoff_sent', 'report_produced'].includes(
    string(item.dispatch_status) ?? string(item.status) ?? string(item.result) ?? ''
  ));
  const turnStarted = Boolean(string(raw.turn_started_at))
    || handoffs.some((item) => ['confirmed', 'verified'].includes(string(item.turn_start_status) ?? ''))
    || cycles.some((item) => Boolean(string(item.turn_started_at)));
  const progressObserved = progressEventObserved
    || raw.progress_observed === true || Boolean(string(raw.progress_summary))
    || cycles.some((item) => Boolean(string(item.progress_observed_at)) || ['completed', 'accepted'].includes(string(item.status) ?? ''));
  const modelRoute = object(raw.model_route);
  const routeActualModelEvidence = evidenceLevel(modelRoute?.actual_model_evidence ?? raw.actual_model_evidence);
  const evidencedHandoff = [...handoffs].reverse().find((item) =>
    Boolean(string(item.actual_model)) && evidenceLevel(item.actual_model_evidence) !== 'unknown'
  );
  const actualModel = routeActualModelEvidence !== 'unknown'
    ? string(modelRoute?.actual_model) ?? string(raw.actual_model)
    : string(evidencedHandoff?.actual_model);
  const actualModelEvidence = actualModel
    ? routeActualModelEvidence !== 'unknown' ? routeActualModelEvidence : evidenceLevel(evidencedHandoff?.actual_model_evidence)
    : 'unknown';
  const ownerAgentId = string(raw.owner_agent_id);
  const assignedByAgentId = string(raw.assigned_by_agent_id) ?? (ownerAgentId === 'orchestrator' ? 'user' : 'orchestrator');
  const reportPath = string(raw.specialist_report_path) ?? string(raw.report_path);

  return {
    id,
    title: string(raw.title) ?? string(raw.purpose) ?? id,
    state: taskState(rawState),
    ownerAgentId,
    assignedByAgentId,
    dependencies: stringArray(raw.dependencies),
    blockedBy: stringArray(raw.blocked_by),
    routingClass: string(raw.routing_class) ?? string(raw.task_kind),
    handoffSent: Boolean(string(raw.handoff_sent_at) || handoffs.length),
    dispatchAccepted,
    turnStarted,
    progressObserved,
    progressSummary: string(raw.progress_summary) ?? string(raw.result_summary),
    progressPercent: typeof raw.progress_percent === 'number' && Number.isFinite(raw.progress_percent) ? raw.progress_percent : null,
    reportStatus: reportPath ? (REVIEW_TASK_STATES.has(rawState) ? rawState : 'available') : null,
    reportPath,
    expectedArtifact: string(raw.expected_artifact) ?? string(raw.task_context && object(raw.task_context)?.expected_artifact),
    acceptanceChecks: stringArray(raw.acceptance_checks).length > 0
      ? stringArray(raw.acceptance_checks)
      : stringArray(raw.acceptance_criteria),
    recommendedModel: string(modelRoute?.recommended_model),
    requestedModel: string(modelRoute?.requested_model),
    actualModel,
    actualModelEvidence,
    startedAt: string(raw.started_at),
    updatedAt: newestTimestamp([raw.updated_at, raw.completed_at, raw.accepted_at, raw.started_at, raw.created_at]),
    userActionId: string(raw.user_action_id)
  };
}

function isFresh(timestamp: string | null, now: Date): boolean {
  const time = dateValue(timestamp);
  return time > 0 && now.getTime() - time >= 0 && now.getTime() - time <= FRESH_RUNTIME_MS;
}

function rawTaskIsCurrent(raw: JsonObject): boolean {
  return !TERMINAL_TASK_STATES.has(string(raw.state) ?? 'unknown');
}

function rawTaskCanBeCurrentFallback(raw: JsonObject): boolean {
  return FALLBACK_CURRENT_TASK_STATES.has(string(raw.state) ?? 'unknown');
}

interface ExplicitOrganizationProjection {
  snapshot: OrganizationUiSnapshot;
  participants: ProjectParticipantUiModel[];
  agentById: Map<string, JsonObject>;
  membershipByAgentId: Map<string, JsonObject>;
  teamById: Map<string, JsonObject>;
  parentByAgentId: Map<string, string>;
  roleById: Map<string, JsonObject>;
}

function projectOrganization(documents: RepositoryDocuments): ExplicitOrganizationProjection {
  let bundle: ReturnType<typeof executionKernel.createOrganizationV3Bundle>;
  try {
    bundle = executionKernel.createOrganizationV3Bundle({
      agentRegistry: documents.agents,
      organization: documents.organization,
      formations: documents.formations
    } as never);
  } catch (error) {
    throw new Error('repository_organization_v3_invalid', { cause: error });
  }
  const organization = object(bundle.organization);
  const agentRegistry = object(bundle.agentRegistry);
  if (organization && agentRegistry) {
    const organizationAgents = rows(agentRegistry, 'agents');
    const memberships = rows(organization, 'memberships').filter((item) => item.active_to === null || item.active_to === undefined);
    const teams = rows(organization, 'teams');
    const activeFormations = rows(bundle.formations, 'formations')
      .filter((item) => string(item.lifecycle_state) === 'active');
    const formationTeams = activeFormations.flatMap((formation, index) => {
      const id = string(formation.formation_id);
      const source = object(formation.source_ref);
      if (!id) return [];
      return [{
        team_id: id,
        line_id: null,
        display_name: id,
        purpose: source ? `${string(source.kind) ?? 'work'}:${string(source.id) ?? id}` : 'Dynamic work formation',
        lifecycle_state: 'active',
        display_order: teams.length + index + 1,
        lead_agent_id: string(formation.lead_agent_id)
      }];
    });
    const formationMemberships = activeFormations.flatMap((formation) => {
      const teamId = string(formation.formation_id);
      const leadAgentId = string(formation.lead_agent_id);
      if (!teamId) return [];
      return stringArray(formation.member_agent_ids).map((agentId, index) => ({
        agent_id: agentId,
        team_id: teamId,
        position: agentId === leadAgentId ? 'lead' : 'member',
        ordinal: index + 1,
        active_to: null
      }));
    });
    const projectedMemberships = [...memberships, ...formationMemberships]
      .filter((membership, index, all) => all.findIndex((candidate) => string(candidate.agent_id) === string(membership.agent_id)) === index);
    const allTeams = [...teams, ...formationTeams];
    const relationships = rows(organization, 'relationships');
    const authorityByParticipantId = new Map(relationships.flatMap((item) => {
      if (string(item.type) !== 'authority_over') return [];
      const subject = object(item.subject_ref);
      const target = object(item.object_ref);
      const participantId = string(subject?.kind) === 'participant' ? string(subject?.id) : null;
      const orchestratorAgentId = string(target?.kind) === 'agent' ? string(target?.id) : null;
      return participantId && orchestratorAgentId ? [[participantId, orchestratorAgentId] as const] : [];
    }));
    const projectedParticipants = rows(organization, 'participants')
      .filter((participant) => string(participant.lifecycle_state) === 'active')
      .flatMap((participant): ProjectParticipantUiModel[] => {
        const id = string(participant.participant_id);
        if (!id) return [];
        return [{
          id,
          displayName: string(participant.display_name) ?? id,
          roleLabel: id === 'user' ? 'OWNER' : 'PROJECT MEMBER',
          isCurrentUser: id === 'user',
          orchestratorAgentId: authorityByParticipantId.get(id) ?? null
        }];
      });
    const lines = rows(organization, 'lines').flatMap((item, index) => {
      const id = string(item.line_id);
      const ownerRef = object(item.owner_ref);
      const ownerAgentId = string(ownerRef?.id);
      if (!id || !ownerAgentId) return [];
      const dedicatedLeadAgentId = allTeams
        .filter((team) => string(team.line_id) === id)
        .map((team) => string(team.lead_agent_id))
        .find((value): value is string => Boolean(value)) ?? null;
      return [{
        id,
        displayName: string(item.display_name) ?? id,
        goal: string(item.goal),
        status: string(item.status) ?? 'unknown',
        ownerAgentId,
        dedicatedLeadAgentId,
        displayOrder: integer(item.display_order, index + 1),
        approvalSource: string(item.approval_source)
      }];
    });
    const projectedTeams = allTeams.flatMap((item, index) => {
      const id = string(item.team_id);
      if (!id) return [];
      return [{
        id,
        lineId: string(item.line_id),
        displayName: string(item.display_name) ?? id,
        purpose: string(item.purpose),
        lifecycleState: string(item.lifecycle_state) ?? 'unknown',
        displayOrder: integer(item.display_order, index + 1)
      }];
    });
    const projectedRelationships = relationships.flatMap((item) => {
      const id = string(item.relationship_id);
      const type = string(item.type);
      const subject = object(item.subject_ref);
      const target = object(item.object_ref);
      const fromAgentId = string(subject?.kind) === 'agent' ? string(subject?.id) : null;
      const toAgentId = string(target?.kind) === 'agent' ? string(target?.id) : null;
      return id && type && fromAgentId && toAgentId ? [{ id, type, fromAgentId, toAgentId }] : [];
    });
    return {
      snapshot: {
        revision: Number(organization.revision),
        source: 'explicit',
        diagnostics: [],
        lines,
        teams: projectedTeams,
        relationships: projectedRelationships,
        lineProposals: []
      },
      participants: projectedParticipants,
      agentById: new Map(organizationAgents.flatMap((item) => string(item.agent_id) ? [[string(item.agent_id)!, item] as const] : [])),
      membershipByAgentId: new Map(projectedMemberships.flatMap((item) => string(item.agent_id) ? [[string(item.agent_id)!, item] as const] : [])),
      teamById: new Map(allTeams.flatMap((item) => string(item.team_id) ? [[string(item.team_id)!, item] as const] : [])),
      parentByAgentId: new Map(relationships.flatMap((item) => {
        if (string(item.type) !== 'reports_to') return [];
        const subject = object(item.subject_ref);
        const target = object(item.object_ref);
        const from = string(subject?.kind) === 'agent' ? string(subject?.id) : null;
        const to = string(target?.kind) === 'agent' ? string(target?.id) : null;
        return from && to ? [[from, to] as const] : [];
      })),
      roleById: new Map()
    };
  }
  throw new Error('repository_organization_v3_required');
}

interface CanonicalSessionAuthority {
  runtimeAuthorityId: string;
  expectedVisibility: 'codex_task' | 'desktop_only';
}

function canonicalSessionAuthority(documents: RepositoryDocuments, projectId?: string): CanonicalSessionAuthority | null {
  const runtime = object(documents.runtimeBinding);
  if (!runtime) return null;
  const runtimeProjectId = string(runtime.project_id);
  const runtimeAuthorityId = string(runtime.runtime_authority_id);
  const mode = string(runtime.mode);
  if (runtime.schema_version !== 1 || !runtimeProjectId || !runtimeAuthorityId
    || !['codex_hosted', 'standalone'].includes(mode ?? '')
    || (projectId !== undefined && runtimeProjectId !== projectId)) {
    throw new Error('repository_runtime_binding_invalid');
  }
  return {
    runtimeAuthorityId,
    expectedVisibility: mode === 'codex_hosted' ? 'codex_task' : 'desktop_only'
  };
}

function canonicalActiveOwnerSessions(
  documents: RepositoryDocuments,
  projectId?: string
): { sessions: JsonObject[]; activeOwnerByAgentId: Map<string, JsonObject> } {
  if (documents.sessions === undefined) return { sessions: [], activeOwnerByAgentId: new Map() };
  const validation = validateContract('session-binding-state-v1', documents.sessions);
  if (!validation.ok) throw new Error('repository_session_binding_v1_required');
  const state = object(documents.sessions)!;
  if (projectId !== undefined && string(state.project_id) !== projectId) {
    throw new Error('repository_session_binding_foreign_project');
  }
  const sessions = rows(state, 'sessions', true);
  const authority = canonicalSessionAuthority(documents, projectId ?? string(state.project_id));
  if (!authority) return { sessions, activeOwnerByAgentId: new Map() };
  const activeOwnerByAgentId = new Map<string, JsonObject>();
  for (const session of sessions) {
    const acceptingOwner = string(session.session_kind) === 'persistent_agent'
      && string(session.handoff_status) === 'accepted'
      && string(session.binding_status) === 'bound'
      && string(session.ownership_status) === 'owner'
      && ['active', 'rotation_preparing', 'rotation_pending'].includes(string(session.rotation_state) ?? '')
      && session.accepts_new_work === true;
    if (!acceptingOwner) continue;
    if (string(session.runtime_authority_id) !== authority.runtimeAuthorityId
      || string(session.visibility) !== authority.expectedVisibility) {
      throw new Error('repository_session_binding_runtime_authority_conflict');
    }
    const agentId = string(session.agent_id);
    if (!agentId) throw new Error('repository_session_binding_owner_invalid');
    if (activeOwnerByAgentId.has(agentId)) {
      throw new Error(`repository_session_binding_active_owner_ambiguous:${agentId}`);
    }
    activeOwnerByAgentId.set(agentId, session);
  }
  return { sessions, activeOwnerByAgentId };
}

function projectAgents(
  rawAgents: JsonObject[],
  rawTasks: JsonObject[],
  tasksById: Map<string, TaskUiModel>,
  sessions: JsonObject[],
  activeOwnerByAgentId: Map<string, JsonObject>,
  organization: ExplicitOrganizationProjection,
  now: Date
): AgentUiModel[] {
  const rawTaskById = new Map(rawTasks.flatMap((item) => string(item.task_id) ? [[string(item.task_id)!, item] as const] : []));
  const tasksByOwner = new Map<string, JsonObject[]>();
  for (const task of rawTasks) {
    const owner = string(task.owner_agent_id);
    if (!owner || !rawTaskCanBeCurrentFallback(task)) continue;
    const list = tasksByOwner.get(owner) ?? [];
    list.push(task);
    tasksByOwner.set(owner, list);
  }
  const sessionsByAgent = new Map<string, JsonObject[]>();
  for (const session of sessions) {
    const agentId = string(session.agent_id);
    if (!agentId) continue;
    const values = sessionsByAgent.get(agentId) ?? [];
    values.push(session);
    sessionsByAgent.set(agentId, values);
  }

  return rawAgents.flatMap((raw) => {
    const id = string(raw.agent_id);
    if (!id) return [];
    if (organization.snapshot.source === 'explicit' && !organization.agentById.has(id)) return [];
    const organizationAgent = organization.agentById.get(id);
    if (['retired', 'superseded'].includes(string(organizationAgent?.lifecycle_state) ?? '')) return [];
    const declaredTaskId = string(raw.current_task);
    const declaredTask = declaredTaskId ? rawTaskById.get(declaredTaskId) : undefined;
    const validDeclaredTask = declaredTask && string(declaredTask.owner_agent_id) === id && rawTaskIsCurrent(declaredTask) ? declaredTask : undefined;
    const fallbackTask = [...(tasksByOwner.get(id) ?? [])].sort((left, right) =>
      dateValue(newestTimestamp([right.updated_at, right.completed_at, right.started_at, right.created_at]))
      - dateValue(newestTimestamp([left.updated_at, left.completed_at, left.started_at, left.created_at])))[0];
    const currentRawTask = validDeclaredTask ?? fallbackTask;
    const currentTaskId = currentRawTask ? string(currentRawTask.task_id) : null;
    const currentTask = currentTaskId ? tasksById.get(currentTaskId) : undefined;
    const membership = organization.membershipByAgentId.get(id);
    const teamId = string(membership?.team_id) ?? string(raw.team_id);
    const team = teamId ? organization.teamById.get(teamId) : undefined;
    const organizationParentAgentId = organization.parentByAgentId.get(id)
      ?? string(raw.organization_parent_agent_id);
    const session = activeOwnerByAgentId.get(id);
    const liveBinding = session !== undefined;
    const hasBindingEvidence = (sessionsByAgent.get(id)?.length ?? 0) > 0;
    const heartbeat = newestTimestamp([session?.updated_at, currentRawTask?.updated_at, currentRawTask?.started_at]);
    const fresh = liveBinding
      && isFresh(heartbeat, now)
      && string(session?.accepted_at) !== null;
    const rawStatus = string(organizationAgent?.operational_status) ?? string(raw.operational_status) ?? string(raw.status) ?? 'unknown';
    let status: AgentUiStatus;
    let statusEvidence: EvidenceLevel;

    if (currentTask?.state === 'blocked' || rawStatus === 'blocked') {
      status = 'blocked'; statusEvidence = 'proven';
    } else if (currentTask && ['report_ready', 'needs_review'].includes(currentTask.state)) {
      status = 'report_ready'; statusEvidence = 'proven';
    } else if (rawStatus === 'approval_wait' || currentTask?.state === 'approval_wait') {
      status = 'approval_wait'; statusEvidence = 'reported';
    } else if (!liveBinding) {
      status = 'stale'; statusEvidence = hasBindingEvidence ? 'proven' : 'unknown';
    } else if (currentTask?.turnStarted && fresh) {
      status = 'working'; statusEvidence = 'proven';
    } else if (currentTask?.turnStarted && !fresh) {
      status = 'stale'; statusEvidence = 'reported';
    } else if (currentTask?.dispatchAccepted || currentTask?.handoffSent) {
      status = 'assigned_waiting'; statusEvidence = 'reported';
    } else if (['standby', 'idle'].includes(rawStatus) || liveBinding) {
      status = 'standby'; statusEvidence = 'proven';
    } else if (rawStatus === 'active' && !fresh) {
      status = 'stale'; statusEvidence = 'reported';
    } else if (rawStatus === 'active') {
      status = 'standby'; statusEvidence = 'reported';
    } else {
      status = 'unknown'; statusEvidence = 'unknown';
    }

    const roleId = string(organizationAgent?.role_id) ?? string(raw.role_id) ?? string(raw.role) ?? 'specialist';
    const roleDefinition = organization.roleById.get(roleId);
    const roleNames = object(roleDefinition?.display_names);
    const role = organization.snapshot.source === 'explicit' ? roleId : string(raw.role) ?? roleId;
    const displayName = string(raw.display_name) ?? string(raw.display_name_ja) ?? string(raw.display_name_en) ?? string(roleNames?.ja) ?? string(roleNames?.en) ?? id;
    const roleSummary = string(raw.role_summary) ?? string(raw.mission) ?? role.replaceAll('-', ' ');
    const presentation = id === LUCA_AGENT_ID
      ? { displayName: LUCA_DISPLAY_NAME, role: LUCA_ROLE_LABEL, roleSummary: LUCA_ROLE_SUMMARY }
      : { displayName, role, roleSummary };
    const delegatedByAgentId = string(currentRawTask?.assigned_by_agent_id) ?? string(raw.delegated_by_agent_id) ?? string(raw.assigned_by_agent_id);
    const lineId = string(team?.line_id) ?? string(raw.line_id);
    const declaredOrganizationScope = string(organizationAgent?.organization_scope) ?? string(raw.organization_scope);
    const organizationScope = ['project', 'line'].includes(declaredOrganizationScope ?? '')
      ? declaredOrganizationScope as 'project' | 'line'
      : teamId ? (lineId ? 'line' : 'project') : 'project';
    const history = rawTasks
      .filter((task) => string(task.owner_agent_id) === id && TERMINAL_TASK_STATES.has(string(task.state) ?? ''))
      .sort((left, right) => dateValue(right.accepted_at) - dateValue(left.accepted_at))
      .slice(0, 8)
      .flatMap((task) => string(task.task_id) ? [{
        id: string(task.task_id)!,
        title: string(task.title) ?? string(task.task_id)!,
        state: string(task.state) ?? 'unknown',
        changedAt: newestTimestamp([task.accepted_at, task.completed_at, task.updated_at, task.created_at]) ?? now.toISOString()
      }] : []);
    const recentEvidence = currentTask ? [
      ...(currentTask.handoffSent ? [{ id: `${currentTask.id}-dispatch`, label: 'Dispatch recorded', detail: 'The canonical task contains handoff evidence.', level: 'reported' as const, observedAt: currentTask.startedAt }] : []),
      ...(currentTask.turnStarted ? [{ id: `${currentTask.id}-turn`, label: 'Turn start recorded', detail: 'The canonical task contains confirmed or verified turn-start evidence.', level: 'proven' as const, observedAt: currentTask.startedAt }] : []),
      ...(currentTask.progressObserved ? [{ id: `${currentTask.id}-progress`, label: 'Progress recorded', detail: currentTask.progressSummary ?? 'Task progress exists in canonical state.', level: 'proven' as const, observedAt: currentTask.updatedAt }] : [])
    ] : [];

    return [{
      id,
      displayName: presentation.displayName,
      role: presentation.role,
      roleSummary: presentation.roleSummary,
      iconKey: roleIcon(role),
      status,
      statusEvidence,
      currentTaskId: currentTask?.id ?? null,
      currentTaskTitle: currentTask?.title ?? null,
      assignedByAgentId: organizationParentAgentId ?? (id === 'orchestrator' || id === LUCA_AGENT_ID ? 'user' : string(raw.assigned_by_agent_id) ?? 'orchestrator'),
      roleId,
      teamId,
      lineId,
      position: ['member', 'lead'].includes(string(membership?.position) ?? '') ? string(membership?.position) as 'member' | 'lead' : null,
      organizationParentAgentId,
      delegatedByAgentId,
      organizationScope,
      lifecycleState: ['proposed', 'provisioning', 'active', 'retired', 'superseded'].includes(string(organizationAgent?.lifecycle_state) ?? string(raw.lifecycle_state) ?? '')
        ? (string(organizationAgent?.lifecycle_state) ?? string(raw.lifecycle_state)) as AgentUiModel['lifecycleState']
        : null,
      operationalStatus: string(organizationAgent?.operational_status) ?? string(raw.operational_status),
      organizationRevision: organization.snapshot.source === 'explicit'
        ? organization.snapshot.revision
        : typeof raw.organization_revision === 'number' && Number.isInteger(raw.organization_revision) ? raw.organization_revision : null,
      membershipOrdinal: membership ? integer(membership.ordinal) : null,
      displayOrder: organizationAgent && typeof organizationAgent.display_order === 'number' && Number.isInteger(organizationAgent.display_order)
        ? organizationAgent.display_order
        : null,
      blockedReason: string(raw.blocked_reason) ?? (currentTask?.state === 'blocked' ? currentTask.progressSummary : null),
      waitingOn: string(raw.waiting_on),
      contextScope: string(raw.context_scope),
      requiredReadingCount: stringArray(raw.required_reading).length,
      expectedArtifact: currentTask?.expectedArtifact ?? null,
      lastEvidenceAt: newestTimestamp([currentTask?.updatedAt, raw.last_report_at, heartbeat]),
      lastHeartbeatAt: heartbeat,
      recentEvidence,
      history,
      forbiddenActions: stringArray(raw.forbidden_actions)
    }];
  });
}

function priority(value: unknown): AttentionUiItem['priority'] {
  return ['low', 'medium', 'high', 'blocker'].includes(String(value)) ? value as AttentionUiItem['priority'] : 'medium';
}

const CLOSED_USER_ACTION_STATES = new Set(['answered', 'applied', 'cancelled', 'closed', 'dismissed', 'done', 'rejected', 'resolved']);

function actionIsOpen(value: unknown): boolean {
  return !CLOSED_USER_ACTION_STATES.has(string(value) ?? 'pending');
}

function actionAttentionType(kind: AttentionUiItem['actionKind']): AttentionUiItem['type'] {
  if (kind === 'answer') return 'question';
  if (kind === 'approve') return 'approval';
  if (kind === 'review') return 'report_review';
  return 'direction';
}

function attentionId(source: 'question' | 'user-task' | 'user-action', canonicalId: string): string {
  return `${source}:${canonicalId}`;
}

function projectAttention(documents: RepositoryDocuments, now: Date): AttentionUiItem[] {
  const questions = rows(documents.questions, 'questions')
    .filter((item) => actionIsOpen(item.status))
    .flatMap((item) => {
      const id = string(item.question_id) ?? string(item.id);
      return id ? [{
        id: attentionId('question', id), sourceKind: 'user_question' as const, type: 'question' as const, actionKind: 'answer' as const, priority: priority(item.priority), title: string(item.title) ?? 'Question',
        summary: string(item.question) ?? 'A user decision is waiting.', sourceAgentId: string(item.source_agent_id), taskId: string(item.source_task_id) ?? string(item.task_id),
        blocking: Boolean(item.blocking), createdAt: string(item.created_at) ?? now.toISOString(), resolvedAt: null, resolutionDecision: null
      }] : [];
    });
  const userTasks = rows(documents.userTasks, 'tasks')
    .filter((item) => actionIsOpen(item.status))
    .flatMap((item) => {
      const id = string(item.user_task_id) ?? string(item.task_id);
      if (!id) return [];
      const source = string(item.source) ?? '';
      const kind: AttentionUiItem['actionKind'] = source === 'approval_wait' || Boolean(string(item.approval_type))
        ? 'approve'
        : /review/u.test(source)
          ? 'review'
          : 'do';
      return [{
        id: attentionId('user-task', id),
        sourceKind: 'user_task' as const,
        type: actionAttentionType(kind),
        actionKind: kind,
        priority: priority(item.priority),
        title: string(item.title) ?? 'User task',
        summary: string(item.prompt) ?? string(item.requested_action) ?? string(item.resume_instruction) ?? 'A user action is waiting.',
        sourceAgentId: string(item.source_agent_id) ?? string(item.support_agent_id),
        taskId: stringArray(item.source_ids)[0] ?? null,
        blocking: source === 'approval_wait',
        createdAt: string(item.created_at) ?? now.toISOString(),
        resolvedAt: null,
        resolutionDecision: null
      }];
    });
  const userActions = rows(documents.userActions, 'actions')
    .filter((item) => actionIsOpen(item.status))
    .flatMap((item) => {
      const id = string(item.action_id);
      if (!id) return [];
      const steps = stringArray(item.user_steps);
      return [{
        id: attentionId('user-action', id),
        sourceKind: 'user_action' as const,
        type: 'repair' as const,
        actionKind: 'do' as const,
        priority: priority(item.priority ?? item.risk),
        title: string(item.title) ?? 'Repair action',
        summary: string(item.why_this_helps) ?? steps[0] ?? 'A user-side repair is ready.',
        sourceAgentId: string(item.source_agent_id) ?? 'user-support',
        taskId: string(item.task_id),
        blocking: item.requires_user_approval === true,
        createdAt: string(item.created_at) ?? now.toISOString(),
        resolvedAt: null,
        resolutionDecision: null
      }];
    });
  const projected = [...questions, ...userTasks, ...userActions];
  const seen = new Set<string>();
  return projected.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function projectEvents(events: unknown[] | undefined, now: Date): RuntimeUiEvent[] {
  return (events ?? []).flatMap((item, index) => {
    const event = object(item);
    if (!event) return [];
    const type = string(event.type) ?? 'state_changed';
    const createdAt = string(event.ts) ?? string(event.created_at) ?? now.toISOString();
    const tone: RuntimeUiEvent['tone'] = /fail|error|blocked/.test(type) ? 'danger' : /accepted|completed|resolved/.test(type) ? 'success' : /review|warning/.test(type) ? 'warning' : 'neutral';
    return [{
      id: string(event.event_id) ?? `event-${createdAt}-${index}`,
      tone,
      title: type.replaceAll('_', ' '),
      message: string(event.summary) ?? string(event.message) ?? 'Canonical state changed.',
      taskId: string(event.task_id),
      createdAt
    }];
  }).sort((left, right) => dateValue(right.createdAt) - dateValue(left.createdAt)).slice(0, 6);
}

function projectPhases(tasks: TaskUiModel[]): { phases: ProjectPhaseUiModel[]; currentPhaseId: string } {
  const active = tasks.filter((task) => ['queued', 'assigned', 'dispatch_accepted', 'turn_started', 'in_progress'].includes(task.state));
  const review = tasks.filter((task) => ['report_ready', 'needs_review', 'approval_wait'].includes(task.state));
  const blocked = tasks.filter((task) => ['blocked', 'failed'].includes(task.state));
  const done = tasks.filter((task) => task.state === 'accepted');
  const phases: ProjectPhaseUiModel[] = [
    { id: 'completed-work', title: 'Completed work', summary: `${done.length} tasks accepted or retired`, status: 'done', ownerAgentIds: [], itemCount: done.length, completedItemCount: done.length },
    { id: 'active-work', title: 'Active work', summary: `${active.length} tasks queued or executing`, status: active.length ? 'current' : 'done', ownerAgentIds: [...new Set(active.flatMap((task) => task.ownerAgentId ?? []))], itemCount: active.length, completedItemCount: 0 },
    { id: 'review-work', title: 'Review queue', summary: `${review.length} tasks waiting for review`, status: review.length ? 'current' : 'done', ownerAgentIds: [...new Set(review.flatMap((task) => task.ownerAgentId ?? []))], itemCount: review.length, completedItemCount: 0 },
    { id: 'blocked-work', title: 'Blocked work', summary: `${blocked.length} tasks blocked or failed`, status: blocked.length ? 'blocked' : 'done', ownerAgentIds: [...new Set(blocked.flatMap((task) => task.ownerAgentId ?? []))], itemCount: blocked.length, completedItemCount: 0 }
  ];
  return { phases, currentPhaseId: blocked.length ? 'blocked-work' : active.length ? 'active-work' : review.length ? 'review-work' : 'completed-work' };
}

const ACTIVE_INSPECTION_STATUSES = new Set<InspectionRunStatus>(['queued', 'running', 'cancelling']);
const REPORT_INSPECTION_STATUSES = new Set<InspectionRunStatus>(['report_ready', 'partial', 'closed']);

function projectInspections(
  documents: RepositoryDocuments,
  rootPath: string,
  agents: AgentUiModel[],
  organization: OrganizationUiSnapshot
): { templates: InspectionTemplateUiModel[]; runs: InspectionRunUiModel[] } {
  const state = parseInspectionState(documents.inspectionRuns ?? { version: 1, runs: [] });
  const agentNames = new Map(agents.map((agent) => [agent.id, agent.displayName]));
  const lineNames = new Map(organization.lines.map((line) => [line.id, line.displayName]));
  const teamNames = new Map(organization.teams.map((team) => [team.id, team.displayName]));
  const targetLabel = (target: { kind: 'project' | 'line' | 'team' | 'agents'; ids: string[] }): string => {
    if (target.kind === 'project') return portableBasename(portableResolve(rootPath)) || rootPath;
    const names = target.kind === 'line'
      ? target.ids.map((id) => lineNames.get(id) ?? id)
      : target.kind === 'team'
        ? target.ids.map((id) => teamNames.get(id) ?? id)
        : target.ids.map((id) => agentNames.get(id) ?? id);
    return names.join(', ') || target.kind;
  };
  const displayName = new Map(INSPECTION_TEMPLATE_DEFINITIONS.map((template) => [template.kind, template.displayName]));
  const runs = state.runs
    .map((run): InspectionRunUiModel => ({
      runId: run.runId,
      kind: run.kind,
      displayName: displayName.get(run.kind) ?? run.kind,
      status: run.status,
      target: { ...run.target, ids: [...run.target.ids], label: targetLabel(run.target) },
      focus: run.focus,
      threadId: run.threadId,
      turnId: run.turnId,
      reportPath: run.reportPath,
      sourceCount: run.sourceCount,
      errorCode: run.errorCode,
      errorMessage: run.errorMessage,
      createdAt: run.createdAt,
      completedAt: run.completedAt
    }))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const templates = INSPECTION_TEMPLATE_DEFINITIONS.map((template): InspectionTemplateUiModel => ({
    ...template,
    activeRunId: runs.find((run) => run.kind === template.kind && ACTIVE_INSPECTION_STATUSES.has(run.status))?.runId ?? null,
    lastReportRunId: runs.find((run) => run.kind === template.kind && REPORT_INSPECTION_STATUSES.has(run.status) && run.reportPath)?.runId ?? null
  }));
  return { templates, runs };
}

export function projectSnapshotFromDocuments({ rootPath, projectId, documents, now = new Date() }: SnapshotProjectionInput): OrquestaUiSnapshot {
  const rawAgents = rows(documents.agents, 'agents', true);
  const rawTasks = rows(documents.tasks, 'tasks', true);
  const canonicalSessions = canonicalActiveOwnerSessions(documents, projectId);
  const sessions = canonicalSessions.sessions;
  const progressedTaskIds = new Set((documents.events ?? []).flatMap((item) => {
    const event = object(item);
    const type = string(event?.type) ?? '';
    const taskId = string(event?.task_id);
    return taskId && /progress|completed|accepted/u.test(type) ? [taskId] : [];
  }));
  const tasks = rawTasks.flatMap((task) => mapTask(task, progressedTaskIds.has(string(task.task_id) ?? '')) ?? []);
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const organization = projectOrganization(documents);
  const agents = projectAgents(rawAgents, rawTasks, tasksById, sessions, canonicalSessions.activeOwnerByAgentId, organization, now);
  const attention = projectAttention(documents, now);
  const failures = projectFailures(documents);
  const recentEvents = projectEvents(documents.events, now);
  const { phases, currentPhaseId } = projectPhases(tasks);
  const workingCount = agents.filter((agent) => agent.status === 'working' && agent.statusEvidence === 'proven').length;
  const blocked = tasks.some((task) => ['blocked', 'failed'].includes(task.state));
  const reviewTasks = tasks.filter((task) => ['report_ready', 'needs_review', 'approval_wait'].includes(task.state));
  const activeTasks = tasks.filter((task) => ['queued', 'assigned', 'dispatch_accepted', 'turn_started', 'in_progress'].includes(task.state));
  const nextTask = blocked ? tasks.find((task) => ['blocked', 'failed'].includes(task.state)) : activeTasks[0] ?? reviewTasks[0];
  const agentDocument = object(documents.agents);
  const taskDocument = object(documents.tasks);
  const sessionDocument = object(documents.sessions);
  const inspections = projectInspections(documents, rootPath, agents, organization.snapshot);

  return {
    project: {
      id: projectId ?? stableProjectId(rootPath),
      title: portableBasename(portableResolve(rootPath)) || rootPath,
      rootPathLabel: portableResolve(rootPath),
      status: blocked ? 'blocked' : workingCount ? 'working' : 'ready',
      connectionLabel: blocked ? 'Canonical state loaded · blockers present' : workingCount ? 'Canonical state loaded · live evidence present' : 'Canonical state loaded · no proven active work',
      isDemoData: false,
      repositoryDisplayState: 'snapshot',
      lastSyncedAt: newestTimestamp([agentDocument?.updated_at, taskDocument?.updated_at, sessionDocument?.synced_at]),
      currentPhaseId,
      agentCount: agents.length,
      provenWorkingAgentCount: workingCount,
      summary: `${tasks.length} canonical tasks · ${attention.length} attention items`,
      nextMilestone: nextTask?.title ?? null
    },
    agents,
    participants: organization.participants,
    tasks,
    attention,
    failures,
    phases,
    recentEvents,
    organization: organization.snapshot,
    projectStructure: projectStructure(documents),
    inspectionTemplates: inspections.templates,
    inspectionRuns: inspections.runs
  };
}

async function readBoundedJson(filename: string, required: boolean): Promise<unknown> {
  try {
    const info = await stat(filename);
    if (!info.isFile()) throw new Error('not a regular file');
    if (info.size > MAX_JSON_BYTES) throw new Error(`exceeds ${MAX_JSON_BYTES} bytes`);
    const source = await readFile(filename, 'utf8');
    return JSON.parse(source);
  } catch (error) {
    const code = object(error)?.code;
    if (!required && code === 'ENOENT') return undefined;
    throw new Error(`Cannot read ${path.basename(filename)}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readEvents(filename: string): Promise<unknown[]> {
  try {
    const info = await stat(filename);
    if (!info.isFile() || info.size > MAX_JSON_BYTES) return [];
    const source = await readFile(filename, 'utf8');
    return source.split(/\r?\n/u).filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } catch {
    return [];
  }
}

async function confinedFile(root: string, relativePath: string): Promise<string> {
  const filename = path.join(root, relativePath);
  try {
    const resolved = await realpath(filename);
    const relative = path.relative(root, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('path escapes selected project');
    return resolved;
  } catch (error) {
    if (object(error)?.code === 'ENOENT') return filename;
    throw error;
  }
}

function confinedStorageFile(root: string, relativePath: string): Promise<string> {
  return confinedFile(root, path.relative(root, projectStoragePath(root, relativePath)));
}

export async function readRepositorySnapshot(
  rootPath: string,
  options: { now?: Date; projectId?: string } = {}
): Promise<OrquestaUiSnapshot> {
  const root = await realpath(path.resolve(rootPath));
  const rolesPath = await confinedStorageFile(root, PROJECT_STORAGE.roles);
  const questionsPath = await confinedStorageFile(root, PROJECT_STORAGE.visionQuestions);
  const userTasksPath = await confinedStorageFile(root, PROJECT_STORAGE.userTaskQueue);
  const userActionsPath = await confinedStorageFile(root, PROJECT_STORAGE.failureUserActions);
  const dashboardActionsPath = await confinedStorageFile(root, PROJECT_STORAGE.dashboardActions);
  const incidentsPath = await confinedStorageFile(root, PROJECT_STORAGE.failureIncidents);
  const incidentCandidatesPath = await confinedStorageFile(root, PROJECT_STORAGE.failureCandidates);
  const incidentClustersPath = await confinedStorageFile(root, PROJECT_STORAGE.failureClusters);
  const eventsPath = await confinedStorageFile(root, PROJECT_STORAGE.stateEvents);
  const inspectionRunsPath = await confinedStorageFile(root, PROJECT_STORAGE.inspectionState);
  const structureInventoryPath = await confinedStorageFile(root, PROJECT_STORAGE.structureInventory);
  const structureAuditPath = await confinedStorageFile(root, PROJECT_STORAGE.structureAudit);
  const initialContextViewPath = await confinedStorageFile(root, PROJECT_STORAGE.initialContextView);
  const migrationPlanPath = await confinedStorageFile(root, PROJECT_STORAGE.structureMigrationPlan);
  const runtimeEvidence = await readRuntimeBindingEvidence(root);
  const effectiveProjectId = options.projectId ?? runtimeEvidence?.binding.project_id;
  if (!runtimeEvidence || !effectiveProjectId || runtimeEvidence.binding.project_id !== effectiveProjectId) {
    throw new Error('repository_runtime_binding_required');
  }
  const organizationState = executionKernel.inspectOrganizationV3(root, {
    validatedRuntimeBindingSha256: runtimeEvidence.sha256
  }) as {
    status: string;
    reason?: string;
    bundle?: { agentRegistry: unknown; organization: unknown; formations: unknown };
  };
  if (organizationState.status !== 'ready') {
    throw new Error(`repository_organization_v3_${organizationState.status}:${organizationState.reason ?? 'not_ready'}`);
  }
  if (!organizationState.bundle) throw new Error('repository_organization_v3_ready_without_bundle');
  const sessionState = await new SessionBindingStore().read(root, effectiveProjectId);
  if (sessionState.status !== 'ready') {
    throw new Error(`repository_session_binding_${sessionState.status}:${'reason' in sessionState ? sessionState.reason : 'not_ready'}`);
  }
  const placementState = new PlacementTaskPort(root).read(effectiveProjectId);
  if (placementState.status !== 'ready') {
    throw new Error(`repository_placement_task_${placementState.status}:${'reason' in placementState ? placementState.reason : 'not_ready'}`);
  }
  const [roles, questions, userTasks, userActions, dashboardActions, incidents, incidentCandidates, incidentClusters, inspectionRuns, structureInventory, structureAudit, initialContextView, migrationPlan, events] = await Promise.all([
    readBoundedJson(rolesPath, false),
    readBoundedJson(questionsPath, false),
    readBoundedJson(userTasksPath, false),
    readBoundedJson(userActionsPath, false),
    readBoundedJson(dashboardActionsPath, false),
    readBoundedJson(incidentsPath, false),
    readBoundedJson(incidentCandidatesPath, false),
    readBoundedJson(incidentClustersPath, false),
    readBoundedJson(inspectionRunsPath, false),
    readBoundedJson(structureInventoryPath, false),
    readBoundedJson(structureAuditPath, false),
    readBoundedJson(initialContextViewPath, false),
    readBoundedJson(migrationPlanPath, false),
    readEvents(eventsPath)
  ]);
  const migrationPlanId = string(object(migrationPlan)?.plan_id);
  const migrationResult = migrationPlanId
    ? await readBoundedJson(await confinedFile(root, path.join('.orquesta', 'project', 'migrations', 'applied', migrationPlanId, 'result.json')), false)
    : undefined;
  return projectSnapshotFromDocuments({
    rootPath: root,
    projectId: effectiveProjectId,
    now: options.now,
    documents: {
      agents: organizationState.bundle.agentRegistry,
      tasks: placementState.state,
      roles,
      organization: organizationState.bundle.organization,
      formations: organizationState.bundle.formations,
      sessions: sessionState.state,
      runtimeBinding: runtimeEvidence.binding,
      questions, userTasks, userActions, dashboardActions,
      incidents, incidentCandidates, incidentClusters, inspectionRuns,
      structureInventory, structureAudit, initialContextView, migrationPlan, migrationResult, events
    }
  });
}
