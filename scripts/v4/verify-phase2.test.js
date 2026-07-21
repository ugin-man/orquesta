"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { canonicalHash } = require("@orquesta/contracts");
const { verifyDocumentation, verifyLivePacket, verifyPhase2, verifyScopePaths } = require("./verify-phase2");

const REPOSITORY_ROOT = path.resolve(__dirname, "..", "..");

function livePacket() {
  const packet = {
    phase: "2A-2B",
    status: "ready_for_user_review",
    packet_hash: null,
    source_families: ["official_docs", "registry"],
    source_evidence: [{ source_id: "source:official_docs:codex" }],
    audited_candidate: { candidate_id: "registry:codex-sdk", status: "eligible" },
    audition: { authorization_ref: "user-goal:phase2-through-2B", verdict: "passed", cleanup_evidence: ["cleanup:clean"], installed: false },
    runtime: { adapter: "typescript_sdk", dispatch_accepted: true, turn_started: true, turn_completed: true, actual_model: null, actual_model_evidence_ref: null },
    artifact: { ref: "artifact:phase2", hash: "a".repeat(64) },
    report: { ref: "report:phase2", hash: "b".repeat(64) },
    acceptance: { status: "passed", ref: "acceptance:phase2" },
    journal: { evidence_ref: "journal:phase2", replay_equivalent: true, correlation_id: "CORR-phase2", evidence_count: 7 },
    checks: {
      two_live_source_families: true, audited_candidate: true, audition_authorized_passed_clean: true,
      real_codex_turn: true, artifact_report_acceptance: true, journal_replay: true
    },
    limitations: []
  };
  packet.packet_hash = canonicalHash({ ...packet, packet_hash: null });
  return packet;
}

test("live evidence is never inferred from deterministic checks or an absent packet", () => {
  const missing = verifyLivePacket(path.join(os.tmpdir(), "orquesta-phase2-missing-review-packet.json"));
  assert.equal(missing.status, "missing");
  assert.equal(missing.passed, false);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-phase2-packet-"));
  const packetPath = path.join(root, "review-packet.json");
  fs.writeFileSync(packetPath, `${JSON.stringify(livePacket())}\n`, "utf8");
  assert.equal(verifyLivePacket(packetPath).passed, true);
  const unbound = livePacket();
  unbound.runtime.actual_model = "claimed-model";
  unbound.runtime.actual_model_evidence_ref = null;
  unbound.packet_hash = canonicalHash({ ...unbound, packet_hash: null });
  fs.writeFileSync(packetPath, `${JSON.stringify(unbound)}\n`, "utf8");
  assert.equal(verifyLivePacket(packetPath).passed, false);
});

test("scope verifier permits Phase 2 surfaces and rejects application, dashboard, plugin, Phase 3, and invalid model evidence", () => {
  assert.equal(verifyScopePaths([
    "packages/acquisition/src/index.js", "packages/core/src/commands.js", "scripts/v4/phase-boundary-check.js", "scripts/v4/verify-phase2.js", "README.md"
  ]).passed, true);
  const forbidden = verifyScopePaths(["apps/desktop/main.js", "orquesta/assets/dashboard/app.js", "plugins/runtime.js", "packages/phase3/index.js"]);
  assert.equal(forbidden.passed, false);
  assert.equal(forbidden.forbidden_paths.length, 4);
  assert.equal(verifyScopePaths([], { modelEvidenceObjects: [{ actual_model: "claimed", actual_model_evidence_ref: null }] }).passed, false);
});

test("Phase 2 documentation states the implemented runtime and Desktop boundaries", () => {
  const result = verifyDocumentation(REPOSITORY_ROOT);
  assert.equal(result.passed, true, result.missing.join("\n"));
});

test("deterministic verifier covers the complete 2A to 2B slice while reporting live evidence separately", async () => {
  const missingLivePath = path.join(os.tmpdir(), "orquesta-phase2-no-live-packet.json");
  const result = await verifyPhase2({ root: REPOSITORY_ROOT, liveEvidencePath: missingLivePath });
  assert.equal(result.deterministic.passed, true);
  assert.equal(result.live.passed, false);
  assert.equal(result.ok, false);
  assert.deepEqual(result.deterministic.connector_ids, ["github", "official_docs", "registry", "ui_catalog"]);
  assert.equal(result.deterministic.evidence_count, 7);
});
