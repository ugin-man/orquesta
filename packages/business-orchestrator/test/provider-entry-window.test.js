"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { canonicalHash } = require("@orquesta/contracts");
const {
  V2_EFFECT_IDENTITY_FIELDS,
  deriveEffectOperationScopeHashV2,
} = require("../src/lifecycle");
const {
  BusinessProviderEntryWindowError,
  PROVIDER_ENTRY_AUTHORIZATION_VERSION,
  PROVIDER_ENTRY_WINDOW_INDEX_VERSION,
  PROVIDER_ENTRY_WINDOW_VERSION,
  advanceProviderEntryWindowIndexV1,
  assertProviderEntryWindowContinuationV1,
  assertProviderEntryWindowCoverageV1,
  createProviderEntryWindowAnchorV1,
  createProviderEntryWindowContinuationV1,
  createProviderEntryWindowIndexV1,
  normalizeProviderEntryAuthorizationProofV1,
  normalizeProviderEntryWindowIndexV1,
  normalizeProviderEntryWindowReceiptClosureV1,
  normalizeProviderEntryWindowV1,
} = require("../src/provider-entry-window");
const {
  createCommittedSendAuthorizationProofV2,
  createSendAuthorizationBundleV1,
  deriveCommittedSendAuthorizationHashV2,
} = require("../src/send-authorization");

const SEND_AT = "2026-08-10T01:00:01.000Z";
const CLAIMED_AT = "2026-08-10T01:00:00.000Z";
const BASE_EXPIRY = "2026-08-10T01:10:00.000Z";

function hash(label) {
  return canonicalHash({ label });
}

function contentRef(prefix, label) {
  return { id: `${prefix}:${label}`, hash: hash(`${prefix}:${label}`) };
}

function identifier(prefix, value) {
  return `${prefix}-${canonicalHash(value).slice(0, 32)}`;
}

function eventId(sourceId, ordinal, type, payload, evidenceRefs = []) {
  return identifier("BVE", {
    source_id: sourceId,
    ordinal,
    type,
    payload,
    evidence_refs: evidenceRefs,
  });
}

function effectSeed(effect) {
  return Object.fromEntries(V2_EFFECT_IDENTITY_FIELDS
    .filter((field) => !["effect_id", "idempotency_key", "created_at"].includes(field))
    .map((field) => [field, effect[field]]));
}

function effectFor(kind, label) {
  const workOrderId = `WO-${hash(`work-order:${label}`).slice(0, 32)}`;
  const packetRef = contentRef("dispatch-packet", label);
  const threadCreate = kind === "provider.thread.create";
  const userInput = kind === "provider.user_input.submit";
  const targetRuntimeIdentity = threadCreate ? null : {
    operation_id: `operation:${label}`,
    thread_id: `thread:${label}`,
    turn_id: kind === "provider.turn.start" ? null : `turn:${label}`,
  };
  const predecessorEffectId = threadCreate
    ? null
    : `FX-${hash(`predecessor:${label}`).slice(0, 32)}`;
  const predecessorDeliveryHash = threadCreate ? null : hash(`delivery:${label}`);
  const requestId = userInput ? `request:${label}` : null;
  const responseRef = userInput ? contentRef("response", label) : null;
  const operationScopeBinding = {
    effect_kind: kind,
    provider_ref: "provider:recorded",
    packet_ref: packetRef.id,
    packet_hash: packetRef.hash,
    predecessor_effect_id: predecessorEffectId,
    predecessor_delivery_hash: predecessorDeliveryHash,
    target_runtime_identity: targetRuntimeIdentity,
    request_id: requestId,
    response_ref: responseRef,
  };
  const base = {
    effect_contract_version: 2,
    work_order_id: workOrderId,
    branch_ref: `branch:${label}`,
    attempt: 1,
    dispatch_id: identifier("DSP", {
      work_order_id: workOrderId,
      branch_ref: `branch:${label}`,
      attempt: 1,
      packet_ref: packetRef,
    }),
    effect_kind: kind,
    origin_source_id: `source:${label}`,
    operation_scope_hash: deriveEffectOperationScopeHashV2(operationScopeBinding),
    operation_generation: 1,
    generation_predecessor_effect_id: null,
    provider_ref: operationScopeBinding.provider_ref,
    packet_ref: packetRef.id,
    packet_hash: packetRef.hash,
    predecessor_effect_id: predecessorEffectId,
    predecessor_delivery_hash: predecessorDeliveryHash,
    target_runtime_identity: targetRuntimeIdentity,
  };
  const seed = effectSeed(base);
  return {
    effect: {
      effect_id: identifier("FX", seed),
      ...base,
      idempotency_key: identifier("IDEM", seed),
      created_at: "2026-08-10T00:59:00.000Z",
    },
    operationScopeBinding,
    packetRef,
  };
}

