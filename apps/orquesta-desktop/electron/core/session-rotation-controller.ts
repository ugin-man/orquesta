import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  activateSessionSuccessor,
  beginSessionDrain,
  markSessionCheckpointed,
  markSuccessorVerified,
  registerSessionSuccessor,
  verifySuccessorReceipt,
  type SessionRotationRecord,
  type SessionRotationRegistry
} from '@orquesta/execution-kernel';
import type { ConversationMessage } from '../../src/contracts/bridge';
import type { RuntimeNotification } from './protocol';
import type { DesktopCodexService } from './desktop-codex-service';
import { readRuntimeBinding, type RuntimeBinding } from './runtime-binding-store';
// @ts-expect-error Canonical CommonJS setup helper does not publish TypeScript declarations.
import sessionRotationHookInstaller from '../../../../orquesta/scripts/session-rotation-hook-install.js';

type JsonRecord = Record<string, unknown>;

interface RotationOperation {
  rootPath: string;
  projectId: string;
  agentId: string;
  predecessorSessionId: string;
  successorSessionId: string;
  successorThreadId: string;
  successorTurnId: string;
  manifestPath: string;
  manifestHash: string;
}

interface ProjectRegistration {
  rootPath: string;
  projectId: string;
}

interface RotationWaiter {
  promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
}

function record(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
}

function safeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);
}

