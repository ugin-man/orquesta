"use strict";

const { canonicalHash } = require("@orquesta/contracts");
const { evidenceError } = require("./normalize");

function matchingPredecessor(state, evidence, requiredKind, code, message) {
  if (!evidence.predecessor_evidence_id) {
    throw evidenceError(code, message, { evidence_id: evidence.evidence_id });
  }
  const predecessor = state.evidence_by_id && state.evidence_by_id[evidence.predecessor_evidence_id];
  if (!predecessor || predecessor.kind !== requiredKind) {
    throw evidenceError(code, message, { evidence_id: evidence.evidence_id, predecessor_evidence_id: evidence.predecessor_evidence_id });
  }
  if (predecessor.correlation_id !== evidence.correlation_id) {
    throw evidenceError("EVIDENCE_CORRELATION_MISMATCH", "Evidence predecessor must use the same correlation id.", {
      evidence_id: evidence.evidence_id, predecessor_evidence_id: predecessor.evidence_id,
    });
  }
  if (predecessor.task_intent_id !== evidence.task_intent_id
    || predecessor.resolution_id !== evidence.resolution_id
    || predecessor.context_pack_id !== evidence.context_pack_id) {
    throw evidenceError("EVIDENCE_BINDING_STALE", "Evidence predecessor must bind the same current lifecycle.", {
      evidence_id: evidence.evidence_id, predecessor_evidence_id: predecessor.evidence_id,
    });
  }
  if (canonicalHash(predecessor.source_evidence_refs) !== canonicalHash(evidence.source_evidence_refs)) {
    throw evidenceError("EVIDENCE_SOURCE_MISMATCH", "Evidence predecessor must bind the same source evidence.", {
      evidence_id: evidence.evidence_id, predecessor_evidence_id: predecessor.evidence_id,
    });
  }
  return predecessor;
}

function assertCurrentBindings(state, evidence) {
  const resolutionIds = Array.isArray(state.current_resolution_ids) ? state.current_resolution_ids : [];
  if (evidence.task_intent_id !== state.current_task_intent_id
    || evidence.context_pack_id !== state.current_context_pack_id
    || !resolutionIds.includes(evidence.resolution_id)) {
    throw evidenceError("EVIDENCE_BINDING_STALE", "Evidence must bind the current TaskIntent, Resolution, and Context Pack.", {
      task_intent_id: evidence.task_intent_id, resolution_id: evidence.resolution_id, context_pack_id: evidence.context_pack_id,
    });
  }
}

function hasActiveTurn(state, evidence) {
  const chain = state.evidence_by_correlation && state.evidence_by_correlation[evidence.correlation_id] || [];
  let active = null;
  for (const item of chain) {
    if (item.kind !== "runtime_event" || item.thread_id !== evidence.thread_id || item.turn_id !== evidence.turn_id) continue;
    if (item.event_kind === "turn_started") active = item;
    if (item.event_kind === "turn_completed") active = null;
  }
  return active;
}

function eventType(evidence) {
  if (evidence.kind === "runtime_dispatch") return "runtime.dispatch.accepted";
  if (evidence.kind === "runtime_event") return `runtime.${evidence.event_kind.replace("_", ".")}`;
  if (evidence.kind === "artifact") return "artifact.produced";
  if (evidence.kind === "report") return "report.produced";
  return "acceptance.completed";
}

function immutableEvidence(evidence) {
  const { sequence, ...content } = evidence;
  return content;
}

function correlateEvidence(state, evidence) {
  assertCurrentBindings(state, evidence);
  const existing = state.evidence_by_id && state.evidence_by_id[evidence.evidence_id];
  if (existing) {
    if (canonicalHash(immutableEvidence(existing)) === canonicalHash(immutableEvidence(evidence))) {
      return { status: "idempotent", event_type: eventType(existing), evidence: existing };
    }
    throw evidenceError("EVIDENCE_ID_CONFLICT", "Evidence id was already used with different immutable content.", { evidence_id: evidence.evidence_id });
  }
  if (evidence.kind === "runtime_dispatch") {
    if (!evidence.request_ref) throw evidenceError("EVIDENCE_REQUEST_REQUIRED", "Runtime dispatch requires a request reference.", { evidence_id: evidence.evidence_id });
  }
  if (evidence.kind === "runtime_event") {
    const predecessor = matchingPredecessor(state, evidence, evidence.event_kind === "turn_started" ? "runtime_dispatch" : "runtime_event", "EVIDENCE_PREDECESSOR_REQUIRED", "Runtime event requires the previous correlated evidence.");
    if (!evidence.thread_id) throw evidenceError("EVIDENCE_INVALID", "Runtime event requires a thread_id; turn_id may remain null when the adapter cannot observe one.", { evidence_id: evidence.evidence_id });
    if (evidence.event_kind === "turn_started" && predecessor.thread_id && predecessor.thread_id !== evidence.thread_id) {
      throw evidenceError("EVIDENCE_CORRELATION_MISMATCH", "Runtime turn must bind the dispatched thread.", { evidence_id: evidence.evidence_id });
    }
    if (evidence.event_kind !== "turn_started"
      && (predecessor.thread_id !== evidence.thread_id || predecessor.turn_id !== evidence.turn_id)) {
      throw evidenceError("EVIDENCE_CORRELATION_MISMATCH", "Runtime events must remain on the same observed thread and turn.", { evidence_id: evidence.evidence_id });
    }
  }
  if (evidence.kind === "artifact") {
    matchingPredecessor(state, evidence, "runtime_event", "EVIDENCE_PREDECESSOR_REQUIRED", "Artifact evidence requires an active runtime predecessor.");
    if (!evidence.artifact_ref || !evidence.artifact_hash || evidence.artifact_hash !== evidence.evidence_hash || !hasActiveTurn(state, evidence)) {
      throw evidenceError("EVIDENCE_RUNTIME_INACTIVE", "Artifact evidence requires an active correlated runtime turn.", { evidence_id: evidence.evidence_id });
    }
  }
  if (evidence.kind === "report") {
    if (evidence.predecessor_evidence_id) matchingPredecessor(state, evidence, "artifact", "EVIDENCE_REPORT_PREDECESSOR_REQUIRED", "Report evidence requires artifact evidence or an explicit report reference.");
    else if (!evidence.report_ref) throw evidenceError("EVIDENCE_REPORT_PREDECESSOR_REQUIRED", "Report evidence requires artifact evidence or an explicit report reference.", { evidence_id: evidence.evidence_id });
    if (!evidence.report_hash || evidence.report_hash !== evidence.evidence_hash) {
      throw evidenceError("EVIDENCE_INVALID", "Report evidence hash must bind the persisted report hash.", { evidence_id: evidence.evidence_id });
    }
  }
  if (evidence.kind === "acceptance") {
    matchingPredecessor(state, evidence, "report", "EVIDENCE_ACCEPTANCE_EVIDENCE_REQUIRED", "Acceptance evidence requires current report evidence.");
  }
  return { status: "ready", event_type: eventType(evidence), evidence };
}

module.exports = { correlateEvidence, eventType };
