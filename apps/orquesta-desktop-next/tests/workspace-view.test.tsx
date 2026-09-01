import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { App } from '../src/App';
import type { ConversationActivityCursor, ConversationCursor, ConversationReadCheckpoint, DesktopEvent, HistoryConversationPage, NativeSettings, ProjectBootstrapResult, ProjectSummary, RendererAuthority, RuntimeAuthority, VoiceStatus, WorkflowCatalog, WorkspaceSnapshot } from '../src/domain/models';
import { conversationMessageToThreadMessage, loadOlderWithScrollAnchor } from '../src/features/thread/OrquestaThread';
import { VoiceCaptureController, type VoiceCaptureHandle } from '../src/features/conversation/voice-capture';
import { WorkspaceView } from '../src/features/workspace/WorkspaceView';
import { PreviewDesktopClient, previewSnapshot } from '../src/testing/preview-client';
import type { NotificationGateway } from '../src/application/notification-coordinator';
import { createInitialApplicationState, type ApplicationState } from '../src/application/state';
import type { ApplicationStore } from '../src/application/store';

test('renders the supplied Orquesta symbol in the workspace brand', async () => {
  render(<App client={new PreviewDesktopClient()} />);
  const brand = await screen.findByText('ORQUESTA');
  const header = brand.closest('header');
  expect(header).not.toBeNull();
  const image = header!.querySelector('img');
  expect(image).toHaveAttribute('src', '/brand/orquesta-symbol.png');
  expect(image).toHaveAttribute('alt', '');
  expect(header!.querySelector('.ledger-brand-mark')).toBeNull();
});

test('removes an inactive project from the recent list without offering removal for the active project', async () => {
  const client = new PreviewDesktopClient();
  const forget = vi.spyOn(client, 'forgetRecentProject');
  render(<App client={client} />);

  const sidebar = await screen.findByRole('complementary', { name: 'Project navigation' });
  fireEvent.click(within(sidebar).getByRole('button', { name: /Orquesta Desktop Next/ }));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).queryByRole('button', { name: /Remove Orquesta Desktop Next from the list/ })).toBeNull();

  fireEvent.click(within(dialog).getByRole('button', { name: 'Remove Research Operations from the list' }));
  await waitFor(() => expect(within(dialog).queryByText('Research Operations')).toBeNull());
  expect(forget).toHaveBeenCalledWith(
    expect.objectContaining({ rendererSessionId: 'preview-renderer', rendererGeneration: 1 }),
    'research-ops',
  );
  expect(within(dialog).getByText('Orquesta Desktop Next')).toBeInTheDocument();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

type PreviewBootstrap = Awaited<ReturnType<PreviewDesktopClient['bootstrap']>>;

function withBootstrap(
  client: PreviewDesktopClient,
  transform: (bootstrap: PreviewBootstrap) => PreviewBootstrap | Promise<PreviewBootstrap>,
): PreviewDesktopClient {
  const readBase = client.bootstrap.bind(client);
  vi.spyOn(client, 'bootstrap').mockImplementation(async (signal) => transform(await readBase(signal)));
  return client;
}

function installSettingsWriter(client: PreviewDesktopClient) {
  let revision = 1;
  return vi.spyOn(client, 'updateSettings').mockImplementation(async (_renderer, input) => ({
    schemaVersion: 2,
    revision: ++revision,
    locale: input.locale,
    theme: input.theme,
    reducedMotion: input.reducedMotion,
    notificationsEnabled: input.notificationsEnabled,
  }));
}

function activeTurnScenario() {
  const client = new PreviewDesktopClient();
  const readBase = client.readConversation.bind(client);
  vi.spyOn(client, 'readConversation').mockImplementation(async (...args) => {
    const page = await readBase(...args);
    const targetAgentId = args[1];
    return targetAgentId === 'orchestrator'
      ? {
          ...page,
          activeTurns: [{
            threadId: 'thread-live',
            turnId: 'turn-live',
            targetAgentId,
            state: 'in_progress' as const,
            lastJournalSequence: 7,
          }],
        }
      : page;
  });
  const interrupt = vi.spyOn(client, 'interruptTurn').mockResolvedValue(undefined);
  const steer = vi.spyOn(client, 'steerTurn').mockResolvedValue(undefined);
  return { client, interrupt, steer };
}

function voiceAssetScenario(phase: 'failed' | 'recovery_required' = 'failed') {
  let voice: VoiceStatus = {
    schemaVersion: 2,
    revision: 3,
    providerId: 'whisper.cpp-local',
    binaryAssetId: 'whisper.cpp-windows-x64-b4938-spike',
    initialModelAssetId: 'whisper.cpp-model-small-multilingual',
    comparisonModelAssetId: 'whisper.cpp-model-base-multilingual',
    requiredAssetsReady: false,
    assets: [
      {
        assetId: 'whisper.cpp-windows-x64-b4938-spike',
        kind: 'native_binary_bundle',
        phase,
        downloadedBytes: 400,
        expectedBytes: 1_000,
        operationRef: null,
        lastErrorCode: phase === 'failed'
          ? 'voice_asset_download_failed'
          : 'voice_asset_recovery_required',
      },
      {
        assetId: 'whisper.cpp-model-small-multilingual',
        kind: 'model',
        phase: 'installed',
        downloadedBytes: 2_000,
        expectedBytes: 2_000,
        operationRef: null,
        lastErrorCode: null,
      },
      {
        assetId: 'whisper.cpp-model-base-multilingual',
        kind: 'model',
        phase: 'absent',
        downloadedBytes: 0,
        expectedBytes: 1_000,
        operationRef: null,
        lastErrorCode: null,
      },
    ],
    operations: [],
  };
  const client = withBootstrap(new PreviewDesktopClient(), (bootstrap) => ({
    ...bootstrap,
    voiceStatus: structuredClone(voice),
  }));
  const acquire = vi.spyOn(client, 'acquireVoiceAsset').mockImplementation(async (_renderer, assetId) => {
    voice = {
      ...voice,
      revision: voice.revision + 1,
      requiredAssetsReady: true,
      assets: voice.assets.map((asset) => asset.assetId === assetId
        ? {
            ...asset,
            phase: 'installed' as const,
            downloadedBytes: asset.expectedBytes,
            operationRef: null,
            lastErrorCode: null,
          }
        : asset),
    };
    return structuredClone(voice);
  });
  return { client, acquire };
}

function attachmentScenario() {
  const client = new PreviewDesktopClient();
  const bytes = new Map<string, ArrayBuffer>();
  const importedNames: string[][] = [];
  const importAttachments = vi.spyOn(client, 'importAttachments').mockImplementation(
    async (_authority, selectionId, files) => {
      importedNames.push(files.map((file) => file.name));
      return Promise.all(files.map(async (file, index) => {
        const content = await file.arrayBuffer();
        const id = 'attachment-' + selectionId + '-' + index;
        bytes.set(id, content.slice(0));
        const extension = file.name.split('.').at(-1)?.toLowerCase();
        return {
          id,
          selectionId,
          name: file.name,
          kind: ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(extension ?? '') ? 'image' as const : 'text' as const,
          mediaType: file.type || 'application/octet-stream',
          sizeBytes: content.byteLength,
        };
      }));
    },
  );
  const readAttachmentPreview = vi.spyOn(client, 'readAttachmentPreview').mockImplementation(
    async (_authority, _selectionId, attachmentId) => {
      const content = bytes.get(attachmentId);
      if (!content) throw new Error('attachment unavailable');
      return content.slice(0);
    },
  );
  vi.spyOn(client, 'forgetAttachment').mockImplementation(async (_authority, _selectionId, attachmentId) => {
    bytes.delete(attachmentId);
  });
  vi.spyOn(client, 'abandonAttachmentSelection').mockResolvedValue(undefined);
  return { client, importedNames, importAttachments, readAttachmentPreview };
}

function voiceRecoveryScenario(blank = false) {
  const client = withBootstrap(new PreviewDesktopClient(), (bootstrap) => ({
    ...bootstrap,
    ...(blank
      ? {
          projects: [],
          selectedProjectId: null,
          snapshot: null,
          status: {
            ...bootstrap.status,
            lifecycle: 'Stopped' as const,
            projectId: null,
            activationToken: null,
          },
        }
      : {}),
    voiceStatus: {
      ...bootstrap.voiceStatus,
      revision: bootstrap.voiceStatus.revision + 1,
      operations: [{
        operationRef: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        composerBinding: { state: 'legacy_unbound' as const },
        phase: 'recovery_required' as const,
        durationMs: 100,
        transcript: '復旧された音声入力',
        lastErrorCode: 'voice_cleanup_recovery_required',
      }],
    },
  }));
  vi.spyOn(client, 'acknowledgeVoiceTranscription').mockImplementation((renderer) => client.readVoiceStatus(renderer));
  return client;
}

function projectPreparationScenario(
  result: ProjectBootstrapResult,
  options: ConstructorParameters<typeof PreviewDesktopClient>[0] = {},
) {
  const client = new PreviewDesktopClient(options);
  vi.spyOn(client, 'bootstrapProject').mockResolvedValue(structuredClone(result));
  if (result.status === 'ready') {
    vi.spyOn(client, 'readSnapshot').mockResolvedValue({
      ...structuredClone(previewSnapshot),
      agents: structuredClone(previewSnapshot.agents.filter((agent) => (
        ['orchestrator', 'orquesta-admin', 'user-support'].includes(agent.id)
      ))),
    });
  }
  return client;
}

