export type EvidenceLevel = 'proven' | 'reported' | 'inferred' | 'unknown';
export type AgentUiStatus =
  | 'working'
  | 'assigned_waiting'
  | 'standby'
  | 'approval_wait'
  | 'blocked'
  | 'stale'
  | 'report_ready'
  | 'unknown';
export type TaskUiState =
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
export type AttentionType =
  | 'question'
  | 'approval'
  | 'report_review'
  | 'user_capability_review'
  | 'repair'
  | 'error'
  | 'direction';
export type UserActionKind = 'answer' | 'approve' | 'review' | 'do';
export type ProjectStatus = 'ready' | 'working' | 'blocked' | 'offline' | 'unknown';
export type RepositoryDisplayState = 'watching' | 'snapshot' | 'offline' | 'demo' | 'error';
export type FailureUiSeverity = 'low' | 'medium' | 'high' | 'blocker' | 'unknown';
export type FailureUiResolution = 'open' | 'resolved' | 'unknown';
export type FailureUiSource = 'incident' | 'candidate' | 'cluster';

export interface RuntimeEvidenceUi {
  id: string;
  label: string;
  detail: string;
  level: EvidenceLevel;
  observedAt: string | null;
}

export interface AgentHistoryUiItem {
  id: string;
  title: string;
  state: string;
  changedAt: string;
}

export interface AgentUiModel {
  id: string;
  displayName: string;
  role: string;
  roleSummary: string;
  iconKey: string;
  status: AgentUiStatus;
  statusLabel: string;
  statusEvidence: EvidenceLevel;
  currentTaskId: string | null;
  currentTaskTitle: string | null;
  assignedByAgentId: string | null;
  blockedReason: string | null;
  waitingOn: string | null;
  contextScope: string | null;
  requiredReadingCount: number;
  expectedArtifact: string | null;
  lastEvidenceAt: string | null;
  lastHeartbeatAt: string | null;
  recentEvidence: RuntimeEvidenceUi[];
  history: AgentHistoryUiItem[];
  forbiddenActions: string[];
}

export interface TaskUiModel {
  id: string;
  title: string;
  state: TaskUiState;
  ownerAgentId: string | null;
  assignedByAgentId: string | null;
  dependencies: string[];
  blockedBy: string[];
  routingClass: string | null;
  handoffSent: boolean;
  dispatchAccepted: boolean;
  turnStarted: boolean;
  progressObserved: boolean;
  progressSummary: string | null;
  progressPercent: number | null;
  reportStatus: string | null;
  reportPath: string | null;
  expectedArtifact: string | null;
  acceptanceChecks: string[];
  recommendedModel: string | null;
  requestedModel: string | null;
  actualModel: string | null;
  actualModelEvidence: EvidenceLevel;
  startedAt: string | null;
  updatedAt: string | null;
  userActionId: string | null;
}

export interface AttentionUiItem {
  id: string;
  type: AttentionType;
  actionKind: UserActionKind;
  priority: 'low' | 'medium' | 'high' | 'blocker';
  title: string;
  summary: string;
  sourceAgentId: string | null;
  taskId: string | null;
  blocking: boolean;
  primaryActionLabel: string;
  createdAt: string;
  resolvedAt: string | null;
  resolutionLabel: string | null;
  runtimeApproval?: {
    requestId: string;
    method: string;
    threadId: string;
    turnId: string;
    responseOptions: string[];
  };
}

export interface ProjectPhaseUiModel {
  id: string;
  title: string;
  summary: string;
  status: 'queued' | 'current' | 'blocked' | 'done' | 'unknown';
  ownerAgentIds: string[];
  itemCount: number;
  completedItemCount: number;
}

export interface ProjectUiModel {
  id: string;
  title: string;
  rootPathLabel: string | null;
  status: ProjectStatus;
  connectionLabel: string;
  isDemoData: boolean;
  repositoryDisplayState: RepositoryDisplayState;
  lastSyncedAt: string | null;
  currentPhaseId: string | null;
  agentCount: number;
  provenWorkingAgentCount: number;
  summary: string;
  nextMilestone: string | null;
}

export interface RuntimeUiEvent {
  id: string;
  tone: 'neutral' | 'success' | 'warning' | 'danger';
  title: string;
  message: string;
  taskId: string | null;
  createdAt: string;
}

