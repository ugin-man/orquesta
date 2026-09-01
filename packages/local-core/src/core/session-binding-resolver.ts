import type { SessionBindingV1 } from '@orquesta/contracts';
import { readRuntimeBindingEvidence } from './runtime-binding-store';
import { SessionBindingStore, type SessionBindingReadResult } from './session-binding-store';

export interface ProjectCodexThread {
  id: string;
  cwd: string;
  name: string | null;
  archived: boolean;
  status: 'active' | 'idle' | 'notLoaded' | 'systemError' | string;
  updatedAt: number | string | null;
}

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
  attachmentToolState: 'supported' | 'unsupported';
}

export interface ActiveAgentSession {
  threadId: string;
  attachmentToolState: 'supported' | 'unsupported';
}

function attachmentToolState(binding: SessionBindingV1): 'supported' | 'unsupported' {
  return (binding as SessionBindingV1 & { attachment_tool_state?: unknown }).attachment_tool_state === 'supported'
    ? 'supported'
    : 'unsupported';
}

export class SessionBindingResolutionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SessionBindingResolutionError';
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new SessionBindingResolutionError(code, message);
}

function failReadState(result: Exclude<SessionBindingReadResult, { status: 'ready' }>): never {
  if (result.status === 'missing') {
    fail('SESSION_BINDING_STATE_MISSING', 'Canonical session binding state is not initialized');
  }
  if (result.status === 'migration_required') {
    fail('SESSION_BINDING_MIGRATION_REQUIRED', `${result.reason}: ${result.filePath}`);
  }
  fail('SESSION_BINDING_STATE_UNSUPPORTED', `${result.reason}: ${result.filePath}`);
}

function generation(binding: SessionBindingV1): AgentSessionGeneration {
  return {
    sessionId: binding.session_id,
    threadId: binding.thread_id,
    agentId: binding.agent_id,
    generation: binding.session_generation,
    rotationState: binding.rotation_state,
    ownershipStatus: binding.ownership_status,
    bindingStatus: binding.binding_status,
    runtimeAuthorityId: binding.runtime_authority_id,
    visibility: binding.visibility,
    profileId: binding.profile_id,
    sessionKind: binding.session_kind,
    createdAt: binding.created_at,
    updatedAt: binding.updated_at,
    attachmentToolState: attachmentToolState(binding)
  };
}

export class SessionBindingResolver {
  readonly #store: SessionBindingStore;

  constructor(store = new SessionBindingStore()) {
    this.#store = store;
  }

  async resolveActiveThread(rootPath: string, projectId: string, agentId: string): Promise<string> {
    return (await this.resolveActiveSession(rootPath, projectId, agentId)).threadId;
  }

  async resolveActiveSession(rootPath: string, projectId: string, agentId: string): Promise<ActiveAgentSession> {
    const { bindings, runtimeAuthorityId, expectedVisibility } = await this.#read(rootPath, projectId);
    const matches = bindings.filter((binding) => (
      binding.agent_id === agentId
      && binding.session_kind === 'persistent_agent'
      && binding.handoff_status === 'accepted'
      && binding.binding_status === 'bound'
      && binding.ownership_status === 'owner'
      && ['active', 'rotation_preparing', 'rotation_pending'].includes(binding.rotation_state)
      && binding.accepts_new_work
      && binding.runtime_authority_id === runtimeAuthorityId
      && binding.visibility === expectedVisibility
    ));
    if (matches.length === 0) {
      fail('SESSION_BINDING_ACTIVE_OWNER_MISSING', `Agent ${agentId} has no accepted active owner binding`);
    }
    if (matches.length > 1) {
      fail('SESSION_BINDING_ACTIVE_OWNER_AMBIGUOUS', `Agent ${agentId} has multiple accepted active owner bindings`);
    }
    return {
      threadId: matches[0].thread_id,
      attachmentToolState: attachmentToolState(matches[0])
    };
  }

  async resolveConversationSessions(
    rootPath: string,
    projectId: string,
    agentId: string
  ): Promise<AgentSessionGeneration[]> {
    const { bindings, runtimeAuthorityId, expectedVisibility } = await this.#read(rootPath, projectId);
    return bindings
      .filter((binding) => binding.agent_id === agentId
        && binding.session_kind === 'persistent_agent'
        && binding.handoff_status === 'accepted'
        && binding.binding_status === 'bound'
        && binding.runtime_authority_id === runtimeAuthorityId
        && binding.visibility === expectedVisibility
        && binding.ownership_status !== 'candidate'
        && !['failed', 'successor_warming', 'successor_verified'].includes(binding.rotation_state))
      .sort((left, right) => left.session_generation - right.session_generation
        || left.thread_id.localeCompare(right.thread_id))
      .map(generation);
  }

  async #read(rootPath: string, projectId: string): Promise<{
    bindings: SessionBindingV1[];
    runtimeAuthorityId: string;
    expectedVisibility: 'codex_task' | 'desktop_only';
  }> {
    const runtime = await readRuntimeBindingEvidence(rootPath);
    if (!runtime || runtime.binding.project_id !== projectId) {
      fail('SESSION_BINDING_RUNTIME_AUTHORITY_MISSING', 'Exact project runtime authority is unavailable');
    }
    const result = await this.#store.read(rootPath, projectId);
    if (result.status !== 'ready') failReadState(result);
    return {
      bindings: result.state.sessions,
      runtimeAuthorityId: runtime.binding.runtime_authority_id,
      expectedVisibility: runtime.binding.mode === 'codex_hosted' ? 'codex_task' : 'desktop_only'
    };
  }
}
