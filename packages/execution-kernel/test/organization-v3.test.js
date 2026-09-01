"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { canonicalHash } = require("@orquesta/contracts");
const {
  FOUNDATION_AGENT_IDS,
  assertOrganizationV3Bundle,
  createFoundationOrganizationV3Bundle,
  createOrganizationV3Bundle,
  validateOrganizationV3Bundle
} = require("../src/organization-v3");
const { assessOrganizationV2ForV3 } = require("../src/organization-v2-assessor");
const { createOrganizationV3BoundaryFixture } = require("../test-support/organization-v3-boundary-fixture");

const timestamp = "2026-08-15T00:00:00.000Z";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function formationId(kind, sourceKind, sourceId) {
  return `formation-${kind}-${canonicalHash({ kind, sourceKind, sourceId }).slice(0, 12)}`;
}

test("fresh foundation is exactly three agents under the canonical user authority", () => {
  const foundation = createFoundationOrganizationV3Bundle({ createdAt: timestamp });
  assert.deepEqual(FOUNDATION_AGENT_IDS, ["orchestrator", "orquesta-admin", "user-support"]);
  assert.deepEqual(foundation.agentRegistry.agents.map(({ agent_id }) => agent_id), ["orchestrator", "orquesta-admin", "user-support"]);
  assert.deepEqual(foundation.agentRegistry.agents.map(({ lifecycle_state }) => lifecycle_state), ["provisioning", "provisioning", "provisioning"]);
  assert.deepEqual(foundation.organization.participants, [{
    participant_id: "user",
    display_name: "User",
    participant_kind: "human",
    lifecycle_state: "active",
    joined_at: timestamp
  }]);
  assert.deepEqual(foundation.organization.relationships, [{
    relationship_id: "relationship-user-authority-orchestrator",
    type: "authority_over",
    subject_ref: { kind: "participant", id: "user" },
    object_ref: { kind: "agent", id: "orchestrator" }
  }]);

  const missingParticipant = clone(foundation);
  missingParticipant.organization.participants = [];
  assert.ok(validateOrganizationV3Bundle(missingParticipant).issues.some(({ code }) => code === "CANONICAL_USER_MISSING"));

  const missingAuthorityTarget = clone(foundation);
  missingAuthorityTarget.organization.relationships[0].object_ref.id = "missing-agent";
  assert.ok(validateOrganizationV3Bundle(missingAuthorityTarget).issues.some(({ code }) => code === "CANONICAL_USER_AUTHORITY_INVALID"));

  const missingFoundationAgent = clone(foundation);
  missingFoundationAgent.agentRegistry.agents = missingFoundationAgent.agentRegistry.agents.filter(({ agent_id }) => agent_id !== "orquesta-admin");
  assert.ok(validateOrganizationV3Bundle(missingFoundationAgent).issues.some(({ code }) => code === "FOUNDATION_AGENT_MISSING"));

  const retiredFoundationAgent = clone(foundation);
  const admin = retiredFoundationAgent.agentRegistry.agents.find(({ agent_id }) => agent_id === "orquesta-admin");
  admin.lifecycle_state = "retired";
  admin.retired_at = timestamp;
  assert.ok(validateOrganizationV3Bundle(retiredFoundationAgent).issues.some(({ code }) => code === "FOUNDATION_AGENT_NOT_OPERATIONAL"));

  const wrongFoundationIdentity = clone(foundation);
  const orchestrator = wrongFoundationIdentity.agentRegistry.agents.find(({ agent_id }) => agent_id === "orchestrator");
  orchestrator.role_id = "testing";
  orchestrator.origin = "controller";
  orchestrator.created_from_ref = { kind: "task", id: "T-WRONG" };
  const identityIssues = validateOrganizationV3Bundle(wrongFoundationIdentity).issues;
  assert.ok(identityIssues.some(({ code }) => code === "FOUNDATION_ROLE_MISMATCH"));
  assert.ok(identityIssues.some(({ code }) => code === "FOUNDATION_ORIGIN_MISMATCH"));
  assert.ok(identityIssues.some(({ code }) => code === "FOUNDATION_PROVENANCE_MISMATCH"));

  const splitBootstrap = clone(foundation);
  splitBootstrap.agentRegistry.agents.find(({ agent_id }) => agent_id === "user-support").created_from_ref.id = "another-bootstrap";
  assert.ok(validateOrganizationV3Bundle(splitBootstrap).issues.some(({ code }) => code === "FOUNDATION_BOOTSTRAP_MISMATCH"));

  const duplicateAuthority = clone(foundation);
  duplicateAuthority.organization.relationships.push({ ...clone(duplicateAuthority.organization.relationships[0]), relationship_id: "duplicate-user-authority" });
  const authorityIssues = validateOrganizationV3Bundle(duplicateAuthority).issues;
  assert.ok(authorityIssues.some(({ code }) => code === "CANONICAL_USER_AUTHORITY_INVALID"));
  assert.ok(authorityIssues.some(({ code }) => code === "CONTRACT_ORGANIZATION_STATE_V3_ORGANIZATION_V3_RELATIONSHIP_SEMANTIC_UNIQUE"));

  const wrongContext = clone(foundation);
  wrongContext.agentRegistry.agents.find(({ agent_id }) => agent_id === "orchestrator").context_scope = ["task:tiny"];
  assert.ok(validateOrganizationV3Bundle(wrongContext).issues.some(({ code }) => code === "FOUNDATION_CONTEXT_SCOPE_MISMATCH"));

  const rogueFoundation = clone(foundation);
  rogueFoundation.agentRegistry.agents.push({
    agent_id: "rogue-foundation", role_id: "rogue-foundation", role_version: 1,
    mission: "Impersonate foundation authority.", context_scope: ["project"], lifecycle_state: "provisioning",
    origin: "foundation", created_from_ref: { kind: "project_bootstrap", id: "foundation" }, retired_at: null
  });
  assert.ok(validateOrganizationV3Bundle(rogueFoundation).issues.some(({ code }) => code === "FOUNDATION_AGENT_ID_INVALID"));

  const overCapacity = clone(foundation);
  overCapacity.agentRegistry.agents.push({
    agent_id: "fourth-provisioning", role_id: "implementation", role_version: 1,
    mission: "Exceed saved policy capacity.", context_scope: ["project"], lifecycle_state: "provisioning",
    origin: "controller", created_from_ref: { kind: "task", id: "T-FOURTH" }, retired_at: null
  });
  assert.ok(validateOrganizationV3Bundle(overCapacity).issues.some(({ code }) => code === "PROVISIONING_CAPACITY_EXCEEDED"));
  assert.throws(() => createOrganizationV3Bundle(overCapacity), /PROVISIONING_CAPACITY_EXCEEDED/);

  const rogueOuterAuthority = clone(foundation);
  rogueOuterAuthority.rogue_authority = { writer: "other" };
  assert.ok(validateOrganizationV3Bundle(rogueOuterAuthority).issues.some(({ code }) => code === "ORGANIZATION_BUNDLE_KEYS_INVALID"));
  assert.throws(() => createOrganizationV3Bundle(rogueOuterAuthority), /ORGANIZATION_BUNDLE_KEYS_INVALID/);
});

