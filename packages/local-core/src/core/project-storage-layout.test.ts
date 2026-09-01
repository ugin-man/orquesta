import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { PROJECT_STORAGE, ensureProjectStorageDirectory, projectStoragePath } from './project-storage-layout';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'orquesta-storage-layout-'));
  roots.push(root);
  await mkdir(path.join(root, '.orquesta'), { recursive: true });
  return root;
}

describe('project storage layout', () => {
  test('keeps every owned path inside the project storage root', async () => {
    const root = await project();
    expect(projectStoragePath(root, 'state/example.json'))
      .toBe(path.join(root, '.orquesta', 'state', 'example.json'));
    expect(() => projectStoragePath(root, '../project-owned.txt'))
      .toThrow('project_storage_relative_path_invalid');
    expect(PROJECT_STORAGE.tasks).not.toBe(PROJECT_STORAGE.placementTasks);
    expect(PROJECT_STORAGE.sessions).not.toBe(PROJECT_STORAGE.sessionBindings);
  });

  test('does not follow a linked storage ancestor', async () => {
    const root = await project();
    const outside = await mkdtemp(path.join(os.tmpdir(), 'orquesta-storage-outside-'));
    roots.push(outside);
    await symlink(outside, path.join(root, '.orquesta', 'state'));
    await expect(ensureProjectStorageDirectory(root, 'state/nested'))
      .rejects.toThrow('project_storage_directory_unsafe');
  });
});
