import { describe, expect, test, vi } from 'vitest';
import { DESKTOP_IPC } from '../shared/host-contract';
import { registerDesktopIpc } from './ipc-handlers';

describe('registerDesktopIpc', () => {
  test('registers only the bounded desktop channels', async () => {
    const handlers = new Map<string, (event: unknown, input?: unknown) => unknown>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (event: unknown, input?: unknown) => unknown) => {
        handlers.set(channel, handler);
      })
    };
    const coreHost = {
      status: vi.fn(() => 'ready' as const),
      ping: vi.fn(async (correlationId: string) => ({ correlationId })),
      sendMessage: vi.fn(async () => ({ correlationId: 'send-1', threadId: 'thread-1', turnId: 'turn-1', actualModel: 'gpt-current' })),
      listConversation: vi.fn(async () => ({ items: [], nextCursor: null }))
    };
    const snapshot = { project: { id: 'repo-1' }, agents: [], tasks: [], attention: [], phases: [], recentEvents: [] };
    const repositories = {
      getSnapshot: vi.fn(async () => snapshot),
      listProjects: vi.fn(async () => [{ id: 'repo-1' }]),
      switchProject: vi.fn(async () => ({ status: 'accepted', correlationId: 'switch-1' })),
      openProject: vi.fn(async () => ({ status: 'accepted', correlationId: 'open-1' })),
      getCurrentRuntimeContext: vi.fn(() => ({ projectId: 'repo-1', rootPath: 'C:\\repo', threadId: 'thread-1' })),
      setCoordinatorThread: vi.fn(async () => undefined)
    };
    const attachments = { chooseImages: vi.fn(async () => []), resolveImagePaths: vi.fn(() => []) };

    registerDesktopIpc(ipcMain, coreHost, repositories, attachments);

    expect([...handlers.keys()]).toEqual([
      DESKTOP_IPC.getHostInfo,
      DESKTOP_IPC.pingCore,
      DESKTOP_IPC.getRepositorySnapshot,
      DESKTOP_IPC.listRepositories,
      DESKTOP_IPC.switchRepository,
      DESKTOP_IPC.openRepository,
      DESKTOP_IPC.selectImageAttachments,
      DESKTOP_IPC.sendMessage,
      DESKTOP_IPC.listConversation
    ]);
    await expect(handlers.get(DESKTOP_IPC.getHostInfo)?.({})).resolves.toEqual({
      platform: 'win32',
      coreStatus: 'ready'
    });
    await expect(handlers.get(DESKTOP_IPC.pingCore)?.({}, { correlationId: 'ping-1' })).resolves.toEqual({
      correlationId: 'ping-1'
    });
    await expect(handlers.get(DESKTOP_IPC.getRepositorySnapshot)?.({})).resolves.toBe(snapshot);
    await expect(handlers.get(DESKTOP_IPC.listRepositories)?.({})).resolves.toEqual([{ id: 'repo-1' }]);
    await expect(handlers.get(DESKTOP_IPC.switchRepository)?.({}, { projectId: 'repo-1' })).resolves.toMatchObject({ status: 'accepted' });
    await expect(handlers.get(DESKTOP_IPC.openRepository)?.({})).resolves.toMatchObject({ status: 'accepted' });
    await expect(handlers.get(DESKTOP_IPC.sendMessage)?.({}, { targetAgentId: 'orchestrator', text: 'Continue.', attachmentIds: [], selectedContextIds: [] })).resolves.toMatchObject({ status: 'accepted', correlationId: 'send-1' });
    expect(coreHost.sendMessage).toHaveBeenCalledWith({ projectId: 'repo-1', rootPath: 'C:\\repo', threadId: 'thread-1', targetAgentId: 'orchestrator', text: 'Continue.', localImagePaths: [] });
    await expect(handlers.get(DESKTOP_IPC.listConversation)?.({}, { targetAgentId: 'orchestrator', limit: 20 })).resolves.toEqual({ items: [], nextCursor: null });
  });

  test('rejects malformed ping input without reaching Core', async () => {
    const handlers = new Map<string, (event: unknown, input?: unknown) => unknown>();
    const ipcMain = {
      handle(channel: string, handler: (event: unknown, input?: unknown) => unknown) {
        handlers.set(channel, handler);
      }
    };
    const coreHost = { status: () => 'ready' as const, ping: vi.fn(), sendMessage: vi.fn(), listConversation: vi.fn() };
    const repositories = {
      getSnapshot: vi.fn(), listProjects: vi.fn(), switchProject: vi.fn(), openProject: vi.fn(),
      getCurrentRuntimeContext: vi.fn(), setCoordinatorThread: vi.fn()
    };
    registerDesktopIpc(ipcMain, coreHost, repositories, { chooseImages: vi.fn(async () => []), resolveImagePaths: vi.fn(() => []) });

    await expect(handlers.get(DESKTOP_IPC.pingCore)?.({}, { correlationId: '' })).rejects.toThrow('correlationId');
    expect(coreHost.ping).not.toHaveBeenCalled();
    await expect(handlers.get(DESKTOP_IPC.switchRepository)?.({}, { projectId: '../escape' })).rejects.toThrow('projectId');
    expect(repositories.switchProject).not.toHaveBeenCalled();
    await expect(handlers.get(DESKTOP_IPC.sendMessage)?.({}, { targetAgentId: '../bad', text: 'x', attachmentIds: [], selectedContextIds: [] })).rejects.toThrow('targetAgentId');
    expect(coreHost.sendMessage).not.toHaveBeenCalled();
  });
});
