import type { ConversationPage, RuntimeInfoUi } from '../../src/contracts/bridge';

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

export interface RuntimeConversationRequest {
  type: 'runtime.conversation';
  correlationId: string;
  threadId: string;
  targetAgentId: string;
  limit: number;
}

export interface RuntimeInfoRequest {
  type: 'runtime.info';
  correlationId: string;
  probe: boolean;
}

export type CoreRequest =
  | { type: 'core.shutdown' }
  | { type: 'core.ping'; correlationId: string }
  | RuntimeSendRequest
  | RuntimeConversationRequest
  | RuntimeInfoRequest;

export type CoreEvent =
  | { type: 'core.ready'; version: 1 }
  | { type: 'core.pong'; correlationId: string }
  | { type: 'runtime.dispatch.accepted'; correlationId: string; threadId: string; turnId: string; modelEvidence: RuntimeModelEvidence }
  | { type: 'runtime.request.failed'; correlationId: string; reason: string; retryable: boolean }
  | { type: 'runtime.conversation.result'; correlationId: string; page: ConversationPage }
  | { type: 'runtime.info.result'; correlationId: string; info: RuntimeInfoUi }
  | { type: 'runtime.notification'; notification: RuntimeNotification }
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
  if (value.type === 'runtime.conversation') {
    return isCorrelationId(value.correlationId) && isSafeId(value.threadId) && isSafeId(value.targetAgentId)
      && typeof value.limit === 'number' && Number.isInteger(value.limit) && value.limit >= 1 && value.limit <= 200;
  }
  if (value.type === 'runtime.info') {
    return isCorrelationId(value.correlationId) && typeof value.probe === 'boolean';
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
  return value.type === 'core.stopped';
}
