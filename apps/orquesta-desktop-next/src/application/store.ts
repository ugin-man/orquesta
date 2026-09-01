import type {
  ComposerAttachment,
  AgentExecution,
  ConversationActivityCursor,
  ConversationCursor,
  ConversationReadCheckpoint,
  DesktopEvent,
  DispatchRecovery,
  NativeSettings,
  ProjectSummary,
  ProjectedPendingRequest,
  RendererAuthority,
  RuntimeAuthority,
  RuntimeStatus,
  WorkspaceSnapshot,
  BusinessSourceCursor,
  BusinessWorkOrderSummary,
  WorkflowCatalog,
  WorkflowCheck,
  VoiceComposerBinding,
  VoiceOperationStatus,
  VoiceStatus,
} from '../domain/models';
import { runtimeAuthorityFrom, sameRendererAuthority, sameRuntimeAuthority } from '../domain/models';
import { fitsMessageTextPolicy, isRecord, parseWorkflowCatalog } from '../domain/validation';
import {
  DispatchSendError,
  isAbortError,
  type DesktopClient,
  type StartInspectionInput,
  type VoiceTranscriptionBindingInput,
} from '../ports/desktop-client';
import {
  executionFromProjection,
  latestActiveTurn,
  mergeConversationActivities,
} from './reducers/activity-reducer';
import { resolvedAttentionItems } from './reducers/attention-reducer';
import { mergeConversationMessages } from './reducers/conversation-reducer';
import {
  sameRuntimeIncarnation,
  sameRuntimeStatus,
  statusChanged,
} from './reducers/project-reducer';
import {
  projectLifecycleAllowsUserMutation,
  projectLifecycleIsTransitioning,
  selectAgentExists,
  selectCurrentUserOrchestratorId,
  selectProject,
  selectProjectLifecycle,
  selectSelectedExecution,
} from './selectors';
import {
  createInitialApplicationState,
  type ApplicationPhase,
  type ApplicationState,
  type VoiceAgentComposerCapture,
  type VoiceComposerCapture,
  type WorkspaceRoute,
} from './state';
import { WorkspaceLoadCoordinator } from './workspace-load-coordinator';
import { UserMessageError, userMessage, type UserMessage } from './user-message';

interface OperationGuard {
  scope: 'runtime_preparation' | 'runtime_read' | 'workspace_side_load' | 'ready_operation';
  epoch: number;
  renderer: RendererAuthority;
  authority: RuntimeAuthority;
  runtimeGeneration: string;
  statusRevision: number;
}

type ProjectPreparationOutcome = 'ready' | 'blocked' | 'failed' | 'stale';
type ActivationFinishOutcome = 'committed' | Exclude<ProjectPreparationOutcome, 'ready'>;

function sameProjectPreparationOwner(left: OperationGuard, right: OperationGuard): boolean {
  return left.runtimeGeneration === right.runtimeGeneration
    && sameRendererAuthority(left.renderer, right.renderer)
    && sameRuntimeAuthority(left.authority, right.authority);
}

function appendVoiceTranscript(draft: string, transcript: string): string | null {
  const next = draft.trimEnd() ? `${draft.trimEnd()} ${transcript}` : transcript;
  return fitsMessageTextPolicy(next) ? next : null;
}

interface ComposerDraftRecord {
  text: string;
  revision: number;
}

interface ProjectEntryIntent {
  entryIntentRef: string;
  kind: 'starter' | 'open_existing' | 'recent';
  operationRef: string | null;
  projectName: string | null;
  draftText: string;
  draftRevision: number;
  targetDraftRevision: number | null;
  sendAfterActivation: boolean;
  phase: 'captured' | 'applied' | 'dispatch_started' | 'consumed' | 'retired';
}

interface VoiceTerminalWatcher {
  operationRef: string;
  renderer: RendererAuthority;
  epoch: number;
  controller: AbortController;
}

interface InsertedVoiceClaim {
  binding: VoiceComposerBinding;
  ackTarget: { projectId: string; agentId: string } | null;
  draftRevision: number;
  consumedByUser: boolean;
}

const VOICE_STATUS_WATCH_INITIAL_DELAY_MS = 250;
const VOICE_STATUS_WATCH_INTERVAL_MS = 1_000;
// Native transcription has a 150-second deadline. Leave room for its bounded
// containment shutdown and terminal-state persistence before the final read.
const VOICE_STATUS_WATCH_DEADLINE_MS = 165_000;
const LAST_WORK_AGENT_DRAIN_TIMEOUT_MS = 5_000;
type HistoryRefreshMode = 'reset' | 'preserve' | 'summary';
const HISTORY_REFRESH_PRIORITY: Record<HistoryRefreshMode, number> = {
  summary: 0,
  preserve: 1,
  reset: 2,
};

function waitForVoiceStatusPoll(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, delayMs);
    const onAbort = () => {
      window.clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export interface ProjectEntryOptions {
  sendDraft?: boolean;
}

export type ComposerDraftCapture = VoiceAgentComposerCapture;

function displayError(error: unknown): UserMessage {
  if (error instanceof UserMessageError) return error.userMessage;
  const code = isRecord(error) && typeof error.code === 'string'
    ? error.code
    : error instanceof Error && typeof (error as Error & { code?: unknown }).code === 'string'
      ? (error as Error & { code: string }).code
      : '';
  if (code === 'project_name_invalid') {
    return userMessage('project_name_invalid');
  }
  if (code === 'project_metadata_directory_selected') {
    return userMessage('project_metadata_directory_selected');
  }
  if (code === 'project_recent_forget_active') {
    return userMessage('project_recent_forget_active');
  }
  if (code.startsWith('dispatch_')) {
    return userMessage('dispatch_state_unknown');
  }
  if (code.startsWith('runtime_') || code.includes('authority') || code.includes('generation')) {
    return userMessage('runtime_changed');
  }
  if (code.startsWith('voice_')) {
    return userMessage('voice_failed');
  }
  if (code === 'attachment_draft_quota' || code === 'attachment_selection_limit') {
    return userMessage('attachment_batch_rejected');
  }
  if (code === 'attachment_preview_too_large') {
    return userMessage('attachment_preview_too_large');
  }
  if (code.startsWith('attachment_')) {
    return userMessage('attachment_failed');
  }
  return userMessage('generic_failure');
}

function isOutcomeUnknownError(error: unknown): boolean {
  if (isRecord(error)) return error.outcomeUnknown === true;
  return error instanceof Error
    && (error as Error & { outcomeUnknown?: unknown }).outcomeUnknown === true;
}

const STARTER_NAME_VALIDATION_ERROR_CODES = new Set([
  'project_name_invalid',
]);

function isStarterNameValidationError(error: unknown): boolean {
  return isRecord(error)
    && typeof error.code === 'string'
    && STARTER_NAME_VALIDATION_ERROR_CODES.has(error.code);
}

function withoutRecordKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}

function mergeProjectedPendingRequests(
  existing: ProjectedPendingRequest[],
  incoming: ProjectedPendingRequest[],
): ProjectedPendingRequest[] {
  const byKey = new Map(existing.map((request) => [request.requestKey, request]));
  for (const request of incoming) byKey.set(request.requestKey, request);
  return [...byKey.values()];
}

function executionHasActiveTurn(execution: AgentExecution | null | undefined): boolean {
  return Boolean(execution?.threadId && execution.turnId
    && ['accepted', 'working', 'stopping'].includes(execution.phase));
}

function draftKey(projectId: string, agentId: string): string {
  return `${projectId.length}:${projectId}${agentId.length}:${agentId}`;
}

function createSelectionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') {
    throw new Error('Secure UUID generation is unavailable.');
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function activitySummary(value: string): string {
  const compact = value.replace(/\s+/gu, ' ').trim();
  return compact.length <= 160 ? compact : `${compact.slice(0, 157)}…`;
}

