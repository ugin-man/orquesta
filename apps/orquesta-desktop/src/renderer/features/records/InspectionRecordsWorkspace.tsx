import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, FileSearch, Globe2, MessageCircleQuestion, RotateCcw, ShieldAlert, X } from 'lucide-react';
import type { InspectionReportUi } from '../../../contracts/bridge';
import type { InspectionKind, InspectionRunStatus, InspectionRunUiModel } from '../../../contracts/orquesta-ui';
import { formatDateTime } from '../../components/format';
import { useI18n } from '../i18n/I18nProvider';

export type InspectionRecordFilter = 'all' | InspectionKind | 'complete' | 'failed';

type ReportBlock =
  | { kind: 'heading'; level: 2 | 3; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'link'; label: string; url: string };

type LoadedReport =
  | { runId: string; state: 'loading'; markdown: null; error: null }
  | { runId: string; state: 'ready'; markdown: string; error: null }
  | { runId: string; state: 'error'; markdown: null; error: string };

const completeStatuses = new Set<InspectionRunStatus>(['report_ready', 'partial', 'closed']);

function runTimestamp(run: InspectionRunUiModel): number {
  const parsed = Date.parse(run.completedAt ?? run.createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseReport(markdown: string): ReportBlock[] {
  const blocks: ReportBlock[] = [];
  const lines = markdown.replace(/\r\n?/gu, '\n').split('\n');
  for (let index = 0; index < lines.length;) {
    const line = lines[index].trim();
    if (!line) {
      index += 1;
      continue;
    }
    const heading = /^(##|###)\s+(.+)$/u.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length as 2 | 3, text: heading[2] });
      index += 1;
      continue;
    }
    if (/^[-*]\s+/u.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^[-*]\s+/u.test(lines[index].trim())) {
        items.push(lines[index].trim().replace(/^[-*]\s+/u, ''));
        index += 1;
      }
      blocks.push({ kind: 'list', items });
      continue;
    }
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/u.exec(line);
    if (link) {
      try {
        const url = new URL(link[2]);
        if (url.protocol === 'http:' || url.protocol === 'https:') {
          blocks.push({ kind: 'link', label: link[1], url: url.toString() });
        } else {
          blocks.push({ kind: 'paragraph', text: line });
        }
      } catch {
        blocks.push({ kind: 'paragraph', text: line });
      }
      index += 1;
      continue;
    }
    blocks.push({ kind: 'paragraph', text: line });
    index += 1;
  }
  return blocks;
}

function SafeReport({ markdown }: { markdown: string }) {
  return (
    <div className="inspection-report-markdown">
      {parseReport(markdown).map((block, index) => {
        if (block.kind === 'heading') return block.level === 2 ? <h2 key={index}>{block.text}</h2> : <h3 key={index}>{block.text}</h3>;
        if (block.kind === 'list') return <ul key={index}>{block.items.map((item, itemIndex) => <li key={`${index}-${itemIndex}`}>{item}</li>)}</ul>;
        if (block.kind === 'link') return <p key={index}><a href={block.url} target="_blank" rel="noreferrer">{block.label}</a></p>;
        return <p key={index}>{block.text}</p>;
      })}
    </div>
  );
}

function kindIcon(kind: InspectionKind) {
  return kind === 'external_benchmark' ? <Globe2 size={15} /> : <ShieldAlert size={15} />;
}

export function InspectionRecordsWorkspace({ runs, selectedRunId, onSelectedRunIdChange, readReport, onAskLuca, lucaActive = false }: {
  runs: InspectionRunUiModel[];
  selectedRunId: string | null;
  onSelectedRunIdChange(runId: string | null): void;
  readReport(runId: string): Promise<InspectionReportUi>;
  onAskLuca?(runId: string): void;
  lucaActive?: boolean;
}) {
  const { locale } = useI18n();
  const [filter, setFilter] = useState<InspectionRecordFilter>('all');
  const [limit, setLimit] = useState(100);
  const [report, setReport] = useState<LoadedReport | null>(null);
  const copy = locale === 'ja'
    ? {
        all: 'すべて', external: '外部比較', audit: '敵対監査', complete: '完了', failed: '失敗', filters: '検査履歴の絞り込み',
        records: '件を表示', empty: '条件に合う検査履歴はありません。', more: 'さらに表示', target: '対象', sources: '参照元',
        started: '開始', completed: '完了', close: '検査レポートを閉じる', loading: 'レポートを読み込み中…', retry: '再試行',
        noReport: 'この実行には保存済みレポートがありません。', error: 'レポートを読み込めませんでした。', report: 'レポート', askLuca: 'この監査をLucaに聞く'
      }
    : {
        all: 'All', external: 'External benchmark', audit: 'Adversarial audit', complete: 'Complete', failed: 'Failed', filters: 'Inspection history filters',
        records: 'shown', empty: 'No inspection runs match these filters.', more: 'Show more', target: 'Target', sources: 'Sources',
        started: 'Started', completed: 'Completed', close: 'Close inspection report', loading: 'Loading report…', retry: 'Retry',
        noReport: 'This run has no saved report.', error: 'The report could not be loaded.', report: 'report', askLuca: 'Ask Luca about this inspection'
      };
  const kindLabel = { external_benchmark: copy.external, adversarial_audit: copy.audit };
  const statusLabel: Record<InspectionRunStatus, string> = locale === 'ja'
    ? { queued: '開始待ち', running: '実行中', cancelling: '中止処理中', report_ready: '完了', partial: '一部完了', failed: '失敗', cancelled: '中止', closed: '完了' }
    : { queued: 'Queued', running: 'Running', cancelling: 'Cancelling', report_ready: 'Complete', partial: 'Partial', failed: 'Failed', cancelled: 'Cancelled', closed: 'Complete' };
  const filterOptions: Array<[InspectionRecordFilter, string]> = [
    ['all', copy.all], ['external_benchmark', copy.external], ['adversarial_audit', copy.audit], ['complete', copy.complete], ['failed', copy.failed]
  ];
  const filteredRuns = useMemo(() => runs
    .filter((run) => filter === 'all'
      || run.kind === filter
      || (filter === 'complete' && completeStatuses.has(run.status))
      || (filter === 'failed' && run.status === 'failed'))
    .sort((left, right) => runTimestamp(right) - runTimestamp(left)), [filter, runs]);
  const visibleRuns = filteredRuns.slice(0, limit);
  const selectedRun = selectedRunId ? runs.find((run) => run.runId === selectedRunId) ?? null : null;

  const loadReport = useCallback(async (run: InspectionRunUiModel) => {
    if (!run.reportPath) {
      setReport({ runId: run.runId, state: 'error', markdown: null, error: run.errorMessage ?? copy.noReport });
      return;
    }
    setReport({ runId: run.runId, state: 'loading', markdown: null, error: null });
    try {
      const loaded = await readReport(run.runId);
      setReport({ runId: run.runId, state: 'ready', markdown: loaded.markdown, error: null });
    } catch (error) {
      setReport({ runId: run.runId, state: 'error', markdown: null, error: error instanceof Error ? error.message : copy.error });
    }
  }, [copy.error, copy.noReport, readReport]);

  useEffect(() => {
    if (!selectedRun) {
      setReport(null);
      return;
    }
    if (report?.runId !== selectedRun.runId) void loadReport(selectedRun);
  }, [loadReport, report?.runId, selectedRun]);

  useEffect(() => {
    if (!selectedRun) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onSelectedRunIdChange(null);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onSelectedRunIdChange, selectedRun]);

  return (
    <div className="inspection-records-workspace">
      <nav className="inspection-record-filters" aria-label={copy.filters}>
        {filterOptions.map(([value, label]) => (
          <button type="button" key={value} aria-current={filter === value ? 'page' : undefined} onClick={() => { setFilter(value); setLimit(100); }}>{label}</button>
        ))}
      </nav>
      <section className="inspection-record-results" aria-label={`${filteredRuns.length} ${copy.records}`}>
        <header><span><strong>{filteredRuns.length}</strong> {copy.records}</span></header>
        <div className="inspection-record-grid">
          {visibleRuns.map((run) => (
            <button
              type="button"
              key={run.runId}
              className={`inspection-record-card inspection-record-card--${run.kind === 'external_benchmark' ? 'blue' : 'red'}`}
              aria-label={`${run.runId} · ${kindLabel[run.kind]} · ${statusLabel[run.status]}`}
              onClick={() => onSelectedRunIdChange(run.runId)}
            >
              <header><span>{kindIcon(run.kind)}{kindLabel[run.kind]}</span><strong>{statusLabel[run.status]}</strong></header>
              <h3>{run.runId}</h3>
              <dl>
                <div><dt>{copy.target}</dt><dd>{run.target.label}</dd></div>
                <div><dt>{copy.sources}</dt><dd>{run.sourceCount}</dd></div>
                <div><dt>{copy.started}</dt><dd>{formatDateTime(run.createdAt)}</dd></div>
                <div><dt>{copy.completed}</dt><dd>{formatDateTime(run.completedAt)}</dd></div>
              </dl>
              <p>{run.focus ?? run.errorMessage ?? run.reportPath ?? copy.noReport}</p>
            </button>
          ))}
          {!visibleRuns.length ? <p className="inspection-record-empty"><FileSearch size={19} />{copy.empty}</p> : null}
        </div>
        {filteredRuns.length > limit ? <button type="button" className="inspection-record-more" onClick={() => setLimit((value) => value + 100)}>{copy.more}</button> : null}
      </section>
      {selectedRun ? (
        <div className={`inspection-record-modal-layer${lucaActive ? ' has-luca' : ''}`} data-testid="inspection-record-modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onSelectedRunIdChange(null); }}>
          <aside className={`inspection-record-detail inspection-record-detail--${selectedRun.kind === 'external_benchmark' ? 'blue' : 'red'}`} role="dialog" aria-modal="true" aria-label={`${kindLabel[selectedRun.kind]}${copy.report}`}>
            <header>
              <div><span>{kindIcon(selectedRun.kind)}{kindLabel[selectedRun.kind]}</span><small>{selectedRun.runId}</small></div>
              <button type="button" aria-label={copy.close} onClick={() => onSelectedRunIdChange(null)}><X size={17} /></button>
              <h1>{selectedRun.displayName}</h1>
            </header>
            <div className="inspection-record-detail__scroll">
              {onAskLuca ? <button type="button" className="luca-detail-trigger" onClick={() => onAskLuca(selectedRun.runId)}><MessageCircleQuestion size={15} />{copy.askLuca}</button> : null}
              {report?.state === 'loading' ? <p className="inspection-report-state">{copy.loading}</p> : null}
              {report?.state === 'error' ? (
                <div className="inspection-report-state inspection-report-state--error">
                  <AlertTriangle size={18} /><p>{report.error}</p>
                  {selectedRun.reportPath ? <button type="button" onClick={() => void loadReport(selectedRun)}><RotateCcw size={13} />{copy.retry}</button> : null}
                </div>
              ) : null}
              {report?.state === 'ready' ? <SafeReport markdown={report.markdown} /> : null}
            </div>
          </aside>
        </div>
      ) : null}
    </div>
  );
}
