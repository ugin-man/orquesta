"use strict";

const WEIGHTS_V1 = Object.freeze({
  task_fit: 30,
  integration_ease: 15,
  evidence_strength: 15,
  maintainability: 10,
  security: 10,
  license_fit: 10,
  exit_option: 5,
  cost: 5,
});

const AXES = Object.freeze(Object.keys(WEIGHTS_V1));

function auditError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function sameWeights(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return false;
  const keys = Object.keys(policy).sort();
  return keys.length === AXES.length && keys.every((key, index) => key === AXES.slice().sort()[index] && policy[key] === WEIGHTS_V1[key]);
}

function validateAxes(axes) {
  if (!axes || typeof axes !== "object" || Array.isArray(axes)) {
    throw auditError("AUDIT_AXES_INVALID", "Candidate axes must be an object.");
  }
  const keys = Object.keys(axes).sort();
  if (keys.length !== AXES.length || !AXES.slice().sort().every((axis, index) => keys[index] === axis)) {
    throw auditError("AUDIT_AXES_INVALID", "Candidate axes must contain exactly the Phase 1 axes.");
  }
  for (const axis of AXES) {
    const entry = axes[axis];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || typeof entry.value !== "number" || !Number.isFinite(entry.value)
      || typeof entry.reason !== "string" || !entry.reason.trim()) {
      throw auditError("AUDIT_AXIS_INVALID", `Candidate axis ${axis} is invalid.`, { axis });
    }
    if (entry.value < 0 || entry.value > 100) {
      throw auditError("AUDIT_AXIS_VALUE_INVALID", `Candidate axis ${axis} must be between 0 and 100.`, { axis, value: entry.value });
    }
  }
}

function scoreCandidate({ axes, uncertaintyPenalty, policy = WEIGHTS_V1 } = {}) {
  if (!sameWeights(policy)) throw auditError("AUDIT_POLICY_INVALID", "Only immutable Phase 1 weights are allowed.");
  validateAxes(axes);
  if (typeof uncertaintyPenalty !== "number" || !Number.isFinite(uncertaintyPenalty) || uncertaintyPenalty < 0 || uncertaintyPenalty > 100) {
    throw auditError("AUDIT_UNCERTAINTY_INVALID", "Uncertainty penalty must be between 0 and 100.");
  }

  const contributions = {};
  let weightedSum = 0;
  for (const axis of AXES) {
    const contribution = Number(((axes[axis].value * WEIGHTS_V1[axis]) / 100).toFixed(2));
    contributions[axis] = contribution.toFixed(2);
    weightedSum += contribution;
  }
  weightedSum = Number(weightedSum.toFixed(2));
  const candidateScore = Math.max(0, Number((weightedSum - uncertaintyPenalty).toFixed(2)));
  return { contributions, weighted_sum: weightedSum, candidate_score: candidateScore };
}

module.exports = { AXES, WEIGHTS_V1, auditError, scoreCandidate };
