"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { canonicalHash } = require("@orquesta/contracts");
const { normalizeBusinessWorkOrderPlanV1 } = require("../src/contract");
const {
  BusinessDecisionError,
  decideWorkOrderV1,
} = require("../src/state-machine");
const {
  OUTBOX_IMMUTABLE_FIELDS,
  initialBusinessProjectionV1,
  projectBusinessEventV1,
} = require("../src/projector");

const WORK_ORDER_ID = `WO-${"1".repeat(32)}`;
const BASE_TIME = "2026-08-09T00:00:00.000Z";
let sourceSequence = 0;

function ref(id, seed = id) {
  return { id, hash: canonicalHash({ seed }) };
}

function branch(branchRef, suffix, overrides = {}) {
  return {
    branch_ref: branchRef,
    task_intent_ref: ref(`TI-${suffix}`),
    execution_plan_ref: ref(`EP-${suffix}`),
    context_pack_ref: ref(`CP-${suffix}`),
    dependencies: [],
    role: "work",
    parallelizable: true,
    isolation: "worktree",
    assignee_ref: `agent:${suffix}`,
    provider_ref: "provider:recorded",
    permission_mode: "workspace-write",
    ...overrides,
  };
}

function rawPlan(overrides = {}) {
  const verificationRef = ref("verification:tests");
  return {
    version: 1,
    project_ref: "project:business-v5",
    revision: 1,
    supersedes_plan_ref: null,
    title: "Durably execute a bounded change",
    desired_outcome: "The verified result is accepted without duplicate provider work.",
    acceptance_policy: {
      criteria: [{
        criterion_id: "criterion:tests",
        description: "The deterministic verification passes.",
        verification: "deterministic",
        verification_requirements: [{
          kind: "deterministic",
          verification_ref: verificationRef,
        }],
      }],
      review_minimum: "light",
    },
    task_intent_ref: ref("TI-root"),
    execution_plan_ref: ref("EP-root"),
    context_pack_ref: ref("CP-root"),
    branches: [branch("branch:solo", "solo", { isolation: "sandbox" })],
    integration_branch_ref: null,
    max_concurrency: 1,
    context_duplication_budget_tokens: 100,
    retry_policy: {
      max_attempts: 3,
      attempt_timeout_ms: 60_000,
      max_elapsed_ms: 300_000,
      backoff_initial_ms: 1_000,
      backoff_max_ms: 10_000,
      retryable_observations: ["branch.dispatch.not_sent"],
    },
    lease_policy: {
      lease_duration_ms: 30_000,
      heartbeat_interval_ms: 5_000,
      max_recovery_probes: 3,
    },
    provider_policy: {
      allowed_provider_refs: ["provider:recorded"],
      selection: "fixed",
    },
    permission_mode: "workspace-write",
    ...overrides,
  };
}

function multiPlan(overrides = {}) {
  return rawPlan({
    branches: [
      branch("branch:alpha", "alpha"),
      branch("branch:beta", "beta", { isolation: "remote" }),
      branch("branch:integration", "integration", {
        dependencies: ["branch:alpha", "branch:beta"],
        role: "integration",
        parallelizable: false,
      }),
    ],
    integration_branch_ref: "branch:integration",
    max_concurrency: 2,
    ...overrides,
  });
}

function id(prefix) {
  sourceSequence += 1;
  return `${prefix}-${sourceSequence.toString(16).padStart(32, "0")}`;
}

function command(plan, name, payload, revision) {
  const actorType = ["user_input.resolve", "acceptance.decision.record"].includes(name)
    ? "user"
    : "orchestrator";
  return {
    version: 1,
    command_id: id("CMD"),
    work_order_id: WORK_ORDER_ID,
    plan_snapshot_ref: plan.plan_snapshot_id,
    plan_hash: plan.plan_hash,
    expected_work_order_revision: revision,
    actor: { type: actorType, actor_id: `${actorType}:primary` },
    name,
    payload,
    payload_hash: canonicalHash(payload),
  };
}

function observation(plan, name, payload, revision, actor) {
  const actorType = actor || (["verification.recorded", "review.recorded"].includes(name)
    ? "verifier"
    : [
      "work_order.started",
      "work_order.cancelled",
      "branch.dispatch.not_sent",
      "branch.timed_out",
      "branch.delivery_unknown",
    ].includes(name)
      ? "runtime"
      : "provider");
  return {
    version: 1,
    observation_id: id("OBS"),
    work_order_id: WORK_ORDER_ID,
    plan_snapshot_ref: plan.plan_snapshot_id,
    plan_hash: plan.plan_hash,
    work_order_revision: revision,
    actor: { type: actorType, actor_id: `${actorType}:primary` },
    name,
    payload,
    payload_hash: canonicalHash(payload),
  };
}

function derivedRef(prefix, content) {
  const hash = canonicalHash(content);
  return { id: `${prefix}-${hash.slice(0, 32)}`, hash };
}

function settlementObservation(plan, effect, classification, revision) {
  const payload = {
    effect_id: effect.effect_id,
    effect_contract_version: 2,
    effect_kind: effect.effect_kind,
    branch_ref: effect.branch_ref,
    attempt: effect.attempt,
    dispatch_id: effect.dispatch_id,
    classification,
    settlement_source: "worker_result",
    worker_fencing_token: {
      lease_id: effect.lease.lease_id,
      owner_id: effect.lease.owner_id,
      generation: effect.lease.generation,
    },
    worker_result_ref: derivedRef("WRR", {
      effect_id: effect.effect_id,
      generation: effect.lease.generation,
      classification,
    }),
  };
  return {
    version: 2,
    observation_id: id("OBS"),
    work_order_id: WORK_ORDER_ID,
    plan_snapshot_ref: plan.plan_snapshot_id,
    plan_hash: plan.plan_hash,
    work_order_revision: revision,
    actor: { type: "runtime", actor_id: "runtime:settlement" },
    name: "provider.effect.settlement.recorded",
    payload,
    payload_hash: canonicalHash(payload),
  };
}

function presendFailureObservation(plan, effect, reason, revision) {
  const payload = {
    effect_id: effect.effect_id,
    effect_contract_version: 2,
    effect_kind: effect.effect_kind,
    branch_ref: effect.branch_ref,
    attempt: effect.attempt,
    dispatch_id: effect.dispatch_id,
    claimed_fencing_token: {
      lease_id: effect.lease.lease_id,
      owner_id: effect.lease.owner_id,
      generation: effect.lease.generation,
    },
    failure_reason: reason,
    failure_record_ref: derivedRef("PFR", {
      effect_id: effect.effect_id,
      lease_id: effect.lease.lease_id,
      reason,
    }),
  };
  return {
    version: 2,
    observation_id: id("OBS"),
    work_order_id: WORK_ORDER_ID,
    plan_snapshot_ref: plan.plan_snapshot_id,
    plan_hash: plan.plan_hash,
    work_order_revision: revision,
    actor: { type: "runtime", actor_id: "system:presend-control-plane" },
    name: "provider.effect.presend_failure.recorded",
    payload,
    payload_hash: canonicalHash(payload),
  };
}

function settlementFacts(current, effect, time, reason) {
  return observationFacts(time, {
    delivery_effect: effectDeliveryFact(effect),
    settlement_certainty_fact: {
      certainty_fact_version: 2,
      effect_contract_version: 2,
      effect_kind: effect.effect_kind,
      effect_stage: effect.effect_kind === "provider.thread.create"
        ? "thread_create"
        : "turn_start",
      settlement_source: "worker_result",
      classification: "not_sent",
      reason,
    },
  });
}

function packets(plan, suffix = "initial") {
  return Object.fromEntries(plan.branches.map((item) => [
    item.branch_ref,
    ref(`packet:${item.branch_ref}:${suffix}`, suffix),
  ]));
}

function startFacts(plan, occurredAt = BASE_TIME) {
  const allCriteria = plan.acceptance_policy.criteria.map((item) => item.criterion_id);
  return {
    occurred_at: occurredAt,
    plan,
    context_budget_receipt: {
      budget_tokens: plan.context_duplication_budget_tokens,
      duplicate_context_tokens: plan.context_duplication_budget_tokens,
      evidence_refs: ["evidence:context-budget"],
    },
    branch_criterion_ids: Object.fromEntries(plan.branches.map((item) => [
      item.branch_ref,
      allCriteria,
    ])),
    dispatch_packets: packets(plan),
  };
}

function sourceId(input) {
  return input.command_id || input.observation_id;
}

function applyDecision(projection, input, decision) {
  const first = decision.events[0];
  assert.ok(first, "a public input must produce at least one event");
  const source = sourceId(input);
  const receiptId = `BEV-${canonicalHash({ source, receipt: true }).slice(0, 32)}`;
  const batchId = `business:${source}`;
  const eventIds = decision.events.map((event) => event.event_id);
  const receiptEvent = {
    event_id: receiptId,
    schema_version: 1,
    type: input.command_id ? "business.command.received" : "business.observation.received",
    payload: {
      work_order_id: input.work_order_id,
      plan_snapshot_ref: input.plan_snapshot_ref,
      plan_hash: input.plan_hash,
      source_id: source,
      prior_work_order_revision: first.payload.prior_work_order_revision,
      target_work_order_revision: first.payload.target_work_order_revision,
      occurred_at: first.payload.occurred_at,
      receipt: {
        source_id: source,
        source_type: input.command_id ? "command" : "observation",
        identity_hash: canonicalHash(input),
        payload_hash: input.payload_hash,
        work_order_id: input.work_order_id,
        applied_revision: first.payload.target_work_order_revision,
        batch_id: batchId,
        event_ids: eventIds,
        result: decision.result,
      },
    },
    evidence_refs: [],
  };
  const batchEvents = [...decision.events, receiptEvent];
  let next = projection;
  for (const event of batchEvents) {
    next = projectBusinessEventV1(next, event, { batch_id: batchId, events: batchEvents });
  }
  return next;
}

function start(planInput = rawPlan(), factsOverride = {}) {
  const plan = normalizeBusinessWorkOrderPlanV1(planInput);
  const input = command(plan, "work_order.start", {}, 0);
  const facts = { ...startFacts(plan), ...factsOverride };
  const decision = decide(null, input, facts);
  const projection = applyDecision(initialBusinessProjectionV1(), input, decision);
  return { plan, input, decision, projection, state: projection.work_orders[WORK_ORDER_ID] };
}

function decideAndApply(current, input, facts) {
  const decision = decide(current.state, input, facts);
  const projection = applyDecision(current.projection, input, decision);
  return {
    ...current,
    input,
    decision,
    projection,
    state: projection.work_orders[WORK_ORDER_ID],
  };
}

function decide(state, input, facts) {
  const trusted = input.observation_id && !facts.authenticated_principal
    ? {
      ...facts,
      authenticated_principal: { type: "agent", id: input.actor.actor_id },
    }
    : facts;
  return decideWorkOrderV1(state, input, trusted);
}

function observationFacts(time, overrides = {}) {
  return {
    occurred_at: time,
    observation_evidence_refs: [`evidence:observation-${sourceSequence + 1}`],
    ...overrides,
  };
}

function eventTypes(decision) {
  return decision.events.map((event) => event.type);
}

function currentStartEffect(current, branchRef) {
  return currentEffect(current, branchRef, ["provider.thread.create", "provider.turn.start"]);
}

function currentEffect(current, branchRef, effectKinds) {
  const branchState = current.state.branches[branchRef];
  const matches = Object.values(current.projection.outbox).filter((effect) => (
    effect.branch_ref === branchRef
      && effect.attempt === branchState.attempt
      && effect.dispatch_id === branchState.dispatch_id
      && effectKinds.includes(effect.effect_kind)
      && ["pending", "claimed", "sending", "delivery_unknown"].includes(effect.status)
  ));
  assert.equal(matches.length, 1);
  return matches[0];
}

function deliveryFact(current, branchRef) {
  const effect = currentStartEffect(current, branchRef);
  return effectDeliveryFact(effect);
}

function effectDeliveryFact(effect) {
  return {
    effect_id: effect.effect_id,
    effect_contract_version: effect.effect_contract_version,
    work_order_id: effect.work_order_id,
    branch_ref: effect.branch_ref,
    attempt: effect.attempt,
    dispatch_id: effect.dispatch_id,
    effect_kind: effect.effect_kind,
    origin_source_id: effect.origin_source_id,
    operation_scope_hash: effect.operation_scope_hash,
    operation_generation: effect.operation_generation,
    generation_predecessor_effect_id: effect.generation_predecessor_effect_id,
    provider_ref: effect.provider_ref,
    packet_ref: effect.packet_ref,
    packet_hash: effect.packet_hash,
    predecessor_effect_id: effect.predecessor_effect_id,
    predecessor_delivery_hash: effect.predecessor_delivery_hash,
    target_runtime_identity: effect.target_runtime_identity,
    idempotency_key: effect.idempotency_key,
    created_at: effect.created_at,
    fencing_token: effect.lease
      ? {
        lease_id: effect.lease.lease_id,
        owner_id: effect.lease.owner_id,
        generation: effect.lease.generation,
      }
      : null,
    status: effect.status,
  };
}

function cancellationFact(current, branchRef) {
  const { fencing_token: ignored, ...fact } = deliveryFact(current, branchRef);
  void ignored;
  return fact;
}

function cancellationFactForEffect(effect) {
  const { fencing_token: ignored, ...fact } = effectDeliveryFact(effect);
  void ignored;
  return fact;
}

function branchAttemptRetryBasis(current, branchRef) {
  const branch = current.state.branches[branchRef];
  return {
    kind: "branch_attempt",
    terminal_evidence: {
      kind: branch.last_runtime_observation?.name === "branch.failed"
        ? "accepted_runtime_failure"
        : "accepted_result_failure",
      attempt: branch.attempt,
      dispatch_id: branch.dispatch_id,
      delivery: structuredClone(branch.delivery),
      runtime_observation: structuredClone(branch.last_runtime_observation),
      result: structuredClone(branch.result),
    },
  };
}

function effectGenerationRetryBasis(current, effectId) {
  const effect = current.projection.outbox[effectId];
  const branch = current.state.branches[effect.branch_ref];
  return {
    kind: "effect_generation",
    predecessor: cancellationFactForEffect(effect),
    settlement_policy: structuredClone(effect.settlement_policy),
    eligible_at: branch.retry_at,
  };
}

