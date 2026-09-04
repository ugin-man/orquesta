import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  Archive,
  ArrowRight,
  ArrowUpRight,
  BriefcaseBusiness,
  ChevronRight,
  Circle,
  FolderKanban,
  FolderOpen,
  Gauge,
  History as HistoryIcon,
  Map as MapIcon,
  MessageCircle,
  Plus,
  RotateCcw,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Workflow,
  X,
} from 'lucide-react';
import type { ApplicationStore } from '../../application/store';
import type { ApplicationState, WorkspaceRoute } from '../../application/state';
import {
  projectLifecycleIsTransitioning,
  selectCurrentProjectDispatchRecovery,
  selectCurrentUserOrchestratorId,
  selectOpenAttention,
  selectProjectLifecycle,
  selectProjectSurface,
} from '../../application/selectors';
import type {
  AgentSummary,
  AttentionItem,
  BusinessWorkOrderSummary,
  ProjectFolderSelection,
  ProjectSummary,
  TaskSummary,
} from '../../domain/models';
import {
  agentModelLabel,
  OrquestaMap,
  taskForAgent,
  type OrquestaMapSessionState,
} from '../../components/OrquestaMap';
import { Composer } from '../conversation/Composer';
import { ChatSurfaceV2, loadOlderWithScrollAnchor } from '../thread/ChatSurfaceV2';
import { WorkflowLab } from './WorkflowLab';
import {
  agentStatusCopy,
  approvalDecisionCopy,
  attentionActionCopy,
  attentionPresentationCopy,
  attentionPriorityCopy,
  attentionTypeCopy,
  evidenceLevelCopy,
  evidenceTypeCopy,
  userMessageCopy,
  uiStateCopy,
  workflowBatchStatusCopy,
} from '../../presentation/user-copy';
import {
  collectUserSignals,
  expectedUserSignalStreams,
  UserSignalTracker,
} from '../../presentation/user-signals';

export type NotificationSettingsResult = 'saved' | 'permission_denied' | 'save_failed';

interface WorkspaceViewProps {
  state: ApplicationState;
  store: ApplicationStore;
  locale: 'ja' | 'en';
  onLocaleChange(locale: 'ja' | 'en'): void;
  onNotificationsChange(enabled: boolean): Promise<NotificationSettingsResult>;
  browserPreview?: boolean;
}

function ScreenReaderAnnouncer({ state, locale }: Pick<WorkspaceViewProps, 'state' | 'locale'>) {
  const [announcement, setAnnouncement] = useState({ key: 'baseline', text: '' });
  const trackerRef = useRef(new UserSignalTracker());
  const signals = collectUserSignals(state, locale);
  useEffect(() => {
    if (state.runtimeAuthority && !state.userSignalsBaselineReady) {
      trackerRef.current.reset();
      setAnnouncement((current) => current.text
        ? { key: 'baseline', text: '' }
        : current);
      return;
    }
    const fresh = trackerRef.current.observe(signals, expectedUserSignalStreams(state));
    if (fresh.length === 0) return;
    setAnnouncement({
      key: fresh.map((signal) => signal.key).join('|'),
      text: fresh.map((signal) => signal.announcement).join(' ').slice(0, 480),
    });
  }, [signals, state]);
  return <div key={announcement.key} className="sr-only" aria-live="polite" aria-atomic="true" aria-label={announcement.text} />;
}

const navigation: Array<{
  route: WorkspaceRoute;
  label: string;
  icon: typeof MapIcon;
}> = [
  { route: 'work', label: 'WORK', icon: BriefcaseBusiness },
  { route: 'map', label: 'MAP', icon: MapIcon },
  { route: 'decisions', label: 'DECISIONS', icon: ShieldCheck },
  { route: 'workflows', label: 'WORKFLOWS', icon: Workflow },
  { route: 'history', label: 'HISTORY', icon: HistoryIcon },
];

function compactTime(value: string | null, locale: 'ja' | 'en'): string {
  if (!value) return '—';
  return new Date(value).toLocaleTimeString(locale === 'ja' ? 'ja-JP' : 'en-US', {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function ProjectSidebar({
  state,
  locale,
  compact,
  onNavigate,
  onOpenProjects,
  onOpenSettings,
}: Pick<WorkspaceViewProps, 'state' | 'locale'> & {
  compact: boolean;
  onNavigate(route: WorkspaceRoute): void;
  onOpenProjects(): void;
  onOpenSettings(): void;
}) {
  const project = state.snapshot?.project
    ?? state.projects.find((candidate) => candidate.id === state.selectedProjectId)
    ?? null;
  const projectLifecycle = selectProjectLifecycle(state);
  const projectTransitionLocked = state.addingProject
    || projectLifecycleIsTransitioning(projectLifecycle)
    || state.voiceCapturePhase !== 'idle';
  const navigationReady = projectLifecycle === 'ready';
  const activeRoute = navigationReady ? state.route : 'work';
  return (
    <aside className="ledger-sidebar" aria-label={locale === 'ja' ? 'プロジェクトナビゲーション' : 'Project navigation'}>
      <header className="ledger-brand" data-tauri-drag-region>
        <span className="ledger-brand-symbol" data-tauri-drag-region aria-hidden="true"><img src="/brand/orquesta-symbol.png" alt="" data-tauri-drag-region /></span>
        <b data-tauri-drag-region>ORQUESTA</b>
        <small data-tauri-drag-region>V5 PREVIEW</small>
      </header>

      <section className="ledger-project-block" aria-labelledby="local-project-title">
        <h2 id="local-project-title">PROJECT</h2>
        <button type="button" className={`ledger-project-card${project ? ' is-current' : ' is-empty'}`} onClick={onOpenProjects} disabled={projectTransitionLocked} title={compact ? project?.title : undefined} aria-label={compact ? (project?.title ?? (locale === 'ja' ? 'プロジェクトを開く' : 'Open projects')) : undefined}>
          <span className="ledger-project-icon" aria-hidden="true"><FolderKanban /></span>
          <span><b>{project?.title ?? (locale === 'ja' ? 'プロジェクト未選択' : 'No project selected')}</b><small>{project?.rootPathLabel ?? (locale === 'ja' ? '必要なときに開く' : 'Open one when needed')}</small></span>
        </button>
      </section>

      {state.starterCreationRecoveries.length > 0 && <section className="ledger-starter-recoveries" role="alert" aria-label={locale === 'ja' ? '新規プロジェクトの復旧が必要' : 'Starter project recovery required'}>
        <details>
          <summary><span>{locale === 'ja' ? '作成途中のプロジェクト' : 'UNFINISHED PROJECTS'}</span><b>{state.starterCreationRecoveries.length}</b></summary>
          <p>{locale === 'ja' ? '保存先は変更せず保全しています。' : 'The selected roots remain preserved without changes.'}</p>
          <ul>{state.starterCreationRecoveries.map((recovery) => <li key={recovery.operationRef}><b>{recovery.displayName}</b><small>{locale === 'ja' ? '作成途中の内容を保全しています。' : 'The unfinished project is preserved.'}</small></li>)}</ul>
        </details>
      </section>}

      <nav className="ledger-navigation" aria-label={locale === 'ja' ? 'ワークスペース' : 'Workspace'}>
        {navigation.map(({ route, label, icon: Icon }) => (
          <button key={route} type="button" className={activeRoute === route ? 'is-active' : ''} aria-current={activeRoute === route ? 'page' : undefined} aria-label={compact ? label : undefined} disabled={!navigationReady && route !== 'work'} onClick={() => onNavigate(route)} title={compact ? label : undefined}>
            <Icon aria-hidden="true" /><span>{label}</span>
          </button>
        ))}
      </nav>

      <div className="sidebar-utilities">
        <button type="button" onClick={onOpenSettings} aria-label={compact ? (locale === 'ja' ? '設定' : 'Settings') : undefined} title={compact ? (locale === 'ja' ? '設定' : 'Settings') : undefined}><Settings aria-hidden="true" /><span>{locale === 'ja' ? '設定' : 'Settings'}</span></button>
      </div>

      <footer className="ledger-runtime-status" title={compact ? uiStateCopy(state.runtimeStatus?.lifecycle, locale) : undefined}>
        <span><Gauge aria-hidden="true" /><b>{locale === 'ja' ? '実行状態' : 'Runtime'}</b></span>
        <small><i aria-hidden="true" />{uiStateCopy(state.runtimeStatus?.lifecycle, locale)}</small>
      </footer>
    </aside>
  );
}

function WorkLedger({
  state,
  selectedAgentId,
  selectedWorkOrderKey,
  onSelectAgent,
  onSelectWorkOrder,
  onViewHistory,
  locale,
}: {
  state: ApplicationState;
  selectedAgentId: string | null;
  selectedWorkOrderKey: string | null;
  onSelectAgent(agentId: string): void;
  onSelectWorkOrder(workOrder: BusinessWorkOrderSummary): void;
  onViewHistory(): void;
  locale: 'ja' | 'en';
}) {
  const snapshot = state.snapshot!;
  const openAttention = selectOpenAttention(state);
  const workOrders = state.businessWorkOrders.slice(0, 3);
  const agents = snapshot.agents
    .filter((agent) => !['orquesta-admin', 'user-support'].includes(agent.id))
    .slice(0, 8);
  return (
    <aside className="work-ledger" aria-labelledby="work-ledger-title">
      <header className="execution-ledger-head" data-tauri-drag-region>
        <span data-tauri-drag-region>PROJECT ACTIVITY</span>
        <h2 id="work-ledger-title" data-tauri-drag-region>Work</h2>
      </header>

      <section className="ledger-group work-order-group">
        <header><h3>WORK ORDERS</h3><b>{workOrders.length}</b></header>
        {state.businessLoading && workOrders.length === 0 && <p className="ledger-empty">LOADING WORK…</p>}
        {!state.businessLoading && workOrders.length === 0 && snapshot.tasks.slice(0, 2).map((task) => (
          <div key={task.id} className="ledger-static-work"><i className={`ledger-status status-${task.state}`} /><span><b>{task.title}</b><small>{uiStateCopy(task.state, locale)}</small></span></div>
        ))}
        {workOrders.map((item) => (
          <button key={item.key} type="button" className={selectedWorkOrderKey === item.key ? 'is-selected' : ''} onClick={() => onSelectWorkOrder(item)}>
            <i className={`ledger-status status-${item.status}`} aria-hidden="true" />
            <span><b>{item.title}</b><small>{uiStateCopy(item.status, locale)}</small><em>{item.workOrderId}</em></span>
            <time dateTime={item.createdAt}>R{item.revision}</time>
          </button>
        ))}
      </section>

      <section className="ledger-group running-group">
        <header><h3>AGENTS</h3><b>{agents.length}</b></header>
        {agents.map((agent) => {
          const decision = openAttention.find((item) => item.sourceAgentId === agent.id);
          const decisionCopy = decision ? attentionPresentationCopy(decision, locale) : null;
          return <button key={agent.id} type="button" className={`${selectedAgentId === agent.id && !selectedWorkOrderKey ? 'is-selected' : ''}${decision ? ' has-decision' : ''}`} onClick={() => onSelectAgent(agent.id)}>
            <i className={`ledger-status status-${agent.status}`} aria-hidden="true" />
            <span><b>{agent.displayName}</b><small>{agentStatusCopy(agent.status, locale)}</small><em>{decisionCopy?.title ?? agent.currentTaskTitle ?? (locale === 'ja' ? '担当待ち' : 'Awaiting assignment')}</em></span>
            {decision ? <mark>{locale === 'ja' ? '判断待ち' : 'DECISION'}</mark> : null}
            <time dateTime={agent.lastEvidenceAt ?? undefined}>{compactTime(agent.lastEvidenceAt, locale)}</time>
          </button>;
        })}
      </section>

      <button type="button" className="ledger-history-link" onClick={onViewHistory}>
        {locale === 'ja' ? 'プロジェクト履歴を開く' : 'View project history'} <ArrowRight aria-hidden="true" />
      </button>
    </aside>
  );
}

const NAVIGATION_RAIL_WIDTH = 56;
const NAVIGATION_PANEL_DEFAULT_WIDTH = 184;
const NAVIGATION_PANEL_MIN_WIDTH = 176;
const NAVIGATION_PANEL_MAX_WIDTH = 320;
const NAVIGATION_PANEL_CLOSE_THRESHOLD = 128;
const WORK_LEDGER_DEFAULT_WIDTH = 260;
const WORK_LEDGER_MIN_WIDTH = 220;
const WORK_LEDGER_MAX_WIDTH = 420;
const WORK_LEDGER_CLOSE_THRESHOLD = 160;

function NavigationDivider({
  expanded,
  width,
  showWorkHandle,
  disabled,
  locale,
  onResize,
  onCommit,
  onDragStateChange,
  onOpenWork,
}: {
  expanded: boolean;
  width: number;
  showWorkHandle: boolean;
  disabled: boolean;
  locale: 'ja' | 'en';
  onResize(width: number): void;
  onCommit(width: number): void;
  onDragStateChange(active: boolean): void;
  onOpenWork(): void;
}) {
  const dragRef = useRef<{ pointerId: number; startX: number; startWidth: number; lastX: number } | null>(null);
  useEffect(() => () => {
    document.documentElement.classList.remove('is-resizing-navigation');
  }, []);
  const nextWidth = (clientX: number) => {
    const drag = dragRef.current;
    if (!drag) return expanded ? width : NAVIGATION_RAIL_WIDTH;
    return Math.max(0, Math.min(NAVIGATION_PANEL_MAX_WIDTH, drag.startWidth + clientX - drag.startX));
  };
  const finishDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) return;
    const committedWidth = nextWidth(event.clientX);
    dragRef.current = null;
    if (
      typeof event.currentTarget.hasPointerCapture === 'function'
      && event.currentTarget.hasPointerCapture(event.pointerId)
    ) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    document.documentElement.classList.remove('is-resizing-navigation');
    onCommit(committedWidth);
    onDragStateChange(false);
  };
  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    const startWidth = expanded ? width : NAVIGATION_RAIL_WIDTH;
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth, lastX: event.clientX };
    onResize(startWidth);
    onDragStateChange(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    document.documentElement.classList.add('is-resizing-navigation');
  };
  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) return;
    dragRef.current.lastX = event.clientX;
    onResize(nextWidth(event.clientX));
  };
  const loseCapture = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const committedWidth = nextWidth(drag.lastX);
    dragRef.current = null;
    document.documentElement.classList.remove('is-resizing-navigation');
    onCommit(committedWidth);
    onDragStateChange(false);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (disabled || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home'
      ? NAVIGATION_RAIL_WIDTH
      : event.key === 'End'
        ? NAVIGATION_PANEL_DEFAULT_WIDTH
        : expanded
          ? Math.max(0, Math.min(NAVIGATION_PANEL_MAX_WIDTH, width + (event.key === 'ArrowLeft' ? -16 : 16)))
          : NAVIGATION_PANEL_DEFAULT_WIDTH;
    onResize(next);
    onCommit(next);
  };
  const segment = (position: 'full' | 'upper' | 'lower', primary: boolean) => <div
    className={`navigation-resize-segment is-${position}`}
    role={primary ? 'separator' : undefined}
    aria-hidden={primary ? undefined : true}
    aria-label={primary ? (locale === 'ja' ? 'ナビゲーションの幅を変更' : 'Resize navigation panel') : undefined}
    aria-orientation={primary ? 'vertical' : undefined}
    aria-valuemin={primary ? NAVIGATION_RAIL_WIDTH : undefined}
    aria-valuemax={primary ? NAVIGATION_PANEL_MAX_WIDTH : undefined}
    aria-valuenow={primary ? Math.round(expanded ? width : NAVIGATION_RAIL_WIDTH) : undefined}
    aria-disabled={primary ? disabled : undefined}
    tabIndex={primary && !disabled ? 0 : undefined}
    onDoubleClick={primary ? () => onCommit(expanded ? NAVIGATION_RAIL_WIDTH : NAVIGATION_PANEL_DEFAULT_WIDTH) : undefined}
    onKeyDown={primary ? onKeyDown : undefined}
    onPointerDown={startDrag}
    onPointerMove={moveDrag}
    onPointerUp={finishDrag}
    onPointerCancel={finishDrag}
    onLostPointerCapture={loseCapture}
  />;
  return <div className={`navigation-edge-control${showWorkHandle ? ' has-work-handle' : ''}`}>
    {segment('full', true)}
    {showWorkHandle &&
      <button
        type="button"
        className="work-ledger-edge-handle"
        onClick={onOpenWork}
        disabled={disabled}
        aria-label={locale === 'ja' ? 'Workパネルを開く' : 'Open Work panel'}
        title={locale === 'ja' ? 'Workパネルを開く' : 'Open Work panel'}
      ><span className="work-ledger-edge-glyph" aria-hidden="true"><ChevronRight preserveAspectRatio="none" /></span></button>}
  </div>;
}

