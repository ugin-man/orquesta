"use strict";

const { assertContract, canonicalHash, canonicalJson } = require("@orquesta/contracts");

const UNIT_KINDS = new Set([
  "inspect", "research", "change", "execute", "verify", "repair_cycle", "review"
]);
const CALIBRATION_MODES = new Set(["cold_start", "historical", "hybrid"]);
const DEFAULT_CALIBRATION = Object.freeze({
  mode: "cold_start",
  profile_key: "",
  sample_count: 0,
  active_minutes_per_critical_unit: Object.freeze({ p50: 2, p80: 4 })
});

function clone(value) {
  return value === undefined ? undefined : JSON.parse(canonicalJson(value));
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function round(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function nonNegativeNumber(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${field} must be a finite non-negative number`);
  }
  return value;
}

function positiveInteger(value, field) {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${field} must be an integer >= 1`);
  return value;
}

function normalizeRange(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  const normalized = {
    p50: nonNegativeNumber(value.p50, `${field}.p50`),
    p80: nonNegativeNumber(value.p80, `${field}.p80`)
  };
  if (normalized.p80 < normalized.p50) throw new TypeError(`${field}.p80 must be >= p50`);
  return normalized;
}

function stringList(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new TypeError(`${field} must be an array of non-empty strings`);
  }
  return [...new Set(value.map((item) => item.trim()))].sort(compareText);
}

function percentile(values, probability) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(probability * sorted.length) - 1);
  return sorted[index];
}

function deriveCalibrationProfile({ profileKey = "", observations = [] } = {}) {
  if (typeof profileKey !== "string") throw new TypeError("profileKey must be a string");
  if (!Array.isArray(observations)) throw new TypeError("observations must be an array");
  const ratios = observations.flatMap((observation, index) => {
    if (!observation || typeof observation !== "object" || Array.isArray(observation)) {
      throw new TypeError(`observations[${index}] must be an object`);
    }
    if (observation.profile_key !== undefined && observation.profile_key !== profileKey) return [];
    const units = nonNegativeNumber(observation.critical_path_units, `observations[${index}].critical_path_units`);
    const active = nonNegativeNumber(observation.actual_agent_active_minutes, `observations[${index}].actual_agent_active_minutes`);
    if (units === 0) return [];
    return [active / units];
  });
  if (!ratios.length) return clone({ ...DEFAULT_CALIBRATION, profile_key: profileKey });

  const sampleP50 = percentile(ratios, 0.5);
  const sampleP80 = percentile(ratios, 0.8);
  const sampleCount = ratios.length;
  if (sampleCount < 5) {
    const weight = sampleCount / (sampleCount + 4);
    const p50 = round(DEFAULT_CALIBRATION.active_minutes_per_critical_unit.p50 * (1 - weight) + sampleP50 * weight);
    const p80 = round(Math.max(
      p50,
      DEFAULT_CALIBRATION.active_minutes_per_critical_unit.p80 * (1 - weight) + sampleP80 * weight
    ));
    return {
      mode: "hybrid",
      profile_key: profileKey,
      sample_count: sampleCount,
      active_minutes_per_critical_unit: { p50, p80 }
    };
  }
  return {
    mode: "historical",
    profile_key: profileKey,
    sample_count: sampleCount,
    active_minutes_per_critical_unit: {
      p50: round(sampleP50),
      p80: round(Math.max(sampleP50, sampleP80))
    }
  };
}

function normalizeCalibration(value, profileKey, observations) {
  if (value === undefined || value === null) return deriveCalibrationProfile({ profileKey, observations });
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("calibration must be an object");
  if (!CALIBRATION_MODES.has(value.mode)) throw new TypeError("calibration.mode is invalid");
  if (typeof value.profile_key !== "string") throw new TypeError("calibration.profile_key must be a string");
  if (!Number.isInteger(value.sample_count) || value.sample_count < 0) {
    throw new TypeError("calibration.sample_count must be an integer >= 0");
  }
  const normalized = {
    mode: value.mode,
    profile_key: value.profile_key || profileKey,
    sample_count: value.sample_count,
    active_minutes_per_critical_unit: normalizeRange(
      value.active_minutes_per_critical_unit,
      "calibration.active_minutes_per_critical_unit"
    )
  };
  if (normalized.mode === "cold_start" && normalized.sample_count !== 0) {
    throw new TypeError("cold_start calibration must have sample_count 0");
  }
  if (normalized.mode === "historical" && normalized.sample_count < 1) {
    throw new TypeError("historical calibration requires observations");
  }
  return normalized;
}

