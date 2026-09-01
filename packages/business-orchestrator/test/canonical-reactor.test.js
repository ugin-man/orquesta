"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { canonicalHash } = require("@orquesta/contracts");
const {
  BusinessCanonicalReactorError,
  RECORDED_FAKE_CAPABILITIES,
  SEND_AUTHORIZATION_CONTRACT_VERSION,
  createBusinessCanonicalReactor,
  deriveBusinessCanonicalReactorPlanV1,
} = require("../src/canonical-reactor");
const { deriveEffectOperationScopeHashV2 } = require("../src/lifecycle");
const { RECORDED_FAKE_CRASH_POINTS } = require("../src/recorded-fake-provider");
const {
  createCanonicalReactorStack,
} = require("./support/canonical-reactor-stack");

const NOW = "2026-08-10T03:00:00.000Z";
const FUTURE = "2026-08-10T03:00:30.000Z";
const PAST = "2026-08-10T02:59:59.999Z";

function effectFor(label, status = "pending", expiresAt = FUTURE) {
  const workOrderId = `WO-${canonicalHash(`work-order:${label}`).slice(0, 32)}`;
  const branchRef = `branch:${label}`;
  const packet = {
    id: `dispatch-packet:${canonicalHash(`packet:${label}`)}`,
    hash: canonicalHash(`packet:${label}`),
  };
  const dispatchId = `DSP-${canonicalHash({
    work_order_id: workOrderId,
    branch_ref: branchRef,
    attempt: 1,
    packet_ref: packet,
  }).slice(0, 32)}`;
  const identitySeed = {
    effect_contract_version: 2,
    work_order_id: workOrderId,
    branch_ref: branchRef,
    attempt: 1,
    dispatch_id: dispatchId,
    effect_kind: "provider.thread.create",
    origin_source_id: `CMD-${canonicalHash(`command:${label}`).slice(0, 32)}`,
    operation_scope_hash: deriveEffectOperationScopeHashV2({
      effect_kind: "provider.thread.create",
      provider_ref: "provider:recorded",
      packet_ref: packet.id,
      packet_hash: packet.hash,
    }),
    operation_generation: 1,
    generation_predecessor_effect_id: null,
    provider_ref: "provider:recorded",
    packet_ref: packet.id,
    packet_hash: packet.hash,
    predecessor_effect_id: null,
    predecessor_delivery_hash: null,
    target_runtime_identity: null,
  };
  const identityHash = canonicalHash(identitySeed);
  const lease = status === "pending" || status === "delivery_unknown"
    ? null
    : {
      lease_id: `lease:${label}`,
      owner_id: `worker:${label}`,
      generation: 1,
      claimed_at: "2026-08-10T02:59:30.000Z",
      heartbeat_at: "2026-08-10T02:59:30.000Z",
      expires_at: expiresAt,
    };
  const effect = {
    effect_id: `FX-${identityHash.slice(0, 32)}`,
    ...identitySeed,
    idempotency_key: `IDEM-${identityHash.slice(0, 32)}`,
    status,
    lease,
    delivery: status === "delivery_unknown"
      ? {
        classification: "delivery_unknown",
        evidence_refs: ["evidence:expiry"],
        runtime_identity: null,
        recorded_at: "2026-08-10T02:59:59.999Z",
      }
      : null,
    lease_generation: status === "pending" ? 0 : 1,
    last_lease_id: status === "pending" ? null : `lease:${label}`,
    fencing_history: status === "pending" ? [] : [{
      lease_id: `lease:${label}`,
      owner_id: `worker:${label}`,
      generation: 1,
    }],
    settlement_policy: null,
    created_at: "2026-08-10T02:59:00.000Z",
    updated_at: "2026-08-10T02:59:30.000Z",
  };
  return effect;
}

function projectionFor(entries, { cutover = true } = {}) {
  const workOrders = {};
  const outbox = {};
  for (const [label, status, expiresAt] of entries) {
    const effect = effectFor(label, status, expiresAt);
    const ambiguous = status === "delivery_unknown";
    const attention = ambiguous
      ? {
        [`ATTN-${canonicalHash(label).slice(0, 32)}`]: {
          attention_id: `ATTN-${canonicalHash(label).slice(0, 32)}`,
          kind: "delivery_unknown",
          branch_ref: effect.branch_ref,
          effect_id: effect.effect_id,
          detail_ref: { id: `detail:${label}`, hash: canonicalHash(`detail:${label}`) },
          evidence_refs: ["evidence:expiry"],
          opened_at: "2026-08-10T02:59:59.999Z",
          status: "open",
          resolution: null,
        },
      }
      : {};
    workOrders[effect.work_order_id] = {
      work_order_id: effect.work_order_id,
      engine_contract_version: 2,
      status: "running",
      revision: 1,
      plan_hash: canonicalHash({ plan: label }),
      plan_snapshot_ref: `BPS-${canonicalHash({ plan: label }).slice(0, 32)}`,
      branches: {
        [effect.branch_ref]: {
          branch_ref: effect.branch_ref,
          state: ambiguous ? "delivery_unknown" : "dispatch_pending",
          attempt: 1,
          dispatch_id: effect.dispatch_id,
        },
      },
      attention,
    };
    outbox[effect.effect_id] = effect;
  }
  return {
    work_orders: workOrders,
    outbox,
    internal_receipts: {},
    provider_entry_windows: {},
    observation_receipts: {},
    provider_settlement_epoch: cutover ? { cutover_id: "cutover:test" } : null,
  };
}

