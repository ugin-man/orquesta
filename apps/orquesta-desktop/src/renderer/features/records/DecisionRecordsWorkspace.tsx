import { Archive, ArrowRight, CalendarClock, CheckCircle2, CircleHelp, CircleUserRound, ClipboardCheck, ShieldCheck, Wrench } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { AgentUiModel, AttentionUiItem, UserActionKind } from '../../../contracts/orquesta-ui';
import { formatDateTime } from '../../components/format';
import { useI18n } from '../i18n/I18nProvider';

export type DecisionRecordKind = UserActionKind | 'all';

export interface DecisionRecordsWorkspaceProps {
  items: AttentionUiItem[];
  agents: AgentUiModel[];
  selectedKind: DecisionRecordKind;
  loading: boolean;
  onSelectKind(kind: DecisionRecordKind): void;
}

function DecisionIcon({ kind }: { kind: UserActionKind }) {
  if (kind === 'answer') return <CircleHelp size={15} />;
  if (kind === 'approve') return <ShieldCheck size={15} />;
  if (kind === 'review') return <ClipboardCheck size={15} />;
  return <Wrench size={15} />;
}

export function DecisionRecordsWorkspace({ items, agents, selectedKind, loading, onSelectKind }: DecisionRecordsWorkspaceProps) {
  const { locale, t } = useI18n();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const copy = locale === 'ja' ? {
    filters: '判断の種類', list: '判断履歴', detail: '判断詳細', answers: '回答', approvals: '承認', reviews: '確認', manual: '手作業',
    originalRequest: '元の依頼', recordedDecision: '記録された判断', context: '関連情報', relatedTask: '関連タスク', requestedBy: '依頼元', resolved: '判断日時', decisionMaker: '判断したユーザー', changeOutcome: '判断による変更', notRecorded: '記録なし', loading: '判断履歴を読み込み中…', empty: 'この種類の判断記録はありません。'
  } : {
    filters: 'Decision types', list: 'Decision history', detail: 'Decision detail', answers: 'Answers', approvals: 'Approvals', reviews: 'Reviews', manual: 'Manual work',
    originalRequest: 'Original request', recordedDecision: 'Recorded decision', context: 'Related context', relatedTask: 'Related task', requestedBy: 'Requested by', resolved: 'Resolved', decisionMaker: 'Decision maker', changeOutcome: 'Recorded change', notRecorded: 'Not recorded', loading: 'Loading decision history…', empty: 'No decisions of this type.'
  };
  const labels: Record<UserActionKind, string> = { answer: copy.answers, approve: copy.approvals, review: copy.reviews, do: copy.manual };
  const counts: Record<DecisionRecordKind, number> = {
    all: items.length,
    answer: items.filter((item) => item.actionKind === 'answer').length,
    approve: items.filter((item) => item.actionKind === 'approve').length,
    review: items.filter((item) => item.actionKind === 'review').length,
    do: items.filter((item) => item.actionKind === 'do').length
  };
  const filters: Array<[DecisionRecordKind, string]> = [['all', t('all')], ['answer', copy.answers], ['approve', copy.approvals], ['review', copy.reviews], ['do', copy.manual]];
  const visibleItems = useMemo(() => [...items]
    .filter((item) => selectedKind === 'all' || item.actionKind === selectedKind)
    .sort((left, right) => (right.resolvedAt ?? right.createdAt).localeCompare(left.resolvedAt ?? left.createdAt)), [items, selectedKind]);
  const selected = visibleItems.find((item) => item.id === selectedId) ?? visibleItems[0] ?? null;
  const requester = selected?.sourceAgentId
    ? agents.find((agent) => agent.id === selected.sourceAgentId)?.displayName ?? selected.sourceAgentId
    : 'System';

  return (
    <div className="decision-records-workspace">
      <nav className="decision-record-filters" aria-label={copy.filters}>
        {filters.map(([kind, label]) => (
          <button type="button" key={kind} aria-current={selectedKind === kind ? 'page' : undefined} onClick={() => onSelectKind(kind)}>
            <span>{label}</span><strong>{counts[kind]}</strong>
          </button>
        ))}
      </nav>
      <div className="decision-record-split">
        <section className="decision-record-list" aria-label={copy.list}>
          <header><span>{copy.list}</span><strong>{visibleItems.length}</strong></header>
          <div className="decision-record-list__scroll">
            {visibleItems.map((item) => (
              <button type="button" key={item.id} aria-current={selected?.id === item.id ? 'true' : undefined} onClick={() => setSelectedId(item.id)}>
                <span className={`decision-record-kind decision-record-kind--${item.actionKind}`}><DecisionIcon kind={item.actionKind} />{labels[item.actionKind]}</span>
                <strong>{item.title}</strong>
                <p>{item.resolutionLabel ?? copy.notRecorded}</p>
                <small><span>{formatDateTime(item.resolvedAt ?? item.createdAt)}</span><span>{item.taskId ?? '—'}</span><span>{copy.notRecorded}</span></small>
                <ArrowRight size={14} aria-hidden="true" />
              </button>
            ))}
            {!loading && !visibleItems.length ? <p className="decision-record-empty"><Archive size={17} />{copy.empty}</p> : null}
            {loading && !visibleItems.length ? <p className="decision-record-empty">{copy.loading}</p> : null}
          </div>
        </section>
        <section className="decision-record-detail" aria-label={copy.detail}>
          {selected ? (
            <div className="decision-record-detail__scroll">
              <header>
                <span className={`decision-record-kind decision-record-kind--${selected.actionKind}`}><DecisionIcon kind={selected.actionKind} />{labels[selected.actionKind]}</span>
                <h2>{selected.title}</h2>
                <small>{selected.id}</small>
              </header>
              <section><h3>{copy.originalRequest}</h3><p>{selected.summary}</p></section>
              <section className="decision-record-outcome"><h3>{copy.recordedDecision}</h3><strong>{selected.resolutionLabel ?? copy.notRecorded}</strong></section>
              <section><h3>{copy.context}</h3><dl>
                <div><dt><CheckCircle2 size={14} />{copy.relatedTask}</dt><dd>{selected.taskId ?? '—'}</dd></div>
                <div><dt><CircleUserRound size={14} />{copy.requestedBy}</dt><dd>{requester}</dd></div>
                <div><dt><CalendarClock size={14} />{copy.resolved}</dt><dd>{formatDateTime(selected.resolvedAt ?? selected.createdAt)}</dd></div>
                <div><dt><CircleUserRound size={14} />{copy.decisionMaker}</dt><dd>{copy.notRecorded}</dd></div>
                <div><dt><CheckCircle2 size={14} />{copy.changeOutcome}</dt><dd>{copy.notRecorded}</dd></div>
              </dl></section>
            </div>
          ) : <p className="decision-record-empty">{loading ? copy.loading : copy.empty}</p>}
        </section>
      </div>
    </div>
  );
}