function prepareDelivery(current, branchRef, targetStatus, occurredAt, effectKind = null) {
  const effect = effectKind === null
    ? currentStartEffect(current, branchRef)
    : currentEffect(current, branchRef, [effectKind]);
  if (effect.status === targetStatus) return current;
  assert.equal(effect.status, "pending");
  const source = id("INT");
  const batchId = `business:${source}`;
  const common = {
    work_order_id: WORK_ORDER_ID,
    plan_snapshot_ref: current.plan.plan_snapshot_id,
    plan_hash: current.plan.plan_hash,
    source_id: source,
    prior_work_order_revision: current.state.revision,
    target_work_order_revision: current.state.revision,
    occurred_at: occurredAt,
  };
  const lease = {
    lease_id: `lease:${source}`,
    owner_id: "worker:recorded",
    generation: 1,
    claimed_at: occurredAt,
    heartbeat_at: occurredAt,
    expires_at: new Date(Date.parse(occurredAt) + 30_000).toISOString(),
  };
  const { fencing_token: ignoredFencingToken, status: ignoredStatus, ...effectIdentity } = effectDeliveryFact(effect);
  void ignoredFencingToken;
  void ignoredStatus;
  const specifics = [{
    type: "business.outbox.claimed",
    specific: { effect_id: effect.effect_id, effect: effectIdentity, lease },
  }];
  if (targetStatus === "sending") {
    specifics.push({
      type: "business.outbox.send_begun",
      specific: {
        effect_id: effect.effect_id,
        lease_id: lease.lease_id,
        lease_owner_id: lease.owner_id,
        lease_generation: lease.generation,
        effect: effectIdentity,
      },
    });
  } else {
    assert.equal(targetStatus, "claimed");
  }
  const events = specifics.map((entry, index) => ({
    event_id: `BEV-${canonicalHash({ source, index, type: entry.type }).slice(0, 32)}`,
    schema_version: 1,
    type: entry.type,
    payload: { ...common, ...entry.specific },
    evidence_refs: [],
  }));
  const receiptId = `BEV-${canonicalHash({ source, receipt: true }).slice(0, 32)}`;
  events.push({
    event_id: receiptId,
    schema_version: 1,
    type: "business.internal_action.received",
    payload: {
      ...common,
      receipt: {
        source_id: source,
        source_type: "internal_action",
        identity_hash: canonicalHash({ source, targetStatus }),
        payload_hash: canonicalHash(specifics),
        work_order_id: WORK_ORDER_ID,
        applied_revision: current.state.revision,
        batch_id: batchId,
        event_ids: events.map((entry) => entry.event_id),
        result: { status: targetStatus },
      },
    },
    evidence_refs: [],
  });
  let projection = current.projection;
  for (const event of events) {
    projection = projectBusinessEventV1(projection, event, { batch_id: batchId, events });
  }
  return { ...current, projection, state: projection.work_orders[WORK_ORDER_ID] };
}

test("start is deterministic, capacity bounded, immutable, and projector-compatible", () => {
  sourceSequence = 0;
  const plan = normalizeBusinessWorkOrderPlanV1(multiPlan());
  const input = command(plan, "work_order.start", {}, 0);
  const facts = startFacts(plan);
  const inputCopy = structuredClone(input);
  const factsCopy = structuredClone(facts);

  const first = decide(null, input, facts);
  const second = decide(null, structuredClone(input), structuredClone(facts));

  assert.deepEqual(first, second);
  assert.deepEqual(input, inputCopy);
  assert.deepEqual(facts, factsCopy);
  assert.equal(first.result.status, "starting");
  assert.deepEqual(first.result.dispatched_branch_refs, ["branch:alpha", "branch:beta"]);
  assert.equal(eventTypes(first).filter((type) => type === "business.branch.attempt_opened").length, 2);
  assert.equal(new Set(first.events.map((event) => event.event_id)).size, first.events.length);
  for (const event of first.events) {
    assert.deepEqual(Object.keys(event).sort(), [
      "event_id", "evidence_refs", "payload", "schema_version", "type",
    ]);
    assert.equal(event.schema_version, 1);
    assert.equal(event.payload.prior_work_order_revision, 0);
    assert.equal(event.payload.target_work_order_revision, 1);
  }

  const projection = applyDecision(initialBusinessProjectionV1(), input, first);
  const state = projection.work_orders[WORK_ORDER_ID];
  assert.equal(state.branches["branch:alpha"].state, "dispatch_pending");
  assert.equal(state.branches["branch:beta"].state, "dispatch_pending");
  assert.equal(state.branches["branch:integration"].state, "blocked");
  assert.equal(Object.keys(projection.outbox).length, 2);
  for (const effect of Object.values(projection.outbox)) {
    assert.equal(effect.effect_contract_version, 2);
    assert.equal(effect.effect_kind, "provider.thread.create");
    assert.equal(effect.predecessor_effect_id, null);
    assert.equal(effect.predecessor_delivery_hash, null);
    assert.equal(effect.target_runtime_identity, null);
    assert.equal(effect.operation_generation, 1);
    assert.equal(effect.generation_predecessor_effect_id, null);
  }
});

test("pure decisions never append new work to a frozen V1 aggregate", () => {
  const current = start();
  const frozenV1 = structuredClone(current.state);
  delete frozenV1.engine_contract_version;
  const input = command(
    current.plan,
    "work_order.cancel.request",
    { reason: "This requires an explicit migration first." },
    frozenV1.revision,
  );

  assert.throws(
    () => decideWorkOrderV1(frozenV1, input, { occurred_at: "2026-08-09T00:00:01.000Z" }),
    (error) => error instanceof BusinessDecisionError
      && error.code === "BUSINESS_ENGINE_MIGRATION_REQUIRED",
  );
});

test("V2 creates a thread before a bound turn and rejects legacy or forged stage callbacks", () => {
  sourceSequence = 0;
  let current = start();
  current = prepareDelivery(current, "branch:solo", "sending", "2026-08-09T00:00:00.100Z");
  const createEffect = currentStartEffect(current, "branch:solo");
  const legacyAccepted = observation(current.plan, "branch.dispatch.accepted", {
    branch_ref: "branch:solo",
    attempt: 1,
    dispatch_id: createEffect.dispatch_id,
  }, current.state.revision);
  assert.throws(
    () => decide(current.state, legacyAccepted, observationFacts("2026-08-09T00:00:00.200Z", {
      runtime_identity: { operation_id: "operation:create", thread_id: "thread:one", turn_id: null },
      delivery_effect: deliveryFact(current, "branch:solo"),
    })),
    (error) => error.code === "BUSINESS_DELIVERY_EFFECT_STAGE",
  );

  const createAccepted = providerDeliveryObservation(current, createEffect, "accepted");
  current = decideAndApply(current, createAccepted, observationFacts("2026-08-09T00:00:00.200Z", {
    runtime_identity: { operation_id: "operation:create", thread_id: "thread:one", turn_id: null },
    delivery_effect: deliveryFact(current, "branch:solo"),
  }));
  assert.equal(current.state.status, "starting");
  assert.equal(current.state.branches["branch:solo"].state, "dispatch_pending");
  assert.deepEqual(eventTypes(current.decision), [
    "business.outbox.delivered",
    "business.branch.runtime_observed",
    "business.outbox.enqueued",
  ]);
  assert.equal(current.projection.outbox[createEffect.effect_id].status, "delivered");
  const turnEffect = currentStartEffect(current, "branch:solo");
  assert.equal(turnEffect.effect_kind, "provider.turn.start");
  assert.equal(turnEffect.predecessor_effect_id, createEffect.effect_id);
  assert.equal(turnEffect.predecessor_delivery_hash, current.state.branches["branch:solo"].thread_create_delivery_hash);
  assert.deepEqual(turnEffect.target_runtime_identity, {
    operation_id: "operation:create",
    thread_id: "thread:one",
    turn_id: null,
  });
  assert.equal(turnEffect.operation_generation, 1);
  assert.equal(turnEffect.generation_predecessor_effect_id, null);

  current = prepareDelivery(current, "branch:solo", "sending", "2026-08-09T00:00:00.300Z");
  const turnAccepted = providerDeliveryObservation(current, turnEffect, "accepted");
  for (const forged of [
    { predecessor_effect_id: `FX-${"f".repeat(32)}` },
    { predecessor_delivery_hash: "f".repeat(64) },
    { target_runtime_identity: { operation_id: null, thread_id: "thread:forged", turn_id: null } },
  ]) {
    assert.throws(
      () => decide(current.state, turnAccepted, observationFacts("2026-08-09T00:00:00.400Z", {
        runtime_identity: { operation_id: "operation:turn", thread_id: "thread:one", turn_id: "turn:one" },
        delivery_effect: { ...deliveryFact(current, "branch:solo"), ...forged },
      })),
      (error) => ["BUSINESS_OUTBOX_EFFECT_BINDING", "BUSINESS_DELIVERY_EFFECT_BINDING"].includes(error.code),
    );
  }
  assert.throws(
    () => decide(current.state, turnAccepted, observationFacts("2026-08-09T00:00:00.400Z", {
      runtime_identity: { operation_id: "operation:turn", thread_id: "thread:forged", turn_id: "turn:one" },
      delivery_effect: deliveryFact(current, "branch:solo"),
    })),
    (error) => error.code === "BUSINESS_RUNTIME_IDENTITY_STAGE",
  );
});

test("an accepted thread recovery advances the same attempt to its pending turn stage", () => {
  sourceSequence = 0;
  let current = start();
  current = prepareDelivery(
    current,
    "branch:solo",
    "sending",
    "2026-08-09T00:00:00.100Z",
  );
  const threadEffect = currentStartEffect(current, "branch:solo");
  const unknown = providerDeliveryObservation(current, threadEffect, "delivery_unknown");
  current = decideAndApply(current, unknown, observationFacts("2026-08-09T00:00:00.200Z", {
    delivery_effect: effectDeliveryFact(current.projection.outbox[threadEffect.effect_id]),
    attention_detail_ref: ref("detail:thread-create-unknown"),
  }));
  assert.equal(current.state.branches["branch:solo"].state, "delivery_unknown");
  assert.equal(current.state.branches["branch:solo"].delivery.classification, "delivery_unknown");

  const accepted = providerDeliveryObservation(current, threadEffect, "accepted");
  current = decideAndApply(current, accepted, observationFacts("2026-08-09T00:00:00.300Z", {
    runtime_identity: {
      operation_id: "operation:recovered-thread",
      thread_id: "thread:recovered",
      turn_id: null,
    },
    delivery_effect: effectDeliveryFact(current.projection.outbox[threadEffect.effect_id]),
    reconciliation_resolution_ref: ref("resolution:thread-create-found"),
  }));

  assert.deepEqual(eventTypes(current.decision), [
    "business.outbox.delivered",
    "business.branch.runtime_observed",
    "business.attention.resolved",
    "business.branch.status_changed",
    "business.outbox.enqueued",
  ]);
  const recoveredBranch = current.state.branches["branch:solo"];
  assert.equal(recoveredBranch.state, "dispatch_pending");
  assert.equal(recoveredBranch.last_transition_reason, "thread_create_recovered");
  assert.equal(recoveredBranch.delivery, null);
  assert.equal(recoveredBranch.thread_create_effect_id, threadEffect.effect_id);
  assert.equal(Object.values(current.state.attention).filter(
    (attention) => attention.status === "open",
  ).length, 0);
  assert.equal(current.projection.outbox[threadEffect.effect_id].status, "delivered");
  const turnEffect = currentStartEffect(current, "branch:solo");
  assert.equal(turnEffect.effect_kind, "provider.turn.start");
  assert.equal(turnEffect.attempt, threadEffect.attempt);
  assert.equal(turnEffect.dispatch_id, threadEffect.dispatch_id);
  assert.equal(turnEffect.predecessor_effect_id, threadEffect.effect_id);
  assert.deepEqual(turnEffect.target_runtime_identity, recoveredBranch.thread_identity);
});

test("generic V2 delivery settles accepted, not-sent, and unknown for every effect kind", () => {
  const setup = (effectKind) => {
    sourceSequence = 0;
    let current = start();
    if (effectKind !== "provider.thread.create") {
      current = advanceThread(current, "branch:solo", "2026-08-09T00:00:00.100Z");
    }
    if (!["provider.thread.create", "provider.turn.start"].includes(effectKind)) {
      current = acceptDispatch(current, "branch:solo", "2026-08-09T00:00:00.300Z");
    }
    if (effectKind === "provider.user_input.submit") {
      const branchState = current.state.branches["branch:solo"];
      const requested = observation(current.plan, "user_input.requested", {
        branch_ref: "branch:solo",
        request_id: `REQ-${"c".repeat(32)}`,
        prompt_ref: ref("prompt:generic-delivery"),
      }, current.state.revision);
      current = decideAndApply(current, requested, observationFacts("2026-08-09T00:00:00.400Z", {
        current_attempt: { attempt: 1, dispatch_id: branchState.dispatch_id },
      }));
      const responseRef = ref("response:generic-delivery");
      const resolved = command(current.plan, "user_input.resolve", {
        request_id: requested.payload.request_id,
        response_ref: responseRef,
      }, current.state.revision);
      current = decideAndApply(current, resolved, {
        occurred_at: "2026-08-09T00:00:00.500Z",
        resolved_response_ref: responseRef,
        dispatch_packets: packets(current.plan, "generic-input"),
      });
    } else if (effectKind === "provider.turn.cancel") {
      const cancelled = command(current.plan, "work_order.cancel.request", {
        reason: "generic cancel delivery",
      }, current.state.revision);
      current = decideAndApply(current, cancelled, {
        occurred_at: "2026-08-09T00:00:00.500Z",
        cancel_packets: packets(current.plan, "generic-cancel"),
      });
    }
    return current;
  };

  for (const effectKind of [
    "provider.thread.create",
    "provider.turn.start",
    "provider.user_input.submit",
    "provider.turn.cancel",
  ]) {
    for (const classification of ["accepted", "not_sent", "delivery_unknown"]) {
      let current = setup(effectKind);
      const effect = currentEffect(current, "branch:solo", [effectKind]);
      current = prepareDelivery(
        current,
        "branch:solo",
        classification === "not_sent" ? "claimed" : "sending",
        "2026-08-09T00:00:00.600Z",
        effectKind,
      );
      const input = providerDeliveryObservation(current, effect, classification);
      const runtimeIdentity = effectKind === "provider.thread.create"
        ? { operation_id: "operation:generic-thread", thread_id: "thread:generic", turn_id: null }
        : effectKind === "provider.turn.start"
          ? {
            operation_id: "operation:generic-turn",
            thread_id: effect.target_runtime_identity.thread_id,
            turn_id: "turn:generic",
          }
          : effect.target_runtime_identity;
      const facts = observationFacts("2026-08-09T00:00:00.700Z", {
        delivery_effect: effectDeliveryFact(current.projection.outbox[effect.effect_id]),
        ...(runtimeIdentity ? { runtime_identity: runtimeIdentity } : {}),
        ...((classification === "delivery_unknown"
          || (effectKind === "provider.turn.cancel" && classification === "not_sent"))
          ? { attention_detail_ref: ref(`detail:${effectKind}:${classification}`) }
          : {}),
      });
      if (classification === "accepted"
          && ["provider.user_input.submit", "provider.turn.cancel"].includes(effectKind)) {
        assert.throws(
          () => decide(current.state, input, {
            ...facts,
            runtime_identity: {
              operation_id: "operation:foreign-turn",
              thread_id: "thread:foreign-turn",
              turn_id: "turn:foreign-turn",
            },
          }),
          (error) => error.code === "BUSINESS_RUNTIME_IDENTITY_STAGE",
        );
      }
      current = decideAndApply(current, input, facts);
      const expectedStatus = {
        accepted: "delivered",
        not_sent: "not_sent",
        delivery_unknown: "delivery_unknown",
      }[classification];
      assert.equal(current.projection.outbox[effect.effect_id].status, expectedStatus);
      if (effectKind === "provider.user_input.submit" && classification !== "accepted") {
        assert.equal(current.state.branches["branch:solo"].state, "waiting_for_user");
      }
      if (effectKind === "provider.turn.cancel") {
        assert.equal(current.state.branches["branch:solo"].state, "cancelling");
      }
    }

    let expired = setup(effectKind);
    const expiringEffect = currentEffect(expired, "branch:solo", [effectKind]);
    expired = prepareDelivery(
      expired,
      "branch:solo",
      "sending",
      "2026-08-09T00:00:00.600Z",
      effectKind,
    );
    const projectedEffect = expired.projection.outbox[expiringEffect.effect_id];
    const expiry = sendExpiryObservation(expired, expiringEffect);
    expired = decideAndApply(expired, expiry, observationFacts(projectedEffect.lease.expires_at, {
      send_expiry: {
        effect: Object.fromEntries(OUTBOX_IMMUTABLE_FIELDS.map((field) => [
          field,
          projectedEffect[field],
        ])),
        status: "sending",
        fencing_token: {
          lease_id: projectedEffect.lease.lease_id,
          owner_id: projectedEffect.lease.owner_id,
          generation: projectedEffect.lease.generation,
        },
        lease_expires_at: projectedEffect.lease.expires_at,
        trigger_ref: expiry.payload.expiry_receipt_ref,
        quarantine_original: false,
      },
      attention_detail_ref: expiry.payload.expiry_receipt_ref,
    }));
    assert.equal(
      expired.projection.outbox[expiringEffect.effect_id].status,
      "delivery_unknown",
      effectKind,
    );
    assert.ok(Object.values(expired.state.attention).some((attention) => (
      attention.status === "open" && attention.effect_id === expiringEffect.effect_id
    )), effectKind);
  }
});

