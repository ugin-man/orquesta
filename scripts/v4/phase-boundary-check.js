#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const V3_DASHBOARD_BASELINE = "node orquesta/dashboard-server.js";
const V3_CHECK_BASELINE = [
  "node --check orquesta/dashboard-server.js",
  "node --check orquesta/assets/dashboard/app.js",
  "node --check orquesta/scripts/dashboard-dom-smoke.js",
  "node --check orquesta/scripts/validate-state-encoding.js",
  "node --check orquesta/scripts/dashboard-port-selection.js",
  "node --check orquesta/scripts/dashboard-port-selection.test.js",
  "node --check orquesta/scripts/dashboard-state-cache.js",
  "node --check orquesta/scripts/dashboard-state-cache.test.js",
  "node --check orquesta/scripts/foundation-trigger-audit.js",
  "node --check orquesta/scripts/foundation-trigger-audit.test.js",
  "node --check orquesta/scripts/incident-intake.js",
  "node --check orquesta/scripts/incident-intake.test.js",
  "node --check orquesta/scripts/model-policy.js",
  "node --check orquesta/scripts/model-policy.test.js",
  "node --check orquesta/scripts/delegation-gate-check.js",
  "node --check orquesta/scripts/delegation-gate-check.test.js",
  "node --check orquesta/scripts/approval-wait-check.js",
  "node --check orquesta/scripts/approval-wait-check.test.js",
  "node --check orquesta/scripts/report-question-candidates-check.js",
  "node --check orquesta/scripts/report-question-candidates-check.test.js",
  "node --check orquesta/scripts/json-state.js",
  "node --check orquesta/scripts/json-state.test.js",
  "node --check orquesta/scripts/beta-v3-state-init.js",
  "node --check orquesta/scripts/beta-v3-state-init.test.js",
  "node --check orquesta/scripts/control-integration.test.js",
  "node --check orquesta/scripts/completion-envelope-check.js",
  "node --check orquesta/scripts/completion-envelope-check.test.js",
  "node --check orquesta/scripts/capacity-gate.js",
  "node --check orquesta/scripts/capacity-gate.test.js",
  "node --check orquesta/scripts/control-audit.js",
  "node --check orquesta/scripts/control-audit.test.js",
  "node --check orquesta/scripts/dashboard-report-review.test.js",
  "npm run test:ports",
  "npm run test:cache",
  "npm run test:triggers",
  "npm run test:incident-intake",
  "npm run test:model-policy",
  "npm run test:delegation",
  "npm run test:approval",
  "npm run test:question-candidates",
  "npm run test:json-state",
  "npm run test:beta-v3-state",
  "npm run test:control-integration",
  "npm run test:completion-envelope",
  "npm run test:capacity",
  "npm run test:control-audit",
  "npm run test:report-review",
  "npm run check:encoding"
].join(" && ");
const workspacePackages = {
  "apps/workbench": { version: "0.4.0-preview.1", dependencies: { "@orquesta/core": "*", "@orquesta/event-store": "*" } },
  "packages/contracts": { version: "0.4.0-preview.1", dependencies: {} },
  "packages/event-store": { version: "0.4.0-preview.1", dependencies: { "@orquesta/contracts": "*" } },
  "packages/core": { version: "0.4.0-preview.1", dependencies: { "@orquesta/contracts": "*", "@orquesta/event-store": "*", "@orquesta/capability-compiler": "*", "@orquesta/scouts": "*", "@orquesta/audit": "*", "@orquesta/capability-resolver": "*", "@orquesta/context-compiler": "*", "@orquesta/evidence-fabric": "*" } },
  "packages/capability-compiler": { version: "0.4.0-preview.1", dependencies: { "@orquesta/contracts": "*" } },
  "packages/scouts": { version: "0.4.0-preview.1", dependencies: { "@orquesta/contracts": "*" } },
  "packages/audit": { version: "0.4.0-preview.1", dependencies: { "@orquesta/contracts": "*" } },
  "packages/capability-resolver": { version: "0.4.0-preview.1", dependencies: { "@orquesta/contracts": "*", "@orquesta/audit": "*" } },
  "packages/context-compiler": { version: "0.4.0-preview.1", dependencies: { "@orquesta/contracts": "*" } },
  "packages/acquisition": { version: "0.4.0-preview.1", dependencies: { "@orquesta/contracts": "*" } },
  "packages/audition": { version: "0.4.0-preview.2", dependencies: { "@orquesta/contracts": "*" } },
  "packages/codex-adapter": { version: "0.4.0-preview.1", dependencies: { "@openai/codex-sdk": "0.144.5" } },
  "packages/evidence-fabric": { version: "0.4.0-preview.1", dependencies: { "@orquesta/contracts": "*" } }
};
const forbiddenDirectories = [
  "apps/desktop",
  "packages/experience",
  "packages/intent-graph",
  "plugins/orquesta"
];

