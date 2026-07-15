"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { assertContract } = require("@orquesta/contracts");
const { WEIGHTS_V1 } = require("@orquesta/audit");
const { createBuildCandidate, resolveNeed } = require("../src");

const need = {
  need_id: "CN-RESOLVE-001",
  description: "Browser verification evidence",
  kind: "evidence",
  required_level: "required",
  hard_constraints: [],
  dependencies: [],
  verification_method: "Record a repeatable local browser check",
  status: "open",
  confidence: 100,
};

function axes(value) {
  return {
    task_fit: { value, reason: "fixture task fit" },
    integration_ease: { value, reason: "fixture runtime" },
    evidence_strength: { value, reason: "fixture evidence" },
    maintainability: { value, reason: "fixture maintenance" },
    security: { value, reason: "fixture metadata" },
    license_fit: { value, reason: "fixture license" },
    exit_option: { value, reason: "fixture removal" },
    cost: { value, reason: "fixture cost" },
  };
}

function candidate(providerId, value, staticMetadata, resolutionMode = "reuse") {
  return {
    provider_id: providerId,
    provider_type: "fixture",
    source_uri: `fixture:${providerId}`,
    capabilities: ["browser verification evidence"],
    trust_tier: "local",
    availability: "available",
    version: "1.0.0",
    evidence_refs: [`fixture:${providerId}`],
    resolution_mode: resolutionMode,
    static_metadata: staticMetadata,
    axes: axes(value),
    uncertainty_penalty: 5,
  };
}

test("resolver includes one conservative deterministic build candidate for every Need", () => {
  const build = createBuildCandidate({ need, policyVersion: "phase1-v1" });
  assert.equal(build.provider_id, "build:CN-RESOLVE-001");
  assert.equal(build.provider_type, "new_build");
  assert.equal(build.trust_tier, "local");
  assert.equal(build.resolution_mode, "build");
  assert.equal(build.uncertainty_penalty, 100);
  assert.ok(build.unknowns.includes("implementation_estimate"));
});

test("resolver separates raw and eligible leaders, keeps hard rejects and needs-user candidates out of ranking", () => {
  const proposal = resolveNeed({
    need,
    scoutedCandidates: [
      candidate("reuse-safe", 80, { license: "MIT", runtime: "compatible", security: "no_critical_finding" }),
      candidate("rejected-license", 99, { license: "forbidden", runtime: "compatible", security: "no_critical_finding" }),
      candidate("blocked-payment", 95, { license: "MIT", runtime: "compatible", security: "no_critical_finding", payment: true }),
    ],
    auditFacts: [],
    policy: WEIGHTS_V1,
  });

  assert.equal(proposal.raw_score_leader.candidate_id, "rejected-license");
  assert.equal(proposal.eligible_leader.candidate_id, "reuse-safe");
  assert.ok(proposal.ranked_candidates.length <= 3);
  assert.ok(proposal.ranked_candidates.some((entry) => entry.candidate_id === "build:CN-RESOLVE-001"));
  assert.equal(proposal.ranked_candidates.some((entry) => entry.candidate_id === "rejected-license"), false);
  assert.equal(proposal.ranked_candidates.some((entry) => entry.candidate_id === "blocked-payment"), false);
  assert.deepEqual(
    proposal.rejected_candidates.map((entry) => [entry.candidate_id, entry.eligibility]),
    [["blocked-payment", "blocked"], ["rejected-license", "ineligible"]],
  );
  assert.equal(proposal.resolution.mode, "reuse");
  assert.equal(proposal.resolution.approval_status, "pending_user");
  assert.equal(proposal.inconclusive, false);
  assert.ok(proposal.ranked_candidates[0].why_selected);
  assert.ok(proposal.ranked_candidates.slice(1).every((entry) => entry.why_not_selected));
  assert.ok(proposal.rejected_candidates.every((entry) => entry.why_not_selected));
  assert.doesNotThrow(() => assertContract("resolution", proposal.resolution));
});

test("resolver keeps exactly one synthetic build candidate and is stable across Scout order", () => {
  const duplicatedBuild = createBuildCandidate({ need, policyVersion: "phase1-v1" });
  const safe = candidate("reuse-safe", 80, { license: "MIT", runtime: "compatible", security: "no_critical_finding" });
  const first = resolveNeed({ need, scoutedCandidates: [duplicatedBuild, safe], auditFacts: [], policy: WEIGHTS_V1 });
  const second = resolveNeed({ need, scoutedCandidates: [safe, duplicatedBuild], auditFacts: [], policy: WEIGHTS_V1 });
  const candidateIds = [
    ...first.ranked_candidates.map((entry) => entry.candidate_id),
    ...first.rejected_candidates.map((entry) => entry.candidate_id),
  ];
  assert.equal(candidateIds.filter((id) => id === "build:CN-RESOLVE-001").length, 1);
  assert.deepEqual(first, second);
});

