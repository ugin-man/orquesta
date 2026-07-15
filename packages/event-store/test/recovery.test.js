"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createEventStore, CRASH_POINTS } = require("../src");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-recovery-"));
  return { root, journal: path.join(root, "events.jsonl"), cleanup() { cleanupTree(root); } };
}
function cleanupTree(directory) { if (!fs.existsSync(directory)) return; for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { const target = path.join(directory, entry.name); if (entry.isDirectory()) cleanupTree(target); else fs.unlinkSync(target); } fs.rmdirSync(directory); }
function request(id = "one") { return { expected_revision: 0, batch_id: `recovery-${id}`, actor: { type: "agent", id: "implementation-001" }, correlation_id: id, events: [{ event_id: `recovery-event-${id}`, schema_version: 1, type: "counter.add", payload: {}, evidence_refs: [] }] }; }
function pending(f, entry, workspaceId = "workspace") {
  const serialized = JSON.stringify(entry);
  const value = { pending_version: 1, workspace_id: workspaceId, journal_path: ".orquesta/v4/events.jsonl", batch_id: entry.batch_id, expected_revision: entry.expected_revision, next_sequence: entry.sequence, serialized_batch: serialized, sha256: crypto.createHash("sha256").update(serialized).digest("hex"), created_at: entry.committed_at };
  fs.mkdirSync(path.join(f.root, "pending"), { recursive: true });
  const target = path.join(f.root, "pending", `${crypto.createHash("sha256").update(entry.batch_id, "utf8").digest("hex")}.json`);
  fs.writeFileSync(target, `${JSON.stringify(value)}\n`, "utf8"); return target;
}
function pendingFile(f) { return path.join(f.root, "pending", fs.readdirSync(path.join(f.root, "pending")).sort()[0]); }
function partialNextLine(original, pendingPath, fullJson = false) {
  const serialized = JSON.parse(fs.readFileSync(pendingPath, "utf8")).serialized_batch;
  const length = fullJson ? serialized.length : Math.max(1, Math.floor(serialized.length / 2));
  return Buffer.concat([original, Buffer.from(serialized.slice(0, length), "utf8")]);
}
function recoveryInput(inspection) { return { recoveryId: inspection.recovery_id, action: inspection.action, operator: { type: "local_operator", id: "explicit-recovery-command" } }; }
function inspectReadOnly(store, root, expected) {
  const before = fs.readdirSync(root).sort();
  const inspection = store.inspectRecovery();
  assert.equal(inspection.action, expected);
  assert.deepEqual(fs.readdirSync(root).sort(), before);
  assert.ok(Number.isInteger(inspection.last_valid_sequence));
  assert.ok(Array.isArray(inspection.quarantine_paths));
  assert.ok(Object.hasOwn(inspection, "required_user_decision"));
  return inspection;
}
function writeLock(f, values = {}) {
  const metadata = {
    owner_pid: process.pid,
    host_id: "recovery-host",
    nonce: "a".repeat(32),
    acquired_at: "2026-07-15T00:00:00.000Z",
    target_revision: 0,
    ...values,
  };
  fs.writeFileSync(`${f.journal}.lock`, `${JSON.stringify(metadata)}\n`, "utf8");
}
function treeSnapshot(root) {
  const rows = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const target = path.join(directory, entry.name); const relative = path.relative(root, target);
      const stat = fs.lstatSync(target);
      if (entry.isDirectory()) { rows.push({ relative, type: "dir", mtime_ms: stat.mtimeMs }); walk(target); }
      else rows.push({ relative, type: stat.isSymbolicLink() ? "symlink" : "file", mtime_ms: stat.mtimeMs, bytes: crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex") });
    }
  }
  walk(root); return rows;
}

test("recovery lock eligibility never releases a live, remote, invalid, or transitioning owner", () => {
  const variants = [
    ["live", {}, "blocked_lock"],
    ["remote", { host_id: "other-host", owner_pid: 999999 }, "blocked_lock"],
    ["invalid", { nonce: "" }, "blocked_lock"],
    ["transition", {}, "blocked_lock"],
  ];
  for (const [name, values, expected] of variants) {
    const f = fixture();
    try {
      writeLock(f, values);
      if (name === "transition") fs.writeFileSync(`${f.journal}.lock.transition-test`, "{}\n");
      const store = createEventStore({ stateRoot: f.root, hostId: "recovery-host" });
      const inspection = inspectReadOnly(store, f.root, expected);
      assert.equal(inspection.required_user_decision, "manual_lock_repair", name);
      assert.throws(() => store.applyRecovery(recoveryInput(inspection)), { code: "RECOVERY_LOCK_NOT_ELIGIBLE" }, name);
      assert.equal(fs.existsSync(`${f.journal}.lock`), true, name);
    } finally { f.cleanup(); }
  }
});

test("recovery releases only a valid dead local lock with no transition evidence", () => {
  const f = fixture();
  try {
    writeLock(f, { owner_pid: 999999 });
    const store = createEventStore({ stateRoot: f.root, hostId: "recovery-host" });
    const inspection = inspectReadOnly(store, f.root, "stale_lock");
    const result = store.applyRecovery(recoveryInput(inspection));
    assert.equal(result.status, "lock_released"); assert.equal(fs.existsSync(`${f.journal}.lock`), false); assert.ok(result.summary);
  } finally { f.cleanup(); }
});

test("recovery lock eligibility requires the current revision, a lowercase nonce, and strict UTC milliseconds", () => {
  const variants = [
    ["revision", { owner_pid: 999999, target_revision: 99 }],
    ["nonce", { owner_pid: 999999, nonce: "not-hex" }],
    ["timestamp", { owner_pid: 999999, acquired_at: "2026-07-15T00:00:00Z" }],
    ["calendar", { owner_pid: 999999, acquired_at: "2026-99-99T00:00:00.000Z" }],
  ];
  for (const [name, values] of variants) {
    const f = fixture();
    try { writeLock(f, values); const store = createEventStore({ stateRoot: f.root, hostId: "recovery-host" }); assert.equal(inspectReadOnly(store, f.root, "blocked_lock").required_user_decision, "manual_lock_repair", name); } finally { f.cleanup(); }
  }
});

test("stale lock apply releases only the lock and requires a new explicit recovery action", () => {
  const f = fixture();
  try {
    const source = request("stale-follow-up"); pending(f, { journal_version: 1, sequence: 1, ...source, committed_at: "2026-07-15T00:00:00.000Z" }); writeLock(f, { owner_pid: 999999 });
    const store = createEventStore({ stateRoot: f.root, hostId: "recovery-host" }); const inspection = inspectReadOnly(store, f.root, "stale_lock");
    const result = store.applyRecovery(recoveryInput(inspection));
    assert.equal(result.status, "lock_released"); assert.equal(fs.existsSync(`${f.journal}.lock`), false); assert.equal(fs.existsSync(pendingFile(f)), true); assert.equal(store.inspectRecovery().action, "retry_pending_commit");
  } finally { f.cleanup(); }
});

test("stale lock recovery cannot release a replacement live owner", () => {
  const f = fixture();
  try {
    writeLock(f, { owner_pid: 999999 });
    let replacementBytes;
    const store = createEventStore({
      stateRoot: f.root,
      hostId: "recovery-host",
      testRecoveryHooks: {
        beforeReleaseMove({ lock }) {
          const replacement = {
            owner_pid: process.pid,
            host_id: "recovery-host",
            nonce: "b".repeat(32),
            acquired_at: "2026-07-15T00:00:01.000Z",
            target_revision: 0,
          };
          replacementBytes = Buffer.from(`${JSON.stringify(replacement)}\n`, "utf8");
          fs.writeFileSync(lock.lockPath, replacementBytes);
        },
      },
    });
    const inspection = inspectReadOnly(store, f.root, "stale_lock");
    assert.throws(() => store.applyRecovery(recoveryInput(inspection)), { code: "EVENT_LOCK_OWNERSHIP_LOST" });
    assert.deepEqual(fs.readFileSync(`${f.journal}.lock`), replacementBytes);
    assert.equal(fs.readdirSync(f.root).some((name) => name.includes(".release-") || name.includes(".transition-")), false);
    assert.equal(store.inspectRecovery().action, "blocked_lock");
  } finally { f.cleanup(); }
});

