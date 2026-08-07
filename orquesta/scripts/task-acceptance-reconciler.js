#!/usr/bin/env node

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { reconcileProducedReportsAtomic } = require("./capacity-gate");
const {
  extractCompletionEnvelope,
  validateCompletionEnvelope,
} = require("./completion-envelope-check");
const { reviewTaskControl, runControlAudit } = require("./control-audit");
const { checkDelegationGate, checkTask } = require("./delegation-gate-check");
const { buildAudit } = require("./foundation-trigger-audit");
const {
  ingestReportQuestionCandidates,
  inspectReportQuestionCandidates,
} = require("./report-question-candidates-check");
const {
  appendJsonlAtomic,
  readJsonFile,
  updateJsonAtomic,
  writeJsonAtomic,
  writeTextAtomic,
} = require("./json-state");
const { buildCurrentOrchestra } = require("./current-orchestra");
const { runPlacementCompletionHook } = require("./placement-resolver");
const { persistUserSupportWakeRequest } = require("./user-support-wake");

function reconciliationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isoTimestamp(value, field) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw reconciliationError("TASK_ACCEPTANCE_INVALID", `${field} must be an ISO timestamp.`);
  }
  return value;
}

function nonempty(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw reconciliationError("TASK_ACCEPTANCE_INVALID", `${field} is required.`);
  }
  return value.trim();
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
}

function withoutAcceptanceClaim(task) {
  const { acceptance_claim: ignored, ...rest } = task || {};
  return rest;
}

function sameReceipt(left, right) {
  return left?.thread_id === right?.thread_id && left?.turn_id === right?.turn_id;
}

function sameAcceptanceClaim(left, right) {
  return sameReceipt(left, right)
    && left?.receipt_sha256 === right?.receipt_sha256
    && left?.report_sha256 === right?.report_sha256
    && left?.review_sha256 === right?.review_sha256
    && left?.task_snapshot_sha256 === right?.task_snapshot_sha256;
}

function safeRelativePath(rootPath, value, field) {
  const relative = nonempty(value, field).replaceAll("\\", "/");
  const resolved = path.resolve(rootPath, relative);
  const boundary = path.relative(rootPath, resolved);
  if (boundary === ".." || boundary.startsWith(`..${path.sep}`) || path.isAbsolute(boundary)) {
    throw reconciliationError("TASK_ACCEPTANCE_PATH_ESCAPE", `${field} escapes the project root.`);
  }
  return { relative, resolved };
}

function readRequiredJson(filePath, field) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw reconciliationError(
      "TASK_ACCEPTANCE_INVALID",
      `${field} is unreadable: ${error.message}`,
    );
  }
}

function replaceCompletionEnvelope(reportText, envelope) {
  const blockPattern = /```(?:json)?\s*([\s\S]*?)```/gi;
  let replaced = false;
  const next = String(reportText).replace(blockPattern, (block, body) => {
    if (replaced) return block;
    try {
      const parsed = JSON.parse(body);
      if (!parsed || typeof parsed.completion_envelope !== "object") return block;
      replaced = true;
      return `\`\`\`json\n${JSON.stringify({ completion_envelope: envelope }, null, 2)}\n\`\`\``;
    } catch {
      return block;
    }
  });
  if (!replaced) {
    throw reconciliationError(
      "TASK_ACCEPTANCE_REPORT_INVALID",
      "The specialist report has no completion_envelope JSON block.",
    );
  }
  return next;
}

function appendCompletionEnvelope(reportText, envelope) {
  const source = String(reportText).trimEnd();
  return `${source}\n\n## Canonical Completion Envelope\n\n\`\`\`json\n${JSON.stringify({
    completion_envelope: envelope,
  }, null, 2)}\n\`\`\`\n`;
}

function extractSpecialistResult(reportText) {
  const blockPattern = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const match of String(reportText).matchAll(blockPattern)) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed?.specialist_result && typeof parsed.specialist_result === "object") {
        return parsed.specialist_result;
      }
    } catch {
      // Other fenced blocks may not be JSON.
    }
  }
  return null;
}