test("normalization never invents missing required Organization v3 arrays", () => {
  const requiredArrays = [
    ["agentRegistry", "agents"],
    ["organization", "participants"],
    ["organization", "lines"],
    ["organization", "teams"],
    ["organization", "memberships"],
    ["organization", "relationships"],
    ["organization", "applied_decision_ids"],
    ["organization", "applied_decision_bindings"],
    ["formations", "formations"]
  ];
  for (const [section, field] of requiredArrays) {
    const incomplete = bundleFixture();
    delete incomplete[section][field];
    assert.equal(validateOrganizationV3Bundle(incomplete).ok, false, `${section}.${field} must remain missing`);
    assert.throws(() => createOrganizationV3Bundle(incomplete), /validation failed/, `${section}.${field} must not be healed`);
  }
});

function bundleFixture() {
  return {
    agentRegistry: {
      schema_version: 3,
      organization_revision: 4,
      agents: [
        { agent_id: "implementation-001", role_id: "implementation", role_version: 1, mission: "Implement.", context_scope: ["line-a"], lifecycle_state: "active", origin: "controller", created_from_ref: { kind: "task", id: "T-A" }, retired_at: null },
        { agent_id: "implementation-002", role_id: "implementation", role_version: 1, mission: "Implement.", context_scope: ["line-b"], lifecycle_state: "active", origin: "controller", created_from_ref: { kind: "task", id: "T-B" }, retired_at: null },
        { agent_id: "orchestrator", role_id: "orchestrator", role_version: 1, mission: "Coordinate.", context_scope: ["project"], lifecycle_state: "active", origin: "foundation", created_from_ref: { kind: "project_bootstrap", id: "foundation" }, retired_at: null },
        { agent_id: "orquesta-admin", role_id: "orquesta-admin", role_version: 1, mission: "Maintain Orquesta.", context_scope: ["project"], lifecycle_state: "active", origin: "foundation", created_from_ref: { kind: "project_bootstrap", id: "foundation" }, retired_at: null },
        { agent_id: "user-support", role_id: "user-support", role_version: 1, mission: "Support the user.", context_scope: ["project"], lifecycle_state: "active", origin: "foundation", created_from_ref: { kind: "project_bootstrap", id: "foundation" }, retired_at: null }
      ]
    },
    organization: {
      schema_version: 3,
      revision: 4,
      policy: { line_creation: "review", max_concurrent_provisioning: 3, require_executable_task_per_new_agent: true, require_no_file_ownership_conflict: true },
      participants: [
        { participant_id: "owner", display_name: "Owner", participant_kind: "human", lifecycle_state: "active", joined_at: timestamp },
        { participant_id: "user", display_name: "User", participant_kind: "human", lifecycle_state: "active", joined_at: timestamp }
      ],
      lines: [
        { line_id: "line-a", display_name: "A", goal: "A goal", deliverable_ids: ["A"], completion_root_ids: ["CM-A"], scope: ["a"], owner_ref: { kind: "participant", id: "owner" }, status: "active", approval_source: "user_approval" },
        { line_id: "line-b", display_name: "B", goal: "B goal", deliverable_ids: ["B"], completion_root_ids: ["CM-B"], scope: ["b"], owner_ref: { kind: "agent", id: "orchestrator" }, status: "active", approval_source: "user_approval" }
      ],
      teams: [
        { team_id: "a-build", line_id: "line-a", display_name: "A build", purpose: "Build A", coordination_mode: "peer", lead_agent_id: null, lifecycle_state: "active" },
        { team_id: "a-review", line_id: "line-a", display_name: "A review", purpose: "Review A", coordination_mode: "peer", lead_agent_id: null, lifecycle_state: "active" },
        { team_id: "b-build", line_id: "line-b", display_name: "B build", purpose: "Build B", coordination_mode: "peer", lead_agent_id: null, lifecycle_state: "active" }
      ],
      memberships: [
        { membership_id: "m-a-build", agent_id: "implementation-001", team_id: "a-build", position: "member", ordinal: 1, active_from: timestamp, active_to: null },
        { membership_id: "m-a-review", agent_id: "implementation-001", team_id: "a-review", position: "member", ordinal: 1, active_from: timestamp, active_to: null },
        { membership_id: "m-b-build", agent_id: "implementation-002", team_id: "b-build", position: "member", ordinal: 1, active_from: timestamp, active_to: null }
      ],
      relationships: [
        { relationship_id: "owner-a", type: "authority_over", subject_ref: { kind: "participant", id: "owner" }, object_ref: { kind: "line", id: "line-a" } },
        { relationship_id: "impl-reports", type: "reports_to", subject_ref: { kind: "agent", id: "implementation-001" }, object_ref: { kind: "agent", id: "orchestrator" } },
        { relationship_id: "user-authority", type: "authority_over", subject_ref: { kind: "participant", id: "user" }, object_ref: { kind: "agent", id: "orchestrator" } }
      ],
      applied_decision_ids: [],
      applied_decision_bindings: []
    },
    formations: {
      schema_version: 1,
      organization_revision: 4,
      formations: [
        {
          formation_id: formationId("workflow", "workflow_run", "RUN-1"),
          formation_kind: "work_cell",
          source_ref: { kind: "workflow_run", id: "RUN-1" },
          scope_ref: { kind: "project", id: "orquesta" },
          member_agent_ids: ["implementation-001", "implementation-002"],
          coordination_mode: "workflow_managed",
          lead_agent_id: null,
          target_refs: [],
          lifecycle_state: "active",
          created_at: timestamp,
          retired_at: null
        }
      ]
    }
  };
}

