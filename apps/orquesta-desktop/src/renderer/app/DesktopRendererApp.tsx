import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FolderOpen, MessageCircleQuestion } from 'lucide-react';
import type { AgentProposal, ComposerAttachment, ConversationMessage, OrquestaRendererBridge, ProjectSummary, UiActionResult } from '../../contracts/bridge';
import { LUCA_AGENT_ID, type AskLucaInput, type LucaContextRef } from '../../contracts/luca';
import type { AttentionUiItem, OrquestaUiSnapshot, RuntimeUiEvent, UserActionKind } from '../../contracts/orquesta-ui';
import { DesktopRepositoryBridge } from '../../bridges/desktop-repository-bridge';
import { MockOrquestaBridge } from '../../bridges/mock-bridge';
import { fixtureKeys, type FixtureId } from '../../fixtures';
import { AttentionCard } from '../features/attention/AttentionCard';
import { UserTaskQuickView } from '../features/attention/UserTaskQuickView';
import { CommandComposer } from '../features/composer/CommandComposer';
import { AgentDetail } from '../features/details/AgentDetail';
import { AttentionDetail } from '../features/details/AttentionDetail';
import { InspectionDetail } from '../features/details/InspectionDetail';
import { TaskDetail } from '../features/details/TaskDetail';
import { I18nProvider, useI18n } from '../features/i18n/I18nProvider';
import type { Locale } from '../features/i18n/messages';
import { MapViewport } from '../features/map/MapViewport';
import { LucaPanel, type LucaPanelState } from '../features/luca/LucaPanel';
import { WorkspaceDock, type WorkspaceId } from '../features/navigation/WorkspaceDock';
import { WorkspaceSurface, type RecordKind, type UserTaskKind } from '../features/navigation/WorkspaceSurface';
import { createDefaultTaskRecordView, type TaskRecordView } from '../features/records/TaskRecordsWorkspace';
import { createDefaultFailureRecordView, type FailureRecordView } from '../features/records/FailureRecordsWorkspace';
import type { DecisionRecordKind } from '../features/records/DecisionRecordsWorkspace';
import type { TimelineRecord } from '../features/records/TimelineRecordsWorkspace';
import { NowCardStack } from '../features/now/NowCardStack';
import { NowListOverlay } from '../features/now/NowListOverlay';
import { V4Operations } from '../features/operations/V4Operations';
import { ProjectLauncher } from '../features/project/ProjectLauncher';
import { RepositoryStatusPill } from '../features/project/RepositoryStatusPill';
import { ProjectRoute } from '../features/project/ProjectRoute';
import { ProjectStatusCard } from '../features/project/ProjectStatusCard';
import { ProjectSwitcher } from '../features/project/ProjectSwitcher';
import { InitialSetupExperience } from '../features/setup/InitialSetupExperience';
import { SetupIntake } from '../features/setup/SetupIntake';
import { TeamManagement } from '../features/team/TeamManagement';
import { ToastStack } from '../features/toast/ToastStack';

export type OpenOverlay =
  | { kind: 'agent'; agentId: string }
  | { kind: 'task'; taskId: string }
  | { kind: 'attention'; attentionId: string }
  | { kind: 'inspection'; runId: string }
  | { kind: 'project-route' }
  | { kind: 'project-switcher' }
  | { kind: 'team-management' }
  | { kind: 'operations' }
  | { kind: 'now-list' }
  | { kind: 'user-task-quick-view' }
  | null;

type MapSelection = { kind: 'agent'; agentId: string } | { kind: 'task'; taskId: string } | null;

function queryFixture(): FixtureId | null {
  if (typeof window === 'undefined') return null;
  const requested = new URLSearchParams(window.location.search).get('fixture');
  return fixtureKeys.includes(requested as FixtureId) ? requested as FixtureId : null;
}

function createDefaultBridge(): OrquestaRendererBridge {
  const fixture = queryFixture();
  if (fixture) return new MockOrquestaBridge(fixture);
  if (typeof window !== 'undefined' && window.orquestaDesktop) return new DesktopRepositoryBridge(window.orquestaDesktop);
  return new MockOrquestaBridge('active-project');
}
const LOCALE_STORAGE_KEY = 'orquesta.desktop.locale';

