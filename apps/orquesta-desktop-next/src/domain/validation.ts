import type {
  AttentionItem,
  ComposerAttachment,
  ConversationActivity,
  ConversationMessage,
  ConversationSnapshot,
  HistoryConversationPage,
  HistoryIndexPage,
  DesktopBootstrap,
  DispatchRecovery,
  DispatchRecoveryResult,
  InspectionRun,
  NativeSettings,
  ProjectSummary,
  RendererAuthority,
  RuntimeStatus,
  WorkspaceSnapshot,
  BusinessWorkOrderSummary,
  BusinessWorkOrdersResult,
  WorkflowAttempt,
  WorkflowBatch,
  WorkflowBatchMetrics,
  WorkflowCatalog,
  WorkflowCheck,
  WorkflowDefinition,
  VoiceAssetPhase,
  VoiceAssetStatus,
  VoiceOperationPhase,
  VoiceComposerBinding,
  VoiceOperationStatus,
  VoiceStatus,
} from './models';
import { compareConversationActivityOrder, compareConversationEntryOrder } from './exact-order';
import {
  NATIVE_ATTACHMENT_PICKER_ACCEPT,
  NATIVE_CONTENT_POLICY,
} from '../../../../packages/contracts/generated/desktop/native-bridge-contract';

const ATTACHMENT_POLICY = NATIVE_CONTENT_POLICY.attachments;
const ATTACHMENT_FORMATS: ReadonlyMap<string, Readonly<{
  extension: string;
  kind: 'image' | 'text';
  mediaType: string;
}>> = new Map(
  ATTACHMENT_POLICY.formats.map((format) => [format.extension, format] as const),
);
const UTF8_ENCODER = new TextEncoder();
export const ATTACHMENT_PICKER_ACCEPT = NATIVE_ATTACHMENT_PICKER_ACCEPT;
export const MESSAGE_TEXT_MAX_LENGTH_HINT = NATIVE_CONTENT_POLICY.message.maxUtf8Bytes;

export const BUSINESS_WORK_ORDER_REQUIRED_FEATURES = Object.freeze([
  'authoritative-lifecycle-mode.v1',
  'journal-prefix-continuity.v1',
  'provider-delivery-separate-from-acceptance.v1',
  'root-journal-all-business-project-refs.v1',
  'work-order-index.v1',
]);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, maximum = 65_536): value is string {
  return typeof value === 'string' && value.length <= maximum;
}

function nonEmptyText(value: unknown, maximum = 65_536): value is string {
  return text(value, maximum) && value.trim().length > 0;
}

