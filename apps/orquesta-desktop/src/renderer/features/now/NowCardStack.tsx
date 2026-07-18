import { Activity, Expand, ListTodo } from 'lucide-react';
import type { AgentUiModel, TaskUiModel } from '../../../contracts/orquesta-ui';
import { AgentGlyph } from '../../components/AgentGlyph';
import { useI18n } from '../i18n/I18nProvider';

export interface WorkItem { agent: AgentUiModel; task: TaskUiModel }

export function activeItems(agents: AgentUiModel[], tasks: TaskUiModel[], allowActive: boolean): WorkItem[] {
  if (!allowActive) return [];
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return agents
    .filter((agent) => agent.id !== 'orchestrator' && agent.status === 'working' && agent.statusEvidence === 'proven' && agent.currentTaskId)
    .map((agent) => ({ agent, task: byId.get(agent.currentTaskId!) }))
    .filter((item): item is WorkItem => Boolean(item.task && (item.task.turnStarted || item.task.progressObserved)))
    .sort((left, right) => (right.task.updatedAt ?? '').localeCompare(left.task.updatedAt ?? '') || left.agent.id.localeCompare(right.agent.id));
}

function elapsedLabel(task: TaskUiModel): string {
  if (!task.startedAt) return '—';
  const start = new Date(task.startedAt).getTime();
  const end = new Date(task.updatedAt ?? task.startedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '—';
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;
}

export function NowCardStack({ agents, tasks, allowActive, onOpenTask, onOpenAll }: {
  agents: AgentUiModel[];
  tasks: TaskUiModel[];
  allowActive: boolean;
  onOpenTask(taskId: string, agentId: string): void;
  onOpenAll(): void;
}) {
  const { t } = useI18n();
  const items = activeItems(agents, tasks, allowActive);
  return (
    <section className={`now-stack floating-panel${items.length ? '' : ' now-stack--empty'}`} aria-label={t('now')}>
      <header className="now-stack__header">
        <span className="now-label">{t('now')}<i /></span>
        <span>{items.length} {t('provenWorking')}</span>
      </header>
      {items.length ? (
        <div className="now-stack__scroll">
          {items.map((item) => (
            <button key={item.task.id} type="button" className="now-item" onClick={() => onOpenTask(item.task.id, item.agent.id)}>
              <span className="now-card__icon"><AgentGlyph iconKey={item.agent.iconKey} size={18} /></span>
              <span className="now-item__copy">
                <span><strong>{item.agent.displayName}</strong><time>{elapsedLabel(item.task)}</time></span>
                <b>{item.task.id}</b>
                <small>{item.task.progressSummary ?? item.task.title}</small>
                <span className="now-progress"><i style={{ width: `${item.task.progressPercent ?? 0}%` }} /></span>
              </span>
              <Expand size={12} aria-hidden="true" />
            </button>
          ))}
        </div>
      ) : <div className="now-empty"><Activity size={18} aria-hidden="true" /><strong>{t('noActiveWork')}</strong></div>}
      <button type="button" className="now-all" onClick={onOpenAll}><ListTodo size={14} />{t('viewAllWork')}</button>
    </section>
  );
}
