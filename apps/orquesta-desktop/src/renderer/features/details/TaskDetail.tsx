import { Check, Circle, Clock, FileOutput, GitBranch, Link2, Play, Send, Sparkles } from 'lucide-react';
import type { AgentUiModel, TaskUiModel } from '../../../contracts/orquesta-ui';
import type { RuntimeEstimateUiModel } from '../../../contracts/runtime-estimate-ui';
import { OverlayFrame } from '../../components/OverlayFrame';
import { formatDateTime, statusLabel } from '../../components/format';
import { useI18n } from '../i18n/I18nProvider';
import './runtime-estimate.css';

function EvidenceState({ value }: { value: boolean }) {
  const { t } = useI18n();
  return <span className={`proof-state${value ? ' is-proven' : ''}`}>{value ? <Check size={13} /> : <Circle size={11} />}{value ? t('observed') : t('notObserved')}</span>;
}

function TaskRow({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="task-detail-row"><dt>{label}</dt><dd>{children}</dd></div>;
}

function formatMinutes(minutes: number): string {
  if (minutes === 0) return '0m';
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 24) {
    const value = hours >= 10 ? Math.round(hours).toString() : hours.toFixed(1).replace(/\.0$/u, '');
    return `${value}h`;
  }
  const days = hours / 24;
  const value = days >= 10 ? Math.round(days).toString() : days.toFixed(1).replace(/\.0$/u, '');
  return `${value}d`;
}

function RuntimeRange({ value }: { value: RuntimeEstimateUiModel['agentActiveMinutes'] }) {
  return <><strong>P50 {formatMinutes(value.p50)}</strong><small>P80 {formatMinutes(value.p80)}</small></>;
}