test("pending eligibility blocks multiple, malformed, and revision-mismatched evidence", () => {
  const arrangements = [
    ["multiple", (f, entry) => { pending(f, entry); fs.copyFileSync(pendingFile(f), path.join(f.root, "pending", "second.json")); }],
    ["hash", (f, entry) => { pending(f, entry); const target = pendingFile(f); const data = JSON.parse(fs.readFileSync(target, "utf8")); data.sha256 = "0".repeat(64); fs.writeFileSync(target, `${JSON.stringify(data)}\n`); }],
    ["revision", (f, entry) => { pending(f, { ...entry, expected_revision: 1 }); }],
  ];
  for (const [name, arrange] of arrangements) {
    const f = fixture();
    try {
      const entry = { journal_version: 1, sequence: 1, ...request(`pending-${name}`), committed_at: "2026-07-15T00:00:00.000Z" }; arrange(f, entry);
      const inspection = inspectReadOnly(createEventStore({ stateRoot: f.root }), f.root, "blocked_pending");
      assert.equal(inspection.required_user_decision, "manual_pending_repair", name);
    } finally { f.cleanup(); }
  }
});

test("pending eligibility requires the complete Task 3 wrapper for this workspace and journal", () => {
  const variants = [
    ["version", (value) => { value.pending_version = 2; }],
    ["workspace", (value) => { value.workspace_id = "other"; }],
    ["batch-id-type", (value) => { value.batch_id = 7; }],
    ["journal", (value) => { value.journal_path = ".orquesta/v4/other.jsonl"; }],
    ["created", (value) => { value.created_at = "2026-99-99T00:00:00.000Z"; }],
    ["created-mismatch", (value) => { value.created_at = "2026-07-15T00:00:00.001Z"; }],
    ["extra", (value) => { value.extra = true; }],
    ["missing", (value) => { delete value.workspace_id; }],
    ["entry-wrapper", (value) => { const entry = JSON.parse(value.serialized_batch); entry.journal_version = 2; value.serialized_batch = JSON.stringify(entry); value.sha256 = crypto.createHash("sha256").update(value.serialized_batch).digest("hex"); }],
    ["entry-contract", (value) => { const entry = JSON.parse(value.serialized_batch); entry.events[0].event_id = ""; value.serialized_batch = JSON.stringify(entry); value.sha256 = crypto.createHash("sha256").update(value.serialized_batch).digest("hex"); }],
    ["filename", (_value, target) => { fs.renameSync(target, path.join(path.dirname(target), "wrong.json")); }],
    ["invalid-utf8", (_value, target) => { fs.writeFileSync(target, Buffer.from([0xff, 0xfe])); return "written"; }],
    ["missing-newline", (value, target) => { fs.writeFileSync(target, JSON.stringify(value), "utf8"); return "written"; }],
    ["two-lines", (value, target) => { fs.writeFileSync(target, `${JSON.stringify(value)}\n{}\n`, "utf8"); return "written"; }],
  ];
  for (const [name, mutate] of variants) {
    const f = fixture();
    try {
      const source = request(`pending-wrapper-${name}`); const target = pending(f, { journal_version: 1, sequence: 1, ...source, committed_at: "2026-07-15T00:00:00.000Z" });
      const value = JSON.parse(fs.readFileSync(target, "utf8")); const output = mutate(value, target); if (output !== "written" && fs.existsSync(target)) fs.writeFileSync(target, `${JSON.stringify(value)}\n`);
      assert.equal(inspectReadOnly(createEventStore({ stateRoot: f.root }), f.root, "blocked_pending").required_user_decision, "manual_pending_repair", name);
    } finally { f.cleanup(); }
  }
});

test("retry pending keeps the exact verified pending evidence when projection retry fails", () => {
  const f = fixture();
  try {
    const source = request("retry-failure"); const entry = { journal_version: 1, sequence: 1, ...source, committed_at: "2026-07-15T00:00:00.000Z" }; pending(f, entry);
    const pendingPath = pendingFile(f); const before = fs.readFileSync(pendingPath);
    const store = createEventStore({ stateRoot: f.root, reducers: { "counter.add"() { throw Object.assign(new Error("retry projection failed"), { code: "EVENT_RETRY_PROJECTION_FAILED" }); } } });
    const inspection = inspectReadOnly(store, f.root, "retry_pending_commit");
    assert.throws(() => store.applyRecovery(recoveryInput(inspection)), { code: "EVENT_RETRY_PROJECTION_FAILED" });
    assert.deepEqual(fs.readFileSync(pendingPath), before);
  } finally { f.cleanup(); }
});

test("recovery retries revalidate a pending wrapper after acquiring the journal lock", () => {
  const modes = [
    ["retry", false],
    ["finalize", true],
  ];
  for (const [name, journaled] of modes) {
    const f = fixture();
    try {
      const source = request(`lock-time-${name}`);
      const entry = { journal_version: 1, sequence: 1, ...source, committed_at: "2026-07-15T00:00:00.000Z" };
      const pendingPath = pending(f, entry);
      if (journaled) fs.writeFileSync(f.journal, `${JSON.stringify(entry)}\n`, "utf8");
      let tamperedBytes;
      const store = createEventStore({
        stateRoot: f.root,
        testLockHooks: {
          afterAcquire() {
            const wrapper = JSON.parse(fs.readFileSync(pendingPath, "utf8"));
            wrapper.workspace_id = "other-workspace";
            tamperedBytes = Buffer.from(`${JSON.stringify(wrapper)}\n`, "utf8");
            fs.writeFileSync(pendingPath, tamperedBytes);
          },
        },
      });
      const inspection = inspectReadOnly(store, f.root, journaled ? "finalize_pending_commit" : "retry_pending_commit");
      assert.throws(() => store.applyRecovery(recoveryInput(inspection)), { code: "EVENT_PENDING_VERIFY_FAILED" }, name);
      assert.deepEqual(fs.readFileSync(pendingPath), tamperedBytes, name);
      assert.equal(fs.existsSync(path.join(f.root, "projections", "state.json")), false, name);
      assert.equal(fs.existsSync(f.journal), journaled, name);
      if (journaled) assert.equal(fs.readFileSync(f.journal, "utf8"), `${JSON.stringify(entry)}\n`, name);
    } finally { f.cleanup(); }
  }
});

test("backup restore requires a valid matching backup and preserves all evidence when quarantine move fails", () => {
  const f = fixture();
  try {
    const baseStore = createEventStore({ stateRoot: f.root }); baseStore.commit(request("backup-eligibility"));
    const original = fs.readFileSync(f.journal); fs.writeFileSync(`${f.journal}.bak`, "not a journal\n");
    const source = { ...request("backup-pending-eligibility"), expected_revision: 1 }; pending(f, { journal_version: 1, sequence: 2, ...source, committed_at: "2026-07-15T00:00:01.000Z" }); fs.writeFileSync(f.journal, partialNextLine(original, pendingFile(f)));
    assert.equal(baseStore.inspectRecovery().action, "blocked_corruption");
    fs.writeFileSync(`${f.journal}.bak`, original);
    const store = createEventStore({ stateRoot: f.root, testRecoveryHooks: { beforeQuarantineMove() { throw Object.assign(new Error("move denied"), { code: "EPERM" }); } } });
    const inspection = inspectReadOnly(store, f.root, "restore_backup_retry");
    assert.throws(() => store.applyRecovery(recoveryInput(inspection)), { code: "RECOVERY_QUARANTINE_MOVE_FAILED" });
    assert.equal(fs.existsSync(f.journal), true); assert.equal(fs.existsSync(`${f.journal}.bak`), true); assert.equal(fs.existsSync(pendingFile(f)), true); assert.equal(fs.existsSync(inspection.quarantine_paths[0]), true);
  } finally { f.cleanup(); }
});

test("corruption diagnostics retain the last valid sequence and exact failing line", () => {
  const f = fixture();
  try {
    const store = createEventStore({ stateRoot: f.root }); store.commit(request("diagnostic-first"));
    const valid = fs.readFileSync(f.journal, "utf8").trim(); fs.writeFileSync(f.journal, `${valid}\n{broken}\n`);
    const inspection = inspectReadOnly(store, f.root, "blocked_corruption");
    assert.equal(inspection.last_valid_sequence, 1); assert.equal(inspection.diagnostics.corruption_line, 2); assert.equal(inspection.required_user_decision, "manual_recovery"); assert.equal(inspection.quarantine_paths.length, 1);
  } finally { f.cleanup(); }
});

