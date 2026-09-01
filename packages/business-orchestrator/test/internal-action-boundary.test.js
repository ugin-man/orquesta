"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { canonicalHash, canonicalJson } = require("@orquesta/contracts");
const { createEventStore } = require("@orquesta/event-store");
const { normalizeBusinessWorkOrderPlanV1 } = require("../src/contract");
const { deriveEffectOperationScopeHashV2 } = require("../src/lifecycle");
const {
  BUSINESS_EVENT_TYPES,
  OUTBOX_IMMUTABLE_FIELDS,
  initialBusinessProjectionV1,
  projectBusinessEventV1,
} = require("../src/projector");
const {
  INTERNAL_ACTION_NAMES,
  BusinessInternalActionBoundaryError,
  createBusinessInternalActionBoundary,
  normalizeInternalActionEnvelopeV1,
} = require("../src/internal-action-boundary");
const {
  buildProviderSettlementCutoverBatchV1,
  deriveProviderSettlementCutoverReadinessV1,
} = require("../src/provider-settlement-cutover-boundary");

const CREATED_AT = "2026-08-09T00:00:00.000Z";
const ATTEMPT_DEADLINE = "2026-08-09T00:01:00.000Z";
const WORK_ORDER_DEADLINE = "2026-08-09T00:10:00.000Z";
const SYSTEM_ID = "system:outbox-worker";

function contentRef(id) {
  return { id, hash: canonicalHash({ id }) };
}

function validPlan(suffix = "one") {
  return normalizeBusinessWorkOrderPlanV1({
    version: 1,
    project_ref: `project:internal-boundary:${suffix}`,
    revision: 1,
    supersedes_plan_ref: null,
    title: "Fence every durable outbox transition",
    desired_outcome: "Only an authorized system worker can mutate a current lease.",
    acceptance_policy: {
      criteria: [{
        criterion_id: "criterion:durability",
        description: "The exact lifecycle action is durably receipt-backed.",
        verification: "deterministic",
        verification_requirements: [{
          kind: "deterministic",
          verification_ref: contentRef(`verification:internal-boundary:${suffix}`),
        }],
      }],
      review_minimum: "light",
    },
    task_intent_ref: contentRef(`TI-internal-root:${suffix}`),
    execution_plan_ref: contentRef(`EP-internal-root:${suffix}`),
    context_pack_ref: contentRef(`CP-internal-root:${suffix}`),
    branches: [{
      branch_ref: `branch:${suffix}`,
      task_intent_ref: contentRef(`TI-internal-branch:${suffix}`),
      execution_plan_ref: contentRef(`EP-internal-branch:${suffix}`),
      context_pack_ref: contentRef(`CP-internal-branch:${suffix}`),
      dependencies: [],
      role: "work",
      parallelizable: false,
      isolation: "sandbox",
      assignee_ref: `assignee:${suffix}`,
      provider_ref: "provider:recorded",
      permission_mode: "workspace-write",
    }],
    integration_branch_ref: null,
    max_concurrency: 1,
    context_duplication_budget_tokens: 1_000,
    retry_policy: {
      max_attempts: 3,
      attempt_timeout_ms: 60_000,
      max_elapsed_ms: 600_000,
      backoff_initial_ms: 1_000,
      backoff_max_ms: 30_000,
      retryable_observations: ["branch.dispatch.not_sent"],
    },
    lease_policy: {
      lease_duration_ms: 30_000,
      heartbeat_interval_ms: 10_000,
      max_recovery_probes: 3,
    },
    provider_policy: {
      allowed_provider_refs: ["provider:recorded"],
      selection: "fixed",
    },
    permission_mode: "workspace-write",
  });
}

function businessEvent(plan, {
  eventId,
  type,
  sourceId,
  workOrderId,
  prior,
  target,
  occurredAt = CREATED_AT,
  specific = {},
  evidenceRefs = [],
}) {
  return {
    event_id: eventId,
    schema_version: 1,
    type,
    payload: {
      work_order_id: workOrderId,
      plan_snapshot_ref: plan.plan_snapshot_id,
      plan_hash: plan.plan_hash,
      source_id: sourceId,
      prior_work_order_revision: prior,
      target_work_order_revision: target,
      occurred_at: occurredAt,
      ...specific,
    },
    evidence_refs: evidenceRefs,
  };
}

function inputBatch(plan, {
  batchId,
  sourceId,
  sourceType,
  workOrderId,
  prior,
  target,
  occurredAt = CREATED_AT,
  events,
  result = { status: "recorded" },
}) {
  const projected = events.map((entry, index) => businessEvent(plan, {
    eventId: `${sourceId}:event:${index + 1}`,
    type: entry.type,
    sourceId,
    workOrderId,
    prior,
    target,
    occurredAt,
    specific: entry.specific,
    evidenceRefs: entry.evidenceRefs || [],
  }));
  const receiptType = {
    command: "business.command.received",
    internal_action: "business.internal_action.received",
  }[sourceType];
  projected.push(businessEvent(plan, {
    eventId: `${sourceId}:receipt`,
    type: receiptType,
    sourceId,
    workOrderId,
    prior,
    target,
    occurredAt,
    specific: {
      receipt: {
        source_id: sourceId,
        source_type: sourceType,
        identity_hash: canonicalHash({ sourceId, sourceType, fixture: true }),
        payload_hash: canonicalHash(events),
        work_order_id: workOrderId,
        applied_revision: target,
        batch_id: batchId,
        event_ids: projected.map((event) => event.event_id),
        result,
      },
    },
  }));
  return { batch_id: batchId, events: projected };
}

