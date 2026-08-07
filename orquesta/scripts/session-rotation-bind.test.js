"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { bindHostedSessionSuccessor } = require("./session-rotation-bind");

function createRecovery() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-session-bind-"));
  const stateRoot = path.join(root, ".orquesta", "state");
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.writeFileSync(path.join(stateRoot, "session-rotation-recovery.json"), `${JSON.stringify({
    schema_version: 1,
    requests: [{
      request_id: "orchestrator:generation-2",
      agent_id: "orchestrator",
      expected_successor_generation: 2,
      target_project_root: root,
      status: "manual_recovery",
      reason: "codex_hosted_successor_thread_binding_required",
      successor_thread_id: null
    }]
  }, null, 2)}\n`, "utf8");
  return root;
}

test("binds a host-created thread to the exact pending generation", (t) => {
  const root = createRecovery();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = bindHostedSessionSuccessor({
    root,
    agentId: "orchestrator",
    successorThreadId: "thread-visible",
    expectedGeneration: 2,
    now: () => "2026-08-03T07:00:00.000Z"
  });

  assert.deepEqual(result, {
    status: "bound",
    agent_id: "orchestrator",
    successor_thread_id: "thread-visible",
    expected_successor_generation: 2,
    target_project_root: fs.realpathSync(root)
  });
  const state = JSON.parse(fs.readFileSync(
    path.join(root, ".orquesta", "state", "session-rotation-recovery.json"),
    "utf8"
  ));
  assert.equal(state.requests[0].status, "bound");
  assert.equal(state.requests[0].successor_thread_id, "thread-visible");
  assert.equal(state.requests[0].bound_by, "codex_hosted_thread_tool");
});

test("rejects stale generations and conflicting successor bindings", (t) => {
  const root = createRecovery();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.throws(() => bindHostedSessionSuccessor({
    root,
    agentId: "orchestrator",
    successorThreadId: "thread-visible",
    expectedGeneration: 3
  }), /session_rotation_request_missing/);

  bindHostedSessionSuccessor({
    root,
    agentId: "orchestrator",
    successorThreadId: "thread-visible",
    expectedGeneration: 2
  });
  assert.throws(() => bindHostedSessionSuccessor({
    root,
    agentId: "orchestrator",
    successorThreadId: "thread-other",
    expectedGeneration: 2
  }), /session_rotation_successor_binding_conflict/);
});
