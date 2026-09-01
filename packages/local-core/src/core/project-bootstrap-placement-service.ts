import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { FOUNDATION_AGENT_IDS, type AgentV3, type SessionBindingV1 } from '@orquesta/contracts';
import executionKernel from '@orquesta/execution-kernel';
import type {
  FoundationBootstrapClassification,
  PersistentPlacementSessionAdapter as KernelPersistentPlacementSessionAdapter,
  PersistentPlacementTaskPort
} from '@orquesta/execution-kernel';
import type { DesktopCodexService } from './desktop-codex-service';
import { PlacementTaskPort, type PlacementTaskReadResult } from './placement-task-port';
import type { PlacementTaskAuthorityPolicy } from './placement-task-port';
import { PersistentPlacementSessionAdapter } from './persistent-placement-session-adapter';
import {
  readRuntimeBindingEvidence,
  type RuntimeBindingEvidence
} from './runtime-binding-store';
import {
  SessionBindingStore,
  type SessionBindingReadResult
} from './session-binding-store';

const IDENTIFIER_128 = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const IDENTIFIER_256 = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const FOUNDATION_AGENT_ID_SET = new Set<string>(FOUNDATION_AGENT_IDS);
const FOUNDATION_HANDOFF_TIMEOUT_MS = 120_000;
const FOUNDATION_HANDOFF_POLL_MS = 100;
const FOUNDATION_HANDOFF_FAILURES = new Set(['failed', 'interrupted', 'cancelled', 'canceled']);

type ProjectRuntime = Pick<DesktopCodexService, 'sendMessage' | 'readTurnStatus' | 'listConversation'>;

export interface ProjectBootstrapPlacementServiceOptions {
  productRoot: string;
  projectRoot: string;
  projectId: string;
  runtime: ProjectRuntime;
  now?: () => Date;
  readRuntimeEvidence?: typeof readRuntimeBindingEvidence;
}

export interface FoundationBootstrapInput {
  bootstrapId?: string | null;
  userDisplayName?: string;
}

export interface PersistentAgentPlacementInput {
  sourceRef: { kind: string; id: string };
  roleCatalog: Array<{ id: string; version: number; capabilities: string[] }>;
  template: Record<string, unknown>;
}

type AcceptedFoundationBinding = {
  status: 'accepted';
  agent_id: string;
  thread_id: string;
  session_id: string;
  handoff_turn_id: string;
  accepted_at: string;
  runtime_authority_id: string;
};

const EXACT_SESSION_MIGRATIONS = new Set([
  'session_binding_legacy_shared_path'
]);
const EXACT_TASK_MIGRATIONS = new Set([
  'placement_task_legacy_shared_path'
]);

type AuthorityMode = 'missing' | 'ready' | 'exact_legacy' | 'invalid';
type AuthorityPolicy = PlacementTaskAuthorityPolicy;
type CompositionAdmission =
  | {
      allowed: true;
      sessionMode: Exclude<AuthorityMode, 'invalid'>;
      taskMode: Exclude<AuthorityMode, 'invalid'>;
    }
  | { allowed: false; result: Record<string, unknown> };

function sagaPhase(foundation: FoundationBootstrapClassification): string | null {
  const phase = foundation.saga?.phase;
  return typeof phase === 'string' ? phase : null;
}

function sagaMayCreateSessionAuthority(foundation: FoundationBootstrapClassification): boolean {
  if (sagaPhase(foundation) !== 'organization_initialized_with_provisioning_agents') return false;
  const bindings = foundation.saga?.session_bindings;
  return bindings !== null
    && typeof bindings === 'object'
    && !Array.isArray(bindings)
    && Object.values(bindings).length > 0
    && Object.values(bindings).every((entry) => (
      entry !== null
      && typeof entry === 'object'
      && !Array.isArray(entry)
      && (entry as { status?: unknown }).status === 'not_requested'
    ));
}

function repairResult(
  classification: FoundationBootstrapClassification['status'],
  reason: string
): CompositionAdmission {
  return {
    allowed: false,
    result: { status: 'repair_required', classification, reason, no_write: true }
  };
}

