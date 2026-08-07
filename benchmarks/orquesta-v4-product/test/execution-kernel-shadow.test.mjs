import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createExecutionKernelBenchmarkShadow,
  createExecutionKernelSpecialistScheduler,
} from "../scripts/lib/execution-kernel-shadow.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

async function fixture(t, tasks) {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "orquesta-kernel-shadow-"));
  t.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(workspaceRoot, ".orquesta", "state"), { recursive: true });
  await fs.writeFile(
    path.join(workspaceRoot, ".orquesta", "state", "tasks.json"),
    `${JSON.stringify({ version: 1, tasks }, null, 2)}\n`,
    "utf8",
  );
  return workspaceRoot;
}

test("records real specialist identities without starting an extra Codex turn", async (t) => {
  const workspaceRoot = await fixture(t, [
    { task_id: "土台", state: "accepted", dependencies: [] },
    { task_id: "未知の仕事", state: "queued", dependencies: ["土台"] },
  ]);
  const shadow = createExecutionKernelBenchmarkShadow({
    runtimeRoot: repositoryRoot,
    workspaceRoot,
    now: () => new Date("2026-07-31T00:00:00.000Z"),
  });
  const [ticket] = await shadow.beginBatch({
    requests: [{ task_id: "未知の仕事", agent_id: "implementation-001" }],
  });
  shadow.recordResult(ticket, {
    status: "completed",
    thread_id: "thread-real",
    turn_id: "turn-real",
  });
  const evidence = shadow.snapshot();

  assert.equal(evidence.additional_codex_turns, 0);
  assert.deepEqual(evidence.observations[0], {
    ...evidence.observations[0],
    scenario: "unknown_task",
    predicted_action: "dispatch",
    expected_action: "dispatch",
    actual_action: "dispatch_accepted",
    actual_thread_id: "thread-real",
    actual_turn_id: "turn-real",
    runtime_status: "completed",
    additional_codex_turns: 0,
  });
});

test("detects dependency, capacity, and duplicate structure without task keywords", async (t) => {
  const workspaceRoot = await fixture(t, [
    { task_id: "先", state: "queued", dependencies: [] },
    { task_id: "後", state: "queued", dependencies: ["先"] },
    { task_id: "α", state: "queued", dependencies: [] },
    { task_id: "β", state: "queued", dependencies: [] },
    { task_id: "γ", state: "queued", dependencies: [] },
  ]);
  const shadow = createExecutionKernelBenchmarkShadow({
    runtimeRoot: repositoryRoot,
    workspaceRoot,
    maxConcurrent: 2,
    now: () => new Date("2026-07-31T00:00:00.000Z"),
  });
  await shadow.beginBatch({
    requests: [
      { task_id: "後", agent_id: "a" },
      { task_id: "α", agent_id: "b" },
      { task_id: "β", agent_id: "c" },
      { task_id: "γ", agent_id: "d" },
      { task_id: "α", agent_id: "e" },
    ],
  });
  const observations = shadow.snapshot().observations;

  assert.deepEqual(
    observations.map((item) => item.expected_action),
    [
      "wait_for_dependency",
      "dispatch",
      "dispatch",
      "wait_for_capacity",
      "suppress_duplicate",
    ],
  );
  assert.deepEqual(
    observations.map((item) => item.predicted_action),
    observations.map((item) => item.expected_action),
  );
});

test("active benchmark scheduler releases dependencies and never exceeds capacity", async (t) => {
  const workspaceRoot = await fixture(t, [
    { task_id: "先行", state: "queued", dependencies: [], priority: 1 },
    { task_id: "後続", state: "queued", dependencies: ["先行"], priority: 1 },
    { task_id: "独立", state: "queued", dependencies: [], priority: 2 },
  ]);
  const scheduler = createExecutionKernelSpecialistScheduler({
    runtimeRoot: repositoryRoot,
    workspaceRoot,
    maxConcurrent: 2,
    now: () => new Date("2026-07-31T00:00:00.000Z"),
  });
  let active = 0;
  let maximum = 0;
  const order = [];
  const requests = [
    { task_id: "後続", agent_id: "after" },
    { task_id: "独立", agent_id: "parallel" },
    { task_id: "先行", agent_id: "before" },
  ];
  const results = await scheduler.run({
    requests,
    async start(request) {
      active += 1;
      maximum = Math.max(maximum, active);
      order.push(request.task_id);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return {
        status: "completed",
        thread_id: `thread-${request.task_id}`,
        turn_id: `turn-${request.task_id}`,
      };
    },
  });

  assert.equal(maximum, 2);
  assert.equal(order.indexOf("後続") > order.indexOf("先行"), true);
  assert.deepEqual(results.map((result) => result.status), [
    "completed",
    "completed",
    "completed",
  ]);
});
