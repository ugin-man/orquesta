import type {
  ComposerAttachment,
  ConversationActivityCursor,
  ConversationCursor,
  ConversationReadCheckpoint,
  ConversationSnapshot,
  HistoryConversationPage,
  HistoryCursor,
  HistoryIndexPage,
  NativeSettings,
  DesktopBootstrap,
  DesktopEvent,
  DispatchSendResult,
  DispatchRecovery,
  DispatchRecoveryResult,
  ProjectSummary,
  ProjectBootstrapResult,
  RendererAuthority,
  RuntimeAuthority,
  RuntimePayloadEvent,
  RuntimeStatus,
  WorkspaceSnapshot,
  BusinessSourceCursor,
  BusinessWorkOrdersResult,
  WorkflowCatalog,
  WorkflowCheck,
  VoiceOperationStatus,
  VoiceStatus,
} from '../domain/models';
import { runtimeAuthorityFrom, sameRendererAuthority, sameRuntimeAuthority } from '../domain/models';
import {
  isRecord,
  parseBootstrap,
  parseDispatchRecovery,
  parseDispatchReconcileResult,
  parseNativeProjectSummary,
  parseNativeSettings,
  parseRuntimeStatus,
  parseWorkspaceSnapshot,
  parseBusinessWorkOrdersResult,
  BUSINESS_WORK_ORDER_REQUIRED_FEATURES,
  parseWorkflowCatalog,
  parseVoiceStatus,
} from '../domain/validation';
import {
  DispatchSendError,
  ClientDisposedError,
  RuntimeAuthorityError,
  type AttachmentBinarySource,
  type DesktopClient,
  type SendMessageInput,
  type StartInspectionInput,
  type VoiceTranscriptionBindingInput,
} from '../ports/desktop-client';
import {
  NATIVE_COMMANDS,
  NATIVE_EVENTS,
  defaultTransport,
  hasExactKeys,
  invokeNative,
  invokeNativeResult,
  unwrapResult,
  type TauriTransport,
} from './tauri/native-bridge';
import {
  abortError,
  cancelRendererSessionNative,
  createRendererIdentity,
  createUuidValue as createUuid,
  openRendererSessionNative,
  settleBestEffort,
  type RendererIdentity,
} from './tauri/session-transport';
import {
  dispatchMessageNative,
  interruptTurnNative,
  steerTurnNative,
  invokeRuntimeMethod,
  recoveryFromNativeError,
} from './tauri/runtime-transport';
import {
  matchesProjectionIncarnation,
  parseDispatchRecoveryCleared,
  parseProjectionChanged,
  parseProjectionFault,
  projectionIncarnationFromStatus,
  projectionReadRaced,
  projectionWatermarkIsSameOrOlder,
  readProjectionConversation,
  readProjectionHistoryIndex,
  readProjectionHistoryPage,
  sameProjectionIncarnation,
  type ProjectionWatermark,
} from './tauri/projection-transport';
import {
  abandonAttachmentSelectionNative,
  forgetAttachmentNative,
  importAttachmentsNative,
  readAttachmentPreviewNative,
} from './tauri/attachment-transport';
import {
  acknowledgeVoiceTranscriptionNative,
  acquireVoiceAssetNative,
  cancelVoiceAssetAcquisitionNative,
  cancelVoiceTranscriptionNative,
  deleteVoiceAssetNative,
  readVoiceStatusNative,
  transcribeVoicePcmNative,
} from './tauri/voice-transport';

export type { TauriEvent, TauriTransport } from './tauri/native-bridge';

interface PendingRuntimeEvent extends RuntimePayloadEvent {
  event: unknown;
}

interface RendererOperationGuard {
  renderer: RendererAuthority;
}

interface RuntimeOperationGuard extends RendererOperationGuard {
  authority: RuntimeAuthority;
  runtimeGeneration: string;
  statusRevision: number;
}

const MAX_PENDING_RUNTIME_EVENTS = 128;
const MAX_FOLLOW_UP_REFRESHES = 3;

function sameRuntimeStatus(left: RuntimeStatus, right: RuntimeStatus): boolean {
  return left.lifecycle === right.lifecycle
    && left.projectId === right.projectId
    && left.activationToken === right.activationToken
    && left.rendererSessionId === right.rendererSessionId
    && left.rendererGeneration === right.rendererGeneration
    && left.runtimeGeneration === right.runtimeGeneration
    && left.statusRevision === right.statusRevision
    && left.failureReason === right.failureReason;
}

function sameVoiceStatus(left: VoiceStatus, right: VoiceStatus): boolean {
  if (left.schemaVersion !== right.schemaVersion
    || left.revision !== right.revision
    || left.providerId !== right.providerId
    || left.binaryAssetId !== right.binaryAssetId
    || left.initialModelAssetId !== right.initialModelAssetId
    || left.comparisonModelAssetId !== right.comparisonModelAssetId
    || left.requiredAssetsReady !== right.requiredAssetsReady
    || left.assets.length !== right.assets.length
    || left.operations.length !== right.operations.length) return false;
  return left.assets.every((asset, index) => {
    const candidate = right.assets[index];
    return asset.assetId === candidate.assetId
      && asset.kind === candidate.kind
      && asset.phase === candidate.phase
      && asset.downloadedBytes === candidate.downloadedBytes
      && asset.expectedBytes === candidate.expectedBytes
      && asset.operationRef === candidate.operationRef
      && asset.lastErrorCode === candidate.lastErrorCode;
  }) && left.operations.every((operation, index) => {
    const candidate = right.operations[index];
    return operation.operationRef === candidate.operationRef
      && operation.phase === candidate.phase
      && operation.durationMs === candidate.durationMs
      && operation.transcript === candidate.transcript
      && operation.lastErrorCode === candidate.lastErrorCode;
  });
}

export class TauriDesktopClient implements DesktopClient {
  readonly #transportFactory: () => Promise<TauriTransport>;
  readonly #identity: RendererIdentity;
  readonly #disposeController = new AbortController();
  readonly #listeners = new Set<(event: DesktopEvent) => void>();
  readonly #unlisten = new Set<() => void>();
  readonly #pendingRuntimeEvents: PendingRuntimeEvent[] = [];
  #transportPromise: Promise<TauriTransport> | null = null;
  #bootstrapPromise: Promise<DesktopBootstrap> | null = null;
  #disposePromise: Promise<void> | null = null;
  #renderer: RendererAuthority | null = null;
  #status: RuntimeStatus | null = null;
  #voiceStatus: VoiceStatus | null = null;
  #disposed = false;
  #nativeListenersReady = false;
  #statusRefreshInFlight: Promise<void> | null = null;
  #followUpTimer: ReturnType<typeof setTimeout> | null = null;
  #refreshTargetRevision: number | null = null;
  #refreshAttemptsWithoutProgress = 0;
  readonly #projectionWatermarks = new Map<string, ProjectionWatermark>();