function authorityMode(
  state: SessionBindingReadResult | PlacementTaskReadResult,
  exactMigrations: ReadonlySet<string>
): AuthorityMode {
  if (state.status === 'missing' || state.status === 'ready') return state.status;
  if (state.status === 'migration_required' && exactMigrations.has(state.reason)) return 'exact_legacy';
  return 'invalid';
}

function authorityPolicy(mode: Exclude<AuthorityMode, 'invalid'>): AuthorityPolicy {
  if (mode === 'missing') return 'create_fresh';
  if (mode === 'exact_legacy') return 'migrate_only';
  return 'require_existing';
}

function compositionAdmission(
  foundation: FoundationBootstrapClassification,
  sessions: SessionBindingReadResult,
  tasks: PlacementTaskReadResult
): CompositionAdmission {
  const sessionMode = authorityMode(sessions, EXACT_SESSION_MIGRATIONS);
  const taskMode = authorityMode(tasks, EXACT_TASK_MIGRATIONS);
  if (['legacy_v2', 'mixed_v2', 'partial', 'unsupported'].includes(foundation.status)) {
    return {
      allowed: false,
      result: {
        status: foundation.status === 'unsupported' ? 'unsupported' : 'migration_required',
        classification: foundation.status,
        reason: foundation.reason,
        no_write: true
      }
    };
  }
  if (sessionMode === 'invalid') {
    return {
      allowed: false,
      result: {
        status: sessions.status,
        classification: sessions.status === 'unsupported' ? 'unsupported' : 'mixed_v2',
        reason: sessions.status === 'missing' || sessions.status === 'ready' ? null : sessions.reason,
        no_write: true
      }
    };
  }
  if (taskMode === 'invalid') {
    return {
      allowed: false,
      result: {
        status: tasks.status,
        classification: tasks.status === 'unsupported' ? 'unsupported' : 'mixed_v2',
        reason: tasks.status === 'missing' || tasks.status === 'ready' ? null : tasks.reason,
        no_write: true
      }
    };
  }
  if (foundation.status === 'fresh') {
    return sessionMode === 'missing' && taskMode === 'missing'
      ? { allowed: true, sessionMode, taskMode }
      : repairResult('fresh', 'project_composition_authority_precedes_foundation');
  }
  if (foundation.status === 'incomplete' || foundation.status === 'prepared') {
    const phase = sagaPhase(foundation);
    if (foundation.status === 'prepared' && phase === 'complete') {
      if (sessionMode === 'missing') {
        return repairResult('prepared', 'session_binding_authority_missing_after_foundation_completion');
      }
      if (taskMode === 'missing') {
        return repairResult('prepared', 'placement_task_authority_missing_after_foundation_completion');
      }
      return { allowed: true, sessionMode, taskMode };
    }
    if (taskMode !== 'missing') {
      return repairResult(foundation.status, 'placement_task_authority_precedes_foundation_completion');
    }
    if (phase === null) {
      return sessionMode === 'missing'
        ? { allowed: true, sessionMode, taskMode }
        : repairResult(foundation.status, 'session_binding_authority_precedes_foundation_saga');
    }
    const mayCreateSessionAuthority = sagaMayCreateSessionAuthority(foundation);
    if (!mayCreateSessionAuthority && sessionMode === 'missing') {
      return repairResult(foundation.status, 'session_binding_authority_missing_after_foundation_progress');
    }
    return { allowed: true, sessionMode, taskMode };
  }
  if (foundation.status === 'ready') {
    if (sessionMode === 'missing') {
      return {
        allowed: false,
        result: {
          status: 'repair_required',
          classification: 'ready',
          reason: 'session_binding_authority_missing_after_foundation_ready',
          no_write: true
        }
      };
    }
    if (taskMode === 'missing') {
      return {
        allowed: false,
        result: {
          status: 'repair_required',
          classification: 'ready',
          reason: 'placement_task_authority_missing_after_foundation_ready',
          no_write: true
        }
      };
    }
    return { allowed: true, sessionMode, taskMode };
  }
  return {
    allowed: false,
    result: {
      status: 'unsupported',
      classification: 'unsupported',
      reason: `project_composition_foundation_${foundation.status}`,
      no_write: true
    }
  };
}

