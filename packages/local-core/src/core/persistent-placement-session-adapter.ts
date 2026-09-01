import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import type { AgentV3, PlacementTaskV3, SessionBindingV1 } from '@orquesta/contracts';
import { validateContract } from '@orquesta/contracts';
import executionKernel from '@orquesta/execution-kernel';
import type { DesktopCodexService } from './desktop-codex-service';
import {
  readRuntimeBindingEvidence,
  type RuntimeBindingEvidence
} from './runtime-binding-store';
import {
  SessionBindingStore,
  type SessionBindingMutationResult,
  type SessionBindingReadResult
} from './session-binding-store';

const IDENTIFIER_128 = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const IDENTIFIER_256 = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const PLACEMENT_INTENT_ID = /^PI-[a-f0-9]{12}$/u;

type AcceptedPlacementBinding = {
  status: 'accepted';
  agent_id: string;
  thread_id: string;
  session_id: string;
  accepted_at: string;
};

type PlacementRuntime = Pick<DesktopCodexService, 'sendMessage'>;
type PlacementSessionStore = Pick<
  SessionBindingStore,
  'read' | 'findAcceptedPlacementBinding' | 'upsertAcceptedPersistentBinding'
>;

export interface PersistentPlacementSessionAdapterOptions {
  rootPath: string;
  projectId: string;
  runtime: PlacementRuntime;
  now?: () => Date;
  sessionStore?: PlacementSessionStore;
  runtimeEvidence?: RuntimeBindingEvidence;
  readRuntimeEvidence?: typeof readRuntimeBindingEvidence;
}

export interface FindAcceptedPlacementInput {
  projectId: string;
  placementIntentId: string;
  taskId: string;
  agentId: string;
  requestId: string;
}

export interface ProvisionPersistentPlacementInput {
  projectId: string;
  placementIntentId: string;
  requestId: string;
  task: PlacementTaskV3;
  agent: AgentV3;
}

export class PersistentPlacementSessionError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PersistentPlacementSessionError';
    this.code = code;
  }
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new PersistentPlacementSessionError(code, message, cause === undefined ? undefined : { cause });
}

function exactKeys(input: object, expected: readonly string[], label: string): void {
  const observed = Object.keys(input).sort();
  const required = [...expected].sort();
  if (observed.length !== required.length || observed.some((key, index) => key !== required[index])) {
    fail('PLACEMENT_SESSION_INPUT_INVALID', `${label} must contain exactly: ${required.join(', ')}`);
  }
}

function canonicalIdentifier(value: unknown, label: string, pattern = IDENTIFIER_128): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    fail('PLACEMENT_SESSION_INPUT_INVALID', `${label} is invalid`);
  }
  return value;
}

function accepted(binding: SessionBindingV1 | null): AcceptedPlacementBinding | null {
  if (binding === null) return null;
  return {
    status: 'accepted',
    agent_id: binding.agent_id,
    thread_id: binding.thread_id,
    session_id: binding.session_id,
    accepted_at: binding.accepted_at as string
  };
}

function profileId(agent: AgentV3): string {
  return `role:${agent.role_id}:v${agent.role_version}`;
}

function sessionId(requestId: string, agentId: string, threadId: string): string {
  return `session-${createHash('sha256')
    .update(`${requestId}\0${agentId}\0${threadId}`, 'utf8')
    .digest('hex')
    .slice(0, 32)}`;
}

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function handoff(task: PlacementTaskV3, agent: AgentV3): string {
  return [
    '<orquesta_persistent_specialist_assignment version="1">',
    `  <agent_id>${xml(agent.agent_id)}</agent_id>`,
    `  <role_id>${xml(agent.role_id)}</role_id>`,
    `  <role_version>${agent.role_version}</role_version>`,
    `  <task_id>${xml(task.task_id)}</task_id>`,
    `  <mission>${xml(agent.mission)}</mission>`,
    '  <acceptance_criteria>',
    ...task.acceptance_criteria.map((criterion) => `    <criterion>${xml(criterion)}</criterion>`),
    '  </acceptance_criteria>',
    '  <boundary>Work only on the assigned task and preserve the user authority boundary. Report missing context instead of inventing it.</boundary>',
    '  <completion>Return the bounded result and durable evidence to the orchestrator.</completion>',
    '</orquesta_persistent_specialist_assignment>'
  ].join('\n');
}

