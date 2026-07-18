import { Boxes, CheckCircle2, FileText, Target } from 'lucide-react';
import type { V4OperationsSnapshot } from '../../../contracts/orquesta-ui';
import { useI18n } from '../i18n/I18nProvider';

function EmptyCapability() {
  const { t } = useI18n();
  return <div className="operations-empty"><Boxes size={24} /><strong>{t('noCapabilityState')}</strong><p>{t('noCapabilityStateDetail')}</p></div>;
}

export function CapabilityPanel({ operations }: { operations: V4OperationsSnapshot }) {
  const { t } = useI18n();
  const hasData = Boolean(operations.taskIntent || operations.capabilityNeeds.length || operations.latestResolutions.length || operations.contextPack);
  if (!hasData) return <EmptyCapability />;

  return (
    <div className="operations-panel-grid operations-panel-grid--capability">
      <article className="operations-section operations-section--featured">
        <header><span><Target size={16} /></span><div><small>{t('taskIntent')}</small><h3>{operations.taskIntent?.id ?? t('notRecorded')}</h3></div></header>
        <p className="operations-featured-copy">{operations.taskIntent?.desiredOutcome ?? t('notRecorded')}</p>
        {operations.taskIntent?.acceptanceCriteria.length ? (
          <div className="operations-checks"><strong>{t('acceptanceCriteria')}</strong><ul>{operations.taskIntent.acceptanceCriteria.map((item) => <li key={item}><CheckCircle2 size={12} />{item}</li>)}</ul></div>
        ) : null}
      </article>

      <article className="operations-section">
        <header><span><Boxes size={16} /></span><div><small>{t('capabilityNeeds')}</small><h3>{operations.capabilityNeeds.length}</h3></div></header>
        <div className="operations-record-list">
          {operations.capabilityNeeds.map((need) => (
            <section key={need.id}>
              <div><strong>{need.description}</strong><small>{need.id}</small></div>
              <span className={`operations-state operations-state--${need.status}`}>{need.status}</span>
              <dl><div><dt>{t('kind')}</dt><dd>{need.kind}</dd></div><div><dt>{t('requiredLevel')}</dt><dd>{need.requiredLevel}</dd></div><div><dt>{t('confidence')}</dt><dd>{need.confidence}%</dd></div></dl>
            </section>
          ))}
        </div>
      </article>

      <article className="operations-section">
        <header><span><CheckCircle2 size={16} /></span><div><small>{t('selectedResolutions')}</small><h3>{operations.latestResolutions.length}</h3></div></header>
        <div className="operations-record-list">
          {operations.latestResolutions.length ? operations.latestResolutions.map((resolution) => (
            <section key={resolution.id}>
              <div><strong>{resolution.providerId ?? t('newBuild')}</strong><small>{resolution.needId}</small></div>
              <span className="operations-state">{resolution.approvalStatus}</span>
              <dl><div><dt>{t('mode')}</dt><dd>{resolution.mode}</dd></div><div><dt>{t('cost')}</dt><dd>{resolution.totalCost}</dd></div></dl>
            </section>
          )) : <p className="operations-inline-empty">{t('noResolutions')}</p>}
        </div>
      </article>

      <article className="operations-section">
        <header><span><FileText size={16} /></span><div><small>{t('contextPack')}</small><h3>{operations.contextPack?.id ?? t('notRecorded')}</h3></div></header>
        {operations.contextPack ? (
          <dl className="operations-detail-list">
            <div><dt>{t('owner')}</dt><dd>{operations.contextPack.ownerAgentId}</dd></div>
            <div><dt>{t('objective')}</dt><dd>{operations.contextPack.objective}</dd></div>
            <div><dt>{t('status')}</dt><dd>{operations.contextPack.status}</dd></div>
            <div><dt>{t('requiredReading')}</dt><dd>{operations.contextPack.requiredReading.join(' · ') || t('none')}</dd></div>
          </dl>
        ) : <p className="operations-inline-empty">{t('noContextPack')}</p>}
      </article>
    </div>
  );
}