function isSupportedNodeVersion(version = process.version) {
  const major = Number.parseInt(String(version).replace(/^v/, "").split(".")[0], 10);
  return Number.isInteger(major) && major >= 20;
}

function hasV3Baseline(scripts = {}) {
  return scripts.dashboard === V3_DASHBOARD_BASELINE && scripts.check === V3_CHECK_BASELINE;
}

function hasActiveIgnoreRule(content, expectedRule) {
  let active = false;
  for (const rawLine of String(content || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line === expectedRule) active = true;
    if (line === `!${expectedRule}`) active = false;
  }
  return active;
}

function isAllowedWorkspaceLink(entry) {
  if (!entry || entry.link !== true || typeof entry.resolved !== "string") return false;
  const normalized = entry.resolved.replace(/\\/g, "/");
  if (/^[a-z][a-z0-9+.-]*:/i.test(normalized) || normalized.startsWith("/")) return false;
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return false;
  return Object.hasOwn(workspacePackages, normalized);
}

function isAllowedReviewDependency(packagePath, entry, rootManifest = {}) {
  if (packagePath !== "node_modules/playwright-core" || !entry || entry.dev !== true) return false;
  if (typeof entry.version !== "string" || rootManifest.devDependencies?.["playwright-core"] !== entry.version) return false;
  if (typeof entry.integrity !== "string" || !entry.integrity.startsWith("sha512-") || entry.integrity.length <= "sha512-".length) return false;
  return entry.resolved === `https://registry.npmjs.org/playwright-core/-/playwright-core-${entry.version}.tgz`;
}

function hasRegistryIntegrity(entry) {
  return typeof entry?.integrity === "string" && entry.integrity.startsWith("sha512-") && entry.integrity.length > "sha512-".length;
}

function isAllowedCodexDependency(packagePath, entry) {
  const version = "0.144.5";
  if (!entry || !hasRegistryIntegrity(entry)) return false;
  if (packagePath === "node_modules/@openai/codex-sdk") {
    return entry.version === version
      && entry.resolved === `https://registry.npmjs.org/@openai/codex-sdk/-/codex-sdk-${version}.tgz`
      && entry.optional !== true;
  }
  if (packagePath === "node_modules/@openai/codex") {
    return entry.version === version
      && entry.resolved === `https://registry.npmjs.org/@openai/codex/-/codex-${version}.tgz`
      && entry.optional !== true;
  }
  const platforms = {
    "darwin-arm64": { os: "darwin", cpu: "arm64" },
    "darwin-x64": { os: "darwin", cpu: "x64" },
    "linux-arm64": { os: "linux", cpu: "arm64" },
    "linux-x64": { os: "linux", cpu: "x64" },
    "win32-arm64": { os: "win32", cpu: "arm64" },
    "win32-x64": { os: "win32", cpu: "x64" },
  };
  const prefix = "node_modules/@openai/codex-";
  if (!packagePath.startsWith(prefix)) return false;
  const platform = packagePath.slice(prefix.length);
  const expected = platforms[platform];
  return Boolean(expected)
    && entry.name === "@openai/codex"
    && entry.version === `${version}-${platform}`
    && entry.resolved === `https://registry.npmjs.org/@openai/codex/-/codex-${version}-${platform}.tgz`
    && entry.optional === true
    && JSON.stringify(entry.os) === JSON.stringify([expected.os])
    && JSON.stringify(entry.cpu) === JSON.stringify([expected.cpu]);
}

