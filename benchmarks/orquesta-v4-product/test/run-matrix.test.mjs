import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildEnvironmentObservation,
  collectThreadIds,
  executeMatrixPlan,
} from "../scripts/run-matrix.mjs";

test("audits the Orquesta base profile while preserving routed model evidence", () => {
  const observed = buildEnvironmentObservation({
    mode: "orquesta",
    profile: {
      multi_agent: true,
      execution: {
        model: "gpt-5.6-sol",
        reasoning_effort: "high",
        sandbox: "workspace-write",
        approval_policy: "never",
      },
    },
    outcome: { final: { actual_model: "gpt-5.6-terra" } },
    runtimeSnapshotHash: "snapshot-hash",
  });

  assert.equal(observed.model, "gpt-5.6-sol");
  assert.equal(observed.multi_agent, true);
});

test("collects direct execution threads for token accounting", () => {
  assert.deepEqual(collectThreadIds({
    bootstrap_metrics: { thread_ids: ["foundation-1"] },
    main_metrics: {
      orchestrator_thread_id: "foundation-1",
      direct_thread_ids: ["direct-1"],
      specialist_thread_ids: [],
    },
  }), ["foundation-1", "direct-1"]);
});

test("does not start any condition when preflight is invalid", async () => {
  let calls = 0;
  await assert.rejects(executeMatrixPlan({
    matrixId: "matrix-invalid",
    storageRoot: "unused",
    preflight: { valid: false, errors: ["sandbox mismatch"] },
    async runMode() {
      calls += 1;
    }
  }), /preflight/i);
  assert.equal(calls, 0);
});

test("runs plain, skills, and orquesta once with distinct run ids", async (t) => {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "orquesta-matrix-plan-"));
  t.after(() => fs.rm(storageRoot, { recursive: true, force: true }));
  const calls = [];
  const result = await executeMatrixPlan({
    matrixId: "matrix-20260730",
    storageRoot,
    preflight: { valid: true, errors: [] },
    taskId: "parallel-integration",
    async runMode(input) {
      calls.push(input);
      const runDir = path.join(storageRoot, "runs", input.runId);
      await fs.mkdir(runDir, { recursive: true });
      await fs.writeFile(
        path.join(runDir, "result.json"),
        `${JSON.stringify({ mode: input.mode, run_id: input.runId })}\n`,
        "utf8"
      );
      return { mode: input.mode, run_id: input.runId, status: "finalized" };
    }
  });

  assert.deepEqual(calls.map(({ mode }) => mode), ["plain", "skills", "orquesta"]);
  assert.deepEqual(calls.map(({ taskId }) => taskId), [
    "parallel-integration",
    "parallel-integration",
    "parallel-integration"
  ]);
  assert.equal(new Set(calls.map(({ runId }) => runId)).size, 3);
  assert.equal(result.results.length, 3);
  assert.equal(result.task_id, "parallel-integration");
});

test("can run one selected condition for an out-of-sample task", async (t) => {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "orquesta-matrix-one-"));
  t.after(() => fs.rm(storageRoot, { recursive: true, force: true }));
  const calls = [];
  const result = await executeMatrixPlan({
    matrixId: "matrix-triage",
    storageRoot,
    preflight: { valid: true, errors: [] },
    taskId: "conflicting-requirements-triage",
    modes: ["orquesta"],
    async runMode(input) {
      calls.push(input);
      return { mode: input.mode, run_id: input.runId, status: "finalized" };
    }
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].mode, "orquesta");
  assert.equal(calls[0].taskId, "conflicting-requirements-triage");
  assert.equal(result.results.length, 1);
});

test("refuses to overwrite an existing run directory", async (t) => {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "orquesta-matrix-existing-"));
  t.after(() => fs.rm(storageRoot, { recursive: true, force: true }));
  await fs.mkdir(
    path.join(storageRoot, "runs", "matrix-existing-plain"),
    { recursive: true }
  );
  let calls = 0;
  await assert.rejects(executeMatrixPlan({
    matrixId: "matrix-existing",
    storageRoot,
    preflight: { valid: true, errors: [] },
    async runMode() {
      calls += 1;
    }
  }), /already exists/i);
  assert.equal(calls, 0);
});