  constructor(transport?: TauriTransport | (() => Promise<TauriTransport>), identity?: { current: string; previous: string | null }) {
    this.#transportFactory = typeof transport === 'function'
      ? transport
      : transport ? async () => transport : defaultTransport;
    this.#identity = identity ?? createRendererIdentity();
  }

  subscribe(listener: (event: DesktopEvent) => void): () => void {
    if (this.#disposed) return () => undefined;
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  bootstrap(signal?: AbortSignal): Promise<DesktopBootstrap> {
    if (this.#disposed) return Promise.reject(new ClientDisposedError());
    if (!this.#bootstrapPromise) this.#bootstrapPromise = this.#bootstrap(signal);
    return this.#bootstrapPromise;
  }

  async #bootstrap(externalSignal?: AbortSignal): Promise<DesktopBootstrap> {
    const signal = this.#combinedAbortSignal(externalSignal);
    const renderer = await this.#openRendererSession(signal);
    if (signal.aborted || this.#disposed) throw abortError();
    this.#renderer = renderer;
    try {
      await this.#startNativeListeners();
      const transport = await this.#transport();
      const raw = await invokeNative<unknown>(transport, NATIVE_COMMANDS.bootstrap, {
        rendererSessionId: renderer.rendererSessionId,
        rendererGeneration: renderer.rendererGeneration,
      });
      if (signal.aborted || this.#disposed) throw abortError();
      const bootstrap = parseBootstrap(unwrapResult(raw), renderer);
      const readVoiceStatus = await readVoiceStatusNative(transport, renderer);
      const voiceStatus = this.#acceptVoiceStatus(readVoiceStatus) ?? this.#voiceStatus ?? readVoiceStatus;
      const accepted = this.#acceptStatus(bootstrap.status);
      const status = accepted ?? this.#status ?? bootstrap.status;
      const coherentPayload = status.statusRevision === bootstrap.status.statusRevision
        && (!status.rendererSessionId || sameRendererAuthority(renderer, {
          rendererSessionId: status.rendererSessionId,
          rendererGeneration: status.rendererGeneration ?? -1,
        }));
      return {
        ...bootstrap,
        status,
        snapshot: coherentPayload ? bootstrap.snapshot : null,
        dispatchRecovery: coherentPayload ? bootstrap.dispatchRecovery : null,
        voiceStatus,
      };
    } catch (error) {
      this.#releaseNativeListeners();
      await this.#cancelAdmissionBestEffort();
      if (!this.#disposed && sameRendererAuthority(this.#renderer, renderer)) {
        this.#renderer = null;
        this.#status = null;
        this.#voiceStatus = null;
      }
      throw error;
    }
  }

  dispose(): Promise<void> {
    this.#disposePromise ??= this.#dispose();
    return this.#disposePromise;
  }

  async #dispose(): Promise<void> {
    this.#disposed = true;
    this.#disposeController.abort();
    if (this.#followUpTimer) clearTimeout(this.#followUpTimer);
    this.#followUpTimer = null;
    this.#refreshTargetRevision = null;
    this.#releaseNativeListeners();
    this.#pendingRuntimeEvents.length = 0;
    this.#listeners.clear();
    // Cancellation tombstones an admission that has not reached Rust yet and conditionally retires a current one.
    try {
      await settleBestEffort(this.#transport().then((transport) => cancelRendererSessionNative(transport, {
        rendererSessionId: this.#identity.current,
        rendererGeneration: this.#renderer?.rendererGeneration ?? null,
      })));
    } catch {
      // Window teardown remains the second native ownership boundary.
    }
    this.#renderer = null;
    this.#status = null;
    this.#voiceStatus = null;
    this.#projectionWatermarks.clear();
  }

  async listProjects(renderer: RendererAuthority): Promise<ProjectSummary[]> {
    const guard = this.#captureRendererOperation(renderer);
    const transport = await this.#transport();
    this.#assertRendererOperation(guard);
    const raw = await invokeNative<unknown>(transport, NATIVE_COMMANDS.listProjects, { ...renderer });
    this.#assertRendererOperation(guard);
    const value = unwrapResult(raw);
    if (!Array.isArray(value)) throw new Error('Native project list is invalid.');
    return value.slice(0, 1_024).map(parseNativeProjectSummary);
  }

  async forgetRecentProject(renderer: RendererAuthority, projectId: string): Promise<ProjectSummary[]> {
    const guard = this.#captureRendererOperation(renderer);
    const transport = await this.#transport();
    this.#assertRendererOperation(guard);
    const raw = await invokeNative<unknown>(transport, NATIVE_COMMANDS.forgetRecentProject, {
      ...renderer,
      projectId,
    });
    this.#assertRendererOperation(guard);
    const value = unwrapResult(raw);
    if (!Array.isArray(value)) throw new Error('Native recent-project list is invalid.');
    return value.slice(0, 1_024).map(parseNativeProjectSummary);
  }

  async openProjectFolder(renderer: RendererAuthority): Promise<ProjectSummary | null> {
    const guard = this.#captureRendererOperation(renderer);
    const transport = await this.#transport();
    this.#assertRendererOperation(guard);
    const result = await invokeNativeResult(transport, NATIVE_COMMANDS.openProjectFolder, { ...renderer });
    this.#assertRendererOperation(guard);
    return result === null ? null : parseNativeProjectSummary(result);
  }

  async updateSettings(
    renderer: RendererAuthority,
    input: Omit<NativeSettings, 'schemaVersion' | 'revision'> & { expectedRevision: number },
  ): Promise<NativeSettings> {
    const guard = this.#captureRendererOperation(renderer);
    const transport = await this.#transport();
    this.#assertRendererOperation(guard);
    const raw = await invokeNative<unknown>(transport, NATIVE_COMMANDS.updateSettings, {
      ...renderer,
      expectedRevision: input.expectedRevision,
      locale: input.locale,
      theme: input.theme,
      reducedMotion: input.reducedMotion,
      notificationsEnabled: input.notificationsEnabled,
    });
    this.#assertRendererOperation(guard);
    return parseNativeSettings(unwrapResult(raw));
  }

  async createStarterProject(
    renderer: RendererAuthority,
    input: { operationRef: string; projectName: string },
  ): Promise<ProjectSummary | null> {
    const guard = this.#captureRendererOperation(renderer);
    const transport = await this.#transport();
    this.#assertRendererOperation(guard);
    const result = await invokeNativeResult(transport, NATIVE_COMMANDS.createStarterProject, {
      ...renderer,
      operationRef: input.operationRef,
      projectName: input.projectName.trim(),
    });
    this.#assertRendererOperation(guard);
    return result === null ? null : parseNativeProjectSummary(result);
  }

  async activateProject(project: ProjectSummary, renderer: RendererAuthority, expectedStatusRevision: number): Promise<RuntimeStatus> {
    const guard = this.#captureRendererOperation(renderer);
    const transport = await this.#transport();
    this.#assertRendererOperation(guard);
    const activationToken = createUuid();
    const raw = await invokeNative<unknown>(transport, NATIVE_COMMANDS.activateProject, {
      ...renderer,
      expectedStatusRevision,
      projectId: project.id,
      activationToken,
    });
    this.#assertRendererOperation(guard);
    const result = unwrapResult(raw);
    if (!isRecord(result) || result.activationToken !== activationToken) {
      throw new Error('Native project activation response is invalid.');
    }
    const activatedProject = parseNativeProjectSummary(result.project);
    if (activatedProject.id !== project.id) throw new Error('Native project activation response belongs to another project.');
    const activationSnapshot = parseWorkspaceSnapshot(result.snapshot);
    if (activationSnapshot.project.id !== project.id) {
      throw new Error('Native project activation snapshot belongs to another project.');
    }
    const status = parseRuntimeStatus(result.runtime);
    if (status.lifecycle !== 'Ready'
      || status.projectId !== project.id
      || status.activationToken !== activationToken
      || status.rendererSessionId !== renderer.rendererSessionId
      || status.rendererGeneration !== renderer.rendererGeneration) {
      throw new Error('Native project activation response does not contain the admitted authority.');
    }
    const accepted = this.#acceptStatus(status);
    const finalStatus = accepted ?? this.#status ?? status;
    const expectedAuthority: RuntimeAuthority = {
      projectId: project.id,
      activationToken,
      rendererSessionId: renderer.rendererSessionId,
      rendererGeneration: renderer.rendererGeneration,
    };
    if (finalStatus.lifecycle !== 'Ready'
      || !sameRuntimeAuthority(runtimeAuthorityFrom(finalStatus), expectedAuthority)) {
      throw new RuntimeAuthorityError('Project activation authority changed before activation completed.');
    }
    return finalStatus;
  }

  async stopRuntime(authority: RuntimeAuthority, expectedStatusRevision: number): Promise<RuntimeStatus> {
    const guard = this.#captureRuntimeOperation(authority);
    const transport = await this.#transport();
    this.#assertRuntimeOperation(guard);
    const raw = await invokeNative<unknown>(transport, NATIVE_COMMANDS.stopRuntime, {
      ...authority,
      expectedStatusRevision,
      runtimeGeneration: guard.runtimeGeneration,
    });
    this.#assertRenderer(authority);
    const status = parseRuntimeStatus(unwrapResult(raw));
    const accepted = this.#acceptStatus(status);
    return accepted ?? this.#status ?? status;
  }

  async refreshStatus(renderer: RendererAuthority): Promise<RuntimeStatus> {
    this.#assertRenderer(renderer);
    const transport = await this.#transport();
    this.#assertRenderer(renderer);
    const raw = await invokeNative<unknown>(transport, NATIVE_COMMANDS.reconcileRuntimeSession, { ...renderer });
    this.#assertRenderer(renderer);
    const bootstrap = parseBootstrap(unwrapResult(raw), renderer);
    const status = bootstrap.status;
    return this.#acceptStatus(status) ?? this.#status ?? status;
  }

  async readSnapshot(authority: RuntimeAuthority): Promise<WorkspaceSnapshot> {
    const result = await this.#runtimeCall(authority, 'repository.get-snapshot', {});
    return parseWorkspaceSnapshot(result);
  }

  async recordLastWorkAgent(authority: RuntimeAuthority, targetAgentId: string): Promise<ProjectSummary> {
    const guard = this.#captureRuntimeOperation(authority);
    const transport = await this.#transport();
    this.#assertRuntimeOperation(guard);
    const raw = await invokeNative<unknown>(transport, NATIVE_COMMANDS.recordLastWorkAgent, {
      ...authority,
      targetAgentId,
    });
    this.#assertRuntimeOperation(guard);
    const project = parseNativeProjectSummary(unwrapResult(raw));
    if (project.id !== authority.projectId || project.lastWorkAgentId !== targetAgentId) {
      throw new Error('Last WORK agent response belongs to another project or agent.');
    }
    return project;
  }

  async bootstrapProject(authority: RuntimeAuthority): Promise<ProjectBootstrapResult> {
    const result = await this.#runtimeCall(authority, 'project.bootstrap', {});
    if (!isRecord(result)
      || !['ready', 'migration_required', 'unsupported', 'recovery_required'].includes(String(result.status))
      || typeof result.no_write !== 'boolean'
      || (result.reason !== null && typeof result.reason !== 'string')) {
      throw new Error('Project bootstrap response is invalid.');
    }
    return {
      status: result.status as ProjectBootstrapResult['status'],
      noWrite: result.no_write,
      reason: result.reason,
      classification: typeof result.classification === 'string' ? result.classification : null,
    };
  }

  async readBusinessWorkOrders(
    authority: RuntimeAuthority,
    input: { afterCursor: BusinessSourceCursor | null; afterKey: string | null },
  ): Promise<BusinessWorkOrdersResult> {
    return parseBusinessWorkOrdersResult(await this.#runtimeCall(
      authority,
      'business.work-orders.read',
      {
        projectId: authority.projectId,
        consumer: {
          name: 'orquesta.business-work-orders.read',
          major: 1,
          minMinor: 0,
          requiredFeatures: [...BUSINESS_WORK_ORDER_REQUIRED_FEATURES],
        },
        afterCursor: input.afterCursor,
        query: { kind: 'index', limit: 25, afterKey: input.afterKey },
      },
    ));
  }

  async readConversation(
    authority: RuntimeAuthority,
    targetAgentId: string,
    checkpoint: ConversationReadCheckpoint,
    cursor?: ConversationCursor | null,
    activityCursor?: ConversationActivityCursor | null,
    pendingRequestCursor?: string | null,
  ): Promise<ConversationSnapshot> {
    const guard = this.#captureRuntimeOperation(authority);
    let expectedStreamId = checkpoint.streamId;
    let afterJournalSequence = checkpoint.journalSequence;
    let expectedProjectionRevision = checkpoint.projectionRevision;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const transport = await this.#transport();
      this.#assertRuntimeOperation(guard);
      const snapshot = await readProjectionConversation(transport, {
        renderer: guard.renderer,
        projectId: authority.projectId,
        targetAgentId,
        checkpoint: {
          streamId: expectedStreamId,
          journalSequence: afterJournalSequence,
          projectionRevision: expectedProjectionRevision,
        },
        cursor,
        activityCursor,
        pendingRequestCursor,
      });
      this.#assertRuntimeOperation(guard);
      const observed = this.#projectionWatermarks.get(authority.projectId);
      const raced = projectionReadRaced(snapshot, observed);
      if (!raced || attempt === 2 || cursor || activityCursor || pendingRequestCursor) return snapshot;
      expectedStreamId = snapshot.streamId;
      afterJournalSequence = snapshot.appliedJournalSequence;
      expectedProjectionRevision = snapshot.projectionRevision;
    }
    throw new Error('Projection conversation could not reach a stable watermark.');
  }