function nullableText(value: unknown, maximum = 65_536): value is string | null {
  return value === null || text(value, maximum);
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function nullableNonEmptyText(value: unknown, maximum = 65_536): value is string | null {
  return value === null || nonEmptyText(value, maximum);
}

function epochMilliseconds(value: unknown): value is number {
  return nonNegativeInteger(value) && Number(value) <= 8_640_000_000_000_000;
}

function isoFromMilliseconds(value: number): string {
  try { return new Date(value).toISOString(); } catch { throw new Error('Native timestamp is invalid.'); }
}

export function parseRendererAuthority(value: unknown): RendererAuthority {
  if (!isRecord(value)
    || !nonEmptyText(value.rendererSessionId, 128)
    || !nonNegativeInteger(value.rendererGeneration)
    || Number(value.rendererGeneration) < 1) {
    throw new Error('Native renderer session response is invalid.');
  }
  return {
    rendererSessionId: value.rendererSessionId,
    rendererGeneration: Number(value.rendererGeneration),
  };
}

export function parseRuntimeStatus(value: unknown): RuntimeStatus {
  if (!isRecord(value)) throw new Error('Native runtime status is invalid.');
  const phase = String(value.phase);
  if (!['stopped', 'starting', 'ready', 'stopping', 'faulted'].includes(phase)
    || !nullableNonEmptyText(value.runtimeGeneration, 128)
    || !nonNegativeInteger(value.statusRevision)
    || !(value.pid === null || nonNegativeInteger(value.pid))
    || !(value.startedAtMs === null || epochMilliseconds(value.startedAtMs))
    || !nullableNonEmptyText(value.activeProjectId, 256)
    || !nullableNonEmptyText(value.authorityActivationToken, 256)
    || !nullableNonEmptyText(value.authorityRendererSessionId, 128)
    || !(value.authorityRendererGeneration === null || nonNegativeInteger(value.authorityRendererGeneration))
    || typeof value.processTerminationConfirmed !== 'boolean'
    || !(value.lastError === null || (isRecord(value.lastError)
      && nonEmptyText(value.lastError.code, 256)
      && text(value.lastError.message, 4_096)
      && typeof value.lastError.retryable === 'boolean'
      && typeof value.lastError.outcomeUnknown === 'boolean'))) {
    throw new Error('Native runtime status fields are invalid.');
  }
  const lifecycle = ({ stopped: 'Stopped', starting: 'Starting', ready: 'Ready', stopping: 'Stopping', faulted: 'Failed' } as const)[phase as 'stopped' | 'starting' | 'ready' | 'stopping' | 'faulted'];
  const status: RuntimeStatus = {
    lifecycle,
    projectId: value.activeProjectId,
    activationToken: value.authorityActivationToken,
    rendererSessionId: value.authorityRendererSessionId,
    rendererGeneration: value.authorityRendererGeneration === null ? null : Number(value.authorityRendererGeneration),
    runtimeGeneration: value.runtimeGeneration,
    statusRevision: Number(value.statusRevision),
    failureReason: isRecord(value.lastError) ? String(value.lastError.message) : null,
  };
  const hasCompleteAuthority = Boolean(status.projectId && status.activationToken
    && status.rendererSessionId && status.rendererGeneration !== null);
  const hasAnyAuthority = Boolean(status.projectId || status.activationToken
    || status.rendererSessionId || status.rendererGeneration !== null);
  if (hasAnyAuthority && !hasCompleteAuthority) {
    throw new Error('Native runtime status contains a partial authority.');
  }
  if (status.lifecycle === 'Ready' && status.runtimeGeneration === null) {
    throw new Error('Ready runtime status does not contain a runtime generation.');
  }
  if (status.lifecycle === 'Stopped' && (status.projectId || status.activationToken)) {
    throw new Error('Stopped runtime status unexpectedly contains an active project authority.');
  }
  return status;
}

/** Native registry records are deliberately normalized only at this boundary. */
export function parseNativeProjectSummary(value: unknown): ProjectSummary {
  if (!isRecord(value)
    || !nonEmptyText(value.projectId, 256)
    || !nonEmptyText(value.displayName, 1_024)
    || !nonEmptyText(value.rootPath, 32_768)
    || !nonEmptyText(value.rootIdentity, 256)
    || !epochMilliseconds(value.createdAtMs)
    || !epochMilliseconds(value.lastOpenedAtMs)
    || !nullableNonEmptyText(value.lastWorkAgentId, 256)) throw new Error('Native project record is invalid.');
  return {
    id: value.projectId,
    title: value.displayName,
    rootPath: value.rootPath,
    rootPathLabel: value.rootPath,
    status: 'unknown',
    connectionLabel: 'Registered locally',
    lastOpenedAt: isoFromMilliseconds(value.lastOpenedAtMs),
    lastWorkAgentId: typeof value.lastWorkAgentId === 'string' ? value.lastWorkAgentId : null,
    ...(typeof value.creationOperationRef === 'string'
      ? { creationOperationRef: value.creationOperationRef }
      : {}),
    ...(typeof value.creationRequestSha256 === 'string'
      ? { creationRequestSha256: value.creationRequestSha256 }
      : {}),
  };
}

export function parseProjectSummary(value: unknown): ProjectSummary {
  if (!isRecord(value)
    || !nonEmptyText(value.id, 256)
    || !nonEmptyText(value.title, 1_024)
    || !nonEmptyText(value.rootPath, 32_768)
    || !text(value.rootPathLabel, 32_768)
    || !['ready', 'working', 'blocked', 'offline', 'unknown'].includes(String(value.status))
    || !text(value.connectionLabel, 1_024)
    || !nullableText(value.lastOpenedAt, 256)) throw new Error('Project summary is invalid.');
  return {
    ...(value as unknown as ProjectSummary),
    lastWorkAgentId: typeof value.lastWorkAgentId === 'string' ? value.lastWorkAgentId : null,
    creationOperationRef: typeof value.creationOperationRef === 'string' ? value.creationOperationRef : null,
    creationRequestSha256: typeof value.creationRequestSha256 === 'string' ? value.creationRequestSha256 : null,
  };
}

export function parseAttention(value: unknown): AttentionItem {
  if (!isRecord(value) || !nonEmptyText(value.id, 256) || !text(value.createdAt, 256)
    || !['user_question', 'user_task', 'user_action'].includes(String(value.sourceKind))
    || !nonEmptyText(value.title, 1_024) || !text(value.summary)
    || (value.runtimeApproval !== null && value.runtimeApproval !== undefined)) {
    throw new Error('Attention item is invalid.');
  }
  const common = {
    id: value.id,
    type: ['question', 'approval', 'report_review', 'repair', 'error', 'direction'].includes(String(value.type))
      ? value.type as AttentionItem['type'] : 'error',
    actionKind: ['answer', 'approve', 'review', 'do'].includes(String(value.actionKind))
      ? value.actionKind as AttentionItem['actionKind'] : 'review',
    priority: ['low', 'medium', 'high', 'blocker'].includes(String(value.priority))
      ? value.priority as AttentionItem['priority'] : 'medium',
    sourceAgentId: typeof value.sourceAgentId === 'string' ? value.sourceAgentId : null,
    taskId: typeof value.taskId === 'string' ? value.taskId : null,
    blocking: value.blocking === true,
    createdAt: value.createdAt,
    resolvedAt: typeof value.resolvedAt === 'string' ? value.resolvedAt : null,
    resolutionDecision: typeof value.resolutionDecision === 'string' ? value.resolutionDecision : null,
  };
  return {
    ...common,
    sourceKind: value.sourceKind as 'user_question' | 'user_task' | 'user_action',
    title: value.title as string,
    summary: value.summary as string,
    runtimeApproval: null,
  };
}

export function utf8ByteLength(value: string): number {
  return UTF8_ENCODER.encode(value).byteLength;
}

export function fitsMessageTextPolicy(value: string): boolean {
  return utf8ByteLength(value) <= NATIVE_CONTENT_POLICY.message.maxUtf8Bytes;
}

const VOICE_ASSET_PHASES = new Set<VoiceAssetPhase>([
  'absent', 'paused', 'downloading', 'verifying', 'installing',
  'deleting', 'installed', 'failed', 'recovery_required',
]);
const VOICE_ASSET_KINDS = new Set<VoiceAssetStatus['kind']>([
  'native_binary_bundle', 'model',
]);

const FOUNDATION_RECEIPT_MESSAGE = /^<orquesta_foundation_receipt(?:\s[^<>]*)?\s*\/>$/u;

function isFoundationReceiptText(value: string): boolean {
  return FOUNDATION_RECEIPT_MESSAGE.test(value.trim());
}

function isVisibleConversationMessage(message: ConversationMessage): boolean {
  return message.role !== 'agent' || !isFoundationReceiptText(message.text);
}
const VOICE_OPERATION_PHASES = new Set<VoiceOperationPhase>([
  'staging', 'transcribing', 'transcribed', 'cancelled', 'failed', 'recovery_required',
]);

const LOWER_SHA256_PATTERN = /^[0-9a-f]{64}$/u;

function parseVoiceComposerBinding(value: unknown): VoiceComposerBinding {
  if (!isRecord(value) || typeof value.state !== 'string') {
    throw new Error('Native voice Composer binding is invalid.');
  }
  if (value.state === 'legacy_unbound') {
    if (Object.keys(value).sort().join(',') !== 'state') {
      throw new Error('Native legacy voice Composer binding is invalid.');
    }
    return { state: 'legacy_unbound' };
  }
  if (value.state === 'launcher') {
    if (Object.keys(value).sort().join(',') !== 'draftSha256,state'
      || typeof value.draftSha256 !== 'string'
      || !LOWER_SHA256_PATTERN.test(value.draftSha256)) {
      throw new Error('Native launcher voice Composer binding is invalid.');
    }
    return { state: 'launcher', draftSha256: value.draftSha256 };
  }
  if (value.state === 'agent') {
    if (Object.keys(value).sort().join(',') !== 'agentId,draftSha256,projectId,state'
      || !nonEmptyText(value.projectId, 128)
      || !nonEmptyText(value.agentId, 128)
      || typeof value.draftSha256 !== 'string'
      || !LOWER_SHA256_PATTERN.test(value.draftSha256)) {
      throw new Error('Native agent voice Composer binding is invalid.');
    }
    return {
      state: 'agent',
      projectId: value.projectId,
      agentId: value.agentId,
      draftSha256: value.draftSha256,
    };
  }
  throw new Error('Native voice Composer binding state is unsupported.');
}

export function parseVoiceOperationStatus(value: unknown): VoiceOperationStatus {
  if (!isRecord(value)
    || Object.keys(value).sort().join(',') !== 'composerBinding,durationMs,lastErrorCode,operationRef,phase,transcript'
    || !nonEmptyText(value.operationRef, 128)
    || !VOICE_OPERATION_PHASES.has(value.phase as VoiceOperationPhase)
    || !nonNegativeInteger(value.durationMs)
    || Number(value.durationMs) > 120_000
    || (value.transcript !== null && (
      typeof value.transcript !== 'string'
      || utf8ByteLength(value.transcript) > NATIVE_CONTENT_POLICY.voice.transcriptMaxUtf8Bytes
    ))
    || !nullableNonEmptyText(value.lastErrorCode, 256)) {
    throw new Error('Native voice operation status is invalid.');
  }
  const phase = value.phase as VoiceOperationPhase;
  const hasTranscript = typeof value.transcript === 'string' && value.transcript.length > 0;
  if ((phase === 'transcribed' && !hasTranscript)
    || (hasTranscript && phase !== 'transcribed' && phase !== 'recovery_required')) {
    throw new Error('Native voice transcript state is invalid.');
  }
  return {
    operationRef: value.operationRef,
    composerBinding: parseVoiceComposerBinding(value.composerBinding),
    phase,
    durationMs: Number(value.durationMs),
    transcript: value.transcript,
    lastErrorCode: value.lastErrorCode,
  };
}

function parseVoiceAssetStatus(value: unknown): VoiceAssetStatus {
  if (!isRecord(value)
    || Object.keys(value).sort().join(',') !== 'assetId,downloadedBytes,expectedBytes,kind,lastErrorCode,operationRef,phase'
    || !nonEmptyText(value.assetId, 256)
    || !VOICE_ASSET_KINDS.has(value.kind as VoiceAssetStatus['kind'])
    || !VOICE_ASSET_PHASES.has(value.phase as VoiceAssetPhase)
    || !nonNegativeInteger(value.downloadedBytes)
    || !nonNegativeInteger(value.expectedBytes)
    || Number(value.downloadedBytes) > Number(value.expectedBytes)
    || !nullableNonEmptyText(value.operationRef, 128)
    || !nullableNonEmptyText(value.lastErrorCode, 256)) {
    throw new Error('Native voice asset status is invalid.');
  }
  return {
    assetId: value.assetId,
    kind: value.kind as VoiceAssetStatus['kind'],
    phase: value.phase as VoiceAssetPhase,
    downloadedBytes: Number(value.downloadedBytes),
    expectedBytes: Number(value.expectedBytes),
    operationRef: value.operationRef,
    lastErrorCode: value.lastErrorCode,
  };
}

export function parseVoiceStatus(value: unknown): VoiceStatus {
  if (!isRecord(value)
    || Object.keys(value).sort().join(',') !== 'assets,binaryAssetId,comparisonModelAssetId,initialModelAssetId,operations,providerId,requiredAssetsReady,revision,schemaVersion'
    || value.schemaVersion !== 2
    || !nonNegativeInteger(value.revision)
    || !nonEmptyText(value.providerId, 256)
    || !nonEmptyText(value.binaryAssetId, 256)
    || !nonEmptyText(value.initialModelAssetId, 256)
    || !nonEmptyText(value.comparisonModelAssetId, 256)
    || typeof value.requiredAssetsReady !== 'boolean'
    || !Array.isArray(value.assets) || value.assets.length > 16
    || !Array.isArray(value.operations) || value.operations.length > 32) {
    throw new Error('Native voice status is invalid.');
  }
  const assets = value.assets.map(parseVoiceAssetStatus);
  const operations = value.operations.map(parseVoiceOperationStatus);
  if (new Set(assets.map((asset) => asset.assetId)).size !== assets.length
    || new Set(operations.map((operation) => operation.operationRef)).size !== operations.length) {
    throw new Error('Native voice status contains duplicate identities.');
  }
  const roleAssetIds = [value.binaryAssetId, value.initialModelAssetId, value.comparisonModelAssetId] as string[];
  if (new Set(roleAssetIds).size !== roleAssetIds.length || assets.length !== roleAssetIds.length) {
    throw new Error('Native voice status contains invalid asset roles.');
  }
  const assetsById = new Map(assets.map((asset) => [asset.assetId, asset]));
  const binaryAsset = assetsById.get(value.binaryAssetId as string);
  const initialModelAsset = assetsById.get(value.initialModelAssetId as string);
  const comparisonModelAsset = assetsById.get(value.comparisonModelAssetId as string);
  if (binaryAsset?.kind !== 'native_binary_bundle'
    || initialModelAsset?.kind !== 'model'
    || comparisonModelAsset?.kind !== 'model') {
    throw new Error('Native voice status asset roles do not match the catalog.');
  }
  const requiredAssetsReady = binaryAsset.phase === 'installed' && initialModelAsset.phase === 'installed';
  if (value.requiredAssetsReady !== requiredAssetsReady) {
    throw new Error('Native voice status readiness does not match required assets.');
  }
  return {
    schemaVersion: 2,
    revision: Number(value.revision),
    providerId: value.providerId,
    binaryAssetId: value.binaryAssetId,
    initialModelAssetId: value.initialModelAssetId,
    comparisonModelAssetId: value.comparisonModelAssetId,
    requiredAssetsReady: value.requiredAssetsReady,
    assets,
    operations,
  };
}

export function parseAttentionItems(value: unknown): AttentionItem[] {
  if (!Array.isArray(value)) throw new Error('Attention history is invalid.');
  return value.slice(0, 4_096).map(parseAttention);
}

export function parseWorkspaceSnapshot(value: unknown): WorkspaceSnapshot {
  if (!isRecord(value) || !isRecord(value.project)
    || !Array.isArray(value.participants) || !Array.isArray(value.agents) || !Array.isArray(value.tasks)
    || !Array.isArray(value.attention) || !Array.isArray(value.phases)) {
    throw new Error('Workspace snapshot is invalid.');
  }
  const baseProject = parseProjectSummary({
    ...value.project,
    rootPath: value.project.rootPath ?? value.project.rootPathLabel,
    rootPathLabel: value.project.rootPathLabel ?? value.project.rootPath,
    connectionLabel: value.project.connectionLabel ?? '',
    lastOpenedAt: value.project.lastOpenedAt ?? null,
  });
  const agents = value.agents.slice(0, 1_024).map((agent) => {
    if (!isRecord(agent) || !nonEmptyText(agent.id, 256) || !nonEmptyText(agent.displayName, 1_024)) {
      throw new Error('Workspace agent is invalid.');
    }
    return {
      id: agent.id,
      displayName: agent.displayName,
      role: typeof agent.role === 'string' ? agent.role : '',
      roleSummary: typeof agent.roleSummary === 'string' ? agent.roleSummary : '',
      status: ['working', 'assigned_waiting', 'standby', 'approval_wait', 'blocked', 'stale', 'report_ready', 'unknown'].includes(String(agent.status))
        ? agent.status : 'unknown',
      currentTaskId: typeof agent.currentTaskId === 'string' ? agent.currentTaskId : null,
      currentTaskTitle: typeof agent.currentTaskTitle === 'string' ? agent.currentTaskTitle : null,
      parentAgentId: typeof agent.parentAgentId === 'string' ? agent.parentAgentId
        : typeof agent.organizationParentAgentId === 'string' ? agent.organizationParentAgentId : null,
      teamId: typeof agent.teamId === 'string' ? agent.teamId : null,
      lineId: typeof agent.lineId === 'string' ? agent.lineId : null,
      progressPercent: typeof agent.progressPercent === 'number' ? agent.progressPercent : null,
      lastEvidenceAt: typeof agent.lastEvidenceAt === 'string' ? agent.lastEvidenceAt : null,
      recentEvidence: Array.isArray(agent.recentEvidence) ? agent.recentEvidence.filter(isRecord).slice(0, 256).map((evidence, index) => ({
        id: typeof evidence.id === 'string' ? evidence.id : `evidence-${index}`,
        type: typeof evidence.type === 'string' ? evidence.type : 'runtime',
        title: typeof evidence.title === 'string' ? evidence.title : '',
        detail: typeof evidence.detail === 'string' ? evidence.detail : '',
        level: ['reported', 'proven', 'inferred', 'unknown'].includes(String(evidence.level))
          ? evidence.level as WorkspaceSnapshot['agents'][number]['recentEvidence'][number]['level'] : 'unknown',
        observedAt: typeof evidence.observedAt === 'string' ? evidence.observedAt : null,
      })) : [],
      history: Array.isArray(agent.history) ? agent.history.filter(isRecord).slice(0, 512).map((entry, index) => ({
        id: typeof entry.id === 'string' ? entry.id : `history-${index}`,
        title: typeof entry.title === 'string' ? entry.title : '',
        state: typeof entry.state === 'string' ? entry.state : 'unknown',
        changedAt: typeof entry.changedAt === 'string' ? entry.changedAt : '',
      })) : [],
    } as WorkspaceSnapshot['agents'][number];
  });
  const participants = value.participants
    .filter(isRecord).slice(0, 256).flatMap((participant) => {
        if (!nonEmptyText(participant.id, 256) || !nonEmptyText(participant.displayName, 1_024)) return [];
        return [{
          id: participant.id,
          displayName: participant.displayName,
          roleLabel: typeof participant.roleLabel === 'string' ? participant.roleLabel : 'PROJECT MEMBER',
          isCurrentUser: participant.isCurrentUser === true,
          orchestratorAgentId: typeof participant.orchestratorAgentId === 'string' ? participant.orchestratorAgentId : null,
        }];
      });
  const currentUsers = participants.filter((participant) => participant.isCurrentUser);
  const currentUserOrchestratorId = currentUsers[0]?.orchestratorAgentId ?? null;
  if (agents.length > 0 && (currentUsers.length !== 1 || !currentUserOrchestratorId
    || !agents.some((agent) => agent.id === currentUserOrchestratorId))) {
    throw new Error('Workspace current-user authority is invalid.');
  }
  const tasks = value.tasks.slice(0, 4_096).map((task) => {
    if (!isRecord(task) || !nonEmptyText(task.id, 256) || !nonEmptyText(task.title, 1_024)) {
      throw new Error('Workspace task is invalid.');
    }
    return {
      id: task.id,
      title: task.title,
      state: ['queued', 'assigned', 'dispatch_accepted', 'turn_started', 'in_progress', 'blocked', 'approval_wait', 'report_ready', 'needs_review', 'accepted', 'failed', 'unknown'].includes(String(task.state))
        ? task.state : 'unknown',
      ownerAgentId: typeof task.ownerAgentId === 'string' ? task.ownerAgentId : null,
      assignedByAgentId: typeof task.assignedByAgentId === 'string' ? task.assignedByAgentId : null,
      recommendedModel: typeof task.recommendedModel === 'string' ? task.recommendedModel : null,
      requestedModel: typeof task.requestedModel === 'string' ? task.requestedModel : null,
      actualModel: typeof task.actualModel === 'string' ? task.actualModel : null,
      progressSummary: typeof task.progressSummary === 'string' ? task.progressSummary : null,
      progressPercent: typeof task.progressPercent === 'number' ? task.progressPercent : null,
      updatedAt: typeof task.updatedAt === 'string' ? task.updatedAt : null,
    } as WorkspaceSnapshot['tasks'][number];
  });
  const phases = value.phases.slice(0, 256).map((phase) => {
    if (!isRecord(phase) || !nonEmptyText(phase.id, 256) || !nonEmptyText(phase.title, 1_024)) {
      throw new Error('Workspace phase is invalid.');
    }
    return {
      id: phase.id,
      title: phase.title,
      summary: typeof phase.summary === 'string' ? phase.summary : '',
      status: ['queued', 'current', 'blocked', 'done', 'unknown'].includes(String(phase.status)) ? phase.status : 'unknown',
      itemCount: nonNegativeInteger(phase.itemCount) ? phase.itemCount : 0,
      completedItemCount: nonNegativeInteger(phase.completedItemCount) ? phase.completedItemCount : 0,
    } as WorkspaceSnapshot['phases'][number];
  });
  const inspections: InspectionRun[] = Array.isArray(value.inspectionRuns)
    ? value.inspectionRuns.filter(isRecord).slice(0, 256).map((run) => ({
        runId: String(run.runId ?? ''),
        kind: run.kind === 'external_benchmark' ? 'external_benchmark' : 'adversarial_audit',
        displayName: String(run.displayName ?? 'Inspection'),
        status: ['queued', 'running', 'cancelling', 'report_ready', 'partial', 'failed', 'cancelled', 'closed'].includes(String(run.status))
          ? run.status as InspectionRun['status'] : 'failed',
        focus: typeof run.focus === 'string' ? run.focus : null,
        sourceCount: nonNegativeInteger(run.sourceCount) ? run.sourceCount : 0,
        createdAt: String(run.createdAt ?? ''),
        completedAt: typeof run.completedAt === 'string' ? run.completedAt : null,
        errorMessage: typeof run.errorMessage === 'string' ? run.errorMessage : null,
      })) : [];
  return {
    project: {
      ...baseProject,
      summary: typeof value.project.summary === 'string' ? value.project.summary : '',
      nextMilestone: typeof value.project.nextMilestone === 'string' ? value.project.nextMilestone : null,
      currentPhaseId: typeof value.project.currentPhaseId === 'string' ? value.project.currentPhaseId : null,
      agentCount: nonNegativeInteger(value.project.agentCount) ? value.project.agentCount : agents.length,
      provenWorkingAgentCount: nonNegativeInteger(value.project.provenWorkingAgentCount)
        ? value.project.provenWorkingAgentCount : agents.filter((agent) => agent.status === 'working').length,
      lastSyncedAt: typeof value.project.lastSyncedAt === 'string' ? value.project.lastSyncedAt : null,
    },
    participants,
    agents,
    tasks,
    attention: value.attention.slice(0, 1_024).map(parseAttention),
    phases,
    recentEvents: Array.isArray(value.recentEvents) ? value.recentEvents.filter(isRecord).slice(0, 2_048).map((event, index) => ({
      id: typeof event.id === 'string' ? event.id : `event-${index}`,
      tone: ['neutral', 'success', 'warning', 'danger'].includes(String(event.tone))
        ? event.tone as WorkspaceSnapshot['recentEvents'][number]['tone'] : 'neutral',
      title: typeof event.title === 'string' ? event.title : '',
      message: typeof event.message === 'string' ? event.message : '',
      taskId: typeof event.taskId === 'string' ? event.taskId : null,
      createdAt: typeof event.createdAt === 'string' ? event.createdAt : '',
    })) : [],
    inspectionRuns: inspections,
  };
}

function parseCountMap(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([key, count]) => key.length <= 128 && nonNegativeInteger(count))
    .slice(0, 128)
    .map(([key, count]) => [key, Number(count)]));
}

