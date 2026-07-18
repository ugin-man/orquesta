import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { RepositoryService } from './repository-service';

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeProject(parent: string, name: string) {
  const root = path.join(parent, name);
  const state = path.join(root, '.orquesta', 'state');
  await mkdir(state, { recursive: true });
  await writeFile(path.join(state, 'agents.json'), JSON.stringify({ updated_at: '2026-07-18T11:00:00.000Z', agents: [{ agent_id: 'orchestrator', role: 'orchestrator', display_name: `${name} Lead`, status: 'standby' }] }), 'utf8');
  await writeFile(path.join(state, 'tasks.json'), JSON.stringify({ updated_at: '2026-07-18T11:00:00.000Z', tasks: [] }), 'utf8');
  return root;
}

describe('RepositoryService', () => {
  test('persists app-owned recent projects and switches without writing project state', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'orquesta-repositories-'));
    temporaryRoots.push(temporary);
    const first = await makeProject(temporary, 'first');
    const second = await makeProject(temporary, 'second');
    const firstAgentsBefore = await readFile(path.join(first, '.orquesta', 'state', 'agents.json'), 'utf8');
    const registryPath = path.join(temporary, 'user-data', 'repositories.json');
    const snapshots: string[] = [];
    const service = new RepositoryService({ registryPath, initialRootPath: first, now: () => new Date('2026-07-18T11:00:00.000Z') });
    service.subscribe((snapshot) => snapshots.push(snapshot.project.title));

    await service.initialize();
    expect((await service.getSnapshot()).project.title).toBe('first');
    await expect(service.selectRoot(second)).resolves.toMatchObject({ status: 'accepted' });
    const projects = await service.listProjects();
    expect(projects.map((project) => project.title).sort()).toEqual(['first', 'second']);
    await expect(service.switchProject(projects.find((project) => project.title === 'first')!.id)).resolves.toMatchObject({ status: 'accepted' });
    expect((await service.getSnapshot()).project.title).toBe('first');
    expect(snapshots).toContain('second');
    expect(await readFile(path.join(first, '.orquesta', 'state', 'agents.json'), 'utf8')).toBe(firstAgentsBefore);
    expect(JSON.parse(await readFile(registryPath, 'utf8')).projects).toHaveLength(2);
    await service.stop();
  });

  test('uses the folder chooser and rejects a cancelled selection', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'orquesta-picker-'));
    temporaryRoots.push(temporary);
    const project = await makeProject(temporary, 'picked');
    const chooseDirectory = vi.fn<() => Promise<string | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(project);
    const service = new RepositoryService({ registryPath: path.join(temporary, 'repositories.json'), chooseDirectory });
    await service.initialize();

    await expect(service.openProject()).resolves.toMatchObject({ status: 'rejected' });
    await expect(service.openProject()).resolves.toMatchObject({ status: 'accepted' });
    expect((await service.getSnapshot()).project.title).toBe('picked');
    await service.stop();
  });

  test('keeps the last snapshot offline when a refresh becomes unreadable', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'orquesta-refresh-'));
    temporaryRoots.push(temporary);
    const project = await makeProject(temporary, 'watched');
    const service = new RepositoryService({ registryPath: path.join(temporary, 'repositories.json'), initialRootPath: project });
    await service.initialize();
    await writeFile(path.join(project, '.orquesta', 'state', 'tasks.json'), '{broken', 'utf8');

    await service.refresh();

    expect((await service.getSnapshot()).project).toMatchObject({ title: 'watched', status: 'offline' });
    expect((await service.getSnapshot()).agents).toHaveLength(1);
    await service.stop();
  });
});
