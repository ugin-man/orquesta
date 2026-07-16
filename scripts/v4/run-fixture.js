"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { canonicalHash } = require("@orquesta/contracts");
const { createEventStore } = require("@orquesta/event-store");
const { createCommandBoundary, createProjectors } = require("@orquesta/core");
const { WEIGHTS_V1 } = require("@orquesta/audit");

const REPOSITORY_ROOT = path.resolve(__dirname, "..", "..");
const FIXTURES_ROOT = path.join(REPOSITORY_ROOT, "fixtures", "v4", "phase1");
const FIXTURE_IDS = Object.freeze(["local-reuse", "adapt-vs-build", "blocked-candidate"]);
const FIXTURE_CLOCK = "2026-07-16T10:04:41.631Z";

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function fixtureDirectory(fixtureId) {
  if (!FIXTURE_IDS.includes(fixtureId)) throw new Error(`Unknown V4 fixture: ${fixtureId}`);
  return path.join(FIXTURES_ROOT, fixtureId);
}

function loadFixture(fixtureId) {
  const directory = fixtureDirectory(fixtureId);
  return {
    task: readJson(path.join(directory, "task-intent.json")),
    providers: readJson(path.join(directory, "providers.json")),
  };
}

function loadFixtureExpected(fixtureId) {
  return readJson(path.join(fixtureDirectory(fixtureId), "expected.json"));
}

