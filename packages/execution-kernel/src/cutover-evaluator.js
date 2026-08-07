"use strict";

const ACTIONS = new Set([
  "dispatch",
  "wait_for_capacity",
  "wait_for_dependency",
  "suppress_duplicate",
]);
const REQUIRED_SCENARIOS = Object.freeze([
  "independent",
  "dependency_blocked",
  "capacity_blocked",
  "duplicate_active",
  "recovery",
  "failure_retry",
  "unknown_task",
]);
const DEFAULT_REQUIREMENTS = Object.freeze({
  min_live_orquesta_observations: 8,
  min_live_unknown_tasks: 2,
  min_live_benchmark_cases: 3,
  min_live_unknown_benchmark_cases: 2,
  solo_max_wall_time_ratio: 1.1,
  solo_max_token_ratio: 1.25,
  parallel_max_wall_time_ratio: 0.85,
  parallel_max_token_ratio_without_quality_gain: 2,
});

function finiteNonNegative(value) {
  return Number.isFinite(value) && value >= 0;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function gate(name, status, details) {
  return { name, status, details };
}

function ratio(numerator, denominator) {
  if (!finiteNonNegative(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return null;
  }
  return numerator / denominator;
}

function liveOrquestaObservations(observations) {
  return observations.filter((item) => (
    item?.evidence_kind === "live"
    && item?.surface === "orquesta_task_dispatch"
  ));
}

function liveBenchmarkCases(benchmarkCases) {
  return benchmarkCases.filter((item) => item?.evidence_kind === "live");
}

function observationGates(observations, requirements) {
  const live = liveOrquestaObservations(observations);
  const unknownCount = live.filter((item) => item.task_origin === "unknown").length;
  const scenarios = new Set(live.map((item) => item.scenario).filter(Boolean));
  const missingScenarios = REQUIRED_SCENARIOS.filter((scenario) => !scenarios.has(scenario));
  const invalidActions = live.filter((item) => (
    !ACTIONS.has(item.predicted_action) || !ACTIONS.has(item.expected_action)
  ));
  const mismatches = live.filter((item) => (
    ACTIONS.has(item.predicted_action)
    && ACTIONS.has(item.expected_action)
    && item.predicted_action !== item.expected_action
  ));
  const extraTurns = live.filter((item) => item.additional_codex_turns !== 0);
  const dispatches = live.filter((item) => item.predicted_action === "dispatch");
  const missingDispatchIds = dispatches.filter((item) => (
    typeof item.predicted_dispatch_id !== "string" || !item.predicted_dispatch_id
  ));
  const dispatchIdentities = dispatches
    .filter((item) => (
      typeof item.predicted_dispatch_id === "string"
      && item.predicted_dispatch_id
    ))
    .map((item) => ({
      run_scope: item.source_run_id || "unscoped",
      dispatch_id: item.predicted_dispatch_id,
    }));
  const dispatchKeys = dispatchIdentities.map(
    (item) => `${item.run_scope}\u0000${item.dispatch_id}`
  );
  const duplicateDispatchKeys = [...new Set(dispatchKeys.filter(
    (value, index) => dispatchKeys.indexOf(value) !== index
  ))];
  const duplicateDispatchIds = duplicateDispatchKeys.map((value) => {
    const separator = value.indexOf("\u0000");
    return {
      run_scope: value.slice(0, separator),
      dispatch_id: value.slice(separator + 1),
    };
  });
  const legacyAccepted = live.filter((item) => item.actual_action === "dispatch_accepted");
  const missingRuntimeIdentity = legacyAccepted.filter((item) => (
    typeof item.actual_thread_id !== "string" || !item.actual_thread_id
    || typeof item.actual_turn_id !== "string" || !item.actual_turn_id
  ));
  const recovery = live.filter((item) => item.scenario === "recovery");
  const failedRecovery = recovery.filter((item) => item.recovered_without_redispatch !== true);
  const retry = live.filter((item) => item.scenario === "failure_retry");
  const unboundedRetry = retry.filter((item) => item.retry_bounded !== true);

  return {
    live,
    gates: [
      gate(
        "live_dispatch_coverage",
        live.length >= requirements.min_live_orquesta_observations
          && unknownCount >= requirements.min_live_unknown_tasks
          ? "pass"
          : "insufficient",
        {
          observed: live.length,
          required: requirements.min_live_orquesta_observations,
          unknown_tasks_observed: unknownCount,
          unknown_tasks_required: requirements.min_live_unknown_tasks,
        }
      ),
      gate(
        "scenario_coverage",
        missingScenarios.length === 0 ? "pass" : "insufficient",
        { required: [...REQUIRED_SCENARIOS], missing: missingScenarios }
      ),
      gate(
        "scheduler_correctness",
        invalidActions.length || mismatches.length || missingDispatchIds.length || duplicateDispatchIds.length
          ? "fail"
          : live.length
            ? "pass"
            : "insufficient",
        {
          invalid_action_observations: invalidActions.map((item) => item.observation_id ?? null),
          mismatched_observations: mismatches.map((item) => item.observation_id ?? null),
          missing_dispatch_ids: missingDispatchIds.map((item) => item.observation_id ?? null),
          duplicate_dispatch_ids: duplicateDispatchIds,
        }
      ),
      gate(
        "runtime_identity",
        missingRuntimeIdentity.length
          ? "fail"
          : legacyAccepted.length
            ? "pass"
            : "insufficient",
        {
          accepted_dispatches: legacyAccepted.length,
          missing_identity: missingRuntimeIdentity.map((item) => item.observation_id ?? null),
        }
      ),
      gate(
        "recovery_and_retry",
        failedRecovery.length || unboundedRetry.length
          ? "fail"
          : recovery.length && retry.length
            ? "pass"
            : "insufficient",
        {
          recovery_observations: recovery.length,
          retry_observations: retry.length,
          recovery_failures: failedRecovery.map((item) => item.observation_id ?? null),
          unbounded_retries: unboundedRetry.map((item) => item.observation_id ?? null),
        }
      ),
      gate(
        "no_additional_codex_turns",
        extraTurns.length
          ? "fail"
          : live.length
            ? "pass"
            : "insufficient",
        {
          additional_turns: extraTurns.reduce(
            (total, item) => total + (Number(item.additional_codex_turns) || 0),
            0
          ),
          violating_observations: extraTurns.map((item) => item.observation_id ?? null),
        }
      ),
    ],
  };
}

function benchmarkGates(benchmarkCases, requirements) {
  const live = liveBenchmarkCases(benchmarkCases);
  const unknownCount = live.filter((item) => item.task_origin === "unknown").length;
  const qualityFailures = live.filter((item) => item.quality_passed !== true);
  const complete = live.filter((item) => (
    ratio(item.kernel?.wall_time_ms, item.plain?.wall_time_ms) !== null
    && ratio(item.kernel?.total_tokens, item.plain?.total_tokens) !== null
  ));
  const solo = complete.filter((item) => item.execution_mode === "solo_direct");
  const parallel = complete.filter((item) => item.execution_mode === "bounded_parallel");
  const soloWallRatios = solo.map((item) => ratio(
    item.kernel.wall_time_ms,
    item.plain.wall_time_ms
  ));
  const soloTokenRatios = solo.map((item) => ratio(
    item.kernel.total_tokens,
    item.plain.total_tokens
  ));
  const soloWallMedian = median(soloWallRatios);
  const soloTokenMedian = median(soloTokenRatios);
  const parallelWithoutValue = parallel.filter((item) => (
    ratio(item.kernel.wall_time_ms, item.plain.wall_time_ms)
      > requirements.parallel_max_wall_time_ratio
    && item.quality_benefit !== true
  ));
  const tokenBloat = complete.filter((item) => (
    ratio(item.kernel.total_tokens, item.plain.total_tokens)
      > requirements.parallel_max_token_ratio_without_quality_gain
    && item.quality_benefit !== true
  ));

  return {
    live,
    gates: [
      gate(
        "benchmark_coverage",
        live.length >= requirements.min_live_benchmark_cases
          && unknownCount >= requirements.min_live_unknown_benchmark_cases
          && complete.length === live.length
          && solo.length > 0
          && parallel.length > 0
          ? "pass"
          : "insufficient",
        {
          observed: live.length,
          required: requirements.min_live_benchmark_cases,
          unknown_tasks_observed: unknownCount,
          unknown_tasks_required: requirements.min_live_unknown_benchmark_cases,
          complete_metrics: complete.length,
          solo_cases: solo.length,
          bounded_parallel_cases: parallel.length,
        }
      ),
      gate(
        "quality",
        qualityFailures.length
          ? "fail"
          : live.length
            ? "pass"
            : "insufficient",
        { failed_cases: qualityFailures.map((item) => item.case_id ?? null) }
      ),
      gate(
        "solo_efficiency",
        soloWallMedian === null || soloTokenMedian === null
          ? "insufficient"
          : soloWallMedian <= requirements.solo_max_wall_time_ratio
            && soloTokenMedian <= requirements.solo_max_token_ratio
            ? "pass"
            : "fail",
        {
          wall_time_ratio_median: soloWallMedian,
          wall_time_ratio_limit: requirements.solo_max_wall_time_ratio,
          token_ratio_median: soloTokenMedian,
          token_ratio_limit: requirements.solo_max_token_ratio,
        }
      ),
      gate(
        "parallel_value",
        !parallel.length
          ? "insufficient"
          : parallelWithoutValue.length
            ? "fail"
            : "pass",
        {
          wall_time_ratio_limit: requirements.parallel_max_wall_time_ratio,
          cases_without_value: parallelWithoutValue.map((item) => item.case_id ?? null),
        }
      ),
      gate(
        "token_bloat",
        !complete.length
          ? "insufficient"
          : tokenBloat.length
            ? "fail"
            : "pass",
        {
          ratio_limit_without_quality_gain:
            requirements.parallel_max_token_ratio_without_quality_gain,
          violating_cases: tokenBloat.map((item) => item.case_id ?? null),
        }
      ),
    ],
  };
}

function normalizeRequirements(input = {}) {
  return { ...DEFAULT_REQUIREMENTS, ...(input ?? {}) };
}

function cutoverStatus(gates) {
  if (gates.some((item) => item.status === "fail")) return "fail";
  if (gates.some((item) => item.status === "insufficient")) return "insufficient_evidence";
  return "pass";
}

function evaluateExecutionKernelCutover({
  observations = [],
  benchmark_cases: benchmarkCases = [],
  requirements: requirementOverrides = {},
} = {}) {
  if (!Array.isArray(observations)) throw new TypeError("observations must be an array");
  if (!Array.isArray(benchmarkCases)) throw new TypeError("benchmark_cases must be an array");
  const requirements = normalizeRequirements(requirementOverrides);
  const observationEvaluation = observationGates(observations, requirements);
  const benchmarkEvaluation = benchmarkGates(benchmarkCases, requirements);
  const gates = [...observationEvaluation.gates, ...benchmarkEvaluation.gates];
  const status = cutoverStatus(gates);

  return {
    schema_version: 1,
    evaluator: "orquesta_execution_kernel_cutover",
    status,
    cutover_allowed: status === "pass",
    requirements,
    summary: {
      total_observations: observations.length,
      live_orquesta_observations: observationEvaluation.live.length,
      desktop_only_observations: observations.filter(
        (item) => item?.surface === "desktop_runtime_send"
      ).length,
      total_benchmark_cases: benchmarkCases.length,
      live_benchmark_cases: benchmarkEvaluation.live.length,
      passed_gates: gates.filter((item) => item.status === "pass").length,
      failed_gates: gates.filter((item) => item.status === "fail").length,
      insufficient_gates: gates.filter((item) => item.status === "insufficient").length,
    },
    gates,
  };
}

module.exports = {
  DEFAULT_REQUIREMENTS,
  REQUIRED_SCENARIOS,
  evaluateExecutionKernelCutover,
};
