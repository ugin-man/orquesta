import { describe, expect, test, vi } from 'vitest';
import { MockOrquestaBridge } from '../../src/bridges/mock-bridge';

describe('MockOrquestaBridge', () => {
  test('reports prototype runtime metadata without claiming a live runtime', async () => {
    const bridge = new MockOrquestaBridge('active-project');
    await expect(bridge.getRuntimeInfo({ probe: false })).resolves.toMatchObject({ status: 'unavailable', integrity: 'unverified' });
  });

  test('accepts a prototype message without claiming completion', async () => {
    const bridge = new MockOrquestaBridge('active-project');
    const result = await bridge.sendMessage({ targetAgentId: 'orchestrator', text: 'Keep the bridge clean.', attachmentIds: [], selectedContextIds: [] });
    expect(result.status).toBe('accepted');
    const page = await bridge.listConversation({ targetAgentId: 'orchestrator' });
    expect(page.items[page.items.length - 1]).toMatchObject({ role: 'user', text: 'Keep the bridge clean.', evidenceLabel: 'Prototype message · no real turn started' });
  });

  test('rejects sending while the project is offline', async () => {
    const bridge = new MockOrquestaBridge('offline-project');
    const result = await bridge.sendMessage({ targetAgentId: 'orchestrator', text: 'Run now.', attachmentIds: [], selectedContextIds: [] });
    expect(result).toMatchObject({ status: 'unavailable', retryable: true });
  });

  test('emits a new snapshot when switching projects', async () => {
    const bridge = new MockOrquestaBridge('active-project');
    const listener = vi.fn();
    bridge.subscribe(listener);
    const result = await bridge.switchProject('unknown-evidence');
    expect(result.status).toBe('accepted');
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ type: 'snapshot_changed', snapshot: expect.objectContaining({ project: expect.objectContaining({ id: 'unknown-evidence' }) }) }));
  });

  test('resolving attention removes it from the current list', async () => {
    const bridge = new MockOrquestaBridge('active-project');
    await bridge.resolveAttentionItem({ id: 'A67', resolution: 'Resolved in test' });
    const snapshot = await bridge.getInitialSnapshot();
    expect(snapshot.attention.some((item) => item.id === 'A67')).toBe(false);
  });
});
