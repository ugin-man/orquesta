import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

test('session binding consumes the CommonJS execution-kernel foundation authority through its real ESM default', async () => {
  const executionKernelNamespace = await import('@orquesta/execution-kernel');
  const executionKernelRequire = require('@orquesta/execution-kernel');
  assert.equal(executionKernelNamespace.FOUNDATION_AGENT_IDS, undefined);
  assert.deepEqual(
    [...executionKernelNamespace.default.FOUNDATION_AGENT_IDS],
    [...executionKernelRequire.FOUNDATION_AGENT_IDS]
  );
  const source = await readFile(new URL('../src/core/session-binding-store.ts', import.meta.url), 'utf8');
  assert.match(source, /import executionKernel from '@orquesta\/execution-kernel'/u);
  assert.doesNotMatch(source, /import \{ FOUNDATION_AGENT_IDS \}/u);
});