test("dispatch identity is exact; stale attempts and replaced dispatches are quarantined", () => {
  sourceSequence = 0;
  let current = start();
  current = advanceThread(current, "branch:solo", "2026-08-09T00:00:00.400Z");
  current = prepareDelivery(current, "branch:solo", "sending", "2026-08-09T00:00:00.500Z");
  const branchState = current.state.branches["branch:solo"];
  const accepted = observation(current.plan, "branch.dispatch.accepted", {
    branch_ref: "branch:solo",
    attempt: 1,
    dispatch_id: branchState.dispatch_id,
  }, current.state.revision);
  assert.throws(
    () => decideWorkOrderV1(current.state, accepted, observationFacts(
      "2026-08-09T00:00:01.000Z",
      {
        authenticated_principal: { type: "agent", id: "provider:impostor" },
        runtime_identity: { operation_id: "operation:forged" },
        delivery_effect: deliveryFact(current, "branch:solo"),
      },
    )),
    (error) => error.code === "BUSINESS_ACTOR_BINDING_MISMATCH",
  );
  assert.throws(
    () => decide(current.state, accepted, observationFacts("2026-08-09T00:00:01.000Z", {
      runtime_identity: { operation_id: "operation:forged" },
      delivery_effect: {
        ...deliveryFact(current, "branch:solo"),
        effect_kind: "provider.turn.cancel",
      },
    })),
    (error) => [
      "BUSINESS_DELIVERY_EFFECT_BINDING",
      "BUSINESS_OUTBOX_EFFECT_BINDING",
    ].includes(error.code),
  );
  current = decideAndApply(current, accepted, observationFacts("2026-08-09T00:00:01.000Z", {
    runtime_identity: {
      operation_id: "operation:one",
      thread_id: "thread:branch:solo",
      turn_id: "turn:one",
    },
    delivery_effect: deliveryFact(current, "branch:solo"),
  }));
  assert.equal(current.state.branches["branch:solo"].state, "running");

  const stale = observation(current.plan, "branch.progress", {
    branch_ref: "branch:solo",
    attempt: 2,
    message: "forged future attempt",
  }, current.state.revision);
  const staleDecision = decide(current.state, stale, observationFacts(
    "2026-08-09T00:00:02.000Z",
  ));
  assert.deepEqual(staleDecision.result, {
    status: "quarantined",
    reason: "stale_attempt",
    work_order_revision: current.state.revision + 1,
  });
  assert.deepEqual(eventTypes(staleDecision), ["business.late_observation.quarantined"]);

  const replaced = observation(current.plan, "branch.delivery_unknown", {
    branch_ref: "branch:solo",
    attempt: 1,
    dispatch_id: `DSP-${"f".repeat(32)}`,
    detail: "not the current dispatch",
  }, current.state.revision);
  assert.equal(
    decide(current.state, replaced, observationFacts("2026-08-09T00:00:03.000Z"))
      .result.reason,
    "replaced_dispatch",
  );
});

test("only proven not-sent schedules bounded retry; delivery unknown never retries", () => {
  sourceSequence = 0;
  let current = start();
  current = advanceThread(current, "branch:solo", "2026-08-09T00:00:00.400Z");
  current = prepareDelivery(current, "branch:solo", "claimed", "2026-08-09T00:00:00.500Z");
  const branchState = current.state.branches["branch:solo"];
  const notSent = observation(current.plan, "branch.dispatch.not_sent", {
    branch_ref: "branch:solo",
    attempt: 1,
    dispatch_id: branchState.dispatch_id,
    reason: "validation failed before provider boundary",
  }, current.state.revision);
  current = decideAndApply(current, notSent, observationFacts("2026-08-09T00:00:01.000Z", {
    delivery_effect: deliveryFact(current, "branch:solo"),
  }));
  assert.equal(current.state.branches["branch:solo"].state, "retryable");
  assert.equal(current.state.branches["branch:solo"].attempt, 1);
  assert.equal(current.state.branches["branch:solo"].retry_at, "2026-08-09T00:00:02.000Z");
  assert.ok(!eventTypes(current.decision).includes("business.branch.attempt_opened"));

  let unknownCurrent = start();
  unknownCurrent = advanceThread(
    unknownCurrent,
    "branch:solo",
    "2026-08-09T00:00:00.400Z",
  );
  unknownCurrent = prepareDelivery(
    unknownCurrent,
    "branch:solo",
    "sending",
    "2026-08-09T00:00:00.500Z",
  );
  const unknownBranch = unknownCurrent.state.branches["branch:solo"];
  const unknown = observation(unknownCurrent.plan, "branch.delivery_unknown", {
    branch_ref: "branch:solo",
    attempt: 1,
    dispatch_id: unknownBranch.dispatch_id,
    detail: "acknowledgement was lost after send began",
  }, unknownCurrent.state.revision);
  unknownCurrent = decideAndApply(unknownCurrent, unknown, observationFacts(
    "2026-08-09T00:00:01.000Z",
    {
      attention_detail_ref: ref("detail:delivery-unknown"),
      delivery_effect: deliveryFact(unknownCurrent, "branch:solo"),
    },
  ));
  assert.equal(unknownCurrent.state.branches["branch:solo"].state, "delivery_unknown");
  assert.equal(unknownCurrent.decision.result.automatic_retry, false);
  assert.ok(!eventTypes(unknownCurrent.decision).includes("business.branch.attempt_opened"));

  const retry = command(unknownCurrent.plan, "branch.retry.request", {
    branch_ref: "branch:solo",
    failed_attempt: 1,
    reason: "unsafe operator retry",
  }, unknownCurrent.state.revision);
  assert.throws(
    () => decide(unknownCurrent.state, retry, {
      occurred_at: "2026-08-09T00:00:02.000Z",
      dispatch_packets: packets(unknownCurrent.plan, "retry"),
    }),
    (error) => error instanceof BusinessDecisionError && error.code === "BUSINESS_RETRY_NOT_SAFE",
  );
});

test("delivery reconciliation resolves its attention and recovery observations are bounded", () => {
  sourceSequence = 0;
  let current = start();
  current = advanceThread(current, "branch:solo", "2026-08-09T00:00:00.400Z");
  current = prepareDelivery(current, "branch:solo", "sending", "2026-08-09T00:00:00.500Z");
  const dispatchId = current.state.branches["branch:solo"].dispatch_id;
  const unknown = observation(current.plan, "branch.delivery_unknown", {
    branch_ref: "branch:solo",
    attempt: 1,
    dispatch_id: dispatchId,
    detail: "delivery remained ambiguous",
  }, current.state.revision);
  current = decideAndApply(current, unknown, observationFacts("2026-08-09T00:00:01.000Z", {
    attention_detail_ref: ref("detail:unknown-1"),
    delivery_effect: deliveryFact(current, "branch:solo"),
  }));
  assert.equal(Object.keys(current.state.attention).length, 1);
  const repeated = observation(current.plan, "branch.delivery_unknown", {
    branch_ref: "branch:solo",
    attempt: 1,
    dispatch_id: dispatchId,
    detail: "a second probe requires a durable probe ledger",
  }, current.state.revision);
  const repeatedDecision = decide(current.state, repeated, observationFacts(
    "2026-08-09T00:00:02.000Z",
    { delivery_effect: deliveryFact(current, "branch:solo") },
  ));
  assert.equal(repeatedDecision.result.reason, "recovery_probe_ledger_required");
  assert.deepEqual(eventTypes(repeatedDecision), ["business.late_observation.quarantined"]);

  const accepted = observation(current.plan, "branch.dispatch.accepted", {
    branch_ref: "branch:solo",
    attempt: 1,
    dispatch_id: dispatchId,
  }, current.state.revision);
  current = decideAndApply(current, accepted, observationFacts("2026-08-09T00:00:05.000Z", {
    runtime_identity: {
      operation_id: "operation:reconciled",
      thread_id: "thread:branch:solo",
      turn_id: "turn:reconciled",
    },
    reconciliation_resolution_ref: ref("resolution:provider-found-operation"),
    delivery_effect: deliveryFact(current, "branch:solo"),
  }));
  assert.equal(current.state.branches["branch:solo"].state, "running");
  assert.equal(
    Object.values(current.state.attention).filter((attention) => attention.status === "open").length,
    0,
  );
  assert.equal(
    eventTypes(current.decision).filter((type) => type === "business.attention.resolved").length,
    1,
  );
});

test("a pre-delivery failure is quarantined and cannot leave two pending starts", () => {
  sourceSequence = 0;
  let current = start();
  const failed = observation(current.plan, "branch.failed", {
    branch_ref: "branch:solo",
    attempt: 1,
    failure_code: "provider_failed_before_acceptance",
  }, current.state.revision);
  const quarantined = decide(
    current.state,
    failed,
    observationFacts("2026-08-09T00:00:01.000Z"),
  );
  assert.equal(quarantined.result.reason, "failure_before_delivery_certainty");
  assert.deepEqual(eventTypes(quarantined), ["business.late_observation.quarantined"]);
  assert.equal(Object.values(current.projection.outbox).filter((effect) => effect.status === "pending").length, 1);

  const unsafeState = structuredClone(current.state);
  unsafeState.status = "paused";
  unsafeState.branches["branch:solo"].state = "failed";
  const unsafeRetry = command(current.plan, "branch.retry.request", {
    branch_ref: "branch:solo",
    failed_attempt: 1,
    reason: "must not retry an unsettled dispatch",
  }, unsafeState.revision);
  assert.throws(
    () => decide(unsafeState, unsafeRetry, {
      occurred_at: "2026-08-09T00:00:02.000Z",
      dispatch_packets: packets(current.plan, "unsafe-retry"),
    }),
    (error) => error.code === "BUSINESS_RETRY_NOT_SAFE",
  );

  current = acceptDispatch(current, "branch:solo", "2026-08-09T00:00:03.000Z");
  const terminalFailure = observation(current.plan, "branch.failed", {
    branch_ref: "branch:solo",
    attempt: 1,
    failure_code: "provider_run_terminal",
  }, current.state.revision);
  current = decideAndApply(
    current,
    terminalFailure,
    observationFacts("2026-08-09T00:00:04.000Z"),
  );
  const safeRetry = command(current.plan, "branch.retry.request", {
    branch_ref: "branch:solo",
    failed_attempt: 1,
    reason: "provider run is authoritatively terminal",
  }, current.state.revision);
  current = decideAndApply(current, safeRetry, {
    occurred_at: "2026-08-09T00:00:05.000Z",
    dispatch_packets: packets(current.plan, "safe-retry"),
    retry_basis: branchAttemptRetryBasis(current, "branch:solo"),
  });
  assert.equal(current.state.branches["branch:solo"].attempt, 2);
  assert.equal(Object.values(current.projection.outbox).filter((effect) => effect.status === "pending").length, 1);
});

test("manual retry shares the automatic scheduler's provider execution capacity", () => {
  sourceSequence = 0;
  const configured = multiPlan({ max_concurrency: 1 });
  const current = start(configured);

  assert.deepEqual(current.decision.result.dispatched_branch_refs, ["branch:alpha"]);
  assert.equal(current.state.branches["branch:alpha"].state, "dispatch_pending");
  assert.equal(current.state.branches["branch:beta"].state, "ready");

  const saturated = structuredClone(current.state);
  saturated.status = "running";
  saturated.branches["branch:alpha"].state = "delivery_unknown";
  saturated.branches["branch:beta"].state = "failed";
  saturated.branches["branch:beta"].attempt = 1;
  saturated.branches["branch:beta"].dispatch_id = "DSP-capacity-beta";
  saturated.branches["branch:beta"].delivery = {
    classification: "accepted",
    observed_at: "2026-08-09T00:00:01.000Z",
  };
  saturated.branches["branch:beta"].last_runtime_observation = {
    name: "branch.failed",
    payload: { attempt: 1 },
  };

  const retry = command(current.plan, "branch.retry.request", {
    branch_ref: "branch:beta",
    failed_attempt: 1,
    reason: "retry an authoritatively terminal attempt",
  }, saturated.revision);
  assert.throws(
    () => decide(saturated, retry, {
      occurred_at: "2026-08-09T00:00:02.000Z",
      retry_basis: branchAttemptRetryBasis({ state: saturated }, "branch:beta"),
    }),
    (error) => error instanceof BusinessDecisionError
      && error.code === "BUSINESS_RETRY_CAPACITY_EXHAUSTED"
      && error.details.active_slot_count === 1
      && error.details.max_concurrency === 1,
  );

  const capacityAvailable = structuredClone(saturated);
  capacityAvailable.branches["branch:alpha"].state = "failed";
  const decision = decide(capacityAvailable, retry, {
    occurred_at: "2026-08-09T00:00:02.000Z",
    dispatch_packets: packets(current.plan, "capacity-available"),
    retry_basis: branchAttemptRetryBasis(
      { state: capacityAvailable },
      "branch:beta",
    ),
  });
  assert.equal(decision.result.branch_state, "dispatch_pending");
  assert.equal(eventTypes(decision).filter((type) => type === "business.branch.attempt_opened").length, 1);
  assert.equal(eventTypes(decision).filter((type) => type === "business.outbox.enqueued").length, 1);
});