test("resolver asks when only unknown-estimate build evidence is available", () => {
  const proposal = resolveNeed({ need, scoutedCandidates: [], auditFacts: [], policy: WEIGHTS_V1 });
  assert.equal(proposal.inconclusive, true);
  assert.equal(proposal.resolution.mode, "ask");
  assert.equal(proposal.resolution.selected_provider_id, null);
  assert.equal(proposal.resolution.approval_status, "pending_user");
  assert.equal(proposal.ranked_candidates.length, 1);
  assert.equal(proposal.ranked_candidates[0].candidate_id, "build:CN-RESOLVE-001");
});

test("resolver keeps a planned but unverified build candidate comparable for an accessibility-required Need", () => {
  const accessibilityNeed = { ...need, hard_constraints: ["accessibility_required"] };
  const proposal = resolveNeed({ need: accessibilityNeed, scoutedCandidates: [], auditFacts: [], policy: WEIGHTS_V1 });

  assert.equal(proposal.ranked_candidates.length, 1);
  assert.equal(proposal.ranked_candidates[0].candidate_id, "build:CN-RESOLVE-001");
  assert.equal(proposal.ranked_candidates[0].eligibility, "eligible");
  assert.equal(proposal.ranked_candidates[0].evaluation.hard_gate_results.find((gate) => gate.gate === "accessibility").status, "pass");
  assert.ok(proposal.ranked_candidates[0].unknowns.includes("accessibility_verification"));
  assert.equal(proposal.resolution.mode, "ask");

  const partiallyEvidencedBuild = resolveNeed({
    need: accessibilityNeed,
    scoutedCandidates: [],
    auditFacts: [{
      candidate_id: "build:CN-RESOLVE-001",
      static_metadata: { license: "not_applicable", runtime: "compatible", security: "no_critical_finding" },
      axes: axes(70),
      uncertainty_penalty: 4,
    }],
    policy: WEIGHTS_V1,
  });
  const partiallyEvidencedEntry = partiallyEvidencedBuild.ranked_candidates.find((entry) => entry.candidate_id === "build:CN-RESOLVE-001");
  assert.ok(partiallyEvidencedEntry);
  assert.equal(partiallyEvidencedEntry.eligibility, "eligible");
  assert.ok(partiallyEvidencedEntry.unknowns.includes("accessibility"));
  assert.ok(partiallyEvidencedEntry.unknowns.includes("accessibility_verification"));
  assert.equal(partiallyEvidencedBuild.inconclusive, true);
  assert.equal(partiallyEvidencedBuild.resolution.mode, "ask");
  assert.equal(partiallyEvidencedBuild.resolution.selected_provider_id, null);

  const explicitlyUnverifiedBuild = resolveNeed({
    need: accessibilityNeed,
    scoutedCandidates: [],
    auditFacts: [{
      candidate_id: "build:CN-RESOLVE-001",
      static_metadata: { license: "not_applicable", runtime: "compatible", security: "no_critical_finding" },
      axes: axes(70),
      uncertainty_penalty: 4,
      unknowns: ["accessibility_verification"],
    }],
    policy: WEIGHTS_V1,
  });
  assert.equal(explicitlyUnverifiedBuild.inconclusive, true);
  assert.equal(explicitlyUnverifiedBuild.resolution.mode, "ask");
  assert.equal(explicitlyUnverifiedBuild.resolution.selected_provider_id, null);

  const plannedBuildWithNoExplicitUnknowns = resolveNeed({
    need: accessibilityNeed,
    scoutedCandidates: [],
    auditFacts: [{
      candidate_id: "build:CN-RESOLVE-001",
      static_metadata: { license: "not_applicable", runtime: "compatible", security: "no_critical_finding" },
      axes: axes(70),
      uncertainty_penalty: 4,
      unknowns: [],
    }],
    policy: WEIGHTS_V1,
  });
  assert.equal(plannedBuildWithNoExplicitUnknowns.inconclusive, true);
  assert.equal(plannedBuildWithNoExplicitUnknowns.resolution.mode, "ask");
  assert.equal(plannedBuildWithNoExplicitUnknowns.resolution.selected_provider_id, null);

  const verifiedBuild = resolveNeed({
    need: accessibilityNeed,
    scoutedCandidates: [],
    auditFacts: [{
      candidate_id: "build:CN-RESOLVE-001",
      static_metadata: { license: "not_applicable", runtime: "compatible", security: "no_critical_finding", accessibility: "met" },
      axes: axes(70),
      uncertainty_penalty: 4,
      unknowns: [],
    }],
    policy: WEIGHTS_V1,
  });
  assert.equal(verifiedBuild.inconclusive, false);
  assert.equal(verifiedBuild.resolution.mode, "build");
  assert.equal(verifiedBuild.resolution.selected_provider_id, "build:CN-RESOLVE-001");

  const unmetThirdParty = candidate("reuse-unmet", 80, {
    license: "MIT",
    runtime: "compatible",
    security: "no_critical_finding",
    accessibility: "unmet",
  });
  const thirdPartyProposal = resolveNeed({ need: accessibilityNeed, scoutedCandidates: [unmetThirdParty], auditFacts: [], policy: WEIGHTS_V1 });
  assert.equal(thirdPartyProposal.rejected_candidates.find((entry) => entry.candidate_id === "reuse-unmet").eligibility, "ineligible");
  assert.equal(thirdPartyProposal.ranked_candidates.some((entry) => entry.candidate_id === "reuse-unmet"), false);

  const missingThirdParty = candidate("reuse-missing", 80, {
    license: "MIT",
    runtime: "compatible",
    security: "no_critical_finding",
  });
  const missingProposal = resolveNeed({ need: accessibilityNeed, scoutedCandidates: [missingThirdParty], auditFacts: [], policy: WEIGHTS_V1 });
  assert.equal(missingProposal.rejected_candidates.find((entry) => entry.candidate_id === "reuse-missing").eligibility, "ineligible");
});

