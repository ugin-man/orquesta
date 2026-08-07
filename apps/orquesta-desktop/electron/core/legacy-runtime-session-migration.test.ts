import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { legacyCodexHostedSessionIds, migrateLegacyCodexHostedSessions } from './legacy-runtime-session-migration';
import type { RuntimeBinding } from './runtime-binding-store';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project(sessions: unknown[]): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'orquesta-legacy-runtime-'));
  roots.push(root);
  const state = path.join(root, '.orquesta', 'state');
  await mkdir(state, { recursive: true });
  await writeFile(path.join(state, 'sessions.json'), `${JSON.stringify({ sessions }, null, 2)}\n`, 'utf8');
  return root;
}

function binding(): RuntimeBinding {
  return {
    schema_version: 1,
    project_id: 'repo-1',
    project_root_fingerprint: 'a'.repeat(64),
    mode: 'codex_hosted',
    runtime_authority_id: 'authority-current',
    transport: 'codex_shared_app_server',
    calling_thread_id: 'thread-calling-chat',
    established_at: '2026-08-03T00:00:00.000Z',
    verified_at: '2026-08-03T00:00:00.000Z',
    migration: null
  };
}

describe('legacy Codex-hosted session migration', () => {
  test('adopts only live tasks proven to belong to the exact project root', async () => {
    const root = await project([
      { session_id: 'session-live', agent_id: 'testing-001', thread_id: 'thread-live' },
      { session_id: 'session-archived', agent_id: 'writing-001', thread_id: 'thread-archived' },
      { session_id: 'session-other-root', agent_id: 'research-001', thread_id: 'thread-other-root' }
    ]);
    const threads = [
      { id: 'thread-live', cwd: root, archived: false },
      { id: 'thread-archived', cwd: root, archived: true },
      { id: 'thread-other-root', cwd: path.join(root, 'other'), archived: false }
    ];

    await expect(legacyCodexHostedSessionIds(root, threads)).resolves.toEqual(['thread-live']);
    await expect(migrateLegacyCodexHostedSessions({
      rootPath: root,
      binding: binding(),
      threads,
      now: () => new Date('2026-08-03T01:00:00.000Z')
    })).resolves.toEqual(['thread-live']);

    const state = JSON.parse(await readFile(path.join(root, '.orquesta', 'state', 'sessions.json'), 'utf8'));
    expect(state.sessions[0]).toMatchObject({
      runtime_authority_id: 'authority-current', visibility: 'codex_task',
      profile_id: 'legacy:testing-001:v1', session_kind: 'persistent_agent'
    });
    expect(state.sessions[1]).not.toHaveProperty('runtime_authority_id');
    expect(state.sessions[2]).not.toHaveProperty('runtime_authority_id');
  });

  test('rejects conflicting metadata before changing the sessions file', async () => {
    const root = await project([{
      session_id: 'session-live', agent_id: 'testing-001', thread_id: 'thread-live',
      runtime_authority_id: 'authority-other'
    }]);
    const statePath = path.join(root, '.orquesta', 'state', 'sessions.json');
    const before = await readFile(statePath, 'utf8');

    await expect(migrateLegacyCodexHostedSessions({
      rootPath: root,
      binding: binding(),
      threads: [{ id: 'thread-live', cwd: root, archived: false }]
    })).rejects.toThrow('legacy_runtime_migration_conflict:thread-live');
    await expect(readFile(statePath, 'utf8')).resolves.toBe(before);
  });
});