function canonicalEnvelopeFromSpecialistResult({
  result,
  task,
  receipt,
  evidence,
  createdAt,
}) {
  if (!result || typeof result !== "object") {
    throw reconciliationError(
      "TASK_ACCEPTANCE_REPORT_INVALID",
      "The specialist report has neither completion_envelope nor specialist_result JSON.",
    );
  }
  if (result.task_id !== task.task_id || result.agent_id !== task.owner_agent_id) {
    throw reconciliationError(
      "TASK_ACCEPTANCE_REPORT_INVALID",
      "The specialist_result does not match canonical task ownership.",
    );
  }
  if (result.status !== "completed") {
    throw reconciliationError(
      "TASK_ACCEPTANCE_REPORT_INVALID",
      `The specialist_result ended as ${result.status || "unknown"}.`,
    );
  }
  const validChangeKinds = new Set(["created", "modified", "deleted", "report_only", "state_only"]);
  const changes = Array.isArray(result.changes)
    ? result.changes.map((change) => ({
      path: nonempty(change?.path, "specialist_result.changes[].path"),
      kind: validChangeKinds.has(change?.kind)
        ? change.kind
        : change?.kind === "created_or_modified"
          ? "modified"
          : null,
      summary: nonempty(change?.summary, "specialist_result.changes[].summary"),
    }))
    : [];
  if (!changes.length || changes.some((change) => !change.kind)) {
    throw reconciliationError(
      "TASK_ACCEPTANCE_REPORT_INVALID",
      "specialist_result.changes must contain valid implementation changes.",
    );
  }
  const verification = Array.isArray(result.verification)
    ? result.verification.map((check) => ({
      command: nonempty(check?.command, "specialist_result.verification[].command"),
      status: check?.status,
      expected: nonempty(check?.expected, "specialist_result.verification[].expected"),
      evidence: nonempty(check?.evidence, "specialist_result.verification[].evidence"),
    }))
    : [];
  const reportOnly = changes.every((change) => change.kind === "report_only");
  const noCommandsReason = typeof result.no_commands_reason === "string"
    ? result.no_commands_reason.trim()
    : "";
  if (
    verification.some((check) => check.status !== "passed")
    || (verification.length === 0 && (!reportOnly || !noCommandsReason))
  ) {
    throw reconciliationError(
      "TASK_ACCEPTANCE_REPORT_INVALID",
      "specialist_result.verification requires passed deterministic checks, or report-only changes with no_commands_reason.",
    );
  }
  const risk = task.task_intent?.risk?.impact;
  const riskLevel = ["low", "medium", "high"].includes(risk) ? risk : "medium";
  const filesRead = Array.isArray(result.files_read)
    ? [...new Set(result.files_read.filter((value) => typeof value === "string" && value.trim()))]
    : [];
  const questionCandidates = result.question_candidates;
  if (
    questionCandidates
    && (
      !["none", "submitted"].includes(questionCandidates.status)
    || (
      questionCandidates.status === "none"
      && (!questionCandidates.none_reason || !questionCandidates.none_rationale)
    )
    || (
      questionCandidates.status === "submitted"
      && (!Array.isArray(questionCandidates.items) || questionCandidates.items.length > 3)
    )
    )
  ) {
    throw reconciliationError(
      "TASK_ACCEPTANCE_REPORT_INVALID",
      "When present, specialist_result.question_candidates must be a valid none or submitted record.",
    );
  }
  return {
    version: 1,
    task_id: task.task_id,
    agent_id: task.owner_agent_id,
    status: "submitted",
    risk_level: riskLevel,
    required_reading: {
      status: "done",
      files: filesRead,
      not_read: [],
    },
    delegation_evidence: {
      routing_class: task.routing_class,
      handoff_sent_at: task.handoff_sent_at,
      specialist_report_path: task.specialist_report_path,
      completion_transport: task.handoff_attempts?.[0]?.transport || "manual_recovery",
    },
    model_route: {
      ...(task.model_route || {}),
      ...(receipt.actual_model ? {
        actual_model: receipt.actual_model,
        actual_model_evidence: evidence,
      } : {}),
    },
    changes,
    verification: {
      commands: verification,
      ...(verification.length === 0 ? { no_commands_reason: noCommandsReason } : {}),
      browser: {
        status: "not_required",
        evidence: "No browser verification was required by this specialist result.",
      },
      live_thread: {
        status: "not_required",
        evidence: "Live-thread identity is recorded by the deterministic controller.",
      },
    },
    not_verified: Array.isArray(result.not_verified) ? result.not_verified : [],
    open_risks: Array.isArray(result.open_risks) ? result.open_risks : [],
    fallbacks: [],
    question_candidates_status: questionCandidates?.status || "omitted",
    created_at: Number.isFinite(Date.parse(result.completed_at))
      ? result.completed_at
      : createdAt,
  };
}

function normalizeReview(rootPath, task, review) {
  if (!review || typeof review !== "object") {
    throw reconciliationError("TASK_ACCEPTANCE_INVALID", "review is required.");
  }
  if (review.task_id !== task.task_id) {
    throw reconciliationError("TASK_ACCEPTANCE_INVALID", "review.task_id does not match the task.");
  }
  const owner = nonempty(review.review_owner_agent_id, "review.review_owner_agent_id");
  if (owner === task.owner_agent_id) {
    throw reconciliationError(
      "TASK_ACCEPTANCE_NOT_INDEPENDENT",
      "The review owner must differ from the implementation owner.",
    );
  }
  if (review.status !== "accepted") {
    throw reconciliationError(
      "TASK_ACCEPTANCE_REJECTED",
      `The independent review ended as ${review.status || "unknown"}.`,
    );
  }
  const findings = review.findings || {};
  for (const key of ["critical", "important", "minor"]) {
    if (!Number.isInteger(findings[key]) || findings[key] < 0) {
      throw reconciliationError("TASK_ACCEPTANCE_INVALID", `review.findings.${key} is invalid.`);
    }
  }
  if (findings.critical !== 0 || findings.important !== 0) {
    throw reconciliationError(
      "TASK_ACCEPTANCE_REJECTED",
      "Critical or Important review findings require a correction cycle.",
    );
  }
  const evidenceRefs = Array.isArray(review.evidence_refs)
    ? [...new Set(review.evidence_refs.map((value) => nonempty(value, "review.evidence_refs[]")))]
    : [];
  if (!evidenceRefs.includes(task.specialist_report_path)) {
    throw reconciliationError(
      "TASK_ACCEPTANCE_INVALID",
      "review.evidence_refs must include the specialist report.",
    );
  }
  for (const ref of evidenceRefs) {
    const evidence = safeRelativePath(rootPath, ref, "review.evidence_refs[]");
    if (!fs.existsSync(evidence.resolved)) {
      throw reconciliationError(
        "TASK_ACCEPTANCE_EVIDENCE_MISSING",
        `Review evidence is missing: ${evidence.relative}`,
      );
    }
  }
  const completionEvidence = Array.isArray(review.completion_evidence)
    ? review.completion_evidence.map((item) => ({
      kind: nonempty(item?.kind, "review.completion_evidence[].kind"),
      ref: nonempty(item?.ref, "review.completion_evidence[].ref"),
      status: item?.status,
    }))
    : [];
  if (
    completionEvidence.length === 0
    || completionEvidence.some((item) => item.status !== "passed")
    || !completionEvidence.some((item) => item.kind === "implementation")
  ) {
    throw reconciliationError(
      "TASK_ACCEPTANCE_INVALID",
      "review.completion_evidence must contain passed implementation evidence.",
    );
  }
  if (!completionEvidence.some((item) => (
    item.kind === "implementation" && evidenceRefs.includes(item.ref)
  ))) {
    throw reconciliationError(
      "TASK_ACCEPTANCE_INVALID",
      "Passed implementation completion evidence must be bound to review.evidence_refs.",
    );
  }
  const reviewPath = safeRelativePath(
    rootPath,
    review.review_path || `.orquesta/reviews/${task.task_id}-${owner}.json`,
    "review.review_path",
  );
  if (!fs.existsSync(reviewPath.resolved)) {
    throw reconciliationError(
      "TASK_ACCEPTANCE_EVIDENCE_MISSING",
      `The durable review verdict is missing: ${reviewPath.relative}`,
    );
  }
  const durableReview = readRequiredJson(reviewPath.resolved, "durable review verdict");
  if (stableJson(durableReview) !== stableJson(review)) {
    throw reconciliationError(
      "TASK_ACCEPTANCE_REVIEW_MISMATCH",
      "The supplied review does not match the durable review verdict.",
    );
  }
  return {
    ...review,
    review_owner_agent_id: owner,
    reviewed_at: isoTimestamp(review.reviewed_at, "review.reviewed_at"),
    findings: {
      critical: findings.critical,
      important: findings.important,
      minor: findings.minor,
    },
    evidence_refs: evidenceRefs,
    completion_evidence: completionEvidence,
    review_path: reviewPath.relative,
    summary: nonempty(review.summary, "review.summary"),
  };
}