export interface FailureOccurrenceUi {
  id: string;
  source: 'incident' | 'candidate';
  status: string;
  summary: string;
  occurredAt: string | null;
  taskId: string | null;
  sourceAgentId: string | null;
  evidence: string[];
  attemptedFixes: string[];
  outcome: string | null;
}

export interface FailureUiModel {
  id: string;
  source: FailureUiSource;
  failureClass: string;
  title: string;
  summary: string;
  severity: FailureUiSeverity;
  status: string;
  resolution: FailureUiResolution;
  occurrenceCount: number;
  firstOccurredAt: string | null;
  lastOccurredAt: string | null;
  taskIds: string[];
  sourceAgentIds: string[];
  suspectedOwner: string | null;
  repairStatus: string | null;
  cause: string | null;
  fix: string | null;
  prevention: string[];
  evidence: string[];
  occurrences: FailureOccurrenceUi[];
}

export interface V4TaskIntentUi {
  id: string;
  desiredOutcome: string;
  acceptanceCriteria: string[];
  rawRequestRef: string;
}

export interface V4CapabilityNeedUi {
  id: string;
  description: string;
  kind: string;
  requiredLevel: string;
  status: string;
  confidence: number;
}

export interface V4ProviderUi {
  id: string;
  type: string;
  sourceUri: string;
  capabilities: string[];
  trustTier: string;
  availability: string;
  version: string;
  lastVerifiedAt: string;
  evidenceRefs: string[];
}

export interface V4CandidateEvaluationUi {
  id: string;
  candidateId: string;
  needId: string;
  score: number;
  eligibility: string;
  hardGates: Array<{ name: string; status: string; reason: string }>;
  actualModel: string | null;
}

export interface V4ResolutionUi {
  id: string;
  needId: string;
  mode: string;
  providerId: string | null;
  approvalStatus: string;
  totalCost: number;
}

export interface V4ContextPackUi {
  id: string;
  ownerAgentId: string;
  objective: string;
  requiredReading: string[];
  resolutionIds: string[];
  status: string;
}

export interface V4AcquisitionSourceUi {
  connectorId: string;
  trustTier: string;
  status: string;
  fetchedAt: string;
  expiresAt: string;
  candidateIds: string[];
  sourceEvidenceRefs: string[];
  cacheStatus: string;
}

export interface V4AcquisitionSnapshotUi {
  queryId: string;
  needId: string;
  queryTerms: string[];
  requestedAt: string;
  maxRequests: number;
  consumedRequests: number;
  remainingRequests: number;
  sources: V4AcquisitionSourceUi[];
}

export interface V4AuditionResultUi {
  planId: string;
  verdict: string;
  observedProfile: string;
  cleanupEvidence: string[];
  evidenceRefs: string[];
}

export interface V4EvidenceItemUi {
  id: string;
  kind: string;
  correlationId: string;
  threadId: string | null;
  turnId: string | null;
  predecessorId: string | null;
  ref: string | null;
  sequence: number;
}

export interface V4AuditTimelineItemUi {
  sequence: number;
  eventId: string;
  type: string;
  actorId: string;
  responsibility: string;
  commandName: string | null;
  scoutSkipReason: string | null;
  evidenceRefs: string[];
}

export interface V4OperationsSnapshot {
  available: boolean;
  revision: number;
  taskIntent: V4TaskIntentUi | null;
  capabilityNeeds: V4CapabilityNeedUi[];
  providers: V4ProviderUi[];
  candidateEvaluations: V4CandidateEvaluationUi[];
  latestResolutions: V4ResolutionUi[];
  contextPack: V4ContextPackUi | null;
  acquisitionSnapshots: V4AcquisitionSnapshotUi[];
  auditionResults: V4AuditionResultUi[];
  installRequest: { id: string; status: string; candidateId: string; expiresAt: string | null } | null;
  evidenceChains: Array<{ correlationId: string; items: V4EvidenceItemUi[] }>;
  runtimeCorrelations: Array<{ correlationId: string; dispatchEvidenceId: string | null; activeThreadId: string | null; activeTurnId: string | null }>;
  auditTimeline: V4AuditTimelineItemUi[];
  phaseReviews: Array<{ phaseId: string; status: string; reviewPacketRef: string; buildRef: string }>;
  limitation: string | null;
}

