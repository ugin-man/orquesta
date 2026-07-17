"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { assertContract } = require("@orquesta/contracts");
const { WEIGHTS_V1, auditLiveCandidate } = require("@orquesta/audit");
const { createOfficialDocsConnector, toAuditLiveCandidateInput } = require("../../acquisition/src");
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

function candidate(providerId, value, staticMetadata, resolutionMode = "reuse", overrides = {}) {
  return {
    provider_id: providerId,
    provider_type: "fixture",
    source_uri: `fixture:${providerId}`,
    source_ref: `https://example.test/official/${providerId}`,
    source_hash: "b".repeat(64),
    capabilities: ["browser verification evidence"],
    trust_tier: "local",
    availability: "available",
    version: "1.0.0",
    evidence_refs: [`fixture:${providerId}`],
    resolution_mode: resolutionMode,
    static_metadata: staticMetadata,
    axes: axes(value),
    uncertainty_penalty: 5,
    estimated_total_cost: 0,
    ...overrides,
  };
}

function resolverError(run, code) {
  let thrown = null;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, `Expected ${code}.`);
  assert.equal(thrown.code, code);
  return { code: thrown.code, details: thrown.details };
}

test("resolver includes one conservative deterministic build candidate for every Need", () => {
  const build = createBuildCandidate({ need, policyVersion: "phase1-v1" });
  assert.equal(build.provider_id, "build:CN-RESOLVE-001");
  assert.equal(build.provider_type, "new_build");
  assert.equal(build.trust_tier, "local");
  assert.equal(build.resolution_mode, "build");
  assert.equal(build.uncertainty_penalty, 100);
  assert.ok(build.unknowns.includes("implementation_estimate"));
  assert.ok(build.unknowns.includes("total_cost"));
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
      estimated_total_cost: 0,
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
      estimated_total_cost: 0,
    }],
    policy: WEIGHTS_V1,
  });
  const evidencedBuild = buildEvidence.ranked_candidates.find((entry) => entry.candidate_id === "build:CN-RESOLVE-001");
  assert.equal(evidencedBuild.candidate_score, 66);
  assert.deepEqual(evidencedBuild.unknowns, []);
  assert.equal(buildEvidence.resolution.mode, "build");
});

test("resolver rejects duplicate array Audit facts in a stable order-independent error", () => {
  const mit = { candidate_id: "reuse-a", static_metadata: { license: "MIT" } };
  const forbidden = { candidate_id: "reuse-a", static_metadata: { license: "forbidden" } };
  const first = resolverError(
    () => resolveNeed({ need, scoutedCandidates: [candidate("reuse-a", 80, { license: "MIT", runtime: "compatible", security: "no_critical_finding" })], auditFacts: [mit, forbidden], policy: WEIGHTS_V1 }),
    "RESOLVER_AUDIT_FACT_DUPLICATE",
  );
  const second = resolverError(
    () => resolveNeed({ need, scoutedCandidates: [candidate("reuse-a", 80, { license: "MIT", runtime: "compatible", security: "no_critical_finding" })], auditFacts: [forbidden, mit], policy: WEIGHTS_V1 }),
    "RESOLVER_AUDIT_FACT_DUPLICATE",
  );
  assert.deepEqual(first, second);
  assert.deepEqual(first.details, { candidate_ids: ["reuse-a"] });
});

test("resolver rejects duplicate non-synthetic providers and keeps resolution identifiers disjoint", () => {
  const duplicate = candidate("reuse-a", 80, { license: "MIT", runtime: "compatible", security: "no_critical_finding" });
  const conflictingDuplicate = candidate("reuse-a", 95, { license: "forbidden", runtime: "compatible", security: "no_critical_finding" });
  const error = resolverError(
    () => resolveNeed({ need, scoutedCandidates: [duplicate, conflictingDuplicate], auditFacts: [], policy: WEIGHTS_V1 }),
    "RESOLVER_SCOUTED_CANDIDATE_DUPLICATE",
  );
  assert.deepEqual(error.details, { provider_ids: ["reuse-a"] });

  const callerBuild = createBuildCandidate({ need, policyVersion: "phase1-v1" });
  const proposal = resolveNeed({ need, scoutedCandidates: [callerBuild, callerBuild, duplicate], auditFacts: [], policy: WEIGHTS_V1 });
  const rankedIds = proposal.ranked_candidates.map((entry) => entry.candidate_id);
  const rejectedIds = proposal.rejected_candidates.map((entry) => entry.candidate_id);
  assert.equal([...rankedIds, ...rejectedIds].filter((id) => id === "build:CN-RESOLVE-001").length, 1);
  assert.deepEqual(rankedIds.filter((id) => rejectedIds.includes(id)), []);
  assert.equal(proposal.resolution.rejected_provider_ids.includes(proposal.resolution.selected_provider_id), false);
  assert.ok(rankedIds.includes(proposal.resolution.selected_provider_id));
});

