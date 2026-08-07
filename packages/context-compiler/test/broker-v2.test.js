"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createTaskIntent } = require("../../core/src/task-intent");
const {
  buildSourceCatalogV2,
  compileContextPackV2Shadow,
  createContextBrokerV2,
  createTaskEnvelopeV2,
  deriveContextRequirementV2,
} = require("../src");

const NOW = "2026-07-31T00:00:00.000Z";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-context-broker-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "target.js"), "export const target = 1;\n", "utf8");
  fs.writeFileSync(path.join(root, "src", "extra.js"), "export const extra = 2;\n", "utf8");
  const taskIntent = createTaskIntent({
    rawRequestRef: "user:broker-test",
    desiredOutcome: "Update the bounded target.",
    acceptanceCriteria: ["src/target.js is updated and verified"],
    constraints: ["Do not read unrelated files."],
    risk: { impact: "low", reversible: true },
    authorityBoundary: { agent_may: ["read source", "edit target"], user_only: [] },
    assumptions: [],
    status: "compiled",
  });
  const taskEnvelope = createTaskEnvelopeV2({
    taskIntent,
    workItem: {
      execution_channel: "product_implementation",
      context_manifest: { required_reading: ["src/target.js"] },
    },
  });
  const contextRequirement = deriveContextRequirementV2({
    taskIntent,
    taskEnvelope,
    workItem: {
      scope_boundaries: ["src"],
      context_manifest: { required_reading: ["src/target.js"] },
      initial_token_budget: 2000,
      expansion_budget: 2000,
    },
  });
  const sourceCatalog = buildSourceCatalogV2({
    workspaceRoot: root,
    taskIntent,
    taskEnvelope,
    contextRequirement,
    sourceRefs: ["src/target.js", "src/extra.js"],
  });
  const { context_pack: contextPack } = compileContextPackV2Shadow({
    taskIntent,
    taskEnvelope,
    contextRequirement,
    agentCapabilityProfile: {
      agent_id: "unknown-specialist-001",
      capabilities: [],
      availability: "available",
      organization_revision: 1,
    },
    sourceCatalog,
  });
  return {
    root,
    taskIntent,
    taskEnvelope,
    contextRequirement,
    sourceCatalog,
    contextPack,
    inlineSources: {
      [`task_intent:${taskIntent.task_intent_id}`]: JSON.stringify(taskIntent),
      [`task_envelope:${taskEnvelope.task_envelope_id}`]: JSON.stringify(taskEnvelope),
    },
  };
}

test("Broker searches the bounded catalog without scanning the workspace", () => {
  const input = fixture();
  try {
    fs.writeFileSync(path.join(input.root, "secret-unindexed.txt"), "extra secret", "utf8");
    const broker = createContextBrokerV2({ ...input, workspaceRoot: input.root });
    const results = broker.search("extra");
    assert.deepEqual(results.map(({ source_ref }) => source_ref), ["src/extra.js"]);
    assert.equal(results.some(({ source_ref }) => source_ref.includes("secret-unindexed")), false);
  } finally {
    fs.rmSync(input.root, { recursive: true, force: true });
  }
});

test("Broker requires explicit expansion before opening unselected context and records its cost", () => {
  const input = fixture();
  try {
    const broker = createContextBrokerV2({ ...input, workspaceRoot: input.root });
    assert.throws(() => broker.open("src/extra.js"), /source_not_selected/);
    const expanded = broker.expand(["src/extra.js"]);
    assert.equal(expanded.added.length, 1);
    const opened = broker.open("src/extra.js");
    assert.match(opened.content, /extra = 2/u);
    assert.equal(opened.truncated, false);
    assert.equal(broker.explain("src/extra.js").reason, "bounded_expansion");
    assert.ok(broker.snapshot().expansion_tokens > 0);
  } finally {
    fs.rmSync(input.root, { recursive: true, force: true });
  }
});

test("Broker emits one schema-valid receipt from actual use, expansion, and missing context", () => {
  const input = fixture();
  try {
    const broker = createContextBrokerV2({ ...input, workspaceRoot: input.root });
    broker.open("src/target.js");
    broker.expand("src/extra.js");
    broker.open("src/extra.js");
    broker.reportMissingContext("A current user decision is not available.");
    const receipt = broker.finalize({
      compactionCount: 1,
      acceptanceResults: [{ criterion_id: "acceptance:1", status: "passed", evidence_refs: ["test:broker"] }],
      createdAt: NOW,
    });
    assert.equal(receipt.context_pack_id, input.contextPack.context_pack_id);
    assert.equal(receipt.used_source_ids.length, 2);
    assert.ok(receipt.additional_tokens > 0);
    assert.deepEqual(receipt.missing_context, ["A current user decision is not available."]);
    assert.equal(receipt.compaction_count, 1);
  } finally {
    fs.rmSync(input.root, { recursive: true, force: true });
  }
});

test("Broker indexes selected sources without bodies and rehydrates only required anchors", () => {
  const input = fixture();
  try {
    const broker = createContextBrokerV2({ ...input, workspaceRoot: input.root });
    broker.expand("src/extra.js");
    const index = broker.sourceIndex();
    assert.ok(index.length > 0);
    assert.equal(index.some((entry) => Object.hasOwn(entry, "content")), false);
    assert.ok(index.every((entry) => typeof entry.provenance_reason === "string"));

    const result = broker.rehydrate();
    assert.equal(result.status, "rehydrated");
    assert.ok(result.opened.some((entry) => entry.source_ref.startsWith("task_intent:")));
    assert.ok(result.deferred.some((entry) => entry.source_ref === "src/extra.js"));
    assert.equal(result.stale_source_ids.length, 0);
  } finally {
    fs.rmSync(input.root, { recursive: true, force: true });
  }
});

test("Broker stops rehydration on a stale cataloged source but does not false-stale inline task anchors", () => {
  const input = fixture();
  try {
    fs.writeFileSync(path.join(input.root, "src", "target.js"), "export const target = 99;\n", "utf8");
    const broker = createContextBrokerV2({ ...input, workspaceRoot: input.root });
    const result = broker.rehydrate();
    const target = input.sourceCatalog.find((record) => record.source_ref === "src/target.js");
    assert.equal(result.status, "needs_refresh");
    assert.ok(result.stale_source_ids.includes(target.source_id));
    assert.equal(result.next_action, "refresh_source_index");
    assert.ok(result.opened.some((entry) => entry.source_ref.startsWith("task_intent:")));
  } finally {
    fs.rmSync(input.root, { recursive: true, force: true });
  }
});
