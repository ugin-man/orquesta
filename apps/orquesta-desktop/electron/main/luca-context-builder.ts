import type { InspectionReportUi } from '../../src/contracts/bridge';
import type { AskLucaInput, LucaQuestionId } from '../../src/contracts/luca';
import type {
  AgentUiModel,
  AttentionUiItem,
  FailureUiModel,
  InspectionRunUiModel,
  OrquestaUiSnapshot,
  RuntimeUiEvent,
  TaskUiModel
} from '../../src/contracts/orquesta-ui';
import { questionDefinition } from './luca-question-catalog';

export const LUCA_CONTEXT_LIMITS = Object.freeze({
  relatedTasks: 12,
  occurrences: 10,
  inspectionCharacters: 20_000,
  activeTasks: 10,
  blockedTasks: 10,
  completedTasks: 10,
  attention: 10,
  failures: 10,
  agents: 20,
  events: 20,
  inspections: 5
});

export interface LucaContextOptions {
  readInspectionReport(runId: string): Promise<InspectionReportUi>;
  lastHomeSeenAt: string | null;
}

export type LucaContextPacket = Record<string, unknown> & { kind: 'task' | 'failure' | 'inspection' | 'home' };

export class LucaContextNotFoundError extends Error {
  constructor(kind: string, id: string) {
    super(`Luca ${kind} context no longer exists: ${id}`);
    this.name = 'LucaContextNotFoundError';
  }
}

function capped<T>(items: T[], limit: number): { items: T[]; omittedCount: number } {
  return { items: items.slice(0, limit), omittedCount: Math.max(0, items.length - limit) };
}

function newest<T>(items: T[], value: (item: T) => string | null): T[] {
  return [...items].sort((left, right) => (value(right) ?? '').localeCompare(value(left) ?? ''));
}

function taskContext(id: string, snapshot: OrquestaUiSnapshot): LucaContextPacket {
  const task = snapshot.tasks.find((item) => item.id === id);
  if (!task) throw new LucaContextNotFoundError('task', id);
  const byId = new Map(snapshot.tasks.map((item) => [item.id, item]));
  const agentById = new Map(snapshot.agents.map((item) => [item.id, item]));
  return {
    kind: 'task',
    subject: task,
    owner: task.ownerAgentId ? agentById.get(task.ownerAgentId) ?? null : null,
    assignedBy: task.assignedByAgentId ? agentById.get(task.assignedByAgentId) ?? null : null,
    dependencies: capped(task.dependencies.flatMap((taskId) => byId.get(taskId) ?? []), LUCA_CONTEXT_LIMITS.relatedTasks),
    dependents: capped(snapshot.tasks.filter((candidate) => candidate.dependencies.includes(id)), LUCA_CONTEXT_LIMITS.relatedTasks),
    attention: capped(snapshot.attention.filter((item) => item.taskId === id && item.resolvedAt === null), LUCA_CONTEXT_LIMITS.attention),
    failures: capped(newest(snapshot.failures.filter((failure) => failure.taskIds.includes(id)), (failure) => failure.lastOccurredAt), LUCA_CONTEXT_LIMITS.failures)
  };
}

function failureContext(id: string, snapshot: OrquestaUiSnapshot): LucaContextPacket {
  const failure = snapshot.failures.find((item) => item.id === id);
  if (!failure) throw new LucaContextNotFoundError('failure', id);
  const { occurrences, ...subject } = failure;
  const taskIds = new Set(failure.taskIds);
  const agentIds = new Set(failure.sourceAgentIds);
  return {
    kind: 'failure',
    subject,
    occurrences: capped(newest(occurrences, (occurrence) => occurrence.occurredAt), LUCA_CONTEXT_LIMITS.occurrences),
    relatedTasks: capped(snapshot.tasks.filter((task) => taskIds.has(task.id)), LUCA_CONTEXT_LIMITS.relatedTasks),
    sourceAgents: capped(snapshot.agents.filter((agent) => agentIds.has(agent.id)), LUCA_CONTEXT_LIMITS.agents)
  };
}

