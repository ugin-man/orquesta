import { useEffect } from 'react';
import { AlertTriangle, CalendarClock, Check, Circle, FileOutput, GitBranch, Link2, MessageCircleQuestion, Play, Search, Send, UserRound, X } from 'lucide-react';
import type { AgentUiModel, TaskUiModel, TaskUiState } from '../../../contracts/orquesta-ui';
import { formatDateTime } from '../../components/format';
import { useI18n } from '../i18n/I18nProvider';

export type TaskRecordScope = 'incomplete' | 'complete' | 'all';
export type TaskRecordStateGroup = 'all' | 'active' | 'waiting' | 'user_wait' | 'review_wait' | 'blocked' | 'complete' | 'failed';
export type TaskRecordPeriod = 'all' | '24h' | '7d' | '30d';
export type TaskRecordSort = 'updated_desc' | 'updated_asc' | 'id_asc';

export interface TaskRecordView {
  scope: TaskRecordScope;
  query: string;
  ownerId: string;
  stateGroup: TaskRecordStateGroup;
  period: TaskRecordPeriod;
  sort: TaskRecordSort;
  selectedTaskId: string | null;
}

export function createDefaultTaskRecordView(): TaskRecordView {
  return {
    scope: 'all',
    query: '',
    ownerId: 'all',
    stateGroup: 'all',
    period: 'all',
    sort: 'updated_desc',
    selectedTaskId: null
  };
}

const stateGroups: Record<Exclude<TaskRecordStateGroup, 'all'>, TaskUiState[]> = {
  active: ['dispatch_accepted', 'turn_started', 'in_progress'],
  waiting: ['queued', 'assigned'],
  user_wait: ['approval_wait'],
  review_wait: ['report_ready', 'needs_review'],
  blocked: ['blocked'],
  complete: ['accepted'],
  failed: ['failed']
};

const stateCopy: Record<'ja' | 'en', Record<TaskUiState, string>> = {
  ja: { queued: '待機', assigned: '割当済み', dispatch_accepted: '委譲済み', turn_started: '実行開始', in_progress: '稼働中', blocked: '停止中', approval_wait: 'ユーザー待ち', report_ready: '報告確認待ち', needs_review: '確認待ち', accepted: '完了', failed: '失敗', unknown: '不明' },
  en: { queued: 'Queued', assigned: 'Assigned', dispatch_accepted: 'Delegated', turn_started: 'Started', in_progress: 'In progress', blocked: 'Blocked', approval_wait: 'Waiting for user', report_ready: 'Report ready', needs_review: 'Needs review', accepted: 'Complete', failed: 'Failed', unknown: 'Unknown' }
};

