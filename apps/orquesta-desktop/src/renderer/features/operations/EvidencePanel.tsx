import { Activity, Link2, RefreshCw, Server, ShieldCheck } from 'lucide-react';
import type { RuntimeInfoUi } from '../../../contracts/bridge';
import type { V4OperationsSnapshot } from '../../../contracts/orquesta-ui';
import { useI18n } from '../i18n/I18nProvider';

function value(value: string | null, fallback: string): string { return value || fallback; }

export function EvidencePanel({ operations, runtimeInfo, runtimeError, refreshing, onRefresh }: {
  operations: V4OperationsSnapshot;
  runtimeInfo: RuntimeInfoUi | null;
  runtimeError: string | null;
  refreshing: boolean;
  onRefresh(): void;
}) {
  const { t } = useI18n();
  const noEvidence = !operations.evidenceChains.length && !operations.runtimeCorrelations.length;
  return (
    <div className="operations-panel-grid operations-panel-grid--evidence">
      <article className="operations-section operations-runtime-card">
        <header><span><Server size={16} /></span><div><small>{t('codexRuntime')}</small><h3>{runtimeInfo?.status ?? t('loadingRuntime')}</h3></div><button type="button" onClick={onRefresh} disabled={refreshing} aria-label={t('refreshRuntime')}><RefreshCw size={14} className={refreshing ? 'is-spinning' : ''} />{t('refresh')}</button></header>
        {runtimeError ? <p className="operations-warning" role="status">{runtimeError}</p> : null}
        <dl className="operations-detail-list operations-detail-list--runtime">
          <div><dt>{t('adapter')}</dt><dd>{runtimeInfo?.adapter ?? t('unknown')}</dd></div>
          <div><dt>{t('integrity')}</dt><dd>{runtimeInfo?.integrity ?? t('unknown')}</dd></div>
          <div><dt>{t('sdkVersion')}</dt><dd>{value(runtimeInfo?.sdkVersion ?? null, t('notObserved'))}</dd></div>
          <div><dt>{t('codexVersion')}</dt><dd>{value(runtimeInfo?.codexVersion ?? null, t('notObserved'))}</dd></div>
          <div><dt>{t('runtimeVersion')}</dt><dd>{value(runtimeInfo?.runtimeVersion ?? null, t('notObserved'))}</dd></div>
          <div><dt>{t('target')}</dt><dd>{value(runtimeInfo?.targetTriple ?? null, t('notObserved'))}</dd></div>
        </dl>
        <p className="operations-runtime-note"><ShieldCheck size={12} />{t('runtimeProbeDetail')}</p>
      </article>

      <article className="operations-section">
        <header><span><Activity size={16} /></span><div><small>{t('runtimeCorrelations')}</small><h3>{operations.runtimeCorrelations.length}</h3></div></header>
        <div className="operations-record-list">{operations.runtimeCorrelations.map((item) => <section key={item.correlationId}><div><strong>{item.correlationId}</strong><small>{item.dispatchEvidenceId ?? t('notObserved')}</small></div><p>{t('thread')} · {item.activeThreadId ?? t('none')}</p><p>{t('turn')} · {item.activeTurnId ?? t('none')}</p></section>)}</div>
      </article>

      <article className="operations-section operations-section--chains">
        <header><span><Link2 size={16} /></span><div><small>{t('evidenceChains')}</small><h3>{operations.evidenceChains.length}</h3></div></header>
        {noEvidence ? <p className="operations-inline-empty">{t('noEvidenceState')}</p> : (
          <div className="evidence-chain-list">{operations.evidenceChains.map((chain) => <section key={chain.correlationId}><header><strong>{chain.correlationId}</strong><small>{chain.items.length} {t('items')}</small></header><ol>{chain.items.map((item) => <li key={item.id}><span>{item.sequence}</span><div><strong>{item.id}</strong><small>{item.kind} · {item.threadId ?? t('noThread')} · {item.turnId ?? t('noTurn')}</small>{item.ref ? <p>{item.ref}</p> : null}</div></li>)}</ol></section>)}</div>
        )}
      </article>
    </div>
  );
}
