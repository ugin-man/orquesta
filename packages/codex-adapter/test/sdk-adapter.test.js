const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createSdkAdapter,
  mapThreadOptions
} = require("../src/sdk-adapter");

function waitForEvent(events, type) {
  return new Promise((resolve) => {
    const existing = events.find((event) => event.type === type);
    if (existing) return resolve(existing);
    events.waiters.push({ type, resolve });
  });
}

function collectEvents() {
  const events = [];
  events.waiters = [];
  events.listener = (event) => {
    events.push(event);
    for (const waiter of [...events.waiters]) {
      if (waiter.type === event.type) {
        events.waiters.splice(events.waiters.indexOf(waiter), 1);
        waiter.resolve(event);
      }
    }
  };
  return events;
}

test("maps only approved SDK ThreadOptions", () => {
  assert.deepEqual(mapThreadOptions({
    model: "gpt-5",
    sandboxMode: "workspace-write",
    workingDirectory: "C:\\repo",
    skipGitRepoCheck: true,
    networkAccessEnabled: true,
    webSearchMode: "live",
    approvalPolicy: "on-request",
    hiddenPolicy: "must-not-pass"
  }), {
    model: "gpt-5",
    sandboxMode: "workspace-write",
    workingDirectory: "C:\\repo",
    skipGitRepoCheck: true,
    networkAccessEnabled: true,
    webSearchMode: "live",
    approvalPolicy: "on-request"
  });
});

