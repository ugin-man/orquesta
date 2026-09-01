import type { ApplicationState } from './state';
import type { WorkspaceSnapshot } from '../domain/models';
import { openAttentionItems } from './reducers/attention-reducer';

export type ProjectLifecycle =
  | 'no_project'
  | 'registered_inactive'
  | 'activating'
  | 'hydrating_snapshot'
  | 'bootstrapping_foundation'
  | 'preparation_failed'
  | 'ready'
  | 'migration_required'
  | 'recovery_required'
  | 'stopping';

export type ProjectSurface =
  | 'empty'
  | 'inactive'
  | 'preparing'
  | 'preparation_failed'
  | 'ready'
  | 'migration_required'
  | 'recovery_required'
  | 'stopping';

export type ApplicationSurface = 'startup' | 'workspace' | 'failure';

export function selectCurrentUserOrchestratorId(snapshot: WorkspaceSnapshot): string | null {
  const currentUser = snapshot.participants.find((participant) => participant.isCurrentUser) ?? null;
  const participantTarget = currentUser?.orchestratorAgentId ?? null;
  return participantTarget && snapshot.agents.some((agent) => agent.id === participantTarget)
    ? participantTarget
    : null;
}

export function selectProjectLifecycle(state: ApplicationState): ProjectLifecycle {
  if (state.phase === 'stopping') return 'stopping';
  const projectId = state.selectedProjectId;
  if (!projectId) return 'no_project';
  if (state.phase === 'activating') return 'activating';
  const authorityMatches = state.runtimeAuthority?.projectId === projectId;
  if (!authorityMatches) return 'registered_inactive';
  if (!state.projectStartPending && !state.projectBootstrap && state.error) return 'preparation_failed';
  if (!state.snapshot || state.snapshot.project.id !== projectId) return 'hydrating_snapshot';
  if (state.projectBootstrap?.status === 'migration_required') return 'migration_required';
  if (state.projectBootstrap?.status === 'unsupported'
    || state.projectBootstrap?.status === 'recovery_required') return 'recovery_required';
  const hasOrchestrator = Boolean(selectCurrentUserOrchestratorId(state.snapshot));
  if (state.projectStartPending || state.projectBootstrap?.status !== 'ready') {
    return 'bootstrapping_foundation';
  }
  if (!hasOrchestrator) return 'recovery_required';
  return 'ready';
}

export function selectProjectSurface(lifecycle: ProjectLifecycle): ProjectSurface {
  if (lifecycle === 'no_project') return 'empty';
  if (lifecycle === 'registered_inactive') return 'inactive';
  if (lifecycle === 'activating' || lifecycle === 'hydrating_snapshot'
    || lifecycle === 'bootstrapping_foundation') return 'preparing';
  return lifecycle;
}

export function selectApplicationSurface(state: ApplicationState): ApplicationSurface {
  if (state.phase === 'booting' && !state.snapshot && !state.runtimeAuthority) return 'startup';
  if (state.phase === 'failed' && !state.snapshot && !state.runtimeAuthority) return 'failure';
  return 'workspace';
}

export function projectLifecycleAllowsUserMutation(lifecycle: ProjectLifecycle): boolean {
  return lifecycle === 'ready';
}

export function projectLifecycleLocksConversation(lifecycle: ProjectLifecycle): boolean {
  return projectLifecycleIsTransitioning(lifecycle)
    || lifecycle === 'migration_required'
    || lifecycle === 'recovery_required'
    || lifecycle === 'preparation_failed';
}

export function projectLifecycleIsTransitioning(lifecycle: ProjectLifecycle): boolean {
  return lifecycle === 'activating'
    || lifecycle === 'hydrating_snapshot'
    || lifecycle === 'bootstrapping_foundation'
    || lifecycle === 'stopping';
}

export function selectProject(state: ApplicationState, projectId: string) {
  return state.projects.find((project) => project.id === projectId) ?? null;
}

export function selectAgentExists(state: ApplicationState, agentId: string): boolean {
  return state.snapshot?.agents.some((agent) => agent.id === agentId) ?? false;
}

export function selectSelectedExecution(state: ApplicationState) {
  return state.selectedAgentId ? state.executions[state.selectedAgentId] ?? null : null;
}

export function selectOpenAttention(state: ApplicationState) {
  return openAttentionItems(state.snapshot?.attention ?? [], state.projectedPendingRequests);
}

export function selectCurrentProjectDispatchRecovery(
  state: ApplicationState,
): ApplicationState['dispatchRecovery'] {
  const recovery = state.dispatchRecovery;
  return recovery && recovery.projectId === state.selectedProjectId ? recovery : null;
}
