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
const ESCALATION_TRIGGERS = Object.freeze([
  "budget_exhausted", "critical_risk_discovered", "scope_drift", "semantic_finding_not_machine_verifiable"
]);
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

function createExecutionPlan({ taskIntent, riskProfile, revision = 1, supersedesExecutionPlanId = null } = {}) {
  const validTaskIntent = detached(assertContract("task-intent", taskIntent));
  if (!Number.isInteger(revision) || revision < 1) throw new TypeError("revision must be a positive integer");
  if (supersedesExecutionPlanId !== null && !/^EP-[a-f0-9]{12}$/.test(supersedesExecutionPlanId)) {
    throw new TypeError("supersedesExecutionPlanId is invalid");
  }
  const { profile, missing } = normalizeRiskProfile(riskProfile);
  const { lane, reasonCodes } = classify(profile, missing);
  const { routing, review_policy } = laneFields(lane);
  const content = {
    task_intent_id: validTaskIntent.task_intent_id,
    policy_version: 1,
    lane,
    risk_profile: profile,
    reason_codes: reasonCodes,
    routing,
    budget: detached(EXECUTION_BUDGETS[lane]),
    review_policy,
    escalation_triggers: [...ESCALATION_TRIGGERS],
    revision,
    supersedes_execution_plan_id: supersedesExecutionPlanId
  };
  const plan = {
    execution_plan_id: `EP-${canonicalHash(content).slice(0, 12)}`,
    ...content
  };
  return deepFreeze(assertContract("execution-plan", detached(plan)));
}

module.exports = {
  EXECUTION_LANES,
  EXECUTION_BUDGETS,
  createExecutionPlan
};
