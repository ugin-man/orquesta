"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createSetupStateBundle,
  prepareProvisioningBatch,
} = require("./adaptive-setup-state");

const NOW = "2026-07-20T13:50:00.000Z";

function specialistPlan() {
  return {
    schema_version: 2,
    source_understanding_hash: "a".repeat(64),
    source_completion_map_revision: 1,
    first_executable_batch: ["T001", "T002", "T003"],
    selected_specialists: [
      {
        role_id: "implementation",
        quantity: 2,
        line_id: "desktop-line",
        team_id: "desktop-implementation",
        reason_codes: ["PARALLEL_NON_CONFLICTING_WORK"],
        task_ids: ["T001", "T002"],
      },
      {
        role_id: "design",
        quantity: 1,
        line_id: "desktop-line",
        team_id: "desktop-design",
        reason_codes: ["CAPABILITY_GAP"],
        task_ids: ["T003"],
      },
    ],
    future_candidates: [{ role_id: "release", activation_condition: "release task becomes executable" }],
    approval_source: "setup_confirmation",
  };
}

test("setup state creates exactly three unconditional foundation agents", () => {
  const bundle = createSetupStateBundle({
    projectId: "fixture-project",
    projectUnderstanding: { project_id: "fixture-project", goal: "Build a desktop app" },
    specialistPlan: specialistPlan(),
    now: NOW,
  });

  assert.deepEqual(
    bundle.foundationAgents.map((agent) => agent.agent_id),
    ["orchestrator", "orquesta-admin", "user-support"],
  );
  assert.equal(bundle.foundationAgents.some((agent) => agent.agent_id === "bootstrap-qa-001"), false);
  assert.equal(bundle.foundationAgents.some((agent) => agent.agent_id === "vision-curator"), false);
});

test("provisioning requests create one agent per executable owned task and keep future roles uncreated", () => {
  const batch = prepareProvisioningBatch({
    specialistPlan: specialistPlan(),
    organizationRevision: 2,
    existingAgents: [],
    now: NOW,
  });

  assert.equal(batch.max_concurrent_provisioning, 3);
  assert.deepEqual(batch.requests.map((request) => request.task_id).sort(), ["T001", "T002", "T003"]);
  assert.equal(batch.requests.every((request) => request.status === "pending"), true);
  assert.equal(batch.requests.some((request) => request.role_id === "release"), false);
  assert.equal(new Set(batch.requests.map((request) => request.agent_id)).size, 3);
});

test("provisioning reuses an existing matching specialist before creating another agent", () => {
  const plan = specialistPlan();
  plan.selected_specialists[0].quantity = 1;
  plan.selected_specialists[0].task_ids = ["T001"];
  plan.selected_specialists = [plan.selected_specialists[0]];
  const batch = prepareProvisioningBatch({
    specialistPlan: plan,
    organizationRevision: 2,
    existingAgents: [
      {
        agent_id: "implementation-004",
        role_id: "implementation",
        lifecycle_state: "active",
        operational_status: "standby",
        line_id: "desktop-line",
      },
    ],
    now: NOW,
  });

  assert.deepEqual(batch.requests, [{
    agent_id: "implementation-004",
    role_id: "implementation",
    team_id: "desktop-implementation",
    line_id: "desktop-line",
    task_id: "T001",
    status: "reuse_ready",
    created_at: NOW,
  }]);
});

test("one task cannot silently approve a new line", () => {
  const plan = specialistPlan();
  plan.selected_specialists[0].line_id = "unapproved-new-line";
  plan.selected_specialists[0].line_approval_state = "pending_user";

  assert.throws(
    () => prepareProvisioningBatch({
      specialistPlan: plan,
      organizationRevision: 2,
      existingAgents: [],
      now: NOW,
    }),
    /new line requires user approval/,
  );
});
