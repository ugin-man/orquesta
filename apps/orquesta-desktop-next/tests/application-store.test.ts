import { waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { ApplicationStore } from '../src/application/store';
import type { ConversationCursor, ConversationMessage, ConversationReadCheckpoint, DispatchRecovery, DispatchSendResult, ProjectBootstrapResult, ProjectSummary, RendererAuthority, RuntimeAuthority, RuntimeStatus, VoiceComposerBinding, VoiceOperationStatus, VoiceStatus, WorkspaceSnapshot } from '../src/domain/models';
import { DispatchSendError, type VoiceTranscriptionBindingInput } from '../src/ports/desktop-client';
import { PreviewDesktopClient, previewProjects, previewSnapshot } from '../src/testing/preview-client';

const RUNTIME_GENERATION_A = '88888888-8888-4888-8888-888888888888';
const RUNTIME_GENERATION_B = '99999999-9999-4999-8999-999999999999';
const RUNTIME_GENERATION_C = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PREVIEW_RUNTIME_GENERATION = '77777777-7777-4777-8777-777777777777';
const LEGACY_VOICE_BINDING: VoiceComposerBinding = { state: 'legacy_unbound' };

function voiceStatusBinding(binding: VoiceTranscriptionBindingInput): VoiceComposerBinding {
  return binding.target === 'agent'
    ? {
        state: 'agent', projectId: binding.projectId, agentId: binding.agentId,
        draftSha256: binding.draftSha256,
      }
    : { state: 'launcher', draftSha256: binding.draftSha256 };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function withControls<Client extends object, Controls extends object>(client: Client, controls: Controls) {
  Object.defineProperties(client, Object.getOwnPropertyDescriptors(controls));
  return client as Client & Controls;
}

const DeferredApprovalClient = (() => {
  const client = new PreviewDesktopClient();
  let runtimeStatus: RuntimeStatus | null = null;
  const bootstrap = client.bootstrap.bind(client);
  const readSnapshot = client.readSnapshot.bind(client);
  const approval = deferred<void>();
  const inspection = deferred<void>();
  const snapshotSpy = vi.spyOn(client, 'readSnapshot').mockImplementation(readSnapshot);
  const approvalSpy = vi.spyOn(client, 'respondToApproval').mockImplementation(() => approval.promise);
  const inspectionSpy = vi.spyOn(client, 'startInspection').mockImplementation(async () => {
    await inspection.promise;
    return 'inspection-delayed';
  });
  vi.spyOn(client, 'bootstrap').mockImplementation(async (signal) => {
    const result = await bootstrap(signal);
    runtimeStatus = result.status;
    return result;
  });
  vi.spyOn(client, 'stopRuntime').mockImplementation(async (authority) => {
    runtimeStatus = {
      lifecycle: 'Stopped', projectId: null, activationToken: null,
      rendererSessionId: authority.rendererSessionId, rendererGeneration: authority.rendererGeneration,
      runtimeGeneration: runtimeStatus?.runtimeGeneration ?? PREVIEW_RUNTIME_GENERATION,
      statusRevision: (runtimeStatus?.statusRevision ?? 12) + 1, failureReason: null,
    };
    return structuredClone(runtimeStatus);
  });
  return withControls(client, {
    get snapshotReads() { return snapshotSpy.mock.calls.length; },
    get approvalStarted() { return approvalSpy.mock.calls.length > 0; },
    get inspectionStarted() { return inspectionSpy.mock.calls.length > 0; },
    resolveApproval: () => approval.resolve(),
    resolveInspection: () => inspection.resolve(),
  });
});

const PassiveStatusClient = ((options: ConstructorParameters<typeof PreviewDesktopClient>[0] = {}) => {
  const client = new PreviewDesktopClient(options);
  const sendSpy = vi.spyOn(client, 'sendMessage').mockImplementation(async (_authority, input) => ({
    receipt: {
      dispatchId: `passive-${sendSpy.mock.calls.length}`,
      threadId: `thread-${input.targetAgentId}`,
      turnId: `turn-${sendSpy.mock.calls.length}`,
    },
    dispatchRecovery: null,
  }));
  return withControls(client, {
    get sendCalls() { return sendSpy.mock.calls.length; },
    emitStatus: (status: RuntimeStatus) => client.emitScenarioEvent({ type: 'status', status }),
  });
});

const HistoryTrackingClient = (() => {
  const client = PassiveStatusClient();
  const historyQueries: Array<string | null> = [];
  const historyPageResponses: Array<Promise<Awaited<ReturnType<PreviewDesktopClient['readHistoryPage']>>>> = [];
  const historyIndexResponses: Array<Promise<Awaited<ReturnType<PreviewDesktopClient['readHistoryIndex']>>>> = [];
  const readHistoryIndex = client.readHistoryIndex.bind(client);
  const readHistoryPage = client.readHistoryPage.bind(client);
  const indexSpy = vi.spyOn(client, 'readHistoryIndex').mockImplementation(async (...args) => (
    await (historyIndexResponses.shift() ?? readHistoryIndex(...args))
  ));
  vi.spyOn(client, 'readHistoryPage').mockImplementation(async (...args) => {
    historyQueries.push(args[2]);
    return await (historyPageResponses.shift() ?? readHistoryPage(...args));
  });
  return withControls(client, {
    historyQueries, historyPageResponses, historyIndexResponses, readHistoryPageFixture: readHistoryPage,
    get historyIndexCalls() { return indexSpy.mock.calls.length; },
  });
});

const VoiceAssetLifecycleClient = ((initialPhase: 'absent' | 'recovery_required' = 'absent') => {
  const client = PassiveStatusClient();
  let voice: VoiceStatus = {
    schemaVersion: 2,
    revision: 1,
    providerId: 'whisper.cpp-local',
    binaryAssetId: 'whisper.cpp-windows-x64-b4938-spike',
    initialModelAssetId: 'whisper.cpp-model-small-multilingual',
    comparisonModelAssetId: 'whisper.cpp-model-base-multilingual',
    requiredAssetsReady: false,
    assets: [
      {
        assetId: 'whisper.cpp-windows-x64-b4938-spike', kind: 'native_binary_bundle', phase: 'absent',
        downloadedBytes: 0, expectedBytes: 1_000, operationRef: null, lastErrorCode: null,
      },
      {
        assetId: 'whisper.cpp-model-small-multilingual', kind: 'model', phase: 'installed',
        downloadedBytes: 2_000, expectedBytes: 2_000, operationRef: null, lastErrorCode: null,
      },
      {
        assetId: 'whisper.cpp-model-base-multilingual', kind: 'model', phase: 'absent',
        downloadedBytes: 0, expectedBytes: 1_000, operationRef: null, lastErrorCode: null,
      },
    ],
    operations: [],
  };
  if (initialPhase === 'recovery_required') {
    voice = {
        ...voice,
        assets: voice.assets.map((asset) => asset.assetId === voice.binaryAssetId ? {
          ...asset,
          phase: initialPhase,
          lastErrorCode: 'voice_asset_recovery_required',
        } : asset),
    };
  }
  const bootstrap = client.bootstrap.bind(client);
  vi.spyOn(client, 'bootstrap').mockImplementation(async (signal) => ({
    ...(await bootstrap(signal)), voiceStatus: structuredClone(voice),
  }));
  vi.spyOn(client, 'readVoiceStatus').mockImplementation(async () => structuredClone(voice));
  const acquireSpy = vi.spyOn(client, 'acquireVoiceAsset').mockImplementation(async (_renderer, assetId) => {
    const installed = acquireSpy.mock.calls.length > 1;
    voice = {
      ...voice,
      revision: installed ? 4 : 2,
      requiredAssetsReady: installed,
      assets: voice.assets.map((asset) => asset.assetId === assetId ? {
        ...asset,
        phase: installed ? 'installed' as const : 'downloading' as const,
        downloadedBytes: installed ? asset.expectedBytes : 400,
        operationRef: installed ? null : '77777777-7777-4777-8777-777777777777',
        lastErrorCode: null,
      } : asset),
    };
    return structuredClone(voice);
  });
  const emitAsyncFailure = () => {
    voice = {
      ...voice,
      revision: 3,
      requiredAssetsReady: false,
      assets: voice.assets.map((asset) => asset.assetId === voice.binaryAssetId ? {
        ...asset,
        phase: 'failed' as const,
        operationRef: null,
        lastErrorCode: 'voice_asset_download_failed',
      } : asset),
    };
    client.emitScenarioEvent({ type: 'voice_status', status: structuredClone(voice) });
  };
  return withControls(client, {
    emitAsyncFailure,
    get acquireCalls() { return acquireSpy.mock.calls.length; },
  });
});

const VoiceSendTrackingClient = ((options: ConstructorParameters<typeof PreviewDesktopClient>[0] = {}) => {
  const client = new PreviewDesktopClient(options);
  const readVoiceStatus = client.readVoiceStatus.bind(client);
  const readConversation = client.readConversation.bind(client);
  const sentByAgent = new Map<string, ConversationMessage[]>();
  let voice: VoiceStatus | null = null;
  vi.spyOn(client, 'readVoiceStatus').mockImplementation(async (renderer) => (
    structuredClone(voice ?? await readVoiceStatus(renderer))
  ));
  const transcribeSpy = vi.spyOn(client, 'transcribeVoicePcm').mockImplementation(async (
    renderer, operationRef, binding, _pcm, sampleCount,
  ) => {
    const baseline = await readVoiceStatus(renderer);
    const operation: VoiceOperationStatus = {
      operationRef, composerBinding: voiceStatusBinding(binding), phase: 'transcribed',
      durationMs: Math.round(sampleCount / 16), transcript: 'プレビュー音声入力', lastErrorCode: null,
    };
    voice = { ...baseline, revision: baseline.revision + 1, operations: [operation] };
    return structuredClone(operation);
  });
  const sendSpy = vi.spyOn(client, 'sendMessage').mockImplementation(async (_authority, input) => ({
    receipt: {
      dispatchId: `preview-${sendSpy.mock.calls.length}`,
      threadId: `thread-${input.targetAgentId}`,
      turnId: `turn-${sendSpy.mock.calls.length}`,
    },
    dispatchRecovery: null,
  }));
  sendSpy.mockImplementation(async (_authority, input) => {
    const sent = sentByAgent.get(input.targetAgentId) ?? [];
    sent.push({
      id: `sent-${sent.length + 1}`, role: 'user', targetAgentId: input.targetAgentId,
      authorLabel: 'YOU', text: input.text, createdAt: `2026-08-29T00:00:0${sent.length}.000Z`, evidenceLabel: null,
    });
    sentByAgent.set(input.targetAgentId, sent);
    return {
      receipt: {
        dispatchId: `preview-${sendSpy.mock.calls.length}`,
        threadId: `thread-${input.targetAgentId}`,
        turnId: `turn-${sendSpy.mock.calls.length}`,
      },
      dispatchRecovery: null,
    };
  });
  vi.spyOn(client, 'readConversation').mockImplementation(async (...args) => {
    const page = await readConversation(...args);
    return { ...page, items: [...page.items, ...structuredClone(sentByAgent.get(args[1]) ?? [])] };
  });
  const ackSpy = vi.spyOn(client, 'acknowledgeVoiceTranscription').mockImplementation(async (renderer, operationRef) => {
    const baseline = voice ?? await readVoiceStatus(renderer);
    voice = {
      ...baseline, revision: baseline.revision + 1,
      operations: baseline.operations.filter((operation) => operation.operationRef !== operationRef),
    };
    return structuredClone(voice);
  });
  return withControls(client, {
    get sendCalls() { return sendSpy.mock.calls.length; },
    get ackCalls() { return ackSpy.mock.calls.length; },
    get transcribeCalls() { return transcribeSpy.mock.calls.length; },
  });
});

const VoiceRecoveryTranscriptClient = ((recoveredAtBootstrap = false) => {
  const client = PassiveStatusClient();
  let voice: VoiceStatus | null = null;
  let activeProject = previewProjects[0];
  let runtimeStatus: RuntimeStatus | null = null;
  const operation = (operationRef: string, phase: 'recovery_required' | 'transcribed'): VoiceOperationStatus => ({
    operationRef, composerBinding: LEGACY_VOICE_BINDING, phase, durationMs: 100,
    transcript: '復旧された音声入力',
    lastErrorCode: phase === 'recovery_required' ? 'voice_cleanup_recovery_required' : null,
  });
  const bootstrapFixture = client.bootstrap.bind(client);
  const readVoiceFixture = client.readVoiceStatus.bind(client);
  vi.spyOn(client, 'bootstrap').mockImplementation(async (signal) => {
    const bootstrap = await bootstrapFixture(signal);
    runtimeStatus = bootstrap.status;
    if (recoveredAtBootstrap && !voice) {
      voice = {
        ...bootstrap.voiceStatus, revision: bootstrap.voiceStatus.revision + 1,
        operations: [operation('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'recovery_required')],
      };
    }
    return { ...bootstrap, voiceStatus: structuredClone(voice ?? bootstrap.voiceStatus) };
  });
  vi.spyOn(client, 'stopRuntime').mockImplementation(async (authority) => {
    runtimeStatus = {
      lifecycle: 'Stopped', projectId: null, activationToken: null,
      rendererSessionId: authority.rendererSessionId, rendererGeneration: authority.rendererGeneration,
      runtimeGeneration: runtimeStatus?.runtimeGeneration ?? PREVIEW_RUNTIME_GENERATION,
      statusRevision: (runtimeStatus?.statusRevision ?? 12) + 1, failureReason: null,
    };
    return structuredClone(runtimeStatus);
  });
  vi.spyOn(client, 'activateProject').mockImplementation(async (project, renderer, expectedStatusRevision) => {
    activeProject = project;
    runtimeStatus = {
      lifecycle: 'Ready', projectId: project.id, activationToken: `preview-${project.id}`,
      rendererSessionId: renderer.rendererSessionId, rendererGeneration: renderer.rendererGeneration,
      runtimeGeneration: runtimeStatus?.runtimeGeneration ?? PREVIEW_RUNTIME_GENERATION,
      statusRevision: expectedStatusRevision + 1, failureReason: null,
    };
    return structuredClone(runtimeStatus);
  });
  vi.spyOn(client, 'readSnapshot').mockImplementation(async () => ({
    ...structuredClone(previewSnapshot),
    project: { ...structuredClone(previewSnapshot.project), ...structuredClone(activeProject) },
  }));
  vi.spyOn(client, 'createStarterProject').mockImplementation(async (_renderer, input) => ({
    ...structuredClone(previewProjects[1]), title: input.projectName, creationOperationRef: input.operationRef,
  }));
  vi.spyOn(client, 'chooseProjectFolder').mockResolvedValue({
    selectionRef: '44444444-4444-4444-8444-444444444444',
    rootPath: previewProjects[1].rootPath,
    suggestedName: previewProjects[1].title,
  });
  vi.spyOn(client, 'openProjectFolder').mockResolvedValue(structuredClone(previewProjects[1]));
  vi.spyOn(client, 'readVoiceStatus').mockImplementation(async (renderer) => (
    structuredClone(voice ?? await readVoiceFixture(renderer))
  ));
  vi.spyOn(client, 'transcribeVoicePcm').mockImplementation(async (renderer, operationRef, binding) => {
    const baseline = await readVoiceFixture(renderer);
    const nextOperation = { ...operation(operationRef, 'recovery_required'), composerBinding: voiceStatusBinding(binding) };
    voice = { ...baseline, revision: baseline.revision + 1, operations: [nextOperation] };
    client.emitScenarioEvent({ type: 'voice_status', status: structuredClone(voice) });
    return structuredClone(nextOperation);
  });
  const resolveSafeRecovery = () => {
    if (!voice) throw new Error('voice recovery fixture is not initialized');
    voice = {
      ...voice, revision: voice.revision + 1,
      operations: voice.operations.map((candidate) => ({
        ...candidate, phase: 'transcribed' as const, lastErrorCode: null,
      })),
    };
    client.emitScenarioEvent({ type: 'voice_status', status: structuredClone(voice) });
  };
  const ackSpy = vi.spyOn(client, 'acknowledgeVoiceTranscription').mockImplementation(async (_renderer, operationRef) => {
    if (!voice) throw new Error('voice recovery fixture is not initialized');
    const currentOperation = voice.operations.find((candidate) => candidate.operationRef === operationRef);
    if (currentOperation?.phase === 'recovery_required') throw new Error('recovery operation is not acknowledgeable');
    voice = {
      ...voice, revision: voice.revision + 1,
      operations: voice.operations.filter((candidate) => candidate.operationRef !== operationRef),
    };
    client.emitScenarioEvent({ type: 'voice_status', status: structuredClone(voice) });
    return structuredClone(voice);
  });
  return withControls(client, {
    resolveSafeRecovery,
    get ackCalls() { return ackSpy.mock.calls.length; },
  });
});

const VoiceCancellationClient = ((responseLoss = false) => {
  const client = new PreviewDesktopClient();
  const cancelResult = deferred<VoiceStatus>();
  const readVoiceFixture = client.readVoiceStatus.bind(client);
  let status: VoiceStatus | null = null;
  vi.spyOn(client, 'transcribeVoicePcm').mockImplementation(async (renderer, operationRef, binding) => {
    status = {
      ...(await readVoiceFixture(renderer)), revision: 2,
      operations: [{ operationRef, composerBinding: voiceStatusBinding(binding), phase: 'transcribing', durationMs: 100, transcript: null, lastErrorCode: null }],
    };
    return { operationRef, composerBinding: voiceStatusBinding(binding), phase: 'staging', durationMs: 100, transcript: null, lastErrorCode: null };
  });
  vi.spyOn(client, 'readVoiceStatus').mockImplementation(async (renderer) => (
    status ? structuredClone(status) : readVoiceFixture(renderer)
  ));
  const cancelSpy = vi.spyOn(client, 'cancelVoiceTranscription').mockImplementation(async (renderer, operationRef) => {
    const cancelled: VoiceStatus = {
      ...(await readVoiceFixture(renderer)), revision: 3,
      operations: [{ operationRef, composerBinding: status!.operations[0].composerBinding, phase: 'cancelled', durationMs: 100, transcript: null, lastErrorCode: null }],
    };
    if (responseLoss) {
      status = cancelled;
      throw { message: 'cancel response outcome unknown', outcomeUnknown: true };
    }
    return cancelResult.promise;
  });
  vi.spyOn(client, 'acknowledgeVoiceTranscription').mockImplementation(async (renderer, operationRef) => {
    const baseline = status ?? await readVoiceFixture(renderer);
    status = {
      ...baseline, revision: baseline.revision + 1,
      operations: baseline.operations.filter((candidate) => candidate.operationRef !== operationRef),
    };
    return structuredClone(status);
  });
  const resolveCancel = (operationRef: string) => {
    if (!status?.operations[0]) throw new Error('Voice cancellation was not started.');
    status = {
      ...status,
      revision: 3,
      operations: [{ operationRef, composerBinding: status.operations[0].composerBinding, phase: 'cancelled', durationMs: 100, transcript: null, lastErrorCode: null }],
    };
    cancelResult.resolve(structuredClone(status));
  };
  return withControls(client, {
    cancelResult, resolveCancel,
    get cancelCalls() { return cancelSpy.mock.calls.length; },
  });
});

const VoiceDurableTerminalWatcherClient = ((
  initialTerminalAfterRead: number | null = 2,
  cancelResponseNeverSettles = false,
) => {
  const client = PassiveStatusClient();
  const readVoiceFixture = client.readVoiceStatus.bind(client);
  let status: VoiceStatus | null = null;
  let terminalAfterRead = initialTerminalAfterRead;
  let cancelTerminalAfterRead: number | null = null;
  vi.spyOn(client, 'transcribeVoicePcm').mockImplementation(async (renderer, operationRef, binding) => {
    const baseline = await readVoiceFixture(renderer);
    status = {
      ...baseline, revision: baseline.revision + 1,
      operations: [{ operationRef, composerBinding: voiceStatusBinding(binding), phase: 'transcribing', durationMs: 100, transcript: null, lastErrorCode: null }],
    };
    return { operationRef, composerBinding: voiceStatusBinding(binding), phase: 'staging', durationMs: 100, transcript: null, lastErrorCode: null };
  });
  const readSpy = vi.spyOn(client, 'readVoiceStatus').mockImplementation(async (renderer) => {
    const baseline = await readVoiceFixture(renderer);
    const terminalRead = cancelTerminalAfterRead ?? terminalAfterRead;
    if (status && terminalRead !== null && readSpy.mock.calls.length >= terminalRead) {
      status = {
        ...status, revision: status.revision + 1,
        operations: status.operations.map((candidate) => ({
          ...candidate,
          phase: cancelTerminalAfterRead === null ? 'transcribed' as const : 'cancelled' as const,
          transcript: cancelTerminalAfterRead === null ? 'イベントなしで完了した音声入力' : null,
        })),
      };
      terminalAfterRead = null;
      cancelTerminalAfterRead = null;
    }
    return structuredClone(status ?? baseline);
  });
  const cancelSpy = vi.spyOn(client, 'cancelVoiceTranscription').mockImplementation(async (renderer, operationRef) => {
    cancelTerminalAfterRead = readSpy.mock.calls.length + 1;
    if (cancelResponseNeverSettles) return new Promise<VoiceStatus>(() => undefined);
    const baseline = status ?? await readVoiceFixture(renderer);
    return structuredClone(status ?? {
      ...baseline,
      operations: [{ operationRef, composerBinding: LEGACY_VOICE_BINDING, phase: 'transcribing', durationMs: 100, transcript: null, lastErrorCode: null }],
    });
  });
  vi.spyOn(client, 'acknowledgeVoiceTranscription').mockImplementation(async (renderer, operationRef) => {
    const baseline = status ?? await readVoiceFixture(renderer);
    status = {
      ...baseline, revision: baseline.revision + 1,
      operations: baseline.operations.filter((candidate) => candidate.operationRef !== operationRef),
    };
    return structuredClone(status);
  });
  return withControls(client, {
    get voiceStatusReads() { return readSpy.mock.calls.length; },
    get cancelCalls() { return cancelSpy.mock.calls.length; },
  });
});

function imageFile(name = 'evidence.png'): File {
  return new File([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], name, { type: 'image/png' });
}

const DeferredActivationClient = (() => {
  const client = PassiveStatusClient();
  const activation = deferred<RuntimeStatus>();
  vi.spyOn(client, 'stopRuntime').mockImplementation(async (authority) => ({
    lifecycle: 'Stopped', projectId: null, activationToken: null,
    rendererSessionId: authority.rendererSessionId, rendererGeneration: authority.rendererGeneration,
    runtimeGeneration: PREVIEW_RUNTIME_GENERATION, statusRevision: 9, failureReason: null,
  }));
  vi.spyOn(client, 'activateProject').mockImplementation(() => activation.promise);
  vi.spyOn(client, 'readSnapshot').mockImplementation(async (authority) => {
    const project = previewProjects.find((candidate) => candidate.id === authority.projectId)!;
    const snapshot = structuredClone(previewSnapshot);
    return { ...snapshot, project: { ...snapshot.project, ...project } };
  });
  vi.spyOn(client, 'readConversation').mockImplementation(async (authority, targetAgentId) => ({
      source: 'sqlite',
      projectId: authority.projectId,
      targetAgentId,
      streamId: `test-stream-${authority.projectId}`,
      appliedJournalSequence: 0,
      projectionRevision: 0,
      syncState: 'current',
      items: [],
      activities: [],
      olderCursor: null,
      activityOlderCursor: null,
      pendingRequestOlderCursor: null,
      pendingRequests: [],
      resolvedRequests: [],
      activeTurns: [],
      latestTurn: null,
  }));
  return withControls(client, { activation });
});

const DeferredProjectBootstrapClient = (() => {
  const client = PassiveStatusClient();
  const bootstrapGate = deferred<void>();
  const snapshotGate = deferred<void>();
  const controls = { failNextBootstrap: false, failNextSnapshot: false, blockSnapshot: false };
  const bootstrapFixture = client.bootstrap.bind(client);
  const snapshotFixture = client.readSnapshot.bind(client);
  let activeProject = previewProjects[0];
  let activeStatus: RuntimeStatus | null = null;
  vi.spyOn(client, 'bootstrap').mockImplementation(async (signal) => {
    const bootstrap = await bootstrapFixture(signal);
    return {
      ...bootstrap,
      selectedProjectId: null,
      status: {
        ...bootstrap.status,
        lifecycle: 'Stopped' as const,
        projectId: null,
        activationToken: null,
      },
      snapshot: null,
    };
  });
  vi.spyOn(client, 'activateProject').mockImplementation(async (project, renderer, expectedStatusRevision) => {
    activeProject = project;
    activeStatus = {
      lifecycle: 'Ready', projectId: project.id, activationToken: `preview-${project.id}`,
      rendererSessionId: renderer.rendererSessionId, rendererGeneration: renderer.rendererGeneration,
      runtimeGeneration: PREVIEW_RUNTIME_GENERATION,
      statusRevision: expectedStatusRevision + 1, failureReason: null,
    };
    return structuredClone(activeStatus);
  });
  const bootstrapSpy = vi.spyOn(client, 'bootstrapProject').mockImplementation(async (authority) => {
    const status = activeStatus ?? await client.refreshStatus(authority);
    activeStatus = { ...status, statusRevision: status.statusRevision + 1 };
    client.emitStatus(activeStatus);
    if (controls.failNextBootstrap) {
      controls.failNextBootstrap = false;
      throw new Error('injected project bootstrap failure');
    }
    await bootstrapGate.promise;
    return { status: 'ready', noWrite: true, reason: null };
  });
  const snapshotSpy = vi.spyOn(client, 'readSnapshot').mockImplementation(async (authority) => {
    if (controls.failNextSnapshot) {
      controls.failNextSnapshot = false;
      throw new Error('injected project snapshot failure');
    }
    if (controls.blockSnapshot) await snapshotGate.promise;
    const snapshot = await snapshotFixture(authority);
    return {
      ...snapshot,
      project: { ...snapshot.project, ...structuredClone(activeProject) },
    };
  });
  return withControls(client, {
    bootstrapGate, snapshotGate,
    get bootstrapCalls() { return bootstrapSpy.mock.calls.length; },
    get snapshotReads() { return snapshotSpy.mock.calls.length; },
    get failNextBootstrap() { return controls.failNextBootstrap; },
    set failNextBootstrap(value: boolean) { controls.failNextBootstrap = value; },
    get failNextSnapshot() { return controls.failNextSnapshot; },
    set failNextSnapshot(value: boolean) { controls.failNextSnapshot = value; },
    get blockSnapshot() { return controls.blockSnapshot; },
    set blockSnapshot(value: boolean) { controls.blockSnapshot = value; },
  });
});

const ActiveTurnClient = (() => {
  const client = new PreviewDesktopClient();
  const activeByAgent = new Map<string, Array<{
    threadId: string;
    turnId: string;
    targetAgentId: string;
    state: 'accepted' | 'in_progress' | 'interrupting';
    lastJournalSequence: number;
  }>>();
  const latestByAgent = new Map<string, {
    threadId: string;
    turnId: string;
    targetAgentId: string;
    state: 'accepted' | 'in_progress' | 'interrupting' | 'completed' | 'failed' | 'interrupted' | 'cancelled';
    lastJournalSequence: number;
  }>();
  const interruptCalls: Array<{ targetAgentId: string; threadId: string; turnId: string }> = [];
  const steerCalls: Array<{ steerId: string; targetAgentId: string; threadId: string; turnId: string; text: string }> = [];
  const sendCalls: Array<{ targetAgentId: string; text: string; attachmentRefs: Array<{ selectionId: string; publicId: string }> }> = [];
  const controls: {
    interruptResult: Promise<void> | null; interruptFailure: unknown;
    steerResult: Promise<void> | null; steerFailure: unknown;
  } = { interruptResult: null, interruptFailure: null, steerResult: null, steerFailure: null };
  const readConversation = client.readConversation.bind(client);
  vi.spyOn(client, 'readConversation').mockImplementation(async (authority, targetAgentId, checkpoint, cursor, activityCursor) => {
    const page = await readConversation(authority, targetAgentId, checkpoint, cursor, activityCursor);
    return {
      ...page,
      activeTurns: structuredClone(activeByAgent.get(targetAgentId) ?? []),
      latestTurn: structuredClone(latestByAgent.get(targetAgentId) ?? null),
    };
  });
  vi.spyOn(client, 'interruptTurn').mockImplementation(async (_authority, input) => {
    interruptCalls.push(input);
    if (controls.interruptFailure) throw controls.interruptFailure;
    return controls.interruptResult ?? Promise.resolve();
  });
  vi.spyOn(client, 'steerTurn').mockImplementation(async (_authority, input) => {
    steerCalls.push(input);
    if (controls.steerFailure) throw controls.steerFailure;
    return controls.steerResult ?? Promise.resolve();
  });
  vi.spyOn(client, 'sendMessage').mockImplementation(async (_authority, input) => {
    sendCalls.push(structuredClone(input));
    return {
      receipt: {
        dispatchId: `preview-${sendCalls.length}`,
        threadId: `thread-${input.targetAgentId}`,
        turnId: `turn-${sendCalls.length}`,
      },
      dispatchRecovery: null,
    };
  });
  return withControls(client, {
    activeByAgent, latestByAgent, interruptCalls, steerCalls, sendCalls,
    get interruptResult() { return controls.interruptResult; },
    set interruptResult(value: Promise<void> | null) { controls.interruptResult = value; },
    get interruptFailure() { return controls.interruptFailure; },
    set interruptFailure(value: unknown) { controls.interruptFailure = value; },
    get steerResult() { return controls.steerResult; },
    set steerResult(value: Promise<void> | null) { controls.steerResult = value; },
    get steerFailure() { return controls.steerFailure; },
    set steerFailure(value: unknown) { controls.steerFailure = value; },
  });
});

const AttachmentClient = (() => {
  const client = ActiveTurnClient();
  const importCalls: Array<{ selectionId: string; fileNames: string[] }> = [];
  const forgetCalls: Array<{ selectionId: string; attachmentId: string }> = [];
  const abandonCalls: string[] = [];
  const controls: {
    importResult: Promise<Awaited<ReturnType<PreviewDesktopClient['importAttachments']>>> | null;
    forgetResult: Promise<void> | null; forgetFailure: unknown; sendResult: Promise<DispatchSendResult> | null;
  } = { importResult: null, forgetResult: null, forgetFailure: null, sendResult: null };
  vi.spyOn(client, 'importAttachments').mockImplementation(async (_authority, selectionId, files) => {
    importCalls.push({ selectionId, fileNames: files.map((file) => file.name) });
    return controls.importResult ?? Promise.resolve([
      { id: '55555555-5555-4555-8555-555555555555', selectionId, name: 'first.png', kind: 'image', mediaType: 'image/png', sizeBytes: 120 },
      { id: '66666666-6666-4666-8666-666666666666', selectionId, name: 'second.png', kind: 'image', mediaType: 'image/png', sizeBytes: 240 },
    ]);
  });
  vi.spyOn(client, 'forgetAttachment').mockImplementation(async (_authority, selectionId, attachmentId) => {
    forgetCalls.push({ selectionId, attachmentId });
    if (controls.forgetFailure) throw controls.forgetFailure;
    return controls.forgetResult ?? Promise.resolve();
  });
  vi.spyOn(client, 'abandonAttachmentSelection').mockImplementation(async (_authority, selectionId) => {
    if (!selectionId) throw new Error('selectionId is required');
    abandonCalls.push(selectionId);
  });
  const sendMessage = vi.mocked(client.sendMessage).getMockImplementation()!;
  vi.spyOn(client, 'sendMessage').mockImplementation(async (...args) => (
    controls.sendResult ?? sendMessage(...args)
  ));
  return withControls(client, {
    importCalls, forgetCalls, abandonCalls,
    get importResult() { return controls.importResult; },
    set importResult(value: typeof controls.importResult) { controls.importResult = value; },
    get forgetResult() { return controls.forgetResult; },
    set forgetResult(value: Promise<void> | null) { controls.forgetResult = value; },
    get forgetFailure() { return controls.forgetFailure; },
    set forgetFailure(value: unknown) { controls.forgetFailure = value; },
    get sendResult() { return controls.sendResult; },
    set sendResult(value: Promise<DispatchSendResult> | null) { controls.sendResult = value; },
  });
});

const ResetBaselineFailureClient = (() => {
  const client = new PreviewDesktopClient();
  let resetThenFail = false;
  const readConversation = client.readConversation.bind(client);
  vi.spyOn(client, 'readConversation').mockImplementation(async (authority, targetAgentId, checkpoint, cursor, activityCursor) => {
    if (!resetThenFail) return readConversation(authority, targetAgentId, checkpoint, cursor, activityCursor);
    if (checkpoint.streamId === null) throw new Error('baseline unavailable');
    const page = await readConversation(authority, targetAgentId, checkpoint, cursor, activityCursor);
    return { ...page, streamId: 'replacement-stream', syncState: 'stream_reset' as const };
  });
  return withControls(client, {
    get resetThenFail() { return resetThenFail; },
    set resetThenFail(value: boolean) { resetThenFail = value; },
  });
});

const BootstrapSwitchClient = (() => {
  const client = new PreviewDesktopClient();
  const operations: string[] = [];
  let activeProject = previewProjects[0];
  let statusRevision = 12;
  vi.spyOn(client, 'stopRuntime').mockImplementation(async (authority) => {
    operations.push('stop');
    const status: RuntimeStatus = {
      lifecycle: 'Stopped', projectId: null, activationToken: null,
      rendererSessionId: authority.rendererSessionId, rendererGeneration: authority.rendererGeneration,
      runtimeGeneration: PREVIEW_RUNTIME_GENERATION, statusRevision: ++statusRevision, failureReason: null,
    };
    return status;
  });
  vi.spyOn(client, 'activateProject').mockImplementation(async (project, renderer, expectedStatusRevision) => {
    operations.push(`activate:${project.id}`);
    activeProject = project;
    const status: RuntimeStatus = {
      lifecycle: 'Ready', projectId: project.id, activationToken: `preview-${project.id}`,
      rendererSessionId: renderer.rendererSessionId, rendererGeneration: renderer.rendererGeneration,
      runtimeGeneration: PREVIEW_RUNTIME_GENERATION,
      statusRevision: statusRevision = Math.max(statusRevision, expectedStatusRevision) + 1,
      failureReason: null,
    };
    return status;
  });
  vi.spyOn(client, 'readSnapshot').mockImplementation(async () => ({
    ...structuredClone(previewSnapshot),
    project: { ...structuredClone(previewSnapshot.project), ...structuredClone(activeProject) },
  }));
  return withControls(client, { operations });
});

const NamedProjectClient = ((options: ConstructorParameters<typeof PreviewDesktopClient>[0] = {}) => {
  const client = LauncherWithProjectsClient(undefined, options);
  const createStarterProject = vi.mocked(client.createStarterProject).getMockImplementation()!;
  let chosenTitle: string | undefined;
  vi.spyOn(client, 'createStarterProject').mockImplementation(async (...args) => {
    chosenTitle = args[1].projectName;
    return createStarterProject(...args);
  });
  return withControls(client, { get chosenTitle() { return chosenTitle; } });
});

const LauncherWithProjectsClient = ((
  resumeHint?: string | null,
  options: ConstructorParameters<typeof PreviewDesktopClient>[0] = {},
) => {
  const client = VoiceSendTrackingClient(options);
  const conversationReads: string[] = [];
  const recordedAgents: string[] = [];
  let activeProject = previewProjects[0];
  let runtimeStatus: RuntimeStatus | null = null;
  const bootstrapFixture = client.bootstrap.bind(client);
  const readConversation = vi.mocked(client.readConversation).getMockImplementation()!;
  vi.spyOn(client, 'bootstrap').mockImplementation(async (signal) => {
    const bootstrap = await bootstrapFixture(signal);
    runtimeStatus = {
      ...bootstrap.status, lifecycle: 'Stopped' as const,
      projectId: null, activationToken: null,
    };
    return {
      ...bootstrap,
      projects: resumeHint === undefined ? bootstrap.projects : bootstrap.projects.map((project, index) => index === 0
        ? { ...project, lastWorkAgentId: resumeHint }
        : project),
      selectedProjectId: null,
      status: structuredClone(runtimeStatus),
      snapshot: null,
    };
  });
  vi.spyOn(client, 'readConversation').mockImplementation((authority, targetAgentId, checkpoint, cursor, activityCursor) => {
    conversationReads.push(targetAgentId);
    return readConversation(authority, targetAgentId, checkpoint, cursor, activityCursor);
  });
  vi.spyOn(client, 'recordLastWorkAgent').mockImplementation(async (_authority, targetAgentId) => {
    recordedAgents.push(targetAgentId);
    return { ...structuredClone(activeProject), lastWorkAgentId: targetAgentId };
  });
  vi.spyOn(client, 'stopRuntime').mockImplementation(async (authority) => {
    runtimeStatus = {
      lifecycle: 'Stopped', projectId: null, activationToken: null,
      rendererSessionId: authority.rendererSessionId, rendererGeneration: authority.rendererGeneration,
      runtimeGeneration: runtimeStatus?.runtimeGeneration ?? PREVIEW_RUNTIME_GENERATION,
      statusRevision: (runtimeStatus?.statusRevision ?? 8) + 1, failureReason: null,
    };
    return structuredClone(runtimeStatus);
  });
  vi.spyOn(client, 'activateProject').mockImplementation(async (project, renderer, expectedStatusRevision) => {
    activeProject = project;
    runtimeStatus = {
      lifecycle: 'Ready', projectId: project.id, activationToken: `preview-${project.id}`,
      rendererSessionId: renderer.rendererSessionId, rendererGeneration: renderer.rendererGeneration,
      runtimeGeneration: runtimeStatus?.runtimeGeneration ?? PREVIEW_RUNTIME_GENERATION,
      statusRevision: expectedStatusRevision + 1, failureReason: null,
    };
    return structuredClone(runtimeStatus);
  });
  vi.spyOn(client, 'readSnapshot').mockImplementation(async () => ({
    ...structuredClone(previewSnapshot),
    project: { ...structuredClone(previewSnapshot.project), ...structuredClone(activeProject) },
  }));
  vi.spyOn(client, 'createStarterProject').mockImplementation(async (_renderer, input) => ({
    ...structuredClone(previewProjects[1]), title: input.projectName, creationOperationRef: input.operationRef,
  }));
  vi.spyOn(client, 'chooseProjectFolder').mockResolvedValue({
    selectionRef: '44444444-4444-4444-8444-444444444444',
    rootPath: previewProjects[1].rootPath,
    suggestedName: previewProjects[1].title,
  });
  vi.spyOn(client, 'openProjectFolder').mockResolvedValue(structuredClone(previewProjects[1]));
  return withControls(client, { conversationReads, recordedAgents });
});

describe('ApplicationStore authority boundaries', () => {
  test('loads the live model catalog and enables runtime choices before a project is selected', async () => {
    const client = new PreviewDesktopClient({ state: 'empty' });
    const previewCatalog = await client.readComposerRuntimeOptions({
      rendererSessionId: 'preview-renderer', rendererGeneration: 1,
    });
    const catalog = vi.spyOn(client, 'readComposerRuntimeOptions').mockResolvedValue({
      models: previewCatalog.models.map((model) => ({ ...model, serviceTiers: [] })),
    });
    const store = new ApplicationStore(client);

    await store.initialize();
    expect(catalog).toHaveBeenCalledWith({
      rendererSessionId: 'preview-renderer', rendererGeneration: 1,
    });
    expect(store.getState()).toMatchObject({
      phase: 'launcher',
      runtimeAuthority: null,
      runtimeModelsLoading: false,
      composerModelId: 'gpt-5.6-sol',
      composerReasoningEffort: 'xhigh',
      composerAccessMode: 'full_access',
    });

    store.selectComposerModel('gpt-5.6-terra');
    store.selectComposerReasoningEffort('medium');
    store.setComposerAccessMode('approval_required');
    store.setComposerServiceTier('fast');
    store.selectComposerModel('gpt-5.6-sol');
    expect(store.getState()).toMatchObject({
      composerModelId: 'gpt-5.6-sol',
      composerAccessMode: 'approval_required',
      composerServiceTier: 'fast',
    });
    expect(store.getState().runtimeModels.every((model) => model.serviceTiers.length === 0)).toBe(true);
    await store.dispose();
  });

  test('keeps renderer-scoped project refresh valid across a same-renderer runtime revision', async () => {
    const client = PassiveStatusClient();
    const projectList = deferred<ProjectSummary[]>();
    const listSpy = vi.spyOn(client, 'listProjects').mockImplementation(() => projectList.promise);
    const store = new ApplicationStore(client);
    await store.initialize();
    const refreshing = store.refreshProjects();
    await waitFor(() => expect(listSpy).toHaveBeenCalled());

    const current = store.getState().runtimeStatus!;
    client.emitStatus({ ...current, statusRevision: current.statusRevision + 1 });
    const added = { ...structuredClone(previewProjects[1]), id: 'renderer-scope-proof' };
    projectList.resolve([...previewProjects, added]);
    await refreshing;

    expect(store.getState().projects).toContainEqual(expect.objectContaining({ id: added.id }));
    await store.dispose();
  });

  test('archives and restores only an inactive project while keeping the active project protected', async () => {
    const client = PassiveStatusClient();
    const archive = vi.spyOn(client, 'archiveProject').mockResolvedValue({
      projects: [structuredClone(previewProjects[0])],
      archivedProjects: [structuredClone(previewProjects[1])],
    });
    const restore = vi.spyOn(client, 'restoreArchivedProject').mockResolvedValue({
      projects: structuredClone(previewProjects),
      archivedProjects: [],
    });
    const store = new ApplicationStore(client);
    await store.initialize();

    await expect(store.archiveProject(previewProjects[1].id)).resolves.toBe(true);
    expect(archive).toHaveBeenCalledWith(
      store.getState().rendererAuthority,
      previewProjects[1].id,
    );
    expect(store.getState().projects.map((project) => project.id)).toEqual([previewProjects[0].id]);
    expect(store.getState().archivedProjects.map((project) => project.id)).toEqual([previewProjects[1].id]);
    await expect(store.restoreArchivedProject(previewProjects[1].id)).resolves.toBe(true);
    expect(restore).toHaveBeenCalledWith(store.getState().rendererAuthority, previewProjects[1].id);
    expect(store.getState().projects.map((project) => project.id)).toEqual(previewProjects.map((project) => project.id));
    expect(store.getState().archivedProjects).toEqual([]);
    await expect(store.archiveProject(previewProjects[0].id)).resolves.toBe(false);
    expect(archive).toHaveBeenCalledTimes(1);
    await store.dispose();
  });

  test('keeps a stopped registry selection available for explicit reactivation', async () => {
    const client = new PreviewDesktopClient();
    const bootstrapFixture = client.bootstrap.bind(client);
    vi.spyOn(client, 'bootstrap').mockImplementation(async (signal) => {
      const bootstrap = await bootstrapFixture(signal);
      return {
        ...bootstrap,
        selectedProjectId: bootstrap.projects[0]?.id ?? null,
        status: {
          ...bootstrap.status,
          lifecycle: 'Stopped' as const,
          projectId: null,
          activationToken: null,
        },
        snapshot: null,
      };
    });

    const store = new ApplicationStore(client);
    await store.initialize();

    expect(store.getState()).toMatchObject({
      phase: 'launcher', selectedProjectId: null, runtimeAuthority: null,
    });
    expect(store.getState().projects).not.toHaveLength(0);
    await store.dispose();
  });

  test.each([
    ['frontend', 'frontend'],
    ['missing-agent', 'orchestrator'],
  ])('explicitly resumes a stopped project at its validated last-WORK target (%s)', async (hint, expectedAgentId) => {
    const client = LauncherWithProjectsClient(hint);
    const store = new ApplicationStore(client);
    await store.initialize();

    await expect(store.selectProject(previewProjects[0].id)).resolves.toBe(true);
    expect(store.getState()).toMatchObject({
      phase: 'workspace', selectedAgentId: expectedAgentId,
      projectBootstrap: { status: 'ready' }, error: null,
    });
    await waitFor(() => expect(client.conversationReads).toContain(expectedAgentId));
    expect(client.recordedAgents).toEqual([]);
    await store.dispose();
  });

  test('finishes preparation when bootstrap already includes the active project snapshot', async () => {
    const store = new ApplicationStore(new PreviewDesktopClient());
    await store.initialize();

    expect(store.getState()).toMatchObject({
      phase: 'workspace', projectStartPending: false,
      projectBootstrap: { status: 'ready' },
      selectedAgentId: 'orchestrator',
    });
    await store.dispose();
  });

  test('keeps project preparation authoritative during first-run settings migration', async () => {
    const store = new ApplicationStore(new PreviewDesktopClient());
    const initializing = store.initialize();
    await waitFor(() => expect(store.getState().settings).not.toBeNull());
    const settings = store.getState().settings!;
    await store.updateSettings({
      locale: 'en', theme: settings.theme, reducedMotion: settings.reducedMotion,
      notificationsEnabled: settings.notificationsEnabled,
      navigationCompact: settings.navigationCompact, workLedgerOpen: settings.workLedgerOpen,
    });
    await initializing;

    expect(store.getState()).toMatchObject({
      phase: 'workspace', projectStartPending: false,
      projectBootstrap: { status: 'ready' },
    });
    await store.dispose();
  });

  test('starts an uninitialized folder without exposing a setup step', async () => {
    const client = new PreviewDesktopClient();
    let current: WorkspaceSnapshot = {
      ...structuredClone(previewSnapshot),
      project: { ...structuredClone(previewSnapshot.project), agentCount: 0, provenWorkingAgentCount: 0 },
      agents: [], tasks: [], attention: [], phases: [], inspectionRuns: [],
    };
    const bootstrap = client.bootstrap.bind(client);
    vi.spyOn(client, 'bootstrap').mockImplementation(async (signal) => ({
      ...await bootstrap(signal), snapshot: structuredClone(current),
    }));
    vi.spyOn(client, 'readSnapshot').mockImplementation(async () => structuredClone(current));
    const bootstrapSpy = vi.spyOn(client, 'bootstrapProject').mockImplementation(async () => {
      current = { ...current, agents: structuredClone(previewSnapshot.agents.filter(
        (agent) => ['orchestrator', 'orquesta-admin', 'user-support'].includes(agent.id),
      )) };
      return { status: 'ready', noWrite: false, reason: null };
    });
    const store = new ApplicationStore(client);
    await store.initialize();

    expect(bootstrapSpy).toHaveBeenCalledOnce();
    expect(store.getState()).toMatchObject({
      phase: 'workspace', projectStartPending: false, selectedAgentId: 'orchestrator',
      snapshot: { agents: expect.arrayContaining([expect.objectContaining({ id: 'orchestrator' })]) },
    });
    await store.dispose();
  });

  test('commits completed project bootstrap after a normal same-runtime status revision advance', async () => {
    const client = PassiveStatusClient({ state: 'uninitialized' });
    let bootstrapped = false;
    const readSnapshot = client.readSnapshot.bind(client);
    vi.spyOn(client, 'readSnapshot').mockImplementation(async (authority) =>
      bootstrapped ? structuredClone(previewSnapshot) : readSnapshot(authority));
    vi.spyOn(client, 'bootstrapProject').mockImplementation(async (authority) => {
      const status = await client.refreshStatus(authority);
      bootstrapped = true;
      client.emitStatus({ ...status, statusRevision: status.statusRevision + 1 });
      client.emitScenarioEvent({ type: 'snapshot', snapshot: structuredClone(previewSnapshot) });
      return { status: 'ready', noWrite: true, reason: null };
    });
    const store = new ApplicationStore(client);
    await store.initialize();

    expect(store.getState()).toMatchObject({
      phase: 'workspace', projectStartPending: false,
      projectBootstrap: { status: 'ready' },
      selectedAgentId: 'orchestrator',
    });
    expect(store.getState().runtimeStatus?.statusRevision).toBeGreaterThan(7);
    await store.dispose();
  });

  test('rejects an old project bootstrap when only the runtime generation changes', async () => {
    const client = PassiveStatusClient();
    const firstBootstrap = deferred<ProjectBootstrapResult>();
    const bootstrapSpy = vi.spyOn(client, 'bootstrapProject').mockImplementation(() =>
      bootstrapSpy.mock.calls.length === 1
        ? firstBootstrap.promise
        : Promise.resolve({ status: 'ready', noWrite: true, reason: null }));
    const store = new ApplicationStore(client);
    const initializing = store.initialize();
    await waitFor(() => expect(bootstrapSpy).toHaveBeenCalledOnce());
    const previous = store.getState().runtimeStatus!;

    client.emitStatus({
      ...previous,
      runtimeGeneration: RUNTIME_GENERATION_B,
      statusRevision: previous.statusRevision + 1,
    });
    await waitFor(() => expect(bootstrapSpy).toHaveBeenCalledTimes(2));
    firstBootstrap.resolve({
      status: 'migration_required', noWrite: true,
      reason: 'stale generation must not commit', classification: 'legacy_v2',
    });
    await initializing;

    await waitFor(() => expect(store.getState()).toMatchObject({
      runtimeStatus: { runtimeGeneration: RUNTIME_GENERATION_B },
      projectBootstrap: { status: 'ready' },
    }));
    await store.dispose();
  });

  test('blocks a representative Store mutation at the shared readiness guard', async () => {
    const client = new PreviewDesktopClient();
    vi.spyOn(client, 'bootstrapProject').mockResolvedValue({
      status: 'migration_required', noWrite: true,
      reason: 'organization_v2_migration_required', classification: 'legacy_v2',
    });
    const inspectionSpy = vi.spyOn(client, 'startInspection').mockResolvedValue('must-not-start');
    const store = new ApplicationStore(client);
    await store.initialize();

    await store.startInspection('adversarial_audit', null);

    expect(inspectionSpy).not.toHaveBeenCalled();
    expect(store.getState().projectBootstrap).toMatchObject({ status: 'migration_required' });
    await store.dispose();
  });

  test('normalizes a recoverable stop failure back to workspace ownership', async () => {
    const client = new PreviewDesktopClient();
    vi.spyOn(client, 'stopRuntime').mockRejectedValue(new Error('injected stop failure'));
    const store = new ApplicationStore(client);
    await store.initialize();

    await store.stopRuntime();

    expect(store.getState()).toMatchObject({
      phase: 'workspace',
      runtimeStatus: { lifecycle: 'Ready' },
      error: { id: 'generic_failure' },
    });
    await store.dispose();
  });

  test('switches projects without turning internal project preparation into a cancelled terminal setup', async () => {
    const client = BootstrapSwitchClient();
    const store = new ApplicationStore(client);
    await store.initialize();
    await store.selectProject('research-ops');
    expect(client.operations).toEqual(['stop', 'activate:research-ops']);
    expect(store.getState()).toMatchObject({ phase: 'workspace', selectedProjectId: 'research-ops' });
    await store.dispose();
  });
  test('creates a workflow, repeats it and keeps completion separate from unassessed success', async () => {
    const client = new PreviewDesktopClient();
    const catalog: Awaited<ReturnType<PreviewDesktopClient['readWorkflowCatalog']>> = {
      definitions: [], batches: [], maxAttemptsPerBatch: 50,
    };
    vi.spyOn(client, 'readWorkflowCatalog').mockImplementation(async () => structuredClone(catalog));
    vi.spyOn(client, 'saveWorkflowDefinition').mockImplementation(async (_authority, input) => {
      const workflowId = 'workflow-test';
      catalog.definitions = [{
        workflowId, name: input.name, prompt: input.prompt, checks: structuredClone(input.checks),
        createdAt: '2026-08-29T00:00:00.000Z', updatedAt: '2026-08-29T00:00:00.000Z',
      }];
      return workflowId;
    });
    vi.spyOn(client, 'startWorkflowBatch').mockImplementation(async (_authority, workflowId, repetitions) => {
      const batchId = 'batch-test';
      catalog.batches = [{
        batchId, workflowId, requestedRuns: repetitions, status: 'completed',
        attempts: Array.from({ length: repetitions }, (_, index) => ({
          attemptId: `${batchId}:${index + 1}`, ordinal: index + 1, status: 'completed' as const,
          resultPreview: 'preview complete', checkOutcome: 'unassessed' as const,
          errorMessage: null, completedAt: '2026-08-29T00:00:01.000Z', durationMs: 1_000,
        })),
        createdAt: '2026-08-29T00:00:00.000Z', completedAt: '2026-08-29T00:00:01.000Z',
        metrics: {
          requestedRuns: repetitions, terminalRuns: repetitions, completedRuns: repetitions,
          failedRuns: 0, cancelledRuns: 0, assessedRuns: 0, passedRuns: 0,
          executionReliabilityPercent: 100, successRatePercent: null,
          outcomeConsistencyPercent: null, medianDurationMs: 1_000,
        },
      }];
      return batchId;
    });
    const store = new ApplicationStore(client);
    await store.initialize();
    await waitFor(() => expect(store.getState().workflowCatalog).not.toBeNull());

    await store.saveWorkflowDefinition({
      workflowId: null,
      name: '構造確認',
      prompt: '現在の構造を短く確認する',
      checks: [],
    });
    const workflowId = store.getState().workflowCatalog!.definitions[0].workflowId;
    await store.startWorkflowBatch(workflowId, 3);

    expect(store.getState().workflowCatalog!.batches[0]).toMatchObject({
      workflowId,
      requestedRuns: 3,
      metrics: {
        executionReliabilityPercent: 100,
        successRatePercent: null,
        outcomeConsistencyPercent: null,
      },
    });
    await store.dispose();
  });

  test('scopes composer drafts by both project and agent', async () => {
    const store = new ApplicationStore(BootstrapSwitchClient());
    await store.initialize();
    store.setDraft('orchestrator draft');
    store.selectAgent('frontend');
    expect(store.getState().draft).toBe('');
    store.setDraft('frontend draft');
    store.selectAgent('orchestrator');
    expect(store.getState().draft).toBe('orchestrator draft');

    await store.selectProject('research-ops');
    expect(store.getState().selectedProjectId).toBe('research-ops');
    expect(store.getState().draft).toBe('');
    store.setDraft('other project draft');

    await store.selectProject('orquesta-v5');
    expect(store.getState().selectedProjectId).toBe('orquesta-v5');
    expect(store.getState().draft).toBe('orchestrator draft');
    await store.dispose();
  });

  test('loads the newly active project recovery after switching projects', async () => {
    const client = BootstrapSwitchClient();
    vi.spyOn(client, 'readDispatchRecovery').mockResolvedValue({
      kind: 'prepared_outcome_unknown', dispatchId: 'research-recovery', projectId: 'research-ops',
      targetAgentId: 'orchestrator', createdAt: '2026-08-10T00:00:00Z', reason: null,
      threadId: null, turnId: null,
    });
    const store = new ApplicationStore(client);
    await store.initialize();
    expect(store.getState().dispatchRecovery).toBeNull();

    await expect(store.selectProject('research-ops')).resolves.toBe(true);

    expect(store.getState().dispatchRecovery).toMatchObject({
      dispatchId: 'research-recovery',
      projectId: 'research-ops',
    });
    await store.dispose();
  });

  test('rejects foreign and internally mismatched dispatch recovery events at the Store boundary', async () => {
    const client = PassiveStatusClient();
    const store = new ApplicationStore(client);
    await store.initialize();
    const currentRecovery: DispatchRecovery = {
      kind: 'prepared_outcome_unknown',
      dispatchId: 'current-recovery',
      projectId: 'orquesta-v5',
      targetAgentId: 'orchestrator',
      createdAt: '2026-08-10T00:00:00Z',
      reason: null,
      threadId: null,
      turnId: null,
    };
    client.emitScenarioEvent({ type: 'dispatch_recovery', projectId: 'orquesta-v5', recovery: currentRecovery });
    expect(store.getState().dispatchRecovery).toEqual(currentRecovery);

    client.emitScenarioEvent({ type: 'dispatch_recovery', projectId: 'research-ops', recovery: null });
    client.emitScenarioEvent({
      type: 'dispatch_recovery',
      projectId: 'orquesta-v5',
      recovery: { ...currentRecovery, projectId: 'research-ops', dispatchId: 'mismatched-recovery' },
    });

    expect(store.getState().dispatchRecovery).toEqual(currentRecovery);
    client.emitScenarioEvent({
      type: 'dispatch_recovery', projectId: 'orquesta-v5', recovery: null,
      clearedDispatchId: 'older-completed-dispatch',
    });
    expect(store.getState().dispatchRecovery).toEqual(currentRecovery);
    client.emitScenarioEvent({
      type: 'dispatch_recovery', projectId: 'orquesta-v5', recovery: null,
      clearedDispatchId: currentRecovery.dispatchId,
    });
    expect(store.getState().dispatchRecovery).toBeNull();
    client.emitScenarioEvent({ type: 'dispatch_recovery', projectId: 'orquesta-v5', recovery: currentRecovery });
    client.emitScenarioEvent({ type: 'dispatch_recovery', projectId: 'orquesta-v5', recovery: null });
    expect(store.getState().dispatchRecovery).toBeNull();
    client.emitScenarioEvent({ type: 'dispatch_recovery', projectId: 'research-ops', recovery: currentRecovery });
    client.emitScenarioEvent({
      type: 'dispatch_recovery',
      projectId: 'orquesta-v5',
      recovery: { ...currentRecovery, projectId: 'research-ops', dispatchId: 'mismatched-recovery-2' },
    });
    expect(store.getState().dispatchRecovery).toBeNull();
    store.selectAgent('frontend');
    store.setDraft('Continue this project');
    await store.sendMessage();
    expect(client.sendCalls).toBe(1);
    await store.dispose();
  });

  test('keeps accepted dispatch state internal until the exact terminal clear arrives', async () => {
    const accepted: DispatchRecovery = {
      kind: 'accepted',
      dispatchId: 'accepted-dispatch',
      projectId: 'orquesta-v5',
      targetAgentId: 'orchestrator',
      createdAt: '2026-08-30T11:28:25.000Z',
      reason: null,
      threadId: 'accepted-thread',
      turnId: 'accepted-turn',
    };
    const client = new PreviewDesktopClient();
    const send = vi.spyOn(client, 'sendMessage').mockResolvedValue({
      receipt: {
        dispatchId: accepted.dispatchId,
        threadId: accepted.threadId!,
        turnId: accepted.turnId!,
      },
      dispatchRecovery: accepted,
    });
    const store = new ApplicationStore(client);
    await store.initialize();
    store.setDraft('first turn');

    await store.sendMessage();

    expect(store.getState().dispatchRecovery).toEqual(accepted);
    expect(store.getState().executions.orchestrator).toMatchObject({
      phase: 'accepted',
      threadId: accepted.threadId,
      turnId: accepted.turnId,
    });
    store.setDraft('must wait for the active turn');
    await store.sendMessage();
    expect(send).toHaveBeenCalledOnce();
    expect(store.getState().notice).not.toEqual({ id: 'recover_before_send' });

    client.emitScenarioEvent({
      type: 'dispatch_recovery',
      projectId: accepted.projectId,
      recovery: null,
      clearedDispatchId: accepted.dispatchId,
    });
    expect(store.getState().dispatchRecovery).toBeNull();
    await store.dispose();
  });

  test.each(['prepared_outcome_unknown', 'cleanup_pending'] as const)(
    'blocks a new send while actionable %s state still needs owner reconciliation',
    async (kind) => {
      const client = PassiveStatusClient();
      const store = new ApplicationStore(client);
      await store.initialize();
      client.emitScenarioEvent({
        type: 'dispatch_recovery',
        projectId: 'orquesta-v5',
        recovery: {
          kind,
          dispatchId: `${kind}-dispatch`,
          projectId: 'orquesta-v5',
          targetAgentId: 'orchestrator',
          createdAt: '2026-08-30T11:28:25.000Z',
          reason: null,
          threadId: null,
          turnId: null,
        },
      });
      store.setDraft('must not send yet');

      await store.sendMessage();

      expect(client.sendCalls).toBe(0);
      expect(store.getState().notice).toEqual({ id: 'recover_before_send' });
      await store.dispose();
    },
  );

  test('atomically inserts a transcript only into the unchanged captured composer draft', async () => {
    const store = new ApplicationStore(new PreviewDesktopClient());
    await store.initialize();
    expect(store.getState()).toMatchObject({
      phase: 'workspace', selectedProjectId: 'orquesta-v5', selectedAgentId: 'orchestrator',
      voiceCapturePhase: 'idle',
      voiceStatus: { requiredAssetsReady: true },
    });
    store.setDraft('既存の指示');
    const capture = store.captureComposerDraft();
    expect(capture).toMatchObject({
      projectId: 'orquesta-v5',
      agentId: 'orchestrator',
      draft: '既存の指示',
      draftRevision: 1,
    });

    expect(store.commitComposerTranscript(capture!, '音声で追加した内容')).toBe(true);
    expect(store.getState().draft).toBe('既存の指示 音声で追加した内容');
    await store.dispose();
  });

  test('rejects stale transcript insertion after an ABA draft edit or target switch', async () => {
    const store = new ApplicationStore(new PreviewDesktopClient());
    await store.initialize();
    store.setDraft('元の文');
    const staleAfterEdit = store.captureComposerDraft();
    store.setDraft('編集中');
    store.setDraft('元の文');
    expect(store.commitComposerTranscript(staleAfterEdit!, '上書きしてはいけない')).toBe(false);
    expect(store.getState().draft).toBe('元の文');

    const staleAfterTargetSwitch = store.captureComposerDraft();
    store.selectAgent('frontend');
    expect(store.commitComposerTranscript(staleAfterTargetSwitch!, '別担当へ入れてはいけない')).toBe(false);
    expect(store.getState().draft).toBe('');
    await store.dispose();
  });

  test('carries a new project name through the existing folder-selection route', async () => {
    const client = NamedProjectClient();
    const store = new ApplicationStore(client);
    await store.initialize();

    await expect(store.createStarterProject('  顧客管理プロジェクト  ')).resolves.toBe(true);
    expect(client.chosenTitle).toBe('顧客管理プロジェクト');
    expect(store.getState()).toMatchObject({ phase: 'workspace' });
    expect(store.getState().projects.find((project) => project.creationOperationRef)?.title)
      .toBe('顧客管理プロジェクト');
    await store.dispose();
  });

  test('retries one transport-unknown Starter create with the exact operation before list reconciliation', async () => {
    const client = LauncherWithProjectsClient();
    const createInputs: Array<{ operationRef: string; projectName: string }> = [];
    const listProjects = client.listProjects.bind(client);
    vi.spyOn(client, 'createStarterProject').mockImplementation(async (_renderer, input) => {
      createInputs.push({ ...input });
      throw { message: 'starter response lost', outcomeUnknown: true };
    });
    const listSpy = vi.spyOn(client, 'listProjects').mockImplementation(async (renderer) =>
      (await listProjects(renderer)).map((project, index) => index === 1
        ? { ...project, creationOperationRef: createInputs[0]?.operationRef ?? null } : project));
    const store = new ApplicationStore(client);
    await store.initialize();
    store.setDraft('応答喪失でも一度だけ作る');

    await expect(store.createStarterProject('応答喪失プロジェクト')).resolves.toBe(true);

    expect(createInputs).toHaveLength(2);
    expect(createInputs[1]).toEqual(createInputs[0]);
    expect(listSpy).toHaveBeenCalledOnce();
    expect(store.getState()).toMatchObject({
      selectedProjectId: 'research-ops',
      selectedAgentId: 'orchestrator',
      draft: '応答喪失でも一度だけ作る',
    });
    await store.dispose();
  });

  test('keeps every durable Starter recovery in application state instead of a dismissible notice', async () => {
    const client = new PreviewDesktopClient({ state: 'empty' });
    const bootstrapFixture = client.bootstrap.bind(client);
    vi.spyOn(client, 'bootstrap').mockImplementation(async (signal) => ({
      ...await bootstrapFixture(signal),
      starterCreationRecoveries: [
        { operationRef: '11111111-1111-4111-8111-111111111111', displayName: '顧客管理', finalChildPath: 'C:\\Projects\\顧客管理', reason: 'owned_root_identity_mismatch' },
        { operationRef: '22222222-2222-4222-8222-222222222222', displayName: '店舗分析', finalChildPath: 'C:\\Projects\\店舗分析', reason: 'restart_planned_final_exists_without_owned_identity' },
      ],
    }));
    const store = new ApplicationStore(client);
    await store.initialize();

    expect(store.getState().starterCreationRecoveries).toEqual([
      expect.objectContaining({ displayName: '顧客管理', reason: 'owned_root_identity_mismatch' }),
      expect.objectContaining({ displayName: '店舗分析', reason: 'restart_planned_final_exists_without_owned_identity' }),
    ]);
    store.clearError();
    expect(store.getState().starterCreationRecoveries).toHaveLength(2);
    await store.dispose();
  });

  test('keeps project-only routes out of state until a project is ready', async () => {
    const store = new ApplicationStore(new PreviewDesktopClient({ state: 'empty' }));
    await store.initialize();

    store.setRoute('map');
    store.setRoute('decisions');
    store.setRoute('workflows');
    store.setRoute('history');

    expect(store.getState().route).toBe('work');
    await store.dispose();
  });

  test('does not start project entry when the folder picker is cancelled', async () => {
    const client = LauncherWithProjectsClient();
    const createInputs: Array<{ operationRef: string; projectName: string }> = [];
    vi.spyOn(client, 'chooseProjectFolder').mockResolvedValue(null);
    vi.spyOn(client, 'createStarterProject').mockImplementation(async (_renderer, input) => {
      createInputs.push({ ...input });
      return null;
    });
    const store = new ApplicationStore(client);
    await store.initialize();
    store.setDraft('キャンセルしても残す');

    await expect(store.chooseProjectFolder()).resolves.toBeNull();
    await expect(store.createStarterProject('一度目')).resolves.toBe(false);
    await expect(store.createStarterProject('一度目')).resolves.toBe(false);

    expect(createInputs).toHaveLength(2);
    expect(createInputs[1].operationRef).not.toBe(createInputs[0].operationRef);
    expect(store.getState()).toMatchObject({ phase: 'launcher', draft: 'キャンセルしても残す' });
    await store.dispose();
  });

  test('registers a selected folder only after receiving its explicit project name', async () => {
    const client = LauncherWithProjectsClient();
    const open = vi.mocked(client.openProjectFolder);
    const store = new ApplicationStore(client);
    await store.initialize();

    const selection = await store.chooseProjectFolder();
    expect(selection).not.toBeNull();
    expect(open).not.toHaveBeenCalled();

    await expect(store.openProjectFolder(selection!, '  Customer control  ')).resolves.toBe(true);
    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({ rendererSessionId: 'preview-renderer' }),
      { selectionRef: selection!.selectionRef, projectName: 'Customer control' },
    );
    await store.dispose();
  });

  test('retires only the EntryIntent on definitive name validation failure', async () => {
    const client = LauncherWithProjectsClient();
    const createInputs: Array<{ operationRef: string; projectName: string }> = [];
    vi.spyOn(client, 'createStarterProject').mockImplementation(async (_renderer, input) => {
      createInputs.push({ ...input });
      throw { code: 'project_name_invalid', message: 'Project name is reserved.', retryable: false, outcomeUnknown: false };
    });
    const store = new ApplicationStore(client);
    await store.initialize();
    store.setDraft('予約名でも本文は消さない');

    await expect(store.createStarterProject('CON')).resolves.toBe(false);
    await expect(store.createStarterProject('CON')).resolves.toBe(false);

    expect(createInputs).toHaveLength(2);
    expect(createInputs[1].operationRef).not.toBe(createInputs[0].operationRef);
    expect(store.getState()).toMatchObject({ phase: 'launcher', draft: '予約名でも本文は消さない' });
    expect(store.getState().error).toEqual({ id: 'project_name_invalid' });
    await store.dispose();
  });

  test('keeps a non-validation failure retryable until the dialog abandons that entry', async () => {
    const client = LauncherWithProjectsClient();
    const createInputs: Array<{ operationRef: string; projectName: string }> = [];
    vi.spyOn(client, 'createStarterProject').mockImplementation(async (_renderer, input) => {
      createInputs.push({ ...input });
      throw new Error('The selected parent is temporarily unavailable.');
    });
    const store = new ApplicationStore(client);
    await store.initialize();

    await expect(store.createStarterProject('再試行する')).resolves.toBe(false);
    await expect(store.createStarterProject('再試行する')).resolves.toBe(false);
    expect(createInputs[1]).toEqual(createInputs[0]);

    store.retireProjectEntryIntent();
    await expect(store.createStarterProject('再試行する')).resolves.toBe(false);
    expect(createInputs[2].operationRef).not.toBe(createInputs[1].operationRef);
    await store.dispose();
  });

  test('reuses the exact Starter operation after activation fails, then activates once', async () => {
    const client = LauncherWithProjectsClient();
    const createInputs: Array<{ operationRef: string; projectName: string }> = [];
    const createStarterProject = vi.mocked(client.createStarterProject).getMockImplementation()!;
    const activateProject = vi.mocked(client.activateProject).getMockImplementation()!;
    let failActivation = true;
    vi.spyOn(client, 'createStarterProject').mockImplementation(async (...args) => {
      createInputs.push({ ...args[1] });
      return createStarterProject(...args);
    });
    vi.spyOn(client, 'activateProject').mockImplementation(async (...args) => {
      if (failActivation) { failActivation = false; throw new Error('Injected activation failure.'); }
      return activateProject(...args);
    });
    const store = new ApplicationStore(client);
    await store.initialize();
    store.setDraft('起動失敗でも保持する');

    await expect(store.createStarterProject('起動再試行')).resolves.toBe(false);
    await expect(store.createStarterProject('起動再試行')).resolves.toBe(true);

    expect(createInputs).toHaveLength(2);
    expect(createInputs[1]).toEqual(createInputs[0]);
    expect(store.getState()).toMatchObject({ phase: 'workspace', draft: '起動失敗でも保持する' });
    await store.dispose();
  });

  test('retries project bootstrap for an already-active Starter without minting another operation', async () => {
    const client = LauncherWithProjectsClient();
    const createInputs: Array<{ operationRef: string; projectName: string }> = [];
    const createStarterProject = vi.mocked(client.createStarterProject).getMockImplementation()!;
    let allowBootstrap = false;
    vi.spyOn(client, 'createStarterProject').mockImplementation(async (...args) => {
      createInputs.push({ ...args[1] });
      return createStarterProject(...args);
    });
    vi.spyOn(client, 'bootstrapProject').mockImplementation(async () => allowBootstrap
      ? { status: 'ready', noWrite: true, reason: null }
      : { status: 'recovery_required', noWrite: true, reason: 'Injected bootstrap failure.' });
    const store = new ApplicationStore(client);
    await store.initialize();
    store.setDraft('基盤準備後に渡す');

    await expect(store.createStarterProject('基盤再試行')).resolves.toBe(false);
    allowBootstrap = true;
    await expect(store.createStarterProject('基盤再試行')).resolves.toBe(true);

    expect(createInputs).toHaveLength(2);
    expect(createInputs[1]).toEqual(createInputs[0]);
    expect(store.getState()).toMatchObject({ phase: 'workspace', draft: '基盤準備後に渡す' });
    await store.dispose();
  });

  test('does not apply a stale launcher draft revision after creation finishes', async () => {
    const client = LauncherWithProjectsClient();
    const createInputs: Array<{ operationRef: string; projectName: string }> = [];
    const pendingCreate = deferred<ProjectSummary | null>();
    vi.spyOn(client, 'createStarterProject').mockImplementation(async (_renderer, input) => {
      createInputs.push({ ...input });
      return pendingCreate.promise;
    });
    const store = new ApplicationStore(client);
    await store.initialize();
    store.setDraft('作成開始時の本文');

    const creation = store.createStarterProject('遅延作成');
    await waitFor(() => expect(createInputs).toHaveLength(1));
    store.setDraft('作成中に更新した本文');
    pendingCreate.resolve({
      ...structuredClone(previewProjects[1]),
      id: `preview-starter-${createInputs[0].operationRef}`,
      title: '遅延作成',
      creationOperationRef: createInputs[0].operationRef,
    });

    await expect(creation).resolves.toBe(false);
    expect(client.sendCalls).toBe(0);
    expect(store.getState().notice).toEqual({ id: 'project_start_draft_preserved' });
    await store.stopRuntime();
    expect(store.getState()).toMatchObject({ phase: 'launcher', draft: '作成中に更新した本文' });
    await store.dispose();
  });

  test('never overwrites an existing target draft and keeps the launcher draft recoverable', async () => {
    const client = LauncherWithProjectsClient();
    vi.spyOn(client, 'createStarterProject').mockImplementation(async (_renderer, input) => ({
      ...structuredClone(previewProjects[1]), creationOperationRef: input.operationRef,
    }));
    const store = new ApplicationStore(client);
    await store.initialize();
    await store.selectProject('research-ops');
    store.setDraft('既存ターゲットの本文');
    await store.stopRuntime();
    store.setDraft('新規プロジェクトへ渡したい本文');

    await expect(store.createStarterProject('既存ターゲット')).resolves.toBe(false);

    expect(client.sendCalls).toBe(0);
    expect(store.getState()).toMatchObject({ draft: '既存ターゲットの本文' });
    expect(store.getState().notice).toEqual({ id: 'project_entry_draft_conflict' });
    await store.stopRuntime();
    expect(store.getState()).toMatchObject({ phase: 'launcher', draft: '新規プロジェクトへ渡したい本文' });
    await store.dispose();
  });

  test('preserves a pre-project composer draft when the new project activates its orchestrator', async () => {
    const client = NamedProjectClient({ state: 'empty' });
    const store = new ApplicationStore(client);
    await store.initialize();
    store.setDraft('複数店舗の顧客管理を作りたい');

    await expect(store.createStarterProject('顧客管理プロジェクト')).resolves.toBe(true);

    expect(store.getState()).toMatchObject({
      selectedAgentId: 'orchestrator',
      draft: '複数店舗の顧客管理を作りたい',
    });
    await store.dispose();
  });

  test('sends the blank-WORK draft exactly once after the new project and orchestrator are ready', async () => {
    const client = LauncherWithProjectsClient();
    const store = new ApplicationStore(client);
    await store.initialize();
    store.setDraft('複数店舗の顧客管理を作りたい');

    await expect(store.createStarterProject('顧客管理プロジェクト', { sendDraft: true })).resolves.toBe(true);

    expect(client.sendCalls).toBe(1);
    expect(store.getState().messages).toContainEqual(expect.objectContaining({
      role: 'user', text: '複数店舗の顧客管理を作りたい', targetAgentId: 'orchestrator',
    }));
    expect(store.getState().draft).toBe('');
    await store.dispose();
  });

  test('carries a blank-WORK draft through a recent project without sending unless explicitly requested', async () => {
    const client = LauncherWithProjectsClient();
    const store = new ApplicationStore(client);
    await store.initialize();
    store.setDraft('既存案件の続きを確認したい');

    await store.selectProject('research-ops');

    expect(client.sendCalls).toBe(0);
    expect(store.getState()).toMatchObject({
      selectedProjectId: 'research-ops', selectedAgentId: 'orchestrator', draft: '既存案件の続きを確認したい',
    });
    await store.dispose();
  });

  test('sends a blank-WORK draft exactly once when a recent project is chosen from the explicit Send flow', async () => {
    const client = LauncherWithProjectsClient();
    const store = new ApplicationStore(client);
    await store.initialize();
    store.setDraft('既存案件をこの要望から再開する');

    await store.selectProject('research-ops', { sendDraft: true });

    expect(client.sendCalls).toBe(1);
    expect(store.getState().messages).toContainEqual(expect.objectContaining({
      role: 'user', text: '既存案件をこの要望から再開する', targetAgentId: 'orchestrator',
    }));
    expect(store.getState().draft).toBe('');
    await store.dispose();
  });

  test('never carries an active-project agent draft into a switched project', async () => {
    const store = new ApplicationStore(BootstrapSwitchClient());
    await store.initialize();
    store.setDraft('今のプロジェクトだけの下書き');

    await store.selectProject('research-ops', { sendDraft: true });

    expect(store.getState()).toMatchObject({
      selectedProjectId: 'research-ops', selectedAgentId: 'orchestrator', draft: '',
    });
    expect(store.getState().messages).not.toContainEqual(expect.objectContaining({
      text: '今のプロジェクトだけの下書き',
    }));
    await store.dispose();
  });

  test('keeps the registered project name when a resumed runtime reports the folder basename', async () => {
    const client = new PreviewDesktopClient();
    const bootstrapFixture = client.bootstrap.bind(client);
    vi.spyOn(client, 'bootstrap').mockImplementation(async (signal) => {
      const bootstrap = await bootstrapFixture(signal);
      return {
        ...bootstrap,
        projects: bootstrap.projects.map((project, index) => index === 0
          ? { ...project, title: '登録済みプロジェクト名' } : project),
        snapshot: bootstrap.snapshot
          ? { ...bootstrap.snapshot, project: { ...bootstrap.snapshot.project, title: 'runtime-folder-name' } }
          : null,
      };
    });
    const store = new ApplicationStore(client);
    await store.initialize();

    expect(store.getState().snapshot?.project.title).toBe('登録済みプロジェクト名');
    expect(store.getState().projects[0]?.title).toBe('登録済みプロジェクト名');
    await store.dispose();
  });

  test('shows the user message without interpreting raw runtime phases in the application store', async () => {
    const client = VoiceSendTrackingClient();
    const store = new ApplicationStore(client);
    await store.initialize();
    store.setDraft('顧客管理を複数店舗対応へ拡張する');

    await store.sendMessage();

    const accepted = store.getState().executions.orchestrator;
    expect(accepted).toMatchObject({
      phase: 'accepted', summary: '顧客管理を複数店舗対応へ拡張する', threadId: 'thread-orchestrator',
    });
    expect(store.getState().messages.at(-1)).toMatchObject({ role: 'user', text: '顧客管理を複数店舗対応へ拡張する' });

    client.emitScenarioEvent({
      type: 'runtime',
      event: {
        type: 'runtime.notification',
        notification: {
          kind: 'turn_started', correlationId: 'codex-correlation-expansion', targetAgentId: 'orchestrator',
          threadId: 'thread-orchestrator', turnId: 'turn-expansion', text: null,
        },
      },
    });
    expect(store.getState().executions.orchestrator).toMatchObject({ phase: 'accepted', turnId: accepted?.turnId });

    client.emitScenarioEvent({
      type: 'runtime',
      event: {
        type: 'runtime.notification',
        notification: {
          kind: 'turn_completed', correlationId: 'codex-correlation-expansion', targetAgentId: 'orchestrator',
          threadId: 'thread-orchestrator', turnId: 'turn-expansion', text: null,
        },
      },
    });
    expect(store.getState().executions.orchestrator).toMatchObject({ phase: 'accepted', turnId: accepted?.turnId });
    await store.dispose();
  });

  test('keeps the newly selected agent draft and loading owner when an earlier agent send completes', async () => {
    const client = new PreviewDesktopClient();
    const result = deferred<DispatchSendResult>();
    const conversationReads: string[] = [];
    const readConversation = client.readConversation.bind(client);
    vi.spyOn(client, 'sendMessage').mockImplementation(() => result.promise);
    vi.spyOn(client, 'readConversation').mockImplementation((authority, targetAgentId, checkpoint, cursor, activityCursor) => {
      conversationReads.push(targetAgentId);
      return readConversation(authority, targetAgentId, checkpoint, cursor, activityCursor);
    });
    const store = new ApplicationStore(client);
    await store.initialize();
    conversationReads.length = 0;
    store.setDraft('message for orchestrator');

    const sending = store.sendMessage();
    expect(store.getState().sending).toBe(true);
    store.selectAgent('frontend');
    store.setDraft('evidence agent draft');
    await waitFor(() => expect(store.getState()).toMatchObject({
      selectedAgentId: 'frontend', conversationLoading: false, draft: 'evidence agent draft',
    }));

    result.resolve({
      receipt: { dispatchId: 'dispatch-a', threadId: 'thread-orchestrator', turnId: 'turn-a' },
      dispatchRecovery: null,
    });
    await sending;

    expect(store.getState()).toMatchObject({
      selectedAgentId: 'frontend', conversationLoading: false,
      draft: 'evidence agent draft', sending: false,
    });
    expect(conversationReads).toEqual(['frontend']);
    await store.dispose();
  });

  test('does not create a second turn during the accepted-before-projection window', async () => {
    const client = new PreviewDesktopClient();
    const sendSpy = vi.spyOn(client, 'sendMessage').mockImplementation(async () => ({
      receipt: {
        dispatchId: `dispatch-${sendSpy.mock.calls.length}`,
        threadId: 'thread-awaiting-projection', turnId: 'turn-awaiting-projection',
      },
      dispatchRecovery: null,
    }));
    const store = new ApplicationStore(client);
    await store.initialize();
    store.setDraft('first turn');
    await store.sendMessage();
    expect(store.getState().executions.orchestrator).toMatchObject({
      phase: 'accepted', threadId: 'thread-awaiting-projection', turnId: 'turn-awaiting-projection', canInterrupt: false,
    });

    store.setDraft('must not become a second turn');
    await store.sendMessage();
    expect(sendSpy).toHaveBeenCalledOnce();
    expect(store.getState().draft).toBe('must not become a second turn');
    await store.dispose();
  });

  test('does not regress a fast projected completion back to accepted when the send receipt resolves later', async () => {
    const client = PassiveStatusClient();
    const result = deferred<DispatchSendResult>();
    let completed = false;
    const readConversation = client.readConversation.bind(client);
    vi.spyOn(client, 'sendMessage').mockImplementation(() => result.promise);
    vi.spyOn(client, 'readConversation').mockImplementation(async (authority, targetAgentId, checkpoint, cursor, activityCursor) => {
      const page = await readConversation(authority, targetAgentId, checkpoint, cursor, activityCursor);
      if (!completed) return page;
      return {
        ...page, appliedJournalSequence: 3, projectionRevision: 3,
        items: [
          { id: 'message-fast-user', role: 'user' as const, targetAgentId, authorLabel: 'YOU', text: 'fast turn', createdAt: '2026-08-25T00:00:00.000Z', evidenceLabel: null },
          { id: 'message-fast-agent', role: 'agent' as const, targetAgentId, authorLabel: 'orchestrator', text: 'done', createdAt: '2026-08-25T00:00:01.000Z', evidenceLabel: null },
        ],
        activeTurns: [],
        latestTurn: { threadId: 'thread-fast', turnId: 'turn-fast', targetAgentId, state: 'completed' as const, lastJournalSequence: 3 },
      };
    });
    const store = new ApplicationStore(client);
    await store.initialize();
    store.setDraft('fast turn');

    const sending = store.sendMessage();
    expect(store.getState().executions.orchestrator).toMatchObject({
      phase: 'queueing', threadId: null, turnId: null,
    });
    completed = true;
    client.emitScenarioEvent({
      type: 'projection_changed', projectId: 'orquesta-v5', streamId: 'preview-stream',
      appliedJournalSequence: 3, projectionRevision: 3,
    });
    await waitFor(() => expect(store.getState().executions.orchestrator).toMatchObject({
      phase: 'completed', source: 'projection', threadId: 'thread-fast', turnId: 'turn-fast',
    }));
    result.resolve({
      receipt: { dispatchId: 'dispatch-fast', threadId: 'thread-fast', turnId: 'turn-fast' },
      dispatchRecovery: null,
    });
    await sending;

    expect(store.getState()).toMatchObject({
      sending: false,
      executions: {
        orchestrator: {
          phase: 'completed', source: 'projection', threadId: 'thread-fast', turnId: 'turn-fast',
          dispatchId: 'dispatch-fast', canInterrupt: false, lastJournalSequence: 3,
        },
      },
    });
    await store.dispose();
  });

  test('interrupts only the exact projection-owned active turn and suppresses duplicate Stop', async () => {
    const client = ActiveTurnClient();
    client.activeByAgent.set('orchestrator', [{
      threadId: 'thread-owned', turnId: 'turn-owned', targetAgentId: 'orchestrator',
      state: 'in_progress', lastJournalSequence: 41,
    }]);
    const stop = deferred<void>();
    client.interruptResult = stop.promise;
    const store = new ApplicationStore(client);
    await store.initialize();
    await waitFor(() => expect(store.getState().executions.orchestrator).toMatchObject({
      threadId: 'thread-owned', turnId: 'turn-owned', phase: 'working', source: 'projection', canInterrupt: true,
    }));

    const first = store.interruptActiveTurn();
    expect(store.getState()).toMatchObject({
      executions: { orchestrator: { phase: 'stopping', threadId: 'thread-owned', turnId: 'turn-owned', canInterrupt: false } },
    });
    await store.interruptActiveTurn();
    expect(client.interruptCalls).toEqual([{
      targetAgentId: 'orchestrator', threadId: 'thread-owned', turnId: 'turn-owned',
    }]);

    stop.resolve();
    await first;
    expect(store.getState().notice).toEqual({ id: 'stop_accepted' });
    await store.dispose();
  });

  test('steers only the exact active turn, suppresses duplicate submit, and preserves a newer draft', async () => {
    const client = ActiveTurnClient();
    client.activeByAgent.set('orchestrator', [{
      threadId: 'thread-steer', turnId: 'turn-steer', targetAgentId: 'orchestrator',
      state: 'in_progress', lastJournalSequence: 42,
    }]);
    const steered = deferred<void>();
    client.steerResult = steered.promise;
    const store = new ApplicationStore(client);
    await store.initialize();
    await waitFor(() => expect(store.getState().executions.orchestrator?.canInterrupt).toBe(true));
    store.setDraft('根本原因を先に見て');

    const first = store.steerActiveTurn();
    expect(store.getState()).toMatchObject({ sending: true, conversationAction: 'steer' });
    await store.steerActiveTurn();
    expect(client.steerCalls).toHaveLength(1);
    expect(client.steerCalls[0]).toMatchObject({
      targetAgentId: 'orchestrator', threadId: 'thread-steer', turnId: 'turn-steer', text: '根本原因を先に見て',
    });

    store.setDraft('次の新規ターン用の下書き');
    steered.resolve();
    await first;
    expect(store.getState()).toMatchObject({
      sending: false,
      conversationAction: null,
      draft: '次の新規ターン用の下書き',
      notice: { id: 'steer_sent' },
    });
    await store.dispose();
  });

  test('blocks duplicate Steer after an outcome-unknown response until the active turn changes', async () => {
    const client = ActiveTurnClient();
    client.activeByAgent.set('orchestrator', [{
      threadId: 'thread-unknown', turnId: 'turn-unknown', targetAgentId: 'orchestrator',
      state: 'in_progress', lastJournalSequence: 50,
    }]);
    client.steerFailure = { message: 'response lost', outcomeUnknown: true };
    const store = new ApplicationStore(client);
    await store.initialize();
    await waitFor(() => expect(store.getState().executions.orchestrator?.canInterrupt).toBe(true));
    store.setDraft('同じ指示を重ねない');

    await store.steerActiveTurn();
    await store.steerActiveTurn();
    expect(client.steerCalls).toHaveLength(1);
    expect(store.getState()).toMatchObject({
      turnMutationOutcomeUnknownTurnKey: 'thread-unknown:turn-unknown',
      error: { id: 'steer_outcome_unknown' },
    });

    client.activeByAgent.set('orchestrator', [{
      threadId: 'thread-next', turnId: 'turn-next', targetAgentId: 'orchestrator',
      state: 'in_progress', lastJournalSequence: 51,
    }]);
    client.steerFailure = null;
    await store.loadConversation('orchestrator');
    expect(store.getState().turnMutationOutcomeUnknownTurnKey).toBeNull();
    await store.steerActiveTurn();
    expect(client.steerCalls).toHaveLength(2);
    await store.dispose();
  });

  test('does not dispatch Stop while Steer owns the exact active turn', async () => {
    const client = ActiveTurnClient();
    client.activeByAgent.set('orchestrator', [{
      threadId: 'thread-conflict', turnId: 'turn-conflict', targetAgentId: 'orchestrator',
      state: 'in_progress', lastJournalSequence: 52,
    }]);
    const steered = deferred<void>();
    client.steerResult = steered.promise;
    const store = new ApplicationStore(client);
    await store.initialize();
    await waitFor(() => expect(store.getState().executions.orchestrator?.canInterrupt).toBe(true));
    store.setDraft('進行中の回答を修正');

    const steering = store.steerActiveTurn();
    await store.interruptActiveTurn();
    expect(client.steerCalls).toHaveLength(1);
    expect(client.interruptCalls).toHaveLength(0);

    steered.resolve();
    await steering;
    await store.interruptActiveTurn();
    expect(client.interruptCalls).toHaveLength(0);
    expect(store.getState().turnMutationAcceptedTurnKey).toBe('thread-conflict:turn-conflict');

    client.activeByAgent.set('orchestrator', [{
      threadId: 'thread-after-steer', turnId: 'turn-after-steer', targetAgentId: 'orchestrator',
      state: 'in_progress', lastJournalSequence: 53,
    }]);
    await store.loadConversation('orchestrator');
    expect(store.getState().turnMutationAcceptedTurnKey).toBeNull();
    await store.interruptActiveTurn();
    expect(client.interruptCalls).toHaveLength(1);
    await store.dispose();
  });

  test('does not dispatch Steer while Stop owns the exact active turn', async () => {
    const client = ActiveTurnClient();
    client.activeByAgent.set('orchestrator', [{
      threadId: 'thread-stop-first', turnId: 'turn-stop-first', targetAgentId: 'orchestrator',
      state: 'in_progress', lastJournalSequence: 53,
    }]);
    const stopped = deferred<void>();
    client.interruptResult = stopped.promise;
    const store = new ApplicationStore(client);
    await store.initialize();
    await waitFor(() => expect(store.getState().executions.orchestrator?.canInterrupt).toBe(true));

    const stopping = store.interruptActiveTurn();
    store.setDraft('停止と競合させない');
    await store.steerActiveTurn();
    expect(client.interruptCalls).toHaveLength(1);
    expect(client.steerCalls).toHaveLength(0);

    stopped.resolve();
    await stopping;
    await store.dispose();
  });

  test('blocks both Stop and Steer after a turn mutation outcome becomes unknown', async () => {
    const client = ActiveTurnClient();
    client.activeByAgent.set('orchestrator', [{
      threadId: 'thread-mutation-unknown', turnId: 'turn-mutation-unknown', targetAgentId: 'orchestrator',
      state: 'in_progress', lastJournalSequence: 54,
    }]);
    client.steerFailure = { message: 'response lost', outcomeUnknown: true };
    const store = new ApplicationStore(client);
    await store.initialize();
    await waitFor(() => expect(store.getState().executions.orchestrator?.canInterrupt).toBe(true));
    store.setDraft('結果不明になる軌道修正');

    await store.steerActiveTurn();
    await store.interruptActiveTurn();
    await store.steerActiveTurn();

    expect(client.steerCalls).toHaveLength(1);
    expect(client.interruptCalls).toHaveLength(0);
    expect(store.getState()).toMatchObject({
      turnMutationOutcomeUnknownTurnKey: 'thread-mutation-unknown:turn-mutation-unknown',
      error: { id: 'steer_outcome_unknown' },
    });
    await store.dispose();
  });

  test('keeps an outcome-unknown Stop visibly stopping and blocks later Steer', async () => {
    const client = ActiveTurnClient();
    client.activeByAgent.set('orchestrator', [{
      threadId: 'thread-stop-unknown', turnId: 'turn-stop-unknown', targetAgentId: 'orchestrator',
      state: 'in_progress', lastJournalSequence: 55,
    }]);
    client.interruptFailure = { message: 'response lost', outcomeUnknown: true };
    const store = new ApplicationStore(client);
    await store.initialize();
    await waitFor(() => expect(store.getState().executions.orchestrator?.canInterrupt).toBe(true));

    await store.interruptActiveTurn();
    store.setDraft('停止結果不明の後には送らない');
    await store.steerActiveTurn();

    expect(client.interruptCalls).toHaveLength(1);
    expect(client.steerCalls).toHaveLength(0);
    expect(store.getState()).toMatchObject({
      sending: false,
      conversationAction: null,
      turnMutationOutcomeUnknownTurnKey: 'thread-stop-unknown:turn-stop-unknown',
      error: { id: 'stop_outcome_unknown' },
      executions: { orchestrator: { phase: 'stopping', canInterrupt: false } },
    });
    await store.dispose();
  });

  test('retries a visible user message as a new turn without overwriting the current draft', async () => {
    const client = ActiveTurnClient();
    const store = new ApplicationStore(client);
    await store.initialize();
    store.setDraft('再送する元の文');
    await store.sendMessage();
    const message = store.getState().messages.find((candidate) => candidate.role === 'user')!;
    const completedExecution = store.getState().executions.orchestrator;
    client.latestByAgent.set('orchestrator', {
      threadId: completedExecution.threadId!,
      turnId: completedExecution.turnId!,
      targetAgentId: 'orchestrator',
      state: 'completed',
      lastJournalSequence: 3,
    });
    client.emitScenarioEvent({
      type: 'projection_changed', projectId: 'orquesta-v5', streamId: 'preview-stream',
      appliedJournalSequence: 3, projectionRevision: 3,
    });
    await waitFor(() => expect(store.getState().executions.orchestrator?.phase).toBe('completed'));
    client.sendCalls.length = 0;
    store.setDraft('別の下書き');
    store.selectComposerModel('gpt-5.6-terra');
    store.selectComposerReasoningEffort('medium');
    store.setComposerAccessMode('approval_required');
    store.setComposerServiceTier('fast');

    await store.retryMessage(message.id);

    expect(client.sendCalls).toEqual([{
      targetAgentId: 'orchestrator', text: message.text, attachmentRefs: [],
      model: 'gpt-5.6-terra', effort: 'medium', accessMode: 'approval_required', serviceTier: 'fast',
    }]);
    expect(store.getState()).toMatchObject({
      draft: '別の下書き', sending: false, conversationAction: null,
      notice: { id: 'retry_sent' },
    });
    await store.dispose();
  });

  test('serializes the image picker and exposes its honest in-flight state', async () => {
    const client = AttachmentClient();
    const selection = deferred<Awaited<ReturnType<PreviewDesktopClient['importAttachments']>>>();
    client.importResult = selection.promise;
    const store = new ApplicationStore(client, {
      selectionId: () => '44444444-4444-4444-8444-444444444444',
    });
    await store.initialize();

    const first = store.stageAttachmentFiles([imageFile('first.png')]);
    const duplicate = store.stageAttachmentFiles([imageFile('duplicate.png')]);
    expect(store.getState().attachmentSelectionPending).toBe(true);
    expect(client.importCalls).toEqual([{
      selectionId: '44444444-4444-4444-8444-444444444444',
      fileNames: ['first.png'],
    }]);

    selection.resolve([{
      id: '55555555-5555-4555-8555-555555555555',
      selectionId: '44444444-4444-4444-8444-444444444444',
      name: 'first.png', kind: 'image', mediaType: 'image/png', sizeBytes: 120,
    }]);
    await Promise.all([first, duplicate]);
    expect(store.getState()).toMatchObject({
      attachmentSelectionPending: false,
      attachments: [expect.objectContaining({ name: 'first.png' })],
    });
    await store.dispose();
  });

  test('lets Native own attachment quota and presents its rejection without changing the draft', async () => {
    const client = AttachmentClient();
    const selectionIds = [
      '44444444-4444-4444-8444-444444444444',
      '77777777-7777-4777-8777-777777777777',
    ];
    const store = new ApplicationStore(client, { selectionId: () => selectionIds.shift()! });
    await store.initialize();
    await store.stageAttachmentFiles([imageFile('first.png'), imageFile('second.png')]);
    const original = structuredClone(store.getState().attachments);
    client.importResult = Promise.reject(Object.assign(new Error('native attachment quota rejected'), {
      code: 'attachment_draft_quota',
    }));
    await store.stageAttachmentFiles([imageFile('a.png'), imageFile('b.png'), imageFile('c.png')]);

    expect(store.getState()).toMatchObject({
      attachments: original,
      attachmentSelectionPending: false,
      error: { id: 'attachment_batch_rejected' },
    });
    expect(client.importCalls).toHaveLength(2);
    expect(client.abandonCalls).toEqual(['77777777-7777-4777-8777-777777777777']);
    await store.dispose();
  });

  test('does not send while the picker transaction is pending', async () => {
    const client = AttachmentClient();
    const selection = deferred<Awaited<ReturnType<PreviewDesktopClient['importAttachments']>>>();
    client.importResult = selection.promise;
    const store = new ApplicationStore(client, {
      selectionId: () => '44444444-4444-4444-8444-444444444444',
    });
    await store.initialize();
    store.setDraft('画像選択中は送らない');

    const choosing = store.stageAttachmentFiles([imageFile()]);
    await store.sendMessage();
    expect(client.sendCalls).toEqual([]);
    selection.resolve([]);
    await choosing;
    await store.dispose();
  });

  test('stale picker completion only cleans its Native selection', async () => {
    const client = AttachmentClient();
    const selection = deferred<Awaited<ReturnType<PreviewDesktopClient['importAttachments']>>>();
    client.importResult = selection.promise;
    const store = new ApplicationStore(client, {
      selectionId: () => '44444444-4444-4444-8444-444444444444',
    });
    await store.initialize();
    const choosing = store.stageAttachmentFiles([imageFile()]);
    await store.dispose();
    const disposedState = structuredClone(store.getState());

    selection.resolve([{
      id: '55555555-5555-4555-8555-555555555555',
      selectionId: '44444444-4444-4444-8444-444444444444',
      name: 'stale.png', kind: 'image', mediaType: 'image/png', sizeBytes: 120,
    }]);
    await choosing;

    expect(client.abandonCalls).toEqual(['44444444-4444-4444-8444-444444444444']);
    expect(store.getState()).toEqual(disposedState);
  });

  test('forgets exactly one sibling attachment before sending the remaining handle', async () => {
    const client = AttachmentClient();
    const store = new ApplicationStore(client, {
      selectionId: () => '44444444-4444-4444-8444-444444444444',
    });
    await store.initialize();
    await store.stageAttachmentFiles([imageFile('first.png'), imageFile('second.png')]);

    await store.removeAttachment('55555555-5555-4555-8555-555555555555');
    store.setDraft('残した画像だけ送る');
    await store.sendMessage();

    expect(client.forgetCalls).toEqual([{
      selectionId: '44444444-4444-4444-8444-444444444444',
      attachmentId: '55555555-5555-4555-8555-555555555555',
    }]);
    expect(client.sendCalls).toEqual([{
      targetAgentId: 'orchestrator',
      text: '残した画像だけ送る',
      attachmentRefs: [{
        selectionId: '44444444-4444-4444-8444-444444444444',
        publicId: '66666666-6666-4666-8666-666666666666',
      }],
      model: 'gpt-5.6-sol', effort: 'xhigh', accessMode: 'full_access', serviceTier: 'standard',
    }]);
    expect(store.getState().attachments).toEqual([]);
    await store.dispose();
  });

  test('keeps an attachment visible when exact Native removal fails', async () => {
    const client = AttachmentClient();
    client.forgetFailure = new Error('sealed cleanup failed');
    const store = new ApplicationStore(client, {
      selectionId: () => '44444444-4444-4444-8444-444444444444',
    });
    await store.initialize();
    await store.stageAttachmentFiles([imageFile('first.png'), imageFile('second.png')]);

    await store.removeAttachment('55555555-5555-4555-8555-555555555555');

    expect(store.getState().attachments).toHaveLength(2);
    expect(store.getState().error).toEqual({ id: 'generic_failure' });
    await store.dispose();
  });

  test('retires submitted attachment chips after Native owns a failed dispatch', async () => {
    const client = AttachmentClient();
    client.sendResult = Promise.reject(new DispatchSendError(Object.assign(
      new Error('text attachment contract rejected'),
      { code: 'attachment_text_contract_invalid' },
    ), null));
    const store = new ApplicationStore(client, {
      selectionId: () => '44444444-4444-4444-8444-444444444444',
    });
    await store.initialize();
    await store.stageAttachmentFiles([imageFile('first.png'), imageFile('second.png')]);
    store.setDraft('添付を送る');

    await store.sendMessage();
    await store.removeAttachment('55555555-5555-4555-8555-555555555555');

    expect(store.getState()).toMatchObject({
      draft: '添付を送る', attachments: [], error: { id: 'attachment_failed' },
    });
    expect(client.forgetCalls).toEqual([]);
    await store.dispose();
  });

  test('does not race per-handle removal against an in-flight send', async () => {
    const client = AttachmentClient();
    const sending = deferred<DispatchSendResult>();
    client.sendResult = sending.promise;
    const store = new ApplicationStore(client, {
      selectionId: () => '44444444-4444-4444-8444-444444444444',
    });
    await store.initialize();
    await store.stageAttachmentFiles([imageFile('first.png'), imageFile('second.png')]);
    store.setDraft('送信を先に始める');

    const send = store.sendMessage();
    await store.removeAttachment('55555555-5555-4555-8555-555555555555');

    expect(store.getState().sending).toBe(true);
    expect(client.forgetCalls).toEqual([]);
    sending.resolve({
      receipt: { dispatchId: 'dispatch-race', threadId: 'thread-orchestrator', turnId: 'turn-race' },
      dispatchRecovery: null,
    });
    await send;
    await store.dispose();
  });

  test('does not start a send while exact per-handle removal is in flight', async () => {
    const client = AttachmentClient();
    const forgetting = deferred<void>();
    client.forgetResult = forgetting.promise;
    const store = new ApplicationStore(client, {
      selectionId: () => '44444444-4444-4444-8444-444444444444',
    });
    await store.initialize();
    await store.stageAttachmentFiles([imageFile('first.png'), imageFile('second.png')]);
    store.setDraft('削除完了までは送らない');

    const remove = store.removeAttachment('55555555-5555-4555-8555-555555555555');
    await store.sendMessage();

    expect(store.getState().attachmentRemovalPending).toBe(true);
    expect(client.sendCalls).toEqual([]);
    forgetting.resolve();
    await remove;
    expect(store.getState().attachmentRemovalPending).toBe(false);
    await store.dispose();
  });

  test('keeps another agent draft selected while an earlier agent Stop settles', async () => {
    const client = ActiveTurnClient();
    client.activeByAgent.set('orchestrator', [{
      threadId: 'thread-a', turnId: 'turn-a', targetAgentId: 'orchestrator',
      state: 'in_progress', lastJournalSequence: 12,
    }]);
    const stop = deferred<void>();
    client.interruptResult = stop.promise;
    const store = new ApplicationStore(client);
    await store.initialize();
    await waitFor(() => expect(store.getState().executions.orchestrator).toBeDefined());

    const stopping = store.interruptActiveTurn();
    store.selectAgent('frontend');
    store.setDraft('frontend draft survives');
    stop.resolve();
    await stopping;

    await waitFor(() => expect(store.getState().conversationLoading).toBe(false));

    expect(store.getState()).toMatchObject({
      selectedAgentId: 'frontend', draft: 'frontend draft survives', conversationLoading: false,
    });
    expect(client.interruptCalls).toEqual([{
      targetAgentId: 'orchestrator', threadId: 'thread-a', turnId: 'turn-a',
    }]);
    await store.dispose();
  });

  test('restores the exact active turn when native Stop rejects it', async () => {
    const client = ActiveTurnClient();
    client.activeByAgent.set('orchestrator', [{
      threadId: 'thread-retry', turnId: 'turn-retry', targetAgentId: 'orchestrator',
      state: 'accepted', lastJournalSequence: 9,
    }]);
    client.interruptFailure = new Error('turn ownership changed');
    const store = new ApplicationStore(client);
    await store.initialize();
    await waitFor(() => expect(store.getState().executions.orchestrator).toBeDefined());

    await store.interruptActiveTurn();

    expect(store.getState().executions.orchestrator).toMatchObject({
      threadId: 'thread-retry', turnId: 'turn-retry', phase: 'accepted', canInterrupt: true,
    });
    expect(store.getState()).toMatchObject({
      error: { id: 'generic_failure' },
      executions: { orchestrator: { phase: 'accepted' } },
    });
    await store.dispose();
  });

  test('lands a projected turn on its exact failed or interrupted terminal state', async () => {
    const client = ActiveTurnClient();
    const store = new ApplicationStore(client);
    client.activeByAgent.set('orchestrator', [{
      threadId: 'thread-terminal', turnId: 'turn-terminal', targetAgentId: 'orchestrator',
      state: 'in_progress', lastJournalSequence: 20,
    }]);
    client.latestByAgent.set('orchestrator', {
      threadId: 'thread-terminal', turnId: 'turn-terminal', targetAgentId: 'orchestrator',
      state: 'in_progress', lastJournalSequence: 20,
    });
    await store.initialize();
    await waitFor(() => expect(store.getState().executions.orchestrator?.phase).toBe('working'));

    client.activeByAgent.set('orchestrator', []);
    client.latestByAgent.set('orchestrator', {
      threadId: 'thread-terminal', turnId: 'turn-terminal', targetAgentId: 'orchestrator',
      state: 'failed', lastJournalSequence: 21,
    });
    await store.loadConversation('orchestrator');
    expect(store.getState().executions.orchestrator).toMatchObject({
      phase: 'failed', threadId: 'thread-terminal', turnId: 'turn-terminal',
    });

    client.activeByAgent.set('orchestrator', [{
      threadId: 'thread-second', turnId: 'turn-second', targetAgentId: 'orchestrator',
      state: 'in_progress', lastJournalSequence: 22,
    }]);
    client.latestByAgent.set('orchestrator', {
      threadId: 'thread-second', turnId: 'turn-second', targetAgentId: 'orchestrator',
      state: 'in_progress', lastJournalSequence: 22,
    });
    await store.loadConversation('orchestrator');
    client.activeByAgent.set('orchestrator', []);
    client.latestByAgent.set('orchestrator', {
      threadId: 'thread-second', turnId: 'turn-second', targetAgentId: 'orchestrator',
      state: 'interrupted', lastJournalSequence: 23,
    });
    await store.loadConversation('orchestrator');
    expect(store.getState().executions.orchestrator).toMatchObject({
      phase: 'interrupted', threadId: 'thread-second', turnId: 'turn-second',
    });
    await store.dispose();
  });

  test('hides an invalidated stream immediately when baseline recovery fails', async () => {
    const client = ResetBaselineFailureClient();
    const store = new ApplicationStore(client);
    await store.initialize();
    await waitFor(() => expect(store.getState().messages).toHaveLength(2));

    client.resetThenFail = true;
    await store.loadConversation('orchestrator');
    expect(store.getState()).toMatchObject({
      messages: [], conversationOlderCursor: null, conversationLoading: false,
      error: { id: 'generic_failure' },
    });

    client.resetThenFail = false;
    store.clearError();
    await store.loadConversation('orchestrator');
    expect(store.getState().messages).toHaveLength(2);
    await store.dispose();
  });

  test('keeps the Luca overlay fail-closed when its replacement stream cannot be established', async () => {
    const client = ResetBaselineFailureClient();
    const store = new ApplicationStore(client);
    await store.initialize();
    store.openSupport('security');
    await waitFor(() => expect(store.getState().supportMessages).toHaveLength(5));

    client.resetThenFail = true;
    await store.loadSupportConversation('security');
    expect(store.getState()).toMatchObject({
      supportMessages: [], supportConversationLoading: false,
      error: { id: 'generic_failure' },
    });
    await store.dispose();
  });

  test('routes a Luca overlay send through the shared accepted-turn lifecycle exactly once', async () => {
    const client = ActiveTurnClient();
    const store = new ApplicationStore(client);
    await store.initialize();
    store.openSupport('security');
    await waitFor(() => expect(store.getState().supportMessages).toHaveLength(5));
    store.setSupportDraft('この状態を確認して');

    const first = store.sendSupportMessage();
    const duplicate = store.sendSupportMessage();
    await Promise.all([first, duplicate]);

    expect(client.sendCalls).toEqual([{
      targetAgentId: 'security', text: 'この状態を確認して', attachmentRefs: [],
      model: 'gpt-5.6-sol', effort: 'xhigh', accessMode: 'full_access', serviceTier: 'standard',
    }]);
    expect(store.getState()).toMatchObject({
      sending: false,
      supportSending: false,
      supportDraft: '',
      notice: null,
      executions: {
        security: {
          phase: 'accepted',
          threadId: 'thread-security',
          turnId: 'turn-1',
        },
      },
    });
    await store.dispose();
  });

  test('does not start a second Luca turn while that agent already owns an active turn', async () => {
    const client = ActiveTurnClient();
    client.activeByAgent.set('security', [{
      threadId: 'thread-luca-active', turnId: 'turn-luca-active', targetAgentId: 'security',
      state: 'in_progress', lastJournalSequence: 20,
    }]);
    const store = new ApplicationStore(client);
    await store.initialize();
    store.openSupport('security');
    await waitFor(() => expect(store.getState().executions.security?.phase).toBe('working'));
    store.setSupportDraft('二重送信してはいけない');

    await store.sendSupportMessage();

    expect(client.sendCalls).toEqual([]);
    expect(store.getState().supportDraft).toBe('二重送信してはいけない');
    await store.dispose();
  });

  test.each(['prepared_outcome_unknown', 'cleanup_pending'] as const)(
    'blocks Luca overlay send while project dispatch recovery is %s',
    async (kind) => {
      const client = PassiveStatusClient();
      const store = new ApplicationStore(client);
      await store.initialize();
      store.openSupport('security');
      await waitFor(() => expect(store.getState().supportMessages).toHaveLength(5));
      client.emitScenarioEvent({
        type: 'dispatch_recovery',
        projectId: 'orquesta-v5',
        recovery: {
          kind,
          dispatchId: `support-${kind}`,
          projectId: 'orquesta-v5',
          targetAgentId: 'security',
          createdAt: '2026-08-30T11:28:25.000Z',
          reason: null,
          threadId: null,
          turnId: null,
        },
      });
      store.setSupportDraft('復旧前には送信しない');

      await store.sendSupportMessage();

      expect(client.sendCalls).toBe(0);
      expect(store.getState()).toMatchObject({
        supportDraft: '復旧前には送信しない',
        notice: { id: 'recover_before_send' },
      });
      await store.dispose();
    },
  );

  test('does not let an overlay conversation replace the project pending-request authority', async () => {
    const client = PassiveStatusClient();
    const readConversation = client.readConversation.bind(client);
    vi.spyOn(client, 'readConversation').mockImplementation(async (...args) => {
      const page = await readConversation(...args);
      return args[1] === 'security' ? { ...page, pendingRequests: [] } : page;
    });
    const store = new ApplicationStore(client);
    await store.initialize();
    await waitFor(() => expect(store.getState().projectedPendingRequests).toHaveLength(1));

    store.openSupport('security');
    await waitFor(() => expect(store.getState().supportMessages).toHaveLength(5));

    expect(store.getState().projectedPendingRequests).toHaveLength(1);
    await store.dispose();
  });

  test('refreshes live approval state on connection changes without rewriting history or duplicating a shared read', async ({ onTestFinished }) => {
    const client = PassiveStatusClient();
    const readConversation = client.readConversation.bind(client);
    let connected = true;
    const readSpy = vi.spyOn(client, 'readConversation').mockImplementation(async (...args) => {
      const page = await readConversation(...args);
      return {
        ...page,
        pendingRequests: page.pendingRequests.map((request) => ({
          ...request, recoveryState: connected ? 'actionable' as const : 'stale' as const,
        })),
      };
    });
    const historySpy = vi.spyOn(client, 'readHistoryIndex');
    const store = new ApplicationStore(client);
    onTestFinished(() => store.dispose());
    await store.initialize();
    await waitFor(() => expect(store.getState().projectedPendingRequests[0]?.recoveryState).toBe('actionable'));
    store.openSupport('security');
    await waitFor(() => expect(store.getState().supportConversationLoading).toBe(false));
    readSpy.mockClear();
    historySpy.mockClear();

    client.emitScenarioEvent({ type: 'runtime', event: { type: 'runtime.notification', notification: { kind: 'thread_status' } } });
    expect(readSpy).not.toHaveBeenCalled();
    connected = false;
    client.emitScenarioEvent({
      type: 'runtime', event: {
        type: 'runtime.notification',
        notification: { kind: 'provider_connection', providerConnectionId: 'connection-a', state: 'disconnected' },
      },
    });
    await waitFor(() => expect(store.getState().projectedPendingRequests[0]?.recoveryState).toBe('stale'));
    expect(readSpy.mock.calls.map((call) => call[1]).sort()).toEqual(['orchestrator', 'security']);
    expect(historySpy).not.toHaveBeenCalled();

    store.openSupport('orchestrator');
    await waitFor(() => expect(store.getState().supportConversationLoading).toBe(false));
    readSpy.mockClear();
    connected = true;
    client.emitScenarioEvent({
      type: 'runtime', event: {
        type: 'runtime.notification',
        notification: { kind: 'provider_connection', providerConnectionId: 'connection-b', state: 'connected' },
      },
    });
    await waitFor(() => expect(store.getState().projectedPendingRequests[0]?.recoveryState).toBe('actionable'));
    expect(readSpy.mock.calls.map((call) => call[1])).toEqual(['orchestrator']);
    expect(store.getState().supportMessages).toEqual(store.getState().messages);
    expect(historySpy).not.toHaveBeenCalled();
  });

  test('pages pending requests through the existing older-conversation path and preserves the current live request', async () => {
    const client = PassiveStatusClient();
    const readConversation = client.readConversation.bind(client);
    const readSpy = vi.spyOn(client, 'readConversation').mockImplementation(async (...args) => {
      const page = await readConversation(...args);
      if (args[1] !== 'orchestrator') return page;
      if (args[5] === 'pending-page-2') {
        return {
          ...page,
          items: [],
          activities: [],
          olderCursor: null,
          activityOlderCursor: null,
          pendingRequestOlderCursor: null,
          pendingRequests: [{
            requestKey: 'stale-approval-201', agentId: 'orchestrator',
            requestKind: 'attention.approval_requested' as const,
            responseOptions: ['accept', 'decline'], prompt: null,
            createdAt: '2026-08-01T00:00:00.000Z', requestedEffectKind: 'command_execution',
            responsePhase: null, recoveryState: 'stale' as const,
          }],
        };
      }
      return {
        ...page,
        pendingRequestOlderCursor: 'pending-page-2',
        pendingRequests: [{
          requestKey: 'current-live-approval', agentId: 'orchestrator',
          requestKind: 'attention.approval_requested' as const,
          responseOptions: ['accept', 'decline'], prompt: null,
          createdAt: '2026-08-31T00:00:00.000Z', requestedEffectKind: 'command_execution',
          responsePhase: null, recoveryState: 'actionable' as const,
        }],
      };
    });
    const store = new ApplicationStore(client);
    await store.initialize();
    await waitFor(() => expect(store.getState().projectedPendingRequests).toEqual([
      expect.objectContaining({ requestKey: 'current-live-approval', recoveryState: 'actionable' }),
    ]));

    expect(store.getState().conversationOlderPendingRequestCursor).toBe('pending-page-2');
    await expect(store.loadOlderConversation('orchestrator')).resolves.toBe(true);
    expect(readSpy.mock.calls.some((call) => call[5] === 'pending-page-2')).toBe(true);
    expect(store.getState().projectedPendingRequests).toEqual([
      expect.objectContaining({ requestKey: 'current-live-approval', recoveryState: 'actionable' }),
      expect.objectContaining({ requestKey: 'stale-approval-201', recoveryState: 'stale' }),
    ]);
    expect(store.getState().conversationOlderPendingRequestCursor).toBeNull();
    await store.dispose();
  });

  test('refreshes one shared conversation read into WORK and Luca when both show the same agent', async () => {
    const client = PassiveStatusClient();
    const readConversation = client.readConversation.bind(client);
    let includeNewMessage = false;
    const readSpy = vi.spyOn(client, 'readConversation').mockImplementation(async (...args) => {
      const page = await readConversation(...args);
      if (!includeNewMessage || args[1] !== 'orchestrator') return page;
      return {
        ...page,
        appliedJournalSequence: page.appliedJournalSequence + 1,
        projectionRevision: page.projectionRevision + 1,
        items: [...page.items, {
          id: 'message-shared-overlay', role: 'agent' as const, targetAgentId: 'orchestrator',
          authorLabel: 'orchestrator', text: '共有された更新',
          createdAt: '2026-08-30T12:00:00.000Z', evidenceLabel: null,
        }],
      };
    });
    const store = new ApplicationStore(client);
    await store.initialize();
    await waitFor(() => expect(store.getState().messages.length).toBeGreaterThan(0));
    store.openSupport('orchestrator');
    await waitFor(() => expect(store.getState().supportMessages).toEqual(store.getState().messages));
    readSpy.mockClear();
    includeNewMessage = true;

    client.emitScenarioEvent({
      type: 'projection_changed', projectId: 'orquesta-v5', streamId: 'preview-stream',
      appliedJournalSequence: 3, projectionRevision: 3,
    });

    await waitFor(() => expect(store.getState().messages.at(-1)?.id).toBe('message-shared-overlay'));
    expect(store.getState().supportMessages.at(-1)?.id).toBe('message-shared-overlay');
    expect(readSpy.mock.calls.filter((call) => call[1] === 'orchestrator')).toHaveLength(1);
    await store.dispose();
  });

  test('keeps Luca owned after repeated WORK agent changes during shared reads', async () => {
    const client = PassiveStatusClient();
    const readConversation = client.readConversation.bind(client);
    const heldReads: Array<ReturnType<typeof deferred<void>>> = [];
    let holdOrchestratorReads = false;
    const readSpy = vi.spyOn(client, 'readConversation').mockImplementation(async (...args) => {
      if (holdOrchestratorReads && args[1] === 'orchestrator') {
        const gate = deferred<void>();
        heldReads.push(gate);
        await gate.promise;
      }
      return await readConversation(...args);
    });
    const store = new ApplicationStore(client);
    await store.initialize();
    await waitFor(() => expect(store.getState().messages.length).toBeGreaterThan(0));
    readSpy.mockClear();
    holdOrchestratorReads = true;

    store.openSupport('orchestrator');
    await waitFor(() => expect(heldReads).toHaveLength(1));
    expect(store.getState().supportConversationLoading).toBe(true);
    store.selectAgent('security');
    await waitFor(() => expect(heldReads).toHaveLength(2));
    store.selectAgent('orchestrator');
    await waitFor(() => expect(heldReads).toHaveLength(3));
    store.selectAgent('security');
    await waitFor(() => expect(heldReads).toHaveLength(4));
    holdOrchestratorReads = false;
    for (const read of heldReads) read.resolve();

    await waitFor(() => expect(store.getState()).toMatchObject({
      selectedAgentId: 'security',
      supportAgentId: 'orchestrator',
      supportConversationLoading: false,
    }));
    expect(store.getState().supportMessages.length).toBeGreaterThan(0);
    expect(readSpy.mock.calls.filter((call) => call[1] === 'orchestrator')).toHaveLength(4);
    await store.dispose();
  });

  test('closes Luca instead of leaving a shared read pending when its agent disappears', async () => {
    const client = PassiveStatusClient();
    const readConversation = client.readConversation.bind(client);
    const sharedRead = deferred<void>();
    let holdSharedRead = false;
    vi.spyOn(client, 'readConversation').mockImplementation(async (...args) => {
      if (holdSharedRead && args[1] === 'orchestrator') {
        holdSharedRead = false;
        await sharedRead.promise;
      }
      return await readConversation(...args);
    });
    const store = new ApplicationStore(client);
    await store.initialize();
    await waitFor(() => expect(store.getState().messages.length).toBeGreaterThan(0));
    holdSharedRead = true;

    store.openSupport('orchestrator');
    await waitFor(() => expect(store.getState().supportConversationLoading).toBe(true));
    client.emitScenarioEvent({
      type: 'snapshot',
      snapshot: {
        ...structuredClone(previewSnapshot),
        agents: previewSnapshot.agents.filter((agent) => agent.id !== 'orchestrator'),
      },
    });

    await waitFor(() => expect(store.getState()).toMatchObject({
      selectedAgentId: null,
      messages: [],
      activities: [],
      conversationLoading: false,
      supportAgentId: null,
      supportMessages: [],
      supportConversationLoading: false,
    }));
    sharedRead.resolve();
    await waitFor(() => expect(store.getState()).toMatchObject({
      selectedAgentId: null,
      messages: [],
      activities: [],
      conversationLoading: false,
      supportAgentId: null,
    }));
    await store.dispose();
  });

  test('applies the same Luca ownership rule after an action refreshes the snapshot', async () => {
    const client = PassiveStatusClient();
    const readConversation = client.readConversation.bind(client);
    const sharedRead = deferred<void>();
    let holdSharedRead = false;
    vi.spyOn(client, 'readConversation').mockImplementation(async (...args) => {
      if (holdSharedRead && args[1] === 'orchestrator') {
        holdSharedRead = false;
        await sharedRead.promise;
      }
      return await readConversation(...args);
    });
    const store = new ApplicationStore(client);
    await store.initialize();
    await waitFor(() => expect(store.getState().messages.length).toBeGreaterThan(0));
    vi.spyOn(client, 'startInspection').mockResolvedValue('inspection-refresh');
    vi.spyOn(client, 'readSnapshot').mockResolvedValue({
      ...structuredClone(previewSnapshot),
      agents: previewSnapshot.agents.filter((agent) => agent.id !== 'orchestrator'),
    });
    holdSharedRead = true;

    store.openSupport('orchestrator');
    await waitFor(() => expect(store.getState().supportConversationLoading).toBe(true));
    const refreshing = store.startInspection('adversarial_audit', 'snapshot ownership');

    await waitFor(() => expect(store.getState()).toMatchObject({
      selectedAgentId: null,
      messages: [],
      activities: [],
      conversationLoading: false,
      supportAgentId: null,
      supportMessages: [],
      supportConversationLoading: false,
    }));
    sharedRead.resolve();
    await refreshing;
    expect(store.getState()).toMatchObject({
      selectedAgentId: null,
      messages: [],
      activities: [],
      conversationLoading: false,
      supportAgentId: null,
    });
    await store.dispose();
  });

  test('does not run a stale approval follow-up read after Stop invalidates the lifecycle epoch', async () => {
    const client = DeferredApprovalClient();
    const store = new ApplicationStore(client);
    await store.initialize();
    await waitFor(() => expect(store.getState().projectedPendingRequests).toEqual([
      expect.objectContaining({ requestKey: 'runtime-approval-req-1', recoveryState: 'actionable' }),
    ]));
    const resolving = store.respondToApproval('runtime-approval-req-1', 'accept');
    expect(client.approvalStarted).toBe(true);

    await store.stopRuntime();
    expect(store.getState().phase).toBe('launcher');
    client.resolveApproval();
    await resolving;
    expect(client.snapshotReads).toBe(0);
    await store.dispose();
  });

  test('does not run a stale inspection follow-up read after Stop invalidates the lifecycle epoch', async () => {
    const client = DeferredApprovalClient();
    const store = new ApplicationStore(client);
    await store.initialize();
    const starting = store.startInspection('adversarial_audit', 'session ownership');
    expect(client.inspectionStarted).toBe(true);

    await store.stopRuntime();
    expect(store.getState().phase).toBe('launcher');
    client.resolveInspection();
    await starting;
    expect(client.snapshotReads).toBe(0);
    await store.dispose();
  });

  test('passive status progress invalidates an in-flight conversation and clears its loading owner', async () => {
    const client = PassiveStatusClient();
    const conversation = deferred<Awaited<ReturnType<PreviewDesktopClient['readConversation']>>>();
    vi.spyOn(client, 'readConversation').mockImplementation(() => conversation.promise);
    const store = new ApplicationStore(client);
    await store.initialize();
    await waitFor(() => expect(store.getState().conversationLoading).toBe(true));
    const status = store.getState().runtimeStatus!;

    client.emitStatus({ ...status, statusRevision: status.statusRevision + 1 });
    expect(store.getState().conversationLoading).toBe(false);
    conversation.resolve({
      source: 'sqlite',
      projectId: 'orquesta-v5',
      targetAgentId: 'orchestrator',
      streamId: 'stale-stream',
      appliedJournalSequence: 1,
      projectionRevision: 1,
      syncState: 'current',
      items: [{
        id: 'stale-message', role: 'agent', targetAgentId: 'orchestrator', authorLabel: 'OLD',
        text: 'must not re-enter', createdAt: '2026-08-10T00:00:00.000Z', evidenceLabel: null,
      }],
      activities: [],
      olderCursor: null,
      activityOlderCursor: null,
      pendingRequestOlderCursor: null,
      pendingRequests: [],
      resolvedRequests: [],
      activeTurns: [],
      latestTurn: null,
    });
    await waitFor(() => expect(store.getState().messages).toEqual([]));
    expect(store.getState().conversationLoading).toBe(false);
    await store.dispose();
  });

  test('a stale activation rejection cannot erase a newer passively committed authority', async () => {
    const client = DeferredActivationClient();
    const store = new ApplicationStore(client);
    await store.initialize();
    const renderer = store.getState().rendererAuthority!;
    const previous = store.getState().runtimeStatus!;
    const selecting = store.selectProject('research-ops');

    client.emitStatus({
      ...previous,
      projectId: 'research-ops',
      activationToken: 'passive-new-activation',
      rendererSessionId: renderer.rendererSessionId,
      rendererGeneration: renderer.rendererGeneration,
      runtimeGeneration: RUNTIME_GENERATION_A,
      statusRevision: previous.statusRevision + 1,
    });
    client.activation.reject(new Error('old activation response failed'));
    await selecting;

    expect(store.getState()).toMatchObject({
      phase: 'workspace', selectedProjectId: 'research-ops', error: null,
      runtimeAuthority: { projectId: 'research-ops', activationToken: 'passive-new-activation' },
    });
    await store.dispose();
  });

  test('hydrates a passively replaced ready runtime under the new epoch instead of leaving a blank workspace', async () => {
    const client = DeferredActivationClient();
    const store = new ApplicationStore(client);
    await store.initialize();
    const previous = store.getState().runtimeStatus!;

    client.emitStatus({
      ...previous,
      activationToken: 'passive-replacement',
      runtimeGeneration: RUNTIME_GENERATION_A,
      statusRevision: previous.statusRevision + 1,
    });

    await waitFor(() => expect(store.getState()).toMatchObject({
      phase: 'workspace',
      runtimeAuthority: { projectId: 'orquesta-v5', activationToken: 'passive-replacement' },
      snapshot: { project: { id: 'orquesta-v5' } },
      selectedAgentId: 'orchestrator',
    }));
    await store.dispose();
  });

  test('re-drives the exact unexpected-runtime stop when its owner changes during the first stop', async () => {
    const client = PassiveStatusClient();
    const firstStop = deferred<RuntimeStatus>();
    const stoppedAuthorities: RuntimeAuthority[] = [];
    vi.spyOn(client, 'stopRuntime').mockImplementation(async (authority) => {
      stoppedAuthorities.push(authority);
      if (stoppedAuthorities.length === 1) return firstStop.promise;
      return {
        lifecycle: 'Stopped', projectId: null, activationToken: null,
        rendererSessionId: authority.rendererSessionId, rendererGeneration: authority.rendererGeneration,
        runtimeGeneration: RUNTIME_GENERATION_C, statusRevision: 15, failureReason: null,
      };
    });
    const store = new ApplicationStore(client);
    await store.initialize();
    const initial = store.getState().runtimeStatus!;
    const renderer = store.getState().rendererAuthority!;
    const firstUnexpected: RuntimeStatus = {
      ...initial,
      projectId: 'research-ops', activationToken: 'unexpected-a',
      runtimeGeneration: RUNTIME_GENERATION_A, statusRevision: 13,
    };
    const secondUnexpected: RuntimeStatus = {
      ...initial,
      projectId: 'rogue-project', activationToken: 'unexpected-b',
      runtimeGeneration: RUNTIME_GENERATION_B, statusRevision: 14,
    };

    client.emitStatus(firstUnexpected);
    expect(stoppedAuthorities.map((authority) => authority.activationToken)).toEqual(['unexpected-a']);
    client.emitStatus(secondUnexpected);
    firstStop.resolve(secondUnexpected);

    await waitFor(() => expect(stoppedAuthorities.map((authority) => authority.activationToken)).toEqual([
      'unexpected-a', 'unexpected-b',
    ]));
    await waitFor(() => expect(store.getState()).toMatchObject({ phase: 'launcher', runtimeAuthority: null }));
    expect(store.getState().rendererAuthority).toEqual(renderer);
    await store.dispose();
  });

  test('does not let an older snapshot read overwrite a newer runtime snapshot event', async () => {
    const client = PassiveStatusClient();
    const snapshotRead = deferred<WorkspaceSnapshot>();
    vi.spyOn(client, 'respondToApproval').mockResolvedValue();
    vi.spyOn(client, 'readSnapshot').mockImplementation(() => snapshotRead.promise);
    const store = new ApplicationStore(client);
    await store.initialize();
    await waitFor(() => expect(store.getState().projectedPendingRequests).toEqual([
      expect.objectContaining({ requestKey: 'runtime-approval-req-1', recoveryState: 'actionable' }),
    ]));
    const reading = store.respondToApproval('runtime-approval-req-1', 'accept');
    await waitFor(() => expect(store.getState().actionPendingId).toBe('runtime-approval-req-1'));

    const eventSnapshot = structuredClone(previewSnapshot);
    eventSnapshot.project.summary = 'newer event snapshot';
    client.emitScenarioEvent({ type: 'snapshot', snapshot: eventSnapshot });
    const staleRead = structuredClone(previewSnapshot);
    staleRead.project.summary = 'older read snapshot';
    snapshotRead.resolve(staleRead);
    await reading;

    expect(store.getState().snapshot?.project.summary).toBe('newer event snapshot');
    await store.dispose();
  });

  test('all activation paths await one shared project bootstrap instead of reporting a false failure', async () => {
    const client = DeferredProjectBootstrapClient();
    const store = new ApplicationStore(client);
    await store.initialize();

    const selecting = store.selectProject('research-ops');
    await waitFor(() => expect(client.bootstrapCalls).toBe(1));
    expect(store.getState()).toMatchObject({
      phase: 'workspace', selectedProjectId: 'research-ops', projectStartPending: true,
    });

    client.bootstrapGate.resolve();
    await expect(selecting).resolves.toBe(true);

    expect(client.bootstrapCalls).toBe(1);
    expect(store.getState()).toMatchObject({
      phase: 'workspace', selectedProjectId: 'research-ops', selectedAgentId: 'orchestrator',
      projectStartPending: false, projectBootstrap: { status: 'ready' }, error: null,
    });
    await store.dispose();
  });

  test('shares the whole project preparation while a same-runtime status revision advances', async () => {
    const client = DeferredProjectBootstrapClient();
    client.blockSnapshot = true;
    const store = new ApplicationStore(client);
    await store.initialize();

    const selecting = store.selectProject('research-ops');
    await waitFor(() => expect(client.snapshotReads).toBe(1));
    const status = store.getState().runtimeStatus!;
    client.emitStatus({ ...status, statusRevision: status.statusRevision + 1 });

    expect(client.snapshotReads).toBe(1);
    client.snapshotGate.resolve();
    await waitFor(() => expect(client.bootstrapCalls).toBe(1));
    client.bootstrapGate.resolve();
    await expect(selecting).resolves.toBe(true);
    expect(client.bootstrapCalls).toBe(1);
    await store.dispose();
  });

  test('coalesces business and workflow reads across a same-owner status advance', async () => {
    const client = PassiveStatusClient();
    const businessGate = deferred<Awaited<ReturnType<PreviewDesktopClient['readBusinessWorkOrders']>>>();
    const workflowGate = deferred<Awaited<ReturnType<PreviewDesktopClient['readWorkflowCatalog']>>>();
    const readBusinessFixture = client.readBusinessWorkOrders.bind(client);
    const readWorkflowFixture = client.readWorkflowCatalog.bind(client);
    const businessSpy = vi.spyOn(client, 'readBusinessWorkOrders').mockImplementation(() => businessGate.promise);
    const workflowSpy = vi.spyOn(client, 'readWorkflowCatalog').mockImplementation(() => workflowGate.promise);
    const store = new ApplicationStore(client);
    await store.initialize();
    await waitFor(() => expect([businessSpy.mock.calls.length, workflowSpy.mock.calls.length]).toEqual([1, 1]));

    const status = store.getState().runtimeStatus!;
    client.emitStatus({ ...status, statusRevision: status.statusRevision + 1 });
    const joinedReads = [
      store.refreshBusinessWorkOrders(),
      store.refreshWorkflowCatalog(),
    ];
    expect([businessSpy.mock.calls.length, workflowSpy.mock.calls.length]).toEqual([1, 1]);

    const authority = store.getState().runtimeAuthority!;
    const [business, workflow] = await Promise.all([
      readBusinessFixture(authority, { afterCursor: null, afterKey: null }),
      readWorkflowFixture(authority),
    ]);
    businessGate.resolve(business);
    workflowGate.resolve(workflow);
    await Promise.all(joinedReads);

    await waitFor(() => expect(store.getState()).toMatchObject({
      businessWorkOrders: business.items,
      businessCursor: business.cursor,
      workflowCatalog: workflow,
      businessLoading: false,
      workflowLoading: false,
    }));
    await store.dispose();
  });

  test('runs one fresh projection read after authoritative snapshot and workflow mutations', async () => {
    const client = PassiveStatusClient();
    const workflow = [
      deferred<Awaited<ReturnType<PreviewDesktopClient['readWorkflowCatalog']>>>(),
      deferred<Awaited<ReturnType<PreviewDesktopClient['readWorkflowCatalog']>>>(),
    ];
    const catalog: Awaited<ReturnType<PreviewDesktopClient['readWorkflowCatalog']>> = {
      definitions: [], batches: [], maxAttemptsPerBatch: 50,
    };
    const readWorkflowFixture = async (..._args: Parameters<PreviewDesktopClient['readWorkflowCatalog']>) => structuredClone(catalog);
    const workflowSpy = vi.spyOn(client, 'readWorkflowCatalog').mockImplementation((...args) =>
      workflow[workflowSpy.mock.calls.length - 1]?.promise ?? readWorkflowFixture(...args));
    const workflowMutationSpy = vi.spyOn(client, 'saveWorkflowDefinition').mockImplementation(async (_authority, input) => {
      const workflowId = 'workflow-authoritative';
      catalog.definitions = [{
        workflowId, name: input.name, prompt: input.prompt, checks: structuredClone(input.checks),
        createdAt: '2026-08-29T00:00:00.000Z', updatedAt: '2026-08-29T00:00:00.000Z',
      }];
      return workflowId;
    });
    const store = new ApplicationStore(client);
    await store.initialize();
    await waitFor(() => expect(workflowSpy.mock.calls.length).toBe(1));

    const authority = store.getState().runtimeAuthority!;
    const oldWorkflow = await readWorkflowFixture(authority);
    client.emitScenarioEvent({ type: 'snapshot', snapshot: structuredClone(store.getState().snapshot!) });
    const saving = store.saveWorkflowDefinition({
      workflowId: null,
      name: 'Current contract refresh',
      prompt: 'Refresh the durable catalog after this mutation.',
      checks: [],
    });
    await waitFor(() => expect(workflowMutationSpy).toHaveBeenCalledOnce());

    workflow[0].resolve(oldWorkflow);
    await waitFor(() => expect(workflowSpy.mock.calls.length).toBe(2));

    const freshWorkflow = await readWorkflowFixture(authority);
    workflow[1].resolve(freshWorkflow);
    await saving;

    await waitFor(() => expect(store.getState()).toMatchObject({
      workflowCatalog: freshWorkflow,
      workflowLoading: false,
    }));
    expect(freshWorkflow.definitions).toHaveLength(1);
    await store.dispose();
  });

  test('does not blindly retry a failed bootstrap inside one activation but allows the next explicit retry', async () => {
    const client = DeferredProjectBootstrapClient();
    client.failNextBootstrap = true;
    client.bootstrapGate.resolve();
    const store = new ApplicationStore(client);
    await store.initialize();

    await expect(store.selectProject('research-ops')).resolves.toBe(false);

    expect(client.bootstrapCalls).toBe(1);
    expect(store.getState()).toMatchObject({
      phase: 'workspace', selectedProjectId: 'research-ops', projectStartPending: false,
      projectBootstrap: null,
      error: { id: 'generic_failure' },
    });

    await expect(store.selectProject('research-ops')).resolves.toBe(true);
    expect(client.bootstrapCalls).toBe(2);
    expect(store.getState()).toMatchObject({
      phase: 'workspace', selectedProjectId: 'research-ops', selectedAgentId: 'orchestrator',
      projectStartPending: false, projectBootstrap: { status: 'ready' }, error: null,
    });
    await store.dispose();
  });

  test('atomically drops old pending actions and projection checkpoints on same-project incarnation change', async () => {
    const client = PassiveStatusClient();
    const conversationCheckpoints: ConversationReadCheckpoint[] = [];
    const readConversation = client.readConversation.bind(client);
    vi.spyOn(client, 'readConversation').mockImplementation((authority, targetAgentId, checkpoint, cursor, activityCursor) => {
      conversationCheckpoints.push(structuredClone(checkpoint));
      return readConversation(authority, targetAgentId, checkpoint, cursor, activityCursor);
    });
    const approvalSpy = vi.spyOn(client, 'respondToApproval').mockResolvedValue();
    const store = new ApplicationStore(client);
    await store.initialize();
    await waitFor(() => expect(store.getState().projectedPendingRequests).toEqual([
      expect.objectContaining({ requestKey: 'runtime-approval-req-1', recoveryState: 'actionable' }),
    ]));
    await waitFor(() => expect(conversationCheckpoints.length).toBeGreaterThan(0));
    const previous = store.getState().runtimeStatus!;

    client.emitStatus({
      ...previous,
      activationToken: 'same-project-new-incarnation',
      runtimeGeneration: RUNTIME_GENERATION_B,
      statusRevision: previous.statusRevision + 1,
    });

    expect(store.getState().projectedPendingRequests).toEqual([]);
    await store.respondToApproval('runtime-approval-req-1', 'accept');
    expect(approvalSpy).not.toHaveBeenCalled();
    await store.loadConversation('orchestrator');
    expect(store.getState().projectedPendingRequests).toEqual([
      expect.objectContaining({ requestKey: 'runtime-approval-req-1', recoveryState: 'stale' }),
    ]);
    expect(conversationCheckpoints.length).toBeGreaterThan(1);
    expect(conversationCheckpoints.at(-1)).toMatchObject({
      streamId: null,
      journalSequence: 0,
      projectionRevision: 0,
    });
    await store.dispose();
  });

  test.each([
    ['mismatched_approval', 'runtime-approval-req-1', 'accept'],
    ['user_input', 'user-input-1', 'continue'],
  ] as const)('never submits a Native-classified stale %s request', async (kind, requestKey, decision) => {
    const client = new PreviewDesktopClient();
    const readConversation = client.readConversation.bind(client);
    vi.spyOn(client, 'readConversation').mockImplementation(async (authority, targetAgentId, checkpoint, cursor, activityCursor) => ({
      ...await readConversation(authority, targetAgentId, checkpoint, cursor, activityCursor),
      pendingRequests: kind === 'mismatched_approval' ? [{
        requestKey: 'runtime-approval-req-1', agentId: 'security',
        requestKind: 'attention.approval_requested' as const,
        responseOptions: ['accept', 'decline'], prompt: 'stale approval', createdAt: '2026-08-16T10:00:00.000Z',
        requestedEffectKind: 'file_change' as const, responsePhase: null, recoveryState: 'stale' as const,
      }] : [{
        requestKey: 'user-input-1', agentId: 'security',
        requestKind: 'attention.user_input_requested' as const,
        responseOptions: ['continue'], prompt: 'stale question', createdAt: '2026-08-16T10:00:00.000Z',
        requestedEffectKind: null, responsePhase: null, recoveryState: 'stale' as const,
      }],
    }));
    const approvalSpy = vi.spyOn(client, 'respondToApproval').mockResolvedValue();
    const store = new ApplicationStore(client);
    await store.initialize();
    await waitFor(() => expect(store.getState().projectedPendingRequests).toEqual([
      expect.objectContaining({ requestKey, recoveryState: 'stale' }),
    ]));

    await store.respondToApproval(requestKey, decision);

    expect(approvalSpy).not.toHaveBeenCalled();
    expect(store.getState().actionPendingId).toBeNull();
    expect(store.getState().error).toEqual({ id: 'approval_stale' });
    await store.dispose();
  });

  test('keeps an outcome-unknown approval non-actionable across stale reads and duplicate clicks', async () => {
    const client = new PreviewDesktopClient();
    const readConversation = client.readConversation.bind(client);
    let outcomeUnknown = false;
    vi.spyOn(client, 'readConversation').mockImplementation(async (...args) => {
      const page = await readConversation(...args);
      return outcomeUnknown ? {
        ...page,
        pendingRequests: page.pendingRequests.map((request) => request.requestKey === 'runtime-approval-req-1'
          ? { ...request, responsePhase: 'outcome_unknown' as const, recoveryState: 'stale' as const }
          : request),
      } : page;
    });
    const approvalSpy = vi.spyOn(client, 'respondToApproval').mockImplementation(async () => {
      outcomeUnknown = true;
      throw { message: 'provider response outcome unknown', outcomeUnknown: true };
    });
    const store = new ApplicationStore(client);
    await store.initialize();
    await waitFor(() => expect(store.getState().projectedPendingRequests).toEqual([
      expect.objectContaining({ requestKey: 'runtime-approval-req-1', recoveryState: 'actionable' }),
    ]));

    await store.respondToApproval('runtime-approval-req-1', 'accept');
    await store.respondToApproval('runtime-approval-req-1', 'accept');

    expect(approvalSpy).toHaveBeenCalledOnce();
    expect(store.getState()).toMatchObject({
      actionPendingId: null,
      error: { id: 'approval_outcome_unknown' },
      projectedPendingRequests: [expect.objectContaining({
        requestKey: 'runtime-approval-req-1', responsePhase: 'outcome_unknown',
      })],
    });

    // A late page captured before Native persisted outcome_unknown must not
    // make the same response actionable again. Terminal omission may clear it.
    await store.loadConversation('orchestrator');
    expect(store.getState().projectedPendingRequests[0]).toMatchObject({
      requestKey: 'runtime-approval-req-1', recoveryState: 'stale', responsePhase: 'outcome_unknown',
    });
    await store.respondToApproval('runtime-approval-req-1', 'accept');
    expect(approvalSpy).toHaveBeenCalledOnce();
    await store.dispose();
  });

  test('isolates throwing subscribers from later state observers', async () => {
    const store = new ApplicationStore(new PreviewDesktopClient());
    await store.initialize();
    let observed = 0;
    store.subscribe(() => { throw new Error('host observer failed'); });
    store.subscribe(() => { observed += 1; });
    store.setDraft('safe transition');
    await waitFor(() => expect(observed).toBe(1));
    expect(store.getState().draft).toBe('safe transition');
    await store.dispose();
  });

  test('auto-inserts a current exact-bound transcript without acknowledging or sending it', async () => {
    const client = VoiceSendTrackingClient();
    const store = new ApplicationStore(client, {
      selectionId: () => '88888888-8888-4888-8888-888888888888',
    });
    await store.initialize();
    store.setDraft('既存の指示');
    const prepared = store.prepareVoiceCapture();
    expect(prepared).toEqual({ operationRef: '88888888-8888-4888-8888-888888888888' });
    store.markVoiceRecording(prepared!.operationRef);

    await store.submitVoiceCapture(prepared!.operationRef, new Uint8Array(3_200), 1_600);

    await waitFor(() => expect(store.getState().draft).toBe('既存の指示 プレビュー音声入力'));
    expect(store.getState()).toMatchObject({
      voiceCapturePhase: 'idle',
      voiceActiveOperationRef: null,
    });
    expect(client.ackCalls).toBe(0);
    expect(client.sendCalls).toBe(0);
    await store.dispose();
  });

  test('stores one send intent in the conversation reducer, inserts exactly, sends once, then acknowledges', async () => {
    const operationRef = '88888888-8888-4888-8888-888888888888';
    const client = VoiceSendTrackingClient();
    const store = new ApplicationStore(client, { selectionId: () => operationRef });
    await store.initialize();
    store.setDraft('既存の指示');
    expect(store.prepareVoiceCapture()).toEqual({ operationRef });
    store.markVoiceRecording(operationRef);

    expect(store.requestVoiceSendIntent(operationRef)).toBe(true);
    expect(store.getState().voiceSendIntentOperationRef).toBe(operationRef);
    await store.submitVoiceCapture(operationRef, new Uint8Array(3_200), 1_600);

    await waitFor(() => expect(client.sendCalls).toBe(1));
    await waitFor(() => expect(client.ackCalls).toBe(1));
    expect(store.getState()).toMatchObject({
      draft: '',
      voiceActiveOperationRef: null,
      voiceSendIntentOperationRef: null,
    });
    await store.dispose();
  });

  test('keeps an inserted transcript unacknowledged when the queued normal send is outcome unknown', async () => {
    const operationRef = '88888888-8888-4888-8888-888888888888';
    const client = VoiceSendTrackingClient();
    vi.spyOn(client, 'sendMessage').mockRejectedValue({ message: 'voice send outcome unknown', outcomeUnknown: true });
    const store = new ApplicationStore(client, { selectionId: () => operationRef });
    await store.initialize();
    store.setDraft('既存の指示');
    expect(store.prepareVoiceCapture()).toEqual({ operationRef });
    store.markVoiceRecording(operationRef);
    expect(store.requestVoiceSendIntent(operationRef)).toBe(true);

    await store.submitVoiceCapture(operationRef, new Uint8Array(3_200), 1_600);

    await waitFor(() => expect(client.sendCalls).toBe(1));
    expect(client.ackCalls).toBe(0);
    expect(store.getState()).toMatchObject({
      draft: '既存の指示 プレビュー音声入力',
      voiceSendIntentOperationRef: null,
    });
    expect(store.getState().error).toEqual({ id: 'generic_failure' });
    await store.dispose();
  });

  test('keeps same-lifetime inserted suppression when acknowledgement is outcome unknown and Native still has the operation', async () => {
    const operationRef = '88888888-8888-4888-8888-888888888888';
    const client = VoiceSendTrackingClient();
    const readVoiceStatus = vi.mocked(client.readVoiceStatus).getMockImplementation()!;
    const readSpy = vi.spyOn(client, 'readVoiceStatus').mockImplementation(async (...args) => {
      const status = await readVoiceStatus(...args);
      return { ...status, revision: status.revision + readSpy.mock.calls.length };
    });
    vi.spyOn(client, 'acknowledgeVoiceTranscription').mockRejectedValue({
      message: 'voice ack outcome unknown', outcomeUnknown: true,
    });
    const store = new ApplicationStore(client, { selectionId: () => operationRef });
    await store.initialize();
    store.setDraft('既存の指示');
    expect(store.prepareVoiceCapture()).toEqual({ operationRef });
    store.markVoiceRecording(operationRef);
    expect(store.requestVoiceSendIntent(operationRef)).toBe(true);

    await store.submitVoiceCapture(operationRef, new Uint8Array(3_200), 1_600);

    await waitFor(() => expect(client.ackCalls).toBe(1));
    expect(client.sendCalls).toBe(1);
    expect(readSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(store.getState().voiceStatus?.operations).toContainEqual(
      expect.objectContaining({ operationRef, phase: 'transcribed' }),
    );
    expect(store.getState().voiceError).toEqual({ id: 'generic_failure' });
    await store.dispose();
  });

  test('cancelling before the durable transcription claim completes prevents the Native call', async () => {
    const operationRef = '88888888-8888-4888-8888-888888888888';
    const digest = deferred<ArrayBuffer>();
    const digestSpy = vi.spyOn(globalThis.crypto.subtle, 'digest')
      .mockImplementation(() => digest.promise);
    const client = VoiceSendTrackingClient();
    const store = new ApplicationStore(client, { selectionId: () => operationRef });
    try {
      await store.initialize();
      store.setDraft('録音前の本文');
      expect(store.prepareVoiceCapture()).toEqual({ operationRef });
      store.markVoiceRecording(operationRef);
      store.markVoiceCaptureStopping(operationRef);

      const submission = store.submitVoiceCapture(operationRef, new Uint8Array(3_200), 1_600);
      await waitFor(() => expect(digestSpy).toHaveBeenCalledTimes(1));
      store.cancelVoiceCapture(operationRef);
      digest.resolve(new Uint8Array(32).buffer);
      await submission;

      expect(client.transcribeCalls).toBe(0);
      expect(store.getState()).toMatchObject({
        voiceCapturePhase: 'idle', voiceActiveOperationRef: null, voiceSendIntentOperationRef: null,
      });
    } finally {
      digestSpy.mockRestore();
      await store.dispose();
    }
  });

  test('converges from transcribing to the durable Native terminal when the final voice event is missed', async () => {
    const operationRef = '88888888-8888-4888-8888-888888888888';
    const client = VoiceDurableTerminalWatcherClient();
    const store = new ApplicationStore(client, { selectionId: () => operationRef });
    await store.initialize();
    store.setDraft('録音前の入力');
    expect(store.prepareVoiceCapture()).toEqual({ operationRef });
    store.markVoiceRecording(operationRef);

    await store.submitVoiceCapture(operationRef, new Uint8Array(3_200), 1_600);
    expect(client.voiceStatusReads).toBe(1);
    expect(store.getState().voiceCapturePhase).toBe('transcribing');

    await waitFor(() => expect(store.getState().draft)
      .toBe('録音前の入力 イベントなしで完了した音声入力'));
    expect(client.voiceStatusReads).toBe(2);
    expect(store.getState()).toMatchObject({
      voiceCapturePhase: 'idle',
      voiceActiveOperationRef: null,
    });
    await store.dispose();
  });

  test('restarts one durable watcher after a nonterminal cancel response and stops at cancelled', async () => {
    vi.useFakeTimers();
    const operationRef = '88888888-8888-4888-8888-888888888888';
    const client = VoiceDurableTerminalWatcherClient(null);
    const store = new ApplicationStore(client, { selectionId: () => operationRef });
    try {
      await store.initialize();
      expect(store.prepareVoiceCapture()).toEqual({ operationRef });
      store.markVoiceRecording(operationRef);
      await store.submitVoiceCapture(operationRef, new Uint8Array(3_200), 1_600);

      await store.cancelVoiceTranscription(operationRef);
      expect(client.cancelCalls).toBe(1);
      expect(store.getState().voiceCapturePhase).toBe('cancelling');
      await vi.advanceTimersByTimeAsync(10_000);
      expect(store.getState()).toMatchObject({
        voiceCapturePhase: 'idle',
        voiceActiveOperationRef: null,
        voiceError: null,
      });
      const terminalReads = client.voiceStatusReads;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(client.voiceStatusReads).toBe(terminalReads);
      await store.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  test('keeps durable polling alive when the cancel response never settles and its terminal event is missed', async () => {
    vi.useFakeTimers();
    const operationRef = '88888888-8888-4888-8888-888888888888';
    const client = VoiceDurableTerminalWatcherClient(null, true);
    const store = new ApplicationStore(client, { selectionId: () => operationRef });
    try {
      await store.initialize();
      expect(store.prepareVoiceCapture()).toEqual({ operationRef });
      store.markVoiceRecording(operationRef);
      await store.submitVoiceCapture(operationRef, new Uint8Array(3_200), 1_600);

      void store.cancelVoiceTranscription(operationRef);
      expect(store.getState().voiceCapturePhase).toBe('cancelling');
      await vi.advanceTimersByTimeAsync(10_000);
      expect(store.getState()).toMatchObject({
        voiceCapturePhase: 'idle',
        voiceActiveOperationRef: null,
        voiceError: null,
      });
      expect(client.voiceStatusReads).toBe(2);
      const terminalReads = client.voiceStatusReads;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(client.voiceStatusReads).toBe(terminalReads);
      await store.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  test('does not let a failed cancel read overwrite a late terminal event', async () => {
    const operationRef = '88888888-8888-4888-8888-888888888888';
    const client = PassiveStatusClient();
    const readVoiceFixture = client.readVoiceStatus.bind(client);
    let status: VoiceStatus | null = null;
    let failCancelRead = false;
    vi.spyOn(client, 'transcribeVoicePcm').mockImplementation(async (renderer, operationRef, binding) => {
      const baseline = await readVoiceFixture(renderer);
      status = {
        ...baseline, revision: baseline.revision + 1,
        operations: [{ operationRef, composerBinding: voiceStatusBinding(binding), phase: 'transcribing', durationMs: 100, transcript: null, lastErrorCode: null }],
      };
      return { operationRef, composerBinding: voiceStatusBinding(binding), phase: 'staging', durationMs: 100, transcript: null, lastErrorCode: null };
    });
    vi.spyOn(client, 'readVoiceStatus').mockImplementation(async (renderer) => {
      const baseline = await readVoiceFixture(renderer);
      if (!status) return baseline;
      if (failCancelRead) {
        failCancelRead = false;
        status = {
          ...status, revision: status.revision + 1,
          operations: status.operations.map((candidate) => ({ ...candidate, phase: 'cancelled' as const, transcript: null })),
        };
        client.emitScenarioEvent({ type: 'voice_status', status: structuredClone(status) });
        throw new Error('cancel status read failed after terminal event');
      }
      return structuredClone(status);
    });
    vi.spyOn(client, 'cancelVoiceTranscription').mockImplementation(async () => {
      failCancelRead = true;
      throw { message: 'cancel response outcome unknown', outcomeUnknown: true };
    });
    const store = new ApplicationStore(client, { selectionId: () => operationRef });
    await store.initialize();
    expect(store.prepareVoiceCapture()).toEqual({ operationRef });
    store.markVoiceRecording(operationRef);
    await store.submitVoiceCapture(operationRef, new Uint8Array(3_200), 1_600);

    await store.cancelVoiceTranscription(operationRef);

    expect(store.getState()).toMatchObject({
      voiceCapturePhase: 'idle',
      voiceActiveOperationRef: null,
      voiceError: null,
    });
    await store.dispose();
  });

  test.each(['dispose', 'epoch'] as const)(
    'stops the durable voice watcher without another poll after %s change',
    async (stopKind) => {
      vi.useFakeTimers();
      const operationRef = '88888888-8888-4888-8888-888888888888';
      const client = VoiceDurableTerminalWatcherClient(null);
      const store = new ApplicationStore(client, { selectionId: () => operationRef });
      try {
        await store.initialize();
        expect(store.prepareVoiceCapture()).toEqual({ operationRef });
        store.markVoiceRecording(operationRef);
        await store.submitVoiceCapture(operationRef, new Uint8Array(3_200), 1_600);
        expect(client.voiceStatusReads).toBe(1);

        if (stopKind === 'dispose') {
          await store.dispose();
        } else {
          const status = store.getState().runtimeStatus!;
          client.emitStatus({ ...status, statusRevision: status.statusRevision + 1 });
        }
        await vi.advanceTimersByTimeAsync(10_000);
        expect(client.voiceStatusReads).toBe(1);
        if (stopKind === 'epoch') await store.dispose();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  test('captures voice in blank WORK and inserts it into the launcher draft without auto-sending', async () => {
    const operationRef = '88888888-8888-4888-8888-888888888888';
    const client = VoiceSendTrackingClient({ state: 'empty' });
    const store = new ApplicationStore(client, { selectionId: () => operationRef });
    await store.initialize();
    store.setDraft('最初の要望');

    expect(store.prepareVoiceCapture()).toEqual({ operationRef });
    store.markVoiceRecording(operationRef);
    await store.submitVoiceCapture(operationRef, new Uint8Array(3_200), 1_600);

    await waitFor(() => expect(store.getState().draft).toBe('最初の要望 プレビュー音声入力'));
    expect(client.ackCalls).toBe(0);
    expect(client.sendCalls).toBe(0);
    await store.dispose();
  });

  test('binds a launcher transcript acknowledgement only to the exact carried project draft and target', async () => {
    const operationRef = '88888888-8888-4888-8888-888888888888';
    const client = LauncherWithProjectsClient();
    const readSnapshot = vi.mocked(client.readSnapshot).getMockImplementation()!;
    vi.spyOn(client, 'readSnapshot').mockImplementation(async (...args) => {
      const snapshot = await readSnapshot(...args);
      return {
        ...snapshot,
        agents: snapshot.agents.map((agent) => ({
          ...agent, currentTaskId: null, currentTaskStatus: 'idle' as const, currentTaskTitle: null,
        })),
        tasks: [],
      };
    });
    const store = new ApplicationStore(client, { selectionId: () => operationRef });
    await store.initialize();
    store.setDraft('最初の要望');
    expect(store.prepareVoiceCapture()).toEqual({ operationRef });
    store.markVoiceRecording(operationRef);
    await store.submitVoiceCapture(operationRef, new Uint8Array(3_200), 1_600);
    await waitFor(() => expect(store.getState().draft).toBe('最初の要望 プレビュー音声入力'));

    await store.selectProject('research-ops');
    expect(store.getState()).toMatchObject({ selectedAgentId: 'orchestrator', draft: '最初の要望 プレビュー音声入力' });
    store.selectAgent('orquesta-admin');
    expect(store.getState().selectedAgentId).toBe('orquesta-admin');
    store.setDraft('別担当への無関係な指示');
    await store.sendMessage();
    expect(client.sendCalls).toBe(1);
    expect(client.ackCalls).toBe(0);

    store.selectAgent('orchestrator');
    expect(store.getState().draft).toBe('最初の要望 プレビュー音声入力');
    await store.sendMessage();
    expect(client.sendCalls).toBe(2);
    expect(store.getState()).toMatchObject({ selectedAgentId: 'orchestrator', draft: '' });
    await waitFor(() => expect(client.ackCalls).toBe(1));
    await store.dispose();
  });

  test('treats an explicit edit as consumption of an inserted transcript', async () => {
    const operationRef = '88888888-8888-4888-8888-888888888888';
    const client = VoiceSendTrackingClient();
    const store = new ApplicationStore(client, { selectionId: () => operationRef });
    await store.initialize();
    store.setDraft('録音前');
    expect(store.prepareVoiceCapture()).toEqual({ operationRef });
    store.markVoiceRecording(operationRef);
    await store.submitVoiceCapture(operationRef, new Uint8Array(3_200), 1_600);
    await waitFor(() => expect(store.getState().draft).toBe('録音前 プレビュー音声入力'));

    store.setDraft('利用者が置き換えた別の指示');
    await store.sendMessage();

    expect(client.sendCalls).toBe(1);
    await waitFor(() => expect(client.ackCalls).toBe(1));
    await waitFor(() => expect(store.getState().voiceStatus?.operations).toEqual([]));
    await store.dispose();
  });

  test('rejects every project transition while local voice capture owns the microphone', async () => {
    const operationRef = '88888888-8888-4888-8888-888888888888';
    const client = LauncherWithProjectsClient();
    const store = new ApplicationStore(client, { selectionId: () => operationRef });
    await store.initialize();
    expect(store.prepareVoiceCapture()).toEqual({ operationRef });
    store.markVoiceRecording(operationRef);

    await store.selectProject('research-ops');
    await expect(store.createStarterProject('録音中に作ってはいけない')).resolves.toBe(false);

    expect(store.getState()).toMatchObject({
      phase: 'launcher', selectedProjectId: null, voiceCapturePhase: 'recording',
    });
    store.cancelVoiceCapture(operationRef);
    await store.dispose();
  });

  test('keeps every project-entry route available after restoring a transcript into the normal Composer', async () => {
    const selectStore = new ApplicationStore(VoiceRecoveryTranscriptClient(true));
    await selectStore.initialize();
    expect(selectStore.getState().draft).toBe('復旧された音声入力');
    await expect(selectStore.selectProject('research-ops')).resolves.toBe(true);
    expect(selectStore.getState().selectedProjectId).toBe('research-ops');
    await selectStore.dispose();

    const createStore = new ApplicationStore(VoiceRecoveryTranscriptClient(true));
    await createStore.initialize();
    expect(createStore.getState().draft).toBe('復旧された音声入力');
    await expect(createStore.createStarterProject('保持中でも作れる')).resolves.toBe(true);
    await createStore.dispose();

    const openStore = new ApplicationStore(VoiceRecoveryTranscriptClient(true));
    await openStore.initialize();
    expect(openStore.getState().draft).toBe('復旧された音声入力');
    const selection = await openStore.chooseProjectFolder();
    expect(selection).not.toBeNull();
    await expect(openStore.openProjectFolder(selection!, selection!.suggestedName)).resolves.toBe(true);
    await openStore.dispose();
  });

  test('treats an omitted operation as durable ack success after the ack response is lost', async () => {
    const operationRef = '88888888-8888-4888-8888-888888888888';
    const client = VoiceSendTrackingClient();
    const readVoiceStatus = vi.mocked(client.readVoiceStatus).getMockImplementation()!;
    const readSpy = vi.spyOn(client, 'readVoiceStatus').mockImplementation(readVoiceStatus);
    const acknowledge = vi.mocked(client.acknowledgeVoiceTranscription).getMockImplementation()!;
    vi.spyOn(client, 'acknowledgeVoiceTranscription').mockImplementation(async (...args) => {
      await acknowledge(...args);
      throw new Error('voice ack response lost');
    });
    const store = new ApplicationStore(client, { selectionId: () => operationRef });
    await store.initialize();
    store.setDraft('既存の指示');
    const prepared = store.prepareVoiceCapture();
    expect(prepared).toEqual({ operationRef });
    store.markVoiceRecording(operationRef);

    await store.submitVoiceCapture(operationRef, new Uint8Array(3_200), 1_600);

    await waitFor(() => expect(store.getState().draft).toBe('既存の指示 プレビュー音声入力'));
    expect(client.ackCalls).toBe(0);
    await store.sendMessage();
    await waitFor(() => expect(client.ackCalls).toBe(1));
    // One normal post-transcription read plus one bounded ack-loss readback.
    await waitFor(() => expect(readSpy).toHaveBeenCalledTimes(2));
    expect(store.getState().draft).toBe('');
    expect(store.getState().voiceStatus?.operations).toEqual([]);
    expect(store.getState().voiceError).toBeNull();
    expect(client.sendCalls).toBe(1);
    await store.dispose();
  });

  test('restores a recovery-required transcript into the normal Composer without auto-sending', async () => {
    const operationRef = '88888888-8888-4888-8888-888888888888';
    const client = VoiceRecoveryTranscriptClient();
    const store = new ApplicationStore(client, { selectionId: () => operationRef });
    await store.initialize();
    store.setDraft('録音前の本文');
    expect(store.prepareVoiceCapture()).toEqual({ operationRef });
    store.markVoiceRecording(operationRef);

    await store.submitVoiceCapture(operationRef, new Uint8Array(3_200), 1_600);

    expect(store.getState().draft).toBe('録音前の本文 復旧された音声入力');
    expect(client.ackCalls).toBe(0);
    store.setDraft('利用者が確認した本文');
    expect(client.ackCalls).toBe(0);
    client.resolveSafeRecovery();
    await waitFor(() => expect(client.ackCalls).toBe(1));
    await waitFor(() => expect(store.getState().voiceStatus?.operations).toEqual([]));
    await store.dispose();
  });

  test('restores a legacy transcript into the one visible Composer and acknowledges only after user consumption', async () => {
    const client = VoiceRecoveryTranscriptClient(true);
    const store = new ApplicationStore(client);
    await store.initialize();
    expect(store.getState().draft).toBe('復旧された音声入力');
    expect(client.ackCalls).toBe(0);

    client.resolveSafeRecovery();
    await waitFor(() => expect(store.getState().voiceError).toBeNull());
    expect(client.ackCalls).toBe(0);
    store.setDraft('復旧された音声入力を確認・修正');
    await waitFor(() => expect(client.ackCalls).toBe(1));
    expect(store.getState().voiceStatus?.operations).toEqual([]);
    await store.dispose();
  });

  test.each(['cancelled', 'failed'] as const)(
    'acknowledges a durable %s voice terminal left at bootstrap so capacity is reusable',
    async (phase) => {
      const client = PassiveStatusClient();
      let voice: VoiceStatus | null = null;
      const bootstrapFixture = client.bootstrap.bind(client);
      vi.spyOn(client, 'bootstrap').mockImplementation(async (signal) => {
        const bootstrap = await bootstrapFixture(signal);
        voice ??= {
          ...bootstrap.voiceStatus, revision: bootstrap.voiceStatus.revision + 1,
          operations: [{
            operationRef: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', composerBinding: LEGACY_VOICE_BINDING,
            phase, durationMs: 100, transcript: null,
            lastErrorCode: phase === 'failed' ? 'voice_transcription_failed' : null,
          }],
        };
        return { ...bootstrap, voiceStatus: structuredClone(voice) };
      });
      const ackSpy = vi.spyOn(client, 'acknowledgeVoiceTranscription').mockImplementation(async (_renderer, operationRef) => {
        voice = {
          ...voice!, revision: voice!.revision + 1,
          operations: voice!.operations.filter((candidate) => candidate.operationRef !== operationRef),
        };
        client.emitScenarioEvent({ type: 'voice_status', status: structuredClone(voice) });
        return structuredClone(voice);
      });
      const store = new ApplicationStore(client);
      await store.initialize();
      await waitFor(() => expect(ackSpy).toHaveBeenCalledOnce());
      await waitFor(() => expect(store.getState().voiceStatus?.operations).toEqual([]));
      await store.dispose();
    },
  );

  test('projects asynchronous voice asset progress and failure, then retries through the same Native owner', async () => {
    const client = VoiceAssetLifecycleClient();
    const store = new ApplicationStore(client);
    await store.initialize();
    const absentStatus = store.getState().voiceStatus;
    expect(absentStatus).not.toBeNull();
    expect(absentStatus).toMatchObject({ revision: 1, requiredAssetsReady: false });
    expect(absentStatus?.assets).toContainEqual(
      expect.objectContaining({ phase: 'absent', downloadedBytes: 0, expectedBytes: 1_000 }),
    );

    await store.prepareVoiceAssets();
    expect(client.acquireCalls).toBe(1);
    const downloadingStatus = store.getState().voiceStatus;
    expect(downloadingStatus).not.toBeNull();
    expect(downloadingStatus).toMatchObject({ revision: 2 });
    expect(downloadingStatus?.assets).toContainEqual(
      expect.objectContaining({ phase: 'downloading', downloadedBytes: 400, expectedBytes: 1_000 }),
    );

    client.emitAsyncFailure();
    const failedStatus = store.getState().voiceStatus;
    expect(failedStatus).not.toBeNull();
    expect(failedStatus).toMatchObject({ revision: 3 });
    expect(failedStatus?.assets).toContainEqual(
      expect.objectContaining({ phase: 'failed', lastErrorCode: 'voice_asset_download_failed' }),
    );
    await store.prepareVoiceAssets();
    expect(client.acquireCalls).toBe(2);
    expect(store.getState().voiceStatus).toMatchObject({ revision: 4, requiredAssetsReady: true });
    await store.dispose();
  });

  test('keeps voice capture admission free of download side effects and fails closed on recovery-required assets', async () => {
    const absentClient = VoiceAssetLifecycleClient();
    const absentStore = new ApplicationStore(absentClient);
    await absentStore.initialize();
    expect(absentStore.prepareVoiceCapture()).toBeNull();
    await Promise.resolve();
    expect(absentClient.acquireCalls).toBe(0);
    await absentStore.dispose();

    const recoveryClient = VoiceAssetLifecycleClient('recovery_required');
    const recoveryStore = new ApplicationStore(recoveryClient);
    await recoveryStore.initialize();
    expect(recoveryStore.prepareVoiceCapture()).toBeNull();
    await recoveryStore.prepareVoiceAssets();
    expect(recoveryClient.acquireCalls).toBe(0);
    await recoveryStore.dispose();
  });

  test('never overwrites a draft changed during recording and retains the transcript for recovery', async () => {
    const client = VoiceSendTrackingClient();
    const store = new ApplicationStore(client, {
      selectionId: () => '88888888-8888-4888-8888-888888888888',
    });
    await store.initialize();
    store.setDraft('録音開始時');
    const prepared = store.prepareVoiceCapture()!;
    store.markVoiceRecording(prepared.operationRef);
    expect(store.requestVoiceSendIntent(prepared.operationRef)).toBe(true);
    store.setDraft('録音中に編集した本文');

    await store.submitVoiceCapture(prepared.operationRef, new Uint8Array(3_200), 1_600);

    expect(store.getState().draft).toBe('録音中に編集した本文');
    expect(store.getState().voiceSendIntentOperationRef).toBeNull();
    expect(store.getState().voiceError).toEqual({ id: 'voice_draft_changed' });
    expect(client.ackCalls).toBe(0);
    expect(client.sendCalls).toBe(0);
    await store.dispose();
  });

  test('exposes one cancelling lifecycle and blocks duplicate native cancel commands', async () => {
    const operationRef = '88888888-8888-4888-8888-888888888888';
    const client = VoiceCancellationClient();
    const store = new ApplicationStore(client, { selectionId: () => operationRef });
    await store.initialize();
    const prepared = store.prepareVoiceCapture()!;
    store.markVoiceRecording(prepared.operationRef);
    await store.submitVoiceCapture(operationRef, new Uint8Array(3_200), 1_600);
    expect(store.getState().voiceCapturePhase).toBe('transcribing');

    const first = store.cancelVoiceTranscription(operationRef);
    const duplicate = store.cancelVoiceTranscription(operationRef);
    expect(store.getState().voiceCapturePhase).toBe('cancelling');
    expect(client.cancelCalls).toBe(1);
    client.resolveCancel(operationRef);
    await Promise.all([first, duplicate]);

    expect(store.getState()).toMatchObject({
      voiceCapturePhase: 'idle', voiceActiveOperationRef: null, voiceError: null,
    });
    await store.dispose();
  });

  test('recovers a lost cancel response from durable terminal voice status', async () => {
    const operationRef = '88888888-8888-4888-8888-888888888888';
    const client = VoiceCancellationClient(true);
    const store = new ApplicationStore(client, { selectionId: () => operationRef });
    await store.initialize();
    const prepared = store.prepareVoiceCapture()!;
    store.markVoiceRecording(prepared.operationRef);
    await store.submitVoiceCapture(operationRef, new Uint8Array(3_200), 1_600);

    await store.cancelVoiceTranscription(operationRef);

    expect(client.cancelCalls).toBe(1);
    expect(store.getState()).toMatchObject({
      voiceCapturePhase: 'idle', voiceActiveOperationRef: null, voiceError: null,
    });
    await store.dispose();
  });

  test('keeps History selection and search separate from the WORK target and draft', async () => {
    const client = HistoryTrackingClient();
    const store = new ApplicationStore(client);
    await store.initialize();
    store.setDraft('WORKだけの下書き');
    const workAgent = store.getState().selectedAgentId;

    store.setRoute('history');
    await waitFor(() => expect(store.getState().historyLoading).toBe(false));
    expect(store.getState().historyConversations.length).toBeGreaterThan(0);
    const historyAgent = store.getState().historyConversations[0]!.targetAgentId;
    store.selectHistoryAgent(historyAgent);
    await waitFor(() => expect(store.getState().historyLoading).toBe(false));
    store.setHistoryQuery('   message   ');
    await waitFor(() => expect(store.getState().historyLoading).toBe(false));

    expect(client.historyQueries.at(-1)).toBe('message');
    expect(store.getState()).toMatchObject({
      selectedAgentId: workAgent,
      draft: 'WORKだけの下書き',
      historySelectedAgentId: historyAgent,
      historyQuery: 'message',
    });

    store.setRoute('work');
    store.setRoute('history');
    await waitFor(() => expect(store.getState()).toMatchObject({ historyLoading: false, historyQuery: '' }));
    await store.dispose();
  });

  test('refreshes SQLite conversation summaries on projection changes without opening History pages', async () => {
    const client = HistoryTrackingClient();
    const store = new ApplicationStore(client);
    await store.initialize();
    await waitFor(() => expect(client.historyIndexCalls).toBeGreaterThan(0));
    expect(store.getState().userSignalsBaselineReady).toBe(true);
    const beforeRefresh = client.historyIndexCalls;

    client.emitScenarioEvent({
      type: 'projection_changed', projectId: store.getState().runtimeAuthority!.projectId,
      streamId: 'preview-stream', appliedJournalSequence: 99, projectionRevision: 99,
    });

    await waitFor(() => expect(client.historyIndexCalls).toBeGreaterThan(beforeRefresh));
    expect(store.getState().route).toBe('work');
    expect(store.getState().historyConversations.length).toBeGreaterThan(0);
    expect(client.historyQueries).toEqual([]);
    await store.dispose();
  });

  test('opens the shared user-signal baseline only after summaries and selected conversation load', async () => {
    const client = PassiveStatusClient();
    const conversationGate = deferred<Awaited<ReturnType<PreviewDesktopClient['readConversation']>>>();
    const historyIndex = deferred<Awaited<ReturnType<PreviewDesktopClient['readHistoryIndex']>>>();
    const readConversationFixture = client.readConversation.bind(client);
    const readHistoryIndexFixture = client.readHistoryIndex.bind(client);
    vi.spyOn(client, 'readConversation').mockImplementation(() => conversationGate.promise);
    vi.spyOn(client, 'readHistoryIndex').mockImplementation(() => historyIndex.promise);
    const store = new ApplicationStore(client);
    await store.initialize();
    const authority = store.getState().runtimeAuthority!;
    const agentId = store.getState().selectedAgentId!;
    expect(store.getState().userSignalsBaselineReady).toBe(false);

    const history = await readHistoryIndexFixture(authority, null);
    historyIndex.resolve(history);
    await waitFor(() => expect(store.getState().historyConversations).toHaveLength(history.items.length));
    expect(store.getState().userSignalsBaselineReady).toBe(false);

    const conversation = await readConversationFixture(
      authority,
      agentId,
      { streamId: null, journalSequence: 0, projectionRevision: 0 },
      null,
      null,
    );
    conversationGate.resolve(conversation);
    await waitFor(() => expect(store.getState().userSignalsBaselineReady).toBe(true));
    await store.dispose();
  });

  test('coalesces a projection update during History search without dropping the query or selection', async () => {
    const client = HistoryTrackingClient();
    const store = new ApplicationStore(client);
    await store.initialize();
    store.setRoute('history');
    await waitFor(() => expect(store.getState().historyLoading).toBe(false));
    const authority = store.getState().runtimeAuthority!;
    const agentId = store.getState().historySelectedAgentId!;
    const page = await client.readHistoryPageFixture(authority, agentId, 'message', null);
    const blocked = deferred<typeof page>();
    client.historyPageResponses.push(blocked.promise);
    const beforeRefresh = client.historyIndexCalls;

    store.setHistoryQuery('  message  ');
    await waitFor(() => expect(store.getState().historyLoading).toBe(true));
    client.emitScenarioEvent({
      type: 'projection_changed', projectId: authority.projectId, streamId: 'preview-stream',
      appliedJournalSequence: 99, projectionRevision: 99,
    });
    blocked.resolve(page);

    await waitFor(() => expect(client.historyIndexCalls).toBeGreaterThan(beforeRefresh));
    await waitFor(() => expect(store.getState()).toMatchObject({
      historyLoading: false,
      historySelectedAgentId: agentId,
      historyQuery: 'message',
    }));
    expect(client.historyQueries.slice(-2)).toEqual(['message', 'message']);
    await store.dispose();
  });

  test('keeps an explicit History reset stronger than later background refreshes', async () => {
    const client = HistoryTrackingClient();
    const store = new ApplicationStore(client);
    await store.initialize();
    store.setRoute('history');
    await waitFor(() => expect(store.getState().historyLoading).toBe(false));
    const authority = store.getState().runtimeAuthority!;
    const agentId = store.getState().historySelectedAgentId!;
    const page = await client.readHistoryPageFixture(authority, agentId, 'message', null);
    const blocked = deferred<typeof page>();
    client.historyPageResponses.push(blocked.promise);

    store.setHistoryQuery('message');
    await waitFor(() => expect(store.getState().historyLoading).toBe(true));
    void store.loadHistoryIndex();
    client.emitScenarioEvent({
      type: 'projection_changed', projectId: authority.projectId, streamId: 'preview-stream',
      appliedJournalSequence: 100, projectionRevision: 100,
    });
    blocked.resolve(page);

    await waitFor(() => expect(store.getState()).toMatchObject({
      historyLoading: false,
      historyQuery: '',
    }));
    expect(client.historyQueries.at(-1)).toBeNull();
    await store.dispose();
  });

  test('restarts an in-flight History read under a same-project replacement incarnation', async () => {
    const client = HistoryTrackingClient();
    const store = new ApplicationStore(client);
    await store.initialize();
    store.setRoute('history');
    await waitFor(() => expect(store.getState().historyLoading).toBe(false));
    const authority = store.getState().runtimeAuthority!;
    const agentId = store.getState().historySelectedAgentId!;
    const oldPage = await client.readHistoryPageFixture(authority, agentId, 'message', null);
    const blocked = deferred<typeof oldPage>();
    client.historyPageResponses.push(blocked.promise);
    store.setHistoryQuery('message');
    await waitFor(() => expect(store.getState().historyLoading).toBe(true));
    const indexCalls = client.historyIndexCalls;
    const previous = store.getState().runtimeStatus!;

    client.emitStatus({
      ...previous,
      activationToken: 'history-replacement-incarnation',
      runtimeGeneration: RUNTIME_GENERATION_B,
      statusRevision: previous.statusRevision + 1,
    });

    await waitFor(() => expect(client.historyIndexCalls).toBeGreaterThan(indexCalls));
    await waitFor(() => expect(store.getState()).toMatchObject({
      historySelectedAgentId: agentId,
      historyQuery: 'message',
      historyLoading: false,
      historyOlderLoading: false,
      runtimeAuthority: { activationToken: 'history-replacement-incarnation' },
    }));
    const messagesAfterReplacement = store.getState().historyMessages;
    blocked.resolve(oldPage);
    await Promise.resolve();
    expect(store.getState().historyMessages).toEqual(messagesAfterReplacement);
    await store.dispose();
  });

  test('serializes last-WORK hints and drains the latest selection before renderer shutdown', async () => {
    const client = new PreviewDesktopClient();
    const hintCalls: string[] = [];
    const firstWrite = deferred<void>();
    vi.spyOn(client, 'recordLastWorkAgent').mockImplementation(async (_authority, targetAgentId) => {
      hintCalls.push(targetAgentId);
      if (hintCalls.length === 1) await firstWrite.promise;
      return { ...structuredClone(previewProjects[0]), lastWorkAgentId: targetAgentId };
    });
    const store = new ApplicationStore(client);
    await store.initialize();

    store.selectAgent('frontend');
    await waitFor(() => expect(hintCalls).toEqual(['frontend']));
    store.selectAgent('orchestrator');
    const disposing = store.dispose();
    firstWrite.resolve();
    await disposing;

    expect(hintCalls).toEqual(['frontend', 'orchestrator']);
  });

  test('does not retain subscribers registered after disposal', async () => {
    const store = new ApplicationStore(new PreviewDesktopClient());
    await store.initialize();
    await store.dispose();
    let observed = 0;
    store.subscribe(() => { observed += 1; });
    store.setDraft('ignored after disposal');
    expect(observed).toBe(0);
  });
});
