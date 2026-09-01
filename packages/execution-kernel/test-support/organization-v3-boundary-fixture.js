"use strict";

const timestamp = "2026-08-15T00:00:00.000Z";

function createOrganizationV3BoundaryFixture(lineCount) {
  const agents = [
    { agent_id: "orchestrator", role_id: "orchestrator", role_version: 1, mission: "Coordinate.", context_scope: ["project"], lifecycle_state: "active", origin: "foundation", created_from_ref: { kind: "project_bootstrap", id: "foundation" }, retired_at: null },
    { agent_id: "orquesta-admin", role_id: "orquesta-admin", role_version: 1, mission: "Maintain Orquesta.", context_scope: ["project"], lifecycle_state: "active", origin: "foundation", created_from_ref: { kind: "project_bootstrap", id: "foundation" }, retired_at: null },
    { agent_id: "user-support", role_id: "user-support", role_version: 1, mission: "Support the user.", context_scope: ["project"], lifecycle_state: "active", origin: "foundation", created_from_ref: { kind: "project_bootstrap", id: "foundation" }, retired_at: null }
  ];
  const lines = [];
  const teams = [];
  const memberships = [];
  for (let lineIndex = 0; lineIndex < lineCount; lineIndex += 1) {
    const suffix = String(lineIndex).padStart(4, "0");
    const lineId = `line-${suffix}`;
    const teamId = `team-${suffix}`;
    lines.push({
      line_id: lineId,
      display_name: `Line ${suffix}`,
      goal: `Deliver ${suffix}`,
      deliverable_ids: [`D-${suffix}`],
      completion_root_ids: [`CM-${suffix}`],
      scope: [`scope/${suffix}`],
      owner_ref: { kind: "participant", id: "owner" },
      status: "active",
      approval_source: "user_approval"
    });
    teams.push({
      team_id: teamId,
      line_id: lineId,
      display_name: `Team ${suffix}`,
      purpose: `Operate ${suffix}`,
      coordination_mode: "peer",
      lead_agent_id: null,
      lifecycle_state: "active"
    });
    const memberCount = lineIndex < lineCount - 3 ? 2 : 1;
    for (let memberIndex = 0; memberIndex < memberCount; memberIndex += 1) {
      const agentId = `agent-${suffix}-${memberIndex}`;
      agents.push({
        agent_id: agentId,
        role_id: "implementation",
        role_version: 1,
        mission: `Operate ${lineId}.`,
        context_scope: [lineId],
        lifecycle_state: "active",
        origin: "controller",
        created_from_ref: { kind: "task", id: `T-${suffix}-${memberIndex}` },
        retired_at: null
      });
      memberships.push({
        membership_id: `membership-${suffix}-${memberIndex}`,
        agent_id: agentId,
        team_id: teamId,
        position: "member",
        ordinal: memberIndex + 1,
        active_from: timestamp,
        active_to: null
      });
    }
  }
  return {
    agents,
    lines,
    bundle: {
      agentRegistry: { schema_version: 3, organization_revision: 1, agents },
      organization: {
        schema_version: 3,
        revision: 1,
        policy: { line_creation: "review", max_concurrent_provisioning: 3, require_executable_task_per_new_agent: true, require_no_file_ownership_conflict: true },
        participants: [
          { participant_id: "owner", display_name: "Owner", participant_kind: "human", lifecycle_state: "active", joined_at: timestamp },
          { participant_id: "user", display_name: "User", participant_kind: "human", lifecycle_state: "active", joined_at: timestamp }
        ],
        lines,
        teams,
        memberships,
        relationships: [{ relationship_id: "user-authority", type: "authority_over", subject_ref: { kind: "participant", id: "user" }, object_ref: { kind: "agent", id: "orchestrator" } }],
        applied_decision_ids: [],
        applied_decision_bindings: []
      },
      formations: { schema_version: 1, organization_revision: 1, formations: [] }
    }
  };
}

module.exports = { createOrganizationV3BoundaryFixture };
