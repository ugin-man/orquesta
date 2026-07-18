import type { AgentUiModel, AttentionUiItem, ProjectPhaseUiModel, TaskUiModel } from '../contracts/orquesta-ui';

export const observedAt = '2026-07-17T13:28:00.000Z';

export function agent(input: Partial<AgentUiModel> & Pick<AgentUiModel, 'id' | 'displayName' | 'role' | 'roleSummary' | 'iconKey'>): AgentUiModel {
  return {
    status: 'standby',
    statusLabel: 'Idle',
    statusEvidence: 'proven',
    currentTaskId: null,
    currentTaskTitle: null,
    assignedByAgentId: null,
    blockedReason: null,
    waitingOn: null,
    contextScope: 'Project-scoped context only',
    requiredReadingCount: 2,
    expectedArtifact: null,
    lastEvidenceAt: observedAt,
    lastHeartbeatAt: observedAt,
    recentEvidence: [],
    history: [],
    forbiddenActions: ['Do not expand project scope without approval.'],
    ...input
  };
}

export function task(input: Partial<TaskUiModel> & Pick<TaskUiModel, 'id' | 'title'>): TaskUiModel {
  return {
    state: 'queued',
    ownerAgentId: null,
    assignedByAgentId: null,
    dependencies: [],
    blockedBy: [],
    routingClass: null,
    handoffSent: false,
    dispatchAccepted: false,
    turnStarted: false,
    progressObserved: false,
    progressSummary: null,
    progressPercent: null,
    reportStatus: null,
    reportPath: null,
    expectedArtifact: null,
    acceptanceChecks: [],
    recommendedModel: null,
    requestedModel: null,
    actualModel: null,
    actualModelEvidence: 'unknown',
    startedAt: null,
    updatedAt: observedAt,
    userActionId: null,
    ...input
  };
}

export function attention(input: Partial<AttentionUiItem> & Pick<AttentionUiItem, 'id' | 'type' | 'title' | 'summary'>): AttentionUiItem {
  return {
    priority: 'medium',
    sourceAgentId: null,
    taskId: null,
    blocking: false,
    primaryActionLabel: 'View',
    createdAt: observedAt,
    resolvedAt: null,
    resolutionLabel: null,
    ...input
  };
}

export function phase(input: Partial<ProjectPhaseUiModel> & Pick<ProjectPhaseUiModel, 'id' | 'title' | 'summary'>): ProjectPhaseUiModel {
  return {
    status: 'queued',
    ownerAgentIds: [],
    itemCount: 0,
    completedItemCount: 0,
    ...input
  };
}
