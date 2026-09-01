"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { canonicalHash, canonicalJson } = require("@orquesta/contracts");
const {
  BusinessProjectionError,
  OUTBOX_IMMUTABLE_FIELDS,
  initialBusinessProjectionV1,
  projectBusinessEventV1,
  replayBusinessProjectionV1,
} = require("../src/projector");
const {
  normalizeBusinessWorkOrderPlanV1,
} = require("../src/contract");
const { deriveEffectOperationScopeHashV2 } = require("../src/lifecycle");
const {
  buildProviderSettlementCutoverBatchV1,
  deriveProviderSettlementCutoverReadinessV1,
} = require("../src/provider-settlement-cutover-boundary");

const WORK_ORDER_ID = "WO-11111111111111111111111111111111";
const CREATED_AT = "2026-08-09T00:00:00.000Z";
const DEADLINE_AT = "2026-08-09T00:10:00.000Z";
const ATTEMPT_DEADLINE = "2026-08-09T00:01:00.000Z";

function ref(id) {
  return { id, hash: canonicalHash({ id }) };
}

function planFixture() {
  return normalizeBusinessWorkOrderPlanV1({
    version: 1,
    project_ref: "project:projector-test",
    revision: 1,
    supersedes_plan_ref: null,
    title: "Project a durable Work Order",
    desired_outcome: "The event-only projection can be replayed deterministically.",
    acceptance_policy: {
      criteria: [{
        criterion_id: "criterion:tests",
        description: "The deterministic projector tests pass.",
        verification: "deterministic",
        verification_requirements: [{
          kind: "deterministic",
          verification_ref: ref("verification:projector-tests"),
        }],
      }],
      review_minimum: "normal",
    },
    task_intent_ref: ref("TI-projector-root"),
    execution_plan_ref: ref("EP-projector-root"),
    context_pack_ref: ref("CP-projector-root"),
    branches: [{
      branch_ref: "branch:solo",
      task_intent_ref: ref("TI-projector-solo"),
      execution_plan_ref: ref("EP-projector-solo"),
      context_pack_ref: ref("CP-projector-solo"),
      dependencies: [],
      role: "work",
      parallelizable: false,
      isolation: "sandbox",
      assignee_ref: "assignee:projector",
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
  prior,
  target,
  workOrderId = WORK_ORDER_ID,
  occurredAt = CREATED_AT,
  specific = {},
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
    evidence_refs: [],
  };
}

function inputBatch(plan, {
  batchId,
  sourceId,
  sourceType,
  prior,
  target,
  workOrderId = WORK_ORDER_ID,
  occurredAt = CREATED_AT,
  events,
  result = { status: "recorded" },
}) {
  const projected = events.map((entry, index) => businessEvent(plan, {
    eventId: `${sourceId}:event:${index + 1}`,
    type: entry.type,
    sourceId,
    prior,
    target,
    workOrderId,
    occurredAt,
    specific: entry.specific,
  }));
  const receiptType = {
    command: "business.command.received",
    observation: "business.observation.received",
    internal_action: "business.internal_action.received",
  }[sourceType];
  const receiptEventId = `${sourceId}:receipt`;
  projected.push(businessEvent(plan, {
    eventId: receiptEventId,
    type: receiptType,
    sourceId,
    prior,
    target,
    workOrderId,
    occurredAt,
    specific: {
      receipt: {
        source_id: sourceId,
        source_type: sourceType,
        identity_hash: canonicalHash({ sourceId, sourceType, principal: "fixture" }),
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

function v2Effect({
  workOrderId = WORK_ORDER_ID,
  branchRef = "branch:solo",
  attempt = 1,
  dispatchId = "dispatch:v2",
  effectKind = "provider.thread.create",
  originSourceId = "CMD-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  providerRef = "provider:recorded",
  packet,
  predecessorEffectId = null,
  predecessorDeliveryHash = null,
  targetRuntimeIdentity = null,
  requestId = null,
  responseRef = null,
  operationGeneration = 1,
  generationPredecessorEffectId = null,
  operationScopeHash = null,
  createdAt = CREATED_AT,
}) {
  const derivedOperationScopeHash = deriveEffectOperationScopeHashV2({
    effect_kind: effectKind,
    provider_ref: providerRef,
    packet_ref: packet.id,
    packet_hash: packet.hash,
    predecessor_effect_id: predecessorEffectId,
    predecessor_delivery_hash: predecessorDeliveryHash,
    target_runtime_identity: targetRuntimeIdentity,
    request_id: requestId,
    response_ref: responseRef,
  });
  const seed = {
    effect_contract_version: 2,
    work_order_id: workOrderId,
    branch_ref: branchRef,
    attempt,
    dispatch_id: dispatchId,
    effect_kind: effectKind,
    origin_source_id: originSourceId,
    operation_scope_hash: operationScopeHash || derivedOperationScopeHash,
    operation_generation: operationGeneration,
    generation_predecessor_effect_id: generationPredecessorEffectId,
    provider_ref: providerRef,
    packet_ref: packet.id,
    packet_hash: packet.hash,
    predecessor_effect_id: predecessorEffectId,
    predecessor_delivery_hash: predecessorDeliveryHash,
    target_runtime_identity: targetRuntimeIdentity,
  };
  return {
    effect_id: `FX-${canonicalHash(seed).slice(0, 32)}`,
    ...seed,
    idempotency_key: `IDEM-${canonicalHash(seed).slice(0, 32)}`,
    status: "pending",
    lease: null,
    delivery: null,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

function startFixture({
  workOrderId = WORK_ORDER_ID,
  sourceId = "CMD-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  suffix = "one",
  effectVersion = 1,
} = {}) {
  const plan = planFixture();
  const packet = ref(`packet:dispatch-${suffix}`);
  const dispatchId = effectVersion === 2
    ? `DSP-${"3".repeat(32)}`
    : `DSP-${canonicalHash({ legacy: suffix }).slice(0, 32)}`;
  const legacyEffect = {
    effect_id: `effect:turn-start:${suffix}`,
    work_order_id: workOrderId,
    branch_ref: "branch:solo",
    attempt: 1,
    dispatch_id: dispatchId,
    effect_kind: "provider.turn.start",
    provider_ref: "provider:recorded",
    packet_ref: packet.id,
    packet_hash: packet.hash,
    idempotency_key: `idempotency:turn-start:${suffix}`,
    status: "pending",
    lease: null,
    delivery: null,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
  };
  const effect = effectVersion === 2
    ? v2Effect({
      workOrderId,
      dispatchId,
      packet,
      originSourceId: sourceId,
    })
    : legacyEffect;
  const batch = inputBatch(plan, {
    batchId: `business:${sourceId}`,
    sourceId,
    sourceType: "command",
    prior: 0,
    target: 1,
    workOrderId,
    events: [
      {
        type: "business.work_order.created",
        specific: {
          plan,
          ...(effectVersion === 2 ? { engine_contract_version: 2 } : {}),
          revision: 1,
          status: "starting",
          created_at: CREATED_AT,
          deadline_at: DEADLINE_AT,
        },
      },
      {
        type: "business.context_budget.verified",
        specific: {
          receipt: {
            budget_tokens: 1_000,
            duplicate_context_tokens: 200,
            evidence_refs: ["evidence:context-budget"],
          },
        },
      },
      {
        type: "business.branch.initialized",
        specific: {
          branch: plan.branches[0],
          state: "ready",
          required_criterion_ids: ["criterion:tests"],
        },
      },
      {
        type: "business.branch.attempt_opened",
        specific: {
          branch_ref: "branch:solo",
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
    result: { work_order_id: workOrderId, revision: 1 },
  });
  return { batch, effect, packet, plan };
}

function effectIdentity(effect) {
  return Object.fromEntries(
    OUTBOX_IMMUTABLE_FIELDS
      .filter((field) => Object.hasOwn(effect, field))
      .map((field) => [field, effect[field]]),
  );
}

function projectBatches(batches, initial = initialBusinessProjectionV1()) {
  let projection = initial;
  for (const batch of batches) {
    for (const event of batch.events) projection = projectBusinessEventV1(projection, event, batch);
  }
  return projection;
}

function leaseFixture(label, occurredAt) {
  return {
    lease_id: `lease:${label}`,
    owner_id: `worker:${label}`,
    generation: 1,
    claimed_at: occurredAt,
    heartbeat_at: occurredAt,
    expires_at: new Date(Date.parse(occurredAt) + 30_000).toISOString(),
  };
}

function claimAndSendBatch(fixture, effect, {
  sourceId,
  occurredAt,
  prior,
  send = true,
}) {
  const lease = leaseFixture(sourceId, occurredAt);
  const events = [{
    type: "business.outbox.claimed",
    specific: { effect_id: effect.effect_id, effect: effectIdentity(effect), lease },
  }];
  if (send) {
    events.push({
      type: "business.outbox.send_begun",
      specific: {
        effect_id: effect.effect_id,
        effect: effectIdentity(effect),
        lease_id: lease.lease_id,
        lease_owner_id: lease.owner_id,
        lease_generation: lease.generation,
      },
    });
  }
  return {
    lease,
    batch: inputBatch(fixture.plan, {
      batchId: `business:${sourceId}`,
      sourceId,
      sourceType: "internal_action",
      prior,
      target: prior,
      workOrderId: effect.work_order_id,
      occurredAt,
      events,
    }),
  };
}

function observationFixture(fixture, {
  sourceId,
  revision,
  name,
  payload,
  actorType = "provider",
}) {
  return {
    version: 1,
    observation_id: sourceId,
    work_order_id: fixture.effect.work_order_id,
    plan_snapshot_ref: fixture.plan.plan_snapshot_id,
    plan_hash: fixture.plan.plan_hash,
    work_order_revision: revision,
    actor: { type: actorType, actor_id: `${actorType}:recorded` },
    name,
    payload,
    payload_hash: canonicalHash(payload),
  };
}

function acceptedLegacyTurnFixture() {
  const fixture = startFixture({ suffix: "legacy-accepted" });
  let projection = projectBatches([fixture.batch]);
  const claimed = claimAndSendBatch(fixture, fixture.effect, {
    sourceId: "INT-legacy-accepted-send",
    occurredAt: "2026-08-09T00:00:01.000Z",
    prior: 1,
  });
  projection = projectBatches([claimed.batch], projection);
  const sourceId = `OBS-${"1".repeat(32)}`;
  const occurredAt = "2026-08-09T00:00:02.000Z";
  const runtimeIdentity = {
    operation_id: "operation:legacy-only",
    thread_id: null,
    turn_id: null,
  };
  const observation = observationFixture(fixture, {
    sourceId,
    revision: 1,
    name: "branch.dispatch.accepted",
    payload: {
      branch_ref: "branch:solo",
      attempt: 1,
      dispatch_id: fixture.effect.dispatch_id,
    },
  });
  const accepted = inputBatch(fixture.plan, {
    batchId: `business:${sourceId}`,
    sourceId,
    sourceType: "observation",
    prior: 1,
    target: 2,
    occurredAt,
    events: [{
      type: "business.outbox.delivered",
      specific: {
        effect_id: fixture.effect.effect_id,
        effect: effectIdentity(fixture.effect),
        fencing_token: {
          lease_id: claimed.lease.lease_id,
          owner_id: claimed.lease.owner_id,
          generation: claimed.lease.generation,
        },
        delivery: {
          classification: "accepted",
          evidence_refs: ["evidence:legacy-accepted"],
          runtime_identity: runtimeIdentity,
          recorded_at: occurredAt,
        },
      },
    }, {
      type: "business.branch.runtime_observed",
      specific: { observation, runtime_identity: runtimeIdentity },
    }, {
      type: "business.branch.status_changed",
      specific: {
        branch_ref: "branch:solo",
        from: "dispatch_pending",
        to: "running",
        reason: "legacy_dispatch_accepted",
      },
    }, {
      type: "business.work_order.status_changed",
      specific: { from: "starting", to: "running", reason: "legacy_dispatch_accepted" },
    }],
  });
  projection = projectBatches([accepted], projection);
  return { fixture, projection, runtimeIdentity };
}

function acceptedV2TurnFixture() {
  const fixture = startFixture({
    sourceId: `CMD-${"c".repeat(32)}`,
    suffix: "v2-running",
    effectVersion: 2,
  });
  let projection = projectBatches([fixture.batch]);
  const threadClaim = claimAndSendBatch(fixture, fixture.effect, {
    sourceId: "INT-v2-running-thread-send",
    occurredAt: "2026-08-09T00:00:00.100Z",
    prior: 1,
  });
  projection = projectBatches([threadClaim.batch], projection);
  const threadSource = `OBS-${"d".repeat(32)}`;
  const threadAt = "2026-08-09T00:00:00.200Z";
  const threadIdentity = {
    operation_id: "operation:v2-thread",
    thread_id: "thread:v2-running",
    turn_id: null,
  };
  const threadDelivery = {
    classification: "accepted",
    evidence_refs: ["evidence:v2-thread"],
    runtime_identity: threadIdentity,
    recorded_at: threadAt,
  };
  const threadHash = canonicalHash({
    effect: effectIdentity(fixture.effect),
    ...threadDelivery,
  });
  const turnEffect = v2Effect({
    dispatchId: fixture.effect.dispatch_id,
    effectKind: "provider.turn.start",
    packet: fixture.packet,
    predecessorEffectId: fixture.effect.effect_id,
    predecessorDeliveryHash: threadHash,
    targetRuntimeIdentity: threadIdentity,
    originSourceId: threadSource,
    createdAt: threadAt,
  });
  const threadObservation = observationFixture(fixture, {
    sourceId: threadSource,
    revision: 1,
    name: "provider.effect.delivery.recorded",
    payload: {
      effect_id: fixture.effect.effect_id,
      effect_contract_version: 2,
      effect_kind: "provider.thread.create",
      branch_ref: "branch:solo",
      attempt: 1,
      dispatch_id: fixture.effect.dispatch_id,
      classification: "accepted",
    },
  });
  const threadAccepted = inputBatch(fixture.plan, {
    batchId: `business:${threadSource}`,
    sourceId: threadSource,
    sourceType: "observation",
    prior: 1,
    target: 2,
    occurredAt: threadAt,
    events: [{
      type: "business.outbox.delivered",
      specific: {
        effect_id: fixture.effect.effect_id,
        effect: effectIdentity(fixture.effect),
        fencing_token: {
          lease_id: threadClaim.lease.lease_id,
          owner_id: threadClaim.lease.owner_id,
          generation: threadClaim.lease.generation,
        },
        delivery: threadDelivery,
      },
    }, {
      type: "business.branch.runtime_observed",
      specific: {
        observation: threadObservation,
        runtime_identity: threadIdentity,
        delivery_effect_id: fixture.effect.effect_id,
        effect_kind: fixture.effect.effect_kind,
      },
    }, {
      type: "business.outbox.enqueued",
      specific: { effect: turnEffect },
    }],
  });
  projection = projectBatches([threadAccepted], projection);
  const turnClaim = claimAndSendBatch(fixture, turnEffect, {
    sourceId: "INT-v2-running-turn-send",
    occurredAt: "2026-08-09T00:00:00.300Z",
    prior: 2,
  });
  projection = projectBatches([turnClaim.batch], projection);
  const turnSource = `OBS-${"e".repeat(32)}`;
  const turnAt = "2026-08-09T00:00:00.400Z";
  const runtimeIdentity = {
    operation_id: "operation:v2-turn",
    thread_id: threadIdentity.thread_id,
    turn_id: "turn:v2-running",
  };
  const turnDelivery = {
    classification: "accepted",
    evidence_refs: ["evidence:v2-turn"],
    runtime_identity: runtimeIdentity,
    recorded_at: turnAt,
  };
  const turnHash = canonicalHash({ effect: effectIdentity(turnEffect), ...turnDelivery });
  const turnObservation = observationFixture(fixture, {
    sourceId: turnSource,
    revision: 2,
    name: "provider.effect.delivery.recorded",
    payload: {
      effect_id: turnEffect.effect_id,
      effect_contract_version: 2,
      effect_kind: "provider.turn.start",
      branch_ref: "branch:solo",
      attempt: 1,
      dispatch_id: turnEffect.dispatch_id,
      classification: "accepted",
    },
  });
  const turnAccepted = inputBatch(fixture.plan, {
    batchId: `business:${turnSource}`,
    sourceId: turnSource,
    sourceType: "observation",
    prior: 2,
    target: 3,
    occurredAt: turnAt,
    events: [{
      type: "business.outbox.delivered",
      specific: {
        effect_id: turnEffect.effect_id,
        effect: effectIdentity(turnEffect),
        fencing_token: {
          lease_id: turnClaim.lease.lease_id,
          owner_id: turnClaim.lease.owner_id,
          generation: turnClaim.lease.generation,
        },
        delivery: turnDelivery,
      },
    }, {
      type: "business.branch.runtime_observed",
      specific: {
        observation: turnObservation,
        runtime_identity: runtimeIdentity,
        delivery_effect_id: turnEffect.effect_id,
        effect_kind: turnEffect.effect_kind,
      },
    }, {
      type: "business.branch.status_changed",
      specific: {
        branch_ref: "branch:solo",
        from: "dispatch_pending",
        to: "running",
        reason: "v2_turn_accepted",
      },
    }, {
      type: "business.work_order.status_changed",
      specific: { from: "starting", to: "running", reason: "v2_turn_accepted" },
    }],
  });
  projection = projectBatches([turnAccepted], projection);
  return {
    fixture,
    projection,
    threadEffect: fixture.effect,
    turnEffect,
    threadIdentity,
    runtimeIdentity,
    threadHash,
    turnHash,
  };
}

function enqueueV2CancelFixture(running, {
  sourceId = `CMD-${"6".repeat(32)}`,
  occurredAt = "2026-08-09T00:00:00.500Z",
} = {}) {
  const packet = ref(`packet:${sourceId}`);
  const cancelEffect = v2Effect({
    dispatchId: running.turnEffect.dispatch_id,
    effectKind: "provider.turn.cancel",
    packet,
    predecessorEffectId: running.turnEffect.effect_id,
    predecessorDeliveryHash: running.turnHash,
    targetRuntimeIdentity: running.runtimeIdentity,
    originSourceId: sourceId,
    createdAt: occurredAt,
  });
  const batch = inputBatch(running.fixture.plan, {
    batchId: `business:${sourceId}`,
    sourceId,
    sourceType: "command",
    prior: 3,
    target: 4,
    occurredAt,
    events: [{
      type: "business.work_order.status_changed",
      specific: { from: "running", to: "cancelling", reason: "v2_cancel" },
    }, {
      type: "business.branch.status_changed",
      specific: {
        branch_ref: "branch:solo",
        from: "running",
        to: "cancelling",
        reason: "v2_cancel",
      },
    }, {
      type: "business.outbox.enqueued",
      specific: { effect: cancelEffect },
    }],
  });
  return {
    ...running,
    cancelEffect,
    cancelBatch: batch,
    projection: projectBatches([batch], running.projection),
  };
}

function attentionSpecific(kind, occurredAt, suffix = kind, effectId = undefined) {
  const attention = {
    attention_id: `attention:${suffix}`,
    kind,
    branch_ref: "branch:solo",
    detail_ref: ref(`attention-detail:${suffix}`),
    evidence_refs: [`evidence:${suffix}`],
    opened_at: occurredAt,
  };
  if (effectId !== undefined) attention.effect_id = effectId;
  return { attention };
}

function providerSettlementBatch(current, {
  sourceId,
  occurredAt,
  prior,
  effect,
  lease,
  classification,
  runtimeIdentity = null,
  extraEvents = [],
}) {
  const payload = {
    effect_id: effect.effect_id,
    effect_contract_version: 2,
    effect_kind: effect.effect_kind,
    branch_ref: effect.branch_ref,
    attempt: effect.attempt,
    dispatch_id: effect.dispatch_id,
    classification,
  };
  const eventType = {
    accepted: "business.outbox.delivered",
    not_sent: "business.outbox.not_sent",
    delivery_unknown: "business.outbox.delivery_unknown",
  }[classification];
  const specific = {
    observation: observationFixture(current.fixture, {
      sourceId,
      revision: prior,
      name: "provider.effect.delivery.recorded",
      payload,
    }),
    delivery_effect_id: effect.effect_id,
    effect_kind: effect.effect_kind,
  };
  if (runtimeIdentity !== null) specific.runtime_identity = runtimeIdentity;
  return inputBatch(current.fixture.plan, {
    batchId: `business:${sourceId}`,
    sourceId,
    sourceType: "observation",
    prior,
    target: prior + 1,
    occurredAt,
    events: [{
      type: eventType,
      specific: {
        effect_id: effect.effect_id,
        effect: effectIdentity(effect),
        fencing_token: lease === null ? null : {
          lease_id: lease.lease_id,
          owner_id: lease.owner_id,
          generation: lease.generation,
        },
        delivery: {
          classification,
          evidence_refs: [`evidence:${classification}`],
          runtime_identity: runtimeIdentity,
          recorded_at: occurredAt,
        },
      },
    }, {
      type: "business.branch.runtime_observed",
      specific,
    }, ...extraEvents],
  });
}

function pendingV2InputFixture({
  resolveAt = "2026-08-09T00:00:00.600Z",
} = {}) {
  const running = acceptedV2TurnFixture();
  const requestSource = `OBS-${"8".repeat(32)}`;
  const requestAt = "2026-08-09T00:00:00.500Z";
  const requestPayload = {
    branch_ref: "branch:solo",
    request_id: `REQ-${"8".repeat(32)}`,
    prompt_ref: ref("prompt:v2-cancel-race"),
  };
  const requested = inputBatch(running.fixture.plan, {
    batchId: `business:${requestSource}`,
    sourceId: requestSource,
    sourceType: "observation",
    prior: 3,
    target: 4,
    occurredAt: requestAt,
    events: [{
      type: "business.branch.runtime_observed",
      specific: {
        observation: observationFixture(running.fixture, {
          sourceId: requestSource,
          revision: 3,
          name: "user_input.requested",
          payload: requestPayload,
          actorType: "runtime",
        }),
        active_turn_effect_id: running.turnEffect.effect_id,
        active_runtime_identity: running.runtimeIdentity,
      },
    }, {
      type: "business.branch.status_changed",
      specific: {
        branch_ref: "branch:solo",
        from: "running",
        to: "waiting_for_user",
        reason: "v2_input_requested",
      },
    }],
  });
  let projection = projectBatches([requested], running.projection);
  const resolveSource = `CMD-${"8".repeat(32)}`;
  const responseRef = ref("response:v2-cancel-race");
  const inputEffect = v2Effect({
    dispatchId: running.turnEffect.dispatch_id,
    effectKind: "provider.user_input.submit",
    packet: responseRef,
    predecessorEffectId: running.turnEffect.effect_id,
    predecessorDeliveryHash: running.turnHash,
    targetRuntimeIdentity: running.runtimeIdentity,
    requestId: requestPayload.request_id,
    responseRef,
    originSourceId: resolveSource,
    createdAt: resolveAt,
  });
  const resolved = inputBatch(running.fixture.plan, {
    batchId: `business:${resolveSource}`,
    sourceId: resolveSource,
    sourceType: "command",
    prior: 4,
    target: 5,
    occurredAt: resolveAt,
    events: [{
      type: "business.outbox.enqueued",
      specific: { effect: inputEffect, user_input_response_ref: responseRef },
    }],
  });
  projection = projectBatches([resolved], projection);
  return {
    ...running,
    projection,
    inputEffect,
    requestPayload,
    responseRef,
  };
}

function notSentV2InputFixture({ sameMillisecond = false } = {}) {
  const sharedAt = "2026-08-09T00:00:00.600Z";
  const current = pendingV2InputFixture({ resolveAt: sharedAt });
  const claimAt = sameMillisecond ? sharedAt : "2026-08-09T00:00:00.700Z";
  const settledAt = sameMillisecond ? sharedAt : "2026-08-09T00:00:00.800Z";
  const claim = claimAndSendBatch(current.fixture, current.inputEffect, {
    sourceId: "INT-v2-input-lineage-claim",
    occurredAt: claimAt,
    prior: 5,
    send: false,
  });
  let projection = projectBatches([claim.batch], current.projection);
  const settlement = providerSettlementBatch(current, {
    sourceId: `OBS-${"b".repeat(32)}`,
    occurredAt: settledAt,
    prior: 5,
    effect: current.inputEffect,
    lease: claim.lease,
    classification: "not_sent",
  });
  projection = projectBatches([settlement], projection);
  return { ...current, claim, projection, settledAt };
}

function inputGenerationBatch(current, {
  sourceId,
  occurredAt,
  prior,
  operationGeneration,
  generationPredecessorEffectId,
  operationScopeHash = null,
  packet = current.responseRef,
}) {
  const effect = v2Effect({
    dispatchId: current.turnEffect.dispatch_id,
    effectKind: "provider.user_input.submit",
    packet,
    predecessorEffectId: current.turnEffect.effect_id,
    predecessorDeliveryHash: current.turnHash,
    targetRuntimeIdentity: current.runtimeIdentity,
    requestId: current.requestPayload.request_id,
    responseRef: current.responseRef,
    originSourceId: sourceId,
    operationGeneration,
    generationPredecessorEffectId,
    operationScopeHash,
    createdAt: occurredAt,
  });
  return {
    effect,
    batch: inputBatch(current.fixture.plan, {
      batchId: `business:${sourceId}`,
      sourceId,
      sourceType: "command",
      prior,
      target: prior + 1,
      occurredAt,
      events: [{
        type: "business.outbox.enqueued",
        specific: { effect, user_input_response_ref: current.responseRef },
      }],
    }),
  };
}

function expectCode(code) {
  return (error) => {
    assert.ok(error instanceof BusinessProjectionError);
    assert.equal(error.code, code);
    return true;
  };
}

test("projects the bounded V1 start batch and replays it deterministically", () => {
  const initial = initialBusinessProjectionV1();
  assert.deepEqual(initial, {
    schema_version: 2,
    work_orders: {},
    command_receipts: {},
    observation_receipts: {},
    internal_receipts: {},
    provider_entry_windows: {},
    outbox: {},
    late_observations: {},
    provider_settlement_epoch: null,
  });

  const fixture = startFixture();
  const first = replayBusinessProjectionV1([fixture.batch]);
  const second = replayBusinessProjectionV1([fixture.batch]);
  assert.equal(canonicalHash(first), canonicalHash(second));
  assert.equal(first.work_orders[WORK_ORDER_ID].revision, 1);
  assert.equal(first.work_orders[WORK_ORDER_ID].engine_contract_version, 1);
  assert.equal(first.work_orders[WORK_ORDER_ID].status, "starting");
  assert.equal(first.work_orders[WORK_ORDER_ID].pending_projection_input, null);
  assert.equal(first.work_orders[WORK_ORDER_ID].branches["branch:solo"].state, "dispatch_pending");
  assert.equal(first.work_orders[WORK_ORDER_ID].branches["branch:solo"].cancel_effect_id, null);
  assert.deepEqual(
    first.work_orders[WORK_ORDER_ID].branches["branch:solo"].required_criterion_ids,
    ["criterion:tests"],
  );
  assert.equal(first.outbox[fixture.effect.effect_id].status, "pending");
  assert.equal(first.outbox[fixture.effect.effect_id].effect_id, fixture.effect.effect_id);
  assert.equal(first.outbox[fixture.effect.effect_id].effect_kind, "provider.turn.start");
  assert.equal(Object.hasOwn(first.outbox[fixture.effect.effect_id], "effect_contract_version"), false);
  assert.ok(first.command_receipts["CMD-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]);
  assert.ok(Object.isFrozen(first));

  const exactReplay = replayBusinessProjectionV1([fixture.batch], first);
  assert.equal(canonicalJson(exactReplay), canonicalJson(first));

  const conflicting = structuredClone(fixture.batch);
  conflicting.events[0].payload.deadline_at = "2026-08-09T00:09:00.000Z";
  assert.throws(
    () => projectBusinessEventV1(first, conflicting.events[0], conflicting),
    expectCode("BUSINESS_PROJECTION_ID_CONFLICT"),
  );
});

test("projects one journal-global provider-settlement epoch without mutating Work Orders", () => {
  const initial = initialBusinessProjectionV1();
  const projectedReadiness = deriveProviderSettlementCutoverReadinessV1(initial, 0);
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
  const cutover = {
    version: 1,
    cutover_id: `PSC-${"a".repeat(32)}`,
    actor: { type: "system", actor_id: "system:provider-settlement-cutover" },
    settlement_contract_version: 2,
    send_authorization_contract_version: 2,
    payload_hash: canonicalHash({
      settlement_contract_version: 2,
      send_authorization_contract_version: 2,
    }),
  };
  const built = buildProviderSettlementCutoverBatchV1({
    cutover,
    principal: { type: "system", id: cutover.actor.actor_id },
    projection: initial,
    journal_sequence: 0,
    readiness: {
      readiness_assessment_ref: {
        id: `PSA-${assessmentHash.slice(0, 32)}`,
        hash: assessmentHash,
      },
      assessment,
    },
    occurred_at: "2026-08-10T00:00:00.000Z",
  });
  const projected = projectBatches([built.request], initial);
  assert.deepEqual(projected.provider_settlement_epoch, built.epoch);
  assert.deepEqual(projected.work_orders, initial.work_orders);
  assert.equal(canonicalHash(replayBusinessProjectionV1([built.request])), canonicalHash(projected));

  const tampered = structuredClone(built.request);
  tampered.events[0].payload.pre_cutover_projection_hash = "f".repeat(64);
  assert.throws(
    () => projectBatches([tampered], initial),
    expectCode("BUSINESS_PROJECTION_PROVIDER_SETTLEMENT_CUTOVER"),
  );
});

test("projects the atomic V2 thread-to-turn handoff and rejects hostile predecessor, target, or stage", () => {
  const fixture = startFixture({
    sourceId: "CMD-v2v2v2v2v2v2v2v2v2v2v2v2v2v2v2v2",
    suffix: "v2",
    effectVersion: 2,
  });
  const forgedThreadScope = structuredClone(fixture.batch);
  forgedThreadScope.events[4].payload.effect = v2Effect({
    dispatchId: fixture.effect.dispatch_id,
    packet: fixture.packet,
    originSourceId: "CMD-v2v2v2v2v2v2v2v2v2v2v2v2v2v2v2v2",
    operationScopeHash: "f".repeat(64),
  });
  assert.throws(
    () => projectBatches([forgedThreadScope]),
    expectCode("BUSINESS_PROJECTION_PLAN_BINDING"),
  );
  let projection = projectBatches([fixture.batch]);
  const lease = {
    lease_id: "lease:v2-create",
    owner_id: "worker:v2-create",
    generation: 1,
    claimed_at: "2026-08-09T00:00:01.000Z",
    heartbeat_at: "2026-08-09T00:00:01.000Z",
    expires_at: "2026-08-09T00:00:31.000Z",
  };
  const send = inputBatch(fixture.plan, {
    batchId: "business:INT-v2-create-send",
    sourceId: "INT-v2-create-send",
    sourceType: "internal_action",
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
    }, {
      type: "business.outbox.send_begun",
      specific: {
        effect_id: fixture.effect.effect_id,
        effect: effectIdentity(fixture.effect),
        lease_id: lease.lease_id,
        lease_owner_id: lease.owner_id,
        lease_generation: lease.generation,
      },
    }],
  });
  projection = projectBatches([send], projection);
  const occurredAt = "2026-08-09T00:00:02.000Z";
  const runtimeIdentity = {
    operation_id: "operation:v2-create",
    thread_id: "thread:v2",
    turn_id: null,
  };
  const delivery = {
    classification: "accepted",
    evidence_refs: ["evidence:v2-create"],
    runtime_identity: runtimeIdentity,
    recorded_at: occurredAt,
  };
  const predecessorDeliveryHash = canonicalHash({
    effect: effectIdentity(fixture.effect),
    ...delivery,
  });
  const turnEffect = v2Effect({
    dispatchId: fixture.effect.dispatch_id,
    effectKind: "provider.turn.start",
    packet: fixture.packet,
    predecessorEffectId: fixture.effect.effect_id,
    predecessorDeliveryHash,
    targetRuntimeIdentity: runtimeIdentity,
    originSourceId: `OBS-${"6".repeat(32)}`,
    createdAt: occurredAt,
  });
  const observationPayload = {
    effect_id: fixture.effect.effect_id,
    effect_contract_version: 2,
    effect_kind: "provider.thread.create",
    branch_ref: "branch:solo",
    attempt: 1,
    dispatch_id: fixture.effect.dispatch_id,
    classification: "accepted",
  };
  const observation = {
    version: 1,
    observation_id: `OBS-${"6".repeat(32)}`,
    work_order_id: WORK_ORDER_ID,
    plan_snapshot_ref: fixture.plan.plan_snapshot_id,
    plan_hash: fixture.plan.plan_hash,
    work_order_revision: 1,
    actor: { type: "provider", actor_id: "provider:recorded" },
    name: "provider.effect.delivery.recorded",
    payload: observationPayload,
    payload_hash: canonicalHash(observationPayload),
  };
  const accepted = inputBatch(fixture.plan, {
    batchId: `business:${observation.observation_id}`,
    sourceId: observation.observation_id,
    sourceType: "observation",
    prior: 1,
    target: 2,
    occurredAt,
    events: [{
      type: "business.outbox.delivered",
      specific: {
        effect_id: fixture.effect.effect_id,
        effect: effectIdentity(fixture.effect),
        fencing_token: {
          lease_id: lease.lease_id,
          owner_id: lease.owner_id,
          generation: lease.generation,
        },
        delivery,
      },
    }, {
      type: "business.branch.runtime_observed",
      specific: {
        observation,
        runtime_identity: runtimeIdentity,
        delivery_effect_id: fixture.effect.effect_id,
        effect_kind: fixture.effect.effect_kind,
      },
    }, {
      type: "business.outbox.enqueued",
      specific: { effect: turnEffect },
    }],
  });
  const handedOff = projectBatches([accepted], projection);
  assert.equal(handedOff.work_orders[WORK_ORDER_ID].engine_contract_version, 2);
  assert.equal(handedOff.outbox[fixture.effect.effect_id].status, "delivered");
  assert.equal(handedOff.outbox[turnEffect.effect_id].status, "pending");
  assert.equal(handedOff.work_orders[WORK_ORDER_ID].branches["branch:solo"].state, "dispatch_pending");
  assert.deepEqual(handedOff.work_orders[WORK_ORDER_ID].branches["branch:solo"].thread_identity, runtimeIdentity);

  const wrongPredecessor = structuredClone(accepted);
  wrongPredecessor.events[2].payload.effect.predecessor_effect_id = `FX-${"f".repeat(32)}`;
  assert.throws(
    () => projectBatches([wrongPredecessor], projection),
    expectCode("BUSINESS_PROJECTION_PLAN_BINDING"),
  );
  const wrongTarget = structuredClone(accepted);
  wrongTarget.events[2].payload.effect = v2Effect({
    dispatchId: fixture.effect.dispatch_id,
    effectKind: "provider.turn.start",
    packet: fixture.packet,
    predecessorEffectId: fixture.effect.effect_id,
    predecessorDeliveryHash,
    targetRuntimeIdentity: { operation_id: null, thread_id: "thread:forged", turn_id: null },
    originSourceId: `OBS-${"6".repeat(32)}`,
    createdAt: occurredAt,
  });
  assert.throws(
    () => projectBatches([wrongTarget], projection),
    expectCode("BUSINESS_PROJECTION_PLAN_BINDING"),
  );
  const wrongScope = structuredClone(accepted);
  wrongScope.events[2].payload.effect = v2Effect({
    dispatchId: fixture.effect.dispatch_id,
    effectKind: "provider.turn.start",
    packet: fixture.packet,
    predecessorEffectId: fixture.effect.effect_id,
    predecessorDeliveryHash,
    targetRuntimeIdentity: runtimeIdentity,
    originSourceId: `OBS-${"6".repeat(32)}`,
    operationScopeHash: "f".repeat(64),
    createdAt: occurredAt,
  });
  assert.throws(
    () => projectBatches([wrongScope], projection),
    expectCode("BUSINESS_PROJECTION_PLAN_BINDING"),
  );
  const wrongStage = structuredClone(accepted);
  wrongStage.events[1].payload.effect_kind = "provider.turn.start";
  assert.throws(
    () => projectBatches([wrongStage], projection),
    expectCode("BUSINESS_PROJECTION_OUTBOX_BINDING"),
  );
});

test("engine contracts select workers and reject implicit V1/V2 mixing", () => {
  const v2 = startFixture({
    sourceId: `CMD-${"7".repeat(32)}`,
    suffix: "engine-v2",
    effectVersion: 2,
  });
  const v2Started = projectBatches([v2.batch]);
  const v2Claim = claimAndSendBatch(v2, v2.effect, {
    sourceId: "INT-engine-v2-claim",
    occurredAt: "2026-08-09T00:00:00.100Z",
    prior: 1,
    send: false,
  });
  assert.equal(
    projectBatches([v2Claim.batch], v2Started).outbox[v2.effect.effect_id].status,
    "claimed",
  );

  const v1 = startFixture({ suffix: "engine-v1" });
  const v1Started = projectBatches([v1.batch]);
  const explicitV1 = structuredClone(v1.batch);
  explicitV1.events[0].payload.engine_contract_version = 1;
  assert.equal(
    projectBatches([explicitV1]).work_orders[WORK_ORDER_ID].engine_contract_version,
    1,
  );
  const v1Claim = claimAndSendBatch(v1, v1.effect, {
    sourceId: "INT-engine-v1-claim",
    occurredAt: "2026-08-09T00:00:00.100Z",
    prior: 1,
    send: false,
  });
  assert.equal(
    projectBatches([v1Claim.batch], v1Started).outbox[v1.effect.effect_id].status,
    "claimed",
  );

  const legacy = startFixture({ suffix: "engine-mixed-v1" }).effect;
  const mixedV2 = structuredClone(v2Started);
  mixedV2.outbox[legacy.effect_id] = {
    ...legacy,
    status: "cancelled",
    updated_at: "2026-08-09T00:00:00.050Z",
    last_delivery_reason: "historical_terminal_v1",
  };
  assert.throws(
    () => projectBatches([v2Claim.batch], mixedV2),
    expectCode("BUSINESS_PROJECTION_VERSION"),
  );

  const mixedV1 = structuredClone(v1Started);
  mixedV1.outbox[v2.effect.effect_id] = v2.effect;
  assert.throws(
    () => projectBatches([v1Claim.batch], mixedV1),
    expectCode("BUSINESS_PROJECTION_VERSION"),
  );

  const implicitUpgrade = structuredClone(v2.batch);
  delete implicitUpgrade.events[0].payload.engine_contract_version;
  assert.throws(
    () => projectBatches([implicitUpgrade]),
    expectCode("BUSINESS_PROJECTION_VERSION"),
  );
  const implicitDowngrade = structuredClone(v1.batch);
  implicitDowngrade.events[0].payload.engine_contract_version = 2;
  assert.throws(
    () => projectBatches([implicitDowngrade]),
    expectCode("BUSINESS_PROJECTION_VERSION"),
  );
  const unsupported = structuredClone(v1.batch);
  unsupported.events[0].payload.engine_contract_version = 3;
  assert.throws(
    () => projectBatches([unsupported]),
    expectCode("BUSINESS_PROJECTION_INVALID"),
  );
  const versionMutation = inputBatch(v1.plan, {
    batchId: "business:CMD-engine-version-mutation",
    sourceId: "CMD-engine-version-mutation",
    sourceType: "command",
    prior: 1,
    target: 2,
    occurredAt: "2026-08-09T00:00:00.200Z",
    events: [{
      type: "business.work_order.status_changed",
      specific: {
        from: "starting",
        to: "paused",
        reason: "implicit_engine_upgrade",
        engine_contract_version: 2,
      },
    }],
  });
  assert.throws(
    () => projectBatches([versionMutation], v1Started),
    expectCode("BUSINESS_PROJECTION_INVALID"),
  );

  const otherWorkOrderId = "WO-22222222222222222222222222222222";
  const unrelated = startFixture({
    workOrderId: otherWorkOrderId,
    sourceId: `CMD-${"8".repeat(32)}`,
    suffix: "unrelated-v1",
  });
  const separated = projectBatches([v2.batch, unrelated.batch]);
  const unrelatedClaim = claimAndSendBatch(v2, v2.effect, {
    sourceId: "INT-engine-unrelated-v1",
    occurredAt: "2026-08-09T00:00:00.100Z",
    prior: 1,
    send: false,
  });
  const separatedClaimed = projectBatches([unrelatedClaim.batch], separated);
  assert.equal(separatedClaimed.outbox[v2.effect.effect_id].status, "claimed");
  assert.equal(separatedClaimed.outbox[unrelated.effect.effect_id].status, "pending");
});

test("legacy operation-only delivery remains an exact replay path", () => {
  const { projection, runtimeIdentity } = acceptedLegacyTurnFixture();
  const branch = projection.work_orders[WORK_ORDER_ID].branches["branch:solo"];
  assert.equal(projection.work_orders[WORK_ORDER_ID].status, "running");
  assert.equal(branch.state, "running");
  assert.deepEqual(branch.runtime_identity, runtimeIdentity);
  assert.equal(branch.runtime_identity.thread_id, null);
  assert.equal(branch.runtime_identity.turn_id, null);
});

test("legacy input resolution can run, claim, send, and replay without V2 markers", () => {
  const accepted = acceptedLegacyTurnFixture();
  const { fixture } = accepted;
  const requestSource = `OBS-${"3".repeat(32)}`;
  const requestAt = "2026-08-09T00:00:03.000Z";
  const requestPayload = {
    branch_ref: "branch:solo",
    request_id: `REQ-${"3".repeat(32)}`,
    prompt_ref: ref("prompt:legacy-replay"),
  };
  const requested = inputBatch(fixture.plan, {
    batchId: `business:${requestSource}`,
    sourceId: requestSource,
    sourceType: "observation",
    prior: 2,
    target: 3,
    occurredAt: requestAt,
    events: [{
      type: "business.branch.runtime_observed",
      specific: {
        observation: observationFixture(fixture, {
          sourceId: requestSource,
          revision: 2,
          name: "user_input.requested",
          payload: requestPayload,
          actorType: "runtime",
        }),
      },
    }, {
      type: "business.branch.status_changed",
      specific: {
        branch_ref: "branch:solo",
        from: "running",
        to: "waiting_for_user",
        reason: "legacy_input_requested",
      },
    }],
  });
  let projection = projectBatches([requested], accepted.projection);
  const resolveSource = "CMD-legacy-input-resolve";
  const resolveAt = "2026-08-09T00:00:04.000Z";
  const responseRef = ref("response:legacy-replay");
  const inputEffect = {
    ...fixture.effect,
    effect_id: "effect:user-input:legacy-replay",
    effect_kind: "provider.user_input.submit",
    packet_ref: responseRef.id,
    packet_hash: responseRef.hash,
    idempotency_key: "idempotency:user-input:legacy-replay",
    status: "pending",
    lease: null,
    delivery: null,
    created_at: resolveAt,
    updated_at: resolveAt,
  };
  const resolved = inputBatch(fixture.plan, {
    batchId: `business:${resolveSource}`,
    sourceId: resolveSource,
    sourceType: "command",
    prior: 3,
    target: 4,
    occurredAt: resolveAt,
    events: [{
      type: "business.outbox.enqueued",
      specific: { effect: inputEffect },
    }, {
      type: "business.branch.status_changed",
      specific: {
        branch_ref: "branch:solo",
        from: "waiting_for_user",
        to: "running",
        reason: "legacy_input_resolved",
        resolved_request_id: requestPayload.request_id,
        response_ref: responseRef,
      },
    }],
  });
  projection = projectBatches([resolved], projection);
  assert.equal(projection.work_orders[WORK_ORDER_ID].branches["branch:solo"].state, "running");
  const sent = claimAndSendBatch(fixture, inputEffect, {
    sourceId: "INT-legacy-input-send",
    occurredAt: "2026-08-09T00:00:05.000Z",
    prior: 4,
  });
  const afterSend = projectBatches([sent.batch], projection);
  assert.equal(afterSend.outbox[inputEffect.effect_id].status, "sending");
  const exactReplay = projectBatches([sent.batch], afterSend);
  assert.equal(canonicalJson(exactReplay), canonicalJson(afterSend));

  const failedSource = `OBS-${"a".repeat(32)}`;
  const failedPayload = {
    branch_ref: "branch:solo",
    attempt: 1,
    failure_code: "legacy_input_followup_failed",
  };
  const failedAndPaused = inputBatch(fixture.plan, {
    batchId: `business:${failedSource}`,
    sourceId: failedSource,
    sourceType: "observation",
    prior: 4,
    target: 5,
    occurredAt: "2026-08-09T00:00:06.000Z",
    events: [{
      type: "business.branch.runtime_observed",
      specific: {
        observation: observationFixture(fixture, {
          sourceId: failedSource,
          revision: 4,
          name: "branch.failed",
          payload: failedPayload,
          actorType: "runtime",
        }),
      },
    }, {
      type: "business.branch.status_changed",
      specific: {
        branch_ref: "branch:solo",
        from: "running",
        to: "failed",
        reason: "legacy_input_followup_failed",
      },
    }, {
      type: "business.work_order.status_changed",
      specific: { from: "running", to: "paused", reason: "legacy_branch_failed" },
    }],
  });
  const paused = projectBatches([failedAndPaused], afterSend);
  assert.equal(paused.work_orders[WORK_ORDER_ID].status, "paused");
  assert.equal(paused.outbox[inputEffect.effect_id].status, "sending");

  const resultSource = `OBS-${"b".repeat(32)}`;
  const resultPayload = {
    branch_ref: "branch:solo",
    attempt: 1,
    artifact_refs: [ref("artifact:legacy-after-input")],
    evidence_refs: ["evidence:legacy-after-input"],
  };
  const result = inputBatch(fixture.plan, {
    batchId: `business:${resultSource}`,
    sourceId: resultSource,
    sourceType: "observation",
    prior: 4,
    target: 5,
    occurredAt: "2026-08-09T00:00:06.000Z",
    events: [{
      type: "business.branch.runtime_observed",
      specific: {
        observation: observationFixture(fixture, {
          sourceId: resultSource,
          revision: 4,
          name: "branch.result.submitted",
          payload: resultPayload,
          actorType: "runtime",
        }),
      },
    }, {
      type: "business.branch.status_changed",
      specific: {
        branch_ref: "branch:solo",
        from: "running",
        to: "verifying",
        reason: "legacy_result_submitted",
      },
    }],
  });
  const verifying = projectBatches([result], afterSend);
  const terminalBatch = inputBatch(fixture.plan, {
    batchId: "business:CMD-legacy-input-terminal",
    sourceId: "CMD-legacy-input-terminal",
    sourceType: "command",
    prior: 5,
    target: 6,
    occurredAt: "2026-08-09T00:00:07.000Z",
    events: [{
      type: "business.branch.status_changed",
      specific: {
        branch_ref: "branch:solo",
        from: "verifying",
        to: "failed",
        reason: "legacy_verification_failed",
      },
    }, {
      type: "business.work_order.status_changed",
      specific: { from: "running", to: "failed", reason: "legacy_verification_failed" },
    }],
  });
  const terminal = projectBatches([terminalBatch], verifying);
  assert.equal(terminal.work_orders[WORK_ORDER_ID].status, "failed");
  assert.equal(terminal.outbox[inputEffect.effect_id].status, "sending");
});

test("legacy running cancellation retains exactly one matching V1 cancel effect", () => {
  const accepted = acceptedLegacyTurnFixture();
  const { fixture } = accepted;
  const sourceId = "CMD-legacy-cancel";
  const occurredAt = "2026-08-09T00:00:03.000Z";
  const packet = ref("packet:legacy-cancel");
  const cancelEffect = {
    ...fixture.effect,
    effect_id: "effect:turn-cancel:legacy",
    effect_kind: "provider.turn.cancel",
    packet_ref: packet.id,
    packet_hash: packet.hash,
    idempotency_key: "idempotency:turn-cancel:legacy",
    status: "pending",
    lease: null,
    delivery: null,
    created_at: occurredAt,
    updated_at: occurredAt,
  };
  const cancelled = inputBatch(fixture.plan, {
    batchId: `business:${sourceId}`,
    sourceId,
    sourceType: "command",
    prior: 2,
    target: 3,
    occurredAt,
    events: [{
      type: "business.work_order.status_changed",
      specific: { from: "running", to: "cancelling", reason: "legacy_cancel" },
    }, {
      type: "business.branch.status_changed",
      specific: {
        branch_ref: "branch:solo",
        from: "running",
        to: "cancelling",
        reason: "legacy_cancel",
      },
    }, {
      type: "business.outbox.enqueued",
      specific: { effect: cancelEffect },
    }],
  });
  const projection = projectBatches([cancelled], accepted.projection);
  const branch = projection.work_orders[WORK_ORDER_ID].branches["branch:solo"];
  assert.equal(branch.state, "cancelling");
  assert.equal(branch.cancel_effect_id, null);
  assert.equal(projection.outbox[cancelEffect.effect_id].status, "pending");
  const branchSource = `OBS-${"6".repeat(32)}`;
  const branchPayload = {
    branch_ref: "branch:solo",
    attempt: 1,
    reason: "legacy provider confirmed cancellation",
  };
  const branchCancelled = inputBatch(fixture.plan, {
    batchId: `business:${branchSource}`,
    sourceId: branchSource,
    sourceType: "observation",
    prior: 3,
    target: 4,
    occurredAt: "2026-08-09T00:00:04.000Z",
    events: [{
      type: "business.branch.runtime_observed",
      specific: {
        observation: observationFixture(fixture, {
          sourceId: branchSource,
          revision: 3,
          name: "branch.cancelled",
          payload: branchPayload,
          actorType: "runtime",
        }),
        runtime_identity: accepted.runtimeIdentity,
      },
    }, {
      type: "business.branch.status_changed",
      specific: {
        branch_ref: "branch:solo",
        from: "cancelling",
        to: "cancelled",
        reason: "legacy_provider_confirmed",
      },
    }],
  });
  const branchTerminal = projectBatches([branchCancelled], projection);
  assert.equal(
    branchTerminal.work_orders[WORK_ORDER_ID].branches["branch:solo"].state,
    "cancelled",
  );
  assert.equal(branchTerminal.outbox[cancelEffect.effect_id].status, "pending");

  const workOrderSource = `OBS-${"7".repeat(32)}`;
  const workOrderPayload = { reason: "legacy cancellation complete" };
  const workOrderCancelled = inputBatch(fixture.plan, {
    batchId: `business:${workOrderSource}`,
    sourceId: workOrderSource,
    sourceType: "observation",
    prior: 4,
    target: 5,
    occurredAt: "2026-08-09T00:00:05.000Z",
    events: [{
      type: "business.branch.runtime_observed",
      specific: {
        observation: observationFixture(fixture, {
          sourceId: workOrderSource,
          revision: 4,
          name: "work_order.cancelled",
          payload: workOrderPayload,
          actorType: "runtime",
        }),
      },
    }, {
      type: "business.work_order.status_changed",
      specific: {
        from: "cancelling",
        to: "cancelled",
        reason: "legacy_cancellation_complete",
      },
    }],
  });
  const terminal = projectBatches([workOrderCancelled], branchTerminal);
  assert.equal(terminal.work_orders[WORK_ORDER_ID].status, "cancelled");
  assert.equal(terminal.outbox[cancelEffect.effect_id].status, "pending");
});

test("legacy dispatch timeouts replay pending, claimed, or sending starts without weakening V2", () => {
  const cases = [
    { status: "pending", digit: "c" },
    { status: "claimed", digit: "d" },
    { status: "sending", digit: "e" },
  ];
  for (const { status, digit } of cases) {
    const fixture = startFixture({ suffix: `legacy-timeout-${status}` });
    let projection = projectBatches([fixture.batch]);
    if (status !== "pending") {
      const prepared = claimAndSendBatch(fixture, fixture.effect, {
        sourceId: `INT-legacy-timeout-${status}`,
        occurredAt: "2026-08-09T00:00:30.100Z",
        prior: 1,
        send: status === "sending",
      });
      projection = projectBatches([prepared.batch], projection);
    }
    const sourceId = `OBS-${digit.repeat(32)}`;
    const payload = { branch_ref: "branch:solo", attempt: 1, timeout_ms: 60_000 };
    const timedOut = inputBatch(fixture.plan, {
      batchId: `business:${sourceId}`,
      sourceId,
      sourceType: "observation",
      prior: 1,
      target: 2,
      occurredAt: ATTEMPT_DEADLINE,
      events: [{
        type: "business.branch.runtime_observed",
        specific: {
          observation: observationFixture(fixture, {
            sourceId,
            revision: 1,
            name: "branch.timed_out",
            payload,
            actorType: "runtime",
          }),
        },
      }, {
        type: "business.branch.status_changed",
        specific: {
          branch_ref: "branch:solo",
          from: "dispatch_pending",
          to: "cancelling",
          reason: "legacy_timeout_requires_reconciliation",
        },
      }, {
        type: "business.work_order.status_changed",
        specific: {
          from: "starting",
          to: "cancelling",
          reason: "legacy_timeout_requires_reconciliation",
        },
      }, {
        type: "business.attention.opened",
        specific: attentionSpecific(
          "timeout_requires_reconciliation",
          ATTEMPT_DEADLINE,
          `legacy-timeout-${status}`,
        ),
      }],
    });
    const replayed = projectBatches([timedOut], projection);
    assert.equal(
      replayed.work_orders[WORK_ORDER_ID].branches["branch:solo"].state,
      "cancelling",
    );
    assert.equal(replayed.outbox[fixture.effect.effect_id].status, status);
    assert.equal(
      replayed.work_orders[WORK_ORDER_ID]
        .attention[`attention:legacy-timeout-${status}`].effect_id,
      null,
    );
  }

  const v2 = startFixture({
    sourceId: `CMD-${"2".repeat(32)}`,
    suffix: "v2-timeout-must-close",
    effectVersion: 2,
  });
  const v2Started = projectBatches([v2.batch]);
  const v2Source = `OBS-${"2".repeat(32)}`;
  const v2Payload = { branch_ref: "branch:solo", attempt: 1, timeout_ms: 60_000 };
  const v2Attack = inputBatch(v2.plan, {
    batchId: `business:${v2Source}`,
    sourceId: v2Source,
    sourceType: "observation",
    prior: 1,
    target: 2,
    occurredAt: ATTEMPT_DEADLINE,
    events: [{
      type: "business.branch.runtime_observed",
      specific: {
        observation: observationFixture(v2, {
          sourceId: v2Source,
          revision: 1,
          name: "branch.timed_out",
          payload: v2Payload,
          actorType: "runtime",
        }),
      },
    }, {
      type: "business.branch.status_changed",
      specific: {
        branch_ref: "branch:solo",
        from: "dispatch_pending",
        to: "cancelling",
        reason: "must_not_use_legacy_timeout_compat",
      },
    }, {
      type: "business.work_order.status_changed",
      specific: {
        from: "starting",
        to: "cancelling",
        reason: "must_not_use_legacy_timeout_compat",
      },
    }, {
      type: "business.attention.opened",
      specific: attentionSpecific(
        "timeout_requires_reconciliation",
        ATTEMPT_DEADLINE,
        "v2-timeout-must-close",
      ),
    }],
  });
  assert.throws(
    () => projectBatches([v2Attack], v2Started),
    expectCode("BUSINESS_PROJECTION_RECEIPT_BINDING"),
  );
});

test("legacy cancel or timeout clears an unanswered open prompt before closure", () => {
  const accepted = acceptedLegacyTurnFixture();
  const { fixture } = accepted;
  const requestSource = `OBS-${"f".repeat(32)}`;
  const requestPayload = {
    branch_ref: "branch:solo",
    request_id: `REQ-${"f".repeat(32)}`,
    prompt_ref: ref("prompt:legacy-cancel-open"),
  };
  const request = inputBatch(fixture.plan, {
    batchId: `business:${requestSource}`,
    sourceId: requestSource,
    sourceType: "observation",
    prior: 2,
    target: 3,
    occurredAt: "2026-08-09T00:00:03.000Z",
    events: [{
      type: "business.branch.runtime_observed",
      specific: {
        observation: observationFixture(fixture, {
          sourceId: requestSource,
          revision: 2,
          name: "user_input.requested",
          payload: requestPayload,
          actorType: "runtime",
        }),
      },
    }, {
      type: "business.branch.status_changed",
      specific: {
        branch_ref: "branch:solo",
        from: "running",
        to: "waiting_for_user",
        reason: "legacy_prompt_opened",
      },
    }],
  });
  const waiting = projectBatches([request], accepted.projection);
  const makeCancelEffect = (suffix, occurredAt) => {
    const packet = ref(`packet:${suffix}`);
    return {
      ...fixture.effect,
      effect_id: `effect:turn-cancel:${suffix}`,
      effect_kind: "provider.turn.cancel",
      packet_ref: packet.id,
      packet_hash: packet.hash,
      idempotency_key: `idempotency:turn-cancel:${suffix}`,
      status: "pending",
      lease: null,
      delivery: null,
      created_at: occurredAt,
      updated_at: occurredAt,
    };
  };

  const cancelAt = "2026-08-09T00:00:04.000Z";
  const cancelEffect = makeCancelEffect("legacy-open-prompt", cancelAt);
  const cancel = inputBatch(fixture.plan, {
    batchId: "business:CMD-legacy-open-prompt-cancel",
    sourceId: "CMD-legacy-open-prompt-cancel",
    sourceType: "command",
    prior: 3,
    target: 4,
    occurredAt: cancelAt,
    events: [{
      type: "business.work_order.status_changed",
      specific: { from: "running", to: "cancelling", reason: "legacy_prompt_cancel" },
    }, {
      type: "business.branch.status_changed",
      specific: {
        branch_ref: "branch:solo",
        from: "waiting_for_user",
        to: "cancelling",
        reason: "legacy_prompt_cancel",
      },
    }, {
      type: "business.outbox.enqueued",
      specific: { effect: cancelEffect },
    }],
  });
  const cancelled = projectBatches([cancel], waiting);
  assert.equal(
    cancelled.work_orders[WORK_ORDER_ID].branches["branch:solo"].open_user_input,
    null,
  );

  const timeoutSource = `OBS-${"0".repeat(32)}`;
  const timeoutEffect = makeCancelEffect("legacy-open-prompt-timeout", ATTEMPT_DEADLINE);
  const timeoutPayload = { branch_ref: "branch:solo", attempt: 1, timeout_ms: 60_000 };
  const timeout = inputBatch(fixture.plan, {
    batchId: `business:${timeoutSource}`,
    sourceId: timeoutSource,
    sourceType: "observation",
    prior: 3,
    target: 4,
    occurredAt: ATTEMPT_DEADLINE,
    events: [{
      type: "business.branch.runtime_observed",
      specific: {
        observation: observationFixture(fixture, {
          sourceId: timeoutSource,
          revision: 3,
          name: "branch.timed_out",
          payload: timeoutPayload,
          actorType: "runtime",
        }),
      },
    }, {
      type: "business.work_order.status_changed",
      specific: { from: "running", to: "cancelling", reason: "legacy_prompt_timeout" },
    }, {
      type: "business.branch.status_changed",
      specific: {
        branch_ref: "branch:solo",
        from: "waiting_for_user",
        to: "cancelling",
        reason: "legacy_prompt_timeout",
      },
    }, {
      type: "business.outbox.enqueued",
      specific: { effect: timeoutEffect },
    }],
  });
  const timedOut = projectBatches([timeout], waiting);
  assert.equal(
    timedOut.work_orders[WORK_ORDER_ID].branches["branch:solo"].open_user_input,
    null,
  );
});

test("mixed V1 and V2 stages reject every unannotated legacy runtime alias", () => {
  const fixture = startFixture({
    sourceId: `CMD-${"4".repeat(32)}`,
    suffix: "mixed-alias",
    effectVersion: 2,
  });
  const mixed = structuredClone(projectBatches([fixture.batch]));
  const runtimeIdentity = {
    operation_id: "operation:mixed-legacy",
    thread_id: null,
    turn_id: null,
  };
  const legacy = {
    ...startFixture({ suffix: "mixed-legacy" }).effect,
    work_order_id: WORK_ORDER_ID,
    attempt: 1,
    dispatch_id: fixture.effect.dispatch_id,
    status: "delivered",
    delivery: {
      classification: "accepted",
      evidence_refs: ["evidence:mixed-legacy"],
      runtime_identity: runtimeIdentity,
      recorded_at: "2026-08-09T00:00:01.000Z",
    },
    updated_at: "2026-08-09T00:00:01.000Z",
  };
  mixed.outbox[legacy.effect_id] = legacy;
  const deliverySource = `OBS-${"4".repeat(32)}`;
  const deliveryAlias = inputBatch(fixture.plan, {
    batchId: `business:${deliverySource}`,
    sourceId: deliverySource,
    sourceType: "observation",
    prior: 1,
    target: 2,
    occurredAt: legacy.delivery.recorded_at,
    events: [{
      type: "business.branch.runtime_observed",
      specific: {
        observation: observationFixture(fixture, {
          sourceId: deliverySource,
          revision: 1,
          name: "branch.dispatch.accepted",
          payload: {
            branch_ref: "branch:solo",
            attempt: 1,
            dispatch_id: fixture.effect.dispatch_id,
          },
        }),
        runtime_identity: runtimeIdentity,
      },
    }],
  });
  assert.throws(
    () => projectBatches([deliveryAlias], mixed),
    expectCode("BUSINESS_PROJECTION_OUTBOX_BINDING"),
  );

  const runningMixed = structuredClone(mixed);
  const branch = runningMixed.work_orders[WORK_ORDER_ID].branches["branch:solo"];
  runningMixed.work_orders[WORK_ORDER_ID].status = "running";
  branch.state = "running";
  branch.delivery = { classification: "accepted", observed_at: legacy.delivery.recorded_at };
  branch.runtime_identity = runtimeIdentity;
  const progressSource = `OBS-${"5".repeat(32)}`;
  const progressAlias = inputBatch(fixture.plan, {
    batchId: `business:${progressSource}`,
    sourceId: progressSource,
    sourceType: "observation",
    prior: 1,
    target: 2,
    occurredAt: "2026-08-09T00:00:02.000Z",
    events: [{
      type: "business.branch.runtime_observed",
      specific: {
        observation: observationFixture(fixture, {
          sourceId: progressSource,
          revision: 1,
          name: "branch.progress",
          payload: { branch_ref: "branch:solo", attempt: 1, message: "forged legacy alias" },
          actorType: "runtime",
        }),
      },
    }],
  });
  assert.throws(
    () => projectBatches([progressAlias], runningMixed),
    expectCode("BUSINESS_PROJECTION_OUTBOX_BINDING"),
  );
});

test("receipt closure rejects raw parent and multi-hop lifecycle jumps", () => {
  const fixture = startFixture({
    sourceId: `CMD-${"1".repeat(32)}`,
    suffix: "raw-lifecycle",
    effectVersion: 2,
  });
  const started = projectBatches([fixture.batch]);
  for (const [index, status] of ["paused", "cancelling"].entries()) {
    const sourceId = `CMD-raw-parent-${index}`;
    const attack = inputBatch(fixture.plan, {
      batchId: `business:${sourceId}`,
      sourceId,
      sourceType: "command",
      prior: 1,
      target: 2,
      occurredAt: "2026-08-09T00:00:01.000Z",
      events: [{
        type: "business.work_order.status_changed",
        specific: { from: "starting", to: status, reason: "raw_parent_jump" },
      }],
    });
    assert.throws(
      () => projectBatches([attack], started),
      expectCode("BUSINESS_PROJECTION_RECEIPT_BINDING"),
      status,
    );
  }

  const multiHop = inputBatch(fixture.plan, {
    batchId: "business:CMD-raw-multi-hop",
    sourceId: "CMD-raw-multi-hop",
    sourceType: "command",
    prior: 1,
    target: 2,
    occurredAt: "2026-08-09T00:00:01.000Z",
    events: [{
      type: "business.branch.status_changed",
      specific: {
        branch_ref: "branch:solo",
        from: "dispatch_pending",
        to: "running",
        reason: "raw_without_delivery",
      },
    }, {
      type: "business.branch.status_changed",
      specific: {
        branch_ref: "branch:solo",
        from: "running",
        to: "waiting_for_user",
        reason: "raw_without_prompt",
      },
    }, {
      type: "business.work_order.status_changed",
      specific: { from: "starting", to: "running", reason: "raw_without_delivery" },
    }],
  });
  assert.throws(
    () => projectBatches([multiHop], started),
    expectCode("BUSINESS_PROJECTION_RECEIPT_BINDING"),
  );
});

test("a paused V2 Work Order may retain an effect-scoped cleanup hold", () => {
  const fixture = startFixture({
    sourceId: `CMD-${"6".repeat(32)}`,
    suffix: "paused-cleanup-hold",
    effectVersion: 2,
  });
  let projection = projectBatches([fixture.batch]);
  const sent = claimAndSendBatch(fixture, fixture.effect, {
    sourceId: "INT-paused-cleanup-send",
    occurredAt: "2026-08-09T00:00:00.100Z",
    prior: 1,
  });
  projection = projectBatches([sent.batch], projection);
  const observedAt = "2026-08-09T00:00:00.200Z";
  const sourceId = `OBS-${"6".repeat(32)}`;
  const held = providerSettlementBatch({ fixture }, {
    sourceId,
    occurredAt: observedAt,
    prior: 1,
    effect: fixture.effect,
    lease: sent.lease,
    classification: "delivery_unknown",
    extraEvents: [{
      type: "business.branch.status_changed",
      specific: {
        branch_ref: "branch:solo",
        from: "dispatch_pending",
        to: "delivery_unknown",
        reason: "cleanup_hold",
      },
    }, {
      type: "business.attention.opened",
      specific: attentionSpecific(
        "delivery_unknown",
        observedAt,
        "paused-cleanup-hold",
        fixture.effect.effect_id,
      ),
    }, {
      type: "business.work_order.status_changed",
      specific: { from: "starting", to: "paused", reason: "cleanup_hold" },
    }],
  });

  const paused = projectBatches([held], projection);
  assert.equal(paused.work_orders[WORK_ORDER_ID].status, "paused");
  assert.equal(
    paused.work_orders[WORK_ORDER_ID].branches["branch:solo"].state,
    "delivery_unknown",
  );
  assert.equal(paused.outbox[fixture.effect.effect_id].status, "delivery_unknown");
  assert.equal(
    paused.work_orders[WORK_ORDER_ID].attention["attention:paused-cleanup-hold"].effect_id,
    fixture.effect.effect_id,
  );
});

test("an accepted V2 thread may fail without a turn only after the immutable deadline", () => {
  const fixture = startFixture({
    sourceId: `CMD-${"5".repeat(32)}`,
    suffix: "late-thread",
    effectVersion: 2,
  });
  let projection = projectBatches([fixture.batch]);
  const claimed = claimAndSendBatch(fixture, fixture.effect, {
    sourceId: "INT-late-thread-send",
    occurredAt: "2026-08-09T00:00:30.100Z",
    prior: 1,
  });
  projection = projectBatches([claimed.batch], projection);
  const sourceId = `OBS-${"c".repeat(32)}`;
  const runtimeIdentity = {
    operation_id: "operation:late-thread",
    thread_id: "thread:late-thread",
    turn_id: null,
  };
  const makeFailure = (occurredAt) => {
    const payload = {
      effect_id: fixture.effect.effect_id,
      effect_contract_version: 2,
      effect_kind: fixture.effect.effect_kind,
      branch_ref: "branch:solo",
      attempt: 1,
      dispatch_id: fixture.effect.dispatch_id,
      classification: "accepted",
    };
    return inputBatch(fixture.plan, {
      batchId: `business:${sourceId}`,
      sourceId,
      sourceType: "observation",
      prior: 1,
      target: 2,
      occurredAt,
      events: [{
        type: "business.outbox.delivered",
        specific: {
          effect_id: fixture.effect.effect_id,
          effect: effectIdentity(fixture.effect),
          fencing_token: {
            lease_id: claimed.lease.lease_id,
            owner_id: claimed.lease.owner_id,
            generation: claimed.lease.generation,
          },
          delivery: {
            classification: "accepted",
            evidence_refs: ["evidence:late-thread"],
            runtime_identity: runtimeIdentity,
            recorded_at: occurredAt,
          },
        },
      }, {
        type: "business.branch.runtime_observed",
        specific: {
          observation: observationFixture(fixture, {
            sourceId,
            revision: 1,
            name: "provider.effect.delivery.recorded",
            payload,
          }),
          runtime_identity: runtimeIdentity,
          delivery_effect_id: fixture.effect.effect_id,
          effect_kind: fixture.effect.effect_kind,
        },
      }, {
        type: "business.branch.status_changed",
        specific: {
          branch_ref: "branch:solo",
          from: "dispatch_pending",
          to: "failed",
          reason: "accepted_thread_missed_turn_deadline",
        },
      }, {
        type: "business.work_order.status_changed",
        specific: { from: "starting", to: "failed", reason: "turn_deadline_elapsed" },
      }],
    });
  };
  assert.throws(
    () => projectBatches([makeFailure("2026-08-09T00:00:59.999Z")], projection),
    expectCode("BUSINESS_PROJECTION_TRANSITION"),
  );
  const failed = projectBatches([makeFailure(ATTEMPT_DEADLINE)], projection);
  assert.equal(failed.work_orders[WORK_ORDER_ID].status, "failed");
  assert.equal(failed.work_orders[WORK_ORDER_ID].branches["branch:solo"].state, "failed");
});

test("a new V2 attempt cannot hide an unresolved mutation from its predecessor", () => {
  const fixture = startFixture({
    sourceId: `CMD-${"0".repeat(32)}`,
    suffix: "stale-v2-attempt",
    effectVersion: 2,
  });
  const hostile = structuredClone(projectBatches([fixture.batch]));
  const workOrder = hostile.work_orders[WORK_ORDER_ID];
  const branch = workOrder.branches["branch:solo"];
  hostile.outbox[fixture.effect.effect_id] = {
    ...hostile.outbox[fixture.effect.effect_id],
    status: "delivery_unknown",
    delivery: {
      classification: "delivery_unknown",
      evidence_refs: ["evidence:stale-attempt-one"],
      runtime_identity: null,
      recorded_at: "2026-08-09T00:00:00.100Z",
    },
    updated_at: "2026-08-09T00:00:00.100Z",
  };
  branch.state = "delivery_unknown";
  branch.cancel_effect_id = `FX-${"f".repeat(32)}`;
  branch.delivery = {
    classification: "delivery_unknown",
    observed_at: "2026-08-09T00:00:00.100Z",
  };
  workOrder.attention["attention:stale-attempt-one"] = {
    ...attentionSpecific(
      "delivery_unknown",
      "2026-08-09T00:00:00.100Z",
      "stale-attempt-one",
    ).attention,
    effect_id: fixture.effect.effect_id,
    status: "open",
    resolution: null,
  };
  const sourceId = `CMD-${"1".repeat(32)}`;
  const occurredAt = "2026-08-09T00:00:00.200Z";
  const packet = ref("packet:stale-v2-attempt-two");
  const dispatchId = `DSP-${"5".repeat(32)}`;
  const nextEffect = v2Effect({
    attempt: 2,
    dispatchId,
    packet,
    originSourceId: sourceId,
    createdAt: occurredAt,
  });
  const attack = inputBatch(fixture.plan, {
    batchId: `business:${sourceId}`,
    sourceId,
    sourceType: "command",
    prior: 1,
    target: 2,
    occurredAt,
    events: [{
      type: "business.branch.status_changed",
      specific: {
        branch_ref: "branch:solo",
        from: "delivery_unknown",
        to: "retryable",
        reason: "forged_reconciliation",
        retry_at: "2026-08-09T00:00:00.300Z",
      },
    }, {
      type: "business.branch.attempt_opened",
      specific: {
        branch_ref: "branch:solo",
        attempt: 2,
        dispatch_id: dispatchId,
        attempt_started_at: occurredAt,
        attempt_deadline_at: "2026-08-09T00:01:00.200Z",
        retry_at: null,
        packet_ref: packet,
        packet_hash: packet.hash,
      },
    }, {
      type: "business.outbox.enqueued",
      specific: { effect: nextEffect },
    }],
  });
  assert.throws(
    () => projectBatches([attack], hostile),
    expectCode("BUSINESS_PROJECTION_TRANSITION"),
  );
});

test("explicit Effect generations accept a same-millisecond not-sent successor", () => {
  const current = notSentV2InputFixture({ sameMillisecond: true });
  const sourceId = "CMD-same-ms-generation-successor";
  const successor = inputGenerationBatch(current, {
    sourceId,
    occurredAt: current.inputEffect.created_at,
    prior: 6,
    operationGeneration: 2,
    generationPredecessorEffectId: current.inputEffect.effect_id,
    packet: ref("packet:same-millisecond-successor"),
  });
  const projected = projectBatches([successor.batch], current.projection);
  assert.equal(successor.effect.created_at, current.inputEffect.created_at);
  assert.equal(successor.effect.operation_scope_hash, current.inputEffect.operation_scope_hash);
  assert.equal(successor.effect.operation_generation, 2);
  assert.equal(
    successor.effect.generation_predecessor_effect_id,
    current.inputEffect.effect_id,
  );
  assert.equal(projected.outbox[successor.effect.effect_id].status, "pending");
});

test("Effect generation lineage rejects orphan, gap, fork, and semantic-scope forgery", () => {
  const current = notSentV2InputFixture();
  const attacks = [
    inputGenerationBatch(current, {
      sourceId: `CMD-${"d".repeat(32)}`,
      occurredAt: "2026-08-09T00:00:00.900Z",
      prior: 6,
      operationGeneration: 2,
      generationPredecessorEffectId: `FX-${"f".repeat(32)}`,
    }),
    inputGenerationBatch(current, {
      sourceId: `CMD-${"e".repeat(32)}`,
      occurredAt: "2026-08-09T00:00:00.900Z",
      prior: 6,
      operationGeneration: 3,
      generationPredecessorEffectId: current.inputEffect.effect_id,
    }),
  ];
  for (const attack of attacks) {
    assert.throws(
      () => projectBatches([attack.batch], current.projection),
      expectCode("BUSINESS_PROJECTION_OUTBOX_BINDING"),
    );
  }

  const forgedScope = inputGenerationBatch(current, {
    sourceId: `CMD-${"f".repeat(32)}`,
    occurredAt: "2026-08-09T00:00:00.900Z",
    prior: 6,
    operationGeneration: 2,
    generationPredecessorEffectId: current.inputEffect.effect_id,
    operationScopeHash: "f".repeat(64),
  });
  assert.throws(
    () => projectBatches([forgedScope.batch], current.projection),
    expectCode("BUSINESS_PROJECTION_PLAN_BINDING"),
  );

  const valid = inputGenerationBatch(current, {
    sourceId: `CMD-${"1".repeat(32)}`,
    occurredAt: "2026-08-09T00:00:00.900Z",
    prior: 6,
    operationGeneration: 2,
    generationPredecessorEffectId: current.inputEffect.effect_id,
  });
  let projection = projectBatches([valid.batch], current.projection);
  const claim = claimAndSendBatch(current.fixture, valid.effect, {
    sourceId: "INT-v2-input-lineage-successor-claim",
    occurredAt: "2026-08-09T00:00:01.000Z",
    prior: 7,
    send: false,
  });
  projection = projectBatches([claim.batch], projection);
  const settled = providerSettlementBatch(current, {
    sourceId: `OBS-${"2".repeat(32)}`,
    occurredAt: "2026-08-09T00:00:01.100Z",
    prior: 7,
    effect: valid.effect,
    lease: claim.lease,
    classification: "not_sent",
  });
  projection = projectBatches([settled], projection);
  const fork = inputGenerationBatch(current, {
    sourceId: `CMD-${"3".repeat(32)}`,
    occurredAt: "2026-08-09T00:00:01.200Z",
    prior: 8,
    operationGeneration: 2,
    generationPredecessorEffectId: current.inputEffect.effect_id,
    packet: ref("packet:forked-successor"),
  });
  assert.throws(
    () => projectBatches([fork.batch], projection),
    expectCode("BUSINESS_PROJECTION_RECEIPT_BINDING"),
  );
});

test("V2 cancellation records one active marker and rejects markerless or premature closure", () => {
  const running = acceptedV2TurnFixture();
  const runningBranch = running.projection.work_orders[WORK_ORDER_ID].branches["branch:solo"];
  assert.equal(runningBranch.state, "running");
  assert.equal(runningBranch.turn_start_effect_id, running.turnEffect.effect_id);

  const rawSource = "CMD-v2-markerless-cancel";
  const rawCancel = inputBatch(running.fixture.plan, {
    batchId: `business:${rawSource}`,
    sourceId: rawSource,
    sourceType: "command",
    prior: 3,
    target: 4,
    occurredAt: "2026-08-09T00:00:00.500Z",
    events: [{
      type: "business.work_order.status_changed",
      specific: { from: "running", to: "cancelling", reason: "markerless_cancel" },
    }, {
      type: "business.branch.status_changed",
      specific: {
        branch_ref: "branch:solo",
        from: "running",
        to: "cancelling",
        reason: "markerless_cancel",
      },
    }],
  });
  assert.throws(
    () => projectBatches([rawCancel], running.projection),
    expectCode("BUSINESS_PROJECTION_RECEIPT_BINDING"),
  );

  const cancelling = enqueueV2CancelFixture(running);
  const cancellingBranch = cancelling.projection.work_orders[WORK_ORDER_ID]
    .branches["branch:solo"];
  assert.equal(cancellingBranch.cancel_effect_id, cancelling.cancelEffect.effect_id);
  const forgedCancelScope = structuredClone(cancelling.cancelBatch);
  forgedCancelScope.events[2].payload.effect = v2Effect({
    dispatchId: running.turnEffect.dispatch_id,
    effectKind: "provider.turn.cancel",
    packet: ref(`packet:${`CMD-${"6".repeat(32)}`}`),
    predecessorEffectId: running.turnEffect.effect_id,
    predecessorDeliveryHash: running.turnHash,
    targetRuntimeIdentity: running.runtimeIdentity,
    originSourceId: `CMD-${"6".repeat(32)}`,
    operationScopeHash: "f".repeat(64),
    createdAt: "2026-08-09T00:00:00.500Z",
  });
  assert.throws(
    () => projectBatches([forgedCancelScope], running.projection),
    expectCode("BUSINESS_PROJECTION_PLAN_BINDING"),
  );
  const duplicateSource = `CMD-${"9".repeat(32)}`;
  const duplicatePacket = ref("packet:duplicate-cancel");
  const duplicateEffect = v2Effect({
    dispatchId: cancelling.turnEffect.dispatch_id,
    effectKind: "provider.turn.cancel",
    packet: duplicatePacket,
    predecessorEffectId: cancelling.turnEffect.effect_id,
    predecessorDeliveryHash: cancelling.turnHash,
    targetRuntimeIdentity: cancelling.runtimeIdentity,
    originSourceId: duplicateSource,
    createdAt: "2026-08-09T00:00:00.600Z",
  });
  const duplicate = inputBatch(cancelling.fixture.plan, {
    batchId: `business:${duplicateSource}`,
    sourceId: duplicateSource,
    sourceType: "command",
    prior: 4,
    target: 5,
    occurredAt: "2026-08-09T00:00:00.600Z",
    events: [{ type: "business.outbox.enqueued", specific: { effect: duplicateEffect } }],
  });
  assert.throws(
    () => projectBatches([duplicate], cancelling.projection),
    expectCode("BUSINESS_PROJECTION_TRANSITION"),
  );

  const premature = inputBatch(cancelling.fixture.plan, {
    batchId: "business:OBS-v2-premature-terminal",
    sourceId: "OBS-v2-premature-terminal",
    sourceType: "observation",
    prior: 4,
    target: 5,
    occurredAt: "2026-08-09T00:00:00.600Z",
    events: [{
      type: "business.branch.status_changed",
      specific: {
        branch_ref: "branch:solo",
        from: "cancelling",
        to: "cancelled",
        reason: "raw_terminal_before_provider",
      },
    }, {
      type: "business.work_order.status_changed",
      specific: { from: "cancelling", to: "cancelled", reason: "raw_terminal" },
    }],
  });
  assert.throws(
    () => projectBatches([premature], cancelling.projection),
    expectCode("BUSINESS_PROJECTION_RECEIPT_BINDING"),
  );
});

test("V2 cancel markers survive ambiguous or accepted delivery and clear on definitive closure", () => {
  const acceptedBase = enqueueV2CancelFixture(acceptedV2TurnFixture());
  const acceptedClaim = claimAndSendBatch(acceptedBase.fixture, acceptedBase.cancelEffect, {
    sourceId: "INT-v2-cancel-accepted-send",
    occurredAt: "2026-08-09T00:00:00.600Z",
    prior: 4,
  });
  let acceptedProjection = projectBatches([acceptedClaim.batch], acceptedBase.projection);
  const acceptedBatch = providerSettlementBatch(acceptedBase, {
    sourceId: `OBS-${"a".repeat(32)}`,
    occurredAt: "2026-08-09T00:00:00.700Z",
    prior: 4,
    effect: acceptedBase.cancelEffect,
    lease: acceptedClaim.lease,
    classification: "accepted",
    runtimeIdentity: acceptedBase.runtimeIdentity,
  });
  acceptedProjection = projectBatches([acceptedBatch], acceptedProjection);
  assert.equal(
    acceptedProjection.work_orders[WORK_ORDER_ID].branches["branch:solo"].cancel_effect_id,
    acceptedBase.cancelEffect.effect_id,
  );
  const cancelledSource = `OBS-${"b".repeat(32)}`;
  const cancelledPayload = {
    branch_ref: "branch:solo",
    attempt: 1,
    reason: "provider confirmed quiescence",
  };
  const providerCancelled = inputBatch(acceptedBase.fixture.plan, {
    batchId: `business:${cancelledSource}`,
    sourceId: cancelledSource,
    sourceType: "observation",
    prior: 5,
    target: 6,
    occurredAt: "2026-08-09T00:00:00.800Z",
    events: [{
      type: "business.branch.runtime_observed",
      specific: {
        observation: observationFixture(acceptedBase.fixture, {
          sourceId: cancelledSource,
          revision: 5,
          name: "branch.cancelled",
          payload: cancelledPayload,
        }),
        runtime_identity: acceptedBase.runtimeIdentity,
      },
    }, {
      type: "business.branch.status_changed",
      specific: {
        branch_ref: "branch:solo",
        from: "cancelling",
        to: "cancelled",
        reason: "provider_confirmed_quiescence",
      },
    }],
  });
  const quiescent = projectBatches([providerCancelled], acceptedProjection);
  assert.equal(
    quiescent.work_orders[WORK_ORDER_ID].branches["branch:solo"].cancel_effect_id,
    null,
  );

  const unknownBase = enqueueV2CancelFixture(acceptedV2TurnFixture());
  const unknownClaim = claimAndSendBatch(unknownBase.fixture, unknownBase.cancelEffect, {
    sourceId: "INT-v2-cancel-unknown-send",
    occurredAt: "2026-08-09T00:00:00.600Z",
    prior: 4,
  });
  let unknownProjection = projectBatches([unknownClaim.batch], unknownBase.projection);
  const unknownAt = "2026-08-09T00:00:00.700Z";
  const unknownBatch = providerSettlementBatch(unknownBase, {
    sourceId: `OBS-${"0".repeat(32)}`,
    occurredAt: unknownAt,
    prior: 4,
    effect: unknownBase.cancelEffect,
    lease: unknownClaim.lease,
    classification: "delivery_unknown",
    extraEvents: [{
      type: "business.attention.opened",
      specific: attentionSpecific(
        "delivery_unknown",
        unknownAt,
        "v2-cancel-unknown",
        unknownBase.cancelEffect.effect_id,
      ),
    }],
  });
  unknownProjection = projectBatches([unknownBatch], unknownProjection);
  assert.equal(
    unknownProjection.work_orders[WORK_ORDER_ID].branches["branch:solo"].cancel_effect_id,
    unknownBase.cancelEffect.effect_id,
  );

  const notSentBase = enqueueV2CancelFixture(acceptedV2TurnFixture());
  const notSentClaim = claimAndSendBatch(notSentBase.fixture, notSentBase.cancelEffect, {
    sourceId: "INT-v2-cancel-not-sent-claim",
    occurredAt: "2026-08-09T00:00:00.600Z",
    prior: 4,
    send: false,
  });
  let notSentProjection = projectBatches([notSentClaim.batch], notSentBase.projection);
  const notSentAt = "2026-08-09T00:00:00.700Z";
  const notSentBatch = providerSettlementBatch(notSentBase, {
    sourceId: `OBS-${"f".repeat(32)}`,
    occurredAt: notSentAt,
    prior: 4,
    effect: notSentBase.cancelEffect,
    lease: notSentClaim.lease,
    classification: "not_sent",
    extraEvents: [{
      type: "business.attention.opened",
      specific: attentionSpecific("cancel_not_sent", notSentAt, "v2-cancel-not-sent"),
    }],
  });
  notSentProjection = projectBatches([notSentBatch], notSentProjection);
  assert.equal(
    notSentProjection.work_orders[WORK_ORDER_ID].branches["branch:solo"].cancel_effect_id,
    null,
  );

  const localBase = enqueueV2CancelFixture(acceptedV2TurnFixture());
  const localAt = "2026-08-09T00:00:00.600Z";
  const localBatch = inputBatch(localBase.fixture.plan, {
    batchId: "business:CMD-v2-cancel-local",
    sourceId: "CMD-v2-cancel-local",
    sourceType: "command",
    prior: 4,
    target: 5,
    occurredAt: localAt,
    events: [{
      type: "business.outbox.cancelled",
      specific: {
        effect_id: localBase.cancelEffect.effect_id,
        effect: effectIdentity(localBase.cancelEffect),
        reason: "cancel_not_sent_locally",
      },
    }, {
      type: "business.attention.opened",
      specific: attentionSpecific("cancel_not_sent", localAt, "v2-cancel-local"),
    }],
  });
  const localProjection = projectBatches([localBatch], localBase.projection);
  assert.equal(
    localProjection.work_orders[WORK_ORDER_ID].branches["branch:solo"].cancel_effect_id,
    null,
  );
});

test("V2 recovery attention is exact and bidirectional for an ambiguous effect", () => {
  const fixture = startFixture({
    sourceId: `CMD-${"9".repeat(32)}`,
    suffix: "attention-iff",
    effectVersion: 2,
  });
  const started = projectBatches([fixture.batch]);
  const prematureAt = "2026-08-09T00:00:00.050Z";
  const premature = inputBatch(fixture.plan, {
    batchId: "business:CMD-attention-before-send",
    sourceId: "CMD-attention-before-send",
    sourceType: "command",
    prior: 1,
    target: 2,
    occurredAt: prematureAt,
    events: [{
      type: "business.attention.opened",
      specific: attentionSpecific(
        "timeout_requires_reconciliation",
        prematureAt,
        "before-send",
        fixture.effect.effect_id,
      ),
    }],
  });
  assert.throws(
    () => projectBatches([premature], started),
    expectCode("BUSINESS_PROJECTION_RECEIPT_BINDING"),
  );

  const send = claimAndSendBatch(fixture, fixture.effect, {
    sourceId: "INT-attention-iff-send",
    occurredAt: "2026-08-09T00:00:00.100Z",
    prior: 1,
  });
  const sending = projectBatches([send.batch], started);
  const recovery = (sourceId, includeAttention) => {
    const occurredAt = "2026-08-09T00:00:00.200Z";
    const events = [{
      type: "business.work_order.status_changed",
      specific: { from: "starting", to: "cancelling", reason: "start_send_ambiguous" },
    }, {
      type: "business.branch.status_changed",
      specific: {
        branch_ref: "branch:solo",
        from: "dispatch_pending",
        to: "delivery_unknown",
        reason: "start_send_ambiguous",
      },
    }];
    if (includeAttention) {
      events.push({
        type: "business.attention.opened",
        specific: attentionSpecific(
          "timeout_requires_reconciliation",
          occurredAt,
          "exact-sending-effect",
          fixture.effect.effect_id,
        ),
      });
    }
    return inputBatch(fixture.plan, {
      batchId: `business:${sourceId}`,
      sourceId,
      sourceType: "command",
      prior: 1,
      target: 2,
      occurredAt,
      events,
    });
  };
  assert.throws(
    () => projectBatches([recovery("CMD-attention-iff-missing", false)], sending),
    expectCode("BUSINESS_PROJECTION_RECEIPT_BINDING"),
  );
  const reconciled = projectBatches([
    recovery("CMD-attention-iff-exact", true),
  ], sending);
  assert.equal(
    reconciled.work_orders[WORK_ORDER_ID]
      .attention["attention:exact-sending-effect"].effect_id,
    fixture.effect.effect_id,
  );
  assert.equal(reconciled.outbox[fixture.effect.effect_id].status, "sending");
});

test("delivery reconciliation attention is scoped to the exact V2 effect", () => {
  const current = pendingV2InputFixture();
  const inputClaim = claimAndSendBatch(current.fixture, current.inputEffect, {
    sourceId: "INT-effect-scoped-input-send",
    occurredAt: "2026-08-09T00:00:00.650Z",
    prior: 5,
  });
  let projection = projectBatches([inputClaim.batch], current.projection);
  const attentionId = "attention:effect-scoped-input";
  const inputUnknownAt = "2026-08-09T00:00:00.700Z";
  const inputUnknown = providerSettlementBatch(current, {
    sourceId: `OBS-${"3".repeat(32)}`,
    occurredAt: inputUnknownAt,
    prior: 5,
    effect: current.inputEffect,
    lease: inputClaim.lease,
    classification: "delivery_unknown",
    extraEvents: [{
      type: "business.attention.opened",
      specific: {
        attention: {
          ...attentionSpecific(
            "delivery_unknown",
            inputUnknownAt,
            "effect-scoped-input",
            current.inputEffect.effect_id,
          ).attention,
          attention_id: attentionId,
        },
      },
    }],
  });
  projection = projectBatches([inputUnknown], projection);
  assert.equal(
    projection.work_orders[WORK_ORDER_ID].attention[attentionId].effect_id,
    current.inputEffect.effect_id,
  );

  const cancelSource = `CMD-${"3".repeat(32)}`;
  const cancelAt = "2026-08-09T00:00:00.750Z";
  const cancelPacket = ref("packet:effect-scoped-cancel");
  const cancelEffect = v2Effect({
    dispatchId: current.turnEffect.dispatch_id,
    effectKind: "provider.turn.cancel",
    packet: cancelPacket,
    predecessorEffectId: current.turnEffect.effect_id,
    predecessorDeliveryHash: current.turnHash,
    targetRuntimeIdentity: current.runtimeIdentity,
    originSourceId: cancelSource,
    createdAt: cancelAt,
  });
  const cancel = inputBatch(current.fixture.plan, {
    batchId: `business:${cancelSource}`,
    sourceId: cancelSource,
    sourceType: "command",
    prior: 6,
    target: 7,
    occurredAt: cancelAt,
    events: [{
      type: "business.work_order.status_changed",
      specific: { from: "running", to: "cancelling", reason: "effect_scoped_cancel" },
    }, {
      type: "business.branch.status_changed",
      specific: {
        branch_ref: "branch:solo",
        from: "waiting_for_user",
        to: "cancelling",
        reason: "effect_scoped_cancel",
      },
    }, {
      type: "business.outbox.enqueued",
      specific: { effect: cancelEffect },
    }],
  });
  projection = projectBatches([cancel], projection);
  const cancelClaim = claimAndSendBatch(current.fixture, cancelEffect, {
    sourceId: "INT-effect-scoped-cancel-send",
    occurredAt: "2026-08-09T00:00:00.800Z",
    prior: 7,
  });
  const cancelSending = projectBatches([cancelClaim.batch], projection);
  const acceptedAt = "2026-08-09T00:00:00.850Z";
  const goodAccepted = providerSettlementBatch(current, {
    sourceId: `OBS-${"4".repeat(32)}`,
    occurredAt: acceptedAt,
    prior: 7,
    effect: cancelEffect,
    lease: cancelClaim.lease,
    classification: "accepted",
    runtimeIdentity: current.runtimeIdentity,
  });
  const stillReconciling = projectBatches([goodAccepted], cancelSending);
  assert.equal(
    stillReconciling.work_orders[WORK_ORDER_ID].attention[attentionId].status,
    "open",
  );

  const wronglyResolved = providerSettlementBatch(current, {
    sourceId: `OBS-${"5".repeat(32)}`,
    occurredAt: acceptedAt,
    prior: 7,
    effect: cancelEffect,
    lease: cancelClaim.lease,
    classification: "accepted",
    runtimeIdentity: current.runtimeIdentity,
    extraEvents: [{
      type: "business.attention.resolved",
      specific: {
        attention_id: attentionId,
        resolution_ref: ref("resolution:wrong-cancel-effect"),
        evidence_refs: ["evidence:wrong-cancel-effect"],
      },
    }],
  });
  assert.throws(
    () => projectBatches([wronglyResolved], cancelSending),
    expectCode("BUSINESS_PROJECTION_RECEIPT_BINDING"),
  );
});

test("cancelling prompt closure distinguishes unsent, in-flight, and terminal input", () => {
  const pending = pendingV2InputFixture();
  const rawAt = "2026-08-09T00:00:00.700Z";
  const rawCancel = inputBatch(pending.fixture.plan, {
    batchId: "business:CMD-pending-input-raw-cancel",
    sourceId: "CMD-pending-input-raw-cancel",
    sourceType: "command",
    prior: 5,
    target: 6,
    occurredAt: rawAt,
    events: [{
      type: "business.work_order.status_changed",
      specific: { from: "running", to: "cancelling", reason: "raw_input_cancel" },
    }, {
      type: "business.branch.status_changed",
      specific: {
        branch_ref: "branch:solo",
        from: "waiting_for_user",
        to: "cancelling",
        reason: "raw_input_cancel",
      },
    }, {
      type: "business.attention.opened",
      specific: attentionSpecific(
        "cancel_requires_dispatch_reconciliation",
        rawAt,
        "pending-input-raw-cancel",
      ),
    }],
  });
  assert.throws(
    () => projectBatches([rawCancel], pending.projection),
    expectCode("BUSINESS_PROJECTION_RECEIPT_BINDING"),
  );

  const settledCancel = inputBatch(pending.fixture.plan, {
    batchId: "business:CMD-pending-input-settled-cancel",
    sourceId: "CMD-pending-input-settled-cancel",
    sourceType: "command",
    prior: 5,
    target: 6,
    occurredAt: rawAt,
    events: [{
      type: "business.outbox.cancelled",
      specific: {
        effect_id: pending.inputEffect.effect_id,
        effect: effectIdentity(pending.inputEffect),
        reason: "input_not_sent_before_cancel",
      },
    }, {
      type: "business.work_order.status_changed",
      specific: { from: "running", to: "cancelling", reason: "settled_input_cancel" },
    }, {
      type: "business.branch.status_changed",
      specific: {
        branch_ref: "branch:solo",
        from: "waiting_for_user",
        to: "cancelling",
        reason: "settled_input_cancel",
      },
    }, {
      type: "business.attention.opened",
      specific: attentionSpecific(
        "cancel_requires_runtime_identity",
        rawAt,
        "pending-input-settled-cancel",
      ),
    }],
  });
  const settled = projectBatches([settledCancel], pending.projection);
  const settledBranch = settled.work_orders[WORK_ORDER_ID].branches["branch:solo"];
  assert.equal(settledBranch.open_user_input, null);
  assert.equal(settledBranch.pending_user_input_effect_id, null);

  const notSent = pendingV2InputFixture();
  const inputClaim = claimAndSendBatch(notSent.fixture, notSent.inputEffect, {
    sourceId: "INT-v2-input-not-sent-claim",
    occurredAt: "2026-08-09T00:00:00.700Z",
    prior: 5,
    send: false,
  });
  let notSentProjection = projectBatches([inputClaim.batch], notSent.projection);
  const notSentAt = "2026-08-09T00:00:00.800Z";
  const inputNotSent = providerSettlementBatch(notSent, {
    sourceId: `OBS-${"9".repeat(32)}`,
    occurredAt: notSentAt,
    prior: 5,
    effect: notSent.inputEffect,
    lease: inputClaim.lease,
    classification: "not_sent",
  });
  notSentProjection = projectBatches([inputNotSent], notSentProjection);
  const waitingAfterNotSent = notSentProjection.work_orders[WORK_ORDER_ID]
    .branches["branch:solo"];
  assert.ok(waitingAfterNotSent.open_user_input);
  assert.equal(waitingAfterNotSent.pending_user_input_effect_id, null);
  const raceAt = "2026-08-09T00:00:00.900Z";
  const raceCancel = inputBatch(notSent.fixture.plan, {
    batchId: "business:CMD-not-sent-input-cancel",
    sourceId: "CMD-not-sent-input-cancel",
    sourceType: "command",
    prior: 6,
    target: 7,
    occurredAt: raceAt,
    events: [{
      type: "business.work_order.status_changed",
      specific: { from: "running", to: "cancelling", reason: "cancel_after_not_sent" },
    }, {
      type: "business.branch.status_changed",
      specific: {
        branch_ref: "branch:solo",
        from: "waiting_for_user",
        to: "cancelling",
        reason: "cancel_after_not_sent",
      },
    }, {
      type: "business.attention.opened",
      specific: attentionSpecific(
        "cancel_requires_runtime_identity",
        raceAt,
        "cancel-after-not-sent",
      ),
    }],
  });
  const afterRace = projectBatches([raceCancel], notSentProjection);
  assert.equal(
    afterRace.work_orders[WORK_ORDER_ID].branches["branch:solo"].open_user_input,
    null,
  );

  const sending = pendingV2InputFixture();
  const inputSend = claimAndSendBatch(sending.fixture, sending.inputEffect, {
    sourceId: "INT-v2-input-send-before-cancel",
    occurredAt: "2026-08-09T00:00:00.700Z",
    prior: 5,
  });
  const sendingProjection = projectBatches([inputSend.batch], sending.projection);
  const sendCancelSource = `CMD-${"a".repeat(32)}`;
  const sendCancelAt = "2026-08-09T00:00:00.800Z";
  const cancelPacket = ref("packet:cancel-with-input-in-flight");
  const cancelEffect = v2Effect({
    dispatchId: sending.turnEffect.dispatch_id,
    effectKind: "provider.turn.cancel",
    packet: cancelPacket,
    predecessorEffectId: sending.turnEffect.effect_id,
    predecessorDeliveryHash: sending.turnHash,
    targetRuntimeIdentity: sending.runtimeIdentity,
    originSourceId: sendCancelSource,
    createdAt: sendCancelAt,
  });
  const sendCancel = inputBatch(sending.fixture.plan, {
    batchId: `business:${sendCancelSource}`,
    sourceId: sendCancelSource,
    sourceType: "command",
    prior: 5,
    target: 6,
    occurredAt: sendCancelAt,
    events: [{
      type: "business.work_order.status_changed",
      specific: { from: "running", to: "cancelling", reason: "input_in_flight" },
    }, {
      type: "business.branch.status_changed",
      specific: {
        branch_ref: "branch:solo",
        from: "waiting_for_user",
        to: "cancelling",
        reason: "input_in_flight",
      },
    }, {
      type: "business.outbox.enqueued",
      specific: { effect: cancelEffect },
    }],
  });
  const inFlight = projectBatches([sendCancel], sendingProjection);
  const inFlightBranch = inFlight.work_orders[WORK_ORDER_ID].branches["branch:solo"];
  assert.ok(inFlightBranch.open_user_input);
  assert.equal(inFlightBranch.pending_user_input_effect_id, sending.inputEffect.effect_id);
  assert.equal(inFlight.outbox[sending.inputEffect.effect_id].status, "sending");

  const terminalBase = enqueueV2CancelFixture(acceptedV2TurnFixture());
  const forgedTerminal = structuredClone(terminalBase.projection);
  const forgedBranch = forgedTerminal.work_orders[WORK_ORDER_ID].branches["branch:solo"];
  forgedBranch.open_user_input = {
    request_id: `REQ-${"f".repeat(32)}`,
    prompt_ref: ref("prompt:must-not-survive-terminal"),
    requested_at: "2026-08-09T00:00:00.550Z",
  };
  forgedTerminal.outbox[terminalBase.cancelEffect.effect_id] = {
    ...forgedTerminal.outbox[terminalBase.cancelEffect.effect_id],
    status: "delivered",
    delivery: {
      classification: "accepted",
      evidence_refs: ["evidence:forged-terminal-cancel"],
      runtime_identity: terminalBase.runtimeIdentity,
      recorded_at: "2026-08-09T00:00:00.600Z",
    },
    updated_at: "2026-08-09T00:00:00.600Z",
  };
  const terminalAttack = inputBatch(terminalBase.fixture.plan, {
    batchId: "business:OBS-terminal-open-prompt",
    sourceId: "OBS-terminal-open-prompt",
    sourceType: "observation",
    prior: 4,
    target: 5,
    occurredAt: "2026-08-09T00:00:00.700Z",
    events: [{
      type: "business.branch.status_changed",
      specific: {
        branch_ref: "branch:solo",
        from: "cancelling",
        to: "cancelled",
        reason: "raw_terminal_with_prompt",
      },
    }],
  });
  assert.throws(
    () => projectBatches([terminalAttack], forgedTerminal),
    expectCode("BUSINESS_PROJECTION_RECEIPT_BINDING"),
  );
});

test("terminal Work Orders are monotonic and later facts must use quarantine", () => {
  const fixture = startFixture({
    sourceId: `CMD-${"6".repeat(32)}`,
    suffix: "terminal-v2",
    effectVersion: 2,
  });
  const started = projectBatches([fixture.batch]);
  const stranded = inputBatch(fixture.plan, {
    batchId: "business:CMD-stranded-terminal",
    sourceId: "CMD-stranded-terminal",
    sourceType: "command",
    prior: 1,
    target: 2,
    occurredAt: "2026-08-09T00:00:04.000Z",
    events: [{
      type: "business.work_order.status_changed",
      specific: { from: "starting", to: "failed", reason: "unsafe_global_failure" },
    }],
  });
  assert.throws(
    () => projectBatches([stranded], started),
    expectCode("BUSINESS_PROJECTION_RECEIPT_BINDING"),
  );
  const failed = inputBatch(fixture.plan, {
    batchId: "business:CMD-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    sourceId: "CMD-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    sourceType: "command",
    prior: 1,
    target: 2,
    occurredAt: "2026-08-09T00:00:05.000Z",
    events: [{
      type: "business.outbox.cancelled",
      specific: {
        effect_id: fixture.effect.effect_id,
        effect: effectIdentity(fixture.effect),
        reason: "preflight_failed_before_send",
      },
    }, {
      type: "business.branch.status_changed",
      specific: {
        branch_ref: "branch:solo",
        from: "dispatch_pending",
        to: "cancelled",
        reason: "preflight_failed_before_send",
      },
    }, {
      type: "business.work_order.status_changed",
      specific: { from: "starting", to: "failed", reason: "preflight_failed" },
    }],
  });
  const terminal = projectBatches([failed], started);
  assert.equal(terminal.work_orders[WORK_ORDER_ID].status, "failed");
  assert.equal(terminal.work_orders[WORK_ORDER_ID].revision, 2);

  const reopen = businessEvent(fixture.plan, {
    eventId: "CMD-cccccccccccccccccccccccccccccccc:event:1",
    type: "business.work_order.status_changed",
    sourceId: "CMD-cccccccccccccccccccccccccccccccc",
    prior: 2,
    target: 3,
    occurredAt: "2026-08-09T00:00:06.000Z",
    specific: { from: "failed", to: "running", reason: "unsafe_reopen" },
  });
  assert.throws(
    () => projectBusinessEventV1(terminal, reopen, { batch_id: "business:unsafe-reopen" }),
    expectCode("BUSINESS_PROJECTION_TRANSITION"),
  );
  assert.equal(terminal.work_orders[WORK_ORDER_ID].revision, 2);
});

test("internal outbox receipts do not advance the public business revision", () => {
  const fixture = startFixture();
  const started = projectBatches([fixture.batch]);
  const claimed = inputBatch(fixture.plan, {
    batchId: "business:INT-dddddddddddddddddddddddddddddddd",
    sourceId: "INT-dddddddddddddddddddddddddddddddd",
    sourceType: "internal_action",
    prior: 1,
    target: 1,
    occurredAt: "2026-08-09T00:00:10.000Z",
    events: [{
      type: "business.outbox.claimed",
      specific: {
        effect_id: fixture.effect.effect_id,
        effect: effectIdentity(fixture.effect),
        lease: {
          lease_id: "lease:one",
          owner_id: "worker:one",
          generation: 1,
          claimed_at: "2026-08-09T00:00:10.000Z",
          heartbeat_at: "2026-08-09T00:00:10.000Z",
          expires_at: "2026-08-09T00:00:40.000Z",
        },
      },
    }],
  });
  const projection = projectBatches([claimed], started);
  assert.equal(projection.work_orders[WORK_ORDER_ID].revision, 1);
  assert.equal(projection.outbox[fixture.effect.effect_id].status, "claimed");
  assert.equal(
    projection.internal_receipts["INT-dddddddddddddddddddddddddddddddd"].applied_revision,
    1,
  );

  const mutated = structuredClone(claimed.events[0]);
  mutated.event_id = "INT-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee:event:1";
  mutated.payload.source_id = "INT-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  mutated.payload.effect = {
    ...effectIdentity(projection.outbox[fixture.effect.effect_id]),
    provider_ref: "provider:other",
  };
  assert.throws(
    () => projectBusinessEventV1(projection, mutated, { batch_id: "business:immutable-attack" }),
    expectCode("BUSINESS_PROJECTION_OUTBOX_IMMUTABLE"),
  );
});

test("every outbox transition is fenced to its immutable Work Order and effect identity", () => {
  const fixtureA = startFixture();
  const workOrderB = "WO-22222222222222222222222222222222";
  const fixtureB = startFixture({
    workOrderId: workOrderB,
    sourceId: "CMD-22222222222222222222222222222222",
    suffix: "two",
  });
  const projection = projectBatches([fixtureA.batch, fixtureB.batch]);
  const crossWorkOrderClaim = inputBatch(fixtureA.plan, {
    batchId: "business:INT-cross-work-order-claim",
    sourceId: "INT-cross-work-order-claim",
    sourceType: "internal_action",
    prior: 1,
    target: 1,
    occurredAt: "2026-08-09T00:00:10.000Z",
    events: [{
      type: "business.outbox.claimed",
      specific: {
        effect_id: fixtureB.effect.effect_id,
        effect: effectIdentity(fixtureB.effect),
        lease: {
          lease_id: "lease:cross-work-order",
          owner_id: "worker:cross-work-order",
          generation: 1,
          claimed_at: "2026-08-09T00:00:10.000Z",
          heartbeat_at: "2026-08-09T00:00:10.000Z",
          expires_at: "2026-08-09T00:00:40.000Z",
        },
      },
    }],
  });
  assert.throws(
    () => projectBatches([crossWorkOrderClaim], projection),
    expectCode("BUSINESS_PROJECTION_OUTBOX_BINDING"),
  );

  const mutations = {
    work_order_id: workOrderB,
    branch_ref: "branch:forged",
    attempt: 2,
    dispatch_id: "dispatch:forged",
    provider_ref: "provider:forged",
    effect_kind: "provider.turn.cancel",
  };
  for (const [index, [field, value]] of Object.entries(mutations).entries()) {
    const sourceId = `INT-effect-binding-${String(index).padStart(2, "0")}`;
    const attack = inputBatch(fixtureA.plan, {
      batchId: `business:${sourceId}`,
      sourceId,
      sourceType: "internal_action",
      prior: 1,
      target: 1,
      occurredAt: "2026-08-09T00:00:11.000Z",
      events: [{
        type: "business.outbox.claimed",
        specific: {
          effect_id: fixtureA.effect.effect_id,
          effect: { ...effectIdentity(fixtureA.effect), [field]: value },
          lease: {
            lease_id: `lease:forged:${field}`,
            owner_id: "worker:forged",
            generation: 1,
            claimed_at: "2026-08-09T00:00:11.000Z",
            heartbeat_at: "2026-08-09T00:00:11.000Z",
            expires_at: "2026-08-09T00:00:41.000Z",
          },
        },
      }],
    });
    assert.throws(
      () => projectBatches([attack], projectBatches([fixtureA.batch])),
      expectCode("BUSINESS_PROJECTION_OUTBOX_IMMUTABLE"),
      field,
    );
  }

  const extraIdentityField = inputBatch(fixtureA.plan, {
    batchId: "business:INT-effect-binding-extra",
    sourceId: "INT-effect-binding-extra",
    sourceType: "internal_action",
    prior: 1,
    target: 1,
    occurredAt: "2026-08-09T00:00:11.000Z",
    events: [{
      type: "business.outbox.claimed",
      specific: {
        effect_id: fixtureA.effect.effect_id,
        effect: { ...effectIdentity(fixtureA.effect), status: "pending" },
        lease: {
          lease_id: "lease:forged:extra",
          owner_id: "worker:forged",
          generation: 1,
          claimed_at: "2026-08-09T00:00:11.000Z",
          heartbeat_at: "2026-08-09T00:00:11.000Z",
          expires_at: "2026-08-09T00:00:41.000Z",
        },
      },
    }],
  });
  assert.throws(
    () => projectBatches([extraIdentityField], projectBatches([fixtureA.batch])),
    expectCode("BUSINESS_PROJECTION_INVALID"),
  );
});

test("outbox leases cannot send or renew after expiry or requeue before expiry", () => {
  const fixture = startFixture();
  const started = projectBatches([fixture.batch]);
  const lease = {
    lease_id: "lease:expiry",
    owner_id: "worker:expiry",
    generation: 1,
    claimed_at: "2026-08-09T00:00:10.000Z",
    heartbeat_at: "2026-08-09T00:00:10.000Z",
    expires_at: "2026-08-09T00:00:40.000Z",
  };
  const claim = inputBatch(fixture.plan, {
    batchId: "business:INT-expiry-claim",
    sourceId: "INT-expiry-claim",
    sourceType: "internal_action",
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
  });
  const oversizedClaim = inputBatch(fixture.plan, {
    batchId: "business:INT-oversized-claim",
    sourceId: "INT-oversized-claim",
    sourceType: "internal_action",
    prior: 1,
    target: 1,
    occurredAt: lease.claimed_at,
    events: [{
      type: "business.outbox.claimed",
      specific: {
        effect_id: fixture.effect.effect_id,
        effect: effectIdentity(fixture.effect),
        lease: { ...lease, expires_at: "2026-08-09T00:10:00.000Z" },
      },
    }],
  });
  assert.throws(
    () => projectBatches([oversizedClaim], started),
    expectCode("BUSINESS_PROJECTION_TRANSITION"),
  );
  const claimed = projectBatches([claim], started);
  const internalUpdate = (sourceId, occurredAt, type, specific) => inputBatch(fixture.plan, {
    batchId: `business:${sourceId}`,
    sourceId,
    sourceType: "internal_action",
    prior: 1,
    target: 1,
    occurredAt,
    events: [{
      type,
      specific: {
        effect_id: fixture.effect.effect_id,
        effect: effectIdentity(fixture.effect),
        ...specific,
      },
    }],
  });

  const expiredSend = internalUpdate(
    "INT-expired-send",
    lease.expires_at,
    "business.outbox.send_begun",
    {
      lease_id: lease.lease_id,
      lease_owner_id: lease.owner_id,
      lease_generation: lease.generation,
    },
  );
  assert.throws(
    () => projectBatches([expiredSend], claimed),
    expectCode("BUSINESS_PROJECTION_TRANSITION"),
  );

  const earlyRequeue = internalUpdate(
    "INT-early-requeue",
    "2026-08-09T00:00:39.999Z",
    "business.outbox.requeued",
    {
      lease_id: lease.lease_id,
      lease_owner_id: lease.owner_id,
      lease_generation: lease.generation,
      reason: "not_yet_expired",
    },
  );
  assert.throws(
    () => projectBatches([earlyRequeue], claimed),
    expectCode("BUSINESS_PROJECTION_TRANSITION"),
  );

  const validSend = internalUpdate(
    "INT-send-before-expiry",
    "2026-08-09T00:00:39.999Z",
    "business.outbox.send_begun",
    {
      lease_id: lease.lease_id,
      lease_owner_id: lease.owner_id,
      lease_generation: lease.generation,
    },
  );
  const sending = projectBatches([validSend], claimed);
  const expirationDelivery = (recordedAt) => ({
    classification: "delivery_unknown",
    evidence_refs: ["evidence:expired-send"],
    runtime_identity: null,
    recorded_at: recordedAt,
  });
  const earlySendExpiry = internalUpdate(
    "INT-early-send-expiry",
    "2026-08-09T00:00:39.999Z",
    "business.outbox.send_expired",
    { delivery: expirationDelivery("2026-08-09T00:00:39.999Z") },
  );
  assert.throws(
    () => projectBatches([earlySendExpiry], sending),
    expectCode("BUSINESS_PROJECTION_TRANSITION"),
  );
  const sendExpiry = internalUpdate(
    "INT-send-expired",
    lease.expires_at,
    "business.outbox.send_expired",
    { delivery: expirationDelivery(lease.expires_at) },
  );
  const legacyAmbiguous = projectBatches([sendExpiry], sending);
  assert.equal(legacyAmbiguous.outbox[fixture.effect.effect_id].status, "delivery_unknown");
  assert.equal(legacyAmbiguous.work_orders[WORK_ORDER_ID].engine_contract_version, 1);

  const expiredSettlement = inputBatch(fixture.plan, {
    batchId: "business:OBS-expired-settlement",
    sourceId: "OBS-expired-settlement",
    sourceType: "observation",
    prior: 1,
    target: 2,
    occurredAt: lease.expires_at,
    events: [{
      type: "business.outbox.not_sent",
      specific: {
        effect_id: fixture.effect.effect_id,
        effect: effectIdentity(fixture.effect),
        fencing_token: {
          lease_id: lease.lease_id,
          owner_id: lease.owner_id,
          generation: lease.generation,
        },
        delivery: {
          classification: "not_sent",
          evidence_refs: ["evidence:expired-worker"],
          runtime_identity: null,
          recorded_at: lease.expires_at,
        },
      },
    }],
  });
  assert.throws(
    () => projectBatches([expiredSettlement], claimed),
    expectCode("BUSINESS_PROJECTION_TRANSITION"),
  );

  const renewalLease = {
    ...lease,
    heartbeat_at: "2026-08-09T00:00:20.000Z",
    expires_at: "2026-08-09T00:00:50.000Z",
  };
  const renewal = internalUpdate(
    "INT-valid-renewal",
    renewalLease.heartbeat_at,
    "business.outbox.lease_renewed",
    { lease: renewalLease },
  );
  const renewed = projectBatches([renewal], claimed);
  assert.equal(renewed.outbox[fixture.effect.effect_id].lease.expires_at, renewalLease.expires_at);

  const oversizedRenewal = internalUpdate(
    "INT-oversized-renewal",
    "2026-08-09T00:00:21.000Z",
    "business.outbox.lease_renewed",
    {
      lease: {
        ...renewalLease,
        heartbeat_at: "2026-08-09T00:00:21.000Z",
        expires_at: "2026-08-09T00:10:00.000Z",
      },
    },
  );
  assert.throws(
    () => projectBatches([oversizedRenewal], renewed),
    expectCode("BUSINESS_PROJECTION_TRANSITION"),
  );

  const regressingRenewal = internalUpdate(
    "INT-regressing-renewal",
    "2026-08-09T00:00:30.000Z",
    "business.outbox.lease_renewed",
    {
      lease: {
        ...renewalLease,
        heartbeat_at: "2026-08-09T00:00:30.000Z",
        expires_at: "2026-08-09T00:00:49.000Z",
      },
    },
  );
  assert.throws(
    () => projectBatches([regressingRenewal], renewed),
    expectCode("BUSINESS_PROJECTION_TRANSITION"),
  );

  const expiredRenewal = internalUpdate(
    "INT-expired-renewal",
    renewalLease.expires_at,
    "business.outbox.lease_renewed",
    {
      lease: {
        ...renewalLease,
        heartbeat_at: renewalLease.expires_at,
        expires_at: "2026-08-09T00:01:20.000Z",
      },
    },
  );
  assert.throws(
    () => projectBatches([expiredRenewal], renewed),
    expectCode("BUSINESS_PROJECTION_TRANSITION"),
  );
});

test("worker actions recheck the current branch and immutable execution deadlines", () => {
  const fixture = startFixture();
  const started = projectBatches([fixture.batch]);
  const internalBatch = (sourceId, occurredAt, type, specific) => inputBatch(fixture.plan, {
    batchId: `business:${sourceId}`,
    sourceId,
    sourceType: "internal_action",
    prior: 1,
    target: 1,
    occurredAt,
    events: [{
      type,
      specific: {
        effect_id: fixture.effect.effect_id,
        effect: effectIdentity(fixture.effect),
        ...specific,
      },
    }],
  });
  const firstLease = {
    lease_id: "lease:deadline",
    owner_id: "worker:deadline",
    generation: 1,
    claimed_at: "2026-08-09T00:00:20.000Z",
    heartbeat_at: "2026-08-09T00:00:20.000Z",
    expires_at: "2026-08-09T00:00:50.000Z",
  };
  const claimed = projectBatches([internalBatch(
    "INT-deadline-claim",
    firstLease.claimed_at,
    "business.outbox.claimed",
    { lease: firstLease },
  )], started);
  const renewedLease = {
    ...firstLease,
    heartbeat_at: "2026-08-09T00:00:40.000Z",
    expires_at: "2026-08-09T00:01:10.000Z",
  };
  const renewed = projectBatches([internalBatch(
    "INT-deadline-renew",
    renewedLease.heartbeat_at,
    "business.outbox.lease_renewed",
    { lease: renewedLease },
  )], claimed);
  const atAttemptDeadline = ATTEMPT_DEADLINE;
  for (const [type, specific] of [
    ["business.outbox.send_begun", {
      lease_id: renewedLease.lease_id,
      lease_owner_id: renewedLease.owner_id,
      lease_generation: renewedLease.generation,
    }],
    ["business.outbox.lease_renewed", {
      lease: {
        ...renewedLease,
        heartbeat_at: atAttemptDeadline,
        expires_at: "2026-08-09T00:01:30.000Z",
      },
    }],
  ]) {
    assert.throws(
      () => projectBatches([internalBatch(
        `INT-after-deadline-${type.split(".").at(-1)}`,
        atAttemptDeadline,
        type,
        specific,
      )], renewed),
      expectCode("BUSINESS_PROJECTION_TRANSITION"),
      type,
    );
  }

  const timeoutPayload = { branch_ref: "branch:solo", attempt: 1, timeout_ms: 60_000 };
  const timeoutSource = `OBS-${"d".repeat(32)}`;
  const timeoutObservation = {
    version: 1,
    observation_id: timeoutSource,
    work_order_id: WORK_ORDER_ID,
    plan_snapshot_ref: fixture.plan.plan_snapshot_id,
    plan_hash: fixture.plan.plan_hash,
    work_order_revision: 1,
    actor: { type: "runtime", actor_id: "runtime:deadline" },
    name: "branch.timed_out",
    payload: timeoutPayload,
    payload_hash: canonicalHash(timeoutPayload),
  };
  const timeoutBatch = inputBatch(fixture.plan, {
    batchId: `business:${timeoutSource}`,
    sourceId: timeoutSource,
    sourceType: "observation",
    prior: 1,
    target: 2,
    occurredAt: ATTEMPT_DEADLINE,
    events: [{
      type: "business.branch.runtime_observed",
      specific: { observation: timeoutObservation },
    }, {
      type: "business.branch.status_changed",
      specific: {
        branch_ref: "branch:solo",
        from: "dispatch_pending",
        to: "cancelling",
        reason: "attempt_timed_out",
      },
    }],
  });
  const earlyTimeout = structuredClone(timeoutBatch);
  for (const event of earlyTimeout.events) {
    event.payload.occurred_at = "2026-08-09T00:00:59.999Z";
  }
  assert.throws(
    () => projectBatches([earlyTimeout], started),
    expectCode("BUSINESS_PROJECTION_TRANSITION"),
  );
  const timedOut = projectBatches([timeoutBatch], started);
  assert.equal(timedOut.work_orders[WORK_ORDER_ID].engine_contract_version, 1);
  assert.equal(timedOut.work_orders[WORK_ORDER_ID].branches["branch:solo"].state, "cancelling");
  const lateLease = {
    lease_id: "lease:after-timeout",
    owner_id: "worker:after-timeout",
    generation: 1,
    claimed_at: "2026-08-09T00:01:00.001Z",
    heartbeat_at: "2026-08-09T00:01:00.001Z",
    expires_at: "2026-08-09T00:01:30.001Z",
  };
  const lateClaim = inputBatch(fixture.plan, {
    batchId: "business:INT-claim-after-timeout",
    sourceId: "INT-claim-after-timeout",
    sourceType: "internal_action",
    prior: 2,
    target: 2,
    occurredAt: lateLease.claimed_at,
    events: [{
      type: "business.outbox.claimed",
      specific: {
        effect_id: fixture.effect.effect_id,
        effect: effectIdentity(fixture.effect),
        lease: lateLease,
      },
    }],
  });
  assert.throws(
    () => projectBatches([lateClaim], timedOut),
    expectCode("BUSINESS_PROJECTION_TRANSITION"),
  );
});

test("outbox delivery certainty is durable and ambiguous sends cannot be reclaimed", () => {
  const fixture = startFixture();
  const started = projectBatches([fixture.batch]);
  const claim = inputBatch(fixture.plan, {
    batchId: "business:INT-90909090909090909090909090909090",
    sourceId: "INT-90909090909090909090909090909090",
    sourceType: "internal_action",
    prior: 1,
    target: 1,
    occurredAt: "2026-08-09T00:00:10.000Z",
    events: [{
      type: "business.outbox.claimed",
      specific: {
        effect_id: fixture.effect.effect_id,
        effect: effectIdentity(fixture.effect),
        lease: {
          lease_id: "lease:delivery-test",
          owner_id: "worker:delivery-test",
          generation: 1,
          claimed_at: "2026-08-09T00:00:10.000Z",
          heartbeat_at: "2026-08-09T00:00:10.000Z",
          expires_at: "2026-08-09T00:00:40.000Z",
        },
      },
    }],
  });
  const claimed = projectBatches([claim], started);
  const send = inputBatch(fixture.plan, {
    batchId: "business:INT-91919191919191919191919191919191",
    sourceId: "INT-91919191919191919191919191919191",
    sourceType: "internal_action",
    prior: 1,
    target: 1,
    occurredAt: "2026-08-09T00:00:11.000Z",
    events: [{
      type: "business.outbox.send_begun",
      specific: {
        effect_id: fixture.effect.effect_id,
        effect: effectIdentity(fixture.effect),
        lease_id: "lease:delivery-test",
        lease_owner_id: "worker:delivery-test",
        lease_generation: 1,
      },
    }],
  });
  const sending = projectBatches([send], claimed);
  assert.equal(sending.work_orders[WORK_ORDER_ID].revision, 1);
  assert.equal(sending.outbox[fixture.effect.effect_id].status, "sending");

  const uncertain = inputBatch(fixture.plan, {
    batchId: "business:OBS-92929292929292929292929292929292",
    sourceId: "OBS-92929292929292929292929292929292",
    sourceType: "observation",
    prior: 1,
    target: 2,
    occurredAt: "2026-08-09T00:00:12.000Z",
    events: [{
      type: "business.outbox.delivery_unknown",
      specific: {
        effect_id: fixture.effect.effect_id,
        effect: effectIdentity(fixture.effect),
        fencing_token: {
          lease_id: "lease:delivery-test",
          owner_id: "worker:delivery-test",
          generation: 1,
        },
        delivery: {
          classification: "delivery_unknown",
          evidence_refs: ["evidence:ack-lost"],
          runtime_identity: null,
          recorded_at: "2026-08-09T00:00:12.000Z",
        },
      },
    }, {
      type: "business.branch.runtime_observed",
      specific: {
        observation: {
          version: 1,
          observation_id: "OBS-92929292929292929292929292929292",
          work_order_id: WORK_ORDER_ID,
          plan_snapshot_ref: fixture.plan.plan_snapshot_id,
          plan_hash: fixture.plan.plan_hash,
          work_order_revision: 1,
          actor: { type: "runtime", actor_id: "runtime:recorded" },
          name: "branch.delivery_unknown",
          payload: {
            branch_ref: "branch:solo",
            attempt: 1,
            dispatch_id: fixture.effect.dispatch_id,
            detail: "provider acknowledgement was lost",
          },
          payload_hash: canonicalHash({
            branch_ref: "branch:solo",
            attempt: 1,
            dispatch_id: fixture.effect.dispatch_id,
            detail: "provider acknowledgement was lost",
          }),
        },
      },
    }, {
      type: "business.branch.status_changed",
      specific: {
        branch_ref: "branch:solo",
        from: "dispatch_pending",
        to: "delivery_unknown",
        reason: "provider_delivery_unknown",
      },
    }, {
      type: "business.attention.opened",
      specific: {
        attention: {
          attention_id: "attention:delivery-unknown",
          kind: "delivery_unknown",
          branch_ref: "branch:solo",
          detail_ref: ref("attention-detail:delivery-unknown"),
          evidence_refs: ["evidence:ack-lost"],
          opened_at: "2026-08-09T00:00:12.000Z",
        },
      },
    }],
  });
  const projection = projectBatches([uncertain], sending);
  assert.equal(projection.work_orders[WORK_ORDER_ID].revision, 2);
  assert.equal(projection.outbox[fixture.effect.effect_id].status, "delivery_unknown");
  assert.equal(
    projection.outbox[fixture.effect.effect_id].delivery.classification,
    "delivery_unknown",
  );
  const repeatedSource = `OBS-${"2".repeat(32)}`;
  const repeatedAt = "2026-08-09T00:00:13.000Z";
  const repeatedPayload = {
    branch_ref: "branch:solo",
    attempt: 1,
    dispatch_id: fixture.effect.dispatch_id,
    detail: "the same unknown delivery was observed again",
  };
  const repeated = inputBatch(fixture.plan, {
    batchId: `business:${repeatedSource}`,
    sourceId: repeatedSource,
    sourceType: "observation",
    prior: 2,
    target: 3,
    occurredAt: repeatedAt,
    events: [{
      type: "business.branch.runtime_observed",
      specific: {
        observation: observationFixture(fixture, {
          sourceId: repeatedSource,
          revision: 2,
          name: "branch.delivery_unknown",
          payload: repeatedPayload,
          actorType: "runtime",
        }),
      },
    }],
  });
  const repeatedProjection = projectBatches([repeated], projection);
  assert.equal(
    repeatedProjection.outbox[fixture.effect.effect_id].delivery.recorded_at,
    "2026-08-09T00:00:12.000Z",
  );
  assert.equal(
    repeatedProjection.work_orders[WORK_ORDER_ID].branches["branch:solo"].delivery.observed_at,
    repeatedAt,
  );

  const reclaim = businessEvent(fixture.plan, {
    eventId: "INT-93939393939393939393939393939393:event:1",
    type: "business.outbox.claimed",
    sourceId: "INT-93939393939393939393939393939393",
    prior: 2,
    target: 2,
    occurredAt: "2026-08-09T00:00:13.000Z",
    specific: {
      effect_id: fixture.effect.effect_id,
      effect: effectIdentity(fixture.effect),
      lease: {
        lease_id: "lease:unsafe-reclaim",
        owner_id: "worker:unsafe-reclaim",
        generation: 2,
        claimed_at: "2026-08-09T00:00:13.000Z",
        heartbeat_at: "2026-08-09T00:00:13.000Z",
        expires_at: "2026-08-09T00:00:43.000Z",
      },
    },
  });
  assert.throws(
    () => projectBusinessEventV1(projection, reclaim, { batch_id: "business:unsafe-reclaim" }),
    expectCode("BUSINESS_PROJECTION_TRANSITION"),
  );
});

test("outbox lease generations fence a stale worker after requeue and reclaim", () => {
  const fixture = startFixture();
  let projection = projectBatches([fixture.batch]);
  const makeLease = (generation, owner, leaseId, occurredAt) => ({
    lease_id: leaseId,
    owner_id: owner,
    generation,
    claimed_at: occurredAt,
    heartbeat_at: occurredAt,
    expires_at: new Date(Date.parse(occurredAt) + 30_000).toISOString(),
  });
  const firstLease = makeLease(1, "worker:old", "lease:old", "2026-08-09T00:00:10.000Z");
  const claimOne = inputBatch(fixture.plan, {
    batchId: "business:INT-a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
    sourceId: "INT-a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
    sourceType: "internal_action",
    prior: 1,
    target: 1,
    occurredAt: firstLease.claimed_at,
    events: [{
      type: "business.outbox.claimed",
      specific: {
        effect_id: fixture.effect.effect_id,
        effect: effectIdentity(fixture.effect),
        lease: firstLease,
      },
    }],
  });
  projection = projectBatches([claimOne], projection);
  const requeue = inputBatch(fixture.plan, {
    batchId: "business:INT-a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2",
    sourceId: "INT-a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2",
    sourceType: "internal_action",
    prior: 1,
    target: 1,
    occurredAt: "2026-08-09T00:00:40.000Z",
    events: [{
      type: "business.outbox.requeued",
      specific: {
        effect_id: fixture.effect.effect_id,
        effect: effectIdentity(fixture.effect),
        lease_id: firstLease.lease_id,
        lease_owner_id: firstLease.owner_id,
        lease_generation: firstLease.generation,
        reason: "lease_expired_before_send",
      },
    }],
  });
  projection = projectBatches([requeue], projection);
  const secondLease = makeLease(2, "worker:new", "lease:new", "2026-08-09T00:00:41.000Z");
  const claimTwo = inputBatch(fixture.plan, {
    batchId: "business:INT-a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3",
    sourceId: "INT-a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3",
    sourceType: "internal_action",
    prior: 1,
    target: 1,
    occurredAt: secondLease.claimed_at,
    events: [{
      type: "business.outbox.claimed",
      specific: {
        effect_id: fixture.effect.effect_id,
        effect: effectIdentity(fixture.effect),
        lease: secondLease,
      },
    }],
  });
  projection = projectBatches([claimTwo], projection);
  const staleSend = inputBatch(fixture.plan, {
    batchId: "business:INT-a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4",
    sourceId: "INT-a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4a4",
    sourceType: "internal_action",
    prior: 1,
    target: 1,
    occurredAt: "2026-08-09T00:00:42.000Z",
    events: [{
      type: "business.outbox.send_begun",
      specific: {
        effect_id: fixture.effect.effect_id,
        effect: effectIdentity(fixture.effect),
        lease_id: firstLease.lease_id,
        lease_owner_id: firstLease.owner_id,
        lease_generation: firstLease.generation,
      },
    }],
  });
  assert.throws(
    () => projectBatches([staleSend], projection),
    expectCode("BUSINESS_PROJECTION_TRANSITION"),
  );
  const currentSend = structuredClone(staleSend);
  currentSend.batch_id = "business:INT-a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5";
  for (const event of currentSend.events) {
    event.payload.source_id = "INT-a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5";
    event.payload.occurred_at = "2026-08-09T00:00:43.000Z";
  }
  currentSend.events[0].payload.lease_id = secondLease.lease_id;
  currentSend.events[0].payload.lease_owner_id = secondLease.owner_id;
  currentSend.events[0].payload.lease_generation = secondLease.generation;
  currentSend.events.at(-1).payload.receipt.source_id = currentSend.events.at(-1).payload.source_id;
  currentSend.events.at(-1).payload.receipt.batch_id = currentSend.batch_id;
  currentSend.events.at(-1).payload.receipt.event_ids = [currentSend.events[0].event_id];
  projection = projectBatches([currentSend], projection);
  assert.equal(projection.outbox[fixture.effect.effect_id].status, "sending");
  assert.equal(projection.outbox[fixture.effect.effect_id].lease_generation, 2);

  const staleSettlement = inputBatch(fixture.plan, {
    batchId: "business:OBS-a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6",
    sourceId: "OBS-a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6",
    sourceType: "observation",
    prior: 1,
    target: 2,
    occurredAt: "2026-08-09T00:00:44.000Z",
    events: [{
      type: "business.outbox.delivered",
      specific: {
        effect_id: fixture.effect.effect_id,
        effect: effectIdentity(fixture.effect),
        fencing_token: {
          lease_id: firstLease.lease_id,
          owner_id: firstLease.owner_id,
          generation: firstLease.generation,
        },
        delivery: {
          classification: "accepted",
          evidence_refs: ["evidence:stale-worker-ack"],
          runtime_identity: {
            operation_id: "operation:stale-worker",
            thread_id: "thread:stale-worker",
            turn_id: "turn:stale-worker",
          },
          recorded_at: "2026-08-09T00:00:44.000Z",
        },
      },
    }],
  });
  assert.throws(
    () => projectBatches([staleSettlement], projection),
    expectCode("BUSINESS_PROJECTION_TRANSITION"),
  );
});

test("late observations are receipt-backed quarantined evidence and never alter the branch", () => {
  const fixture = startFixture();
  const started = projectBatches([fixture.batch]);
  const observationPayload = {
    branch_ref: "branch:solo",
    attempt: 2,
    message: "sanitized stale progress",
  };
  const observation = {
    version: 1,
    observation_id: "OBS-ffffffffffffffffffffffffffffffff",
    work_order_id: WORK_ORDER_ID,
    plan_snapshot_ref: fixture.plan.plan_snapshot_id,
    plan_hash: fixture.plan.plan_hash,
    work_order_revision: 1,
    actor: { type: "provider", actor_id: "provider:recorded" },
    name: "branch.progress",
    payload: observationPayload,
    payload_hash: canonicalHash(observationPayload),
  };
  const quarantine = inputBatch(fixture.plan, {
    batchId: "business:OBS-ffffffffffffffffffffffffffffffff",
    sourceId: observation.observation_id,
    sourceType: "observation",
    prior: 1,
    target: 2,
    occurredAt: "2026-08-09T00:00:20.000Z",
    events: [{
      type: "business.late_observation.quarantined",
      specific: {
        record: {
          observation,
          reason: "stale_attempt",
          artifact_refs: [],
          evidence_refs: ["evidence:stale-observation"],
        },
      },
    }],
    result: { status: "quarantined", reason: "stale_attempt" },
  });

  const projection = replayBusinessProjectionV1([fixture.batch, quarantine]);
  const branch = projection.work_orders[WORK_ORDER_ID].branches["branch:solo"];
  assert.equal(branch.attempt, 1);
  assert.equal(branch.state, "dispatch_pending");
  assert.equal(branch.last_progress_at, null);
  assert.equal(projection.work_orders[WORK_ORDER_ID].revision, 2);
  assert.equal(
    projection.late_observations[observation.observation_id].reason,
    "stale_attempt",
  );
  assert.equal(
    projection.observation_receipts[observation.observation_id].result.status,
    "quarantined",
  );

  const exactReplay = replayBusinessProjectionV1([quarantine], projection);
  assert.equal(canonicalJson(exactReplay), canonicalJson(projection));
});

test("projector rejects a pre-delivery failure that could strand a second pending attempt", () => {
  const fixture = startFixture();
  const started = projectBatches([fixture.batch]);
  const unsafeFailure = inputBatch(fixture.plan, {
    batchId: "business:OBS-pre-delivery-failure",
    sourceId: "OBS-pre-delivery-failure",
    sourceType: "observation",
    prior: 1,
    target: 2,
    occurredAt: "2026-08-09T00:00:20.000Z",
    events: [{
      type: "business.branch.status_changed",
      specific: {
        branch_ref: "branch:solo",
        from: "dispatch_pending",
        to: "failed",
        reason: "provider_failure_before_delivery_certainty",
      },
    }],
  });
  assert.throws(
    () => projectBatches([unsafeFailure], started),
    expectCode("BUSINESS_PROJECTION_TRANSITION"),
  );
  assert.equal(started.outbox[fixture.effect.effect_id].status, "pending");
});

test("projector rejects forward runtime facts and effects at the execution deadline", () => {
  const fixture = startFixture();
  const running = structuredClone(projectBatches([fixture.batch]));
  const workOrder = running.work_orders[WORK_ORDER_ID];
  const branch = workOrder.branches["branch:solo"];
  workOrder.status = "running";
  workOrder.started_at = "2026-08-09T00:00:01.000Z";
  branch.state = "running";
  branch.delivery = {
    classification: "accepted",
    observed_at: "2026-08-09T00:00:01.000Z",
  };
  branch.runtime_identity = {
    operation_id: "operation:deadline-test",
    thread_id: "thread:deadline-test",
    turn_id: "turn:deadline-test",
  };

  const resultPayload = {
    branch_ref: "branch:solo",
    attempt: 1,
    artifact_refs: [ref("artifact:after-deadline")],
    evidence_refs: ["evidence:after-deadline"],
  };
  const resultObservation = {
    version: 1,
    observation_id: `OBS-${"4".repeat(32)}`,
    work_order_id: WORK_ORDER_ID,
    plan_snapshot_ref: fixture.plan.plan_snapshot_id,
    plan_hash: fixture.plan.plan_hash,
    work_order_revision: 1,
    actor: { type: "provider", actor_id: "provider:recorded" },
    name: "branch.result.submitted",
    payload: resultPayload,
    payload_hash: canonicalHash(resultPayload),
  };
  const lateResult = inputBatch(fixture.plan, {
    batchId: `business:${resultObservation.observation_id}`,
    sourceId: resultObservation.observation_id,
    sourceType: "observation",
    prior: 1,
    target: 2,
    occurredAt: ATTEMPT_DEADLINE,
    events: [{
      type: "business.branch.runtime_observed",
      specific: { observation: resultObservation },
    }],
  });
  assert.throws(
    () => projectBatches([lateResult], running),
    expectCode("BUSINESS_PROJECTION_TRANSITION"),
  );

  const waiting = structuredClone(running);
  const waitingBranch = waiting.work_orders[WORK_ORDER_ID].branches["branch:solo"];
  waitingBranch.state = "waiting_for_user";
  waitingBranch.open_user_input = {
    request_id: `REQ-${"5".repeat(32)}`,
    prompt_ref: ref("prompt:deadline-test"),
    requested_at: "2026-08-09T00:00:02.000Z",
  };
  const responseRef = ref("response:deadline-test");
  const effect = {
    ...fixture.effect,
    effect_id: "effect:user-input:deadline-test",
    effect_kind: "provider.user_input.submit",
    packet_ref: responseRef.id,
    packet_hash: responseRef.hash,
    idempotency_key: "idempotency:user-input:deadline-test",
    created_at: ATTEMPT_DEADLINE,
    updated_at: ATTEMPT_DEADLINE,
  };
  const lateUserInput = inputBatch(fixture.plan, {
    batchId: "business:CMD-deadline-user-input",
    sourceId: "CMD-deadline-user-input",
    sourceType: "command",
    prior: 1,
    target: 2,
    occurredAt: ATTEMPT_DEADLINE,
    events: [{
      type: "business.outbox.enqueued",
      specific: { effect },
    }, {
      type: "business.branch.status_changed",
      specific: {
        branch_ref: "branch:solo",
        from: "waiting_for_user",
        to: "running",
        reason: "user_input_resolved",
        resolved_request_id: waitingBranch.open_user_input.request_id,
        response_ref: responseRef,
      },
    }],
  });
  assert.throws(
    () => projectBatches([lateUserInput], waiting),
    expectCode("BUSINESS_PROJECTION_TRANSITION"),
  );
});

test("normal review events can release acceptance and remain bound to the reviewed final result", () => {
  const fixture = startFixture();
  const prepared = structuredClone(projectBatches([fixture.batch]));
  const workOrder = prepared.work_orders[WORK_ORDER_ID];
  const branch = workOrder.branches["branch:solo"];
  const requirement = fixture.plan.acceptance_policy.criteria[0].verification_requirements[0];
  const runtimeIdentity = {
    operation_id: "operation:reviewed-result",
    thread_id: null,
    turn_id: null,
  };
  prepared.outbox[fixture.effect.effect_id] = {
    ...prepared.outbox[fixture.effect.effect_id],
    status: "delivered",
    delivery: {
      classification: "accepted",
      evidence_refs: ["evidence:reviewed-turn"],
      runtime_identity: runtimeIdentity,
      recorded_at: "2026-08-09T00:00:19.000Z",
    },
    updated_at: "2026-08-09T00:00:19.000Z",
  };
  branch.delivery = {
    classification: "accepted",
    observed_at: "2026-08-09T00:00:19.000Z",
  };
  branch.runtime_identity = runtimeIdentity;
  const result = {
    attempt: 1,
    artifact_refs: [ref("artifact:reviewed-result")],
    evidence_refs: ["evidence:reviewed-result"],
    submitted_at: "2026-08-09T00:00:20.000Z",
  };
  workOrder.status = "running";
  branch.state = "verifying";
  branch.result = result;
  branch.verification_by_criterion = {
    "criterion:tests": {
      [requirement.verification_ref.id]: {
        criterion_id: "criterion:tests",
        verification_ref: requirement.verification_ref,
        kind: requirement.kind,
        status: "passed",
        evidence_refs: ["evidence:verification"],
        verifier_ref: "verifier:deterministic",
        recorded_at: "2026-08-09T00:00:21.000Z",
      },
    },
  };
  const prematureRelease = inputBatch(fixture.plan, {
    batchId: "business:OBS-premature-review-release",
    sourceId: "OBS-premature-review-release",
    sourceType: "observation",
    prior: 1,
    target: 2,
    occurredAt: "2026-08-09T00:00:21.500Z",
    events: [{
      type: "business.branch.status_changed",
      specific: {
        branch_ref: "branch:solo",
        from: "verifying",
        to: "accepted",
        reason: "missing_independent_review",
      },
    }],
  });
  assert.throws(
    () => projectBatches([prematureRelease], prepared),
    expectCode("BUSINESS_PROJECTION_ACCEPTANCE_GATES"),
  );
  const reviewPayload = {
    branch_ref: "branch:solo",
    review_id: "review:current-result",
    status: "accepted",
    findings: { critical: 0, important: 0, minor: 0 },
    evidence_refs: ["evidence:independent-review"],
  };
  const sourceId = "OBS-33333333333333333333333333333333";
  const observation = {
    version: 1,
    observation_id: sourceId,
    work_order_id: WORK_ORDER_ID,
    plan_snapshot_ref: fixture.plan.plan_snapshot_id,
    plan_hash: fixture.plan.plan_hash,
    work_order_revision: 1,
    actor: { type: "verifier", actor_id: "verifier:independent" },
    name: "review.recorded",
    payload: reviewPayload,
    payload_hash: canonicalHash(reviewPayload),
  };
  const reviewAndRelease = inputBatch(fixture.plan, {
    batchId: `business:${sourceId}`,
    sourceId,
    sourceType: "observation",
    prior: 1,
    target: 2,
    occurredAt: "2026-08-09T00:00:22.000Z",
    events: [{
      type: "business.review.recorded",
      specific: { observation, result_hash: canonicalHash(result) },
    }, {
      type: "business.branch.status_changed",
      specific: {
        branch_ref: "branch:solo",
        from: "verifying",
        to: "accepted",
        reason: "review_minimum_satisfied",
      },
    }, {
      type: "business.work_order.status_changed",
      specific: {
        from: "running",
        to: "awaiting_acceptance",
        reason: "review_minimum_satisfied",
      },
    }],
  });
  const reviewed = projectBatches([reviewAndRelease], prepared);
  assert.equal(reviewed.work_orders[WORK_ORDER_ID].status, "awaiting_acceptance");
  assert.equal(
    reviewed.work_orders[WORK_ORDER_ID].acceptance.reviews[reviewPayload.review_id].result_hash,
    canonicalHash(result),
  );

  const changed = structuredClone(reviewed);
  const changedWorkOrder = changed.work_orders[WORK_ORDER_ID];
  changedWorkOrder.status = "running";
  changedWorkOrder.branches["branch:solo"].result = {
    ...result,
    artifact_refs: [ref("artifact:replacement-result")],
    submitted_at: "2026-08-09T00:00:23.000Z",
  };
  const staleReviewRelease = inputBatch(fixture.plan, {
    batchId: "business:CMD-stale-review-release",
    sourceId: "CMD-stale-review-release",
    sourceType: "command",
    prior: 2,
    target: 3,
    occurredAt: "2026-08-09T00:00:24.000Z",
    events: [{
      type: "business.work_order.status_changed",
      specific: {
        from: "running",
        to: "awaiting_acceptance",
        reason: "must_not_reuse_review_for_old_result",
      },
    }],
  });
  assert.throws(
    () => projectBatches([staleReviewRelease], changed),
    expectCode("BUSINESS_PROJECTION_ACCEPTANCE_GATES"),
  );
});

test("unknown events, plan mismatches, revision reuse, and incomplete inputs fail closed", () => {
  const fixture = startFixture();
  const started = projectBatches([fixture.batch]);
  const unknown = businessEvent(fixture.plan, {
    eventId: "CMD-12121212121212121212121212121212:event:1",
    type: "business.provider.magic",
    sourceId: "CMD-12121212121212121212121212121212",
    prior: 1,
    target: 2,
  });
  assert.throws(
    () => projectBusinessEventV1(started, unknown),
    expectCode("BUSINESS_PROJECTION_EVENT_UNKNOWN"),
  );

  const mismatch = structuredClone(fixture.batch.events[1]);
  mismatch.event_id = "CMD-34343434343434343434343434343434:event:1";
  mismatch.payload.source_id = "CMD-34343434343434343434343434343434";
  mismatch.payload.prior_work_order_revision = 1;
  mismatch.payload.target_work_order_revision = 2;
  mismatch.payload.plan_hash = "f".repeat(64);
  assert.throws(
    () => projectBusinessEventV1(started, mismatch),
    expectCode("BUSINESS_PROJECTION_PLAN_BINDING"),
  );

  const regression = structuredClone(fixture.batch.events[1]);
  regression.event_id = "CMD-56565656565656565656565656565656:event:1";
  regression.payload.source_id = "CMD-56565656565656565656565656565656";
  regression.payload.prior_work_order_revision = 0;
  regression.payload.target_work_order_revision = 1;
  assert.throws(
    () => projectBusinessEventV1(started, regression),
    expectCode("BUSINESS_PROJECTION_SOURCE_CLASS"),
  );

  const incompleteEvent = businessEvent(fixture.plan, {
    eventId: "CMD-78787878787878787878787878787878:event:1",
    type: "business.attention.opened",
    sourceId: "CMD-78787878787878787878787878787878",
    prior: 1,
    target: 2,
    specific: {
      attention: {
        attention_id: "attention:one",
        kind: "operator_required",
        branch_ref: "branch:solo",
        detail_ref: ref("attention-detail:one"),
        evidence_refs: ["evidence:attention"],
        opened_at: CREATED_AT,
      },
    },
  });
  assert.throws(
    () => projectBusinessEventV1(started, incompleteEvent, {
      batch_id: "business:CMD-78787878787878787878787878787878",
      events: [incompleteEvent],
    }),
    expectCode("BUSINESS_PROJECTION_RECEIPT_BINDING"),
  );
});

test("a Business receipt cannot hide behind foreign events or close an empty input", () => {
  const fixture = startFixture();
  const started = projectBatches([fixture.batch]);
  const sourceId = "CMD-forged-receipt";
  const batchId = "business:CMD-forged-receipt";
  const receipt = businessEvent(fixture.plan, {
    eventId: `${sourceId}:receipt`,
    type: "business.command.received",
    sourceId,
    prior: 1,
    target: 2,
    occurredAt: "2026-08-09T00:00:30.000Z",
    specific: {
      receipt: {
        source_id: sourceId,
        source_type: "command",
        identity_hash: canonicalHash({ sourceId, kind: "forged" }),
        payload_hash: canonicalHash({ result: "forged" }),
        work_order_id: WORK_ORDER_ID,
        applied_revision: 2,
        batch_id: batchId,
        event_ids: [],
        result: { status: "forged" },
      },
    },
  });
  const foreign = {
    ...structuredClone(receipt),
    event_id: "foreign:event:1",
    type: "task.updated",
  };
  assert.throws(
    () => projectBusinessEventV1(started, receipt, {
      batch_id: batchId,
      events: [foreign, receipt],
    }),
    expectCode("BUSINESS_PROJECTION_EVENT_UNKNOWN"),
  );
  assert.throws(
    () => projectBusinessEventV1(started, receipt),
    expectCode("BUSINESS_PROJECTION_LIMIT"),
  );

  const domain = businessEvent(fixture.plan, {
    eventId: `${sourceId}:event:1`,
    type: "business.work_order.status_changed",
    sourceId,
    prior: 1,
    target: 2,
    occurredAt: "2026-08-09T00:00:30.000Z",
    specific: { from: "starting", to: "running", reason: "forged_mixed_batch" },
  });
  const domainReceipt = structuredClone(receipt);
  domainReceipt.payload.receipt.event_ids = [domain.event_id];
  assert.throws(
    () => projectBusinessEventV1(started, domain, {
      batch_id: batchId,
      events: [foreign, domain, domainReceipt],
    }),
    expectCode("BUSINESS_PROJECTION_EVENT_UNKNOWN"),
  );
});

test("source classes, terminal transitions, and acceptance gates reject mixed hostile batches", () => {
  const fixture = startFixture();
  const started = projectBatches([fixture.batch]);
  const mixedInternal = inputBatch(fixture.plan, {
    batchId: "business:INT-b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1",
    sourceId: "INT-b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1",
    sourceType: "internal_action",
    prior: 1,
    target: 1,
    occurredAt: "2026-08-09T00:01:00.000Z",
    events: [{
      type: "business.outbox.claimed",
      specific: {
        effect_id: fixture.effect.effect_id,
        effect: effectIdentity(fixture.effect),
        lease: {
          lease_id: "lease:mixed",
          owner_id: "worker:mixed",
          generation: 1,
          claimed_at: "2026-08-09T00:01:00.000Z",
          heartbeat_at: "2026-08-09T00:01:00.000Z",
          expires_at: "2026-08-09T00:01:30.000Z",
        },
      },
    }, {
      type: "business.branch.status_changed",
      specific: {
        branch_ref: "branch:solo",
        from: "dispatch_pending",
        to: "running",
        reason: "smuggled_internal_mutation",
      },
    }],
  });
  assert.throws(
    () => projectBatches([mixedInternal], started),
    expectCode("BUSINESS_PROJECTION_SOURCE_CLASS"),
  );

  const postTerminal = inputBatch(fixture.plan, {
    batchId: "business:CMD-b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2",
    sourceId: "CMD-b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2",
    sourceType: "command",
    prior: 1,
    target: 2,
    occurredAt: "2026-08-09T00:01:01.000Z",
    events: [{
      type: "business.work_order.status_changed",
      specific: { from: "starting", to: "failed", reason: "terminal_first" },
    }, {
      type: "business.branch.status_changed",
      specific: {
        branch_ref: "branch:solo",
        from: "dispatch_pending",
        to: "running",
        reason: "mutation_after_terminal",
      },
    }],
  });
  assert.throws(
    () => projectBatches([postTerminal], started),
    expectCode("BUSINESS_PROJECTION_TRANSITION"),
  );

  const falseAcceptance = inputBatch(fixture.plan, {
    batchId: "business:CMD-b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3",
    sourceId: "CMD-b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3",
    sourceType: "command",
    prior: 1,
    target: 2,
    occurredAt: "2026-08-09T00:01:02.000Z",
    events: [{
      type: "business.work_order.status_changed",
      specific: { from: "starting", to: "running", reason: "synthetic_start" },
    }, {
      type: "business.work_order.status_changed",
      specific: { from: "running", to: "awaiting_acceptance", reason: "forged_ready" },
    }],
  });
  assert.throws(
    () => projectBatches([falseAcceptance], started),
    expectCode("BUSINESS_PROJECTION_ACCEPTANCE_GATES"),
  );
});