test("zero-backoff not-sent opens exactly one new attempt and respects attempt exhaustion", () => {
  sourceSequence = 0;
  const configured = rawPlan({
    retry_policy: {
      ...rawPlan().retry_policy,
      max_attempts: 2,
      backoff_initial_ms: 0,
      backoff_max_ms: 0,
    },
  });
  let current = start(configured);
  current = advanceThread(current, "branch:solo", "2026-08-09T00:00:00.400Z");
  current = prepareDelivery(current, "branch:solo", "claimed", "2026-08-09T00:00:00.500Z");
  let branchState = current.state.branches["branch:solo"];
  let input = observation(current.plan, "branch.dispatch.not_sent", {
    branch_ref: "branch:solo",
    attempt: 1,
    dispatch_id: branchState.dispatch_id,
    reason: "not sent",
  }, current.state.revision);
  current = decideAndApply(current, input, observationFacts("2026-08-09T00:00:01.000Z", {
    retry_dispatch_packets: packets(current.plan, "retry-2"),
    delivery_effect: deliveryFact(current, "branch:solo"),
  }));
  assert.equal(current.state.branches["branch:solo"].attempt, 2);
  assert.equal(current.state.branches["branch:solo"].state, "dispatch_pending");
  assert.equal(eventTypes(current.decision).filter((type) => type === "business.branch.attempt_opened").length, 1);

  branchState = current.state.branches["branch:solo"];
  current = advanceThread(current, "branch:solo", "2026-08-09T00:00:01.400Z");
  current = prepareDelivery(current, "branch:solo", "claimed", "2026-08-09T00:00:01.500Z");
  branchState = current.state.branches["branch:solo"];
  input = observation(current.plan, "branch.dispatch.not_sent", {
    branch_ref: "branch:solo",
    attempt: 2,
    dispatch_id: branchState.dispatch_id,
    reason: "still not sent",
  }, current.state.revision);
  current = decideAndApply(current, input, observationFacts("2026-08-09T00:00:02.000Z", {
    delivery_effect: deliveryFact(current, "branch:solo"),
  }));
  assert.equal(current.state.branches["branch:solo"].state, "failed");
  assert.equal(current.state.status, "paused");
  assert.ok(!eventTypes(current.decision).includes("business.branch.attempt_opened"));
});

test("explicit V2 not-sent retries the same Effect stage without a new packet or attempt", () => {
  sourceSequence = 0;
  let current = start();
  current = prepareDelivery(
    current,
    "branch:solo",
    "sending",
    "2026-08-09T00:00:00.500Z",
  );
  const first = currentStartEffect(current, "branch:solo");
  const settlement = settlementObservation(
    current.plan,
    first,
    "not_sent",
    current.state.revision,
  );
  current = decideAndApply(
    current,
    settlement,
    settlementFacts(current, first, "2026-08-09T00:00:01.000Z", "provider_rejected_no_mutation"),
  );
  assert.equal(current.state.branches["branch:solo"].state, "retryable");
  assert.equal(current.state.branches["branch:solo"].attempt, 1);
  const retry = command(current.plan, "branch.retry.request", {
    branch_ref: "branch:solo",
    failed_attempt: 1,
    reason: "Explicitly retry the same provider mutation.",
  }, current.state.revision);
  current = decideAndApply(current, retry, {
    occurred_at: "2026-08-09T00:00:01.000Z",
    retry_basis: effectGenerationRetryBasis(current, first.effect_id),
  });
  const effects = Object.values(current.projection.outbox).filter((effect) => (
    effect.effect_kind === "provider.thread.create"
  )).sort((left, right) => left.operation_generation - right.operation_generation);
  assert.equal(current.decision.result.retry_kind, "effect_generation");
  assert.equal(current.state.branches["branch:solo"].attempt, 1);
  assert.equal(effects.length, 2);
  assert.equal(effects[0].status, "not_sent");
  assert.equal(effects[1].status, "pending");
  assert.equal(effects[1].generation_predecessor_effect_id, effects[0].effect_id);
  assert.equal(effects[1].packet_ref, effects[0].packet_ref);
  assert.ok(!eventTypes(current.decision).includes("business.branch.attempt_opened"));
});

test("pre-send control-plane failures close all Effect V2 kinds without provider retry", () => {
  function claimedFixture(effectKind) {
    sourceSequence = 0;
    let current = start();
    if (effectKind === "provider.thread.create") {
      current = prepareDelivery(current, "branch:solo", "claimed", "2026-08-09T00:00:00.100Z");
      return current;
    }
    if (effectKind === "provider.turn.start") {
      current = advanceThread(current, "branch:solo", "2026-08-09T00:00:00.200Z");
      return prepareDelivery(current, "branch:solo", "claimed", "2026-08-09T00:00:00.300Z");
    }
    current = acceptDispatch(current, "branch:solo", "2026-08-09T00:00:01.000Z");
    if (effectKind === "provider.user_input.submit") {
      const request = observation(current.plan, "user_input.requested", {
        branch_ref: "branch:solo",
        request_id: id("REQ"),
        prompt_ref: ref("prompt:presend-control-plane"),
      }, current.state.revision);
      current = decideAndApply(current, request, observationFacts("2026-08-09T00:00:02.000Z", {
        current_attempt: {
          attempt: current.state.branches["branch:solo"].attempt,
          dispatch_id: current.state.branches["branch:solo"].dispatch_id,
        },
      }));
      const responseRef = ref("response:presend-control-plane");
      const resolve = command(current.plan, "user_input.resolve", {
        request_id: request.payload.request_id,
        response_ref: responseRef,
      }, current.state.revision);
      current = decideAndApply(current, resolve, {
        occurred_at: "2026-08-09T00:00:02.100Z",
        resolved_response_ref: responseRef,
        dispatch_packets: packets(current.plan, "presend-input"),
      });
      return prepareDelivery(
        current,
        "branch:solo",
        "claimed",
        "2026-08-09T00:00:02.200Z",
        effectKind,
      );
    }
    const cancel = command(current.plan, "work_order.cancel.request", {
      reason: "exercise the pre-send cancel failure path",
    }, current.state.revision);
    current = decideAndApply(current, cancel, {
      occurred_at: "2026-08-09T00:00:02.000Z",
      cancel_packets: packets(current.plan, "presend-cancel"),
    });
    return prepareDelivery(
      current,
      "branch:solo",
      "claimed",
      "2026-08-09T00:00:02.100Z",
      effectKind,
    );
  }

  const cases = [
    ["provider.thread.create", "packet_integrity_failed"],
    ["provider.turn.start", "authority_failed"],
    ["provider.user_input.submit", "driver_capability_failed"],
    ["provider.turn.cancel", "packet_integrity_failed"],
  ];
  for (const [effectKind, reason] of cases) {
    const current = claimedFixture(effectKind);
    const effect = currentEffect(current, "branch:solo", [effectKind]);
    const input = presendFailureObservation(current.plan, effect, reason, current.state.revision);
    const certainty = {
      certainty_fact_version: 2,
      effect_contract_version: 2,
      effect_kind: effect.effect_kind,
      effect_stage: {
        "provider.thread.create": "thread_create",
        "provider.turn.start": "turn_start",
        "provider.user_input.submit": "user_input_submit",
        "provider.turn.cancel": "turn_cancel",
      }[effect.effect_kind],
      settlement_source: "control_plane",
      classification: "not_sent",
      reason,
    };
    const facts = observationFacts("2026-08-09T00:00:02.300Z", {
      authenticated_principal: { type: "system", id: input.actor.actor_id },
      delivery_effect: effectDeliveryFact(effect),
      settlement_certainty_fact: certainty,
      attention_detail_ref: input.payload.failure_record_ref,
    });
    const decision = decide(current.state, input, facts);
    const types = eventTypes(decision);
    assert.equal(decision.result.branch_state, "failed", effectKind);
    assert.equal(decision.result.disposition, "operator_attention", effectKind);
    assert.equal(decision.result.automatic_retry, false, effectKind);
    assert.equal(types.filter((type) => type === "business.outbox.not_sent").length, 1, effectKind);
    assert.equal(types.filter((type) => type === "business.attention.opened").length, 1, effectKind);
    assert.equal(types.filter((type) => type === "business.branch.status_changed").length, 1, effectKind);
    assert.ok(!types.includes("business.outbox.enqueued"), effectKind);
    assert.ok(!types.includes("business.branch.attempt_opened"), effectKind);
    const settlement = decision.events.find((event) => event.type === "business.outbox.not_sent");
    assert.equal(settlement.payload.settlement_policy.disposition, "operator_attention", effectKind);
    assert.deepEqual(settlement.payload.settlement_policy.retry, { scope: "none", mode: "none" });
    const attention = decision.events.find((event) => event.type === "business.attention.opened");
    assert.equal(attention.payload.attention.effect_id, effect.effect_id, effectKind);
    assert.deepEqual(attention.payload.attention.detail_ref, input.payload.failure_record_ref);

    const forgedToken = structuredClone(input);
    forgedToken.payload.claimed_fencing_token.owner_id = "worker:forged";
    forgedToken.payload_hash = canonicalHash(forgedToken.payload);
    assert.throws(
      () => decide(current.state, forgedToken, facts),
      (error) => error.code === "BUSINESS_DELIVERY_EFFECT_BINDING",
      effectKind,
    );
    assert.throws(
      () => decide(current.state, input, {
        ...facts,
        settlement_certainty_fact: { ...certainty, disposition: "retry_candidate" },
      }),
      (error) => error.code === "BUSINESS_SETTLEMENT_POLICY_INVALID",
      effectKind,
    );
  }
});

test("a delayed V2 generation rejects early activation and never falls back to an attempt", () => {
  sourceSequence = 0;
  let current = start();
  current = prepareDelivery(
    current,
    "branch:solo",
    "sending",
    "2026-08-09T00:00:00.500Z",
  );
  const first = currentStartEffect(current, "branch:solo");
  const settlement = settlementObservation(
    current.plan,
    first,
    "not_sent",
    current.state.revision,
  );
  current = decideAndApply(
    current,
    settlement,
    settlementFacts(current, first, "2026-08-09T00:00:01.000Z", "provider_deferred_no_mutation"),
  );
  const basis = effectGenerationRetryBasis(current, first.effect_id);
  assert.equal(basis.eligible_at, "2026-08-09T00:00:02.000Z");
  const retry = command(current.plan, "branch.retry.request", {
    branch_ref: "branch:solo",
    failed_attempt: 1,
    reason: "Retry only after the shared generation backoff.",
  }, current.state.revision);
  assert.throws(
    () => decide(current.state, retry, {
      occurred_at: "2026-08-09T00:00:01.999Z",
      retry_basis: basis,
    }),
    (error) => error.code === "BUSINESS_RETRY_TOO_EARLY",
  );
  current = decideAndApply(current, retry, {
    occurred_at: basis.eligible_at,
    retry_basis: basis,
  });
  assert.equal(current.state.branches["branch:solo"].attempt, 1);
  assert.equal(current.state.branches["branch:solo"].state, "dispatch_pending");
  assert.ok(!eventTypes(current.decision).includes("business.branch.attempt_opened"));
});

test("V2 generation exhaustion fails closed without consuming a branch attempt", () => {
  sourceSequence = 0;
  const configured = rawPlan({
    retry_policy: {
      ...rawPlan().retry_policy,
      max_attempts: 1,
      backoff_initial_ms: 0,
      backoff_max_ms: 0,
    },
  });
  let current = start(configured);
  current = prepareDelivery(
    current,
    "branch:solo",
    "sending",
    "2026-08-09T00:00:00.500Z",
  );
  const first = currentStartEffect(current, "branch:solo");
  const settlement = settlementObservation(
    current.plan,
    first,
    "not_sent",
    current.state.revision,
  );
  current = decideAndApply(
    current,
    settlement,
    settlementFacts(current, first, "2026-08-09T00:00:01.000Z", "provider_deferred_no_mutation"),
  );
  assert.equal(current.state.branches["branch:solo"].state, "failed");
  assert.equal(current.state.branches["branch:solo"].attempt, 1);
  assert.equal(current.state.status, "paused");
  assert.ok(!eventTypes(current.decision).includes("business.branch.attempt_opened"));
  assert.equal(Object.values(current.projection.outbox).filter((effect) => (
    effect.effect_kind === "provider.thread.create"
  )).length, 1);
});

function advanceThread(current, branchRef, time) {
  const active = currentStartEffect(current, branchRef);
  if (active.effect_kind === "provider.turn.start") return current;
  current = prepareDelivery(
    current,
    branchRef,
    "sending",
    new Date(Date.parse(time) - 100).toISOString(),
  );
  const effect = currentStartEffect(current, branchRef);
  const input = observation(current.plan, "provider.effect.delivery.recorded", {
    effect_id: effect.effect_id,
    effect_contract_version: effect.effect_contract_version,
    effect_kind: effect.effect_kind,
    branch_ref: branchRef,
    attempt: effect.attempt,
    dispatch_id: effect.dispatch_id,
    classification: "accepted",
  }, current.state.revision);
  return decideAndApply(current, input, observationFacts(time, {
    runtime_identity: {
      operation_id: `operation:thread:${branchRef}`,
      thread_id: `thread:${branchRef}`,
      turn_id: null,
    },
    delivery_effect: deliveryFact(current, branchRef),
  }));
}

function providerDeliveryObservation(current, effect, classification) {
  return observation(current.plan, "provider.effect.delivery.recorded", {
    effect_id: effect.effect_id,
    effect_contract_version: effect.effect_contract_version,
    effect_kind: effect.effect_kind,
    branch_ref: effect.branch_ref,
    attempt: effect.attempt,
    dispatch_id: effect.dispatch_id,
    classification,
  }, current.state.revision);
}

function sendExpiryObservation(current, effect) {
  const lease = current.projection.outbox[effect.effect_id].lease;
  const expiryHash = canonicalHash({
    effect_id: effect.effect_id,
    lease_id: lease.lease_id,
    expires_at: lease.expires_at,
  });
  const payload = {
    effect_id: effect.effect_id,
    effect_contract_version: 2,
    effect_kind: effect.effect_kind,
    branch_ref: effect.branch_ref,
    attempt: effect.attempt,
    dispatch_id: effect.dispatch_id,
    expired_fencing_token: {
      lease_id: lease.lease_id,
      owner_id: lease.owner_id,
      generation: lease.generation,
    },
    lease_expires_at: lease.expires_at,
    expiry_receipt_ref: { id: `EXP-${expiryHash.slice(0, 32)}`, hash: expiryHash },
  };
  return {
    version: 2,
    observation_id: id("OBS"),
    work_order_id: WORK_ORDER_ID,
    plan_snapshot_ref: current.plan.plan_snapshot_id,
    plan_hash: current.plan.plan_hash,
    work_order_revision: current.state.revision,
    actor: { type: "runtime", actor_id: "runtime:expiry" },
    name: "provider.effect.send_expiration.recorded",
    payload,
    payload_hash: canonicalHash(payload),
  };
}

function acceptDispatch(current, branchRef, time) {
  current = advanceThread(
    current,
    branchRef,
    new Date(Date.parse(time) - 100).toISOString(),
  );
  current = prepareDelivery(
    current,
    branchRef,
    "sending",
    new Date(Date.parse(time) - 50).toISOString(),
  );
  const branchState = current.state.branches[branchRef];
  const input = observation(current.plan, "branch.dispatch.accepted", {
    branch_ref: branchRef,
    attempt: branchState.attempt,
    dispatch_id: branchState.dispatch_id,
  }, current.state.revision);
  return decideAndApply(current, input, observationFacts(time, {
    runtime_identity: {
      operation_id: `operation:${branchRef}`,
      thread_id: `thread:${branchRef}`,
      turn_id: `turn:${branchRef}`,
    },
    delivery_effect: deliveryFact(current, branchRef),
  }));
}

