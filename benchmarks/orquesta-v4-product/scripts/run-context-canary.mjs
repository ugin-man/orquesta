import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import {
  createDefaultAppServerAdapter,
  runAppServerTask,
} from "./lib/app-server-runner.mjs";
import { parseArgs } from "./lib/cli.mjs";
import {
  CANARY_DIRECT_SOURCES,
  CONTEXT_VARIANTS,
  contextPrompt,
  estimateVariantContext,
  writeLegacyNoise,
} from "./lib/context-variant-canary.mjs";
import { finalizeRun, startRun } from "./lib/lifecycle.mjs";
import { benchmarkRoot, repositoryRoot } from "./lib/paths.mjs";
import { prepareRuntimeProfile } from "./lib/runtime-profiles.mjs";
import { prepareTasks } from "./lib/tasks.mjs";
import { assertPreflightReady } from "./preflight.mjs";

const require = createRequire(path.join(repositoryRoot, "package.json"));
const {
  buildSourceCatalogV2,
  compileContextPackV2Shadow,
  createProjectControlPlaneV2,
  createTaskEnvelopeV2,
  deriveContextRequirementV2,
} = require(path.join(repositoryRoot, "packages", "context-compiler", "src"));

const TASK_ID = "worldbuilding-consistency-review";
const CONTEXT_TASK_ID = "CTX-WORLDBUILDING-001";

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, value, "utf8");
}

function defaultMatrixId() {
  return `context-canary-${new Date().toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(/\.\d{3}Z$/u, "z")
    .toLowerCase()}`;
}

function taskIntent(benchmarkPrompt) {
  return {
    task_intent_id: "TI-context-canary-worldbuilding",
    raw_request_ref: "benchmark:worldbuilding-consistency-review",
    desired_outcome: benchmarkPrompt,
    acceptance_criteria: [
      "Compare lore/world.md with characters/aria.md and report every supported contradiction.",
      "Compare lore/world.md with scenes/chapter-4.md and report every supported contradiction.",
      "Write reports/worldbuilding-consistency.json with category, severity, summary, and source_refs.",
    ],
    constraints: [
      "Do not rewrite the lore.",
      "Do not load unrelated project history.",
    ],
    risk: { impact: "low", reversible: true },
    authority_boundary: {
      agent_may: ["read", "review", "write"],
      user_only: ["publish"],
    },
    assumptions: [],
    status: "approved",
  };
}

async function installCanaryRuntime(workspaceRoot) {
  const skillTarget = path.join(workspaceRoot, ".agents", "skills", "orquesta");
  await fs.mkdir(path.dirname(skillTarget), { recursive: true });
  await fs.cp(path.join(repositoryRoot, "orquesta"), skillTarget, { recursive: true });
  await writeLegacyNoise(workspaceRoot);
}

