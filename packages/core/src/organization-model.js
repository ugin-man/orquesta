"use strict";

const { assertContract, canonicalHash } = require("@orquesta/contracts");

const ORGANIZATION_POLICY = Object.freeze({
  organization_changes: "autonomous_except_new_line",
  max_concurrent_provisioning: 3,
  require_executable_task_per_new_agent: true,
  require_no_file_ownership_conflict: true
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function createOrganizationState(input = {}) {
  const state = {
    schema_version: 2,
    revision: Number.isInteger(input.revision) ? input.revision : 0,
    policy: clone(ORGANIZATION_POLICY),
    agents: clone(input.agents || []),
    teams: clone(input.teams || []),
    memberships: clone(input.memberships || []),
    relationships: clone(input.relationships || []),
    lines: clone(input.lines || []),
    applied_decision_ids: clone(input.applied_decision_ids || [])
  };
  assertOrganizationInvariants(state);
  return state;
}

function assertOrganizationInvariants(state) {
  return assertContract("organization-state", state);
}

function normalizeRoleText(value) {
  return typeof value === "string" ? value.normalize("NFKC").trim().toLowerCase() : "";
}

function canonicalRoleId({ requestedRole, roles }) {
  const key = normalizeRoleText(requestedRole);
  if (!key || !Array.isArray(roles)) return null;
  const match = roles.find((role) => role && [role.role_id, ...(role.aliases || [])]
    .some((value) => normalizeRoleText(value) === key));
  return match ? match.role_id : null;
}

function agentCapabilityProviders({ organization, profiles }) {
  assertOrganizationInvariants(organization);
  const agents = new Map(organization.agents.map((agent) => [agent.agent_id, agent]));
  return (profiles || [])
    .filter((profile) => profile && profile.organization_revision === organization.revision && profile.availability === "available")
    .map((profile) => {
      const agent = agents.get(profile.agent_id);
      const capabilities = (profile.capabilities || []).filter((capability) => capability.status === "verified");
      if (!agent || agent.lifecycle_state !== "active" || capabilities.length === 0) return null;
      return {
        agent_id: agent.agent_id,
        capability_ids: capabilities.map((capability) => capability.capability_id).sort(compareText),
        evidence_refs: [...new Set(capabilities.flatMap((capability) => capability.evidence_refs || []))].sort(compareText),
        organization_scope: agent.organization_scope,
        availability: profile.availability
      };
    })
    .filter(Boolean)
    .sort((left, right) => compareText(left.agent_id, right.agent_id));
}

function mergeRecords(current, additions, field) {
  const values = [...current, ...(additions || [])].map(clone);
  const ids = new Set();
  for (const value of values) {
    if (ids.has(value[field])) throw new TypeError(`organization change duplicates ${field}`);
    ids.add(value[field]);
  }
  return values.sort((left, right) => compareText(left[field], right[field]));
}

function replaceRecords(current, replacements, field) {
  const byId = new Map(current.map((value) => [value[field], clone(value)]));
  for (const replacement of replacements || []) {
    if (!byId.has(replacement[field])) throw new TypeError(`organization replacement is missing ${field}`);
    byId.set(replacement[field], clone(replacement));
  }
  return [...byId.values()].sort((left, right) => compareText(left[field], right[field]));
}

function applyOrganizationDecision({ state, decision, changes = {} }) {
  assertOrganizationInvariants(state);
  assertContract("organization-decision", decision);
  const idempotency_key = canonicalHash({ decision_id: decision.decision_id, prior_revision: decision.organization_revision });
  if (state.applied_decision_ids.includes(decision.decision_id)) {
    return { state: clone(state), idempotency_key, idempotent: true };
  }
  if (decision.organization_revision !== state.revision) {
    throw new TypeError("organization decision revision does not match current state");
  }
  if (decision.selected_action === "propose_line" && decision.approval_state !== "approved") {
    throw new TypeError("propose_line decision must be approved before application");
  }
  const replacementKeys = ["replace_agents", "replace_teams", "replace_memberships", "replace_relationships", "replace_lines"];
  if (!new Set(["permanent_transfer", "assign_lead"]).has(decision.selected_action)
    && replacementKeys.some((key) => Array.isArray(changes[key]) && changes[key].length)) {
    throw new TypeError("organization replacements are limited to permanent transfer and lead assignment");
  }
  const agents = replaceRecords(state.agents, changes.replace_agents, "agent_id");
  const teams = replaceRecords(state.teams, changes.replace_teams, "team_id");
  const memberships = replaceRecords(state.memberships, changes.replace_memberships, "membership_id");
  const relationships = replaceRecords(state.relationships, changes.replace_relationships, "relationship_id");
  const lines = replaceRecords(state.lines, changes.replace_lines, "line_id");
  const next = {
    ...clone(state),
    revision: state.revision + 1,
    agents: mergeRecords(agents, changes.agents, "agent_id"),
    teams: mergeRecords(teams, changes.teams, "team_id"),
    memberships: mergeRecords(memberships, changes.memberships, "membership_id"),
    relationships: mergeRecords(relationships, changes.relationships, "relationship_id"),
    lines: mergeRecords(lines, changes.lines, "line_id"),
    applied_decision_ids: [...state.applied_decision_ids, decision.decision_id].sort(compareText)
  };
  assertOrganizationInvariants(next);
  return { state: next, idempotency_key, idempotent: false };
}

module.exports = {
  ORGANIZATION_POLICY,
  createOrganizationState,
  canonicalRoleId,
  assertOrganizationInvariants,
  applyOrganizationDecision,
  agentCapabilityProviders
};
