import { describe, expect, test, vi } from 'vitest';
import { DESKTOP_IPC } from '../shared/host-contract';
import { createDesktopHostApi } from './host-api';

describe('createDesktopHostApi', () => {
  test('exposes bounded methods instead of raw IPC', async () => {
    const snapshot = { project: { id: 'repo-1', title: 'Repo' }, agents: [], tasks: [], attention: [], phases: [], recentEvents: [] };
    const invoke = vi.fn(async (channel: string, input?: unknown) => {
      if (channel === DESKTOP_IPC.getHostInfo) return { platform: 'win32', coreStatus: 'ready' };
      if (channel === DESKTOP_IPC.getRepositorySnapshot) return snapshot;
      if (channel === DESKTOP_IPC.listRepositories) return [];
      if (channel === DESKTOP_IPC.switchRepository || channel === DESKTOP_IPC.openRepository) return { status: 'accepted', correlationId: 'action-1' };
      if (channel === DESKTOP_IPC.sendMessage) return { status: 'accepted', correlationId: 'send-1' };
      if (channel === DESKTOP_IPC.listConversation) return { items: [], nextCursor: null };
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
    await expect(api.sendMessage({ targetAgentId: 'orchestrator', text: 'Continue.', attachmentIds: [], selectedContextIds: [] })).resolves.toMatchObject({ status: 'accepted' });
    await expect(api.listConversation({ targetAgentId: 'orchestrator', limit: 20 })).resolves.toEqual({ items: [], nextCursor: null });
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
      [DESKTOP_IPC.sendMessage, { targetAgentId: 'orchestrator', text: 'Continue.', attachmentIds: [], selectedContextIds: [] }],
      [DESKTOP_IPC.listConversation, { targetAgentId: 'orchestrator', limit: 20 }]
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
});