async function createContextRuntime({ workspaceRoot, benchmarkPrompt }) {
  const intent = taskIntent(benchmarkPrompt);
  const envelope = createTaskEnvelopeV2({
    taskIntent: intent,
    options: {
      workstream_id: "benchmark:worldbuilding-continuity",
      terminal_outcome: "Produce the verified continuity report.",
      local_deliverable: "reports/worldbuilding-consistency.json",
      execution_channel: "independent_review",
      conversation_history_policy: "fresh",
    },
  });
  const requirement = deriveContextRequirementV2({
    taskIntent: intent,
    taskEnvelope: envelope,
    workItem: {
      project_scope: "component",
      scope_boundaries: [...CANARY_DIRECT_SOURCES],
      knowledge_domains: ["worldbuilding.continuity"],
      artifact_types: ["documentation"],
      context_manifest: {
        required_reading: [...CANARY_DIRECT_SOURCES],
        excluded_context: [".benchmark-context"],
      },
      initial_token_budget: 4_000,
      expansion_budget: 2_000,
    },
    capabilityNeeds: [{
      capability_id: "worldbuilding.continuity",
      knowledge_domains: ["worldbuilding.continuity"],
    }],
  });
  const catalog = buildSourceCatalogV2({
    workspaceRoot,
    taskIntent: intent,
    taskEnvelope: envelope,
    contextRequirement: requirement,
    sourceRefs: [...CANARY_DIRECT_SOURCES],
  });
  const compiled = compileContextPackV2Shadow({
    taskIntent: intent,
    taskEnvelope: envelope,
    contextRequirement: requirement,
    agentCapabilityProfile: {
      agent_id: "continuity-review-001",
      capabilities: [{
        capability_id: "worldbuilding.continuity",
        status: "verified",
        evidence_refs: ["benchmark:worldbuilding-consistency-review"],
        scope: [...CANARY_DIRECT_SOURCES],
      }],
      availability: "available",
      organization_revision: 1,
    },
    sourceCatalog: catalog,
  });
  const selectedRefs = new Set(compiled.selected_source_records.map((record) => record.source_ref));
  const missing = CANARY_DIRECT_SOURCES.filter((source) => !selectedRefs.has(source));
  if (missing.length > 0) {
    throw new Error(`context canary pack omitted required sources: ${missing.join(", ")}`);
  }
  const contextRoot = path.join(workspaceRoot, ".orquesta", "context");
  const tasksRoot = path.join(workspaceRoot, ".orquesta", "state");
  await Promise.all([
    writeJson(path.join(contextRoot, "requirements", `${requirement.requirement_id}.json`), requirement),
    writeJson(path.join(contextRoot, "packs", `${compiled.context_pack.context_pack_id}.json`), compiled.context_pack),
    writeJson(path.join(contextRoot, "source_catalog.json"), {
      version: 2,
      records: catalog,
    }),
    writeJson(path.join(contextRoot, "shadow_index.json"), {
      version: 2,
      comparisons: [{
        task_id: CONTEXT_TASK_ID,
        owner_agent_id: "continuity-review-001",
        task_envelope_id: envelope.task_envelope_id,
        context_requirement_id: requirement.requirement_id,
        context_pack_id: compiled.context_pack.context_pack_id,
      }],
    }),
    writeJson(path.join(contextRoot, "project_control_plane.json"), createProjectControlPlaneV2({
      projectId: "benchmark-worldbuilding",
      revision: 1,
      activeWorkstream: {
        workstream_id: "benchmark:worldbuilding-continuity",
        task_id: CONTEXT_TASK_ID,
        current_goal: "Produce the verified continuity report.",
        next_decision: "Accept or reject the continuity findings.",
      },
      projectBrief: {
        title: "Worldbuilding continuity canary",
        goal: benchmarkPrompt,
        source: "benchmark",
      },
      updatedAt: new Date().toISOString(),
    })),
    writeJson(path.join(tasksRoot, "tasks.json"), {
      version: 1,
      tasks: [{
        task_id: CONTEXT_TASK_ID,
        title: "Review worldbuilding continuity",
        state: "in_progress",
        owner_agent_id: "continuity-review-001",
        task_intent: intent,
        task_profile: {
          task_envelope: envelope,
          context_requirement: requirement,
          context_pack_id: compiled.context_pack.context_pack_id,
        },
      }],
    }),
    writeJson(path.join(workspaceRoot, ".orquesta", "project", "project_understanding.json"), {
      version: 1,
      project_name: "Worldbuilding continuity canary",
      goal: benchmarkPrompt,
      evidence: CANARY_DIRECT_SOURCES.map((source) => ({ path: source })),
    }),
    writeText(
      path.join(workspaceRoot, ".orquesta", "CURRENT_ORCHESTRA.md"),
      "# Current Orquesta\n\nContext canary fixture. No production state.\n",
    ),
  ]);
  return {
    intent,
    envelope,
    requirement,
    contextPack: compiled.context_pack,
  };
}

async function brokerSession(workspaceRoot) {
  const file = path.join(
    workspaceRoot,
    ".orquesta",
    "context",
    "sessions",
    `${encodeURIComponent(CONTEXT_TASK_ID)}.json`,
  );
  return fs.stat(file).then(() => readJson(file), () => null);
}

function summaryRow(result, estimate, session) {
  const usage = result.phase_token_usage?.main?.totals || result.token_usage?.totals || {};
  return {
    variant: result.execution_outcome.context_variant,
    quality_passed: result.verifier?.passed === true,
    status: result.status,
    initial_context_token_estimate: estimate.token_estimate,
    observed_opened_tokens: session?.opened_tokens ?? null,
    observed_expansion_tokens: session?.expansion_tokens ?? null,
    input_tokens: usage.input_tokens ?? null,
    cached_input_tokens: usage.cached_input_tokens ?? null,
    uncached_input_tokens: usage.uncached_input_tokens ?? null,
    output_tokens: usage.output_tokens ?? null,
    total_tokens: usage.total_tokens ?? null,
    wall_time_ms: result.execution_outcome.main_metrics.wall_time_ms,
    thread_id: result.execution_outcome.thread_id || null,
    run_id: result.run_id,
  };
}

