import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import { ArrowDown, Check, Copy, FileDiff, FilePenLine, History, ListChecks, RefreshCw, Terminal, Wrench } from 'lucide-react';
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ApplicationStore } from '../../application/store';
import type { ApplicationState } from '../../application/state';
import { compareConversationEntryOrder } from '../../domain/exact-order';
import type { ConversationActivity, ConversationMessage } from '../../domain/models';
import {
  conversationActivityKindCopy,
  conversationActivityStateCopy,
  fileChangeKindCopy,
  planStepStatusCopy,
} from '../../presentation/user-copy';

interface OrquestaThreadProps {
  state: ApplicationState;
  store: ApplicationStore;
  locale: 'ja' | 'en';
  agentLabel: string;
  afterMessages?: ReactNode;
}

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

type ConversationEntry = ConversationMessage | ConversationActivity;

function isConversationActivity(entry: ConversationEntry): entry is ConversationActivity {
  return 'kind' in entry;
}

function conversationActivityToThreadMessage(activity: ConversationActivity): ThreadMessageLike {
  return {
    id: `activity-${activity.id}`,
    role: 'assistant',
    content: [{ type: 'text', text: activity.title }],
    createdAt: safeDate(activity.createdAt),
    status: { type: 'complete', reason: 'stop' },
    metadata: {
      custom: {
        activityJson: JSON.stringify(activity),
        authorLabel: 'ACTIVITY',
        targetAgentId: activity.targetAgentId,
      },
    },
  };
}