function committedProof(kind = "provider.thread.create", label = "one") {
  const { effect, operationScopeBinding, packetRef } = effectFor(kind, label);
  const token = { lease_id: `lease:${label}`, owner_id: `worker:${label}`, generation: 1 };
  const sourceId = `send:${label}`;
  const packetVerificationReceipt = { packet_ref: packetRef };
  const payload = {
    work_order_id: effect.work_order_id,
    plan_snapshot_ref: `plan:${label}`,
    plan_hash: hash(`plan:${label}`),
    source_id: sourceId,
    prior_work_order_revision: 1,
    target_work_order_revision: 1,
    occurred_at: SEND_AT,
    effect_id: effect.effect_id,
    effect,
    lease_id: token.lease_id,
    lease_owner_id: token.owner_id,
    lease_generation: token.generation,
    lease_expires_at: BASE_EXPIRY,
    packet_verification_receipt: packetVerificationReceipt,
    provider_settlement_cutover_id: `cutover:${label}`,
    operation_scope_binding: operationScopeBinding,
    send_authorization_contract_version: 2,
  };
  const sendEvent = {
    event_id: eventId(sourceId, 0, "business.outbox.send_begun", payload),
    schema_version: 1,
    type: "business.outbox.send_begun",
    payload,
    evidence_refs: [],
  };
  const batchId = `business:${sourceId}`;
  const bundle = createSendAuthorizationBundleV1({
    send_event: sendEvent,
    batch_id: batchId,
  });
  const result = {
    internal_action_id: sourceId,
    work_order_id: effect.work_order_id,
    work_order_revision: 1,
    effect_id: effect.effect_id,
    action: "outbox.send.begin",
    outbox_status: "sending",
    fencing_token: token,
    packet_verification_receipt: packetVerificationReceipt,
    send_authorization_bundle: bundle,
  };
  const journalReceipt = {
    source_id: sourceId,
    source_type: "internal_action",
    identity_hash: hash(`identity:${label}`),
    payload_hash: hash(`payload:${label}`),
    work_order_id: effect.work_order_id,
    applied_revision: 1,
    batch_id: batchId,
    event_ids: [sendEvent.event_id],
    result,
  };
  const receiptPayload = {
    work_order_id: effect.work_order_id,
    plan_snapshot_ref: payload.plan_snapshot_ref,
    plan_hash: payload.plan_hash,
    source_id: sourceId,
    prior_work_order_revision: 1,
    target_work_order_revision: 1,
    occurred_at: SEND_AT,
    receipt: journalReceipt,
  };
  const receiptEvent = {
    event_id: eventId(
      sourceId,
      1,
      "business.internal_action.received",
      receiptPayload,
    ),
    schema_version: 1,
    type: "business.internal_action.received",
    payload: receiptPayload,
    evidence_refs: [],
  };
  return createCommittedSendAuthorizationProofV2({
    send_authorization_bundle: bundle,
    internal_receipt: {
      ...journalReceipt,
      event_hashes: {
        [sendEvent.event_id]: canonicalHash(sendEvent),
        [receiptEvent.event_id]: canonicalHash(receiptEvent),
      },
    },
  });
}

function renewalEvent(proof, label, occurredAt, expiresAt) {
  const sourceId = `renew:${label}`;
  const payload = {
    work_order_id: proof.effect.work_order_id,
    plan_snapshot_ref: proof.send_event.payload.plan_snapshot_ref,
    plan_hash: proof.send_event.payload.plan_hash,
    source_id: sourceId,
    prior_work_order_revision: 1,
    target_work_order_revision: 1,
    occurred_at: occurredAt,
    effect_id: proof.effect.effect_id,
    effect: proof.effect,
    lease: {
      ...proof.authorized_fencing_token,
      claimed_at: CLAIMED_AT,
      heartbeat_at: occurredAt,
      expires_at: expiresAt,
    },
  };
  return {
    event_id: eventId(sourceId, 0, "business.outbox.lease_renewed", payload),
    schema_version: 1,
    type: "business.outbox.lease_renewed",
    payload,
    evidence_refs: [],
  };
}