function legacyFixture() {
  return {
    organization: {
      schema_version: 2,
      revision: 4,
      policy: { organization_changes: "autonomous_except_new_line", max_concurrent_provisioning: 3, require_executable_task_per_new_agent: true, require_no_file_ownership_conflict: true },
      agents: [
        { agent_id: "implementation-001", role_id: "implementation", organization_scope: "line", lifecycle_state: "active", operational_status: "working" },
        { agent_id: "orchestrator", role_id: "orchestrator", organization_scope: "project", lifecycle_state: "active", operational_status: "working" }
      ],
      teams: [{ team_id: "team-a", line_id: "line-a", display_name: "Team A", purpose: "Build A", lifecycle_state: "active" }],
      memberships: [{ membership_id: "m-a", agent_id: "implementation-001", team_id: "team-a", position: "member", ordinal: 1, active_from: timestamp, active_to: null }],
      relationships: [{ relationship_id: "reports-a", type: "reports_to", from_agent_id: "implementation-001", to_agent_id: "orchestrator" }],
      lines: [{ line_id: "line-a", display_name: "Line A", goal: "Deliver A", deliverable_ids: ["A"], completion_root_ids: ["CM-A"], scope: ["a"], owner_agent_id: "orchestrator", dedicated_lead_agent_id: null, status: "active", approval_source: "user_approval" }],
      applied_decision_ids: []
    },
    agents: {
      schema_version: 2,
      organization_revision: 4,
      agents: [
        { agent_id: "implementation-001", role_id: "implementation", role_version: 1, mission: "Implement A.", context_scope: "line-a", lifecycle_state: "active", provisioning_batch_id: "PB-A", provisioning_task_id: "T-A" },
        { agent_id: "orchestrator", role_id: "orchestrator", role_version: 1, mission: "Coordinate.", context_scope: "project", lifecycle_state: "active" }
      ]
    }
  };
}

