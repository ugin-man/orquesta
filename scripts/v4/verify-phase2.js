"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ACQUISITION_LIMITS } = require("@orquesta/acquisition");
const { canonicalHash } = require("@orquesta/contracts");
const { CAPABILITY_METHODS, createRepositoryAdapter } = require("@orquesta/codex-adapter");
const { COMMAND_NAMES } = require("@orquesta/core");
const { runDeterministicPhase2Slice } = require("./run-phase2-slice");

const REPOSITORY_ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_LIVE_PACKET = path.join(REPOSITORY_ROOT, "output", "v4-phase2-review", "review-packet.json");
const HASH = /^[a-f0-9]{64}$/;
const CONNECTOR_IDS = Object.freeze(["github", "official_docs", "registry", "ui_catalog"]);

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function readJson(filePath) {
  return JSON.parse(readText(filePath));
}

function verifyLivePacket(packetPath = DEFAULT_LIVE_PACKET) {
  const resolved = path.resolve(packetPath);
  if (!fs.existsSync(resolved)) return { passed: false, status: "missing", packet_path: resolved, failures: ["live_review_packet_missing"] };
  let packet;
  try {
    packet = readJson(resolved);
  } catch {
    return { passed: false, status: "invalid", packet_path: resolved, failures: ["live_review_packet_invalid_json"] };
  }
  const failures = [];
  const expectedHash = canonicalHash({ ...packet, packet_hash: null });
  if (packet.phase !== "2A-2B" || packet.status !== "ready_for_user_review") failures.push("live_review_not_ready");
  if (packet.packet_hash !== expectedHash) failures.push("live_review_packet_hash_mismatch");
  if (!Array.isArray(packet.source_families) || !packet.source_families.includes("official_docs") || !packet.source_families.includes("registry")) failures.push("live_source_families_incomplete");
  if (!packet.audited_candidate?.candidate_id) failures.push("live_audited_candidate_missing");
  if (packet.audition?.verdict !== "passed" || packet.audition?.installed !== false || !packet.audition?.authorization_ref
    || !packet.audition?.cleanup_evidence?.includes("cleanup:clean")) failures.push("live_audition_evidence_incomplete");
  const runtime = packet.runtime || {};
  if (!["app_server", "typescript_sdk"].includes(runtime.adapter)
    || runtime.dispatch_accepted !== true || runtime.turn_started !== true || runtime.turn_completed !== true) failures.push("live_runtime_evidence_incomplete");
  if (runtime.actual_model !== null && !runtime.actual_model_evidence_ref) failures.push("live_actual_model_unbound");
  if (!HASH.test(packet.artifact?.hash || "") || !HASH.test(packet.report?.hash || "") || packet.acceptance?.status !== "passed") failures.push("live_acceptance_evidence_incomplete");
  if (packet.journal?.replay_equivalent !== true || !packet.journal?.correlation_id || packet.journal?.evidence_count < 7) failures.push("live_journal_evidence_incomplete");
  if (!packet.checks || Object.values(packet.checks).some((value) => value !== true) || !Array.isArray(packet.limitations) || packet.limitations.length > 0) failures.push("live_review_checks_failed");
  return { passed: failures.length === 0, status: failures.length === 0 ? "ready_for_user_review" : "invalid", packet_path: resolved, failures };
}

const ALLOWED_SCOPE = [
  /^\.gitattributes$/,
  /^README\.md$/,
  /^package(?:-lock)?\.json$/,
  /^docs\/superpowers\/(?:plans|specs)\/2026-07-(?:15|17)-orquesta-v4-/,
  /^docs\/testing\/orquesta-v4-phase2-review\.md$/,
  /^fixtures\/v4\/phase2\//,
  /^packages\/(?:acquisition|audit|audition|capability-resolver|codex-adapter|contracts|core|evidence-fabric)\//,
  /^scripts\/v4\/(?:phase-boundary-check|probe-codex-runtime|review-phase2-live|run-phase2-slice|verify-phase2)\.(?:js|test\.js)$/,
  /^orquesta\/SKILL\.md$/,
  /^\.agents\/skills\/orquesta\/SKILL\.md$/,
  /^orquesta\/references\/(?:orchestration-protocol|agent-contract|state-schema)\.md$/
];
const FORBIDDEN_SCOPE = [
  /^apps\//i,
  /(?:^|\/)dashboard(?:\/|$)/i,
  /(?:^|\/)plugins?(?:\/|$)/i,
  /(?:^|[\/_-])phase[_-]?3(?:[\/_-]|$)/i
];

