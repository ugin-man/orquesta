export type RuntimeLifecycle = 'Stopped' | 'Starting' | 'Ready' | 'Stopping' | 'Failed';

export interface RendererAuthority {
  rendererSessionId: string;
  rendererGeneration: number;
}

export interface RuntimeAuthority extends RendererAuthority {
  projectId: string;
  activationToken: string;
}

export interface RuntimeStatus {
  lifecycle: RuntimeLifecycle;
  projectId: string | null;
  activationToken: string | null;
  rendererSessionId: string | null;
  rendererGeneration: number | null;
  /** Durable native process-tree identity. UUIDs are opaque and never ordered. */
  runtimeGeneration: string | null;
  statusRevision: number;
  failureReason: string | null;
}

export interface ProjectSummary {
  id: string;
  title: string;
  rootPath: string;
  rootPathLabel: string;
  status: 'ready' | 'working' | 'blocked' | 'offline' | 'unknown';
  connectionLabel: string;
  lastOpenedAt: string | null;
  lastWorkAgentId: string | null;
  creationOperationRef?: string | null;
  creationRequestSha256?: string | null;
}

export interface StarterCreationRecoverySummary {
  operationRef: string;
  displayName: string;
  finalChildPath: string;
  reason: string;
}

export type AgentStatus =
  | 'working'
  | 'assigned_waiting'
  | 'standby'
  | 'approval_wait'
  | 'blocked'
  | 'stale'
  | 'report_ready'
  | 'unknown';

export interface RuntimeEvidenceSummary {
  id: string;
  type: string;
  title: string;
  detail: string;
  level: 'reported' | 'proven' | 'inferred' | 'unknown';
  observedAt: string | null;
}

export interface AgentHistoryItem {
  id: string;
  title: string;
  state: string;
  changedAt: string;
}

export interface AgentSummary {
  id: string;
  displayName: string;
  role: string;
  roleSummary: string;
  status: AgentStatus;
  currentTaskId: string | null;
  currentTaskTitle: string | null;
  parentAgentId: string | null;
  teamId: string | null;
  lineId: string | null;
  progressPercent: number | null;
  lastEvidenceAt: string | null;
  recentEvidence: RuntimeEvidenceSummary[];
  history: AgentHistoryItem[];
}

export interface ProjectParticipantSummary {
  id: string;
  displayName: string;
  roleLabel: string;
  isCurrentUser: boolean;
  orchestratorAgentId: string | null;
}

export type TaskState =
  | 'queued'
  | 'assigned'
  | 'dispatch_accepted'
  | 'turn_started'
  | 'in_progress'
  | 'blocked'
  | 'approval_wait'
  | 'report_ready'
  | 'needs_review'
  | 'accepted'
  | 'failed'
  | 'unknown';

export interface TaskSummary {
  id: string;
  title: string;
  state: TaskState;
  ownerAgentId: string | null;
  assignedByAgentId: string | null;
  recommendedModel: string | null;
  requestedModel: string | null;
  actualModel: string | null;
  progressSummary: string | null;
  progressPercent: number | null;
  updatedAt: string | null;
}

interface AttentionItemBase {
  id: string;
  type: 'question' | 'approval' | 'report_review' | 'repair' | 'error' | 'direction';
  actionKind: 'answer' | 'approve' | 'review' | 'do';
  priority: 'low' | 'medium' | 'high' | 'blocker';
  sourceAgentId: string | null;
  taskId: string | null;
  blocking: boolean;
  createdAt: string;
  resolvedAt: string | null;
  resolutionDecision: string | null;
}

export interface CanonicalAttentionItem extends AttentionItemBase {
  sourceKind: 'user_question' | 'user_task' | 'user_action';
  title: string;
  summary: string;
  runtimeApproval: null;
}

export interface RuntimeApprovalAttentionItem extends AttentionItemBase {
  sourceKind: 'runtime_approval';
  title: null;
  summary: null;
  runtimeApproval: {
    requestedEffectKind: 'file_change' | 'command_execution' | 'other';
    responseOptions: string[];
  };
}

