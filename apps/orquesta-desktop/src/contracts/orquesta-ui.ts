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
export type ProjectStatus = 'ready' | 'working' | 'blocked' | 'offline' | 'unknown';

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

export interface OrquestaUiSnapshot {
  project: ProjectUiModel;
  agents: AgentUiModel[];
  tasks: TaskUiModel[];
  attention: AttentionUiItem[];
  phases: ProjectPhaseUiModel[];
  recentEvents: RuntimeUiEvent[];
}
