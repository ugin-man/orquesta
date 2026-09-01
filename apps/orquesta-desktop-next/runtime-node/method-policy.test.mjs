import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadPackagedMethodPolicy } from './method-policy.mjs';

const canonicalPolicyPath = fileURLToPath(new URL(
  '../../../packages/contracts/desktop/runtime-method-policy.v1.json',
  import.meta.url,
));
const canonicalBytes = readFileSync(canonicalPolicyPath);
const canonicalPolicy = JSON.parse(canonicalBytes.toString('utf8'));

function withPackagedPolicy(contents, operation) {
  const directory = mkdtempSync(path.join(tmpdir(), 'orquesta-method-policy-'));
  const policyPath = path.join(directory, 'runtime-method-policy.v1.json');
  try {
    writeFileSync(policyPath, contents);
    return operation(policyPath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('production loader returns the exact packaged bytes and a detached frozen policy', () => {
  withPackagedPolicy(canonicalBytes, (policyPath) => {
    const loaded = loadPackagedMethodPolicy(policyPath);
    assert.deepEqual(loaded.bytes, canonicalBytes);
    assert.equal(Object.isFrozen(loaded), true);
    assert.equal(Object.isFrozen(loaded.policy), true);
    assert.equal(Object.isFrozen(loaded.policy.methods), true);
    for (const entry of Object.values(loaded.policy.methods)) assert.equal(Object.isFrozen(entry), true);
    assert.equal(loaded.policy.methods['runtime.send'].recoveryStrategy, 'dispatch_outbox');
    assert.equal(loaded.policy.methods['runtime.turn.interrupt'].recoveryStrategy, 'exact_turn_interrupt');
    assert.equal(loaded.policy.methods['runtime.approval.respond'].recoveryStrategy, 'native_exact_approval');
  });
});

test('production loader rejects malformed and structurally invalid packaged policies', () => {
  const mutate = (operation) => {
    const policy = structuredClone(canonicalPolicy);
    operation(policy);
    return Buffer.from(JSON.stringify(policy));
  };
  for (const [label, contents, expected] of [
    ['malformed JSON', Buffer.from('{'), /runtime_method_policy_json_invalid/u],
    ['unknown root field', mutate((policy) => { policy.rogue = true; }), /runtime_method_policy_shape_invalid/u],
    ['empty response type', mutate((policy) => { policy.methods['runtime.info'].responseType = '   '; }), /runtime_method_policy_response_invalid/u],
    ['runtime.send mutation', mutate((policy) => { policy.methods['runtime.send'].responseType = 'runtime.dispatch.changed'; }), /runtime_send_must_be_typed_native_dispatch/u],
  ]) {
    assert.throws(
      () => withPackagedPolicy(contents, (policyPath) => loadPackagedMethodPolicy(policyPath)),
      expected,
      label,
    );
  }
});
