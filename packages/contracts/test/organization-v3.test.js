"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { SCHEMA_NAMES, loadSchema, validateContract } = require("../src");

const timestamp = "2026-08-15T00:00:00.000Z";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function agentRegistry() {
  return {
    schema_version: 3,
    organization_revision: 7,
    agents: [
      {
        agent_id: "implementation-001",
        role_id: "implementation",
        role_version: 1,
        mission: "Implement bounded product changes.",
        context_scope: ["packages/local-core"],
        lifecycle_state: "active",
        origin: "controller",
        created_from_ref: { kind: "task", id: "T-IMPLEMENT" },
        retired_at: null
      },
      {
        agent_id: "orchestrator",
        role_id: "orchestrator",
        role_version: 1,
        mission: "Coordinate the project.",
        context_scope: ["project"],
        lifecycle_state: "active",
        origin: "foundation",
        created_from_ref: { kind: "project_bootstrap", id: "foundation" },
        retired_at: null
      }
    ]
  };
}

function organization() {
  return {
    schema_version: 3,
    revision: 7,
    policy: {
      line_creation: "review",
      max_concurrent_provisioning: 3,
      require_executable_task_per_new_agent: true,
      require_no_file_ownership_conflict: true
    },
    participants: [
      {
        participant_id: "user",
        display_name: "User",
        participant_kind: "human",
        lifecycle_state: "active",
        joined_at: timestamp
      }
    ],
    lines: [
      {
        line_id: "desktop-line",
        display_name: "Desktop",
        goal: "Deliver Desktop",
        deliverable_ids: ["desktop"],
        completion_root_ids: ["CM-DESKTOP"],
        scope: ["apps/orquesta-desktop-next"],
        owner_ref: { kind: "participant", id: "user" },
        status: "active",
        approval_source: "user_approval"
      }
    ],
    teams: [
      {
        team_id: "desktop-implementation",
        line_id: "desktop-line",
        display_name: "Desktop implementation",
        purpose: "Implement Desktop",
        coordination_mode: "peer",
        lead_agent_id: null,
        lifecycle_state: "active"
      }
    ],
    memberships: [
      {
        membership_id: "membership-implementation",
        agent_id: "implementation-001",
        team_id: "desktop-implementation",
        position: "member",
        ordinal: 1,
        active_from: timestamp,
        active_to: null
      }
    ],
    relationships: [
      {
        relationship_id: "owner-authority",
        type: "authority_over",
        subject_ref: { kind: "participant", id: "user" },
        object_ref: { kind: "agent", id: "orchestrator" }
      },
      {
        relationship_id: "implementation-reports",
        type: "reports_to",
        subject_ref: { kind: "agent", id: "implementation-001" },
        object_ref: { kind: "agent", id: "orchestrator" }
      }
    ],
    applied_decision_ids: [],
    applied_decision_bindings: []
  };
}

function formationState() {
  return {
    schema_version: 1,
    organization_revision: 7,
    formations: [
      {
        formation_id: "formation-review",
        formation_kind: "inspection",
        source_ref: { kind: "task", id: "T-REVIEW" },
        scope_ref: { kind: "line", id: "desktop-line" },
        member_agent_ids: ["implementation-001"],
        coordination_mode: "peer",
        lead_agent_id: null,
        target_refs: [{ kind: "line", id: "desktop-line" }],
        lifecycle_state: "active",
        created_at: timestamp,
        retired_at: null
      }
    ]
  };
}

function placementIntent() {
  return {
    placement_intent_id: "PI-0123456789ab",
    purpose: "Review the Desktop architecture.",
    capability_needs: ["architecture.review", "desktop.ux"],
    scope_ref: { kind: "line", id: "desktop-line" },
    lifetime: "one_shot",
    requested_count: 1,
    coordination_hint: null,
    source_ref: { kind: "task", id: "T-REVIEW" }
  };
}

function persistentAgentPlacementTemplate() {
  const { placement_intent_id, source_ref, lifetime, ...template } = placementIntent();
  return { ...template, role_ref: { id: "implementation", version: 1 } };
}

