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

function factFor(auditFacts, candidateId) {
  if (Array.isArray(auditFacts)) return auditFacts.find((item) => item && item.candidate_id === candidateId) || null;
  if (auditFacts && typeof auditFacts === "object" && !Array.isArray(auditFacts)) return auditFacts[candidateId] || null;
  return null;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function withAuditFact(candidate, auditFacts) {
  const fact = factFor(auditFacts, candidate.provider_id);
  if (!fact || typeof fact !== "object") return candidate;
  const resolved = {
    ...candidate,
    static_metadata: {
      ...(isPlainObject(candidate.static_metadata) ? candidate.static_metadata : {}),
      ...(isPlainObject(fact.static_metadata) ? fact.static_metadata : {}),
    },
  };
  for (const field of ["axes", "uncertainty_penalty", "unknowns"]) {
    if (Object.hasOwn(fact, field)) resolved[field] = fact[field];
  }
  return resolved;
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
  return {
    candidate_id: entry.candidate.provider_id,
    candidate_score: entry.audit.evaluation.candidate_score,
    eligibility: entry.audit.evaluation.eligibility,
    mode: modeFor(entry.candidate),
    evaluation: entry.audit.evaluation,
    unknowns: entry.audit.unknowns,
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

function resolveNeed({ need, scoutedCandidates = [], auditFacts = [], policy = WEIGHTS_V1 } = {}) {
  assertContract("capability-need", need);
  if (!Array.isArray(scoutedCandidates)) throw new TypeError("scoutedCandidates must be an array.");
  const build = createBuildCandidate({ need, policyVersion: "phase1-v1" });
  const input = [...scoutedCandidates.filter((candidate) => candidate && candidate.provider_id !== build.provider_id), build]
    .map((candidate) => withAuditFact(candidate, auditFacts))
    .map(evaluationCandidate)
    .sort((left, right) => compareText(left.provider_id, right.provider_id));
  const entries = input.map((candidate) => ({ candidate, audit: auditCandidate({ candidate, need, policy }) })).sort(compareEntries);
  const rawLeader = entries[0] || null;
  const eligible = entries.filter((entry) => entry.audit.evaluation.eligibility === "eligible");
  const eligibleLeader = eligible[0] || null;
  const ranked = selectedRanked(eligible).map((entry, index) => candidateSummary(entry, index === 0
    ? { why_selected: "Highest eligible Phase 1 static score after hard gates." }
    : { why_not_selected: "Eligible comparison candidate retained for transparent user review." }));
  const rejected = entries.filter((entry) => entry.audit.evaluation.eligibility !== "eligible")
    .sort((left, right) => compareText(left.candidate.provider_id, right.candidate.provider_id))
    .map((entry) => candidateSummary(entry, {
      why_not_selected: entry.audit.evaluation.eligibility === "blocked"
        ? "Needs a user decision before Phase 1 eligibility."
        : "Excluded by a static hard gate.",
    }));
  const scoreTie = eligible.length > 1 && eligible[0].audit.evaluation.candidate_score === eligible[1].audit.evaluation.candidate_score;
  const unresolvedBuildAccessibility = Boolean(eligibleLeader
    && eligibleLeader.candidate.provider_type === "new_build"
    && (eligibleLeader.audit.unknowns.includes("accessibility") || eligibleLeader.audit.unknowns.includes("accessibility_verification")));
  const uncertainLeader = Boolean(eligibleLeader && (
    eligibleLeader.audit.evaluation.uncertainty_penalty >= 50
    || eligibleLeader.audit.unknowns.includes("score_estimates")
    || eligibleLeader.audit.unknowns.includes("implementation_estimate")
    || unresolvedBuildAccessibility
  ));
  const abandoned = need.status === "superseded";
  const inconclusive = !abandoned && (!eligibleLeader || scoreTie || uncertainLeader);
  const mode = abandoned ? "abandon" : inconclusive ? "ask" : modeFor(eligibleLeader.candidate);
  const selectedProviderId = abandoned || inconclusive ? null : eligibleLeader.candidate.provider_id;
  const rejectedProviderIds = rejected.map((entry) => entry.candidate_id);
  const resolutionContent = {
    need_id: need.need_id,
    mode,
    selected_provider_id: selectedProviderId,
    rejected_provider_ids: rejectedProviderIds,
    rationale: abandoned
      ? "The Capability Need is explicitly superseded."
      : inconclusive
      ? "Phase 1 evidence is insufficient for a deterministic adoption proposal."
      : `Selected ${selectedProviderId} after static hard gates and transparent scoring.`,
    evidence_refs: collectEvidence(entries),
    total_cost: 0,
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
    resolution,
  };
}

module.exports = { resolveNeed };
