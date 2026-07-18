import { describe, expect, test, vi } from 'vitest';
import type { DesktopHostApi } from '../../electron/shared/host-contract';
import { DesktopRepositoryBridge } from '../../src/bridges/desktop-repository-bridge';
import { fixtureCatalog } from '../../src/fixtures';

describe('DesktopRepositoryBridge', () => {
  test('adapts the bounded host repository API and keeps writes unavailable', async () => {
    const snapshot = fixtureCatalog['active-project'].snapshot;
    const subscription: { listener: ((next: typeof snapshot) => void) | null } = { listener: null };
    const host = {
      getRepositorySnapshot: vi.fn(async () => snapshot),
      listRepositories: vi.fn(async () => []),
      switchRepository: vi.fn(async () => ({ status: 'accepted' as const, correlationId: 'switch-1' })),
      openRepository: vi.fn(async () => ({ status: 'accepted' as const, correlationId: 'open-1' })),
      subscribeRepository: vi.fn((listener: (next: typeof snapshot) => void) => { subscription.listener = listener; return () => { subscription.listener = null; }; }),
      getHostInfo: vi.fn(),
      pingCore: vi.fn()
    } satisfies DesktopHostApi;
    const bridge = new DesktopRepositoryBridge(host);

    await expect(bridge.getInitialSnapshot()).resolves.toBe(snapshot);
    const listener = vi.fn();
    const unsubscribe = bridge.subscribe(listener);
    subscription.listener?.(snapshot);
    expect(listener).toHaveBeenCalledWith({ type: 'snapshot_changed', snapshot });
    unsubscribe();
    await expect(bridge.switchProject('repo-1')).resolves.toMatchObject({ status: 'accepted' });
    await expect(bridge.requestOpenProject()).resolves.toMatchObject({ status: 'accepted' });
    await expect(bridge.sendMessage({ targetAgentId: 'orchestrator', text: 'hello', attachmentIds: [], selectedContextIds: [] })).resolves.toMatchObject({ status: 'unavailable' });
    await expect(bridge.resolveAttentionItem({ id: 'A1', resolution: 'done' })).resolves.toMatchObject({ status: 'unsupported' });
  });
});