function activityScenario(mode: 'paged' | 'unknown' | 'lifecycle') {
  const client = new PreviewDesktopClient();
  const readBase = client.readConversation.bind(client);
  let completed = false;
  vi.spyOn(client, 'readConversation').mockImplementation(async (...args) => {
    const page = await readBase(...args);
    const targetAgentId = args[1];
    const activityCursor = args[4];
    if (targetAgentId !== 'orchestrator') return page;
    if (mode === 'lifecycle') {
      return {
        ...page,
        items: [],
        olderCursor: null,
        activities: [{
          id: 'activity-item-plan', threadId: 'thread-a', turnId: 'turn-a', itemId: 'plan-a',
          targetAgentId, kind: 'plan' as const, state: completed ? 'completed' as const : 'running' as const,
          title: 'Plan', createdAt: '2026-08-17T00:00:02.000Z',
          updatedAt: completed ? '2026-08-17T00:00:03.000Z' : '2026-08-17T00:00:02.000Z',
          lastJournalSequence: completed ? 4 : 3,
          details: {
            text: 'Inspect the provider contract, then implement the bounded card.', originalBytes: 66,
            truncated: false, redacted: false, steps: [], stepCount: 0, stepsTruncated: false,
            explanation: null, explanationTruncated: false, explanationRedacted: false,
          },
        }],
        activityOlderCursor: null,
      };
    }
    if (activityCursor) {
      return {
        ...page,
        items: [],
        olderCursor: null,
        activities: [{
          id: 'activity-command', threadId: 'thread-a', turnId: 'turn-a', itemId: 'command-a',
          targetAgentId, kind: 'command' as const, state: 'completed' as const, title: 'Run powershell.exe',
          createdAt: '2026-08-17T00:00:00.000Z', updatedAt: '2026-08-17T00:00:01.000Z', lastJournalSequence: 2,
          details: {
            commandName: 'powershell.exe', actionTypes: ['unknown'], actionTypesTruncated: false,
            exitCode: 0, durationMs: 125, outputPresent: true, outputBytes: 64,
            outputText: 'safe output line\n'.repeat(40) + 'done', outputTruncated: true, outputRedacted: false,
            cwdOmitted: true as const, commandArgumentsOmitted: true as const, contentOmitted: true as const,
          },
        }],
        activityOlderCursor: null,
      };
    }
    return {
      ...page,
      items: [],
      olderCursor: null,
      activities: [{
        id: 'activity-plan', threadId: 'thread-a', turnId: 'turn-a', itemId: null,
        targetAgentId, kind: 'plan' as const, state: mode === 'unknown' ? 'unknown' as const : 'updated' as const,
        title: 'Plan updated', createdAt: '2026-08-17T00:00:02.000Z',
        updatedAt: '2026-08-17T00:00:02.000Z', lastJournalSequence: 3,
        details: {
          text: null, originalBytes: null, truncated: false, redacted: false,
          steps: [{ status: 'inProgress' as const, text: 'Connect the safe activity projection', truncated: false, redacted: false }],
          stepCount: 1, stepsTruncated: false, explanation: null,
          explanationTruncated: false, explanationRedacted: false,
        },
      }],
      activityOlderCursor: mode === 'paged'
        ? { beforeCreatedAt: '2026-08-17T00:00:02.000Z', beforeActivityId: 'activity-plan' }
        : null,
    };
  });
  return {
    client,
    complete() {
      completed = true;
      client.emitScenarioEvent({
        type: 'projection_changed',
        projectId: 'orquesta-v5',
        streamId: 'preview-stream',
        appliedJournalSequence: 4,
        projectionRevision: 4,
      });
    },
  };
}






class PermissionNotificationGateway implements NotificationGateway {
  permissionChecks = 0;
  permissionRequests = 0;
  readonly notifications: Array<{ title: string; body: string }> = [];

  constructor(readonly permission: 'granted' | 'denied') {}

  async isPermissionGranted(): Promise<boolean> {
    this.permissionChecks += 1;
    return false;
  }

  async requestPermission(): Promise<'granted' | 'denied'> {
    this.permissionRequests += 1;
    return this.permission;
  }

  async notify(input: { title: string; body: string }): Promise<void> {
    this.notifications.push(structuredClone(input));
  }
}


test('does not present an already-selected project as unselected while its snapshot hydrates', async () => {
  const snapshotRead = deferred<WorkspaceSnapshot>();
  const client = withBootstrap(new PreviewDesktopClient(), (bootstrap) => ({
    ...bootstrap,
    snapshot: null,
    settings: { ...bootstrap.settings, locale: 'ja' },
  }));
  vi.spyOn(client, 'readSnapshot').mockReturnValue(snapshotRead.promise);
  window.localStorage.setItem('orquesta.desktop-next.locale', 'ja');
  render(<App client={client} />);

  await screen.findByText('プロジェクトを準備しています');
  expect(screen.queryByText('PROJECT / 未選択')).toBeNull();
  expect(screen.queryByText('プロジェクト未選択')).toBeNull();
  expect(screen.queryByRole('button', { name: '新規' })).toBeNull();
  expect(screen.getByText('PROJECT / 準備中')).toBeInTheDocument();
  expect(screen.getByLabelText('エージェントへの指示')).toBeDisabled();

  snapshotRead.resolve(structuredClone(previewSnapshot));
  await waitFor(() => expect(screen.getByLabelText('エージェントへの指示')).toBeEnabled());
  expect(screen.queryByText('PROJECT / 準備中')).toBeNull();
});













function installObjectUrlHarness() {
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const blobs: Blob[] = [];
  const createObjectURL = vi.fn((blob: Blob) => {
    blobs.push(blob);
    return `blob:orquesta-preview-${blobs.length}`;
  });
  const revokeObjectURL = vi.fn();
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
  return {
    blobs,
    createObjectURL,
    revokeObjectURL,
    restore() {
      Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: originalCreate });
      Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: originalRevoke });
    },
  };
}

function imageFile(name: string, mediaType: string, bytes: Uint8Array): File {
  const stableBytes = Uint8Array.from(bytes).buffer;
  const file = new File([stableBytes], name, { type: mediaType });
  Object.defineProperty(file, 'arrayBuffer', {
    configurable: true,
    value: async () => stableBytes.slice(0),
  });
  return file;
}

function readBlobBytes(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Blob read failed.'));
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.readAsArrayBuffer(blob);
  });
}








afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.history.replaceState({}, '', '/');
  vi.restoreAllMocks();
});

