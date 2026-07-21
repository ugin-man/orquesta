"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { assertContract } = require("@orquesta/contracts");
const { normalizeOrganizationLeadership } = require("../../packages/core/src/organization-model");
const {
  readJsonFile,
  writeJsonAtomic,
} = require("./json-state");

const SUPPORT_AGENT_IDS = new Set(["user-liaison", "vision-curator", "error-concierge"]);
const FOUNDATION_AGENT_IDS = new Set(["orchestrator", "user-support", "orquesta-admin"]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function roleIdFor(agent) {
  if (SUPPORT_AGENT_IDS.has(agent.agent_id)) return "user-support";
  if (agent.agent_id === "user-support") return "user-support";
  return String(agent.role_id || agent.role || agent.agent_id || "specialist").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "specialist";
}

function operationalStatus(status) {
  if (["active", "working", "running"].includes(status)) return "working";
  if (["blocked", "error"].includes(status)) return "blocked";
  if (status === "reviewing") return "reviewing";
  return "standby";
}

function displayName(roleId) {
  const names = {
    orchestrator: { ja: "統括者", en: "Orchestrator" },
    "user-support": { ja: "利用者支援係", en: "User Support" },
    "orquesta-admin": { ja: "管理係", en: "Orquesta Admin" },
    implementation: { ja: "実装係", en: "Implementation" },
    "bootstrap-qa": { ja: "初期設定検証係", en: "Bootstrap QA" },
    "dashboard-ux": { ja: "ダッシュボード係", en: "Dashboard UX" },
    "docs-release": { ja: "文書公開係", en: "Docs and Release" },
    "protocol-architect": { ja: "設計規約係", en: "Protocol Architect" },
  };
  return names[roleId] || { ja: roleId, en: roleId };
}

function roleDefinition(roleId) {
  const aliases = roleId === "user-support"
    ? ["error-concierge", "user-liaison", "vision-curator"]
    : [];
  return {
    role_id: roleId,
    version: 1,
    display_names: displayName(roleId),
    aliases,
    capability_ids: [`role:${roleId}`],
    default_contract_template: `${roleId}-v1`,
    lifecycle_state: "active",
  };
}

function migratedAgent(agent, now) {
  const supportLegacy = SUPPORT_AGENT_IDS.has(agent.agent_id);
  const roleId = roleIdFor(agent);
  const foundation = FOUNDATION_AGENT_IDS.has(agent.agent_id) || supportLegacy;
  const organizationParentAgentId = FOUNDATION_AGENT_IDS.has(agent.agent_id)
    ? "user"
    : supportLegacy
      ? "user-support"
      : agent.organization_parent_agent_id;
  return {
    ...clone(agent),
    role_id: roleId,
    role_version: 1,
    organization_scope: foundation ? "project" : "line",
    ...(organizationParentAgentId ? { organization_parent_agent_id: organizationParentAgentId } : {}),
    lifecycle_state: supportLegacy ? "superseded" : "active",
    operational_status: supportLegacy ? "standby" : operationalStatus(agent.status),
    superseded_by: supportLegacy ? "user-support" : agent.superseded_by || null,
    migration_review_required: !foundation,
    updated_at: agent.updated_at || now,
  };
}

function newUserSupport(now) {
  return {
    agent_id: "user-support",
    role: "user-support",
    role_id: "user-support",
    role_version: 1,
    thread_id: null,
    status: "standby",
    mission: "Coordinate user questions, user decisions, manual actions, vision ambiguity, and repeated failure guidance.",
    organization_scope: "project",
    organization_parent_agent_id: "user",
    lifecycle_state: "active",
    operational_status: "standby",
    superseded_by: null,
    migration_review_required: false,
    display_name: "利用者支援係",
    display_name_ja: "利用者支援係",
    display_name_en: "User Support",
    created_at: now,
    updated_at: now,
  };
}

function newFoundationAgent(agentId, now) {
  if (agentId === "user-support") return newUserSupport(now);
  const working = agentId === "orchestrator" || agentId === "orquesta-admin";
  const names = displayName(agentId);
  const missions = {
    orchestrator: "Coordinate the project, compile task intent, route work, integrate evidence, and preserve the user authority boundary.",
    "orquesta-admin": "Maintain Orquesta setup, state integrity, diagnostics, and user-facing explanations of Orquesta operation.",
  };
  return {
    agent_id: agentId,
    role: agentId,
    role_id: agentId,
    role_version: 1,
    thread_id: null,
    status: working ? "active" : "standby",
    mission: missions[agentId],
    organization_scope: "project",
    organization_parent_agent_id: "user",
    lifecycle_state: "active",
    operational_status: working ? "working" : "standby",
    superseded_by: null,
    migration_review_required: false,
    display_name: names.ja,
    display_name_ja: names.ja,
    display_name_en: names.en,
    created_at: now,
    updated_at: now,
  };
}

function migrationProductionRecords(agents, now) {
  const productionAgents = agents.filter((agent) => agent.organization_scope === "line");
  if (!productionAgents.length) return { teams: [], memberships: [], lines: [] };
  const lineId = "migration-existing-project";
  const roleIds = [...new Set(productionAgents.map((agent) => agent.role_id))].sort(compareText);
  const teamIdForRole = (roleId) => `${lineId}-${roleId}`;
  const teams = roleIds.map((roleId) => ({
    team_id: teamIdForRole(roleId),
    line_id: lineId,
    display_name: displayName(roleId).ja,
    purpose: `Preserve the existing ${roleId} specialists while explicit production lines are reviewed.`,
    lifecycle_state: "active",
  }));
  const roleOrdinal = new Map();
  const memberships = productionAgents.map((agent) => {
    const ordinal = (roleOrdinal.get(agent.role_id) || 0) + 1;
    roleOrdinal.set(agent.role_id, ordinal);
    return {
      membership_id: `membership-${lineId}-${agent.agent_id}`,
      agent_id: agent.agent_id,
      team_id: teamIdForRole(agent.role_id),
      position: ordinal === 1 ? "lead" : "member",
      ordinal,
      active_from: now,
      active_to: null,
    };
  });
  return {
    teams,
    memberships,
    lines: [{
      line_id: lineId,
      display_name: "既存プロジェクト",
      goal: "Keep the existing production organization operational while its explicit lines are reviewed.",
      deliverable_ids: ["existing-project-delivery"],
      completion_root_ids: ["existing-project-completion"],
      scope: ["existing-project"],
      owner_agent_id: "orchestrator",
      dedicated_lead_agent_id: null,
      status: "active",
      approval_source: "setup_confirmation",
    }],
  };
}

function migrateLegacyOrganization({
  projectId,
  agentsState,
  sessionsState = { version: 1, sessions: [] },
  tasksState = { version: 1, tasks: [] },
  rolesState = null,
  organizationState = null,
  now,
} = {}) {
  if (!projectId || !agentsState || !Array.isArray(agentsState.agents) || !now) {
    throw new TypeError("projectId, agentsState.agents, and now are required");
  }
  if (organizationState?.schema_version === 2 && rolesState?.schema_version === 1) {
    return {
      rolesState: clone(rolesState),
      agentsState: clone(agentsState),
      organizationState: clone(organizationState),
      sessionsState: clone(sessionsState),
      tasksState: clone(tasksState),
    };
  }

  const migratedAgents = agentsState.agents.map((agent) => migratedAgent(agent, now));
  for (const agentId of FOUNDATION_AGENT_IDS) {
    if (!migratedAgents.some((agent) => agent.agent_id === agentId)) {
      migratedAgents.push(newFoundationAgent(agentId, now));
    }
  }
  migratedAgents.sort((left, right) => compareText(left.agent_id, right.agent_id));

  const roleIds = [...new Set(migratedAgents.map((agent) => agent.role_id))].sort(compareText);
  const revision = 1;
  const nextRolesState = {
    schema_version: 1,
    organization_revision: revision,
    roles: roleIds.map(roleDefinition),
    updated_at: now,
  };
  const nextAgentsState = {
    ...clone(agentsState),
    schema_version: 2,
    organization_revision: revision,
    agents: migratedAgents,
    organization_migration: {
      status: "review_required",
      migrated_at: now,
      superseded_agent_ids: ["error-concierge", "user-liaison", "vision-curator"]
        .filter((agentId) => migratedAgents.some((agent) => agent.agent_id === agentId)),
      unassigned_production_agent_ids: migratedAgents
        .filter((agent) => agent.migration_review_required)
        .map((agent) => agent.agent_id),
      diagnostics: ["legacy_production_membership_requires_explicit_line_mapping"],
    },
    updated_at: now,
  };
  const foundationMembers = ["orchestrator", "orquesta-admin", "user-support"]
    .filter((agentId) => migratedAgents.some((agent) => agent.agent_id === agentId));
  const productionRecords = migrationProductionRecords(migratedAgents, now);
  const nextOrganizationState = normalizeOrganizationLeadership({
    schema_version: 2,
    revision,
    policy: {
      organization_changes: "autonomous_except_new_line",
      max_concurrent_provisioning: 3,
      require_executable_task_per_new_agent: true,
      require_no_file_ownership_conflict: true,
    },
    agents: migratedAgents.map((agent) => ({
      agent_id: agent.agent_id,
      role_id: agent.role_id,
      organization_scope: agent.organization_scope,
      lifecycle_state: agent.lifecycle_state,
      operational_status: agent.operational_status,
    })),
    teams: [{
      team_id: "foundation",
      line_id: null,
      display_name: "Orquesta Foundation",
      purpose: "Project-wide orchestration and user support",
      lifecycle_state: "active",
    }, ...productionRecords.teams],
    memberships: [...foundationMembers.map((agentId, index) => ({
      membership_id: `membership-foundation-${agentId}`,
      agent_id: agentId,
      team_id: "foundation",
      position: agentId === "orchestrator" ? "lead" : "member",
      ordinal: index + 1,
      active_from: now,
      active_to: null,
    })), ...productionRecords.memberships],
    relationships: [],
    lines: productionRecords.lines,
    applied_decision_ids: [],
  });

  return {
    rolesState: nextRolesState,
    agentsState: nextAgentsState,
    organizationState: nextOrganizationState,
    sessionsState: clone(sessionsState),
    tasksState: clone(tasksState),
  };
}

function repairLegacyOrganizationMigration({
  rolesState,
  agentsState,
  organizationState,
  sessionsState = { version: 1, sessions: [] },
  tasksState = { version: 1, tasks: [] },
  now,
} = {}) {
  if (!rolesState || !agentsState || !organizationState || !now) {
    throw new TypeError("rolesState, agentsState, organizationState, and now are required");
  }
  const migration = agentsState.organization_migration;
  if (!migration || typeof migration !== "object" || migration.status !== "review_required") {
    return {
      changed: false,
      bundle: {
        rolesState: clone(rolesState),
        agentsState: clone(agentsState),
        organizationState: clone(organizationState),
        sessionsState: clone(sessionsState),
        tasksState: clone(tasksState),
      },
    };
  }

  const desiredScope = (agentId) => FOUNDATION_AGENT_IDS.has(agentId) || SUPPORT_AGENT_IDS.has(agentId) ? "project" : "line";
  const desiredParent = (agent) => FOUNDATION_AGENT_IDS.has(agent.agent_id)
    ? "user"
    : SUPPORT_AGENT_IDS.has(agent.agent_id)
      ? "user-support"
      : agent.organization_parent_agent_id;
  const repairedAgents = (agentsState.agents || []).map((agent) => {
    const parent = desiredParent(agent);
    const next = {
      ...clone(agent),
      organization_scope: desiredScope(agent.agent_id),
      ...(parent ? { organization_parent_agent_id: parent } : {}),
    };
    return next;
  });
  const repairedOrganizationAgents = (organizationState.agents || []).map((agent) => ({
    ...clone(agent),
    organization_scope: desiredScope(agent.agent_id),
  }));
  const repairedRelationships = (organizationState.relationships || []).filter((relationship) => (
    !["user-support", "orquesta-admin"].includes(relationship.from_agent_id)
  ));
  const teamById = new Map((organizationState.teams || []).map((team) => [team.team_id, team]));
  const lineScopedMemberIds = new Set((organizationState.memberships || [])
    .filter((membership) => membership.active_to === null && teamById.get(membership.team_id)?.line_id)
    .map((membership) => membership.agent_id));
  const unmappedProductionAgents = repairedAgents.filter((agent) => (
    agent.organization_scope === "line" && !lineScopedMemberIds.has(agent.agent_id)
  ));
  const productionRecords = migrationProductionRecords(unmappedProductionAgents, now);
  const appendUnique = (current, additions, key) => {
    const ids = new Set((current || []).map((item) => item[key]));
    return [...clone(current || []), ...additions.filter((item) => !ids.has(item[key]))];
  };
  const repairedTeams = appendUnique(organizationState.teams, productionRecords.teams, "team_id");
  const repairedMemberships = appendUnique(organizationState.memberships, productionRecords.memberships, "membership_id");
  const repairedLines = appendUnique(organizationState.lines, productionRecords.lines, "line_id");
  const repairedOrganizationState = normalizeOrganizationLeadership({
    ...clone(organizationState),
    agents: repairedOrganizationAgents,
    teams: repairedTeams,
    memberships: repairedMemberships,
    relationships: repairedRelationships,
    lines: repairedLines,
  });
  const layoutAlreadyCanonical = JSON.stringify(repairedAgents) === JSON.stringify(agentsState.agents || [])
    && JSON.stringify(repairedOrganizationAgents) === JSON.stringify(organizationState.agents || [])
    && JSON.stringify(repairedRelationships) === JSON.stringify(organizationState.relationships || [])
    && JSON.stringify(repairedTeams) === JSON.stringify(organizationState.teams || [])
    && JSON.stringify(repairedOrganizationState.memberships) === JSON.stringify(organizationState.memberships || [])
    && JSON.stringify(repairedOrganizationState.lines) === JSON.stringify(organizationState.lines || []);
  if (layoutAlreadyCanonical) {
    return {
      changed: false,
      bundle: {
        rolesState: clone(rolesState),
        agentsState: clone(agentsState),
        organizationState: clone(organizationState),
        sessionsState: clone(sessionsState),
        tasksState: clone(tasksState),
      },
    };
  }

  const revision = Number(organizationState.revision || 0) + 1;
  return {
    changed: true,
    bundle: {
      rolesState: {
        ...clone(rolesState),
        organization_revision: revision,
        updated_at: now,
      },
      agentsState: {
        ...clone(agentsState),
        organization_revision: revision,
        agents: repairedAgents,
        organization_migration: {
          ...clone(migration),
          layout_repaired_at: now,
        },
        updated_at: now,
      },
      organizationState: {
        ...repairedOrganizationState,
        revision,
      },
      sessionsState: clone(sessionsState),
      tasksState: clone(tasksState),
    },
  };
}

function duplicateIds(items, field) {
  const seen = new Set();
  const duplicates = new Set();
  for (const item of items || []) {
    const id = item?.[field];
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return [...duplicates].sort(compareText);
}

function assertBundle(bundle, expectedRevision) {
  if (!bundle || !bundle.rolesState || !bundle.agentsState || !bundle.organizationState) {
    throw new TypeError("organization transition requires rolesState, agentsState, and organizationState");
  }
  const agentDuplicates = duplicateIds(bundle.agentsState.agents, "agent_id");
  if (agentDuplicates.length) throw new Error(`duplicate agent_id: ${agentDuplicates.join(", ")}`);
  const roleDuplicates = duplicateIds(bundle.rolesState.roles, "role_id");
  if (roleDuplicates.length) throw new Error(`duplicate role_id: ${roleDuplicates.join(", ")}`);
  const registeredAgentIds = new Set((bundle.agentsState.agents || []).map((agent) => agent.agent_id));
  const registeredRoleIds = new Set((bundle.rolesState.roles || []).map((role) => role.role_id));
  for (const agent of bundle.organizationState.agents || []) {
    if (!registeredAgentIds.has(agent.agent_id)) {
      throw new Error(`organization references missing agent_id: ${agent.agent_id}`);
    }
    if (!registeredRoleIds.has(agent.role_id)) {
      throw new Error(`organization references missing role_id: ${agent.role_id}`);
    }
  }
  const nextRevision = expectedRevision + 1;
  for (const [name, revision] of [
    ["organization", bundle.organizationState.revision],
    ["roles", bundle.rolesState.organization_revision],
    ["agents", bundle.agentsState.organization_revision],
  ]) {
    if (revision !== nextRevision) throw new Error(`${name} revision must equal ${nextRevision}`);
  }
  if (JSON.stringify(bundle).includes("temporary_assignment")) {
    throw new Error("temporary_assignment is forbidden");
  }
  for (const role of bundle.rolesState.roles || []) assertContract("role-definition", role);
  assertContract("organization-state", bundle.organizationState);
}

function statePaths(root) {
  const stateRoot = path.join(root, ".orquesta", "state");
  return {
    stateRoot,
    roles: path.join(stateRoot, "roles.json"),
    agents: path.join(stateRoot, "agents.json"),
    organization: path.join(stateRoot, "organization.json"),
    sessions: path.join(stateRoot, "sessions.json"),
    tasks: path.join(stateRoot, "tasks.json"),
    transition: path.join(stateRoot, "organization-transition.json"),
  };
}

function readOrganizationBundle(root) {
  const paths = statePaths(root);
  return {
    rolesState: readJsonFile(paths.roles, { schema_version: 1, organization_revision: 0, roles: [], updated_at: null }),
    agentsState: readJsonFile(paths.agents, { version: 1, agents: [] }),
    organizationState: readJsonFile(paths.organization, {
      schema_version: 2,
      revision: 0,
      policy: {
        organization_changes: "autonomous_except_new_line",
        max_concurrent_provisioning: 3,
        require_executable_task_per_new_agent: true,
        require_no_file_ownership_conflict: true,
      },
      agents: [],
      teams: [],
      memberships: [],
      relationships: [],
      lines: [],
      applied_decision_ids: [],
    }),
    sessionsState: readJsonFile(paths.sessions, { version: 1, sessions: [] }),
    tasksState: readJsonFile(paths.tasks, { version: 1, tasks: [] }),
  };
}

function snapshotFiles(paths) {
  const snapshot = new Map();
  for (const filePath of paths) {
    snapshot.set(filePath, fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null);
  }
  return snapshot;
}

function restoreFiles(snapshot) {
  for (const [filePath, content] of snapshot) {
    if (content === null) {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      continue;
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf8");
  }
}

function commitOrganizationTransition({ root, expectedRevision, bundle, now } = {}) {
  if (!root || !Number.isInteger(expectedRevision) || expectedRevision < 0 || !now) {
    throw new TypeError("root, nonnegative expectedRevision, bundle, and now are required");
  }
  assertBundle(bundle, expectedRevision);
  const paths = statePaths(root);
  const current = readJsonFile(paths.organization, { revision: 0 });
  if (Number(current.revision || 0) !== expectedRevision) {
    throw new Error(`organization revision conflict: expected ${expectedRevision}, found ${current.revision || 0}`);
  }
  const targetPaths = [paths.roles, paths.agents, paths.organization];
  const snapshot = snapshotFiles([...targetPaths, paths.transition]);
  const manifest = {
    schema_version: 1,
    status: "prepared",
    from_revision: expectedRevision,
    to_revision: expectedRevision + 1,
    prepared_at: now,
    committed_at: null,
    target_paths: targetPaths.map((filePath) => path.relative(root, filePath).replace(/\\/g, "/")),
  };
  try {
    writeJsonAtomic(paths.transition, manifest, { backup: true });
    writeJsonAtomic(paths.roles, bundle.rolesState, { backup: true });
    writeJsonAtomic(paths.agents, bundle.agentsState, { backup: true });
    writeJsonAtomic(paths.organization, bundle.organizationState, { backup: true });
    writeJsonAtomic(paths.transition, { ...manifest, status: "committed", committed_at: now }, { backup: true });
    return { status: "committed", revision: expectedRevision + 1, manifestPath: paths.transition };
  } catch (error) {
    restoreFiles(snapshot);
    throw error;
  }
}

module.exports = {
  FOUNDATION_AGENT_IDS,
  commitOrganizationTransition,
  migrateLegacyOrganization,
  repairLegacyOrganizationMigration,
  readOrganizationBundle,
};
