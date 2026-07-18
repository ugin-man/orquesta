import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { pruneElectronLocales } = require('./package-locales.cjs');
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'orquesta-locales-'));
const locales = path.join(temporaryRoot, 'locales');

try {
  await mkdir(locales);
  await Promise.all([
    writeFile(path.join(locales, 'en-US.pak'), 'en'),
    writeFile(path.join(locales, 'ja.pak'), 'ja'),
    writeFile(path.join(locales, 'fr.pak'), 'fr')
  ]);

  await pruneElectronLocales(temporaryRoot);
  assert.deepEqual((await readdir(locales)).sort(), ['en-US.pak', 'ja.pak']);
  console.log('desktop locale package tests passed');
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}
