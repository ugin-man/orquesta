"use strict";

const crypto = require("node:crypto");

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

module.exports = {
  FOUNDATION,
  createSetupStateBundle,
  prepareProvisioningBatch,
};

