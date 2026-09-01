import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  assertRuntimeAuthority,
  establishRuntimeBinding,
  readRuntimeBinding,
  readRuntimeBindingEvidence
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
  test('missing evidence is a strictly read-only observation', async () => {
    const rootPath = await root();
    await expect(readRuntimeBindingEvidence(rootPath)).resolves.toBeNull();
    await expect(access(path.join(rootPath, '.orquesta'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

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

  test('adopts a legacy binding project id only when its old root fingerprint and caller authority agree', async () => {
    const rootPath = await root();
    await establishRuntimeBinding({
      rootPath,
      projectId: 'Legacy project title',
      launchContext: { source: 'standalone', callingThreadId: null },
      authorityId: () => 'authority-legacy'
    });
    const filename = path.join(rootPath, '.orquesta', 'state', 'runtime-binding.json');
    const legacy = JSON.parse(await readFile(filename, 'utf8'));
    legacy.project_root_fingerprint = createHash('sha256')
      .update(path.resolve(rootPath).replaceAll('\\', '/'), 'utf8').digest('hex');
    await writeFile(filename, `${JSON.stringify(legacy, null, 2)}\n`, 'utf8');

    await expect(establishRuntimeBinding({
      rootPath,
      projectId: 'native-project-id',
      launchContext: { source: 'standalone', callingThreadId: null }
    })).rejects.toThrow('runtime_binding_project_mismatch');
    const migrated = await establishRuntimeBinding({
      rootPath,
      projectId: 'native-project-id',
      launchContext: { source: 'standalone', callingThreadId: null },
      allowLegacyProjectIdAdoption: true
    });
    expect(migrated).toMatchObject({
      project_id: 'native-project-id',
      runtime_authority_id: 'authority-legacy'
    });
    expect(migrated.project_root_fingerprint).not.toBe(legacy.project_root_fingerprint);
  });

  test('returns the SHA-256 of the exact validated runtime-binding bytes', async () => {
    const rootPath = await root();
    const binding = await establishRuntimeBinding({
      rootPath,
      projectId: 'project-a',
      launchContext: { source: 'standalone', callingThreadId: null },
      authorityId: () => 'authority-evidence',
      now: () => new Date('2026-08-02T01:00:00.000Z')
    });
    const evidence = await readRuntimeBindingEvidence(rootPath);
    const filePath = path.join(rootPath, '.orquesta', 'state', 'runtime-binding.json');
    const bytes = await readFile(filePath);
    expect(evidence).toEqual({
      binding,
      filePath,
      sha256: createHash('sha256').update(bytes).digest('hex')
    });
  });

  test('adopts the normalized Windows legacy fingerprint written by the interim migration code', async () => {
    if (process.platform !== 'win32') return;
    const rootPath = await root();
    await establishRuntimeBinding({
      rootPath,
      projectId: 'Legacy project title',
      launchContext: { source: 'standalone', callingThreadId: null },
      authorityId: () => 'authority-normalized-legacy'
    });
    const filename = path.join(rootPath, '.orquesta', 'state', 'runtime-binding.json');
    const legacy = JSON.parse(await readFile(filename, 'utf8'));
    legacy.project_root_fingerprint = createHash('sha256')
      .update(path.resolve(rootPath).replaceAll('\\', '/').toLowerCase(), 'utf8').digest('hex');
    await writeFile(filename, `${JSON.stringify(legacy, null, 2)}\n`, 'utf8');

    await expect(establishRuntimeBinding({
      rootPath,
      projectId: 'native-project-id',
      launchContext: { source: 'standalone', callingThreadId: null },
      allowLegacyProjectIdAdoption: true
    })).resolves.toMatchObject({
      project_id: 'native-project-id',
      runtime_authority_id: 'authority-normalized-legacy'
    });
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

  test('rejects a binding copied from another project root on read and establish without rewriting it', async () => {
    const source = await root();
    const copy = await root();
    await establishRuntimeBinding({
      rootPath: source,
      projectId: 'project-a',
      launchContext: { source: 'standalone', callingThreadId: null },
      authorityId: () => 'authority-a'
    });
    const copiedBinding = await readFile(path.join(source, '.orquesta', 'state', 'runtime-binding.json'), 'utf8');
    await mkdir(path.join(copy, '.orquesta', 'state'), { recursive: true });
    const copiedPath = path.join(copy, '.orquesta', 'state', 'runtime-binding.json');
    await writeFile(copiedPath, copiedBinding, 'utf8');

    await expect(readRuntimeBinding(copy)).rejects.toThrow('runtime_binding_project_mismatch');
    await expect(establishRuntimeBinding({
      rootPath: copy,
      projectId: 'project-a',
      launchContext: { source: 'standalone', callingThreadId: null }
    })).rejects.toThrow('runtime_binding_project_mismatch');
    expect(await readFile(copiedPath, 'utf8')).toBe(copiedBinding);
  });
});
