"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  buildSourceCatalogV2,
  compileContextPackV2Shadow,
  createProjectControlPlaneV2,
  createTaskEnvelopeV2,
  deriveContextRequirementV2,
  summarizeContextVariantComparison,
} = require("../../packages/context-compiler/src");
const { createTaskIntent } = require("../../packages/core/src/task-intent");
const { writeJsonAtomic } = require("./json-state");
const { runCli: runBroker } = require("./context-v2-broker");

const TASK_ID = "CANARY-RETRIEVAL-001";
const SENTINEL = "ALPHA-73";

function capture() {
  let value = "";
  return { stdout: { write(chunk) { value += String(chunk); } }, value: () => value };
}

function textFromOpened(opened) {
  return (Array.isArray(opened) ? opened : []).map((entry) => entry?.content || "").join("\n");
}

async function runRetrievalCanary({ workspaceRoot, reportPath, now = () => new Date().toISOString() }) {
  const root = path.resolve(workspaceRoot);
  const timestamp = now();
  fs.mkdirSync(path.join(root, "project"), { recursive: true });
  fs.writeFileSync(path.join(root, "project", "overview.md"), "# Release overview\nThe deployment codename is recorded in the bounded constraints source.\n", "utf8");
  fs.writeFileSync(path.join(root, "project", "bounded-constraints.md"), [
    "# Bounded deployment constraints",
    `The authoritative deployment codename is ${SENTINEL}.`,
    "This source is intentionally larger than the initial context allowance.",
    "bounded retrieval evidence ".repeat(420),
  ].join("\n"), "utf8");

  const intent = createTaskIntent({
    rawRequestRef: "canary:bounded-retrieval",
    desiredOutcome: "Report the authoritative deployment codename.",
    acceptanceCriteria: ["Use project/overview.md to locate the authoritative deployment codename without scanning unrelated files."],
    constraints: ["Use only cataloged project sources."],
    risk: { impact: "low", reversible: true },
    authorityBoundary: { agent_may: ["read"], user_only: ["publish"] },
    assumptions: [], status: "compiled",
  });
  const envelope = createTaskEnvelopeV2({ taskIntent: intent, options: {
    execution_channel: "independent_review", conversation_history_policy: "fresh",
  } });
  const requirement = deriveContextRequirementV2({
    taskIntent: intent,
    taskEnvelope: envelope,
    workItem: {
      project_scope: "local",
      decision_authority: "read_only",
      scope_boundaries: ["project/overview.md", "project/bounded-constraints.md"],
      artifact_types: ["documentation"],
      context_manifest: { required_reading: ["project/overview.md"] },
      initial_token_budget: 1200,
      expansion_budget: 4000,
    },
  });
  let catalog = buildSourceCatalogV2({
    workspaceRoot: root, taskIntent: intent, taskEnvelope: envelope, contextRequirement: requirement,
    sourceRefs: ["project/overview.md", "project/bounded-constraints.md"],
  });
  catalog = catalog.map((record) => record.source_ref === "project/bounded-constraints.md"
    ? { ...record, summary: "authoritative deployment codename bounded constraints" }
    : record);
  const compiled = compileContextPackV2Shadow({
    taskIntent: intent, taskEnvelope: envelope, contextRequirement: requirement,
    agentCapabilityProfile: { agent_id: "canary-research-001", capabilities: [], availability: "available", organization_revision: 1 },
    sourceCatalog: catalog,
  });
  const hidden = catalog.find((record) => record.source_ref === "project/bounded-constraints.md");
  if (!hidden || compiled.context_pack.selected_sources.includes(hidden.source_id)) {
    throw new Error("retrieval_canary_invalid:bounded_source_was_not_omitted_initially");
  }

  const contextRoot = path.join(root, ".orquesta", "context");
  writeJsonAtomic(path.join(root, ".orquesta", "state", "tasks.json"), { version: 1, tasks: [{
    task_id: TASK_ID, state: "working", owner_agent_id: "canary-research-001", task_intent: intent,
    task_profile: { task_envelope: envelope, context_requirement: requirement, context_pack_id: compiled.context_pack.context_pack_id },
  }] });
  writeJsonAtomic(path.join(contextRoot, "requirements", `${requirement.requirement_id}.json`), requirement);
  writeJsonAtomic(path.join(contextRoot, "packs", `${compiled.context_pack.context_pack_id}.json`), compiled.context_pack);
  writeJsonAtomic(path.join(contextRoot, "source_catalog.json"), { version: 2, records: catalog });
  writeJsonAtomic(path.join(contextRoot, "shadow_index.json"), { version: 2, comparisons: [{
    task_id: TASK_ID, owner_agent_id: "canary-research-001", task_envelope_id: envelope.task_envelope_id,
    context_requirement_id: requirement.requirement_id, context_pack_id: compiled.context_pack.context_pack_id,
  }] });
  writeJsonAtomic(path.join(contextRoot, "project_control_plane.json"), createProjectControlPlaneV2({
    projectId: "context-retrieval-canary", revision: 1,
    projectBrief: { title: "Context retrieval canary", goal: intent.desired_outcome, source: "runtime_canary" },
    updatedAt: timestamp,
  }));

  const bootstrapOut = capture();
  const bootstrap = await runBroker(["--root", root, "--task", TASK_ID, "bootstrap"], { stdout: bootstrapOut.stdout, now });
  const initialPassed = textFromOpened(bootstrap.opened).includes(SENTINEL);
  const searchOut = capture();
  const search = await runBroker(["--root", root, "--task", TASK_ID, "search", "--query", "deployment codename"], { stdout: searchOut.stdout, now });
  const candidate = search.find((entry) => entry.source_id === hidden.source_id && entry.selected === false);
  if (!candidate) throw new Error("retrieval_canary_failed:bounded_source_not_found_by_search");
  await runBroker(["--root", root, "--task", TASK_ID, "missing", "--description", "authoritative deployment codename is absent from initial context"], { stdout: capture().stdout, now });
  const expansion = await runBroker(["--root", root, "--task", TASK_ID, "expand", "--source", candidate.source_id], { stdout: capture().stdout, now });
  const opened = await runBroker(["--root", root, "--task", TASK_ID, "open", "--source", candidate.source_id], { stdout: capture().stdout, now });
  const boundedPassed = String(opened.content || "").includes(SENTINEL) && expansion.expansion_tokens > 0;
  const rehydration = await runBroker(["--root", root, "--task", TASK_ID, "rehydrate"], { stdout: capture().stdout, now });

  const common = { scenario_id: "bounded-retrieval-required", retrieval_required: true, major_regression: false, user_corrections: 0, incorrect_project_facts: 0, cold_cost_explainable: true, steady_cost_explainable: true };
  const rows = [
    { ...common, variant: "v1", quality_passed: true },
    { ...common, variant: "fixed_minimal", quality_passed: true },
    { ...common, variant: "v2_initial", quality_passed: initialPassed },
    { ...common, variant: "v2_bounded_retrieval", quality_passed: boundedPassed },
  ];
  const comparison = summarizeContextVariantComparison(rows);
  const result = {
    schema_version: 1, status: comparison.passed && !initialPassed && boundedPassed && rehydration.status === "rehydrated" ? "passed" : "failed",
    task_id: TASK_ID, sentinel: SENTINEL, initial_context_insufficient: !initialPassed,
    search_found_omitted_source: Boolean(candidate), expansion_tokens: expansion.expansion_tokens,
    bounded_retrieval_recovered: boundedPassed,
    post_compaction_rehydration: {
      status: rehydration.status,
      strategy: rehydration.strategy,
      opened_source_refs: rehydration.opened.map((entry) => entry.source_ref),
      deferred_source_refs: rehydration.deferred.map((entry) => entry.source_ref),
      stale_source_ids: rehydration.stale_source_ids,
    },
    variant_comparison: comparison,
    workspace_root: root, observed_at: timestamp,
  };
  writeJsonAtomic(reportPath, result);
  if (result.status !== "passed") throw new Error(`retrieval_canary_failed:${JSON.stringify(result)}`);
  return result;
}

function option(argv, name) { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : null; }

if (require.main === module) {
  const argv = process.argv.slice(2);
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const workspaceRoot = option(argv, "--workspace") || path.join(process.cwd(), "benchmarks", "orquesta-v4-product", ".cache", "context-retrieval-canary", stamp);
  const reportPath = option(argv, "--report") || path.join(process.cwd(), "benchmarks", "orquesta-v4-product", "reports", `context-retrieval-canary-${stamp}.json`);
  runRetrievalCanary({ workspaceRoot, reportPath }).then((result) => {
    process.stdout.write(`${JSON.stringify({ ...result, report_path: path.resolve(reportPath) }, null, 2)}\n`);
  }).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

module.exports = { SENTINEL, TASK_ID, runRetrievalCanary };
