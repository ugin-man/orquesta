import { describe, expect, test, vi } from 'vitest';
import type { DesktopHostApi } from '../../electron/shared/host-contract';
import { DesktopRepositoryBridge } from '../../src/bridges/desktop-repository-bridge';
import { fixtureCatalog } from '../../src/fixtures';

describe('DesktopRepositoryBridge', () => {
  test('adapts repository reads and runtime messages through the bounded host API', async () => {
    const snapshot = fixtureCatalog['active-project'].snapshot;
    const subscription: { listener: ((next: typeof snapshot) => void) | null } = { listener: null };
    const runtimeSubscription: { listener: Parameters<DesktopHostApi['subscribeRuntime']>[0] | null } = { listener: null };
    const host = {
      getRepositorySnapshot: vi.fn(async () => snapshot),
      listRepositories: vi.fn(async () => []),
      switchRepository: vi.fn(async () => ({ status: 'accepted' as const, correlationId: 'switch-1' })),
      openRepository: vi.fn(async () => ({ status: 'accepted' as const, correlationId: 'open-1' })),
      selectImageAttachments: vi.fn(async () => []),
      subscribeRepository: vi.fn((listener: (next: typeof snapshot) => void) => { subscription.listener = listener; return () => { subscription.listener = null; }; }),
      sendMessage: vi.fn(async () => ({ status: 'accepted' as const, correlationId: 'send-1' })),
      listConversation: vi.fn(async () => ({ items: [], nextCursor: null })),
      getRuntimeInfo: vi.fn(async () => ({
        status: 'not_started' as const, adapter: 'app_server' as const, sdkVersion: '0.144.5', codexVersion: '0.144.5',
        runtimeVersion: '0.144.5-win32-x64', targetTriple: 'x86_64-pc-windows-msvc',
        platformFamily: null, platformOs: null, userAgent: null, integrity: 'verified' as const
      })),
      respondRuntimeApproval: vi.fn(async () => ({ status: 'accepted' as const, correlationId: 'approval-1' })),
      listAttentionHistory: vi.fn(async () => []),
      subscribeRuntime: vi.fn((listener) => { runtimeSubscription.listener = listener; return () => { runtimeSubscription.listener = null; }; }),
      getHostInfo: vi.fn(),
      pingCore: vi.fn()
    } satisfies DesktopHostApi;
    const bridge = new DesktopRepositoryBridge(host);

    await expect(bridge.getInitialSnapshot()).resolves.toBe(snapshot);
    const listener = vi.fn();
    const unsubscribe = bridge.subscribe(listener);
    subscription.listener?.(snapshot);
    expect(listener).toHaveBeenCalledWith({ type: 'snapshot_changed', snapshot });
    runtimeSubscription.listener?.({
      kind: 'model_observed', threadId: 'thread-1', turnId: 'turn-1',
      targetAgentId: 'orchestrator', text: null,
      modelEvidence: {
        recommendedModel: null, requestedModel: null, appliedModel: null,
        actualModel: 'gpt-5.6-codex', actualModelEvidence: 'proven'
      }
    });
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'toast', toast: expect.objectContaining({ title: 'Codex model observed' })
    }));
    unsubscribe();
    expect(runtimeSubscription.listener).toBeNull();
    await expect(bridge.switchProject('repo-1')).resolves.toMatchObject({ status: 'accepted' });
    await expect(bridge.requestOpenProject()).resolves.toMatchObject({ status: 'accepted' });
    await expect(bridge.sendMessage({ targetAgentId: 'orchestrator', text: 'hello', attachmentIds: [], selectedContextIds: [] })).resolves.toMatchObject({ status: 'accepted' });
    expect(bridge.capabilities.attentionResolution).toBe(true);
    await expect(bridge.resolveAttentionItem({ kind: 'runtime_approval', id: 'runtime-approval-1', decision: 'decline' })).resolves.toMatchObject({ status: 'accepted' });
    expect(host.respondRuntimeApproval).toHaveBeenCalledWith({ id: 'runtime-approval-1', decision: 'decline' });
    await expect(bridge.resolveAttentionItem({ kind: 'repository_action', id: 'A1', resolution: 'done' })).resolves.toMatchObject({ status: 'unsupported' });
    expect(host.respondRuntimeApproval).toHaveBeenCalledTimes(1);
    await expect(bridge.getRuntimeInfo({ probe: false })).resolves.toMatchObject({ status: 'not_started', integrity: 'verified' });
  });
});
