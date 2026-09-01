"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { canonicalHash, canonicalJson } = require("@orquesta/contracts");

const {
  RECORDED_FAKE_CRASH_POINTS,
  RECORDED_FAKE_LOOKUP_CONTRACT_VERSION,
  RECORDED_FAKE_PROBE_CRASH_POINTS,
  createRecordedFakeProviderDriver,
} = require("../src/recorded-fake-provider");
const {
  V2_EFFECT_IDENTITY_FIELDS,
  deriveEffectOperationScopeHashV2,
} = require("../src/lifecycle");
const {
  advanceProviderEntryWindowIndexV1,
  createProviderEntryWindowAnchorV1,
  createProviderEntryWindowContinuationV1,
  createProviderEntryWindowIndexV1,
} = require("../src/provider-entry-window");
const {
  createCommittedSendAuthorizationProofV2,
  createSendAuthorizationBundleV1,
  deriveCommittedSendAuthorizationHashV2,
} = require("../src/send-authorization");
const {
  createRecordedFakePosixTestAdapter,
} = require("./support/recorded-fake-platform-adapter");

function hash(label) {
  return crypto.createHash("sha256").update(label, "utf8").digest("hex");
}

function contentRef(prefix, label) {
  return { id: `${prefix}:${label}`, hash: hash(`${prefix}:${label}`) };
}

function identifier(prefix, value) {
  return `${prefix}-${canonicalHash(value).slice(0, 32)}`;
}

function effectSeed(effect) {
  return Object.fromEntries(V2_EFFECT_IDENTITY_FIELDS
    .filter((field) => !["effect_id", "idempotency_key", "created_at"].includes(field))
    .map((field) => [field, effect[field]]));
}

function effectFor(_key, label = "one") {
  const packetRef = contentRef("dispatch-packet", label);
  const base = {
    effect_contract_version: 2,
    work_order_id: `WO-${hash(`work-order:${label}`).slice(0, 32)}`,
    branch_ref: `branch-${label}`,
    attempt: 1,
    dispatch_id: identifier("DSP", {
      work_order_id: `WO-${hash(`work-order:${label}`).slice(0, 32)}`,
      branch_ref: `branch-${label}`,
      attempt: 1,
      packet_ref: packetRef,
    }),
    effect_kind: "provider.thread.create",
    origin_source_id: `source-${label}`,
    operation_scope_hash: deriveEffectOperationScopeHashV2({
      effect_kind: "provider.thread.create",
      provider_ref: "recorded-fake-provider",
      packet_ref: packetRef.id,
      packet_hash: packetRef.hash,
      predecessor_effect_id: null,
      predecessor_delivery_hash: null,
      target_runtime_identity: null,
    }),
    operation_generation: 1,
    generation_predecessor_effect_id: null,
    provider_ref: "recorded-fake-provider",
    packet_ref: packetRef.id,
    packet_hash: packetRef.hash,
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

function mutationKey(label) {
  return effectFor(null, label).idempotency_key;
}

function packetVerificationReceipt(effect, label) {
  const packetRef = { id: effect.packet_ref, hash: effect.packet_hash };
  const binding = {
    work_order_id: effect.work_order_id,
    work_order_revision: 1,
    engine_contract_version: 2,
    plan_snapshot_ref: `plan-${label}`,
    plan_hash: hash(`plan-${label}`),
    branch_ref: effect.branch_ref,
    next_attempt: effect.attempt,
    task_intent_ref: contentRef("task-intent", label),
    execution_plan_ref: contentRef("execution-plan", label),
    dispatch_packet_ref: packetRef,
    provider_ref: effect.provider_ref,
    provider_configuration_ref: contentRef("provider-configuration", label),
    workspace_ref: `workspace-${label}`,
    workspace_checkpoint_ref: contentRef("workspace-checkpoint", label),
    isolation_mode: "sandbox",
    context_pack_ref: contentRef("context-pack", label),
    context_manifest_ref: contentRef("context-manifest", label),
    context_binding_hash: hash(`context-binding-${label}`),
    authority_ref: contentRef("authority", label),
    principal_type: "system",
    principal_id: `worker-${label}`,
    project_ref: `project-${label}`,
    permission_mode: "workspace-write",
    authority_ceiling_hash: hash(`authority-ceiling-${label}`),
    effect_ceiling_hash: hash(`effect-ceiling-${label}`),
  };
  const body = {
    schema_version: 1,
    disposition: "verified",
    failure_class: null,
    failure_taxonomy_version: 1,
    delivery_disposition: "not_evaluated",
    verification_scope: "packet_integrity_and_effect_binding_only",
    retry_authorization: "not_evaluated",
    packet_ref: packetRef,
    packet_binding: binding,
    effect_identity: effect,
    dispatch_identity_hash: canonicalHash({
      work_order_id: effect.work_order_id,
      branch_ref: effect.branch_ref,
      attempt: effect.attempt,
      packet_ref: packetRef,
    }),
    effect_identity_hash: canonicalHash(effect),
    effect_identifier_seed_hash: canonicalHash(effectSeed(effect)),
    generation_binding_hash: canonicalHash({
      operation_scope_hash: effect.operation_scope_hash,
      operation_generation: effect.operation_generation,
      generation_predecessor_effect_id: effect.generation_predecessor_effect_id,
    }),
  };
  const receiptHash = canonicalHash(body);
  return {
    ...body,
    receipt_ref: `dispatch-packet-verification:${receiptHash}`,
    receipt_hash: receiptHash,
  };
}

const AUTHORIZATIONS = new Map();
const PROVIDER_ENTRY_CHAINS = new Map();

function authorizationFor(effect, label) {
  const packetReceipt = packetVerificationReceipt(effect, label);
  const token = { lease_id: `lease-${label}`, owner_id: `worker-${label}`, generation: 1 };
  const internalActionId = `action-${label}`;
  const operationScopeBinding = {
    effect_kind: effect.effect_kind,
    provider_ref: effect.provider_ref,
    packet_ref: effect.packet_ref,
    packet_hash: effect.packet_hash,
    predecessor_effect_id: effect.predecessor_effect_id,
    predecessor_delivery_hash: effect.predecessor_delivery_hash,
    target_runtime_identity: effect.target_runtime_identity,
    request_id: null,
    response_ref: null,
  };
  const sendPayload = {
    work_order_id: effect.work_order_id,
    plan_snapshot_ref: `plan-${label}`,
    plan_hash: hash(`plan-${label}`),
    source_id: internalActionId,
    prior_work_order_revision: 1,
    target_work_order_revision: 1,
    occurred_at: "2026-08-10T01:00:01.000Z",
    effect_id: effect.effect_id,
    effect,
    lease_id: token.lease_id,
    lease_owner_id: token.owner_id,
    lease_generation: token.generation,
    lease_expires_at: "2026-08-10T01:10:00.000Z",
    packet_verification_receipt: packetReceipt,
    provider_settlement_cutover_id: `cutover-${label}`,
    operation_scope_binding: operationScopeBinding,
    send_authorization_contract_version: 2,
  };
  const sendEvidenceRefs = [];
  const sendEvent = {
    event_id: identifier("BVE", {
      source_id: internalActionId,
      ordinal: 0,
      type: "business.outbox.send_begun",
      payload: sendPayload,
      evidence_refs: sendEvidenceRefs,
    }),
    schema_version: 1,
    type: "business.outbox.send_begun",
    payload: sendPayload,
    evidence_refs: sendEvidenceRefs,
  };
  const batchId = `business:${internalActionId}`;
  const sendAuthorizationBundle = createSendAuthorizationBundleV1({
    send_event: sendEvent,
    batch_id: batchId,
  });
  const result = {
    internal_action_id: internalActionId,
    work_order_id: effect.work_order_id,
    work_order_revision: 1,
    effect_id: effect.effect_id,
    action: "outbox.send.begin",
    outbox_status: "sending",
    fencing_token: token,
    packet_verification_receipt: packetReceipt,
    send_authorization_bundle: sendAuthorizationBundle,
  };
  const journalReceipt = {
    source_id: internalActionId,
    source_type: "internal_action",
    identity_hash: hash(`identity-${label}`),
    payload_hash: hash(`payload-${label}`),
    work_order_id: effect.work_order_id,
    applied_revision: 1,
    batch_id: batchId,
    event_ids: [sendEvent.event_id],
    result,
  };
  const receiptPayload = {
    work_order_id: effect.work_order_id,
    plan_snapshot_ref: `plan-${label}`,
    plan_hash: hash(`plan-${label}`),
    source_id: internalActionId,
    prior_work_order_revision: 1,
    target_work_order_revision: 1,
    occurred_at: "2026-08-10T01:00:01.000Z",
    receipt: journalReceipt,
  };
  const receiptEvidenceRefs = [];
  const receiptEvent = {
    event_id: identifier("BVE", {
      source_id: internalActionId,
      ordinal: 1,
      type: "business.internal_action.received",
      payload: receiptPayload,
      evidence_refs: receiptEvidenceRefs,
    }),
    schema_version: 1,
    type: "business.internal_action.received",
    payload: receiptPayload,
    evidence_refs: receiptEvidenceRefs,
  };
  const internalReceipt = {
    ...journalReceipt,
    event_hashes: {
      [sendEvent.event_id]: canonicalHash(sendEvent),
      [receiptEvent.event_id]: canonicalHash(receiptEvent),
    },
  };
  return createCommittedSendAuthorizationProofV2({
    send_authorization_bundle: sendAuthorizationBundle,
    internal_receipt: internalReceipt,
  });
}

function readdressSendAuthorization(proof) {
  const receiptHash = canonicalHash(proof.internal_receipt);
  proof.send_authorization_receipt_ref = {
    id: `IAR-${receiptHash.slice(0, 32)}`,
    hash: receiptHash,
  };
  return proof;
}

function recoveryEligibility(base, inspectedAt) {
  const eligibilityBody = {
    eligibility_version: 1,
    eligible: true,
    state: "delivery_unknown",
    eligibility_basis_ref: contentRef("recovery-basis", base.effect.effect_id),
    eligible_at: "2026-08-10T01:10:00.000Z",
    inspected_at: inspectedAt,
  };
  const recoveryRef = (() => {
    const value = {
      authorization_hash: deriveCommittedSendAuthorizationHashV2(base),
      recovery_eligibility: eligibilityBody,
      inspected_at: inspectedAt,
    };
    const valueHash = canonicalHash(value);
    return { id: `RAR-${valueHash.slice(0, 32)}`, hash: valueHash };
  })();
  return {
    ...eligibilityBody,
    recovery_authorization_ref: recoveryRef,
  };
}

function anchorProviderEntryChain(proof) {
  return {
    proof,
    windows: [createProviderEntryWindowAnchorV1({ committed_send_authorization: proof })],
    receipts: [proof.internal_receipt],
    index: createProviderEntryWindowIndexV1({ committed_send_authorization: proof }),
  };
}

function providerEntryAuthorizationFor(key, minimumProviderEntryWindowRef = null) {
  const proof = AUTHORIZATIONS.get(key);
  if (!proof) throw Object.assign(new Error("authorization missing"), { code: "NOT_FOUND" });
  const registered = PROVIDER_ENTRY_CHAINS.get(key);
  const chain = registered && registered.proof === proof
    ? registered
    : anchorProviderEntryChain(proof);
  return providerEntryAuthorizationFromChain(chain, minimumProviderEntryWindowRef);
}

function providerEntryAuthorizationFromChain(chain, minimumProviderEntryWindowRef = null) {
  const { proof } = chain;
  const entryIndex = minimumProviderEntryWindowRef === null
    ? 0
    : chain.windows.findIndex((window) => (
      canonicalJson(window.window_ref) === canonicalJson(minimumProviderEntryWindowRef)
    ));
  if (entryIndex < 0) {
    throw Object.assign(new Error("provider entry minimum is not retained"), {
      code: "PROVIDER_ENTRY_MINIMUM_NOT_FOUND",
    });
  }
  return {
    provider_entry_authorization_version: 1,
    committed_send_authorization: structuredClone(proof),
    committed_send_authorization_hash: deriveCommittedSendAuthorizationHashV2(proof),
    entry_window: structuredClone(chain.windows[entryIndex]),
    entry_window_internal_receipt: structuredClone(chain.receipts[entryIndex]),
    continuation_chain: chain.windows.slice(entryIndex + 1).map((window, offset) => ({
      provider_entry_window: structuredClone(window),
      internal_receipt: structuredClone(chain.receipts[entryIndex + offset + 1]),
    })),
    current_window_index: structuredClone(chain.index),
  };
}

function providerEntryAuthorizationFromBase(proof, minimumProviderEntryWindowRef = null) {
  const chain = anchorProviderEntryChain(proof);
  if (minimumProviderEntryWindowRef !== null
      && canonicalJson(minimumProviderEntryWindowRef)
        !== canonicalJson(chain.windows[0].window_ref)) {
    throw Object.assign(new Error("provider entry minimum is not retained"), {
      code: "PROVIDER_ENTRY_MINIMUM_NOT_FOUND",
    });
  }
  return {
    provider_entry_authorization_version: 1,
    committed_send_authorization: structuredClone(proof),
    committed_send_authorization_hash: deriveCommittedSendAuthorizationHashV2(proof),
    entry_window: structuredClone(chain.windows[0]),
    entry_window_internal_receipt: structuredClone(chain.receipts[0]),
    continuation_chain: [],
    current_window_index: structuredClone(chain.index),
  };
}

function renewalEventFor(proof, label, occurredAt, expiresAt) {
  const sourceId = `renew-${label}`;
  const payload = {
    work_order_id: proof.effect.work_order_id,
    plan_snapshot_ref: proof.send_event.payload.plan_snapshot_ref,
    plan_hash: proof.send_event.payload.plan_hash,
    source_id: sourceId,
    prior_work_order_revision: proof.send_event.payload.target_work_order_revision,
    target_work_order_revision: proof.send_event.payload.target_work_order_revision,
    occurred_at: occurredAt,
    effect_id: proof.effect.effect_id,
    effect: proof.effect,
    lease: {
      ...proof.authorized_fencing_token,
      claimed_at: "2026-08-10T01:00:00.000Z",
      heartbeat_at: occurredAt,
      expires_at: expiresAt,
    },
  };
  return {
    event_id: identifier("BVE", {
      source_id: sourceId,
      ordinal: 0,
      type: "business.outbox.lease_renewed",
      payload,
      evidence_refs: [],
    }),
    schema_version: 1,
    type: "business.outbox.lease_renewed",
    payload,
    evidence_refs: [],
  };
}

function renewalReceiptFor(window, label) {
  const sourceEvent = window.source_event;
  const result = {
    internal_action_id: sourceEvent.payload.source_id,
    work_order_id: sourceEvent.payload.work_order_id,
    work_order_revision: sourceEvent.payload.target_work_order_revision,
    effect_id: window.effect_id,
    action: "outbox.lease.renew",
    outbox_status: "sending",
    fencing_token: window.authorized_fencing_token,
    provider_entry_window_continuation: window,
  };
  const journalReceipt = {
    source_id: sourceEvent.payload.source_id,
    source_type: "internal_action",
    identity_hash: hash(`renew-identity:${label}`),
    payload_hash: hash(`renew-payload:${label}`),
    work_order_id: sourceEvent.payload.work_order_id,
    applied_revision: sourceEvent.payload.target_work_order_revision,
    batch_id: window.batch_id,
    event_ids: [sourceEvent.event_id],
    result,
  };
  const receiptPayload = {
    work_order_id: sourceEvent.payload.work_order_id,
    plan_snapshot_ref: sourceEvent.payload.plan_snapshot_ref,
    plan_hash: sourceEvent.payload.plan_hash,
    source_id: sourceEvent.payload.source_id,
    prior_work_order_revision: sourceEvent.payload.prior_work_order_revision,
    target_work_order_revision: sourceEvent.payload.target_work_order_revision,
    occurred_at: sourceEvent.payload.occurred_at,
    receipt: journalReceipt,
  };
  const receiptEvent = {
    event_id: identifier("BVE", {
      source_id: sourceEvent.payload.source_id,
      ordinal: 1,
      type: "business.internal_action.received",
      payload: receiptPayload,
      evidence_refs: [],
    }),
    schema_version: 1,
    type: "business.internal_action.received",
    payload: receiptPayload,
    evidence_refs: [],
  };
  return {
    ...journalReceipt,
    event_hashes: {
      [sourceEvent.event_id]: canonicalHash(sourceEvent),
      [receiptEvent.event_id]: canonicalHash(receiptEvent),
    },
  };
}

function registerProviderEntryRenewals(key, label, schedule) {
  const proof = AUTHORIZATIONS.get(key);
  const anchor = createProviderEntryWindowAnchorV1({ committed_send_authorization: proof });
  const windows = [anchor];
  const receipts = [proof.internal_receipt];
  let index = createProviderEntryWindowIndexV1({ committed_send_authorization: proof });
  let previousWindow = anchor;
  let previousReceipt = null;
  for (const [ordinal, [occurredAt, expiresAt]] of schedule.entries()) {
    const hopLabel = `${label}-${ordinal + 1}`;
    const renewalEvent = renewalEventFor(proof, hopLabel, occurredAt, expiresAt);
    const window = createProviderEntryWindowContinuationV1({
      committed_send_authorization: proof,
      previous_window: previousWindow,
      renewal_event: renewalEvent,
      batch_id: `business:${renewalEvent.payload.source_id}`,
    });
    const receipt = renewalReceiptFor(window, hopLabel);
    index = advanceProviderEntryWindowIndexV1({
      committed_send_authorization: proof,
      current_index: index,
      current_window: previousWindow,
      current_window_internal_receipt: previousReceipt,
      next_window: window,
      next_window_internal_receipt: receipt,
    });
    windows.push(window);
    receipts.push(receipt);
    previousWindow = window;
    previousReceipt = receipt;
  }
  const chain = { proof, windows, receipts, index };
  PROVIDER_ENTRY_CHAINS.set(key, chain);
  return chain;
}

function invocationFor(key, label = "one", overrides = {}) {
  const effect = effectFor(key, label);
  const authorization = authorizationFor(effect, label);
  AUTHORIZATIONS.set(key, authorization);
  PROVIDER_ENTRY_CHAINS.delete(key);
  return {
    invocation_version: 1,
    effect,
    mutation_idempotency_key: key,
    send_authorization_receipt_ref: authorization.send_authorization_receipt_ref,
    provider_request_ref: authorization.provider_request_ref,
    worker_fencing_token: authorization.authorized_fencing_token,
    ...overrides,
  };
}

function acceptedOutcome(label = "one") {
  return {
    outcome_version: 1,
    classification: "accepted",
    reason: "provider_acknowledged",
    runtime_identity: {
      operation_id: `operation-${label}`,
      thread_id: `thread-${label}`,
      turn_id: null,
    },
    provider_result_ref: contentRef("provider-result", label),
    evidence_refs: [contentRef("provider-evidence", label)],
  };
}

function notSentOutcome(label = "one") {
  return {
    outcome_version: 1,
    classification: "not_sent",
    reason: "provider_rejected_no_mutation",
    runtime_identity: null,
    provider_result_ref: null,
    evidence_refs: [contentRef("provider-evidence", label)],
  };
}

async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "orquesta-recorded-fake-"));
  await fsp.chmod(root, 0o700);
  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });
  return { root, adapter: createRecordedFakePosixTestAdapter() };
}

