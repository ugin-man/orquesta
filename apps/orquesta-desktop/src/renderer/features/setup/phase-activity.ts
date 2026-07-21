import type {
  SetupVisualLifecycle,
  SetupVisualPhaseId,
  SetupVisualPhaseStatus,
  SetupVisualState
} from './setup-visual-types';

export interface PhaseActivityState {
  status: SetupVisualPhaseStatus;
  running: boolean;
  emphasis: 'current' | 'blocked' | 'none';
}

function highestRunningPhase(lifecycle: SetupVisualLifecycle, activePhaseId: SetupVisualPhaseId | null): SetupVisualPhaseId | 0 {
  if (lifecycle === 'complete') return 6;
  return activePhaseId ?? 0;
}

export function getPhaseActivity(state: SetupVisualState, phaseId: SetupVisualPhaseId): PhaseActivityState {
  const status = state.phases.find((phase) => phase.id === phaseId)?.status ?? 'waiting';
  const highest = highestRunningPhase(state.lifecycle, state.activePhaseId);
  const blockedCurrent = status === 'blocked' && state.activePhaseId === phaseId;
  const running = phaseId <= highest && !blockedCurrent;
  return {
    status,
    running,
    emphasis: blockedCurrent ? 'blocked' : running && status !== 'waiting' ? 'current' : 'none'
  };
}

export function phaseActivityAttributes(state: SetupVisualState, phaseId: SetupVisualPhaseId) {
  const activity = getPhaseActivity(state, phaseId);
  return {
    'data-phase-id': phaseId,
    'data-phase-status': activity.status,
    'data-mechanism-running': String(activity.running),
    'data-phase-emphasis': activity.emphasis
  } as const;
}
