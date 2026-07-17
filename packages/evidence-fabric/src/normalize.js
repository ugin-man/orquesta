"use strict";

const KINDS = new Set(["runtime_dispatch", "runtime_event", "artifact", "report", "acceptance"]);
const RUNTIME_EVENTS = new Set(["turn_started", "progress_observed", "turn_completed"]);

function evidenceError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function requiredText(value, field) {
  if (typeof value !== "string" || !value) {
    throw evidenceError("EVIDENCE_INVALID", `Evidence requires ${field}.`, { field });
  }
  return value;
}

function optionalText(value, field) {
  if (value === undefined || value === null) return null;
  return requiredText(value, field);
}

function sortedRefs(value) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item)) {
    throw evidenceError("EVIDENCE_INVALID", "Evidence requires source_evidence_refs as nonempty strings.", { field: "source_evidence_refs" });
  }
  return [...new Set(value)].sort();
}

function normalizeEvidence(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || !KINDS.has(input.kind)) {
    throw evidenceError("EVIDENCE_INVALID", "Evidence kind is not supported.", { kind: input && input.kind || null });
  }
  const normalized = {
    kind: input.kind,
    evidence_id: requiredText(input.evidence_id, "evidence_id"),
    evidence_hash: requiredText(input.evidence_hash, "evidence_hash"),
    task_intent_id: requiredText(input.task_intent_id, "task_intent_id"),
    resolution_id: requiredText(input.resolution_id, "resolution_id"),
    context_pack_id: requiredText(input.context_pack_id, "context_pack_id"),
    correlation_id: requiredText(input.correlation_id, "correlation_id"),
    source_evidence_refs: sortedRefs(input.source_evidence_refs || []),
    request_ref: optionalText(input.request_ref, "request_ref"),
    thread_id: optionalText(input.thread_id, "thread_id"),
    turn_id: optionalText(input.turn_id, "turn_id"),
    predecessor_evidence_id: optionalText(input.predecessor_evidence_id, "predecessor_evidence_id"),
    artifact_ref: optionalText(input.artifact_ref, "artifact_ref"),
    artifact_hash: optionalText(input.artifact_hash, "artifact_hash"),
    report_ref: optionalText(input.report_ref, "report_ref"),
    report_hash: optionalText(input.report_hash, "report_hash"),
    acceptance_ref: optionalText(input.acceptance_ref, "acceptance_ref"),
  };
  if (normalized.kind === "runtime_event") {
    if (!RUNTIME_EVENTS.has(input.event_kind)) {
      throw evidenceError("EVIDENCE_INVALID", "Runtime evidence requires a supported event_kind.", { field: "event_kind" });
    }
    normalized.event_kind = input.event_kind;
  } else {
    normalized.event_kind = null;
  }
  return normalized;
}

module.exports = { evidenceError, normalizeEvidence };