test("resolver treats explicit Audit facts as authoritative without erasing omitted candidate evidence", () => {
  const selfClaimedSafe = candidate("self-claimed-safe", 80, {
    license: "MIT",
    runtime: "compatible",
    security: "no_critical_finding",
  });
  const forbiddenAudit = resolveNeed({
    need,
    scoutedCandidates: [selfClaimedSafe],
    auditFacts: [{
      candidate_id: "self-claimed-safe",
      static_metadata: { license: "forbidden" },
      unknowns: ["license_provenance"],
    }],
    policy: WEIGHTS_V1,
  });
  const rejectedSelfClaim = forbiddenAudit.rejected_candidates.find((entry) => entry.candidate_id === "self-claimed-safe");
  assert.ok(rejectedSelfClaim, "An explicit forbidden Audit fact must move the self-claimed candidate out of ranking.");
  assert.equal(rejectedSelfClaim.eligibility, "ineligible");
  assert.equal(forbiddenAudit.ranked_candidates.some((entry) => entry.candidate_id === "self-claimed-safe"), false);
  assert.deepEqual(rejectedSelfClaim.unknowns, ["license_provenance"]);

  const selfClaimedForbidden = candidate("self-claimed-forbidden", 80, {
    license: "forbidden",
    runtime: "compatible",
    security: "no_critical_finding",
  });
  const confirmedAudit = resolveNeed({
    need,
    scoutedCandidates: [selfClaimedForbidden],
    auditFacts: [{
      candidate_id: "self-claimed-forbidden",
      static_metadata: { license: "MIT" },
      axes: axes(60),
      uncertainty_penalty: 7,
      unknowns: ["audit_follow_up"],
    }],
    policy: WEIGHTS_V1,
  });
  const confirmedCandidate = confirmedAudit.ranked_candidates.find((entry) => entry.candidate_id === "self-claimed-forbidden");
  assert.equal(confirmedCandidate.eligibility, "eligible");
  assert.equal(confirmedCandidate.candidate_score, 53);
  assert.deepEqual(confirmedCandidate.unknowns, ["audit_follow_up"]);

  const buildEvidence = resolveNeed({
    need,
    scoutedCandidates: [],
    auditFacts: [{
      candidate_id: "build:CN-RESOLVE-001",
      static_metadata: { license: "not_applicable", runtime: "compatible", security: "no_critical_finding" },
      axes: axes(70),
      uncertainty_penalty: 4,
      unknowns: [],
    }],
    policy: WEIGHTS_V1,
  });
  const evidencedBuild = buildEvidence.ranked_candidates.find((entry) => entry.candidate_id === "build:CN-RESOLVE-001");
  assert.equal(evidencedBuild.candidate_score, 66);
  assert.deepEqual(evidencedBuild.unknowns, []);
  assert.equal(buildEvidence.resolution.mode, "build");
});

test("resolver abandons only an explicitly superseded Need", () => {
  const proposal = resolveNeed({
    need: { ...need, status: "superseded" },
    scoutedCandidates: [candidate("reuse-safe", 80, { license: "MIT", runtime: "compatible", security: "no_critical_finding" })],
    auditFacts: [],
    policy: WEIGHTS_V1,
  });
  assert.equal(proposal.inconclusive, false);
  assert.equal(proposal.resolution.mode, "abandon");
  assert.equal(proposal.resolution.selected_provider_id, null);
  assert.equal(proposal.resolution.approval_status, "pending_user");
});