function startFixture({ digit = "1", suffix = "one", engineVersion = 2 } = {}) {
  const plan = validPlan(suffix);
  const workOrderId = `WO-${digit.repeat(32)}`;
  const commandId = `CMD-${digit.repeat(32)}`;
  const packet = contentRef(`packet:${suffix}`);
  const branchRef = `branch:${suffix}`;
  const dispatchId = `DSP-${canonicalHash({
    work_order_id: workOrderId,
    branch_ref: branchRef,
    attempt: 1,
    packet_ref: packet,
  }).slice(0, 32)}`;
  const operationScopeHash = deriveEffectOperationScopeHashV2({
    effect_kind: "provider.thread.create",
    provider_ref: "provider:recorded",
    packet_ref: packet.id,
    packet_hash: packet.hash,
  });
  const effectIdentity = {
    effect_contract_version: 2,
    work_order_id: workOrderId,
    branch_ref: branchRef,
    attempt: 1,
    dispatch_id: dispatchId,
    effect_kind: "provider.thread.create",
    origin_source_id: commandId,
    operation_scope_hash: operationScopeHash,
    operation_generation: 1,
    generation_predecessor_effect_id: null,
    provider_ref: "provider:recorded",
    packet_ref: packet.id,
    packet_hash: packet.hash,
    predecessor_effect_id: null,
    predecessor_delivery_hash: null,
    target_runtime_identity: null,
  };
  const effect = engineVersion === 2
    ? {
      effect_id: `FX-${canonicalHash(effectIdentity).slice(0, 32)}`,
      ...effectIdentity,
      idempotency_key: `IDEM-${canonicalHash(effectIdentity).slice(0, 32)}`,
      status: "pending",
      lease: null,
      delivery: null,
      created_at: CREATED_AT,
      updated_at: CREATED_AT,
    }
    : {
      effect_id: `effect:legacy:${suffix}`,
      work_order_id: workOrderId,
      branch_ref: branchRef,
      attempt: 1,
      dispatch_id: dispatchId,
      effect_kind: "provider.turn.start",
      provider_ref: "provider:recorded",
      packet_ref: packet.id,
      packet_hash: packet.hash,
      idempotency_key: `idempotency:legacy:${suffix}`,
      status: "pending",
      lease: null,
      delivery: null,
      created_at: CREATED_AT,
      updated_at: CREATED_AT,
    };
  const batch = inputBatch(plan, {
    batchId: `business:${commandId}`,
    sourceId: commandId,
    sourceType: "command",
    workOrderId,
    prior: 0,
    target: 1,
    events: [
      {
        type: "business.work_order.created",
        specific: {
          plan,
          ...(engineVersion === 2 ? { engine_contract_version: 2 } : {}),
          deadline_at: WORK_ORDER_DEADLINE,
        },
      },
      {
        type: "business.context_budget.verified",
        specific: {
          receipt: {
            budget_tokens: 1_000,
            duplicate_context_tokens: 100,
            evidence_refs: ["evidence:context-budget"],
          },
        },
      },
      {
        type: "business.branch.initialized",
        specific: {
          branch: plan.branches[0],
          state: "ready",
          required_criterion_ids: ["criterion:durability"],
        },
      },
      {
        type: "business.branch.attempt_opened",
        specific: {
          branch_ref: branchRef,
          attempt: 1,
          dispatch_id: dispatchId,
          attempt_started_at: CREATED_AT,
          attempt_deadline_at: ATTEMPT_DEADLINE,
          retry_at: null,
          packet_ref: packet,
          packet_hash: packet.hash,
        },
      },
      { type: "business.outbox.enqueued", specific: { effect } },
    ],
    result: { work_order_id: workOrderId, work_order_revision: 1 },
  });
  return { batch, commandId, effect, packet, plan, workOrderId };
}

function settlementCutoverBatch(projection, journalSequence = 1) {
  const projectedReadiness = deriveProviderSettlementCutoverReadinessV1(
    projection,
    journalSequence,
  );
  const assessment = {
    assessment_schema_version: 1,
    status: "ready",
    event_store_recovery: "clean",
    settlement_ingress: "stopped",
    provider_reactors: "stopped",
    send_authorization_contract_version: 2,
    projected_readiness: projectedReadiness,
  };
  const assessmentHash = canonicalHash(assessment);
  const cutoverId = `PSC-${canonicalHash({ internal_action_fixture: true }).slice(0, 32)}`;
  return buildProviderSettlementCutoverBatchV1({
    cutover: {
      version: 1,
      cutover_id: cutoverId,
      actor: { type: "system", actor_id: SYSTEM_ID },
      settlement_contract_version: 2,
      send_authorization_contract_version: 2,
      payload_hash: canonicalHash({
        settlement_contract_version: 2,
        send_authorization_contract_version: 2,
      }),
    },
    principal: { type: "system", id: SYSTEM_ID },
    projection,
    journal_sequence: journalSequence,
    readiness: {
      readiness_assessment_ref: {
        id: `PSA-${assessmentHash.slice(0, 32)}`,
        hash: assessmentHash,
      },
      assessment,
    },
    occurred_at: "2026-08-09T00:00:05.000Z",
  }).request;
}

function projectBatches(batches) {
  let state = initialBusinessProjectionV1();
  for (const batch of batches) {
    for (const event of batch.events) {
      state = projectBusinessEventV1(state, event, batch);
    }
  }
  return state;
}

function effectIdentity(effect) {
  return Object.fromEntries(OUTBOX_IMMUTABLE_FIELDS.map((field) => [field, effect[field]]));
}

function effectFacts(effect) {
  return {
    work_order_id: effect.work_order_id,
    effect_id: effect.effect_id,
    effect: effectIdentity(effect),
    status: effect.status,
    lease: effect.lease === null ? null : structuredClone(effect.lease),
  };
}

