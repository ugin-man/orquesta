import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { SetupSourceService } from './setup-source-service';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryParent(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

describe('SetupSourceService', () => {
  test('keeps existing and detected project roots read only', async () => {
    const root = await temporaryParent('orquesta-existing-source-');
    const service = new SetupSourceService();

    const materialized = await service.materialize({ kind: 'existing_folder', rootPath: root });

    expect(materialized.rootPath).toBe(await import('node:fs/promises').then(({ realpath }) => realpath(root)));
    expect(materialized.createdByApp).toBe(false);
    await materialized.rollback();
    await expect(access(path.join(root, '.orquesta'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('creates a new project only during materialization and can roll it back', async () => {
    const temporary = await temporaryParent('orquesta-new-source-');
    const parent = path.join(temporary, 'Orquesta Projects');
    const target = path.join(parent, 'Demo');
    const service = new SetupSourceService();

    await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' });
    const materialized = await service.materialize({ kind: 'new_project', parentPath: parent, folderName: 'Demo' });
    await expect(access(target)).resolves.toBeUndefined();
    await expect(access(path.join(target, '.orquesta'))).rejects.toMatchObject({ code: 'ENOENT' });

    await materialized.rollback();
    await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(parent)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('does not overwrite an existing new-project destination', async () => {
    const parent = await temporaryParent('orquesta-collision-source-');
    await mkdir(path.join(parent, 'Demo'));
    const service = new SetupSourceService();

    await expect(service.materialize({ kind: 'new_project', parentPath: parent, folderName: 'Demo' }))
      .rejects.toThrow('already exists');
  });

  test('stages a public GitHub repository, rejects submodules, and removes all partial output', async () => {
    const parent = await temporaryParent('orquesta-github-submodule-');
    const cloneRepository = vi.fn(async ({ dir }: { dir: string }) => {
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, '.gitmodules'), '[submodule "vendor"]', 'utf8');
    });
    const service = new SetupSourceService({ cloneRepository, randomUUID: () => 'fixture' });

    await expect(service.materialize({
      kind: 'public_github', repositoryUrl: 'https://github.com/example/demo.git', parentPath: parent
    })).rejects.toThrow('submodules');

    expect(cloneRepository).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://github.com/example/demo.git', depth: 1
    }));
    await expect(access(path.join(parent, 'demo'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(path.join(parent, '.orquesta-source-fixture.tmp'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('rejects Git LFS and materializes an ordinary public repository atomically', async () => {
    const lfsParent = await temporaryParent('orquesta-github-lfs-');
    const lfs = new SetupSourceService({
      randomUUID: () => 'lfs',
      cloneRepository: async ({ dir }) => {
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text', 'utf8');
      }
    });
    await expect(lfs.materialize({
      kind: 'public_github', repositoryUrl: 'https://github.com/example/lfs', parentPath: lfsParent
    })).rejects.toThrow('Git LFS');

    const parent = await temporaryParent('orquesta-github-source-');
    const service = new SetupSourceService({
      randomUUID: () => 'success',
      cloneRepository: async ({ dir }) => {
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, 'README.md'), '# Demo', 'utf8');
      }
    });
    const materialized = await service.materialize({
      kind: 'public_github', repositoryUrl: 'https://github.com/example/demo', parentPath: parent
    });

    expect(materialized.rootPath).toBe(path.join(parent, 'demo'));
    expect(await readFile(path.join(materialized.rootPath, 'README.md'), 'utf8')).toBe('# Demo');
    await materialized.rollback();
    await expect(access(materialized.rootPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
