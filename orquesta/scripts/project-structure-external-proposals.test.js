"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { main } = require("./project-structure-external-proposals");

test("external proposals inspect targets without writing into them", () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-external-output-"));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-external-target-"));
  try {
    fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "package.json"), "{}\n", "utf8");
    fs.writeFileSync(path.join(projectRoot, "src", "index.js"), "module.exports = {};\n", "utf8");
    const before = fs.readdirSync(projectRoot).sort();
    const result = main([
      "--output-root", outputRoot,
      "--project", "Fixture", projectRoot,
      "--output", "proposals.json",
      "--report", "proposals.md",
    ]);
    assert.equal(result.document.projects[0].archetype, "software");
    assert.deepEqual(result.document.projects[0].physical_changes, []);
    assert.deepEqual(fs.readdirSync(projectRoot).sort(), before);
    assert.equal(fs.existsSync(path.join(outputRoot, "proposals.json")), true);
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