async function gitCommonDirectory(rootPath: string): Promise<string | null> {
  const marker = path.join(rootPath, '.git');
  try {
    const details = await stat(marker);
    if (details.isDirectory()) return await realpath(marker);
    if (!details.isFile()) return null;
    const match = /^gitdir:\s*(.+)\s*$/mu.exec(await readFile(marker, 'utf8'));
    if (!match) return null;
    const gitDirectory = await realpath(path.resolve(rootPath, match[1]));
    try {
      const common = (await readFile(path.join(gitDirectory, 'commondir'), 'utf8')).trim();
      return common ? await realpath(path.resolve(gitDirectory, common)) : gitDirectory;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return gitDirectory;
      throw error;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function readJson(filePath: string, fallback: unknown): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(fallback);
    throw error;
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, filePath);
}

function registrySessions(registry: SessionRotationRegistry): SessionRotationRecord[] {
  return Object.values(registry.sessions ?? {});
}

function activeOwner(registry: SessionRotationRegistry, agentId: string): SessionRotationRecord | null {
  const owners = registrySessions(registry)
    .filter((session) => session.agent_id === agentId && session.ownership_status === 'owner')
    .filter((session) => !['superseded', 'failed'].includes(session.rotation_state))
    .sort((left, right) => right.session_generation - left.session_generation);
  if (owners.length > 1 && owners[0].session_generation === owners[1].session_generation) {
    throw new Error(`multiple active owners for agent ${agentId}`);
  }
  return owners[0] ?? null;
}

function boundedConversation(messages: ConversationMessage[]): Array<Record<string, unknown>> {
  let budget = 32_000;
  const selected: Array<Record<string, unknown>> = [];
  for (const message of [...messages].reverse()) {
    if (message.kind === 'session_boundary') continue;
    const text = message.text.slice(0, Math.min(4_000, budget));
    if (!text) continue;
    selected.unshift({
      role: message.role,
      author_label: message.authorLabel,
      text,
      created_at: message.createdAt,
      evidence_label: message.evidenceLabel
    });
    budget -= text.length;
    if (budget <= 0) break;
  }
  return selected;
}

function parseReceipt(text: string): JsonRecord | null {
  const match = /<orquesta_session_receipt>(\{[\s\S]*?\})<\/orquesta_session_receipt>/u.exec(text);
  if (!match) return null;
  try {
    return record(JSON.parse(match[1]));
  } catch {
    return null;
  }
}

export class SessionRotationController {
  readonly #runtime: DesktopCodexService;
  readonly #projects = new Map<string, ProjectRegistration>();
  readonly #operationsBySuccessorThread = new Map<string, RotationOperation>();
  readonly #waiters = new Map<string, RotationWaiter>();
  readonly #queues = new Map<string, Promise<void>>();

  constructor({ runtime }: { runtime: DesktopCodexService }) {
    this.#runtime = runtime;
  }

  async open(rootPath: string, projectId: string): Promise<void> {
    const canonicalRoot = await realpath(rootPath);
    await this.#installRotationHooks(canonicalRoot);
    this.#projects.set(canonicalRoot, { rootPath: canonicalRoot, projectId });
    await this.#enqueue(canonicalRoot, async () => {
      await this.#recoverWarming(canonicalRoot, projectId);
      await this.#recoverBoundHostedSuccessors(canonicalRoot, projectId);
      await this.#rotateEligibleIdleOwners(canonicalRoot, projectId);
    });
  }

  async ensureReadyForDispatch(rootPath: string, projectId: string, agentId: string): Promise<void> {
    const canonicalRoot = await realpath(rootPath);
    this.#projects.set(canonicalRoot, { rootPath: canonicalRoot, projectId });
    let waitForCutover: Promise<void> | null = null;
    await this.#enqueue(canonicalRoot, async () => {
      const registry = await this.#readRegistry(canonicalRoot);
      const owner = activeOwner(registry, agentId);
      if (!owner) return;
      const existingWaiter = this.#waiters.get(this.#waiterKey(canonicalRoot, agentId));
      if (existingWaiter) {
        waitForCutover = existingWaiter.promise;
        return;
      }
      if (!['rotation_pending', 'rotation_required'].includes(owner.rotation_state)) {
        if (owner.accepts_new_work === false) {
          throw new Error(`Agent ${agentId} session handoff is incomplete; the prior owner remains protected`);
        }
        return;
      }
      const sessions = await this.#readSessions(canonicalRoot);
      const session = sessions.find((item) => safeString(item.thread_id) === owner.thread_id);
      if (safeString(session?.runtime_status) === 'active' || safeString(session?.status) === 'working') {
        if (owner.rotation_state === 'rotation_required') {
          throw new Error(`Agent ${agentId} must finish its current atomic work before session rotation`);
        }
        return;
      }
      const started = await this.#startRotation(canonicalRoot, projectId, owner);
      if (started) {
        waitForCutover = this.#waiters.get(this.#waiterKey(canonicalRoot, agentId))?.promise ?? null;
      } else if (owner.rotation_state === 'rotation_required') {
        throw new Error(`Agent ${agentId} requires a Codex-hosted successor binding before session rotation`);
      }
    });
    if (waitForCutover) await waitForCutover;
  }

  async bindHostedSuccessor(input: {
    rootPath: string;
    projectId: string;
    agentId: string;
    successorThreadId: string;
  }): Promise<void> {
    const canonicalRoot = await realpath(input.rootPath);
    const successorThreadId = input.successorThreadId.trim();
    if (!successorThreadId) throw new Error('Hosted session rotation requires a successor thread id');
    this.#projects.set(canonicalRoot, { rootPath: canonicalRoot, projectId: input.projectId });
    await this.#enqueue(canonicalRoot, async () => {
      const registry = await this.#readRegistry(canonicalRoot);
      const owner = activeOwner(registry, input.agentId);
      if (!owner) throw new Error(`Agent ${input.agentId} has no active session owner`);
      if (!['rotation_pending', 'rotation_required'].includes(owner.rotation_state)) {
        throw new Error(`Agent ${input.agentId} is not ready for session rotation`);
      }
      const started = await this.#startRotation(canonicalRoot, input.projectId, owner, successorThreadId);
      if (!started) throw new Error(`Hosted successor ${successorThreadId} could not be bound safely`);
    });
  }

  async observe(notification: RuntimeNotification): Promise<void> {
    if (notification.kind !== 'turn_completed' && notification.kind !== 'turn_failed') return;
    const operation = this.#operationsBySuccessorThread.get(notification.threadId);
    if (operation) {
      await this.#enqueue(operation.rootPath, async () => {
        if (notification.kind === 'turn_completed') await this.#completeSuccessor(operation);
        else await this.#recordFailure(operation, 'successor_turn_failed');
      });
      return;
    }
    for (const project of this.#projects.values()) {
      const registry = await this.#readRegistry(project.rootPath);
      const owner = registrySessions(registry).find((session) => (
        session.thread_id === notification.threadId
        && session.ownership_status === 'owner'
        && ['rotation_pending', 'rotation_required'].includes(session.rotation_state)
      ));
      if (!owner) continue;
      await this.#enqueue(project.rootPath, () => this.#startRotation(project.rootPath, project.projectId, owner));
      break;
    }
  }

  async #enqueue(rootPath: string, task: () => Promise<void>): Promise<void> {
    const prior = this.#queues.get(rootPath) ?? Promise.resolve();
    const next = prior.then(task, task);
    this.#queues.set(rootPath, next.catch(() => undefined));
    return next;
  }

  #waiterKey(rootPath: string, agentId: string): string {
    return `${rootPath}\0${agentId}`;
  }

  #createWaiter(rootPath: string, agentId: string): RotationWaiter {
    const key = this.#waiterKey(rootPath, agentId);
    const existing = this.#waiters.get(key);
    if (existing) return existing;
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    void promise.catch(() => undefined);
    const waiter = { promise, resolve, reject };
    this.#waiters.set(key, waiter);
    return waiter;
  }

  async #readRegistry(rootPath: string): Promise<SessionRotationRegistry> {
    return await readJson(path.join(rootPath, '.orquesta', 'state', 'session-rotation.json'), {
      schema_version: 1, revision: 0, policy: { prepare_at: 12, pending_at: 15, required_at: 20 },
      sessions: {}, applied_event_ids: [], updated_at: null
    }) as SessionRotationRegistry;
  }

  async #writeRegistry(rootPath: string, registry: SessionRotationRegistry): Promise<void> {
    await writeJsonAtomic(path.join(rootPath, '.orquesta', 'state', 'session-rotation.json'), registry);
  }

  async #readSessions(rootPath: string): Promise<JsonRecord[]> {
    const state = record(await readJson(path.join(rootPath, '.orquesta', 'state', 'sessions.json'), { sessions: [] }));
    return Array.isArray(state?.sessions) ? state.sessions.flatMap((value) => record(value) ?? []) : [];
  }

  async #installRotationHooks(canonicalRoot: string): Promise<void> {
    const installer = sessionRotationHookInstaller as {
      installSessionRotationHook(input: { projectRoot: string; canonicalRoot?: string }): unknown;
    };
    installer.installSessionRotationHook({ projectRoot: canonicalRoot, canonicalRoot });
    const canonicalGit = await gitCommonDirectory(canonicalRoot);
    if (!canonicalGit) return;
    const sessions = await this.#readSessions(canonicalRoot);
    const placements = new Set(sessions.filter((session) => (
      safeString(session.ownership_status) === 'owner'
      && !['superseded', 'failed'].includes(safeString(session.rotation_state) ?? '')
      && safeString(session.binding_status) === 'bound'
    )).flatMap((session) => safeString(session.cwd) ?? []));
    for (const placementValue of placements) {
      let placement: string;
      try {
        placement = await realpath(placementValue);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      if (samePath(placement, canonicalRoot)) continue;
      const placementGit = await gitCommonDirectory(placement);
      if (!placementGit || !samePath(placementGit, canonicalGit)) continue;
      installer.installSessionRotationHook({ projectRoot: placement, canonicalRoot });
    }
  }

  async #readAgents(rootPath: string): Promise<{ state: JsonRecord; agents: JsonRecord[] }> {
    const state = record(await readJson(path.join(rootPath, '.orquesta', 'state', 'agents.json'), { version: 1, agents: [] })) ?? {};
    return { state, agents: Array.isArray(state.agents) ? state.agents.flatMap((value) => record(value) ?? []) : [] };
  }

  async #rotateEligibleIdleOwners(rootPath: string, projectId: string): Promise<void> {
    const registry = await this.#readRegistry(rootPath);
    const sessions = await this.#readSessions(rootPath);
    for (const owner of registrySessions(registry).filter((session) => (
      session.ownership_status === 'owner' && ['rotation_pending', 'rotation_required'].includes(session.rotation_state)
    ))) {
      const projected = sessions.find((session) => safeString(session.thread_id) === owner.thread_id);
      if (safeString(projected?.runtime_status) === 'active' || safeString(projected?.status) === 'working') continue;
      await this.#startRotation(rootPath, projectId, owner);
    }
  }

  async #startRotation(
    rootPath: string,
    projectId: string,
    owner: SessionRotationRecord,
    hostedSuccessorThreadId: string | null = null
  ): Promise<boolean> {
    let registry = await this.#readRegistry(rootPath);
    const current = registry.sessions[owner.session_id];
    if (!current || !['rotation_pending', 'rotation_required'].includes(current.rotation_state)) return false;
    const runtimeBinding = await readRuntimeBinding(rootPath);
    if (!runtimeBinding) {
      await this.#recordManualRecovery(rootPath, projectId, current, 'runtime_binding_required');
      return false;
    }
    if (runtimeBinding.mode === 'codex_hosted') {
      if (!hostedSuccessorThreadId) {
        await this.#recordManualRecovery(
          rootPath,
          projectId,
          current,
          'codex_hosted_successor_thread_binding_required'
        );
        return false;
      }
      const visibleThreads = await this.#runtime.listProjectThreads(rootPath);
      const successor = visibleThreads.find((thread) => thread.id === hostedSuccessorThreadId && !thread.archived);
      if (!successor) {
        await this.#recordManualRecovery(
          rootPath,
          projectId,
          current,
          `codex_hosted_successor_not_in_project:${hostedSuccessorThreadId}`
        );
        return false;
      }
    } else if (hostedSuccessorThreadId) {
      throw new Error('Standalone session rotation cannot bind a Codex-hosted successor');
    }
    this.#createWaiter(rootPath, current.agent_id ?? 'unknown');
    registry = beginSessionDrain(registry, {
      session_id: owner.session_id,
      expected_revision: registry.revision,
      observed_at: new Date().toISOString()
    });
    await this.#writeRegistry(rootPath, registry);

    const manifest = await this.#buildManifest(rootPath, current);
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    const manifestHash = sha256(manifestText);
    const manifestPath = path.join(
      rootPath, '.orquesta', 'state', 'session-handoffs', current.agent_id ?? 'unknown',
      `generation-${current.session_generation}-to-${current.session_generation + 1}.manifest.json`
    );
    await writeJsonAtomic(manifestPath, manifest);
    registry = await this.#readRegistry(rootPath);
    registry = markSessionCheckpointed(registry, {
      session_id: owner.session_id,
      expected_revision: registry.revision,
      handoff_manifest_path: path.relative(rootPath, manifestPath).replaceAll('\\', '/'),
      handoff_manifest_hash: manifestHash,
      observed_at: new Date().toISOString()
    });
    await this.#writeRegistry(rootPath, registry);

    const agentId = current.agent_id;
    if (!agentId) throw new Error(`session ${current.session_id} has no agent id`);
    const agents = await this.#readAgents(rootPath);
    const agent = agents.agents.find((item) => safeString(item.agent_id) === agentId);
    const title = safeString(agent?.display_name) ?? safeString(agent?.title) ?? agentId;
    const relativeManifestPath = path.relative(rootPath, manifestPath).replaceAll('\\', '/');
    const prompt = [
      `You are taking over the stable Orquesta role agent_id=${agentId} as session generation ${current.session_generation + 1}.`,
      `Read the handoff manifest at ${relativeManifestPath} and every canonical file listed in canonical_state_files.`,
      'Do not edit product files during this handoff turn. Confirm the current objective, unresolved constraints, and next action.',
      'End your response with exactly one machine-readable receipt using this shape:',
      `<orquesta_session_receipt>{"agent_id":"${agentId}","expected_generation":${current.session_generation + 1},"observed_generation":${current.session_generation + 1},"handoff_manifest_hash":"${manifestHash}","ready_to_assume_ownership":true,"evidence_checked":["${relativeManifestPath}"],"next_action":"brief concrete next action"}</orquesta_session_receipt>`
    ].join('\n\n');

    let successorThreadId = '';
    const result = await this.#runtime.sendMessage({
      correlationId: `session-rotation:${randomUUID()}`,
      projectId,
      rootPath,
      threadId: runtimeBinding.mode === 'codex_hosted' ? hostedSuccessorThreadId : null,
      targetAgentId: agentId,
      threadTitle: title,
      text: prompt,
      localImagePaths: [],
      recommendedModel: null,
      requestedModel: null,
      onThreadReady: async (threadId) => {
        if (runtimeBinding.mode === 'codex_hosted' && threadId !== hostedSuccessorThreadId) {
          throw new Error(`Codex-hosted successor binding changed during rotation: ${threadId}`);
        }
        successorThreadId = threadId;
        let latest = await this.#readRegistry(rootPath);
        latest = registerSessionSuccessor(latest, {
          predecessor_session_id: current.session_id,
          successor_session_id: threadId,
          successor_thread_id: threadId,
          expected_revision: latest.revision,
          observed_at: new Date().toISOString()
        });
        await this.#writeRegistry(rootPath, latest);
        await this.#appendCandidateSession(rootPath, current, threadId, title, runtimeBinding);
      }
    });
    const operation: RotationOperation = {
      rootPath, projectId, agentId, predecessorSessionId: current.session_id,
      successorSessionId: successorThreadId || result.threadId,
      successorThreadId: result.threadId,
      successorTurnId: result.turnId,
      manifestPath, manifestHash
    };
    this.#operationsBySuccessorThread.set(result.threadId, operation);
    await this.#recordRecoveryState(rootPath, projectId, current, {
      status: 'dispatching',
      reason: null,
      successor_thread_id: result.threadId
    });
    return true;
  }

  async #recordManualRecovery(
    rootPath: string,
    projectId: string,
    owner: SessionRotationRecord,
    reason: string
  ): Promise<void> {
    await this.#recordRecoveryState(rootPath, projectId, owner, {
      status: 'manual_recovery',
      reason,
      successor_thread_id: null
    });
  }

  async #recordRecoveryState(
    rootPath: string,
    projectId: string,
    owner: SessionRotationRecord,
    patch: { status: string; reason: string | null; successor_thread_id: string | null }
  ): Promise<void> {
    const statePath = path.join(rootPath, '.orquesta', 'state', 'session-rotation-recovery.json');
    const state = record(await readJson(statePath, { schema_version: 1, requests: [] })) ?? {};
    const requests = Array.isArray(state.requests) ? state.requests.flatMap((value) => record(value) ?? []) : [];
    const requestId = `${owner.agent_id ?? 'unknown'}:generation-${owner.session_generation + 1}`;
    const now = new Date().toISOString();
    const existingIndex = requests.findIndex((request) => safeString(request.request_id) === requestId);
    const existing = existingIndex >= 0 ? requests[existingIndex] : {};
    const request = {
      ...existing,
      request_id: requestId,
      agent_id: owner.agent_id,
      predecessor_session_id: owner.session_id,
      predecessor_thread_id: owner.thread_id,
      expected_successor_generation: owner.session_generation + 1,
      project_id: projectId,
      target_project_root: rootPath,
      completion_transport: 'manual_recovery',
      ...patch,
      created_at: safeString(existing.created_at) ?? now,
      updated_at: now
    };
    if (existingIndex >= 0) requests[existingIndex] = request;
    else requests.push(request);
    await writeJsonAtomic(statePath, { ...state, schema_version: 1, requests, updated_at: now });
  }

  async #buildManifest(rootPath: string, owner: SessionRotationRecord): Promise<JsonRecord> {
    const stateDirectory = path.join(rootPath, '.orquesta', 'state');
    const canonicalNames = ['agents.json', 'tasks.json', 'sessions.json', 'project-control-plane.json', 'questions.json'];
    const canonicalStateFiles: Array<Record<string, unknown>> = [];
    for (const name of canonicalNames) {
      try {
        const content = await readFile(path.join(stateDirectory, name), 'utf8');
        canonicalStateFiles.push({ path: `.orquesta/state/${name}`, sha256: sha256(content), bytes: Buffer.byteLength(content) });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    const tasksState = record(await readJson(path.join(stateDirectory, 'tasks.json'), { tasks: [] }));
    const tasks = Array.isArray(tasksState?.tasks) ? tasksState.tasks.flatMap((value) => record(value) ?? []) : [];
    const activeTasks = tasks.filter((task) => {
      const lifecycle = safeString(task.state) ?? safeString(task.status) ?? '';
      return safeString(task.owner_agent_id) === owner.agent_id && !['completed', 'cancelled', 'failed', 'accepted'].includes(lifecycle);
    });
    let conversation: ConversationMessage[] = [];
    if (owner.agent_id) {
      try {
        conversation = (await this.#runtime.listConversation({
          correlationId: `session-manifest:${randomUUID()}`,
          threadId: owner.thread_id,
          targetAgentId: owner.agent_id,
          limit: 40
        })).items;
      } catch {
        conversation = [];
      }
    }
    return {
      schema_version: 1,
      kind: 'orquesta_session_handoff_manifest',
      created_at: new Date().toISOString(),
      agent_id: owner.agent_id,
      predecessor: {
        session_id: owner.session_id,
        thread_id: owner.thread_id,
        generation: owner.session_generation,
        compaction_count: owner.compaction_count
      },
      successor_generation: owner.session_generation + 1,
      canonical_state_files: canonicalStateFiles,
      active_tasks: activeTasks,
      conversation_tail: boundedConversation(conversation),
      continuity_rules: [
        'Canonical state files outrank the conversation tail.',
        'Do not silently broaden scope or revive superseded constraints.',
        'Preserve unresolved user intent and report uncertainty instead of guessing.',
        'Use the same stable agent_id after ownership cutover.'
      ]
    };
  }

  async #appendCandidateSession(
    rootPath: string,
    predecessor: SessionRotationRecord,
    threadId: string,
    title: string,
    runtimeBinding: RuntimeBinding
  ): Promise<void> {
    const statePath = path.join(rootPath, '.orquesta', 'state', 'sessions.json');
    const state = record(await readJson(statePath, { schema_version: '1.0', sessions: [] })) ?? {};
    const sessions = Array.isArray(state.sessions) ? state.sessions.flatMap((value) => record(value) ?? []) : [];
    if (!sessions.some((session) => safeString(session.thread_id) === threadId)) {
      sessions.push({
        session_id: threadId,
        thread_id: threadId,
        agent_id: predecessor.agent_id,
        session_generation: predecessor.session_generation + 1,
        rotation_state: 'successor_warming',
        ownership_status: 'candidate',
        accepts_new_work: false,
        binding_status: 'bound',
        runtime_status: 'active',
        status: 'working',
        title,
        runtime_authority_id: runtimeBinding.runtime_authority_id,
        visibility: runtimeBinding.mode === 'codex_hosted' ? 'codex_task' : 'desktop_only',
        profile_id: `session-rotation:${predecessor.agent_id ?? 'unknown'}:generation-${predecessor.session_generation + 1}`,
        session_kind: 'persistent_agent',
        replaces_session_id: predecessor.session_id,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });
      await writeJsonAtomic(statePath, { ...state, sessions, updated_at: new Date().toISOString() });
    }
  }

  async #completeSuccessor(operation: RotationOperation): Promise<void> {
    const page = await this.#runtime.listConversation({
      correlationId: `session-receipt:${randomUUID()}`,
      threadId: operation.successorThreadId,
      targetAgentId: operation.agentId,
      limit: 20
    });
    const response = [...page.items].reverse().find((message) => message.role === 'agent');
    const receipt = response ? parseReceipt(response.text) : null;
    if (!receipt) {
      await this.#recordFailure(operation, 'successor_receipt_missing');
      return;
    }
    let registry = await this.#readRegistry(operation.rootPath);
    const verification = verifySuccessorReceipt(registry, {
      successor_session_id: operation.successorSessionId,
      receipt
    });
    if (!verification.valid) {
      await this.#recordFailure(operation, `successor_receipt_rejected:${verification.reasons.join(',')}`);
      return;
    }
    const receiptPath = operation.manifestPath.replace(/\.manifest\.json$/u, '.receipt.json');
    await writeJsonAtomic(receiptPath, { schema_version: 1, ...receipt, verified_at: new Date().toISOString() });
    const receiptHash = sha256(await readFile(receiptPath, 'utf8'));
    registry = markSuccessorVerified(registry, {
      successor_session_id: operation.successorSessionId,
      expected_revision: registry.revision,
      receipt,
      receipt_path: path.relative(operation.rootPath, receiptPath).replaceAll('\\', '/'),
      receipt_hash: receiptHash,
      observed_at: new Date().toISOString()
    });
    await this.#writeRegistry(operation.rootPath, registry);

    await this.#projectCutover(operation.rootPath, operation);
    registry = await this.#readRegistry(operation.rootPath);
    registry = activateSessionSuccessor(registry, {
      successor_session_id: operation.successorSessionId,
      expected_revision: registry.revision,
      observed_at: new Date().toISOString()
    });
    await this.#writeRegistry(operation.rootPath, registry);
    const predecessor = registry.sessions[operation.predecessorSessionId];
    if (predecessor) {
      await this.#recordRecoveryState(operation.rootPath, operation.projectId, predecessor, {
        status: 'completed',
        reason: null,
        successor_thread_id: operation.successorThreadId
      });
    }
    this.#operationsBySuccessorThread.delete(operation.successorThreadId);
    const waiterKey = this.#waiterKey(operation.rootPath, operation.agentId);
    this.#waiters.get(waiterKey)?.resolve();
    this.#waiters.delete(waiterKey);
  }

  async #projectCutover(rootPath: string, operation: RotationOperation): Promise<void> {
    const now = new Date().toISOString();
    const sessionsPath = path.join(rootPath, '.orquesta', 'state', 'sessions.json');
    const sessionsState = record(await readJson(sessionsPath, { sessions: [] })) ?? {};
    const sessions = (Array.isArray(sessionsState.sessions) ? sessionsState.sessions : []).map((value) => {
      const session = record(value) ?? {};
      const sessionId = safeString(session.session_id) ?? safeString(session.thread_id);
      if (sessionId === operation.predecessorSessionId) return {
        ...session, rotation_state: 'superseded', ownership_status: 'superseded', accepts_new_work: false,
        replaced_by_session_id: operation.successorSessionId, updated_at: now
      };
      if (sessionId === operation.successorSessionId) return {
        ...session, rotation_state: 'active', ownership_status: 'owner', accepts_new_work: true,
        runtime_status: 'idle', status: 'standby', updated_at: now
      };
      return session;
    });
    await writeJsonAtomic(sessionsPath, { ...sessionsState, sessions, updated_at: now });

    const { state, agents } = await this.#readAgents(rootPath);
    const projectedAgents = agents.map((agent) => safeString(agent.agent_id) === operation.agentId ? {
      ...agent,
      thread_id: operation.successorThreadId,
      session_id: operation.successorSessionId,
      session_generation: Number(agent.session_generation ?? 1) + 1,
      updated_at: now
    } : agent);
    await writeJsonAtomic(path.join(rootPath, '.orquesta', 'state', 'agents.json'), {
      ...state, agents: projectedAgents, updated_at: now
    });
  }

  async #recoverBoundHostedSuccessors(rootPath: string, projectId: string): Promise<void> {
    const statePath = path.join(rootPath, '.orquesta', 'state', 'session-rotation-recovery.json');
    const state = record(await readJson(statePath, { schema_version: 1, requests: [] })) ?? {};
    const requests = Array.isArray(state.requests) ? state.requests.flatMap((value) => record(value) ?? []) : [];
    for (const request of requests.filter((item) => safeString(item.status) === 'bound')) {
      const agentId = safeString(request.agent_id);
      const successorThreadId = safeString(request.successor_thread_id);
      if (!agentId || !successorThreadId) continue;
      const registry = await this.#readRegistry(rootPath);
      const owner = activeOwner(registry, agentId);
      if (!owner || !['rotation_pending', 'rotation_required'].includes(owner.rotation_state)) continue;
      const expectedGeneration = Number(request.expected_successor_generation);
      if (Number.isInteger(expectedGeneration) && expectedGeneration !== owner.session_generation + 1) {
        await this.#recordManualRecovery(
          rootPath,
          projectId,
          owner,
          `successor_generation_mismatch:${expectedGeneration}`
        );
        continue;
      }
      await this.#startRotation(rootPath, projectId, owner, successorThreadId);
    }
  }

  async #recoverWarming(rootPath: string, projectId: string): Promise<void> {
    const registry = await this.#readRegistry(rootPath);
    for (const successor of registrySessions(registry).filter((session) => session.rotation_state === 'successor_warming')) {
      const predecessor = registry.sessions[successor.replaces_session_id ?? ''];
      if (!predecessor?.handoff_manifest_path || !predecessor.handoff_manifest_hash || !successor.agent_id) continue;
      const operation: RotationOperation = {
        rootPath, projectId, agentId: successor.agent_id,
        predecessorSessionId: predecessor.session_id,
        successorSessionId: successor.session_id,
        successorThreadId: successor.thread_id,
        successorTurnId: '',
        manifestPath: path.join(rootPath, predecessor.handoff_manifest_path),
        manifestHash: predecessor.handoff_manifest_hash
      };
      this.#operationsBySuccessorThread.set(successor.thread_id, operation);
      this.#createWaiter(rootPath, successor.agent_id);
      try {
        await this.#completeSuccessor(operation);
      } catch {
        // The successor may still be running. Its completion notification will retry this check.
      }
    }
  }

  async #recordFailure(operation: RotationOperation, reason: string): Promise<void> {
    await writeJsonAtomic(operation.manifestPath.replace(/\.manifest\.json$/u, '.failure.json'), {
      schema_version: 1,
      agent_id: operation.agentId,
      predecessor_session_id: operation.predecessorSessionId,
      successor_session_id: operation.successorSessionId,
      reason,
      observed_at: new Date().toISOString(),
      ownership_preserved_by: operation.predecessorSessionId
    });
    const registry = await this.#readRegistry(operation.rootPath);
    const predecessor = registry.sessions[operation.predecessorSessionId];
    const successor = registry.sessions[operation.successorSessionId];
    if (predecessor) {
      await this.#recordRecoveryState(operation.rootPath, operation.projectId, predecessor, {
        status: 'manual_recovery',
        reason,
        successor_thread_id: operation.successorThreadId
      });
    }
    if (predecessor) {
      const retryState = predecessor.compaction_count >= registry.policy.required_at ? 'rotation_required' : 'rotation_pending';
      const now = new Date().toISOString();
      const next: SessionRotationRegistry = {
        ...registry,
        revision: registry.revision + 1,
        sessions: {
          ...registry.sessions,
          [operation.predecessorSessionId]: {
            ...predecessor,
            rotation_state: retryState,
            accepts_new_work: retryState !== 'rotation_required',
            replaced_by_session_id: null,
            updated_at: now
          },
          ...(successor ? {
            [operation.successorSessionId]: {
              ...successor,
              rotation_state: 'failed',
              ownership_status: 'candidate',
              accepts_new_work: false,
              updated_at: now
            }
          } : {})
        },
        updated_at: now
      };
      await this.#writeRegistry(operation.rootPath, next);
    }
    this.#operationsBySuccessorThread.delete(operation.successorThreadId);
    const waiterKey = this.#waiterKey(operation.rootPath, operation.agentId);
    this.#waiters.get(waiterKey)?.reject(new Error(`Session handoff failed safely: ${reason}`));
    this.#waiters.delete(waiterKey);
  }
}
