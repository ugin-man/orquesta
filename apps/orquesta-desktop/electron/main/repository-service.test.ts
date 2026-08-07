import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { RepositoryRuntime } from '../core/repository-runtime';
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
  await writeFile(path.join(state, 'roles.json'), JSON.stringify({
    schema_version: 1,
    organization_revision: 1,
    roles: [{ role_id: 'orchestrator', display_names: { en: 'Orchestrator', ja: '統括者' } }]
  }), 'utf8');
  await writeFile(path.join(state, 'organization.json'), JSON.stringify({
    schema_version: 2,
    revision: 1,
    agents: [{ agent_id: 'orchestrator', role_id: 'orchestrator', organization_scope: 'project', lifecycle_state: 'active', operational_status: 'standby' }],
    teams: [],
    memberships: [],
    relationships: [],
    lines: []
  }), 'utf8');
  return root;
}

function createProjectionHost() {
  const runtime = new RepositoryRuntime();
  return {
    runtime,
    host: {
      selectRepository: (projectId: string, rootPath: string) => runtime.select({ projectId, rootPath }),
      getRepositorySnapshot: () => runtime.refresh(),
      subscribeRepository: (listener: Parameters<RepositoryRuntime['subscribe']>[0]) => runtime.subscribe(listener)
    }
  };
}

