"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { canonicalHash } = require("@orquesta/contracts");
const { createEventStore } = require("@orquesta/event-store");
const core = require("../src");

const NOW = "2026-07-17T00:00:00.000Z";
const LATER = "2026-07-17T01:00:00.000Z";

function axes() {
  return Object.fromEntries(["task_fit", "integration_ease", "evidence_strength", "maintainability", "security", "license_fit", "exit_option", "cost"]
    .map((axis) => [axis, { value: 100, reason: "fixture" }]));
}

function intent() {
  return {
    rawRequestRef: "request:install", desiredOutcome: "Use a selected package", acceptanceCriteria: ["Verify package evidence"],
    constraints: [], risk: { impact: "high", reversible: true },
    authorityBoundary: { agent_may: ["request"], user_only: ["authorize"] }, assumptions: [], status: "compiled"
  };
}

function candidate(providerId = "candidate-package") {
  return {
    provider_id: providerId, provider_type: "package", resolution_mode: "reuse",
    evidence_refs: [`workspace:package.json#${providerId}`],
    static_metadata: { license: "MIT", runtime: "compatible", security: "low" },
    axes: axes(), uncertainty_penalty: 0, estimated_total_cost: 0, unknowns: []
  };
}

function provider(overrides = {}) {
  return {
    provider_id: "candidate-package", provider_type: "package", source_type: "package_manifest",
    source_uri: "workspace:package.json#candidate-package", capabilities: ["candidate package"], trust_tier: "local",
    availability: "available", version: "2.3.4", last_verified_at: NOW, provider_hash: "a".repeat(64),
    evidence_refs: ["workspace:package.json#candidate-package"], ...overrides
  };
}

function makeBoundary(options = {}) {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-install-approval-"));
  const store = createEventStore({ stateRoot, workspaceId: "install-test", clock: () => NOW });
  let providers = [provider()];
  const observedTargets = [];
  const verifyUserApproval = options.verifyUserApproval || ((evidence, target) => {
    observedTargets.push(JSON.parse(JSON.stringify(target)));
    assert.equal(evidence.raw_token, "approval-secret");
    return {
      actor: { type: "user", id: "verified-install-user" },
      attestation: {
        source: "local_workbench_confirmation", challenge_id: "install-challenge",
        target_id: target.target_id, target_revision: target.target_revision, review_packet_hash: target.review_packet_hash,
        token_hash: canonicalHash(evidence.raw_token), captured_at: NOW, expires_at: LATER,
        identity_assurance: "local_interaction_unverified_identity"
      }
    };
  });
  const boundary = core.createCommandBoundary({
    eventStore: store,
    rules: { catalog_version: 1, rules: [{ rule_id: "package", match: { any_terms: ["package"], acceptance_terms: ["evidence"] }, emits: [{ kind: "evidence", description: "package evidence", verification_method: "verify" }] }] },
    collectInventory: () => ({ version: 1, providers, conflicts: [] }),
    verifyUserApproval,
    referenceTime: NOW
  });
  return {
    stateRoot, store, boundary, observedTargets,
    setProviders(next) { providers = next; }
  };
}

function prepare(options = {}) {
  const result = makeBoundary(options);
  const { boundary, store } = result;
  boundary.execute({ command_id: "install-intent", name: "task-intent.create", payload: intent() });
  boundary.execute({ command_id: "install-compile", name: "capability.compile", payload: {} });
  boundary.execute({ command_id: "install-inventory", name: "inventory.refresh-local", payload: {} });
  const need = boundary.replay().capability_graphs[0].needs[0];
  boundary.execute({ command_id: "install-proposal", name: "resolution.propose", payload: { need_id: need.need_id, candidates: [candidate()], audit_facts: [] } });
  const resolution = boundary.replay().resolutions[0];
  boundary.execute({ command_id: "install-resolution-approval", name: "resolution.approve", payload: { resolution_id: resolution.resolution_id, approval_evidence: { raw_token: "approval-secret" } } });
  const reviewPacket = { artifact_ref: "artifact:install-review", artifact_hash: "b".repeat(64), kind: "install_review_packet" };
  const currentSequence = boundary.replay().timeline.at(-1).sequence;
  store.commit({
    expected_revision: currentSequence, batch_id: "install-review-packet", actor: { type: "agent", id: "reviewer" }, correlation_id: "install-review-packet",
    events: [{ event_id: "install-review-packet-event", schema_version: 1, type: "artifact.produced", payload: { artifact: reviewPacket, responsibility: "reviewer" }, evidence_refs: [reviewPacket.artifact_ref] }]
  });
  const state = boundary.replay();
  return {
    ...result, need, resolution, reviewPacket,
    resolutionRevision: state.latest_resolution_by_need[resolution.need_id].sequence
  };
}

function targetInput(prepared, overrides = {}) {
  return {
    resolution_id: prepared.resolution.resolution_id,
    resolution_revision: prepared.resolutionRevision,
    candidate_id: "candidate-package",
    candidate_version: "2.3.4",
    source_hash: "a".repeat(64),
    dependency_preview_hash: "c".repeat(64),
    lockfile_preview_hash: "d".repeat(64),
    target_workspace: "C:/workspace/project",
    effects: ["dependency_change", "workspace_write"],
    expires_at: LATER,
    review_packet_ref: prepared.reviewPacket.artifact_ref,
    review_packet_hash: prepared.reviewPacket.artifact_hash,
    ...overrides
  };
}

function request(prepared, commandId = "install-request", overrides = {}) {
  const target = targetInput(prepared, overrides);
  const result = prepared.boundary.execute({ command_id: commandId, name: "candidate.install.request", payload: target });
  return { result, target: prepared.boundary.replay().current_install_request.target };
}

