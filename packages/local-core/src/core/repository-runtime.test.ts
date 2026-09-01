import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { OrquestaUiSnapshot } from '../contracts/orquesta-ui';
import { RepositoryRuntime } from './repository-runtime';

const temporaryRepositories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(temporaryRepositories.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

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
  test('projects an uninitialized root without invoking the repository reader or watcher', async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'orquesta-desktop-uninitialized-'));
    temporaryRepositories.push(projectRoot);
    const readSnapshot = vi.fn();
    const watchDirectory = vi.fn();
    const runtime = new RepositoryRuntime({ readSnapshot, watchDirectory });

    const selected = runtime.selectUninitialized({ projectId: 'native-project', rootPath: projectRoot });

    expect(selected).toMatchObject({
      project: { id: 'native-project', rootPathLabel: projectRoot, repositoryDisplayState: 'snapshot' },
      agents: [], tasks: [],
    });
    expect(readSnapshot).not.toHaveBeenCalled();
    expect(watchDirectory).not.toHaveBeenCalled();
    await expect(readFile(path.join(projectRoot, '.orquesta', 'state', 'desktop-writer.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('does not run legacy migration during ordinary repository selection', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'orquesta-desktop-read-only-'));
    temporaryRepositories.push(root);
    const runtime = new RepositoryRuntime({
      readSnapshot: vi.fn(async () => snapshot('repo-read-only', root)),
      watchDirectory: vi.fn(() => ({ close: vi.fn() }))
    });

    await runtime.select({ projectId: 'repo-read-only', rootPath: root });

    await expect(readFile(path.join(root, '.orquesta', 'state', 'organization.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
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

    expect(close).toHaveBeenCalledTimes(1);
    expect(runtime.getSnapshot().project).toMatchObject({
      id: 'repo-second',
      repositoryDisplayState: 'watching',
      connectionLabel: 'Live repository'
    });
  });

  test('recursively watches the canonical root and closes the watcher on switch and shutdown', async () => {
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
    expect(watchDirectory).toHaveBeenCalledWith(
      path.join('C:\\first', '.orquesta'),
      expect.any(Function),
      expect.any(Function),
      { recursive: true }
    );

    await runtime.select({ projectId: 'repo-second', rootPath: 'C:\\second' });
    expect(close).toHaveBeenCalledTimes(1);
    await runtime.stop();
    expect(close).toHaveBeenCalledTimes(2);
  });

  test('keeps every watcher refresh projection-only', async () => {
    vi.useFakeTimers();
    const first = snapshot('repo-first', 'C:\\first');
    const readSnapshot = vi.fn(async () => first);
    let onChange = (_changedPath?: string) => undefined;
    const runtime = new RepositoryRuntime({
      readSnapshot,
      watchDirectory: vi.fn((_directory, callback) => { onChange = callback; return { close: vi.fn() }; }),
      debounceMs: 10
    });
    await runtime.select({ projectId: 'repo-first', rootPath: 'C:\\first' });

    onChange('state\\tasks.json');
    await vi.advanceTimersByTimeAsync(10);
    expect(readSnapshot).toHaveBeenCalledTimes(2);

    onChange('state\\organization.json');
    await vi.advanceTimersByTimeAsync(10);
    expect(readSnapshot).toHaveBeenCalledTimes(3);
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
