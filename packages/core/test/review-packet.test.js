"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { REQUIRED_PACKET_FIELDS, createReviewPacket } = require("../src");

function validPacketInput() {
  return {
    build_ref: "commit:43ab176",
    artifact_hashes: {
      "output/v4-phase1-review/checks.json": "a".repeat(64),
      "output/v4-phase1-review/workbench.png": "b".repeat(64),
    },
    five_minute_path: ["Open the packet", "Run the three fixtures", "Return to the Codex orchestrator task"],
    fixture_results: [
      { fixture_id: "local-reuse", expected_mode: "REUSE", actual_mode: "REUSE", status: "passed" },
      { fixture_id: "adapt-vs-build", expected_mode: "ADAPT", actual_mode: "ADAPT", status: "passed" },
      { fixture_id: "blocked-candidate", expected_mode: "BUILD", actual_mode: "BUILD", status: "passed" },
    ],
    automated_checks: [
      { name: "phase_boundary", status: "passed" },
      { name: "v3", status: "passed" },
      { name: "v4", status: "passed" },
      { name: "projection_replay", status: "passed" },
    ],
    browser_evidence: { status: "passed", fixtures: 3, console_errors: 0, page_errors: 0 },
    browser_runner_versions: { driver: "playwright-core 1.61.1", browser: "Chrome 150" },
    approval_assurance: "explicit_user_decision_in_codex_orchestrator_task",
    tested_node_versions: ["v24.12.0"],
    adopted_and_rejected: { adopted: ["read-only Workbench"], rejected: ["Workbench approval writes"] },
    known_gaps: ["Node 20 runtime was not executed."],
    phase2_changes: ["Audition and external scouting remain Phase 2 work."],
    user_decision_location: "Codex orchestrator task",
  };
}

test("review packet requires every durable user-review field", () => {
  assert.equal(REQUIRED_PACKET_FIELDS.length, 13);
  for (const field of REQUIRED_PACKET_FIELDS) {
    const input = validPacketInput();
    delete input[field];
    assert.throws(() => createReviewPacket(input), (error) => error.code === "REVIEW_PACKET_FIELD_REQUIRED" && error.details.field === field);
  }
});

test("review packet refuses browser, V3, replay, or Phase 1 boundary gaps", () => {
  const cases = [
    (input) => { input.browser_evidence.status = "not_run"; },
    (input) => { input.automated_checks.find((check) => check.name === "v3").status = "failed"; },
    (input) => { input.automated_checks.find((check) => check.name === "projection_replay").status = "failed"; },
    (input) => { input.automated_checks.find((check) => check.name === "phase_boundary").status = "failed"; },
  ];
  for (const mutate of cases) {
    const input = validPacketInput();
    mutate(input);
    assert.throws(() => createReviewPacket(input), { code: "REVIEW_PACKET_NOT_READY" });
  }
});

test("review packet becomes ready only with valid hashes and the Codex user checkpoint", () => {
  const packet = createReviewPacket(validPacketInput());
  assert.equal(packet.status, "ready_for_user_review");
  assert.equal(packet.approval_assurance, "explicit_user_decision_in_codex_orchestrator_task");
  assert.equal(packet.user_decision_location, "Codex orchestrator task");
  assert.throws(() => createReviewPacket({ ...validPacketInput(), artifact_hashes: { packet: "not-a-hash" } }), { code: "REVIEW_PACKET_ARTIFACT_HASH_INVALID" });
});