test("Organization v3 contracts are registered and accept their bounded positive fixtures", () => {
  for (const name of ["agent-registry-v3", "formation-state", "organization-state-v3", "organization-agent-placement-persistent-v1", "placement-intent"]) {
    assert.equal(SCHEMA_NAMES.includes(name), true, `${name} must be registered`);
  }
  assert.equal(validateContract("agent-registry-v3", agentRegistry()).ok, true);
  assert.equal(validateContract("organization-state-v3", organization()).ok, true);
  assert.equal(validateContract("formation-state", formationState()).ok, true);
  assert.equal(validateContract("organization-agent-placement-persistent-v1", persistentAgentPlacementTemplate()).ok, true);
  assert.equal(validateContract("placement-intent", placementIntent()).ok, true);
});

test("Organization v3 exported values stay in parity with their canonical schemas", () => {
  const agentSchema = loadSchema("agent-registry-v3");
  const organizationSchema = loadSchema("organization-state-v3");
  assert.deepEqual(
    agentSchema.properties.agents.items.properties.created_from_ref.anyOf[0].properties.kind.enum,
    ["task", "workflow_run", "project_bootstrap", "migration", "user", "organization_decision", "inspection"]
  );
  assert.deepEqual(
    organizationSchema.properties.lines.items.properties.approval_source.enum,
    ["user_approval", "organization_decision", "migrated_legacy"]
  );
  assert.deepEqual(
    organizationSchema.properties.teams.items.properties.coordination_mode.enum,
    ["peer", "supervised", "workflow_managed"]
  );
});

test("Organization v3 contracts reject duplicate identity and invalid coordination semantics", () => {
  const duplicateAgents = agentRegistry();
  duplicateAgents.agents.push(clone(duplicateAgents.agents[0]));
  assert.ok(validateContract("agent-registry-v3", duplicateAgents).errors.some((error) => error.code === "agent_registry_unique_id"));

  const peerWithLead = organization();
  peerWithLead.teams[0].lead_agent_id = "implementation-001";
  peerWithLead.memberships[0].position = "lead";
  assert.ok(validateContract("organization-state-v3", peerWithLead).errors.some((error) => error.code === "organization_v3_peer_lead"));

  const supervisedWithoutLead = organization();
  supervisedWithoutLead.teams[0].coordination_mode = "supervised";
  assert.ok(validateContract("organization-state-v3", supervisedWithoutLead).errors.some((error) => error.code === "organization_v3_supervised_lead"));

  const invalidFormation = formationState();
  invalidFormation.formations[0].coordination_mode = "supervised";
  assert.ok(validateContract("formation-state", invalidFormation).errors.some((error) => error.code === "formation_supervised_lead"));

  const legacySetupProvenance = agentRegistry();
  legacySetupProvenance.agents[1].created_from_ref = { kind: "setup", id: "legacy-setup" };
  assert.equal(validateContract("agent-registry-v3", legacySetupProvenance).ok, false);

  const legacySetupApproval = organization();
  legacySetupApproval.lines[0].approval_source = "setup_confirmation";
  assert.equal(validateContract("organization-state-v3", legacySetupApproval).ok, false);

  const wrongProvenance = agentRegistry();
  wrongProvenance.agents[0].origin = "workflow";
  wrongProvenance.agents[0].created_from_ref = { kind: "task", id: "T-WRONG" };
  assert.ok(validateContract("agent-registry-v3", wrongProvenance).errors.some((error) => error.code === "agent_registry_provenance_compatibility"));

  const duplicateMemberships = organization();
  duplicateMemberships.memberships.push({ ...clone(duplicateMemberships.memberships[0]), membership_id: "membership-duplicate", ordinal: 2 });
  duplicateMemberships.memberships.push({ ...clone(duplicateMemberships.memberships[0]), membership_id: "membership-ordinal", agent_id: "implementation-002" });
  const membershipErrors = validateContract("organization-state-v3", duplicateMemberships).errors;
  assert.ok(membershipErrors.some((error) => error.code === "organization_v3_active_agent_team_unique"));
  assert.ok(membershipErrors.some((error) => error.code === "organization_v3_active_team_ordinal_unique"));

  const hiddenCycle = organization();
  hiddenCycle.relationships.push({ relationship_id: "orchestrator-reports", type: "reports_to", subject_ref: { kind: "agent", id: "orchestrator" }, object_ref: { kind: "agent", id: "implementation-001" } });
  hiddenCycle.relationships.push({ relationship_id: "implementation-reports-second", type: "reports_to", subject_ref: { kind: "agent", id: "implementation-001" }, object_ref: { kind: "agent", id: "implementation-002" } });
  const relationshipErrors = validateContract("organization-state-v3", hiddenCycle).errors;
  assert.ok(relationshipErrors.some((error) => error.code === "organization_v3_reports_to_unique"));
  assert.ok(relationshipErrors.some((error) => error.code === "organization_v3_reports_to_cycle"));
});

