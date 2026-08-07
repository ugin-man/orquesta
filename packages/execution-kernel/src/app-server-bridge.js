"use strict";

const { retryDelayMs } = require("./kernel");

function nonempty(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function adapterFailure(result, operation) {
  const message = result?.error?.message || `${operation} failed`;
  const error = new Error(message);
  error.code = result?.error?.code || "codex_adapter_failed";
  error.operation = operation;
  return error;
}

function createAppServerExecutionBridge({
  adapter,
  resolveTask,
  maxTasks = 2,
  clock = () => new Date().toISOString(),
  retry = {},
  onDiagnostic = () => {},
  subscriptionCorrelationId = "orquesta-execution-kernel:subscribe",
} = {}) {
  if (!adapter || typeof adapter.createThread !== "function"
      || typeof adapter.startTurn !== "function"
      || typeof adapter.subscribeEvents !== "function") {
    throw new TypeError("a Codex App Server adapter is required");
  }
  if (typeof resolveTask !== "function") {
    throw new TypeError("resolveTask is required");
  }
  if (!Number.isInteger(maxTasks) || maxTasks < 1) {
    throw new TypeError("maxTasks must be a positive integer");
  }

  const taskIds = new Set();
  const taskSessions = new Map();
  const dispatches = new Map();
  const byCorrelation = new Map();
  const queuedEvents = [];
  const listeners = new Set();
  let subscriptionPromise = null;
  let adapterSubscription = null;
  let eventSequence = 0;

  function observedAt() {
    return new Date(clock()).toISOString();
  }

  function emit(event) {
    if (listeners.size === 0) {
      queuedEvents.push(event);
      return;
    }
    for (const listener of listeners) listener(clone(event));
  }

  function runtimeIdentityMatches(event, record) {
    if (event.thread_id && record.thread_id && event.thread_id !== record.thread_id) {
      onDiagnostic({
        type: "runtime_thread_mismatch",
        dispatch_id: record.dispatch_id,
        expected: record.thread_id,
        observed: event.thread_id,
      });
      return false;
    }
    if (event.turn_id && record.turn_id && event.turn_id !== record.turn_id) {
      onDiagnostic({
        type: "runtime_turn_mismatch",
        dispatch_id: record.dispatch_id,
        expected: record.turn_id,
        observed: event.turn_id,
      });
      return false;
    }
    return true;
  }

  function baseKernelEvent(type, event, record, suffix = "") {
    eventSequence += 1;
    return {
      event_id: `${record.dispatch_id}:${type}${suffix ? `:${suffix}` : ""}`,
      type,
      task_id: record.task_id,
      dispatch_id: record.dispatch_id,
      correlation_id: record.correlation_id,
      thread_id: event.thread_id ?? record.thread_id,
      turn_id: event.turn_id ?? record.turn_id,
      observed_at: observedAt(),
    };
  }

  function handleAdapterEvent(event) {
    if (!event || event.type === "dispatch_accepted") return;
    const record = byCorrelation.get(event.correlation_id);
    if (!record || !runtimeIdentityMatches(event, record)) return;

    if (event.type === "turn_started") {
      record.turn_started = true;
      emit(baseKernelEvent("turn_started", event, record));
      return;
    }
    if (event.type === "progress_observed") {
      const suffix = [
        event.event_method || "progress",
        event.item_id || String(eventSequence + 1),
      ].join(":");
      emit(baseKernelEvent("progress_observed", event, record, suffix));
      return;
    }
    if (event.type === "model_observed" && event.model) {
      emit({
        ...baseKernelEvent("model_observed", event, record, event.model),
        model: event.model,
      });
      return;
    }
    if (event.type === "runtime_error") {
      emit({
        ...baseKernelEvent("runtime_error_observed", event, record, String(eventSequence + 1)),
        error: event.will_retry ? "codex_runtime_error_retrying" : "codex_runtime_error",
        will_retry: Boolean(event.will_retry),
      });
      return;
    }
    if (event.type === "approval_requested") {
      emit({
        ...baseKernelEvent("user_input_required", event, record, event.request_id || "approval"),
        reason: "codex_approval_required",
        approval: {
          request_id: event.request_id ?? null,
          method: event.method ?? null,
          requested_effect: event.requested_effect ?? null,
          response_options: event.response_options ?? [],
        },
      });
      return;
    }
    if (event.type === "turn_completed") {
      record.completed = true;
      if (event.status === "completed") {
        emit({
          ...baseKernelEvent("turn_completed", event, record),
          status: event.status,
        });
      } else {
        const completedAt = observedAt();
        emit({
          ...baseKernelEvent("attempt_failed", event, record),
          observed_at: completedAt,
          retry_at: new Date(
            Date.parse(completedAt) + retryDelayMs(record.attempt, retry),
          ).toISOString(),
          error: `codex_turn_${event.status || "failed"}`,
        });
      }
    }
  }

  async function ensureSubscribed() {
    if (!subscriptionPromise) {
      subscriptionPromise = Promise.resolve(adapter.subscribeEvents({
        correlationId: subscriptionCorrelationId,
        listener: handleAdapterEvent,
      })).then((result) => {
        if (!result?.ok) throw adapterFailure(result, "subscribeEvents");
        adapterSubscription = result.subscription ?? null;
        return result;
      });
    }
    return subscriptionPromise;
  }

  async function requiredResult(operation, promise) {
    const result = await promise;
    if (!result?.ok) throw adapterFailure(result, operation);
    return result;
  }

  async function start(dispatch) {
    await ensureSubscribed();
    const taskId = nonempty(dispatch?.task_id, "dispatch.task_id");
    const dispatchId = nonempty(dispatch?.dispatch_id, "dispatch.dispatch_id");
    const attempt = Number(dispatch?.attempt);
    if (!Number.isInteger(attempt) || attempt < 1) {
      throw new TypeError("dispatch.attempt must be a positive integer");
    }
    if (dispatches.has(dispatchId)) {
      throw new Error(`duplicate_dispatch:${dispatchId}`);
    }
    if (!taskIds.has(taskId) && taskIds.size >= maxTasks) {
      throw new Error(`app_server_proof_task_limit:${maxTasks}`);
    }
    taskIds.add(taskId);

    const spec = await resolveTask(clone(dispatch));
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
      throw new TypeError(`resolveTask returned an invalid task for ${taskId}`);
    }
    const cwd = nonempty(spec.cwd, `task ${taskId}.cwd`);
    let session = taskSessions.get(taskId);

    if (!session) {
      const threadCorrelationId = `orquesta-execution:${dispatchId}:thread`;
      const created = await requiredResult("createThread", adapter.createThread({
        correlationId: threadCorrelationId,
        recommendedModel: spec.recommended_model,
        requestedModel: spec.requested_model,
        params: {
          cwd,
          sandbox: "read-only",
          approvalPolicy: "never",
          ...(spec.thread_params || {}),
        },
      }));
      session = {
        thread_id: nonempty(created.thread_id, "createThread.thread_id"),
        accepted_turns: 0,
        runtime_profile: created.runtime_profile ?? null,
        model_evidence: created.model_evidence ?? null,
      };
      taskSessions.set(taskId, session);

      if (spec.thread_name && typeof adapter.setThreadName === "function") {
        await requiredResult("setThreadName", adapter.setThreadName({
          correlationId: `orquesta-execution:${dispatchId}:name`,
          threadId: session.thread_id,
          name: nonempty(spec.thread_name, `task ${taskId}.thread_name`),
        }));
      }
    } else if (typeof adapter.resumeThread === "function") {
      await requiredResult("resumeThread", adapter.resumeThread({
        correlationId: `orquesta-execution:${dispatchId}:resume`,
        threadId: session.thread_id,
        recommendedModel: spec.recommended_model,
        requestedModel: spec.requested_model,
        params: {
          cwd,
          sandbox: "read-only",
          approvalPolicy: "never",
          ...(spec.thread_params || {}),
        },
      }));
    }

    const isContinuation = session.accepted_turns > 0;
    const prompt = isContinuation
      ? nonempty(
        spec.continuation_prompt
          ?? "Continue the assigned task from the existing thread context. Do not repeat completed work.",
        `task ${taskId}.continuation_prompt`,
      )
      : nonempty(spec.prompt, `task ${taskId}.prompt`);
    const correlationId = `orquesta-execution:${dispatchId}`;
    const record = {
      task_id: taskId,
      dispatch_id: dispatchId,
      execution_key: dispatch.execution_key ?? null,
      attempt,
      correlation_id: correlationId,
      thread_id: session.thread_id,
      turn_id: null,
      continuation: isContinuation,
      turn_started: false,
      completed: false,
    };
    dispatches.set(dispatchId, record);
    byCorrelation.set(correlationId, record);

    let started;
    try {
      started = await requiredResult("startTurn", adapter.startTurn({
        correlationId,
        threadId: session.thread_id,
        input: [{ type: "text", text: prompt, text_elements: [] }],
        params: { ...(spec.turn_params || {}) },
      }));
    } catch (error) {
      dispatches.delete(dispatchId);
      byCorrelation.delete(correlationId);
      throw error;
    }
    record.turn_id = nonempty(started.turn_id, "startTurn.turn_id");
    session.accepted_turns += 1;

    return {
      accepted_at: observedAt(),
      correlation_id: correlationId,
      thread_id: record.thread_id,
      turn_id: record.turn_id,
      runtime_profile: clone(session.runtime_profile),
      model_evidence: clone(session.model_evidence),
      continuation: isContinuation,
    };
  }

  function subscribeKernelEvents({ listener, replayQueued = true } = {}) {
    if (typeof listener !== "function") throw new TypeError("listener is required");
    listeners.add(listener);
    if (replayQueued) {
      const pending = queuedEvents.splice(0, queuedEvents.length);
      for (const event of pending) listener(clone(event));
    }
    return {
      unsubscribe() {
        listeners.delete(listener);
      },
    };
  }

  function drainKernelEvents() {
    return queuedEvents.splice(0, queuedEvents.length).map(clone);
  }

  function readDispatch(dispatchId) {
    return clone(dispatches.get(dispatchId) ?? null);
  }

  function readTaskSession(taskId) {
    return clone(taskSessions.get(taskId) ?? null);
  }

  async function interrupt(dispatchId) {
    const record = dispatches.get(dispatchId);
    if (!record) throw new Error(`dispatch_not_found:${dispatchId}`);
    return requiredResult("interruptTurn", adapter.interruptTurn({
      correlationId: `${record.correlation_id}:interrupt`,
      threadId: record.thread_id,
      turnId: record.turn_id,
    }));
  }

  async function shutdown() {
    adapterSubscription?.unsubscribe?.();
    listeners.clear();
    queuedEvents.length = 0;
    if (typeof adapter.shutdown === "function") {
      return adapter.shutdown({
        correlationId: "orquesta-execution-kernel:shutdown",
      });
    }
    return null;
  }

  return Object.freeze({
    start,
    subscribeKernelEvents,
    drainKernelEvents,
    readDispatch,
    readTaskSession,
    interrupt,
    shutdown,
  });
}

module.exports = { createAppServerExecutionBridge };
