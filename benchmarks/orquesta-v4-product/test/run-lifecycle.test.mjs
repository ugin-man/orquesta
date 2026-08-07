import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  finalizeRun,
  rebaselineRunMeasurement,
  recordUserIntervention,
  startRun
} from "../scripts/lib/lifecycle.mjs";
import { benchmarkRoot } from "../scripts/lib/paths.mjs";

async function roots(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orquesta-lifecycle-v2-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sessionsRoot = path.join(root, "sessions");
  await fs.mkdir(sessionsRoot);
  return { storageRoot: root, sessionsRoot };
}

async function createWorkspace({ destination }) {
  await fs.mkdir(destination, { recursive: true });
  await fs.writeFile(path.join(destination, "input.txt"), "fixture\n", "utf8");
  return { task_id: "organization-json-generator", workspace_root: destination };
}

test("rejects legacy and unknown modes in a schema v2 run", async (t) => {
  const { storageRoot, sessionsRoot } = await roots(t);
  for (const mode of ["solo", "crowd"]) {
    await assert.rejects(startRun({
      benchmarkRoot,
      storageRoot,
      sessionsRoots: [{ label: "current", sessionsRoot }],
      taskId: "organization-json-generator",
      mode,
      matrixId: "matrix-1",
      createTaskWorkspaceImpl: createWorkspace
    }), /mode/i);
  }
});

test("uses the exact same task prompt in all three modes", async (t) => {
  const { storageRoot, sessionsRoot } = await roots(t);
  const prompts = [];
  for (const mode of ["plain", "skills", "orquesta"]) {
    const run = await startRun({
      benchmarkRoot,
      storageRoot,
      sessionsRoots: [{ label: mode, sessionsRoot }],
      taskId: "organization-json-generator",
      mode,
      matrixId: "matrix-prompts",
      runId: `run-${mode}`,
      instruction: "Create organization.json",
      createTaskWorkspaceImpl: createWorkspace
    });
    prompts.push(run.prompt);
  }
  assert.equal(new Set(prompts).size, 1);
  assert.equal(prompts[0], "Create organization.json");
});

test("rebaselines a running measurement after warmup", async (t) => {
  const { storageRoot, sessionsRoot } = await roots(t);
  const run = await startRun({
    benchmarkRoot,
    storageRoot,
    sessionsRoots: [{ label: "orquesta", sessionsRoot }],
    taskId: "organization-json-generator",
    mode: "orquesta",
    matrixId: "matrix-steady",
    runId: "run-steady",
    instruction: "Create organization.json",
    startedAt: "2026-07-30T00:00:00.000Z",
    createTaskWorkspaceImpl: createWorkspace,
  });

  const updated = await rebaselineRunMeasurement({
    storageRoot,
    runId: run.run_id,
    startedAt: "2026-07-30T00:02:00.000Z",
  });

  assert.equal(updated.started_at, "2026-07-30T00:02:00.000Z");
  assert.equal(updated.measurement_window.kind, "post_foundation_warmup");
  assert.equal(updated.measurement_window.original_started_at, "2026-07-30T00:00:00.000Z");
  assert.equal(updated.session_evidence_roots.length, 1);
});

test("finalizes schema v2 once and preserves execution outcome and intervention counts", async (t) => {
  const { storageRoot, sessionsRoot } = await roots(t);
  const run = await startRun({
    benchmarkRoot,
    storageRoot,
    sessionsRoots: [{ label: "plain", sessionsRoot }],
    taskId: "organization-json-generator",
    mode: "plain",
    matrixId: "matrix-finalize",
    runId: "run-finalize",
    instruction: "Create organization.json",
    startedAt: "2026-07-30T00:00:00.000Z",
    createTaskWorkspaceImpl: createWorkspace
  });
  await recordUserIntervention({
    storageRoot,
    runId: run.run_id,
    at: "2026-07-30T00:00:30.000Z",
    kind: "question_answered"
  });
  const result = await finalizeRun({
    benchmarkRoot,
    storageRoot,
    runId: run.run_id,
    endedAt: "2026-07-30T00:01:00.000Z",
    executionOutcome: {
      status: "completed",
      thread_ids: ["thread-1"],
      events: [{ type: "turn_completed" }]
    },
    verifyTaskImpl: async () => ({
      status: "passed",
      passed: true,
      duration_ms: 10,
      output: "ok"
    })
  });

  assert.equal(result.schema_version, 2);
  assert.equal(result.matrix_id, "matrix-finalize");
  assert.equal(result.mode, "plain");
  assert.equal(result.status, "finalized");
  assert.equal(result.verifier.passed, true);
  assert.equal(result.token_usage.coverage, "unknown");
  assert.equal(result.phase_token_usage, null);
  assert.equal(result.diagnostics.user_interventions, 1);
  assert.equal(result.diagnostics.participating_threads, 1);
  await assert.rejects(finalizeRun({
    benchmarkRoot,
    storageRoot,
    runId: run.run_id,
    executionOutcome: { status: "completed" },
    verifyTaskImpl: async () => ({})
  }), /already finalized/i);
});
