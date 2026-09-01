"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { mock } = require("node:test");

const { createAppServerExecutionBridge } = require("../src");
const {
  cleanupProofRuntime,
  finalizeProofArtifact,
  normalizeProofAnswer,
} = require("../scripts/live-two-task-proof");

function completed(operation, fields = {}) {
  return { ok: true, status: "completed", operation, ...fields };
}

function failed(operation, code) {
  return {
    ok: false,
    status: "failed",
    operation,
    error: { code, message: code },
    evidence: { dispatch_accepted: code === "runtime_outcome_unknown" },
  };
}

function cleanupHarness({
  startResult = failed("startTurn", "runtime_failed"),
  setThreadNameResult = null,
  snapshots = [{ status: "idle", turns: [] }],
  archiveResult = completed("archiveThread"),
  shutdownResult = completed("shutdown"),
} = {}) {
  const calls = [];
  let readCount = 0;
  const adapter = {
    subscribeEvents() {
      return completed("subscribeEvents", { subscription: { unsubscribe() {} } });
    },
    createThread() {
      calls.push(["createThread"]);
      return completed("createThread", { thread_id: "thread-proof" });
    },
    startTurn() {
      calls.push(["startTurn"]);
      return typeof startResult === "function" ? startResult() : startResult;
    },
    readThread(input) {
      calls.push(["readThread", input.threadId]);
      const snapshot = snapshots[Math.min(readCount, snapshots.length - 1)];
      readCount += 1;
      return completed("readThread", {
        thread: {
          id: input.threadId,
          status: snapshot.status,
          turns: snapshot.turns.map((turn) => ({ ...turn, items: [] })),
        },
      });
    },
    interruptTurn(input) {
      calls.push(["interruptTurn", input.threadId, input.turnId]);
      return completed("interruptTurn", { thread_id: input.threadId, turn_id: input.turnId });
    },
    archiveThread(input) {
      calls.push(["archiveThread", input.threadId]);
      return archiveResult;
    },
    shutdown() {
      calls.push(["shutdown"]);
      return shutdownResult;
    },
  };
  if (setThreadNameResult) {
    adapter.setThreadName = () => {
      calls.push(["setThreadName"]);
      return setThreadNameResult;
    };
  }
  const bridge = createAppServerExecutionBridge({
    adapter,
    maxTasks: 2,
    resolveTask: () => ({ cwd: process.cwd(), prompt: "proof", thread_name: "proof" }),
  });
  return { adapter, bridge, calls };
}

async function start(harness, taskId = "A") {
  return harness.bridge.start({
    task_id: taskId,
    dispatch_id: `dispatch-${taskId}`,
    execution_key: `execution-${taskId}`,
    attempt: 1,
  });
}

function successfulCleanup(threadCount = 0) {
  const threads = Array.from({ length: threadCount }, (_, index) => ({
    thread_id: `thread-${index + 1}`,
    settlement: "known_turn",
    inspected: true,
    observed_turn_count: 1,
    interrupted_turn_ids: [],
    quiescence_read_count: 1,
    archived: true,
  }));
  return {
    proof_owned_thread_count: threadCount,
    inspected_thread_count: threadCount,
    interrupted_turn_count: 0,
    archived_thread_count: threadCount,
    provider_shutdown: true,
    threads,
  };
}

function artifactFixture(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const outputDirectory = path.join(root, "output", "execution-kernel");
  const outputPath = path.join(outputDirectory, "live-two-task-proof-test.json");
  return { root, outputDirectory, outputPath };
}

function assertNoPublishTemps(root) {
  const staging = path.join(root, ".orquesta", "runtime", "exclusive-json-publish-v1");
  assert.deepEqual(fs.existsSync(staging) ? fs.readdirSync(staging) : [], []);
}

test("normalizes plain and inline-code proof answers without accepting extra content", () => {
  assert.equal(normalizeProofAnswer("orquesta-v5"), "orquesta-v5");
  assert.equal(normalizeProofAnswer("`@orquesta/execution-kernel`"), "@orquesta/execution-kernel");
  assert.equal(normalizeProofAnswer("answer plus explanation"), "answer plus explanation");
});

test("archives only a definitively pre-provider idle thread", async () => {
  const harness = cleanupHarness();
  await assert.rejects(start(harness), /runtime_failed/u);
  const cleanup = await cleanupProofRuntime({
    adapter: harness.adapter,
    bridge: harness.bridge,
    taskIds: ["A"],
  });
  assert.equal(cleanup.archived_thread_count, 1);
  assert.equal(cleanup.threads[0].settlement, "pre_provider");
  assert.deepEqual(harness.calls.map((call) => call[0]), [
    "createThread", "startTurn", "readThread", "archiveThread", "shutdown",
  ]);
});