test("corruption diagnostics stop before a contract-invalid or duplicate-id journal line", () => {
  for (const mode of ["invalid", "duplicate-event", "duplicate-batch"]) {
    const f = fixture();
    try {
      const store = createEventStore({ stateRoot: f.root }); store.commit(request(`strict-prefix-a-${mode}`)); store.commit({ ...request(`strict-prefix-b-${mode}`), expected_revision: 1 });
      const lines = fs.readFileSync(f.journal, "utf8").trim().split("\n"); const first = JSON.parse(lines[0]); const invalid = JSON.parse(lines[1]);
      if (mode === "invalid") invalid.events[0].event_id = "";
      if (mode === "duplicate-event") invalid.events[0].event_id = first.events[0].event_id;
      if (mode === "duplicate-batch") invalid.batch_id = first.batch_id;
      lines[1] = JSON.stringify(invalid); fs.writeFileSync(f.journal, `${lines.join("\n")}\n`);
      const inspection = inspectReadOnly(store, f.root, "blocked_corruption"); assert.equal(inspection.last_valid_sequence, 1, mode); assert.equal(inspection.diagnostics.corruption_line, 2, mode);
    } finally { f.cleanup(); }
  }
});

test("backup restore rejects a valid but unrelated backup lineage", () => {
  const f = fixture();
  try {
    const store = createEventStore({ stateRoot: f.root }); store.commit(request("lineage-current")); const unrelated = fixture(); const other = createEventStore({ stateRoot: unrelated.root }); other.commit(request("lineage-other")); fs.copyFileSync(unrelated.journal, `${f.journal}.bak`); const source = { ...request("lineage-pending"), expected_revision: 1 }; pending(f, { journal_version: 1, sequence: 2, ...source, committed_at: "2026-07-15T00:00:01.000Z" }); fs.writeFileSync(f.journal, fs.readFileSync(f.journal).subarray(0, 20));
    assert.equal(inspectReadOnly(store, f.root, "blocked_corruption").required_user_decision, "manual_recovery"); unrelated.cleanup();
  } finally { f.cleanup(); }
});

test("backup restore resumes safely after a stop between quarantine move and atomic backup replacement", () => {
  const f = fixture();
  try {
    const base = createEventStore({ stateRoot: f.root }); base.commit(request("resume-base")); const original = fs.readFileSync(f.journal); fs.writeFileSync(`${f.journal}.bak`, original); const source = { ...request("resume-pending"), expected_revision: 1 }; pending(f, { journal_version: 1, sequence: 2, ...source, committed_at: "2026-07-15T00:00:01.000Z" }); fs.writeFileSync(f.journal, partialNextLine(original, pendingFile(f), true));
    const stopping = createEventStore({ stateRoot: f.root, testRecoveryHooks: { afterQuarantineMove() { throw Object.assign(new Error("stop after move"), { code: "EVENT_TEST_STOP_AFTER_MOVE" }); } } }); const first = inspectReadOnly(stopping, f.root, "restore_backup_retry"); assert.throws(() => stopping.applyRecovery(recoveryInput(first)), { code: "EVENT_TEST_STOP_AFTER_MOVE" }); assert.equal(fs.existsSync(f.journal), false);
    const resumed = createEventStore({ stateRoot: f.root }); const second = inspectReadOnly(resumed, f.root, "restore_backup_retry"); assert.equal(resumed.applyRecovery(recoveryInput(second)).status, "committed"); assert.equal(resumed.commit(source).status, "idempotent");
  } finally { f.cleanup(); }
});

test("resume requires exactly one quarantine artifact that matches backup and pending lineage", () => {
  const f = fixture();
  try {
    const base = createEventStore({ stateRoot: f.root }); base.commit(request("resume-lineage-base")); const original = fs.readFileSync(f.journal); fs.writeFileSync(`${f.journal}.bak`, original);
    const source = { ...request("resume-lineage-pending"), expected_revision: 1 }; pending(f, { journal_version: 1, sequence: 2, ...source, committed_at: "2026-07-15T00:00:01.000Z" }); fs.writeFileSync(f.journal, partialNextLine(original, pendingFile(f)));
    const stopping = createEventStore({ stateRoot: f.root, testRecoveryHooks: { afterQuarantineMove() { throw Object.assign(new Error("stop"), { code: "EVENT_TEST_STOP_AFTER_MOVE" }); } } }); const first = stopping.inspectRecovery(); assert.throws(() => stopping.applyRecovery(recoveryInput(first)), { code: "EVENT_TEST_STOP_AFTER_MOVE" });
    const quarantine = path.join(f.root, "quarantine"); fs.copyFileSync(fs.readdirSync(quarantine).map((name) => path.join(quarantine, name))[0], path.join(quarantine, `events-${"b".repeat(64)}.jsonl`));
    assert.equal(createEventStore({ stateRoot: f.root }).inspectRecovery().action, "blocked_corruption");
  } finally { f.cleanup(); }
});

test("projection hand edit with a valid watermark is detected against replayed canonical data", () => {
  const f = fixture();
  try {
    const store = createEventStore({ stateRoot: f.root, reducers: { "counter.add"(state) { return { ...state, count: (state.count || 0) + 1 }; } }, initialState: { count: 0 } }); store.commit(request("projection-hand-edit"));
    const target = path.join(f.root, "projections", "state.json"); const data = JSON.parse(fs.readFileSync(target, "utf8")); fs.writeFileSync(target, `${JSON.stringify({ ...data, data: { count: 999 } })}\n`);
    assert.equal(inspectReadOnly(store, f.root, "rebuild_projection").last_valid_sequence, 1);
  } finally { f.cleanup(); }
});

test("projection inspection validates the complete wrapper at revision zero and after journal commits", () => {
  const empty = fixture();
  try {
    const store = createEventStore({ stateRoot: empty.root });
    const missing = inspectReadOnly(store, empty.root, "rebuild_projection"); assert.equal(store.applyRecovery(recoveryInput(missing)).status, "projection_rebuilt");
    const target = path.join(empty.root, "projections", "state.json"); const rebuilt = JSON.parse(fs.readFileSync(target, "utf8")); assert.deepEqual(rebuilt, { projection_version: 1, journal_sequence: 0, last_batch_id: null, journal_hash: crypto.createHash("sha256").update("", "utf8").digest("hex"), data: {} });
    for (const mutate of [(value) => { value.journal_sequence = 1; }, (value) => { value.data = { tampered: true }; }]) { const changed = { ...rebuilt, data: { ...rebuilt.data } }; mutate(changed); fs.writeFileSync(target, `${JSON.stringify(changed)}\n`); assert.equal(inspectReadOnly(store, empty.root, "rebuild_projection").last_valid_sequence, 0); }
  } finally { empty.cleanup(); }
  for (const [name, mutate] of [["version", (value) => { value.projection_version = 2; }], ["last-batch", (value) => { value.last_batch_id = "wrong-batch"; }]]) {
    const f = fixture();
    try { const store = createEventStore({ stateRoot: f.root }); store.commit(request(`projection-wrapper-${name}`)); const target = path.join(f.root, "projections", "state.json"); const value = JSON.parse(fs.readFileSync(target, "utf8")); mutate(value); fs.writeFileSync(target, `${JSON.stringify(value)}\n`); assert.equal(inspectReadOnly(store, f.root, "rebuild_projection").last_valid_sequence, 1); } finally { f.cleanup(); }
  }
});

test("inspect is byte and mtime read-only across every recovery artifact", () => {
  const f = fixture();
  try {
    const store = createEventStore({ stateRoot: f.root }); store.commit(request("full-snapshot"));
    fs.copyFileSync(f.journal, `${f.journal}.bak`); pending(f, JSON.parse(fs.readFileSync(f.journal, "utf8").trim())); writeLock(f, { owner_pid: 999999 }); fs.mkdirSync(path.join(f.root, "quarantine"), { recursive: true }); fs.writeFileSync(path.join(f.root, "quarantine", "evidence.txt"), "evidence\n"); fs.writeFileSync(path.join(f.root, "events (conflicted copy).jsonl"), "copy\n");
    const before = treeSnapshot(f.root); store.inspectRecovery(); assert.deepEqual(treeSnapshot(f.root), before);
  } finally { f.cleanup(); }
});

