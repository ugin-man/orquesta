"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { canonicalHash } = require("@orquesta/contracts");
const {
  createBusinessCanonicalReactor,
} = require("../src/canonical-reactor");
const {
  normalizeProviderEntryAuthorizationProofV1,
} = require("../src/provider-entry-window");
const {
  deriveEffectOperationScopeHashV2,
} = require("../src/lifecycle");
const {
  BusinessSendAuthorizationError,
  createCommittedSendAuthorizationProofV2,
  createSendAuthorizationBundleV1,
  deriveCommittedSendAuthorizationHashV2,
  normalizeCommittedSendAuthorizationProofV2,
  normalizeSendAuthorizationBundleV1,
  normalizeSendAuthorizationOperationScopeBindingV2,
} = require("../src/send-authorization");
const {
  createCanonicalReactorStack,
} = require("./support/canonical-reactor-stack");

function ref(id) {
  return { id, hash: canonicalHash({ id }) };
}

function scopeFixture(kind) {
  const threadCreate = kind === "provider.thread.create";
  const userInput = kind === "provider.user_input.submit";
  const binding = {
    effect_kind: kind,
    provider_ref: "provider:scope-fixture",
    packet_ref: `packet:${kind}`,
    packet_hash: canonicalHash({ packet: kind }),
    predecessor_effect_id: threadCreate ? null : `effect:predecessor:${kind}`,
    predecessor_delivery_hash: threadCreate ? null : canonicalHash({ delivery: kind }),
    target_runtime_identity: threadCreate ? null : {
      operation_id: kind === "provider.turn.start" ? null : `operation:${kind}`,
      thread_id: `thread:${kind}`,
      turn_id: kind === "provider.turn.start" ? null : `turn:${kind}`,
    },
    request_id: userInput ? "request:user-input" : null,
    response_ref: userInput ? ref("response:user-input") : null,
  };
  const seed = {
    effect_contract_version: 2,
    work_order_id: `WO-${canonicalHash({ work_order: kind }).slice(0, 32)}`,
    branch_ref: `branch:${kind}`,
    attempt: 1,
    dispatch_id: `DSP-${canonicalHash({ dispatch: kind }).slice(0, 32)}`,
    effect_kind: kind,
    origin_source_id: `source:${kind}`,
    operation_scope_hash: deriveEffectOperationScopeHashV2(binding),
    operation_generation: 1,
    generation_predecessor_effect_id: null,
    provider_ref: binding.provider_ref,
    packet_ref: binding.packet_ref,
    packet_hash: binding.packet_hash,
    predecessor_effect_id: binding.predecessor_effect_id,
    predecessor_delivery_hash: binding.predecessor_delivery_hash,
    target_runtime_identity: binding.target_runtime_identity,
  };
  const hash = canonicalHash(seed);
  return {
    binding,
    effect: {
      effect_id: `FX-${hash.slice(0, 32)}`,
      ...seed,
      idempotency_key: `IDEM-${hash.slice(0, 32)}`,
      created_at: "2026-08-10T00:00:00.000Z",
    },
  };
}

function bundleFixture() {
  const { binding, effect } = scopeFixture("provider.thread.create");
  const payload = {
    work_order_id: effect.work_order_id,
    plan_snapshot_ref: "BPS-send-authorization-fixture",
    plan_hash: canonicalHash({ plan: "send-authorization-fixture" }),
    source_id: "IAC-send-authorization-fixture",
    prior_work_order_revision: 1,
    target_work_order_revision: 1,
    occurred_at: "2026-08-10T00:00:01.000Z",
    effect_id: effect.effect_id,
    effect,
    lease_id: "lease:send-authorization-fixture",
    lease_owner_id: "worker:send-authorization-fixture",
    lease_generation: 1,
    lease_expires_at: "2026-08-10T00:00:31.000Z",
    packet_verification_receipt: { packet_ref: ref("packet:send-authorization-fixture") },
    provider_settlement_cutover_id: "PSC-send-authorization-fixture",
    operation_scope_binding: binding,
    send_authorization_contract_version: 2,
  };
  const eventSeed = {
    source_id: payload.source_id,
    ordinal: 0,
    type: "business.outbox.send_begun",
    payload,
    evidence_refs: [],
  };
  return {
    event: {
      event_id: `BVE-${canonicalHash(eventSeed).slice(0, 32)}`,
      schema_version: 1,
      type: eventSeed.type,
      payload,
      evidence_refs: [],
    },
    batch_id: `business:${payload.source_id}`,
  };
}

