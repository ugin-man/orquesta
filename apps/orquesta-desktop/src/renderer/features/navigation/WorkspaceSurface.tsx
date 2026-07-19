import { ArrowRight, Bot, GitBranch, Languages, Network, Settings, ShieldAlert, Stethoscope, UserRound, Wrench } from 'lucide-react';
import type { ConversationMessage } from '../../../contracts/bridge';
import type { AttentionUiItem, OrquestaUiSnapshot, TaskUiModel } from '../../../contracts/orquesta-ui';
import { formatDateTime } from '../../components/format';
import { useI18n } from '../i18n/I18nProvider';
import type { WorkspaceId } from './WorkspaceDock';

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

function ConversationList({ messages, loading, hasOlder, onLoadOlder }: {
  messages: ConversationMessage[];
  loading: boolean;
  hasOlder: boolean;
  onLoadOlder(): void;
}) {
  const { t } = useI18n();
  return (
    <div className="workspace-conversation">
      {hasOlder ? <button type="button" className="workspace-load-older" disabled={loading} onClick={onLoadOlder}>{loading ? t('loadingOlder') : t('loadOlder')}</button> : null}
      {messages.length ? messages.map((message) => (
        <article key={message.id} className={`workspace-message workspace-message--${message.role}`}>
          <span>{message.role === 'user' ? <UserRound size={15} /> : <Bot size={15} />}</span>
          <div><header><strong>{message.authorLabel}</strong><time>{formatDateTime(message.createdAt)}</time></header><p>{message.text}</p></div>
        </article>
      )) : <p className="workspace-empty">{t('noMessages')}</p>}
    </div>
  );
}

export function WorkspaceSurface({ active, snapshot, messages, conversationTargetLabel, conversationLoading, conversationHasOlder, onLoadOlderConversation, onOpenAttention, onOpenTask, onOpenRoute, onOpenOperations, onOpenTeam }: {
  active: Exclude<WorkspaceId, 'home'>;
  snapshot: OrquestaUiSnapshot;
  messages: ConversationMessage[];
  conversationTargetLabel: string;
  conversationLoading: boolean;
  conversationHasOlder: boolean;
  onLoadOlderConversation(): void;
  onOpenAttention(item: AttentionUiItem): void;
  onOpenTask(taskId: string): void;
  onOpenRoute(): void;
  onOpenOperations(): void;
  onOpenTeam(): void;
}) {
  const { locale, setLocale, t } = useI18n();
  const title = {
    attention: t('workspaceAttention'),
    tasks: t('tasks'),
    failures: t('workspaceFailures'),
    conversation: t('workspaceConversation'),
    more: t('workspaceMore')
  }[active];
  const failures = snapshot.attention.filter((item) => item.type === 'error' || item.type === 'repair');
  const visibleTitle = active === 'conversation' ? `${title} · ${conversationTargetLabel}` : title;

  return (
    <section className={`workspace-surface workspace-surface--${active}`} aria-label={title}>
      <header className="workspace-surface__header"><div><small>{snapshot.project.title}</small><h1>{visibleTitle}</h1></div><span>{active === 'tasks' ? snapshot.tasks.length : active === 'attention' ? snapshot.attention.length : ''}</span></header>
      <div className="workspace-surface__body">
        {active === 'attention' ? <AttentionList items={snapshot.attention} onOpen={onOpenAttention} /> : null}
        {active === 'tasks' ? <TaskList tasks={snapshot.tasks} onOpen={onOpenTask} /> : null}
        {active === 'failures' ? (
          failures.length ? <AttentionList items={failures} onOpen={onOpenAttention} /> : <p className="workspace-empty"><ShieldAlert size={20} />{t('noFailures')}</p>
        ) : null}
        {active === 'conversation' ? <ConversationList messages={messages} loading={conversationLoading} hasOlder={conversationHasOlder} onLoadOlder={onLoadOlderConversation} /> : null}
        {active === 'more' ? (
          <div className="workspace-more-grid">
            <button type="button" onClick={onOpenRoute}><GitBranch size={18} /><span><strong>{t('projectRoute')}</strong><small>{snapshot.project.rootPathLabel ?? t('pathUnavailable')}</small></span></button>
            <button type="button" onClick={onOpenOperations}><Wrench size={18} /><span><strong>{t('operationsTitle')}</strong><small>{t('operationsIntro')}</small></span></button>
            <button type="button" onClick={onOpenTeam}><Network size={18} /><span><strong>{t('teamManagement')}</strong><small>{snapshot.agents.length} {t('agents')}</small></span></button>
            <section><Settings size={18} /><div><strong>{t('displayLanguage')}</strong><small>{t('languageDetail')}</small><span className="workspace-language"><button type="button" aria-label="日本語" aria-pressed={locale === 'ja'} onClick={() => setLocale('ja')}><Languages size={13} />JA</button><button type="button" aria-label="English" aria-pressed={locale === 'en'} onClick={() => setLocale('en')}>EN</button></span></div></section>
            <details className="workspace-diagnostics"><summary><Stethoscope size={18} /><span><strong>{t('diagnostics')}</strong><small>{snapshot.project.connectionLabel}</small></span></summary><dl><div><dt>{t('status')}</dt><dd>{snapshot.project.repositoryDisplayState}</dd></div><div><dt>{t('projectRoot')}</dt><dd>{snapshot.project.rootPathLabel ?? t('pathUnavailable')}</dd></div><div><dt>{t('lastSynced')}</dt><dd>{formatDateTime(snapshot.project.lastSyncedAt)}</dd></div></dl></details>
          </div>
        ) : null}
      </div>
    </section>
  );
}