export function emptyV4OperationsSnapshot(limitation = 'V4 journal unavailable'): V4OperationsSnapshot {
  return {
    available: false,
    revision: 0,
    taskIntent: null,
    capabilityNeeds: [],
    providers: [],
    candidateEvaluations: [],
    latestResolutions: [],
    contextPack: null,
    acquisitionSnapshots: [],
    auditionResults: [],
    installRequest: null,
    evidenceChains: [],
    runtimeCorrelations: [],
    auditTimeline: [],
    phaseReviews: [],
    limitation,
  };
}

function v4Record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function v4Text(value: unknown, maximum = 4_096): value is string {
  return typeof value === 'string' && value.length <= maximum;
}

function v4NullableText(value: unknown, maximum = 4_096): boolean {
  return value === null || v4Text(value, maximum);
}

function v4Strings(value: unknown, maximumItems = 128, maximumText = 4_096): value is string[] {
  return Array.isArray(value) && value.length <= maximumItems && value.every((item) => v4Text(item, maximumText));
}

function v4Array(value: unknown, maximum: number, validator: (item: unknown) => boolean): boolean {
  return Array.isArray(value) && value.length <= maximum && value.every(validator);
}

function isTaskIntent(value: unknown): boolean {
  if (value === null) return true;
  if (!v4Record(value)) return false;
  return v4Text(value.id, 256) && v4Text(value.desiredOutcome) && v4Strings(value.acceptanceCriteria)
    && v4Text(value.rawRequestRef);
}

function isCapabilityNeed(value: unknown): boolean {
  if (!v4Record(value)) return false;
  return v4Text(value.id, 256) && v4Text(value.description) && v4Text(value.kind, 128)
    && v4Text(value.requiredLevel, 256) && v4Text(value.status, 128)
    && typeof value.confidence === 'number' && Number.isFinite(value.confidence);
}

function isProvider(value: unknown): boolean {
  if (!v4Record(value)) return false;
  return v4Text(value.id, 256) && v4Text(value.type, 256) && v4Text(value.sourceUri, 32_768)
    && v4Strings(value.capabilities) && v4Text(value.trustTier, 128) && v4Text(value.availability, 128)
    && v4Text(value.version, 256) && v4Text(value.lastVerifiedAt, 256) && v4Strings(value.evidenceRefs, 128, 32_768);
}

function isEvaluation(value: unknown): boolean {
  if (!v4Record(value)) return false;
  return v4Text(value.id, 256) && v4Text(value.candidateId, 256) && v4Text(value.needId, 256)
    && typeof value.score === 'number' && Number.isFinite(value.score) && v4Text(value.eligibility, 128)
    && (value.actualModel === null || v4Text(value.actualModel, 256))
    && v4Array(value.hardGates, 64, (gate) => v4Record(gate) && v4Text(gate.name, 256)
      && v4Text(gate.status, 128) && v4Text(gate.reason));
}

function isResolution(value: unknown): boolean {
  if (!v4Record(value)) return false;
  return v4Text(value.id, 256) && v4Text(value.needId, 256) && v4Text(value.mode, 128)
    && (value.providerId === null || v4Text(value.providerId, 256)) && v4Text(value.approvalStatus, 128)
    && typeof value.totalCost === 'number' && Number.isFinite(value.totalCost);
}

function isContextPack(value: unknown): boolean {
  if (value === null) return true;
  if (!v4Record(value)) return false;
  return v4Text(value.id, 256) && v4Text(value.ownerAgentId, 256) && v4Text(value.objective)
    && v4Strings(value.requiredReading, 128, 32_768) && v4Strings(value.resolutionIds) && v4Text(value.status, 128);
}

