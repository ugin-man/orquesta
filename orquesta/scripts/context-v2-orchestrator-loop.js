"use strict";

const { mkdir, readFile, readdir, rename, writeFile } = require("node:fs/promises");
const path = require("node:path");
const {
  createOrchestratorResumePlan,
  verifyControlPlaneContinuity,
} = require("../../packages/execution-kernel/src");

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

async function loadBranchDeltas(contextRoot) {
  const directory = path.join(contextRoot, "branch_deltas");
  let names = [];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const values = await Promise.all(names
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => readJson(path.join(directory, name))));
  return values.filter(Boolean);
}

async function planFileBackedOrchestrator(root, {
  observedAt = new Date().toISOString(),
  ackBranchDeltaIds = [],
} = {}) {
  const contextRoot = path.join(path.resolve(root), ".orquesta", "context");
  const [controlPlane, priorState, branchDeltas] = await Promise.all([
    readJson(path.join(contextRoot, "project_control_plane.json")),
    readJson(path.join(contextRoot, "orchestrator_state.json"), {
      version: 2,
      consumed_branch_delta_ids: [],
    }),
    loadBranchDeltas(contextRoot),
  ]);
  if (!controlPlane) throw new Error("context_v2_project_control_plane_missing");
  const acknowledged = [...new Set([
    ...(priorState.consumed_branch_delta_ids || []),
    ...(Array.isArray(ackBranchDeltaIds) ? ackBranchDeltaIds : []),
  ])].sort();
  const planningState = { ...priorState, consumed_branch_delta_ids: acknowledged };
  const plan = createOrchestratorResumePlan({
    projectControlPlane: controlPlane,
    branchDeltas,
    orchestrationState: planningState,
    observedAt,
  });
  const state = {
    ...planningState,
    version: 2,
    project_id: controlPlane.project_id,
    control_plane_revision: controlPlane.revision,
    last_processed_at: observedAt,
  };
  await Promise.all([
    writeJsonAtomic(path.join(contextRoot, "orchestrator_state.json"), state),
    writeJsonAtomic(path.join(contextRoot, "orchestrator_resume.json"), plan),
  ]);
  return { plan, state };
}

async function verifyFileBackedContinuity(root, beforeFile, afterFile) {
  const workspaceRoot = path.resolve(root);
  const before = await readJson(path.resolve(workspaceRoot, beforeFile));
  const after = await readJson(path.resolve(workspaceRoot, afterFile));
  if (!before || !after) throw new Error("control_plane_continuity_input_missing");
  return verifyControlPlaneContinuity(before, after);
}

function option(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1];
}

async function runCli(argv = process.argv.slice(2), { stdout = process.stdout } = {}) {
  const root = option(argv, "--root");
  if (!root) throw new Error("missing_option:--root");
  const command = argv.find((value) => !value.startsWith("--") && value !== root) || "status";
  let result;
  if (command === "verify-continuity") {
    const before = option(argv, "--before");
    const after = option(argv, "--after");
    if (!before || !after) throw new Error("missing_continuity_paths");
    result = await verifyFileBackedContinuity(root, before, after);
  } else {
    const ackValues = argv.reduce((values, value, index) => (
      value === "--ack" && argv[index + 1] ? [...values, argv[index + 1]] : values
    ), []);
    result = await planFileBackedOrchestrator(root, {
      observedAt: option(argv, "--observed-at") || undefined,
      ackBranchDeltaIds: ackValues,
    });
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

module.exports = {
  planFileBackedOrchestrator,
  runCli,
  verifyFileBackedContinuity,
};