test("same-line multi-team membership and temporary cross-line formations are valid", () => {
  const bundle = createOrganizationV3Bundle(bundleFixture());
  assert.doesNotThrow(() => assertOrganizationV3Bundle(bundle));
  assert.equal(validateOrganizationV3Bundle(bundle).ok, true);
});

test("persistent cross-line membership and reporting cycles are rejected explicitly", () => {
  const crossLine = bundleFixture();
  crossLine.organization.memberships.push({ membership_id: "m-a-cross", agent_id: "implementation-001", team_id: "b-build", position: "member", ordinal: 2, active_from: timestamp, active_to: null });
  assert.ok(validateOrganizationV3Bundle(crossLine).issues.some((issue) => issue.code === "PERSISTENT_CROSS_LINE_MEMBERSHIP"));

  const cycle = bundleFixture();
  cycle.organization.relationships.push({ relationship_id: "orchestrator-reports", type: "reports_to", subject_ref: { kind: "agent", id: "orchestrator" }, object_ref: { kind: "agent", id: "implementation-001" } });
  cycle.organization.relationships.push({ relationship_id: "impl-reports-second", type: "reports_to", subject_ref: { kind: "agent", id: "implementation-001" }, object_ref: { kind: "agent", id: "implementation-002" } });
  const cycleIssues = validateOrganizationV3Bundle(cycle).issues;
  assert.ok(cycleIssues.some((issue) => issue.code === "CONTRACT_ORGANIZATION_STATE_V3_ORGANIZATION_V3_REPORTS_TO_CYCLE"));
  assert.ok(cycleIssues.some((issue) => issue.code === "CONTRACT_ORGANIZATION_STATE_V3_ORGANIZATION_V3_REPORTS_TO_UNIQUE"));
  assert.equal(cycleIssues.filter((issue) => issue.code.includes("REPORTS_TO_CYCLE")).length, 1, "contracts must be the sole reports_to cycle authority");
});

