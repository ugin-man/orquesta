import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  createDefaultAppServerAdapter,
  runAppServerTask
} from "./lib/app-server-runner.mjs";
import { auditEnvironment } from "./lib/environment-evidence.mjs";
import { initializeGitWorkspace } from "./lib/git.mjs";
import { benchmarkRoot } from "./lib/paths.mjs";
import {
  prepareRuntimeProfile,
  sharedExecutionContract
} from "./lib/runtime-profiles.mjs";
import { prepareTasks } from "./lib/tasks.mjs";
import { createV4FastSnapshot } from "./lib/v4-fast-snapshot.mjs";

const MODES = ["plain", "skills", "orquesta"];

export async function runPreflightMatrix({
  execution,
  probe
}) {
  const conditions = [];
  const errors = [];
  for (const mode of MODES) {
    try {
      const condition = await probe({ mode, execution });
      conditions.push(condition);
      if (!condition.valid) errors.push(`${mode} preflight failed`);
      for (const field of [
        "model",
        "reasoning_effort",
        "sandbox",
        "approval_policy"
      ]) {
        if (condition.observed?.[field] !== execution[field]) {
          errors.push(
            `${mode} ${field} mismatch: ${condition.observed?.[field]}`
          );
        }
      }
      if (condition.write_probe !== "passed") {
        errors.push(`${mode} write probe failed`);
      }
    } catch (error) {
      conditions.push({
        mode,
        valid: false,
        error: error.message
      });
      errors.push(`${mode} preflight error: ${error.message}`);
    }
  }
  const processIds = conditions
    .map((condition) => condition.process_id)
    .filter(Boolean);
  if (
    processIds.length !== MODES.length
    || new Set(processIds).size !== MODES.length
  ) {
    errors.push("conditions did not use independent App Server processes");
  }
  return {
    schema_version: 1,
    valid: errors.length === 0,
    execution,
    conditions,
    errors
  };
}

export function assertPreflightReady(preflight) {
  if (!preflight?.valid) {
    throw new Error(
      `benchmark preflight is not ready: ${(preflight?.errors || []).join("; ")}`
    );
  }
}

async function copyOrquestaSkill(runtimeRoot, workspaceRoot) {
  const target = path.join(workspaceRoot, ".agents", "skills", "orquesta");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.cp(path.join(runtimeRoot, "orquesta"), target, { recursive: true });
}

export async function runLiveProbe({
  mode,
  execution,
  currentCodexHome,
  tempRoot,
  runtimeRoot,
  runtimeSnapshotHash
}) {
  const workspaceRoot = path.join(tempRoot, "workspaces", mode);
  await fs.rm(workspaceRoot, { recursive: true, force: true });
  await fs.mkdir(workspaceRoot, { recursive: true });
  if (mode === "orquesta") await copyOrquestaSkill(runtimeRoot, workspaceRoot);
  await fs.writeFile(
    path.join(workspaceRoot, ".benchmark-preflight"),
    "isolated benchmark preflight workspace\n",
    "utf8"
  );
  initializeGitWorkspace(workspaceRoot);
  const profile = await prepareRuntimeProfile({
    mode,
    currentCodexHome,
    tempRoot: path.join(tempRoot, "profiles", mode),
    workspaceRoot
  });
  let processId = null;
  const diagnostics = [];
  const adapter = createDefaultAppServerAdapter({
    profile,
    onDiagnostic(diagnostic) {
      diagnostics.push(diagnostic);
    },
    spawnImpl(executable, args, options) {
      const child = spawn(executable, args, options);
      processId = String(child.pid);
      return child;
    }
  });
  const probePath = path.join(workspaceRoot, "preflight.txt");
  const probePassed = () => fs.readFile(probePath, "utf8").then(
    (value) => value.trim() === "orquesta-benchmark-preflight",
    () => false
  );
  const result = await runAppServerTask({
    adapter,
    profile,
    workspaceRoot,
    prompt: "Create preflight.txt containing exactly orquesta-benchmark-preflight and do not modify any other file.",
    timeoutMs: 90_000,
    interruptGraceMs: 10_000,
    successProbe: probePassed,
    successProbeIntervalMs: 100,
    correlationPrefix: `preflight-${mode}`
  });
  const writePassed = await probePassed();
  const observed = {
    model: result.actual_model,
    reasoning_effort: execution.reasoning_effort,
    sandbox: result.runtime_profile?.sandbox,
    approval_policy: result.runtime_profile?.approval_policy,
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
    instruction_sources: mode === "plain" ? ["system"] : ["system", "user"]
  };
  const environmentAudit = auditEnvironment({
    mode,
    expectedRuntime: execution,
    observed
  });
  return {
    mode,
    valid: ["completed", "probe_completed"].includes(result.status)
      && writePassed
      && environmentAudit.valid,
    process_id: processId,
    write_probe: writePassed ? "passed" : "failed",
    observed,
    environment_audit: environmentAudit,
    app_server_status: result.status,
    app_server_error: result.error || null,
    diagnostics,
    thread_id: result.thread_id || null
  };
}

async function main() {
  const tempRoot = path.join(benchmarkRoot, ".cache", "preflight");
  const snapshotRoot = path.join(tempRoot, "v4-fast");
  const preparedTasks = await prepareTasks({ benchmarkRoot });
  const snapshot = await createV4FastSnapshot({
    sourceRoot: path.resolve(benchmarkRoot, "..", ".."),
    destination: snapshotRoot
  });
  const execution = sharedExecutionContract();
  const currentCodexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const preflight = await runPreflightMatrix({
    execution,
    probe: ({ mode }) => runLiveProbe({
      mode,
      execution,
      currentCodexHome,
      tempRoot,
      runtimeRoot: path.join(snapshotRoot, "runtime"),
      runtimeSnapshotHash: snapshot.runtime_snapshot_sha256
    })
  });
  const output = path.join(benchmarkRoot, ".cache", "preflight-latest.json");
  await fs.writeFile(output, `${JSON.stringify({
    ...preflight,
    created_at: new Date().toISOString(),
    task_source_probe: {
      status: "passed",
      prepared_tasks: preparedTasks
    },
    runtime_snapshot: snapshot
  }, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({
    valid: preflight.valid,
    output,
    runtime_snapshot_sha256: snapshot.runtime_snapshot_sha256,
    task_source_probe: "passed",
    conditions: preflight.conditions.map(({ mode, valid, write_probe }) => ({
      mode,
      valid,
      write_probe
    })),
    errors: preflight.errors
  }, null, 2)}\n`);
  if (!preflight.valid) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    process.stderr.write(`Benchmark preflight failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
