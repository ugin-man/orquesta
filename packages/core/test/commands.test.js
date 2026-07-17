"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createEventStore } = require("@orquesta/event-store");
const { canonicalHash } = require("@orquesta/contracts");
const { createCommandBoundary, COMMAND_NAMES } = require("../src");
const { createTaskIntent } = require("../src/task-intent");
const { initialProjection } = require("../src/projectors");

function makeIntent(status = "compiled") {
  return {
    rawRequestRef: "request:T9", desiredOutcome: "Build a UI compiler", acceptanceCriteria: ["Verify browser evidence"],
    constraints: [], risk: { impact: "low", reversible: true },
    authorityBoundary: { agent_may: ["propose"], user_only: ["approve"] }, assumptions: [], status,
  };
}

function axes(value = 100) {
  return Object.fromEntries(["task_fit", "integration_ease", "evidence_strength", "maintainability", "security", "license_fit", "exit_option", "cost"]
    .map((axis) => [axis, { value, reason: "fixture" }]));
}

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

function selectedCandidate(providerId = "local-reuse") {
  return {
    provider_id: providerId, provider_type: "package", resolution_mode: "reuse", evidence_refs: [`workspace:package.json#${providerId}`],
    static_metadata: { license: "MIT", runtime: "compatible", security: "low" }, axes: axes(), uncertainty_penalty: 0,
    estimated_total_cost: 0, unknowns: [],
  };
}

function trustedDraftContextPack({ taskIntent, resolutions, request }) {
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
  return {
    context_pack: {
      context_pack_id: `CP-${canonicalHash(content).slice(0, 12)}`,
      ...content,
    },
  };
}

function duplicateTaskIntentProvenance(input, duplicateHash, reverse) {
  const contextPack = copy(trustedDraftContextPack(input).context_pack);
  const taskIntentEntry = contextPack.provenance.find((entry) => entry.kind === "task_intent");
  const duplicates = [
    { ...taskIntentEntry },
    { ...taskIntentEntry, source_hash: duplicateHash },
  ];
  if (reverse) duplicates.reverse();
  contextPack.provenance = contextPack.provenance.flatMap((entry) => entry === taskIntentEntry ? duplicates : [entry]);
  const content = { ...contextPack };
  delete content.context_pack_id;
  contextPack.context_pack_id = `CP-${canonicalHash(content).slice(0, 12)}`;
  return contextPack;
}

function contextPackSnapshot(store, boundary) {
  const replayed = store.replay({ reducers: boundary.projectors, initialState: initialProjection() });
  const state = boundary.replay();
  return {
    watermark: replayed.watermark.journal_sequence,
    context_packs: copy(state.context_packs),
    current_context_pack_id: state.current_context_pack_id,
    current_context_pack_sequence: state.current_context_pack_sequence,
  };
}

function makeBoundary(options = {}) {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-core-command-"));
  const store = createEventStore({ stateRoot, workspaceId: "test", clock: () => "2026-07-16T07:30:00.000Z" });
  const verifyUserApproval = options.verifyUserApproval || ((evidence, target) => {
    assert.equal(evidence.raw_token, "never-persist");
    return {
      attestation: {
        source: "local_workbench_confirmation", challenge_id: "challenge-1", target_id: target.target_id,
        target_revision: target.target_revision, review_packet_hash: target.review_packet_hash,
        token_hash: canonicalHash(evidence.raw_token), captured_at: "2026-07-16T07:30:00.000Z",
        expires_at: "2026-07-16T08:30:00.000Z", identity_assurance: "local_interaction_unverified_identity",
      },
      actor: { type: "user", id: "verified-user" },
    };
  });
  return {
    stateRoot, store,
    boundary: createCommandBoundary({
      eventStore: store,
      rules: options.rules || { catalog_version: 1, rules: [{ rule_id: "ui", match: { any_terms: ["ui"], acceptance_terms: ["browser"] }, emits: [{ kind: "evidence", description: "Browser evidence", verification_method: "verify" }] }] },
      collectInventory: options.collectInventory || (() => ({ version: 1, providers: [{ provider_id: "local-ui", source_type: "repository", provider_type: "package", evidence_refs: ["workspace:package.json#local-ui"] }], conflicts: [] })),
      verifyUserApproval,
      compileContextPack: options.compileContextPack || trustedDraftContextPack,
      referenceTime: "2026-07-16T07:30:00.000Z",
    }),
  };
}

function localProvider(providerId, providerHash = "a".repeat(64), evidenceRefs = [`workspace:package.json#${providerId}`]) {
  return {
    provider_id: providerId,
    provider_type: "package",
    source_uri: evidenceRefs[0],
    source_type: "repository",
    capabilities: ["UI"],
    trust_tier: "local",
    availability: "available",
    version: "1.0.0",
    last_verified_at: "2026-07-16T07:30:00.000Z",
    provider_hash: providerHash,
    evidence_refs: evidenceRefs,
  };
}

function prepareLocalProposal(initialProvider = localProvider("local-reuse")) {
  let providers = [initialProvider];
  const result = makeBoundary({
    collectInventory: () => ({ version: 1, providers, conflicts: [] }),
  });
  result.boundary.execute({ command_id: "binding-intent", name: "task-intent.create", payload: makeIntent() });
  result.boundary.execute({ command_id: "binding-compile", name: "capability.compile", payload: {} });
  result.boundary.execute({ command_id: "binding-inventory", name: "inventory.refresh-local", payload: {} });
  const need = result.boundary.replay().capability_graphs[0].needs[0];
  result.boundary.execute({
    command_id: "binding-proposal",
    name: "resolution.propose",
    payload: { need_id: need.need_id, candidates: [selectedCandidate(initialProvider.provider_id)], audit_facts: [] },
  });
  return {
    ...result,
    resolution: result.boundary.replay().resolutions[0],
    refresh(nextProviders) {
      providers = nextProviders;
      return result.boundary.execute({ command_id: `binding-refresh-${providers.length}-${providers[0] && providers[0].provider_hash || "none"}`, name: "inventory.refresh-local", payload: {} });
    },
  };
}

test("command boundary exposes only the approved Core command names", () => {
  assert.deepEqual([...COMMAND_NAMES], [
    "task-intent.create", "capability.compile", "execution-plan.create", "execution-plan.escalate", "inventory.refresh-local", "resolution.propose",
    "resolution.approve", "context-pack.preview", "candidate.install.request", "candidate.install.authorize",
    "phase-review.request", "phase-review.decide",
  ]);
  const { boundary } = makeBoundary();
  assert.throws(() => boundary.execute({ command_id: "bad", name: "network.install", payload: {} }), { code: "CORE_COMMAND_UNKNOWN" });
});

