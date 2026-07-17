"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { canonicalHash } = require("@orquesta/contracts");

const REPOSITORY_ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_OUTPUT_ROOT = path.join(REPOSITORY_ROOT, "output", "v4-phase2-review");

function liveError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function parseArguments(argv) {
  const options = { allowNetwork: false, allowCodexTurn: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--allow-network") options.allowNetwork = true;
    else if (flag === "--allow-codex-turn") options.allowCodexTurn = true;
    else if (flag === "--state-root" || flag === "--output-root") {
      const value = argv[index + 1];
      if (typeof value !== "string" || value.startsWith("--")) {
        throw liveError("PHASE2_LIVE_ARGUMENT_INVALID", `${flag} requires a path.`);
      }
      options[flag === "--state-root" ? "stateRoot" : "outputRoot"] = path.resolve(value);
      index += 1;
    } else {
      throw liveError("PHASE2_LIVE_ARGUMENT_INVALID", `Unknown Phase 2 live option: ${flag}`);
    }
  }
  if (options.stateRoot) options.stateRoot = path.resolve(options.stateRoot);
  if (options.outputRoot) options.outputRoot = path.resolve(options.outputRoot);
  return options;
}

function validHash(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function assessLiveEvidence(evidence) {
  const limitations = [];
  const sourceFamilies = [...new Set(Array.isArray(evidence?.source_families) ? evidence.source_families.filter(Boolean) : [])].sort();
  if (sourceFamilies.length < 2) limitations.push("fewer_than_two_live_source_families");
  if (!evidence?.audited_candidate?.candidate_id) limitations.push("audited_candidate_missing");
  if (!evidence?.audition?.authorization_ref) limitations.push("audition_authorization_missing");
  if (evidence?.audition?.verdict !== "passed" || !evidence?.audition?.cleanup_evidence?.includes("cleanup:clean")) {
    limitations.push("audition_not_passed_and_clean");
  }
  if (evidence?.audition?.installed === true) limitations.push("live_review_installed_candidate_without_separate_approval");

  const runtime = evidence?.runtime || {};
  if (runtime.adapter === "repository") limitations.push("repository_fallback_is_not_a_live_turn");
  if (runtime.dispatch_accepted !== true) limitations.push("runtime_dispatch_not_accepted");
  if (runtime.turn_started !== true) limitations.push("runtime_turn_not_started");
  if (runtime.turn_completed !== true) limitations.push("runtime_turn_not_completed");
  if (runtime.actual_model !== null && !runtime.actual_model_evidence_ref) limitations.push("actual_model_unbound");

  if (!evidence?.artifact?.ref || !validHash(evidence?.artifact?.hash)) limitations.push("artifact_evidence_missing");
  if (!evidence?.report?.ref || !validHash(evidence?.report?.hash)) limitations.push("report_evidence_missing");
  if (evidence?.acceptance?.status !== "passed") limitations.push("acceptance_not_passed");
  if (!evidence?.journal?.evidence_ref || evidence?.journal?.replay_equivalent !== true) limitations.push("journal_replay_not_proven");
  return { sourceFamilies, limitations };
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeReviewArtifacts(outputRoot, result) {
  fs.mkdirSync(outputRoot, { recursive: true });
  writeJson(path.join(outputRoot, "checks.json"), result.checks);
  writeJson(path.join(outputRoot, "source-evidence.json"), { source_families: result.source_families, source_evidence: result.source_evidence, audited_candidate: result.audited_candidate });
  writeJson(path.join(outputRoot, "audition-report.json"), result.audition);
  writeJson(path.join(outputRoot, "runtime-timeline.json"), result.runtime);
  writeJson(path.join(outputRoot, "artifact-report-hashes.json"), { artifact: result.artifact, report: result.report });
  writeJson(path.join(outputRoot, "limitations.json"), result.limitations);
  writeJson(path.join(outputRoot, "review-packet.json"), result);
}

async function defaultExecuteLive(input) {
  const { runLivePhase2Slice } = require("./run-phase2-slice");
  return runLivePhase2Slice(input);
}

async function reviewLivePhase2({ options = {}, executeLive = defaultExecuteLive } = {}) {
  if (typeof options.stateRoot !== "string" || !options.stateRoot || options.allowNetwork !== true || options.allowCodexTurn !== true) {
    throw liveError(
      "PHASE2_LIVE_OPT_IN_REQUIRED",
      "Phase 2 live review requires --state-root, --allow-network, and --allow-codex-turn."
    );
  }
  if (typeof executeLive !== "function") throw new TypeError("executeLive must be a function.");
  const resolvedOutputRoot = path.resolve(options.outputRoot || DEFAULT_OUTPUT_ROOT);
  const evidence = await executeLive({
    stateRoot: path.resolve(options.stateRoot),
    outputRoot: resolvedOutputRoot,
    allowNetwork: true,
    allowCodexTurn: true
  });
  const assessed = assessLiveEvidence(evidence);
  const status = assessed.limitations.length === 0 ? "ready_for_user_review" : "not_ready";
  const checks = {
    two_live_source_families: assessed.sourceFamilies.length >= 2,
    audited_candidate: Boolean(evidence?.audited_candidate?.candidate_id),
    audition_authorized_passed_clean: Boolean(evidence?.audition?.authorization_ref)
      && evidence?.audition?.verdict === "passed"
      && evidence?.audition?.cleanup_evidence?.includes("cleanup:clean"),
    real_codex_turn: evidence?.runtime?.adapter !== "repository"
      && evidence?.runtime?.dispatch_accepted === true
      && evidence?.runtime?.turn_started === true
      && evidence?.runtime?.turn_completed === true,
    artifact_report_acceptance: validHash(evidence?.artifact?.hash)
      && validHash(evidence?.report?.hash)
      && evidence?.acceptance?.status === "passed",
    journal_replay: evidence?.journal?.replay_equivalent === true
  };
  const body = {
    phase: "2A-2B",
    status,
    packet_hash: null,
    source_families: assessed.sourceFamilies,
    source_evidence: Array.isArray(evidence?.source_evidence) ? evidence.source_evidence : [],
    audited_candidate: evidence?.audited_candidate || null,
    audition: evidence?.audition || null,
    runtime: evidence?.runtime || null,
    artifact: evidence?.artifact || null,
    report: evidence?.report || null,
    acceptance: evidence?.acceptance || null,
    journal: evidence?.journal || null,
    checks,
    limitations: assessed.limitations
  };
  body.packet_hash = canonicalHash({ ...body, packet_hash: null });
  writeReviewArtifacts(resolvedOutputRoot, body);
  return body;
}

if (require.main === module) {
  reviewLivePhase2({ options: parseArguments(process.argv.slice(2)) })
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error.code || "PHASE2_LIVE_REVIEW_FAILED"}: ${error.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = { DEFAULT_OUTPUT_ROOT, assessLiveEvidence, parseArguments, reviewLivePhase2 };
