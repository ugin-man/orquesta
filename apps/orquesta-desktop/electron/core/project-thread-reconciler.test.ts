import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ProjectThreadReconciler } from './project-thread-reconciler';
import { establishRuntimeBinding } from './runtime-binding-store';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function projectWithSessions(sessions: unknown[], agents: unknown[] = []) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'orquesta-thread-reconcile-'));
  roots.push(root);
  const state = path.join(root, '.orquesta', 'state');
  await mkdir(state, { recursive: true });
  await writeFile(path.join(state, 'sessions.json'), JSON.stringify({
    schema_version: '1.0',
    source: 'desktop_codex_provisioning',
    sessions
  }), 'utf8');
  await writeFile(path.join(state, 'agents.json'), JSON.stringify({
    version: 1,
    agents
  }), 'utf8');
  return root;
}

describe('ProjectThreadReconciler', () => {
  test('coalesces concurrent refreshes for the same project root', async () => {
    const root = await projectWithSessions([
      { agent_id: 'orchestrator', thread_id: 'thread-live', status: 'working' }
    ]);
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const listProjectThreads = vi.fn(async () => {
      await gate;
      return [{
        id: 'thread-live', cwd: root, name: 'Orquesta 統括者', archived: false,
        status: 'active', updatedAt: 1_785_283_200
      }];
    });
    const reconciler = new ProjectThreadReconciler({ listProjectThreads });

    const refreshes = [reconciler.reconcile(root), reconciler.reconcile(root), reconciler.reconcile(root)];
    await vi.waitFor(() => expect(listProjectThreads).toHaveBeenCalledTimes(1));
    release?.();
    await Promise.all(refreshes);
    expect(listProjectThreads).toHaveBeenCalledTimes(1);

    await reconciler.reconcile(root);
    expect(listProjectThreads).toHaveBeenCalledTimes(2);
  });

  test('marks exact-cwd live bindings as bound and missing bindings as missing', async () => {
    const root = await projectWithSessions([
      { agent_id: 'orchestrator', thread_id: 'thread-live', status: 'working' },
      { agent_id: 'implementation', thread_id: 'thread-gone', status: 'working' }
    ]);
    const listProjectThreads = vi.fn(async () => [{
      id: 'thread-live',
      cwd: root,
      name: 'Orquesta 統括者',
      archived: false,
      status: 'active',
      updatedAt: 1_785_283_200
    }]);
    const reconciler = new ProjectThreadReconciler({ listProjectThreads });

    await reconciler.reconcile(root);

    const state = JSON.parse(await readFile(path.join(root, '.orquesta', 'state', 'sessions.json'), 'utf8'));
    expect(state.source).toBe('codex_app.thread_list');
    expect(state.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ agent_id: 'orchestrator', thread_id: 'thread-live', binding_status: 'bound' }),
      expect.objectContaining({ agent_id: 'implementation', thread_id: 'thread-gone', binding_status: 'missing', status: 'stale' })
    ]));
    await expect(reconciler.resolveBoundThread(root, 'implementation')).rejects.toThrow(/not bound/i);
    await expect(reconciler.resolveBoundThread(root, 'orchestrator')).resolves.toBe('thread-live');
  });

  test('does not rebind a missing id merely because a live thread has the same title', async () => {
    const root = await projectWithSessions([
      { agent_id: 'orchestrator', thread_id: 'thread-old', title: 'Orquesta 統括者', status: 'working' }
    ]);
    const reconciler = new ProjectThreadReconciler({
      listProjectThreads: async () => [{
        id: 'thread-new',
        cwd: root,
        name: 'Orquesta 統括者',
        archived: false,
        status: 'idle',
        updatedAt: 1_785_283_200
      }]
    });

    await reconciler.reconcile(root);

    const state = JSON.parse(await readFile(path.join(root, '.orquesta', 'state', 'sessions.json'), 'utf8'));
    expect(state.sessions[0]).toMatchObject({ thread_id: 'thread-old', binding_status: 'missing' });
  });

  test('fails closed when a session belongs to another runtime authority', async () => {
    const root = await projectWithSessions([{
      agent_id: 'orchestrator',
      thread_id: 'thread-live',
      runtime_authority_id: 'authority-other',
      visibility: 'codex_task',
      session_kind: 'persistent_agent'
    }]);
    await establishRuntimeBinding({
      rootPath: root,
      projectId: 'project-a',
      launchContext: { source: 'argv', callingThreadId: 'thread-live' },
      authorityId: () => 'authority-current'
    });
    const reconciler = new ProjectThreadReconciler({
      listProjectThreads: async () => [{
        id: 'thread-live',
        cwd: root,
        name: 'Orquesta 統括',
        archived: false,
        status: 'idle',
        updatedAt: 1_785_283_200
      }]
    });

    await reconciler.reconcile(root);

    const state = JSON.parse(await readFile(path.join(root, '.orquesta', 'state', 'sessions.json'), 'utf8'));
    expect(state.sessions[0]).toMatchObject({
      thread_id: 'thread-live',
      binding_status: 'authority_conflict',
      status: 'stale'
    });
    await expect(reconciler.resolveBoundThread(root, 'orchestrator')).rejects.toThrow(/not bound/i);
  });

  test('accepts a session owned by the current runtime authority', async () => {
    const root = await projectWithSessions([{
      agent_id: 'orchestrator',
      thread_id: 'thread-live',
      runtime_authority_id: 'authority-current',
      visibility: 'codex_task',
      profile_id: 'foundation:orchestrator:v1',
      session_kind: 'persistent_agent'
    }]);
    await establishRuntimeBinding({
      rootPath: root,
      projectId: 'project-a',
      launchContext: { source: 'argv', callingThreadId: 'thread-live' },
      authorityId: () => 'authority-current'
    });
    const reconciler = new ProjectThreadReconciler({
      listProjectThreads: async () => [{
        id: 'thread-live',
        cwd: root,
        name: 'Orquesta 統括',
        archived: false,
        status: 'idle',
        updatedAt: 1_785_283_200
      }]
    });

    await reconciler.reconcile(root);

    await expect(reconciler.resolveBoundThread(root, 'orchestrator')).resolves.toBe('thread-live');
    await expect(reconciler.resolveAgentSessions(root, 'orchestrator')).resolves.toEqual([
      expect.objectContaining({
        runtimeAuthorityId: 'authority-current',
        visibility: 'codex_task',
        profileId: 'foundation:orchestrator:v1',
        sessionKind: 'persistent_agent'
      })
    ]);
  });

  test('migrates a legacy session agent id from the appointed agent thread id', async () => {
    const root = await projectWithSessions([
      { thread_id: 'thread-live', title: '★ Orquesta 統括', status: 'active' }
    ], [
      {
        agent_id: 'orchestrator',
        thread_id: 'thread-live'
      }
    ]);
    const reconciler = new ProjectThreadReconciler({
      listProjectThreads: async () => [{
        id: 'thread-live',
        cwd: root,
        name: '★ Orquesta 統括',
        archived: false,
        status: 'idle',
        updatedAt: 1_785_283_200
      }]
    });

    await reconciler.reconcile(root);

    const state = JSON.parse(await readFile(path.join(root, '.orquesta', 'state', 'sessions.json'), 'utf8'));
    expect(state.sessions[0]).toMatchObject({
      agent_id: 'orchestrator',
      thread_id: 'thread-live',
      binding_status: 'bound'
    });
    await expect(reconciler.resolveBoundThread(root, 'orchestrator')).resolves.toBe('thread-live');
  });

  test('binds an appointed specialist thread from its registered worktree', async () => {
    const root = await projectWithSessions([
      { agent_id: 'spiritual-product', thread_id: 'thread-worktree', status: 'active' }
    ]);
    const worktree = await mkdtemp(path.join(os.tmpdir(), 'orquesta-specialist-worktree-'));
    roots.push(worktree);
    const agentsPath = path.join(root, '.orquesta', 'state', 'agents.json');
    await writeFile(agentsPath, JSON.stringify({
      version: 1,
      agents: [{
        agent_id: 'spiritual-product',
        thread_id: 'thread-worktree',
        workspace_path: worktree
      }]
    }), 'utf8');
    const listProjectThreads = vi.fn(async (workspacePath: string) => (
      path.resolve(workspacePath) === path.resolve(worktree)
        ? [{
            id: 'thread-worktree',
            cwd: worktree,
            name: '収益事業｜鑑定書商品開発',
            archived: false,
            status: 'active',
            updatedAt: 1_785_283_200
          }]
        : []
    ));
    const reconciler = new ProjectThreadReconciler({ listProjectThreads });

    await reconciler.reconcile(root);

    const state = JSON.parse(await readFile(path.join(root, '.orquesta', 'state', 'sessions.json'), 'utf8'));
    expect(state.sessions[0]).toMatchObject({
      agent_id: 'spiritual-product',
      thread_id: 'thread-worktree',
      binding_status: 'bound',
      cwd: worktree
    });
    expect(listProjectThreads).toHaveBeenCalledWith(worktree);
  });

  test('discovers a recorded session root and synchronizes its explicit canonical title', async () => {
    const alternateRoot = await mkdtemp(path.join(os.tmpdir(), 'orquesta-recorded-session-root-'));
    roots.push(alternateRoot);
    const root = await projectWithSessions([{
      agent_id: 'orchestrator',
      thread_id: 'thread-live',
      title: '統括者',
      cwd: alternateRoot
    }], [{
      agent_id: 'orchestrator',
      display_name: '★ Orquesta 統括者',
      thread_id: 'thread-live'
    }]);
    const listProjectThreads = vi.fn(async (workspacePath: string) => (
      path.resolve(workspacePath) === path.resolve(alternateRoot)
        ? [{
            id: 'thread-live',
            cwd: alternateRoot,
            name: '統括者',
            archived: false,
            status: 'idle',
            updatedAt: 1_785_283_200
          }]
        : []
    ));
    const setThreadName = vi.fn(async () => undefined);
    const reconciler = new ProjectThreadReconciler({ listProjectThreads, setThreadName });

    await reconciler.reconcile(root);

    expect(listProjectThreads).toHaveBeenCalledWith(alternateRoot);
    expect(setThreadName).toHaveBeenCalledWith({
      correlationId: 'project-thread-title:thread-live',
      threadId: 'thread-live',
      name: '★ Orquesta 統括者'
    });
    const state = JSON.parse(await readFile(path.join(root, '.orquesta', 'state', 'sessions.json'), 'utf8'));
    expect(state.sessions[0]).toMatchObject({
      binding_status: 'bound',
      cwd: alternateRoot,
      title: '★ Orquesta 統括者',
      title_sync_status: 'synced'
    });
  });

  test('routes new work to the verified owner while keeping superseded generations readable', async () => {
    const root = await projectWithSessions([
      {
        session_id: 'session-old', agent_id: 'orchestrator', thread_id: 'thread-old',
        session_generation: 1, rotation_state: 'superseded', ownership_status: 'superseded'
      },
      {
        session_id: 'session-new', agent_id: 'orchestrator', thread_id: 'thread-new',
        session_generation: 2, rotation_state: 'active', ownership_status: 'owner'
      }
    ]);
    const reconciler = new ProjectThreadReconciler({
      listProjectThreads: async () => [
        { id: 'thread-old', cwd: root, name: 'Orquesta 統括', archived: true, status: 'idle', updatedAt: 1_785_283_100 },
        { id: 'thread-new', cwd: root, name: 'Orquesta 統括', archived: false, status: 'idle', updatedAt: 1_785_283_200 }
      ]
    });

    await reconciler.reconcile(root);

    await expect(reconciler.resolveBoundThread(root, 'orchestrator')).resolves.toBe('thread-new');
    await expect(reconciler.resolveConversationSessions(root, 'orchestrator')).resolves.toEqual([
      expect.objectContaining({ threadId: 'thread-old', generation: 1, ownershipStatus: 'superseded' }),
      expect.objectContaining({ threadId: 'thread-new', generation: 2, ownershipStatus: 'owner' })
    ]);
  });

  test('reads a canonical superseded generation without making its unverified authority routable', async () => {
    const root = await projectWithSessions([
      {
        session_id: 'session-old', agent_id: 'orchestrator', thread_id: 'thread-old',
        session_generation: 1, rotation_state: 'superseded', ownership_status: 'superseded',
        binding_status: 'authority_unverified', accepts_new_work: false
      },
      {
        session_id: 'session-new', agent_id: 'orchestrator', thread_id: 'thread-new',
        session_generation: 2, rotation_state: 'active', ownership_status: 'owner',
        binding_status: 'bound', accepts_new_work: true
      }
    ]);
    const reconciler = new ProjectThreadReconciler({ listProjectThreads: async () => [] });

    await expect(reconciler.resolveBoundThread(root, 'orchestrator')).resolves.toBe('thread-new');
    await expect(reconciler.resolveConversationSessions(root, 'orchestrator')).resolves.toEqual([
      expect.objectContaining({
        threadId: 'thread-old', generation: 1, ownershipStatus: 'superseded', bindingStatus: 'authority_unverified'
      }),
      expect.objectContaining({
        threadId: 'thread-new', generation: 2, ownershipStatus: 'owner', bindingStatus: 'bound'
      })
    ]);
  });

  test('restores a verified successor from the rotation registry when a stale refresh omitted it', async () => {
    const root = await projectWithSessions([{
      session_id: 'session-old', agent_id: 'testing-001', thread_id: 'thread-old'
    }], [{ agent_id: 'testing-001', thread_id: 'thread-new', session_generation: 2 }]);
    await writeFile(path.join(root, '.orquesta', 'state', 'session-rotation.json'), JSON.stringify({
      sessions: {
        'session-old': { session_id: 'session-old', thread_id: 'thread-old', agent_id: 'testing-001', session_generation: 1, rotation_state: 'superseded', ownership_status: 'superseded', accepts_new_work: false, replaced_by_session_id: 'thread-new' },
        'thread-new': { session_id: 'thread-new', thread_id: 'thread-new', agent_id: 'testing-001', session_generation: 2, rotation_state: 'active', ownership_status: 'owner', accepts_new_work: true, replaces_session_id: 'session-old' }
      }
    }), 'utf8');
    const reconciler = new ProjectThreadReconciler({ listProjectThreads: async () => [
      { id: 'thread-old', cwd: root, name: '旧検証係', archived: false, status: 'idle', updatedAt: 1_785_283_100 },
      { id: 'thread-new', cwd: root, name: '検証係', archived: false, status: 'idle', updatedAt: 1_785_283_200 }
    ] });

    await reconciler.reconcile(root);

    const state = JSON.parse(await readFile(path.join(root, '.orquesta', 'state', 'sessions.json'), 'utf8'));
    expect(state.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ thread_id: 'thread-old', ownership_status: 'superseded', session_generation: 1 }),
      expect.objectContaining({ thread_id: 'thread-new', ownership_status: 'owner', session_generation: 2, binding_status: 'bound' })
    ]));
    await expect(reconciler.resolveBoundThread(root, 'testing-001')).resolves.toBe('thread-new');
  });

  test('keeps a non-rotated agent routable when another agent has rotation records', async () => {
    const root = await projectWithSessions([
      { session_id: 'session-orchestrator', agent_id: 'orchestrator', thread_id: 'thread-orchestrator' },
      { session_id: 'session-testing', agent_id: 'testing-001', thread_id: 'thread-testing' }
    ]);
    await writeFile(path.join(root, '.orquesta', 'state', 'session-rotation.json'), JSON.stringify({
      sessions: {
        'session-testing': {
          session_id: 'session-testing',
          thread_id: 'thread-testing',
          agent_id: 'testing-001',
          session_generation: 1,
          rotation_state: 'active',
          ownership_status: 'owner',
          accepts_new_work: true
        }
      }
    }), 'utf8');
    const reconciler = new ProjectThreadReconciler({ listProjectThreads: async () => [
      { id: 'thread-orchestrator', cwd: root, name: 'Orquesta 統括', archived: false, status: 'idle', updatedAt: 1_785_283_200 },
      { id: 'thread-testing', cwd: root, name: '検証係', archived: false, status: 'idle', updatedAt: 1_785_283_100 }
    ] });

    await reconciler.reconcile(root);

    await expect(reconciler.resolveBoundThread(root, 'orchestrator')).resolves.toBe('thread-orchestrator');
    await expect(reconciler.resolveBoundThread(root, 'testing-001')).resolves.toBe('thread-testing');
  });
});
