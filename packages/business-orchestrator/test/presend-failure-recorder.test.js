"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { canonicalHash } = require("@orquesta/contracts");
const {
  V2_EFFECT_IDENTITY_FIELDS,
  deriveEffectOperationScopeHashV2,
} = require("../src/lifecycle");
const {
  PRESEND_FAILURE_RECORDER_CAPABILITIES,
  createPresendFailureObservationFactsResolver,
  createPresendFailureRecorder,
} = require("../src/presend-failure-recorder");
const {
  createRecordedFakePosixTestAdapter,
} = require("./support/recorded-fake-platform-adapter");
const {
  createPresendFailureStorePosixAdapter,
} = require("../src/posix-platform-adapters");

function hash(label) {
  return crypto.createHash("sha256").update(label, "utf8").digest("hex");
}

function identifier(prefix, value) {
  return `${prefix}-${canonicalHash(value).slice(0, 32)}`;
}

function effectSeed(effect) {
  return Object.fromEntries(V2_EFFECT_IDENTITY_FIELDS
    .filter((field) => !["effect_id", "idempotency_key", "created_at"].includes(field))
    .map((field) => [field, effect[field]]));
}

function effectFor(label = "one") {
  const packet = {
    id: `dispatch-packet:${hash(`packet:${label}`)}`,
    hash: hash(`packet:${label}`),
  };
  const base = {
    effect_contract_version: 2,
    work_order_id: `WO-${hash(`work-order:${label}`).slice(0, 32)}`,
    branch_ref: `branch-${label}`,
    attempt: 1,
    dispatch_id: identifier("DSP", {
      work_order_id: `WO-${hash(`work-order:${label}`).slice(0, 32)}`,
      branch_ref: `branch-${label}`,
      attempt: 1,
      packet_ref: packet,
    }),
    effect_kind: "provider.thread.create",
    origin_source_id: `source-${label}`,
    operation_scope_hash: deriveEffectOperationScopeHashV2({
      effect_kind: "provider.thread.create",
      provider_ref: "recorded-fake-provider",
      packet_ref: packet.id,
      packet_hash: packet.hash,
      predecessor_effect_id: null,
      predecessor_delivery_hash: null,
      target_runtime_identity: null,
    }),
    operation_generation: 1,
    generation_predecessor_effect_id: null,
    provider_ref: "recorded-fake-provider",
    packet_ref: packet.id,
    packet_hash: packet.hash,
    predecessor_effect_id: null,
    predecessor_delivery_hash: null,
    target_runtime_identity: null,
  };
  const seed = effectSeed(base);
  return {
    effect_id: identifier("FX", seed),
    ...base,
    idempotency_key: identifier("IDEM", seed),
    created_at: "2026-08-10T01:00:00.000Z",
  };
}

function inputFor(label = "one", source = "packet_store") {
  const effect = effectFor(label);
  const token = {
    lease_id: `lease-${label}`,
    owner_id: `worker-${label}`,
    generation: 1,
  };
  return {
    recorder_contract_version: 1,
    presend_failure_id: identifier("PSF", {
      reactor_contract_version: 1,
      effect_id: effect.effect_id,
      claimed_fencing_token: token,
      failure_source: source,
    }),
    effect_identity: effect,
    claimed_fencing_token: token,
    failure_source: source,
  };
}

const REASONS = {
  packet_store: "packet_integrity_failed",
  authority: "authority_failed",
  driver_capability: "driver_capability_failed",
};

async function fixture(t, overrides = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "orquesta-presend-recorder-"));
  t.after(async () => fsp.rm(root, { recursive: true, force: true }));
  const calls = [];
  const sourceVerifiers = Object.fromEntries(Object.keys(REASONS).map((source) => [
    source,
    async (request) => {
      calls.push({ source, request });
      if (overrides[source]) return overrides[source](request);
      return {
        verification_contract_version: 1,
        verification_status: "verified_failure",
        failure_source: source,
        failure_reason: REASONS[source],
        binding_hash: canonicalHash(request),
        evidence_refs: [`PFE-${canonicalHash({ source, request }).slice(0, 32)}`],
      };
    },
  ]));
  const recorder = createPresendFailureRecorder({
    root_path: root,
    platform_adapter: createRecordedFakePosixTestAdapter(),
    source_verifiers: sourceVerifiers,
    allow_test_only_platform_adapter: true,
  });
  return { root, calls, recorder };
}

