"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { prepareHostedSessionPlacement } = require("./session-placement-prepare");

function fixture({ bound = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-placement-prepare-"));
  const state = path.join(root, ".orquesta", "state");
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, "runtime-binding.json"), `${JSON.stringify({
    mode: "codex_hosted", project_id: "repo-1", runtime_authority_id: "authority-1"
  }, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(state, "sessions.json"), `${JSON.stringify({
    sessions: [{
      session_id: "session-luca", thread_id: "thread-luca", agent_id: "orquesta-admin",
      ...(bound ? { binding_status: "bound", runtime_authority_id: "authority-1", visibility: "codex_task" } : {})
    }]
  }, null, 2)}\n`, "utf8");
  return { root, state };
}

test("imports a legacy owner and prepares one manual hosted recovery request", (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));

  const result = prepareHostedSessionPlacement({
    root: f.root,
    agentId: "orquesta-admin",
    expectedGeneration: 2,
    now: () => "2026-08-03T09:00:00.000Z"
  });

  assert.deepEqual(result, {
    status: "manual_recovery",
    agent_id: "orquesta-admin",
    predecessor_session_id: "session-luca",
    predecessor_thread_id: "thread-luca",
    expected_successor_generation: 2,
    target_project_root: fs.realpathSync(f.root),
    recovery_path: path.join(fs.realpathSync(f.root), ".orquesta", "state", "session-rotation-recovery.json")
  });
  const registry = JSON.parse(fs.readFileSync(path.join(f.state, "session-rotation.json"), "utf8"));
  assert.equal(registry.revision, 1);
  assert.equal(registry.sessions["session-luca"].rotation_state, "rotation_pending");
  assert.equal(registry.sessions["session-luca"].ownership_status, "owner");
  assert.equal(registry.sessions["session-luca"].accepts_new_work, true);
  const recovery = JSON.parse(fs.readFileSync(path.join(f.state, "session-rotation-recovery.json"), "utf8"));
  assert.equal(recovery.requests.length, 1);
  assert.equal(recovery.requests[0].request_id, "orquesta-admin:generation-2");
  assert.equal(recovery.requests[0].status, "manual_recovery");
  assert.equal(recovery.requests[0].successor_thread_id, null);
});

test("is idempotent and preserves an already bound successor", (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const input = {
    root: f.root, agentId: "orquesta-admin", expectedGeneration: 2,
    now: () => "2026-08-03T09:00:00.000Z"
  };
  prepareHostedSessionPlacement(input);
  const recoveryPath = path.join(f.state, "session-rotation-recovery.json");
  const recovery = JSON.parse(fs.readFileSync(recoveryPath, "utf8"));
  recovery.requests[0].status = "bound";
  recovery.requests[0].successor_thread_id = "thread-luca-g2";
  fs.writeFileSync(recoveryPath, `${JSON.stringify(recovery, null, 2)}\n`, "utf8");

  const result = prepareHostedSessionPlacement(input);
  assert.equal(result.status, "bound");
  const registry = JSON.parse(fs.readFileSync(path.join(f.state, "session-rotation.json"), "utf8"));
  assert.equal(registry.revision, 1);
  const after = JSON.parse(fs.readFileSync(recoveryPath, "utf8"));
  assert.equal(after.requests[0].successor_thread_id, "thread-luca-g2");
});

test("rejects stale generations and sessions already owned by this runtime", (t) => {
  const f = fixture();
  const bound = fixture({ bound: true });
  t.after(() => {
    fs.rmSync(f.root, { recursive: true, force: true });
    fs.rmSync(bound.root, { recursive: true, force: true });
  });

  assert.throws(() => prepareHostedSessionPlacement({
    root: f.root, agentId: "orquesta-admin", expectedGeneration: 3
  }), /session_placement_generation_mismatch/);
  assert.throws(() => prepareHostedSessionPlacement({
    root: bound.root, agentId: "orquesta-admin", expectedGeneration: 2
  }), /session_already_bound_to_runtime/);
});
