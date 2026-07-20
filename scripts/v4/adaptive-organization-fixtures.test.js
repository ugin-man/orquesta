"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  applyOrganizationDecision,
  createAdaptiveSpecialistPlan,
  createOrganizationPreflight,
} = require("@orquesta/core");
const {
  createInitialRosterTransition,
  prepareProvisioningBatch,
} = require("../../orquesta/scripts/adaptive-setup-state");
const {
  commitOrganizationTransition,
  migrateLegacyOrganization,
  readOrganizationBundle,
} = require("../../orquesta/scripts/organization-state");
const {
  commitAutonomousOrganizationDecision,
  commitApprovedLineDecision,
  recordOrganizationDecision,
  resolveLineDecision,
} = require("../../orquesta/scripts/organization-decision-state");

const NOW = "2026-07-20T14:30:00.000Z";

function role(roleId) {
  return {
    role_id: roleId,
    version: 1,
    display_names: { en: roleId, ja: roleId },
    aliases: [],
    capability_ids: [`role:${roleId}`],
    default_contract_template: `${roleId}-v1`,
    lifecycle_state: "active",
  };
}

function understanding(deliverables) {
  return {
    project_id: "fixture",
    goal: "Build the fixture project",
    stage: "initial-setup",
    deliverables: deliverables.map((deliverable_id) => ({ deliverable_id, name: deliverable_id, completion_evidence: [`CM-${deliverable_id.toUpperCase()}`] })),
    evidence: [{ path: "README.md" }],
  };
}

function foundation() {
  return migrateLegacyOrganization({ projectId: "fixture", agentsState: { version: 1, agents: [] }, now: NOW });
}

function planFor(tasks, roleIds, deliverables = ["primary"]) {
  return createAdaptiveSpecialistPlan({
    project_understanding: understanding(deliverables),
    completion_map: { revision: 1, tasks },
    role_definitions: roleIds.map(role),
    approval_source: "setup_confirmation",
  });
}

function autonomousDecision(action, revision, suffix) {
  return {
    decision_id: `OD-${suffix.padStart(12, "0")}`,
    task_intent_id: `TI-${suffix.padStart(12, "0")}`,
    organization_revision: revision,
    input_hash: suffix.padStart(64, "a"),
    mode: "deep",
    selected_action: action,
    reason_codes: [action === "add_role" ? "CAPABILITY_GAP" : action === "add_member" ? "CAPACITY_DURABLE" : action === "assign_lead" ? "DEDICATED_LEAD_CANDIDATE" : "PERMANENT_TRANSFER_SAFE"],
    requires_user_approval: false,
    approval_state: "not_required",
    proposed_line: null,
    created_at: NOW,
  };
}

test("initial setup creates only the two specialists with executable owned work", () => {
  const plan = planFor([
    { task_id: "T-IMPL", status: "ready", depends_on: [], role_id: "implementation", line_id: "primary-line", team_id: "primary-implementation", scope_boundaries: ["src"], acceptance_root_id: "CM-IMPL" },
    { task_id: "T-TEST", status: "ready", depends_on: [], role_id: "testing", line_id: "primary-line", team_id: "primary-testing", scope_boundaries: ["test"], acceptance_root_id: "CM-TEST" },
    { task_id: "T-RELEASE", status: "queued", depends_on: ["T-IMPL"], role_id: "release", line_id: "primary-line", team_id: "primary-release", scope_boundaries: ["dist"], acceptance_root_id: "CM-RELEASE", activation_condition: "T-IMPL accepted" },
  ], ["implementation", "testing", "release"]);
  const base = foundation();
  const batch = prepareProvisioningBatch({ specialistPlan: plan, organizationRevision: 1, existingAgents: base.agentsState.agents, now: NOW });
  const next = createInitialRosterTransition({ bundle: base, specialistPlan: plan, provisioningBatch: batch, projectUnderstanding: understanding(["primary"]), now: NOW });

  assert.deepEqual(batch.requests.map((request) => request.role_id).sort(), ["implementation", "testing"]);
  assert.equal(next.organizationState.agents.filter((agent) => agent.organization_scope === "line").length, 2);
  assert.equal(plan.future_candidates.some((candidate) => candidate.role_id === "release"), true);
});