function parseBusinessWorkOrder(value: unknown): BusinessWorkOrderSummary {
  if (!isRecord(value)
    || !nonEmptyText(value.key, 256)
    || !nonEmptyText(value.workOrderId, 256)
    || value.key !== value.workOrderId
    || !nonEmptyText(value.title, 1_024)
    || !nonEmptyText(value.status, 128)
    || !nonNegativeInteger(value.revision)
    || !nonNegativeInteger(value.engineContractVersion)
    || !text(value.createdAt, 128)
    || !text(value.deadlineAt, 128)
    || !isRecord(value.branchCounts)
    || !nonNegativeInteger(value.branchCounts.total)
    || !isRecord(value.lifecycle)
    || !isRecord(value.providerDelivery)
    || !isRecord(value.acceptance)) {
    throw new Error('Business Work Order summary is invalid.');
  }
  const numberField = (record: Record<string, unknown>, key: string): number => (
    nonNegativeInteger(record[key]) ? Number(record[key]) : 0
  );
  return {
    key: value.key,
    workOrderId: value.workOrderId,
    projectRef: typeof value.projectRef === 'string' ? value.projectRef : null,
    title: value.title,
    status: value.status,
    revision: Number(value.revision),
    engineContractVersion: Number(value.engineContractVersion),
    createdAt: value.createdAt,
    deadlineAt: value.deadlineAt,
    branchCounts: {
      total: Number(value.branchCounts.total),
      byState: parseCountMap(value.branchCounts.byState),
    },
    lifecycle: {
      mode: typeof value.lifecycle.mode === 'string' ? value.lifecycle.mode : 'unknown',
      automationState: typeof value.lifecycle.automationState === 'string'
        ? value.lifecycle.automationState : 'unknown',
      blockingEffectCount: numberField(value.lifecycle, 'blockingEffectCount'),
      violationCount: numberField(value.lifecycle, 'violationCount'),
    },
    providerDelivery: {
      total: numberField(value.providerDelivery, 'total'),
      accepted: numberField(value.providerDelivery, 'accepted'),
      notSent: numberField(value.providerDelivery, 'notSent'),
      deliveryUnknown: numberField(value.providerDelivery, 'deliveryUnknown'),
      unresolved: numberField(value.providerDelivery, 'unresolved'),
    },
    acceptance: {
      decision: typeof value.acceptance.decision === 'string' ? value.acceptance.decision : null,
      reviewCount: numberField(value.acceptance, 'reviewCount'),
    },
  };
}