function submitResult(current, branchRef, time) {
  const branchState = current.state.branches[branchRef];
  const input = observation(current.plan, "branch.result.submitted", {
    branch_ref: branchRef,
    attempt: branchState.attempt,
    artifact_refs: [ref(`artifact:${branchRef}`)],
    evidence_refs: [`evidence:result-${branchRef.replace(":", "-")}`],
  }, current.state.revision);
  return decideAndApply(current, input, observationFacts(time));
}

function verify(current, branchRef, time, status = "passed", extraFacts = {}) {
  const requirement = current.plan.acceptance_policy.criteria[0].verification_requirements[0];
  const input = observation(current.plan, "verification.recorded", {
    branch_ref: branchRef,
    criterion_id: "criterion:tests",
    verification_ref: requirement.verification_ref,
    kind: requirement.kind,
    status,
    evidence_refs: [`evidence:verification-${branchRef.replace(":", "-")}`],
  }, current.state.revision);
  return decideAndApply(current, input, observationFacts(time, {
    current_result_hash: canonicalHash(current.state.branches[branchRef].result),
    dispatch_packets: packets(current.plan, `after-${branchRef}`),
    authenticated_principal: { type: "agent", id: input.actor.actor_id },
    ...extraFacts,
  }));
}

function review(current, branchRef, time, {
  status = "accepted",
  findings = { critical: 0, important: 0, minor: 0 },
  reviewerRef = "verifier:primary",
} = {}) {
  const input = observation(current.plan, "review.recorded", {
    branch_ref: branchRef,
    review_id: id("REV"),
    status,
    findings,
    evidence_refs: [`evidence:review-${reviewerRef.replaceAll(":", "-")}`],
  }, current.state.revision);
  input.actor.actor_id = reviewerRef;
  input.payload_hash = canonicalHash(input.payload);
  return decideAndApply(current, input, observationFacts(time, {
    current_result_hash: canonicalHash(current.state.branches[branchRef].result),
    authenticated_principal: { type: "agent", id: reviewerRef },
  }));
}

test("result completion is not acceptance; verification releases DAG dependencies and capacity", () => {
  sourceSequence = 0;
  let current = start(multiPlan());
  current = acceptDispatch(current, "branch:alpha", "2026-08-09T00:00:01.000Z");
  current = submitResult(current, "branch:alpha", "2026-08-09T00:00:02.000Z");
  assert.equal(current.state.branches["branch:alpha"].state, "verifying");
  assert.equal(current.state.branches["branch:integration"].state, "blocked");
  current = verify(current, "branch:alpha", "2026-08-09T00:00:03.000Z");
  assert.equal(current.state.branches["branch:alpha"].state, "accepted");
  assert.equal(current.state.branches["branch:integration"].state, "blocked");

  current = acceptDispatch(current, "branch:beta", "2026-08-09T00:00:04.000Z");
  current = submitResult(current, "branch:beta", "2026-08-09T00:00:05.000Z");
  current = verify(current, "branch:beta", "2026-08-09T00:00:06.000Z");
  assert.equal(current.state.branches["branch:integration"].state, "dispatch_pending");
  assert.equal(current.state.branches["branch:integration"].attempt, 1);
  assert.equal(
    eventTypes(current.decision).filter((type) => type === "business.branch.attempt_opened").length,
    1,
  );
});

test("a solo dispatch can run, submit, verify, and reach awaiting acceptance through the projector", () => {
  sourceSequence = 0;
  let current = start();
  current = acceptDispatch(current, "branch:solo", "2026-08-09T00:00:01.000Z");
  assert.equal(current.state.status, "running");
  assert.ok(eventTypes(current.decision).includes("business.work_order.status_changed"));
  current = submitResult(current, "branch:solo", "2026-08-09T00:00:02.000Z");
  assert.equal(current.state.branches["branch:solo"].state, "verifying");
  const resultHash = canonicalHash(current.state.branches["branch:solo"].result);
  const requirement = current.plan.acceptance_policy.criteria[0].verification_requirements[0];
  const forgedVerification = observation(current.plan, "verification.recorded", {
    branch_ref: "branch:solo",
    criterion_id: "criterion:tests",
    verification_ref: requirement.verification_ref,
    kind: requirement.kind,
    status: "passed",
    evidence_refs: ["evidence:forged-verification"],
  }, current.state.revision);
  const forgedDecision = decide(current.state, forgedVerification, observationFacts(
    "2026-08-09T00:00:02.500Z",
    { current_result_hash: "f".repeat(64) },
  ));
  assert.equal(forgedDecision.result.reason, "stale_result");
  assert.deepEqual(eventTypes(forgedDecision), ["business.late_observation.quarantined"]);
  current = verify(current, "branch:solo", "2026-08-09T00:00:03.000Z");
  assert.equal(current.state.branches["branch:solo"].state, "accepted");
  assert.equal(current.state.status, "awaiting_acceptance");
  assert.equal(
    current.decision.events.find((event) => event.type === "business.verification.recorded")
      .payload.result_hash,
    resultHash,
  );
  assert.deepEqual(eventTypes(current.decision).slice(-2), [
    "business.branch.status_changed",
    "business.work_order.status_changed",
  ]);
});

test("normal and strict plans wait for clean independent reviews of the current final result", () => {
  sourceSequence = 0;
  let normal = start(rawPlan({
    acceptance_policy: {
      ...rawPlan().acceptance_policy,
      review_minimum: "normal",
    },
  }));
  normal = acceptDispatch(normal, "branch:solo", "2026-08-09T00:00:01.000Z");
  normal = submitResult(normal, "branch:solo", "2026-08-09T00:00:02.000Z");
  normal = verify(normal, "branch:solo", "2026-08-09T00:00:03.000Z");
  assert.equal(normal.state.branches["branch:solo"].state, "verifying");
  assert.equal(normal.state.status, "running");
  normal = review(normal, "branch:solo", "2026-08-09T00:00:04.000Z", {
    reviewerRef: "verifier:normal-one",
  });
  assert.equal(normal.state.branches["branch:solo"].state, "accepted");
  assert.equal(normal.state.status, "awaiting_acceptance");
  assert.equal(
    normal.state.acceptance.reviews[normal.input.payload.review_id].result_hash,
    canonicalHash(normal.state.branches["branch:solo"].result),
  );

  let strict = start(rawPlan({
    acceptance_policy: {
      ...rawPlan().acceptance_policy,
      review_minimum: "strict",
    },
  }));
  strict = acceptDispatch(strict, "branch:solo", "2026-08-09T00:00:11.000Z");
  strict = submitResult(strict, "branch:solo", "2026-08-09T00:00:12.000Z");
  strict = verify(strict, "branch:solo", "2026-08-09T00:00:13.000Z");
  strict = review(strict, "branch:solo", "2026-08-09T00:00:14.000Z", {
    reviewerRef: "verifier:strict-one",
  });
  assert.equal(strict.state.branches["branch:solo"].state, "verifying");
  assert.equal(strict.state.status, "running");
  strict = review(strict, "branch:solo", "2026-08-09T00:00:15.000Z", {
    reviewerRef: "verifier:strict-two",
  });
  assert.equal(strict.state.branches["branch:solo"].state, "accepted");
  assert.equal(strict.state.status, "awaiting_acceptance");
});

test("review-before-verification is supported and stale-result reviews never approve a retry", () => {
  sourceSequence = 0;
  const planInput = rawPlan({
    acceptance_policy: {
      ...rawPlan().acceptance_policy,
      review_minimum: "normal",
    },
  });
  let current = start(planInput);
  current = acceptDispatch(current, "branch:solo", "2026-08-09T00:00:01.000Z");
  current = submitResult(current, "branch:solo", "2026-08-09T00:00:02.000Z");
  current = review(current, "branch:solo", "2026-08-09T00:00:03.000Z", {
    reviewerRef: "verifier:attempt-one",
  });
  const firstResultHash = canonicalHash(current.state.branches["branch:solo"].result);
  assert.equal(current.state.branches["branch:solo"].state, "verifying");
  current = verify(current, "branch:solo", "2026-08-09T00:00:04.000Z", "failed");
  assert.equal(current.state.status, "paused");

  const retry = command(current.plan, "branch.retry.request", {
    branch_ref: "branch:solo",
    failed_attempt: 1,
    reason: "verification failed",
  }, current.state.revision);
  current = decideAndApply(current, retry, {
    occurred_at: "2026-08-09T00:00:05.000Z",
    dispatch_packets: packets(current.plan, "review-retry"),
    retry_basis: branchAttemptRetryBasis(current, "branch:solo"),
  });
  current = acceptDispatch(current, "branch:solo", "2026-08-09T00:00:06.000Z");
  current = submitResult(current, "branch:solo", "2026-08-09T00:00:07.000Z");
  const secondResultHash = canonicalHash(current.state.branches["branch:solo"].result);
  assert.notEqual(secondResultHash, firstResultHash);
  current = verify(current, "branch:solo", "2026-08-09T00:00:08.000Z");
  assert.equal(current.state.branches["branch:solo"].state, "verifying");
  assert.equal(current.state.status, "running");
  current = review(current, "branch:solo", "2026-08-09T00:00:09.000Z", {
    reviewerRef: "verifier:attempt-two",
  });
  assert.equal(current.state.branches["branch:solo"].state, "accepted");
  assert.equal(current.state.status, "awaiting_acceptance");
});

test("a blocking current-result review fails the final branch and permits a safe retry", () => {
  sourceSequence = 0;
  let current = start(rawPlan({
    acceptance_policy: {
      ...rawPlan().acceptance_policy,
      review_minimum: "normal",
    },
  }));
  current = acceptDispatch(current, "branch:solo", "2026-08-09T00:00:01.000Z");
  current = submitResult(current, "branch:solo", "2026-08-09T00:00:02.000Z");
  current = verify(current, "branch:solo", "2026-08-09T00:00:03.000Z");
  current = review(current, "branch:solo", "2026-08-09T00:00:04.000Z", {
    status: "rejected",
    findings: { critical: 1, important: 0, minor: 0 },
    reviewerRef: "verifier:blocking",
  });
  assert.equal(current.state.branches["branch:solo"].state, "failed");
  assert.equal(current.state.status, "paused");
  assert.deepEqual(eventTypes(current.decision).slice(-2), [
    "business.branch.status_changed",
    "business.work_order.status_changed",
  ]);

  const retry = command(current.plan, "branch.retry.request", {
    branch_ref: "branch:solo",
    failed_attempt: 1,
    reason: "blocking review requires rework",
  }, current.state.revision);
  current = decideAndApply(current, retry, {
    occurred_at: "2026-08-09T00:00:05.000Z",
    dispatch_packets: packets(current.plan, "blocking-review-retry"),
    retry_basis: branchAttemptRetryBasis(current, "branch:solo"),
  });
  assert.equal(current.state.branches["branch:solo"].state, "dispatch_pending");
  assert.equal(current.state.branches["branch:solo"].attempt, 2);
});

test("failed verification fails the branch and pauses instead of accepting provider completion", () => {
  sourceSequence = 0;
  let current = start();
  current = acceptDispatch(current, "branch:solo", "2026-08-09T00:00:01.000Z");
  current = submitResult(current, "branch:solo", "2026-08-09T00:00:02.000Z");
  current = verify(current, "branch:solo", "2026-08-09T00:00:03.000Z", "failed");
  assert.equal(current.state.branches["branch:solo"].state, "failed");
  assert.equal(current.state.status, "paused");
  assert.ok(!eventTypes(current.decision).includes("business.acceptance.recorded"));
});

test("a rejected acceptance can be resumed, reconsidered, and accepted as a new decision cycle", () => {
  sourceSequence = 0;
  let current = start();
  current = acceptDispatch(current, "branch:solo", "2026-08-09T00:00:01.000Z");
  current = submitResult(current, "branch:solo", "2026-08-09T00:00:02.000Z");
  current = verify(current, "branch:solo", "2026-08-09T00:00:03.000Z");
  assert.equal(current.state.status, "awaiting_acceptance");

  const rejected = command(current.plan, "acceptance.decision.record", {
    decision: "rejected",
    evidence_refs: ["evidence:user-rejection"],
    comment: "Reconsider the verified result.",
  }, current.state.revision);
  current = decideAndApply(current, rejected, {
    occurred_at: "2026-08-09T00:00:04.000Z",
    authenticated_principal: { type: "user", id: rejected.actor.actor_id },
  });
  assert.equal(current.state.status, "paused");
  assert.equal(current.state.acceptance.decision.decision, "rejected");

  const resume = command(current.plan, "work_order.resume", {
    reason: "user requested another acceptance decision",
  }, current.state.revision);
  current = decideAndApply(current, resume, {
    occurred_at: "2026-08-09T00:00:05.000Z",
  });
  assert.equal(current.state.status, "awaiting_acceptance");

  const accepted = command(current.plan, "acceptance.decision.record", {
    decision: "accepted",
    evidence_refs: ["evidence:user-acceptance"],
    comment: "Accept after reconsideration.",
  }, current.state.revision);
  current = decideAndApply(current, accepted, {
    occurred_at: "2026-08-09T00:00:06.000Z",
    authenticated_principal: { type: "user", id: accepted.actor.actor_id },
  });
  assert.equal(current.state.status, "accepted");
  assert.equal(current.state.acceptance.decision.decision, "accepted");
  assert.equal(current.state.acceptance.decision_history.length, 2);
  assert.deepEqual(current.state.acceptance.decision_history.map((item) => item.decision), [
    "rejected",
    "accepted",
  ]);
});

test("acceptance rejects any blocking review even when the numeric minimum is satisfied", () => {
  sourceSequence = 0;
  const current = start();
  const state = structuredClone(current.state);
  state.status = "awaiting_acceptance";
  state.branches["branch:solo"].state = "accepted";
  state.branches["branch:solo"].result = {
    attempt: 1,
    artifact_refs: [ref("artifact:manual-acceptance")],
    evidence_refs: ["evidence:manual-acceptance"],
    submitted_at: "2026-08-09T00:00:00.500Z",
  };
  state.acceptance.reviews["review:blocking"] = {
    review_id: "review:blocking",
    branch_ref: "branch:solo",
    status: "rejected",
    findings: { critical: 1, important: 0, minor: 0 },
    evidence_refs: ["evidence:blocking-review"],
    reviewer_ref: "agent:independent-reviewer",
    result_hash: canonicalHash(state.branches["branch:solo"].result),
    recorded_at: "2026-08-09T00:00:01.000Z",
  };
  const input = command(current.plan, "acceptance.decision.record", {
    decision: "accepted",
    evidence_refs: ["evidence:user-acceptance"],
    comment: "accept",
  }, state.revision);
  assert.throws(
    () => decide(state, input, {
      occurred_at: "2026-08-09T00:00:02.000Z",
      authenticated_principal: { type: "user", id: input.actor.actor_id },
    }),
    (error) => (
      error instanceof BusinessDecisionError
        && error.code === "BUSINESS_ACCEPTANCE_GATES"
        && error.details.blocking_reviews === 1
    ),
  );

  delete state.acceptance.reviews["review:blocking"];
  assert.throws(
    () => decide(state, input, {
      occurred_at: "2026-08-09T00:00:02.000Z",
      authenticated_principal: { type: "user", id: "user:impostor" },
    }),
    (error) => error.code === "BUSINESS_ACTOR_BINDING_MISMATCH",
  );
  const accepted = decide(state, input, {
    occurred_at: "2026-08-09T00:00:02.000Z",
    authenticated_principal: { type: "user", id: input.actor.actor_id },
  });
  assert.equal(accepted.result.status, "accepted");
  assert.deepEqual(eventTypes(accepted), [
    "business.acceptance.recorded",
    "business.work_order.status_changed",
  ]);
});

