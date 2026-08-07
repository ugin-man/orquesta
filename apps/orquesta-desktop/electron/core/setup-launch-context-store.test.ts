import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { readSetupLaunchContext, writeSetupLaunchContext } from './setup-launch-context-store';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('setup launch context store', () => {
  test('persists the calling Codex thread inside the selected project', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'orquesta-launch-context-'));
    roots.push(root);
    await writeSetupLaunchContext(root, {
      source: 'argv',
      callingThreadId: '018f0000-0000-7000-8000-000000000001'
    });
    await expect(readSetupLaunchContext(root)).resolves.toMatchObject({
      source: 'argv',
      callingThreadId: '018f0000-0000-7000-8000-000000000001'
    });
  });
});
