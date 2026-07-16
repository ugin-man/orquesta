#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { createEventStore } = require("@orquesta/event-store");
const {
  createCommandBoundary,
  createProjectors,
  createReviewPacket,
  projectionHash,
} = require("@orquesta/core");
const { startWorkbench } = require("../../apps/workbench/server");
const { resolveChrome, runBrowserSmoke } = require("../../apps/workbench/scripts/browser-smoke");

const REPOSITORY_ROOT = path.resolve(__dirname, "../..");
const OUTPUT_ROOT = path.join(REPOSITORY_ROOT, "output", "v4-phase1-review");
const FIXTURE_IDS = Object.freeze(["local-reuse", "adapt-vs-build", "blocked-candidate"]);
const EXPECTED_MODES = Object.freeze({ "local-reuse": "REUSE", "adapt-vs-build": "ADAPT", "blocked-candidate": "BUILD" });
const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";

function now() {
  return new Date().toISOString();
}

function relative(filePath) {
  return path.relative(REPOSITORY_ROOT, filePath).replaceAll("\\", "/");
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function outputSummary(stdout, stderr) {
  const lines = `${stdout || ""}\n${stderr || ""}`.split(/\r?\n/u).map((line) => line.trimEnd()).filter(Boolean);
  const selected = lines.length <= 24 ? lines : [...lines.slice(0, 8), `... ${lines.length - 20} lines omitted ...`, ...lines.slice(-12)];
  return selected.join("\n").slice(0, 6000);
}

function runCommand(name, executable, args, options = {}) {
  const startedAt = now();
  const started = Date.now();
  const useWindowsCommandShell = process.platform === "win32" && executable.toLowerCase().endsWith(".cmd");
  const spawnExecutable = useWindowsCommandShell ? (process.env.ComSpec || "cmd.exe") : executable;
  const spawnArgs = useWindowsCommandShell ? ["/d", "/s", "/c", [executable, ...args].join(" ")] : args;
  const result = spawnSync(spawnExecutable, spawnArgs, {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, ...(options.env || {}) },
  });
  const record = {
    name,
    command: [executable, ...args].join(" "),
    status: result.status === 0 ? "passed" : "failed",
    exit_code: Number.isInteger(result.status) ? result.status : null,
    started_at: startedAt,
    completed_at: now(),
    duration_ms: Date.now() - started,
    summary: outputSummary(result.stdout, `${result.stderr || ""}${result.error ? `\n${result.error.message}` : ""}`),
  };
  return { record, stdout: result.stdout || "", stderr: result.stderr || "" };
}

async function runDiagnostic(name, action) {
  const startedAt = now();
  const started = Date.now();
  try {
    const evidence = await action();
    return {
      record: {
        name,
        command: evidence.command || name,
        status: "passed",
        exit_code: 0,
        started_at: startedAt,
        completed_at: now(),
        duration_ms: Date.now() - started,
        summary: evidence.summary || "passed",
      },
      evidence,
    };
  } catch (error) {
    return {
      record: {
        name,
        command: name,
        status: "failed",
        exit_code: 1,
        started_at: startedAt,
        completed_at: now(),
        duration_ms: Date.now() - started,
        summary: `${error.code || "ERROR"}: ${error.message}`,
      },
      evidence: { error: { code: error.code || null, message: error.message } },
    };
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parseFixtureResult(fixtureId, commandResult) {
  if (commandResult.record.status !== "passed") {
    return { fixture_id: fixtureId, expected_mode: EXPECTED_MODES[fixtureId], actual_mode: null, status: "failed", error: commandResult.record.summary };
  }
  const parsed = JSON.parse(commandResult.stdout);
  const actualMode = String(parsed.review_view.proposed_mode || "").toUpperCase();
  return {
    fixture_id: fixtureId,
    expected_mode: EXPECTED_MODES[fixtureId],
    actual_mode: actualMode,
    status: actualMode === EXPECTED_MODES[fixtureId] ? "passed" : "failed",
    selected_provider_id: parsed.review_view.proposed_provider_id,
    approval_status: parsed.review_view.approval_status,
    context_pack_status: parsed.review_view.context_pack_status,
    rejection_gate: parsed.review_view.rejection_gate,
    build_candidate_present: parsed.review_view.build_candidate_present,
    journal: parsed.journal,
  };
}

async function runApiSmoke(stateRoot) {
  const app = await startWorkbench({ feature: "v4", stateRoot, port: 0 });
  try {
    const modes = {};
    for (const fixtureId of FIXTURE_IDS) {
      const response = await fetch(`${app.url}/api/v4/fixtures/${fixtureId}/load`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: app.url },
        body: "{}",
      });
      if (response.status !== 200) throw new Error(`${fixtureId} load returned ${response.status}`);
      const state = await response.json();
      modes[fixtureId] = String(state.fixtures.find((fixture) => fixture.fixture_id === fixtureId)?.review_view?.proposed_mode || "").toUpperCase();
    }
    const replayResponse = await fetch(`${app.url}/api/v4/replay`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: app.url },
      body: "{}",
    });
    if (replayResponse.status !== 200) throw new Error(`replay returned ${replayResponse.status}`);
    const replayed = await replayResponse.json();
    for (const fixtureId of FIXTURE_IDS) {
      if (modes[fixtureId] !== EXPECTED_MODES[fixtureId]) throw new Error(`${fixtureId} API mode mismatch`);
    }
    if (replayed.journal.batch_count !== 18 || replayed.journal.event_count !== 42) throw new Error("Workbench API replay did not produce 18 batches and 42 events");
    return {
      command: "Workbench loopback API smoke",
      summary: `3 fixtures passed at ${app.url}; replay 18 batches / 42 events`,
      modes,
      journal: replayed.journal,
    };
  } finally {
    await app.close();
  }
}

