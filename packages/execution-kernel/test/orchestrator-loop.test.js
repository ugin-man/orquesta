"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createOrchestratorResumePlan,
  verifyControlPlaneContinuity,
} = require("../src");

const NOW = "2026-07-31T00:00:00.000Z";

function plane() {
  return {
    version: 2,
    project_id: "project-1",
    revision: 8,
    active_workstream: {
      workstream_id: "workstream:T1",
      task_id: "T1",
      current_goal: "Complete the project.",
      next_decision: "schedule_continuation",
    },
    project_brief: { goal: "Complete the project." },
    user_intent: { constraints: ["Do not publish."] },
    decision_ledger: [{ id: "D1", decision: "Keep API." }],
    risk_and_approval: { unresolved: ["Need final review."] },
  };
}

test("orchestrator resume plans consume compact deltas without specialist logs", () => {
  const deltas = [{
    branch_delta_id: "BD-1",
    receipt_id: "CE-1",
    workstream_id: "workstream:T1",
    task_intent_id: "TI-1",
    orchestrator_action: "schedule_continuation",
    transition: "continuation_ready",
    attention: "none",
    summary: "Local work is accepted.",
    observed_at: NOW,
  }, {
    branch_delta_id: "BD-2",
    receipt_id: "CE-2",
    workstream_id: "workstream:T2",
    task_intent_id: "TI-2",
    orchestrator_action: "request_context_expansion",
    transition: "needs_context",
    attention: "blocker",
    summary: "A current decision is missing.",
    observed_at: "2026-07-31T00:00:01.000Z",
  }];
  const plan = createOrchestratorResumePlan({
    projectControlPlane: plane(),
    branchDeltas: deltas,
    orchestrationState: { consumed_branch_delta_ids: [] },
    observedAt: NOW,
  });
  assert.equal(plan.resume_required, true);
  assert.equal(plan.wake_orchestrator, true);
  assert.deepEqual(plan.resume_packet.actions.map((action) => action.action), [
    "dispatch_continuation",
    "expand_context",
  ]);
  assert.equal(JSON.stringify(plan).includes("specialist log"), false);
  assert.equal(plan.resume_packet.project_goal.goal, "Complete the project.");

  const idempotent = createOrchestratorResumePlan({
    projectControlPlane: plane(),
    branchDeltas: deltas,
    orchestrationState: { consumed_branch_delta_ids: ["BD-1", "BD-2"] },
    observedAt: NOW,
  });
  assert.equal(idempotent.resume_required, false);
  assert.equal(idempotent.resume_packet, null);
});

test("control plane continuity detects lost goals, decisions, and unresolved issues", () => {
  const before = plane();
  const preserved = verifyControlPlaneContinuity(before, JSON.parse(JSON.stringify(before)));
  assert.equal(preserved.preserved, true);
  const broken = verifyControlPlaneContinuity(before, {
    ...before,
    decision_ledger: [],
    risk_and_approval: {},
  });
  assert.equal(broken.preserved, false);
  assert.ok(broken.missing.some((entry) => entry.startsWith("decision:")));
  assert.ok(broken.missing.includes("risk_and_approval"));
});
