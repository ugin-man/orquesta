"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  applyKernelEvent,
  createAppServerExecutionBridge,
  createKernelState,
  reconcileTasks,
  runDispatchTick,
} = require("../src");

function createFakeAppServer() {
  const calls = [];
  const listeners = new Set();
  let threadCounter = 0;
  let turnCounter = 0;

  const completed = (operation, fields = {}) => ({
    ok: true,
    status: "completed",
    operation,
    ...fields,
  });

  return {
    calls,
    emit(event) {
      for (const listener of listeners) listener(event);
    },
    subscribeEvents({ listener }) {
      listeners.add(listener);
      return completed("subscribeEvents", {
        subscription: { unsubscribe: () => listeners.delete(listener) },
      });
    },
    createThread(input) {
      calls.push(["createThread", input]);
      threadCounter += 1;
      return completed("createThread", {
        thread_id: `thread-${threadCounter}`,
        runtime_profile: {
          cwd: input.params.cwd,
          sandbox: input.params.sandbox,
          approval_policy: input.params.approvalPolicy,
        },
        model_evidence: {
          recommended_model: null,
          requested_model: null,
          applied_model: "test-model",
          actual_model: null,
        },
      });
    },
    resumeThread(input) {
      calls.push(["resumeThread", input]);
      return completed("resumeThread", { thread_id: input.threadId });
    },
    setThreadName(input) {
      calls.push(["setThreadName", input]);
      return completed("setThreadName", { thread_id: input.threadId });
    },
    startTurn(input) {
      calls.push(["startTurn", input]);
      turnCounter += 1;
      return completed("startTurn", {
        thread_id: input.threadId,
        turn_id: `turn-${turnCounter}`,
      });
    },
    interruptTurn(input) {
      calls.push(["interruptTurn", input]);
      return completed("interruptTurn", {
        thread_id: input.threadId,
        turn_id: input.turnId,
      });
    },
    shutdown(input) {
      calls.push(["shutdown", input]);
      return completed("shutdown");
    },
  };
}

function taskSpec(taskId) {
  return {
    cwd: "C:\\repo",
    prompt: `initial:${taskId}`,
    continuation_prompt: `continue:${taskId}`,
    thread_name: `proof:${taskId}`,
  };
}

test("runs exactly two independent App Server tasks and records real runtime identities", async () => {
  const appServer = createFakeAppServer();
  const bridge = createAppServerExecutionBridge({
    adapter: appServer,
    resolveTask: ({ task_id: taskId }) => taskSpec(taskId),
    clock: () => "2026-07-31T00:00:01.000Z",
  });
  const tasks = [
    { task_id: "A", priority: 1 },
    { task_id: "B", priority: 2 },
  ];
  const tick = await runDispatchTick({
    state: createKernelState({ maxConcurrent: 2 }),
    tasks,
    adapter: bridge,
    now: "2026-07-31T00:00:00.000Z",
  });

  assert.equal(tick.results.length, 2);
  assert.deepEqual(
    tick.results.map((result) => [result.task_id, result.thread_id, result.turn_id]),
    [["A", "thread-1", "turn-1"], ["B", "thread-2", "turn-2"]],
  );
  assert.equal(tick.state.tasks.A.state, "dispatching");
  assert.equal(tick.state.tasks.A.thread_id, "thread-1");
  assert.equal(tick.state.tasks.A.turn_id, "turn-1");
  assert.equal(tick.state.tasks.A.model_evidence.applied_model, "test-model");
  assert.equal(tick.state.tasks.A.runtime_profile.sandbox, "read-only");
  assert.equal(tick.state.tasks.B.thread_id, "thread-2");
  assert.notEqual(tick.state.tasks.A.thread_id, tick.state.tasks.B.thread_id);

  const startCalls = appServer.calls.filter(([operation]) => operation === "startTurn");
  assert.equal(startCalls.length, 2);
  assert.deepEqual(
    startCalls.map(([, input]) => input.input[0].text),
    ["initial:A", "initial:B"],
  );
  await bridge.shutdown();
});