test("records and resolves one source-verified content-addressed pre-send failure", async (t) => {
  const { calls, recorder } = await fixture(t);
  assert.deepEqual(recorder.capabilities(), PRESEND_FAILURE_RECORDER_CAPABILITIES);

  const input = inputFor();
  const result = await recorder.recordVerifiedFailure(input);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].source, "packet_store");
  assert.deepEqual(calls[0].request.effect_identity, input.effect_identity);
  assert.equal(result.failure_record.failure_reason, "packet_integrity_failed");
  assert.equal(result.failure_record.failure_source, "packet_store");
  assert.equal(result.failure_record_ref.id, `PFR-${result.failure_record_ref.hash.slice(0, 32)}`);
  assert.equal(result.failure_record_ref.hash, canonicalHash(result.failure_record));
  assert.deepEqual(result.presend_failure_attestation, {
    effect_id: input.effect_identity.effect_id,
    idempotency_key: input.effect_identity.idempotency_key,
    provider_ref: input.effect_identity.provider_ref,
    claimed_fencing_token: input.claimed_fencing_token,
    failure_reason: "packet_integrity_failed",
    failure_record_ref: result.failure_record_ref,
    evidence_refs: result.failure_record.evidence_refs,
  });
  assert.deepEqual(
    await recorder.readVerifiedFailure({ failure_record_ref: result.failure_record_ref }),
    result,
  );
});

test("presend_failure_id is the idempotency authority and retry does not rerun the verifier", async (t) => {
  let available = true;
  const { calls, recorder } = await fixture(t, {
    packet_store: async (request) => {
      if (!available) throw Object.assign(new Error("verifier is offline"), { code: "EOFFLINE" });
      return {
        verification_contract_version: 1,
        verification_status: "verified_failure",
        failure_source: "packet_store",
        failure_reason: "packet_integrity_failed",
        binding_hash: canonicalHash(request),
        evidence_refs: [`PFE-${hash("stable-evidence").slice(0, 32)}`],
      };
    },
  });
  const input = inputFor();
  const first = await recorder.recordVerifiedFailure(input);
  available = false;
  const replay = await recorder.recordVerifiedFailure(input);
  assert.deepEqual(replay, first);
  assert.equal(calls.length, 1);
});

test("the same presend_failure_id cannot be rebound to another Effect or token", async (t) => {
  const { recorder } = await fixture(t);
  const first = inputFor("one");
  await recorder.recordVerifiedFailure(first);

  const wrongEffect = { ...inputFor("two"), presend_failure_id: first.presend_failure_id };
  await assert.rejects(
    recorder.recordVerifiedFailure(wrongEffect),
    { code: "BUSINESS_PRESEND_FAILURE_EFFECT_BINDING" },
  );
  await assert.rejects(
    recorder.recordVerifiedFailure({
      ...first,
      claimed_fencing_token: { ...first.claimed_fencing_token, generation: 2 },
    }),
    { code: "BUSINESS_PRESEND_FAILURE_EFFECT_BINDING" },
  );
});

test("each source is verified by only its configured verifier and maps to one fixed reason", async (t) => {
  const { calls, recorder } = await fixture(t);
  for (const source of Object.keys(REASONS)) {
    const result = await recorder.recordVerifiedFailure(inputFor(source, source));
    assert.equal(result.failure_record.failure_source, source);
    assert.equal(result.failure_record.failure_reason, REASONS[source]);
  }
  assert.deepEqual(calls.map((entry) => entry.source), Object.keys(REASONS));
});

test("a verifier cannot inject another source, reason, binding, or empty evidence", async (t) => {
  const mutations = [
    (result) => { result.failure_source = "authority"; },
    (result) => { result.failure_reason = "authority_failed"; },
    (result) => { result.binding_hash = hash("wrong-binding"); },
    (result) => { result.evidence_refs = []; },
    (result) => { result.disposition = "automatic_retry"; },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const { recorder } = await fixture(t, {
      packet_store: async (request) => {
        const result = {
          verification_contract_version: 1,
          verification_status: "verified_failure",
          failure_source: "packet_store",
          failure_reason: "packet_integrity_failed",
          binding_hash: canonicalHash(request),
          evidence_refs: [`PFE-${hash(`evidence:${index}`).slice(0, 32)}`],
        };
        mutate(result);
        return result;
      },
    });
    await assert.rejects(
      recorder.recordVerifiedFailure(inputFor(`hostile-${index}`)),
      { code: /BUSINESS_PRESEND_FAILURE_(VERIFICATION|RECORD)_INVALID/u },
    );
  }
});