function validateProvisionInput(input: ProvisionPersistentPlacementInput): void {
  exactKeys(input, ['projectId', 'placementIntentId', 'requestId', 'task', 'agent'], 'provisionPersistentAgent input');
  canonicalIdentifier(input.projectId, 'projectId');
  canonicalIdentifier(input.requestId, 'requestId', IDENTIFIER_256);
  if (!PLACEMENT_INTENT_ID.test(input.placementIntentId)) {
    fail('PLACEMENT_SESSION_INPUT_INVALID', 'placementIntentId is invalid');
  }
  const taskState = {
    schema_version: 3,
    project_id: input.projectId,
    revision: 0,
    tasks: [input.task]
  };
  const taskValidation = validateContract('placement-task-state-v3', taskState);
  const agentValidation = validateContract('agent-registry-v3', {
    schema_version: 3,
    organization_revision: 0,
    agents: [input.agent]
  });
  if (!taskValidation.ok || !agentValidation.ok
    || input.task.state !== 'assigned'
    || input.task.placement_intent_id !== input.placementIntentId
    || input.task.assigned_agent_id !== input.agent.agent_id
    || input.task.owner_agent_id !== input.agent.agent_id
    || input.task.role_id !== input.agent.role_id
    || input.task.role_version !== input.agent.role_version
    || executionKernel.taskFingerprint(input.task) !== input.task.placement_fingerprint
    || input.agent.lifecycle_state !== 'provisioning'
    || input.agent.origin !== 'controller'
    || input.agent.created_from_ref.kind !== 'task'
    || input.agent.created_from_ref.id !== input.task.task_id) {
    fail('PLACEMENT_SESSION_INPUT_INVALID', 'Task and agent do not form one exact persistent placement assignment');
  }
}

export class PersistentPlacementSessionAdapter {
  readonly #rootPath: string;
  readonly #projectId: string;
  readonly #runtime: PlacementRuntime;
  readonly #sessionStore: PlacementSessionStore;
  readonly #runtimeEvidence: RuntimeBindingEvidence;
  readonly #verifyRuntime: () => Promise<void>;
  readonly #now: () => Date;
  readonly project_id: string;
  readonly project_root_binding_sha256: string;

  private constructor(input: {
    rootPath: string;
    projectId: string;
    runtime: PlacementRuntime;
    sessionStore: PlacementSessionStore;
    runtimeEvidence: RuntimeBindingEvidence;
    verifyRuntime: () => Promise<void>;
    now: () => Date;
  }) {
    this.#rootPath = input.rootPath;
    this.#projectId = input.projectId;
    this.#runtime = input.runtime;
    this.#sessionStore = input.sessionStore;
    this.#runtimeEvidence = input.runtimeEvidence;
    this.#verifyRuntime = input.verifyRuntime;
    this.#now = input.now;
    this.project_id = input.projectId;
    this.project_root_binding_sha256 = executionKernel.projectRootBindingSha256(input.rootPath);
  }

  static async create(options: PersistentPlacementSessionAdapterOptions): Promise<PersistentPlacementSessionAdapter> {
    exactKeys(options, [
      'rootPath', 'projectId', 'runtime', 'now', 'sessionStore', 'runtimeEvidence', 'readRuntimeEvidence'
    ].filter((key) => Object.hasOwn(options, key)), 'PersistentPlacementSessionAdapter options');
    const rootPath = await realpath(options.rootPath);
    const readEvidence = options.readRuntimeEvidence ?? readRuntimeBindingEvidence;
    const evidence = options.runtimeEvidence ?? await readEvidence(rootPath);
    if (!evidence || evidence.binding.project_id !== options.projectId) {
      fail('PLACEMENT_SESSION_RUNTIME_AUTHORITY_INVALID', 'Exact project runtime authority is unavailable');
    }
    const verifyCapturedRuntime = async (input: {
      rootPath: string;
      projectId: string;
      runtimeAuthorityId: string;
    }): Promise<void> => {
      const observed = await readEvidence(input.rootPath);
      if (!observed
        || observed.sha256 !== evidence.sha256
        || observed.binding.project_id !== input.projectId
        || observed.binding.runtime_authority_id !== input.runtimeAuthorityId) {
        fail('PLACEMENT_SESSION_RUNTIME_AUTHORITY_CHANGED', 'Runtime authority changed during persistent placement');
      }
    };
    const store = options.sessionStore ?? new SessionBindingStore({
      now: options.now,
      verifyRuntimeAuthority: verifyCapturedRuntime
    });
    return new PersistentPlacementSessionAdapter({
      rootPath,
      projectId: options.projectId,
      runtime: options.runtime,
      sessionStore: store,
      runtimeEvidence: evidence,
      verifyRuntime: () => verifyCapturedRuntime({
        rootPath,
        projectId: options.projectId,
        runtimeAuthorityId: evidence.binding.runtime_authority_id
      }),
      now: options.now ?? (() => new Date())
    });
  }

