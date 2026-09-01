"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluateExecutionKernelCutover } = require("../src");

function observation({
  id,
  scenario,
  action = "dispatch",
  origin = "known",
  overrides = {},
}) {
  return {
    observation_id: id,
    evidence_kind: "live",
    surface: "orquesta_task_dispatch",
    scenario,
    task_origin: origin,
    predicted_action: action,
    expected_action: action,
    predicted_dispatch_id: action === "dispatch" ? `D-${id}` : null,
    actual_action: action === "dispatch" ? "dispatch_accepted" : "not_dispatched",
    actual_thread_id: action === "dispatch" ? `thread-${id}` : null,
    actual_turn_id: action === "dispatch" ? `turn-${id}` : null,
    additional_codex_turns: 0,
    recovered_without_redispatch: scenario === "recovery" ? true : null,
    retry_bounded: scenario === "failure_retry" ? true : null,
    ...overrides,
  };
}

function completeObservations() {
  return [
    observation({ id: "日本語-1", scenario: "independent" }),
    observation({ id: "english-2", scenario: "dependency_blocked", action: "wait_for_dependency" }),
    observation({ id: "neutral-3", scenario: "capacity_blocked", action: "wait_for_capacity" }),
    observation({ id: "変異-4", scenario: "duplicate_active", action: "suppress_duplicate" }),
    observation({ id: "renamed-5", scenario: "recovery", action: "suppress_duplicate" }),
    observation({ id: "任意-6", scenario: "failure_retry", action: "dispatch" }),
    observation({ id: "unseen-7", scenario: "unknown_task", origin: "unknown" }),
    observation({ id: "未知-8", scenario: "unknown_task", origin: "unknown" }),
  ];
}

function benchmarkCase({
  id,
  mode,
  origin = "unknown",
  plainTime = 1000,
  kernelTime = 900,
  plainTokens = 1000,
  kernelTokens = 1100,
  qualityBenefit = false,
}) {
  return {
    case_id: id,
    evidence_kind: "live",
    task_origin: origin,
    execution_mode: mode,
    quality_passed: true,
    quality_benefit: qualityBenefit,
    plain: { wall_time_ms: plainTime, total_tokens: plainTokens },
    kernel: { wall_time_ms: kernelTime, total_tokens: kernelTokens },
  };
}

function passingEvidence() {
  return {
    observations: completeObservations(),
    benchmark_cases: [
      benchmarkCase({
        id: "solo-unseen",
        mode: "solo_direct",
        kernelTime: 1050,
        kernelTokens: 1200,
      }),
      benchmarkCase({
        id: "parallel-unseen",
        mode: "bounded_parallel",
        kernelTime: 800,
        kernelTokens: 1400,
      }),
      benchmarkCase({
        id: "parallel-known",
        mode: "bounded_parallel",
        origin: "known",
        kernelTime: 1000,
        kernelTokens: 1600,
        qualityBenefit: true,
      }),
    ],
  };
}

test("desktop composer evidence alone cannot authorize the multi-agent cutover", () => {
  const result = evaluateExecutionKernelCutover({
    observations: [{
      observation_id: "desktop-1",
      evidence_kind: "live",
      surface: "desktop_runtime_send",
      predicted_action: "dispatch",
      expected_action: "dispatch",
      additional_codex_turns: 0,
    }],
  });

  assert.equal(result.status, "insufficient_evidence");
  assert.equal(result.cutover_allowed, false);
  assert.equal(result.summary.desktop_only_observations, 1);
  assert.equal(result.summary.live_orquesta_observations, 0);
});

test("passes only with structural scheduler coverage and live performance evidence", () => {
  const result = evaluateExecutionKernelCutover(passingEvidence());
  assert.equal(result.status, "pass");
  assert.equal(result.cutover_allowed, true);
  assert.equal(result.summary.failed_gates, 0);
  assert.equal(result.summary.insufficient_gates, 0);
});

test("fails on a wrong structural decision, extra turn, or duplicate dispatch id", () => {
  const evidence = passingEvidence();
  evidence.observations[1].predicted_action = "dispatch";
  evidence.observations[1].predicted_dispatch_id = evidence.observations[0].predicted_dispatch_id;
  evidence.observations[1].additional_codex_turns = 1;
  const result = evaluateExecutionKernelCutover(evidence);

  assert.equal(result.status, "fail");
  assert.equal(result.cutover_allowed, false);
  assert.equal(result.gates.find((item) => item.name === "scheduler_correctness").status, "fail");
  assert.equal(result.gates.find((item) => item.name === "no_additional_codex_turns").status, "fail");
});

test("allows the same deterministic dispatch id in separate benchmark runs", () => {
  const evidence = passingEvidence();
  evidence.observations[0].source_run_id = "run-a";
  evidence.observations[1].source_run_id = "run-b";
  evidence.observations[1].predicted_dispatch_id =
    evidence.observations[0].predicted_dispatch_id;
  const result = evaluateExecutionKernelCutover(evidence);

  assert.equal(result.gates.find((item) => item.name === "scheduler_correctness").status, "pass");
});

test("fails performance gates without changing behavior based on task wording", () => {
  const evidence = passingEvidence();
  evidence.benchmark_cases[0].kernel.wall_time_ms = 1500;
  evidence.benchmark_cases[0].kernel.total_tokens = 1800;
  evidence.benchmark_cases[1].kernel.wall_time_ms = 980;
  evidence.benchmark_cases[1].kernel.total_tokens = 2500;
  const result = evaluateExecutionKernelCutover(evidence);

  assert.equal(result.status, "fail");
  assert.equal(result.gates.find((item) => item.name === "solo_efficiency").status, "fail");
  assert.equal(result.gates.find((item) => item.name === "parallel_value").status, "fail");
  assert.equal(result.gates.find((item) => item.name === "token_bloat").status, "fail");
});
