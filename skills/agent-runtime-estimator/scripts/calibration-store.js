"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const VERSION = 1;
const DEFAULT_ROOT = process.env.AGENT_RUNTIME_ESTIMATOR_HOME
  ? path.resolve(process.env.AGENT_RUNTIME_ESTIMATOR_HOME)
  : path.join(os.homedir(), ".agent-runtime-estimator");

function finiteNonNegative(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${name} must be a finite non-negative number`);
  return number;
}

function profilePart(value) {
  return String(value || "unknown").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-") || "unknown";
}

function profileKey(input) {
  return [input.model, input.reasoning, input.task_class, input.execution_mode, input.tool_profile]
    .map(profilePart)
    .join("|");
}

function percentile(sorted, q) {
  if (!sorted.length) return null;
  const index = Math.max(0, Math.ceil(sorted.length * q) - 1);
  return sorted[index];
}

function ensureRoot(root) {
  fs.mkdirSync(root, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") return fallback;
    throw error;
  }
}

function appendObservation(observation, root = DEFAULT_ROOT) {
  const units = finiteNonNegative(observation.critical_path_units, "critical_path_units");
  if (units <= 0) throw new Error("critical_path_units must be > 0");
  const elapsed = finiteNonNegative(observation.actual_elapsed_minutes, "actual_elapsed_minutes");
  const active = observation.actual_agent_active_minutes == null
    ? null
    : finiteNonNegative(observation.actual_agent_active_minutes, "actual_agent_active_minutes");
  const record = {
    version: VERSION,
    recorded_at: observation.recorded_at || new Date().toISOString(),
    profile: {
      model: profilePart(observation.model),
      reasoning: profilePart(observation.reasoning),
      task_class: profilePart(observation.task_class),
      execution_mode: profilePart(observation.execution_mode),
      tool_profile: profilePart(observation.tool_profile)
    },
    profile_key: profileKey(observation),
    critical_path_units: units,
    actual_elapsed_minutes: elapsed,
    actual_agent_active_minutes: active
  };
  ensureRoot(root);
  fs.appendFileSync(path.join(root, "history.jsonl"), `${JSON.stringify(record)}\n`, "utf8");
  return record;
}

function readObservations(root = DEFAULT_ROOT) {
  const file = path.join(root, "history.jsonl");
  try {
    return fs.readFileSync(file, "utf8")
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((item) => item && item.version === VERSION && item.profile_key && item.critical_path_units > 0);
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
}

function summarize(observations) {
  const groups = new Map();
  for (const item of observations) {
    const group = groups.get(item.profile_key) || { profile: item.profile, elapsed: [], active: [] };
    group.elapsed.push(item.actual_elapsed_minutes / item.critical_path_units);
    if (item.actual_agent_active_minutes != null) group.active.push(item.actual_agent_active_minutes / item.critical_path_units);
    groups.set(item.profile_key, group);
  }
  const profiles = {};
  for (const [key, group] of groups) {
    group.elapsed.sort((a, b) => a - b);
    group.active.sort((a, b) => a - b);
    profiles[key] = {
      profile: group.profile,
      sample_count: group.elapsed.length,
      elapsed_minutes_per_critical_unit: {
        p50: percentile(group.elapsed, 0.5),
        p80: percentile(group.elapsed, 0.8)
      },
      active_minutes_per_critical_unit: group.active.length ? {
        p50: percentile(group.active, 0.5),
        p80: percentile(group.active, 0.8),
        sample_count: group.active.length
      } : null
    };
  }
  return { version: VERSION, generated_at: new Date().toISOString(), profiles };
}

function compact(root = DEFAULT_ROOT) {
  ensureRoot(root);
  const calibration = summarize(readObservations(root));
  const target = path.join(root, "calibration.json");
  const temp = `${target}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(calibration, null, 2)}\n`, "utf8");
  fs.renameSync(temp, target);
  return calibration;
}

function loadCalibration(root = DEFAULT_ROOT) {
  return readJson(path.join(root, "calibration.json"), { version: VERSION, generated_at: null, profiles: {} });
}

function specificity(candidate, requested) {
  const fields = ["model", "reasoning", "task_class", "execution_mode", "tool_profile"];
  let score = 0;
  for (const field of fields) {
    const wanted = profilePart(requested[field]);
    const actual = profilePart(candidate[field]);
    if (wanted !== "unknown" && actual !== wanted) return -1;
    if (wanted !== "unknown" && actual === wanted) score += 1;
  }
  return score;
}

function selectCalibration(requested, calibration = loadCalibration()) {
  let best = null;
  for (const [key, entry] of Object.entries(calibration.profiles || {})) {
    const score = specificity(entry.profile || {}, requested);
    if (score < 0) continue;
    const rank = [score, Number(entry.sample_count || 0)];
    if (!best || rank[0] > best.rank[0] || (rank[0] === best.rank[0] && rank[1] > best.rank[1])) {
      best = { key, entry, rank };
    }
  }
  return best ? { profile_key: best.key, ...best.entry } : null;
}

function parseFlags(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2).replace(/-/g, "_");
    const value = args[index + 1];
    if (value == null || value.startsWith("--")) result[key] = true;
    else { result[key] = value; index += 1; }
  }
  return result;
}

function main(argv) {
  const command = argv[2];
  const flags = parseFlags(argv.slice(3));
  const root = flags.home ? path.resolve(String(flags.home)) : DEFAULT_ROOT;
  if (command === "record") {
    const record = appendObservation({
      model: flags.model,
      reasoning: flags.reasoning,
      task_class: flags.task_class,
      execution_mode: flags.execution_mode,
      tool_profile: flags.tool_profile,
      critical_path_units: flags.units,
      actual_elapsed_minutes: flags.elapsed,
      actual_agent_active_minutes: flags.active
    }, root);
    process.stdout.write(`${JSON.stringify(record)}\n`);
    return;
  }
  if (command === "compact") {
    const result = compact(root);
    process.stdout.write(`${JSON.stringify({ profiles: Object.keys(result.profiles).length })}\n`);
    return;
  }
  if (command === "lookup") {
    const result = selectCalibration({
      model: flags.model,
      reasoning: flags.reasoning,
      task_class: flags.task_class,
      execution_mode: flags.execution_mode,
      tool_profile: flags.tool_profile
    }, loadCalibration(root));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  throw new Error("usage: calibration-store.js <record|compact|lookup> [--flags]");
}

if (require.main === module) {
  try { main(process.argv); }
  catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = { appendObservation, readObservations, summarize, compact, loadCalibration, selectCalibration, profileKey };
