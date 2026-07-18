import { Archive, CheckCircle2 } from 'lucide-react';
import type { AgentUiModel, AttentionUiItem } from '../../../contracts/orquesta-ui';
import { OverlayFrame } from '../../components/OverlayFrame';
import { formatDateTime } from '../../components/format';
import { useI18n } from '../i18n/I18nProvider';

export function AttentionHistory({ items, agents, onClose }: { items: AttentionUiItem[]; agents: AgentUiModel[]; onClose(): void }) {
  const { t } = useI18n();
  const byId = new Map(agents.map((agent) => [agent.id, agent.displayName]));
  return (
    <OverlayFrame title={t('attentionHistory')} subtitle={`${items.length} archived items`} ariaLabel={t('attentionHistory')} className="attention-history-overlay" onClose={onClose}>
      <div className="history-scroll">
        {items.length ? items.map((item) => (
          <article key={item.id} className="history-card">
            <span><CheckCircle2 size={17} /></span>
            <div><header><strong>{item.title}</strong><time>{formatDateTime(item.resolvedAt)}</time></header><p>{item.summary}</p><small>{item.sourceAgentId ? byId.get(item.sourceAgentId) ?? item.sourceAgentId : 'System'} · {item.resolutionLabel ?? 'Resolved'}</small></div>
          </article>
        )) : <div className="empty-detail"><Archive size={18} />No archived actions.</div>}
      </div>
    </OverlayFrame>
  );
}