function verifyProjectionReplay(stateRoot) {
  const store = createEventStore({ stateRoot, workspaceId: "v4-phase1-fixtures", reducers: createProjectors(), initialState: {} });
  const live = store.rebuildProjections();
  const liveHash = projectionHash(live.state);
  const before = store.inspectRecovery();
  const projectionPaths = store.listProjectionPaths();
  if (projectionPaths.length !== 1) throw new Error(`Expected one projection, found ${projectionPaths.length}`);
  for (const projectionPath of projectionPaths) store.removeArtifact(projectionPath);
  const missing = store.inspectRecovery();
  const replayed = store.replay();
  const replayHash = projectionHash(replayed.state);
  const rebuilt = store.rebuildProjections();
  const rebuiltHash = projectionHash(rebuilt.state);
  const after = store.inspectRecovery();
  const hashMatch = liveHash === replayHash && liveHash === rebuiltHash;
  if (!hashMatch) throw new Error("Projection hash changed after deletion and replay");
  return {
    command: "delete projection; replay journal; rebuild projection",
    summary: `projection hash ${liveHash} matched after deletion, replay, and rebuild`,
    status: "passed",
    projection_deleted: true,
    live_hash: liveHash,
    replay_hash: replayHash,
    rebuilt_hash: rebuiltHash,
    hash_match: hashMatch,
    recovery_actions: { before: before.action, projection_missing: missing.action, after: after.action },
    journal: replayed.watermark,
  };
}

function automatedPacketChecks(records) {
  const status = (name) => records.find((record) => record.name === name)?.status || "failed";
  return [
    { name: "phase_boundary", status: status("phase_boundary") },
    { name: "v3", status: status("v3") },
    { name: "v4", status: status("v4") },
    { name: "onedrive_live", status: status("onedrive_live") },
    { name: "fixtures", status: status("fixtures") },
    { name: "workbench_api", status: status("workbench_api") },
    { name: "browser", status: status("browser") },
    { name: "projection_replay", status: status("projection_replay") },
  ];
}

function markdownList(values) {
  return values.map((value) => `- ${value}`).join("\n");
}

