"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { main, parseArguments, resolveInside } = require("./project-structure-migration-plan");

const NOW = "2026-08-01T00:00:00.000Z";

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function manifests(root) {
  writeJson(path.join(root, ".orquesta", "project", "layout.json"), {
    schema_version: 1,
    status: "draft",
    project_id: "fixture",
    project_kind: "software",
    components: [{
      component_id: "runtime",
      kind: "runtime_state",
      roots: [".orquesta"],
      owner: null,
      default_lifecycle: "current",
      default_authority: "supporting",
      default_read_policy: "task_candidate",
      include: ["**"],
      exclude: [],
    }],
    generated_roots: [],
    external_storage_roots: [],
    updated_at: NOW,
  });
  writeJson(path.join(root, ".orquesta", "project", "lifecycle.json"), {
    schema_version: 1,
    status: "draft",
    rules: [{
      rule_id: "canonical-state",
      match: [".orquesta/state/*.json"],
      lifecycle: "current",
      authority: "canonical",
      read_policy: "task_candidate",
      storage_policy: "versioned",
      reason: "Canonical state.",
    }],
    overrides: [],
    canonical_claims: [],
    updated_at: NOW,
  });
}

test("CLI writes review evidence but does not apply the planned move", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-migration-cli-"));
  try {
    manifests(root);
    const backup = path.join(root, ".orquesta", "state", "sessions.json.bak");
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.writeFileSync(backup, "backup\n", "utf8");
    writeJson(path.join(root, "candidates.json"), [{
      action: "quarantine",
      source_ref: ".orquesta/state/sessions.json.bak",
      reason: "Fixture backup.",
      confidence: "high",
    }]);
    const result = main([
      "--root", root,
      "--candidates", "candidates.json",
      "--output", ".orquesta/project/migration-plan.json",
      "--report", ".orquesta/reports/migration-plan.md",
    ]);
    assert.equal(result.plan.status, "review_required");
    assert.equal(fs.existsSync(backup), true);
    assert.equal(fs.existsSync(path.join(root, ".orquesta", "archive")), false);
    assert.equal(fs.existsSync(path.join(root, ".orquesta", "project", "migration-plan.json")), true);
    assert.match(fs.readFileSync(path.join(root, ".orquesta", "reports", "migration-plan.md"), "utf8"), /entire plan requires user approval/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CLI parser stays bounded to project-relative outputs", () => {
  assert.equal(parseArguments(["--root", "x"]).root, "x");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-migration-path-"));
  try {
    assert.throws(() => resolveInside(root, "../outside.json"), /escapes project root/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
