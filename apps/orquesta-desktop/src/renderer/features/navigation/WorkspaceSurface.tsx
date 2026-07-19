import { ArrowRight, GitBranch } from 'lucide-react';
import type { ConversationMessage, RuntimeInfoUi, UiActionResult } from '../../../contracts/bridge';
import type { AttentionUiItem, OrquestaUiSnapshot, TaskUiModel } from '../../../contracts/orquesta-ui';
import { UserTasksWorkspace, type UserTaskKind } from '../attention/UserTasksWorkspace';
import { useI18n } from '../i18n/I18nProvider';
import { TaskRecordsWorkspace, type TaskRecordView } from '../records/TaskRecordsWorkspace';
import { FailureRecordsWorkspace, type FailureRecordView } from '../records/FailureRecordsWorkspace';
import { ConversationRecordsWorkspace } from '../records/ConversationRecordsWorkspace';
import { DecisionRecordsWorkspace, type DecisionRecordKind } from '../records/DecisionRecordsWorkspace';
import { TimelineRecordsWorkspace, type TimelineRecord } from '../records/TimelineRecordsWorkspace';
import { SettingsWorkspace } from '../settings/SettingsWorkspace';
import type { WorkspaceId } from './WorkspaceDock';

export type { UserTaskKind } from '../attention/UserTasksWorkspace';
export type RecordKind = 'task' | 'error' | 'conversation' | 'decision' | 'timeline';

const taskRank: Record<TaskUiModel['state'], number> = {
  blocked: 0,
  approval_wait: 1,
  needs_review: 2,
  failed: 3,
  in_progress: 4,
  turn_started: 5,
  assigned: 6,
  dispatch_accepted: 7,
  queued: 8,
  report_ready: 9,
  accepted: 10,
  unknown: 11
};

