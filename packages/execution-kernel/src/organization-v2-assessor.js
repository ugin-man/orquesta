"use strict";

const { canonicalHash } = require("@orquesta/contracts");
const { validateOrganizationV3Bundle } = require("./organization-v3");

const FOUNDATION_AGENT_ID_SET = new Set(["orchestrator", "orquesta-admin", "user-support"]);
const LIFECYCLE_STATES = new Set(["proposed", "provisioning", "active", "retired", "superseded"]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function recordIssue(issues, code, path, message) {
  issues.push({ code, path, message, severity: "error" });
}

function sortedRecords(values, field) {
  return clone(values || []).sort((left, right) => compareText(String(left?.[field] || ""), String(right?.[field] || "")));
}

function sortedUniqueStrings(values) {
  return [...new Set((values || []).filter((value) => typeof value === "string" && value.length > 0))].sort(compareText);
}

function sortedStrings(values) {
  return clone(values || []).sort((left, right) => compareText(String(left), String(right)));
}

function normalizeBundle(input) {
  const bundle = clone(input);
  bundle.agentRegistry.agents = sortedRecords(bundle.agentRegistry.agents, "agent_id");
  bundle.organization.participants = sortedRecords(bundle.organization.participants, "participant_id");
  bundle.organization.lines = sortedRecords(bundle.organization.lines, "line_id");
  bundle.organization.teams = sortedRecords(bundle.organization.teams, "team_id");
  bundle.organization.memberships = sortedRecords(bundle.organization.memberships, "membership_id");
  bundle.organization.relationships = sortedRecords(bundle.organization.relationships, "relationship_id");
  bundle.organization.applied_decision_ids = sortedStrings(bundle.organization.applied_decision_ids);
  bundle.organization.applied_decision_bindings = sortedRecords(bundle.organization.applied_decision_bindings, "decision_id");
  bundle.formations.formations = sortedRecords(bundle.formations.formations, "formation_id");
  return bundle;
}

function sortAndDedupeIssues(issues) {
  const byKey = new Map();
  for (const issue of issues) {
    const key = `${issue.code}\u0000${issue.path}\u0000${issue.message}`;
    if (!byKey.has(key)) byKey.set(key, issue);
  }
  return [...byKey.values()].sort((left, right) => (
    compareText(left.code, right.code)
    || compareText(left.path, right.path)
    || compareText(left.message, right.message)
  ));
}

function normalizedContextScope(value) {
  if (Array.isArray(value)) return sortedUniqueStrings(value);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function migrationAgentRecord({ agentId, legacyAgent, organizationAgent, issues }) {
  const roleId = legacyAgent?.role_id || legacyAgent?.role || organizationAgent?.role_id || "unknown";
  const roleVersion = Number.isInteger(legacyAgent?.role_version) && legacyAgent.role_version >= 1 ? legacyAgent.role_version : 1;
  const mission = typeof legacyAgent?.mission === "string" && legacyAgent.mission.trim() ? legacyAgent.mission.trim() : null;
  const contextScope = normalizedContextScope(legacyAgent?.context_scope);
  const lifecycleState = LIFECYCLE_STATES.has(legacyAgent?.lifecycle_state)
    ? legacyAgent.lifecycle_state
    : LIFECYCLE_STATES.has(organizationAgent?.lifecycle_state)
      ? organizationAgent.lifecycle_state
      : "proposed";
  let origin = null;
  let createdFromRef = null;
  if (FOUNDATION_AGENT_ID_SET.has(agentId)) {
    origin = "foundation";
  } else if (legacyAgent?.provisioning_batch_id) {
    origin = "controller";
  }
  if (legacyAgent || organizationAgent) {
    createdFromRef = {
      kind: "migration",
      id: legacyAgent?.provisioning_task_id || legacyAgent?.provisioning_batch_id || "organization-v2"
    };
  }
  if (mission === null) recordIssue(issues, "AGENT_MISSION_MISSING", `$.agents.agents.${agentId}.mission`, "legacy agent mission requires review");
  if (contextScope.length === 0) recordIssue(issues, "AGENT_CONTEXT_SCOPE_MISSING", `$.agents.agents.${agentId}.context_scope`, "legacy agent context scope requires review");
  if (origin === null) recordIssue(issues, "AGENT_ORIGIN_UNKNOWN", `$.agents.agents.${agentId}.origin`, "legacy agent origin requires review");
  if (roleId === "unknown") recordIssue(issues, "AGENT_ROLE_MISSING", `$.agents.agents.${agentId}.role_id`, "legacy agent role requires review");
  return {
    agent_id: agentId,
    role_id: roleId,
    role_version: roleVersion,
    mission,
    context_scope: contextScope,
    lifecycle_state: lifecycleState,
    origin,
    created_from_ref: createdFromRef,
    retired_at: legacyAgent?.retired_at || null
  };
}

function recordLegacyDuplicateIds(issues, values, field, path) {
  const seen = new Set();
  for (const value of values || []) {
    const id = value?.[field];
    if (typeof id !== "string" || seen.has(id)) {
      recordIssue(issues, "LEGACY_DUPLICATE_ID_REVIEW_REQUIRED", path, `legacy ${field} values must be unique before migration`);
      return;
    }
    seen.add(id);
  }
}

function assessOrganizationV2ForV3(input = {}) {
  const source = clone(input);
  const legacyOrganization = source.organization || {};
  const legacyAgentsState = source.agents || {};
  const issues = [];
  const legacyAgentsById = new Map((legacyAgentsState.agents || []).map((agent) => [agent.agent_id, agent]));
  const organizationAgentsById = new Map((legacyOrganization.agents || []).map((agent) => [agent.agent_id, agent]));
  recordLegacyDuplicateIds(issues, legacyAgentsState.agents, "agent_id", "$.agents.agents");
  recordLegacyDuplicateIds(issues, legacyOrganization.agents, "agent_id", "$.organization.agents");
  recordLegacyDuplicateIds(issues, legacyOrganization.lines, "line_id", "$.organization.lines");
  recordLegacyDuplicateIds(issues, legacyOrganization.teams, "team_id", "$.organization.teams");
  recordLegacyDuplicateIds(issues, legacyOrganization.memberships, "membership_id", "$.organization.memberships");
  recordLegacyDuplicateIds(issues, legacyOrganization.relationships, "relationship_id", "$.organization.relationships");
  const agentIds = sortedUniqueStrings([...legacyAgentsById.keys(), ...organizationAgentsById.keys()]);

  const agentRegistry = {
    schema_version: 3,
    organization_revision: Number.isInteger(legacyOrganization.revision) ? legacyOrganization.revision : 0,
    agents: agentIds.map((agentId) => migrationAgentRecord({
      agentId,
      legacyAgent: legacyAgentsById.get(agentId),
      organizationAgent: organizationAgentsById.get(agentId),
      issues
    }))
  };

  const legacyMemberships = clone(legacyOrganization.memberships || []);
  const activeMemberships = legacyMemberships.filter((membership) => membership.active_to === null);
  const lineIds = new Set((legacyOrganization.lines || []).map((line) => line.line_id));
  const teamIds = new Set((legacyOrganization.teams || []).map((team) => team.team_id));

  for (const membership of legacyMemberships) {
    if (!agentIds.includes(membership.agent_id)) {
      recordIssue(issues, "MEMBERSHIP_AGENT_MISSING", `$.organization.memberships.${membership.membership_id}.agent_id`, "legacy membership references a missing agent");
    }
    if (!teamIds.has(membership.team_id)) {
      recordIssue(issues, "MEMBERSHIP_TEAM_MISSING", `$.organization.memberships.${membership.membership_id}.team_id`, "legacy membership references a missing team");
    }
  }

  const teams = (legacyOrganization.teams || []).map((team) => {
    if (team.line_id !== null && !lineIds.has(team.line_id)) {
      recordIssue(issues, "TEAM_LINE_MISSING", `$.organization.teams.${team.team_id}.line_id`, "legacy team references a missing line");
    }
    const members = activeMemberships.filter((membership) => membership.team_id === team.team_id);
    const leads = members.filter((membership) => membership.position === "lead").sort((left, right) => compareText(left.agent_id, right.agent_id));
    if (leads.length > 1) {
      recordIssue(issues, "LEGACY_MULTIPLE_LEADS_REVIEW_REQUIRED", `$.organization.teams.${team.team_id}`, "multiple legacy team leads require review");
    }
    if (members.length >= 3 && leads.length === 1) {
      recordIssue(issues, "LEGACY_COUNT_BASED_LEAD_REVIEW_REQUIRED", `$.organization.teams.${team.team_id}`, "legacy lead may have been generated from member count and requires review");
    }
    return {
      team_id: team.team_id,
      line_id: team.line_id ?? null,
      display_name: team.display_name,
      purpose: team.purpose,
      coordination_mode: leads.length > 0 ? "supervised" : "peer",
      lead_agent_id: leads.length === 1 ? leads[0].agent_id : null,
      lifecycle_state: team.lifecycle_state
    };
  });

  const relationships = (legacyOrganization.relationships || []).map((relationship) => {
    if (!agentIds.includes(relationship.from_agent_id) || !agentIds.includes(relationship.to_agent_id)) {
      recordIssue(issues, "RELATIONSHIP_AGENT_MISSING", `$.organization.relationships.${relationship.relationship_id}`, "legacy relationship references a missing agent");
    }
    return {
      relationship_id: relationship.relationship_id,
      type: "reports_to",
      subject_ref: { kind: "agent", id: relationship.from_agent_id },
      object_ref: { kind: "agent", id: relationship.to_agent_id }
    };
  });

  const lines = (legacyOrganization.lines || []).map((line) => {
    if (line.dedicated_lead_agent_id !== null && line.dedicated_lead_agent_id !== undefined) {
      recordIssue(issues, "LEGACY_DEDICATED_LEAD_REVIEW_REQUIRED", `$.organization.lines.${line.line_id}.dedicated_lead_agent_id`, "legacy dedicated line lead is not automatically promoted into v3 authority");
    }
    if (!agentIds.includes(line.owner_agent_id)) {
      recordIssue(issues, "LINE_OWNER_MISSING", `$.organization.lines.${line.line_id}.owner_agent_id`, "legacy line owner references a missing agent");
    }
    return {
      line_id: line.line_id,
      display_name: line.display_name,
      goal: line.goal,
      deliverable_ids: clone(line.deliverable_ids || []),
      completion_root_ids: clone(line.completion_root_ids || []),
      scope: clone(line.scope || []),
      owner_ref: { kind: "agent", id: line.owner_agent_id },
      status: line.status,
      approval_source: line.approval_source === "user_approval" ? "user_approval" : "migrated_legacy"
    };
  });

  const policy = legacyOrganization.policy || {};
  const bundle = normalizeBundle({
    agentRegistry,
    organization: {
      schema_version: 3,
      revision: agentRegistry.organization_revision,
      policy: {
        line_creation: policy.organization_changes === "autonomous_except_new_line" ? "review" : "review",
        max_concurrent_provisioning: Number.isInteger(policy.max_concurrent_provisioning) && policy.max_concurrent_provisioning >= 1 ? policy.max_concurrent_provisioning : 3,
        require_executable_task_per_new_agent: policy.require_executable_task_per_new_agent !== false,
        require_no_file_ownership_conflict: policy.require_no_file_ownership_conflict !== false
      },
      participants: [],
      lines,
      teams,
      memberships: legacyMemberships,
      relationships,
      applied_decision_ids: clone(legacyOrganization.applied_decision_ids || []),
      applied_decision_bindings: []
    },
    formations: {
      schema_version: 1,
      organization_revision: agentRegistry.organization_revision,
      formations: []
    }
  });

  const validation = validateOrganizationV3Bundle(bundle);
  issues.push(...validation.issues);
  const normalizedIssues = sortAndDedupeIssues(issues);
  return {
    source_hash: canonicalHash(source),
    status: normalizedIssues.length === 0 ? "ready" : "review_required",
    bundle,
    issues: normalizedIssues
  };
}


module.exports = { assessOrganizationV2ForV3 };
