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
  isAllowedCodexDependency,
  isAllowedReviewDependency,
  isAllowedWorkspaceLink
} = require("./phase-boundary-check.js");
const { probeBrowserDriver, probeBrowserVersion } = require("./browser-preflight.js");

const root = path.resolve(__dirname, "../..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const workspacePackages = {
  "apps/workbench": { name: "@orquesta/workbench", version: "0.4.0-preview.1", dependencies: { "@orquesta/core": "*", "@orquesta/event-store": "*" } },
  "packages/contracts": { name: "@orquesta/contracts", version: "0.4.0-preview.1", dependencies: {} },
  "packages/event-store": { name: "@orquesta/event-store", version: "0.4.0-preview.1", dependencies: { "@orquesta/contracts": "*" } },
  "packages/core": { name: "@orquesta/core", version: "0.4.0-preview.1", dependencies: { "@orquesta/contracts": "*", "@orquesta/event-store": "*", "@orquesta/capability-compiler": "*", "@orquesta/scouts": "*", "@orquesta/audit": "*", "@orquesta/capability-resolver": "*", "@orquesta/context-compiler": "*", "@orquesta/evidence-fabric": "*" } },
  "packages/capability-compiler": { name: "@orquesta/capability-compiler", version: "0.4.0-preview.1", dependencies: { "@orquesta/contracts": "*" } },
  "packages/scouts": { name: "@orquesta/scouts", version: "0.4.0-preview.1", dependencies: { "@orquesta/contracts": "*" } },
  "packages/audit": { name: "@orquesta/audit", version: "0.4.0-preview.1", dependencies: { "@orquesta/contracts": "*" } },
  "packages/capability-resolver": { name: "@orquesta/capability-resolver", version: "0.4.0-preview.1", dependencies: { "@orquesta/contracts": "*", "@orquesta/audit": "*" } },
  "packages/context-compiler": { name: "@orquesta/context-compiler", version: "0.4.0-preview.1", dependencies: { "@orquesta/contracts": "*" } },
  "packages/acquisition": { name: "@orquesta/acquisition", version: "0.4.0-preview.1", dependencies: { "@orquesta/contracts": "*" } },
  "packages/audition": { name: "@orquesta/audition", version: "0.4.0-preview.2", dependencies: { "@orquesta/contracts": "*" } },
  "packages/codex-adapter": { name: "@orquesta/codex-adapter", version: "0.4.0-preview.1", dependencies: { "@openai/codex-sdk": "0.144.5" } },
  "packages/evidence-fabric": { name: "@orquesta/evidence-fabric", version: "0.4.0-preview.1", dependencies: { "@orquesta/contracts": "*" } }
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

test("the approved desktop remains outside the Phase 1 and 2 workspace surface", () => {
  assert.deepEqual(pkg.workspaces, ["apps/workbench", "packages/*"]);
  assert.equal(pkg.scripts["workbench:v4"], "node apps/workbench/server.js --feature v4");
  assert.equal(fs.existsSync(path.join(root, "apps/orquesta-desktop/package.json")), true);
  const rootLock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  assert.equal(Object.hasOwn(rootLock.packages, "apps/orquesta-desktop"), false);
  assert.equal(Object.values(rootLock.packages).some((entry) => entry?.resolved === "apps/orquesta-desktop"), false);
  for (const blocked of [
    "apps/desktop",
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
    assert.equal(manifest.version, expected.version);
    assert.equal(manifest.scripts.test, "node --test");
    assert.deepEqual(manifest.dependencies || {}, expected.dependencies);
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

test("browser driver preflight launches an injected Chrome-family runner and captures a page", async () => {
  const calls = [];
  const probe = await probeBrowserDriver("C:/tool/chrome.exe", {
    loadDriver: () => ({
      chromium: {
        launch: async ({ executablePath, headless }) => {
          calls.push({ executablePath, headless });
          return {
            version: () => "Chrome/137.0.7151.120",
            newPage: async () => ({
              on: () => {},
              setContent: async () => {},
              screenshot: async () => Buffer.from("png"),
            }),
            close: async () => {},
          };
        },
      },
    }),
  });
  assert.equal(probe.ok, true);
  assert.equal(probe.version, "Chrome/137.0.7151.120");
  assert.equal(probe.screenshot_bytes, 3);
  assert.deepEqual(calls, [{ executablePath: "C:/tool/chrome.exe", headless: true }]);

  const unavailable = await probeBrowserDriver("C:/tool/chrome.exe", { loadDriver: () => { throw new Error("missing"); } });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.reason, "driver_unavailable");
});

test("workspace lockfile allows only the pinned review driver outside workspace links", () => {
  const lockfilePath = path.join(root, "package-lock.json");
  assert.equal(fs.existsSync(lockfilePath), true, lockfilePath);
  const lockfile = JSON.parse(fs.readFileSync(lockfilePath, "utf8"));
  const rootEntry = lockfile.packages[""];
  for (const [packagePath, entry] of Object.entries(lockfile.packages || {})) {
    if (Object.hasOwn(entry, "resolved")) {
      assert.equal(isAllowedWorkspaceLink(entry) || isAllowedReviewDependency(packagePath, entry, rootEntry) || isAllowedCodexDependency(packagePath, entry), true, packagePath);
    }
  }
});

test("review dependency gate accepts only exact dev-only playwright-core evidence", () => {
  const rootEntry = { devDependencies: { "playwright-core": "1.61.1" } };
  const valid = {
    version: "1.61.1",
    resolved: "https://registry.npmjs.org/playwright-core/-/playwright-core-1.61.1.tgz",
    integrity: "sha512-evidence",
    dev: true,
  };
  assert.equal(isAllowedReviewDependency("node_modules/playwright-core", valid, rootEntry), true);
  for (const [packagePath, entry, manifest] of [
    ["node_modules/playwright", valid, rootEntry],
    ["node_modules/playwright-core", { ...valid, dev: false }, rootEntry],
    ["node_modules/playwright-core", { ...valid, integrity: "" }, rootEntry],
    ["node_modules/playwright-core", { ...valid, version: "1.61.0" }, rootEntry],
    ["node_modules/playwright-core", { ...valid, resolved: "https://example.invalid/playwright-core.tgz" }, rootEntry],
    ["node_modules/playwright-core", valid, { devDependencies: { "playwright-core": "^1.61.1" } }],
  ]) assert.equal(isAllowedReviewDependency(packagePath, entry, manifest), false, packagePath);
});

test("Codex dependency gate accepts only the pinned SDK runtime set", () => {
  const validSdk = {
    version: "0.144.5",
    resolved: "https://registry.npmjs.org/@openai/codex-sdk/-/codex-sdk-0.144.5.tgz",
    integrity: "sha512-evidence",
  };
  const validPlatform = {
    name: "@openai/codex",
    version: "0.144.5-win32-x64",
    resolved: "https://registry.npmjs.org/@openai/codex/-/codex-0.144.5-win32-x64.tgz",
    integrity: "sha512-evidence",
    optional: true,
    os: ["win32"],
    cpu: ["x64"],
  };
  assert.equal(isAllowedCodexDependency("node_modules/@openai/codex-sdk", validSdk), true);
  assert.equal(isAllowedCodexDependency("node_modules/@openai/codex-win32-x64", validPlatform), true);
  assert.equal(isAllowedCodexDependency("node_modules/@openai/codex-sdk", { ...validSdk, version: "0.145.0" }), false);
  assert.equal(isAllowedCodexDependency("node_modules/@openai/codex-sdk", { ...validSdk, resolved: "https://example.invalid/codex.tgz" }), false);
  assert.equal(isAllowedCodexDependency("node_modules/@openai/codex-win32-x64", { ...validPlatform, optional: false }), false);
  assert.equal(isAllowedCodexDependency("node_modules/unrelated", validSdk), false);
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