export class ProjectBootstrapPlacementServiceError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProjectBootstrapPlacementServiceError';
    this.code = code;
  }
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new ProjectBootstrapPlacementServiceError(code, message, cause === undefined ? undefined : { cause });
}

function identifier(value: unknown, label: string, pattern = IDENTIFIER_128): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    fail('PROJECT_COMPOSITION_INPUT_INVALID', `${label} is invalid`);
  }
  return value;
}

function comparable(value: string): string {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
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

function foundationReceipt(agentId: string): string {
  return `<orquesta_foundation_receipt version="1" agent_id="${xml(agentId)}" status="accepted" />`;
}

function foundationHandoff(agent: AgentV3): string {
  const receipt = foundationReceipt(agent.agent_id);
  return [
    '<orquesta_foundation_assignment version="1">',
    `  <agent_id>${xml(agent.agent_id)}</agent_id>`,
    `  <role_id>${xml(agent.role_id)}</role_id>`,
    `  <role_version>${agent.role_version}</role_version>`,
    `  <mission>${xml(agent.mission)}</mission>`,
    '  <boundary>Operate only inside this project and preserve the user authority boundary.</boundary>',
    `  <completion>Do not use tools or perform project work. Reply with exactly ${xml(receipt)} and nothing else.</completion>`,
    '</orquesta_foundation_assignment>'
  ].join('\n');
}

function acceptedFoundation(binding: SessionBindingV1): AcceptedFoundationBinding {
  if (binding.handoff_turn_id === null || binding.accepted_at === null) {
    fail('FOUNDATION_SESSION_PERSISTENCE_MISMATCH', 'Accepted Foundation binding lacks handoff evidence');
  }
  return {
    status: 'accepted',
    agent_id: binding.agent_id,
    thread_id: binding.thread_id,
    session_id: binding.session_id,
    handoff_turn_id: binding.handoff_turn_id,
    accepted_at: binding.accepted_at,
    runtime_authority_id: binding.runtime_authority_id as string
  };
}

class FoundationSessionAdapter {
  readonly project_id: string;
  readonly project_root_binding_sha256: string;
  readonly runtime_authority_id: string;
  readonly #rootPath: string;
  readonly #runtime: ProjectRuntime;
  readonly #store: SessionBindingStore;
  readonly #runtimeEvidence: RuntimeBindingEvidence;
  readonly #verifyRuntime: () => Promise<void>;
  readonly #now: () => Date;

  constructor(input: {
    rootPath: string;
    projectId: string;
    runtime: ProjectRuntime;
    store: SessionBindingStore;
    runtimeEvidence: RuntimeBindingEvidence;
    verifyRuntime: () => Promise<void>;
    now: () => Date;
  }) {
    this.#rootPath = input.rootPath;
    this.project_id = input.projectId;
    this.#runtime = input.runtime;
    this.#store = input.store;
    this.#runtimeEvidence = input.runtimeEvidence;
    this.#verifyRuntime = input.verifyRuntime;
    this.#now = input.now;
    this.project_root_binding_sha256 = executionKernel.projectRootBindingSha256(input.rootPath);
    this.runtime_authority_id = input.runtimeEvidence.binding.runtime_authority_id;
  }

  async ensureAuthority(input: { projectId: string; policy: AuthorityPolicy }) {
    if (input.projectId !== this.project_id) {
      fail('FOUNDATION_SESSION_PROJECT_CONFLICT', 'Foundation session state belongs to another project');
    }
    await this.#verifyRuntime();
    return this.#store.ensureAuthority({
      rootPath: this.#rootPath,
      projectId: this.project_id,
      policy: input.policy
    });
  }

  async findAcceptedFoundationBinding(input: {
    projectId: string;
    bootstrapId: string;
    requestId: string;
    agentId: string;
  }): Promise<AcceptedFoundationBinding | null> {
    if (input.projectId !== this.project_id) {
      fail('FOUNDATION_SESSION_PROJECT_CONFLICT', 'Foundation session request belongs to another project');
    }
    identifier(input.bootstrapId, 'bootstrapId', IDENTIFIER_256);
    identifier(input.requestId, 'requestId', IDENTIFIER_256);
    identifier(input.agentId, 'agentId');
    await this.#verifyRuntime();
    const read = await this.#store.read(this.#rootPath, this.project_id);
    if (read.status === 'missing') return null;
    if (read.status !== 'ready') this.#failState(read);
    const matches = read.state.sessions.filter((binding) => (
      binding.agent_id === input.agentId
      && binding.profile_id === `foundation:${input.agentId}:v1`
      && binding.runtime_authority_id === this.#runtimeEvidence.binding.runtime_authority_id
      && binding.handoff_status === 'accepted'
      && binding.binding_status === 'bound'
      && binding.ownership_status === 'owner'
      && binding.rotation_state === 'active'
      && binding.accepts_new_work
    ));
    if (matches.length > 1) {
      fail('FOUNDATION_SESSION_OWNER_AMBIGUOUS', `Foundation agent ${input.agentId} has multiple active owner sessions`);
    }
    return matches.length === 0 ? null : acceptedFoundation(matches[0]);
  }

  async provisionFoundationAgent(input: {
    projectId: string;
    bootstrapId: string;
    requestId: string;
    agent: AgentV3;
  }): Promise<AcceptedFoundationBinding> {
    if (input.projectId !== this.project_id
      || input.agent.origin !== 'foundation'
      || !FOUNDATION_AGENT_ID_SET.has(input.agent.agent_id)) {
      fail('FOUNDATION_SESSION_INPUT_INVALID', 'Foundation provisioning identity is invalid');
    }
    identifier(input.requestId, 'requestId', IDENTIFIER_256);
    const identity = {
      projectId: input.projectId,
      bootstrapId: input.bootstrapId,
      requestId: input.requestId,
      agentId: input.agent.agent_id
    };
    const prior = await this.findAcceptedFoundationBinding(identity);
    if (prior) return prior;
    const preflight = await this.#store.read(this.#rootPath, this.project_id);
    if (preflight.status !== 'ready') this.#failState(preflight);
    await this.#verifyRuntime();
    const result = await this.#runtime.sendMessage({
      messageId: input.requestId,
      correlationId: input.requestId,
      projectId: this.project_id,
      rootPath: this.#rootPath,
      threadId: null,
      targetAgentId: input.agent.agent_id,
      threadTitle: `Orquesta ${input.agent.role_id} · ${input.agent.agent_id}`,
      text: foundationHandoff(input.agent),
      attachments: [],
      recommendedModel: null,
      requestedModel: null
    });
    identifier(result.threadId, 'threadId', IDENTIFIER_256);
    identifier(result.turnId, 'turnId', IDENTIFIER_256);
    await this.#awaitFoundationAcceptance({
      requestId: input.requestId,
      agentId: input.agent.agent_id,
      threadId: result.threadId,
      turnId: result.turnId
    });
    await this.#verifyRuntime();
    const acceptedAt = this.#now().toISOString();
    const proposedSessionId = sessionId(input.requestId, input.agent.agent_id, result.threadId);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const existing = await this.findAcceptedFoundationBinding(identity);
      if (existing) return existing;
      const read = await this.#store.read(this.#rootPath, this.project_id);
      if (read.status !== 'ready') this.#failState(read);
      try {
        await this.#store.upsertAcceptedFoundationBinding({
          rootPath: this.#rootPath,
          projectId: this.project_id,
          expectedRevision: read.state.revision,
          sessionId: proposedSessionId,
          agentId: input.agent.agent_id as (typeof FOUNDATION_AGENT_IDS)[number],
          threadId: result.threadId,
          handoffTurnId: result.turnId,
          acceptedAt,
          runtimeAuthorityId: this.#runtimeEvidence.binding.runtime_authority_id,
          visibility: this.#runtimeEvidence.binding.mode === 'codex_hosted' ? 'codex_task' : 'desktop_only',
          attachmentToolState: result.attachmentToolState
        });
        const persisted = await this.findAcceptedFoundationBinding(identity);
        if (!persisted || persisted.session_id !== proposedSessionId) {
          fail('FOUNDATION_SESSION_PERSISTENCE_MISMATCH', 'Foundation binding was not readable after persistence');
        }
        return persisted;
      } catch (error) {
        if ((error as { code?: unknown })?.code !== 'SESSION_BINDING_REVISION_CONFLICT' || attempt === 7) throw error;
      }
    }
    fail('FOUNDATION_SESSION_REVISION_CONFLICT', 'Foundation binding did not settle after bounded CAS retries');
  }

  async #awaitFoundationAcceptance(input: {
    requestId: string;
    agentId: string;
    threadId: string;
    turnId: string;
  }): Promise<void> {
    const deadline = Date.now() + FOUNDATION_HANDOFF_TIMEOUT_MS;
    const expectedReceipt = foundationReceipt(input.agentId);
    while (Date.now() <= deadline) {
      const status = (await this.#runtime.readTurnStatus(input.threadId, input.turnId))?.toLowerCase() ?? null;
      if (status === 'completed') {
        const page = await this.#runtime.listConversation({
          correlationId: `${input.requestId}:receipt`,
          threadId: input.threadId,
          targetAgentId: input.agentId,
          cursor: null,
          limit: 10,
          includeFoundationReceipts: true
        });
        const response = page.items.findLast((item) => item.role === 'agent' && item.turnId === input.turnId);
        if (response) {
          if (response.text.trim() !== expectedReceipt) {
            fail('FOUNDATION_HANDOFF_RECEIPT_INVALID', `Foundation agent ${input.agentId} returned an invalid acceptance receipt`);
          }
          return;
        }
      } else if (status && FOUNDATION_HANDOFF_FAILURES.has(status)) {
        fail('FOUNDATION_HANDOFF_TURN_FAILED', `Foundation agent ${input.agentId} handoff ended with status ${status}`);
      }
      if (Date.now() >= deadline) break;
      await new Promise<void>((resolve) => setTimeout(resolve, FOUNDATION_HANDOFF_POLL_MS));
    }
    fail('FOUNDATION_HANDOFF_TIMEOUT', `Foundation agent ${input.agentId} did not complete its acceptance receipt in time`);
  }

  #failState(read: Exclude<SessionBindingReadResult, { status: 'ready' }>): never {
    if (read.status === 'missing') {
      fail('FOUNDATION_SESSION_STATE_NOT_INITIALIZED', 'Foundation session binding state is not initialized');
    }
    if (read.status === 'migration_required') {
      fail('FOUNDATION_SESSION_MIGRATION_REQUIRED', `${read.reason}: ${read.filePath}`);
    }
    fail('FOUNDATION_SESSION_STATE_UNSUPPORTED', `${read.reason}: ${read.filePath}`);
  }
}

