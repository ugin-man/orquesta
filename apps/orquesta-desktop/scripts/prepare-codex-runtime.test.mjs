import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { prepareCodexRuntime } from './prepare-codex-runtime.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDirectory, '..');
const repositoryRoot = path.resolve(desktopRoot, '..', '..');
const require = createRequire(import.meta.url);

const packageFixtures = [
  { directory: 'codex-sdk', name: '@openai/codex-sdk', version: '0.144.5' },
  { directory: 'codex', name: '@openai/codex', version: '0.144.5' },
  { directory: 'codex-win32-x64', name: '@openai/codex', version: '0.144.5-win32-x64' },
  { directory: 'unrelated-package', name: '@openai/unrelated-package', version: '1.0.0' }
];

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'orquesta-runtime-stage-'));
  const appRoot = path.join(root, 'app');
  const stagingRoot = path.join(root, 'stage');
  const packageEntries = {};

  for (const fixture of packageFixtures) {
    const packageRoot = path.join(appRoot, 'node_modules', '@openai', fixture.directory);
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      path.join(packageRoot, 'package.json'),
      `${JSON.stringify({ name: fixture.name, version: fixture.version }, null, 2)}\n`,
      'utf8'
    );
    await writeFile(path.join(packageRoot, 'index.js'), `export const packageName = '${fixture.name}';\n`, 'utf8');
    packageEntries[`node_modules/@openai/${fixture.directory}`] = {
      name: fixture.name,
      version: fixture.version,
      resolved: `https://registry.npmjs.org/${fixture.directory}/-/${fixture.directory}-${fixture.version}.tgz`,
      integrity: `sha512-${fixture.directory}`
    };
  }

  const executable = path.join(
    appRoot,
    'node_modules',
    '@openai',
    'codex-win32-x64',
    'vendor',
    'x86_64-pc-windows-msvc',
    'bin',
    'codex.exe'
  );
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(executable, Buffer.from('fixture-codex-executable'));
  await writeFile(
    path.join(appRoot, 'package-lock.json'),
    `${JSON.stringify({ lockfileVersion: 3, packages: { '': {}, ...packageEntries } }, null, 2)}\n`,
    'utf8'
  );

  return { appRoot, root, stagingRoot };
}

test('copies only the exact pinned Codex runtime packages into a clean staging root', async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { force: true, recursive: true }));

  const staleFile = path.join(fixture.stagingRoot, 'codex-runtime', 'stale.txt');
  await mkdir(path.dirname(staleFile), { recursive: true });
  await writeFile(staleFile, 'stale', 'utf8');

  const sdkRoot = await prepareCodexRuntime(fixture);
  const openAiRoot = path.join(fixture.stagingRoot, 'codex-runtime', 'node_modules', '@openai');

  assert.equal(sdkRoot, path.join(openAiRoot, 'codex-sdk'));
  assert.equal(existsSync(path.join(openAiRoot, 'codex-sdk', 'package.json')), true);
  assert.equal(existsSync(path.join(openAiRoot, 'codex', 'package.json')), true);
  assert.equal(existsSync(path.join(openAiRoot, 'codex-win32-x64', 'package.json')), true);
  assert.equal(existsSync(path.join(openAiRoot, 'unrelated-package')), false);
  assert.equal(existsSync(staleFile), false);
});

test('rejects installed package metadata that does not match the pinned version', async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
  const sdkMetadataPath = path.join(fixture.appRoot, 'node_modules', '@openai', 'codex-sdk', 'package.json');
  const metadata = JSON.parse(await readFile(sdkMetadataPath, 'utf8'));
  metadata.version = '0.144.6';
  await writeFile(sdkMetadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');

  await assert.rejects(() => prepareCodexRuntime(fixture), /version mismatch/i);
});

test('writes a manifest for the three package metadata files and selected codex.exe', async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { force: true, recursive: true }));
  await prepareCodexRuntime(fixture);

  const runtimeRoot = path.join(fixture.stagingRoot, 'codex-runtime');
  const manifest = JSON.parse(await readFile(path.join(runtimeRoot, 'runtime-manifest.json'), 'utf8'));
  assert.deepEqual(manifest.packages, packageFixtures.slice(0, 3));
  assert.deepEqual(manifest.files.map((entry) => entry.path), [
    'node_modules/@openai/codex-sdk/package.json',
    'node_modules/@openai/codex/package.json',
    'node_modules/@openai/codex-win32-x64/package.json',
    'node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe'
  ]);

  for (const entry of manifest.files) {
    const contents = await readFile(path.join(runtimeRoot, ...entry.path.split('/')));
    assert.equal(entry.bytes, contents.byteLength);
    assert.equal(entry.sha256, createHash('sha256').update(contents).digest('hex'));
  }
});

test('stages the runtime only in the Forge packaging workflow', async () => {
  const forgeConfig = require('../forge.config.cjs');
  assert.deepEqual(forgeConfig.packagerConfig.extraResource, [
    path.join(desktopRoot, '.runtime-staging', 'codex-runtime')
  ]);

  const makeSource = await readFile(path.join(scriptDirectory, 'make-desktop.mjs'), 'utf8');
  const stagingCall = makeSource.indexOf('await prepareCodexRuntime(');
  const forgeCall = makeSource.indexOf('await runForgeMake();');
  assert.notEqual(stagingCall, -1);
  assert.ok(stagingCall < forgeCall, 'runtime staging must happen immediately before Forge make');

  for (const buildScript of ['build-desktop.mjs', 'build-renderer.mjs']) {
    const buildSource = await readFile(path.join(scriptDirectory, buildScript), 'utf8');
    assert.equal(buildSource.includes('prepareCodexRuntime'), false);
  }

  const gitignore = await readFile(path.join(repositoryRoot, '.gitignore'), 'utf8');
  assert.equal(gitignore.split(/\r?\n/).includes('.runtime-staging/'), true);

  const desktopPackage = JSON.parse(await readFile(path.join(desktopRoot, 'package.json'), 'utf8'));
  assert.match(desktopPackage.scripts['test:desktop-scripts'], /prepare-codex-runtime\.test\.mjs/);
});
