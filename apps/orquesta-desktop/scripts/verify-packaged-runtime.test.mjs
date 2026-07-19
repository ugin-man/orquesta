import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { verifyPackagedRuntime } from './verify-packaged-runtime.mjs';

const packages = [
  { directory: 'codex-sdk', name: '@openai/codex-sdk', version: '0.144.5' },
  { directory: 'codex', name: '@openai/codex', version: '0.144.5' },
  { directory: 'codex-win32-x64', name: '@openai/codex', version: '0.144.5-win32-x64' }
];

async function writeRuntimeFixture(resourcesRoot) {
  const runtimeRoot = path.join(resourcesRoot, 'codex-runtime');
  const openAiRoot = path.join(runtimeRoot, 'node_modules', '@openai');
  const files = [];
  for (const pkg of packages) {
    const metadataPath = path.join(openAiRoot, pkg.directory, 'package.json');
    const contents = `${JSON.stringify({ name: pkg.name, version: pkg.version })}\n`;
    await mkdir(path.dirname(metadataPath), { recursive: true });
    await writeFile(metadataPath, contents, 'utf8');
    files.push({
      path: path.relative(runtimeRoot, metadataPath).split(path.sep).join('/'),
      bytes: Buffer.byteLength(contents),
      sha256: createHash('sha256').update(contents).digest('hex')
    });
  }
  const executablePath = path.join(openAiRoot, 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'codex.exe');
  const executable = Buffer.from('MZ-real-file-fixture');
  await mkdir(path.dirname(executablePath), { recursive: true });
  await writeFile(executablePath, executable);
  files.push({
    path: path.relative(runtimeRoot, executablePath).split(path.sep).join('/'),
    bytes: executable.length,
    sha256: createHash('sha256').update(executable).digest('hex')
  });
  await writeFile(path.join(runtimeRoot, 'runtime-manifest.json'), `${JSON.stringify({ schemaVersion: 1, packages, files }, null, 2)}\n`, 'utf8');
  return { runtimeRoot, openAiRoot, executablePath };
}

async function withFixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'orquesta-packaged-runtime-'));
  try {
    const fixture = await writeRuntimeFixture(root);
    await run({ resourcesRoot: root, ...fixture });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('accepts only the exact packaged Codex runtime', async () => {
  await withFixture(async ({ resourcesRoot, executablePath }) => {
    assert.deepEqual(await verifyPackagedRuntime(resourcesRoot), {
      integrity: 'verified',
      packageDirectories: packages.map((pkg) => pkg.directory),
      executablePath,
      filesVerified: 4
    });
  });
});

test('rejects a missing package metadata file', async () => {
  await withFixture(async ({ resourcesRoot, openAiRoot }) => {
    await rm(path.join(openAiRoot, 'codex-sdk', 'package.json'));
    await assert.rejects(verifyPackagedRuntime(resourcesRoot), /codex-sdk.*package\.json|integrity/i);
  });
});

test('rejects an extra package directory under @openai', async () => {
  await withFixture(async ({ resourcesRoot, openAiRoot }) => {
    await mkdir(path.join(openAiRoot, 'unexpected-package'));
    await assert.rejects(verifyPackagedRuntime(resourcesRoot), /unexpected-package|exactly/i);
  });
});

test('rejects a non-regular codex.exe', async () => {
  await withFixture(async ({ resourcesRoot, executablePath }) => {
    await rm(executablePath);
    await mkdir(executablePath);
    await assert.rejects(verifyPackagedRuntime(resourcesRoot), /regular file|integrity/i);
  });
});
