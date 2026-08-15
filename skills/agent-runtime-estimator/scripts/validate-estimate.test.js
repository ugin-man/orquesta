"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { validateEstimate } = require("./validate-estimate");

function validEstimate() {
  return {
    version: 1,
    scope: {
      task: "Implement and verify one bounded feature",
      done_signal: "targeted checks pass",
      environment: "cold-start test profile",
    },
    work: {
      critical_path_units_p50: 4,
      critical_path_units_p80: 7,
      total_units_p50: 6,
      total_units_p80: 10,
      parallel_branches: 2,
      unit_breakdown: [
        { kind: "inspect", p50: 1, p80: 1, note: "read relevant files" },
        { kind: "change", p50: 2, p80: 3, note: "implementation" },
        { kind: "verify", p50: 1, p80: 2, note: "targeted checks" },
        { kind: "repair_cycle", p50: 0, p80: 1, note: "plausible correction" },
      ],
    },
    runtime: {
      agent_active_minutes: { p50: 8, p80: 28 },
      elapsed_minutes: { p50: 10, p80: 34 },
      human_intervention_minutes: { p50: 0, p80: 0 },
    },
    calibration: {
      mode: "cold_start",
      profile_key: "",
      sample_count: 0,
      active_minutes_per_critical_unit: { p50: 2, p80: 4 },
    },
    external_gates: [],
    uncertainty_drivers: ["test failures may add a repair cycle"],
    confidence: 0.4,
  };
}

test("accepts a valid cold-start estimate", () => {
  const value = validEstimate();
  assert.equal(validateEstimate(value), value);
});

test("rejects a human-style falsely precise cold-start confidence", () => {
  const value = validEstimate();
  value.confidence = 0.8;
  assert.throws(() => validateEstimate(value), /cold_start confidence/);
});

test("rejects elapsed time shorter than agent active time", () => {
  const value = validEstimate();
  value.runtime.elapsed_minutes.p50 = 7;
  assert.throws(() => validateEstimate(value), /elapsed minutes/);
});

test("rejects total work smaller than the critical path", () => {
  const value = validEstimate();
  value.work.total_units_p80 = 6;
  assert.throws(() => validateEstimate(value), /total units/);
});

test("requires unknown waits to remain unknown instead of fabricated", () => {
  const value = validEstimate();
  value.external_gates.push({
    name: "approval",
    status: "unknown_wait",
    blocks_done_signal: true,
    known_wait_minutes: 15,
  });
  assert.throws(() => validateEstimate(value), /unknown_wait/);
});
