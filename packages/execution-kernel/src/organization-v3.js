"use strict";

const { FOUNDATION_AGENT_IDS, canonicalHash, validateContract } = require("@orquesta/contracts");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function records(value) {
  return Array.isArray(value) ? value.filter((record) => record !== null && typeof record === "object" && !Array.isArray(record)) : [];
}

function isOperationalAgent(agent) {
  return Boolean(agent && ["provisioning", "active"].includes(agent.lifecycle_state));
}

function isReadyFormationMember(agent) {
  if (!agent) return false;
  return ["workflow", "inspection"].includes(agent.origin)
    ? isOperationalAgent(agent)
    : agent.lifecycle_state === "active";
}

function canonicalFormationId(formation) {
  if (!formation || !["work_cell", "inspection"].includes(formation.formation_kind)
    || typeof formation.source_ref?.kind !== "string"
    || typeof formation.source_ref?.id !== "string"
    || !formation.source_ref.id) return null;
  const kind = formation.formation_kind === "inspection" ? "inspection" : "workflow";
  return `formation-${kind}-${canonicalHash({
    kind,
    sourceKind: formation.source_ref?.kind,
    sourceId: formation.source_ref?.id
  }).slice(0, 12)}`;
}

function recordIssue(issues, code, path, message) {
  issues.push({ code, path, message, severity: "error" });
}

function sortedRecords(values, field) {
  return clone(values || []).sort((left, right) => compareText(String(left?.[field] || ""), String(right?.[field] || "")));
}


function sortedStrings(values) {
  return clone(values || []).sort((left, right) => compareText(String(left), String(right)));
}

function normalizeBundle(input) {
  const bundle = clone(input);
  if (bundle.agentRegistry) {
    if (Array.isArray(bundle.agentRegistry.agents)) bundle.agentRegistry.agents = sortedRecords(bundle.agentRegistry.agents, "agent_id");
  }
  if (bundle.organization) {
    if (Array.isArray(bundle.organization.participants)) bundle.organization.participants = sortedRecords(bundle.organization.participants, "participant_id");
    if (Array.isArray(bundle.organization.lines)) bundle.organization.lines = sortedRecords(bundle.organization.lines, "line_id");
    if (Array.isArray(bundle.organization.teams)) bundle.organization.teams = sortedRecords(bundle.organization.teams, "team_id");
    if (Array.isArray(bundle.organization.memberships)) bundle.organization.memberships = sortedRecords(bundle.organization.memberships, "membership_id");
    if (Array.isArray(bundle.organization.relationships)) bundle.organization.relationships = sortedRecords(bundle.organization.relationships, "relationship_id");
    if (Array.isArray(bundle.organization.applied_decision_ids)) bundle.organization.applied_decision_ids = sortedStrings(bundle.organization.applied_decision_ids);
    if (Array.isArray(bundle.organization.applied_decision_bindings)) {
      bundle.organization.applied_decision_bindings = sortedRecords(bundle.organization.applied_decision_bindings, "decision_id");
    }
  }
  if (bundle.formations) {
    if (Array.isArray(bundle.formations.formations)) {
      bundle.formations.formations = sortedRecords(bundle.formations.formations, "formation_id")
        .map((formation) => ({
          ...formation,
          member_agent_ids: Array.isArray(formation.member_agent_ids) ? sortedStrings(formation.member_agent_ids) : formation.member_agent_ids,
          target_refs: Array.isArray(formation.target_refs) ? clone(formation.target_refs).sort((left, right) => (
            compareText(String(left?.kind || ""), String(right?.kind || ""))
            || compareText(String(left?.id || ""), String(right?.id || ""))
          )) : formation.target_refs
        }));
    }
  }
  return bundle;
}

