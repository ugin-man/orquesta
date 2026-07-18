"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repositoryRoot = path.resolve(__dirname, "..", "..");

test("keeps the Windows desktop outside the root npm workspace", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8")
  );

  assert.deepEqual(packageJson.workspaces, ["apps/workbench", "packages/*"]);
  assert.equal(
    fs.existsSync(path.join(repositoryRoot, "apps", "orquesta-desktop", "package-lock.json")),
    true
  );
});