test("starts a new SDK thread with a caller-owned handle and truthful model evidence", async () => {
  const calls = [];
  const thread = { id: null, runStreamed: async () => ({ events: (async function* () {})() }) };
  const adapter = createSdkAdapter({
    codexFactory: async () => ({
      startThread(options) {
        calls.push(options);
        return thread;
      },
      resumeThread() {
        throw new Error("not used");
      }
    })
  });

  const result = await adapter.createThread({
    correlationId: "corr-create",
    recommendedModel: "recommended-model",
    requestedModel: "requested-model",
    profile: {
      model: "requested-model",
      sandboxMode: "workspace-write",
      workingDirectory: "C:\\repo",
      skipGitRepoCheck: true,
      networkAccessEnabled: false,
      webSearchMode: "cached",
      approvalPolicy: "on-request"
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.thread_id, null);
  assert.equal(result.thread_handle, "corr-create");
  assert.deepEqual(result.model_evidence, {
    recommended_model: "recommended-model",
    requested_model: "requested-model",
    applied_model: "requested-model",
    actual_model: null,
    actual_model_evidence_ref: null
  });
  assert.equal(result.actual_model, null);
  assert.deepEqual(calls, [{
    model: "requested-model",
    sandboxMode: "workspace-write",
    workingDirectory: "C:\\repo",
    skipGitRepoCheck: true,
    networkAccessEnabled: false,
    webSearchMode: "cached",
    approvalPolicy: "on-request"
  }]);
});

test("resumes an SDK thread by its exact runtime ID", async () => {
  const calls = [];
  const thread = { id: "thread-existing", runStreamed: async () => ({ events: (async function* () {})() }) };
  const adapter = createSdkAdapter({
    codexFactory: async () => ({
      startThread() {
        throw new Error("not used");
      },
      resumeThread(id, options) {
        calls.push({ id, options });
        return thread;
      }
    })
  });

  const result = await adapter.resumeThread({
    correlationId: "corr-resume",
    threadId: "thread-existing",
    profile: { sandboxMode: "read-only" }
  });
  assert.equal(result.thread_id, "thread-existing");
  assert.equal(result.thread_handle, "thread-existing");
  assert.deepEqual(calls, [{ id: "thread-existing", options: { sandboxMode: "read-only" } }]);
});

test("normalizes runStreamed lifecycle and final response artifact without inventing a turn ID", async () => {
  const events = collectEvents();
  const thread = {
    id: null,
    async runStreamed(input, options) {
      assert.deepEqual(input, [{ type: "text", text: "hello" }]);
      assert.ok(options.signal instanceof AbortSignal);
      const self = this;
      return {
        events: (async function* () {
          self.id = "thread-sdk-1";
          yield { type: "thread.started", thread_id: "thread-sdk-1" };
          yield { type: "turn.started" };
          yield { type: "item.started", item: { id: "item-1", type: "reasoning", text: "thinking" } };
          yield { type: "item.completed", item: { id: "item-2", type: "agent_message", text: "final answer" } };
          yield { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0 } };
        })()
      };
    }
  };
  const adapter = createSdkAdapter({
    codexFactory: async () => ({ startThread: () => thread, resumeThread: () => thread })
  });
  await adapter.subscribeEvents({ correlationId: "corr-sub", listener: events.listener });
  await adapter.createThread({ correlationId: "corr-create", profile: {} });
  const started = await adapter.startTurn({
    correlationId: "corr-turn",
    threadHandle: "corr-create",
    input: [{ type: "text", text: "hello" }]
  });
  await waitForEvent(events, "turn_completed");

  assert.equal(started.evidence.dispatch_accepted, true);
  assert.equal(started.evidence.turn_started, false);
  assert.equal(started.turn_id, null);
  assert.deepEqual(events.map((event) => event.type), [
    "dispatch_accepted",
    "thread_started",
    "turn_started",
    "progress_observed",
    "artifact_produced",
    "progress_observed",
    "turn_completed"
  ]);
  const artifact = events.find((event) => event.type === "artifact_produced");
  assert.equal(artifact.correlation_id, "corr-turn");
  assert.equal(artifact.thread_id, "thread-sdk-1");
  assert.equal(artifact.turn_id, null);
  assert.equal(artifact.artifact_type, "final_response");
  assert.equal(artifact.content, "final answer");
});

test("interrupts only an adapter-owned active SDK turn", async () => {
  let capturedSignal;
  let release;
  const thread = {
    id: "thread-sdk-2",
    async runStreamed(input, options) {
      capturedSignal = options.signal;
      return {
        events: (async function* () {
          yield { type: "turn.started" };
          await new Promise((resolve) => { release = resolve; });
        })()
      };
    }
  };
  const adapter = createSdkAdapter({
    codexFactory: async () => ({ startThread: () => thread, resumeThread: () => thread })
  });
  await adapter.createThread({ correlationId: "corr-create", profile: {} });
  await adapter.startTurn({
    correlationId: "corr-turn",
    threadHandle: "corr-create",
    input: "hello"
  });
  await new Promise((resolve) => setImmediate(resolve));

  const interrupted = await adapter.interruptTurn({
    correlationId: "corr-interrupt",
    threadHandle: "corr-create"
  });
  assert.equal(interrupted.ok, true);
  assert.equal(capturedSignal.aborted, true);
  const repeated = await adapter.interruptTurn({
    correlationId: "corr-repeat",
    threadHandle: "corr-create"
  });
  assert.equal(repeated.status, "unsupported");
  release();
});

test("classifies an unavailable SDK separately from SDK execution errors", async () => {
  const unavailable = createSdkAdapter({
    codexFactory: async () => {
      const error = new Error("Cannot find package @openai/codex-sdk");
      error.code = "ERR_MODULE_NOT_FOUND";
      throw error;
    }
  });
  const unavailableResult = await unavailable.createThread({
    correlationId: "corr-unavailable",
    profile: {}
  });
  assert.equal(unavailableResult.status, "unavailable");

  const failed = createSdkAdapter({
    codexFactory: async () => ({
      startThread: () => {
        throw new Error("SDK start failed");
      },
      resumeThread: () => {
        throw new Error("not used");
      }
    })
  });
  const failedResult = await failed.createThread({
    correlationId: "corr-failed",
    profile: {}
  });
  assert.equal(failedResult.status, "failed");
  assert.match(failedResult.error.message, /SDK start failed/);
});

test("keeps steer, direct approval, and actual-model evidence explicitly unsupported", async () => {
  const adapter = createSdkAdapter({
    codexFactory: async () => ({
      startThread: () => ({ id: null }),
      resumeThread: () => ({ id: "thread" })
    })
  });
  for (const [method, input] of [
    ["steerTurn", { correlationId: "corr-steer" }],
    ["respondToApproval", { correlationId: "corr-approval" }],
    ["readActualModel", { correlationId: "corr-model" }]
  ]) {
    const result = await adapter[method](input);
    assert.equal(result.status, "unsupported", method);
    assert.equal(result.actual_model, undefined, method);
    assert.equal(result.evidence.actual_model, null, method);
  }
});