function plan(projection, effectId = null) {
  return deriveBusinessCanonicalReactorPlanV1({
    projection,
    now: NOW,
    ...(effectId === null ? {} : { effect_id: effectId }),
  });
}

test("pure planner follows shared V2 lifecycle states without enabling a provider", () => {
  assert.equal(plan(projectionFor([["pending", "pending"]])).decision, "claim");
  assert.deepEqual(
    [plan(projectionFor([["claimed", "claimed", FUTURE]])).decision,
      plan(projectionFor([["claimed-expired", "claimed", PAST]])).decision],
    ["wait", "requeue"],
  );
  assert.deepEqual(
    [plan(projectionFor([["sending", "sending", FUTURE]])).decision,
      plan(projectionFor([["sending-expired", "sending", PAST]])).decision],
    ["lookup_worker_result", "expire_send"],
  );
  assert.equal(
    plan(projectionFor([["unknown", "delivery_unknown"]])).decision,
    "probe_delivery_unknown",
  );
  assert.equal(
    plan(projectionFor([["pre-cutover", "pending"]], { cutover: false })).reason,
    "provider_settlement_cutover_required",
  );
});

test("a waiting first Effect cannot starve an actionable Effect in another Work Order", () => {
  const projection = projectionFor([
    ["a-claimed", "claimed", FUTURE],
    ["b-pending", "pending"],
  ]);
  const result = plan(projection);
  assert.equal(result.decision, "claim");
  assert.equal(result.effect_id, effectFor("b-pending").effect_id);
});

test("read-only sending lookup cannot monopolize a later pending Work Order", () => {
  const projection = projectionFor([
    ["a-sending", "sending", FUTURE],
    ["b-pending-after-send", "pending"],
  ]);
  const result = plan(projection);
  assert.equal(result.decision, "claim");
  assert.equal(result.effect_id, effectFor("b-pending-after-send").effect_id);
});

test("factory remains plan-only by default and requires verified failure provenance", async () => {
  const projection = projectionFor([["disabled", "pending"]]);
  const eventStore = {
    inspectRecovery() {
      return {
        action: "none",
        required_user_decision: null,
        last_valid_sequence: 1,
        quarantine_paths: [],
      };
    },
    async replay() {
      return { state: projection, watermark: { journal_sequence: 1 } };
    },
  };
  const inertBoundary = { async execute() { throw new Error("must not execute"); } };
  const packetStore = {
    async read() { throw new Error("must not read"); },
    async verifyForEffect() { throw new Error("must not verify"); },
  };
  const resolver = {
    async resolveCommittedSendAuthorization() { throw new Error("must not resolve"); },
    async resolveRetainedProviderEntryAuthorization() { throw new Error("must not resolve"); },
    async resolveRecoveryAuthorization() { throw new Error("must not resolve"); },
  };
  const reactor = createBusinessCanonicalReactor({
    eventStore,
    internalActionBoundary: inertBoundary,
    observationBoundary: inertBoundary,
    packetStore,
    authorizationResolver: resolver,
    recordedFakeProvider: {
      async executeMutation() {},
      async inspectByExactKey() {},
      async readEvidence() {},
    },
    systemActorId: "system:canonical-reactor",
    runtimeActorId: "runtime:canonical-reactor",
    ownerId: "worker:canonical-reactor",
    runId: "a".repeat(32),
    clock: () => NOW,
  });
  assert.equal((await reactor.planOnce()).decision, "claim");
  await assert.rejects(
    reactor.executeOnce(),
    (error) => error instanceof BusinessCanonicalReactorError
      && error.code === "BUSINESS_CANONICAL_REACTOR_DISABLED",
  );

  const enabled = createBusinessCanonicalReactor({
    eventStore,
    internalActionBoundary: inertBoundary,
    observationBoundary: inertBoundary,
    packetStore,
    authorizationResolver: resolver,
    recordedFakeProvider: {
      async executeMutation() {},
      async inspectByExactKey() {},
      async readEvidence() {},
    },
    enabled: true,
    systemActorId: "system:canonical-reactor",
    runtimeActorId: "runtime:canonical-reactor",
    ownerId: "worker:canonical-reactor",
    runId: "b".repeat(32),
    clock: () => NOW,
  });
  await assert.rejects(
    enabled.executeOnce(),
    (error) => error instanceof BusinessCanonicalReactorError
      && error.code === "BUSINESS_CANONICAL_REACTOR_PRESEND_RECORDER_REQUIRED",
  );
});

