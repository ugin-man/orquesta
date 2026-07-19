import { AlertTriangle, ArrowRight, CheckCircle2, Clock3, ListTodo, MessageCircle, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { ConversationMessage } from '../../../contracts/bridge';
import type { AttentionUiItem, OrquestaUiSnapshot } from '../../../contracts/orquesta-ui';
import { formatDateTime } from '../../components/format';
import { useI18n } from '../i18n/I18nProvider';

export type TimelineRecordKind = 'task' | 'error' | 'conversation' | 'decision';
export type TimelineKindFilter = TimelineRecordKind | 'all';
export type TimelinePeriod = 'all' | 'day' | 'week' | 'month';

export interface TimelineRecord {
  id: string;
  sourceId: string;
  kind: TimelineRecordKind;
  title: string;
  summary: string;
  timestamp: string | null;
  agentId: string | null;
  taskId: string | null;
  count: number;
}

interface TimelineRecordsWorkspaceProps {
  snapshot: OrquestaUiSnapshot;
  conversations: ConversationMessage[];
  decisions: AttentionUiItem[];
  loading: boolean;
  onOpenRecord(record: TimelineRecord): void;
}

const GROUP_WINDOW_MS = 30 * 60 * 1000;
const RENDER_STEP = 200;

function timestampValue(value: string | null): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

function groupConversations(messages: ConversationMessage[], agentNames: Map<string, string>): TimelineRecord[] {
  const byTarget = new Map<string, ConversationMessage[]>();
  messages.forEach((message) => byTarget.set(message.targetAgentId, [...(byTarget.get(message.targetAgentId) ?? []), message]));

  return [...byTarget.entries()].flatMap(([targetAgentId, targetMessages]) => {
    const groups: ConversationMessage[][] = [];
    [...targetMessages].sort((left, right) => timestampValue(left.createdAt) - timestampValue(right.createdAt)).forEach((message) => {
      const current = groups.at(-1);
      const previous = current?.at(-1);
      const gap = previous ? timestampValue(message.createdAt) - timestampValue(previous.createdAt) : Number.POSITIVE_INFINITY;
      if (!current || gap > GROUP_WINDOW_MS) groups.push([message]);
      else current.push(message);
    });

    return groups.map((group) => {
      const first = group[0];
      const last = group.at(-1) ?? first;
      return {
        id: `conversation:${targetAgentId}:${first.id}`,
        sourceId: targetAgentId,
        kind: 'conversation' as const,
        title: `Conversation · ${agentNames.get(targetAgentId) ?? targetAgentId}`,
        summary: group.length === 1 ? first.text : `${group.length} messages · ${first.text}`,
        timestamp: last.createdAt,
        agentId: targetAgentId,
        taskId: null,
        count: group.length
      };
    });
  });
}

function buildTimelineRecords(snapshot: OrquestaUiSnapshot, conversations: ConversationMessage[], decisions: AttentionUiItem[]): TimelineRecord[] {
  const agentNames = new Map(snapshot.agents.map((agent) => [agent.id, agent.displayName]));
  const taskRecords: TimelineRecord[] = snapshot.tasks.map((task) => ({
    id: `task:${task.id}`,
    sourceId: task.id,
    kind: 'task',
    title: task.title,
    summary: task.progressSummary ?? task.expectedArtifact ?? task.state.replaceAll('_', ' '),
    timestamp: task.updatedAt ?? task.startedAt,
    agentId: task.ownerAgentId,
    taskId: task.id,
    count: 1
  }));
  const failureRecords: TimelineRecord[] = snapshot.failures.map((failure) => ({
    id: `error:${failure.id}`,
    sourceId: failure.id,
    kind: 'error',
    title: failure.title,
    summary: failure.summary,
    timestamp: failure.lastOccurredAt ?? failure.firstOccurredAt,
    agentId: failure.sourceAgentIds[0] ?? null,
    taskId: failure.taskIds[0] ?? null,
    count: failure.occurrenceCount
  }));
  const decisionRecords: TimelineRecord[] = decisions.map((decision) => ({
    id: `decision:${decision.id}`,
    sourceId: decision.id,
    kind: 'decision',
    title: decision.title,
    summary: decision.resolutionLabel ?? decision.summary,
    timestamp: decision.resolvedAt ?? decision.createdAt,
    agentId: decision.sourceAgentId,
    taskId: decision.taskId,
    count: 1
  }));

  return [...taskRecords, ...failureRecords, ...groupConversations(conversations, agentNames), ...decisionRecords]
    .sort((left, right) => timestampValue(right.timestamp) - timestampValue(left.timestamp));
}

function TimelineIcon({ kind }: { kind: TimelineRecordKind }) {
  if (kind === 'task') return <ListTodo size={15} />;
  if (kind === 'error') return <AlertTriangle size={15} />;
  if (kind === 'conversation') return <MessageCircle size={15} />;
  return <CheckCircle2 size={15} />;
}

export function TimelineRecordsWorkspace({ snapshot, conversations, decisions, loading, onOpenRecord }: TimelineRecordsWorkspaceProps) {
  const { locale, t } = useI18n();
  const [kind, setKind] = useState<TimelineKindFilter>('all');
  const [period, setPeriod] = useState<TimelinePeriod>('all');
  const [agentId, setAgentId] = useState('all');
  const [taskQuery, setTaskQuery] = useState('');
  const [renderLimit, setRenderLimit] = useState(RENDER_STEP);
  const copy = locale === 'ja' ? {
    types: 'タイムラインの種類', tasks: 'タスク', errors: 'エラー', conversation: '会話', decisions: 'ユーザー判断',
    period: '期間', agent: 'エージェント', task: 'タスクID', allTime: '全期間', day: '24時間', week: '7日間', month: '30日間',
    allAgents: 'すべてのエージェント', taskPlaceholder: 'T69 など', list: 'プロジェクトの時系列', events: '件',
    loading: 'タイムラインを読み込み中…', empty: '条件に合う記録はありません。', unknownTime: '日時不明', occurrences: '回'
  } : {
    types: 'Timeline types', tasks: 'Tasks', errors: 'Errors', conversation: 'Conversation', decisions: 'Decisions',
    period: 'Period', agent: 'Agent', task: 'Task ID', allTime: 'All time', day: 'Last 24 hours', week: 'Last 7 days', month: 'Last 30 days',
    allAgents: 'All agents', taskPlaceholder: 'e.g. T69', list: 'Project timeline', events: 'events',
    loading: 'Loading timeline…', empty: 'No records match these filters.', unknownTime: 'Unknown time', occurrences: 'occurrences'
  };
  const labels: Record<TimelineRecordKind, string> = { task: copy.tasks, error: copy.errors, conversation: copy.conversation, decision: copy.decisions };
  const singularLabels: Record<TimelineRecordKind, string> = {
    task: locale === 'ja' ? 'タスク' : 'Task',
    error: locale === 'ja' ? 'エラー' : 'Error',
    conversation: locale === 'ja' ? '会話' : 'Conversation',
    decision: locale === 'ja' ? 'ユーザー判断' : 'Decision'
  };
  const allRecords = useMemo(() => buildTimelineRecords(snapshot, conversations, decisions), [snapshot, conversations, decisions]);
  const counts: Record<TimelineKindFilter, number> = {
    all: allRecords.length,
    task: allRecords.filter((record) => record.kind === 'task').length,
    error: allRecords.filter((record) => record.kind === 'error').length,
    conversation: allRecords.filter((record) => record.kind === 'conversation').length,
    decision: allRecords.filter((record) => record.kind === 'decision').length
  };
  const visibleRecords = useMemo(() => {
    const periodMs: Record<Exclude<TimelinePeriod, 'all'>, number> = { day: 86_400_000, week: 604_800_000, month: 2_592_000_000 };
    const threshold = period === 'all' ? Number.NEGATIVE_INFINITY : Date.now() - periodMs[period];
    const normalizedTask = taskQuery.trim().toLowerCase();
    return allRecords.filter((record) => (
      (kind === 'all' || record.kind === kind)
      && timestampValue(record.timestamp) >= threshold
      && (agentId === 'all' || record.agentId === agentId)
      && (!normalizedTask || record.taskId?.toLowerCase().includes(normalizedTask))
    ));
  }, [agentId, allRecords, kind, period, taskQuery]);
  useEffect(() => setRenderLimit(RENDER_STEP), [agentId, kind, period, taskQuery]);
  const renderedRecords = visibleRecords.slice(0, renderLimit);
  const remainingRecords = Math.max(0, visibleRecords.length - renderedRecords.length);
  const countLabel = locale === 'ja'
    ? `${visibleRecords.length}件中${renderedRecords.length}件を表示`
    : `${renderedRecords.length} of ${visibleRecords.length} events`;
  const nextCount = Math.min(RENDER_STEP, remainingRecords);
  const moreLabel = locale === 'ja' ? `さらに${nextCount}件表示` : `Show ${nextCount} more`;
  const filters: Array<[TimelineKindFilter, string]> = [['all', t('all')], ['task', copy.tasks], ['error', copy.errors], ['conversation', copy.conversation], ['decision', copy.decisions]];

  return (
    <div className="timeline-records-workspace">
      <nav className="timeline-record-types" aria-label={copy.types}>
        {filters.map(([value, label]) => (
          <button type="button" key={value} aria-current={kind === value ? 'page' : undefined} onClick={() => setKind(value)}>
            <span>{label}</span><strong>{counts[value]}</strong>
          </button>
        ))}
      </nav>
      <div className="timeline-record-filters">
        <label><span>{copy.period}</span><select aria-label={copy.period} value={period} onChange={(event) => setPeriod(event.target.value as TimelinePeriod)}><option value="all">{copy.allTime}</option><option value="day">{copy.day}</option><option value="week">{copy.week}</option><option value="month">{copy.month}</option></select></label>
        <label><span>{copy.agent}</span><select aria-label={copy.agent} value={agentId} onChange={(event) => setAgentId(event.target.value)}><option value="all">{copy.allAgents}</option>{snapshot.agents.map((agent) => <option value={agent.id} key={agent.id}>{agent.displayName}</option>)}</select></label>
        <label><span>{copy.task}</span><span className="timeline-task-search"><Search size={13} /><input aria-label={copy.task} value={taskQuery} placeholder={copy.taskPlaceholder} onChange={(event) => setTaskQuery(event.target.value)} /></span></label>
      </div>
      <section className="timeline-record-list" aria-label={copy.list}>
        <header aria-label={countLabel}><strong>{renderedRecords.length}</strong><span>/ {visibleRecords.length} {copy.events}</span></header>
        <div className="timeline-record-list__scroll">
          {renderedRecords.map((record) => (
            <button type="button" key={record.id} aria-label={`${singularLabels[record.kind]} · ${record.sourceId} · ${record.title}`} onClick={() => onOpenRecord(record)}>
              <time>{record.timestamp ? formatDateTime(record.timestamp) : copy.unknownTime}</time>
              <span className={`timeline-record-marker timeline-record-marker--${record.kind}`}><TimelineIcon kind={record.kind} /></span>
              <span className="timeline-record-content"><small>{labels[record.kind]}</small><strong>{record.title}</strong><p>{record.summary}</p></span>
              <span className="timeline-record-meta"><small>{record.agentId ?? '—'}</small><small>{record.taskId ?? '—'}</small>{record.count > 1 && record.kind === 'error' ? <small>{record.count} {copy.occurrences}</small> : null}</span>
              <ArrowRight size={15} aria-hidden="true" />
            </button>
          ))}
          {remainingRecords ? <button type="button" className="timeline-load-more" onClick={() => setRenderLimit((current) => current + RENDER_STEP)}>{moreLabel}</button> : null}
          {!loading && !visibleRecords.length ? <p className="timeline-record-empty"><Clock3 size={17} />{copy.empty}</p> : null}
          {loading && !visibleRecords.length ? <p className="timeline-record-empty">{copy.loading}</p> : null}
        </div>
      </section>
    </div>
  );
}
