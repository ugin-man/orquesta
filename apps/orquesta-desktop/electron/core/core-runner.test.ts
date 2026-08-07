import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  establishExistingProjectRuntimeBinding,
  foundationThreadIdsFromSessions,
  preferredFoundationThreadIds,
  verifyProvisionedThreadsVisible
} from './core-runner';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function runtimeProject(sessions: unknown[] = []): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'orquesta-core-runner-'));
  roots.push(root);
  const state = path.join(root, '.orquesta', 'state');
  await mkdir(state, { recursive: true });
  await writeFile(path.join(state, 'sessions.json'), `${JSON.stringify({ sessions }, null, 2)}\n`, 'utf8');
  return root;
}

describe('existing project runtime binding', () => {
  test('establishes Codex-hosted ownership only after the calling task is visible', async () => {
    const root = await runtimeProject();
    const establish = vi.fn(async () => ({ mode: 'codex_hosted' as const }));
    const writeLaunchContext = vi.fn(async () => undefined);
    const launchContext = { source: 'argv' as const, callingThreadId: 'thread-calling-chat' };

    await establishExistingProjectRuntimeBinding(
      { rootPath: root, projectId: 'repo-1', launchContext },
      async () => [{ id: 'thread-calling-chat', cwd: root, archived: false }],
      establish as never,
      writeLaunchContext
    );

    expect(establish).toHaveBeenCalledWith({ rootPath: root, projectId: 'repo-1', launchContext });
    expect(writeLaunchContext).toHaveBeenCalledWith(root, launchContext);
  });

  test('fails closed before writing when the calling task is absent or archived', async () => {
    const establish = vi.fn();
    const writeLaunchContext = vi.fn();
    const request = {
      rootPath: 'C:\\project', projectId: 'repo-1',
      launchContext: { source: 'argv' as const, callingThreadId: 'thread-calling-chat' }
    };

    await expect(establishExistingProjectRuntimeBinding(
      request,
      async () => [{ id: 'thread-calling-chat', archived: true }],
      establish,
      writeLaunchContext
    )).rejects.toThrow('codex_hosted_calling_thread_not_in_project:thread-calling-chat');
    expect(establish).not.toHaveBeenCalled();
    expect(writeLaunchContext).not.toHaveBeenCalled();
  });

  test('requires an explicit one-time migration before adopting legacy sessions', async () => {
    const root = await runtimeProject([{
      session_id: 'session-testing', agent_id: 'testing-001', thread_id: 'thread-calling-chat'
    }]);
    const establish = vi.fn();
    const writeLaunchContext = vi.fn();

    await expect(establishExistingProjectRuntimeBinding(
      {
        rootPath: root, projectId: 'repo-1',
        launchContext: { source: 'argv', callingThreadId: 'thread-calling-chat' }
      },
      async () => [{ id: 'thread-calling-chat', cwd: root, archived: false }],
      establish,
      writeLaunchContext
    )).rejects.toThrow('legacy_project_requires_migration');
    expect(establish).not.toHaveBeenCalled();
    expect(writeLaunchContext).not.toHaveBeenCalled();
  });
});

describe('foundation thread preference', () => {
  test('uses the calling Codex thread only when CODEX_THREAD_ID is non-empty', () => {
    expect(preferredFoundationThreadIds({ CODEX_THREAD_ID: '  thread-calling-chat  ' })).toEqual({
      orchestrator: 'thread-calling-chat'
    });
    expect(preferredFoundationThreadIds({})).toBeUndefined();
    expect(preferredFoundationThreadIds({ CODEX_THREAD_ID: '   ' })).toBeUndefined();
  });

  test('selects only the active owner generation from canonical foundation sessions', () => {
    expect(foundationThreadIdsFromSessions({ sessions: [
      {
        agent_id: 'orchestrator',
        thread_id: 'thread-old',
        session_generation: 1,
        rotation_state: 'superseded',
        ownership_status: 'superseded',
        accepts_new_work: false
      },
      {
        agent_id: 'orchestrator',
        thread_id: 'thread-current',
        session_generation: 2,
        rotation_state: 'active',
        ownership_status: 'owner',
        accepts_new_work: true
      },
      {
        agent_id: 'orquesta-admin',
        thread_id: 'thread-luca',
        binding_status: 'bound',
        status: 'standby'
      },
      {
        agent_id: 'user-support',
        thread_id: 'thread-support-archived',
        binding_status: 'archived',
        status: 'standby'
      },
      {
        agent_id: 'implementation-001',
        thread_id: 'thread-specialist'
      }
    ] })).toEqual({
      orchestrator: 'thread-current',
      'orquesta-admin': 'thread-luca'
    });
  });
});

describe('provisioned thread visibility', () => {
  test('accepts only persisted, non-archived Codex tasks', async () => {
    await expect(verifyProvisionedThreadsVisible(
      'C:\\project',
      async () => [{ id: 'thread-a', archived: false }, { id: 'thread-old', archived: true }],
      [{ status: 'accepted', thread_id: 'thread-a' }]
    )).resolves.toBeUndefined();
    await expect(verifyProvisionedThreadsVisible(
      'C:\\project',
      async () => [{ id: 'thread-old', archived: true }],
      [{ handoff_status: 'accepted', thread_id: 'thread-a' }]
    )).rejects.toThrow('provisioned_thread_not_visible:thread-a');
  });
});