test("apply rejects a non-recommended action before mutating recovery evidence and returns summaries", () => {
  const f = fixture();
  try {
    const source = request("action-mismatch"); pending(f, { journal_version: 1, sequence: 1, ...source, committed_at: "2026-07-15T00:00:00.000Z" }); const target = pendingFile(f); const before = fs.readFileSync(target);
    const store = createEventStore({ stateRoot: f.root }); const inspection = inspectReadOnly(store, f.root, "retry_pending_commit");
    assert.throws(() => store.applyRecovery({ ...recoveryInput(inspection), action: "finalize_pending_commit" }), { code: "RECOVERY_ACTION_MISMATCH" }); assert.deepEqual(fs.readFileSync(target), before);
    const result = store.applyRecovery(recoveryInput(inspection)); assert.ok(result.summary); assert.equal(result.summary.journal.sequence, 1);
  } finally { f.cleanup(); }
});

test("recovery case 01: unique unjournaled pending is inspect-only then explicitly retried", () => {
  const f = fixture();
  try {
    const source = request("case-01"); const store = createEventStore({ stateRoot: f.root, workspaceId: "recovery" });
    pending(f, { journal_version: 1, sequence: 1, ...source, committed_at: "2026-07-15T00:00:00.000Z" }, "recovery");
    const inspection = inspectReadOnly(store, f.root, "retry_pending_commit");
    assert.equal(inspection.last_valid_sequence, 0); assert.equal(inspection.required_user_decision, "explicit_recovery");
    assert.equal(store.applyRecovery(recoveryInput(inspection)).status, "committed");
    assert.equal(store.commit(source).status, "idempotent");
  } finally { f.cleanup(); }
});

test("recovery case 02: journaled matching pending finalizes without a second batch", () => {
  const f = fixture();
  try {
    const source = request("case-02"); const store = createEventStore({ stateRoot: f.root, workspaceId: "recovery" }); store.commit(source);
    pending(f, JSON.parse(fs.readFileSync(f.journal, "utf8").trim()), "recovery");
    const inspection = inspectReadOnly(store, f.root, "finalize_pending_commit");
    assert.equal(inspection.last_valid_sequence, 1); assert.equal(inspection.required_user_decision, "explicit_recovery");
    assert.equal(store.applyRecovery(recoveryInput(inspection)).status, "pending_committed_rebuilt");
    assert.equal(store.replay().watermark.journal_sequence, 1);
  } finally { f.cleanup(); }
});

test("recovery case 03: pending with the same batch id but a different journal hash is blocked without choosing a revision", () => {
  const f = fixture();
  try {
    const source = request("case-03"); const store = createEventStore({ stateRoot: f.root, workspaceId: "recovery" }); store.commit(source);
    pending(f, JSON.parse(fs.readFileSync(f.journal, "utf8").trim()), "recovery");
    const pendingPath = pendingFile(f); const changed = JSON.parse(fs.readFileSync(pendingPath, "utf8")); changed.sha256 = "0".repeat(64); fs.writeFileSync(pendingPath, `${JSON.stringify(changed)}\n`);
    const inspection = inspectReadOnly(store, f.root, "quarantine_conflict");
    assert.equal(inspection.last_valid_sequence, 1); assert.equal(inspection.required_user_decision, "user_decision");
    assert.equal(inspection.quarantine_paths.length, 2); assert.equal(Object.hasOwn(inspection, "selected_revision"), false);
    assert.equal(fs.existsSync(f.journal), true); assert.equal(fs.existsSync(pendingPath), true);
  } finally { f.cleanup(); }
});

test("same-batch hash conflict explicitly quarantines both verified artifacts before user review", () => {
  const f = fixture();
  try {
    const source = request("quarantine-conflict");
    const store = createEventStore({ stateRoot: f.root, workspaceId: "recovery" });
    store.commit(source);
    const entry = JSON.parse(fs.readFileSync(f.journal, "utf8").trim());
    const pendingPath = pending(f, entry, "recovery");
    const wrapper = JSON.parse(fs.readFileSync(pendingPath, "utf8")); wrapper.sha256 = "0".repeat(64);
    fs.writeFileSync(pendingPath, `${JSON.stringify(wrapper)}\n`, "utf8");
    const journalBytes = fs.readFileSync(f.journal); const pendingBytes = fs.readFileSync(pendingPath);
    const inspection = inspectReadOnly(store, f.root, "quarantine_conflict");
    const applied = store.applyRecovery(recoveryInput(inspection));
    assert.equal(applied.status, "conflict_quarantined");
    assert.equal(fs.existsSync(f.journal), false); assert.equal(fs.existsSync(pendingPath), false);
    const quarantine = path.join(f.root, "quarantine"); const artifacts = fs.readdirSync(quarantine).sort();
    const journalArtifact = artifacts.find((name) => name.startsWith("events-"));
    const pendingArtifact = artifacts.find((name) => name.startsWith("pending-"));
    const manifestArtifact = artifacts.find((name) => name.startsWith("conflict-"));
    assert.deepEqual(fs.readFileSync(path.join(quarantine, journalArtifact)), journalBytes);
    assert.deepEqual(fs.readFileSync(path.join(quarantine, pendingArtifact)), pendingBytes);
    const manifest = JSON.parse(fs.readFileSync(path.join(quarantine, manifestArtifact), "utf8"));
    assert.equal(manifest.required_user_decision, "user_decision"); assert.equal(manifest.status, "user_decision"); assert.equal(Object.hasOwn(manifest, "selected_revision"), false); assert.equal(Object.keys(manifest).some((key) => key.includes("bytes_base64")), false);
    const blocked = store.inspectRecovery(); assert.equal(blocked.action, "blocked_conflict"); assert.equal(blocked.required_user_decision, "user_decision");
  } finally { f.cleanup(); }
});

test("conflict quarantine resumes after journal transition and rejects a replacement pending", () => {
  const f = fixture();
  try {
    const source = request("quarantine-resume"); const entry = { journal_version: 1, sequence: 1, ...source, committed_at: "2026-07-15T00:00:00.000Z" };
    fs.writeFileSync(f.journal, `${JSON.stringify(entry)}\n`, "utf8"); const pendingPath = pending(f, entry); const wrapper = JSON.parse(fs.readFileSync(pendingPath, "utf8")); wrapper.sha256 = "0".repeat(64); fs.writeFileSync(pendingPath, `${JSON.stringify(wrapper)}\n`);
    const stopping = createEventStore({ stateRoot: f.root, testRecoveryHooks: { afterConflictJournalTransition() { throw Object.assign(new Error("stop"), { code: "EVENT_TEST_STOP_CONFLICT_JOURNAL" }); } } });
    const first = inspectReadOnly(stopping, f.root, "quarantine_conflict");
    assert.throws(() => stopping.applyRecovery(recoveryInput(first)), { code: "EVENT_TEST_STOP_CONFLICT_JOURNAL" });
    const resumed = createEventStore({ stateRoot: f.root }); const second = inspectReadOnly(resumed, f.root, "quarantine_conflict");
    assert.equal(resumed.applyRecovery(recoveryInput(second)).status, "conflict_quarantined");
    const replacement = Buffer.from("replacement pending\n", "utf8");
    fs.writeFileSync(pendingPath, replacement);
    assert.equal(resumed.inspectRecovery().action, "blocked_conflict");
    assert.deepEqual(fs.readFileSync(pendingPath), replacement);
  } finally { f.cleanup(); }
});

test("conflict quarantine resumes after the pending transition and keeps a post-inspection replacement", () => {
  const f = fixture();
  try {
    const source = request("quarantine-pending-stop"); const entry = { journal_version: 1, sequence: 1, ...source, committed_at: "2026-07-15T00:00:00.000Z" };
    fs.writeFileSync(f.journal, `${JSON.stringify(entry)}\n`, "utf8"); const pendingPath = pending(f, entry); const wrapper = JSON.parse(fs.readFileSync(pendingPath, "utf8")); wrapper.sha256 = "0".repeat(64); fs.writeFileSync(pendingPath, `${JSON.stringify(wrapper)}\n`);
    const stopping = createEventStore({ stateRoot: f.root, testRecoveryHooks: { afterConflictPendingTransition() { throw Object.assign(new Error("stop"), { code: "EVENT_TEST_STOP_CONFLICT_PENDING" }); } } });
    const first = inspectReadOnly(stopping, f.root, "quarantine_conflict");
    assert.throws(() => stopping.applyRecovery(recoveryInput(first)), { code: "EVENT_TEST_STOP_CONFLICT_PENDING" });
    const replacement = Buffer.from("replacement after inspection\n", "utf8");
    const guarded = createEventStore({ stateRoot: f.root, testRecoveryHooks: { beforeConflictPendingMove() { fs.writeFileSync(pendingPath, replacement); } } });
    const second = inspectReadOnly(guarded, f.root, "quarantine_conflict");
    assert.throws(() => guarded.applyRecovery(recoveryInput(second)), { code: "RECOVERY_CONFLICT_VERIFY_FAILED" });
    assert.deepEqual(fs.readFileSync(pendingPath), replacement);
  } finally { f.cleanup(); }
});

