import { History, Route, ShieldCheck } from 'lucide-react';
import type { V4OperationsSnapshot } from '../../../contracts/orquesta-ui';
import { useI18n } from '../i18n/I18nProvider';

export function AuditPanel({ operations }: { operations: V4OperationsSnapshot }) {
  const { t } = useI18n();
  if (!operations.auditTimeline.length && !operations.phaseReviews.length) {
    return <div className="operations-empty"><History size={24} /><strong>{t('noAuditState')}</strong><p>{t('noAuditStateDetail')}</p></div>;
  }
  return (
    <div className="operations-panel-grid operations-panel-grid--audit">
      <article className="operations-section operations-section--timeline">
        <header><span><History size={16} /></span><div><small>{t('canonicalTimeline')}</small><h3>{operations.auditTimeline.length}</h3></div></header>
        <ol className="operations-timeline">
          {[...operations.auditTimeline].reverse().map((item) => (
            <li key={item.eventId}>
              <span>{item.sequence}</span>
              <div><strong>{item.commandName ?? item.type}</strong><small>{item.type}</small><p>{item.actorId} · {item.responsibility}</p>{item.scoutSkipReason ? <em>{t('scoutSkip')} · {item.scoutSkipReason}</em> : null}</div>
              <b>{item.evidenceRefs.length} {t('evidenceRefs')}</b>
            </li>
          ))}
        </ol>
      </article>
      <div className="operations-panel-stack">
        <article className="operations-section">
          <header><span><ShieldCheck size={16} /></span><div><small>{t('responsibilityBoundary')}</small><h3>{t('readOnly')}</h3></div></header>
          <p className="operations-section-copy">{t('auditBoundaryDetail')}</p>
        </article>
        <article className="operations-section">
          <header><span><Route size={16} /></span><div><small>{t('phaseReviews')}</small><h3>{operations.phaseReviews.length}</h3></div></header>
          <div className="operations-record-list">{operations.phaseReviews.map((review) => <section key={review.phaseId}><div><strong>{review.phaseId}</strong><small>{review.buildRef}</small></div><span className="operations-state">{review.status}</span><p>{review.reviewPacketRef}</p></section>)}</div>
        </article>
      </div>
    </div>
  );
}
