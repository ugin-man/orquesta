"use strict";

const { assertContract } = require("@orquesta/contracts");

const AXES = Object.freeze([
  "task_fit",
  "integration_ease",
  "evidence_strength",
  "maintainability",
  "security",
  "license_fit",
  "exit_option",
  "cost",
]);

function createBuildCandidate({ need, policyVersion = "phase1-v1" } = {}) {
  assertContract("capability-need", need);
  if (typeof policyVersion !== "string" || !policyVersion) throw new TypeError("Build candidate policyVersion is required.");
  const accessibilityRequired = need.hard_constraints.includes("accessibility_required");
  const axes = Object.fromEntries(AXES.map((axis) => [axis, { value: 0, reason: "No Phase 1 implementation estimate is recorded." }]));
  return {
    provider_id: `build:${need.need_id}`,
    provider_type: "new_build",
    source_uri: `synthetic:build:${need.need_id}`,
    capabilities: [need.description],
    trust_tier: "local",
    availability: "available",
    version: policyVersion,
    evidence_refs: [],
    resolution_mode: "build",
    static_metadata: {
      license: "not_applicable",
      runtime: "compatible",
      security: "unknown",
      ...(accessibilityRequired ? { accessibility: "planned_required" } : {}),
    },
    axes,
    uncertainty_penalty: 100,
    unknowns: ["implementation_estimate", "total_cost", ...(accessibilityRequired ? ["accessibility_verification"] : [])],
  };
}

module.exports = { createBuildCandidate };
