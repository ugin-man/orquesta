import fs from "node:fs/promises";
import path from "node:path";

import {
  assertValid,
  validateManifest,
  validateRunResult
} from "./contract.mjs";
import {
  captureWorkspacePatch,
  initializeGitWorkspace,
  workspaceFingerprint
} from "./git.mjs";
import { readOrquestaMetrics } from "./orquesta-metrics.mjs";
import {
  loadRun,
  runDirectory,
  saveRun,
  writeJsonAtomic
} from "./run-store.mjs";
import {
  measureSessionRootsDelta,
  snapshotSessions
} from "./session-usage.mjs";
import {
  createTaskWorkspace,
  taskInstruction,
  verifyTask
} from "./tasks.mjs";

async function readManifest(benchmarkRoot) {
  const manifest = JSON.parse(
    await fs.readFile(path.join(benchmarkRoot, "manifest.json"), "utf8")
  );
  assertValid("benchmark manifest", validateManifest(manifest));
  return manifest;
}

function defaultRunId(matrixId, mode) {
  return `${matrixId}-${mode}`;
}

export async function startRun({
  benchmarkRoot,
  storageRoot = benchmarkRoot,
  sessionsRoots,
  taskId,
  mode,
  matrixId,
  instruction,
  runId,
  startedAt = new Date().toISOString(),
  createTaskWorkspaceImpl = createTaskWorkspace
}) {
  const manifest = await readManifest(benchmarkRoot);
  if (!manifest.modes.includes(mode)) throw new Error(`unknown benchmark mode: ${mode}`);
  if (!manifest.tasks.some((task) => task.id === taskId)) {
    throw new Error(`unknown benchmark task: ${taskId}`);
  }
  if (typeof matrixId !== "string" || !matrixId.trim()) {
    throw new Error("matrixId is required");
  }
  if (!Array.isArray(sessionsRoots) || sessionsRoots.length === 0) {
    throw new Error("sessionsRoots is required");
  }
  const finalRunId = runId || defaultRunId(matrixId, mode);
  const runDir = runDirectory(storageRoot, finalRunId);
  if (await fs.stat(runDir).then(() => true, () => false)) {
    throw new Error(`run already exists: ${finalRunId}`);
  }
  const workspaceRoot = path.join(storageRoot, "workspaces", finalRunId);
  await createTaskWorkspaceImpl({
    benchmarkRoot,
    taskId,
    destination: workspaceRoot
  });
  initializeGitWorkspace(workspaceRoot);
  const sessionEvidenceRoots = [];
  for (const root of sessionsRoots) {
    sessionEvidenceRoots.push({
      label: root.label,
      sessionsRoot: root.sessionsRoot,
      baseline: await snapshotSessions({
        sessionsRoot: root.sessionsRoot,
        workspaceRoot
      })
    });
  }
  const prompt = instruction ?? await taskInstruction({ benchmarkRoot, taskId });
  const run = {
    schema_version: 2,
    run_id: finalRunId,
    matrix_id: matrixId,
    benchmark_id: manifest.benchmark_id,
    task_id: taskId,
    mode,
    status: "running",
    started_at: startedAt,
    runtime: structuredClone(manifest.execution),
    workspace_root: workspaceRoot,
    run_dir: runDir,
    session_evidence_roots: sessionEvidenceRoots,
    prompt,
    user_interventions: []
  };
  await saveRun(storageRoot, run);
  return run;
}

export async function recordUserIntervention({
  storageRoot,
  runId,
  at = new Date().toISOString(),
  kind = "other"
}) {
  const allowed = new Set(["question_answered", "manual_edit", "other"]);
  if (!allowed.has(kind)) throw new Error(`unsupported intervention kind: ${kind}`);
  const run = await loadRun(storageRoot, runId);
  if (run.status !== "running") {
    throw new Error(`cannot annotate a finalized run: ${runId}`);
  }
  const updated = {
    ...run,
    user_interventions: [...run.user_interventions, { at, kind }]
  };
  await saveRun(storageRoot, updated);
  return updated.user_interventions.at(-1);
}

export async function rebaselineRunMeasurement({
  storageRoot,
  runId,
  startedAt = new Date().toISOString(),
}) {
  const run = await loadRun(storageRoot, runId);
  if (run.status !== "running") {
    throw new Error(`cannot rebaseline a finalized run: ${runId}`);
  }
  const sessionEvidenceRoots = [];
  for (const root of run.session_evidence_roots || []) {
    sessionEvidenceRoots.push({
      label: root.label,
      sessionsRoot: root.sessionsRoot,
      baseline: await snapshotSessions({
        sessionsRoot: root.sessionsRoot,
        workspaceRoot: run.workspace_root,
      }),
    });
  }
  const updated = {
    ...run,
    measurement_window: {
      kind: "post_foundation_warmup",
      original_started_at: run.started_at,
      started_at: startedAt,
    },
    started_at: startedAt,
    session_evidence_roots: sessionEvidenceRoots,
  };
  await saveRun(storageRoot, updated);
  return updated;
}