function normalizeReceipt(task, receipt) {
  if (!receipt || typeof receipt !== "object") {
    throw reconciliationError("TASK_ACCEPTANCE_INVALID", "receipt is required.");
  }
  if (receipt.task_id !== task.task_id || receipt.agent_id !== task.owner_agent_id) {
    throw reconciliationError(
      "TASK_ACCEPTANCE_INVALID",
      "The specialist receipt does not match the task owner.",
    );
  }
  if (receipt.status !== "completed") {
    throw reconciliationError(
      "TASK_ACCEPTANCE_INCOMPLETE",
      `The specialist receipt ended as ${receipt.status || "unknown"}.`,
    );
  }
  if (receipt.report_path !== task.specialist_report_path) {
    throw reconciliationError(
      "TASK_ACCEPTANCE_INVALID",
      "The specialist receipt report path does not match canonical task state.",
    );
  }
  return {
    agent_id: receipt.agent_id,
    task_id: receipt.task_id,
    thread_id: nonempty(receipt.thread_id, "receipt.thread_id"),
    turn_id: nonempty(receipt.turn_id, "receipt.turn_id"),
    status: receipt.status,
    report_path: receipt.report_path,
    actual_model: receipt.actual_model || null,
    initial_turn_id: receipt.initial_turn_id || null,
    correction_turn_id: receipt.correction_turn_id || null,
  };
}

function prepareReportModelEvidence({
  reportPath,
  task,
  receipt,
  evidence,
  createdAt,
}) {
  const text = fs.readFileSync(reportPath, "utf8");
  const initialEnvelope = extractCompletionEnvelope(text);
  const specialistResult = initialEnvelope ? null : extractSpecialistResult(text);
  const baseEnvelope = initialEnvelope || canonicalEnvelopeFromSpecialistResult({
    result: specialistResult,
    task,
    receipt,
    evidence,
    createdAt,
  });
  if (
    baseEnvelope.task_id !== task.task_id
    || baseEnvelope.agent_id !== task.owner_agent_id
  ) {
    throw reconciliationError(
      "TASK_ACCEPTANCE_REPORT_INVALID",
      "The specialist report completion evidence does not match canonical task ownership.",
    );
  }
  const envelope = {
    ...baseEnvelope,
    delegation_evidence: {
      ...(baseEnvelope.delegation_evidence || {}),
      routing_class: task.routing_class,
      handoff_sent_at: task.handoff_sent_at,
      specialist_report_path: task.specialist_report_path,
      completion_transport: baseEnvelope.delegation_evidence?.completion_transport
        || task.handoff_attempts?.[0]?.transport
        || "manual_recovery",
    },
    model_route: {
      ...(baseEnvelope.model_route || {}),
      ...(receipt.actual_model ? {
        actual_model: receipt.actual_model,
        actual_model_evidence: evidence,
      } : {}),
    },
  };
  return {
    envelope,
    reportText: initialEnvelope
      ? replaceCompletionEnvelope(text, envelope)
      : appendCompletionEnvelope(text, envelope),
  };
}

