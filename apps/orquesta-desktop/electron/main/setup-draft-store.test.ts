import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { SetupDraftStore } from './setup-draft-store';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('SetupDraftStore', () => {
  test('persists the draft under app-owned user data without touching the project', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'orquesta-setup-draft-'));
    temporaryRoots.push(root);
    const projectRoot = path.join(root, 'project');
    await mkdir(projectRoot, { recursive: true });
    const storePath = path.join(root, 'user-data', 'setup-draft.json');
    const store = new SetupDraftStore({ storePath });
    const draft = {
      revision: 1 as const,
      status: 'draft' as const,
      source: { kind: 'existing_folder' as const, rootPath: projectRoot },
      projectName: 'Demo',
      description: '',
      questions: [],
      answers: []
    };

    await store.save(draft);

    await expect(store.read()).resolves.toEqual(draft);
    await expect(readFile(path.join(projectRoot, '.orquesta', 'setup', 'setup_state.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.parse(await readFile(storePath, 'utf8'))).toEqual({ version: 1, draft });
  });

  test('returns null for a missing or invalid app-owned draft', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'orquesta-setup-draft-invalid-'));
    temporaryRoots.push(root);
    const storePath = path.join(root, 'user-data', 'setup-draft.json');
    const store = new SetupDraftStore({ storePath });

    await expect(store.read()).resolves.toBeNull();
    await mkdir(path.dirname(storePath), { recursive: true });
    await import('node:fs/promises').then(({ writeFile }) => writeFile(storePath, '{"version":1,"draft":{"status":"started"}}', 'utf8'));
    await expect(store.read()).resolves.toBeNull();
  });
});
