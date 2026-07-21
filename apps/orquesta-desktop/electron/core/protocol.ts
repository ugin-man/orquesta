import type { ConversationPage, RuntimeInfoUi } from '../../src/contracts/bridge';
import { isV4OperationsSnapshot, type AttentionUiItem, type InspectionKind, type InspectionTargetUi, type OrquestaUiSnapshot } from '../../src/contracts/orquesta-ui';

export interface RuntimeModelEvidence {
  recommendedModel: string | null;
  requestedModel: string | null;
  appliedModel: string | null;
  actualModel: string | null;
  actualModelEvidence: 'proven' | 'reported' | 'inferred' | 'unknown';
}

export interface RuntimeNotification {
  kind: 'turn_started' | 'turn_completed' | 'turn_failed' | 'agent_message' | 'model_observed';
  threadId: string;
  turnId: string | null;
  text: string | null;
  targetAgentId: string | null;
  modelEvidence: RuntimeModelEvidence;
}

export interface RuntimeApprovalRequest {
  projectId: string;
  correlationId: string;
  requestId: string;
  method: string;
  threadId: string;
  turnId: string;
  reason: string | null;
  responseOptions: string[];
}

export interface RuntimeSendRequest {
  type: 'runtime.send';
  correlationId: string;
  projectId: string;
  rootPath: string;
  threadId: string | null;
  targetAgentId: string;
  text: string;
  localImagePaths: string[];
  recommendedModel?: string | null;
  requestedModel?: string | null;
}

export interface RuntimeLucaSendRequest {
  type: 'runtime.luca.send';
  correlationId: string;
  projectId: string;
  rootPath: string;
  threadId: string | null;
  prompt: string;
}

export interface RuntimeConversationRequest {
  type: 'runtime.conversation';
  correlationId: string;
  threadId: string;
  targetAgentId: string;
  cursor?: string | null;
  limit: number;
}

export interface RuntimeInfoRequest {
  type: 'runtime.info';
  correlationId: string;
  probe: boolean;
}

export interface RepositorySelectRequest {
  type: 'repository.select';
  correlationId: string;
  projectId: string;
  rootPath: string;
}

export interface RepositorySnapshotRequest {
  type: 'repository.get-snapshot';
  correlationId: string;
}

export interface RepositoryCloseRequest {
  type: 'repository.close';
  correlationId: string;
}

export interface RuntimeApprovalRespondRequest {
  type: 'runtime.approval.respond';
  correlationId: string;
  attentionId: string;
  decision: string;
}

export interface RepositoryAttentionHistoryRequest {
  type: 'repository.attention-history';
  correlationId: string;
}

export interface InspectionStartRequest {
  type: 'inspection.start';
  correlationId: string;
  projectId: string;
  rootPath: string;
  kind: InspectionKind;
  target: { kind: InspectionTargetUi['kind']; ids: string[] };
  focus: string | null;
}

export interface InspectionCancelRequest {
  type: 'inspection.cancel';
  correlationId: string;
  projectId: string;
  rootPath: string;
  runId: string;
}

export interface InspectionReadReportRequest {
  type: 'inspection.read-report';
  correlationId: string;
  projectId: string;
  rootPath: string;
  runId: string;
}

export type CoreDispatchRequest = RuntimeSendRequest | RuntimeLucaSendRequest | RuntimeConversationRequest | RuntimeInfoRequest
  | RepositorySelectRequest | RepositorySnapshotRequest | RepositoryCloseRequest
  | RuntimeApprovalRespondRequest | RepositoryAttentionHistoryRequest
  | InspectionStartRequest | InspectionCancelRequest | InspectionReadReportRequest;

export type CoreRequest =
  | { type: 'core.shutdown' }
  | { type: 'core.ping'; correlationId: string }
  | RuntimeSendRequest
  | RuntimeLucaSendRequest
  | RuntimeConversationRequest
  | RuntimeInfoRequest
  | RepositorySelectRequest
  | RepositorySnapshotRequest
  | RepositoryCloseRequest
  | RuntimeApprovalRespondRequest
  | RepositoryAttentionHistoryRequest
  | InspectionStartRequest
  | InspectionCancelRequest
  | InspectionReadReportRequest;