function buildAcceptedTask({
  current,
  receipt,
  review,
  now,
  actualModelEvidence,
  implementationEvidenceRefs,
}) {
  const currentWithoutClaim = withoutAcceptanceClaim(current);
  let implementationCycle = (current.execution_cycles || []).find((cycle) => (
    cycle?.kind === "implementation"
    && cycle.owner_agent_id === current.owner_agent_id
    && cycle.status === "completed"
  ));
  if (!implementationCycle) {
    implementationCycle = {
      cycle_id: "implementation-1",
      kind: "implementation",
      owner_agent_id: current.owner_agent_id,
      status: "completed",
      evidence_refs: implementationEvidenceRefs,
    };
  }
  const cycleId = review.cycle_id || "review-1";
  const attempts = [...(current.handoff_attempts || [])];
  if (!attempts.some((attempt) => attempt.cycle_id === implementationCycle.cycle_id)) {
    attempts.unshift({
      cycle_id: implementationCycle.cycle_id,
      owner_agent_id: current.owner_agent_id,
      sent_at: current.handoff_sent_at,
      transport: "app_server",
      evidence: `${receipt.thread_id}:${receipt.turn_id}`,
    });
  }
  if (!attempts.some((attempt) => attempt.cycle_id === cycleId)) {
    attempts.push({
      cycle_id: cycleId,
      owner_agent_id: review.review_owner_agent_id,
      sent_at: review.reviewed_at,
      transport: review.transport || "deterministic_reconciler",
      evidence: review.review_path,
    });
  }
  const cycles = [...(current.execution_cycles || [])];
  if (!cycles.some((cycle) => cycle.cycle_id === implementationCycle.cycle_id)) {
    cycles.unshift(implementationCycle);
  }
  if (receipt.correction_turn_id && !cycles.some((cycle) => cycle.cycle_id === "correction-1")) {
    cycles.push({
      cycle_id: "correction-1",
      kind: "correction",
      owner_agent_id: current.owner_agent_id,
      status: "completed",
      evidence_refs: implementationEvidenceRefs,
    });
  }
  if (!cycles.some((cycle) => cycle.cycle_id === cycleId)) {
    cycles.push({
      cycle_id: cycleId,
      kind: "review",
      owner_agent_id: review.review_owner_agent_id,
      status: "accepted",
      findings: review.findings,
      evidence_refs: review.evidence_refs,
    });
  }
  const metrics = {
    ...(current.execution_metrics || {}),
    wall_time_ms: current.execution_metrics?.wall_time_ms || 0,
    agent_turns: current.execution_metrics?.agent_turns || 1,
    handoffs: attempts.length,
    independent_reviews: cycles.filter((cycle) => cycle?.kind === "review").length,
    correction_batches: cycles.filter((cycle) => cycle?.kind === "correction").length,
    reports: cycles.filter((cycle) => (
      ["review", "qa"].includes(cycle?.kind)
      && Array.isArray(cycle.evidence_refs)
      && cycle.evidence_refs.length > 0
    )).length,
    token_usage: current.execution_metrics?.token_usage || {
      coverage: "unknown",
      known_total: null,
      by_thread: [],
    },
  };
  return {
    ...currentWithoutClaim,
    state: "accepted",
    result_summary: review.summary,
    handoff_attempts: attempts,
    execution_cycles: cycles,
    completion_evidence: review.completion_evidence,
    execution_metrics: metrics,
    completion_envelope: {
      status: "submitted",
      path: current.specialist_report_path,
    },
    model_route: {
      ...(current.model_route || {}),
      ...(receipt.actual_model ? {
        status: "observed",
        actual_model: receipt.actual_model,
        actual_model_evidence: actualModelEvidence,
      } : {}),
    },
    specialist_receipt: {
      ...receipt,
      reconciled_once: true,
      reconciled_by: review.review_owner_agent_id,
      reconciled_at: now,
    },
    accepted_at: now,
    accepted_by: review.review_owner_agent_id,
    updated_at: now,
  };
}

function claimTaskAcceptance({
  tasksPath,
  taskId,
  expectedTask,
  receipt,
  review,
  reportText,
  now,
}) {
  const claim = {
    thread_id: receipt.thread_id,
    turn_id: receipt.turn_id,
    receipt_sha256: sha256(stableJson(receipt)),
    report_sha256: sha256(reportText),
    review_sha256: sha256(stableJson(review)),
    task_snapshot_sha256: sha256(stableJson(withoutAcceptanceClaim(expectedTask))),
    claimed_at: now,
  };
  let status = "claimed";
  let claimedTask = null;
  updateJsonAtomic(tasksPath, { version: 1, tasks: [] }, (state) => {
    const tasks = Array.isArray(state.tasks) ? state.tasks : [];
    const index = tasks.findIndex((task) => task.task_id === taskId);
    if (index < 0) {
      throw reconciliationError("TASK_ACCEPTANCE_TASK_MISSING", `Unknown task: ${taskId}`);
    }
    const current = tasks[index];
    if (current.state === "accepted" && current.specialist_receipt?.reconciled_once === true) {
      if (!sameReceipt(current.specialist_receipt, receipt)) {
        throw reconciliationError(
          "TASK_ACCEPTANCE_ALREADY_RECONCILED",
          "The accepted task is bound to a different specialist receipt and cannot be overwritten.",
        );
      }
      status = "already_reconciled";
      claimedTask = current;
      return state;
    }
    if (current.acceptance_claim) {
      if (!sameAcceptanceClaim(current.acceptance_claim, claim)) {
        throw reconciliationError(
          "TASK_ACCEPTANCE_IN_PROGRESS",
          "The task is already reserved by a different acceptance receipt or evidence set.",
        );
      }
      claimedTask = current;
      return state;
    }
    if (sha256(stableJson(current)) !== sha256(stableJson(expectedTask))) {
      throw reconciliationError(
        "TASK_ACCEPTANCE_STATE_CHANGED",
        "Canonical task state changed before the acceptance receipt could be reserved.",
      );
    }
    claimedTask = { ...current, acceptance_claim: claim };
    const nextTasks = [...tasks];
    nextTasks[index] = claimedTask;
    return { ...state, tasks: nextTasks, updated_at: now };
  });
  return { claim, status, task: claimedTask };
}