function WorkLedgerDivider({
  width,
  locale,
  onResize,
  onCommit,
}: {
  width: number;
  locale: 'ja' | 'en';
  onResize(width: number): void;
  onCommit(width: number): void;
}) {
  const dragRef = useRef<{ pointerId: number; startX: number; startWidth: number; lastX: number } | null>(null);
  useEffect(() => () => {
    document.documentElement.classList.remove('is-resizing-work-ledger');
  }, []);
  const nextWidth = (clientX: number) => {
    const drag = dragRef.current;
    if (!drag) return width;
    return Math.max(0, Math.min(WORK_LEDGER_MAX_WIDTH, drag.startWidth + clientX - drag.startX));
  };
  const finishDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) return;
    const committedWidth = nextWidth(event.clientX);
    dragRef.current = null;
    if (
      typeof event.currentTarget.hasPointerCapture === 'function'
      && event.currentTarget.hasPointerCapture(event.pointerId)
    ) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    document.documentElement.classList.remove('is-resizing-work-ledger');
    onCommit(committedWidth);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'Enter'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Enter'
      ? 0
      : event.key === 'Home'
      ? WORK_LEDGER_DEFAULT_WIDTH
      : Math.max(WORK_LEDGER_MIN_WIDTH, Math.min(WORK_LEDGER_MAX_WIDTH, width + (event.key === 'ArrowLeft' ? -16 : 16)));
    onResize(next);
    onCommit(next);
  };
  return <div
    className="work-ledger-divider"
    role="separator"
    aria-label={locale === 'ja' ? 'Workパネルの幅を変更。Enterで閉じる' : 'Resize Work panel. Press Enter to close'}
    aria-orientation="vertical"
    aria-valuemin={WORK_LEDGER_MIN_WIDTH}
    aria-valuemax={WORK_LEDGER_MAX_WIDTH}
    aria-valuenow={Math.round(width)}
    tabIndex={0}
    onDoubleClick={() => onCommit(WORK_LEDGER_DEFAULT_WIDTH)}
    onKeyDown={onKeyDown}
    onPointerDown={(event) => {
      if (event.button !== 0) return;
      dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width, lastX: event.clientX };
      event.currentTarget.setPointerCapture(event.pointerId);
      document.documentElement.classList.add('is-resizing-work-ledger');
    }}
    onPointerMove={(event) => {
      if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) return;
      dragRef.current.lastX = event.clientX;
      onResize(nextWidth(event.clientX));
    }}
    onPointerUp={finishDrag}
    onPointerCancel={finishDrag}
    onLostPointerCapture={(event) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const committedWidth = nextWidth(drag.lastX);
      dragRef.current = null;
      document.documentElement.classList.remove('is-resizing-work-ledger');
      onCommit(committedWidth);
    }}
  />;
}

function ApprovalPrompt({ item, state, store, locale }: { item: AttentionItem; state: ApplicationState; store: ApplicationStore; locale: 'ja' | 'en' }) {
  if (!item.runtimeApproval) return null;
  const copy = attentionPresentationCopy(item, locale);
  const restored = state.projectedPendingRequests.find((request) => request.requestKey === item.id) ?? null;
  const actionable = restored?.recoveryState === 'actionable';
  const simpleDecisions = item.runtimeApproval.responseOptions.filter((decision) =>
    ['accept', 'acceptForSession', 'decline', 'cancel'].includes(decision));
  const hasStructuredDecisions = simpleDecisions.length !== item.runtimeApproval.responseOptions.length;
  return (
    <article className="execution-approval" aria-labelledby="execution-approval-title">
      <ShieldCheck aria-hidden="true" />
      <div>
        <h3 id="execution-approval-title">{copy.title}</h3>
        <p>{copy.summary}</p>
        {!actionable && <small>{locale === 'ja' ? 'この要求が現在も有効か確認しています。' : 'Checking whether this request is still active.'}</small>}
        {hasStructuredDecisions && <small>{locale === 'ja' ? '追加条件が必要な選択肢は、現在この画面から回答できません。' : 'Choices requiring extra conditions are not available on this screen yet.'}</small>}
      </div>
      <div className="execution-approval-actions">
        {simpleDecisions.map((decision, index) => (
          <button key={decision} type="button" className={index === 0 ? 'is-primary' : ''} disabled={!actionable || state.actionPendingId === item.id} onClick={() => void store.respondToApproval(item.id, decision)}>
            {approvalDecisionCopy(decision, locale)}<ArrowRight aria-hidden="true" />
          </button>
        ))}
      </div>
    </article>
  );
}

