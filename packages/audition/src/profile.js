"use strict";

const path = require("node:path");
const { clone, compareText, strictDescendant } = require("./plan");

function validTime(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
}

function compareCodexProfile({ planned, actual } = {}) {
  const reasons = [];
  if (!planned || !Array.isArray(planned.allowed_roots) || !Array.isArray(planned.effects)) reasons.push("planned_profile_invalid");
  if (!actual) reasons.push("actual_profile_missing");
  else {
    if (actual.status !== "available") reasons.push("actual_profile_unavailable");
    if (actual.verified !== true) reasons.push("actual_profile_unverified");
    if (typeof actual.source !== "string" || !actual.source.trim()) reasons.push("actual_profile_source_missing");
    if (!validTime(actual.captured_at)) reasons.push("actual_profile_time_missing");
    if (!Array.isArray(actual.allowed_roots) || !actual.allowed_roots.length) reasons.push("actual_profile_roots_missing");
    if (!Array.isArray(actual.effects)) reasons.push("actual_profile_effects_missing");
  }
  if (!reasons.length) {
    const plannedRoots = planned.allowed_roots.map((root) => path.resolve(root));
    const actualRoots = actual.allowed_roots.map((root) => path.resolve(root));
    if (actualRoots.some((root) => !plannedRoots.some((allowed) => root === allowed || strictDescendant(allowed, root)))) {
      reasons.push("actual_profile_roots_broader");
    }
    if (actual.effects.some((effect) => !planned.effects.includes(effect))) reasons.push("actual_profile_effects_broader");
    if (new Set(actualRoots).size !== actualRoots.length || new Set(actual.effects).size !== actual.effects.length) {
      reasons.push("actual_profile_ambiguous");
    }
  }
  return {
    status: reasons.length ? "blocked" : "compatible",
    reasons: reasons.sort(compareText),
    observed_profile: actual ? clone({
      status: actual.status,
      verified: actual.verified,
      source: actual.source || null,
      captured_at: actual.captured_at || null,
      allowed_roots: Array.isArray(actual.allowed_roots) ? actual.allowed_roots.map((root) => path.resolve(root)).sort(compareText) : [],
      effects: Array.isArray(actual.effects) ? [...actual.effects].sort(compareText) : []
    }) : null
  };
}

module.exports = { compareCodexProfile };