export type AttentionItem = CanonicalAttentionItem | RuntimeApprovalAttentionItem;

export interface PhaseSummary {
  id: string;
  title: string;
  summary: string;
  status: 'queued' | 'current' | 'blocked' | 'done' | 'unknown';
  itemCount: number;
  completedItemCount: number;
}

export interface RuntimeEventSummary {
  id: string;
  tone: 'neutral' | 'success' | 'warning' | 'danger';
  title: string;
  message: string;
  taskId: string | null;
  createdAt: string;
}

export interface InspectionRun {
  runId: string;
  kind: 'external_benchmark' | 'adversarial_audit';
  displayName: string;
  status: 'queued' | 'running' | 'cancelling' | 'report_ready' | 'partial' | 'failed' | 'cancelled' | 'closed';
  focus: string | null;
  sourceCount: number;
  createdAt: string;
  completedAt: string | null;
  errorMessage: string | null;
}

export interface WorkspaceSnapshot {
  project: ProjectSummary & {
    summary: string;
    nextMilestone: string | null;
    currentPhaseId: string | null;
    agentCount: number;
    provenWorkingAgentCount: number;
    lastSyncedAt: string | null;
  };
  /** Human participants are separate from the agent organization. */
  participants: ProjectParticipantSummary[];
  agents: AgentSummary[];
  tasks: TaskSummary[];
  attention: AttentionItem[];
  phases: PhaseSummary[];
  recentEvents: RuntimeEventSummary[];
  inspectionRuns: InspectionRun[];
}

export interface ProjectBootstrapResult {
  status: 'ready' | 'migration_required' | 'unsupported' | 'recovery_required';
  noWrite: boolean;
  reason: string | null;
  classification?: string | null;
}

export interface BusinessSourceCursor {
  journalSequence: number;
  lastBatchId: string | null;
  journalHash: string;
  projectionHash: string;
}

export interface BusinessWorkOrderSummary {
  key: string;
  workOrderId: string;
  projectRef: string | null;
  title: string;
  status: string;
  revision: number;
  engineContractVersion: number;
  createdAt: string;
  deadlineAt: string;
  branchCounts: { total: number; byState: Record<string, number> };
  lifecycle: {
    mode: string;
    automationState: string;
    blockingEffectCount: number;
    violationCount: number;
  };
  providerDelivery: {
    total: number;
    accepted: number;
    notSent: number;
    deliveryUnknown: number;
    unresolved: number;
  };
  acceptance: { decision: string | null; reviewCount: number };
}

export interface BusinessWorkOrdersResult {
  runtimeProjectId: string;
  continuity: 'initial' | 'unchanged' | 'advanced';
  cursor: BusinessSourceCursor;
  items: BusinessWorkOrderSummary[];
  nextAfterKey: string | null;
  businessProjectRefs: string[];
  providerSettlementActive: boolean;
}

export interface WorkflowCheck {
  kind: 'contains' | 'not_contains';
  text: string;
  caseSensitive: boolean;
}

