import { Activity, ArrowRight, Database, Expand, Timer } from 'lucide-react';
import type { AgentUiModel, TaskUiModel } from '../../../contracts/orquesta-ui';
import { AgentGlyph } from '../../components/AgentGlyph';
import { useI18n } from '../i18n/I18nProvider';

interface WorkItem {
  agent: AgentUiModel;
  task: TaskUiModel;
}

function activeItems(agents: AgentUiModel[], tasks: TaskUiModel[], allowActive: boolean): WorkItem[] {
  if (!allowActive) return [];
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return agents
    .filter((agent) => agent.id !== 'orchestrator' && agent.currentTaskId)
    .map((agent) => ({ agent, task: byId.get(agent.currentTaskId!) }))
    .filter((item): item is WorkItem => Boolean(item.task && (item.task.turnStarted || item.task.progressObserved)))
    .sort((a, b) => {
      const order = ['connector', 'coder', 'analyst'];
      return (order.indexOf(a.agent.id) < 0 ? 99 : order.indexOf(a.agent.id)) - (order.indexOf(b.agent.id) < 0 ? 99 : order.indexOf(b.agent.id));
    });
}

function elapsedLabel(task: TaskUiModel, fallback: number): string {
  if (!task.startedAt) return `${fallback}s`;
  const start = new Date(task.startedAt).getTime();
  const end = new Date(task.updatedAt ?? task.startedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return `${fallback}s`;
  const seconds = Math.max(fallback, Math.round((end - start) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;
}

export function NowCardStack({
  agents,
  tasks,
  allowActive,
  onOpenTask,
  onOpenAll
}: {
  agents: AgentUiModel[];
  tasks: TaskUiModel[];
  allowActive: boolean;
  onOpenTask(taskId: string, agentId: string): void;
  onOpenAll(): void;
}) {
  const { t } = useI18n();
  const items = activeItems(agents, tasks, allowActive);
  if (!items.length) {
    return (
      <section className="now-stack now-stack--empty" aria-label={t('now')}>
        <div className="now-empty-card">
          <span className="now-label">{t('now')}<i /></span>
          <div><Activity size={18} aria-hidden="true" /><strong>{t('noActiveWork')}</strong></div>
        </div>
      </section>
    );
  }

  const visible = items.slice(0, 2);
  const delegation = items.find((item) => item.agent.id === 'analyst') ?? items[2] ?? items[0];
  const hidden = Math.max(0, items.length - 3);

  return (
    <section className="now-stack" aria-label={t('now')}>
      {visible.map((item, index) => (
        <button key={item.task.id} type="button" className="now-card" onClick={() => onOpenTask(item.task.id, item.agent.id)}>
          <header><span className="now-label">{t('now')}<i /></span><Expand size={13} aria-hidden="true" /></header>
          <div className="now-card__content">
            <span className="now-card__icon"><AgentGlyph iconKey={item.agent.iconKey} size={20} /></span>
            <div className="now-card__copy">
              <div><strong>{t('working')}</strong><time>{elapsedLabel(item.task, index ? 47 : 28)}</time></div>
              <span>{item.agent.displayName}</span>
              <p>{item.task.progressSummary ?? item.task.title}</p>
              <span className="now-progress"><i style={{ width: `${item.task.progressPercent ?? 30}%` }} /></span>
            </div>
          </div>
        </button>
      ))}

      <button type="button" className="now-card now-card--delegation" onClick={() => onOpenTask(delegation.task.id, delegation.agent.id)}>
        <header><span className="now-label">{t('now')}<i /></span><Expand size={13} aria-hidden="true" /></header>
        <div className="now-card__content">
          <span className="now-card__icon now-card__icon--active"><span /></span>
          <div className="now-card__copy">
            <div><strong>Active delegation</strong><time>12s</time></div>
            <span><b>{delegation.task.id}</b> {delegation.task.title}</span>
            <p>Orchestrator <ArrowRight size={12} aria-hidden="true" /> {delegation.agent.displayName}</p>
            <span className="now-progress"><i style={{ width: `${delegation.task.progressPercent ?? 58}%` }} /></span>
          </div>
        </div>
      </button>

      {hidden > 0 ? (
        <button type="button" className="now-more" onClick={onOpenAll}><Timer size={15} />{hidden} {t('moreActive')}</button>
      ) : null}
    </section>
  );
}
