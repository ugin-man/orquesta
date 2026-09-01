import type {
  ConversationActivityCursor, ConversationCursor, ConversationReadCheckpoint, ConversationSnapshot,
  HistoryConversationPage, HistoryCursor, HistoryIndexPage, RendererAuthority, RuntimeStatus,
} from '../../domain/models';
import { runtimeAuthorityFrom, sameRendererAuthority } from '../../domain/models';
import {
  isRecord, parseConversationSnapshot, parseHistoryConversationPage, parseHistoryIndexPage,
} from '../../domain/validation';
import { NATIVE_COMMANDS, hasExactKeys, invokeNative, unwrapResult, type TauriTransport } from './native-bridge';

export interface ProjectionIncarnation {
  projectId: string;
  runtimeGeneration: string;
  activationToken: string;
  rendererSessionId: string;
  rendererGeneration: number;
  statusRevision: number;
}

export interface ProjectionWatermark {
  streamId: string;
  journalSequence: number;
  projectionRevision: number;
}

interface ProjectionRouting extends ProjectionIncarnation { schemaVersion: 1 }

export interface ProjectionChangedPayload extends ProjectionRouting {
  streamId: string;
  appliedJournalSequence: number;
  projectionRevision: number;
  eventCount: number;
  messageCount: number;
  status: 'applied' | 'idempotent';
}

export interface ProjectionFaultPayload extends ProjectionRouting {
  status: 'faulted';
  error: { code: string; message: string; retryable: boolean; outcomeUnknown: boolean };
}

export interface DispatchRecoveryClearedPayload extends ProjectionRouting {
  dispatchId: string;
}

const ROUTING_KEYS = [
  'schemaVersion', 'projectId', 'runtimeGeneration', 'activationToken',
  'rendererSessionId', 'rendererGeneration', 'statusRevision',
] as const;

function parseRouting(value: Record<string, unknown>): ProjectionRouting | null {
  if (value.schemaVersion !== 1
    || typeof value.projectId !== 'string'
    || typeof value.runtimeGeneration !== 'string'
    || typeof value.activationToken !== 'string'
    || typeof value.rendererSessionId !== 'string'
    || !Number.isSafeInteger(value.rendererGeneration)
    || !Number.isSafeInteger(value.statusRevision)) return null;
  return {
    schemaVersion: 1,
    projectId: value.projectId,
    runtimeGeneration: value.runtimeGeneration,
    activationToken: value.activationToken,
    rendererSessionId: value.rendererSessionId,
    rendererGeneration: Number(value.rendererGeneration),
    statusRevision: Number(value.statusRevision),
  };
}

export function projectionIncarnationFromStatus(
  status: RuntimeStatus | null,
  renderer: RendererAuthority | null,
): ProjectionIncarnation | null {
  const authority = status ? runtimeAuthorityFrom(status) : null;
  if (!status || !renderer || !authority || status.runtimeGeneration === null
    || !sameRendererAuthority(renderer, authority)) return null;
  return {
    projectId: authority.projectId,
    runtimeGeneration: status.runtimeGeneration,
    activationToken: authority.activationToken,
    rendererSessionId: authority.rendererSessionId,
    rendererGeneration: authority.rendererGeneration,
    statusRevision: status.statusRevision,
  };
}

export function sameProjectionIncarnation(
  left: ProjectionIncarnation | null,
  right: ProjectionIncarnation | null,
): boolean {
  return left?.projectId === right?.projectId
    && left?.runtimeGeneration === right?.runtimeGeneration
    && left?.activationToken === right?.activationToken
    && left?.rendererSessionId === right?.rendererSessionId
    && left?.rendererGeneration === right?.rendererGeneration
    && left?.statusRevision === right?.statusRevision;
}

export function matchesProjectionIncarnation(
  payload: ProjectionIncarnation,
  current: ProjectionIncarnation | null,
): boolean {
  return current !== null && sameProjectionIncarnation(payload, current);
}

export function parseProjectionChanged(payload: unknown): ProjectionChangedPayload | null {
  const keys = [
    ...ROUTING_KEYS, 'streamId', 'appliedJournalSequence', 'projectionRevision',
    'eventCount', 'messageCount', 'status',
  ];
  if (!isRecord(payload) || !hasExactKeys(payload, keys)) return null;
  const routing = parseRouting(payload);
  if (!routing
    || typeof payload.streamId !== 'string'
    || !Number.isSafeInteger(payload.appliedJournalSequence) || Number(payload.appliedJournalSequence) < 0
    || !Number.isSafeInteger(payload.projectionRevision) || Number(payload.projectionRevision) < 0
    || !Number.isSafeInteger(payload.eventCount)
    || !Number.isSafeInteger(payload.messageCount)
    || !['applied', 'idempotent'].includes(String(payload.status))) return null;
  return {
    ...routing,
    streamId: payload.streamId,
    appliedJournalSequence: Number(payload.appliedJournalSequence),
    projectionRevision: Number(payload.projectionRevision),
    eventCount: Number(payload.eventCount),
    messageCount: Number(payload.messageCount),
    status: payload.status as 'applied' | 'idempotent',
  };
}

