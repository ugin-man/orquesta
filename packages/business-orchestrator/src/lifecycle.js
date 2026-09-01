"use strict";

const { canonicalHash } = require("@orquesta/contracts");

// This module consumes already-normalized aggregate and projection records. It
// deliberately does not re-normalize envelopes, effects, references, hashes,
// or timestamps. The boundaries remain responsible for trust; this module owns
// only the lifecycle meaning shared by the decider and projector.

const V2_MUTATING_EFFECT_KINDS = Object.freeze([
  "provider.thread.create",
  "provider.turn.start",
  "provider.user_input.submit",
  "provider.turn.cancel",
]);

const V2_EFFECT_STATUSES = Object.freeze([
  "pending",
  "claimed",
  "sending",
  "delivery_unknown",
  "delivered",
  "not_sent",
  "cancelled",
]);

const V2_UNRESOLVED_EFFECT_STATUSES = Object.freeze([
  "pending",
  "claimed",
  "sending",
  "delivery_unknown",
]);

const V2_TERMINAL_EFFECT_STATUSES = Object.freeze([
  "delivered",
  "not_sent",
  "cancelled",
]);

const V2_RECOVERABLE_EFFECT_STATUSES = Object.freeze([
  "sending",
  "delivery_unknown",
]);

const V2_RECOVERY_ATTENTION_KINDS = Object.freeze([
  "delivery_unknown",
  "timeout_requires_reconciliation",
  "cancel_requires_dispatch_reconciliation",
]);
const V2_OPERATOR_ATTENTION_KINDS = Object.freeze([
  "provider_effect_presend_failure",
]);

const V2_EFFECT_IDENTITY_FIELDS = Object.freeze([
  "effect_id",
  "effect_contract_version",
  "work_order_id",
  "branch_ref",
  "attempt",
  "dispatch_id",
  "effect_kind",
  "origin_source_id",
  "operation_scope_hash",
  "operation_generation",
  "generation_predecessor_effect_id",
  "provider_ref",
  "packet_ref",
  "packet_hash",
  "predecessor_effect_id",
  "predecessor_delivery_hash",
  "target_runtime_identity",
  "idempotency_key",
  "created_at",
]);

const V2_EFFECT_STAGES = Object.freeze({
  "provider.thread.create": "thread_create",
  "provider.turn.start": "turn_start",
  "provider.user_input.submit": "user_input_submit",
  "provider.turn.cancel": "turn_cancel",
});

const V2_AUTOMATION_STATES = Object.freeze([
  "replay_only",
  "runnable",
  "paused",
  "cleanup_hold",
  "cancelling",
  "awaiting_acceptance",
  "terminal",
  "invalid",
]);

const EFFECT_KIND_SET = new Set(V2_MUTATING_EFFECT_KINDS);
const EFFECT_STATUS_SET = new Set(V2_EFFECT_STATUSES);
const UNRESOLVED_STATUS_SET = new Set(V2_UNRESOLVED_EFFECT_STATUSES);
const TERMINAL_STATUS_SET = new Set(V2_TERMINAL_EFFECT_STATUSES);
const RECOVERABLE_STATUS_SET = new Set(V2_RECOVERABLE_EFFECT_STATUSES);
const RECOVERY_ATTENTION_KIND_SET = new Set(V2_RECOVERY_ATTENTION_KINDS);
const OPERATOR_ATTENTION_KIND_SET = new Set(V2_OPERATOR_ATTENTION_KINDS);
const TERMINAL_WORK_ORDER_STATUS_SET = new Set(["accepted", "failed", "cancelled"]);

// The lane is the one mutating provider kind for a branch attempt. The scope
// hash distinguishes semantic operations within that lane; explicit generation
// fields, never timestamps or object insertion order, define retry lineage.
const V2_OPERATION_GOAL_FIELDS = Object.freeze([
  "work_order_id",
  "branch_ref",
  "attempt",
  "dispatch_id",
  "effect_kind",
]);

class BusinessLifecycleInvariantError extends Error {
  constructor(violations) {
    super("The Effect V2 lifecycle violates intrinsic invariants");
    this.name = "BusinessLifecycleInvariantError";
    this.code = "BUSINESS_LIFECYCLE_INVARIANT";
    this.details = { violations };
  }
}

function compareText(left, right) {
  const leftText = String(left);
  const rightText = String(right);
  if (leftText < rightText) return -1;
  if (leftText > rightText) return 1;
  return 0;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort(compareText);
}

function engineContractVersion(workOrder) {
  return Object.hasOwn(workOrder, "engine_contract_version")
    ? workOrder.engine_contract_version
    : 1;
}

