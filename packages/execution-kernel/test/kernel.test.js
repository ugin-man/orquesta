"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  applyKernelEvent,
  claimDispatch,
  createKernelState,
  dispatchIdFor,
  executionKernelEnabled,
  planDispatchTick,
  reconcileTasks,
  retryDelayMs,
  runDispatchTick,
  selectDispatches,
} = require("../src");

const T0 = "2026-07-31T00:00:00.000Z";

function task(taskId, overrides = {}) {
  return {
    task_id: taskId,
    created_at: T0,
    ...overrides,
  };
}

function event(type, taskId, dispatchId, overrides = {}) {
  return {
    event_id: `${dispatchId}:${type}`,
    type,
    task_id: taskId,
    dispatch_id: dispatchId,
    observed_at: T0,
    ...overrides,
  };
}

test("feature flag is explicit and disabled by default", () => {
  assert.equal(executionKernelEnabled({}), false);
  assert.equal(executionKernelEnabled({ ORQUESTA_EXECUTION_KERNEL_V2: "1" }), true);
  assert.equal(executionKernelEnabled({ ORQUESTA_EXECUTION_KERNEL_V2: "enabled" }), true);
  assert.equal(executionKernelEnabled({ ORQUESTA_EXECUTION_KERNEL_V2: "no" }), false);
});

test("reconcile exposes only dependency-free work and releases dependents immediately", () => {
  let state = reconcileTasks(createKernelState({ maxConcurrent: 2 }), [
    task("T1"),
    task("T2", { dependencies: ["T1"] }),
  ], { now: T0 });
  assert.equal(state.tasks.T1.state, "eligible");
  assert.equal(state.tasks.T2.state, "waiting_for_dependency");

  let claim = claimDispatch(state, { taskId: "T1", now: T0 });
  state = claim.state;
  const dispatchId = claim.dispatch.dispatch_id;
  state = applyKernelEvent(state, event("turn_started", "T1", dispatchId));
  state = applyKernelEvent(state, event("turn_completed", "T1", dispatchId));
  state = applyKernelEvent(state, event("verification_accepted", "T1", dispatchId));

  assert.equal(state.tasks.T1.state, "accepted");
  assert.equal(state.tasks.T2.state, "eligible");
  assert.deepEqual(selectDispatches(state, { now: T0 }).dispatches.map((item) => item.task_id), ["T2"]);
});

test("claiming is capacity bounded and idempotent for an active execution", () => {
  let state = reconcileTasks(createKernelState({ maxConcurrent: 1 }), [task("T1"), task("T2")], { now: T0 });
  const first = claimDispatch(state, { taskId: "T1", now: T0 });
  state = first.state;
  assert.equal(first.claimed, true);
  assert.equal(first.dispatch.dispatch_id, dispatchIdFor({ taskId: "T1", attempt: 1 }));

  const duplicate = claimDispatch(state, { taskId: "T1", now: T0 });
  assert.equal(duplicate.claimed, false);
  assert.equal(duplicate.dispatch.dispatch_id, first.dispatch.dispatch_id);
  assert.throws(() => claimDispatch(state, { taskId: "T2", now: T0 }), /no_available_slots/);
});

test("duplicate runtime event is applied once", () => {
  let state = reconcileTasks(createKernelState(), [task("T1")], { now: T0 });
  const claimed = claimDispatch(state, { taskId: "T1", now: T0 });
  state = claimed.state;
  const runtimeEvent = event("dispatch_accepted", "T1", claimed.dispatch.dispatch_id);
  const once = applyKernelEvent(state, runtimeEvent);
  const twice = applyKernelEvent(once, runtimeEvent);
  assert.deepEqual(twice, once);
  assert.equal(once.revision, state.revision + 1);
});

test("pure operations do not mutate their input state", () => {
  const original = reconcileTasks(createKernelState(), [task("T1")], { now: T0 });
  const snapshot = JSON.stringify(original);
  claimDispatch(original, { taskId: "T1", now: T0 });
  assert.equal(JSON.stringify(original), snapshot);
});

test("stale dispatch events cannot mutate a newer attempt", () => {
  let state = reconcileTasks(createKernelState(), [task("T1")], { now: T0 });
  const claimed = claimDispatch(state, { taskId: "T1", now: T0 });
  state = claimed.state;
  assert.throws(() => applyKernelEvent(state, event("turn_started", "T1", "D-stale")), /stale_dispatch/);
});