async function inspectionContext(id: string, snapshot: OrquestaUiSnapshot, options: LucaContextOptions): Promise<LucaContextPacket> {
  const run = snapshot.inspectionRuns.find((item) => item.runId === id);
  if (!run) throw new LucaContextNotFoundError('inspection', id);
  let reportMarkdown: string | null = null;
  let truncated = false;
  if (run.reportPath) {
    const report = await options.readInspectionReport(id);
    reportMarkdown = report.markdown.slice(0, LUCA_CONTEXT_LIMITS.inspectionCharacters);
    truncated = report.markdown.length > LUCA_CONTEXT_LIMITS.inspectionCharacters;
  }
  return {
    kind: 'inspection',
    subject: run,
    reportMarkdown,
    truncated,
    targetAgents: run.target.kind === 'agents'
      ? capped(snapshot.agents.filter((agent) => run.target.ids.includes(agent.id)), LUCA_CONTEXT_LIMITS.agents)
      : capped<AgentUiModel>([], LUCA_CONTEXT_LIMITS.agents)
  };
}

const ACTIVE_TASK_STATES = new Set(['assigned', 'dispatch_accepted', 'turn_started', 'in_progress']);
const COMPLETED_TASK_STATES = new Set(['report_ready', 'needs_review', 'accepted']);

function taskTime(task: TaskUiModel): string | null {
  return task.updatedAt ?? task.startedAt;
}

function failureTime(failure: FailureUiModel): string | null {
  return failure.lastOccurredAt ?? failure.firstOccurredAt;
}

function eventTime(event: RuntimeUiEvent): string | null {
  return event.createdAt;
}

function inspectionTime(run: InspectionRunUiModel): string | null {
  return run.completedAt ?? run.createdAt;
}

function openAttention(items: AttentionUiItem[]): AttentionUiItem[] {
  return items.filter((item) => item.resolvedAt === null);
}

