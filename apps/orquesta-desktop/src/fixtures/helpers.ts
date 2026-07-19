import type { AgentUiModel, AttentionUiItem, ProjectPhaseUiModel, TaskUiModel, V4OperationsSnapshot } from '../contracts/orquesta-ui';

export const observedAt = '2026-07-17T13:28:00.000Z';
export const fixtureV4Operations: V4OperationsSnapshot = {
  available: true,
  revision: 42,
  taskIntent: { id: 'TI-desktop', desiredOutcome: 'Ship the complete Orquesta Desktop control plane', acceptanceCriteria: ['Canonical V4 state is visible without mutation.', 'Runtime evidence remains explicit.'], rawRequestRef: 'fixture:desktop-request' },
  capabilityNeeds: [{ id: 'NEED-runtime', description: 'Pinned Codex runtime', kind: 'runtime', requiredLevel: 'exact', status: 'resolved', confidence: 96 }],
  providers: [{ id: 'provider-codex', type: 'package', sourceUri: 'npm:@openai/codex', capabilities: ['runtime'], trustTier: 'trusted', availability: 'available', version: '0.144.5', lastVerifiedAt: observedAt, evidenceRefs: ['package-lock:@openai/codex'] }],
  candidateEvaluations: [{ id: 'EVAL-codex', candidateId: 'provider-codex', needId: 'NEED-runtime', score: 94, eligibility: 'eligible', hardGates: [{ name: 'version', status: 'pass', reason: 'Pinned exact version' }], actualModel: null }],
  latestResolutions: [{ id: 'RES-runtime', needId: 'NEED-runtime', mode: 'reuse', providerId: 'provider-codex', approvalStatus: 'approved', totalCost: 0 }],
  contextPack: { id: 'CP-desktop', ownerAgentId: 'coder', objective: 'Integrate V4 state into Desktop', requiredReading: ['README.md', 'docs/V4_DESIGN.md'], resolutionIds: ['RES-runtime'], status: 'ready' },
  acquisitionSnapshots: [{ queryId: 'LSQ-runtime', needId: 'NEED-runtime', queryTerms: ['codex runtime'], requestedAt: observedAt, maxRequests: 8, consumedRequests: 2, remainingRequests: 6, sources: [{ connectorId: 'official_docs', trustTier: 'official', status: 'success', fetchedAt: observedAt, expiresAt: '2026-07-18T13:28:00.000Z', candidateIds: ['provider-codex'], sourceEvidenceRefs: ['docs:codex'], cacheStatus: 'fresh' }] }],
  auditionResults: [{ planId: 'AP-runtime', verdict: 'passed', observedProfile: 'workspace-write', cleanupEvidence: ['cleanup:verified'], evidenceRefs: ['artifact:audition'] }],
  installRequest: { id: 'INSTALL-runtime', status: 'authorized', candidateId: 'provider-codex', expiresAt: null },
  evidenceChains: [{ correlationId: 'CORR-desktop', items: [{ id: 'EVID-dispatch', kind: 'runtime_dispatch', correlationId: 'CORR-desktop', threadId: 'thread-desktop', turnId: null, predecessorId: null, ref: 'fixture:request', sequence: 38 }, { id: 'EVID-turn', kind: 'runtime_event', correlationId: 'CORR-desktop', threadId: 'thread-desktop', turnId: 'turn-desktop', predecessorId: 'EVID-dispatch', ref: null, sequence: 39 }] }],
  runtimeCorrelations: [{ correlationId: 'CORR-desktop', dispatchEvidenceId: 'EVID-dispatch', activeThreadId: 'thread-desktop', activeTurnId: 'turn-desktop' }],
  auditTimeline: [{ sequence: 41, eventId: 'EV-audit', type: 'candidate.audit.recorded', actorId: 'reviewer', responsibility: 'static_audit', commandName: 'candidate.audit.record', scoutSkipReason: null, evidenceRefs: ['fixture:audit-report'] }],
  phaseReviews: [{ phaseId: 'phase-2', status: 'ready_for_user_review', reviewPacketRef: 'fixture:phase2-review', buildRef: 'fixture:desktop-build' }],
  limitation: null,
};

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
  const actionKind = input.type === 'question'
    ? 'answer'
    : input.type === 'approval'
      ? 'approve'
      : input.type === 'report_review' || input.type === 'user_capability_review'
        ? 'review'
        : 'do';
  return {
    actionKind,
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