function effectOperationLaneIdV2(effect) {
  const identity = Object.fromEntries(
    V2_OPERATION_GOAL_FIELDS.map((field) => [field, effect[field]]),
  );
  return `LANE-${canonicalHash(identity).slice(0, 32)}`;
}

function effectOperationGoalIdV2(effect) {
  return `GOAL-${canonicalHash({
    operation_lane_id: effectOperationLaneIdV2(effect),
    operation_scope_hash: effect.operation_scope_hash,
  }).slice(0, 32)}`;
}

function deriveEffectOperationScopeHashV2(binding) {
  const fields = {
    "provider.thread.create": [
      "effect_kind",
      "provider_ref",
      "packet_ref",
      "packet_hash",
    ],
    "provider.turn.start": [
      "effect_kind",
      "provider_ref",
      "packet_ref",
      "packet_hash",
      "predecessor_effect_id",
      "predecessor_delivery_hash",
      "target_runtime_identity",
    ],
    "provider.turn.cancel": [
      "effect_kind",
      "provider_ref",
      "predecessor_effect_id",
      "predecessor_delivery_hash",
      "target_runtime_identity",
    ],
    "provider.user_input.submit": [
      "effect_kind",
      "provider_ref",
      "predecessor_effect_id",
      "predecessor_delivery_hash",
      "target_runtime_identity",
      "request_id",
      "response_ref",
    ],
  }[binding.effect_kind];
  if (!fields) {
    const error = new Error(`Unsupported Effect V2 kind: ${binding.effect_kind}`);
    error.code = "BUSINESS_EFFECT_KIND_UNSUPPORTED";
    throw error;
  }
  return canonicalHash(Object.fromEntries(fields.map((field) => [field, binding[field]])));
}

function attemptScope(effect, branch) {
  if (!branch || effect.branch_ref !== branch.branch_ref) return "unbound";
  if (effect.attempt === branch.attempt && effect.dispatch_id === branch.dispatch_id) {
    return "current";
  }
  if (effect.attempt < branch.attempt
      || (effect.attempt === branch.attempt && effect.dispatch_id !== branch.dispatch_id)) {
    return "prior";
  }
  return "future";
}

function goalDisposition(effect) {
  const { status } = effect;
  if (status === "not_sent"
      && effect.settlement_policy?.disposition === "operator_attention") {
    return "operator_attention";
  }
  switch (status) {
    case "delivered": return "achieved";
    case "not_sent": return "retryable";
    case "cancelled": return "abandoned";
    case "delivery_unknown": return "ambiguous";
    default: return "open";
  }
}

function classifyEffectLifecycleV2(effect, branch, { effectKey = effect.effect_id } = {}) {
  const scope = attemptScope(effect, branch);
  const disposition = goalDisposition(effect);
  return {
    mode: effect.effect_contract_version === 2 ? "v2" : "version_mismatch",
    effect_key: effectKey,
    effect_id: effect.effect_id,
    idempotency_key: effect.idempotency_key,
    work_order_id: effect.work_order_id,
    branch_ref: effect.branch_ref,
    attempt: effect.attempt,
    dispatch_id: effect.dispatch_id,
    effect_kind: effect.effect_kind,
    operation_scope_hash: effect.operation_scope_hash,
    operation_generation: effect.operation_generation,
    generation_predecessor_effect_id: effect.generation_predecessor_effect_id,
    stage: V2_EFFECT_STAGES[effect.effect_kind] || null,
    status: effect.status,
    attempt_scope: scope,
    current_attempt: scope === "current",
    prior_attempt: scope === "prior",
    ambiguous: effect.status === "delivery_unknown",
    unresolved: UNRESOLVED_STATUS_SET.has(effect.status),
    effect_terminal: TERMINAL_STATUS_SET.has(effect.status),
    goal_terminal: disposition === "achieved" || disposition === "abandoned",
    goal_disposition: disposition,
    recovery_attention_required: effect.status === "delivery_unknown",
    operator_attention_required: disposition === "operator_attention",
    may_have_crossed_provider_boundary: [
      "sending",
      "delivery_unknown",
      "delivered",
    ].includes(effect.status),
    operation_lane_id: EFFECT_KIND_SET.has(effect.effect_kind)
      ? effectOperationLaneIdV2(effect)
      : null,
    operation_goal_id: EFFECT_KIND_SET.has(effect.effect_kind)
      && typeof effect.operation_scope_hash === "string"
      ? effectOperationGoalIdV2(effect)
      : null,
    generation: effect.operation_generation,
  };
}