describe('RepositoryService', () => {
  test('turns an uninitialized folder into a read-only setup source instead of selecting it as a repository', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'orquesta-setup-source-'));
    temporaryRoots.push(temporary);
    const project = path.join(temporary, 'new-project');
    await mkdir(project, { recursive: true });
    const prepareSetupSource = vi.fn(async () => undefined);
    const coreHost = {
      selectRepository: vi.fn(),
      getRepositorySnapshot: vi.fn(),
      subscribeRepository: vi.fn(() => () => undefined)
    };
    const service = new RepositoryService({
      registryPath: path.join(temporary, 'user-data', 'repositories.json'),
      coreHost,
      chooseDirectory: async () => project,
      prepareSetupSource
    });

    await service.initialize();
    await expect(service.openProject()).resolves.toMatchObject({ status: 'accepted' });

    expect(prepareSetupSource).toHaveBeenCalledWith({ kind: 'existing_folder', rootPath: project });
    expect(coreHost.selectRepository).not.toHaveBeenCalled();
    await expect(readFile(path.join(project, '.orquesta', 'setup', 'setup_state.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('does not overwrite a partial Orquesta state as a new setup', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'orquesta-partial-state-'));
    temporaryRoots.push(temporary);
    const project = path.join(temporary, 'partial');
    const state = path.join(project, '.orquesta', 'state');
    await mkdir(state, { recursive: true });
    await writeFile(path.join(state, 'agents.json'), JSON.stringify({ agents: [] }), 'utf8');
    const prepareSetupSource = vi.fn(async () => undefined);
    const coreHost = {
      selectRepository: vi.fn(),
      getRepositorySnapshot: vi.fn(),
      subscribeRepository: vi.fn(() => () => undefined)
    };
    const service = new RepositoryService({
      registryPath: path.join(temporary, 'repositories.json'),
      coreHost,
      chooseDirectory: async () => project,
      prepareSetupSource
    });
    await service.initialize();

    await expect(service.openProject()).resolves.toMatchObject({
      status: 'rejected',
      reason: expect.stringContaining('incomplete')
    });
    expect(prepareSetupSource).not.toHaveBeenCalled();
    expect(coreHost.selectRepository).not.toHaveBeenCalled();
  });

  test('does not treat malformed setup state as a resumable project', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'orquesta-broken-setup-'));
    temporaryRoots.push(temporary);
    const project = path.join(temporary, 'broken');
    const setup = path.join(project, '.orquesta', 'setup');
    await mkdir(setup, { recursive: true });
    await writeFile(path.join(setup, 'setup_state.json'), '{broken', 'utf8');
    const coreHost = {
      selectRepository: vi.fn(),
      getRepositorySnapshot: vi.fn(),
      subscribeRepository: vi.fn(() => () => undefined)
    };
    const service = new RepositoryService({
      registryPath: path.join(temporary, 'repositories.json'),
      coreHost,
      chooseDirectory: async () => project,
      prepareSetupSource: vi.fn()
    });
    await service.initialize();

    await expect(service.openProject()).resolves.toMatchObject({
      status: 'rejected',
      reason: expect.stringContaining('unreadable')
    });
    expect(coreHost.selectRepository).not.toHaveBeenCalled();
  });

  test('persists app-owned recent projects and switches without writing project state', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'orquesta-repositories-'));
    temporaryRoots.push(temporary);
    const first = await makeProject(temporary, 'first');
    const second = await makeProject(temporary, 'second');
    const firstAgentsBefore = await readFile(path.join(first, '.orquesta', 'state', 'agents.json'), 'utf8');
    const registryPath = path.join(temporary, 'user-data', 'repositories.json');
    const snapshots: string[] = [];
    const projection = createProjectionHost();
    const service = new RepositoryService({
      registryPath, coreHost: projection.host, initialRootPath: first,
      now: () => new Date('2026-07-18T11:00:00.000Z')
    });
    service.subscribe((snapshot) => snapshots.push(snapshot.project.title));

    await service.initialize();
    expect((await service.getSnapshot()).project.title).toBe('first');
    const firstContext = service.getCurrentProjectContext()!;
    await service.markLucaHomeSeen(firstContext.projectId, '2026-07-18T11:05:00.000Z');
    expect(service.getCurrentProjectContext()).toMatchObject({ rootPath: first });
    expect(service.getLastLucaHomeSeenAt(firstContext.projectId)).toBe('2026-07-18T11:05:00.000Z');
    await expect(service.selectRoot(second)).resolves.toMatchObject({ status: 'accepted' });
    const projects = await service.listProjects();
    expect(projects.map((project) => project.title).sort()).toEqual(['first', 'second']);
    await expect(service.switchProject(projects.find((project) => project.title === 'first')!.id)).resolves.toMatchObject({ status: 'accepted' });
    expect((await service.getSnapshot()).project.title).toBe('first');
    expect(snapshots).toContain('second');
    expect(await readFile(path.join(first, '.orquesta', 'state', 'agents.json'), 'utf8')).toBe(firstAgentsBefore);
    const registry = JSON.parse(await readFile(registryPath, 'utf8')) as { projects: Array<Record<string, unknown> & { title: string }> };
    expect(registry.projects).toHaveLength(2);
    expect(registry.projects.find((project) => project.title === 'first')).not.toHaveProperty('coordinatorThreadId');
    expect(registry.projects.find((project) => project.title === 'first')).not.toHaveProperty('lucaThreadId');
    await service.stop();
    await projection.runtime.stop();
  });

  test('forwards the initial Codex launch context only for the explicitly opened project', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'orquesta-hosted-project-'));
    temporaryRoots.push(temporary);
    const project = await makeProject(temporary, 'hosted');
    const projection = createProjectionHost();
    const selectRepository = vi.spyOn(projection.host, 'selectRepository');
    const service = new RepositoryService({
      registryPath: path.join(temporary, 'repositories.json'),
      coreHost: projection.host,
      initialRootPath: project,
      initialLaunchContext: { source: 'argv', callingThreadId: 'thread-calling-chat' }
    });

    await service.initialize();

    expect(selectRepository).toHaveBeenCalledWith(
      expect.stringMatching(/^repo-/u),
      project,
      { source: 'argv', callingThreadId: 'thread-calling-chat' }
    );
    await service.stop();
    await projection.runtime.stop();
  });

  test('uses the folder chooser and rejects a cancelled selection', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'orquesta-picker-'));
    temporaryRoots.push(temporary);
    const project = await makeProject(temporary, 'picked');
    const chooseDirectory = vi.fn<() => Promise<string | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(project);
    const projection = createProjectionHost();
    const service = new RepositoryService({
      registryPath: path.join(temporary, 'repositories.json'), coreHost: projection.host, chooseDirectory
    });
    await service.initialize();
    await expect(service.getSnapshot()).resolves.toMatchObject({
      project: { id: 'no-project' },
      v4Operations: { available: false, revision: 0 },
      failures: [],
      inspectionTemplates: expect.any(Array),
      inspectionRuns: []
    });

    await expect(service.openProject()).resolves.toMatchObject({ status: 'rejected' });
    await expect(service.openProject()).resolves.toMatchObject({ status: 'accepted' });
    expect((await service.getSnapshot()).project.title).toBe('picked');
    await service.stop();
    await projection.runtime.stop();
  });

  test('exposes an unreadable initial repository instead of silently treating it as no project and can recover', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'orquesta-initial-error-'));
    temporaryRoots.push(temporary);
    const broken = path.join(temporary, 'broken');
    const brokenState = path.join(broken, '.orquesta', 'state');
    await mkdir(brokenState, { recursive: true });
    await writeFile(path.join(brokenState, 'agents.json'), '{ broken', 'utf8');
    await writeFile(path.join(brokenState, 'tasks.json'), '{"tasks":[]}', 'utf8');
    const recovered = await makeProject(temporary, 'recovered');
    const projection = createProjectionHost();
    const service = new RepositoryService({
      registryPath: path.join(temporary, 'repositories.json'),
      coreHost: projection.host,
      initialRootPath: broken,
      chooseDirectory: async () => recovered
    });

    await service.initialize();
    await expect(service.getSnapshot()).rejects.toThrow('agents.json');
    await expect(service.openProject()).resolves.toMatchObject({ status: 'accepted' });
    await expect(service.getSnapshot()).resolves.toMatchObject({ project: { title: 'recovered' } });
    await service.stop();
    await projection.runtime.stop();
  });

  test('keeps the last snapshot offline when a refresh becomes unreadable', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'orquesta-refresh-'));
    temporaryRoots.push(temporary);
    const project = await makeProject(temporary, 'watched');
    const projection = createProjectionHost();
    const service = new RepositoryService({
      registryPath: path.join(temporary, 'repositories.json'), coreHost: projection.host, initialRootPath: project
    });
    await service.initialize();
    await writeFile(path.join(project, '.orquesta', 'state', 'tasks.json'), '{broken', 'utf8');

    await service.refresh();

    expect((await service.getSnapshot()).project).toMatchObject({ title: 'watched', status: 'offline' });
    expect((await service.getSnapshot()).agents).toHaveLength(1);
    await service.stop();
    await projection.runtime.stop();
  });
});
