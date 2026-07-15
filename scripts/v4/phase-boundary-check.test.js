const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  V3_DASHBOARD_BASELINE,
  V3_CHECK_BASELINE,
  hasV3Baseline,
  hasActiveIgnoreRule,
  isAllowedWorkspaceLink
} = require("./phase-boundary-check.js");
const { probeBrowserVersion } = require("./browser-preflight.js");

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
  assert.equal(pkg.scripts.dashboard, V3_DASHBOARD_BASELINE);
  assert.equal(pkg.scripts.check, V3_CHECK_BASELINE);
  assert.equal(hasV3Baseline({
    dashboard: V3_DASHBOARD_BASELINE,
    check: V3_CHECK_BASELINE.slice(0, -" && npm run check:encoding".length)
  }), false, "a truncated V3 check command must fail");
  assert.equal(hasV3Baseline({
    dashboard: V3_DASHBOARD_BASELINE,
    check: `${V3_CHECK_BASELINE} && echo extra`
  }), false, "an appended V3 check command must fail");
  assert.equal(hasV3Baseline({
    dashboard: V3_DASHBOARD_BASELINE,
    check: V3_CHECK_BASELINE.replace(
      "node --check orquesta/dashboard-server.js && node --check orquesta/assets/dashboard/app.js",
      "node --check orquesta/assets/dashboard/app.js && node --check orquesta/dashboard-server.js"
    )
  }), false, "a reordered V3 check command must fail");
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

test("browser preflight accepts only injected Chrome-family version evidence", () => {
  const result = probeBrowserVersion("C:/tool/chrome.exe", {
    spawn: () => ({ status: 0, signal: null, stdout: "Google Chrome 137.0.7151.120\n", stderr: "" })
  });
  assert.deepEqual(result, {
    ok: true,
    version: "Google Chrome 137.0.7151.120"
  });
});

test("browser preflight rejects non-Chrome, empty, and timed-out probes", () => {
  const nonChrome = probeBrowserVersion("C:/tool/not-chrome.exe", {
    spawn: () => ({ status: 0, signal: null, stdout: "v24.12.0\n", stderr: "" })
  });
  const empty = probeBrowserVersion("C:/tool/empty.exe", {
    spawn: () => ({ status: 0, signal: null, stdout: "", stderr: "" })
  });
  const timedOut = probeBrowserVersion("C:/tool/stalled.exe", {
    spawn: () => ({ status: null, signal: "SIGTERM", stdout: "Google Chrome 137.0.7151.120\n", stderr: "" })
  });
  assert.equal(nonChrome.ok, false);
  assert.equal(empty.ok, false);
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.reason, "timeout_or_signal");
});

test("workspace lockfile has no registry-resolved package artifacts", () => {
  const lockfilePath = path.join(root, "package-lock.json");
  assert.equal(fs.existsSync(lockfilePath), true, lockfilePath);
  const lockfile = JSON.parse(fs.readFileSync(lockfilePath, "utf8"));
  for (const entry of Object.values(lockfile.packages || {})) {
    if (Object.hasOwn(entry, "resolved")) {
      assert.equal(isAllowedWorkspaceLink(entry), true);
    }
  }
});

test("lockfile links reject external, absolute, traversal, URI, and unknown paths", () => {
  for (const entry of [
    { link: true, resolved: "packages/contracts" },
    { link: true, resolved: "apps/workbench" }
  ]) assert.equal(isAllowedWorkspaceLink(entry), true);
  for (const entry of [
    { link: true, resolved: "C:/outside/contracts" },
    { link: true, resolved: "../packages/contracts" },
    { link: true, resolved: "https://registry.example/contracts.tgz" },
    { link: true, resolved: "file:../packages/contracts" },
    { link: true, resolved: "packages/not-declared" },
    { link: false, resolved: "packages/contracts" }
  ]) assert.equal(isAllowedWorkspaceLink(entry), false, JSON.stringify(entry));
});

test("ignore rules require active exact lines", () => {
  const rules = ".orquesta/\noutput/\nnode_modules/\n";
  for (const rule of [".orquesta/", "output/", "node_modules/"]) {
    assert.equal(hasActiveIgnoreRule(rules, rule), true);
    assert.equal(hasActiveIgnoreRule(`# ${rule}\n!${rule}\n`, rule), false);
  }
  assert.equal(hasActiveIgnoreRule("prefix-.orquesta/\n", ".orquesta/"), false);
});

test("boundary check rejects unsupported Node versions", () => {
  const check = require("./phase-boundary-check.js");
  assert.equal(check.isSupportedNodeVersion("v20.0.0"), true);
  assert.equal(check.isSupportedNodeVersion("v19.99.0"), false);
});
