"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { assertContract } = require("@orquesta/contracts");
const { createTaskIntent } = require("../src/task-intent");
const { createExecutionPlan, EXECUTION_BUDGETS } = require("../src");

const taskFixture = require("../../../fixtures/v4/phase1/local-reuse/task-intent.json");
const taskIntent = createTaskIntent(taskFixture.task_intent);

function riskProfile(overrides = {}) {
  return {
    reversibility: "easy",
    scope: "single_boundary",
    verification: "deterministic",
    uncertainty: "low",
    effects: ["workspace_write"],
    repeated_failures: 0,
    user_review: "default",
    ...overrides
  };
}

test("classifies a reversible local deterministic task as fast", () => {
  const plan = createExecutionPlan({ taskIntent, riskProfile: riskProfile() });

  assert.equal(plan.lane, "fast");
  assert.equal(plan.routing.routing_class, "inline_verified");
  assert.deepEqual(plan.budget, EXECUTION_BUDGETS.fast);
  assert.equal(assertContract("execution-plan", plan), plan);
});

test("classifies multiple ownership boundaries as standard", () => {
  const plan = createExecutionPlan({
    taskIntent,
    riskProfile: riskProfile({ scope: "multiple_boundaries" })
  });

  assert.equal(plan.lane, "standard");
  assert.deepEqual(plan.reason_codes, ["multiple_boundaries"]);
});

test("classifies external writes and strict review as critical", () => {
  const plan = createExecutionPlan({
    taskIntent,
    riskProfile: riskProfile({ effects: ["external_write"], user_review: "strict" })
  });

  assert.equal(plan.lane, "critical");
  assert.deepEqual(plan.reason_codes, ["critical_effect:external_write", "strict_review_requested"]);
});

test("normalizes effect order before deriving the Execution Plan identity", () => {
  const first = createExecutionPlan({
    taskIntent,
    riskProfile: riskProfile({ effects: ["workspace_write", "local_read"] })
  });
  const second = createExecutionPlan({
    taskIntent,
    riskProfile: riskProfile({ effects: ["local_read", "workspace_write"] })
  });

  assert.equal(first.execution_plan_id, second.execution_plan_id);
  assert.deepEqual(first.risk_profile.effects, ["local_read", "workspace_write"]);
});

test("uses a conservative standard plan for an incomplete risk profile", () => {
  const plan = createExecutionPlan({
    taskIntent,
    riskProfile: { scope: "single_boundary" }
  });

  assert.equal(plan.lane, "standard");
  assert.deepEqual(plan.reason_codes, ["incomplete_profile"]);
});