function WorkSurface({
  state,
  store,
  locale,
  selectedAgent,
  selectedAttention,
}: Pick<WorkspaceViewProps, 'state' | 'store' | 'locale'> & {
  selectedAgent: AgentSummary;
  selectedAttention: AttentionItem | null;
}) {
  const staleRequests = state.projectedPendingRequests.filter((request) => request.recoveryState === 'stale'
    && (!request.agentId || request.agentId === selectedAgent.id));
  return (
    <>
      <section className="execution-conversation" aria-label={locale === 'ja' ? '作業会話' : 'Work conversation'}>
        <ChatSurfaceV2
          state={state}
          store={store}
          locale={locale}
          agentLabel={selectedAgent.displayName}
          afterMessages={<>
          {staleRequests.map((request) => (
            <div key={request.requestKey} className="thread-stale-notice" role="status">
              <ShieldCheck aria-hidden="true" />
              <span>
                <b>{request.requestKind === 'attention.user_input_requested'
                  ? (locale === 'ja' ? '期限切れの入力要求' : 'Expired input request')
                  : (locale === 'ja' ? '期限切れの承認要求' : 'Expired approval request')}</b>
                {' '}{request.requestKind === 'attention.user_input_requested'
                  ? request.prompt ?? (locale === 'ja' ? 'この入力要求は現在の作業では回答できません。' : 'This input request cannot be answered in the current run.')
                  : (locale === 'ja' ? 'この承認要求は現在の作業では回答できません。' : 'This approval request cannot be answered in the current run.')}
              </span>
            </div>
          ))}
          {selectedAttention && <ApprovalPrompt item={selectedAttention} state={state} store={store} locale={locale} />}
          </>}
        />
      </section>
    </>
  );
}

function MapView({
  state,
  store,
  locale,
  sessionState,
  onSessionStateChange,
}: Pick<WorkspaceViewProps, 'state' | 'store' | 'locale'> & {
  sessionState?: OrquestaMapSessionState;
  onSessionStateChange(state: OrquestaMapSessionState): void;
}) {
  const snapshot = state.snapshot!;
  const [inspectedAgentId, setInspectedAgentId] = useState<string | null>(null);
  const inspectedAgent = inspectedAgentId ? snapshot.agents.find((agent) => agent.id === inspectedAgentId) ?? null : null;
  const inspectedTask = inspectedAgent ? taskForAgent(snapshot, inspectedAgent.id) : null;
  const inspectedModel = inspectedAgent ? agentModelLabel(snapshot, inspectedAgent.id) : null;
  const inspectAgent = (agentId: string) => {
    setInspectedAgentId(agentId);
    store.selectAgent(agentId);
  };
  return (
    <section className="map-route route-enter" aria-labelledby="map-route-title">
      <div className={`map-route-stage${inspectedAgent ? ' has-map-inspector' : ''}`}>
        <h1 id="map-route-title" className="sr-only">ORQUESTA MAP</h1>
        <OrquestaMap
          key={snapshot.project.id}
          snapshot={snapshot}
          selectedAgentId={inspectedAgentId}
          onSelectAgent={inspectAgent}
          locale={locale}
          sessionState={sessionState}
          onSessionStateChange={onSessionStateChange}
        />
        {inspectedAgent && <aside className="map-selected-agent" aria-label={locale === 'ja' ? 'エージェント詳細' : 'Agent details'}>
          <button className="map-selected-close" type="button" onClick={() => setInspectedAgentId(null)} aria-label={locale === 'ja' ? '詳細を閉じる' : 'Close details'}><X aria-hidden="true" /></button>
          <span>SELECTED AGENT</span><h2>{inspectedAgent.displayName}</h2>
          <dl>
            <div><dt>{locale === 'ja' ? '状態' : 'Status'}</dt><dd>{agentStatusCopy(inspectedAgent.status, locale)}</dd></div>
            <div><dt>{locale === 'ja' ? 'モデル' : 'Model'}</dt><dd>{inspectedModel}</dd></div>
            <div><dt>{locale === 'ja' ? '現在の作業' : 'Current work'}</dt><dd>{inspectedTask?.title ?? inspectedAgent.currentTaskTitle ?? '—'}</dd></div>
            <div><dt>{locale === 'ja' ? '進捗' : 'Progress'}</dt><dd>{inspectedTask?.progressSummary ?? (inspectedAgent.progressPercent === null ? '—' : `${inspectedAgent.progressPercent}%`)}</dd></div>
            <div><dt>{locale === 'ja' ? '最終根拠' : 'Last evidence'}</dt><dd>{inspectedAgent.recentEvidence[0]?.title ?? '—'}</dd></div>
          </dl>
          <button className="map-open-work" type="button" onClick={() => { store.selectAgent(inspectedAgent.id); store.setRoute('work'); }}>{locale === 'ja' ? 'WORKで会話を開く' : 'OPEN IN WORK'}<ArrowRight aria-hidden="true" /></button>
        </aside>}
      </div>
    </section>
  );
}

function DecisionsView({ state, locale, onOpen }: Pick<WorkspaceViewProps, 'state' | 'locale'> & { onOpen(item: AttentionItem): void }) {
  const [tab, setTab] = useState<'open' | 'history'>('open');
  const snapshot = state.snapshot!;
  const items = tab === 'open' ? selectOpenAttention(state) : state.attentionHistory;
  return (
    <section className="attention-route route-enter" aria-labelledby="decisions-route-title">
      <header className="route-command-bar">
        <div><span>HUMAN DECISION BOUNDARY</span><h1 id="decisions-route-title">DECISIONS</h1></div>
        <p>{locale === 'ja' ? '通知ではなく、人間の判断が必要な仕事と、その決定記録を分けて扱います。' : 'This is not a notification feed. It separates pending human decisions from their durable record.'}</p>
      </header>
      <nav className="history-mode-tabs" aria-label={locale === 'ja' ? '判断の表示' : 'Decision view'}>
        <button type="button" className={tab === 'open' ? 'is-active' : ''} aria-current={tab === 'open' ? 'page' : undefined} onClick={() => setTab('open')}>OPEN</button>
        <button type="button" className={tab === 'history' ? 'is-active' : ''} aria-current={tab === 'history' ? 'page' : undefined} onClick={() => setTab('history')}>HISTORY</button>
      </nav>
      <div className="attention-queue">
        {items.length === 0 ? <p className="empty-state">{tab === 'open'
            ? (locale === 'ja' ? '判断待ちはありません。' : 'No decisions are waiting.')
            : (locale === 'ja' ? '完了した判断はありません。' : 'No completed decisions yet.')}</p> : items.map((item) => {
          const source = snapshot.agents.find((agent) => agent.id === item.sourceAgentId);
          const copy = attentionPresentationCopy(item, locale);
          return <article key={item.id} className={`attention-card priority-${item.priority}`}>
            <header><span>{tab === 'open' ? attentionPriorityCopy(item.priority, locale) : (locale === 'ja' ? '解決済み' : 'Resolved')} / {attentionTypeCopy(item.type, locale)}</span><time dateTime={item.resolvedAt ?? item.createdAt}>{compactTime(item.resolvedAt ?? item.createdAt, locale)}</time></header>
            <h2>{copy.title}</h2><p>{copy.summary}</p>
            <footer><span>{source?.displayName ?? 'Project'}{tab === 'open' && item.blocking ? ' / BLOCKING' : item.resolutionDecision ? ` / ${approvalDecisionCopy(item.resolutionDecision, locale)}` : ''}</span>{tab === 'open' && <button type="button" onClick={() => onOpen(item)}>{attentionActionCopy(item.actionKind, locale)}<ArrowRight aria-hidden="true" /></button>}</footer>
          </article>;
        })}
      </div>
    </section>
  );
}

function WorkflowsView({ state, store, locale }: Pick<WorkspaceViewProps, 'state' | 'store' | 'locale'>) {
  const [tab, setTab] = useState<'library' | 'designer' | 'runs'>('library');
  const definitions = state.workflowCatalog?.definitions ?? [];
  const batches = state.workflowCatalog?.batches ?? [];
  return (
    <section className="workflows-route route-enter" aria-labelledby="workflows-route-title">
      <header className="route-command-bar">
        <div><span>REUSABLE PRODUCTION ASSETS</span><h1 id="workflows-route-title">WORKFLOWS</h1></div>
        <p>{locale === 'ja' ? '一度作った仕事の流れを保存し、反復実行します。視覚的なDesignerは後続段階で追加します。' : 'Save and repeat proven work. The visual designer arrives in a later pass.'}</p>
      </header>
      <div className="workflows-stage">
        <nav className="workflow-mode-tabs" aria-label={locale === 'ja' ? 'ワークフロー表示' : 'Workflow view'}>
          {(['library', 'designer', 'runs'] as const).map((item) => <button key={item} type="button" className={tab === item ? 'is-active' : ''} aria-current={tab === item ? 'page' : undefined} onClick={() => setTab(item)}>{item.toUpperCase()}{item === 'library' ? ` ${definitions.length}` : item === 'runs' ? ` ${batches.length}` : ''}</button>)}
        </nav>
        {tab === 'library' && <section className="workflow-library" aria-labelledby="workflow-library-title">
          <header><div><span>AVAILABLE ASSETS</span><h2 id="workflow-library-title">{locale === 'ja' ? 'ワークフロー・ライブラリ' : 'WORKFLOW LIBRARY'}</h2></div><button type="button" onClick={() => setTab('designer')}>{locale === 'ja' ? '新規作成' : 'NEW WORKFLOW'}<ArrowRight aria-hidden="true" /></button></header>
          {definitions.length === 0 ? <div className="workflow-placeholder"><Workflow aria-hidden="true" /><h3>{locale === 'ja' ? '保存されたワークフローはありません。' : 'No saved workflows yet.'}</h3><p>{locale === 'ja' ? 'Designerで最初の再利用可能な仕事を作成できます。' : 'Create the first reusable work asset in Designer.'}</p><button type="button" onClick={() => setTab('designer')}>{locale === 'ja' ? 'Designerを開く' : 'OPEN DESIGNER'}</button></div> : <div className="workflow-library-grid">{definitions.map((definition) => <article key={definition.workflowId}><span>{definition.checks.length === 0 ? 'UNASSESSED' : `${definition.checks.length} CHECK`}</span><h3>{definition.name}</h3><p>{definition.prompt}</p><footer><time dateTime={definition.updatedAt}>{new Date(definition.updatedAt).toLocaleDateString(locale === 'ja' ? 'ja-JP' : 'en-US')}</time><button type="button" onClick={() => setTab('designer')}>{locale === 'ja' ? '開く' : 'OPEN'}<ArrowRight aria-hidden="true" /></button></footer></article>)}</div>}
        </section>}
        {tab === 'designer' && <WorkflowLab state={state} store={store} locale={locale} />}
        {tab === 'runs' && <section className="workflow-runs" aria-labelledby="workflow-runs-title">
          <header><span>RECENT EXECUTION</span><h2 id="workflow-runs-title">{locale === 'ja' ? '反復実行' : 'WORKFLOW RUNS'}</h2></header>
          {batches.length === 0 ? <div className="workflow-placeholder"><Gauge aria-hidden="true" /><h3>{locale === 'ja' ? '実行履歴はありません。' : 'No workflow runs yet.'}</h3><p>{locale === 'ja' ? 'Designerからワークフローを実行すると、ここに結果が表示されます。' : 'Runs started from Designer will appear here.'}</p></div> : <div className="workflow-run-list">{batches.map((batch) => <article key={batch.batchId}><header><span>{workflowBatchStatusCopy(batch.status, locale)}</span><b>{definitions.find((item) => item.workflowId === batch.workflowId)?.name ?? batch.workflowId}</b></header><dl><div><dt>COMPLETION</dt><dd>{batch.metrics.executionReliabilityPercent === null ? '—' : `${batch.metrics.executionReliabilityPercent}%`}</dd></div><div><dt>CHECK PASS</dt><dd>{batch.metrics.successRatePercent === null ? 'UNASSESSED' : `${batch.metrics.successRatePercent}%`}</dd></div><div><dt>SAMPLE</dt><dd>{batch.metrics.terminalRuns}/{batch.metrics.requestedRuns}</dd></div></dl></article>)}</div>}
        </section>}
      </div>
    </section>
  );
}

