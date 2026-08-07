import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(appRoot, '../..');

const files = [
  path.join(repositoryRoot, 'README.md'),
  path.join(repositoryRoot, 'START_HERE.md'),
  path.join(appRoot, 'README.md')
];

const documents = await Promise.all(files.map((file) => readFile(file, 'utf8')));
const combined = documents.join('\n');

for (const forbidden of [
  /Phase\s*\d/i,
  /Build Week/i,
  /release candidate/i,
  /internal review/i,
  /acceptance evidence/i,
  /historical evidence/i,
  /implementation plan/i,
  /handoff design/i
]) {
  assert.doesNotMatch(combined, forbidden, `Public documentation contains internal development language: ${forbidden}`);
}

assert.match(documents[0], /GitHub Releases/);
assert.match(documents[0], /0\.4\.0-preview\.1/);
assert.match(documents[1], /Download/);
assert.match(documents[2], /Windows/);

console.log('public documentation contract tests passed');