function authorizationResolver(overrides = {}) {
  function asProviderEntryAuthorization(value, query) {
    if (value?.provider_entry_authorization_version === 1) return value;
    if (value?.authorization_version === 2) {
      return providerEntryAuthorizationFromBase(
        value,
        query.minimum_provider_entry_window_ref,
      );
    }
    return value;
  }
  return {
    async resolveSendAuthorization(query, options) {
      if (overrides.resolveSendAuthorization) {
        return asProviderEntryAuthorization(
          await overrides.resolveSendAuthorization(query, options),
          query,
        );
      }
      return providerEntryAuthorizationFor(
        query.mutation_idempotency_key,
        query.minimum_provider_entry_window_ref,
      );
    },
    async resolveRetainedProviderEntryAuthorization(query, options) {
      if (overrides.resolveRetainedProviderEntryAuthorization) {
        return asProviderEntryAuthorization(
          await overrides.resolveRetainedProviderEntryAuthorization(query, options),
          query,
        );
      }
      return providerEntryAuthorizationFor(
        query.mutation_idempotency_key,
        query.minimum_provider_entry_window_ref,
      );
    },
    async resolveRecoveryAuthorization(query) {
      if (overrides.resolveRecoveryAuthorization) {
        return overrides.resolveRecoveryAuthorization(query);
      }
      const proof = AUTHORIZATIONS.get(query.mutation_idempotency_key);
      if (!proof) throw Object.assign(new Error("authorization missing"), { code: "NOT_FOUND" });
      return {
        provider_entry_authorization: providerEntryAuthorizationFor(
          query.mutation_idempotency_key,
          query.minimum_provider_entry_window_ref,
        ),
        recovery_eligibility: recoveryEligibility(proof, query.inspected_at),
      };
    },
  };
}

function driverFor(
  root,
  adapter,
  outcomes,
  resolver = authorizationResolver(),
  clock = ({ purpose } = {}) => (purpose === "recovery_inspection"
    ? "2026-08-10T01:20:00.000Z"
    : "2026-08-10T01:00:02.500Z"),
) {
  return createRecordedFakeProviderDriver({
    root_path: root,
    platform_adapter: adapter,
    recorded_outcomes: outcomes,
    authorization_resolver: resolver,
    clock,
    test_only_allow_process_local_adapter: true,
  });
}

function probeFor(invocation, inspectedAt = "2026-08-10T01:10:05.000Z") {
  return {
    probe_version: 1,
    mutation_idempotency_key: invocation.mutation_idempotency_key,
    expected_effect_id: invocation.effect.effect_id,
    send_authorization_receipt_ref: invocation.send_authorization_receipt_ref,
    inspected_at: inspectedAt,
  };
}

function sequenceClock(values) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

async function recordKinds(root) {
  const result = [];
  for (const name of await fsp.readdir(root)) {
    if (!name.endsWith(".json")) continue;
    const record = JSON.parse(await fsp.readFile(path.join(root, name), "utf8"));
    if (record.record_kind) result.push(record.record_kind);
  }
  return result.sort();
}

