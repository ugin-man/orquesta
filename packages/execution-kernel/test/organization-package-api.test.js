"use strict";

const assert = require("node:assert/strict");
const { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");
const test = require("node:test");

const packageManifest = require("../package.json");
const kernel = require("../src");
const contracts = require("@orquesta/contracts");

function copyTreeFiles(source, target) {
  mkdirSync(target, { recursive: true });
  for (const name of readdirSync(source)) {
    const sourcePath = path.join(source, name);
    const targetPath = path.join(target, name);
    if (statSync(sourcePath).isDirectory()) copyTreeFiles(sourcePath, targetPath);
    else copyFileSync(sourcePath, targetPath);
  }
}

test("Organization v3 is a portable execution-kernel package API", () => {
  assert.equal(packageManifest.dependencies["@orquesta/contracts"], "*");
  for (const name of [
    "applyOrganizationControllerCommand",
    "classifyFoundationBootstrapV3",
    "createOrganizationV3Store",
    "createFoundationOrganizationV3Bundle",
    "createOrganizationV3Bundle",
    "organizationV3HeadHash",
    "runFoundationBootstrapV3",
    "runPersistentAgentPlacement",
    "validateOrganizationV3Bundle"
  ]) {
    assert.equal(typeof kernel[name], "function", `${name} must be exported by @orquesta/execution-kernel`);
  }
  assert.equal(kernel.createOrganizationControllerCommand, undefined, "generic controller command construction must stay internal");
  assert.equal(kernel.migrateOrganizationV2ToV3, undefined, "v2 assessment must not be part of the live package API");
  assert.equal(kernel.assessOrganizationV2ForV3, undefined, "read-only v2 assessment must remain outside the live package API");
  assert.deepEqual(kernel.FOUNDATION_AGENT_IDS, ["orchestrator", "orquesta-admin", "user-support"]);
  assert.strictEqual(kernel.FOUNDATION_AGENT_IDS, contracts.FOUNDATION_AGENT_IDS, "foundation ids must have one contracts authority");
  assert.deepEqual(
    kernel.createFoundationOrganizationV3Bundle({ createdAt: "2026-08-24T00:00:00.000Z" }).agentRegistry.agents.map(({ lifecycle_state }) => lifecycle_state),
    ["provisioning", "provisioning", "provisioning"]
  );
});

test("Organization v3 resolves its declared contracts dependency outside the source workspace", () => {
  const root = mkdtempSync(path.join(tmpdir(), "orquesta-organization-api-"));
  try {
    const scope = path.join(root, "node_modules", "@orquesta");
    const kernelTarget = path.join(scope, "execution-kernel");
    const contractsTarget = path.join(scope, "contracts");
    mkdirSync(scope, { recursive: true });
    copyTreeFiles(path.join(__dirname, "..", "src"), path.join(kernelTarget, "src"));
    copyFileSync(path.join(__dirname, "..", "package.json"), path.join(kernelTarget, "package.json"));
    copyTreeFiles(path.join(__dirname, "..", "..", "contracts", "src"), path.join(contractsTarget, "src"));
    copyTreeFiles(path.join(__dirname, "..", "..", "contracts", "schemas"), path.join(contractsTarget, "schemas"));
    copyFileSync(path.join(__dirname, "..", "..", "contracts", "package.json"), path.join(contractsTarget, "package.json"));
    const isolatedRequire = createRequire(path.join(root, "probe.cjs"));
    const portableKernel = isolatedRequire("@orquesta/execution-kernel/src/organization-v3.js");
    const foundation = portableKernel.createFoundationOrganizationV3Bundle({ createdAt: "2026-08-24T00:00:00.000Z" });
    assert.equal(portableKernel.validateOrganizationV3Bundle(foundation).ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
