import type {
  ComposerAttachment,
  ComposerAccessMode,
  ComposerRuntimeOptions,
  ComposerServiceTier,
  ConversationCursor,
  ConversationActivityCursor,
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
  ProjectFolderSelection,
  ProjectArchiveMutation,
  ProjectSummary,
  ProjectBootstrapResult,
  RendererAuthority,
  RuntimeAuthority,
  RuntimeStatus,
  WorkspaceSnapshot,
  BusinessSourceCursor,
  BusinessWorkOrdersResult,
  WorkflowCatalog,
  WorkflowCheck,
  VoiceOperationStatus,
  VoiceStatus,
} from '../domain/models';

export interface SendMessageInput {
  targetAgentId: string;
  text: string;
  attachmentRefs: Array<{ selectionId: string; publicId: string }>;
  model: string | null;
  effort: string | null;
  accessMode: ComposerAccessMode;
  serviceTier: ComposerServiceTier;
}

export interface SteerTurnInput {
  steerId: string;
  targetAgentId: string;
  threadId: string;
  turnId: string;
  text: string;
}

export interface AttachmentBinarySource {
  readonly name: string;
  readonly size: number;
  readonly type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface StartInspectionInput {
  kind: 'external_benchmark' | 'adversarial_audit';
  focus: string | null;
}

export type VoiceTranscriptionBindingInput =
  | {
      target: 'agent';
      projectId: string;
      agentId: string;
      activationToken: string;
      draftSha256: string;
    }
  | { target: 'launcher'; draftSha256: string };

export interface DesktopClient {
  bootstrap(signal?: AbortSignal): Promise<DesktopBootstrap>;
  dispose(): Promise<void>;
  subscribe(listener: (event: DesktopEvent) => void): () => void;

  updateSettings(
    renderer: RendererAuthority,
    input: Omit<NativeSettings, 'schemaVersion' | 'revision'> & { expectedRevision: number },
  ): Promise<NativeSettings>;

  listProjects(renderer: RendererAuthority): Promise<ProjectSummary[]>;
  listArchivedProjects(renderer: RendererAuthority): Promise<ProjectSummary[]>;
  archiveProject(renderer: RendererAuthority, projectId: string): Promise<ProjectArchiveMutation>;
  restoreArchivedProject(renderer: RendererAuthority, projectId: string): Promise<ProjectArchiveMutation>;
  recordLastWorkAgent(authority: RuntimeAuthority, targetAgentId: string): Promise<ProjectSummary>;
  chooseProjectFolder(renderer: RendererAuthority): Promise<ProjectFolderSelection | null>;
  openProjectFolder(
    renderer: RendererAuthority,
    input: { selectionRef: string; projectName: string },
  ): Promise<ProjectSummary>;
  createStarterProject(
    renderer: RendererAuthority,
    input: { operationRef: string; projectName: string },
  ): Promise<ProjectSummary | null>;
  activateProject(project: ProjectSummary, renderer: RendererAuthority, expectedStatusRevision: number): Promise<RuntimeStatus>;
  stopRuntime(authority: RuntimeAuthority, expectedStatusRevision: number): Promise<RuntimeStatus>;
  refreshStatus(renderer: RendererAuthority): Promise<RuntimeStatus>;