test("resolver treats exact Audit license unknown as ineligible before selection", () => {
  const proposal = resolveNeed({
    need,
    scoutedCandidates: [candidate("reuse-a", 80, { license: "MIT", runtime: "compatible", security: "no_critical_finding" })],
    auditFacts: [{ candidate_id: "reuse-a", unknowns: ["license"] }],
    policy: WEIGHTS_V1,
  });
  const rejected = proposal.rejected_candidates.find((entry) => entry.candidate_id === "reuse-a");
  assert.ok(rejected);
  assert.equal(rejected.eligibility, "ineligible");
  assert.equal(proposal.ranked_candidates.some((entry) => entry.candidate_id === "reuse-a"), false);
  assert.equal(proposal.resolution.selected_provider_id, null);
});

test("resolver keeps total-cost estimates distinct from the cost score axis", () => {
  const unknownCost = candidate("reuse-unknown", 80, { license: "MIT", runtime: "compatible", security: "no_critical_finding" });
  delete unknownCost.estimated_total_cost;
  const unknownProposal = resolveNeed({ need, scoutedCandidates: [unknownCost], auditFacts: [], policy: WEIGHTS_V1 });
  const unknownSummary = unknownProposal.ranked_candidates.find((entry) => entry.candidate_id === "reuse-unknown");
  assert.equal(unknownProposal.inconclusive, true);
  assert.equal(unknownProposal.resolution.mode, "ask");
  assert.equal(unknownProposal.resolution.selected_provider_id, null);
  assert.equal(unknownProposal.resolution.total_cost, 0);
  assert.equal(unknownSummary.estimated_total_cost, null);
  assert.equal(unknownSummary.cost_status, "unknown");
  assert.equal(unknownProposal.cost_evidence.status, "unknown");
  assert.ok(unknownSummary.unknowns.includes("total_cost"));

  const zeroProposal = resolveNeed({
    need,
    scoutedCandidates: [candidate("reuse-zero", 80, { license: "MIT", runtime: "compatible", security: "no_critical_finding" })],
    auditFacts: [],
    policy: WEIGHTS_V1,
  });
  assert.equal(zeroProposal.resolution.mode, "reuse");
  assert.equal(zeroProposal.resolution.total_cost, 0);
  assert.equal(zeroProposal.ranked_candidates[0].estimated_total_cost, 0);
  assert.equal(zeroProposal.ranked_candidates[0].cost_status, "estimated");
  assert.equal(zeroProposal.cost_evidence.status, "estimated");

  const positiveProposal = resolveNeed({
    need,
    scoutedCandidates: [candidate("reuse-positive", 80, { license: "MIT", runtime: "compatible", security: "no_critical_finding" })],
    auditFacts: [{ candidate_id: "reuse-positive", estimated_total_cost: 42 }],
    policy: WEIGHTS_V1,
  });
  assert.equal(positiveProposal.resolution.mode, "reuse");
  assert.equal(positiveProposal.resolution.total_cost, 42);
  assert.equal(positiveProposal.ranked_candidates[0].estimated_total_cost, 42);
  assert.equal(positiveProposal.cost_evidence.estimated_total_cost, 42);

  const staleUnknown = candidate("reuse-stale-cost", 80, { license: "MIT", runtime: "compatible", security: "no_critical_finding" }, "reuse", {
    unknowns: ["total_cost", "runtime"],
  });
  delete staleUnknown.estimated_total_cost;
  const reconciledProposal = resolveNeed({
    need,
    scoutedCandidates: [staleUnknown],
    auditFacts: [{ candidate_id: "reuse-stale-cost", estimated_total_cost: 17 }],
    policy: WEIGHTS_V1,
  });
  const reconciledSummary = reconciledProposal.ranked_candidates.find((entry) => entry.candidate_id === "reuse-stale-cost");
  assert.equal(reconciledProposal.resolution.mode, "reuse");
  assert.equal(reconciledSummary.estimated_total_cost, 17);
  assert.equal(reconciledSummary.cost_status, "estimated");
  assert.deepEqual(reconciledSummary.unknowns, ["runtime"]);

  for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, "zero"]) {
    resolverError(
      () => resolveNeed({ need, scoutedCandidates: [candidate("invalid-cost", 80, { license: "MIT", runtime: "compatible", security: "no_critical_finding" }, "reuse", { estimated_total_cost: value })], auditFacts: [], policy: WEIGHTS_V1 }),
      "RESOLVER_ESTIMATED_TOTAL_COST_INVALID",
    );
  }
  resolverError(
    () => resolveNeed({
      need,
      scoutedCandidates: [candidate("invalid-audit-cost", 80, { license: "MIT", runtime: "compatible", security: "no_critical_finding" })],
      auditFacts: [{ candidate_id: "invalid-audit-cost", estimated_total_cost: "zero" }],
      policy: WEIGHTS_V1,
    }),
    "RESOLVER_ESTIMATED_TOTAL_COST_INVALID",
  );
});

