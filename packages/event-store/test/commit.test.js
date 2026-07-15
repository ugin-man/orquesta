"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");

const {
  createEventStore,
  acquireJournalLock,
  releaseJournalLock,
  inspectJournalLock,
  CRASH_POINTS,
} = require("../src");
const { replaceFileAtomic } = require("../src/atomic-replace");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-event-store-"));
  return {
    root,
    journalPath: path.join(root, "events.jsonl"),
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function batch(overrides = {}) {
  const { event_id: eventId, ...requestOverrides } = overrides;
  const batchId = requestOverrides.batch_id || `batch-${crypto.randomUUID()}`;
  return {
    expected_revision: 0,
    batch_id: batchId,
    actor: { type: "agent", id: "implementation-001" },
    correlation_id: `correlation-${batchId}`,
    events: [
      {
        event_id: eventId || `event-${crypto.randomUUID()}`,
        schema_version: 1,
        type: "task.updated",
        payload: { title: "日本語を含む durable journal" },
        evidence_refs: ["test://event-store"],
      },
    ],
    ...requestOverrides,
  };
}

function readLines(journalPath) {
  return fs.readFileSync(journalPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function pendingFiles(root) {
  const directory = path.join(root, "pending");
  return fs.existsSync(directory) ? fs.readdirSync(directory) : [];
}

function transientArtifacts(root) {
  const found = [];
  function visit(directory) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.name.includes(".lock") || entry.name.includes(".transition-") || entry.name.includes(".release-") || entry.name.endsWith(".tmp")) found.push(target);
    }
  }
  visit(root);
  return found;
}

