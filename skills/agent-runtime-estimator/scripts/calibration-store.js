"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const VERSION = 1;
const FIELDS = ["model", "reasoning", "task_class", "execution_mode", "tool_profile"];
const DEFAULT_ROOT = process.env.AGENT_RUNTIME_ESTIMATOR_HOME ? path.resolve(process.env.AGENT_RUNTIME_ESTIMATOR_HOME) : path.join(os.homedir(), ".agent-runtime-estimator");
function nonNegative(value, name) { const n = Number(value); if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a finite non-negative number`); return n; }
function part(value) { return String(value || "unknown").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-") || "unknown"; }
function profile(input) { return Object.fromEntries(FIELDS.map((field) => [field, part(input[field])])); }
function profileKey(input) { const p = profile(input); return FIELDS.map((field) => p[field]).join("|"); }
function percentile(sorted, q) { return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)] : null; }
function ensureRoot(root) { fs.mkdirSync(root, { recursive: true }); }
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (error) { if (error && error.code === "ENOENT") return fallback; throw error; } }
function appendObservation(observation, root = DEFAULT_ROOT) {
  const units = nonNegative(observation.critical_path_units, "critical_path_units"); if (units <= 0) throw new Error("critical_path_units must be > 0");
  const record = { version: VERSION, recorded_at: observation.recorded_at || new Date().toISOString(), profile: profile(observation), profile_key: profileKey(observation), critical_path_units: units, actual_elapsed_minutes: nonNegative(observation.actual_elapsed_minutes, "actual_elapsed_minutes"), actual_agent_active_minutes: observation.actual_agent_active_minutes == null ? null : nonNegative(observation.actual_agent_active_minutes, "actual_agent_active_minutes") };
  ensureRoot(root); fs.appendFileSync(path.join(root, "history.jsonl"), `${JSON.stringify(record)}\n`, "utf8"); return record;
}
function readObservations(root = DEFAULT_ROOT) { try { return fs.readFileSync(path.join(root, "history.jsonl"), "utf8").split(/\r?\n/u).filter(Boolean).map(JSON.parse).filter((item) => item && item.version === VERSION && item.profile_key && item.critical_path_units > 0); } catch (error) { if (error && error.code === "ENOENT") return []; throw error; } }
function summarize(observations) {
  const groups = new Map(); for (const item of observations) { const items = groups.get(item.profile_key) || []; items.push(item); groups.set(item.profile_key, items); }
  const profiles = {}; for (const [key, items] of groups) { const elapsed = items.map((item) => item.actual_elapsed_minutes / item.critical_path_units).sort((a, b) => a - b); const active = items.filter((item) => item.actual_agent_active_minutes != null).map((item) => item.actual_agent_active_minutes / item.critical_path_units).sort((a, b) => a - b); profiles[key] = { profile: items[0].profile, sample_count: elapsed.length, elapsed_minutes_per_critical_unit: { p50: percentile(elapsed, 0.5), p80: percentile(elapsed, 0.8) }, active_minutes_per_critical_unit: active.length ? { p50: percentile(active, 0.5), p80: percentile(active, 0.8), sample_count: active.length } : null }; }
  return { version: VERSION, generated_at: new Date().toISOString(), profiles };
}
function compact(root = DEFAULT_ROOT) { ensureRoot(root); const result = summarize(readObservations(root)); const target = path.join(root, "calibration.json"); const temp = `${target}.tmp`; fs.writeFileSync(temp, `${JSON.stringify(result, null, 2)}\n`, "utf8"); fs.renameSync(temp, target); return result; }
function loadCalibration(root = DEFAULT_ROOT) { return readJson(path.join(root, "calibration.json"), { version: VERSION, generated_at: null, profiles: {} }); }
function selectCalibration(requestedInput, calibration = loadCalibration()) {
  const requested = profile(requestedInput); const entries = Object.entries(calibration.profiles || {});
  // Never cross a known model or reasoning boundary. Fallback only relaxes tool/execution specificity.
  const levels = [FIELDS, ["model", "reasoning", "task_class", "execution_mode"], ["model", "reasoning", "task_class"]];
  for (const fields of levels) {
    const matches = entries.filter(([, entry]) => fields.every((field) => requested[field] === "unknown" || part(entry.profile?.[field]) === requested[field])); if (!matches.length) continue;
    if (fields.length === FIELDS.length && matches.length === 1) return { profile_key: matches[0][0], fallback_level: "exact", ...matches[0][1] };
    const total = matches.reduce((sum, [, entry]) => sum + Number(entry.sample_count || 0), 0); if (!total) continue;
    const weighted = (section, percentileName) => matches.reduce((sum, [, entry]) => sum + Number(entry[section]?.[percentileName] || 0) * Number(entry.sample_count || 0), 0) / total;
    return { profile_key: `${fields.map((field) => requested[field]).join("|")}|*`, fallback_level: fields.join("+"), sample_count: total, elapsed_minutes_per_critical_unit: { p50: weighted("elapsed_minutes_per_critical_unit", "p50"), p80: weighted("elapsed_minutes_per_critical_unit", "p80") }, active_minutes_per_critical_unit: null };
  }
  return null;
}
function flags(args) { const out = {}; for (let i = 0; i < args.length; i += 1) { if (!args[i].startsWith("--")) continue; const key = args[i].slice(2).replace(/-/g, "_"); const value = args[i + 1]; if (value == null || value.startsWith("--")) out[key] = true; else { out[key] = value; i += 1; } } return out; }
function main(argv) { const command = argv[2]; const f = flags(argv.slice(3)); const root = f.home ? path.resolve(String(f.home)) : DEFAULT_ROOT; if (command === "record") { process.stdout.write(`${JSON.stringify(appendObservation({ model: f.model, reasoning: f.reasoning, task_class: f.task_class, execution_mode: f.execution_mode, tool_profile: f.tool_profile, critical_path_units: f.units, actual_elapsed_minutes: f.elapsed, actual_agent_active_minutes: f.active }, root))}\n`); return; } if (command === "compact") { process.stdout.write(`${JSON.stringify({ profiles: Object.keys(compact(root).profiles).length })}\n`); return; } if (command === "lookup") { process.stdout.write(`${JSON.stringify(selectCalibration({ model: f.model, reasoning: f.reasoning, task_class: f.task_class, execution_mode: f.execution_mode, tool_profile: f.tool_profile }, loadCalibration(root)))}\n`); return; } throw new Error("usage: calibration-store.js <record|compact|lookup> [--flags]"); }
if (require.main === module) { try { main(process.argv); } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; } }
module.exports = { appendObservation, readObservations, summarize, compact, loadCalibration, selectCalibration, profileKey };
