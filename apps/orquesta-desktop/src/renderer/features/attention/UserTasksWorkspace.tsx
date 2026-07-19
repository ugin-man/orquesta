import { AlertTriangle, ArrowRight, CalendarClock, CheckCircle2, CircleHelp, CircleUserRound, ClipboardCheck, Pause, RefreshCw, ShieldCheck, Wrench } from 'lucide-react';
import { useState } from 'react';
import type { UiActionResult } from '../../../contracts/bridge';
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

type SubmissionState =
  | { status: 'sending'; response: string }
  | { status: 'pending'; response: string; correlationId: string }
  | { status: 'failed'; response: string; reason: string; retryable: boolean };

export function UserTasksWorkspace({ items, agents, selectedKind, canResolve, onSelectKind, onSubmit }: {
  items: AttentionUiItem[];
  agents: AgentUiModel[];
  selectedKind: UserTaskKind;
  canResolve: boolean;
  onSelectKind(kind: UserTaskKind): void;
  onSubmit(item: AttentionUiItem, response: string): Promise<UiActionResult>;
}) {
  const { locale, t } = useI18n();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [submissions, setSubmissions] = useState<Record<string, SubmissionState>>({});
  const [heldIds, setHeldIds] = useState<Set<string>>(() => new Set());
  const summary = summarizeAttention(items);
  const visibleItems = selectedKind === 'all' ? items : items.filter((item) => item.actionKind === selectedKind);
  const selected = visibleItems.find((item) => item.id === selectedId) ?? visibleItems[0] ?? null;
  const copy = locale === 'ja'
    ? {
        list: 'ユーザータスク一覧', detail: 'ユーザータスク詳細', request: '依頼内容', context: '判断材料', requester: '依頼元', task: '関連タスク', received: '受信日時', priority: '優先度', actions: '操作', hold: '保留する', releaseHold: '保留を解除', held: '保留中', noSelection: 'この種類の未処理タスクはありません', high: '高', blocker: '最優先', medium: '中', low: '低', answerInput: '回答を入力', answerPlaceholder: 'この質問への回答を入力…', sendAnswer: '回答を送信', sending: '送信中', pending: '送信済み・反映待ち', retry: '再送する', approve: '承認する', reject: '却下する', pass: '合格', requestChanges: '修正を依頼', complete: '完了を報告', cannotComplete: 'まだできない'
      }
    : {
        list: 'User task list', detail: 'User task detail', request: 'Request', context: 'Context', requester: 'Requested by', task: 'Related task', received: 'Received', priority: 'Priority', actions: 'Actions', hold: 'Hold', releaseHold: 'Release hold', held: 'On hold', noSelection: 'No unresolved tasks of this type', high: 'High', blocker: 'Urgent', medium: 'Medium', low: 'Low', answerInput: 'Answer', answerPlaceholder: 'Write an answer to this question…', sendAnswer: 'Send answer', sending: 'Sending', pending: 'Sent · waiting for update', retry: 'Retry', approve: 'Approve', reject: 'Reject', pass: 'Pass', requestChanges: 'Request changes', complete: 'Report complete', cannotComplete: 'Cannot complete yet'
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
  const submission = selected ? submissions[selected.id] : undefined;
  const isHeld = selected ? heldIds.has(selected.id) : false;
  const isSending = submission?.status === 'sending';
  const runtimeDecisions = selected?.runtimeApproval?.responseOptions ?? [];
  const standardDecisions: Record<Exclude<UserActionKind, 'answer'>, Array<[string, string]>> = {
    approve: [[copy.approve, 'approve'], [copy.reject, 'reject']],
    review: [[copy.pass, 'pass'], [copy.requestChanges, 'request_changes']],
    do: [[copy.complete, 'complete'], [copy.cannotComplete, 'cannot_complete']]
  };

  async function submit(item: AttentionUiItem, response: string) {
    const normalized = response.trim();
    if (!normalized || submissions[item.id]?.status === 'sending') return;
    setSubmissions((current) => ({ ...current, [item.id]: { status: 'sending', response: normalized } }));
    try {
      const result = await onSubmit(item, normalized);
      if (result.status === 'accepted') {
        setSubmissions((current) => ({ ...current, [item.id]: { status: 'pending', response: normalized, correlationId: result.correlationId } }));
      } else {
        setSubmissions((current) => ({ ...current, [item.id]: { status: 'failed', response: normalized, reason: result.reason, retryable: result.retryable } }));
      }
    } catch (error) {
      setSubmissions((current) => ({
        ...current,
        [item.id]: {
          status: 'failed',
          response: normalized,
          reason: error instanceof Error ? error.message : 'The response could not be sent.',
          retryable: true
        }
      }));
    }
  }

  function toggleHold(id: string) {
    setHeldIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

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
                {selected.actionKind === 'answer' ? (
                  <div className="user-task-answer">
                    <label htmlFor={`user-task-answer-${selected.id}`}>{copy.answerInput}</label>
                    <textarea
                      id={`user-task-answer-${selected.id}`}
                      value={drafts[selected.id] ?? ''}
                      placeholder={copy.answerPlaceholder}
                      disabled={!canResolve || isSending}
                      onChange={(event) => setDrafts((current) => ({ ...current, [selected.id]: event.target.value }))}
                    />
                    <div className="user-task-action-buttons">
                      <button type="button" className="is-primary" disabled={!canResolve || isSending || !(drafts[selected.id] ?? '').trim()} onClick={() => void submit(selected, drafts[selected.id] ?? '')}>{copy.sendAnswer}</button>
                      <button type="button" className="is-secondary" disabled={isSending} onClick={() => toggleHold(selected.id)}><Pause size={13} />{isHeld ? copy.releaseHold : copy.hold}</button>
                    </div>
                  </div>
                ) : (
                  <div className="user-task-action-buttons">
                    {canResolve && runtimeDecisions.length ? runtimeDecisions.map((decision) => <button type="button" key={decision} className="is-primary" disabled={isSending} onClick={() => void submit(selected, decision)}>{decision}</button>) : null}
                    {canResolve && !runtimeDecisions.length ? standardDecisions[selected.actionKind].map(([label, value], index) => <button type="button" key={value} className={index === 0 ? 'is-primary' : 'is-secondary'} disabled={isSending} onClick={() => void submit(selected, value)}>{label}</button>) : null}
                    <button type="button" className="is-secondary" disabled={isSending} onClick={() => toggleHold(selected.id)}><Pause size={13} />{isHeld ? copy.releaseHold : copy.hold}</button>
                  </div>
                )}
                {submission?.status === 'sending' ? <p className="user-task-submission user-task-submission--sending" role="status">{copy.sending}</p> : null}
                {submission?.status === 'pending' ? <p className="user-task-submission user-task-submission--pending" role="status"><CheckCircle2 size={14} />{copy.pending}</p> : null}
                {submission?.status === 'failed' ? (
                  <div className="user-task-submission user-task-submission--failed" role="alert">
                    <span><AlertTriangle size={14} />{submission.reason}</span>
                    {submission.retryable ? <button type="button" className="is-secondary" onClick={() => void submit(selected, submission.response)}><RefreshCw size={13} />{copy.retry}</button> : null}
                  </div>
                ) : null}
                {isHeld && !submission ? <p className="user-task-submission user-task-submission--held" role="status"><Pause size={13} />{copy.held}</p> : null}
              </section>
            </div>
          ) : <p className="user-task-empty">{copy.noSelection}</p>}
        </section>
      </div>
    </div>
  );
}
