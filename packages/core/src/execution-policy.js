"use strict";

const { assertContract, canonicalHash, canonicalJson } = require("@orquesta/contracts");

const EXECUTION_LANES = Object.freeze(["fast", "standard", "critical"]);
const EFFECTS = Object.freeze([
  "local_read", "workspace_write", "dependency_change", "network_access", "external_write", "public_release",
  "credential_access", "payment", "destructive_operation", "data_migration", "security_boundary"
]);
const CRITICAL_EFFECTS = new Set([
  "external_write", "public_release", "credential_access", "payment", "destructive_operation", "data_migration", "security_boundary"
]);
const STANDARD_EFFECTS = new Set(["dependency_change", "network_access"]);
const METRIC_TO_BUDGET = Object.freeze({
  handoffs: "max_handoffs",
  independent_reviews: "max_independent_reviews",
  correction_batches: "max_correction_batches",
  reports: "max_reports",
  auxiliary_tasks: "max_auxiliary_tasks"
});
const CORRECTION_THRESHOLD_REPLAN_REASON = "correction_threshold_replanned";
const ESCALATION_LANES = Object.freeze({
  fast: Object.freeze({
    test_failure: "standard",
    scope_drift: "standard",
    new_risk: "standard",
    acceptance_uncertain: "standard"
  }),
  standard: Object.freeze({
    critical_risk_discovered: "critical",
    semantic_finding_not_machine_verifiable: "critical",
    scope_drift: "critical",
    budget_exhausted: "critical"
  })
});
const EXECUTION_BUDGETS = deepFreeze({
  fast: { max_handoffs: 0, max_independent_reviews: 0, max_correction_batches: 1, max_reports: 0, max_auxiliary_tasks: 0 },
  standard: { max_handoffs: 2, max_independent_reviews: 1, max_correction_batches: 1, max_reports: 1, max_auxiliary_tasks: 0 },
  critical: { max_handoffs: 4, max_independent_reviews: 2, max_correction_batches: 2, max_reports: 2, max_auxiliary_tasks: 0 }
});

const ENUMS = {
  reversibility: ["easy", "costly", "irreversible"],
  scope: ["single_boundary", "multiple_boundaries"],
  verification: ["deterministic", "mixed", "human_only"],
  uncertainty: ["low", "medium", "high"],
  user_review: ["default", "strict"]
};
const DEFAULT_RISK_PROFILE = Object.freeze({
  reversibility: "easy",
  scope: "single_boundary",
  verification: "deterministic",
  uncertainty: "low",
  effects: ["workspace_write"],
  repeated_failures: 0,
  user_review: "default"
});

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function detached(value) {
  return JSON.parse(canonicalJson(value));
}

function normalizeRiskProfile(input) {
  if (input !== undefined && (!input || typeof input !== "object" || Array.isArray(input))) {
    throw new TypeError("riskProfile must be an object");
  }
  const provided = input || {};
  const missing = Object.keys(DEFAULT_RISK_PROFILE).some((field) => provided[field] === undefined);
  const profile = { ...DEFAULT_RISK_PROFILE, ...provided };
  for (const [field, values] of Object.entries(ENUMS)) {
    if (!values.includes(profile[field])) throw new TypeError(`riskProfile.${field} is invalid`);
  }
  if (!Number.isInteger(profile.repeated_failures) || profile.repeated_failures < 0) {
    throw new TypeError("riskProfile.repeated_failures is invalid");
  }
  if (!Array.isArray(profile.effects) || profile.effects.length === 0) {
    throw new TypeError("riskProfile.effects is invalid");
  }
  if (profile.effects.some((effect) => !EFFECTS.includes(effect))) {
    throw new TypeError("riskProfile.effects contains an invalid effect");
  }
  return { profile: { ...profile, effects: [...new Set(profile.effects)].sort(compareText) }, missing };
}

function classify(profile, incomplete) {
  const reasons = [];
  if (profile.reversibility === "irreversible") reasons.push("irreversible");
  for (const effect of profile.effects) {
    if (CRITICAL_EFFECTS.has(effect)) reasons.push(`critical_effect:${effect}`);
  }
  if (profile.user_review === "strict") reasons.push("strict_review_requested");
  if (reasons.length > 0) return { lane: "critical", reasonCodes: reasons.sort(compareText) };

  if (incomplete) reasons.push("incomplete_profile");
  if (profile.reversibility === "costly") reasons.push("costly_reversibility");
  if (profile.scope === "multiple_boundaries") reasons.push("multiple_boundaries");
  if (profile.verification === "mixed") reasons.push("mixed_verification");
  if (profile.verification === "human_only") reasons.push("human_only_verification");
  if (profile.uncertainty === "medium") reasons.push("medium_uncertainty");
  if (profile.uncertainty === "high") reasons.push("high_uncertainty");
  for (const effect of profile.effects) {
    if (STANDARD_EFFECTS.has(effect)) reasons.push(effect);
  }
  if (profile.repeated_failures > 0) reasons.push("repeated_failures");
  return reasons.length > 0
    ? { lane: "standard", reasonCodes: reasons.sort(compareText) }
    : { lane: "fast", reasonCodes: [] };
}