function HistoryView({ state, store, locale }: Pick<WorkspaceViewProps, 'state' | 'store' | 'locale'>) {
  const [tab, setTab] = useState<'activity' | 'conversations' | 'evidence'>('activity');
  const [searchDraft, setSearchDraft] = useState(state.historyQuery);
  const snapshot = state.snapshot!;
  const agentHistory = snapshot.agents.flatMap((agent) => agent.history.map((entry) => ({ ...entry, agent })));
  const evidence = snapshot.agents.flatMap((agent) => agent.recentEvidence.map((entry) => ({ ...entry, agent })));
  const historyAgent = state.historySelectedAgentId
    ? snapshot.agents.find((agent) => agent.id === state.historySelectedAgentId) ?? null
    : null;
  const historyViewportRef = useRef<HTMLDivElement>(null);
  const historyIdentityRef = useRef('');
  historyIdentityRef.current = `${state.historySelectedAgentId ?? ''}\u0000${state.historyQuery}`;
  useEffect(() => setSearchDraft(state.historyQuery), [state.historyQuery, state.historySelectedAgentId]);
  const loadOlderHistory = async () => {
    const identity = historyIdentityRef.current;
    await loadOlderWithScrollAnchor(
      historyViewportRef.current,
      () => historyIdentityRef.current === identity,
      () => store.loadOlderHistory(),
    );
  };
  return (
    <section className="evidence-route history-route route-enter" aria-labelledby="history-route-title">
      <header className="route-command-bar">
        <div><span>PROJECT MEMORY / PROVENANCE</span><h1 id="history-route-title">HISTORY</h1></div>
        <p>{locale === 'ja' ? '会話だけではなく、作業の変化、プロジェクトイベント、証拠を別々に確認します。' : 'Review work changes, project events, conversations, and evidence as separate records.'}</p>
      </header>
      <nav className="history-mode-tabs" aria-label={locale === 'ja' ? '履歴の種類' : 'History type'}>
        {(['activity', 'conversations', 'evidence'] as const).map((item) => <button key={item} type="button" className={tab === item ? 'is-active' : ''} aria-current={tab === item ? 'page' : undefined} onClick={() => setTab(item)}>{item.toUpperCase()}</button>)}
      </nav>
      {tab === 'activity' && <div className="history-activity-grid">
        <section aria-labelledby="project-events-title"><header><span>PROJECT</span><h2 id="project-events-title">ACTIVITY</h2></header>{snapshot.recentEvents.length === 0 ? <p className="empty-state">{locale === 'ja' ? 'プロジェクトイベントはありません。' : 'No project events.'}</p> : snapshot.recentEvents.map((event) => <article key={event.id} className={`history-event tone-${event.tone}`}><i aria-hidden="true" /><div><header><b>{event.title}</b><time dateTime={event.createdAt}>{compactTime(event.createdAt, locale)}</time></header><p>{event.message}</p></div></article>)}</section>
        <section aria-labelledby="agent-history-title"><header><span>AGENTS</span><h2 id="agent-history-title">WORK CHANGES</h2></header>{agentHistory.length === 0 ? <p className="empty-state">{locale === 'ja' ? '作業履歴はありません。' : 'No work changes.'}</p> : agentHistory.map((entry) => <article key={`${entry.agent.id}:${entry.id}`} className="history-agent-entry"><div><b>{entry.title}</b><small>{entry.agent.displayName} / {uiStateCopy(entry.state, locale)}</small></div><time dateTime={entry.changedAt}>{compactTime(entry.changedAt, locale)}</time></article>)}</section>
      </div>}
      {tab === 'conversations' && <div className="evidence-body history-conversations">
        <nav className="evidence-agents" aria-label={locale === 'ja' ? '会話対象' : 'Conversation target'}><h2>CONVERSATIONS</h2>{state.historyConversations.map((summary) => {
          const agent = snapshot.agents.find((candidate) => candidate.id === summary.targetAgentId) ?? null;
          return <button key={summary.targetAgentId} type="button" className={summary.targetAgentId === state.historySelectedAgentId ? 'is-active' : ''} onClick={() => store.selectHistoryAgent(summary.targetAgentId)}><span>{agent?.displayName ?? summary.targetAgentId}</span><small>{agent ? agentStatusCopy(agent.status, locale) : (locale === 'ja' ? '過去の担当者' : 'Former agent')}</small></button>;
        })}{state.historyIndexCursor && <button type="button" disabled={state.historyLoading} onClick={() => void store.loadOlderHistoryIndex()}>{locale === 'ja' ? '過去の担当者をさらに表示' : 'Older conversations'}</button>}</nav>
        <div className="history-conversation-column"><form onSubmit={(event) => { event.preventDefault(); store.setHistoryQuery(searchDraft); }}><label className="evidence-search"><Search aria-hidden="true" /><span className="sr-only">{locale === 'ja' ? '会話を検索' : 'Search conversation'}</span><input type="search" value={searchDraft} onChange={(event) => setSearchDraft(event.target.value)} placeholder={locale === 'ja' ? 'この会話を検索' : 'Search this conversation'} /></label><button type="submit" disabled={!state.historySelectedAgentId || state.historyLoading}>{locale === 'ja' ? '検索' : 'Search'}</button></form>{historyAgent && <button type="button" onClick={() => store.openHistoryAgentInWork()}>{locale === 'ja' ? 'WORKで開く' : 'Open in WORK'}</button>}<div ref={historyViewportRef} className="evidence-messages">{state.historyLoading ? <p className="empty-state">LOADING CONVERSATION…</p> : state.historyMessages.length === 0 ? <p className="empty-state">{state.historyCursor ? (locale === 'ja' ? 'この範囲には一致がありません。さらに古い会話を検索できます。' : 'No match in this range. Search the older range to continue.') : (locale === 'ja' ? '一致する会話はありません。' : 'No matching conversation.')}</p> : state.historyMessages.map((message) => <article key={message.id} className={`evidence-message role-${message.role}`}><header><b>{message.authorLabel}</b><time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleString(locale === 'ja' ? 'ja-JP' : 'en-US')}</time></header><p>{message.text}</p>{message.evidenceLabel && <small>{message.evidenceLabel}</small>}</article>)}</div>{state.historyCursor && <button type="button" disabled={state.historyOlderLoading} onClick={() => void loadOlderHistory()}>{state.historyOlderLoading ? (locale === 'ja' ? '読み込み中…' : 'Loading…') : (locale === 'ja' ? 'さらに古い会話' : 'Older')}</button>}</div>
      </div>}
      {tab === 'evidence' && <div className="history-evidence-grid"><section><header><span>AGENT RECORDS</span><h2>EVIDENCE</h2></header>{evidence.length === 0 ? <p className="empty-state">{locale === 'ja' ? 'エージェント証拠はありません。' : 'No agent evidence.'}</p> : evidence.map((entry) => <article key={`${entry.agent.id}:${entry.id}`} className="history-evidence-entry"><header><span>{evidenceLevelCopy(entry.level, locale)}</span><time dateTime={entry.observedAt ?? undefined}>{compactTime(entry.observedAt, locale)}</time></header><h3>{entry.title}</h3><p>{entry.detail}</p><small>{entry.agent.displayName} / {evidenceTypeCopy(entry.type, locale)}</small></article>)}</section><aside className="inspection-records"><h2>INSPECTIONS</h2>{snapshot.inspectionRuns.length === 0 ? <p>{locale === 'ja' ? '監査記録はありません。' : 'No inspection records.'}</p> : snapshot.inspectionRuns.map((run) => <article key={run.runId}><span>{uiStateCopy(run.status, locale)}</span><h3>{run.displayName}</h3><p>{run.focus ?? (locale === 'ja' ? 'プロジェクト全体' : 'Whole project')}</p><small>{run.sourceCount} SOURCES</small></article>)}</aside></div>}
    </section>
  );
}

function LucaAccess({ state, store, locale }: Pick<WorkspaceViewProps, 'state' | 'store' | 'locale'>) {
  const luca = state.snapshot?.agents.find((agent) => agent.id === 'orquesta-admin') ?? null;
  const open = Boolean(luca && state.supportAgentId === luca.id);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    if (typeof dialogRef.current?.showModal === 'function') dialogRef.current.showModal();
    else dialogRef.current?.setAttribute('open', '');
    return () => triggerRef.current?.focus();
  }, [open]);
  if (!luca) return null;
  return <>
    <button ref={triggerRef} type="button" className={`luca-tether${open ? ' is-open' : ''}`} aria-expanded={open} aria-controls="luca-dialog" onClick={() => open ? store.closeSupport() : store.openSupport(luca.id)}>
      <MessageCircle aria-hidden="true" /><span>Luca</span><i className={`status-${luca.status}`} aria-hidden="true" />
    </button>
    {open && <dialog ref={dialogRef} id="luca-dialog" className="luca-overlay" aria-labelledby="luca-dialog-title" onCancel={(event) => { event.preventDefault(); store.closeSupport(); }} onMouseDown={(event) => { if (event.target === event.currentTarget) store.closeSupport(); }}>
        <header><div><span>ORQUESTA GUIDE</span><h2 id="luca-dialog-title">Luca</h2><p>{agentStatusCopy(luca.status, locale)} / {luca.currentTaskTitle ?? (locale === 'ja' ? '待機中' : 'Standing by')}</p></div><button type="button" onClick={() => store.closeSupport()} aria-label={locale === 'ja' ? 'Lucaを閉じる' : 'Close Luca'}><X aria-hidden="true" /></button></header>
        <div className="luca-messages">
          {state.supportConversationLoading ? <p className="empty-state">LOADING LUCA…</p> : state.supportMessages.length === 0 ? <p className="empty-state">{locale === 'ja' ? 'まだ会話はありません。' : 'No conversation yet.'}</p> : state.supportMessages.map((message) => <article key={message.id} className={`luca-message role-${message.role}`}><header><b>{message.authorLabel}</b><time dateTime={message.createdAt}>{compactTime(message.createdAt, locale)}</time></header><p>{message.text}</p>{message.evidenceLabel && <small>{message.evidenceLabel}</small>}</article>)}
        </div>
        <form className="luca-composer" onSubmit={(event) => { event.preventDefault(); void store.sendSupportMessage(); }}>
          <label htmlFor="luca-message-input">{locale === 'ja' ? '今いる画面のままLucaに相談' : 'Ask Luca without leaving this screen'}</label>
          <div><textarea id="luca-message-input" rows={3} value={state.supportDraft} onChange={(event) => store.setSupportDraft(event.target.value)} placeholder={locale === 'ja' ? '指示や相談を入力…' : 'Give an instruction or ask a question…'} /><button type="submit" disabled={!state.supportDraft.trim() || state.supportSending}>{state.supportSending ? (locale === 'ja' ? '送信中' : 'SENDING') : (locale === 'ja' ? '送信' : 'SEND')}<Send aria-hidden="true" /></button></div>
        </form>
    </dialog>}
  </>;
}

