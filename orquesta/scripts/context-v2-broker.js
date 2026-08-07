"use strict";

const { mkdir, readFile, rename, writeFile } = require("node:fs/promises");
const { existsSync } = require("node:fs");
const path = require("node:path");
function requireRuntimePackage(relativePath) {
  const candidates = [
    path.resolve(__dirname, "..", "..", relativePath),
    path.resolve(__dirname, "..", "..", "..", "..", relativePath),
  ];
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (error) {
      if (error?.code !== "MODULE_NOT_FOUND") throw error;
    }
  }
  const bundledRuntimePath = path.resolve(__dirname, "..", "runtime", "context-v2-runtime.cjs");
  if (existsSync(bundledRuntimePath)) return require(bundledRuntimePath);
  throw new Error(`orquesta_runtime_package_missing:${relativePath}`);
}

const { createContextBrokerV2 } = requireRuntimePackage("packages/context-compiler/src");
const {
  createOrchestratorResumePlan,
  reconcileContextReceiptV2,
} = requireRuntimePackage("packages/execution-kernel/src");

function parseArguments(argv) {
  const options = {};
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const key = value.slice(2).replaceAll("-", "_");
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) options[key] = true;
    else {
      options[key] = next;
      index += 1;
    }
  }
  return { command: positionals[0] || "status", options };
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

function requireString(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`missing_option:${name}`);
  return value.trim();
}

function taskFileName(taskId) {
  return encodeURIComponent(taskId);
}

async function loadRuntime(root, taskId) {
  const contextRoot = path.join(root, ".orquesta", "context");
  const index = await readJson(path.join(contextRoot, "shadow_index.json"));
  const comparison = index?.comparisons?.find((entry) => entry.task_id === taskId);
  if (!comparison) throw new Error(`context_task_not_indexed:${taskId}`);
  const requirement = await readJson(path.join(contextRoot, "requirements", `${comparison.context_requirement_id}.json`));
  const pack = await readJson(path.join(contextRoot, "packs", `${comparison.context_pack_id}.json`));
  const sourceCatalogState = await readJson(path.join(contextRoot, "source_catalog.json"));
  if (!requirement || !pack || !Array.isArray(sourceCatalogState?.records)) {
    throw new Error(`context_runtime_incomplete:${taskId}`);
  }
  const tasks = await readJson(path.join(root, ".orquesta", "state", "tasks.json"), { tasks: [] });
  const task = tasks.tasks?.find((entry) => entry.task_id === taskId) || {};
  const inlineSources = {};
  if (task.task_intent && task.task_intent.task_intent_id) {
    inlineSources[`task_intent:${task.task_intent.task_intent_id}`] = JSON.stringify(task.task_intent);
  }
  const envelope = task.task_profile?.task_envelope;
  if (envelope?.task_envelope_id) {
    inlineSources[`task_envelope:${envelope.task_envelope_id}`] = JSON.stringify(envelope);
  }
  const sessionPath = path.join(contextRoot, "sessions", `${taskFileName(taskId)}.json`);
  const session = await readJson(sessionPath, {});
  const projectControlPlane = await readJson(path.join(contextRoot, "project_control_plane.json"));
  const branchDeltaIndex = await readJson(path.join(contextRoot, "branch_delta_index.json"), {
    version: 2,
    applied_branch_delta_ids: [],
    latest_by_workstream: {},
  });
  const receiptIndex = await readJson(path.join(contextRoot, "receipt_index.json"), {
    version: 2,
    receipts: [],
  });
  const orchestrationState = await readJson(path.join(contextRoot, "orchestrator_state.json"), {
    version: 2,
    project_id: projectControlPlane?.project_id || null,
    control_plane_revision: projectControlPlane?.revision || 0,
    consumed_branch_delta_ids: [],
    last_processed_at: null,
  });
  return {
    branchDeltaIndex,
    comparison,
    contextRoot,
    inlineSources,
    pack,
    requirement,
    session,
    sessionPath,
    sourceCatalog: sourceCatalogState.records,
    taskEnvelope: envelope,
    projectControlPlane,
    receiptIndex,
    orchestrationState,
  };
}

