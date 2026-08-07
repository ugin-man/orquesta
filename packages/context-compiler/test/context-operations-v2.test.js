"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  buildProjectMapV2,
  compareColdAndSteadyContextCosts,
  createContextCostReport,
  evaluateContextV2Activation,
  refreshSourceCatalogV2,
  summarizeContextVariantComparison,
} = require("../src");

const NOW = "2026-07-31T00:00:00.000Z";

test("context cost reports separate cold and steady costs and preserve actual read evidence", () => {
  const common = {
    universalContract: "short universal contract",
    taskEnvelope: { task: "bounded" },
    projectControlPlane: { goal: "ship" },
    specialistCapabilitySlice: { capabilities: ["code"] },
    selectedProjectSources: [{ token_estimate: 40 }],
    toolResults: { tokens: 12, evidence_ref: "session:tools" },
    conversationHistory: { tokens: 8, evidence_ref: "session:history" },
    observedFullPromptTokens: 150,
    fileReadEvents: [{
      source_id: "SRC-123456789abc",
      source_ref: "src/app.js",
      bytes: 80,
      tokens: 20,
      truncated: false,
    }],
    fileReadMeasurementComplete: true,
    generatedAt: NOW,
  };
  const cold = createContextCostReport({
    ...common,
    runId: "cold-1",
    startupMode: "cold",
    codexHarnessBaseline: { tokens: 70, evidence_ref: "session:cold" },
    foundation: { generation_count: 3, reuse_count: 0 },
  });
  const steady = createContextCostReport({
    ...common,
    runId: "steady-1",
    startupMode: "steady",
    codexHarnessBaseline: { tokens: 25, evidence_ref: "session:steady" },
    observedFullPromptTokens: 100,
    foundation: { generation_count: 0, reuse_count: 3 },
  });
  assert.equal(cold.file_reading.bytes, 80);
  assert.equal(cold.file_reading.tokens, 20);
  assert.equal(cold.explainable, true);
  const comparison = compareColdAndSteadyContextCosts(cold, steady);
  assert.equal(comparison.comparable, true);
  assert.equal(comparison.prompt_token_delta, -50);
  assert.equal(comparison.steady_reused_foundation, true);

  const incomplete = createContextCostReport({
    ...common,
    startupMode: "steady",
    codexHarnessBaseline: undefined,
  });
  assert.equal(incomplete.categories.codex_harness_baseline.measurement, "unknown");
  assert.equal(incomplete.explainable, false);
});

