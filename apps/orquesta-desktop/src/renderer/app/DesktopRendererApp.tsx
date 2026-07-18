import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import type { AgentProposal, ComposerAttachment, ConversationMessage, OrquestaRendererBridge, ProjectSummary } from '../../contracts/bridge';
import type { AttentionUiItem, OrquestaUiSnapshot, RuntimeUiEvent } from '../../contracts/orquesta-ui';
import { DesktopRepositoryBridge } from '../../bridges/desktop-repository-bridge';
import { MockOrquestaBridge } from '../../bridges/mock-bridge';
import { fixtureKeys, type FixtureId } from '../../fixtures';
import { AttentionCard } from '../features/attention/AttentionCard';
import { AttentionHistory } from '../features/attention/AttentionHistory';
import { CommandComposer } from '../features/composer/CommandComposer';
import { ConversationHistory } from '../features/conversation/ConversationHistory';
import { AgentDetail } from '../features/details/AgentDetail';
import { TaskDetail } from '../features/details/TaskDetail';
import { I18nProvider, useI18n } from '../features/i18n/I18nProvider';
import type { Locale } from '../features/i18n/messages';
import { MapViewport } from '../features/map/MapViewport';
import { NowCardStack } from '../features/now/NowCardStack';
import { NowListOverlay } from '../features/now/NowListOverlay';
import { AdvancedOperations } from '../features/operations/AdvancedOperations';
import { ProjectRoute } from '../features/project/ProjectRoute';
import { ProjectStatusCard } from '../features/project/ProjectStatusCard';
import { ProjectSwitcher } from '../features/project/ProjectSwitcher';
import { TeamManagement } from '../features/team/TeamManagement';
import { ToastStack } from '../features/toast/ToastStack';

export type OpenOverlay =
  | { kind: 'agent'; agentId: string }
  | { kind: 'task'; taskId: string }
  | { kind: 'project-route' }
  | { kind: 'project-switcher' }
  | { kind: 'conversation' }
  | { kind: 'attention-history' }
  | { kind: 'team-management' }
  | { kind: 'operations' }
  | { kind: 'now-list' }
  | null;

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

