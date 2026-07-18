(function exposeWorkbenchViewModel(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.OrquestaWorkbenchViewModel = api;
}(typeof globalThis === "object" ? globalThis : this, function createModule() {
  "use strict";

  const FIXTURE_COPY = Object.freeze({
    "local-reuse": Object.freeze({
      eyebrow: "LOCAL REUSE",
      tab: "既存helperをそのまま使う",
      title: "既存資産で足りるなら、新しく作らない",
      summary: "repository内のatomic JSON helperを見つけ、buildより低コストなreuseを提案します。",
    }),
    "adapt-vs-build": Object.freeze({
      eyebrow: "ADAPT VS BUILD",
      tab: "既存assetを直す方が速い",
      title: "作り直す前に、薄いadaptで済むか比べる",
      summary: "既存browser smokeを小さく直す案と新規buildを、同じ軸と不確実性で比較します。",
    }),
    "blocked-candidate": Object.freeze({
      eyebrow: "HARD GATE",
      tab: "高得点でも採用しない",
      title: "高得点でも、license不明なら採用しない",
      summary: "raw scoreが高い候補でもhard gateを通らなければ棄却し、安全なbuildへ戻します。",
    }),
  });

  function fail(code, message) {
    const error = new Error(message);
    error.code = code;
    throw error;
  }

  function entries(value) {
    return Object.entries(value || {}).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  }

  function candidateMode(candidate, review) {
    if (String(candidate.candidate_id).startsWith("build:")) return "build";
    if (candidate.candidate_id === review.proposed_provider_id) return review.proposed_mode;
    return "candidate";
  }

  function buildNeeds(review) {
    const known = [...new Map((review.resolution_summaries || []).map((resolution) => [resolution.need_id, resolution])).values()];
    return Array.from({ length: review.need_count }, (_, index) => {
      const resolution = known[index] || null;
      return {
        index: index + 1,
        needId: resolution ? resolution.need_id : `unresolved-${index + 1}`,
        resolutionId: resolution ? resolution.resolution_id : null,
        mode: resolution ? resolution.mode : "unresolved",
        selectedProviderId: resolution ? resolution.selected_provider_id : null,
        verification: resolution && resolution.evidence_refs.length ? "evidence linked" : "fixture assertion",
      };
    });
  }

  function buildWorkbenchView(apiState, options = {}) {
    if (!apiState || typeof apiState !== "object") fail("V4_WORKBENCH_STATE_INVALID", "Workbench state is required.");
    const selectedFixtureId = options.selectedFixtureId || apiState.current_fixture;
    const fixture = (apiState.fixtures || []).find((item) => item.fixture_id === selectedFixtureId);
    if (!fixture || !fixture.review_view) fail("V4_WORKBENCH_FIXTURE_NOT_LOADED", "Load the selected fixture before building its review view.");
    const copy = FIXTURE_COPY[selectedFixtureId] || { eyebrow: selectedFixtureId, tab: selectedFixtureId, title: selectedFixtureId, summary: "" };
    const review = fixture.review_view;
    const candidates = (review.evaluation_evidence || []).map((candidate) => {
      const gates = entries(candidate.hard_gates).map(([name, status]) => ({ name, status }));
      const failedGates = gates.filter((gate) => gate.status === "fail").map((gate) => gate.name);
      return {
        candidateId: candidate.candidate_id,
        needId: candidate.need_id,
        mode: candidateMode(candidate, review),
        score: candidate.candidate_score,
        weightedSum: candidate.weighted_sum,
        uncertaintyPenalty: candidate.uncertainty_penalty,
        eligibility: candidate.eligibility,
        selected: candidate.candidate_id === review.proposed_provider_id,
        highestRawScore: candidate.candidate_id === review.highest_raw_score_provider_id,
        rejectionReasons: failedGates,
        gates,
        axisContributions: entries(candidate.axis_contributions).map(([axis, contribution]) => ({
          axis,
          value: candidate.axis_values ? candidate.axis_values[axis] : null,
          contribution,
        })),
        actualModel: candidate.actual_model === null ? "unavailable" : String(candidate.actual_model),
      };
    });

    return {
      product: apiState.product,
      phaseId: apiState.phase_id,
      fixtureId: selectedFixtureId,
      fixtureTabs: (apiState.fixtures || []).map((item) => ({
        fixtureId: item.fixture_id,
        active: item.fixture_id === selectedFixtureId,
        loaded: item.status === "loaded",
        ...(FIXTURE_COPY[item.fixture_id] || { eyebrow: item.fixture_id, tab: item.fixture_id }),
      })),
      outcome: { title: copy.title, summary: copy.summary, eyebrow: copy.eyebrow },
      needs: buildNeeds(review),
      candidates,
      decision: {
        mode: review.proposed_mode,
        providerId: review.proposed_provider_id,
        approvalStatus: review.approval_status,
        writesApproval: false,
        rawLeaderId: review.highest_raw_score_provider_id,
        rawLeaderEligible: review.highest_raw_score_eligible,
        rejectionGate: review.rejection_gate,
        cost: review.cost_evidence,
      },
      evidence: {
        providers: (review.provider_evidence || []).map((item) => ({
          providerId: item.provider_id,
          sourceType: item.source_type,
          evidenceRefs: [...(item.evidence_refs || [])],
        })),
        adaptation: [...(review.adaptation_evidence || [])],
        scout: review.scout_invoked ? "invoked" : (review.scout_skip_reason || "not invoked"),
      },
      contextPack: {
        status: review.context_pack_status,
        requiredReading: [...(review.required_reading || [])],
        intentGraphEnabled: false,
      },
      timeline: [...(review.timeline_event_types || [])],
      journal: {
        batchCount: apiState.journal ? apiState.journal.batch_count : 0,
        eventCount: apiState.journal ? apiState.journal.event_count : 0,
        fixtureIds: apiState.journal ? [...apiState.journal.fixture_ids] : [],
      },
      limits: {
        actualModel: "unavailable",
        audition: review.audition_status,
        approvalPath: "Codex orchestrator task",
        items: [...(apiState.limitations || [])],
      },
    };
  }

  return { FIXTURE_COPY, buildWorkbenchView };
}));
