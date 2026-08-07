"use strict";

const { mkdir, readFile, rename, writeFile } = require("node:fs/promises");
const path = require("node:path");
const {
  compareColdAndSteadyContextCosts,
  createContextCostReport,
} = require("../../packages/context-compiler/src");

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function readText(filePath) {
  if (!filePath) return undefined;
  return readFile(filePath, "utf8");
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

function option(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1];
}

function integerOption(argv, name) {
  const value = option(argv, name);
  if (value === null) return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new Error(`invalid_option:${name}`);
  return number;
}

async function createFileBackedCostReport(root, taskId, startupMode, options = {}) {
  const workspaceRoot = path.resolve(root);
  const contextRoot = path.join(workspaceRoot, ".orquesta", "context");
  const tasks = await readJson(path.join(workspaceRoot, ".orquesta", "state", "tasks.json"), { tasks: [] });
  const agents = await readJson(path.join(workspaceRoot, ".orquesta", "state", "agents.json"), { agents: [] });
  const catalog = await readJson(path.join(contextRoot, "source_catalog.json"), { records: [] });
  const controlPlane = await readJson(path.join(contextRoot, "project_control_plane.json"));
  const session = await readJson(path.join(contextRoot, "sessions", `${encodeURIComponent(taskId)}.json`), {});
  const task = (tasks.tasks || []).find((entry) => entry.task_id === taskId);
  if (!task) throw new Error(`task_not_found:${taskId}`);
  const packId = task.task_profile?.context_pack_id;
  const pack = packId ? await readJson(path.join(contextRoot, "packs", `${packId}.json`)) : null;
  if (!pack || !controlPlane) throw new Error(`context_cost_inputs_missing:${taskId}`);
  const selectedIds = new Set(pack.selected_sources || []);
  const selectedRecords = (catalog.records || []).filter((record) => selectedIds.has(record.source_id));
  const capability = (agents.agents || []).find((agent) => agent.agent_id === task.owner_agent_id);
  const report = createContextCostReport({
    runId: options.runId || `${taskId}:${startupMode}`,
    startupMode,
    codexHarnessBaseline: options.harnessTokens === null || options.harnessTokens === undefined
      ? undefined
      : { tokens: options.harnessTokens, evidence_ref: options.harnessEvidenceRef || "codex_session_jsonl" },
    universalContract: options.universalContract,
    taskEnvelope: task.task_profile?.task_envelope,
    projectControlPlane: controlPlane,
    specialistCapabilitySlice: capability,
    selectedProjectSources: selectedRecords,
    toolResults: options.toolResultTokens === null || options.toolResultTokens === undefined
      ? undefined
      : { tokens: options.toolResultTokens, evidence_ref: options.toolEvidenceRef || "codex_session_jsonl" },
    conversationHistory: options.historyTokens === null || options.historyTokens === undefined
      ? undefined
      : { tokens: options.historyTokens, evidence_ref: options.historyEvidenceRef || "codex_session_jsonl" },
    observedFullPromptTokens: options.observedPromptTokens,
    fileReadEvents: session.read_events || [],
    fileReadMeasurementComplete: true,
    foundation: {
      generation_count: options.foundationGenerationCount || 0,
      reuse_count: options.foundationReuseCount || 0,
    },
    generatedAt: options.generatedAt,
  });
  const costRoot = path.join(contextRoot, "costs", encodeURIComponent(taskId));
  await writeJsonAtomic(path.join(costRoot, `${startupMode}.json`), report);
  const counterpart = startupMode === "cold" ? "steady" : "cold";
  const other = await readJson(path.join(costRoot, `${counterpart}.json`));
  let comparison = null;
  if (other) {
    comparison = compareColdAndSteadyContextCosts(
      startupMode === "cold" ? report : other,
      startupMode === "steady" ? report : other,
    );
    await writeJsonAtomic(path.join(costRoot, "comparison.json"), comparison);
  }
  return { report, comparison };
}

async function runCli(argv = process.argv.slice(2), { stdout = process.stdout } = {}) {
  const root = option(argv, "--root");
  const task = option(argv, "--task");
  const startupMode = option(argv, "--startup-mode");
  if (!root) throw new Error("missing_option:--root");
  if (!task) throw new Error("missing_option:--task");
  const universalContractPath = option(argv, "--universal-contract");
  const result = await createFileBackedCostReport(root, task, startupMode, {
    runId: option(argv, "--run-id"),
    harnessTokens: integerOption(argv, "--harness-tokens"),
    toolResultTokens: integerOption(argv, "--tool-result-tokens"),
    historyTokens: integerOption(argv, "--history-tokens"),
    observedPromptTokens: integerOption(argv, "--observed-prompt-tokens"),
    foundationGenerationCount: integerOption(argv, "--foundation-generation-count"),
    foundationReuseCount: integerOption(argv, "--foundation-reuse-count"),
    universalContract: await readText(universalContractPath),
    generatedAt: option(argv, "--generated-at") || undefined,
  });
  stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (require.main === module) {
  runCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { createFileBackedCostReport, runCli };