test("conflict quarantine resumes after the pending transition without selecting a revision", () => {
  const f = fixture();
  try {
    const source = request("quarantine-pending-resume"); const entry = { journal_version: 1, sequence: 1, ...source, committed_at: "2026-07-15T00:00:00.000Z" };
    fs.writeFileSync(f.journal, `${JSON.stringify(entry)}\n`, "utf8"); const pendingPath = pending(f, entry); const wrapper = JSON.parse(fs.readFileSync(pendingPath, "utf8")); wrapper.sha256 = "0".repeat(64); fs.writeFileSync(pendingPath, `${JSON.stringify(wrapper)}\n`);
    const stopping = createEventStore({ stateRoot: f.root, testRecoveryHooks: { afterConflictPendingTransition() { throw Object.assign(new Error("stop"), { code: "EVENT_TEST_STOP_CONFLICT_PENDING" }); } } });
    const first = inspectReadOnly(stopping, f.root, "quarantine_conflict"); assert.throws(() => stopping.applyRecovery(recoveryInput(first)), { code: "EVENT_TEST_STOP_CONFLICT_PENDING" });
    const resumed = createEventStore({ stateRoot: f.root }); const second = inspectReadOnly(resumed, f.root, "quarantine_conflict");
    assert.equal(resumed.applyRecovery(recoveryInput(second)).status, "conflict_quarantined");
    const blocked = resumed.inspectRecovery(); assert.equal(blocked.action, "blocked_conflict"); assert.equal(Object.hasOwn(blocked, "selected_revision"), false);
  } finally { f.cleanup(); }
});

test("completed conflict quarantine preserves later canonical replacements as user-decision evidence", () => {
  const f = fixture();
  try {
    const source = request("quarantine-complete-replacement"); const entry = { journal_version: 1, sequence: 1, ...source, committed_at: "2026-07-15T00:00:00.000Z" };
    fs.writeFileSync(f.journal, `${JSON.stringify(entry)}\n`, "utf8"); const pendingPath = pending(f, entry); const wrapper = JSON.parse(fs.readFileSync(pendingPath, "utf8")); wrapper.sha256 = "0".repeat(64); fs.writeFileSync(pendingPath, `${JSON.stringify(wrapper)}\n`);
    const store = createEventStore({ stateRoot: f.root }); const inspection = inspectReadOnly(store, f.root, "quarantine_conflict"); assert.equal(store.applyRecovery(recoveryInput(inspection)).status, "conflict_quarantined");
    const replacement = Buffer.from("replacement after completed conflict\n", "utf8"); fs.writeFileSync(pendingPath, replacement);
    const blocked = inspectReadOnly(store, f.root, "blocked_conflict");
    assert.throws(() => store.applyRecovery(recoveryInput(blocked)), { code: "RECOVERY_ACTION_BLOCKED" });
    assert.deepEqual(fs.readFileSync(pendingPath), replacement);
  } finally { f.cleanup(); }
});

test("a status-only conflict completion never accepts remaining original artifacts", () => {
  const f = fixture();
  try {
    const source = request("quarantine-status-tamper"); const entry = { journal_version: 1, sequence: 1, ...source, committed_at: "2026-07-15T00:00:00.000Z" };
    fs.writeFileSync(f.journal, `${JSON.stringify(entry)}\n`, "utf8"); const pendingPath = pending(f, entry); const wrapper = JSON.parse(fs.readFileSync(pendingPath, "utf8")); wrapper.sha256 = "0".repeat(64); fs.writeFileSync(pendingPath, `${JSON.stringify(wrapper)}\n`);
    const stopping = createEventStore({ stateRoot: f.root, testRecoveryHooks: { afterConflictJournalTransition() { throw Object.assign(new Error("stop"), { code: "EVENT_TEST_STOP_CONFLICT_JOURNAL" }); } } });
    const first = inspectReadOnly(stopping, f.root, "quarantine_conflict"); assert.throws(() => stopping.applyRecovery(recoveryInput(first)), { code: "EVENT_TEST_STOP_CONFLICT_JOURNAL" });
    const manifestPath = path.join(f.root, "quarantine", fs.readdirSync(path.join(f.root, "quarantine")).find((name) => name.startsWith("conflict-")));
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); manifest.status = "user_decision"; fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    const blocked = inspectReadOnly(createEventStore({ stateRoot: f.root }), f.root, "blocked_conflict");
    assert.equal(blocked.diagnostics.conflict_reason, "completed_artifacts_present");
    assert.equal(fs.existsSync(pendingPath), true); assert.equal(fs.readdirSync(f.root).some((name) => name.includes(".conflict-")), true);
  } finally { f.cleanup(); }
});

test("a completed conflict never hides an exact transition behind a replacement", () => {
  const f = fixture();
  try {
    const source = request("quarantine-transition-replacement"); const entry = { journal_version: 1, sequence: 1, ...source, committed_at: "2026-07-15T00:00:00.000Z" };
    fs.writeFileSync(f.journal, `${JSON.stringify(entry)}\n`, "utf8"); const pendingPath = pending(f, entry); const wrapper = JSON.parse(fs.readFileSync(pendingPath, "utf8")); wrapper.sha256 = "0".repeat(64); fs.writeFileSync(pendingPath, `${JSON.stringify(wrapper)}\n`);
    const stopping = createEventStore({ stateRoot: f.root, testRecoveryHooks: { afterConflictPendingTransition() { throw Object.assign(new Error("stop"), { code: "EVENT_TEST_STOP_CONFLICT_PENDING" }); } } });
    const first = inspectReadOnly(stopping, f.root, "quarantine_conflict"); assert.throws(() => stopping.applyRecovery(recoveryInput(first)), { code: "EVENT_TEST_STOP_CONFLICT_PENDING" });
    const quarantine = path.join(f.root, "quarantine"); const manifestPath = path.join(quarantine, fs.readdirSync(quarantine).find((name) => name.startsWith("conflict-")));
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); manifest.status = "user_decision"; fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    const transition = path.join(f.root, "pending", `${path.basename(pendingPath)}.conflict-${manifest.id}`); const transitionBytes = fs.readFileSync(transition); const replacement = Buffer.from("replacement pending after transition\n", "utf8"); fs.writeFileSync(pendingPath, replacement);
    const blocked = inspectReadOnly(createEventStore({ stateRoot: f.root }), f.root, "blocked_conflict");
    assert.equal(blocked.diagnostics.conflict_reason, "completed_artifacts_present"); assert.deepEqual(fs.readFileSync(transition), transitionBytes); assert.deepEqual(fs.readFileSync(pendingPath), replacement);
  } finally { f.cleanup(); }
});

test("conflict completion resumes from ready evidence after an atomic manifest update failure", () => {
  const f = fixture();
  try {
    const source = request("quarantine-completion-resume"); const entry = { journal_version: 1, sequence: 1, ...source, committed_at: "2026-07-15T00:00:00.000Z" };
    fs.writeFileSync(f.journal, `${JSON.stringify(entry)}\n`, "utf8"); const pendingPath = pending(f, entry); const wrapper = JSON.parse(fs.readFileSync(pendingPath, "utf8")); wrapper.sha256 = "0".repeat(64); fs.writeFileSync(pendingPath, `${JSON.stringify(wrapper)}\n`);
    const stopping = createEventStore({ stateRoot: f.root, testRecoveryHooks: { beforeConflictManifestComplete() { throw Object.assign(new Error("manifest update failed"), { code: "EVENT_TEST_CONFLICT_MANIFEST_COMPLETE" }); } } });
    const first = inspectReadOnly(stopping, f.root, "quarantine_conflict"); assert.throws(() => stopping.applyRecovery(recoveryInput(first)), { code: "EVENT_TEST_CONFLICT_MANIFEST_COMPLETE" });
    assert.equal(fs.existsSync(f.journal), false); assert.equal(fs.existsSync(pendingPath), false);
    const resumed = createEventStore({ stateRoot: f.root }); const second = inspectReadOnly(resumed, f.root, "quarantine_conflict");
    assert.equal(resumed.applyRecovery(recoveryInput(second)).status, "conflict_quarantined"); assert.equal(inspectReadOnly(resumed, f.root, "blocked_conflict").required_user_decision, "user_decision");
  } finally { f.cleanup(); }
});