test("user-input observations require explicit current-attempt binding and resolution is content-bound", () => {
  sourceSequence = 0;
  let current = start();
  current = acceptDispatch(current, "branch:solo", "2026-08-09T00:00:01.000Z");
  const branchState = current.state.branches["branch:solo"];
  const request = observation(current.plan, "user_input.requested", {
    branch_ref: "branch:solo",
    request_id: `REQ-${"a".repeat(32)}`,
    prompt_ref: ref("prompt:approval"),
  }, current.state.revision);
  const stale = decide(current.state, request, observationFacts(
    "2026-08-09T00:00:02.000Z",
    { current_attempt: { attempt: 1, dispatch_id: `DSP-${"f".repeat(32)}` } },
  ));
  assert.equal(stale.result.reason, "stale_attempt");

  current = decideAndApply(current, request, observationFacts("2026-08-09T00:00:02.000Z", {
    current_attempt: { attempt: 1, dispatch_id: branchState.dispatch_id },
  }));
  assert.equal(current.state.branches["branch:solo"].state, "waiting_for_user");
  const responseRef = ref("response:approval");
  const resolve = command(current.plan, "user_input.resolve", {
    request_id: request.payload.request_id,
    response_ref: responseRef,
  }, current.state.revision);
  assert.throws(
    () => decide(current.state, resolve, {
      occurred_at: "2026-08-09T00:00:03.000Z",
      resolved_response_ref: ref("response:forged"),
      dispatch_packets: packets(current.plan, "input"),
    }),
    (error) => error.code === "BUSINESS_CONTENT_BINDING",
  );
  current = decideAndApply(current, resolve, {
    occurred_at: "2026-08-09T00:00:03.000Z",
    resolved_response_ref: responseRef,
    dispatch_packets: packets(current.plan, "input"),
  });
  assert.equal(current.state.branches["branch:solo"].state, "waiting_for_user");
  assert.equal(current.state.branches["branch:solo"].open_user_input.request_id, request.payload.request_id);
  assert.deepEqual(
    current.state.branches["branch:solo"].pending_user_input_response_ref,
    responseRef,
  );
  const inputEffect = currentEffect(current, "branch:solo", ["provider.user_input.submit"]);
  current = prepareDelivery(
    current,
    "branch:solo",
    "sending",
    "2026-08-09T00:00:03.100Z",
    "provider.user_input.submit",
  );
  const delivered = observation(current.plan, "provider.effect.delivery.recorded", {
    effect_id: inputEffect.effect_id,
    effect_contract_version: inputEffect.effect_contract_version,
    effect_kind: inputEffect.effect_kind,
    branch_ref: inputEffect.branch_ref,
    attempt: inputEffect.attempt,
    dispatch_id: inputEffect.dispatch_id,
    classification: "accepted",
  }, current.state.revision);
  current = decideAndApply(current, delivered, observationFacts("2026-08-09T00:00:03.200Z", {
    runtime_identity: inputEffect.target_runtime_identity,
    delivery_effect: effectDeliveryFact(
      current.projection.outbox[inputEffect.effect_id],
    ),
  }));
  assert.equal(current.state.branches["branch:solo"].state, "running");
  assert.equal(current.state.branches["branch:solo"].open_user_input, null);
  assert.equal(current.state.branches["branch:solo"].pending_user_input_response_ref, null);
  const resolutionEvent = current.decision.events.find((event) => (
    event.type === "business.branch.status_changed"
      && event.payload.resolved_request_id === request.payload.request_id
  ));
  assert.deepEqual(resolutionEvent.payload.response_ref, responseRef);
});

test("cancel clears an open prompt after its response was proven not sent", () => {
  sourceSequence = 0;
  let current = start();
  current = acceptDispatch(current, "branch:solo", "2026-08-09T00:00:01.000Z");
  const request = observation(current.plan, "user_input.requested", {
    branch_ref: "branch:solo",
    request_id: id("REQ"),
    prompt_ref: ref("prompt:cancel-after-not-sent"),
  }, current.state.revision);
  current = decideAndApply(current, request, observationFacts("2026-08-09T00:00:02.000Z", {
    current_attempt: { attempt: 1, dispatch_id: current.state.branches["branch:solo"].dispatch_id },
  }));
  const responseRef = ref("response:cancel-after-not-sent");
  const resolve = command(current.plan, "user_input.resolve", {
    request_id: request.payload.request_id,
    response_ref: responseRef,
  }, current.state.revision);
  current = decideAndApply(current, resolve, {
    occurred_at: "2026-08-09T00:00:02.100Z",
    resolved_response_ref: responseRef,
    dispatch_packets: packets(current.plan, "input-before-cancel"),
  });
  const inputEffect = currentEffect(current, "branch:solo", ["provider.user_input.submit"]);
  current = prepareDelivery(
    current,
    "branch:solo",
    "claimed",
    "2026-08-09T00:00:02.200Z",
    "provider.user_input.submit",
  );
  const notSent = providerDeliveryObservation(current, inputEffect, "not_sent");
  current = decideAndApply(current, notSent, observationFacts("2026-08-09T00:00:02.300Z", {
    delivery_effect: effectDeliveryFact(current.projection.outbox[inputEffect.effect_id]),
  }));
  assert.ok(current.state.branches["branch:solo"].open_user_input);
  assert.equal(current.state.branches["branch:solo"].pending_user_input_effect_id, null);

  const cancel = command(current.plan, "work_order.cancel.request", {
    reason: "stop instead of resubmitting the response",
  }, current.state.revision);
  current = decideAndApply(current, cancel, {
    occurred_at: "2026-08-09T00:00:02.400Z",
    cancel_packets: packets(current.plan, "cancel-after-input-not-sent"),
  });
  assert.equal(current.state.branches["branch:solo"].state, "cancelling");
  assert.equal(current.state.branches["branch:solo"].open_user_input, null);
  assert.ok(current.state.branches["branch:solo"].cancel_effect_id);
});

test("the same user response may be resubmitted only after not-sent proof", () => {
  sourceSequence = 0;
  let current = start();
  current = acceptDispatch(current, "branch:solo", "2026-08-09T00:00:01.000Z");
  const request = observation(current.plan, "user_input.requested", {
    branch_ref: "branch:solo",
    request_id: id("REQ"),
    prompt_ref: ref("prompt:retry-response"),
  }, current.state.revision);
  current = decideAndApply(current, request, observationFacts("2026-08-09T00:00:02.000Z", {
    current_attempt: { attempt: 1, dispatch_id: current.state.branches["branch:solo"].dispatch_id },
  }));
  const responseRef = ref("response:retry-response");
  const resolveOnce = command(current.plan, "user_input.resolve", {
    request_id: request.payload.request_id,
    response_ref: responseRef,
  }, current.state.revision);
  current = decideAndApply(current, resolveOnce, {
    occurred_at: "2026-08-09T00:00:02.100Z",
    resolved_response_ref: responseRef,
    dispatch_packets: packets(current.plan, "response-first"),
  });
  const first = currentEffect(current, "branch:solo", ["provider.user_input.submit"]);
  current = prepareDelivery(
    current,
    "branch:solo",
    "claimed",
    "2026-08-09T00:00:02.100Z",
    "provider.user_input.submit",
  );
  const notSent = providerDeliveryObservation(current, first, "not_sent");
  current = decideAndApply(current, notSent, observationFacts("2026-08-09T00:00:02.100Z", {
    delivery_effect: effectDeliveryFact(current.projection.outbox[first.effect_id]),
  }));

  const differentResponseRef = ref("response:retry-response-replaced");
  const resolveDifferent = command(current.plan, "user_input.resolve", {
    request_id: request.payload.request_id,
    response_ref: differentResponseRef,
  }, current.state.revision);
  const differentGoal = decideAndApply(current, resolveDifferent, {
    occurred_at: "2026-08-09T00:00:02.100Z",
    resolved_response_ref: differentResponseRef,
    dispatch_packets: packets(current.plan, "response-replaced"),
  });
  const differentEffect = currentEffect(
    differentGoal,
    "branch:solo",
    ["provider.user_input.submit"],
  );
  assert.notEqual(differentEffect.operation_scope_hash, first.operation_scope_hash);
  assert.equal(differentEffect.operation_generation, 1);
  assert.equal(differentEffect.generation_predecessor_effect_id, null);

  const resolveAgain = command(current.plan, "user_input.resolve", {
    request_id: request.payload.request_id,
    response_ref: responseRef,
  }, current.state.revision);
  const exactPredecessor = cancellationFactForEffect(
    current.projection.outbox[first.effect_id],
  );
  for (const forgedPredecessor of [
    { ...exactPredecessor, status: "delivery_unknown" },
    { ...exactPredecessor, operation_scope_hash: "f".repeat(64) },
    { ...exactPredecessor, operation_generation: exactPredecessor.operation_generation + 1 },
  ]) {
    assert.throws(
      () => decide(current.state, resolveAgain, {
        occurred_at: "2026-08-09T00:00:02.100Z",
        resolved_response_ref: responseRef,
        dispatch_packets: packets(current.plan, "response-forged-predecessor"),
        generation_predecessors: { "branch:solo": forgedPredecessor },
      }),
      (error) => error.code === "BUSINESS_OUTBOX_EFFECT_GENERATION_BINDING",
    );
  }
  const selfConsistentOrphan = {
    ...exactPredecessor,
    packet_ref: "packet:self-consistent-orphan",
    packet_hash: canonicalHash({ packet: "self-consistent-orphan" }),
  };
  const selfConsistentSeed = Object.fromEntries(OUTBOX_IMMUTABLE_FIELDS
    .filter((field) => !["effect_id", "idempotency_key", "created_at"].includes(field))
    .map((field) => [field, selfConsistentOrphan[field]]));
  selfConsistentOrphan.effect_id = `FX-${canonicalHash(selfConsistentSeed).slice(0, 32)}`;
  selfConsistentOrphan.idempotency_key = `IDEM-${canonicalHash(selfConsistentSeed).slice(0, 32)}`;
  assert.throws(
    () => decideAndApply(current, resolveAgain, {
      occurred_at: "2026-08-09T00:00:02.100Z",
      resolved_response_ref: responseRef,
      dispatch_packets: packets(current.plan, "response-self-consistent-orphan"),
      generation_predecessors: { "branch:solo": selfConsistentOrphan },
    }),
    (error) => error.code === "BUSINESS_PROJECTION_OUTBOX_BINDING",
  );
  current = decideAndApply(current, resolveAgain, {
    occurred_at: "2026-08-09T00:00:02.100Z",
    resolved_response_ref: responseRef,
    dispatch_packets: packets(current.plan, "response-second"),
    generation_predecessors: {
      "branch:solo": exactPredecessor,
    },
  });
  const successor = currentEffect(current, "branch:solo", ["provider.user_input.submit"]);
  assert.notEqual(successor.effect_id, first.effect_id);
  assert.equal(successor.created_at, first.created_at);
  assert.equal(successor.operation_scope_hash, first.operation_scope_hash);
  assert.equal(successor.operation_generation, first.operation_generation + 1);
  assert.equal(successor.generation_predecessor_effect_id, first.effect_id);
  assert.equal(current.projection.outbox[first.effect_id].status, "not_sent");
  assert.equal(current.state.branches["branch:solo"].pending_user_input_effect_id, successor.effect_id);
});

test("sequential user-input operations start distinct lineage goals", () => {
  sourceSequence = 0;
  let current = start();
  current = acceptDispatch(current, "branch:solo", "2026-08-09T00:00:01.000Z");

  const requestOne = observation(current.plan, "user_input.requested", {
    branch_ref: "branch:solo",
    request_id: id("REQ"),
    prompt_ref: ref("prompt:lineage-one"),
  }, current.state.revision);
  current = decideAndApply(current, requestOne, observationFacts("2026-08-09T00:00:02.000Z", {
    current_attempt: {
      attempt: 1,
      dispatch_id: current.state.branches["branch:solo"].dispatch_id,
    },
  }));
  const responseOne = ref("response:lineage-one");
  current = decideAndApply(current, command(current.plan, "user_input.resolve", {
    request_id: requestOne.payload.request_id,
    response_ref: responseOne,
  }, current.state.revision), {
    occurred_at: "2026-08-09T00:00:02.100Z",
    resolved_response_ref: responseOne,
    dispatch_packets: packets(current.plan, "lineage-one"),
  });
  const first = currentEffect(current, "branch:solo", ["provider.user_input.submit"]);
  current = prepareDelivery(
    current,
    "branch:solo",
    "sending",
    "2026-08-09T00:00:02.200Z",
    "provider.user_input.submit",
  );
  current = decideAndApply(
    current,
    providerDeliveryObservation(current, first, "accepted"),
    observationFacts("2026-08-09T00:00:02.300Z", {
      runtime_identity: first.target_runtime_identity,
      delivery_effect: effectDeliveryFact(current.projection.outbox[first.effect_id]),
    }),
  );

  const requestTwo = observation(current.plan, "user_input.requested", {
    branch_ref: "branch:solo",
    request_id: id("REQ"),
    prompt_ref: ref("prompt:lineage-two"),
  }, current.state.revision);
  current = decideAndApply(current, requestTwo, observationFacts("2026-08-09T00:00:02.400Z", {
    current_attempt: {
      attempt: 1,
      dispatch_id: current.state.branches["branch:solo"].dispatch_id,
    },
  }));
  const responseTwo = ref("response:lineage-two");
  current = decideAndApply(current, command(current.plan, "user_input.resolve", {
    request_id: requestTwo.payload.request_id,
    response_ref: responseTwo,
  }, current.state.revision), {
    occurred_at: "2026-08-09T00:00:02.500Z",
    resolved_response_ref: responseTwo,
    dispatch_packets: packets(current.plan, "lineage-two"),
  });
  const second = currentEffect(current, "branch:solo", ["provider.user_input.submit"]);
  assert.notEqual(second.operation_scope_hash, first.operation_scope_hash);
  assert.equal(second.operation_generation, 1);
  assert.equal(second.generation_predecessor_effect_id, null);
});

