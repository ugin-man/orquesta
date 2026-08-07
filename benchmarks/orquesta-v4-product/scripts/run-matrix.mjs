import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import {
  createDefaultAppServerAdapter,
  createProfiledSpawn,
  runAppServerTask
} from "./lib/app-server-runner.mjs";
import { parseArgs } from "./lib/cli.mjs";
import { auditEnvironment } from "./lib/environment-evidence.mjs";
import {
  finalizeRun,
  rebaselineRunMeasurement,
  startRun,
} from "./lib/lifecycle.mjs";
import {
  createAppServerAgentExecutor,
  prepareSteadyOrquestaTask,
  createSnapshotSetupRuntime,
  runOrquestaTask
} from "./lib/orquesta-runner.mjs";
import {
  createExecutionKernelBenchmarkShadow,
  createExecutionKernelSpecialistScheduler
} from "./lib/execution-kernel-shadow.mjs";
import { benchmarkRoot, repositoryRoot } from "./lib/paths.mjs";
import {
  compareMatrix,
  renderMarkdownReport
} from "./lib/report.mjs";
import { prepareRuntimeProfile } from "./lib/runtime-profiles.mjs";
import { prepareTasks, verifyTask } from "./lib/tasks.mjs";
import {
  createV4FastSnapshot,
  verifyV4FastSource
} from "./lib/v4-fast-snapshot.mjs";
import { assertPreflightReady } from "./preflight.mjs";

const MODES = ["plain", "skills", "orquesta"];

function assertMatrixId(matrixId) {
  if (!/^[a-zA-Z0-9._-]+$/.test(matrixId || "")) {
    throw new Error("matrix ID contains unsupported characters");
  }
}

async function exists(target) {
  return fs.stat(target).then(() => true, () => false);
}

export async function executeMatrixPlan({
  matrixId,
  storageRoot,
  preflight,
  taskId = "organization-json-generator",
  modes = MODES,
  runMode
}) {
  assertPreflightReady(preflight);
  assertMatrixId(matrixId);
  if (
    !Array.isArray(modes)
    || modes.length === 0
    || modes.some((mode) => !MODES.includes(mode))
    || new Set(modes).size !== modes.length
  ) {
    throw new Error("modes must be a non-empty unique subset of plain, skills, and orquesta");
  }
  const plans = modes.map((mode) => ({
    matrixId,
    mode,
    taskId,
    runId: `${matrixId}-${mode}`
  }));
  for (const plan of plans) {
    const runDir = path.join(storageRoot, "runs", plan.runId);
    if (await exists(runDir)) {
      throw new Error(`run already exists: ${plan.runId}`);
    }
  }
  const results = [];
  for (const plan of plans) {
    results.push(await runMode(plan));
  }
  return { matrix_id: matrixId, task_id: taskId, results };
}

function snapshotAdapter({ runtimeRoot, profile }) {
  const runtimeRequire = createRequire(path.join(runtimeRoot, "package.json"));
  const { createAppServerAdapter } = runtimeRequire(
    path.join(runtimeRoot, "packages", "codex-adapter", "src", "index.js")
  );
  return createAppServerAdapter({
    spawnProcess: createProfiledSpawn({ profile })
  });
}

export function collectThreadIds(outcome) {
  const ids = new Set(outcome?.thread_ids || []);
  if (outcome?.thread_id) ids.add(outcome.thread_id);
  for (const id of outcome?.bootstrap_metrics?.thread_ids || []) ids.add(id);
  if (outcome?.main_metrics?.orchestrator_thread_id) {
    ids.add(outcome.main_metrics.orchestrator_thread_id);
  }
  for (const id of outcome?.main_metrics?.direct_thread_ids || []) ids.add(id);
  for (const id of outcome?.main_metrics?.specialist_thread_ids || []) ids.add(id);
  return [...ids].filter(Boolean);
}

export function buildEnvironmentObservation({
  mode,
  profile,
  outcome,
  runtimeSnapshotHash
}) {
  return {
    model: mode === "orquesta"
      ? profile.execution.model
      : outcome?.actual_model || outcome?.final?.actual_model || profile.execution.model,
    reasoning_effort: profile.execution.reasoning_effort,
    sandbox: outcome?.runtime_profile?.sandbox || profile.execution.sandbox,
    approval_policy: outcome?.runtime_profile?.approval_policy
      || profile.execution.approval_policy,
    multi_agent: profile.multi_agent,
    loaded_skills: mode === "orquesta"
      ? [{
        name: "orquesta",
        source: "repository",
        runtime_snapshot_hash: runtimeSnapshotHash
      }]
      : [],
    loaded_plugins: [],
    mcp_servers: [],
    instruction_sources: mode === "plain" ? ["system"] : ["system", "user"],
    evidence_basis: {
      model_sandbox_approval: "app-server-applied-profile",
      reasoning_effort: "turn-start-parameter",
      features_skills_plugins_mcp: "isolated-profile-and-workspace-configuration"
    }
  };
}

