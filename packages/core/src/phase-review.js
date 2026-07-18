"use strict";

const { assertContract, canonicalHash } = require("@orquesta/contracts");

const ATTESTATION_FIELDS = Object.freeze([
  "source", "challenge_id", "target_id", "target_revision", "review_packet_hash", "token_hash",
  "captured_at", "expires_at", "identity_assurance",
]);

function phaseError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function allChecksPass(checks) {
  return Array.isArray(checks) && checks.length > 0 && checks.every((check) => check && check.status === "passed");
}

function createPhaseReview({ phase_id, build_ref, review_packet_ref, review_packet_hash, checks, revision = 0 } = {}) {
  if (typeof phase_id !== "string" || !phase_id || typeof build_ref !== "string" || !build_ref
    || typeof review_packet_ref !== "string" || !review_packet_ref || !/^[a-f0-9]{64}$/.test(review_packet_hash || "")
    || !allChecksPass(checks) || !Number.isInteger(revision) || revision < 0) {
    throw phaseError("PHASE_REVIEW_REQUEST_INVALID", "Phase review requires a build, packet, hash, passing checks, and revision.");
  }
  return assertContract("phase-review", {
    phase_id, status: "in_progress", build_ref, artifacts: [], artifact_hashes: { [review_packet_ref]: review_packet_hash }, review_packet_ref, review_packet_hash,
    checks, demo_script: null, screenshots: [], known_gaps: [], review_requested_at: null, reviewed_at: null,
    review_cycle_revision: revision, user_decision: null,
  });
}

function redactAttestation(attestation, target) {
  if (!attestation || attestation.target_id !== target.target_id || attestation.target_revision !== target.target_revision
    || attestation.review_packet_hash !== target.review_packet_hash || !/^[a-f0-9]{64}$/.test(attestation.token_hash || "")) {
    throw phaseError("PHASE_REVIEW_APPROVAL_INVALID", "Approval evidence does not bind the active review target.");
  }
  const redacted = Object.fromEntries(ATTESTATION_FIELDS.map((field) => [field, attestation[field]]));
  try {
    return assertContract("approval-attestation", redacted);
  } catch {
    throw phaseError("PHASE_REVIEW_APPROVAL_INVALID", "Approval evidence is not a valid redacted attestation.");
  }
}

function decidePhaseReview({ review, decision, approval_evidence, verifyUserApproval, revision } = {}) {
  if (!review || typeof review !== "object") throw phaseError("PHASE_REVIEW_TRANSITION_INVALID", "A current Phase Review is required.");
  if (decision === "ready_for_user_review") {
    if (!(["in_progress", "changes_requested"].includes(review.status))) throw phaseError("PHASE_REVIEW_TRANSITION_INVALID", "Only active or changed reviews can return to user review.");
    return assertContract("phase-review", { ...review, artifact_hashes: Object.keys(review.artifact_hashes).length ? review.artifact_hashes : { [review.review_packet_ref]: review.review_packet_hash }, status: "ready_for_user_review", user_decision: null });
  }
  if (!(["approved", "changes_requested"].includes(decision)) || review.status !== "ready_for_user_review" || typeof verifyUserApproval !== "function") {
    throw phaseError("PHASE_REVIEW_TRANSITION_INVALID", "A verified user decision requires a ready Phase Review.");
  }
  const targetRevision = Number.isInteger(revision) && revision >= 0 ? revision : review.review_cycle_revision;
  const target = { target_id: review.phase_id, target_revision: targetRevision, review_packet_hash: review.review_packet_hash, decision };
  const verified = verifyUserApproval(approval_evidence, target);
  const attestation = redactAttestation(verified && verified.attestation, target);
  return assertContract("phase-review", {
    ...review,
    status: decision,
    review_cycle_revision: targetRevision,
    artifact_hashes: Object.keys(review.artifact_hashes).length ? review.artifact_hashes : { [review.review_packet_ref]: review.review_packet_hash },
    reviewed_at: attestation.captured_at,
    user_decision: { decision, attestation: { ...attestation } },
  });
}

function resolutionApprovalTarget(resolution, revision) {
  return { target_id: resolution.resolution_id, target_revision: revision, review_packet_hash: canonicalHash(resolution) };
}

module.exports = { createPhaseReview, decidePhaseReview, phaseError, redactAttestation, resolutionApprovalTarget };
