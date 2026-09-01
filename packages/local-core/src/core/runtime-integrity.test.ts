import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { verifyDesktopRuntimeIntegrity } from './runtime-integrity';

const temporaryRoots: string[] = [];
const packages = [
  { directory: 'codex-sdk', name: '@openai/codex-sdk', version: '0.144.5' },
  { directory: 'codex', name: '@openai/codex', version: '0.144.5' },
  { directory: 'codex-win32-x64', name: '@openai/codex', version: '0.144.5-win32-x64' }
];
const fileContents = new Map<string, Buffer>([
  ['node_modules/@openai/codex-sdk/package.json', Buffer.from('{"name":"@openai/codex-sdk","version":"0.144.5"}\n')],
  ['node_modules/@openai/codex/package.json', Buffer.from('{"name":"@openai/codex","version":"0.144.5"}\n')],
  ['node_modules/@openai/codex-win32-x64/package.json', Buffer.from('{"name":"@openai/codex","version":"0.144.5-win32-x64"}\n')],
  ['node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe', Buffer.from('fixture-executable')]
]);

async function createRuntimeFixture() {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), 'orquesta-runtime-integrity-'));
  temporaryRoots.push(runtimeRoot);
  const files = [];
  for (const [relativePath, contents] of fileContents) {
    const target = path.join(runtimeRoot, ...relativePath.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
    files.push({
      path: relativePath,
      bytes: contents.byteLength,
      sha256: createHash('sha256').update(contents).digest('hex')
    });
  }
  const manifest = { schemaVersion: 1, packages, files };
  await writeFile(path.join(runtimeRoot, 'runtime-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { manifest, runtimeRoot };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});
describe('verifyDesktopRuntimeIntegrity', () => {
  it('accepts an exact pinned runtime manifest and matching files', async () => {
    const fixture = await createRuntimeFixture();
    await expect(verifyDesktopRuntimeIntegrity({ runtimeRoot: fixture.runtimeRoot })).resolves.toEqual({
      integrity: 'verified',
      filesVerified: 4
    });
  });

  it('rejects a tampered codex.exe', async () => {
    const fixture = await createRuntimeFixture();
    const executablePath = path.join(
      fixture.runtimeRoot,
      'node_modules',
      '@openai',
      'codex-win32-x64',
      'vendor',
      'x86_64-pc-windows-msvc',
      'bin',
      'codex.exe'
    );
    await writeFile(executablePath, Buffer.from('tampered-executable'));

    await expect(verifyDesktopRuntimeIntegrity({ runtimeRoot: fixture.runtimeRoot })).rejects.toThrow(/integrity mismatch/i);
  });

  it('rejects tampered package metadata even when the file length is unchanged', async () => {
    const fixture = await createRuntimeFixture();
    const packagePath = path.join(fixture.runtimeRoot, 'node_modules', '@openai', 'codex', 'package.json');
    const original = await readFile(packagePath);
    const tampered = Buffer.from(original.toString('utf8').replace('0.144.5', '0.144.6'));
    expect(tampered.byteLength).toBe(original.byteLength);
    await writeFile(packagePath, tampered);

    await expect(verifyDesktopRuntimeIntegrity({ runtimeRoot: fixture.runtimeRoot })).rejects.toThrow(/integrity mismatch/i);
  });

  it('rejects a manifest path that escapes the packaged runtime root', async () => {
    const fixture = await createRuntimeFixture();
    fixture.manifest.files[0].path = '../outside.json';
    await writeFile(
      path.join(fixture.runtimeRoot, 'runtime-manifest.json'),
      `${JSON.stringify(fixture.manifest, null, 2)}\n`,
      'utf8'
    );

    await expect(verifyDesktopRuntimeIntegrity({ runtimeRoot: fixture.runtimeRoot })).rejects.toThrow(/unsafe manifest path/i);
  });
});