function infrastructureOutcome(error) {
  return {
    status: "infrastructure_error",
    error: {
      code: error.code || "matrix_runner_failed",
      message: error.message
    },
    events: [],
    thread_ids: []
  };
}

export async function runFormalMode({
  matrixId,
  mode,
  taskId = "organization-json-generator",
  runId,
  storageRoot,
  currentCodexHome,
  matrixCacheRoot,
  snapshot,
  runtimeRoot,
  kernelMode = "shadow",
  startupMode = "cold",
}) {
  const workspaceRoot = path.join(storageRoot, "workspaces", runId);
  const profile = await prepareRuntimeProfile({
    mode,
    currentCodexHome,
    tempRoot: path.join(matrixCacheRoot, "profiles", mode),
    workspaceRoot
  });
  if (!["cold", "steady"].includes(startupMode)) {
    throw new Error("startupMode must be cold or steady");
  }
  if (startupMode === "steady" && mode !== "orquesta") {
    throw new Error("steady startup is only supported for Orquesta mode");
  }
  let run = await startRun({
    benchmarkRoot,
    storageRoot,
    sessionsRoots: [{
      label: mode,
      sessionsRoot: path.join(profile.codex_home, "sessions")
    }],
    taskId,
    mode,
    matrixId,
    runId
  });

  let outcome;
  try {
    if (mode === "orquesta") {
      const adapter = snapshotAdapter({ runtimeRoot, profile });
      const agentExecutor = createAppServerAgentExecutor({
        adapter,
        profile,
        workspaceRoot: run.workspace_root
      });
      const dispatchObserver = createExecutionKernelBenchmarkShadow({
        runtimeRoot,
        workspaceRoot: run.workspace_root,
        actualRoute: kernelMode === "active" ? "kernel" : "legacy"
      });
      const specialistScheduler = kernelMode === "active"
        ? createExecutionKernelSpecialistScheduler({
          runtimeRoot,
          workspaceRoot: run.workspace_root
        })
        : null;
      let steadyPreparation = null;
      let foundationSessionPool = null;
      if (startupMode === "steady") {
        foundationSessionPool = {};
        steadyPreparation = await prepareSteadyOrquestaTask({
          workspaceRoot: run.workspace_root,
          runtimeRoot,
          setupRuntime: createSnapshotSetupRuntime({
            runtimeRoot,
            workspaceRoot: run.workspace_root,
            projectName: `Benchmark: ${run.task_id}`,
            description: run.prompt,
          }),
          agentExecutor,
          foundationSessionPool,
        });
        run = await rebaselineRunMeasurement({
          storageRoot,
          runId: run.run_id,
        });
      }
      outcome = await runOrquestaTask({
        workspaceRoot: run.workspace_root,
        runtimeRoot,
        prompt: run.prompt,
        setupRuntime: createSnapshotSetupRuntime({
          runtimeRoot,
          workspaceRoot: run.workspace_root,
          projectName: `Benchmark: ${run.task_id}`,
          description: run.prompt,
        }),
        agentExecutor,
        dispatchObserver,
        specialistScheduler,
        startupMode,
        foundationSessionPool,
        preparedSetup: steadyPreparation,
        acceptanceVerifier: async () => ({
          ...(await verifyTask({
            benchmarkRoot,
            taskId: run.task_id,
            workspaceRoot: run.workspace_root,
            timeoutMs: run.runtime.verifier_timeout_sec * 1000,
          })),
          acceptance_authority: "deterministic",
        }),
      });
      if (steadyPreparation) outcome.warmup_evidence = steadyPreparation.metrics;
      outcome.execution_kernel_mode = kernelMode;
    } else {
      const adapter = createDefaultAppServerAdapter({ profile });
      outcome = await runAppServerTask({
        adapter,
        profile,
        workspaceRoot: run.workspace_root,
        prompt: run.prompt,
        correlationPrefix: `${matrixId}-${mode}`
      });
    }
  } catch (error) {
    outcome = infrastructureOutcome(error);
  }

  outcome.thread_ids = collectThreadIds(outcome);
  const observed = buildEnvironmentObservation({
    mode,
    profile,
    outcome,
    runtimeSnapshotHash: snapshot.runtime_snapshot_sha256
  });
  const environmentAudit = auditEnvironment({
    mode,
    expectedRuntime: profile.execution,
    observed
  });
  const sourceStability = await verifyV4FastSource({
    sourceRoot: repositoryRoot,
    identity: snapshot
  });
  if (!environmentAudit.valid || !sourceStability.valid) {
    outcome = {
      ...outcome,
      status: "invalid",
      error: {
        code: environmentAudit.valid
          ? "runtime_drift"
          : "environment_contamination",
        message: environmentAudit.valid
          ? `V4-fast source changed: ${sourceStability.changed.join(", ")}`
          : environmentAudit.violations.join("; ")
      }
    };
  }
  outcome.environment_evidence = observed;
  outcome.environment_audit = environmentAudit;
  outcome.source_stability = sourceStability;
  outcome.runtime_snapshot_sha256 = snapshot.runtime_snapshot_sha256;

  return finalizeRun({
    benchmarkRoot,
    storageRoot,
    runId: run.run_id,
    executionOutcome: outcome
  });
}

