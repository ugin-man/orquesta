import { AlertCircle, ArrowRight, CheckCircle2, Expand, HelpCircle, History, ShieldAlert, Wrench } from 'lucide-react';
import type { AgentUiModel, AttentionType, AttentionUiItem } from '../../../contracts/orquesta-ui';
import { useI18n } from '../i18n/I18nProvider';

function AttentionIcon({ type }: { type: AttentionType }) {
  const props = { size: 19, strokeWidth: 1.6, 'aria-hidden': true } as const;
  if (type === 'question') return <HelpCircle {...props} />;
  if (type === 'approval' || type === 'report_review') return <CheckCircle2 {...props} />;
  if (type === 'error') return <AlertCircle {...props} />;
  if (type === 'repair') return <Wrench {...props} />;
  return <ShieldAlert {...props} />;
}

const priorityRank: Record<AttentionUiItem['priority'], number> = { blocker: 0, high: 1, medium: 2, low: 3 };

export function AttentionCard({ items, agents, canResolve, onOpenItem, onResolve, onViewHistory }: {
  items: AttentionUiItem[];
  agents: AgentUiModel[];
  canResolve: boolean;
  onOpenItem(item: AttentionUiItem): void;
  onResolve(item: AttentionUiItem, decision: string): void;
  onViewHistory(): void;
}) {
  const { t } = useI18n();
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const sorted = [...items].sort((a, b) => priorityRank[a.priority] - priorityRank[b.priority]);
  return (
    <section className={`floating-panel attention-card${items.length ? '' : ' attention-card--clear'}`} aria-label={t('attention')}>
      <header className="attention-card__header">
        <span>{t('attention')}{items.length ? <b>{items.length}</b> : null}</span>
        <Expand size={13} aria-hidden="true" />
      </header>
      {items.length ? (
        <div className="attention-card__scroll" data-testid="attention-scroll">
          {sorted.map((item) => (
            <article key={item.id} className={`attention-item attention-item--${item.type} attention-item--${item.priority}`}>
              <span className="attention-item__icon"><AttentionIcon type={item.type} /></span>
              <div className="attention-item__copy">
                <header><strong>{item.title}</strong><span>{item.taskId ?? ''}</span></header>
                <small>{item.sourceAgentId ? agentById.get(item.sourceAgentId)?.displayName ?? item.sourceAgentId : 'System'}</small>
                <p>{item.summary}</p>
                <div className="attention-item__actions">
                  <button type="button" onClick={() => onOpenItem(item)}>{item.primaryActionLabel}<ArrowRight size={14} /></button>
                  {canResolve && item.runtimeApproval
                    ? item.runtimeApproval.responseOptions.map((decision) => (
                        <button type="button" className="text-action" key={decision} onClick={() => onResolve(item, decision)}>{decision}</button>
                      ))
                    : null}
                </div>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="attention-clear"><CheckCircle2 size={22} /><div><strong>{t('allClear')}</strong><p>{t('allClearDetail')}</p></div></div>
      )}
      <button type="button" className="attention-history-link" onClick={onViewHistory}><History size={14} />{t('viewHistory')}</button>
    </section>
  );
}