test("even a driver with send authorization stays blocked without the call-entry window and verified failure recorder", async () => {
  const projection = projectionFor([["capability-gate", "pending"]]);
  const eventStore = {
    inspectRecovery() {
      return {
        action: "none",
        required_user_decision: null,
        last_valid_sequence: 1,
        quarantine_paths: [],
      };
    },
    async replay() {
      return { state: projection, watermark: { journal_sequence: 1 } };
    },
  };
  const inertBoundary = { async execute() { throw new Error("must not execute"); } };
  const packetStore = {
    async read() { throw new Error("must not read"); },
    async verifyForEffect() { throw new Error("must not verify"); },
  };
  const resolver = {
    async resolveCommittedSendAuthorization() { throw new Error("must not resolve"); },
    async resolveRetainedProviderEntryAuthorization() { throw new Error("must not resolve"); },
    async resolveRecoveryAuthorization() { throw new Error("must not resolve"); },
  };
  const methods = {
    authorization_contract_version: SEND_AUTHORIZATION_CONTRACT_VERSION,
    async executeMutation() {},
    async readAuthorizedMutationResult() {},
    async inspectByExactKey() {},
    async readEvidence() {},
  };
  const beforeEntryWindow = {
    ...methods,
    capabilities() {
      const { provider_entry_window: ignored, ...old } = RECORDED_FAKE_CAPABILITIES;
      void ignored;
      return old;
    },
  };
  const blockedDriver = createBusinessCanonicalReactor({
    eventStore,
    internalActionBoundary: inertBoundary,
    observationBoundary: inertBoundary,
    packetStore,
    authorizationResolver: resolver,
    recordedFakeProvider: beforeEntryWindow,
    presendFailureRecorder: {
      capabilities() {
        return {
          recorder_contract_version: 1,
          storage: "durable_content_addressed",
          idempotency: "presend_failure_id",
          verification: "source_specific_internal",
          observation_attestation: "trusted_resolver_readable",
        };
      },
      async recordVerifiedFailure() { throw new Error("must not record"); },
    },
    enabled: true,
    systemActorId: "system:canonical-reactor",
    runtimeActorId: "runtime:canonical-reactor",
    ownerId: "worker:canonical-reactor",
    runId: "c".repeat(32),
    clock: () => NOW,
  });
  assert.equal(blockedDriver.capabilities, null);
  assert.equal((await blockedDriver.planOnce()).decision, "claim");

  const entrySafeDriver = {
    ...methods,
    capabilities() { return RECORDED_FAKE_CAPABILITIES; },
  };
  const missingRecorder = createBusinessCanonicalReactor({
    eventStore,
    internalActionBoundary: inertBoundary,
    observationBoundary: inertBoundary,
    packetStore,
    authorizationResolver: resolver,
    recordedFakeProvider: entrySafeDriver,
    enabled: true,
    systemActorId: "system:canonical-reactor",
    runtimeActorId: "runtime:canonical-reactor",
    ownerId: "worker:canonical-reactor",
    runId: "d".repeat(32),
    clock: () => NOW,
  });
  await assert.rejects(
    missingRecorder.executeOnce(),
    (error) => error.code === "BUSINESS_CANONICAL_REACTOR_PRESEND_RECORDER_REQUIRED",
  );
});