function verifyScopePaths(paths, { modelEvidenceObjects = [] } = {}) {
  const normalized = [...new Set((paths || []).map((item) => String(item).replaceAll("\\", "/")))].sort();
  const forbiddenPaths = normalized.filter((item) => FORBIDDEN_SCOPE.some((pattern) => pattern.test(item)));
  const outOfScopePaths = normalized.filter((item) => !ALLOWED_SCOPE.some((pattern) => pattern.test(item)));
  const invalidModelEvidence = (modelEvidenceObjects || []).filter((item) => item && typeof item === "object"
    && item.actual_model !== null && (!item.actual_model_evidence_ref || typeof item.actual_model_evidence_ref !== "string"));
  return {
    passed: forbiddenPaths.length === 0 && outOfScopePaths.length === 0 && invalidModelEvidence.length === 0,
    checked_paths: normalized,
    forbidden_paths: forbiddenPaths,
    out_of_scope_paths: outOfScopePaths,
    invalid_model_evidence_count: invalidModelEvidence.length
  };
}

function collectModelEvidence(value, output = []) {
  if (!value || typeof value !== "object") return output;
  if (Object.hasOwn(value, "actual_model") && (value.actual_model === null || typeof value.actual_model === "string")) output.push(value);
  for (const child of Object.values(value)) collectModelEvidence(child, output);
  return output;
}

function verifyGitScope(root, base, head) {
  const result = spawnSync("git", ["diff", "--name-only", `${base}..${head}`], { cwd: root, encoding: "utf8", windowsHide: true, shell: false });
  if (result.status !== 0) return { passed: false, error: (result.stderr || "git scope diff failed").trim(), checked_paths: [] };
  const paths = result.stdout.split(/\r?\n/).filter(Boolean);
  const modelEvidenceObjects = [];
  for (const relative of paths.filter((item) => item.endsWith(".json"))) {
    const target = path.resolve(root, relative);
    if (fs.existsSync(target)) {
      try { collectModelEvidence(readJson(target), modelEvidenceObjects); } catch {}
    }
  }
  return verifyScopePaths(paths, { modelEvidenceObjects });
}

function verifyDocumentation(root) {
  const requirements = [
    ["orquesta/SKILL.md", ["Phase 2A and 2B", "Codex harness is the runtime safety boundary", "does not add a second sandbox", "install authorization", "App Server", "SDK", "repository-only", "dispatch acceptance", "actual_model"]],
    ["orquesta/references/orchestration-protocol.md", ["Phase 2A and 2B", "Audition", "install authorization", "dispatch acceptance", "turn start"]],
    ["orquesta/references/agent-contract.md", ["Phase 2 runtime contract", "App Server", "SDK", "repository-only", "actual_model"]],
    ["orquesta/references/state-schema.md", ["Phase 2A and 2B evidence", "derived cache", "Event Journal is canonical"]],
    ["README.md", ["Phase 2A", "Phase 2B", "Windows application", "Electron", "Requested, applied, and observed model identity stay separate"]]
  ];
  const missing = [];
  for (const [relative, markers] of requirements) {
    const target = path.join(root, relative);
    if (!fs.existsSync(target)) {
      missing.push(`${relative}:missing`);
      continue;
    }
    const text = readText(target);
    for (const marker of markers) if (!text.includes(marker)) missing.push(`${relative}:${marker}`);
  }
  const mirror = path.join(root, ".agents", "skills", "orquesta", "SKILL.md");
  if (fs.existsSync(mirror)) {
    const mirrorText = readText(mirror);
    for (const marker of requirements[0][1]) if (!mirrorText.includes(marker)) missing.push(`.agents/skills/orquesta/SKILL.md:${marker}`);
  }
  return { passed: missing.length === 0, missing, mirror_status: fs.existsSync(mirror) ? "verified" : "local_mirror_absent" };
}