function invalidEffectViolations(effectKey, effect, workOrder, branch) {
  const violations = [];
  const identity = { effect_key: effectKey, effect_id: effect.effect_id ?? null };
  if (effect.effect_contract_version !== 2) {
    violations.push({
      code: "effect_contract_version_mismatch",
      ...identity,
      expected: 2,
      actual: effect.effect_contract_version ?? 1,
    });
  }
  if (effect.effect_id !== effectKey) {
    violations.push({
      code: "effect_map_identity_mismatch",
      ...identity,
    });
  }
  if (effect.work_order_id !== workOrder.work_order_id) {
    violations.push({
      code: "effect_work_order_identity_mismatch",
      ...identity,
      work_order_id: effect.work_order_id ?? null,
    });
  }
  if (!branch || effect.branch_ref !== branch.branch_ref) {
    violations.push({
      code: "effect_branch_identity_mismatch",
      ...identity,
      branch_ref: effect.branch_ref ?? null,
    });
  }
  if (!EFFECT_KIND_SET.has(effect.effect_kind)) {
    violations.push({
      code: "effect_kind_unsupported",
      ...identity,
      effect_kind: effect.effect_kind ?? null,
    });
  }
  if (!EFFECT_STATUS_SET.has(effect.status)) {
    violations.push({
      code: "effect_status_unsupported",
      ...identity,
      status: effect.status ?? null,
    });
  }
  if (typeof effect.operation_scope_hash !== "string"
      || !/^[a-f0-9]{64}$/u.test(effect.operation_scope_hash)) {
    violations.push({
      code: "effect_operation_scope_hash_invalid",
      ...identity,
    });
  }
  if (!Number.isSafeInteger(effect.operation_generation)
      || effect.operation_generation < 1) {
    violations.push({
      code: "effect_operation_generation_invalid",
      ...identity,
      operation_generation: effect.operation_generation ?? null,
    });
  }
  for (const field of V2_EFFECT_IDENTITY_FIELDS) {
    if (!Object.hasOwn(effect, field) || effect[field] === undefined) {
      violations.push({
        code: "effect_identity_field_missing",
        ...identity,
        field,
      });
    }
  }
  const scope = branch ? attemptScope(effect, branch) : "unbound";
  if (scope === "future") {
    violations.push({
      code: "effect_ahead_of_branch_attempt",
      ...identity,
      branch_ref: effect.branch_ref ?? null,
      effect_attempt: effect.attempt ?? null,
      branch_attempt: branch.attempt ?? null,
    });
  }
  return violations;
}

function goalSnapshot(laneId, goalId, effects) {
  const ordered = [...effects].sort((left, right) => (
    (left.lifecycle.operation_generation - right.lifecycle.operation_generation)
      || compareText(left.lifecycle.effect_id, right.lifecycle.effect_id)
  ));
  ordered.forEach((effect) => {
    effect.lifecycle.operation_lane_id = laneId;
    effect.lifecycle.operation_goal_id = goalId;
    effect.lifecycle.generation = effect.lifecycle.operation_generation;
  });
  const latest = ordered.at(-1).lifecycle;
  const unresolvedEffectIds = ordered
    .filter((entry) => entry.lifecycle.unresolved)
    .map((entry) => entry.lifecycle.effect_id);
  return {
    operation_lane_id: laneId,
    operation_goal_id: goalId,
    effect_ids: ordered.map((entry) => entry.lifecycle.effect_id),
    unresolved_effect_ids: unresolvedEffectIds,
    latest_effect_id: latest.effect_id,
    latest_generation: latest.operation_generation,
    terminal: unresolvedEffectIds.length === 0 && latest.goal_terminal,
    disposition: unresolvedEffectIds.length === 0
      ? latest.goal_disposition
      : (ordered.some((entry) => entry.lifecycle.ambiguous) ? "ambiguous" : "open"),
  };
}

function replayOnlyBranchSnapshot(branch) {
  return {
    mode: "replay_only",
    branch_ref: branch.branch_ref,
    branch_state: branch.state,
    current_attempt: branch.attempt,
    current_dispatch_id: branch.dispatch_id,
    effects: [],
    operation_goals: [],
    current_effect_ids: [],
    prior_effect_ids: [],
    unresolved_effect_ids: [],
    stale_unresolved_effect_ids: [],
    ambiguous_effect_ids: [],
    open_recovery_attention_ids: [],
    open_operator_attention_ids: [],
    operator_attention_hold_effect_ids: [],
    cleanup_blocking_effect_ids: [],
    cleanup_hold_effect_ids: [],
    cleanup_hold: false,
    cleanup_blocked: false,
    retry_candidate: false,
    lifecycle_retry_clear: false,
    retry_allowed: false,
    lifecycle_allows_forward_automation: false,
    violations: [],
  };
}

