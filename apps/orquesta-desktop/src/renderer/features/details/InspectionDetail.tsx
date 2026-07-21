import { Clock3, FileText, Search, ShieldAlert, Square } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { UiActionResult } from '../../../contracts/bridge';
import type { InspectionRunUiModel } from '../../../contracts/orquesta-ui';
import { formatDateTime } from '../../components/format';
import { OverlayFrame } from '../../components/OverlayFrame';
import { useI18n } from '../i18n/I18nProvider';

const ACTIVE_STATUSES = new Set(['queued', 'running', 'cancelling']);

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return <div className="detail-row"><dt>{label}</dt><dd>{value || '—'}</dd></div>;
}

export function InspectionDetail({ run, history, onCancel, onOpenReport, onClose }: {
  run: InspectionRunUiModel;
  history: InspectionRunUiModel[];
  onCancel(runId: string): Promise<UiActionResult>;
  onOpenReport(runId: string): void;
  onClose(): void;
}) {
  const { locale, t } = useI18n();
  const [tab, setTab] = useState<'now' | 'history'>('now');
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isExternal = run.kind === 'external_benchmark';
  const name = t(isExternal ? 'externalBenchmark' : 'adversarialAudit');
  const copy = locale === 'ja' ? {
    detail: 'の詳細', now: '現在', history: '履歴', readOnly: '読み取り専用',
    target: '対象', focus: '注目点', status: '状態', requested: '開始要求',
    runId: '実行ID', threadId: 'スレッドID', sourceCount: '確認ソース数',
    noFocus: '指定なし', recentRuns: '同種の実行履歴', noHistory: '過去の実行はありません',
    openReport: 'レポートを開く', error: '実行エラー', sections: '詳細セクション'
  } : {
    detail: ' detail', now: 'Now', history: 'History', readOnly: 'Read only',
    target: 'Target', focus: 'Focus', status: 'Status', requested: 'Requested',
    runId: 'Run ID', threadId: 'Thread ID', sourceCount: 'Sources checked',
    noFocus: 'Not specified', recentRuns: 'Recent runs of this type', noHistory: 'No previous runs',
    openReport: 'Open report', error: 'Execution error', sections: 'detail sections'
  };
  const orderedHistory = useMemo(() => [...history]
    .filter((candidate) => candidate.kind === run.kind && candidate.runId !== run.runId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, 8), [history, run.kind, run.runId]);
  const cancel = async () => {
    if (cancelling) return;
    setCancelling(true);
    setError(null);
    try {
      const result = await onCancel(run.runId);
      if (result.status === 'accepted') onClose();
      else setError(result.reason);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCancelling(false);
    }
  };
  const Icon = isExternal ? Search : ShieldAlert;
  const active = ACTIVE_STATUSES.has(run.status);

  return (
    <OverlayFrame
      title={<span className={`inspection-detail__title inspection-detail__title--${isExternal ? 'blue' : 'red'}`}><span><Icon size={21} /></span>{name}</span>}
      subtitle={<span className={`inspection-detail__status inspection-detail__status--${run.status}`}>{copy.readOnly} · {run.status}</span>}
      ariaLabel={`${name}${copy.detail}`}
      className={`inspection-detail inspection-detail--${isExternal ? 'blue' : 'red'} inspector-overlay`}
      onClose={onClose}
      modal={false}
    >
      <nav className="detail-tabs inspection-detail__tabs" aria-label={`${name} ${copy.sections}`}>
        <button type="button" className={tab === 'now' ? 'is-active' : ''} onClick={() => setTab('now')}>{copy.now}</button>
        <button type="button" className={tab === 'history' ? 'is-active' : ''} onClick={() => setTab('history')}>{copy.history}</button>
      </nav>

      {tab === 'now' ? (
        <div className="detail-section">
          <dl className="detail-grid">
            <DetailRow label={copy.status} value={run.status} />
            <DetailRow label={copy.target} value={run.target.label} />
            <DetailRow label={copy.focus} value={run.focus ?? copy.noFocus} />
            <DetailRow label={copy.requested} value={formatDateTime(run.createdAt)} />
            <DetailRow label={copy.runId} value={run.runId} />
            <DetailRow label={copy.threadId} value={run.threadId ?? '—'} />
            <DetailRow label={copy.sourceCount} value={String(run.sourceCount)} />
          </dl>
          {run.errorMessage ? <section className="inspection-detail__error" role="alert"><strong>{copy.error}</strong><p>{run.errorMessage}</p></section> : null}
          {error ? <p className="inspection-detail__action-error" role="alert">{error}</p> : null}
          <footer className="inspection-detail__actions">
            {run.reportPath ? <button type="button" onClick={() => onOpenReport(run.runId)}><FileText size={14} />{copy.openReport}</button> : null}
            {active ? (
              <button type="button" className="inspection-detail__cancel" aria-label={t(isExternal ? 'cancelExternalBenchmark' : 'cancelAdversarialAudit')} disabled={cancelling || run.status === 'cancelling'} onClick={() => void cancel()}>
                <Square size={12} />{cancelling ? '…' : t('cancelInspection')}
              </button>
            ) : null}
          </footer>
        </div>
      ) : (
        <div className="detail-section">
          <h3 className="inspection-detail__history-title"><Clock3 size={14} />{copy.recentRuns}</h3>
          {orderedHistory.length ? <ol className="history-list">{orderedHistory.map((item) => <li key={item.runId}><Clock3 size={14} /><div><strong>{item.status}</strong><span>{formatDateTime(item.createdAt)} · {item.target.label}</span></div></li>)}</ol> : <div className="empty-detail">{copy.noHistory}</div>}
        </div>
      )}
    </OverlayFrame>
  );
}