test("durable evidence references use the exact downstream observation contract", async (t) => {
  for (const [index, invalidEvidenceRef] of [
    "contains space",
    `PFE-${"a".repeat(253)}`,
    " padded-reference",
    "PFE-non-ascii-évidence",
  ].entries()) {
    let evidenceRef = invalidEvidenceRef;
    const { calls, recorder } = await fixture(t, {
      packet_store: async (request) => ({
        verification_contract_version: 1,
        verification_status: "verified_failure",
        failure_source: "packet_store",
        failure_reason: "packet_integrity_failed",
        binding_hash: canonicalHash(request),
        evidence_refs: [evidenceRef],
      }),
    });
    const input = inputFor(`portable-evidence-${index}`);
    await assert.rejects(
      recorder.recordVerifiedFailure(input),
      { code: "BUSINESS_PRESEND_FAILURE_RECORD_INVALID" },
      invalidEvidenceRef,
    );

    // Reusing the same id must remain possible because invalid downstream
    // evidence never crossed the durable publication boundary.
    evidenceRef = `PFE-${hash(`portable-evidence-${index}`).slice(0, 32)}`;
    const recorded = await recorder.recordVerifiedFailure(input);
    assert.deepEqual(recorded.failure_record.evidence_refs, [evidenceRef]);
    assert.equal(calls.length, 2);

    const resolver = createPresendFailureObservationFactsResolver({
      recorder,
      delegate: {
        async resolveObservationFacts() {
          return { provider_ref: input.effect_identity.provider_ref };
        },
      },
    });
    const facts = await resolver.resolveObservationFacts({
      observation: {
        name: "provider.effect.presend_failure.recorded",
        payload: {
          claimed_fencing_token: input.claimed_fencing_token,
          failure_reason: recorded.failure_record.failure_reason,
          failure_record_ref: recorded.failure_record_ref,
        },
      },
      presend_failure_effect: input.effect_identity,
    });
    assert.deepEqual(facts.observation_evidence_refs, [evidenceRef]);
  }
});

test("an invalid self-consistent Effect identity is rejected before source verification", async (t) => {
  const { calls, recorder } = await fixture(t);
  const input = inputFor();
  input.effect_identity = {
    ...input.effect_identity,
    provider_ref: "forged-provider",
  };
  await assert.rejects(
    recorder.recordVerifiedFailure(input),
    { code: "BUSINESS_PRESEND_FAILURE_EFFECT_BINDING" },
  );
  assert.equal(calls.length, 0);
});

test("a missing content-address alias is forward-recovered from the id record", async (t) => {
  const { root, calls, recorder } = await fixture(t);
  const input = inputFor();
  const result = await recorder.recordVerifiedFailure(input);
  const alias = (await fsp.readdir(root)).find((name) => name.startsWith("presend-failure-ref-"));
  assert.ok(alias);
  await fsp.unlink(path.join(root, alias));

  const replay = await recorder.recordVerifiedFailure(input);
  assert.deepEqual(replay, result);
  assert.equal(calls.length, 1);
  assert.ok((await fsp.readdir(root)).some((name) => name === alias));
});

test("tampered record and alias bytes fail closed", async (t) => {
  const recordFixture = await fixture(t);
  const input = inputFor("record-tamper");
  const result = await recordFixture.recorder.recordVerifiedFailure(input);
  const recordName = (await fsp.readdir(recordFixture.root))
    .find((name) => name.startsWith("presend-failure-id-"));
  await fsp.writeFile(path.join(recordFixture.root, recordName), "{}\n", { mode: 0o600 });
  await assert.rejects(
    recordFixture.recorder.readVerifiedFailure({ failure_record_ref: result.failure_record_ref }),
    { code: /BUSINESS_PRESEND_FAILURE_(RECORD_INVALID|CONFLICT)/u },
  );

  const aliasFixture = await fixture(t);
  const aliasInput = inputFor("alias-tamper");
  const aliasResult = await aliasFixture.recorder.recordVerifiedFailure(aliasInput);
  const aliasName = (await fsp.readdir(aliasFixture.root))
    .find((name) => name.startsWith("presend-failure-ref-"));
  await fsp.writeFile(path.join(aliasFixture.root, aliasName), "{}\n", { mode: 0o600 });
  await assert.rejects(
    aliasFixture.recorder.readVerifiedFailure({ failure_record_ref: aliasResult.failure_record_ref }),
    { code: "BUSINESS_PRESEND_FAILURE_RECORD_INVALID" },
  );
});

