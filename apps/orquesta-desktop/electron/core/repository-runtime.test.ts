import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { OrquestaUiSnapshot } from '../../src/contracts/orquesta-ui';
import { RepositoryRuntime } from './repository-runtime';

afterEach(() => vi.useRealTimers());

function snapshot(id: string, rootPath: string): OrquestaUiSnapshot {
  return {
    project: {
      id,
      title: path.win32.basename(rootPath),
      rootPathLabel: rootPath,
      status: 'ready',
      connectionLabel: 'Live repository',
      isDemoData: false,
      lastSyncedAt: '2026-07-18T00:00:00.000Z',
      currentPhaseId: null,
      agentCount: 1,
      provenWorkingAgentCount: 0,
      summary: 'Ready',
      nextMilestone: null
    },
    agents: [{
      id: 'orchestrator',
      displayName: 'Coordinator',
      role: 'orchestrator',
      roleSummary: 'Coordinates work.',
      iconKey: 'network',
      status: 'standby',
      statusLabel: 'Idle',
      statusEvidence: 'proven',
      currentTaskId: null,
      currentTaskTitle: null,
      assignedByAgentId: null,
      blockedReason: null,
      waitingOn: null,
      contextScope: null,
      requiredReadingCount: 0,
      expectedArtifact: null,
      lastEvidenceAt: null,
      lastHeartbeatAt: null,
      recentEvidence: [],
      history: [],
      forbiddenActions: []
    }],
    tasks: [],
    attention: [],
    phases: [],
    recentEvents: []
  };
}

describe('RepositoryRuntime', () => {
  test('watches all projection directories and closes every watcher on switch and shutdown', async () => {
    const first = snapshot('repo-first', 'C:\\first');
    const second = snapshot('repo-second', 'C:\\second');
    const readSnapshot = vi.fn(async (rootPath: string) => rootPath === 'C:\\first' ? first : second);
    const close = vi.fn();
    const watchDirectory = vi.fn((_directory: string, _onChange: () => void) => ({ close }));
    const runtime = new RepositoryRuntime({ readSnapshot, watchDirectory, debounceMs: 1 });

    await expect(runtime.select({ projectId: 'repo-first', rootPath: 'C:\\first' })).resolves.toEqual(first);
    expect(watchDirectory.mock.calls.map(([directory]) => directory)).toEqual([
      path.join('C:\\first', '.orquesta', 'state'),
      path.join('C:\\first', '.orquesta', 'vision'),
      path.join('C:\\first', '.orquesta', 'failures'),
      path.join('C:\\first', '.orquesta', 'v4')
    ]);

    await runtime.select({ projectId: 'repo-second', rootPath: 'C:\\second' });
    expect(close).toHaveBeenCalledTimes(4);
    await runtime.stop();
    expect(close).toHaveBeenCalledTimes(8);
  });

  test('debounces changes and retains the last snapshot as offline when a read fails', async () => {
    vi.useFakeTimers();
    const first = snapshot('repo-first', 'C:\\first');
    const readSnapshot = vi.fn().mockResolvedValueOnce(first).mockRejectedValueOnce(new Error('broken state'));
    let onChange = () => undefined;
    const runtime = new RepositoryRuntime({
      readSnapshot,
      watchDirectory: vi.fn((_directory, callback) => {
        onChange = callback;
        return { close: vi.fn() };
      }),
      debounceMs: 10
    });
    const listener = vi.fn();
    runtime.subscribe(listener);
    await runtime.select({ projectId: 'repo-first', rootPath: 'C:\\first' });

    onChange();
    onChange();
    await vi.advanceTimersByTimeAsync(10);

    expect(readSnapshot).toHaveBeenCalledTimes(2);
    expect(runtime.getSnapshot()).toMatchObject({
      project: { id: 'repo-first', title: 'first', status: 'offline' },
      agents: [{ id: 'orchestrator' }]
    });
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({
      project: expect.objectContaining({ status: 'offline' })
    }));
  });
});