function laneFields(lane) {
  if (lane === "fast") {
    return {
      routing: { routing_class: "inline_verified", handoff_required: false, specialist_report_required: false },
      review_policy: "none"
    };
  }
  return {
    routing: { routing_class: "specialist_required", handoff_required: true, specialist_report_required: true },
    review_policy: lane === "standard" ? "independent_once" : "independent_twice"
  };
}

function laneEscalationTriggers(lane) {
  return Object.keys(ESCALATION_LANES[lane] || {}).sort(compareText);
}

function deriveExecutionAxes(riskProfile, executionEvidence = {}) {
  const evidence = executionEvidence && typeof executionEvidence === "object" ? executionEvidence : {};
  const parallel = Array.isArray(evidence.independent_deliverables) && evidence.independent_deliverables.length >= 2
    && evidence.dependencies_explicit === true
    && evidence.write_overlap === false
    && evidence.verification_independence === true
    && evidence.parallel_gain === true;
  const execution_mode = evidence.durable_context_required === true
    ? "durable_specialist"
    : parallel ? "bounded_parallel" : "solo_direct";
  const strict = riskProfile.reversibility === "irreversible"
    || riskProfile.user_review === "strict"
    || riskProfile.effects.some((effect) => CRITICAL_EFFECTS.has(effect))
    || riskProfile.verification === "human_only";
  const normal = strict || riskProfile.scope === "multiple_boundaries"
    || riskProfile.verification === "mixed" || riskProfile.uncertainty !== "low"
    || riskProfile.repeated_failures > 0 || riskProfile.effects.some((effect) => STANDARD_EFFECTS.has(effect));
  return { execution_mode, review_intensity: strict ? "strict" : normal ? "normal" : "light" };
}

function buildExecutionPlan({ taskIntentId, riskProfile, lane, reasonCodes, revision, supersedesExecutionPlanId, escalationTriggers, executionEvidence }) {
  const axes = executionEvidence === undefined ? null : deriveExecutionAxes(riskProfile, executionEvidence);
  const reviewPolicyForAxes = axes?.review_intensity === "light" ? "none"
    : axes?.review_intensity === "normal" ? "independent_once"
      : axes?.review_intensity === "strict" ? "independent_twice" : null;
  const laneFieldsForPlan = axes
    ? axes.execution_mode === "solo_direct"
      ? { routing: { routing_class: "inline_verified", handoff_required: false, specialist_report_required: false }, review_policy: reviewPolicyForAxes }
      : { routing: { routing_class: "specialist_required", handoff_required: true, specialist_report_required: true }, review_policy: reviewPolicyForAxes }
    : laneFields(lane);
  const { routing, review_policy } = laneFieldsForPlan;
  const content = {
    task_intent_id: taskIntentId,
    policy_version: executionEvidence === undefined ? 1 : 2,
    lane,
    risk_profile: riskProfile,
    reason_codes: [...new Set(reasonCodes)].sort(compareText),
    routing,
    budget: detached(EXECUTION_BUDGETS[lane]),
    review_policy,
    escalation_triggers: [...escalationTriggers].sort(compareText),
    revision,
    supersedes_execution_plan_id: supersedesExecutionPlanId
  };
  if (axes) Object.assign(content, axes);
  const plan = {
    execution_plan_id: `EP-${canonicalHash(content).slice(0, 12)}`,
    ...content
  };
  return deepFreeze(assertContract("execution-plan", detached(plan)));
}

function createExecutionPlan({ taskIntent, riskProfile, executionEvidence, revision = 1, supersedesExecutionPlanId = null } = {}) {
  const validTaskIntent = detached(assertContract("task-intent", taskIntent));
  if (revision !== 1 || supersedesExecutionPlanId !== null) {
    throw new TypeError("createExecutionPlan creates only an initial plan; use reviseExecutionPlan or escalateExecutionPlan for later revisions");
  }
  const { profile, missing } = normalizeRiskProfile(riskProfile);
  const { lane, reasonCodes } = classify(profile, missing);
  return buildExecutionPlan({
    taskIntentId: validTaskIntent.task_intent_id,
    riskProfile: profile,
    lane,
    reasonCodes,
    revision,
    supersedesExecutionPlanId,
    escalationTriggers: laneEscalationTriggers(lane),
    executionEvidence
  });
}

