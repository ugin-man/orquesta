import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(appRoot, '../..');
const documents = {
  readme: path.join(appRoot, 'README.md'),
  validation: path.join(appRoot, 'VALIDATION.md'),
  runtime: path.join(appRoot, 'docs', 'validation', 'codex-runtime.md'),
  integration: path.join(appRoot, 'docs', 'validation', 'v4-desktop-integration.md')
};

const entries = await Promise.all(Object.entries(documents).map(async ([name, filePath]) => [name, await readFile(filePath, 'utf8')]));
const text = Object.fromEntries(entries);
const desktopPackage = JSON.parse(await readFile(path.join(appRoot, 'package.json'), 'utf8'));
const rootPackage = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));

for (const script of ['check', 'make:win', 'verify:packaged-runtime', 'test:packaged-runtime', 'test:interaction-retention', 'test:desktop-smoke', 'validate:lockfile']) {
  assert.equal(typeof desktopPackage.scripts?.[script], 'string', `Missing desktop script ${script}`);
}
for (const script of ['check:v4:phase1', 'check:v4:phase15', 'check:v4:phase2']) {
  assert.equal(typeof rootPackage.scripts?.[script], 'string', `Missing root script ${script}`);
}

for (const required of [
  '@openai/codex-sdk@0.144.5',
  '@openai/codex@0.144.5',
  '@openai/codex-win32-x64@0.144.5-win32-x64',
  'out/make/squirrel.windows/x64/OrquestaSetup.exe',
  'out/make/zip/win32/x64/Orquesta-win32-x64-0.1.0.zip',
  'コード署名していません'
]) assert.match(text.readme, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `README missing ${required}`);

assert.doesNotMatch(text.readme, /Codex Desktopまたはstandalone Codex CLI/);
assert.doesNotMatch(text.runtime, /discovers an existing Codex runtime/i);
assert.doesNotMatch(text.runtime, /approval policy `never`/i);
assert.match(text.runtime, /bundled/i);
assert.match(text.runtime, /normal.*approval/i);
assert.match(text.runtime, /real packaged runtime/i);

for (const command of [
  'npm run check:v4:phase1',
  'npm run check:v4:phase15',
  'npm run check:v4:phase2',
  'npm run check --prefix apps/orquesta-desktop',
  'npm run test:desktop-smoke --prefix apps/orquesta-desktop',
  'npm run verify:packaged-runtime --prefix apps/orquesta-desktop',
  'npm run test:packaged-runtime --prefix apps/orquesta-desktop',
  'npm run test:interaction-retention --prefix apps/orquesta-desktop'
]) assert.ok(text.validation.includes(command), `VALIDATION missing ${command}`);

for (const evidenceClass of ['Deterministic', 'Browser', 'Electron', 'Fake runtime', 'Real packaged runtime']) {
  assert.ok(text.integration.includes(evidenceClass), `Integration evidence matrix missing ${evidenceClass}`);
}
for (const requirement of [
  'one-runtime architecture',
  'project switching',
  'approval relay',
  'conversation history',
  'V4 Operations',
  'repository-only fallback',
  'package footprint',
  'memory gates',
  'code signing'
]) assert.ok(text.integration.toLowerCase().includes(requirement.toLowerCase()), `Integration review missing ${requirement}`);

for (const fileName of [
  'desktop-foundation.md',
  'desktop-interaction-retention.md',
  'desktop-leak.md',
  'packaged-runtime.md',
  'repository-integration.md',
  'codex-runtime.md'
]) await access(path.join(appRoot, 'docs', 'validation', fileName));

for (const [name, documentText] of Object.entries(text)) {
  for (const match of documentText.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1].split('#', 1)[0];
    if (!target || /^(?:https?:|mailto:)/i.test(target)) continue;
    const resolved = path.resolve(path.dirname(documents[name]), decodeURIComponent(target));
    await access(resolved);
  }
}

console.log('desktop documentation contract tests passed');
