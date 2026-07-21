import type { SetupActivityUiModel, SetupUiSnapshot } from '../../../contracts/orquesta-ui';
import type {
  SetupVisualLifecycle,
  SetupVisualLogEntry,
  SetupVisualPhase,
  SetupVisualPhaseId,
  SetupVisualState
} from './setup-visual-types';

const PHASE_COPY: Record<SetupVisualPhaseId, { code: string; subtitle: string }> = {
  1: { code: 'ENVIRONMENT', subtitle: '実行環境と保存先を確認' },
  2: { code: 'UNDERSTANDING', subtitle: '目的と既存資産を把握' },
  3: { code: 'FOUNDATION', subtitle: '基礎エージェントと状態領域を構築' },
  4: { code: 'PLANNING', subtitle: '最初の実行可能作業を設計' },
  5: { code: 'SPECIALISTS', subtitle: '必要な専門家を接続' },
  6: { code: 'OPERATION', subtitle: '初期体制と運用開始を確認' }
};

function lifecycleFor(status: SetupUiSnapshot['status']): SetupVisualLifecycle {
  if (status === 'completed') return 'complete';
  if (status === 'blocked' || status === 'paused' || status === 'cancelled') return 'blocked';
  return 'running';
}

function visualPhaseId(order: number): SetupVisualPhaseId {
  return Math.min(6, Math.max(1, order)) as SetupVisualPhaseId;
}

function timeLabel(value: string | null): string {
  if (!value) return '--:--:--';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '--:--:--';
  return new Intl.DateTimeFormat('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(date);
}

function activityLog(activity: SetupActivityUiModel): SetupVisualLogEntry {
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
    time: timeLabel(activity.observedAt),
    message: activity.title,
    state,
    stateLabel
  };
}

export function createSetupVisualState(setup: SetupUiSnapshot, reducedMotion: boolean): SetupVisualState {
  const activePhase = setup.phases.find((phase) => phase.id === setup.currentPhaseId)
    ?? setup.phases.find((phase) => phase.status === 'active' || phase.status === 'blocked')
    ?? null;
  const activePhaseId = activePhase ? visualPhaseId(activePhase.order) : null;
  const phases: SetupVisualPhase[] = setup.phases.map((phase) => {
    const id = visualPhaseId(phase.order);
    return {
      id,
      code: PHASE_COPY[id].code,
      title: phase.title,
      subtitle: phase.summary || PHASE_COPY[id].subtitle,
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
  ].slice(-6).map(activityLog);

  return {
    activePhaseId,
    lifecycle: lifecycleFor(setup.status),
    phases,
    overallProgress,
    reducedMotion,
    connection: {
      status: setup.status === 'preparing' ? 'connecting' : setup.status === 'cancelled' ? 'disconnected' : 'connected',
      label: setup.status === 'preparing' ? '接続中' : setup.status === 'cancelled' ? '切断' : '接続済み',
      detail: setup.projectRootLabel
    },
    logs
  };
}