function Workspace({ bridge }: { bridge: OrquestaRendererBridge }) {
  const { t } = useI18n();
  const reducedMotion = useReducedMotion();
  const [snapshot, setSnapshot] = useState<OrquestaUiSnapshot | null>(null);
  const [loadingError, setLoadingError] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<OpenOverlay>(null);
  const [draft, setDraft] = useState('');
  const [targetAgentId, setTargetAgentId] = useState('orchestrator');
  const [sending, setSending] = useState(false);
  const [openingProject, setOpeningProject] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<RuntimeUiEvent[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [history, setHistory] = useState<AttentionUiItem[]>([]);
  const [proposals, setProposals] = useState<AgentProposal[]>([]);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const draftProjectId = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    void bridge.getInitialSnapshot()
      .then((next) => {
        if (!alive) return;
        setSnapshot(next);
        setToasts(next.recentEvents);
      })
      .catch((error: unknown) => setLoadingError(error instanceof Error ? error.message : String(error)));
    const unsubscribe = bridge.subscribe((event) => {
      if (event.type === 'snapshot_changed') {
        setSnapshot(event.snapshot);
        setActionError(null);
        setTargetAgentId((current) => event.snapshot.agents.some((agent) => agent.id === current) ? current : 'orchestrator');
      } else {
        setToasts((current) => [...current, event.toast].slice(-6));
      }
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [bridge]);

  useEffect(() => {
    const projectId = snapshot?.project.id ?? null;
    if (!projectId || projectId === 'no-project' || draftProjectId.current === projectId) return;
    draftProjectId.current = projectId;
    setAttachments([]);
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
  const openProjects = async () => {
    try {
      setProjects(await bridge.listProjects());
      setOverlay({ kind: 'project-switcher' });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  };
  const openConversation = async () => {
    try {
      const page = await bridge.listConversation({ targetAgentId });
      setMessages(page.items);
      setOverlay({ kind: 'conversation' });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  };
  const openHistory = async () => {
    try {
      setHistory(await bridge.listAttentionHistory());
      setOverlay({ kind: 'attention-history' });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
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
    try {
      const result = await bridge.sendMessage({ targetAgentId, text: draft.trim(), attachmentIds: attachments.map((attachment) => attachment.id), selectedContextIds: [] });
      if (result.status === 'accepted') { setDraft(''); setAttachments([]); }
      else setActionError(result.reason);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
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
  const resolveAttention = async (item: AttentionUiItem, decision: string) => {
    try {
      const result = item.runtimeApproval
        ? await bridge.resolveAttentionItem({ kind: 'runtime_approval', id: item.id, decision })
        : await bridge.resolveAttentionItem({ kind: 'repository_action', id: item.id, resolution: decision });
      if (result.status !== 'accepted') setActionError(result.reason);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  };

  if (loadingError) {
    return (
      <main className="desktop-shell loading-shell" role="application" aria-label="Orquesta Desktop">
        <section><strong>{t('snapshotUnavailable')}</strong><p>{loadingError}</p><button type="button" onClick={() => window.location.reload()}>{t('retry')}</button></section>
      </main>
    );
  }
  if (!snapshot) {
    return <main className="desktop-shell loading-shell" role="application" aria-label="Orquesta Desktop"><div className="loading-mark"><i />{t('loading')}</div></main>;
  }

  if (snapshot.project.id === 'no-project') {
    const openFirstProject = async () => {
      if (openingProject) return;
      setOpeningProject(true);
      setActionError(null);
      const result = await bridge.requestOpenProject();
      setOpeningProject(false);
      if (result.status !== 'accepted') setActionError(result.reason);
    };
    return (
      <main className="desktop-shell project-onboarding-shell" role="application" aria-label="Orquesta Desktop">
        <div className="paper-grain" aria-hidden="true" />
        <span className="prototype-badge live-state-badge"><i />{t('liveState')}</span>
        <section className="project-onboarding" aria-labelledby="project-onboarding-title">
          <span className="project-onboarding__mark" aria-hidden="true"><FolderOpen size={27} /></span>
          <p>{t('orquestaDesktop')}</p>
          <h1 id="project-onboarding-title">{t('openFirstProjectTitle')}</h1>
          <div className="project-onboarding__rule" aria-hidden="true" />
          <small>{t('openFirstProjectBody')}</small>
          <button type="button" onClick={() => void openFirstProject()} disabled={openingProject}>
            <FolderOpen size={16} />{openingProject ? t('openingProject') : t('openProjectFolder')}
          </button>
          {actionError ? <p className="project-onboarding__error" role="status">{actionError}</p> : null}
        </section>
      </main>
    );
  }

  const selectedAgent = overlay?.kind === 'agent' ? snapshot.agents.find((agent) => agent.id === overlay.agentId) ?? null : null;
  const selectedTask = overlay?.kind === 'task' ? snapshot.tasks.find((task) => task.id === overlay.taskId) ?? null : null;
  const selectedAgentTask = selectedAgent?.currentTaskId ? snapshot.tasks.find((task) => task.id === selectedAgent.currentTaskId) ?? null : null;
  const selectAgent = (agentId: string) => setOverlay({ kind: 'agent', agentId });
  const selectTask = (taskId: string) => setOverlay({ kind: 'task', taskId });

  return (
    <main className={`desktop-shell project-${snapshot.project.status}`} role="application" aria-label="Orquesta Desktop">
      <div className="paper-grain" aria-hidden="true" />
      <span className={`prototype-badge${snapshot.project.isDemoData ? '' : ' live-state-badge'}`}><i />{snapshot.project.isDemoData ? t('prototype') : t('liveState')}</span>
      {snapshot.project.status === 'offline' ? (
        <div className="stale-ribbon" role="status">{t('offlineSnapshot')} · {t('lastSynced')} {snapshot.project.lastSyncedAt ? new Date(snapshot.project.lastSyncedAt).toLocaleTimeString() : t('unknown')}</div>
      ) : null}

      <MapViewport
        snapshot={snapshot}
        selectedAgentId={selectedAgent?.id ?? null}
        selectedTaskId={selectedTask?.id ?? null}
        reducedMotion={reducedMotion}
        onSelectAgent={selectAgent}
        onSelectTask={selectTask}
        onClearSelection={closeOverlay}
        onOpenTeam={() => void openTeam()}
      />

      <div className="floating-instrument-layer" aria-label="Workspace instruments">
        <NowCardStack
          agents={snapshot.agents}
          tasks={snapshot.tasks}
          allowActive={snapshot.project.status !== 'offline'}
          onOpenTask={(taskId, agentId) => {
            setTargetAgentId(agentId);
            selectTask(taskId);
          }}
          onOpenAll={() => setOverlay({ kind: 'now-list' })}
        />
        <ProjectStatusCard
          project={snapshot.project}
          phases={snapshot.phases}
          onOpenRoute={() => setOverlay({ kind: 'project-route' })}
          onSwitchProject={() => void openProjects()}
          onOpenOperations={() => setOverlay({ kind: 'operations' })}
        />
        <AttentionCard
          items={snapshot.attention}
          agents={snapshot.agents}
          canResolve={bridge.capabilities.attentionResolution}
          onOpenItem={(item) => item.taskId ? selectTask(item.taskId) : void bridge.openAttentionItem(item.id)}
          onResolve={(item, decision) => void resolveAttention(item, decision)}
          onViewHistory={() => void openHistory()}
        />
        <CommandComposer
          agents={snapshot.agents}
          online={snapshot.project.status !== 'offline'}
          sending={sending}
          value={draft}
          targetAgentId={targetAgentId}
          error={actionError}
          attachments={attachments}
          canAttach={bridge.capabilities.imageAttachments}
          onTargetChange={setTargetAgentId}
          onChange={setDraft}
          onSend={() => void send()}
          onOpenHistory={() => void openConversation()}
          onSelectAttachments={() => void selectAttachments()}
          onRemoveAttachment={(id) => setAttachments((current) => current.filter((attachment) => attachment.id !== id))}
        />
        <ToastStack toasts={toasts} onDismiss={(id) => setToasts((current) => current.filter((toast) => toast.id !== id))} />
      </div>

      {selectedAgent ? <AgentDetail agent={selectedAgent} task={selectedAgentTask} onOpenTask={selectTask} onClose={closeOverlay} /> : null}
      {selectedTask ? <TaskDetail task={selectedTask} agents={snapshot.agents} onClose={closeOverlay} /> : null}
      {overlay?.kind === 'project-route' ? <ProjectRoute project={snapshot.project} phases={snapshot.phases} onClose={closeOverlay} /> : null}
      {overlay?.kind === 'project-switcher' ? <ProjectSwitcher projects={projects} currentProjectId={snapshot.project.id} onSwitch={(id) => bridge.switchProject(id)} onOpenProject={() => bridge.requestOpenProject()} onClose={closeOverlay} /> : null}
      {overlay?.kind === 'conversation' ? <ConversationHistory targetAgentId={targetAgentId} agents={snapshot.agents} messages={messages} onClose={closeOverlay} /> : null}
      {overlay?.kind === 'attention-history' ? <AttentionHistory items={history} agents={snapshot.agents} onClose={closeOverlay} /> : null}
      {overlay?.kind === 'team-management' ? (
        <TeamManagement
          agents={snapshot.agents}
          proposals={proposals}
          onApprove={async (id) => {
            const result = await bridge.approveAgentProposal(id);
            if (result.status === 'accepted') setProposals((current) => current.filter((proposal) => proposal.id !== id));
            return result;
          }}
          onClose={closeOverlay}
        />
      ) : null}
      {overlay?.kind === 'operations' ? <AdvancedOperations onClose={closeOverlay} /> : null}
      {overlay?.kind === 'now-list' ? <NowListOverlay agents={snapshot.agents} tasks={snapshot.tasks} onOpenTask={selectTask} onClose={closeOverlay} /> : null}
    </main>
  );
}

export function DesktopRendererApp({ bridge, initialLocale }: { bridge?: OrquestaRendererBridge; initialLocale?: Locale }) {
  useLayoutEffect(() => {
    document.documentElement.classList.add('orquesta-root');
    return () => document.documentElement.classList.remove('orquesta-root');
  }, []);
  const rendererBridge = useMemo(() => bridge ?? createDefaultBridge(), [bridge]);
  return <I18nProvider initialLocale={resolveInitialLocale(initialLocale)}><Workspace bridge={rendererBridge} /></I18nProvider>;
}
