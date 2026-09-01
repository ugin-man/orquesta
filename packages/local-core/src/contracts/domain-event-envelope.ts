import { createHash } from 'node:crypto';

export type DomainEventOwnerV1 =
  | { kind: 'agent'; agentId: string }
  | { kind: 'ephemeral'; executionId: string }
  | { kind: 'system'; systemId: string };

export interface DomainEventEnvelopeV1 {
  domainEventVersion: 1;
  sourceEventId: string;
  sourceRuntime: string;
  sourceCursor: string | null;
  owner: DomainEventOwnerV1;
  agentId: string | null;
  taskId: string | null;
  threadId: string | null;
  turnId: string | null;
  itemId: string | null;
  kind: string;
  phase: string;
  occurredAt: string;
  payload: Record<string, unknown>;
  evidenceRef: string | null;
}

export type DomainEventEnvelopeInputV1 = Omit<DomainEventEnvelopeV1,
  'domainEventVersion' | 'sourceEventId' | 'agentId' | 'owner'> & {
    owner?: DomainEventOwnerV1;
    agentId?: string | null;
    projectId: string;
  };

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError('Domain event identity must be JSON serializable');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}

function bounded(value: unknown, label: string, maximum = 2_048): string {
  if (typeof value !== 'string' || value.trim() === '' || Buffer.byteLength(value, 'utf8') > maximum) {
    throw new TypeError(`${label} must be a bounded non-empty string`);
  }
  return value;
}

function nullable(value: unknown, label: string, maximum = 2_048): string | null {
  return value === null || value === undefined ? null : bounded(value, label, maximum);
}

function exactOwner(value: DomainEventOwnerV1): DomainEventOwnerV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Domain event owner must be an object');
  }
  const keys = Object.keys(value).sort();
  if (value.kind === 'agent' && keys.join(',') === 'agentId,kind') {
    return Object.freeze({ kind: 'agent', agentId: bounded(value.agentId, 'owner.agentId', 512) });
  }
  if (value.kind === 'ephemeral' && keys.join(',') === 'executionId,kind') {
    return Object.freeze({ kind: 'ephemeral', executionId: bounded(value.executionId, 'owner.executionId', 512) });
  }
  if (value.kind === 'system' && keys.join(',') === 'kind,systemId') {
    return Object.freeze({ kind: 'system', systemId: bounded(value.systemId, 'owner.systemId', 512) });
  }
  throw new TypeError('Domain event owner must be exactly agent, ephemeral, or system');
}

export function domainEventOwner(input: {
  owner?: DomainEventOwnerV1;
  agentId?: string | null;
  sourceRuntime: string;
}): DomainEventOwnerV1 {
  if (input.owner) return exactOwner(input.owner);
  const agentId = nullable(input.agentId, 'agentId', 512);
  return agentId
    ? Object.freeze({ kind: 'agent', agentId })
    : Object.freeze({ kind: 'system', systemId: bounded(input.sourceRuntime, 'sourceRuntime', 256) });
}

export function createDomainEventEnvelopeV1(input: DomainEventEnvelopeInputV1): DomainEventEnvelopeV1 {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Domain event input must be an object');
  }
  const projectId = bounded(input.projectId, 'projectId', 512);
  const sourceRuntime = bounded(input.sourceRuntime, 'sourceRuntime', 256);
  const sourceCursor = nullable(input.sourceCursor, 'sourceCursor');
  const owner = domainEventOwner({ owner: input.owner, agentId: input.agentId, sourceRuntime });
  const taskId = nullable(input.taskId, 'taskId', 512);
  const threadId = nullable(input.threadId, 'threadId', 512);
  const turnId = nullable(input.turnId, 'turnId', 512);
  const itemId = nullable(input.itemId, 'itemId', 512);
  const kind = bounded(input.kind, 'kind', 256);
  const phase = bounded(input.phase, 'phase', 128);
  if (sourceCursor === null && itemId === null) {
    throw new TypeError('Cursorless domain events require a stable itemId');
  }
  if (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)) {
    throw new TypeError('Domain event payload must be an object');
  }
  const identity = {
    domainEventVersion: 1,
    sourceRuntime,
    sourceCursor,
    projectId,
    owner,
    taskId,
    threadId,
    turnId,
    itemId,
    kind,
    phase,
  };
  const sourceEventId = `src_${createHash('sha256').update(canonicalJson(identity), 'utf8').digest('hex')}`;
  return Object.freeze({
    domainEventVersion: 1,
    sourceEventId,
    sourceRuntime,
    sourceCursor,
    owner,
    agentId: owner.kind === 'agent' ? owner.agentId : null,
    taskId,
    threadId,
    turnId,
    itemId,
    kind,
    phase,
    occurredAt: bounded(input.occurredAt, 'occurredAt', 128),
    payload: structuredClone(input.payload),
    evidenceRef: nullable(input.evidenceRef, 'evidenceRef'),
  });
}