function WorkspaceInactiveState({
  state,
  store,
  locale,
}: Pick<WorkspaceViewProps, 'state' | 'store' | 'locale'>) {
  const project = state.snapshot?.project
    ?? state.projects.find((candidate) => candidate.id === state.selectedProjectId)
    ?? null;
  const projectLifecycle = selectProjectLifecycle(state);
  const starting = projectLifecycle === 'activating'
    || projectLifecycle === 'hydrating_snapshot'
    || projectLifecycle === 'bootstrapping_foundation';
  const stopping = projectLifecycle === 'stopping';
  const registeredInactive = projectLifecycle === 'registered_inactive';
  const preparationFailed = projectLifecycle === 'preparation_failed';
  const bootstrap = state.projectBootstrap;
  const migrationRequired = projectLifecycle === 'migration_required' && bootstrap?.classification === 'legacy_v2';
  const blocked = projectLifecycle === 'recovery_required'
    || (projectLifecycle === 'migration_required' && !migrationRequired);
  return (
    <section className="workspace-inactive" aria-label={locale === 'ja' ? '空のWORK' : 'Empty WORK'}>
      <div className="workspace-inactive-copy">
        <span>{stopping
          ? (locale === 'ja' ? 'プロジェクト / 停止中' : 'PROJECT / STOPPING')
          : starting
            ? (locale === 'ja' ? 'プロジェクト / 準備中' : 'PROJECT / STARTING')
            : preparationFailed
              ? (locale === 'ja' ? 'プロジェクト / 準備失敗' : 'PROJECT / START FAILED')
              : registeredInactive
                ? (locale === 'ja' ? 'プロジェクト / 停止' : 'PROJECT / STOPPED')
                : migrationRequired
                  ? (locale === 'ja' ? 'プロジェクト / データ移行が必要' : 'PROJECT / MIGRATION REQUIRED')
                  : blocked
                    ? (locale === 'ja' ? 'プロジェクト / 復旧が必要' : 'PROJECT / RECOVERY REQUIRED')
                    : (locale === 'ja' ? 'WORK / 準備完了' : 'WORK / READY')}</span>
        <div className="workspace-empty-agent" aria-label={locale === 'ja' ? '統括者の開始位置' : 'Orchestrator starting point'}>
          <span><Circle aria-hidden="true" /></span>
          <div>
            <b>{locale === 'ja' ? '統括者' : 'Orchestrator'}</b>
            <small>{stopping
              ? (locale === 'ja' ? '実行中の処理を安全に終了しています' : 'Stopping active work safely')
              : starting
              ? (locale === 'ja' ? 'プロジェクトと基盤エージェントを準備しています' : 'Preparing the project and foundation agents')
              : preparationFailed
                ? (locale === 'ja' ? '準備に失敗しました。再試行できます' : 'Preparation failed. You can retry')
              : registeredInactive
                ? (locale === 'ja' ? '最近のプロジェクトから再開できます' : 'Resume it from recent projects')
              : (locale === 'ja' ? 'ここから新しい会話を始められます' : 'Start a new conversation from here')}</small>
          </div>
        </div>
        <h1>{stopping
          ? (locale === 'ja' ? 'プロジェクトを停止しています' : 'Stopping the project')
          : starting
          ? (locale === 'ja' ? 'プロジェクトを準備しています' : 'Preparing your project')
          : preparationFailed
            ? (locale === 'ja' ? `「${project?.title ?? 'このプロジェクト'}」を開始できませんでした` : `Could not start “${project?.title ?? 'this project'}”`)
          : registeredInactive
            ? (locale === 'ja' ? `「${project?.title ?? 'このプロジェクト'}」を再開できます` : `Resume “${project?.title ?? 'this project'}”`)
          : migrationRequired
            ? (locale === 'ja' ? `「${project?.title ?? 'このプロジェクト'}」には旧形式のデータがあります` : `“${project?.title ?? 'This project'}” has legacy Orquesta data`)
            : blocked
              ? (locale === 'ja' ? `「${project?.title ?? 'このプロジェクト'}」は安全に開けません` : `“${project?.title ?? 'This project'}” cannot be opened safely`)
              : (locale === 'ja' ? '今日は何を進めますか？' : 'What do you want to work on?')}</h1>
        <p>{stopping
          ? (locale === 'ja' ? '終了処理が完了するまで、この画面を閉じずにお待ちください。' : 'Keep this window open until shutdown completes.')
          : starting
          ? (locale === 'ja' ? '統括者と基本担当を作成しています。入力した内容は消えません。' : 'Creating the orchestrator and foundation agents. Your draft is preserved.')
          : preparationFailed
            ? (locale === 'ja' ? '入力内容は保持されています。下のボタンから同じプロジェクトをもう一度準備できます。' : 'Your draft is preserved. Retry preparation for the same project below.')
          : registeredInactive
            ? (locale === 'ja' ? '下の入力欄に続きを書き、最近のプロジェクトから再開してください。' : 'Write the next instruction below, then resume from recent projects.')
          : migrationRequired
            ? (locale === 'ja' ? '旧データは変更していません。別のプロジェクトを始めることもできます。' : 'Legacy data remains unchanged. You can also start another project.')
            : blocked
              ? (locale === 'ja' ? '読み取り専用で停止しています。別のプロジェクトを選ぶか、新しく始められます。' : 'This project is paused read-only. Choose another project or start a new one.')
              : (locale === 'ja' ? '下の入力欄にやりたいことを書き、プロジェクトかフォルダを選んでください。' : 'Write what you want below, then choose a project or folder.')}</p>
        {(starting || stopping) && <div className="project-start-progress" role="status"><i /><span>{stopping
          ? (locale === 'ja' ? '実行中の処理を停止中…' : 'Stopping active work…')
          : (locale === 'ja' ? '統括者と基盤エージェントを準備中…' : 'Preparing the orchestrator and foundation agents…')}</span></div>}
        {preparationFailed && project && <button type="button" className="project-start-retry" onClick={() => void store.selectProject(project.id)}>{locale === 'ja' ? 'もう一度試す' : 'TRY AGAIN'}<ArrowRight aria-hidden="true" /></button>}
        {migrationRequired && <div className="workspace-state-note" role="status"><ShieldCheck aria-hidden="true" /><span>{locale === 'ja' ? 'データ保全済み / 移行待ち' : 'DATA PRESERVED / MIGRATION PENDING'}</span></div>}
      </div>
    </section>
  );
}

function ProjectDialog({ projects, currentId, adding, onAdd, onFolderSelected, onNew, onSelect, onArchive, onClose, locale }: { projects: ProjectSummary[]; currentId: string | null; adding: boolean; onAdd(): Promise<ProjectFolderSelection | null>; onFolderSelected(selection: ProjectFolderSelection): void; onNew(): void; onSelect(id: string): Promise<boolean>; onArchive(id: string): Promise<boolean>; onClose(): void; locale: 'ja' | 'en' }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [archiveCandidate, setArchiveCandidate] = useState<ProjectSummary | null>(null);
  const [archivingProjectId, setArchivingProjectId] = useState<string | null>(null);
  useEffect(() => {
    if (typeof ref.current?.showModal === 'function') ref.current.showModal();
    else ref.current?.setAttribute('open', '');
  }, []);
  const close = () => {
    if (typeof ref.current?.close === 'function') ref.current.close();
    else onClose();
  };
  const startFromFolder = async () => {
    const selection = await onAdd();
    if (selection) onFolderSelected(selection);
  };
  const selectRecent = async (projectId: string) => {
    if (await onSelect(projectId)) close();
  };
  const archiveProject = async (projectId: string) => {
    setArchivingProjectId(projectId);
    try {
      if (await onArchive(projectId)) setArchiveCandidate(null);
    } finally {
      setArchivingProjectId(null);
    }
  };
  return (
    <dialog ref={ref} className="project-dialog" onClose={onClose} onCancel={(event) => {
      if (!archiveCandidate) return onClose();
      event.preventDefault();
      if (!archivingProjectId) setArchiveCandidate(null);
    }}>
      <header><span>{archiveCandidate ? 'ARCHIVE PROJECT' : 'PROJECT SWITCHER'}</span><button type="button" onClick={close} aria-label={locale === 'ja' ? '閉じる' : 'Close'}><X aria-hidden="true" /></button></header>
      {archiveCandidate ? <>
        <section className="project-archive-confirmation" aria-labelledby="project-archive-title">
          <Archive aria-hidden="true" />
          <div>
            <h2 id="project-archive-title">{locale === 'ja' ? 'このプロジェクトをアーカイブしますか？' : 'Archive this project?'}</h2>
            <p>{locale === 'ja' ? '一覧からは隠れますが、ファイルや履歴は削除されません。設定の「アーカイブ」からいつでも復元できます。' : 'It will leave the project list, but its files and history will not be deleted. You can restore it from Archive in Settings.'}</p>
            <strong>{archiveCandidate.title}</strong>
            <small>{archiveCandidate.rootPathLabel}</small>
          </div>
        </section>
        <footer className="project-archive-actions"><button type="button" className="is-secondary" disabled={archivingProjectId !== null} onClick={() => setArchiveCandidate(null)}>{locale === 'ja' ? 'キャンセル' : 'CANCEL'}</button><button type="button" disabled={archivingProjectId !== null} onClick={() => void archiveProject(archiveCandidate.id)}><Archive aria-hidden="true" />{archivingProjectId ? (locale === 'ja' ? 'アーカイブ中…' : 'ARCHIVING…') : (locale === 'ja' ? 'アーカイブする' : 'ARCHIVE PROJECT')}</button></footer>
      </> : <>
        <h2>{locale === 'ja' ? 'プロジェクトを開く' : 'Open a project'}</h2>
        <div className="project-dialog-list">{projects.length === 0
          ? <p className="project-dialog-empty">{locale === 'ja' ? '登録されているプロジェクトはありません。必要になったときにフォルダを追加できます。' : 'No projects are registered. Add a folder whenever you need one.'}</p>
          : projects.map((project) => <div className="project-dialog-item" key={project.id}>
            <button className="project-dialog-open" type="button" disabled={project.id === currentId || adding || archivingProjectId !== null} onClick={() => void selectRecent(project.id)}><span><b>{project.title}</b><small>{project.rootPathLabel}</small></span><span>{project.id === currentId ? 'CURRENT' : <><span>OPEN</span><ArrowUpRight aria-hidden="true" /></>}</span></button>
            {project.id !== currentId && <button className="project-dialog-archive" type="button" disabled={adding || archivingProjectId !== null} aria-label={locale === 'ja' ? `「${project.title}」をアーカイブ` : `Archive ${project.title}`} onClick={() => setArchiveCandidate(project)}><Archive aria-hidden="true" /><span>{locale === 'ja' ? 'アーカイブ' : 'ARCHIVE'}</span></button>}
          </div>)}</div>
        <footer><button type="button" className="is-secondary" disabled={adding} onClick={() => void startFromFolder()}><FolderOpen aria-hidden="true" />{adding ? (locale === 'ja' ? '選択中…' : 'CHOOSING…') : (locale === 'ja' ? 'フォルダから始める' : 'START FROM FOLDER')}</button><button type="button" disabled={adding} onClick={onNew}><Plus aria-hidden="true" />{locale === 'ja' ? '新しいプロジェクト' : 'NEW PROJECT'}</button></footer>
      </>}
    </dialog>
  );
}