function appendContractIssues(issues, name, value, pathPrefix) {
  let result;
  try {
    result = validateContract(name, value);
  } catch (error) {
    recordIssue(issues, "CONTRACT_UNAVAILABLE", pathPrefix, error.message);
    return;
  }
  for (const error of result.errors) {
    recordIssue(
      issues,
      `CONTRACT_${name.replace(/-/g, "_").toUpperCase()}_${String(error.code).toUpperCase()}`,
      `${pathPrefix}${error.path.slice(1)}`,
      error.message
    );
  }
}

function validateOrganizationV3Bundle(input) {
  const bundle = clone(input || {});
  const issues = [];
  const outerKeys = Object.keys(bundle).sort();
  const expectedOuterKeys = ["agentRegistry", "formations", "organization"];
  if (outerKeys.length !== expectedOuterKeys.length
    || outerKeys.some((key, index) => key !== expectedOuterKeys[index])) {
    recordIssue(issues, "ORGANIZATION_BUNDLE_KEYS_INVALID", "$", "organization v3 bundle must contain exactly agentRegistry, organization, and formations");
  }
  appendContractIssues(issues, "agent-registry-v3", bundle.agentRegistry, "$.agentRegistry");
  appendContractIssues(issues, "organization-state-v3", bundle.organization, "$.organization");
  appendContractIssues(issues, "formation-state", bundle.formations, "$.formations");

  if (!bundle.agentRegistry || !bundle.organization || !bundle.formations) {
    return { ok: false, issues: sortAndDedupeIssues(issues) };
  }

  if (bundle.agentRegistry.organization_revision !== bundle.organization.revision) {
    recordIssue(issues, "AGENT_REGISTRY_REVISION_MISMATCH", "$.agentRegistry.organization_revision", "agent registry revision must match organization revision");
  }
  if (bundle.formations.organization_revision !== bundle.organization.revision) {
    recordIssue(issues, "FORMATION_REVISION_MISMATCH", "$.formations.organization_revision", "formation revision must match organization revision");
  }

  const agentRecords = records(bundle.agentRegistry.agents);
  const participantRecords = records(bundle.organization.participants);
  const lineRecords = records(bundle.organization.lines);
  const teamRecords = records(bundle.organization.teams);
  const membershipRecords = records(bundle.organization.memberships);
  const relationshipRecords = records(bundle.organization.relationships);
  const formations = records(bundle.formations.formations);
  const agentIds = new Set(agentRecords.map((agent) => agent.agent_id));
  const agentsById = new Map(agentRecords.map((agent) => [agent.agent_id, agent]));
  const lines = new Map(lineRecords.map((line) => [line.line_id, line]));
  const teams = new Map(teamRecords.map((team) => [team.team_id, team]));
  const activeMemberships = membershipRecords.filter((membership) => membership.active_to === null);
  const provisioningCount = agentRecords.filter((agent) => agent.lifecycle_state === "provisioning").length;
  if (Number.isInteger(bundle.organization.policy?.max_concurrent_provisioning)
    && provisioningCount > bundle.organization.policy.max_concurrent_provisioning) {
    recordIssue(issues, "PROVISIONING_CAPACITY_EXCEEDED", "$.agentRegistry.agents", "current provisioning agents exceed organization policy capacity");
  }

  const foundationBootstrapIds = new Set();
  for (const agentId of FOUNDATION_AGENT_IDS) {
    const agent = agentsById.get(agentId);
    if (!agent) {
      recordIssue(issues, "FOUNDATION_AGENT_MISSING", `$.agentRegistry.agents.${agentId}`, "operational v3 requires every canonical foundation agent");
      continue;
    }
    if (!["provisioning", "active"].includes(agent.lifecycle_state)) {
      recordIssue(issues, "FOUNDATION_AGENT_NOT_OPERATIONAL", `$.agentRegistry.agents.${agentId}.lifecycle_state`, "foundation agents must be provisioning or active");
    }
    if (agent.role_id !== agentId) {
      recordIssue(issues, "FOUNDATION_ROLE_MISMATCH", `$.agentRegistry.agents.${agentId}.role_id`, "foundation agent role_id must match its canonical agent id");
    }
    if (agent.origin !== "foundation") {
      recordIssue(issues, "FOUNDATION_ORIGIN_MISMATCH", `$.agentRegistry.agents.${agentId}.origin`, "foundation agents require foundation origin");
    }
    if (!Array.isArray(agent.context_scope) || !agent.context_scope.includes("project")) {
      recordIssue(issues, "FOUNDATION_CONTEXT_SCOPE_MISMATCH", `$.agentRegistry.agents.${agentId}.context_scope`, "foundation agents require project-wide context scope");
    }
    if (agent.created_from_ref?.kind !== "project_bootstrap") {
      recordIssue(issues, "FOUNDATION_PROVENANCE_MISMATCH", `$.agentRegistry.agents.${agentId}.created_from_ref`, "foundation agents require project_bootstrap provenance");
    } else {
      foundationBootstrapIds.add(agent.created_from_ref.id);
    }
  }
  if (foundationBootstrapIds.size > 1) {
    recordIssue(issues, "FOUNDATION_BOOTSTRAP_MISMATCH", "$.agentRegistry.agents", "all foundation agents must share one project_bootstrap reference");
  }
  for (const agent of agentsById.values()) {
    if (agent.origin === "foundation" && !FOUNDATION_AGENT_IDS.includes(agent.agent_id)) {
      recordIssue(issues, "FOUNDATION_AGENT_ID_INVALID", `$.agentRegistry.agents.${agent.agent_id}.origin`, "foundation origin is reserved for the three canonical foundation agents");
    }
  }
  const canonicalUsers = participantRecords.filter((participant) => participant.participant_id === "user");
  if (canonicalUsers.length !== 1 || canonicalUsers[0].lifecycle_state !== "active") {
    recordIssue(issues, "CANONICAL_USER_MISSING", "$.organization.participants.user", "operational v3 requires an active canonical user participant");
  }
  const canonicalAuthorities = relationshipRecords.filter((relationship) => (
    relationship.type === "authority_over"
    && relationship.subject_ref?.kind === "participant"
    && relationship.subject_ref.id === "user"
    && relationship.object_ref?.kind === "agent"
    && relationship.object_ref.id === "orchestrator"
  ));
  if (canonicalAuthorities.length !== 1) {
    recordIssue(issues, "CANONICAL_USER_AUTHORITY_INVALID", "$.organization.relationships", "operational v3 requires exactly one user authority_over orchestrator relationship");
  }

  for (const line of lines.values()) {
    if (line.owner_ref?.kind === "agent" && !agentIds.has(line.owner_ref.id)) {
      recordIssue(issues, "LINE_OWNER_AGENT_MISSING", `$.organization.lines.${line.line_id}.owner_ref`, "agent line owner must exist in the agent registry");
    } else if (line.status === "active" && line.owner_ref?.kind === "agent" && !isOperationalAgent(agentsById.get(line.owner_ref.id))) {
      recordIssue(issues, "ACTIVE_LINE_OWNER_NOT_OPERATIONAL", `$.organization.lines.${line.line_id}.owner_ref`, "an active line requires an operational agent owner");
    }
  }

  for (const membership of membershipRecords) {
    const agent = agentsById.get(membership.agent_id);
    if (!agent) {
      recordIssue(issues, "MEMBERSHIP_AGENT_MISSING", `$.organization.memberships.${membership.membership_id}.agent_id`, "membership agent must exist in the agent registry");
      continue;
    }
    if (["workflow", "inspection"].includes(agent.origin)) {
      recordIssue(issues, "EPHEMERAL_PERSISTENT_MEMBERSHIP", `$.organization.memberships.${membership.membership_id}.agent_id`, "workflow and inspection agents cannot own persistent team memberships");
    }
    if (membership.active_to === null && !isOperationalAgent(agent)) {
      recordIssue(issues, "ACTIVE_MEMBERSHIP_AGENT_NOT_OPERATIONAL", `$.organization.memberships.${membership.membership_id}.agent_id`, "an active membership requires an operational agent");
    }
  }
  const activeLineKeysByAgent = new Map();
  for (const membership of activeMemberships) {
    const team = teams.get(membership.team_id);
    if (!team) continue;
    const key = team.line_id === null ? "<project>" : team.line_id;
    if (!activeLineKeysByAgent.has(membership.agent_id)) activeLineKeysByAgent.set(membership.agent_id, new Set());
    activeLineKeysByAgent.get(membership.agent_id).add(key);
  }
  for (const [agentId, lineKeys] of activeLineKeysByAgent.entries()) {
    if (lineKeys.size > 1) {
      recordIssue(issues, "PERSISTENT_CROSS_LINE_MEMBERSHIP", `$.organization.memberships.${agentId}`, "persistent memberships for one agent must stay in one home line");
    }
  }

  for (const relationship of relationshipRecords) {
    for (const [field, ref] of [["subject_ref", relationship.subject_ref], ["object_ref", relationship.object_ref]]) {
      if (ref?.kind === "agent" && !agentIds.has(ref.id)) {
        recordIssue(issues, "RELATIONSHIP_AGENT_MISSING", `$.organization.relationships.${relationship.relationship_id}.${field}`, "relationship agent must exist in the agent registry");
      } else if (ref?.kind === "agent" && !isOperationalAgent(agentsById.get(ref.id))) {
        recordIssue(issues, "RELATIONSHIP_AGENT_NOT_OPERATIONAL", `$.organization.relationships.${relationship.relationship_id}.${field}`, "current relationships require operational agent endpoints");
      }
    }
  }

  for (const formation of formations) {
    const expectedFormationId = canonicalFormationId(formation);
    if (expectedFormationId !== null && formation.formation_id !== expectedFormationId) {
      recordIssue(issues, "FORMATION_ID_NONCANONICAL", `$.formations.formations.${formation.formation_id}.formation_id`, "formation id must be derived from its kind and source");
    }
    for (const memberId of formation.member_agent_ids || []) {
      const member = agentsById.get(memberId);
      if (!member) {
        recordIssue(issues, "FORMATION_AGENT_MISSING", `$.formations.formations.${formation.formation_id}.member_agent_ids`, "formation members must exist in the agent registry");
      } else if (formation.lifecycle_state === "active" && !isReadyFormationMember(member)) {
        recordIssue(issues, "ACTIVE_FORMATION_AGENT_NOT_READY", `$.formations.formations.${formation.formation_id}.member_agent_ids`, "an active formation requires active persistent members or source-matched provisioning ephemeral members");
      }
      if (member && ["workflow", "inspection"].includes(member.origin)) {
        const expectedFormationKind = member.origin === "workflow" ? "work_cell" : "inspection";
        const expectedSourceKind = member.origin === "workflow" ? "workflow_run" : "task";
        if (formation.formation_kind !== expectedFormationKind
          || formation.source_ref?.kind !== expectedSourceKind
          || formation.source_ref?.id !== member.created_from_ref?.id) {
          recordIssue(issues, "FORMATION_EPHEMERAL_PROVENANCE_MISMATCH", `$.formations.formations.${formation.formation_id}.member_agent_ids`, "an ephemeral member can belong only to the formation that created it");
        }
      }
    }
    const refs = [formation.scope_ref, ...(formation.target_refs || [])];
    for (const ref of refs) {
      const exists = ref?.kind === "agent" ? agentIds.has(ref.id)
        : ref?.kind === "line" ? lines.has(ref.id)
          : ref?.kind === "team" ? teams.has(ref.id)
            : true;
      if (!exists) {
        recordIssue(issues, "FORMATION_REFERENCE_MISSING", `$.formations.formations.${formation.formation_id}`, "formation scope and organization targets must exist");
      }
    }
  }

  for (const agent of agentsById.values()) {
    if (!["workflow", "inspection"].includes(agent.origin)) continue;
    const expectedFormationKind = agent.origin === "workflow" ? "work_cell" : "inspection";
    const expectedSourceKind = agent.origin === "workflow" ? "workflow_run" : "task";
    const matches = formations.filter((formation) => (
      formation.formation_kind === expectedFormationKind
      && formation.source_ref?.kind === expectedSourceKind
      && formation.source_ref?.id === agent.created_from_ref?.id
      && (formation.member_agent_ids || []).includes(agent.agent_id)
    ));
    if (matches.length !== 1) {
      recordIssue(issues, "EPHEMERAL_FORMATION_BINDING_INVALID", `$.agentRegistry.agents.${agent.agent_id}.created_from_ref`, "an ephemeral agent must be a member of exactly one matching source formation");
      continue;
    }
    const formation = matches[0];
    const lifecycleMatches = formation.lifecycle_state === "active"
      ? isOperationalAgent(agent)
      : agent.lifecycle_state === "retired";
    if (!lifecycleMatches) {
      recordIssue(issues, "EPHEMERAL_FORMATION_LIFECYCLE_MISMATCH", `$.agentRegistry.agents.${agent.agent_id}.lifecycle_state`, "ephemeral agent lifecycle must match its source formation lifecycle");
    }
  }

  const normalizedIssues = sortAndDedupeIssues(issues);
  return { ok: normalizedIssues.length === 0, issues: normalizedIssues };
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

function assertOrganizationV3Bundle(bundle) {
  const result = validateOrganizationV3Bundle(bundle);
  if (!result.ok) {
    const error = new TypeError(`organization v3 validation failed: ${result.issues.map((issue) => issue.code).join(", ")}`);
    error.issues = result.issues;
    throw error;
  }
  return bundle;
}

function createOrganizationV3Bundle(input) {
  const bundle = normalizeBundle(input);
  assertOrganizationV3Bundle(bundle);
  return bundle;
}

function createFoundationOrganizationV3Bundle({ createdAt, bootstrapId = "foundation", userDisplayName = "User" } = {}) {
  if (typeof createdAt !== "string" || !createdAt) {
    throw new TypeError("createdAt is required for the Organization v3 foundation bundle");
  }
  const missions = {
    orchestrator: "Coordinate the project and route work across the organization.",
    "orquesta-admin": "Maintain Orquesta configuration, diagnostics, and system continuity.",
    "user-support": "Carry user questions, decisions, and repair needs into the organization."
  };
  return createOrganizationV3Bundle({
    agentRegistry: {
      schema_version: 3,
      organization_revision: 1,
      agents: FOUNDATION_AGENT_IDS.map((agentId) => ({
        agent_id: agentId,
        role_id: agentId,
        role_version: 1,
        mission: missions[agentId],
        context_scope: ["project"],
        lifecycle_state: "provisioning",
        origin: "foundation",
        created_from_ref: { kind: "project_bootstrap", id: bootstrapId },
        retired_at: null
      }))
    },
    organization: {
      schema_version: 3,
      revision: 1,
      policy: {
        line_creation: "review",
        max_concurrent_provisioning: 3,
        require_executable_task_per_new_agent: true,
        require_no_file_ownership_conflict: true
      },
      participants: [{ participant_id: "user", display_name: userDisplayName, participant_kind: "human", lifecycle_state: "active", joined_at: createdAt }],
      lines: [],
      teams: [],
      memberships: [],
      relationships: [{
        relationship_id: "relationship-user-authority-orchestrator",
        type: "authority_over",
        subject_ref: { kind: "participant", id: "user" },
        object_ref: { kind: "agent", id: "orchestrator" }
      }],
      applied_decision_ids: [],
      applied_decision_bindings: []
    },
    formations: { schema_version: 1, organization_revision: 1, formations: [] }
  });
}

module.exports = {
  FOUNDATION_AGENT_IDS,
  assertOrganizationV3Bundle,
  createFoundationOrganizationV3Bundle,
  createOrganizationV3Bundle,
  validateOrganizationV3Bundle
};
