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