export function parseBusinessWorkOrdersResult(value: unknown): BusinessWorkOrdersResult {
  const capability = isRecord(value) && isRecord(value.capability) ? value.capability : null;
  const capabilityFeatures = capability && Array.isArray(capability.features)
    ? capability.features
    : null;
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength >= 1_048_576
    || !isRecord(value)
    || value.schemaVersion !== 1
    || !nonEmptyText(value.runtimeProjectId, 256)
    || !['initial', 'unchanged', 'advanced'].includes(String(value.continuity))
    || !isRecord(value.cursor)
    || !nonNegativeInteger(value.cursor.journalSequence)
    || !(value.cursor.lastBatchId === null || nonEmptyText(value.cursor.lastBatchId, 256))
    || typeof value.cursor.journalHash !== 'string' || !/^[a-f0-9]{64}$/u.test(value.cursor.journalHash)
    || typeof value.cursor.projectionHash !== 'string' || !/^[a-f0-9]{64}$/u.test(value.cursor.projectionHash)
    || !capability
    || capability.name !== 'orquesta.business-work-orders.read'
    || capability.major !== 1
    || !capabilityFeatures
    || !BUSINESS_WORK_ORDER_REQUIRED_FEATURES.every((feature) => capabilityFeatures.includes(feature))
    || !isRecord(value.page) || value.page.kind !== 'index'
    || !Array.isArray(value.page.items) || value.page.items.length > 25
    || !(value.page.nextAfterKey === null || nonEmptyText(value.page.nextAfterKey, 256))
    || !isRecord(value.businessProjectScope) || !Array.isArray(value.businessProjectScope.projectRefs)
    || value.businessProjectScope.projectRefs.length > 256
    || !value.businessProjectScope.projectRefs.every((item) => nonEmptyText(item, 512))
    || !isRecord(value.providerSettlement)
    || typeof value.providerSettlement.active !== 'boolean') {
    throw new Error('Business Work Orders response is invalid.');
  }
  return {
    runtimeProjectId: value.runtimeProjectId,
    continuity: value.continuity as BusinessWorkOrdersResult['continuity'],
    cursor: {
      journalSequence: Number(value.cursor.journalSequence),
      lastBatchId: value.cursor.lastBatchId,
      journalHash: value.cursor.journalHash,
      projectionHash: value.cursor.projectionHash,
    },
    items: value.page.items.map(parseBusinessWorkOrder),
    nextAfterKey: value.page.nextAfterKey,
    businessProjectRefs: [...value.businessProjectScope.projectRefs],
    providerSettlementActive: value.providerSettlement.active,
  };
}

function parseWorkflowCheck(value: unknown): WorkflowCheck {
  if (!isRecord(value) || !['contains', 'not_contains'].includes(String(value.kind))
    || !nonEmptyText(value.text, 1_024) || typeof value.caseSensitive !== 'boolean') {
    throw new Error('Workflow check is invalid.');
  }
  return { kind: value.kind as WorkflowCheck['kind'], text: value.text, caseSensitive: value.caseSensitive };
}