test("one shared scope matrix enforces all four provider Effect kinds", () => {
  for (const kind of [
    "provider.thread.create",
    "provider.turn.start",
    "provider.user_input.submit",
    "provider.turn.cancel",
  ]) {
    const { binding, effect } = scopeFixture(kind);
    assert.deepEqual(
      normalizeSendAuthorizationOperationScopeBindingV2(binding, effect),
      binding,
    );
  }
  const { binding, effect } = scopeFixture("provider.user_input.submit");
  assert.throws(
    () => normalizeSendAuthorizationOperationScopeBindingV2(
      { ...binding, request_id: null },
      effect,
    ),
    (error) => error instanceof BusinessSendAuthorizationError
      && error.code === "BUSINESS_SEND_AUTHORIZATION_SCOPE_INVALID",
  );
});

test("SAB content addressing excludes receipt self-reference and rejects rehashed malformed identity", () => {
  const fixture = bundleFixture();
  const bundle = createSendAuthorizationBundleV1({
    send_event: fixture.event,
    batch_id: fixture.batch_id,
  });
  assert.deepEqual(normalizeSendAuthorizationBundleV1(bundle), bundle);
  assert.equal(Object.hasOwn(bundle, "receipt_event"), false);
  assert.equal(Object.hasOwn(bundle, "internal_receipt"), false);

  const malformed = structuredClone(fixture.event);
  malformed.payload.effect.attempt = "not-an-integer";
  malformed.payload.effect.created_at = "not-a-time";
  malformed.event_id = `BVE-${canonicalHash({ forged: malformed }).slice(0, 32)}`;
  assert.throws(
    () => createSendAuthorizationBundleV1({
      send_event: malformed,
      batch_id: fixture.batch_id,
    }),
    (error) => error instanceof BusinessSendAuthorizationError
      && error.code === "BUSINESS_SEND_AUTHORIZATION_INVALID",
  );
});

test("fresh public replay reconstructs the exact stable proof without a raw commit map", async (t) => {
  const stack = await createCanonicalReactorStack(t, { label: "public-proof-restart" });
  const interrupted = createBusinessCanonicalReactor({
    ...stack.reactorOptions(),
    authorizationResolver: {
      async resolveCommittedSendAuthorization() {
        throw Object.assign(new Error("stop after durable send.begin"), {
          code: "TEST_AFTER_SEND_BEGIN",
        });
      },
      resolveRetainedProviderEntryAuthorization: (query) => (
        stack.authorizationResolver.resolveRetainedProviderEntryAuthorization(query)
      ),
      resolveRecoveryAuthorization: (query) => (
        stack.authorizationResolver.resolveRecoveryAuthorization(query)
      ),
    },
  });
  assert.equal((await interrupted.executeOnce()).status, "claimed");
  stack.now.value = stack.times.send_at;
  await assert.rejects(interrupted.executeOnce(), { code: "TEST_AFTER_SEND_BEGIN" });

  const replay = await stack.eventStore.replay();
  const receipt = Object.values(replay.state.internal_receipts).find(
    (candidate) => candidate.result?.effect_id === stack.effect.effect_id
      && candidate.result?.action === "outbox.send.begin",
  );
  const proof = createCommittedSendAuthorizationProofV2({
    send_authorization_bundle: receipt.result.send_authorization_bundle,
    internal_receipt: receipt,
  });
  assert.deepEqual(normalizeCommittedSendAuthorizationProofV2(proof), proof);
  assert.match(deriveCommittedSendAuthorizationHashV2(proof), /^[a-f0-9]{64}$/u);
  assert.deepEqual(proof.commit.event_ids, [proof.send_event.event_id, proof.receipt_event.event_id]);

  const reopened = stack.reopenAuthorization();
  assert.equal(Object.hasOwn(reopened.eventStore, "commits"), false);
  const query = {
    authorization_contract_version: 2,
    effect_id: proof.effect.effect_id,
    mutation_idempotency_key: proof.effect.idempotency_key,
    send_authorization_receipt_ref: proof.send_authorization_receipt_ref,
    provider_request_ref: proof.provider_request_ref,
    worker_fencing_token: proof.authorized_fencing_token,
  };
  assert.deepEqual(
    await reopened.authorizationResolver.resolveCommittedSendAuthorization(query),
    proof,
  );
  await assert.rejects(
    reopened.authorizationResolver.resolveCommittedSendAuthorization({
      ...query,
      send_authorization_receipt_ref: ref("forged:receipt"),
    }),
    (error) => error.code === "BUSINESS_SEND_AUTHORIZATION_PROJECTION_MISMATCH",
  );

  const tampered = structuredClone(proof);
  tampered.commit.event_hashes[tampered.send_event.event_id] = "0".repeat(64);
  assert.throws(
    () => normalizeCommittedSendAuthorizationProofV2(tampered),
    (error) => error instanceof BusinessSendAuthorizationError
      && error.code === "BUSINESS_SEND_AUTHORIZATION_INVALID",
  );
});

