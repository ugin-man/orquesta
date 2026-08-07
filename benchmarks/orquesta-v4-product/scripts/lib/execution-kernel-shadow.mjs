import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const ACCEPTED_TASK_STATES = new Set(["accepted", "completed"]);
const FAILED_TASK_STATES = new Set(["failed", "rejected"]);
const CANCELLED_TASK_STATES = new Set(["cancelled", "superseded"]);
const ACTIVE_KERNEL_STATES = new Set(["claimed", "dispatching", "running"]);

function initialKernelState(task, requested) {
  if (requested) return "pending";
  if (ACCEPTED_TASK_STATES.has(task?.state)) return "accepted";
  if (FAILED_TASK_STATES.has(task?.state)) return "failed";
  if (CANCELLED_TASK_STATES.has(task?.state)) return "cancelled";
  return "waiting_for_user";
}

function compareTasks(left, right) {
  const leftPriority = Number.isInteger(left.priority) ? left.priority : Number.MAX_SAFE_INTEGER;
  const rightPriority = Number.isInteger(right.priority) ? right.priority : Number.MAX_SAFE_INTEGER;
  if (leftPriority !== rightPriority) return leftPriority - rightPriority;
  const leftCreated = left.created_at ? Date.parse(left.created_at) : Number.MAX_SAFE_INTEGER;
  const rightCreated = right.created_at ? Date.parse(right.created_at) : Number.MAX_SAFE_INTEGER;
  if (leftCreated !== rightCreated) return leftCreated - rightCreated;
  return left.task_id.localeCompare(right.task_id);
}

async function readTasks(workspaceRoot) {
  const file = path.join(workspaceRoot, ".orquesta", "state", "tasks.json");
  const state = JSON.parse(await fs.readFile(file, "utf8"));
  return Array.isArray(state.tasks) ? state.tasks : [];
}

function relatedDefinitions(tasks, requests) {
  const byId = new Map(tasks.map((task) => [task.task_id, task]));
  const requested = new Set(requests.map((request) => request.task_id));
  const included = new Set();

  function include(taskId) {
    if (!taskId || included.has(taskId)) return;
    included.add(taskId);
    const task = byId.get(taskId);
    for (const dependency of task?.dependencies || []) include(dependency);
  }
  for (const request of requests) include(request.task_id);

  return [...included].map((taskId) => {
    const task = byId.get(taskId) || { task_id: taskId, dependencies: [] };
    return {
      task_id: taskId,
      dependencies: Array.isArray(task.dependencies) ? task.dependencies : [],
      priority: Number.isInteger(task.priority) && task.priority > 0 ? task.priority : null,
      created_at: task.created_at || null,
      execution_revision: Number.isInteger(task.execution_revision)
        ? task.execution_revision
        : Number.isInteger(task.execution_plan?.revision)
          ? task.execution_plan.revision
          : 1,
      cycle_id: task.execution_cycles?.find((cycle) => cycle.status !== "completed")?.cycle_id
        || task.execution_cycles?.at(-1)?.cycle_id
        || "implementation-1",
      state: initialKernelState(task, requested.has(taskId)),
    };
  });
}

function structuralActions({ tasks, requests, state, maxConcurrent }) {
  const byId = new Map(tasks.map((task) => [task.task_id, task]));
  const seen = new Set();
  const candidates = [];
  const actionByIndex = new Map();

  requests.forEach((request, index) => {
    const taskId = request.task_id;
    const existing = state.tasks[taskId];
    if (seen.has(taskId) || (existing && (ACTIVE_KERNEL_STATES.has(existing.state)
      || ["accepted", "failed", "cancelled"].includes(existing.state)))) {
      actionByIndex.set(index, "suppress_duplicate");
      return;
    }
    seen.add(taskId);
    const task = byId.get(taskId) || { task_id: taskId, dependencies: [] };
    const dependencyBlocked = (task.dependencies || []).some((dependencyId) => (
      !ACCEPTED_TASK_STATES.has(byId.get(dependencyId)?.state)
    ));
    if (dependencyBlocked) {
      actionByIndex.set(index, "wait_for_dependency");
      return;
    }
    candidates.push({
      index,
      task_id: taskId,
      priority: Number.isInteger(task.priority) ? task.priority : null,
      created_at: task.created_at || null,
    });
  });

  const active = Object.values(state.tasks).filter((task) => (
    ACTIVE_KERNEL_STATES.has(task.state)
  )).length;
  const slots = Math.max(maxConcurrent - active, 0);
  candidates.sort(compareTasks).forEach((candidate, rank) => {
    actionByIndex.set(candidate.index, rank < slots ? "dispatch" : "wait_for_capacity");
  });
  return actionByIndex;
}

