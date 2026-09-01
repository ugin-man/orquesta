import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'sidecar-entry.ts'), 'utf8');

// These tests guard production-entry wiring only. They are not protocol
// behavior evidence; framed I/O and contained-process behavior belong to the
// Native runtime integration/live gate.
test('source guard keeps frame bounds and method-policy gates wired into the sidecar entry', () => {
  assert.match(source, /MAX_FRAME_BYTES = 4 \* 1024 \* 1024/u);
  assert.match(source, /recoveryStrategy === 'internal_unavailable'/u);
  assert.match(source, /runtime_method_unknown/u);
  assert.match(source, /Object\.hasOwn\(policy\.methods, request\.method\)/u);
  assert.match(source, /policyDigestSha256/u);
  assert.match(source, /BUSINESS_DESKTOP_READ_FEATURES/u);
  assert.match(source, /businessWorkOrdersCapability/u);
});

test('source guard keeps structured terminal-proof fields wired without message parsing', () => {
  assert.match(source, /details\?\.terminalOutcome === 'failed'/u);
  assert.match(source, /details\.messageId/u);
  assert.match(source, /details\.actionFingerprint/u);
  assert.doesNotMatch(source, /reason\.startsWith|CORE_REQUEST_FAILED/u);
});

test('source guard keeps explicit Core outcome knowledge wired at the Native boundary', () => {
  assert.match(source, /typeof event\.outcomeUnknown === 'boolean'/u);
  assert.match(source, /\? event\.outcomeUnknown/u);
  assert.match(source, /: terminal \? false : event\.retryable !== true/u);
});

test('source guard keeps supported Windows extended-prefix normalization wired', () => {
  assert.match(source, /rootPath\.startsWith\('\\\\\\\\\?\\\\UNC\\\\'\)/u);
  assert.match(source, /rootPath\.slice\(8\)/u);
  assert.match(source, /rootPath\.slice\(4\)/u);
});
