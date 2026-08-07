import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ConversationPage } from '../../src/contracts/bridge';
import type { DesktopCodexService, DesktopRuntimeSendInput } from './desktop-codex-service';
import { establishRuntimeBinding } from './runtime-binding-store';
import { SessionRotationController } from './session-rotation-controller';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createProject(
  compactionCount = 15,
  runtimeMode: 'standalone' | 'codex_hosted' | 'missing' = 'standalone'
): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'orquesta-session-rotation-'));
  roots.push(root);
  const state = path.join(root, '.orquesta', 'state');
  await mkdir(state, { recursive: true });
  await writeFile(path.join(state, 'sessions.json'), `${JSON.stringify({
    schema_version: '1.0',
    sessions: [{
      session_id: 'session-old', thread_id: 'thread-old', agent_id: 'orchestrator',
      session_generation: 1, rotation_state: 'rotation_pending', ownership_status: 'owner',
      accepts_new_work: true, binding_status: 'bound', runtime_status: 'idle', status: 'standby', title: 'Orquesta 統括'
    }]
  }, null, 2)}\n`, 'utf8');
  await writeFile(path.join(state, 'agents.json'), `${JSON.stringify({
    version: 1,
    agents: [{ agent_id: 'orchestrator', display_name: 'Orquesta 統括', thread_id: 'thread-old', session_generation: 1 }]
  }, null, 2)}\n`, 'utf8');
  await writeFile(path.join(state, 'tasks.json'), `${JSON.stringify({
    tasks: [{ task_id: 'T1', owner_agent_id: 'orchestrator', status: 'working', title: 'Continue the project' }]
  }, null, 2)}\n`, 'utf8');
  await writeFile(path.join(state, 'session-rotation.json'), `${JSON.stringify({
    schema_version: 1,
    revision: 1,
    policy: { prepare_at: 12, pending_at: 15, required_at: 20 },
    sessions: {
      'session-old': {
        session_id: 'session-old', thread_id: 'thread-old', agent_id: 'orchestrator', session_generation: 1,
        compaction_count: compactionCount, rotation_state: compactionCount >= 20 ? 'rotation_required' : 'rotation_pending',
        ownership_status: 'owner', accepts_new_work: compactionCount < 20,
        replaces_session_id: null, replaced_by_session_id: null,
        handoff_manifest_path: null, handoff_manifest_hash: null,
        successor_receipt_path: null, successor_receipt_hash: null, last_compaction: null,
        created_at: '2026-07-31T00:00:00.000Z', updated_at: '2026-07-31T00:00:00.000Z'
      }
    },
    applied_event_ids: [],
    updated_at: '2026-07-31T00:00:00.000Z'
  }, null, 2)}\n`, 'utf8');
  if (runtimeMode !== 'missing') {
    await establishRuntimeBinding({
      rootPath: root,
      projectId: 'project-1',
      launchContext: runtimeMode === 'codex_hosted'
        ? { source: 'argv', callingThreadId: 'thread-old' }
        : { source: 'standalone', callingThreadId: null }
    });
  }
  return root;
}

function runtimeDouble({
  validReceipt = true,
  visibleThreadIds = ['thread-old', 'thread-new']
}: { validReceipt?: boolean; visibleThreadIds?: string[] } = {}) {
  let receiptText = '';
  const listConversation = vi.fn(async ({ threadId }: { threadId: string }): Promise<ConversationPage> => ({
    items: threadId === 'thread-new' ? [{
      id: 'agent-receipt', role: 'agent', targetAgentId: 'orchestrator', authorLabel: 'Orquesta 統括',
      text: validReceipt ? receiptText : 'I read the handoff, but omitted the receipt.',
      createdAt: '2026-07-31T00:01:00.000Z', evidenceLabel: 'Codex thread history'
    }] : [{
      id: 'user-old', role: 'user', targetAgentId: 'orchestrator', authorLabel: 'You', text: 'Keep the important nuance.',
      createdAt: '2026-07-31T00:00:00.000Z', evidenceLabel: null
    }],
    nextCursor: null
  }));
  const sendMessage = vi.fn(async (input: DesktopRuntimeSendInput) => {
    const receipt = input.text.match(/<orquesta_session_receipt>(\{.*\})<\/orquesta_session_receipt>/u)?.[1] ?? '{}';
    receiptText = `<orquesta_session_receipt>${receipt}</orquesta_session_receipt>`;
    await input.onThreadReady?.('thread-new');
    return {
      threadId: 'thread-new', turnId: 'turn-new',
      modelEvidence: { recommendedModel: null, requestedModel: null, appliedModel: null, actualModel: null, actualModelEvidence: 'unknown' as const }
    };
  });
  const listProjectThreads = vi.fn(async () => visibleThreadIds.map((id) => ({
    id,
    cwd: roots.at(-1) ?? '',
    name: null,
    archived: false,
    status: 'idle',
    updatedAt: Date.now()
  })));
  return {
    runtime: { listConversation, listProjectThreads, sendMessage } as unknown as DesktopCodexService,
    listConversation,
    listProjectThreads,
    sendMessage
  };
}