test("Organization v3 current-state edges reject retired or inactive structure", () => {
  const retiredTeam = organization();
  retiredTeam.teams[0].lifecycle_state = "retired";
  assert.ok(validateContract("organization-state-v3", retiredTeam).errors.some((error) => error.code === "organization_v3_active_membership_team_state"));

  const retiredLine = organization();
  retiredLine.lines[0].status = "retired";
  assert.ok(validateContract("organization-state-v3", retiredLine).errors.some((error) => error.code === "organization_v3_active_team_line_state"));

  const inactiveOwner = organization();
  inactiveOwner.participants[0].lifecycle_state = "inactive";
  const ownerErrors = validateContract("organization-state-v3", inactiveOwner).errors;
  assert.ok(ownerErrors.some((error) => error.code === "organization_v3_active_line_owner_state"));
  assert.ok(ownerErrors.some((error) => error.code === "organization_v3_relationship_endpoint_state"));

  const retiredRelationshipTeam = organization();
  retiredRelationshipTeam.relationships.push({
    relationship_id: "support-retired-team", type: "supports",
    subject_ref: { kind: "participant", id: "user" }, object_ref: { kind: "team", id: "desktop-implementation" }
  });
  retiredRelationshipTeam.teams[0].lifecycle_state = "retired";
  assert.ok(validateContract("organization-state-v3", retiredRelationshipTeam).errors.some((error) => error.code === "organization_v3_relationship_endpoint_state"));
});

test("Formation state has one semantic source and kind-specific targets", () => {
  const duplicateSource = formationState();
  duplicateSource.formations.push({ ...clone(duplicateSource.formations[0]), formation_id: "formation-review-duplicate" });
  assert.ok(validateContract("formation-state", duplicateSource).errors.some((error) => error.code === "formation_source_unique"));

  const wrongSource = formationState();
  wrongSource.formations[0].source_ref = { kind: "workflow_run", id: "RUN-WRONG" };
  assert.ok(validateContract("formation-state", wrongSource).errors.some((error) => error.code === "formation_source_kind"));

  const noInspectionTarget = formationState();
  noInspectionTarget.formations[0].target_refs = [];
  assert.ok(validateContract("formation-state", noInspectionTarget).errors.some((error) => error.code === "formation_inspection_targets"));
});

test("Placement Intent stays a light intent contract rather than a placement checklist", () => {
  assert.equal(validateContract("organization-agent-placement-persistent-v1", placementIntent()).ok, false, "AI template must reject trusted identity and lifetime fields");
  const invalid = placementIntent();
  invalid.requested_count = 0;
  assert.equal(validateContract("placement-intent", invalid).ok, false);

  const duplicateNeeds = placementIntent();
  duplicateNeeds.capability_needs = ["desktop.ux", "desktop.ux"];
  assert.ok(validateContract("placement-intent", duplicateNeeds).errors.some((error) => error.code === "sorted_unique"));

  const blankTemplate = persistentAgentPlacementTemplate();
  blankTemplate.purpose = "   ";
  blankTemplate.scope_ref.id = "\t";
  assert.equal(validateContract("organization-agent-placement-persistent-v1", blankTemplate).ok, false);

  const oversizedTemplate = persistentAgentPlacementTemplate();
  oversizedTemplate.purpose = "x".repeat(8193);
  oversizedTemplate.requested_count = 1025;
  oversizedTemplate.capability_needs = Array.from({ length: 65 }, (_, index) => `capability.${index}`);
  const oversizedErrors = validateContract("organization-agent-placement-persistent-v1", oversizedTemplate).errors;
  assert.ok(oversizedErrors.some((error) => error.path === "$.purpose" && error.code === "maxLength"));
  assert.ok(oversizedErrors.some((error) => error.path === "$.requested_count" && error.code === "maximum"));
  assert.ok(oversizedErrors.some((error) => error.path === "$.capability_needs" && error.code === "maxItems"));

  const duplicateTemplateNeeds = persistentAgentPlacementTemplate();
  duplicateTemplateNeeds.capability_needs = ["desktop.ux", "desktop.ux"];
  assert.ok(validateContract("organization-agent-placement-persistent-v1", duplicateTemplateNeeds).errors
    .some((error) => error.path === "$.capability_needs" && error.code === "uniqueItems"));
});