test("an ambiguous user-input operation cannot be bypassed with a different response scope", () => {
  sourceSequence = 0;
  let current = start();
  current = acceptDispatch(current, "branch:solo", "2026-08-09T00:00:01.000Z");
  const request = observation(current.plan, "user_input.requested", {
    branch_ref: "branch:solo",
    request_id: id("REQ"),
    prompt_ref: ref("prompt:unknown-lineage"),
  }, current.state.revision);
  current = decideAndApply(current, request, observationFacts("2026-08-09T00:00:02.000Z", {
    current_attempt: {
      attempt: 1,
      dispatch_id: current.state.branches["branch:solo"].dispatch_id,
    },
  }));
  const response = ref("response:unknown-lineage");
  current = decideAndApply(current, command(current.plan, "user_input.resolve", {
    request_id: request.payload.request_id,
    response_ref: response,
  }, current.state.revision), {
    occurred_at: "2026-08-09T00:00:02.100Z",
    resolved_response_ref: response,
    dispatch_packets: packets(current.plan, "unknown-lineage"),
  });
  const effect = currentEffect(current, "branch:solo", ["provider.user_input.submit"]);
  current = prepareDelivery(
    current,
    "branch:solo",
    "sending",
    "2026-08-09T00:00:02.200Z",
    "provider.user_input.submit",
  );
  current = decideAndApply(
    current,
    providerDeliveryObservation(current, effect, "delivery_unknown"),
    observationFacts("2026-08-09T00:00:02.300Z", {
      delivery_effect: effectDeliveryFact(current.projection.outbox[effect.effect_id]),
      attention_detail_ref: ref("attention:unknown-lineage"),
    }),
  );
  const replacement = ref("response:unknown-lineage-replacement");
  assert.throws(
    () => decide(current.state, command(current.plan, "user_input.resolve", {
      request_id: request.payload.request_id,
      response_ref: replacement,
    }, current.state.revision), {
      occurred_at: "2026-08-09T00:00:02.400Z",
      resolved_response_ref: replacement,
      dispatch_packets: packets(current.plan, "unknown-lineage-replacement"),
    }),
    (error) => error.code === "BUSINESS_USER_INPUT_DELIVERY_PENDING",
  );
});

test("cancel acknowledgement cannot resolve another effect's delivery ambiguity", () => {
  sourceSequence = 0;
  let current = start();
  current = acceptDispatch(current, "branch:solo", "2026-08-09T00:00:01.000Z");
  const request = observation(current.plan, "user_input.requested", {
    branch_ref: "branch:solo",
    request_id: id("REQ"),
    prompt_ref: ref("prompt:ambiguous-input-before-cancel"),
  }, current.state.revision);
  current = decideAndApply(current, request, observationFacts("2026-08-09T00:00:02.000Z", {
    current_attempt: { attempt: 1, dispatch_id: current.state.branches["branch:solo"].dispatch_id },
  }));
  const responseRef = ref("response:ambiguous-input-before-cancel");
  const resolve = command(current.plan, "user_input.resolve", {
    request_id: request.payload.request_id,
    response_ref: responseRef,
  }, current.state.revision);
  current = decideAndApply(current, resolve, {
    occurred_at: "2026-08-09T00:00:02.100Z",
    resolved_response_ref: responseRef,
    dispatch_packets: packets(current.plan, "ambiguous-input-before-cancel"),
  });
  const inputEffect = currentEffect(current, "branch:solo", ["provider.user_input.submit"]);
  current = prepareDelivery(
    current,
    "branch:solo",
    "sending",
    "2026-08-09T00:00:02.200Z",
    "provider.user_input.submit",
  );
  const inputUnknown = providerDeliveryObservation(current, inputEffect, "delivery_unknown");
  current = decideAndApply(current, inputUnknown, observationFacts("2026-08-09T00:00:02.300Z", {
    delivery_effect: effectDeliveryFact(current.projection.outbox[inputEffect.effect_id]),
    attention_detail_ref: ref("attention:ambiguous-input-before-cancel"),
  }));
  const inputAttention = Object.values(current.state.attention).find((attention) => (
    attention.kind === "delivery_unknown" && attention.effect_id === inputEffect.effect_id
  ));
  assert.equal(inputAttention.status, "open");

  const cancel = command(current.plan, "work_order.cancel.request", {
    reason: "cancel while input delivery remains ambiguous",
  }, current.state.revision);
  current = decideAndApply(current, cancel, {
    occurred_at: "2026-08-09T00:00:02.400Z",
    cancellation: {
      "branch:solo": cancellationFactForEffect(current.projection.outbox[inputEffect.effect_id]),
    },
    cancel_packets: packets(current.plan, "cancel-after-ambiguous-input"),
  });
  const cancelEffect = currentEffect(current, "branch:solo", ["provider.turn.cancel"]);
  current = prepareDelivery(
    current,
    "branch:solo",
    "sending",
    "2026-08-09T00:00:02.500Z",
    "provider.turn.cancel",
  );
  const cancelAccepted = providerDeliveryObservation(current, cancelEffect, "accepted");
  current = decideAndApply(current, cancelAccepted, observationFacts("2026-08-09T00:00:02.600Z", {
    runtime_identity: current.state.branches["branch:solo"].runtime_identity,
    delivery_effect: effectDeliveryFact(current.projection.outbox[cancelEffect.effect_id]),
  }));
  assert.equal(current.projection.outbox[cancelEffect.effect_id].status, "delivered");
  assert.equal(current.projection.outbox[inputEffect.effect_id].status, "delivery_unknown");
  assert.equal(current.state.attention[inputAttention.attention_id].status, "open");
});

test("an attempt cannot time out before its immutable deadline", () => {
  sourceSequence = 0;
  const current = start();
  const timeout = observation(current.plan, "branch.timed_out", {
    branch_ref: "branch:solo",
    attempt: 1,
    timeout_ms: 60_000,
  }, current.state.revision);
  const early = decideAndApply(current, timeout, observationFacts(
    "2026-08-09T00:00:59.999Z",
  ));
  assert.equal(early.decision.result.status, "quarantined");
  assert.equal(early.decision.result.reason, "attempt_deadline_not_reached");
  assert.equal(early.state.branches["branch:solo"].state, "dispatch_pending");
  assert.equal(currentStartEffect(early, "branch:solo").status, "pending");
});

test("timeout atomically cancels unsent starts and quarantines a sending start", () => {
  for (const status of ["pending", "claimed"]) {
    sourceSequence = 0;
    let current = start();
    if (status === "claimed") {
      current = prepareDelivery(current, "branch:solo", "claimed", "2026-08-09T00:00:00.100Z");
    }
    const effect = currentStartEffect(current, "branch:solo");
    const timeout = observation(current.plan, "branch.timed_out", {
      branch_ref: "branch:solo",
      attempt: 1,
      timeout_ms: 60_000,
    }, current.state.revision);
    current = decideAndApply(current, timeout, observationFacts("2026-08-09T00:01:00.000Z", {
      timeout_effect: cancellationFact(current, "branch:solo"),
    }));
    assert.equal(current.projection.outbox[effect.effect_id].status, "cancelled");
    assert.equal(current.state.branches["branch:solo"].state, "cancelled");
    assert.ok(eventTypes(current.decision).includes("business.outbox.cancelled"));
  }

  sourceSequence = 0;
  let sending = start();
  sending = prepareDelivery(sending, "branch:solo", "sending", "2026-08-09T00:00:59.900Z");
  const effect = currentStartEffect(sending, "branch:solo");
  const timeout = observation(sending.plan, "branch.timed_out", {
    branch_ref: "branch:solo",
    attempt: 1,
    timeout_ms: 60_000,
  }, sending.state.revision);
  sending = decideAndApply(sending, timeout, observationFacts("2026-08-09T00:01:00.000Z", {
    timeout_effect: cancellationFact(sending, "branch:solo"),
    attention_detail_ref: ref("detail:timeout-sending"),
  }));
  assert.equal(sending.projection.outbox[effect.effect_id].status, "sending");
  assert.equal(sending.state.branches["branch:solo"].state, "delivery_unknown");
  assert.equal(Object.values(sending.state.attention).filter((item) => item.status === "open").length, 1);
  const lateThreadAccepted = providerDeliveryObservation(sending, effect, "accepted");
  sending = decideAndApply(sending, lateThreadAccepted, observationFacts("2026-08-09T00:01:00.100Z", {
    runtime_identity: { operation_id: "operation:late-thread", thread_id: "thread:late", turn_id: null },
    delivery_effect: effectDeliveryFact(sending.projection.outbox[effect.effect_id]),
    reconciliation_resolution_ref: ref("resolution:late-thread"),
  }));
  assert.equal(sending.projection.outbox[effect.effect_id].status, "delivered");
  assert.equal(sending.state.branches["branch:solo"].state, "failed");
  assert.equal(
    Object.values(sending.projection.outbox).filter((item) => item.effect_kind === "provider.turn.start").length,
    0,
  );

  sourceSequence = 0;
  let lateTurn = start();
  lateTurn = advanceThread(lateTurn, "branch:solo", "2026-08-09T00:00:00.200Z");
  lateTurn = prepareDelivery(lateTurn, "branch:solo", "sending", "2026-08-09T00:00:59.900Z");
  const turnEffect = currentStartEffect(lateTurn, "branch:solo");
  const turnTimeout = observation(lateTurn.plan, "branch.timed_out", {
    branch_ref: "branch:solo",
    attempt: 1,
    timeout_ms: 60_000,
  }, lateTurn.state.revision);
  lateTurn = decideAndApply(lateTurn, turnTimeout, observationFacts("2026-08-09T00:01:00.000Z", {
    timeout_effect: cancellationFact(lateTurn, "branch:solo"),
    attention_detail_ref: ref("detail:timeout-turn-sending"),
  }));
  const lateTurnAccepted = providerDeliveryObservation(lateTurn, turnEffect, "accepted");
  lateTurn = decideAndApply(lateTurn, lateTurnAccepted, observationFacts("2026-08-09T00:01:00.100Z", {
    runtime_identity: {
      operation_id: "operation:late-turn",
      thread_id: "thread:branch:solo",
      turn_id: "turn:late",
    },
    delivery_effect: effectDeliveryFact(lateTurn.projection.outbox[turnEffect.effect_id]),
    reconciliation_resolution_ref: ref("resolution:late-turn"),
    cancel_packets: packets(lateTurn.plan, "cancel-late-turn"),
  }));
  assert.equal(lateTurn.state.branches["branch:solo"].state, "cancelling");
  assert.ok(Object.values(lateTurn.projection.outbox).some(
    (item) => item.effect_kind === "provider.turn.cancel" && item.status === "pending",
  ));
  const lateCancel = currentEffect(lateTurn, "branch:solo", ["provider.turn.cancel"]);
  lateTurn = prepareDelivery(
    lateTurn,
    "branch:solo",
    "sending",
    "2026-08-09T00:01:00.200Z",
    "provider.turn.cancel",
  );
  const lateCancelAccepted = providerDeliveryObservation(lateTurn, lateCancel, "accepted");
  lateTurn = decideAndApply(lateTurn, lateCancelAccepted, observationFacts("2026-08-09T00:01:00.300Z", {
    runtime_identity: lateTurn.state.branches["branch:solo"].runtime_identity,
    delivery_effect: effectDeliveryFact(lateTurn.projection.outbox[lateCancel.effect_id]),
  }));
  const lateBranchCancelled = observation(lateTurn.plan, "branch.cancelled", {
    branch_ref: "branch:solo",
    attempt: 1,
    reason: "late-started turn was stopped",
  }, lateTurn.state.revision);
  lateTurn = decideAndApply(lateTurn, lateBranchCancelled, observationFacts(
    "2026-08-09T00:01:00.400Z",
  ));
  assert.equal(lateTurn.state.branches["branch:solo"].state, "cancelled");
  assert.equal(lateTurn.state.status, "paused");

  sourceSequence = 0;
  let waiting = start();
  waiting = acceptDispatch(waiting, "branch:solo", "2026-08-09T00:00:01.000Z");
  const request = observation(waiting.plan, "user_input.requested", {
    branch_ref: "branch:solo",
    request_id: id("REQ"),
    prompt_ref: ref("prompt:unanswered-timeout"),
  }, waiting.state.revision);
  waiting = decideAndApply(waiting, request, observationFacts("2026-08-09T00:00:02.000Z", {
    current_attempt: {
      attempt: waiting.state.branches["branch:solo"].attempt,
      dispatch_id: waiting.state.branches["branch:solo"].dispatch_id,
    },
  }));
  assert.equal(waiting.state.branches["branch:solo"].pending_user_input_effect_id, null);
  const waitingDeadline = waiting.state.branches["branch:solo"].attempt_deadline_at;
  const waitingTimeout = observation(waiting.plan, "branch.timed_out", {
    branch_ref: "branch:solo",
    attempt: 1,
    timeout_ms: waiting.plan.retry_policy.attempt_timeout_ms,
  }, waiting.state.revision);
  waiting = decideAndApply(waiting, waitingTimeout, observationFacts(waitingDeadline, {
    cancel_packets: packets(waiting.plan, "cancel-unanswered-timeout"),
  }));
  assert.equal(waiting.state.branches["branch:solo"].state, "cancelling");
  assert.equal(waiting.state.branches["branch:solo"].open_user_input, null);
  assert.ok(waiting.state.branches["branch:solo"].cancel_effect_id);
});

test("provider work and user input cannot advance after an execution deadline", () => {
  sourceSequence = 0;
  let current = start();
  current = acceptDispatch(current, "branch:solo", "2026-08-09T00:00:01.000Z");
  const branchState = current.state.branches["branch:solo"];
  const afterDeadline = "2026-08-09T00:01:00.001Z";

  const result = observation(current.plan, "branch.result.submitted", {
    branch_ref: "branch:solo",
    attempt: branchState.attempt,
    artifact_refs: [ref("artifact:late-result")],
    evidence_refs: ["evidence:late-result"],
  }, current.state.revision);
  const lateResult = decide(current.state, result, observationFacts(afterDeadline));
  assert.equal(lateResult.result.reason, "execution_deadline_elapsed");
  assert.deepEqual(
    lateResult.events[0].payload.record.artifact_refs,
    result.payload.artifact_refs,
  );

  const progress = observation(current.plan, "branch.progress", {
    branch_ref: "branch:solo",
    attempt: branchState.attempt,
    message: "late progress",
  }, current.state.revision);
  assert.equal(
    decide(current.state, progress, observationFacts(afterDeadline)).result.reason,
    "execution_deadline_elapsed",
  );

  const lateRequest = observation(current.plan, "user_input.requested", {
    branch_ref: "branch:solo",
    request_id: `REQ-${"d".repeat(32)}`,
    prompt_ref: ref("prompt:late-request"),
  }, current.state.revision);
  assert.equal(
    decide(current.state, lateRequest, observationFacts(afterDeadline, {
      current_attempt: {
        attempt: branchState.attempt,
        dispatch_id: branchState.dispatch_id,
      },
    })).result.reason,
    "execution_deadline_elapsed",
  );

  const timelyRequest = observation(current.plan, "user_input.requested", {
    branch_ref: "branch:solo",
    request_id: `REQ-${"e".repeat(32)}`,
    prompt_ref: ref("prompt:timely-request"),
  }, current.state.revision);
  current = decideAndApply(current, timelyRequest, observationFacts(
    "2026-08-09T00:00:02.000Z",
    {
      current_attempt: {
        attempt: branchState.attempt,
        dispatch_id: branchState.dispatch_id,
      },
    },
  ));
  const responseRef = ref("response:after-deadline");
  const resolve = command(current.plan, "user_input.resolve", {
    request_id: timelyRequest.payload.request_id,
    response_ref: responseRef,
  }, current.state.revision);
  assert.throws(
    () => decide(current.state, resolve, {
      occurred_at: afterDeadline,
      resolved_response_ref: responseRef,
      dispatch_packets: packets(current.plan, "late-input"),
    }),
    (error) => error.code === "BUSINESS_EXECUTION_DEADLINE_ELAPSED",
  );
  assert.equal(current.state.branches["branch:solo"].state, "waiting_for_user");
  assert.equal(
    Object.values(current.projection.outbox).filter(
      (effect) => effect.effect_kind === "provider.user_input.submit",
    ).length,
    0,
  );
});