function assessExecutionBudget(executionPlan, counts) {
  const plan = assertContract("execution-plan", executionPlan);
  if (!counts || typeof counts !== "object" || Array.isArray(counts)) {
    throw new TypeError("Execution counts must be an object");
  }
  const exceeded = [];
  for (const [metric, budgetField] of Object.entries(METRIC_TO_BUDGET)) {
    if (!Number.isInteger(counts[metric]) || counts[metric] < 0) {
      throw new TypeError(`Execution count ${metric} must be a non-negative integer`);
    }
    if (counts[metric] > plan.budget[budgetField]) exceeded.push(budgetField);
  }
  if (exceeded.length === 0) return { status: "within_budget", exceeded: [] };
  if (plan.policy_version === 2) {
    const otherExceeded = exceeded.filter((field) => field !== "max_correction_batches");
    if (otherExceeded.length > 0) {
      return { status: "replan_required", exceeded };
    }
    const replanned = plan.revision > 1
      && typeof plan.supersedes_execution_plan_id === "string"
      && plan.reason_codes.includes(CORRECTION_THRESHOLD_REPLAN_REASON);
    return {
      status: replanned ? "continuation_allowed" : "replan_required",
      exceeded
    };
  }
  return {
    status: plan.lane === "critical" ? "user_decision_required" : "escalation_required",
    exceeded
  };
}

function escalateExecutionPlan({ executionPlan, trigger } = {}) {
  const current = detached(assertContract("execution-plan", executionPlan));
  if (current.lane === "critical") {
    throw new TypeError("Critical execution plans cannot be escalated automatically");
  }
  const targetLane = ESCALATION_LANES[current.lane]?.[trigger];
  if (!targetLane) throw new TypeError("Execution escalation trigger is invalid for the current lane");
  const executionEvidence = current.policy_version === 2
    ? current.execution_mode === "durable_specialist"
      ? { durable_context_required: true }
      : current.execution_mode === "bounded_parallel"
        ? { independent_deliverables: ["independent-1", "independent-2"], dependencies_explicit: true, write_overlap: false, verification_independence: true, parallel_gain: true }
        : {}
    : undefined;
  return buildExecutionPlan({
    taskIntentId: current.task_intent_id,
    riskProfile: current.risk_profile,
    lane: targetLane,
    reasonCodes: [...current.reason_codes, `escalation:${trigger}`],
    revision: current.revision + 1,
    supersedesExecutionPlanId: current.execution_plan_id,
    escalationTriggers: laneEscalationTriggers(targetLane),
    executionEvidence
  });
}

function executionEvidenceForPlan(plan) {
  if (plan.policy_version !== 2) return undefined;
  if (plan.execution_mode === "durable_specialist") return { durable_context_required: true };
  if (plan.execution_mode === "bounded_parallel") {
    return {
      independent_deliverables: ["independent-1", "independent-2"],
      dependencies_explicit: true,
      write_overlap: false,
      verification_independence: true,
      parallel_gain: true,
    };
  }
  return {};
}

function reviseExecutionPlan({ executionPlan, reasonCodes = [] } = {}) {
  const current = detached(assertContract("execution-plan", executionPlan));
  if (!Array.isArray(reasonCodes) || reasonCodes.some((reason) => typeof reason !== "string" || !reason.trim())) {
    throw new TypeError("reasonCodes must contain nonempty strings");
  }
  return buildExecutionPlan({
    taskIntentId: current.task_intent_id,
    riskProfile: current.risk_profile,
    lane: current.lane,
    reasonCodes: [...current.reason_codes, ...reasonCodes],
    revision: current.revision + 1,
    supersedesExecutionPlanId: current.execution_plan_id,
    escalationTriggers: current.escalation_triggers,
    executionEvidence: executionEvidenceForPlan(current),
  });
}

module.exports = {
  CORRECTION_THRESHOLD_REPLAN_REASON,
  EXECUTION_LANES,
  EXECUTION_BUDGETS,
  assessExecutionBudget,
  createExecutionPlan,
  deriveExecutionAxes,
  escalateExecutionPlan,
  reviseExecutionPlan,
};