test("same-run fresh claim records a source-verified Packet failure without provider entry", async () => {
  const projection = projectionFor([["verified-presend", "pending"]]);
  const effect = Object.values(projection.outbox)[0];
  const calls = { provider: 0, recorder: 0, observation: 0 };
  const eventStore = {
    inspectRecovery() {
      return {
        action: "none",
        required_user_decision: null,
        last_valid_sequence: 1,
        quarantine_paths: [],
      };
    },
    async replay() {
      return { state: projection, watermark: { journal_sequence: 1 } };
    },
  };
  const internalActionBoundary = {
    async execute({ internal_action: action }) {
      if (action.name === "outbox.claim") {
        const token = {
          lease_id: action.payload.lease_id,
          owner_id: action.payload.owner_id,
          generation: 1,
        };
        effect.status = "claimed";
        effect.lease = {
          ...token,
          claimed_at: NOW,
          heartbeat_at: NOW,
          expires_at: FUTURE,
        };
        effect.lease_generation = 1;
        effect.last_lease_id = token.lease_id;
        effect.fencing_history = [token];
        effect.updated_at = NOW;
        return {
          internal_action_id: action.internal_action_id,
          work_order_id: effect.work_order_id,
          work_order_revision: 1,
          effect_id: effect.effect_id,
          action: "outbox.claim",
          outbox_status: "claimed",
          fencing_token: token,
        };
      }
      assert.equal(action.name, "outbox.send.begin");
      throw Object.assign(new Error("verified packet failure"), {
        code: "BUSINESS_INTERNAL_PACKET_VERIFICATION_FAILED",
      });
    },
  };
  const observationBoundary = {
    async execute({ observation }) {
      calls.observation += 1;
      assert.equal(observation.name, "provider.effect.presend_failure.recorded");
      assert.equal(observation.payload.failure_reason, "packet_integrity_failed");
      return { outbox_status: "not_sent", attention: "operator" };
    },
  };
  const recorder = {
    capabilities() {
      return {
        recorder_contract_version: 1,
        storage: "durable_content_addressed",
        idempotency: "presend_failure_id",
        verification: "source_specific_internal",
        observation_attestation: "trusted_resolver_readable",
      };
    },
    async recordVerifiedFailure(input) {
      calls.recorder += 1;
      assert.equal(input.failure_source, "packet_store");
      const failureRecord = {
        failure_record_version: 1,
        failure_record_kind: "verified_provider_presend_failure",
        presend_failure_id: input.presend_failure_id,
        effect_identity: input.effect_identity,
        claimed_fencing_token: input.claimed_fencing_token,
        failure_source: input.failure_source,
        failure_reason: "packet_integrity_failed",
        evidence_refs: ["evidence:verified-packet-failure"],
      };
      const hash = canonicalHash(failureRecord);
      const failureRecordRef = { id: `PFR-${hash.slice(0, 32)}`, hash };
      return {
        recorder_contract_version: 1,
        presend_failure_id: input.presend_failure_id,
        failure_record: failureRecord,
        failure_record_ref: failureRecordRef,
        presend_failure_attestation: {
          effect_id: effect.effect_id,
          idempotency_key: effect.idempotency_key,
          provider_ref: effect.provider_ref,
          claimed_fencing_token: input.claimed_fencing_token,
          failure_reason: failureRecord.failure_reason,
          failure_record_ref: failureRecordRef,
          evidence_refs: failureRecord.evidence_refs,
        },
      };
    },
  };
  const driver = {
    authorization_contract_version: SEND_AUTHORIZATION_CONTRACT_VERSION,
    capabilities() { return RECORDED_FAKE_CAPABILITIES; },
    async executeMutation() { calls.provider += 1; },
    async readAuthorizedMutationResult() {},
    async inspectByExactKey() {},
    async readEvidence() {},
  };
  const reactor = createBusinessCanonicalReactor({
    eventStore,
    internalActionBoundary,
    observationBoundary,
    packetStore: {
      async read() { throw new Error("must not read after rejected send.begin"); },
      async verifyForEffect() { throw new Error("must not verify after rejected send.begin"); },
    },
    authorizationResolver: {
      async resolveCommittedSendAuthorization() { throw new Error("must not resolve"); },
      async resolveRetainedProviderEntryAuthorization() { throw new Error("must not resolve"); },
      async resolveRecoveryAuthorization() { throw new Error("must not resolve"); },
    },
    recordedFakeProvider: driver,
    presendFailureRecorder: recorder,
    enabled: true,
    systemActorId: "system:canonical-reactor",
    runtimeActorId: "runtime:canonical-reactor",
    ownerId: "worker:canonical-reactor",
    runId: "e".repeat(32),
    clock: () => NOW,
  });
  assert.equal((await reactor.executeOnce()).status, "claimed");
  const failure = await reactor.executeOnce();
  assert.equal(failure.status, "operator_attention");
  assert.deepEqual(calls, { provider: 0, recorder: 1, observation: 1 });
});

test("enabled reactor closes one exact real-stack mutation through durable worker evidence", async (t) => {
  const stack = await createCanonicalReactorStack(t, { label: "happy-path" });
  const reactor = createBusinessCanonicalReactor(stack.reactorOptions());

  assert.equal((await reactor.executeOnce()).status, "claimed");
  stack.now.value = stack.times.send_at;
  const settled = await reactor.executeOnce();
  assert.equal(settled.status, "settled");
  assert.equal(settled.source, "worker_result");

  const replay = await stack.eventStore.replay();
  assert.equal(replay.state.outbox[stack.effect.effect_id].status, "delivered");
});

test("enabled real stack also closes through the production POSIX provider adapter", async (t) => {
  const stack = await createCanonicalReactorStack(t, {
    label: "production-provider-adapter",
    productionProviderAdapter: true,
  });
  const reactor = createBusinessCanonicalReactor(stack.reactorOptions());
  assert.equal((await reactor.executeOnce()).status, "claimed");
  stack.now.value = stack.times.send_at;
  const settled = await reactor.executeOnce();
  assert.equal(settled.status, "settled");
  assert.equal(settled.source, "worker_result");
  const replay = await stack.eventStore.replay();
  assert.equal(replay.state.outbox[stack.effect.effect_id].status, "delivered");
});

