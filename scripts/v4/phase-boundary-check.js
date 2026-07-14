#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const workspacePackages = {
  "apps/workbench": ["@orquesta/core", "@orquesta/event-store"],
  "packages/contracts": [],
  "packages/event-store": ["@orquesta/contracts"],
  "packages/core": ["@orquesta/contracts", "@orquesta/event-store", "@orquesta/capability-compiler", "@orquesta/scouts", "@orquesta/audit", "@orquesta/capability-resolver", "@orquesta/context-compiler"],
  "packages/capability-compiler": ["@orquesta/contracts"],
  "packages/scouts": ["@orquesta/contracts"],
  "packages/audit": ["@orquesta/contracts"],
  "packages/capability-resolver": ["@orquesta/contracts", "@orquesta/audit"],
  "packages/context-compiler": ["@orquesta/contracts"]
};
const forbiddenDirectories = [
  "apps/desktop",
  "packages/codex-adapter",
  "packages/experience",
  "packages/intent-graph",
  "plugins/orquesta"
];

function isSupportedNodeVersion(version = process.version) {
  const major = Number.parseInt(String(version).replace(/^v/, "").split(".")[0], 10);
  return Number.isInteger(major) && major >= 20;
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
  addError(errors, pkg.scripts?.dashboard === "node orquesta/dashboard-server.js", "V3 dashboard command changed.");
  addError(errors, /^node --check orquesta\/dashboard-server\.js/.test(pkg.scripts?.check || ""), "V3 check command changed.");
  addError(errors, JSON.stringify(pkg.workspaces) === JSON.stringify(["apps/*", "packages/*"]), "V4 workspace surface is invalid.");
  addError(errors, pkg.scripts?.["workbench:v4"] === "node apps/workbench/server.js --feature v4", "V4 workbench command is invalid.");
  addError(errors, isSupportedNodeVersion(), `Node ${process.version} is below the required major version 20.`);

  for (const ignoredPath of [".orquesta/", "output/", "node_modules/"]) {
    addError(errors, gitignore.includes(ignoredPath), `${ignoredPath} must be ignored.`);
  }
  for (const relativePath of forbiddenDirectories) {
    addError(errors, !fs.existsSync(path.join(root, relativePath)), `Forbidden Phase 1 directory exists: ${relativePath}`);
  }
  for (const [relativePath, expectedDependencies] of Object.entries(workspacePackages)) {
    const manifestPath = path.join(root, relativePath, "package.json");
    addError(errors, fs.existsSync(manifestPath), `Workspace manifest is missing: ${relativePath}`);
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const dependencies = Object.keys(manifest.dependencies || {}).sort();
    addError(errors, manifest.private === true, `${relativePath} must be private.`);
    addError(errors, manifest.version === "0.4.0-preview.1", `${relativePath} has an invalid version.`);
    addError(errors, manifest.scripts?.test === "node --test", `${relativePath} has an invalid test command.`);
    addError(errors, JSON.stringify(dependencies) === JSON.stringify([...expectedDependencies].sort()), `${relativePath} has an invalid dependency graph.`);
    addError(errors, Object.values(manifest.dependencies || {}).every((version) => version === "*"), `${relativePath} has a non-workspace dependency.`);
  }

  addError(errors, Object.keys(pkg.dependencies || {}).length === 0, "Root package must not have runtime dependencies.");
  addError(errors, Object.keys(pkg.devDependencies || {}).every((name) => name === "playwright-core"), "Root package has an unsupported development dependency.");

  const lockfilePath = path.join(root, "package-lock.json");
  addError(errors, fs.existsSync(lockfilePath), "package-lock.json is missing.");
  if (fs.existsSync(lockfilePath)) {
    const lockfile = JSON.parse(fs.readFileSync(lockfilePath, "utf8"));
    for (const [packagePath, entry] of Object.entries(lockfile.packages || {})) {
      const workspaceLink = entry.link === true && typeof entry.resolved === "string" && !/^https?:/i.test(entry.resolved);
      addError(errors, !Object.hasOwn(entry, "resolved") || workspaceLink, `Lockfile contains a registry artifact: ${packagePath}`);
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

module.exports = { checkBoundary, isSupportedNodeVersion };
