"use strict";

const path = require("node:path");
const {
  createRuntimeEstimate,
  validateRuntimeEstimate,
} = require("../../packages/core/src/runtime-estimator");
const { updateJsonAtomic } = require("./json-state");

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function parseArguments(argv) {
  const result = {
    rootPath: process.cwd(),
    taskId: null,
    refresh: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--root") result.rootPath = argv[++index];
    else if (argument === "--task-id") result.taskId = argv[++index];
    else if (argument === "--refresh") result.refresh = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (typeof result.rootPath !== "string" || !result.rootPath.trim()) throw new Error("--root requires a path");
  if (result.taskId !== null && (typeof result.taskId !== "string" || !result.taskId.trim())) {
    throw new Error("--task-id requires a non-empty task id");
  }
  result.rootPath = path.resolve(result.rootPath);
  if (result.taskId) result.taskId = result.taskId.trim();
  return result;
}

function eligibleTask(task) {
  return Boolean(
    task
    && typeof task === "object"
    && !Array.isArray(task)
    && task.task_intent
    && task.task_profile
    && task.execution_plan
  );
}

function estimateTask(task, { refresh = false, now = () => new Date().toISOString() } = {}) {
  const existing = task.runtime_estimate;
  if (existing !== undefined && existing !== null) {
    const validated = validateRuntimeEstimate(existing);
    if (!refresh || validated.source === "agent_decomposed") {
      return { task: clone(task), action: "preserved" };
    }
  }
  if (!eligibleTask(task)) return { task: clone(task), action: "skipped" };

  const runtimeEstimate = createRuntimeEstimate({
    taskIntent: task.task_intent,
    taskProfile: task.task_profile,
    executionPlan: task.execution_plan,
    estimateInput: task.runtime_estimate_input || {},
    calibration: task.runtime_calibration,
    observations: task.runtime_observations || [],
  });
  return {
    task: {
      ...clone(task),
      runtime_estimate: clone(runtimeEstimate),
      runtime_estimate_updated_at: now(),
    },
    action: existing ? "refreshed" : "estimated",
  };
}

function updateTasksDocument(document, {
  taskId = null,
  refresh = false,
  now = () => new Date().toISOString(),
} = {}) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new TypeError("tasks state must be an object");
  }
  if (!Array.isArray(document.tasks)) throw new TypeError("tasks state must contain a tasks array");
  const found = taskId === null || document.tasks.some((task) => task?.task_id === taskId);
  if (!found) throw new Error(`Task not found: ${taskId}`);

  const summary = {
    estimated_task_ids: [],
    refreshed_task_ids: [],
    preserved_task_ids: [],
    skipped_task_ids: [],
  };
  const tasks = document.tasks.map((task) => {
    const id = typeof task?.task_id === "string" ? task.task_id : "<unknown>";
    if (taskId !== null && id !== taskId) return clone(task);
    const result = estimateTask(task, { refresh, now });
    summary[`${result.action}_task_ids`].push(id);
    return result.task;
  });
  if (taskId !== null && summary.skipped_task_ids.includes(taskId)) {
    throw new Error(`Task lacks runtime-estimate inputs: ${taskId}`);
  }
  const changed = summary.estimated_task_ids.length > 0 || summary.refreshed_task_ids.length > 0;
  return {
    document: {
      ...clone(document),
      tasks,
      updated_at: changed ? now() : document.updated_at,
    },
    summary: {
      ...summary,
      status: changed ? "updated" : "unchanged",
    },
  };
}

function applyRuntimeEstimates({
  rootPath = process.cwd(),
  taskId = null,
  refresh = false,
  now = () => new Date().toISOString(),
} = {}) {
  const canonicalRoot = path.resolve(rootPath);
  const tasksPath = path.join(canonicalRoot, ".orquesta", "state", "tasks.json");
  let summary = null;
  updateJsonAtomic(tasksPath, null, (current) => {
    if (current === null) throw new Error(`Canonical tasks state is missing: ${tasksPath}`);
    const result = updateTasksDocument(current, { taskId, refresh, now });
    summary = result.summary;
    return result.document;
  });
  return {
    ...summary,
    tasks_path: tasksPath,
    task_id: taskId,
    refresh,
  };
}

function main() {
  const input = parseArguments(process.argv.slice(2));
  const result = applyRuntimeEstimates(input);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  applyRuntimeEstimates,
  eligibleTask,
  estimateTask,
  parseArguments,
  updateTasksDocument,
};