export function parseProjectionFault(payload: unknown): ProjectionFaultPayload | null {
  if (!isRecord(payload)
    || !hasExactKeys(payload, [...ROUTING_KEYS, 'status', 'error'])
    || payload.status !== 'faulted'
    || !isRecord(payload.error)
    || !hasExactKeys(payload.error, ['code', 'message', 'retryable', 'outcomeUnknown'])
    || typeof payload.error.code !== 'string'
    || typeof payload.error.message !== 'string'
    || typeof payload.error.retryable !== 'boolean'
    || typeof payload.error.outcomeUnknown !== 'boolean') return null;
  const routing = parseRouting(payload);
  if (!routing) return null;
  return {
    ...routing,
    status: 'faulted',
    error: {
      code: payload.error.code,
      message: payload.error.message,
      retryable: payload.error.retryable,
      outcomeUnknown: payload.error.outcomeUnknown,
    },
  };
}

export function parseDispatchRecoveryCleared(payload: unknown): DispatchRecoveryClearedPayload | null {
  if (!isRecord(payload)
    || !hasExactKeys(payload, [...ROUTING_KEYS, 'dispatchId'])
    || typeof payload.dispatchId !== 'string'
    || payload.dispatchId.length === 0
    || payload.dispatchId.length > 128) return null;
  const routing = parseRouting(payload);
  return routing ? { ...routing, dispatchId: payload.dispatchId } : null;
}

export async function readProjectionConversation(
  transport: TauriTransport,
  input: {
    renderer: RendererAuthority;
    projectId: string;
    targetAgentId: string;
    checkpoint: ConversationReadCheckpoint;
    cursor?: ConversationCursor | null;
    activityCursor?: ConversationActivityCursor | null;
    pendingRequestCursor?: string | null;
  },
): Promise<ConversationSnapshot> {
  const raw = await invokeNative<unknown>(transport, NATIVE_COMMANDS.projectionConversation, {
    rendererSessionId: input.renderer.rendererSessionId,
    rendererGeneration: input.renderer.rendererGeneration,
    projectId: input.projectId,
    targetAgentId: input.targetAgentId,
    expectedStreamId: input.checkpoint.streamId,
    afterJournalSequence: input.checkpoint.journalSequence,
    expectedProjectionRevision: input.checkpoint.projectionRevision,
    cursor: input.cursor ?? null,
    activityCursor: input.activityCursor ?? null,
    pendingRequestCursor: input.pendingRequestCursor ?? null,
    limit: 50,
  });
  const snapshot = parseConversationSnapshot(unwrapResult(raw));
  if (snapshot.projectId !== input.projectId || snapshot.targetAgentId !== input.targetAgentId) {
    throw new Error('Projection conversation response belongs to another project or agent.');
  }
  return snapshot;
}

export async function readProjectionHistoryIndex(
  transport: TauriTransport,
  input: {
    renderer: RendererAuthority;
    projectId: string;
    cursor?: HistoryCursor | null;
  },
): Promise<HistoryIndexPage> {
  const raw = await invokeNative<unknown>(transport, NATIVE_COMMANDS.projectionHistoryIndex, {
    rendererSessionId: input.renderer.rendererSessionId,
    rendererGeneration: input.renderer.rendererGeneration,
    projectId: input.projectId,
    cursor: input.cursor ?? null,
    limit: 50,
  });
  const page = parseHistoryIndexPage(unwrapResult(raw));
  if (page.projectId !== input.projectId) {
    throw new Error('Projection history index belongs to another project.');
  }
  return page;
}

export async function readProjectionHistoryPage(
  transport: TauriTransport,
  input: {
    renderer: RendererAuthority;
    projectId: string;
    targetAgentId: string;
    query: string | null;
    cursor?: ConversationCursor | null;
  },
): Promise<HistoryConversationPage> {
  const query = input.query?.trim() || null;
  const raw = await invokeNative<unknown>(transport, NATIVE_COMMANDS.projectionHistoryPage, {
    rendererSessionId: input.renderer.rendererSessionId,
    rendererGeneration: input.renderer.rendererGeneration,
    projectId: input.projectId,
    targetAgentId: input.targetAgentId,
    query,
    cursor: input.cursor ?? null,
    limit: 50,
  });
  const page = parseHistoryConversationPage(unwrapResult(raw));
  if (page.projectId !== input.projectId || page.targetAgentId !== input.targetAgentId
    || page.query !== query) {
    throw new Error('Projection history page belongs to another request.');
  }
  return page;
}

export function projectionReadRaced(
  snapshot: ConversationSnapshot,
  observed: ProjectionWatermark | undefined,
): boolean {
  return Boolean(observed && (snapshot.streamId !== observed.streamId
    || snapshot.appliedJournalSequence < observed.journalSequence
    || snapshot.projectionRevision < observed.projectionRevision));
}

export function projectionWatermarkIsSameOrOlder(
  previous: ProjectionWatermark | undefined,
  next: ProjectionWatermark,
): boolean {
  return Boolean(previous
    && previous.streamId === next.streamId
    && previous.projectionRevision >= next.projectionRevision);
}