function predictedAction(task, plannedDispatch) {
  if (plannedDispatch) return "dispatch";
  if (task?.state === "waiting_for_dependency") return "wait_for_dependency";
  if (task?.state === "eligible") return "wait_for_capacity";
  return "suppress_duplicate";
}

function scenarioFor(action, taskOrigin, existing) {
  if (existing && ["accepted", "failed", "cancelled"].includes(existing.state)) return "recovery";
  if (action === "wait_for_dependency") return "dependency_blocked";
  if (action === "wait_for_capacity") return "capacity_blocked";
  if (action === "suppress_duplicate") return "duplicate_active";
  return taskOrigin === "unknown" ? "unknown_task" : "independent";
}

export function createExecutionKernelBenchmarkShadow({
  runtimeRoot,
  workspaceRoot,
  maxConcurrent = 2,
  actualRoute = "legacy",
  now = () => new Date(),
}) {
  const runtimeRequire = createRequire(path.join(runtimeRoot, "package.json"));
  const {
    applyKernelEvent,
    claimDispatch,
    createKernelState,
    planDispatchTick,
    retryDelayMs,
  } = runtimeRequire(path.join(runtimeRoot, "packages", "execution-kernel", "src"));
  let kernelState = createKernelState({
    maxConcurrent,
    updatedAt: now().toISOString(),
  });
  let sequence = 0;
  const observations = [];
  const errors = [];

  async function beginBatch({ requests, taskOrigin = "unknown" }) {
    const tasks = await readTasks(workspaceRoot);
    const definitions = relatedDefinitions(tasks, requests);
    const before = kernelState;
    const expected = structuralActions({
      tasks,
      requests,
      state: before,
      maxConcurrent,
    });
    const plan = planDispatchTick({
      state: before,
      tasks: definitions,
      now: now().toISOString(),
    });
    kernelState = plan.state;
    const dispatchByTask = new Map(plan.dispatches.map((dispatch) => [dispatch.task_id, dispatch]));
    const consumedDispatches = new Set();
    const observedTaskIds = new Set();

    return requests.map((request, index) => {
      const existing = before.tasks[request.task_id] || null;
      const duplicateRequest = observedTaskIds.has(request.task_id);
      observedTaskIds.add(request.task_id);
      const dispatch = consumedDispatches.has(request.task_id)
        ? null
        : dispatchByTask.get(request.task_id) || null;
      if (dispatch) consumedDispatches.add(request.task_id);
      const action = duplicateRequest
        ? "suppress_duplicate"
        : predictedAction(kernelState.tasks[request.task_id], dispatch);
      const observation = {
        observation_id: `BENCH-SHADOW-${String(++sequence).padStart(4, "0")}`,
        evidence_kind: "live",
        surface: "orquesta_task_dispatch",
        scenario: scenarioFor(action, taskOrigin, existing),
        task_origin: taskOrigin,
        task_id: request.task_id,
        target_agent_id: request.agent_id,
        actual_route: actualRoute,
        predicted_action: action,
        expected_action: expected.get(index),
        predicted_dispatch_id: dispatch?.dispatch_id || null,
        actual_action: null,
        actual_thread_id: null,
        actual_turn_id: null,
        runtime_status: "unknown",
        additional_codex_turns: 0,
        recovered_without_redispatch: null,
        retry_bounded: null,
        divergence: null,
        observed_at: now().toISOString(),
      };
      observations.push(observation);
      return { observation_id: observation.observation_id };
    });
  }

  function recordResult(ticket, result, error = null) {
    const observation = observations.find((item) => (
      item.observation_id === ticket?.observation_id
    ));
    if (!observation) throw new Error("unknown shadow observation");
    const observedAt = now().toISOString();
    const accepted = !error && result?.status === "completed";
    observation.actual_action = accepted ? "dispatch_accepted" : "dispatch_failed";
    observation.actual_thread_id = result?.thread_id || null;
    observation.actual_turn_id = result?.turn_id || null;
    observation.runtime_status = accepted ? "completed" : "failed";
    observation.finished_at = observedAt;

    if (observation.predicted_action !== "dispatch") {
      observation.divergence = accepted && actualRoute === "legacy"
        ? "kernel_waited_legacy_dispatched"
        : null;
      observation.recovered_without_redispatch = observation.scenario === "recovery"
        ? !accepted
        : null;
      return;
    }

    const claimed = claimDispatch(kernelState, {
      taskId: observation.task_id,
      now: observedAt,
    });
    kernelState = claimed.state;
    if (!claimed.claimed) {
      observation.divergence = "kernel_duplicate_claim";
      return;
    }
    if (accepted) {
      kernelState = applyKernelEvent(kernelState, {
        event_id: `${observation.observation_id}:accepted`,
        type: "dispatch_accepted",
        task_id: observation.task_id,
        dispatch_id: claimed.dispatch.dispatch_id,
        thread_id: result.thread_id,
        turn_id: result.turn_id,
        observed_at: observedAt,
      });
      kernelState = applyKernelEvent(kernelState, {
        event_id: `${observation.observation_id}:started`,
        type: "turn_started",
        task_id: observation.task_id,
        dispatch_id: claimed.dispatch.dispatch_id,
        thread_id: result.thread_id,
        turn_id: result.turn_id,
        observed_at: observedAt,
      });
      kernelState = applyKernelEvent(kernelState, {
        event_id: `${observation.observation_id}:completed`,
        type: "turn_completed",
        task_id: observation.task_id,
        dispatch_id: claimed.dispatch.dispatch_id,
        thread_id: result.thread_id,
        turn_id: result.turn_id,
        observed_at: observedAt,
        status: "completed",
      });
      kernelState = applyKernelEvent(kernelState, {
        event_id: `${observation.observation_id}:verified`,
        type: "verification_accepted",
        task_id: observation.task_id,
        dispatch_id: claimed.dispatch.dispatch_id,
        observed_at: observedAt,
      });
    } else {
      kernelState = applyKernelEvent(kernelState, {
        event_id: `${observation.observation_id}:failed`,
        type: "attempt_failed",
        task_id: observation.task_id,
        dispatch_id: claimed.dispatch.dispatch_id,
        observed_at: observedAt,
        retry_at: new Date(
          Date.parse(observedAt) + retryDelayMs(claimed.dispatch.attempt)
        ).toISOString(),
        error: error?.message || "legacy_dispatch_failed",
      });
      observation.scenario = "failure_retry";
      observation.retry_bounded = true;
    }
  }

  return {
    beginBatch,
    recordResult,
    recordError(error) {
      errors.push({
        message: error instanceof Error ? error.message : String(error),
        observed_at: now().toISOString(),
      });
    },
    snapshot() {
      return {
        schema_version: 1,
        mode: "shadow",
        source: "orquesta_v4_product_benchmark",
        actual_route: actualRoute,
        additional_codex_turns: 0,
        observations: structuredClone(observations),
        errors: structuredClone(errors),
      };
    },
  };
}