  async readHistoryIndex(
    authority: RuntimeAuthority,
    cursor?: HistoryCursor | null,
  ): Promise<HistoryIndexPage> {
    const guard = this.#captureRuntimeOperation(authority);
    const transport = await this.#transport();
    this.#assertRuntimeOperation(guard);
    const page = await readProjectionHistoryIndex(transport, {
      renderer: guard.renderer,
      projectId: authority.projectId,
      cursor,
    });
    this.#assertRuntimeOperation(guard);
    return page;
  }

  async readHistoryPage(
    authority: RuntimeAuthority,
    targetAgentId: string,
    query: string | null,
    cursor?: ConversationCursor | null,
  ): Promise<HistoryConversationPage> {
    const guard = this.#captureRuntimeOperation(authority);
    const transport = await this.#transport();
    this.#assertRuntimeOperation(guard);
    const page = await readProjectionHistoryPage(transport, {
      renderer: guard.renderer,
      projectId: authority.projectId,
      targetAgentId,
      query,
      cursor,
    });
    this.#assertRuntimeOperation(guard);
    return page;
  }

  async sendMessage(authority: RuntimeAuthority, input: SendMessageInput): Promise<DispatchSendResult> {
    const guard = this.#captureRuntimeOperation(authority);
    try {
      const transport = await this.#transport();
      this.#assertRuntimeOperation(guard);
      const dispatchId = createUuid();
      const result = await dispatchMessageNative(transport, guard, dispatchId, input);
      this.#assertRuntimeOperation(guard);
      this.#emit({ type: 'dispatch_recovery', projectId: authority.projectId, recovery: result.dispatchRecovery });
      return result;
    } catch (error) {
      let recovery: DispatchRecovery | null | undefined;
      try {
        recovery = recoveryFromNativeError(error);
      } catch { /* malformed native error details */ }
      if (recovery !== undefined) {
        this.#emit({ type: 'dispatch_recovery', projectId: authority.projectId, recovery });
        throw new DispatchSendError(error, recovery);
      }
      throw error;
    }
  }