function updateTaskState({
  tasksPath,
  stateRoot,
  taskId,
  receipt,
  review,
  now,
  actualModelEvidence,
  implementationEvidenceRefs,
  completionEnvelope,
  acceptanceClaim,
}) {
  let updatedTask = null;
  let alreadyReconciled = false;
  updateJsonAtomic(tasksPath, { version: 1, tasks: [] }, (state) => {
    const tasks = Array.isArray(state.tasks) ? state.tasks : [];
    const index = tasks.findIndex((task) => task.task_id === taskId);
    if (index < 0) {
      throw reconciliationError("TASK_ACCEPTANCE_TASK_MISSING", `Unknown task: ${taskId}`);
    }
    const current = tasks[index];
    const existingReceipt = current.specialist_receipt;
    if (
      current.state === "accepted"
      && existingReceipt?.reconciled_once === true
    ) {
      if (!sameReceipt(existingReceipt, receipt)) {
        throw reconciliationError(
          "TASK_ACCEPTANCE_ALREADY_RECONCILED",
          "The accepted task is bound to a different specialist receipt and cannot be overwritten.",
        );
      }
      updatedTask = current;
      alreadyReconciled = true;
      return state;
    }
    if (!sameAcceptanceClaim(current.acceptance_claim, acceptanceClaim)) {
      throw reconciliationError(
        "TASK_ACCEPTANCE_CLAIM_MISMATCH",
        "Canonical task state is not reserved for this acceptance receipt and evidence set.",
      );
    }
    if (
      sha256(stableJson(withoutAcceptanceClaim(current)))
      !== acceptanceClaim.task_snapshot_sha256
    ) {
      throw reconciliationError(
        "TASK_ACCEPTANCE_STATE_CHANGED",
        "Canonical task state changed after the acceptance receipt was reserved.",
      );
    }
    updatedTask = buildAcceptedTask({
      current: withoutAcceptanceClaim(current),
      receipt,
      review,
      now,
      actualModelEvidence,
      implementationEvidenceRefs,
    });
    const targetGate = checkTask(updatedTask, { stateRoot });
    if (targetGate.errors.length) {
      throw reconciliationError("TASK_ACCEPTANCE_GATE_FAILED", targetGate.errors.join("; "));
    }
    const envelopeCheck = validateCompletionEnvelope(completionEnvelope, updatedTask, { stagedIn: true });
    if (envelopeCheck.status !== "valid") {
      throw reconciliationError(
        "TASK_ACCEPTANCE_REPORT_INVALID",
        envelopeCheck.errors.map((item) => item.message).join("; "),
      );
    }
    const nextTasks = [...tasks];
    nextTasks[index] = updatedTask;
    return { ...state, tasks: nextTasks, updated_at: now };
  });
  return { already_reconciled: alreadyReconciled, task: updatedTask };
}

function updateCompletionMap(rootPath, taskId, summary, now) {
  const mapPath = path.join(rootPath, ".orquesta", "project", "completion_map.json");
  if (!fs.existsSync(mapPath)) return;
  updateJsonAtomic(mapPath, { tasks: [] }, (state) => {
    const tasks = (state.tasks || []).map((task) => (
      task.task_id === taskId
        ? { ...task, status: "done", completed_at: now, result_summary: summary }
        : task
    ));
    const terminal = new Set(["done", "completed", "accepted", "skipped", "retired"]);
    const completed = tasks.length > 0 && tasks.every((task) => (
      terminal.has(String(task.status || task.state || "").toLowerCase())
    ));
    return {
      ...state,
      tasks,
      status: completed ? "completed" : state.status,
      updated_at: now,
    };
  });
}

function updateCurrentOrchestra(rootPath, tasksState, now) {
  const orquestaRoot = path.join(rootPath, ".orquesta");
  const setupState = readJsonFile(
    path.join(orquestaRoot, "setup", "setup_state.json"),
    { project_title: "Orquesta project", project_id: "unknown-project" },
  );
  const agentsState = readJsonFile(
    path.join(orquestaRoot, "state", "agents.json"),
    { agents: [] },
  );
  const directivesState = readJsonFile(
    path.join(orquestaRoot, "state", "directives.json"),
    { directives: [] },
  );
  writeTextAtomic(
    path.join(orquestaRoot, "CURRENT_ORCHESTRA.md"),
    buildCurrentOrchestra({
      setupState,
      now,
      status: "ready",
      agentsState,
      tasksState,
      directivesState,
    }),
  );
}

function appendAcceptanceEvents(rootPath, task, receipt, review, now) {
  const eventsPath = path.join(rootPath, ".orquesta", "state", "events.jsonl");
  const events = [
    {
      event_id: `acceptance:${task.task_id}:receipt:${receipt.thread_id}:${receipt.turn_id}`,
      timestamp: now,
      type: "specialist_receipt_reconciled",
      actor: review.review_owner_agent_id,
      task_id: task.task_id,
      agent_id: receipt.agent_id,
      thread_id: receipt.thread_id,
      turn_id: receipt.turn_id,
      report_path: receipt.report_path,
      actual_model: receipt.actual_model,
      summary: "The specialist receipt was reconciled once by the deterministic acceptance controller.",
    },
    {
      event_id: `acceptance:${task.task_id}:review:${review.cycle_id || "review-1"}`,
      timestamp: now,
      type: "independent_review_accepted",
      actor: review.review_owner_agent_id,
      task_id: task.task_id,
      cycle_id: review.cycle_id || "review-1",
      findings: review.findings,
      evidence_refs: review.evidence_refs,
      summary: review.summary,
    },
    {
      event_id: `acceptance:${task.task_id}:accepted`,
      timestamp: now,
      type: "task_accepted",
      actor: review.review_owner_agent_id,
      task_id: task.task_id,
      summary: review.summary,
    },
  ];
  for (const event of events) appendJsonlAtomic(eventsPath, event);
}

function refreshUserSupportTrigger(root, acceptedAt) {
  const triggerAudit = buildAudit(root, new Date(acceptedAt));
  writeJsonAtomic(
    path.join(root, ".orquesta", "state", "trigger_audit.json"),
    triggerAudit,
  );
  const supportWake = persistUserSupportWakeRequest(root, triggerAudit, acceptedAt);
  return { trigger_audit: triggerAudit, support_wake: supportWake };
}

function capturePostAcceptanceError(errors, code, operation, fallback = null) {
  try {
    return operation();
  } catch (error) {
    errors.push({
      code,
      message: error?.message || String(error),
    });
    return fallback;
  }
}

function acceptedReviewSnapshot(task) {
  const reviewCycle = [...(task.execution_cycles || [])].reverse().find((cycle) => (
    cycle?.kind === "review" && cycle.status === "accepted"
  ));
  return {
    review_owner_agent_id: task.accepted_by || reviewCycle?.owner_agent_id || "acceptance-controller",
    cycle_id: reviewCycle?.cycle_id || "review-1",
    findings: reviewCycle?.findings || { critical: 0, important: 0, minor: 0 },
    evidence_refs: reviewCycle?.evidence_refs || [],
    summary: task.result_summary || "Task acceptance was reconciled.",
  };
}