function persistedSession(taskId, runtime, snapshot, previous, now) {
  const initial = new Set(snapshot.initially_selected_source_ids);
  return {
    version: 2,
    task_id: taskId,
    context_pack_id: snapshot.context_pack_id,
    expanded_source_ids: snapshot.currently_selected_source_ids.filter((sourceId) => !initial.has(sourceId)),
    used_source_ids: snapshot.used_source_ids,
    missing_context: snapshot.missing_context,
    expansion_tokens: snapshot.expansion_tokens,
    read_events: snapshot.read_events,
    opened_bytes: snapshot.opened_bytes,
    opened_tokens: snapshot.opened_tokens,
    receipt_ids: Array.isArray(previous.receipt_ids) ? previous.receipt_ids : [],
    updated_at: now,
  };
}

async function runCli(argv = process.argv.slice(2), { stdout = process.stdout, now = () => new Date().toISOString() } = {}) {
  const { command, options } = parseArguments(argv);
  const root = path.resolve(requireString(options.root, "root"));
  const taskId = requireString(options.task, "task");
  const runtime = await loadRuntime(root, taskId);
  const broker = createContextBrokerV2({
    workspaceRoot: root,
    contextPack: runtime.pack,
    contextRequirement: runtime.requirement,
    sourceCatalog: runtime.sourceCatalog,
    inlineSources: runtime.inlineSources,
    session: runtime.session,
  });
  let result;
  let persist = false;
  if (command === "bootstrap") {
    const initialSourceIds = broker.snapshot().initially_selected_source_ids;
    const opened = initialSourceIds.map((source) => broker.open(source, {
      maxTokens: options.max_tokens === undefined ? null : Number(options.max_tokens),
    }));
    const snapshot = broker.snapshot();
    result = {
      status: "bootstrapped",
      context_pack_id: snapshot.context_pack_id,
      requirement_id: snapshot.requirement_id,
      initially_selected_source_ids: snapshot.initially_selected_source_ids,
      opened,
      opened_bytes: snapshot.opened_bytes,
      opened_tokens: snapshot.opened_tokens,
      missing_context: snapshot.missing_context,
      remaining_expansion_tokens: snapshot.remaining_expansion_tokens,
    };
    persist = true;
  } else if (command === "search") {
    result = broker.search(requireString(options.query, "query"), {
      limit: options.limit === undefined ? 10 : Number(options.limit),
    });
  } else if (command === "index") {
    result = broker.sourceIndex();
  } else if (command === "rehydrate") {
    result = broker.rehydrate();
    persist = true;
  } else if (command === "expand") {
    const sources = String(requireString(options.source, "source")).split(",").map((entry) => entry.trim()).filter(Boolean);
    result = broker.expand(sources);
    persist = true;
  } else if (command === "open") {
    const sources = String(requireString(options.source, "source"))
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    const opened = sources.map((source) => broker.open(source, {
      maxTokens: options.max_tokens === undefined ? null : Number(options.max_tokens),
    }));
    result = opened.length === 1 ? opened[0] : { opened };
    persist = true;
  } else if (command === "explain") {
    result = broker.explain(requireString(options.source, "source"));
  } else if (command === "missing") {
    broker.reportMissingContext(requireString(options.description, "description"));
    result = broker.snapshot();
    persist = true;
  } else if (command === "receipt") {
    const acceptanceResults = options.acceptance_file
      ? await readJson(path.resolve(root, options.acceptance_file))
      : [];
    const receipt = broker.finalize({
      userCorrections: Number(options.user_corrections || 0),
      incorrectProjectFacts: Number(options.incorrect_project_facts || 0),
      compactionCount: Number(options.compaction_count || 0),
      acceptanceResults: Array.isArray(acceptanceResults) ? acceptanceResults : acceptanceResults?.acceptance_results || [],
      createdAt: now(),
    });
    if (!runtime.taskEnvelope || !runtime.projectControlPlane) throw new Error(`context_reconciliation_inputs_missing:${taskId}`);
    await writeJsonAtomic(path.join(runtime.contextRoot, "receipts", `${receipt.receipt_id}.json`), receipt);
    const receiptEntries = Array.isArray(runtime.receiptIndex.receipts) ? runtime.receiptIndex.receipts : [];
    const nextReceiptEntries = [
      ...receiptEntries.filter((entry) => entry?.receipt_id !== receipt.receipt_id),
      {
        task_id: taskId,
        context_pack_id: receipt.context_pack_id,
        receipt_id: receipt.receipt_id,
        created_at: receipt.created_at,
      },
    ].sort((left, right) => (
      String(left.task_id).localeCompare(String(right.task_id))
      || String(left.created_at).localeCompare(String(right.created_at))
      || String(left.receipt_id).localeCompare(String(right.receipt_id))
    ));
    await writeJsonAtomic(path.join(runtime.contextRoot, "receipt_index.json"), {
      version: 2,
      receipts: nextReceiptEntries,
      updated_at: now(),
    });
    const reconciliation = reconcileContextReceiptV2({
      projectControlPlane: runtime.projectControlPlane,
      taskEnvelope: runtime.taskEnvelope,
      contextPack: runtime.pack,
      contextReceipt: receipt,
      terminalOutcomeCompleted: options.terminal === "true",
      priorBranchDeltaIds: runtime.branchDeltaIndex.applied_branch_delta_ids || [],
      observedAt: now(),
    });
    await writeJsonAtomic(
      path.join(runtime.contextRoot, "branch_deltas", `${reconciliation.branch_delta.branch_delta_id}.json`),
      reconciliation.branch_delta,
    );
    await writeJsonAtomic(path.join(runtime.contextRoot, "project_control_plane.json"), reconciliation.project_control_plane);
    const workstreamId = reconciliation.branch_delta.workstream_id;
    await writeJsonAtomic(path.join(runtime.contextRoot, "branch_delta_index.json"), {
      version: 2,
      applied_branch_delta_ids: [...new Set([
        ...(runtime.branchDeltaIndex.applied_branch_delta_ids || []),
        reconciliation.branch_delta.branch_delta_id,
      ])].sort(),
      latest_by_workstream: {
        ...(runtime.branchDeltaIndex.latest_by_workstream || {}),
        [workstreamId]: reconciliation.branch_delta.branch_delta_id,
      },
      updated_at: now(),
    });
    const orchestratorResume = createOrchestratorResumePlan({
      projectControlPlane: reconciliation.project_control_plane,
      branchDeltas: [reconciliation.branch_delta],
      orchestrationState: runtime.orchestrationState,
      observedAt: now(),
    });
    await writeJsonAtomic(
      path.join(runtime.contextRoot, "orchestrator_resume.json"),
      orchestratorResume,
    );
    runtime.session.receipt_ids = [...new Set([...(runtime.session.receipt_ids || []), receipt.receipt_id])];
    result = { receipt, reconciliation, orchestrator_resume: orchestratorResume };
    persist = true;
  } else if (command === "status") {
    result = broker.snapshot();
  } else {
    throw new Error(`unknown_context_command:${command}`);
  }
  if (persist) {
    const session = persistedSession(taskId, runtime, broker.snapshot(), runtime.session, now());
    const receiptId = result?.receipt?.receipt_id || result?.receipt_id;
    if (receiptId) session.receipt_ids = [...new Set([...(session.receipt_ids || []), receiptId])];
    await writeJsonAtomic(runtime.sessionPath, session);
  }
  stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (require.main === module) {
  runCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { runCli };
