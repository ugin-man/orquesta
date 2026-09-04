import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import {
  ArrowDown,
  Check,
  ChevronDown,
  Copy,
  FileDiff,
  FilePenLine,
  History,
  ListChecks,
  MoreHorizontal,
  RefreshCw,
  Terminal,
  Wrench,
} from 'lucide-react';
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ApplicationStore } from '../../application/store';
import type { ApplicationState } from '../../application/state';
import { compareConversationActivityOrder, compareConversationEntryOrder } from '../../domain/exact-order';
import type { ConversationActivity, ConversationMessage } from '../../domain/models';
import {
  conversationActivityStateCopy,
  planStepStatusCopy,
} from '../../presentation/user-copy';

interface ChatSurfaceV2Props {
  state: ApplicationState;
  store: ApplicationStore;
  locale: 'ja' | 'en';
  agentLabel: string;
  afterMessages?: ReactNode;
}

export interface ConversationActivityGroup {
  entryType: 'activity-group';
  id: string;
  threadId: string;
  turnId: string;
  targetAgentId: string;
  createdAt: string;
  updatedAt: string;
  activities: ConversationActivity[];
}

type ConversationEntry = ConversationMessage | ConversationActivityGroup;

function safeDate(value: string): Date {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date(0) : date;
}

export async function loadOlderWithScrollAnchor(
  viewport: HTMLElement | null,
  isCurrent: () => boolean,
  loadOlder: () => Promise<boolean>,
): Promise<boolean | null> {
  const beforeHeight = viewport?.scrollHeight ?? 0;
  const beforeTop = viewport?.scrollTop ?? 0;
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  if (!isCurrent()) return null;
  const prepended = await loadOlder();
  if (!isCurrent()) return null;
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  if (!isCurrent()) return null;
  if (viewport) {
    viewport.scrollTop = prepended
      ? beforeTop + Math.max(0, viewport.scrollHeight - beforeHeight)
      : viewport.scrollHeight;
  }
  return prepended;
}

export function conversationMessageToThreadMessage(message: ConversationMessage): ThreadMessageLike {
  return {
    id: message.id,
    role: message.role === 'agent' ? 'assistant' : message.role,
    content: [{ type: 'text', text: message.text }],
    createdAt: safeDate(message.createdAt),
    ...(message.role === 'agent' ? {
      status: message.status === 'running'
        ? { type: 'running' as const }
        : { type: 'complete' as const, reason: 'stop' as const },
    } : {}),
    metadata: {
      custom: {
        authorLabel: message.authorLabel,
        evidenceLabel: message.evidenceLabel,
        targetAgentId: message.targetAgentId,
      },
    },
  };
}

function isActivityGroup(entry: ConversationEntry): entry is ConversationActivityGroup {
  return 'entryType' in entry && entry.entryType === 'activity-group';
}

export function groupConversationEntries(
  messages: readonly ConversationMessage[],
  activities: readonly ConversationActivity[],
): ConversationEntry[] {
  const groups = new Map<string, ConversationActivity[]>();
  for (const activity of activities) {
    const key = `${activity.threadId}\u0000${activity.turnId}`;
    const current = groups.get(key);
    if (current) current.push(activity);
    else groups.set(key, [activity]);
  }
  const activityGroups = [...groups.values()].map<ConversationActivityGroup>((items) => {
    const ordered = [...items].sort(compareConversationActivityOrder);
    const first = ordered[0];
    const updatedAt = ordered.reduce((latest, item) => item.updatedAt > latest ? item.updatedAt : latest, first.updatedAt);
    return {
      entryType: 'activity-group',
      id: `activity-group:${first.threadId}:${first.turnId}`,
      threadId: first.threadId,
      turnId: first.turnId,
      targetAgentId: first.targetAgentId,
      createdAt: first.createdAt,
      updatedAt,
      activities: ordered,
    };
  });
  return [...messages, ...activityGroups].sort(compareConversationEntryOrder);
}