function homeContext(questionId: LucaQuestionId, snapshot: OrquestaUiSnapshot, lastHomeSeenAt: string | null): LucaContextPacket {
  const active = newest(snapshot.tasks.filter((task) => ACTIVE_TASK_STATES.has(task.state)), taskTime);
  const blocked = newest(snapshot.tasks.filter((task) => task.state === 'blocked'), taskTime);
  const completed = newest(snapshot.tasks.filter((task) => COMPLETED_TASK_STATES.has(task.state)), taskTime);
  const queued = newest(snapshot.tasks.filter((task) => task.state === 'queued'), taskTime);
  const attention = newest(openAttention(snapshot.attention), (item) => item.createdAt);
  const failures = newest(snapshot.failures, failureTime);
  const events = newest(snapshot.recentEvents, eventTime);
  const inspections = newest(snapshot.inspectionRuns, inspectionTime);
  const agents = snapshot.agents.filter((agent) => agent.lifecycleState !== 'retired' && agent.lifecycleState !== 'superseded');
  const phase = snapshot.phases.find((item) => item.id === snapshot.project.currentPhaseId) ?? null;
  const base: LucaContextPacket = { kind: 'home', questionId, project: snapshot.project };
  const taskList = (items: TaskUiModel[], limit: number) => capped(items, limit);
  const attentionList = (items: AttentionUiItem[]) => capped(items, LUCA_CONTEXT_LIMITS.attention);
  const failureList = (items: FailureUiModel[]) => capped(items, LUCA_CONTEXT_LIMITS.failures);

  switch (questionId) {
    case 'home.current':
      return { ...base, currentPhase: phase, activeTasks: taskList(active, LUCA_CONTEXT_LIMITS.activeTasks), attention: attentionList(attention), recentEvents: capped(events, LUCA_CONTEXT_LIMITS.events) };
    case 'home.active':
      return { ...base, activeTasks: taskList(active, LUCA_CONTEXT_LIMITS.activeTasks) };
    case 'home.blocked':
      return { ...base, blockedTasks: taskList(blocked, LUCA_CONTEXT_LIMITS.blockedTasks), blockingAttention: attentionList(attention.filter((item) => item.blocking)), openFailures: failureList(failures.filter((failure) => failure.resolution !== 'resolved')) };
    case 'home.completed':
      return { ...base, completedTasks: taskList(completed, LUCA_CONTEXT_LIMITS.completedTasks) };
    case 'home.next':
      return { ...base, nextMilestone: snapshot.project.nextMilestone, queuedTasks: taskList(queued, LUCA_CONTEXT_LIMITS.activeTasks) };
    case 'home.user-review':
      return { ...base, userItems: attentionList(attention.filter((item) => item.actionKind === 'review')) };
    case 'home.user-answer':
      return { ...base, userItems: attentionList(attention.filter((item) => item.actionKind === 'answer')) };
    case 'home.user-decision':
      return { ...base, userItems: attentionList(attention.filter((item) => item.actionKind === 'approve' || item.type === 'direction')) };
    case 'home.overlooked':
      return { ...base, attention: attentionList(attention), blockedTasks: taskList(blocked, LUCA_CONTEXT_LIMITS.blockedTasks), openFailures: failureList(failures.filter((failure) => failure.resolution !== 'resolved')) };
    case 'home.project':
      return { ...base, currentPhase: phase, setup: snapshot.setup ?? null };
    case 'home.phase':
      return { ...base, currentPhase: phase, phases: capped(snapshot.phases, 12) };
    case 'home.changed': {
      const newerThan = (value: string | null) => Boolean(lastHomeSeenAt && value && value > lastHomeSeenAt);
      return {
        ...base,
        comparisonBaseline: lastHomeSeenAt,
        changedTasks: taskList(newest(snapshot.tasks.filter((task) => newerThan(taskTime(task))), taskTime), LUCA_CONTEXT_LIMITS.activeTasks),
        changedFailures: failureList(failures.filter((failure) => newerThan(failureTime(failure)))),
        changedEvents: capped(events.filter((event) => newerThan(eventTime(event))), LUCA_CONTEXT_LIMITS.events)
      };
    }
    case 'home.organization':
      return { ...base, organization: snapshot.organization ?? null, agents: capped(agents, LUCA_CONTEXT_LIMITS.agents) };
    case 'home.health':
      return { ...base, currentPhase: phase, activeTasks: taskList(active, LUCA_CONTEXT_LIMITS.activeTasks), blockedTasks: taskList(blocked, LUCA_CONTEXT_LIMITS.blockedTasks), openFailures: failureList(failures.filter((failure) => failure.resolution !== 'resolved')), attention: attentionList(attention) };
    case 'home.recent-errors':
      return { ...base, failures: failureList(failures) };
    case 'home.repeated':
      return { ...base, repeatedFailures: failureList(failures.filter((failure) => failure.occurrenceCount > 1)) };
    case 'home.bottleneck':
      return { ...base, blockedTasks: taskList(blocked, LUCA_CONTEXT_LIMITS.blockedTasks), openFailures: failureList(failures.filter((failure) => failure.resolution !== 'resolved')), attention: attentionList(attention.filter((item) => item.blocking)) };
    case 'home.custom':
      return {
        ...base,
        currentPhase: phase,
        activeTasks: taskList(active, LUCA_CONTEXT_LIMITS.activeTasks),
        blockedTasks: taskList(blocked, LUCA_CONTEXT_LIMITS.blockedTasks),
        completedTasks: taskList(completed, LUCA_CONTEXT_LIMITS.completedTasks),
        attention: attentionList(attention),
        failures: failureList(failures),
        agents: capped(agents, LUCA_CONTEXT_LIMITS.agents),
        recentEvents: capped(events, LUCA_CONTEXT_LIMITS.events),
        inspections: capped(inspections, LUCA_CONTEXT_LIMITS.inspections),
        organization: snapshot.organization ?? null,
        setup: snapshot.setup ?? null
      };
    default:
      throw new Error(`Unsupported Luca Home question: ${questionId}`);
  }
}

export async function buildLucaContext(
  input: AskLucaInput,
  snapshot: OrquestaUiSnapshot,
  options: LucaContextOptions
): Promise<LucaContextPacket> {
  const definition = questionDefinition(input.questionId);
  if (definition.contextKind !== input.context.kind) throw new Error('Luca question does not match context kind');
  if (input.context.kind === 'task') return taskContext(input.context.id, snapshot);
  if (input.context.kind === 'failure') return failureContext(input.context.id, snapshot);
  if (input.context.kind === 'inspection') return inspectionContext(input.context.id, snapshot, options);
  return homeContext(input.questionId, snapshot, options.lastHomeSeenAt);
}