test("Execution Plan commands require lifecycle evidence, journal once, replay, and escalate the current plan", () => {
  const before = makeBoundary();
  assert.throws(() => before.boundary.execute({
    command_id: "plan-before-intent", name: "execution-plan.create", payload: { risk_profile: { scope: "multiple_boundaries" } }
  }), { code: "CORE_TASK_INTENT_REQUIRED" });
  assert.throws(() => before.boundary.execute({
    command_id: "plan-before-current", name: "execution-plan.escalate", payload: { trigger: "scope_drift" }
  }), { code: "CORE_EXECUTION_PLAN_REQUIRED" });

  const { boundary, stateRoot } = makeBoundary();
  boundary.execute({ command_id: "plan-intent", name: "task-intent.create", payload: makeIntent() });
  assert.throws(() => boundary.execute({
    command_id: "plan-before-graph", name: "execution-plan.create", payload: { risk_profile: { scope: "multiple_boundaries" } }
  }), { code: "CORE_CAPABILITY_GRAPH_REQUIRED" });
  boundary.execute({ command_id: "plan-graph", name: "capability.compile", payload: {} });

  const create = {
    command_id: "execution-plan-create",
    name: "execution-plan.create",
    payload: {
      risk_profile: {
        reversibility: "easy", scope: "single_boundary", verification: "deterministic", uncertainty: "low",
        effects: ["workspace_write"], repeated_failures: 0, user_review: "default"
      }
    }
  };
  assert.equal(boundary.execute(create).status, "committed");
  assert.equal(boundary.execute(create).status, "idempotent");
  const first = boundary.replay();
  assert.equal(first.execution_plans.length, 1);
  assert.equal(first.current_execution_plan_id, first.execution_plans[0].execution_plan_id);
  const batch = JSON.parse(fs.readFileSync(path.join(stateRoot, "events.jsonl"), "utf8").trim().split("\n").at(-1));
  assert.deepEqual(batch.events.map((event) => event.type), ["execution.plan.created"]);

  const escalation = boundary.execute({
    command_id: "execution-plan-escalate", name: "execution-plan.escalate", payload: { trigger: "scope_drift" }
  });
  assert.equal(escalation.status, "committed");
  const second = boundary.replay();
  const current = second.execution_plans.find((plan) => plan.execution_plan_id === second.current_execution_plan_id);
  assert.equal(current.lane, "standard");
  assert.equal(current.revision, 2);
  assert.equal(current.supersedes_execution_plan_id, first.execution_plans[0].execution_plan_id);
});

test("Execution Plan creation is idempotent but cannot replace the current lane", () => {
  const { boundary } = makeBoundary();
  boundary.execute({ command_id: "locked-plan-intent", name: "task-intent.create", payload: makeIntent() });
  boundary.execute({ command_id: "locked-plan-graph", name: "capability.compile", payload: {} });
  const critical = {
    command_id: "locked-plan-critical",
    name: "execution-plan.create",
    payload: { risk_profile: { effects: ["external_write"] } }
  };
  assert.equal(boundary.execute(critical).status, "committed");
  assert.equal(boundary.execute(critical).status, "idempotent");
  assert.throws(() => boundary.execute({
    command_id: "locked-plan-fast",
    name: "execution-plan.create",
    payload: { risk_profile: { effects: ["workspace_write"] } }
  }), { code: "CORE_EXECUTION_PLAN_EXISTS" });
  const state = boundary.replay();
  assert.equal(state.execution_plans.length, 1);
  assert.equal(state.execution_plans[0].lane, "critical");
});

test("a command commits one EventStore batch and command identity is idempotent only for its canonical payload", () => {
  const { boundary } = makeBoundary();
  const command = { command_id: "cmd-intent", name: "task-intent.create", payload: makeIntent() };
  const first = boundary.execute(command);
  const again = boundary.execute(command);
  assert.equal(first.status, "committed");
  assert.equal(again.status, "idempotent");
  assert.equal(boundary.replay().timeline.length, 1);
  assert.throws(() => boundary.execute({ ...command, payload: makeIntent("draft") }), { code: "CORE_COMMAND_ID_CONFLICT" });
});

test("command boundary rejects payload values canonical JSON cannot preserve before identity is recorded", () => {
  const { boundary } = makeBoundary();
  for (const { commandId, value } of [
    { commandId: "canonical-undefined", value: undefined },
    { commandId: "canonical-nan", value: Number.NaN },
  ]) {
    assert.throws(() => boundary.execute({
      command_id: commandId,
      name: "inventory.refresh-local",
      payload: { noncanonical: value },
    }), { code: "CORE_COMMAND_INVALID" });
    assert.equal(boundary.execute({
      command_id: commandId,
      name: "inventory.refresh-local",
      payload: {},
    }).status, "committed");
  }
});

test("resolution approval ignores request body actor and persists only redacted verified attestation", () => {
  const { boundary } = makeBoundary();
  boundary.execute({ command_id: "intent", name: "task-intent.create", payload: makeIntent() });
  boundary.execute({ command_id: "compile", name: "capability.compile", payload: {} });
  const graph = boundary.replay().capability_graphs[0];
  const need = graph.needs[0];
  boundary.execute({ command_id: "proposal", name: "resolution.propose", payload: { need_id: need.need_id, candidates: [], audit_facts: [] } });
  const proposal = boundary.replay().resolutions[0];
  const result = boundary.execute({
    command_id: "approve", name: "resolution.approve",
    actor: { type: "user", id: "body-user-must-not-authorize" },
    payload: { resolution_id: proposal.resolution_id, approval_evidence: { raw_token: "never-persist" } },
  });
  assert.equal(result.status, "committed");
  const entry = boundary.replay().timeline.at(-1);
  assert.equal(entry.actor.id, "verified-user");
  assert.equal(entry.type, "resolution.approved");
  assert.equal(entry.responsibility, "user");
  assert.equal(JSON.stringify(entry).includes("never-persist"), false);
  assert.equal(boundary.replay().resolutions[0].approval_status, "approved");
});