describe('Desktop Next work-first shell', () => {
  test('maps only a non-empty projected agent delta to one running assistant message', () => {
    expect(conversationMessageToThreadMessage({
      id: 'stream-1', role: 'agent', targetAgentId: 'orchestrator', authorLabel: 'Orchestrator',
      text: '途中まで届いた回答', createdAt: '2026-08-17T00:00:00.000Z', evidenceLabel: null,
      status: 'running',
    })).toMatchObject({
      id: 'stream-1', role: 'assistant', content: [{ type: 'text', text: '途中まで届いた回答' }],
      status: { type: 'running' },
    });
  });

  test('enables Stop only for the selected agent projection-owned active turn', async () => {
    const user = userEvent.setup();
    const { client, interrupt } = activeTurnScenario();
    render(<App client={client} />);

    const stop = await screen.findByRole('button', { name: 'Stop' });
    await waitFor(() => expect(stop).toBeEnabled());
    await user.click(stop);

    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(stop).toBeDisabled();
    expect(stop).toHaveTextContent(/停止中|Stopping/);
  });

  test('switches the fixed composer to exact-turn Steer while an answer is active', async () => {
    const user = userEvent.setup();
    const { client, steer } = activeTurnScenario();
    render(<App client={client} />);

    const steerButton = await screen.findByRole('button', { name: 'STEER' });
    await user.type(screen.getByLabelText('Instruction to agent'), 'Check the root cause first');
    await user.click(steerButton);

    expect(steer).toHaveBeenCalledTimes(1);
    expect(steer.mock.calls[0]?.[1]).toMatchObject({
      targetAgentId: 'orchestrator', threadId: 'thread-live', turnId: 'turn-live', text: 'Check the root cause first',
    });
    expect(await screen.findByText('The additional instruction was sent to the current response.')).toBeInTheDocument();
  });

  test('keeps voice setup in the composer mic and retries a real asset failure without a persistent setup panel', async () => {
    const user = userEvent.setup();
    const { client, acquire } = voiceAssetScenario();
    render(<App client={client} />);

    await screen.findByRole('button', { name: 'RETRY VOICE SETUP' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'RETRY VOICE SETUP' })).toBeEnabled());
    const mic = screen.getByRole('button', { name: 'RETRY VOICE SETUP' });
    expect(mic).toHaveClass('has-setup-error');
    expect(screen.queryByLabelText('Voice setup status')).not.toBeInTheDocument();
    await user.click(mic);

    expect(acquire).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'VOICE INPUT' })).toBeEnabled();
  });

  test('blocks automatic voice asset retry when Native marks manual recovery required', async () => {
    const { client, acquire } = voiceAssetScenario('recovery_required');
    render(<App client={client} />);

    expect(screen.queryByLabelText('Voice setup status')).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'VOICE RECOVERY REQUIRED' })).toBeDisabled();
    expect(acquire).not.toHaveBeenCalled();
  });

  test('restores a recovered transcript into the normal Composer without a second editor', async () => {
    render(<App client={voiceRecoveryScenario()} />);

    expect(await screen.findByLabelText('Instruction to agent')).toHaveValue('復旧された音声入力');
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
  });

  test('shows an unknown send outcome as an honest status check, not a second Composer panel', async () => {
    const user = userEvent.setup();
    const client = new PreviewDesktopClient({ recovery: true });
    vi.spyOn(client, 'reconcileDispatchRecovery').mockResolvedValue({ outcome: 'accepted', recovery: null });
    render(<App client={client} />);

    const recoveryMessages = await screen.findAllByText(/The send result could not be confirmed\./u);
    const toast = recoveryMessages
      .map((message) => message.closest<HTMLElement>('.toast[role="status"]'))
      .find((candidate): candidate is HTMLElement => candidate !== null) ?? null;
    expect(toast).not.toBeNull();
    expect(screen.getAllByLabelText('Instruction to agent')).toHaveLength(1);
    expect(within(toast!).queryByRole('button', { name: 'Dismiss notification' })).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Instruction to agent'), 'Do not duplicate this turn');
    expect(screen.getByRole('button', { name: 'SEND' })).toBeDisabled();
    await user.click(within(toast!).getByRole('button', { name: 'CHECK SEND STATUS' }));
    await waitFor(() => expect(screen.queryByText(/The send result could not be confirmed/u)).toBeNull());
  });

  test('keeps accepted dispatch state internal while steering the exact active turn once', async () => {
    const user = userEvent.setup();
    const accepted = {
      kind: 'accepted' as const,
      dispatchId: 'accepted-dispatch',
      projectId: 'orquesta-v5',
      targetAgentId: 'orchestrator',
      createdAt: '2026-08-30T11:28:25.000Z',
      reason: null,
      threadId: 'thread-live',
      turnId: 'turn-live',
    };
    const { client, steer } = activeTurnScenario();
    const send = vi.spyOn(client, 'sendMessage');
    render(<App client={client} />);

    const steerButton = await screen.findByRole('button', { name: 'STEER' });
    const draft = screen.getByLabelText('Instruction to agent');
    await waitFor(() => expect(draft).toBeEnabled());
    act(() => client.emitScenarioEvent({
      type: 'dispatch_recovery',
      projectId: accepted.projectId,
      recovery: accepted,
    }));
    expect(screen.queryByText(/send result could not be confirmed/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/temporary data from a failed send/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'CHECK SEND STATUS' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'RESUME CLEANUP' })).not.toBeInTheDocument();
    expect(screen.getAllByLabelText('Instruction to agent')).toHaveLength(1);
    expect(draft).toBeEnabled();

    const text = 'Check the root cause before continuing this response';
    await user.type(draft, text);
    expect(draft).toHaveValue(text);
    await waitFor(() => expect(steerButton).toBeEnabled());
    await user.click(steerButton);

    expect(steer).toHaveBeenCalledTimes(1);
    expect(steer).toHaveBeenCalledWith(expect.objectContaining({ projectId: accepted.projectId }), {
      steerId: expect.any(String),
      targetAgentId: accepted.targetAgentId,
      threadId: accepted.threadId,
      turnId: accepted.turnId,
      text,
    });
    expect(send).not.toHaveBeenCalled();
    expect(await screen.findByText('The additional instruction was sent to the current response.')).toBeInTheDocument();
  });

  test('shows cleanup-pending as cleanup work instead of claiming the send stopped midway', async () => {
    const user = userEvent.setup();
    const cleanupPending = {
      kind: 'cleanup_pending' as const,
      dispatchId: 'cleanup-dispatch',
      projectId: 'orquesta-v5',
      targetAgentId: 'orchestrator',
      createdAt: '2026-08-30T11:28:25.000Z',
      reason: 'attachment cleanup is pending',
      threadId: null,
      turnId: null,
    };
    const client = withBootstrap(new PreviewDesktopClient(), (bootstrap) => ({
      ...bootstrap,
      dispatchRecovery: cleanupPending,
    }));
    vi.spyOn(client, 'reconcileDispatchRecovery').mockResolvedValue({
      outcome: 'definitive_failure',
      recovery: null,
    });
    render(<App client={client} />);

    const cleanupMessage = await screen.findByText(/Temporary data from a failed send still needs cleanup\./u);
    const toast = cleanupMessage.closest<HTMLElement>('.toast[role="status"]');
    expect(toast).not.toBeNull();
    await user.type(screen.getByLabelText('Instruction to agent'), 'Wait for cleanup');
    expect(screen.getByRole('button', { name: 'SEND' })).toBeDisabled();
    expect(screen.queryByText(/previous send stopped midway/i)).not.toBeInTheDocument();
    await user.click(within(toast!).getByRole('button', { name: 'RESUME CLEANUP' }));
    await waitFor(() => expect(screen.queryByText(/Temporary data from a failed send still needs cleanup/u)).toBeNull());
  });

  test('does not expose a foreign-project recovery in the current Composer', async () => {
    const user = userEvent.setup();
    const client = withBootstrap(new PreviewDesktopClient(), (bootstrap) => ({
      ...bootstrap,
      projects: bootstrap.projects.map((project) => project.id === bootstrap.selectedProjectId
        ? { ...project, lastWorkAgentId: 'frontend' }
        : project),
      dispatchRecovery: {
        kind: 'prepared_outcome_unknown' as const,
        dispatchId: 'foreign-dispatch',
        projectId: 'another-project',
        targetAgentId: 'orchestrator',
        createdAt: '2026-08-10T00:00:00Z',
        reason: null,
        threadId: null,
        turnId: null,
      },
    }));
    render(<App client={client} />);

    const composer = await screen.findByLabelText('Instruction to agent');
    await user.type(composer, 'Continue this project');
    expect(screen.queryByText(/previous send stopped midway/u)).toBeNull();
    expect(screen.getAllByLabelText('Instruction to agent')).toHaveLength(1);
  });

  test('keeps project entry available after restoring voice into the blank WORK Composer', async () => {
    render(<App client={voiceRecoveryScenario(true)} />);

    expect(await screen.findByLabelText('Instruction to agent')).toHaveValue('復旧された音声入力');
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'NEW' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'OPEN FOLDER' })).toBeEnabled();
    expect(screen.getByRole('button', { name: /No project selected/i })).toBeEnabled();
  });

  test('keeps an empty WORK visible before the user selects a project', async () => {
    const user = userEvent.setup();
    render(<App client={new PreviewDesktopClient({ state: 'empty' })} />);

    expect(await screen.findByRole('heading', { name: 'What do you want to work on?' })).toBeInTheDocument();
    expect(screen.getByLabelText('Orchestrator starting point')).toHaveTextContent('Orchestrator');
    expect(screen.getByRole('button', { name: 'WORK' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'MAP' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'DECISIONS' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'WORKFLOWS' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'HISTORY' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /No project selected/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'NEW' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'OPEN FOLDER' })).toBeInTheDocument();
    const draft = screen.getByLabelText('Instruction to agent');
    expect(draft).toBeEnabled();
    expect(screen.getByRole('button', { name: 'VOICE INPUT' })).toBeEnabled();
    expect(screen.queryByText('The shell stays available')).not.toBeInTheDocument();

    await user.type(draft, 'Build a small customer workspace');
    await user.click(screen.getByRole('button', { name: 'Create a new project and continue' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Start a new project');
    expect(screen.getByRole('button', { name: 'CHOOSE FOLDER AND START' })).toBeDisabled();
  });

  test('renders inactive state as WORK even when a stale non-WORK route remains', () => {
    const state = { ...createInitialApplicationState(), phase: 'launcher' as const, route: 'map' as const };
    const store = { setRoute: vi.fn(), selectAgent: vi.fn() } as unknown as ApplicationStore;
    const view = render(<WorkspaceView
      state={state}
      store={store}
      locale="en"
      onLocaleChange={() => undefined}
      onNotificationsChange={async () => 'saved'}
    />);

    expect(view.container.firstElementChild).toHaveClass('route-work', 'is-inactive');
    expect(screen.getByRole('button', { name: 'WORK' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'MAP' })).toBeDisabled();
    expect(screen.getByRole('heading', { name: 'What do you want to work on?' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'ORQUESTA MAP' })).toBeNull();
  });

  test('closes the new-project dialog when the selected project is registered while Foundation preparation continues', async () => {
    const user = userEvent.setup();
    const client = new PreviewDesktopClient({ state: 'empty' });
    const initialBootstrap = await client.bootstrap();
    const preparation = deferred<ProjectBootstrapResult>();
    const project: ProjectSummary = {
      id: 'starter-accepted', title: 'Starter accepted',
      rootPath: 'C:\\Projects\\Starter accepted', rootPathLabel: 'C:\\Projects\\Starter accepted',
      status: 'ready', connectionLabel: 'LOCAL', lastOpenedAt: null, lastWorkAgentId: null,
      creationOperationRef: '11111111-1111-4111-8111-111111111111',
    };
    vi.spyOn(client, 'createStarterProject').mockResolvedValue(project);
    vi.spyOn(client, 'activateProject').mockResolvedValue({
      lifecycle: 'Ready', projectId: project.id,
      activationToken: '22222222-2222-4222-8222-222222222222',
      rendererSessionId: initialBootstrap.renderer.rendererSessionId,
      rendererGeneration: initialBootstrap.renderer.rendererGeneration,
      runtimeGeneration: '33333333-3333-4333-8333-333333333333',
      statusRevision: initialBootstrap.status.statusRevision + 1, failureReason: null,
    });
    vi.spyOn(client, 'readSnapshot').mockResolvedValue({
      ...structuredClone(previewSnapshot),
      project: { ...structuredClone(previewSnapshot.project), id: project.id, title: project.title },
    });
    const bootstrapProject = vi.spyOn(client, 'bootstrapProject').mockReturnValue(preparation.promise);
    render(<App client={client} />);

    await user.click(await screen.findByRole('button', { name: 'NEW' }));
    await user.type(screen.getByLabelText('Project name'), project.title);
    await user.click(screen.getByRole('button', { name: 'CHOOSE FOLDER AND START' }));

    await waitFor(() => expect(bootstrapProject).toHaveBeenCalledOnce());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('Preparing the orchestrator and foundation agents…')).toBeInTheDocument();

    preparation.resolve({ status: 'ready', noWrite: true, reason: null });
    expect(await screen.findByRole('heading', { level: 1, name: 'Orchestrator' })).toBeInTheDocument();
  });

  test('keeps all durable Starter recoveries visible across routes without a dismiss action', async () => {
    const user = userEvent.setup();
    const client = withBootstrap(new PreviewDesktopClient({ state: 'empty' }), (bootstrap) => ({
      ...bootstrap,
      starterCreationRecoveries: [
        { operationRef: '11111111-1111-4111-8111-111111111111', displayName: '顧客管理', finalChildPath: 'C:\\Projects\\顧客管理', reason: 'owned_root_identity_mismatch' },
        { operationRef: '22222222-2222-4222-8222-222222222222', displayName: '店舗分析', finalChildPath: 'C:\\Projects\\店舗分析', reason: 'restart_planned_final_exists_without_owned_identity' },
      ],
    }));
    render(<App client={client} />);

    const recovery = await screen.findByRole('alert', { name: 'Starter project recovery required' });
    expect(recovery).toHaveTextContent('UNFINISHED PROJECTS2');
    await user.click(within(recovery).getByText('UNFINISHED PROJECTS'));
    expect(recovery).toHaveTextContent('顧客管理');
    expect(recovery).toHaveTextContent('店舗分析');
    expect(within(recovery).queryByRole('button')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'WORKFLOWS' }));
    expect(screen.getByRole('alert', { name: 'Starter project recovery required' })).toHaveTextContent('店舗分析');
  });

  test('keeps browser preview visually identical to the packaged-mode React surface for the same state', async () => {
    const voiceStart = vi.spyOn(VoiceCaptureController.prototype, 'start');
    const packagedMode = render(<App client={new PreviewDesktopClient({ state: 'empty' })} />);
    await screen.findByRole('button', { name: 'VOICE INPUT' });
    const packagedWorkspace = packagedMode.container.querySelector('.workspace-shell')?.innerHTML;
    expect(packagedWorkspace).toBeTruthy();
    cleanup();

    const preview = render(<App client={new PreviewDesktopClient({ state: 'empty' })} browserPreview />);
    const mic = await screen.findByRole('button', { name: 'VOICE INPUT' });
    expect(preview.container.querySelector('.workspace-shell')?.innerHTML).toBe(packagedWorkspace);

    await waitFor(() => expect(screen.getByRole('button', { name: 'VOICE INPUT' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'VOICE INPUT' }));
    expect(voiceStart).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'VOICE INPUT' })).toBeEnabled();
    expect(await screen.findByRole('status')).toHaveTextContent('Use Orquesta Next Desktop for this operation.');
    expect(screen.queryByText('プレビュー音声入力')).not.toBeInTheDocument();
  });

  test('routes the same microphone control to Native capture outside browser preview', async () => {
    const voiceStart = vi.spyOn(VoiceCaptureController.prototype, 'start')
      .mockRejectedValue(new Error('expected Native capture boundary test stop'));
    render(<App client={new PreviewDesktopClient({ state: 'empty' })} />);

    await userEvent.setup().click(await screen.findByRole('button', { name: 'VOICE INPUT' }));

    await waitFor(() => expect(voiceStart).toHaveBeenCalledTimes(1));
  });

  test('does not submit during IME composition and submits the next Enter exactly once', async () => {
    const client = new PreviewDesktopClient();
    const send = vi.spyOn(client, 'sendMessage').mockResolvedValue({
      receipt: { dispatchId: 'dispatch-ime', threadId: 'thread-ime', turnId: 'turn-ime' },
      dispatchRecovery: null,
    });
    render(<App client={client} />);
    await screen.findByLabelText('Instruction to agent');
    await waitFor(() => expect(screen.getByLabelText('Instruction to agent')).toBeEnabled());
    const draft = screen.getByLabelText('Instruction to agent');
    fireEvent.change(draft, { target: { value: '送信しない変換中の本文' } });

    fireEvent.compositionStart(draft);
    fireEvent.keyDown(draft, { key: 'Enter', code: 'Enter', keyCode: 229 });

    expect(send).not.toHaveBeenCalled();
    expect(draft).toHaveValue('送信しない変換中の本文');
    await waitFor(() => expect(screen.getByRole('button', { name: 'SEND' })).toBeEnabled());

    fireEvent.compositionEnd(draft);
    fireEvent.keyDown(draft, { key: 'Enter', code: 'Enter', keyCode: 13, isComposing: false });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  });

  test('shows legacy project state as preserved migration work instead of a raw bootstrap error', async () => {
    render(<App client={projectPreparationScenario({
      status: 'migration_required', noWrite: true,
      reason: 'organization_v2_migration_required', classification: 'legacy_v2',
    }, { state: 'uninitialized' })} />);

    expect(await screen.findByText('DATA PRESERVED / MIGRATION PENDING')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: /legacy Orquesta data/ })).toBeInTheDocument();
    expect(screen.queryByText('organization_v2_migration_required')).not.toBeInTheDocument();
  });

  test('shows an honest project-start failure and retries the same active project from WORK', async () => {
    const user = userEvent.setup();
    const client = withBootstrap(new PreviewDesktopClient({ state: 'uninitialized' }), (bootstrap) => ({
      ...bootstrap,
      snapshot: null,
    }));
    vi.spyOn(client, 'bootstrapProject').mockResolvedValue({ status: 'ready', noWrite: false, reason: null });
    const snapshotReads = vi.spyOn(client, 'readSnapshot')
      .mockRejectedValueOnce(new Error('injected snapshot preparation failure'))
      .mockResolvedValue(structuredClone(previewSnapshot));
    render(<App client={client} />);

    expect(await screen.findByRole('heading', { level: 1, name: /Could not start/ })).toBeInTheDocument();
    expect(screen.queryByText('Preparing the orchestrator and foundation agents…')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'TRY AGAIN' }));

    expect(await screen.findByRole('heading', { name: 'Orchestrator', level: 1 })).toBeInTheDocument();
    expect(snapshotReads.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  test('keeps migration blocking visible when legacy agent rows are still present', async () => {
    render(<App client={projectPreparationScenario({
      status: 'migration_required', noWrite: true,
      reason: 'organization_v2_migration_required', classification: 'legacy_v2',
    })} />);

    expect(await screen.findByText('DATA PRESERVED / MIGRATION PENDING')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: 'Orchestrator' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Instruction to agent')).toBeDisabled();
  });

  test('does not describe mixed v2 and v3 authority as an ordinary legacy migration', async () => {
    render(<App client={projectPreparationScenario({
      status: 'migration_required', noWrite: true,
      reason: 'legacy_and_v3_authority_mixed', classification: 'mixed_v2',
    }, { state: 'uninitialized' })} />);

    expect(await screen.findByRole('heading', { level: 1, name: /cannot be opened safely/ })).toBeInTheDocument();
    expect(screen.queryByText('DATA PRESERVED / MIGRATION PENDING')).not.toBeInTheDocument();
    expect(screen.queryByText('legacy_and_v3_authority_mixed')).not.toBeInTheDocument();
  });

  test('starts an uninitialized project directly in the orchestrator conversation', async () => {
    const user = userEvent.setup();
    const retiredGuideKey = 'orquesta.desktop-next.project-start-tip.v1.orquesta-v5';
    window.localStorage.setItem(retiredGuideKey, 'dismissed');
    render(<App client={projectPreparationScenario({ status: 'ready', noWrite: false, reason: null }, { state: 'uninitialized' })} />);

    expect(await screen.findByRole('heading', { name: 'Orchestrator', level: 1 })).toBeInTheDocument();
    expect(screen.getByLabelText('Project start tip')).toHaveTextContent('Tell the orchestrator about this project');
    expect(screen.queryByText('START SETUP')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Dismiss tip' }));
    expect(screen.queryByLabelText('Project start tip')).not.toBeInTheDocument();
    expect(window.localStorage.getItem(retiredGuideKey)).toBe('dismissed');

    await user.click(screen.getByRole('button', { name: 'MAP' }));
    await user.click(screen.getByRole('button', { name: 'WORK' }));
    expect(screen.queryByLabelText('Project start tip')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Desktop settings');
    expect(screen.getByRole('dialog')).not.toHaveTextContent('Project setup');
  });

  test('keeps the project start tip dismissal isolated per project for one app lifetime', async () => {
    const user = userEvent.setup();
    const projectState = (projectId: string): ApplicationState => {
      const snapshot = structuredClone(previewSnapshot);
      snapshot.project = { ...snapshot.project, id: projectId, title: `Project ${projectId}` };
      const activationToken = `activation-${projectId}`;
      return {
        ...createInitialApplicationState(),
        phase: 'workspace',
        route: 'work',
        projects: [snapshot.project],
        selectedProjectId: projectId,
        snapshot,
        runtimeStatus: {
          lifecycle: 'Ready', projectId, activationToken,
          rendererSessionId: 'renderer-guide-test', rendererGeneration: 1,
          runtimeGeneration: 'guide-test-runtime', statusRevision: 1, failureReason: null,
        },
        rendererAuthority: { rendererSessionId: 'renderer-guide-test', rendererGeneration: 1 },
        runtimeAuthority: {
          projectId, activationToken,
          rendererSessionId: 'renderer-guide-test', rendererGeneration: 1,
        },
        selectedAgentId: 'orchestrator',
        projectBootstrap: { status: 'ready', noWrite: false, reason: null, classification: null },
      };
    };
    const store = {
      setRoute: vi.fn(),
      selectAgent: vi.fn(),
    } as unknown as ApplicationStore;
    const renderWorkspace = (state: ApplicationState) => (
      <WorkspaceView
        state={state}
        store={store}
        locale="en"
        onLocaleChange={() => undefined}
        onNotificationsChange={async () => 'saved'}
      />
    );
    const projectA = projectState('project-a');
    const projectB = projectState('project-b');
    const view = render(renderWorkspace(projectA));

    expect(screen.getByLabelText('Project start tip')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Dismiss tip' }));
    expect(screen.queryByLabelText('Project start tip')).not.toBeInTheDocument();

    view.rerender(renderWorkspace({ ...createInitialApplicationState(), phase: 'launcher', route: 'work' }));
    expect(screen.queryByLabelText('Project start tip')).not.toBeInTheDocument();

    view.rerender(renderWorkspace(projectB));
    expect(screen.getByLabelText('Project start tip')).toBeInTheDocument();

    view.rerender(renderWorkspace(projectA));
    expect(screen.queryByLabelText('Project start tip')).not.toBeInTheDocument();

    view.unmount();
    render(renderWorkspace(projectA));
    expect(screen.getByLabelText('Project start tip')).toBeInTheDocument();
  });

  test('starts in WORK, keeps Luca reachable and separates Settings from language switching', async () => {
    const user = userEvent.setup();
    render(<App client={new PreviewDesktopClient()} />);

    expect(await screen.findByRole('heading', { name: 'Orchestrator', level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'WORK' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('region', { name: 'Work conversation' })).toBeInTheDocument();
    expect(within(screen.getByRole('complementary', { name: 'Work' })).queryByRole('button', { name: /Luca/ })).not.toBeInTheDocument();
    expect(within(screen.getByRole('complementary', { name: 'Work' })).queryByRole('button', { name: /User support/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'WORKFLOWS' }));
    expect(await screen.findByRole('heading', { name: 'WORKFLOWS' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'LIBRARY 0' })).toHaveAttribute('aria-current', 'page');

    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Desktop settings');
    expect(screen.getByRole('button', { name: 'English' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'Close' }));

    const lucaTrigger = screen.getByRole('button', { name: 'Luca' });
    await user.click(lucaTrigger);
    expect(await screen.findByRole('dialog', { name: 'Luca' })).toHaveTextContent('ORQUESTA GUIDE');
    expect(screen.getByRole('button', { name: 'WORKFLOWS' })).toHaveAttribute('aria-current', 'page');
    await user.click(screen.getByRole('button', { name: 'Close Luca' }));
    await waitFor(() => expect(lucaTrigger).toHaveFocus());
  });

  test('uses one bounded live region instead of announcing every changing panel', async () => {
    const client = new PreviewDesktopClient();
    const conversationGate = deferred<void>();
    const historyGate = deferred<void>();
    const originalReadConversation = client.readConversation.bind(client);
    const originalReadHistoryIndex = client.readHistoryIndex.bind(client);
    const conversationRead = vi.spyOn(client, 'readConversation').mockImplementation(async (...args) => {
      const page = await originalReadConversation(...args);
      await conversationGate.promise;
      return page;
    });
    const historyRead = vi.spyOn(client, 'readHistoryIndex').mockImplementation(async (...args) => {
      const page = await originalReadHistoryIndex(...args);
      await historyGate.promise;
      return page;
    });
    const { container } = render(<App client={client} />);

    expect(await screen.findByRole('heading', { name: 'Orchestrator', level: 1 })).toBeInTheDocument();
    await waitFor(() => {
      expect(conversationRead).toHaveBeenCalled();
      expect(historyRead).toHaveBeenCalled();
    });
    const currentAnnouncingRegions = () => container.querySelectorAll('[aria-live="polite"], [aria-live="assertive"]');
    expect(currentAnnouncingRegions()).toHaveLength(1);
    expect(currentAnnouncingRegions()[0]).toHaveAttribute('aria-live', 'polite');
    expect(currentAnnouncingRegions()[0]).toHaveAttribute('aria-label', '');

    conversationGate.resolve();
    expect(await screen.findByText('了解。まずCSVの列を確認し、保存前に追加・更新・エラーの件数を見られるプレビューを作ります。')).toBeInTheDocument();
    expect(currentAnnouncingRegions()[0]).toHaveAttribute('aria-label', '');

    const historyReadPromise = historyRead.mock.results[0]?.value;
    expect(historyReadPromise).toBeDefined();
    historyGate.resolve();
    await act(async () => {
      await historyReadPromise;
      await Promise.resolve();
    });
    expect(currentAnnouncingRegions()[0]).toHaveAttribute('aria-label', '');
    expect(container.querySelector('.orquesta-thread-viewport')).toHaveAttribute('aria-live', 'off');
  });

  test('persists appearance and reduced motion through the single Native settings update path', async () => {
    const client = new PreviewDesktopClient();
    const settingsWrite = installSettingsWriter(client);
    const user = userEvent.setup();
    render(<App client={client} />);

    await user.click(await screen.findByRole('button', { name: /Settings|設定/ }));
    const settingsDialog = screen.getByRole('dialog');
    expect(within(settingsDialog).getByRole('heading', { name: /System status|システムの状態/ })).toBeInTheDocument();
    expect(within(settingsDialog).getByText('Runtime')).toBeInTheDocument();
    expect(within(settingsDialog).getByText('Voice')).toBeInTheDocument();
    expect(within(settingsDialog).getByText('whisper.cpp-local · Ready')).toBeInTheDocument();
    expect(within(settingsDialog).queryByText(/2\/3 assets/)).not.toBeInTheDocument();
    expect(within(settingsDialog).getByText('Observed · gpt-5.6-sol')).toBeInTheDocument();
    expect(within(settingsDialog).getByText(/Native SQLite · \d+\+? summaries shown/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Dark|ダーク/ }));
    await waitFor(() => expect(document.querySelector('.application-root')).toHaveAttribute('data-theme', 'dark'));
    await user.click(screen.getByRole('button', { name: /Reduce motion: Off|動きを減らす: オフ/ }));
    await waitFor(() => expect(document.querySelector('.application-root')).toHaveAttribute('data-reduced-motion', 'true'));

    expect(settingsWrite.mock.calls.at(-2)?.[1].theme).toBe('dark');
    expect(settingsWrite.mock.calls.at(-1)?.[1].reducedMotion).toBe(true);
  });

  test('never presents a requested or recommended model as observed', async () => {
    const user = userEvent.setup();
    const client = withBootstrap(new PreviewDesktopClient(), (bootstrap) => ({
      ...bootstrap,
      snapshot: bootstrap.snapshot
        ? {
            ...bootstrap.snapshot,
            tasks: bootstrap.snapshot.tasks.map((task) => ({ ...task, actualModel: null })),
          }
        : null,
    }));
    render(<App client={client} />);

    await user.click(await screen.findByRole('button', { name: /Settings|設定/ }));
    const settingsDialog = screen.getByRole('dialog');
    const modelRow = within(settingsDialog).getByText('Model').parentElement!;
    expect(modelRow).toHaveTextContent('Not observed');
    expect(modelRow).not.toHaveTextContent('gpt-5.6-sol');
    expect(modelRow).not.toHaveTextContent('gpt-5.6-terra');
  });

  test('requests notification permission only from the Settings toggle and saves after grant', async () => {
    const client = new PreviewDesktopClient();
    const settingsWrite = installSettingsWriter(client);
    const gateway = new PermissionNotificationGateway('granted');
    const user = userEvent.setup();
    render(<App client={client} notificationGateway={gateway} />);

    await screen.findByRole('button', { name: /Settings|設定/ });
    expect(gateway.permissionChecks).toBe(0);
    expect(gateway.permissionRequests).toBe(0);
    await user.click(screen.getByRole('button', { name: /Settings|設定/ }));
    const notificationSection = screen.getByRole('heading', { name: 'Desktop notifications' }).closest('section')!;
    await user.click(within(notificationSection).getByRole('button', { name: 'Desktop notifications: Off' }));

    await waitFor(() => expect(settingsWrite.mock.calls.at(-1)?.[1].notificationsEnabled).toBe(true));
    expect(gateway.permissionChecks).toBe(1);
    expect(gateway.permissionRequests).toBe(1);
  });

  test('keeps notifications disabled when the OS permission request is denied', async () => {
    const client = new PreviewDesktopClient();
    const settingsWrite = installSettingsWriter(client);
    const gateway = new PermissionNotificationGateway('denied');
    const user = userEvent.setup();
    render(<App client={client} notificationGateway={gateway} />);

    await user.click(await screen.findByRole('button', { name: /Settings|設定/ }));
    const notificationSection = screen.getByRole('heading', { name: 'Desktop notifications' }).closest('section')!;
    await user.click(within(notificationSection).getByRole('button', { name: 'Desktop notifications: Off' }));

    expect(await within(notificationSection).findByRole('status')).toHaveTextContent('Desktop notifications were not allowed');
    expect(settingsWrite.mock.calls.some((call) => call[1].notificationsEnabled)).toBe(false);
  });

  test('does not misreport a Native settings save failure as an OS permission denial', async () => {
    const client = new PreviewDesktopClient();
    const settingsWrite = vi.spyOn(client, 'updateSettings').mockRejectedValue(new Error('settings unavailable'));
    const gateway = new PermissionNotificationGateway('granted');
    const user = userEvent.setup();
    render(<App client={client} notificationGateway={gateway} />);

    await user.click(await screen.findByRole('button', { name: /Settings|設定/ }));
    const notificationSection = screen.getByRole('heading', { name: 'Desktop notifications' }).closest('section')!;
    await user.click(within(notificationSection).getByRole('button', { name: 'Desktop notifications: Off' }));

    await screen.findByRole('alert');
    expect(within(notificationSection).queryByText(/not allowed|許可されませんでした/iu)).toBeNull();
    expect(settingsWrite.mock.calls.some((call) => call[1].notificationsEnabled)).toBe(true);
  });

  test('attempts a missing-locale migration only once for the same Native revision', async () => {
    const localeFailureClient = () => {
      const candidate = withBootstrap(new PreviewDesktopClient(), (bootstrap) => ({
        ...bootstrap,
        settings: { ...bootstrap.settings, locale: null },
      }));
      const update = vi.spyOn(candidate, 'updateSettings').mockRejectedValue(new Error('settings unavailable'));
      return { candidate, update };
    };
    const first = localeFailureClient();
    const client = first.candidate;
    const mounted = render(<App client={client} />);

    await screen.findByRole('alert');
    await act(async () => { await Promise.resolve(); });
    expect(first.update).toHaveBeenCalledTimes(1);
    mounted.rerender(<App client={client} />);
    await act(async () => { await Promise.resolve(); });
    expect(first.update).toHaveBeenCalledTimes(1);

    mounted.unmount();
    const remounted = localeFailureClient();
    const remountedClient = remounted.candidate;
    render(<App client={remountedClient} />);
    await screen.findByRole('alert');
    await act(async () => { await Promise.resolve(); });
    expect(remounted.update).toHaveBeenCalledTimes(1);
  });

  test('uses lang query only for Browser Preview and never overrides packaged Native settings', async () => {
    window.history.replaceState({}, '', '/?lang=ja');
    const packaged = render(<App client={new PreviewDesktopClient()} />);
    await screen.findByRole('button', { name: 'Settings' });
    expect(packaged.container.querySelector('.application-root')).toHaveAttribute('lang', 'en');
    packaged.unmount();

    const preview = render(<App client={new PreviewDesktopClient()} browserPreview />);
    await screen.findByRole('button', { name: '設定' });
    expect(preview.container.querySelector('.application-root')).toHaveAttribute('lang', 'ja');
  });

  test('retires the old locale key after Native settings establish locale authority', async () => {
    window.localStorage.setItem('orquesta.desktop-next.locale', 'en');
    render(<App client={new PreviewDesktopClient()} />);

    await screen.findByRole('button', { name: /Settings|設定/ });
    await waitFor(() => expect(window.localStorage.getItem('orquesta.desktop-next.locale')).toBeNull());
  });

  test('renders workflow and evidence states through the shared user-copy boundary', async () => {
    const user = userEvent.setup();
    const client = new PreviewDesktopClient();
    vi.spyOn(client, 'readWorkflowCatalog').mockResolvedValue({
      maxAttemptsPerBatch: 50,
      definitions: [{
        workflowId: 'workflow-copy', name: 'Copy boundary', prompt: 'Check user-facing status copy.',
        checks: [], createdAt: '2026-08-28T00:00:00.000Z', updatedAt: '2026-08-28T00:00:00.000Z',
      }],
      batches: [{
        batchId: 'batch-copy', workflowId: 'workflow-copy', requestedRuns: 1, status: 'cancelling',
        createdAt: '2026-08-28T00:00:00.000Z', completedAt: null,
        metrics: {
          requestedRuns: 1, terminalRuns: 0, completedRuns: 0, failedRuns: 0, cancelledRuns: 0,
          assessedRuns: 0, passedRuns: 0, executionReliabilityPercent: 0, successRatePercent: null,
          outcomeConsistencyPercent: null, medianDurationMs: null,
        },
        attempts: [{
          attemptId: 'attempt-copy', ordinal: 1, status: 'starting', resultPreview: null,
          checkOutcome: 'unassessed', errorMessage: null, completedAt: null, durationMs: null,
        }],
      }],
    });
    render(<App client={client} />);

    await user.click(await screen.findByRole('button', { name: 'WORKFLOWS' }));
    await user.click(screen.getByRole('button', { name: 'DESIGNER' }));
    expect(await screen.findByText('Stopping')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '#1 Starting / Not assessed' })).toBeInTheDocument();
    expect(screen.queryByText('cancelling')).not.toBeInTheDocument();
    expect(screen.queryByText('unassessed')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'HISTORY' }));
    await user.click(screen.getByRole('button', { name: 'EVIDENCE' }));
    expect((await screen.findAllByText('Verified')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText(/Runtime record|Decision record|Report/)).length).toBeGreaterThan(0);
    expect(screen.queryByText('proven')).not.toBeInTheDocument();
  });

  test('restores the validated last-WORK agent without a mount-time coordinator overwrite', async () => {
    const client = withBootstrap(new PreviewDesktopClient(), (bootstrap) => ({
      ...bootstrap,
      projects: bootstrap.projects.map((project) => project.id === bootstrap.selectedProjectId
        ? { ...project, lastWorkAgentId: 'frontend' }
        : project),
    }));
    const recordLastWorkAgent = vi.spyOn(client, 'recordLastWorkAgent').mockImplementation(
      async (_authority, targetAgentId) => ({ ...structuredClone(previewSnapshot.project), lastWorkAgentId: targetAgentId }),
    );
    render(<App client={client} />);

    expect(await screen.findByRole('heading', { name: 'Review', level: 1 })).toBeInTheDocument();
    await waitFor(() => expect(recordLastWorkAgent).not.toHaveBeenCalled());
    const sidebar = screen.getByRole('complementary', { name: 'Project navigation' });
    expect(within(sidebar).queryByText('RECENT PROJECTS')).not.toBeInTheDocument();
    const settings = within(sidebar).getByRole('button', { name: 'Settings' });
    const runtime = within(sidebar).getByText('Runtime');
    expect(settings.compareDocumentPosition(runtime) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  test('opens a work order in WORK and shows its context only on request', async () => {
    const user = userEvent.setup();
    render(<App client={new PreviewDesktopClient()} />);
    const order = await screen.findByRole('button', { name: /Desktop Next を統合する/ });
    await user.click(order);
    await user.click(screen.getByRole('button', { name: 'Details' }));

    expect(screen.getByRole('complementary', { name: 'Selected work details' })).toHaveTextContent('WORK ORDER');
    expect(screen.getByRole('complementary', { name: 'Selected work details' })).toHaveTextContent('4/5');
  });

  test('does not duplicate decision agents and keeps durable history separate from conversation', async () => {
    const user = userEvent.setup();
    render(<App client={new PreviewDesktopClient()} />);

    expect(await screen.findByRole('heading', { name: 'Orchestrator', level: 1 })).toBeInTheDocument();
    expect(screen.queryByText('NEEDS ATTENTION')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Release/ })).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'DECISIONS' }));
    expect(await screen.findByRole('heading', { name: 'DECISIONS' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Review request' }));
    expect(await screen.findByRole('button', { name: 'Accept once' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accept for session' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Decline' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'DECISIONS' }));
    await user.click(within(screen.getByRole('navigation', { name: 'Decision view' })).getByRole('button', { name: 'HISTORY' }));
    expect(screen.getByRole('heading', { name: 'Review file changes' })).toBeInTheDocument();

    await user.click(within(screen.getByRole('navigation', { name: 'Workspace' })).getByRole('button', { name: 'HISTORY' }));
    expect(await screen.findByRole('heading', { name: 'HISTORY' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ACTIVITY' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('Import preview ready')).toBeInTheDocument();
  });

  test('disables an approval immediately when its provider outcome becomes unknown', async () => {
    const user = userEvent.setup();
    const client = new PreviewDesktopClient();
    let outcomeUnknown = false;
    const readConversation = client.readConversation.bind(client);
    vi.spyOn(client, 'readConversation').mockImplementation(async (...args) => {
      const page = await readConversation(...args);
      return outcomeUnknown ? {
        ...page,
        pendingRequests: page.pendingRequests.map((request) => request.requestKey === 'runtime-approval-req-1'
          ? { ...request, responsePhase: 'outcome_unknown' as const, recoveryState: 'stale' as const }
          : request),
      } : page;
    });
    const approval = vi.spyOn(client, 'respondToApproval').mockImplementation(async () => {
      outcomeUnknown = true;
      throw {
        message: 'provider response outcome unknown',
        outcomeUnknown: true,
      };
    });
    render(<App client={client} />);

    await user.click(await screen.findByRole('button', { name: 'DECISIONS' }));
    await user.click(screen.getByRole('button', { name: 'Review request' }));
    const accept = await screen.findByRole('button', { name: 'Accept once' });
    await user.click(accept);

    expect(await screen.findByText('Delivery of the decision is unknown, so another response is blocked for this request.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept once' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Provider|App Server|実行権限|永続台帳|runtime boundary|write access|session acknowledgement/iu)).not.toBeInTheDocument();
    expect(approval).toHaveBeenCalledTimes(1);
  });

  test('keeps runtime approval meaning and localized copy after it moves to decision history', async () => {
    window.localStorage.setItem('orquesta.desktop-next.locale', 'ja');
    const user = userEvent.setup();
    const client = withBootstrap(new PreviewDesktopClient(), (bootstrap) => ({
      ...bootstrap,
      settings: { ...bootstrap.settings, locale: 'ja' },
    }));
    const requestKey = 'runtime-approval-req-1';
    let approvalResolved = false;
    vi.spyOn(client, 'respondToApproval').mockImplementation(async () => { approvalResolved = true; });
    const readConversation = client.readConversation.bind(client);
    vi.spyOn(client, 'readConversation').mockImplementation(async (...args) => {
      const page = await readConversation(...args);
      if (!approvalResolved) return page;
      const pending = page.pendingRequests.find((request) => request.requestKey === requestKey);
      return {
        ...page,
        pendingRequests: page.pendingRequests.filter((request) => request.requestKey !== requestKey),
        resolvedRequests: pending
          ? [...page.resolvedRequests, {
              requestKey: pending.requestKey,
              agentId: pending.agentId,
              requestKind: pending.requestKind,
              responseOptions: pending.responseOptions,
              createdAt: pending.createdAt,
              resolvedAt: '2026-08-10T08:43:00.000Z',
              requestedEffectKind: pending.requestedEffectKind,
              responseDecision: 'accept',
            }]
          : page.resolvedRequests,
      };
    });
    render(<App client={client} />);

    await user.click(await screen.findByRole('button', { name: 'DECISIONS' }));
    await user.click(screen.getByRole('button', { name: '内容を確認' }));
    expect((await screen.findAllByRole('heading', { name: 'ファイル変更の確認' })).length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: '今回のみ許可' }));

    await user.click(await screen.findByRole('button', { name: 'DECISIONS' }));
    await user.click(within(screen.getByRole('navigation', { name: '判断の表示' })).getByRole('button', { name: 'HISTORY' }));
    expect((await screen.findAllByRole('heading', { name: 'ファイル変更の確認' })).length).toBeGreaterThan(0);
    expect(screen.queryByText('確認が必要です')).not.toBeInTheDocument();
  });

  test('renders projected conversation as left/right chat and loads older pages without a scroll jump', async () => {
    const user = userEvent.setup();
    render(<App client={new PreviewDesktopClient({ conversationMessageCount: 65 })} />);

    const latestAgent = await screen.findByText('Preview agent message 16');
    const latestUser = screen.getByText('Preview user message 65');
    expect(screen.queryByText('Preview user message 15')).not.toBeInTheDocument();
    expect(latestAgent.closest('.orquesta-thread-message')).toHaveClass('role-agent');
    expect(latestUser.closest('.orquesta-thread-message')).toHaveClass('role-user');

    const viewport = document.querySelector<HTMLElement>('.orquesta-thread-viewport');
    expect(viewport).not.toBeNull();
    let scrollHeight = 1_000;
    Object.defineProperty(viewport!, 'scrollHeight', { configurable: true, get: () => scrollHeight });
    viewport!.scrollTop = 20;
    viewport!.dispatchEvent(new Event('scroll'));
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      scrollHeight = 1_400;
      callback(0);
      return 1;
    });

    await user.click(screen.getByRole('button', { name: 'SHOW EARLIER MESSAGES' }));
    expect(await screen.findByText('Preview user message 01')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'SHOW EARLIER MESSAGES' })).not.toBeInTheDocument();
    expect(viewport!.scrollTop).toBe(420);
  });

  test('shares the anchored Older behavior with History and cancels adjustment after identity change', async () => {
    const user = userEvent.setup();
    render(<App client={new PreviewDesktopClient({ conversationMessageCount: 65 })} />);
    await screen.findByRole('heading', { name: 'Orchestrator', level: 1 });
    await user.click(within(screen.getByRole('navigation', { name: 'Workspace' })).getByRole('button', { name: 'HISTORY' }));
    await user.click(await screen.findByRole('button', { name: 'CONVERSATIONS' }));
    await user.click(within(await screen.findByRole('navigation', { name: 'Conversation target' }))
      .getByRole('button', { name: /Orchestrator/i }));
    expect(await screen.findByText('Preview user message 65')).toBeInTheDocument();
    expect(screen.queryByText('Preview user message 15')).not.toBeInTheDocument();

    const viewport = document.querySelector<HTMLElement>('.history-conversation-column .evidence-messages');
    expect(viewport).not.toBeNull();
    let scrollHeight = 1_000;
    Object.defineProperty(viewport!, 'scrollHeight', { configurable: true, get: () => scrollHeight });
    viewport!.scrollTop = 30;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      scrollHeight = 1_300;
      callback(0);
      return 1;
    });
    await user.click(screen.getByRole('button', { name: 'Older' }));
    expect(await screen.findByText('Preview user message 01')).toBeInTheDocument();
    expect(viewport!.scrollTop).toBe(330);

    const isolatedViewport = document.createElement('div');
    Object.defineProperty(isolatedViewport, 'scrollHeight', { configurable: true, value: 100 });
    isolatedViewport.scrollTop = 12;
    let current = true;
    const result = await loadOlderWithScrollAnchor(
      isolatedViewport,
      () => current,
      async () => { current = false; return true; },
    );
    expect(result).toBeNull();
    expect(isolatedViewport.scrollTop).toBe(12);
  });

  test('shows an honest empty search window and lets the user continue to the older range', async () => {
    const user = userEvent.setup();
    const client = new PreviewDesktopClient();
    const readBase = client.readHistoryPage.bind(client);
    vi.spyOn(client, 'readHistoryPage').mockImplementation(async (authority, targetAgentId, query, cursor) => {
      if (query !== '見つからない') return readBase(authority, targetAgentId, query, cursor);
      return {
        source: 'sqlite',
        projectId: authority.projectId,
        targetAgentId,
        query,
        items: [],
        nextCursor: cursor
          ? null
          : { beforeCreatedAt: '2026-08-17T00:00:10.000Z', beforeMessageId: 'history-scan-boundary' },
      };
    });
    render(<App client={client} />);
    await screen.findByRole('heading', { name: 'Orchestrator', level: 1 });
    await user.click(within(screen.getByRole('navigation', { name: 'Workspace' })).getByRole('button', { name: 'HISTORY' }));
    await user.click(await screen.findByRole('button', { name: 'CONVERSATIONS' }));
    await user.click(within(await screen.findByRole('navigation', { name: 'Conversation target' }))
      .getByRole('button', { name: /Orchestrator/i }));

    await user.type(screen.getByRole('searchbox', { name: 'Search conversation' }), '見つからない');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('No match in this range. Search the older range to continue.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Older' }));
    expect(await screen.findByText('No matching conversation.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Older' })).not.toBeInTheDocument();
  });

  test('exposes Copy and honest new-turn Retry on projected user messages', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const client = new PreviewDesktopClient({ conversationMessageCount: 6 });
    vi.spyOn(client, 'sendMessage').mockResolvedValue({
      receipt: { dispatchId: 'retry-dispatch', threadId: 'retry-thread', turnId: 'retry-turn' },
      dispatchRecovery: null,
    });
    render(<App client={client} />);

    const copyButtons = await screen.findAllByRole('button', { name: 'Copy message' });
    await user.click(copyButtons[0]);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(screen.getByText('COPIED')).toBeInTheDocument();

    const retryButtons = screen.getAllByRole('button', { name: 'Retry as a new turn' });
    await user.click(retryButtons[0]);
    expect(await screen.findByText('The same message was retried as a new turn.')).toBeInTheDocument();
  });

  test('renders safe structured activity cards and pages them independently from messages', async () => {
    const user = userEvent.setup();
    render(<App client={activityScenario('paged').client} />);

    expect(await screen.findByRole('article', { name: 'Plan updated, UPDATED' })).toBeInTheDocument();
    expect(screen.getByText('Connect the safe activity projection')).toBeInTheDocument();
    expect(screen.getByText('In progress')).toBeInTheDocument();
    expect(screen.queryByText('inProgress')).not.toBeInTheDocument();
    expect(screen.getByText('Raw arguments, results, and unbounded logs are not stored')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'SHOW EARLIER MESSAGES' }));

    expect(await screen.findByRole('article', { name: 'Run powershell.exe, COMPLETE' })).toBeInTheDocument();
    expect(screen.getByText('powershell.exe')).toBeInTheDocument();
    expect(screen.getByText('125 ms')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'EXPAND' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(/safe output line/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'EXPAND' }));
    expect(screen.getByText(/safe output line/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Copy safe output excerpt' }));
    expect(screen.getByText('COPIED')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'SHOW EARLIER MESSAGES' })).not.toBeInTheDocument();
  });

  test('renders a ThreadItem plan body and updates the same card from running to completed', async () => {
    const scenario = activityScenario('lifecycle');
    const client = scenario.client;
    render(<App client={client} />);

    expect(await screen.findByRole('article', { name: 'Plan, RUNNING' })).toBeInTheDocument();
    expect(screen.getByText('Inspect the provider contract, then implement the bounded card.')).toBeInTheDocument();

    scenario.complete();

    expect(await screen.findByRole('article', { name: 'Plan, COMPLETE' })).toBeInTheDocument();
    expect(screen.queryByRole('article', { name: 'Plan, RUNNING' })).not.toBeInTheDocument();
    expect(screen.getAllByText('Inspect the provider contract, then implement the bounded card.')).toHaveLength(1);
  });

  test('shows an unknown activity result without presenting it as success', async () => {
    render(<App client={activityScenario('unknown').client} />);
    expect(await screen.findByRole('article', { name: 'Plan updated, UNKNOWN' })).toBeInTheDocument();
    expect(screen.queryByRole('article', { name: 'Plan updated, COMPLETE' })).not.toBeInTheDocument();
  });

  test('routes the HTML picker and file drop through one attachment import path and keeps text drops native', async () => {
    const objectUrls = installObjectUrlHarness();
    try {
      const user = userEvent.setup();
      const { client, importedNames } = attachmentScenario();
      render(<App client={client} />);
      const attach = await screen.findByRole('button', { name: 'Attach files' });
      const firstBytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
      const sameFile = imageFile('same.png', 'image/png', firstBytes);

      await user.click(attach);
      let input = document.querySelector<HTMLInputElement>('input[type="file"]');
      expect(input).not.toBeNull();
      expect(input?.getAttribute('accept')).toContain('.png');
      expect(input?.getAttribute('accept')).toContain('.txt');
      await user.upload(input!, sameFile);
      await waitFor(() => expect(importedNames).toEqual([['same.png']]));

      input = document.querySelector<HTMLInputElement>('input[type="file"]');
      expect(input).not.toBeNull();
      await user.upload(input!, sameFile);
      await waitFor(() => expect(importedNames).toEqual([['same.png'], ['same.png']]));

      const composer = document.querySelector<HTMLElement>('.composer');
      expect(composer).not.toBeNull();
      const droppedFile = imageFile(
        'drop.jpg',
        'image/jpeg',
        Uint8Array.from([255, 216, 255, 224, 2]),
      );
      fireEvent.drop(composer!, { dataTransfer: { files: [droppedFile], types: ['Files'] } });
      await waitFor(() => expect(importedNames).toEqual([['same.png'], ['same.png'], ['drop.jpg']]));

      const textDrop = new Event('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(textDrop, 'dataTransfer', {
        value: { files: [], types: ['text/plain'] },
      });
      fireEvent(composer!, textDrop);
      expect(textDrop.defaultPrevented).toBe(false);

      await waitFor(() => expect(objectUrls.createObjectURL).toHaveBeenCalledTimes(3));
      expect(objectUrls.blobs[0].type).toBe('image/png');
      expect(await readBlobBytes(objectUrls.blobs[0])).toEqual(firstBytes);
      expect(objectUrls.revokeObjectURL).not.toHaveBeenCalled();
    } finally {
      cleanup();
      objectUrls.restore();
    }
  });

  test('renders an ordinary text file as a card without fetching its sealed bytes for preview', async () => {
    const user = userEvent.setup();
    const { client, importedNames, readAttachmentPreview } = attachmentScenario();
    render(<App client={client} />);
    await screen.findByRole('button', { name: 'Attach files' });
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();

    await user.upload(
      input!,
      imageFile('notes.txt', 'text/plain', Uint8Array.from(new TextEncoder().encode('hello, world\n'))),
    );

    await waitFor(() => expect(importedNames).toEqual([['notes.txt']]));
    expect(await screen.findByText('notes.txt')).toBeInTheDocument();
    expect(readAttachmentPreview).not.toHaveBeenCalled();
    expect(document.querySelector('.attachment-preview img')).toBeNull();
  });

  test('lets Native own the image preview limit and surfaces its typed refusal', async () => {
    const user = userEvent.setup();
    const scenario = attachmentScenario();
    scenario.readAttachmentPreview.mockRejectedValue(Object.assign(
      new Error('preview rejected by Native'),
      { code: 'attachment_preview_too_large' },
    ));
    render(<App client={scenario.client} />);
    await screen.findByRole('button', { name: 'Attach files' });
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    await user.upload(input!, imageFile(
      'large-preview.png',
      'image/png',
      Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    ));

    await waitFor(() => expect(scenario.readAttachmentPreview).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(document.querySelector('.attachment-preview')).toHaveAttribute(
      'title',
      'This image exceeds the preview limit and cannot be shown.',
    ));
  });

  test('keeps sealed preview URLs bounded and revokes them on removal and unmount', async () => {
    const objectUrls = installObjectUrlHarness();
    try {
      const user = userEvent.setup();
      const { client } = attachmentScenario();
      const view = render(<App client={client} />);
      await screen.findByRole('button', { name: 'Attach files' });
      const input = document.querySelector<HTMLInputElement>('input[type="file"]');
      await user.upload(input!, imageFile(
        'remove.png',
        'image/png',
        Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
      ));
      await waitFor(() => expect(objectUrls.createObjectURL).toHaveBeenCalledTimes(1));
      expect(objectUrls.revokeObjectURL).not.toHaveBeenCalled();

      await user.click(screen.getByRole('button', { name: 'remove.png remove' }));
      await waitFor(() => expect(objectUrls.revokeObjectURL).toHaveBeenCalledWith('blob:orquesta-preview-1'));

      const nextInput = document.querySelector<HTMLInputElement>('input[type="file"]');
      await user.upload(nextInput!, imageFile(
        'unmount.png',
        'image/png',
        Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 2]),
      ));
      await waitFor(() => expect(objectUrls.createObjectURL).toHaveBeenCalledTimes(2));
      view.unmount();
      expect(objectUrls.revokeObjectURL).toHaveBeenCalledWith('blob:orquesta-preview-2');
    } finally {
      cleanup();
      objectUrls.restore();
    }
  });

  test('discards a sealed preview response that completes after its attachment was removed', async () => {
    const objectUrls = installObjectUrlHarness();
    try {
      const user = userEvent.setup();
      const scenario = attachmentScenario();
      const client = scenario.client;
      const preview = deferred<ArrayBuffer>();
      scenario.readAttachmentPreview.mockImplementation(() => preview.promise);
      render(<App client={client} />);
      await screen.findByRole('button', { name: 'Attach files' });
      const input = document.querySelector<HTMLInputElement>('input[type="file"]');
      await user.upload(input!, imageFile(
        'stale.png',
        'image/png',
        Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
      ));
      await waitFor(() => expect(scenario.readAttachmentPreview).toHaveBeenCalled());

      await user.click(screen.getByRole('button', { name: 'stale.png remove' }));
      preview.resolve(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]).buffer);
      await Promise.resolve();
      await Promise.resolve();

      expect(objectUrls.createObjectURL).not.toHaveBeenCalled();
      expect(screen.queryByText('stale.png')).not.toBeInTheDocument();
    } finally {
      cleanup();
      objectUrls.restore();
    }
  });

  test('invalidates an older-page anchor and follows the latest message when the agent changes', async () => {
    const user = userEvent.setup();
    const client = new PreviewDesktopClient({ conversationMessageCount: 65 });
    const olderGate = deferred<void>();
    const readBase = client.readConversation.bind(client);
    const conversationRead = vi.spyOn(client, 'readConversation').mockImplementation(async (...args) => {
      const page = await readBase(...args);
      if (args[3]) await olderGate.promise;
      return page;
    });
    render(<App client={client} />);
    await screen.findByText('Preview agent message 16');

    const viewport = document.querySelector<HTMLElement>('.orquesta-thread-viewport');
    expect(viewport).not.toBeNull();
    let scrollHeight = 1_000;
    Object.defineProperty(viewport!, 'scrollHeight', { configurable: true, get: () => scrollHeight });
    viewport!.scrollTop = 20;
    viewport!.dispatchEvent(new Event('scroll'));
    await user.click(screen.getByRole('button', { name: 'SHOW EARLIER MESSAGES' }));
    await waitFor(() => expect(conversationRead.mock.calls.some((call) => Boolean(call[3]))).toBe(true));

    scrollHeight = 500;
    const workLedger = screen.getByRole('complementary', { name: 'Work' });
    await user.click(within(workLedger).getByRole('button', { name: /Release/ }));
    expect(await screen.findByRole('heading', { name: 'Release', level: 1 })).toBeInTheDocument();
    await waitFor(() => expect(viewport!.scrollTop).toBe(500));

    olderGate.resolve();
    await waitFor(() => expect(screen.getByText('The sample import is ready. Please review the preview, then decide whether to add these customers.')).toBeInTheDocument());
    expect(viewport!.scrollTop).toBe(500);
    expect(screen.queryByText('Preview user message 01')).not.toBeInTheDocument();
  });

  test('opens map work details only after selecting an agent', async () => {
    const user = userEvent.setup();
    render(<App client={new PreviewDesktopClient()} />);

    await screen.findByRole('heading', { name: 'Orchestrator', level: 1 });
    await user.click(screen.getByRole('button', { name: 'MAP' }));
    expect(screen.queryByRole('complementary', { name: 'Agent details' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Implementation, Working, SOL' }));
    const details = screen.getByRole('complementary', { name: 'Agent details' });
    expect(details).toHaveTextContent('SOL');
    expect(details).toHaveTextContent('Add customer CSV import');

    await user.click(screen.getByRole('button', { name: 'Close details' }));
    expect(screen.queryByRole('complementary', { name: 'Agent details' })).not.toBeInTheDocument();
  });

  test('keeps the current project map arrangement while moving between MAP and WORK', async () => {
    const user = userEvent.setup();
    const { container } = render(<App client={new PreviewDesktopClient()} />);

    await screen.findByRole('heading', { name: 'Orchestrator', level: 1 });
    await user.click(screen.getByRole('button', { name: 'MAP' }));
    await user.click(screen.getByRole('button', { name: 'Radial layout' }));
    const stage = container.querySelector('.map-network-stage')!;
    Object.defineProperty(stage, 'getBoundingClientRect', {
      value: () => ({ x: 0, y: 0, top: 0, left: 0, right: 1000, bottom: 600, width: 1000, height: 600, toJSON: () => ({}) }),
    });
    const node = container.querySelector('[data-agent-id="native"]')!;
    const frame = node.closest('foreignObject')!;
    const automatic = [frame.getAttribute('x'), frame.getAttribute('y')];
    const dispatch = (type: string, clientX: number, clientY: number, buttons: number) => {
      const event = new Event(type, { bubbles: true });
      Object.defineProperties(event, {
        pointerId: { value: 21 }, clientX: { value: clientX }, clientY: { value: clientY }, buttons: { value: buttons },
      });
      fireEvent(node, event);
    };
    dispatch('pointerdown', 430, 260, 1);
    dispatch('pointermove', 12_520, 9_350, 1);
    dispatch('pointerup', 12_520, 9_350, 0);
    const manual = [frame.getAttribute('x'), frame.getAttribute('y')];
    expect(manual).not.toEqual(automatic);

    await user.click(screen.getByRole('button', { name: 'WORK' }));
    await user.click(screen.getByRole('button', { name: 'MAP' }));
    expect(screen.getByRole('button', { name: 'Radial layout' })).toHaveAttribute('aria-pressed', 'true');
    const restoredFrame = container.querySelector('[data-agent-id="native"]')!.closest('foreignObject')!;
    expect([restoredFrame.getAttribute('x'), restoredFrame.getAttribute('y')]).toEqual(manual);
    const [viewX, viewY, viewWidth, viewHeight] = container.querySelector('.map-network-svg')!.getAttribute('viewBox')!.split(' ').map(Number);
    const restoredCenter = {
      x: Number(restoredFrame.getAttribute('x')) + 92,
      y: Number(restoredFrame.getAttribute('y')) + 35,
    };
    expect(restoredCenter.x).toBeGreaterThanOrEqual(viewX);
    expect(restoredCenter.x).toBeLessThanOrEqual(viewX + viewWidth);
    expect(restoredCenter.y).toBeGreaterThanOrEqual(viewY);
    expect(restoredCenter.y).toBeLessThanOrEqual(viewY + viewHeight);
  });
});
