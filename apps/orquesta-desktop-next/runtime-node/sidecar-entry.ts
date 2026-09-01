import crypto from 'node:crypto';
import path from 'node:path';
import readline from 'node:readline';
import businessModule from '../../../packages/business-orchestrator/src/index.js';
import { DesktopCodexService } from '../../../packages/local-core/src/core/desktop-codex-service';
import { runDesktopCore, type DesktopCoreTransport } from '../../../packages/local-core/src/core/core-runner';
import { loadPackagedMethodPolicy } from './method-policy.mjs';
import { ProjectionEventCoordinator } from './projection-event-coordinator';

type JsonRecord = Record<string, unknown>;
type Request = { protocolVersion: 1; id: string; method: string; params: JsonRecord };

const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const METHOD_NAME = /^[a-z][a-z0-9.-]{1,127}$/u;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/u;

function requiredAbsoluteEnvironmentPath(name: string): string {
  const value = process.env[name];
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new Error(`${name.toLowerCase()}_unavailable`);
  }
  return path.resolve(value);
}

const runtimeDirectory = requiredAbsoluteEnvironmentPath('ORQUESTA_NEXT_RUNTIME_DIST');
const resourcesPath = requiredAbsoluteEnvironmentPath('ORQUESTA_NEXT_RESOURCES_PATH');
const {
  bytes: policyBytes,
  policy,
} = loadPackagedMethodPolicy(path.join(runtimeDirectory, 'runtime-method-policy.v1.json'));
const policyDigestSha256 = crypto.createHash('sha256').update(policyBytes).digest('hex');
const businessCapability = {
  name: businessModule.BUSINESS_DESKTOP_READ_CONSUMER,
  major: 1,
  minor: 0,
  features: [...businessModule.BUSINESS_DESKTOP_READ_FEATURES],
};
const pending = new Map<string, {
  id: string;
  method: string;
  params: JsonRecord;
  responseType: string | null;
}>();
let inbound: ((message: unknown) => void) | null = null;
let stopping = false;
let selectedProjectId: string | null = null;
const nativeRuntimeGeneration = process.env.ORQUESTA_RUNTIME_GENERATION ?? '';

function record(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
}

function write(value: unknown): void {
  const frame = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(frame, 'utf8') >= MAX_FRAME_BYTES) {
    const fallback = `${JSON.stringify({
      protocolVersion: 1,
      id: null,
      ok: false,
      error: {
        code: 'runtime_frame_too_large',
        message: 'Core response exceeded the transport limit',
        retryable: false,
        outcomeUnknown: false,
        details: null
      }
    })}\n`;
    process.stdout.write(fallback);
    return;
  }
  process.stdout.write(frame);
}

const projectionEvents = new ProjectionEventCoordinator({
  notify: write,
});

function coreFailureCode(value: unknown): string {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,127}$/u.test(value)
    ? value
    : 'core_request_failed';
}

function fail(id: string | null, code: string, message: string, retryable = false, outcomeUnknown = false, details: unknown = null): void {
  write({ protocolVersion: 1, id, ok: false, error: { code, message: message.slice(0, 4096), retryable, outcomeUnknown, details } });
}

function responseResult(event: JsonRecord): unknown {
  const { type: _type, correlationId: _correlationId, ...rest } = event;
  if (Object.keys(rest).length === 1) return Object.values(rest)[0];
  return rest;
}

function normalizeCoreParams(params: JsonRecord): JsonRecord {
  if (process.platform !== 'win32' || typeof params.rootPath !== 'string') return params;
  const rootPath = params.rootPath;
  const normalized = rootPath.startsWith('\\\\?\\UNC\\')
    ? `\\\\${rootPath.slice(8)}`
    : rootPath.startsWith('\\\\?\\') && /^[A-Za-z]:[\\\\/]/u.test(rootPath.slice(4))
      ? rootPath.slice(4)
      : rootPath;
  return normalized === rootPath ? params : { ...params, rootPath: normalized };
}

const transport: DesktopCoreTransport = {
  postMessage(rawEvent) {
    const event = record(rawEvent);
    if (!event) return;
    const correlationId = typeof event.correlationId === 'string' ? event.correlationId : null;
    const request = correlationId ? pending.get(correlationId) : null;
    if (request && event.type === 'runtime.request.failed') {
      pending.delete(correlationId!);
      const details = record(event.details);
      const terminal = details?.terminalOutcome === 'failed'
        && typeof details.messageId === 'string'
        && typeof details.actionFingerprint === 'string';
      const outcomeUnknown = typeof event.outcomeUnknown === 'boolean'
        ? event.outcomeUnknown
        : terminal ? false : event.retryable !== true;
      fail(
        request.id,
        coreFailureCode(event.errorCode),
        typeof event.reason === 'string' ? event.reason : 'Core request failed',
        event.retryable === true,
        outcomeUnknown,
        details
      );
      return;
    }
    if (request && event.type === request.responseType) {
      pending.delete(correlationId!);
      try {
        if (request.method === 'repository.select') {
          selectedProjectId = String(request.params.projectId ?? '');
          projectionEvents.unbind();
        }
        projectionEvents.observeResponse(request.method, request.params, event);
      } catch (error) {
        fail(
          request.id,
          'projection_journal_bind_failed',
          error instanceof Error ? error.message : String(error),
          false,
          false,
        );
        return;
      }
      write({ protocolVersion: 1, id: request.id, ok: true, result: responseResult(event) });
      return;
    }
    if (event.type === 'core.ready') {
      write({
        protocolVersion: 1,
        type: 'sidecar.ready',
        pid: process.pid,
        policySchemaVersion: policy.schemaVersion,
        policyDigestSha256,
        businessWorkOrdersCapability: businessCapability,
      });
      return;
    }
    projectionEvents.observeCoreEvent(event);
    if (event.type === 'runtime.approval.requested'
      || event.type === 'runtime.approval.expired'
      || (event.type === 'runtime.notification'
        && record(event.notification)?.kind === 'provider_event')) {
      return;
    }
    write({ protocolVersion: 1, type: 'runtime.event', event });
  },
  onMessage(listener) {
    inbound = listener;
  },
  exit(code) {
    if (stopping) process.exitCode = code;
  }
};

