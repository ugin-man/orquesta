"use strict";

const crypto = require("node:crypto");
const { assertContract } = require("@orquesta/contracts");
const { normalizeOrganizationLeadership } = require("../../packages/core/src/organization-model");

const FOUNDATION = Object.freeze([
  Object.freeze({ agent_id: "orchestrator", role_id: "orchestrator", organization_scope: "project", lifecycle_state: "active", operational_status: "working" }),
  Object.freeze({ agent_id: "orquesta-admin", role_id: "orquesta-admin", organization_scope: "project", lifecycle_state: "active", operational_status: "working" }),
  Object.freeze({ agent_id: "user-support", role_id: "user-support", organization_scope: "project", lifecycle_state: "active", operational_status: "standby" }),
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function hash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function createSetupStateBundle({ projectId, projectUnderstanding, specialistPlan, now } = {}) {
  if (!projectId || !projectUnderstanding || !specialistPlan || !now) {
    throw new TypeError("projectId, projectUnderstanding, specialistPlan, and now are required");
  }
  return {
    schema_version: 1,
    project_id: projectId,
    project_understanding: clone(projectUnderstanding),
    foundationAgents: FOUNDATION.map(clone),
    specialist_plan: clone(specialistPlan),
    setup_confirmation: { status: "approved", approved_at: now },
    phases: [
      "environment",
      "understanding",
      "foundation",
      "planning",
      "specialists",
      "operation",
    ],
    created_at: now,
  };
}

function nextAgentId(roleId, reservedIds) {
  let ordinal = 1;
  while (reservedIds.has(`${roleId}-${String(ordinal).padStart(3, "0")}`)) ordinal += 1;
  const agentId = `${roleId}-${String(ordinal).padStart(3, "0")}`;
  reservedIds.add(agentId);
  return agentId;
}

function availableExisting(existingAgents, roleId, lineId, usedIds) {
  return existingAgents.find((agent) => (
    agent.role_id === roleId
    && agent.line_id === lineId
    && agent.lifecycle_state === "active"
    && agent.operational_status === "standby"
    && !usedIds.has(agent.agent_id)
  ));
}

function prepareProvisioningBatch({ specialistPlan, organizationRevision, existingAgents = [], now } = {}) {
  if (!specialistPlan || specialistPlan.schema_version !== 2 || !Number.isInteger(organizationRevision) || !now) {
    throw new TypeError("specialistPlan v2, organizationRevision, and now are required");
  }
  if (!Array.isArray(existingAgents)) throw new TypeError("existingAgents must be an array");
  const reservedIds = new Set(existingAgents.map((agent) => agent.agent_id));
  const usedIds = new Set();
  const requests = [];

  for (const specialist of specialistPlan.selected_specialists || []) {
    if (specialist.line_approval_state === "pending_user" || specialist.line_approval_state === "rejected") {
      throw new Error(`new line requires user approval: ${specialist.line_id}`);
    }
    if (!Number.isInteger(specialist.quantity) || specialist.quantity < 1) {
      throw new TypeError(`specialist quantity must be positive: ${specialist.role_id}`);
    }
    if (!Array.isArray(specialist.task_ids) || specialist.task_ids.length < specialist.quantity) {
      throw new Error(`every new specialist requires an executable task: ${specialist.role_id}`);
    }
    for (let index = 0; index < specialist.quantity; index += 1) {
      const existing = availableExisting(existingAgents, specialist.role_id, specialist.line_id, usedIds);
      const agentId = existing ? existing.agent_id : nextAgentId(specialist.role_id, reservedIds);
      usedIds.add(agentId);
      requests.push({
        agent_id: agentId,
        role_id: specialist.role_id,
        team_id: specialist.team_id,
        line_id: specialist.line_id,
        task_id: specialist.task_ids[index],
        status: existing ? "reuse_ready" : "pending",
        created_at: now,
      });
    }
  }
  const identity = {
    organization_revision: organizationRevision,
    requests: requests.map(({ created_at, ...request }) => request),
  };
  return {
    provisioning_batch_id: `PB-${hash(identity).slice(0, 12)}`,
    organization_revision: organizationRevision,
    max_concurrent_provisioning: 3,
    requests,
    created_at: now,
  };
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function roleDefinition(roleId) {
  const knownNames = {
    implementation: { ja: "実装係", en: "Implementation" },
    design: { ja: "設計係", en: "Design" },
    research: { ja: "調査係", en: "Research" },
    testing: { ja: "検証係", en: "Testing" },
    writing: { ja: "文書係", en: "Writing" },
    generalist: { ja: "専門係", en: "Generalist" },
  };
  return {
    role_id: roleId,
    version: 1,
    display_names: knownNames[roleId] || { ja: roleId, en: roleId },
    aliases: [],
    capability_ids: [`role:${roleId}`],
    default_contract_template: `${roleId}-v1`,
    lifecycle_state: "active",
  };
}

function upsert(values, field, additions) {
  const byId = new Map((values || []).map((value) => [value[field], clone(value)]));
  for (const addition of additions || []) {
    byId.set(addition[field], { ...(byId.get(addition[field]) || {}), ...clone(addition) });
  }
  return [...byId.values()].sort((left, right) => compareText(left[field], right[field]));
}

function createInitialRosterTransition({
  bundle,
  specialistPlan,
  provisioningBatch,
  projectUnderstanding,
  now,
} = {}) {
  if (!bundle?.organizationState || !bundle?.rolesState || !bundle?.agentsState
    || specialistPlan?.schema_version !== 2 || !provisioningBatch || !projectUnderstanding || !now) {
    throw new TypeError("bundle, specialistPlan v2, provisioningBatch, projectUnderstanding, and now are required");
  }
  const currentRevision = bundle.organizationState.revision;
  if (provisioningBatch.organization_revision !== currentRevision) {
    throw new Error("provisioning batch organization revision mismatch");
  }
  const selectedByRoleTeamLine = new Map((specialistPlan.selected_specialists || []).map((specialist) => [
    `${specialist.role_id}\u0000${specialist.team_id}\u0000${specialist.line_id}`,
    specialist,
  ]));
  const roleIds = [...new Set((specialistPlan.selected_specialists || []).map((specialist) => specialist.role_id))];
  const rolesState = {
    ...clone(bundle.rolesState),
    organization_revision: currentRevision + 1,
    roles: upsert(bundle.rolesState.roles, "role_id", roleIds.map(roleDefinition)),
    updated_at: now,
  };
  const existingAgents = new Map((bundle.agentsState.agents || []).map((agent) => [agent.agent_id, agent]));
  const agentRecords = provisioningBatch.requests.map((request) => ({
    ...(existingAgents.has(request.agent_id) ? clone(existingAgents.get(request.agent_id)) : {}),
    agent_id: request.agent_id,
    role: request.role_id,
    role_id: request.role_id,
    role_version: 1,
    team_id: request.team_id,
    line_id: request.line_id,
    organization_scope: "line",
    lifecycle_state: existingAgents.get(request.agent_id)?.lifecycle_state === "active" ? "active" : "provisioning",
    operational_status: existingAgents.get(request.agent_id)?.operational_status || "standby",
    status: request.status === "reuse_ready" ? "standby" : "provisioning",
    provisioning_batch_id: provisioningBatch.provisioning_batch_id,
    provisioning_task_id: request.task_id,
    updated_at: now,
  }));
  const agentsState = {
    ...clone(bundle.agentsState),
    organization_revision: currentRevision + 1,
    agents: upsert(bundle.agentsState.agents, "agent_id", agentRecords),
    updated_at: now,
  };
  const organizationAgents = agentRecords.map((agent) => ({
    agent_id: agent.agent_id,
    role_id: agent.role_id,
    organization_scope: agent.organization_scope,
    lifecycle_state: agent.lifecycle_state,
    operational_status: agent.operational_status,
  }));
  const teams = [...new Map((specialistPlan.selected_specialists || []).map((specialist) => [specialist.team_id, {
    team_id: specialist.team_id,
    line_id: specialist.line_id,
    display_name: specialist.team_id,
    purpose: `${specialist.role_id} work for ${specialist.line_id}`,
    lifecycle_state: "active",
  }])).values()];
  const deliverableIds = (projectUnderstanding.deliverables || [])
    .map((deliverable) => deliverable.deliverable_id)
    .filter(Boolean);
  const lines = [...new Set((specialistPlan.selected_specialists || []).map((specialist) => specialist.line_id))]
    .map((lineId) => {
      if (!lineId) throw new Error("initial production specialist requires an approved line");
      const specialists = (specialistPlan.selected_specialists || []).filter((specialist) => specialist.line_id === lineId);
      return {
        line_id: lineId,
        display_name: lineId,
        goal: projectUnderstanding.goal,
        deliverable_ids: deliverableIds.length ? deliverableIds : [lineId],
        completion_root_ids: [...new Set(specialists.flatMap((specialist) => specialist.task_ids))].sort(compareText),
        scope: ["."],
        owner_agent_id: "orchestrator",
        dedicated_lead_agent_id: null,
        status: "active",
        approval_source: specialistPlan.approval_source,
      };
    });
  const memberships = provisioningBatch.requests.map((request, index) => ({
    membership_id: `membership-${request.team_id}-${request.agent_id}`,
    agent_id: request.agent_id,
    team_id: request.team_id,
    position: "member",
    ordinal: index + 1,
    active_from: now,
    active_to: null,
  }));
  const relationships = provisioningBatch.requests.map((request) => ({
    relationship_id: `relationship-${request.agent_id}-orchestrator`,
    type: "reports_to",
    from_agent_id: request.agent_id,
    to_agent_id: "orchestrator",
  }));
  const organizationState = normalizeOrganizationLeadership({
    ...clone(bundle.organizationState),
    revision: currentRevision + 1,
    agents: upsert(bundle.organizationState.agents, "agent_id", organizationAgents),
    teams: upsert(bundle.organizationState.teams, "team_id", teams),
    memberships: upsert(bundle.organizationState.memberships, "membership_id", memberships),
    relationships: upsert(bundle.organizationState.relationships, "relationship_id", relationships),
    lines: upsert(bundle.organizationState.lines, "line_id", lines),
  });
  assertContract("organization-state", organizationState);
  for (const specialist of specialistPlan.selected_specialists || []) {
    if (!selectedByRoleTeamLine.has(`${specialist.role_id}\u0000${specialist.team_id}\u0000${specialist.line_id}`)) {
      throw new Error("specialist plan identity changed during roster transition");
    }
  }
  return {
    rolesState,
    agentsState,
    organizationState,
    sessionsState: clone(bundle.sessionsState || { version: 1, sessions: [] }),
    tasksState: clone(bundle.tasksState || { version: 1, tasks: [] }),
  };
}

module.exports = {
  FOUNDATION,
  createInitialRosterTransition,
  createSetupStateBundle,
  prepareProvisioningBatch,
};