async function waitForFiles(filePaths, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (filePaths.every((filePath) => fs.existsSync(filePath))) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${filePaths.join(", ")}`);
}

function runWorker(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "crash-worker.js"), ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test("exports the fixed durable journal surface and ordered crash points", () => {
  assert.equal(typeof createEventStore, "function");
  assert.equal(typeof acquireJournalLock, "function");
  assert.equal(typeof releaseJournalLock, "function");
  assert.equal(typeof inspectJournalLock, "function");
  assert.deepEqual(CRASH_POINTS, [
    "before_pending_write",
    "after_pending_fsync",
    "after_temp_journal_fsync",
    "after_journal_rename",
    "after_journal_verify",
    "after_projection_write",
    "before_pending_delete",
  ]);
});

test("commits one validated batch and retries an identical immutable request idempotently", () => {
  const f = fixture();
  try {
    let now = "2026-07-15T08:45:11.000Z";
    const store = createEventStore({ stateRoot: f.root, workspaceId: "workspace-a", clock: () => now });
    const request = batch();
    assert.deepEqual(store.commit(request), { status: "committed", sequence: 1 });
    now = "2026-07-15T08:45:12.000Z";
    assert.deepEqual(store.commit(request), { status: "idempotent", sequence: 1 });
    const lines = readLines(f.journalPath);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].sequence, 1);
    assert.equal(lines[0].expected_revision, 0);
    assert.equal(lines[0].journal_version, 1);
    assert.equal(lines[0].committed_at, "2026-07-15T08:45:11.000Z");
    assert.equal(lines[0].events[0].payload.title, "日本語を含む durable journal");
  } finally {
    f.cleanup();
  }
});

test("blocks conflicting batch ids, duplicate events, revision conflicts, and malformed journals before append", () => {
  const f = fixture();
  try {
    const store = createEventStore({ stateRoot: f.root, workspaceId: "workspace-a" });
    const original = batch({ batch_id: "batch-fixed", event_id: "event-fixed" });
    store.commit(original);
    assert.throws(() => store.commit({ ...original, events: [{ ...original.events[0], event_id: "event-changed" }] }), { code: "EVENT_BATCH_ID_CONFLICT" });
    assert.throws(() => store.commit(batch({ expected_revision: 1, event_id: "event-fixed" })), { code: "EVENT_DUPLICATE_EVENT_ID" });
    assert.throws(() => store.commit(batch({ expected_revision: 0 })), { code: "EVENT_REVISION_CONFLICT" });
    fs.writeFileSync(f.journalPath, "{not-json}\n", "utf8");
    assert.throws(() => store.commit(batch()), { code: "EVENT_JOURNAL_INVALID" });
  } finally {
    f.cleanup();
  }
});

test("returns a structured EventStore error for null and invalid event ids", () => {
  const f = fixture();
  try {
    const store = createEventStore({ stateRoot: f.root, workspaceId: "workspace-a" });
    assert.throws(() => store.commit(null), { code: "EVENT_BATCH_INVALID" });
    const invalidEventId = batch();
    invalidEventId.events[0].event_id = "";
    assert.throws(() => store.commit(invalidEventId), { code: "EVENT_BATCH_INVALID" });
    assert.equal(fs.existsSync(f.journalPath), false);
  } finally {
    f.cleanup();
  }
});

test("wraps JSON-external payload values as EVENT_BATCH_INVALID", () => {
  const f = fixture();
  try {
    const request = batch();
    request.events[0].payload.unsupported = undefined;
    const store = createEventStore({ stateRoot: f.root, workspaceId: "workspace-a" });
    assert.throws(() => store.commit(request), (error) => error.code === "EVENT_BATCH_INVALID" && error.details.cause_code === "CANONICALIZATION_FAILED");
    assert.equal(fs.existsSync(f.journalPath), false);
  } finally {
    f.cleanup();
  }
});

test("blocks malformed UTF-8 and a journal without a final newline", () => {
  const f = fixture();
  try {
    const store = createEventStore({ stateRoot: f.root, workspaceId: "workspace-a" });
    fs.writeFileSync(f.journalPath, Buffer.from([0xff, 0xfe]));
    assert.throws(() => store.commit(batch()), { code: "EVENT_JOURNAL_INVALID" });
    fs.writeFileSync(f.journalPath, JSON.stringify({ journal_version: 1 }), "utf8");
    assert.throws(() => store.commit(batch()), { code: "EVENT_JOURNAL_INVALID" });
  } finally {
    f.cleanup();
  }
});

test("records lock ownership metadata, refuses stale locks, and preserves a replacement nonce on release", () => {
  const f = fixture();
  try {
    const lock = acquireJournalLock({ journalPath: f.journalPath, hostId: "host-a", targetRevision: 0, timeoutMs: 20 });
    const inspected = inspectJournalLock(f.journalPath);
    assert.equal(inspected.exists, true);
    assert.equal(inspected.metadata.owner_pid, process.pid);
    assert.equal(inspected.metadata.host_id, "host-a");
    assert.equal(inspected.metadata.target_revision, 0);
    assert.equal(typeof inspected.metadata.nonce, "string");
    assert.equal(typeof inspected.metadata.acquired_at, "string");
    assert.equal(new Date(inspected.metadata.acquired_at).toISOString(), inspected.metadata.acquired_at);

    fs.unlinkSync(`${f.journalPath}.lock`);
    fs.writeFileSync(`${f.journalPath}.lock`, `${JSON.stringify({ ...lock.metadata, nonce: "replacement" })}\n`, "utf8");
    assert.throws(() => releaseJournalLock(lock), { code: "EVENT_LOCK_OWNERSHIP_LOST" });
    assert.equal(inspectJournalLock(f.journalPath).metadata.nonce, "replacement");
    fs.unlinkSync(`${f.journalPath}.lock`);
    fs.writeFileSync(`${f.journalPath}.lock`, "not-json\n", "utf8");
    assert.throws(() => acquireJournalLock({ journalPath: f.journalPath, hostId: "host-a", targetRevision: 1, timeoutMs: 1 }), { code: "EVENT_STALE_LOCK" });
  } finally {
    f.cleanup();
  }
});

test("does not steal a valid dead-owner lock", () => {
  const f = fixture();
  try {
    const lockPath = `${f.journalPath}.lock`;
    const metadata = {
      owner_pid: 2147483647,
      host_id: "host-a",
      nonce: "dead-owner-nonce",
      acquired_at: "2026-07-15T08:45:10.000Z",
      target_revision: 0,
    };
    fs.writeFileSync(lockPath, `${JSON.stringify(metadata)}\n`, "utf8");
    assert.throws(() => acquireJournalLock({ journalPath: f.journalPath, hostId: "host-a", targetRevision: 0, timeoutMs: 1 }), { code: "EVENT_STALE_LOCK" });
    assert.deepEqual(JSON.parse(fs.readFileSync(lockPath, "utf8")), metadata);
  } finally {
    f.cleanup();
  }
});

test("treats semantically malformed live-owner metadata as stale evidence", () => {
  const f = fixture();
  try {
    const lockPath = `${f.journalPath}.lock`;
    fs.writeFileSync(lockPath, `${JSON.stringify({
      owner_pid: process.pid,
      host_id: "host-a",
      nonce: "",
      acquired_at: "not-a-timestamp",
      target_revision: -1,
    })}\n`, "utf8");
    assert.throws(() => acquireJournalLock({ journalPath: f.journalPath, hostId: "host-a", targetRevision: 0, timeoutMs: 1 }), { code: "EVENT_STALE_LOCK" });
    assert.equal(fs.existsSync(lockPath), true);
  } finally {
    f.cleanup();
  }
});

test("does not move a replacement owner during release transition", () => {
  const f = fixture();
  try {
    const lock = acquireJournalLock({ journalPath: f.journalPath, hostId: "host-a", targetRevision: 0, timeoutMs: 20 });
    const replacement = { ...lock.metadata, nonce: "replacement-after-inspect" };
    assert.throws(() => releaseJournalLock(lock, {
      testHooks: {
        afterTransitionMarker() {
          fs.unlinkSync(lock.lockPath);
          fs.writeFileSync(lock.lockPath, `${JSON.stringify(replacement)}\n`, "utf8");
        },
      },
    }), { code: "EVENT_LOCK_OWNERSHIP_LOST" });
    assert.equal(inspectJournalLock(f.journalPath).metadata.nonce, replacement.nonce);
  } finally {
    f.cleanup();
  }
});

test("restores a replacement owner swapped after the final release recheck", () => {
  const f = fixture();
  try {
    const lock = acquireJournalLock({ journalPath: f.journalPath, hostId: "host-a", targetRevision: 0, timeoutMs: 20 });
    const replacement = { ...lock.metadata, nonce: "replacement-before-release-move" };
    assert.throws(() => releaseJournalLock(lock, {
      testHooks: {
        beforeReleaseMove() {
          fs.unlinkSync(lock.lockPath);
          fs.writeFileSync(lock.lockPath, `${JSON.stringify(replacement)}\n`, "utf8");
        },
      },
    }), (error) => error.code === "EVENT_LOCK_OWNERSHIP_LOST" && error.details.replacement_restored === true);
    assert.equal(inspectJournalLock(f.journalPath).metadata.nonce, replacement.nonce);
    const transitionArtifacts = fs.readdirSync(f.root).filter((name) => name.includes(".transition-") || name.includes(".release-"));
    assert.deepEqual(transitionArtifacts, []);
  } finally {
    f.cleanup();
  }
});

test("blocks acquisition when a transition appears between precheck and wx ownership", () => {
  const f = fixture();
  try {
    const markerPath = `${f.journalPath}.lock.transition-race`;
    assert.throws(() => acquireJournalLock({
      journalPath: f.journalPath,
      hostId: "host-a",
      targetRevision: 0,
      timeoutMs: 20,
      testHooks: {
        afterTransitionPrecheck() {
          fs.writeFileSync(markerPath, "transition\n", "utf8");
        },
      },
    }), { code: "EVENT_STALE_LOCK" });
    assert.equal(fs.existsSync(`${f.journalPath}.lock`), true);
    assert.equal(fs.existsSync(markerPath), true);
    assert.throws(() => acquireJournalLock({ journalPath: f.journalPath, hostId: "host-b", targetRevision: 0, timeoutMs: 1 }), { code: "EVENT_STALE_LOCK" });
  } finally {
    f.cleanup();
  }
});

test("atomic replacement rereads exact target bytes after rename", () => {
  const f = fixture();
  const originalReadFileSync = fs.readFileSync;
  try {
    fs.readFileSync = function patchedReadFileSync(filePath, ...args) {
      if (path.resolve(filePath) === path.resolve(f.journalPath)) return Buffer.from("different bytes", "utf8");
      return originalReadFileSync.call(fs, filePath, ...args);
    };
    assert.throws(() => replaceFileAtomic(f.journalPath, "expected bytes\n"), { code: "EVENT_ATOMIC_VERIFY_FAILED" });
  } finally {
    fs.readFileSync = originalReadFileSync;
    f.cleanup();
  }
});

test("two real processes racing revision zero append exactly one batch", async () => {
  const f = fixture();
  try {
    const [first, second] = await Promise.all([
      runWorker(["commit", f.root, "race-a", "race-event-a"]),
      runWorker(["commit", f.root, "race-b", "race-event-b"]),
    ]);
    assert.equal([first, second].filter((result) => result.code === 0).length, 1, `${first.stderr}\n${second.stderr}`);
    assert.equal(readLines(f.journalPath).length, 1);
    const loser = [first, second].find((result) => result.code !== 0);
    assert.equal(JSON.parse(loser.stderr).code, "EVENT_REVISION_CONFLICT");
  } finally {
    f.cleanup();
  }
});

test("two barrier-synchronized processes prove lock contention before revision conflict", async () => {
  const f = fixture();
  try {
    const ready = ["barrier-a", "barrier-b"].map((id) => path.join(f.root, `.ready-${id}`));
    const [firstPromise, secondPromise] = [
      runWorker(["barrier", f.root, "barrier-a", "barrier-event-a"]),
      runWorker(["barrier", f.root, "barrier-b", "barrier-event-b"]),
    ];
    await waitForFiles(ready);
    fs.writeFileSync(path.join(f.root, ".start"), "go\n", "utf8");
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    assert.equal([first, second].filter((result) => result.code === 0).length, 1, `${first.stderr}\n${second.stderr}`);
    assert.equal(JSON.parse([first, second].find((result) => result.code !== 0).stderr).code, "EVENT_REVISION_CONFLICT");
    assert.equal(fs.existsSync(path.join(f.root, ".contention-observed")), true);
  } finally {
    f.cleanup();
  }
});

test("rejects a physically changed but canonically equivalent tail before projection", () => {
  const f = fixture();
  try {
    let projectionCalls = 0;
    const store = createEventStore({
      stateRoot: f.root,
      workspaceId: "workspace-a",
      project() { projectionCalls += 1; },
      testFailureInjector(point) {
        if (point !== "after_journal_rename") return;
        const line = fs.readFileSync(f.journalPath, "utf8").trimEnd();
        fs.writeFileSync(f.journalPath, ` ${line} \n`, "utf8");
      },
    });
    assert.throws(() => store.commit(batch()), { code: "EVENT_JOURNAL_VERIFY_FAILED" });
    assert.equal(projectionCalls, 0);
  } finally {
    f.cleanup();
  }
});

test("uses the persisted pending record as the success oracle", () => {
  const f = fixture();
  try {
    let projectionCalls = 0;
    const store = createEventStore({
      stateRoot: f.root,
      workspaceId: "workspace-a",
      project() { projectionCalls += 1; },
      testFailureInjector(point) {
        if (point !== "after_pending_fsync") return;
        const [pendingFile] = pendingFiles(f.root);
        const pendingPath = path.join(f.root, "pending", pendingFile);
        const pending = JSON.parse(fs.readFileSync(pendingPath, "utf8"));
        pending.sha256 = "0".repeat(64);
        fs.writeFileSync(pendingPath, `${JSON.stringify(pending)}\n`, "utf8");
      },
    });
    assert.throws(() => store.commit(batch()), { code: "EVENT_PENDING_VERIFY_FAILED" });
    assert.equal(projectionCalls, 0);
    assert.equal(pendingFiles(f.root).length, 1);
  } finally {
    f.cleanup();
  }
});

test("unresolved pending blocks idempotent and new writes after projection failure", () => {
  const f = fixture();
  try {
    const request = batch({ batch_id: "projection-failure", event_id: "projection-event" });
    const store = createEventStore({
      stateRoot: f.root,
      workspaceId: "workspace-a",
      project() {
        const error = new Error("projection failed");
        error.code = "EVENT_OPERATION_FAILED";
        throw error;
      },
    });
    assert.throws(() => store.commit(request), { code: "EVENT_OPERATION_FAILED" });
    assert.equal(pendingFiles(f.root).length, 1);
    assert.throws(() => store.commit(request), { code: "EVENT_PENDING_RECOVERY_REQUIRED" });
    assert.throws(() => store.commit(batch({ expected_revision: 1 })), { code: "EVENT_PENDING_RECOVERY_REQUIRED" });
    assert.equal(readLines(f.journalPath).length, 1);
  } finally {
    f.cleanup();
  }
});

test("unresolved pending blocks every write after exact-tail verification failure", () => {
  const f = fixture();
  try {
    const request = batch({ batch_id: "tail-failure", event_id: "tail-event" });
    const tamperingStore = createEventStore({
      stateRoot: f.root,
      workspaceId: "workspace-a",
      testFailureInjector(point) {
        if (point !== "after_journal_rename") return;
        const line = fs.readFileSync(f.journalPath, "utf8").trimEnd();
        fs.writeFileSync(f.journalPath, ` ${line} \n`, "utf8");
      },
    });
    assert.throws(() => tamperingStore.commit(request), { code: "EVENT_JOURNAL_VERIFY_FAILED" });
    const ordinaryStore = createEventStore({ stateRoot: f.root, workspaceId: "workspace-a" });
    assert.throws(() => ordinaryStore.commit(request), { code: "EVENT_PENDING_RECOVERY_REQUIRED" });
    assert.throws(() => ordinaryStore.commit(batch({ expected_revision: 1 })), { code: "EVENT_PENDING_RECOVERY_REQUIRED" });
    assert.equal(pendingFiles(f.root).length, 1);
    assert.equal(readLines(f.journalPath).length, 1);
  } finally {
    f.cleanup();
  }
});

test("product callbacks cannot forge controlled rollback with EVENT_TEST_ABORT", () => {
  const f = fixture();
  try {
    const store = createEventStore({
      stateRoot: f.root,
      workspaceId: "workspace-a",
      project() {
        const error = new Error("product failure");
        error.code = "EVENT_TEST_ABORT";
        throw error;
      },
    });
    assert.throws(() => store.commit(batch()), { code: "EVENT_TEST_ABORT" });
    assert.equal(readLines(f.journalPath).length, 1);
    assert.equal(pendingFiles(f.root).length, 1);
  } finally {
    f.cleanup();
  }
});

test("reused injector Error cannot authorize rollback from a later product callback", () => {
  const f = fixture();
  try {
    const sharedError = new Error("shared controlled error");
    sharedError.code = "EVENT_TEST_ABORT";
    const controlledStore = createEventStore({
      stateRoot: f.root,
      workspaceId: "workspace-a",
      testFailureInjector(point) {
        if (point === "after_pending_fsync") throw sharedError;
      },
    });
    let controlledCaught;
    try {
      controlledStore.commit(batch({ batch_id: "controlled-shared", event_id: "controlled-shared-event" }));
    } catch (error) {
      controlledCaught = error;
    }
    assert.strictEqual(controlledCaught, sharedError);
    assert.deepEqual(pendingFiles(f.root), []);
    assert.equal(fs.existsSync(f.journalPath), false);

    const productStore = createEventStore({
      stateRoot: f.root,
      workspaceId: "workspace-a",
      project() {
        throw sharedError;
      },
    });
    let productCaught;
    try {
      productStore.commit(batch({ batch_id: "product-shared", event_id: "product-shared-event" }));
    } catch (error) {
      productCaught = error;
    }
    assert.strictEqual(productCaught, sharedError);
    assert.equal(readLines(f.journalPath).length, 1);
    assert.equal(pendingFiles(f.root).length, 1);
    assert.throws(
      () => productStore.commit(batch({ expected_revision: 1, batch_id: "blocked-after-product-error", event_id: "blocked-after-product-error" })),
      { code: "EVENT_PENDING_RECOVERY_REQUIRED" },
    );
  } finally {
    f.cleanup();
  }
});

test("preserves the primary operation error when release also fails", () => {
  const f = fixture();
  try {
    const store = createEventStore({
      stateRoot: f.root,
      workspaceId: "workspace-a",
      project() {
        const error = new Error("operation failed");
        error.code = "EVENT_OPERATION_FAILED";
        throw error;
      },
      testLockHooks: {
        beforeDeleteReleaseArtifact() {
          const error = new Error("release denied");
          error.code = "EPERM";
          throw error;
        },
      },
    });
    assert.throws(() => store.commit(batch()), (error) => error.code === "EVENT_OPERATION_FAILED" && error.release_failure?.code === "EVENT_LOCK_RELEASE_FAILED");
    assert.equal(pendingFiles(f.root).length, 1);
  } finally {
    f.cleanup();
  }
});

test("each controlled abort point can be retried with exactly one committed event", () => {
  for (const crashPoint of CRASH_POINTS) {
    const f = fixture();
    try {
      const request = batch({ batch_id: `batch-${crashPoint}`, event_id: `event-${crashPoint}` });
      let fired = false;
      const store = createEventStore({
        stateRoot: f.root,
        workspaceId: "workspace-a",
        testFailureInjector(point) {
          if (!fired && point === crashPoint) {
            fired = true;
            const error = new Error(`controlled ${point}`);
            error.code = "EVENT_TEST_ABORT";
            throw error;
          }
        },
      });
      assert.throws(() => store.commit(request), { code: "EVENT_TEST_ABORT" });
      assert.deepEqual(store.commit(request), { status: "committed", sequence: 1 });
      const lines = readLines(f.journalPath);
      assert.equal(lines.length, 1);
      assert.equal(lines[0].events.length, 1);
      assert.equal(lines[0].events[0].event_id, request.events[0].event_id);
      assert.deepEqual(pendingFiles(f.root), []);
      assert.deepEqual(transientArtifacts(f.root), []);
    } finally {
      f.cleanup();
    }
  }
});

test("an exit-86 crash after pending fsync leaves a blocker rather than automatic recovery", async () => {
  const f = fixture();
  try {
    const crashed = await runWorker(["crash", f.root]);
    assert.equal(crashed.code, 86, crashed.stderr);
    assert.equal(fs.existsSync(`${f.journalPath}.lock`), true);
    const pendingFiles = fs.readdirSync(path.join(f.root, "pending"));
    assert.equal(pendingFiles.length, 1);
    const pending = JSON.parse(fs.readFileSync(path.join(f.root, "pending", pendingFiles[0]), "utf8"));
    assert.deepEqual(Object.keys(pending).sort(), [
      "batch_id", "created_at", "expected_revision", "journal_path", "next_sequence",
      "pending_version", "serialized_batch", "sha256", "workspace_id",
    ]);
    assert.match(pending.sha256, /^[a-f0-9]{64}$/);
    assert.equal(crypto.createHash("sha256").update(pending.serialized_batch, "utf8").digest("hex"), pending.sha256);
    assert.deepEqual(JSON.parse(pending.serialized_batch).batch_id, pending.batch_id);
    const store = createEventStore({ stateRoot: f.root, workspaceId: "workspace-a", lockTimeoutMs: 5 });
    assert.throws(() => store.commit(batch()), { code: "EVENT_STALE_LOCK" });
  } finally {
    f.cleanup();
  }
});