test("accepted mutation durably binds exact key, authorization, callback token, markers, and evidence", async (t) => {
  const { root, adapter } = await fixture(t);
  const key = mutationKey("accepted");
  const invocation = invocationFor(key, "accepted");
  const driver = driverFor(root, adapter, { [key]: acceptedOutcome("accepted") });

  const result = await driver.executeMutation(invocation);
  assert.equal(result.classification, "accepted");
  assert.equal(result.mutation_idempotency_key, key);
  assert.equal(result.retry_authorization, "not_evaluated");
  assert.deepEqual(result.callback_fencing_token, invocation.worker_fencing_token);
  assert.match(result.worker_result_ref.id, /^WRR-[a-f0-9]{32}$/u);

  const evidence = await driver.readEvidence(result.worker_result_ref);
  assert.equal(evidence.evidence_version, 2);
  assert.equal(evidence.evidence_kind, "worker_result");
  assert.equal(evidence.effect_id, invocation.effect.effect_id);
  assert.equal(evidence.mutation_idempotency_key, key);
  assert.deepEqual(evidence.worker_fencing_token, invocation.worker_fencing_token);
  assert.deepEqual(
    evidence.send_authorization_receipt_ref,
    invocation.send_authorization_receipt_ref,
  );
  assert.deepEqual(evidence.provider_request_ref, invocation.provider_request_ref);
  assert.equal(evidence.retry_authorization, "not_evaluated");
  assert.equal(evidence.entry_checked_at, "2026-08-10T01:00:02.500Z");
  assert.equal(evidence.mutation_entry_checked_at, "2026-08-10T01:00:02.500Z");
  assert.equal(
    AUTHORIZATIONS.get(key).send_begin_lease_expires_at,
    "2026-08-10T01:10:00.000Z",
  );
  const authorizationHash = deriveCommittedSendAuthorizationHashV2(AUTHORIZATIONS.get(key));
  assert.equal(evidence.authorization_hash, authorizationHash);

  const durableRecords = [];
  for (const name of await fsp.readdir(root)) {
    if (!name.startsWith("recorded-fake-") || !name.endsWith(".json")) continue;
    const record = JSON.parse(await fsp.readFile(path.join(root, name), "utf8"));
    if (["binding", "call_entered", "provider_accepted", "ack_returned"]
      .includes(record.record_kind)) durableRecords.push(record);
  }
  assert.equal(durableRecords.length, 4);
  assert.equal(durableRecords.every((record) => record.record_version === 2), true);
  assert.equal(durableRecords.every((record) => record.authorization_hash === authorizationHash), true);
  const durableEntryCore = {
    provider_entry_window_ref: evidence.provider_entry_window_ref,
    provider_entry_window_sequence: evidence.provider_entry_window_sequence,
    provider_entry_window_lease_expires_at:
      evidence.provider_entry_window_lease_expires_at,
    provider_entry_window_fencing_token: evidence.provider_entry_window_fencing_token,
  };
  assert.equal(durableRecords.every((record) => canonicalJson({
    provider_entry_window_ref: record.provider_entry_window_ref,
    provider_entry_window_sequence: record.provider_entry_window_sequence,
    provider_entry_window_lease_expires_at: record.provider_entry_window_lease_expires_at,
    provider_entry_window_fencing_token: record.provider_entry_window_fencing_token,
  }) === canonicalJson(durableEntryCore)), true);

  assert.deepEqual(await recordKinds(root), [
    "ack_returned",
    "binding",
    "call_entered",
    "provider_accepted",
  ]);
  for (const name of await fsp.readdir(root)) {
    const stat = await fsp.stat(path.join(root, name));
    assert.equal(stat.mode & 0o077, 0, name);
  }

  const probe = await driver.inspectByExactKey(probeFor(invocation));
  assert.equal(probe.classification, "accepted");
  assert.equal(probe.probe_classification, "found");
  assert.equal(probe.reason, "recovery_probe_found");
  assert.equal(probe.retry_authorization, "not_evaluated");
  const probeEvidence = await driver.readEvidence(probe.probe_receipt_ref);
  assert.equal(probeEvidence.evidence_version, 2);
  assert.equal(probeEvidence.evidence_kind, "recovery_probe");
  assert.equal(probeEvidence.classification, "accepted");
  assert.deepEqual(probeEvidence.provider_entry_window_ref, evidence.provider_entry_window_ref);
  assert.deepEqual(
    probeEvidence.provider_entry_window_fencing_token,
    evidence.provider_entry_window_fencing_token,
  );
  assert.deepEqual(probeEvidence.worker_result_ref, result.worker_result_ref);
});

test("not-sent recording uses the mutually exclusive immutable not_mutated marker", async (t) => {
  const { root, adapter } = await fixture(t);
  const key = mutationKey("not-sent");
  const invocation = invocationFor(key, "not-sent");
  const driver = driverFor(root, adapter, { [key]: notSentOutcome("not-sent") });

  const result = await driver.executeMutation(invocation);
  assert.equal(result.classification, "not_sent");
  assert.equal(result.reason, "provider_rejected_no_mutation");
  assert.equal(result.runtime_identity, null);
  assert.deepEqual(await recordKinds(root), [
    "ack_returned",
    "binding",
    "call_entered",
    "not_mutated",
  ]);

  const evidence = await driver.readEvidence(result.worker_result_ref);
  assert.equal(evidence.classification, "not_sent");
  assert.equal(evidence.provider_result_ref, null);
  const probe = await driver.inspectByExactKey(probeFor(invocation));
  assert.equal(probe.probe_classification, "authoritative_absence");
  assert.equal(probe.classification, "not_sent");
});

test("same exact invocation is idempotent and concurrent calls produce one provider outcome", async (t) => {
  const { root, adapter } = await fixture(t);
  const key = mutationKey("concurrent");
  const invocation = invocationFor(key, "concurrent");
  const outcomes = { [key]: acceptedOutcome("concurrent") };
  const firstDriver = driverFor(root, adapter, outcomes);
  const secondDriver = driverFor(root, adapter, outcomes);

  const [first, second] = await Promise.all([
    firstDriver.executeMutation(invocation),
    secondDriver.executeMutation(invocation),
  ]);
  assert.deepEqual(first, second);
  const kinds = await recordKinds(root);
  assert.equal(kinds.filter((kind) => kind === "provider_accepted").length, 1);
  assert.equal(kinds.filter((kind) => kind === "ack_returned").length, 1);
});

test("an absent short-read authority is discarded when another executor wins before reread", async (t) => {
  const { root, adapter } = await fixture(t);
  const label = "short-read-reread-race";
  const key = mutationKey(label);
  const invocation = invocationFor(key, label);
  const outcomes = { [key]: acceptedOutcome(label) };
  let releaseFirstResolve;
  let announceFirstResolve;
  const firstResolveReached = new Promise((resolve) => { announceFirstResolve = resolve; });
  const release = new Promise((resolve) => { releaseFirstResolve = resolve; });
  let liveCalls = 0;
  let retainedCalls = 0;
  const delayedResolver = authorizationResolver({
    async resolveSendAuthorization(query) {
      liveCalls += 1;
      announceFirstResolve();
      await release;
      return providerEntryAuthorizationFor(
        query.mutation_idempotency_key,
        query.minimum_provider_entry_window_ref,
      );
    },
    async resolveRetainedProviderEntryAuthorization(query) {
      retainedCalls += 1;
      return providerEntryAuthorizationFor(
        query.mutation_idempotency_key,
        query.minimum_provider_entry_window_ref,
      );
    },
  });
  const delayed = driverFor(root, adapter, outcomes, delayedResolver);
  const winner = driverFor(root, adapter, outcomes);
  const delayedExecution = delayed.executeMutation(invocation);
  await firstResolveReached;
  const winnerResult = await winner.executeMutation(invocation);
  releaseFirstResolve();
  const delayedResult = await delayedExecution;
  assert.deepEqual(delayedResult, winnerResult);
  assert.equal(liveCalls, 1);
  assert.equal(retainedCalls, 1);
  assert.equal((await recordKinds(root)).filter((kind) => kind === "provider_accepted").length, 1);
});

test("a mutation key cannot be rebound to another token, request, effect, or recorded outcome", async (t) => {
  const { root, adapter } = await fixture(t);
  const key = mutationKey("conflict");
  const invocation = invocationFor(key, "conflict");
  const first = driverFor(root, adapter, { [key]: acceptedOutcome("conflict") });
  await first.executeMutation(invocation);

  const changedToken = invocationFor(key, "conflict", {
    worker_fencing_token: { ...invocation.worker_fencing_token, generation: 2 },
  });
  await assert.rejects(
    first.executeMutation(changedToken),
    { code: "BUSINESS_RECORDED_FAKE_AUTHORIZATION_FAILED" },
  );

  const changedOutcome = acceptedOutcome("conflict-changed");
  const restarted = driverFor(root, adapter, { [key]: changedOutcome });
  await assert.rejects(
    restarted.executeMutation(invocation),
    { code: "BUSINESS_RECORDED_FAKE_MUTATION_CONFLICT" },
  );
  assert.equal((await recordKinds(root)).filter((kind) => kind === "provider_accepted").length, 1);
});

test("deterministic mutation crash points recover only through exact-key evidence and never duplicate mutation", async (t) => {
  assert.deepEqual(RECORDED_FAKE_CRASH_POINTS, [
    "before_binding",
    "after_binding",
    "after_call_entered",
    "after_provider_outcome",
    "after_worker_result_persisted",
    "after_ack_returned",
  ]);

  for (const [index, crashPoint] of RECORDED_FAKE_CRASH_POINTS.entries()) {
    await t.test(crashPoint, async (child) => {
      const { root, adapter } = await fixture(child);
      const label = `crash-${index}`;
      const key = mutationKey(label);
      const invocation = invocationFor(key, label);
      const outcomes = { [key]: acceptedOutcome(label) };
      const driver = driverFor(root, adapter, outcomes);

      await assert.rejects(
        driver.executeMutation(invocation, { crash_at: crashPoint }),
        (error) => error.code === "BUSINESS_RECORDED_FAKE_CRASH"
          && error.crash_point === crashPoint,
      );

      const restarted = driverFor(root, adapter, outcomes);
      const probe = await restarted.inspectByExactKey(probeFor(invocation));
      const mutationCouldBeAccepted = [
        "after_provider_outcome",
        "after_worker_result_persisted",
        "after_ack_returned",
      ].includes(crashPoint);
      assert.equal(probe.classification, mutationCouldBeAccepted ? "accepted" : "not_sent");
      assert.equal(
        probe.probe_classification,
        mutationCouldBeAccepted ? "found" : "authoritative_absence",
      );
      assert.equal(probe.retry_authorization, "not_evaluated");
      await restarted.readEvidence(probe.probe_receipt_ref);

      if (mutationCouldBeAccepted) {
        const replayedAck = await restarted.executeMutation(invocation);
        assert.equal(replayedAck.classification, "accepted");
        const exactReplay = await restarted.executeMutation(invocation);
        assert.deepEqual(exactReplay, replayedAck);
        assert.equal(
          (await recordKinds(root)).filter((kind) => kind === "provider_accepted").length,
          1,
        );
      } else {
        await assert.rejects(
          restarted.executeMutation(invocation),
          { code: "BUSINESS_RECORDED_FAKE_MUTATION_SEALED" },
        );
        assert.equal(
          (await recordKinds(root)).filter((kind) => kind === "provider_accepted").length,
          0,
        );
        assert.equal(
          (await recordKinds(root)).filter((kind) => kind === "not_mutated").length,
          1,
        );
      }
    });
  }
});

