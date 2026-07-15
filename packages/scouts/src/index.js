"use strict";

const { collectLocalInventory } = require("./inventory");

const PHASE1_SOURCES = new Set(["repository", "package_manifest", "package_lock", "codex", "fixture"]);
const PHASE2_SOURCES = new Set(["web", "registry", "remote"]);
const MAX_CANDIDATES = 3;
const MAX_SOURCES = 4;

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function scoutError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function boundedInteger(value, fallback, maximum) {
  if (!Number.isInteger(value) || value < 0) return fallback;
  return Math.min(value, maximum);
}

function sourceFamily(sourceType) {
  if (typeof sourceType === "string" && sourceType.startsWith("codex_")) return "codex";
  return sourceType;
}

function tokens(value) {
  return new Set(String(value || "").toLowerCase().match(/[a-z0-9_-]{2,}|[\p{L}\p{N}]{2,}/gu) || []);
}

function matchesNeed(need, provider) {
  const needText = `${need.description || ""} ${(need.hard_constraints || []).join(" ")}`.toLowerCase();
  const needTokens = tokens(needText);
  return (provider.capabilities || []).some((capability) => {
    const capabilityText = String(capability).toLowerCase();
    if (needText.includes(capabilityText) || capabilityText.includes(needText)) return true;
    for (const token of tokens(capabilityText)) if (needTokens.has(token)) return true;
    return false;
  });
}

function scoutNeed({ need, inventory, budget = {}, allowed_sources: allowedSources = [] } = {}) {
  if (!need || typeof need !== "object") throw scoutError("SCOUT_NEED_REQUIRED", "Scout requires a Capability Need.");
  if (!inventory || !Array.isArray(inventory.providers)) throw scoutError("SCOUT_INVENTORY_REQUIRED", "Scout requires an inventory.");
  if (!Array.isArray(allowedSources)) throw scoutError("SCOUT_ALLOWED_SOURCES_INVALID", "allowed_sources must be an array.");

  for (const source of allowedSources) {
    if (PHASE2_SOURCES.has(source) || !PHASE1_SOURCES.has(source)) {
      throw scoutError("SCOUT_SOURCE_NOT_ALLOWED_PHASE1", `Source ${source} is not allowed in Phase 1.`);
    }
  }

  const maxCandidates = boundedInteger(budget.max_candidates, MAX_CANDIDATES, MAX_CANDIDATES);
  const maxSources = boundedInteger(budget.max_sources, MAX_SOURCES, MAX_SOURCES);
  const sourcesConsidered = allowedSources.slice(0, maxSources);
  const sourceRank = new Map(sourcesConsidered.map((source, index) => [source, index]));
  const matching = inventory.providers
    .filter((provider) => sourceRank.has(sourceFamily(provider.source_type)))
    .filter((provider) => matchesNeed(need, provider))
    .sort((left, right) => {
      const rankDifference = sourceRank.get(sourceFamily(left.source_type)) - sourceRank.get(sourceFamily(right.source_type));
      return rankDifference || compareText(left.provider_id, right.provider_id);
    });
  const candidates = matching.slice(0, maxCandidates).map((provider) => {
    const unverifiedFields = [];
    if (!provider.license) unverifiedFields.push("license");
    if (!provider.compatibility) unverifiedFields.push("compatibility");
    return {
      provider_id: provider.provider_id,
      provider_type: provider.provider_type,
      source_type: provider.source_type,
      capabilities: [...(provider.capabilities || [])],
      provider_hash: provider.provider_hash || null,
      evidence_refs: [...(provider.evidence_refs || [])],
      unverified_fields: unverifiedFields
    };
  });
  const evidenceRefs = [...new Set(candidates.flatMap((candidate) => candidate.evidence_refs))].sort();
  const unverifiedFields = [...new Set(candidates.flatMap((candidate) => candidate.unverified_fields))].sort();

  let stopReason = "local_search_complete";
  if (!candidates.length) stopReason = "no_local_candidates";
  else if (matching.length > maxCandidates) stopReason = "candidate_budget_reached";
  else if (allowedSources.length > maxSources) stopReason = "source_budget_reached";
  else if (candidates.length >= 2) stopReason = "sufficient_local_candidates";

  return {
    need_id: need.need_id || null,
    candidates,
    evidence_refs: evidenceRefs,
    unverified_fields: unverifiedFields,
    sources_considered: sourcesConsidered,
    stop_reason: stopReason,
    unresolved: candidates.length === 0
  };
}

module.exports = { collectLocalInventory, scoutNeed };