  readSnapshot(authority: RuntimeAuthority): Promise<WorkspaceSnapshot>;
  readComposerRuntimeOptions(renderer: RendererAuthority): Promise<ComposerRuntimeOptions>;
  bootstrapProject(authority: RuntimeAuthority): Promise<ProjectBootstrapResult>;
  readBusinessWorkOrders(
    authority: RuntimeAuthority,
    input: { afterCursor: BusinessSourceCursor | null; afterKey: string | null },
  ): Promise<BusinessWorkOrdersResult>;
  readConversation(
    authority: RuntimeAuthority,
    targetAgentId: string,
    checkpoint: ConversationReadCheckpoint,
    cursor?: ConversationCursor | null,
    activityCursor?: ConversationActivityCursor | null,
    pendingRequestCursor?: string | null,
  ): Promise<ConversationSnapshot>;
  readHistoryIndex(authority: RuntimeAuthority, cursor?: HistoryCursor | null): Promise<HistoryIndexPage>;
  readHistoryPage(
    authority: RuntimeAuthority,
    targetAgentId: string,
    query: string | null,
    cursor?: ConversationCursor | null,
  ): Promise<HistoryConversationPage>;
  sendMessage(authority: RuntimeAuthority, input: SendMessageInput): Promise<DispatchSendResult>;
  interruptTurn(authority: RuntimeAuthority, input: {
    targetAgentId: string;
    threadId: string;
    turnId: string;
  }): Promise<void>;
  steerTurn(authority: RuntimeAuthority, input: SteerTurnInput): Promise<void>;
  respondToApproval(authority: RuntimeAuthority, attentionId: string, decision: string): Promise<void>;
  startInspection(authority: RuntimeAuthority, input: StartInspectionInput): Promise<string>;
  cancelInspection(authority: RuntimeAuthority, runId: string): Promise<void>;
  readWorkflowCatalog(authority: RuntimeAuthority): Promise<WorkflowCatalog>;
  saveWorkflowDefinition(authority: RuntimeAuthority, input: {
    workflowId: string | null;
    name: string;
    prompt: string;
    checks: WorkflowCheck[];
  }): Promise<string>;
  startWorkflowBatch(authority: RuntimeAuthority, workflowId: string, repetitions: number): Promise<string>;
  cancelWorkflowBatch(authority: RuntimeAuthority, batchId: string): Promise<void>;
  readWorkflowResult(authority: RuntimeAuthority, batchId: string, attemptId: string): Promise<string>;

  importAttachments(
    authority: RuntimeAuthority,
    selectionId: string,
    files: readonly AttachmentBinarySource[],
  ): Promise<ComposerAttachment[]>;
  readAttachmentPreview(
    authority: RuntimeAuthority,
    selectionId: string,
    attachmentId: string,
  ): Promise<ArrayBuffer>;
  forgetAttachment(authority: RuntimeAuthority | null, selectionId: string, attachmentId: string): Promise<void>;
  abandonAttachmentSelection(authority: RuntimeAuthority | null, selectionId: string): Promise<void>;

  readVoiceStatus(renderer: RendererAuthority): Promise<VoiceStatus>;
  acquireVoiceAsset(renderer: RendererAuthority, assetId: string): Promise<VoiceStatus>;
  cancelVoiceAssetAcquisition(renderer: RendererAuthority, operationRef: string): Promise<VoiceStatus>;
  deleteVoiceAsset(renderer: RendererAuthority, assetId: string): Promise<VoiceStatus>;
  transcribeVoicePcm(
    renderer: RendererAuthority,
    operationRef: string,
    binding: VoiceTranscriptionBindingInput,
    pcm: Uint8Array,
    sampleCount: number,
  ): Promise<VoiceOperationStatus>;
  cancelVoiceTranscription(renderer: RendererAuthority, operationRef: string): Promise<VoiceStatus>;
  acknowledgeVoiceTranscription(renderer: RendererAuthority, operationRef: string): Promise<VoiceStatus>;

  readDispatchRecovery(renderer: RendererAuthority): Promise<DispatchRecovery | null>;
  reconcileDispatchRecovery(renderer: RendererAuthority, recovery: DispatchRecovery, authority: RuntimeAuthority | null): Promise<DispatchRecoveryResult>;
}

export class ClientDisposedError extends Error {
  constructor() {
    super('Desktop client was disposed.');
    this.name = 'ClientDisposedError';
  }
}

export class RuntimeAuthorityError extends Error {
  constructor(message = 'The runtime authority changed before this action could complete.') {
    super(message);
    this.name = 'RuntimeAuthorityError';
  }
}

export class DispatchSendError extends Error {
  constructor(
    readonly failure: unknown,
    readonly recovery: DispatchRecovery | null,
  ) {
    super(failure instanceof Error ? failure.message : 'Native dispatch failed.');
    this.name = 'DispatchSendError';
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