  async findAcceptedBinding(input: FindAcceptedPlacementInput): Promise<AcceptedPlacementBinding | null> {
    exactKeys(input, ['projectId', 'placementIntentId', 'taskId', 'agentId', 'requestId'], 'findAcceptedBinding input');
    if (input.projectId !== this.#projectId) {
      fail('PLACEMENT_SESSION_PROJECT_CONFLICT', 'Placement request belongs to another project');
    }
    return accepted(await this.#sessionStore.findAcceptedPlacementBinding({
      rootPath: this.#rootPath,
      projectId: input.projectId,
      requestId: input.requestId,
      placementIntentId: input.placementIntentId,
      taskId: input.taskId,
      agentId: input.agentId,
      runtimeAuthorityId: this.#runtimeEvidence.binding.runtime_authority_id
    }));
  }

  async provisionPersistentAgent(input: ProvisionPersistentPlacementInput): Promise<AcceptedPlacementBinding> {
    validateProvisionInput(input);
    if (input.projectId !== this.#projectId) {
      fail('PLACEMENT_SESSION_PROJECT_CONFLICT', 'Placement request belongs to another project');
    }
    const identity = {
      projectId: input.projectId,
      placementIntentId: input.placementIntentId,
      taskId: input.task.task_id,
      agentId: input.agent.agent_id,
      requestId: input.requestId
    };
    const prior = await this.findAcceptedBinding(identity);
    if (prior) return prior;
    const preflight = await this.#sessionStore.read(this.#rootPath, input.projectId);
    if (preflight.status !== 'ready') this.#failState(preflight);
    await this.#verifyRuntime();
    const result = await this.#runtime.sendMessage({
      messageId: input.requestId,
      correlationId: input.requestId,
      projectId: input.projectId,
      rootPath: this.#rootPath,
      threadId: null,
      targetAgentId: input.agent.agent_id,
      threadTitle: `Orquesta ${input.agent.role_id} · ${input.agent.agent_id}`,
      text: handoff(input.task, input.agent),
      attachments: [],
      recommendedModel: null,
      requestedModel: null
    });
    canonicalIdentifier(result.threadId, 'threadId', IDENTIFIER_256);
    canonicalIdentifier(result.turnId, 'turnId', IDENTIFIER_256);
    await this.#verifyRuntime();
    const acceptedAt = this.#now().toISOString();
    const proposedSessionId = sessionId(input.requestId, input.agent.agent_id, result.threadId);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const existing = await this.findAcceptedBinding(identity);
      if (existing) return existing;
      const read = await this.#sessionStore.read(this.#rootPath, input.projectId);
      if (read.status !== 'ready') this.#failState(read);
      try {
        const mutation: SessionBindingMutationResult = await this.#sessionStore.upsertAcceptedPersistentBinding({
          rootPath: this.#rootPath,
          projectId: input.projectId,
          expectedRevision: read.state.revision,
          sessionId: proposedSessionId,
          agentId: input.agent.agent_id,
          threadId: result.threadId,
          handoffTurnId: result.turnId,
          acceptedAt,
          runtimeAuthorityId: this.#runtimeEvidence.binding.runtime_authority_id,
          visibility: this.#runtimeEvidence.binding.mode === 'codex_hosted' ? 'codex_task' : 'desktop_only',
          profileId: profileId(input.agent),
          requestId: input.requestId,
          placementIntentId: input.placementIntentId,
          taskId: input.task.task_id,
          attachmentToolState: result.attachmentToolState
        });
        const persisted = mutation.state.sessions.find((session) => session.session_id === proposedSessionId) ?? null;
        const binding = accepted(persisted);
        if (!binding) fail('PLACEMENT_SESSION_PERSISTENCE_MISMATCH', 'Accepted session was not present after persistence');
        return binding;
      } catch (error) {
        if ((error as { code?: unknown })?.code !== 'SESSION_BINDING_REVISION_CONFLICT' || attempt === 7) throw error;
      }
    }
    fail('PLACEMENT_SESSION_REVISION_CONFLICT', 'Session binding did not settle after bounded CAS retries');
  }

  #failState(read: Exclude<SessionBindingReadResult, { status: 'ready' }>): never {
    if (read.status === 'missing') {
      fail('PLACEMENT_SESSION_STATE_NOT_INITIALIZED', 'Session binding state is not initialized');
    }
    if (read.status === 'migration_required') {
      fail('PLACEMENT_SESSION_MIGRATION_REQUIRED', `${read.reason}: ${read.filePath}`);
    }
    fail('PLACEMENT_SESSION_STATE_UNSUPPORTED', `${read.reason}: ${read.filePath}`);
  }
}