function parseRequest(line: string): Request {
  if (Buffer.byteLength(line, 'utf8') > MAX_FRAME_BYTES) throw new Error('runtime_frame_too_large');
  const value = record(JSON.parse(line));
  if (!value || value.protocolVersion !== 1 || !REQUEST_ID.test(String(value.id ?? '')) || !METHOD_NAME.test(String(value.method ?? ''))) {
    throw new Error('runtime_request_invalid');
  }
  const params = record(value.params);
  if (!params) throw new Error('runtime_request_params_invalid');
  return { protocolVersion: 1, id: String(value.id), method: String(value.method), params };
}

function dispatch(request: Request): void {
  if (request.method === 'projection.ingest.bind' || request.method === 'projection.ingest.suspend') {
    const keys = Object.keys(request.params).sort();
    const expectedKeys = [
      'activationToken',
      'expectedStatusRevision',
      'projectId',
      'rendererGeneration',
      'rendererSessionId',
      'runtimeGeneration',
    ];
    const projectId = request.params.projectId;
    const runtimeGeneration = request.params.runtimeGeneration;
    const activationToken = request.params.activationToken;
    const rendererSessionId = request.params.rendererSessionId;
    const rendererGeneration = request.params.rendererGeneration;
    const expectedStatusRevision = request.params.expectedStatusRevision;
    if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)
      || typeof projectId !== 'string' || projectId.length === 0
      || typeof runtimeGeneration !== 'string' || runtimeGeneration.length === 0
      || typeof activationToken !== 'string' || activationToken.length === 0
      || typeof rendererSessionId !== 'string' || rendererSessionId.length === 0
      || !Number.isSafeInteger(rendererGeneration) || Number(rendererGeneration) < 0
      || !Number.isSafeInteger(expectedStatusRevision) || Number(expectedStatusRevision) < 0) {
      return fail(request.id, 'projection_ingest_binding_invalid', 'Projection ingest binding is not the exact native authority shape');
    }
    if (!nativeRuntimeGeneration || runtimeGeneration !== nativeRuntimeGeneration
      || projectId !== selectedProjectId) {
      return fail(request.id, 'projection_ingest_binding_mismatch', 'Projection ingest binding does not match the selected native runtime');
    }
    const binding = {
      projectId,
      runtimeGeneration,
      activationToken,
      rendererSessionId,
      rendererGeneration: Number(rendererGeneration),
      expectedStatusRevision: Number(expectedStatusRevision),
    };
    try {
      if (request.method === 'projection.ingest.suspend') projectionEvents.suspend(binding);
      else projectionEvents.bind(binding);
    } catch (error) {
      return fail(
        request.id,
        'projection_ingest_binding_mismatch',
        error instanceof Error ? error.message : String(error),
      );
    }
    write({
      protocolVersion: 1,
      id: request.id,
      ok: true,
      result: {
        bound: true,
        suspended: request.method === 'projection.ingest.suspend',
        projectId,
        runtimeGeneration,
        expectedStatusRevision,
      },
    });
    return;
  }
  const method = Object.hasOwn(policy.methods, request.method)
    ? policy.methods[request.method]
    : undefined;
  if (!method) return fail(request.id, 'runtime_method_unknown', `Unknown runtime method: ${request.method}`);
  if (method.recoveryStrategy === 'internal_unavailable') return fail(request.id, 'runtime_method_internal_unavailable', `Runtime method is not connected in Desktop Next: ${request.method}`);
  if (!inbound) return fail(request.id, 'runtime_not_ready', 'Core transport is not ready', true);
  if (pending.has(request.id) || [...pending.values()].some((item) => item.id === request.id)) return fail(request.id, 'runtime_request_duplicate', 'Request id is already in flight');
  const correlationId = `next:${request.id}`;
  const params = normalizeCoreParams(request.params);
  pending.set(correlationId, {
    id: request.id,
    method: request.method,
    params,
    responseType: method.responseType,
  });
  // The Native sidecar transport delivers the request value itself.
  inbound({ ...params, type: request.method, correlationId });
  if (method.responseType === null) {
    pending.delete(correlationId);
    write({ protocolVersion: 1, id: request.id, ok: true, result: null });
  }
}

runDesktopCore(new DesktopCodexService({
  packaged: process.env.NODE_ENV === 'production',
  appRoot: runtimeDirectory,
  resourcesPath,
}), transport);

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
lines.on('line', (line) => {
  if (!line.trim()) return;
  try { dispatch(parseRequest(line)); }
  catch (error) { fail(null, 'runtime_protocol_error', error instanceof Error ? error.message : String(error)); }
});
lines.on('close', () => {
  stopping = true;
  inbound?.({ type: 'core.shutdown' });
});
