"use strict";

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim()))].sort();
}

function actionForDelta(delta) {
  const action = delta.orchestrator_action;
  if (action === "request_context_expansion") return "expand_context";
  if (action === "schedule_correction" || action === "review_correction") return "schedule_correction";
  if (action === "request_user_input") return "queue_user_task";
  if (action === "schedule_continuation") return "dispatch_continuation";
  if (action === "accept_terminal_result") return "close_parent_goal";
  if (action === "verify_local_result") return "schedule_verification";
  return "record_result";
}

function createOrchestratorResumePlan({
  projectControlPlane,
  branchDeltas = [],
  orchestrationState = {},
  observedAt,
  maxReceipts = 25,
} = {}) {
  if (!projectControlPlane || typeof projectControlPlane !== "object") {
    throw new TypeError("projectControlPlane is required");
  }
  const consumed = new Set(uniqueStrings(orchestrationState.consumed_branch_delta_ids));
  const pending = (Array.isArray(branchDeltas) ? branchDeltas : [])
    .filter((delta) => delta && typeof delta === "object"
      && typeof delta.branch_delta_id === "string"
      && !consumed.has(delta.branch_delta_id))
    .sort((left, right) => (
      String(left.observed_at).localeCompare(String(right.observed_at))
      || left.branch_delta_id.localeCompare(right.branch_delta_id)
    ))
    .slice(0, Math.max(1, Number.isInteger(maxReceipts) ? maxReceipts : 25));
  const actions = pending.map((delta) => ({
    branch_delta_id: delta.branch_delta_id,
    receipt_id: delta.receipt_id,
    workstream_id: delta.workstream_id,
    task_intent_id: delta.task_intent_id,
    action: actionForDelta(delta),
    transition: delta.transition,
    attention: delta.attention,
    summary: delta.summary,
    evidence_refs: [delta.receipt_id, delta.branch_delta_id],
  }));
  const wakeReasons = uniqueStrings(actions
    .filter((action) => ["blocker", "user_action", "terminal"].includes(action.attention))
    .map((action) => `${action.attention}:${action.action}`));
  const processedIds = actions.map((action) => action.branch_delta_id);
  const nextState = {
    version: 2,
    project_id: projectControlPlane.project_id,
    control_plane_revision: projectControlPlane.revision,
    consumed_branch_delta_ids: uniqueStrings([...consumed, ...processedIds]),
    last_processed_at: observedAt || new Date().toISOString(),
  };
  const resumePacket = actions.length ? {
    version: 2,
    project_id: projectControlPlane.project_id,
    control_plane_revision: projectControlPlane.revision,
    active_workstream: clone(projectControlPlane.active_workstream),
    project_goal: clone(projectControlPlane.project_brief || {}),
    accepted_decisions: clone(projectControlPlane.decision_ledger || []),
    unresolved_issues: clone(projectControlPlane.risk_and_approval || {}),
    actions,
  } : null;
  return Object.freeze({
    version: 2,
    resume_required: actions.length > 0,
    wake_orchestrator: wakeReasons.length > 0,
    wake_reasons: wakeReasons,
    resume_packet: resumePacket,
    next_state: nextState,
  });
}

function verifyControlPlaneContinuity(before, after) {
  const missing = [];
  const beforeGoal = JSON.stringify(before?.project_brief || {});
  const afterGoal = JSON.stringify(after?.project_brief || {});
  if (beforeGoal !== afterGoal) missing.push("project_brief");
  const beforeIntent = JSON.stringify(before?.user_intent || {});
  const afterIntent = JSON.stringify(after?.user_intent || {});
  if (beforeIntent !== afterIntent) missing.push("user_intent");
  const beforeDecisions = new Set((Array.isArray(before?.decision_ledger) ? before.decision_ledger : [])
    .map((entry) => JSON.stringify(entry)));
  const afterDecisions = new Set((Array.isArray(after?.decision_ledger) ? after.decision_ledger : [])
    .map((entry) => JSON.stringify(entry)));
  for (const decision of beforeDecisions) {
    if (!afterDecisions.has(decision)) missing.push(`decision:${decision}`);
  }
  const beforeRisk = JSON.stringify(before?.risk_and_approval || {});
  const afterRisk = JSON.stringify(after?.risk_and_approval || {});
  if (beforeRisk !== afterRisk) missing.push("risk_and_approval");
  return Object.freeze({
    preserved: missing.length === 0,
    missing: uniqueStrings(missing),
  });
}

module.exports = { createOrchestratorResumePlan, verifyControlPlaneContinuity };
