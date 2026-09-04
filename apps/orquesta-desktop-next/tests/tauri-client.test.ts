import { describe, expect, test, vi } from 'vitest';
import bridgeManifest from '../../../packages/contracts/desktop/native-bridge-manifest.v1.json';
import bridgeFixtures from '../../../packages/contracts/desktop/fixtures/native-bridge-fixtures.v1.json';
import {
  NATIVE_BINARY_TRANSPORTS,
  NATIVE_COMMANDS,
  NATIVE_EVENTS,
} from '../../../packages/contracts/generated/desktop/native-bridge-contract';
import { TauriDesktopClient, type TauriTransport } from '../src/adapters/tauri-client';
import {
  invokeNative,
  invokeNativeRawRequest,
  invokeNativeRawResponse,
} from '../src/adapters/tauri/native-bridge';
import { createRendererIdentity } from '../src/adapters/tauri/session-transport';
import type { DispatchRecovery, RuntimeAuthority } from '../src/domain/models';
import { runtimeAuthorityFrom } from '../src/domain/models';
import { parseAttachments, parseDispatchRecovery, parseRuntimeStatus } from '../src/domain/validation';
import type { AttachmentBinarySource } from '../src/ports/desktop-client';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const PREVIOUS_SESSION_ID = '00000000-0000-4000-8000-000000000000';
const RENDERER_GENERATION = 7;
const RUNTIME_GENERATION = '33333333-3333-4333-8333-333333333333';
const PROJECT_ID = 'project-1';
const ACTIVATION_TOKEN = '22222222-2222-4222-8222-222222222222';
const BASE_REVISION = 7;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function commandResponse(name: keyof typeof bridgeFixtures.commands): unknown {
  return clone(bridgeFixtures.commands[name].response);
}

function inputOf(args?: Record<string, unknown>): Record<string, unknown> {
  const input = args?.input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('missing native input envelope');
  return input as Record<string, unknown>;
}

function nativeReadyStatus(revision = BASE_REVISION): Record<string, unknown> {
  const response = commandResponse('bootstrap') as {
    result: { runtime: Record<string, unknown> };
  };
  return { ...response.result.runtime, statusRevision: revision };
}

function nativeStoppedStatus(revision: number): Record<string, unknown> {
  return {
    ...nativeReadyStatus(revision),
    phase: 'stopped',
    pid: null,
    startedAtMs: null,
    activeProjectId: null,
    authorityActivationToken: null,
    authorityRendererSessionId: null,
    authorityRendererGeneration: null,
    processTerminationConfirmed: true,
  };
}

function bootstrapResponse(rendererSessionId = SESSION_ID): unknown {
  const response = commandResponse('bootstrap') as {
    result: {
      rendererSessionId: string;
      runtime: Record<string, unknown>;
      runtimeAuthority: Record<string, unknown> | null;
    };
  };
  response.result.rendererSessionId = rendererSessionId;
  response.result.runtime.authorityRendererSessionId = rendererSessionId;
  if (response.result.runtimeAuthority) response.result.runtimeAuthority.rendererSessionId = rendererSessionId;
  return response;
}

function reconcileResponse(status: Record<string, unknown>): unknown {
  const response = commandResponse('reconcileRuntimeSession') as { result: { runtime: Record<string, unknown> } };
  response.result.runtime = clone(status);
  return response;
}

function runtimeEvent(statusRevision: number, event: unknown, rendererSessionId = SESSION_ID): Record<string, unknown> {
  return {
    schemaVersion: 1,
    statusRevision,
    runtimeGeneration: RUNTIME_GENERATION,
    rendererSessionId,
    rendererGeneration: RENDERER_GENERATION,
    projectId: PROJECT_ID,
    activationToken: ACTIVATION_TOKEN,
    event,
  };
}

function statusEvent(status: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: 1,
    rendererSessionId: SESSION_ID,
    rendererGeneration: RENDERER_GENERATION,
    runtimeGeneration: status.runtimeGeneration,
    statusRevision: status.statusRevision,
    status,
  };
}

test('attachment display names use the same 255 Unicode-scalar boundary as Native and Core', () => {
  const selectionId = '55555555-5555-4555-8555-555555555555';
  const response = (displayName: string) => ({
    selectionId,
    attachments: [{
      publicId: 'attachment-public-id',
      displayName,
      kind: 'text',
      mediaType: 'text/plain',
      sizeBytes: 1,
    }],
  });
  expect(parseAttachments(response(`${'😀'.repeat(251)}.txt`), selectionId)[0].name).toBe(`${'😀'.repeat(251)}.txt`);
  expect(() => parseAttachments(response(`${'😀'.repeat(252)}.txt`), selectionId)).toThrow('Attachment descriptor is invalid.');
  expect(() => parseAttachments(response('unsafe\u0000name.txt'), selectionId)).toThrow('Attachment descriptor is invalid.');
});

test('dispatch recovery receipt invariants match the durable Native contract', () => {
  const record = (phase: string, receipt: unknown) => ({
    phase,
    messageId: 'message-a',
    projectId: 'project-a',
    runtimeProjectId: 'runtime-a',
    targetAgentId: 'orchestrator',
    actionFingerprint: 'a'.repeat(64),
    attachmentCount: 0,
    selectedContextCount: 0,
    createdAtMs: 1,
    updatedAtMs: 2,
    receipt,
  });
  const complete = { threadId: 'thread-a', turnId: 'turn-a' };

  expect(parseDispatchRecovery(record('prepared', null))).toMatchObject({ kind: 'prepared_outcome_unknown' });
  expect(parseDispatchRecovery(record('accepted', complete))).toMatchObject({ kind: 'accepted', threadId: 'thread-a', turnId: 'turn-a' });
  expect(parseDispatchRecovery(record('outcome_unknown', null))).toMatchObject({ kind: 'prepared_outcome_unknown' });
  expect(parseDispatchRecovery(record('outcome_unknown', complete))).toMatchObject({ threadId: 'thread-a', turnId: 'turn-a' });

  for (const invalid of [
    record('prepared', complete),
    record('accepted', null),
    record('accepted', { threadId: 'thread-a', turnId: null }),
    record('cleanup_pending', { threadId: '', turnId: 'turn-a' }),
  ]) expect(() => parseDispatchRecovery(invalid)).toThrow('Dispatch recovery record is invalid.');
});

function projectionRouting(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runtimeGeneration: RUNTIME_GENERATION,
    activationToken: ACTIVATION_TOKEN,
    rendererSessionId: SESSION_ID,
    rendererGeneration: RENDERER_GENERATION,
    statusRevision: BASE_REVISION,
    ...overrides,
  };
}

class FakeTransport implements TauriTransport {
  readonly calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  readonly rawRequestCalls: Array<{
    command: string;
    body: Uint8Array;
    headers: Readonly<Record<string, string>>;
  }> = [];
  readonly rawResponseCalls: Array<{ command: string; args: Record<string, unknown> }> = [];
  readonly listeners = new Map<string, (event: { payload: unknown }) => void>();
  openFailures = 0;
  openRetiredRecoveryPrevious: string | null = null;
  readonly openStructuredFailures: Array<{
    code: string;
    details: Record<string, unknown>;
  }> = [];
  openResponse: Promise<unknown> | null = null;
  runtimeCallResponse: Promise<unknown> | null = null;
  runtimeSendResponse: unknown | null = null;
  bootstrapOverride: unknown | null = null;
  readonly projectionResponses: Array<unknown | Promise<unknown>> = [];
  readonly historyPageResponses: Array<unknown | Promise<unknown>> = [];
  reconcileDispatchResponse: unknown = commandResponse('reconcileDispatchRecovery');
  dispatchRecoveryStatusResponse: unknown = commandResponse('readDispatchRecovery');
  readonly statusResponses: Array<unknown | Promise<unknown>> = [];
  readonly listenFailures = new Set<string>();
  unlistenCount = 0;
  echoOpenSession = false;
  openedRendererSessionId: string | null = null;
  rawResponseOverride: unknown | undefined;
  rawRequestFailures = 0;
  beginAttachmentImportFailure: Error | null = null;
  activateEmitsStatusBeforeResponse = false;
  activateStatusOverrideBeforeResponse: ((
    runtime: Record<string, unknown>,
    input: Record<string, unknown>,
  ) => Record<string, unknown>) | null = null;
  activateResponseRuntimeMutator: ((runtime: Record<string, unknown>) => Record<string, unknown>) | null = null;
  activateSnapshotProjectIdOverride: string | null = null;

