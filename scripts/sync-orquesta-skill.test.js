"use strict";

const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  compareSourceToTarget,
  syncSkillTree,
} = require("./sync-orquesta-skill");

const roots = [];
test.afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "orquesta-skill-sync-"));
  roots.push(root);
  const source = path.join(root, "source");
  const target = path.join(root, "target");
  mkdirSync(path.join(source, "references"), { recursive: true });
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(source, "SKILL.md"), "v4\n", "utf8");
  writeFileSync(path.join(source, "references", "user-support.md"), "support\n", "utf8");
  writeFileSync(path.join(target, "SKILL.md"), "legacy\n", "utf8");
  writeFileSync(path.join(target, "package.json"), "{\"private\":true}\n", "utf8");
  return { source, target };
}

test("overlays every canonical V4 file while preserving target-only metadata", () => {
  const { source, target } = fixture();

  const result = syncSkillTree({ source, target });

  assert.equal(result.copiedFiles, 2);
  assert.equal(readFileSync(path.join(target, "SKILL.md"), "utf8"), "v4\n");
  assert.equal(readFileSync(path.join(target, "references", "user-support.md"), "utf8"), "support\n");
  assert.equal(readFileSync(path.join(target, "package.json"), "utf8"), "{\"private\":true}\n");
  assert.deepEqual(compareSourceToTarget({ source, target }), []);
});

test("reports content drift and missing canonical files", () => {
  const { source, target } = fixture();

  assert.deepEqual(
    compareSourceToTarget({ source, target }).map((item) => item.kind).sort(),
    ["content_mismatch", "missing"],
  );
});

test("refuses to synchronize a directory onto itself", () => {
  const { source } = fixture();
  assert.throws(() => syncSkillTree({ source, target: source }), /must differ/);
});
