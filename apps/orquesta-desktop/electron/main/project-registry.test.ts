import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { emptyV4OperationsSnapshot, type OrquestaUiSnapshot } from '../../src/contracts/orquesta-ui';
import { ProjectRegistry } from './project-registry';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function snapshot(id: string, title: string, rootPath: string): OrquestaUiSnapshot {
  return {
    project: {
      id,
      title,
      rootPathLabel: rootPath,
      status: 'ready',
      connectionLabel: 'Live repository',
      isDemoData: false,
      repositoryDisplayState: 'snapshot',
      lastSyncedAt: null,
      currentPhaseId: null,
      agentCount: 0,
      provenWorkingAgentCount: 0,
      summary: 'Ready',
      nextMilestone: null
    },
    agents: [],
    tasks: [],
    attention: [],
    phases: [],
    recentEvents: [],
    v4Operations: emptyV4OperationsSnapshot()
  };
}

describe('ProjectRegistry', () => {
  test('owns recent-project persistence, folder choice, and coordinator thread ids', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'orquesta-project-registry-'));
    temporaryRoots.push(root);
    const registryPath = path.join(root, 'repositories.json');
    const chooseDirectory = vi.fn(async () => 'C:\\project');
    const registry = new ProjectRegistry({
      registryPath,
      chooseDirectory,
      now: () => new Date('2026-07-18T00:00:00.000Z')
    });

    await registry.initialize();
    await expect(registry.chooseRoot()).resolves.toBe('C:\\project');
    await registry.remember(snapshot('repo-1', 'Project', 'C:\\project'));
    await registry.setCoordinatorThread('repo-1', 'thread-1');

    expect(registry.getCurrentRuntimeContext()).toEqual({
      projectId: 'repo-1', rootPath: 'C:\\project', threadId: 'thread-1'
    });
    expect(await registry.listProjects()).toEqual([
      expect.objectContaining({ id: 'repo-1', title: 'Project' })
    ]);
    const stored = JSON.parse(await readFile(registryPath, 'utf8')) as {
      projects: Array<{ coordinatorThreadId: string | null }>;
    };
    expect(stored.projects[0].coordinatorThreadId).toBe('thread-1');
  });

  test('migrates a version 1 registry without losing the coordinator thread', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'orquesta-project-registry-v1-'));
    temporaryRoots.push(root);
    const registryPath = path.join(root, 'repositories.json');
    await writeFile(registryPath, JSON.stringify({
      version: 1,
      currentProjectId: 'repo-1',
      projects: [{
        id: 'repo-1', title: 'One', rootPath: 'C:\\project', rootPathLabel: 'C:\\project',
        status: 'ready', connectionLabel: 'Watching', lastOpenedAt: '2026-07-18T00:00:00.000Z',
        coordinatorThreadId: 'thread-coordinator'
      }]
    }), 'utf8');

    const registry = new ProjectRegistry({ registryPath });
    await registry.initialize();

    expect(registry.getCurrentRuntimeContext()).toMatchObject({ threadId: 'thread-coordinator' });
    expect(registry.getLucaRuntimeContext()).toMatchObject({ threadId: null });
    expect(registry.getLastLucaHomeSeenAt('repo-1')).toBeNull();
  });

  test('persists Luca thread and Home baseline independently from coordinator state', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'orquesta-project-registry-luca-'));
    temporaryRoots.push(root);
    const registryPath = path.join(root, 'repositories.json');
    const registry = new ProjectRegistry({ registryPath });
    await registry.initialize();
    await registry.remember(snapshot('repo-1', 'Project', 'C:\\project'));
    await registry.setCoordinatorThread('repo-1', 'thread-coordinator');
    await registry.setLucaThread('repo-1', 'thread-luca');
    await registry.markLucaHomeSeen('repo-1', '2026-07-22T00:00:00.000Z');

    expect(registry.getCurrentRuntimeContext()).toMatchObject({ threadId: 'thread-coordinator' });
    expect(registry.getLucaRuntimeContext()).toMatchObject({ threadId: 'thread-luca' });
    expect(registry.getLastLucaHomeSeenAt('repo-1')).toBe('2026-07-22T00:00:00.000Z');
    const stored = JSON.parse(await readFile(registryPath, 'utf8')) as {
      version: number;
      projects: Array<{ lucaThreadId: string | null; lastLucaHomeSeenAt: string | null }>;
    };
    expect(stored.version).toBe(2);
    expect(stored.projects[0]).toMatchObject({
      lucaThreadId: 'thread-luca',
      lastLucaHomeSeenAt: '2026-07-22T00:00:00.000Z'
    });
  });
});

test('Electron Main production sources do not import repository projection or Orquesta state packages', async () => {
  const files = ['index.ts', 'ipc-handlers.ts', 'repository-service.ts', 'project-registry.ts'];
  const sources = await Promise.all(files.map(async (file) => readFile(path.join(import.meta.dirname, file), 'utf8')));
  for (const source of sources) {
    expect(source).not.toMatch(/(?:repository-reader|@orquesta\/core|@orquesta\/event-store)/u);
  }
});