test("cancel binds the exact current Work Order branch attempt and outbox identity", () => {
  sourceSequence = 0;
  const current = start();
  const cancel = command(current.plan, "work_order.cancel.request", {
    reason: "cancel before provider send",
  }, current.state.revision);
  const exact = cancellationFact(current, "branch:solo");
  for (const forged of [
    { ...exact, work_order_id: `WO-${"f".repeat(32)}` },
    { ...exact, branch_ref: "branch:other" },
    { ...exact, attempt: 2 },
    { ...exact, dispatch_id: `DSP-${"f".repeat(32)}` },
    { ...exact, provider_ref: "provider:forged" },
    { ...exact, effect_kind: "provider.turn.cancel" },
    { ...exact, status: "forged" },
  ]) {
    assert.throws(
      () => decide(current.state, cancel, {
        occurred_at: "2026-08-09T00:00:01.000Z",
        cancellation: { "branch:solo": forged },
      }),
      (error) => [
        "BUSINESS_OUTBOX_EFFECT_BINDING",
        "BUSINESS_CANCELLATION_EFFECT_BINDING",
      ].includes(error.code),
    );
  }
  const incomplete = { ...exact };
  delete incomplete.packet_hash;
  assert.throws(
    () => decide(current.state, cancel, {
      occurred_at: "2026-08-09T00:00:01.000Z",
      cancellation: { "branch:solo": incomplete },
    }),
    (error) => error.code === "BUSINESS_CANCELLATION_EFFECT_BINDING",
  );

  const decision = decide(current.state, cancel, {
    occurred_at: "2026-08-09T00:00:01.000Z",
    cancellation: { "branch:solo": exact },
  });
  const cancelled = decision.events.find((event) => event.type === "business.outbox.cancelled");
  assert.deepEqual(cancelled.payload.effect, Object.fromEntries(
    Object.entries(exact).filter(([key]) => key !== "status"),
  ));
  const applied = applyDecision(current.projection, cancel, decision);
  assert.equal(applied.outbox[exact.effect_id].status, "cancelled");
  assert.equal(applied.work_orders[WORK_ORDER_ID].branches["branch:solo"].state, "cancelled");
});

test("cancel winning before thread or turn acceptance never restarts the branch", () => {
  sourceSequence = 0;
  let threadCurrent = start();
  threadCurrent = prepareDelivery(
    threadCurrent,
    "branch:solo",
    "sending",
    "2026-08-09T00:00:00.100Z",
  );
  const createEffect = currentStartEffect(threadCurrent, "branch:solo");
  const cancelThread = command(threadCurrent.plan, "work_order.cancel.request", {
    reason: "cancel while thread creation acknowledgement is pending",
  }, threadCurrent.state.revision);
  threadCurrent = decideAndApply(threadCurrent, cancelThread, {
    occurred_at: "2026-08-09T00:00:00.200Z",
    cancellation: { "branch:solo": cancellationFact(threadCurrent, "branch:solo") },
    cancellation_evidence_refs: ["evidence:cancel-thread-create"],
    attention_detail_ref: ref("attention:cancel-thread-create"),
  });
  assert.equal(threadCurrent.state.branches["branch:solo"].state, "delivery_unknown");
  const acceptedThread = providerDeliveryObservation(threadCurrent, createEffect, "accepted");
  threadCurrent = decideAndApply(
    threadCurrent,
    acceptedThread,
    observationFacts("2026-08-09T00:00:00.300Z", {
      runtime_identity: { operation_id: "operation:cancelled-thread", thread_id: "thread:cancelled", turn_id: null },
      delivery_effect: effectDeliveryFact(threadCurrent.projection.outbox[createEffect.effect_id]),
      reconciliation_resolution_ref: ref("resolution:cancelled-thread-create"),
    }),
  );
  assert.equal(threadCurrent.state.status, "cancelling");
  assert.equal(threadCurrent.state.branches["branch:solo"].state, "cancelled");
  assert.ok(!Object.values(threadCurrent.projection.outbox).some(
    (item) => item.effect_kind === "provider.turn.start",
  ));

  sourceSequence = 0;
  let turnCurrent = start();
  turnCurrent = advanceThread(turnCurrent, "branch:solo", "2026-08-09T00:00:00.200Z");
  turnCurrent = prepareDelivery(
    turnCurrent,
    "branch:solo",
    "sending",
    "2026-08-09T00:00:00.300Z",
  );
  const turnEffect = currentStartEffect(turnCurrent, "branch:solo");
  const cancelTurn = command(turnCurrent.plan, "work_order.cancel.request", {
    reason: "cancel while turn acknowledgement is pending",
  }, turnCurrent.state.revision);
  turnCurrent = decideAndApply(turnCurrent, cancelTurn, {
    occurred_at: "2026-08-09T00:00:00.400Z",
    cancellation: { "branch:solo": cancellationFact(turnCurrent, "branch:solo") },
    cancellation_evidence_refs: ["evidence:cancel-turn-start"],
    attention_detail_ref: ref("attention:cancel-turn-start"),
  });
  const acceptedTurn = providerDeliveryObservation(turnCurrent, turnEffect, "accepted");
  turnCurrent = decideAndApply(turnCurrent, acceptedTurn, observationFacts("2026-08-09T00:00:00.500Z", {
    runtime_identity: {
      operation_id: "operation:cancelled-turn",
      thread_id: "thread:branch:solo",
      turn_id: "turn:cancelled",
    },
    delivery_effect: effectDeliveryFact(turnCurrent.projection.outbox[turnEffect.effect_id]),
    cancel_packets: packets(turnCurrent.plan, "cancel-after-accepted-turn"),
    reconciliation_resolution_ref: ref("resolution:cancelled-turn-start"),
  }));
  assert.equal(turnCurrent.state.status, "cancelling");
  assert.equal(turnCurrent.state.branches["branch:solo"].state, "cancelling");
  assert.ok(Object.values(turnCurrent.projection.outbox).some(
    (item) => item.effect_kind === "provider.turn.cancel" && item.status === "pending",
  ));
});

test("cancel remains nonterminal until provider work is quiescent; terminal late results only quarantine", () => {
  sourceSequence = 0;
  let current = start();
  current = acceptDispatch(current, "branch:solo", "2026-08-09T00:00:01.000Z");
  const cancel = command(current.plan, "work_order.cancel.request", {
    reason: "user stopped the operation",
  }, current.state.revision);
  current = decideAndApply(current, cancel, {
    occurred_at: "2026-08-09T00:00:02.000Z",
    cancel_packets: packets(current.plan, "cancel"),
  });
  assert.equal(current.state.status, "cancelling");
  assert.equal(current.state.branches["branch:solo"].state, "cancelling");
  assert.ok(eventTypes(current.decision).includes("business.outbox.enqueued"));

  const cancelEffect = currentEffect(current, "branch:solo", ["provider.turn.cancel"]);
  current = prepareDelivery(
    current,
    "branch:solo",
    "sending",
    "2026-08-09T00:00:02.100Z",
    "provider.turn.cancel",
  );
  const cancelAccepted = providerDeliveryObservation(current, cancelEffect, "accepted");
  current = decideAndApply(current, cancelAccepted, observationFacts("2026-08-09T00:00:02.200Z", {
    runtime_identity: current.state.branches["branch:solo"].runtime_identity,
    delivery_effect: effectDeliveryFact(current.projection.outbox[cancelEffect.effect_id]),
  }));
  assert.equal(current.projection.outbox[cancelEffect.effect_id].status, "delivered");

  const branchCancelled = observation(current.plan, "branch.cancelled", {
    branch_ref: "branch:solo",
    attempt: 1,
    reason: "provider confirmed cancellation",
  }, current.state.revision);
  current = decideAndApply(current, branchCancelled, observationFacts("2026-08-09T00:00:03.000Z"));
  assert.equal(current.state.status, "cancelling");
  const workOrderCancelled = observation(current.plan, "work_order.cancelled", {
    reason: "all mutating effects settled",
  }, current.state.revision);
  current = decideAndApply(current, workOrderCancelled, observationFacts(
    "2026-08-09T00:00:04.000Z",
    { mutating_effects_quiescent: true },
  ));
  assert.equal(current.state.status, "cancelled");

  const late = observation(current.plan, "branch.result.submitted", {
    branch_ref: "branch:solo",
    attempt: 1,
    artifact_refs: [ref("artifact:late")],
    evidence_refs: ["evidence:late-result"],
  }, current.state.revision);
  const lateDecision = decide(current.state, late, observationFacts(
    "2026-08-09T00:00:05.000Z",
  ));
  assert.equal(lateDecision.result.reason, "terminal_work_order");
  assert.deepEqual(eventTypes(lateDecision), ["business.late_observation.quarantined"]);
  const afterLate = applyDecision(current.projection, late, lateDecision);
  assert.equal(afterLate.work_orders[WORK_ORDER_ID].status, "cancelled");
  assert.equal(afterLate.work_orders[WORK_ORDER_ID].branches["branch:solo"].result, null);
});

test("a timeout and a later Work Order cancel share one active provider cancel effect", () => {
  sourceSequence = 0;
  let current = start();
  current = acceptDispatch(current, "branch:solo", "2026-08-09T00:00:01.000Z");
  const deadline = current.state.branches["branch:solo"].attempt_deadline_at;
  const timedOut = observation(current.plan, "branch.timed_out", {
    branch_ref: "branch:solo",
    attempt: 1,
    timeout_ms: current.plan.retry_policy.attempt_timeout_ms,
  }, current.state.revision);
  current = decideAndApply(current, timedOut, observationFacts(deadline, {
    cancel_packets: packets(current.plan, "timeout-cancel"),
  }));
  const firstCancelId = current.state.branches["branch:solo"].cancel_effect_id;
  assert.ok(firstCancelId);

  const cancel = command(current.plan, "work_order.cancel.request", {
    reason: "user confirmed the timeout should stop the whole Work Order",
  }, current.state.revision);
  current = decideAndApply(current, cancel, {
    occurred_at: new Date(Date.parse(deadline) + 1).toISOString(),
    cancel_packets: packets(current.plan, "explicit-cancel-after-timeout"),
  });
  assert.equal(current.state.status, "cancelling");
  assert.equal(current.state.branches["branch:solo"].cancel_effect_id, firstCancelId);
  assert.equal(Object.values(current.projection.outbox).filter((effect) => (
    effect.effect_kind === "provider.turn.cancel"
      && ["pending", "claimed", "sending", "delivery_unknown"].includes(effect.status)
  )).length, 1);

});

test("a proven-not-sent cancel can be retried with one successor identity", () => {
  sourceSequence = 0;
  let current = start();
  current = acceptDispatch(current, "branch:solo", "2026-08-09T00:00:01.000Z");
  const cancel = command(current.plan, "work_order.cancel.request", {
    reason: "stop the active turn",
  }, current.state.revision);
  current = decideAndApply(current, cancel, {
    occurred_at: "2026-08-09T00:00:02.000Z",
    cancel_packets: packets(current.plan, "cancel-first"),
  });
  const first = currentEffect(current, "branch:solo", ["provider.turn.cancel"]);
  current = prepareDelivery(
    current,
    "branch:solo",
    "claimed",
    "2026-08-09T00:00:02.100Z",
    "provider.turn.cancel",
  );
  const notSent = providerDeliveryObservation(current, first, "not_sent");
  current = decideAndApply(current, notSent, observationFacts("2026-08-09T00:00:02.200Z", {
    delivery_effect: effectDeliveryFact(current.projection.outbox[first.effect_id]),
    attention_detail_ref: ref("attention:cancel-not-sent"),
  }));
  assert.equal(current.state.branches["branch:solo"].cancel_effect_id, null);
  assert.equal(current.projection.outbox[first.effect_id].status, "not_sent");

  const retry = command(current.plan, "work_order.cancel.request", {
    reason: "retry the cancel proven not sent",
  }, current.state.revision);
  current = decideAndApply(current, retry, {
    occurred_at: "2026-08-09T00:00:02.300Z",
    cancel_packets: packets(current.plan, "cancel-successor"),
    generation_predecessors: {
      "branch:solo": cancellationFactForEffect(current.projection.outbox[first.effect_id]),
    },
  });
  const successor = currentEffect(current, "branch:solo", ["provider.turn.cancel"]);
  assert.notEqual(successor.effect_id, first.effect_id);
  assert.equal(successor.operation_scope_hash, first.operation_scope_hash);
  assert.equal(successor.operation_generation, first.operation_generation + 1);
  assert.equal(successor.generation_predecessor_effect_id, first.effect_id);
  assert.equal(current.state.branches["branch:solo"].cancel_effect_id, successor.effect_id);
  assert.equal(Object.values(current.projection.outbox).filter((effect) => (
    effect.effect_kind === "provider.turn.cancel"
      && ["pending", "claimed", "sending", "delivery_unknown"].includes(effect.status)
  )).length, 1);

  current = prepareDelivery(
    current,
    "branch:solo",
    "sending",
    "2026-08-09T00:00:02.400Z",
    "provider.turn.cancel",
  );
  const accepted = providerDeliveryObservation(current, successor, "accepted");
  current = decideAndApply(current, accepted, observationFacts("2026-08-09T00:00:02.500Z", {
    runtime_identity: current.state.branches["branch:solo"].runtime_identity,
    delivery_effect: effectDeliveryFact(current.projection.outbox[successor.effect_id]),
    reconciliation_resolution_ref: ref("resolution:cancel-successor-accepted"),
  }));
  assert.equal(current.projection.outbox[successor.effect_id].status, "delivered");
  assert.equal(Object.values(current.state.attention).filter((attention) => (
    attention.kind === "cancel_not_sent" && attention.status === "open"
  )).length, 0);
});

test("terminal commands, stale command revisions, and future observations fail closed", () => {
  sourceSequence = 0;
  let current = start();
  const staleResume = command(current.plan, "work_order.cancel.request", { reason: "stale" }, 0);
  assert.throws(
    () => decide(current.state, staleResume, { occurred_at: "2026-08-09T00:00:01.000Z" }),
    (error) => error.code === "BUSINESS_STALE_WORK_ORDER",
  );
  const future = observation(current.plan, "branch.progress", {
    branch_ref: "branch:solo",
    attempt: 1,
    message: "claims a future state",
  }, current.state.revision + 1);
  assert.throws(
    () => decide(current.state, future, observationFacts("2026-08-09T00:00:01.000Z")),
    (error) => error.code === "BUSINESS_FUTURE_OBSERVATION",
  );

  const terminalState = structuredClone(current.state);
  terminalState.status = "accepted";
  const terminalCancel = command(current.plan, "work_order.cancel.request", { reason: "too late" }, terminalState.revision);
  assert.throws(
    () => decide(terminalState, terminalCancel, { occurred_at: "2026-08-09T00:00:02.000Z" }),
    (error) => error.code === "BUSINESS_WORK_ORDER_TERMINAL",
  );
});