export class ProjectBootstrapPlacementService {
  readonly project_id: string;
  readonly project_root_binding_sha256: string;
  readonly runtime_binding_sha256: string;
  readonly #productRoot: string;
  readonly #projectRoot: string;
  readonly #now: () => Date;
  readonly #verifyRuntime: () => Promise<void>;
  readonly #organizationStore: ReturnType<typeof executionKernel.createOrganizationV3Store>;
  readonly #taskPort: PlacementTaskPort;
  readonly #sessionStore: SessionBindingStore;
  readonly #foundationSessionPort: FoundationSessionAdapter;
  readonly #persistentSessionAdapter: PersistentPlacementSessionAdapter;

  private constructor(input: {
    productRoot: string;
    projectRoot: string;
    projectId: string;
    runtimeEvidence: RuntimeBindingEvidence;
    now: () => Date;
    verifyRuntime: () => Promise<void>;
    organizationStore: ReturnType<typeof executionKernel.createOrganizationV3Store>;
    taskPort: PlacementTaskPort;
    sessionStore: SessionBindingStore;
    foundationSessionPort: FoundationSessionAdapter;
    persistentSessionAdapter: PersistentPlacementSessionAdapter;
  }) {
    this.#productRoot = input.productRoot;
    this.#projectRoot = input.projectRoot;
    this.project_id = input.projectId;
    this.#now = input.now;
    this.#verifyRuntime = input.verifyRuntime;
    this.#organizationStore = input.organizationStore;
    this.#taskPort = input.taskPort;
    this.#sessionStore = input.sessionStore;
    this.#foundationSessionPort = input.foundationSessionPort;
    this.#persistentSessionAdapter = input.persistentSessionAdapter;
    this.project_root_binding_sha256 = input.taskPort.project_root_binding_sha256;
    this.runtime_binding_sha256 = input.runtimeEvidence.sha256;
  }