test("coordination mode is semantic and never derived from member count", () => {
  const supervised = bundleFixture();
  supervised.organization.teams[0].coordination_mode = "supervised";
  assert.ok(validateOrganizationV3Bundle(supervised).issues.some((issue) => issue.code === "CONTRACT_ORGANIZATION_STATE_V3_ORGANIZATION_V3_SUPERVISED_LEAD"));

  const peer = bundleFixture();
  peer.organization.teams[0].lead_agent_id = "implementation-001";
  peer.organization.memberships[0].position = "lead";
  const peerIssues = validateOrganizationV3Bundle(peer).issues;
  assert.ok(peerIssues.some((issue) => issue.code === "CONTRACT_ORGANIZATION_STATE_V3_ORGANIZATION_V3_PEER_LEAD"));
  assert.equal(peerIssues.filter((issue) => issue.code.includes("PEER_LEAD")).length, 1, "contracts must be the sole team coordination authority");

  const threePeers = bundleFixture();
  threePeers.agentRegistry.agents.push({ agent_id: "implementation-003", role_id: "implementation", role_version: 1, mission: "Implement.", context_scope: ["line-a"], lifecycle_state: "active", origin: "controller", created_from_ref: { kind: "task", id: "T-C" }, retired_at: null });
  threePeers.agentRegistry.agents.push({ agent_id: "implementation-004", role_id: "implementation", role_version: 1, mission: "Implement.", context_scope: ["line-a"], lifecycle_state: "active", origin: "controller", created_from_ref: { kind: "task", id: "T-D" }, retired_at: null });
  threePeers.organization.memberships.push({ membership_id: "m-a-3", agent_id: "implementation-003", team_id: "a-build", position: "member", ordinal: 2, active_from: timestamp, active_to: null });
  threePeers.organization.memberships.push({ membership_id: "m-a-4", agent_id: "implementation-004", team_id: "a-build", position: "member", ordinal: 3, active_from: timestamp, active_to: null });
  assert.equal(validateOrganizationV3Bundle(threePeers).ok, true);
});

test("v2 migration is pure, deterministic, and preserves explicit legacy relationships", () => {
  const source = legacyFixture();
  const before = clone(source);
  const first = assessOrganizationV2ForV3(source);
  const second = assessOrganizationV2ForV3(source);
  assert.deepEqual(source, before);
  assert.deepEqual(first, second);
  assert.equal(first.status, "review_required");
  assert.equal(first.bundle.organization.relationships[0].type, "reports_to");
  assert.equal(first.bundle.organization.teams[0].coordination_mode, "peer");
  assert.deepEqual(first.bundle.agentRegistry.agents.map((agent) => agent.created_from_ref.kind), ["migration", "migration"]);
  assert.ok(first.issues.some((issue) => issue.code === "FOUNDATION_AGENT_MISSING"));
  assert.ok(first.issues.some((issue) => issue.code === "CANONICAL_USER_MISSING"));
  assert.equal(first.source_hash.length, 64);
});

test("v2 migration quarantines Setup Wizard provenance instead of preserving it in v3", () => {
  const source = legacyFixture();
  source.organization.lines[0].approval_source = "setup_confirmation";
  source.agents.agents[0].created_from_ref = { kind: "setup", id: "legacy-setup" };
  const migrated = assessOrganizationV2ForV3(source);
  assert.equal(migrated.status, "review_required");
  assert.equal(migrated.bundle.organization.lines[0].approval_source, "migrated_legacy");
  assert.equal(migrated.bundle.agentRegistry.agents[0].created_from_ref.kind, "migration");
  assert.equal(migrated.bundle.agentRegistry.agents[0].created_from_ref.id, "T-A");
});

