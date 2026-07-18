"use strict";

const { auditError } = require("./score");

const GATE_ORDER = Object.freeze(["security", "license", "runtime", "accessibility", "payment", "login", "secret", "external_send"]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function metadataFor(candidate) {
  if (!candidate || !isPlainObject(candidate)) throw auditError("AUDIT_CANDIDATE_INVALID", "Candidate must be an object.");
  return isPlainObject(candidate.static_metadata) ? candidate.static_metadata : {};
}

function requiresUserDecision(value) {
  return value === true || value === "required" || value === "needs_user";
}

function hasExactUnknown(candidate, code) {
  return Array.isArray(candidate.unknowns) && candidate.unknowns.includes(code);
}

function evaluateHardGates({ candidate, need } = {}) {
  const metadata = metadataFor(candidate);
  const constraints = Array.isArray(need && need.hard_constraints) ? need.hard_constraints : [];
  const results = [];

  const security = metadata.security;
  results.push({
    gate: "security",
    status: security === "critical" ? "fail" : "pass",
    reason: security === "critical"
      ? "Static metadata records a critical security finding."
      : "No critical security finding is recorded in static metadata."
  });

  const license = metadata.license;
  const licenseUnknown = hasExactUnknown(candidate, "license");
  results.push({
    gate: "license",
    status: !license || license === "unknown" || license === "forbidden" || licenseUnknown ? "fail" : "pass",
    reason: licenseUnknown
      ? "Static metadata does not have confirmed license evidence."
      : !license || license === "unknown"
      ? "Static metadata does not provide a usable license value."
      : license === "forbidden"
        ? "Static metadata records a forbidden license."
        : "Static metadata provides a license value."
  });

  const runtime = metadata.runtime;
  results.push({
    gate: "runtime",
    status: runtime === "incompatible" ? "fail" : "pass",
    reason: runtime === "incompatible"
      ? "Static metadata records an incompatible runtime."
      : "Static metadata does not record runtime incompatibility."
  });

  const accessibilityRequired = constraints.includes("accessibility_required");
  const plannedBuildAccessibility = candidate.provider_type === "new_build" && metadata.accessibility === "planned_required";
  results.push({
    gate: "accessibility",
    status: accessibilityRequired && metadata.accessibility !== "met" && !plannedBuildAccessibility ? "fail" : "pass",
    reason: plannedBuildAccessibility
      ? "Accessibility is not proven met; it is an unverified requirement included in the new-build acceptance plan."
      : accessibilityRequired && metadata.accessibility !== "met"
      ? "Accessibility is required and static metadata does not record it as met."
      : accessibilityRequired
        ? "Accessibility is required and static metadata records it as met."
        : "Accessibility is not a hard constraint for this Need."
  });

  for (const gate of ["payment", "login", "secret", "external_send"]) {
    results.push({
      gate,
      status: requiresUserDecision(metadata[gate]) ? "blocked" : "pass",
      reason: requiresUserDecision(metadata[gate])
        ? `Static metadata says ${gate} requires a user decision.`
        : `Static metadata does not say ${gate} is required.`
    });
  }

  const eligibility = results.some((result) => result.status === "fail")
    ? "ineligible"
    : results.some((result) => result.status === "blocked")
      ? "blocked"
      : "eligible";
  return { hard_gate_results: results, eligibility };
}

function staticFacts({ candidate, need } = {}) {
  const metadata = metadataFor(candidate);
  const facts = Object.keys(metadata).sort().map((key) => `metadata.${key}=${String(metadata[key])}`);
  const unknowns = [];
  for (const field of ["license", "security", "runtime"]) {
    if (!Object.hasOwn(metadata, field) || metadata[field] === "unknown") unknowns.push(field);
  }
  if (Array.isArray(need && need.hard_constraints) && need.hard_constraints.includes("accessibility_required") && metadata.accessibility !== "met") {
    unknowns.push("accessibility");
  }
  for (const item of Array.isArray(candidate.unknowns) ? candidate.unknowns : []) {
    if (typeof item === "string" && item && !unknowns.includes(item)) unknowns.push(item);
  }
  return { facts, unknowns: unknowns.sort() };
}

module.exports = { GATE_ORDER, evaluateHardGates, staticFacts };
