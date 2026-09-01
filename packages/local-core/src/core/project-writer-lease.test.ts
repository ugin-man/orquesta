import { lstat, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import { ProjectWriterLease } from './project-writer-lease';

const roots: string[] = [];

async function projectRoot(prefix = 'orquesta-writer-lease-'): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('ProjectWriterLease', () => {
  test('admits only one process-local writer for a canonical project root', async () => {
    const root = await projectRoot();
    const first = new ProjectWriterLease();
    const second = new ProjectWriterLease();
    await first.select(root, 'project-1');
    await expect(second.select(root, 'project-1')).rejects.toThrow('project_writer_lease_held');
    await first.release();
    await expect(second.select(root, 'project-1')).resolves.toBe(await lstat(root).then(() => root));
    await second.release();
  });

  test.runIf(process.platform !== 'win32')('rejects a symlinked state boundary', async () => {
    const root = await projectRoot();
    const outside = await projectRoot('orquesta-writer-outside-');
    await mkdir(path.join(root, '.orquesta'));
    await symlink(outside, path.join(root, '.orquesta', 'state'), 'dir');
    await expect(new ProjectWriterLease().select(root, 'project-1')).rejects.toThrow('symlink_boundary');
  });

  test('reserves an operation before path awaits and drains it before removing the lock', async () => {
    const root = await projectRoot();
    const first = new ProjectWriterLease();
    const second = new ProjectWriterLease();
    await first.select(root, 'project-1');
    let finish!: () => void;
    const operation = first.run(root, 'project-1', async () => {
      await new Promise<void>((resolve) => { finish = resolve; });
      return 'done';
    });
    const release = first.release();
    await expect(second.select(root, 'project-1')).rejects.toThrow('held');
    finish();
    await expect(operation).resolves.toBe('done');
    await release;
    await expect(second.select(root, 'project-1')).resolves.toBe(root);
    await second.release();
  });

  test('closes admission before consumer shutdown and retains the lease until termination', async () => {
    const root = await projectRoot();
    const first = new ProjectWriterLease();
    const second = new ProjectWriterLease();
    await first.select(root, 'project-1');
    let finishShutdown!: () => void;
    const closing = first.close(async () => {
      await new Promise<void>((resolve) => { finishShutdown = resolve; });
    });
    await expect(first.run(root, 'project-1', async () => undefined)).rejects.toThrow('not_selected');
    await expect(second.select(root, 'project-1')).rejects.toThrow('held');
    finishShutdown();
    await closing;
    await expect(second.select(root, 'project-1')).resolves.toBe(root);
    await second.release();
  });
});