export type CoreEvent =
  | { type: 'core.ready'; version: 1 }
  | { type: 'core.pong'; correlationId: string }
  | { type: 'runtime.dispatch.accepted'; correlationId: string; threadId: string; turnId: string; modelEvidence: RuntimeModelEvidence }
  | { type: 'runtime.request.failed'; correlationId: string; reason: string; retryable: boolean }
  | { type: 'runtime.conversation.result'; correlationId: string; page: ConversationPage }
  | { type: 'runtime.info.result'; correlationId: string; info: RuntimeInfoUi }
  | { type: 'runtime.notification'; notification: RuntimeNotification }
  | { type: 'repository.snapshot.result'; correlationId: string; snapshot: OrquestaUiSnapshot }
  | { type: 'repository.snapshot.changed'; snapshot: OrquestaUiSnapshot }
  | { type: 'runtime.approval.accepted'; correlationId: string; attentionId: string; decision: string }
  | { type: 'repository.attention-history.result'; correlationId: string; items: AttentionUiItem[] }
  | { type: 'inspection.action.accepted'; correlationId: string; runId: string }
  | { type: 'inspection.report.result'; correlationId: string; runId: string; markdown: string }
  | { type: 'core.stopped' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isCorrelationId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,128}$/u.test(value);
}

function isBoundedText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
}

function isNullableBoundedText(value: unknown, maximum: number): value is string | null {
  return value === null || (typeof value === 'string' && value.trim().length > 0 && value.length <= maximum);
}

function isModelEvidence(value: unknown): value is RuntimeModelEvidence {
  if (!isRecord(value)) return false;
  return isNullableBoundedText(value.recommendedModel, 256)
    && isNullableBoundedText(value.requestedModel, 256)
    && isNullableBoundedText(value.appliedModel, 256)
    && isNullableBoundedText(value.actualModel, 256)
    && ['proven', 'reported', 'inferred', 'unknown'].includes(String(value.actualModelEvidence));
}

function isRuntimeInfo(value: unknown): value is RuntimeInfoUi {
  if (!isRecord(value)) return false;
  return ['not_started', 'ready', 'unavailable'].includes(String(value.status))
    && value.adapter === 'app_server'
    && isNullableBoundedText(value.sdkVersion, 128)
    && isNullableBoundedText(value.codexVersion, 128)
    && isNullableBoundedText(value.runtimeVersion, 128)
    && isNullableBoundedText(value.targetTriple, 256)
    && isNullableBoundedText(value.platformFamily, 128)
    && isNullableBoundedText(value.platformOs, 128)
    && isNullableBoundedText(value.userAgent, 512)
    && ['verified', 'unverified', 'failed'].includes(String(value.integrity));
}

function isRepositorySnapshot(value: unknown): value is OrquestaUiSnapshot {
  if (!isRecord(value) || !isRecord(value.project)) return false;
  return isSafeId(value.project.id)
    && isBoundedText(value.project.title, 1_024)
    && (value.project.rootPathLabel === null || isBoundedText(value.project.rootPathLabel, 32_768))
    && ['ready', 'working', 'blocked', 'offline', 'unknown'].includes(String(value.project.status))
    && Array.isArray(value.agents)
    && Array.isArray(value.tasks)
    && Array.isArray(value.attention)
    && Array.isArray(value.phases)
    && Array.isArray(value.recentEvents)
    && Array.isArray(value.inspectionTemplates)
    && Array.isArray(value.inspectionRuns)
    && isV4OperationsSnapshot(value.v4Operations);
}

function isInspectionTarget(value: unknown): value is InspectionStartRequest['target'] {
  if (!isRecord(value) || !['project', 'line', 'team', 'agents'].includes(String(value.kind)) || !Array.isArray(value.ids)) return false;
  if (value.ids.length > 32 || !value.ids.every(isSafeId)) return false;
  if (value.kind === 'project') return value.ids.length === 0;
  if (value.kind === 'line' || value.kind === 'team') return value.ids.length === 1;
  return value.ids.length > 0;
}

