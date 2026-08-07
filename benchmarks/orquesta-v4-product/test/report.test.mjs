import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  compareMatrix,
  renderMarkdownReport,
  splitMatrixAndLegacy
} from "../scripts/lib/report.mjs";

const fixtureRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "results"
);
const load = async (name) => JSON.parse(
  await fs.readFile(path.join(fixtureRoot, name), "utf8")
);

async function matrix() {
  return Promise.all([
    load("plain-pass-v2.json"),
    load("skills-pass-v2.json"),
    load("orquesta-pass-v2.json")
  ]);
}

test("compares all three pairwise deltas only when every verifier passes", async () => {
  const comparison = compareMatrix(await matrix());
  assert.equal(comparison.decision, "all_passed");
  assert.equal(comparison.direct_comparison_allowed, true);
  assert.equal(comparison.pairs.plain_vs_skills.time_delta_ms, 30_000);
  assert.equal(comparison.pairs.skills_vs_orquesta.time_delta_ms, -50_000);
  assert.equal(comparison.pairs.plain_vs_orquesta.time_winner, "orquesta");
  assert.equal(comparison.pairs.plain_vs_orquesta.total_token_delta, -200);
  assert.equal(comparison.pairs.plain_vs_orquesta.uncached_input_delta, -80);
});

test("withholds speed and token winners when one condition fails quality", async () => {
  const runs = await matrix();
  runs[1].verifier = {
    status: "failed",
    passed: false,
    duration_ms: 20
  };
  const comparison = compareMatrix(runs);
  assert.equal(comparison.decision, "quality_mismatch");
  assert.equal(comparison.direct_comparison_allowed, false);
  assert.equal(comparison.pairs.plain_vs_skills.time_winner, null);
  assert.equal(comparison.pairs.plain_vs_orquesta.total_token_delta, null);
});

test("rejects missing, duplicate, or cross-matrix conditions", async () => {
  const runs = await matrix();
  assert.throws(() => compareMatrix(runs.slice(0, 2)), /plain, skills, and orquesta/i);
  assert.throws(() => compareMatrix([runs[0], runs[0], runs[2]]), /plain, skills, and orquesta/i);
  runs[2].matrix_id = "another-matrix";
  assert.throws(() => compareMatrix(runs), /matrix_id/i);
});

test("separates legacy solo without relabeling it as plain or skills", async () => {
  const legacy = await load("solo-pass.json");
  legacy.schema_version = 1;
  legacy.run_id = "legacy-solo";
  const split = splitMatrixAndLegacy([...(await matrix()), legacy]);
  assert.equal(split.matrix_runs.length, 3);
  assert.equal(split.legacy_pilots.length, 1);
  assert.equal(split.legacy_pilots[0].mode, "solo");
});

test("renders cached and uncached tokens in a three-column report", async () => {
  const markdown = renderMarkdownReport([compareMatrix(await matrix())], [{
    schema_version: 1,
    mode: "solo",
    run_id: "legacy-solo"
  }]);
  assert.match(markdown, /Plain Codex/);
  assert.match(markdown, /Common skills/);
  assert.match(markdown, /Orquesta V4-fast/);
  assert.match(markdown, /Uncached input tokens/);
  assert.match(markdown, /Cached input tokens/);
  assert.match(markdown, /legacy-solo/);
  assert.doesNotMatch(markdown, /overall score/i);
});
