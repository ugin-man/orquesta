"use strict";

const path = require("node:path");
const { clone, compareText, stableJson } = require("./plan");

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
    if (planned && planned.profile_id && actual.profile_id !== planned.profile_id) reasons.push("actual_profile_id_mismatch");
    if (typeof actual.source !== "string" || !actual.source.trim()) reasons.push("actual_profile_source_missing");
    if (!validTime(actual.captured_at)) reasons.push("actual_profile_time_missing");
    if (!Array.isArray(actual.allowed_roots) || !actual.allowed_roots.length
      || actual.allowed_roots.some((root) => typeof root !== "string" || !root.trim())) reasons.push("actual_profile_roots_missing");
    if (!Array.isArray(actual.effects) || actual.effects.some((effect) => typeof effect !== "string" || !effect.trim())) reasons.push("actual_profile_effects_missing");
  }
  if (!reasons.length) {
    const plannedRoots = planned.allowed_roots.map((root) => path.resolve(root)).sort(compareText);
    const actualRoots = actual.allowed_roots.map((root) => path.resolve(root)).sort(compareText);
    const plannedEffects = planned.effects.map((effect) => effect.trim()).sort(compareText);
    const actualEffects = actual.effects.map((effect) => effect.trim()).sort(compareText);
    if (actualRoots.some((root) => !plannedRoots.includes(root))) reasons.push("actual_profile_roots_broader");
    if (plannedRoots.some((root) => !actualRoots.includes(root))) reasons.push("actual_profile_roots_missing_required");
    if (actualEffects.some((effect) => !plannedEffects.includes(effect))) reasons.push("actual_profile_effects_broader");
    if (plannedEffects.some((effect) => !actualEffects.includes(effect))) reasons.push("actual_profile_effects_missing_required");
    if (stableJson(actualRoots) !== stableJson(plannedRoots) && !reasons.some((reason) => reason.startsWith("actual_profile_roots_"))) {
      reasons.push("actual_profile_roots_mismatch");
    }
    if (stableJson(actualEffects) !== stableJson(plannedEffects) && !reasons.some((reason) => reason.startsWith("actual_profile_effects_"))) {
      reasons.push("actual_profile_effects_mismatch");
    }
    if (new Set(actualRoots).size !== actualRoots.length || new Set(actualEffects).size !== actualEffects.length) {
      reasons.push("actual_profile_ambiguous");
    }
  }
  return {
    status: reasons.length ? "blocked" : "compatible",
    reasons: reasons.sort(compareText),
    observed_profile: actual ? clone({
      status: actual.status,
      verified: actual.verified,
      profile_id: actual.profile_id || null,
      source: actual.source || null,
      captured_at: actual.captured_at || null,
      allowed_roots: Array.isArray(actual.allowed_roots) ? actual.allowed_roots.map((root) => path.resolve(root)).sort(compareText) : [],
      effects: Array.isArray(actual.effects) ? actual.effects.map((effect) => typeof effect === "string" ? effect.trim() : effect).sort(compareText) : []
    }) : null
  };
}

module.exports = { compareCodexProfile };