test("retry is not eligible before its due time and uses a new attempt id", () => {
  let state = reconcileTasks(createKernelState(), [task("T1")], { now: T0 });
  const first = claimDispatch(state, { taskId: "T1", now: T0 });
  state = applyKernelEvent(first.state, event("attempt_failed", "T1", first.dispatch.dispatch_id, {
    retry_at: "2026-07-31T00:00:10.000Z",
    error: "temporary",
  }));
  assert.equal(state.tasks.T1.state, "retry_queued");
  assert.equal(selectDispatches(state, { now: "2026-07-31T00:00:09.000Z" }).dispatches.length, 0);

  state = applyKernelEvent(state, event("retry_due", "T1", first.dispatch.dispatch_id, {
    event_id: "retry:T1:1",
    observed_at: "2026-07-31T00:00:10.000Z",
  }));
  const second = claimDispatch(state, { taskId: "T1", now: "2026-07-31T00:00:10.000Z" });
  assert.equal(second.dispatch.attempt, 2);
  assert.notEqual(second.dispatch.dispatch_id, first.dispatch.dispatch_id);
  assert.equal(retryDelayMs(1), 10_000);
  assert.equal(retryDelayMs(10), 300_000);
});

test("dependency cycles are rejected before dispatch", () => {
  assert.throws(() => reconcileTasks(createKernelState(), [
    task("T1", { dependencies: ["T2"] }),
    task("T2", { dependencies: ["T1"] }),
  ], { now: T0 }), /dependency_cycle/);
});

test("dispatch tick claims all slots before concurrently calling the adapter", async () => {
  const starts = [];
  const adapter = {
    async start(dispatch) {
      starts.push(dispatch);
      return { accepted_at: T0 };
    },
  };
  const result = await runDispatchTick({
    state: createKernelState({ maxConcurrent: 2 }),
    tasks: [task("T2", { priority: 2 }), task("T1", { priority: 1 }), task("T3", { priority: 3 })],
    adapter,
    now: T0,
  });
  assert.deepEqual(starts.map((item) => item.task_id), ["T1", "T2"]);
  assert.equal(result.state.tasks.T1.state, "dispatching");
  assert.equal(result.state.tasks.T2.state, "dispatching");
  assert.equal(result.state.tasks.T3.state, "eligible");
});

test("shadow planning is pure, dependency-aware, and never calls an adapter", () => {
  const initial = createKernelState({ maxConcurrent: 2 });
  const snapshot = JSON.stringify(initial);
  const result = planDispatchTick({
    state: initial,
    tasks: [
      task("neutral-3", { dependencies: ["neutral-1"], priority: 1 }),
      task("neutral-2", { priority: 3 }),
      task("neutral-1", { priority: 2 }),
      task("neutral-4", { dependencies: ["missing-1"], priority: 1 }),
    ],
    now: T0,
  });

  assert.equal(JSON.stringify(initial), snapshot);
  assert.deepEqual(result.dispatches.map((item) => item.task_id), ["neutral-1", "neutral-2"]);
  assert.equal(result.state.tasks["neutral-3"].state, "waiting_for_dependency");
  assert.equal(result.state.tasks["neutral-4"].blocker_reason, "dependency_missing");
  assert.equal(result.dispatches[0].dispatch_id, dispatchIdFor({ taskId: "neutral-1", attempt: 1 }));
});

test("adapter failures enter bounded exponential retry", async () => {
  const result = await runDispatchTick({
    state: createKernelState(),
    tasks: [task("T1")],
    adapter: { async start() { throw new Error("offline"); } },
    now: T0,
  });
  assert.equal(result.state.tasks.T1.state, "retry_queued");
  assert.equal(result.state.tasks.T1.retry_at, "2026-07-31T00:00:10.000Z");
  assert.match(result.state.tasks.T1.last_error, /offline/);
});

test("cancelling an active task releases capacity and keeps dependents blocked", () => {
  let state = reconcileTasks(createKernelState({ maxConcurrent: 1 }), [
    task("T1"),
    task("T2"),
    task("T3", { dependencies: ["T1"] }),
  ], { now: T0 });
  const claimed = claimDispatch(state, { taskId: "T1", now: T0 });
  state = applyKernelEvent(claimed.state, event("task_cancelled", "T1", claimed.dispatch.dispatch_id));
  assert.equal(state.tasks.T1.state, "cancelled");
  assert.equal(state.tasks.T3.state, "waiting_for_dependency");
  assert.equal(state.tasks.T3.blocker_reason, "dependency_terminal_without_acceptance");
  assert.deepEqual(selectDispatches(state, { now: T0 }).dispatches.map((item) => item.task_id), ["T2"]);
});

test("user-input wait releases the execution slot without accepting the task", () => {
  let state = reconcileTasks(createKernelState({ maxConcurrent: 1 }), [task("T1"), task("T2")], { now: T0 });
  const claimed = claimDispatch(state, { taskId: "T1", now: T0 });
  state = applyKernelEvent(claimed.state, event("turn_started", "T1", claimed.dispatch.dispatch_id));
  state = applyKernelEvent(state, event("user_input_required", "T1", claimed.dispatch.dispatch_id, {
    reason: "approval_required",
  }));
  assert.equal(state.tasks.T1.state, "waiting_for_user");
  assert.deepEqual(selectDispatches(state, { now: T0 }).dispatches.map((item) => item.task_id), ["T2"]);
});