function deriveBranchLifecycleSnapshot({
  workOrder,
  branch,
  outbox,
  attention = workOrder.attention,
}) {
  const version = engineContractVersion(workOrder);
  if (version === 1) return replayOnlyBranchSnapshot(branch);
  if (version !== 2) {
    return {
      ...replayOnlyBranchSnapshot(branch),
      mode: "unsupported",
      violations: [{
        code: "engine_contract_version_unsupported",
        work_order_id: workOrder.work_order_id,
        engine_contract_version: version,
      }],
    };
  }

  const violations = [];
  const effectEntries = Object.entries(outbox)
    .filter(([, effect]) => (
      effect
        && effect.work_order_id === workOrder.work_order_id
        && effect.branch_ref === branch.branch_ref
    ))
    .sort(([left], [right]) => compareText(left, right));
  const effects = [];
  const lineageEntries = [];
  const laneMembers = new Map();
  const goalMembers = new Map();

  for (const [effectKey, effect] of effectEntries) {
    violations.push(...invalidEffectViolations(effectKey, effect, workOrder, branch));
    const lifecycle = classifyEffectLifecycleV2(effect, branch, { effectKey });
    const entry = { effect, lifecycle };
    effects.push(lifecycle);
    if (effect.effect_contract_version !== 2
        || !EFFECT_KIND_SET.has(effect.effect_kind)
        || !EFFECT_STATUS_SET.has(effect.status)
        || typeof effect.operation_scope_hash !== "string"
        || !/^[a-f0-9]{64}$/u.test(effect.operation_scope_hash)
        || !Number.isSafeInteger(effect.operation_generation)
        || effect.operation_generation < 1) continue;
    let laneId;
    let goalId;
    try {
      laneId = effectOperationLaneIdV2(effect);
      goalId = effectOperationGoalIdV2(effect);
    } catch (error) {
      violations.push({
        code: "effect_operation_goal_identity_invalid",
        effect_key: effectKey,
        effect_id: effect.effect_id ?? null,
      });
      continue;
    }
    lifecycle.operation_lane_id = laneId;
    lifecycle.operation_goal_id = goalId;
    lineageEntries.push(entry);
    const lane = laneMembers.get(laneId) || [];
    lane.push(entry);
    laneMembers.set(laneId, lane);
    const goal = goalMembers.get(goalId) || [];
    goal.push(entry);
    goalMembers.set(goalId, goal);
  }

  const effectEntryById = new Map();
  for (const entry of lineageEntries) {
    const existing = effectEntryById.get(entry.lifecycle.effect_id);
    if (existing) {
      violations.push({
        code: "effect_identity_duplicate",
        branch_ref: branch.branch_ref,
        effect_id: entry.lifecycle.effect_id,
        effect_keys: uniqueSorted([
          existing.lifecycle.effect_key,
          entry.lifecycle.effect_key,
        ]),
      });
    } else {
      effectEntryById.set(entry.lifecycle.effect_id, entry);
    }
  }

  const cycleSignatures = new Set();
  const visited = new Set();
  const visiting = new Map();
  function visitGeneration(effectId, path) {
    if (visited.has(effectId)) return;
    if (visiting.has(effectId)) {
      const cycle = path.slice(visiting.get(effectId));
      const signature = uniqueSorted(cycle).join("|");
      if (!cycleSignatures.has(signature)) {
        cycleSignatures.add(signature);
        violations.push({
          code: "operation_generation_cycle",
          branch_ref: branch.branch_ref,
          effect_ids: uniqueSorted(cycle),
        });
      }
      return;
    }
    const entry = effectEntryById.get(effectId);
    if (!entry) return;
    visiting.set(effectId, path.length);
    const predecessorId = entry.effect.generation_predecessor_effect_id;
    if (typeof predecessorId === "string") {
      visitGeneration(predecessorId, [...path, effectId]);
    }
    visiting.delete(effectId);
    visited.add(effectId);
  }
  for (const effectId of [...effectEntryById.keys()].sort(compareText)) {
    visitGeneration(effectId, []);
  }

  const operationGoals = [];
  for (const [goalId, members] of [...goalMembers.entries()]
    .sort(([left], [right]) => compareText(left, right))) {
    const laneId = members[0].lifecycle.operation_lane_id;
    const generationMembers = new Map();
    const successorMembers = new Map();
    for (const member of members) {
      const generation = member.effect.operation_generation;
      const atGeneration = generationMembers.get(generation) || [];
      atGeneration.push(member);
      generationMembers.set(generation, atGeneration);
      const predecessorId = member.effect.generation_predecessor_effect_id;
      if (typeof predecessorId === "string") {
        const successors = successorMembers.get(predecessorId) || [];
        successors.push(member);
        successorMembers.set(predecessorId, successors);
      }

      if (generation === 1) {
        if (predecessorId !== null) {
          violations.push({
            code: "operation_generation_root_has_predecessor",
            branch_ref: branch.branch_ref,
            operation_goal_id: goalId,
            effect_id: member.lifecycle.effect_id,
            generation_predecessor_effect_id: predecessorId ?? null,
          });
        }
        continue;
      }
      if (typeof predecessorId !== "string") {
        violations.push({
          code: "operation_generation_predecessor_missing",
          branch_ref: branch.branch_ref,
          operation_goal_id: goalId,
          effect_id: member.lifecycle.effect_id,
          operation_generation: generation,
        });
        continue;
      }
      const predecessor = effectEntryById.get(predecessorId);
      if (!predecessor) {
        violations.push({
          code: "operation_generation_predecessor_orphaned",
          branch_ref: branch.branch_ref,
          operation_goal_id: goalId,
          effect_id: member.lifecycle.effect_id,
          generation_predecessor_effect_id: predecessorId,
        });
        continue;
      }
      if (predecessor.lifecycle.operation_goal_id !== goalId) {
        violations.push({
          code: "operation_generation_goal_mismatch",
          branch_ref: branch.branch_ref,
          operation_goal_id: goalId,
          effect_id: member.lifecycle.effect_id,
          generation_predecessor_effect_id: predecessorId,
        });
      }
      if (predecessor.effect.operation_generation !== generation - 1) {
        violations.push({
          code: "operation_generation_gap",
          branch_ref: branch.branch_ref,
          operation_goal_id: goalId,
          effect_id: member.lifecycle.effect_id,
          operation_generation: generation,
          predecessor_generation: predecessor.effect.operation_generation,
        });
      }
      if (predecessor.effect.status !== "not_sent") {
        violations.push({
          code: "operation_generation_predecessor_not_retryable",
          branch_ref: branch.branch_ref,
          operation_goal_id: goalId,
          effect_id: member.lifecycle.effect_id,
          generation_predecessor_effect_id: predecessorId,
          predecessor_status: predecessor.effect.status,
        });
      }
    }

    for (const [generation, atGeneration] of generationMembers) {
      if (atGeneration.length > 1) {
        violations.push({
          code: "operation_generation_duplicate",
          branch_ref: branch.branch_ref,
          operation_goal_id: goalId,
          operation_generation: generation,
          effect_ids: uniqueSorted(atGeneration.map((entry) => entry.lifecycle.effect_id)),
        });
      }
    }
    for (const [predecessorId, successors] of successorMembers) {
      if (successors.length > 1) {
        violations.push({
          code: "operation_generation_fork",
          branch_ref: branch.branch_ref,
          operation_goal_id: goalId,
          generation_predecessor_effect_id: predecessorId,
          effect_ids: uniqueSorted(successors.map((entry) => entry.lifecycle.effect_id)),
        });
      }
    }

    const goal = goalSnapshot(laneId, goalId, members);
    if (goal.unresolved_effect_ids.length > 1) {
      violations.push({
        code: "multiple_unresolved_generations_for_operation_goal",
        branch_ref: branch.branch_ref,
        operation_goal_id: goal.operation_goal_id,
        effect_ids: goal.unresolved_effect_ids,
      });
    }
    operationGoals.push(goal);
  }

  for (const [laneId, members] of [...laneMembers.entries()]
    .sort(([left], [right]) => compareText(left, right))) {
    const unresolved = members
      .filter((member) => member.lifecycle.unresolved)
      .map((member) => member.lifecycle.effect_id);
    if (unresolved.length > 1) {
      violations.push({
        code: "multiple_unresolved_effects_for_operation_lane",
        branch_ref: branch.branch_ref,
        operation_lane_id: laneId,
        effect_ids: uniqueSorted(unresolved),
      });
    }
  }

  const effectById = new Map(effects.map((effect) => [effect.effect_id, effect]));
  const openRecoveryAttentionEntries = Object.entries(attention)
    .filter(([, record]) => (
      record
        && record.status === "open"
        && record.branch_ref === branch.branch_ref
        && RECOVERY_ATTENTION_KIND_SET.has(record.kind)
    ))
    .sort(([left], [right]) => compareText(left, right));
  const recoveryAttentionEffectIds = [];
  for (const [attentionKey, record] of openRecoveryAttentionEntries) {
    if (record.attention_id !== attentionKey) {
      violations.push({
        code: "attention_map_identity_mismatch",
        attention_key: attentionKey,
        attention_id: record.attention_id ?? null,
        branch_ref: branch.branch_ref,
      });
    }
    const bound = record.effect_id === null || record.effect_id === undefined
      ? null
      : effectById.get(record.effect_id);
    if (!bound) {
      violations.push({
        code: "recovery_attention_effect_missing",
        attention_id: record.attention_id,
        branch_ref: branch.branch_ref,
        effect_id: record.effect_id ?? null,
      });
      continue;
    }
    recoveryAttentionEffectIds.push(bound.effect_id);
    if (!RECOVERABLE_STATUS_SET.has(bound.status)) {
      violations.push({
        code: "recovery_attention_effect_not_recoverable",
        attention_id: record.attention_id,
        branch_ref: branch.branch_ref,
        effect_id: bound.effect_id,
        effect_status: bound.status,
      });
    }
  }

  const recoveredEffectIdSet = new Set(recoveryAttentionEffectIds);
  for (const effect of effects) {
    if (effect.recovery_attention_required && !recoveredEffectIdSet.has(effect.effect_id)) {
      violations.push({
        code: "delivery_unknown_recovery_attention_missing",
        branch_ref: branch.branch_ref,
        effect_id: effect.effect_id,
      });
    }
  }

  const openOperatorAttentionEntries = Object.entries(attention)
    .filter(([, record]) => (
      record
        && record.status === "open"
        && record.branch_ref === branch.branch_ref
        && OPERATOR_ATTENTION_KIND_SET.has(record.kind)
    ))
    .sort(([left], [right]) => compareText(left, right));
  const operatorAttentionEffectIds = [];
  for (const [attentionKey, record] of openOperatorAttentionEntries) {
    const bound = record.attention_id === attentionKey
      && record.effect_id !== null
      && record.effect_id !== undefined
      ? effectById.get(record.effect_id)
      : null;
    if (!bound || !bound.operator_attention_required) {
      violations.push({
        code: "operator_attention_effect_mismatch",
        attention_id: record.attention_id ?? null,
        branch_ref: branch.branch_ref,
        effect_id: record.effect_id ?? null,
      });
      continue;
    }
    operatorAttentionEffectIds.push(bound.effect_id);
  }
  const operatorAttentionEffectIdSet = new Set(operatorAttentionEffectIds);
  for (const effect of effects) {
    if (effect.operator_attention_required
        && !operatorAttentionEffectIdSet.has(effect.effect_id)) {
      violations.push({
        code: "operator_attention_missing",
        branch_ref: branch.branch_ref,
        effect_id: effect.effect_id,
      });
    }
  }

  const currentEffectIds = effects
    .filter((effect) => effect.current_attempt)
    .map((effect) => effect.effect_id);
  const priorEffectIds = effects
    .filter((effect) => effect.prior_attempt)
    .map((effect) => effect.effect_id);
  const unresolvedEffectIds = effects
    .filter((effect) => effect.unresolved)
    .map((effect) => effect.effect_id);
  const currentUnresolvedEffectIds = effects
    .filter((effect) => effect.current_attempt && effect.unresolved)
    .map((effect) => effect.effect_id);
  const staleUnresolvedEffectIds = effects
    .filter((effect) => effect.prior_attempt && effect.unresolved)
    .map((effect) => effect.effect_id);
  const futureUnresolvedEffectIds = effects
    .filter((effect) => effect.attempt_scope === "future" && effect.unresolved)
    .map((effect) => effect.effect_id);
  const ambiguousEffectIds = effects
    .filter((effect) => effect.ambiguous)
    .map((effect) => effect.effect_id);
  const pausedCrossedBoundaryEffectIds = workOrder.status === "paused"
    ? effects
      .filter((effect) => effect.unresolved && effect.may_have_crossed_provider_boundary)
      .map((effect) => effect.effect_id)
    : [];
  const cleanupHoldEffectIds = uniqueSorted([
    ...staleUnresolvedEffectIds,
    ...futureUnresolvedEffectIds,
    ...ambiguousEffectIds,
    ...recoveryAttentionEffectIds,
    ...pausedCrossedBoundaryEffectIds,
  ]);
  const cleanupHold = cleanupHoldEffectIds.length !== 0;
  const operatorAttentionHoldEffectIds = uniqueSorted(operatorAttentionEffectIds);
  const operatorAttentionHold = operatorAttentionHoldEffectIds.length !== 0;
  const retryCandidate = ["retryable", "failed"].includes(branch.state);
  const lifecycleRetryClear = !cleanupHold && currentUnresolvedEffectIds.length === 0;
  const retryAllowed = retryCandidate
    && lifecycleRetryClear
    && operatorAttentionEffectIds.length === 0;

  return {
    mode: "v2",
    branch_ref: branch.branch_ref,
    branch_state: branch.state,
    current_attempt: branch.attempt,
    current_dispatch_id: branch.dispatch_id,
    effects,
    operation_goals: operationGoals,
    current_effect_ids: uniqueSorted(currentEffectIds),
    prior_effect_ids: uniqueSorted(priorEffectIds),
    unresolved_effect_ids: uniqueSorted(unresolvedEffectIds),
    current_unresolved_effect_ids: uniqueSorted(currentUnresolvedEffectIds),
    stale_unresolved_effect_ids: uniqueSorted(staleUnresolvedEffectIds),
    ambiguous_effect_ids: uniqueSorted(ambiguousEffectIds),
    open_recovery_attention_ids: openRecoveryAttentionEntries
      .map(([, record]) => record.attention_id),
    open_operator_attention_ids: openOperatorAttentionEntries
      .map(([, record]) => record.attention_id),
    operator_attention_hold_effect_ids: operatorAttentionHoldEffectIds,
    cleanup_blocking_effect_ids: cleanupHoldEffectIds,
    cleanup_hold_effect_ids: cleanupHoldEffectIds,
    cleanup_hold: cleanupHold,
    cleanup_blocked: cleanupHold,
    retry_candidate: retryCandidate,
    lifecycle_retry_clear: lifecycleRetryClear,
    retry_allowed: retryAllowed,
    lifecycle_allows_forward_automation: !cleanupHold && !operatorAttentionHold,
    violations,
  };
}