test("approval events retain only the schema-valid redacted attestation and bind the selected proposal", () => {
  let observedTarget;
  const { boundary, stateRoot } = makeBoundary({
    verifyUserApproval: (_evidence, target) => {
      observedTarget = target;
      return {
        actor: { type: "user", id: "verified-user" },
        attestation: {
          source: "local_workbench_confirmation", challenge_id: "challenge-secret", target_id: target.target_id,
          target_revision: target.target_revision, review_packet_hash: target.review_packet_hash,
          token_hash: "f".repeat(64), captured_at: "2026-07-16T07:30:00.000Z",
          expires_at: "2026-07-16T08:30:00.000Z", identity_assurance: "local_interaction_unverified_identity",
          raw_token: "raw-secret", secret: "shared-secret", hmac: "proof-secret",
        },
      };
    },
    collectInventory: () => ({ version: 1, providers: [{ provider_id: "local-reuse", provider_type: "package", source_uri: "workspace:package.json#local-reuse", source_type: "repository", capabilities: ["UI"], trust_tier: "local", availability: "available", version: "1", last_verified_at: "2026-07-16T07:30:00.000Z", provider_hash: "a".repeat(64), evidence_refs: ["workspace:package.json#local-reuse"], private_body: "never-store" }], conflicts: [] }),
  });
  boundary.execute({ command_id: "intent-secret", name: "task-intent.create", payload: makeIntent() });
  boundary.execute({ command_id: "compile-secret", name: "capability.compile", payload: {} });
  boundary.execute({ command_id: "inventory-secret", name: "inventory.refresh-local", payload: {} });
  const need = boundary.replay().capability_graphs[0].needs[0];
  boundary.execute({ command_id: "proposal-secret", name: "resolution.propose", payload: { need_id: need.need_id, candidates: [selectedCandidate()], audit_facts: [] } });
  const proposal = boundary.replay().resolutions[0];
  boundary.execute({ command_id: "approval-secret", name: "resolution.approve", payload: { resolution_id: proposal.resolution_id, approval_evidence: { raw_token: "request-secret" } } });
  assert.equal(observedTarget.candidate_id, "local-reuse");
  assert.equal(observedTarget.mode, "reuse");
  const journal = fs.readFileSync(path.join(stateRoot, "events.jsonl"), "utf8");
  assert.equal(journal.includes("raw-secret"), false);
  assert.equal(journal.includes("shared-secret"), false);
  assert.equal(journal.includes("proof-secret"), false);
});

test("proposal projections retain CandidateEvaluations for separate Capability Needs", () => {
  const { boundary } = makeBoundary({
    rules: {
      catalog_version: 1,
      rules: [{ rule_id: "two-needs", match: { any_terms: ["ui"], acceptance_terms: ["browser"] }, emits: [
        { kind: "asset", description: "UI asset", verification_method: "asset verify" },
        { kind: "evidence", description: "Browser proof", verification_method: "browser verify" },
      ] }],
    },
  });
  boundary.execute({ command_id: "intent-two", name: "task-intent.create", payload: makeIntent() });
  boundary.execute({ command_id: "compile-two", name: "capability.compile", payload: {} });
  const needs = boundary.replay().capability_graphs[0].needs;
  boundary.execute({ command_id: "proposal-one", name: "resolution.propose", payload: { need_id: needs[0].need_id, candidates: [], audit_facts: [] } });
  boundary.execute({ command_id: "proposal-two", name: "resolution.propose", payload: { need_id: needs[1].need_id, candidates: [], audit_facts: [] } });
  assert.equal(boundary.replay().candidate_evaluations.length, 2);
});

test("multi-event batches keep journal revision distinct from timeline event count", () => {
  let approvalTarget;
  const { boundary } = makeBoundary({
    verifyUserApproval: (_evidence, target) => {
      approvalTarget = target;
      return {
        actor: { type: "user", id: "verified-user" },
        attestation: {
          source: "local_workbench_confirmation", challenge_id: "revision-bound", target_id: target.target_id,
          target_revision: target.target_revision, review_packet_hash: target.review_packet_hash, token_hash: "e".repeat(64),
          captured_at: "2026-07-16T07:30:00.000Z", expires_at: "2026-07-16T08:30:00.000Z", identity_assurance: "local_interaction_unverified_identity",
        },
      };
    },
    collectInventory: () => ({ version: 1, providers: [{ provider_id: "local-reuse", provider_type: "package", source_type: "repository", evidence_refs: ["workspace:package.json#local-reuse"] }], conflicts: [] }),
  });
  boundary.execute({ command_id: "revision-intent", name: "task-intent.create", payload: makeIntent() });
  boundary.execute({ command_id: "revision-compile", name: "capability.compile", payload: {} });
  boundary.execute({ command_id: "revision-inventory", name: "inventory.refresh-local", payload: {} });
  const need = boundary.replay().capability_graphs[0].needs[0];
  boundary.execute({ command_id: "revision-proposal", name: "resolution.propose", payload: { need_id: need.need_id, candidates: [selectedCandidate()], audit_facts: [] } });
  const proposal = boundary.replay().resolutions[0];
  assert.equal(boundary.replay().timeline.length, 8);
  assert.equal(boundary.replay().latest_resolution_by_need[need.need_id].sequence, 4);
  boundary.execute({ command_id: "revision-approve", name: "resolution.approve", payload: { resolution_id: proposal.resolution_id, approval_evidence: {} } });
  assert.equal(approvalTarget.target_revision, 4);
});

test("Core uses the EventStore journal watermark when an unknown future event is not projected", () => {
  const { boundary, store } = makeBoundary();
  store.commit({
    expected_revision: 0,
    batch_id: "future-event-seed",
    actor: { type: "agent", id: "future-producer" },
    correlation_id: "future-event-seed",
    events: [{ event_id: "future-event", schema_version: 1, type: "future.phase.annotation", payload: { version: 2 }, evidence_refs: [] }],
  });
  const result = boundary.execute({ command_id: "watermark-intent", name: "task-intent.create", payload: makeIntent() });
  assert.equal(result.status, "committed");
  assert.equal(result.sequence, 2);
});

test("compiled state uses the most recent TaskIntent and CapabilityGraph journal batches rather than sorted identifiers", () => {
  const { boundary } = makeBoundary();
  const firstPayload = { ...makeIntent(), rawRequestRef: "request:0", desiredOutcome: "Build UI 0" };
  const secondPayload = { ...makeIntent(), rawRequestRef: "request:6", desiredOutcome: "Build UI 6" };
  const first = createTaskIntent(firstPayload);
  const second = createTaskIntent(secondPayload);
  boundary.execute({ command_id: "current-intent-first", name: "task-intent.create", payload: firstPayload });
  boundary.execute({ command_id: "current-graph-first", name: "capability.compile", payload: {} });
  boundary.execute({ command_id: "current-intent-second", name: "task-intent.create", payload: secondPayload });
  boundary.execute({ command_id: "current-graph-second", name: "capability.compile", payload: {} });
  const state = boundary.replay();
  assert.equal(state.current_task_intent_id, second.task_intent_id);
  assert.notEqual(first.task_intent_id, second.task_intent_id);
  assert.ok(second.task_intent_id < first.task_intent_id);
  assert.equal(state.current_capability_graph_id, state.capability_graphs.find((graph) => graph.task_intent_id === second.task_intent_id).graph_id);
  const currentGraph = state.capability_graphs.find((graph) => graph.graph_id === state.current_capability_graph_id);
  assert.doesNotThrow(() => boundary.execute({ command_id: "current-graph-proposal", name: "resolution.propose", payload: { need_id: currentGraph.needs[0].need_id, candidates: [], audit_facts: [] } }));
});

