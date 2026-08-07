"use strict";

const { profileTask } = require("./task-profiler");
const { createExecutionPlan } = require("./execution-policy");

const LEVELS = Object.freeze({
  reversibility: ["easy", "costly", "irreversible"],
  scope: ["single_boundary", "multiple_boundaries"],
  verification: ["deterministic", "mixed", "human_only"],
  uncertainty: ["low", "medium", "high"],
  user_review: ["default", "strict"],
});
const EFFECTS = new Set([
  "local_read", "workspace_write", "dependency_change", "network_access", "external_write", "public_release",
  "credential_access", "payment", "destructive_operation", "data_migration", "security_boundary",
]);

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function stronger(field, left, right) {
  const values = LEVELS[field];
  return values[Math.max(values.indexOf(left), values.indexOf(right))];
}

function normalizeLegacyRiskProfile(legacyRiskProfile) {
  if (legacyRiskProfile === undefined || legacyRiskProfile === null) return null;
  if (!legacyRiskProfile || typeof legacyRiskProfile !== "object" || Array.isArray(legacyRiskProfile)) {
    throw new TypeError("legacy risk_profile must be an object");
  }
  const allowed = new Set([...Object.keys(LEVELS), "effects", "repeated_failures"]);
  for (const field of Object.keys(legacyRiskProfile)) {
    if (!allowed.has(field)) throw new TypeError(`legacy risk_profile.${field} is not supported`);
  }
  const normalized = {};
  for (const [field, values] of Object.entries(LEVELS)) {
    if (legacyRiskProfile[field] !== undefined) {
      if (!values.includes(legacyRiskProfile[field])) throw new TypeError(`legacy risk_profile.${field} is invalid`);
      normalized[field] = legacyRiskProfile[field];
    }
  }
  if (legacyRiskProfile.effects !== undefined) {
    if (!Array.isArray(legacyRiskProfile.effects) || legacyRiskProfile.effects.some((effect) => !EFFECTS.has(effect))) {
      throw new TypeError("legacy risk_profile.effects is invalid");
    }
    normalized.effects = [...new Set(legacyRiskProfile.effects)].sort();
  }
  if (legacyRiskProfile.repeated_failures !== undefined) {
    if (!Number.isInteger(legacyRiskProfile.repeated_failures) || legacyRiskProfile.repeated_failures < 0) {
      throw new TypeError("legacy risk_profile.repeated_failures is invalid");
    }
    normalized.repeated_failures = legacyRiskProfile.repeated_failures;
  }
  return normalized;
}

function applyLegacySafetyFloors(taskProfile, legacy) {
  if (!legacy) return taskProfile;
  const riskProfile = clone(taskProfile.risk_profile);
  for (const field of Object.keys(LEVELS)) {
    if (legacy[field] !== undefined) riskProfile[field] = stronger(field, riskProfile[field], legacy[field]);
  }
  if (legacy.effects) riskProfile.effects = [...new Set([...riskProfile.effects, ...legacy.effects])].sort();
  if (legacy.repeated_failures !== undefined) riskProfile.repeated_failures = Math.max(riskProfile.repeated_failures, legacy.repeated_failures);
  return {
    ...clone(taskProfile),
    risk_profile: riskProfile,
    reason_codes: [...new Set([...taskProfile.reason_codes, "legacy:risk_profile_safety_floor"])].sort(),
    evidence_refs: [...new Set([...taskProfile.evidence_refs, "legacy:risk_profile"])].sort(),
  };
}

function normalizeLegacyWorkItem(workItem, legacy) {
  const normalized = clone(workItem) || {};
  if (!legacy) return normalized;
  const effects = Array.isArray(normalized.effects) ? normalized.effects : [];
  if (legacy.effects) normalized.effects = [...new Set([...effects, ...legacy.effects])].sort();
  if (legacy.verification !== undefined) {
    const current = LEVELS.verification.includes(normalized.verification_method)
      ? normalized.verification_method
      : "deterministic";
    normalized.verification_method = stronger("verification", current, legacy.verification);
  }
  const signals = normalized.control_signals && typeof normalized.control_signals === "object"
    ? { ...normalized.control_signals }
    : {};
  if (legacy.scope === "multiple_boundaries") signals.context_breadth = "high";
  if (legacy.reversibility === "costly" && signals.reversibility !== "high") signals.reversibility = "medium";
  if (legacy.reversibility === "irreversible") signals.reversibility = "high";
  if (legacy.uncertainty !== undefined) signals.ambiguity = stronger("uncertainty", signals.ambiguity || "low", legacy.uncertainty);
  if (legacy.user_review === "strict") signals.consequence = "high";
  if (Object.keys(signals).length) normalized.control_signals = signals;
  return normalized;
}

function createProfiledExecutionPlan({
  taskIntent,
  workItem = {},
  projectUnderstanding = {},
  capabilityNeeds = [],
  localInventory = null,
  failureHistory = [],
  legacyRiskProfile,
} = {}) {
  const legacy = normalizeLegacyRiskProfile(legacyRiskProfile);
  const normalizedWorkItem = normalizeLegacyWorkItem(workItem, legacy);
  const normalizedFailureHistory = legacy && legacy.repeated_failures !== undefined
    ? Math.max(Array.isArray(failureHistory) ? failureHistory.length : Number(failureHistory) || 0, legacy.repeated_failures)
    : failureHistory;
  const profiled = profileTask({
    taskIntent,
    workItem: normalizedWorkItem,
    projectUnderstanding: clone(projectUnderstanding) || {},
    capabilityNeeds: clone(capabilityNeeds) || [],
    localInventory: clone(localInventory),
    failureHistory: clone(normalizedFailureHistory) || [],
  });
  const task_profile = {
    ...applyLegacySafetyFloors(profiled, legacy),
    task_intent_id: taskIntent.task_intent_id,
  };
  const execution_plan = createExecutionPlan({
    taskIntent: clone(taskIntent), riskProfile: task_profile.risk_profile,
    executionEvidence: normalizedWorkItem.execution_evidence || {},
  });
  return Object.freeze({ task_profile: Object.freeze(task_profile), execution_plan });
}

module.exports = { createProfiledExecutionPlan, normalizeLegacyRiskProfile };