function reconcileAcceptanceProjections({
  root,
  task,
  receipt,
  review,
  reportPath,
  envelope,
  questionInspection,
  now,
  priorErrors = [],
}) {
  const postAcceptanceErrors = [...priorErrors];
  let questionCandidateIntake = {
    status: "unavailable",
    recorded_count: 0,
    skipped_duplicate_count: 0,
  };
  if (!reportPath || !fs.existsSync(reportPath)) {
    postAcceptanceErrors.push({
      code: "post_acceptance_report_unavailable",
      message: "The accepted task report is unavailable for projection reconciliation.",
    });
  } else if (questionInspection?.errors?.length) {
    questionCandidateIntake = {
      present: questionInspection.present,
      status: questionInspection.status,
      item_count: questionInspection.itemCount,
      recorded_count: 0,
      skipped_duplicate_count: 0,
      errors: questionInspection.errors,
      warnings: questionInspection.warnings,
      candidates: [],
    };
    postAcceptanceErrors.push({
      code: "post_acceptance_question_intake_invalid",
      message: questionInspection.errors.join("; "),
    });
  } else {
    questionCandidateIntake = capturePostAcceptanceError(
      postAcceptanceErrors,
      "post_acceptance_question_intake_unavailable",
      () => ingestReportQuestionCandidates(root, reportPath, now, questionInspection),
      questionCandidateIntake,
    );
  }
  capturePostAcceptanceError(
    postAcceptanceErrors,
    "post_acceptance_completion_map_unavailable",
    () => updateCompletionMap(root, task.task_id, review.summary, now),
  );
  if (!envelope) {
    postAcceptanceErrors.push({
      code: "post_acceptance_envelope_unavailable",
      message: "The accepted task completion envelope is unavailable for capacity reconciliation.",
    });
  } else {
    capturePostAcceptanceError(
      postAcceptanceErrors,
      "post_acceptance_placement_projection_unavailable",
      () => runPlacementCompletionHook({
        rootPath: root,
        taskId: task.task_id,
        changedPaths: (envelope.changes || [])
          .filter((change) => !["report_only", "state_only"].includes(change?.kind))
          .map((change) => change.path),
        checkedAt: now,
        persist: true,
      }),
    );
    capturePostAcceptanceError(
      postAcceptanceErrors,
      "post_acceptance_capacity_reconciliation_unavailable",
      () => reconcileProducedReportsAtomic(
        path.join(root, ".orquesta", "state", "capacity.json"),
        [{
          task_id: task.task_id,
          agent_id: receipt.agent_id,
          thread_id: receipt.thread_id,
          dispatch_id: `DISPATCH-${task.task_id}-1`,
          report_path: receipt.report_path,
          report_produced_at: envelope.created_at,
          dispatch_accepted_at: task.handoff_sent_at,
          adapter_id: task.model_route?.adapter || "repository_only",
          idempotency_key: `${task.task_id}:${receipt.turn_id}`,
        }],
        { now },
      ),
    );
  }
  capturePostAcceptanceError(
    postAcceptanceErrors,
    "post_acceptance_events_unavailable",
    () => appendAcceptanceEvents(root, task, receipt, review, now),
  );
  return { question_candidate_intake: questionCandidateIntake, post_acceptance_errors: postAcceptanceErrors };
}

function finalizeAcceptanceAudit(root, acceptedAt, priorErrors = []) {
  const tasksPath = path.join(root, ".orquesta", "state", "tasks.json");
  const postAcceptanceErrors = [...priorErrors];
  try {
    const finalTasksState = readJsonFile(tasksPath, { version: 1, tasks: [] });
    updateCurrentOrchestra(root, finalTasksState, acceptedAt);
  } catch (error) {
    postAcceptanceErrors.push({
      code: "post_acceptance_current_orchestra_unavailable",
      message: error?.message || String(error),
    });
  }
  let supportTrigger = { trigger_audit: null, support_wake: null };
  try {
    supportTrigger = refreshUserSupportTrigger(root, acceptedAt);
  } catch (error) {
    postAcceptanceErrors.push({
      code: "post_acceptance_support_refresh_unavailable",
      message: error?.message || String(error),
    });
  }
  let delegationGate;
  try {
    delegationGate = checkDelegationGate(root);
  } catch (error) {
    delegationGate = {
      errors: [`post-acceptance delegation audit unavailable: ${error?.message || String(error)}`],
      warnings: [],
    };
  }
  let control;
  try {
    control = runControlAudit({ root, now: acceptedAt });
  } catch (error) {
    control = {
      audit: {
        status: "blockers",
        findings: [{
          severity: "blocker",
          category: "control_audit",
          code: "post_acceptance_control_audit_unavailable",
          message: error?.message || String(error),
          created_at: acceptedAt,
        }],
      },
    };
  }
  if (postAcceptanceErrors.length) {
    delegationGate.errors.push(...postAcceptanceErrors.map((item) => (
      `${item.code}: ${item.message}`
    )));
    control.audit = {
      ...control.audit,
      status: "blockers",
      findings: [
        ...(control.audit?.findings || []),
        ...postAcceptanceErrors.map((item) => ({
          severity: "blocker",
          category: "control_audit",
          code: item.code,
          message: item.message,
          created_at: acceptedAt,
        })),
      ],
    };
  }
  return {
    ...supportTrigger,
    control_audit: control.audit,
    delegation_gate: delegationGate,
    post_acceptance_errors: postAcceptanceErrors,
  };
}

