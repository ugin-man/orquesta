import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { OrquestaUiSnapshot } from '../../src/contracts/orquesta-ui';
import { emptyV4OperationsSnapshot } from '../../src/contracts/orquesta-ui';
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
      repositoryDisplayState: 'snapshot',
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
    recentEvents: [],
    v4Operations: emptyV4OperationsSnapshot()
  };
}

describe('RepositoryRuntime', () => {
  test('provisions pending setup specialists before projecting the selected repository', async () => {
    const first = snapshot('repo-first', 'C:\\first');
    const events: string[] = [];
    const runtime = new RepositoryRuntime({
      readSnapshot: vi.fn(async () => {
        events.push('snapshot');
        return first;
      }),
      readProvisioningBatch: vi.fn(async () => ({
        provisioning_batch_id: 'PB-0123456789ab',
        organization_revision: 2,
        max_concurrent_provisioning: 3,
        created_at: '2026-07-20T15:00:00.000Z',
        requests: [{
          agent_id: 'implementation-001', role_id: 'implementation', team_id: 'desktop-team', line_id: 'desktop-line',
          task_id: 'T001', status: 'pending', created_at: '2026-07-20T15:00:00.000Z'
        }]
      })),
      provisionSetupSpecialists: vi.fn(async () => {
        events.push('provision');
      }),
      watchDirectory: vi.fn(() => ({ close: vi.fn() }))
    });

    await runtime.select({ projectId: 'repo-first', rootPath: 'C:\\first' });

    expect(events).toEqual(['provision', 'snapshot']);
  });

  test('marks repository state watching only after a canonical watcher starts', async () => {
    const first = snapshot('repo-first', 'C:\\first');
    const runtime = new RepositoryRuntime({
      readSnapshot: vi.fn(async () => first),
      watchDirectory: vi.fn(() => ({ close: vi.fn() }))
    });

    const selected = await runtime.select({ projectId: 'repo-first', rootPath: 'C:\\first' });

    expect(selected.project.repositoryDisplayState).toBe('watching');
  });

  test('stops claiming a live watcher after the watcher reports an error', async () => {
    const first = snapshot('repo-first', 'C:\\first');
    let reportWatchError = (_error: Error) => undefined;
    const runtime = new RepositoryRuntime({
      readSnapshot: vi.fn(async () => first),
      watchDirectory: vi.fn((...args: unknown[]) => {
        reportWatchError = (args[2] as ((error: Error) => void) | undefined) ?? reportWatchError;
        return { close: vi.fn() };
      })
    });

    await runtime.select({ projectId: 'repo-first', rootPath: 'C:\\first' });
    reportWatchError(new Error('watcher failed'));

    expect(runtime.getSnapshot().project).toMatchObject({
      repositoryDisplayState: 'snapshot',
      connectionLabel: 'Watcher stopped · watcher failed'
    });
  });

  test('ignores a delayed watcher error from the previously selected project', async () => {
    const first = snapshot('repo-first', 'C:\\first');
    const second = snapshot('repo-second', 'C:\\second');
    const callbacks: Array<(error: Error) => void> = [];
    const close = vi.fn();
    const runtime = new RepositoryRuntime({
      readSnapshot: vi.fn(async (rootPath: string) => rootPath === 'C:\\first' ? first : second),
      watchDirectory: vi.fn((_directory, _onChange, onError) => {
        callbacks.push(onError);
        return { close };
      })
    });

    await runtime.select({ projectId: 'repo-first', rootPath: 'C:\\first' });
    await runtime.select({ projectId: 'repo-second', rootPath: 'C:\\second' });
    callbacks[0](new Error('late failure from first project'));

    expect(close).toHaveBeenCalledTimes(6);
    expect(runtime.getSnapshot().project).toMatchObject({
      id: 'repo-second',
      repositoryDisplayState: 'watching',
      connectionLabel: 'Live repository'
    });
  });

  test('merges canonical V4 operations on selection and refresh without changing the base snapshot', async () => {
    const first = snapshot('repo-first', 'C:\\first');
    const readSnapshot = vi.fn(async () => first);
    const readV4Operations = vi.fn(async () => ({
      ...emptyV4OperationsSnapshot(),
      available: true,
      revision: 12,
      limitation: null,
    }));
    const runtime = new RepositoryRuntime({
      readSnapshot,
      readV4Operations,
      watchDirectory: vi.fn(() => ({ close: vi.fn() })),
    });

    const selected = await runtime.select({ projectId: 'repo-first', rootPath: 'C:\\first' });
    expect(selected).toMatchObject({ project: { id: 'repo-first', status: 'ready' }, v4Operations: { available: true, revision: 12 } });
    await runtime.refresh();
    expect(readSnapshot).toHaveBeenCalledTimes(2);
    expect(readV4Operations).toHaveBeenCalledTimes(2);
    expect(readV4Operations).toHaveBeenLastCalledWith('C:\\first');
  });

  test('keeps valid repository state online when only the V4 journal is unavailable', async () => {
    const first = snapshot('repo-first', 'C:\\first');
    const runtime = new RepositoryRuntime({
      readSnapshot: vi.fn(async () => first),
      readV4Operations: vi.fn(async () => emptyV4OperationsSnapshot('V4 journal recovery required')),
      watchDirectory: vi.fn(() => ({ close: vi.fn() })),
    });

    const selected = await runtime.select({ projectId: 'repo-first', rootPath: 'C:\\first' });
    expect(selected).toMatchObject({
      project: { status: 'ready' },
      agents: [{ id: 'orchestrator', status: 'standby' }],
      v4Operations: { available: false, limitation: 'V4 journal recovery required' },
    });
  });

  test('watches all projection directories and closes every watcher on switch and shutdown', async () => {
    const first = snapshot('repo-first', 'C:\\first');
    const second = snapshot('repo-second', 'C:\\second');
    const readSnapshot = vi.fn(async (rootPath: string) => rootPath === 'C:\\first' ? first : second);
    const close = vi.fn();
    const watchDirectory = vi.fn((_directory: string, _onChange: () => void) => ({ close }));
    const runtime = new RepositoryRuntime({ readSnapshot, watchDirectory, debounceMs: 1 });

    await expect(runtime.select({ projectId: 'repo-first', rootPath: 'C:\\first' })).resolves.toMatchObject({
      project: { id: 'repo-first', repositoryDisplayState: 'watching' }
    });
    expect(first.project.repositoryDisplayState).toBe('snapshot');
    expect(watchDirectory.mock.calls.map(([directory]) => directory)).toEqual([
      path.join('C:\\first', '.orquesta', 'state'),
      path.join('C:\\first', '.orquesta', 'vision'),
      path.join('C:\\first', '.orquesta', 'user_tasks'),
      path.join('C:\\first', '.orquesta', 'failures'),
      path.join('C:\\first', '.orquesta', 'v4'),
      path.join('C:\\first', '.orquesta', 'setup')
    ]);

    await runtime.select({ projectId: 'repo-second', rootPath: 'C:\\second' });
    expect(close).toHaveBeenCalledTimes(6);
    await runtime.stop();
    expect(close).toHaveBeenCalledTimes(12);
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

  test('projects live runtime approvals without writing canonical state and keeps local resolved history', async () => {
    const first = snapshot('repo-first', 'C:\\first');
    const runtime = new RepositoryRuntime({
      readSnapshot: vi.fn(async () => first),
      watchDirectory: vi.fn(() => ({ close: vi.fn() }))
    });
    await runtime.select({ projectId: 'repo-first', rootPath: 'C:\\first' });
    runtime.addRuntimeApproval({
      projectId: 'repo-first', correlationId: 'corr-approval', requestId: 'approval-1', method: 'item/fileChange/requestApproval',
      threadId: 'thread-1', turnId: 'turn-1', reason: '[redacted approval reason]',
      responseOptions: ['accept', 'decline', 'cancel']
    });

    const item = runtime.getSnapshot().attention[0];
    expect(item).toMatchObject({
      id: 'runtime-approval-approval-1', type: 'approval', blocking: true, priority: 'blocker',
      runtimeApproval: { requestId: 'approval-1', responseOptions: ['accept', 'decline', 'cancel'] }
    });
    expect(runtime.runtimeApproval(item.id)).toMatchObject({ requestId: 'approval-1' });

    runtime.resolveRuntimeApproval(item.id, 'decline');
    expect(runtime.getSnapshot().attention).toEqual([]);
    expect(runtime.listAttentionHistory()).toEqual([
      expect.objectContaining({ id: item.id, resolvedAt: expect.any(String), resolutionLabel: 'decline' })
    ]);
  });
});