function parseWorkflowDefinition(value: unknown): WorkflowDefinition {
  if (!isRecord(value) || !nonEmptyText(value.workflowId, 128) || !nonEmptyText(value.name, 256)
    || !nonEmptyText(value.prompt, 65_536) || !Array.isArray(value.checks) || value.checks.length > 16
    || !nonEmptyText(value.createdAt, 128) || !nonEmptyText(value.updatedAt, 128)) {
    throw new Error('Workflow definition is invalid.');
  }
  return {
    workflowId: value.workflowId,
    name: value.name,
    prompt: value.prompt,
    checks: value.checks.map(parseWorkflowCheck),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function nullableNumber(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('Workflow metric is invalid.');
  return value;
}

function parseWorkflowAttempt(value: unknown): WorkflowAttempt {
  if (!isRecord(value) || !nonEmptyText(value.attemptId, 128) || !nonNegativeInteger(value.ordinal)
    || !['queued', 'starting', 'running', 'completed', 'failed', 'cancelled'].includes(String(value.status))) {
    throw new Error('Workflow attempt is invalid.');
  }
  return {
    attemptId: value.attemptId,
    ordinal: value.ordinal,
    status: value.status as WorkflowAttempt['status'],
    resultPreview: typeof value.resultPreview === 'string' ? value.resultPreview.slice(0, 1_024) : null,
    checkOutcome: ['passed', 'failed', 'unassessed'].includes(String(value.checkOutcome))
      ? value.checkOutcome as WorkflowAttempt['checkOutcome'] : null,
    errorMessage: typeof value.errorMessage === 'string' ? value.errorMessage.slice(0, 4_096) : null,
    completedAt: typeof value.completedAt === 'string' ? value.completedAt : null,
    durationMs: nullableNumber(value.durationMs),
  };
}

function parseWorkflowMetrics(value: unknown): WorkflowBatchMetrics {
  if (!isRecord(value)) throw new Error('Workflow metrics are invalid.');
  const integerKeys = ['requestedRuns', 'terminalRuns', 'completedRuns', 'failedRuns', 'cancelledRuns', 'assessedRuns', 'passedRuns'] as const;
  if (!integerKeys.every((key) => nonNegativeInteger(value[key]))) throw new Error('Workflow metric counts are invalid.');
  const percent = (candidate: unknown): number => {
    if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate < 0 || candidate > 100) {
      throw new Error('Workflow percentage is invalid.');
    }
    return candidate;
  };
  return {
    requestedRuns: value.requestedRuns as number,
    terminalRuns: value.terminalRuns as number,
    completedRuns: value.completedRuns as number,
    failedRuns: value.failedRuns as number,
    cancelledRuns: value.cancelledRuns as number,
    assessedRuns: value.assessedRuns as number,
    passedRuns: value.passedRuns as number,
    executionReliabilityPercent: percent(value.executionReliabilityPercent),
    successRatePercent: value.successRatePercent === null ? null : percent(value.successRatePercent),
    outcomeConsistencyPercent: value.outcomeConsistencyPercent === null ? null : percent(value.outcomeConsistencyPercent),
    medianDurationMs: nullableNumber(value.medianDurationMs),
  };
}

function parseWorkflowBatch(value: unknown): WorkflowBatch {
  if (!isRecord(value) || !nonEmptyText(value.batchId, 128) || !nonEmptyText(value.workflowId, 128)
    || !nonNegativeInteger(value.requestedRuns)
    || !['queued', 'running', 'cancelling', 'completed', 'partial', 'failed', 'cancelled'].includes(String(value.status))
    || !Array.isArray(value.attempts) || value.attempts.length > 50 || !nonEmptyText(value.createdAt, 128)) {
    throw new Error('Workflow batch is invalid.');
  }
  return {
    batchId: value.batchId,
    workflowId: value.workflowId,
    requestedRuns: value.requestedRuns,
    status: value.status as WorkflowBatch['status'],
    attempts: value.attempts.map(parseWorkflowAttempt),
    createdAt: value.createdAt,
    completedAt: typeof value.completedAt === 'string' ? value.completedAt : null,
    metrics: parseWorkflowMetrics(value.metrics),
  };
}

export function parseWorkflowCatalog(value: unknown): WorkflowCatalog {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.definitions) || value.definitions.length > 100
    || !Array.isArray(value.batches) || value.batches.length > 50 || !isRecord(value.limits)
    || !nonNegativeInteger(value.limits.maxAttemptsPerBatch)) throw new Error('Workflow catalog is invalid.');
  return {
    definitions: value.definitions.map(parseWorkflowDefinition),
    batches: value.batches.map(parseWorkflowBatch),
    maxAttemptsPerBatch: value.limits.maxAttemptsPerBatch,
  };
}

export function parseDispatchRecovery(value: unknown): DispatchRecovery | null {
  if (value === null || value === undefined) return null;
  const phase = isRecord(value) ? String(value.phase) : '';
  const receiptIsComplete = isRecord(value) && isRecord(value.receipt)
    && nonEmptyText(value.receipt.threadId, 128)
    && nonEmptyText(value.receipt.turnId, 128);
  const receiptIsAbsent = isRecord(value) && value.receipt === null;
  const receiptMatchesPhase = phase === 'prepared'
    ? receiptIsAbsent
    : phase === 'accepted'
      ? receiptIsComplete
      : receiptIsAbsent || receiptIsComplete;
  if (!isRecord(value)
    || !['prepared', 'outcome_unknown', 'accepted', 'cleanup_pending', 'definitive_failure_cleanup_pending'].includes(String(value.phase))
    || !nonEmptyText(value.messageId, 256)
    || !nonEmptyText(value.projectId, 256)
    || !nonEmptyText(value.runtimeProjectId, 256)
    || !nonEmptyText(value.targetAgentId, 256)
    || !nonEmptyText(value.actionFingerprint, 128)
    || !nonNegativeInteger(value.attachmentCount)
    || !nonNegativeInteger(value.selectedContextCount)
    || !epochMilliseconds(value.createdAtMs)
    || !epochMilliseconds(value.updatedAtMs)
    || !receiptMatchesPhase) throw new Error('Dispatch recovery record is invalid.');
  return {
    kind: phase === 'accepted' ? 'accepted'
      : phase === 'cleanup_pending' || phase === 'definitive_failure_cleanup_pending' ? 'cleanup_pending'
        : 'prepared_outcome_unknown',
    dispatchId: value.messageId,
    projectId: value.projectId,
    targetAgentId: value.targetAgentId,
    createdAt: isoFromMilliseconds(Number(value.createdAtMs)),
    reason: phase === 'outcome_unknown' ? 'Native dispatch outcome is not yet known.' : null,
    threadId: isRecord(value.receipt) && typeof value.receipt.threadId === 'string' ? value.receipt.threadId : null,
    turnId: isRecord(value.receipt) && typeof value.receipt.turnId === 'string' ? value.receipt.turnId : null,
  };
}

export function parseBootstrap(value: unknown, renderer: RendererAuthority): Omit<DesktopBootstrap, 'voiceStatus'> {
  if (!isRecord(value)
    || value.rendererSessionId !== renderer.rendererSessionId
    || value.rendererGeneration !== renderer.rendererGeneration
    || !isRecord(value.settings)
    || !Array.isArray(value.projects)
    || !Array.isArray(value.starterCreationRecoveries)
    || !nullableNonEmptyText(value.selectedProjectId, 256)
    || !Array.isArray(value.pendingAttachmentSelections)
    || typeof value.runtimeTransitionInProgress !== 'boolean') throw new Error('Native bootstrap payload is invalid.');
  const status = parseRuntimeStatus(value.runtime);
  if (status.rendererSessionId && (status.rendererSessionId !== renderer.rendererSessionId
    || status.rendererGeneration !== renderer.rendererGeneration)) {
    throw new Error('Native bootstrap status belongs to a different renderer authority.');
  }
  const projects = value.projects.slice(0, 1_024).map(parseNativeProjectSummary);
  const starterRecoveryReasons = new Set([
    'derived_child_path_mismatch',
    'planned_final_path_exists_without_owned_identity',
    'new_root_identity_or_contents_unproven',
    'owned_root_unavailable',
    'owned_root_identity_mismatch',
    'owned_root_identity_or_contents_unproven',
    'owned_root_canonical_path_mismatch',
    'registered_identity_mismatch',
    'precommit_root_identity_or_contents_unproven',
    'restart_parent_unavailable',
    'restart_derived_path_mismatch',
    'restart_planned_final_exists_without_owned_identity',
  ]);
  const starterCreationRecoveries = value.starterCreationRecoveries.slice(0, 128).map((recovery) => {
        if (!isRecord(recovery)
          || !nonEmptyText(recovery.operationRef, 128)
          || !nonEmptyText(recovery.displayName, 1_024)
          || !nonEmptyText(recovery.finalChildPath, 32_768)
          || !nonEmptyText(recovery.reason, 128)
          || !starterRecoveryReasons.has(recovery.reason)) {
          throw new Error('Native Starter recovery summary is invalid.');
        }
        return {
          operationRef: recovery.operationRef,
          displayName: recovery.displayName,
          finalChildPath: recovery.finalChildPath,
          reason: recovery.reason,
        };
      });
  if (value.selectedProjectId && !projects.some((project) => project.id === value.selectedProjectId)) {
    throw new Error('Native selected project is not present in the registry payload.');
  }
  if (value.runtimeAuthority === null) {
    if (status.projectId || status.activationToken || status.rendererSessionId || status.rendererGeneration !== null) {
      throw new Error('Native bootstrap authority disagrees with runtime status.');
    }
  } else {
    if (!isRecord(value.runtimeAuthority)
      || !nonEmptyText(value.runtimeAuthority.projectId, 256)
      || !nonEmptyText(value.runtimeAuthority.activationToken, 256)
      || !nonEmptyText(value.runtimeAuthority.rendererSessionId, 128)
      || !nonNegativeInteger(value.runtimeAuthority.rendererGeneration)
      || !nonEmptyText(value.runtimeAuthority.windowLabel, 256)
      || value.runtimeAuthority.projectId !== status.projectId
      || value.runtimeAuthority.activationToken !== status.activationToken
      || value.runtimeAuthority.rendererSessionId !== status.rendererSessionId
      || value.runtimeAuthority.rendererGeneration !== status.rendererGeneration) {
      throw new Error('Native bootstrap authority disagrees with runtime status.');
    }
  }
  return {
    renderer,
    settings: parseNativeSettings(value.settings),
    status,
    projects,
    starterCreationRecoveries,
    selectedProjectId: value.selectedProjectId,
    snapshot: null,
    dispatchRecovery: parseDispatchRecovery(value.dispatchRecovery ?? null),
    pendingAttachmentSelectionIds: value.pendingAttachmentSelections.slice(0, 1_024).map((selection) => {
      if (!isRecord(selection) || !nonEmptyText(selection.selectionId, 256) || !Array.isArray(selection.attachments)) {
        throw new Error('Native pending attachment selection is invalid.');
      }
      const selectionId = selection.selectionId;
      parseNativeAttachmentDescriptors(selection.attachments, selectionId);
      return selectionId;
    }),
  };
}

