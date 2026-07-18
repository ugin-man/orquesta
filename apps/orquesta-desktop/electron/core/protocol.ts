import type { ConversationPage } from '../../src/contracts/bridge';

export interface RuntimeSendRequest {
  type: 'runtime.send';
  correlationId: string;
  projectId: string;
  rootPath: string;
  threadId: string | null;
  targetAgentId: string;
  text: string;
}

export interface RuntimeConversationRequest {
  type: 'runtime.conversation';
  correlationId: string;
  threadId: string;
  targetAgentId: string;
  limit: number;
}

export interface RuntimeNotification {
  kind: 'turn_started' | 'turn_completed' | 'turn_failed' | 'agent_message';
  threadId: string;
  turnId: string | null;
  text: string | null;
}

export type CoreRequest =
  | { type: 'core.shutdown' }
  | { type: 'core.ping'; correlationId: string }
  | RuntimeSendRequest
  | RuntimeConversationRequest;

export type CoreEvent =
  | { type: 'core.ready'; version: 1 }
  | { type: 'core.pong'; correlationId: string }
  | { type: 'runtime.dispatch.accepted'; correlationId: string; threadId: string; turnId: string; actualModel: string | null }
  | { type: 'runtime.request.failed'; correlationId: string; reason: string; retryable: boolean }
  | { type: 'runtime.conversation.result'; correlationId: string; page: ConversationPage }
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

export function isCoreRequest(value: unknown): value is CoreRequest {
  if (!isRecord(value)) return false;
  if (value.type === 'core.shutdown') return true;
  if (value.type === 'core.ping') return isCorrelationId(value.correlationId);
  if (value.type === 'runtime.send') {
    return isCorrelationId(value.correlationId) && isSafeId(value.projectId) && isBoundedText(value.rootPath, 32_768)
      && (value.threadId === null || isSafeId(value.threadId)) && isSafeId(value.targetAgentId) && isBoundedText(value.text, 65_536);
  }
  if (value.type === 'runtime.conversation') {
    return isCorrelationId(value.correlationId) && isSafeId(value.threadId) && isSafeId(value.targetAgentId)
      && typeof value.limit === 'number' && Number.isInteger(value.limit) && value.limit >= 1 && value.limit <= 200;
  }
  return false;
}

export function isCoreEvent(value: unknown): value is CoreEvent {
  if (!isRecord(value)) return false;
  if (value.type === 'core.ready') return value.version === 1;
  if (value.type === 'core.pong') return isCorrelationId(value.correlationId);
  if (value.type === 'runtime.dispatch.accepted') {
    return isCorrelationId(value.correlationId) && isSafeId(value.threadId) && isSafeId(value.turnId)
      && (value.actualModel === null || isBoundedText(value.actualModel, 256));
  }
  if (value.type === 'runtime.request.failed') {
    return isCorrelationId(value.correlationId) && isBoundedText(value.reason, 4_096) && typeof value.retryable === 'boolean';
  }
  if (value.type === 'runtime.conversation.result') {
    return isCorrelationId(value.correlationId) && isRecord(value.page) && Array.isArray(value.page.items);
  }
  if (value.type === 'runtime.notification') {
    const notification = isRecord(value.notification) ? value.notification : null;
    return Boolean(notification && ['turn_started', 'turn_completed', 'turn_failed', 'agent_message'].includes(String(notification.kind))
      && isSafeId(notification.threadId) && (notification.turnId === null || isSafeId(notification.turnId))
      && (notification.text === null || typeof notification.text === 'string'));
  }
  return value.type === 'core.stopped';
}