test("initial setup can form separate Desktop and Core lines under one setup confirmation", () => {
  const plan = planFor([
    { task_id: "T-DESKTOP", status: "ready", depends_on: [], role_id: "implementation", line_id: "desktop-line", team_id: "desktop-implementation", scope_boundaries: ["apps/desktop"], acceptance_root_id: "CM-DESKTOP" },
    { task_id: "T-CORE", status: "ready", depends_on: [], role_id: "implementation", line_id: "core-line", team_id: "core-implementation", scope_boundaries: ["packages/core"], acceptance_root_id: "CM-CORE" },
  ], ["implementation"], ["desktop", "core"]);
  const base = foundation();
  const batch = prepareProvisioningBatch({ specialistPlan: plan, organizationRevision: 1, existingAgents: base.agentsState.agents, now: NOW });
  const next = createInitialRosterTransition({ bundle: base, specialistPlan: plan, provisioningBatch: batch, projectUnderstanding: understanding(["desktop", "core"]), now: NOW });

  assert.deepEqual(next.organizationState.lines.map((line) => line.line_id), ["core-line", "desktop-line"]);
  assert.equal(next.organizationState.lines.every((line) => line.approval_source === "setup_confirmation"), true);
});

test("three non-conflicting same-role tasks create three agents in one role and line", () => {
  const tasks = ["a", "b", "c"].map((name, index) => ({
    task_id: `T-${name.toUpperCase()}`,
    status: "ready",
    depends_on: [],
    role_id: "implementation",
    line_id: "primary-line",
    team_id: "primary-implementation",
    scope_boundaries: [`src/${name}`],
    acceptance_root_id: `CM-${index}`,
  }));
  const plan = planFor(tasks, ["implementation"]);
  const batch = prepareProvisioningBatch({ specialistPlan: plan, organizationRevision: 1, existingAgents: foundation().agentsState.agents, now: NOW });

  assert.equal(plan.selected_specialists[0].quantity, 3);
  assert.equal(new Set(batch.requests.map((request) => request.agent_id)).size, 3);
  assert.equal(new Set(batch.requests.map((request) => request.role_id)).size, 1);
});

test("new roles, leads, and safe permanent transfers stay autonomous", () => {
  const base = foundation().organizationState;
  const withLine = {
    ...base,
    revision: 2,
    agents: [...base.agents, { agent_id: "implementation-001", role_id: "implementation", organization_scope: "line", lifecycle_state: "active", operational_status: "standby" }],
    teams: [{ team_id: "desktop-implementation", line_id: "desktop-line", display_name: "Desktop implementation", purpose: "Desktop", lifecycle_state: "active" }],
    memberships: [{ membership_id: "M-IMPL", agent_id: "implementation-001", team_id: "desktop-implementation", position: "member", ordinal: 1, active_from: NOW, active_to: null }],
    relationships: [],
    lines: [{ line_id: "desktop-line", display_name: "Desktop", goal: "Desktop", deliverable_ids: ["desktop"], completion_root_ids: ["CM-DESKTOP"], scope: ["apps/desktop"], owner_agent_id: "orchestrator", dedicated_lead_agent_id: null, status: "active", approval_source: "setup_confirmation" }],
  };
  const common = {
    task_intent: { task_intent_id: "TI-0123456789ab" },
    organization: withLine,
    work_items: [{ work_item_id: "W1", acceptance_root_id: "CM-DESKTOP", deliverable_id: "desktop", line_id: "desktop-line", scope_boundaries: ["apps/desktop"], durable: true }],
    capability_needs: [{ need_id: "N1", capability_id: "research.primary", role_id: "research", verification_method: "source review" }],
    resolved_assets: [],
    prior_decisions: [],
    created_at: NOW,
  };
  const newRole = createOrganizationPreflight({ ...common, agent_profiles: [] });
  const lead = createOrganizationPreflight({ ...common, capability_needs: [], agent_profiles: [], management_loop: { candidate_agent_id: "implementation-001", evidence_refs: ["EV-LEAD"] } });
  const transfer = createOrganizationPreflight({
    ...common,
    work_items: [{ ...common.work_items[0], acceptance_root_id: "CM-CORE", deliverable_id: "core", line_id: "core-line", scope_boundaries: ["packages/core"] }],
    capability_needs: [{ need_id: "N2", capability_id: "code.change", role_id: "implementation", verification_method: "test" }],
    agent_profiles: [{ agent_id: "implementation-001", availability: "available", organization_revision: 2, current_task_id: null, open_ownership_count: 0, pending_handoff_count: 0, capabilities: [{ capability_id: "code.change", status: "verified", evidence_refs: ["EV-CODE"], scope: ["packages/core"] }] }],
  });

  assert.deepEqual([newRole.selected_action, lead.selected_action, transfer.selected_action], ["add_role", "assign_lead", "permanent_transfer"]);
  assert.equal([newRole, lead, transfer].every((decision) => decision.requires_user_approval === false), true);
});

