const MODES = new Set(["plain", "skills", "orquesta"]);
const REQUIRED_MODES = ["plain", "skills", "orquesta"];
const RUN_STATUSES = new Set([
  "prepared",
  "running",
  "finalized",
  "timeout",
  "invalid",
  "infrastructure_error"
]);
const VERIFIER_STATUSES = new Set([
  "passed",
  "failed",
  "infrastructure_error",
  "not_run"
]);
const COVERAGES = new Set(["unknown", "partial", "complete"]);

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonNegative(value) {
  return Number.isFinite(value) && value >= 0;
}

function duplicate(values) {
  return values.length !== new Set(values).size;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateExecution(execution, errors, label = "execution") {
  if (!object(execution)) {
    errors.push(`${label} is required`);
    return;
  }
  if (execution.model !== "gpt-5.6-sol") errors.push(`${label}.model must be gpt-5.6-sol`);
  if (execution.reasoning_effort !== "high") errors.push(`${label}.reasoning_effort must be high`);
  if (!["workspace-write", "danger-full-access"].includes(execution.sandbox)) {
    errors.push(`${label}.sandbox is invalid`);
  }
  if (execution.approval_policy !== "never") errors.push(`${label}.approval_policy must be never`);
  if (execution.agent_timeout_sec !== 900) errors.push(`${label}.agent_timeout_sec must be 900`);
  if (execution.verifier_timeout_sec !== 60) errors.push(`${label}.verifier_timeout_sec must be 60`);
}

export function validateManifest(value) {
  const errors = [];
  if (!object(value)) return { ok: false, errors: ["manifest must be an object"] };
  if (value.schema_version !== 2) errors.push("schema_version must be 2");
  if (value.benchmark_id !== "orquesta-v4-product") errors.push("benchmark_id is invalid");
  if (
    !Array.isArray(value.modes)
    || value.modes.length !== REQUIRED_MODES.length
    || duplicate(value.modes)
    || value.modes.some((mode) => !MODES.has(mode))
    || REQUIRED_MODES.some((mode) => !value.modes.includes(mode))
  ) {
    errors.push("modes must contain plain, skills, and orquesta exactly once");
  }
  validateExecution(value.execution, errors);
  if (!Array.isArray(value.tasks) || value.tasks.length === 0) {
    errors.push("manifest must contain at least one task");
  } else {
    const taskIds = value.tasks.map((task) => task?.id);
    if (
      duplicate(taskIds)
      || taskIds.some((id) => typeof id !== "string" || !/^[a-z0-9-]+$/u.test(id))
    ) {
      errors.push("task ids must be unique lowercase identifiers");
    }
    const organizationTask = value.tasks.find(
      (task) => task?.id === "organization-json-generator"
    );
    if (!organizationTask) {
      errors.push("manifest must contain the organization-json-generator task");
    } else if (organizationTask.fixed_inputs?.organization_name !== "Pilot Organization") {
      errors.push("organization_name must be Pilot Organization");
    } else if (organizationTask.fixed_inputs?.organization_founded !== "2020-01-01") {
      errors.push("organization_founded must be 2020-01-01");
    }
  }
  return { ok: errors.length === 0, errors };
}

export function validateRunResult(value, manifest) {
  const errors = [];
  if (!object(value)) return { ok: false, errors: ["run result must be an object"] };
  const taskIds = new Set(manifest?.tasks?.map((task) => task.id) || []);
  if (value.schema_version !== 2) errors.push("schema_version must be 2");
  if (value.benchmark_id !== manifest?.benchmark_id) errors.push("benchmark_id does not match manifest");
  if (typeof value.matrix_id !== "string" || !value.matrix_id) errors.push("matrix_id is required");
  if (!taskIds.has(value.task_id)) errors.push("task_id is not present in manifest");
  if (!MODES.has(value.mode)) errors.push("mode is invalid");
  if (!RUN_STATUSES.has(value.status)) errors.push("status is invalid");
  validateExecution(value.runtime, errors, "runtime");
  if (object(manifest?.execution) && !sameJson(value.runtime, manifest.execution)) {
    errors.push("runtime does not match the shared manifest execution contract");
  }
  if (!nonNegative(value.wall_time_ms)) errors.push("wall_time_ms must be non-negative");

  if (
    !VERIFIER_STATUSES.has(value.verifier?.status)
    || typeof value.verifier?.passed !== "boolean"
    || !nonNegative(value.verifier?.duration_ms)
  ) {
    errors.push("verifier result is invalid");
  }

  const usage = value.token_usage;
  if (!object(usage) || !COVERAGES.has(usage.coverage)) {
    errors.push("token coverage is invalid");
  } else {
    const totals = usage.totals;
    const tokenKeys = [
      "input_tokens",
      "uncached_input_tokens",
      "cached_input_tokens",
      "output_tokens",
      "reasoning_output_tokens",
      "total_tokens"
    ];
    if (usage.coverage === "unknown") {
      if (totals !== null || !Array.isArray(usage.by_thread) || usage.by_thread.length !== 0) {
        errors.push("unknown coverage requires null totals and no thread evidence");
      }
    } else if (!object(totals) || tokenKeys.some((key) => !nonNegative(totals[key]))) {
      errors.push("token totals must be non-negative");
    }
    if (!Array.isArray(usage.by_thread)) errors.push("token by_thread must be an array");
    if (
      usage.coverage === "complete"
      && (!Array.isArray(usage.by_thread) || usage.by_thread.length === 0)
    ) {
      errors.push("complete coverage requires at least one thread");
    }
  }

  return { ok: errors.length === 0, errors };
}

export function classifyStoredResult(value) {
  if (value?.schema_version === 1 && value?.mode === "solo") {
    return {
      classification: "legacy_pilot",
      original_mode: "solo",
      eligible_for_matrix: false
    };
  }
  if (value?.schema_version === 2 && MODES.has(value?.mode)) {
    return {
      classification: "matrix_run",
      original_mode: value.mode,
      eligible_for_matrix: true
    };
  }
  return {
    classification: "unknown",
    original_mode: value?.mode ?? null,
    eligible_for_matrix: false
  };
}

export function assertValid(name, validation) {
  if (!validation.ok) throw new Error(`${name} is invalid:\n- ${validation.errors.join("\n- ")}`);
}