function deriveAllowedAutomationState(snapshot) {
  if (snapshot.mode === "replay_only") {
    return {
      state: "replay_only",
      may_schedule_forward_work: false,
      may_retry: false,
      may_reconcile: false,
      may_run_cleanup: false,
      blocking_effect_ids: [],
      cleanup_blocked_by_branch: {},
      lifecycle_retry_clear_by_branch: {},
      retry_candidate_by_branch: {},
      retry_allowed_by_branch: {},
    };
  }
  if (snapshot.mode !== "v2") {
    return {
      state: "invalid",
      may_schedule_forward_work: false,
      may_retry: false,
      may_reconcile: false,
      may_run_cleanup: false,
      blocking_effect_ids: [],
      cleanup_blocked_by_branch: {},
      lifecycle_retry_clear_by_branch: {},
      retry_candidate_by_branch: {},
      retry_allowed_by_branch: {},
    };
  }

  const branches = Object.values(snapshot.branches);
  const cleanupEffectIds = uniqueSorted(
    branches.flatMap((branch) => branch.cleanup_hold_effect_ids),
  );
  const operatorAttentionEffectIds = uniqueSorted(
    branches.flatMap((branch) => branch.operator_attention_hold_effect_ids || []),
  );
  const blockingEffectIds = uniqueSorted([...cleanupEffectIds, ...operatorAttentionEffectIds]);
  const retryAllowedByBranch = Object.fromEntries(
    branches.map((branch) => [branch.branch_ref, branch.retry_allowed]),
  );
  const cleanupBlockedByBranch = Object.fromEntries(
    branches.map((branch) => [branch.branch_ref, branch.cleanup_blocked]),
  );
  const lifecycleRetryClearByBranch = Object.fromEntries(
    branches.map((branch) => [branch.branch_ref, branch.lifecycle_retry_clear]),
  );
  const retryCandidateByBranch = Object.fromEntries(
    branches.map((branch) => [branch.branch_ref, branch.retry_candidate]),
  );
  let state;
  if (snapshot.violations.length !== 0) state = "invalid";
  else if (cleanupEffectIds.length !== 0) state = "cleanup_hold";
  else if (operatorAttentionEffectIds.length !== 0) state = "paused";
  else if (TERMINAL_WORK_ORDER_STATUS_SET.has(snapshot.work_order_status)) state = "terminal";
  else if (snapshot.work_order_status === "cancelling") state = "cancelling";
  else if (snapshot.work_order_status === "paused") state = "paused";
  else if (snapshot.work_order_status === "awaiting_acceptance") state = "awaiting_acceptance";
  else state = "runnable";

  return {
    state,
    may_schedule_forward_work: state === "runnable",
    may_retry: state !== "invalid" && Object.values(retryAllowedByBranch).some(Boolean),
    may_reconcile: state === "cleanup_hold",
    may_run_cleanup: state === "cleanup_hold" || state === "cancelling",
    blocking_effect_ids: blockingEffectIds,
    cleanup_blocked_by_branch: cleanupBlockedByBranch,
    lifecycle_retry_clear_by_branch: lifecycleRetryClearByBranch,
    retry_candidate_by_branch: retryCandidateByBranch,
    retry_allowed_by_branch: retryAllowedByBranch,
  };
}

