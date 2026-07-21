"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { assertContract } = require("@orquesta/contracts");

const {
  commitOrganizationTransition,
  migrateLegacyOrganization,
  repairLegacyOrganizationMigration,
  readOrganizationBundle,
} = require("./organization-state");

const NOW = "2026-07-20T13:50:00.000Z";

function legacyAgents() {
  return {
    version: 1,
    updated_at: "2026-07-17T00:00:00.000Z",
    agents: [
      { agent_id: "orchestrator", role: "orchestrator", status: "active", thread_id: "thread-orchestrator" },
      { agent_id: "orquesta-admin", role: "orquesta-admin", status: "standby", thread_id: "thread-admin" },
      { agent_id: "user-liaison", role: "user-liaison", status: "standby", thread_id: "thread-liaison" },
      { agent_id: "vision-curator", role: "vision-curator", status: "standby", thread_id: "thread-vision" },
      { agent_id: "error-concierge", role: "error-concierge", status: "idle", thread_id: "thread-error" },
      { agent_id: "implementation-001", role: "implementation", status: "standby", thread_id: "thread-implementation" },
      { agent_id: "bootstrap-qa-001", role: "bootstrap-qa", status: "standby", thread_id: "thread-bootstrap" },
    ],
  };
}

function emptySessions() {
  return { version: 1, sessions: [] };
}

function emptyTasks() {
  return { version: 1, tasks: [] };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function makeRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-organization-state-"));
  const stateRoot = path.join(root, ".orquesta", "state");
  writeJson(path.join(stateRoot, "agents.json"), legacyAgents());
  writeJson(path.join(stateRoot, "sessions.json"), emptySessions());
  writeJson(path.join(stateRoot, "tasks.json"), emptyTasks());
  return { root, stateRoot };
}

test("legacy support agents are superseded by one active user-support agent without deleting history", () => {
  const migrated = migrateLegacyOrganization({
    projectId: "fixture-project",
    agentsState: legacyAgents(),
    sessionsState: emptySessions(),
    tasksState: emptyTasks(),
    now: NOW,
  });

  assert.deepEqual(
    migrated.agentsState.agents.filter((agent) => agent.agent_id === "user-support").map((agent) => ({
      role_id: agent.role_id,
      lifecycle_state: agent.lifecycle_state,
      organization_scope: agent.organization_scope,
    })),
    [{ role_id: "user-support", lifecycle_state: "active", organization_scope: "project" }],
  );

  for (const agentId of ["user-liaison", "vision-curator", "error-concierge"]) {
    const agent = migrated.agentsState.agents.find((candidate) => candidate.agent_id === agentId);
    assert.equal(agent.lifecycle_state, "superseded", agentId);
    assert.equal(agent.superseded_by, "user-support", agentId);
    assert.match(agent.thread_id, /^thread-/, `${agentId} thread history must be preserved`);
  }

  assert.equal(migrated.agentsState.agents.find((agent) => agent.agent_id === "bootstrap-qa-001").organization_scope, "line");
  assert.equal(migrated.agentsState.agents.find((agent) => agent.agent_id === "implementation-001").organization_scope, "line");
  assert.equal(migrated.agentsState.agents.find((agent) => agent.agent_id === "orchestrator").organization_parent_agent_id, "user");
  assert.equal(migrated.agentsState.agents.find((agent) => agent.agent_id === "user-support").organization_parent_agent_id, "user");
  assert.equal(migrated.agentsState.agents.find((agent) => agent.agent_id === "orquesta-admin").organization_parent_agent_id, "user");
  assert.equal(migrated.organizationState.relationships.some((relationship) => ["user-support", "orquesta-admin"].includes(relationship.from_agent_id)), false);
  assert.equal(migrated.agentsState.organization_migration.status, "review_required");
  assert.doesNotThrow(() => assertContract("organization-state", migrated.organizationState));
  assert.equal(JSON.stringify(migrated).includes("temporary_assignment"), false);
});

test("legacy migration is idempotent and canonicalizes one role definition per role", () => {
  const first = migrateLegacyOrganization({
    projectId: "fixture-project",
    agentsState: legacyAgents(),
    sessionsState: emptySessions(),
    tasksState: emptyTasks(),
    now: NOW,
  });
  const second = migrateLegacyOrganization({
    projectId: "fixture-project",
    agentsState: first.agentsState,
    sessionsState: emptySessions(),
    tasksState: emptyTasks(),
    rolesState: first.rolesState,
    organizationState: first.organizationState,
    now: NOW,
  });

  assert.deepEqual(second, first);
  assert.equal(new Set(first.rolesState.roles.map((role) => role.role_id)).size, first.rolesState.roles.length);
  assert.equal(first.agentsState.agents.filter((agent) => agent.agent_id === "user-support").length, 1);
});