export function parseConversationSnapshot(value: unknown): ConversationSnapshot {
  if (!isRecord(value)
    || !nonEmptyText(value.projectId, 256)
    || !nonEmptyText(value.targetAgentId, 256)
    || !nullableNonEmptyText(value.streamId, 1_024)
    || !nonNegativeInteger(value.appliedJournalSequence)
    || !nonNegativeInteger(value.projectionRevision)
    || !['current', 'advanced', 'stream_reset', 'gap'].includes(String(value.syncState))
    || !Array.isArray(value.items)
    || value.items.length > 200
    || !Array.isArray(value.streamingItems)
    || value.streamingItems.length > 200
    || !Array.isArray(value.activities)
    || value.activities.length > 200
    || !Array.isArray(value.activeTurns)
    || value.activeTurns.length > 200
    || !(value.latestTurn === null || isRecord(value.latestTurn))
    || !Array.isArray(value.pendingRequests)
    || value.pendingRequests.length > 200
    || !Array.isArray(value.resolvedRequests)
    || value.resolvedRequests.length > 200
    || !(value.olderCursor === null || (isRecord(value.olderCursor)
      && nonEmptyText(value.olderCursor.beforeCreatedAt, 64)
      && nonEmptyText(value.olderCursor.beforeMessageId, 512)))
    || !(value.activityOlderCursor === null || (isRecord(value.activityOlderCursor)
      && nonEmptyText(value.activityOlderCursor.beforeCreatedAt, 64)
      && nonEmptyText(value.activityOlderCursor.beforeActivityId, 512)))
    || !(value.pendingRequestOlderCursor === null
      || nonEmptyText(value.pendingRequestOlderCursor, 4_096))) {
    throw new Error('Projection conversation snapshot is invalid.');
  }
  const targetAgentId = value.targetAgentId;
  const items: ConversationMessage[] = value.items
    .map((message) => parseProjectionMessage(message, targetAgentId))
    .filter(isVisibleConversationMessage);
  const completedIds = new Set(items.map((message) => message.id));
  const streamingItems: ConversationMessage[] = value.streamingItems.flatMap((message) => {
    if (!isRecord(message)
      || !nonEmptyText(message.messageId, 512)
      || !nonEmptyText(message.threadId, 512)
      || !nonEmptyText(message.turnId, 512)
      || !nonEmptyText(message.itemId, 512)
      || message.targetAgentId !== targetAgentId
      || message.role !== 'agent'
      || typeof message.text !== 'string'
      || !nonEmptyText(message.createdAt, 64)
      || !nonEmptyText(message.updatedAt, 64)
      || !(Number.isSafeInteger(message.lastJournalSequence) && Number(message.lastJournalSequence) > 0)) {
      throw new Error('Projection streaming message is invalid.');
    }
    if (completedIds.has(message.messageId) || !message.text.trim()) return [];
    const parsed = {
      id: message.messageId,
      role: 'agent' as const,
      targetAgentId,
      authorLabel: targetAgentId,
      text: message.text,
      createdAt: message.createdAt,
      evidenceLabel: null,
      status: 'running' as const,
    };
    return isVisibleConversationMessage(parsed) ? [parsed] : [];
  });
  const activities: ConversationActivity[] = value.activities.map((activity) => {
    if (!isRecord(activity)
      || !nonEmptyText(activity.activityId, 512)
      || !nonEmptyText(activity.threadId, 512)
      || !nonEmptyText(activity.turnId, 512)
      || !nullableNonEmptyText(activity.itemId, 512)
      || activity.targetAgentId !== targetAgentId
      || !['tool', 'command', 'file_change', 'diff', 'plan'].includes(String(activity.kind))
      || !['running', 'completed', 'failed', 'declined', 'updated', 'unknown'].includes(String(activity.state))
      || !nonEmptyText(activity.title, 512)
      || !isRecord(activity.details)
      || !nonEmptyText(activity.createdAt, 64)
      || !nonEmptyText(activity.updatedAt, 64)
      || !(Number.isSafeInteger(activity.lastJournalSequence) && Number(activity.lastJournalSequence) > 0)) {
      throw new Error('Projection structured activity is invalid.');
    }
    const common = {
      id: activity.activityId,
      threadId: activity.threadId,
      turnId: activity.turnId,
      itemId: typeof activity.itemId === 'string' ? activity.itemId : null,
      targetAgentId,
      state: activity.state as ConversationActivity['state'],
      title: activity.title,
      createdAt: activity.createdAt,
      updatedAt: activity.updatedAt,
      lastJournalSequence: Number(activity.lastJournalSequence),
    };
    const details = activity.details;
    const nullableInteger = (candidate: unknown): number | null => candidate === null || candidate === undefined
      ? null : Number.isSafeInteger(candidate) ? Number(candidate) : Number.NaN;
    if (activity.kind === 'command') {
      const durationMs = nullableInteger(details.durationMs);
      const exitCode = nullableInteger(details.exitCode);
      if (!nonEmptyText(details.commandName, 256)
        || !Array.isArray(details.actionTypes) || details.actionTypes.length > 16
        || !details.actionTypes.every((entry) => nonEmptyText(entry, 256))
        || typeof details.actionTypesTruncated !== 'boolean'
        || Number.isNaN(exitCode) || Number.isNaN(durationMs)
        || typeof details.outputPresent !== 'boolean' || !nonNegativeInteger(details.outputBytes)
        || !nullableText(details.outputText, 16_384)
        || typeof details.outputTruncated !== 'boolean' || typeof details.outputRedacted !== 'boolean'
        || (details.outputPresent ? typeof details.outputText !== 'string' : details.outputText !== null)
        || (!details.outputPresent && Number(details.outputBytes) !== 0)
        || details.cwdOmitted !== true || details.commandArgumentsOmitted !== true || details.contentOmitted !== true) {
        throw new Error('Projection command activity details are invalid.');
      }
      return { ...common, kind: 'command', details: {
        commandName: details.commandName,
        actionTypes: details.actionTypes as string[],
        actionTypesTruncated: details.actionTypesTruncated,
        exitCode,
        durationMs,
        outputPresent: details.outputPresent,
        outputBytes: Number(details.outputBytes),
        outputText: typeof details.outputText === 'string' ? details.outputText : null,
        outputTruncated: details.outputTruncated,
        outputRedacted: details.outputRedacted,
        cwdOmitted: true,
        commandArgumentsOmitted: true,
        contentOmitted: true,
      } };
    }
    if (activity.kind === 'tool') {
      const durationMs = nullableInteger(details.durationMs);
      if (!['mcpToolCall', 'dynamicToolCall', 'collabAgentToolCall', 'webSearch'].includes(String(details.toolKind))
        || !nonEmptyText(details.toolName, 256) || !nullableNonEmptyText(details.toolNamespace, 256)
        || Number.isNaN(durationMs) || !(details.success === null || typeof details.success === 'boolean')
        || details.argumentsOmitted !== true || details.resultOmitted !== true || details.contentOmitted !== true) {
        throw new Error('Projection tool activity details are invalid.');
      }
      return { ...common, kind: 'tool', details: {
        toolKind: details.toolKind as 'mcpToolCall' | 'dynamicToolCall' | 'collabAgentToolCall' | 'webSearch',
        toolName: details.toolName,
        toolNamespace: typeof details.toolNamespace === 'string' ? details.toolNamespace : null,
        durationMs,
        success: typeof details.success === 'boolean' ? details.success : null,
        argumentsOmitted: true,
        resultOmitted: true,
        contentOmitted: true,
      } };
    }
    if (activity.kind === 'file_change') {
      if (!Array.isArray(details.changes) || details.changes.length > 128
        || !nonNegativeInteger(details.changeCount) || typeof details.changesTruncated !== 'boolean'
        || details.contentOmitted !== true) throw new Error('Projection file activity details are invalid.');
      const changes = details.changes.map((change) => {
        if (!isRecord(change) || !nonEmptyText(change.path, 2_048) || !nonEmptyText(change.kind, 256)
          || !nonNegativeInteger(change.original_bytes) || !nonNegativeInteger(change.added_lines)
          || !nonNegativeInteger(change.removed_lines)) throw new Error('Projection file change detail is invalid.');
        return { path: change.path, kind: change.kind, originalBytes: Number(change.original_bytes),
          addedLines: Number(change.added_lines), removedLines: Number(change.removed_lines) };
      });
      return { ...common, kind: 'file_change', details: { changes, changeCount: Number(details.changeCount),
        changesTruncated: details.changesTruncated, contentOmitted: true } };
    }
    if (activity.kind === 'diff') {
      if (!nonNegativeInteger(details.originalBytes) || !nonNegativeInteger(details.addedLines)
        || !nonNegativeInteger(details.removedLines) || details.contentOmitted !== true) {
        throw new Error('Projection diff activity details are invalid.');
      }
      return { ...common, kind: 'diff', details: { originalBytes: Number(details.originalBytes),
        addedLines: Number(details.addedLines), removedLines: Number(details.removedLines), contentOmitted: true } };
    }
    const stepsValue = Array.isArray(details.steps) ? details.steps : [];
    if (stepsValue.length > 64) throw new Error('Projection plan activity has too many steps.');
    const steps = stepsValue.map((step) => {
      if (!isRecord(step) || !['pending', 'inProgress', 'completed'].includes(String(step.status))
        || !text(step.text, 2_048) || typeof step.truncated !== 'boolean' || typeof step.redacted !== 'boolean') {
        throw new Error('Projection plan step is invalid.');
      }
      return { status: step.status as 'pending' | 'inProgress' | 'completed', text: step.text,
        truncated: step.truncated, redacted: step.redacted };
    });
    if (!(details.text === undefined || nullableText(details.text, 16_384)) || !(details.originalBytes === null || details.originalBytes === undefined || nonNegativeInteger(details.originalBytes))
      || !(details.truncated === undefined || typeof details.truncated === 'boolean')
      || !(details.redacted === undefined || typeof details.redacted === 'boolean')
      || !(details.stepCount === undefined || nonNegativeInteger(details.stepCount))
      || !(details.stepsTruncated === undefined || typeof details.stepsTruncated === 'boolean')
      || !(details.explanation === undefined || nullableText(details.explanation, 4_096))
      || !(details.explanationTruncated === undefined || typeof details.explanationTruncated === 'boolean')
      || !(details.explanationRedacted === undefined || typeof details.explanationRedacted === 'boolean')) {
      throw new Error('Projection plan activity details are invalid.');
    }
    return { ...common, kind: 'plan', details: {
      text: typeof details.text === 'string' ? details.text : null,
      originalBytes: nonNegativeInteger(details.originalBytes) ? Number(details.originalBytes) : null,
      truncated: details.truncated === true,
      redacted: details.redacted === true,
      steps,
      stepCount: nonNegativeInteger(details.stepCount) ? Number(details.stepCount) : steps.length,
      stepsTruncated: details.stepsTruncated === true,
      explanation: typeof details.explanation === 'string' ? details.explanation : null,
      explanationTruncated: details.explanationTruncated === true,
      explanationRedacted: details.explanationRedacted === true,
    } };
  });
  const activeTurns = value.activeTurns.map((turn) => {
    if (!isRecord(turn)
      || !nonEmptyText(turn.threadId, 512)
      || !nonEmptyText(turn.turnId, 512)
      || turn.targetAgentId !== targetAgentId
      || !['accepted', 'in_progress', 'interrupting'].includes(String(turn.state))
      || !(Number.isSafeInteger(turn.lastJournalSequence) && Number(turn.lastJournalSequence) > 0)) {
      throw new Error('Projection active turn is invalid.');
    }
    return {
      threadId: turn.threadId,
      turnId: turn.turnId,
      targetAgentId,
      state: turn.state as 'accepted' | 'in_progress' | 'interrupting',
      lastJournalSequence: Number(turn.lastJournalSequence),
    };
  });
  const latestTurn = value.latestTurn === null ? null : (() => {
    const turn = value.latestTurn;
    if (!isRecord(turn)
      || !nonEmptyText(turn.threadId, 512)
      || !nonEmptyText(turn.turnId, 512)
      || turn.targetAgentId !== targetAgentId
      || !['accepted', 'in_progress', 'interrupting', 'completed', 'failed', 'interrupted', 'cancelled'].includes(String(turn.state))
      || !(Number.isSafeInteger(turn.lastJournalSequence) && Number(turn.lastJournalSequence) > 0)) {
      throw new Error('Projection latest turn is invalid.');
    }
    return {
      threadId: turn.threadId as string,
      turnId: turn.turnId as string,
      targetAgentId,
      state: turn.state as 'accepted' | 'in_progress' | 'interrupting' | 'completed' | 'failed' | 'interrupted' | 'cancelled',
      lastJournalSequence: Number(turn.lastJournalSequence),
    };
  })();
  items.push(...streamingItems);
  items.sort(compareConversationEntryOrder);
  activities.sort(compareConversationActivityOrder);
  const pendingRequests = value.pendingRequests.map((request) => {
    if (!isRecord(request)
      || !nonEmptyText(request.requestKey, 512)
      || !nullableNonEmptyText(request.agentId, 512)
      || !['attention.approval_requested', 'attention.user_input_requested'].includes(String(request.requestKind))
      || !Array.isArray(request.responseOptions)
      || request.responseOptions.length > 32
      || !request.responseOptions.every((option) => nonEmptyText(option, 4_096))
      || !nullableText(request.prompt)
      || !nonEmptyText(request.createdAt, 64)
      || ![null, 'file_change', 'command_execution', 'other'].includes(request.requestedEffectKind as null | string)
      || ![null, 'in_flight', 'outcome_unknown'].includes(request.responsePhase as null | string)
      || !['actionable', 'stale'].includes(String(request.recoveryState))) {
      throw new Error('Projection pending request is invalid.');
    }
    return {
      requestKey: request.requestKey,
      agentId: typeof request.agentId === 'string' ? request.agentId : null,
      requestKind: request.requestKind as 'attention.approval_requested' | 'attention.user_input_requested',
      responseOptions: request.responseOptions as string[],
      // Existing projection databases may contain old provider approval text.
      // Only explicit user-input questions are allowed through this boundary.
      prompt: request.requestKind === 'attention.user_input_requested'
        && typeof request.prompt === 'string' ? request.prompt : null,
      createdAt: request.createdAt,
      requestedEffectKind: request.requestedEffectKind as 'file_change' | 'command_execution' | 'other' | null,
      responsePhase: request.responsePhase as 'in_flight' | 'outcome_unknown' | null,
      recoveryState: request.recoveryState as 'actionable' | 'stale',
    };
  });
  const resolvedRequests = value.resolvedRequests.map((request) => {
    if (!isRecord(request)
      || !nonEmptyText(request.requestKey, 512)
      || !nullableNonEmptyText(request.agentId, 512)
      || !['attention.approval_requested', 'attention.user_input_requested'].includes(String(request.requestKind))
      || !Array.isArray(request.responseOptions)
      || request.responseOptions.length > 32
      || !request.responseOptions.every((option) => nonEmptyText(option, 4_096))
      || !nonEmptyText(request.createdAt, 64)
      || !nonEmptyText(request.resolvedAt, 64)
      || ![null, 'file_change', 'command_execution', 'other'].includes(request.requestedEffectKind as null | string)
      || !nonEmptyText(request.responseDecision, 128)) {
      throw new Error('Projection resolved request is invalid.');
    }
    return {
      requestKey: request.requestKey,
      agentId: typeof request.agentId === 'string' ? request.agentId : null,
      requestKind: request.requestKind as 'attention.approval_requested' | 'attention.user_input_requested',
      responseOptions: request.responseOptions as string[],
      createdAt: request.createdAt,
      resolvedAt: request.resolvedAt,
      requestedEffectKind: request.requestedEffectKind as 'file_change' | 'command_execution' | 'other' | null,
      responseDecision: request.responseDecision,
    };
  });
  return {
    source: 'sqlite',
    projectId: value.projectId,
    targetAgentId,
    streamId: typeof value.streamId === 'string' ? value.streamId : null,
    appliedJournalSequence: Number(value.appliedJournalSequence),
    projectionRevision: Number(value.projectionRevision),
    syncState: value.syncState as ConversationSnapshot['syncState'],
    items,
    activities,
    olderCursor: value.olderCursor === null ? null : {
      beforeCreatedAt: String(value.olderCursor.beforeCreatedAt),
      beforeMessageId: String(value.olderCursor.beforeMessageId),
    },
    activityOlderCursor: value.activityOlderCursor === null ? null : {
      beforeCreatedAt: String(value.activityOlderCursor.beforeCreatedAt),
      beforeActivityId: String(value.activityOlderCursor.beforeActivityId),
    },
    pendingRequestOlderCursor: typeof value.pendingRequestOlderCursor === 'string'
      ? value.pendingRequestOlderCursor
      : null,
    pendingRequests,
    resolvedRequests,
    activeTurns,
    latestTurn,
  };
}

