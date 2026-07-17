"use strict";

const { assertContract, canonicalHash } = require("@orquesta/contracts");
const { evaluateHardGates, staticFacts } = require("./hard-gates");
const { reconcileLiveEvidence } = require("./phase2-facts");
const { WEIGHTS_V1, auditError, scoreCandidate } = require("./score");

const RESPONSIBILITY = Object.freeze({
  scout: "candidate_and_evidence_only",
  audit: "metadata_checks_only",
  audition: "disabled_until_phase2",
  orchestrator: "proposal_and_evidence_reconciliation",
  user: "all_phase1_adoption_approval",
});

function candidateId(candidate) {
  const value = candidate && (candidate.provider_id || candidate.candidate_id);
  if (typeof value !== "string" || !value) throw auditError("AUDIT_CANDIDATE_INVALID", "Candidate requires a stable provider_id.");
  return value;
}

function assertNeed(need) {
  try {
    return assertContract("capability-need", need);
  } catch (error) {
    throw auditError("AUDIT_NEED_INVALID", "Audit requires a valid Capability Need.", { errors: error.errors || [] });
  }
}

function evaluateCandidate({ candidate, need, axes = candidate && candidate.axes, uncertaintyPenalty = candidate && candidate.uncertainty_penalty, policyVersion = "phase1-v1", policy = WEIGHTS_V1 } = {}) {
  const validNeed = assertNeed(need);
  const id = candidateId(candidate);
  if (typeof policyVersion !== "string" || !policyVersion) throw auditError("AUDIT_POLICY_VERSION_INVALID", "Policy version is required.");
  const gates = evaluateHardGates({ candidate, need: validNeed });
  const score = scoreCandidate({ axes, uncertaintyPenalty, policy });
  const fingerprint = {
    need_id: validNeed.need_id,
    candidate_id: id,
    policy_version: policyVersion,
    axes,
    uncertainty_penalty: uncertaintyPenalty,
    weighted_sum: score.weighted_sum,
    candidate_score: score.candidate_score,
    hard_gate_results: gates.hard_gate_results,
    eligibility: gates.eligibility,
  };
  const evaluation = {
    evaluation_id: `CE-${canonicalHash(fingerprint).slice(0, 12)}`,
    ...fingerprint,
    actual_model: null,
  };
  return assertContract("candidate-evaluation", evaluation);
}

function auditCandidate({ candidate, need, axes = candidate && candidate.axes, uncertaintyPenalty = candidate && candidate.uncertainty_penalty, policyVersion = "phase1-v1", policy = WEIGHTS_V1 } = {}) {
  const evaluation = evaluateCandidate({ candidate, need, axes, uncertaintyPenalty, policyVersion, policy });
  const evidence = scoreCandidate({ axes, uncertaintyPenalty, policy });
  const metadata = staticFacts({ candidate, need });
  return {
    audit_mode: "phase1_static_metadata",
    facts: metadata.facts,
    unknowns: metadata.unknowns,
    hard_gate_results: evaluation.hard_gate_results,
    responsibility: { ...RESPONSIBILITY },
    score_contributions: evidence.contributions,
    evaluation,
  };
}

function auditLiveCandidate({ candidate, need, sourceEvidence, policyVersion = "phase2-v1", policy = WEIGHTS_V1 } = {}) {
  const live = reconcileLiveEvidence({ candidate, sourceEvidence });
  const audited = auditCandidate({
    candidate: live.candidate,
    need,
    policyVersion,
    policy,
  });
  return {
    audit_mode: "phase2_source_bound",
    candidate_id: live.candidate.provider_id,
    policy_version: policyVersion,
    static_metadata: { ...live.candidate.static_metadata },
    unknowns: audited.unknowns,
    ...(Object.hasOwn(live.candidate, "estimated_total_cost")
      ? { estimated_total_cost: live.candidate.estimated_total_cost }
      : {}),
    facts: audited.facts,
    fact_provenance: live.fact_provenance,
    hard_gate_results: audited.hard_gate_results,
    responsibility: { ...RESPONSIBILITY, audit: "source_bound_metadata_checks_only" },
    evaluation: audited.evaluation,
  };
}

module.exports = { RESPONSIBILITY, WEIGHTS_V1, auditCandidate, auditLiveCandidate, evaluateCandidate, scoreCandidate };
