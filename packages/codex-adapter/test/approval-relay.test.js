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

function responseFor(request, overrides = {}) {
  return response({ requestId: request.request_id, ...overrides });
}

test("normalizes only bounded approval evidence from the schema-pinned request", () => {
  const normalized = normalizeApprovalRequest({
    message: approvalMessage(),
    correlationId: "corr-1",
    threadId: "thread-1",
    turnId: "turn-1"
  });

  assert.match(normalized.request_id, /^adapter-approval-[a-f0-9]{64}$/u);
  assert.match(normalized.request_instance_id, /^adapter-approval-instance-[a-f0-9]{64}$/u);
  assert.deepEqual(normalized, {
    request_id: normalized.request_id,
    request_instance_id: normalized.request_instance_id,
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
  assert.doesNotMatch(serialized, /approval-1/);
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
    const request = register(relay);
    const boundResponse = responseFor(request, mismatch.requestId ? mismatch : { ...mismatch });
    assert.throws(
      () => relay.consume(mismatch.requestId
        ? response(mismatch)
        : boundResponse),
      /does not match|not allowed/,
      JSON.stringify(mismatch)
    );
    assert.equal(relay.pendingCount(), 1);
  }
});

test("returns exactly one method-matched response and rejects a consumed ID", () => {
  const relay = createApprovalRelay();
  const request = register(relay);

  assert.deepEqual(relay.consume(responseFor(request)), {
    id: "approval-1",
    result: { decision: "decline" }
  });
  assert.equal(relay.pendingCount(), 0);
  assert.throws(() => relay.consume(responseFor(request)), /does not match a pending request/);
});

test("preserves concurrent approval requests independently", () => {
  const relay = createApprovalRelay();
  const first = register(relay, { id: "approval-1", itemId: "item-1" });
  const second = register(relay, { id: "approval-2", itemId: "item-2" });

  assert.deepEqual(relay.consume(responseFor(second)), {
    id: "approval-2",
    result: { decision: "decline" }
  });
  assert.equal(relay.pendingCount(), 1);
  assert.deepEqual(relay.consume(responseFor(first)), {
    id: "approval-1",
    result: { decision: "decline" }
  });
});

test("fails closed across a process restart and has no automatic response path", () => {
  const relay = createApprovalRelay();
  const request = register(relay);

  assert.equal(relay.pendingCount(), 1);
  assert.equal(Object.hasOwn(request, "decision"), false);
  const expired = relay.reset();
  assert.deepEqual(expired, [request]);
  assert.equal(Object.isFrozen(expired), true);
  assert.equal(relay.pendingCount(), 0);
  assert.throws(() => relay.consume(responseFor(request)), /does not match a pending request/);
  const restarted = register(relay);
  assert.notEqual(restarted.request_id, request.request_id);
  assert.deepEqual(relay.consume(responseFor(restarted)), {
    id: "approval-1",
    result: { decision: "decline" }
  });
});

test("rejects lossy numeric and oversized string provider IDs", () => {
  assert.throws(
    () => normalizeApprovalRequest({
      message: approvalMessage({ id: Number.MAX_SAFE_INTEGER + 1 }),
      correlationId: "corr-1",
      threadId: "thread-1",
      turnId: "turn-1"
    }),
    /safe integer/i
  );
  assert.throws(
    () => normalizeApprovalRequest({
      message: approvalMessage({ id: "x".repeat(1025) }),
      correlationId: "corr-1",
      threadId: "thread-1",
      turnId: "turn-1"
    }),
    /1-1024/i
  );
  assert.throws(
    () => normalizeApprovalRequest({
      message: approvalMessage({ id: -0 }),
      correlationId: "corr-1",
      threadId: "thread-1",
      turnId: "turn-1"
    }),
    /safe integer/i
  );
  for (const id of [
    `approval-${"a".repeat(64)}`,
    `adapter-approval-${"b".repeat(64)}`,
    `adapter-approval-instance-${"c".repeat(64)}`
  ]) {
    assert.throws(
      () => normalizeApprovalRequest({
        message: approvalMessage({ id }),
        correlationId: "corr-1",
        threadId: "thread-1",
        turnId: "turn-1"
      }),
      /public approval namespace/i
    );
  }
});

test("expires every pending approval for a terminal turn", () => {
  const relay = createApprovalRelay();
  const first = register(relay, { id: "approval-1" });
  register(relay, { id: "approval-2" });
  assert.equal(relay.expireTurn("thread-1", "turn-1"), 2);
  assert.equal(relay.pendingCount(), 0);
  assert.throws(() => relay.consume(responseFor(first)), /pending request/);
});

test("domain-separates raw ID types and instances for legal sequential provider ID reuse", () => {
  const stringRelay = createApprovalRelay();
  const stringRequest = register(stringRelay, { id: "1" });
  const numberRelay = createApprovalRelay();
  const numberRequest = register(numberRelay, { id: 1 });
  assert.notEqual(stringRequest.request_id, numberRequest.request_id);

  const relay = createApprovalRelay();
  const first = register(relay, { id: "reused-provider-id" });
  assert.deepEqual(relay.consume(responseFor(first)), {
    id: "reused-provider-id",
    result: { decision: "decline" }
  });
  const second = register(relay, { id: "reused-provider-id", itemId: "different-item" });
  assert.notEqual(second.request_id, first.request_id);
  assert.notEqual(second.request_instance_id, first.request_instance_id);
  assert.throws(() => relay.consume(responseFor(first)), /pending request/i);
  assert.deepEqual(relay.consume(responseFor(second)), {
    id: "reused-provider-id",
    result: { decision: "decline" }
  });
});

test("rejects only ambiguous concurrent raw-ID reuse and enforces the pending bound", () => {
  const relay = createApprovalRelay({ maxPending: 2 });
  register(relay, { id: "provider-1", itemId: "item-1" });
  assert.throws(
    () => register(relay, { id: "provider-1", itemId: "different-item" }),
    /already pending/i
  );
  register(relay, { id: "provider-2", itemId: "item-2" });
  assert.throws(
    () => register(relay, { id: "provider-3", itemId: "item-3" }),
    /pending approval limit 2/i
  );
});