function reconcileTaskAcceptanceAtomic({
  rootPath,
  taskId,
  receipt,
  review,
  now = new Date().toISOString(),
  deferGlobalAudit = false,
}) {
  const root = path.resolve(rootPath);
  const tasksPath = path.join(root, ".orquesta", "state", "tasks.json");
  const tasksState = readRequiredJson(tasksPath, "canonical task state");
  const task = (tasksState.tasks || []).find((item) => item.task_id === taskId);
  if (!task) {
    throw reconciliationError("TASK_ACCEPTANCE_TASK_MISSING", `Unknown task: ${taskId}`);
  }
  const normalizedReceipt = normalizeReceipt(task, receipt);
  const requestedAt = isoTimestamp(now, "now");
  const acceptedAt = task.acceptance_claim && sameReceipt(task.acceptance_claim, normalizedReceipt)
    ? isoTimestamp(task.acceptance_claim.claimed_at, "task.acceptance_claim.claimed_at")
    : requestedAt;
  if (task.state === "accepted" && task.specialist_receipt?.reconciled_once === true) {
    if (
      task.specialist_receipt.thread_id !== normalizedReceipt.thread_id
      || task.specialist_receipt.turn_id !== normalizedReceipt.turn_id
    ) {
      throw reconciliationError(
        "TASK_ACCEPTANCE_ALREADY_RECONCILED",
        "The accepted task is bound to a different specialist receipt and cannot be overwritten.",
      );
    }
    const projectionErrors = [];
    const report = capturePostAcceptanceError(
      projectionErrors,
      "post_acceptance_report_path_invalid",
      () => safeRelativePath(root, task.specialist_report_path, "task.specialist_report_path"),
    );
    const questionInspection = report && fs.existsSync(report.resolved)
      ? capturePostAcceptanceError(
        projectionErrors,
        "post_acceptance_question_inspection_unavailable",
        () => inspectReportQuestionCandidates(report.resolved),
      )
      : null;
    const completionEnvelope = report && fs.existsSync(report.resolved)
      ? capturePostAcceptanceError(
        projectionErrors,
        "post_acceptance_envelope_unavailable",
        () => extractCompletionEnvelope(fs.readFileSync(report.resolved, "utf8")),
      )
      : null;
    const projections = reconcileAcceptanceProjections({
      root,
      task,
      receipt: task.specialist_receipt,
      review: acceptedReviewSnapshot(task),
      reportPath: report?.resolved || null,
      envelope: completionEnvelope,
      questionInspection,
      now: acceptedAt,
      priorErrors: projectionErrors,
    });
    const finalAudit = deferGlobalAudit
      ? {
        trigger_audit: null,
        support_wake: null,
        control_audit: null,
        delegation_gate: null,
        post_acceptance_errors: projections.post_acceptance_errors,
      }
      : finalizeAcceptanceAudit(root, acceptedAt, projections.post_acceptance_errors);
    return {
      status: "already_reconciled",
      task,
      question_candidate_intake: projections.question_candidate_intake,
      ...finalAudit,
      placement_review: null,
    };
  }
  const normalizedReview = normalizeReview(root, task, review);
  const report = safeRelativePath(root, task.specialist_report_path, "task.specialist_report_path");
  if (!fs.existsSync(report.resolved)) {
    throw reconciliationError(
      "TASK_ACCEPTANCE_EVIDENCE_MISSING",
      `The specialist report is missing: ${report.relative}`,
    );
  }
  const actualModelEvidence = normalizedReceipt.actual_model
    ? `specialist receipt for thread ${normalizedReceipt.thread_id} turn ${normalizedReceipt.turn_id}`
    : null;
  const questionCandidateInspection = inspectReportQuestionCandidates(report.resolved);
  if (questionCandidateInspection.errors.length) {
    throw reconciliationError(
      "TASK_ACCEPTANCE_REPORT_INVALID",
      `The specialist report has invalid question_candidates metadata: ${questionCandidateInspection.errors.join("; ")}`,
    );
  }
  const preparedReport = prepareReportModelEvidence({
    reportPath: report.resolved,
    task,
    receipt: normalizedReceipt,
    evidence: actualModelEvidence,
    createdAt: acceptedAt,
  });
  const envelope = preparedReport.envelope;
  for (const [index, change] of (envelope.changes || []).entries()) {
    if (!["report_only", "state_only"].includes(change?.kind)) {
      safeRelativePath(root, change?.path, `completion_envelope.changes[${index}].path`);
    }
  }
  const placementReview = runPlacementCompletionHook({
    rootPath: root,
    taskId,
    changedPaths: (envelope.changes || [])
      .filter((change) => !["report_only", "state_only"].includes(change?.kind))
      .map((change) => change.path),
    checkedAt: acceptedAt,
    persist: false,
  });
  if (placementReview.status === "blocked") {
    throw reconciliationError(
      "TASK_ACCEPTANCE_PLACEMENT_BLOCKED",
      placementReview.hard_errors.map((item) => item.message).join("; "),
    );
  }
  const implementationEvidenceRefs = [
    ...new Set([
      ...(envelope.changes || [])
        .filter((change) => !["report_only", "state_only"].includes(change?.kind))
        .map((change) => change.path)
        .filter((value) => typeof value === "string" && value.trim()),
      normalizedReceipt.report_path,
    ]),
  ];
  if (implementationEvidenceRefs.length < 2) {
    const reviewImplementation = normalizedReview.completion_evidence.find(
      (item) => item.kind === "implementation",
    );
    if (reviewImplementation) implementationEvidenceRefs.unshift(reviewImplementation.ref);
  }
  const prospectiveTask = buildAcceptedTask({
    current: task,
    receipt: normalizedReceipt,
    review: normalizedReview,
    now: acceptedAt,
    actualModelEvidence,
    implementationEvidenceRefs,
  });
  const prospectiveGate = checkTask(prospectiveTask, { stateRoot: root });
  if (prospectiveGate.errors.length) {
    throw reconciliationError("TASK_ACCEPTANCE_GATE_FAILED", prospectiveGate.errors.join("; "));
  }
  const prospectiveEnvelope = validateCompletionEnvelope(envelope, prospectiveTask, { stagedIn: true });
  if (prospectiveEnvelope.status !== "valid") {
    throw reconciliationError(
      "TASK_ACCEPTANCE_REPORT_INVALID",
      prospectiveEnvelope.errors.map((item) => item.message).join("; "),
    );
  }
  const prospectiveControl = reviewTaskControl({
    root,
    task: prospectiveTask,
    reportPath: report.relative,
    completionEnvelope: envelope,
    now: acceptedAt,
  });
  const targetBlockers = prospectiveControl.blockers.filter((finding) => (
    finding.code !== "missing_capacity_dispatch"
  ));
  if (targetBlockers.length) {
    throw reconciliationError(
      "TASK_ACCEPTANCE_CONTROL_FAILED",
      targetBlockers.map((finding) => finding.message || finding.code).join("; "),
    );
  }
  const acceptanceClaim = claimTaskAcceptance({
    tasksPath,
    taskId,
    expectedTask: task,
    receipt: normalizedReceipt,
    review: normalizedReview,
    reportText: preparedReport.reportText,
    now: acceptedAt,
  });
  if (acceptanceClaim.status === "already_reconciled") {
    return reconcileTaskAcceptanceAtomic({
      rootPath: root,
      taskId,
      receipt,
      review,
      now: acceptedAt,
      deferGlobalAudit,
    });
  }
  writeTextAtomic(report.resolved, preparedReport.reportText);
  const taskUpdate = updateTaskState({
    tasksPath,
    stateRoot: root,
    taskId,
    receipt: normalizedReceipt,
    review: normalizedReview,
    now: acceptedAt,
    actualModelEvidence,
    implementationEvidenceRefs,
    completionEnvelope: envelope,
    acceptanceClaim: acceptanceClaim.claim,
  });
  if (taskUpdate.already_reconciled) {
    return reconcileTaskAcceptanceAtomic({
      rootPath: root,
      taskId,
      receipt,
      review,
      now: acceptedAt,
      deferGlobalAudit,
    });
  }
  const updatedTask = taskUpdate.task;
  const projections = reconcileAcceptanceProjections({
    root,
    task: updatedTask,
    receipt: normalizedReceipt,
    review: normalizedReview,
    reportPath: report.resolved,
    envelope,
    questionInspection: questionCandidateInspection,
    now: acceptedAt,
  });
  const finalAudit = deferGlobalAudit
    ? {
      trigger_audit: null,
      support_wake: null,
      control_audit: null,
      delegation_gate: null,
      post_acceptance_errors: projections.post_acceptance_errors,
    }
    : finalizeAcceptanceAudit(root, acceptedAt, projections.post_acceptance_errors);
  return {
    status: "accepted",
    task: updatedTask,
    review: normalizedReview,
    placement_review: placementReview,
    question_candidate_intake: projections.question_candidate_intake,
    ...finalAudit,
  };
}

