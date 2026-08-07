"use strict";

const assert = require("node:assert/strict");
const { mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createVariantReport } = require("./context-v2-variant-report");

test("variant report requires all four strategies for every scenario", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orquesta-variant-report-"));
  try {
    const input = path.join(root, "rows.json");
    const rows = ["v1", "fixed_minimal", "v2_initial", "v2_bounded_retrieval"].map((variant) => ({
      scenario_id: "unknown-specialist",
      variant,
      quality_passed: true,
      major_regression: false,
      user_corrections: 0,
      incorrect_project_facts: 0,
      cold_cost_explainable: true,
      steady_cost_explainable: true,
    }));
    await writeFile(input, JSON.stringify(rows), "utf8");
    const result = await createVariantReport(root, [input], {
      generatedAt: "2026-07-31T00:00:00.000Z",
    });
    assert.equal(result.summary.passed, true);
    const persisted = JSON.parse(await readFile(result.output, "utf8"));
    assert.equal(persisted.scenario_count, 1);
    assert.deepEqual(persisted.required_variants, [
      "v1",
      "fixed_minimal",
      "v2_initial",
      "v2_bounded_retrieval",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