function normalizeExternalGates(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError("external_gates must be an array");
  return value.map((gate, index) => {
    if (!gate || typeof gate !== "object" || Array.isArray(gate)) {
      throw new TypeError(`external_gates[${index}] must be an object`);
    }
    if (typeof gate.name !== "string" || !gate.name.trim()) {
      throw new TypeError(`external_gates[${index}].name must be a non-empty string`);
    }
    if (!["unknown_wait", "known_wait"].includes(gate.status)) {
      throw new TypeError(`external_gates[${index}].status is invalid`);
    }
    const known = gate.known_wait_minutes === null
      ? null
      : nonNegativeNumber(gate.known_wait_minutes, `external_gates[${index}].known_wait_minutes`);
    if (gate.status === "unknown_wait" && known !== null) {
      throw new TypeError(`external_gates[${index}] unknown_wait must use null known_wait_minutes`);
    }
    if (gate.status === "known_wait" && known === null) {
      throw new TypeError(`external_gates[${index}] known_wait requires known_wait_minutes`);
    }
    return {
      name: gate.name.trim(),
      status: gate.status,
      blocks_done_signal: gate.blocks_done_signal !== false,
      known_wait_minutes: known
    };
  });
}

function normalizeBreakdown(value) {
  if (!Array.isArray(value)) throw new TypeError("work.unit_breakdown must be an array");
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new TypeError(`work.unit_breakdown[${index}] must be an object`);
    }
    if (!UNIT_KINDS.has(item.kind)) throw new TypeError(`work.unit_breakdown[${index}].kind is invalid`);
    const p50 = nonNegativeNumber(item.p50, `work.unit_breakdown[${index}].p50`);
    const p80 = nonNegativeNumber(item.p80, `work.unit_breakdown[${index}].p80`);
    if (p80 < p50) throw new TypeError(`work.unit_breakdown[${index}].p80 must be >= p50`);
    if (item.note !== undefined && typeof item.note !== "string") {
      throw new TypeError(`work.unit_breakdown[${index}].note must be a string`);
    }
    return { kind: item.kind, p50, p80, note: item.note || "" };
  });
}

