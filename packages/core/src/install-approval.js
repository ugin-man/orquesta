"use strict";

const { assertContract, canonicalHash } = require("@orquesta/contracts");

function installError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function createInstallApprovalTarget(input = {}) {
  const resolutionId = text(input.resolution_id);
  const resolutionRevision = Number.isInteger(input.resolution_revision) && input.resolution_revision > 0
    ? input.resolution_revision
    : null;
  if (!resolutionId || resolutionRevision === null) {
    throw installError("CORE_INSTALL_TARGET_INVALID", "Install target requires an exact Resolution and revision.");
  }
  const effects = Array.isArray(input.effects) ? [...input.effects].sort(compareText) : input.effects;
  let contract;
  try {
    contract = assertContract("install-approval-target", {
      candidate_id: input.candidate_id,
      candidate_version: input.candidate_version,
      source_hash: input.source_hash,
      dependency_preview_hash: input.dependency_preview_hash,
      lockfile_preview_hash: input.lockfile_preview_hash,
      target_workspace: input.target_workspace,
      effects,
      expires_at: input.expires_at,
      review_packet_ref: input.review_packet_ref,
      review_packet_hash: input.review_packet_hash
    });
  } catch (error) {
    throw installError("CORE_INSTALL_TARGET_INVALID", "Install target does not satisfy the semantic approval contract.", { cause_code: error.code || null });
  }
  const content = { resolution_id: resolutionId, resolution_revision: resolutionRevision, ...contract };
  return {
    target_id: `INSTALL-${canonicalHash(content).slice(0, 24)}`,
    target_revision: resolutionRevision,
    ...content
  };
}

module.exports = { createInstallApprovalTarget, installError };