test("a runtime new line creates one user approval task and cannot commit before approval", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-line-approval-"));
  try {
    const base = foundation();
    commitOrganizationTransition({ root, expectedRevision: 0, bundle: base, now: NOW });
    const current = readOrganizationBundle(root).organizationState;
    const decision = createOrganizationPreflight({
      task_intent: { task_intent_id: "TI-abcdef123456" },
      organization: current,
      work_items: [{ work_item_id: "W-CORE", acceptance_root_id: "CM-CORE", deliverable_id: "core", line_id: null, scope_boundaries: ["packages/core"], durable: true, independent_deliverable: true }],
      capability_needs: [],
      agent_profiles: [],
      resolved_assets: [],
      prior_decisions: [],
      created_at: NOW,
    });
    recordOrganizationDecision({ root, decision, now: NOW });
    const queuePath = path.join(root, ".orquesta", "user_tasks", "queue.json");
    const queue = JSON.parse(fs.readFileSync(queuePath, "utf8"));

    assert.equal(decision.selected_action, "propose_line");
    assert.equal(decision.requires_user_approval, true);
    assert.equal(queue.tasks.length, 1);
    assert.throws(() => commitApprovedLineDecision({ root, decisionId: decision.decision_id, now: NOW }), /approved/);

    resolveLineDecision({ root, decisionId: decision.decision_id, approved: true, note: "Create Core line", now: NOW });
    const committed = commitApprovedLineDecision({ root, decisionId: decision.decision_id, now: NOW });
    assert.equal(committed.organization.lines.some((line) => line.line_id === "core-line"), true);
    assert.equal(JSON.stringify(committed).includes("temporary_assignment"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("roles, members, leads, and safe permanent transfers commit without user tasks", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-autonomous-org-"));
  try {
    const base = foundation();
    commitOrganizationTransition({ root, expectedRevision: 0, bundle: base, now: NOW });
    const initialPlan = planFor([
      { task_id: "T-CORE", status: "ready", depends_on: [], role_id: "implementation", line_id: "core-line", team_id: "core-implementation", scope_boundaries: ["packages/core"], acceptance_root_id: "CM-CORE" },
      { task_id: "T-DESKTOP", status: "ready", depends_on: [], role_id: "implementation", line_id: "desktop-line", team_id: "desktop-implementation", scope_boundaries: ["apps/desktop"], acceptance_root_id: "CM-DESKTOP" },
    ], ["implementation"], ["core", "desktop"]);
    const batch = prepareProvisioningBatch({ specialistPlan: initialPlan, organizationRevision: 1, existingAgents: base.agentsState.agents, now: NOW });
    const initial = createInitialRosterTransition({ bundle: base, specialistPlan: initialPlan, provisioningBatch: batch, projectUnderstanding: understanding(["core", "desktop"]), now: NOW });
    commitOrganizationTransition({ root, expectedRevision: 1, bundle: initial, now: NOW });
    fs.writeFileSync(path.join(root, ".orquesta", "state", "tasks.json"), `${JSON.stringify({ version: 1, tasks: [
      { task_id: "T-SCALE", state: "queued", line_id: "desktop-line" },
      { task_id: "T-RESEARCH", state: "queued", line_id: "core-line" },
    ] }, null, 2)}\n`, "utf8");

    const addMember = autonomousDecision("add_member", 2, "1");
    commitAutonomousOrganizationDecision({
      root,
      decision: addMember,
      changes: {
        agents: [{ agent_id: "implementation-003", role_id: "implementation", organization_scope: "line", lifecycle_state: "provisioning", operational_status: "standby" }],
        memberships: [{ membership_id: "membership-desktop-implementation-implementation-003", agent_id: "implementation-003", team_id: "desktop-implementation", position: "member", ordinal: 2, active_from: NOW, active_to: null }],
        relationships: [{ relationship_id: "relationship-implementation-003-orchestrator", type: "reports_to", from_agent_id: "implementation-003", to_agent_id: "orchestrator" }],
      },
      agentRecords: [{ agent_id: "implementation-003", role: "implementation", role_id: "implementation", role_version: 1, thread_id: null, status: "provisioning", team_id: "desktop-implementation", line_id: "desktop-line", organization_scope: "line", lifecycle_state: "provisioning", operational_status: "standby", created_at: NOW, updated_at: NOW }],
      provisioningRequests: [{ agent_id: "implementation-003", role_id: "implementation", team_id: "desktop-implementation", line_id: "desktop-line", task_id: "T-SCALE" }],
      now: NOW,
    });

    const addRole = autonomousDecision("add_role", 3, "2");
    commitAutonomousOrganizationDecision({
      root,
      decision: addRole,
      changes: {
        agents: [{ agent_id: "research-001", role_id: "research", organization_scope: "line", lifecycle_state: "provisioning", operational_status: "standby" }],
        teams: [{ team_id: "core-research", line_id: "core-line", display_name: "Core research", purpose: "Research Core implementation", lifecycle_state: "active" }],
        memberships: [{ membership_id: "membership-core-research-research-001", agent_id: "research-001", team_id: "core-research", position: "member", ordinal: 1, active_from: NOW, active_to: null }],
        relationships: [{ relationship_id: "relationship-research-001-orchestrator", type: "reports_to", from_agent_id: "research-001", to_agent_id: "orchestrator" }],
      },
      roleDefinitions: [role("research")],
      agentRecords: [{ agent_id: "research-001", role: "research", role_id: "research", role_version: 1, thread_id: null, status: "provisioning", team_id: "core-research", line_id: "core-line", organization_scope: "line", lifecycle_state: "provisioning", operational_status: "standby", created_at: NOW, updated_at: NOW }],
      provisioningRequests: [{ agent_id: "research-001", role_id: "research", team_id: "core-research", line_id: "core-line", task_id: "T-RESEARCH" }],
      now: NOW,
    });

    let current = readOrganizationBundle(root).organizationState;
    const researchMembership = current.memberships.find((item) => item.agent_id === "research-001");
    const coreLine = current.lines.find((line) => line.line_id === "core-line");
    commitAutonomousOrganizationDecision({
      root,
      decision: autonomousDecision("assign_lead", 4, "3"),
      changes: {
        replace_memberships: [{ ...researchMembership, position: "lead" }],
        replace_lines: [{ ...coreLine, dedicated_lead_agent_id: "research-001" }],
      },
      now: NOW,
    });

    current = readOrganizationBundle(root).organizationState;
    const movable = current.agents.find((agent) => agent.agent_id.startsWith("implementation-"));
    const membership = current.memberships.find((item) => item.agent_id === movable.agent_id);
    const destination = current.teams.find((team) => team.line_id !== current.teams.find((team) => team.team_id === membership.team_id).line_id && team.team_id.endsWith("implementation"));
    commitAutonomousOrganizationDecision({
      root,
      decision: autonomousDecision("permanent_transfer", 5, "4"),
      changes: { replace_memberships: [{ ...membership, team_id: destination.team_id }] },
      now: NOW,
    });

    const finalBundle = readOrganizationBundle(root);
    const queuePath = path.join(root, ".orquesta", "user_tasks", "queue.json");
    const provisioning = JSON.parse(fs.readFileSync(path.join(root, ".orquesta", "setup", "provisioning_batch.json"), "utf8"));
    assert.equal(finalBundle.organizationState.revision, 6);
    assert.equal(finalBundle.rolesState.roles.some((item) => item.role_id === "research"), true);
    assert.equal(finalBundle.organizationState.agents.some((agent) => agent.agent_id === "implementation-003"), true);
    assert.equal(finalBundle.organizationState.lines.find((line) => line.line_id === "core-line").dedicated_lead_agent_id, "research-001");
    assert.equal(finalBundle.organizationState.memberships.find((item) => item.agent_id === movable.agent_id).team_id, destination.team_id);
    assert.equal(fs.existsSync(queuePath), false);
    assert.deepEqual(provisioning.requests.map((request) => request.agent_id).sort(), ["implementation-003", "research-001"]);
    assert.equal(provisioning.requests.every((request) => request.status === "pending" && request.task_id), true);
    const repeated = commitAutonomousOrganizationDecision({
      root,
      decision: addMember,
      provisioningRequests: [{ agent_id: "implementation-003", role_id: "implementation", team_id: "desktop-implementation", line_id: "desktop-line", task_id: "T-SCALE" }],
      now: NOW,
    });
    assert.equal(repeated.idempotent, true);
    assert.equal(readOrganizationBundle(root).organizationState.revision, 6);
    assert.throws(() => commitAutonomousOrganizationDecision({
      root,
      decision: autonomousDecision("add_member", 6, "5"),
      provisioningRequests: [{ agent_id: "implementation-004", role_id: "implementation", team_id: "desktop-implementation", line_id: "desktop-line", task_id: "T-MISSING" }],
      now: NOW,
    }), /task not found/);
    assert.equal(readOrganizationBundle(root).organizationState.revision, 6);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("legacy support history is preserved and repeated decisions are idempotent", () => {
  const migrated = migrateLegacyOrganization({
    projectId: "legacy",
    agentsState: { version: 1, agents: [
      { agent_id: "user-liaison", role: "user-liaison", status: "standby" },
      { agent_id: "vision-curator", role: "vision-curator", status: "standby" },
      { agent_id: "error-concierge", role: "error-concierge", status: "standby" },
    ] },
    now: NOW,
  });
  assert.equal(migrated.agentsState.agents.filter((agent) => agent.lifecycle_state === "superseded").length, 3);
  assert.equal(migrated.agentsState.agents.filter((agent) => agent.agent_id === "user-support").length, 1);

  const state = migrated.organizationState;
  const decision = {
    decision_id: "OD-0123456789ab",
    task_intent_id: "TI-0123456789ab",
    organization_revision: state.revision,
    input_hash: "a".repeat(64),
    mode: "deep",
    selected_action: "add_role",
    reason_codes: ["CAPABILITY_GAP"],
    requires_user_approval: false,
    approval_state: "not_required",
    proposed_line: null,
    created_at: NOW,
  };
  const first = applyOrganizationDecision({ state, decision, changes: {} });
  const repeated = applyOrganizationDecision({ state: first.state, decision, changes: {} });
  assert.equal(repeated.idempotent, true);
  assert.equal(new Set(repeated.state.agents.map((agent) => agent.agent_id)).size, repeated.state.agents.length);
});

test("fixed legacy generation paths remain absent", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "..", "orquesta", "dashboard-server.js"), "utf8");
  assert.doesNotMatch(source, /function buildSpecialistCandidates/);
  assert.doesNotMatch(source, /agent_id:\s*"bootstrap-qa-001"/);
  assert.doesNotMatch(source, /foundation_agent_ids[^\n]*user-liaison/);
});