test("Organization v3 decision ids and canonical content bindings are exact, sorted, and total", () => {
  const missing = organization();
  missing.applied_decision_ids = ["OD-111111111111"];
  assert.ok(validateContract("organization-state-v3", missing).errors.some((error) => error.code === "organization_v3_decision_binding_missing"));

  const extra = organization();
  extra.applied_decision_bindings = [{ decision_id: "OD-111111111111", content_hash: "1".repeat(64) }];
  assert.ok(validateContract("organization-state-v3", extra).errors.some((error) => error.code === "organization_v3_decision_binding_reference"));

  const malformedHash = organization();
  malformedHash.applied_decision_ids = ["OD-111111111111"];
  malformedHash.applied_decision_bindings = [{ decision_id: "OD-111111111111", content_hash: "not-a-hash" }];
  assert.ok(validateContract("organization-state-v3", malformedHash).errors.some((error) => error.path.endsWith(".content_hash") && error.code === "pattern"));

  const outOfOrder = organization();
  outOfOrder.applied_decision_ids = ["OD-111111111111", "OD-222222222222"];
  outOfOrder.applied_decision_bindings = [
    { decision_id: "OD-222222222222", content_hash: "2".repeat(64) },
    { decision_id: "OD-111111111111", content_hash: "1".repeat(64) }
  ];
  assert.ok(validateContract("organization-state-v3", outOfOrder).errors.some((error) => error.path === "$.applied_decision_bindings" && error.code === "sorted_unique"));

  const duplicate = organization();
  duplicate.applied_decision_ids = ["OD-111111111111"];
  duplicate.applied_decision_bindings = [
    { decision_id: "OD-111111111111", content_hash: "1".repeat(64) },
    { decision_id: "OD-111111111111", content_hash: "1".repeat(64) }
  ];
  assert.ok(validateContract("organization-state-v3", duplicate).errors.some((error) => error.code === "organization_unique_id"));
});

test("Organization v3 set-like nested arrays and required safety policy stay canonical", () => {
  for (const field of ["deliverable_ids", "completion_root_ids", "scope"]) {
    const outOfOrder = organization();
    outOfOrder.lines[0][field] = ["z", "a"];
    assert.ok(validateContract("organization-state-v3", outOfOrder).errors.some((error) => error.path.endsWith(`.${field}`) && error.code === "sorted_unique"));

    const duplicate = organization();
    duplicate.lines[0][field] = ["same", "same"];
    assert.ok(validateContract("organization-state-v3", duplicate).errors.some((error) => error.path.endsWith(`.${field}`) && error.code === "sorted_unique"));
  }

  const targetsOutOfOrder = formationState();
  targetsOutOfOrder.formations[0].target_refs = [{ kind: "line", id: "z" }, { kind: "agent", id: "a" }];
  assert.ok(validateContract("formation-state", targetsOutOfOrder).errors.some((error) => error.path.endsWith(".target_refs") && error.code === "sorted_unique"));

  const targetsDuplicate = formationState();
  targetsDuplicate.formations[0].target_refs = [clone(targetsDuplicate.formations[0].target_refs[0]), clone(targetsDuplicate.formations[0].target_refs[0])];
  assert.ok(validateContract("formation-state", targetsDuplicate).errors.some((error) => error.path.endsWith(".target_refs") && error.code === "sorted_unique"));

  for (const field of ["require_executable_task_per_new_agent", "require_no_file_ownership_conflict"]) {
    const disabled = organization();
    disabled.policy[field] = false;
    assert.equal(validateContract("organization-state-v3", disabled).ok, false, `${field} is an invariant delegated to placement evidence`);
  }
});

test("Organization v3 rejects reversed membership and formation chronology", () => {
  const reversedMembership = organization();
  reversedMembership.memberships[0].active_to = "2026-08-14T00:00:00.000Z";
  assert.ok(validateContract("organization-state-v3", reversedMembership).errors.some((error) => error.code === "organization_v3_membership_chronology"));

  const reversedFormation = formationState();
  reversedFormation.formations[0].lifecycle_state = "retired";
  reversedFormation.formations[0].retired_at = "2026-08-14T00:00:00.000Z";
  assert.ok(validateContract("formation-state", reversedFormation).errors.some((error) => error.code === "formation_retirement_chronology"));
});
