"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createTaskIntent } = require("../src/task-intent");
const { createProfiledExecutionPlan } = require("../src/profiled-execution-plan");

function intent() {
  return createTaskIntent({
    rawRequestRef: "request:runtime-estimate",
    desiredOutcome: "Implement and verify a bounded runtime estimate.",
    acceptanceCriteria: ["The runtime estimate is attached to the profiled plan."],
    constraints: ["Keep work within the approved repository."],
    risk: { impact: "low", reversible: true },
    authorityBoundary: { agent_may: ["edit approved files"], user_only: ["authorize external actions"] },
    assumptions: [],
    status: "compiled",
  });
}

test("profiled plans include a low-confidence cold-start runtime estimate", () => {
  const result = createProfiledExecutionPlan({
    taskIntent: intent(),
    workItem: {
      scope_boundaries: ["packages/core"],
      effects: ["workspace_write"],
      verification_method: "deterministic",
    },
  });

  assert.equal(result.runtime_estimate.task_intent_id, result.task_profile.task_intent_id);
  assert.equal(result.runtime_estimate.source, "profile_inferred");
  assert.equal(result.runtime_estimate.calibration.mode, "cold_start");
  assert.ok(result.runtime_estimate.runtime.agent_active_minutes.p50 > 0);
  assert.ok(result.runtime_estimate.confidence <= 0.5);
});

test("profiled plans accept the standalone estimator skill output as canonical input", () => {
  const taskIntent = intent();
  const runtimeEstimateInput = {
    version: 1,
    scope: {
      task: taskIntent.desired_outcome,
      done_signal: "The runtime estimate is attached to the profiled plan.",
      environment: "codex|reasoning-high|orquesta-core",
    },
    work: {
      critical_path_units_p50: 3,
      critical_path_units_p80: 5,
      total_units_p50: 5,
      total_units_p80: 8,
      parallel_branches: 2,
      unit_breakdown: [
        { kind: "inspect", p50: 1, p80: 2, note: "Inspect current planning flow." },
        { kind: "change", p50: 2, p80: 3, note: "Wire the estimate into the plan." },
        { kind: "verify", p50: 2, p80: 3, note: "Run focused checks." },
      ],
    },
    runtime: {
      agent_active_minutes: { p50: 6, p80: 20 },
      elapsed_minutes: { p50: 8, p80: 24 },
      human_intervention_minutes: { p50: 0, p80: 2 },
    },
    calibration: {
      mode: "cold_start",
      profile_key: "codex|reasoning-high|orquesta-core",
      sample_count: 0,
      active_minutes_per_critical_unit: { p50: 2, p80: 4 },
    },
    external_gates: [],
    uncertainty_drivers: ["test_latency"],
    confidence: 0.4,
  };

  const result = createProfiledExecutionPlan({
    taskIntent,
    workItem: {
      scope_boundaries: ["packages/core"],
      effects: ["workspace_write"],
      verification_method: "deterministic",
      runtime_estimate_input: runtimeEstimateInput,
    },
  });

  assert.equal(result.runtime_estimate.source, "agent_decomposed");
  assert.deepEqual(result.runtime_estimate.runtime, runtimeEstimateInput.runtime);
  assert.equal(result.runtime_estimate.work.parallel_branches, 2);
});
