"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { appendObservation, readObservations, summarize, compact, loadCalibration, selectCalibration, profileKey } = require("./calibration-store");
function tempRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), "agent-runtime-estimator-")); }

test("records observations outside the skill package and compacts them", () => {
  const root = tempRoot(); try {
    appendObservation({ model: "gpt-5.6-sol", reasoning: "high", task_class: "coding", execution_mode: "codex", tool_profile: "local-tests", critical_path_units: 4, actual_elapsed_minutes: 8, actual_agent_active_minutes: 6 }, root);
    appendObservation({ model: "gpt-5.6-sol", reasoning: "high", task_class: "coding", execution_mode: "codex", tool_profile: "local-tests", critical_path_units: 4, actual_elapsed_minutes: 12, actual_agent_active_minutes: 8 }, root);
    const result = compact(root); const key = profileKey({ model: "gpt-5.6-sol", reasoning: "high", task_class: "coding", execution_mode: "codex", tool_profile: "local-tests" });
    assert.equal(result.profiles[key].sample_count, 2); assert.deepEqual(result.profiles[key].elapsed_minutes_per_critical_unit, { p50: 2, p80: 3 }); assert.deepEqual(result.profiles[key].active_minutes_per_critical_unit, { p50: 1.5, p80: 2, sample_count: 2 }); assert.equal(readObservations(root).length, 2); assert.equal(loadCalibration(root).profiles[key].sample_count, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("exact lookup does not mix known models", () => {
  const calibration = summarize([
    { version: 1, profile_key: "sol", profile: { model: "gpt-5.6-sol", reasoning: "high", task_class: "coding", execution_mode: "codex", tool_profile: "local-tests" }, critical_path_units: 2, actual_elapsed_minutes: 4, actual_agent_active_minutes: 3 },
    { version: 1, profile_key: "terra", profile: { model: "gpt-5.6-terra", reasoning: "high", task_class: "coding", execution_mode: "codex", tool_profile: "local-tests" }, critical_path_units: 2, actual_elapsed_minutes: 20, actual_agent_active_minutes: 18 }
  ]);
  const selected = selectCalibration({ model: "gpt-5.6-sol", reasoning: "high", task_class: "coding", execution_mode: "codex", tool_profile: "local-tests" }, calibration);
  assert.equal(selected.profile_key, "sol"); assert.equal(selected.fallback_level, "exact"); assert.equal(selected.elapsed_minutes_per_critical_unit.p50, 2);
});

test("falls back across tool profiles without crossing model or reasoning", () => {
  const calibration = summarize([
    { version: 1, profile_key: "a", profile: { model: "gpt-5.6-sol", reasoning: "high", task_class: "coding", execution_mode: "codex", tool_profile: "fast-tests" }, critical_path_units: 2, actual_elapsed_minutes: 4, actual_agent_active_minutes: null },
    { version: 1, profile_key: "b", profile: { model: "gpt-5.6-sol", reasoning: "high", task_class: "coding", execution_mode: "codex", tool_profile: "slow-tests" }, critical_path_units: 2, actual_elapsed_minutes: 8, actual_agent_active_minutes: null },
    { version: 1, profile_key: "c", profile: { model: "gpt-5.6-sol", reasoning: "low", task_class: "coding", execution_mode: "codex", tool_profile: "other" }, critical_path_units: 2, actual_elapsed_minutes: 40, actual_agent_active_minutes: null },
    { version: 1, profile_key: "d", profile: { model: "gpt-5.6-terra", reasoning: "high", task_class: "coding", execution_mode: "codex", tool_profile: "other" }, critical_path_units: 2, actual_elapsed_minutes: 40, actual_agent_active_minutes: null }
  ]);
  const selected = selectCalibration({ model: "gpt-5.6-sol", reasoning: "high", task_class: "coding", execution_mode: "codex", tool_profile: "unknown-tool" }, calibration);
  assert.equal(selected.fallback_level, "model+reasoning+task_class+execution_mode"); assert.equal(selected.sample_count, 2); assert.equal(selected.elapsed_minutes_per_critical_unit.p50, 3);
});

test("missing active time still calibrates elapsed time", () => {
  const result = summarize([{ version: 1, profile_key: "profile", profile: { model: "model", reasoning: "medium", task_class: "research", execution_mode: "interactive", tool_profile: "web" }, critical_path_units: 5, actual_elapsed_minutes: 15, actual_agent_active_minutes: null }]);
  assert.equal(result.profiles.profile.elapsed_minutes_per_critical_unit.p50, 3); assert.equal(result.profiles.profile.active_minutes_per_critical_unit, null);
});