  async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    this.calls.push({ command, args });
    if (command === NATIVE_COMMANDS.openRendererSession) {
      if (this.openResponse) return await this.openResponse as T;
      const structuredFailure = this.openStructuredFailures.shift();
      if (structuredFailure) {
        throw {
          code: structuredFailure.code,
          message: 'native session recovery required',
          retryable: false,
          outcomeUnknown: structuredFailure.code === 'renderer_session_recovery_required',
          details: structuredFailure.details,
        };
      }
      if (this.openRetiredRecoveryPrevious) {
        const recoveryPreviousSessionId = this.openRetiredRecoveryPrevious;
        this.openRetiredRecoveryPrevious = null;
        throw {
          code: 'renderer_session_retired',
          message: 'retired admission',
          retryable: false,
          outcomeUnknown: false,
          details: { recoveryPreviousSessionId },
        };
      }
      if (this.openFailures > 0) {
        this.openFailures -= 1;
        throw new Error('invoke response lost');
      }
      const response = commandResponse('openRendererSession') as { result: { rendererSessionId: string } };
      if (this.echoOpenSession) {
        this.openedRendererSessionId = String(inputOf(args).rendererSessionId);
        response.result.rendererSessionId = this.openedRendererSessionId;
      }
      return response as T;
    }
    if (command === NATIVE_COMMANDS.bootstrap) {
      if (this.bootstrapOverride) return clone(this.bootstrapOverride) as T;
      return bootstrapResponse(this.openedRendererSessionId ?? SESSION_ID) as T;
    }
    if (command === NATIVE_COMMANDS.chooseProjectFolder) return commandResponse('chooseProjectFolder') as T;
    if (command === NATIVE_COMMANDS.openProjectFolder) return commandResponse('openProjectFolder') as T;
    if (command === NATIVE_COMMANDS.listArchivedProjects) return commandResponse('listArchivedProjects') as T;
    if (command === NATIVE_COMMANDS.archiveProject) return commandResponse('archiveProject') as T;
    if (command === NATIVE_COMMANDS.restoreArchivedProject) return commandResponse('restoreArchivedProject') as T;
    if (command === NATIVE_COMMANDS.forgetRecentProject) return commandResponse('forgetRecentProject') as T;
    if (command === NATIVE_COMMANDS.createStarterProject) return commandResponse('createStarterProject') as T;
    if (command === NATIVE_COMMANDS.activateProject) {
      const input = inputOf(args);
      const response = commandResponse('activateProject') as {
        result: {
          project: Record<string, unknown>;
          activationToken: string;
          runtime: Record<string, unknown>;
          snapshot: { project: Record<string, unknown> };
        };
      };
      const projectId = String(input.projectId);
      const activationToken = String(input.activationToken);
      response.result.project.projectId = projectId;
      response.result.activationToken = activationToken;
      response.result.runtime = {
        ...response.result.runtime,
        statusRevision: Number(input.expectedStatusRevision) + 1,
        activeProjectId: projectId,
        authorityActivationToken: activationToken,
        authorityRendererSessionId: String(input.rendererSessionId),
        authorityRendererGeneration: Number(input.rendererGeneration),
      };
      if (this.activateResponseRuntimeMutator) {
        response.result.runtime = this.activateResponseRuntimeMutator(response.result.runtime);
      }
      response.result.snapshot.project.id = this.activateSnapshotProjectIdOverride ?? projectId;
      if (this.activateEmitsStatusBeforeResponse || this.activateStatusOverrideBeforeResponse) {
        this.emit(NATIVE_EVENTS.runtimeStatus, statusEvent(
          this.activateStatusOverrideBeforeResponse
            ? this.activateStatusOverrideBeforeResponse(response.result.runtime, input)
            : response.result.runtime,
        ));
      }
      return response as T;
    }
    if (command === NATIVE_COMMANDS.runtimeSend) {
      if (this.runtimeSendResponse) return clone(this.runtimeSendResponse) as T;
      const response = commandResponse('runtimeSend') as {
        result: { dispatchRecovery: { messageId: string } };
      };
      response.result.dispatchRecovery.messageId = String(inputOf(args).messageId);
      return response as T;
    }
    if (command === NATIVE_COMMANDS.interruptTurn) return commandResponse('interruptTurn') as T;
    if (command === NATIVE_COMMANDS.steerTurn) return commandResponse('steerTurn') as T;
    if (command === NATIVE_COMMANDS.readComposerRuntimeOptions) {
      return commandResponse('readComposerRuntimeOptions') as T;
    }
    if (command === NATIVE_COMMANDS.runtimeCall) {
      if (this.runtimeCallResponse) return await this.runtimeCallResponse as T;
      return commandResponse('runtimeCall') as T;
    }
    if (command === NATIVE_COMMANDS.projectionConversation) {
      const response = this.projectionResponses.shift() ?? commandResponse('projectionConversation');
      return await response as T;
    }
    if (command === NATIVE_COMMANDS.recordLastWorkAgent) return commandResponse('recordLastWorkAgent') as T;
    if (command === NATIVE_COMMANDS.projectionHistoryIndex) return commandResponse('projectionHistoryIndex') as T;
    if (command === NATIVE_COMMANDS.projectionHistoryPage) {
      const response = this.historyPageResponses.shift() ?? commandResponse('projectionHistoryPage');
      return await response as T;
    }
    if (command === NATIVE_COMMANDS.reconcileRuntimeSession) {
      const response = this.statusResponses.shift();
      if (!response) throw new Error('missing queued status response');
      return await response as T;
    }
    if (command === NATIVE_COMMANDS.reconcileDispatchRecovery) return clone(this.reconcileDispatchResponse) as T;
    if (command === NATIVE_COMMANDS.readDispatchRecovery) return clone(this.dispatchRecoveryStatusResponse) as T;
    if (command === NATIVE_COMMANDS.beginAttachmentImport) {
      if (this.beginAttachmentImportFailure) throw this.beginAttachmentImportFailure;
      const response = commandResponse('beginAttachmentImport') as {
        result: { selectionId: string; fileCount: number; stagedCount: number; attachments: unknown[] };
      };
      const input = inputOf(args);
      response.result.selectionId = String(input.selectionId);
      response.result.fileCount = Array.isArray(input.files) ? input.files.length : 0;
      response.result.stagedCount = 0;
      response.result.attachments = [];
      return response as T;
    }
    if (command === NATIVE_COMMANDS.finishAttachmentImport) {
      const response = commandResponse('finishAttachmentImport') as {
        result: { selectionId: string };
      };
      response.result.selectionId = String(inputOf(args).selectionId);
      return response as T;
    }
    if (command === NATIVE_COMMANDS.forgetAttachment) return commandResponse('forgetAttachment') as T;
    if (command === NATIVE_COMMANDS.abandonAttachmentSelection) return commandResponse('abandonAttachmentSelection') as T;
    if (command === NATIVE_COMMANDS.voiceStatus) return commandResponse('voiceStatus') as T;
    if (command === NATIVE_COMMANDS.acquireVoiceAsset) return commandResponse('acquireVoiceAsset') as T;
    if (command === NATIVE_COMMANDS.cancelVoiceAssetAcquisition) return commandResponse('cancelVoiceAssetAcquisition') as T;
    if (command === NATIVE_COMMANDS.deleteVoiceAsset) return commandResponse('deleteVoiceAsset') as T;
    if (command === NATIVE_COMMANDS.cancelVoiceTranscription) return commandResponse('cancelVoiceTranscription') as T;
    if (command === NATIVE_COMMANDS.acknowledgeVoiceTranscription) return commandResponse('acknowledgeVoiceTranscription') as T;
    if (command === NATIVE_COMMANDS.cancelRendererSession) return commandResponse('cancelRendererSession') as T;
    throw new Error(`unexpected command: ${command}`);
  }

  async invokeRawRequest<T>(
    command: string,
    body: Uint8Array,
    headers: Readonly<Record<string, string>>,
  ): Promise<T> {
    this.rawRequestCalls.push({ command, body: body.slice(), headers: { ...headers } });
    if (command === NATIVE_COMMANDS.transcribeVoicePcm) {
      return commandResponse('transcribeVoicePcm') as T;
    }
    if (command !== NATIVE_COMMANDS.stageAttachmentBytes) throw new Error(`unexpected raw request: ${command}`);
    if (this.rawRequestFailures > 0) {
      this.rawRequestFailures -= 1;
      throw new Error('raw attachment write failed');
    }
    const response = commandResponse('stageAttachmentBytes') as {
      result: { selectionId: string; slotId: string; staged: boolean };
    };
    response.result.selectionId = headers['x-orquesta-selection-id'];
    response.result.slotId = headers['x-orquesta-slot-id'];
    return response as T;
  }

  async invokeRawResponse(command: string, args: Record<string, unknown>): Promise<unknown> {
    this.rawResponseCalls.push({ command, args });
    if (command !== NATIVE_COMMANDS.readAttachmentPreview) throw new Error(`unexpected raw response: ${command}`);
    if (this.rawResponseOverride !== undefined) return this.rawResponseOverride;
    const fixture = bridgeFixtures.commands.readAttachmentPreview.response;
    const bytes = Uint8Array.from(Buffer.from(fixture.rawBodyBase64, 'base64'));
    return bytes.buffer;
  }

  async listen<T>(event: string, listener: (event: { payload: T }) => void): Promise<() => void> {
    if (this.listenFailures.has(event)) throw new Error(`listen failed: ${event}`);
    this.listeners.set(event, listener as (event: { payload: unknown }) => void);
    return () => {
      this.unlistenCount += 1;
      this.listeners.delete(event);
    };
  }

  emit(event: string, payload: unknown): void {
    this.listeners.get(event)?.({ payload });
  }
}

