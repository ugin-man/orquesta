"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { canonicalHash } = require("@orquesta/contracts");
const { createEventStore } = require("@orquesta/event-store");
const { normalizeBusinessWorkOrderPlanV1 } = require("../src/contract");
const {
  deriveEffectOperationScopeHashV2,
  deriveLifecycleSnapshot,
} = require("../src/lifecycle");
const {
  BUSINESS_EVENT_TYPES,
  OUTBOX_IMMUTABLE_FIELDS,
  initialBusinessProjectionV1,
  projectBusinessEventV1,
} = require("../src/projector");
const {
  BusinessObservationBoundaryError,
  createBusinessObservationBoundary,
} = require("../src/observation-boundary");
const {
  buildProviderSettlementCutoverBatchV1,
  deriveProviderSettlementCutoverReadinessV1,
} = require("../src/provider-settlement-cutover-boundary");
const { createSendAuthorizationBundleV1 } = require("../src/send-authorization");
const { decideWorkOrderV1 } = require("../src/state-machine");

const WORK_ORDER_ID = `WO-${"1".repeat(32)}`;
const CREATED_AT = "2026-08-09T00:00:00.000Z";
const OBSERVED_AT = "2026-08-09T00:00:12.000Z";
const DEADLINE_AT = "2026-08-09T00:10:00.000Z";
const ATTEMPT_DEADLINE = "2026-08-09T00:01:00.000Z";
const START_SOURCE = `CMD-${"a".repeat(32)}`;

function ref(id) {
  return { id, hash: canonicalHash({ id }) };
}

const INITIAL_PACKET_REF = ref("packet:initial");
const DISPATCH_ID = `DSP-${canonicalHash({
  work_order_id: WORK_ORDER_ID,
  branch_ref: "branch:solo",
  attempt: 1,
  packet_ref: INITIAL_PACKET_REF,
}).slice(0, 32)}`;