function isAcquisition(value: unknown): boolean {
  if (!v4Record(value)) return false;
  return v4Text(value.queryId, 256) && v4Text(value.needId, 256) && v4Strings(value.queryTerms, 32)
    && v4Text(value.requestedAt, 256)
    && ['maxRequests', 'consumedRequests', 'remainingRequests'].every((field) => (
      typeof value[field] === 'number' && Number.isInteger(value[field]) && Number(value[field]) >= 0
    ))
    && v4Array(value.sources, 8, (source) => v4Record(source) && v4Text(source.connectorId, 128)
      && v4Text(source.trustTier, 128) && v4Text(source.status, 128) && v4Text(source.fetchedAt, 256)
      && v4Text(source.expiresAt, 256) && v4Strings(source.candidateIds, 3, 256)
      && v4Strings(source.sourceEvidenceRefs, 128, 32_768) && v4Text(source.cacheStatus, 128));
}

function isAudition(value: unknown): boolean {
  if (!v4Record(value)) return false;
  return v4Text(value.planId, 256) && v4Text(value.verdict, 128) && v4Text(value.observedProfile, 256)
    && v4Strings(value.cleanupEvidence, 128) && v4Strings(value.evidenceRefs, 128, 32_768);
}

function isEvidenceChain(value: unknown): boolean {
  if (!v4Record(value) || !v4Text(value.correlationId, 256)) return false;
  return v4Array(value.items, 32, (item) => v4Record(item) && v4Text(item.id, 256)
    && v4Text(item.kind, 128) && v4Text(item.correlationId, 256) && v4NullableText(item.threadId, 256)
    && v4NullableText(item.turnId, 256) && v4NullableText(item.predecessorId, 256)
    && v4NullableText(item.ref, 32_768) && typeof item.sequence === 'number' && Number.isInteger(item.sequence));
}

function isRuntimeCorrelation(value: unknown): boolean {
  return v4Record(value) && v4Text(value.correlationId, 256) && v4NullableText(value.dispatchEvidenceId, 256)
    && v4NullableText(value.activeThreadId, 256) && v4NullableText(value.activeTurnId, 256);
}

function isTimelineItem(value: unknown): boolean {
  return v4Record(value) && typeof value.sequence === 'number' && Number.isInteger(value.sequence)
    && v4Text(value.eventId, 256) && v4Text(value.type, 256) && v4Text(value.actorId, 256)
    && v4Text(value.responsibility, 128) && v4NullableText(value.commandName, 256)
    && v4NullableText(value.scoutSkipReason) && v4Strings(value.evidenceRefs, 128, 32_768);
}

export function isV4OperationsSnapshot(value: unknown): value is V4OperationsSnapshot {
  if (!v4Record(value)) return false;
  try {
    if (JSON.stringify(value).length > 1_000_000) return false;
  } catch {
    return false;
  }
  const install = value.installRequest;
  const installValid = install === null || (v4Record(install) && v4Text(install.id, 256)
    && v4Text(install.status, 128) && v4Text(install.candidateId, 256) && v4NullableText(install.expiresAt, 256));
  const reviewsValid = v4Array(value.phaseReviews, 128, (review) => v4Record(review)
    && v4Text(review.phaseId, 256) && v4Text(review.status, 128)
    && v4Text(review.reviewPacketRef, 32_768) && v4Text(review.buildRef, 32_768));
  return typeof value.available === 'boolean' && Number.isInteger(value.revision) && Number(value.revision) >= 0
    && isTaskIntent(value.taskIntent) && v4Array(value.capabilityNeeds, 128, isCapabilityNeed)
    && v4Array(value.providers, 128, isProvider) && v4Array(value.candidateEvaluations, 128, isEvaluation)
    && v4Array(value.latestResolutions, 128, isResolution) && isContextPack(value.contextPack)
    && v4Array(value.acquisitionSnapshots, 128, isAcquisition) && v4Array(value.auditionResults, 128, isAudition)
    && installValid && v4Array(value.evidenceChains, 128, isEvidenceChain)
    && v4Array(value.runtimeCorrelations, 128, isRuntimeCorrelation)
    && v4Array(value.auditTimeline, 500, isTimelineItem) && reviewsValid && v4NullableText(value.limitation);
}

export interface OrquestaUiSnapshot {
  project: ProjectUiModel;
  agents: AgentUiModel[];
  tasks: TaskUiModel[];
  attention: AttentionUiItem[];
  failures: FailureUiModel[];
  phases: ProjectPhaseUiModel[];
  recentEvents: RuntimeUiEvent[];
  v4Operations: V4OperationsSnapshot;
}
