import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, test } from 'vitest';
import { pathIdentity, samePathIdentity } from './path-identity';

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'orquesta-path-identity-'));
  roots.push(root);
  return root;
}

describe('path identity', () => {
  test('ignores trailing separators and Windows case without merging different worktree roots', async () => {
    const root = await fixture();
    const worktree = path.join(root, 'Worktree');
    const otherWorktree = path.join(root, 'OtherWorktree');
    await Promise.all([mkdir(worktree), mkdir(otherWorktree)]);

    expect(await samePathIdentity(worktree, `${worktree}${path.sep}`)).toBe(true);
    if (process.platform === 'win32') expect(await samePathIdentity(worktree, worktree.toUpperCase())).toBe(true);
    expect(await samePathIdentity(worktree, otherWorktree)).toBe(false);
  });

  test('keeps distinct nonexistent paths distinct while normalizing the same spelling', async () => {
    const root = await fixture();
    const missing = path.join(root, 'missing');
    const other = path.join(root, 'other-missing');
    expect((await pathIdentity(missing)).exists).toBe(false);
    expect(await samePathIdentity(missing, `${missing}${path.sep}`)).toBe(true);
    expect(await samePathIdentity(missing, other)).toBe(false);
  });

  test.skipIf(process.platform !== 'win32')('matches an existing directory by its long and 8.3 short aliases when available', async () => {
    const root = await fixture();
    const longPath = path.join(root, 'Directory With A Long Name');
    await mkdir(longPath);
    const { stdout } = await execFileAsync('cmd.exe', ['/d', '/s', '/c', `for %I in ("${longPath}") do @echo %~sI`]);
    const shortPath = stdout.trim();
    if (!shortPath || shortPath.toLowerCase() === longPath.toLowerCase()) return;
    expect(await samePathIdentity(longPath, shortPath)).toBe(true);
  });
});
