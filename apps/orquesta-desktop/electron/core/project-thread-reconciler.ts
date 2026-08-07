import { readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { selectActiveAgentSession } from '@orquesta/execution-kernel';
import { readRuntimeBinding } from './runtime-binding-store';

export interface ProjectCodexThread {
  id: string;
  cwd: string;
  name: string | null;
  archived: boolean;
  status: 'active' | 'idle' | 'notLoaded' | 'systemError' | string;
  updatedAt: number | string | null;
}

export interface ProjectThreadReconcilerOptions {
  listProjectThreads(rootPath: string): Promise<ProjectCodexThread[]>;
  setThreadName?(input: { correlationId: string; threadId: string; name: string }): Promise<void>;
  now?: () => Date;
}

type JsonRecord = Record<string, unknown>;

export interface AgentSessionGeneration {
  sessionId: string;
  threadId: string;
  agentId: string;
  generation: number;
  rotationState: string;
  ownershipStatus: string;
  bindingStatus: string;
  runtimeAuthorityId: string | null;
  visibility: string | null;
  profileId: string | null;
  sessionKind: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

function record(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
}

function safeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function timestamp(value: number | string | null, fallback: string): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value > 10_000_000_000 ? value : value * 1_000).toISOString();
  }
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return fallback;
}

function comparableWindowsPath(value: string): string {
  return path.resolve(value).replaceAll('/', '\\').toLowerCase();
}

export class ProjectThreadReconciler {
  readonly #listProjectThreads: ProjectThreadReconcilerOptions['listProjectThreads'];
  readonly #setThreadName: ProjectThreadReconcilerOptions['setThreadName'];
  readonly #now: () => Date;
  readonly #reconcileByRoot = new Map<string, Promise<void>>();

  constructor(options: ProjectThreadReconcilerOptions) {
    this.#listProjectThreads = options.listProjectThreads;
    this.#setThreadName = options.setThreadName;
    this.#now = options.now ?? (() => new Date());
  }

  async reconcile(rootPath: string): Promise<void> {
    const canonicalRoot = await realpath(rootPath);
    const current = this.#reconcileByRoot.get(canonicalRoot);
    if (current) return current;
    const pending = this.#reconcileCanonicalRoot(canonicalRoot);
    this.#reconcileByRoot.set(canonicalRoot, pending);
    try {
      await pending;
    } finally {
      if (this.#reconcileByRoot.get(canonicalRoot) === pending) {
        this.#reconcileByRoot.delete(canonicalRoot);
      }
    }
  }