function reconcileTaskAcceptanceBatchAtomic({
  rootPath,
  items,
  now = new Date().toISOString(),
}) {
  if (!Array.isArray(items) || items.length === 0) {
    throw reconciliationError(
      "TASK_ACCEPTANCE_INVALID",
      "items must contain at least one specialist acceptance.",
    );
  }
  const root = path.resolve(rootPath);
  const acceptedAt = isoTimestamp(now, "now");
  const results = items.map((item) => reconcileTaskAcceptanceAtomic({
    rootPath: root,
    taskId: item.taskId || item.task_id || item.receipt?.task_id,
    receipt: item.receipt,
    review: item.review,
    now: item.now || item.review?.reviewed_at || acceptedAt,
    deferGlobalAudit: true,
  }));
  const finalAudit = finalizeAcceptanceAudit(
    root,
    acceptedAt,
    results.flatMap((result) => result.post_acceptance_errors || []),
  );
  return {
    status: "accepted",
    results,
    ...finalAudit,
  };
}

function argumentValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function main() {
  const args = process.argv.slice(2);
  const rootPath = path.resolve(argumentValue(args, "--root") || process.cwd());
  const receiptPath = argumentValue(args, "--receipt");
  const reviewPath = argumentValue(args, "--review");
  if (!receiptPath || !reviewPath) {
    console.error(
      "usage: node orquesta/scripts/task-acceptance-reconciler.js --root <project> --receipt <receipt.json> --review <review.json>",
    );
    process.exitCode = 1;
    return;
  }
  try {
    const receipt = readRequiredJson(path.resolve(receiptPath), "receipt");
    const review = readRequiredJson(path.resolve(reviewPath), "review");
    const result = reconcileTaskAcceptanceAtomic({
      rootPath,
      taskId: receipt.task_id,
      receipt,
      review,
      now: review.reviewed_at || new Date().toISOString(),
    });
    console.log(JSON.stringify({
      status: result.status,
      task_id: result.task.task_id,
      task_state: result.task.state,
      control_status: result.control_audit?.status || null,
      question_candidates_recorded: result.question_candidate_intake?.recorded_count || 0,
      user_support_wake_status: result.support_wake?.status || null,
      user_support_thread_id: result.support_wake?.thread_id || null,
      placement_status: result.placement_review?.status || null,
      placement_warnings: result.placement_review?.warnings?.length || 0,
    }, null, 2));
  } catch (error) {
    console.error(`${error.code || "TASK_ACCEPTANCE_FAILED"}: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  canonicalEnvelopeFromSpecialistResult,
  extractSpecialistResult,
  finalizeAcceptanceAudit,
  reconcileTaskAcceptanceAtomic,
  reconcileTaskAcceptanceBatchAtomic,
  replaceCompletionEnvelope,
  safeRelativePath,
  sameAcceptanceClaim,
};