function normalizeFullEstimate(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("runtime estimate must be an object");
  if (value.version !== 1) throw new TypeError("runtime estimate version must be 1");
  if (!value.scope || typeof value.scope !== "object" || Array.isArray(value.scope)) {
    throw new TypeError("runtime estimate scope is required");
  }
  const scope = {};
  for (const field of ["task", "done_signal", "environment"]) {
    if (typeof value.scope[field] !== "string" || !value.scope[field].trim()) {
      throw new TypeError(`scope.${field} must be a non-empty string`);
    }
    scope[field] = value.scope[field].trim();
  }
  if (!value.work || typeof value.work !== "object" || Array.isArray(value.work)) {
    throw new TypeError("runtime estimate work is required");
  }
  const work = {
    critical_path_units_p50: nonNegativeNumber(value.work.critical_path_units_p50, "work.critical_path_units_p50"),
    critical_path_units_p80: nonNegativeNumber(value.work.critical_path_units_p80, "work.critical_path_units_p80"),
    total_units_p50: nonNegativeNumber(value.work.total_units_p50, "work.total_units_p50"),
    total_units_p80: nonNegativeNumber(value.work.total_units_p80, "work.total_units_p80"),
    parallel_branches: positiveInteger(value.work.parallel_branches, "work.parallel_branches"),
    unit_breakdown: normalizeBreakdown(value.work.unit_breakdown)
  };
  if (work.critical_path_units_p80 < work.critical_path_units_p50) {
    throw new TypeError("work.critical_path_units_p80 must be >= p50");
  }
  if (work.total_units_p80 < work.total_units_p50) throw new TypeError("work.total_units_p80 must be >= p50");
  if (work.total_units_p50 < work.critical_path_units_p50 || work.total_units_p80 < work.critical_path_units_p80) {
    throw new TypeError("total units must be >= critical path units");
  }
  if (!value.runtime || typeof value.runtime !== "object" || Array.isArray(value.runtime)) {
    throw new TypeError("runtime estimate runtime is required");
  }
  const runtime = {
    agent_active_minutes: normalizeRange(value.runtime.agent_active_minutes, "runtime.agent_active_minutes"),
    elapsed_minutes: normalizeRange(value.runtime.elapsed_minutes, "runtime.elapsed_minutes"),
    human_intervention_minutes: normalizeRange(value.runtime.human_intervention_minutes, "runtime.human_intervention_minutes")
  };
  if (runtime.elapsed_minutes.p50 < runtime.agent_active_minutes.p50
    || runtime.elapsed_minutes.p80 < runtime.agent_active_minutes.p80) {
    throw new TypeError("elapsed minutes must be >= agent active minutes");
  }
  const calibration = normalizeCalibration(value.calibration, value.calibration?.profile_key || "", []);
  const external_gates = normalizeExternalGates(value.external_gates);
  const uncertainty_drivers = stringList(value.uncertainty_drivers, "uncertainty_drivers");
  const confidence = nonNegativeNumber(value.confidence, "confidence");
  if (confidence > 1) throw new TypeError("confidence must be <= 1");
  if (calibration.mode === "cold_start" && confidence > 0.5) {
    throw new TypeError("cold_start confidence must be <= 0.5");
  }
  return {
    version: 1,
    scope,
    work,
    runtime,
    calibration,
    external_gates,
    uncertainty_drivers,
    confidence
  };
}

function inferredBreakdown(taskProfile, executionPlan) {
  const risk = taskProfile?.risk_profile || executionPlan?.risk_profile || {};
  const effects = Array.isArray(risk.effects) ? risk.effects : ["local_read"];
  const writeWork = effects.some((effect) => effect !== "local_read");
  const multiple = risk.scope === "multiple_boundaries";
  const highUncertainty = risk.uncertainty === "high";
  const breakdown = [];
  const add = (kind, p50, p80, note) => {
    if (p80 > 0) breakdown.push({ kind, p50: round(p50), p80: round(p80), note });
  };

  const inspectP50 = multiple ? 2 : 1;
  add("inspect", inspectP50, inspectP50 + (highUncertainty ? 2 : 1), "Inspect task scope and relevant project evidence.");

  const workMode = String(taskProfile?.recommended_work_mode || "");
  if (["research", "exploration", "audit"].includes(workMode)) {
    add("research", 1, highUncertainty ? 3 : 2, "Resolve task-specific evidence gaps.");
  }

  if (writeWork) {
    let changeP50 = multiple ? 3 : 1;
    if (effects.some((effect) => ["dependency_change", "data_migration", "security_boundary"].includes(effect))) changeP50 += 1;
    add("change", changeP50, changeP50 + (highUncertainty ? 2 : 1), "Implement the bounded workspace change.");
    add("execute", 1, 2, "Run relevant commands, builds, or generated outputs.");
  }

  if (risk.verification === "human_only") add("verify", 0.5, 1, "Prepare evidence for human verification.");
  else if (risk.verification === "mixed") add("verify", 1.5, 3, "Run deterministic checks and prepare semantic review.");
  else add("verify", 1, 2, "Run deterministic acceptance checks.");

  if (executionPlan?.review_policy === "independent_once") add("review", 1, 2, "One independent review cycle.");
  if (executionPlan?.review_policy === "independent_twice") add("review", 2, 3, "Two independent review cycles.");

  const corrections = executionPlan?.budget?.max_correction_batches;
  if (writeWork && Number.isInteger(corrections) && corrections > 0) {
    const p50 = risk.repeated_failures > 0 ? 1 : highUncertainty ? 0.5 : 0.25;
    add("repair_cycle", p50, corrections, "Plausible correction work within the execution budget.");
  }
  return breakdown;
}

