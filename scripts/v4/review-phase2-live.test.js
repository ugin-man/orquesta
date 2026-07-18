"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { parseArguments, reviewLivePhase2 } = require("./review-phase2-live");

test("live reviewer requires state root, network, and Codex-turn opt-ins before effects", async () => {
  let calls = 0;
  await assert.rejects(
    reviewLivePhase2({ options: { stateRoot: "C:\\state", allowNetwork: true, allowCodexTurn: false }, executeLive: async () => { calls += 1; } }),
    (error) => error && error.code === "PHASE2_LIVE_OPT_IN_REQUIRED"
  );
  assert.equal(calls, 0);
  assert.deepEqual(parseArguments(["--state-root", "C:\\state", "--allow-network", "--allow-codex-turn"]), {
    stateRoot: path.resolve("C:\\state"), allowNetwork: true, allowCodexTurn: true
  });
});

test("live reviewer accepts two source families and a real-turn evidence packet without inferring an actual model", async () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-phase2-live-"));
  const result = await reviewLivePhase2({
    options: { stateRoot: outputRoot, allowNetwork: true, allowCodexTurn: true, outputRoot },
    executeLive: async () => ({
      source_families: ["official_docs", "registry"],
      audited_candidate: { candidate_id: "registry:codex-sdk", status: "eligible" },
      audition: { authorization_ref: "user-goal:phase2-through-2B", verdict: "passed", cleanup_evidence: ["cleanup:clean"], installed: false },
      runtime: { adapter: "typescript_sdk", dispatch_accepted: true, turn_started: true, turn_completed: true, actual_model: null, actual_model_evidence_ref: null },
      artifact: { ref: "artifact:final-response", hash: "a".repeat(64) },
      report: { ref: "report:phase2-live", hash: "b".repeat(64) },
      acceptance: { status: "passed" },
      journal: { evidence_ref: "journal:phase2-live", replay_equivalent: true }
    })
  });

  assert.equal(result.status, "ready_for_user_review");
  assert.equal(result.runtime.actual_model, null);
  assert.equal(result.source_families.length, 2);
  assert.equal(fs.existsSync(path.join(outputRoot, "review-packet.json")), true);
});

test("repository-only fallback cannot satisfy the live-turn requirement", async () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-phase2-repository-"));
  const result = await reviewLivePhase2({
    options: { stateRoot: outputRoot, allowNetwork: true, allowCodexTurn: true, outputRoot },
    executeLive: async () => ({
      source_families: ["official_docs", "registry"],
      audited_candidate: { candidate_id: "registry:codex-sdk", status: "eligible" },
      audition: { authorization_ref: "user-goal:phase2-through-2B", verdict: "passed", cleanup_evidence: ["cleanup:clean"], installed: false },
      runtime: { adapter: "repository", dispatch_accepted: false, turn_started: false, turn_completed: false, actual_model: null, actual_model_evidence_ref: null },
      artifact: null,
      report: { ref: "report:repository-fallback", hash: "b".repeat(64) },
      acceptance: { status: "failed" },
      journal: { evidence_ref: "journal:repository-fallback", replay_equivalent: true }
    })
  });
  assert.equal(result.status, "not_ready");
  assert.ok(result.limitations.includes("repository_fallback_is_not_a_live_turn"));
});
