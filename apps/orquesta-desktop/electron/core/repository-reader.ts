import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { emptyV4OperationsSnapshot, type
  AgentUiModel,
  AgentUiStatus,
  AttentionUiItem,
  EvidenceLevel,
  FailureOccurrenceUi,
  FailureUiModel,
  FailureUiResolution,
  FailureUiSeverity,
  OrganizationUiSnapshot,
  OrquestaUiSnapshot,
  ProjectPhaseUiModel,
  RuntimeUiEvent,
  SetupActivityUiModel,
  SetupPhaseUiModel,
  SetupUiSnapshot,
  TaskUiModel,
  TaskUiState
} from '../../src/contracts/orquesta-ui';

type JsonObject = Record<string, unknown>;

export interface RepositoryDocuments {
  agents: unknown;
  tasks: unknown;
  roles?: unknown;
  organization?: unknown;
  setupState?: unknown;
  provisioningBatch?: unknown;
  sessions?: unknown;
  questions?: unknown;
  userTasks?: unknown;
  userActions?: unknown;
  dashboardActions?: unknown;
  incidents?: unknown;
  incidentCandidates?: unknown;
  incidentClusters?: unknown;
  events?: unknown[];
}

export interface SnapshotProjectionInput {
  rootPath: string;
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

function stringList(value: unknown): string[] {
  const single = string(value);
  return single ? [single] : stringArray(value);
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
  const normalized = path.resolve(rootPath).replaceAll('\\', '/').toLowerCase();
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
  const dispatchAccepted = handoffs.some((item) => ['accepted', 'started', 'handoff_sent', 'report_produced'].includes(
    string(item.dispatch_status) ?? string(item.status) ?? string(item.result) ?? ''
  ));
  const turnStarted = rawState === 'turn_started' || Boolean(string(raw.turn_started_at))
    || handoffs.some((item) => ['confirmed', 'verified'].includes(string(item.turn_start_status) ?? ''))
    || cycles.some((item) => Boolean(string(item.turn_started_at)));
  const progressObserved = progressEventObserved || raw.progress_observed === true || Boolean(string(raw.progress_summary))
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
    title: string(raw.title) ?? id,
    state: taskState(rawState),
    ownerAgentId,
    assignedByAgentId,
    dependencies: stringArray(raw.dependencies),
    blockedBy: stringArray(raw.blocked_by),
    routingClass: string(raw.routing_class),
    handoffSent: Boolean(string(raw.handoff_sent_at) || handoffs.length),
    dispatchAccepted,
    turnStarted,
    progressObserved,
    progressSummary: string(raw.progress_summary) ?? string(raw.result_summary),
    progressPercent: typeof raw.progress_percent === 'number' && Number.isFinite(raw.progress_percent) ? raw.progress_percent : null,
    reportStatus: reportPath ? (REVIEW_TASK_STATES.has(rawState) ? rawState : 'available') : null,
    reportPath,
    expectedArtifact: string(raw.expected_artifact) ?? string(raw.task_context && object(raw.task_context)?.expected_artifact),
    acceptanceChecks: stringArray(raw.acceptance_checks),
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

function statusLabel(status: AgentUiStatus): string {
  switch (status) {
    case 'working': return 'Working';
    case 'assigned_waiting': return 'Assigned · waiting';
    case 'standby': return 'Idle';
    case 'approval_wait': return 'Approval wait';
    case 'blocked': return 'Blocked';
    case 'stale': return 'Stale evidence';
    case 'report_ready': return 'Report ready';
    default: return 'Unknown';
  }
}

interface ExplicitOrganizationProjection {
  snapshot: OrganizationUiSnapshot;
  agentById: Map<string, JsonObject>;
  membershipByAgentId: Map<string, JsonObject>;
  teamById: Map<string, JsonObject>;
  parentByAgentId: Map<string, string>;
  roleById: Map<string, JsonObject>;
}

function projectOrganization(documents: RepositoryDocuments): ExplicitOrganizationProjection {
  const organization = object(documents.organization);
  if (organization && organization.schema_version === 2 && Number.isInteger(organization.revision)) {
    const organizationAgents = rows(organization, 'agents');
    const memberships = rows(organization, 'memberships').filter((item) => item.active_to === null || item.active_to === undefined);
    const teams = rows(organization, 'teams');
    const relationships = rows(organization, 'relationships').filter((item) => string(item.type) === 'reports_to');
    return {
      snapshot: { revision: Number(organization.revision), source: 'explicit', diagnostics: [] },
      agentById: new Map(organizationAgents.flatMap((item) => string(item.agent_id) ? [[string(item.agent_id)!, item] as const] : [])),
      membershipByAgentId: new Map(memberships.flatMap((item) => string(item.agent_id) ? [[string(item.agent_id)!, item] as const] : [])),
      teamById: new Map(teams.flatMap((item) => string(item.team_id) ? [[string(item.team_id)!, item] as const] : [])),
      parentByAgentId: new Map(relationships.flatMap((item) => {
        const from = string(item.from_agent_id);
        const to = string(item.to_agent_id);
        return from && to ? [[from, to] as const] : [];
      })),
      roleById: new Map(rows(documents.roles, 'roles').flatMap((item) => string(item.role_id) ? [[string(item.role_id)!, item] as const] : []))
    };
  }
  return {
    snapshot: { revision: 0, source: 'legacy', diagnostics: ['legacy_inferred_organization'] },
    agentById: new Map(),
    membershipByAgentId: new Map(),
    teamById: new Map(),
    parentByAgentId: new Map(),
    roleById: new Map()
  };
}

function projectAgents(
  rawAgents: JsonObject[],
  rawTasks: JsonObject[],
  tasksById: Map<string, TaskUiModel>,
  sessions: JsonObject[],
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
  const sessionByAgent = new Map(sessions.flatMap((item) => string(item.agent_id) ? [[string(item.agent_id)!, item] as const] : []));

  return rawAgents.flatMap((raw) => {
    const id = string(raw.agent_id);
    if (!id) return [];
    const declaredTaskId = string(raw.current_task);
    const declaredTask = declaredTaskId ? rawTaskById.get(declaredTaskId) : undefined;
    const validDeclaredTask = declaredTask && string(declaredTask.owner_agent_id) === id && rawTaskIsCurrent(declaredTask) ? declaredTask : undefined;
    const fallbackTask = [...(tasksByOwner.get(id) ?? [])].sort((left, right) =>
      dateValue(newestTimestamp([right.updated_at, right.completed_at, right.started_at, right.created_at]))
      - dateValue(newestTimestamp([left.updated_at, left.completed_at, left.started_at, left.created_at])))[0];
    const currentRawTask = validDeclaredTask ?? fallbackTask;
    const currentTaskId = currentRawTask ? string(currentRawTask.task_id) : null;
    const currentTask = currentTaskId ? tasksById.get(currentTaskId) : undefined;
    const organizationAgent = organization.agentById.get(id);
    const membership = organization.membershipByAgentId.get(id);
    const teamId = string(membership?.team_id) ?? string(raw.team_id);
    const team = teamId ? organization.teamById.get(teamId) : undefined;
    const organizationParentAgentId = organization.parentByAgentId.get(id)
      ?? string(raw.organization_parent_agent_id)
      ?? (id === 'orchestrator' ? 'user' : null);
    const session = sessionByAgent.get(id);
    const heartbeat = newestTimestamp([session?.last_seen, session?.updated_at, raw.last_heartbeat]);
    const fresh = isFresh(heartbeat, now) && (!session || ['active', 'working', 'ready'].includes(string(session.status) ?? ''));
    const rawStatus = string(organizationAgent?.operational_status) ?? string(raw.operational_status) ?? string(raw.status) ?? 'unknown';
    let status: AgentUiStatus;
    let statusEvidence: EvidenceLevel;

    if (currentTask?.state === 'blocked' || rawStatus === 'blocked') {
      status = 'blocked'; statusEvidence = 'proven';
    } else if (currentTask && ['report_ready', 'needs_review'].includes(currentTask.state)) {
      status = 'report_ready'; statusEvidence = 'proven';
    } else if (rawStatus === 'approval_wait' || currentTask?.state === 'approval_wait') {
      status = 'approval_wait'; statusEvidence = 'reported';
    } else if (currentTask?.turnStarted && fresh) {
      status = 'working'; statusEvidence = 'proven';
    } else if (currentTask?.turnStarted && !fresh) {
      status = 'stale'; statusEvidence = 'reported';
    } else if (currentTask?.dispatchAccepted || currentTask?.handoffSent) {
      status = 'assigned_waiting'; statusEvidence = 'reported';
    } else if (['standby', 'idle'].includes(rawStatus)) {
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
    const delegatedByAgentId = string(currentRawTask?.assigned_by_agent_id) ?? string(raw.delegated_by_agent_id) ?? string(raw.assigned_by_agent_id);
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
      displayName: string(raw.display_name) ?? string(raw.display_name_ja) ?? string(raw.display_name_en) ?? string(roleNames?.ja) ?? string(roleNames?.en) ?? id,
      role,
      roleSummary: string(raw.role_summary) ?? string(raw.mission) ?? role.replaceAll('-', ' '),
      iconKey: roleIcon(role),
      status,
      statusLabel: statusLabel(status),
      statusEvidence,
      currentTaskId: currentTask?.id ?? null,
      currentTaskTitle: currentTask?.title ?? null,
      assignedByAgentId: organizationParentAgentId ?? (id === 'orchestrator' ? 'user' : string(raw.assigned_by_agent_id) ?? 'orchestrator'),
      roleId,
      teamId,
      lineId: string(team?.line_id) ?? string(raw.line_id),
      position: ['member', 'lead'].includes(string(membership?.position) ?? '') ? string(membership?.position) as 'member' | 'lead' : null,
      organizationParentAgentId,
      delegatedByAgentId,
      organizationScope: ['project', 'line'].includes(string(organizationAgent?.organization_scope) ?? string(raw.organization_scope) ?? '')
        ? (string(organizationAgent?.organization_scope) ?? string(raw.organization_scope)) as 'project' | 'line'
        : null,
      lifecycleState: ['proposed', 'provisioning', 'active', 'retired', 'superseded'].includes(string(organizationAgent?.lifecycle_state) ?? string(raw.lifecycle_state) ?? '')
        ? (string(organizationAgent?.lifecycle_state) ?? string(raw.lifecycle_state)) as AgentUiModel['lifecycleState']
        : null,
      operationalStatus: string(organizationAgent?.operational_status) ?? string(raw.operational_status),
      organizationRevision: organization.snapshot.source === 'explicit'
        ? organization.snapshot.revision
        : typeof raw.organization_revision === 'number' && Number.isInteger(raw.organization_revision) ? raw.organization_revision : null,
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

function dashboardActionKind(type: string): AttentionUiItem['actionKind'] {
  if (type === 'fallback_approval' || type === 'wake_defer') return 'approve';
  if (type === 'report_review' || type === 'model_route_review' || type === 'incident_review') return 'review';
  return 'do';
}

function actionAttentionType(kind: AttentionUiItem['actionKind']): AttentionUiItem['type'] {
  if (kind === 'answer') return 'question';
  if (kind === 'approve') return 'approval';
  if (kind === 'review') return 'report_review';
  return 'direction';
}

function attentionId(source: 'question' | 'user-task' | 'user-action' | 'dashboard-action' | 'incident', canonicalId: string): string {
  return `${source}:${canonicalId}`;
}

function projectAttention(documents: RepositoryDocuments, now: Date): AttentionUiItem[] {
  const questions = rows(documents.questions, 'questions')
    .filter((item) => actionIsOpen(item.status))
    .flatMap((item) => {
      const id = string(item.question_id) ?? string(item.id);
      return id ? [{
        id: attentionId('question', id), type: 'question' as const, actionKind: 'answer' as const, priority: priority(item.priority), title: string(item.title) ?? 'Question',
        summary: string(item.question) ?? 'A user decision is waiting.', sourceAgentId: string(item.source_agent_id), taskId: string(item.source_task_id) ?? string(item.task_id),
        blocking: Boolean(item.blocking), primaryActionLabel: 'Review', createdAt: string(item.created_at) ?? now.toISOString(), resolvedAt: null, resolutionLabel: null
      }] : [];
    });
  const incidents = rows(documents.incidents, 'incidents')
    .filter((item) => actionIsOpen(item.status) && item.user_action_required === true)
    .flatMap((item) => {
      const id = string(item.incident_id);
      return id ? [{
        id: attentionId('incident', id), type: 'repair' as const, actionKind: 'do' as const,
        priority: string(item.severity) === 'critical' ? 'blocker' as const : priority(item.severity),
        title: string(item.title) ?? 'Runtime incident', summary: string(item.current_action) ?? string(item.suspected_cause) ?? 'An unresolved incident is recorded.',
        sourceAgentId: string(item.source_agent_id), taskId: string(item.task_id), blocking: string(item.severity) === 'critical',
        primaryActionLabel: 'Inspect', createdAt: string(item.detected_at) ?? now.toISOString(), resolvedAt: null, resolutionLabel: null
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
        type: actionAttentionType(kind),
        actionKind: kind,
        priority: priority(item.priority),
        title: string(item.title) ?? 'User task',
        summary: string(item.prompt) ?? string(item.requested_action) ?? string(item.resume_instruction) ?? 'A user action is waiting.',
        sourceAgentId: string(item.source_agent_id) ?? string(item.support_agent_id),
        taskId: stringArray(item.source_ids)[0] ?? null,
        blocking: source === 'approval_wait',
        primaryActionLabel: kind === 'approve' ? 'Review request' : kind === 'review' ? 'Review' : 'Open',
        createdAt: string(item.created_at) ?? now.toISOString(),
        resolvedAt: null,
        resolutionLabel: null
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
        type: 'repair' as const,
        actionKind: 'do' as const,
        priority: priority(item.priority ?? item.risk),
        title: string(item.title) ?? 'Repair action',
        summary: string(item.why_this_helps) ?? steps[0] ?? 'A user-side repair is ready.',
        sourceAgentId: string(item.source_agent_id) ?? 'user-support',
        taskId: string(item.task_id),
        blocking: item.requires_user_approval === true,
        primaryActionLabel: 'Open',
        createdAt: string(item.created_at) ?? now.toISOString(),
        resolvedAt: null,
        resolutionLabel: null
      }];
    });
  const dashboardActions = rows(documents.dashboardActions, 'actions')
    .filter((item) => actionIsOpen(item.status))
    .flatMap((item) => {
      const id = string(item.action_id);
      if (!id) return [];
      const type = string(item.type) ?? 'dashboard_action';
      const kind = dashboardActionKind(type);
      const payload = object(item.payload);
      return [{
        id: attentionId('dashboard-action', id),
        type: actionAttentionType(kind),
        actionKind: kind,
        priority: priority(item.priority ?? payload?.priority),
        title: string(payload?.title) ?? type.replaceAll('_', ' '),
        summary: string(payload?.summary) ?? string(payload?.reason) ?? 'A recorded dashboard action is waiting.',
        sourceAgentId: string(item.agent_id),
        taskId: string(item.task_id),
        blocking: kind === 'approve',
        primaryActionLabel: kind === 'approve' ? 'Review request' : 'Review',
        createdAt: string(item.created_at) ?? now.toISOString(),
        resolvedAt: null,
        resolutionLabel: null
      }];
    });
  const projected = [...questions, ...userTasks, ...userActions, ...dashboardActions, ...incidents];
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

const SETUP_PHASE_LABELS: Record<string, { title: string; summary: string }> = {
  environment: { title: 'Environment', summary: 'Confirm the selected project and required runtime.' },
  understanding: { title: 'Understanding', summary: 'Read bounded project evidence and build the project understanding.' },
  foundation: { title: 'Foundation', summary: 'Create the three project-wide foundation agents.' },
  planning: { title: 'Planning', summary: 'Build the Completion Map and first executable work.' },
  specialists: { title: 'Specialists', summary: 'Form the initial teams and provision their Codex tasks.' },
  operation: { title: 'Operation', summary: 'Confirm operational state and open the Home screen.' }
};

function setupStatus(value: unknown): SetupUiSnapshot['status'] {
  const normalized = string(value) ?? 'preparing';
  if (normalized === 'completed' || normalized === 'ready' || normalized === 'ready_for_operation') return 'completed';
  if (normalized === 'blocked' || normalized === 'failed') return 'blocked';
  if (normalized === 'paused') return 'paused';
  if (normalized === 'cancelled') return 'cancelled';
  if (normalized === 'running' || normalized === 'provisioning' || normalized === 'in_progress') return 'running';
  return 'preparing';
}

function setupActivity(value: unknown, fallbackId: string, fallbackStatus: SetupActivityUiModel['status']): SetupActivityUiModel | null {
  const raw = object(value);
  if (!raw) return null;
  return {
    id: string(raw.id) ?? string(raw.activity_id) ?? fallbackId,
    title: string(raw.title) ?? string(raw.label) ?? fallbackId,
    detail: string(raw.detail) ?? string(raw.summary) ?? '',
    status: ['complete', 'active', 'waiting', 'failed'].includes(string(raw.status) ?? '')
      ? string(raw.status) as SetupActivityUiModel['status']
      : fallbackStatus,
    observedAt: string(raw.observed_at) ?? string(raw.updated_at) ?? string(raw.created_at)
  };
}

function projectSetup(documents: RepositoryDocuments, rootPath: string, now: Date): SetupUiSnapshot | null {
  const state = object(documents.setupState);
  if (!state) return null;
  const status = setupStatus(state.status);
  const rawPhases = Array.isArray(state.phases) ? state.phases : [];
  const phaseIds = rawPhases.map((phase) => string(phase) ?? string(object(phase)?.id) ?? string(object(phase)?.phase_id)).filter((id): id is string => Boolean(id));
  const normalizedPhaseIds = phaseIds.length === 6 ? phaseIds : Object.keys(SETUP_PHASE_LABELS);
  const currentPhaseId = string(state.current_phase) ?? string(state.currentPhaseId) ?? null;
  const currentIndex = currentPhaseId ? normalizedPhaseIds.indexOf(currentPhaseId) : -1;
  const phases: SetupPhaseUiModel[] = normalizedPhaseIds.map((id, index) => {
    const raw = object(rawPhases[index]);
    const explicit = string(raw?.status);
    let phaseStatus: SetupPhaseUiModel['status'];
    if (['complete', 'completed', 'done'].includes(explicit ?? '') || status === 'completed' || (currentIndex >= 0 && index < currentIndex)) phaseStatus = 'complete';
    else if (['blocked', 'failed'].includes(explicit ?? '') || (status === 'blocked' && id === currentPhaseId)) phaseStatus = 'blocked';
    else if (['active', 'running', 'in_progress'].includes(explicit ?? '') || id === currentPhaseId) phaseStatus = 'active';
    else phaseStatus = 'waiting';
    return {
      id,
      order: index + 1,
      title: string(raw?.title) ?? SETUP_PHASE_LABELS[id]?.title ?? id,
      summary: string(raw?.summary) ?? SETUP_PHASE_LABELS[id]?.summary ?? '',
      status: phaseStatus
    };
  });
  const batch = object(documents.provisioningBatch);
  const requests = rows(batch, 'requests');
  const failedRequests = requests.filter((request) => string(request.status) === 'provisioning_failed');
  const currentPhase = phases.find((phase) => phase.id === currentPhaseId) ?? null;
  const currentActivity = setupActivity(state.current_activity, `setup-${currentPhaseId ?? 'preparing'}`, 'active')
    ?? (currentPhase ? { id: `phase-${currentPhase.id}`, title: currentPhase.title, detail: currentPhase.summary, status: currentPhase.status === 'blocked' ? 'failed' : 'active', observedAt: string(state.updated_at) } : null);
  const recentActivities = (Array.isArray(state.recent_activities) ? state.recent_activities : [])
    .flatMap((activity, index) => setupActivity(activity, `recent-${index}`, 'complete') ?? [])
    .slice(0, 16);
  const nextPhase = phases.find((phase) => phase.status === 'waiting') ?? null;
  const nextActivity = setupActivity(state.next_activity, 'setup-next', 'waiting')
    ?? (nextPhase ? { id: `phase-${nextPhase.id}`, title: nextPhase.title, detail: nextPhase.summary, status: 'waiting', observedAt: null } : null);
  return {
    status,
    projectTitle: string(state.project_title) ?? string(object(state.project_understanding)?.goal) ?? path.basename(rootPath),
    projectRootLabel: path.resolve(rootPath),
    currentPhaseId,
    startedAt: string(state.started_at) ?? string(state.created_at) ?? string(state.updated_at) ?? now.toISOString(),
    updatedAt: string(state.updated_at) ?? string(state.created_at) ?? now.toISOString(),
    phases,
    currentActivity,
    recentActivities,
    nextActivity,
    technicalDetails: [
      ...(string(batch?.provisioning_batch_id) ? [{ id: 'provisioning-batch', label: 'Provisioning batch', value: string(batch?.provisioning_batch_id)!, tone: 'neutral' as const }] : []),
      ...(requests.length ? [{ id: 'provisioning-progress', label: 'Specialist requests', value: `${requests.filter((request) => ['accepted', 'reuse_ready'].includes(string(request.status) ?? '')).length}/${requests.length}`, tone: failedRequests.length ? 'warning' as const : 'neutral' as const }] : []),
      ...(failedRequests.length ? [{ id: 'provisioning-failures', label: 'Provisioning failures', value: String(failedRequests.length), tone: 'danger' as const }] : [])
    ],
    canCancel: status === 'running' || status === 'preparing'
  };
}

export function projectSnapshotFromDocuments({ rootPath, documents, now = new Date() }: SnapshotProjectionInput): OrquestaUiSnapshot {
  const rawAgents = rows(documents.agents, 'agents', true);
  const rawTasks = rows(documents.tasks, 'tasks', true);
  const sessions = rows(documents.sessions, 'sessions');
  const progressedTaskIds = new Set((documents.events ?? []).flatMap((item) => {
    const event = object(item);
    const type = string(event?.type) ?? '';
    const taskId = string(event?.task_id);
    return taskId && /progress|completed|accepted/u.test(type) ? [taskId] : [];
  }));
  const tasks = rawTasks.flatMap((task) => mapTask(task, progressedTaskIds.has(string(task.task_id) ?? '')) ?? []);
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const organization = projectOrganization(documents);
  const agents = projectAgents(rawAgents, rawTasks, tasksById, sessions, organization, now);
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

  return {
    project: {
      id: stableProjectId(rootPath),
      title: path.basename(path.resolve(rootPath)) || rootPath,
      rootPathLabel: path.resolve(rootPath),
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
    tasks,
    attention,
    failures,
    phases,
    recentEvents,
    v4Operations: emptyV4OperationsSnapshot(),
    organization: organization.snapshot,
    setup: projectSetup(documents, rootPath, now)
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

export async function readRepositorySnapshot(rootPath: string, options: { now?: Date } = {}): Promise<OrquestaUiSnapshot> {
  const root = await realpath(path.resolve(rootPath));
  const agentsPath = await confinedFile(root, path.join('.orquesta', 'state', 'agents.json'));
  const tasksPath = await confinedFile(root, path.join('.orquesta', 'state', 'tasks.json'));
  const rolesPath = await confinedFile(root, path.join('.orquesta', 'state', 'roles.json'));
  const organizationPath = await confinedFile(root, path.join('.orquesta', 'state', 'organization.json'));
  const sessionsPath = await confinedFile(root, path.join('.orquesta', 'state', 'sessions.json'));
  const questionsPath = await confinedFile(root, path.join('.orquesta', 'vision', 'questions.json'));
  const userTasksPath = await confinedFile(root, path.join('.orquesta', 'user_tasks', 'queue.json'));
  const userActionsPath = await confinedFile(root, path.join('.orquesta', 'failures', 'user_actions.json'));
  const dashboardActionsPath = await confinedFile(root, path.join('.orquesta', 'state', 'dashboard_actions.json'));
  const incidentsPath = await confinedFile(root, path.join('.orquesta', 'failures', 'incidents.json'));
  const incidentCandidatesPath = await confinedFile(root, path.join('.orquesta', 'failures', 'incident_candidates.json'));
  const incidentClustersPath = await confinedFile(root, path.join('.orquesta', 'failures', 'incident_clusters.json'));
  const eventsPath = await confinedFile(root, path.join('.orquesta', 'state', 'events.jsonl'));
  const setupStatePath = await confinedFile(root, path.join('.orquesta', 'setup', 'setup_state.json'));
  const provisioningBatchPath = await confinedFile(root, path.join('.orquesta', 'setup', 'provisioning_batch.json'));
  const [agents, tasks, roles, organization, sessions, questions, userTasks, userActions, dashboardActions, incidents, incidentCandidates, incidentClusters, setupState, provisioningBatch, events] = await Promise.all([
    readBoundedJson(agentsPath, true),
    readBoundedJson(tasksPath, true),
    readBoundedJson(rolesPath, false),
    readBoundedJson(organizationPath, false),
    readBoundedJson(sessionsPath, false),
    readBoundedJson(questionsPath, false),
    readBoundedJson(userTasksPath, false),
    readBoundedJson(userActionsPath, false),
    readBoundedJson(dashboardActionsPath, false),
    readBoundedJson(incidentsPath, false),
    readBoundedJson(incidentCandidatesPath, false),
    readBoundedJson(incidentClustersPath, false),
    readBoundedJson(setupStatePath, false),
    readBoundedJson(provisioningBatchPath, false),
    readEvents(eventsPath)
  ]);
  return projectSnapshotFromDocuments({
    rootPath: root,
    now: options.now,
    documents: { agents, tasks, roles, organization, sessions, questions, userTasks, userActions, dashboardActions, incidents, incidentCandidates, incidentClusters, setupState, provisioningBatch, events }
  });
}