test("an interrupted invocation cannot be re-mutated before recovery inspection", async (t) => {
  const { root, adapter } = await fixture(t);
  const key = mutationKey("requires-probe");
  const invocation = invocationFor(key, "requires-probe");
  const outcomes = { [key]: acceptedOutcome("requires-probe") };
  const driver = driverFor(root, adapter, outcomes);

  await assert.rejects(
    driver.executeMutation(invocation, { crash_at: "after_call_entered" }),
    { code: "BUSINESS_RECORDED_FAKE_CRASH" },
  );
  const restarted = driverFor(root, adapter, outcomes);
  await assert.rejects(
    restarted.executeMutation(invocation),
    (error) => error.code === "BUSINESS_RECORDED_FAKE_RECOVERY_REQUIRED"
      && error.retry_authorization === "not_evaluated",
  );
  const probe = await restarted.inspectByExactKey(probeFor(invocation));
  assert.equal(probe.classification, "not_sent");
  await assert.rejects(
    restarted.executeMutation(invocation),
    { code: "BUSINESS_RECORDED_FAKE_MUTATION_SEALED" },
  );
});

test("probe seals an absent exact key before reporting authoritative absence", async (t) => {
  const { root, adapter } = await fixture(t);
  const key = mutationKey("absent");
  const invocation = invocationFor(key, "absent");
  const outcomes = { [key]: acceptedOutcome("absent") };
  const driver = driverFor(root, adapter, outcomes);

  const first = await driver.inspectByExactKey(probeFor(invocation));
  const second = await driver.inspectByExactKey(probeFor(invocation));
  assert.deepEqual(first, second);
  assert.equal(first.classification, "not_sent");
  assert.equal(first.reason, "recovery_probe_authoritative_absence");
  assert.deepEqual(await recordKinds(root), ["not_mutated"]);
  await assert.rejects(
    driver.executeMutation(invocation),
    { code: "BUSINESS_RECORDED_FAKE_MUTATION_SEALED" },
  );

  const laterProbe = await driver.inspectByExactKey(
    probeFor(invocation, "2026-08-10T01:10:06.000Z"),
  );
  assert.notDeepEqual(laterProbe.probe_receipt_ref, first.probe_receipt_ref);
});

test("probe effect identity must match the mutation-key binding", async (t) => {
  const { root, adapter } = await fixture(t);
  const key = mutationKey("probe-conflict");
  const invocation = invocationFor(key, "probe-conflict");
  const driver = driverFor(root, adapter, { [key]: acceptedOutcome("probe-conflict") });
  await driver.executeMutation(invocation);

  await assert.rejects(
    driver.inspectByExactKey({
      ...probeFor(invocation),
      expected_effect_id: `FX-${hash("different-effect").slice(0, 32)}`,
    }),
    { code: "BUSINESS_RECORDED_FAKE_RECOVERY_NOT_AUTHORIZED" },
  );
});

test("durability proof is mandatory and directory-fsync uncertainty never becomes a provider classification", async (t) => {
  const { root, adapter } = await fixture(t);
  const key = mutationKey("proof");
  const invocation = invocationFor(key, "proof");
  const outcomes = { [key]: acceptedOutcome("proof") };

  assert.throws(
    () => driverFor(root, {}, outcomes),
    { code: "BUSINESS_RECORDED_FAKE_CONFIGURATION_INVALID" },
  );

  const invalidProofAdapter = {
    ...adapter,
    async openStore(input) {
      const session = await adapter.openStore(input);
      return { ...session, proof: { ...session.proof, atomic_mutation_index: false } };
    },
  };
  const invalidProofDriver = driverFor(root, invalidProofAdapter, outcomes);
  await assert.rejects(
    invalidProofDriver.executeMutation(invocation),
    { code: "BUSINESS_RECORDED_FAKE_SECURITY_UNVERIFIED" },
  );

  let failOnce = true;
  const uncertainAdapter = {
    ...adapter,
    async fsyncDirectory(input) {
      if (failOnce) {
        failOnce = false;
        throw Object.assign(new Error("injected directory fsync failure"), { code: "EIO" });
      }
      return adapter.fsyncDirectory(input);
    },
  };
  const uncertainDriver = driverFor(root, uncertainAdapter, outcomes);
  await assert.rejects(
    uncertainDriver.executeMutation(invocation),
    (error) => error.code === "BUSINESS_RECORDED_FAKE_DURABILITY_UNCERTAIN"
      && error.retry_authorization === "not_evaluated"
      && error.classification === undefined,
  );

  const recovered = driverFor(root, adapter, outcomes);
  const probe = await recovered.inspectByExactKey(probeFor(invocation));
  assert.equal(probe.classification, "not_sent");
});

test("no-follow platform boundary rejects evidence-file symlink substitution", async (t) => {
  const { root, adapter } = await fixture(t);
  const key = mutationKey("symlink");
  const invocation = invocationFor(key, "symlink");
  const driver = driverFor(root, adapter, { [key]: acceptedOutcome("symlink") });
  const result = await driver.executeMutation(invocation);
  const evidenceName = `recorded-fake-evidence-${result.worker_result_ref.hash}.json`;
  const evidencePath = path.join(root, evidenceName);
  const replacement = path.join(root, "replacement.json");
  await fsp.writeFile(replacement, "{}\n", { mode: 0o600 });
  await fsp.unlink(evidencePath);
  await fsp.symlink(replacement, evidencePath);

  await assert.rejects(
    driver.readEvidence(result.worker_result_ref),
    { code: "BUSINESS_RECORDED_FAKE_SECURITY_UNVERIFIED" },
  );
});

test("content-addressed evidence detects canonical-byte tampering", async (t) => {
  const { root, adapter } = await fixture(t);
  const key = mutationKey("tamper");
  const invocation = invocationFor(key, "tamper");
  const driver = driverFor(root, adapter, { [key]: acceptedOutcome("tamper") });
  const result = await driver.executeMutation(invocation);
  const evidencePath = path.join(
    root,
    `recorded-fake-evidence-${result.worker_result_ref.hash}.json`,
  );
  const record = JSON.parse(await fsp.readFile(evidencePath, "utf8"));
  record.reason = "provider_rejected_no_mutation";
  await fsp.writeFile(evidencePath, `${JSON.stringify(record)}\n`, { mode: 0o600 });

  await assert.rejects(
    driver.readEvidence(result.worker_result_ref),
    { code: "BUSINESS_RECORDED_FAKE_RECORD_CORRUPT" },
  );
});

test("legacy v1 durable records and mixed PEW cores fail closed without migration", async (t) => {
  await t.test("legacy binding version", async (child) => {
    const { root, adapter } = await fixture(child);
    const label = "legacy-binding-v1";
    const key = mutationKey(label);
    const invocation = invocationFor(key, label);
    const driver = driverFor(root, adapter, { [key]: acceptedOutcome(label) });
    await driver.executeMutation(invocation);
    const bindingName = (await fsp.readdir(root)).find((name) => name.endsWith("-binding.json"));
    const bindingPath = path.join(root, bindingName);
    const binding = JSON.parse(await fsp.readFile(bindingPath, "utf8"));
    binding.record_version = 1;
    await fsp.writeFile(bindingPath, `${canonicalJson(binding)}\n`, { mode: 0o600 });
    await assert.rejects(
      driver.readAuthorizedMutationResult(invocation),
      { code: "BUSINESS_RECORDED_FAKE_RECORD_CORRUPT" },
    );
  });

  const markerScenarios = [
    ["call-entered.json", (record) => {
      record.provider_entry_window_fencing_token.generation += 1;
    }],
    ["provider-accepted.json", (record) => {
      record.provider_entry_window_lease_expires_at = "2026-08-10T01:09:59.000Z";
    }],
    ["ack-returned.json", (record) => {
      record.provider_entry_window_sequence += 1;
    }],
  ];
  for (const [suffix, mutate] of markerScenarios) {
    await t.test(`mixed core ${suffix}`, async (child) => {
      const { root, adapter } = await fixture(child);
      const label = `mixed-core-${suffix}`;
      const key = mutationKey(label);
      const invocation = invocationFor(key, label);
      const driver = driverFor(root, adapter, { [key]: acceptedOutcome(label) });
      await driver.executeMutation(invocation);
      const name = (await fsp.readdir(root)).find((entry) => entry.endsWith(suffix));
      const targetPath = path.join(root, name);
      const record = JSON.parse(await fsp.readFile(targetPath, "utf8"));
      mutate(record);
      await fsp.writeFile(targetPath, `${canonicalJson(record)}\n`, { mode: 0o600 });
      await assert.rejects(
        driver.readAuthorizedMutationResult(invocation),
        { code: "BUSINESS_RECORDED_FAKE_RECORD_CORRUPT" },
      );
    });
  }
});

test("the driver rejects non-exact mutation-key and outcome contracts before durable call entry", async (t) => {
  const { root, adapter } = await fixture(t);
  const key = mutationKey("invalid");
  const invocation = invocationFor(key, "invalid");
  const differentKey = mutationKey("different");
  const driver = driverFor(root, adapter, { [key]: acceptedOutcome("invalid") });

  await assert.rejects(
    driver.executeMutation({ ...invocation, mutation_idempotency_key: differentKey }),
    { code: "BUSINESS_RECORDED_FAKE_MUTATION_CONFLICT" },
  );
  assert.deepEqual(await fsp.readdir(root), []);

  await assert.rejects(
    driver.executeMutation({
      ...invocation,
      minimum_provider_entry_window_ref: contentRef("PEW", "caller-selected"),
    }),
    { code: "BUSINESS_RECORDED_FAKE_INPUT_INVALID" },
  );
  assert.deepEqual(await fsp.readdir(root), []);

  assert.throws(
    () => driverFor(root, adapter, {
      [key]: { ...acceptedOutcome("invalid"), provider_result_ref: null },
    }),
    { code: "BUSINESS_RECORDED_FAKE_CONFIGURATION_INVALID" },
  );
});

test("trusted authorization resolver and explicit test-only platform opt-in are mandatory", async (t) => {
  const { root, adapter } = await fixture(t);
  const key = mutationKey("configuration-gates");
  const invocation = invocationFor(key, "configuration-gates");
  assert.throws(
    () => createRecordedFakeProviderDriver({
      root_path: root,
      platform_adapter: adapter,
      recorded_outcomes: { [key]: acceptedOutcome("configuration-gates") },
    }),
    { code: "BUSINESS_RECORDED_FAKE_CONFIGURATION_INVALID" },
  );
  assert.throws(
    () => createRecordedFakeProviderDriver({
      root_path: root,
      platform_adapter: adapter,
      recorded_outcomes: { [key]: acceptedOutcome("configuration-gates") },
      authorization_resolver: authorizationResolver(),
    }),
    { code: "BUSINESS_RECORDED_FAKE_CONFIGURATION_INVALID" },
  );

  const failClosed = createRecordedFakeProviderDriver({
    root_path: root,
    platform_adapter: adapter,
    recorded_outcomes: { [key]: acceptedOutcome("configuration-gates") },
    authorization_resolver: authorizationResolver(),
    clock: () => "2026-08-10T01:00:02.500Z",
  });
  await assert.rejects(
    failClosed.executeMutation(invocation),
    { code: "BUSINESS_RECORDED_FAKE_SECURITY_UNVERIFIED" },
  );
  assert.deepEqual(await fsp.readdir(root), []);
});