function markdownReport(matrixId, taskId, rows) {
  const lines = [
    "# Context V2 canary",
    "",
    `Matrix: ${matrixId}`,
    `Task: ${taskId}`,
    "",
    "| Variant | Quality | Initial estimate | Uncached input | Cached input | Total tokens | Wall time | Broker opened | Expansion |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const row of rows) {
    lines.push(
      `| ${row.variant} | ${row.quality_passed ? "pass" : "fail"}`
      + ` | ${row.initial_context_token_estimate ?? "n/a"}`
      + ` | ${row.uncached_input_tokens ?? "n/a"}`
      + ` | ${row.cached_input_tokens ?? "n/a"}`
      + ` | ${row.total_tokens ?? "n/a"}`
      + ` | ${row.wall_time_ms} ms`
      + ` | ${row.observed_opened_tokens ?? "n/a"}`
      + ` | ${row.observed_expansion_tokens ?? "n/a"} |`,
    );
  }
  lines.push(
    "",
    "This is a single-specialist cold canary. It isolates context delivery and does not measure full Orquesta bootstrap cost.",
    "",
  );
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const taskId = args.task || TASK_ID;
  if (taskId !== TASK_ID) {
    throw new Error(`the first context canary currently supports only ${TASK_ID}`);
  }
  const variants = args.variants
    ? args.variants.split(",").map((value) => value.trim()).filter(Boolean)
    : [...CONTEXT_VARIANTS];
  if (variants.length === 0 || variants.some((variant) => !CONTEXT_VARIANTS.includes(variant))) {
    throw new Error(`--variants must use: ${CONTEXT_VARIANTS.join(", ")}`);
  }
  const matrixId = args.matrix_id || defaultMatrixId();
  const storageRoot = args.storage_root ? path.resolve(args.storage_root) : benchmarkRoot;
  const preflight = await readJson(path.join(benchmarkRoot, ".cache", "preflight-latest.json"));
  assertPreflightReady(preflight);
  await prepareTasks({ benchmarkRoot });
  const currentCodexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const cacheRoot = path.join(benchmarkRoot, ".cache", "context-canary", matrixId);
  const rows = [];
  const brokerPath = path.join(repositoryRoot, "orquesta", "scripts", "context-v2-broker.js");

  for (const variant of variants) {
    const runId = `${matrixId}-${variant}`;
    process.stdout.write(`${JSON.stringify({ event: "variant_started", variant, run_id: runId })}\n`);
    const profile = await prepareRuntimeProfile({
      mode: "orquesta",
      currentCodexHome,
      tempRoot: path.join(cacheRoot, "profiles", variant),
      workspaceRoot: path.join(storageRoot, "workspaces", runId),
    });
    profile.execution = {
      ...profile.execution,
      model: "gpt-5.6-terra",
      reasoning_effort: "medium",
      agent_timeout_sec: 420,
    };
    const run = await startRun({
      benchmarkRoot,
      storageRoot,
      sessionsRoots: [{
        label: variant,
        sessionsRoot: path.join(profile.codex_home, "sessions"),
      }],
      taskId,
      mode: "orquesta",
      matrixId,
      runId,
    });
    await installCanaryRuntime(run.workspace_root);
    const context = await createContextRuntime({
      workspaceRoot: run.workspace_root,
      benchmarkPrompt: run.prompt,
    });
    const estimate = await estimateVariantContext({
      variant,
      workspaceRoot: run.workspace_root,
      contextPack: context.contextPack,
    });
    const prompt = contextPrompt({
      variant,
      benchmarkPrompt: run.prompt,
      workspaceRoot: run.workspace_root,
      taskId: CONTEXT_TASK_ID,
      brokerPath,
    });
    const adapter = createDefaultAppServerAdapter({ profile });
    const mainStartedAt = Date.now();
    let outcome = await runAppServerTask({
      adapter,
      profile,
      workspaceRoot: run.workspace_root,
      prompt,
      correlationPrefix: `${matrixId}-${variant}`,
    });
    const mainEndedAt = Date.now();
    outcome = {
      ...outcome,
      context_variant: variant,
      startup_mode: "cold",
      thread_ids: [outcome.thread_id].filter(Boolean),
      main_metrics: {
        started_at_ms: mainStartedAt,
        ended_at_ms: mainEndedAt,
        wall_time_ms: mainEndedAt - mainStartedAt,
      },
    };
    const result = await finalizeRun({
      benchmarkRoot,
      storageRoot,
      runId,
      executionOutcome: outcome,
    });
    const session = await brokerSession(run.workspace_root);
    const row = summaryRow(result, estimate, session);
    rows.push(row);
    process.stdout.write(`${JSON.stringify({ event: "variant_finished", ...row })}\n`);
    if (result.status === "infrastructure_error") break;
  }

  const reportRoot = path.join(benchmarkRoot, "reports");
  await fs.mkdir(reportRoot, { recursive: true });
  const reportPath = path.join(reportRoot, `${matrixId}.md`);
  const jsonPath = path.join(reportRoot, `${matrixId}.json`);
  await fs.writeFile(reportPath, markdownReport(matrixId, taskId, rows), "utf8");
  await writeJson(jsonPath, {
    schema_version: 1,
    matrix_id: matrixId,
    task_id: taskId,
    execution: {
      model: "gpt-5.6-terra",
      reasoning_effort: "medium",
      topology: "single_specialist",
      startup: "cold",
    },
    rows,
  });
  process.stdout.write(`${JSON.stringify({
    status: rows.length === variants.length ? "complete" : "stopped",
    matrix_id: matrixId,
    rows,
    report: reportPath,
    data: jsonPath,
  }, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    process.stderr.write(`Context canary failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