test("a new repository receives exactly the three unconditional foundation agents", () => {
  const migrated = migrateLegacyOrganization({
    projectId: "new-project",
    agentsState: { version: 1, agents: [] },
    sessionsState: emptySessions(),
    tasksState: emptyTasks(),
    now: NOW,
  });

  assert.deepEqual(
    migrated.organizationState.agents.map((agent) => agent.agent_id).sort(),
    ["orchestrator", "orquesta-admin", "user-support"].sort(),
  );
  assert.equal(migrated.organizationState.agents.some((agent) => agent.agent_id === "bootstrap-qa-001"), false);
});

test("a completed development reset is not repopulated from legacy agent history", () => {
  const migrated = migrateLegacyOrganization({
    projectId: "development-project",
    agentsState: legacyAgents(),
    sessionsState: emptySessions(),
    tasksState: emptyTasks(),
    now: NOW,
  });
  const foundationIds = new Set(["orchestrator", "orquesta-admin", "user-support"]);
  migrated.agentsState.organization_migration.status = "complete";
  migrated.organizationState.agents = migrated.organizationState.agents.filter((agent) => foundationIds.has(agent.agent_id));
  migrated.organizationState.teams = migrated.organizationState.teams.filter((team) => team.team_id === "foundation");
  migrated.organizationState.memberships = migrated.organizationState.memberships.filter((membership) => foundationIds.has(membership.agent_id));
  migrated.organizationState.lines = [];

  const repaired = repairLegacyOrganizationMigration({
    ...migrated,
    now: "2026-07-21T15:00:00.000Z",
  });

  assert.equal(repaired.changed, false);
  assert.deepEqual(repaired.bundle.organizationState.agents.map((agent) => agent.agent_id).sort(), [...foundationIds].sort());
  assert.deepEqual(repaired.bundle.organizationState.lines, []);
});

test("an invalid transition writes no organization files", () => {
  const { root, stateRoot } = makeRepository();
  try {
    const beforeAgents = fs.readFileSync(path.join(stateRoot, "agents.json"), "utf8");
    const migrated = migrateLegacyOrganization({
      projectId: "fixture-project",
      agentsState: legacyAgents(),
      sessionsState: emptySessions(),
      tasksState: emptyTasks(),
      now: NOW,
    });
    migrated.agentsState.agents.push({ ...migrated.agentsState.agents[0] });

    assert.throws(
      () => commitOrganizationTransition({ root, expectedRevision: 0, bundle: migrated, now: NOW }),
      /duplicate agent_id/,
    );
    assert.equal(fs.readFileSync(path.join(stateRoot, "agents.json"), "utf8"), beforeAgents);
    assert.equal(fs.existsSync(path.join(stateRoot, "roles.json")), false);
    assert.equal(fs.existsSync(path.join(stateRoot, "organization.json")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a transition rejects organization agents missing from the role or agent registries", () => {
  const { root } = makeRepository();
  try {
    const migrated = migrateLegacyOrganization({
      projectId: "fixture-project",
      agentsState: legacyAgents(),
      sessionsState: emptySessions(),
      tasksState: emptyTasks(),
      now: NOW,
    });
    migrated.organizationState.agents[0].role_id = "missing-role";
    assert.throws(
      () => commitOrganizationTransition({ root, expectedRevision: 0, bundle: migrated, now: NOW }),
      /missing role_id/,
    );

    const missingAgent = migrateLegacyOrganization({
      projectId: "fixture-project",
      agentsState: legacyAgents(),
      sessionsState: emptySessions(),
      tasksState: emptyTasks(),
      now: NOW,
    });
    missingAgent.agentsState.agents = missingAgent.agentsState.agents.filter((agent) => agent.agent_id !== "user-support");
    assert.throws(
      () => commitOrganizationTransition({ root, expectedRevision: 0, bundle: missingAgent, now: NOW }),
      /missing agent_id/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a valid transition commits roles, agents, and organization at one revision and can be read back", () => {
  const { root } = makeRepository();
  try {
    const migrated = migrateLegacyOrganization({
      projectId: "fixture-project",
      agentsState: legacyAgents(),
      sessionsState: emptySessions(),
      tasksState: emptyTasks(),
      now: NOW,
    });
    const result = commitOrganizationTransition({ root, expectedRevision: 0, bundle: migrated, now: NOW });
    const readBack = readOrganizationBundle(root);

    assert.equal(result.status, "committed");
    assert.equal(readBack.organizationState.revision, 1);
    assert.equal(readBack.rolesState.organization_revision, 1);
    assert.equal(readBack.agentsState.organization_revision, 1);
    assert.equal(readBack.agentsState.agents.some((agent) => agent.agent_id === "user-support"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
