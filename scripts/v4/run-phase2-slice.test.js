"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createAppServerAdapter } = require("@orquesta/codex-adapter");
const { FakeAppServerProcess } = require("../../packages/codex-adapter/test/fixtures/fake-app-server");
const { createLiveNetworkConnectors, removeOwnedTemporaryRoot, runAdapterTurn, runDeterministicPhase2Slice, runLivePhase2Slice } = require("./run-phase2-slice");

function thread(id) {
  return { cliVersion: "0.144.5", createdAt: 1, cwd: "C:\\phase2", ephemeral: false, id, modelProvider: "openai", preview: "", sessionId: `session-${id}`, source: "appServer", status: "idle", turns: [], updatedAt: 1 };
}

function fakeAppServer() {
  const child = new FakeAppServerProcess();
  child.on("clientMessage", (message) => {
    if (message.method === "initialize") {
      child.send({ id: message.id, result: { codexHome: "C:\\codex-home", platformFamily: "windows", platformOs: "windows", userAgent: "codex-cli/0.144.5" } });
    } else if (message.method === "thread/start") {
      child.send({ id: message.id, result: { approvalPolicy: "on-request", approvalsReviewer: "user", cwd: "C:\\phase2", model: "requested-model", modelProvider: "openai", sandbox: "workspace-write", thread: thread("thread-phase2") } });
    } else if (message.method === "turn/start") {
      child.send({ id: message.id, result: { turn: { id: "turn-phase2", items: [], status: "inProgress" } } });
      setImmediate(() => {
        child.send({ method: "turn/started", params: { threadId: "thread-phase2", turn: { id: "turn-phase2", items: [], status: "inProgress" } } });
        child.send({ method: "item/completed", params: { completedAtMs: 2, item: { id: "item-phase2", type: "agent_message" }, threadId: "thread-phase2", turnId: "turn-phase2" } });
        child.send({ method: "turn/completed", params: { threadId: "thread-phase2", turn: { id: "turn-phase2", items: [], status: "completed" } } });
      });
    }
  });
  return createAppServerAdapter({
    resolveRuntime: () => ({ sdk_package: "@openai/codex-sdk", sdk_version: "0.144.5", codex_package: "@openai/codex", codex_version: "0.144.5", runtime_package: "@openai/codex-win32-x64", runtime_package_version: "0.144.5-win32-x64", target_triple: "x86_64-pc-windows-msvc", executable_path: "C:\\runtime\\codex.exe" }),
    spawnProcess: () => child
  });
}

function temporaryRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `orquesta-phase2-${label}-`));
}

test("deterministic Phase 2 slice proves stable acquisition, Audition, runtime, artifact, report, acceptance, and replay evidence", async () => {
  const stateRoot = temporaryRoot("stable");
  const first = await runDeterministicPhase2Slice({ stateRoot, runtimeAdapter: fakeAppServer() });
  const second = await runDeterministicPhase2Slice({ stateRoot, runtimeAdapter: fakeAppServer() });

  assert.deepEqual(first.stable_ids, second.stable_ids);
  assert.equal(first.acquisition.candidate_count, 3);
  assert.deepEqual(first.acquisition.connector_ids, ["github", "official_docs", "registry", "ui_catalog"]);
  assert.equal(first.audit.hard_gate_rejection_count, 1);
  assert.equal(first.audition.approval_wait_observed, true);
  assert.equal(first.audition.verdict, "passed");
  assert.ok(first.audition.cleanup_evidence.includes("cleanup:clean"));
  assert.deepEqual(first.runtime.timeline, ["dispatch_accepted", "turn_started", "progress_observed", "turn_completed"]);
  assert.equal(first.runtime.actual_model, null);
  assert.match(first.artifact.hash, /^[a-f0-9]{64}$/);
  assert.match(first.report.hash, /^[a-f0-9]{64}$/);
  assert.equal(first.acceptance.status, "passed");
  assert.equal(first.journal.replay_equivalent, true);
  assert.equal(first.journal.evidence_count, 7);
  assert.equal(first.review_packet.status, "ready_for_user_review");
  assert.equal(first.repository_fallback.live_turn_eligible, false);
});

test("deterministic slice rejects a turn start without a matching accepted dispatch", async () => {
  await assert.rejects(
    runDeterministicPhase2Slice({ stateRoot: temporaryRoot("bad-order"), runtimeAdapter: fakeAppServer(), fault: "turn_started_before_dispatch" }),
    (error) => error && error.code === "EVIDENCE_PREDECESSOR_REQUIRED"
  );
});

test("deterministic slice has a built-in no-network runtime for direct script execution", async () => {
  const result = await runDeterministicPhase2Slice({ stateRoot: temporaryRoot("built-in") });
  assert.equal(result.runtime.adapter, "app_server");
  assert.equal(result.journal.replay_equivalent, true);
});

test("live docs connector binds fetched bytes and rejects a final redirect outside first-party origins", async () => {
  const query = {
    need_id: "NEED-live-docs",
    query_terms: ["codex"],
    allowed_connector_ids: ["official_docs"],
    request_budget: { max_requests_per_need: 8, max_requests_per_connector: 2 },
    candidate_limit: 3,
    requested_at: "2026-07-17T00:00:00.000Z"
  };
  const run = async (body, url = "https://learn.chatgpt.com/docs") => {
    const [connector] = createLiveNetworkConnectors({
      fetchImpl: async () => ({ ok: true, status: 200, url, async text() { return body; } }),
      clock: () => "2026-07-17T00:00:00.000Z"
    });
    return connector.search({ query, budget: { remaining_total: 7, remaining_connector: 1 } });
  };
  const first = await run("official docs snapshot one");
  const second = await run("official docs snapshot two");
  assert.notEqual(first.source_evidence[0].source_hash, second.source_evidence[0].source_hash);
  await assert.rejects(run("outside", "https://outside.example.test/docs"), { code: "SOURCE_REDIRECT_OUTSIDE_ALLOWLIST" });
});

