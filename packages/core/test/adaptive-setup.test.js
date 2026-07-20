"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createAdaptiveSpecialistPlan,
  createFoundationPlan,
  normalizeProjectUnderstanding,
  selectFirstExecutableBatch,
} = require("../src/adaptive-setup");

function understanding(projectId, goal) {
  return {
    project_id: projectId,
    goal,
    stage: "active-development",
    deliverables: [{ deliverable_id: projectId, name: goal, completion_evidence: ["fixture"] }],
    stack: ["Node.js"],
    constraints: [],
    existing_assets: [],
    unknowns: [],
    evidence: [{ path: "README.md", content_hash: "a".repeat(64), read_at: "2026-07-20T00:00:00.000Z" }],
    confidence: 80
  };
}

function role(roleId) {
  return { role_id: roleId, aliases: [] };
}

function task(taskId, roleId, scope, status = "executable") {
  return {
    task_id: taskId,
    status,
    role_id: roleId,
    line_id: "project-line",
    team_id: `${roleId}-team`,
    scope_boundaries: [scope],
    activation_condition: `${taskId} becomes executable`
  };
}

function planInput(overrides = {}) {
  return {
    project_understanding: understanding("docs", "Documentation project"),
    completion_map: { revision: 1, tasks: [task("T-docs", "documentation", "docs")] },
    role_definitions: [role("documentation"), role("implementation"), role("game-design"), role("release")],
    approval_source: "setup_confirmation",
    ...overrides
  };
}

test("adaptive setup creates exactly the three foundation agents", () => {
  assert.deepEqual(createFoundationPlan(), [
    { agent_id: "orchestrator", role_id: "orchestrator", organization_scope: "project", operational_status: "working" },
    { agent_id: "user-support", role_id: "user-support", organization_scope: "project", operational_status: "standby" },
    { agent_id: "orquesta-admin", role_id: "orquesta-admin", organization_scope: "project", operational_status: "working" }
  ]);
});

test("adaptive setup derives distinct initial specialists from executable project work", () => {
  const documentation = createAdaptiveSpecialistPlan(planInput());
  const desktopCore = createAdaptiveSpecialistPlan(planInput({
    project_understanding: understanding("desktop-core", "Desktop and Core project"),
    completion_map: { revision: 2, tasks: [task("T-desktop", "implementation", "apps/orquesta-desktop"), task("T-core", "implementation", "packages/core")] }
  }));
  const game = createAdaptiveSpecialistPlan(planInput({
    project_understanding: understanding("game", "Game project"),
    completion_map: { revision: 3, tasks: [task("T-game", "game-design", "game/design")] }
  }));

  assert.deepEqual(documentation.selected_specialists.map((item) => item.role_id), ["documentation"]);
  assert.equal(desktopCore.selected_specialists[0].quantity, 2);
  assert.deepEqual(game.selected_specialists.map((item) => item.role_id), ["game-design"]);
  assert.notDeepEqual(documentation.selected_specialists, game.selected_specialists);
});

test("future milestone roles remain candidates without agents", () => {
  const plan = createAdaptiveSpecialistPlan(planInput({
    completion_map: { revision: 1, tasks: [task("T-docs", "documentation", "docs"), task("T-release", "release", "release", "planned")] }
  }));
  assert.equal(plan.selected_specialists.some((item) => item.role_id === "release"), false);
  assert.equal(plan.future_candidates.some((item) => item.role_id === "release"), true);
});

test("unknown initial work blocks with a user capability instead of inventing a specialist", () => {
  const unknown = createAdaptiveSpecialistPlan(planInput({
    completion_map: { revision: 1, tasks: [task("T-unknown", null, "unknown")] }
  }));
  assert.equal(unknown.status, "blocked_unknown");
  assert.equal(unknown.specialist_plan, null);
  assert.equal(unknown.user_capability.capability_id, "organization.clarification");
});

test("understanding and first executable selection are canonical and dependency-aware", () => {
  const normalized = normalizeProjectUnderstanding({ ...understanding("docs", "Documentation project"), stack: ["Node.js", "Node.js"] });
  assert.deepEqual(normalized.stack, ["Node.js"]);
  const batch = selectFirstExecutableBatch([
    { ...task("T-complete", "documentation", "docs", "completed") },
    { ...task("T-ready", "documentation", "docs", "ready"), depends_on: ["T-complete"] },
    { ...task("T-blocked", "release", "release", "ready"), depends_on: ["T-missing"] }
  ]);
  assert.deepEqual(batch.map((item) => item.task_id), ["T-ready"]);
});