test("fresh public replay closes every renewed provider-entry window without granting stale entry", async (t) => {
  const stack = await createCanonicalReactorStack(t, { label: "public-pew-restart" });
  const interrupted = createBusinessCanonicalReactor({
    ...stack.reactorOptions(),
    authorizationResolver: {
      async resolveCommittedSendAuthorization() {
        throw Object.assign(new Error("stop after durable send.begin"), {
          code: "TEST_AFTER_SEND_BEGIN",
        });
      },
      resolveRetainedProviderEntryAuthorization: (query) => (
        stack.authorizationResolver.resolveRetainedProviderEntryAuthorization(query)
      ),
      resolveRecoveryAuthorization: (query) => (
        stack.authorizationResolver.resolveRecoveryAuthorization(query)
      ),
    },
  });
  assert.equal((await interrupted.executeOnce()).status, "claimed");
  stack.now.value = stack.times.send_at;
  await assert.rejects(interrupted.executeOnce(), { code: "TEST_AFTER_SEND_BEGIN" });
  await stack.renewSendingLease("2026-08-10T01:00:20.000Z");
  await stack.renewSendingLease("2026-08-10T01:00:25.000Z");

  const replay = await stack.eventStore.replay();
  const sendReceipt = Object.values(replay.state.internal_receipts).find(
    (candidate) => candidate.result?.effect_id === stack.effect.effect_id
      && candidate.result?.action === "outbox.send.begin",
  );
  const proof = createCommittedSendAuthorizationProofV2({
    send_authorization_bundle: sendReceipt.result.send_authorization_bundle,
    internal_receipt: sendReceipt,
  });
  const baseQuery = {
    authorization_contract_version: 2,
    effect_id: proof.effect.effect_id,
    mutation_idempotency_key: proof.effect.idempotency_key,
    send_authorization_receipt_ref: proof.send_authorization_receipt_ref,
    provider_request_ref: proof.provider_request_ref,
    worker_fencing_token: proof.authorized_fencing_token,
  };
  const reopened = stack.reopenAuthorization();
  assert.equal(Object.hasOwn(reopened.eventStore, "commits"), false);
  const fromAnchor = await reopened.authorizationResolver.resolveSendAuthorization({
    ...baseQuery,
    minimum_provider_entry_window_ref: null,
  });
  assert.deepEqual(normalizeProviderEntryAuthorizationProofV1(fromAnchor), fromAnchor);
  assert.equal(fromAnchor.entry_window.window_kind, "send_begin");
  assert.equal(fromAnchor.continuation_chain.length, 2);
  assert.equal(fromAnchor.current_window_index.current_window_sequence, 2);
  assert.equal(
    fromAnchor.continuation_chain.at(-1).provider_entry_window.lease_expires_at,
    "2026-08-10T01:00:55.000Z",
  );

  const currentRef = fromAnchor.current_window_index.current_window_ref;
  const fromCurrent = await reopened.authorizationResolver
    .resolveRetainedProviderEntryAuthorization({
      ...baseQuery,
      minimum_provider_entry_window_ref: currentRef,
    });
  assert.deepEqual(normalizeProviderEntryAuthorizationProofV1(fromCurrent), fromCurrent);
  assert.deepEqual(fromCurrent.entry_window.window_ref, currentRef);
  assert.deepEqual(fromCurrent.continuation_chain, []);

  stack.now.value = "2026-08-10T01:00:56.000Z";
  await assert.rejects(
    reopened.authorizationResolver.resolveSendAuthorization({
      ...baseQuery,
      minimum_provider_entry_window_ref: currentRef,
    }),
    (error) => error.code === "BUSINESS_SEND_AUTHORIZATION_ENTRY_WINDOW_CLOSED",
  );
  assert.deepEqual(
    await reopened.authorizationResolver.resolveRetainedProviderEntryAuthorization({
      ...baseQuery,
      minimum_provider_entry_window_ref: currentRef,
    }),
    fromCurrent,
    "retained coverage is readable after expiry but never grants provider entry",
  );
  await assert.rejects(
    reopened.authorizationResolver.resolveRetainedProviderEntryAuthorization({
      ...baseQuery,
      minimum_provider_entry_window_ref: ref("PEW-forged"),
    }),
    (error) => error.code === "BUSINESS_SEND_AUTHORIZATION_PROVIDER_ENTRY_NOT_COVERED",
  );
});
