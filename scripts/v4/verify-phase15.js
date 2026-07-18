#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createTaskIntent } = require("../../packages/core/src/task-intent");
const {
  assessExecutionBudget,
  createExecutionPlan,
  escalateExecutionPlan
} = require("../../packages/core/src/execution-policy");
const { checkDelegationGate } = require("../../orquesta/scripts/delegation-gate-check");

const WORKSPACE_ROOT = path.resolve(__dirname, "..", "..");
const TASK_FIXTURE_PATH = path.join(WORKSPACE_ROOT, "fixtures", "v4", "phase1", "local-reuse", "task-intent.json");

function profile(overrides = {}) {
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

function representativeTask(taskId, plan, root) {
  const requiresReview = plan.lane !== "fast";
  const implementation = {
    cycle_id: `${taskId}-implementation-1`,
    kind: "implementation",
    owner_agent_id: "implementation-001",
    status: "completed",
    evidence_refs: ["commit:phase15-verifier"]
  };
  const review = requiresReview ? [{
    cycle_id: `${taskId}-review-1`,
    kind: "review",
    owner_agent_id: "protocol-architect-001",
    status: "accepted",
    findings: { critical: 0, important: 0, minor: 0 },
    evidence_refs: [`.orquesta/reports/${taskId}-review.md`]
  }] : [];
  const handoffAttempts = requiresReview ? [
    { cycle_id: implementation.cycle_id, owner_agent_id: implementation.owner_agent_id, sent_at: "2026-07-16T13:52:19.224Z" },
    { cycle_id: review[0].cycle_id, owner_agent_id: review[0].owner_agent_id, sent_at: "2026-07-16T13:53:19.224Z" }
  ] : [];
  return {
    task_id: taskId,
    state: "accepted",
    owner_agent_id: "implementation-001",
    routing_class: plan.routing.routing_class,
    routing_gate_status: "passed",
    handoff_required: plan.routing.handoff_required,
    handoff_sent_at: requiresReview ? "2026-07-16T13:52:19.224Z" : null,
    handoff_attempts: handoffAttempts,
    specialist_report_required: plan.routing.specialist_report_required,
    specialist_report_path: requiresReview ? `.orquesta/reports/${taskId}-review.md` : null,
    execution_policy_version: 1,
    canonical_state_root: root,
    execution_plan: plan,
    execution_cycles: [implementation, ...review],
    completion_evidence: [
      { kind: "implementation", ref: "commit:phase15-verifier", status: "passed" },
      { kind: "test", ref: "npm run check:v4:phase15", status: "passed" }
    ],
    execution_metrics: {
      wall_time_ms: 1,
      agent_turns: requiresReview ? 2 : 1,
      handoffs: handoffAttempts.length,
      independent_reviews: review.length,
      correction_batches: 0,
      reports: review.length,
      token_usage: { coverage: "unknown", known_total: null, by_thread: [] }
    },
    ...(plan.lane === "critical" ? {
      user_approval_evidence: { status: "approved", source: "phase15 verifier", scope: "temporary critical task" }
    } : {})
  };
}

function writeTasks(root, tasks) {
  const tasksPath = path.join(root, ".orquesta", "state", "tasks.json");
  fs.mkdirSync(path.dirname(tasksPath), { recursive: true });
  fs.writeFileSync(tasksPath, `${JSON.stringify({ version: 1, tasks }, null, 2)}\n`, "utf8");
}

function verifyPhase15() {
  const fixture = JSON.parse(fs.readFileSync(TASK_FIXTURE_PATH, "utf8"));
  const taskIntent = createTaskIntent(fixture.task_intent);
  const fast = createExecutionPlan({ taskIntent, riskProfile: profile({ effects: ["local_read", "workspace_write"] }) });
  const fastReordered = createExecutionPlan({ taskIntent, riskProfile: profile({ effects: ["workspace_write", "local_read"] }) });
  const standard = createExecutionPlan({ taskIntent, riskProfile: profile({ scope: "multiple_boundaries" }) });
  const critical = createExecutionPlan({ taskIntent, riskProfile: profile({ effects: ["external_write"] }) });
  if (fast.execution_plan_id !== fastReordered.execution_plan_id) {
    throw new Error("Execution Plan identity changed when effects were reordered");
  }
  if (assessExecutionBudget(fast, { handoffs: 0, independent_reviews: 0, correction_batches: 0, reports: 0, auxiliary_tasks: 0 }).status !== "within_budget") {
    throw new Error("Fast plan did not accept an in-budget execution");
  }
  if (assessExecutionBudget(fast, { handoffs: 0, independent_reviews: 0, correction_batches: 2, reports: 0, auxiliary_tasks: 0 }).status !== "escalation_required") {
    throw new Error("Fast plan did not require escalation for an over-budget execution");
  }
  const fastEscalated = escalateExecutionPlan({ executionPlan: fast, trigger: "test_failure" });
  const standardEscalated = escalateExecutionPlan({ executionPlan: standard, trigger: "scope_drift" });
  if (fastEscalated.lane !== "standard" || standardEscalated.lane !== "critical") {
    throw new Error("Execution lane escalation was not deterministic");
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-phase15-"));
  try {
    const legacy = {
      task_id: "P15-LEGACY",
      state: "accepted",
      routing_class: "specialist_required",
      routing_gate_status: "passed",
      handoff_required: true,
      handoff_sent_at: "2026-07-16T13:52:19.224Z",
      specialist_report_required: true,
      specialist_report_path: ".orquesta/reports/P15-LEGACY.md"
    };
    const tasks = [
      legacy,
      representativeTask("P15-FAST", fast, root),
      representativeTask("P15-STANDARD", standard, root),
      representativeTask("P15-CRITICAL", critical, root)
    ];
    writeTasks(root, tasks);
    const valid = checkDelegationGate(root);
    if (valid.errors.length > 0) throw new Error(valid.errors.join("\n"));

    writeTasks(root, [...tasks, { task_id: "P15-CHILD", state: "active", execution_parent_task_id: "P15-STANDARD" }]);
    const childResult = checkDelegationGate(root);
    const auxiliaryTaskRejected = childResult.errors.some((error) => error.includes("execution_cycle"));
    if (!auxiliaryTaskRejected) throw new Error("Phase 1.5 auxiliary task was not rejected");

    return {
      status: "passed",
      lanes: [fast.lane, standard.lane, critical.lane],
      stable_effect_ids: true,
      budget: { within_budget: true, over_budget_requires_escalation: true },
      escalation: { fast_to_standard: true, standard_to_critical: true },
      legacy_compatible: true,
      auxiliary_task_rejected: true,
      token_unknown_preserved: tasks.every((task) => task.execution_policy_version !== 1
        || (task.execution_metrics.token_usage.coverage === "unknown"
          && task.execution_metrics.token_usage.known_total === null
          && task.execution_metrics.token_usage.by_thread.length === 0))
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (require.main === module) {
  process.stdout.write(`${JSON.stringify(verifyPhase15())}\n`);
}

module.exports = { verifyPhase15 };