function eventText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function eventId(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function withRegisteredProjectTitle(
  snapshot: WorkspaceSnapshot,
  projects: ProjectSummary[],
): WorkspaceSnapshot {
  const registered = projects.find((project) => project.id === snapshot.project.id);
  if (!registered || registered.title === snapshot.project.title) return snapshot;
  return {
    ...snapshot,
    project: { ...snapshot.project, title: registered.title },
  };
}

function preferredWorkAgentId(snapshot: WorkspaceSnapshot, projects: ProjectSummary[]): string | null {
  const hint = projects.find((project) => project.id === snapshot.project.id)?.lastWorkAgentId ?? null;
  if (hint && snapshot.agents.some((agent) => agent.id === hint)) return hint;
  const orchestratorAgentId = selectCurrentUserOrchestratorId(snapshot);
  return orchestratorAgentId;
}

async function exactDraftSha256(draft: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new UserMessageError(userMessage('voice_start_failed'));
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(draft));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function statusBindingFor(input: VoiceTranscriptionBindingInput): VoiceComposerBinding {
  return input.target === 'agent'
    ? {
        state: 'agent', projectId: input.projectId, agentId: input.agentId,
        draftSha256: input.draftSha256,
      }
    : { state: 'launcher', draftSha256: input.draftSha256 };
}

function sameVoiceBinding(left: VoiceComposerBinding, right: VoiceComposerBinding): boolean {
  if (left.state !== right.state) return false;
  if (left.state === 'legacy_unbound' || right.state === 'legacy_unbound') {
    return left.state === 'legacy_unbound' && right.state === 'legacy_unbound';
  }
  if (left.draftSha256 !== right.draftSha256) return false;
  if (left.state === 'launcher' || right.state === 'launcher') {
    return left.state === 'launcher' && right.state === 'launcher';
  }
  return left.projectId === right.projectId && left.agentId === right.agentId;
}

export class ApplicationStore {
  readonly #client: DesktopClient;
  readonly #observedAt: () => string;
  readonly #selectionId: () => string;
  readonly #listeners = new Set<() => void>();
  readonly #drafts = new Map<string, ComposerDraftRecord>();
  readonly #supportDrafts = new Map<string, string>();
  readonly #pendingSelectionCleanup = new Set<string>();
  readonly #voiceDraftCaptures = new Map<string, VoiceComposerCapture>();
  // Same-lifetime consumption claim only. Native VoiceOperationRecord remains
  // the durable transcript authority. The exact draft revision prevents a
  // later unrelated send from acknowledging an inserted transcript.
  readonly #voiceInsertedUnacked = new Map<string, InsertedVoiceClaim>();
  readonly #voiceSettledUnacked = new Set<string>();
  readonly #voiceAckPending = new Set<string>();
  readonly #bootstrapController = new AbortController();
  #voiceTerminalWatcher: VoiceTerminalWatcher | null = null;
  #voiceFinalizingOperationRef: string | null = null;
  #state: ApplicationState = createInitialApplicationState();
  #unsubscribeClient: (() => void) | null = null;
  #initializePromise: Promise<void> | null = null;
  #disposing = false;
  #disposed = false;
  #rendererEpoch = 0;
  #epoch = 0;
  #selectionTicket = 0;
  #conversationTicket = 0;
  #historyTicket = 0;
  #historyRefreshRequested: HistoryRefreshMode | null = null;
  readonly #userSignalBaselineParts = new Set<'conversation' | 'summaries'>();
  #supportConversationTicket = 0;
  #snapshotTicket = 0;
  #projectPreparationRun: {
    guard: OperationGuard;
    promise: Promise<ProjectPreparationOutcome>;
    sideLoadsStarted: boolean;
  } | null = null;
  #unexpectedStopAttempt = 0;
  #unexpectedStopPending = 0;
  #launcherDraft = '';
  #launcherDraftRevision = 0;
  #projectEntryIntent: ProjectEntryIntent | null = null;
  #lastWorkAgentWriteChain: Promise<void> = Promise.resolve();
  readonly #workspaceLoads = new WorkspaceLoadCoordinator();
  readonly #conversationCheckpoints = new Map<string, ConversationReadCheckpoint & {
    olderCursor: ConversationCursor | null;
    activityOlderCursor: ConversationActivityCursor | null;
    pendingRequestOlderCursor: string | null;
    loadedOlder: boolean;
  }>();

  constructor(
    client: DesktopClient,
    dependencies: {
      observedAt?: () => string;
      selectionId?: () => string;
    } = {},
  ) {
    this.#client = client;
    this.#observedAt = dependencies.observedAt ?? (() => new Date().toISOString());
    this.#selectionId = dependencies.selectionId ?? createSelectionId;
  }

  getState = (): ApplicationState => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    if (this.#disposed) return () => undefined;
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  initialize(): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    if (this.#initializePromise) return this.#initializePromise;
    this.#unsubscribeClient = this.#client.subscribe((event) => this.#onClientEvent(event));
    this.#initializePromise = this.#initialize();
    return this.#initializePromise;
  }

  async #initialize(): Promise<void> {
    try {
      const bootstrap = await this.#client.bootstrap(this.#bootstrapController.signal);
      if (this.#disposed) return;
      const rendererCoherent = !bootstrap.status.rendererSessionId || sameRendererAuthority(bootstrap.renderer, {
        rendererSessionId: bootstrap.status.rendererSessionId,
        rendererGeneration: bootstrap.status.rendererGeneration ?? -1,
      });
      const runtimeAuthority = rendererCoherent ? runtimeAuthorityFrom(bootstrap.status) : null;
      const runtimeSnapshot = runtimeAuthority && bootstrap.snapshot?.project.id === runtimeAuthority.projectId
        ? bootstrap.snapshot : null;
      const snapshot = runtimeSnapshot
        ? withRegisteredProjectTitle(runtimeSnapshot, bootstrap.projects)
        : null;
      const selectedAgentId = snapshot ? preferredWorkAgentId(snapshot, bootstrap.projects) : null;
      this.#rendererEpoch += 1;
      this.#advanceEpoch();
      this.#state = {
        ...createInitialApplicationState(),
        projects: bootstrap.projects,
        starterCreationRecoveries: bootstrap.starterCreationRecoveries,
        // The registry remembers the last-opened project, but only a live runtime authority owns
        // the workspace. Treating a stopped registry selection as current disables the only row
        // that can reactivate it after an app restart.
        selectedProjectId: runtimeAuthority?.projectId ?? null,
        snapshot,
        runtimeStatus: bootstrap.status,
        rendererAuthority: bootstrap.renderer,
        settings: bootstrap.settings,
        runtimeAuthority,
        selectedAgentId,
        draft: this.#readDraft(runtimeAuthority?.projectId ?? null, selectedAgentId),
        dispatchRecovery: bootstrap.dispatchRecovery?.projectId === runtimeAuthority?.projectId
          ? bootstrap.dispatchRecovery
          : null,
        voiceStatus: bootstrap.voiceStatus,
        phase: runtimeAuthority ? 'workspace'
          : bootstrap.status.lifecycle === 'Starting' || bootstrap.status.lifecycle === 'Stopping' ? 'booting'
            : bootstrap.status.lifecycle === 'Failed' ? 'failed' : 'launcher',
      };
      this.#snapshotTicket += 1;
      this.#notify();
      this.#reconcileVoiceOperations(bootstrap.voiceStatus);
      bootstrap.pendingAttachmentSelectionIds.forEach((selectionId) => this.#pendingSelectionCleanup.add(selectionId));
      void this.#retryPendingSelectionCleanup(runtimeAuthority);
      if (runtimeAuthority) {
        const guard = this.#runtimeGuard();
        if (guard) {
          const outcome = await this.#prepareSelectedProject(guard);
          if (outcome !== 'ready' || !this.#guardCurrent(guard)) return;
        }
      }
    } catch (error) {
      if (this.#disposed || isAbortError(error)) return;
      this.#set({ phase: 'failed', error: displayError(error) });
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed || this.#disposing) return;
    this.#disposing = true;
    const hintDrained = await new Promise<boolean>((resolve) => {
      const timer = globalThis.setTimeout(() => resolve(false), LAST_WORK_AGENT_DRAIN_TIMEOUT_MS);
      void this.#lastWorkAgentWriteChain.then(
        () => { globalThis.clearTimeout(timer); resolve(true); },
        () => { globalThis.clearTimeout(timer); resolve(true); },
      );
    });
    if (!hintDrained) {
      this.#set({ error: userMessage('last_agent_save_failed') });
    }
    this.#disposed = true;
    this.#rendererEpoch += 1;
    this.#advanceEpoch();
    this.#selectionTicket += 1;
    this.#snapshotTicket += 1;
    this.#bootstrapController.abort();
    this.#unsubscribeClient?.();
    this.#unsubscribeClient = null;
    this.#listeners.clear();
    this.#voiceDraftCaptures.clear();
    this.#voiceInsertedUnacked.clear();
    this.#voiceSettledUnacked.clear();
    this.#voiceAckPending.clear();
    await this.#client.dispose();
  }

  setRoute(route: WorkspaceRoute): void {
    if (route !== 'work' && selectProjectLifecycle(this.#state) !== 'ready') return;
    this.#set({ route });
    if (route === 'history' && this.#state.runtimeAuthority) void this.loadHistoryIndex();
  }

  clearError(): void {
    this.#set({ error: null, notice: null });
  }

  async refreshProjects(): Promise<void> {
    const renderer = this.#state.rendererAuthority;
    if (!renderer) return;
    const epoch = this.#rendererEpoch;
    try {
      const projects = await this.#client.listProjects(renderer);
      if (!this.#rendererGuardCurrent(renderer, epoch)) return;
      this.#set({ projects });
    } catch (error) {
      if (this.#rendererGuardCurrent(renderer, epoch)) this.#set({ error: displayError(error) });
    }
  }

  async forgetRecentProject(projectId: string): Promise<boolean> {
    const renderer = this.#state.rendererAuthority;
    const project = this.#state.projects.find((candidate) => candidate.id === projectId);
    if (!renderer || !project || this.#state.runtimeAuthority?.projectId === projectId
      || this.#state.addingProject) return false;
    const epoch = this.#rendererEpoch;
    try {
      const projects = await this.#client.forgetRecentProject(renderer, projectId);
      if (!this.#rendererGuardCurrent(renderer, epoch)) return false;
      this.#set({
        projects,
        selectedProjectId: this.#state.selectedProjectId === projectId ? null : this.#state.selectedProjectId,
        error: null,
      });
      return true;
    } catch (error) {
      if (this.#rendererGuardCurrent(renderer, epoch)) this.#set({ error: displayError(error) });
      return false;
    }
  }

  async openProjectFolder(options: ProjectEntryOptions = {}): Promise<boolean> {
    const renderer = this.#state.rendererAuthority;
    if (!renderer || this.#state.addingProject
      || projectLifecycleIsTransitioning(selectProjectLifecycle(this.#state))
      || this.#state.voiceCapturePhase !== 'idle') return false;
    const intent = this.#beginProjectEntryIntent('open_existing', options.sendDraft === true, null);
    const epoch = this.#rendererEpoch;
    this.#set({ addingProject: true, error: null });
    try {
      const project = await this.#client.openProjectFolder(renderer);
      if (!this.#rendererGuardCurrent(renderer, epoch)) return false;
      if (!project) {
        this.retireProjectEntryIntent(intent.entryIntentRef);
        this.#set({ addingProject: false });
        return false;
      }
      const projects = [project, ...this.#state.projects.filter((candidate) => candidate.id !== project.id)];
      this.#set({ projects, addingProject: false });
      return await this.selectProject(project.id, options, intent);
    } catch (error) {
      if (this.#rendererGuardCurrent(renderer, epoch)) this.#set({ addingProject: false, error: displayError(error) });
      return false;
    }
  }

  async updateSettings(
    input: Omit<NativeSettings, 'schemaVersion' | 'revision'>,
  ): Promise<boolean> {
    const renderer = this.#state.rendererAuthority;
    const current = this.#state.settings;
    if (!renderer || !current || this.#state.settingsUpdating) return false;
    const epoch = this.#rendererEpoch;
    this.#set({ settingsUpdating: true, error: null });
    try {
      const saved = await this.#client.updateSettings(renderer, {
        ...input,
        expectedRevision: current.revision,
      });
      if (!this.#rendererGuardCurrent(renderer, epoch)) return false;
      if (saved.revision !== current.revision + 1) throw new Error('Settings revision did not advance exactly once.');
      this.#set({ settings: saved, settingsUpdating: false });
      return true;
    } catch (error) {
      if (this.#rendererGuardCurrent(renderer, epoch)) {
        this.#set({ settingsUpdating: false, error: displayError(error) });
      }
      return false;
    }
  }

  async createStarterProject(projectName: string, options: ProjectEntryOptions = {}): Promise<boolean> {
    const renderer = this.#state.rendererAuthority;
    const normalizedName = projectName.trim();
    if (!renderer || !normalizedName || this.#state.addingProject
      || projectLifecycleIsTransitioning(selectProjectLifecycle(this.#state))
      || this.#state.voiceCapturePhase !== 'idle') return false;
    const intent = this.#beginProjectEntryIntent('starter', options.sendDraft === true, normalizedName);
    const epoch = this.#rendererEpoch;
    this.#set({ addingProject: true, error: null });
    try {
      const project = await this.#client.createStarterProject(renderer, {
        operationRef: intent.operationRef!, projectName: normalizedName,
      });
      if (!this.#rendererGuardCurrent(renderer, epoch)) return false;
      if (!project) {
        this.retireProjectEntryIntent(intent.entryIntentRef);
        this.#set({ addingProject: false });
        return false;
      }
      const projects = [project, ...this.#state.projects.filter((candidate) => candidate.id !== project.id)];
      this.#set({ projects, addingProject: false });
      return await this.selectProject(project.id, options, intent);
    } catch (error) {
      if (!this.#rendererGuardCurrent(renderer, epoch)) return false;
      if (isOutcomeUnknownError(error)) {
        try {
          const retried = await this.#client.createStarterProject(renderer, {
            operationRef: intent.operationRef!, projectName: normalizedName,
          });
          if (!this.#rendererGuardCurrent(renderer, epoch)) return false;
          if (retried) {
            const projects = [retried, ...this.#state.projects.filter((candidate) => candidate.id !== retried.id)];
            this.#set({ projects, addingProject: false });
            return await this.selectProject(retried.id, options, intent);
          }
          this.retireProjectEntryIntent(intent.entryIntentRef);
          this.#set({ addingProject: false });
          return false;
        } catch (retryError) {
          if (!isOutcomeUnknownError(retryError)) {
            if (isStarterNameValidationError(retryError)) {
              this.retireProjectEntryIntent(intent.entryIntentRef);
            }
            this.#set({ addingProject: false, error: displayError(retryError) });
            return false;
          }
        }
        try {
          const projects = await this.#client.listProjects(renderer);
          if (!this.#rendererGuardCurrent(renderer, epoch)) return false;
          this.#set({ projects });
          const reconciled = projects.find((candidate) => candidate.creationOperationRef === intent.operationRef);
          if (reconciled) {
            this.#set({ addingProject: false });
            return await this.selectProject(reconciled.id, options, intent);
          }
        } catch { /* retry keeps the exact operationRef in the Store-owned intent */ }
      }
      if (isStarterNameValidationError(error)) {
        this.retireProjectEntryIntent(intent.entryIntentRef);
      }
      this.#set({ addingProject: false, error: displayError(error) });
      return false;
    }
  }

  retireProjectEntryIntent(entryIntentRef?: string): void {
    const intent = this.#projectEntryIntent;
    if (!intent || (entryIntentRef && intent.entryIntentRef !== entryIntentRef)) return;
    if (intent.phase !== 'consumed') intent.phase = 'retired';
    this.#projectEntryIntent = null;
  }

  async selectProject(
    projectId: string,
    options: ProjectEntryOptions = {},
    suppliedIntent: ProjectEntryIntent | null = null,
  ): Promise<boolean> {
    const renderer = this.#state.rendererAuthority;
    const project = selectProject(this.#state, projectId);
    const sameActiveProject = this.#state.runtimeAuthority?.projectId === projectId
      && this.#state.runtimeStatus?.lifecycle === 'Ready';
    if (!renderer || !project || (!sameActiveProject && projectLifecycleIsTransitioning(selectProjectLifecycle(this.#state)))
      || this.#state.voiceCapturePhase !== 'idle') return false;
    const entryIntent = suppliedIntent
      ?? this.#beginProjectEntryIntent('recent', options.sendDraft === true, null);
    if (sameActiveProject) {
      if (selectProjectLifecycle(this.#state) !== 'ready') {
        const guard = this.#runtimeGuard();
        if (!guard || await this.#prepareSelectedProject(guard) !== 'ready') return false;
      }
      return this.#applyProjectEntryIntent(entryIntent, projectId, this.#selectionTicket);
    }
    const previousAuthority = this.#state.runtimeAuthority;
    const previousStatus = this.#state.runtimeStatus;
    this.#retireAttachments(this.#state.runtimeAuthority, this.#state.attachments);
    const ticket = ++this.#selectionTicket;
    this.#advanceEpoch();
    this.#snapshotTicket += 1;
    this.#resetUserSignalsBaseline();
    this.#set({
      phase: 'activating', selectedProjectId: projectId, snapshot: null, runtimeAuthority: null,
      selectedAgentId: null, messages: [], activities: [], attachments: [],
      attachmentSelectionPending: false, attachmentRemovalPending: false,
      actionPendingId: null,
      sending: false, conversationAction: null, turnMutationAcceptedTurnKey: null, turnMutationOutcomeUnknownTurnKey: null,
      conversationLoading: false, conversationOlderCursor: null,
      conversationOlderActivityCursor: null, conversationOlderPendingRequestCursor: null,
      conversationOlderLoading: false, error: null, notice: null,
      historyConversations: [], userSignalsBaselineReady: false,
      historyIndexCursor: null, historySelectedAgentId: null,
      historyQuery: '', historyMessages: [], historyCursor: null,
      historyLoading: false, historyOlderLoading: false,
      executions: {},
      attentionHistory: [],
      projectedPendingRequests: [],
      supportAgentId: null, supportMessages: [], supportConversationLoading: false,
      supportDraft: '', supportSending: false,
      businessWorkOrders: [], businessCursor: null, businessNextAfterKey: null,
      businessLoading: false, businessRecoveryRequired: false,
      workflowCatalog: null, workflowLoading: false,
      projectStartPending: false,
      projectBootstrap: null,
      dispatchRecovery: null,
      recoveryPending: false,
    });
    try {
      let expectedStatusRevision = previousStatus?.statusRevision ?? 0;
      if (previousAuthority && previousStatus) {
        const stopped = await this.#client.stopRuntime(previousAuthority, previousStatus.statusRevision);
        if (this.#disposed || ticket !== this.#selectionTicket) return false;
        this.#acceptStatus(stopped, { selectedProjectId: projectId, suppressUnexpectedStop: true });
        if (stopped.lifecycle !== 'Stopped') throw new Error('The current project did not stop before switching.');
        expectedStatusRevision = stopped.statusRevision;
      }
      const status = await this.#client.activateProject(project, renderer, expectedStatusRevision);
      if (this.#disposed || ticket !== this.#selectionTicket) return false;
      this.#acceptStatus(status, { selectedProjectId: projectId, suppressUnexpectedStop: true });
      const finish = await this.#finishActivation(projectId, renderer, ticket);
      if (finish === 'blocked' || finish === 'failed') return false;
      if (finish !== 'committed') {
        throw new Error('Runtime activation did not commit the selected project authority.');
      }
      return await this.#applyProjectEntryIntent(entryIntent, projectId, ticket);
    } catch (error) {
      if (this.#disposed || ticket !== this.#selectionTicket) return false;
      const finish = await this.#finishActivation(projectId, renderer, ticket);
      if (finish === 'committed') {
        return await this.#applyProjectEntryIntent(entryIntent, projectId, ticket);
      }
      if (finish === 'blocked' || finish === 'failed') return false;
      // Reconcile response-loss without invoking the runtime. The observed status owns the screen.
      try {
        const current = await this.#client.refreshStatus(renderer);
        if (this.#disposed || ticket !== this.#selectionTicket) return false;
        this.#acceptStatus(current, { selectedProjectId: projectId, suppressUnexpectedStop: true });
        const reconciled = await this.#finishActivation(projectId, renderer, ticket);
        if (reconciled === 'committed') {
          return await this.#applyProjectEntryIntent(entryIntent, projectId, ticket);
        }
        if (reconciled === 'blocked' || reconciled === 'failed') return false;
      } catch { /* the original activation error remains authoritative */ }
      if ((this.#state.runtimeStatus?.statusRevision ?? 0) > (previousStatus?.statusRevision ?? 0)) {
        this.#set({ error: displayError(error) });
        return false;
      }
      this.#set({ phase: 'launcher', runtimeAuthority: null, snapshot: null, error: displayError(error) });
      return false;
    }
  }

  async #prepareSelectedProject(guard: OperationGuard): Promise<ProjectPreparationOutcome> {
    let run = this.#projectPreparationRun;
    if (!run || !sameProjectPreparationOwner(run.guard, guard)) {
      if (!this.#guardCurrent(guard)) return 'stale';
      const promise = (async () => {
      this.#set({ projectStartPending: true, projectBootstrap: null, error: null });
      try {
        const hydrated = this.#state.snapshot?.project.id === guard.authority.projectId
          || await this.#refreshSnapshot(guard);
        if (!this.#guardCurrent(guard)) return 'stale' as const;
        if (!hydrated) throw new Error('The selected project snapshot could not be prepared.');
        const result = await this.#client.bootstrapProject(guard.authority);
        if (!this.#guardCurrent(guard)) return 'stale' as const;
        if (result.status !== 'ready') {
          this.#set({ projectStartPending: false, projectBootstrap: result, error: null, notice: null });
          return 'blocked' as const;
        }
        if (!result.noWrite) {
          const refreshed = await this.#refreshSnapshot(guard);
          if (!this.#guardCurrent(guard)) return 'stale' as const;
          if (!refreshed) throw new Error('The prepared project snapshot could not be committed.');
        }
        this.#set({
          phase: 'workspace',
          ...(result.noWrite ? {} : { route: 'work' as const }),
          projectStartPending: false,
          projectBootstrap: result,
          notice: null,
        });
        if (!this.#state.snapshot) throw new Error('The prepared project snapshot is unavailable.');
        return 'ready' as const;
      } catch (error) {
        if (this.#guardCurrent(guard)) this.#set({ projectStartPending: false, projectBootstrap: null, error: displayError(error) });
        return this.#guardCurrent(guard) ? 'failed' as const : 'stale' as const;
      }
      })();
      run = { guard, promise, sideLoadsStarted: false };
      this.#projectPreparationRun = run;
    }
    const outcome = await run.promise;
    if (outcome === 'ready' && this.#guardCurrent(run.guard) && !run.sideLoadsStarted) {
      run.sideLoadsStarted = true;
      this.#startWorkspaceSideLoads(run.guard);
    }
    if (this.#projectPreparationRun === run) this.#projectPreparationRun = null;
    return outcome;
  }

  async #finishActivation(projectId: string, renderer: RendererAuthority, ticket: number): Promise<ActivationFinishOutcome> {
    if (this.#disposed || ticket !== this.#selectionTicket) return 'stale';
    const authority = this.#state.runtimeAuthority;
    if (!authority || authority.projectId !== projectId || !sameRendererAuthority(renderer, authority)) return 'stale';
    const selectedAgentId = this.#state.selectedAgentId;
    this.#set({
      phase: 'workspace', runtimeAuthority: authority, selectedProjectId: projectId,
      draft: this.#readDraft(projectId, selectedAgentId), error: null,
    });
    const guard = this.#runtimeGuard();
    if (!guard) return 'stale';
    try {
      const recovery = await this.#client.readDispatchRecovery(renderer);
      if (!this.#guardCurrent(guard) || ticket !== this.#selectionTicket) return 'stale';
      if (recovery && recovery.projectId !== projectId) {
        throw new Error('The selected project returned an unrelated send recovery record.');
      }
      this.#set({ dispatchRecovery: recovery, recoveryPending: false });
    } catch (error) {
      if (!this.#guardCurrent(guard) || ticket !== this.#selectionTicket) return 'stale';
      this.#set({ projectStartPending: false, error: displayError(error) });
      return 'failed';
    }
    const preparationOutcome = await this.#prepareSelectedProject(guard);
    if (preparationOutcome !== 'ready') return preparationOutcome;
    const readySnapshot = this.#state.snapshot;
    const orchestratorAgentId = readySnapshot ? selectCurrentUserOrchestratorId(readySnapshot) : null;
    const workAgentId = readySnapshot ? preferredWorkAgentId(readySnapshot, this.#state.projects) : null;
    const ready = this.#state.runtimeStatus?.lifecycle === 'Ready'
      && this.#state.runtimeAuthority?.projectId === projectId
      && this.#state.projectBootstrap?.status === 'ready'
      && Boolean(orchestratorAgentId)
      && Boolean(workAgentId);
    if (!ready || !workAgentId) return 'stale';
    if (this.#state.selectedAgentId !== workAgentId) {
      this.#selectAgentLocally(workAgentId);
      void this.loadConversation(workAgentId);
    }
    return this.#state.selectedAgentId === workAgentId ? 'committed' : 'stale';
  }

  async stopRuntime(): Promise<void> {
    const authority = this.#state.runtimeAuthority;
    const status = this.#state.runtimeStatus;
    if (!authority || !status || this.#state.phase === 'stopping') return;
    this.#retireAttachments(authority, this.#state.attachments);
    const ticket = ++this.#selectionTicket;
    this.#advanceEpoch();
    this.#snapshotTicket += 1;
    this.#set({
      phase: 'stopping', sending: false, conversationAction: null,
      turnMutationAcceptedTurnKey: null, turnMutationOutcomeUnknownTurnKey: null,
      actionPendingId: null, attachments: [], attachmentSelectionPending: false,
      attachmentRemovalPending: false, error: null,
    });
    try {
      const stopped = await this.#client.stopRuntime(authority, status.statusRevision);
      if (this.#disposed || ticket !== this.#selectionTicket) return;
      this.#acceptStatus(stopped, { suppressUnexpectedStop: true });
      if (this.#state.runtimeStatus?.lifecycle !== 'Stopped') throw new Error('Runtime did not reach the stopped state.');
      this.#resetUserSignalsBaseline();
      this.#set({
        phase: 'launcher', selectedProjectId: null, snapshot: null, runtimeAuthority: null,
        selectedAgentId: null, messages: [], activities: [], draft: this.#launcherDraft, conversationLoading: false,
        conversationOlderCursor: null, conversationOlderActivityCursor: null,
        conversationOlderPendingRequestCursor: null, conversationOlderLoading: false,
        historyConversations: [], userSignalsBaselineReady: false,
        historyIndexCursor: null, historySelectedAgentId: null,
        historyQuery: '', historyMessages: [], historyCursor: null,
        historyLoading: false, historyOlderLoading: false,
        executions: {},
        attentionHistory: [],
        projectedPendingRequests: [],
        supportAgentId: null, supportMessages: [], supportConversationLoading: false, supportDraft: '', supportSending: false,
        projectStartPending: false, projectBootstrap: null,
      });
    } catch (error) {
      if (this.#disposed || ticket !== this.#selectionTicket) return;
      if (this.#state.runtimeStatus?.lifecycle === 'Stopped') {
        this.#resetUserSignalsBaseline();
        this.#set({
          phase: 'launcher', selectedProjectId: null, snapshot: null, runtimeAuthority: null,
          selectedAgentId: null, messages: [], activities: [], draft: this.#launcherDraft, conversationLoading: false,
          conversationOlderCursor: null, conversationOlderActivityCursor: null,
          conversationOlderPendingRequestCursor: null, conversationOlderLoading: false, error: null,
          historyConversations: [], userSignalsBaselineReady: false,
          historyIndexCursor: null, historySelectedAgentId: null,
          historyQuery: '', historyMessages: [], historyCursor: null,
          historyLoading: false, historyOlderLoading: false,
          executions: {},
          attentionHistory: [],
          projectedPendingRequests: [],
          supportAgentId: null, supportMessages: [], supportConversationLoading: false, supportDraft: '', supportSending: false,
          projectStartPending: false, projectBootstrap: null,
        });
        return;
      }
      // Reconcile before presenting a failure; the stop response itself may have been lost.
      try {
        const current = await this.#client.refreshStatus(authority);
        if (this.#disposed || ticket !== this.#selectionTicket) return;
        this.#acceptStatus(current, { suppressUnexpectedStop: true });
        if (current.lifecycle === 'Stopped') {
          this.#resetUserSignalsBaseline();
          this.#set({
            phase: 'launcher', selectedProjectId: null, snapshot: null, runtimeAuthority: null,
            selectedAgentId: null, messages: [], activities: [], draft: this.#launcherDraft, conversationLoading: false,
            conversationOlderCursor: null, conversationOlderActivityCursor: null,
            conversationOlderPendingRequestCursor: null, conversationOlderLoading: false, error: null,
            historyConversations: [], userSignalsBaselineReady: false,
            historyIndexCursor: null, historySelectedAgentId: null,
            historyQuery: '', historyMessages: [], historyCursor: null,
            historyLoading: false, historyOlderLoading: false,
            executions: {},
            attentionHistory: [],
            projectedPendingRequests: [],
            supportAgentId: null, supportMessages: [], supportConversationLoading: false, supportDraft: '', supportSending: false,
            projectStartPending: false, projectBootstrap: null,
          });
          return;
        }
      } catch { /* preserve original failure */ }
      const observedStatus = this.#state.runtimeStatus;
      const observedAuthority = observedStatus ? runtimeAuthorityFrom(observedStatus) : null;
      if (observedStatus && observedStatus.statusRevision > status.statusRevision
        && !sameRuntimeAuthority(observedAuthority, authority)) {
        return;
      }
      this.#set({ phase: 'workspace', error: displayError(error) });
    }
  }

  selectAgent(agentId: string): void {
    if (this.#disposing || !selectAgentExists(this.#state, agentId)) return;
    this.#selectAgentLocally(agentId);
    this.#queueLastWorkAgentHint(agentId);
    void this.loadConversation(agentId);
  }

  #queueLastWorkAgentHint(agentId: string): void {
    const guard = this.#guard();
    if (!guard) return;
    this.#lastWorkAgentWriteChain = this.#lastWorkAgentWriteChain
      .catch(() => undefined)
      .then(async () => {
        if (!this.#guardCurrent(guard) || this.#state.selectedAgentId !== agentId) return;
        try {
          const updated = await this.#client.recordLastWorkAgent(guard.authority, agentId);
          if (!this.#guardCurrent(guard) || this.#state.selectedAgentId !== agentId) return;
          this.#set({
            projects: this.#state.projects.map((project) => project.id === updated.id ? updated : project),
          });
        } catch (error) {
          if (this.#guardCurrent(guard) && this.#state.selectedAgentId === agentId) {
            this.#set({ error: displayError(error) });
          }
        }
      });
  }

  #selectAgentLocally(agentId: string): void {
    const projectId = this.#state.selectedProjectId;
    const currentAgent = this.#state.selectedAgentId;
    const supportAgent = this.#state.supportAgentId;
    if (projectId && currentAgent) this.#writeDraft(projectId, currentAgent, this.#state.draft);
    this.#conversationTicket += 1;
    this.#set({
      selectedAgentId: agentId, messages: [], activities: [], conversationLoading: false,
      conversationOlderCursor: null, conversationOlderActivityCursor: null,
      conversationOlderPendingRequestCursor: null, conversationOlderLoading: false,
      draft: this.#readDraft(projectId, agentId), error: null,
    });
    if (supportAgent && supportAgent !== agentId) void this.loadSupportConversation(supportAgent);
  }

  #clearSelectedAgentLocally(): void {
    const projectId = this.#state.selectedProjectId;
    const currentAgent = this.#state.selectedAgentId;
    if (projectId && currentAgent) this.#writeDraft(projectId, currentAgent, this.#state.draft);
    this.#conversationTicket += 1;
    this.#set({
      selectedAgentId: null, messages: [], activities: [], conversationLoading: false,
      conversationOlderCursor: null, conversationOlderActivityCursor: null,
      conversationOlderPendingRequestCursor: null, conversationOlderLoading: false,
      draft: '', error: null,
    });
  }

  setDraft(draft: string): void {
    if (!fitsMessageTextPolicy(draft)) return;
    const projectId = this.#state.selectedProjectId;
    const agentId = this.#state.selectedAgentId;
    if (projectId && agentId) {
      const previous = this.#readDraftRecord(projectId, agentId);
      const next = this.#writeDraft(projectId, agentId, draft);
      if (next.revision !== previous.revision) this.#consumeEditedVoiceClaims(projectId, agentId, previous.revision, next.revision);
    }
    else if (this.#state.draft !== draft) {
      const previousRevision = this.#launcherDraftRevision;
      this.#launcherDraft = draft;
      this.#launcherDraftRevision += 1;
      this.#consumeEditedVoiceClaims(null, null, previousRevision, this.#launcherDraftRevision);
    }
    this.#set({ draft });
  }

  captureComposerDraft(): ComposerDraftCapture | null {
    const guard = this.#guard();
    const projectId = this.#state.selectedProjectId;
    const agentId = this.#state.selectedAgentId;
    if (!guard || !projectId || !agentId || guard.authority.projectId !== projectId) return null;
    const record = this.#readDraftRecord(projectId, agentId);
    if (record.text !== this.#state.draft) return null;
    return {
      target: 'agent',
      ...guard,
      scope: 'ready_operation',
      projectId,
      agentId,
      draft: record.text,
      draftRevision: record.revision,
    };
  }

  #captureLauncherVoiceDraft(): VoiceComposerCapture | null {
    const renderer = this.#state.rendererAuthority;
    if (!renderer || this.#state.selectedAgentId
      || this.#state.phase === 'activating' || this.#state.phase === 'stopping') return null;
    return {
      target: 'launcher',
      epoch: this.#epoch,
      renderer,
      projectId: null,
      agentId: null,
      draft: this.#state.draft,
      draftRevision: this.#launcherDraftRevision,
    };
  }

  #voiceCaptureScopeCurrent(capture: VoiceComposerCapture): boolean {
    if (capture.target === 'launcher') {
      return this.#rendererGuardCurrent(capture.renderer, capture.epoch)
        && !this.#state.selectedAgentId
        && this.#state.phase !== 'activating' && this.#state.phase !== 'stopping';
    }
    return this.#guardCurrent(capture)
      && this.#state.selectedProjectId === capture.projectId
      && this.#state.selectedAgentId === capture.agentId
      && capture.authority.projectId === capture.projectId;
  }

  #voiceCaptureCurrent(capture: VoiceComposerCapture): boolean {
    if (!this.#voiceCaptureScopeCurrent(capture)) return false;
    if (capture.target === 'launcher') {
      return capture.draft === this.#state.draft
        && capture.draftRevision === this.#launcherDraftRevision;
    }
    const current = this.#readDraftRecord(capture.projectId, capture.agentId);
    return current.revision === capture.draftRevision
      && current.text === capture.draft
      && this.#state.draft === capture.draft;
  }

  async #voiceBindingForCapture(capture: VoiceComposerCapture): Promise<VoiceTranscriptionBindingInput> {
    const draftSha256 = await exactDraftSha256(capture.draft);
    if (capture.target === 'launcher') return { target: 'launcher', draftSha256 };
    return {
      target: 'agent',
      projectId: capture.projectId,
      agentId: capture.agentId,
      activationToken: capture.authority.activationToken,
      draftSha256,
    };
  }

  commitComposerTranscript(capture: VoiceComposerCapture, transcript: string): boolean {
    const normalized = transcript.trim();
    if (!normalized || !this.#voiceCaptureCurrent(capture)) return false;
    const next = appendVoiceTranscript(capture.draft, normalized);
    if (next === null) return false;
    if (capture.target === 'launcher') {
      this.setDraft(next);
      return true;
    }
    this.#writeDraft(capture.projectId, capture.agentId, next);
    this.#set({ draft: next });
    return true;
  }

  async prepareVoiceAssets(): Promise<void> {
    const renderer = this.#state.rendererAuthority;
    const status = this.#state.voiceStatus;
    if (!renderer || !status || status.requiredAssetsReady) return;
    const epoch = this.#rendererEpoch;
    const activePhases = new Set(['downloading', 'verifying', 'installing']);
    const required = [...new Set([status.binaryAssetId, status.initialModelAssetId])];
    const recoveryBlocked = required.some((assetId) => status.assets.some((asset) => (
      asset.assetId === assetId && asset.phase === 'recovery_required'
    )));
    if (recoveryBlocked) return;
    this.#set({ voiceError: null });
    try {
      for (const assetId of required) {
        const currentAsset = this.#state.voiceStatus?.assets.find((asset) => asset.assetId === assetId);
        if (currentAsset?.phase === 'installed' || (currentAsset && activePhases.has(currentAsset.phase))) continue;
        const next = await this.#client.acquireVoiceAsset(renderer, assetId);
        if (!this.#rendererGuardCurrent(renderer, epoch)) return;
        this.#acceptVoiceStatus(next);
      }
    } catch (error) {
      if (this.#rendererGuardCurrent(renderer, epoch)) this.#set({ voiceError: displayError(error) });
    }
  }

  prepareVoiceCapture(): { operationRef: string } | null {
    if (!this.#state.voiceStatus?.requiredAssetsReady) return null;
    if (this.#state.voiceCapturePhase !== 'idle'
      || this.#state.voiceStatus.operations.some((operation) => operation.phase === 'recovery_required')) return null;
    const capture = this.captureComposerDraft() ?? this.#captureLauncherVoiceDraft();
    if (!capture) return null;
    const operationRef = this.#selectionId();
    this.#voiceDraftCaptures.set(operationRef, capture);
    this.#set({
      voiceActiveOperationRef: operationRef,
      voiceCapturePhase: 'requesting_permission',
      voiceError: null,
    });
    return { operationRef };
  }

  markVoiceRecording(operationRef: string): void {
    if (this.#state.voiceActiveOperationRef !== operationRef
      || !this.#voiceDraftCaptures.has(operationRef)
      || this.#state.voiceCapturePhase !== 'requesting_permission') return;
    this.#set({ voiceCapturePhase: 'recording' });
  }

  markVoiceCaptureStopping(operationRef: string): void {
    if (this.#state.voiceActiveOperationRef !== operationRef
      || this.#state.voiceCapturePhase !== 'recording') return;
    this.#set({ voiceCapturePhase: 'stopping' });
  }

  failVoiceCapture(operationRef: string, error: unknown): void {
    this.#voiceDraftCaptures.delete(operationRef);
    if (this.#state.voiceActiveOperationRef !== operationRef) return;
    this.#stopVoiceTerminalWatcher(operationRef);
    this.#set({
      voiceActiveOperationRef: null,
      voiceSendIntentOperationRef: null,
      voiceCapturePhase: 'idle',
      voiceError: displayError(error),
    });
  }

  cancelVoiceCapture(operationRef: string): void {
    this.#voiceDraftCaptures.delete(operationRef);
    if (this.#state.voiceActiveOperationRef !== operationRef) return;
    this.#stopVoiceTerminalWatcher(operationRef);
    this.#set({
      voiceActiveOperationRef: null,
      voiceSendIntentOperationRef: null,
      voiceCapturePhase: 'idle',
      voiceError: null,
    });
  }

  requestVoiceSendIntent(operationRef: string): boolean {
    if (this.#state.voiceActiveOperationRef !== operationRef
      || !['recording', 'stopping', 'transcribing'].includes(this.#state.voiceCapturePhase)) return false;
    this.#set({ voiceSendIntentOperationRef: operationRef, voiceError: null });
    return true;
  }

  async submitVoiceCapture(operationRef: string, pcm: Uint8Array, sampleCount: number): Promise<void> {
    const capture = this.#voiceDraftCaptures.get(operationRef);
    if (!capture || this.#state.voiceActiveOperationRef !== operationRef) return;
    if (!this.#voiceCaptureScopeCurrent(capture)) {
      this.failVoiceCapture(operationRef, new UserMessageError(userMessage('voice_project_changed')));
      return;
    }
    if (!this.#voiceCaptureCurrent(capture)) {
      this.failVoiceCapture(operationRef, new UserMessageError(userMessage('voice_draft_changed')));
      return;
    }
    const renderer = capture.renderer;
    const epoch = this.#rendererEpoch;
    this.#set({ voiceError: null });
    try {
      const binding = await this.#voiceBindingForCapture(capture);
      if (this.#state.voiceActiveOperationRef !== operationRef
        || this.#voiceDraftCaptures.get(operationRef) !== capture
        || !['recording', 'stopping'].includes(this.#state.voiceCapturePhase)
        || !this.#voiceCaptureCurrent(capture)) {
        if (this.#state.voiceActiveOperationRef === operationRef) {
          this.failVoiceCapture(operationRef, new UserMessageError(userMessage('voice_draft_changed')));
        }
        return;
      }
      await this.#client.transcribeVoicePcm(renderer, operationRef, binding, pcm, sampleCount);
      if (!this.#rendererGuardCurrent(renderer, epoch)) return;
      if (this.#state.voiceActiveOperationRef !== operationRef
        || this.#voiceDraftCaptures.get(operationRef) !== capture) return;
      this.#set({ voiceCapturePhase: 'transcribing' });
      const status = await this.#client.readVoiceStatus(renderer);
      if (!this.#rendererGuardCurrent(renderer, epoch)) return;
      const operation = status.operations.find((candidate) => candidate.operationRef === operationRef);
      this.#acceptVoiceStatus(status);
      if (operation?.phase === 'staging' || operation?.phase === 'transcribing') {
        this.#startVoiceTerminalWatcher(operationRef, renderer, epoch);
      }
    } catch (error) {
      if (!this.#rendererGuardCurrent(renderer, epoch)) return;
      try {
        const recovered = await this.#client.readVoiceStatus(renderer);
        if (!this.#rendererGuardCurrent(renderer, epoch)) return;
        this.#acceptVoiceStatus(recovered);
        const operation = recovered.operations.find((candidate) => candidate.operationRef === operationRef);
        if (operation) {
          if (operation.phase === 'staging' || operation.phase === 'transcribing') {
            this.#startVoiceTerminalWatcher(operationRef, renderer, epoch);
          }
          return;
        }
      } catch { /* The original transcription error remains authoritative. */ }
      this.failVoiceCapture(operationRef, error);
    }
  }

  async cancelVoiceTranscription(operationRef: string): Promise<void> {
    const renderer = this.#state.rendererAuthority;
    if (!renderer || this.#state.voiceActiveOperationRef !== operationRef
      || this.#state.voiceCapturePhase !== 'transcribing') return;
    const epoch = this.#rendererEpoch;
    this.#set({ voiceCapturePhase: 'cancelling', voiceError: null });
    try {
      const status = await this.#client.cancelVoiceTranscription(renderer, operationRef);
      if (!this.#rendererGuardCurrent(renderer, epoch)) return;
      const operation = status.operations.find((candidate) => candidate.operationRef === operationRef);
      this.#acceptVoiceStatus(status);
      if (operation?.phase === 'staging' || operation?.phase === 'transcribing') {
        this.#startVoiceTerminalWatcher(operationRef, renderer, epoch);
      }
    } catch (error) {
      if (!this.#rendererGuardCurrent(renderer, epoch)) return;
      try {
        const recovered = await this.#client.readVoiceStatus(renderer);
        if (!this.#rendererGuardCurrent(renderer, epoch)) return;
        const operation = recovered.operations.find((candidate) => candidate.operationRef === operationRef);
        this.#acceptVoiceStatus(recovered);
        if (this.#state.voiceActiveOperationRef !== operationRef) return;
        if (operation && ['cancelled', 'failed', 'transcribed', 'recovery_required'].includes(operation.phase)) return;
        if (operation?.phase === 'staging' || operation?.phase === 'transcribing') {
          this.#startVoiceTerminalWatcher(operationRef, renderer, epoch);
        }
      } catch { /* Keep the exact cancel error below. */ }
      if (!this.#rendererGuardCurrent(renderer, epoch)
        || this.#state.voiceActiveOperationRef !== operationRef) return;
      this.#set({
        voiceCapturePhase: isOutcomeUnknownError(error) ? 'cancelling' : 'transcribing',
        voiceError: displayError(error),
      });
    }
  }

  async loadConversation(agentId = this.#state.selectedAgentId): Promise<void> {
    if (!agentId) return;
    const guard = this.#readGuard();
    if (!guard) return;
    if (this.#state.supportAgentId === agentId) this.#supportConversationTicket += 1;
    const ticket = ++this.#conversationTicket;
    this.#set({ conversationLoading: true });
    try {
      const key = draftKey(guard.authority.projectId, agentId);
      const checkpoint = this.#conversationCheckpoints.get(key)
        ?? {
          streamId: null, journalSequence: 0, projectionRevision: 0,
          olderCursor: null, activityOlderCursor: null, pendingRequestOlderCursor: null, loadedOlder: false,
        };
      let page = await this.#client.readConversation(guard.authority, agentId, checkpoint, null, null, null);
      let reset = false;
      if (page.syncState === 'stream_reset' || page.syncState === 'gap') {
        if (!this.#guardCurrent(guard) || ticket !== this.#conversationTicket || this.#state.selectedAgentId !== agentId) return;
        reset = true;
        this.#conversationCheckpoints.delete(key);
        this.#set({
          messages: [],
          ...(this.#state.supportAgentId === agentId ? { supportMessages: [] } : {}),
          activities: [],
          conversationOlderCursor: null,
          conversationOlderActivityCursor: null,
          conversationOlderPendingRequestCursor: null,
          projectedPendingRequests: [],
          executions: withoutRecordKey(this.#state.executions, agentId),
        });
        page = await this.#client.readConversation(
          guard.authority,
          agentId,
          { streamId: null, journalSequence: 0, projectionRevision: 0 },
          null,
          null,
          null,
        );
        if (page.syncState === 'stream_reset' || page.syncState === 'gap') {
          throw new Error('Conversation projection baseline did not establish current stream ownership.');
        }
      }
      if (!this.#guardCurrent(guard) || ticket !== this.#conversationTicket || this.#state.selectedAgentId !== agentId) return;
      const preserveOlder = !reset
        && checkpoint.loadedOlder
        && checkpoint.streamId === page.streamId
        && (this.#state.messages.length > 0 || this.#state.activities.length > 0);
      const messages = preserveOlder
        ? mergeConversationMessages(this.#state.messages, page.items)
        : page.items;
      const activities = preserveOlder
        ? mergeConversationActivities(this.#state.activities, page.activities)
        : page.activities;
      const olderCursor = preserveOlder ? checkpoint.olderCursor : page.olderCursor;
      const activityOlderCursor = preserveOlder ? checkpoint.activityOlderCursor : page.activityOlderCursor;
      // Pending requests are mutable recovery state. A current refresh replaces
      // the visible first page and restarts its continuation so resolved or
      // reclassified rows retire without skipping a previously loaded page.
      const pendingRequestOlderCursor = page.pendingRequestOlderCursor;
      this.#conversationCheckpoints.set(key, {
        streamId: page.streamId,
        journalSequence: page.appliedJournalSequence,
        projectionRevision: page.projectionRevision,
        olderCursor,
        activityOlderCursor,
        pendingRequestOlderCursor,
        loadedOlder: preserveOlder,
      });
      const activeTurn = latestActiveTurn(page.activeTurns);
      const execution = executionFromProjection(
        guard.authority.projectId,
        agentId,
        activeTurn,
        page.latestTurn,
        this.#state.executions[agentId] ?? null,
        this.#observedAt(),
      );
      const activeTurnKey = activeTurn ? `${activeTurn.threadId}:${activeTurn.turnId}` : null;
      const pendingRequests = page.pendingRequests;
      this.#set({
        messages,
        ...(this.#state.supportAgentId === agentId
          ? { supportMessages: messages, supportConversationLoading: false }
          : {}),
        activities,
        conversationLoading: false,
        conversationOlderCursor: olderCursor,
        conversationOlderActivityCursor: activityOlderCursor,
        conversationOlderPendingRequestCursor: pendingRequestOlderCursor,
        conversationOlderLoading: false,
        projectedPendingRequests: pendingRequests,
        attentionHistory: resolvedAttentionItems(page.resolvedRequests),
        turnMutationAcceptedTurnKey: activeTurnKey === this.#state.turnMutationAcceptedTurnKey
          ? this.#state.turnMutationAcceptedTurnKey : null,
        turnMutationOutcomeUnknownTurnKey: activeTurnKey === this.#state.turnMutationOutcomeUnknownTurnKey
          ? this.#state.turnMutationOutcomeUnknownTurnKey : null,
        executions: execution
          ? { ...this.#state.executions, [agentId]: execution }
          : withoutRecordKey(this.#state.executions, agentId),
      });
      this.#markUserSignalBaselinePart('conversation');
    } catch (error) {
      if (!this.#guardCurrent(guard) || ticket !== this.#conversationTicket) return;
      this.#set({
        conversationLoading: false,
        conversationOlderLoading: false,
        ...(this.#state.supportAgentId === agentId ? { supportConversationLoading: false } : {}),
        error: displayError(error),
      });
    }
  }

  async loadOlderConversation(agentId = this.#state.selectedAgentId): Promise<boolean> {
    if (!agentId || this.#state.conversationLoading || this.#state.conversationOlderLoading) return false;
    const guard = this.#readGuard();
    if (!guard) return false;
    const key = draftKey(guard.authority.projectId, agentId);
    const checkpoint = this.#conversationCheckpoints.get(key);
    const cursor = checkpoint?.olderCursor ?? null;
    const activityCursor = checkpoint?.activityOlderCursor ?? null;
    const pendingRequestCursor = checkpoint?.pendingRequestOlderCursor ?? null;
    if (!checkpoint || (!cursor && !activityCursor && !pendingRequestCursor)) return false;
    const ticket = this.#conversationTicket;
    this.#set({ conversationOlderLoading: true, error: null });
    try {
      const page = await this.#client.readConversation(
        guard.authority,
        agentId,
        checkpoint,
        cursor,
        activityCursor,
        pendingRequestCursor,
      );
      if (!this.#guardCurrent(guard) || ticket !== this.#conversationTicket || this.#state.selectedAgentId !== agentId) return false;
      if (page.syncState === 'stream_reset' || page.syncState === 'gap' || page.streamId !== checkpoint.streamId) {
        this.#conversationCheckpoints.delete(key);
        this.#set({
          messages: [], activities: [], conversationOlderCursor: null,
          conversationOlderActivityCursor: null, conversationOlderPendingRequestCursor: null,
          conversationOlderLoading: false,
          projectedPendingRequests: [],
        });
        await this.loadConversation(agentId);
        return false;
      }
      this.#conversationCheckpoints.set(key, {
        streamId: checkpoint.streamId,
        journalSequence: checkpoint.journalSequence,
        projectionRevision: checkpoint.projectionRevision,
        olderCursor: page.olderCursor,
        activityOlderCursor: page.activityOlderCursor,
        pendingRequestOlderCursor: page.pendingRequestOlderCursor,
        loadedOlder: true,
      });
      const pendingRequests = mergeProjectedPendingRequests(
        this.#state.projectedPendingRequests,
        page.pendingRequests,
      );
      this.#set({
        messages: mergeConversationMessages(page.items, this.#state.messages),
        activities: mergeConversationActivities(page.activities, this.#state.activities),
        conversationOlderCursor: page.olderCursor,
        conversationOlderActivityCursor: page.activityOlderCursor,
        conversationOlderPendingRequestCursor: page.pendingRequestOlderCursor,
        conversationOlderLoading: false,
        projectedPendingRequests: pendingRequests,
        attentionHistory: resolvedAttentionItems(page.resolvedRequests),
      });
      return true;
    } catch (error) {
      if (!this.#guardCurrent(guard) || ticket !== this.#conversationTicket) return false;
      this.#set({ conversationOlderLoading: false, error: displayError(error) });
      return false;
    }
  }

  async loadHistoryIndex(
    cursor = null as import('../domain/models').HistoryCursor | null,
    preserveConversation = false,
    summaryOnly = false,
  ): Promise<boolean> {
    const guard = this.#readGuard();
    if (!guard) return false;
    if (this.#state.historyLoading) {
      if (!cursor) this.#queueHistoryRefresh(summaryOnly
        ? 'summary' : preserveConversation ? 'preserve' : 'reset');
      return false;
    }
    const ticket = ++this.#historyTicket;
    this.#set({ historyLoading: true, ...(summaryOnly ? {} : { error: null }) });
    try {
      const page = await this.#client.readHistoryIndex(guard.authority, cursor);
      if (!this.#guardCurrent(guard) || ticket !== this.#historyTicket
        || page.projectId !== guard.authority.projectId) return false;
      let conversations = cursor
        ? [...new Map([...this.#state.historyConversations, ...page.items]
          .map((item) => [item.targetAgentId, item])).values()]
        : page.items;
      if (summaryOnly && this.#state.route !== 'history') {
        this.#set({
          historyConversations: conversations,
          historyIndexCursor: page.nextCursor,
          historyLoading: false,
        });
        this.#markUserSignalBaselinePart('summaries');
        this.#runQueuedHistoryRefresh();
        return true;
      }
      if (!cursor && preserveConversation && this.#state.historySelectedAgentId
        && !conversations.some((item) => item.targetAgentId === this.#state.historySelectedAgentId)) {
        const selectedSummary = this.#state.historyConversations
          .find((item) => item.targetAgentId === this.#state.historySelectedAgentId);
        if (selectedSummary) conversations = [...conversations, selectedSummary];
      }
      const selected = this.#state.historySelectedAgentId
        && conversations.some((item) => item.targetAgentId === this.#state.historySelectedAgentId)
        ? this.#state.historySelectedAgentId
        : conversations[0]?.targetAgentId ?? null;
      const query = preserveConversation && selected === this.#state.historySelectedAgentId
        ? this.#state.historyQuery
        : '';
      this.#set({
        historyConversations: conversations,
        historyIndexCursor: page.nextCursor,
        historySelectedAgentId: selected,
        historyLoading: cursor ? false : selected !== null,
        ...(!cursor ? {
          historyQuery: query,
          ...(preserveConversation && selected === this.#state.historySelectedAgentId
            ? {}
            : { historyMessages: [], historyCursor: null }),
          historyOlderLoading: false,
        } : {}),
      });
      this.#markUserSignalBaselinePart('summaries');
      if (!cursor && selected) await this.#loadHistoryPage(guard, selected, query, null, true, ticket);
      this.#runQueuedHistoryRefresh();
      return true;
    } catch (error) {
      if (this.#guardCurrent(guard) && ticket === this.#historyTicket) {
        this.#set({
          historyLoading: false,
          ...(summaryOnly ? {} : { error: displayError(error) }),
        });
      }
      this.#runQueuedHistoryRefresh();
      return false;
    }
  }

  #runQueuedHistoryRefresh(): void {
    if (!this.#historyRefreshRequested
      || this.#state.historyLoading || !this.#state.runtimeAuthority) return;
    const mode = this.#historyRefreshRequested;
    this.#historyRefreshRequested = null;
    queueMicrotask(() => {
      if (!this.#disposed) {
        const summaryOnly = mode === 'summary' && this.#state.route !== 'history';
        void this.loadHistoryIndex(null, mode !== 'reset', summaryOnly);
      }
    });
  }

  #queueHistoryRefresh(mode: HistoryRefreshMode): void {
    if (!this.#historyRefreshRequested
      || HISTORY_REFRESH_PRIORITY[mode] > HISTORY_REFRESH_PRIORITY[this.#historyRefreshRequested]) {
      this.#historyRefreshRequested = mode;
    }
  }

  async loadOlderHistoryIndex(): Promise<boolean> {
    const cursor = this.#state.historyIndexCursor;
    return cursor ? this.loadHistoryIndex(cursor) : false;
  }

  selectHistoryAgent(agentId: string): void {
    if (!this.#state.historyConversations.some((item) => item.targetAgentId === agentId)) return;
    const guard = this.#readGuard();
    if (!guard) return;
    this.#historyTicket += 1;
    this.#set({
      historySelectedAgentId: agentId,
      historyQuery: '',
      historyMessages: [],
      historyCursor: null,
      historyLoading: true,
      historyOlderLoading: false,
      error: null,
    });
    const ticket = this.#historyTicket;
    void this.#loadHistoryPage(guard, agentId, '', null, true, ticket);
  }

  setHistoryQuery(query: string): void {
    const canonicalQuery = query.trim();
    const agentId = this.#state.historySelectedAgentId;
    const guard = this.#readGuard();
    this.#historyTicket += 1;
    this.#set({
      historyQuery: canonicalQuery,
      historyMessages: [],
      historyCursor: null,
      historyLoading: Boolean(guard && agentId),
      historyOlderLoading: false,
      error: null,
    });
    if (guard && agentId) {
      const ticket = this.#historyTicket;
      void this.#loadHistoryPage(guard, agentId, canonicalQuery, null, true, ticket);
    }
  }

  async loadOlderHistory(): Promise<boolean> {
    const guard = this.#readGuard();
    const agentId = this.#state.historySelectedAgentId;
    const cursor = this.#state.historyCursor;
    if (!guard || !agentId || !cursor || this.#state.historyLoading || this.#state.historyOlderLoading) return false;
    const ticket = this.#historyTicket;
    this.#set({ historyOlderLoading: true, error: null });
    return this.#loadHistoryPage(guard, agentId, this.#state.historyQuery, cursor, false, ticket);
  }

  async #loadHistoryPage(
    guard: OperationGuard,
    agentId: string,
    query: string,
    cursor: ConversationCursor | null,
    replace: boolean,
    ticket = this.#historyTicket,
  ): Promise<boolean> {
    const canonicalQuery = query.trim();
    try {
      const page = await this.#client.readHistoryPage(
        guard.authority,
        agentId,
        canonicalQuery || null,
        cursor,
      );
      if (!this.#guardCurrent(guard) || ticket !== this.#historyTicket
        || this.#state.historySelectedAgentId !== agentId
        || this.#state.historyQuery !== canonicalQuery
        || page.projectId !== guard.authority.projectId
        || page.targetAgentId !== agentId
        || page.query !== (canonicalQuery || null)) return false;
      this.#set({
        historyMessages: replace
          ? page.items
          : mergeConversationMessages(page.items, this.#state.historyMessages),
        historyCursor: page.nextCursor,
        historyLoading: false,
        historyOlderLoading: false,
      });
      this.#runQueuedHistoryRefresh();
      return true;
    } catch (error) {
      if (this.#guardCurrent(guard) && ticket === this.#historyTicket
        && this.#state.historySelectedAgentId === agentId) {
        this.#set({ historyLoading: false, historyOlderLoading: false, error: displayError(error) });
      }
      this.#runQueuedHistoryRefresh();
      return false;
    }
  }

  openHistoryAgentInWork(): void {
    const agentId = this.#state.historySelectedAgentId;
    if (!agentId || !selectAgentExists(this.#state, agentId)) return;
    this.#set({ route: 'work' });
    this.selectAgent(agentId);
  }

  openSupport(agentId: string): void {
    if (!selectAgentExists(this.#state, agentId)) return;
    const projectId = this.#state.selectedProjectId;
    const previous = this.#state.supportAgentId;
    if (projectId && previous) this.#supportDrafts.set(draftKey(projectId, previous), this.#state.supportDraft);
    this.#supportConversationTicket += 1;
    this.#set({
      supportAgentId: agentId,
      supportMessages: [],
      supportConversationLoading: true,
      supportDraft: projectId ? this.#supportDrafts.get(draftKey(projectId, agentId)) ?? '' : '',
      supportSending: false,
      error: null,
    });
    void this.loadSupportConversation(agentId);
  }

  closeSupport(): void {
    const projectId = this.#state.selectedProjectId;
    const agentId = this.#state.supportAgentId;
    if (projectId && agentId) this.#supportDrafts.set(draftKey(projectId, agentId), this.#state.supportDraft);
    this.#supportConversationTicket += 1;
    this.#set({
      supportAgentId: null,
      supportMessages: [],
      supportConversationLoading: false,
      supportDraft: '',
      supportSending: false,
    });
  }

  setSupportDraft(draft: string): void {
    const projectId = this.#state.selectedProjectId;
    const agentId = this.#state.supportAgentId;
    if (projectId && agentId) this.#supportDrafts.set(draftKey(projectId, agentId), draft);
    this.#set({ supportDraft: draft });
  }

  async loadSupportConversation(agentId = this.#state.supportAgentId): Promise<void> {
    if (!agentId) return;
    if (this.#state.selectedAgentId === agentId) {
      await this.loadConversation(agentId);
      return;
    }
    const guard = this.#readGuard();
    if (!guard) return;
    const ticket = ++this.#supportConversationTicket;
    this.#set({ supportConversationLoading: true });
    try {
      const key = draftKey(guard.authority.projectId, agentId);
      const checkpoint = this.#conversationCheckpoints.get(key)
        ?? {
          streamId: null, journalSequence: 0, projectionRevision: 0,
          olderCursor: null, activityOlderCursor: null, pendingRequestOlderCursor: null, loadedOlder: false,
        };
      let page = await this.#client.readConversation(guard.authority, agentId, checkpoint, null, null, null);
      if (page.syncState === 'stream_reset' || page.syncState === 'gap') {
        if (!this.#guardCurrent(guard) || ticket !== this.#supportConversationTicket || this.#state.supportAgentId !== agentId) return;
        this.#conversationCheckpoints.delete(key);
        this.#set({
          supportMessages: [],
          executions: withoutRecordKey(this.#state.executions, agentId),
        });
        page = await this.#client.readConversation(
          guard.authority,
          agentId,
          { streamId: null, journalSequence: 0, projectionRevision: 0 },
          null,
          null,
          null,
        );
        if (page.syncState === 'stream_reset' || page.syncState === 'gap') {
          throw new Error('Support conversation projection baseline did not establish current stream ownership.');
        }
      }
      if (!this.#guardCurrent(guard) || ticket !== this.#supportConversationTicket || this.#state.supportAgentId !== agentId) return;
      this.#conversationCheckpoints.set(key, {
        streamId: page.streamId,
        journalSequence: page.appliedJournalSequence,
        projectionRevision: page.projectionRevision,
        olderCursor: page.olderCursor,
        activityOlderCursor: page.activityOlderCursor,
        pendingRequestOlderCursor: page.pendingRequestOlderCursor,
        loadedOlder: false,
      });
      const activeTurn = latestActiveTurn(page.activeTurns);
      const execution = executionFromProjection(
        guard.authority.projectId,
        agentId,
        activeTurn,
        page.latestTurn,
        this.#state.executions[agentId] ?? null,
        this.#observedAt(),
      );
      this.#set({
        supportMessages: page.items,
        supportConversationLoading: false,
        executions: execution
          ? { ...this.#state.executions, [agentId]: execution }
          : withoutRecordKey(this.#state.executions, agentId),
      });
    } catch (error) {
      if (!this.#guardCurrent(guard) || ticket !== this.#supportConversationTicket) return;
      this.#set({ supportConversationLoading: false, error: displayError(error) });
    }
  }

  async sendSupportMessage(): Promise<void> {
    const guard = this.#guard();
    const targetAgentId = this.#state.supportAgentId;
    const draftAtSubmit = this.#state.supportDraft;
    const text = draftAtSubmit.trim();
    const execution = targetAgentId ? this.#state.executions[targetAgentId] ?? null : null;
    if (guard && this.#state.dispatchRecovery?.projectId === guard.authority.projectId
      && this.#state.dispatchRecovery.kind !== 'accepted') {
      this.#set({ notice: userMessage('recover_before_send') });
      return;
    }
    if (!guard || !targetAgentId || !text || this.#state.sending
      || this.#state.supportSending || executionHasActiveTurn(execution)) return;
    await this.#dispatchNewTurn({
      guard,
      targetAgentId,
      text,
      attachments: [],
      action: 'send',
      surface: 'support',
      draftAtSubmit,
      draftRevisionAtSubmit: null,
    });
  }

  async stageAttachmentFiles(files: File[]): Promise<void> {
    const guard = this.#guard();
    if (!guard || this.#state.sending || this.#state.attachmentSelectionPending
      || this.#state.attachmentRemovalPending
      || files.length === 0) return;
    const selectionId = this.#selectionId();
    this.#set({ attachmentSelectionPending: true, error: null });
    try {
      const selected = await this.#client.importAttachments(guard.authority, selectionId, files);
      if (!this.#guardCurrent(guard)) {
        await this.#cleanupSelection(guard.authority, selectionId);
        return;
      }
      if (selected.length !== files.length) {
        await this.#cleanupSelection(guard.authority, selectionId);
        if (this.#guardCurrent(guard)) this.#set({
          attachmentSelectionPending: false,
          error: userMessage('attachment_batch_rejected'),
        });
      } else this.#set({
        attachments: [...this.#state.attachments, ...selected],
        attachmentSelectionPending: false,
        error: null,
      });
    } catch (error) {
      await this.#cleanupSelection(guard.authority, selectionId);
      if (this.#guardCurrent(guard)) this.#set({
        attachmentSelectionPending: false,
        error: displayError(error),
      });
    }
  }

  async readAttachmentPreview(attachmentId: string): Promise<{ bytes: ArrayBuffer; mediaType: string }> {
    const guard = this.#guard();
    const attachment = this.#state.attachments.find((candidate) => candidate.id === attachmentId);
    if (!guard || !attachment || attachment.kind !== 'image') throw new UserMessageError(userMessage('attachment_preview_unavailable'));
    let bytes: ArrayBuffer;
    try {
      bytes = await this.#client.readAttachmentPreview(
        guard.authority,
        attachment.selectionId,
        attachment.id,
      );
    } catch (error) {
      throw new UserMessageError(displayError(error));
    }
    const current = this.#state.attachments.find((candidate) => candidate.id === attachmentId);
    if (!this.#guardCurrent(guard) || !current
      || current.selectionId !== attachment.selectionId
      || current.mediaType !== attachment.mediaType
      || current.sizeBytes !== attachment.sizeBytes) {
      throw new UserMessageError(userMessage('attachment_preview_stale'));
    }
    return { bytes, mediaType: attachment.mediaType };
  }

  async removeAttachment(attachmentId: string): Promise<void> {
    if (this.#state.sending || this.#state.attachmentSelectionPending
      || this.#state.attachmentRemovalPending) return;
    const attachment = this.#state.attachments.find((candidate) => candidate.id === attachmentId);
    if (!attachment) return;
    const epoch = this.#epoch;
    this.#set({ attachmentRemovalPending: true, error: null });
    try {
      await this.#client.forgetAttachment(
        this.#state.runtimeAuthority,
        attachment.selectionId,
        attachment.id,
      );
      if (this.#disposed || epoch !== this.#epoch) return;
      this.#set({
        attachments: this.#state.attachments.filter((candidate) => candidate.id !== attachmentId),
        attachmentRemovalPending: false,
        error: null,
      });
    } catch (error) {
      if (!this.#disposed && epoch === this.#epoch
        && this.#state.attachments.some((candidate) => candidate.id === attachmentId)) {
        this.#set({ attachmentRemovalPending: false, error: displayError(error) });
      }
    }
  }

  async sendMessage(): Promise<void> {
    const guard = this.#guard();
    const targetAgentId = this.#state.selectedAgentId;
    const execution = targetAgentId ? this.#state.executions[targetAgentId] ?? null : null;
    const draftAtSubmit = this.#state.draft;
    const draftRevisionAtSubmit = guard && targetAgentId
      ? this.#readDraftRecord(guard.authority.projectId, targetAgentId).revision
      : null;
    const text = draftAtSubmit.trim();
    if (guard && this.#state.dispatchRecovery?.projectId === guard.authority.projectId
      && this.#state.dispatchRecovery.kind !== 'accepted') {
      this.#set({ notice: userMessage('recover_before_send') });
      return;
    }
    if (!guard || !targetAgentId || !text || this.#state.sending
      || this.#state.attachmentSelectionPending
      || this.#state.attachmentRemovalPending || executionHasActiveTurn(execution)) return;
    await this.#dispatchNewTurn({
      guard,
      targetAgentId,
      text,
      attachments: this.#state.attachments,
      action: 'send',
      surface: 'work',
      draftAtSubmit,
      draftRevisionAtSubmit,
    });
  }

  async retryMessage(messageId: string): Promise<void> {
    const guard = this.#guard();
    const targetAgentId = this.#state.selectedAgentId;
    const message = this.#state.messages.find((candidate) => candidate.id === messageId);
    const execution = targetAgentId ? this.#state.executions[targetAgentId] ?? null : null;
    if (guard && this.#state.dispatchRecovery?.projectId === guard.authority.projectId
      && this.#state.dispatchRecovery.kind !== 'accepted') {
      this.#set({ notice: userMessage('recover_before_retry') });
      return;
    }
    if (!guard || !targetAgentId || !message || message.role !== 'user'
      || message.targetAgentId !== targetAgentId || !message.text.trim()
      || this.#state.sending || executionHasActiveTurn(execution)) return;
    await this.#dispatchNewTurn({
      guard,
      targetAgentId,
      text: message.text.trim(),
      attachments: [],
      action: 'retry',
      surface: 'work',
      draftAtSubmit: null,
      draftRevisionAtSubmit: null,
    });
  }

  async #dispatchNewTurn(input: {
    guard: OperationGuard;
    targetAgentId: string;
    text: string;
    attachments: ComposerAttachment[];
    action: 'send' | 'retry';
    surface: 'work' | 'support';
    draftAtSubmit: string | null;
    draftRevisionAtSubmit: number | null;
  }): Promise<void> {
    const {
      guard, targetAgentId, text, attachments, action, surface, draftAtSubmit, draftRevisionAtSubmit,
    } = input;
    const supportSurface = surface === 'support';
    const summary = activitySummary(text);
    const dispatchBaselineSequence = this.#conversationCheckpoints
      .get(draftKey(guard.authority.projectId, targetAgentId))?.journalSequence ?? 0;
    this.#set({
      sending: true,
      supportSending: supportSurface,
      conversationAction: supportSurface ? null : action,
      error: null,
      notice: null,
      executions: {
        ...this.#state.executions,
        [targetAgentId]: {
          executionId: `pending:${guard.authority.projectId}:${targetAgentId}`,
          projectId: guard.authority.projectId,
          targetAgentId,
          phase: 'queueing', summary, updatedAt: this.#observedAt(),
          dispatchId: null, threadId: null, turnId: null,
          lastJournalSequence: dispatchBaselineSequence, source: 'optimistic', canInterrupt: false,
        },
      },
    });
    try {
      const result = await this.#client.sendMessage(guard.authority, {
        targetAgentId,
        text,
        attachmentRefs: attachments.map((attachment) => ({
          selectionId: attachment.selectionId,
          publicId: attachment.id,
        })),
      });
      if (!this.#guardCurrent(guard)) return;
      const clearSubmittedDraft = !supportSurface && draftAtSubmit !== null
        && draftRevisionAtSubmit !== null
        && this.#state.selectedAgentId === targetAgentId
        && this.#state.draft === draftAtSubmit
        && this.#readDraftRecord(guard.authority.projectId, targetAgentId).revision === draftRevisionAtSubmit;
      if (clearSubmittedDraft) this.#writeDraft(guard.authority.projectId, targetAgentId, '');
      const supportDraftKey = draftKey(guard.authority.projectId, targetAgentId);
      const clearSubmittedSupportDraft = supportSurface && draftAtSubmit !== null
        && this.#supportDrafts.get(supportDraftKey) === draftAtSubmit;
      const clearVisibleSupportDraft = clearSubmittedSupportDraft
        && this.#state.supportAgentId === targetAgentId
        && this.#state.supportDraft === draftAtSubmit;
      if (clearSubmittedSupportDraft) this.#supportDrafts.delete(supportDraftKey);
      // runtime_send atomically transfers selection ownership to the native outbox.
      attachments.forEach((attachment) => this.#pendingSelectionCleanup.delete(attachment.selectionId));
      const currentExecution = this.#state.executions[targetAgentId];
      const targetStillSelected = this.#state.selectedAgentId === targetAgentId;
      this.#set({
        draft: clearSubmittedDraft ? '' : this.#state.draft,
        supportDraft: clearVisibleSupportDraft ? '' : this.#state.supportDraft,
        attachments: !supportSurface && action === 'send' ? [] : this.#state.attachments,
        sending: false,
        supportSending: false,
        conversationAction: null,
        dispatchRecovery: result.dispatchRecovery,
        notice: action === 'retry' && targetStillSelected ? userMessage('retry_sent') : this.#state.notice,
        executions: {
          ...this.#state.executions,
          [targetAgentId]: {
            executionId: result.receipt.dispatchId,
            projectId: guard.authority.projectId,
            targetAgentId,
            phase: currentExecution?.phase === 'queueing' ? 'accepted' : currentExecution?.phase ?? 'accepted',
            source: currentExecution?.source ?? 'optimistic',
            summary: currentExecution?.summary ?? summary,
            updatedAt: currentExecution?.updatedAt ?? this.#observedAt(),
            dispatchId: result.receipt.dispatchId,
            threadId: currentExecution?.threadId ?? result.receipt.threadId,
            turnId: currentExecution?.turnId ?? result.receipt.turnId,
            lastJournalSequence: currentExecution?.lastJournalSequence ?? null,
            canInterrupt: currentExecution?.canInterrupt ?? false,
          },
        },
      });
      if (!supportSurface && action === 'send') {
        for (const [operationRef, claim] of this.#voiceInsertedUnacked) {
          if (!claim.ackTarget
            || claim.ackTarget.projectId !== guard.authority.projectId
            || claim.ackTarget.agentId !== targetAgentId
            || claim.draftRevision !== draftRevisionAtSubmit) continue;
          void this.#acknowledgeVoiceOperation(operationRef);
        }
      }
      if (supportSurface && this.#guardCurrent(guard)
        && this.#state.supportAgentId === targetAgentId) {
        await this.loadSupportConversation(targetAgentId);
      } else if (this.#guardCurrent(guard) && this.#state.selectedAgentId === targetAgentId) {
        await this.loadConversation(targetAgentId);
      }
    } catch (error) {
      if (!this.#guardCurrent(guard)) return;
      const dispatchFailure = error instanceof DispatchSendError ? error : null;
      const failure = displayError(dispatchFailure?.failure ?? error);
      if (dispatchFailure) {
        attachments.forEach((attachment) => this.#pendingSelectionCleanup.delete(attachment.selectionId));
      }
      const submittedAttachments = new Set(
        attachments.map((attachment) => `${attachment.selectionId}\0${attachment.id}`),
      );
      this.#set({
        attachments: dispatchFailure
          ? this.#state.attachments.filter((attachment) => (
              !submittedAttachments.has(`${attachment.selectionId}\0${attachment.id}`)
            ))
          : this.#state.attachments,
        sending: false,
        supportSending: false,
        conversationAction: null,
        error: failure,
        dispatchRecovery: dispatchFailure
          ? dispatchFailure.recovery
          : this.#state.dispatchRecovery,
        executions: {
          ...this.#state.executions,
          [targetAgentId]: {
            ...(this.#state.executions[targetAgentId] ?? {
              executionId: `failed:${guard.authority.projectId}:${targetAgentId}`,
              projectId: guard.authority.projectId,
              targetAgentId,
              source: 'optimistic',
              summary, dispatchId: null, threadId: null, turnId: null,
              lastJournalSequence: null, canInterrupt: false,
            }),
            phase: 'failed', updatedAt: this.#observedAt(), canInterrupt: false,
          },
        },
      });
      // A response-loss may have produced a durable recovery record. Read it instead of guessing delivery outcome.
      try {
        const recovery = await this.#client.readDispatchRecovery(guard.renderer);
        if (this.#guardCurrent(guard)
          && (!recovery || recovery.projectId === guard.authority.projectId)) {
          this.#set({ dispatchRecovery: recovery });
        }
      } catch { /* original send error remains useful */ }
    }
  }

  async steerActiveTurn(): Promise<void> {
    const guard = this.#guard();
    const targetAgentId = this.#state.selectedAgentId;
    const execution = targetAgentId ? selectSelectedExecution(this.#state) : null;
    const text = this.#state.draft.trim();
    const turnKey = execution?.threadId && execution.turnId
      ? `${execution.threadId}:${execution.turnId}` : null;
    if (!guard || !targetAgentId || !text || this.#state.sending
      || !execution?.canInterrupt || !execution.threadId || !execution.turnId
      || this.#state.turnMutationAcceptedTurnKey === turnKey
      || this.#state.turnMutationOutcomeUnknownTurnKey === turnKey) return;
    const draftAtSubmit = this.#state.draft;
    const draftRevisionAtSubmit = this.#readDraftRecord(guard.authority.projectId, targetAgentId).revision;
    const steerId = createSelectionId();
    this.#set({
      sending: true,
      conversationAction: 'steer',
      error: null,
      notice: null,
      executions: {
        ...this.#state.executions,
        [targetAgentId]: {
          ...execution,
          updatedAt: this.#observedAt(),
        },
      },
    });
    try {
      await this.#client.steerTurn(guard.authority, {
        steerId,
        targetAgentId,
        threadId: execution.threadId,
        turnId: execution.turnId,
        text,
      });
      if (!this.#guardCurrent(guard)) return;
      const clearSubmittedDraft = this.#state.selectedAgentId === targetAgentId
        && this.#state.draft === draftAtSubmit
        && this.#readDraftRecord(guard.authority.projectId, targetAgentId).revision === draftRevisionAtSubmit;
      if (clearSubmittedDraft) this.#writeDraft(guard.authority.projectId, targetAgentId, '');
      const current = this.#state.executions[targetAgentId];
      this.#set({
        draft: clearSubmittedDraft ? '' : this.#state.draft,
        sending: false,
        conversationAction: null,
        turnMutationAcceptedTurnKey: turnKey,
        notice: userMessage('steer_sent'),
        executions: current ? {
          ...this.#state.executions,
          [targetAgentId]: { ...current, updatedAt: this.#observedAt() },
        } : this.#state.executions,
      });
      if (this.#state.selectedAgentId === targetAgentId) await this.loadConversation(targetAgentId);
    } catch (error) {
      if (!this.#guardCurrent(guard)) return;
      const outcomeUnknown = isOutcomeUnknownError(error);
      this.#set({
        sending: false,
        conversationAction: null,
        turnMutationOutcomeUnknownTurnKey: outcomeUnknown ? turnKey : this.#state.turnMutationOutcomeUnknownTurnKey,
        error: outcomeUnknown
          ? userMessage('steer_outcome_unknown')
          : displayError(error),
        executions: {
          ...this.#state.executions,
          [targetAgentId]: execution,
        },
      });
    }
  }

  async interruptActiveTurn(): Promise<void> {
    const guard = this.#guard();
    const targetAgentId = this.#state.selectedAgentId;
    const execution = targetAgentId ? selectSelectedExecution(this.#state) : null;
    const turnKey = execution?.threadId && execution.turnId
      ? `${execution.threadId}:${execution.turnId}` : null;
    if (!guard || !targetAgentId || this.#state.sending || !execution?.canInterrupt || !execution.threadId || !execution.turnId
      || this.#state.turnMutationAcceptedTurnKey === turnKey
      || this.#state.turnMutationOutcomeUnknownTurnKey === turnKey) return;
    this.#set({
      sending: true,
      conversationAction: 'stop',
      error: null,
      notice: null,
      executions: {
        ...this.#state.executions,
        [targetAgentId]: {
          ...execution,
          phase: 'stopping',
          updatedAt: this.#observedAt(),
          canInterrupt: false,
        },
      },
    });
    try {
      await this.#client.interruptTurn(guard.authority, {
        targetAgentId,
        threadId: execution.threadId,
        turnId: execution.turnId,
      });
      if (!this.#guardCurrent(guard)) return;
      const current = this.#state.executions[targetAgentId];
      if (current?.executionId === execution.executionId) {
        this.#set({ sending: false, conversationAction: null, notice: userMessage('stop_accepted') });
      } else {
        this.#set({ sending: false, conversationAction: null });
      }
    } catch (error) {
      if (!this.#guardCurrent(guard)) return;
      const current = this.#state.executions[targetAgentId];
      if (current?.executionId !== execution.executionId) {
        this.#set({ sending: false, conversationAction: null });
        return;
      }
      const outcomeUnknown = isOutcomeUnknownError(error);
      this.#set({
        sending: false,
        conversationAction: null,
        turnMutationOutcomeUnknownTurnKey: outcomeUnknown ? turnKey : this.#state.turnMutationOutcomeUnknownTurnKey,
        error: outcomeUnknown
          ? userMessage('stop_outcome_unknown')
          : displayError(error),
        executions: outcomeUnknown ? this.#state.executions
          : { ...this.#state.executions, [targetAgentId]: execution },
      });
    }
  }

  async respondToApproval(attentionId: string, decision: string): Promise<void> {
    const guard = this.#guard();
    if (!guard || this.#state.actionPendingId) return;
    const restored = this.#state.projectedPendingRequests.find((item) => item.requestKey === attentionId);
    const simpleDecision = ['accept', 'acceptForSession', 'decline', 'cancel'].includes(decision);
    if (!restored || restored.recoveryState !== 'actionable' || !simpleDecision || !restored.responseOptions.includes(decision)) {
      this.#set({
        error: restored?.responsePhase === 'outcome_unknown'
          ? userMessage('approval_outcome_unknown')
          : userMessage('approval_stale'),
      });
      return;
    }
    this.#set({ actionPendingId: attentionId, error: null });
    try {
      await this.#client.respondToApproval(guard.authority, attentionId, decision);
      if (!this.#guardCurrent(guard)) return;
      await this.loadConversation();
      if (this.#guardCurrent(guard)) this.#set({ actionPendingId: null, notice: userMessage('approval_recorded') });
    } catch (error) {
      if (!this.#guardCurrent(guard)) return;
      if (!isOutcomeUnknownError(error)) {
        this.#set({ actionPendingId: null, error: displayError(error) });
        return;
      }
      await this.loadConversation();
      if (this.#guardCurrent(guard)) {
        this.#set({ actionPendingId: null, error: userMessage('approval_outcome_unknown') });
      }
    }
  }

  async startInspection(kind: StartInspectionInput['kind'], focus: string | null): Promise<void> {
    const guard = this.#guard();
    if (!guard || this.#state.actionPendingId) return;
    const pendingId = `inspection:${kind}`;
    this.#set({ actionPendingId: pendingId, error: null });
    try {
      await this.#client.startInspection(guard.authority, { kind, focus });
      if (!this.#guardCurrent(guard)) return;
      await this.#refreshSnapshot(guard);
      if (this.#guardCurrent(guard)) this.#set({ actionPendingId: null, notice: userMessage('inspection_started') });
    } catch (error) {
      if (this.#guardCurrent(guard)) this.#set({ actionPendingId: null, error: displayError(error) });
    }
  }

  async cancelInspection(runId: string): Promise<void> {
    const guard = this.#guard();
    if (!guard || this.#state.actionPendingId) return;
    this.#set({ actionPendingId: runId, error: null });
    try {
      await this.#client.cancelInspection(guard.authority, runId);
      if (!this.#guardCurrent(guard)) return;
      await this.#refreshSnapshot(guard);
      if (this.#guardCurrent(guard)) this.#set({ actionPendingId: null });
    } catch (error) {
      if (this.#guardCurrent(guard)) this.#set({ actionPendingId: null, error: displayError(error) });
    }
  }

  async refreshWorkflowCatalog(): Promise<void> {
    const guard = this.#workspaceSideLoadGuard();
    if (!guard) return;
    await this.#requestWorkflowCatalog(guard, 'join', true);
  }

  #requestWorkflowCatalog(
    guard: OperationGuard,
    mode: 'join' | 'refresh_after_current',
    surfaceError: boolean,
  ): Promise<void> {
    return this.#workspaceLoads.run('workflow', this.#workspaceLoadOwnerKey(guard), mode, async () => {
      if (!this.#guardCurrent(guard)) return;
      this.#set({ workflowLoading: true, ...(surfaceError ? { error: null } : {}) });
      try {
        const catalog = await this.#client.readWorkflowCatalog(guard.authority);
        if (this.#guardCurrent(guard)) this.#set({ workflowCatalog: catalog });
      } catch (error) {
        if (this.#guardCurrent(guard) && surfaceError) this.#set({ error: displayError(error) });
      } finally {
        if (this.#guardCurrent(guard)) this.#set({ workflowLoading: false });
      }
    });
  }

  async saveWorkflowDefinition(input: {
    workflowId: string | null;
    name: string;
    prompt: string;
    checks: WorkflowCheck[];
  }): Promise<void> {
    const guard = this.#guard();
    if (!guard || this.#state.actionPendingId) return;
    this.#set({ actionPendingId: input.workflowId ?? 'workflow:new', error: null });
    try {
      await this.#client.saveWorkflowDefinition(guard.authority, input);
      if (!this.#guardCurrent(guard)) return;
      const refreshGuard = this.#workspaceSideLoadGuard();
      if (refreshGuard) await this.#requestWorkflowCatalog(refreshGuard, 'refresh_after_current', true);
      if (this.#guardCurrent(guard)) this.#set({ actionPendingId: null, notice: userMessage('workflow_saved') });
    } catch (error) {
      if (this.#guardCurrent(guard)) this.#set({ actionPendingId: null, error: displayError(error) });
    }
  }

  async startWorkflowBatch(workflowId: string, repetitions: number): Promise<void> {
    const guard = this.#guard();
    if (!guard || this.#state.actionPendingId) return;
    this.#set({ actionPendingId: `workflow:${workflowId}`, error: null });
    try {
      await this.#client.startWorkflowBatch(guard.authority, workflowId, repetitions);
      if (!this.#guardCurrent(guard)) return;
      const refreshGuard = this.#workspaceSideLoadGuard();
      if (refreshGuard) await this.#requestWorkflowCatalog(refreshGuard, 'refresh_after_current', true);
      if (this.#guardCurrent(guard)) this.#set({ actionPendingId: null, notice: userMessage('workflow_started') });
    } catch (error) {
      if (this.#guardCurrent(guard)) this.#set({ actionPendingId: null, error: displayError(error) });
    }
  }

  async cancelWorkflowBatch(batchId: string): Promise<void> {
    const guard = this.#guard();
    if (!guard || this.#state.actionPendingId) return;
    this.#set({ actionPendingId: batchId, error: null });
    try {
      await this.#client.cancelWorkflowBatch(guard.authority, batchId);
      if (!this.#guardCurrent(guard)) return;
      const refreshGuard = this.#workspaceSideLoadGuard();
      if (refreshGuard) await this.#requestWorkflowCatalog(refreshGuard, 'refresh_after_current', true);
      if (this.#guardCurrent(guard)) this.#set({ actionPendingId: null });
    } catch (error) {
      if (this.#guardCurrent(guard)) this.#set({ actionPendingId: null, error: displayError(error) });
    }
  }

  async readWorkflowResult(batchId: string, attemptId: string): Promise<string | null> {
    const guard = this.#readGuard();
    if (!guard) return null;
    try {
      const result = await this.#client.readWorkflowResult(guard.authority, batchId, attemptId);
      return this.#guardCurrent(guard) ? result : null;
    } catch (error) {
      if (this.#guardCurrent(guard)) this.#set({ error: displayError(error) });
      return null;
    }
  }

  async reconcileDispatchRecovery(): Promise<void> {
    const renderer = this.#state.rendererAuthority;
    const recovery = this.#state.dispatchRecovery;
    if (!renderer || !recovery || recovery.projectId !== this.#state.selectedProjectId
      || this.#state.recoveryPending) return;
    const epoch = this.#rendererEpoch;
    const authority = this.#state.runtimeAuthority?.projectId === recovery.projectId ? this.#state.runtimeAuthority : null;
    if (recovery.kind !== 'cleanup_pending' && !authority) {
      this.#set({ notice: userMessage('recovery_open_project') });
      return;
    }
    this.#set({ recoveryPending: true, error: null });
    try {
      const result = await this.#client.reconcileDispatchRecovery(renderer, recovery, authority);
      if (!this.#rendererGuardCurrent(renderer, epoch)) return;
      this.#set({
        recoveryPending: false,
        dispatchRecovery: result.recovery,
        notice: result.outcome === 'accepted' ? userMessage('recovery_message_sent')
          : result.outcome === 'definitive_failure' ? userMessage('recovery_send_failed_cleaned')
            : null,
      });
    } catch (error) {
      if (!this.#rendererGuardCurrent(renderer, epoch)) return;
      // The reconcile response can be lost after its durable write. Re-read before showing a false failure.
      try {
        const current = await this.#client.readDispatchRecovery(renderer);
        if (!this.#rendererGuardCurrent(renderer, epoch)) return;
        if (current && current.projectId !== recovery.projectId) {
          this.#set({ recoveryPending: false, error: userMessage('recovery_update_failed') });
          return;
        }
        if (!current || current.dispatchId !== recovery.dispatchId || current.kind === 'accepted') {
          this.#set({ recoveryPending: false, dispatchRecovery: current, notice: userMessage('recovery_checked') });
          return;
        }
      } catch { /* retain reconcile error */ }
      this.#set({ recoveryPending: false, error: displayError(error) });
    }
  }

  async #refreshSnapshot(guard: OperationGuard | null): Promise<boolean> {
    if (!guard || !this.#guardCurrent(guard)) return false;
    const snapshotTicket = this.#snapshotTicket;
    const runtimeSnapshot = await this.#client.readSnapshot(guard.authority);
    if (!this.#guardCurrent(guard)) return false;
    if (snapshotTicket !== this.#snapshotTicket) {
      return this.#state.snapshot?.project.id === guard.authority.projectId;
    }
    if (runtimeSnapshot.project.id !== guard.authority.projectId) return false;
    const snapshot = withRegisteredProjectTitle(runtimeSnapshot, this.#state.projects);
    const selectedAgentId = this.#state.selectedAgentId && snapshot.agents.some((agent) => agent.id === this.#state.selectedAgentId)
      ? this.#state.selectedAgentId
      : preferredWorkAgentId(snapshot, this.#state.projects);
    this.#snapshotTicket += 1;
    this.#set({ snapshot });
    const selectionChanged = this.#applySnapshotAgentSelection(snapshot, selectedAgentId);
    if (selectionChanged && selectedAgentId
      && this.#state.projectBootstrap?.status === 'ready') {
      void this.loadConversation(selectedAgentId);
    }
    return true;
  }

  #applySnapshotAgentSelection(
    snapshot: WorkspaceSnapshot,
    selectedAgentId: string | null,
  ): boolean {
    const previousAgentId = this.#state.selectedAgentId;
    const supportAgentId = this.#state.supportAgentId;
    if (supportAgentId && !snapshot.agents.some((agent) => agent.id === supportAgentId)) {
      this.closeSupport();
    }
    if (selectedAgentId === previousAgentId) {
      this.#set({ draft: this.#readDraft(snapshot.project.id, selectedAgentId) });
      return false;
    }
    if (selectedAgentId) this.#selectAgentLocally(selectedAgentId);
    else this.#clearSelectedAgentLocally();
    return true;
  }

  async refreshBusinessWorkOrders(): Promise<void> {
    const guard = this.#workspaceSideLoadGuard();
    if (!guard) return;
    await this.#requestBusinessWorkOrders(guard, 'join', null, this.#state.businessCursor);
  }

  async loadMoreBusinessWorkOrders(): Promise<void> {
    const guard = this.#workspaceSideLoadGuard();
    const afterKey = this.#state.businessNextAfterKey;
    const cursor = this.#state.businessCursor;
    if (!guard || !afterKey || !cursor) return;
    await this.#requestBusinessWorkOrders(guard, 'join', afterKey, cursor);
  }

  #requestBusinessWorkOrders(
    guard: OperationGuard,
    mode: 'join' | 'refresh_after_current',
    afterKey: string | null,
    afterCursor: BusinessSourceCursor | null,
  ): Promise<void> {
    return this.#workspaceLoads.run('business', this.#workspaceLoadOwnerKey(guard), mode, async () => {
      if (!this.#guardCurrent(guard)) return;
      this.#set({ businessLoading: true });
      await this.#readBusinessWorkOrders(guard, afterKey, afterCursor);
      if (this.#guardCurrent(guard)) this.#set({ businessLoading: false });
    });
  }

  async #readBusinessWorkOrders(
    guard: OperationGuard,
    afterKey: string | null,
    afterCursor: BusinessSourceCursor | null,
  ): Promise<void> {
    try {
      const result = await this.#client.readBusinessWorkOrders(guard.authority, { afterCursor, afterKey });
      if (!this.#guardCurrent(guard)) return;
      if (result.runtimeProjectId !== guard.authority.projectId) throw new Error('Business result belongs to another project.');
      if (afterKey && (result.continuity !== 'unchanged'
        || !afterCursor
        || JSON.stringify(result.cursor) !== JSON.stringify(afterCursor))) {
        await this.#readBusinessWorkOrders(guard, null, afterCursor);
        return;
      }
      const items = afterKey
        ? [...new Map([...this.#state.businessWorkOrders, ...result.items]
          .map((item) => [item.key, item])).values()]
        : result.items;
      this.#set({
        businessWorkOrders: items,
        businessCursor: result.cursor,
        businessNextAfterKey: result.nextAfterKey,
        businessRecoveryRequired: false,
      });
    } catch (error) {
      if (!this.#guardCurrent(guard)) return;
      const code = error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code ?? '') : '';
      this.#set({
        businessRecoveryRequired: code === 'BUSINESS_DESKTOP_SOURCE_RECOVERY_REQUIRED',
      });
    }
  }

  #startWorkspaceSideLoads(preparationGuard: OperationGuard): void {
    if (!this.#guardCurrent(preparationGuard)) return;
    const guard = this.#workspaceSideLoadGuard();
    if (!guard) return;
    // These projections share a runtime owner, not a status revision or an
    // ordering dependency. Start them independently so a slow attention read or
    // an ordinary same-runtime status update cannot permanently suppress the
    // remaining workspace data.
    void Promise.allSettled([
      this.#requestBusinessWorkOrders(guard, 'join', null, this.#state.businessCursor),
      this.#requestWorkflowCatalog(guard, 'join', false),
    ]);
    const agentId = this.#state.selectedAgentId;
    if (agentId) void this.loadConversation(agentId);
    else this.#markUserSignalBaselinePart('conversation');
    void this.loadHistoryIndex(null, true, this.#state.route !== 'history');
  }

  #onClientEvent(event: DesktopEvent): void {
    if (this.#disposed) return;
    if (event.type === 'voice_status') {
      this.#acceptVoiceStatus(event.status);
      return;
    }
    if (event.type === 'status') {
      this.#acceptStatus(event.status);
      return;
    }
    if (event.type === 'runtime') {
      const notification = event.event.notification;
      if (event.event.type === 'runtime.notification' && isRecord(notification)
        && notification.kind === 'provider_connection') {
        // Pending-request actionability depends on the live connection, even
        // when the durable conversation has not changed. Reuse its local read;
        // connection metadata does not belong in the history journal.
        const selected = this.#state.selectedAgentId;
        const support = this.#state.supportAgentId;
        if (selected) void this.loadConversation(selected);
        if (support && support !== selected) void this.loadSupportConversation(support);
      }
      return;
    }
    if (event.type === 'snapshot') {
      const authority = this.#state.runtimeAuthority;
      if (authority && event.snapshot.project.id === authority.projectId) {
        const snapshot = withRegisteredProjectTitle(event.snapshot, this.#state.projects);
        const selectedAgentId = this.#state.selectedAgentId
          && snapshot.agents.some((agent) => agent.id === this.#state.selectedAgentId)
          ? this.#state.selectedAgentId
          : preferredWorkAgentId(snapshot, this.#state.projects);
        this.#snapshotTicket += 1;
        this.#set({
          snapshot,
          projectStartPending: snapshot.agents.length > 0 ? false : this.#state.projectStartPending,
        });
        if (this.#applySnapshotAgentSelection(snapshot, selectedAgentId) && selectedAgentId) {
          void this.loadConversation(selectedAgentId);
        }
      }
      return;
    }
    if (event.type === 'dispatch_recovery') {
      if (event.projectId === this.#state.selectedProjectId
        && (!event.recovery || event.recovery.projectId === event.projectId)
        && (event.recovery || !event.clearedDispatchId
          || this.#state.dispatchRecovery?.dispatchId === event.clearedDispatchId)) {
        this.#set({ dispatchRecovery: event.recovery });
      }
      return;
    }
    if (event.type === 'projection_changed') {
      if (event.projectId !== this.#state.runtimeAuthority?.projectId) return;
      const selected = this.#state.selectedAgentId;
      const support = this.#state.supportAgentId;
      if (selected) void this.loadConversation(selected);
      if (support && support !== selected) void this.loadSupportConversation(support);
      const summaryOnly = this.#state.route !== 'history';
      if (this.#state.historyLoading) this.#queueHistoryRefresh(summaryOnly ? 'summary' : 'preserve');
      else void this.loadHistoryIndex(null, true, summaryOnly);
      return;
    }
    if (event.type === 'projection_status') {
      if (event.projectId === this.#state.runtimeAuthority?.projectId) {
        this.#set({ error: userMessage('conversation_save_failed') });
      }
      return;
    }
    if (event.type === 'workflow_catalog') {
      this.#set({ workflowCatalog: event.catalog });
    }
  }

  #acceptVoiceStatus(status: VoiceStatus): void {
    const current = this.#state.voiceStatus;
    if (current && status.revision <= current.revision) return;
    this.#set({ voiceStatus: status });
    this.#reconcileVoiceOperations(status);
  }

  #reconcileVoiceOperations(status: VoiceStatus): void {
    const activeRef = this.#state.voiceActiveOperationRef;
    const active = activeRef
      ? status.operations.find((operation) => operation.operationRef === activeRef) ?? null
      : null;
    if (active) this.#reconcileActiveVoiceOperation(active);

    for (const operation of status.operations) {
      if (operation.phase === 'cancelled' || operation.phase === 'failed') {
        this.#voiceSettledUnacked.add(operation.operationRef);
      }
      const inserted = this.#voiceInsertedUnacked.get(operation.operationRef);
      if (inserted && operation.phase === 'transcribed') {
        if (this.#state.voiceError) this.#set({ voiceError: null });
        if (inserted.consumedByUser) void this.#acknowledgeVoiceOperation(operation.operationRef);
      }
    }

    for (const operationRef of this.#voiceInsertedUnacked.keys()) {
      if (!status.operations.some((operation) => operation.operationRef === operationRef)) {
        this.#voiceInsertedUnacked.delete(operationRef);
      }
    }

    for (const operationRef of this.#voiceSettledUnacked) {
      if (status.operations.some((operation) => operation.operationRef === operationRef)) {
        void this.#acknowledgeVoiceOperation(operationRef);
      }
    }

    if (this.#state.voiceActiveOperationRef) return;
    const recovered = status.operations.find((operation) => (
      (operation.phase === 'transcribed' || operation.phase === 'recovery_required')
      && Boolean(operation.transcript)
      && !this.#voiceInsertedUnacked.has(operation.operationRef)
      && !this.#voiceSettledUnacked.has(operation.operationRef)
    ));
    if (recovered?.transcript) this.#restoreVoiceTranscript(recovered, true);
  }

  #reconcileActiveVoiceOperation(operation: VoiceOperationStatus): void {
    const operationRef = operation.operationRef;
    if (operation.phase === 'staging' || operation.phase === 'transcribing') {
      if (this.#state.voiceCapturePhase !== 'cancelling') {
        this.#set({ voiceCapturePhase: 'transcribing', voiceError: null });
      }
      return;
    }
    if (operation.phase === 'transcribed' && operation.transcript) {
      this.#stopVoiceTerminalWatcher(operationRef);
      void this.#finalizeCurrentVoiceTranscript(operation);
      return;
    }
    if (operation.phase === 'recovery_required') {
      this.#stopVoiceTerminalWatcher(operationRef);
      if (operation.transcript) this.#restoreVoiceTranscript(operation, false);
      else {
        this.#voiceDraftCaptures.delete(operationRef);
        this.#set({
          voiceActiveOperationRef: null,
          voiceSendIntentOperationRef: null,
          voiceCapturePhase: 'idle',
          voiceError: userMessage('voice_recovery_wait'),
        });
      }
      return;
    }
    if (operation.phase === 'failed' || operation.phase === 'cancelled') {
      this.#stopVoiceTerminalWatcher(operationRef);
      this.#voiceDraftCaptures.delete(operationRef);
      this.#set({
        voiceActiveOperationRef: null,
        voiceSendIntentOperationRef: null,
        voiceCapturePhase: 'idle',
          voiceError: operation.phase === 'cancelled'
          ? null : userMessage('voice_transcription_failed'),
      });
    }
  }

  async #finalizeCurrentVoiceTranscript(operation: VoiceOperationStatus): Promise<void> {
    const operationRef = operation.operationRef;
    if (this.#voiceFinalizingOperationRef === operationRef) return;
    const capture = this.#voiceDraftCaptures.get(operationRef) ?? null;
    if (!capture) {
      this.#restoreVoiceTranscript(operation, true);
      return;
    }
    this.#voiceFinalizingOperationRef = operationRef;
    try {
      const binding = await this.#voiceBindingForCapture(capture);
      const currentOperation = this.#state.voiceStatus?.operations
        .find((candidate) => candidate.operationRef === operationRef);
      if (this.#state.voiceActiveOperationRef !== operationRef
        || currentOperation?.phase !== 'transcribed'
        || !currentOperation.transcript
        || !sameVoiceBinding(currentOperation.composerBinding, statusBindingFor(binding))
        || !this.#voiceCaptureCurrent(capture)
        || !this.commitComposerTranscript(capture, currentOperation.transcript)) {
        this.#restoreVoiceTranscript(currentOperation ?? operation, false);
        return;
      }
      const sendAfterInsert = this.#state.voiceSendIntentOperationRef === operationRef;
      const insertedRevision = capture.target === 'launcher'
        ? this.#launcherDraftRevision
        : this.#readDraftRecord(capture.projectId, capture.agentId).revision;
      for (const claim of this.#voiceInsertedUnacked.values()) {
        const sameTarget = capture.target === 'launcher'
          ? claim.ackTarget === null && claim.binding.state === 'launcher'
          : claim.ackTarget?.projectId === capture.projectId
            && claim.ackTarget.agentId === capture.agentId;
        if (sameTarget && claim.draftRevision === capture.draftRevision) {
          claim.draftRevision = insertedRevision;
        }
      }
      this.#voiceDraftCaptures.delete(operationRef);
      this.#voiceInsertedUnacked.set(operationRef, {
        binding: currentOperation.composerBinding,
        ackTarget: capture.target === 'agent'
          ? { projectId: capture.projectId, agentId: capture.agentId }
          : null,
        draftRevision: insertedRevision,
        consumedByUser: false,
      });
      this.#set({
        voiceActiveOperationRef: null,
        voiceSendIntentOperationRef: null,
        voiceCapturePhase: 'idle',
        voiceError: null,
      });
      if (sendAfterInsert && currentOperation.composerBinding.state === 'agent') {
        await this.sendMessage();
      }
    } catch (error) {
      this.#restoreVoiceTranscript(operation, false, displayError(error));
    } finally {
      if (this.#voiceFinalizingOperationRef === operationRef) this.#voiceFinalizingOperationRef = null;
    }
  }

  #restoreVoiceTranscript(operation: VoiceOperationStatus, recoveredAfterRestart: boolean, fallbackError?: UserMessage): void {
    this.#voiceDraftCaptures.delete(operation.operationRef);
    const transcript = operation.transcript?.trim() ?? '';
    if (!transcript || this.#voiceInsertedUnacked.has(operation.operationRef)) return;
    const append = (draft: string) => appendVoiceTranscript(draft, transcript);
    let ackTarget: InsertedVoiceClaim['ackTarget'] = null;
    let draftRevision = 0;
    const selectedProjectId = this.#state.selectedProjectId;
    const selectedAgentId = this.#state.selectedAgentId;
    const binding = operation.composerBinding;
    if (binding.state === 'agent') {
      const restored = append(this.#readDraft(binding.projectId, binding.agentId));
      if (restored === null) {
        this.#set({ voiceActiveOperationRef: null, voiceSendIntentOperationRef: null, voiceCapturePhase: 'idle', voiceError: userMessage('voice_transcript_too_large') });
        return;
      }
      const next = this.#writeDraft(binding.projectId, binding.agentId, restored);
      ackTarget = { projectId: binding.projectId, agentId: binding.agentId };
      draftRevision = next.revision;
      if (selectedProjectId === binding.projectId && selectedAgentId === binding.agentId) {
        this.#set({ draft: next.text });
      }
    } else if (selectedProjectId && selectedAgentId) {
      const restored = append(this.#readDraft(selectedProjectId, selectedAgentId));
      if (restored === null) {
        this.#set({ voiceActiveOperationRef: null, voiceSendIntentOperationRef: null, voiceCapturePhase: 'idle', voiceError: userMessage('voice_transcript_too_large') });
        return;
      }
      const next = this.#writeDraft(selectedProjectId, selectedAgentId, restored);
      ackTarget = { projectId: selectedProjectId, agentId: selectedAgentId };
      draftRevision = next.revision;
      this.#set({ draft: next.text });
    } else {
      const restored = append(this.#launcherDraft);
      if (restored === null) {
        this.#set({ voiceActiveOperationRef: null, voiceSendIntentOperationRef: null, voiceCapturePhase: 'idle', voiceError: userMessage('voice_transcript_too_large') });
        return;
      }
      this.#launcherDraft = restored;
      this.#launcherDraftRevision += 1;
      draftRevision = this.#launcherDraftRevision;
      this.#set({ draft: this.#launcherDraft });
    }
    this.#voiceInsertedUnacked.set(operation.operationRef, {
      binding, ackTarget, draftRevision, consumedByUser: false,
    });
    this.#set({
      voiceActiveOperationRef: null,
      voiceSendIntentOperationRef: null,
      voiceCapturePhase: 'idle',
      voiceError: operation.phase === 'recovery_required'
        ? userMessage('voice_recovery_draft')
        : fallbackError ?? null,
      notice: recoveredAfterRestart
        ? userMessage('voice_restored_after_restart')
        : userMessage('voice_restored'),
    });
  }

  async #acknowledgeVoiceOperation(operationRef: string): Promise<void> {
    if (this.#voiceAckPending.has(operationRef)) return;
    const renderer = this.#state.rendererAuthority;
    if (!renderer) return;
    const epoch = this.#rendererEpoch;
    this.#voiceAckPending.add(operationRef);
    try {
      const status = await this.#client.acknowledgeVoiceTranscription(renderer, operationRef);
      if (!this.#rendererGuardCurrent(renderer, epoch)) return;
      this.#voiceSettledUnacked.delete(operationRef);
      this.#voiceInsertedUnacked.delete(operationRef);
      this.#acceptVoiceStatus(status);
    } catch (error) {
      if (!this.#rendererGuardCurrent(renderer, epoch)) return;
      try {
        const status = await this.#client.readVoiceStatus(renderer);
        if (!this.#rendererGuardCurrent(renderer, epoch)) return;
        const operationRemains = status.operations.some((operation) => operation.operationRef === operationRef);
        if (!operationRemains) {
          this.#voiceSettledUnacked.delete(operationRef);
          this.#voiceInsertedUnacked.delete(operationRef);
          this.#acceptVoiceStatus(status);
          this.#set({ voiceError: null });
          return;
        }
        this.#acceptVoiceStatus(status);
        this.#set({ voiceError: displayError(error) });
      } catch (readError) {
        if (this.#rendererGuardCurrent(renderer, epoch)) {
          this.#set({ voiceError: userMessage('voice_ack_state_failed') });
        }
      }
    } finally {
      this.#voiceAckPending.delete(operationRef);
    }
  }

  #consumeEditedVoiceClaims(
    projectId: string | null,
    agentId: string | null,
    previousRevision: number,
    nextRevision: number,
  ): void {
    for (const [operationRef, claim] of this.#voiceInsertedUnacked) {
      const sameTarget = projectId && agentId
        ? claim.ackTarget?.projectId === projectId && claim.ackTarget.agentId === agentId
        : claim.ackTarget === null;
      if (!sameTarget || claim.draftRevision !== previousRevision) continue;
      claim.draftRevision = nextRevision;
      claim.consumedByUser = true;
      const operation = this.#state.voiceStatus?.operations
        .find((candidate) => candidate.operationRef === operationRef);
      if (operation?.phase === 'transcribed') void this.#acknowledgeVoiceOperation(operationRef);
    }
  }

  #startVoiceTerminalWatcher(operationRef: string, renderer: RendererAuthority, epoch: number): void {
    if (!this.#rendererGuardCurrent(renderer, epoch)
      || this.#state.voiceActiveOperationRef !== operationRef) return;
    const current = this.#voiceTerminalWatcher;
    if (current
      && current.operationRef === operationRef
      && current.epoch === epoch
      && sameRendererAuthority(current.renderer, renderer)
      && !current.controller.signal.aborted) return;
    this.#stopVoiceTerminalWatcher();
    const watcher: VoiceTerminalWatcher = {
      operationRef,
      renderer,
      epoch,
      controller: new AbortController(),
    };
    this.#voiceTerminalWatcher = watcher;
    void this.#watchVoiceTerminalStatus(watcher);
  }

  #stopVoiceTerminalWatcher(operationRef?: string): void {
    const watcher = this.#voiceTerminalWatcher;
    if (!watcher || (operationRef && watcher.operationRef !== operationRef)) return;
    this.#voiceTerminalWatcher = null;
    watcher.controller.abort();
  }

  #voiceTerminalWatcherCurrent(watcher: VoiceTerminalWatcher): boolean {
    return this.#voiceTerminalWatcher === watcher
      && !watcher.controller.signal.aborted
      && this.#rendererGuardCurrent(watcher.renderer, watcher.epoch)
      && this.#state.voiceActiveOperationRef === watcher.operationRef;
  }

  async #watchVoiceTerminalStatus(watcher: VoiceTerminalWatcher): Promise<void> {
    const deadline = Date.now() + VOICE_STATUS_WATCH_DEADLINE_MS;
    let delayMs = VOICE_STATUS_WATCH_INITIAL_DELAY_MS;
    let lastReadError: unknown = null;
    try {
      while (this.#voiceTerminalWatcherCurrent(watcher) && Date.now() < deadline) {
        const remainingMs = deadline - Date.now();
        if (!await waitForVoiceStatusPoll(Math.min(delayMs, remainingMs), watcher.controller.signal)) return;
        if (!this.#voiceTerminalWatcherCurrent(watcher)) return;
        try {
          const status = await this.#client.readVoiceStatus(watcher.renderer);
          if (!this.#voiceTerminalWatcherCurrent(watcher)) return;
          lastReadError = null;
          this.#acceptVoiceStatus(status);
        } catch (error) {
          lastReadError = error;
        }
        delayMs = VOICE_STATUS_WATCH_INTERVAL_MS;
      }
      if (!this.#voiceTerminalWatcherCurrent(watcher)) return;
      try {
        const status = await this.#client.readVoiceStatus(watcher.renderer);
        if (!this.#voiceTerminalWatcherCurrent(watcher)) return;
        lastReadError = null;
        this.#acceptVoiceStatus(status);
      } catch (error) {
        lastReadError = error;
      }
      if (this.#voiceTerminalWatcherCurrent(watcher)) {
        this.#set({
          voiceError: lastReadError
            ? userMessage('voice_terminal_state_failed')
            : userMessage('voice_terminal_state_unknown'),
        });
      }
    } finally {
      if (this.#voiceTerminalWatcher === watcher) this.#voiceTerminalWatcher = null;
    }
  }

  #acceptStatus(
    status: RuntimeStatus,
    options: { selectedProjectId?: string; suppressUnexpectedStop?: boolean } = {},
  ): void {
    const current = this.#state.runtimeStatus;
    if (current && status.statusRevision < current.statusRevision) return;
    if (current && status.statusRevision === current.statusRevision) {
      // Status revisions are immutable; equal-revision conflicts cannot rewrite the owner.
      if (!sameRuntimeStatus(current, status)) return;
      return;
    }
    const changed = statusChanged(current, status);
    const incarnationChanged = !sameRuntimeIncarnation(current, status);
    const previousAuthority = this.#state.runtimeAuthority;
    const retiredAttachments = incarnationChanged ? this.#state.attachments : [];
    if (changed) this.#advanceEpoch();
    if (incarnationChanged) this.#snapshotTicket += 1;
    const renderer = this.#state.rendererAuthority;
    const rendererMatches = renderer && (!status.rendererSessionId || sameRendererAuthority(renderer, {
      rendererSessionId: status.rendererSessionId,
      rendererGeneration: status.rendererGeneration ?? -1,
    }));
    const authority = rendererMatches ? runtimeAuthorityFrom(status) : null;
    const selectedProjectId = options.selectedProjectId
      ?? (status.lifecycle === 'Stopped' ? null : this.#state.selectedProjectId ?? authority?.projectId ?? null);
    const unexpectedProject = Boolean(authority && selectedProjectId && authority.projectId !== selectedProjectId);
    const phase: ApplicationPhase = authority && !unexpectedProject ? 'workspace'
      : status.lifecycle === 'Starting' ? 'activating'
        : status.lifecycle === 'Stopping' ? 'stopping'
          : status.lifecycle === 'Failed' ? 'failed' : 'launcher';
    const preserveWorkspace = Boolean(authority && !unexpectedProject && !incarnationChanged);
    const preserveHistoryIdentity = Boolean(
      incarnationChanged
      && authority
      && !unexpectedProject
      && previousAuthority?.projectId === authority.projectId,
    );
    if (incarnationChanged) {
      this.#conversationCheckpoints.clear();
      this.#historyTicket += 1;
      this.#historyRefreshRequested = null;
    }
    if (!preserveWorkspace) this.#resetUserSignalsBaseline();
    this.#set({
      runtimeStatus: status,
      runtimeAuthority: unexpectedProject ? null : authority,
      selectedProjectId,
      phase,
      snapshot: preserveWorkspace && this.#state.snapshot?.project.id === authority?.projectId
        ? this.#state.snapshot : null,
      selectedAgentId: preserveWorkspace ? this.#state.selectedAgentId : null,
      messages: preserveWorkspace ? this.#state.messages : [],
      activities: preserveWorkspace ? this.#state.activities : [],
      conversationOlderCursor: preserveWorkspace ? this.#state.conversationOlderCursor : null,
      conversationOlderActivityCursor: preserveWorkspace ? this.#state.conversationOlderActivityCursor : null,
      conversationOlderPendingRequestCursor: preserveWorkspace
        ? this.#state.conversationOlderPendingRequestCursor
        : null,
      draft: preserveWorkspace ? this.#state.draft : '',
      attentionHistory: preserveWorkspace ? this.#state.attentionHistory : [],
      projectedPendingRequests: preserveWorkspace ? this.#state.projectedPendingRequests : [],
      attachments: preserveWorkspace ? this.#state.attachments : [],
      attachmentSelectionPending: false,
      attachmentRemovalPending: false,
      conversationLoading: false,
      conversationOlderLoading: false,
      sending: false,
      conversationAction: null,
      turnMutationAcceptedTurnKey: preserveWorkspace ? this.#state.turnMutationAcceptedTurnKey : null,
      turnMutationOutcomeUnknownTurnKey: preserveWorkspace ? this.#state.turnMutationOutcomeUnknownTurnKey : null,
      executions: preserveWorkspace ? this.#state.executions : {},
      supportAgentId: preserveWorkspace ? this.#state.supportAgentId : null,
      supportMessages: preserveWorkspace ? this.#state.supportMessages : [],
      supportConversationLoading: false,
      supportDraft: preserveWorkspace ? this.#state.supportDraft : '',
      supportSending: false,
      actionPendingId: null,
      recoveryPending: false,
      error: incarnationChanged ? null : this.#state.error,
      notice: incarnationChanged ? null : this.#state.notice,
      businessWorkOrders: preserveWorkspace ? this.#state.businessWorkOrders : [],
      businessCursor: preserveWorkspace ? this.#state.businessCursor : null,
      businessNextAfterKey: preserveWorkspace ? this.#state.businessNextAfterKey : null,
      businessLoading: preserveWorkspace ? this.#state.businessLoading : false,
      businessRecoveryRequired: preserveWorkspace ? this.#state.businessRecoveryRequired : false,
      workflowCatalog: preserveWorkspace ? this.#state.workflowCatalog : null,
      workflowLoading: preserveWorkspace ? this.#state.workflowLoading : false,
      projectStartPending: preserveWorkspace ? this.#state.projectStartPending : false,
      projectBootstrap: preserveWorkspace ? this.#state.projectBootstrap : null,
      historyConversations: preserveWorkspace || preserveHistoryIdentity
        ? this.#state.historyConversations : [],
      userSignalsBaselineReady: preserveWorkspace
        ? this.#state.userSignalsBaselineReady : false,
      historyIndexCursor: preserveWorkspace ? this.#state.historyIndexCursor : null,
      historySelectedAgentId: preserveWorkspace || preserveHistoryIdentity
        ? this.#state.historySelectedAgentId : null,
      historyQuery: preserveWorkspace || preserveHistoryIdentity ? this.#state.historyQuery : '',
      historyMessages: preserveWorkspace ? this.#state.historyMessages : [],
      historyCursor: preserveWorkspace ? this.#state.historyCursor : null,
      historyLoading: false,
      historyOlderLoading: false,
    });
    if (retiredAttachments.length > 0) this.#retireAttachments(previousAuthority, retiredAttachments);
    if (authority && !unexpectedProject && !this.#state.snapshot) {
      const guard = this.#runtimeGuard();
      if (guard) void this.#prepareSelectedProject(guard);
    }
    if (unexpectedProject && !options.suppressUnexpectedStop && authority) {
      this.#scheduleUnexpectedStop(authority, status.statusRevision);
    }
  }

  #scheduleUnexpectedStop(authority: RuntimeAuthority, statusRevision: number): void {
    if (this.#disposed || this.#unexpectedStopPending !== 0) return;
    const attempt = ++this.#unexpectedStopAttempt;
    this.#unexpectedStopPending = attempt;
    void this.#client.stopRuntime(authority, statusRevision)
      .then((stopped) => {
        if (this.#disposed || this.#unexpectedStopPending !== attempt) return;
        this.#acceptStatus(stopped, { suppressUnexpectedStop: true });
      })
      .catch((error) => {
        if (this.#disposed || this.#unexpectedStopPending !== attempt) return;
        const currentUnexpected = this.#state.runtimeStatus ? runtimeAuthorityFrom(this.#state.runtimeStatus) : null;
        if (sameRuntimeAuthority(currentUnexpected, authority)) {
          this.#set({ error: userMessage('unexpected_runtime_stop_failed') });
        }
      })
      .finally(() => {
        if (this.#unexpectedStopPending !== attempt) return;
        this.#unexpectedStopPending = 0;
        const status = this.#state.runtimeStatus;
        const currentUnexpected = status ? runtimeAuthorityFrom(status) : null;
        const selectedProjectId = this.#state.selectedProjectId;
        if (status && currentUnexpected && selectedProjectId
          && currentUnexpected.projectId !== selectedProjectId
          && (!sameRuntimeAuthority(currentUnexpected, authority) || status.statusRevision > statusRevision)
          && sameRendererAuthority(this.#state.rendererAuthority, currentUnexpected)) {
          // A second foreign activation can arrive while the exact stop is in flight.
          this.#scheduleUnexpectedStop(currentUnexpected, status.statusRevision);
        }
      });
  }

  #runtimeGuard(): OperationGuard | null {
    const renderer = this.#state.rendererAuthority;
    const authority = this.#state.runtimeAuthority;
    const status = this.#state.runtimeStatus;
    if (!renderer || !authority || !status || status.lifecycle !== 'Ready' || !status.runtimeGeneration) return null;
    return {
      scope: 'runtime_preparation', epoch: this.#epoch,
      renderer, authority, runtimeGeneration: status.runtimeGeneration,
      statusRevision: status.statusRevision,
    };
  }

  #guard(): OperationGuard | null {
    const guard = this.#runtimeGuard();
    if (!guard || !projectLifecycleAllowsUserMutation(selectProjectLifecycle(this.#state))) return null;
    return { ...guard, scope: 'ready_operation' };
  }

  #readGuard(): OperationGuard | null {
    const guard = this.#runtimeGuard();
    return guard ? { ...guard, scope: 'runtime_read' } : null;
  }

  #workspaceSideLoadGuard(): OperationGuard | null {
    const guard = this.#runtimeGuard();
    return guard ? { ...guard, scope: 'workspace_side_load' } : null;
  }

  #workspaceLoadOwnerKey(guard: OperationGuard): string {
    return [
      guard.renderer.rendererSessionId,
      guard.renderer.rendererGeneration,
      guard.authority.projectId,
      guard.authority.activationToken,
      guard.runtimeGeneration,
    ].join(':');
  }

  #guardCurrent(guard: OperationGuard): boolean {
    const sameOwner = !this.#disposed
      && this.#state.runtimeStatus?.lifecycle === 'Ready'
      && this.#state.runtimeStatus.runtimeGeneration === guard.runtimeGeneration
      && sameRendererAuthority(this.#state.rendererAuthority, guard.renderer)
      && sameRuntimeAuthority(this.#state.runtimeAuthority, guard.authority);
    if (!sameOwner) return false;
    return guard.scope === 'runtime_preparation' || guard.scope === 'workspace_side_load'
      || (guard.epoch === this.#epoch
        && this.#state.runtimeStatus?.statusRevision === guard.statusRevision);
  }

  #rendererGuardCurrent(renderer: RendererAuthority, epoch: number): boolean {
    return !this.#disposed && epoch === this.#rendererEpoch
      && sameRendererAuthority(this.#state.rendererAuthority, renderer);
  }

  #advanceEpoch(): void {
    this.#stopVoiceTerminalWatcher();
    this.#voiceDraftCaptures.clear();
    this.#voiceFinalizingOperationRef = null;
    this.#state = { ...this.#state, voiceSendIntentOperationRef: null };
    this.#epoch += 1;
    this.#conversationTicket += 1;
    this.#supportConversationTicket += 1;
  }

  #readDraft(projectId: string | null, agentId: string | null): string {
    return projectId && agentId ? this.#readDraftRecord(projectId, agentId).text : '';
  }

  #readDraftRecord(projectId: string, agentId: string): ComposerDraftRecord {
    return this.#drafts.get(draftKey(projectId, agentId)) ?? { text: '', revision: 0 };
  }

  #writeDraft(projectId: string, agentId: string, text: string): ComposerDraftRecord {
    const key = draftKey(projectId, agentId);
    const current = this.#drafts.get(key);
    if (current?.text === text) return current;
    const next = { text, revision: (current?.revision ?? 0) + 1 };
    this.#drafts.set(key, next);
    return next;
  }

  #beginProjectEntryIntent(
    kind: ProjectEntryIntent['kind'],
    sendAfterActivation: boolean,
    projectName: string | null,
  ): ProjectEntryIntent {
    const captureLauncherDraft = !this.#state.selectedAgentId
      && this.#state.phase !== 'activating' && this.#state.phase !== 'stopping';
    const draftText = captureLauncherDraft ? this.#launcherDraft : '';
    const draftRevision = this.#launcherDraftRevision;
    const existing = this.#projectEntryIntent;
    const sameStarterRetry = kind === 'starter'
      && existing?.kind === 'starter'
      && existing.projectName === projectName;
    if (existing && existing.phase !== 'consumed' && existing.phase !== 'retired'
      && existing.kind === kind && existing.projectName === projectName
      && (sameStarterRetry
        || (existing.draftRevision === draftRevision && existing.draftText === draftText))) {
      existing.sendAfterActivation = sendAfterActivation;
      return existing;
    }
    if (existing && existing.phase !== 'consumed') existing.phase = 'retired';
    const intent: ProjectEntryIntent = {
      entryIntentRef: this.#selectionId(),
      kind,
      operationRef: kind === 'starter' ? this.#selectionId() : null,
      projectName,
      draftText,
      draftRevision,
      targetDraftRevision: null,
      sendAfterActivation,
      phase: 'captured',
    };
    this.#projectEntryIntent = intent;
    return intent;
  }

  async #applyProjectEntryIntent(
    intent: ProjectEntryIntent,
    projectId: string,
    ticket: number,
  ): Promise<boolean> {
    if (this.#projectEntryIntent !== intent || intent.phase === 'retired'
      || this.#disposed || ticket !== this.#selectionTicket
      || this.#state.runtimeAuthority?.projectId !== projectId) return false;
    if (intent.draftRevision !== this.#launcherDraftRevision) {
      this.#set({ notice: userMessage('project_start_draft_preserved') });
      return false;
    }
    if (intent.phase === 'consumed') return true;
    const snapshot = this.#state.snapshot;
    if (!snapshot || this.#state.projectBootstrap?.status !== 'ready') return false;
    if (intent.phase === 'dispatch_started') return true;
    if (!intent.draftText && !intent.sendAfterActivation) {
      intent.phase = 'consumed';
      return true;
    }
    const agentId = selectCurrentUserOrchestratorId(snapshot);
    if (!agentId) return false;
    if (this.#state.selectedAgentId !== agentId) {
      this.#selectAgentLocally(agentId);
      void this.loadConversation(agentId);
    }
    const existingTarget = this.#readDraftRecord(projectId, agentId);
    intent.targetDraftRevision ??= existingTarget.revision;
    if (existingTarget.revision !== intent.targetDraftRevision
      || (existingTarget.text && existingTarget.text !== intent.draftText)) {
      this.#set({
        draft: existingTarget.text,
        notice: userMessage('project_entry_draft_conflict'),
      });
      return false;
    }
    const targetDraft = this.#writeDraft(projectId, agentId, intent.draftText);
    intent.phase = 'applied';
    for (const claim of this.#voiceInsertedUnacked.values()) {
      if (claim.binding.state === 'launcher'
        && claim.ackTarget === null
        && claim.draftRevision === intent.draftRevision) {
        claim.ackTarget = { projectId, agentId };
        claim.draftRevision = targetDraft.revision;
      }
    }
    this.#launcherDraft = '';
    this.#set({ draft: intent.draftText });
    if (intent.sendAfterActivation && intent.draftText.trim()) {
      intent.phase = 'dispatch_started';
      const dispatch = this.sendMessage();
      if (!this.#state.sending) {
        intent.phase = 'applied';
        return false;
      }
      await dispatch;
    }
    intent.phase = 'consumed';
    return true;
  }

  #retireAttachments(authority: RuntimeAuthority | null, attachments: ComposerAttachment[]): void {
    const selectionIds = new Set(attachments.map((attachment) => attachment.selectionId));
    selectionIds.forEach((selectionId) => { void this.#cleanupSelection(authority, selectionId); });
  }

  async #cleanupSelection(authority: RuntimeAuthority | null, selectionId: string): Promise<void> {
    this.#pendingSelectionCleanup.add(selectionId);
    try {
      await this.#client.abandonAttachmentSelection(authority, selectionId);
      this.#pendingSelectionCleanup.delete(selectionId);
    } catch {
      // Retained for the next coherent authority/bootstrap cleanup pass.
    }
  }

  async #retryPendingSelectionCleanup(authority: RuntimeAuthority | null): Promise<void> {
    await Promise.all([...this.#pendingSelectionCleanup].map((selectionId) => this.#cleanupSelection(authority, selectionId)));
  }

  #set(patch: Partial<ApplicationState>): void {
    if (this.#disposed) return;
    this.#state = { ...this.#state, ...patch };
    this.#notify();
  }

  #resetUserSignalsBaseline(): void {
    this.#userSignalBaselineParts.clear();
  }

  #markUserSignalBaselinePart(part: 'conversation' | 'summaries'): void {
    this.#userSignalBaselineParts.add(part);
    if (this.#userSignalBaselineParts.size === 2 && !this.#state.userSignalsBaselineReady) {
      this.#set({ userSignalsBaselineReady: true });
    }
  }

  #notify(): void {
    this.#listeners.forEach((listener) => {
      try { listener(); } catch { /* one observer cannot abort an authority transition */ }
    });
  }
}