function renewalReceipt(window, label) {
  const sourceEvent = window.source_event;
  const result = {
    internal_action_id: sourceEvent.payload.source_id,
    work_order_id: window.effect_id === sourceEvent.payload.effect_id
      ? sourceEvent.payload.work_order_id
      : "unreachable",
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
    event_id: eventId(
      sourceEvent.payload.source_id,
      1,
      "business.internal_action.received",
      receiptPayload,
    ),
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

function readdressWindow(input) {
  const candidate = structuredClone(input);
  delete candidate.window_ref;
  const valueHash = canonicalHash(candidate);
  return {
    ...candidate,
    window_ref: { id: `PEW-${valueHash.slice(0, 32)}`, hash: valueHash },
  };
}

function readdressWindowSourceEvent(input) {
  const candidate = structuredClone(input);
  const event = candidate.source_event;
  event.event_id = eventId(
    event.payload.source_id,
    0,
    event.type,
    event.payload,
    event.evidence_refs,
  );
  candidate.source_event_ref = {
    id: event.event_id,
    hash: canonicalHash(event),
  };
  candidate.domain_event_manifest_hash = canonicalHash([{
    event_id: event.event_id,
    event_hash: canonicalHash(event),
  }]);
  return readdressWindow(candidate);
}

function assertPewError(action, code) {
  assert.throws(action, (error) => (
    error instanceof BusinessProviderEntryWindowError && error.code === code
  ));
}

function continuationFixture(proof, label, schedule) {
  const anchor = createProviderEntryWindowAnchorV1({ committed_send_authorization: proof });
  const windows = [];
  const receipts = [];
  let index = createProviderEntryWindowIndexV1({ committed_send_authorization: proof });
  let previousWindow = anchor;
  let previousReceipt = null;
  for (const [ordinal, [occurredAt, expiresAt]] of schedule.entries()) {
    const hopLabel = `${label}:${ordinal + 1}`;
    const event = renewalEvent(proof, hopLabel, occurredAt, expiresAt);
    const window = createProviderEntryWindowContinuationV1({
      committed_send_authorization: proof,
      previous_window: previousWindow,
      renewal_event: event,
      batch_id: `business:${event.payload.source_id}`,
    });
    const receipt = renewalReceipt(window, hopLabel);
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
  return { anchor, windows, receipts, index };
}

test("SAB-derived PEW anchors normalize all four mutating Effect V2 kinds", () => {
  const kinds = [
    "provider.thread.create",
    "provider.turn.start",
    "provider.user_input.submit",
    "provider.turn.cancel",
  ];
  for (const [index, kind] of kinds.entries()) {
    const proof = committedProof(kind, `kind-${index}`);
    const anchor = createProviderEntryWindowAnchorV1({
      committed_send_authorization: proof,
    });
    assert.equal(anchor.provider_entry_window_version, PROVIDER_ENTRY_WINDOW_VERSION);
    assert.equal(anchor.window_kind, "send_begin");
    assert.equal(anchor.window_sequence, 0);
    assert.equal(anchor.previous_window_ref, null);
    assert.equal(anchor.previous_lease_expires_at, null);
    assert.equal(anchor.lease_expires_at, proof.send_begin_lease_expires_at);
    assert.deepEqual(
      normalizeProviderEntryWindowV1(anchor, { committed_send_authorization: proof }),
      anchor,
    );
    assert.equal(Object.isFrozen(anchor), true);
  }
});

test("zero and multi-stage continuation, receipt closure, index transition, and coverage compose", () => {
  const proof = committedProof("provider.user_input.submit", "chain");
  const anchor = createProviderEntryWindowAnchorV1({ committed_send_authorization: proof });
  let index = createProviderEntryWindowIndexV1({ committed_send_authorization: proof });
  assert.equal(index.index_version, PROVIDER_ENTRY_WINDOW_INDEX_VERSION);
  assert.deepEqual(
    assertProviderEntryWindowCoverageV1({
      committed_send_authorization: proof,
      entry_window: anchor,
      current_window: anchor,
    }),
    anchor,
  );

  const schedule = [
    ["2026-08-10T01:05:00.000Z", "2026-08-10T01:15:00.000Z"],
    ["2026-08-10T01:12:00.000Z", "2026-08-10T01:22:00.000Z"],
    ["2026-08-10T01:20:00.000Z", "2026-08-10T01:30:00.000Z"],
    ["2026-08-10T01:28:00.000Z", "2026-08-10T01:38:00.000Z"],
  ];
  const windows = [];
  let previous = anchor;
  let previousReceipt = null;
  for (const [ordinal, [occurredAt, expiresAt]] of schedule.entries()) {
    const event = renewalEvent(proof, `chain:${ordinal + 1}`, occurredAt, expiresAt);
    const window = createProviderEntryWindowContinuationV1({
      committed_send_authorization: proof,
      previous_window: previous,
      renewal_event: event,
      batch_id: `business:${event.payload.source_id}`,
    });
    const receipt = renewalReceipt(window, `chain:${ordinal + 1}`);
    const closure = normalizeProviderEntryWindowReceiptClosureV1({
      committed_send_authorization: proof,
      provider_entry_window: window,
      internal_receipt: receipt,
    });
    assert.equal(closure.receipt_ref.id, `IAR-${closure.receipt_ref.hash.slice(0, 32)}`);
    index = advanceProviderEntryWindowIndexV1({
      committed_send_authorization: proof,
      current_index: index,
      current_window: previous,
      current_window_internal_receipt: previousReceipt,
      next_window: window,
      next_window_internal_receipt: receipt,
    });
    assert.deepEqual(
      normalizeProviderEntryWindowIndexV1(index, {
        committed_send_authorization: proof,
        current_window: window,
        current_window_internal_receipt: receipt,
      }),
      index,
    );
    windows.push(window);
    previous = window;
    previousReceipt = receipt;
  }
  const tip = windows.at(-1);
  assert.equal(index.current_window_sequence, schedule.length);
  assert.equal(index.current_lease_expires_at, tip.lease_expires_at);
  assert.deepEqual(
    assertProviderEntryWindowCoverageV1({
      committed_send_authorization: proof,
      entry_window: anchor,
      current_window: tip,
      continuation_chain: windows.slice(0, -1),
    }),
    tip,
  );
  assert.deepEqual(
    assertProviderEntryWindowCoverageV1({
      committed_send_authorization: proof,
      entry_window: windows[0],
      current_window: tip,
      continuation_chain: windows.slice(1, -1),
    }),
    tip,
  );
  assertPewError(() => assertProviderEntryWindowCoverageV1({
    committed_send_authorization: proof,
    entry_window: anchor,
    current_window: tip,
    continuation_chain: [windows[1], windows[0], windows[2]],
  }), "BUSINESS_PROVIDER_ENTRY_WINDOW_NOT_COVERED");
});

test("composite provider-entry authorization proof closes base, every hop receipt, coverage, and tip index", () => {
  const proof = committedProof("provider.user_input.submit", "composite");
  const baseHash = deriveCommittedSendAuthorizationHashV2(proof);
  const fixture = continuationFixture(proof, "composite", [
    ["2026-08-10T01:05:00.000Z", "2026-08-10T01:15:00.000Z"],
    ["2026-08-10T01:12:00.000Z", "2026-08-10T01:22:00.000Z"],
    ["2026-08-10T01:20:00.000Z", "2026-08-10T01:30:00.000Z"],
  ]);
  const anchorIndex = createProviderEntryWindowIndexV1({
    committed_send_authorization: proof,
  });
  const anchorOnly = {
    provider_entry_authorization_version: PROVIDER_ENTRY_AUTHORIZATION_VERSION,
    committed_send_authorization: proof,
    committed_send_authorization_hash: baseHash,
    entry_window: fixture.anchor,
    entry_window_internal_receipt: proof.internal_receipt,
    continuation_chain: [],
    current_window_index: anchorIndex,
  };
  assert.deepEqual(normalizeProviderEntryAuthorizationProofV1(anchorOnly), anchorOnly);

  const fromAnchor = {
    ...anchorOnly,
    continuation_chain: fixture.windows.map((window, index) => ({
      provider_entry_window: window,
      internal_receipt: fixture.receipts[index],
    })),
    current_window_index: fixture.index,
  };
  const normalizedFromAnchor = normalizeProviderEntryAuthorizationProofV1(fromAnchor);
  assert.deepEqual(normalizedFromAnchor, fromAnchor);
  assert.equal(Object.isFrozen(normalizedFromAnchor), true);
  assert.equal(Object.isFrozen(normalizedFromAnchor.continuation_chain), true);

  const fromFirstRenewal = {
    ...fromAnchor,
    entry_window: fixture.windows[0],
    entry_window_internal_receipt: fixture.receipts[0],
    continuation_chain: fixture.windows.slice(1).map((window, index) => ({
      provider_entry_window: window,
      internal_receipt: fixture.receipts[index + 1],
    })),
  };
  assert.deepEqual(
    normalizeProviderEntryAuthorizationProofV1(fromFirstRenewal),
    fromFirstRenewal,
  );

  const missingMiddle = structuredClone(fromAnchor);
  missingMiddle.continuation_chain.splice(1, 1);
  assertPewError(
    () => normalizeProviderEntryAuthorizationProofV1(missingMiddle),
    "BUSINESS_PROVIDER_ENTRY_WINDOW_NOT_COVERED",
  );

  const repeatedHopIdentity = structuredClone(fromAnchor);
  repeatedHopIdentity.continuation_chain[1]
    = structuredClone(repeatedHopIdentity.continuation_chain[0]);
  assertPewError(
    () => normalizeProviderEntryAuthorizationProofV1(repeatedHopIdentity),
    "BUSINESS_PROVIDER_ENTRY_WINDOW_NOT_COVERED",
  );

  const duplicateSourceProof = committedProof(
    "provider.turn.start",
    "composite-duplicate-source",
  );
  const duplicateSourceAnchor = createProviderEntryWindowAnchorV1({
    committed_send_authorization: duplicateSourceProof,
  });
  const duplicateSourceEventOne = renewalEvent(
    duplicateSourceProof,
    "composite-duplicate-source:renewal",
    "2026-08-10T01:05:00.000Z",
    "2026-08-10T01:15:00.000Z",
  );
  const duplicateSourceWindowOne = createProviderEntryWindowContinuationV1({
    committed_send_authorization: duplicateSourceProof,
    previous_window: duplicateSourceAnchor,
    renewal_event: duplicateSourceEventOne,
    batch_id: `business:${duplicateSourceEventOne.payload.source_id}`,
  });
  const duplicateSourceReceiptOne = renewalReceipt(
    duplicateSourceWindowOne,
    "composite-duplicate-source:one",
  );
  const duplicateSourceEventTwo = renewalEvent(
    duplicateSourceProof,
    "composite-duplicate-source:renewal",
    "2026-08-10T01:12:00.000Z",
    "2026-08-10T01:22:00.000Z",
  );
  const duplicateSourceWindowTwo = createProviderEntryWindowContinuationV1({
    committed_send_authorization: duplicateSourceProof,
    previous_window: duplicateSourceWindowOne,
    renewal_event: duplicateSourceEventTwo,
    batch_id: `business:${duplicateSourceEventTwo.payload.source_id}`,
  });
  const duplicateSourceReceiptTwo = renewalReceipt(
    duplicateSourceWindowTwo,
    "composite-duplicate-source:two",
  );
  let duplicateSourceIndex = createProviderEntryWindowIndexV1({
    committed_send_authorization: duplicateSourceProof,
  });
  duplicateSourceIndex = advanceProviderEntryWindowIndexV1({
    committed_send_authorization: duplicateSourceProof,
    current_index: duplicateSourceIndex,
    current_window: duplicateSourceAnchor,
    next_window: duplicateSourceWindowOne,
    next_window_internal_receipt: duplicateSourceReceiptOne,
  });
  duplicateSourceIndex = advanceProviderEntryWindowIndexV1({
    committed_send_authorization: duplicateSourceProof,
    current_index: duplicateSourceIndex,
    current_window: duplicateSourceWindowOne,
    current_window_internal_receipt: duplicateSourceReceiptOne,
    next_window: duplicateSourceWindowTwo,
    next_window_internal_receipt: duplicateSourceReceiptTwo,
  });
  assert.notEqual(
    duplicateSourceWindowOne.source_event.event_id,
    duplicateSourceWindowTwo.source_event.event_id,
  );
  assert.notEqual(
    duplicateSourceWindowOne.window_ref.id,
    duplicateSourceWindowTwo.window_ref.id,
  );
  assertPewError(() => normalizeProviderEntryAuthorizationProofV1({
    provider_entry_authorization_version: PROVIDER_ENTRY_AUTHORIZATION_VERSION,
    committed_send_authorization: duplicateSourceProof,
    committed_send_authorization_hash:
      deriveCommittedSendAuthorizationHashV2(duplicateSourceProof),
    entry_window: duplicateSourceAnchor,
    entry_window_internal_receipt: duplicateSourceProof.internal_receipt,
    continuation_chain: [
      {
        provider_entry_window: duplicateSourceWindowOne,
        internal_receipt: duplicateSourceReceiptOne,
      },
      {
        provider_entry_window: duplicateSourceWindowTwo,
        internal_receipt: duplicateSourceReceiptTwo,
      },
    ],
    current_window_index: duplicateSourceIndex,
  }), "BUSINESS_PROVIDER_ENTRY_WINDOW_NOT_COVERED");

  const forgedReceipt = structuredClone(fromAnchor);
  const firstEventId = fixture.windows[0].source_event.event_id;
  forgedReceipt.continuation_chain[0].internal_receipt.event_hashes[firstEventId]
    = hash("composite-forged-hop");
  assertPewError(
    () => normalizeProviderEntryAuthorizationProofV1(forgedReceipt),
    "BUSINESS_PROVIDER_ENTRY_WINDOW_RECEIPT_INVALID",
  );

  const nonTipIndex = structuredClone(fromAnchor);
  nonTipIndex.current_window_index = anchorIndex;
  assertPewError(
    () => normalizeProviderEntryAuthorizationProofV1(nonTipIndex),
    "BUSINESS_PROVIDER_ENTRY_WINDOW_INDEX_INVALID",
  );

  const wrongBaseHash = structuredClone(fromAnchor);
  wrongBaseHash.committed_send_authorization_hash = hash("composite-wrong-base");
  assertPewError(
    () => normalizeProviderEntryAuthorizationProofV1(wrongBaseHash),
    "BUSINESS_PROVIDER_ENTRY_WINDOW_BASE_INVALID",
  );

  const wrongAnchorReceipt = structuredClone(anchorOnly);
  wrongAnchorReceipt.entry_window_internal_receipt = fixture.receipts[0];
  assertPewError(
    () => normalizeProviderEntryAuthorizationProofV1(wrongAnchorReceipt),
    "BUSINESS_PROVIDER_ENTRY_WINDOW_RECEIPT_INVALID",
  );

  const extraOuterField = { ...fromAnchor, current_status: "sending" };
  assertPewError(
    () => normalizeProviderEntryAuthorizationProofV1(extraOuterField),
    "BUSINESS_PROVIDER_ENTRY_WINDOW_INVALID",
  );
  const extraHopField = structuredClone(fromAnchor);
  extraHopField.continuation_chain[0].current_status = "sending";
  assertPewError(
    () => normalizeProviderEntryAuthorizationProofV1(extraHopField),
    "BUSINESS_PROVIDER_ENTRY_WINDOW_INVALID",
  );

  let getterCalls = 0;
  const accessorOuter = { ...fromAnchor };
  Object.defineProperty(accessorOuter, "current_window_index", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return fixture.index;
    },
  });
  assertPewError(
    () => normalizeProviderEntryAuthorizationProofV1(accessorOuter),
    "BUSINESS_PROVIDER_ENTRY_WINDOW_INVALID",
  );
  assert.equal(getterCalls, 0);

  let proxyGets = 0;
  const descriptorOnlyProxy = new Proxy(fromAnchor, {
    get() {
      proxyGets += 1;
      throw new Error("raw property access is forbidden");
    },
  });
  assert.deepEqual(
    normalizeProviderEntryAuthorizationProofV1(descriptorOnlyProxy),
    fromAnchor,
  );
  assert.equal(proxyGets, 0);
  const hostileShapeProxy = new Proxy(fromAnchor, {
    ownKeys() {
      throw new Error("hostile ownKeys trap");
    },
  });
  assertPewError(
    () => normalizeProviderEntryAuthorizationProofV1(hostileShapeProxy),
    "BUSINESS_PROVIDER_ENTRY_WINDOW_INVALID",
  );

  const sparseChain = structuredClone(fromAnchor);
  delete sparseChain.continuation_chain[1];
  assertPewError(
    () => normalizeProviderEntryAuthorizationProofV1(sparseChain),
    "BUSINESS_PROVIDER_ENTRY_WINDOW_NOT_COVERED",
  );
});

test("a receipt-closed provider entry lineage has no hidden 64-renewal ceiling", () => {
  const proof = committedProof("provider.turn.start", "long-lineage");
  const schedule = Array.from({ length: 65 }, (_, index) => {
    const occurredAt = new Date(Date.parse("2026-08-10T01:05:00.000Z")
      + index * 5 * 60_000).toISOString();
    const expiresAt = new Date(Date.parse(occurredAt) + 10 * 60_000).toISOString();
    return [occurredAt, expiresAt];
  });
  const fixture = continuationFixture(proof, "long-lineage", schedule);
  const candidate = {
    provider_entry_authorization_version: PROVIDER_ENTRY_AUTHORIZATION_VERSION,
    committed_send_authorization: proof,
    committed_send_authorization_hash: deriveCommittedSendAuthorizationHashV2(proof),
    entry_window: fixture.anchor,
    entry_window_internal_receipt: proof.internal_receipt,
    continuation_chain: fixture.windows.map((window, index) => ({
      provider_entry_window: window,
      internal_receipt: fixture.receipts[index],
    })),
    current_window_index: fixture.index,
  };

  const normalized = normalizeProviderEntryAuthorizationProofV1(candidate);
  assert.equal(normalized.continuation_chain.length, 65);
  assert.equal(normalized.current_window_index.current_window_sequence, 65);
  assert.deepEqual(normalized, candidate);
});

test("continuation normalizer and relation reject hostile token, anchor, time, event, and manifest drift", () => {
  const proof = committedProof("provider.thread.create", "hostile");
  const anchor = createProviderEntryWindowAnchorV1({ committed_send_authorization: proof });
  const event = renewalEvent(
    proof,
    "hostile:one",
    "2026-08-10T01:05:00.000Z",
    "2026-08-10T01:15:00.000Z",
  );
  const window = createProviderEntryWindowContinuationV1({
    committed_send_authorization: proof,
    previous_window: anchor,
    renewal_event: event,
    batch_id: `business:${event.payload.source_id}`,
  });

  for (const mutate of [
    (value) => { value.committed_send_authorization_hash = hash("forged-base"); },
    (value) => { value.authorized_fencing_token.owner_id = "worker:forged"; },
    (value) => { value.source_event_ref.hash = hash("forged-event"); },
    (value) => { value.domain_event_manifest_hash = hash("forged-manifest"); },
    (value) => { value.source_event.event_id = `BVE-${"f".repeat(32)}`; },
  ]) {
    const forged = structuredClone(window);
    mutate(forged);
    const readdressed = readdressWindow(forged);
    assertPewError(
      () => normalizeProviderEntryWindowV1(readdressed, {
        committed_send_authorization: proof,
      }),
      forged.committed_send_authorization_hash !== window.committed_send_authorization_hash
        ? "BUSINESS_PROVIDER_ENTRY_WINDOW_CONTINUATION_INVALID"
        : (forged.source_event.event_id !== window.source_event.event_id
          ? "BUSINESS_PROVIDER_ENTRY_WINDOW_EVENT_INVALID"
          : "BUSINESS_PROVIDER_ENTRY_WINDOW_CONTINUATION_INVALID"),
    );
  }

  for (const [label, occurredAt, expiresAt] of [
    ["equal-expiry", "2026-08-10T01:05:00.000Z", BASE_EXPIRY],
    ["regressed-expiry", "2026-08-10T01:05:00.000Z", "2026-08-10T01:09:59.999Z"],
    ["late-renewal", BASE_EXPIRY, "2026-08-10T01:20:00.000Z"],
  ]) {
    const invalidEvent = renewalEvent(proof, label, occurredAt, expiresAt);
    assertPewError(() => createProviderEntryWindowContinuationV1({
      committed_send_authorization: proof,
      previous_window: anchor,
      renewal_event: invalidEvent,
      batch_id: `business:${invalidEvent.payload.source_id}`,
    }), "BUSINESS_PROVIDER_ENTRY_WINDOW_CONTINUATION_INVALID");
  }

  // Business revision is aggregate-wide. An unrelated branch may advance it
  // while this exact sending lease remains current, so PEW must preserve that
  // normal path rather than pinning every heartbeat to the send-begin revision.
  const laterBusinessRevision = renewalEvent(
    proof,
    "later-business-revision",
    "2026-08-10T01:05:00.000Z",
    "2026-08-10T01:15:00.000Z",
  );
  laterBusinessRevision.payload.prior_work_order_revision = 2;
  laterBusinessRevision.payload.target_work_order_revision = 2;
  laterBusinessRevision.event_id = eventId(
    laterBusinessRevision.payload.source_id,
    0,
    laterBusinessRevision.type,
    laterBusinessRevision.payload,
  );
  const laterRevisionWindow = createProviderEntryWindowContinuationV1({
    committed_send_authorization: proof,
    previous_window: anchor,
    renewal_event: laterBusinessRevision,
    batch_id: `business:${laterBusinessRevision.payload.source_id}`,
  });
  assert.equal(
    laterRevisionWindow.source_event.payload.prior_work_order_revision,
    2,
  );

  const secondEvent = renewalEvent(
    proof,
    "hostile:second",
    "2026-08-10T01:12:00.000Z",
    "2026-08-10T01:22:00.000Z",
  );
  const second = createProviderEntryWindowContinuationV1({
    committed_send_authorization: proof,
    previous_window: window,
    renewal_event: secondEvent,
    batch_id: `business:${secondEvent.payload.source_id}`,
  });
  const claimedAtDrift = structuredClone(second);
  claimedAtDrift.source_event.payload.lease.claimed_at = "2026-08-10T00:59:59.000Z";
  const readdressedClaimedAtDrift = readdressWindowSourceEvent(claimedAtDrift);
  assert.deepEqual(
    normalizeProviderEntryWindowV1(readdressedClaimedAtDrift, {
      committed_send_authorization: proof,
    }),
    readdressedClaimedAtDrift,
  );
  assertPewError(() => assertProviderEntryWindowContinuationV1({
    committed_send_authorization: proof,
    previous_window: window,
    current_window: readdressedClaimedAtDrift,
  }), "BUSINESS_PROVIDER_ENTRY_WINDOW_CONTINUATION_INVALID");

  const laterRevisionFirst = createProviderEntryWindowContinuationV1({
    committed_send_authorization: proof,
    previous_window: anchor,
    renewal_event: laterBusinessRevision,
    batch_id: `business:${laterBusinessRevision.payload.source_id}`,
  });
  const regressedRevision = structuredClone(second);
  regressedRevision.previous_window_ref = laterRevisionFirst.window_ref;
  regressedRevision.previous_lease_expires_at = laterRevisionFirst.lease_expires_at;
  regressedRevision.window_sequence = laterRevisionFirst.window_sequence + 1;
  const readdressedRegressedRevision = readdressWindow(regressedRevision);
  assertPewError(() => assertProviderEntryWindowContinuationV1({
    committed_send_authorization: proof,
    previous_window: laterRevisionFirst,
    current_window: readdressedRegressedRevision,
  }), "BUSINESS_PROVIDER_ENTRY_WINDOW_CONTINUATION_INVALID");

  const backwardsEvent = renewalEvent(
    proof,
    "hostile:backwards",
    "2026-08-10T01:04:00.000Z",
    "2026-08-10T01:22:00.000Z",
  );
  assertPewError(() => createProviderEntryWindowContinuationV1({
    committed_send_authorization: proof,
    previous_window: window,
    renewal_event: backwardsEvent,
    batch_id: `business:${backwardsEvent.payload.source_id}`,
  }), "BUSINESS_PROVIDER_ENTRY_WINDOW_CONTINUATION_INVALID");
});

test("forks, orphans, skipped sequences, and same-sequence aliases never cover an entry", () => {
  const proof = committedProof("provider.turn.start", "fork");
  const anchor = createProviderEntryWindowAnchorV1({ committed_send_authorization: proof });
  const firstEvent = renewalEvent(
    proof,
    "fork:first",
    "2026-08-10T01:05:00.000Z",
    "2026-08-10T01:15:00.000Z",
  );
  const first = createProviderEntryWindowContinuationV1({
    committed_send_authorization: proof,
    previous_window: anchor,
    renewal_event: firstEvent,
    batch_id: `business:${firstEvent.payload.source_id}`,
  });
  const forkEvent = renewalEvent(
    proof,
    "fork:other",
    "2026-08-10T01:06:00.000Z",
    "2026-08-10T01:16:00.000Z",
  );
  const fork = createProviderEntryWindowContinuationV1({
    committed_send_authorization: proof,
    previous_window: anchor,
    renewal_event: forkEvent,
    batch_id: `business:${forkEvent.payload.source_id}`,
  });
  assertPewError(() => assertProviderEntryWindowCoverageV1({
    committed_send_authorization: proof,
    entry_window: first,
    current_window: fork,
  }), "BUSINESS_PROVIDER_ENTRY_WINDOW_NOT_COVERED");

  const orphan = readdressWindow({
    ...structuredClone(first),
    previous_window_ref: { id: `PEW-${"a".repeat(32)}`, hash: "a".repeat(64) },
  });
  assert.deepEqual(
    normalizeProviderEntryWindowV1(orphan, { committed_send_authorization: proof }),
    orphan,
  );
  assertPewError(() => assertProviderEntryWindowContinuationV1({
    committed_send_authorization: proof,
    previous_window: anchor,
    current_window: orphan,
  }), "BUSINESS_PROVIDER_ENTRY_WINDOW_CONTINUATION_INVALID");

  const skipped = readdressWindow({ ...structuredClone(first), window_sequence: 3 });
  assertPewError(() => assertProviderEntryWindowContinuationV1({
    committed_send_authorization: proof,
    previous_window: anchor,
    current_window: skipped,
  }), "BUSINESS_PROVIDER_ENTRY_WINDOW_CONTINUATION_INVALID");

  assert.deepEqual(assertProviderEntryWindowCoverageV1({
    committed_send_authorization: proof,
    entry_window: first,
    current_window: first,
  }), first);
  const sameSequenceAlias = readdressWindow({
    ...structuredClone(first),
    previous_window_ref: { id: `PEW-${"b".repeat(32)}`, hash: "b".repeat(64) },
  });
  assertPewError(() => assertProviderEntryWindowCoverageV1({
    committed_send_authorization: proof,
    entry_window: first,
    current_window: sameSequenceAlias,
  }), "BUSINESS_PROVIDER_ENTRY_WINDOW_NOT_COVERED");
});

test("a forked later tip cannot pass coverage without its exact intermediate chain", () => {
  const proof = committedProof("provider.turn.cancel", "later-fork");
  const anchor = createProviderEntryWindowAnchorV1({ committed_send_authorization: proof });
  function extend(previous, label, occurredAt, expiresAt) {
    const event = renewalEvent(proof, label, occurredAt, expiresAt);
    return createProviderEntryWindowContinuationV1({
      committed_send_authorization: proof,
      previous_window: previous,
      renewal_event: event,
      batch_id: `business:${event.payload.source_id}`,
    });
  }
  const entry = extend(
    anchor,
    "later-fork:entry",
    "2026-08-10T01:05:00.000Z",
    "2026-08-10T01:15:00.000Z",
  );
  const other = extend(
    anchor,
    "later-fork:other",
    "2026-08-10T01:06:00.000Z",
    "2026-08-10T01:16:00.000Z",
  );
  const forkedTip = extend(
    other,
    "later-fork:tip",
    "2026-08-10T01:12:00.000Z",
    "2026-08-10T01:22:00.000Z",
  );
  assertPewError(() => assertProviderEntryWindowCoverageV1({
    committed_send_authorization: proof,
    entry_window: entry,
    current_window: forkedTip,
  }), "BUSINESS_PROVIDER_ENTRY_WINDOW_NOT_COVERED");
  assertPewError(() => assertProviderEntryWindowCoverageV1({
    committed_send_authorization: proof,
    entry_window: entry,
    current_window: forkedTip,
    continuation_chain: [other],
  }), "BUSINESS_PROVIDER_ENTRY_WINDOW_NOT_COVERED");
});

test("receipt hashes and index pointers reject conflicting continuation content", () => {
  const proof = committedProof("provider.thread.create", "receipt-hostile");
  const anchor = createProviderEntryWindowAnchorV1({ committed_send_authorization: proof });
  const event = renewalEvent(
    proof,
    "receipt-hostile:one",
    "2026-08-10T01:05:00.000Z",
    "2026-08-10T01:15:00.000Z",
  );
  const window = createProviderEntryWindowContinuationV1({
    committed_send_authorization: proof,
    previous_window: anchor,
    renewal_event: event,
    batch_id: `business:${event.payload.source_id}`,
  });
  const receipt = renewalReceipt(window, "receipt-hostile:one");
  const index = advanceProviderEntryWindowIndexV1({
    committed_send_authorization: proof,
    current_index: createProviderEntryWindowIndexV1({ committed_send_authorization: proof }),
    current_window: anchor,
    next_window: window,
    next_window_internal_receipt: receipt,
  });

  const badHash = structuredClone(receipt);
  badHash.event_hashes[event.event_id] = hash("forged-renewal-event");
  assertPewError(() => normalizeProviderEntryWindowReceiptClosureV1({
    committed_send_authorization: proof,
    provider_entry_window: window,
    internal_receipt: badHash,
  }), "BUSINESS_PROVIDER_ENTRY_WINDOW_RECEIPT_INVALID");

  assertPewError(() => normalizeProviderEntryWindowReceiptClosureV1({
    committed_send_authorization: proof,
    provider_entry_window: window,
    internal_receipt: null,
  }), "BUSINESS_PROVIDER_ENTRY_WINDOW_INVALID");

  const secondEvent = renewalEvent(
    proof,
    "receipt-hostile:two",
    "2026-08-10T01:12:00.000Z",
    "2026-08-10T01:22:00.000Z",
  );
  const secondWindow = createProviderEntryWindowContinuationV1({
    committed_send_authorization: proof,
    previous_window: window,
    renewal_event: secondEvent,
    batch_id: `business:${secondEvent.payload.source_id}`,
  });
  const secondReceipt = renewalReceipt(secondWindow, "receipt-hostile:two");
  assert.deepEqual(assertProviderEntryWindowCoverageV1({
    committed_send_authorization: proof,
    entry_window: anchor,
    current_window: secondWindow,
    continuation_chain: [window],
  }), secondWindow);
  // A raw window chain proves ancestry, but every hop still needs its own
  // committed receipt closure at the resolver/projector trust boundary.
  assertPewError(() => normalizeProviderEntryWindowReceiptClosureV1({
    committed_send_authorization: proof,
    provider_entry_window: window,
    internal_receipt: secondReceipt,
  }), "BUSINESS_PROVIDER_ENTRY_WINDOW_RECEIPT_INVALID");

  const badResult = structuredClone(receipt);
  badResult.result.provider_entry_window_continuation.window_ref.hash = hash("forged-window");
  assertPewError(() => normalizeProviderEntryWindowReceiptClosureV1({
    committed_send_authorization: proof,
    provider_entry_window: window,
    internal_receipt: badResult,
  }), "BUSINESS_PROVIDER_ENTRY_WINDOW_RECEIPT_INVALID");

  const badIndex = structuredClone(index);
  badIndex.current_window_receipt_id = "renew:another";
  assertPewError(() => normalizeProviderEntryWindowIndexV1(badIndex, {
    committed_send_authorization: proof,
    current_window: window,
    current_window_internal_receipt: receipt,
  }), "BUSINESS_PROVIDER_ENTRY_WINDOW_INDEX_INVALID");

  assertPewError(
    () => normalizeProviderEntryWindowV1(null, { committed_send_authorization: proof }),
    "BUSINESS_PROVIDER_ENTRY_WINDOW_INVALID",
  );
});