  async #reconcileCanonicalRoot(canonicalRoot: string): Promise<void> {
    const statePath = path.join(canonicalRoot, '.orquesta', 'state', 'sessions.json');
    const agentsPath = path.join(canonicalRoot, '.orquesta', 'state', 'agents.json');
    let state: JsonRecord;
    try {
      state = record(JSON.parse(await readFile(statePath, 'utf8'))) ?? {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    let agents: JsonRecord[] = [];
    try {
      const agentsState = record(JSON.parse(await readFile(agentsPath, 'utf8')));
      agents = Array.isArray(agentsState?.agents) ? agentsState.agents.flatMap((value) => record(value) ?? []) : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const now = this.#now().toISOString();
    const runtimeBinding = await readRuntimeBinding(canonicalRoot);
    let rotationSessions: JsonRecord[] = [];
    try {
      const rotation = record(JSON.parse(await readFile(path.join(canonicalRoot, '.orquesta', 'state', 'session-rotation.json'), 'utf8')));
      const entries = record(rotation?.sessions);
      rotationSessions = Object.values(entries ?? {}).flatMap((value) => record(value) ?? []);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const workspaceByAgent = new Map<string, string>();
    const agentByThreadId = new Map<string, string>();
    const ambiguousThreadIds = new Set<string>();
    for (const agent of agents) {
      const agentId = safeString(agent.agent_id);
      const threadId = safeString(agent.thread_id);
      if (!agentId) continue;
      const workspacePath = safeString(agent.workspace_path);
      if (workspacePath && agent.lifecycle_state !== 'superseded' && threadId) {
        try {
          workspaceByAgent.set(agentId, await realpath(workspacePath));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      if (!threadId || ambiguousThreadIds.has(threadId)) continue;
      const existing = agentByThreadId.get(threadId);
      if (existing && existing !== agentId) {
        agentByThreadId.delete(threadId);
        ambiguousThreadIds.add(threadId);
      } else {
        agentByThreadId.set(threadId, agentId);
      }
    }
    const recordedWorkspaceRoots = (await Promise.all((Array.isArray(state.sessions) ? state.sessions : []).map(async (value) => {
      const workspacePath = safeString(record(value)?.cwd);
      if (!workspacePath) return null;
      try {
        return await realpath(workspacePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    }))).flatMap((value) => value ?? []);
    // Existing Codex tasks may have been created from a managed worktree or the local
    // checkout. Keep the logical Orquesta tree complete by discovering every recorded
    // session root instead of assuming cwd is identical to the canonical state root.
    const workspaceRoots = [...new Set([canonicalRoot, ...workspaceByAgent.values(), ...recordedWorkspaceRoots])];
    const threads = (await Promise.all(workspaceRoots.map((workspaceRoot) => (
      this.#listProjectThreads(workspaceRoot)
    )))).flat();
    const byId = new Map(threads.map((thread) => [thread.id, thread]));
    const sessionByThread = new Map<string, JsonRecord>();
    for (const value of Array.isArray(state.sessions) ? state.sessions : []) {
      const session = record(value);
      const threadId = safeString(session?.thread_id);
      if (session && threadId) sessionByThread.set(threadId, session);
    }
    // The rotation registry is the ownership source of truth. Repository refreshes may race
    // with a cutover, so merge every recorded generation back before projecting live status.
    for (const rotation of rotationSessions) {
      const threadId = safeString(rotation.thread_id);
      if (!threadId) continue;
      sessionByThread.set(threadId, {
        ...(sessionByThread.get(threadId) ?? {}),
        session_id: safeString(rotation.session_id) ?? threadId,
        thread_id: threadId,
        agent_id: safeString(rotation.agent_id),
        session_generation: Number.isInteger(rotation.session_generation) ? rotation.session_generation : 1,
        rotation_state: safeString(rotation.rotation_state) ?? 'active',
        ownership_status: safeString(rotation.ownership_status) ?? 'owner',
        accepts_new_work: rotation.accepts_new_work !== false,
        replaces_session_id: safeString(rotation.replaces_session_id),
        replaced_by_session_id: safeString(rotation.replaced_by_session_id),
      });
    }
    const sessions = [...sessionByThread.values()];
    const desiredTitleByAgent = new Map<string, string>();
    const titlePriority = (title: string) => title.startsWith('★') ? 3 : title.startsWith('Orquesta ') ? 2 : 1;
    for (const session of sessions) {
      const agentId = safeString(session.agent_id);
      const title = safeString(session.title);
      if (!agentId || !title) continue;
      const existing = desiredTitleByAgent.get(agentId);
      if (!existing || titlePriority(title) >= titlePriority(existing)) desiredTitleByAgent.set(agentId, title);
    }
    for (const agent of agents) {
      const agentId = safeString(agent.agent_id);
      const displayName = safeString(agent.display_name);
      if (!agentId || !displayName) continue;
      // A starred registry name is an explicit user-facing title policy. Plain role
      // labels do not replace a more descriptive persisted title such as Luca's.
      if (displayName.startsWith('★') || !desiredTitleByAgent.has(agentId)) {
        desiredTitleByAgent.set(agentId, displayName);
      }
    }
    const titleSyncStatusByThread = new Map<string, 'synced' | 'error'>();
    if (this.#setThreadName) {
      const renameRequests = sessions.flatMap((session) => {
        const threadId = safeString(session.thread_id);
        const agentId = safeString(session.agent_id) ?? (threadId ? agentByThreadId.get(threadId) ?? null : null);
        const expectedTitle = agentId ? desiredTitleByAgent.get(agentId) ?? null : null;
        const thread = threadId ? byId.get(threadId) : null;
        if (!threadId || !expectedTitle || !thread || thread.archived
          || safeString(session.ownership_status) === 'superseded'
          || safeString(session.rotation_state) === 'superseded') return [];
        if (thread.name === expectedTitle) {
          titleSyncStatusByThread.set(threadId, 'synced');
          return [];
        }
        return [{ threadId, expectedTitle, thread }];
      });
      const renameResults = await Promise.allSettled(renameRequests.map((request) => this.#setThreadName!({
        correlationId: `project-thread-title:${request.threadId}`,
        threadId: request.threadId,
        name: request.expectedTitle
      })));
      renameResults.forEach((result, index) => {
        const request = renameRequests[index];
        if (result.status === 'fulfilled') {
          request.thread.name = request.expectedTitle;
          titleSyncStatusByThread.set(request.threadId, 'synced');
        } else {
          titleSyncStatusByThread.set(request.threadId, 'error');
        }
      });
    }
    const reconciled = sessions.map((value) => {
      const session = record(value) ?? {};
      const threadId = safeString(session.thread_id);
      if (!threadId) {
        return { ...session, binding_status: 'unbound', runtime_status: 'unbound', status: 'stale', updated_at: now };
      }
      const agentId = safeString(session.agent_id) ?? agentByThreadId.get(threadId) ?? null;
      const migratedSession = agentId ? { ...session, agent_id: agentId } : session;
      if (runtimeBinding) {
        const sessionAuthorityId = safeString(session.runtime_authority_id);
        if (!sessionAuthorityId) {
          return { ...migratedSession, binding_status: 'authority_unverified', runtime_status: 'unverified', status: 'stale', updated_at: now };
        }
        if (sessionAuthorityId !== runtimeBinding.runtime_authority_id) {
          return { ...migratedSession, binding_status: 'authority_conflict', runtime_status: 'conflict', status: 'stale', updated_at: now };
        }
        const expectedVisibility = runtimeBinding.mode === 'codex_hosted' ? 'codex_task' : 'desktop_only';
        if (safeString(session.visibility) !== expectedVisibility) {
          return { ...migratedSession, binding_status: 'visibility_conflict', runtime_status: 'conflict', status: 'stale', updated_at: now };
        }
        if (safeString(session.session_kind) !== 'persistent_agent') {
          return { ...migratedSession, binding_status: 'session_kind_conflict', runtime_status: 'conflict', status: 'stale', updated_at: now };
        }
      }
      const thread = byId.get(threadId);
      if (!thread) {
        return { ...migratedSession, binding_status: 'missing', runtime_status: 'missing', status: 'stale', updated_at: now };
      }
      const recordedCwd = safeString(session.cwd);
      const allowedCwds = new Set([canonicalRoot, ...(agentId && workspaceByAgent.has(agentId) ? [workspaceByAgent.get(agentId)!] : []), ...(recordedCwd ? [recordedCwd] : [])]
        .map(comparableWindowsPath));
      if (!allowedCwds.has(comparableWindowsPath(thread.cwd))) {
        return { ...migratedSession, binding_status: 'cwd_mismatch', runtime_status: thread.status, status: 'stale', updated_at: now };
      }
      if (thread.archived) {
        return { ...migratedSession, binding_status: 'archived', runtime_status: 'archived', status: 'stale', updated_at: now };
      }
      return {
        ...migratedSession,
        binding_status: 'bound',
        runtime_status: thread.status,
        status: thread.status === 'active' ? 'working' : 'standby',
        title: thread.name ?? (agentId ? desiredTitleByAgent.get(agentId) : null) ?? session.title ?? null,
        ...(titleSyncStatusByThread.has(threadId) ? { title_sync_status: titleSyncStatusByThread.get(threadId) } : {}),
        cwd: thread.cwd,
        last_seen: timestamp(thread.updatedAt, now),
        updated_at: now
      };
    });
    const next = {
      ...state,
      source: 'codex_app.thread_list',
      project_cwd: canonicalRoot,
      synced_at: now,
      updated_at: now,
      sessions: reconciled
    };
    const temporary = `${statePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    await rename(temporary, statePath);
  }

  async resolveBoundThread(rootPath: string, agentId: string): Promise<string> {
    const sessions = await this.resolveAgentSessions(rootPath, agentId);
    const sessionProjection = sessions.map((session) => ({
      session_id: session.sessionId,
      thread_id: session.threadId,
      agent_id: session.agentId,
      session_generation: session.generation,
      rotation_state: session.rotationState,
      ownership_status: session.ownershipStatus,
      binding_status: session.bindingStatus,
      updated_at: session.updatedAt
    }));
    let registryProjection: Array<Record<string, unknown>> = [];
    try {
      const canonicalRoot = await realpath(rootPath);
      const registry = record(JSON.parse(await readFile(path.join(canonicalRoot, '.orquesta', 'state', 'session-rotation.json'), 'utf8')));
      const registrySessions = record(registry?.sessions);
      const bindingByThread = new Map(sessions.map((session) => [session.threadId, session.bindingStatus]));
      registryProjection = Object.values(registrySessions ?? {}).flatMap((value) => {
        const item = record(value);
        const threadId = safeString(item?.thread_id);
        if (!item || !threadId) return [];
        return [{ ...item, binding_status: bindingByThread.get(threadId) ?? 'unbound' }];
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // Rotation entries override the matching persisted generation, but the registry is
    // intentionally sparse: agents that have never rotated are not recorded there.
    // Do not let an unrelated agent's first rotation hide every non-rotated agent.
    const registryThreadIds = new Set(registryProjection.flatMap((session) => {
      const threadId = safeString(session.thread_id);
      return threadId ? [threadId] : [];
    }));
    const selectionProjection = [
      ...sessionProjection.filter((session) => !registryThreadIds.has(session.thread_id)),
      ...registryProjection
    ];
    const selected = selectActiveAgentSession(selectionProjection, agentId);
    const threadId = safeString(selected?.thread_id);
    if (!threadId) throw new Error(`Agent ${agentId} is not bound to a live Codex thread`);
    return threadId;
  }

  async resolveAgentSessions(rootPath: string, agentId: string): Promise<AgentSessionGeneration[]> {
    const canonicalRoot = await realpath(rootPath);
    const statePath = path.join(canonicalRoot, '.orquesta', 'state', 'sessions.json');
    const state = record(JSON.parse(await readFile(statePath, 'utf8')));
    const sessions = Array.isArray(state?.sessions) ? state.sessions : [];
    return sessions.map(record).flatMap((session) => {
      const threadId = safeString(session?.thread_id);
      const sessionAgentId = safeString(session?.agent_id);
      if (!threadId || sessionAgentId !== agentId) return [];
      return [{
        sessionId: safeString(session?.session_id) ?? threadId,
        threadId,
        agentId: sessionAgentId,
        generation: Number.isInteger(session?.session_generation) && Number(session?.session_generation) > 0
          ? Number(session?.session_generation)
          : 1,
        rotationState: safeString(session?.rotation_state) ?? 'active',
        ownershipStatus: safeString(session?.ownership_status) ?? 'owner',
        bindingStatus: safeString(session?.binding_status) ?? 'unbound',
        runtimeAuthorityId: safeString(session?.runtime_authority_id),
        visibility: safeString(session?.visibility),
        profileId: safeString(session?.profile_id),
        sessionKind: safeString(session?.session_kind),
        createdAt: safeString(session?.created_at),
        updatedAt: safeString(session?.updated_at)
      }];
    });
  }

  async resolveConversationSessions(rootPath: string, agentId: string): Promise<AgentSessionGeneration[]> {
    const sessions = await this.resolveAgentSessions(rootPath, agentId);
    const visible = sessions
      .filter((session) => ['bound', 'archived'].includes(session.bindingStatus)
        || (session.ownershipStatus === 'superseded' && session.rotationState === 'superseded'))
      .filter((session) => session.ownershipStatus !== 'candidate')
      .filter((session) => !['failed', 'successor_warming', 'successor_verified'].includes(session.rotationState))
      .sort((left, right) => left.generation - right.generation || left.threadId.localeCompare(right.threadId));
    if (!visible.length) throw new Error(`Agent ${agentId} has no readable Codex conversation`);
    return visible;
  }
}