function NewProjectDialog({ adding, locale, onStart, onClose }: { adding: boolean; locale: 'ja' | 'en'; onStart(name: string): Promise<boolean>; onClose(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState('');
  useEffect(() => {
    if (typeof ref.current?.showModal === 'function') ref.current.showModal();
    else ref.current?.setAttribute('open', '');
  }, []);
  const close = () => {
    if (typeof ref.current?.close === 'function') ref.current.close();
    else onClose();
  };
  const start = async (value: string) => {
    if (await onStart(value)) close();
  };
  return (
    <dialog ref={ref} className="new-project-dialog" onClose={onClose} onCancel={onClose}>
      <header><span>NEW PROJECT</span><button type="button" onClick={close} aria-label={locale === 'ja' ? '閉じる' : 'Close'}><X aria-hidden="true" /></button></header>
      <form onSubmit={(event) => { event.preventDefault(); const value = name.trim(); if (!value) return; void start(value); }}>
        <h2>{locale === 'ja' ? '新しいプロジェクトを始める' : 'Start a new project'}</h2>
        <p>{locale === 'ja' ? '名前を入力すると、ドキュメント内の Orquesta / Projects に作成します。' : 'Enter a name to create it in Orquesta / Projects under Documents.'}</p>
        <label htmlFor="new-project-name">{locale === 'ja' ? 'プロジェクト名' : 'Project name'}</label>
        <input id="new-project-name" autoFocus value={name} onChange={(event) => setName(event.target.value)} maxLength={160} placeholder={locale === 'ja' ? '例：新しいサービス' : 'Example: New service'} />
        <button className="new-project-submit" type="submit" disabled={!name.trim() || adding}><Plus aria-hidden="true" />{adding ? (locale === 'ja' ? '作成中…' : 'CREATING…') : (locale === 'ja' ? '作成して始める' : 'CREATE AND START')}</button>
      </form>
    </dialog>
  );
}

function FolderProjectDialog({ selection, adding, locale, onStart, onClose }: { selection: ProjectFolderSelection; adding: boolean; locale: 'ja' | 'en'; onStart(name: string): Promise<boolean>; onClose(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(selection.suggestedName);
  useEffect(() => {
    if (typeof ref.current?.showModal === 'function') ref.current.showModal();
    else ref.current?.setAttribute('open', '');
  }, []);
  const close = () => {
    if (typeof ref.current?.close === 'function') ref.current.close();
    else onClose();
  };
  const start = async (value: string) => {
    if (await onStart(value)) close();
  };
  return (
    <dialog ref={ref} className="new-project-dialog folder-project-dialog" onClose={onClose} onCancel={onClose}>
      <header><span>OPEN FOLDER</span><button type="button" onClick={close} aria-label={locale === 'ja' ? '閉じる' : 'Close'}><X aria-hidden="true" /></button></header>
      <form onSubmit={(event) => { event.preventDefault(); const value = name.trim(); if (!value) return; void start(value); }}>
        <h2>{locale === 'ja' ? 'プロジェクト名を決める' : 'Name this project'}</h2>
        <p>{locale === 'ja' ? '選んだフォルダは移動せず、この名前でOrquestaに登録します。' : 'The selected folder stays where it is and is registered in Orquesta with this name.'}</p>
        <small className="selected-folder-path">{selection.rootPath}</small>
        <label htmlFor="folder-project-name">{locale === 'ja' ? 'プロジェクト名' : 'Project name'}</label>
        <input id="folder-project-name" autoFocus value={name} onChange={(event) => setName(event.target.value)} maxLength={160} />
        <button type="submit" disabled={!name.trim() || adding}><FolderOpen aria-hidden="true" />{adding ? (locale === 'ja' ? '開始中…' : 'OPENING…') : (locale === 'ja' ? 'この名前で始める' : 'START WITH THIS NAME')}</button>
      </form>
    </dialog>
  );
}

function SettingsDialog({ state, store, locale, onLocaleChange, onNotificationsChange, onClose }: Pick<WorkspaceViewProps, 'state' | 'store' | 'locale' | 'onLocaleChange' | 'onNotificationsChange'> & { onClose(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const settings = state.settings;
  const updating = state.settingsUpdating;
  const runtimeStatus = state.runtimeStatus?.lifecycle ?? 'Stopped';
  const voiceStatus = state.voiceStatus;
  const requiredVoiceAssetIds = voiceStatus
    ? [voiceStatus.binaryAssetId, voiceStatus.initialModelAssetId]
    : [];
  const installedRequiredVoiceAssets = requiredVoiceAssetIds.filter((assetId) => (
    voiceStatus?.assets.some((asset) => asset.assetId === assetId && asset.phase === 'installed')
  )).length;
  const voiceStatusText = voiceStatus
    ? voiceStatus.requiredAssetsReady
      ? `${voiceStatus.providerId} · ${locale === 'ja' ? '準備完了' : 'Ready'}`
      : `${voiceStatus.providerId} · ${locale === 'ja' ? '要準備' : 'Setup needed'} (${installedRequiredVoiceAssets}/${requiredVoiceAssetIds.length})`
    : (locale === 'ja' ? '未読込' : 'Not loaded');
  const observedModels = [...new Set((state.snapshot?.tasks ?? [])
    .filter((task) => task.ownerAgentId === state.selectedAgentId
      && task.state !== 'queued' && task.state !== 'accepted' && task.state !== 'failed'
      && Boolean(task.actualModel))
    .map((task) => task.actualModel!))];
  const modelStatus = observedModels.length === 0
    ? (locale === 'ja' ? '未観測' : 'Not observed')
    : observedModels.length === 1
      ? (locale === 'ja' ? `観測済み · ${observedModels[0]}` : `Observed · ${observedModels[0]}`)
      : (locale === 'ja'
          ? `複数を観測 · ${observedModels.slice(0, 3).join(', ')}${observedModels.length > 3 ? ` +${observedModels.length - 3}` : ''}`
          : `Multiple observed · ${observedModels.slice(0, 3).join(', ')}${observedModels.length > 3 ? ` +${observedModels.length - 3}` : ''}`);
  const loadedSummaryCount = `${state.historyConversations.length}${state.historyIndexCursor ? '+' : ''}`;
  const storageStatus = locale === 'ja'
    ? `Native SQLite · 表示中の概要 ${loadedSummaryCount}件`
    : `Native SQLite · ${loadedSummaryCount} summaries shown`;
  const [notificationPending, setNotificationPending] = useState(false);
  const [notificationDenied, setNotificationDenied] = useState(false);
  useEffect(() => {
    if (typeof ref.current?.showModal === 'function') ref.current.showModal();
    else ref.current?.setAttribute('open', '');
    void store.refreshArchivedProjects();
  }, [store]);
  const close = () => {
    if (typeof ref.current?.close === 'function') ref.current.close();
    else onClose();
  };
  const save = (patch: Partial<Pick<NonNullable<ApplicationState['settings']>, 'theme' | 'reducedMotion'>>) => {
    if (!settings || updating) return;
    void store.updateSettings({
      locale: settings.locale ?? locale,
      theme: patch.theme ?? settings.theme,
      reducedMotion: patch.reducedMotion ?? settings.reducedMotion,
      notificationsEnabled: settings.notificationsEnabled,
      navigationCompact: settings.navigationCompact,
      workLedgerOpen: settings.workLedgerOpen,
    });
  };
  const changeNotifications = async () => {
    if (!settings || updating || notificationPending) return;
    setNotificationPending(true);
    setNotificationDenied(false);
    const result = await onNotificationsChange(!settings.notificationsEnabled);
    setNotificationPending(false);
    if (result === 'permission_denied' && !settings.notificationsEnabled) setNotificationDenied(true);
  };
  return (
    <dialog ref={ref} className="settings-dialog" onClose={onClose} onCancel={onClose}>
      <header><span>SETTINGS</span><button type="button" onClick={close} aria-label={locale === 'ja' ? '閉じる' : 'Close'}><X aria-hidden="true" /></button></header>
      <h2>{locale === 'ja' ? 'デスクトップ設定' : 'Desktop settings'}</h2>
      <section className="settings-section"><div><h3>{locale === 'ja' ? '言語' : 'Language'}</h3><p>{locale === 'ja' ? '画面に表示する言語を選びます。' : 'Choose the interface language.'}</p></div><div className="settings-options"><button type="button" disabled={!settings || updating} className={locale === 'ja' ? 'is-selected' : ''} aria-pressed={locale === 'ja'} onClick={() => onLocaleChange('ja')}>日本語</button><button type="button" disabled={!settings || updating} className={locale === 'en' ? 'is-selected' : ''} aria-pressed={locale === 'en'} onClick={() => onLocaleChange('en')}>English</button></div></section>
      <section className="settings-section"><div><h3>{locale === 'ja' ? '外観' : 'Appearance'}</h3><p>{locale === 'ja' ? '明るさをOSに合わせるか、固定します。' : 'Follow the OS appearance or choose one.'}</p></div><div className="settings-options"><button type="button" disabled={!settings || updating} className={settings?.theme === 'system' ? 'is-selected' : ''} aria-pressed={settings?.theme === 'system'} onClick={() => save({ theme: 'system' })}>{locale === 'ja' ? '自動' : 'System'}</button><button type="button" disabled={!settings || updating} className={settings?.theme === 'light' ? 'is-selected' : ''} aria-pressed={settings?.theme === 'light'} onClick={() => save({ theme: 'light' })}>{locale === 'ja' ? 'ライト' : 'Light'}</button><button type="button" disabled={!settings || updating} className={settings?.theme === 'dark' ? 'is-selected' : ''} aria-pressed={settings?.theme === 'dark'} onClick={() => save({ theme: 'dark' })}>{locale === 'ja' ? 'ダーク' : 'Dark'}</button></div></section>
      <section className="settings-section"><div><h3>{locale === 'ja' ? '動きを減らす' : 'Reduce motion'}</h3><p>{locale === 'ja' ? '画面の移動や点滅する演出を止めます。OS設定が有効な場合も自動で止まります。' : 'Stops moving and pulsing effects. The OS preference is also respected.'}</p></div><button type="button" className={`settings-toggle${settings?.reducedMotion ? ' is-selected' : ''}`} disabled={!settings || updating} aria-label={`${locale === 'ja' ? '動きを減らす' : 'Reduce motion'}: ${settings?.reducedMotion ? (locale === 'ja' ? 'オン' : 'On') : (locale === 'ja' ? 'オフ' : 'Off')}`} aria-pressed={settings?.reducedMotion ?? false} onClick={() => save({ reducedMotion: !settings?.reducedMotion })}>{settings?.reducedMotion ? (locale === 'ja' ? 'オン' : 'On') : (locale === 'ja' ? 'オフ' : 'Off')}</button></section>
      <section className="settings-section"><div><h3>{locale === 'ja' ? 'OS通知' : 'Desktop notifications'}</h3><p>{locale === 'ja' ? '返信、質問、確認、失敗を、Orquestaを見ていないときだけ知らせます。' : 'Get notified about replies, questions, reviews, and failures while you are away.'}</p>{notificationDenied && <small role="status">{locale === 'ja' ? 'OS通知が許可されていません。Windowsの設定を確認してください。' : 'Desktop notifications were not allowed. Check Windows settings.'}</small>}</div><button type="button" data-native-effect="notifications" className={`settings-toggle${settings?.notificationsEnabled ? ' is-selected' : ''}`} disabled={!settings || updating || notificationPending} aria-label={`${locale === 'ja' ? 'OS通知' : 'Desktop notifications'}: ${notificationPending ? (locale === 'ja' ? '確認中' : 'Checking') : settings?.notificationsEnabled ? (locale === 'ja' ? 'オン' : 'On') : (locale === 'ja' ? 'オフ' : 'Off')}`} aria-busy={notificationPending} aria-pressed={settings?.notificationsEnabled ?? false} onClick={() => void changeNotifications()}>{notificationPending ? (locale === 'ja' ? '確認中…' : 'Checking…') : settings?.notificationsEnabled ? (locale === 'ja' ? 'オン' : 'On') : (locale === 'ja' ? 'オフ' : 'Off')}</button></section>
      <section className="settings-section settings-archive-section" aria-labelledby="settings-archive-title">
        <div className="settings-archive-heading"><Archive aria-hidden="true" /><div><h3 id="settings-archive-title">{locale === 'ja' ? 'アーカイブ' : 'Archive'}</h3><p>{locale === 'ja' ? '一覧から退避したプロジェクトです。復元しても自動では開きません。' : 'Projects moved out of the main list. Restoring one does not open it automatically.'}</p></div></div>
        <div className="settings-archive-list" aria-live="polite" aria-busy={state.archivedProjectsLoading}>
          {state.archivedProjectsLoading
            ? <p className="settings-archive-empty">{locale === 'ja' ? '読み込み中…' : 'Loading archived projects…'}</p>
            : state.archivedProjects.length === 0
              ? <p className="settings-archive-empty">{locale === 'ja' ? 'アーカイブ済みのプロジェクトはありません。' : 'No archived projects.'}</p>
              : state.archivedProjects.map((project) => <div className="settings-archive-item" key={project.id}><span><b>{project.title}</b><small>{project.rootPathLabel}</small></span><button type="button" disabled={state.projectArchiveMutationId !== null} aria-label={locale === 'ja' ? `「${project.title}」を復元` : `Restore ${project.title}`} onClick={() => void store.restoreArchivedProject(project.id)}><RotateCcw aria-hidden="true" />{state.projectArchiveMutationId === project.id ? (locale === 'ja' ? '復元中…' : 'RESTORING…') : (locale === 'ja' ? '復元' : 'RESTORE')}</button></div>)}
        </div>
      </section>
      <section className="settings-section settings-status-section"><div><h3>{locale === 'ja' ? 'システムの状態' : 'System status'}</h3><p>{locale === 'ja' ? '保存する希望値ではなく、現在読み取れている状態です。' : 'Read-only facts observed from the current system, not saved preferences.'}</p><dl className="settings-status-list"><div><dt>Runtime</dt><dd>{runtimeStatus}</dd></div><div><dt>Model</dt><dd>{modelStatus}</dd></div><div><dt>Voice</dt><dd>{voiceStatusText}</dd></div><div><dt>Storage</dt><dd>{storageStatus}</dd></div><div><dt>Diagnostic</dt><dd>{`Runtime r${state.runtimeStatus?.statusRevision ?? 0} · Settings r${settings?.revision ?? 0} · Voice r${voiceStatus?.revision ?? 0}`}</dd></div></dl></div></section>
      <footer><span>ORQUESTA DESKTOP NEXT</span><small>V5 PREVIEW</small></footer>
    </dialog>
  );
}

export function WorkspaceView({ state, store, locale, onLocaleChange, onNotificationsChange, browserPreview = false }: WorkspaceViewProps) {
  const [projectDialog, setProjectDialog] = useState(false);
  const [newProjectDialog, setNewProjectDialog] = useState(false);
  const [folderProjectSelection, setFolderProjectSelection] = useState<ProjectFolderSelection | null>(null);
  const [newProjectOriginId, setNewProjectOriginId] = useState<string | null>(null);
  const [projectEntrySendDraft, setProjectEntrySendDraft] = useState(false);
  const [settingsDialog, setSettingsDialog] = useState(false);
  const [workLedgerWidth, setWorkLedgerWidth] = useState(WORK_LEDGER_DEFAULT_WIDTH);
  const [navigationPanelWidth, setNavigationPanelWidth] = useState(NAVIGATION_PANEL_DEFAULT_WIDTH);
  const [navigationResizeActive, setNavigationResizeActive] = useState(false);
  const [navigationExpandedIntent, setNavigationExpandedIntent] = useState<boolean | null>(null);
  const [workLedgerOpenIntent, setWorkLedgerOpenIntent] = useState<boolean | null>(null);
  const [workLedgerOpening, setWorkLedgerOpening] = useState(false);
  const lastNavigationPanelWidthRef = useRef(NAVIGATION_PANEL_DEFAULT_WIDTH);
  const lastWorkLedgerWidthRef = useRef(WORK_LEDGER_DEFAULT_WIDTH);
  const [previewEffectNotice, setPreviewEffectNotice] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedWorkOrderKey, setSelectedWorkOrderKey] = useState<string | null>(null);
  const [dismissedProjectGuideIds, setDismissedProjectGuideIds] = useState<Set<string>>(() => new Set());
  const [mapSessionStates, setMapSessionStates] = useState<Record<string, OrquestaMapSessionState>>({});
  const snapshot = state.snapshot;
  const selectedAgent = useMemo(() => snapshot?.agents.find((agent) => agent.id === state.selectedAgentId) ?? snapshot?.agents[0] ?? null, [snapshot, state.selectedAgentId]);

  useEffect(() => {
    if (!snapshot || !selectedAgent) return;
    const currentTask = snapshot.tasks.find((task) => task.id === selectedTaskId) ?? null;
    if (currentTask?.ownerAgentId === selectedAgent.id) return;
    const ownedTask = snapshot.tasks.find((task) => task.ownerAgentId === selectedAgent.id) ?? null;
    setSelectedTaskId(ownedTask?.id ?? null);
  }, [snapshot, selectedAgent, selectedTaskId, store]);

  useEffect(() => {
    if (!workLedgerOpening) return;
    const finishOpening = window.setTimeout(() => setWorkLedgerOpening(false), 260);
    return () => window.clearTimeout(finishOpening);
  }, [workLedgerOpening]);

  useEffect(() => {
    if (!newProjectDialog || !state.selectedProjectId || state.selectedProjectId === newProjectOriginId) return;
    setNewProjectDialog(false);
    setNewProjectOriginId(null);
  }, [newProjectDialog, newProjectOriginId, state.selectedProjectId]);

  const projectLifecycle = selectProjectLifecycle(state);
  const projectSurface = selectProjectSurface(projectLifecycle);
  const inactive = projectSurface !== 'ready' || !snapshot || !selectedAgent;
  const renderedRoute = inactive ? 'work' : state.route;
  const storedNavigationCompact = state.settings?.navigationCompact ?? true;
  const navigationExpandedPreference = navigationExpandedIntent ?? !storedNavigationCompact;
  const navigationExpanded = !inactive && (navigationResizeActive || navigationExpandedPreference);
  const workLedgerOpenPreference = workLedgerOpenIntent ?? (state.settings?.workLedgerOpen ?? true);
  const workLedgerOpen = !inactive && renderedRoute === 'work' && workLedgerOpenPreference;
  const workLedgerVisible = workLedgerOpen && !navigationExpanded;
  const dockMode = navigationExpanded ? 'navigation' : workLedgerVisible ? 'work' : 'collapsed';
  const showWorkHandle = !inactive
    && storedNavigationCompact
    && navigationExpandedIntent !== true
    && renderedRoute === 'work'
    && !workLedgerOpenPreference;
  const selectedTask = snapshot?.tasks.find((task) => task.id === selectedTaskId) ?? null;
  const openAttentionItems = selectOpenAttention(state);
  const selectedAttention = openAttentionItems.find((item) => item.taskId === selectedTask?.id)
    ?? openAttentionItems.find((item) => item.sourceAgentId === selectedAgent?.id)
    ?? null;
  const guideProjectId = snapshot?.project.id ?? null;
  const guideDismissed = !guideProjectId || dismissedProjectGuideIds.has(guideProjectId);
  const dismissProjectGuide = () => {
    if (!guideProjectId) return;
    setDismissedProjectGuideIds((current) => {
      if (current.has(guideProjectId)) return current;
      const next = new Set(current);
      next.add(guideProjectId);
      return next;
    });
  };
  const updateMapSessionState = (projectId: string, next: OrquestaMapSessionState) => {
    setMapSessionStates((current) => ({ ...current, [projectId]: next }));
  };

  const openProjectDialog = (sendDraft = false) => {
    setProjectEntrySendDraft(sendDraft);
    setProjectDialog(true);
  };
  const openNewProjectDialog = (sendDraft = false) => {
    setProjectEntrySendDraft(sendDraft);
    setNewProjectOriginId(state.selectedProjectId);
    setNewProjectDialog(true);
  };
  const updateWorkspaceLayout = async (patch: Partial<Pick<NonNullable<ApplicationState['settings']>, 'navigationCompact' | 'workLedgerOpen'>>) => {
    const settings = state.settings;
    if (!settings || state.settingsUpdating) return false;
    return await store.updateSettings({
      locale: settings.locale ?? locale,
      theme: settings.theme,
      reducedMotion: settings.reducedMotion,
      notificationsEnabled: settings.notificationsEnabled,
      navigationCompact: patch.navigationCompact ?? settings.navigationCompact,
      workLedgerOpen: patch.workLedgerOpen ?? settings.workLedgerOpen,
    });
  };
  const chooseFolderProject = async (sendDraft = false) => {
    setProjectEntrySendDraft(sendDraft);
    const selection = await store.chooseProjectFolder();
    if (!selection) return;
    setProjectDialog(false);
    setFolderProjectSelection(selection);
  };
  const commitWorkLedgerWidth = (nextWidth: number) => {
    if (nextWidth < WORK_LEDGER_CLOSE_THRESHOLD) {
      setWorkLedgerWidth(lastWorkLedgerWidthRef.current);
      setWorkLedgerOpening(false);
      setWorkLedgerOpenIntent(false);
      void updateWorkspaceLayout({ workLedgerOpen: false }).finally(() => setWorkLedgerOpenIntent(null));
      return;
    }
    const committed = Math.max(WORK_LEDGER_MIN_WIDTH, Math.min(WORK_LEDGER_MAX_WIDTH, nextWidth));
    lastWorkLedgerWidthRef.current = committed;
    setWorkLedgerWidth(committed);
  };
  const openWorkLedger = () => {
    setWorkLedgerWidth(lastWorkLedgerWidthRef.current);
    setWorkLedgerOpening(true);
    setWorkLedgerOpenIntent(true);
    void updateWorkspaceLayout({ workLedgerOpen: true }).finally(() => setWorkLedgerOpenIntent(null));
  };
  const commitNavigationPanelWidth = (nextWidth: number) => {
    if (nextWidth < NAVIGATION_PANEL_CLOSE_THRESHOLD) {
      setNavigationPanelWidth(lastNavigationPanelWidthRef.current);
      setNavigationExpandedIntent(false);
      void updateWorkspaceLayout({ navigationCompact: true }).finally(() => setNavigationExpandedIntent(null));
      return;
    }
    const committed = Math.max(NAVIGATION_PANEL_MIN_WIDTH, Math.min(NAVIGATION_PANEL_MAX_WIDTH, nextWidth));
    lastNavigationPanelWidthRef.current = committed;
    setNavigationPanelWidth(committed);
    setNavigationExpandedIntent(true);
    void updateWorkspaceLayout({ navigationCompact: false }).finally(() => setNavigationExpandedIntent(null));
  };
  const navigateWorkspace = (route: WorkspaceRoute) => {
    store.setRoute(route);
    if (!navigationExpanded) return;
    setNavigationExpandedIntent(false);
    void updateWorkspaceLayout({ navigationCompact: true }).finally(() => setNavigationExpandedIntent(null));
  };

  useEffect(() => {
    if (!navigationExpanded || navigationResizeActive) return;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setNavigationExpandedIntent(false);
      void updateWorkspaceLayout({ navigationCompact: true }).finally(() => setNavigationExpandedIntent(null));
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [navigationExpanded, navigationResizeActive, state.settings, state.settingsUpdating]);

  const selectAgent = (agentId: string) => {
    if (!agentId) return;
    setSelectedWorkOrderKey(null);
    store.selectAgent(agentId);
  };
  const selectTask = (task: TaskSummary) => {
    if (!snapshot) return;
    setSelectedWorkOrderKey(null);
    setSelectedTaskId(task.id);
    if (task.ownerAgentId) store.selectAgent(task.ownerAgentId);
  };
  const selectAttention = (item: AttentionItem) => {
    if (!snapshot) return;
    const task = item.taskId ? snapshot.tasks.find((candidate) => candidate.id === item.taskId) ?? null : null;
    if (task) selectTask(task);
    else if (item.sourceAgentId) selectAgent(item.sourceAgentId);
  };
  const openAttentionItem = (item: AttentionItem) => {
    selectAttention(item);
    store.setRoute('work');
  };
  const selectWorkOrder = (workOrder: BusinessWorkOrderSummary) => {
    if (!snapshot || !selectedAgent) return;
    setSelectedWorkOrderKey(workOrder.key);
    const coordinatorId = selectCurrentUserOrchestratorId(snapshot);
    const coordinator = snapshot.agents.find((agent) => agent.id === coordinatorId) ?? null;
    if (coordinator && coordinator.id !== selectedAgent.id) store.selectAgent(coordinator.id);
  };
  const blockNativeEffectInPreview = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!browserPreview || !(event.target instanceof Element)) return;
    const effectTarget = event.target.closest<HTMLElement>('[data-native-effect]');
    if (!effectTarget || !event.currentTarget.contains(effectTarget)) return;
    event.preventDefault();
    event.stopPropagation();
    setPreviewEffectNotice(locale === 'ja'
      ? 'ブラウザでは見た目だけ確認できます。この操作はOrquesta Nextデスクトップで実行してください。'
      : 'The browser mirrors the interface. Use Orquesta Next Desktop for this operation.');
  };
  const currentRecovery = selectCurrentProjectDispatchRecovery(state);
  const actionableRecovery = currentRecovery?.kind === 'accepted' ? null : currentRecovery;
  const recoveryMessage = actionableRecovery?.kind === 'prepared_outcome_unknown'
    ? (locale === 'ja'
        ? '送信結果を確認できませんでした。重複送信を避けるため、送信を一時停止しています。'
        : 'The send result could not be confirmed. Sending is paused to prevent a duplicate.')
    : actionableRecovery?.kind === 'cleanup_pending'
      ? (locale === 'ja'
          ? '送信失敗後の一時データを整理する必要があります。完了するまで送信を一時停止しています。'
          : 'Temporary data from a failed send still needs cleanup. Sending is paused until cleanup finishes.')
      : null;
  const recoveryActionLabel = actionableRecovery?.kind === 'prepared_outcome_unknown'
    ? (state.recoveryPending
        ? (locale === 'ja' ? '確認中…' : 'CHECKING…')
        : (locale === 'ja' ? '送信状態を確認' : 'CHECK SEND STATUS'))
    : actionableRecovery?.kind === 'cleanup_pending'
      ? (state.recoveryPending
          ? (locale === 'ja' ? '整理中…' : 'CLEANING…')
          : (locale === 'ja' ? '整理を再開' : 'RESUME CLEANUP'))
      : null;
  const toastMessage = state.error ? userMessageCopy(state.error, locale)
    : state.notice ? userMessageCopy(state.notice, locale)
      : recoveryMessage ?? previewEffectNotice;
  const dismissToast = () => {
    if (state.error || state.notice) store.clearError();
    else setPreviewEffectNotice(null);
  };
  return (
    <div
      className={`workspace-shell v5-workspace-shell route-${renderedRoute}${inactive ? ' is-inactive' : navigationExpanded ? ' is-navigation-overlay-open' : ' is-nav-compact'}${!inactive && renderedRoute === 'work' && !workLedgerVisible ? ' is-work-ledger-closed' : ''}${workLedgerOpening && workLedgerVisible ? ' is-work-ledger-opening' : ''}`}
      data-dock-mode={dockMode}
      style={{
        '--work-ledger-width': `${workLedgerWidth}px`,
        '--navigation-panel-width': `${navigationPanelWidth}px`,
      } as CSSProperties}
      onClickCapture={blockNativeEffectInPreview}
    >
      <a href="#main-content" className="skip-link">{locale === 'ja' ? 'メインへ移動' : 'Skip to main content'}</a>
      <ScreenReaderAnnouncer state={state} locale={locale} />
      <ProjectSidebar
        state={state}
        locale={locale}
        compact={!inactive && !navigationExpanded}
        onNavigate={navigateWorkspace}
        onOpenProjects={() => openProjectDialog(false)}
        onOpenSettings={() => setSettingsDialog(true)}
      />
      {!inactive && <NavigationDivider
        expanded={navigationExpanded}
        width={navigationPanelWidth}
        showWorkHandle={showWorkHandle}
        disabled={state.settingsUpdating}
        locale={locale}
        onResize={setNavigationPanelWidth}
        onCommit={commitNavigationPanelWidth}
        onDragStateChange={setNavigationResizeActive}
        onOpenWork={openWorkLedger}
      />}
      <LucaAccess state={state} store={store} locale={locale} />
      {inactive ? <main id="main-content" className="execution-workspace is-empty route-enter">
        <WorkspaceInactiveState state={state} store={store} locale={locale} />
        <div className="ledger-composer-slot"><Composer
          state={state}
          store={store}
          locale={locale}
          onOpenProjects={openProjectDialog}
          onNewProject={openNewProjectDialog}
          onStartFromFolder={(sendDraft = false) => void chooseFolderProject(sendDraft)}
          guideDismissed={guideDismissed}
          onDismissGuide={dismissProjectGuide}
        /></div>
      </main>
        : renderedRoute === 'work' ? <>
        {workLedgerVisible && <WorkLedger state={state} selectedAgentId={selectedAgent.id} selectedWorkOrderKey={selectedWorkOrderKey} onSelectAgent={selectAgent} onSelectWorkOrder={selectWorkOrder} onViewHistory={() => store.setRoute('history')} locale={locale} />}
        {workLedgerVisible && <WorkLedgerDivider width={workLedgerWidth} locale={locale} onResize={setWorkLedgerWidth} onCommit={commitWorkLedgerWidth} />}
        <main id="main-content" className="execution-workspace route-enter">
          <WorkSurface state={state} store={store} locale={locale} selectedAgent={selectedAgent} selectedAttention={selectedAttention} />
          <div className="ledger-composer-slot"><Composer state={state} store={store} locale={locale} guideDismissed={guideDismissed} onDismissGuide={dismissProjectGuide} /></div>
        </main>
      </> : <main id="main-content" className="route-workspace">
        {renderedRoute === 'map' && snapshot && <MapView
          state={state}
          store={store}
          locale={locale}
          sessionState={mapSessionStates[snapshot.project.id]}
          onSessionStateChange={(next) => updateMapSessionState(snapshot.project.id, next)}
        />}
        {renderedRoute === 'decisions' && <DecisionsView state={state} locale={locale} onOpen={openAttentionItem} />}
        {renderedRoute === 'workflows' && <WorkflowsView state={state} store={store} locale={locale} />}
        {renderedRoute === 'history' && <HistoryView state={state} store={store} locale={locale} />}
      </main>}
      {projectDialog && <ProjectDialog projects={state.projects} currentId={state.runtimeAuthority?.projectId ?? null} adding={state.addingProject} locale={locale} onAdd={() => store.chooseProjectFolder()} onFolderSelected={(selection) => { setProjectDialog(false); setFolderProjectSelection(selection); }} onNew={() => { store.retireProjectEntryIntent(); setProjectDialog(false); setNewProjectOriginId(state.selectedProjectId); setNewProjectDialog(true); }} onClose={() => { store.retireProjectEntryIntent(); setProjectDialog(false); }} onSelect={(projectId) => store.selectProject(projectId, { sendDraft: projectEntrySendDraft })} onArchive={(projectId) => store.archiveProject(projectId)} />}
      {newProjectDialog && <NewProjectDialog adding={state.addingProject} locale={locale} onStart={(name) => store.createStarterProject(name, { sendDraft: projectEntrySendDraft })} onClose={() => { store.retireProjectEntryIntent(); setNewProjectDialog(false); setNewProjectOriginId(null); }} />}
      {folderProjectSelection && <FolderProjectDialog selection={folderProjectSelection} adding={state.addingProject} locale={locale} onStart={(name) => store.openProjectFolder(folderProjectSelection, name, { sendDraft: projectEntrySendDraft })} onClose={() => { store.retireProjectEntryIntent(); setFolderProjectSelection(null); }} />}
      {settingsDialog && <SettingsDialog state={state} store={store} locale={locale} onLocaleChange={onLocaleChange} onNotificationsChange={onNotificationsChange} onClose={() => setSettingsDialog(false)} />}
      {toastMessage && <div className={`toast ${state.error ? 'toast-error' : 'toast-notice'}`} role={state.error ? 'alert' : 'status'}><span>{toastMessage}</span>{actionableRecovery && recoveryActionLabel && !state.error && !state.notice && <button className="toast-action" type="button" disabled={state.recoveryPending} onClick={() => void store.reconcileDispatchRecovery()}>{recoveryActionLabel}</button>}{(!actionableRecovery || state.error || state.notice) && <button type="button" onClick={dismissToast} aria-label={locale === 'ja' ? '通知を閉じる' : 'Dismiss notification'}><X aria-hidden="true" /></button>}</div>}
    </div>
  );
}