test("ambiguous count-era leads and malformed references require review without guessing", () => {
  const ambiguous = legacyFixture();
  ambiguous.organization.agents.push({ agent_id: "implementation-002", role_id: "implementation", organization_scope: "line", lifecycle_state: "active", operational_status: "working" });
  ambiguous.organization.agents.push({ agent_id: "implementation-003", role_id: "implementation", organization_scope: "line", lifecycle_state: "active", operational_status: "working" });
  ambiguous.organization.memberships[0].position = "lead";
  ambiguous.organization.memberships.push({ membership_id: "m-b", agent_id: "implementation-002", team_id: "team-a", position: "member", ordinal: 2, active_from: timestamp, active_to: null });
  ambiguous.organization.memberships.push({ membership_id: "m-c", agent_id: "implementation-003", team_id: "team-a", position: "member", ordinal: 3, active_from: timestamp, active_to: null });
  ambiguous.agents.agents.push({ agent_id: "implementation-002", role_id: "implementation", role_version: 1, mission: "Implement.", context_scope: "line-a", lifecycle_state: "active", provisioning_batch_id: "PB-A", provisioning_task_id: "T-B" });
  ambiguous.agents.agents.push({ agent_id: "implementation-003", role_id: "implementation", role_version: 1, mission: "Implement.", context_scope: "line-a", lifecycle_state: "active", provisioning_batch_id: "PB-A", provisioning_task_id: "T-C" });
  const migrated = assessOrganizationV2ForV3(ambiguous);
  assert.equal(migrated.status, "review_required");
  assert.ok(migrated.issues.some((issue) => issue.code === "LEGACY_COUNT_BASED_LEAD_REVIEW_REQUIRED"));

  const malformed = legacyFixture();
  malformed.organization.memberships[0].agent_id = "missing-agent";
  const malformedResult = assessOrganizationV2ForV3(malformed);
  assert.equal(malformedResult.status, "review_required");
  assert.ok(malformedResult.issues.some((issue) => issue.code === "MEMBERSHIP_AGENT_MISSING"));
});

test("normalization never hides duplicate formation members or incomplete agent identity", () => {
  const duplicateFormationMember = bundleFixture();
  duplicateFormationMember.formations.formations[0].member_agent_ids.push("implementation-001");
  assert.throws(() => createOrganizationV3Bundle(duplicateFormationMember), /CONTRACT_FORMATION_STATE_SORTED_UNIQUE/);

  const incompleteAgent = bundleFixture();
  incompleteAgent.agentRegistry.agents[0].mission = null;
  incompleteAgent.agentRegistry.agents[0].origin = null;
  incompleteAgent.agentRegistry.agents[0].created_from_ref = null;
  const result = validateOrganizationV3Bundle(incompleteAgent);
  assert.ok(result.issues.some((issue) => issue.code === "CONTRACT_AGENT_REGISTRY_V3_AGENT_REGISTRY_MISSION"));
  assert.ok(result.issues.some((issue) => issue.code === "CONTRACT_AGENT_REGISTRY_V3_AGENT_REGISTRY_ORIGIN"));
  assert.ok(result.issues.some((issue) => issue.code === "CONTRACT_AGENT_REGISTRY_V3_AGENT_REGISTRY_CREATED_FROM_REF"));

  const inactiveMissingAgent = bundleFixture();
  inactiveMissingAgent.organization.memberships.push({ membership_id: "historical-missing", agent_id: "missing-agent", team_id: "a-build", position: "member", ordinal: 99, active_from: timestamp, active_to: timestamp });
  assert.ok(validateOrganizationV3Bundle(inactiveMissingAgent).issues.some((issue) => issue.code === "MEMBERSHIP_AGENT_MISSING"));
});

test("current organization edges never point at retired agents", () => {
  const retiredMember = bundleFixture();
  const implementation = retiredMember.agentRegistry.agents.find(({ agent_id }) => agent_id === "implementation-001");
  implementation.lifecycle_state = "retired";
  implementation.retired_at = timestamp;
  const issues = validateOrganizationV3Bundle(retiredMember).issues;
  assert.ok(issues.some(({ code }) => code === "ACTIVE_MEMBERSHIP_AGENT_NOT_OPERATIONAL"));
  assert.ok(issues.some(({ code }) => code === "RELATIONSHIP_AGENT_NOT_OPERATIONAL"));
  assert.ok(issues.some(({ code }) => code === "ACTIVE_FORMATION_AGENT_NOT_READY"));

  const retiredOwner = bundleFixture();
  const orchestrator = retiredOwner.agentRegistry.agents.find(({ agent_id }) => agent_id === "orchestrator");
  orchestrator.lifecycle_state = "retired";
  orchestrator.retired_at = timestamp;
  assert.ok(validateOrganizationV3Bundle(retiredOwner).issues.some(({ code }) => code === "ACTIVE_LINE_OWNER_NOT_OPERATIONAL"));

  const provisioningPersistentMember = bundleFixture();
  provisioningPersistentMember.agentRegistry.agents.find(({ agent_id }) => agent_id === "implementation-001").lifecycle_state = "provisioning";
  assert.ok(validateOrganizationV3Bundle(provisioningPersistentMember).issues.some(({ code }) => code === "ACTIVE_FORMATION_AGENT_NOT_READY"));
});

