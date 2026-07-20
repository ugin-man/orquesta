"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  agentCapabilityProviders,
  applyOrganizationDecision,
  assertOrganizationInvariants,
  canonicalRoleId,
  createOrganizationState,
} = require("../src/organization-model");

const timestamp = "2026-07-20T00:00:00.000Z";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function fixtureOrganization() {
  return createOrganizationState({
    revision: 1,
    agents: [
      { agent_id: "orchestrator", role_id: "orchestrator", organization_scope: "project", lifecycle_state: "active", operational_status: "working" },
      { agent_id: "implementation-001", role_id: "implementation", organization_scope: "line", lifecycle_state: "active", operational_status: "working" }
    ],
    teams: [{ team_id: "desktop-implementation", line_id: "desktop-line", display_name: "Desktop implementation", purpose: "Desktop work", lifecycle_state: "active" }],
    memberships: [{ membership_id: "membership-implementation", agent_id: "implementation-001", team_id: "desktop-implementation", position: "member", ordinal: 1, active_from: timestamp, active_to: null }],
    relationships: [{ relationship_id: "reports-implementation", type: "reports_to", from_agent_id: "implementation-001", to_agent_id: "orchestrator" }],
    lines: [{ line_id: "desktop-line", display_name: "Desktop", goal: "Desktop deliverable", deliverable_ids: ["desktop"], completion_root_ids: ["CM-DESKTOP"], scope: ["apps/orquesta-desktop"], owner_agent_id: "orchestrator", dedicated_lead_agent_id: null, status: "active", approval_source: "setup_confirmation" }]
  });
}

function decision(action, overrides = {}) {
  const line = action === "propose_line";
  return {
    decision_id: "OD-0123456789ab",
    task_intent_id: "TI-0123456789ab",
    organization_revision: 1,
    input_hash: "a".repeat(64),
    mode: "deep",
    selected_action: action,
    reason_codes: [line ? "NEW_LINE_CANDIDATE" : "CAPABILITY_GAP"],
    requires_user_approval: line,
    approval_state: line ? "approved" : "not_required",
    proposed_line: line ? { line_id: "core-line", display_name: "Core", goal: "Core deliverable", deliverable_ids: ["core"], completion_root_ids: ["CM-CORE"], scope: ["packages/core"], owner_agent_id: "orchestrator" } : null,
    created_at: timestamp,
    ...overrides
  };
}

test("organization invariants keep references, memberships, leads, and reporting truthful", () => {
  const state = fixtureOrganization();
  assert.doesNotThrow(() => assertOrganizationInvariants(state));

  const projectOwner = clone(state);
  projectOwner.lines.push({ ...projectOwner.lines[0], line_id: "core-line", display_name: "Core", deliverable_ids: ["core"], completion_root_ids: ["CM-CORE"], scope: ["packages/core"] });
  assert.doesNotThrow(() => assertOrganizationInvariants(projectOwner));

  const duplicateLead = clone(state);
  duplicateLead.memberships.push({ ...duplicateLead.memberships[0], membership_id: "membership-lead-one", position: "lead" });
  duplicateLead.memberships.push({ ...duplicateLead.memberships[0], membership_id: "membership-lead-two", position: "lead", ordinal: 2 });
  assert.throws(() => assertOrganizationInvariants(duplicateLead), /organization/);

  const twoLines = clone(state);
  twoLines.lines.push({ ...twoLines.lines[0], line_id: "core-line", display_name: "Core", deliverable_ids: ["core"], completion_root_ids: ["CM-CORE"], scope: ["packages/core"] });
  twoLines.teams.push({ ...twoLines.teams[0], team_id: "core-implementation", line_id: "core-line", display_name: "Core implementation" });
  twoLines.memberships.push({ ...twoLines.memberships[0], membership_id: "membership-cross-line", team_id: "core-implementation" });
  assert.throws(() => assertOrganizationInvariants(twoLines), /organization/);

  const cycle = clone(state);
  cycle.relationships.push({ relationship_id: "reports-orchestrator", type: "reports_to", from_agent_id: "orchestrator", to_agent_id: "implementation-001" });
  assert.throws(() => assertOrganizationInvariants(cycle), /organization/);

  assert.throws(() => assertOrganizationInvariants({ ...state, temporary_assignment: {} }), /organization/);
});

test("canonical roles, capability providers, and decision application stay deterministic", () => {
  const roles = [{ role_id: "implementation", aliases: ["coder", "developer"] }];
  assert.equal(canonicalRoleId({ requestedRole: "DEVELOPER", roles }), "implementation");
  assert.equal(canonicalRoleId({ requestedRole: "release", roles }), null);

  const state = fixtureOrganization();
  const providers = agentCapabilityProviders({
    organization: state,
    profiles: [{ agent_id: "implementation-001", availability: "available", organization_revision: 1, capabilities: [{ capability_id: "code.change", status: "verified", evidence_refs: ["evidence:code"], scope: ["packages/core"] }] }]
  });
  assert.deepEqual(providers, [{ agent_id: "implementation-001", capability_ids: ["code.change"], evidence_refs: ["evidence:code"], organization_scope: "line", availability: "available" }]);

  const addMember = decision("add_member");
  const first = applyOrganizationDecision({
    state,
    decision: addMember,
    changes: {
      agents: [{ agent_id: "implementation-002", role_id: "implementation", organization_scope: "line", lifecycle_state: "provisioning", operational_status: "standby" }],
      memberships: [{ membership_id: "membership-implementation-002", agent_id: "implementation-002", team_id: "desktop-implementation", position: "member", ordinal: 2, active_from: timestamp, active_to: null }]
    }
  });
  assert.equal(first.state.revision, 2);
  assert.equal(first.state.agents.some((agent) => agent.agent_id === "implementation-002"), true);
  assert.equal(applyOrganizationDecision({ state: first.state, decision: addMember, changes: {} }).idempotent, true);

  assert.throws(() => applyOrganizationDecision({ state, decision: decision("propose_line", { approval_state: "pending_user" }), changes: {} }), /approved/);
});

test("permanent transfer closes the old membership and adds the new membership atomically", () => {
  const state = fixtureOrganization();
  const transfer = decision("permanent_transfer");
  const oldMembership = state.memberships[0];
  const result = applyOrganizationDecision({
    state,
    decision: transfer,
    changes: {
      teams: [{ team_id: "core-implementation", line_id: "core-line", display_name: "Core implementation", purpose: "Core work", lifecycle_state: "active" }],
      lines: [{ line_id: "core-line", display_name: "Core", goal: "Core deliverable", deliverable_ids: ["core"], completion_root_ids: ["CM-CORE"], scope: ["packages/core"], owner_agent_id: "orchestrator", dedicated_lead_agent_id: null, status: "active", approval_source: "user_approval" }],
      replace_memberships: [{ ...oldMembership, active_to: timestamp }],
      memberships: [{ membership_id: "membership-implementation-core", agent_id: oldMembership.agent_id, team_id: "core-implementation", position: "member", ordinal: 1, active_from: timestamp, active_to: null }]
    }
  });

  assert.equal(result.state.memberships.find((item) => item.membership_id === oldMembership.membership_id).active_to, timestamp);
  assert.equal(result.state.memberships.find((item) => item.membership_id === "membership-implementation-core").active_to, null);
});