function workTotals(breakdown, parallelBranches) {
  const totalP50 = round(breakdown.reduce((sum, item) => sum + item.p50, 0));
  const totalP80 = round(breakdown.reduce((sum, item) => sum + item.p80, 0));
  if (parallelBranches === 1) {
    return {
      critical_path_units_p50: totalP50,
      critical_path_units_p80: totalP80,
      total_units_p50: totalP50,
      total_units_p80: totalP80
    };
  }
  const parallelKinds = new Set(["research", "change", "verify"]);
  const parallelP50 = breakdown.filter((item) => parallelKinds.has(item.kind)).reduce((sum, item) => sum + item.p50, 0);
  const parallelP80 = breakdown.filter((item) => parallelKinds.has(item.kind)).reduce((sum, item) => sum + item.p80, 0);
  const savedP50 = parallelP50 * (1 - (1 / parallelBranches));
  const savedP80 = parallelP80 * (1 - (1 / parallelBranches));
  return {
    critical_path_units_p50: round(Math.max(0, totalP50 - savedP50)),
    critical_path_units_p80: round(Math.max(0, totalP80 - savedP80)),
    total_units_p50: totalP50,
    total_units_p80: totalP80
  };
}

function inferredHumanMinutes(taskProfile, executionPlan) {
  const risk = taskProfile?.risk_profile || executionPlan?.risk_profile || {};
  if (risk.verification === "human_only") return { p50: 5, p80: 20 };
  if (risk.user_review === "strict") return { p50: 2, p80: 10 };
  if (risk.verification === "mixed") return { p50: 1, p80: 5 };
  return { p50: 0, p80: 0 };
}

function defaultProfileKey(taskProfile, executionPlan) {
  const risk = taskProfile?.risk_profile || executionPlan?.risk_profile || {};
  return [
    taskProfile?.recommended_work_mode || "unknown_mode",
    executionPlan?.lane || "unknown_lane",
    executionPlan?.execution_mode || "unknown_execution",
    risk.scope || "unknown_scope",
    risk.verification || "unknown_verification"
  ].join("|");
}

function inferredEstimate({ taskIntent, taskProfile, executionPlan, estimateInput, calibration, observations }) {
  const profileKey = typeof estimateInput.profile_key === "string" ? estimateInput.profile_key : defaultProfileKey(taskProfile, executionPlan);
  const normalizedCalibration = normalizeCalibration(calibration, profileKey, observations);
  const parallelBranches = estimateInput.parallel_branches === undefined
    ? executionPlan?.execution_mode === "bounded_parallel" ? 2 : 1
    : positiveInteger(estimateInput.parallel_branches, "parallel_branches");
  const breakdown = inferredBreakdown(taskProfile, executionPlan);
  const totals = workTotals(breakdown, parallelBranches);
  const gates = normalizeExternalGates(estimateInput.external_gates);
  const knownWait = gates.reduce((sum, gate) => sum + (gate.known_wait_minutes || 0), 0);
  const active = {
    p50: round(totals.critical_path_units_p50 * normalizedCalibration.active_minutes_per_critical_unit.p50),
    p80: round(totals.critical_path_units_p80 * normalizedCalibration.active_minutes_per_critical_unit.p80)
  };
  const human = estimateInput.human_intervention_minutes === undefined
    ? inferredHumanMinutes(taskProfile, executionPlan)
    : normalizeRange(estimateInput.human_intervention_minutes, "human_intervention_minutes");
  const risk = taskProfile?.risk_profile || executionPlan?.risk_profile || {};
  const uncertaintyDrivers = [
    "profile_inferred_work_units",
    ...(normalizedCalibration.mode === "cold_start" ? ["cold_start_calibration"] : []),
    ...(risk.uncertainty === "high" ? ["high_scope_uncertainty"] : []),
    ...(risk.repeated_failures > 0 ? ["repeated_failures"] : []),
    ...(risk.verification === "human_only" ? ["human_only_verification"] : []),
    ...(gates.length ? ["external_gate_latency"] : []),
    ...stringList(estimateInput.uncertainty_drivers, "uncertainty_drivers")
  ];
  const confidence = normalizedCalibration.mode === "historical"
    ? Math.min(0.8, 0.55 + normalizedCalibration.sample_count * 0.02)
    : normalizedCalibration.mode === "hybrid"
      ? Math.min(0.6, 0.35 + normalizedCalibration.sample_count * 0.04)
      : 0.3;
  return {
    version: 1,
    scope: {
      task: taskIntent.desired_outcome,
      done_signal: Array.isArray(taskIntent.acceptance_criteria) && taskIntent.acceptance_criteria.length
        ? taskIntent.acceptance_criteria.join("; ")
        : "The task is accepted against its canonical completion evidence.",
      environment: typeof estimateInput.environment === "string" && estimateInput.environment.trim()
        ? estimateInput.environment.trim()
        : `orquesta:${profileKey}`
    },
    work: { ...totals, parallel_branches: parallelBranches, unit_breakdown: breakdown },
    runtime: {
      agent_active_minutes: active,
      elapsed_minutes: { p50: round(active.p50 + knownWait), p80: round(active.p80 + knownWait) },
      human_intervention_minutes: human
    },
    calibration: normalizedCalibration,
    external_gates: gates,
    uncertainty_drivers: [...new Set(uncertaintyDrivers)].sort(compareText),
    confidence: round(confidence)
  };
}

