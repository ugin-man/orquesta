import { describe, expect, test, vi } from 'vitest';
import { emptyV4OperationsSnapshot } from '../../src/contracts/orquesta-ui';
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
      sendMessage: vi.fn(async () => ({
        correlationId: 'send-1', threadId: 'thread-1', turnId: 'turn-1',
        modelEvidence: { recommendedModel: null, requestedModel: null, appliedModel: null, actualModel: null, actualModelEvidence: 'unknown' as const }
      })),
      listConversation: vi.fn(async () => ({ items: [], nextCursor: null })),
      getRuntimeInfo: vi.fn(async () => ({
        status: 'not_started' as const, adapter: 'app_server' as const, sdkVersion: '0.144.5', codexVersion: '0.144.5',
        runtimeVersion: '0.144.5-win32-x64', targetTriple: 'x86_64-pc-windows-msvc',
        platformFamily: null, platformOs: null, userAgent: null, integrity: 'verified' as const
      })),
      respondRuntimeApproval: vi.fn(async () => ({ correlationId: 'approval-1' })),
      listAttentionHistory: vi.fn(async () => []),
      startInspection: vi.fn(async () => ({ correlationId: 'inspection-1', runId: 'BENCH-001' })),
      cancelInspection: vi.fn(async () => ({ correlationId: 'inspection-2', runId: 'BENCH-001' })),
      readInspectionReport: vi.fn(async () => ({ runId: 'BENCH-001', markdown: '# Benchmark' }))
    };
    const snapshot = {
      project: { id: 'repo-1' }, agents: [], tasks: [], attention: [], phases: [], recentEvents: [],
      v4Operations: emptyV4OperationsSnapshot()
    };
    const repositories = {
      getSnapshot: vi.fn(async () => snapshot),
      listProjects: vi.fn(async () => [{ id: 'repo-1' }]),
      switchProject: vi.fn(async () => ({ status: 'accepted', correlationId: 'switch-1' })),
      openProject: vi.fn(async () => ({ status: 'accepted', correlationId: 'open-1' })),
      getCurrentRuntimeContext: vi.fn(() => ({ projectId: 'repo-1', rootPath: 'C:\\repo', threadId: 'thread-1' })),
      setCoordinatorThread: vi.fn(async () => undefined)
    };
    const attachments = { chooseImages: vi.fn(async () => []), resolveImagePaths: vi.fn(() => []) };
    const external = { openExternal: vi.fn(async () => undefined) };

    registerDesktopIpc(ipcMain, coreHost, repositories, attachments, external);

    expect([...handlers.keys()]).toEqual([
      DESKTOP_IPC.getHostInfo,
      DESKTOP_IPC.pingCore,
      DESKTOP_IPC.getRepositorySnapshot,
      DESKTOP_IPC.listRepositories,
      DESKTOP_IPC.switchRepository,
      DESKTOP_IPC.openRepository,
      DESKTOP_IPC.selectImageAttachments,
      DESKTOP_IPC.sendMessage,
      DESKTOP_IPC.listConversation,
      DESKTOP_IPC.getRuntimeInfo,
      DESKTOP_IPC.respondRuntimeApproval,
      DESKTOP_IPC.listAttentionHistory,
      DESKTOP_IPC.startInspection,
      DESKTOP_IPC.cancelInspection,
      DESKTOP_IPC.readInspectionReport,
      DESKTOP_IPC.openCodexDraft
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
    await expect(handlers.get(DESKTOP_IPC.getRuntimeInfo)?.({}, { probe: false })).resolves.toMatchObject({ status: 'not_started', integrity: 'verified' });
    expect(coreHost.getRuntimeInfo).toHaveBeenCalledWith({ probe: false });
    await expect(handlers.get(DESKTOP_IPC.respondRuntimeApproval)?.({}, {
      id: 'runtime-approval-1', decision: 'decline'
    })).resolves.toMatchObject({ status: 'accepted', correlationId: 'approval-1' });
    expect(coreHost.respondRuntimeApproval).toHaveBeenCalledWith({ attentionId: 'runtime-approval-1', decision: 'decline' });
    await expect(handlers.get(DESKTOP_IPC.listAttentionHistory)?.({})).resolves.toEqual([]);
    await expect(handlers.get(DESKTOP_IPC.startInspection)?.({}, {
      kind: 'external_benchmark', target: { kind: 'project', ids: [] }, focus: 'cost'
    })).resolves.toMatchObject({ status: 'accepted', correlationId: 'inspection-1' });
    expect(coreHost.startInspection).toHaveBeenCalledWith({
      projectId: 'repo-1', rootPath: 'C:\\repo', kind: 'external_benchmark',
      target: { kind: 'project', ids: [] }, focus: 'cost'
    });
    await expect(handlers.get(DESKTOP_IPC.cancelInspection)?.({}, { runId: 'BENCH-001' }))
      .resolves.toMatchObject({ status: 'accepted', correlationId: 'inspection-2' });
    await expect(handlers.get(DESKTOP_IPC.readInspectionReport)?.({}, { runId: 'BENCH-001' }))
      .resolves.toEqual({ runId: 'BENCH-001', markdown: '# Benchmark' });
    await expect(handlers.get(DESKTOP_IPC.openCodexDraft)?.({}, {
      targetAgentId: 'worker', text: '日本語の下書き', url: 'https://evil.example', rootPath: 'C:\\evil'
    })).resolves.toMatchObject({ status: 'accepted' });
    const opened = new URL(external.openExternal.mock.calls[0][0]);
    expect(`${opened.protocol}//${opened.host}${opened.pathname}`).toBe('codex://threads/new');
    expect(opened.searchParams.get('path')).toBe('C:\\repo');
    expect(opened.searchParams.get('prompt')).toContain('日本語の下書き');
    expect(opened.searchParams.get('prompt')).toContain('agent_id="worker"');
    expect(opened.toString()).not.toContain('evil.example');
  });

  test('rejects malformed ping input without reaching Core', async () => {
    const handlers = new Map<string, (event: unknown, input?: unknown) => unknown>();
    const ipcMain = {
      handle(channel: string, handler: (event: unknown, input?: unknown) => unknown) {
        handlers.set(channel, handler);
      }
    };
    const coreHost = {
      status: () => 'ready' as const,
      ping: vi.fn(), sendMessage: vi.fn(), listConversation: vi.fn(), getRuntimeInfo: vi.fn(),
      respondRuntimeApproval: vi.fn(), listAttentionHistory: vi.fn(), startInspection: vi.fn(),
      cancelInspection: vi.fn(), readInspectionReport: vi.fn()
    };
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
    await expect(handlers.get(DESKTOP_IPC.getRuntimeInfo)?.({}, { probe: 'yes' })).rejects.toThrow('probe');
    expect(coreHost.getRuntimeInfo).not.toHaveBeenCalled();
    await expect(handlers.get(DESKTOP_IPC.respondRuntimeApproval)?.({}, {
      id: 'runtime-approval-1', decision: ''
    })).rejects.toThrow('decision');
    expect(coreHost.respondRuntimeApproval).not.toHaveBeenCalled();
    await expect(handlers.get(DESKTOP_IPC.startInspection)?.({}, {
      kind: 'adversarial_audit', target: { kind: 'agents', ids: ['../bad'] }, focus: null
    })).rejects.toThrow('target');
    expect(coreHost.startInspection).not.toHaveBeenCalled();
    await expect(handlers.get(DESKTOP_IPC.openCodexDraft)?.({}, {
      targetAgentId: 'orchestrator', text: ''
    })).rejects.toThrow('text');
  });
});