async function verifyPhase2({ root = REPOSITORY_ROOT, liveEvidencePath = DEFAULT_LIVE_PACKET, scopeBase = null, scopeHead = "HEAD" } = {}) {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-phase2-verify-"));
  let slice;
  try {
    slice = await runDeterministicPhase2Slice({ stateRoot });
  } finally {
    const temporaryBase = path.resolve(os.tmpdir());
    const resolved = path.resolve(stateRoot);
    if (resolved.startsWith(`${temporaryBase}${path.sep}`)) fs.rmSync(resolved, { recursive: true, force: true });
  }
  const repository = await createRepositoryAdapter().capabilities({ correlationId: "CORR-phase2-verifier" });
  const expectedRepositoryCapabilities = Object.fromEntries(
    CAPABILITY_METHODS.map((method) => [method, ["runtimeInfo", "shutdown"].includes(method)])
  );
  const deterministicFailures = [];
  if (canonicalHash(ACQUISITION_LIMITS) !== canonicalHash({ max_requests_per_need: 8, max_requests_per_connector: 2, max_candidates: 3 })) deterministicFailures.push("acquisition_budget_drift");
  if (canonicalHash(slice.acquisition.connector_ids) !== canonicalHash(CONNECTOR_IDS)) deterministicFailures.push("connector_coverage_incomplete");
  if (slice.acquisition.candidate_count !== 3 || slice.audit.hard_gate_rejection_count !== 1) deterministicFailures.push("audit_slice_mismatch");
  if (!slice.audition.approval_wait_observed || slice.audition.verdict !== "passed" || !slice.audition.cleanup_evidence.includes("cleanup:clean")) deterministicFailures.push("audition_slice_mismatch");
  if (canonicalHash(slice.runtime.timeline) !== canonicalHash(["dispatch_accepted", "turn_started", "progress_observed", "turn_completed"]) || slice.runtime.actual_model !== null) deterministicFailures.push("runtime_slice_mismatch");
  if (!slice.journal.replay_equivalent || slice.journal.evidence_count !== 7 || slice.acceptance.status !== "passed") deterministicFailures.push("evidence_slice_mismatch");
  if (!COMMAND_NAMES.includes("candidate.install.request") || !COMMAND_NAMES.includes("candidate.install.authorize") || COMMAND_NAMES.some((name) => name.includes("install.execute"))) deterministicFailures.push("install_authorization_boundary_drift");
  if (repository.execution !== "unsupported"
      || repository.actual_model !== null
      || canonicalHash(repository.capabilities) !== canonicalHash(expectedRepositoryCapabilities)) {
    deterministicFailures.push("repository_fallback_drift");
  }
  const deterministic = {
    passed: deterministicFailures.length === 0,
    failures: deterministicFailures,
    connector_ids: slice.acquisition.connector_ids,
    evidence_count: slice.journal.evidence_count,
    replay_equivalent: slice.journal.replay_equivalent,
    runtime_timeline: slice.runtime.timeline,
    actual_model: slice.runtime.actual_model
  };
  const documentation = verifyDocumentation(root);
  const live = verifyLivePacket(liveEvidencePath);
  const scope = scopeBase ? verifyGitScope(root, scopeBase, scopeHead) : { passed: true, status: "not_requested" };
  return { schema_version: 1, phase: "2A-2B", ok: deterministic.passed && documentation.passed && live.passed && scope.passed, deterministic, documentation, live, scope };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (["--scope-base", "--scope-head", "--live-evidence"].includes(flag)) {
      if (!argv[index + 1]) throw new Error(`${flag} requires a value`);
      if (flag === "--scope-base") options.scopeBase = argv[++index];
      else if (flag === "--scope-head") options.scopeHead = argv[++index];
      else options.liveEvidencePath = path.resolve(argv[++index]);
    } else throw new Error(`Unknown option: ${flag}`);
  }
  return options;
}

if (require.main === module) {
  verifyPhase2({ root: REPOSITORY_ROOT, ...parseArguments(process.argv.slice(2)) })
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (!result.ok) process.exitCode = 1;
    })
    .catch((error) => {
      process.stderr.write(`${error.code || "PHASE2_VERIFY_FAILED"}: ${error.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = { DEFAULT_LIVE_PACKET, verifyDocumentation, verifyGitScope, verifyLivePacket, verifyPhase2, verifyScopePaths };
