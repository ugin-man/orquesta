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

test("single-flights concurrent starts for the same immutable dispatch", async () => {
  const appServer = createFakeAppServer();
  let resolveCount = 0;
  const bridge = createAppServerExecutionBridge({
    adapter: appServer,
    resolveTask: async ({ task_id: taskId }) => {
      resolveCount += 1;
      await Promise.resolve();
      return taskSpec(taskId);
    },
  });
  const dispatch = {
    task_id: "A",
    dispatch_id: "dispatch-a",
    execution_key: "execution-a",
    attempt: 1,
    payload: { objective: "build the report", constraints: ["read-only"] },
  };

  const [first, second] = await Promise.all([
    bridge.start(dispatch),
    bridge.start({
      payload: { constraints: ["read-only"], objective: "build the report" },
      attempt: 1,
      execution_key: "execution-a",
      dispatch_id: "dispatch-a",
      task_id: "A",
    }),
  ]);

  assert.deepEqual(second, first);
  assert.equal(resolveCount, 1);
  assert.equal(
    appServer.calls.filter(([operation]) => operation === "createThread").length,
    1,
  );
  assert.equal(
    appServer.calls.filter(([operation]) => operation === "startTurn").length,
    1,
  );
  await assert.rejects(
    bridge.start({ ...dispatch }),
    /duplicate_dispatch:dispatch-a/,
  );
  await bridge.shutdown();
});

test("rejects a concurrent payload conflict for the same dispatch ID", async () => {
  const appServer = createFakeAppServer();
  const bridge = createAppServerExecutionBridge({
    adapter: appServer,
    resolveTask: ({ task_id: taskId }) => taskSpec(taskId),
  });
  const firstStart = bridge.start({
    task_id: "A",
    dispatch_id: "dispatch-a",
    execution_key: "execution-a",
    attempt: 1,
    payload: { objective: "first objective" },
  });

  await assert.rejects(
    bridge.start({
      task_id: "A",
      dispatch_id: "dispatch-a",
      execution_key: "execution-a",
      attempt: 1,
      payload: { objective: "different objective" },
    }),
    (error) => error.code === "dispatch_payload_conflict"
      && error.message === "dispatch_payload_conflict:dispatch-a",
  );
  await firstStart;

  await assert.rejects(
    bridge.start({
      task_id: "A",
      dispatch_id: "dispatch-a",
      execution_key: "execution-a",
      attempt: 1,
      payload: { objective: "another objective after acceptance" },
    }),
    (error) => error.code === "dispatch_payload_conflict",
  );

  assert.equal(
    appServer.calls.filter(([operation]) => operation === "createThread").length,
    1,
  );
  assert.equal(
    appServer.calls.filter(([operation]) => operation === "startTurn").length,
    1,
  );
  await bridge.shutdown();
});

test("cleans a failed start reservation so the dispatch can be retried", async () => {
  const appServer = createFakeAppServer();
  let resolveCount = 0;
  const bridge = createAppServerExecutionBridge({
    adapter: appServer,
    resolveTask: ({ task_id: taskId }) => {
      resolveCount += 1;
      if (resolveCount === 1) throw new Error("task_resolution_failed");
      return taskSpec(taskId);
    },
  });
  const dispatch = {
    task_id: "A",
    dispatch_id: "dispatch-a",
    execution_key: "execution-a",
    attempt: 1,
  };

  await assert.rejects(bridge.start(dispatch), /task_resolution_failed/);
  assert.equal(bridge.readDispatch("dispatch-a"), null);

  const retried = await bridge.start(dispatch);
  assert.equal(retried.thread_id, "thread-1");
  assert.equal(retried.turn_id, "turn-1");
  assert.equal(resolveCount, 2);
  assert.equal(
    appServer.calls.filter(([operation]) => operation === "startTurn").length,
    1,
  );
  await bridge.shutdown();
});

test("records turn-start stage and preserves missing versus false acceptance evidence", async () => {
  for (const evidence of [undefined, { dispatch_accepted: false }]) {
    const appServer = createFakeAppServer();
    const bridge = createAppServerExecutionBridge({
      adapter: appServer,
      resolveTask: ({ task_id: taskId }) => taskSpec(taskId),
    });
    const dispatch = { task_id: "A", dispatch_id: "dispatch-a", attempt: 1 };
    appServer.setThreadName = () => ({ ok: false, error: { code: "name_failed" } });
    await assert.rejects(bridge.start(dispatch));
    assert.equal(bridge.readTaskSession("A").start_turn_stage, "not_issued");
    assert.equal(bridge.readTaskSession("A").last_start_failure, null);
    appServer.startTurn = () => ({ ok: false, error: { code: "runtime_failed" }, evidence });
    await assert.rejects(bridge.start(dispatch));
    const session = bridge.readTaskSession("A");
    assert.equal(session.start_turn_stage, "issued");
    assert.equal(session.last_start_failure.dispatch_accepted, evidence ? false : null);
    appServer.startTurn = () => ({ ok: true, turn_id: "turn-accepted" });
    if (evidence) {
      await bridge.start(dispatch);
      assert.equal(bridge.readTaskSession("A").start_turn_stage, "accepted");
      assert.equal(bridge.readTaskSession("A").last_start_failure, null);
    } else {
      await assert.rejects(bridge.start({ ...dispatch, dispatch_id: "dispatch-next", attempt: 2 }),
        { code: "runtime_outcome_unknown" });
      assert.deepEqual(bridge.readTaskSession("A"), session);
    }
    await bridge.shutdown();
  }
});

test("a distinct dispatch cannot overwrite an in-flight start on the same session", async () => {
  const appServer = createFakeAppServer();
  let resolveStart;
  let startCount = 0;
  appServer.startTurn = () => {
    startCount += 1;
    return new Promise((resolve) => { resolveStart = resolve; });
  };
  const bridge = createAppServerExecutionBridge({
    adapter: appServer,
    resolveTask: ({ task_id: taskId }) => taskSpec(taskId),
  });
  const first = bridge.start({ task_id: "A", dispatch_id: "dispatch-first", attempt: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  const pending = bridge.readTaskSession("A");
  await assert.rejects(bridge.start({ task_id: "A", dispatch_id: "dispatch-next", attempt: 2 }),
    { code: "task_start_in_progress" });
  assert.deepEqual(bridge.readTaskSession("A"), pending);
  assert.equal(appServer.calls.some(([operation]) => operation === "resumeThread"), false);
  assert.equal(startCount, 1);
  resolveStart({ ok: true, turn_id: "turn-first" });
  await first;
  assert.equal(bridge.readTaskSession("A").start_turn_stage, "accepted");
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