  async respondToApproval(authority: RuntimeAuthority, attentionId: string, decision: string): Promise<void> {
    await this.#runtimeCall(authority, 'runtime.approval.respond', { attentionId, decision });
  }

  async startInspection(authority: RuntimeAuthority, input: StartInspectionInput): Promise<string> {
    const result = await this.#runtimeCall(authority, 'inspection.start', {
      projectId: authority.projectId,
      kind: input.kind,
      target: { kind: 'project', ids: [] },
      focus: input.focus,
    });
    if (!isRecord(result) || typeof result.runId !== 'string') throw new Error('Inspection start response is invalid.');
    return result.runId;
  }

  async cancelInspection(authority: RuntimeAuthority, runId: string): Promise<void> {
    await this.#runtimeCall(authority, 'inspection.cancel', { projectId: authority.projectId, runId });
  }

  async readWorkflowCatalog(authority: RuntimeAuthority): Promise<WorkflowCatalog> {
    const result = await this.#runtimeCall(authority, 'workflow.catalog.read', { projectId: authority.projectId });
    if (!isRecord(result)) throw new Error('Workflow catalog response is invalid.');
    return parseWorkflowCatalog(result.catalog);
  }

  async saveWorkflowDefinition(authority: RuntimeAuthority, input: {
    workflowId: string | null;
    name: string;
    prompt: string;
    checks: WorkflowCheck[];
  }): Promise<string> {
    const result = await this.#runtimeCall(authority, 'workflow.definition.save', {
      projectId: authority.projectId,
      workflowId: input.workflowId,
      name: input.name,
      prompt: input.prompt,
      checks: input.checks,
    });
    if (!isRecord(result) || typeof result.workflowId !== 'string') throw new Error('Workflow save response is invalid.');
    return result.workflowId;
  }

  async startWorkflowBatch(authority: RuntimeAuthority, workflowId: string, repetitions: number): Promise<string> {
    const result = await this.#runtimeCall(authority, 'workflow.batch.start', {
      projectId: authority.projectId, workflowId, repetitions,
    });
    if (!isRecord(result) || typeof result.batchId !== 'string') throw new Error('Workflow start response is invalid.');
    return result.batchId;
  }

  async cancelWorkflowBatch(authority: RuntimeAuthority, batchId: string): Promise<void> {
    await this.#runtimeCall(authority, 'workflow.batch.cancel', { projectId: authority.projectId, batchId });
  }

  async readWorkflowResult(authority: RuntimeAuthority, batchId: string, attemptId: string): Promise<string> {
    const result = await this.#runtimeCall(authority, 'workflow.result.read', {
      projectId: authority.projectId, batchId, attemptId,
    });
    if (!isRecord(result) || typeof result.output !== 'string') throw new Error('Workflow result response is invalid.');
    return result.output;
  }

  async importAttachments(
    authority: RuntimeAuthority,
    selectionId: string,
    files: readonly AttachmentBinarySource[],
  ): Promise<ComposerAttachment[]> {
    const guard = this.#captureRuntimeOperation(authority);
    const transport = await this.#transport();
    this.#assertRuntimeOperation(guard);
    const attachments = await importAttachmentsNative(transport, guard.renderer, selectionId, files);
    try {
      this.#assertRuntimeOperation(guard);
      return attachments;
    } catch (error) {
      // The byte transaction succeeded, but the runtime epoch changed before the
      // renderer could own the result. Retire that exact committed selection.
      await this.#abandonSelectionBestEffort(authority, selectionId);
      throw error;
    }
  }

  abandonAttachmentSelection(authority: RuntimeAuthority | null, selectionId: string): Promise<void> {
    return this.#abandonSelection(authority, selectionId);
  }

  async readAttachmentPreview(
    authority: RuntimeAuthority,
    selectionId: string,
    attachmentId: string,
  ): Promise<ArrayBuffer> {
    const guard = this.#captureRuntimeOperation(authority);
    const transport = await this.#transport();
    this.#assertRuntimeOperation(guard);
    const bytes = await readAttachmentPreviewNative(
      transport,
      guard.renderer,
      selectionId,
      attachmentId,
    );
    this.#assertRuntimeOperation(guard);
    return bytes;
  }

  async forgetAttachment(
    _authority: RuntimeAuthority | null,
    selectionId: string,
    attachmentId: string,
  ): Promise<void> {
    const renderer = this.#renderer;
    if (!renderer) throw new RuntimeAuthorityError('Renderer session is unavailable for attachment cleanup.');
    await forgetAttachmentNative(await this.#transport(), renderer, selectionId, attachmentId);
  }

  async readVoiceStatus(renderer: RendererAuthority): Promise<VoiceStatus> {
    const guard = this.#captureRendererOperation(renderer);
    const transport = await this.#transport();
    this.#assertRendererOperation(guard);
    const status = await readVoiceStatusNative(transport, renderer);
    this.#assertRendererOperation(guard);
    return this.#acceptVoiceStatus(status) ?? this.#voiceStatus ?? status;
  }

  async acquireVoiceAsset(renderer: RendererAuthority, assetId: string): Promise<VoiceStatus> {
    return this.#voiceStatusOperation(renderer, (transport) => (
      acquireVoiceAssetNative(transport, renderer, assetId)
    ));
  }

  async cancelVoiceAssetAcquisition(
    renderer: RendererAuthority,
    operationRef: string,
  ): Promise<VoiceStatus> {
    return this.#voiceStatusOperation(renderer, (transport) => (
      cancelVoiceAssetAcquisitionNative(transport, renderer, operationRef)
    ));
  }

  async deleteVoiceAsset(renderer: RendererAuthority, assetId: string): Promise<VoiceStatus> {
    return this.#voiceStatusOperation(renderer, (transport) => (
      deleteVoiceAssetNative(transport, renderer, assetId)
    ));
  }

  async transcribeVoicePcm(
    renderer: RendererAuthority,
    operationRef: string,
    binding: VoiceTranscriptionBindingInput,
    pcm: Uint8Array,
    sampleCount: number,
  ): Promise<VoiceOperationStatus> {
    const guard = this.#captureRendererOperation(renderer);
    const transport = await this.#transport();
    this.#assertRendererOperation(guard);
    const operation = await transcribeVoicePcmNative(
      transport, renderer, operationRef, binding, pcm, sampleCount,
    );
    this.#assertRendererOperation(guard);
    return operation;
  }

  async cancelVoiceTranscription(
    renderer: RendererAuthority,
    operationRef: string,
  ): Promise<VoiceStatus> {
    return this.#voiceStatusOperation(renderer, (transport) => (
      cancelVoiceTranscriptionNative(transport, renderer, operationRef)
    ));
  }

  async acknowledgeVoiceTranscription(
    renderer: RendererAuthority,
    operationRef: string,
  ): Promise<VoiceStatus> {
    return this.#voiceStatusOperation(renderer, (transport) => (
      acknowledgeVoiceTranscriptionNative(transport, renderer, operationRef)
    ));
  }

  async readDispatchRecovery(renderer: RendererAuthority): Promise<DispatchRecovery | null> {
    const guard = this.#captureRendererOperation(renderer);
    const transport = await this.#transport();
    this.#assertRendererOperation(guard);
    const raw = await invokeNative<unknown>(transport, NATIVE_COMMANDS.readDispatchRecovery, { ...renderer });
    this.#assertRendererOperation(guard);
    return parseDispatchRecovery(unwrapResult(raw));
  }

  async reconcileDispatchRecovery(
    renderer: RendererAuthority,
    recovery: DispatchRecovery,
    authority: RuntimeAuthority | null,
  ): Promise<DispatchRecoveryResult> {
    const runtimeGuard = recovery.kind === 'cleanup_pending'
      ? null : this.#captureRuntimeOperation(authority);
    const rendererGuard = runtimeGuard ? null : this.#captureRendererOperation(renderer);
    if (runtimeGuard && (!sameRendererAuthority(renderer, runtimeGuard.renderer)
      || runtimeGuard.authority.projectId !== recovery.projectId)) {
      throw new RuntimeAuthorityError('Dispatch recovery does not belong to the active runtime authority.');
    }
    const transport = await this.#transport();
    if (runtimeGuard) this.#assertRuntimeOperation(runtimeGuard);
    else this.#assertRendererOperation(rendererGuard!);
    const raw = await invokeNative<unknown>(transport, NATIVE_COMMANDS.reconcileDispatchRecovery, {
      ...renderer,
      messageId: recovery.dispatchId,
      projectId: recovery.projectId,
      activationToken: runtimeGuard ? runtimeGuard.authority.activationToken : null,
      runtimeGeneration: runtimeGuard?.runtimeGeneration ?? null,
      expectedStatusRevision: runtimeGuard?.statusRevision ?? null,
    });
    if (runtimeGuard) this.#assertRuntimeOperation(runtimeGuard);
    else this.#assertRendererOperation(rendererGuard!);
    return parseDispatchReconcileResult(unwrapResult(raw));
  }

  async #runtimeCall(authority: RuntimeAuthority, method: string, params: Record<string, unknown>): Promise<unknown> {
    const guard = this.#captureRuntimeOperation(authority);
    const transport = await this.#transport();
    this.#assertRuntimeOperation(guard);
    const result = await invokeRuntimeMethod(transport, guard, method, params);
    // A single epoch invalidates every read and mutation when lifecycle ownership changes.
    this.#assertRuntimeOperation(guard);
    return result;
  }

  async #abandonSelectionBestEffort(authority: RuntimeAuthority | null, selectionId: string): Promise<void> {
    try {
      await this.#abandonSelection(authority, selectionId);
    } catch {
      // Native session retirement owns any remaining quarantine batch.
    }
  }

  async #abandonSelection(authority: RuntimeAuthority | null, selectionId: string): Promise<void> {
    const renderer = this.#renderer;
    if (!renderer) throw new RuntimeAuthorityError('Renderer session is unavailable for attachment cleanup.');
    await abandonAttachmentSelectionNative(await this.#transport(), renderer, selectionId);
  }

  async #openRendererSession(signal: AbortSignal): Promise<RendererAuthority> {
    return openRendererSessionNative({
      getTransport: () => this.#transport(),
      identity: this.#identity,
      signal,
      isDisposed: () => this.#disposed,
      cancelAdmission: () => this.#cancelAdmissionBestEffort(),
    });
  }

  async #cancelAdmissionBestEffort(): Promise<void> {
    try {
      await settleBestEffort(this.#transport().then((transport) => cancelRendererSessionNative(transport, {
        rendererSessionId: this.#identity.current,
        rendererGeneration: this.#renderer?.rendererGeneration ?? null,
      })));
    } catch {
      // The WebviewWindow teardown hook is authoritative if transport has already gone away.
    }
  }

  async #startNativeListeners(): Promise<void> {
    if (this.#nativeListenersReady) return;
    const transport = await this.#transport();
    const registrations = await Promise.allSettled([
      transport.listen<unknown>(NATIVE_EVENTS.runtimeStatus, ({ payload }) => this.#receiveStatusPayload(payload)),
      transport.listen<unknown>(NATIVE_EVENTS.runtimeEvent, ({ payload }) => this.#receiveRuntimePayload(payload)),
      transport.listen<unknown>(NATIVE_EVENTS.dispatchRecoveryCleared, ({ payload }) => this.#receiveDispatchRecoveryCleared(payload)),
      transport.listen<unknown>(NATIVE_EVENTS.projectionChanged, ({ payload }) => this.#receiveProjectionChanged(payload)),
      transport.listen<unknown>(NATIVE_EVENTS.projectionStatus, ({ payload }) => this.#receiveProjectionStatus(payload)),
      transport.listen<unknown>(NATIVE_EVENTS.voiceStatus, ({ payload }) => this.#receiveVoiceStatus(payload)),
    ]);
    const unlisten = registrations.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
    const failure = registrations.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure || this.#disposed) {
      unlisten.forEach((stop) => {
        try { stop(); } catch { /* best effort registration rollback */ }
      });
      if (failure) throw failure.reason;
      return;
    }
    unlisten.forEach((stop) => this.#unlisten.add(stop));
    this.#nativeListenersReady = true;
  }

  #releaseNativeListeners(): void {
    for (const unlisten of this.#unlisten) {
      try { unlisten(); } catch { /* best effort local listener cleanup */ }
    }
    this.#unlisten.clear();
    this.#nativeListenersReady = false;
  }

  #receiveStatusPayload(payload: unknown): void {
    if (this.#disposed) return;
    if (!isRecord(payload)
      || !hasExactKeys(payload, [
        'schemaVersion', 'rendererSessionId', 'rendererGeneration',
        'runtimeGeneration', 'statusRevision', 'status',
      ])
      || payload.schemaVersion !== 1
      || !Number.isSafeInteger(payload.statusRevision)
      || typeof payload.rendererSessionId !== 'string'
      || !Number.isSafeInteger(payload.rendererGeneration)
      || !(payload.runtimeGeneration === null || typeof payload.runtimeGeneration === 'string')) return;
    if (!sameRendererAuthority(this.#renderer, {
      rendererSessionId: payload.rendererSessionId,
      rendererGeneration: Number(payload.rendererGeneration),
    })) return;
    const revision = Number(payload.statusRevision);
    // Routing headers are parsed before the body, so a stale malformed body cannot disturb the current writer.
    if (this.#status && revision < this.#status.statusRevision) return;
    try {
      const status = parseRuntimeStatus(payload.status);
      if (status.statusRevision !== revision || status.runtimeGeneration !== payload.runtimeGeneration) return;
      this.#acceptStatus(status);
    } catch {
      // Native boundary validation is fail-closed.
    }
  }

  #receiveRuntimePayload(payload: unknown): void {
    if (this.#disposed) return;
    if (!isRecord(payload)
      || !hasExactKeys(payload, [
        'schemaVersion', 'runtimeGeneration', 'statusRevision', 'rendererSessionId',
        'rendererGeneration', 'projectId', 'activationToken', 'event',
      ])
      || payload.schemaVersion !== 1
      || !Number.isSafeInteger(payload.statusRevision)) return;
    const statusRevision = Number(payload.statusRevision);
    if (this.#status && statusRevision < this.#status.statusRevision) return;
    // Only inspect the remaining routing header after the stale revision barrier.
    if (typeof payload.runtimeGeneration !== 'string' || payload.runtimeGeneration.length === 0
      || typeof payload.rendererSessionId !== 'string'
      || !Number.isSafeInteger(payload.rendererGeneration)
      || typeof payload.projectId !== 'string'
      || typeof payload.activationToken !== 'string') return;
    const routing = {
      type: 'runtime_event',
      statusRevision,
      runtimeGeneration: payload.runtimeGeneration,
      rendererSessionId: payload.rendererSessionId,
      rendererGeneration: Number(payload.rendererGeneration),
      projectId: payload.projectId,
      activationToken: payload.activationToken,
    } as const;
    if (!sameRendererAuthority(this.#renderer, routing)) return;
    let eventBody: unknown;
    try { eventBody = payload.event; } catch { return; }
    const pending: PendingRuntimeEvent = { ...routing, event: eventBody };
    if (this.#canDeliverRuntimeEvent(pending)) {
      this.#deliverRuntimeEvent(pending);
      return;
    }
    if (!this.#status || statusRevision <= this.#status.statusRevision) return;
    if (this.#pendingRuntimeEvents.length >= MAX_PENDING_RUNTIME_EVENTS) this.#pendingRuntimeEvents.shift();
    this.#pendingRuntimeEvents.push(pending);
    this.#requestStatusProgress(statusRevision);
  }

  async interruptTurn(authority: RuntimeAuthority, input: {
    targetAgentId: string;
    threadId: string;
    turnId: string;
  }): Promise<void> {
    const guard = this.#captureRuntimeOperation(authority);
    const transport = await this.#transport();
    this.#assertRuntimeOperation(guard);
    await interruptTurnNative(transport, guard, input);
    this.#assertRuntimeOperation(guard);
  }

  async steerTurn(authority: RuntimeAuthority, input: {
    steerId: string;
    targetAgentId: string;
    threadId: string;
    turnId: string;
    text: string;
  }): Promise<void> {
    const guard = this.#captureRuntimeOperation(authority);
    const transport = await this.#transport();
    this.#assertRuntimeOperation(guard);
    await steerTurnNative(transport, guard, input);
    this.#assertRuntimeOperation(guard);
  }

  #receiveProjectionChanged(payload: unknown): void {
    if (this.#disposed) return;
    const event = parseProjectionChanged(payload);
    if (!event || !matchesProjectionIncarnation(
      event,
      projectionIncarnationFromStatus(this.#status, this.#renderer),
    )) return;
    const next = {
      streamId: event.streamId,
      journalSequence: event.appliedJournalSequence,
      projectionRevision: event.projectionRevision,
    };
    const previous = this.#projectionWatermarks.get(event.projectId);
    if (projectionWatermarkIsSameOrOlder(previous, next)) return;
    this.#projectionWatermarks.set(event.projectId, next);
    this.#emit({
      type: 'projection_changed',
      projectId: event.projectId,
      streamId: next.streamId,
      appliedJournalSequence: next.journalSequence,
      projectionRevision: next.projectionRevision,
    });
  }

  #receiveDispatchRecoveryCleared(payload: unknown): void {
    if (this.#disposed) return;
    const event = parseDispatchRecoveryCleared(payload);
    if (!event || !matchesProjectionIncarnation(
      event,
      projectionIncarnationFromStatus(this.#status, this.#renderer),
    )) return;
    this.#emit({
      type: 'dispatch_recovery',
      projectId: event.projectId,
      recovery: null,
      clearedDispatchId: event.dispatchId,
    });
  }

  #receiveProjectionStatus(payload: unknown): void {
    if (this.#disposed) return;
    const event = parseProjectionFault(payload);
    if (!event || !matchesProjectionIncarnation(
      event,
      projectionIncarnationFromStatus(this.#status, this.#renderer),
    )) return;
    this.#emit({
      type: 'projection_status',
      projectId: event.projectId,
      status: 'faulted',
      code: event.error.code,
      message: event.error.message,
      retryable: event.error.retryable,
    });
  }

  #receiveVoiceStatus(payload: unknown): void {
    if (this.#disposed) return;
    if (!isRecord(payload)
      || !hasExactKeys(payload, [
        'schemaVersion', 'rendererSessionId', 'rendererGeneration', 'windowLabel', 'status',
      ])
      || payload.schemaVersion !== 1
      || typeof payload.rendererSessionId !== 'string'
      || !Number.isSafeInteger(payload.rendererGeneration)
      || typeof payload.windowLabel !== 'string'
      || payload.windowLabel.length === 0) return;
    if (!sameRendererAuthority(this.#renderer, {
      rendererSessionId: payload.rendererSessionId,
      rendererGeneration: Number(payload.rendererGeneration),
    })) return;
    try {
      this.#acceptVoiceStatus(parseVoiceStatus(payload.status));
    } catch {
      // Native boundary validation is fail-closed.
    }
  }

  #acceptVoiceStatus(status: VoiceStatus): VoiceStatus | null {
    if (this.#disposed) return null;
    const current = this.#voiceStatus;
    if (current && status.revision < current.revision) return null;
    if (current && status.revision === current.revision) {
      // Voice status revisions are immutable. Equal-revision equivocation is ignored.
      return sameVoiceStatus(current, status) ? current : null;
    }
    this.#voiceStatus = status;
    this.#emit({ type: 'voice_status', status });
    return status;
  }

  async #voiceStatusOperation(
    renderer: RendererAuthority,
    run: (transport: TauriTransport) => Promise<VoiceStatus>,
  ): Promise<VoiceStatus> {
    const guard = this.#captureRendererOperation(renderer);
    const transport = await this.#transport();
    this.#assertRendererOperation(guard);
    const status = await run(transport);
    this.#assertRendererOperation(guard);
    return this.#acceptVoiceStatus(status) ?? this.#voiceStatus ?? status;
  }

  #acceptStatus(status: RuntimeStatus): RuntimeStatus | null {
    if (this.#disposed) return null;
    const renderer = this.#renderer;
    const current = this.#status;
    if (current && status.statusRevision < current.statusRevision) return null;
    if (current && status.statusRevision === current.statusRevision) {
      // A revision is immutable. Equal-revision equivocation cannot replace accepted authority.
      return sameRuntimeStatus(current, status) ? current : null;
    }
    const previousProjectionIncarnation = projectionIncarnationFromStatus(current, renderer);
    const nextProjectionIncarnation = projectionIncarnationFromStatus(status, renderer);
    if (!sameProjectionIncarnation(previousProjectionIncarnation, nextProjectionIncarnation)) {
      this.#projectionWatermarks.clear();
    }
    this.#status = status;
    if (!current || status.statusRevision > current.statusRevision) this.#refreshAttemptsWithoutProgress = 0;
    // A foreign/new renderer may be visible during handoff, but it must never become this client's authority.
    if (renderer && status.rendererSessionId && !sameRendererAuthority(renderer, {
      rendererSessionId: status.rendererSessionId,
      rendererGeneration: status.rendererGeneration ?? -1,
    })) {
      this.#pendingRuntimeEvents.length = 0;
    }
    this.#emit({ type: 'status', status });
    this.#drainPendingRuntimeEvents();
    this.#recomputeRefreshTarget();
    this.#scheduleFollowUpRefresh();
    return status;
  }

  #canDeliverRuntimeEvent(event: PendingRuntimeEvent): boolean {
    const status = this.#status;
    const renderer = this.#renderer;
    if (!status || !renderer || status.lifecycle !== 'Ready') return false;
    if (event.statusRevision !== status.statusRevision || event.runtimeGeneration !== status.runtimeGeneration) return false;
    if (!sameRendererAuthority(renderer, event)) return false;
    return sameRuntimeAuthority(runtimeAuthorityFrom(status), event);
  }

  #deliverRuntimeEvent(event: PendingRuntimeEvent): void {
    if (!isRecord(event.event)) return;
    if (event.event.type === 'repository.snapshot.changed' && 'snapshot' in event.event) {
      try { this.#emit({ type: 'snapshot', snapshot: parseWorkspaceSnapshot(event.event.snapshot) }); } catch { /* malformed */ }
      return;
    }
    if (event.event.type === 'workflow.catalog.changed' && 'catalog' in event.event) {
      try { this.#emit({ type: 'workflow_catalog', catalog: parseWorkflowCatalog(event.event.catalog) }); } catch { /* malformed */ }
      return;
    }
    this.#emit({ type: 'runtime', event: event.event });
  }

  #drainPendingRuntimeEvents(): void {
    const status = this.#status;
    if (!status) return;
    for (let index = 0; index < this.#pendingRuntimeEvents.length;) {
      const event = this.#pendingRuntimeEvents[index];
      if (this.#canDeliverRuntimeEvent(event)) {
        this.#pendingRuntimeEvents.splice(index, 1);
        this.#deliverRuntimeEvent(event);
      } else if (event.statusRevision <= status.statusRevision) {
        // An exact-or-older revision with a different incarnation can never become current later.
        this.#pendingRuntimeEvents.splice(index, 1);
      } else {
        index += 1;
      }
    }
  }

  #requestStatusProgress(targetRevision: number): void {
    this.#refreshTargetRevision = Math.max(this.#refreshTargetRevision ?? -1, targetRevision);
    this.#scheduleFollowUpRefresh();
  }

  #recomputeRefreshTarget(): void {
    const currentRevision = this.#status?.statusRevision ?? -1;
    const target = this.#pendingRuntimeEvents.reduce<number | null>((highest, event) => (
      event.statusRevision > currentRevision ? Math.max(highest ?? -1, event.statusRevision) : highest
    ), null);
    this.#refreshTargetRevision = target;
  }

  #scheduleFollowUpRefresh(): void {
    if (this.#disposed || !this.#renderer || this.#statusRefreshInFlight || this.#followUpTimer) return;
    const currentRevision = this.#status?.statusRevision ?? -1;
    if (this.#refreshTargetRevision === null || this.#refreshTargetRevision <= currentRevision) return;
    if (this.#refreshAttemptsWithoutProgress >= MAX_FOLLOW_UP_REFRESHES) return;
    const delay = this.#refreshAttemptsWithoutProgress === 0
      ? 0 : 40 * (2 ** (this.#refreshAttemptsWithoutProgress - 1));
    this.#followUpTimer = setTimeout(() => {
      this.#followUpTimer = null;
      const renderer = this.#renderer;
      if (!renderer || this.#disposed) return;
      const beforeRevision = this.#status?.statusRevision ?? -1;
      if (this.#refreshTargetRevision === null || this.#refreshTargetRevision <= beforeRevision) return;
      this.#statusRefreshInFlight = this.refreshStatus(renderer)
        .then(() => undefined)
        .catch(() => undefined)
        .finally(() => {
          const afterRevision = this.#status?.statusRevision ?? -1;
          this.#refreshAttemptsWithoutProgress = afterRevision > beforeRevision
            ? 0 : this.#refreshAttemptsWithoutProgress + 1;
          this.#statusRefreshInFlight = null;
          this.#recomputeRefreshTarget();
          this.#scheduleFollowUpRefresh();
        });
    }, delay);
  }

  #assertRenderer(renderer: RendererAuthority): void {
    if (this.#disposed) throw new ClientDisposedError();
    if (!sameRendererAuthority(this.#renderer, renderer)) throw new RuntimeAuthorityError('Renderer session authority changed.');
  }

  #captureRendererOperation(renderer: RendererAuthority): RendererOperationGuard {
    this.#assertRenderer(renderer);
    return { renderer };
  }

  #assertRendererOperation(guard: RendererOperationGuard): void {
    this.#assertRenderer(guard.renderer);
  }

  #assertAuthority(authority: RuntimeAuthority | null): asserts authority is RuntimeAuthority {
    if (!authority) throw new RuntimeAuthorityError();
    this.#assertRenderer(authority);
    if (!sameRuntimeAuthority(runtimeAuthorityFrom(this.#status ?? {
      lifecycle: 'Stopped', projectId: null, activationToken: null, rendererSessionId: null,
      rendererGeneration: null, runtimeGeneration: null, statusRevision: 0, failureReason: null,
    }), authority)) throw new RuntimeAuthorityError();
  }

  #captureRuntimeOperation(authority: RuntimeAuthority | null): RuntimeOperationGuard {
    this.#assertAuthority(authority);
    const status = this.#status;
    if (!status || status.runtimeGeneration === null) throw new RuntimeAuthorityError();
    return {
      renderer: {
        rendererSessionId: authority.rendererSessionId,
        rendererGeneration: authority.rendererGeneration,
      },
      authority,
      runtimeGeneration: status.runtimeGeneration,
      statusRevision: status.statusRevision,
    };
  }

  #assertRuntimeOperation(guard: RuntimeOperationGuard): void {
    this.#assertAuthority(guard.authority);
    const status = this.#status;
    if (!status
      || guard.runtimeGeneration !== status.runtimeGeneration
      || guard.statusRevision !== status.statusRevision) {
      throw new RuntimeAuthorityError('Runtime lifecycle changed before this operation completed.');
    }
  }

  #emit(event: DesktopEvent): void {
    if (this.#disposed) return;
    this.#listeners.forEach((listener) => {
      try { listener(event); } catch { /* one subscriber cannot break native event delivery */ }
    });
  }

  #combinedAbortSignal(external?: AbortSignal): AbortSignal {
    if (!external) return this.#disposeController.signal;
    if (external.aborted || this.#disposeController.signal.aborted) return AbortSignal.abort();
    return AbortSignal.any([external, this.#disposeController.signal]);
  }

  #transport(): Promise<TauriTransport> {
    this.#transportPromise ??= this.#transportFactory();
    return this.#transportPromise;
  }
}

export function createTauriDesktopClient(transport?: TauriTransport): TauriDesktopClient {
  return new TauriDesktopClient(transport);
}