test("ephemeral agents are bound to one matching formation and never gain persistent memberships", () => {
  const sourceId = "RUN-EPHEMERAL";
  const ephemeral = bundleFixture();
  ephemeral.agentRegistry.agents.push({
    agent_id: "workflow-worker", role_id: "implementation", role_version: 1,
    mission: "Run one workflow.", context_scope: ["project"], lifecycle_state: "provisioning",
    origin: "workflow", created_from_ref: { kind: "workflow_run", id: sourceId }, retired_at: null
  });
  ephemeral.formations.formations.push({
    formation_id: formationId("workflow", "workflow_run", sourceId),
    formation_kind: "work_cell", source_ref: { kind: "workflow_run", id: sourceId },
    scope_ref: { kind: "project", id: "orquesta" }, member_agent_ids: ["workflow-worker"],
    coordination_mode: "peer", lead_agent_id: null, target_refs: [], lifecycle_state: "active",
    created_at: timestamp, retired_at: null
  });
  assert.equal(validateOrganizationV3Bundle(ephemeral).ok, true);

  const orphan = clone(ephemeral);
  orphan.formations.formations = orphan.formations.formations.filter(({ source_ref }) => source_ref.id !== sourceId);
  assert.ok(validateOrganizationV3Bundle(orphan).issues.some(({ code }) => code === "EPHEMERAL_FORMATION_BINDING_INVALID"));

  const persistentLeak = clone(ephemeral);
  persistentLeak.organization.memberships.push({
    membership_id: "workflow-home", agent_id: "workflow-worker", team_id: "a-build",
    position: "member", ordinal: 9, active_from: timestamp, active_to: timestamp
  });
  assert.ok(validateOrganizationV3Bundle(persistentLeak).issues.some(({ code }) => code === "EPHEMERAL_PERSISTENT_MEMBERSHIP"));

  const reusedByAnotherSource = clone(ephemeral);
  reusedByAnotherSource.formations.formations.push({
    formation_id: formationId("workflow", "workflow_run", "RUN-OTHER"),
    formation_kind: "work_cell", source_ref: { kind: "workflow_run", id: "RUN-OTHER" },
    scope_ref: { kind: "project", id: "orquesta" }, member_agent_ids: ["workflow-worker"],
    coordination_mode: "peer", lead_agent_id: null, target_refs: [], lifecycle_state: "active",
    created_at: timestamp, retired_at: null
  });
  assert.ok(validateOrganizationV3Bundle(reusedByAnotherSource).issues.some(({ code }) => code === "FORMATION_EPHEMERAL_PROVENANCE_MISMATCH"));

  const retiredFormation = clone(ephemeral);
  const formation = retiredFormation.formations.formations.find(({ source_ref }) => source_ref.id === sourceId);
  formation.lifecycle_state = "retired";
  formation.retired_at = timestamp;
  assert.ok(validateOrganizationV3Bundle(retiredFormation).issues.some(({ code }) => code === "EPHEMERAL_FORMATION_LIFECYCLE_MISMATCH"));
});

test("legacy duplicate identities remain visible as migration review issues", () => {
  const source = legacyFixture();
  source.agents.agents.push(clone(source.agents.agents[0]));
  const result = assessOrganizationV2ForV3(source);
  assert.equal(result.status, "review_required");
  assert.ok(result.issues.some((issue) => issue.code === "LEGACY_DUPLICATE_ID_REVIEW_REQUIRED"));
});

test("the in-memory model keeps a small multi-line boundary valid", () => {
  const { agents, lines, bundle } = createOrganizationV3BoundaryFixture(8);
  assert.equal(agents.length, 16);
  assert.equal(lines.length, 8);
  assert.equal(validateOrganizationV3Bundle(bundle).ok, true);
});
