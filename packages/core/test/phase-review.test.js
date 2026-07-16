"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createPhaseReview, decidePhaseReview } = require("../src");

const hash = "a".repeat(64);

test("phase review only permits its explicit lifecycle and requires complete review evidence", () => {
  assert.throws(() => createPhaseReview({ phase_id: "phase-1", build_ref: null, review_packet_ref: "packet", review_packet_hash: hash, checks: [] }), { code: "PHASE_REVIEW_REQUEST_INVALID" });
  const review = createPhaseReview({ phase_id: "phase-1", build_ref: "build:1", review_packet_ref: "packet", review_packet_hash: hash, checks: [{ name: "tests", status: "passed" }], revision: 2 });
  assert.equal(review.status, "in_progress");
  assert.deepEqual(review.artifact_hashes, { packet: hash });
  assert.throws(() => decidePhaseReview({ review, decision: "approved", attestation: {} }), { code: "PHASE_REVIEW_TRANSITION_INVALID" });
  const ready = decidePhaseReview({ review, decision: "ready_for_user_review" });
  assert.equal(ready.status, "ready_for_user_review");
});

test("phase review canonicalizes artifact hashes from its packet ref and packet hash", () => {
  const review = createPhaseReview({
    phase_id: "phase-packet-integrity", build_ref: "build:packet", review_packet_ref: "artifact:packet", review_packet_hash: hash,
    checks: [{ name: "tests", status: "passed" }], revision: 3,
    artifact_hashes: { "artifact:packet": "b".repeat(64), "artifact:untrusted": "b".repeat(64) },
  });
  assert.deepEqual(review.artifact_hashes, { "artifact:packet": hash });
});

test("phase approval requires a verifier-bound unused target packet and revision", () => {
  const review = { ...createPhaseReview({ phase_id: "phase-1", build_ref: "build:1", review_packet_ref: "packet", review_packet_hash: hash, checks: [{ name: "tests", status: "passed" }], revision: 2 }), status: "ready_for_user_review" };
  assert.throws(() => decidePhaseReview({ review, decision: "approved", verifyUserApproval: () => null }), { code: "PHASE_REVIEW_APPROVAL_INVALID" });
  const approved = decidePhaseReview({ review, decision: "approved", verifyUserApproval: (_evidence, target) => ({ attestation: { target_id: target.target_id, target_revision: target.target_revision, review_packet_hash: target.review_packet_hash, token_hash: "b".repeat(64), source: "local_workbench_confirmation", challenge_id: "c", captured_at: "2026-07-16T07:30:00.000Z", expires_at: "2026-07-16T08:30:00.000Z", identity_assurance: "local_interaction_unverified_identity" }, actor: { type: "user", id: "verified" } }) });
  assert.equal(approved.status, "approved");
  assert.equal(approved.user_decision.attestation.token_hash, "b".repeat(64));
});

test("phase decision verifier receives the requested decision so changes evidence cannot authorize approval", () => {
  const review = { ...createPhaseReview({ phase_id: "phase-decision", build_ref: "build:1", review_packet_ref: "packet", review_packet_hash: hash, checks: [{ name: "tests", status: "passed" }], revision: 2 }), status: "ready_for_user_review" };
  const verifier = (_evidence, target) => {
    assert.equal(target.decision, "changes_requested");
    return { attestation: { target_id: target.target_id, target_revision: target.target_revision, review_packet_hash: target.review_packet_hash, token_hash: "c".repeat(64), source: "local_workbench_confirmation", challenge_id: "decision-c", captured_at: "2026-07-16T07:30:00.000Z", expires_at: "2026-07-16T08:30:00.000Z", identity_assurance: "local_interaction_unverified_identity" }, actor: { type: "user", id: "verified" } };
  };
  const changed = decidePhaseReview({ review, decision: "changes_requested", verifyUserApproval: verifier });
  assert.equal(changed.status, "changes_requested");
  assert.throws(() => decidePhaseReview({ review, decision: "approved", verifyUserApproval: verifier }), /changes_requested/);
});
