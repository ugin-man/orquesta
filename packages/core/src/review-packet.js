"use strict";

const REQUIRED_PACKET_FIELDS = Object.freeze([
  "build_ref",
  "artifact_hashes",
  "five_minute_path",
  "fixture_results",
  "automated_checks",
  "browser_evidence",
  "browser_runner_versions",
  "approval_assurance",
  "tested_node_versions",
  "adopted_and_rejected",
  "known_gaps",
  "phase2_changes",
  "user_decision_location",
]);

function reviewPacketError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function checkStatus(checks, name) {
  return Array.isArray(checks) && checks.find((check) => check && check.name === name)?.status;
}

function createReviewPacket(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw reviewPacketError("REVIEW_PACKET_INVALID", "Review packet input must be an object.");
  }
  for (const field of REQUIRED_PACKET_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(input, field) || input[field] === undefined || input[field] === null) {
      throw reviewPacketError("REVIEW_PACKET_FIELD_REQUIRED", `Review packet requires ${field}.`, { field });
    }
  }
  const hashEntries = Object.entries(input.artifact_hashes || {});
  if (hashEntries.length === 0 || hashEntries.some(([reference, hash]) => !reference || !/^[a-f0-9]{64}$/u.test(hash))) {
    throw reviewPacketError("REVIEW_PACKET_ARTIFACT_HASH_INVALID", "Every review artifact requires a SHA-256 hash.");
  }
  const blockers = [];
  if (input.browser_evidence?.status !== "passed") blockers.push("browser_evidence");
  if (Number(input.browser_evidence?.console_errors || 0) !== 0 || Number(input.browser_evidence?.page_errors || 0) !== 0) blockers.push("browser_errors");
  for (const name of ["phase_boundary", "v3", "v4", "projection_replay"]) {
    if (checkStatus(input.automated_checks, name) !== "passed") blockers.push(name);
  }
  if (!Array.isArray(input.fixture_results) || input.fixture_results.length !== 3
    || input.fixture_results.some((result) => result?.status !== "passed" || result.expected_mode !== result.actual_mode)) {
    blockers.push("fixtures");
  }
  if (input.approval_assurance !== "explicit_user_decision_in_codex_orchestrator_task") blockers.push("approval_assurance");
  if (typeof input.user_decision_location !== "string" || !input.user_decision_location.trim()) blockers.push("user_decision_location");
  if (blockers.length > 0) {
    throw reviewPacketError("REVIEW_PACKET_NOT_READY", "Phase 1 evidence is not ready for user review.", { blockers });
  }
  return Object.freeze({ version: 1, status: "ready_for_user_review", ...clone(input) });
}

module.exports = { REQUIRED_PACKET_FIELDS, createReviewPacket, reviewPacketError };
