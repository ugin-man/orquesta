"use strict";

const { assertContract, canonicalHash } = require("@orquesta/contracts");
const { WEIGHTS_V1, auditCandidate } = require("@orquesta/audit");
const { createBuildCandidate } = require("./build-candidate");

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareEntries(left, right) {
  return right.audit.evaluation.candidate_score - left.audit.evaluation.candidate_score
    || compareText(left.candidate.provider_id, right.candidate.provider_id);
}

function unknownAxes() {
  return Object.fromEntries(Object.keys(WEIGHTS_V1).map((axis) => [axis, { value: 0, reason: "No Phase 1 estimate is recorded." }]));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolverError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function duplicateIds(items, idFor) {
  const counts = new Map();
  for (const item of items) {
    const id = idFor(item);
    if (typeof id !== "string" || !id) continue;
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  return [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id).sort(compareText);
}

function auditFactLookup(auditFacts) {
  if (Array.isArray(auditFacts)) {
    const duplicates = duplicateIds(auditFacts, (fact) => fact && fact.candidate_id);
    if (duplicates.length) {
      throw resolverError(
        "RESOLVER_AUDIT_FACT_DUPLICATE",
        "Array audit facts must have unique candidate IDs.",
        { candidate_ids: duplicates },
      );
    }
    const facts = new Map(auditFacts.filter(isPlainObject).map((fact) => [fact.candidate_id, fact]));
    return (candidateId) => facts.get(candidateId) || null;
  }
  if (isPlainObject(auditFacts)) return (candidateId) => auditFacts[candidateId] || null;
  return () => null;
}

function withAuditFact(candidate, getAuditFact) {
  const fact = getAuditFact(candidate.provider_id);
  if (!fact || typeof fact !== "object") return candidate;
  const resolved = {
    ...candidate,
    static_metadata: {
      ...(isPlainObject(candidate.static_metadata) ? candidate.static_metadata : {}),
      ...(isPlainObject(fact.static_metadata) ? fact.static_metadata : {}),
    },
  };
  for (const field of ["axes", "uncertainty_penalty", "unknowns", "estimated_total_cost"]) {
    if (Object.hasOwn(fact, field)) resolved[field] = fact[field];
  }
  return resolved;
}

function normalizeCostEvidence(candidate) {
  const hasEstimate = Object.hasOwn(candidate, "estimated_total_cost");
  if (hasEstimate && (typeof candidate.estimated_total_cost !== "number" || !Number.isFinite(candidate.estimated_total_cost) || candidate.estimated_total_cost < 0)) {
    throw resolverError(
      "RESOLVER_ESTIMATED_TOTAL_COST_INVALID",
      "Estimated total cost must be a finite nonnegative number when provided.",
      { candidate_id: candidate.provider_id },
    );
  }
  const unknowns = Array.isArray(candidate.unknowns) ? candidate.unknowns.filter((value) => typeof value === "string" && value) : [];
  if (hasEstimate) {
    for (let index = unknowns.length - 1; index >= 0; index -= 1) {
      if (unknowns[index] === "total_cost") unknowns.splice(index, 1);
    }
  } else if (!unknowns.includes("total_cost")) {
    unknowns.push("total_cost");
  }
  return { ...candidate, unknowns: [...new Set(unknowns)].sort(compareText) };
}

function evaluationCandidate(candidate) {
  if (candidate.axes && candidate.uncertainty_penalty !== undefined) return candidate;
  return {
    ...candidate,
    axes: unknownAxes(),
    uncertainty_penalty: 100,
    unknowns: [...new Set([...(candidate.unknowns || []), "score_estimates"])].sort(compareText),
  };
}

function modeFor(candidate) {
  if (["reuse", "adapt", "build"].includes(candidate.resolution_mode)) return candidate.resolution_mode;
  return candidate.provider_type === "new_build" ? "build" : "reuse";
}

function candidateSummary(entry, extra = {}) {
  const hasCostEstimate = Object.hasOwn(entry.candidate, "estimated_total_cost");
  return {
    candidate_id: entry.candidate.provider_id,
    candidate_score: entry.audit.evaluation.candidate_score,
    eligibility: entry.audit.evaluation.eligibility,
    mode: modeFor(entry.candidate),
    evaluation: entry.audit.evaluation,
    unknowns: entry.audit.unknowns,
    estimated_total_cost: hasCostEstimate ? entry.candidate.estimated_total_cost : null,
    cost_status: hasCostEstimate ? "estimated" : "unknown",
    ...extra,
  };
}

function selectedRanked(eligible) {
  const build = eligible.find((entry) => entry.candidate.provider_type === "new_build");
  if (!build || eligible.indexOf(build) < 3) return eligible.slice(0, 3);
  return [...eligible.slice(0, 2), build].sort(compareEntries);
}

function collectEvidence(entries) {
  return [...new Set(entries.flatMap((entry) => Array.isArray(entry.candidate.evidence_refs) ? entry.candidate.evidence_refs : []))].sort(compareText);
}

function inconclusiveReasons(eligible, scoreTie) {
  const leader = eligible[0] || null;
  if (!leader) return ["no_eligible_candidate"];
  const reasons = [];
  if (scoreTie) reasons.push("score_tie");
  if (leader.audit.evaluation.uncertainty_penalty >= 50) reasons.push("high_uncertainty_penalty");
  for (const code of ["score_estimates", "implementation_estimate", "total_cost"]) {
    if (leader.audit.unknowns.includes(code)) reasons.push(code);
  }
  if (leader.candidate.provider_type === "new_build"
    && (leader.audit.unknowns.includes("accessibility") || leader.audit.unknowns.includes("accessibility_verification"))) {
    reasons.push("accessibility");
  }
  return reasons;
}

function readableInconclusiveReason(reasons) {
  const text = {
    score_tie: "Eligible candidates tie on the static score.",
    high_uncertainty_penalty: "The leading eligible candidate has a high uncertainty penalty.",
    score_estimates: "The leading eligible candidate lacks score estimates.",
    implementation_estimate: "The leading eligible candidate lacks an implementation estimate.",
    total_cost: "The leading eligible candidate lacks a total-cost estimate.",
    accessibility: "The leading new-build candidate has unresolved accessibility evidence.",
    no_eligible_candidate: "No candidate passed the static hard gates.",
  };
  return reasons.map((reason) => text[reason]).join(" ");
}

function assertUniqueScoutedCandidates(candidates) {
  const duplicates = duplicateIds(candidates, (candidate) => candidate && candidate.provider_id);
  if (duplicates.length) {
    throw resolverError(
      "RESOLVER_SCOUTED_CANDIDATE_DUPLICATE",
      "Scouted candidates must have unique provider IDs.",
      { provider_ids: duplicates },
    );
  }
}

function resolveNeed({ need, scoutedCandidates = [], auditFacts = [], policy = WEIGHTS_V1 } = {}) {
  assertContract("capability-need", need);
  if (!Array.isArray(scoutedCandidates)) throw new TypeError("scoutedCandidates must be an array.");
  const getAuditFact = auditFactLookup(auditFacts);
  const syntheticBuildId = `build:${need.need_id}`;
  const normalizedScouted = scoutedCandidates.filter((candidate) => candidate && candidate.provider_id !== syntheticBuildId);
  assertUniqueScoutedCandidates(normalizedScouted);
  const build = createBuildCandidate({ need, policyVersion: "phase1-v1" });
  const input = [...normalizedScouted, build]
    .map((candidate) => withAuditFact(candidate, getAuditFact))
    .map(normalizeCostEvidence)
    .map(evaluationCandidate)
    .sort((left, right) => compareText(left.provider_id, right.provider_id));
  const entries = input.map((candidate) => ({ candidate, audit: auditCandidate({ candidate, need, policy }) })).sort(compareEntries);
  const rawLeader = entries[0] || null;
  const eligible = entries.filter((entry) => entry.audit.evaluation.eligibility === "eligible");
  const eligibleLeader = eligible[0] || null;
  const scoreTie = eligible.length > 1 && eligible[0].audit.evaluation.candidate_score === eligible[1].audit.evaluation.candidate_score;
  const abandoned = need.status === "superseded";
  const reasons = abandoned ? [] : inconclusiveReasons(eligible, scoreTie);
  const inconclusive = !abandoned && reasons.length > 0;
  const mode = abandoned ? "abandon" : inconclusive ? "ask" : modeFor(eligibleLeader.candidate);
  const selectedProviderId = abandoned || inconclusive ? null : eligibleLeader.candidate.provider_id;
  const retainedWhyNotSelected = abandoned
    ? "The Capability Need is explicitly superseded."
    : inconclusive
      ? readableInconclusiveReason(reasons)
      : "Eligible comparison candidate retained for transparent user review."
  const ranked = selectedRanked(eligible).map((entry) => candidateSummary(entry,
    entry.candidate.provider_id === selectedProviderId
      ? { why_selected: "Highest eligible Phase 1 static score after hard gates." }
      : { why_not_selected: retainedWhyNotSelected }));
  const rejected = entries.filter((entry) => entry.audit.evaluation.eligibility !== "eligible")
    .sort((left, right) => compareText(left.candidate.provider_id, right.candidate.provider_id))
    .map((entry) => candidateSummary(entry, {
      why_not_selected: entry.audit.evaluation.eligibility === "blocked"
        ? "Needs a user decision before Phase 1 eligibility."
        : "Excluded by a static hard gate.",
    }));
  const rejectedProviderIds = rejected.map((entry) => entry.candidate_id);
  const selectedEntry = selectedProviderId ? eligibleLeader : null;
  const selectedCost = selectedEntry ? selectedEntry.candidate.estimated_total_cost : 0;
  const costEvidence = selectedEntry
    ? {
      status: "estimated",
      selected_provider_id: selectedProviderId,
      estimated_total_cost: selectedCost,
      resolution_total_cost: selectedCost,
    }
    : {
      status: abandoned ? "not_applicable" : reasons.includes("total_cost") ? "unknown" : "not_selected",
      selected_provider_id: null,
      estimated_total_cost: null,
      resolution_total_cost: 0,
    };
  const resolutionContent = {
    need_id: need.need_id,
    mode,
    selected_provider_id: selectedProviderId,
    rejected_provider_ids: rejectedProviderIds,
    rationale: abandoned
      ? "The Capability Need is explicitly superseded."
      : inconclusive
      ? `Phase 1 evidence is insufficient for a deterministic adoption proposal. ${readableInconclusiveReason(reasons)}`
      : `Selected ${selectedProviderId} after static hard gates and transparent scoring.`,
    evidence_refs: collectEvidence(entries),
    total_cost: selectedCost,
    approval_status: "pending_user",
    reevaluate_when: ["user_approval", "new_static_metadata", "audition_phase2"],
  };
  const resolution = assertContract("resolution", {
    resolution_id: `CR-${canonicalHash(resolutionContent).slice(0, 12)}`,
    ...resolutionContent,
    status: "proposed",
  });
  return {
    need_id: need.need_id,
    policy_version: "phase1-v1",
    approval_status: "pending_user",
    raw_score_leader: rawLeader ? candidateSummary(rawLeader) : null,
    eligible_leader: eligibleLeader ? candidateSummary(eligibleLeader) : null,
    ranked_candidates: ranked,
    rejected_candidates: rejected,
    inconclusive,
    inconclusive_reasons: reasons,
    cost_evidence: costEvidence,
    resolution,
  };
}

module.exports = { resolveNeed };
