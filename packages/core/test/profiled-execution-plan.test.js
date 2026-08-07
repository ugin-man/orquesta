"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createTaskIntent } = require("../src/task-intent");
const { createProfiledExecutionPlan } = require("../src/profiled-execution-plan");

function intent({ outcome = "Inspect the local workspace", risk = { impact: "low", reversible: true } } = {}) {
  return createTaskIntent({
    rawRequestRef: "request:profiled-plan",
    desiredOutcome: outcome,
    acceptanceCriteria: ["Run a deterministic check"],
    constraints: ["Keep work within the approved repository."],
    risk,
    authorityBoundary: { agent_may: ["read approved project context"], user_only: ["authorize external actions"] },
    assumptions: [],
    status: "compiled",
  });
}

test("profiled execution plans derive tiny, standard, and critical lanes from structured inputs", () => {
  const tiny = createProfiledExecutionPlan({
    taskIntent: intent(),
    workItem: { scope_boundaries: ["docs"], effects: ["local_read"], verification_method: "deterministic" },
  });
  const standard = createProfiledExecutionPlan({
    taskIntent: intent(),
    workItem: { scope_boundaries: ["docs", "src"], effects: ["local_read"], verification_method: "deterministic" },
  });
  const critical = createProfiledExecutionPlan({
    taskIntent: intent(),
    workItem: { scope_boundaries: ["docs"], effects: ["external_write"], verification_method: "deterministic" },
  });

  assert.equal(tiny.execution_plan.lane, "fast");
  assert.equal(standard.execution_plan.lane, "standard");
  assert.equal(critical.execution_plan.lane, "critical");
  assert.ok(critical.task_profile.reason_codes.includes("critical_effect:external_write"));
  assert.ok(critical.task_profile.evidence_refs.includes("work_item:effects"));
});

test("profiled execution plans preserve explicit risk and accept legacy profiles only as safety floors", () => {
  const explicitCritical = createProfiledExecutionPlan({
    taskIntent: intent({ risk: { impact: "high", reversible: false } }),
    workItem: { scope_boundaries: ["docs"], effects: ["local_read"], verification_method: "deterministic", control_signals: { consequence: "low" } },
    legacyRiskProfile: { effects: ["workspace_write"], user_review: "default" },
  });
  const legacyCritical = createProfiledExecutionPlan({
    taskIntent: intent(),
    workItem: { scope_boundaries: ["docs"], effects: ["local_read"], verification_method: "deterministic" },
    legacyRiskProfile: { effects: ["external_write"] },
  });
  const legacyMultipleBoundaries = createProfiledExecutionPlan({
    taskIntent: intent(),
    workItem: { scope_boundaries: ["docs"], effects: ["local_read"], verification_method: "deterministic" },
    legacyRiskProfile: { scope: "multiple_boundaries" },
  });

  assert.equal(explicitCritical.execution_plan.lane, "critical");
  assert.equal(explicitCritical.execution_plan.risk_profile.reversibility, "irreversible");
  assert.equal(legacyCritical.execution_plan.lane, "critical");
  assert.equal(legacyMultipleBoundaries.execution_plan.lane, "standard");
  assert.equal(legacyMultipleBoundaries.task_profile.control_signals.context_breadth, "high");
  assert.ok(legacyCritical.task_profile.reason_codes.includes("legacy:risk_profile_safety_floor"));
  assert.throws(() => createProfiledExecutionPlan({ taskIntent: intent(), legacyRiskProfile: { unknown: true } }), /not supported/u);
});