function normalizeObject(value = {}) {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function addError(errors, condition, message) {
  if (!condition) errors.push(message);
}

function checkBoundary() {
  const errors = [];
  const pkg = readJson("package.json");
  const gitignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");

  addError(errors, pkg.private === false, "Root package must remain private: false.");
  addError(errors, hasV3Baseline(pkg.scripts), "V3 dashboard or check command changed.");
  addError(errors, JSON.stringify(pkg.workspaces) === JSON.stringify(["apps/*", "packages/*"]), "V4 workspace surface is invalid.");
  addError(errors, pkg.scripts?.["workbench:v4"] === "node apps/workbench/server.js --feature v4", "V4 workbench command is invalid.");
  addError(errors, isSupportedNodeVersion(), `Node ${process.version} is below the required major version 20.`);

  for (const ignoredPath of [".orquesta/", "output/", "node_modules/"]) {
    addError(errors, hasActiveIgnoreRule(gitignore, ignoredPath), `${ignoredPath} must be ignored.`);
  }
  for (const relativePath of forbiddenDirectories) {
    addError(errors, !fs.existsSync(path.join(root, relativePath)), `Forbidden Phase 1 directory exists: ${relativePath}`);
  }
  for (const [relativePath, expected] of Object.entries(workspacePackages)) {
    const manifestPath = path.join(root, relativePath, "package.json");
    addError(errors, fs.existsSync(manifestPath), `Workspace manifest is missing: ${relativePath}`);
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    addError(errors, manifest.private === true, `${relativePath} must be private.`);
    addError(errors, manifest.version === expected.version, `${relativePath} has an invalid version.`);
    addError(errors, manifest.scripts?.test === "node --test", `${relativePath} has an invalid test command.`);
    addError(errors, JSON.stringify(normalizeObject(manifest.dependencies)) === JSON.stringify(normalizeObject(expected.dependencies)), `${relativePath} has an invalid dependency graph.`);
  }

  addError(errors, Object.keys(pkg.dependencies || {}).length === 0, "Root package must not have runtime dependencies.");
  addError(errors, Object.keys(pkg.devDependencies || {}).every((name) => name === "playwright-core"), "Root package has an unsupported development dependency.");

  const lockfilePath = path.join(root, "package-lock.json");
  addError(errors, fs.existsSync(lockfilePath), "package-lock.json is missing.");
  if (fs.existsSync(lockfilePath)) {
    const lockfile = JSON.parse(fs.readFileSync(lockfilePath, "utf8"));
    for (const [packagePath, entry] of Object.entries(lockfile.packages || {})) {
      addError(
        errors,
        !Object.hasOwn(entry, "resolved") || isAllowedWorkspaceLink(entry) || isAllowedReviewDependency(packagePath, entry, pkg) || isAllowedCodexDependency(packagePath, entry),
        `Lockfile contains an unsupported registry artifact: ${packagePath}`,
      );
    }
  }

  return errors;
}

function main() {
  const errors = checkBoundary();
  if (errors.length) {
    console.error("Orquesta V4 Phase 1 boundary check failed:");
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log("Orquesta V4 Phase 1 boundary check passed");
}

if (require.main === module) main();

module.exports = {
  V3_DASHBOARD_BASELINE,
  V3_CHECK_BASELINE,
  checkBoundary,
  hasActiveIgnoreRule,
  hasV3Baseline,
  isAllowedCodexDependency,
  isAllowedReviewDependency,
  isAllowedWorkspaceLink,
  isSupportedNodeVersion
};