test("normalizes correlated App Server notifications without treating acceptance as start", async () => {
  const appServer = createFakeAppServer();
  const bridge = createAppServerExecutionBridge({
    adapter: appServer,
    resolveTask: ({ task_id: taskId }) => taskSpec(taskId),
    clock: () => "2026-07-31T00:00:02.000Z",
  });
  const tasks = [{ task_id: "A" }];
  const tick = await runDispatchTick({
    state: createKernelState(),
    tasks,
    adapter: bridge,
    now: "2026-07-31T00:00:00.000Z",
  });
  const dispatch = tick.results[0];

  appServer.emit({
    type: "dispatch_accepted",
    correlation_id: dispatch.correlation_id,
    thread_id: dispatch.thread_id,
    turn_id: dispatch.turn_id,
  });
  assert.deepEqual(bridge.drainKernelEvents(), []);

  appServer.emit({
    type: "turn_started",
    correlation_id: dispatch.correlation_id,
    thread_id: dispatch.thread_id,
    turn_id: dispatch.turn_id,
  });
  appServer.emit({
    type: "progress_observed",
    event_method: "item/completed",
    item_id: "item-1",
    correlation_id: dispatch.correlation_id,
    thread_id: dispatch.thread_id,
    turn_id: dispatch.turn_id,
  });
  appServer.emit({
    type: "turn_completed",
    status: "completed",
    correlation_id: dispatch.correlation_id,
    thread_id: dispatch.thread_id,
    turn_id: dispatch.turn_id,
  });

  let state = tick.state;
  for (const event of bridge.drainKernelEvents()) {
    state = applyKernelEvent(state, event);
  }
  assert.equal(state.tasks.A.state, "verifying");
  assert.equal(state.tasks.A.runtime_status, "completed");
  assert.ok(state.tasks.A.turn_started_at);
  assert.ok(state.tasks.A.last_progress_at);
  await bridge.shutdown();
});

test("rejects mismatched runtime identity and a third proof task", async () => {
  const diagnostics = [];
  const appServer = createFakeAppServer();
  const bridge = createAppServerExecutionBridge({
    adapter: appServer,
    resolveTask: ({ task_id: taskId }) => taskSpec(taskId),
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  await bridge.start({
    task_id: "A",
    dispatch_id: "dispatch-a",
    execution_key: "execution-a",
    attempt: 1,
  });
  await bridge.start({
    task_id: "B",
    dispatch_id: "dispatch-b",
    execution_key: "execution-b",
    attempt: 1,
  });

  appServer.emit({
    type: "turn_started",
    correlation_id: "orquesta-execution:dispatch-a",
    thread_id: "wrong-thread",
    turn_id: "turn-1",
  });
  assert.equal(bridge.drainKernelEvents().length, 0);
  assert.equal(diagnostics[0].type, "runtime_thread_mismatch");

  await assert.rejects(
    bridge.start({
      task_id: "C",
      dispatch_id: "dispatch-c",
      execution_key: "execution-c",
      attempt: 1,
    }),
    /app_server_proof_task_limit:2/,
  );
  await bridge.shutdown();
});

test("reuses the real thread and sends only a continuation prompt on a later attempt", async () => {
  const appServer = createFakeAppServer();
  const bridge = createAppServerExecutionBridge({
    adapter: appServer,
    resolveTask: ({ task_id: taskId }) => taskSpec(taskId),
  });
  const first = await bridge.start({
    task_id: "A",
    dispatch_id: "dispatch-a-1",
    execution_key: "execution-a",
    attempt: 1,
  });
  const second = await bridge.start({
    task_id: "A",
    dispatch_id: "dispatch-a-2",
    execution_key: "execution-a",
    attempt: 2,
  });

  assert.equal(first.thread_id, second.thread_id);
  assert.equal(second.continuation, true);
  assert.equal(
    appServer.calls.filter(([operation]) => operation === "createThread").length,
    1,
  );
  assert.equal(
    appServer.calls.filter(([operation]) => operation === "resumeThread").length,
    1,
  );
  assert.deepEqual(
    appServer.calls
      .filter(([operation]) => operation === "startTurn")
      .map(([, input]) => input.input[0].text),
    ["initial:A", "continue:A"],
  );
  await bridge.shutdown();
});

test("kernel refuses a runtime event from another real turn", () => {
  let state = reconcileTasks(
    createKernelState(),
    [{ task_id: "A" }],
    { now: "2026-07-31T00:00:00.000Z" },
  );
  state.tasks.A.state = "dispatching";
  state.tasks.A.dispatch_id = "dispatch-a";
  state.tasks.A.thread_id = "thread-a";
  state.tasks.A.turn_id = "turn-a";

  assert.throws(
    () => applyKernelEvent(state, {
      event_id: "event-wrong-turn",
      type: "turn_started",
      task_id: "A",
      dispatch_id: "dispatch-a",
      thread_id: "thread-a",
      turn_id: "turn-other",
      observed_at: "2026-07-31T00:00:01.000Z",
    }),
    /runtime_turn_mismatch:turn-other/,
  );
});