function timestamp(task: TaskUiModel): number {
  const value = task.updatedAt ?? task.startedAt;
  const parsed = value ? Date.parse(value) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function taskMatchesState(task: TaskUiModel, group: TaskRecordStateGroup): boolean {
  return group === 'all' || stateGroups[group].includes(task.state);
}

function TaskEvidence({ label, value, icon }: { label: string; value: boolean; icon: React.ReactNode }) {
  return <div><span>{icon}{label}</span><strong className={value ? 'is-proven' : undefined}>{value ? <Check size={12} /> : <Circle size={9} />}</strong></div>;
}

function TaskRecordDetail({ task, agents, onClose, onAskLuca }: { task: TaskUiModel; agents: AgentUiModel[]; onClose(): void; onAskLuca?(): void }) {
  const { locale, t } = useI18n();
  const agentById = new Map(agents.map((agent) => [agent.id, agent.displayName]));
  const owner = task.ownerAgentId ? agentById.get(task.ownerAgentId) ?? task.ownerAgentId : t('unknown');
  const assigner = task.assignedByAgentId === 'user' ? (locale === 'ja' ? 'あなた' : 'You') : task.assignedByAgentId ? agentById.get(task.assignedByAgentId) ?? task.assignedByAgentId : t('unknown');
  const copy = locale === 'ja'
    ? { close: 'タスク詳細を閉じる', askLuca: 'このタスクをLucaに聞く', progress: '進捗', ownership: '担当と経路', owner: '担当', assignedBy: '依頼元', routing: '経路', dependencies: '依存タスク', blockedBy: '停止理由', artifact: '成果物', report: '関連レポート', evidence: '実行証拠', models: 'モデル経路', checks: '完了条件', handoff: '引き渡し', dispatch: '委譲受付', turn: '実行開始', observed: '進捗観測', recommended: '推奨', requested: '要求', actual: '実際', started: '開始', updated: '更新' }
    : { close: 'Close task detail', askLuca: 'Ask Luca about this task', progress: 'Progress', ownership: 'Ownership and route', owner: 'Owner', assignedBy: 'Assigned by', routing: 'Routing', dependencies: 'Dependencies', blockedBy: 'Blocked by', artifact: 'Artifact', report: 'Related report', evidence: 'Execution evidence', models: 'Model routing', checks: 'Acceptance checks', handoff: 'Handoff sent', dispatch: 'Dispatch accepted', turn: 'Turn started', observed: 'Progress observed', recommended: 'Recommended', requested: 'Requested', actual: 'Actual', started: 'Started', updated: 'Updated' };
  return (
    <aside className="task-record-detail" role="dialog" aria-modal="true" aria-label={`Task ${task.id} detail`}>
      <header>
        <div><span className={`task-record-state task-record-state--${task.state}`}>{stateCopy[locale][task.state]}</span><small>{task.id}</small></div>
        <button type="button" aria-label={copy.close} onClick={onClose}><X size={16} /></button>
        <h2>{task.title}</h2>
      </header>
      <div className="task-record-detail__scroll">
        {onAskLuca ? <button type="button" className="luca-detail-trigger" onClick={onAskLuca}><MessageCircleQuestion size={15} />{copy.askLuca}</button> : null}
        <section className="task-record-progress">
          <h3>{copy.progress}</h3>
          <div><span>{task.progressSummary ?? stateCopy[locale][task.state]}</span><strong>{task.progressPercent == null ? '—' : `${task.progressPercent}%`}</strong></div>
          <i><span style={{ width: `${task.progressPercent ?? 0}%` }} /></i>
        </section>
        <section><h3>{copy.ownership}</h3><dl className="task-record-facts">
          <div><dt>{copy.owner}</dt><dd>{owner}</dd></div><div><dt>{copy.assignedBy}</dt><dd>{assigner}</dd></div>
          <div><dt>{copy.routing}</dt><dd>{task.routingClass ?? '—'}</dd></div><div><dt>{copy.dependencies}</dt><dd>{task.dependencies.join(', ') || '—'}</dd></div>
          <div><dt>{copy.blockedBy}</dt><dd>{task.blockedBy.join(', ') || '—'}</dd></div><div><dt>{copy.artifact}</dt><dd>{task.expectedArtifact ?? '—'}</dd></div>
          <div className="is-wide"><dt>{copy.report}</dt><dd>{task.reportPath ?? task.reportStatus ?? '—'}</dd></div>
        </dl></section>
        <section><h3>{copy.evidence}</h3><div className="task-record-evidence">
          <TaskEvidence label={copy.handoff} value={task.handoffSent} icon={<Send size={13} />} />
          <TaskEvidence label={copy.dispatch} value={task.dispatchAccepted} icon={<GitBranch size={13} />} />
          <TaskEvidence label={copy.turn} value={task.turnStarted} icon={<Play size={13} />} />
          <TaskEvidence label={copy.observed} value={task.progressObserved} icon={<Link2 size={13} />} />
        </div></section>
        <section><h3>{copy.models}</h3><dl className="task-record-facts">
          <div><dt>{copy.recommended}</dt><dd>{task.recommendedModel ?? '—'}</dd></div><div><dt>{copy.requested}</dt><dd>{task.requestedModel ?? '—'}</dd></div>
          <div className="is-wide"><dt>{copy.actual}</dt><dd>{task.actualModel ?? '—'} <small>· {task.actualModelEvidence}</small></dd></div>
        </dl></section>
        <section><h3><FileOutput size={13} />{copy.checks}</h3>{task.acceptanceChecks.length ? <ul>{task.acceptanceChecks.map((check) => <li key={check}>{check}</li>)}</ul> : <p>—</p>}</section>
        <footer>{copy.started} {formatDateTime(task.startedAt)} · {copy.updated} {formatDateTime(task.updatedAt)}</footer>
      </div>
    </aside>
  );
}

export function TaskRecordsWorkspace({ tasks, agents, view, onViewChange, onAskLuca, lucaActive = false }: {
  tasks: TaskUiModel[];
  agents: AgentUiModel[];
  view: TaskRecordView;
  onViewChange(view: TaskRecordView): void;
  onAskLuca?(taskId: string): void;
  lucaActive?: boolean;
}) {
  const { locale } = useI18n();
  const copy = locale === 'ja'
    ? { summary: 'タスク件数', incomplete: '未完了', complete: '完了', all: 'すべて', filters: 'タスクの絞り込み', search: 'タスクを検索', searchPlaceholder: 'IDまたはタイトルで検索', agent: '担当', allAgents: 'すべての担当', state: '状態', period: '更新期間', sort: '並び順', active: '稼働中', waiting: '待機', user_wait: 'ユーザー待ち', review_wait: 'レビュー待ち', blocked: '停止中', failed: '失敗', periodAll: 'すべての期間', day: '24時間', week: '7日', month: '30日', newest: '更新が新しい順', oldest: '更新が古い順', id: 'ID順', results: '件を表示', empty: '条件に合うタスクはありません', outside: '選択中のタスクは現在の絞り込み条件の外にあります。', updated: '更新', owner: '担当', noSummary: '進捗の要約はありません' }
    : { summary: 'Task summary', incomplete: 'Incomplete', complete: 'Completed', all: 'All', filters: 'Task filters', search: 'Search tasks', searchPlaceholder: 'Search by ID or title', agent: 'Agent', allAgents: 'All agents', state: 'State', period: 'Updated', sort: 'Sort', active: 'Active', waiting: 'Waiting', user_wait: 'Waiting for user', review_wait: 'Review wait', blocked: 'Blocked', failed: 'Failed', periodAll: 'Any time', day: '24 hours', week: '7 days', month: '30 days', newest: 'Newest update', oldest: 'Oldest update', id: 'Task ID', results: 'shown', empty: 'No tasks match these filters.', outside: 'The selected task is outside the current filters.', updated: 'Updated', owner: 'Owner', noSummary: 'No progress summary' };
  const counts = {
    incomplete: tasks.filter((task) => task.state !== 'accepted').length,
    complete: tasks.filter((task) => task.state === 'accepted').length,
    all: tasks.length
  };
  const agentById = new Map(agents.map((agent) => [agent.id, agent.displayName]));
  const ownerOptions = [...new Set(tasks.map((task) => task.ownerAgentId).filter((id): id is string => Boolean(id)))]
    .sort((left, right) => (agentById.get(left) ?? left).localeCompare(agentById.get(right) ?? right));
  const cutoff = view.period === 'all' ? 0 : Date.now() - ({ '24h': 1, '7d': 7, '30d': 30 }[view.period] * 86_400_000);
  const normalizedQuery = view.query.trim().toLocaleLowerCase();
  const visibleTasks = tasks
    .filter((task) => view.scope === 'all' || (view.scope === 'complete' ? task.state === 'accepted' : task.state !== 'accepted'))
    .filter((task) => !normalizedQuery || `${task.id} ${task.title}`.toLocaleLowerCase().includes(normalizedQuery))
    .filter((task) => view.ownerId === 'all' || task.ownerAgentId === view.ownerId)
    .filter((task) => taskMatchesState(task, view.stateGroup))
    .filter((task) => !cutoff || timestamp(task) >= cutoff)
    .sort((left, right) => view.sort === 'id_asc'
      ? left.id.localeCompare(right.id, undefined, { numeric: true })
      : view.sort === 'updated_asc' ? timestamp(left) - timestamp(right) : timestamp(right) - timestamp(left));
  const selected = view.selectedTaskId ? tasks.find((task) => task.id === view.selectedTaskId) ?? null : null;
  const selectedOutsideFilters = Boolean(selected && !visibleTasks.some((task) => task.id === selected.id));
  const update = (patch: Partial<TaskRecordView>) => onViewChange({ ...view, ...patch });
  const stateSelection = view.stateGroup === 'all' ? view.scope : view.stateGroup;
  const stateOptions: Array<[TaskRecordScope | Exclude<TaskRecordStateGroup, 'all' | 'complete'>, string]> = [['all', copy.all], ['complete', copy.complete], ['incomplete', copy.incomplete], ['active', copy.active], ['waiting', copy.waiting], ['user_wait', copy.user_wait], ['review_wait', copy.review_wait], ['blocked', copy.blocked], ['failed', copy.failed]];
  const selectState = (value: string) => {
    if (value === 'all' || value === 'complete' || value === 'incomplete') update({ scope: value, stateGroup: 'all' });
    else update({ scope: 'all', stateGroup: value as TaskRecordStateGroup });
  };

  useEffect(() => {
    if (!selected) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onViewChange({ ...view, selectedTaskId: null });
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [selected?.id, onViewChange, view]);

  return (
    <div className="task-records-workspace">
      <div className="task-record-summary" aria-label={copy.summary}><span>{copy.all}<strong>{counts.all}</strong></span><span>{copy.complete}<strong>{counts.complete}</strong></span><span>{copy.incomplete}<strong>{counts.incomplete}</strong></span></div>
      <div className="task-record-filters" aria-label={copy.filters}>
        <label className="task-record-search"><Search size={14} /><input type="search" aria-label={copy.search} placeholder={copy.searchPlaceholder} value={view.query} onChange={(event) => update({ query: event.target.value })} /></label>
        <label><span>{copy.agent}</span><select aria-label={copy.agent} value={view.ownerId} onChange={(event) => update({ ownerId: event.target.value })}><option value="all">{copy.allAgents}</option>{ownerOptions.map((id) => <option key={id} value={id}>{agentById.get(id) ?? id}</option>)}</select></label>
        <label><span>{copy.state}</span><select aria-label={copy.state} value={stateSelection} onChange={(event) => selectState(event.target.value)}>{stateOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label><span>{copy.period}</span><select aria-label={copy.period} value={view.period} onChange={(event) => update({ period: event.target.value as TaskRecordPeriod })}><option value="all">{copy.periodAll}</option><option value="24h">{copy.day}</option><option value="7d">{copy.week}</option><option value="30d">{copy.month}</option></select></label>
        <label><span>{copy.sort}</span><select aria-label={copy.sort} value={view.sort} onChange={(event) => update({ sort: event.target.value as TaskRecordSort })}><option value="updated_desc">{copy.newest}</option><option value="updated_asc">{copy.oldest}</option><option value="id_asc">{copy.id}</option></select></label>
      </div>
      <div className="task-record-layout" data-testid="task-record-layout">
        <section className="task-record-results" aria-label={`${visibleTasks.length} ${copy.results}`}>
          <header><span><strong>{visibleTasks.length}</strong> {copy.results}</span>{selectedOutsideFilters ? <small><AlertTriangle size={12} />{copy.outside}</small> : null}</header>
          <div className="task-record-grid">
            {visibleTasks.map((task) => {
              const owner = task.ownerAgentId ? agentById.get(task.ownerAgentId) ?? task.ownerAgentId : '—';
              const summary = task.blockedBy[0] ?? task.progressSummary ?? copy.noSummary;
              return (
                <button type="button" key={task.id} aria-label={`${task.id} · ${task.title}`} aria-current={selected?.id === task.id ? 'true' : undefined} onClick={() => update({ selectedTaskId: task.id })}>
                  <header><span>{task.id}</span><strong className={`task-record-state task-record-state--${task.state}`}>{stateCopy[locale][task.state]}</strong></header>
                  <h3>{task.title}</h3>
                  <dl><div><dt><UserRound size={12} />{copy.owner}</dt><dd>{owner}</dd></div><div><dt><CalendarClock size={12} />{copy.updated}</dt><dd>{formatDateTime(task.updatedAt)}</dd></div></dl>
                  <p className={task.blockedBy.length ? 'is-blocked' : undefined}>{task.blockedBy.length ? <AlertTriangle size={12} /> : null}{summary}</p>
                </button>
              );
            })}
            {!visibleTasks.length ? <p className="task-record-empty">{copy.empty}</p> : null}
          </div>
        </section>
      </div>
      {selected ? <div className={`task-record-modal-layer${lucaActive ? ' has-luca' : ''}`} data-testid="task-record-modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget) update({ selectedTaskId: null }); }}><TaskRecordDetail task={selected} agents={agents} onClose={() => update({ selectedTaskId: null })} onAskLuca={onAskLuca ? () => onAskLuca(selected.id) : undefined} /></div> : null}
    </div>
  );
}
