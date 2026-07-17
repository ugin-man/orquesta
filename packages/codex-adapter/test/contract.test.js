const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CODEX_ADAPTER_METHODS,
  ADAPTER_FAILURE_STATUSES,
  createAppServerAdapter,
  createAdapterFailure,
  createJsonlTransport,
  resolveBundledCodexRuntime,
  defineCodexAdapter
} = require("../src");

test("CodexAdapter declares the complete stable method surface", () => {
  assert.deepEqual(CODEX_ADAPTER_METHODS, [
    "capabilities",
    "createThread",
    "resumeThread",
    "startTurn",
    "steerTurn",
    "interruptTurn",
    "respondToApproval",
    "subscribeEvents",
    "readActualModel"
  ]);
  assert.deepEqual(ADAPTER_FAILURE_STATUSES, [
    "unsupported",
    "unauthorized",
    "unavailable",
    "rejected",
    "failed"
  ]);
});

test("package exports the pinned runtime and App Server adapter surface", () => {
  assert.equal(typeof resolveBundledCodexRuntime, "function");
  assert.equal(typeof createJsonlTransport, "function");
  assert.equal(typeof createAppServerAdapter, "function");
});

test("adapter construction rejects incomplete or non-boolean capability declarations", () => {
  const methods = Object.fromEntries(
    CODEX_ADAPTER_METHODS.map((method) => [method, () => ({ ok: true })])
  );

  assert.throws(
    () => defineCodexAdapter({
      adapter: "invalid",
      capabilities: { createThread: true },
      methods
    }),
    /capability declaration/i
  );

  const capabilities = Object.fromEntries(
    CODEX_ADAPTER_METHODS
      .filter((method) => method !== "capabilities")
      .map((method) => [method, false])
  );
  capabilities.startTurn = "no";

  assert.throws(
    () => defineCodexAdapter({ adapter: "invalid", capabilities, methods }),
    /startTurn.*boolean/i
  );
});

test("failure results have a detached frozen shape and redact unapproved evidence", () => {
  const source = {
    dispatch_accepted: true,
    turn_started: false,
    actual_model: null,
    api_key: "secret",
    credential: "also-secret"
  };
  const result = createAdapterFailure({
    adapter: "repository_only",
    status: "unsupported",
    correlationId: "corr-1",
    operation: "startTurn",
    code: "runtime_unsupported",
    message: "Runtime execution is unavailable.",
    evidence: source
  });

  source.dispatch_accepted = false;
  assert.deepEqual(result, {
    ok: false,
    status: "unsupported",
    adapter: "repository_only",
    operation: "startTurn",
    correlation_id: "corr-1",
    thread_id: null,
    turn_id: null,
    approval_id: null,
    error: {
      code: "runtime_unsupported",
      message: "Runtime execution is unavailable."
    },
    evidence: {
      dispatch_accepted: true,
      turn_started: false,
      actual_model: null
    }
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.evidence), true);
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("failure results require a caller correlation ID and an enumerated status", () => {
  assert.throws(
    () => createAdapterFailure({
      adapter: "repository_only",
      status: "unsupported",
      operation: "startTurn",
      code: "runtime_unsupported",
      message: "Runtime execution is unavailable."
    }),
    /correlation/i
  );
  assert.throws(
    () => createAdapterFailure({
      adapter: "repository_only",
      status: "maybe",
      correlationId: "corr-2",
      operation: "startTurn",
      code: "runtime_unsupported",
      message: "Runtime execution is unavailable."
    }),
    /failure status/i
  );
});
