"use strict";

const fs = require("node:fs");

const KINDS = new Set(["inspect", "research", "change", "execute", "verify", "repair_cycle", "review"]);
const MODES = new Set(["cold_start", "historical", "hybrid"]);

function fail(message) {
  throw new Error(message);
}

function number(value, path) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fail(`${path} must be a finite non-negative number`);
}

function range(value, path) {
  if (!value || typeof value !== "object") fail(`${path} must be an object`);
  number(value.p50, `${path}.p50`);
  number(value.p80, `${path}.p80`);
  if (value.p80 < value.p50) fail(`${path}.p80 must be >= p50`);
}

function validateEstimate(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("estimate must be an object");
  if (input.version !== 1) fail("version must be 1");

  if (!input.scope || typeof input.scope !== "object") fail("scope is required");
  for (const key of ["task", "done_signal", "environment"]) {
    if (typeof input.scope[key] !== "string" || !input.scope[key].trim()) fail(`scope.${key} must be a non-empty string`);
  }

  const work = input.work;
  if (!work || typeof work !== "object") fail("work is required");
  for (const key of ["critical_path_units_p50", "critical_path_units_p80", "total_units_p50", "total_units_p80"]) number(work[key], `work.${key}`);
  if (work.critical_path_units_p80 < work.critical_path_units_p50) fail("work.critical_path_units_p80 must be >= p50");
  if (work.total_units_p80 < work.total_units_p50) fail("work.total_units_p80 must be >= p50");
  if (work.total_units_p50 < work.critical_path_units_p50 || work.total_units_p80 < work.critical_path_units_p80) fail("total units must be >= critical path units");
  if (!Number.isInteger(work.parallel_branches) || work.parallel_branches < 1) fail("work.parallel_branches must be an integer >= 1");
  if (!Array.isArray(work.unit_breakdown)) fail("work.unit_breakdown must be an array");
  for (const [index, item] of work.unit_breakdown.entries()) {
    if (!item || typeof item !== "object") fail(`work.unit_breakdown[${index}] must be an object`);
    if (!KINDS.has(item.kind)) fail(`work.unit_breakdown[${index}].kind is invalid`);
    number(item.p50, `work.unit_breakdown[${index}].p50`);
    number(item.p80, `work.unit_breakdown[${index}].p80`);
    if (item.p80 < item.p50) fail(`work.unit_breakdown[${index}].p80 must be >= p50`);
    if (item.note != null && typeof item.note !== "string") fail(`work.unit_breakdown[${index}].note must be a string`);
  }

  if (!input.runtime || typeof input.runtime !== "object") fail("runtime is required");
  range(input.runtime.agent_active_minutes, "runtime.agent_active_minutes");
  range(input.runtime.elapsed_minutes, "runtime.elapsed_minutes");
  range(input.runtime.human_intervention_minutes, "runtime.human_intervention_minutes");
  if (input.runtime.elapsed_minutes.p50 < input.runtime.agent_active_minutes.p50 || input.runtime.elapsed_minutes.p80 < input.runtime.agent_active_minutes.p80) fail("elapsed minutes must be >= agent active minutes");

  const calibration = input.calibration;
  if (!calibration || typeof calibration !== "object") fail("calibration is required");
  if (!MODES.has(calibration.mode)) fail("calibration.mode is invalid");
  if (typeof calibration.profile_key !== "string") fail("calibration.profile_key must be a string");
  if (!Number.isInteger(calibration.sample_count) || calibration.sample_count < 0) fail("calibration.sample_count must be an integer >= 0");
  range(calibration.active_minutes_per_critical_unit, "calibration.active_minutes_per_critical_unit");

  if (!Array.isArray(input.external_gates)) fail("external_gates must be an array");
  for (const [index, gate] of input.external_gates.entries()) {
    if (!gate || typeof gate !== "object") fail(`external_gates[${index}] must be an object`);
    if (typeof gate.name !== "string" || !gate.name.trim()) fail(`external_gates[${index}].name must be non-empty`);
    if (gate.status !== "unknown_wait" && gate.status !== "known_wait") fail(`external_gates[${index}].status is invalid`);
    if (typeof gate.blocks_done_signal !== "boolean") fail(`external_gates[${index}].blocks_done_signal must be boolean`);
    if (gate.known_wait_minutes !== null) number(gate.known_wait_minutes, `external_gates[${index}].known_wait_minutes`);
    if (gate.status === "unknown_wait" && gate.known_wait_minutes !== null) fail(`external_gates[${index}] unknown_wait must use null known_wait_minutes`);
    if (gate.status === "known_wait" && gate.known_wait_minutes === null) fail(`external_gates[${index}] known_wait requires known_wait_minutes`);
  }

  if (!Array.isArray(input.uncertainty_drivers) || input.uncertainty_drivers.some((item) => typeof item !== "string")) fail("uncertainty_drivers must be an array of strings");
  number(input.confidence, "confidence");
  if (input.confidence > 1) fail("confidence must be <= 1");
  if (calibration.mode === "cold_start" && input.confidence > 0.5) fail("cold_start confidence must be <= 0.5");

  return input;
}

function main(argv) {
  const path = argv[2];
  if (!path) fail("usage: node validate-estimate.js <estimate.json>");
  const input = JSON.parse(fs.readFileSync(path, "utf8"));
  validateEstimate(input);
  process.stdout.write("valid\n");
}

if (require.main === module) {
  try {
    main(process.argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = { validateEstimate };
