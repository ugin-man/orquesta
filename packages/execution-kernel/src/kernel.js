"use strict";

const crypto = require("node:crypto");

const TASK_STATES = Object.freeze([
  "pending",
  "eligible",
  "claimed",
  "dispatching",
  "running",
  "waiting_for_user",
  "waiting_for_dependency",
  "retry_queued",
  "verifying",
  "accepted",
  "failed",
  "cancelled",
]);
const TASK_STATE_SET = new Set(TASK_STATES);
const ACTIVE_STATES = new Set(["claimed", "dispatching", "running"]);
const TERMINAL_STATES = new Set(["accepted", "failed", "cancelled"]);
const TRANSITIONS = Object.freeze({
  dispatch_accepted: new Set(["claimed", "dispatching"]),
  turn_started: new Set(["claimed", "dispatching", "running"]),
  progress_observed: new Set(["running"]),
  model_observed: new Set(["dispatching", "running"]),
  runtime_error_observed: new Set(["dispatching", "running"]),
  user_input_required: new Set(["dispatching", "running"]),
  user_input_resolved: new Set(["waiting_for_user"]),
  turn_completed: new Set(["running"]),
  verification_accepted: new Set(["verifying"]),
  attempt_failed: new Set(["claimed", "dispatching", "running", "verifying"]),
  retry_due: new Set(["retry_queued"]),
  task_cancelled: new Set(TASK_STATES.filter((state) => !TERMINAL_STATES.has(state))),
  task_failed: new Set(TASK_STATES.filter((state) => !TERMINAL_STATES.has(state))),
});

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function nonempty(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function positiveInteger(value, field, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return value;
}

function timestamp(value, field, fallback = null) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${field} must be an ISO timestamp`);
  }
  return new Date(value).toISOString();
}

function uniqueStrings(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  return [...new Set(value.map((item, index) => nonempty(item, `${field}[${index}]`)))].sort();
}

function stableHash(prefix, parts) {
  const digest = crypto.createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 16);
  return `${prefix}-${digest}`;
}

function executionKeyFor({ taskId, executionRevision = 1, cycleId = "implementation-1" } = {}) {
  return stableHash("E", [
    nonempty(taskId, "taskId"),
    String(positiveInteger(executionRevision, "executionRevision", 1)),
    nonempty(cycleId, "cycleId"),
  ]);
}

function dispatchIdFor({
  taskId,
  executionRevision = 1,
  cycleId = "implementation-1",
  attempt = 1,
} = {}) {
  const executionKey = executionKeyFor({ taskId, executionRevision, cycleId });
  return stableHash("D", [executionKey, String(positiveInteger(attempt, "attempt", 1))]);
}

function normalizeTaskDefinition(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("task definition must be an object");
  }
  const taskId = nonempty(value.task_id ?? value.taskId, "task.task_id");
  const executionRevision = positiveInteger(
    value.execution_revision ?? value.executionRevision,
    "task.execution_revision",
    1,
  );
  const cycleId = nonempty(value.cycle_id ?? value.cycleId ?? "implementation-1", "task.cycle_id");
  const initialState = value.state ?? "pending";
  if (!TASK_STATE_SET.has(initialState)) throw new TypeError(`task ${taskId} has an invalid state`);
  const priority = value.priority === undefined || value.priority === null
    ? null
    : positiveInteger(value.priority, `task ${taskId}.priority`);
  return Object.freeze({
    task_id: taskId,
    dependencies: uniqueStrings(
      value.dependencies ?? value.depends_on ?? value.blocked_by_task_ids,
      `task ${taskId}.dependencies`,
    ),
    priority,
    created_at: timestamp(value.created_at, `task ${taskId}.created_at`),
    execution_revision: executionRevision,
    cycle_id: cycleId,
    execution_key: executionKeyFor({ taskId, executionRevision, cycleId }),
    initial_state: initialState,
  });
}

function createKernelState({ maxConcurrent = 1, updatedAt = null } = {}) {
  return {
    version: 1,
    revision: 0,
    max_concurrent: positiveInteger(maxConcurrent, "maxConcurrent", 1),
    tasks: {},
    applied_event_ids: [],
    recent_events: [],
    updated_at: timestamp(updatedAt, "updatedAt"),
  };
}

function normalizeState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("kernel state must be an object");
  }
  const state = clone(value);
  state.version = 1;
  state.revision = Number.isInteger(state.revision) && state.revision >= 0 ? state.revision : 0;
  state.max_concurrent = positiveInteger(state.max_concurrent, "state.max_concurrent", 1);
  state.tasks = state.tasks && typeof state.tasks === "object" && !Array.isArray(state.tasks)
    ? state.tasks
    : {};
  state.applied_event_ids = uniqueStrings(state.applied_event_ids, "state.applied_event_ids");
  state.recent_events = Array.isArray(state.recent_events) ? state.recent_events : [];
  state.updated_at = timestamp(state.updated_at, "state.updated_at");
  return state;
}

function assertAcyclic(definitions) {
  const byId = new Map(definitions.map((definition) => [definition.task_id, definition]));
  const visiting = new Set();
  const visited = new Set();

  function visit(taskId, trail) {
    if (visiting.has(taskId)) {
      throw new Error(`dependency_cycle:${[...trail, taskId].join("->")}`);
    }
    if (visited.has(taskId) || !byId.has(taskId)) return;
    visiting.add(taskId);
    const definition = byId.get(taskId);
    for (const dependency of definition.dependencies) visit(dependency, [...trail, taskId]);
    visiting.delete(taskId);
    visited.add(taskId);
  }

  for (const definition of definitions) visit(definition.task_id, []);
}

function dependencyStatus(state, record) {
  const missing = [];
  const unresolved = [];
  const terminalBlockers = [];
  for (const taskId of record.dependencies) {
    const dependency = state.tasks[taskId];
    if (!dependency) missing.push(taskId);
    else if (dependency.state === "accepted") continue;
    else if (dependency.state === "failed" || dependency.state === "cancelled") terminalBlockers.push(taskId);
    else unresolved.push(taskId);
  }
  return { missing, unresolved, terminalBlockers };
}

function refreshEligibility(state, now) {
  const next = clone(state);
  const observedAt = timestamp(now, "now");
  let changed = false;

  for (const record of Object.values(next.tasks)) {
    if (TERMINAL_STATES.has(record.state) || ACTIVE_STATES.has(record.state)
      || record.state === "verifying" || record.state === "waiting_for_user") {
      continue;
    }
    if (record.state === "retry_queued") {
      if (!record.retry_at || !observedAt || Date.parse(record.retry_at) > Date.parse(observedAt)) continue;
      record.retry_at = null;
    }
    const dependencies = dependencyStatus(next, record);
    const desired = dependencies.missing.length || dependencies.unresolved.length || dependencies.terminalBlockers.length
      ? "waiting_for_dependency"
      : "eligible";
    const blockerReason = dependencies.terminalBlockers.length
      ? "dependency_terminal_without_acceptance"
      : dependencies.missing.length
        ? "dependency_missing"
        : dependencies.unresolved.length
          ? "dependency_incomplete"
          : null;
    if (record.state !== desired || record.blocker_reason !== blockerReason) {
      record.state = desired;
      record.blocker_reason = blockerReason;
      changed = true;
    }
  }
  if (changed) {
    next.revision += 1;
    next.updated_at = observedAt ?? next.updated_at;
  }
  return next;
}

function reconcileTasks(value, taskDefinitions, { now = null } = {}) {
  const state = normalizeState(value);
  if (!Array.isArray(taskDefinitions)) throw new TypeError("taskDefinitions must be an array");
  const definitions = taskDefinitions.map(normalizeTaskDefinition);
  assertAcyclic(definitions);
  const seenTaskIds = new Set();
  let changed = false;

  for (const definition of definitions) {
    if (seenTaskIds.has(definition.task_id)) throw new Error(`duplicate_task:${definition.task_id}`);
    seenTaskIds.add(definition.task_id);
    const current = state.tasks[definition.task_id];
    if (!current) {
      state.tasks[definition.task_id] = {
        task_id: definition.task_id,
        dependencies: [...definition.dependencies],
        priority: definition.priority,
        created_at: definition.created_at,
        execution_revision: definition.execution_revision,
        cycle_id: definition.cycle_id,
        execution_key: definition.execution_key,
        state: definition.initial_state,
        blocker_reason: null,
        attempt: 0,
        dispatch_id: null,
        correlation_id: null,
        thread_id: null,
        turn_id: null,
        retry_at: null,
        last_error: null,
        actual_model: null,
        actual_model_evidence_ref: null,
        model_evidence: null,
        runtime_profile: null,
        runtime_status: null,
        claimed_at: null,
        dispatch_accepted_at: null,
        turn_started_at: null,
        last_progress_at: null,
        finished_at: TERMINAL_STATES.has(definition.initial_state) ? timestamp(now, "now") : null,
      };
      changed = true;
      continue;
    }
    const identityChanged = current.execution_key !== definition.execution_key;
    if (identityChanged && !TERMINAL_STATES.has(current.state)) {
      throw new Error(`active_execution_identity_changed:${definition.task_id}`);
    }
    const nextMetadata = {
      dependencies: [...definition.dependencies],
      priority: definition.priority,
      created_at: definition.created_at,
    };
    if (JSON.stringify({
      dependencies: current.dependencies,
      priority: current.priority,
      created_at: current.created_at,
    }) !== JSON.stringify(nextMetadata)) {
      Object.assign(current, nextMetadata);
      changed = true;
    }
  }

  if (changed) {
    state.revision += 1;
    state.updated_at = timestamp(now, "now", state.updated_at);
  }
  return refreshEligibility(state, now);
}

function activeCount(state) {
  return Object.values(state.tasks).filter((task) => ACTIVE_STATES.has(task.state)).length;
}

function candidateCompare(left, right) {
  const leftPriority = left.priority ?? Number.MAX_SAFE_INTEGER;
  const rightPriority = right.priority ?? Number.MAX_SAFE_INTEGER;
  if (leftPriority !== rightPriority) return leftPriority - rightPriority;
  const leftCreated = left.created_at ? Date.parse(left.created_at) : Number.MAX_SAFE_INTEGER;
  const rightCreated = right.created_at ? Date.parse(right.created_at) : Number.MAX_SAFE_INTEGER;
  if (leftCreated !== rightCreated) return leftCreated - rightCreated;
  return left.task_id.localeCompare(right.task_id);
}

function selectDispatches(value, { now = null, limit = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(limit) || limit < 0) throw new TypeError("limit must be a non-negative integer");
  const state = refreshEligibility(normalizeState(value), now);
  const slots = Math.max(Math.min(state.max_concurrent - activeCount(state), limit), 0);
  const dispatches = Object.values(state.tasks)
    .filter((task) => task.state === "eligible")
    .sort(candidateCompare)
    .slice(0, slots)
    .map((task) => ({
      task_id: task.task_id,
      execution_key: task.execution_key,
      next_attempt: task.attempt + 1,
    }));
  return { state, dispatches, available_slots: slots };
}

function claimDispatch(value, { taskId, now = null } = {}) {
  const state = refreshEligibility(normalizeState(value), now);
  const normalizedTaskId = nonempty(taskId, "taskId");
  const task = state.tasks[normalizedTaskId];
  if (!task) throw new Error(`task_not_found:${normalizedTaskId}`);
  if (ACTIVE_STATES.has(task.state)) {
    return {
      state,
      dispatch: {
        task_id: task.task_id,
        execution_key: task.execution_key,
        dispatch_id: task.dispatch_id,
        attempt: task.attempt,
      },
      claimed: false,
    };
  }
  if (task.state !== "eligible") throw new Error(`task_not_eligible:${normalizedTaskId}:${task.state}`);
  if (activeCount(state) >= state.max_concurrent) throw new Error("no_available_slots");

  task.attempt += 1;
  task.dispatch_id = dispatchIdFor({
    taskId: task.task_id,
    executionRevision: task.execution_revision,
    cycleId: task.cycle_id,
    attempt: task.attempt,
  });
  task.state = "claimed";
  task.claimed_at = timestamp(now, "now");
  task.dispatch_accepted_at = null;
  task.turn_started_at = null;
  task.last_progress_at = null;
  task.last_error = null;
  task.correlation_id = null;
  task.thread_id = null;
  task.turn_id = null;
  task.actual_model = null;
  task.actual_model_evidence_ref = null;
  task.model_evidence = null;
  task.runtime_profile = null;
  task.runtime_status = null;
  task.blocker_reason = null;
  state.revision += 1;
  state.updated_at = timestamp(now, "now", state.updated_at);
  return {
    state,
    dispatch: {
      task_id: task.task_id,
      execution_key: task.execution_key,
      dispatch_id: task.dispatch_id,
      attempt: task.attempt,
    },
    claimed: true,
  };
}

function eventForLog(event) {
  return {
    event_id: event.event_id,
    type: event.type,
    task_id: event.task_id,
    dispatch_id: event.dispatch_id ?? null,
    correlation_id: event.correlation_id ?? null,
    thread_id: event.thread_id ?? null,
    turn_id: event.turn_id ?? null,
    observed_at: event.observed_at,
  };
}

function applyKernelEvent(value, input) {
  const state = normalizeState(value);
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("event must be an object");
  }
  const event = {
    ...clone(input),
    event_id: nonempty(input.event_id, "event.event_id"),
    type: nonempty(input.type, "event.type"),
    task_id: nonempty(input.task_id, "event.task_id"),
    observed_at: timestamp(input.observed_at, "event.observed_at"),
  };
  if (state.applied_event_ids.includes(event.event_id)) return state;
  const task = state.tasks[event.task_id];
  if (!task) throw new Error(`task_not_found:${event.task_id}`);
  if (!TRANSITIONS[event.type]) throw new Error(`unsupported_event:${event.type}`);
  if (!TRANSITIONS[event.type].has(task.state)) {
    throw new Error(`invalid_transition:${task.state}:${event.type}`);
  }
  if (event.dispatch_id && task.dispatch_id && event.dispatch_id !== task.dispatch_id) {
    throw new Error(`stale_dispatch:${event.dispatch_id}`);
  }
  if (event.thread_id && task.thread_id && event.thread_id !== task.thread_id) {
    throw new Error(`runtime_thread_mismatch:${event.thread_id}`);
  }
  if (event.turn_id && task.turn_id && event.turn_id !== task.turn_id) {
    throw new Error(`runtime_turn_mismatch:${event.turn_id}`);
  }

  if (event.type === "dispatch_accepted") {
    task.state = "dispatching";
    task.dispatch_accepted_at = event.observed_at;
    task.correlation_id = event.correlation_id
      ? nonempty(event.correlation_id, "event.correlation_id")
      : task.correlation_id;
    task.thread_id = event.thread_id
      ? nonempty(event.thread_id, "event.thread_id")
      : task.thread_id;
    task.turn_id = event.turn_id
      ? nonempty(event.turn_id, "event.turn_id")
      : task.turn_id;
    task.model_evidence = event.model_evidence
      ? clone(event.model_evidence)
      : task.model_evidence;
    task.runtime_profile = event.runtime_profile
      ? clone(event.runtime_profile)
      : task.runtime_profile;
  } else if (event.type === "turn_started") {
    task.state = "running";
    task.turn_started_at = event.observed_at;
  } else if (event.type === "progress_observed") {
    task.last_progress_at = event.observed_at;
  } else if (event.type === "model_observed") {
    task.actual_model = nonempty(event.model, "event.model");
    task.actual_model_evidence_ref = event.event_id;
  } else if (event.type === "runtime_error_observed") {
    task.last_error = nonempty(event.error ?? "runtime_error", "event.error");
  } else if (event.type === "user_input_required") {
    task.state = "waiting_for_user";
    task.blocker_reason = nonempty(event.reason ?? "user_input_required", "event.reason");
  } else if (event.type === "user_input_resolved") {
    task.state = "pending";
    task.blocker_reason = null;
  } else if (event.type === "turn_completed") {
    task.state = "verifying";
    task.last_progress_at = event.observed_at;
    task.runtime_status = event.status
      ? nonempty(event.status, "event.status")
      : "completed";
  } else if (event.type === "verification_accepted") {
    task.state = "accepted";
    task.finished_at = event.observed_at;
  } else if (event.type === "attempt_failed") {
    task.state = "retry_queued";
    task.retry_at = timestamp(event.retry_at, "event.retry_at");
    task.last_error = nonempty(event.error ?? "attempt_failed", "event.error");
  } else if (event.type === "retry_due") {
    if (task.retry_at && Date.parse(event.observed_at) < Date.parse(task.retry_at)) {
      throw new Error(`retry_not_due:${task.task_id}`);
    }
    task.state = "pending";
    task.retry_at = null;
  } else if (event.type === "task_cancelled") {
    task.state = "cancelled";
    task.finished_at = event.observed_at;
  } else if (event.type === "task_failed") {
    task.state = "failed";
    task.last_error = nonempty(event.error ?? "task_failed", "event.error");
    task.finished_at = event.observed_at;
  }

  state.applied_event_ids.push(event.event_id);
  state.recent_events.push(eventForLog(event));
  state.recent_events = state.recent_events.slice(-256);
  state.revision += 1;
  state.updated_at = event.observed_at;
  return refreshEligibility(state, event.observed_at);
}

function retryDelayMs(attempt, { baseMs = 10_000, maxMs = 300_000 } = {}) {
  const normalizedAttempt = positiveInteger(attempt, "attempt");
  if (!Number.isInteger(baseMs) || baseMs < 1) throw new TypeError("baseMs must be a positive integer");
  if (!Number.isInteger(maxMs) || maxMs < 1) throw new TypeError("maxMs must be a positive integer");
  return Math.min(baseMs * (2 ** Math.min(normalizedAttempt - 1, 30)), maxMs);
}

module.exports = {
  ACTIVE_STATES,
  TERMINAL_STATES,
  TASK_STATES,
  applyKernelEvent,
  claimDispatch,
  createKernelState,
  dispatchIdFor,
  executionKeyFor,
  normalizeTaskDefinition,
  reconcileTasks,
  retryDelayMs,
  selectDispatches,
};