function activityGroupToThreadMessage(group: ConversationActivityGroup): ThreadMessageLike {
  return {
    id: group.id,
    role: 'assistant',
    content: [{ type: 'text', text: group.activities.map((activity) => activity.title).join(' · ') }],
    createdAt: safeDate(group.createdAt),
    status: { type: 'complete', reason: 'stop' },
    metadata: {
      custom: {
        activityGroupJson: JSON.stringify(group),
        targetAgentId: group.targetAgentId,
      },
    },
  };
}

function conversationEntryToThreadMessage(entry: ConversationEntry): ThreadMessageLike {
  return isActivityGroup(entry)
    ? activityGroupToThreadMessage(entry)
    : conversationMessageToThreadMessage(entry);
}

function textFromAppendMessage(message: AppendMessage): string {
  return message.content
    .filter((part): part is Extract<(typeof message.content)[number], { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

function customString(custom: Record<string, unknown>, key: string): string | null {
  const value = custom[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function activityGroupFromCustom(custom: Record<string, unknown>): ConversationActivityGroup | null {
  const encoded = customString(custom, 'activityGroupJson');
  if (!encoded) return null;
  try {
    const value = JSON.parse(encoded) as ConversationActivityGroup;
    return value.entryType === 'activity-group' && Array.isArray(value.activities) ? value : null;
  } catch {
    return null;
  }
}

function formatTime(date: Date, locale: 'ja' | 'en'): string {
  return date.toLocaleTimeString(locale === 'ja' ? 'ja-JP' : 'en-US', {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function ActivityIcon({ kind }: { kind: ConversationActivity['kind'] }) {
  if (kind === 'command') return <Terminal aria-hidden="true" />;
  if (kind === 'tool') return <Wrench aria-hidden="true" />;
  if (kind === 'file_change') return <FilePenLine aria-hidden="true" />;
  if (kind === 'diff') return <FileDiff aria-hidden="true" />;
  return <ListChecks aria-hidden="true" />;
}

function activityStateLabel(activity: ConversationActivity, locale: 'ja' | 'en'): string {
  return conversationActivityStateCopy(activity.state, locale);
}

function groupState(group: ConversationActivityGroup): 'running' | 'failed' | 'unknown' | 'complete' {
  if (group.activities.some((activity) => activity.state === 'running')) return 'running';
  if (group.activities.some((activity) => activity.state === 'failed' || activity.state === 'declined')) return 'failed';
  if (group.activities.some((activity) => activity.state === 'unknown')) return 'unknown';
  return 'complete';
}

function activityGroupSummary(group: ConversationActivityGroup, locale: 'ja' | 'en'): string {
  const commandCount = group.activities.filter((activity) => activity.kind === 'command').length;
  const browserCount = group.activities.filter((activity) => activity.kind === 'tool' && activity.details.toolKind === 'webSearch').length;
  const toolCount = group.activities.filter((activity) => activity.kind === 'tool' && activity.details.toolKind !== 'webSearch').length;
  const fileCount = group.activities.reduce((count, activity) => (
    activity.kind === 'file_change' ? count + activity.details.changeCount : count
  ), 0);
  const hasDiff = group.activities.some((activity) => activity.kind === 'diff');
  const hasPlan = group.activities.some((activity) => activity.kind === 'plan');
  const parts: string[] = [];
  if (browserCount > 0) parts.push(locale === 'ja' ? 'ブラウザーを使用' : `Used browser${browserCount > 1 ? ` ${browserCount}×` : ''}`);
  if (fileCount > 0) parts.push(locale === 'ja' ? `${fileCount}件のファイルを編集` : `Edited ${fileCount} file${fileCount === 1 ? '' : 's'}`);
  if (commandCount > 0) parts.push(locale === 'ja' ? `${commandCount}件のコマンドを実行` : `Ran ${commandCount} command${commandCount === 1 ? '' : 's'}`);
  if (toolCount > 0) parts.push(locale === 'ja' ? `${toolCount}件のツールを使用` : `Used ${toolCount} tool${toolCount === 1 ? '' : 's'}`);
  if (hasDiff && fileCount === 0) parts.push(locale === 'ja' ? '差分を更新' : 'Updated diff');
  if (hasPlan) parts.push(locale === 'ja' ? '計画を更新' : 'Updated plan');
  if (parts.length === 0) parts.push(locale === 'ja' ? `${group.activities.length}件の作業` : `${group.activities.length} activit${group.activities.length === 1 ? 'y' : 'ies'}`);
  const state = groupState(group);
  const prefix = locale === 'ja'
    ? state === 'running' ? '作業中' : state === 'failed' ? '一部の作業に失敗' : state === 'unknown' ? '作業状態を確認できません' : '作業しました'
    : state === 'running' ? 'Working' : state === 'failed' ? 'Some work failed' : state === 'unknown' ? 'Work status unknown' : 'Worked';
  return `${prefix} · ${parts.join(' · ')}`;
}

function CopyOutputButton({ text, locale }: { text: string; locale: 'ja' | 'en' }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!navigator.clipboard?.writeText) return;
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };
  return (
    <button type="button" onClick={() => void copy()} aria-label={locale === 'ja' ? '出力をコピー' : 'Copy output'}>
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      {copied ? (locale === 'ja' ? 'コピー済み' : 'COPIED') : (locale === 'ja' ? 'コピー' : 'COPY')}
    </button>
  );
}

function ActivityRowMetadata({ activity, locale }: { activity: ConversationActivity; locale: 'ja' | 'en' }) {
  const showState = activity.state !== 'completed' && activity.state !== 'updated';
  if (activity.kind === 'command') {
    return (
      <span className="orquesta-activity-row-meta">
        {activity.details.exitCode !== null && activity.details.exitCode !== 0 && <span>exit {activity.details.exitCode}</span>}
        {showState && <em>{activityStateLabel(activity, locale)}</em>}
      </span>
    );
  }
  if (activity.kind === 'tool') {
    return (
      <span className="orquesta-activity-row-meta">
        {showState && <em>{activityStateLabel(activity, locale)}</em>}
      </span>
    );
  }
  if (activity.kind === 'file_change') {
    const addedLines = activity.details.changes.reduce((total, change) => total + change.addedLines, 0);
    const removedLines = activity.details.changes.reduce((total, change) => total + change.removedLines, 0);
    return (
      <span className="orquesta-activity-row-meta">
        {addedLines > 0 && <span className="is-added">+{addedLines}</span>}
        {removedLines > 0 && <span className="is-removed">−{removedLines}</span>}
        {showState && <em>{activityStateLabel(activity, locale)}</em>}
      </span>
    );
  }
  if (activity.kind === 'diff') {
    return (
      <span className="orquesta-activity-row-meta">
        {activity.details.addedLines > 0 && <span className="is-added">+{activity.details.addedLines}</span>}
        {activity.details.removedLines > 0 && <span className="is-removed">−{activity.details.removedLines}</span>}
        {showState && <em>{activityStateLabel(activity, locale)}</em>}
      </span>
    );
  }
  return showState
    ? <span className="orquesta-activity-row-meta"><em>{activityStateLabel(activity, locale)}</em></span>
    : null;
}

function compactActivityTitle(activity: ConversationActivity, locale: 'ja' | 'en'): string {
  if (activity.kind === 'command') return activity.details.commandName || activity.title;
  if (activity.kind === 'tool') return activity.details.toolName || activity.title;
  if (activity.kind === 'file_change') {
    return locale === 'ja'
      ? `${activity.details.changeCount}件のファイルを編集`
      : `Edited ${activity.details.changeCount} file${activity.details.changeCount === 1 ? '' : 's'}`;
  }
  if (activity.kind === 'diff') return locale === 'ja' ? '差分を更新' : 'Updated diff';
  return locale === 'ja' ? '計画を更新' : 'Updated plan';
}

function CompactActivityHeader({
  activity,
  locale,
  disclosure = false,
}: {
  activity: ConversationActivity;
  locale: 'ja' | 'en';
  disclosure?: boolean;
}) {
  const title = compactActivityTitle(activity, locale);
  return (
    <div className="orquesta-activity-row">
      <ActivityIcon kind={activity.kind} />
      <b title={activity.title}>{title}</b>
      <ActivityRowMetadata activity={activity} locale={locale} />
      {disclosure && <ChevronDown aria-hidden="true" />}
    </div>
  );
}

function ActivityDetails({ activity, locale }: { activity: ConversationActivity; locale: 'ja' | 'en' }) {
  if (activity.kind === 'command' || activity.kind === 'tool' || activity.kind === 'diff') return null;
  if (activity.kind === 'file_change') {
    return (
      <div className="orquesta-activity-files">
        {activity.details.changes.slice(0, 8).map((change, index) => (
          <div key={`${change.path}-${index}`}>
            <span title={change.path}>{change.path}</span>
            {change.addedLines > 0 && <b className="is-added">+{change.addedLines}</b>}
            {change.removedLines > 0 && <b className="is-removed">−{change.removedLines}</b>}
          </div>
        ))}
        {(activity.details.changesTruncated || activity.details.changeCount > 8) && (
          <p>{locale === 'ja' ? `ほか ${Math.max(0, activity.details.changeCount - 8)} 件` : `${Math.max(0, activity.details.changeCount - 8)} more`}</p>
        )}
      </div>
    );
  }
  return (
    <div className="orquesta-activity-plan">
      {activity.details.text && <p>{activity.details.text}</p>}
      {activity.details.explanation && <p>{activity.details.explanation}</p>}
      {activity.details.steps.slice(0, 12).map((step, index) => (
        <div key={`${index}-${step.text}`} data-status={step.status}>
          <i aria-hidden="true" />
          <span>{step.text}</span>
          <small>{planStepStatusCopy(step.status, locale)}</small>
        </div>
      ))}
    </div>
  );
}

function ActivityItem({ activity, locale }: { activity: ConversationActivity; locale: 'ja' | 'en' }) {
  const outputText = activity.kind === 'command' && activity.details.outputPresent
    ? activity.details.outputText
    : null;
  const outputLabel = locale === 'ja' ? '出力を表示' : 'Show output';
  if (activity.kind === 'command' && outputText) {
    return (
      <details className={`orquesta-activity-item kind-${activity.kind} state-${activity.state}`}>
        <summary role="button" aria-label={outputLabel}>
          <CompactActivityHeader activity={activity} locale={locale} disclosure />
        </summary>
        <div className="orquesta-activity-command-output">
          <div><CopyOutputButton text={outputText} locale={locale} /></div>
          <pre>{outputText}</pre>
        </div>
      </details>
    );
  }
  return (
    <article className={`orquesta-activity-item kind-${activity.kind} state-${activity.state}`}>
      <header><CompactActivityHeader activity={activity} locale={locale} /></header>
      <ActivityDetails activity={activity} locale={locale} />
    </article>
  );
}

function ActivityGroup({ group, locale }: { group: ConversationActivityGroup; locale: 'ja' | 'en' }) {
  const [expanded, setExpanded] = useState(false);
  const summary = activityGroupSummary(group, locale);
  const state = groupState(group);
  const hasFileChanges = group.activities.some((activity) => activity.kind === 'file_change');
  const visibleActivities = hasFileChanges
    ? group.activities.filter((activity) => activity.kind !== 'diff')
    : group.activities;
  return (
    <section className={`orquesta-activity-group state-${state}`} aria-label={summary}>
      <button
        type="button"
        className="orquesta-activity-group-trigger"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="orquesta-activity-group-state" aria-hidden="true" />
        <span>{summary}</span>
        <ChevronDown aria-hidden="true" />
      </button>
      {expanded && (
        <div
          className="orquesta-activity-group-details"
          role="region"
          aria-label={locale === 'ja' ? '作業の詳細' : 'Work details'}
          tabIndex={0}
        >
          {visibleActivities.map((activity) => (
            <ActivityItem key={activity.id} activity={activity} locale={locale} />
          ))}
        </div>
      )}
    </section>
  );
}

function OrquestaMessage({ locale, agentLabel, state, store }: Pick<ChatSurfaceV2Props, 'locale' | 'agentLabel' | 'state' | 'store'>) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const messageId = useAuiState((snapshot) => snapshot.message.id);
  const role = useAuiState((snapshot) => snapshot.message.role);
  const createdAt = useAuiState((snapshot) => snapshot.message.createdAt);
  const custom = useAuiState((snapshot) => snapshot.message.metadata.custom);
  const activityGroup = activityGroupFromCustom(custom);
  const messageStatus = useAuiState((snapshot) => snapshot.message.status?.type ?? 'complete');
  if (activityGroup) {
    return (
      <MessagePrimitive.Root className="orquesta-thread-activity" role="article" aria-label={activityGroupSummary(activityGroup, locale)}>
        <ActivityGroup group={activityGroup} locale={locale} />
      </MessagePrimitive.Root>
    );
  }
  const projectedMessage = state.messages.find((message) => message.id === messageId) ?? null;
  const evidenceLabel = customString(custom, 'evidenceLabel');
  const activeExecution = state.selectedAgentId ? state.executions[state.selectedAgentId] ?? null : null;
  const hasActiveTurn = Boolean(activeExecution?.threadId && activeExecution.turnId
    && ['accepted', 'working', 'stopping'].includes(activeExecution.phase));
  const copyMessage = async () => {
    if (!projectedMessage) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard_unavailable');
      await navigator.clipboard.writeText(projectedMessage.text);
      setCopyState('copied');
      window.setTimeout(() => setCopyState('idle'), 1_500);
    } catch {
      setCopyState('failed');
    }
  };
  const visualRole = role === 'assistant' ? 'agent' : role;
  const roleLabel = role === 'user' ? (locale === 'ja' ? '自分のメッセージ' : 'Your message')
    : role === 'system' ? (locale === 'ja' ? 'システムメッセージ' : 'System message')
      : (locale === 'ja' ? `${agentLabel}の応答` : `${agentLabel} response`);
  return (
    <MessagePrimitive.Root
      className={`orquesta-thread-message role-${visualRole}${messageStatus === 'running' ? ' is-streaming' : ''}`}
      role="article"
      aria-label={roleLabel}
    >
      <div className="orquesta-thread-bubble">
        <MessagePrimitive.Content />
        {messageStatus === 'running' && (
          <span className="orquesta-thread-stream-state" role="status">
            <i aria-hidden="true" />{locale === 'ja' ? '応答中' : 'Responding'}
          </span>
        )}
      </div>
      {projectedMessage && (
        <details className="orquesta-thread-actions">
          <summary role="button" aria-label={locale === 'ja' ? 'メッセージ操作を開く' : 'Open message actions'}>
            <MoreHorizontal aria-hidden="true" />
          </summary>
          <div role="menu" aria-label={locale === 'ja' ? 'メッセージ操作' : 'Message actions'}>
            <time dateTime={createdAt.toISOString()}>{formatTime(createdAt, locale)}</time>
            {evidenceLabel && <small>{evidenceLabel}</small>}
            <button type="button" role="menuitem" onClick={() => void copyMessage()}>
              {copyState === 'copied' ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
              {copyState === 'copied'
                ? (locale === 'ja' ? 'コピー済み' : 'Copied')
                : copyState === 'failed'
                  ? (locale === 'ja' ? 'コピー失敗' : 'Copy failed')
                  : (locale === 'ja' ? 'コピー' : 'Copy')}
            </button>
            {role === 'user' && (
              <button
                type="button"
                role="menuitem"
                onClick={() => void store.retryMessage(messageId)}
                disabled={state.sending || hasActiveTurn}
              >
                <RefreshCw aria-hidden="true" />{locale === 'ja' ? '再送' : 'Retry'}
              </button>
            )}
          </div>
        </details>
      )}
    </MessagePrimitive.Root>
  );
}

export function ChatSurfaceV2({ state, store, locale, agentLabel, afterMessages }: ChatSurfaceV2Props) {
  const [historyAnchorPending, setHistoryAnchorPending] = useState(false);
  const activeAgentId = state.selectedAgentId;
  const running = state.messages.some((message) => message.role === 'agent' && message.status === 'running');
  const entries = useMemo<ConversationEntry[]>(() => (
    groupConversationEntries(state.messages, state.activities)
  ), [state.activities, state.messages]);
  const onNew = useCallback(async (message: AppendMessage) => {
    if (message.role !== 'user') return;
    const text = textFromAppendMessage(message);
    if (!text) return;
    store.setDraft(text);
    const execution = activeAgentId ? state.executions[activeAgentId] ?? null : null;
    const activeTurn = Boolean(execution?.threadId && execution.turnId
      && ['accepted', 'working', 'stopping'].includes(execution.phase));
    const steerMode = Boolean(execution?.canInterrupt && execution.threadId && execution.turnId
      && ['accepted', 'working'].includes(execution.phase));
    if (activeTurn && !steerMode) return;
    await (steerMode ? store.steerActiveTurn() : store.sendMessage());
  }, [activeAgentId, state.executions, store]);
  const onCancel = useCallback(() => store.interruptActiveTurn(), [store]);
  const onRefetchThread = useCallback(() => store.loadConversation(activeAgentId), [activeAgentId, store]);
  const externalStore = useMemo(() => ({
    messages: entries,
    convertMessage: conversationEntryToThreadMessage,
    isLoading: state.conversationLoading,
    isRunning: running,
    isDisabled: !activeAgentId || !state.runtimeAuthority,
    isSendDisabled: state.sending,
    onNew,
    onCancel,
    onRefetchThread,
  }), [
    activeAgentId,
    entries,
    onCancel,
    onNew,
    onRefetchThread,
    running,
    state.conversationLoading,
    state.runtimeAuthority,
    state.sending,
  ]);
  const runtime = useExternalStoreRuntime<ConversationEntry>(externalStore);
  const viewportRef = useRef<HTMLDivElement>(null);
  const followLatestRef = useRef(true);
  const historyAnchorPendingRef = useRef(false);
  const followFrameRef = useRef<number | null>(null);
  const threadGenerationRef = useRef(0);
  const activeAgentRef = useRef(activeAgentId);
  activeAgentRef.current = activeAgentId;
  const lastAgentRef = useRef<string | null>(null);
  const lastMessageCountRef = useRef(0);
  const messageViewRef = useRef({ locale, agentLabel, state, store });
  messageViewRef.current = { locale, agentLabel, state, store };
  const Message = useCallback(() => <OrquestaMessage {...messageViewRef.current} />, []);
  const components = useMemo(() => ({ Message }), [Message]);
  const loadOlder = useCallback(async () => {
    const targetAgentId = activeAgentId;
    const generation = threadGenerationRef.current;
    const viewport = viewportRef.current;
    historyAnchorPendingRef.current = true;
    setHistoryAnchorPending(true);
    const prepended = await loadOlderWithScrollAnchor(
      viewport,
      () => threadGenerationRef.current === generation && activeAgentRef.current === targetAgentId,
      () => store.loadOlderConversation(targetAgentId),
    );
    if (prepended === null) return;
    historyAnchorPendingRef.current = false;
    followLatestRef.current = !prepended;
    setHistoryAnchorPending(false);
  }, [activeAgentId, store]);
  const trackViewport = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    followLatestRef.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 24;
  }, []);
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const agentChanged = lastAgentRef.current !== activeAgentId;
    if (agentChanged) {
      threadGenerationRef.current += 1;
      historyAnchorPendingRef.current = false;
      followLatestRef.current = true;
      lastMessageCountRef.current = 0;
      if (historyAnchorPending) setHistoryAnchorPending(false);
      if (followFrameRef.current !== null) {
        window.cancelAnimationFrame(followFrameRef.current);
        followFrameRef.current = null;
      }
    }
    const messageCountGrew = entries.length > lastMessageCountRef.current;
    if (viewport && (agentChanged || (messageCountGrew && !historyAnchorPending && followLatestRef.current))) {
      if (followFrameRef.current !== null) window.cancelAnimationFrame(followFrameRef.current);
      followFrameRef.current = window.requestAnimationFrame(() => {
        followFrameRef.current = null;
        if (historyAnchorPendingRef.current || !followLatestRef.current) return;
        viewport.scrollTop = viewport.scrollHeight;
        followLatestRef.current = true;
      });
    }
    lastAgentRef.current = activeAgentId;
    lastMessageCountRef.current = entries.length;
  }, [activeAgentId, entries.length, historyAnchorPending]);
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || typeof MutationObserver === 'undefined') return undefined;
    const observer = new MutationObserver(() => {
      if (historyAnchorPendingRef.current || !followLatestRef.current || followFrameRef.current !== null) return;
      followFrameRef.current = window.requestAnimationFrame(() => {
        followFrameRef.current = null;
        if (historyAnchorPendingRef.current || !followLatestRef.current) return;
        viewport.scrollTop = viewport.scrollHeight;
      });
    });
    observer.observe(viewport, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      if (followFrameRef.current !== null) window.cancelAnimationFrame(followFrameRef.current);
      followFrameRef.current = null;
    };
  }, []);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="orquesta-thread-root">
        <ThreadPrimitive.Viewport
          ref={viewportRef}
          className="orquesta-thread-viewport"
          autoScroll={false}
          turnAnchor="bottom"
          scrollToBottomOnInitialize={false}
          scrollToBottomOnRunStart={false}
          scrollToBottomOnThreadSwitch={false}
          onScroll={trackViewport}
          role="log"
          aria-live="off"
          aria-relevant="additions text"
          aria-atomic="false"
        >
          {(state.conversationOlderCursor
            || state.conversationOlderActivityCursor
            || state.conversationOlderPendingRequestCursor
            || state.conversationOlderLoading) && (
            <div className="orquesta-thread-history-control">
              <button type="button" onClick={() => void loadOlder()} disabled={state.conversationOlderLoading}>
                <History aria-hidden="true" />
                {state.conversationOlderLoading
                  ? (locale === 'ja' ? '過去の会話を読込中…' : 'LOADING EARLIER…')
                  : (locale === 'ja' ? '以前の会話を表示' : 'SHOW EARLIER MESSAGES')}
              </button>
            </div>
          )}
          {state.conversationLoading && entries.length === 0
            ? <p className="execution-empty" role="status">{locale === 'ja' ? '会話を読み込んでいます…' : 'LOADING CONVERSATION…'}</p>
            : entries.length === 0
              ? <p className="execution-empty">{locale === 'ja' ? 'この担当者の会話はまだありません。' : 'No conversation for this agent yet.'}</p>
              : <ThreadPrimitive.Messages components={components} />}
          {afterMessages}
          <ThreadPrimitive.ScrollToBottom className="orquesta-thread-scroll-bottom" aria-label={locale === 'ja' ? '最新の会話へ移動' : 'Scroll to latest message'}>
            <ArrowDown aria-hidden="true" />
          </ThreadPrimitive.ScrollToBottom>
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}