export function createExecutionKernelSpecialistScheduler({
  runtimeRoot,
  workspaceRoot,
  maxConcurrent = 2,
  now = () => new Date(),
}) {
  const runtimeRequire = createRequire(path.join(runtimeRoot, "package.json"));
  const {
    applyKernelEvent,
    claimDispatch,
    createKernelState,
    planDispatchTick,
  } = runtimeRequire(path.join(runtimeRoot, "packages", "execution-kernel", "src"));

  return {
    async run({ requests, start }) {
      if (!Array.isArray(requests)) throw new TypeError("requests must be an array");
      if (typeof start !== "function") throw new TypeError("start must be a function");
      const tasks = await readTasks(workspaceRoot);
      const definitions = relatedDefinitions(tasks, requests);
      const requestByTask = new Map();
      for (const request of requests) {
        if (!requestByTask.has(request.task_id)) requestByTask.set(request.task_id, request);
      }
      let state = createKernelState({
        maxConcurrent,
        updatedAt: now().toISOString(),
      });
      const resultByTask = new Map();
      let cycles = 0;

      while (resultByTask.size < requestByTask.size) {
        if (++cycles > Math.max(requestByTask.size * 2, 2)) {
          throw new Error("execution_kernel_scheduler_cycle_limit");
        }
        const observedAt = now().toISOString();
        const plan = planDispatchTick({
          state,
          tasks: definitions,
          now: observedAt,
        });
        state = plan.state;
        const candidates = plan.dispatches.filter((dispatch) => (
          requestByTask.has(dispatch.task_id) && !resultByTask.has(dispatch.task_id)
        ));
        if (!candidates.length) {
          const blocked = [...requestByTask.keys()].filter((taskId) => !resultByTask.has(taskId));
          throw new Error(`execution_kernel_scheduler_blocked:${blocked.join(",")}`);
        }
        const claims = candidates.map((candidate) => {
          const claimed = claimDispatch(state, {
            taskId: candidate.task_id,
            now: observedAt,
          });
          state = claimed.state;
          if (!claimed.claimed) throw new Error(`execution_kernel_claim_failed:${candidate.task_id}`);
          return claimed.dispatch;
        });
        const outcomes = await Promise.allSettled(claims.map((dispatch) => (
          start(requestByTask.get(dispatch.task_id))
        )));

        outcomes.forEach((outcome, index) => {
          const dispatch = claims[index];
          const finishedAt = now().toISOString();
          if (outcome.status === "rejected") {
            state = applyKernelEvent(state, {
              event_id: `${dispatch.dispatch_id}:benchmark:failed`,
              type: "task_failed",
              task_id: dispatch.task_id,
              dispatch_id: dispatch.dispatch_id,
              observed_at: finishedAt,
              error: outcome.reason instanceof Error
                ? outcome.reason.message
                : String(outcome.reason),
            });
            throw outcome.reason;
          }
          const result = outcome.value;
          if (result?.status !== "completed" || !result.thread_id || !result.turn_id) {
            state = applyKernelEvent(state, {
              event_id: `${dispatch.dispatch_id}:benchmark:incomplete`,
              type: "task_failed",
              task_id: dispatch.task_id,
              dispatch_id: dispatch.dispatch_id,
              observed_at: finishedAt,
              error: `specialist ended as ${result?.status || "unknown"}`,
            });
            throw new Error(`execution_kernel_specialist_incomplete:${dispatch.task_id}`);
          }
          const common = {
            task_id: dispatch.task_id,
            dispatch_id: dispatch.dispatch_id,
            thread_id: result.thread_id,
            turn_id: result.turn_id,
            observed_at: finishedAt,
          };
          state = applyKernelEvent(state, {
            ...common,
            event_id: `${dispatch.dispatch_id}:benchmark:accepted`,
            type: "dispatch_accepted",
          });
          state = applyKernelEvent(state, {
            ...common,
            event_id: `${dispatch.dispatch_id}:benchmark:started`,
            type: "turn_started",
          });
          state = applyKernelEvent(state, {
            ...common,
            event_id: `${dispatch.dispatch_id}:benchmark:completed`,
            type: "turn_completed",
            status: "completed",
          });
          state = applyKernelEvent(state, {
            ...common,
            event_id: `${dispatch.dispatch_id}:benchmark:verified`,
            type: "verification_accepted",
          });
          resultByTask.set(dispatch.task_id, result);
        });
      }

      return requests.map((request) => resultByTask.get(request.task_id));
    },
  };
}