test("single-process test storage is explicit and the production boundary stays fail closed", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "orquesta-presend-proof-"));
  t.after(async () => fsp.rm(root, { recursive: true, force: true }));
  const verifier = async (request) => ({
    verification_contract_version: 1,
    verification_status: "verified_failure",
    failure_source: request.failure_source,
    failure_reason: REASONS[request.failure_source],
    binding_hash: canonicalHash(request),
    evidence_refs: [`PFE-${hash("test-proof").slice(0, 32)}`],
  });
  const recorder = createPresendFailureRecorder({
    root_path: root,
    platform_adapter: createRecordedFakePosixTestAdapter(),
    source_verifiers: {
      packet_store: verifier,
      authority: verifier,
      driver_capability: verifier,
    },
  });
  await assert.rejects(
    recorder.recordVerifiedFailure(inputFor()),
    { code: "BUSINESS_PRESEND_FAILURE_SECURITY_UNVERIFIED" },
  );
});

test("concurrent identical requests converge to one durable id/ref binding", async (t) => {
  const { root, recorder } = await fixture(t);
  const input = inputFor("concurrent");
  const results = await Promise.all(Array.from({ length: 8 }, () => (
    recorder.recordVerifiedFailure(input)
  )));
  for (const result of results) assert.deepEqual(result, results[0]);
  const names = await fsp.readdir(root);
  assert.equal(names.filter((name) => name.startsWith("presend-failure-id-")).length, 1);
  assert.equal(names.filter((name) => name.startsWith("presend-failure-ref-")).length, 1);
});

test("the production POSIX facade persists and reopens the exact recorder evidence", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "orquesta-presend-production-"));
  await fsp.chmod(root, 0o700);
  t.after(async () => fsp.rm(root, { recursive: true, force: true }));
  const sourceVerifiers = Object.fromEntries(Object.keys(REASONS).map((source) => [
    source,
    async (request) => ({
      verification_contract_version: 1,
      verification_status: "verified_failure",
      failure_source: source,
      failure_reason: REASONS[source],
      binding_hash: canonicalHash(request),
      evidence_refs: [`PFE-${canonicalHash({ source, request }).slice(0, 32)}`],
    }),
  ]));
  const options = {
    root_path: root,
    platform_adapter: createPresendFailureStorePosixAdapter(),
    source_verifiers: sourceVerifiers,
  };
  const first = createPresendFailureRecorder(options);
  const input = inputFor("production");
  const recorded = await first.recordVerifiedFailure(input);

  const reopened = createPresendFailureRecorder({
    ...options,
    platform_adapter: createPresendFailureStorePosixAdapter(),
  });
  assert.deepEqual(
    await reopened.readVerifiedFailure({ failure_record_ref: recorded.failure_record_ref }),
    recorded,
  );
  const names = (await fsp.readdir(root)).sort();
  assert.equal(names.length, 2);
  assert.ok(names.every((name) => /^presend-failure-(?:id|ref)-[a-f0-9]{64}\.json$/u.test(name)));
  for (const name of names) {
    assert.equal((await fsp.stat(path.join(root, name))).mode & 0o777, 0o600);
  }
});

test("source verification is bounded and actively aborts the dependency signal", async (t) => {
  let dependencySignal = null;
  const { root } = await fixture(t);
  const hanging = async (_request, options) => {
    dependencySignal = options.signal;
    return new Promise(() => {});
  };
  const recorder = createPresendFailureRecorder({
    root_path: root,
    platform_adapter: createRecordedFakePosixTestAdapter(),
    source_verifiers: {
      packet_store: hanging,
      authority: hanging,
      driver_capability: hanging,
    },
    allow_test_only_platform_adapter: true,
    dependency_timeout_ms: 10,
  });
  await assert.rejects(
    recorder.recordVerifiedFailure(inputFor("timeout")),
    { code: "BUSINESS_PRESEND_FAILURE_DEPENDENCY_TIMEOUT" },
  );
  assert.equal(dependencySignal.aborted, true);
  assert.deepEqual(await fsp.readdir(root), []);
});