function workspaceFileHash(sourceUri) {
  if (typeof sourceUri !== "string" || !sourceUri.startsWith("workspace:")) return null;
  const relativePath = sourceUri.slice("workspace:".length);
  if (!relativePath || path.isAbsolute(relativePath)) throw new Error(`Fixture provider source must be workspace-relative: ${sourceUri}`);
  const filePath = path.resolve(REPOSITORY_ROOT, relativePath);
  const relative = path.relative(REPOSITORY_ROOT, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Fixture provider escapes the workspace: ${sourceUri}`);
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error(`Fixture provider source is not a regular file: ${sourceUri}`);
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function materializeProviders(input) {
  return input.providers.map((provider) => ({ ...provider, provider_hash: workspaceFileHash(provider.source_uri) }));
}

function fixtureAuditFacts(input, needId) {
  const facts = Array.isArray(input.audit_facts) ? input.audit_facts.map((fact) => JSON.parse(JSON.stringify(fact))) : [];
  if (input.build_audit_fact && typeof input.build_audit_fact === "object") {
    facts.push({ ...JSON.parse(JSON.stringify(input.build_audit_fact)), candidate_id: `build:${needId}` });
  }
  return facts;
}

function fixtureContextCompiler(providerById) {
  return ({ taskIntent, resolutions }) => {
    const selectedProviderIds = [...new Set(resolutions.map((resolution) => resolution.selected_provider_id).filter(Boolean))].sort(compareText);
    const required_reading = selectedProviderIds
      .map((providerId) => providerById.get(providerId))
      .filter(Boolean)
      .map((provider) => provider.source_uri.slice("workspace:".length))
      .filter((reference, index, values) => values.indexOf(reference) === index)
      .sort(compareText);
    const content = {
      task_intent_id: taskIntent.task_intent_id,
      owner_agent_id: "implementation-001",
      objective: taskIntent.desired_outcome,
      acceptance_criteria: [...taskIntent.acceptance_criteria],
      adopted_decisions: [],
      capability_resolutions: resolutions.map((resolution) => resolution.resolution_id).sort(compareText),
      required_reading,
      relevant_state_excerpts: [],
      interfaces: [],
      allowed_files: [],
      forbidden_actions: [],
      excluded_context: [],
      evidence_requirements: [...taskIntent.acceptance_criteria],
      provenance: [
        { kind: "task_intent", source_ref: `task_intent:${taskIntent.task_intent_id}`, source_hash: canonicalHash(taskIntent) },
        ...resolutions.map((resolution) => ({
          kind: "capability_resolution",
          source_ref: `resolution:${resolution.resolution_id}`,
          source_hash: canonicalHash(resolution),
        })),
      ].sort((left, right) => compareText(`${left.kind}:${left.source_ref}`, `${right.kind}:${right.source_ref}`)),
      token_budget: null,
      expires_at: null,
      status: "draft",
    };
    return { context_pack: { context_pack_id: `CP-${canonicalHash(content).slice(0, 12)}`, ...content } };
  };
}

function journalBatches(stateRoot) {
  const journalPath = path.join(stateRoot, "events.jsonl");
  if (!fs.existsSync(journalPath)) return [];
  const content = fs.readFileSync(journalPath, "utf8").trim();
  return content ? content.split("\n").map((line) => JSON.parse(line)) : [];
}

function fixtureCompletion(batches, fixtureId) {
  const prefix = `fixture:${fixtureId}:`;
  const fixtureBatches = batches.filter((batch) => batch.batch_id.startsWith(prefix));
  if (fixtureBatches.length === 0) return { status: "absent" };
  const byId = new Map(fixtureBatches.map((batch) => [batch.batch_id, batch]));
  const required = ["task-intent", "capability-compile", "inventory-refresh", "context-preview"];
  const missing = required.filter((name) => !byId.has(`${prefix}${name}`));
  const graph = byId.get(`${prefix}capability-compile`)?.events.find((event) => event.type === "capability.graph.compiled")?.payload.graph;
  if (!graph || !Array.isArray(graph.needs)) {
    throw new Error(`Fixture ${fixtureId} has incomplete Capability Graph evidence.`);
  }
  for (const need of graph.needs) {
    if (!byId.has(`${prefix}resolution:${need.need_id}`)) missing.push(`resolution:${need.need_id}`);
  }
  const preview = byId.get(`${prefix}context-preview`);
  const previewed = preview && preview.events.some((event) => event.type === "context.pack.created");
  if (!previewed) missing.push("context.pack.created");
  if (missing.length > 0) {
    throw new Error(`Fixture ${fixtureId} has partial journal evidence: ${[...new Set(missing)].sort(compareText).join(", ")}`);
  }
  return { status: "complete" };
}

function reviewView({ fixtureId, state, batches }) {
  const fixtureBatches = batches.filter((batch) => batch.batch_id.startsWith(`fixture:${fixtureId}:`));
  const events = fixtureBatches.flatMap((batch) => batch.events);
  const fixtureResolutions = events.filter((event) => event.type === "resolution.proposed").map((event) => event.payload.resolution);
  const resolution = fixtureResolutions.at(-1) || null;
  const evaluations = events.filter((event) => event.type === "candidate.evaluated").map((event) => event.payload.evaluation);
  const rawLeader = [...evaluations].sort((left, right) => right.candidate_score - left.candidate_score || compareText(left.candidate_id, right.candidate_id))[0] || null;
  const localInventoryRecorded = events.some((event) => event.type === "capability.inventory.refreshed" && event.payload.responsibility === "scout");
  const skipReasons = events.map((event) => event.payload.scout_skip_reason).filter(Boolean).sort(compareText);
  const auditionCompleted = events.some((event) => event.type === "candidate.audition.completed");
  const fixtureIds = [...new Set(state.task_intents.map((intent) => intent.raw_request_ref).filter((reference) => reference.startsWith("fixture:")).map((reference) => reference.slice("fixture:".length)))].sort(compareText);
  const rejectionGate = rawLeader && rawLeader.hard_gate_results.find((gate) => gate.status === "fail");
  const graph = events.find((event) => event.type === "capability.graph.compiled");
  const contextPack = events.filter((event) => event.type === "context.pack.created").at(-1)?.payload.context_pack || null;
  const providerEvidence = events.filter((event) => event.type === "capability.provider.discovered")
    .map((event) => ({
      provider_id: event.payload.provider.provider_id,
      source_uri: event.payload.provider.source_uri,
      source_type: event.payload.provider.source_type,
      provider_hash: event.payload.provider.provider_hash,
      evidence_refs: [...event.payload.provider.evidence_refs],
    }))
    .sort((left, right) => compareText(left.provider_id, right.provider_id));
  const evaluationEvidence = evaluations.filter((evaluation) => !resolution || evaluation.need_id === resolution.need_id)
    .map((evaluation) => ({
      candidate_id: evaluation.candidate_id,
      need_id: evaluation.need_id,
      axis_values: Object.fromEntries(Object.entries(evaluation.axes).map(([axis, evidence]) => [axis, evidence.value])),
      axis_contributions: Object.fromEntries(Object.entries(evaluation.axes).map(([axis, evidence]) => [axis, Number(((evidence.value * WEIGHTS_V1[axis]) / 100).toFixed(2)).toFixed(2)])),
      weighted_sum: evaluation.weighted_sum,
      candidate_score: evaluation.candidate_score,
      uncertainty_penalty: evaluation.uncertainty_penalty,
      hard_gates: Object.fromEntries(evaluation.hard_gate_results.map((gate) => [gate.gate, gate.status])),
      eligibility: evaluation.eligibility,
      actual_model: evaluation.actual_model,
    }))
    .sort((left, right) => compareText(left.need_id, right.need_id) || compareText(left.candidate_id, right.candidate_id));
  const resolutionSummaries = fixtureResolutions.map((item) => ({
    resolution_id: item.resolution_id,
    need_id: item.need_id,
    mode: item.mode,
    selected_provider_id: item.selected_provider_id,
    rejected_provider_ids: [...item.rejected_provider_ids],
    evidence_refs: [...item.evidence_refs],
    total_cost: item.total_cost,
    approval_status: item.approval_status,
  })).sort((left, right) => compareText(left.need_id, right.need_id));
  const selectedEvaluation = resolution && evaluations.find((evaluation) => evaluation.need_id === resolution.need_id && evaluation.candidate_id === resolution.selected_provider_id);
  const buildEvaluation = resolution && evaluations.find((evaluation) => evaluation.need_id === resolution.need_id && evaluation.candidate_id === `build:${resolution.need_id}`);
  const selectedCostMatch = selectedEvaluation && selectedEvaluation.axes.cost.reason.match(/^estimated_total_cost=(\d+(?:\.\d+)?)$/);
  const buildCostMatch = buildEvaluation && buildEvaluation.axes.cost.reason.match(/^estimated_total_cost=(\d+(?:\.\d+)?)$/);
  return {
    fixture_id: fixtureId,
    proposed_mode: resolution ? resolution.mode : null,
    proposed_provider_id: resolution ? resolution.selected_provider_id : null,
    highest_raw_score_provider_id: rawLeader ? rawLeader.candidate_id : null,
    highest_raw_score_eligible: rawLeader ? rawLeader.eligibility === "eligible" : null,
    rejection_gate: rejectionGate ? rejectionGate.gate : null,
    need_count: graph ? graph.payload.graph.needs.length : 0,
    candidate_evaluation_count: evaluations.length,
    top_candidate_count: resolution ? evaluations.filter((evaluation) => evaluation.need_id === resolution.need_id).length : 0,
    build_candidate_present: evaluations.some((evaluation) => evaluation.candidate_id.startsWith("build:")),
    approval_status: resolution ? resolution.approval_status : null,
    context_pack_status: contextPack ? contextPack.status : null,
    required_reading: contextPack ? contextPack.required_reading : [],
    scout_invoked: false,
    external_scout_invoked: false,
    local_inventory_recorded: localInventoryRecorded,
    scout_skip_reason: skipReasons.includes("local_inventory_satisfied_need") ? "local_inventory_satisfied_need" : null,
    audition_status: auditionCompleted ? "completed" : "disabled_until_phase2",
    provider_evidence: providerEvidence,
    evaluation_evidence: evaluationEvidence,
    resolution_summaries: resolutionSummaries,
    timeline_event_types: [...new Set(events.map((event) => event.type))].sort(compareText),
    adaptation_evidence: selectedEvaluation && resolution.mode === "adapt"
      ? [selectedEvaluation.axes.task_fit.reason, selectedEvaluation.axes.integration_ease.reason, selectedEvaluation.axes.evidence_strength.reason]
      : [],
    build_maintenance_cost: buildCostMatch ? Number(buildCostMatch[1]) : null,
    uncertainty_by_mode: {
      adapt: selectedEvaluation && resolution.mode === "adapt" ? selectedEvaluation.uncertainty_penalty : null,
      build: buildEvaluation ? buildEvaluation.uncertainty_penalty : null,
    },
    cost_evidence: resolution && resolution.selected_provider_id && selectedCostMatch
      ? { status: "estimated", selected_candidate_estimate: Number(selectedCostMatch[1]), resolution_total_cost: resolution.total_cost }
      : { status: "unknown", selected_estimate: null, resolution_total_cost: resolution ? resolution.total_cost : null },
  };
}

function runFixture({ fixtureId, stateRoot } = {}) {
  if (typeof stateRoot !== "string" || !stateRoot) throw new Error("A fixture stateRoot is required.");
  const resolvedStateRoot = path.resolve(stateRoot);
  const existingBatches = journalBatches(resolvedStateRoot);
  const completion = fixtureCompletion(existingBatches, fixtureId);
  const fixture = loadFixture(fixtureId);
  const providers = materializeProviders(fixture.providers);
  const providerById = new Map(providers.map((provider) => [provider.provider_id, provider]));
  const rules = readJson(path.join(FIXTURES_ROOT, "compiler-rules.json"));
  const store = createEventStore({
    stateRoot: resolvedStateRoot,
    workspaceId: "v4-phase1-fixtures",
    clock: () => FIXTURE_CLOCK,
    reducers: createProjectors(),
    initialState: {},
  });
  const boundary = createCommandBoundary({
    eventStore: store,
    rules,
    collectInventory: () => ({ version: fixture.providers.version, providers, conflicts: fixture.providers.conflicts || [] }),
    compileContextPack: fixtureContextCompiler(providerById),
    referenceTime: FIXTURE_CLOCK,
  });
  if (completion.status === "absent") {
    const prefix = `fixture:${fixtureId}`;
    boundary.execute({ command_id: `${prefix}:task-intent`, name: "task-intent.create", payload: fixture.task.task_intent });
    boundary.execute({ command_id: `${prefix}:capability-compile`, name: "capability.compile", payload: {} });
    boundary.execute({ command_id: `${prefix}:inventory-refresh`, name: "inventory.refresh-local", payload: {} });
    const graph = boundary.replay().capability_graphs.find((item) => item.task_intent_id === boundary.replay().current_task_intent_id);
    if (!graph) throw new Error(`Fixture ${fixtureId} did not produce a Capability Graph.`);
    for (const need of graph.needs) {
      boundary.execute({
        command_id: `${prefix}:resolution:${need.need_id}`,
        name: "resolution.propose",
        payload: { need_id: need.need_id, candidates: fixture.providers.candidates, audit_facts: fixtureAuditFacts(fixture.providers, need.need_id) },
      });
    }
    boundary.execute({ command_id: `${prefix}:context-preview`, name: "context-pack.preview", payload: { fixture_id: fixtureId } });
  }
  const replayed = store.replay({ reducers: createProjectors(), initialState: {} });
  const batches = journalBatches(resolvedStateRoot);
  return {
    review_view: reviewView({ fixtureId, state: replayed.state, batches }),
    journal: {
      batch_count: batches.length,
      event_count: batches.reduce((total, batch) => total + batch.events.length, 0),
      fixture_ids: [...new Set(replayed.state.task_intents.map((intent) => intent.raw_request_ref).filter((reference) => reference.startsWith("fixture:")).map((reference) => reference.slice("fixture:".length)))].sort(compareText),
    },
  };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--fixture") options.fixtureId = value;
    else if (flag === "--state-root") options.stateRoot = value;
    else throw new Error(`Unknown option: ${flag}`);
  }
  return options;
}

if (require.main === module) {
  try {
    const result = runFixture(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.code || "FIXTURE_RUN_FAILED"}: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { FIXTURE_IDS, loadFixtureExpected, runFixture };