test("archives a created idle thread when naming fails before startTurn is issued", async () => {
  const harness = cleanupHarness({ setThreadNameResult: failed("setThreadName", "name_failed") });
  await assert.rejects(start(harness), /name_failed/u);
  assert.equal(harness.bridge.readTaskSession("A").start_turn_stage, "not_issued");
  const cleanup = await cleanupProofRuntime({ adapter: harness.adapter, bridge: harness.bridge, taskIds: ["A"] });
  assert.equal(cleanup.archived_thread_count, 1);
  assert.equal(cleanup.threads[0].settlement, "pre_provider");
  assert.deepEqual(harness.calls.map((call) => call[0]), [
    "createThread", "setThreadName", "readThread", "archiveThread", "shutdown",
  ]);
});

test("unknown outcomes and absent acceptance evidence never certify a pre-provider failure", async (t) => {
  const unknown = failed("startTurn", "runtime_outcome_unknown");
  unknown.evidence.dispatch_accepted = false;
  const missing = failed("startTurn", "runtime_failed");
  delete missing.evidence;
  for (const [name, startResult] of [
    ["unknown without accepted receipt", unknown],
    ["failure without evidence", missing],
    ["thrown failure without evidence", () => { throw new Error("start_transport_failed"); }],
  ]) {
    await t.test(name, async () => {
      const harness = cleanupHarness({ startResult });
      await assert.rejects(start(harness));
      await assert.rejects(cleanupProofRuntime({
        adapter: harness.adapter,
        bridge: harness.bridge,
        taskIds: ["A"],
        quiescenceDelaysMs: [0, 0],
        sleep: async () => {},
      }), (error) => error.cleanup.threads[0].settlement === "observe_active"
        && error.errors.some((nested) => /recovery_required/u.test(nested.message)));
      assert.equal(harness.calls.some((call) => call[0] === "archiveThread"), false);
    });
  }
});

test("a later dispatch cannot clear an unresolved start and make cleanup archive the thread", async (t) => {
  for (const accepted of [true, false]) {
    await t.test(`unknown accepted receipt: ${accepted}`, async () => {
      const unknown = failed("startTurn", "runtime_outcome_unknown");
      unknown.evidence.dispatch_accepted = accepted;
      const harness = cleanupHarness({ startResult: unknown });
      await assert.rejects(start(harness), { code: "runtime_outcome_unknown" });
      const unresolved = harness.bridge.readTaskSession("A");
      harness.adapter.startTurn = () => {
        harness.calls.push(["unexpectedSecondStart"]);
        return completed("startTurn", { thread_id: "thread-proof", turn_id: "second-known-turn" });
      };
      await assert.rejects(harness.bridge.start({
        task_id: "A", dispatch_id: "dispatch-A-2", execution_key: "execution-A", attempt: 2,
      }), { code: "runtime_outcome_unknown" });
      assert.deepEqual(harness.bridge.readTaskSession("A"), unresolved);
      assert.equal(harness.calls.some((call) => call[0] === "unexpectedSecondStart"), false);
      await assert.rejects(cleanupProofRuntime({
        adapter: harness.adapter,
        bridge: harness.bridge,
        taskIds: ["A"],
        quiescenceDelaysMs: [0, 0],
        sleep: async () => {},
      }), (error) => error.cleanup.archived_thread_count === 0
        && error.cleanup.threads[0].settlement === "observe_active");
      assert.equal(harness.calls.some((call) => call[0] === "archiveThread"), false);
    });
  }
});

