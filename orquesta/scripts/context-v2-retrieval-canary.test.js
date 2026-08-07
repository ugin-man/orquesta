"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { runRetrievalCanary } = require("./context-v2-retrieval-canary");

test("canary proves initial insufficiency, bounded expansion, and progressive rehydration", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-retrieval-canary-"));
  try {
    const result = await runRetrievalCanary({ workspaceRoot: root, reportPath: path.join(root, "report.json"), now: () => "2026-08-01T00:00:00.000Z" });
    assert.equal(result.status, "passed");
    assert.equal(result.initial_context_insufficient, true);
    assert.equal(result.bounded_retrieval_recovered, true);
    assert.ok(result.expansion_tokens > 0);
    assert.equal(result.post_compaction_rehydration.status, "rehydrated");
    assert.ok(result.post_compaction_rehydration.deferred_source_refs.includes("project/bounded-constraints.md"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
