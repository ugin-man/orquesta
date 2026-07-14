const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const workspacePackages = {
  "apps/workbench": { name: "@orquesta/workbench", dependencies: ["@orquesta/core", "@orquesta/event-store"] },
  "packages/contracts": { name: "@orquesta/contracts", dependencies: [] },
  "packages/event-store": { name: "@orquesta/event-store", dependencies: ["@orquesta/contracts"] },
  "packages/core": { name: "@orquesta/core", dependencies: ["@orquesta/contracts", "@orquesta/event-store", "@orquesta/capability-compiler", "@orquesta/scouts", "@orquesta/audit", "@orquesta/capability-resolver", "@orquesta/context-compiler"] },
  "packages/capability-compiler": { name: "@orquesta/capability-compiler", dependencies: ["@orquesta/contracts"] },
  "packages/scouts": { name: "@orquesta/scouts", dependencies: ["@orquesta/contracts"] },
  "packages/audit": { name: "@orquesta/audit", dependencies: ["@orquesta/contracts"] },
  "packages/capability-resolver": { name: "@orquesta/capability-resolver", dependencies: ["@orquesta/contracts", "@orquesta/audit"] },
  "packages/context-compiler": { name: "@orquesta/context-compiler", dependencies: ["@orquesta/contracts"] }
};

test("V3 entry points remain unchanged", () => {
  assert.equal(pkg.private, false);
  assert.equal(pkg.scripts.dashboard, "node orquesta/dashboard-server.js");
  assert.match(pkg.scripts.check, /^node --check orquesta\/dashboard-server\.js/);
});

test("Phase 1 exposes only the V4 workbench workspace surface", () => {
  assert.deepEqual(pkg.workspaces, ["apps/*", "packages/*"]);
  assert.equal(pkg.scripts["workbench:v4"], "node apps/workbench/server.js --feature v4");
  for (const blocked of [
    "apps/desktop",
    "packages/codex-adapter",
    "packages/experience",
    "packages/intent-graph",
    "plugins/orquesta"
  ]) {
    assert.equal(fs.existsSync(path.join(root, blocked)), false, blocked);
  }
});

test("workspace manifests are private and use only the fixed workspace dependency graph", () => {
  for (const [relativePath, expected] of Object.entries(workspacePackages)) {
    const manifestPath = path.join(root, relativePath, "package.json");
    assert.equal(fs.existsSync(manifestPath), true, manifestPath);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.name, expected.name);
    assert.equal(manifest.private, true);
    assert.equal(manifest.version, "0.4.0-preview.1");
    assert.equal(manifest.scripts.test, "node --test");
    assert.deepEqual(Object.keys(manifest.dependencies || {}).sort(), expected.dependencies.sort());
    for (const dependency of Object.values(manifest.dependencies || {})) {
      assert.equal(dependency, "*");
    }
  }
});

test("boundary checker validates the workspace without touching V3", () => {
  const result = spawnSync(process.execPath, ["scripts/v4/phase-boundary-check.js"], {
    cwd: root,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Orquesta V4 Phase 1 boundary check passed/);
});

test("browser preflight reports a configured existing executable without downloads", () => {
  const result = spawnSync(process.execPath, ["scripts/v4/browser-preflight.js", "--check-chrome-only"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ORQUESTA_CHROME_PATH: process.execPath }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Browser runner path:/);
  assert.match(result.stdout, /Browser runner version:/);
});

test("workspace lockfile has no registry-resolved package artifacts", () => {
  const lockfilePath = path.join(root, "package-lock.json");
  assert.equal(fs.existsSync(lockfilePath), true, lockfilePath);
  const lockfile = JSON.parse(fs.readFileSync(lockfilePath, "utf8"));
  for (const entry of Object.values(lockfile.packages || {})) {
    if (Object.hasOwn(entry, "resolved")) {
      assert.equal(entry.link, true);
      assert.doesNotMatch(entry.resolved, /^https?:/i);
    }
  }
});

test("boundary check rejects unsupported Node versions", () => {
  const check = require("./phase-boundary-check.js");
  assert.equal(check.isSupportedNodeVersion("v20.0.0"), true);
  assert.equal(check.isSupportedNodeVersion("v19.99.0"), false);
});
