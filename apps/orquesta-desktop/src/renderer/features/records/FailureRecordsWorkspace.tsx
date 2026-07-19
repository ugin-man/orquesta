import { AlertTriangle, CheckCircle2, Clock3, Repeat2, Search, ShieldAlert, Wrench, X } from 'lucide-react';
import type { FailureUiModel, FailureUiSeverity } from '../../../contracts/orquesta-ui';
import { formatDateTime } from '../../components/format';
import { useI18n } from '../i18n/I18nProvider';

export type FailureRecordScope = 'open' | 'repeated' | 'resolved' | 'all';
export type FailureRecordSort = 'last_desc' | 'occurrences_desc' | 'severity_desc';

export interface FailureRecordView {
  scope: FailureRecordScope;
  query: string;
  severity: FailureUiSeverity | 'all';
  sort: FailureRecordSort;
  selectedFailureId: string | null;
}

export function createDefaultFailureRecordView(): FailureRecordView {
  return { scope: 'open', query: '', severity: 'all', sort: 'last_desc', selectedFailureId: null };
}

const severityRank: Record<FailureUiSeverity, number> = { blocker: 4, high: 3, medium: 2, low: 1, unknown: 0 };

function time(value: string | null): number {
  const parsed = value ? Date.parse(value) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function FailureDetail({ failure, onClose }: { failure: FailureUiModel; onClose(): void }) {
  const { locale } = useI18n();
  const copy = locale === 'ja'
    ? { close: 'エラー詳細を閉じる', occurrences: '発生', affected: '影響範囲', tasks: 'タスク', agents: 'エージェント', first: '初回', last: '最終', owner: '推定担当', cause: '原因', repair: '修復状況', fix: '修復内容・次の対応', evidence: '証拠', prevention: '再発防止', history: '発生履歴', attempted: '試した対応', outcome: '結果', candidate: '候補', incident: '受理済み', cluster: '反復cluster' }
    : { close: 'Close error detail', occurrences: 'occurrences', affected: 'Affected work', tasks: 'Tasks', agents: 'Agents', first: 'First', last: 'Last', owner: 'Suspected owner', cause: 'Cause', repair: 'Repair state', fix: 'Repair or next action', evidence: 'Evidence', prevention: 'Prevention', history: 'Occurrence history', attempted: 'Attempted fixes', outcome: 'Outcome', candidate: 'Candidate', incident: 'Accepted incident', cluster: 'Repeated cluster' };
  const sourceLabel = copy[failure.source];
  return (
    <aside className="failure-record-detail" role="region" aria-label={`Failure ${failure.id} detail`}>
      <header>
        <div><span className={`failure-source failure-source--${failure.source}`}>{sourceLabel}</span><small>{failure.id}</small></div>
        <button type="button" aria-label={copy.close} onClick={onClose}><X size={16} /></button>
        <h2>{failure.title}</h2>
        <p>{failure.failureClass}</p>
      </header>
      <div className="failure-record-detail__scroll">
        <section className="failure-detail-summary">
          <strong><Repeat2 size={15} />{failure.occurrenceCount} {copy.occurrences}</strong>
          <p>{failure.summary}</p>
        </section>
        <section><h3>{copy.affected}</h3><dl className="failure-detail-facts">
          <div><dt>{copy.tasks}</dt><dd>{failure.taskIds.join(', ') || '—'}</dd></div>
          <div><dt>{copy.agents}</dt><dd>{failure.sourceAgentIds.join(', ') || '—'}</dd></div>
          <div><dt>{copy.first}</dt><dd>{formatDateTime(failure.firstOccurredAt)}</dd></div>
          <div><dt>{copy.last}</dt><dd>{formatDateTime(failure.lastOccurredAt)}</dd></div>
          <div><dt>{copy.owner}</dt><dd>{failure.suspectedOwner ?? '—'}</dd></div>
          <div><dt>{copy.repair}</dt><dd>{failure.repairStatus ?? failure.status}</dd></div>
        </dl></section>
        <section><h3><AlertTriangle size={13} />{copy.cause}</h3><p>{failure.cause ?? '—'}</p></section>
        <section><h3><Wrench size={13} />{copy.fix}</h3><p>{failure.fix ?? '—'}</p></section>
        <section><h3>{copy.evidence}</h3>{failure.evidence.length ? <ul>{failure.evidence.map((item) => <li key={item}>{item}</li>)}</ul> : <p>—</p>}</section>
        <section><h3>{copy.prevention}</h3>{failure.prevention.length ? <ul>{failure.prevention.map((item) => <li key={item}>{item}</li>)}</ul> : <p>—</p>}</section>
        <section><h3><Clock3 size={13} />{copy.history}</h3><div className="failure-occurrence-list">
          {failure.occurrences.map((occurrence) => (
            <article key={`${occurrence.source}:${occurrence.id}`}>
              <header><strong>{occurrence.id}</strong><span>{occurrence.source === 'candidate' ? copy.candidate : copy.incident} · {occurrence.status}</span><time>{formatDateTime(occurrence.occurredAt)}</time></header>
              <p>{occurrence.summary}</p>
              {occurrence.attemptedFixes.length ? <div><small>{copy.attempted}</small>{occurrence.attemptedFixes.map((item) => <span key={item}>{item}</span>)}</div> : null}
              {occurrence.outcome ? <div><small>{copy.outcome}</small><span>{occurrence.outcome}</span></div> : null}
            </article>
          ))}
        </div></section>
      </div>
    </aside>
  );
}

export function FailureRecordsWorkspace({ failures, view, onViewChange }: {
  failures: FailureUiModel[];
  view: FailureRecordView;
  onViewChange(view: FailureRecordView): void;
}) {
  const { locale } = useI18n();
  const copy = locale === 'ja'
    ? { scopes: 'エラー表示', open: '未解決', repeated: '反復', resolved: '解決済み', all: 'すべて', filters: 'エラーの絞り込み', search: 'エラーを検索', placeholder: 'class、説明、タスク、agentで検索', severity: '重大度', everySeverity: 'すべての重大度', sort: '並び順', newest: '最終発生が新しい順', mostRepeated: '発生回数が多い順', strongest: '重大度が高い順', results: '件', empty: '条件に合うエラー記録はありません', error: 'エラー', state: '状態', count: '回数', last: '最終発生', repair: '修復', select: 'エラーを選ぶと、発生履歴と修復結果を確認できます。', candidate: '候補', incident: '受理済み', cluster: '反復', unknown: '不明', low: '低', medium: '中', high: '高', blocker: '最優先' }
    : { scopes: 'Failure scopes', open: 'Unresolved', repeated: 'Repeated', resolved: 'Resolved', all: 'All', filters: 'Failure filters', search: 'Search errors', placeholder: 'Search class, summary, task, or agent', severity: 'Severity', everySeverity: 'All severities', sort: 'Sort', newest: 'Newest occurrence', mostRepeated: 'Most occurrences', strongest: 'Highest severity', results: 'records', empty: 'No error records match these filters.', error: 'Error', state: 'State', count: 'Count', last: 'Last occurrence', repair: 'Repair', select: 'Select an error to inspect its occurrences and repair result.', candidate: 'Candidate', incident: 'Incident', cluster: 'Repeated', unknown: 'Unknown', low: 'Low', medium: 'Medium', high: 'High', blocker: 'Blocker' };
  const counts: Record<FailureRecordScope, number> = {
    open: failures.filter((failure) => failure.resolution !== 'resolved').length,
    repeated: failures.filter((failure) => failure.occurrenceCount >= 2).length,
    resolved: failures.filter((failure) => failure.resolution === 'resolved').length,
    all: failures.length
  };
  const update = (patch: Partial<FailureRecordView>) => onViewChange({ ...view, ...patch });
  const normalizedQuery = view.query.trim().toLocaleLowerCase();
  const visible = failures
    .filter((failure) => view.scope === 'all'
      || (view.scope === 'open' ? failure.resolution !== 'resolved' : view.scope === 'resolved' ? failure.resolution === 'resolved' : failure.occurrenceCount >= 2))
    .filter((failure) => view.severity === 'all' || failure.severity === view.severity)
    .filter((failure) => !normalizedQuery || [failure.id, failure.failureClass, failure.title, failure.summary, ...failure.taskIds, ...failure.sourceAgentIds].join(' ').toLocaleLowerCase().includes(normalizedQuery))
    .sort((left, right) => view.sort === 'occurrences_desc'
      ? right.occurrenceCount - left.occurrenceCount || time(right.lastOccurredAt) - time(left.lastOccurredAt)
      : view.sort === 'severity_desc'
        ? severityRank[right.severity] - severityRank[left.severity] || time(right.lastOccurredAt) - time(left.lastOccurredAt)
        : time(right.lastOccurredAt) - time(left.lastOccurredAt));
  const selected = view.selectedFailureId ? failures.find((failure) => failure.id === view.selectedFailureId) ?? null : null;
  const scopeOptions: Array<[FailureRecordScope, string]> = [['open', copy.open], ['repeated', copy.repeated], ['resolved', copy.resolved], ['all', copy.all]];
  const sourceLabel = (source: FailureUiModel['source']) => copy[source];

  return (
    <div className="failure-records-workspace">
      <nav className="failure-record-scopes" aria-label={copy.scopes}>
        {scopeOptions.map(([scope, label]) => <button type="button" key={scope} aria-current={view.scope === scope ? 'page' : undefined} aria-label={`${label} ${counts[scope]}`} onClick={() => update({ scope })}><span>{label}</span><strong>{counts[scope]}</strong></button>)}
      </nav>
      <div className="failure-record-filters" aria-label={copy.filters}>
        <label className="failure-record-search"><Search size={14} /><input type="search" aria-label={copy.search} placeholder={copy.placeholder} value={view.query} onChange={(event) => update({ query: event.target.value })} /></label>
        <label><span>{copy.severity}</span><select aria-label={copy.severity} value={view.severity} onChange={(event) => update({ severity: event.target.value as FailureRecordView['severity'] })}><option value="all">{copy.everySeverity}</option><option value="blocker">{copy.blocker}</option><option value="high">{copy.high}</option><option value="medium">{copy.medium}</option><option value="low">{copy.low}</option><option value="unknown">{copy.unknown}</option></select></label>
        <label><span>{copy.sort}</span><select aria-label={copy.sort} value={view.sort} onChange={(event) => update({ sort: event.target.value as FailureRecordSort })}><option value="last_desc">{copy.newest}</option><option value="occurrences_desc">{copy.mostRepeated}</option><option value="severity_desc">{copy.strongest}</option></select></label>
      </div>
      <div className={`failure-record-layout${selected ? ' failure-record-layout--detail-open' : ''}`}>
        <section className="failure-record-results" aria-label={`${visible.length} ${copy.results}`}>
          <header><span><strong>{visible.length}</strong> {copy.results}</span><div><span>{copy.error}</span><span>{copy.state}</span><span>{copy.count}</span><span>{copy.last}</span><span>{copy.repair}</span></div></header>
          <div className="failure-record-list">
            {visible.map((failure) => (
              <button type="button" key={failure.id} aria-label={`${failure.id} · ${failure.title}`} aria-current={selected?.id === failure.id ? 'true' : undefined} onClick={() => update({ selectedFailureId: failure.id })}>
                <span className="failure-record-main"><small className={`failure-source failure-source--${failure.source}`}>{sourceLabel(failure.source)}</small><strong>{failure.failureClass}</strong><em>{failure.title}</em></span>
                <span><i className={`failure-severity failure-severity--${failure.severity}`} />{copy[failure.severity]}</span>
                <span>{failure.status}</span>
                <strong className={failure.occurrenceCount >= 2 ? 'is-repeated' : undefined}>{failure.occurrenceCount}</strong>
                <time>{formatDateTime(failure.lastOccurredAt)}</time>
                <span>{failure.repairStatus ?? '—'}</span>
              </button>
            ))}
            {!visible.length ? <p className="failure-record-empty"><CheckCircle2 size={20} />{copy.empty}</p> : null}
          </div>
        </section>
        {selected ? <FailureDetail failure={selected} onClose={() => update({ selectedFailureId: null })} /> : <aside className="failure-record-placeholder"><ShieldAlert size={27} /><p>{copy.select}</p></aside>}
      </div>
    </div>
  );
}
