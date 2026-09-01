"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createEventStore } = require("../src");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-replay-"));
  return { root, cleanup() { cleanupTree(root); } };
}
function cleanupTree(directory) { if (!fs.existsSync(directory)) return; for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { const target = path.join(directory, entry.name); if (entry.isDirectory()) cleanupTree(target); else fs.unlinkSync(target); } fs.rmdirSync(directory); }

function batch(sequence, type = "counter.add") {
  return {
    expected_revision: sequence - 1,
    batch_id: `replay-batch-${sequence}`,
    actor: { type: "agent", id: "implementation-001" },
    correlation_id: `replay-${sequence}`,
    events: [{ event_id: `replay-event-${sequence}`, schema_version: 1, type, payload: { amount: sequence }, evidence_refs: [] }],
  };
}

const reducers = {
  "counter.add": (state, event) => ({ ...state, total: state.total + event.payload.amount }),
};

test("replay is deterministic and rebuilds missing, behind, ahead, and edited projections", () => {
  const f = fixture();
  try {
    const store = createEventStore({ stateRoot: f.root, workspaceId: "replay", reducers, initialState: { total: 0 } });
    store.commit(batch(1));
    store.commit(batch(2));
    const first = store.replay({ reducers, initialState: { total: 0 } });
    const second = store.replay({ reducers, initialState: { total: 0 } });
    assert.deepEqual(first.state, { total: 3 });
    assert.equal(first.hash, second.hash);
    const rebuilt = store.rebuildProjections({ reducers, initialState: { total: 0 } });
    assert.equal(rebuilt.watermark.journal_sequence, 2);
    const [projectionPath] = store.listProjectionPaths();
    assert.equal(path.relative(path.join(f.root, "projections"), projectionPath).startsWith(".."), false);
    store.removeArtifact(projectionPath);
    assert.equal(store.rebuildProjections({ reducers, initialState: { total: 0 } }).watermark.journal_sequence, 2);
    const projection = JSON.parse(fs.readFileSync(projectionPath, "utf8"));
    projection.journal_sequence = 99;
    fs.writeFileSync(projectionPath, `${JSON.stringify(projection)}\n`, "utf8");
    assert.equal(store.rebuildProjections({ reducers, initialState: { total: 0 } }).watermark.journal_sequence, 2);
  } finally { f.cleanup(); }
});

test("replay owns reducer lookup and exact journal-prefix continuity", () => {
  const f = fixture();
  try {
    const store = createEventStore({ stateRoot: f.root, workspaceId: "cursor" });
    store.commit(batch(1));
    const first = store.replay({ reducers, initialState: { total: 0 } });
    assert.equal(first.continuity, "initial");
    assert.equal(
      store.replay({ reducers, initialState: { total: 0 }, afterCursor: first.cursor }).continuity,
      "unchanged",
    );

    store.commit(batch(2));
    assert.equal(
      store.replay({ reducers, initialState: { total: 0 }, afterCursor: first.cursor }).continuity,
      "advanced",
    );
    assert.equal(
      store.replay({
        reducers,
        initialState: { total: 0 },
        afterCursor: { ...first.cursor, journalHash: "0".repeat(64) },
      }).continuity,
      "diverged",
    );

    store.commit(batch(3, "toString"));
    assert.deepEqual(store.replay({ reducers, initialState: { total: 0 } }).state, { total: 3 });
    assert.throws(
      () => store.replay({
        reducers,
        initialState: { total: 0 },
        claimedEventPrefixes: ["to"],
      }),
      (error) => error?.code === "EVENT_PROJECTION_EVENT_UNSUPPORTED",
    );
  } finally { f.cleanup(); }
});