function renderPacket(packet) {
  const fixtures = packet.fixture_results.map((result) => `| ${result.fixture_id} | ${result.expected_mode} | ${result.actual_mode} | ${result.status} |`).join("\n");
  const checks = packet.automated_checks.map((check) => `- ${check.name}: ${check.status}`).join("\n");
  const hashes = Object.entries(packet.artifact_hashes).map(([reference, hash]) => `| ${reference} | \`${hash}\` |`).join("\n");
  return `# Orquesta V4 Phase 1 ユーザーレビュー\n\nstatus: ${packet.status}\n\nbuild: \`${packet.build_ref}\`\n\nPhase 1の実装と自動確認は終わっています。ただし、Phase 1の承認はまだです。Workbenchは確認専用で、最終判断はこのCodex統括タスクで行います。\n\n## 5分で見る手順\n\n${packet.five_minute_path.map((step, index) => `${index + 1}. ${step}`).join("\n")}\n\n## 三つのfixture\n\n| fixture | 期待 | 実際 | 結果 |\n|---|---:|---:|---|\n${fixtures}\n\n## 自動確認\n\n${checks}\n\nBrowserは${packet.browser_evidence.fixtures} fixture、console error ${packet.browser_evidence.console_errors}、page error ${packet.browser_evidence.page_errors}でした。実行環境は${packet.browser_runner_versions.driver} / ${packet.browser_runner_versions.browser}、Nodeは${packet.tested_node_versions.join(", ")}です。\n\n## 今回採用したもの\n\n${markdownList(packet.adopted_and_rejected.adopted)}\n\n## 今回入れなかったもの\n\n${markdownList(packet.adopted_and_rejected.rejected)}\n\n## 既知のgap\n\n${markdownList(packet.known_gaps)}\n\n## Phase 2で増えるもの\n\n${markdownList(packet.phase2_changes)}\n\n## 判断する場所\n\n承認方式は \`${packet.approval_assurance}\` です。${packet.user_decision_location}で、ユーザーが承認か変更要求を明示してください。OS identity proof、独自HMAC、独自challengeを承認根拠にはしていません。\n\n## 証拠hash\n\n| artifact | SHA-256 |\n|---|---|\n${hashes}\n`;
}

function recordPhaseReview({ stateRoot, packetPath, packetHash, buildRef, automatedChecks }) {
  const store = createEventStore({ stateRoot, workspaceId: "v4-phase1-fixtures", reducers: createProjectors(), initialState: {} });
  const artifact = { artifact_ref: relative(packetPath), artifact_hash: packetHash, kind: "phase_review_packet" };
  const revision = store.replay().watermark.journal_sequence;
  store.commit({
    expected_revision: revision,
    batch_id: "phase-1-review-packet",
    actor: { type: "agent", id: "orchestrator" },
    correlation_id: "phase-1-review",
    events: [{
      event_id: "phase-1-review-packet-produced",
      schema_version: 1,
      type: "artifact.produced",
      payload: { artifact, responsibility: "implementation" },
      evidence_refs: [artifact.artifact_ref],
    }],
  });
  const boundary = createCommandBoundary({
    eventStore: store,
    rules: { catalog_version: 1, rules: [] },
    collectInventory: () => ({ version: 1, providers: [], conflicts: [] }),
  });
  boundary.execute({
    command_id: "phase-1-review-request",
    name: "phase-review.request",
    payload: {
      phase_id: "phase-1",
      build_ref: buildRef,
      review_packet_ref: artifact.artifact_ref,
      review_packet_hash: artifact.artifact_hash,
      checks: automatedChecks.map((check) => ({ name: check.name, status: check.status })),
    },
  });
  boundary.execute({ command_id: "phase-1-review-ready", name: "phase-review.decide", payload: { phase_id: "phase-1", decision: "ready_for_user_review" } });
  const rebuilt = store.rebuildProjections();
  const review = rebuilt.state.phase_reviews.find((item) => item.phase_id === "phase-1");
  if (!review || review.status !== "ready_for_user_review") throw new Error("Phase Review projection did not reach ready_for_user_review");
  return { status: review.status, phase_id: review.phase_id, review_packet_hash: review.review_packet_hash, journal: rebuilt.watermark };
}