test("a later local inventory refresh replaces the provider snapshot and prevents reuse of removed providers", () => {
  let providers = ["retired-provider", "current-provider"];
  const { boundary } = makeBoundary({
    collectInventory: () => ({ version: 1, providers: providers.map((provider_id) => ({
      provider_id, provider_type: "package", source_type: "repository", evidence_refs: [`workspace:package.json#${provider_id}`],
    })), conflicts: [] }),
  });
  boundary.execute({ command_id: "snapshot-intent", name: "task-intent.create", payload: makeIntent() });
  boundary.execute({ command_id: "snapshot-compile", name: "capability.compile", payload: {} });
  boundary.execute({ command_id: "snapshot-first", name: "inventory.refresh-local", payload: {} });
  providers = ["current-provider"];
  boundary.execute({ command_id: "snapshot-second", name: "inventory.refresh-local", payload: {} });
  assert.deepEqual(boundary.replay().providers.map((provider) => provider.provider_id), ["current-provider"]);
  const need = boundary.replay().capability_graphs[0].needs[0];
  assert.throws(() => boundary.execute({
    command_id: "snapshot-retired-proposal", name: "resolution.propose",
    payload: { need_id: need.need_id, candidates: [selectedCandidate("retired-provider")], audit_facts: [] },
  }), { code: "CORE_CANDIDATE_NOT_DISCOVERED" });
});

test("inventory snapshot identity changes when safe metadata or evidence changes for the same provider id", () => {
  let provider = {
    provider_id: "same-provider", provider_type: "package", source_type: "repository",
    provider_hash: "a".repeat(64), evidence_refs: ["workspace:package.json#same-provider"],
  };
  const { boundary, stateRoot } = makeBoundary({ collectInventory: () => ({ version: 1, providers: [provider], conflicts: [] }) });
  boundary.execute({ command_id: "fingerprint-first", name: "inventory.refresh-local", payload: {} });
  provider = { ...provider, provider_hash: "b".repeat(64), evidence_refs: ["workspace:package.json#same-provider-v2"] };
  boundary.execute({ command_id: "fingerprint-second", name: "inventory.refresh-local", payload: {} });
  const summaries = fs.readFileSync(path.join(stateRoot, "events.jsonl"), "utf8").trim().split("\n")
    .flatMap((line) => JSON.parse(line).events)
    .filter((event) => event.type === "capability.inventory.refreshed");
  assert.equal(summaries.length, 2);
  assert.notEqual(summaries[0].payload.inventory_id, summaries[1].payload.inventory_id);
});

test("Phase Review user decisions bind their current journal revision and record their exact transition event", () => {
  let staleChallenge = true;
  let expectedStaleRevision;
  let observedTarget;
  const { boundary, store } = makeBoundary({
    verifyUserApproval: (_evidence, target) => {
      observedTarget = target;
      const target_revision = staleChallenge ? expectedStaleRevision : target.target_revision;
      return {
        actor: { type: "user", id: "verified-user" },
        attestation: {
          source: "local_workbench_confirmation", challenge_id: staleChallenge ? "old-challenge" : "current-challenge",
          target_id: target.target_id, target_revision, review_packet_hash: target.review_packet_hash,
          token_hash: "7".repeat(64), captured_at: "2026-07-16T07:30:00.000Z",
          expires_at: "2026-07-16T08:30:00.000Z", identity_assurance: "local_interaction_unverified_identity",
        },
      };
    },
  });
  const packet = { artifact_ref: "artifact:current", artifact_hash: "8".repeat(64), kind: "phase_review_packet" };
  store.commit({ expected_revision: 0, batch_id: "current-packet", actor: { type: "agent", id: "implementation" }, correlation_id: "current-packet", events: [{ event_id: "current-packet-event", schema_version: 1, type: "artifact.produced", payload: { artifact: packet, responsibility: "implementation" }, evidence_refs: [packet.artifact_ref] }] });
  boundary.execute({ command_id: "current-request", name: "phase-review.request", payload: { phase_id: "current-phase", build_ref: "build:current", review_packet_ref: packet.artifact_ref, review_packet_hash: packet.artifact_hash, checks: [{ name: "tests", status: "passed" }] } });
  boundary.execute({ command_id: "current-ready", name: "phase-review.decide", payload: { phase_id: "current-phase", decision: "ready_for_user_review" } });
  expectedStaleRevision = boundary.replay().phase_reviews[0].review_cycle_revision;
  store.commit({ expected_revision: 3, batch_id: "current-intervening", actor: { type: "agent", id: "implementation" }, correlation_id: "current-intervening", events: [{ event_id: "current-intervening-event", schema_version: 1, type: "artifact.produced", payload: { artifact: { artifact_ref: "artifact:other", artifact_hash: "9".repeat(64), kind: "phase_review_packet" }, responsibility: "implementation" }, evidence_refs: ["artifact:other"] }] });
  assert.throws(() => boundary.execute({ command_id: "current-stale-decision", name: "phase-review.decide", payload: { phase_id: "current-phase", decision: "approved", approval_evidence: {} } }), { code: "CORE_APPROVAL_INVALID" });
  assert.equal(observedTarget.target_revision, 4);
  staleChallenge = false;
  boundary.execute({ command_id: "current-approved-decision", name: "phase-review.decide", payload: { phase_id: "current-phase", decision: "approved", approval_evidence: {} } });
  const state = boundary.replay();
  assert.equal(state.phase_reviews[0].review_cycle_revision, 4);
  assert.equal(state.timeline.at(-1).type, "phase.review.approved");
});

test("inventory projects bounded provider metadata and rejects an undiscovered proposal provider", () => {
  const provider = {
    provider_id: "known-provider", provider_type: "package", source_uri: "workspace:package.json#known-provider", source_type: "repository",
    capabilities: ["UI"], trust_tier: "local", availability: "available", version: "1.0.0", last_verified_at: "2026-07-16T07:30:00.000Z",
    provider_hash: "b".repeat(64), evidence_refs: ["workspace:package.json#known-provider"], provider_body: { secret: "do-not-store" },
  };
  const { boundary } = makeBoundary({ collectInventory: () => ({ version: 1, providers: [provider], conflicts: [] }) });
  boundary.execute({ command_id: "metadata-intent", name: "task-intent.create", payload: makeIntent() });
  boundary.execute({ command_id: "metadata-compile", name: "capability.compile", payload: {} });
  boundary.execute({ command_id: "metadata-inventory", name: "inventory.refresh-local", payload: {} });
  const metadata = boundary.replay().providers[0];
  assert.deepEqual(metadata, {
    provider_id: "known-provider", provider_type: "package", source_uri: "workspace:package.json#known-provider", source_type: "repository",
    capabilities: ["UI"], trust_tier: "local", availability: "available", version: "1.0.0", last_verified_at: "2026-07-16T07:30:00.000Z",
    provider_hash: "b".repeat(64), evidence_refs: ["workspace:package.json#known-provider"],
  });
  const need = boundary.replay().capability_graphs[0].needs[0];
  assert.throws(() => boundary.execute({ command_id: "unknown-provider", name: "resolution.propose", payload: { need_id: need.need_id, candidates: [{ ...selectedCandidate(), provider_id: "unknown-provider" }], audit_facts: [] } }), { code: "CORE_CANDIDATE_NOT_DISCOVERED" });
  assert.throws(() => boundary.execute({ command_id: "injected-build", name: "resolution.propose", payload: { need_id: need.need_id, candidates: [{ ...selectedCandidate("evil-build"), provider_type: "new_build" }], audit_facts: [] } }), { code: "CORE_CANDIDATE_NOT_DISCOVERED" });
});