test("resolver never labels a retained candidate selected for ask or abandon proposals", () => {
  const tied = resolveNeed({
    need,
    scoutedCandidates: [
      candidate("reuse-a", 80, { license: "MIT", runtime: "compatible", security: "no_critical_finding" }),
      candidate("reuse-b", 80, { license: "MIT", runtime: "compatible", security: "no_critical_finding" }),
    ],
    auditFacts: [],
    policy: WEIGHTS_V1,
  });
  assert.equal(tied.inconclusive, true);
  assert.deepEqual(tied.inconclusive_reasons, ["score_tie"]);
  assert.equal(tied.cost_evidence.status, "not_selected");
  assert.equal(tied.ranked_candidates.some((entry) => entry.why_selected), false);
  assert.ok(tied.ranked_candidates.every((entry) => entry.why_not_selected));

  const highPenalty = resolveNeed({
    need,
    scoutedCandidates: [candidate("reuse-high-penalty", 80, { license: "MIT", runtime: "compatible", security: "no_critical_finding" }, "reuse", { uncertainty_penalty: 50 })],
    auditFacts: [],
    policy: WEIGHTS_V1,
  });
  assert.equal(highPenalty.inconclusive, true);
  assert.deepEqual(highPenalty.inconclusive_reasons, ["high_uncertainty_penalty"]);
  assert.equal(highPenalty.cost_evidence.status, "not_selected");
  assert.equal(highPenalty.ranked_candidates.some((entry) => entry.why_selected), false);
  assert.ok(highPenalty.ranked_candidates.every((entry) => entry.why_not_selected));

  const abandoned = resolveNeed({
    need: { ...need, status: "superseded" },
    scoutedCandidates: [candidate("reuse-superseded", 80, { license: "MIT", runtime: "compatible", security: "no_critical_finding" })],
    auditFacts: [],
    policy: WEIGHTS_V1,
  });
  assert.equal(abandoned.resolution.mode, "abandon");
  assert.equal(abandoned.ranked_candidates.some((entry) => entry.why_selected), false);
  assert.ok(abandoned.ranked_candidates.every((entry) => entry.why_not_selected));
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

test("resolver accepts the source-bound live Audit fact without treating self-report as authority", () => {
  const liveFact = auditLiveCandidate({
    candidate: candidate("live-source", 80, { license: "forbidden", runtime: "compatible", security: "no_critical_finding" }),
    need,
    sourceEvidence: [{
      source_id: "source:official-license",
      source_ref: "https://example.test/official/live-source",
      source_hash: "b".repeat(64),
      freshness: "fresh",
      authoritative_fields: ["cost", "license"],
      facts: { cost: 12, license: "MIT" },
      unknowns: [],
    }],
    policyVersion: "phase2-v1",
  });
  const proposal = resolveNeed({
    need,
    scoutedCandidates: [candidate("live-source", 80, { license: "forbidden", runtime: "compatible", security: "no_critical_finding" })],
    auditFacts: [liveFact],
    policy: WEIGHTS_V1,
  });
  assert.equal(proposal.resolution.mode, "reuse");
  assert.equal(proposal.resolution.selected_provider_id, "live-source");
  assert.equal(proposal.resolution.total_cost, 12);
});

test("real connector evidence converts deterministically into source-bound Audit input before Resolver selection", async () => {
  const connector = createOfficialDocsConnector({
    baseUrl: "https://platform.openai.com/docs",
    transport: {
      async request() {
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            items: [{
              id: "source-bound",
              source_uri: "https://platform.openai.com/docs/source-bound",
              version: "1.0.0",
              license: "MIT",
              maintenance: "maintained",
              security: "no_critical_finding",
              compatibility: "compatible",
              accessibility: "met",
              cost: 12,
            }],
          }),
          captured_at: "2026-07-16T00:00:00.000Z",
        };
      },
    },
    clock: () => "2026-07-16T00:00:00.000Z",
  });
  const sourceResult = await connector.search({
    query: {
      need_id: need.need_id,
      query_terms: ["source-bound"],
      allowed_connector_ids: ["official_docs"],
      request_budget: { max_requests_per_need: 8, max_requests_per_connector: 2 },
      candidate_limit: 3,
      requested_at: "2026-07-16T00:00:00.000Z",
    },
  });
  const discovered = sourceResult.candidates[0];
  const input = toAuditLiveCandidateInput({
    sourceResult,
    candidate: candidate(discovered.candidate_id, 80, { license: "forbidden", runtime: "incompatible", security: "critical" }, "reuse", {
      source_uri: discovered.source_ref,
      source_ref: discovered.source_ref,
      source_hash: discovered.source_hash,
      evidence_refs: [discovered.source_ref],
    }),
  });
  const audited = auditLiveCandidate({ ...input, need, policyVersion: "phase2-v1" });
  const proposal = resolveNeed({ need, scoutedCandidates: [input.candidate], auditFacts: [audited], policy: WEIGHTS_V1 });

  assert.equal(audited.static_metadata.license, "MIT");
  assert.equal(proposal.resolution.selected_provider_id, "official_docs:source-bound");
  assert.equal(proposal.resolution.total_cost, 12);
});
