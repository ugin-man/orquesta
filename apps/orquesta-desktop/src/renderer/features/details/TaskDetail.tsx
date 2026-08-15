import { Check, Circle, FileOutput, GitBranch, Link2, Play, Send, Sparkles } from 'lucide-react';
import type { AgentUiModel, TaskUiModel } from '../../../contracts/orquesta-ui';
import { OverlayFrame } from '../../components/OverlayFrame';
import { formatDateTime, statusLabel } from '../../components/format';
import { useI18n } from '../i18n/I18nProvider';

function EvidenceState({ value }: { value: boolean }) {
  const { t } = useI18n();
  return <span className={`proof-state${value ? ' is-proven' : ''}`}>{value ? <Check size={13} /> : <Circle size={11} />}{value ? t('observed') : t('notObserved')}</span>;
}

function TaskRow({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="task-detail-row"><dt>{label}</dt><dd>{children}</dd></div>;
}

export function TaskDetail({ task, agents, onClose }: { task: TaskUiModel; agents: AgentUiModel[]; onClose(): void }) {
  const { t } = useI18n();
  const agentById = new Map(agents.map((agent) => [agent.id, agent.displayName]));
  const owner = task.ownerAgentId ? agentById.get(task.ownerAgentId) ?? task.ownerAgentId : t('unknown');
  const assigner = task.assignedByAgentId === 'user' ? 'You' : task.assignedByAgentId ? agentById.get(task.assignedByAgentId) ?? task.assignedByAgentId : t('unknown');
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
