"use strict";

const crypto = require("node:crypto");

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${field} must be an object`);
  return clone(value);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function branchDeltaId(content) {
  return `BD-${crypto.createHash("sha256").update(canonical(content)).digest("hex").slice(0, 16)}`;
}

function timestamp(value, field) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new TypeError(`${field} must be an ISO timestamp`);
  return new Date(value).toISOString();
}

function acceptanceState(receipt, pack) {
  const results = Array.isArray(receipt.acceptance_results) ? receipt.acceptance_results : [];
  if (receipt.incorrect_project_facts > 0 || receipt.user_corrections > 0) {
    return {
      state: "correction_required",
      attention: "blocker",
      action: "review_correction",
      summary: "The execution used incorrect project facts or required user correction.",
    };
  }
  if (Array.isArray(receipt.missing_context) && receipt.missing_context.length) {
    return {
      state: "needs_context",
      attention: "blocker",
      action: "request_context_expansion",
      summary: "The bounded context was insufficient and needs explicit expansion.",
    };
  }
  if (results.some(({ status }) => status === "failed")) {
    return {
      state: "correction_required",
      attention: "blocker",
      action: "schedule_correction",
      summary: "At least one acceptance criterion failed.",
    };
  }
  const expectedCriteria = [...new Set((Array.isArray(pack.coverage_matrix) ? pack.coverage_matrix : [])
    .map((entry) => entry?.criterion_id)
    .filter((criterionId) => typeof criterionId === "string" && criterionId.trim()))];
  const observedCriteria = results
    .map((entry) => entry?.criterion_id)
    .filter((criterionId) => typeof criterionId === "string" && criterionId.trim());
  const observedSet = new Set(observedCriteria);
  const duplicateCriterion = observedSet.size !== observedCriteria.length;
  const unknownCriterion = expectedCriteria.length > 0
    && observedCriteria.some((criterionId) => !expectedCriteria.includes(criterionId));
  const missingCriterion = expectedCriteria.some((criterionId) => !observedSet.has(criterionId));
  if (!results.length
    || results.some(({ status }) => status !== "passed")
    || duplicateCriterion
    || unknownCriterion
    || missingCriterion) {
    return {
      state: "verification_incomplete",
      attention: "none",
      action: "continue_verification",
      summary: "Acceptance evidence is incomplete or does not match the Context Pack criteria.",
    };
  }
  return null;
}

function successfulState(envelope, terminalOutcomeCompleted) {
  if (terminalOutcomeCompleted) {
    return {
      state: "terminal_accepted",
      attention: "terminal",
      action: "complete_workstream",
      summary: "The terminal outcome is accepted.",
    };
  }
  if (envelope.continue_policy === "continue_until_terminal") {
    return {
      state: "continuation_ready",
      attention: "none",
      action: "schedule_continuation",
      summary: "The local deliverable passed and the parent workstream should continue.",
    };
  }
  if (envelope.continue_policy === "await_user") {
    return {
      state: "waiting_for_user",
      attention: "user_action",
      action: "request_user_input",
      summary: "The local deliverable passed and the task is waiting for the user.",
    };
  }
  return {
    state: "local_accepted",
    attention: "none",
    action: "accept_local_result",
    summary: "The bounded local deliverable is accepted.",
  };
}

function reconcileContextReceiptV2({
  projectControlPlane,
  taskEnvelope,
  contextPack,
  contextReceipt,
  terminalOutcomeCompleted = false,
  priorBranchDeltaIds = [],
  observedAt,
} = {}) {
  const controlPlane = object(projectControlPlane, "projectControlPlane");
  const envelope = object(taskEnvelope, "taskEnvelope");
  const pack = object(contextPack, "contextPack");
  const receipt = object(contextReceipt, "contextReceipt");
  const time = timestamp(observedAt || receipt.created_at, "observedAt");
  if (receipt.context_pack_id !== pack.context_pack_id
    || receipt.task_intent_id !== pack.task_intent_id
    || pack.task_intent_id !== envelope.task_intent_id
    || pack.task_envelope_id !== envelope.task_envelope_id) {
    throw new Error("context_receipt_binding_mismatch");
  }
  const decision = acceptanceState(receipt, pack) || successfulState(envelope, terminalOutcomeCompleted);
  const active = controlPlane.active_workstream;
  const content = {
    version: 2,
    project_id: controlPlane.project_id,
    workstream_id: envelope.workstream_id,
    task_intent_id: envelope.task_intent_id,
    task_envelope_id: envelope.task_envelope_id,
    context_pack_id: pack.context_pack_id,
    receipt_id: receipt.receipt_id,
    transition: decision.state,
    attention: decision.attention,
    orchestrator_action: decision.action,
    summary: decision.summary,
    acceptance: {
      passed: decision.state === "local_accepted"
        || decision.state === "continuation_ready"
        || decision.state === "terminal_accepted"
        || decision.state === "waiting_for_user",
      results: clone(receipt.acceptance_results || []),
    },
    context_observation: {
      initial_token_estimate: receipt.initial_token_estimate,
      additional_tokens: receipt.additional_tokens,
      compaction_count: receipt.compaction_count,
      missing_context: clone(receipt.missing_context || []),
      user_corrections: receipt.user_corrections,
      incorrect_project_facts: receipt.incorrect_project_facts,
    },
    observed_at: time,
  };
  const delta = { ...content, branch_delta_id: branchDeltaId(content) };
  const duplicate = new Set(priorBranchDeltaIds).has(delta.branch_delta_id);
  const nextControlPlane = clone(controlPlane);
  if (!duplicate) {
    nextControlPlane.revision = Number.isInteger(nextControlPlane.revision) ? nextControlPlane.revision + 1 : 1;
    nextControlPlane.updated_at = time;
    if (nextControlPlane.active_workstream?.workstream_id === envelope.workstream_id) {
      nextControlPlane.active_workstream.next_decision = decision.action;
      nextControlPlane.active_workstream.current_goal = terminalOutcomeCompleted
        ? "Terminal outcome accepted."
        : envelope.terminal_outcome;
    } else if (Array.isArray(nextControlPlane.background_workstreams)) {
      nextControlPlane.background_workstreams = nextControlPlane.background_workstreams.map((workstream) => (
        workstream.workstream_id === envelope.workstream_id
          ? {
              ...workstream,
              state: decision.state,
              summary: terminalOutcomeCompleted
                ? "Terminal outcome accepted."
                : decision.summary,
            }
          : workstream
      ));
    }
  }
  const notifyOn = new Set(envelope.notification_policy?.notify_on || []);
  const userNotification = decision.attention !== "none" && notifyOn.has(decision.attention);
  return Object.freeze({
    branch_delta: Object.freeze(delta),
    project_control_plane: Object.freeze(nextControlPlane),
    duplicate,
    notification: Object.freeze({
      wake_orchestrator: !duplicate && ["blocker", "user_action", "terminal"].includes(decision.attention),
      notify_user: !duplicate && userNotification,
      attention: decision.attention,
      reason: decision.action,
    }),
  });
}

module.exports = { reconcileContextReceiptV2 };
