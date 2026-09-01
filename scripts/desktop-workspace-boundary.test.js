"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repositoryRoot = path.resolve(__dirname, "..");

test("keeps Desktop Next as the only product app and outside the root npm workspace", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8")
  );

  assert.equal(packageJson.workspaces.includes("packages/local-core"), true);
  assert.equal(packageJson.workspaces.includes("packages/business-orchestrator"), true);
  const productApps = fs.readdirSync(path.join(repositoryRoot, "apps"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(repositoryRoot, "apps", entry.name, "package.json")))
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(productApps, ["orquesta-desktop-next"]);
  assert.equal(
    fs.existsSync(path.join(repositoryRoot, "apps", "orquesta-desktop-next", "package-lock.json")),
    true
  );
  const rootLock = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package-lock.json"), "utf8"));
  assert.equal(Object.hasOwn(rootLock.packages, "apps/orquesta-desktop"), false);
  assert.equal(Object.hasOwn(rootLock.packages, "apps/orquesta-desktop-next"), false);
  assert.equal(Object.hasOwn(rootLock.packages, "apps/workbench"), false);
});