test("same-task starts reserve session creation before a thread identity exists", async () => {
  const harness = cleanupHarness({ startResult: failed("startTurn", "runtime_outcome_unknown") });
  let resolveThread;
  let createCount = 0;
  harness.adapter.createThread = () => {
    createCount += 1;
    return new Promise((resolve) => { resolveThread = resolve; });
  };
  const first = assert.rejects(start(harness), { code: "runtime_outcome_unknown" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.bridge.readTaskSession("A"), null);
  await assert.rejects(harness.bridge.start({
    task_id: "A", dispatch_id: "dispatch-A-2", execution_key: "execution-A", attempt: 2,
  }), { code: "task_start_in_progress" });
  assert.equal(createCount, 1);
  resolveThread(completed("createThread", { thread_id: "thread-proof" }));
  await first;
  assert.equal(harness.bridge.readTaskSession("A").thread_id, "thread-proof");
  await assert.rejects(cleanupProofRuntime({
    adapter: harness.adapter,
    bridge: harness.bridge,
    taskIds: ["A"],
    quiescenceDelaysMs: [0, 0],
    sleep: async () => {},
  }), (error) => error.cleanup.proof_owned_thread_count === 1
    && error.cleanup.threads[0].thread_id === "thread-proof"
    && error.cleanup.archived_thread_count === 0);
  assert.equal(harness.calls.some((call) => call[0] === "archiveThread"), false);
});

test("observes a late active turn after an outcome-unknown idle snapshot before interrupting and archiving", async () => {
  const harness = cleanupHarness({
    startResult: failed("startTurn", "runtime_outcome_unknown"),
    snapshots: [
      { status: "idle", turns: [] },
      { status: "active", turns: [{ id: "turn-late", status: "inProgress" }] },
      { status: "idle", turns: [{ id: "turn-late", status: "interrupted" }] },
    ],
  });
  await assert.rejects(start(harness), /runtime_outcome_unknown/u);
  const cleanup = await cleanupProofRuntime({
    adapter: harness.adapter,
    bridge: harness.bridge,
    taskIds: ["A"],
    quiescenceDelaysMs: [0, 0],
    sleep: async () => {},
  });
  assert.equal(cleanup.interrupted_turn_count, 1);
  assert.equal(cleanup.archived_thread_count, 1);
  assert.deepEqual(harness.calls.slice(-6), [
    ["readThread", "thread-proof"],
    ["readThread", "thread-proof"],
    ["interruptTurn", "thread-proof", "turn-late"],
    ["readThread", "thread-proof"],
    ["archiveThread", "thread-proof"],
    ["shutdown"],
  ]);
});

test("keeps an outcome-unknown idle thread unarchived when no exact active turn becomes observable", async () => {
  const harness = cleanupHarness({
    startResult: failed("startTurn", "runtime_outcome_unknown"),
    snapshots: [{ status: "idle", turns: [] }],
  });
  await assert.rejects(start(harness));
  await assert.rejects(
    cleanupProofRuntime({
      adapter: harness.adapter,
      bridge: harness.bridge,
      taskIds: ["A"],
      quiescenceDelaysMs: [0, 0, 0],
      sleep: async () => {},
    }),
    (error) => error instanceof AggregateError
      && error.errors.some((nested) => /recovery_required/u.test(nested.message)),
  );
  assert.equal(harness.calls.some((call) => call[0] === "archiveThread"), false);
  assert.equal(harness.calls.at(-1)[0], "shutdown");
});

test("whole-proof timeout mode does not treat an already-idle known turn as safe archival evidence", async () => {
  const harness = cleanupHarness({
    startResult: completed("startTurn", { thread_id: "thread-proof", turn_id: "turn-known" }),
    snapshots: [{ status: "idle", turns: [{ id: "turn-known", status: "completed" }] }],
  });
  const dispatch = await start(harness);
  await assert.rejects(
    cleanupProofRuntime({
      adapter: harness.adapter,
      bridge: harness.bridge,
      taskIds: ["A"],
      dispatchResults: [{ task_id: "A", ...dispatch }],
      forceOutcomeUnknown: true,
      quiescenceDelaysMs: [0, 0],
      sleep: async () => {},
    }),
    (error) => error instanceof AggregateError
      && error.errors.some((nested) => /recovery_required/u.test(nested.message)),
  );
  assert.equal(harness.calls.some((call) => call[0] === "archiveThread"), false);
});

test("does not archive when an interrupted active turn never becomes terminal", async () => {
  const active = { status: "active", turns: [{ id: "turn-active", status: "inProgress" }] };
  const harness = cleanupHarness({
    startResult: failed("startTurn", "runtime_outcome_unknown"),
    snapshots: [active],
  });
  await assert.rejects(start(harness));
  await assert.rejects(
    cleanupProofRuntime({
      adapter: harness.adapter,
      bridge: harness.bridge,
      taskIds: ["A"],
      quiescenceDelaysMs: [0, 0],
      sleep: async () => {},
    }),
    (error) => error instanceof AggregateError
      && error.errors.some((nested) => /quiescence_timeout/u.test(nested.message)),
  );
  assert.equal(harness.calls.some((call) => call[0] === "archiveThread"), false);
});

test("reports archive and provider shutdown failures instead of publishing false cleanup success", async () => {
  const harness = cleanupHarness({
    archiveResult: failed("archiveThread", "archive_failed"),
    shutdownResult: failed("shutdown", "shutdown_failed"),
  });
  await assert.rejects(start(harness));
  await assert.rejects(
    cleanupProofRuntime({
      adapter: harness.adapter,
      bridge: harness.bridge,
      taskIds: ["A"],
    }),
    (error) => error instanceof AggregateError
      && error.errors.some((nested) => nested.code === "archive_failed")
      && error.errors.some((nested) => nested.code === "shutdown_failed")
      && error.cleanup?.provider_shutdown === false,
  );
});

test("publishes only after cleanup succeeds and reparses the exact final JSON", async () => {
  const fixture = artifactFixture("orquesta-live-proof-finalize-");
  try {
    await assert.rejects(
      finalizeProofArtifact({
        proof: { schema_version: 1, status: "passed" },
        cleanupOperation: async () => { throw new Error("cleanup_failed"); },
        repositoryRoot: fixture.root,
        outputPath: fixture.outputPath,
        finishedAt: () => "2026-08-31T00:00:01.000Z",
      }),
      /cleanup_failed/u,
    );
    assert.equal(fs.existsSync(fixture.outputPath), false);

    const finalized = await finalizeProofArtifact({
      proof: { schema_version: 1, status: "passed" },
      cleanupOperation: async () => successfulCleanup(),
      repositoryRoot: fixture.root,
      outputPath: fixture.outputPath,
      finishedAt: () => "2026-08-31T00:00:02.000Z",
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(fixture.outputPath, "utf8")), finalized);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("rejects an undefined proof payload before creating an artifact", async () => {
  const fixture = artifactFixture("orquesta-live-proof-undefined-");
  try {
    await assert.rejects(
      finalizeProofArtifact({
        proof: undefined,
        cleanupOperation: async () => successfulCleanup(),
        repositoryRoot: fixture.root,
        outputPath: fixture.outputPath,
        finishedAt: () => "2026-08-31T00:00:03.000Z",
      }),
      TypeError,
    );
    assert.equal(fs.existsSync(fixture.outputPath), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a directory swap during promotion leaves no artifact in the external junction target", async (t) => {
  const fixture = artifactFixture("orquesta-live-proof-swap-");
  const external = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-live-proof-external-"));
  const parked = path.join(fixture.root, "parked-output");
  fs.mkdirSync(fixture.outputDirectory, { recursive: true });
  const originalLink = fs.linkSync.bind(fs);
  let swapped = false;
  mock.method(fs, "linkSync", (sourcePath, targetPath) => {
    if (!swapped && targetPath === fixture.outputPath) {
      swapped = true;
      fs.renameSync(fixture.outputDirectory, parked);
      try {
        fs.symlinkSync(external, fixture.outputDirectory, process.platform === "win32" ? "junction" : "dir");
      } catch (cause) {
        t.skip(`directory link unavailable: ${cause.code || cause.message}`);
        throw cause;
      }
    }
    return originalLink(sourcePath, targetPath);
  });
  try {
    await assert.rejects(
      finalizeProofArtifact({
        proof: { schema_version: 1, status: "passed" },
        cleanupOperation: async () => successfulCleanup(),
        repositoryRoot: fixture.root,
        outputPath: fixture.outputPath,
        finishedAt: () => "2026-08-31T00:00:04.000Z",
      }),
    );
    assert.deepEqual(fs.readdirSync(external), []);
    assertNoPublishTemps(fixture.root);
  } finally {
    mock.restoreAll();
    if (fs.existsSync(fixture.outputDirectory) && fs.lstatSync(fixture.outputDirectory).isSymbolicLink()) {
      fs.unlinkSync(fixture.outputDirectory);
    }
    fs.rmSync(fixture.root, { recursive: true, force: true });
    fs.rmSync(external, { recursive: true, force: true });
  }
});

test("rejects and preserves a same-bytes final that is not the owned candidate inode", async () => {
  const fixture = artifactFixture("orquesta-live-proof-inode-");
  const originalLink = fs.linkSync.bind(fs);
  mock.method(fs, "linkSync", (sourcePath, targetPath) => {
    if (targetPath === fixture.outputPath) {
      fs.copyFileSync(sourcePath, targetPath);
      return;
    }
    return originalLink(sourcePath, targetPath);
  });
  try {
    await assert.rejects(
      finalizeProofArtifact({
        proof: { schema_version: 1, status: "passed" },
        cleanupOperation: async () => successfulCleanup(),
        repositoryRoot: fixture.root,
        outputPath: fixture.outputPath,
        finishedAt: () => "2026-08-31T00:00:05.000Z",
      }),
      (error) => error.code === "LIVE_PROOF_ARTIFACT_PUBLISH_IDENTITY_MISMATCH",
    );
    const preserved = JSON.parse(fs.readFileSync(fixture.outputPath, "utf8"));
    assert.equal(preserved.schema_version, 1);
    assert.equal(preserved.status, "passed");
    assert.equal(preserved.finished_at, "2026-08-31T00:00:05.000Z");
    assertNoPublishTemps(fixture.root);
  } finally {
    mock.restoreAll();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