export interface WorkflowDefinition {
  workflowId: string;
  name: string;
  prompt: string;
  checks: WorkflowCheck[];
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowAttempt {
  attemptId: string;
  ordinal: number;
  status: 'queued' | 'starting' | 'running' | 'completed' | 'failed' | 'cancelled';
  resultPreview: string | null;
  checkOutcome: 'passed' | 'failed' | 'unassessed' | null;
  errorMessage: string | null;
  completedAt: string | null;
  durationMs: number | null;
}

export interface WorkflowBatchMetrics {
  requestedRuns: number;
  terminalRuns: number;
  completedRuns: number;
  failedRuns: number;
  cancelledRuns: number;
  assessedRuns: number;
  passedRuns: number;
  executionReliabilityPercent: number;
  successRatePercent: number | null;
  outcomeConsistencyPercent: number | null;
  medianDurationMs: number | null;
}

export interface WorkflowBatch {
  batchId: string;
  workflowId: string;
  requestedRuns: number;
  status: 'queued' | 'running' | 'cancelling' | 'completed' | 'partial' | 'failed' | 'cancelled';
  attempts: WorkflowAttempt[];
  createdAt: string;
  completedAt: string | null;
  metrics: WorkflowBatchMetrics;
}

export interface WorkflowCatalog {
  definitions: WorkflowDefinition[];
  batches: WorkflowBatch[];
  maxAttemptsPerBatch: number;
}

export interface ConversationMessage {
  id: string;
  role: 'user' | 'agent' | 'system';
  targetAgentId: string;
  authorLabel: string;
  text: string;
  createdAt: string;
  evidenceLabel: string | null;
  status?: 'complete' | 'running';
}

export type ConversationActivityState = 'running' | 'completed' | 'failed' | 'declined' | 'updated' | 'unknown';

interface ConversationActivityBase {
  id: string;
  threadId: string;
  turnId: string;
  itemId: string | null;
  targetAgentId: string;
  state: ConversationActivityState;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastJournalSequence: number;
}

export interface CommandActivityDetails {
  commandName: string;
  actionTypes: string[];
  actionTypesTruncated: boolean;
  exitCode: number | null;
  durationMs: number | null;
  outputPresent: boolean;
  outputBytes: number;
  outputText: string | null;
  outputTruncated: boolean;
  outputRedacted: boolean;
  cwdOmitted: true;
  commandArgumentsOmitted: true;
  contentOmitted: true;
}

export interface ToolActivityDetails {
  toolKind: 'mcpToolCall' | 'dynamicToolCall' | 'collabAgentToolCall' | 'webSearch';
  toolName: string;
  toolNamespace: string | null;
  durationMs: number | null;
  success: boolean | null;
  argumentsOmitted: true;
  resultOmitted: true;
  contentOmitted: true;
}

export interface FileActivityChange {
  path: string;
  kind: string;
  originalBytes: number;
  addedLines: number;
  removedLines: number;
}

export interface FileChangeActivityDetails {
  changes: FileActivityChange[];
  changeCount: number;
  changesTruncated: boolean;
  contentOmitted: true;
}

export interface DiffActivityDetails {
  originalBytes: number;
  addedLines: number;
  removedLines: number;
  contentOmitted: true;
}

export interface PlanActivityStep {
  status: 'pending' | 'inProgress' | 'completed';
  text: string;
  truncated: boolean;
  redacted: boolean;
}

export interface PlanActivityDetails {
  text: string | null;
  originalBytes: number | null;
  truncated: boolean;
  redacted: boolean;
  steps: PlanActivityStep[];
  stepCount: number;
  stepsTruncated: boolean;
  explanation: string | null;
  explanationTruncated: boolean;
  explanationRedacted: boolean;
}

export type ConversationActivity =
  | (ConversationActivityBase & { kind: 'command'; details: CommandActivityDetails })
  | (ConversationActivityBase & { kind: 'tool'; details: ToolActivityDetails })
  | (ConversationActivityBase & { kind: 'file_change'; details: FileChangeActivityDetails })
  | (ConversationActivityBase & { kind: 'diff'; details: DiffActivityDetails })
  | (ConversationActivityBase & { kind: 'plan'; details: PlanActivityDetails });

export interface ConversationActiveTurn {
  threadId: string;
  turnId: string;
  targetAgentId: string;
  state: 'accepted' | 'in_progress' | 'interrupting';
  lastJournalSequence: number;
}

export interface ConversationTurnState {
  threadId: string;
  turnId: string;
  targetAgentId: string;
  state: 'accepted' | 'in_progress' | 'interrupting' | 'completed' | 'failed' | 'interrupted' | 'cancelled';
  lastJournalSequence: number;
}

export type AgentExecutionPhase =
  | 'queueing'
  | 'accepted'
  | 'working'
  | 'stopping'
  | 'completed'
  | 'interrupted'
  | 'failed';

/**
 * The sole application-level representation of an agent execution.
 * Native turn/activity payloads are normalized into this entity at the store boundary.
 */
export interface AgentExecution {
  executionId: string;
  projectId: string;
  targetAgentId: string;
  phase: AgentExecutionPhase;
  source: 'optimistic' | 'projection';
  summary: string;
  updatedAt: string;
  dispatchId: string | null;
  threadId: string | null;
  turnId: string | null;
  lastJournalSequence: number | null;
  canInterrupt: boolean;
}

export type ConversationSyncState = 'current' | 'advanced' | 'stream_reset' | 'gap';

export interface ConversationCursor {
  beforeCreatedAt: string;
  beforeMessageId: string;
}

export interface ConversationActivityCursor {
  beforeCreatedAt: string;
  beforeActivityId: string;
}

export interface ConversationReadCheckpoint {
  streamId: string | null;
  journalSequence: number;
  projectionRevision: number;
}

export interface ProjectedPendingRequest {
  requestKey: string;
  agentId: string | null;
  requestKind: 'attention.approval_requested' | 'attention.user_input_requested';
  responseOptions: string[];
  prompt: string | null;
  createdAt: string;
  requestedEffectKind: 'file_change' | 'command_execution' | 'other' | null;
  responsePhase: 'in_flight' | 'outcome_unknown' | null;
  recoveryState: 'actionable' | 'stale';
}

export interface ProjectedResolvedRequest {
  requestKey: string;
  agentId: string | null;
  requestKind: 'attention.approval_requested' | 'attention.user_input_requested';
  responseOptions: string[];
  createdAt: string;
  resolvedAt: string;
  requestedEffectKind: 'file_change' | 'command_execution' | 'other' | null;
  responseDecision: string;
}

export interface ConversationSnapshot {
  source: 'sqlite';
  projectId: string;
  targetAgentId: string;
  streamId: string | null;
  appliedJournalSequence: number;
  projectionRevision: number;
  syncState: ConversationSyncState;
  items: ConversationMessage[];
  activities: ConversationActivity[];
  olderCursor: ConversationCursor | null;
  activityOlderCursor: ConversationActivityCursor | null;
  pendingRequestOlderCursor: string | null;
  pendingRequests: ProjectedPendingRequest[];
  resolvedRequests: ProjectedResolvedRequest[];
  activeTurns: ConversationActiveTurn[];
  latestTurn: ConversationTurnState | null;
}

export interface HistoryCursor {
  beforeUpdatedAt: string;
  beforeMessageId: string;
}

export interface ConversationSummary {
  targetAgentId: string;
  updatedAt: string;
  lastMessageId: string;
  lastRole: 'user' | 'agent' | 'system';
  preview: string;
}

export interface HistoryIndexPage {
  source: 'sqlite';
  projectId: string;
  items: ConversationSummary[];
  nextCursor: HistoryCursor | null;
}

export interface HistoryConversationPage {
  source: 'sqlite';
  projectId: string;
  targetAgentId: string;
  query: string | null;
  items: ConversationMessage[];
  nextCursor: ConversationCursor | null;
}

export interface NativeSettings {
  schemaVersion: 2;
  revision: number;
  locale: 'ja' | 'en' | null;
  theme: 'system' | 'light' | 'dark';
  reducedMotion: boolean;
  notificationsEnabled: boolean;
}

export type VoiceAssetPhase =
  | 'absent' | 'paused' | 'downloading' | 'verifying' | 'installing'
  | 'deleting' | 'installed' | 'failed' | 'recovery_required';

export type VoiceOperationPhase =
  | 'staging' | 'transcribing' | 'transcribed' | 'cancelled' | 'failed' | 'recovery_required';

export type VoiceComposerBinding =
  | { state: 'agent'; projectId: string; agentId: string; draftSha256: string }
  | { state: 'launcher'; draftSha256: string }
  | { state: 'legacy_unbound' };

export interface VoiceAssetStatus {
  assetId: string;
  kind: 'native_binary_bundle' | 'model';
  phase: VoiceAssetPhase;
  downloadedBytes: number;
  expectedBytes: number;
  operationRef: string | null;
  lastErrorCode: string | null;
}

export interface VoiceOperationStatus {
  operationRef: string;
  composerBinding: VoiceComposerBinding;
  phase: VoiceOperationPhase;
  durationMs: number;
  transcript: string | null;
  lastErrorCode: string | null;
}

export interface VoiceStatus {
  schemaVersion: 2;
  revision: number;
  providerId: string;
  binaryAssetId: string;
  initialModelAssetId: string;
  comparisonModelAssetId: string;
  requiredAssetsReady: boolean;
  assets: VoiceAssetStatus[];
  operations: VoiceOperationStatus[];
}

export interface ComposerAttachment {
  id: string;
  selectionId: string;
  name: string;
  kind: 'image' | 'text';
  mediaType: string;
  sizeBytes: number;
}

export interface DispatchReceipt {
  /** Stable native outbox/message identity supplied before dispatch admission. */
  dispatchId: string;
  threadId: string;
  turnId: string;
}

export interface DispatchSendResult {
  receipt: DispatchReceipt;
  dispatchRecovery: DispatchRecovery | null;
}

export type DispatchRecoveryKind =
  | 'prepared_outcome_unknown'
  | 'accepted'
  | 'cleanup_pending';

export interface DispatchRecovery {
  kind: DispatchRecoveryKind;
  dispatchId: string;
  projectId: string;
  targetAgentId: string;
  createdAt: string;
  reason: string | null;
  threadId: string | null;
  turnId: string | null;
}

export interface DispatchRecoveryResult {
  recovery: DispatchRecovery | null;
  outcome: 'accepted' | 'definitive_failure' | 'outcome_unknown' | 'none';
}

export interface DesktopBootstrap {
  renderer: RendererAuthority;
  settings: NativeSettings;
  status: RuntimeStatus;
  projects: ProjectSummary[];
  starterCreationRecoveries: StarterCreationRecoverySummary[];
  selectedProjectId: string | null;
  snapshot: WorkspaceSnapshot | null;
  dispatchRecovery: DispatchRecovery | null;
  pendingAttachmentSelectionIds: string[];
  voiceStatus: VoiceStatus;
}

export interface RuntimeStatusEvent {
  type: 'runtime_status';
  statusRevision: number;
  runtimeGeneration: string | null;
  rendererSessionId: string;
  rendererGeneration: number;
  status: unknown;
}

export interface RuntimePayloadEvent {
  type: 'runtime_event';
  statusRevision: number;
  runtimeGeneration: string;
  rendererSessionId: string;
  rendererGeneration: number;
  projectId: string;
  activationToken: string;
  event: unknown;
}

export type DesktopEvent =
  | { type: 'status'; status: RuntimeStatus }
  | { type: 'snapshot'; snapshot: WorkspaceSnapshot }
  | { type: 'projection_changed'; projectId: string; streamId: string; appliedJournalSequence: number; projectionRevision: number }
  | { type: 'projection_status'; projectId: string; status: 'faulted'; code: string; message: string; retryable: boolean }
  | { type: 'workflow_catalog'; catalog: WorkflowCatalog }
  | { type: 'runtime'; event: Record<string, unknown> }
  | {
    type: 'dispatch_recovery';
    projectId: string;
    recovery: DispatchRecovery | null;
    clearedDispatchId?: string;
  }
  | { type: 'voice_status'; status: VoiceStatus };

export function runtimeAuthorityFrom(status: RuntimeStatus): RuntimeAuthority | null {
  if (status.lifecycle !== 'Ready'
    || !status.projectId
    || !status.activationToken
    || !status.rendererSessionId
    || status.rendererGeneration === null) return null;
  return {
    projectId: status.projectId,
    activationToken: status.activationToken,
    rendererSessionId: status.rendererSessionId,
    rendererGeneration: status.rendererGeneration,
  };
}

export function sameRuntimeAuthority(left: RuntimeAuthority | null, right: RuntimeAuthority | null): boolean {
  return left === right || Boolean(left && right
    && left.projectId === right.projectId
    && left.activationToken === right.activationToken
    && left.rendererSessionId === right.rendererSessionId
    && left.rendererGeneration === right.rendererGeneration);
}

export function sameRendererAuthority(left: RendererAuthority | null, right: RendererAuthority | null): boolean {
  return left === right || Boolean(left && right
    && left.rendererSessionId === right.rendererSessionId
    && left.rendererGeneration === right.rendererGeneration);
}