export function resolveInitialLocale(explicit?: Locale): Locale {
  if (typeof window === 'undefined') return explicit ?? 'en';
  const requested = new URLSearchParams(window.location.search).get('lang');
  if (requested === 'ja' || requested === 'en') return requested;
  if (explicit) return explicit;
  const persisted = window.localStorage.getItem(LOCALE_STORAGE_KEY);
  if (persisted === 'ja' || persisted === 'en') return persisted;
  return window.navigator.languages?.some((locale) => locale.toLowerCase().startsWith('ja')) ? 'ja' : 'en';
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!media) return;
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener?.('change', update);
    return () => media.removeEventListener?.('change', update);
  }, []);
  return reduced;
}

function Workspace({ bridge, onStartupReady }: { bridge: OrquestaRendererBridge; onStartupReady?: () => void }) {
  const { t, locale } = useI18n();
  const reducedMotion = useReducedMotion();
  const [snapshot, setSnapshot] = useState<OrquestaUiSnapshot | null>(null);
  const [loadingError, setLoadingError] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<OpenOverlay>(null);
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceId>('home');
  const [userTaskKind, setUserTaskKind] = useState<UserTaskKind>('all');
  const [recordKind, setRecordKind] = useState<RecordKind>('task');
  const [taskRecordView, setTaskRecordView] = useState<TaskRecordView>(() => createDefaultTaskRecordView());
  const [failureRecordView, setFailureRecordView] = useState<FailureRecordView>(() => createDefaultFailureRecordView());
  const [selectedInspectionRunId, setSelectedInspectionRunId] = useState<string | null>(null);
  const [decisionRecords, setDecisionRecords] = useState<AttentionUiItem[]>([]);
  const [decisionRecordKind, setDecisionRecordKind] = useState<DecisionRecordKind>('all');
  const [decisionRecordsLoading, setDecisionRecordsLoading] = useState(false);
  const [timelineConversations, setTimelineConversations] = useState<ConversationMessage[]>([]);
  const [timelineDecisions, setTimelineDecisions] = useState<AttentionUiItem[]>([]);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [mapSelection, setMapSelection] = useState<MapSelection>(null);
  const [draft, setDraft] = useState('');
  const [targetAgentId, setTargetAgentId] = useState('orchestrator');
  const [sending, setSending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [directSendFailure, setDirectSendFailure] = useState<string | null>(null);
  const [toasts, setToasts] = useState<RuntimeUiEvent[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [conversationTargetAgentId, setConversationTargetAgentId] = useState('orchestrator');
  const [conversationCursor, setConversationCursor] = useState<string | null>(null);
  const [loadingConversation, setLoadingConversation] = useState(false);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const [proposals, setProposals] = useState<AgentProposal[]>([]);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [lucaContext, setLucaContext] = useState<LucaContextRef | null>(null);
  const [lucaState, setLucaState] = useState<LucaPanelState>({ kind: 'idle' });
  const [lucaMessages, setLucaMessages] = useState<ConversationMessage[]>([]);
  const draftProjectId = useRef<string | null>(null);
  const startupReadyReported = useRef(false);
  const conversationRequest = useRef(0);
  const decisionHistoryRequest = useRef(0);
  const timelineRequest = useRef(0);
  const conversationTargetAgentIdRef = useRef('orchestrator');
  const availableAgentIdsRef = useRef<Set<string>>(new Set());
  const currentProjectIdRef = useRef<string | null>(null);
  const lucaPendingProjectIdRef = useRef<string | null>(null);
  const lucaPendingThreadIdRef = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    void bridge.getInitialSnapshot()
      .then((next) => {
        if (!alive) return;
        availableAgentIdsRef.current = new Set(next.agents.map((agent) => agent.id));
        currentProjectIdRef.current = next.project.id;
        setSnapshot(next);
        setToasts(next.recentEvents);
      })
      .catch((error: unknown) => setLoadingError(error instanceof Error ? error.message : String(error)));
    const unsubscribe = bridge.subscribe((event) => {
      if (event.type === 'snapshot_changed') {
        availableAgentIdsRef.current = new Set(event.snapshot.agents.map((agent) => agent.id));
        currentProjectIdRef.current = event.snapshot.project.id;
        const fallbackAgentId = event.snapshot.agents.find((agent) => agent.id === 'orchestrator')?.id
          ?? event.snapshot.agents[0]?.id
          ?? 'orchestrator';
        setSnapshot(event.snapshot);
        setLoadingError(null);
        setActionError(null);
        setTargetAgentId((current) => event.snapshot.agents.some((agent) => agent.id === current) ? current : fallbackAgentId);
        if (conversationTargetAgentIdRef.current !== LUCA_AGENT_ID && !event.snapshot.agents.some((agent) => agent.id === conversationTargetAgentIdRef.current)) {
          conversationRequest.current += 1;
          conversationTargetAgentIdRef.current = fallbackAgentId;
          setConversationTargetAgentId(fallbackAgentId);
          setMessages([]);
          setConversationCursor(null);
          setLoadingConversation(false);
          setActiveWorkspace('home');
        }
      } else if (event.type === 'toast') {
        setToasts((current) => [...current, event.toast].slice(-6));
      } else if (event.notification.targetAgentId === 'orquesta-admin'
        && lucaPendingProjectIdRef.current === currentProjectIdRef.current) {
        const notification = event.notification;
        if (notification.kind === 'turn_started') {
          lucaPendingThreadIdRef.current = notification.threadId;
        } else if (!lucaPendingThreadIdRef.current || lucaPendingThreadIdRef.current === notification.threadId) {
          lucaPendingThreadIdRef.current = notification.threadId;
          if (notification.kind === 'turn_failed') {
            setLucaState({ kind: 'error', message: notification.text ?? 'Luca could not answer this question.', retryable: true });
          } else if (notification.kind === 'agent_message' || notification.kind === 'turn_completed') {
            void bridge.listConversation({ targetAgentId: 'orquesta-admin', cursor: null, limit: 100 })
              .then((page) => {
                if (lucaPendingProjectIdRef.current !== currentProjectIdRef.current) return;
                setLucaMessages(page.items);
                const latest = [...page.items].reverse().find((message) => message.role === 'agent');
                if (!latest && notification.kind !== 'agent_message') return;
                setLucaState({
                  kind: 'answer',
                  payload: latest?.lucaAnswer ?? {
                    answer: latest?.text ?? notification.text ?? 'Luca returned an empty answer.',
                    points: [], uncertainties: [], references: []
                  }
                });
              })
              .catch((error: unknown) => setLucaState({
                kind: 'error', message: error instanceof Error ? error.message : String(error), retryable: true
              }));
          }
        }
      }
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [bridge]);

  useEffect(() => {
    if (startupReadyReported.current || (!snapshot && !loadingError)) return;
    startupReadyReported.current = true;
    onStartupReady?.();
  }, [loadingError, onStartupReady, snapshot]);

  useEffect(() => {
    const projectId = snapshot?.project.id ?? null;
    if (!projectId || projectId === 'no-project' || draftProjectId.current === projectId) return;
    draftProjectId.current = projectId;
    setMapSelection(null);
    setActiveWorkspace('home');
    setTaskRecordView(createDefaultTaskRecordView());
    setFailureRecordView(createDefaultFailureRecordView());
    setSelectedInspectionRunId(null);
    setDecisionRecords([]);
    setDecisionRecordKind('all');
    setDecisionRecordsLoading(false);
    decisionHistoryRequest.current += 1;
    setTimelineConversations([]);
    setTimelineDecisions([]);
    setTimelineLoading(false);
    timelineRequest.current += 1;
    setOverlay(null);
    setAttachments([]);
    setDirectSendFailure(null);
    setLucaContext(null);
    setLucaState({ kind: 'idle' });
    setLucaMessages([]);
    lucaPendingProjectIdRef.current = null;
    lucaPendingThreadIdRef.current = null;
    setMessages([]);
    conversationTargetAgentIdRef.current = 'orchestrator';
    setConversationTargetAgentId('orchestrator');
    conversationRequest.current += 1;
    setConversationCursor(null);
    setLoadingConversation(false);
    setDraft(window.localStorage.getItem(`orquesta.desktop.draft.${projectId}`) ?? '');
  }, [snapshot?.project.id]);

  useEffect(() => {
    const projectId = draftProjectId.current;
    if (!projectId) return;
    const key = `orquesta.desktop.draft.${projectId}`;
    if (draft) window.localStorage.setItem(key, draft);
    else window.localStorage.removeItem(key);
  }, [draft]);

  const closeOverlay = useCallback(() => setOverlay(null), []);
  const clearMapSelection = useCallback(() => {
    setMapSelection(null);
    setOverlay(null);
  }, []);
  const getRuntimeInfo = useCallback((input: { probe: boolean }) => bridge.getRuntimeInfo(input), [bridge]);
  const readInspectionReport = useCallback((runId: string) => bridge.readInspectionReport(runId), [bridge]);
  const openLuca = useCallback((context: LucaContextRef) => {
    setLucaContext((current) => {
      const same = current?.kind === context.kind
        && (current.kind === 'home' || (context.kind !== 'home' && current.id === context.id));
      if (!same) setLucaState({ kind: 'idle' });
      return context;
    });
  }, []);
  const askLuca = useCallback(async (input: AskLucaInput) => {
    if (!currentProjectIdRef.current) return;
    setLucaState({ kind: 'pending', questionId: input.questionId });
    lucaPendingProjectIdRef.current = currentProjectIdRef.current;
    lucaPendingThreadIdRef.current = null;
    try {
      const result = await bridge.askLuca(input);
      if (result.status !== 'accepted') {
        setLucaState({ kind: 'error', message: result.reason, retryable: result.retryable });
      }
    } catch (error) {
      setLucaState({ kind: 'error', message: error instanceof Error ? error.message : String(error), retryable: true });
    }
  }, [bridge]);
  const openProjects = async () => {
    try {
      setProjects(await bridge.listProjects());
      setOverlay({ kind: 'project-switcher' });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  };
  const openProjectFolder = async () => {
    try {
      const result = await bridge.requestOpenProject();
      if (result.status !== 'accepted') setActionError(result.reason);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  };
  const openConversation = async (requestedTargetAgentId = targetAgentId) => {
    if (requestedTargetAgentId !== LUCA_AGENT_ID && !availableAgentIdsRef.current.has(requestedTargetAgentId)) return;
    const request = ++conversationRequest.current;
    conversationTargetAgentIdRef.current = requestedTargetAgentId;
    setConversationTargetAgentId(requestedTargetAgentId);
    if (requestedTargetAgentId !== LUCA_AGENT_ID) setTargetAgentId(requestedTargetAgentId);
    setMessages([]);
    setConversationCursor(null);
    setLoadingConversation(true);
    setActionError(null);
    setOverlay(null);
    setMapSelection(null);
    setRecordKind('conversation');
    setActiveWorkspace('records');
    try {
      const page = await bridge.listConversation({ targetAgentId: requestedTargetAgentId, cursor: null, limit: 100 });
      if (request !== conversationRequest.current || (requestedTargetAgentId !== LUCA_AGENT_ID && !availableAgentIdsRef.current.has(requestedTargetAgentId))) return;
      setMessages(page.items);
      setConversationCursor(page.nextCursor);
    } catch (error) {
      if (request === conversationRequest.current) setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      if (request === conversationRequest.current) setLoadingConversation(false);
    }
  };
  const openDecisionHistory = async () => {
    const request = ++decisionHistoryRequest.current;
    setDecisionRecords([]);
    setDecisionRecordsLoading(true);
    setActionError(null);
    setOverlay(null);
    setMapSelection(null);
    setRecordKind('decision');
    setActiveWorkspace('records');
    try {
      const items = await bridge.listAttentionHistory();
      if (request !== decisionHistoryRequest.current) return;
      setDecisionRecords(items);
    } catch (error) {
      if (request === decisionHistoryRequest.current) setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      if (request === decisionHistoryRequest.current) setDecisionRecordsLoading(false);
    }
  };
  const openTimeline = async () => {
    if (!snapshot) return;
    const projectId = snapshot.project.id;
    const request = ++timelineRequest.current;
    setTimelineConversations([]);
    setTimelineDecisions([]);
    setTimelineLoading(true);
    setActionError(null);
    setOverlay(null);
    setMapSelection(null);
    setRecordKind('timeline');
    setActiveWorkspace('records');
    try {
      const [decisions, conversationPages] = await Promise.all([
        bridge.listAttentionHistory(),
        Promise.all(snapshot.agents.map((agent) => bridge.listConversation({ targetAgentId: agent.id, cursor: null, limit: 100 })))
      ]);
      if (request !== timelineRequest.current || draftProjectId.current !== projectId) return;
      const byId = new Map(conversationPages.flatMap((page) => page.items).map((message) => [message.id, message]));
      setTimelineConversations([...byId.values()]);
      setTimelineDecisions(decisions);
    } catch (error) {
      if (request === timelineRequest.current) setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      if (request === timelineRequest.current) setTimelineLoading(false);
    }
  };
  const selectWorkspace = (workspace: WorkspaceId) => {
    setOverlay(null);
    setMapSelection(null);
    setActiveWorkspace(workspace);
  };
  const loadOlderConversation = async () => {
    if (!conversationCursor || loadingOlderMessages) return;
    setLoadingOlderMessages(true);
    try {
      const page = await bridge.listConversation({ targetAgentId: conversationTargetAgentId, cursor: conversationCursor, limit: 100 });
      setMessages((current) => {
        const byId = new Map([...page.items, ...current].map((message) => [message.id, message]));
        return [...byId.values()];
      });
      setConversationCursor(page.nextCursor);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingOlderMessages(false);
    }
  };
  const openTeam = async () => {
    try {
      setProposals(await bridge.listAgentProposals());
      setOverlay({ kind: 'team-management' });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  };
  const send = async () => {
    if (!draft.trim() || sending) return;
    setSending(true);
    setActionError(null);
    setDirectSendFailure(null);
    try {
      const result = await bridge.sendMessage({ targetAgentId, text: draft.trim(), attachmentIds: attachments.map((attachment) => attachment.id), selectedContextIds: [] });
      if (result.status === 'accepted') { setDraft(''); setAttachments([]); }
      else setDirectSendFailure(result.reason);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setDirectSendFailure(`Message was not sent. ${message}`);
    } finally {
      setSending(false);
    }
  };
  const openCodexDraft = async () => {
    if (!draft.trim()) return;
    try {
      const result = await bridge.openCodexDraft({ targetAgentId, text: draft.trim() });
      if (result.status !== 'accepted') {
        setDirectSendFailure(result.reason);
        return;
      }
      setDirectSendFailure(null);
      setToasts((current) => [...current, {
        id: result.correlationId,
        tone: 'neutral' as const,
        title: 'Unsent Codex draft opened',
        message: 'The text remains a draft and has not been sent.',
        taskId: null,
        createdAt: new Date().toISOString()
      }].slice(-6));
    } catch (error) {
      setDirectSendFailure(error instanceof Error ? error.message : String(error));
    }
  };
  const selectAttachments = async () => {
    try {
      const selected = await bridge.selectImageAttachments();
      setAttachments((current) => [...current, ...selected].slice(0, 4));
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  };
  const resolveAttention = async (item: AttentionUiItem, decision: string): Promise<UiActionResult> => {
    try {
      if (item.runtimeApproval) {
        const result = await bridge.resolveAttentionItem({ kind: 'runtime_approval', id: item.id, decision });
        if (result.status !== 'accepted' && activeWorkspace === 'home') setActionError(result.reason);
        return result;
      }

      const directResult = await bridge.resolveAttentionItem({ kind: 'repository_action', id: item.id, resolution: decision });
      if (directResult.status !== 'unsupported') {
        if (directResult.status !== 'accepted' && activeWorkspace === 'home') setActionError(directResult.reason);
        return directResult;
      }

      const responseTargetAgentId = item.sourceAgentId && availableAgentIdsRef.current.has(item.sourceAgentId)
        ? item.sourceAgentId
        : availableAgentIdsRef.current.has('orchestrator') ? 'orchestrator' : targetAgentId;
      const message = [
        'User Task response',
        `ID: ${item.id}`,
        `Task: ${item.taskId ?? 'none'}`,
        `Type: ${item.actionKind}`,
        '',
        'Response:',
        decision,
        '',
        'Apply this response to the canonical Orquesta state and continue the related work.'
      ].join('\n');
      return await bridge.sendMessage({ targetAgentId: responseTargetAgentId, text: message, attachmentIds: [], selectedContextIds: [] });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (activeWorkspace === 'home') setActionError(reason);
      return { status: 'failed', correlationId: `user-task-${Date.now()}`, reason, retryable: true };
    }
  };

  if (loadingError) {
    return (
      <main className="desktop-shell loading-shell" role="application" aria-label="Orquesta Desktop">
        <section><strong>{t('snapshotUnavailable')}</strong><p>{loadingError}</p><div className="loading-actions"><button type="button" onClick={() => window.location.reload()}>{t('retry')}</button><button type="button" onClick={() => void openProjectFolder()}><FolderOpen size={15} />{t('openProjectFolder')}</button></div></section>
      </main>
    );
  }
  if (!snapshot) {
    return <main className="desktop-shell loading-shell" role="application" aria-label="Orquesta Desktop"><div className="loading-mark"><i />{t('loading')}</div></main>;
  }

  if (snapshot.setup && snapshot.setup.status !== 'completed' && snapshot.setup.status !== 'cancelled') {
    return <InitialSetupExperience setup={snapshot.setup} />;
  }

  if (snapshot.project.id === 'no-project') {
    return <SetupIntake bridge={bridge} locale={locale} />;
  }

  const selectedAgent = overlay?.kind === 'agent' ? snapshot.agents.find((agent) => agent.id === overlay.agentId) ?? null : null;
  const selectedTask = overlay?.kind === 'task' ? snapshot.tasks.find((task) => task.id === overlay.taskId) ?? null : null;
  const selectedAttention = overlay?.kind === 'attention' ? snapshot.attention.find((item) => item.id === overlay.attentionId) ?? null : null;
  const selectedInspection = overlay?.kind === 'inspection' ? snapshot.inspectionRuns.find((item) => item.runId === overlay.runId) ?? null : null;
  const selectedAgentTask = selectedAgent?.currentTaskId ? snapshot.tasks.find((task) => task.id === selectedAgent.currentTaskId) ?? null : null;
  const selectAgent = (agentId: string) => {
    setMapSelection({ kind: 'agent', agentId });
    setOverlay({ kind: 'agent', agentId });
  };
  const selectInspection = (runId: string) => {
    setMapSelection(null);
    setOverlay({ kind: 'inspection', runId });
  };
  const cancelInspection = async (runId: string): Promise<UiActionResult> => {
    const result = await bridge.cancelInspection(runId);
    if (result.status !== 'accepted') setActionError(result.reason);
    return result;
  };
  const openTaskRecord = (taskId: string) => {
    const task = snapshot.tasks.find((candidate) => candidate.id === taskId);
    setTaskRecordView((current) => ({
      ...current,
      scope: task?.state === 'accepted' ? 'complete' : 'incomplete',
      selectedTaskId: taskId
    }));
    setMapSelection(null);
    setOverlay(null);
    setRecordKind('task');
    setActiveWorkspace('records');
  };
  const openTimelineRecord = (record: TimelineRecord) => {
    if (record.kind === 'task') {
      openTaskRecord(record.sourceId);
      return;
    }
    if (record.kind === 'error') {
      const failure = snapshot.failures.find((candidate) => candidate.id === record.sourceId);
      setFailureRecordView((current) => ({
        ...current,
        scope: failure?.resolution === 'resolved' ? 'resolved' : (failure?.occurrenceCount ?? 0) >= 2 ? 'repeated' : 'open',
        selectedFailureId: record.sourceId
      }));
      setRecordKind('error');
      setActiveWorkspace('records');
      return;
    }
    if (record.kind === 'conversation') {
      void openConversation(record.sourceId);
      return;
    }
    void openDecisionHistory();
  };
  const workspaceCounts = {
    userTasks: snapshot.attention.length
  };
  const workspaceLabels = {
    navigation: t('workspace'),
    home: t('home'),
    'user-tasks': t('workspaceUserTasks'),
    records: t('workspaceRecords'),
    settings: t('workspaceSettings')
  };
  const openAttentionItem = (item: AttentionUiItem) => item.taskId && snapshot.tasks.some((task) => task.id === item.taskId)
    ? openTaskRecord(item.taskId)
    : setOverlay({ kind: 'attention', attentionId: item.id });
  const changeTargetAgent = (agentId: string) => {
    setTargetAgentId(agentId);
    if (activeWorkspace === 'records' && recordKind === 'conversation') void openConversation(agentId);
  };
  const openUserTasks = (kind: UserTaskKind = 'all') => {
    setUserTaskKind(kind);
    selectWorkspace('user-tasks');
  };
  const openRecords = (kind: RecordKind) => {
    if (kind === 'task') setTaskRecordView((current) => ({ ...current, scope: 'incomplete', selectedTaskId: null }));
    if (kind !== 'inspection') setSelectedInspectionRunId(null);
    setRecordKind(kind);
    selectWorkspace('records');
  };
  const openInspectionReport = (runId: string) => {
    setSelectedInspectionRunId(runId);
    setMapSelection(null);
    setOverlay(null);
    setRecordKind('inspection');
    setActiveWorkspace('records');
  };

  return (
    <main className={`desktop-shell project-${snapshot.project.status}`} role="application" aria-label="Orquesta Desktop">
      <div className="paper-grain" aria-hidden="true" />
      <RepositoryStatusPill project={snapshot.project} />
      {activeWorkspace === 'home' ? (
        <ProjectLauncher
          project={snapshot.project}
          onSwitchProject={() => void openProjects()}
          onOpenProject={() => void openProjectFolder()}
        />
      ) : null}
      {activeWorkspace === 'home' ? (
        <button type="button" className="luca-home-trigger" aria-label={locale === 'ja' ? 'Lucaに聞く' : 'Ask Luca'} aria-pressed={lucaContext?.kind === 'home'} onClick={() => openLuca({ kind: 'home' })}>
          <MessageCircleQuestion size={15} /><span>Luca</span>
        </button>
      ) : null}
      {snapshot.project.status === 'offline' ? (
        <div className="stale-ribbon" role="status">{t('offlineSnapshot')} · {t('lastSynced')} {snapshot.project.lastSyncedAt ? new Date(snapshot.project.lastSyncedAt).toLocaleTimeString() : t('unknown')}</div>
      ) : null}

      {activeWorkspace === 'home' ? (
        <MapViewport
          snapshot={snapshot}
          selectedAgentId={mapSelection?.kind === 'agent' ? mapSelection.agentId : null}
          selectedTaskId={mapSelection?.kind === 'task' ? mapSelection.taskId : null}
          reducedMotion={reducedMotion}
          onSelectAgent={selectAgent}
          onSelectTask={openTaskRecord}
          onSelectInspection={selectInspection}
          onClearSelection={clearMapSelection}
          onOpenTeam={() => void openTeam()}
        />
      ) : (
        <WorkspaceSurface
          active={activeWorkspace}
          snapshot={snapshot}
          reducedMotion={reducedMotion}
          userTaskKind={userTaskKind}
          recordKind={recordKind}
          taskRecordView={taskRecordView}
          failureRecordView={failureRecordView}
          selectedInspectionRunId={selectedInspectionRunId}
          decisionRecords={decisionRecords}
          decisionRecordKind={decisionRecordKind}
          decisionRecordsLoading={decisionRecordsLoading}
          timelineConversations={timelineConversations}
          timelineDecisions={timelineDecisions}
          timelineLoading={timelineLoading}
          messages={messages}
          conversationTargetAgentId={conversationTargetAgentId}
          conversationLoading={loadingConversation || loadingOlderMessages}
          conversationHasOlder={Boolean(conversationCursor)}
          activeLucaContext={lucaContext}
          canResolveAttention={bridge.capabilities.attentionResolution}
          getRuntimeInfo={getRuntimeInfo}
          readInspectionReport={readInspectionReport}
          onSelectUserTaskKind={setUserTaskKind}
          onSelectRecordKind={(kind) => {
            if (kind !== 'inspection') setSelectedInspectionRunId(null);
            if (kind === 'conversation') void openConversation();
            else if (kind === 'decision') void openDecisionHistory();
            else if (kind === 'timeline') void openTimeline();
            else setRecordKind(kind);
          }}
          onTaskRecordViewChange={setTaskRecordView}
          onFailureRecordViewChange={setFailureRecordView}
          onSelectedInspectionRunIdChange={setSelectedInspectionRunId}
          onDecisionRecordKindChange={setDecisionRecordKind}
          onOpenTimelineRecord={openTimelineRecord}
          onSelectConversationTarget={(agentId) => void openConversation(agentId)}
          onLoadOlderConversation={() => void loadOlderConversation()}
          onOpenAttention={openAttentionItem}
          onResolveAttention={resolveAttention}
          onAskLuca={openLuca}
          onOpenRoute={() => setOverlay({ kind: 'project-route' })}
          onOpenOperations={() => setOverlay({ kind: 'operations' })}
        />
      )}

      <div className="floating-instrument-layer" aria-label="Workspace instruments">
        {activeWorkspace === 'home' ? (
          <>
            <NowCardStack
              agents={snapshot.agents}
              tasks={snapshot.tasks}
              allowActive={snapshot.project.status !== 'offline'}
              onOpenTask={(taskId, agentId) => {
                setTargetAgentId(agentId);
                openTaskRecord(taskId);
              }}
              onOpenAll={() => setOverlay({ kind: 'now-list' })}
            />
            <div className="home-right-rail">
              <ProjectStatusCard project={snapshot.project} agentCount={snapshot.agents.length} />
              <AttentionCard
                items={snapshot.attention}
                agents={snapshot.agents}
                canResolve={bridge.capabilities.attentionResolution}
                onOpenItem={openAttentionItem}
                onResolve={(item, decision) => void resolveAttention(item, decision)}
                onOpenAll={() => setOverlay({ kind: 'user-task-quick-view' })}
                onOpenKind={(kind: UserActionKind) => openUserTasks(kind)}
              />
            </div>
          </>
        ) : null}
        <CommandComposer
          agents={snapshot.agents}
          online={snapshot.project.status !== 'offline'}
          sending={sending}
          value={draft}
          targetAgentId={targetAgentId}
          error={actionError}
          directSendFailure={directSendFailure}
          attachments={attachments}
          canAttach={bridge.capabilities.imageAttachments}
          onTargetChange={changeTargetAgent}
          onChange={(value) => { setDraft(value); setDirectSendFailure(null); }}
          onSend={() => void send()}
          onOpenHistory={() => void openConversation()}
          onSelectAttachments={() => void selectAttachments()}
          onRemoveAttachment={(id) => setAttachments((current) => current.filter((attachment) => attachment.id !== id))}
          onRetryDirect={() => void send()}
          onOpenCodexDraft={() => void openCodexDraft()}
        />
        <ToastStack toasts={toasts} onDismiss={(id) => setToasts((current) => current.filter((toast) => toast.id !== id))} />
        <WorkspaceDock active={activeWorkspace} counts={workspaceCounts} labels={workspaceLabels} onSelect={selectWorkspace} />
      </div>

      {lucaContext ? (
        <div className={`luca-panel-host luca-panel-host--${activeWorkspace}`}>
          <LucaPanel
            context={lucaContext}
            locale={locale}
            state={lucaState}
            onAsk={askLuca}
            onReset={() => setLucaState({ kind: 'idle' })}
            onClose={() => { setLucaContext(null); setLucaState({ kind: 'idle' }); }}
          />
        </div>
      ) : null}

      {selectedAgent ? <AgentDetail agent={selectedAgent} task={selectedAgentTask} onOpenTask={openTaskRecord} onClose={clearMapSelection} /> : null}
      {selectedTask ? <TaskDetail task={selectedTask} agents={snapshot.agents} onClose={clearMapSelection} /> : null}
      {selectedAttention ? <AttentionDetail item={selectedAttention} sourceLabel={selectedAttention.sourceAgentId ? snapshot.agents.find((agent) => agent.id === selectedAttention.sourceAgentId)?.displayName ?? selectedAttention.sourceAgentId : 'System'} canResolve={bridge.capabilities.attentionResolution} onResolve={(decision) => void resolveAttention(selectedAttention, decision)} onClose={closeOverlay} /> : null}
      {selectedInspection ? <InspectionDetail run={selectedInspection} history={snapshot.inspectionRuns} onCancel={cancelInspection} onOpenReport={openInspectionReport} onClose={clearMapSelection} /> : null}
      {overlay?.kind === 'project-route' ? <ProjectRoute project={snapshot.project} phases={snapshot.phases} onClose={closeOverlay} /> : null}
      {overlay?.kind === 'project-switcher' ? <ProjectSwitcher projects={projects} currentProjectId={snapshot.project.id} onSwitch={(id) => bridge.switchProject(id)} onOpenProject={() => bridge.requestOpenProject()} onClose={closeOverlay} /> : null}
      {overlay?.kind === 'team-management' ? (
        <TeamManagement
          agents={snapshot.agents}
          proposals={proposals}
          inspectionTemplates={snapshot.inspectionTemplates}
          inspectionRuns={snapshot.inspectionRuns}
          organization={snapshot.organization}
          onApprove={async (id) => {
            const result = await bridge.approveAgentProposal(id);
            if (result.status === 'accepted') setProposals((current) => current.filter((proposal) => proposal.id !== id));
            return result;
          }}
          onStartInspection={async (input) => {
            const result = await bridge.startInspection(input);
            if (result.status !== 'accepted') setActionError(result.reason);
            return result;
          }}
          onCancelInspection={async (runId) => {
            return cancelInspection(runId);
          }}
          onOpenInspectionReport={openInspectionReport}
          onClose={closeOverlay}
        />
      ) : null}
      {overlay?.kind === 'operations' ? <V4Operations operations={snapshot.v4Operations} getRuntimeInfo={getRuntimeInfo} onClose={closeOverlay} /> : null}
      {overlay?.kind === 'now-list' ? (
        <NowListOverlay
          agents={snapshot.agents}
          tasks={snapshot.tasks}
          onOpenTask={openTaskRecord}
          onOpenAllRecords={() => openRecords('task')}
          onClose={closeOverlay}
        />
      ) : null}
      {overlay?.kind === 'user-task-quick-view' ? (
        <UserTaskQuickView
          items={snapshot.attention}
          agents={snapshot.agents}
          onOpenAll={() => openUserTasks()}
          onClose={closeOverlay}
        />
      ) : null}
    </main>
  );
}

export function DesktopRendererApp({
  bridge,
  initialLocale,
  onStartupReady
}: {
  bridge?: OrquestaRendererBridge;
  initialLocale?: Locale;
  onStartupReady?: () => void;
}) {
  useLayoutEffect(() => {
    document.documentElement.classList.add('orquesta-root');
    return () => document.documentElement.classList.remove('orquesta-root');
  }, []);
  const rendererBridge = useMemo(() => bridge ?? createDefaultBridge(), [bridge]);
  return <I18nProvider initialLocale={resolveInitialLocale(initialLocale)}><Workspace bridge={rendererBridge} onStartupReady={onStartupReady} /></I18nProvider>;
}