export function TaskDetail({ task, agents, onClose }: { task: TaskUiModel; agents: AgentUiModel[]; onClose(): void }) {
  const { t, locale } = useI18n();
  const labels = locale === 'ja'
    ? {
      section: 'AI作業時間',
      agentActive: 'AI実働',
      elapsed: '完了までの経過',
      human: '人間の作業',
      calibration: '校正',
      agentDecomposed: 'AI分解済み',
      profileInferred: '初期推定',
      unknownSource: '出典不明',
      coldStart: '初期値',
      hybrid: '混合校正',
      historical: '実測校正',
      unknownCalibration: '未校正',
      samples: '件',
      excludedWait: (count: number) => `完了時刻には、時間不明の外部待機 ${count} 件を含めていません。`
    }
    : {
      section: 'AI runtime estimate',
      agentActive: 'Agent active',
      elapsed: 'Elapsed to done',
      human: 'Human work',
      calibration: 'Calibration',
      agentDecomposed: 'Agent-decomposed',
      profileInferred: 'Profile-inferred',
      unknownSource: 'Unknown source',
      coldStart: 'Cold start',
      hybrid: 'Hybrid',
      historical: 'Historical',
      unknownCalibration: 'Uncalibrated',
      samples: ' samples',
      excludedWait: (count: number) => `${count} unknown external wait${count === 1 ? '' : 's'} excluded from the completion clock.`
    };
  const agentById = new Map(agents.map((agent) => [agent.id, agent.displayName]));
  const owner = task.ownerAgentId ? agentById.get(task.ownerAgentId) ?? task.ownerAgentId : t('unknown');
  const assigner = task.assignedByAgentId === 'user' ? 'You' : task.assignedByAgentId ? agentById.get(task.assignedByAgentId) ?? task.assignedByAgentId : t('unknown');
  const estimate = task.runtimeEstimate ?? null;
  const sourceLabel = estimate?.source === 'agent_decomposed'
    ? labels.agentDecomposed
    : estimate?.source === 'profile_inferred'
      ? labels.profileInferred
      : labels.unknownSource;
  const calibrationLabel = estimate?.calibrationMode === 'historical'
    ? labels.historical
    : estimate?.calibrationMode === 'hybrid'
      ? labels.hybrid
      : estimate?.calibrationMode === 'cold_start'
        ? labels.coldStart
        : labels.unknownCalibration;
  return (
    <OverlayFrame
      title={<span>{task.id} <small className="overlay-title-separator">/</small> {task.title}</span>}
      subtitle={<span className={`state-label state-label--${task.state}`}>{statusLabel(task.state)}</span>}
      ariaLabel={`Task ${task.id}`}
      className="task-detail inspector-overlay"
      onClose={onClose}
      modal={false}
    >
      <section className="task-progress-summary">
        <div><span>{task.progressSummary ?? statusLabel(task.state)}</span><strong>{task.progressPercent == null ? '—' : `${task.progressPercent}%`}</strong></div>
        <span className="task-progress-track"><i style={{ width: `${task.progressPercent ?? 0}%` }} /></span>
      </section>

      <dl className="task-detail-grid">
        <TaskRow label="Owner">{owner}</TaskRow>
        <TaskRow label={t('assignedBy')}>{assigner}</TaskRow>
        <TaskRow label={t('routingClass')}>{task.routingClass ?? t('unknown')}</TaskRow>
        <TaskRow label={t('dependencies')}>{task.dependencies.length ? task.dependencies.join(', ') : '—'}</TaskRow>
        <TaskRow label={t('blockedBy')}>{task.blockedBy.length ? task.blockedBy.join(', ') : '—'}</TaskRow>
        <TaskRow label={t('expectedArtifact')}>{task.expectedArtifact ?? '—'}</TaskRow>
      </dl>

      {estimate ? (
        <section className="runtime-estimate" aria-label={labels.section}>
          <header><h3><Clock size={15} />{labels.section}</h3><span className="runtime-estimate__source">{sourceLabel}</span></header>
          <dl>
            <TaskRow label={labels.agentActive}><RuntimeRange value={estimate.agentActiveMinutes} /></TaskRow>
            <TaskRow label={labels.elapsed}><RuntimeRange value={estimate.elapsedMinutes} /></TaskRow>
            <TaskRow label={labels.human}><RuntimeRange value={estimate.humanInterventionMinutes} /></TaskRow>
            <TaskRow label={t('confidence')}><strong>{estimate.confidence == null ? t('unknown') : `${Math.round(estimate.confidence * 100)}%`}</strong></TaskRow>
            <TaskRow label={labels.calibration}>
              <strong>{calibrationLabel}</strong>
              <small>{estimate.calibrationSampleCount == null ? t('notRecorded') : `${estimate.calibrationSampleCount}${labels.samples}`}</small>
            </TaskRow>
          </dl>
          {estimate.unknownBlockingGateCount > 0 ? <p className="runtime-estimate__note">{labels.excludedWait(estimate.unknownBlockingGateCount)}</p> : null}
        </section>
      ) : null}

      <section className="evidence-ladder" aria-label="Execution evidence">
        <h3><Sparkles size={15} />Execution evidence</h3>
        <div><span><Send size={14} />{t('handoffSent')}</span><EvidenceState value={task.handoffSent} /></div>
        <div><span><GitBranch size={14} />{t('dispatchAccepted')}</span><EvidenceState value={task.dispatchAccepted} /></div>
        <div><span><Play size={14} />{t('turnStarted')}</span><EvidenceState value={task.turnStarted} /></div>
        <div><span><Link2 size={14} />{t('progressObserved')}</span><EvidenceState value={task.progressObserved} /></div>
      </section>

      <section className="model-evidence">
        <h3>Model routing</h3>
        <dl>
          <TaskRow label={t('recommendedModel')}>{task.recommendedModel ?? t('unknown')}</TaskRow>
          <TaskRow label={t('requestedModel')}>{task.requestedModel ?? t('unknown')}</TaskRow>
          <TaskRow label={t('actualModel')}><span>{task.actualModel ?? t('unknown')}</span><small>{statusLabel(task.actualModelEvidence)} evidence</small></TaskRow>
        </dl>
      </section>

      <section className="detail-block"><h3><FileOutput size={15} />{t('acceptanceChecks')}</h3>{task.acceptanceChecks.length ? <ul>{task.acceptanceChecks.map((check) => <li key={check}>{check}</li>)}</ul> : <p>—</p>}</section>
      <footer className="task-timestamps">Started {formatDateTime(task.startedAt)} · Updated {formatDateTime(task.updatedAt)}</footer>
    </OverlayFrame>
  );
}