test("caller cancellation reaches the verifier and prevents a pre-commit write", async (t) => {
  const controller = new AbortController();
  let dependencySignal = null;
  const { root } = await fixture(t);
  const hanging = async (_request, options) => {
    dependencySignal = options.signal;
    return new Promise(() => {});
  };
  const recorder = createPresendFailureRecorder({
    root_path: root,
    platform_adapter: createRecordedFakePosixTestAdapter(),
    source_verifiers: {
      packet_store: hanging,
      authority: hanging,
      driver_capability: hanging,
    },
    allow_test_only_platform_adapter: true,
  });
  const pending = recorder.recordVerifiedFailure(inputFor("abort"), {
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(pending, { code: "BUSINESS_PRESEND_FAILURE_ABORTED" });
  assert.equal(dependencySignal.aborted, true);
  assert.deepEqual(await fsp.readdir(root), []);
});

test("the facts resolver reads the same durable record instead of trusting envelope facts", async (t) => {
  const { recorder } = await fixture(t);
  const input = inputFor("facts");
  const recorded = await recorder.recordVerifiedFailure(input);
  const delegateCalls = [];
  const resolver = createPresendFailureObservationFactsResolver({
    recorder,
    delegate: {
      async resolveObservationFacts(args) {
        delegateCalls.push(args);
        return {
          provider_ref: input.effect_identity.provider_ref,
          observation_evidence_refs: ["caller-controlled-evidence"],
        };
      },
    },
  });
  const args = {
    observation: {
      name: "provider.effect.presend_failure.recorded",
      payload: {
        claimed_fencing_token: input.claimed_fencing_token,
        failure_reason: recorded.failure_record.failure_reason,
        failure_record_ref: recorded.failure_record_ref,
      },
    },
    presend_failure_effect: input.effect_identity,
    signal: new AbortController().signal,
  };
  const facts = await resolver.resolveObservationFacts(args);
  assert.equal(delegateCalls.length, 1);
  assert.deepEqual(facts.observation_evidence_refs, recorded.failure_record.evidence_refs);
  assert.deepEqual(
    facts.presend_failure_attestation,
    recorded.presend_failure_attestation,
  );
});

test("the facts resolver rejects delegate ownership and observation/effect rebinding", async (t) => {
  const { recorder } = await fixture(t);
  const input = inputFor("facts-hostile");
  const recorded = await recorder.recordVerifiedFailure(input);
  const observation = {
    name: "provider.effect.presend_failure.recorded",
    payload: {
      claimed_fencing_token: input.claimed_fencing_token,
      failure_reason: recorded.failure_record.failure_reason,
      failure_record_ref: recorded.failure_record_ref,
    },
  };
  const conflict = createPresendFailureObservationFactsResolver({
    recorder,
    delegate: {
      async resolveObservationFacts() {
        return { presend_failure_attestation: recorded.presend_failure_attestation };
      },
    },
  });
  await assert.rejects(
    conflict.resolveObservationFacts({
      observation,
      presend_failure_effect: input.effect_identity,
    }),
    { code: "BUSINESS_PRESEND_FAILURE_FACT_OWNERSHIP_CONFLICT" },
  );

  const resolver = createPresendFailureObservationFactsResolver({
    recorder,
    delegate: { async resolveObservationFacts() { return {}; } },
  });
  await assert.rejects(
    resolver.resolveObservationFacts({
      observation,
      presend_failure_effect: effectFor("another-effect"),
    }),
    { code: "BUSINESS_PRESEND_FAILURE_FACT_BINDING_MISMATCH" },
  );
});

test("the facts resolver is transparent for unrelated observations", async (t) => {
  const { recorder } = await fixture(t);
  const expected = Object.freeze({ provider_ref: "provider:one", observation_evidence_refs: [] });
  const resolver = createPresendFailureObservationFactsResolver({
    recorder,
    delegate: { async resolveObservationFacts() { return expected; } },
  });
  assert.equal(
    await resolver.resolveObservationFacts({ observation: { name: "branch.timed_out" } }),
    expected,
  );
});