test("live provider entry uses the latest receipt-closed renewal window", async (t) => {
  const stack = await createCanonicalReactorStack(t, { label: "renew-before-entry" });
  let renewed = false;
  const resolver = {
    async resolveCommittedSendAuthorization(query) {
      const proof = await stack.authorizationResolver.resolveCommittedSendAuthorization(query);
      if (!renewed) {
        renewed = true;
        await stack.renewSendingLease("2026-08-10T01:00:20.000Z");
        stack.now.value = "2026-08-10T01:00:45.000Z";
      }
      return proof;
    },
    resolveRetainedProviderEntryAuthorization: (query) => (
      stack.authorizationResolver.resolveRetainedProviderEntryAuthorization(query)
    ),
    resolveRecoveryAuthorization: (query) => (
      stack.authorizationResolver.resolveRecoveryAuthorization(query)
    ),
  };
  const reactor = createBusinessCanonicalReactor({
    ...stack.reactorOptions(),
    authorizationResolver: resolver,
  });
  assert.equal((await reactor.executeOnce()).status, "claimed");
  stack.now.value = stack.times.send_at;
  const settled = await reactor.executeOnce();
  assert.equal(settled.status, "settled");
  const evidence = await stack.baseDriver.readEvidence(settled.worker_result_ref);
  assert.equal(evidence.provider_entry_window_sequence, 1);
  assert.equal(
    evidence.provider_entry_window_lease_expires_at,
    "2026-08-10T01:00:50.000Z",
  );
});

test("renewal after provider entry preserves older receipt-closed evidence as an ancestor", async (t) => {
  const stack = await createCanonicalReactorStack(t, { label: "renew-after-entry" });
  const driver = Object.freeze({
    authorization_contract_version: stack.baseDriver.authorization_contract_version,
    capabilities: () => stack.baseDriver.capabilities(),
    async executeMutation(invocation) {
      const result = await stack.baseDriver.executeMutation(invocation);
      await stack.renewSendingLease("2026-08-10T01:00:20.000Z");
      return result;
    },
    readAuthorizedMutationResult: (input) => stack.baseDriver.readAuthorizedMutationResult(input),
    inspectByExactKey: (input) => stack.baseDriver.inspectByExactKey(input),
    readEvidence: (input) => stack.baseDriver.readEvidence(input),
  });
  const reactor = createBusinessCanonicalReactor(stack.reactorOptions(driver));
  assert.equal((await reactor.executeOnce()).status, "claimed");
  stack.now.value = stack.times.send_at;
  const settled = await reactor.executeOnce();
  assert.equal(settled.status, "settled");
  const evidence = await stack.baseDriver.readEvidence(settled.worker_result_ref);
  assert.equal(evidence.provider_entry_window_sequence, 0);
  const replay = await stack.eventStore.replay();
  assert.equal(
    replay.state.provider_entry_windows[stack.effect.effect_id].current_window_sequence,
    1,
  );
});

test("provider evidence cannot substitute an ancestor ref for a later entry core", async (t) => {
  const stack = await createCanonicalReactorStack(t, { label: "forged-entry-core" });
  let anchorRef = null;
  let renewed = false;
  let forgedEvidence = null;
  let forgedEvidenceRef = null;
  const resolver = {
    async resolveCommittedSendAuthorization(query) {
      const proof = await stack.authorizationResolver.resolveCommittedSendAuthorization(query);
      if (!renewed) {
        const replay = await stack.eventStore.replay();
        anchorRef = replay.state.provider_entry_windows[stack.effect.effect_id].current_window_ref;
        renewed = true;
        await stack.renewSendingLease("2026-08-10T01:00:20.000Z");
      }
      return proof;
    },
    resolveRetainedProviderEntryAuthorization: (query) => (
      stack.authorizationResolver.resolveRetainedProviderEntryAuthorization(query)
    ),
    resolveRecoveryAuthorization: (query) => (
      stack.authorizationResolver.resolveRecoveryAuthorization(query)
    ),
  };
  const driver = Object.freeze({
    authorization_contract_version: stack.baseDriver.authorization_contract_version,
    capabilities: () => stack.baseDriver.capabilities(),
    async executeMutation(invocation) {
      const result = await stack.baseDriver.executeMutation(invocation);
      const evidence = structuredClone(
        await stack.baseDriver.readEvidence(result.worker_result_ref),
      );
      assert.equal(evidence.provider_entry_window_sequence, 1);
      evidence.provider_entry_window_ref = anchorRef;
      const hash = canonicalHash(evidence);
      forgedEvidence = evidence;
      forgedEvidenceRef = { id: `WRR-${hash.slice(0, 32)}`, hash };
      return { ...result, worker_result_ref: forgedEvidenceRef };
    },
    readAuthorizedMutationResult: (input) => stack.baseDriver.readAuthorizedMutationResult(input),
    inspectByExactKey: (input) => stack.baseDriver.inspectByExactKey(input),
    readEvidence(input) {
      if (input.id === forgedEvidenceRef?.id) return forgedEvidence;
      return stack.baseDriver.readEvidence(input);
    },
  });
  const reactor = createBusinessCanonicalReactor({
    ...stack.reactorOptions(driver),
    authorizationResolver: resolver,
  });
  assert.equal((await reactor.executeOnce()).status, "claimed");
  stack.now.value = stack.times.send_at;
  await assert.rejects(
    reactor.executeOnce(),
    (error) => error.code === "BUSINESS_CANONICAL_REACTOR_WORKER_EVIDENCE_INVALID",
  );
});