export function parseNativeSettings(value: unknown): NativeSettings {
  if (!isRecord(value)
    || Object.keys(value).sort().join(',') !== 'locale,notificationsEnabled,reducedMotion,revision,schemaVersion,theme'
    || value.schemaVersion !== 2
    || !nonNegativeInteger(value.revision)
    || ![null, 'ja', 'en'].includes(value.locale as null | string)
    || !['system', 'light', 'dark'].includes(String(value.theme))
    || typeof value.reducedMotion !== 'boolean'
    || typeof value.notificationsEnabled !== 'boolean') {
    throw new Error('Native settings payload is invalid.');
  }
  return {
    schemaVersion: 2,
    revision: Number(value.revision),
    locale: value.locale as 'ja' | 'en' | null,
    theme: value.theme as 'system' | 'light' | 'dark',
    reducedMotion: value.reducedMotion,
    notificationsEnabled: value.notificationsEnabled,
  };
}

function parseProjectionMessage(message: unknown, targetAgentId: string): ConversationMessage {
  if (!isRecord(message)
    || !nonEmptyText(message.messageId, 512)
    || !nonEmptyText(message.threadId, 512)
    || !nullableNonEmptyText(message.turnId, 512)
    || !nullableNonEmptyText(message.targetAgentId, 512)
    || !['user', 'agent'].includes(String(message.role))
    || !text(message.text)
    || !nonEmptyText(message.createdAt, 64)
    || !(message.journalSequence === null || (Number.isSafeInteger(message.journalSequence) && Number(message.journalSequence) > 0))
    || !['journal', 'provider_page'].includes(String(message.origin))) {
    throw new Error('Projection conversation message is invalid.');
  }
  const role = message.role as 'user' | 'agent';
  return {
    id: message.messageId,
    role,
    targetAgentId: typeof message.targetAgentId === 'string' ? message.targetAgentId : targetAgentId,
    authorLabel: role === 'user' ? 'You' : targetAgentId,
    text: message.text,
    createdAt: message.createdAt,
    evidenceLabel: null,
    status: 'complete',
  };
}