test("capability proof and authorized lookup are exact and lookup never seals", async (t) => {
  const { root, adapter } = await fixture(t);
  const key = mutationKey("lookup");
  const invocation = invocationFor(key, "lookup");
  const driver = driverFor(root, adapter, { [key]: acceptedOutcome("lookup") });
  assert.equal(driver.authorization_contract_version, 2);
  assert.equal(RECORDED_FAKE_LOOKUP_CONTRACT_VERSION, 1);
  assert.deepEqual(driver.capabilities(), {
    authorization_contract_version: 2,
    provider_entry_authorization_version: 1,
    driver_contract_version: 1,
    mutation_execution: "stable_committed_send_plus_current_provider_entry_window_required",
    provider_entry_window: "contiguous_resolver_chain_rechecked_before_provider_entry",
    recovery_inspection:
      "stable_committed_send_provider_entry_window_and_recovery_eligibility_required",
    authorized_result_lookup: "retained_provider_entry_authorization_read_only",
    process_local_test_adapter: "explicit_opt_in_only",
  });
  assert.deepEqual(await driver.readAuthorizedMutationResult(invocation), {
    lookup_contract_version: 1,
    effect_id: invocation.effect.effect_id,
    mutation_idempotency_key: key,
    status: "not_found",
  });
  assert.deepEqual(await fsp.readdir(root), []);

  await assert.rejects(
    driver.executeMutation(invocation, { crash_at: "after_provider_outcome" }),
    { code: "BUSINESS_RECORDED_FAKE_CRASH" },
  );
  const interrupted = await driver.readAuthorizedMutationResult(structuredClone(invocation));
  assert.equal(interrupted.status, "recovery_required");
  assert.equal(interrupted.durable_stage, "provider_outcome");
  const completed = await driver.executeMutation(structuredClone(invocation));
  const lookup = await driver.readAuthorizedMutationResult(structuredClone(invocation));
  assert.equal(lookup.status, "worker_result");
  assert.deepEqual(lookup.result, completed);
  assert.deepEqual(lookup.worker_result_ref, completed.worker_result_ref);
});

test("durable worker result is immediately readable before acknowledgement on restart", async (t) => {
  const { root, adapter } = await fixture(t);
  const key = mutationKey("lookup-before-ack");
  const invocation = invocationFor(key, "lookup-before-ack");
  const outcomes = { [key]: acceptedOutcome("lookup-before-ack") };
  const first = driverFor(root, adapter, outcomes);

  await assert.rejects(
    first.executeMutation(invocation, { crash_at: "after_worker_result_persisted" }),
    { code: "BUSINESS_RECORDED_FAKE_CRASH" },
  );
  assert.deepEqual(await recordKinds(root), [
    "binding",
    "call_entered",
    "provider_accepted",
  ]);

  const restarted = driverFor(root, adapter, outcomes);
  const lookup = await restarted.readAuthorizedMutationResult(structuredClone(invocation));
  assert.equal(lookup.status, "worker_result");
  assert.equal(lookup.result.classification, "accepted");
  assert.deepEqual(lookup.result.worker_result_ref, lookup.worker_result_ref);
  const evidence = await restarted.readEvidence(lookup.worker_result_ref);
  assert.equal(evidence.evidence_kind, "worker_result");
  assert.equal(evidence.effect_id, invocation.effect.effect_id);
  assert.equal(evidence.mutation_idempotency_key, key);
  assert.deepEqual(
    await restarted.readAuthorizedMutationResult(structuredClone(invocation)),
    lookup,
  );
  const kinds = await recordKinds(root);
  assert.equal(kinds.filter((kind) => kind === "provider_accepted").length, 1);
  assert.equal(kinds.includes("ack_returned"), false);
  assert.equal(kinds.includes("not_mutated"), false);
});

test("stable SAB authority survives restart while entry remains inside its send-begin window", async (t) => {
  for (const crashPoint of ["after_provider_outcome", "after_worker_result_persisted"]) {
    await t.test(crashPoint, async (subtest) => {
      const { root, adapter } = await fixture(subtest);
      const label = `renewed-lease-${crashPoint}`;
      const key = mutationKey(label);
      const invocation = invocationFor(key, label);
      const outcomes = { [key]: acceptedOutcome(label) };
      const entryProof = AUTHORIZATIONS.get(key);
      const entryAuthorizationHash = deriveCommittedSendAuthorizationHashV2(entryProof);
      const first = driverFor(root, adapter, outcomes);

      await assert.rejects(
        first.executeMutation(invocation, { crash_at: crashPoint }),
        { code: "BUSINESS_RECORDED_FAKE_CRASH" },
      );
      const currentLeaseExpiresAt = "2026-08-10T01:20:00.000Z";
      const renewedLiveResolver = authorizationResolver({
        async resolveSendAuthorization(query) {
          assert.equal(query.authorization_contract_version, 2);
          assert.equal(
            Date.parse(currentLeaseExpiresAt)
              > Date.parse(entryProof.send_begin_lease_expires_at),
            true,
          );
          return structuredClone(entryProof);
        },
      });
      const restarted = driverFor(root, adapter, outcomes, renewedLiveResolver);
      const lookup = await restarted.readAuthorizedMutationResult(structuredClone(invocation));
      if (crashPoint === "after_worker_result_persisted") {
        assert.equal(lookup.status, "worker_result");
      } else {
        assert.equal(lookup.status, "recovery_required");
        assert.equal(lookup.durable_stage, "provider_outcome");
      }
      const result = crashPoint === "after_worker_result_persisted"
        ? lookup.result
        : await restarted.executeMutation(structuredClone(invocation));
      const evidence = await restarted.readEvidence(result.worker_result_ref);
      assert.equal(evidence.authorization_hash, entryAuthorizationHash);
      assert.equal(
        (await recordKinds(root)).filter((kind) => kind === "provider_accepted").length,
        1,
      );
    });
  }

  await t.test("stable SAB proof drift remains rejected", async (subtest) => {
    const { root, adapter } = await fixture(subtest);
    const label = "renewed-lease-proof-drift";
    const key = mutationKey(label);
    const invocation = invocationFor(key, label);
    const outcomes = { [key]: acceptedOutcome(label) };
    const first = driverFor(root, adapter, outcomes);
    await assert.rejects(
      first.executeMutation(invocation, { crash_at: "after_worker_result_persisted" }),
      { code: "BUSINESS_RECORDED_FAKE_CRASH" },
    );
    const forged = structuredClone(AUTHORIZATIONS.get(key));
    forged.commit.event_hashes[forged.send_event.event_id] = hash("forged-send-event");
    AUTHORIZATIONS.set(key, forged);

    const restarted = driverFor(root, adapter, outcomes);
    await assert.rejects(
      restarted.readAuthorizedMutationResult(structuredClone(invocation)),
      { code: "BUSINESS_RECORDED_FAKE_AUTHORIZATION_FAILED" },
    );
  });

  await t.test("a cleared live lease cannot revoke retained read-only completion", async (subtest) => {
    const { root, adapter } = await fixture(subtest);
    const label = "renewed-lease-cleared";
    const key = mutationKey(label);
    const invocation = invocationFor(key, label);
    const outcomes = { [key]: acceptedOutcome(label) };
    const first = driverFor(root, adapter, outcomes);
    await assert.rejects(
      first.executeMutation(invocation, { crash_at: "after_worker_result_persisted" }),
      { code: "BUSINESS_RECORDED_FAKE_CRASH" },
    );
    let liveCalls = 0;
    let retainedCalls = 0;
    const leaseClearedResolver = authorizationResolver({
      async resolveSendAuthorization() {
        liveCalls += 1;
        throw Object.assign(new Error("current sending lease was cleared"), {
          code: "CURRENT_SEND_LEASE_CLEARED",
        });
      },
      async resolveRetainedProviderEntryAuthorization(query) {
        retainedCalls += 1;
        return providerEntryAuthorizationFor(
          query.mutation_idempotency_key,
          query.minimum_provider_entry_window_ref,
        );
      },
    });
    const restarted = driverFor(root, adapter, outcomes, leaseClearedResolver);
    const lookup = await restarted.readAuthorizedMutationResult(structuredClone(invocation));
    assert.equal(lookup.status, "worker_result");
    assert.equal(liveCalls, 0);
    assert.equal(retainedCalls, 1);
  });
});

test("same-token PEW renewal authorizes provider entry after stable send-begin expiry", async (t) => {
  const { root, adapter } = await fixture(t);
  const label = "pew-renewed-after-base-expiry";
  const key = mutationKey(label);
  const invocation = invocationFor(key, label);
  const chain = registerProviderEntryRenewals(key, label, [
    ["2026-08-10T01:05:00.000Z", "2026-08-10T01:20:00.000Z"],
  ]);
  const queries = [];
  const resolver = authorizationResolver({
    async resolveSendAuthorization(query) {
      queries.push(structuredClone(query));
      return providerEntryAuthorizationFor(
        query.mutation_idempotency_key,
        query.minimum_provider_entry_window_ref,
      );
    },
  });
  const driver = driverFor(
    root,
    adapter,
    { [key]: acceptedOutcome(label) },
    resolver,
    () => "2026-08-10T01:10:01.000Z",
  );
  const result = await driver.executeMutation(invocation);
  assert.equal(result.classification, "accepted");
  assert.equal(queries.length, 2);
  assert.equal(queries[0].minimum_provider_entry_window_ref, null);
  assert.deepEqual(
    queries[1].minimum_provider_entry_window_ref,
    chain.windows[1].window_ref,
  );
  const evidence = await driver.readEvidence(result.worker_result_ref);
  assert.equal(
    evidence.authorization_hash,
    deriveCommittedSendAuthorizationHashV2(AUTHORIZATIONS.get(key)),
  );
  assert.deepEqual(evidence.provider_entry_window_ref, chain.windows[1].window_ref);
  assert.equal(evidence.provider_entry_window_sequence, 1);
  assert.equal(
    evidence.provider_entry_window_lease_expires_at,
    "2026-08-10T01:20:00.000Z",
  );
  assert.deepEqual(
    evidence.provider_entry_window_fencing_token,
    invocation.worker_fencing_token,
  );
  for (const name of await fsp.readdir(root)) {
    if (!name.endsWith(".json")) continue;
    const record = JSON.parse(await fsp.readFile(path.join(root, name), "utf8"));
    if (!record.record_kind && !record.evidence_kind) continue;
    if (record.evidence_kind === "recovery_probe") continue;
    assert.equal(record.provider_entry_window_sequence, 1, name);
    assert.deepEqual(record.provider_entry_window_ref, chain.windows[1].window_ref, name);
    assert.deepEqual(
      record.provider_entry_window_fencing_token,
      invocation.worker_fencing_token,
      name,
    );
  }
});