test("proposal events retain Audit responsibility and a bounded local-inventory scout skip reason", () => {
  const { boundary, stateRoot } = makeBoundary({ collectInventory: () => ({ version: 1, providers: [{ provider_id: "local-reuse", provider_type: "package", source_type: "repository", evidence_refs: ["workspace:package.json#local-reuse"] }], conflicts: [] }) });
  boundary.execute({ command_id: "responsibility-intent", name: "task-intent.create", payload: makeIntent() });
  boundary.execute({ command_id: "responsibility-compile", name: "capability.compile", payload: {} });
  boundary.execute({ command_id: "responsibility-inventory", name: "inventory.refresh-local", payload: {} });
  const need = boundary.replay().capability_graphs[0].needs[0];
  boundary.execute({ command_id: "responsibility-proposal", name: "resolution.propose", payload: { need_id: need.need_id, candidates: [selectedCandidate()], audit_facts: [] } });
  const events = fs.readFileSync(path.join(stateRoot, "events.jsonl"), "utf8").trim().split("\n").flatMap((line) => JSON.parse(line).events);
  const audit = events.find((event) => event.type === "candidate.evaluated");
  const proposal = events.find((event) => event.type === "resolution.proposed");
  assert.equal(audit.payload.responsibility, "static_audit");
  assert.equal(audit.payload.responsibility_boundary.audit, "metadata_checks_only");
  assert.equal(audit.payload.responsibility_boundary.audition, "disabled_until_phase2");
  assert.equal(proposal.payload.responsibility_boundary.orchestrator, "proposal_and_evidence_reconciliation");
  assert.equal(proposal.payload.scout_skip_reason, "local_inventory_satisfied_need");
  assert.equal(events.some((event) => event.type === "candidate.audition.completed"), false);
});

test("proposal does not claim a local-inventory skip when every local candidate is rejected", () => {
  const provider = {
    provider_id: "rejected-local", provider_type: "package", source_type: "repository",
    evidence_refs: ["workspace:package.json#rejected-local"], provider_hash: "c".repeat(64),
  };
  const { boundary, stateRoot } = makeBoundary({ collectInventory: () => ({ version: 1, providers: [provider], conflicts: [] }) });
  boundary.execute({ command_id: "evidence-intent", name: "task-intent.create", payload: makeIntent() });
  boundary.execute({ command_id: "evidence-compile", name: "capability.compile", payload: {} });
  boundary.execute({ command_id: "evidence-inventory", name: "inventory.refresh-local", payload: {} });
  const need = boundary.replay().capability_graphs[0].needs[0];
  boundary.execute({
    command_id: "evidence-proposal", name: "resolution.propose",
    payload: {
      need_id: need.need_id,
      candidates: [{ ...selectedCandidate("rejected-local"), static_metadata: { license: "forbidden", runtime: "compatible", security: "low" } }],
      audit_facts: [],
    },
  });
  const events = fs.readFileSync(path.join(stateRoot, "events.jsonl"), "utf8").trim().split("\n").flatMap((line) => JSON.parse(line).events);
  const proposal = events.find((event) => event.type === "resolution.proposed");
  assert.equal(proposal.payload.scout_skip_reason, null);
});

test("proposal preserves discovered candidate evidence and leaves synthetic build evidence empty", () => {
  const provider = {
    provider_id: "evidence-local", provider_type: "package", source_type: "repository",
    evidence_refs: ["workspace:package.json#evidence-local"], provider_hash: "d".repeat(64),
  };
  const { boundary, stateRoot } = makeBoundary({ collectInventory: () => ({ version: 1, providers: [provider], conflicts: [] }) });
  boundary.execute({ command_id: "candidate-evidence-intent", name: "task-intent.create", payload: makeIntent() });
  boundary.execute({ command_id: "candidate-evidence-compile", name: "capability.compile", payload: {} });
  boundary.execute({ command_id: "candidate-evidence-inventory", name: "inventory.refresh-local", payload: {} });
  const need = boundary.replay().capability_graphs[0].needs[0];
  boundary.execute({ command_id: "candidate-evidence-proposal", name: "resolution.propose", payload: { need_id: need.need_id, candidates: [selectedCandidate("evidence-local")], audit_facts: [] } });
  const events = fs.readFileSync(path.join(stateRoot, "events.jsonl"), "utf8").trim().split("\n").flatMap((line) => JSON.parse(line).events);
  const localEvaluation = events.find((event) => event.type === "candidate.evaluated" && event.payload.evaluation.candidate_id === "evidence-local");
  const buildEvaluation = events.find((event) => event.type === "candidate.evaluated" && event.payload.evaluation.candidate_id === `build:${need.need_id}`);
  assert.deepEqual(localEvaluation.evidence_refs, provider.evidence_refs);
  assert.deepEqual(buildEvaluation.evidence_refs, []);
});