function deriveLifecycleSnapshot({ workOrder, outbox, attention = workOrder.attention }) {
  const version = engineContractVersion(workOrder);
  if (version === 1) {
    const branches = Object.fromEntries(
      Object.values(workOrder.branches)
        .sort((left, right) => compareText(left.branch_ref, right.branch_ref))
        .map((branch) => [branch.branch_ref, replayOnlyBranchSnapshot(branch)]),
    );
    const snapshot = {
      mode: "replay_only",
      engine_contract_version: 1,
      work_order_id: workOrder.work_order_id,
      work_order_status: workOrder.status,
      branches,
      violations: [],
    };
    return { ...snapshot, automation: deriveAllowedAutomationState(snapshot) };
  }
  if (version !== 2) {
    const snapshot = {
      mode: "unsupported",
      engine_contract_version: version,
      work_order_id: workOrder.work_order_id,
      work_order_status: workOrder.status,
      branches: {},
      violations: [{
        code: "engine_contract_version_unsupported",
        work_order_id: workOrder.work_order_id,
        engine_contract_version: version,
      }],
    };
    return { ...snapshot, automation: deriveAllowedAutomationState(snapshot) };
  }

  const branchEntries = Object.values(workOrder.branches)
    .sort((left, right) => compareText(left.branch_ref, right.branch_ref))
    .map((branch) => [
      branch.branch_ref,
      deriveBranchLifecycleSnapshot({ workOrder, branch, outbox, attention }),
    ]);
  const branches = Object.fromEntries(branchEntries);
  const violations = branchEntries.flatMap(([, branch]) => branch.violations);
  for (const [effectKey, effect] of Object.entries(outbox)
    .sort(([left], [right]) => compareText(left, right))) {
    if (!effect || effect.work_order_id !== workOrder.work_order_id) continue;
    if (!Object.hasOwn(workOrder.branches, effect.branch_ref)) {
      violations.push({
        code: "effect_branch_identity_mismatch",
        effect_key: effectKey,
        effect_id: effect.effect_id ?? null,
        branch_ref: effect.branch_ref ?? null,
      });
    }
  }
  for (const [attentionKey, record] of Object.entries(attention)
    .sort(([left], [right]) => compareText(left, right))) {
    if (!record
        || record.status !== "open"
        || !RECOVERY_ATTENTION_KIND_SET.has(record.kind)) continue;
    if (record.attention_id !== attentionKey
        && (record.branch_ref === null
          || !Object.hasOwn(workOrder.branches, record.branch_ref))) {
      violations.push({
        code: "attention_map_identity_mismatch",
        attention_key: attentionKey,
        attention_id: record.attention_id ?? null,
        branch_ref: record.branch_ref ?? null,
      });
    }
    if (record.branch_ref === null
        || !Object.hasOwn(workOrder.branches, record.branch_ref)) {
      violations.push({
        code: "recovery_attention_branch_missing",
        attention_id: record.attention_id,
        branch_ref: record.branch_ref ?? null,
        effect_id: record.effect_id ?? null,
      });
    }
  }

  const snapshot = {
    mode: "v2",
    engine_contract_version: 2,
    work_order_id: workOrder.work_order_id,
    work_order_status: workOrder.status,
    branches,
    violations,
  };
  return { ...snapshot, automation: deriveAllowedAutomationState(snapshot) };
}

