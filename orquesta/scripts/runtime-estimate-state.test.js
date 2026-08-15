"use strict";

const assert = require("node:assert/strict");
const {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createProfiledExecutionPlan } = require("../../packages/core/src/profiled-execution-plan");
const { createRuntimeEstimate } = require("../../packages/core/src/runtime-estimator");
const { createTaskIntent } = require("../../packages/core/src/task-intent");
const {
  applyRuntimeEstimates,
  parseArguments,
  updateTasksDocument,
} = require("./runtime-estimate-state");

const roots = [];
test.afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function taskFixture(taskId = "TASK-001") {
  const taskIntent = createTaskIntent({
    rawRequestRef: `test:${taskId}`,
    desiredOutcome: "Implement and verify a bounded runtime-estimate slice.",
    acceptanceCriteria: ["The bounded slice passes deterministic checks."],
    constraints: ["Keep changes inside the approved workspace."],
    risk: { impact: "low", reversible: true },
    authorityBoundary: { agent_may: ["edit approved files"], user_only: ["authorize external actions"] },
    assumptions: [],
    status: "compiled",
  });
  const profiled = createProfiledExecutionPlan({
    taskIntent,
    workItem: {
      scope_boundaries: ["packages/core"],
      effects: ["workspace_write"],
      verification_method: "deterministic",
      work_mode: "implementation",
    },
  });
  return {
    task_id: taskId,
    title: "Runtime estimate test",
    state: "queued",
    task_intent: taskIntent,
    task_profile: profiled.task_profile,
    execution_plan: profiled.execution_plan,
  };
}

function stateRoot(tasks) {
  const root = mkdtempSync(path.join(os.tmpdir(), "orquesta-runtime-estimate-state-"));
  roots.push(root);
  const directory = path.join(root, ".orquesta", "state");
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "tasks.json"), `${JSON.stringify({ version: 1, tasks }, null, 2)}\n`, "utf8");
  return root;
}

test("writes a cold-start estimate into canonical task state", () => {
  const root = stateRoot([taskFixture(), { task_id: "LEGACY", state: "queued" }]);
  const result = applyRuntimeEstimates({ rootPath: root, now: () => "2026-08-15T12:00:00.000Z" });
  const state = JSON.parse(readFileSync(path.join(root, ".orquesta", "state", "tasks.json"), "utf8"));

  assert.deepEqual(result.estimated_task_ids, ["TASK-001"]);
  assert.deepEqual(result.skipped_task_ids, ["LEGACY"]);
  assert.equal(state.tasks[0].runtime_estimate.source, "profile_inferred");
  assert.equal(state.tasks[0].runtime_estimate.calibration.mode, "cold_start");
  assert.equal(state.tasks[0].runtime_estimate_updated_at, "2026-08-15T12:00:00.000Z");
  assert.equal(state.tasks[1].runtime_estimate, undefined);
});

test("preserves an agent-decomposed estimate even during refresh", () => {
  const task = taskFixture();
  task.runtime_estimate = createRuntimeEstimate({
    taskIntent: task.task_intent,
    taskProfile: task.task_profile,
    executionPlan: task.execution_plan,
    estimateInput: {
      version: 1,
      scope: { task: "Bounded task", done_signal: "Checks pass", environment: "codex|repo" },
      work: {
        critical_path_units_p50: 2,
        critical_path_units_p80: 4,
        total_units_p50: 3,
        total_units_p80: 6,
        parallel_branches: 2,
        unit_breakdown: [
          { kind: "inspect", p50: 1, p80: 2, note: "" },
          { kind: "change", p50: 1, p80: 2, note: "" },
          { kind: "verify", p50: 1, p80: 2, note: "" },
        ],
      },
      runtime: {
        agent_active_minutes: { p50: 4, p80: 16 },
        elapsed_minutes: { p50: 5, p80: 18 },
        human_intervention_minutes: { p50: 0, p80: 2 },
      },
      calibration: {
        mode: "cold_start",
        profile_key: "codex|repo",
        sample_count: 0,
        active_minutes_per_critical_unit: { p50: 2, p80: 4 },
      },
      external_gates: [],
      uncertainty_drivers: ["test_latency"],
      confidence: 0.4,
    },
  });
  const before = JSON.stringify(task.runtime_estimate);
  const result = updateTasksDocument({ version: 1, tasks: [task] }, { refresh: true });

  assert.deepEqual(result.summary.preserved_task_ids, ["TASK-001"]);
  assert.equal(JSON.stringify(result.document.tasks[0].runtime_estimate), before);
});

test("refreshes profile-inferred estimates from comparable observations", () => {
  const first = updateTasksDocument(
    { version: 1, tasks: [taskFixture()] },
    { now: () => "2026-08-15T12:00:00.000Z" },
  );
  const task = first.document.tasks[0];
  const profileKey = task.runtime_estimate.calibration.profile_key;
  task.runtime_observations = [1, 2, 3, 4, 5].map((ratio) => ({
    profile_key: profileKey,
    critical_path_units: 2,
    actual_agent_active_minutes: ratio * 2,
  }));

  const refreshed = updateTasksDocument(
    { version: 1, tasks: [task] },
    { refresh: true, now: () => "2026-08-15T13:00:00.000Z" },
  );
  const estimate = refreshed.document.tasks[0].runtime_estimate;

  assert.deepEqual(refreshed.summary.refreshed_task_ids, ["TASK-001"]);
  assert.equal(estimate.calibration.mode, "historical");
  assert.equal(estimate.calibration.sample_count, 5);
  assert.equal(estimate.runtime_estimate_updated_at, undefined);
  assert.equal(refreshed.document.tasks[0].runtime_estimate_updated_at, "2026-08-15T13:00:00.000Z");
});

test("fails closed when an explicitly targeted task lacks estimate inputs", () => {
  assert.throws(
    () => updateTasksDocument({ version: 1, tasks: [{ task_id: "LEGACY" }] }, { taskId: "LEGACY" }),
    /lacks runtime-estimate inputs/,
  );
});

test("parses a bounded refresh command", () => {
  const parsed = parseArguments(["--root", ".", "--task-id", "TASK-001", "--refresh"]);
  assert.equal(parsed.rootPath, path.resolve("."));
  assert.equal(parsed.taskId, "TASK-001");
  assert.equal(parsed.refresh, true);
});