test("all state-changing approval and Phase Review retries are idempotent before verifier or active-cycle checks", () => {
  let verifierCalls = 0;
  const { boundary, store } = makeBoundary({
    verifyUserApproval: (_evidence, target) => {
      verifierCalls += 1;
      return { actor: { type: "user", id: "verified-user" }, attestation: { source: "local_workbench_confirmation", challenge_id: `retry-${target.decision || "approval"}`, target_id: target.target_id, target_revision: target.target_revision, review_packet_hash: target.review_packet_hash, token_hash: "1".repeat(64), captured_at: "2026-07-16T07:30:00.000Z", expires_at: "2026-07-16T08:30:00.000Z", identity_assurance: "local_interaction_unverified_identity" } };
    },
    collectInventory: () => ({ version: 1, providers: [{ provider_id: "local-reuse", provider_type: "package", source_type: "repository", evidence_refs: ["workspace:package.json#local-reuse"] }], conflicts: [] }),
  });
  boundary.execute({ command_id: "retry-intent", name: "task-intent.create", payload: makeIntent() });
  boundary.execute({ command_id: "retry-compile", name: "capability.compile", payload: {} });
  boundary.execute({ command_id: "retry-inventory", name: "inventory.refresh-local", payload: {} });
  const need = boundary.replay().capability_graphs[0].needs[0];
  boundary.execute({ command_id: "retry-proposal", name: "resolution.propose", payload: { need_id: need.need_id, candidates: [selectedCandidate()], audit_facts: [] } });
  const resolution = boundary.replay().resolutions[0];
  const approval = { command_id: "retry-approval", name: "resolution.approve", payload: { resolution_id: resolution.resolution_id, approval_evidence: { raw_token: "retry" } } };
  assert.equal(boundary.execute(approval).status, "committed");
  assert.equal(boundary.execute(approval).status, "idempotent");
  assert.equal(verifierCalls, 1);

  const revision = boundary.replay().timeline.at(-1).sequence;
  store.commit({ expected_revision: revision, batch_id: "retry-packet-seed", actor: { type: "agent", id: "packet" }, correlation_id: "retry-packet-seed", events: [{ event_id: "retry-packet-event", schema_version: 1, type: "artifact.produced", payload: { artifact: { artifact_ref: "artifact:retry", artifact_hash: "2".repeat(64), kind: "phase_review_packet" }, responsibility: "implementation" }, evidence_refs: ["artifact:retry"] }] });
  const request = { command_id: "retry-review", name: "phase-review.request", payload: { phase_id: "retry-phase", build_ref: "build:retry", review_packet_ref: "artifact:retry", review_packet_hash: "2".repeat(64), checks: [{ name: "tests", status: "passed" }] } };
  assert.equal(boundary.execute(request).status, "committed");
  assert.equal(boundary.execute(request).status, "idempotent");
  const ready = { command_id: "retry-ready", name: "phase-review.decide", payload: { phase_id: "retry-phase", decision: "ready_for_user_review" } };
  assert.equal(boundary.execute(ready).status, "committed");
  assert.equal(boundary.execute(ready).status, "idempotent");
});

test("resolution approval rejects an older proposed resolution for the same Need", () => {
  const { boundary } = makeBoundary({ collectInventory: () => ({ version: 1, providers: ["local-reuse", "local-second"].map((provider_id) => ({ provider_id, provider_type: "package", source_type: "repository", evidence_refs: [`workspace:package.json#${provider_id}`] })), conflicts: [] }) });
  boundary.execute({ command_id: "stale-intent", name: "task-intent.create", payload: makeIntent() });
  boundary.execute({ command_id: "stale-compile", name: "capability.compile", payload: {} });
  boundary.execute({ command_id: "stale-inventory", name: "inventory.refresh-local", payload: {} });
  const need = boundary.replay().capability_graphs[0].needs[0];
  boundary.execute({ command_id: "stale-proposal-a", name: "resolution.propose", payload: { need_id: need.need_id, candidates: [selectedCandidate("local-reuse")], audit_facts: [] } });
  const first = boundary.replay().resolutions[0];
  boundary.execute({ command_id: "stale-proposal-b", name: "resolution.propose", payload: { need_id: need.need_id, candidates: [selectedCandidate("local-second")], audit_facts: [] } });
  assert.throws(() => boundary.execute({ command_id: "stale-approval", name: "resolution.approve", payload: { resolution_id: first.resolution_id, approval_evidence: { raw_token: "never-persist" } } }), { code: "CORE_RESOLUTION_STALE" });
});

test("phase review request derives its packet hash map only from persisted packet evidence", () => {
  const { boundary, store } = makeBoundary();
  const packet = { artifact_ref: "artifact:packet-integrity", artifact_hash: "a".repeat(64), kind: "phase_review_packet" };
  store.commit({
    expected_revision: 0,
    batch_id: "packet-integrity-seed",
    actor: { type: "agent", id: "implementation" },
    correlation_id: "packet-integrity-seed",
    events: [{ event_id: "packet-integrity-event", schema_version: 1, type: "artifact.produced", payload: { artifact: packet, responsibility: "implementation" }, evidence_refs: [packet.artifact_ref] }],
  });
  boundary.execute({
    command_id: "packet-integrity-request",
    name: "phase-review.request",
    payload: {
      phase_id: "phase-packet-integrity", build_ref: "build:packet", review_packet_ref: packet.artifact_ref,
      review_packet_hash: packet.artifact_hash, checks: [{ name: "tests", status: "passed" }],
      artifact_hashes: { [packet.artifact_ref]: "b".repeat(64), "artifact:untrusted": "b".repeat(64) },
    },
  });
  assert.deepEqual(boundary.replay().phase_reviews[0].artifact_hashes, { [packet.artifact_ref]: packet.artifact_hash });
});

test("proposal records the exact inventory, evaluation, and selected-provider evidence it used", () => {
  const { boundary, resolution } = prepareLocalProposal();
  const state = boundary.replay();
  const binding = state.resolution_bindings[resolution.resolution_id];
  const evaluation = state.candidate_evaluations.find((item) => item.candidate_id === resolution.selected_provider_id);
  assert.equal(binding.inventory_id, state.inventory.inventory_id);
  assert.equal(binding.selected_evaluation_id, evaluation.evaluation_id);
  assert.equal(binding.selected_evaluation_hash, canonicalHash(evaluation));
  assert.equal(binding.selected_provider_fingerprint, canonicalHash(state.providers[0]));
  assert.deepEqual(binding.candidate_evaluations, state.candidate_evaluations
    .map((item) => ({ evaluation_id: item.evaluation_id, evaluation_hash: canonicalHash(item) }))
    .sort((left, right) => left.evaluation_id < right.evaluation_id ? -1 : left.evaluation_id > right.evaluation_id ? 1 : 0));
});

test("resolution approval fails closed when proposal inventory or same-proposal evaluation evidence is stale", () => {
  const changed = prepareLocalProposal();
  changed.refresh([localProvider("local-reuse", "b".repeat(64), ["workspace:package.json#local-reuse-v2"])]);
  assert.throws(() => changed.boundary.execute({
    command_id: "changed-provider-approval", name: "resolution.approve",
    payload: { resolution_id: changed.resolution.resolution_id, approval_evidence: { raw_token: "never-persist" } },
  }), { code: "CORE_RESOLUTION_STALE" });

  const removed = prepareLocalProposal();
  removed.refresh([]);
  assert.throws(() => removed.boundary.execute({
    command_id: "removed-provider-approval", name: "resolution.approve",
    payload: { resolution_id: removed.resolution.resolution_id, approval_evidence: { raw_token: "never-persist" } },
  }), { code: "CORE_RESOLUTION_STALE" });

  const swapped = prepareLocalProposal();
  const originalEvaluation = swapped.boundary.replay().candidate_evaluations.find((item) => item.candidate_id === "local-reuse");
  swapped.store.commit({
    expected_revision: swapped.boundary.replay().timeline.at(-1).sequence,
    batch_id: "swapped-evaluation",
    actor: { type: "agent", id: "external-audit" },
    correlation_id: "swapped-evaluation",
    events: [{
      event_id: "swapped-evaluation-event",
      schema_version: 1,
      type: "candidate.evaluated",
      payload: { evaluation: { ...originalEvaluation, policy_version: "replaced-evidence" }, responsibility: "static_audit" },
      evidence_refs: [],
    }],
  });
  assert.throws(() => swapped.boundary.execute({
    command_id: "swapped-evaluation-approval", name: "resolution.approve",
    payload: { resolution_id: swapped.resolution.resolution_id, approval_evidence: { raw_token: "never-persist" } },
  }), { code: "CORE_RESOLUTION_STALE" });
});

