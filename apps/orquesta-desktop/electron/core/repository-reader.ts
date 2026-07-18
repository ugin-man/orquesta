import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  AgentUiModel,
  AgentUiStatus,
  AttentionUiItem,
  EvidenceLevel,
  OrquestaUiSnapshot,
  ProjectPhaseUiModel,
  RuntimeUiEvent,
  TaskUiModel,
  TaskUiState
} from '../../src/contracts/orquesta-ui';

type JsonObject = Record<string, unknown>;

export interface RepositoryDocuments {
  agents: unknown;
  tasks: unknown;
  sessions?: unknown;
  questions?: unknown;
  incidents?: unknown;
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

function projectAgents(
  rawAgents: JsonObject[],
  rawTasks: JsonObject[],
  tasksById: Map<string, TaskUiModel>,
  sessions: JsonObject[],
  now: Date
): AgentUiModel[] {
  const rawTaskById = new Map(rawTasks.flatMap((item) => string(item.task_id) ? [[string(item.task_id)!, item] as const] : []));
  const tasksByOwner = new Map<string, JsonObject[]>();
  for (const task of rawTasks) {
    const owner = string(task.owner_agent_id);
    if (!owner || !rawTaskIsCurrent(task)) continue;
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
    const session = sessionByAgent.get(id);
    const heartbeat = newestTimestamp([session?.last_seen, session?.updated_at, raw.last_heartbeat]);
    const fresh = isFresh(heartbeat, now) && (!session || ['active', 'working', 'ready'].includes(string(session.status) ?? ''));
    const rawStatus = string(raw.status) ?? 'unknown';
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
      status = 'assigned_waiting'; statusEvidence = 'reported';
    } else {
      status = 'unknown'; statusEvidence = 'unknown';
    }

    const role = string(raw.role) ?? 'specialist';
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
      displayName: string(raw.display_name) ?? string(raw.display_name_ja) ?? string(raw.display_name_en) ?? id,
      role,
      roleSummary: string(raw.role_summary) ?? string(raw.mission) ?? role.replaceAll('-', ' '),
      iconKey: roleIcon(role),
      status,
      statusLabel: statusLabel(status),
      statusEvidence,
      currentTaskId: currentTask?.id ?? null,
      currentTaskTitle: currentTask?.title ?? null,
      assignedByAgentId: id === 'orchestrator'
        ? 'user'
        : string(raw.organization_parent_agent_id) ?? string(raw.assigned_by_agent_id) ?? 'orchestrator',
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

function projectAttention(documents: RepositoryDocuments, rawTasks: JsonObject[], now: Date): AttentionUiItem[] {
  const questions = rows(documents.questions, 'questions')
    .filter((item) => !['answered', 'closed', 'resolved'].includes(string(item.status) ?? 'pending'))
    .flatMap((item) => {
      const id = string(item.question_id);
      return id ? [{
        id, type: 'question' as const, priority: priority(item.priority), title: 'Question',
        summary: string(item.question) ?? 'A user decision is waiting.', sourceAgentId: string(item.source_agent_id), taskId: string(item.source_task_id),
        blocking: Boolean(item.blocking), primaryActionLabel: 'Review', createdAt: string(item.created_at) ?? now.toISOString(), resolvedAt: null, resolutionLabel: null
      }] : [];
    });
  const incidents = rows(documents.incidents, 'incidents')
    .filter((item) => !['resolved', 'mitigated', 'closed'].includes(string(item.status) ?? 'open'))
    .flatMap((item) => {
      const id = string(item.incident_id);
      const userAction = item.user_action_required === true;
      return id ? [{
        id, type: userAction ? 'repair' as const : 'error' as const,
        priority: string(item.severity) === 'critical' ? 'blocker' as const : priority(item.severity),
        title: string(item.title) ?? 'Runtime incident', summary: string(item.current_action) ?? string(item.suspected_cause) ?? 'An unresolved incident is recorded.',
        sourceAgentId: string(item.source_agent_id), taskId: string(item.task_id), blocking: string(item.severity) === 'critical',
        primaryActionLabel: 'Inspect', createdAt: string(item.detected_at) ?? now.toISOString(), resolvedAt: null, resolutionLabel: null
      }] : [];
    });
  const taskItems = rawTasks
    .filter((item) => ['blocked', 'needs_orchestrator_review', 'needs_revision', 'changes_requested'].includes(string(item.state) ?? ''))
    .slice(-30)
    .reverse()
    .flatMap((item) => {
      const id = string(item.task_id);
      const state = string(item.state) ?? '';
      return id ? [{
        id: `task-${id}`, type: state === 'blocked' ? 'error' as const : state === 'changes_requested' ? 'direction' as const : 'report_review' as const,
        priority: state === 'blocked' ? 'high' as const : 'medium' as const,
        title: state === 'blocked' ? 'Blocked task' : 'Review required', summary: `${id} · ${string(item.title) ?? id}`,
        sourceAgentId: string(item.owner_agent_id), taskId: id, blocking: state === 'blocked', primaryActionLabel: 'Inspect',
        createdAt: newestTimestamp([item.updated_at, item.completed_at, item.started_at, item.created_at]) ?? now.toISOString(), resolvedAt: null, resolutionLabel: null
      }] : [];
    });
  return [...questions, ...incidents, ...taskItems];
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
  const agents = projectAgents(rawAgents, rawTasks, tasksById, sessions, now);
  const attention = projectAttention(documents, rawTasks, now);
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
    phases,
    recentEvents
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
  const sessionsPath = await confinedFile(root, path.join('.orquesta', 'state', 'sessions.json'));
  const questionsPath = await confinedFile(root, path.join('.orquesta', 'vision', 'questions.json'));
  const incidentsPath = await confinedFile(root, path.join('.orquesta', 'failures', 'incidents.json'));
  const eventsPath = await confinedFile(root, path.join('.orquesta', 'state', 'events.jsonl'));
  const [agents, tasks, sessions, questions, incidents, events] = await Promise.all([
    readBoundedJson(agentsPath, true),
    readBoundedJson(tasksPath, true),
    readBoundedJson(sessionsPath, false),
    readBoundedJson(questionsPath, false),
    readBoundedJson(incidentsPath, false),
    readEvents(eventsPath)
  ]);
  return projectSnapshotFromDocuments({ rootPath: root, now: options.now, documents: { agents, tasks, sessions, questions, incidents, events } });
}