function defaultMatrixId() {
  return `matrix-${new Date().toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(/\.\d{3}Z$/, "Z")
    .toLowerCase()}`;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const matrixId = args.matrix_id || defaultMatrixId();
  const taskId = args.task || "organization-json-generator";
  const kernelMode = args.kernel_mode || "shadow";
  const startupMode = args.startup_mode || "cold";
  if (!["shadow", "active"].includes(kernelMode)) {
    throw new Error("--kernel-mode must be shadow or active");
  }
  if (!["cold", "steady"].includes(startupMode)) {
    throw new Error("--startup-mode must be cold or steady");
  }
  if (startupMode === "steady" && (args.mode || null) !== "orquesta") {
    throw new Error("--startup-mode steady requires --mode orquesta");
  }
  const modes = args.mode ? [args.mode] : MODES;
  const storageRoot = args.storage_root
    ? path.resolve(args.storage_root)
    : benchmarkRoot;
  const preflightPath = args.preflight
    ? path.resolve(args.preflight)
    : path.join(benchmarkRoot, ".cache", "preflight-latest.json");
  const preflight = await readJson(preflightPath);
  assertPreflightReady(preflight);

  await prepareTasks({ benchmarkRoot });
  const matrixCacheRoot = path.join(benchmarkRoot, ".cache", "matrices", matrixId);
  const snapshotRoot = path.join(matrixCacheRoot, "v4-fast");
  const snapshot = await createV4FastSnapshot({
    sourceRoot: repositoryRoot,
    destination: snapshotRoot
  });
  const runtimeRoot = path.join(snapshotRoot, "runtime");
  const currentCodexHome = process.env.CODEX_HOME
    || path.join(os.homedir(), ".codex");

  const matrix = await executeMatrixPlan({
    matrixId,
    storageRoot,
    preflight,
    taskId,
    modes,
    async runMode(plan) {
      process.stdout.write(`${JSON.stringify({
        event: "mode_started",
        mode: plan.mode,
        run_id: plan.runId,
        at: new Date().toISOString()
      })}\n`);
      const result = await runFormalMode({
        ...plan,
        storageRoot,
        currentCodexHome,
        matrixCacheRoot,
        snapshot,
        runtimeRoot,
        kernelMode,
        startupMode,
      });
      process.stdout.write(`${JSON.stringify({
        event: "mode_finished",
        mode: result.mode,
        run_id: result.run_id,
        status: result.status,
        verifier_passed: result.verifier?.passed === true,
        at: new Date().toISOString()
      })}\n`);
      return result;
    }
  });
  const report = matrix.results.length === MODES.length
    ? renderMarkdownReport([compareMatrix(matrix.results)])
    : [
      "# Orquesta benchmark single-condition run",
      "",
      `Task: ${taskId}`,
      `Mode: ${matrix.results[0]?.mode || "unknown"}`,
      `Status: ${matrix.results[0]?.status || "unknown"}`,
      `Verifier passed: ${matrix.results[0]?.verifier?.passed === true}`,
      `Wall time: ${matrix.results[0]?.wall_time_ms ?? "unknown"} ms`,
      `Total tokens: ${matrix.results[0]?.token_usage?.totals?.total_tokens ?? "unknown"}`,
      ""
    ].join("\n");
  const reportPath = args.output
    ? path.resolve(args.output)
    : path.join(benchmarkRoot, "reports", `${matrixId}.md`);
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, report, "utf8");
  await fs.writeFile(
    path.join(matrixCacheRoot, "matrix.json"),
    `${JSON.stringify({
      schema_version: 1,
      matrix_id: matrixId,
      task_id: taskId,
      modes,
      preflight_path: preflightPath,
      runtime_snapshot: snapshot,
      execution_kernel_mode: kernelMode,
      startup_mode: startupMode,
      run_ids: matrix.results.map((result) => result.run_id),
      report_path: reportPath
    }, null, 2)}\n`,
    "utf8"
  );
  process.stdout.write(`${JSON.stringify({
    status: "complete",
    matrix_id: matrixId,
    task_id: taskId,
    runtime_snapshot_sha256: snapshot.runtime_snapshot_sha256,
    results: matrix.results.map((result) => ({
      mode: result.mode,
      run_id: result.run_id,
      status: result.status,
      verifier_passed: result.verifier?.passed === true
    })),
    report: reportPath
  }, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    process.stderr.write(`Benchmark matrix failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
