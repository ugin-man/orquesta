"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { assertContract } = require("@orquesta/contracts");
const { createTaskIntent } = require("../src/task-intent");
const {
  assessExecutionBudget,
  createExecutionPlan,
  escalateExecutionPlan,
  EXECUTION_BUDGETS
} = require("../src");

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

function fastPlan() {
  return createExecutionPlan({ taskIntent, riskProfile: riskProfile() });
}

function standardPlan() {
  return createExecutionPlan({ taskIntent, riskProfile: riskProfile({ scope: "multiple_boundaries" }) });
}

function criticalPlan() {
  return createExecutionPlan({ taskIntent, riskProfile: riskProfile({ effects: ["external_write"] }) });
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

test("requires escalation when a standard task exceeds one review", () => {
  assert.deepEqual(assessExecutionBudget(standardPlan(), {
    handoffs: 2,
    independent_reviews: 2,
    correction_batches: 0,
    reports: 1,
    auxiliary_tasks: 0
  }), {
    status: "escalation_required",
    exceeded: ["max_independent_reviews"]
  });
});

test("requires a user decision when a critical task exceeds budget", () => {
  assert.equal(assessExecutionBudget(criticalPlan(), {
    handoffs: 5,
    independent_reviews: 2,
    correction_batches: 2,
    reports: 2,
    auxiliary_tasks: 0
  }).status, "user_decision_required");
});

test("escalates fast to standard without changing the TaskIntent", () => {
  const current = fastPlan();
  const next = escalateExecutionPlan({ executionPlan: current, trigger: "test_failure" });

  assert.equal(next.lane, "standard");
  assert.equal(next.revision, 2);
  assert.equal(next.supersedes_execution_plan_id, current.execution_plan_id);
  assert.equal(next.task_intent_id, current.task_intent_id);
});

test("escalates standard to critical but refuses a further critical escalation", () => {
  const standard = standardPlan();
  const critical = escalateExecutionPlan({ executionPlan: standard, trigger: "budget_exhausted" });

  assert.equal(critical.lane, "critical");
  assert.throws(() => escalateExecutionPlan({ executionPlan: critical, trigger: "budget_exhausted" }), /cannot be escalated/);
});

test("rejects unknown escalation triggers and has no de-escalation API", () => {
  assert.throws(() => escalateExecutionPlan({ executionPlan: fastPlan(), trigger: "unknown" }), TypeError);
  assert.equal(typeof require("../src").deescalateExecutionPlan, "undefined");
});

test("records only the escalation triggers accepted by each automatic lane", () => {
  assert.deepEqual(fastPlan().escalation_triggers, ["acceptance_uncertain", "new_risk", "scope_drift", "test_failure"]);
  assert.deepEqual(standardPlan().escalation_triggers, [
    "budget_exhausted", "critical_risk_discovered", "scope_drift", "semantic_finding_not_machine_verifiable"
  ]);
});