function finalizedStatus(executionOutcome, verifier) {
  if (executionOutcome?.status === "timeout") return "timeout";
  if (executionOutcome?.status === "infrastructure_error") return "infrastructure_error";
  if (executionOutcome?.status === "invalid") return "invalid";
  if (verifier.status === "infrastructure_error") return "infrastructure_error";
  return "finalized";
}

function phaseTime(value) {
  if (!Number.isFinite(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

async function phaseTokenUsage({ run, executionOutcome }) {
  if (run.mode !== "orquesta") return null;
  const bootstrapStartedAt = phaseTime(executionOutcome?.bootstrap_metrics?.started_at_ms);
  const bootstrapEndedAt = phaseTime(executionOutcome?.bootstrap_metrics?.ended_at_ms);
  const mainStartedAt = phaseTime(executionOutcome?.main_metrics?.started_at_ms);
  const mainEndedAt = phaseTime(executionOutcome?.main_metrics?.ended_at_ms);
  const measure = async (startedAt, endedAt) => {
    if (!startedAt || !endedAt) {
      return {
        coverage: "unknown",
        reason: "phase timestamps were not observed"
      };
    }
    return measureSessionRootsDelta({
      roots: run.session_evidence_roots,
      workspaceRoot: run.workspace_root,
      startedAt,
      endedAt
    });
  };
  return {
    startup_mode: executionOutcome?.startup_mode || "unknown",
    foundation: {
      generated_count: executionOutcome?.bootstrap_metrics?.foundation_generated_count ?? null,
      reused_count: executionOutcome?.bootstrap_metrics?.foundation_reused_count ?? null
    },
    bootstrap: await measure(bootstrapStartedAt, bootstrapEndedAt),
    main: await measure(mainStartedAt, mainEndedAt)
  };
}

export async function finalizeRun({
  benchmarkRoot,
  storageRoot = benchmarkRoot,
  runId,
  endedAt = new Date().toISOString(),
  executionOutcome,
  verifyTaskImpl = verifyTask
}) {
  const run = await loadRun(storageRoot, runId);
  if (run.status !== "running") throw new Error(`run is already finalized: ${runId}`);
  const manifest = await readManifest(benchmarkRoot);
  const wallTime = Date.parse(endedAt) - Date.parse(run.started_at);
  if (!Number.isFinite(wallTime) || wallTime < 0) {
    throw new Error("run timestamps are invalid");
  }
  const tokenUsage = await measureSessionRootsDelta({
    roots: run.session_evidence_roots,
    workspaceRoot: run.workspace_root,
    startedAt: run.started_at,
    endedAt
  });
  const phaseTokens = await phaseTokenUsage({ run, executionOutcome });
  const patch = captureWorkspacePatch(run.workspace_root);
  await fs.writeFile(path.join(run.run_dir, "workspace.patch"), patch, "utf8");
  const workspace = await workspaceFingerprint(run.workspace_root);
  const verifier = await verifyTaskImpl({
    benchmarkRoot,
    taskId: run.task_id,
    workspaceRoot: run.workspace_root,
    timeoutMs: run.runtime.verifier_timeout_sec * 1000
  });
  await fs.writeFile(
    path.join(run.run_dir, "verifier.txt"),
    `${verifier.output || ""}\n`,
    "utf8"
  );
  const orquestaMetrics = run.mode === "orquesta"
    ? await readOrquestaMetrics(run.workspace_root)
    : {
      handoffs: 0,
      independent_reviews: 0,
      correction_batches: 0
    };
  const status = finalizedStatus(executionOutcome, verifier);
  const observedThreads = new Set(executionOutcome?.thread_ids || []);
  const result = {
    schema_version: 2,
    run_id: run.run_id,
    matrix_id: run.matrix_id,
    benchmark_id: run.benchmark_id,
    task_id: run.task_id,
    mode: run.mode,
    status,
    runtime: run.runtime,
    started_at: run.started_at,
    ended_at: endedAt,
    wall_time_ms: wallTime,
    verifier,
    token_usage: tokenUsage,
    phase_token_usage: phaseTokens,
    diagnostics: {
      participating_threads: Math.max(
        observedThreads.size,
        tokenUsage.by_thread.length
      ),
      agent_turns: tokenUsage.turn_count,
      handoffs: orquestaMetrics.handoffs,
      independent_reviews: orquestaMetrics.independent_reviews,
      correction_batches: orquestaMetrics.correction_batches,
      user_interventions: run.user_interventions.length,
      approval_requests: (executionOutcome?.events || [])
        .filter((event) => event.type === "approval_requested")
        .length
    },
    execution_outcome: executionOutcome,
    workspace
  };
  assertValid("run result", validateRunResult(result, manifest));
  await writeJsonAtomic(path.join(run.run_dir, "result.json"), result);
  await saveRun(storageRoot, {
    ...run,
    status,
    ended_at: endedAt,
    result_path: path.join(run.run_dir, "result.json"),
    session_evidence_roots: undefined
  });
  return result;
}