test("renewed PEW covers every mutation crash point without reopening provider entry", async (t) => {
  for (const [ordinal, crashPoint] of RECORDED_FAKE_CRASH_POINTS.entries()) {
    await t.test(crashPoint, async (child) => {
      const { root, adapter } = await fixture(child);
      const label = `pew-crash-${ordinal}`;
      const key = mutationKey(label);
      const invocation = invocationFor(key, label);
      registerProviderEntryRenewals(key, label, [
        ["2026-08-10T01:05:00.000Z", "2026-08-10T01:20:00.000Z"],
      ]);
      const outcomes = { [key]: acceptedOutcome(label) };
      const renewedClock = ({ purpose } = {}) => (purpose === "recovery_inspection"
        ? "2026-08-10T01:20:30.000Z"
        : "2026-08-10T01:10:01.000Z");
      const first = driverFor(
        root,
        adapter,
        outcomes,
        authorizationResolver(),
        renewedClock,
      );
      await assert.rejects(
        first.executeMutation(invocation, { crash_at: crashPoint }),
        { code: "BUSINESS_RECORDED_FAKE_CRASH" },
      );

      const restarted = driverFor(
        root,
        adapter,
        outcomes,
        authorizationResolver(),
        renewedClock,
      );
      const probe = await restarted.inspectByExactKey(probeFor(invocation));
      const mutationCouldBeAccepted = [
        "after_provider_outcome",
        "after_worker_result_persisted",
        "after_ack_returned",
      ].includes(crashPoint);
      assert.equal(probe.classification, mutationCouldBeAccepted ? "accepted" : "not_sent");
      if (mutationCouldBeAccepted) {
        assert.equal((await restarted.executeMutation(invocation)).classification, "accepted");
      } else {
        await assert.rejects(
          restarted.executeMutation(invocation),
          { code: "BUSINESS_RECORDED_FAKE_MUTATION_SEALED" },
        );
      }
      assert.equal(
        (await recordKinds(root))
          .filter((kind) => ["provider_accepted", "not_mutated"].includes(kind)).length,
        1,
      );
    });
  }
});

test("second live resolve accepts only an exact same-or-later PEW tip covering the first", async (t) => {
  const { root, adapter } = await fixture(t);
  const label = "pew-second-later-tip";
  const key = mutationKey(label);
  const invocation = invocationFor(key, label);
  const firstChain = registerProviderEntryRenewals(key, label, [
    ["2026-08-10T01:05:00.000Z", "2026-08-10T01:15:00.000Z"],
  ]);
  const laterChain = registerProviderEntryRenewals(key, label, [
    ["2026-08-10T01:05:00.000Z", "2026-08-10T01:15:00.000Z"],
    ["2026-08-10T01:12:00.000Z", "2026-08-10T01:25:00.000Z"],
  ]);
  let calls = 0;
  const resolver = authorizationResolver({
    async resolveSendAuthorization(query) {
      calls += 1;
      if (calls === 1) {
        assert.equal(query.minimum_provider_entry_window_ref, null);
        return providerEntryAuthorizationFromChain(firstChain, null);
      }
      assert.deepEqual(
        query.minimum_provider_entry_window_ref,
        firstChain.windows[1].window_ref,
      );
      return providerEntryAuthorizationFromChain(
        laterChain,
        query.minimum_provider_entry_window_ref,
      );
    },
  });
  const driver = driverFor(
    root,
    adapter,
    { [key]: acceptedOutcome(label) },
    resolver,
    () => "2026-08-10T01:10:01.000Z",
  );
  const result = await driver.executeMutation(invocation);
  const evidence = await driver.readEvidence(result.worker_result_ref);
  assert.equal(calls, 2);
  assert.equal(evidence.provider_entry_window_sequence, 2);
  assert.deepEqual(evidence.provider_entry_window_ref, laterChain.windows[2].window_ref);
});

test("retained lookup accepts a later exact tip covering its durable entry window", async (t) => {
  const { root, adapter } = await fixture(t);
  const label = "pew-retained-later-tip";
  const key = mutationKey(label);
  const invocation = invocationFor(key, label);
  const firstChain = registerProviderEntryRenewals(key, label, [
    ["2026-08-10T01:05:00.000Z", "2026-08-10T01:15:00.000Z"],
  ]);
  const outcomes = { [key]: acceptedOutcome(label) };
  const first = driverFor(
    root,
    adapter,
    outcomes,
    authorizationResolver(),
    () => "2026-08-10T01:10:01.000Z",
  );
  const completed = await first.executeMutation(invocation);
  const laterChain = registerProviderEntryRenewals(key, label, [
    ["2026-08-10T01:05:00.000Z", "2026-08-10T01:15:00.000Z"],
    ["2026-08-10T01:12:00.000Z", "2026-08-10T01:25:00.000Z"],
  ]);
  let retainedMinimum = null;
  const resolver = authorizationResolver({
    async resolveSendAuthorization() {
      throw Object.assign(new Error("live entry is unavailable"), { code: "LIVE_CLEARED" });
    },
    async resolveRetainedProviderEntryAuthorization(query) {
      retainedMinimum = structuredClone(query.minimum_provider_entry_window_ref);
      return providerEntryAuthorizationFromChain(
        laterChain,
        query.minimum_provider_entry_window_ref,
      );
    },
  });
  const restarted = driverFor(root, adapter, outcomes, resolver);
  const lookup = await restarted.readAuthorizedMutationResult(invocation);
  assert.equal(lookup.status, "worker_result");
  assert.deepEqual(lookup.result, completed);
  assert.deepEqual(retainedMinimum, firstChain.windows[1].window_ref);
});

test("driver accepts a receipt-closed 65-renewal PEW chain without a history cap", async (t) => {
  const { root, adapter } = await fixture(t);
  const label = "pew-65-renewals";
  const key = mutationKey(label);
  const invocation = invocationFor(key, label);
  const occurredBase = Date.parse("2026-08-10T01:05:00.000Z");
  const expiryBase = Date.parse("2026-08-10T01:10:01.000Z");
  const schedule = Array.from({ length: 65 }, (_, index) => [
    new Date(occurredBase + index * 1_000).toISOString(),
    new Date(expiryBase + index * 1_000).toISOString(),
  ]);
  const chain = registerProviderEntryRenewals(key, label, schedule);
  const driver = driverFor(
    root,
    adapter,
    { [key]: acceptedOutcome(label) },
    authorizationResolver(),
    () => "2026-08-10T01:10:30.000Z",
  );
  const result = await driver.executeMutation(invocation);
  const evidence = await driver.readEvidence(result.worker_result_ref);
  assert.equal(evidence.provider_entry_window_sequence, 65);
  assert.deepEqual(evidence.provider_entry_window_ref, chain.windows[65].window_ref);
});

test("forked, truncated, or selector-ignoring PEW proofs fail before durable entry", async (t) => {
  const scenarios = [
    ["missing composite field", (proof) => { delete proof.current_window_index; }],
    ["stable hash drift", (proof) => {
      proof.committed_send_authorization_hash = hash("wrong-stable-hash");
    }],
    ["renewal receipt drift", (proof) => {
      proof.continuation_chain[0].internal_receipt.payload_hash = hash("wrong-renewal-payload");
    }],
    ["forked previous ref", (proof) => {
      proof.continuation_chain[1].provider_entry_window.previous_window_ref =
        contentRef("PEW", "fork");
    }],
    ["tip index drift", (proof) => {
      proof.current_window_index.current_window_sequence -= 1;
    }],
  ];
  for (const [scenario, mutate] of scenarios) {
    await t.test(scenario, async (child) => {
      const { root, adapter } = await fixture(child);
      const label = `pew-hostile-${scenario.replaceAll(" ", "-")}`;
      const key = mutationKey(label);
      const invocation = invocationFor(key, label);
      const chain = registerProviderEntryRenewals(key, label, [
        ["2026-08-10T01:05:00.000Z", "2026-08-10T01:15:00.000Z"],
        ["2026-08-10T01:12:00.000Z", "2026-08-10T01:25:00.000Z"],
      ]);
      const forged = providerEntryAuthorizationFromChain(chain, null);
      mutate(forged);
      const resolver = authorizationResolver({
        async resolveSendAuthorization() { return forged; },
      });
      const driver = driverFor(
        root,
        adapter,
        { [key]: acceptedOutcome(label) },
        resolver,
        () => "2026-08-10T01:10:01.000Z",
      );
      await assert.rejects(
        driver.executeMutation(invocation),
        { code: "BUSINESS_RECORDED_FAKE_AUTHORIZATION_FAILED" },
      );
      assert.deepEqual(await fsp.readdir(root), []);
    });
  }

  await t.test("second live resolver ignores driver minimum", async (child) => {
    const { root, adapter } = await fixture(child);
    const label = "pew-second-selector-ignored";
    const key = mutationKey(label);
    const invocation = invocationFor(key, label);
    const chain = registerProviderEntryRenewals(key, label, [
      ["2026-08-10T01:05:00.000Z", "2026-08-10T01:20:00.000Z"],
    ]);
    let calls = 0;
    const resolver = authorizationResolver({
      async resolveSendAuthorization(_query) {
        calls += 1;
        return providerEntryAuthorizationFromChain(chain, null);
      },
    });
    const driver = driverFor(
      root,
      adapter,
      { [key]: acceptedOutcome(label) },
      resolver,
      () => "2026-08-10T01:10:01.000Z",
    );
    await assert.rejects(
      driver.executeMutation(invocation),
      { code: "BUSINESS_RECORDED_FAKE_AUTHORIZATION_FAILED" },
    );
    assert.equal(calls, 2);
    assert.deepEqual(await fsp.readdir(root), []);
  });
});

test("unproven renewal metadata cannot widen the stable SAB provider-entry window", async (t) => {
  const { root, adapter } = await fixture(t);
  const label = "renewed-after-sab-window";
  const key = mutationKey(label);
  const invocation = invocationFor(key, label);
  const proof = AUTHORIZATIONS.get(key);
  const resolver = authorizationResolver({
    async resolveSendAuthorization() {
      const currentLeaseExpiresAt = "2026-08-10T01:20:00.000Z";
      assert.equal(
        Date.parse(currentLeaseExpiresAt) > Date.parse(proof.send_begin_lease_expires_at),
        true,
      );
      return structuredClone(proof);
    },
  });
  const driver = driverFor(
    root,
    adapter,
    { [key]: acceptedOutcome(label) },
    resolver,
    () => "2026-08-10T01:10:01.000Z",
  );
  await assert.rejects(
    driver.executeMutation(invocation),
    (error) => error.code === "BUSINESS_RECORDED_FAKE_ENTRY_EXPIRED"
      && error.details.send_begin_lease_expires_at === "2026-08-10T01:10:00.000Z",
  );
  assert.deepEqual(await fsp.readdir(root), []);
});

test("forged or missing committed send authorization performs no durable mutation", async (t) => {
  const { root, adapter } = await fixture(t);
  const key = mutationKey("forged-authorization");
  const invocation = invocationFor(key, "forged-authorization");
  const forgedResolver = authorizationResolver({
    async resolveSendAuthorization() {
      const proof = structuredClone(AUTHORIZATIONS.get(key));
      proof.internal_receipt.result.effect_id = "FX-forged";
      return proof;
    },
  });
  const driver = driverFor(
    root,
    adapter,
    { [key]: acceptedOutcome("forged-authorization") },
    forgedResolver,
  );
  await assert.rejects(
    driver.executeMutation(invocation),
    { code: "BUSINESS_RECORDED_FAKE_AUTHORIZATION_FAILED" },
  );
  assert.deepEqual(await fsp.readdir(root), []);
});