function AttentionList({ items, onOpen }: { items: AttentionUiItem[]; onOpen(item: AttentionUiItem): void }) {
  const { locale, t } = useI18n();
  const actionLabel = { answer: t('answerAction'), approve: t('approve'), review: t('reviewAction'), do: t('doAction') };
  const priorityLabel = locale === 'ja'
    ? { blocker: '最優先', high: '高', medium: '中', low: '低' }
    : { blocker: 'Blocker', high: 'High', medium: 'Medium', low: 'Low' };
  if (!items.length) return <p className="workspace-empty">{t('allClearDetail')}</p>;
  return (
    <div className="workspace-list">
      {items.map((item) => (
        <button type="button" key={item.id} onClick={() => onOpen(item)}>
          <span><strong>{item.title}</strong><small>{actionLabel[item.actionKind]} · {priorityLabel[item.priority]}</small><p>{item.summary}</p></span>
          <ArrowRight size={15} aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}

function TaskList({ tasks, onOpen }: { tasks: TaskUiModel[]; onOpen(taskId: string): void }) {
  const { locale, t } = useI18n();
  const stateLabel: Record<TaskUiModel['state'], string> = locale === 'ja'
    ? { queued: '待機', assigned: '割当済み', dispatch_accepted: '委譲済み', turn_started: '実行開始', in_progress: '作業中', blocked: '停止中', approval_wait: 'ユーザー待ち', report_ready: '報告確認待ち', needs_review: '確認待ち', accepted: '完了', failed: '失敗', unknown: '不明' }
    : { queued: 'Queued', assigned: 'Assigned', dispatch_accepted: 'Delegated', turn_started: 'Started', in_progress: 'In progress', blocked: 'Blocked', approval_wait: 'Waiting for user', report_ready: 'Report ready', needs_review: 'Needs review', accepted: 'Complete', failed: 'Failed', unknown: 'Unknown' };
  if (!tasks.length) return <p className="workspace-empty">{t('noActiveWork')}</p>;
  const sorted = [...tasks].sort((left, right) => taskRank[left.state] - taskRank[right.state]);
  return (
    <div className="workspace-list">
      {sorted.map((task) => (
        <button type="button" key={task.id} onClick={() => onOpen(task.id)}>
          <span><strong>{task.id} · {task.title}</strong><small>{stateLabel[task.state]} · {task.ownerAgentId ?? t('unknown')}</small><p>{task.expectedArtifact ?? task.progressSummary ?? (task.blockedBy.join(', ') || task.routingClass) ?? ''}</p></span>
          <ArrowRight size={15} aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}

export function WorkspaceSurface({ active, snapshot, reducedMotion, userTaskKind, recordKind, taskRecordView, failureRecordView, decisionRecords, decisionRecordKind, decisionRecordsLoading, timelineConversations, timelineDecisions, timelineLoading, messages, conversationTargetAgentId, conversationLoading, conversationHasOlder, canResolveAttention, getRuntimeInfo, onSelectUserTaskKind, onSelectRecordKind, onTaskRecordViewChange, onFailureRecordViewChange, onDecisionRecordKindChange, onOpenTimelineRecord, onSelectConversationTarget, onLoadOlderConversation, onOpenAttention, onResolveAttention, onOpenRoute, onOpenOperations }: {
  active: Exclude<WorkspaceId, 'home'>;
  snapshot: OrquestaUiSnapshot;
  reducedMotion: boolean;
  userTaskKind: UserTaskKind;
  recordKind: RecordKind;
  taskRecordView: TaskRecordView;
  failureRecordView: FailureRecordView;
  decisionRecords: AttentionUiItem[];
  decisionRecordKind: DecisionRecordKind;
  decisionRecordsLoading: boolean;
  timelineConversations: ConversationMessage[];
  timelineDecisions: AttentionUiItem[];
  timelineLoading: boolean;
  messages: ConversationMessage[];
  conversationTargetAgentId: string;
  conversationLoading: boolean;
  conversationHasOlder: boolean;
  canResolveAttention: boolean;
  getRuntimeInfo(input: { probe: boolean }): Promise<RuntimeInfoUi>;
  onSelectUserTaskKind(kind: UserTaskKind): void;
  onSelectRecordKind(kind: RecordKind): void;
  onTaskRecordViewChange(view: TaskRecordView): void;
  onFailureRecordViewChange(view: FailureRecordView): void;
  onDecisionRecordKindChange(kind: DecisionRecordKind): void;
  onOpenTimelineRecord(record: TimelineRecord): void;
  onSelectConversationTarget(agentId: string): void;
  onLoadOlderConversation(): void;
  onOpenAttention(item: AttentionUiItem): void;
  onResolveAttention(item: AttentionUiItem, decision: string): Promise<UiActionResult>;
  onOpenRoute(): void;
  onOpenOperations(): void;
}) {
  const { t } = useI18n();
  const title = {
    'user-tasks': t('workspaceUserTasks'),
    records: t('workspaceRecords'),
    settings: t('workspaceSettings'),
    more: t('workspaceMore')
  }[active];
  const recordTypes: Array<[RecordKind, string]> = [
    ['task', t('recordTasks')],
    ['error', t('recordErrors')],
    ['conversation', t('recordConversation')],
    ['decision', t('recordDecisions')],
    ['timeline', t('recordTimeline')]
  ];

  return (
    <section className={`workspace-surface workspace-surface--${active}`} aria-label={title}>
      <header className="workspace-surface__header"><div><small>{snapshot.project.title}</small><h1>{title}</h1></div><span>{active === 'user-tasks' ? snapshot.attention.length : ''}</span></header>
      {active === 'records' ? (
        <nav className="workspace-tabs" aria-label={t('recordTypes')}>
          {recordTypes.map(([kind, label]) => <button type="button" key={kind} aria-current={recordKind === kind ? 'page' : undefined} onClick={() => onSelectRecordKind(kind)}>{label}</button>)}
        </nav>
      ) : null}
      <div className={`workspace-surface__body${active === 'user-tasks' ? ' workspace-surface__body--user-tasks' : ''}${active === 'records' && recordKind === 'task' ? ' workspace-surface__body--task-records' : ''}${active === 'records' && recordKind === 'error' ? ' workspace-surface__body--failure-records' : ''}${active === 'records' && recordKind === 'conversation' ? ' workspace-surface__body--conversation-records' : ''}${active === 'records' && recordKind === 'decision' ? ' workspace-surface__body--decision-records' : ''}${active === 'records' && recordKind === 'timeline' ? ' workspace-surface__body--timeline-records' : ''}${active === 'settings' ? ' workspace-surface__body--settings' : ''}`}>
        {active === 'user-tasks' ? (
          <UserTasksWorkspace
            items={snapshot.attention}
            agents={snapshot.agents}
            selectedKind={userTaskKind}
            canResolve={canResolveAttention}
            onSelectKind={onSelectUserTaskKind}
            onSubmit={onResolveAttention}
          />
        ) : null}
        {active === 'records' && recordKind === 'task' ? <TaskRecordsWorkspace tasks={snapshot.tasks} agents={snapshot.agents} view={taskRecordView} onViewChange={onTaskRecordViewChange} /> : null}
        {active === 'records' && recordKind === 'error' ? <FailureRecordsWorkspace failures={snapshot.failures} view={failureRecordView} onViewChange={onFailureRecordViewChange} /> : null}
        {active === 'records' && recordKind === 'conversation' ? (
          <ConversationRecordsWorkspace agents={snapshot.agents} targetAgentId={conversationTargetAgentId} messages={messages} loading={conversationLoading} hasOlder={conversationHasOlder} onSelectTarget={onSelectConversationTarget} onLoadOlder={onLoadOlderConversation} />
        ) : null}
        {active === 'records' && recordKind === 'decision' ? <DecisionRecordsWorkspace items={decisionRecords} agents={snapshot.agents} selectedKind={decisionRecordKind} loading={decisionRecordsLoading} onSelectKind={onDecisionRecordKindChange} /> : null}
        {active === 'records' && recordKind === 'timeline' ? <TimelineRecordsWorkspace snapshot={snapshot} conversations={timelineConversations} decisions={timelineDecisions} loading={timelineLoading} onOpenRecord={onOpenTimelineRecord} /> : null}
        {active === 'settings' ? <SettingsWorkspace project={snapshot.project} reducedMotion={reducedMotion} getRuntimeInfo={getRuntimeInfo} onOpenOperations={onOpenOperations} /> : null}
        {active === 'more' ? (
          <div className="workspace-more-grid">
            <button type="button" onClick={onOpenRoute}><GitBranch size={18} /><span><strong>{t('projectRoute')}</strong><small>{snapshot.project.rootPathLabel ?? t('pathUnavailable')}</small></span></button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
