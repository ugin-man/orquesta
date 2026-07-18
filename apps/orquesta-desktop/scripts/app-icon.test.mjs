import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const icon = await readFile(path.join(appRoot, 'assets', 'orquesta.ico'));
assert.deepEqual([...icon.subarray(0, 6)], [0, 0, 1, 0, 1, 0]);
assert.deepEqual([...icon.subarray(22, 30)], [137, 80, 78, 71, 13, 10, 26, 10]);
assert.ok(icon.length > 1_000, 'icon should contain a non-empty PNG image');
console.log('desktop app icon tests passed');
