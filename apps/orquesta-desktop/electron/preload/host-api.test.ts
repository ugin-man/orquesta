import { describe, expect, test, vi } from 'vitest';
import { emptyV4OperationsSnapshot } from '../../src/contracts/orquesta-ui';
import { DESKTOP_IPC } from '../shared/host-contract';
import { createDesktopHostApi } from './host-api';

describe('createDesktopHostApi', () => {
  test('exposes bounded methods instead of raw IPC', async () => {
    const snapshot = { project: { id: 'repo-1', title: 'Repo' }, agents: [], tasks: [], attention: [], phases: [], recentEvents: [], v4Operations: emptyV4OperationsSnapshot() };
    const invoke = vi.fn(async (channel: string, input?: unknown) => {
      if (channel === DESKTOP_IPC.getHostInfo) return { platform: 'win32', coreStatus: 'ready' };
      if (channel === DESKTOP_IPC.getRepositorySnapshot) return snapshot;
      if (channel === DESKTOP_IPC.listRepositories) return [];
      if (channel === DESKTOP_IPC.switchRepository || channel === DESKTOP_IPC.openRepository) return { status: 'accepted', correlationId: 'action-1' };
      if (channel === DESKTOP_IPC.sendMessage) return { status: 'accepted', correlationId: 'send-1' };
      if (channel === DESKTOP_IPC.listConversation) return { items: [], nextCursor: null };
      if (channel === DESKTOP_IPC.getRuntimeInfo) return {
        status: 'not_started', adapter: 'app_server', sdkVersion: '0.144.5', codexVersion: '0.144.5',
        runtimeVersion: '0.144.5-win32-x64', targetTriple: 'x86_64-pc-windows-msvc',
        platformFamily: null, platformOs: null, userAgent: null, integrity: 'verified'
      };
      if (channel === DESKTOP_IPC.respondRuntimeApproval) return { status: 'accepted', correlationId: 'approval-1' };
      if (channel === DESKTOP_IPC.listAttentionHistory) return [];
      if (channel === DESKTOP_IPC.openCodexDraft) return { status: 'accepted', correlationId: 'draft-1' };
      if (channel === DESKTOP_IPC.selectImageAttachments) return [];
      if (channel === DESKTOP_IPC.rendererReady) return { accepted: true };
      return input;
    });
    const listeners = new Set<(payload: unknown) => void>();
    const subscribe = vi.fn((_channel: string, listener: (payload: unknown) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    });
    const api = createDesktopHostApi(invoke, subscribe);

    await expect(api.getHostInfo()).resolves.toEqual({ platform: 'win32', coreStatus: 'ready' });
    await expect(api.pingCore('ping-1')).resolves.toEqual({ correlationId: 'ping-1' });
    await expect(api.getRepositorySnapshot()).resolves.toBe(snapshot);
    await expect(api.listRepositories()).resolves.toEqual([]);
    await expect(api.switchRepository('repo-1')).resolves.toMatchObject({ status: 'accepted' });
    await expect(api.openRepository()).resolves.toMatchObject({ status: 'accepted' });
    await expect(api.selectImageAttachments()).resolves.toEqual([]);
    await expect(api.sendMessage({ targetAgentId: 'orchestrator', text: 'Continue.', attachmentIds: [], selectedContextIds: [] })).resolves.toMatchObject({ status: 'accepted' });
    await expect(api.listConversation({ targetAgentId: 'orchestrator', limit: 20 })).resolves.toEqual({ items: [], nextCursor: null });
    await expect(api.getRuntimeInfo({ probe: false })).resolves.toMatchObject({ status: 'not_started', integrity: 'verified' });
    await expect(api.respondRuntimeApproval({ id: 'runtime-approval-1', decision: 'decline' })).resolves.toMatchObject({ status: 'accepted' });
    await expect(api.listAttentionHistory()).resolves.toEqual([]);
    await expect(api.openCodexDraft({ targetAgentId: 'orchestrator', text: 'Keep as draft.' })).resolves.toMatchObject({ status: 'accepted' });
    await expect(api.notifyRendererReady()).resolves.toBeUndefined();
    const listener = vi.fn();
    const unsubscribe = api.subscribeRepository(listener);
    for (const notify of listeners) notify(snapshot);
    expect(listener).toHaveBeenCalledWith(snapshot);
    unsubscribe();
    expect(invoke.mock.calls).toEqual([
      [DESKTOP_IPC.getHostInfo],
      [DESKTOP_IPC.pingCore, { correlationId: 'ping-1' }],
      [DESKTOP_IPC.getRepositorySnapshot],
      [DESKTOP_IPC.listRepositories],
      [DESKTOP_IPC.switchRepository, { projectId: 'repo-1' }],
      [DESKTOP_IPC.openRepository],
      [DESKTOP_IPC.selectImageAttachments],
      [DESKTOP_IPC.sendMessage, { targetAgentId: 'orchestrator', text: 'Continue.', attachmentIds: [], selectedContextIds: [] }],
      [DESKTOP_IPC.listConversation, { targetAgentId: 'orchestrator', limit: 20 }],
      [DESKTOP_IPC.getRuntimeInfo, { probe: false }],
      [DESKTOP_IPC.respondRuntimeApproval, { id: 'runtime-approval-1', decision: 'decline' }],
      [DESKTOP_IPC.listAttentionHistory],
      [DESKTOP_IPC.openCodexDraft, { targetAgentId: 'orchestrator', text: 'Keep as draft.' }],
      [DESKTOP_IPC.rendererReady]
    ]);
    expect(api).not.toHaveProperty('invoke');
    expect(api).not.toHaveProperty('send');
  });

  test('rejects an empty correlation id before IPC', async () => {
    const invoke = vi.fn();
    const api = createDesktopHostApi(invoke, vi.fn());

    await expect(api.pingCore('')).rejects.toThrow('correlationId');
    expect(invoke).not.toHaveBeenCalled();
  });

  test('rejects malformed runtime metadata before it reaches the renderer', async () => {
    const invoke = vi.fn(async () => ({ status: 'ready', adapter: 'app_server', executablePath: 'C:\\secret\\codex.exe' }));
    const api = createDesktopHostApi(invoke, vi.fn());
    await expect(api.getRuntimeInfo({ probe: true })).rejects.toThrow('runtime information');
  });

  test('rejects repository snapshots that omit or corrupt the bounded V4 projection', async () => {
    const missing = { project: { id: 'repo-1', title: 'Repo' }, agents: [], tasks: [], attention: [], phases: [], recentEvents: [] };
    const missingApi = createDesktopHostApi(vi.fn(async () => missing), vi.fn());
    await expect(missingApi.getRepositorySnapshot()).rejects.toThrow('repository snapshot');

    const malformed = { ...missing, v4Operations: { ...emptyV4OperationsSnapshot(), auditTimeline: {} } };
    const malformedApi = createDesktopHostApi(vi.fn(async () => malformed), vi.fn());
    await expect(malformedApi.getRepositorySnapshot()).rejects.toThrow('repository snapshot');
  });
});