test("enabled API rejects caller-supplied provider and receipt references before any write", async (t) => {
  const stack = await createCanonicalReactorStack(t, { label: "caller-ref-rejected" });
  const reactor = createBusinessCanonicalReactor(stack.reactorOptions());
  await assert.rejects(
    reactor.executeOnce({
      provider_request_ref: { id: "forged", hash: "0".repeat(64) },
      send_authorization_receipt_ref: { id: "forged", hash: "0".repeat(64) },
    }),
    (error) => error.code === "BUSINESS_CANONICAL_REACTOR_INPUT_INVALID",
  );
  const replay = await stack.eventStore.replay();
  assert.equal(replay.state.outbox[stack.effect.effect_id].status, "pending");
  assert.deepEqual(await stack.providerRecordKinds(), []);
});

test("non-clean EventStore recovery blocks every execution side effect before planning", async (t) => {
  const stack = await createCanonicalReactorStack(t, { label: "recovery-gate" });
  const calls = { internal: 0, observation: 0, provider: 0, presend: 0 };
  const baseOptions = stack.reactorOptions();
  const blockedStore = {
    ...stack.eventStore,
    inspectRecovery() {
      return {
        action: "retry_pending_commit",
        required_user_decision: null,
        last_valid_sequence: 2,
        quarantine_paths: [],
      };
    },
  };
  const driver = {
    authorization_contract_version: stack.baseDriver.authorization_contract_version,
    capabilities: () => stack.baseDriver.capabilities(),
    async executeMutation() { calls.provider += 1; },
    async readAuthorizedMutationResult() { calls.provider += 1; },
    async inspectByExactKey() { calls.provider += 1; },
    async readEvidence() { calls.provider += 1; },
  };
  const recorder = {
    capabilities: () => stack.presendFailureRecorder.capabilities(),
    async recordVerifiedFailure() { calls.presend += 1; },
  };
  const reactor = createBusinessCanonicalReactor({
    ...baseOptions,
    eventStore: blockedStore,
    internalActionBoundary: { async execute() { calls.internal += 1; } },
    observationBoundary: { async execute() { calls.observation += 1; } },
    recordedFakeProvider: driver,
    presendFailureRecorder: recorder,
  });
  await assert.rejects(
    reactor.executeOnce(),
    (error) => error.code === "BUSINESS_CANONICAL_REACTOR_RECOVERY_BLOCKED"
      && error.details.recovery_action === "retry_pending_commit",
  );
  assert.deepEqual(calls, { internal: 0, observation: 0, provider: 0, presend: 0 });
  const replay = await stack.eventStore.replay();
  assert.equal(replay.state.outbox[stack.effect.effect_id].status, "pending");
});

test("driver capability failure is source-verified before send.begin and provider entry", async (t) => {
  const stack = await createCanonicalReactorStack(t, {
    label: "driver-capability-failure",
    legacyDriverCapability: true,
  });
  const reactor = createBusinessCanonicalReactor(stack.reactorOptions());
  assert.equal((await reactor.executeOnce()).status, "claimed");
  const failure = await reactor.executeOnce();
  assert.equal(failure.status, "operator_attention");
  assert.equal(failure.source, "verified_presend_failure");
  assert.equal(stack.providerEntryCalls, 0);
  assert.deepEqual(await stack.providerRecordKinds(), []);
  const replay = await stack.eventStore.replay();
  assert.equal(replay.state.outbox[stack.effect.effect_id].status, "not_sent");
});

test("real PacketStore failure is reverified and durably attested before provider entry", async (t) => {
  const stack = await createCanonicalReactorStack(t, { label: "packet-presend-failure" });
  const reactor = createBusinessCanonicalReactor(stack.reactorOptions());
  assert.equal((await reactor.executeOnce()).status, "claimed");
  await stack.removeDispatchPacket();
  const failure = await reactor.executeOnce();
  assert.equal(failure.status, "operator_attention");
  assert.equal(failure.source, "verified_presend_failure");
  assert.deepEqual(await stack.providerRecordKinds(), []);
  const replay = await stack.eventStore.replay();
  assert.equal(replay.state.outbox[stack.effect.effect_id].status, "not_sent");
});