  static async create(options: ProjectBootstrapPlacementServiceOptions): Promise<ProjectBootstrapPlacementService> {
    identifier(options.projectId, 'projectId');
    if (!path.isAbsolute(options.projectRoot) || !path.isAbsolute(options.productRoot)) {
      fail('PROJECT_COMPOSITION_ROOT_INVALID', 'Product and project roots must be absolute');
    }
    // PlacementTaskPort performs the strict canonical-real-directory and no-symlink check.
    const taskPort = new PlacementTaskPort(options.projectRoot);
    const projectRoot = await realpath(options.projectRoot);
    if (comparable(projectRoot) !== comparable(options.projectRoot)) {
      fail('PROJECT_COMPOSITION_ROOT_UNSAFE', 'Project root must already be canonical');
    }
    const productRoot = await realpath(options.productRoot);
    const now = options.now ?? (() => new Date());
    const readEvidence = options.readRuntimeEvidence ?? readRuntimeBindingEvidence;
    const evidence = await readEvidence(projectRoot);
    const expectedRootBinding = executionKernel.projectRootBindingSha256(projectRoot);
    if (!evidence
      || evidence.binding.project_id !== options.projectId
      || !/^[a-f0-9]{64}$/u.test(evidence.sha256)
      || taskPort.project_root_binding_sha256 !== expectedRootBinding) {
      fail('PROJECT_COMPOSITION_RUNTIME_AUTHORITY_INVALID', 'Exact project runtime authority is unavailable');
    }
    const verifyRuntime = async (): Promise<void> => {
      const observed = await readEvidence(projectRoot);
      if (!observed
        || observed.sha256 !== evidence.sha256
        || observed.binding.project_id !== options.projectId
        || observed.binding.runtime_authority_id !== evidence.binding.runtime_authority_id) {
        fail('PROJECT_COMPOSITION_RUNTIME_AUTHORITY_CHANGED', 'Runtime authority changed during project operation');
      }
    };
    const sessionStore = new SessionBindingStore({
      now,
      verifyRuntimeAuthority: async (input) => {
        if (input.rootPath !== projectRoot
          || input.projectId !== options.projectId
          || input.runtimeAuthorityId !== evidence.binding.runtime_authority_id) {
          fail('PROJECT_COMPOSITION_RUNTIME_AUTHORITY_INVALID', 'Session mutation escaped the captured runtime authority');
        }
        await verifyRuntime();
      }
    });
    const foundationSessionPort = new FoundationSessionAdapter({
      rootPath: projectRoot,
      projectId: options.projectId,
      runtime: options.runtime,
      store: sessionStore,
      runtimeEvidence: evidence,
      verifyRuntime,
      now
    });
    const persistentSessionAdapter = await PersistentPlacementSessionAdapter.create({
      rootPath: projectRoot,
      projectId: options.projectId,
      runtime: options.runtime,
      sessionStore,
      runtimeEvidence: evidence,
      readRuntimeEvidence: readEvidence,
      now
    });
    const organizationStore = executionKernel.createOrganizationV3Store({
      rootPath: projectRoot,
      validatedRuntimeBindingSha256: evidence.sha256,
      clock: () => now().toISOString()
    });
    return new ProjectBootstrapPlacementService({
      productRoot,
      projectRoot,
      projectId: options.projectId,
      runtimeEvidence: evidence,
      now,
      verifyRuntime,
      organizationStore,
      taskPort,
      sessionStore,
      foundationSessionPort,
      persistentSessionAdapter
    });
  }

