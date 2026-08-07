"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { assertContract } = require("@orquesta/contracts");
const { createTaskIntent } = require("../src/task-intent");
const {
  CORRECTION_THRESHOLD_REPLAN_REASON,
  assessExecutionBudget,
  createExecutionPlan,
  escalateExecutionPlan,
  reviseExecutionPlan,
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
  assert.equal(plan.policy_version, 1);
  assert.equal(plan.routing.routing_class, "inline_verified");
  assert.deepEqual(plan.budget, EXECUTION_BUDGETS.fast);
  assert.equal(assertContract("execution-plan", plan), plan);
});

test("keeps execution shape independent from review intensity", () => {
  const solo = createExecutionPlan({ taskIntent, riskProfile: riskProfile({ effects: ["external_write"] }), executionEvidence: {} });
  const parallel = createExecutionPlan({
    taskIntent,
    riskProfile: riskProfile(),
    executionEvidence: { independent_deliverables: ["a", "b"], dependencies_explicit: true, write_overlap: false, verification_independence: true, parallel_gain: true },
  });
  const durable = createExecutionPlan({ taskIntent, riskProfile: riskProfile(), executionEvidence: { durable_context_required: true } });
  assert.equal(solo.execution_mode, "solo_direct");
  assert.equal(solo.review_intensity, "strict");
  assert.equal(solo.routing.handoff_required, false);
  assert.equal(solo.review_policy, "independent_twice");
  assert.equal(parallel.execution_mode, "bounded_parallel");
  assert.equal(parallel.review_intensity, "light");
  assert.equal(parallel.review_policy, "none");
  assert.equal(durable.execution_mode, "durable_specialist");
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

test("keeps the V1 correction limits unchanged", () => {
  const baseCounts = {
    handoffs: 2,
    independent_reviews: 1,
    reports: 1,
    auxiliary_tasks: 0,
  };
  assert.equal(assessExecutionBudget(standardPlan(), {
    ...baseCounts,
    correction_batches: 2,
  }).status, "escalation_required");
  assert.equal(assessExecutionBudget(criticalPlan(), {
    handoffs: 3,
    independent_reviews: 2,
    correction_batches: 3,
    reports: 2,
    auxiliary_tasks: 0,
  }).status, "user_decision_required");
});

test("treats the V2 correction budget as a replanning threshold without changing intent or axes", () => {
  const current = createExecutionPlan({
    taskIntent,
    riskProfile: riskProfile({ scope: "multiple_boundaries" }),
    executionEvidence: { durable_context_required: true }
  });
  const counts = {
    handoffs: 2,
    independent_reviews: 1,
    correction_batches: 2,
    reports: 1,
    auxiliary_tasks: 0
  };

  assert.deepEqual(assessExecutionBudget(current, counts), {
    status: "replan_required",
    exceeded: ["max_correction_batches"]
  });

  const unrelatedRevision = reviseExecutionPlan({ executionPlan: current, reasonCodes: ["reuse:CN-tool:reuse"] });
  assert.deepEqual(assessExecutionBudget(unrelatedRevision, counts), {
    status: "replan_required",
    exceeded: ["max_correction_batches"]
  });

  const revised = reviseExecutionPlan({ executionPlan: current, reasonCodes: [CORRECTION_THRESHOLD_REPLAN_REASON] });
  assert.deepEqual(assessExecutionBudget(revised, counts), {
    status: "continuation_allowed",
    exceeded: ["max_correction_batches"]
  });
  assert.equal(revised.task_intent_id, current.task_intent_id);
  assert.equal(revised.lane, current.lane);
  assert.deepEqual(revised.risk_profile.effects, current.risk_profile.effects);
  assert.equal(revised.execution_mode, current.execution_mode);
  assert.equal(revised.review_intensity, current.review_intensity);

  assert.deepEqual(assessExecutionBudget(revised, {
    ...counts,
    handoffs: 3,
  }), {
    status: "replan_required",
    exceeded: ["max_handoffs", "max_correction_batches"],
  });
});

test("does not allow the initial-plan API to forge a later revision", () => {
  assert.throws(() => createExecutionPlan({
    taskIntent,
    riskProfile: riskProfile(),
    executionEvidence: {},
    revision: 2,
    supersedesExecutionPlanId: "EP-0123456789ab"
  }), /initial plan/);
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

test("revises an Execution Plan with discovery decisions without changing its execution axes", () => {
  const current = createExecutionPlan({ taskIntent, riskProfile: riskProfile(), executionEvidence: { durable_context_required: true } });
  const revised = reviseExecutionPlan({ executionPlan: current, reasonCodes: ["reuse:CN-tool:reuse"] });
  assert.equal(revised.revision, current.revision + 1);
  assert.equal(revised.supersedes_execution_plan_id, current.execution_plan_id);
  assert.equal(revised.lane, current.lane);
  assert.equal(revised.execution_mode, "durable_specialist");
  assert.equal(revised.review_intensity, current.review_intensity);
  assert.ok(revised.reason_codes.includes("reuse:CN-tool:reuse"));
});