test("runtime observation unsubscribes immediately when thread creation fails", async () => {
  let unsubscribed = false;
  const adapter = {
    subscribeEvents: () => ({ subscription: { unsubscribe: () => { unsubscribed = true; } } }),
    createThread: async () => ({ ok: false, status: "unavailable" }),
    interruptTurn: async () => ({ ok: true })
  };
  await assert.rejects(
    runAdapterTurn({ adapter, adapterKind: "typescript_sdk", correlationId: "CORR-early-failure", workingDirectory: "C:\\phase2", timeoutMs: 50 }),
    { code: "PHASE2_RUNTIME_UNAVAILABLE" }
  );
  assert.equal(unsubscribed, true);
});

test("SDK Audition opts into its verified non-git root and surfaces runtime errors without waiting for timeout", async () => {
  let listener;
  let profile;
  let unsubscribed = false;
  const adapter = {
    subscribeEvents: ({ listener: value }) => {
      listener = value;
      return { subscription: { unsubscribe: () => { unsubscribed = true; } } };
    },
    createThread: async (input) => {
      profile = input.profile;
      return { ok: true, thread_id: null, thread_handle: "CORR-runtime-error:thread" };
    },
    startTurn: async ({ correlationId }) => {
      queueMicrotask(() => listener({ type: "runtime_error", correlation_id: correlationId, message: "not a git repository" }));
      return { ok: true, thread_id: null, turn_id: null, evidence: { dispatch_accepted: true } };
    },
    interruptTurn: async () => ({ ok: true })
  };
  await assert.rejects(
    runAdapterTurn({ adapter, adapterKind: "typescript_sdk", correlationId: "CORR-runtime-error", workingDirectory: "C:\\audition", timeoutMs: 1000 }),
    (error) => error?.code === "PHASE2_RUNTIME_ERROR" && error?.details?.runtime_message === "not a git repository"
  );
  assert.equal(profile.skipGitRepoCheck, true);
  assert.equal(unsubscribed, true);
});

test("live Audition root cleanup uses bounded Windows transient retries only under the OS temp directory", () => {
  const calls = [];
  const owned = path.join(os.tmpdir(), "orquesta-phase2-owned-cleanup");
  removeOwnedTemporaryRoot(owned, { rmSync: (...args) => calls.push(args) });
  assert.deepEqual(calls, [[owned, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100
  }]]);
  assert.throws(() => removeOwnedTemporaryRoot(os.tmpdir(), { rmSync() {} }), { code: "PHASE2_TEMP_ROOT_INVALID" });
  assert.throws(() => removeOwnedTemporaryRoot(path.resolve(os.tmpdir(), "..", "outside"), { rmSync() {} }), { code: "PHASE2_TEMP_ROOT_INVALID" });
});

test("live slice uses injected network and runtime boundaries without installing a candidate", async () => {
  const projectRoot = temporaryRoot("live-project");
  const outputRoot = path.join(projectRoot, "output", "v4-phase2-review");
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    url,
    async text() {
      return url.includes("registry.npmjs.org")
        ? JSON.stringify({ version: "0.144.5", license: "Apache-2.0" })
        : "official Codex documentation snapshot";
    }
  });
  const runtimeExecutor = async ({ correlationId }) => ({
    adapter: "typescript_sdk",
    thread_id: "thread-live",
    turn_id: null,
    dispatch: { ok: true, evidence: { dispatch_accepted: true }, correlation_id: correlationId },
    started: { type: "turn_started", correlation_id: correlationId, thread_id: "thread-live", turn_id: null },
    progress: { type: "progress_observed", correlation_id: correlationId, thread_id: "thread-live", turn_id: null },
    completed: { type: "turn_completed", correlation_id: correlationId, thread_id: "thread-live", turn_id: null },
    timeline: ["dispatch_accepted", "turn_started", "progress_observed", "artifact_produced", "turn_completed"],
    artifact_content: "ORQUESTA_PHASE2_LIVE_OK",
    dispatch_accepted: true,
    turn_started: true,
    turn_completed: true,
    actual_model: null,
    actual_model_evidence_ref: null
  });

  const result = await runLivePhase2Slice({
    stateRoot: projectRoot,
    outputRoot,
    allowNetwork: true,
    allowCodexTurn: true,
    fetchImpl,
    runtimeExecutor,
    clock: () => "2026-07-17T00:00:00.000Z"
  });
  assert.deepEqual(result.source_families, ["official_docs", "registry"]);
  assert.equal(result.audited_candidate.candidate_id, "registry:codex-sdk");
  assert.equal(result.audition.verdict, "passed");
  assert.equal(result.audition.installed, false);
  assert.equal(result.runtime.turn_completed, true);
  assert.equal(result.runtime.actual_model, null);
  assert.equal(result.acceptance.status, "passed");
  assert.equal(result.journal.replay_equivalent, true);
  assert.equal(result.journal.evidence_count, 7);
});