function packetVerificationReceipt(projection, effect) {
  const identity = effectIdentity(effect);
  const workOrder = projection.work_orders[effect.work_order_id];
  const branch = workOrder.plan.branches.find(
    (candidate) => candidate.branch_ref === effect.branch_ref,
  );
  const dispatchPacketRef = { id: effect.packet_ref, hash: effect.packet_hash };
  const dispatchSeed = {
    work_order_id: effect.work_order_id,
    branch_ref: effect.branch_ref,
    attempt: effect.attempt,
    packet_ref: dispatchPacketRef,
  };
  const effectSeed = Object.fromEntries(OUTBOX_IMMUTABLE_FIELDS
    .filter((field) => !["effect_id", "idempotency_key", "created_at"].includes(field))
    .map((field) => [field, identity[field]]));
  const body = {
    schema_version: 1,
    disposition: "verified",
    failure_class: null,
    failure_taxonomy_version: 1,
    delivery_disposition: "not_evaluated",
    verification_scope: "packet_integrity_and_effect_binding_only",
    retry_authorization: "not_evaluated",
    packet_ref: dispatchPacketRef,
    packet_binding: {
      work_order_id: effect.work_order_id,
      work_order_revision: workOrder.revision,
      engine_contract_version: 2,
      plan_snapshot_ref: workOrder.plan_snapshot_ref,
      plan_hash: workOrder.plan_hash,
      branch_ref: effect.branch_ref,
      next_attempt: effect.attempt,
      task_intent_ref: branch.task_intent_ref,
      execution_plan_ref: branch.execution_plan_ref,
      dispatch_packet_ref: dispatchPacketRef,
      provider_ref: effect.provider_ref,
      provider_configuration_ref: contentRef("provider-config:recorded"),
      workspace_ref: "workspace:internal-boundary",
      workspace_checkpoint_ref: contentRef("checkpoint:internal-boundary"),
      isolation_mode: branch.isolation,
      context_pack_ref: branch.context_pack_ref,
      context_manifest_ref: contentRef("context-manifest:internal-boundary"),
      context_binding_hash: canonicalHash({ context: effect.effect_id }),
      authority_ref: contentRef("authority:internal-boundary"),
      principal_type: "system",
      principal_id: SYSTEM_ID,
      project_ref: workOrder.plan.project_ref,
      permission_mode: workOrder.plan.permission_mode,
      authority_ceiling_hash: canonicalHash({ authority: effect.effect_id }),
      effect_ceiling_hash: canonicalHash({ ceiling: effect.effect_id }),
    },
    effect_identity: identity,
    dispatch_identity_hash: canonicalHash(dispatchSeed),
    effect_identity_hash: canonicalHash(identity),
    effect_identifier_seed_hash: canonicalHash(effectSeed),
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

function packetSendAuthorizationVerification(projection, effect) {
  return {
    authorization_verification_version: 1,
    packet_verification_receipt: packetVerificationReceipt(projection, effect),
    operation_scope_binding: {
      effect_kind: effect.effect_kind,
      provider_ref: effect.provider_ref,
      packet_ref: effect.packet_ref,
      packet_hash: effect.packet_hash,
      predecessor_effect_id: effect.predecessor_effect_id,
      predecessor_delivery_hash: effect.predecessor_delivery_hash,
      target_runtime_identity: effect.target_runtime_identity,
      request_id: null,
      response_ref: null,
    },
  };
}

function actionId(label) {
  return `INT-${canonicalHash({ label }).slice(0, 32)}`;
}

function internalAction(fixture, {
  label,
  name = "outbox.claim",
  effectId = fixture.effect.effect_id,
  workOrderId = fixture.workOrderId,
  expectedWorkOrderRevision = 1,
  payload,
  actorId = SYSTEM_ID,
} = {}) {
  const normalizedPayload = payload || {
    effect_id: effectId,
    lease_id: `lease:${label}`,
    owner_id: `worker:${label}`,
  };
  return {
    version: 1,
    internal_action_id: actionId(label),
    work_order_id: workOrderId,
    plan_snapshot_ref: fixture.plan.plan_snapshot_id,
    plan_hash: fixture.plan.plan_hash,
    expected_work_order_revision: expectedWorkOrderRevision,
    actor: { type: "system", actor_id: actorId },
    name,
    payload: normalizedPayload,
    payload_hash: canonicalHash(normalizedPayload),
  };
}

function leasePayload(effect, extra = {}) {
  assert.ok(effect.lease);
  return {
    effect_id: effect.effect_id,
    lease_id: effect.lease.lease_id,
    owner_id: effect.lease.owner_id,
    generation: effect.lease.generation,
    ...extra,
  };
}

function errorWithCode(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function memoryEventStore(startBatches, behavior = {}) {
  let state = projectBatches(startBatches);
  let sequence = startBatches.length;
  const committedBatches = new Map();
  const commitCalls = [];
  let conflictRemaining = behavior.conflictOnce ? 1 : 0;
  let responseLossRemaining = behavior.responseLossOnce ? 1 : 0;
  return {
    get state() { return state; },
    get sequence() { return sequence; },
    commitCalls,
    async replay() {
      return { state, watermark: { journal_sequence: sequence } };
    },
    async commit(request) {
      commitCalls.push(structuredClone(request));
      if (conflictRemaining > 0) {
        conflictRemaining -= 1;
        sequence += 1;
        throw errorWithCode("EVENT_REVISION_CONFLICT");
      }
      const serialized = canonicalJson(request);
      const existing = committedBatches.get(request.batch_id);
      if (existing) {
        if (existing.serialized !== serialized) throw errorWithCode("EVENT_BATCH_ID_CONFLICT");
        return { status: "idempotent", sequence: existing.sequence };
      }
      if (request.expected_revision !== sequence) {
        throw errorWithCode("EVENT_REVISION_CONFLICT");
      }
      let candidate = state;
      for (const event of request.events) {
        candidate = projectBusinessEventV1(candidate, event, request);
      }
      sequence += 1;
      state = candidate;
      committedBatches.set(request.batch_id, { serialized, sequence });
      if (responseLossRemaining > 0) {
        responseLossRemaining -= 1;
        throw errorWithCode("ECONNRESET", "commit response was lost");
      }
      return { status: "committed", sequence };
    },
  };
}

function boundaryFixture(store, {
  now = { value: "2026-08-09T00:00:10.000Z" },
  clock,
  authenticate,
  authorize,
  resolveEffectFacts,
  packetStore,
  maxGlobalCasRetries = 3,
  dependencyTimeoutMs = 5_000,
} = {}) {
  const calls = { authenticate: 0, authorize: 0, resolve: 0, packet: 0 };
  const effectivePacketStore = packetStore === undefined
    ? {
      async verifyForEffect(identity) {
        calls.packet += 1;
        return packetVerificationReceipt(store.state, store.state.outbox[identity.effect_id]);
      },
      async verifyForSendAuthorization(identity) {
        calls.packet += 1;
        return packetSendAuthorizationVerification(
          store.state,
          store.state.outbox[identity.effect_id],
        );
      },
    }
    : packetStore;
  const boundary = createBusinessInternalActionBoundary({
    eventStore: store,
    clock: clock || (() => now.value),
    maxGlobalCasRetries,
    dependencyTimeoutMs,
    packetStore: effectivePacketStore,
    authorizer: {
      async authenticate(args) {
        calls.authenticate += 1;
        if (authenticate) return authenticate(args, calls);
        return { principal: { type: "system", id: SYSTEM_ID } };
      },
      async authorize(args) {
        calls.authorize += 1;
        if (authorize) return authorize(args, calls);
        return {
          authorized: true,
          principal_type: "system",
          principal_id: args.principal.id,
          work_order_id: args.internal_action.work_order_id,
          effect_id: args.internal_action.payload.effect_id,
          action: args.action,
        };
      },
    },
    resolvers: {
      async resolveEffectFacts(args) {
        calls.resolve += 1;
        if (resolveEffectFacts) return resolveEffectFacts(args, calls);
        return effectFacts(store.state.outbox[args.effect_id]);
      },
    },
  });
  return { boundary, calls, now };
}

function expectBoundaryCode(code) {
  return (error) => {
    assert.ok(error instanceof BusinessInternalActionBoundaryError);
    assert.equal(error.code, code);
    return true;
  };
}

test("defines four bounded actions while withholding non-atomic expiry", async () => {
  assert.deepEqual(INTERNAL_ACTION_NAMES, [
    "outbox.claim",
    "outbox.send.begin",
    "outbox.lease.renew",
    "outbox.requeue",
  ]);
  const fixture = startFixture();
  const valid = internalAction(fixture, { label: "normalize" });
  assert.deepEqual(normalizeInternalActionEnvelopeV1(valid), valid);

  const dependencyStore = memoryEventStore([fixture.batch]);
  assert.doesNotThrow(() => boundaryFixture(dependencyStore, {
    packetStore: { async verifyForSendAuthorization() { return null; } },
  }));
  assert.throws(
    () => boundaryFixture(dependencyStore, {
      packetStore: { async verifyForEffect() { return null; } },
    }),
    /packetStore\.verifyForSendAuthorization/u,
  );

  const unsafeExpiry = { ...valid, name: "outbox.send.expire" };
  assert.throws(
    () => normalizeInternalActionEnvelopeV1(unsafeExpiry),
    expectBoundaryCode("BUSINESS_INTERNAL_ACTION_NAME_INVALID"),
  );
  const sendPayload = {
    effect_id: fixture.effect.effect_id,
    lease_id: "lease:normalize",
    owner_id: "worker:normalize",
    generation: 1,
  };
  const send = internalAction(fixture, {
    label: "normalize-send",
    name: "outbox.send.begin",
    payload: sendPayload,
  });
  assert.deepEqual(normalizeInternalActionEnvelopeV1(send), send);

  const forgedActor = structuredClone(valid);
  forgedActor.actor.type = "orchestrator";
  assert.throws(
    () => normalizeInternalActionEnvelopeV1(forgedActor),
    expectBoundaryCode("BUSINESS_INTERNAL_ACTION_ACTOR_INVALID"),
  );

  const inflated = structuredClone(valid);
  inflated.payload.expires_at = "2026-08-09T01:00:00.000Z";
  inflated.payload_hash = canonicalHash(inflated.payload);
  assert.throws(
    () => normalizeInternalActionEnvelopeV1(inflated),
    expectBoundaryCode("BUSINESS_INTERNAL_ACTION_INVALID"),
  );

  const store = memoryEventStore([fixture.batch]);
  const forgedPrincipal = boundaryFixture(store, {
    authenticate: async () => ({ principal: { type: "agent", id: SYSTEM_ID } }),
  });
  await assert.rejects(
    forgedPrincipal.boundary.execute({ internal_action: valid, authentication: "token" }),
    expectBoundaryCode("BUSINESS_INTERNAL_AUTHENTICATION_INVALID"),
  );
  const mismatchedPrincipal = boundaryFixture(store, {
    authenticate: async () => ({ principal: { type: "system", id: "system:other" } }),
  });
  await assert.rejects(
    mismatchedPrincipal.boundary.execute({ internal_action: valid, authentication: "token" }),
    expectBoundaryCode("BUSINESS_INTERNAL_ACTOR_BINDING_MISMATCH"),
  );
  assert.equal(store.commitCalls.length, 0);
});

test("keeps frozen V1 effects replayable but rejects new worker actions until migration", async () => {
  const fixture = startFixture({ suffix: "legacy-gate", engineVersion: 1 });
  const store = memoryEventStore([fixture.batch]);
  const harness = boundaryFixture(store);

  await assert.rejects(
    harness.boundary.execute({
      internal_action: internalAction(fixture, { label: "legacy-gate" }),
      authentication: "token",
    }),
    expectBoundaryCode("BUSINESS_ENGINE_MIGRATION_REQUIRED"),
  );
  assert.equal(harness.calls.authorize, 1, "immutable legacy scope is still reauthorized");
  assert.equal(harness.calls.resolve, 0, "legacy actions do not resolve mutable lease facts");
  assert.equal(store.commitCalls.length, 0);
});

test("atomically claims an effect with a plan-bound lease and exact receipt replay", async () => {
  const fixture = startFixture();
  const store = memoryEventStore([fixture.batch]);
  const harness = boundaryFixture(store);
  const action = internalAction(fixture, { label: "claim" });
  const first = await harness.boundary.execute({ internal_action: action, authentication: "token" });
  assert.deepEqual(first, {
    internal_action_id: action.internal_action_id,
    work_order_id: fixture.workOrderId,
    work_order_revision: 1,
    effect_id: fixture.effect.effect_id,
    action: "outbox.claim",
    outbox_status: "claimed",
    fencing_token: {
      lease_id: action.payload.lease_id,
      owner_id: action.payload.owner_id,
      generation: 1,
    },
  });
  assert.equal(store.commitCalls.length, 1);
  assert.deepEqual(
    store.commitCalls[0].events.map((event) => event.type),
    ["business.outbox.claimed", "business.internal_action.received"],
  );
  const claimed = store.state.outbox[fixture.effect.effect_id];
  assert.equal(claimed.status, "claimed");
  assert.equal(claimed.lease.claimed_at, "2026-08-09T00:00:10.000Z");
  assert.equal(claimed.lease.expires_at, "2026-08-09T00:00:40.000Z");
  assert.equal(store.state.work_orders[fixture.workOrderId].revision, 1);
  assert.ok(store.state.internal_receipts[action.internal_action_id]);

  const exactReplay = await harness.boundary.execute({
    internal_action: structuredClone(action),
    authentication: "token",
  });
  assert.deepEqual(exactReplay, first);
  assert.equal(store.commitCalls.length, 1);
  assert.equal(harness.calls.authorize, 2, "replay rechecks current authority");
  assert.equal(harness.calls.resolve, 1, "exact replay does not depend on a mutable lease snapshot");

  const conflicting = structuredClone(action);
  conflicting.payload.owner_id = "worker:conflicting-owner";
  conflicting.payload_hash = canonicalHash(conflicting.payload);
  await assert.rejects(
    harness.boundary.execute({ internal_action: conflicting, authentication: "token" }),
    expectBoundaryCode("BUSINESS_INTERNAL_ACTION_ID_CONFLICT"),
  );
  assert.equal(store.commitCalls.length, 1);
});

test("authorizes send only after cutover and atomically binds PacketStore verification", async () => {
  const blockedFixture = startFixture({ suffix: "send-before-cutover" });
  const blockedStore = memoryEventStore([blockedFixture.batch]);
  const blockedHarness = boundaryFixture(blockedStore);
  await blockedHarness.boundary.execute({
    internal_action: internalAction(blockedFixture, { label: "send-before-cutover-claim" }),
    authentication: "token",
  });
  const blockedEffect = blockedStore.state.outbox[blockedFixture.effect.effect_id];
  const blockedSend = internalAction(blockedFixture, {
    label: "send-before-cutover",
    name: "outbox.send.begin",
    payload: leasePayload(blockedEffect),
  });
  await assert.rejects(
    blockedHarness.boundary.execute({ internal_action: blockedSend, authentication: "token" }),
    expectBoundaryCode("BUSINESS_INTERNAL_PROVIDER_SETTLEMENT_CUTOVER_REQUIRED"),
  );
  assert.equal(blockedHarness.calls.packet, 0);
  assert.equal(blockedStore.state.outbox[blockedFixture.effect.effect_id].status, "claimed");

  const fixture = startFixture({ suffix: "packet-authorized-send" });
  const prefix = projectBatches([fixture.batch]);
  const cutover = settlementCutoverBatch(prefix);
  const store = memoryEventStore([fixture.batch, cutover]);
  const harness = boundaryFixture(store);
  await harness.boundary.execute({
    internal_action: internalAction(fixture, { label: "packet-authorized-claim" }),
    authentication: "token",
  });
  harness.now.value = "2026-08-09T00:00:11.000Z";
  const claimed = store.state.outbox[fixture.effect.effect_id];
  const preSendProjection = structuredClone(store.state);
  const send = internalAction(fixture, {
    label: "packet-authorized-send",
    name: "outbox.send.begin",
    payload: leasePayload(claimed),
  });
  const result = await harness.boundary.execute({
    internal_action: send,
    authentication: "token",
  });
  assert.equal(result.outbox_status, "sending");
  assert.deepEqual(result.fencing_token, {
    lease_id: claimed.lease.lease_id,
    owner_id: claimed.lease.owner_id,
    generation: claimed.lease.generation,
  });
  assert.equal(result.packet_verification_receipt.disposition, "verified");
  assert.equal(result.packet_verification_receipt.effect_identity.effect_id, claimed.effect_id);
  assert.equal(harness.calls.packet, 1);
  assert.equal(store.state.outbox[claimed.effect_id].status, "sending");
  assert.deepEqual(
    store.state.outbox[claimed.effect_id].packet_verification_receipt,
    result.packet_verification_receipt,
  );
  const sendCommit = store.commitCalls.at(-1);
  assert.deepEqual(sendCommit.events.map((event) => event.type), [
    "business.outbox.send_begun",
    "business.internal_action.received",
  ]);
  assert.deepEqual(
    sendCommit.events[0].payload.packet_verification_receipt,
    result.packet_verification_receipt,
  );
  const missingReceiptBatch = structuredClone(sendCommit);
  delete missingReceiptBatch.events[0].payload.packet_verification_receipt;
  assert.throws(
    () => projectBusinessEventV1(
      preSendProjection,
      missingReceiptBatch.events[0],
      missingReceiptBatch,
    ),
    { code: "BUSINESS_PROJECTION_PACKET_VERIFICATION" },
  );
  const forgedReceiptBatch = structuredClone(sendCommit);
  forgedReceiptBatch.events[0].payload.packet_verification_receipt
    .effect_identity.provider_ref = "provider:forged";
  assert.throws(
    () => projectBusinessEventV1(
      preSendProjection,
      forgedReceiptBatch.events[0],
      forgedReceiptBatch,
    ),
    { code: "BUSINESS_PROJECTION_PACKET_VERIFICATION" },
  );
  for (const [label, mutate] of [
    ["project", (receipt) => { receipt.packet_binding.project_ref = "project:wrong"; }],
    ["isolation", (receipt) => { receipt.packet_binding.isolation_mode = "read-only"; }],
    ["context", (receipt) => {
      receipt.packet_binding.context_pack_ref = contentRef("context:wrong");
    }],
  ]) {
    const mismatchedPlanBatch = structuredClone(sendCommit);
    const receipt = mismatchedPlanBatch.events[0].payload.packet_verification_receipt;
    mutate(receipt);
    const body = { ...receipt };
    delete body.receipt_ref;
    delete body.receipt_hash;
    receipt.receipt_hash = canonicalHash(body);
    receipt.receipt_ref = `dispatch-packet-verification:${receipt.receipt_hash}`;
    assert.throws(
      () => projectBusinessEventV1(
        preSendProjection,
        mismatchedPlanBatch.events[0],
        mismatchedPlanBatch,
      ),
      { code: "BUSINESS_PROJECTION_PACKET_VERIFICATION" },
      label,
    );
  }
  const forgedResultBatch = structuredClone(sendCommit);
  forgedResultBatch.events.at(-1).payload.receipt.result
    .fencing_token.owner_id = "worker:forged-result";
  assert.throws(() => {
    let candidate = preSendProjection;
    for (const event of forgedResultBatch.events) {
      candidate = projectBusinessEventV1(candidate, event, forgedResultBatch);
    }
    return candidate;
  }, { code: "BUSINESS_PROJECTION_PACKET_VERIFICATION" });

  const exactReplay = await harness.boundary.execute({
    internal_action: structuredClone(send),
    authentication: "token",
  });
  assert.deepEqual(exactReplay, result);
  assert.equal(harness.calls.packet, 1, "exact replay never reopens mutable packet storage");

  const anchorIndex = store.state.provider_entry_windows[claimed.effect_id];
  assert.equal(anchorIndex.current_window_sequence, 0);
  const revisionAdvance = inputBatch(fixture.plan, {
    batchId: "business:CMD-independent-revision-advance",
    sourceId: "CMD-independent-revision-advance",
    sourceType: "command",
    workOrderId: fixture.workOrderId,
    prior: 1,
    target: 2,
    occurredAt: "2026-08-09T00:00:15.000Z",
    events: [{
      type: "business.attention.opened",
      specific: {
        attention: {
          attention_id: "attention:independent-revision-advance",
          kind: "independent_review",
          branch_ref: null,
          detail_ref: contentRef("detail:independent-revision-advance"),
          evidence_refs: ["evidence:independent-revision-advance"],
          opened_at: "2026-08-09T00:00:15.000Z",
        },
      },
    }],
  });
  await store.commit({
    expected_revision: store.sequence,
    batch_id: revisionAdvance.batch_id,
    actor: { type: "agent", id: "fixture:independent-revision-advance" },
    correlation_id: "CMD-independent-revision-advance",
    events: revisionAdvance.events,
  });
  assert.equal(store.state.work_orders[fixture.workOrderId].revision, 2);
  const preRenewProjection = structuredClone(store.state);
  harness.now.value = "2026-08-09T00:00:20.000Z";
  const sending = store.state.outbox[claimed.effect_id];
  const renew = internalAction(fixture, {
    label: "packet-authorized-sending-renew",
    name: "outbox.lease.renew",
    expectedWorkOrderRevision: 2,
    payload: leasePayload(sending),
  });
  const renewed = await harness.boundary.execute({
    internal_action: renew,
    authentication: "token",
  });
  assert.equal(renewed.outbox_status, "sending");
  assert.deepEqual(renewed.fencing_token, result.fencing_token);
  assert.equal(renewed.provider_entry_window_continuation.window_sequence, 1);
  assert.deepEqual(
    renewed.provider_entry_window_continuation.previous_window_ref,
    anchorIndex.current_window_ref,
  );
  assert.equal(
    store.state.provider_entry_windows[claimed.effect_id].current_window_sequence,
    1,
  );
  assert.equal(
    store.state.provider_entry_windows[claimed.effect_id].current_lease_expires_at,
    store.state.outbox[claimed.effect_id].lease.expires_at,
  );
  const renewalCommit = store.commitCalls.at(-1);
  const forgedRenewal = structuredClone(renewalCommit);
  forgedRenewal.events.at(-1).payload.receipt.result
    .provider_entry_window_continuation.previous_window_ref = {
      id: "PEW-forged",
      hash: "0".repeat(64),
    };
  assert.throws(() => {
    let candidate = preRenewProjection;
    for (const event of forgedRenewal.events) {
      candidate = projectBusinessEventV1(candidate, event, forgedRenewal);
    }
    return candidate;
  }, { code: "BUSINESS_PROJECTION_PROVIDER_ENTRY_WINDOW" });
  assert.deepEqual(
    await harness.boundary.execute({
      internal_action: structuredClone(renew),
      authentication: "token",
    }),
    renewed,
    "exact continuation receipt replay does not rebuild mutable window state",
  );

  // A restart may requeue an expired claim that never crossed the provider
  // boundary. The successor claim must perform PacketStore verification from
  // scratch before it can begin sending; a sending mutation is never requeued.
  const requeueFixture = startFixture({ suffix: "packet-authorized-requeue" });
  const requeuePrefix = projectBatches([requeueFixture.batch]);
  const requeueStore = memoryEventStore([
    requeueFixture.batch,
    settlementCutoverBatch(requeuePrefix),
  ]);
  const requeueHarness = boundaryFixture(requeueStore);
  await requeueHarness.boundary.execute({
    internal_action: internalAction(requeueFixture, { label: "packet-authorized-first-claim" }),
    authentication: "token",
  });
  requeueHarness.now.value = "2026-08-09T00:00:41.000Z";
  const expiredClaim = requeueStore.state.outbox[requeueFixture.effect.effect_id];
  await requeueHarness.boundary.execute({
    internal_action: internalAction(requeueFixture, {
      label: "packet-authorized-requeue",
      name: "outbox.requeue",
      payload: leasePayload(expiredClaim, { reason: "lease_expired_before_send" }),
    }),
    authentication: "token",
  });
  assert.equal(requeueStore.state.outbox[expiredClaim.effect_id].status, "pending");
  assert.equal(requeueStore.state.outbox[expiredClaim.effect_id].packet_verification_receipt, null);

  requeueHarness.now.value = "2026-08-09T00:00:42.000Z";
  await requeueHarness.boundary.execute({
    internal_action: internalAction(requeueFixture, {
      label: "packet-authorized-reclaim",
      payload: {
        effect_id: expiredClaim.effect_id,
        lease_id: "lease:packet-authorized-reclaim",
        owner_id: "worker:packet-authorized-reclaim",
      },
    }),
    authentication: "token",
  });
  const reclaimed = requeueStore.state.outbox[expiredClaim.effect_id];
  assert.equal(reclaimed.lease.generation, 2);
  requeueHarness.now.value = "2026-08-09T00:00:43.000Z";
  const resent = await requeueHarness.boundary.execute({
    internal_action: internalAction(requeueFixture, {
      label: "packet-authorized-resend",
      name: "outbox.send.begin",
      payload: leasePayload(reclaimed),
    }),
    authentication: "token",
  });
  assert.equal(resent.fencing_token.generation, 2);
  assert.equal(requeueStore.state.outbox[expiredClaim.effect_id].status, "sending");
  assert.equal(
    requeueHarness.calls.packet,
    1,
    "a reclaimed lease receives a fresh send authorization",
  );

  const missingFixture = startFixture({ suffix: "packet-store-missing" });
  const missingPrefix = projectBatches([missingFixture.batch]);
  const missingStore = memoryEventStore([
    missingFixture.batch,
    settlementCutoverBatch(missingPrefix),
  ]);
  const claimHarness = boundaryFixture(missingStore);
  await claimHarness.boundary.execute({
    internal_action: internalAction(missingFixture, { label: "packet-store-missing-claim" }),
    authentication: "token",
  });
  const missingEffect = missingStore.state.outbox[missingFixture.effect.effect_id];
  const missingHarness = boundaryFixture(missingStore, { packetStore: null });
  await assert.rejects(
    missingHarness.boundary.execute({
      internal_action: internalAction(missingFixture, {
        label: "packet-store-missing-send",
        name: "outbox.send.begin",
        payload: leasePayload(missingEffect),
      }),
      authentication: "token",
    }),
    expectBoundaryCode("BUSINESS_INTERNAL_PACKET_STORE_REQUIRED"),
  );
  assert.equal(missingStore.state.outbox[missingEffect.effect_id].status, "claimed");

  const expiryFixture = startFixture({ suffix: "packet-verification-expiry" });
  const expiryPrefix = projectBatches([expiryFixture.batch]);
  const expiryStore = memoryEventStore([
    expiryFixture.batch,
    settlementCutoverBatch(expiryPrefix),
  ]);
  const expiryClaimHarness = boundaryFixture(expiryStore);
  await expiryClaimHarness.boundary.execute({
    internal_action: internalAction(expiryFixture, { label: "packet-expiry-claim" }),
    authentication: "token",
  });
  const expiryEffect = expiryStore.state.outbox[expiryFixture.effect.effect_id];
  const clockValues = [
    "2026-08-09T00:00:39.999Z",
    "2026-08-09T00:00:40.000Z",
  ];
  const expiryHarness = boundaryFixture(expiryStore, {
    clock: () => clockValues.shift() || "2026-08-09T00:00:40.000Z",
    packetStore: {
      async verifyForEffect() {
        return packetVerificationReceipt(expiryStore.state, expiryEffect);
      },
      async verifyForSendAuthorization() {
        return packetSendAuthorizationVerification(expiryStore.state, expiryEffect);
      },
    },
  });
  await assert.rejects(
    expiryHarness.boundary.execute({
      internal_action: internalAction(expiryFixture, {
        label: "packet-expiry-send",
        name: "outbox.send.begin",
        payload: leasePayload(expiryEffect),
      }),
      authentication: "token",
    }),
    expectBoundaryCode("BUSINESS_INTERNAL_SEND_NOT_AUTHORIZED"),
  );
  assert.equal(expiryStore.state.outbox[expiryEffect.effect_id].status, "claimed");
});

test("replays an early internal receipt without synthesizing modern fencing fields", async () => {
  const fixture = startFixture({ suffix: "historical-internal-result" });
  const action = internalAction(fixture, { label: "historical-internal-result" });
  const lease = {
    lease_id: action.payload.lease_id,
    owner_id: action.payload.owner_id,
    generation: 1,
    claimed_at: "2026-08-09T00:00:10.000Z",
    heartbeat_at: "2026-08-09T00:00:10.000Z",
    expires_at: "2026-08-09T00:00:40.000Z",
  };
  const historicalResult = {
    internal_action_id: action.internal_action_id,
    work_order_id: fixture.workOrderId,
    work_order_revision: 1,
    effect_id: fixture.effect.effect_id,
    action: "outbox.claim",
    outbox_status: "claimed",
  };
  const historicalClaim = inputBatch(fixture.plan, {
    batchId: `business:${action.internal_action_id}`,
    sourceId: action.internal_action_id,
    sourceType: "internal_action",
    workOrderId: fixture.workOrderId,
    prior: 1,
    target: 1,
    occurredAt: lease.claimed_at,
    events: [{
      type: "business.outbox.claimed",
      specific: {
        effect_id: fixture.effect.effect_id,
        effect: effectIdentity(fixture.effect),
        lease,
      },
    }],
    result: historicalResult,
  });
  historicalClaim.events.at(-1).payload.receipt.identity_hash = canonicalHash({
    source_type: "internal_action",
    internal_action: action,
    authenticated_principal: { type: "system", id: SYSTEM_ID },
  });
  historicalClaim.events.at(-1).payload.receipt.payload_hash = action.payload_hash;
  const store = memoryEventStore([fixture.batch, historicalClaim]);
  const harness = boundaryFixture(store, { packetStore: null });
  const replayed = await harness.boundary.execute({
    internal_action: structuredClone(action),
    authentication: "token",
  });
  assert.deepEqual(replayed, historicalResult);
  assert.equal(Object.hasOwn(replayed, "fencing_token"), false);
  assert.equal(store.commitCalls.length, 0);
  assert.equal(harness.calls.resolve, 0);
});

test("send authorization is reverified after CAS and recovered from a lost commit response", async () => {
  async function claimedPrefix(suffix) {
    const fixture = startFixture({ suffix });
    const prefix = projectBatches([fixture.batch]);
    const cutover = settlementCutoverBatch(prefix);
    const preparationStore = memoryEventStore([fixture.batch, cutover]);
    const preparationHarness = boundaryFixture(preparationStore);
    await preparationHarness.boundary.execute({
      internal_action: internalAction(fixture, { label: `${suffix}-claim` }),
      authentication: "token",
    });
    return {
      fixture,
      batches: [fixture.batch, cutover, preparationStore.commitCalls.at(-1)],
    };
  }

  const conflicted = await claimedPrefix("send-cas");
  const conflictedStore = memoryEventStore(conflicted.batches, { conflictOnce: true });
  const clockValues = [
    "2026-08-09T00:00:11.000Z",
    "2026-08-09T00:00:11.001Z",
    "2026-08-09T00:00:12.000Z",
    "2026-08-09T00:00:12.001Z",
  ];
  const conflictedHarness = boundaryFixture(conflictedStore, {
    clock: () => clockValues.shift() || "2026-08-09T00:00:12.001Z",
  });
  const conflictedEffect = conflictedStore.state.outbox[conflicted.fixture.effect.effect_id];
  const conflictedResult = await conflictedHarness.boundary.execute({
    internal_action: internalAction(conflicted.fixture, {
      label: "send-cas-authorize",
      name: "outbox.send.begin",
      payload: leasePayload(conflictedEffect),
    }),
    authentication: "token",
  });
  assert.equal(conflictedResult.outbox_status, "sending");
  assert.equal(conflictedHarness.calls.packet, 2, "CAS retry rereads the PacketStore proof");
  assert.equal(conflictedHarness.calls.authorize, 2, "CAS retry reauthorizes the action");
  assert.equal(conflictedStore.commitCalls.length, 2);

  const lost = await claimedPrefix("send-response-loss");
  const lostStore = memoryEventStore(lost.batches, { responseLossOnce: true });
  const lostHarness = boundaryFixture(lostStore, {
    now: { value: "2026-08-09T00:00:11.000Z" },
  });
  const lostEffect = lostStore.state.outbox[lost.fixture.effect.effect_id];
  const lostAction = internalAction(lost.fixture, {
    label: "send-response-loss-authorize",
    name: "outbox.send.begin",
    payload: leasePayload(lostEffect),
  });
  const recovered = await lostHarness.boundary.execute({
    internal_action: lostAction,
    authentication: "token",
  });
  assert.equal(recovered.outbox_status, "sending");
  assert.equal(lostHarness.calls.packet, 1, "receipt recovery does not reopen PacketStore");
  assert.equal(lostStore.commitCalls.length, 1);
  assert.deepEqual(
    recovered,
    lostStore.state.internal_receipts[lostAction.internal_action_id].result,
  );
});

test("rejects a cross-Work-Order effect before fact resolution or persistence", async () => {
  const first = startFixture({ digit: "1", suffix: "one" });
  const second = startFixture({ digit: "2", suffix: "two" });
  const store = memoryEventStore([first.batch, second.batch]);
  const harness = boundaryFixture(store);
  const crossWorkOrder = internalAction(first, {
    label: "cross-work-order",
    effectId: second.effect.effect_id,
    payload: {
      effect_id: second.effect.effect_id,
      lease_id: "lease:cross-work-order",
      owner_id: "worker:cross-work-order",
    },
  });
  await assert.rejects(
    harness.boundary.execute({ internal_action: crossWorkOrder, authentication: "token" }),
    expectBoundaryCode("BUSINESS_INTERNAL_EFFECT_BINDING_MISMATCH"),
  );
  assert.equal(harness.calls.resolve, 0);
  assert.equal(harness.calls.authorize, 0);
  assert.equal(store.commitCalls.length, 0);
});

test("prevents lease inflation and binds renewal to the current token", async () => {
  const fixture = startFixture({ suffix: "lifecycle" });
  const store = memoryEventStore([fixture.batch]);
  const harness = boundaryFixture(store);
  await harness.boundary.execute({
    internal_action: internalAction(fixture, { label: "lifecycle-claim" }),
    authentication: "token",
  });
  harness.now.value = "2026-08-09T00:00:20.000Z";
  let current = store.state.outbox[fixture.effect.effect_id];
  const renew = internalAction(fixture, {
    label: "lifecycle-renew",
    name: "outbox.lease.renew",
    payload: leasePayload(current),
  });
  await harness.boundary.execute({ internal_action: renew, authentication: "token" });
  const renewalResult = store.state.internal_receipts[renew.internal_action_id].result;
  assert.equal(Object.hasOwn(renewalResult, "provider_entry_window_continuation"), false);
  current = store.state.outbox[fixture.effect.effect_id];
  assert.equal(current.lease.expires_at, "2026-08-09T00:00:50.000Z");

  const inflated = structuredClone(renew);
  inflated.internal_action_id = actionId("inflated-renew");
  inflated.payload.expires_at = "2026-08-09T00:10:00.000Z";
  inflated.payload_hash = canonicalHash(inflated.payload);
  await assert.rejects(
    harness.boundary.execute({ internal_action: inflated, authentication: "token" }),
    expectBoundaryCode("BUSINESS_INTERNAL_ACTION_INVALID"),
  );

  assert.equal(store.state.outbox[fixture.effect.effect_id].status, "claimed");
});

test("recovers a lost commit response but refreshes facts and authority after global CAS", async () => {
  const lostFixture = startFixture({ suffix: "response-loss" });
  const lostStore = memoryEventStore([lostFixture.batch], { responseLossOnce: true });
  const lostHarness = boundaryFixture(lostStore);
  const lostAction = internalAction(lostFixture, { label: "response-loss" });
  const recovered = await lostHarness.boundary.execute({
    internal_action: lostAction,
    authentication: "token",
  });
  assert.equal(recovered.outbox_status, "claimed");
  assert.ok(lostStore.state.internal_receipts[lostAction.internal_action_id]);
  assert.equal(lostStore.commitCalls.length, 1);

  const revokedFixture = startFixture({ suffix: "revoked" });
  const revokedStore = memoryEventStore([revokedFixture.batch], { conflictOnce: true });
  const revokedHarness = boundaryFixture(revokedStore, {
    authorize(args, calls) {
      if (calls.authorize === 2) return null;
      return {
        authorized: true,
        principal_type: "system",
        principal_id: args.principal.id,
        work_order_id: args.internal_action.work_order_id,
        effect_id: args.internal_action.payload.effect_id,
        action: args.action,
      };
    },
  });
  await assert.rejects(
    revokedHarness.boundary.execute({
      internal_action: internalAction(revokedFixture, { label: "cas-revoked" }),
      authentication: "token",
    }),
    expectBoundaryCode("BUSINESS_INTERNAL_AUTHORIZATION_DENIED"),
  );
  assert.equal(revokedHarness.calls.resolve, 1);
  assert.equal(revokedHarness.calls.authorize, 2);
  assert.equal(revokedStore.commitCalls.length, 1);
  assert.equal(
    revokedStore.state.outbox[revokedFixture.effect.effect_id].status,
    "pending",
  );
});

test("stale or malformed authoritative facts and unsafe deadlines never reach commit", async () => {
  const fixture = startFixture({ suffix: "malformed" });
  const store = memoryEventStore([fixture.batch]);
  const malformedFacts = boundaryFixture(store, {
    resolveEffectFacts(args) {
      return {
        ...effectFacts(store.state.outbox[args.effect_id]),
        unexpected: true,
      };
    },
  });
  await assert.rejects(
    malformedFacts.boundary.execute({
      internal_action: internalAction(fixture, { label: "malformed-facts" }),
      authentication: "token",
    }),
    expectBoundaryCode("BUSINESS_INTERNAL_ACTION_FACTS_INVALID"),
  );
  assert.equal(store.commitCalls.length, 0);

  const deadlineHarness = boundaryFixture(store, {
    now: { value: ATTEMPT_DEADLINE },
  });
  await assert.rejects(
    deadlineHarness.boundary.execute({
      internal_action: internalAction(fixture, { label: "deadline-claim" }),
      authentication: "token",
    }),
    (error) => {
      assert.equal(error.code, "BUSINESS_INTERNAL_ACTION_REJECTED");
      assert.equal(error.details.cause_code, "BUSINESS_PROJECTION_TRANSITION");
      return true;
    },
  );
  assert.equal(store.commitCalls.length, 0);
});

test("supports bounded dependency timeout and caller cancellation without a partial batch", async () => {
  const fixture = startFixture({ suffix: "abort" });
  const store = memoryEventStore([fixture.batch]);
  const stalledReplayStore = {
    get state() { return store.state; },
    commitCalls: [],
    replay() { return new Promise(() => {}); },
    commit() { throw new Error("unreachable"); },
  };
  const replayTimeoutHarness = boundaryFixture(stalledReplayStore, {
    dependencyTimeoutMs: 10,
  });
  await assert.rejects(
    replayTimeoutHarness.boundary.execute({
      internal_action: internalAction(fixture, { label: "replay-timeout" }),
      authentication: "token",
    }),
    expectBoundaryCode("BUSINESS_INTERNAL_DEPENDENCY_TIMEOUT"),
  );

  const timeoutHarness = boundaryFixture(store, {
    dependencyTimeoutMs: 10,
    authenticate: async () => new Promise(() => {}),
  });
  await assert.rejects(
    timeoutHarness.boundary.execute({
      internal_action: internalAction(fixture, { label: "timeout" }),
      authentication: "token",
    }),
    expectBoundaryCode("BUSINESS_INTERNAL_DEPENDENCY_TIMEOUT"),
  );

  const abortHarness = boundaryFixture(store);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    abortHarness.boundary.execute({
      internal_action: internalAction(fixture, { label: "abort" }),
      authentication: "token",
      signal: controller.signal,
    }),
    expectBoundaryCode("BUSINESS_INTERNAL_ACTION_ABORTED"),
  );
  assert.equal(store.commitCalls.length, 0);
});

test("real EventStore projection preflight leaves no malformed durable evidence", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-internal-boundary-"));
  const fixture = startFixture({ suffix: "real-store" });
  const reducers = Object.fromEntries(BUSINESS_EVENT_TYPES.map((type) => [
    type,
    (state, event, batch) => projectBusinessEventV1(state, event, batch),
  ]));
  try {
    const store = createEventStore({
      stateRoot: root,
      workspaceId: "business-internal-boundary",
      preflightProjection: true,
      reducers,
      initialState: initialBusinessProjectionV1(),
      clock: () => CREATED_AT,
    });
    store.commit({
      expected_revision: 0,
      batch_id: fixture.batch.batch_id,
      actor: { type: "agent", id: "test:orchestrator" },
      correlation_id: fixture.commandId,
      events: fixture.batch.events,
    });
    const journalPath = path.join(root, "events.jsonl");
    assert.equal(fs.readFileSync(journalPath, "utf8").trim().split("\n").length, 1);

    const badSource = actionId("real-store-inflated");
    const badBatch = inputBatch(fixture.plan, {
      batchId: `business:${badSource}`,
      sourceId: badSource,
      sourceType: "internal_action",
      workOrderId: fixture.workOrderId,
      prior: 1,
      target: 1,
      occurredAt: "2026-08-09T00:00:10.000Z",
      events: [{
        type: "business.outbox.claimed",
        specific: {
          effect_id: fixture.effect.effect_id,
          effect: effectIdentity(fixture.effect),
          lease: {
            lease_id: "lease:inflated",
            owner_id: "worker:inflated",
            generation: 1,
            claimed_at: "2026-08-09T00:00:10.000Z",
            heartbeat_at: "2026-08-09T00:00:10.000Z",
            expires_at: "2026-08-09T00:10:00.000Z",
          },
        },
      }],
    });
    assert.throws(
      () => store.commit({
        expected_revision: 1,
        batch_id: badBatch.batch_id,
        actor: { type: "system", id: SYSTEM_ID },
        correlation_id: badSource,
        events: badBatch.events,
      }),
      { code: "BUSINESS_PROJECTION_TRANSITION" },
    );
    assert.equal(fs.readFileSync(journalPath, "utf8").trim().split("\n").length, 1);
    assert.deepEqual(fs.existsSync(path.join(root, "pending"))
      ? fs.readdirSync(path.join(root, "pending"))
      : [], []);

    const harness = boundaryFixture(store, {
      resolveEffectFacts(args) {
        return effectFacts(store.replay().state.outbox[args.effect_id]);
      },
    });
    const action = internalAction(fixture, { label: "real-store-valid" });
    const result = await harness.boundary.execute({
      internal_action: action,
      authentication: "token",
    });
    assert.equal(result.outbox_status, "claimed");
    assert.equal(store.replay(reducers).state.outbox[fixture.effect.effect_id].status, "claimed");
    assert.equal(fs.readFileSync(journalPath, "utf8").trim().split("\n").length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