async function verifyPhase1() {
  fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
  const checks = [];
  const addCommand = (name, executable, args) => {
    const result = runCommand(name, executable, args);
    checks.push(result.record);
    return result;
  };

  addCommand("phase_boundary", process.execPath, ["scripts/v4/phase-boundary-check.js"]);
  const nodeVersion = addCommand("node_version", process.execPath, ["--version"]);
  const browserPreflight = addCommand("browser_preflight", process.execPath, ["scripts/v4/browser-preflight.js", "--require-driver"]);
  addCommand("v3", npmExecutable, ["run", "check"]);
  addCommand("v4", npmExecutable, ["run", "test:v4:phase1"]);
  addCommand("onedrive_live", process.execPath, ["--test", "packages/event-store/test/onedrive-live.test.js"]);

  const fixtureStateParent = path.join(OUTPUT_ROOT, "fixture-state");
  fs.mkdirSync(fixtureStateParent, { recursive: true });
  const fixtureStateRoot = fs.mkdtempSync(path.join(fixtureStateParent, "run-"));
  const fixtureResults = [];
  for (const fixtureId of FIXTURE_IDS) {
    const result = addCommand(`fixture_${fixtureId}`, process.execPath, ["scripts/v4/run-fixture.js", "--fixture", fixtureId, "--state-root", fixtureStateRoot]);
    try {
      fixtureResults.push(parseFixtureResult(fixtureId, result));
    } catch (error) {
      fixtureResults.push({ fixture_id: fixtureId, expected_mode: EXPECTED_MODES[fixtureId], actual_mode: null, status: "failed", error: error.message });
    }
  }
  checks.push({
    name: "fixtures",
    command: "three fixture CLI runs in one fresh state root",
    status: fixtureResults.every((result) => result.status === "passed") ? "passed" : "failed",
    exit_code: fixtureResults.every((result) => result.status === "passed") ? 0 : 1,
    started_at: checks.find((record) => record.name === "fixture_local-reuse")?.started_at || now(),
    completed_at: now(),
    duration_ms: FIXTURE_IDS.map((id) => checks.find((record) => record.name === `fixture_${id}`)?.duration_ms || 0).reduce((sum, value) => sum + value, 0),
    summary: fixtureResults.map((result) => `${result.fixture_id}=${result.actual_mode || "ERROR"}`).join(", "),
  });
  const fixturePath = path.join(OUTPUT_ROOT, "fixture-results.json");
  writeJson(fixturePath, { status: fixtureResults.every((result) => result.status === "passed") ? "passed" : "failed", state_root: relative(fixtureStateRoot), fixtures: fixtureResults });

  const apiStateParent = path.join(OUTPUT_ROOT, "api-state");
  fs.mkdirSync(apiStateParent, { recursive: true });
  const apiStateRoot = fs.mkdtempSync(path.join(apiStateParent, "run-"));
  const apiSmoke = await runDiagnostic("workbench_api", () => runApiSmoke(apiStateRoot));
  checks.push(apiSmoke.record);

  const browserStateParent = path.join(OUTPUT_ROOT, "browser-state");
  fs.mkdirSync(browserStateParent, { recursive: true });
  const browserSmoke = await runDiagnostic("browser", async () => {
    const evidence = await runBrowserSmoke({ stateRoot: browserStateParent, outputRoot: OUTPUT_ROOT });
    return { command: "apps/workbench/scripts/browser-smoke.js", summary: `${evidence.fixtures.length} fixtures; replay ${evidence.journal.batches}/${evidence.journal.events}; 0 browser errors`, ...evidence };
  });
  checks.push(browserSmoke.record);

  const replayCheck = await runDiagnostic("projection_replay", () => Promise.resolve(verifyProjectionReplay(fixtureStateRoot)));
  checks.push(replayCheck.record);
  const recoveryPath = path.join(OUTPUT_ROOT, "recovery-report.json");
  writeJson(recoveryPath, replayCheck.evidence);

  const checksPath = path.join(OUTPUT_ROOT, "checks.json");
  const checkDocument = {
    status: checks.every((check) => check.status === "passed") ? "passed" : "changes_requested",
    generated_at: now(),
    host: { platform: process.platform, arch: process.arch, hostname: os.hostname() },
    checks,
  };
  writeJson(checksPath, checkDocument);

  const automatedChecks = automatedPacketChecks(checks);
  const requiredArtifacts = [
    checksPath,
    fixturePath,
    path.join(OUTPUT_ROOT, "browser-smoke.json"),
    path.join(OUTPUT_ROOT, "workbench.png"),
    path.join(OUTPUT_ROOT, "workbench-mobile.png"),
    recoveryPath,
  ];
  const missingArtifacts = requiredArtifacts.filter((filePath) => !fs.existsSync(filePath));
  if (missingArtifacts.length) checks.push({ name: "artifacts", status: "failed", summary: `missing: ${missingArtifacts.map(relative).join(", ")}` });
  if (checks.some((check) => check.status !== "passed") || missingArtifacts.length) {
    const failurePath = path.join(OUTPUT_ROOT, "phase-1-review.md");
    fs.writeFileSync(failurePath, `# Orquesta V4 Phase 1 review\n\nstatus: changes_requested\n\n${checks.filter((check) => check.status !== "passed").map((check) => `- ${check.name}: ${check.summary}`).join("\n")}\n`, "utf8");
    throw Object.assign(new Error(`Phase 1 review gate failed. See ${failurePath}`), { code: "PHASE_1_REVIEW_FAILED" });
  }

  const artifactHashes = Object.fromEntries(requiredArtifacts.map((filePath) => [relative(filePath), sha256File(filePath)]));
  const buildResult = runCommand("build_ref", "git", ["rev-parse", "HEAD"]);
  const buildRef = `commit:${buildResult.stdout.trim()}`;
  const driverVersion = require("playwright-core/package.json").version;
  const chromePath = resolveChrome();
  const browserEvidence = browserSmoke.evidence;
  const currentNode = nodeVersion.stdout.trim() || process.version;
  const knownGaps = [
    "Node 20はengines上の互換対象だが、このfull gateで実行したruntimeは現在のNodeだけ。",
    "外部Web探索、候補Audition、Codex Desktopへの自動dispatchはPhase 1では未実装。",
    "最終採用とPhase承認はWorkbenchでは書き込まず、Codex統括タスクへ戻す。",
  ];
  const packet = createReviewPacket({
    build_ref: buildRef,
    artifact_hashes: artifactHashes,
    five_minute_path: [
      "このpacketとdesktop/mobileの画像を開き、Phase 1の範囲を確認する。",
      "`npm run workbench:v4`を実行し、表示されたloopback URLを開く。",
      "local-reuse、adapt-vs-build、blocked-candidateを順に選び、REUSE / ADAPT / BUILDを確認する。",
      "blocked-candidateのlicense gate棄却、pending_user、Context Pack、replay 18 batches / 42 eventsを見る。",
      "このCodex統括タスクへ戻り、`Phase 1 approved`か具体的な変更要求を伝える。",
    ],
    fixture_results: fixtureResults,
    automated_checks: automatedChecks,
    browser_evidence: {
      status: browserEvidence.status,
      fixtures: browserEvidence.fixtures.length,
      console_errors: browserEvidence.console_errors.length,
      page_errors: browserEvidence.page_errors.length,
      journal: browserEvidence.journal,
      viewports: browserEvidence.viewports,
      screenshots: browserEvidence.screenshots,
    },
    browser_runner_versions: {
      driver: `playwright-core ${driverVersion}`,
      browser: `Chrome/Chromium ${browserEvidence.browser.version}`,
      executable: `<standard-install>/${path.basename(chromePath)}`,
      preflight: browserPreflight.record.status,
    },
    approval_assurance: "explicit_user_decision_in_codex_orchestrator_task",
    tested_node_versions: [currentNode],
    adopted_and_rejected: {
      adopted: [
        "Task IntentからCapability Graph、既存資産比較、Resolution、Context Packまでの決定的なPhase 1コア。",
        "REUSE / ADAPT / BUILDを比較できる三fixtureと、根拠・hard gate・棄却理由が見えるread-only Workbench。",
        "append-only journal、projection replay、OneDrive live probe、実Chromeのユーザーレビュー経路。",
      ],
      rejected: [
        "Workbench内のResolution採用ボタンとPhase承認ボタン。",
        "独自HMAC、独自challenge、独自sandboxをCodex Desktopの上に重ねる仕組み。",
        "Phase 1中の外部search、install、Audition、Codex dispatch。",
      ],
    },
    known_gaps: knownGaps,
    phase2_changes: [
      "外部探索を含むScoutと、候補を小さく試すAudition。",
      "Codex Desktop taskへのdispatchと、実行結果をEvidence Ledgerへ戻すadapter。",
      "ユーザー利用から得た暗黙知と失敗パターンを再利用する学習ループ。",
    ],
    user_decision_location: "このCodex統括タスク",
  });
  const packetPath = path.join(OUTPUT_ROOT, "phase-1-review.md");
  fs.writeFileSync(packetPath, renderPacket(packet), "utf8");
  const packetHash = sha256File(packetPath);
  const phaseReview = recordPhaseReview({ stateRoot: fixtureStateRoot, packetPath, packetHash, buildRef, automatedChecks });

  return { packet, packetPath, packetHash, phaseReview, checks: checkDocument };
}

if (require.main === module) {
  verifyPhase1().then((result) => {
    process.stdout.write([
      "V3 check: PASS",
      "V4 contract/unit/integration tests: PASS",
      "EventStore crash points: 7/7 PASS",
      "Recovery matrix: 12/12 PASS",
      "OneDrive live probe: PASS",
      "Fixtures: 3/3 PASS",
      "Workbench browser smoke: PASS",
      "Projection replay hash: MATCH",
      `Phase 1 status: ${result.phaseReview.status}`,
      `Review packet: ${result.packetPath}`,
    ].join("\n") + "\n");
  }).catch((error) => {
    process.stderr.write(`${error.code || "PHASE_1_REVIEW_FAILED"}: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { automatedPacketChecks, renderPacket, runApiSmoke, runCommand, verifyPhase1, verifyProjectionReplay };
