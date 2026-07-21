import type { SetupUiSnapshot } from '../../../contracts/orquesta-ui';
import type { SetupProgressEvent } from '../../../contracts/setup';

export function applySetupProgress(setup: SetupUiSnapshot, progress: SetupProgressEvent): SetupUiSnapshot {
  const phase = setup.phases.find((item) => item.id === progress.phaseId);
  if (!phase) return setup;
  const activityStatus = progress.status === 'failed'
    ? 'failed'
    : progress.status === 'completed'
      ? 'complete'
      : progress.status === 'queued'
        ? 'waiting'
        : 'active';
  const currentActivity = {
    id: `progress-${progress.phaseId}-${progress.status}`,
    title: phase.title,
    detail: progress.message,
    status: activityStatus,
    observedAt: progress.occurredAt
  } as const;
  const currentIndex = phase.order - 1;
  const phases = setup.phases.map((item, index) => {
    if (index < currentIndex) return { ...item, status: 'complete' as const };
    if (index > currentIndex) return { ...item, status: 'waiting' as const };
    return {
      ...item,
      status: progress.status === 'failed'
        ? 'blocked' as const
        : progress.status === 'completed'
          ? 'complete' as const
          : progress.status === 'queued'
            ? 'waiting' as const
            : 'active' as const
    };
  });
  const recentActivities = progress.status === 'completed'
    ? [...setup.recentActivities, currentActivity].slice(-16)
    : setup.recentActivities;
  const nextPhase = phases.find((item) => item.status === 'waiting') ?? null;

  return {
    ...setup,
    status: progress.status === 'failed' ? 'blocked' : 'running',
    currentPhaseId: progress.phaseId,
    phases,
    currentActivity,
    recentActivities,
    nextActivity: nextPhase ? {
      id: `next-${nextPhase.id}`,
      title: nextPhase.title,
      detail: nextPhase.summary,
      status: 'waiting',
      observedAt: null
    } : null,
    updatedAt: progress.occurredAt
  };
}