describe('TauriDesktopClient native bridge and lifecycle fences', () => {
  test('takes every command/event name and envelope version from the single bridge manifest', () => {
    expect(NATIVE_COMMANDS).toEqual(bridgeManifest.commands);
    expect(NATIVE_EVENTS).toEqual(bridgeManifest.events);
    for (const [name, fixture] of Object.entries(bridgeFixtures.commands)) {
      const binary = NATIVE_BINARY_TRANSPORTS[name as keyof typeof NATIVE_BINARY_TRANSPORTS];
      if (binary?.request === 'raw_octet_stream') {
        expect(fixture.args).toMatchObject({ rawHeaders: {}, rawBodyBase64: expect.any(String) });
      } else {
        expect(fixture.args).toMatchObject({ input: { schemaVersion: 1 } });
      }
      if (binary?.response === 'raw_octet_stream') {
        expect(fixture.response).toEqual({ rawBodyBase64: expect.any(String) });
      } else {
        expect(fixture.response).toMatchObject({ schemaVersion: 1 });
        expect(Object.keys(fixture.response).sort()).toEqual(['result', 'schemaVersion']);
      }
    }
  });

  test('parses a Ready process without writer authority as read-only and grants no mutation authority', () => {
    const status = parseRuntimeStatus(bridgeFixtures.scenarios.readOnlyReadyStatus.status);
    expect(status).toMatchObject({ lifecycle: 'Ready', projectId: null, activationToken: null });
    expect(runtimeAuthorityFrom(status)).toBeNull();
  });

  test.each([
    ['missing', undefined],
    ['malformed', 'not-an-array'],
  ])('rejects a %s Starter recovery collection in Native bootstrap', async (_label, replacement) => {
    const transport = new FakeTransport();
    const response = bootstrapResponse() as { result: Record<string, unknown> };
    if (replacement === undefined) delete response.result.starterCreationRecoveries;
    else response.result.starterCreationRecoveries = replacement;
    transport.bootstrapOverride = response;
    const client = new TauriDesktopClient(transport, { current: SESSION_ID, previous: PREVIOUS_SESSION_ID });

    await expect(client.bootstrap()).rejects.toThrow('Native bootstrap payload is invalid.');
    await client.dispose();
  });

  test('rejects a Starter recovery reason that Native Registry cannot produce', async () => {
    const transport = new FakeTransport();
    const response = bootstrapResponse() as { result: Record<string, unknown> };
    response.result.starterCreationRecoveries = [{
      operationRef: '11111111-1111-4111-8111-111111111111',
      displayName: 'Project', finalChildPath: 'C:\\Projects\\Project', reason: 'unknown_reason',
    }];
    transport.bootstrapOverride = response;
    const client = new TauriDesktopClient(transport, { current: SESSION_ID, previous: PREVIOUS_SESSION_ID });

    await expect(client.bootstrap()).rejects.toThrow('Native Starter recovery summary is invalid.');
    await client.dispose();
  });

  test('chooses then opens a native project folder with the exact renderer authority envelopes', async () => {
    const transport = new FakeTransport();
    const client = new TauriDesktopClient(transport, { current: SESSION_ID, previous: PREVIOUS_SESSION_ID });
    const bootstrap = await client.bootstrap();
    const selection = await client.chooseProjectFolder(bootstrap.renderer);
    expect(selection).toEqual({
      selectionRef: '44444444-4444-4444-8444-444444444444',
      rootPath: '/workspace/project-1',
      suggestedName: 'Project One',
    });
    expect(transport.calls.at(-1)).toEqual({
      command: NATIVE_COMMANDS.chooseProjectFolder,
      args: { input: { schemaVersion: 1, rendererSessionId: SESSION_ID, rendererGeneration: RENDERER_GENERATION } },
    });
    const project = await client.openProjectFolder(bootstrap.renderer, {
      selectionRef: selection!.selectionRef,
      projectName: 'Named workspace',
    });
    expect(project).toMatchObject({ id: PROJECT_ID, rootPath: '/workspace/project-1' });
    expect(transport.calls.at(-1)).toEqual({
      command: NATIVE_COMMANDS.openProjectFolder,
      args: { input: {
        schemaVersion: 1,
        rendererSessionId: SESSION_ID,
        rendererGeneration: RENDERER_GENERATION,
        selectionRef: '44444444-4444-4444-8444-444444444444',
        projectName: 'Named workspace',
      } },
    });
    await client.dispose();
  });

  test('archives, lists, and restores a project through exact renderer authority envelopes', async () => {
    const transport = new FakeTransport();
    const client = new TauriDesktopClient(transport, { current: SESSION_ID, previous: PREVIOUS_SESSION_ID });
    const bootstrap = await client.bootstrap();

    await expect(client.listArchivedProjects(bootstrap.renderer)).resolves.toEqual([
      expect.objectContaining({ id: 'project-2', rootPath: '/workspace/project-2' }),
    ]);
    expect(transport.calls.at(-1)).toEqual({
      command: NATIVE_COMMANDS.listArchivedProjects,
      args: { input: {
        schemaVersion: 1,
        rendererSessionId: SESSION_ID,
        rendererGeneration: RENDERER_GENERATION,
      } },
    });
    await expect(client.archiveProject(bootstrap.renderer, 'project-2')).resolves.toMatchObject({
      projects: [expect.objectContaining({ id: PROJECT_ID })],
      archivedProjects: [expect.objectContaining({ id: 'project-2' })],
    });
    expect(transport.calls.at(-1)).toEqual({
      command: NATIVE_COMMANDS.archiveProject,
      args: { input: {
        schemaVersion: 1,
        rendererSessionId: SESSION_ID,
        rendererGeneration: RENDERER_GENERATION,
        projectId: 'project-2',
      } },
    });
    await expect(client.restoreArchivedProject(bootstrap.renderer, 'project-2')).resolves.toMatchObject({
      projects: [expect.objectContaining({ id: PROJECT_ID }), expect.objectContaining({ id: 'project-2' })],
      archivedProjects: [],
    });
    expect(transport.calls.at(-1)?.command).toBe(NATIVE_COMMANDS.restoreArchivedProject);
    await client.dispose();
  });

  test('sends rootless project bootstrap through runtime_call', async () => {
    const transport = new FakeTransport();
    const client = new TauriDesktopClient(transport, { current: SESSION_ID, previous: PREVIOUS_SESSION_ID });
    const bootstrap = await client.bootstrap();
    const authority = runtimeAuthorityFrom(bootstrap.status)!;
    transport.runtimeCallResponse = Promise.resolve({
      schemaVersion: 1,
      result: { status: 'ready', no_write: false, reason: null },
    });
    await expect(client.bootstrapProject(authority)).resolves.toEqual({
      status: 'ready', noWrite: false, reason: null, classification: null,
    });
    expect(inputOf(transport.calls.at(-1)?.args)).toMatchObject({
      projectId: PROJECT_ID, activationToken: ACTIVATION_TOKEN, runtimeGeneration: RUNTIME_GENERATION,
      method: 'project.bootstrap', params: {},
    });
    await client.dispose();
  });

  test('reads the live composer model catalog without project runtime authority', async () => {
    const transport = new FakeTransport();
    const client = new TauriDesktopClient(transport, { current: SESSION_ID, previous: PREVIOUS_SESSION_ID });
    const bootstrap = await client.bootstrap();

    await expect(client.readComposerRuntimeOptions(bootstrap.renderer)).resolves.toEqual({
      models: [{
        id: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', isDefault: true,
        defaultReasoningEffort: 'xhigh',
        supportedReasoningEfforts: [{ effort: 'xhigh', description: 'Maximum practical reasoning.' }],
        serviceTiers: [{ id: 'fast', name: 'Fast', description: '1.5x faster; uses more credits.' }],
      }],
    });
    expect(transport.calls.at(-1)).toMatchObject({
      command: NATIVE_COMMANDS.readComposerRuntimeOptions,
      args: { input: {
        schemaVersion: 1, rendererSessionId: SESSION_ID, rendererGeneration: RENDERER_GENERATION,
      } },
    });
    await client.dispose();
  });

  test('retries unclassified session admission loss with the exact same caller UUID and cancels on dispose', async () => {
    const transport = new FakeTransport();
    transport.openFailures = 2;
    const client = new TauriDesktopClient(transport, { current: SESSION_ID, previous: PREVIOUS_SESSION_ID });
    await client.bootstrap();
    const opens = transport.calls.filter((call) => call.command === NATIVE_COMMANDS.openRendererSession);
    expect(opens).toHaveLength(3);
    expect(opens.every((call) => inputOf(call.args).rendererSessionId === SESSION_ID)).toBe(true);
    expect(opens.every((call) => inputOf(call.args).expectedPreviousSessionId === PREVIOUS_SESSION_ID)).toBe(true);
    await client.dispose();
    expect(transport.calls.at(-1)).toMatchObject({
      command: NATIVE_COMMANDS.cancelRendererSession,
      args: { input: { schemaVersion: 1, rendererSessionId: SESSION_ID, rendererGeneration: RENDERER_GENERATION } },
    });
  });

  test('tombstones an outcome-unknown admission immediately on dispose and never retries after its late response', async () => {
    const transport = new FakeTransport();
    const opening = deferred<unknown>();
    transport.openResponse = opening.promise;
    const client = new TauriDesktopClient(transport, { current: SESSION_ID, previous: PREVIOUS_SESSION_ID });

    const bootstrapping = client.bootstrap();
    await expect.poll(() => transport.calls.filter((call) => call.command === NATIVE_COMMANDS.openRendererSession).length).toBe(1);
    const disposing = client.dispose();
    await expect.poll(() => transport.calls.filter((call) => call.command === NATIVE_COMMANDS.cancelRendererSession).length).toBeGreaterThan(0);
    expect(inputOf(transport.calls.find((call) => call.command === NATIVE_COMMANDS.cancelRendererSession)?.args)).toMatchObject({
      rendererSessionId: SESSION_ID, rendererGeneration: null,
    });

    opening.resolve(commandResponse('openRendererSession'));
    await expect(bootstrapping).rejects.toMatchObject({ name: 'AbortError' });
    await disposing;
    expect(transport.calls.filter((call) => call.command === NATIVE_COMMANDS.openRendererSession)).toHaveLength(1);
  });

  test('retires a malformed versioned admission instead of treating validation failure as transport loss', async () => {
    const transport = new FakeTransport();
    transport.openResponse = Promise.resolve({ schemaVersion: 1, result: { rendererSessionId: SESSION_ID, rendererGeneration: null } });
    const client = new TauriDesktopClient(transport, { current: SESSION_ID, previous: null });

    await expect(client.bootstrap()).rejects.toThrow('Native renderer session response is invalid.');
    expect(transport.calls.filter((call) => call.command === NATIVE_COMMANDS.openRendererSession)).toHaveLength(1);
    expect(transport.calls.filter((call) => call.command === NATIVE_COMMANDS.cancelRendererSession)).toHaveLength(1);
    await client.dispose();
  });

  test('retires an unversioned successful admission instead of accepting a permissive fallback shape', async () => {
    const transport = new FakeTransport();
    transport.openResponse = Promise.resolve({ rendererSessionId: SESSION_ID, rendererGeneration: RENDERER_GENERATION });
    const client = new TauriDesktopClient(transport, { current: SESSION_ID, previous: null });

    await expect(client.bootstrap()).rejects.toThrow('Native response envelope is invalid.');
    expect(transport.calls.filter((call) => call.command === NATIVE_COMMANDS.openRendererSession)).toHaveLength(1);
    expect(transport.calls.filter((call) => call.command === NATIVE_COMMANDS.cancelRendererSession)).toHaveLength(1);
    await client.dispose();
  });

  test('rolls back partially registered native listeners when bootstrap cannot own the full subscription set', async () => {
    const transport = new FakeTransport();
    transport.listenFailures.add(NATIVE_EVENTS.runtimeEvent);
    const client = new TauriDesktopClient(transport, { current: SESSION_ID, previous: null });

    await expect(client.bootstrap()).rejects.toThrow(`listen failed: ${NATIVE_EVENTS.runtimeEvent}`);
    expect(transport.listeners.size).toBe(0);
    expect(transport.unlistenCount).toBe(5);
    expect(transport.calls.filter((call) => call.command === NATIVE_COMMANDS.cancelRendererSession)).toHaveLength(1);
    await client.dispose();
  });

  test('creates a fresh in-memory caller operation key without claiming a predecessor', () => {
    const first = createRendererIdentity();
    const second = createRendererIdentity();
    expect(first.current).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(first.previous).toBeNull();
    expect(second.current).not.toBe(first.current);
    expect(second.previous).toBeNull();
  });

  test('rotates only a definitively retired pending UUID and preserves the native recovery predecessor', async () => {
    const transport = new FakeTransport();
    transport.echoOpenSession = true;
    transport.openRetiredRecoveryPrevious = PREVIOUS_SESSION_ID;
    const client = new TauriDesktopClient(transport);

    await client.bootstrap();

    const opens = transport.calls.filter((call) => call.command === NATIVE_COMMANDS.openRendererSession);
    expect(opens).toHaveLength(2);
    const first = inputOf(opens[0].args);
    const recovered = inputOf(opens[1].args);
    expect(recovered.rendererSessionId).not.toBe(first.rendererSessionId);
    expect(first.expectedPreviousSessionId).toBeNull();
    expect(recovered.expectedPreviousSessionId).toBe(PREVIOUS_SESSION_ID);
    await client.dispose();
  });

  test('rotates a compare-rejected caller key once and adopts the Native predecessor', async () => {
    const transport = new FakeTransport();
    transport.echoOpenSession = true;
    transport.openStructuredFailures.push({
      code: 'renderer_session_compare_failed',
      details: { recoveryPreviousSessionId: PREVIOUS_SESSION_ID },
    });
    const client = new TauriDesktopClient(transport);

    await client.bootstrap();

    const opens = transport.calls.filter((call) => call.command === NATIVE_COMMANDS.openRendererSession);
    expect(opens).toHaveLength(2);
    const rejected = inputOf(opens[0].args);
    const recovered = inputOf(opens[1].args);
    expect(rejected.expectedPreviousSessionId).toBeNull();
    expect(recovered.rendererSessionId).not.toBe(rejected.rendererSessionId);
    expect(recovered.expectedPreviousSessionId).toBe(PREVIOUS_SESSION_ID);
    await client.dispose();
  });

  test('resumes the exact Native-owned pending admission and predecessor', async () => {
    const nativePending = '44444444-4444-4444-8444-444444444444';
    const transport = new FakeTransport();
    transport.echoOpenSession = true;
    transport.openStructuredFailures.push({
      code: 'renderer_session_recovery_required',
      details: {
        recoveryRendererSessionId: nativePending,
        recoveryPreviousSessionId: PREVIOUS_SESSION_ID,
      },
    });
    const client = new TauriDesktopClient(transport);

    await client.bootstrap();

    const opens = transport.calls.filter((call) => call.command === NATIVE_COMMANDS.openRendererSession);
    expect(opens).toHaveLength(2);
    expect(inputOf(opens[1].args)).toMatchObject({
      rendererSessionId: nativePending,
      expectedPreviousSessionId: PREVIOUS_SESSION_ID,
    });
    await client.dispose();
  });

  test('drops stale/foreign runtime bodies before reading them and delivers only the exact UUID incarnation', async () => {
    const transport = new FakeTransport();
    const client = new TauriDesktopClient(transport, { current: SESSION_ID, previous: null });
    const runtimeEvents: unknown[] = [];
    client.subscribe((event) => { if (event.type === 'runtime') runtimeEvents.push(event.event); });
    await client.bootstrap();

    const stale = runtimeEvent(BASE_REVISION - 1, null);
    Object.defineProperty(stale, 'event', { get() { throw new Error('stale body parsed'); } });
    expect(() => transport.emit(NATIVE_EVENTS.runtimeEvent, stale)).not.toThrow();

    const foreign = runtimeEvent(BASE_REVISION + 1, null, '99999999-9999-4999-8999-999999999999');
    Object.defineProperty(foreign, 'event', { get() { throw new Error('foreign body parsed'); } });
    expect(() => transport.emit(NATIVE_EVENTS.runtimeEvent, foreign)).not.toThrow();

    transport.emit(NATIVE_EVENTS.runtimeEvent, runtimeEvent(BASE_REVISION, {
      type: 'runtime.notification', notification: { kind: 'turn_started' },
    }));
    expect(runtimeEvents).toEqual([{ type: 'runtime.notification', notification: { kind: 'turn_started' } }]);
    await client.dispose();
  });

  test('rejects a same-window status event routed to a replacement renderer session', async () => {
    const transport = new FakeTransport();
    const client = new TauriDesktopClient(transport, { current: SESSION_ID, previous: null });
    const statuses: unknown[] = [];
    client.subscribe((event) => { if (event.type === 'status') statuses.push(event.status); });
    await client.bootstrap();
    transport.emit(NATIVE_EVENTS.runtimeStatus, {
      ...statusEvent(nativeStoppedStatus(BASE_REVISION + 1)),
      rendererSessionId: '99999999-9999-4999-8999-999999999999',
    });
    expect(statuses).toHaveLength(1);
    await client.dispose();
  });

  test('uses typed runtime_send with a pre-admission dispatchId and full exact epoch', async () => {
    const transport = new FakeTransport();
    const client = new TauriDesktopClient(transport, { current: SESSION_ID, previous: null });
    await client.bootstrap();
    const authority: RuntimeAuthority = {
      projectId: PROJECT_ID, activationToken: ACTIVATION_TOKEN,
      rendererSessionId: SESSION_ID, rendererGeneration: RENDERER_GENERATION,
    };
    const result = await client.sendMessage(authority, {
      targetAgentId: 'agent-root', text: 'hello', attachmentRefs: [],
      model: 'gpt-5.6-sol', effort: 'xhigh', accessMode: 'full_access', serviceTier: 'fast',
    });
    const send = transport.calls.find((call) => call.command === NATIVE_COMMANDS.runtimeSend)!;
    expect(result.receipt.dispatchId).toBe(inputOf(send.args).messageId);
    expect(result.receipt.dispatchId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(inputOf(send.args)).toMatchObject({
      schemaVersion: 1,
      runtimeGeneration: RUNTIME_GENERATION,
      expectedStatusRevision: BASE_REVISION,
      additionalParams: {
        requestedModel: 'gpt-5.6-sol', effort: 'xhigh', sandbox: 'danger-full-access',
        approvalPolicy: 'never', serviceTier: 'fast', recommendedModel: null,
      },
    });
    expect(transport.calls.some((call) => call.command === NATIVE_COMMANDS.runtimeCall
      && inputOf(call.args).method === 'runtime.send')).toBe(false);
    expect(result.dispatchRecovery).toMatchObject({
      kind: 'accepted', dispatchId: result.receipt.dispatchId, projectId: PROJECT_ID,
    });
    await client.dispose();
  });

  test('rejects a successful native send response without a complete receipt', async () => {
    const transport = new FakeTransport();
    const response = commandResponse('runtimeSend') as {
      result: { runtimeResult: { threadId: string | null; turnId: string | null } };
    };
    response.result.runtimeResult.turnId = null;
    transport.runtimeSendResponse = response;
    const client = new TauriDesktopClient(transport, { current: SESSION_ID, previous: null });
    await client.bootstrap();
    const authority: RuntimeAuthority = {
      projectId: PROJECT_ID, activationToken: ACTIVATION_TOKEN,
      rendererSessionId: SESSION_ID, rendererGeneration: RENDERER_GENERATION,
    };

    await expect(client.sendMessage(authority, {
      targetAgentId: 'agent-root', text: 'hello', attachmentRefs: [],
      model: null, effort: null, accessMode: 'full_access', serviceTier: 'standard',
    })).rejects.toThrow('Dispatch receipt is invalid.');
    await client.dispose();
  });

  test('accepts activation when its own Ready status event arrives before the command response', async () => {
    const transport = new FakeTransport();
    transport.activateEmitsStatusBeforeResponse = true;
    const client = new TauriDesktopClient(transport, { current: SESSION_ID, previous: PREVIOUS_SESSION_ID });
    const bootstrap = await client.bootstrap();
    const project = bootstrap.projects.find((candidate) => candidate.id === PROJECT_ID)!;

    const activated = await client.activateProject(
      project,
      bootstrap.renderer,
      bootstrap.status.statusRevision,
    );
    expect(activated).toMatchObject({
      lifecycle: 'Ready',
      projectId: PROJECT_ID,
      statusRevision: bootstrap.status.statusRevision + 1,
    });
    const call = transport.calls.find((candidate) => candidate.command === NATIVE_COMMANDS.activateProject)!;
    expect(activated.activationToken).toBe(inputOf(call.args).activationToken);
    await client.dispose();
  });

  test('rejects an activation response whose snapshot belongs to another project', async () => {
    const transport = new FakeTransport();
    transport.activateSnapshotProjectIdOverride = 'foreign-project';
    const client = new TauriDesktopClient(transport, { current: SESSION_ID, previous: PREVIOUS_SESSION_ID });
    const bootstrap = await client.bootstrap();
    const project = bootstrap.projects.find((candidate) => candidate.id === PROJECT_ID)!;

    await expect(client.activateProject(
      project,
      bootstrap.renderer,
      bootstrap.status.statusRevision,
    )).rejects.toThrow('Native project activation snapshot belongs to another project.');
    await client.dispose();
  });

  test.each([
    ['activation token', (runtime: Record<string, unknown>) => ({
      ...runtime, authorityActivationToken: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    })],
    ['project', (runtime: Record<string, unknown>) => ({
      ...runtime, activeProjectId: 'foreign-project',
    })],
  ] as const)('rejects activation when a newer foreign %s wins before the command response', async (_field, mutate) => {
    const transport = new FakeTransport();
    transport.activateStatusOverrideBeforeResponse = (runtime) => mutate({
      ...runtime,
      statusRevision: BASE_REVISION + 2,
    });
    const client = new TauriDesktopClient(transport, { current: SESSION_ID, previous: PREVIOUS_SESSION_ID });
    const bootstrap = await client.bootstrap();
    const project = bootstrap.projects.find((candidate) => candidate.id === PROJECT_ID)!;

    await expect(client.activateProject(
      project,
      bootstrap.renderer,
      bootstrap.status.statusRevision,
    )).rejects.toMatchObject({ name: 'RuntimeAuthorityError' });
    await client.dispose();
  });

  test.each([
    ['renderer session', (runtime: Record<string, unknown>) => ({
      ...runtime, authorityRendererSessionId: '99999999-9999-4999-8999-999999999999',
    })],
    ['renderer generation', (runtime: Record<string, unknown>) => ({
      ...runtime, authorityRendererGeneration: RENDERER_GENERATION + 1,
    })],
  ] as const)('rejects activation response with the wrong %s', async (_field, mutate) => {
    const transport = new FakeTransport();
    transport.activateResponseRuntimeMutator = mutate;
    const client = new TauriDesktopClient(transport, { current: SESSION_ID, previous: PREVIOUS_SESSION_ID });
    const bootstrap = await client.bootstrap();
    const project = bootstrap.projects.find((candidate) => candidate.id === PROJECT_ID)!;

    await expect(client.activateProject(
      project,
      bootstrap.renderer,
      bootstrap.status.statusRevision,
    )).rejects.toThrow('admitted authority');
    await client.dispose();
  });

  test('uses the generated History commands and one canonical query identity', async () => {
    const transport = new FakeTransport();
    const client = new TauriDesktopClient(transport, { current: SESSION_ID, previous: null });
    const bootstrap = await client.bootstrap();
    const authority = runtimeAuthorityFrom(bootstrap.status)!;

    await expect(client.recordLastWorkAgent(authority, 'orchestrator')).resolves.toMatchObject({
      id: PROJECT_ID,
      lastWorkAgentId: 'orchestrator',
    });
    await expect(client.readHistoryIndex(authority)).resolves.toMatchObject({
      projectId: PROJECT_ID,
      items: [expect.objectContaining({ targetAgentId: 'orchestrator' })],
    });
    await expect(client.readHistoryPage(authority, 'orchestrator', '  続きを確認  ')).resolves.toMatchObject({
      projectId: PROJECT_ID,
      targetAgentId: 'orchestrator',
      query: '続きを確認',
    });
    const emptyQueryResponse = commandResponse('projectionHistoryPage') as {
      result: { query: string | null };
    };
    emptyQueryResponse.result.query = null;
    transport.historyPageResponses.push(emptyQueryResponse);
    await expect(client.readHistoryPage(authority, 'orchestrator', '   ')).resolves.toMatchObject({ query: null });

    const historyCalls = transport.calls.filter((call) => call.command === NATIVE_COMMANDS.projectionHistoryPage);
    expect(historyCalls).toHaveLength(2);
    expect(inputOf(historyCalls[0].args).query).toBe('続きを確認');
    expect(inputOf(historyCalls[1].args).query).toBeNull();
    expect(inputOf(transport.calls.find((call) => call.command === NATIVE_COMMANDS.recordLastWorkAgent)?.args))
      .toMatchObject({
        schemaVersion: 1,
        projectId: PROJECT_ID,
        activationToken: ACTIVATION_TOKEN,
        targetAgentId: 'orchestrator',
      });
    await client.dispose();
  });

  test('bootstraps voice status and accepts only exact-renderer monotonic voice events', async () => {
    const transport = new FakeTransport();
    const client = new TauriDesktopClient(transport, { current: SESSION_ID, previous: PREVIOUS_SESSION_ID });
    const events: unknown[] = [];
    client.subscribe((event) => { if (event.type === 'voice_status') events.push(event.status); });
    const bootstrap = await client.bootstrap();
    expect(bootstrap.voiceStatus).toMatchObject({
      schemaVersion: 2, revision: 3, providerId: 'whisper.cpp-local', requiredAssetsReady: false,
    });
    events.length = 0;

    const foreign = clone(bridgeFixtures.events.voiceStatus) as Record<string, unknown>;
    foreign.rendererSessionId = '99999999-9999-4999-8999-999999999999';
    Object.defineProperty(foreign, 'status', {
      enumerable: true,
      get: () => { throw new Error('foreign body must not be read'); },
    });
    expect(() => transport.emit(NATIVE_EVENTS.voiceStatus, foreign)).not.toThrow();
    expect(events).toEqual([]);

    const current = clone(bridgeFixtures.events.voiceStatus);
    current.status.revision = 4;
    current.status.requiredAssetsReady = true;
    current.status.assets = current.status.assets.map((asset) => (
      asset.assetId === current.status.comparisonModelAssetId
        ? asset
        : { ...asset, phase: 'installed', downloadedBytes: asset.expectedBytes, operationRef: null }
    ));
    transport.emit(NATIVE_EVENTS.voiceStatus, current);
    expect(events).toEqual([expect.objectContaining({ revision: 4, requiredAssetsReady: true })]);

    const equivocation = clone(current);
    equivocation.status.providerId = 'conflicting-provider';
    transport.emit(NATIVE_EVENTS.voiceStatus, equivocation);
    expect(events).toHaveLength(1);
    await client.dispose();
  });

  test('transports bounded PCM through the manifest raw channel with exact renderer and operation headers', async () => {
    const transport = new FakeTransport();
    const client = new TauriDesktopClient(transport, { current: SESSION_ID, previous: PREVIOUS_SESSION_ID });
    const bootstrap = await client.bootstrap();
    const operationRef = '88888888-8888-4888-8888-888888888888';
    const pcm = new Uint8Array(3_200);
    const binding = {
      target: 'agent' as const,
      projectId: PROJECT_ID,
      agentId: 'orchestrator',
      activationToken: ACTIVATION_TOKEN,
      draftSha256: '1'.repeat(64),
    };

    await expect(client.transcribeVoicePcm(bootstrap.renderer, operationRef, binding, pcm, 1_600)).resolves.toMatchObject({
      operationRef,
      phase: 'staging',
    });
    expect(transport.rawRequestCalls).toEqual([{
      command: NATIVE_COMMANDS.transcribeVoicePcm,
      body: pcm,
      headers: {
        'x-orquesta-schema-version': '1',
        'x-orquesta-renderer-session-id': SESSION_ID,
        'x-orquesta-renderer-generation': String(RENDERER_GENERATION),
        'x-orquesta-operation-ref': operationRef,
        'x-orquesta-sample-rate-hz': '16000',
        'x-orquesta-channel-count': '1',
        'x-orquesta-sample-format': 'pcm-s16le',
        'x-orquesta-sample-count': '1600',
        'x-orquesta-composer-target': 'agent',
        'x-orquesta-composer-draft-sha256': '1'.repeat(64),
        'x-orquesta-composer-project-id': PROJECT_ID,
        'x-orquesta-composer-agent-id': 'orchestrator',
        'x-orquesta-runtime-activation-token': ACTIVATION_TOKEN,
      },
    }]);
    await client.dispose();
  });

  test('retains each accepted response for native exact-terminal cleanup without renderer acknowledgement', async () => {
    const transport = new FakeTransport();
    const client = new TauriDesktopClient(transport, { current: SESSION_ID, previous: null });
    await client.bootstrap();
    const authority: RuntimeAuthority = {
      projectId: PROJECT_ID, activationToken: ACTIVATION_TOKEN,
      rendererSessionId: SESSION_ID, rendererGeneration: RENDERER_GENERATION,
    };

    const first = await client.sendMessage(authority, {
      targetAgentId: 'agent-root', text: 'first', attachmentRefs: [],
      model: null, effort: null, accessMode: 'full_access', serviceTier: 'standard',
    });
    const second = await client.sendMessage(authority, {
      targetAgentId: 'agent-root', text: 'second', attachmentRefs: [],
      model: null, effort: null, accessMode: 'full_access', serviceTier: 'standard',
    });
    expect(first.receipt.dispatchId).not.toBe(second.receipt.dispatchId);
    expect(first.dispatchRecovery).toMatchObject({ kind: 'accepted', dispatchId: first.receipt.dispatchId });
    expect(second.dispatchRecovery).toMatchObject({ kind: 'accepted', dispatchId: second.receipt.dispatchId });
    await client.dispose();
  });

  test('does not use renderer acknowledgement or status polling to clear an accepted send', async () => {
    const transport = new FakeTransport();
    transport.dispatchRecoveryStatusResponse = {
      schemaVersion: 1,
      result: null,
    };
    const client = new TauriDesktopClient(transport, { current: SESSION_ID, previous: null });
    await client.bootstrap();
    const authority: RuntimeAuthority = {
      projectId: PROJECT_ID, activationToken: ACTIVATION_TOKEN,
      rendererSessionId: SESSION_ID, rendererGeneration: RENDERER_GENERATION,
    };

    const result = await client.sendMessage(authority, {
      targetAgentId: 'agent-root', text: 'accepted', attachmentRefs: [],
      model: null, effort: null, accessMode: 'full_access', serviceTier: 'standard',
    });

    expect(result.receipt.dispatchId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(result.dispatchRecovery).toMatchObject({ kind: 'accepted', dispatchId: result.receipt.dispatchId });
    expect(transport.calls.some((call) => call.command === NATIVE_COMMANDS.readDispatchRecovery)).toBe(false);
    await client.dispose();
  });

  test('reads the versioned workflow catalog while allowing additive producer fields', async () => {
    const transport = new FakeTransport();
    transport.runtimeCallResponse = Promise.resolve({
      schemaVersion: 1,
      result: {
        catalog: {
          version: 1,
          definitions: [{
            workflowId: 'workflow-1', name: '確認', prompt: '一度確認する', checks: [],
            createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:00:00.000Z',
            futureField: 'ignored',
          }],
          batches: [],
          limits: { maxAttemptsPerBatch: 50 },
          additiveProducerField: true,
        },
      },
    });
    const client = new TauriDesktopClient(transport, { current: SESSION_ID, previous: null });
    await client.bootstrap();
    const authority: RuntimeAuthority = {
      projectId: PROJECT_ID, activationToken: ACTIVATION_TOKEN,
      rendererSessionId: SESSION_ID, rendererGeneration: RENDERER_GENERATION,
    };

    await expect(client.readWorkflowCatalog(authority)).resolves.toMatchObject({
      definitions: [{ workflowId: 'workflow-1', name: '確認' }],
      batches: [], maxAttemptsPerBatch: 50,
    });
    expect(inputOf(transport.calls.find((call) => call.command === NATIVE_COMMANDS.runtimeCall)?.args)).toMatchObject({
      method: 'workflow.catalog.read',
      params: { projectId: PROJECT_ID },
    });
    await client.dispose();
  });

  test('validates the versioned native response when abandoning a renderer-owned selection', async () => {
    const transport = new FakeTransport();
    const client = new TauriDesktopClient(transport, { current: SESSION_ID, previous: null });
    await client.bootstrap();
    const selectionId = '44444444-4444-4444-8444-444444444444';
    await client.abandonAttachmentSelection(null, selectionId);
    const call = transport.calls.find((candidate) => candidate.command === NATIVE_COMMANDS.abandonAttachmentSelection)!;
    expect(inputOf(call.args)).toEqual({
      schemaVersion: 1,
      rendererSessionId: SESSION_ID,
      rendererGeneration: RENDERER_GENERATION,
      selectionId,
    });
    await client.dispose();
  });

  test('rejects an in-flight runtime completion after a passive lifecycle epoch change', async () => {
    const transport = new FakeTransport();
    const completion = deferred<unknown>();
    transport.runtimeCallResponse = completion.promise;
    const client = new TauriDesktopClient(transport, { current: SESSION_ID, previous: null });
    await client.bootstrap();
    const authority: RuntimeAuthority = {
      projectId: PROJECT_ID, activationToken: ACTIVATION_TOKEN,
      rendererSessionId: SESSION_ID, rendererGeneration: RENDERER_GENERATION,
    };

    const responding = client.respondToApproval(authority, 'approval-1', 'approve');
    await expect.poll(() => transport.calls.filter((call) => call.command === NATIVE_COMMANDS.runtimeCall).length).toBe(1);
    transport.emit(NATIVE_EVENTS.runtimeStatus, statusEvent(nativeStoppedStatus(BASE_REVISION + 1)));
    completion.resolve({ schemaVersion: 1, result: { ok: true } });
    await expect(responding).rejects.toMatchObject({ name: 'RuntimeAuthorityError' });
    await client.dispose();
  });

  test('coalesces same-generation ahead events and follows status progress to the newest revision', async () => {
    const transport = new FakeTransport();
    const firstRefresh = deferred<unknown>();
    transport.statusResponses.push(firstRefresh.promise, reconcileResponse(nativeReadyStatus(BASE_REVISION + 2)));
    const client = new TauriDesktopClient(transport, { current: SESSION_ID, previous: null });
    const delivered: number[] = [];
    client.subscribe((event) => {
      if (event.type === 'runtime' && typeof event.event.sequence === 'number') delivered.push(event.event.sequence);
    });
    await client.bootstrap();

    transport.emit(NATIVE_EVENTS.runtimeEvent, runtimeEvent(BASE_REVISION + 1, {
      type: 'runtime.notification', sequence: BASE_REVISION + 1,
    }));
    await expect.poll(() => transport.calls.filter((call) => call.command === NATIVE_COMMANDS.reconcileRuntimeSession).length).toBe(1);
    transport.emit(NATIVE_EVENTS.runtimeEvent, runtimeEvent(BASE_REVISION + 2, {
      type: 'runtime.notification', sequence: BASE_REVISION + 2,
    }));
    firstRefresh.resolve(reconcileResponse(nativeReadyStatus(BASE_REVISION + 1)));

    await expect.poll(() => transport.calls.filter((call) => call.command === NATIVE_COMMANDS.reconcileRuntimeSession).length).toBe(2);
    await expect.poll(() => delivered).toEqual([BASE_REVISION + 1, BASE_REVISION + 2]);
    expect(transport.calls.filter((call) => call.command === NATIVE_COMMANDS.reconcileRuntimeSession)).toHaveLength(2);
    await client.dispose();
  });

  test('stops follow-up refreshes after bounded attempts without status progress', async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    const unchanged = reconcileResponse(nativeReadyStatus());
    transport.statusResponses.push(clone(unchanged), clone(unchanged), clone(unchanged));
    const client = new TauriDesktopClient(transport, { current: SESSION_ID, previous: null });
    try {
      await client.bootstrap();
      transport.emit(NATIVE_EVENTS.runtimeEvent, runtimeEvent(BASE_REVISION + 1, {
        type: 'runtime.notification', sequence: BASE_REVISION + 1,
      }));

      await vi.advanceTimersByTimeAsync(10_000);
      expect(transport.calls.filter((call) => call.command === NATIVE_COMMANDS.reconcileRuntimeSession)).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(transport.calls.filter((call) => call.command === NATIVE_COMMANDS.reconcileRuntimeSession)).toHaveLength(3);
      await client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  test('reconciles cleanup-pending recovery with renderer ownership and nullable runtime epoch', async () => {
    const transport = new FakeTransport();
    transport.reconcileDispatchResponse = clone(bridgeFixtures.scenarios.cleanupPendingReconcile.response);
    const client = new TauriDesktopClient(transport, { current: SESSION_ID, previous: null });
    await client.bootstrap();
    const recovery: DispatchRecovery = {
      kind: 'cleanup_pending',
      dispatchId: '66666666-6666-4666-8666-666666666666',
      projectId: PROJECT_ID,
      targetAgentId: 'agent-root',
      createdAt: '2023-11-14T22:13:23.000Z',
      reason: null,
      threadId: null,
      turnId: null,
    };
    const result = await client.reconcileDispatchRecovery({
      rendererSessionId: SESSION_ID, rendererGeneration: RENDERER_GENERATION,
    }, recovery, null);
    const call = transport.calls.find((candidate) => candidate.command === NATIVE_COMMANDS.reconcileDispatchRecovery)!;
    expect(inputOf(call.args)).toMatchObject({
      messageId: recovery.dispatchId,
      projectId: recovery.projectId,
      activationToken: null,
      runtimeGeneration: null,
      expectedStatusRevision: null,
    });
    expect(result).toEqual({ outcome: 'definitive_failure', recovery: null });
    await client.dispose();
  });

  test('forgets one attachment with the exact renderer, selection, and public ID binding', async () => {
    const transport = new FakeTransport();
    const client = new TauriDesktopClient(transport, { current: SESSION_ID, previous: null });
    await client.bootstrap();
    const selectionId = '44444444-4444-4444-8444-444444444444';
    const publicId = '55555555-5555-4555-8555-555555555555';

    await client.forgetAttachment(null, selectionId, publicId);

    const call = transport.calls.find((candidate) => candidate.command === NATIVE_COMMANDS.forgetAttachment)!;
    expect(inputOf(call.args)).toEqual({
      schemaVersion: 1,
      rendererSessionId: SESSION_ID,
      rendererGeneration: RENDERER_GENERATION,
      selectionId,
      publicId,
    });
    await client.dispose();
  });

  test('imports browser-owned bytes without reading a path and reads preview only as exact raw bytes', async () => {
    const transport = new FakeTransport();
    const client = new TauriDesktopClient(transport, { current: SESSION_ID, previous: null });
    const boot = await client.bootstrap();
    const authority = runtimeAuthorityFrom(boot.status)!;
    const selectionId = '44444444-4444-4444-8444-444444444444';
    const pngBytes = Uint8Array.from(Buffer.from('iVBORw0KGgo=', 'base64'));
    const source = {
      name: 'evidence.png',
      size: pngBytes.byteLength,
      type: 'image/png',
      async arrayBuffer() { return pngBytes.slice().buffer; },
      get path() { throw new Error('raw path must not be read'); },
      get value() { throw new Error('file input value must not be read'); },
      get webkitRelativePath() { throw new Error('relative path must not be read'); },
    } satisfies AttachmentBinarySource & Record<string, unknown>;

    const attachments = await client.importAttachments(authority, selectionId, [source]);

    expect(attachments).toEqual([expect.objectContaining({
      id: '55555555-5555-4555-8555-555555555555',
      selectionId,
      name: 'evidence.png',
      sizeBytes: 8,
    })]);
    expect(transport.rawRequestCalls).toHaveLength(1);
    expect([...transport.rawRequestCalls[0].body]).toEqual([...pngBytes]);
    expect(transport.rawRequestCalls[0].headers).toEqual({
      'x-orquesta-schema-version': '1',
      'x-orquesta-renderer-session-id': SESSION_ID,
      'x-orquesta-renderer-generation': String(RENDERER_GENERATION),
      'x-orquesta-selection-id': selectionId,
      'x-orquesta-slot-id': expect.any(String),
    });

    const preview = await client.readAttachmentPreview(authority, selectionId, attachments[0].id);
    expect(preview).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(preview)]).toEqual([...pngBytes]);
    expect(transport.rawResponseCalls).toEqual([{
      command: NATIVE_COMMANDS.readAttachmentPreview,
      args: { input: {
        schemaVersion: 1,
        rendererSessionId: SESSION_ID,
        rendererGeneration: RENDERER_GENERATION,
        selectionId,
        publicId: attachments[0].id,
      } },
    }]);
    await client.dispose();
  });

  test('fails closed across generic and raw native body-mode boundaries', async () => {
    const transport = new FakeTransport();
    expect(() => invokeNative(transport, NATIVE_COMMANDS.stageAttachmentBytes, {}))
      .toThrow(/body mode mismatch/);
    expect(() => invokeNativeRawRequest(
      transport,
      NATIVE_COMMANDS.bootstrap,
      new Uint8Array([1]),
      {},
    )).toThrow(/body mode mismatch/);
    expect(() => invokeNative(transport, 'not-a-native-command', {}))
      .toThrow(/Unknown native command/);
    await expect(invokeNativeRawResponse(transport, NATIVE_COMMANDS.bootstrap, {}))
      .rejects.toThrow(/body mode mismatch/);
    expect(transport.calls).toHaveLength(0);
    expect(transport.rawRequestCalls).toHaveLength(0);
    expect(transport.rawResponseCalls).toHaveLength(0);
  });

  test('rejects every non-ArrayBuffer or empty raw preview response', async () => {
    const invalidResponses: unknown[] = [
      [1, 2, 3],
      new Uint8Array([1, 2, 3]),
      new Blob([new Uint8Array([1, 2, 3])]),
      { byteLength: 3 },
      new ArrayBuffer(0),
    ];
    for (const invalid of invalidResponses) {
      const transport = new FakeTransport();
      transport.rawResponseOverride = invalid;
      const client = new TauriDesktopClient(transport, { current: SESSION_ID, previous: null });
      const authority = runtimeAuthorityFrom((await client.bootstrap()).status)!;
      await expect(client.readAttachmentPreview(
        authority,
        '44444444-4444-4444-8444-444444444444',
        '55555555-5555-4555-8555-555555555555',
      )).rejects.toThrow(/exact ArrayBuffer|size is invalid/);
      await client.dispose();
    }
  });

  test('routes attachment policy to Native before reading or transferring raw bytes', async () => {
    const transport = new FakeTransport();
    transport.beginAttachmentImportFailure = new Error('native attachment policy rejected');
    const client = new TauriDesktopClient(transport, { current: SESSION_ID, previous: null });
    const authority = runtimeAuthorityFrom((await client.bootstrap()).status)!;
    const selectionId = '44444444-4444-4444-8444-444444444444';
    const readBytes = vi.fn(async () => new ArrayBuffer(8));

    await expect(client.importAttachments(authority, selectionId, [{
      name: 'unsupported.pdf', size: 8, type: 'application/pdf', arrayBuffer: readBytes,
    }])).rejects.toThrow('native attachment policy rejected');

    expect(transport.calls.some((call) => call.command === NATIVE_COMMANDS.beginAttachmentImport)).toBe(true);
    expect(readBytes).not.toHaveBeenCalled();
    expect(transport.rawRequestCalls).toHaveLength(0);
    expect(transport.calls.some((call) => call.command === NATIVE_COMMANDS.abandonAttachmentSelection)).toBe(true);
    await client.dispose();
  });

  test('abandons the exact selection when a raw stage fails', async () => {
    const transport = new FakeTransport();
    transport.rawRequestFailures = 1;
    const client = new TauriDesktopClient(transport, { current: SESSION_ID, previous: null });
    const authority = runtimeAuthorityFrom((await client.bootstrap()).status)!;
    const selectionId = '44444444-4444-4444-8444-444444444444';
    const pngBytes = Uint8Array.from(Buffer.from('iVBORw0KGgo=', 'base64'));

    await expect(client.importAttachments(authority, selectionId, [{
      name: 'evidence.png', size: pngBytes.byteLength, type: 'image/png',
      async arrayBuffer() { return pngBytes.slice().buffer; },
    }])).rejects.toThrow('raw attachment write failed');

    const cleanupCalls = transport.calls.filter((call) => call.command === NATIVE_COMMANDS.abandonAttachmentSelection);
    expect(cleanupCalls.length).toBeGreaterThanOrEqual(1);
    expect(cleanupCalls.every((call) => inputOf(call.args).selectionId === selectionId)).toBe(true);
    expect(transport.calls.some((call) => call.command === NATIVE_COMMANDS.finishAttachmentImport)).toBe(false);
    await client.dispose();
  });

  test('reads the typed projection with exact renderer and runtime authority', async () => {
    const transport = new FakeTransport();
    const client = new TauriDesktopClient(transport, { current: SESSION_ID, previous: null });
    const boot = await client.bootstrap();
    const authority = runtimeAuthorityFrom(boot.status)!;
    const page = await client.readConversation(
      authority,
      'orchestrator',
      { streamId: null, journalSequence: 0, projectionRevision: 0 },
      null,
      null,
      'pending-cursor-v1',
    );
    expect(page).toMatchObject({
      source: 'sqlite', projectId: PROJECT_ID, targetAgentId: 'orchestrator',
      appliedJournalSequence: 42, syncState: 'current', pendingRequests: [],
    });
    const call = transport.calls.find((candidate) => candidate.command === NATIVE_COMMANDS.projectionConversation)!;
    expect(inputOf(call.args)).toEqual({
      schemaVersion: 1,
      rendererSessionId: SESSION_ID,
      rendererGeneration: RENDERER_GENERATION,
      projectId: PROJECT_ID,
      targetAgentId: 'orchestrator',
      expectedStreamId: null,
      afterJournalSequence: 0,
      expectedProjectionRevision: 0,
      cursor: null,
      activityCursor: null,
      pendingRequestCursor: 'pending-cursor-v1',
      limit: 50,
    });
    await client.dispose();
  });

  test('interrupts only through the typed exact-turn native command', async () => {
    const transport = new FakeTransport();
    const client = new TauriDesktopClient(transport, { current: SESSION_ID, previous: null });
    const boot = await client.bootstrap();
    const authority = runtimeAuthorityFrom(boot.status)!;
    await client.interruptTurn(authority, {
      targetAgentId: 'agent-root',
      threadId: 'thread-1',
      turnId: 'turn-1',
    });
    const call = transport.calls.find((candidate) => candidate.command === NATIVE_COMMANDS.interruptTurn)!;
    expect(inputOf(call.args)).toMatchObject({
      schemaVersion: 1,
      projectId: PROJECT_ID,
      targetAgentId: 'agent-root',
      threadId: 'thread-1',
      turnId: 'turn-1',
      runtimeGeneration: RUNTIME_GENERATION,
      expectedStatusRevision: BASE_REVISION,
    });
    expect(transport.calls.some((candidate) => candidate.command === NATIVE_COMMANDS.runtimeCall
      && inputOf(candidate.args).method === 'runtime.turn.interrupt')).toBe(false);
    await client.dispose();
  });

  test('steers only through the typed exact-turn native command', async () => {
    const transport = new FakeTransport();
    const client = new TauriDesktopClient(transport, { current: SESSION_ID, previous: null });
    const boot = await client.bootstrap();
    const authority = runtimeAuthorityFrom(boot.status)!;
    await client.steerTurn(authority, {
      steerId: '77777777-7777-4777-8777-777777777777',
      targetAgentId: 'agent-root',
      threadId: 'thread-1',
      turnId: 'turn-1',
      text: 'Focus on the root cause.',
    });
    const call = transport.calls.find((candidate) => candidate.command === NATIVE_COMMANDS.steerTurn)!;
    expect(inputOf(call.args)).toMatchObject({
      schemaVersion: 1,
      projectId: PROJECT_ID,
      steerId: '77777777-7777-4777-8777-777777777777',
      targetAgentId: 'agent-root',
      threadId: 'thread-1',
      turnId: 'turn-1',
      text: 'Focus on the root cause.',
      runtimeGeneration: RUNTIME_GENERATION,
      expectedStatusRevision: BASE_REVISION,
    });
    expect(transport.calls.some((candidate) => candidate.command === NATIVE_COMMANDS.runtimeCall
      && inputOf(candidate.args).method === 'runtime.turn.steer')).toBe(false);
    await client.dispose();
  });

  test('retries a projection read when a newer applied watermark arrives before its response', async () => {
    const transport = new FakeTransport();
    const first = deferred<unknown>();
    transport.projectionResponses.push(first.promise);
    const second = commandResponse('projectionConversation') as { result: Record<string, unknown> };
    second.result.appliedJournalSequence = 43;
    second.result.projectionRevision = 18;
    transport.projectionResponses.push(second);
    const client = new TauriDesktopClient(transport, { current: SESSION_ID, previous: null });
    const boot = await client.bootstrap();
    const reading = client.readConversation(
      runtimeAuthorityFrom(boot.status)!,
      'orchestrator',
      { streamId: null, journalSequence: 0, projectionRevision: 0 },
      null,
    );
    await expect.poll(() => transport.calls.filter((call) => call.command === NATIVE_COMMANDS.projectionConversation).length).toBe(1);
    transport.emit(NATIVE_EVENTS.projectionChanged, {
      schemaVersion: 1,
      ...projectionRouting(),
      projectId: PROJECT_ID,
      streamId: 'stream_00000000-0000-4000-8000-000000000001',
      appliedJournalSequence: 43,
      projectionRevision: 18,
      eventCount: 1,
      messageCount: 1,
      status: 'applied',
    });
    first.resolve(commandResponse('projectionConversation'));
    await expect(reading).resolves.toMatchObject({ appliedJournalSequence: 43 });
    const calls = transport.calls.filter((call) => call.command === NATIVE_COMMANDS.projectionConversation);
    expect(calls).toHaveLength(2);
    expect(inputOf(calls[1].args)).toMatchObject({
      expectedStreamId: 'stream_00000000-0000-4000-8000-000000000001',
      afterJournalSequence: 42,
      expectedProjectionRevision: 17,
    });
    await client.dispose();
  });

  test('delivers an additive provider refresh even when the journal watermark is unchanged', async () => {
    const transport = new FakeTransport();
    const client = new TauriDesktopClient(transport, { current: SESSION_ID, previous: null });
    const changes: unknown[] = [];
    client.subscribe((event) => {
      if (event.type === 'projection_changed') changes.push(event);
    });
    await client.bootstrap();
    const base = {
      schemaVersion: 1,
      ...projectionRouting(),
      projectId: PROJECT_ID,
      streamId: 'stream_00000000-0000-4000-8000-000000000001',
      appliedJournalSequence: 42,
      projectionRevision: 17,
      eventCount: 1,
      messageCount: 1,
      status: 'applied',
    };
    transport.emit(NATIVE_EVENTS.projectionChanged, base);
    transport.emit(NATIVE_EVENTS.projectionChanged, {
      ...base,
      projectionRevision: 18,
      eventCount: 0,
      messageCount: 3,
    });
    transport.emit(NATIVE_EVENTS.projectionChanged, {
      ...base,
      projectionRevision: 18,
      eventCount: 0,
      messageCount: 0,
      status: 'idempotent',
    });
    expect(changes).toHaveLength(2);
    await client.dispose();
  });

  test('rejects projection events from every stale same-project runtime incarnation axis', async () => {
    const transport = new FakeTransport();
    const client = new TauriDesktopClient(transport, { current: SESSION_ID, previous: null });
    const changes: unknown[] = [];
    const faults: unknown[] = [];
    client.subscribe((event) => {
      if (event.type === 'projection_changed') changes.push(event);
      if (event.type === 'projection_status') faults.push(event);
    });
    await client.bootstrap();
    const current = {
      schemaVersion: 1,
      ...projectionRouting(),
      projectId: PROJECT_ID,
      streamId: 'stream-current',
      appliedJournalSequence: 42,
      projectionRevision: 17,
      eventCount: 1,
      messageCount: 1,
      status: 'applied',
    };
    transport.emit(NATIVE_EVENTS.projectionChanged, current);
    const staleAxes = [
      { runtimeGeneration: '44444444-4444-4444-8444-444444444444' },
      { activationToken: '55555555-5555-4555-8555-555555555555' },
      { rendererSessionId: '66666666-6666-4666-8666-666666666666' },
      { rendererGeneration: RENDERER_GENERATION + 1 },
      { statusRevision: BASE_REVISION + 1 },
    ];
    staleAxes.forEach((axis, index) => transport.emit(NATIVE_EVENTS.projectionChanged, {
      ...current,
      ...axis,
      streamId: `stream-stale-${index}`,
      projectionRevision: 100 + index,
    }));
    transport.emit(NATIVE_EVENTS.projectionStatus, {
      schemaVersion: 1,
      ...projectionRouting(),
      projectId: PROJECT_ID,
      status: 'faulted',
      error: { code: 'current_fault', message: 'surface this fault', retryable: true, outcomeUnknown: false },
    });
    transport.emit(NATIVE_EVENTS.projectionStatus, {
      schemaVersion: 1,
      ...projectionRouting({ runtimeGeneration: '77777777-7777-4777-8777-777777777777' }),
      projectId: PROJECT_ID,
      status: 'faulted',
      error: { code: 'stale_fault', message: 'must not surface', retryable: false, outcomeUnknown: false },
    });
    expect(changes).toHaveLength(1);
    expect(faults).toEqual([
      expect.objectContaining({ type: 'projection_status', code: 'current_fault', retryable: true }),
    ]);
    await client.dispose();
  });

  test('clears only the exact completed dispatch from the current Native incarnation', async () => {
    const transport = new FakeTransport();
    const client = new TauriDesktopClient(transport, { current: SESSION_ID, previous: null });
    const recoveries: unknown[] = [];
    client.subscribe((event) => {
      if (event.type === 'dispatch_recovery') recoveries.push(event);
    });
    await client.bootstrap();
    const current = {
      schemaVersion: 1,
      ...projectionRouting(),
      projectId: PROJECT_ID,
      dispatchId: '66666666-6666-4666-8666-666666666666',
    };

    transport.emit(NATIVE_EVENTS.dispatchRecoveryCleared, current);
    transport.emit(NATIVE_EVENTS.dispatchRecoveryCleared, {
      ...current,
      runtimeGeneration: '77777777-7777-4777-8777-777777777777',
      dispatchId: 'stale-runtime-dispatch',
    });
    transport.emit(NATIVE_EVENTS.dispatchRecoveryCleared, {
      ...current,
      dispatchId: '',
    });

    expect(recoveries).toEqual([{
      type: 'dispatch_recovery',
      projectId: PROJECT_ID,
      recovery: null,
      clearedDispatchId: '66666666-6666-4666-8666-666666666666',
    }]);
    await client.dispose();
  });

  test('resets projection watermarks when an accepted same-project incarnation changes', async () => {
    const transport = new FakeTransport();
    const client = new TauriDesktopClient(transport, { current: SESSION_ID, previous: null });
    await client.bootstrap();
    transport.emit(NATIVE_EVENTS.projectionChanged, {
      schemaVersion: 1,
      ...projectionRouting(),
      projectId: PROJECT_ID,
      streamId: 'stream-old-incarnation',
      appliedJournalSequence: 500,
      projectionRevision: 500,
      eventCount: 1,
      messageCount: 1,
      status: 'applied',
    });
    const replacementRuntimeGeneration = '88888888-8888-4888-8888-888888888888';
    const replacementActivationToken = '99999999-9999-4999-8999-999999999999';
    const replacement = {
      ...nativeReadyStatus(BASE_REVISION + 1),
      runtimeGeneration: replacementRuntimeGeneration,
      authorityActivationToken: replacementActivationToken,
    };
    transport.emit(NATIVE_EVENTS.runtimeStatus, statusEvent(replacement));
    const authority = runtimeAuthorityFrom(parseRuntimeStatus(replacement))!;
    await client.readConversation(
      authority,
      'orchestrator',
      { streamId: null, journalSequence: 0, projectionRevision: 0 },
      null,
    );
    expect(transport.calls.filter((call) => call.command === NATIVE_COMMANDS.projectionConversation)).toHaveLength(1);
    await client.dispose();
  });

});