test("restart never sends another run's claim and requeues only after exact expiry", async (t) => {
  const stack = await createCanonicalReactorStack(t, { label: "claimed-restart" });
  const first = createBusinessCanonicalReactor(stack.reactorOptions());
  const claimed = await first.executeOnce();
  assert.equal(claimed.status, "claimed");

  const restarted = createBusinessCanonicalReactor(
    stack.reactorOptions(stack.baseDriver, "b".repeat(32)),
  );
  const waiting = await restarted.executeOnce();
  assert.equal(waiting.status, "waiting");
  assert.equal(waiting.plan.reason, "claimed_by_prior_reactor_run");
  assert.deepEqual(await stack.providerRecordKinds(), []);

  stack.now.value = stack.times.lease_expires_at;
  const requeued = await restarted.executeOnce();
  assert.equal(requeued.status, "requeued");
  const replay = await stack.eventStore.replay();
  assert.equal(replay.state.outbox[stack.effect.effect_id].status, "pending");
  assert.equal((await restarted.executeOnce()).status, "claimed");
});

test("crash after send.begin recovers from durable authorization after Packet removal", async (t) => {
  const stack = await createCanonicalReactorStack(t, { label: "post-send-begin-crash" });
  let failCommittedRead = true;
  const interruptedResolver = {
    async resolveCommittedSendAuthorization(query) {
      const proof = await stack.authorizationResolver.resolveCommittedSendAuthorization(query);
      if (failCommittedRead) {
        failCommittedRead = false;
        throw Object.assign(new Error("injected crash after durable send.begin"), {
          code: "INJECTED_AFTER_SEND_BEGIN",
        });
      }
      return proof;
    },
    resolveRetainedProviderEntryAuthorization: (query) => (
      stack.authorizationResolver.resolveRetainedProviderEntryAuthorization(query)
    ),
    resolveRecoveryAuthorization: (query) => (
      stack.authorizationResolver.resolveRecoveryAuthorization(query)
    ),
  };
  const interrupted = createBusinessCanonicalReactor({
    ...stack.reactorOptions(),
    authorizationResolver: interruptedResolver,
  });
  assert.equal((await interrupted.executeOnce()).status, "claimed");
  stack.now.value = stack.times.send_at;
  await assert.rejects(interrupted.executeOnce(), { code: "INJECTED_AFTER_SEND_BEGIN" });
  let replay = await stack.eventStore.replay();
  assert.equal(replay.state.outbox[stack.effect.effect_id].status, "sending");
  assert.deepEqual(await stack.providerRecordKinds(), []);

  await stack.removeDispatchPacket();
  const reopened = stack.reopenAuthorization();
  assert.equal(Object.hasOwn(reopened.eventStore, "commits"), false);
  const restarted = createBusinessCanonicalReactor(
    {
      ...stack.reactorOptions(stack.baseDriver, "c".repeat(32)),
      eventStore: reopened.eventStore,
      authorizationResolver: reopened.authorizationResolver,
    },
  );
  assert.equal((await restarted.executeOnce()).reason, "not_found");
  stack.now.value = stack.times.lease_expires_at;
  assert.equal((await restarted.executeOnce()).status, "delivery_unknown");
  stack.now.value = new Date(Date.parse(stack.times.lease_expires_at) + 1).toISOString();
  assert.equal((await restarted.executeOnce()).source, "recovery_probe");
  replay = await stack.eventStore.replay();
  assert.equal(replay.state.outbox[stack.effect.effect_id].status, "not_sent");
});

test("restart lookup covers an older provider entry through a later renewal receipt", async (t) => {
  const stack = await createCanonicalReactorStack(t, {
    label: "renewed-worker-result-restart",
    crashAt: "after_worker_result_persisted",
  });
  const first = createBusinessCanonicalReactor(stack.reactorOptions());
  assert.equal((await first.executeOnce()).status, "claimed");
  stack.now.value = stack.times.send_at;
  await assert.rejects(
    first.executeOnce(),
    (error) => error.code === "BUSINESS_RECORDED_FAKE_CRASH"
      && error.crash_point === "after_worker_result_persisted",
  );
  await stack.renewSendingLease("2026-08-10T01:00:20.000Z");

  const reopened = stack.reopenAuthorization();
  const restarted = createBusinessCanonicalReactor({
    ...stack.reactorOptions(stack.baseDriver, "f".repeat(32)),
    eventStore: reopened.eventStore,
    authorizationResolver: reopened.authorizationResolver,
  });
  const settled = await restarted.executeOnce();
  assert.equal(settled.status, "settled");
  assert.equal(settled.source, "worker_result");
  const evidence = await stack.baseDriver.readEvidence(settled.worker_result_ref);
  assert.equal(evidence.provider_entry_window_sequence, 0);
  assert.equal(
    (await stack.eventStore.replay()).state
      .provider_entry_windows[stack.effect.effect_id].current_window_sequence,
    1,
  );
  const records = await stack.providerRecordKinds();
  assert.equal(records.filter((kind) => kind === "provider_accepted").length, 1);
});

