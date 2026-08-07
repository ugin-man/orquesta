"use strict";

const { mkdir, readFile, rename, writeFile } = require("node:fs/promises");
const path = require("node:path");
function loadContextRuntime() {
  try {
    return require("../../packages/context-compiler/src");
  } catch (error) {
    if (error?.code !== "MODULE_NOT_FOUND") throw error;
    return require("../runtime/context-v2-runtime.cjs");
  }
}

const { evaluateContextV2Activation, summarizeContextVariantComparison } = loadContextRuntime();

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

function withRouteProfile(task, route) {
  return {
    ...task,
    task_profile: {
      ...(task.task_profile || {}),
      context_route: route,
    },
  };
}

async function routeContextForTask(root, taskId, {
  featureMode = "limited",
  generatedAt = new Date().toISOString(),
} = {}) {
  const workspaceRoot = path.resolve(root);
  const contextRoot = path.join(workspaceRoot, ".orquesta", "context");
  const tasksPath = path.join(workspaceRoot, ".orquesta", "state", "tasks.json");
  const batchPath = path.join(workspaceRoot, ".orquesta", "setup", "provisioning_batch.json");
  const [tasksState, batch, catalog, rawComparison] = await Promise.all([
    readJson(tasksPath, { tasks: [] }),
    readJson(batchPath),
    readJson(path.join(contextRoot, "source_catalog.json"), { records: [] }),
    readJson(path.join(contextRoot, "variant_comparison.json")),
  ]);
  const task = (tasksState.tasks || []).find((entry) => entry.task_id === taskId);
  if (!task) throw new Error(`task_not_found:${taskId}`);
  const profile = task.task_profile || {};
  const requirement = profile.context_requirement;
  const packId = profile.context_pack_id;
  const pack = packId ? await readJson(path.join(contextRoot, "packs", `${packId}.json`)) : null;
  if (!requirement || !pack) throw new Error(`context_route_inputs_missing:${taskId}`);
  const comparison = rawComparison?.passed !== undefined
    ? rawComparison
    : summarizeContextVariantComparison(rawComparison?.rows || []);
  const decision = evaluateContextV2Activation({
    featureMode,
    contextRequirement: requirement,
    contextPack: pack,
    variantComparison: comparison,
  });
  const byId = new Map((catalog.records || []).map((record) => [record.source_id, record]));
  const route = {
    ...decision,
    task_id: taskId,
    generated_at: generatedAt,
    selected_source_refs: decision.fallback
      ? []
      : (pack.selected_sources || [])
        .map((sourceId) => byId.get(sourceId)?.source_ref)
        .filter(Boolean)
        .sort(),
  };
  const nextTasks = {
    ...tasksState,
    tasks: (tasksState.tasks || []).map((entry) => (
      entry.task_id === taskId ? withRouteProfile(entry, route) : entry
    )),
    updated_at: generatedAt,
  };
  const nextBatch = batch ? {
    ...batch,
    requests: (batch.requests || []).map((request) => (
      request.task_id === taskId
        ? { ...request, task_profile: { ...(request.task_profile || {}), context_route: route } }
        : request
    )),
    updated_at: generatedAt,
  } : null;
  await Promise.all([
    writeJsonAtomic(path.join(contextRoot, "activation", `${encodeURIComponent(taskId)}.json`), route),
    writeJsonAtomic(tasksPath, nextTasks),
    ...(nextBatch ? [writeJsonAtomic(batchPath, nextBatch)] : []),
  ]);
  return route;
}

function option(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1];
}

async function runCli(argv = process.argv.slice(2), { stdout = process.stdout } = {}) {
  const root = option(argv, "--root");
  const task = option(argv, "--task");
  if (!root) throw new Error("missing_option:--root");
  if (!task) throw new Error("missing_option:--task");
  const route = await routeContextForTask(root, task, {
    featureMode: option(argv, "--mode") || "limited",
    generatedAt: option(argv, "--generated-at") || undefined,
  });
  stdout.write(`${JSON.stringify(route, null, 2)}\n`);
  return route;
}

if (require.main === module) {
  runCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { routeContextForTask, runCli };