export function parseHistoryIndexPage(value: unknown): HistoryIndexPage {
  if (!isRecord(value) || !nonEmptyText(value.projectId, 256)
    || !Array.isArray(value.items) || value.items.length > 101
    || !(value.nextCursor === null || (isRecord(value.nextCursor)
      && nonEmptyText(value.nextCursor.beforeUpdatedAt, 64)
      && nonEmptyText(value.nextCursor.beforeMessageId, 512)))) {
    throw new Error('Projection history index is invalid.');
  }
  return {
    source: 'sqlite',
    projectId: value.projectId,
    items: value.items.map((item) => {
      if (!isRecord(item) || !nonEmptyText(item.targetAgentId, 256)
        || !nonEmptyText(item.updatedAt, 64) || !nonEmptyText(item.lastMessageId, 512)
        || !['user', 'agent', 'system'].includes(String(item.lastRole))
        || !text(item.preview, 1_024)) throw new Error('Projection history summary is invalid.');
      return {
        targetAgentId: item.targetAgentId,
        updatedAt: item.updatedAt,
        lastMessageId: item.lastMessageId,
        lastRole: item.lastRole as 'user' | 'agent' | 'system',
        preview: item.preview,
      };
    }),
    nextCursor: value.nextCursor === null ? null : {
      beforeUpdatedAt: String(value.nextCursor.beforeUpdatedAt),
      beforeMessageId: String(value.nextCursor.beforeMessageId),
    },
  };
}

export function parseHistoryConversationPage(value: unknown): HistoryConversationPage {
  if (!isRecord(value) || !nonEmptyText(value.projectId, 256)
    || !nonEmptyText(value.targetAgentId, 256) || !nullableText(value.query)
    || !Array.isArray(value.items) || value.items.length > 101
    || !(value.nextCursor === null || (isRecord(value.nextCursor)
      && nonEmptyText(value.nextCursor.beforeCreatedAt, 64)
      && nonEmptyText(value.nextCursor.beforeMessageId, 512)))) {
    throw new Error('Projection history page is invalid.');
  }
  const targetAgentId = value.targetAgentId;
  return {
    source: 'sqlite',
    projectId: value.projectId,
    targetAgentId,
    query: typeof value.query === 'string' ? value.query : null,
    items: value.items
      .map((message) => parseProjectionMessage(message, targetAgentId))
      .filter(isVisibleConversationMessage),
    nextCursor: value.nextCursor === null ? null : {
      beforeCreatedAt: String(value.nextCursor.beforeCreatedAt),
      beforeMessageId: String(value.nextCursor.beforeMessageId),
    },
  };
}

export function parseAttachments(value: unknown, selectionId: string): ComposerAttachment[] {
  if (!isRecord(value) || value.selectionId !== selectionId || !Array.isArray(value.attachments)
    || value.attachments.length > ATTACHMENT_POLICY.maxPerDispatch) {
    throw new Error('Attachment selection response is invalid.');
  }
  return parseNativeAttachmentDescriptors(value.attachments, selectionId);
}

function parseNativeAttachmentDescriptors(value: readonly unknown[], selectionId: string): ComposerAttachment[] {
  if (value.length > ATTACHMENT_POLICY.maxPerDispatch) {
    throw new Error('Attachment selection response is invalid.');
  }
  const attachments = value.map((attachment) => parseNativeAttachmentDescriptor(attachment, selectionId));
  const textBytes = attachments
    .filter((attachment) => attachment.kind === 'text')
    .reduce((total, attachment) => total + attachment.sizeBytes, 0);
  if (textBytes > ATTACHMENT_POLICY.maxTextBytesPerDispatch
    || new Set(attachments.map((attachment) => attachment.id)).size !== attachments.length) {
    throw new Error('Attachment selection response is invalid.');
  }
  return attachments;
}

function isAttachmentDisplayName(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '') return false;
  let scalarCount = 0;
  for (const scalar of value) {
    const codePoint = scalar.codePointAt(0)!;
    if (/\p{Cc}/u.test(scalar) || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return false;
    scalarCount += 1;
    if (scalarCount > 255) return false;
  }
  return true;
}

function parseNativeAttachmentDescriptor(value: unknown, selectionId: string): ComposerAttachment {
  const displayName = typeof value === 'object' && value !== null && 'displayName' in value
    ? (value as { displayName?: unknown }).displayName
    : null;
  const extension = typeof displayName === 'string'
    ? displayName.slice(displayName.lastIndexOf('.')).toLowerCase()
    : '';
  const format = ATTACHMENT_FORMATS.get(extension);
  if (!isRecord(value) || !nonEmptyText(value.publicId, 256) || !isAttachmentDisplayName(value.displayName)
    || !format || value.kind !== format.kind || value.mediaType !== format.mediaType
    || !nonNegativeInteger(value.sizeBytes) || Number(value.sizeBytes) === 0
    || Number(value.sizeBytes) > (format.kind === 'image'
      ? ATTACHMENT_POLICY.maxImageBytes
      : ATTACHMENT_POLICY.maxTextBytes)) throw new Error('Attachment descriptor is invalid.');
  return {
    id: value.publicId,
    selectionId,
    name: value.displayName,
    kind: format.kind,
    mediaType: format.mediaType,
    sizeBytes: Number(value.sizeBytes),
  };
}

export function parseDispatchReconcileResult(value: unknown): DispatchRecoveryResult {
  if (!isRecord(value) || !('runtimeResult' in value) || !('dispatchRecovery' in value)) {
    throw new Error('Dispatch recovery response is invalid.');
  }
  const recovery = parseDispatchRecovery(value.dispatchRecovery);
  const outcome: DispatchRecoveryResult['outcome'] = recovery?.kind === 'accepted' ? 'accepted'
    : recovery?.kind === 'cleanup_pending' ? 'definitive_failure'
      : recovery ? 'outcome_unknown'
        : value.runtimeResult === null ? 'definitive_failure' : 'none';
  return { outcome, recovery };
}