test("synthetic build keeps same-proposal evaluation binding while providerless ask remains a user decision", () => {
  const build = makeBoundary();
  build.boundary.execute({ command_id: "build-intent", name: "task-intent.create", payload: makeIntent() });
  build.boundary.execute({ command_id: "build-compile", name: "capability.compile", payload: {} });
  const buildNeed = build.boundary.replay().capability_graphs[0].needs[0];
  build.boundary.execute({
    command_id: "build-proposal",
    name: "resolution.propose",
    payload: {
      need_id: buildNeed.need_id,
      candidates: [],
      audit_facts: [{
        candidate_id: `build:${buildNeed.need_id}`,
        static_metadata: { license: "not_applicable", runtime: "compatible", security: "no_critical_finding", accessibility: "met" },
        axes: axes(70),
        uncertainty_penalty: 4,
        unknowns: [],
        estimated_total_cost: 0,
      }],
    },
  });
  const buildResolution = build.boundary.replay().resolutions[0];
  assert.equal(buildResolution.mode, "build");
  const buildEvaluation = build.boundary.replay().candidate_evaluations.find((item) => item.candidate_id === buildResolution.selected_provider_id);
  build.store.commit({
    expected_revision: build.boundary.replay().timeline.at(-1).sequence,
    batch_id: "build-evaluation-swapped",
    actor: { type: "agent", id: "external-audit" },
    correlation_id: "build-evaluation-swapped",
    events: [{
      event_id: "build-evaluation-swapped-event",
      schema_version: 1,
      type: "candidate.evaluated",
      payload: { evaluation: { ...buildEvaluation, policy_version: "replaced-build-evidence" }, responsibility: "static_audit" },
      evidence_refs: [],
    }],
  });
  assert.throws(() => build.boundary.execute({
    command_id: "build-approval",
    name: "resolution.approve",
    payload: { resolution_id: buildResolution.resolution_id, approval_evidence: { raw_token: "never-persist" } },
  }), { code: "CORE_RESOLUTION_STALE" });

  const ask = makeBoundary();
  ask.boundary.execute({ command_id: "ask-intent", name: "task-intent.create", payload: makeIntent() });
  ask.boundary.execute({ command_id: "ask-compile", name: "capability.compile", payload: {} });
  const askNeed = ask.boundary.replay().capability_graphs[0].needs[0];
  ask.boundary.execute({ command_id: "ask-proposal", name: "resolution.propose", payload: { need_id: askNeed.need_id, candidates: [], audit_facts: [] } });
  const askResolution = ask.boundary.replay().resolutions[0];
  assert.equal(askResolution.mode, "ask");
  assert.equal(askResolution.selected_provider_id, null);
  assert.doesNotThrow(() => ask.boundary.execute({
    command_id: "ask-approval",
    name: "resolution.approve",
    payload: { resolution_id: askResolution.resolution_id, approval_evidence: { raw_token: "never-persist" } },
  }));
  assert.equal(ask.boundary.replay().resolutions[0].selected_provider_id, null);
});

test("context preview uses a trusted detached compiler result bound to current lifecycle evidence", () => {
  const calls = [];
  let compiledPack;
  const compiler = (input) => {
    compiledPack = trustedDraftContextPack(input).context_pack;
    calls.push(copy(input));
    input.request.compiler_mutation = "must-not-affect-command";
    input.taskIntent.desired_outcome = "must-not-affect-projection";
    input.resolutions[0].rationale = "must-not-affect-projection";
    return { context_pack: compiledPack };
  };
  const { boundary } = makeBoundary({ compileContextPack: compiler });
  boundary.execute({ command_id: "context-intent", name: "task-intent.create", payload: makeIntent() });
  boundary.execute({ command_id: "context-compile", name: "capability.compile", payload: {} });
  const need = boundary.replay().capability_graphs[0].needs[0];
  boundary.execute({ command_id: "context-proposal", name: "resolution.propose", payload: { need_id: need.need_id, candidates: [], audit_facts: [] } });
  const stateBeforePreview = boundary.replay();
  const rogueIntent = { ...stateBeforePreview.task_intents[0], task_intent_id: "TI-unrelated" };
  const callerPack = trustedDraftContextPack({ taskIntent: rogueIntent, resolutions: [] }).context_pack;
  const command = {
    command_id: "context-preview",
    name: "context-pack.preview",
    payload: { request_marker: "caller-request", context_pack: callerPack },
  };
  const freshCommand = { ...command, payload: copy(command.payload) };
  const result = boundary.execute(command);
  const state = boundary.replay();
  assert.equal(result.status, "committed");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].request.context_pack, undefined);
  assert.equal(calls[0].taskIntent.task_intent_id, stateBeforePreview.task_intents[0].task_intent_id);
  assert.deepEqual(calls[0].resolutions.map((resolution) => resolution.resolution_id), [stateBeforePreview.resolutions[0].resolution_id]);
  assert.deepEqual(state.context_packs[0], compiledPack);
  assert.equal(state.current_context_pack_id, compiledPack.context_pack_id);
  assert.equal(state.current_context_pack_sequence, result.sequence);
  assert.equal(state.task_intents[0].desired_outcome, makeIntent().desiredOutcome);
  assert.equal(boundary.execute(freshCommand).status, "idempotent");
});

test("context preview rejects a trusted compiler pack whose canonical lifecycle binding is wrong", () => {
  let roguePack;
  const compiler = () => ({ context_pack: roguePack });
  const { boundary } = makeBoundary({ compileContextPack: compiler });
  boundary.execute({ command_id: "context-invalid-intent", name: "task-intent.create", payload: makeIntent() });
  boundary.execute({ command_id: "context-invalid-compile", name: "capability.compile", payload: {} });
  const need = boundary.replay().capability_graphs[0].needs[0];
  boundary.execute({ command_id: "context-invalid-proposal", name: "resolution.propose", payload: { need_id: need.need_id, candidates: [], audit_facts: [] } });
  const state = boundary.replay();
  const callerPack = trustedDraftContextPack({ taskIntent: state.task_intents[0], resolutions: state.resolutions }).context_pack;
  roguePack = trustedDraftContextPack({
    taskIntent: { ...state.task_intents[0], task_intent_id: "TI-wrong-binding" },
    resolutions: state.resolutions,
  }).context_pack;
  assert.throws(() => boundary.execute({
    command_id: "context-invalid-preview",
    name: "context-pack.preview",
    payload: { context_pack: callerPack },
  }), { code: "CORE_CONTEXT_PACK_BINDING_INVALID" });
  assert.equal(boundary.replay().context_packs.length, 0);
});