function assertLifecycleInvariants(snapshotOrInput) {
  const snapshot = snapshotOrInput
    && Object.hasOwn(snapshotOrInput, "mode")
    ? snapshotOrInput
    : deriveLifecycleSnapshot(snapshotOrInput);
  if (snapshot.mode === "replay_only") return snapshot;
  if (snapshot.violations.length !== 0) {
    throw new BusinessLifecycleInvariantError(snapshot.violations);
  }
  return snapshot;
}

module.exports = {
  BusinessLifecycleInvariantError,
  V2_AUTOMATION_STATES,
  V2_EFFECT_IDENTITY_FIELDS,
  V2_EFFECT_STAGES,
  V2_EFFECT_STATUSES,
  V2_MUTATING_EFFECT_KINDS,
  V2_OPERATOR_ATTENTION_KINDS,
  V2_RECOVERABLE_EFFECT_STATUSES,
  V2_RECOVERY_ATTENTION_KINDS,
  V2_TERMINAL_EFFECT_STATUSES,
  V2_UNRESOLVED_EFFECT_STATUSES,
  assertLifecycleInvariants,
  classifyEffectLifecycleV2,
  deriveAllowedAutomationState,
  deriveBranchLifecycleSnapshot,
  deriveEffectOperationScopeHashV2,
  deriveLifecycleSnapshot,
  effectOperationGoalIdV2,
};
