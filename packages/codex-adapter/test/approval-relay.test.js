const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createApprovalRelay,
  normalizeApprovalRequest
} = require("../src/approval-relay");

function approvalMessage({
  id = "approval-1",
  method = "item/fileChange/requestApproval",
  threadId = "thread-1",
  turnId = "turn-1",
  itemId = "item-1"
} = {}) {
  return {
    id,
    method,
    params: {
      itemId,
      startedAtMs: 4,
      threadId,
      turnId,
      reason: "Write file with Bearer secret-token",
      command: "tool --token raw-secret"
    }
  };
}

function register(relay, overrides = {}) {
  const message = approvalMessage(overrides);
  return relay.register({
    message,
    correlationId: overrides.correlationId || "corr-1",
    threadId: overrides.threadId || "thread-1",
    turnId: overrides.turnId || "turn-1"
  });
}

function response(overrides = {}) {
  return {
    requestId: "approval-1",
    method: "item/fileChange/requestApproval",
    threadId: "thread-1",
    turnId: "turn-1",
    correlationId: "corr-1",
    decision: "decline",
    ...overrides
  };
}

test("normalizes only bounded approval evidence from the schema-pinned request", () => {
  const normalized = normalizeApprovalRequest({
    message: approvalMessage(),
    correlationId: "corr-1",
    threadId: "thread-1",
    turnId: "turn-1"
  });

  assert.deepEqual(normalized, {
    request_id: "approval-1",
    method: "item/fileChange/requestApproval",
    thread_id: "thread-1",
    turn_id: "turn-1",
    correlation_id: "corr-1",
    reason: "[redacted approval reason]",
    requested_effect: {
      kind: "file_change",
      item_id: "item-1"
    },
    response_options: ["accept", "acceptForSession", "decline", "cancel"]
  });
  const serialized = JSON.stringify(normalized);
  assert.doesNotMatch(serialized, /secret-token|raw-secret|tool --token/);
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.requested_effect), true);
});

test("rejects every mismatched approval binding and leaves the request pending", () => {
  const mismatches = [
    { requestId: "wrong-request" },
    { threadId: "wrong-thread" },
    { turnId: "wrong-turn" },
    { correlationId: "wrong-correlation" },
    { method: "item/commandExecution/requestApproval" },
    { decision: "not-a-schema-option" }
  ];

  for (const mismatch of mismatches) {
    const relay = createApprovalRelay();
    register(relay);
    assert.throws(
      () => relay.consume(response(mismatch)),
      /does not match|not allowed/,
      JSON.stringify(mismatch)
    );
    assert.equal(relay.pendingCount(), 1);
  }
});

test("returns exactly one method-matched response and rejects a consumed ID", () => {
  const relay = createApprovalRelay();
  register(relay);

  assert.deepEqual(relay.consume(response()), {
    id: "approval-1",
    result: { decision: "decline" }
  });
  assert.equal(relay.pendingCount(), 0);
  assert.throws(() => relay.consume(response()), /does not match a pending request/);
});

test("preserves concurrent approval requests independently", () => {
  const relay = createApprovalRelay();
  register(relay, { id: "approval-1", itemId: "item-1" });
  register(relay, { id: "approval-2", itemId: "item-2" });

  assert.deepEqual(relay.consume(response({ requestId: "approval-2" })), {
    id: "approval-2",
    result: { decision: "decline" }
  });
  assert.equal(relay.pendingCount(), 1);
  assert.deepEqual(relay.consume(response({ requestId: "approval-1" })), {
    id: "approval-1",
    result: { decision: "decline" }
  });
});

test("fails closed across a process restart and has no automatic response path", () => {
  const relay = createApprovalRelay();
  const request = register(relay);

  assert.equal(relay.pendingCount(), 1);
  assert.equal(Object.hasOwn(request, "decision"), false);
  relay.reset();
  assert.equal(relay.pendingCount(), 0);
  assert.throws(() => relay.consume(response()), /does not match a pending request/);
});
