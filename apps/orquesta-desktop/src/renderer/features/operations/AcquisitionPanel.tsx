import { Download, Gauge, PackageSearch, ShieldCheck } from 'lucide-react';
import type { V4OperationsSnapshot } from '../../../contracts/orquesta-ui';
import { useI18n } from '../i18n/I18nProvider';

export function AcquisitionPanel({ operations }: { operations: V4OperationsSnapshot }) {
  const { t } = useI18n();
  const remaining = operations.acquisitionSnapshots.reduce((sum, item) => sum + item.remainingRequests, 0);
  const hasData = Boolean(operations.providers.length || operations.candidateEvaluations.length || operations.acquisitionSnapshots.length || operations.auditionResults.length || operations.installRequest);
  if (!hasData) return <div className="operations-empty"><PackageSearch size={24} /><strong>{t('noAcquisitionState')}</strong><p>{t('noAcquisitionStateDetail')}</p></div>;

  return (
    <div className="operations-panel-stack">
      <div className="operations-metrics">
        <article><PackageSearch size={15} /><span><strong>{operations.providers.length}</strong><small>{t('providers')}</small></span></article>
        <article><ShieldCheck size={15} /><span><strong>{operations.candidateEvaluations.length}</strong><small>{t('evaluations')}</small></span></article>
        <article><Gauge size={15} /><span><strong>{remaining}</strong><small>{t('requestsRemaining')}</small></span></article>
        <article><Download size={15} /><span><strong>{operations.installRequest?.status ?? t('none')}</strong><small>{t('installState')}</small></span></article>
      </div>

      <article className="operations-section">
        <header><span><PackageSearch size={16} /></span><div><small>{t('discoveredProviders')}</small><h3>{operations.providers.length}</h3></div></header>
        <div className="operations-table" role="table" aria-label={t('discoveredProviders')}>
          {operations.providers.map((provider) => (
            <div role="row" key={provider.id}>
              <span role="cell"><strong>{provider.id}</strong><small>{provider.sourceUri}</small></span>
              <span role="cell">{provider.version || t('unknown')}</span>
              <span role="cell" className="operations-state">{provider.availability}</span>
              <span role="cell">{provider.trustTier}</span>
            </div>
          ))}
        </div>
      </article>

      <div className="operations-panel-grid">
        <article className="operations-section">
          <header><span><ShieldCheck size={16} /></span><div><small>{t('candidateEvaluations')}</small><h3>{operations.candidateEvaluations.length}</h3></div></header>
          <div className="operations-record-list">
            {operations.candidateEvaluations.map((evaluation) => <section key={evaluation.id}><div><strong>{evaluation.candidateId}</strong><small>{evaluation.id}</small></div><b>{evaluation.score}</b><span className="operations-state">{evaluation.eligibility}</span>{evaluation.hardGates.map((gate) => <p key={gate.name}>{gate.name} · {gate.status} · {gate.reason}</p>)}</section>)}
          </div>
        </article>
        <article className="operations-section">
          <header><span><Gauge size={16} /></span><div><small>{t('sourceAcquisition')}</small><h3>{operations.acquisitionSnapshots.length}</h3></div></header>
          <div className="operations-record-list">
            {operations.acquisitionSnapshots.map((snapshot) => <section key={snapshot.queryId}><div><strong>{snapshot.queryTerms.join(' · ')}</strong><small>{snapshot.queryId}</small></div><b>{snapshot.remainingRequests} {t('requestsRemaining')}</b>{snapshot.sources.map((source) => <p key={source.connectorId}>{source.connectorId} · {source.status} · {source.cacheStatus}</p>)}</section>)}
            {operations.auditionResults.map((result) => <section key={result.planId}><div><strong>{t('audition')} · {result.verdict}</strong><small>{result.planId}</small></div><p>{result.observedProfile}</p></section>)}
          </div>
        </article>
      </div>
    </div>
  );
}