test("recovery probe accepts an older bound entry only through the full renewal chain", async (t) => {
  const stack = await createCanonicalReactorStack(t, {
    label: "renewed-probe-restart",
    crashAt: "after_binding",
  });
  const first = createBusinessCanonicalReactor(stack.reactorOptions());
  assert.equal((await first.executeOnce()).status, "claimed");
  stack.now.value = stack.times.send_at;
  await assert.rejects(
    first.executeOnce(),
    (error) => error.code === "BUSINESS_RECORDED_FAKE_CRASH"
      && error.crash_point === "after_binding",
  );
  await stack.renewSendingLease("2026-08-10T01:00:20.000Z");

  const reopened = stack.reopenAuthorization();
  const restarted = createBusinessCanonicalReactor({
    ...stack.reactorOptions(stack.baseDriver, "9".repeat(32)),
    eventStore: reopened.eventStore,
    authorizationResolver: reopened.authorizationResolver,
  });
  const waiting = await restarted.executeOnce();
  assert.equal(waiting.reason, "recovery_required");
  assert.equal(waiting.not_before, "2026-08-10T01:00:50.000Z");
  stack.now.value = "2026-08-10T01:00:50.000Z";
  assert.equal((await restarted.executeOnce()).status, "delivery_unknown");
  stack.now.value = "2026-08-10T01:00:50.001Z";
  const settled = await restarted.executeOnce();
  assert.equal(settled.source, "recovery_probe");
  const evidence = await stack.baseDriver.readEvidence(settled.probe_receipt_ref);
  assert.equal(evidence.provider_entry_window_sequence, 0);
  assert.equal(
    (await stack.eventStore.replay()).state
      .provider_entry_windows[stack.effect.effect_id].current_window_sequence,
    1,
  );
});

test("real-stack crash/restart matrix recovers exact evidence without remutation", async (t) => {
  for (const [index, crashPoint] of RECORDED_FAKE_CRASH_POINTS.entries()) {
    await t.test(crashPoint, async (child) => {
      const stack = await createCanonicalReactorStack(child, {
        label: `reactor-crash-${index}`,
        crashAt: crashPoint,
      });
      const first = createBusinessCanonicalReactor(stack.reactorOptions());
      assert.equal((await first.executeOnce()).status, "claimed");
      stack.now.value = stack.times.send_at;
      await assert.rejects(
        first.executeOnce(),
        (error) => error.code === "BUSINESS_RECORDED_FAKE_CRASH"
          && error.crash_point === crashPoint,
      );

      const reopened = stack.reopenAuthorization();
      const restarted = createBusinessCanonicalReactor({
        ...stack.reactorOptions(stack.baseDriver, `${index + 1}`.repeat(32)),
        eventStore: reopened.eventStore,
        authorizationResolver: reopened.authorizationResolver,
      });
      const firstRecovery = await restarted.executeOnce();
      if (["after_worker_result_persisted", "after_ack_returned"].includes(crashPoint)) {
        assert.equal(firstRecovery.status, "settled");
        assert.equal(firstRecovery.source, "worker_result");
      } else {
        assert.equal(firstRecovery.status, "waiting");
        stack.now.value = stack.times.lease_expires_at;
        assert.equal((await restarted.executeOnce()).status, "delivery_unknown");
        stack.now.value = new Date(
          Date.parse(stack.times.lease_expires_at) + 1,
        ).toISOString();
        const probed = await restarted.executeOnce();
        assert.equal(probed.status, "settled");
        assert.equal(probed.source, "recovery_probe");
      }

      const mutationWasDurable = [
        "after_provider_outcome",
        "after_worker_result_persisted",
        "after_ack_returned",
      ].includes(crashPoint);
      const replay = await stack.eventStore.replay();
      assert.equal(
        replay.state.outbox[stack.effect.effect_id].status,
        mutationWasDurable ? "delivered" : "not_sent",
      );
      const recordKinds = await stack.providerRecordKinds();
      assert.equal(
        recordKinds.filter((kind) => kind === "provider_accepted").length,
        mutationWasDurable ? 1 : 0,
      );
      if (crashPoint === "after_worker_result_persisted") {
        assert.equal(recordKinds.includes("ack_returned"), false);
        assert.equal(recordKinds.includes("not_mutated"), false);
      }
    });
  }
});
