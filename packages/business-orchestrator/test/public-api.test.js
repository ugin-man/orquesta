"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const api = require("../src");

test("publishes versioned contracts, projection V2, and authenticated ingress boundaries", () => {
  for (const name of [
    "normalizeBusinessWorkOrderPlanV1",
    "normalizeBusinessRuntimeObservationEnvelope",
    "normalizeCommandEnvelopeV1",
    "normalizeRuntimeObservationEnvelopeV1",
    "evaluateBusinessAcceptanceV1",
    "createBusinessCommandBoundary",
    "createBusinessObservationBoundary",
    "normalizeInternalActionEnvelopeV1",
    "createBusinessInternalActionBoundary",
    "createDispatchPacketStore",
    "normalizeDispatchPacketV1",
    "normalizeDispatchPacketSendAuthorizationVerificationV1",
    "normalizeDispatchPacketVerificationReceiptV1",
    "businessProjectionConfigurationV1",
    "normalizeProviderSettlementCutoverEnvelopeV1",
    "deriveProviderSettlementCutoverReadinessV1",
    "normalizeProviderSettlementCutoverReadinessEvidenceV1",
    "normalizeProviderSettlementEpochV1",
    "buildProviderSettlementCutoverBatchV1",
    "deriveProviderSettlementEpochFromBatchV1",
    "createBusinessProviderSettlementCutoverBoundary",
    "decideWorkOrderV1",
    "projectBusinessEventV1",
    "replayBusinessProjectionV1",
    "initialBusinessProjectionV1",
  ]) {
    assert.equal(typeof api[name], "function", `${name} must be public`);
  }
  assert.equal(api.BUSINESS_PROJECTION_VERSION, 2);
  assert.equal(api.BUSINESS_EVENT_SCHEMA_VERSION, 1);
  assert.equal(api.BUSINESS_ENGINE_CONTRACT_VERSION, 2);
  assert.equal(api.PROVIDER_SETTLEMENT_CONTRACT_VERSION, 2);
  assert.equal(api.PROVIDER_SETTLEMENT_CUTOVER_ENVELOPE_VERSION, 1);
  assert.equal(api.PROVIDER_SETTLEMENT_CUTOVER_SCHEMA_VERSION, 1);
  assert.equal(api.PROVIDER_SETTLEMENT_CUTOVER_PROJECTION_SCHEMA_VERSION, 2);
  assert.equal(api.PROVIDER_SETTLEMENT_CUTOVER_ACTION,
    "provider_settlement.v2.activate");
  assert.equal(api.PROVIDER_SETTLEMENT_CUTOVER_SOURCE_TYPE,
    "provider_settlement_cutover");
  assert.equal(api.PROVIDER_SETTLEMENT_ACTIVATED_EVENT,
    "business.provider_settlement.v2_activated");
  assert.equal(api.PROVIDER_SETTLEMENT_CUTOVER_RECEIVED_EVENT,
    "business.provider_settlement.cutover_received");
  assert.equal(typeof api.BusinessProviderSettlementCutoverBoundaryError, "function");
  assert.equal(api.DISPATCH_PACKET_CONTRACT_VERSION, 1);
  assert.equal(api.DISPATCH_PACKET_VERIFICATION_RECEIPT_VERSION, 1);
  assert.equal(typeof api.BusinessPacketStoreError, "function");
  assert.equal(api.DISPATCH_PACKET_STORE_LIMITS.max_packet_bytes, 1_048_576);
  assert.throws(
    () => { api.DISPATCH_PACKET_STORE_LIMITS.max_packet_bytes = 2_000_000; },
    TypeError,
  );
  assert.ok(api.BUSINESS_EVENT_TYPES.includes("business.command.received"));
  assert.ok(api.BUSINESS_EVENT_TYPES.includes("business.provider_settlement.received"));
  assert.ok(api.BUSINESS_EVENT_TYPES.includes(api.PROVIDER_SETTLEMENT_ACTIVATED_EVENT));
  assert.ok(api.BUSINESS_EVENT_TYPES.includes(api.PROVIDER_SETTLEMENT_CUTOVER_RECEIVED_EVENT));
  assert.ok(api.REQUIRED_PROVIDER_EFFECTS.includes("provider.turn.inspect"));
  assert.ok(api.OUTBOX_IMMUTABLE_FIELDS.includes("operation_scope_hash"));
  assert.ok(api.OUTBOX_IMMUTABLE_FIELDS.includes("operation_generation"));
  assert.ok(api.OUTBOX_IMMUTABLE_FIELDS.includes("generation_predecessor_effect_id"));
  assert.deepEqual(api.INTERNAL_ACTION_NAMES, [
    "outbox.claim",
    "outbox.send.begin",
    "outbox.lease.renew",
    "outbox.requeue",
  ]);
  assert.deepEqual(api.LIVE_RUNTIME_OBSERVATION_NAMES, [
    "work_order.cancelled",
    "branch.timed_out",
    "verification.recorded",
    "review.recorded",
    "provider.effect.settlement.recorded",
    "provider.effect.send_expiration.recorded",
    "provider.effect.presend_failure.recorded",
  ]);
  assert.ok(!api.LIVE_RUNTIME_OBSERVATION_NAMES.includes("provider.effect.delivery.recorded"));
  assert.ok(!api.LIVE_RUNTIME_OBSERVATION_NAMES.includes("branch.result.submitted"));
  assert.deepEqual(api.TERMINAL_WORK_ORDER_STATES, ["accepted", "failed", "cancelled"]);
  assert.throws(() => api.TERMINAL_WORK_ORDER_STATES.push("running"), TypeError);
  const projection = api.initialBusinessProjectionV1();
  assert.equal(projection.schema_version, 2);
  assert.equal(projection.provider_settlement_epoch, null);
  assert.deepEqual(projection.provider_entry_windows, {});
  const configuration = api.businessProjectionConfigurationV1();
  assert.equal(configuration.initialState.schema_version, 2);
  assert.equal(typeof configuration.reducers[api.PROVIDER_SETTLEMENT_ACTIVATED_EVENT],
    "function");
});

test("keeps runtime value exports aligned with declarations and canonical workers internal", () => {
  const declaration = fs.readFileSync(
    path.join(__dirname, "../src/index.d.ts"),
    "utf8",
  );
  const declaredValues = new Set(
    [...declaration.matchAll(
      /^export\s+(?:declare\s+)?(?:class|const|function)\s+([A-Za-z_$][\w$]*)/gmu,
    )].map((match) => match[1]),
  );
  assert.deepEqual([...declaredValues].sort(), Object.keys(api).sort());

  for (const internalName of [
    "createBusinessCanonicalReactor",
    "createBusinessSendAuthorizationResolver",
    "createRecordedFakeProviderDriver",
    "createSendAuthorizationBundleV1",
    "createProviderEntryWindowAnchorV1",
    "createDispatchPacketStorePosixPlatformAdapter",
    "createPresendFailureRecorder",
    "SEND_AUTHORIZATION_CONTRACT_VERSION",
    "PROVIDER_ENTRY_WINDOW_VERSION",
    "CANONICAL_REACTOR_CONTRACT_VERSION",
    "RECORDED_FAKE_PROVIDER_VERSION",
  ]) {
    assert.equal(Object.hasOwn(api, internalName), false, `${internalName} must stay internal`);
  }
});