test("context preview rejects duplicate provenance keys before it writes lifecycle evidence", () => {
  const variants = [
    { name: "conflicting", duplicateHash: "f".repeat(64), reverse: false },
    { name: "conflicting-reversed", duplicateHash: "f".repeat(64), reverse: true },
    { name: "same", duplicateHash: null, reverse: false },
    { name: "same-reversed", duplicateHash: null, reverse: true },
  ];
  const outcomes = variants.map((variant) => {
    let duplicate = true;
    const { boundary, store } = makeBoundary({
      compileContextPack: (input) => ({
        context_pack: duplicate
          ? duplicateTaskIntentProvenance(input, variant.duplicateHash || canonicalHash(input.taskIntent), variant.reverse)
          : trustedDraftContextPack(input).context_pack,
      }),
    });
    boundary.execute({ command_id: `provenance-${variant.name}-intent`, name: "task-intent.create", payload: makeIntent() });
    boundary.execute({ command_id: `provenance-${variant.name}-compile`, name: "capability.compile", payload: {} });
    const need = boundary.replay().capability_graphs[0].needs[0];
    boundary.execute({ command_id: `provenance-${variant.name}-proposal`, name: "resolution.propose", payload: { need_id: need.need_id, candidates: [], audit_facts: [] } });
    const command = { command_id: `provenance-${variant.name}-preview`, name: "context-pack.preview", payload: {} };
    const before = contextPackSnapshot(store, boundary);
    let result;
    let error;
    try {
      result = boundary.execute(command);
    } catch (caught) {
      error = caught;
    }
    const after = contextPackSnapshot(store, boundary);
    duplicate = false;
    let cleanResult;
    let cleanError;
    try {
      cleanResult = boundary.execute(command);
    } catch (caught) {
      cleanError = caught;
    }
    return {
      status: result && result.status,
      code: error && error.code,
      details: error && error.details,
      before,
      after,
      clean_status: cleanResult && cleanResult.status,
      clean_code: cleanError && cleanError.code,
    };
  });

  assert.deepEqual(outcomes.map((outcome) => outcome.status), [undefined, undefined, undefined, undefined]);
  assert.deepEqual(outcomes.map((outcome) => outcome.code), Array(4).fill("CORE_CONTEXT_PACK_BINDING_INVALID"));
  assert.deepEqual(outcomes.map((outcome) => outcome.details), Array(4).fill({
    reason: "provenance_duplicate",
    kind: "task_intent",
    source_ref: `task_intent:${createTaskIntent(makeIntent()).task_intent_id}`,
  }));
  for (const outcome of outcomes) {
    assert.deepEqual(outcome.after, outcome.before);
    assert.equal(outcome.clean_status, "committed");
    assert.equal(outcome.clean_code, undefined);
  }
});

test("callback mutation cannot alter the precomputed command identity or a fresh retry", () => {
  const originalPayload = { refresh_scope: "local" };
  const expectedHash = canonicalHash(originalPayload);
  const { boundary, stateRoot } = makeBoundary({
    collectInventory: (payload) => {
      payload.collector_mutation = "added";
      return { version: 1, providers: [], conflicts: [] };
    },
  });
  const command = { command_id: "mutable-inventory", name: "inventory.refresh-local", payload: copy(originalPayload) };
  assert.equal(boundary.execute(command).status, "committed");
  const batch = JSON.parse(fs.readFileSync(path.join(stateRoot, "events.jsonl"), "utf8").trim());
  assert.equal(batch.events[0].payload.command_identity.payload_hash, expectedHash);
  assert.equal(fs.readFileSync(path.join(stateRoot, "events.jsonl"), "utf8").includes("collector_mutation"), false);
  assert.equal(boundary.execute({ command_id: "mutable-inventory", name: "inventory.refresh-local", payload: copy(originalPayload) }).status, "idempotent");
});

test("approval verifier receives detached evidence and target snapshots", () => {
  const { boundary } = makeBoundary({
    verifyUserApproval: (evidence, target) => {
      const originalTarget = copy(target);
      evidence.verifier_mutation = "added";
      target.target_revision = 999;
      return {
        actor: { type: "user", id: "verified-user" },
        attestation: {
          source: "local_workbench_confirmation", challenge_id: "detached-verifier", target_id: originalTarget.target_id,
          target_revision: originalTarget.target_revision, review_packet_hash: originalTarget.review_packet_hash,
          token_hash: "c".repeat(64), captured_at: "2026-07-16T07:30:00.000Z",
          expires_at: "2026-07-16T08:30:00.000Z", identity_assurance: "local_interaction_unverified_identity",
        },
      };
    },
  });
  boundary.execute({ command_id: "detached-intent", name: "task-intent.create", payload: makeIntent() });
  boundary.execute({ command_id: "detached-compile", name: "capability.compile", payload: {} });
  const need = boundary.replay().capability_graphs[0].needs[0];
  boundary.execute({ command_id: "detached-proposal", name: "resolution.propose", payload: { need_id: need.need_id, candidates: [], audit_facts: [] } });
  const resolution = boundary.replay().resolutions[0];
  const originalPayload = { resolution_id: resolution.resolution_id, approval_evidence: { raw_token: "never-persist" } };
  const expectedHash = canonicalHash(originalPayload);
  assert.equal(boundary.execute({ command_id: "detached-approval", name: "resolution.approve", payload: copy(originalPayload) }).status, "committed");
  const entry = boundary.replay().timeline.at(-1);
  assert.equal(entry.command_identity.payload_hash, expectedHash);
  assert.equal(boundary.execute({ command_id: "detached-approval", name: "resolution.approve", payload: copy(originalPayload) }).status, "idempotent");
});

test("external events without explicit responsibility remain unattributed rather than impersonating orchestrator", () => {
  const { boundary, store } = makeBoundary();
  const artifact = { artifact_ref: "artifact:unattributed", artifact_hash: "d".repeat(64), kind: "phase_review_packet" };
  store.commit({
    expected_revision: 0,
    batch_id: "unattributed-artifact",
    actor: { type: "agent", id: "implementation-001" },
    correlation_id: "unattributed-artifact",
    events: [{ event_id: "unattributed-artifact-event", schema_version: 1, type: "artifact.produced", payload: { artifact }, evidence_refs: [artifact.artifact_ref] }],
  });
  const entry = boundary.replay().timeline[0];
  assert.equal(entry.actor.id, "implementation-001");
  assert.equal(entry.responsibility, "unattributed");
  assert.notEqual(entry.responsibility, "orchestrator");
});
