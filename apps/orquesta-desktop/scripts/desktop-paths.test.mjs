import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveDesktopPaths } from './desktop-paths.mjs';

const appRoot = path.resolve('C:\\repo\\apps\\orquesta-desktop');
const paths = resolveDesktopPaths(appRoot);

assert.equal(paths.appRoot, appRoot);
assert.equal(paths.rendererDist, path.join(appRoot, 'dist'));
assert.equal(paths.electronDist, path.join(appRoot, 'dist-electron'));
assert.equal(paths.contractSchemasSource, path.resolve(appRoot, '..', '..', 'packages', 'contracts', 'schemas'));
assert.equal(paths.contractSchemasDist, path.join(appRoot, 'schemas'));
assert.equal(paths.mainEntry, path.join(appRoot, 'electron', 'main', 'index.ts'));
assert.equal(paths.preloadEntry, path.join(appRoot, 'electron', 'preload', 'index.ts'));
assert.equal(paths.coreEntry, path.join(appRoot, 'electron', 'core', 'index.ts'));
assert.equal(paths.e2eCoreEntry, path.join(appRoot, 'electron', 'core', 'e2e-index.ts'));

console.log('desktop path tests passed');
