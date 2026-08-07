"use strict";

const assert = require("node:assert/strict");
const { mkdir, mkdtemp, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createContextV2ShadowReport } = require("./context-v2-shadow-report");

const roots = [];
const NOW = "2026-07-31T00:00:00.000Z";

test.afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("shadow report separates comparable workspace tokens from V2 control records", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orquesta-shadow-report-"));
  roots.push(root);
  const contextRoot = path.join(root, ".orquesta", "context");
  await writeJson(path.join(contextRoot, "shadow_index.json"), {
    version: 2,
    mode: "shadow",
    comparisons: [{
      task_id: "T1",
      owner_agent_id: "world-builder",
      context_pack_id: "CP2-111111111111",
      v1_required_reading: ["README.md", "docs/world.md"],
      v2_selected_source_refs: ["task_intent:TI1", "task_envelope:TE1", "docs/world.md"],
      only_in_v1: ["README.md"],
      only_in_v2: ["task_intent:TI1", "task_envelope:TE1"],
      v2_selected_tokens: 92,
      coverage_matrix: [
        { criterion_id: "acceptance:1", status: "covered" },
        { criterion_id: "acceptance:2", status: "uncovered" },
      ],
      fallback_reason: "acceptance_coverage_incomplete",
    }],
  });
  await writeJson(path.join(contextRoot, "source_catalog.json"), {
    version: 2,
    records: [
      { source_id: "SRC-111111111111", source_ref: "README.md", token_estimate: 40 },
      { source_id: "SRC-222222222222", source_ref: "docs/world.md", token_estimate: 20 },
      { source_id: "SRC-333333333333", source_ref: "task_intent:TI1", token_estimate: 12 },
      { source_id: "SRC-444444444444", source_ref: "task_envelope:TE1", token_estimate: 60 },
    ],
  });

  const report = await createContextV2ShadowReport(root, { generatedAt: NOW });
  assert.equal(report.assessment, "shadow_only_not_runtime_savings");
  assert.equal(report.tasks[0].v1.comparable_workspace_known_tokens, 60);
  assert.equal(report.tasks[0].v2.comparable_workspace_known_tokens, 20);
  assert.equal(report.tasks[0].v2.coverage.ratio, 0.5);
  assert.equal(report.totals.v2_selected_token_estimate, 92);
  assert.equal(report.interpretation.token_estimates_are_runtime_proof, false);
});

test("shadow report joins a persisted receipt without claiming a cutover", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orquesta-shadow-receipt-"));
  roots.push(root);
  const contextRoot = path.join(root, ".orquesta", "context");
  await writeJson(path.join(contextRoot, "shadow_index.json"), {
    version: 2,
    mode: "shadow",
    comparisons: [{
      task_id: "T2",
      owner_agent_id: "visualizer",
      context_pack_id: "CP2-222222222222",
      v1_required_reading: [],
      v2_selected_source_refs: ["task_intent:TI2"],
      only_in_v1: [],
      only_in_v2: ["task_intent:TI2"],
      v2_selected_tokens: 10,
      coverage_matrix: [],
      fallback_reason: null,
    }],
  });
  await writeJson(path.join(contextRoot, "source_catalog.json"), {
    version: 2,
    records: [
      { source_id: "SRC-555555555555", source_ref: "task_intent:TI2", token_estimate: 10 },
    ],
  });
  await writeJson(path.join(contextRoot, "receipt_index.json"), {
    version: 2,
    receipts: [{ task_id: "T2", receipt_id: "CE-666666666666" }],
  });
  await writeJson(path.join(contextRoot, "receipts", "CE-666666666666.json"), {
    receipt_id: "CE-666666666666",
    used_source_ids: ["SRC-555555555555"],
    unused_source_ids: [],
    additional_tokens: 4,
    compaction_count: 1,
    missing_context: [],
    user_corrections: 0,
    incorrect_project_facts: 0,
  });

  const report = await createContextV2ShadowReport(root, { generatedAt: NOW });
  assert.equal(report.totals.receipt_count, 1);
  assert.equal(report.tasks[0].runtime_receipt.used_source_refs[0], "task_intent:TI2");
  assert.equal(report.totals.runtime_additional_tokens, 4);
  assert.equal(report.interpretation.cutover_allowed_by_this_report, false);
});