  async bootstrap(input: FoundationBootstrapInput = {}): Promise<Record<string, unknown>> {
    await this.#verifyRuntime();
    const sessionPreflight = await this.#sessionStore.read(this.#projectRoot, this.project_id);
    const taskPreflight = this.#taskPort.read(this.project_id);
    const foundationPreflight = executionKernel.classifyFoundationBootstrapV3({
      projectRoot: this.#projectRoot,
      projectId: this.project_id,
      validatedRuntimeBindingSha256: this.runtime_binding_sha256,
      organizationStore: this.#organizationStore
    });
    const admission = compositionAdmission(foundationPreflight, sessionPreflight, taskPreflight);
    if ('result' in admission) return admission.result;
    const result = await executionKernel.runFoundationBootstrapV3({
      projectRoot: this.#projectRoot,
      projectId: this.project_id,
      validatedRuntimeBindingSha256: this.runtime_binding_sha256,
      bootstrapId: input.bootstrapId ?? null,
      userDisplayName: input.userDisplayName ?? 'User',
      organizationStore: this.#organizationStore,
      sessionPort: this.#foundationSessionPort,
      sessionAuthorityPolicy: authorityPolicy(admission.sessionMode),
      clock: this.#now
    });
    let taskAuthorityChanged = false;
    if (result.status === 'ready') {
      await this.#verifyRuntime();
      const taskAuthority = await this.#taskPort.ensureAuthority({
        projectId: this.project_id,
        policy: authorityPolicy(admission.taskMode)
      });
      taskAuthorityChanged = taskAuthority.changed;
    }
    return {
      ...result,
      no_write: result.no_write === true && !taskAuthorityChanged
    } as unknown as Record<string, unknown>;
  }

  async placePersistentAgent(input: PersistentAgentPlacementInput): Promise<Record<string, unknown>> {
    await this.#verifyRuntime();
    const tasks = this.#taskPort.read(this.project_id);
    if (tasks.status !== 'ready') {
      fail(
        tasks.status === 'missing' ? 'PROJECT_COMPOSITION_NOT_BOOTSTRAPPED' : 'PROJECT_COMPOSITION_TASK_AUTHORITY_UNAVAILABLE',
        `Persistent placement requires ready Task authority: ${tasks.status}`
      );
    }
    const sessions = await this.#sessionStore.read(this.#projectRoot, this.project_id);
    if (sessions.status !== 'ready') {
      fail(
        sessions.status === 'missing' ? 'PROJECT_COMPOSITION_NOT_BOOTSTRAPPED' : 'PROJECT_COMPOSITION_SESSION_AUTHORITY_UNAVAILABLE',
        `Persistent placement requires ready Session authority: ${sessions.status}`
      );
    }
    const taskPort = this.#taskPort as unknown as PersistentPlacementTaskPort;
    const sessionAdapter = {
      project_id: this.#persistentSessionAdapter.project_id,
      project_root_binding_sha256: this.#persistentSessionAdapter.project_root_binding_sha256,
      runtime_authority_id: this.#foundationSessionPort.runtime_authority_id,
      findAcceptedBinding: this.#persistentSessionAdapter.findAcceptedBinding.bind(this.#persistentSessionAdapter),
      provisionPersistentAgent: this.#persistentSessionAdapter.provisionPersistentAgent.bind(this.#persistentSessionAdapter)
    } as unknown as KernelPersistentPlacementSessionAdapter;
    return executionKernel.runPersistentAgentPlacement({
      productRoot: this.#productRoot,
      projectRoot: this.#projectRoot,
      projectId: this.project_id,
      sourceRef: input.sourceRef,
      roleCatalog: input.roleCatalog as Array<Record<string, unknown>>,
      template: input.template,
      organizationStore: this.#organizationStore,
      taskPort,
      sessionAdapter,
      clock: () => this.#now().toISOString()
    }) as Promise<Record<string, unknown>>;
  }
}
