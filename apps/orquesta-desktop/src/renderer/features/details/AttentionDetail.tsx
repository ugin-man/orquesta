import { AlertTriangle, CalendarClock, CircleUserRound, ListChecks } from 'lucide-react';
import type { AttentionUiItem } from '../../../contracts/orquesta-ui';
import { OverlayFrame } from '../../components/OverlayFrame';
import { formatDateTime, statusLabel } from '../../components/format';
import { useI18n } from '../i18n/I18nProvider';

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="detail-row"><dt>{label}</dt><dd>{children || '—'}</dd></div>;
}

export function AttentionDetail({ item, sourceLabel, canResolve, onResolve, onClose }: {
  item: AttentionUiItem;
  sourceLabel: string;
  canResolve: boolean;
  onResolve(decision: string): void;
  onClose(): void;
}) {
  const { t } = useI18n();
  const decisions = item.runtimeApproval?.responseOptions ?? [];

  return (
    <OverlayFrame
      title={<span className="detail-title"><span className="detail-title__icon"><AlertTriangle size={20} /></span><span>{item.title}<small>{statusLabel(item.type)} · {statusLabel(item.priority)}</small></span></span>}
      ariaLabel={`Attention action ${item.id}`}
      className="attention-detail inspector-overlay"
      onClose={onClose}
      modal={false}
    >
      <section className="attention-detail__summary"><p>{item.summary}</p></section>
      <dl className="detail-grid">
        <DetailRow label={t('kind')}><ListChecks size={13} /> {statusLabel(item.actionKind)}</DetailRow>
        <DetailRow label={t('owner')}><CircleUserRound size={13} /> {sourceLabel}</DetailRow>
        <DetailRow label={t('currentTask')}>{item.taskId ?? '—'}</DetailRow>
        <DetailRow label={t('latest')}><CalendarClock size={13} /> {formatDateTime(item.createdAt)}</DetailRow>
      </dl>
      {canResolve && decisions.length ? (
        <section className="attention-detail__actions" aria-label={t('resolve')}>
          {decisions.map((decision) => <button type="button" key={decision} onClick={() => onResolve(decision)}>{decision}</button>)}
        </section>
      ) : null}
    </OverlayFrame>
  );
}
