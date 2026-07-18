import { BookOpen, CircleAlert, Clock3, FileOutput, Link2, ShieldBan } from 'lucide-react';
import { useState } from 'react';
import type { AgentUiModel, TaskUiModel } from '../../../contracts/orquesta-ui';
import { AgentGlyph } from '../../components/AgentGlyph';
import { OverlayFrame } from '../../components/OverlayFrame';
import { formatDateTime, statusLabel } from '../../components/format';
import { useI18n } from '../i18n/I18nProvider';

type Tab = 'now' | 'context' | 'evidence' | 'history';

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return <div className="detail-row"><dt>{label}</dt><dd>{value || '—'}</dd></div>;
}

export function AgentDetail({ agent, task, onOpenTask, onClose }: {
  agent: AgentUiModel;
  task: TaskUiModel | null;
  onOpenTask(taskId: string): void;
  onClose(): void;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>('now');
  return (
    <OverlayFrame
      title={<span className="detail-title"><span className="detail-title__icon"><AgentGlyph iconKey={agent.iconKey} size={22} /></span><span>{agent.displayName}<small>{agent.role} · {agent.roleSummary}</small></span></span>}
      ariaLabel={`${agent.displayName} detail`}
      className="agent-detail inspector-overlay"
      onClose={onClose}
      modal={false}
      subtitle={<span className={`evidence-pill evidence-pill--${agent.statusEvidence}`}>{statusLabel(agent.status)} · {statusLabel(agent.statusEvidence)} evidence</span>}
    >
      <nav className="detail-tabs" aria-label="Agent detail sections">
        {(['now', 'context', 'evidence', 'history'] as Tab[]).map((value) => (
          <button type="button" key={value} className={tab === value ? 'is-active' : ''} onClick={() => setTab(value)}>
            {value === 'now' ? t('nowTab') : value === 'context' ? t('contextTab') : value === 'evidence' ? t('evidenceTab') : t('historyTab')}
          </button>
        ))}
      </nav>

      {tab === 'now' ? (
        <div className="detail-section">
          {task ? (
            <button type="button" className="agent-current-task" onClick={() => onOpenTask(task.id)}>
              <span><b>{task.id}</b>{t('currentTask')}</span><strong>{task.title}</strong><small>{task.progressSummary ?? statusLabel(task.state)}</small>
            </button>
          ) : <div className="empty-detail">{t('noActiveWork')}</div>}
          <dl className="detail-grid">
            <DetailRow label={t('assignedBy')} value={agent.assignedByAgentId ?? '—'} />
            <DetailRow label={t('lastEvidence')} value={formatDateTime(agent.lastEvidenceAt)} />
            <DetailRow label={t('lastHeartbeat')} value={formatDateTime(agent.lastHeartbeatAt)} />
            <DetailRow label={t('blockedReason')} value={agent.blockedReason ?? '—'} />
            <DetailRow label={t('waitingOn')} value={agent.waitingOn ?? '—'} />
            <DetailRow label={t('expectedArtifact')} value={agent.expectedArtifact ?? '—'} />
          </dl>
        </div>
      ) : null}

      {tab === 'context' ? (
        <div className="detail-section">
          <dl className="detail-grid">
            <DetailRow label={t('contextScope')} value={agent.contextScope ?? '—'} />
            <DetailRow label={t('requiredReading')} value={`${agent.requiredReadingCount} references`} />
          </dl>
          <section className="detail-block"><h3><ShieldBan size={15} />{t('forbiddenActions')}</h3><ul>{agent.forbiddenActions.map((item) => <li key={item}>{item}</li>)}</ul></section>
        </div>
      ) : null}

      {tab === 'evidence' ? (
        <div className="detail-section">
          <section className="detail-block"><h3><Link2 size={15} />{t('recentEvidence')}</h3>
            {agent.recentEvidence.length ? <ul className="evidence-list">{agent.recentEvidence.map((item) => <li key={item.id}><span className={`evidence-marker evidence-marker--${item.level}`} /><div><strong>{item.label}</strong><p>{item.detail}</p><small>{formatDateTime(item.observedAt)} · {item.level}</small></div></li>)}</ul> : <div className="empty-detail"><CircleAlert size={16} />No runtime evidence available.</div>}
          </section>
        </div>
      ) : null}

      {tab === 'history' ? (
        <div className="detail-section">
          {agent.history.length ? <ol className="history-list">{agent.history.map((item) => <li key={item.id}><Clock3 size={14} /><div><strong>{item.title}</strong><span>{item.state} · {formatDateTime(item.changedAt)}</span></div></li>)}</ol> : <div className="empty-detail"><BookOpen size={16} />No recent task history.</div>}
        </div>
      ) : null}
    </OverlayFrame>
  );
}
