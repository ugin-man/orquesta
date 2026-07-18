import assert from 'node:assert/strict';
import { isApprovedResolvedUrl } from './lockfile-policy.mjs';

assert.equal(isApprovedResolvedUrl('https://registry.npmjs.org/react/-/react-19.0.0.tgz'), true);
assert.equal(isApprovedResolvedUrl('git+ssh://git@github.com/electron/node-gyp.git#06b29aafb7708acef8b3669835c8a7857ebc92d2'), true);
assert.equal(isApprovedResolvedUrl('../../packages/codex-adapter'), true);
assert.equal(isApprovedResolvedUrl('../../packages/other-package'), false);
assert.equal(isApprovedResolvedUrl('../../../packages/codex-adapter'), false);
assert.equal(isApprovedResolvedUrl('git+ssh://git@github.com/electron/node-gyp.git#main'), false);
assert.equal(isApprovedResolvedUrl('https://packages.example.internal/package.tgz'), false);

console.log('lockfile source policy tests passed');
