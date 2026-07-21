import type { SetupActivityUiModel, SetupUiSnapshot } from '../../../contracts/orquesta-ui';
import type {
  SetupVisualLifecycle,
  SetupVisualLogEntry,
  SetupVisualPhase,
  SetupVisualPhaseId,
  SetupVisualState
} from './setup-visual-types';
import type { Locale } from '../i18n/messages';
import { getSetupCopy, localizeSetupActivity, localizeSetupPhase } from './setup-localization';

const PHASE_COPY: Record<SetupVisualPhaseId, { code: string }> = {
  1: { code: 'ENVIRONMENT' },
  2: { code: 'UNDERSTANDING' },
  3: { code: 'FOUNDATION' },
  4: { code: 'PLANNING' },
  5: { code: 'SPECIALISTS' },
  6: { code: 'OPERATION' }
};

function lifecycleFor(status: SetupUiSnapshot['status']): SetupVisualLifecycle {
  if (status === 'completed') return 'complete';
  if (status === 'blocked' || status === 'paused' || status === 'cancelled') return 'blocked';
  return 'running';
}

function visualPhaseId(order: number): SetupVisualPhaseId {
  return Math.min(6, Math.max(1, order)) as SetupVisualPhaseId;
}

function timeLabel(value: string | null, locale: Locale): string {
  if (!value) return '--:--:--';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '--:--:--';
  return new Intl.DateTimeFormat(locale === 'ja' ? 'ja-JP' : 'en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(date);
}

function activityLog(activity: SetupActivityUiModel, locale: Locale): SetupVisualLogEntry {
  const localized = localizeSetupActivity(activity, locale);
  const state = activity.status === 'complete'
    ? 'ok'
    : activity.status === 'failed'
      ? 'blocked'
      : activity.status === 'waiting'
        ? 'waiting'
        : 'running';
  const stateLabel = state === 'ok' ? 'OK' : state === 'blocked' ? 'STOP' : state === 'waiting' ? 'WAIT' : 'RUN';
  return {
    id: activity.id,
    time: timeLabel(activity.observedAt, locale),
    message: localized.title,
    state,
    stateLabel
  };
}

export function createSetupVisualState(setup: SetupUiSnapshot, reducedMotion: boolean, locale: Locale = 'ja'): SetupVisualState {
  const copy = getSetupCopy(locale);
  const activePhase = setup.phases.find((phase) => phase.id === setup.currentPhaseId)
    ?? setup.phases.find((phase) => phase.status === 'active' || phase.status === 'blocked')
    ?? null;
  const activePhaseId = activePhase ? visualPhaseId(activePhase.order) : null;
  const phases: SetupVisualPhase[] = setup.phases.map((phase) => {
    const localized = localizeSetupPhase(phase, locale);
    const id = visualPhaseId(phase.order);
    return {
      id,
      code: PHASE_COPY[id].code,
      title: localized.title,
      subtitle: localized.summary,
      status: phase.status,
      progress: phase.status === 'complete' ? 100 : phase.status === 'active' || phase.status === 'blocked' ? 50 : 0
    };
  });
  const completed = phases.filter((phase) => phase.status === 'complete').length;
  const overallProgress = setup.status === 'completed'
    ? 100
    : Math.round(((completed + (activePhase ? 1 : 0)) / phases.length) * 100);
  const logs = [
    ...setup.recentActivities.slice(-5).reverse(),
    ...(setup.currentActivity ? [setup.currentActivity] : [])
  ].slice(-6).map((activity) => activityLog(activity, locale));

  return {
    activePhaseId,
    lifecycle: lifecycleFor(setup.status),
    phases,
    overallProgress,
    reducedMotion,
    connection: {
      status: setup.status === 'preparing' ? 'connecting' : setup.status === 'cancelled' ? 'disconnected' : 'connected',
      label: setup.status === 'preparing' ? copy.connection.connecting : setup.status === 'cancelled' ? copy.connection.disconnected : copy.connection.connected,
      detail: setup.projectRootLabel
    },
    logs
  };
}
