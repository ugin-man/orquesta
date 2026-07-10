#!/usr/bin/env node

const fs = require("fs");

const VALID_RISK_LEVELS = new Set(["low", "medium", "high"]);
const VALID_READING_STATUSES = new Set(["done", "partial", "blocked"]);
const VALID_COMMAND_STATUSES = new Set(["passed", "failed", "blocked", "not_run", "failed_expected"]);
const VALID_EVIDENCE_STATUSES = new Set(["passed", "failed", "blocked", "not_required"]);
const VALID_CHANGE_KINDS = new Set(["created", "modified", "deleted", "report_only", "state_only"]);
const VALID_QUESTION_STATUSES = new Set(["submitted", "none"]);
const WEAKENING_IMPACTS = new Set(["weakens_evidence", "weakens_output"]);

function issue(code, message, field = null) {
  return { code, message, field };
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validTimestamp(value) {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function sameValue(left, right) {
  return (left ?? null) === (right ?? null);
}

function isStagedInTask(task = {}, options = {}) {
  if (typeof options.stagedIn === "boolean") return options.stagedIn;
  if (options.rolloutMode === "legacy") return false;
  if (task.control_rollout === "beta_v3") return true;
  if (isRecord(task.control_signals)) return true;
  if (isRecord(task.completion_envelope)) return true;
  if (options.rolloutStartedAt && validTimestamp(task.created_at)) {
    return Date.parse(task.created_at) >= Date.parse(options.rolloutStartedAt);
  }
  return false;
}

function extractCompletionEnvelope(text) {
  const source = String(text || "");
  const blockPattern = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const match of source.matchAll(blockPattern)) {
    try {
      const parsed = JSON.parse(match[1]);
      if (isRecord(parsed?.completion_envelope)) return parsed.completion_envelope;
    } catch {
      // Other fenced blocks may not be JSON. Validation reports a missing envelope.
    }
  }
  return null;
}

function validateCompletionEnvelope(envelope, task = {}, options = {}) {
  const errors = [];
  const warnings = [];

  if (!isRecord(envelope)) {
    errors.push(issue("invalid_completion_envelope", "completion_envelope must be a JSON object.", "completion_envelope"));
    return { status: "invalid", errors, warnings };
  }

  if (envelope.version !== 1) {
    errors.push(issue("unsupported_completion_envelope_version", "completion_envelope.version must be 1.", "version"));
  }
  if (!envelope.task_id) {
    errors.push(issue("task_id_missing", "completion_envelope.task_id is required.", "task_id"));
  } else if (task.task_id && envelope.task_id !== task.task_id) {
    errors.push(issue("task_id_mismatch", "completion_envelope.task_id does not match the reviewed task.", "task_id"));
  }
  if (!envelope.agent_id) {
    errors.push(issue("agent_id_missing", "completion_envelope.agent_id is required.", "agent_id"));
  } else if (task.owner_agent_id && envelope.agent_id !== task.owner_agent_id) {
    errors.push(issue("agent_id_mismatch", "completion_envelope.agent_id does not match task.owner_agent_id.", "agent_id"));
  }
  if (envelope.status !== "submitted") {
    errors.push(issue("invalid_completion_status", "completion_envelope.status must be submitted before acceptance.", "status"));
  }
  if (!VALID_RISK_LEVELS.has(envelope.risk_level)) {
    errors.push(issue("invalid_risk_level", "completion_envelope.risk_level must be low, medium, or high.", "risk_level"));
  }

  const reading = envelope.required_reading;
  if (!isRecord(reading)) {
    errors.push(issue("required_reading_missing", "completion_envelope.required_reading is required.", "required_reading"));
  } else {
    if (!VALID_READING_STATUSES.has(reading.status)) {
      errors.push(issue("invalid_required_reading_status", "required_reading.status is invalid.", "required_reading.status"));
    }
    if (!Array.isArray(reading.files)) {
      errors.push(issue("required_reading_files_missing", "required_reading.files must be an array.", "required_reading.files"));
    }
    if (!Array.isArray(reading.not_read)) {
      errors.push(issue("required_reading_not_read_missing", "required_reading.not_read must be explicit.", "required_reading.not_read"));
    }
  }

  const delegation = envelope.delegation_evidence;
  if (!isRecord(delegation)) {
    errors.push(issue("delegation_evidence_missing", "completion_envelope.delegation_evidence is required.", "delegation_evidence"));
  } else {
    if (task.routing_class && delegation.routing_class !== task.routing_class) {
      errors.push(issue("routing_class_mismatch", "delegation routing_class does not match task state.", "delegation_evidence.routing_class"));
    }
    if (task.routing_class === "specialist_required") {
      if (!validTimestamp(delegation.handoff_sent_at)) {
        errors.push(issue("invalid_handoff_timestamp", "A valid handoff_sent_at is required for specialist work.", "delegation_evidence.handoff_sent_at"));
      } else if (!sameValue(delegation.handoff_sent_at, task.handoff_sent_at)) {
        errors.push(issue("handoff_sent_at_mismatch", "delegation handoff_sent_at does not match task state.", "delegation_evidence.handoff_sent_at"));
      }
      if (!delegation.specialist_report_path) {
        errors.push(issue("specialist_report_path_missing", "delegation specialist_report_path is required.", "delegation_evidence.specialist_report_path"));
      } else if (!sameValue(delegation.specialist_report_path, task.specialist_report_path)) {
        errors.push(issue("specialist_report_path_mismatch", "delegation specialist_report_path does not match task state.", "delegation_evidence.specialist_report_path"));
      }
    }
    if (task.routing_class === "direct_exception") {
      if (!delegation.direct_exception_reason || !sameValue(delegation.direct_exception_reason, task.direct_exception_reason)) {
        errors.push(issue("direct_exception_reason_mismatch", "direct exception reason must match task state.", "delegation_evidence.direct_exception_reason"));
      }
      if (!delegation.bypass_review_owner || !sameValue(delegation.bypass_review_owner, task.bypass_review_owner)) {
        errors.push(issue("bypass_review_owner_mismatch", "bypass review owner must match task state.", "delegation_evidence.bypass_review_owner"));
      }
    }
  }

  const modelRoute = envelope.model_route;
  if (!isRecord(modelRoute)) {
    errors.push(issue("model_route_missing", "completion_envelope.model_route is required.", "model_route"));
  } else {
    const requestedModel = task.model_route?.requested_model ?? null;
    if (requestedModel && !modelRoute.requested_model) {
      errors.push(issue("requested_model_missing", "The task requested model must be preserved in the envelope.", "model_route.requested_model"));
    } else if (requestedModel && modelRoute.requested_model !== requestedModel) {
      errors.push(issue("requested_model_mismatch", "Envelope requested_model does not match task state.", "model_route.requested_model"));
    }
    if (modelRoute.requested_model && !modelRoute.requested_model_evidence) {
      errors.push(issue("requested_model_evidence_missing", "requested_model requires request evidence.", "model_route.requested_model_evidence"));
    }
    if (modelRoute.actual_model && !modelRoute.actual_model_evidence) {
      errors.push(issue("actual_model_evidence_missing", "actual_model requires independent runtime evidence.", "model_route.actual_model_evidence"));
    }
    if (task.model_route?.actual_model && modelRoute.actual_model !== task.model_route.actual_model) {
      errors.push(issue("actual_model_mismatch", "Envelope actual_model does not match the task's verified model evidence.", "model_route.actual_model"));
    }
  }

  if (!Array.isArray(envelope.changes) || envelope.changes.length === 0) {
    errors.push(issue("changes_missing", "completion_envelope.changes must contain at least one change.", "changes"));
  } else {
    envelope.changes.forEach((change, index) => {
      if (!isRecord(change) || !change.path || !VALID_CHANGE_KINDS.has(change.kind) || !change.summary) {
        errors.push(issue("invalid_change_entry", `changes[${index}] is incomplete.`, `changes[${index}]`));
      }
    });
  }

  const verification = envelope.verification;
  if (!isRecord(verification)) {
    errors.push(issue("verification_missing", "completion_envelope.verification is required.", "verification"));
  } else {
    const commands = verification.commands;
    if (!Array.isArray(commands)) {
      errors.push(issue("verification_commands_missing", "verification.commands must be an array.", "verification.commands"));
    } else if (commands.length === 0) {
      const reportOnly = Array.isArray(envelope.changes)
        && envelope.changes.length > 0
        && envelope.changes.every((change) => change?.kind === "report_only");
      if (!reportOnly || !String(verification.no_commands_reason || "").trim()) {
        errors.push(issue("empty_verification_commands", "Empty verification commands require report-only changes and an explicit reason.", "verification.commands"));
      }
    } else {
      commands.forEach((command, index) => {
        if (!isRecord(command) || !command.command || !VALID_COMMAND_STATUSES.has(command.status) || !command.expected || !command.evidence) {
          errors.push(issue("invalid_verification_command", `verification.commands[${index}] is incomplete.`, `verification.commands[${index}]`));
        }
      });
    }
    for (const field of ["browser", "live_thread"]) {
      if (!isRecord(verification[field]) || !VALID_EVIDENCE_STATUSES.has(verification[field].status)) {
        errors.push(issue("invalid_verification_surface", `verification.${field}.status is invalid.`, `verification.${field}`));
      }
    }
  }

  if (!Array.isArray(envelope.not_verified)) {
    errors.push(issue("not_verified_missing", "completion_envelope.not_verified must be explicit.", "not_verified"));
  }
  if (!Array.isArray(envelope.open_risks)) {
    errors.push(issue("open_risks_missing", "completion_envelope.open_risks must be an array.", "open_risks"));
  }
  if (!Array.isArray(envelope.fallbacks)) {
    errors.push(issue("fallbacks_missing", "completion_envelope.fallbacks must be an array.", "fallbacks"));
  } else {
    envelope.fallbacks.forEach((fallback, index) => {
      if (!isRecord(fallback)) {
        errors.push(issue("invalid_fallback", `fallbacks[${index}] must be an object.`, `fallbacks[${index}]`));
        return;
      }
      if (WEAKENING_IMPACTS.has(fallback.quality_impact) && fallback.approval_status !== "approved") {
        errors.push(issue("fallback_user_approval_missing", `fallbacks[${index}] weakens evidence or output without approval.`, `fallbacks[${index}].approval_status`));
      }
      if (fallback.created_at && !validTimestamp(fallback.created_at)) {
        errors.push(issue("invalid_timestamp", `fallbacks[${index}].created_at is invalid.`, `fallbacks[${index}].created_at`));
      }
    });
  }

  if (!VALID_QUESTION_STATUSES.has(envelope.question_candidates_status)) {
    errors.push(issue("invalid_question_candidates_status", "question_candidates_status must be submitted or none.", "question_candidates_status"));
  }
  if (!validTimestamp(envelope.created_at)) {
    errors.push(issue("invalid_timestamp", "completion_envelope.created_at must be a valid timestamp.", "created_at"));
  }

  return {
    status: errors.length ? "invalid" : "valid",
    errors,
    warnings
  };
}

function inspectCompletionEnvelope(reportPath, task = {}, options = {}) {
  let text;
  try {
    text = fs.readFileSync(reportPath, "utf8");
  } catch (error) {
    return {
      present: false,
      status: "invalid",
      envelope: null,
      errors: [issue("completion_report_unreadable", error.message, reportPath)],
      warnings: []
    };
  }

  const envelope = extractCompletionEnvelope(text);
  if (!envelope) {
    if (!isStagedInTask(task, options) && task.state === "accepted" && options.rolloutMode !== "hard") {
      return {
        present: false,
        status: "legacy_warning",
        envelope: null,
        errors: [],
        warnings: [issue("legacy_completion_envelope_missing", "Legacy accepted task has no completion envelope.", "completion_envelope")]
      };
    }
    return {
      present: false,
      status: "invalid",
      envelope: null,
      errors: [issue("missing_completion_envelope", "Staged-in task report has no completion_envelope block.", "completion_envelope")],
      warnings: []
    };
  }

  const validation = validateCompletionEnvelope(envelope, task, options);
  return {
    present: true,
    status: validation.status,
    envelope,
    errors: validation.errors,
    warnings: validation.warnings
  };
}

module.exports = {
  extractCompletionEnvelope,
  inspectCompletionEnvelope,
  isStagedInTask,
  validateCompletionEnvelope
};
