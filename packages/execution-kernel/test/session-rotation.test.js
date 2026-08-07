"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_SESSION_ROTATION_POLICY,
  activateSessionSuccessor,
  beginSessionDrain,
  createSessionRotationRegistry,
  markSessionCheckpointed,
  markSuccessorVerified,
  recordCompaction,
  registerSessionSuccessor,
  rotationStateForCount,
  selectActiveAgentSession,
} = require("../src/session-rotation");

const at = (second) => `2026-07-31T00:00:${String(second).padStart(2, "0")}.000Z`;

function compact(registry, count, sessionId = "thread-1") {
  let next = registry;
  for (let index = 1; index <= count; index += 1) {
    next = recordCompaction(next, {
      event_id: `${sessionId}:compact:${index}`,
      session_id: sessionId,
      thread_id: sessionId,
      agent_id: "orchestrator",
      session_generation: 1,
      turn_id: `turn-${index}`,
      trigger: "auto",
      observed_at: at(index),
    }).registry;
  }
  return next;
}

test("uses 12, 15, and 20 as configurable default thresholds", () => {
  assert.deepEqual(DEFAULT_SESSION_ROTATION_POLICY, { prepare_at: 12, pending_at: 15, required_at: 20 });
  assert.equal(rotationStateForCount(11), "active");
  assert.equal(rotationStateForCount(12), "rotation_preparing");
  assert.equal(rotationStateForCount(15), "rotation_pending");
  assert.equal(rotationStateForCount(20), "rotation_required");
  assert.equal(rotationStateForCount(8, { prepare_at: 4, pending_at: 6, required_at: 8 }), "rotation_required");
});

test("records compactions idempotently and stops accepting new work only at required", () => {
  let registry = compact(createSessionRotationRegistry(), 19);
  assert.equal(registry.sessions["thread-1"].rotation_state, "rotation_pending");
  assert.equal(registry.sessions["thread-1"].accepts_new_work, true);
  const result = recordCompaction(registry, {
    event_id: "thread-1:compact:20",
    session_id: "thread-1",
    agent_id: "orchestrator",
    turn_id: "turn-20",
    trigger: "auto",
    observed_at: at(20),
  });
  registry = result.registry;
  assert.equal(result.threshold_crossed, "rotation_required");
  assert.equal(registry.sessions["thread-1"].accepts_new_work, false);
  const duplicate = recordCompaction(registry, {
    event_id: "thread-1:compact:20",
    session_id: "thread-1",
    observed_at: at(21),
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.session.compaction_count, 20);
});

test("requires checkpoint and verified receipt before atomic ownership cutover", () => {
  let registry = compact(createSessionRotationRegistry(), 15);
  registry = beginSessionDrain(registry, {
    session_id: "thread-1",
    expected_revision: registry.revision,
    observed_at: at(30),
  });
  registry = markSessionCheckpointed(registry, {
    session_id: "thread-1",
    expected_revision: registry.revision,
    handoff_manifest_path: ".orquesta/handoffs/orchestrator-g1.json",
    handoff_manifest_hash: "sha256:manifest",
    observed_at: at(31),
  });
  registry = registerSessionSuccessor(registry, {
    predecessor_session_id: "thread-1",
    successor_session_id: "thread-2",
    successor_thread_id: "thread-2",
    expected_revision: registry.revision,
    observed_at: at(32),
  });
  assert.equal(registry.sessions["thread-1"].ownership_status, "owner");
  assert.equal(registry.sessions["thread-2"].ownership_status, "candidate");
  const receipt = {
    agent_id: "orchestrator",
    expected_generation: 2,
    observed_generation: 2,
    handoff_manifest_hash: "sha256:manifest",
    evidence_checked: ["sessions.json", "tasks.json", "git status"],
    next_action: "Resume the active V4 Fast task.",
    ready_to_assume_ownership: true,
  };
  registry = markSuccessorVerified(registry, {
    successor_session_id: "thread-2",
    expected_revision: registry.revision,
    receipt,
    receipt_path: ".orquesta/handoffs/orchestrator-g2-receipt.json",
    receipt_hash: "sha256:receipt",
    observed_at: at(33),
  });
  registry = activateSessionSuccessor(registry, {
    successor_session_id: "thread-2",
    expected_revision: registry.revision,
    observed_at: at(34),
  });
  assert.equal(registry.sessions["thread-1"].rotation_state, "superseded");
  assert.equal(registry.sessions["thread-2"].rotation_state, "active");
  assert.equal(registry.sessions["thread-2"].ownership_status, "owner");
  assert.equal(selectActiveAgentSession(Object.values(registry.sessions), "orchestrator").thread_id, "thread-2");
});

test("rejects a successor receipt that does not prove the manifest and evidence", () => {
  let registry = compact(createSessionRotationRegistry(), 15);
  registry = beginSessionDrain(registry, { session_id: "thread-1", observed_at: at(30) });
  registry = markSessionCheckpointed(registry, {
    session_id: "thread-1",
    handoff_manifest_path: "manifest.json",
    handoff_manifest_hash: "sha256:manifest",
    observed_at: at(31),
  });
  registry = registerSessionSuccessor(registry, {
    predecessor_session_id: "thread-1",
    successor_session_id: "thread-2",
    successor_thread_id: "thread-2",
    observed_at: at(32),
  });
  assert.throws(() => markSuccessorVerified(registry, {
    successor_session_id: "thread-2",
    receipt: {
      agent_id: "orchestrator",
      expected_generation: 2,
      observed_generation: 2,
      handoff_manifest_hash: "wrong",
      evidence_checked: [],
      next_action: "",
      ready_to_assume_ownership: true,
    },
    receipt_path: "receipt.json",
    receipt_hash: "sha256:receipt",
    observed_at: at(33),
  }), (error) => error.code === "SESSION_ROTATION_RECEIPT_REJECTED");
});

test("does not guess when two sessions claim the same active generation", () => {
  assert.throws(() => selectActiveAgentSession([
    { agent_id: "worker", thread_id: "a", session_generation: 2, ownership_status: "owner", binding_status: "bound" },
    { agent_id: "worker", thread_id: "b", session_generation: 2, ownership_status: "owner", binding_status: "bound" },
  ], "worker"), (error) => error.code === "SESSION_ROTATION_MULTIPLE_OWNERS");
});