function conversationEntryToThreadMessage(entry: ConversationEntry): ThreadMessageLike {
  return isConversationActivity(entry)
    ? conversationActivityToThreadMessage(entry)
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

function activityFromCustom(custom: Record<string, unknown>): ConversationActivity | null {
  const serialized = custom.activityJson;
  if (typeof serialized !== 'string') return null;
  try {
    const value = JSON.parse(serialized) as { kind?: unknown };
    return value && ['command', 'tool', 'file_change', 'diff', 'plan'].includes(String(value.kind))
      ? value as ConversationActivity
      : null;
  } catch {
    return null;
  }
}

function formatTime(value: Date, locale: 'ja' | 'en'): string {
  return value.toLocaleTimeString(locale === 'ja' ? 'ja-JP' : 'en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatDuration(value: number | null, locale: 'ja' | 'en'): string | null {
  if (value === null) return null;
  if (value < 1_000) return `${value} ms`;
  return `${(value / 1_000).toLocaleString(locale === 'ja' ? 'ja-JP' : 'en-US', { maximumFractionDigits: 1 })} s`;
}

function activityStateLabel(activity: ConversationActivity, locale: 'ja' | 'en'): string {
  return conversationActivityStateCopy(activity.state, locale);
}

function ActivityIcon({ kind }: Pick<ConversationActivity, 'kind'>) {
  if (kind === 'command') return <Terminal aria-hidden="true" />;
  if (kind === 'file_change') return <FilePenLine aria-hidden="true" />;
  if (kind === 'diff') return <FileDiff aria-hidden="true" />;
  if (kind === 'plan') return <ListChecks aria-hidden="true" />;
  return <Wrench aria-hidden="true" />;
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return <span><small>{label}</small><b>{value}</b></span>;
}

function CommandOutput({ text, truncated, redacted, locale }: {
  text: string;
  truncated: boolean;
  redacted: boolean;
  locale: 'ja' | 'en';
}) {
  const isLong = text.length > 480 || text.split(/\r?\n/u).length > 8;
  const [expanded, setExpanded] = useState(!isLong);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  };
  return (
    <div className={`orquesta-activity-output${expanded ? ' is-expanded' : ' is-collapsed'}`}>
      <div>
        <b>{locale === 'ja' ? '安全な出力抜粋' : 'SAFE OUTPUT EXCERPT'}</b>
        <span>{[
          truncated ? (locale === 'ja' ? '末尾省略' : 'TRUNCATED') : null,
          redacted ? (locale === 'ja' ? '一部伏せ字' : 'REDACTED') : null,
        ].filter(Boolean).join(' / ')}</span>
        {isLong && <button type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          {expanded ? (locale === 'ja' ? '折り畳む' : 'COLLAPSE') : (locale === 'ja' ? '展開' : 'EXPAND')}
        </button>}
        <button type="button" onClick={() => void copy()} aria-label={locale === 'ja' ? '安全な出力抜粋をコピー' : 'Copy safe output excerpt'}>
          {copyState === 'copied' ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {copyState === 'copied' ? (locale === 'ja' ? 'コピー済み' : 'COPIED')
            : copyState === 'failed' ? (locale === 'ja' ? 'コピー失敗' : 'COPY FAILED')
              : (locale === 'ja' ? 'コピー' : 'COPY')}
        </button>
      </div>
      {expanded && <pre>{text}</pre>}
    </div>
  );
}

function ActivityDetails({ activity, locale }: { activity: ConversationActivity; locale: 'ja' | 'en' }) {
  if (activity.kind === 'command') {
    const duration = formatDuration(activity.details.durationMs, locale);
    return (
      <div>
        <div className="orquesta-activity-stats">
          <Stat label={locale === 'ja' ? 'コマンド' : 'COMMAND'} value={activity.details.commandName} />
          {activity.details.actionTypes.length > 0 && <Stat label={locale === 'ja' ? '種類' : 'ACTION'} value={activity.details.actionTypes.join(', ')} />}
          {duration && <Stat label={locale === 'ja' ? '時間' : 'DURATION'} value={duration} />}
          {activity.details.exitCode !== null && <Stat label="EXIT" value={activity.details.exitCode} />}
          {activity.details.outputPresent && <Stat label={locale === 'ja' ? '元の出力' : 'SOURCE OUTPUT'} value={`${activity.details.outputBytes.toLocaleString()} B`} />}
        </div>
        {activity.details.outputText !== null && <CommandOutput
          text={activity.details.outputText}
          truncated={activity.details.outputTruncated}
          redacted={activity.details.outputRedacted}
          locale={locale}
        />}
      </div>
    );
  }
  if (activity.kind === 'tool') {
    const duration = formatDuration(activity.details.durationMs, locale);
    return (
      <div className="orquesta-activity-stats">
        <Stat label={locale === 'ja' ? 'ツール' : 'TOOL'} value={activity.details.toolName} />
        {activity.details.toolNamespace && <Stat label={locale === 'ja' ? '接続先' : 'NAMESPACE'} value={activity.details.toolNamespace} />}
        {duration && <Stat label={locale === 'ja' ? '時間' : 'DURATION'} value={duration} />}
      </div>
    );
  }
  if (activity.kind === 'file_change') {
    const visible = activity.details.changes.slice(0, 8);
    return (
      <div className="orquesta-activity-files">
        {visible.map((change, index) => (
          <div key={`${change.path}-${index}`}>
            <span>{change.path}</span>
            <small>{fileChangeKindCopy(change.kind, locale)}</small>
            <b className="is-added">+{change.addedLines}</b>
            <b className="is-removed">−{change.removedLines}</b>
          </div>
        ))}
        {activity.details.changeCount > visible.length && (
          <p>{locale === 'ja' ? `ほか ${activity.details.changeCount - visible.length} ファイル` : `${activity.details.changeCount - visible.length} more files`}</p>
        )}
      </div>
    );
  }
  if (activity.kind === 'diff') {
    return (
      <div className="orquesta-activity-stats">
        <Stat label={locale === 'ja' ? '追加行' : 'ADDED'} value={`+${activity.details.addedLines}`} />
        <Stat label={locale === 'ja' ? '削除行' : 'REMOVED'} value={`−${activity.details.removedLines}`} />
        <Stat label={locale === 'ja' ? '差分サイズ' : 'DIFF SIZE'} value={`${activity.details.originalBytes.toLocaleString()} B`} />
      </div>
    );
  }
  const visible = activity.details.steps.slice(0, 12);
  return (
    <div className="orquesta-activity-plan">
      {activity.details.text && <p>{activity.details.text}</p>}
      {activity.details.explanation && <p>{activity.details.explanation}</p>}
      {visible.map((step, index) => (
        <div key={`${index}-${step.text}`} data-status={step.status}>
          <i aria-hidden="true" />
          <span>{step.text}</span>
          <small>{planStepStatusCopy(step.status, locale)}</small>
        </div>
      ))}
      {activity.details.stepCount > visible.length && (
        <p>{locale === 'ja' ? `ほか ${activity.details.stepCount - visible.length} ステップ` : `${activity.details.stepCount - visible.length} more steps`}</p>
      )}
    </div>
  );
}

function ActivityCard({ activity, locale, createdAt }: { activity: ConversationActivity; locale: 'ja' | 'en'; createdAt: Date }) {
  const stateLabel = activityStateLabel(activity, locale);
  return (
    <section className={`orquesta-activity-card kind-${activity.kind} state-${activity.state}`} aria-label={`${activity.title}, ${stateLabel}`}>
      <header>
        <span className="orquesta-activity-icon"><ActivityIcon kind={activity.kind} /></span>
        <div><small>{conversationActivityKindCopy(activity.kind, locale)}</small><b>{activity.title}</b></div>
        <span className="orquesta-activity-state"><i aria-hidden="true" />{stateLabel}</span>
        <time dateTime={createdAt.toISOString()}>{formatTime(createdAt, locale)}</time>
      </header>
      <ActivityDetails activity={activity} locale={locale} />
      <footer>{locale === 'ja' ? '生の引数・結果・無制限ログは保存していません' : 'Raw arguments, results, and unbounded logs are not stored'}</footer>
    </section>
  );
}

function OrquestaMessage({ locale, agentLabel, state, store }: Pick<OrquestaThreadProps, 'locale' | 'agentLabel' | 'state' | 'store'>) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const messageId = useAuiState((snapshot) => snapshot.message.id);
  const role = useAuiState((snapshot) => snapshot.message.role);
  const createdAt = useAuiState((snapshot) => snapshot.message.createdAt);
  const custom = useAuiState((snapshot) => snapshot.message.metadata.custom);
  const activity = activityFromCustom(custom);
  const messageStatus = useAuiState((snapshot) => snapshot.message.status?.type ?? 'complete');
  if (activity) {
    return (
      <MessagePrimitive.Root className="orquesta-thread-activity" role="article" aria-label={`${activity.title}, ${activityStateLabel(activity, locale)}`}>
        <ActivityCard activity={activity} locale={locale} createdAt={createdAt} />
      </MessagePrimitive.Root>
    );
  }
  const authorLabel = customString(custom, 'authorLabel')
    ?? (role === 'user' ? (locale === 'ja' ? 'あなた' : 'You') : role === 'system' ? 'SYSTEM' : 'AGENT');
  const evidenceLabel = customString(custom, 'evidenceLabel');
  const projectedMessage = state.messages.find((message) => message.id === messageId) ?? null;
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
  const roleLabel = role === 'user' ? (locale === 'ja' ? 'ユーザー' : 'operator')
    : role === 'system' ? 'system'
      : agentLabel;
  return (
    <MessagePrimitive.Root
      className={`orquesta-thread-message role-${visualRole}${messageStatus === 'running' ? ' is-streaming' : ''}`}
      role="article"
      aria-label={`${authorLabel}, ${roleLabel}`}
    >
      <span className="orquesta-thread-avatar" aria-hidden="true">{authorLabel.slice(0, 1).toUpperCase()}</span>
      <div className="orquesta-thread-bubble">
        <header>
          <b>{authorLabel}</b>
          <small>{roleLabel}</small>
          <time dateTime={createdAt.toISOString()}>{formatTime(createdAt, locale)}</time>
        </header>
        <MessagePrimitive.Content />
        {messageStatus === 'running' && (
          <span className="orquesta-thread-stream-state" role="status">
            <i aria-hidden="true" />{locale === 'ja' ? '回答中' : 'RESPONDING'}
          </span>
        )}
        {evidenceLabel && <em>{evidenceLabel}</em>}
        {projectedMessage && <div className="orquesta-thread-actions" aria-label={locale === 'ja' ? 'メッセージ操作' : 'Message actions'}>
          <button type="button" onClick={() => void copyMessage()} aria-label={locale === 'ja' ? 'メッセージをコピー' : 'Copy message'}>
            {copyState === 'copied' ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            {copyState === 'copied'
              ? (locale === 'ja' ? 'コピー済み' : 'COPIED')
              : copyState === 'failed'
                ? (locale === 'ja' ? 'コピー失敗' : 'COPY FAILED')
                : (locale === 'ja' ? 'コピー' : 'COPY')}
          </button>
          {role === 'user' && <button
            type="button"
            onClick={() => void store.retryMessage(messageId)}
            disabled={state.sending || hasActiveTurn}
            aria-label={locale === 'ja' ? '同じ内容を新しいターンとして再送' : 'Retry as a new turn'}
          >
            <RefreshCw aria-hidden="true" />{locale === 'ja' ? '再送' : 'RETRY'}
          </button>}
        </div>}
      </div>
    </MessagePrimitive.Root>
  );
}

export function OrquestaThread({ state, store, locale, agentLabel, afterMessages }: OrquestaThreadProps) {
  const [historyAnchorPending, setHistoryAnchorPending] = useState(false);
  const activeAgentId = state.selectedAgentId;
  const activity = activeAgentId ? state.executions[activeAgentId] ?? null : null;
  // Keep assistant-ui's run state tied to an actual non-empty projected delta.
  // Accepted turns are shown separately so the library never invents an empty assistant bubble.
  const running = state.messages.some((message) => message.role === 'agent' && message.status === 'running');
  const entries = useMemo<ConversationEntry[]>(() => (
    [...state.messages, ...state.activities].sort(compareConversationEntryOrder)
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
    unstable_capabilities: { copy: true },
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