test("creates a deterministic semantic target bound to Resolution, candidate evidence, previews, workspace, effects, and review packet", () => {
  const prepared = prepare();
  const input = targetInput(prepared);
  const first = core.createInstallApprovalTarget(input);
  const second = core.createInstallApprovalTarget(JSON.parse(JSON.stringify(input)));
  assert.deepEqual(first, second);
  assert.match(first.target_id, /^INSTALL-[a-f0-9]{24}$/);
  assert.equal(first.target_revision, prepared.resolutionRevision);
  assert.equal(first.resolution_id, prepared.resolution.resolution_id);
  assert.deepEqual(first.effects, ["dependency_change", "workspace_write"]);

  for (const invalid of [
    { resolution_revision: 0 }, { source_hash: "bad" }, { dependency_preview_hash: "bad" },
    { lockfile_preview_hash: "bad" }, { effects: [] }, { review_packet_hash: "bad" }
  ]) assert.throws(() => core.createInstallApprovalTarget({ ...input, ...invalid }), { code: "CORE_INSTALL_TARGET_INVALID" });
});

test("requests and authorizes exactly one current target, commits one user event, replays it, and is idempotent", () => {
  const prepared = prepare();
  const requested = request(prepared);
  assert.equal(requested.result.status, "committed");
  assert.equal(prepared.boundary.execute({ command_id: "install-request", name: "candidate.install.request", payload: targetInput(prepared) }).status, "idempotent");
  assert.equal(prepared.boundary.replay().current_install_request.status, "pending_user");

  const command = {
    command_id: "install-authorize", name: "candidate.install.authorize",
    actor: { type: "user", id: "body-user-must-not-authorize" },
    payload: { target: requested.target, approval_evidence: { raw_token: "approval-secret", actor: "body-user", attestation: "body-attestation" } }
  };
  const authorized = prepared.boundary.execute(command);
  assert.equal(authorized.status, "committed");
  assert.equal(prepared.boundary.execute(command).status, "idempotent");
  const state = prepared.boundary.replay();
  assert.equal(state.current_install_request.status, "authorized");
  assert.equal(state.install_authorizations.length, 1);
  assert.equal(state.timeline.at(-1).type, "candidate.install.authorized");
  assert.equal(state.timeline.at(-1).actor.id, "verified-install-user");
  assert.equal(JSON.stringify(state).includes("approval-secret"), false);
  assert.equal(prepared.store.replay({ reducers: prepared.boundary.projectors, initialState: core.initialProjection() }).state.install_authorizations.length, 1);
  assert.throws(() => prepared.boundary.execute({ ...command, command_id: "install-authorize-duplicate" }), { code: "CORE_INSTALL_ALREADY_AUTHORIZED" });
});

test("rejects missing, stale, changed, expired, and non-current install evidence before user authorization", () => {
  const missing = makeBoundary();
  assert.throws(() => missing.boundary.execute({ command_id: "missing-install", name: "candidate.install.request", payload: {
    resolution_id: "missing", resolution_revision: 1, candidate_id: "candidate-package", candidate_version: "2.3.4", source_hash: "a".repeat(64),
    dependency_preview_hash: "c".repeat(64), lockfile_preview_hash: "d".repeat(64), target_workspace: "C:/workspace/project",
    effects: ["dependency_change"], expires_at: LATER, review_packet_ref: "artifact:missing", review_packet_hash: "b".repeat(64)
  } }), { code: "CORE_INSTALL_RESOLUTION_INVALID" });

  for (const overrides of [
    { candidate_id: "other" }, { candidate_version: "9.9.9" }, { source_hash: "e".repeat(64) },
    { resolution_revision: 999 }, { review_packet_hash: "e".repeat(64) }, { expires_at: "2026-07-16T23:59:59.000Z" }
  ]) {
    const prepared = prepare();
    assert.throws(() => request(prepared, `invalid-${Object.keys(overrides)[0]}`, overrides));
  }

  const changedTarget = prepare();
  const pending = request(changedTarget);
  assert.throws(() => changedTarget.boundary.execute({
    command_id: "changed-target-authorize", name: "candidate.install.authorize",
    payload: { target: { ...pending.target, lockfile_preview_hash: "e".repeat(64) }, approval_evidence: { raw_token: "approval-secret" } }
  }), { code: "CORE_INSTALL_TARGET_STALE" });

  const staleResolution = prepare();
  const stalePending = request(staleResolution);
  staleResolution.boundary.execute({ command_id: "new-install-proposal", name: "resolution.propose", payload: { need_id: staleResolution.need.need_id, candidates: [candidate()], audit_facts: [] } });
  assert.throws(() => staleResolution.boundary.execute({
    command_id: "stale-resolution-authorize", name: "candidate.install.authorize",
    payload: { target: stalePending.target, approval_evidence: { raw_token: "approval-secret" } }
  }), { code: "CORE_INSTALL_RESOLUTION_STALE" });

  const noCurrent = prepare();
  assert.throws(() => noCurrent.boundary.execute({
    command_id: "no-current-authorize", name: "candidate.install.authorize",
    payload: { target: core.createInstallApprovalTarget(targetInput(noCurrent)), approval_evidence: { raw_token: "approval-secret" } }
  }), { code: "CORE_INSTALL_TARGET_REQUIRED" });
});

test("Core exposes semantic authorization only and no install execution surface", () => {
  assert.equal(core.COMMAND_NAMES.includes("candidate.install.request"), true);
  assert.equal(core.COMMAND_NAMES.includes("candidate.install.authorize"), true);
  assert.equal(Object.prototype.hasOwnProperty.call(core, "installCandidate"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(core, "runInstall"), false);
  assert.equal(fs.readFileSync(require.resolve("../src/commands"), "utf8").includes("child_process"), false);
});