describe('SessionRotationController', () => {
  test('installs the canonical compaction guard into an active same-repository task placement', async () => {
    const root = await createProject(0, 'missing');
    const placement = await mkdtemp(path.join(os.tmpdir(), 'orquesta-session-placement-'));
    roots.push(placement);
    const commonGit = path.join(placement, '.git');
    const worktreeGit = path.join(commonGit, 'worktrees', 'canonical');
    await mkdir(worktreeGit, { recursive: true });
    await writeFile(path.join(root, '.git'), `gitdir: ${worktreeGit}\n`, 'utf8');
    await writeFile(path.join(worktreeGit, 'commondir'), '../..\n', 'utf8');
    const sessionsPath = path.join(root, '.orquesta', 'state', 'sessions.json');
    const sessions = JSON.parse(await readFile(sessionsPath, 'utf8'));
    sessions.sessions[0] = {
      ...sessions.sessions[0], cwd: placement, rotation_state: 'active', ownership_status: 'owner', binding_status: 'bound'
    };
    await writeFile(sessionsPath, `${JSON.stringify(sessions, null, 2)}\n`, 'utf8');
    const registryPath = path.join(root, '.orquesta', 'state', 'session-rotation.json');
    const registry = JSON.parse(await readFile(registryPath, 'utf8'));
    registry.sessions['session-old'].rotation_state = 'active';
    registry.sessions['session-old'].accepts_new_work = true;
    await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');

    const controller = new SessionRotationController({ runtime: runtimeDouble().runtime });
    await controller.open(root, 'project-1');

    const placementHooks = JSON.parse(await readFile(path.join(placement, '.codex', 'hooks.json'), 'utf8'));
    const command = placementHooks.hooks.PostCompact[0].hooks[0].commandWindows as string;
    expect(command).toContain(path.join(root, '.orquesta', 'runtime', 'session-rotation-hook.cjs'));
    await expect(readFile(path.join(placement, '.orquesta', 'runtime', 'session-rotation-hook.cjs'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('does not write a hook into a recorded placement from another repository', async () => {
    const root = await createProject(0, 'missing');
    const placement = await mkdtemp(path.join(os.tmpdir(), 'orquesta-other-repository-'));
    roots.push(placement);
    await mkdir(path.join(root, '.git'), { recursive: true });
    await mkdir(path.join(placement, '.git'), { recursive: true });
    const sessionsPath = path.join(root, '.orquesta', 'state', 'sessions.json');
    const sessions = JSON.parse(await readFile(sessionsPath, 'utf8'));
    sessions.sessions[0] = {
      ...sessions.sessions[0], cwd: placement, rotation_state: 'active', ownership_status: 'owner', binding_status: 'bound'
    };
    await writeFile(sessionsPath, `${JSON.stringify(sessions, null, 2)}\n`, 'utf8');
    const registryPath = path.join(root, '.orquesta', 'state', 'session-rotation.json');
    const registry = JSON.parse(await readFile(registryPath, 'utf8'));
    registry.sessions['session-old'].rotation_state = 'active';
    registry.sessions['session-old'].accepts_new_work = true;
    await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');

    const controller = new SessionRotationController({ runtime: runtimeDouble().runtime });
    await controller.open(root, 'project-1');

    await expect(readFile(path.join(placement, '.codex', 'hooks.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('creates a fresh thread, verifies its receipt, and cuts ownership over atomically at the registry boundary', async () => {
    const root = await createProject();
    const double = runtimeDouble();
    const controller = new SessionRotationController({ runtime: double.runtime });

    await controller.open(root, 'project-1');
    expect(double.sendMessage).toHaveBeenCalledOnce();
    expect(double.sendMessage.mock.calls[0][0]).toMatchObject({ threadId: null, targetAgentId: 'orchestrator' });
    await controller.observe({
      kind: 'turn_completed', threadId: 'thread-new', turnId: 'turn-new', text: null, targetAgentId: 'orchestrator',
      modelEvidence: { recommendedModel: null, requestedModel: null, appliedModel: null, actualModel: null, actualModelEvidence: 'unknown' }
    });

    const registry = JSON.parse(await readFile(path.join(root, '.orquesta', 'state', 'session-rotation.json'), 'utf8'));
    expect(registry.sessions['session-old']).toMatchObject({ rotation_state: 'superseded', ownership_status: 'superseded' });
    expect(registry.sessions['thread-new']).toMatchObject({ rotation_state: 'active', ownership_status: 'owner', session_generation: 2 });
    const sessions = JSON.parse(await readFile(path.join(root, '.orquesta', 'state', 'sessions.json'), 'utf8'));
    expect(sessions.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ thread_id: 'thread-old', ownership_status: 'superseded' }),
      expect.objectContaining({
        thread_id: 'thread-new', ownership_status: 'owner', session_generation: 2,
        visibility: 'desktop_only', session_kind: 'persistent_agent'
      })
    ]));
    const agents = JSON.parse(await readFile(path.join(root, '.orquesta', 'state', 'agents.json'), 'utf8'));
    expect(agents.agents[0]).toMatchObject({ thread_id: 'thread-new', session_generation: 2 });
    expect(double.listConversation).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-old' }));
  });

  test('keeps the predecessor as owner when the successor does not provide a verifiable receipt', async () => {
    const root = await createProject();
    const double = runtimeDouble({ validReceipt: false });
    const controller = new SessionRotationController({ runtime: double.runtime });

    await controller.open(root, 'project-1');
    await controller.observe({
      kind: 'turn_completed', threadId: 'thread-new', turnId: 'turn-new', text: null, targetAgentId: 'orchestrator',
      modelEvidence: { recommendedModel: null, requestedModel: null, appliedModel: null, actualModel: null, actualModelEvidence: 'unknown' }
    });

    const registry = JSON.parse(await readFile(path.join(root, '.orquesta', 'state', 'session-rotation.json'), 'utf8'));
    expect(registry.sessions['session-old']).toMatchObject({ rotation_state: 'rotation_pending', ownership_status: 'owner' });
    expect(registry.sessions['thread-new']).toMatchObject({ rotation_state: 'failed', ownership_status: 'candidate' });
    const agents = JSON.parse(await readFile(path.join(root, '.orquesta', 'state', 'agents.json'), 'utf8'));
    expect(agents.agents[0].thread_id).toBe('thread-old');
  });

  test('omits terminal state- and status-based tasks from the handoff manifest', async () => {
    const root = await createProject();
    const tasksPath = path.join(root, '.orquesta', 'state', 'tasks.json');
    await writeFile(tasksPath, `${JSON.stringify({
      tasks: [
        { task_id: 'T-active', owner_agent_id: 'orchestrator', state: 'working' },
        { task_id: 'T-state-accepted', owner_agent_id: 'orchestrator', state: 'accepted' },
        { task_id: 'T-status-completed', owner_agent_id: 'orchestrator', status: 'completed' },
        { task_id: 'T-status-cancelled', owner_agent_id: 'orchestrator', status: 'cancelled' },
        { task_id: 'T-status-failed', owner_agent_id: 'orchestrator', status: 'failed' }
      ]
    }, null, 2)}\n`, 'utf8');
    const controller = new SessionRotationController({ runtime: runtimeDouble().runtime });

    await controller.open(root, 'project-1');

    const manifest = JSON.parse(await readFile(path.join(
      root, '.orquesta', 'state', 'session-handoffs', 'orchestrator', 'generation-1-to-2.manifest.json'
    ), 'utf8'));
    expect(manifest.active_tasks.map((task: { task_id: string }) => task.task_id)).toEqual(['T-active']);
  });

  test('fails closed without a runtime binding instead of creating a hidden successor', async () => {
    const root = await createProject(15, 'missing');
    const double = runtimeDouble();
    const controller = new SessionRotationController({ runtime: double.runtime });

    await controller.open(root, 'project-1');

    expect(double.sendMessage).not.toHaveBeenCalled();
    const recovery = JSON.parse(await readFile(
      path.join(root, '.orquesta', 'state', 'session-rotation-recovery.json'),
      'utf8'
    ));
    expect(recovery.requests).toEqual([
      expect.objectContaining({
        agent_id: 'orchestrator',
        status: 'manual_recovery',
        reason: 'runtime_binding_required',
        successor_thread_id: null
      })
    ]);
    const registry = JSON.parse(await readFile(path.join(root, '.orquesta', 'state', 'session-rotation.json'), 'utf8'));
    expect(registry.sessions['session-old']).toMatchObject({
      rotation_state: 'rotation_pending',
      ownership_status: 'owner'
    });
  });

  test('requires a visible pre-bound Codex task before hosted rotation and completes through that task', async () => {
    const root = await createProject(15, 'codex_hosted');
    const double = runtimeDouble();
    const controller = new SessionRotationController({ runtime: double.runtime });

    await controller.open(root, 'project-1');
    expect(double.sendMessage).not.toHaveBeenCalled();

    await controller.bindHostedSuccessor({
      rootPath: root,
      projectId: 'project-1',
      agentId: 'orchestrator',
      successorThreadId: 'thread-new'
    });
    expect(double.listProjectThreads).toHaveBeenCalledWith(root);
    expect(double.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      threadId: 'thread-new',
      targetAgentId: 'orchestrator'
    }));
    await controller.observe({
      kind: 'turn_completed', threadId: 'thread-new', turnId: 'turn-new', text: null, targetAgentId: 'orchestrator',
      modelEvidence: { recommendedModel: null, requestedModel: null, appliedModel: null, actualModel: null, actualModelEvidence: 'unknown' }
    });

    const registry = JSON.parse(await readFile(path.join(root, '.orquesta', 'state', 'session-rotation.json'), 'utf8'));
    expect(registry.sessions['thread-new']).toMatchObject({ rotation_state: 'active', ownership_status: 'owner' });
    const sessions = JSON.parse(await readFile(path.join(root, '.orquesta', 'state', 'sessions.json'), 'utf8'));
    expect(sessions.sessions.find((session: { thread_id: string }) => session.thread_id === 'thread-new')).toMatchObject({
      runtime_authority_id: expect.any(String), visibility: 'codex_task',
      profile_id: 'session-rotation:orchestrator:generation-2', session_kind: 'persistent_agent'
    });
    const recovery = JSON.parse(await readFile(
      path.join(root, '.orquesta', 'state', 'session-rotation-recovery.json'),
      'utf8'
    ));
    expect(recovery.requests[0]).toMatchObject({
      status: 'completed',
      successor_thread_id: 'thread-new'
    });
  });

  test('rejects a hosted successor that is not visible in the selected Codex project', async () => {
    const root = await createProject(15, 'codex_hosted');
    const double = runtimeDouble({ visibleThreadIds: ['thread-old'] });
    const controller = new SessionRotationController({ runtime: double.runtime });

    await controller.open(root, 'project-1');
    await expect(controller.bindHostedSuccessor({
      rootPath: root,
      projectId: 'project-1',
      agentId: 'orchestrator',
      successorThreadId: 'thread-other-project'
    })).rejects.toThrow('could not be bound safely');

    expect(double.sendMessage).not.toHaveBeenCalled();
    const recovery = JSON.parse(await readFile(
      path.join(root, '.orquesta', 'state', 'session-rotation-recovery.json'),
      'utf8'
    ));
    expect(recovery.requests[0]).toMatchObject({
      status: 'manual_recovery',
      reason: 'codex_hosted_successor_not_in_project:thread-other-project'
    });
  });

  test('resumes a canonical hosted binding when Desktop opens again', async () => {
    const root = await createProject(15, 'codex_hosted');
    const double = runtimeDouble();
    const controller = new SessionRotationController({ runtime: double.runtime });

    await controller.open(root, 'project-1');
    const recoveryPath = path.join(root, '.orquesta', 'state', 'session-rotation-recovery.json');
    const recovery = JSON.parse(await readFile(recoveryPath, 'utf8'));
    recovery.requests[0] = {
      ...recovery.requests[0],
      status: 'bound',
      reason: null,
      successor_thread_id: 'thread-new'
    };
    await writeFile(recoveryPath, `${JSON.stringify(recovery, null, 2)}\n`, 'utf8');

    await controller.open(root, 'project-1');

    expect(double.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-new' }));
  });

  test('blocks required work until a hosted successor binding exists', async () => {
    const root = await createProject(20, 'codex_hosted');
    const controller = new SessionRotationController({ runtime: runtimeDouble().runtime });

    await controller.open(root, 'project-1');

    await expect(controller.ensureReadyForDispatch(root, 'project-1', 'orchestrator'))
      .rejects.toThrow('requires a Codex-hosted successor binding');
  });
});