function createRuntimeEstimate({
  taskIntent,
  taskProfile = {},
  executionPlan = {},
  estimateInput = {},
  calibration,
  observations = []
} = {}) {
  const intent = assertContract("task-intent", clone(taskIntent));
  if (!estimateInput || typeof estimateInput !== "object" || Array.isArray(estimateInput)) {
    throw new TypeError("estimateInput must be an object");
  }
  const full = estimateInput.version === 1 && estimateInput.scope && estimateInput.work && estimateInput.runtime;
  const normalized = full
    ? normalizeFullEstimate(estimateInput)
    : inferredEstimate({
      taskIntent: intent,
      taskProfile: clone(taskProfile) || {},
      executionPlan: clone(executionPlan) || {},
      estimateInput: clone(estimateInput) || {},
      calibration: clone(calibration),
      observations: clone(observations) || []
    });
  const content = {
    task_intent_id: intent.task_intent_id,
    source: full ? "agent_decomposed" : "profile_inferred",
    ...normalized
  };
  return deepFreeze({
    runtime_estimate_id: `RE-${canonicalHash(content).slice(0, 12)}`,
    ...content
  });
}

function validateRuntimeEstimate(value) {
  const normalized = normalizeFullEstimate(value);
  if (value.task_intent_id !== undefined && (typeof value.task_intent_id !== "string" || !/^TI-[a-f0-9]{12}$/.test(value.task_intent_id))) {
    throw new TypeError("task_intent_id is invalid");
  }
  if (value.runtime_estimate_id !== undefined && (typeof value.runtime_estimate_id !== "string" || !/^RE-[a-f0-9]{12}$/.test(value.runtime_estimate_id))) {
    throw new TypeError("runtime_estimate_id is invalid");
  }
  if (value.source !== undefined && !["agent_decomposed", "profile_inferred"].includes(value.source)) {
    throw new TypeError("source is invalid");
  }
  return deepFreeze({
    ...(value.runtime_estimate_id ? { runtime_estimate_id: value.runtime_estimate_id } : {}),
    ...(value.task_intent_id ? { task_intent_id: value.task_intent_id } : {}),
    ...(value.source ? { source: value.source } : {}),
    ...normalized
  });
}

module.exports = {
  DEFAULT_CALIBRATION,
  UNIT_KINDS,
  createRuntimeEstimate,
  deriveCalibrationProfile,
  validateRuntimeEstimate
};
