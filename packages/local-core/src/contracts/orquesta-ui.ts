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
export type InspectionKind = 'external_benchmark' | 'adversarial_audit';
export type InspectionRunStatus =
  | 'queued'
  | 'running'
  | 'cancelling'
  | 'report_ready'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'closed';

export interface InspectionTargetUi {
  kind: 'project' | 'line' | 'team' | 'agents';
  ids: string[];
  label: string;
}

export interface InspectionTemplateUiModel {
  kind: InspectionKind;
  displayName: string;
  summary: string;
  color: 'blue' | 'red';
  activeRunId: string | null;
  lastReportRunId: string | null;
}

export interface InspectionRunUiModel {
  runId: string;
  kind: InspectionKind;
  displayName: string;
  status: InspectionRunStatus;
  target: InspectionTargetUi;
  focus: string | null;
  threadId: string | null;
  turnId: string | null;
  reportPath: string | null;
  sourceCount: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}

export const INSPECTION_TEMPLATE_DEFINITIONS = [
  {
    kind: 'external_benchmark',
    displayName: 'External benchmark',
    summary: 'Compare this project with current competing products and reusable external assets.',
    color: 'blue'
  },
  {
    kind: 'adversarial_audit',
    displayName: 'Adversarial audit',
    summary: 'Challenge the current organization and workflow using project evidence only.',
    color: 'red'
  }
] as const satisfies ReadonlyArray<Omit<InspectionTemplateUiModel, 'activeRunId' | 'lastReportRunId'>>;

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
  statusEvidence: EvidenceLevel;
  currentTaskId: string | null;
  currentTaskTitle: string | null;
  assignedByAgentId: string | null;
  roleId?: string | null;
  teamId?: string | null;
  lineId?: string | null;
  position?: 'member' | 'lead' | null;
  organizationParentAgentId?: string | null;
  delegatedByAgentId?: string | null;
  organizationScope?: 'project' | 'line' | null;
  lifecycleState?: 'proposed' | 'provisioning' | 'active' | 'retired' | 'superseded' | null;
  operationalStatus?: string | null;
  organizationRevision?: number | null;
  membershipOrdinal?: number | null;
  displayOrder?: number | null;
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

interface AttentionUiItemBase {
  id: string;
  type: AttentionType;
  actionKind: UserActionKind;
  priority: 'low' | 'medium' | 'high' | 'blocker';
  sourceAgentId: string | null;
  taskId: string | null;
  blocking: boolean;
  createdAt: string;
  resolvedAt: string | null;
  resolutionDecision: string | null;
}

export interface CanonicalAttentionUiItem extends AttentionUiItemBase {
  sourceKind: 'user_question' | 'user_task' | 'user_action';
  title: string;
  summary: string;
  runtimeApproval?: never;
}

export type AttentionUiItem = CanonicalAttentionUiItem;

export interface ProjectPhaseUiModel {
  id: string;
  title: string;
  summary: string;
  status: 'queued' | 'current' | 'blocked' | 'done' | 'unknown';
  ownerAgentIds: string[];
  itemCount: number;
  completedItemCount: number;
}

export interface OrganizationLineUiModel {
  id: string;
  displayName: string;
  goal: string | null;
  status: string;
  ownerAgentId: string;
  dedicatedLeadAgentId: string | null;
  displayOrder: number;
  approvalSource: string | null;
}

export interface OrganizationTeamUiModel {
  id: string;
  lineId: string | null;
  displayName: string;
  purpose: string | null;
  lifecycleState: string;
  displayOrder: number;
}

export interface OrganizationRelationshipUiModel {
  id: string;
  type: string;
  fromAgentId: string;
  toAgentId: string;
}

export interface OrganizationLineProposalUiModel {
  id: string;
  lineId: string;
  displayName: string;
  goal: string;
  reason: string;
  status: 'approval_wait';
  ownerAgentId: string | null;
}

export interface OrganizationUiSnapshot {
  revision: number;
  source: 'explicit' | 'legacy';
  diagnostics: string[];
  lines: OrganizationLineUiModel[];
  teams: OrganizationTeamUiModel[];
  relationships: OrganizationRelationshipUiModel[];
  lineProposals: OrganizationLineProposalUiModel[];
}

export interface ProjectParticipantUiModel {
  id: string;
  displayName: string;
  roleLabel: string;
  isCurrentUser: boolean;
  orchestratorAgentId: string | null;
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

function boundedRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function boundedText(value: unknown, maximum = 4_096): value is string {
  return typeof value === 'string' && value.length <= maximum;
}

function boundedNullableText(value: unknown, maximum = 4_096): boolean {
  return value === null || boundedText(value, maximum);
}

function boundedStrings(value: unknown, maximumItems = 128, maximumText = 4_096): value is string[] {
  return Array.isArray(value) && value.length <= maximumItems && value.every((item) => boundedText(item, maximumText));
}

function boundedArray(value: unknown, maximum: number, validator: (item: unknown) => boolean): boolean {
  return Array.isArray(value) && value.length <= maximum && value.every(validator);
}

export type ProjectStructureStatus = 'healthy' | 'attention' | 'blocked' | 'unavailable';
export type ProjectStructureLifecycle = 'current' | 'superseded' | 'archived' | 'quarantined' | 'delete_candidate' | 'unknown';

export interface ProjectStructureSourceUi {
  sourceRef: string;
  componentId: string | null;
  lifecycle: ProjectStructureLifecycle;
  authority: string;
  readPolicy: string;
}

export interface ProjectStructureIssueUi {
  severity: 'error' | 'warning' | 'suggestion' | 'unknown';
  code: string;
  message: string;
  sourceRefs: string[];
}

export interface SpecialistContextUi {
  taskId: string;
  taskTitle: string;
  ownerAgentId: string | null;
  taskState: string;
  active: boolean;
  requiredReading: string[];
}

export interface ProjectStructureMigrationUi {
  planId: string | null;
  resultId: string | null;
  status: string;
  operationCount: number;
  destructiveOperationCount: number;
  approvalDecision: string | null;
  appliedAt: string | null;
  verificationStatus: 'passed' | 'warning' | 'not_run';
  rollbackStepCount: number;
}

export interface ProjectStructureUiSnapshot {
  available: boolean;
  status: ProjectStructureStatus;
  generatedAt: string | null;
  indexedFileCount: number;
  canonicalSourceCount: number;
  lifecycleCounts: {
    current: number;
    superseded: number;
    archived: number;
    quarantined: number;
    deleteCandidate: number;
  };
  issueCounts: { error: number; warning: number; suggestion: number };
  canonicalSources: ProjectStructureSourceUi[];
  retiredSources: ProjectStructureSourceUi[];
  issues: ProjectStructureIssueUi[];
  specialistContexts: SpecialistContextUi[];
  contextOverview: {
    viewId: string | null;
    candidateSourceCount: number;
    excludedSourceCount: number;
    warnings: string[];
  };
  migration: ProjectStructureMigrationUi | null;
  limitation: string | null;
}

export interface OrquestaUiSnapshot {
  project: ProjectUiModel;
  participants: ProjectParticipantUiModel[];
  agents: AgentUiModel[];
  tasks: TaskUiModel[];
  attention: AttentionUiItem[];
  failures: FailureUiModel[];
  phases: ProjectPhaseUiModel[];
  recentEvents: RuntimeUiEvent[];
  organization?: OrganizationUiSnapshot;
  projectStructure?: ProjectStructureUiSnapshot;
  inspectionTemplates: InspectionTemplateUiModel[];
  inspectionRuns: InspectionRunUiModel[];
}
