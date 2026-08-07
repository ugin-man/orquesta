"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { runHook } = require("./session-rotation-hook");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-session-hook-"));
  const state = path.join(root, ".orquesta", "state");
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, "sessions.json"), `${JSON.stringify({
    sessions: [{
      session_id: "session-orchestrator-g1",
      thread_id: "thread-orchestrator-g1",
      agent_id: "orchestrator",
      session_generation: 1,
    }],
  }, null, 2)}\n`, "utf8");
  const transcript = path.join(root, "rollout.jsonl");
  fs.writeFileSync(transcript, "{}\n", "utf8");
  return { root, state, transcript };
}

function payload(f, index) {
  fs.appendFileSync(f.transcript, `${JSON.stringify({ index })}\n`, "utf8");
  const stat = fs.statSync(f.transcript);
  fs.utimesSync(f.transcript, stat.atime, new Date(stat.mtimeMs + index + 1));
  return {
    session_id: "thread-orchestrator-g1",
    turn_id: `turn-${index}`,
    transcript_path: f.transcript,
    cwd: f.root,
    hook_event_name: "PostCompact",
    trigger: "auto",
    model: "gpt-5.6-sol",
  };
}

test("ignores non-Orquesta and unbound Codex sessions", () => {
  const f = fixture();
  assert.equal(runHook({ hook_event_name: "PostCompact", session_id: "missing", cwd: f.root }).tracked, false);
  assert.equal(runHook({ hook_event_name: "SessionStart", session_id: "thread-orchestrator-g1", cwd: f.root }).tracked, false);
});

test("persists compaction state and emits only threshold transitions", () => {
  const f = fixture();
  let result;
  for (let index = 1; index <= 20; index += 1) {
    result = runHook(payload(f, index), {
      now: () => `2026-07-31T00:00:${String(index).padStart(2, "0")}.000Z`,
    });
    if ([12, 15, 20].includes(index)) {
      assert.match(result.output.systemMessage, new RegExp(`compaction ${index}`));
    } else {
      assert.equal(result.output, null);
    }
  }
  const registry = JSON.parse(fs.readFileSync(path.join(f.state, "session-rotation.json"), "utf8"));
  const session = registry.sessions["session-orchestrator-g1"];
  assert.equal(session.compaction_count, 20);
  assert.equal(session.rotation_state, "rotation_required");
  assert.equal(session.accepts_new_work, false);
  assert.equal(session.agent_id, "orchestrator");
});