function planFixture({ retryPolicy = {} } = {}) {
  return normalizeBusinessWorkOrderPlanV1({
    version: 1,
    project_ref: "project:observation-boundary",
    revision: 1,
    supersedes_plan_ref: null,
    title: "Ingest authenticated runtime observations",
    desired_outcome: "Every external runtime fact is authorized and receipt-idempotent.",
    acceptance_policy: {
      criteria: [{
        criterion_id: "criterion:tests",
        description: "The deterministic boundary tests pass.",
        verification: "deterministic",
        verification_requirements: [{
          kind: "deterministic",
          verification_ref: ref("verification:observation-boundary"),
        }],
      }],
      review_minimum: "light",
    },
    task_intent_ref: ref("TI-observation-root"),
    execution_plan_ref: ref("EP-observation-root"),
    context_pack_ref: ref("CP-observation-root"),
    branches: [{
      branch_ref: "branch:solo",
      task_intent_ref: ref("TI-observation-solo"),
      execution_plan_ref: ref("EP-observation-solo"),
      context_pack_ref: ref("CP-observation-solo"),
      dependencies: [],
      role: "work",
      parallelizable: false,
      isolation: "sandbox",
      assignee_ref: "assignee:solo",
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
      ...retryPolicy,
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
  occurredAt = CREATED_AT,
  specific = {},
}) {
  return {
    event_id: eventId,
    schema_version: 1,
    type,
    payload: {
      work_order_id: WORK_ORDER_ID,
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
  sourceId,
  sourceType,
  prior,
  target,
  occurredAt = CREATED_AT,
  events,
  result = { status: "recorded" },
}) {
  const batchId = `business:${sourceId}`;
  const projected = events.map((entry, index) => businessEvent(plan, {
    eventId: `${sourceId}:event:${index + 1}`,
    type: entry.type,
    sourceId,
    prior,
    target,
    occurredAt,
    specific: entry.specific,
  }));
  const receiptType = {
    command: "business.command.received",
    observation: "business.observation.received",
    internal_action: "business.internal_action.received",
  }[sourceType];
  projected.push(businessEvent(plan, {
    eventId: `${sourceId}:receipt`,
    type: receiptType,
    sourceId,
    prior,
    target,
    occurredAt,
    specific: {
      receipt: {
        source_id: sourceId,
        source_type: sourceType,
        identity_hash: canonicalHash({ sourceId, sourceType, fixture: true }),
        payload_hash: canonicalHash(events),
        work_order_id: WORK_ORDER_ID,
        applied_revision: target,
        batch_id: batchId,
        event_ids: projected.map((event) => event.event_id),
        result,
      },
    },
  }));
  return { batch_id: batchId, events: projected };
}

function sendAuthorizationBatch({
  plan,
  projection,
  effect,
  identity,
  lease,
  packetReceipt,
  sourceId,
  revision,
  occurredAt,
}) {
  const batchId = `business:${sourceId}`;
  const sendEvent = businessEvent(plan, {
    eventId: "BVE-pending-send-authorization-event",
    type: "business.outbox.send_begun",
    sourceId,
    prior: revision,
    target: revision,
    occurredAt,
    specific: {
      effect_id: effect.effect_id,
      effect: identity,
      lease_id: lease.lease_id,
      lease_owner_id: lease.owner_id,
      lease_generation: lease.generation,
      lease_expires_at: lease.expires_at,
      packet_verification_receipt: packetReceipt,
      provider_settlement_cutover_id: projection.provider_settlement_epoch.cutover_id,
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
      send_authorization_contract_version: 2,
    },
  });
  sendEvent.event_id = `BVE-${canonicalHash({
    source_id: sourceId,
    ordinal: 0,
    type: sendEvent.type,
    payload: sendEvent.payload,
    evidence_refs: sendEvent.evidence_refs,
  }).slice(0, 32)}`;
  const bundle = createSendAuthorizationBundleV1({
    send_event: sendEvent,
    batch_id: batchId,
  });
  const result = {
    internal_action_id: sourceId,
    work_order_id: WORK_ORDER_ID,
    work_order_revision: revision,
    effect_id: effect.effect_id,
    action: "outbox.send.begin",
    outbox_status: "sending",
    fencing_token: {
      lease_id: lease.lease_id,
      owner_id: lease.owner_id,
      generation: lease.generation,
    },
    packet_verification_receipt: packetReceipt,
    send_authorization_bundle: bundle,
  };
  const receiptEvent = businessEvent(plan, {
    eventId: "BVE-pending-send-authorization-receipt",
    type: "business.internal_action.received",
    sourceId,
    prior: revision,
    target: revision,
    occurredAt,
    specific: {
      receipt: {
        source_id: sourceId,
        source_type: "internal_action",
        identity_hash: canonicalHash({ sourceId, sourceType: "internal_action", fixture: true }),
        payload_hash: canonicalHash(sendEvent.payload),
        work_order_id: WORK_ORDER_ID,
        applied_revision: revision,
        batch_id: batchId,
        event_ids: [sendEvent.event_id],
        result,
      },
    },
  });
  receiptEvent.event_id = `BVE-${canonicalHash({
    source_id: sourceId,
    ordinal: 1,
    type: receiptEvent.type,
    payload: receiptEvent.payload,
    evidence_refs: receiptEvent.evidence_refs,
  }).slice(0, 32)}`;
  return { batch_id: batchId, events: [sendEvent, receiptEvent] };
}

function decisionBatch(input, decision) {
  const sourceId = input.observation_id;
  const first = decision.events[0];
  const batchId = `business:${sourceId}`;
  const principal = { type: "agent", id: input.actor.actor_id };
  const receipt = {
    event_id: `${sourceId}:receipt`,
    schema_version: 1,
    type: "business.observation.received",
    payload: {
      work_order_id: input.work_order_id,
      plan_snapshot_ref: input.plan_snapshot_ref,
      plan_hash: input.plan_hash,
      source_id: sourceId,
      prior_work_order_revision: first.payload.prior_work_order_revision,
      target_work_order_revision: first.payload.target_work_order_revision,
      occurred_at: first.payload.occurred_at,
      receipt: {
        source_id: sourceId,
        source_type: "observation",
        identity_hash: canonicalHash({
          source_type: "observation",
          observation: input,
          authenticated_principal: principal,
        }),
        payload_hash: input.payload_hash,
        work_order_id: input.work_order_id,
        applied_revision: first.payload.target_work_order_revision,
        batch_id: batchId,
        event_ids: decision.events.map((event) => event.event_id),
        result: decision.result,
      },
    },
    evidence_refs: [],
  };
  return { batch_id: batchId, events: [...decision.events, receipt] };
}

function commandDecisionBatch(input, decision) {
  const sourceId = input.command_id;
  const first = decision.events[0];
  const batchId = `business:${sourceId}`;
  const receipt = businessEvent({
    plan_snapshot_id: input.plan_snapshot_ref,
    plan_hash: input.plan_hash,
  }, {
    eventId: `${sourceId}:receipt`,
    type: "business.command.received",
    sourceId,
    prior: first.payload.prior_work_order_revision,
    target: first.payload.target_work_order_revision,
    occurredAt: first.payload.occurred_at,
    specific: {
      receipt: {
        source_id: sourceId,
        source_type: "command",
        identity_hash: canonicalHash(input),
        payload_hash: input.payload_hash,
        work_order_id: input.work_order_id,
        applied_revision: first.payload.target_work_order_revision,
        batch_id: batchId,
        event_ids: decision.events.map((event) => event.event_id),
        result: decision.result,
      },
    },
  });
  return { batch_id: batchId, events: [...decision.events, receipt] };
}

function startFixture({ engineVersion = 2, plan: suppliedPlan = null } = {}) {
  const plan = suppliedPlan || planFixture();
  const packet = INITIAL_PACKET_REF;
  const operationScopeHash = deriveEffectOperationScopeHashV2({
    effect_kind: "provider.thread.create",
    provider_ref: "provider:recorded",
    packet_ref: packet.id,
    packet_hash: packet.hash,
  });
  const effectSeed = {
    effect_contract_version: 2,
    work_order_id: WORK_ORDER_ID,
    branch_ref: "branch:solo",
    attempt: 1,
    dispatch_id: DISPATCH_ID,
    effect_kind: "provider.thread.create",
    origin_source_id: START_SOURCE,
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
      effect_id: `FX-${canonicalHash(effectSeed).slice(0, 32)}`,
      ...effectSeed,
      idempotency_key: `IDEM-${canonicalHash(effectSeed).slice(0, 32)}`,
      status: "pending",
      lease: null,
      delivery: null,
      created_at: CREATED_AT,
      updated_at: CREATED_AT,
    }
    : {
      effect_id: "effect:legacy:observation-boundary",
      work_order_id: WORK_ORDER_ID,
      branch_ref: "branch:solo",
      attempt: 1,
      dispatch_id: DISPATCH_ID,
      effect_kind: "provider.turn.start",
      provider_ref: "provider:recorded",
      packet_ref: packet.id,
      packet_hash: packet.hash,
      idempotency_key: "idempotency:legacy:observation-boundary",
      status: "pending",
      lease: null,
      delivery: null,
      created_at: CREATED_AT,
      updated_at: CREATED_AT,
    };
  const batch = inputBatch(plan, {
    sourceId: START_SOURCE,
    sourceType: "command",
    prior: 0,
    target: 1,
    events: [{
      type: "business.work_order.created",
      specific: {
        plan,
        ...(engineVersion === 2 ? { engine_contract_version: 2 } : {}),
        revision: 1,
        status: "starting",
        created_at: CREATED_AT,
        deadline_at: DEADLINE_AT,
      },
    }, {
      type: "business.context_budget.verified",
      specific: {
        receipt: {
          budget_tokens: 1_000,
          duplicate_context_tokens: 100,
          evidence_refs: ["evidence:context-budget"],
        },
      },
    }, {
      type: "business.branch.initialized",
      specific: {
        branch: plan.branches[0],
        state: "ready",
        required_criterion_ids: ["criterion:tests"],
      },
    }, {
      type: "business.branch.attempt_opened",
      specific: {
        branch_ref: "branch:solo",
        attempt: 1,
        dispatch_id: DISPATCH_ID,
        attempt_started_at: CREATED_AT,
        attempt_deadline_at: ATTEMPT_DEADLINE,
        retry_at: null,
        packet_ref: packet,
        packet_hash: packet.hash,
      },
    }, {
      type: "business.outbox.enqueued",
      specific: { effect },
    }],
    result: { status: "starting", work_order_revision: 1 },
  });
  return { plan, effect, batch };
}

function projectBatches(batches, initial = initialBusinessProjectionV1()) {
  let projection = initial;
  for (const batch of batches) {
    for (const event of batch.events) {
      projection = projectBusinessEventV1(projection, event, batch);
    }
  }
  return projection;
}

function packetVerificationReceipt(projection, effect) {
  const identity = Object.fromEntries(OUTBOX_IMMUTABLE_FIELDS.map((field) => [
    field,
    effect[field],
  ]));
  const workOrder = projection.work_orders[effect.work_order_id];
  const materializedBranch = workOrder.branches[effect.branch_ref];
  const planBranch = workOrder.plan.branches.find(
    (candidate) => candidate.branch_ref === effect.branch_ref,
  );
  const dispatchPacketRef = materializedBranch.packet_ref;
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
    packet_ref: { id: effect.packet_ref, hash: effect.packet_hash },
    packet_binding: {
      work_order_id: effect.work_order_id,
      work_order_revision: workOrder.revision,
      engine_contract_version: 2,
      plan_snapshot_ref: workOrder.plan_snapshot_ref,
      plan_hash: workOrder.plan_hash,
      branch_ref: effect.branch_ref,
      next_attempt: effect.attempt,
      task_intent_ref: planBranch.task_intent_ref,
      execution_plan_ref: planBranch.execution_plan_ref,
      dispatch_packet_ref: dispatchPacketRef,
      provider_ref: effect.provider_ref,
      provider_configuration_ref: ref("provider-config:recorded"),
      workspace_ref: "workspace:observation-boundary",
      workspace_checkpoint_ref: ref("checkpoint:observation-boundary"),
      isolation_mode: planBranch.isolation,
      context_pack_ref: planBranch.context_pack_ref,
      context_manifest_ref: ref("context-manifest:observation-boundary"),
      context_binding_hash: canonicalHash({ context: effect.effect_id }),
      authority_ref: ref("authority:observation-boundary"),
      principal_type: "system",
      principal_id: "system:outbox-worker",
      project_ref: workOrder.plan.project_ref,
      permission_mode: planBranch.permission_mode,
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

function activateProviderSettlementProjection(projection, journalSequence = 0) {
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
  const cutover = {
    version: 1,
    cutover_id: `PSC-${"c".repeat(32)}`,
    actor: { type: "system", actor_id: "system:observation-test-cutover" },
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
    projection,
    journal_sequence: journalSequence,
    readiness: {
      readiness_assessment_ref: {
        id: `PSA-${assessmentHash.slice(0, 32)}`,
        hash: assessmentHash,
      },
      assessment,
    },
    occurred_at: CREATED_AT,
  });
  return projectBatches([built.request], projection);
}

function providerSettlementActivatedProjection() {
  return activateProviderSettlementProjection(initialBusinessProjectionV1(), 0);
}

function threadSendingFixture({
  claimReceiptFencingToken = true,
  plan = null,
  settlementActivated = true,
  sendBegun = true,
} = {}) {
  const fixture = startFixture({ plan });
  const initial = settlementActivated
    ? providerSettlementActivatedProjection()
    : initialBusinessProjectionV1();
  const started = projectBatches([fixture.batch], initial);
  const effect = started.outbox[fixture.effect.effect_id];
  const identity = Object.fromEntries(OUTBOX_IMMUTABLE_FIELDS.map((field) => [
    field,
    effect[field],
  ]));
  const lease = {
    lease_id: "lease:thread-boundary",
    owner_id: "worker:thread-boundary",
    generation: 1,
    claimed_at: "2026-08-09T00:00:10.000Z",
    heartbeat_at: "2026-08-09T00:00:10.000Z",
    expires_at: "2026-08-09T00:00:40.000Z",
  };
  const claim = inputBatch(fixture.plan, {
    sourceId: "INT-thread-boundary-claim",
    sourceType: "internal_action",
    prior: 1,
    target: 1,
    occurredAt: lease.claimed_at,
    events: [{
      type: "business.outbox.claimed",
      specific: { effect_id: effect.effect_id, effect: identity, lease },
    }],
    result: {
      internal_action_id: "INT-thread-boundary-claim",
      work_order_id: WORK_ORDER_ID,
      work_order_revision: 1,
      effect_id: effect.effect_id,
      action: "outbox.claim",
      outbox_status: "claimed",
      ...(claimReceiptFencingToken ? {
        fencing_token: {
          lease_id: lease.lease_id,
          owner_id: lease.owner_id,
          generation: lease.generation,
        },
      } : {}),
    },
  });
  const claimed = projectBatches([claim], started);
  if (!sendBegun) {
    return {
      ...fixture,
      effect,
      lease,
      projection: claimed,
      sequence: settlementActivated ? 3 : 2,
    };
  }
  const sendPacketReceipt = settlementActivated
    ? packetVerificationReceipt(claimed, effect)
    : null;
  const send = settlementActivated
    ? sendAuthorizationBatch({
      plan: fixture.plan,
      projection: claimed,
      effect,
      identity,
      lease,
      packetReceipt: sendPacketReceipt,
      sourceId: "INT-thread-boundary-send",
      revision: 1,
      occurredAt: "2026-08-09T00:00:11.000Z",
    })
    : inputBatch(fixture.plan, {
      sourceId: "INT-thread-boundary-send",
      sourceType: "internal_action",
      prior: 1,
      target: 1,
      occurredAt: "2026-08-09T00:00:11.000Z",
      events: [{
        type: "business.outbox.send_begun",
        specific: {
          effect_id: effect.effect_id,
          effect: identity,
          lease_id: lease.lease_id,
          lease_owner_id: lease.owner_id,
          lease_generation: lease.generation,
        },
      }],
    });
  return {
    ...fixture,
    effect,
    lease,
    projection: projectBatches([send], claimed),
    sequence: settlementActivated ? 4 : 3,
  };
}

function presendFailureObservation(plan, effect, lease, {
  digit = "f",
  revision = 1,
  reason = "packet_integrity_failed",
} = {}) {
  const payload = {
    effect_id: effect.effect_id,
    effect_contract_version: effect.effect_contract_version,
    effect_kind: effect.effect_kind,
    branch_ref: effect.branch_ref,
    attempt: effect.attempt,
    dispatch_id: effect.dispatch_id,
    claimed_fencing_token: {
      lease_id: lease.lease_id,
      owner_id: lease.owner_id,
      generation: lease.generation,
    },
    failure_reason: reason,
    failure_record_ref: derivedRef("PFR", {
      effect_id: effect.effect_id,
      lease_id: lease.lease_id,
      reason,
    }),
  };
  return {
    version: 2,
    observation_id: `OBS-${digit.repeat(32)}`,
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

function leaseEffectProjection(projection, plan, effect, {
  label,
  claimedAt,
  sendBegun = false,
}) {
  const identity = Object.fromEntries(OUTBOX_IMMUTABLE_FIELDS.map((field) => [
    field,
    effect[field],
  ]));
  const lease = {
    lease_id: `lease:${label}`,
    owner_id: `worker:${label}`,
    generation: 1,
    claimed_at: claimedAt,
    heartbeat_at: claimedAt,
    expires_at: new Date(Date.parse(claimedAt) + 30_000).toISOString(),
  };
  const revision = projection.work_orders[WORK_ORDER_ID].revision;
  const claim = inputBatch(plan, {
    sourceId: `INT-${label}-claim`,
    sourceType: "internal_action",
    prior: revision,
    target: revision,
    occurredAt: claimedAt,
    events: [{
      type: "business.outbox.claimed",
      specific: { effect_id: effect.effect_id, effect: identity, lease },
    }],
    result: {
      internal_action_id: `INT-${label}-claim`,
      work_order_id: WORK_ORDER_ID,
      work_order_revision: revision,
      effect_id: effect.effect_id,
      action: "outbox.claim",
      outbox_status: "claimed",
      fencing_token: {
        lease_id: lease.lease_id,
        owner_id: lease.owner_id,
        generation: lease.generation,
      },
    },
  });
  const claimed = projectBatches([claim], projection);
  if (!sendBegun) return { projection: claimed, lease, batches: 1 };
  const packetReceipt = packetVerificationReceipt(claimed, effect);
  const sendAt = new Date(Date.parse(claimedAt) + 1).toISOString();
  const send = sendAuthorizationBatch({
    plan,
    projection: claimed,
    effect,
    identity,
    lease,
    packetReceipt,
    sourceId: `INT-${label}-send`,
    revision,
    occurredAt: sendAt,
  });
  return { projection: projectBatches([send], claimed), lease, batches: 2 };
}

function observation(plan, name, payload, {
  digit = "1",
  revision = 1,
  actorType,
  actorId,
} = {}) {
  const type = actorType || (name === "verification.recorded" || name === "review.recorded"
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
  const id = actorId || `${type}:primary`;
  return {
    version: 1,
    observation_id: `OBS-${digit.repeat(32)}`,
    work_order_id: WORK_ORDER_ID,
    plan_snapshot_ref: plan.plan_snapshot_id,
    plan_hash: plan.plan_hash,
    work_order_revision: revision,
    actor: { type, actor_id: id },
    name,
    payload,
    payload_hash: canonicalHash(payload),
  };
}

function derivedRef(prefix, content) {
  const hash = canonicalHash(content);
  return { id: `${prefix}-${hash.slice(0, 32)}`, hash };
}

function settlementObservation(plan, payload, {
  digit = "9",
  revision = 1,
} = {}) {
  return {
    version: 2,
    observation_id: `OBS-${digit.repeat(32)}`,
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

function sendExpiryObservation(plan, effect, lease, {
  digit = "a",
  revision = 1,
} = {}) {
  const payload = {
    effect_id: effect.effect_id,
    effect_contract_version: effect.effect_contract_version,
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
    expiry_receipt_ref: derivedRef("EXP", {
      effect_id: effect.effect_id,
      lease_id: lease.lease_id,
      lease_expires_at: lease.expires_at,
    }),
  };
  return {
    version: 2,
    observation_id: `OBS-${digit.repeat(32)}`,
    work_order_id: WORK_ORDER_ID,
    plan_snapshot_ref: plan.plan_snapshot_id,
    plan_hash: plan.plan_hash,
    work_order_revision: revision,
    actor: { type: "runtime", actor_id: "runtime:settlement" },
    name: "provider.effect.send_expiration.recorded",
    payload,
    payload_hash: canonicalHash(payload),
  };
}

function workerSettlementPayload(effect, lease, {
  classification = "accepted",
  workerResultRef = derivedRef("WRR", {
    effect_id: effect.effect_id,
    lease_id: lease.lease_id,
    classification,
  }),
} = {}) {
  return {
    effect_id: effect.effect_id,
    effect_contract_version: effect.effect_contract_version,
    effect_kind: effect.effect_kind,
    branch_ref: effect.branch_ref,
    attempt: effect.attempt,
    dispatch_id: effect.dispatch_id,
    classification,
    settlement_source: "worker_result",
    worker_fencing_token: {
      lease_id: lease.lease_id,
      owner_id: lease.owner_id,
      generation: lease.generation,
    },
    worker_result_ref: workerResultRef,
  };
}

function recoveryProbeSettlementPayload(effect, {
  classification = "not_sent",
  mutationIdempotencyKey = effect.idempotency_key,
  probeNonce = null,
} = {}) {
  return {
    effect_id: effect.effect_id,
    effect_contract_version: effect.effect_contract_version,
    effect_kind: effect.effect_kind,
    branch_ref: effect.branch_ref,
    attempt: effect.attempt,
    dispatch_id: effect.dispatch_id,
    classification,
    settlement_source: "recovery_probe",
    recovery_probe: {
      probe_receipt_ref: derivedRef("PRB", {
        effect_id: effect.effect_id,
        mutation_idempotency_key: mutationIdempotencyKey,
        classification,
        probe_nonce: probeNonce,
      }),
      mutation_idempotency_key: mutationIdempotencyKey,
    },
  };
}

function applyRequest(projection, request) {
  let next = projection;
  for (const event of request.events) next = projectBusinessEventV1(next, event, request);
  return next;
}

function memoryStore(initialProjection, initialSequence = 1, hook = null) {
  let projection = initialProjection;
  let sequence = initialSequence;
  let commits = 0;
  return {
    get commitCalls() { return commits; },
    get state() { return projection; },
    async replay() {
      return { state: projection, watermark: { journal_sequence: sequence } };
    },
    async commit(request) {
      commits += 1;
      if (request.expected_revision !== sequence) {
        throw Object.assign(new Error("CAS conflict"), { code: "EVENT_REVISION_CONFLICT" });
      }
      const instruction = hook ? await hook({ commits, request }) : null;
      if (instruction && instruction.type === "conflict") {
        projection = instruction.projection;
        sequence += 1;
        throw Object.assign(new Error("CAS conflict"), { code: "EVENT_REVISION_CONFLICT" });
      }
      if (instruction === "conflict") {
        sequence += 1; // Represents a concurrent non-Business journal batch.
        throw Object.assign(new Error("CAS conflict"), { code: "EVENT_REVISION_CONFLICT" });
      }
      projection = applyRequest(projection, request);
      sequence += 1;
      if (instruction === "response-lost") {
        throw Object.assign(new Error("response lost after commit"), { code: "TRANSPORT_LOST" });
      }
      return { status: "committed", sequence };
    },
  };
}

const PROVIDER_NAMES = new Set([
  "provider.effect.settlement.recorded",
  "provider.effect.send_expiration.recorded",
  "provider.effect.presend_failure.recorded",
  "provider.effect.delivery.recorded",
  "branch.dispatch.accepted",
  "branch.dispatch.not_sent",
  "branch.progress",
  "branch.result.submitted",
  "branch.failed",
  "branch.timed_out",
  "branch.delivery_unknown",
  "branch.cancelled",
  "user_input.requested",
  "provider.rate_limited",
  "provider.unavailable",
]);

function defaultFacts(input, deliveryEffect = null) {
  const facts = { observation_evidence_refs: ["evidence:trusted-runtime-record"] };
  if (PROVIDER_NAMES.has(input.name)) facts.provider_ref = "provider:recorded";
  const classification = [
    "provider.effect.delivery.recorded",
    "provider.effect.settlement.recorded",
  ].includes(input.name)
    ? input.payload.classification
    : ({
    "branch.dispatch.accepted": "accepted",
    "branch.dispatch.not_sent": "not_sent",
    "branch.delivery_unknown": "delivery_unknown",
    })[input.name];
  if (classification === "accepted") {
    facts.runtime_identity = [
      "provider.effect.delivery.recorded",
      "provider.effect.settlement.recorded",
    ].includes(input.name)
      && input.payload.effect_kind === "provider.thread.create"
      ? {
        operation_id: "operation:thread-create",
        thread_id: "thread:recorded",
        turn_id: null,
      }
      : {
        operation_id: "operation:recorded",
        thread_id: "thread:recorded",
        turn_id: "turn:recorded",
      };
  }
  if (classification && deliveryEffect
      && input.name !== "provider.effect.settlement.recorded") {
    facts.delivery_attestation = {
      effect_id: deliveryEffect.effect_id,
      idempotency_key: deliveryEffect.idempotency_key,
      provider_ref: deliveryEffect.provider_ref,
      classification,
      runtime_identity: classification === "accepted" ? facts.runtime_identity : null,
      evidence_refs: [...facts.observation_evidence_refs],
    };
  }
  if (input.name === "provider.effect.settlement.recorded" && deliveryEffect) {
    const commonAttestation = {
      effect_id: deliveryEffect.effect_id,
      idempotency_key: deliveryEffect.idempotency_key,
      provider_ref: deliveryEffect.provider_ref,
      classification,
      settlement_source: input.payload.settlement_source,
      runtime_identity: classification === "accepted" ? facts.runtime_identity : null,
      evidence_refs: [...facts.observation_evidence_refs],
    };
    facts.settlement_attestation = input.payload.settlement_source === "worker_result"
      ? {
        ...commonAttestation,
        worker_fencing_token: structuredClone(input.payload.worker_fencing_token),
        worker_result_ref: structuredClone(input.payload.worker_result_ref),
      }
      : {
        ...commonAttestation,
        recovery_probe: structuredClone(input.payload.recovery_probe),
      };
    const effectStage = {
      "provider.thread.create": "thread_create",
      "provider.turn.start": "turn_start",
      "provider.user_input.submit": "user_input_submit",
      "provider.turn.cancel": "turn_cancel",
    }[deliveryEffect.effect_kind];
    const reason = input.payload.settlement_source === "recovery_probe"
      ? ({
        accepted: "recovery_probe_found",
        not_sent: "recovery_probe_authoritative_absence",
        delivery_unknown: "recovery_probe_inconclusive",
      })[classification]
      : ({
        accepted: "provider_acknowledged",
        not_sent: "provider_deferred_no_mutation",
        delivery_unknown: "worker_transport_ambiguous",
      })[classification];
    facts.settlement_certainty_fact = {
      certainty_fact_version: 2,
      effect_contract_version: 2,
      effect_kind: deliveryEffect.effect_kind,
      effect_stage: effectStage,
      settlement_source: input.payload.settlement_source,
      classification,
      reason,
    };
  }
  if (input.name === "provider.effect.presend_failure.recorded" && deliveryEffect) {
    facts.presend_failure_attestation = {
      effect_id: deliveryEffect.effect_id,
      idempotency_key: deliveryEffect.idempotency_key,
      provider_ref: deliveryEffect.provider_ref,
      claimed_fencing_token: structuredClone(input.payload.claimed_fencing_token),
      failure_reason: input.payload.failure_reason,
      failure_record_ref: structuredClone(input.payload.failure_record_ref),
      evidence_refs: [...facts.observation_evidence_refs],
    };
  }
  if (input.name === "branch.delivery_unknown") facts.attention_detail_ref = ref("attention:delivery");
  if (input.name === "provider.effect.send_expiration.recorded") {
    facts.attention_detail_ref = ref("attention:send-expired");
  }
  if (input.name === "branch.timed_out") facts.attention_detail_ref = ref("attention:timeout");
  if (input.name === "provider.rate_limited" || input.name === "provider.unavailable") {
    facts.attention_detail_ref = ref("attention:provider");
  }
  if (input.name === "user_input.requested") {
    facts.current_attempt = { attempt: 1, dispatch_id: DISPATCH_ID };
  }
  if (input.name === "verification.recorded" || input.name === "review.recorded") {
    facts.verifier_ref = input.actor.actor_id;
    facts.current_result_hash = canonicalHash({ no_current_result: true });
  }
  return facts;
}

function authority(plan, input, facts, overrides = {}) {
  return {
    authorized: true,
    principal_type: "agent",
    principal_id: input.actor.actor_id,
    project_ref: plan.project_ref,
    work_order_id: input.work_order_id,
    plan_snapshot_ref: input.plan_snapshot_ref,
    plan_hash: input.plan_hash,
    allowed_observation_names: [input.name],
    allowed_branch_refs: Object.hasOwn(input.payload, "branch_ref")
      ? [input.payload.branch_ref]
      : [],
    allowed_provider_refs: facts.provider_ref ? [facts.provider_ref] : [],
    allowed_verifier_refs: facts.verifier_ref ? [facts.verifier_ref] : [],
    ...overrides,
  };
}

function dependencies(store, plan, input, overrides = {}) {
  const calls = { authenticate: 0, authorize: 0, resolveProject: 0, resolveFacts: 0 };
  const factsFactory = overrides.facts || ((args = {}) => (
    defaultFacts(
      input,
      args.delivery_effect
        || args.settlement_effect
        || args.presend_failure_effect
        || null,
    )
  ));
  const authorizer = overrides.authorizer || {
    async authenticate({ authentication }) {
      calls.authenticate += 1;
      if (authentication !== "valid-token") return null;
      return {
        type: input.actor.type === "verifier" && overrides.verifierPrincipalType === "user"
          ? "user"
          : "agent",
        id: input.actor.actor_id,
      };
    },
    async authorize(args) {
      calls.authorize += 1;
      const scopeFacts = {
        provider_ref: PROVIDER_NAMES.has(input.name) ? plan.branches[0].provider_ref : undefined,
        verifier_ref: input.actor.type === "verifier" ? input.actor.actor_id : undefined,
      };
      return authority(plan, input, scopeFacts, { principal_type: args.principal.type });
    },
  };
  const resolvers = overrides.resolvers || {
    async resolveProject() {
      calls.resolveProject += 1;
      return { project_ref: plan.project_ref };
    },
    async resolveObservationFacts(args) {
      calls.resolveFacts += 1;
      return factsFactory(args);
    },
  };
  return {
    calls,
    boundary: createBusinessObservationBoundary({
      eventStore: store,
      authorizer,
      resolvers,
      clock: overrides.clock || (() => OBSERVED_AT),
      maxGlobalCasRetries: overrides.maxGlobalCasRetries ?? 3,
      dependencyTimeoutMs: overrides.dependencyTimeoutMs ?? 1_000,
    }),
  };
}

async function acceptEffectAtBoundary(projection, sequence, plan, effect, lease, {
  digit,
  occurredAt,
}) {
  const input = settlementObservation(
    plan,
    workerSettlementPayload(effect, lease),
    { digit, revision: projection.work_orders[WORK_ORDER_ID].revision },
  );
  const store = memoryStore(projection, sequence);
  const deps = dependencies(store, plan, input, { clock: () => occurredAt });
  await deps.boundary.execute({ observation: input, authentication: "valid-token" });
  return { projection: store.state, sequence: sequence + 1 };
}

async function runningProjectionFixture() {
  const fixture = threadSendingFixture();
  let current = await acceptEffectAtBoundary(
    fixture.projection,
    fixture.sequence,
    fixture.plan,
    fixture.effect,
    fixture.lease,
    { digit: "1", occurredAt: "2026-08-09T00:00:12.000Z" },
  );
  const turn = Object.values(current.projection.outbox).find(
    (effect) => effect.effect_kind === "provider.turn.start" && effect.status === "pending",
  );
  const leased = leaseEffectProjection(current.projection, fixture.plan, turn, {
    label: "turn-running-fixture",
    claimedAt: "2026-08-09T00:00:13.000Z",
    sendBegun: true,
  });
  current = await acceptEffectAtBoundary(
    leased.projection,
    current.sequence + leased.batches,
    fixture.plan,
    turn,
    leased.lease,
    { digit: "2", occurredAt: "2026-08-09T00:00:14.000Z" },
  );
  return { ...fixture, ...current };
}

function commandEnvelope(plan, name, payload, revision, digit) {
  const actorType = name === "user_input.resolve" ? "user" : "orchestrator";
  return {
    version: 1,
    command_id: `CMD-${digit.repeat(32)}`,
    work_order_id: WORK_ORDER_ID,
    plan_snapshot_ref: plan.plan_snapshot_id,
    plan_hash: plan.plan_hash,
    expected_work_order_revision: revision,
    actor: { type: actorType, actor_id: `${actorType}:presend-fixture` },
    name,
    payload,
    payload_hash: canonicalHash(payload),
  };
}

async function claimedEffectFixture(effectKind) {
  if (effectKind === "provider.thread.create") {
    return threadSendingFixture({ sendBegun: false });
  }
  if (effectKind === "provider.turn.start") {
    const fixture = threadSendingFixture();
    const accepted = await acceptEffectAtBoundary(
      fixture.projection,
      fixture.sequence,
      fixture.plan,
      fixture.effect,
      fixture.lease,
      { digit: "3", occurredAt: "2026-08-09T00:00:12.000Z" },
    );
    const effect = Object.values(accepted.projection.outbox).find(
      (candidate) => candidate.effect_kind === effectKind && candidate.status === "pending",
    );
    const leased = leaseEffectProjection(accepted.projection, fixture.plan, effect, {
      label: "turn-presend-fixture",
      claimedAt: "2026-08-09T00:00:13.000Z",
    });
    return {
      ...fixture,
      effect,
      lease: leased.lease,
      projection: leased.projection,
      sequence: accepted.sequence + leased.batches,
    };
  }
  const running = await runningProjectionFixture();
  let projection = running.projection;
  let sequence = running.sequence;
  if (effectKind === "provider.user_input.submit") {
    const requested = observation(running.plan, "user_input.requested", {
      branch_ref: "branch:solo",
      request_id: `REQ-${"a".repeat(32)}`,
      prompt_ref: ref("prompt:presend-fixture"),
    }, {
      digit: "4",
      revision: projection.work_orders[WORK_ORDER_ID].revision,
      actorType: "provider",
      actorId: "provider:presend-fixture",
    });
    const branch = projection.work_orders[WORK_ORDER_ID].branches["branch:solo"];
    const requestDecision = decideWorkOrderV1(
      projection.work_orders[WORK_ORDER_ID],
      requested,
      {
        occurred_at: "2026-08-09T00:00:15.000Z",
        authenticated_principal: { type: "agent", id: requested.actor.actor_id },
        observation_evidence_refs: ["evidence:presend-request"],
        current_attempt: { attempt: branch.attempt, dispatch_id: branch.dispatch_id },
      },
    );
    projection = projectBatches([decisionBatch(requested, requestDecision)], projection);
    sequence += 1;
    const responseRef = ref("response:presend-fixture");
    const resolved = commandEnvelope(running.plan, "user_input.resolve", {
      request_id: requested.payload.request_id,
      response_ref: responseRef,
    }, projection.work_orders[WORK_ORDER_ID].revision, "5");
    const resolveDecision = decideWorkOrderV1(
      projection.work_orders[WORK_ORDER_ID],
      resolved,
      {
        occurred_at: "2026-08-09T00:00:15.100Z",
        resolved_response_ref: responseRef,
        dispatch_packets: { "branch:solo": ref("packet:presend-input") },
      },
    );
    projection = projectBatches([commandDecisionBatch(resolved, resolveDecision)], projection);
    sequence += 1;
  } else {
    const cancelled = commandEnvelope(running.plan, "work_order.cancel.request", {
      reason: "exercise claimed cancel pre-send failure",
    }, projection.work_orders[WORK_ORDER_ID].revision, "6");
    const cancelDecision = decideWorkOrderV1(
      projection.work_orders[WORK_ORDER_ID],
      cancelled,
      {
        occurred_at: "2026-08-09T00:00:15.000Z",
        cancel_packets: { "branch:solo": ref("packet:presend-cancel") },
      },
    );
    projection = projectBatches([commandDecisionBatch(cancelled, cancelDecision)], projection);
    sequence += 1;
  }
  const effect = Object.values(projection.outbox).find(
    (candidate) => candidate.effect_kind === effectKind && candidate.status === "pending",
  );
  const leased = leaseEffectProjection(projection, running.plan, effect, {
    label: effectKind.replaceAll(".", "-"),
    claimedAt: "2026-08-09T00:00:15.200Z",
  });
  return {
    ...running,
    effect,
    lease: leased.lease,
    projection: leased.projection,
    sequence: sequence + leased.batches,
  };
}

function isBoundaryError(code) {
  return (error) => {
    assert.ok(error instanceof BusinessObservationBoundaryError);
    assert.equal(error.code, code);
    return true;
  };
}

function projectionConfig() {
  return {
    reducers: Object.fromEntries(BUSINESS_EVENT_TYPES.map((type) => [
      type,
      (state, event, batch) => projectBusinessEventV1(state, event, batch),
    ])),
    initialState: initialBusinessProjectionV1(),
  };
}

test("commits an authenticated observation and receipt through a preflight EventStore", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-observation-boundary-"));
  try {
    const fixture = startFixture();
    const config = projectionConfig();
    const store = createEventStore({
      stateRoot: root,
      workspaceId: "observation-boundary-real-store",
      preflightProjection: true,
      ...config,
      clock: () => "2026-08-09T00:00:20.000Z",
    });
    assert.deepEqual(store.commit({
      expected_revision: 0,
      batch_id: fixture.batch.batch_id,
      actor: { type: "agent", id: "orchestrator:seed" },
      correlation_id: START_SOURCE,
      events: fixture.batch.events,
    }), { status: "committed", sequence: 1 });
    const input = observation(fixture.plan, "branch.timed_out", {
      branch_ref: "branch:solo",
      attempt: 1,
      timeout_ms: 60_000,
    }, { digit: "1" });
    const deps = dependencies(store, fixture.plan, input, {
      clock: () => ATTEMPT_DEADLINE,
    });
    const result = await deps.boundary.execute({ observation: input, authentication: "valid-token" });

    assert.equal(result.branch_state, "cancelled");
    const replay = store.replay(config);
    assert.equal(
      replay.state.work_orders[WORK_ORDER_ID].branches["branch:solo"].state,
      "cancelled",
    );
    assert.equal(replay.state.observation_receipts[input.observation_id].identity_hash, canonicalHash({
      source_type: "observation",
      observation: input,
      authenticated_principal: { type: "agent", id: "runtime:primary" },
    }));
    assert.equal(replay.watermark.journal_sequence, 2);
    assert.equal(fs.readFileSync(path.join(root, "events.jsonl"), "utf8").trim().split("\n").length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fails closed for forged actor, provider, and verifier bindings", async () => {
  const fixture = startFixture();
  const projection = projectBatches([fixture.batch]);

  const actorInput = observation(fixture.plan, "branch.timed_out", {
    branch_ref: "branch:solo",
    attempt: 1,
    timeout_ms: 60_000,
  }, { digit: "2" });
  const actorStore = memoryStore(projection);
  const actorDeps = dependencies(actorStore, fixture.plan, actorInput, {
    authorizer: {
      async authenticate() { return { type: "agent", id: "runtime:impostor" }; },
      async authorize() { throw new Error("must not authorize"); },
    },
  });
  await assert.rejects(
    actorDeps.boundary.execute({ observation: actorInput, authentication: "ignored" }),
    isBoundaryError("BUSINESS_OBSERVATION_ACTOR_BINDING_MISMATCH"),
  );
  assert.equal(actorStore.commitCalls, 0);

  const wrongGrantStore = memoryStore(projection);
  const wrongGrantDeps = dependencies(wrongGrantStore, fixture.plan, actorInput, {
    authorizer: {
      async authenticate() { return { type: "agent", id: "runtime:primary" }; },
      async authorize() {
        return authority(fixture.plan, actorInput, defaultFacts(actorInput), {
          principal_type: "system",
        });
      },
    },
  });
  await assert.rejects(
    wrongGrantDeps.boundary.execute({ observation: actorInput, authentication: "ignored" }),
    isBoundaryError("BUSINESS_OBSERVATION_AUTHORIZATION_DENIED"),
  );
  assert.equal(wrongGrantStore.commitCalls, 0);

  const providerInput = observation(fixture.plan, "branch.timed_out", {
    branch_ref: "branch:solo",
    attempt: 1,
    timeout_ms: 60_000,
  }, { digit: "3" });
  const providerStore = memoryStore(projection);
  const providerDeps = dependencies(providerStore, fixture.plan, providerInput, {
    facts: () => ({
      observation_evidence_refs: ["evidence:forged-provider"],
      provider_ref: "provider:forged",
    }),
  });
  await assert.rejects(
    providerDeps.boundary.execute({ observation: providerInput, authentication: "valid-token" }),
    isBoundaryError("BUSINESS_OBSERVATION_PROVIDER_BINDING_MISMATCH"),
  );
  assert.equal(providerStore.commitCalls, 0);

  const verifierInput = observation(fixture.plan, "verification.recorded", {
    branch_ref: "branch:solo",
    criterion_id: "criterion:tests",
    verification_ref: fixture.plan.acceptance_policy.criteria[0]
      .verification_requirements[0].verification_ref,
    kind: "deterministic",
    status: "passed",
    evidence_refs: ["evidence:forged-verification"],
  }, { digit: "4" });
  const verifierStore = memoryStore(projection);
  const verifierDeps = dependencies(verifierStore, fixture.plan, verifierInput, {
    facts: () => ({
      observation_evidence_refs: ["evidence:forged-verifier"],
      verifier_ref: "verifier:impostor",
      current_result_hash: canonicalHash({ no_current_result: true }),
    }),
  });
  await assert.rejects(
    verifierDeps.boundary.execute({ observation: verifierInput, authentication: "valid-token" }),
    isBoundaryError("BUSINESS_OBSERVATION_VERIFIER_BINDING_MISMATCH"),
  );
  assert.equal(verifierStore.commitCalls, 0);
});

test("withholds only public live observations awaiting callback-owned fencing", async () => {
  const fixture = startFixture();
  const projection = projectBatches([fixture.batch]);
  const branchAttempt = { branch_ref: "branch:solo", attempt: 1 };
  const cases = [
    ["work_order.started", {}],
    ["provider.effect.delivery.recorded", {
      effect_id: fixture.effect.effect_id,
      effect_contract_version: 2,
      effect_kind: fixture.effect.effect_kind,
      ...branchAttempt,
      dispatch_id: DISPATCH_ID,
      classification: "accepted",
    }],
    ["branch.dispatch.accepted", { ...branchAttempt, dispatch_id: DISPATCH_ID }],
    ["branch.dispatch.not_sent", {
      ...branchAttempt,
      dispatch_id: DISPATCH_ID,
      reason: "The provider mutation was not attempted.",
    }],
    ["branch.progress", { ...branchAttempt, message: "Unbound progress callback." }],
    ["branch.result.submitted", {
      ...branchAttempt,
      artifact_refs: [ref("artifact:unbound-result")],
      evidence_refs: ["evidence:unbound-result"],
    }],
    ["branch.failed", { ...branchAttempt, failure_code: "provider:unbound-failure" }],
    ["branch.delivery_unknown", {
      ...branchAttempt,
      dispatch_id: DISPATCH_ID,
      detail: "The callback cannot prove which lease generation sent the mutation.",
    }],
    ["branch.cancelled", { ...branchAttempt, reason: "Unbound provider cancellation." }],
    ["user_input.requested", {
      branch_ref: "branch:solo",
      request_id: `REQ-${"b".repeat(32)}`,
      prompt_ref: ref("prompt:unbound-request"),
    }],
    ["provider.rate_limited", { ...branchAttempt, retry_after_ms: 1_000 }],
    ["provider.unavailable", { ...branchAttempt, detail: "Unbound provider status." }],
  ];

  for (const [index, [name, payload]] of cases.entries()) {
    const input = observation(fixture.plan, name, payload, {
      digit: index.toString(16),
    });
    const store = memoryStore(projection);
    const deps = dependencies(store, fixture.plan, input);

    await assert.rejects(
      deps.boundary.execute({ observation: input, authentication: "valid-token" }),
      isBoundaryError("BUSINESS_OBSERVATION_TURN_BINDING_REQUIRED"),
      name,
    );
    assert.equal(deps.calls.authenticate, 1, name);
    assert.equal(deps.calls.authorize, 1, name);
    assert.equal(deps.calls.resolveProject, 1, name);
    assert.equal(deps.calls.resolveFacts, 0, name);
    assert.equal(store.commitCalls, 0, name);
    assert.equal(store.state.observation_receipts[input.observation_id], undefined, name);
  }
});

test("rejects a new live observation for a frozen V1 Work Order before fact resolution", async () => {
  const fixture = startFixture({ engineVersion: 1 });
  const projection = projectBatches([fixture.batch]);
  const input = observation(fixture.plan, "branch.timed_out", {
    branch_ref: "branch:solo",
    attempt: 1,
    timeout_ms: 60_000,
  }, { digit: "e" });
  const store = memoryStore(projection);
  const deps = dependencies(store, fixture.plan, input, {
    clock: () => ATTEMPT_DEADLINE,
  });

  await assert.rejects(
    deps.boundary.execute({ observation: input, authentication: "valid-token" }),
    isBoundaryError("BUSINESS_ENGINE_MIGRATION_REQUIRED"),
  );
  assert.equal(deps.calls.authorize, 1);
  assert.equal(deps.calls.resolveFacts, 0);
  assert.equal(store.commitCalls, 0);
});

test("derives cancellation quiescence from the projection instead of resolver claims", async () => {
  const fixture = startFixture();
  const projection = structuredClone(projectBatches([fixture.batch]));
  const workOrder = projection.work_orders[WORK_ORDER_ID];
  const branch = workOrder.branches["branch:solo"];
  const ambiguityAt = "2026-08-09T00:00:01.000Z";
  workOrder.status = "cancelling";
  branch.state = "delivery_unknown";
  branch.delivery = {
    classification: "delivery_unknown",
    observed_at: ambiguityAt,
  };
  fixture.effect.status = "delivery_unknown";
  fixture.effect.delivery = {
    classification: "delivery_unknown",
    runtime_identity: null,
    evidence_refs: ["evidence:ambiguous-start"],
    recorded_at: ambiguityAt,
  };
  fixture.effect.updated_at = ambiguityAt;
  projection.outbox[fixture.effect.effect_id] = structuredClone(fixture.effect);
  workOrder.attention["attention:ambiguous-start"] = {
    attention_id: "attention:ambiguous-start",
    kind: "delivery_unknown",
    branch_ref: "branch:solo",
    effect_id: fixture.effect.effect_id,
    detail_ref: ref("detail:ambiguous-start"),
    evidence_refs: ["evidence:ambiguous-start"],
    opened_at: ambiguityAt,
    status: "open",
    resolution: null,
  };
  const input = observation(fixture.plan, "work_order.cancelled", {
    reason: "Runtime reported cancellation while a mutation remains pending.",
  }, { digit: "d" });

  const injectedStore = memoryStore(projection);
  const injected = dependencies(injectedStore, fixture.plan, input, {
    facts: () => ({
      observation_evidence_refs: ["evidence:forged-quiescence"],
      mutating_effects_quiescent: true,
    }),
  });
  await assert.rejects(
    injected.boundary.execute({ observation: input, authentication: "valid-token" }),
    isBoundaryError("BUSINESS_OBSERVATION_FACTS_UNVERIFIED"),
  );
  assert.equal(injectedStore.commitCalls, 0);

  const store = memoryStore(projection);
  const deps = dependencies(store, fixture.plan, input);
  const result = await deps.boundary.execute({
    observation: input,
    authentication: "valid-token",
  });
  assert.equal(result.status, "quarantined");
  assert.equal(result.reason, "cancellation_not_quiescent");
  assert.equal(store.state.work_orders[WORK_ORDER_ID].status, "cancelling");
  assert.equal(store.state.outbox[fixture.effect.effect_id].status, "delivery_unknown");
});

test("derives the exact current V2 start effect when an unsent attempt times out", async () => {
  const fixture = startFixture();
  const projection = projectBatches([fixture.batch]);
  const input = observation(fixture.plan, "branch.timed_out", {
    branch_ref: "branch:solo",
    attempt: 1,
    timeout_ms: 60_000,
  }, { digit: "a" });
  const store = memoryStore(projection);
  const deps = dependencies(store, fixture.plan, input, {
    clock: () => ATTEMPT_DEADLINE,
  });
  const result = await deps.boundary.execute({
    observation: input,
    authentication: "valid-token",
  });

  assert.equal(result.branch_state, "cancelled");
  assert.equal(store.state.outbox[fixture.effect.effect_id].status, "cancelled");
  assert.equal(
    store.state.work_orders[WORK_ORDER_ID].branches["branch:solo"].state,
    "cancelled",
  );
  assert.ok(store.state.observation_receipts[input.observation_id]);
});

test("replay-only mode never turns a receipt miss into a new observation write", async () => {
  const fixture = startFixture();
  const projection = projectBatches([fixture.batch]);
  const input = observation(fixture.plan, "branch.timed_out", {
    branch_ref: "branch:solo",
    attempt: 1,
    timeout_ms: 60_000,
  }, { digit: "7" });
  const store = memoryStore(projection);
  const deps = dependencies(store, fixture.plan, input, {
    clock: () => ATTEMPT_DEADLINE,
  });

  await assert.rejects(
    deps.boundary.execute({
      observation: input,
      authentication: "valid-token",
      replay_only: true,
    }),
    isBoundaryError("BUSINESS_OBSERVATION_RECEIPT_NOT_FOUND"),
  );
  assert.equal(deps.calls.resolveFacts, 0);
  assert.equal(store.commitCalls, 0);
  assert.equal(store.state.work_orders[WORK_ORDER_ID].revision, 1);
});

test("replays an exact stored provider receipt before the live fencing gate", async () => {
  const fixture = threadSendingFixture({ settlementActivated: false });
  const input = observation(fixture.plan, "provider.effect.delivery.recorded", {
    effect_id: fixture.effect.effect_id,
    effect_contract_version: 2,
    effect_kind: "provider.thread.create",
    branch_ref: "branch:solo",
    attempt: 1,
    dispatch_id: DISPATCH_ID,
    classification: "accepted",
  }, { digit: "0" });
  const effectIdentity = Object.fromEntries(OUTBOX_IMMUTABLE_FIELDS.map((field) => [
    field,
    fixture.effect[field],
  ]));
  const decision = decideWorkOrderV1(
    fixture.projection.work_orders[WORK_ORDER_ID],
    input,
    {
      occurred_at: OBSERVED_AT,
      authenticated_principal: { type: "agent", id: input.actor.actor_id },
      observation_evidence_refs: ["evidence:stored-thread-create-accepted"],
      runtime_identity: {
        operation_id: "operation:stored-thread-create",
        thread_id: "thread:stored",
        turn_id: null,
      },
      delivery_effect: {
        ...effectIdentity,
        fencing_token: {
          lease_id: fixture.lease.lease_id,
          owner_id: fixture.lease.owner_id,
          generation: fixture.lease.generation,
        },
        status: "sending",
      },
    },
  );
  const recorded = decisionBatch(input, decision);
  const historicalProjection = projectBatches([recorded], fixture.projection);
  const projection = activateProviderSettlementProjection(
    historicalProjection,
    fixture.sequence + 1,
  );
  const store = memoryStore(projection, fixture.sequence + 2);
  const deps = dependencies(store, fixture.plan, input);
  const replayed = await deps.boundary.execute({
    observation: structuredClone(input),
    authentication: "valid-token",
    replay_only: true,
  });
  assert.deepEqual(replayed, decision.result);
  assert.equal(store.commitCalls, 0);
  assert.equal(deps.calls.authenticate, 1);
  assert.equal(deps.calls.authorize, 1);
  assert.equal(deps.calls.resolveFacts, 0);
  assert.equal(store.state.outbox[fixture.effect.effect_id].status, "delivered");
  assert.equal(
    store.state.work_orders[WORK_ORDER_ID].branches["branch:solo"].thread_identity.thread_id,
    "thread:stored",
  );
  const turnEffects = Object.values(store.state.outbox).filter((effect) => (
    effect.effect_kind === "provider.turn.start"
  ));
  assert.equal(turnEffects.length, 1);
  assert.equal(turnEffects[0].status, "pending");
});

test("requires the durable global epoch before any new V2 provider settlement", async () => {
  const fixture = threadSendingFixture({ settlementActivated: false });
  const input = settlementObservation(
    fixture.plan,
    workerSettlementPayload(fixture.effect, fixture.lease),
    { digit: "e" },
  );
  const store = memoryStore(fixture.projection, fixture.sequence);
  const deps = dependencies(store, fixture.plan, input);
  await assert.rejects(
    deps.boundary.execute({ observation: input, authentication: "valid-token" }),
    isBoundaryError("BUSINESS_OBSERVATION_PROVIDER_SETTLEMENT_CUTOVER_REQUIRED"),
  );
  assert.equal(deps.calls.resolveFacts, 0);
  assert.equal(store.commitCalls, 0);
  assert.equal(store.state.outbox[fixture.effect.effect_id].status, "sending");
});

test("atomically closes a claimed pre-send control-plane failure into operator-only recovery", async () => {
  const fixture = threadSendingFixture({ sendBegun: false });
  const input = presendFailureObservation(fixture.plan, fixture.effect, fixture.lease);
  let committedRequest = null;
  const store = memoryStore(fixture.projection, fixture.sequence, ({ request }) => {
    committedRequest = structuredClone(request);
    return "response-lost";
  });
  const systemAuthorizer = {
    async authenticate() {
      return { type: "system", id: input.actor.actor_id };
    },
    async authorize(args) {
      return authority(fixture.plan, input, { provider_ref: fixture.effect.provider_ref }, {
        principal_type: args.principal.type,
      });
    },
  };
  const deps = dependencies(store, fixture.plan, input, {
    authorizer: systemAuthorizer,
    facts(args) {
      assert.deepEqual(
        args.presend_failure_effect,
        Object.fromEntries(OUTBOX_IMMUTABLE_FIELDS.map((field) => [
          field,
          fixture.effect[field],
        ])),
      );
      assert.equal(Object.hasOwn(args.presend_failure_effect, "lease"), false);
      return defaultFacts(input, args.presend_failure_effect);
    },
  });
  const result = await deps.boundary.execute({ observation: input, authentication: "system" });
  assert.equal(result.branch_state, "failed");
  assert.equal(result.disposition, "operator_attention");
  assert.equal(result.automatic_retry, false);
  assert.equal(store.state.outbox[fixture.effect.effect_id].status, "not_sent");
  assert.deepEqual(store.state.outbox[fixture.effect.effect_id].settlement_policy.retry, {
    scope: "none",
    mode: "none",
  });
  const branch = store.state.work_orders[WORK_ORDER_ID].branches["branch:solo"];
  assert.equal(branch.state, "failed");
  assert.equal(store.state.work_orders[WORK_ORDER_ID].status, "paused");
  const attention = Object.values(store.state.work_orders[WORK_ORDER_ID].attention);
  assert.equal(attention.length, 1);
  assert.equal(attention[0].kind, "provider_effect_presend_failure");
  assert.equal(attention[0].effect_id, fixture.effect.effect_id);
  assert.deepEqual(attention[0].detail_ref, input.payload.failure_record_ref);
  const lifecycle = deriveLifecycleSnapshot({
    workOrder: store.state.work_orders[WORK_ORDER_ID],
    outbox: store.state.outbox,
  });
  assert.equal(lifecycle.automation.state, "paused");
  assert.equal(lifecycle.automation.may_schedule_forward_work, false);
  assert.equal(lifecycle.automation.may_retry, false);
  assert.equal(lifecycle.automation.may_reconcile, false);
  assert.equal(lifecycle.automation.may_run_cleanup, false);
  const receipt = store.state.observation_receipts[input.observation_id];
  assert.equal(receipt.source_type, "provider_settlement");
  assert.equal(receipt.settlement_bundle.ingress_kind, "control_plane_failure");
  assert.deepEqual(receipt.settlement_bundle.provenance_ref, input.payload.failure_record_ref);

  const commits = store.commitCalls;
  const replay = dependencies(store, fixture.plan, input, {
    authorizer: systemAuthorizer,
    facts() { throw new Error("exact receipt replay must precede live effect gates"); },
  });
  assert.deepEqual(await replay.boundary.execute({
    observation: structuredClone(input),
    authentication: "system",
    replay_only: true,
  }), result);
  assert.equal(store.commitCalls, commits);
  assert.equal(replay.calls.resolveFacts, 0);

  const hostileToken = structuredClone(committedRequest);
  const runtimeEvent = hostileToken.events.find(
    (event) => event.type === "business.branch.runtime_observed",
  );
  runtimeEvent.payload.observation.payload.claimed_fencing_token.owner_id = "worker:forged";
  runtimeEvent.payload.observation.payload_hash = canonicalHash(runtimeEvent.payload.observation.payload);
  assert.throws(
    () => applyRequest(fixture.projection, hostileToken),
    (error) => error?.code === "BUSINESS_PROJECTION_SETTLEMENT_POLICY",
  );

  const generic = structuredClone(committedRequest);
  generic.events.at(-1).type = "business.observation.received";
  generic.events.at(-1).payload.receipt.source_type = "observation";
  assert.throws(
    () => applyRequest(fixture.projection, generic),
    (error) => error?.code === "BUSINESS_PROJECTION_PROVIDER_SETTLEMENT_ROUTE",
  );

  const agentStore = memoryStore(fixture.projection, fixture.sequence);
  const agentDeps = dependencies(agentStore, fixture.plan, input);
  await assert.rejects(
    agentDeps.boundary.execute({ observation: input, authentication: "valid-token" }),
    isBoundaryError("BUSINESS_OBSERVATION_PRESEND_FAILURE_SYSTEM_REQUIRED"),
  );
  assert.equal(agentStore.commitCalls, 0);

  for (const [label, mutate, expectedCode] of [
    ["missing", (facts) => { delete facts.presend_failure_attestation; },
      "BUSINESS_OBSERVATION_FACTS_UNVERIFIED"],
    ["reason", (facts) => {
      facts.presend_failure_attestation.failure_reason = "authority_failed";
    }, "BUSINESS_OBSERVATION_PRESEND_FAILURE_ATTESTATION_MISMATCH"],
    ["record", (facts) => {
      facts.presend_failure_attestation.failure_record_ref = derivedRef("PFR", {
        forged: "different-control-plane-record",
      });
    }, "BUSINESS_OBSERVATION_PRESEND_FAILURE_ATTESTATION_MISMATCH"],
    ["token", (facts) => {
      facts.presend_failure_attestation.claimed_fencing_token.owner_id = "worker:forged";
    }, "BUSINESS_OBSERVATION_PRESEND_FAILURE_ATTESTATION_MISMATCH"],
  ]) {
    const hostileStore = memoryStore(fixture.projection, fixture.sequence);
    const hostileFacts = defaultFacts(input, fixture.effect);
    mutate(hostileFacts);
    const hostileDeps = dependencies(hostileStore, fixture.plan, input, {
      authorizer: systemAuthorizer,
      facts: () => hostileFacts,
    });
    await assert.rejects(
      hostileDeps.boundary.execute({ observation: input, authentication: "system" }),
      isBoundaryError(expectedCode),
      label,
    );
    assert.equal(hostileStore.commitCalls, 0, label);
  }
});

test("uses one hostile-resistant pre-send closure for all four Effect V2 kinds", async () => {
  const cases = [
    ["provider.thread.create", "packet_integrity_failed", "7"],
    ["provider.turn.start", "authority_failed", "8"],
    ["provider.user_input.submit", "driver_capability_failed", "9"],
    ["provider.turn.cancel", "packet_integrity_failed", "a"],
  ];
  for (const [effectKind, reason, digit] of cases) {
    const fixture = await claimedEffectFixture(effectKind);
    const input = presendFailureObservation(fixture.plan, fixture.effect, fixture.lease, {
      digit,
      revision: fixture.projection.work_orders[WORK_ORDER_ID].revision,
      reason,
    });
    let committedRequest;
    let injectedConflict = effectKind === "provider.turn.start";
    const store = memoryStore(fixture.projection, fixture.sequence, ({ request }) => {
      if (injectedConflict) {
        injectedConflict = false;
        return "conflict";
      }
      committedRequest = structuredClone(request);
      return null;
    });
    const authorizer = {
      async authenticate() { return { type: "system", id: input.actor.actor_id }; },
      async authorize(args) {
        return authority(fixture.plan, input, { provider_ref: fixture.effect.provider_ref }, {
          principal_type: args.principal.type,
        });
      },
    };
    const deps = dependencies(store, fixture.plan, input, {
      authorizer,
      clock: () => "2026-08-09T00:00:16.000Z",
    });
    const result = await deps.boundary.execute({ observation: input, authentication: "system" });
    assert.equal(result.branch_state, "failed", effectKind);
    assert.equal(result.automatic_retry, false, effectKind);
    assert.equal(store.state.outbox[fixture.effect.effect_id].status, "not_sent", effectKind);
    const branch = store.state.work_orders[WORK_ORDER_ID].branches["branch:solo"];
    assert.equal(branch.state, "failed", effectKind);
    if (effectKind === "provider.user_input.submit") {
      assert.equal(branch.open_user_input, null);
      assert.equal(branch.pending_user_input_effect_id, null);
    }
    if (effectKind === "provider.turn.cancel") assert.equal(branch.cancel_effect_id, null);
    assert.equal(committedRequest.events.filter(
      (event) => event.type === "business.outbox.enqueued",
    ).length, 0, effectKind);
    const hostile = structuredClone(committedRequest);
    const attention = hostile.events.find((event) => event.type === "business.attention.opened");
    attention.payload.attention.detail_ref = ref(`forged:presend:${effectKind}`);
    assert.throws(
      () => applyRequest(fixture.projection, hostile),
      (error) => error?.code === "BUSINESS_PROJECTION_SETTLEMENT_POLICY",
      effectKind,
    );
  }
});

test("settles a sending effect from callback-owned worker provenance and replays its exact V2 receipt", async () => {
  const fixture = threadSendingFixture();
  const input = settlementObservation(
    fixture.plan,
    workerSettlementPayload(fixture.effect, fixture.lease),
    { digit: "1" },
  );
  let committedRequest = null;
  const store = memoryStore(fixture.projection, fixture.sequence, ({ request }) => {
    committedRequest = structuredClone(request);
    return null;
  });
  const deps = dependencies(store, fixture.plan, input);

  const result = await deps.boundary.execute({
    observation: input,
    authentication: "valid-token",
  });
  assert.equal(result.branch_state, "dispatch_pending");
  assert.equal(store.state.outbox[fixture.effect.effect_id].status, "delivered");
  const branch = store.state.work_orders[WORK_ORDER_ID].branches["branch:solo"];
  assert.equal(branch.last_runtime_observation.name, "provider.effect.settlement.recorded");
  assert.deepEqual(
    branch.last_runtime_observation.payload.worker_fencing_token,
    input.payload.worker_fencing_token,
  );
  assert.deepEqual(
    branch.last_runtime_observation.payload.worker_result_ref,
    input.payload.worker_result_ref,
  );
  const storedReceipt = store.state.observation_receipts[input.observation_id];
  assert.equal(storedReceipt.source_type, "provider_settlement");
  assert.equal(storedReceipt.settlement_bundle.cutover_id,
    fixture.projection.provider_settlement_epoch.cutover_id);
  assert.equal(storedReceipt.settlement_bundle.effect_binding.effect_id, fixture.effect.effect_id);
  assert.equal(storedReceipt.settlement_bundle.ingress_kind, "worker_result");
  assert.equal(committedRequest.events.at(-1).type, "business.provider_settlement.received");

  for (const mutate of [
    (request) => { request.events.at(-1).payload.receipt.settlement_bundle
      .domain_event_manifest_hash = "f".repeat(64); },
    (request) => { request.events.at(-1).payload.receipt.settlement_bundle
      .settlement_policy_hash = "f".repeat(64); },
    (request) => { request.events.at(-1).payload.receipt.settlement_bundle
      .effect_binding.effect_id = `FX-${"f".repeat(32)}`; },
  ]) {
    const hostile = structuredClone(committedRequest);
    mutate(hostile);
    assert.throws(
      () => applyRequest(fixture.projection, hostile),
      (error) => error?.code === "BUSINESS_PROJECTION_PROVIDER_SETTLEMENT_BUNDLE",
    );
  }
  const genericSuffix = structuredClone(committedRequest);
  genericSuffix.events.at(-1).type = "business.observation.received";
  genericSuffix.events.at(-1).payload.receipt.source_type = "observation";
  assert.throws(
    () => applyRequest(fixture.projection, genericSuffix),
    (error) => error?.code === "BUSINESS_PROJECTION_PROVIDER_SETTLEMENT_ROUTE",
  );
  const preCutover = threadSendingFixture({ settlementActivated: false });
  assert.throws(
    () => applyRequest(preCutover.projection, committedRequest),
    (error) => error?.code === "BUSINESS_PROJECTION_PROVIDER_SETTLEMENT_CUTOVER",
  );

  const commits = store.commitCalls;
  const replayDeps = dependencies(store, fixture.plan, input, {
    facts() { throw new Error("receipt replay must not resolve settlement facts"); },
  });
  assert.deepEqual(await replayDeps.boundary.execute({
    observation: structuredClone(input),
    authentication: "valid-token",
    replay_only: true,
  }), result);
  assert.equal(replayDeps.calls.resolveFacts, 0);
  assert.equal(store.commitCalls, commits);

  const conflictingPayload = workerSettlementPayload(fixture.effect, fixture.lease, {
    classification: "not_sent",
  });
  const conflicting = settlementObservation(fixture.plan, conflictingPayload, {
    digit: "1",
    revision: 2,
  });
  const conflictDeps = dependencies(store, fixture.plan, conflicting);
  await assert.rejects(
    conflictDeps.boundary.execute({
      observation: conflicting,
      authentication: "valid-token",
    }),
    isBoundaryError("BUSINESS_OBSERVATION_ID_CONFLICT"),
  );
  assert.equal(store.commitCalls, commits);
});

test("derives worker fencing from claimed domain history when an older claim receipt is opaque", async () => {
  const fixture = threadSendingFixture({ claimReceiptFencingToken: false });
  const claimReceipt = fixture.projection.internal_receipts["INT-thread-boundary-claim"];
  assert.equal(Object.hasOwn(claimReceipt.result, "fencing_token"), false);
  assert.deepEqual(fixture.projection.outbox[fixture.effect.effect_id].fencing_history, [{
    lease_id: fixture.lease.lease_id,
    owner_id: fixture.lease.owner_id,
    generation: fixture.lease.generation,
  }]);
  const input = settlementObservation(
    fixture.plan,
    workerSettlementPayload(fixture.effect, fixture.lease),
    { digit: "c" },
  );
  const store = memoryStore(fixture.projection, fixture.sequence);
  const deps = dependencies(store, fixture.plan, input);
  await deps.boundary.execute({ observation: input, authentication: "valid-token" });
  assert.equal(store.state.outbox[fixture.effect.effect_id].status, "delivered");
});

test("atomically expires a V2 send into branch reconciliation with an exact receipt", async () => {
  const fixture = threadSendingFixture();
  const input = sendExpiryObservation(fixture.plan, fixture.effect, fixture.lease, {
    digit: "a",
  });
  let committed = null;
  const store = memoryStore(fixture.projection, fixture.sequence, ({ request }) => {
    committed = request;
    return null;
  });
  const deps = dependencies(store, fixture.plan, input, {
    clock: () => fixture.lease.expires_at,
  });

  const result = await deps.boundary.execute({
    observation: input,
    authentication: "valid-token",
  });
  assert.equal(result.branch_state, "delivery_unknown");
  assert.equal(result.automatic_retry, false);
  assert.equal(store.state.outbox[fixture.effect.effect_id].status, "delivery_unknown");
  assert.equal(store.state.outbox[fixture.effect.effect_id].lease, null);
  const workOrder = store.state.work_orders[WORK_ORDER_ID];
  assert.equal(workOrder.branches["branch:solo"].state, "delivery_unknown");
  assert.equal(workOrder.status, "starting");
  assert.ok(Object.values(workOrder.attention).some((attention) => (
    attention.status === "open"
      && attention.effect_id === fixture.effect.effect_id
      && attention.kind === "delivery_unknown"
  )));
  assert.deepEqual(committed.events.map((event) => event.type), [
    "business.outbox.send_expired",
    "business.branch.runtime_observed",
    "business.branch.status_changed",
    "business.attention.opened",
    "business.provider_settlement.received",
  ]);
  assert.equal(
    committed.events[0].payload.settlement_policy.reason,
    "worker_send_expired",
  );
  assert.ok(store.state.observation_receipts[input.observation_id]);

  const expectProjectionCode = (code) => (error) => error?.code === code;
  for (const mutate of [
    (request) => { request.events[0].payload.fencing_token.owner_id = "worker:forged"; },
    (request) => { request.events[0].payload.lease_expires_at = "2026-08-09T00:00:41.000Z"; },
    (request) => { request.events[0].payload.settlement_policy.reason = "worker_transport_ambiguous"; },
  ]) {
    const hostile = structuredClone(committed);
    mutate(hostile);
    assert.throws(
      () => applyRequest(fixture.projection, hostile),
      (error) => [
        "BUSINESS_PROJECTION_TRANSITION",
        "BUSINESS_PROJECTION_SETTLEMENT_POLICY",
      ].includes(error?.code),
    );
  }

  for (const omittedType of [
    "business.branch.runtime_observed",
    "business.branch.status_changed",
    "business.attention.opened",
  ]) {
    const hostile = structuredClone(committed);
    hostile.events = hostile.events.filter((event) => event.type !== omittedType);
    const receipt = hostile.events.at(-1);
    receipt.payload.receipt.event_ids = hostile.events.slice(0, -1).map((event) => event.event_id);
    assert.throws(
      () => applyRequest(fixture.projection, hostile),
      (error) => [
        "BUSINESS_PROJECTION_RECEIPT_BINDING",
        "BUSINESS_PROJECTION_SEND_EXPIRY",
        "BUSINESS_PROJECTION_PROVIDER_SETTLEMENT_ROUTE",
        "BUSINESS_PROJECTION_PROVIDER_SETTLEMENT_BUNDLE",
      ].includes(error?.code),
      omittedType,
    );
  }

  const first = committed.events[0].payload;
  const internalExpiry = inputBatch(fixture.plan, {
    sourceId: "INT-hostile-v2-send-expiry",
    sourceType: "internal_action",
    prior: 1,
    target: 1,
    occurredAt: fixture.lease.expires_at,
    events: [{
      type: "business.outbox.send_expired",
      specific: Object.fromEntries(Object.entries(first).filter(([field]) => ![
        "work_order_id",
        "plan_snapshot_ref",
        "plan_hash",
        "source_id",
        "prior_work_order_revision",
        "target_work_order_revision",
        "occurred_at",
      ].includes(field))),
    }],
  });
  assert.throws(
    () => projectBatches([internalExpiry], fixture.projection),
    expectProjectionCode("BUSINESS_PROJECTION_PROVIDER_SETTLEMENT_ROUTE"),
  );
});

test("an at-expiry worker callback atomically records ambiguity and quarantines its outcome", async () => {
  const fixture = threadSendingFixture();
  const input = settlementObservation(
    fixture.plan,
    workerSettlementPayload(fixture.effect, fixture.lease),
    { digit: "b" },
  );
  let committed = null;
  const store = memoryStore(fixture.projection, fixture.sequence, ({ request }) => {
    committed = request;
    return null;
  });
  const deps = dependencies(store, fixture.plan, input, {
    clock: () => fixture.lease.expires_at,
  });

  const result = await deps.boundary.execute({
    observation: input,
    authentication: "valid-token",
  });
  assert.equal(result.status, "quarantined");
  assert.equal(result.reason, "stale_effect_lease");
  assert.equal(store.state.outbox[fixture.effect.effect_id].status, "delivery_unknown");
  assert.ok(store.state.late_observations[input.observation_id]);
  assert.deepEqual(committed.events.map((event) => event.type), [
    "business.outbox.send_expired",
    "business.branch.status_changed",
    "business.attention.opened",
    "business.late_observation.quarantined",
    "business.provider_settlement.received",
  ]);
  assert.equal(
    committed.events[0].payload.expiry_trigger_ref.id,
    input.payload.worker_result_ref.id,
  );
});

test("journals shared settlement policy and keeps definitive rejection out of automatic retry", async () => {
  const fixture = threadSendingFixture();
  const input = settlementObservation(
    fixture.plan,
    workerSettlementPayload(fixture.effect, fixture.lease, { classification: "not_sent" }),
    { digit: "0" },
  );
  let committedRequest = null;
  const store = memoryStore(fixture.projection, fixture.sequence, ({ request }) => {
    committedRequest = request;
    return null;
  });
  const deps = dependencies(store, fixture.plan, input, {
    facts(args) {
      const facts = defaultFacts(input, args.settlement_effect);
      facts.settlement_certainty_fact.reason = "provider_rejected_no_mutation";
      return facts;
    },
  });

  const result = await deps.boundary.execute({
    observation: input,
    authentication: "valid-token",
  });
  assert.equal(result.branch_state, "retryable");
  assert.equal(result.retry_at, OBSERVED_AT);
  assert.equal(store.state.outbox[fixture.effect.effect_id].status, "not_sent");
  assert.equal(
    store.state.work_orders[WORK_ORDER_ID].branches["branch:solo"].attempt,
    1,
  );
  const runtimeEvent = committedRequest.events.find(
    (event) => event.type === "business.branch.runtime_observed",
  );
  assert.equal(runtimeEvent.payload.settlement_policy.reason, "provider_rejected_no_mutation");
  assert.equal(runtimeEvent.payload.settlement_policy.disposition, "retry_candidate");
  assert.deepEqual(runtimeEvent.payload.settlement_policy.retry, {
    scope: "effect_generation",
    mode: "explicit",
  });
});

test("an immediate start retry advances only the Effect generation", async () => {
  const plan = planFixture({
    retryPolicy: {
      backoff_initial_ms: 0,
      backoff_max_ms: 0,
    },
  });
  const fixture = threadSendingFixture({ plan });
  const input = settlementObservation(
    plan,
    workerSettlementPayload(fixture.effect, fixture.lease, { classification: "not_sent" }),
    { digit: "5" },
  );
  let committedRequest = null;
  const store = memoryStore(fixture.projection, fixture.sequence, ({ request }) => {
    committedRequest = request;
    return null;
  });
  const deps = dependencies(store, plan, input);

  const result = await deps.boundary.execute({
    observation: input,
    authentication: "valid-token",
  });
  assert.equal(result.branch_state, "dispatch_pending");
  assert.equal(result.automatic_retry, true);
  const branch = store.state.work_orders[WORK_ORDER_ID].branches["branch:solo"];
  assert.equal(branch.attempt, 1);
  assert.equal(branch.dispatch_id, DISPATCH_ID);
  assert.equal(branch.packet_ref.id, fixture.effect.packet_ref);
  const effects = Object.values(store.state.outbox).filter((effect) => (
    effect.work_order_id === WORK_ORDER_ID
      && effect.branch_ref === "branch:solo"
      && effect.effect_kind === "provider.thread.create"
  )).sort((left, right) => left.operation_generation - right.operation_generation);
  assert.equal(effects.length, 2);
  assert.equal(effects[0].status, "not_sent");
  assert.equal(effects[1].status, "pending");
  assert.equal(effects[1].operation_generation, 2);
  assert.equal(effects[1].generation_predecessor_effect_id, effects[0].effect_id);
  assert.equal(effects[1].attempt, effects[0].attempt);
  assert.equal(effects[1].dispatch_id, effects[0].dispatch_id);
  assert.equal(effects[1].packet_ref, effects[0].packet_ref);
  assert.ok(!committedRequest.events.some(
    (event) => event.type === "business.branch.attempt_opened",
  ));
});

test("an immediate turn retry preserves the accepted thread and business attempt", async () => {
  const plan = planFixture({
    retryPolicy: {
      backoff_initial_ms: 0,
      backoff_max_ms: 0,
    },
  });
  const thread = threadSendingFixture({ plan });
  const threadInput = settlementObservation(
    plan,
    workerSettlementPayload(thread.effect, thread.lease),
    { digit: "6" },
  );
  const threadStore = memoryStore(thread.projection, thread.sequence);
  await dependencies(threadStore, plan, threadInput).boundary.execute({
    observation: threadInput,
    authentication: "valid-token",
  });
  const acceptedBranch = threadStore.state.work_orders[WORK_ORDER_ID].branches["branch:solo"];
  const acceptedThreadIdentity = structuredClone(acceptedBranch.thread_identity);
  const acceptedThreadEffectId = acceptedBranch.thread_create_effect_id;
  const acceptedThreadDeliveryHash = acceptedBranch.thread_create_delivery_hash;
  const turn = Object.values(threadStore.state.outbox).find((effect) => (
    effect.effect_kind === "provider.turn.start" && effect.status === "pending"
  ));
  const identity = Object.fromEntries(OUTBOX_IMMUTABLE_FIELDS.map((field) => [
    field,
    turn[field],
  ]));
  const lease = {
    lease_id: "lease:turn-generation",
    owner_id: "worker:turn-generation",
    generation: 1,
    claimed_at: "2026-08-09T00:00:13.000Z",
    heartbeat_at: "2026-08-09T00:00:13.000Z",
    expires_at: "2026-08-09T00:00:43.000Z",
  };
  const claim = inputBatch(plan, {
    sourceId: "INT-turn-generation-claim",
    sourceType: "internal_action",
    prior: 2,
    target: 2,
    occurredAt: lease.claimed_at,
    events: [{
      type: "business.outbox.claimed",
      specific: { effect_id: turn.effect_id, effect: identity, lease },
    }],
  });
  const claimedTurnProjection = projectBatches([claim], threadStore.state);
  const turnPacketReceipt = packetVerificationReceipt(claimedTurnProjection, turn);
  const send = sendAuthorizationBatch({
    plan,
    projection: claimedTurnProjection,
    effect: turn,
    identity,
    lease,
    packetReceipt: turnPacketReceipt,
    sourceId: "INT-turn-generation-send",
    revision: 2,
    occurredAt: "2026-08-09T00:00:14.000Z",
  });
  const sendingProjection = projectBatches([claim, send], threadStore.state);
  const turnInput = settlementObservation(
    plan,
    workerSettlementPayload(turn, lease, { classification: "not_sent" }),
    { digit: "7", revision: 2 },
  );
  let committedRequest = null;
  const turnStore = memoryStore(sendingProjection, 6, ({ request }) => {
    committedRequest = request;
    return null;
  });
  const result = await dependencies(turnStore, plan, turnInput, {
    clock: () => "2026-08-09T00:00:15.000Z",
  }).boundary.execute({ observation: turnInput, authentication: "valid-token" });

  assert.equal(result.branch_state, "dispatch_pending");
  const branch = turnStore.state.work_orders[WORK_ORDER_ID].branches["branch:solo"];
  assert.equal(branch.attempt, 1);
  assert.equal(branch.dispatch_id, DISPATCH_ID);
  assert.deepEqual(branch.thread_identity, acceptedThreadIdentity);
  assert.equal(branch.thread_create_effect_id, acceptedThreadEffectId);
  assert.equal(branch.thread_create_delivery_hash, acceptedThreadDeliveryHash);
  const turns = Object.values(turnStore.state.outbox).filter((effect) => (
    effect.effect_kind === "provider.turn.start"
  )).sort((left, right) => left.operation_generation - right.operation_generation);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].status, "not_sent");
  assert.equal(turns[1].status, "pending");
  assert.equal(turns[1].operation_generation, 2);
  assert.equal(turns[1].generation_predecessor_effect_id, turns[0].effect_id);
  assert.equal(turns[1].predecessor_effect_id, acceptedThreadEffectId);
  assert.equal(turns[1].predecessor_delivery_hash, acceptedThreadDeliveryHash);
  assert.deepEqual(turns[1].target_runtime_identity, acceptedThreadIdentity);
  assert.ok(!committedRequest.events.some(
    (event) => event.type === "business.branch.attempt_opened",
  ));
});

test("rejects resolver certainty that does not bind the callback source and outcome", async () => {
  const fixture = threadSendingFixture();
  const input = settlementObservation(
    fixture.plan,
    workerSettlementPayload(fixture.effect, fixture.lease),
    { digit: "f" },
  );
  const store = memoryStore(fixture.projection, fixture.sequence);
  const deps = dependencies(store, fixture.plan, input, {
    facts(args) {
      const facts = defaultFacts(input, args.settlement_effect);
      facts.settlement_certainty_fact = {
        ...facts.settlement_certainty_fact,
        settlement_source: "control_plane",
        reason: "worker_send_expired",
        classification: "delivery_unknown",
      };
      return facts;
    },
  });

  await assert.rejects(
    deps.boundary.execute({ observation: input, authentication: "valid-token" }),
    isBoundaryError("BUSINESS_OBSERVATION_SETTLEMENT_POLICY_MISMATCH"),
  );
  assert.equal(store.commitCalls, 0);
});

function reclaimedGenerationProjection(fixture) {
  const projection = structuredClone(fixture.projection);
  const effect = projection.outbox[fixture.effect.effect_id];
  effect.status = "claimed";
  effect.lease_generation = 2;
  effect.last_lease_id = "lease:thread-boundary:generation-2";
  effect.lease = {
    lease_id: effect.last_lease_id,
    owner_id: "worker:thread-boundary:generation-2",
    generation: 2,
    claimed_at: "2026-08-09T00:00:11.500Z",
    heartbeat_at: "2026-08-09T00:00:11.500Z",
    expires_at: "2026-08-09T00:00:41.500Z",
  };
  effect.delivery = null;
  effect.updated_at = effect.lease.claimed_at;
  effect.fencing_history = [
    ...effect.fencing_history,
    {
      lease_id: effect.lease.lease_id,
      owner_id: effect.lease.owner_id,
      generation: effect.lease.generation,
    },
  ];
  projection.internal_receipts["INT-thread-boundary-claim-generation-2"] = {
    result: {
      internal_action_id: "INT-thread-boundary-claim-generation-2",
      work_order_id: WORK_ORDER_ID,
      work_order_revision: 1,
      effect_id: effect.effect_id,
      action: "outbox.claim",
      outbox_status: "claimed",
      fencing_token: {
        lease_id: effect.lease.lease_id,
        owner_id: effect.lease.owner_id,
        generation: effect.lease.generation,
      },
    },
  };
  return projection;
}

test("durably quarantines a generation-1 worker callback after generation-2 reclaim", async () => {
  const fixture = threadSendingFixture();
  const projection = reclaimedGenerationProjection(fixture);
  const input = settlementObservation(
    fixture.plan,
    workerSettlementPayload(fixture.effect, fixture.lease),
    { digit: "2" },
  );
  const store = memoryStore(projection, fixture.sequence + 1);
  const deps = dependencies(store, fixture.plan, input);

  const result = await deps.boundary.execute({
    observation: input,
    authentication: "valid-token",
  });
  assert.equal(result.status, "quarantined");
  assert.equal(result.reason, "stale_effect_generation");
  assert.equal(store.state.outbox[fixture.effect.effect_id].status, "claimed");
  assert.equal(store.state.outbox[fixture.effect.effect_id].lease.generation, 2);
  assert.equal(
    store.state.late_observations[input.observation_id].reason,
    "stale_effect_generation",
  );
  assert.deepEqual(
    store.state.late_observations[input.observation_id].observation,
    input,
  );
  assert.ok(store.state.observation_receipts[input.observation_id]);
  assert.equal(store.commitCalls, 1);
});

test("rejects a fabricated historical lease instead of laundering it as a stale callback", async () => {
  const fixture = threadSendingFixture();
  const projection = reclaimedGenerationProjection(fixture);
  const forgedLease = {
    ...fixture.lease,
    owner_id: "worker:never-issued-for-generation-1",
  };
  const input = settlementObservation(
    fixture.plan,
    workerSettlementPayload(fixture.effect, forgedLease),
    { digit: "8" },
  );
  const store = memoryStore(projection, fixture.sequence + 1);
  const deps = dependencies(store, fixture.plan, input);

  await assert.rejects(
    deps.boundary.execute({ observation: input, authentication: "valid-token" }),
    isBoundaryError("BUSINESS_OBSERVATION_SETTLEMENT_FENCING_MISMATCH"),
  );
  assert.equal(store.commitCalls, 0);
  assert.equal(store.state.outbox[fixture.effect.effect_id].lease.generation, 2);
  assert.equal(store.state.late_observations[input.observation_id], undefined);
});

test("revalidates worker fencing after CAS change instead of settling with an obsolete decision", async () => {
  const fixture = threadSendingFixture();
  const reclaimed = reclaimedGenerationProjection(fixture);
  const input = settlementObservation(
    fixture.plan,
    workerSettlementPayload(fixture.effect, fixture.lease),
    { digit: "3" },
  );
  const store = memoryStore(
    fixture.projection,
    fixture.sequence,
    ({ commits }) => (commits === 1
      ? { type: "conflict", projection: reclaimed }
      : null),
  );
  const deps = dependencies(store, fixture.plan, input);

  const result = await deps.boundary.execute({
    observation: input,
    authentication: "valid-token",
  });
  assert.equal(result.status, "quarantined");
  assert.equal(result.reason, "stale_effect_generation");
  assert.equal(store.commitCalls, 2);
  assert.equal(deps.calls.authenticate, 2);
  assert.equal(deps.calls.authorize, 2);
  assert.equal(deps.calls.resolveFacts, 2);
  assert.equal(store.state.outbox[fixture.effect.effect_id].status, "claimed");
  assert.equal(store.state.outbox[fixture.effect.effect_id].lease.generation, 2);
  assert.equal(
    store.state.late_observations[input.observation_id].reason,
    "stale_effect_generation",
  );
});

test("samples a fresh durable time when the same worker lease is renewed across CAS", async () => {
  const fixture = threadSendingFixture();
  const renewed = structuredClone(fixture.projection);
  const renewedEffect = renewed.outbox[fixture.effect.effect_id];
  renewedEffect.lease.heartbeat_at = "2026-08-09T00:00:13.000Z";
  renewedEffect.lease.expires_at = "2026-08-09T00:00:43.000Z";
  renewedEffect.updated_at = renewedEffect.lease.heartbeat_at;
  const input = settlementObservation(
    fixture.plan,
    workerSettlementPayload(fixture.effect, fixture.lease),
    { digit: "c" },
  );
  const store = memoryStore(
    fixture.projection,
    fixture.sequence,
    ({ commits }) => (commits === 1
      ? { type: "conflict", projection: renewed }
      : null),
  );
  const times = [OBSERVED_AT, "2026-08-09T00:00:14.000Z"];
  let clockCalls = 0;
  const deps = dependencies(store, fixture.plan, input, {
    clock() {
      const value = times[clockCalls];
      clockCalls += 1;
      return value;
    },
  });

  const result = await deps.boundary.execute({
    observation: input,
    authentication: "valid-token",
  });
  assert.equal(result.branch_state, "dispatch_pending");
  assert.equal(clockCalls, 2);
  assert.equal(store.commitCalls, 2);
  assert.equal(store.state.outbox[fixture.effect.effect_id].status, "delivered");
  assert.equal(
    store.state.outbox[fixture.effect.effect_id].delivery.recorded_at,
    "2026-08-09T00:00:14.000Z",
  );
});

test("rejects forged worker fencing and atomically journals a fully attested recovery probe", async () => {
  const fixture = threadSendingFixture();
  const projection = fixture.projection;

  const forgedWorkerPayload = workerSettlementPayload(fixture.effect, {
    ...fixture.lease,
    owner_id: "worker:forged-owner",
  });
  const forgedWorker = settlementObservation(fixture.plan, forgedWorkerPayload, { digit: "4" });
  const workerStore = memoryStore(projection, fixture.sequence);
  const workerDeps = dependencies(workerStore, fixture.plan, forgedWorker);
  await assert.rejects(
    workerDeps.boundary.execute({
      observation: forgedWorker,
      authentication: "valid-token",
    }),
    isBoundaryError("BUSINESS_OBSERVATION_SETTLEMENT_FENCING_MISMATCH"),
  );
  assert.equal(workerStore.commitCalls, 0);

  const forgedProbePayload = recoveryProbeSettlementPayload(fixture.effect, {
    mutationIdempotencyKey: `IDEM-${"9".repeat(32)}`,
  });
  const forgedProbe = settlementObservation(fixture.plan, forgedProbePayload, { digit: "5" });
  const forgedProbeStore = memoryStore(projection, fixture.sequence);
  const forgedProbeDeps = dependencies(forgedProbeStore, fixture.plan, forgedProbe);
  await assert.rejects(
    forgedProbeDeps.boundary.execute({
      observation: forgedProbe,
      authentication: "valid-token",
    }),
    isBoundaryError("BUSINESS_OBSERVATION_SETTLEMENT_ATTESTATION_MISMATCH"),
  );
  assert.equal(forgedProbeStore.commitCalls, 0);

  const expiry = sendExpiryObservation(fixture.plan, fixture.effect, fixture.lease, {
    digit: "d",
  });
  const probeStore = memoryStore(projection, fixture.sequence);
  const expiryDeps = dependencies(probeStore, fixture.plan, expiry, {
    clock: () => fixture.lease.expires_at,
  });
  await expiryDeps.boundary.execute({ observation: expiry, authentication: "valid-token" });

  const ambiguousEffect = probeStore.state.outbox[fixture.effect.effect_id];
  const validProbePayload = recoveryProbeSettlementPayload(ambiguousEffect);
  const validProbe = settlementObservation(fixture.plan, validProbePayload, {
    digit: "6",
    revision: 2,
  });
  const probeDeps = dependencies(probeStore, fixture.plan, validProbe, {
    clock: () => "2026-08-09T00:00:41.000Z",
    facts(args) {
      const facts = defaultFacts(validProbe, args.settlement_effect);
      facts.reconciliation_resolution_ref = ref("resolution:probe-absence");
      return facts;
    },
  });
  const probeResult = await probeDeps.boundary.execute({
    observation: validProbe,
      authentication: "valid-token",
  });
  assert.equal(probeResult.recovery_probe_ledger.version, 1);
  assert.equal(probeResult.recovery_probe_ledger.effect_id, fixture.effect.effect_id);
  assert.equal(probeDeps.calls.resolveFacts, 1);
  assert.equal(probeStore.commitCalls, 2);
  assert.equal(probeStore.state.outbox[fixture.effect.effect_id].status, "not_sent");
  assert.ok(probeStore.state.observation_receipts[validProbe.observation_id]);

  const reusedProbe = settlementObservation(fixture.plan, validProbePayload, {
    digit: "7",
    revision: 3,
  });
  const reusedDeps = dependencies(probeStore, fixture.plan, reusedProbe);
  await assert.rejects(
    reusedDeps.boundary.execute({
      observation: reusedProbe,
      authentication: "valid-token",
    }),
    isBoundaryError("BUSINESS_OBSERVATION_RECOVERY_PROBE_REUSED"),
  );
});

test("counts recovery budget from exact typed receipts rather than attention records", async () => {
  const fixture = threadSendingFixture();
  const expiry = sendExpiryObservation(fixture.plan, fixture.effect, fixture.lease, {
    digit: "e",
  });
  const store = memoryStore(fixture.projection, fixture.sequence);
  await dependencies(store, fixture.plan, expiry, {
    clock: () => fixture.lease.expires_at,
  }).boundary.execute({ observation: expiry, authentication: "valid-token" });

  for (let index = 0; index < 3; index += 1) {
    const effect = store.state.outbox[fixture.effect.effect_id];
    const payload = recoveryProbeSettlementPayload(effect, {
      classification: "delivery_unknown",
      probeNonce: index,
    });
    const probe = settlementObservation(fixture.plan, payload, {
      digit: String(index + 1),
      revision: index + 2,
    });
    const deps = dependencies(store, fixture.plan, probe, {
      clock: () => `2026-08-09T00:00:4${index + 1}.000Z`,
      facts(args) {
        const facts = defaultFacts(
          probe,
          args.delivery_effect || args.settlement_effect,
        );
        facts.attention_detail_ref = "attention:probe-inconclusive";
        return facts;
      },
    });
    const result = await deps.boundary.execute({
      observation: probe,
      authentication: "valid-token",
    });
    assert.equal(result.recovery_probe_ledger.classification, "delivery_unknown");
    assert.equal(store.state.outbox[effect.effect_id].status, "delivery_unknown");
  }

  const effect = store.state.outbox[fixture.effect.effect_id];
  const exhaustedPayload = recoveryProbeSettlementPayload(effect, {
    classification: "delivery_unknown",
    probeNonce: 4,
  });
  const exhausted = settlementObservation(fixture.plan, exhaustedPayload, {
    digit: "4",
    revision: 5,
  });
  const exhaustedDeps = dependencies(store, fixture.plan, exhausted);
  await assert.rejects(
    exhaustedDeps.boundary.execute({ observation: exhausted, authentication: "valid-token" }),
    isBoundaryError("BUSINESS_OBSERVATION_RECOVERY_PROBE_LIMIT"),
  );
  assert.equal(exhaustedDeps.calls.resolveFacts, 0);
});

test("re-authenticates and observes authorization revocation after a global CAS loss", async () => {
  const fixture = startFixture();
  const projection = projectBatches([fixture.batch]);
  const input = observation(fixture.plan, "branch.timed_out", {
    branch_ref: "branch:solo",
    attempt: 1,
    timeout_ms: 60_000,
  }, { digit: "7" });
  const store = memoryStore(projection, 1, ({ commits }) => (commits === 1 ? "conflict" : null));
  let authenticationCalls = 0;
  let authorizationCalls = 0;
  const deps = dependencies(store, fixture.plan, input, {
    clock: () => ATTEMPT_DEADLINE,
    authorizer: {
      async authenticate() {
        authenticationCalls += 1;
        return { type: "agent", id: "runtime:primary" };
      },
      async authorize() {
        authorizationCalls += 1;
        if (authorizationCalls > 1) return null;
        return authority(fixture.plan, input, defaultFacts(input));
      },
    },
  });
  await assert.rejects(
    deps.boundary.execute({ observation: input, authentication: "valid-token" }),
    isBoundaryError("BUSINESS_OBSERVATION_AUTHORIZATION_DENIED"),
  );
  assert.equal(authenticationCalls, 2);
  assert.equal(authorizationCalls, 2);
  assert.equal(deps.calls.resolveProject, 2);
  assert.equal(deps.calls.resolveFacts, 1);
  assert.equal(store.commitCalls, 1);
  assert.equal(store.state.work_orders[WORK_ORDER_ID].revision, 1);
});

test("recovers a lost commit response by exact receipt and rejects stale receipt reuse", async () => {
  const fixture = startFixture();
  const projection = projectBatches([fixture.batch]);
  const original = observation(fixture.plan, "branch.timed_out", {
    branch_ref: "branch:solo",
    attempt: 1,
    timeout_ms: 60_000,
  }, { digit: "8" });
  const controller = new AbortController();
  const store = memoryStore(projection, 1, ({ commits }) => {
    if (commits !== 1) return null;
    // Cancellation races with a lost response after the durable write. Receipt
    // reconciliation must no longer use this caller-owned signal.
    controller.abort(new Error("caller cancelled after commit began"));
    return "response-lost";
  });
  const deps = dependencies(store, fixture.plan, original, {
    clock: () => ATTEMPT_DEADLINE,
  });
  const result = await deps.boundary.execute({
    observation: original,
    authentication: "valid-token",
    signal: controller.signal,
  });

  assert.equal(result.branch_state, "cancelled");
  assert.equal(store.commitCalls, 1);
  assert.ok(store.state.observation_receipts[original.observation_id]);

  const exactReplay = await deps.boundary.execute({
    observation: original,
    authentication: "valid-token",
  });
  assert.deepEqual(exactReplay, result);
  assert.equal(store.commitCalls, 1);

  const conflicting = observation(fixture.plan, "work_order.cancelled", {
    reason: "Conflicting reuse of the durable identifier.",
  }, { digit: "8", revision: 2 });
  const conflictingDeps = dependencies(store, fixture.plan, conflicting);
  await assert.rejects(
    conflictingDeps.boundary.execute({ observation: conflicting, authentication: "valid-token" }),
    isBoundaryError("BUSINESS_OBSERVATION_ID_CONFLICT"),
  );
  assert.equal(store.commitCalls, 1);
});

test("bounds read dependencies and honors caller AbortSignal without a write", async () => {
  const fixture = startFixture();
  const projection = projectBatches([fixture.batch]);
  const input = observation(fixture.plan, "branch.timed_out", {
    branch_ref: "branch:solo",
    attempt: 1,
    timeout_ms: 60_000,
  }, { digit: "b" });
  const store = memoryStore(projection);
  const timedOut = dependencies(store, fixture.plan, input, {
    dependencyTimeoutMs: 10,
    authorizer: {
      async authenticate() { return new Promise(() => {}); },
      async authorize() { throw new Error("must not authorize"); },
    },
  });
  await assert.rejects(
    timedOut.boundary.execute({ observation: input, authentication: "ignored" }),
    isBoundaryError("BUSINESS_OBSERVATION_DEPENDENCY_TIMEOUT"),
  );
  assert.equal(store.commitCalls, 0);

  const controller = new AbortController();
  controller.abort(new Error("caller stopped"));
  const aborted = dependencies(store, fixture.plan, input);
  await assert.rejects(
    aborted.boundary.execute({
      observation: input,
      authentication: "valid-token",
      signal: controller.signal,
    }),
    isBoundaryError("BUSINESS_OBSERVATION_ABORTED"),
  );
  assert.equal(store.commitCalls, 0);
});

test("rejects a pre-commit abort and wraps an unreconciled EventStore failure", async () => {
  const fixture = startFixture();
  const projection = projectBatches([fixture.batch]);
  const input = observation(fixture.plan, "branch.timed_out", {
    branch_ref: "branch:solo",
    attempt: 1,
    timeout_ms: 60_000,
  }, { digit: "c" });
  const abortedStore = memoryStore(projection);
  const controller = new AbortController();
  const aborted = dependencies(abortedStore, fixture.plan, input, {
    clock() {
      controller.abort();
      return ATTEMPT_DEADLINE;
    },
  });
  await assert.rejects(
    aborted.boundary.execute({
      observation: input,
      authentication: "valid-token",
      signal: controller.signal,
    }),
    isBoundaryError("BUSINESS_OBSERVATION_ABORTED"),
  );
  assert.equal(abortedStore.commitCalls, 0);

  const failingStore = {
    replay: () => ({ state: projection, watermark: { journal_sequence: 1 } }),
    commit() {
      throw Object.assign(new Error("/private/path/events.jsonl: permission denied"), {
        code: "EACCES",
      });
    },
  };
  const failing = dependencies(failingStore, fixture.plan, input, {
    clock: () => ATTEMPT_DEADLINE,
  });
  await assert.rejects(
    failing.boundary.execute({ observation: input, authentication: "valid-token" }),
    (error) => {
      assert.ok(error instanceof BusinessObservationBoundaryError);
      assert.equal(error.code, "BUSINESS_OBSERVATION_EVENT_STORE_COMMIT_FAILED");
      assert.equal(error.details.cause_code, "EACCES");
      assert.ok(!error.message.includes("/private/path"));
      return true;
    },
  );
});