test("every repeated SAB authority layer is revalidated before provider-store entry", async (t) => {
  const scenarios = [
    ["commit closure", (proof) => {
      proof.commit.event_hashes[proof.send_event.event_id] = hash("forged-commit-event");
    }],
    ["SAB", (proof) => {
      proof.send_authorization_bundle.bundle_ref.hash = hash("forged-sab");
    }],
    ["send event", (proof) => {
      proof.send_event.payload.provider_settlement_cutover_id = "cutover-forged";
    }],
    ["stored result", (proof) => {
      proof.internal_receipt.result.send_authorization_bundle.bundle_ref.hash
        = hash("forged-result-sab");
    }],
    ["Packet receipt", (proof) => {
      proof.packet_verification_receipt.receipt_hash = hash("forged-packet-receipt");
    }],
    ["Effect", (proof) => {
      proof.effect.created_at = "2026-08-10T01:00:00.001Z";
    }],
    ["operation scope", (proof) => {
      proof.operation_scope_binding.provider_ref = "recorded-fake-provider-forged";
    }],
    ["fencing token", (proof) => {
      proof.authorized_fencing_token.generation += 1;
    }],
    ["provider request", (proof) => {
      proof.provider_request_ref.id = "dispatch-packet:forged";
    }],
    ["authorization receipt ref", (proof) => {
      proof.send_authorization_receipt_ref.hash = hash("forged-authorization-receipt");
    }],
  ];
  for (const [name, mutate] of scenarios) {
    await t.test(name, async (subtest) => {
      const { root, adapter } = await fixture(subtest);
      const label = `authority-layer-${name.replaceAll(" ", "-")}`;
      const key = mutationKey(label);
      const invocation = invocationFor(key, label);
      const proof = structuredClone(AUTHORIZATIONS.get(key));
      mutate(proof);
      const resolver = authorizationResolver({
        async resolveSendAuthorization() {
          return structuredClone(proof);
        },
      });
      const driver = driverFor(
        root,
        adapter,
        { [key]: acceptedOutcome(label) },
        resolver,
      );
      await assert.rejects(
        driver.executeMutation(invocation),
        { code: "BUSINESS_RECORDED_FAKE_AUTHORIZATION_FAILED" },
      );
      assert.deepEqual(await fsp.readdir(root), []);
    });
  }
});

test("stored receipt hashes close the exact ordered send and receipt events", async (t) => {
  const scenarios = [
    {
      name: "missing receipt-event hash",
      mutate(proof) {
        delete proof.internal_receipt.event_hashes[proof.receipt_event.event_id];
        readdressSendAuthorization(proof);
      },
    },
    {
      name: "extra event hash",
      mutate(proof) {
        proof.internal_receipt.event_hashes[`BVE-${hash("uncommitted-event").slice(0, 32)}`]
          = hash("uncommitted-event-body");
        readdressSendAuthorization(proof);
      },
    },
    {
      name: "forged send-event hash",
      mutate(proof) {
        proof.internal_receipt.event_hashes[proof.send_event.event_id]
          = hash("forged-send-event-body");
        readdressSendAuthorization(proof);
      },
    },
    {
      name: "forged receipt-event hash",
      mutate(proof) {
        proof.internal_receipt.event_hashes[proof.receipt_event.event_id]
          = hash("forged-receipt-event-body");
        readdressSendAuthorization(proof);
      },
    },
    {
      name: "reversed commit event order",
      mutate(proof) {
        proof.commit.event_ids.reverse();
      },
    },
    {
      name: "receipt event does not embed the stored journal receipt",
      mutate(proof) {
        proof.receipt_event.payload.receipt.payload_hash = hash("forged-journal-payload");
        proof.internal_receipt.event_hashes[proof.receipt_event.event_id]
          = canonicalHash(proof.receipt_event);
        readdressSendAuthorization(proof);
      },
    },
    {
      name: "authorization reference hashes a receipt with event hashes stripped",
      mutate(proof) {
        const { event_hashes: ignoredEventHashes, ...strippedReceipt } = proof.internal_receipt;
        void ignoredEventHashes;
        const strippedHash = canonicalHash(strippedReceipt);
        proof.send_authorization_receipt_ref = {
          id: `IAR-${strippedHash.slice(0, 32)}`,
          hash: strippedHash,
        };
      },
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async (subtest) => {
      const { root, adapter } = await fixture(subtest);
      const label = `receipt-closure-${scenario.name.replaceAll(" ", "-")}`;
      const key = mutationKey(label);
      const invocation = invocationFor(key, label);
      const proof = structuredClone(AUTHORIZATIONS.get(key));
      scenario.mutate(proof);
      invocation.send_authorization_receipt_ref = proof.send_authorization_receipt_ref;
      const resolver = authorizationResolver({
        async resolveSendAuthorization() {
          return structuredClone(proof);
        },
      });
      const driver = driverFor(
        root,
        adapter,
        { [key]: acceptedOutcome(label) },
        resolver,
      );

      await assert.rejects(
        driver.executeMutation(invocation),
        { code: "BUSINESS_RECORDED_FAKE_AUTHORIZATION_FAILED" },
      );
      assert.deepEqual(await fsp.readdir(root), []);
    });
  }
});

test("recovery inspection cannot seal an absent key without committed eligible recovery", async (t) => {
  const { root, adapter } = await fixture(t);
  const key = mutationKey("unauthorized-probe");
  const invocation = invocationFor(key, "unauthorized-probe");
  const resolver = authorizationResolver({
    async resolveRecoveryAuthorization() {
      throw Object.assign(new Error("send not recovery eligible"), { code: "NOT_ELIGIBLE" });
    },
  });
  const driver = driverFor(
    root,
    adapter,
    { [key]: acceptedOutcome("unauthorized-probe") },
    resolver,
  );
  await assert.rejects(
    driver.inspectByExactKey(probeFor(invocation)),
    { code: "BUSINESS_RECORDED_FAKE_RECOVERY_NOT_AUTHORIZED" },
  );
  assert.deepEqual(await fsp.readdir(root), []);
  const result = await driver.executeMutation(invocation);
  assert.equal(result.classification, "accepted");
});

test("recovery inspected_at cannot run ahead of the trusted driver clock", async (t) => {
  const { root, adapter } = await fixture(t);
  const label = "future-recovery-inspection";
  const key = mutationKey(label);
  const invocation = invocationFor(key, label);
  const driver = driverFor(
    root,
    adapter,
    { [key]: acceptedOutcome(label) },
    authorizationResolver(),
    () => "2026-08-10T01:10:04.000Z",
  );
  await assert.rejects(
    driver.inspectByExactKey(probeFor(invocation, "2026-08-10T01:10:05.000Z")),
    (error) => error.code === "BUSINESS_RECORDED_FAKE_RECOVERY_NOT_AUTHORIZED"
      && error.details.recovery_checked_at === "2026-08-10T01:10:04.000Z",
  );
  assert.deepEqual(await fsp.readdir(root), []);
});

test("forged Effect identifiers cannot cross the self-contained authorization boundary", async (t) => {
  const { root, adapter } = await fixture(t);
  const valid = effectFor(null, "forged-effect-id");
  const forged = {
    ...valid,
    effect_id: `FX-${hash("forged-effect-id").slice(0, 32)}`,
    idempotency_key: `IDEM-${hash("forged-idempotency").slice(0, 32)}`,
  };
  const authorization = authorizationFor(valid, "forged-effect-id");
  const forgedAuthorization = structuredClone(authorization);
  forgedAuthorization.effect = forged;
  AUTHORIZATIONS.set(forged.idempotency_key, forgedAuthorization);
  const invocation = {
    invocation_version: 1,
    effect: forged,
    mutation_idempotency_key: forged.idempotency_key,
    send_authorization_receipt_ref: authorization.send_authorization_receipt_ref,
    provider_request_ref: authorization.provider_request_ref,
    worker_fencing_token: authorization.authorized_fencing_token,
  };
  const driver = driverFor(root, adapter, {
    [forged.idempotency_key]: acceptedOutcome("forged-effect-id"),
  });
  await assert.rejects(
    driver.executeMutation(invocation),
    { code: "BUSINESS_RECORDED_FAKE_AUTHORIZATION_FAILED" },
  );
  assert.deepEqual(await fsp.readdir(root), []);
});

test("valid Effect generations are not subject to an arbitrary small operational cap", async (t) => {
  const { root, adapter } = await fixture(t);
  const first = effectFor(null, "generation-65");
  const identity = {
    ...first,
    operation_generation: 65,
    generation_predecessor_effect_id: `FX-${hash("generation-64").slice(0, 32)}`,
  };
  delete identity.effect_id;
  delete identity.idempotency_key;
  delete identity.created_at;
  const seed = effectSeed(identity);
  const effect = {
    effect_id: identifier("FX", seed),
    ...identity,
    idempotency_key: identifier("IDEM", seed),
    created_at: first.created_at,
  };
  const authorization = authorizationFor(effect, "generation-65");
  AUTHORIZATIONS.set(effect.idempotency_key, authorization);
  const invocation = {
    invocation_version: 1,
    effect,
    mutation_idempotency_key: effect.idempotency_key,
    send_authorization_receipt_ref: authorization.send_authorization_receipt_ref,
    provider_request_ref: authorization.provider_request_ref,
    worker_fencing_token: authorization.authorized_fencing_token,
  };
  const driver = driverFor(root, adapter, {
    [effect.idempotency_key]: acceptedOutcome("generation-65"),
  });
  assert.equal((await driver.executeMutation(invocation)).classification, "accepted");
});

test("caller time is absent from mutation identity and fresh restart input recovers", async (t) => {
  const { root, adapter } = await fixture(t);
  const key = mutationKey("restart-no-time");
  const invocation = invocationFor(key, "restart-no-time");
  assert.equal(Object.hasOwn(invocation, "invoked_at"), false);
  const outcomes = { [key]: acceptedOutcome("restart-no-time") };
  const first = driverFor(root, adapter, outcomes);
  await assert.rejects(
    first.executeMutation(invocation, { crash_at: "after_provider_outcome" }),
    { code: "BUSINESS_RECORDED_FAKE_CRASH" },
  );
  const restarted = driverFor(root, adapter, outcomes);
  const recovered = await restarted.executeMutation(structuredClone(invocation));
  assert.equal(recovered.classification, "accepted");
});

test("stored outcome hash is closed over the binding before probe evidence", async (t) => {
  const { root, adapter } = await fixture(t);
  const key = mutationKey("outcome-closure");
  const invocation = invocationFor(key, "outcome-closure");
  const driver = driverFor(root, adapter, { [key]: acceptedOutcome("outcome-closure") });
  await driver.executeMutation(invocation);
  const outcomeName = (await fsp.readdir(root)).find((name) => name.endsWith("provider-accepted.json"));
  const outcomePath = path.join(root, outcomeName);
  const record = JSON.parse(await fsp.readFile(outcomePath, "utf8"));
  const changedIdentity = { ...record.runtime_identity, thread_id: "thread-tampered" };
  record.runtime_identity = changedIdentity;
  record.recorded_outcome.runtime_identity = changedIdentity;
  await fsp.writeFile(outcomePath, `${canonicalJson(record)}\n`, { mode: 0o600 });
  await assert.rejects(
    driver.inspectByExactKey(probeFor(invocation)),
    { code: "BUSINESS_RECORDED_FAKE_RECORD_CORRUPT" },
  );
});