test("a OneDrive conflict copy blocks an incomplete manifest without touching any conflict evidence", () => {
  const f = fixture();
  try {
    const source = request("quarantine-onedrive-copy"); const entry = { journal_version: 1, sequence: 1, ...source, committed_at: "2026-07-15T00:00:00.000Z" };
    fs.writeFileSync(f.journal, `${JSON.stringify(entry)}\n`, "utf8"); const pendingPath = pending(f, entry); const wrapper = JSON.parse(fs.readFileSync(pendingPath, "utf8")); wrapper.sha256 = "0".repeat(64); fs.writeFileSync(pendingPath, `${JSON.stringify(wrapper)}\n`);
    const stopping = createEventStore({ stateRoot: f.root, testRecoveryHooks: { afterConflictJournalTransition() { throw Object.assign(new Error("stop"), { code: "EVENT_TEST_STOP_CONFLICT_JOURNAL" }); } } });
    const first = inspectReadOnly(stopping, f.root, "quarantine_conflict"); assert.throws(() => stopping.applyRecovery(recoveryInput(first)), { code: "EVENT_TEST_STOP_CONFLICT_JOURNAL" });
    const copyPath = path.join(f.root, "events (conflicted copy).jsonl"); fs.writeFileSync(copyPath, "onedrive alternate\n", "utf8"); const before = treeSnapshot(f.root);
    const blockedStore = createEventStore({ stateRoot: f.root }); const blocked = inspectReadOnly(blockedStore, f.root, "blocked_conflict");
    assert.equal(blocked.required_user_decision, "user_decision"); assert.equal(blocked.conflicts.length, 1); assert.throws(() => blockedStore.applyRecovery(recoveryInput(blocked)), { code: "RECOVERY_ACTION_BLOCKED" }); assert.deepEqual(treeSnapshot(f.root), before);
  } finally { f.cleanup(); }
});

test("conflict quarantine rejects journal replacement after inspection without moving it", () => {
  const f = fixture();
  try {
    const source = request("quarantine-journal-replacement"); const entry = { journal_version: 1, sequence: 1, ...source, committed_at: "2026-07-15T00:00:00.000Z" };
    fs.writeFileSync(f.journal, `${JSON.stringify(entry)}\n`, "utf8"); const pendingPath = pending(f, entry); const wrapper = JSON.parse(fs.readFileSync(pendingPath, "utf8")); wrapper.sha256 = "0".repeat(64); fs.writeFileSync(pendingPath, `${JSON.stringify(wrapper)}\n`);
    const replacement = Buffer.from("replacement journal\n", "utf8");
    const store = createEventStore({ stateRoot: f.root, testRecoveryHooks: { beforeConflictJournalMove() { fs.writeFileSync(f.journal, replacement); } } });
    const inspection = inspectReadOnly(store, f.root, "quarantine_conflict");
    assert.throws(() => store.applyRecovery(recoveryInput(inspection)), { code: "RECOVERY_CONFLICT_VERIFY_FAILED" });
    assert.deepEqual(fs.readFileSync(f.journal), replacement); assert.equal(fs.existsSync(pendingPath), true);
  } finally { f.cleanup(); }
});

test("tampered conflict manifest never reaches an outside path", () => {
  const f = fixture(); const outside = path.join(os.tmpdir(), `orquesta-conflict-outside-${process.pid}.txt`);
  try {
    fs.writeFileSync(outside, "outside evidence\n");
    const source = request("quarantine-tampered-manifest"); const entry = { journal_version: 1, sequence: 1, ...source, committed_at: "2026-07-15T00:00:00.000Z" };
    fs.writeFileSync(f.journal, `${JSON.stringify(entry)}\n`, "utf8"); const pendingPath = pending(f, entry); const wrapper = JSON.parse(fs.readFileSync(pendingPath, "utf8")); wrapper.sha256 = "0".repeat(64); fs.writeFileSync(pendingPath, `${JSON.stringify(wrapper)}\n`);
    const stopping = createEventStore({ stateRoot: f.root, testRecoveryHooks: { afterConflictJournalTransition() { throw Object.assign(new Error("stop"), { code: "EVENT_TEST_STOP_CONFLICT_JOURNAL" }); } } });
    const first = inspectReadOnly(stopping, f.root, "quarantine_conflict"); assert.throws(() => stopping.applyRecovery(recoveryInput(first)), { code: "EVENT_TEST_STOP_CONFLICT_JOURNAL" });
    const manifestPath = path.join(f.root, "quarantine", fs.readdirSync(path.join(f.root, "quarantine")).find((name) => name.startsWith("conflict-")));
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); manifest.canonical_path = outside; fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    const guarded = createEventStore({ stateRoot: f.root }); const inspection = inspectReadOnly(guarded, f.root, "blocked_conflict");
    assert.throws(() => guarded.applyRecovery(recoveryInput(inspection)), { code: "RECOVERY_ACTION_BLOCKED" });
    assert.equal(fs.readFileSync(outside, "utf8"), "outside evidence\n"); assert.equal(fs.existsSync(pendingPath), true);
  } finally { if (fs.existsSync(outside)) fs.unlinkSync(outside); f.cleanup(); }
});

function assertLateRecoveryPendingSwap(name, journaled) {
  const f = fixture();
  try {
    const source = request(`late-pending-${name}`); const entry = { journal_version: 1, sequence: 1, ...source, committed_at: "2026-07-15T00:00:00.000Z" };
    const pendingPath = pending(f, entry); if (journaled) fs.writeFileSync(f.journal, `${JSON.stringify(entry)}\n`, "utf8");
    const replacement = Buffer.from(`${JSON.stringify({ replacement: name })}\n`, "utf8");
    const store = createEventStore({ stateRoot: f.root, testLockHooks: { beforeDeleteReleaseArtifact() { fs.writeFileSync(pendingPath, replacement); } } });
    const inspection = inspectReadOnly(store, f.root, journaled ? "finalize_pending_commit" : "retry_pending_commit");
    assert.throws(() => store.applyRecovery(recoveryInput(inspection)), { code: "EVENT_PENDING_VERIFY_FAILED" });
    assert.deepEqual(fs.readFileSync(pendingPath), replacement);
    assert.equal(store.inspectRecovery().action, "blocked_pending");
  } finally { f.cleanup(); }
}
test("retry_pending_commit rejects a late pending replacement during lock release", () => assertLateRecoveryPendingSwap("retry", false));
test("finalize_pending_commit rejects a late pending replacement during lock release", () => assertLateRecoveryPendingSwap("finalize", true));

test("finalize_pending_commit preserves pending evidence when projection rebuild fails", () => {
  const f = fixture();
  try {
    const source = request("finalize-projection-failure"); const entry = { journal_version: 1, sequence: 1, ...source, committed_at: "2026-07-15T00:00:00.000Z" };
    fs.writeFileSync(f.journal, `${JSON.stringify(entry)}\n`, "utf8"); const pendingPath = pending(f, entry);
    const store = createEventStore({ stateRoot: f.root, reducers: { "counter.add"() { throw Object.assign(new Error("projection rebuild failed"), { code: "EVENT_PROJECTION_REBUILD_FAILED" }); } } });
    const inspection = inspectReadOnly(store, f.root, "finalize_pending_commit");
    assert.throws(() => store.applyRecovery(recoveryInput(inspection)), { code: "EVENT_PROJECTION_REBUILD_FAILED" });
    assert.equal(fs.existsSync(pendingPath), true);
    assert.equal(inspectReadOnly(store, f.root, "finalize_pending_commit").last_valid_sequence, 1);
  } finally { f.cleanup(); }
});

test("recovery case 05: truncated final without independent evidence is blocked", () => {
  const f = fixture();
  try { fs.writeFileSync(f.journal, "{\"broken\"", "utf8"); const inspection = inspectReadOnly(createEventStore({ stateRoot: f.root }), f.root, "blocked_corruption"); assert.equal(inspection.last_valid_sequence, 0); assert.equal(inspection.required_user_decision, "manual_recovery"); assert.equal(inspection.quarantine_paths.length, 1); } finally { f.cleanup(); }
});

