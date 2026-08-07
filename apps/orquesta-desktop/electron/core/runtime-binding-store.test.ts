import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  assertRuntimeAuthority,
  establishRuntimeBinding,
  readRuntimeBinding
} from './runtime-binding-store';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), 'orquesta-runtime-binding-'));
  roots.push(value);
  return value;
}

describe('runtime binding store', () => {
  test('establishes a Codex-hosted authority from the calling task', async () => {
    const rootPath = await root();
    const binding = await establishRuntimeBinding({
      rootPath,
      projectId: 'project-a',
      launchContext: { source: 'argv', callingThreadId: 'thread-orchestrator' },
      authorityId: () => 'authority-a',
      now: () => new Date('2026-08-02T01:00:00.000Z')
    });
    expect(binding).toMatchObject({
      mode: 'codex_hosted',
      transport: 'codex_shared_app_server',
      runtime_authority_id: 'authority-a',
      calling_thread_id: 'thread-orchestrator'
    });
    await expect(readRuntimeBinding(rootPath)).resolves.toEqual(binding);
  });

  test('establishes an explicit standalone authority without a Codex task', async () => {
    const rootPath = await root();
    await expect(establishRuntimeBinding({
      rootPath,
      projectId: 'project-a',
      launchContext: { source: 'standalone', callingThreadId: null },
      authorityId: () => 'authority-standalone'
    })).resolves.toMatchObject({
      mode: 'standalone',
      transport: 'app_server',
      calling_thread_id: null
    });
  });

  test('refreshes the same authority without replacing it', async () => {
    const rootPath = await root();
    const input = {
      rootPath,
      projectId: 'project-a',
      launchContext: { source: 'argv' as const, callingThreadId: 'thread-orchestrator' },
      authorityId: () => 'authority-a'
    };
    await establishRuntimeBinding({ ...input, now: () => new Date('2026-08-02T01:00:00.000Z') });
    const refreshed = await establishRuntimeBinding({
      ...input,
      authorityId: () => 'must-not-replace',
      now: () => new Date('2026-08-02T02:00:00.000Z')
    });
    expect(refreshed.runtime_authority_id).toBe('authority-a');
    expect(refreshed.established_at).toBe('2026-08-02T01:00:00.000Z');
    expect(refreshed.verified_at).toBe('2026-08-02T02:00:00.000Z');
  });

  test('rejects an implicit standalone to Codex migration', async () => {
    const rootPath = await root();
    await establishRuntimeBinding({
      rootPath,
      projectId: 'project-a',
      launchContext: { source: 'standalone', callingThreadId: null }
    });
    await expect(establishRuntimeBinding({
      rootPath,
      projectId: 'project-a',
      launchContext: { source: 'argv', callingThreadId: 'thread-orchestrator' }
    })).rejects.toThrow('runtime_mode_change_requires_explicit_migration');
  });

  test('rejects another calling task taking over the same binding', async () => {
    const rootPath = await root();
    await establishRuntimeBinding({
      rootPath,
      projectId: 'project-a',
      launchContext: { source: 'argv', callingThreadId: 'thread-a' }
    });
    await expect(establishRuntimeBinding({
      rootPath,
      projectId: 'project-a',
      launchContext: { source: 'argv', callingThreadId: 'thread-b' }
    })).rejects.toThrow('runtime_authority_conflict');
  });

  test('checks the authority before accepting runtime work', async () => {
    const rootPath = await root();
    await establishRuntimeBinding({
      rootPath,
      projectId: 'project-a',
      launchContext: { source: 'standalone', callingThreadId: null },
      authorityId: () => 'authority-a'
    });
    await expect(assertRuntimeAuthority(rootPath, {
      mode: 'standalone',
      runtime_authority_id: 'authority-a'
    })).resolves.toMatchObject({ runtime_authority_id: 'authority-a' });
    await expect(assertRuntimeAuthority(rootPath, {
      mode: 'standalone',
      runtime_authority_id: 'authority-b'
    })).rejects.toThrow('runtime_authority_conflict');
  });
});