test("source catalog refresh and Project Map update only changed local sources", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-project-map-"));
  try {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.mkdirSync(path.join(root, "docs"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "src", "app.js"),
      "import { helper } from './helper.js';\nexport function run() { return helper(); }\n",
      "utf8",
    );
    fs.writeFileSync(path.join(root, "src", "helper.js"), "export const helper = () => 1;\n", "utf8");
    fs.writeFileSync(path.join(root, "docs", "brief.md"), "# Product brief\nThe current goal.\n", "utf8");
    const first = refreshSourceCatalogV2({
      workspaceRoot: root,
      sourceRefs: ["src/app.js", "src/helper.js", "docs/brief.md"],
    });
    assert.equal(first.delta.added_source_ids.length, 3);
    const firstMap = buildProjectMapV2({
      workspaceRoot: root,
      sourceCatalog: first.records,
      projectControlPlane: {
        project_id: "demo",
        active_workstream: { workstream_id: "workstream:demo" },
        decision_ledger: [{ decision: "keep API" }],
        work_graph: {},
      },
      relatedTaskIdsByRef: { "src/app.js": ["T1"] },
      generatedAt: NOW,
    });
    const app = firstMap.details.find((detail) => detail.source_ref === "src/app.js");
    assert.deepEqual(app.symbols, ["run"]);
    assert.deepEqual(app.dependencies, ["./helper.js"]);
    assert.deepEqual(app.related_task_ids, ["T1"]);
    const helperId = first.records.find((record) => record.source_ref === "src/helper.js").source_id;

    fs.writeFileSync(
      path.join(root, "src", "app.js"),
      "import { helper } from './helper.js';\nexport function run() { return helper() + 1; }\n",
      "utf8",
    );
    const second = refreshSourceCatalogV2({
      workspaceRoot: root,
      previousRecords: first.records,
    });
    assert.equal(second.delta.changed_source_ids.length, 1);
    assert.ok(second.delta.unchanged_source_ids.includes(helperId));
    assert.ok(second.records.some((record) => record.source_ref === "src/app.js" && record.status === "superseded"));
    const secondMap = buildProjectMapV2({
      workspaceRoot: root,
      sourceCatalog: second.records,
      projectControlPlane: {
        project_id: "demo",
        active_workstream: { workstream_id: "workstream:demo" },
        decision_ledger: [{ decision: "keep API" }],
        work_graph: {},
      },
      priorMap: firstMap,
      generatedAt: NOW,
    });
    assert.equal(secondMap.revision, firstMap.revision + 1);
    assert.deepEqual(secondMap.delta.changed_source_refs, ["src/app.js"]);

    fs.rmSync(path.join(root, "docs", "brief.md"));
    const third = refreshSourceCatalogV2({
      workspaceRoot: root,
      previousRecords: second.records,
    });
    assert.deepEqual(third.delta.removed_source_refs, ["docs/brief.md"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Project Map never decodes binary assets as UTF-8 descriptions", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-project-map-binary-"));
  try {
    fs.mkdirSync(path.join(root, "assets"), { recursive: true });
    fs.writeFileSync(path.join(root, "assets", "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]));
    const catalog = refreshSourceCatalogV2({ workspaceRoot: root, sourceRefs: ["assets/image.png"] });
    const map = buildProjectMapV2({
      workspaceRoot: root,
      sourceCatalog: catalog.records,
      projectControlPlane: { project_id: "binary-fixture", work_graph: {}, decision_ledger: [] },
      generatedAt: "2026-08-01T00:00:00.000Z",
    });
    assert.equal(map.details[0].description, "visual_reference artifact");
    assert.equal(map.details[0].description.includes("\uFFFD"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("limited activation is structural, comparison-gated, and deterministically falls back", () => {
  const rows = ["v1", "fixed_minimal", "v2_initial", "v2_bounded_retrieval"].map((variant) => ({
    variant,
    quality_passed: true,
    major_regression: false,
    user_corrections: 0,
    incorrect_project_facts: 0,
    cold_cost_explainable: true,
    steady_cost_explainable: true,
    prompt_tokens: 100,
    wall_time_ms: 50,
  }));
  const comparison = summarizeContextVariantComparison(rows);
  assert.equal(comparison.passed, true);
  const requirement = {
    status: "ready",
    decision_authority: "proposal_only",
    project_scope: "component",
    knowledge_domains: ["fiction.world", "visual.composition"],
  };
  const pack = {
    context_pack_id: "CP2-123456789abc",
    fallback_reason: null,
    staleness: { state: "current" },
    budget_receipt: { mandatory_overflow: 0 },
    retrieval_permissions: { expand: true },
  };
  const active = evaluateContextV2Activation({
    featureMode: "limited",
    contextRequirement: requirement,
    contextPack: pack,
    variantComparison: comparison,
  });
  assert.equal(active.route, "v2_bounded_retrieval");
  assert.equal(active.fallback, false);

  const globalWrite = evaluateContextV2Activation({
    featureMode: "limited",
    contextRequirement: { ...requirement, decision_authority: "bounded_execution", project_scope: "global" },
    contextPack: pack,
    variantComparison: comparison,
  });
  assert.equal(globalWrite.route, "v1_fallback");
  assert.ok(globalWrite.reasons.includes("structural_class:outside_limited_boundary"));

  const noEvidence = evaluateContextV2Activation({
    featureMode: "limited",
    contextRequirement: requirement,
    contextPack: pack,
  });
  assert.equal(noEvidence.route, "v1_fallback");
  assert.ok(noEvidence.reasons.includes("variant_comparison_not_passed"));

  const secondScenario = rows.map((row) => ({
    ...row,
    scenario_id: "worldbuilding",
    ...(row.variant === "v2_initial" ? { major_regression: true } : {}),
  }));
  const multiScenario = summarizeContextVariantComparison([
    ...rows.map((row) => ({ ...row, scenario_id: "local-code" })),
    ...secondScenario,
  ]);
  assert.equal(multiScenario.scenario_count, 2);
  assert.equal(multiScenario.passed, false);
  assert.ok(multiScenario.blockers.includes("worldbuilding:v2_initial:quality_regression"));
});

test("four-way comparison accepts a retrieval-required scenario only when bounded retrieval recovers quality", () => {
  const base = { scenario_id: "retrieval-required", retrieval_required: true, major_regression: false, user_corrections: 0, incorrect_project_facts: 0, cold_cost_explainable: true, steady_cost_explainable: true };
  const comparison = summarizeContextVariantComparison([
    { ...base, variant: "v1", quality_passed: true },
    { ...base, variant: "fixed_minimal", quality_passed: true },
    { ...base, variant: "v2_initial", quality_passed: false },
    { ...base, variant: "v2_bounded_retrieval", quality_passed: true },
  ]);
  assert.equal(comparison.passed, true);
  assert.equal(comparison.scenarios[0].retrieval_required, true);
});