test("recovery case 06: corrupted middle journal line is blocked", () => {
  const f = fixture();
  try { const store = createEventStore({ stateRoot: f.root }); store.commit(request("case-04a")); store.commit({ ...request("case-04b"), expected_revision: 1 }); const [first] = fs.readFileSync(f.journal, "utf8").trim().split("\n"); fs.writeFileSync(f.journal, `${first}\n{broken}\n`); const inspection = inspectReadOnly(store, f.root, "blocked_corruption"); assert.equal(inspection.last_valid_sequence, 1); assert.equal(inspection.required_user_decision, "manual_recovery"); } finally { f.cleanup(); }
});

test("recovery case 07: journal sequence gap is blocked", () => {
  const f = fixture();
  try { const store = createEventStore({ stateRoot: f.root }); store.commit(request("case-05")); fs.writeFileSync(f.journal, fs.readFileSync(f.journal, "utf8").replace('"sequence":1', '"sequence":2')); const inspection = inspectReadOnly(store, f.root, "blocked_corruption"); assert.equal(inspection.last_valid_sequence, 0); assert.equal(inspection.required_user_decision, "manual_recovery"); } finally { f.cleanup(); }
});

test("recovery case 08: duplicate journal sequence is blocked", () => {
  const f = fixture();
  try { const store = createEventStore({ stateRoot: f.root }); store.commit(request("case-06")); const line = fs.readFileSync(f.journal, "utf8").trim(); fs.writeFileSync(f.journal, `${line}\n${line}\n`); const inspection = inspectReadOnly(store, f.root, "blocked_corruption"); assert.equal(inspection.last_valid_sequence, 1); assert.equal(inspection.required_user_decision, "manual_recovery"); } finally { f.cleanup(); }
});

test("recovery case 09: stale lock stays present until explicit recovery", () => {
  const f = fixture();
  try { const store = createEventStore({ stateRoot: f.root }); fs.writeFileSync(`${f.journal}.lock`, "{}\n"); const inspection = inspectReadOnly(store, f.root, "blocked_lock"); assert.equal(inspection.last_valid_sequence, 0); assert.equal(inspection.required_user_decision, "manual_lock_repair"); assert.equal(fs.existsSync(`${f.journal}.lock`), true); } finally { f.cleanup(); }
});

test("recovery case 10: OneDrive conflict copy exposes both hashes and requires a user decision without choosing a revision", () => {
  const f = fixture();
  try { const store = createEventStore({ stateRoot: f.root }); store.commit(request("case-08")); const conflict = path.join(f.root, "events (conflicted copy).jsonl"); fs.writeFileSync(conflict, "other copy\n"); const inspection = inspectReadOnly(store, f.root, "blocked_conflict"); const original = inspection.artifacts.find((artifact) => artifact.path === f.journal); assert.equal(inspection.last_valid_sequence, 1); assert.equal(inspection.required_user_decision, "user_decision"); assert.equal(inspection.conflicts.length, 1); assert.match(original.sha256, /^[a-f0-9]{64}$/); assert.match(inspection.conflicts[0].sha256, /^[a-f0-9]{64}$/); assert.equal(typeof inspection.conflicts[0].mtime_ms, "number"); assert.equal(Object.hasOwn(inspection, "selected_revision"), false); } finally { f.cleanup(); }
});

test("recovery case 04: truncated final with backup and unique pending quarantines, restores, and retries", () => {
  const f = fixture();
  try { const store = createEventStore({ stateRoot: f.root }); store.commit(request("case-09-base")); const original = fs.readFileSync(f.journal); fs.writeFileSync(`${f.journal}.bak`, original); const source = { ...request("case-09-pending"), expected_revision: 1 }; pending(f, { journal_version: 1, sequence: 2, ...source, committed_at: "2026-07-15T00:00:01.000Z" }); fs.writeFileSync(f.journal, partialNextLine(original, pendingFile(f), true)); const inspection = inspectReadOnly(store, f.root, "restore_backup_retry"); assert.equal(inspection.last_valid_sequence, 1); assert.equal(inspection.required_user_decision, "explicit_recovery"); assert.equal(inspection.quarantine_paths.length, 1); assert.equal(store.applyRecovery(recoveryInput(inspection)).status, "committed"); assert.equal(fs.existsSync(inspection.quarantine_paths[0]), true); assert.equal(store.commit(source).status, "idempotent"); } finally { f.cleanup(); }
});

test("recovery case 11: projection behind is rebuilt only by explicit apply", () => {
  const f = fixture();
  try { const store = createEventStore({ stateRoot: f.root }); store.commit(request("case-10")); const projection = path.join(f.root, "projections", "state.json"); const data = JSON.parse(fs.readFileSync(projection, "utf8")); fs.writeFileSync(projection, `${JSON.stringify({ ...data, journal_sequence: 0 })}\n`); const inspection = inspectReadOnly(store, f.root, "rebuild_projection"); assert.equal(inspection.last_valid_sequence, 1); assert.equal(inspection.required_user_decision, null); assert.equal(store.applyRecovery(recoveryInput(inspection)).status, "projection_rebuilt"); } finally { f.cleanup(); }
});

test("recovery case 12: projection ahead and journal hash mismatch are rebuilt only by explicit apply", () => {
  const f = fixture();
  try { const store = createEventStore({ stateRoot: f.root }); store.commit(request("case-12")); const projection = path.join(f.root, "projections", "state.json"); const data = JSON.parse(fs.readFileSync(projection, "utf8")); for (const changed of [{ ...data, journal_sequence: 2 }, { ...data, journal_hash: "0".repeat(64) }]) { fs.writeFileSync(projection, `${JSON.stringify(changed)}\n`); const inspection = inspectReadOnly(store, f.root, "rebuild_projection"); assert.equal(inspection.last_valid_sequence, 1); assert.equal(inspection.required_user_decision, null); assert.equal(store.applyRecovery(recoveryInput(inspection)).status, "projection_rebuilt"); } } finally { f.cleanup(); }
});

test("recovery inspection is read-only, detects the twelve matrix states, and apply rejects drift", () => {
  const f = fixture();
  try {
    const store = createEventStore({ stateRoot: f.root, workspaceId: "recovery" });
    const entry = { journal_version: 1, sequence: 1, ...request("pending"), committed_at: "2026-07-15T00:00:00.000Z" };
    pending(f, entry, "recovery");
    const before = fs.readFileSync(pendingFile(f));
    const inspection = store.inspectRecovery();
    assert.equal(inspection.action, "retry_pending_commit");
    assert.deepEqual(fs.readFileSync(pendingFile(f)), before);
    fs.appendFileSync(pendingFile(f), " ");
    assert.throws(() => store.applyRecovery({ recoveryId: inspection.recovery_id, action: inspection.action, operator: { type: "local_operator", id: "explicit-recovery-command" } }), { code: "RECOVERY_STATE_CHANGED" });
  } finally { f.cleanup(); }
});

test("explicit retry_pending_commit reexecutes the pending batch and leaves the next retry idempotent", () => {
  const f = fixture();
  try {
    const store = createEventStore({ stateRoot: f.root, workspaceId: "recovery" });
    const source = request("explicit");
    const entry = { journal_version: 1, sequence: 1, ...source, committed_at: "2026-07-15T00:00:00.000Z" };
    pending(f, entry, "recovery");
    const inspection = store.inspectRecovery();
    const applied = store.applyRecovery({ recoveryId: inspection.recovery_id, action: "retry_pending_commit", operator: { type: "local_operator", id: "explicit-recovery-command" } });
    assert.equal(applied.status, "committed"); assert.equal(applied.sequence, 1); assert.ok(applied.summary);
    assert.deepEqual(store.commit(source), { status: "idempotent", sequence: 1 });
    assert.equal(fs.readdirSync(path.join(f.root, "pending")).length, 0);
  } finally { f.cleanup(); }
});

