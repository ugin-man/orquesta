"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { buildWorkbenchView } = require("../public/view-model");

function fixtureState() {
  return {
    product: "Orquesta V4 Preview",
    phase_id: "phase-1",
    current_fixture: "blocked-candidate",
    fixtures: [
      { fixture_id: "local-reuse", status: "loaded", review_view: null },
      { fixture_id: "adapt-vs-build", status: "loaded", review_view: null },
      {
        fixture_id: "blocked-candidate",
        status: "loaded",
        review_view: {
          proposed_mode: "build",
          proposed_provider_id: "build:CN-001",
          highest_raw_score_provider_id: "ui-catalog-unknown-license",
          highest_raw_score_eligible: false,
          rejection_gate: "license",
          need_count: 2,
          candidate_evaluation_count: 2,
          approval_status: "pending_user",
          context_pack_status: "draft",
          required_reading: [],
          audition_status: "disabled_until_phase2",
          provider_evidence: [{ provider_id: "ui-catalog-unknown-license", source_type: "fixture", evidence_refs: ["workspace:providers.json"] }],
          evaluation_evidence: [
            {
              candidate_id: "ui-catalog-unknown-license",
              need_id: "CN-001",
              axis_values: { task_fit: 95, integration_ease: 80 },
              axis_contributions: { task_fit: 28.5, integration_ease: 12 },
              weighted_sum: 80,
              candidate_score: 75,
              uncertainty_penalty: 5,
              hard_gates: { license: "fail", compatibility: "pass" },
              eligibility: "ineligible",
              actual_model: null,
            },
            {
              candidate_id: "build:CN-001",
              need_id: "CN-001",
              axis_values: { task_fit: 70, integration_ease: 40 },
              axis_contributions: { task_fit: 21, integration_ease: 6 },
              weighted_sum: 55,
              candidate_score: 45,
              uncertainty_penalty: 10,
              hard_gates: { license: "pass", compatibility: "pass" },
              eligibility: "eligible",
              actual_model: null,
            },
          ],
          resolution_summaries: [{ resolution_id: "CR-001", need_id: "CN-001", mode: "build", selected_provider_id: "build:CN-001", rejected_provider_ids: ["ui-catalog-unknown-license"], evidence_refs: [], total_cost: 15, approval_status: "pending_user" }],
          timeline_event_types: ["task.intent.created", "resolution.proposed", "context.pack.created"],
          adaptation_evidence: [],
          cost_evidence: { status: "estimated", selected_candidate_estimate: 15, resolution_total_cost: 15 },
          scout_invoked: false,
          scout_skip_reason: null,
        },
      },
    ],
    journal: { batch_count: 18, event_count: 42, fixture_ids: ["adapt-vs-build", "blocked-candidate", "local-reuse"] },
    limitations: ["Local fixture sources only", "Final adoption and phase approval happen in the Codex task"],
  };
}

test("view model keeps the six-step review evidence explicit and read-only", () => {
  const view = buildWorkbenchView(fixtureState(), { selectedFixtureId: "blocked-candidate" });
  assert.equal(view.outcome.title, "高得点でも、license不明なら採用しない");
  assert.equal(view.decision.mode, "build");
  assert.equal(view.decision.approvalStatus, "pending_user");
  assert.equal(view.decision.writesApproval, false);
  assert.equal(view.needs.length, 2);
  assert.ok(view.candidates.some((candidate) => candidate.mode === "build"));
  assert.ok(view.candidates.some((candidate) => candidate.gates.some((gate) => gate.name === "license" && gate.status === "fail")));
  assert.ok(view.candidates.every((candidate) => candidate.axisContributions.length > 0));
  assert.equal(view.contextPack.intentGraphEnabled, false);
  assert.equal(view.contextPack.status, "draft");
  assert.equal(view.limits.actualModel, "unavailable");
  assert.equal(view.timeline.length, 3);
  assert.equal(view.journal.eventCount, 42);
});

test("view model fails closed when the selected fixture has no review evidence", () => {
  assert.throws(
    () => buildWorkbenchView(fixtureState(), { selectedFixtureId: "local-reuse" }),
    { code: "V4_WORKBENCH_FIXTURE_NOT_LOADED" },
  );
});
