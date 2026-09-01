"use strict";

const {
  applyKernelEvent,
  claimDispatch,
  dispatchIdFor,
  reconcileTasks,
  retryDelayMs,
  selectDispatches,
} = require("./kernel");

function executionKernelEnabled(environment = process.env) {
  const value = String(environment.ORQUESTA_EXECUTION_KERNEL_V2 ?? "").trim().toLowerCase();
  return ["1", "true", "on", "enabled"].includes(value);
}

function addMilliseconds(timestamp, milliseconds) {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

function eventId(type, dispatch, suffix = "") {
  return `${dispatch.dispatch_id}:${type}${suffix ? `:${suffix}` : ""}`;
}

function planDispatchTick({
  state,
  tasks,
  now,
  limit = Number.MAX_SAFE_INTEGER,
} = {}) {
  const observedAt = new Date(now ?? Date.now()).toISOString();
  const reconciled = reconcileTasks(state, tasks, { now: observedAt });
  const selection = selectDispatches(reconciled, { now: observedAt, limit });
  return {
    state: selection.state,
    dispatches: selection.dispatches.map((candidate) => {
      const task = selection.state.tasks[candidate.task_id];
      return {
        task_id: candidate.task_id,
        execution_key: candidate.execution_key,
        dispatch_id: dispatchIdFor({
          taskId: task.task_id,
          executionRevision: task.execution_revision,
          cycleId: task.cycle_id,
          attempt: candidate.next_attempt,
        }),
        attempt: candidate.next_attempt,
      };
    }),
    considered: selection.dispatches.length,
    available_slots: selection.available_slots,
    observed_at: observedAt,
  };
}

async function runDispatchTick({
  state,
  tasks,
  adapter,
  now,
  limit = Number.MAX_SAFE_INTEGER,
  retry = {},
} = {}) {
  if (!adapter || typeof adapter.start !== "function") {
    throw new TypeError("adapter.start is required");
  }
  const observedAt = new Date(now ?? Date.now()).toISOString();
  let next = reconcileTasks(state, tasks, { now: observedAt });
  const selection = selectDispatches(next, { now: observedAt, limit });
  next = selection.state;
  const claims = [];

  for (const candidate of selection.dispatches) {
    const result = claimDispatch(next, { taskId: candidate.task_id, now: observedAt });
    next = result.state;
    if (result.claimed) claims.push(result.dispatch);
  }

  const outcomes = await Promise.allSettled(claims.map((dispatch) => adapter.start({ ...dispatch })));
  const results = [];
  for (let index = 0; index < outcomes.length; index += 1) {
    const outcome = outcomes[index];
    const dispatch = claims[index];
    if (outcome.status === "fulfilled") {
      const acceptedAt = outcome.value?.accepted_at
        ? new Date(outcome.value.accepted_at).toISOString()
        : observedAt;
      next = applyKernelEvent(next, {
        event_id: eventId("dispatch_accepted", dispatch),
        type: "dispatch_accepted",
        task_id: dispatch.task_id,
        dispatch_id: dispatch.dispatch_id,
        correlation_id: outcome.value?.correlation_id ?? null,
        thread_id: outcome.value?.thread_id ?? null,
        turn_id: outcome.value?.turn_id ?? null,
        model_evidence: outcome.value?.model_evidence ?? null,
        runtime_profile: outcome.value?.runtime_profile ?? null,
        observed_at: acceptedAt,
      });
      results.push({
        ...dispatch,
        status: "dispatching",
        accepted_at: acceptedAt,
        correlation_id: outcome.value?.correlation_id ?? null,
        thread_id: outcome.value?.thread_id ?? null,
        turn_id: outcome.value?.turn_id ?? null,
        model_evidence: outcome.value?.model_evidence ?? null,
        runtime_profile: outcome.value?.runtime_profile ?? null,
      });
    } else {
      const delay = retryDelayMs(dispatch.attempt, retry);
      const retryAt = addMilliseconds(observedAt, delay);
      next = applyKernelEvent(next, {
        event_id: eventId("attempt_failed", dispatch),
        type: "attempt_failed",
        task_id: dispatch.task_id,
        dispatch_id: dispatch.dispatch_id,
        observed_at: observedAt,
        retry_at: retryAt,
        error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
      });
      results.push({ ...dispatch, status: "retry_queued", retry_at: retryAt });
    }
  }

  return {
    state: next,
    results,
    considered: selection.dispatches.length,
    available_slots_before_claim: selection.available_slots,
  };
}

module.exports = { executionKernelEnabled, planDispatchTick, runDispatchTick };
