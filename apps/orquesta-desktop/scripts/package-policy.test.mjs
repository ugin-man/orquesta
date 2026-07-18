import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createPackageIgnore } = require('./package-policy.cjs');
const root = path.resolve('C:/workspace/orquesta-desktop');
const ignore = createPackageIgnore(root);

assert.equal(ignore(root), false);
assert.equal(ignore(path.join(root, 'package.json')), false);
assert.equal(ignore(path.join(root, 'dist', 'index.html')), false);
assert.equal(ignore(path.join(root, 'dist-electron', 'main.cjs')), false);
assert.equal(ignore(path.join(root, 'dist-electron', 'core-e2e.cjs')), true);
assert.equal(ignore(path.join(root, 'dist-electron', 'core-e2e.cjs.map')), true);
assert.equal(ignore(path.join(root, 'node_modules', 'electron', 'index.js')), true);
assert.equal(ignore(path.join(root, 'src', 'main.tsx')), true);
assert.equal(ignore(path.join(root, 'dist-diagnostic', 'index.html')), true);
assert.equal(ignore(path.join(root, 'tests', 'electron', 'desktop-shell.spec.ts')), true);
assert.equal(ignore('C:/Temp/electron-packager/resources/app/package.json'), false);
assert.equal(ignore('C:/Temp/electron-packager/resources/app/dist/index.html'), false);
assert.equal(ignore('C:/Temp/electron-packager/resources/app/dist-electron/main.cjs'), false);
assert.equal(ignore('C:/Temp/electron-packager/resources/app/node_modules/react/index.js'), true);

console.log('desktop package policy tests passed');