test("both recovery-probe crash points replay from durable proof without duplicate seal", async (t) => {
  assert.deepEqual(RECORDED_FAKE_PROBE_CRASH_POINTS, [
    "after_probe_seal",
    "after_probe_evidence_persisted",
  ]);
  for (const [index, crashPoint] of RECORDED_FAKE_PROBE_CRASH_POINTS.entries()) {
    await t.test(crashPoint, async (child) => {
      const { root, adapter } = await fixture(child);
      const label = `probe-crash-${index}`;
      const key = mutationKey(label);
      const invocation = invocationFor(key, label);
      const driver = driverFor(root, adapter, { [key]: acceptedOutcome(label) });
      const probe = probeFor(invocation);
      await assert.rejects(
        driver.inspectByExactKey(probe, { crash_at: crashPoint }),
        { code: "BUSINESS_RECORDED_FAKE_CRASH" },
      );
      const replay = await driver.inspectByExactKey(structuredClone(probe));
      assert.equal(replay.classification, "not_sent");
      assert.equal(
        (await recordKinds(root)).filter((kind) => kind === "not_mutated").length,
        1,
      );
    });
  }
});

test("not-sent outcome covers every mutation crash point without a second outcome", async (t) => {
  for (const [index, crashPoint] of RECORDED_FAKE_CRASH_POINTS.entries()) {
    await t.test(crashPoint, async (child) => {
      const { root, adapter } = await fixture(child);
      const label = `not-sent-crash-${index}`;
      const key = mutationKey(label);
      const invocation = invocationFor(key, label);
      const outcomes = { [key]: notSentOutcome(label) };
      const driver = driverFor(root, adapter, outcomes);
      await assert.rejects(
        driver.executeMutation(invocation, { crash_at: crashPoint }),
        { code: "BUSINESS_RECORDED_FAKE_CRASH" },
      );
      const recovery = await driver.inspectByExactKey(probeFor(invocation));
      assert.equal(recovery.classification, "not_sent");
      assert.equal(
        (await recordKinds(root)).filter((kind) => kind === "not_mutated").length,
        1,
      );
    });
  }
});

test("a second current resolver check closes a CAS requeue or lease-generation change", async (t) => {
  const { root, adapter } = await fixture(t);
  const key = mutationKey("entry-reauthorization");
  const invocation = invocationFor(key, "entry-reauthorization");
  let calls = 0;
  const resolver = authorizationResolver({
    async resolveSendAuthorization() {
      calls += 1;
      if (calls === 2) {
        throw Object.assign(new Error("lease generation changed"), {
          code: "CURRENT_SEND_FENCING_CHANGED",
        });
      }
      return structuredClone(AUTHORIZATIONS.get(key));
    },
  });
  const driver = driverFor(
    root,
    adapter,
    { [key]: acceptedOutcome("entry-reauthorization") },
    resolver,
  );
  await assert.rejects(
    driver.executeMutation(invocation),
    (error) => error.code === "BUSINESS_RECORDED_FAKE_AUTHORIZATION_FAILED"
      && error.details.cause_code === "CURRENT_SEND_FENCING_CHANGED",
  );
  assert.equal(calls, 2);
  assert.deepEqual(await fsp.readdir(root), []);
});

test("resolver delay crossing the exact lease expiry blocks entry before any provider record", async (t) => {
  const { root, adapter } = await fixture(t);
  const key = mutationKey("resolver-delay-expiry");
  const invocation = invocationFor(key, "resolver-delay-expiry");
  let now = "2026-08-10T01:00:02.500Z";
  let calls = 0;
  const resolver = authorizationResolver({
    async resolveSendAuthorization() {
      calls += 1;
      if (calls === 2) now = "2026-08-10T01:10:00.000Z";
      return structuredClone(AUTHORIZATIONS.get(key));
    },
  });
  const driver = driverFor(
    root,
    adapter,
    { [key]: acceptedOutcome("resolver-delay-expiry") },
    resolver,
    () => now,
  );
  await assert.rejects(
    driver.executeMutation(invocation),
    (error) => error.code === "BUSINESS_RECORDED_FAKE_ENTRY_EXPIRED"
      && error.failure_class === "control_plane_blocker"
      && error.classification === undefined
      && error.details.control_plane_disposition === "send_expiration_required"
      && error.details.phase === "before_binding"
      && error.details.durable_stage === "none",
  );
  assert.equal(calls, 2);
  assert.deepEqual(await fsp.readdir(root), []);
});

test("a hung current resolver releases the exclusive store at the exact lease expiry", async (t) => {
  const { root, adapter } = await fixture(t);
  const key = mutationKey("hung-entry-reauthorization");
  const invocation = invocationFor(key, "hung-entry-reauthorization");
  let calls = 0;
  let resolverAborted = false;
  const resolver = authorizationResolver({
    async resolveSendAuthorization(_query, options) {
      calls += 1;
      if (calls !== 2) return structuredClone(AUTHORIZATIONS.get(key));
      assert.equal(options?.signal instanceof AbortSignal, true);
      return new Promise((resolve, reject) => {
        void resolve;
        options.signal.addEventListener("abort", () => {
          resolverAborted = true;
          reject(options.signal.reason);
        }, { once: true });
      });
    },
  });
  const driver = driverFor(
    root,
    adapter,
    { [key]: acceptedOutcome("hung-entry-reauthorization") },
    resolver,
    sequenceClock([
      "2026-08-10T01:09:59.950Z",
      "2026-08-10T01:10:00.000Z",
    ]),
  );

  await assert.rejects(
    driver.executeMutation(invocation),
    (error) => error.code === "BUSINESS_RECORDED_FAKE_ENTRY_EXPIRED"
      && error.failure_class === "control_plane_blocker"
      && error.details.phase === "during_authorization_recheck"
      && error.details.durable_stage === "none"
      && error.details.entry_checked_at === "2026-08-10T01:10:00.000Z",
  );
  assert.equal(calls, 2);
  assert.equal(resolverAborted, true);
  assert.deepEqual(await fsp.readdir(root), []);

  const missingHash = hash("missing-worker-result-after-resolver-timeout");
  await assert.rejects(
    driver.readEvidence({
      id: `WRR-${missingHash.slice(0, 32)}`,
      hash: missingHash,
    }),
    { code: "BUSINESS_RECORDED_FAKE_EVIDENCE_NOT_FOUND" },
  );
});

test("fresh clocks fence exact expiry immediately before and after durable call entry", async (t) => {
  const scenarios = [
    {
      name: "before_call_entered",
      clock: [
        "2026-08-10T01:00:02.500Z",
        "2026-08-10T01:00:02.500Z",
        "2026-08-10T01:10:00.000Z",
      ],
      phase: "before_call_entered",
      durableStage: "binding",
      kinds: ["binding"],
    },
    {
      name: "after_call_entered",
      clock: [
        "2026-08-10T01:00:02.500Z",
        "2026-08-10T01:00:02.500Z",
        "2026-08-10T01:00:03.000Z",
        "2026-08-10T01:10:00.000Z",
      ],
      phase: "after_call_entered",
      durableStage: "call_entered",
      kinds: ["binding", "call_entered"],
    },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async (child) => {
      const { root, adapter } = await fixture(child);
      const label = `entry-expiry-${scenario.name}`;
      const key = mutationKey(label);
      const invocation = invocationFor(key, label);
      const driver = driverFor(
        root,
        adapter,
        { [key]: acceptedOutcome(label) },
        authorizationResolver(),
        sequenceClock(scenario.clock),
      );
      await assert.rejects(
        driver.executeMutation(invocation),
        (error) => error.code === "BUSINESS_RECORDED_FAKE_ENTRY_EXPIRED"
          && error.failure_class === "control_plane_blocker"
          && error.classification === undefined
          && error.details.phase === scenario.phase
          && error.details.durable_stage === scenario.durableStage
          && error.details.entry_checked_at === "2026-08-10T01:10:00.000Z",
      );
      assert.deepEqual(await recordKinds(root), scenario.kinds);
      const restarted = driverFor(
        root,
        adapter,
        { [key]: acceptedOutcome(label) },
      );
      await assert.rejects(
        restarted.executeMutation(structuredClone(invocation)),
        (error) => error.code === "BUSINESS_RECORDED_FAKE_RECOVERY_REQUIRED"
          && error.details.durable_stage === scenario.durableStage,
      );
      const recovery = await restarted.inspectByExactKey(probeFor(invocation));
      assert.equal(recovery.classification, "not_sent");
      assert.equal(
        (await recordKinds(root)).filter((kind) => kind === "not_mutated").length,
        1,
      );
    });
  }
});

test("backward trusted time is rejected rather than clamped into the lease window", async (t) => {
  const { root, adapter } = await fixture(t);
  const key = mutationKey("backward-entry-clock");
  const invocation = invocationFor(key, "backward-entry-clock");
  const driver = driverFor(
    root,
    adapter,
    { [key]: acceptedOutcome("backward-entry-clock") },
    authorizationResolver(),
    sequenceClock([
      "2026-08-10T01:00:03.000Z",
      "2026-08-10T01:00:03.000Z",
      "2026-08-10T01:00:02.000Z",
    ]),
  );
  await assert.rejects(
    driver.executeMutation(invocation),
    (error) => error.code === "BUSINESS_RECORDED_FAKE_CLOCK_INVALID"
      && error.details.phase === "before_call_entered",
  );
  assert.deepEqual(await recordKinds(root), ["binding"]);
});

test("execute-versus-probe and conflicting concurrent invocation leave one coherent terminal outcome", async (t) => {
  const { root, adapter } = await fixture(t);
  const key = mutationKey("execute-probe-race");
  const invocation = invocationFor(key, "execute-probe-race");
  const driver = driverFor(root, adapter, { [key]: acceptedOutcome("execute-probe-race") });
  const raced = await Promise.allSettled([
    driver.executeMutation(invocation),
    driver.inspectByExactKey(probeFor(invocation)),
  ]);
  assert.equal(raced.some((entry) => entry.status === "fulfilled"), true);
  const kinds = await recordKinds(root);
  assert.equal(
    kinds.filter((kind) => ["provider_accepted", "not_mutated"].includes(kind)).length,
    1,
  );

  const conflicting = {
    ...structuredClone(invocation),
    worker_fencing_token: { ...invocation.worker_fencing_token, generation: 2 },
  };
  const conflictResults = await Promise.allSettled([
    driver.executeMutation(structuredClone(invocation)),
    driver.executeMutation(conflicting),
  ]);
  assert.equal(conflictResults.some((entry) => (
    entry.status === "rejected"
      && entry.reason.code === "BUSINESS_RECORDED_FAKE_AUTHORIZATION_FAILED"
  )), true);
  assert.equal(
    (await recordKinds(root))
      .filter((kind) => ["provider_accepted", "not_mutated"].includes(kind)).length,
    1,
  );
});
