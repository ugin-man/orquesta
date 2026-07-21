import { ArrowRight, CheckCircle2 } from 'lucide-react';
import type { AgentUiModel, AttentionUiItem, UserActionKind } from '../../../contracts/orquesta-ui';
import { OverlayFrame } from '../../components/OverlayFrame';
import { useI18n } from '../i18n/I18nProvider';
import { sortAttentionItems } from './attention-summary';

export function UserTaskQuickView({ items, agents, onOpenAll, onClose }: {
  items: AttentionUiItem[];
  agents: AgentUiModel[];
  onOpenAll(): void;
  onClose(): void;
}) {
  const { t } = useI18n();
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const labels: Record<UserActionKind, string> = {
    answer: t('questions'),
    approve: t('approvals'),
    review: t('reviews'),
    do: t('manualWork')
  };

  return (
    <OverlayFrame title={t('userTasks')} subtitle={`${t('userTasks')} · ${items.length}`} ariaLabel={t('userTasks')} className="user-task-quick-view" onClose={onClose}>
      {items.length ? (
        <div className="user-task-quick-view__list">
          {sortAttentionItems(items).map((item) => (
            <article key={item.id} className={`user-task-quick-view__item user-task-quick-view__item--${item.priority}`}>
              <header>
                <span className={`user-task-kind user-task-kind--${item.actionKind}`}>{labels[item.actionKind]}</span>
                <small>{item.taskId ?? item.id}</small>
              </header>
              <strong>{item.title}</strong>
              <p>{item.summary}</p>
              <footer>
                <span>{item.sourceAgentId ? agentById.get(item.sourceAgentId)?.displayName ?? item.sourceAgentId : 'System'}</span>
                <span>{item.priority}</span>
              </footer>
            </article>
          ))}
        </div>
      ) : (
        <div className="quick-view-empty"><CheckCircle2 size={22} /><strong>{t('allClear')}</strong></div>
      )}
      <footer className="quick-view-footer">
        <button type="button" className="quick-view-footer__action" onClick={onOpenAll}>{t('viewAllUserTasks')}<ArrowRight size={15} /></button>
      </footer>
    </OverlayFrame>
  );
}
