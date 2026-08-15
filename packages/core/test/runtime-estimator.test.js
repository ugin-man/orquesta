"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createRuntimeEstimate,
  deriveCalibrationProfile,
  validateRuntimeEstimate
} = require("../src/runtime-estimator");

const intent = {
  task_intent_id: "TI-0123456789ab",
  desired_outcome: "Implement and verify a bounded runtime estimator.",
  acceptance_criteria: ["The estimator returns a validated result."],
};

function taskProfile(overrides = {}) {
  return {
    recommended_work_mode: "implementation",
    risk_profile: {
      reversibility: "easy",
      scope: "single_boundary",
      verification: "deterministic",
      uncertainty: "low",
      effects: ["workspace_write"],
      repeated_failures: 0,
      user_review: "default",
      ...overrides
    }
  };
}

function executionPlan(overrides = {}) {
  return {
    lane: "fast",
    execution_mode: "solo_direct",
    review_policy: "none",
    budget: { max_correction_batches: 1 },
    risk_profile: taskProfile().risk_profile,
    ...overrides
  };
}

test("cold-start estimate uses agent clocks and low confidence", () => {
  const estimate = createRuntimeEstimate({
    taskIntent: intent,
    taskProfile: taskProfile(),
    executionPlan: executionPlan()
  });
  assert.equal(estimate.source, "profile_inferred");
  assert.equal(estimate.calibration.mode, "cold_start");
  assert.ok(estimate.runtime.agent_active_minutes.p50 > 0);
  assert.ok(estimate.runtime.elapsed_minutes.p80 >= estimate.runtime.agent_active_minutes.p80);
  assert.equal(estimate.runtime.human_intervention_minutes.p50, 0);
  assert.ok(estimate.confidence <= 0.5);
});

test("accepts the standalone skill contract without recomputing it", () => {
  const declared = {
    version: 1,
    scope: { task: "Bounded change", done_signal: "Tests pass", environment: "codex|high|repo" },
    work: {
      critical_path_units_p50: 3,
      critical_path_units_p80: 5,
      total_units_p50: 6,
      total_units_p80: 9,
      parallel_branches: 2,
      unit_breakdown: [
        { kind: "inspect", p50: 1, p80: 2, note: "" },
        { kind: "change", p50: 3, p80: 4, note: "" },
        { kind: "verify", p50: 2, p80: 3, note: "" }
      ]
    },
    runtime: {
      agent_active_minutes: { p50: 6, p80: 20 },
      elapsed_minutes: { p50: 8, p80: 22 },
      human_intervention_minutes: { p50: 0, p80: 3 }
    },
    calibration: {
      mode: "cold_start",
      profile_key: "codex|high|repo",
      sample_count: 0,
      active_minutes_per_critical_unit: { p50: 2, p80: 4 }
    },
    external_gates: [],
    uncertainty_drivers: ["test_latency"],
    confidence: 0.4
  };
  const estimate = createRuntimeEstimate({
    taskIntent: intent,
    taskProfile: taskProfile(),
    executionPlan: executionPlan({ execution_mode: "bounded_parallel" }),
    estimateInput: declared
  });
  assert.equal(estimate.source, "agent_decomposed");
  assert.deepEqual(estimate.runtime, declared.runtime);
  assert.equal(estimate.work.total_units_p50, 6);
  assert.match(estimate.runtime_estimate_id, /^RE-[a-f0-9]{12}$/);
});

test("known gates affect elapsed time while unknown gates do not fabricate wait", () => {
  const estimate = createRuntimeEstimate({
    taskIntent: intent,
    taskProfile: taskProfile(),
    executionPlan: executionPlan(),
    estimateInput: {
      external_gates: [
        { name: "build queue", status: "known_wait", blocks_done_signal: true, known_wait_minutes: 7 },
        { name: "human reply", status: "unknown_wait", blocks_done_signal: true, known_wait_minutes: null }
      ]
    }
  });
  assert.equal(
    estimate.runtime.elapsed_minutes.p50 - estimate.runtime.agent_active_minutes.p50,
    7
  );
  assert.equal(estimate.external_gates[1].known_wait_minutes, null);
});

test("derives hybrid then historical calibration from comparable observations", () => {
  const hybrid = deriveCalibrationProfile({
    profileKey: "p",
    observations: [
      { profile_key: "p", critical_path_units: 2, actual_agent_active_minutes: 2 },
      { profile_key: "other", critical_path_units: 1, actual_agent_active_minutes: 100 }
    ]
  });
  assert.equal(hybrid.mode, "hybrid");
  assert.equal(hybrid.sample_count, 1);

  const historical = deriveCalibrationProfile({
    profileKey: "p",
    observations: [1, 2, 3, 4, 5].map((ratio) => ({
      profile_key: "p",
      critical_path_units: 2,
      actual_agent_active_minutes: ratio * 2
    }))
  });
  assert.equal(historical.mode, "historical");
  assert.equal(historical.sample_count, 5);
  assert.equal(historical.active_minutes_per_critical_unit.p50, 3);
  assert.equal(historical.active_minutes_per_critical_unit.p80, 4);
});

test("rejects inverted uncertainty ranges", () => {
  const valid = createRuntimeEstimate({
    taskIntent: intent,
    taskProfile: taskProfile(),
    executionPlan: executionPlan()
  });
  const invalid = JSON.parse(JSON.stringify(valid));
  invalid.runtime.elapsed_minutes = { p50: 20, p80: 10 };
  assert.throws(() => validateRuntimeEstimate(invalid), /p80 must be >= p50/);
});

test("bounded parallel mode reduces critical path but not total work", () => {
  const estimate = createRuntimeEstimate({
    taskIntent: intent,
    taskProfile: taskProfile({ scope: "multiple_boundaries", verification: "mixed" }),
    executionPlan: executionPlan({
      lane: "standard",
      execution_mode: "bounded_parallel",
      review_policy: "independent_once",
      risk_profile: taskProfile({ scope: "multiple_boundaries", verification: "mixed" }).risk_profile
    })
  });
  assert.equal(estimate.work.parallel_branches, 2);
  assert.ok(estimate.work.total_units_p50 > estimate.work.critical_path_units_p50);
});
