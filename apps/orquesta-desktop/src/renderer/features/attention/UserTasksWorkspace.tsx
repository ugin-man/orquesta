import { AlertTriangle, ArrowRight, CalendarClock, CheckCircle2, CircleHelp, CircleUserRound, ClipboardCheck, Pause, ShieldCheck, Wrench } from 'lucide-react';
import { useState } from 'react';
import type { AgentUiModel, AttentionUiItem, UserActionKind } from '../../../contracts/orquesta-ui';
import { formatDateTime } from '../../components/format';
import { useI18n } from '../i18n/I18nProvider';
import { summarizeAttention } from './attention-summary';

export type UserTaskKind = UserActionKind | 'all';

function TaskIcon({ kind }: { kind: UserActionKind }) {
  if (kind === 'answer') return <CircleHelp size={16} />;
  if (kind === 'approve') return <ShieldCheck size={16} />;
  if (kind === 'review') return <ClipboardCheck size={16} />;
  return <Wrench size={16} />;
}

export function UserTasksWorkspace({ items, agents, selectedKind, canResolve, onSelectKind, onResolve }: {
  items: AttentionUiItem[];
  agents: AgentUiModel[];
  selectedKind: UserTaskKind;
  canResolve: boolean;
  onSelectKind(kind: UserTaskKind): void;
  onResolve(item: AttentionUiItem, decision: string): void;
}) {
  const { locale, t } = useI18n();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const summary = summarizeAttention(items);
  const visibleItems = selectedKind === 'all' ? items : items.filter((item) => item.actionKind === selectedKind);
  const selected = visibleItems.find((item) => item.id === selectedId) ?? visibleItems[0] ?? null;
  const copy = locale === 'ja'
    ? {
        list: 'ユーザータスク一覧', detail: 'ユーザータスク詳細', request: '依頼内容', context: '判断材料', requester: '依頼元', task: '関連タスク', received: '受信日時', priority: '優先度', actions: '操作', hold: '保留する', noSelection: 'この種類の未処理タスクはありません', high: '高', blocker: '最優先', medium: '中', low: '低'
      }
    : {
        list: 'User task list', detail: 'User task detail', request: 'Request', context: 'Context', requester: 'Requested by', task: 'Related task', received: 'Received', priority: 'Priority', actions: 'Actions', hold: 'Hold', noSelection: 'No unresolved tasks of this type', high: 'High', blocker: 'Urgent', medium: 'Medium', low: 'Low'
      };
  const labels: Record<UserActionKind, string> = {
    answer: t('questions'), approve: t('approvals'), review: t('reviews'), do: t('manualWork')
  };
  const filters: Array<[UserTaskKind, string, number]> = [
    ['all', t('all'), summary.total],
    ['answer', t('questions'), summary.answer],
    ['approve', t('approvals'), summary.approve],
    ['review', t('reviews'), summary.review],
    ['do', t('manualWork'), summary.do]
  ];
  const requester = selected?.sourceAgentId
    ? agents.find((agent) => agent.id === selected.sourceAgentId)?.displayName ?? selected.sourceAgentId
    : 'System';
  const decisions = selected?.runtimeApproval?.responseOptions ?? [];

  return (
    <div className="user-tasks-workspace">
      <nav className="user-task-filters" aria-label={t('userTaskTypes')}>
        {filters.map(([kind, label, count]) => (
          <button type="button" key={kind} aria-current={selectedKind === kind ? 'page' : undefined} onClick={() => onSelectKind(kind)}>
            <span>{label}</span><strong>{count}</strong>
          </button>
        ))}
      </nav>
      <div className="user-task-split">
        <section className="user-task-list" aria-label={copy.list}>
          <header><span>{copy.list}</span><strong>{visibleItems.length}</strong></header>
          <div className="user-task-list__scroll">
            {visibleItems.map((item) => {
              const source = item.sourceAgentId ? agents.find((agent) => agent.id === item.sourceAgentId)?.displayName ?? item.sourceAgentId : 'System';
              return (
                <button type="button" key={item.id} aria-current={selected?.id === item.id ? 'true' : undefined} onClick={() => setSelectedId(item.id)}>
                  <span className={`user-task-kind user-task-kind--${item.actionKind}`}><TaskIcon kind={item.actionKind} />{labels[item.actionKind]}</span>
                  <strong>{item.title}</strong>
                  <p>{item.summary}</p>
                  <small><span>{item.taskId ?? '—'}</span><span>{source}</span><span>{copy[item.priority]}</span></small>
                  <ArrowRight size={14} aria-hidden="true" />
                </button>
              );
            })}
            {!visibleItems.length ? <p className="user-task-empty">{copy.noSelection}</p> : null}
          </div>
        </section>
        <section className="user-task-detail" aria-label={copy.detail}>
          {selected ? (
            <div className="user-task-detail__scroll">
              <header>
                <span className={`user-task-kind user-task-kind--${selected.actionKind}`}><TaskIcon kind={selected.actionKind} />{labels[selected.actionKind]}</span>
                <span className={`user-task-priority user-task-priority--${selected.priority}`}><AlertTriangle size={13} />{copy[selected.priority]}</span>
                <h2>{selected.title}</h2>
                <small>{selected.id}</small>
              </header>
              <section className="user-task-request"><h3>{copy.request}</h3><p>{selected.summary}</p></section>
              <section className="user-task-context"><h3>{copy.context}</h3><dl>
                <div><dt><CircleUserRound size={14} />{copy.requester}</dt><dd>{requester}</dd></div>
                <div><dt><CheckCircle2 size={14} />{copy.task}</dt><dd>{selected.taskId ?? '—'}</dd></div>
                <div><dt><CalendarClock size={14} />{copy.received}</dt><dd>{formatDateTime(selected.createdAt)}</dd></div>
                <div><dt><AlertTriangle size={14} />{copy.priority}</dt><dd>{copy[selected.priority]}</dd></div>
              </dl></section>
              <section className="user-task-actions" aria-label={copy.actions}>
                <h3>{copy.actions}</h3>
                <div>
                  {canResolve && decisions.length ? decisions.map((decision) => <button type="button" key={decision} className="is-primary" onClick={() => onResolve(selected, decision)}>{decision}</button>) : null}
                  {canResolve && !decisions.length ? <button type="button" className="is-primary" onClick={() => onResolve(selected, selected.primaryActionLabel)}>{selected.primaryActionLabel}</button> : null}
                  <button type="button" className="is-secondary"><Pause size={13} />{copy.hold}</button>
                </div>
              </section>
            </div>
          ) : <p className="user-task-empty">{copy.noSelection}</p>}
        </section>
      </div>
    </div>
  );
}
