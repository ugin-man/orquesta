import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readOrquestaStateEvidence } from "../scripts/lib/orquesta-state-evidence.mjs";

async function writeJson(root, relative, value) {
  const target = path.join(root, ".orquesta", "state", relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("accepts foundation and specialist threads that match canonical state", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orquesta-state-evidence-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeJson(root, "agents.json", {
    agents: [
      { agent_id: "orchestrator", thread_id: "thread-orchestrator" },
      { agent_id: "orquesta-admin", thread_id: "thread-admin" },
      { agent_id: "user-support", thread_id: "thread-support" },
      { agent_id: "implementation-001", thread_id: "thread-implementation" }
    ]
  });
  await writeJson(root, "sessions.json", {
    sessions: [
      { agent_id: "orchestrator", thread_id: "thread-orchestrator", handoff_turn_id: "turn-o" },
      { agent_id: "orquesta-admin", thread_id: "thread-admin", handoff_turn_id: "turn-a" },
      { agent_id: "user-support", thread_id: "thread-support", handoff_turn_id: "turn-u" },
      { agent_id: "implementation-001", thread_id: "thread-implementation", handoff_turn_id: "turn-i" }
    ]
  });
  await writeJson(root, "tasks.json", {
    tasks: [{
      task_id: "TASK-1",
      owner_agent_id: "implementation-001",
      routing_class: "specialist_required",
      handoff_required: true,
      handoff_sent_at: "2026-07-30T00:00:00.000Z",
      specialist_report_required: true,
      specialist_report_path: ".orquesta/reports/TASK-1-implementation-001.md",
      state: "completed"
    }]
  });
  await fs.mkdir(path.join(root, ".orquesta", "reports"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".orquesta", "reports", "TASK-1-implementation-001.md"),
    "complete\n",
    "utf8"
  );

  const evidence = await readOrquestaStateEvidence({
    workspaceRoot: root,
    observedThreadIds: [
      "thread-orchestrator",
      "thread-admin",
      "thread-support",
      "thread-implementation"
    ]
  });
  assert.equal(evidence.valid, true);
  assert.equal(evidence.foundation_threads, 3);
  assert.equal(evidence.specialist_threads, 1);
  assert.deepEqual(evidence.errors, []);
});

test("rejects invented sessions, missing reports, and incomplete handoffs", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orquesta-state-invalid-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeJson(root, "agents.json", {
    agents: [
      { agent_id: "orchestrator", thread_id: "thread-invented" },
      { agent_id: "orquesta-admin", thread_id: "thread-admin" },
      { agent_id: "user-support", thread_id: "thread-support" },
      { agent_id: "implementation-001", thread_id: "thread-specialist" }
    ]
  });
  await writeJson(root, "sessions.json", {
    sessions: [
      { agent_id: "orchestrator", thread_id: "thread-invented", handoff_turn_id: null },
      { agent_id: "orquesta-admin", thread_id: "thread-admin", handoff_turn_id: "turn-a" },
      { agent_id: "user-support", thread_id: "thread-support", handoff_turn_id: "turn-u" },
      { agent_id: "implementation-001", thread_id: "thread-specialist", handoff_turn_id: null }
    ]
  });
  await writeJson(root, "tasks.json", {
    tasks: [{
      task_id: "TASK-1",
      owner_agent_id: "implementation-001",
      routing_class: "specialist_required",
      handoff_required: true,
      handoff_sent_at: null,
      specialist_report_required: true,
      specialist_report_path: ".orquesta/reports/missing.md",
      state: "working"
    }]
  });

  const evidence = await readOrquestaStateEvidence({
    workspaceRoot: root,
    observedThreadIds: ["thread-admin", "thread-support", "thread-specialist"]
  });
  assert.equal(evidence.valid, false);
  assert.match(evidence.errors.join("\n"), /observed App Server thread/i);
  assert.match(evidence.errors.join("\n"), /handoff/i);
  assert.match(evidence.errors.join("\n"), /report/i);
});

test("accepts zero specialists when canonical routing chose inline work", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orquesta-state-inline-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const foundation = ["orchestrator", "orquesta-admin", "user-support"];
  await writeJson(root, "agents.json", {
    agents: foundation.map((agentId) => ({
      agent_id: agentId,
      thread_id: `thread-${agentId}`
    }))
  });
  await writeJson(root, "sessions.json", {
    sessions: foundation.map((agentId) => ({
      agent_id: agentId,
      thread_id: `thread-${agentId}`,
      handoff_turn_id: `turn-${agentId}`
    }))
  });
  await writeJson(root, "tasks.json", {
    tasks: [{
      task_id: "TASK-INLINE",
      owner_agent_id: "orchestrator",
      routing_class: "inline_verified",
      handoff_required: false,
      specialist_report_required: false,
      state: "completed"
    }]
  });

  const evidence = await readOrquestaStateEvidence({
    workspaceRoot: root,
    observedThreadIds: foundation.map((agentId) => `thread-${agentId}`)
  });
  assert.equal(evidence.valid, true);
  assert.equal(evidence.specialist_threads, 0);
});