test("explicit finalize_pending_commit rebuilds a journaled pending batch and rejects a conflicting hash", () => {
  const f = fixture();
  try {
    const source = request("journaled");
    const store = createEventStore({ stateRoot: f.root, workspaceId: "recovery" });
    store.commit(source);
    const line = fs.readFileSync(f.journal, "utf8").trim();
    const entry = JSON.parse(line);
    pending(f, entry, "recovery");
    const inspection = store.inspectRecovery();
    assert.equal(inspection.action, "finalize_pending_commit");
    assert.equal(store.applyRecovery({ recoveryId: inspection.recovery_id, action: inspection.action, operator: { type: "local_operator", id: "explicit-recovery-command" } }).status, "pending_committed_rebuilt");
    pending(f, { ...entry, batch_id: entry.batch_id }, "recovery");
    const pendingPath = pendingFile(f);
    const changed = JSON.parse(fs.readFileSync(pendingPath, "utf8")); changed.sha256 = "0".repeat(64); fs.writeFileSync(pendingPath, `${JSON.stringify(changed)}\n`);
    assert.equal(store.inspectRecovery().action, "quarantine_conflict");
  } finally { f.cleanup(); }
});

test("recovery matrix blocks corruption, conflicts, stale locks, and conflict copies without mutation", () => {
  const cases = [
    ["truncated", (f) => fs.writeFileSync(f.journal, "{bad", "utf8"), "blocked_corruption"],
    ["middle", (f) => fs.writeFileSync(f.journal, "{bad}\n{bad}\n", "utf8"), "blocked_corruption"],
    ["gap", (f) => fs.writeFileSync(f.journal, "{\"sequence\":2}\n", "utf8"), "blocked_corruption"],
    ["duplicate", (f) => fs.writeFileSync(f.journal, "{\"sequence\":1}\n{\"sequence\":1}\n", "utf8"), "blocked_corruption"],
    ["stale", (f) => fs.writeFileSync(`${f.journal}.lock`, "{}\n", "utf8"), "blocked_lock"],
    ["conflict", (f) => fs.writeFileSync(path.join(f.root, "events (conflicted copy).jsonl"), "conflict\n", "utf8"), "blocked_conflict"],
  ];
  for (const [name, arrange, expected] of cases) {
    const f = fixture();
    try {
      arrange(f);
      const store = createEventStore({ stateRoot: f.root, workspaceId: "recovery" });
      const before = fs.readdirSync(f.root).sort();
      const inspection = store.inspectRecovery();
      assert.equal(inspection.action, expected, name);
      assert.deepEqual(fs.readdirSync(f.root).sort(), before, name);
      assert.ok(Object.hasOwn(inspection, "last_valid_sequence"));
      assert.ok(Array.isArray(inspection.quarantine_paths));
    } finally { f.cleanup(); }
  }
});

test("truncated final with a valid backup and unique pending batch quarantines, restores, and retries explicitly", () => {
  const f = fixture();
  try {
    const store = createEventStore({ stateRoot: f.root, workspaceId: "recovery" });
    store.commit(request("backup-base"));
    const original = fs.readFileSync(f.journal);
    fs.writeFileSync(`${f.journal}.bak`, original);
    const source = { ...request("backup-pending"), expected_revision: 1 };
    pending(f, { journal_version: 1, sequence: 2, ...source, committed_at: "2026-07-15T00:00:01.000Z" }, "recovery");
    fs.writeFileSync(f.journal, partialNextLine(original, pendingFile(f)));
    const inspection = store.inspectRecovery();
    assert.equal(inspection.action, "restore_backup_retry");
    assert.equal(inspection.last_valid_sequence, 1);
    assert.equal(inspection.required_user_decision, "explicit_recovery");
    const applied = store.applyRecovery({ recoveryId: inspection.recovery_id, action: inspection.action, operator: { type: "local_operator", id: "explicit-recovery-command" } });
    assert.equal(applied.status, "committed");
    assert.equal(store.replay().watermark.journal_sequence, 2);
    assert.equal(store.commit(source).status, "idempotent");
    assert.equal(fs.readdirSync(path.join(f.root, "quarantine")).length, 1);
  } finally { f.cleanup(); }
});

test("projection behind and ahead or hash-mismatched projections rebuild only after explicit apply", () => {
  const f = fixture();
  try {
    const store = createEventStore({ stateRoot: f.root, workspaceId: "recovery" });
    store.commit(request("projection"));
    const projection = path.join(f.root, "projections", "state.json");
    const original = fs.readFileSync(projection);
    for (const mutate of [
      (value) => ({ ...value, journal_sequence: 0 }),
      (value) => ({ ...value, journal_sequence: 99 }),
      (value) => ({ ...value, journal_hash: "0".repeat(64) }),
    ]) {
      const changed = mutate(JSON.parse(original));
      fs.writeFileSync(projection, `${JSON.stringify(changed)}\n`);
      const inspection = store.inspectRecovery();
      assert.equal(inspection.action, "rebuild_projection");
      assert.equal(inspection.last_valid_sequence, 1);
      assert.equal(inspection.required_user_decision, null);
      assert.equal(store.applyRecovery({ recoveryId: inspection.recovery_id, action: inspection.action, operator: { type: "local_operator", id: "explicit-recovery-command" } }).status, "projection_rebuilt");
    }
  } finally { f.cleanup(); }
});

test("projection callback failure never rolls back a verified journal and leaves pending evidence for explicit finalization", () => {
  const f = fixture();
  try {
    const store = createEventStore({ stateRoot: f.root, workspaceId: "recovery", project() { throw Object.assign(new Error("projection callback failed"), { code: "EVENT_PROJECTION_CALLBACK_FAILED" }); } });
    const source = request("projection-failure");
    assert.throws(() => store.commit(source), { code: "EVENT_PROJECTION_CALLBACK_FAILED" });
    assert.equal(store.replay().watermark.journal_sequence, 1);
    assert.equal(fs.readdirSync(path.join(f.root, "pending")).length, 1);
    const inspection = inspectReadOnly(store, f.root, "finalize_pending_commit");
    assert.equal(store.applyRecovery(recoveryInput(inspection)).status, "pending_committed_rebuilt");
    assert.equal(store.commit(source).status, "idempotent");
  } finally { f.cleanup(); }
});

test("projection reducer failure never rolls back a verified journal and leaves pending evidence", () => {
  const f = fixture();
  try {
    const store = createEventStore({ stateRoot: f.root, workspaceId: "recovery", reducers: { "counter.add"() { throw Object.assign(new Error("projection reducer failed"), { code: "EVENT_PROJECTION_REDUCER_FAILED" }); } } });
    assert.throws(() => store.commit(request("projection-reducer-failure")), { code: "EVENT_PROJECTION_REDUCER_FAILED" });
    assert.equal(store.replay({ reducers: {}, initialState: {} }).watermark.journal_sequence, 1);
    assert.equal(fs.readdirSync(path.join(f.root, "pending")).length, 1);
  } finally { f.cleanup(); }
});

test("seven real process crash points recover explicitly to one journal batch and projection", () => {
  for (const point of CRASH_POINTS) {
    const f = fixture();
    try {
      const child = spawnSync(process.execPath, [path.join(__dirname, "crash-worker.js"), "crash", f.root, `crash-${point}`, `crash-event-${point}`, point], { encoding: "utf8" });
      assert.equal(child.status, 86, point);
      assert.equal(fs.existsSync(path.join(f.root, "projections", "state.json")), ["after_projection_write", "before_pending_delete"].includes(point), point);
      const store = createEventStore({ stateRoot: f.root, workspaceId: "workspace-a" });
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const inspection = store.inspectRecovery();
        if (inspection.action === "none") break;
        assert.notEqual(inspection.action, "blocked_corruption", point);
        store.applyRecovery({ recoveryId: inspection.recovery_id, action: inspection.action, operator: { type: "local_operator", id: "explicit-recovery-command" } });
      }
      assert.equal(store.inspectRecovery().action, "none", point);
      const retry = { expected_revision: 0, batch_id: `crash-${point}`, actor: { type: "agent", id: "implementation-001" }, correlation_id: `correlation-crash-${point}`, events: [{ event_id: `crash-event-${point}`, schema_version: 1, type: "task.updated", payload: { worker: "crash" }, evidence_refs: ["test://crash-worker"] }] };
      assert.ok(["committed", "idempotent"].includes(store.commit(retry).status), point);
      assert.equal(store.commit(retry).status, "idempotent", point);
      assert.equal(store.replay({ reducers: {}, initialState: {} }).watermark.journal_sequence, 1, point);
      assert.equal(fs.existsSync(path.join(f.root, "projections", "state.json")), true, point);
      assert.equal(fs.existsSync(`${f.journal}.lock`), false, point);
    } finally { f.cleanup(); }
  }
});