export function isCoreRequest(value: unknown): value is CoreRequest {
  if (!isRecord(value)) return false;
  if (value.type === 'core.shutdown') return true;
  if (value.type === 'core.ping') return isCorrelationId(value.correlationId);
  if (value.type === 'runtime.send') {
    return isCorrelationId(value.correlationId) && isSafeId(value.projectId) && isBoundedText(value.rootPath, 32_768)
      && (value.threadId === null || isSafeId(value.threadId)) && isSafeId(value.targetAgentId) && isBoundedText(value.text, 65_536)
      && Array.isArray(value.localImagePaths) && value.localImagePaths.length <= 4
      && value.localImagePaths.every((filePath) => isBoundedText(filePath, 32_768));
  }
  if (value.type === 'runtime.luca.send') {
    return isCorrelationId(value.correlationId) && isSafeId(value.projectId) && isBoundedText(value.rootPath, 32_768)
      && (value.threadId === null || isSafeId(value.threadId)) && isBoundedText(value.prompt, 65_536);
  }
  if (value.type === 'runtime.conversation') {
    return isCorrelationId(value.correlationId) && isSafeId(value.threadId) && isSafeId(value.targetAgentId)
      && (value.cursor === undefined || value.cursor === null || (typeof value.cursor === 'string' && /^before:\d+$/u.test(value.cursor)))
      && typeof value.limit === 'number' && Number.isInteger(value.limit) && value.limit >= 1 && value.limit <= 200;
  }
  if (value.type === 'runtime.info') {
    return isCorrelationId(value.correlationId) && typeof value.probe === 'boolean';
  }
  if (value.type === 'repository.select') {
    return isCorrelationId(value.correlationId) && isSafeId(value.projectId) && isBoundedText(value.rootPath, 32_768);
  }
  if (value.type === 'repository.get-snapshot' || value.type === 'repository.close') {
    return isCorrelationId(value.correlationId);
  }
  if (value.type === 'runtime.approval.respond') {
    return isCorrelationId(value.correlationId) && isSafeId(value.attentionId) && isBoundedText(value.decision, 128);
  }
  if (value.type === 'repository.attention-history') return isCorrelationId(value.correlationId);
  if (value.type === 'inspection.start') {
    return isCorrelationId(value.correlationId) && isSafeId(value.projectId) && isBoundedText(value.rootPath, 32_768)
      && ['external_benchmark', 'adversarial_audit'].includes(String(value.kind))
      && isInspectionTarget(value.target) && isNullableBoundedText(value.focus, 4_096);
  }
  if (value.type === 'inspection.cancel' || value.type === 'inspection.read-report') {
    return isCorrelationId(value.correlationId) && isSafeId(value.projectId) && isBoundedText(value.rootPath, 32_768)
      && isSafeId(value.runId);
  }
  return false;
}

export function isCoreEvent(value: unknown): value is CoreEvent {
  if (!isRecord(value)) return false;
  if (value.type === 'core.ready') return value.version === 1;
  if (value.type === 'core.pong') return isCorrelationId(value.correlationId);
  if (value.type === 'runtime.dispatch.accepted') {
    return isCorrelationId(value.correlationId) && isSafeId(value.threadId) && isSafeId(value.turnId)
      && isModelEvidence(value.modelEvidence);
  }
  if (value.type === 'runtime.request.failed') {
    return isCorrelationId(value.correlationId) && isBoundedText(value.reason, 4_096) && typeof value.retryable === 'boolean';
  }
  if (value.type === 'runtime.conversation.result') {
    return isCorrelationId(value.correlationId) && isRecord(value.page) && Array.isArray(value.page.items);
  }
  if (value.type === 'runtime.info.result') {
    return isCorrelationId(value.correlationId) && isRuntimeInfo(value.info);
  }
  if (value.type === 'runtime.notification') {
    const notification = isRecord(value.notification) ? value.notification : null;
    return Boolean(notification && ['turn_started', 'turn_completed', 'turn_failed', 'agent_message', 'model_observed'].includes(String(notification.kind))
      && isSafeId(notification.threadId) && (notification.turnId === null || isSafeId(notification.turnId))
      && (notification.text === null || typeof notification.text === 'string')
      && (notification.targetAgentId === null || isSafeId(notification.targetAgentId))
      && isModelEvidence(notification.modelEvidence));
  }
  if (value.type === 'repository.snapshot.result') {
    return isCorrelationId(value.correlationId) && isRepositorySnapshot(value.snapshot);
  }
  if (value.type === 'repository.snapshot.changed') return isRepositorySnapshot(value.snapshot);
  if (value.type === 'runtime.approval.accepted') {
    return isCorrelationId(value.correlationId) && isSafeId(value.attentionId) && isBoundedText(value.decision, 128);
  }
  if (value.type === 'repository.attention-history.result') {
    return isCorrelationId(value.correlationId) && Array.isArray(value.items);
  }
  if (value.type === 'inspection.action.accepted') {
    return isCorrelationId(value.correlationId) && isSafeId(value.runId);
  }
  if (value.type === 'inspection.report.result') {
    return isCorrelationId(value.correlationId) && isSafeId(value.runId) && isBoundedText(value.markdown, 1_048_576);
  }
  return value.type === 'core.stopped';
}
