"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createEventStore } = require("@orquesta/event-store");
const { canonicalHash } = require("@orquesta/contracts");
const { createCommandBoundary, createProjectors } = require("../src");

function trustedDraftContextPack({ taskIntent, resolutions }) {
  const content = {
    task_intent_id: taskIntent.task_intent_id,
    owner_agent_id: "implementation-001",
    objective: taskIntent.desired_outcome,
    acceptance_criteria: [...taskIntent.acceptance_criteria],
    adopted_decisions: [],
    capability_resolutions: resolutions.map((resolution) => resolution.resolution_id).sort(),
    required_reading: [],
    relevant_state_excerpts: [],
    interfaces: [],
    allowed_files: [],
    forbidden_actions: [],
    excluded_context: [],
    evidence_requirements: [...taskIntent.acceptance_criteria],
    provenance: [
      { kind: "task_intent", source_ref: `task_intent:${taskIntent.task_intent_id}`, source_hash: canonicalHash(taskIntent) },
      ...resolutions.map((resolution) => ({
        kind: "capability_resolution", source_ref: `resolution:${resolution.resolution_id}`, source_hash: canonicalHash(resolution),
      })),
    ].sort((left, right) => {
      const leftKey = `${left.kind}:${left.source_ref}`;
      const rightKey = `${right.kind}:${right.source_ref}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    }),
    token_budget: null,
    expires_at: null,
    status: "draft",
  };
  return { context_pack: { context_pack_id: `CP-${canonicalHash(content).slice(0, 12)}`, ...content } };
}

function assertGoldenEvidence(actual, expected, label) {
  assert.ok(expected && typeof expected === "object" && !Array.isArray(expected), `${label} must contain explicit golden evidence`);
  assert.ok(Object.keys(expected).length > 0, `${label} must not be empty`);
  const visit = (value, golden, location) => {
    if (Array.isArray(golden)) {
      assert.ok(Array.isArray(value), `${location} must be an array`);
      assert.equal(value.length, golden.length, `${location} must preserve the golden item count`);
      golden.forEach((item, index) => visit(value[index], item, `${location}[${index}]`));
      return;
    }
    if (golden && typeof golden === "object") {
      assert.ok(value && typeof value === "object" && !Array.isArray(value), `${location} must be an object`);
      for (const [key, nested] of Object.entries(golden)) visit(value[key], nested, `${location}.${key}`);
      return;
    }
    assert.deepEqual(value, golden, `${location} must match the golden value`);
  };
  visit(actual, expected, label);
}

test("vertical lifecycle commits through the real EventStore and replay matches after projections are removed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-core-vertical-"));
  const store = createEventStore({ stateRoot: root, workspaceId: "vertical", clock: () => "2026-07-16T07:30:00.000Z", reducers: createProjectors(), initialState: {} });
  const boundary = createCommandBoundary({
    eventStore: store,
    rules: { catalog_version: 1, rules: [{ rule_id: "ui", match: { any_terms: ["ui"], acceptance_terms: ["browser"] }, emits: [{ kind: "evidence", description: "Browser evidence", verification_method: "verify" }] }] },
    collectInventory: () => ({ version: 1, providers: [{ provider_id: "vertical-provider", provider_type: "package", source_type: "repository", provider_hash: "a".repeat(64), evidence_refs: ["workspace:package.json#vertical-provider"] }], conflicts: [] }),
    compileContextPack: trustedDraftContextPack,
    referenceTime: "2026-07-16T07:30:00.000Z",
  });
  boundary.execute({ command_id: "1", name: "task-intent.create", payload: { rawRequestRef: "request:vertical", desiredOutcome: "Build UI", acceptanceCriteria: ["Verify browser"], constraints: [], risk: { impact: "low", reversible: true }, authorityBoundary: { agent_may: ["propose"], user_only: ["approve"] }, assumptions: [], status: "compiled" } });
  boundary.execute({ command_id: "2", name: "capability.compile", payload: {} });
  boundary.execute({ command_id: "3", name: "inventory.refresh-local", payload: {} });
  const need = boundary.replay().capability_graphs[0].needs[0];
  boundary.execute({ command_id: "4", name: "resolution.propose", payload: { need_id: need.need_id, candidates: [], audit_facts: [] } });
  boundary.execute({ command_id: "5", name: "context-pack.preview", payload: { context_pack: { context_pack_id: "CP-caller-controlled", status: "draft" } } });
  assert.throws(() => boundary.execute({ command_id: "bad-review", name: "phase-review.request", payload: { phase_id: "phase-bad", build_ref: "build:vertical", review_packet_ref: "missing-packet", review_packet_hash: "c".repeat(64), checks: [{ name: "vertical", status: "passed" }] } }), { code: "CORE_PHASE_PACKET_REQUIRED" });
  const packet = { artifact_ref: "artifact:phase-1", artifact_hash: "d".repeat(64), kind: "phase_review_packet" };
  const projection = boundary.replay();
  store.commit({
    expected_revision: projection.timeline.at(-1).sequence, batch_id: "packet-seed", actor: { type: "agent", id: "packet-producer" }, correlation_id: "packet-seed",
    events: [{ event_id: "packet-produced", schema_version: 1, type: "artifact.produced", payload: { artifact: packet, responsibility: "implementation" }, evidence_refs: [packet.artifact_ref] }],
  });
  boundary.execute({ command_id: "6", name: "phase-review.request", payload: { phase_id: "phase-1", build_ref: "build:vertical", review_packet_ref: packet.artifact_ref, review_packet_hash: packet.artifact_hash, checks: [{ name: "vertical", status: "passed" }] } });
  const live = store.rebuildProjections();
  store.listProjectionPaths().forEach((projectionPath) => store.removeArtifact(projectionPath));
  const replay = store.replay();
  assert.equal(live.hash, replay.hash);
  assert.equal(replay.state.task_intents[0].status, "compiled");
  assert.ok(replay.state.capability_graphs[0].needs.length >= 1);
  assert.ok(replay.state.resolutions.every((resolution) => resolution.approval_status === "pending_user"));
  assert.equal(replay.state.context_packs[0].status, "draft");
  assert.equal(replay.state.phase_reviews[0].status, "in_progress");
  assert.deepEqual(replay.state.providers.map((provider) => provider.provider_id), ["vertical-provider"]);
  const batches = fs.readFileSync(path.join(root, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  const events = batches.flatMap((batch) => batch.events);
  assert.ok(events.some((event) => event.type === "task.intent.created"));
  assert.ok(events.some((event) => event.type === "capability.need.declared" && event.payload.responsibility === "orchestrator"));
  assert.ok(events.some((event) => event.type === "capability.graph.compiled" && event.payload.responsibility === "orchestrator"));
  assert.ok(events.some((event) => event.type === "capability.provider.discovered" && event.payload.responsibility === "scout"));
  assert.ok(events.some((event) => event.type === "candidate.evaluated" && event.payload.responsibility === "static_audit"));
  assert.ok(events.some((event) => event.type === "resolution.proposed" && event.payload.responsibility === "orchestrator"));
  assert.ok(events.some((event) => event.type === "context.pack.created" && event.payload.responsibility === "orchestrator"));
  assert.ok(events.some((event) => event.type === "phase.review.requested" && event.payload.responsibility === "orchestrator"));
  assert.equal(events.some((event) => event.type === "candidate.audition.completed"), false);
});

test("an active Phase Review cannot be replaced by a second request for the same phase", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-core-phase-active-"));
  const store = createEventStore({ stateRoot: root, workspaceId: "phase-active", clock: () => "2026-07-16T07:30:00.000Z" });
  const boundary = createCommandBoundary({ eventStore: store, rules: { catalog_version: 1, rules: [] }, collectInventory: () => ({ version: 1, providers: [], conflicts: [] }) });
  const artifact = { artifact_ref: "artifact:active", artifact_hash: "e".repeat(64), kind: "phase_review_packet" };
  store.commit({ expected_revision: 0, batch_id: "active-packet-seed", actor: { type: "agent", id: "packet" }, correlation_id: "active-packet-seed", events: [{ event_id: "active-packet-event", schema_version: 1, type: "artifact.produced", payload: { artifact, responsibility: "implementation" }, evidence_refs: [artifact.artifact_ref] }] });
  const payload = { phase_id: "phase-active", build_ref: "build:active", review_packet_ref: artifact.artifact_ref, review_packet_hash: artifact.artifact_hash, checks: [{ name: "checks", status: "passed" }] };
  boundary.execute({ command_id: "review-first", name: "phase-review.request", payload });
  assert.throws(() => boundary.execute({ command_id: "review-second", name: "phase-review.request", payload }), { code: "CORE_PHASE_REVIEW_ACTIVE" });
  assert.equal(boundary.replay().phase_reviews.length, 1);
});

test("Task 10 fixtures derive independent golden review evidence from Core and the Event Journal", () => {
  const { loadFixtureExpected, runFixture } = require("../../../scripts/v4/run-fixture");
  const fixtureIds = ["local-reuse", "adapt-vs-build", "blocked-candidate"];

  for (const fixtureId of fixtureIds) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `orquesta-v4-${fixtureId}-`));
    const first = runFixture({ fixtureId, stateRoot: root });
    const expected = loadFixtureExpected(fixtureId);
    assertGoldenEvidence(first.review_view, expected, `${fixtureId} golden evidence`);
    assert.ok(first.review_view.provider_evidence.length > 0, `${fixtureId} must preserve fixture-scoped provider source and hash evidence`);
    assert.ok(first.review_view.evaluation_evidence.every((evaluation) => evaluation.axis_values && evaluation.hard_gates), `${fixtureId} must preserve scored hard-gate evidence`);
    assert.ok(first.review_view.resolution_summaries.every((resolution) => resolution.approval_status === "pending_user"), `${fixtureId} must preserve pending Resolution evidence`);
    assert.ok(first.review_view.timeline_event_types.includes("context.pack.created"), `${fixtureId} must preserve Context Pack timeline evidence`);
    assert.equal(first.review_view.cost_evidence.status, "estimated", `${fixtureId} must identify selected cost evidence`);
    assert.equal(first.review_view.cost_evidence.selected_candidate_estimate, first.review_view.cost_evidence.resolution_total_cost, `${fixtureId} CandidateEvaluation cost must match the Resolution total`);
    assert.ok(first.review_view.evaluation_evidence.every((evaluation) => evaluation.actual_model === null), `${fixtureId} must retain actual_model null without runtime proof`);
    assert.ok(first.review_view.evaluation_evidence.every((evaluation) => evaluation.axis_contributions), `${fixtureId} must retain immutable-weight contribution evidence`);
    assert.equal(Object.hasOwn(first.review_view, "journal_batch_count"), false, `${fixtureId} golden view must not include shared-root batch counts`);
    assert.equal(Object.hasOwn(first.review_view, "journal_event_count"), false, `${fixtureId} golden view must not include shared-root event counts`);
    assert.equal(Object.hasOwn(first.review_view, "fixture_history_ids"), false, `${fixtureId} golden view must not include shared-root fixture history`);

    const repeated = runFixture({ fixtureId, stateRoot: root });
    assert.equal(repeated.journal.batch_count, first.journal.batch_count, `${fixtureId} rerun must not append batches`);
    assert.equal(repeated.journal.event_count, first.journal.event_count, `${fixtureId} rerun must not append events`);
  }
});

test("Task 10 fixtures coexist without adding history on an A-B-C-A rerun", () => {
  const { runFixture } = require("../../../scripts/v4/run-fixture");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-v4-fixture-shared-"));
  runFixture({ fixtureId: "local-reuse", stateRoot: root });
  runFixture({ fixtureId: "adapt-vs-build", stateRoot: root });
  const beforeCrossFixtureRerun = runFixture({ fixtureId: "blocked-candidate", stateRoot: root }).journal;
  const combined = runFixture({ fixtureId: "local-reuse", stateRoot: root });
  assert.equal(combined.journal.batch_count, beforeCrossFixtureRerun.batch_count, "A after B and C must not append batches");
  assert.equal(combined.journal.event_count, beforeCrossFixtureRerun.event_count, "A after B and C must not append events");
  assert.equal(combined.journal.fixture_ids.length, 3, "fixture history must coexist without a reset");
  assert.equal(combined.review_view.scout_invoked, false);
  assert.equal(combined.review_view.external_scout_invoked, false);
  assert.equal(combined.review_view.local_inventory_recorded, true);

  const adapt = runFixture({ fixtureId: "adapt-vs-build", stateRoot: root }).review_view;
  assert.deepEqual(adapt.adaptation_evidence, [
    "target URL argument",
    "Workbench data-testid",
    "fixture completion assertion",
  ]);
  assert.equal(adapt.build_maintenance_cost, 15);
  assert.equal(adapt.uncertainty_by_mode.adapt, 18);
  assert.equal(adapt.uncertainty_by_mode.build, 45);

  const blocked = runFixture({ fixtureId: "blocked-candidate", stateRoot: root }).review_view;
  const unknownLicense = blocked.provider_evidence.find((provider) => provider.provider_id === "ui-catalog-unknown-license");
  assert.deepEqual(unknownLicense.evidence_refs, ["workspace:fixtures/v4/phase1/blocked-candidate/providers.json"]);
  assert.equal(unknownLicense.source_type, "fixture");
  assert.equal(blocked.proposed_mode, "build");
  assert.ok(blocked.proposed_provider_id.startsWith("build:"));
  assert.deepEqual(blocked.required_reading, []);
  assert.equal(blocked.provider_evidence.some((provider) => provider.provider_id === "local-ui-safe-helper"), false);
});
