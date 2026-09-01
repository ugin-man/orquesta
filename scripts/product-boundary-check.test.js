"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  DESKTOP_CONTRACT_FILES,
  DESKTOP_CONTRACT_ROOT,
  DESKTOP_GENERATED_FILES,
  RETIRED_DESKTOP_CONTRACT_PATHS,
  RETIRED_LOCAL_CORE_ROOTS,
  RETIRED_LOCAL_CORE_MARKERS,
  WORKSPACE_PATHS,
  hasMaterialPath,
  hasActiveIgnoreRule,
  isAllowedCodexDependency,
  isAllowedWorkspaceLink,
  isSupportedNodeVersion,
  businessRuntimeImportSpecifiers,
  localCoreIntegrationImportSpecifiers,
  localCoreIntegrationViolation,
  desktopContractAuthorityViolation,
  desktopContractAuthorityTargets,
  activeProductionSourceFiles,
  buildRuntimeCopiesCanonicalPolicy,
  retiredLocalCoreImportTargets,
  retiredLocalCoreSemanticMarkers,
  projectionReadBoundaryViolations,
  hasRuntimeJournalAuthority,
  applicationExecutionAuthorityViolations,
  readOnlyProjectPathBoundaryViolations,
  sidecarHostBoundaryViolations,
} = require("./product-boundary-check.js");

const root = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

test("local-core product code is rooted in src and retired Electron roots cannot return", () => {
  assert.equal(
    hasMaterialPath(path.join(root, "apps/orquesta-desktop")),
    false,
    "apps/orquesta-desktop",
  );
  for (const relativePath of RETIRED_LOCAL_CORE_ROOTS) {
    assert.equal(hasMaterialPath(path.join(root, relativePath)), false, relativePath);
  }
  const production = activeProductionSourceFiles();
  assert.ok(production.includes("packages/local-core/src/core/core-runner.ts"));
  assert.ok(production.includes("packages/local-core/src/shared/portable-path.ts"));
  assert.equal(production.some((relativePath) => RETIRED_LOCAL_CORE_ROOTS.some((retiredRoot) => (
    relativePath === retiredRoot || relativePath.startsWith(`${retiredRoot}/`)
  ))), false);
  assert.deepEqual(retiredLocalCoreImportTargets(
    "apps/orquesta-desktop-next/runtime-node/sidecar-entry.ts",
  ), []);
  assert.deepEqual(retiredLocalCoreImportTargets(
    "apps/orquesta-desktop-next/runtime-node/sidecar-entry.ts",
    "import { runDesktopCore } from '../../../packages/local-core/electron/core/core-runner';\n",
  ), ["packages/local-core/electron/core/core-runner"]);
  for (const marker of RETIRED_LOCAL_CORE_MARKERS) {
    assert.deepEqual(retiredLocalCoreSemanticMarkers(
      "packages/local-core/src/core/rogue.ts",
      `export const retired = ${JSON.stringify(marker)};\n`,
    ), [marker]);
  }
  assert.deepEqual(retiredLocalCoreSemanticMarkers(
    "apps/orquesta-desktop-next/src/unrelated.ts",
    `export const ignored = ${JSON.stringify(RETIRED_LOCAL_CORE_MARKERS[0])};\n`,
  ), []);
});

test("desktop manifest, fixtures, generated bindings, and real imports share one authority", () => {
  for (const filename of DESKTOP_CONTRACT_FILES) {
    assert.equal(fs.existsSync(path.join(root, DESKTOP_CONTRACT_ROOT, filename)), true, filename);
  }
  for (const relativePath of RETIRED_DESKTOP_CONTRACT_PATHS) {
    assert.equal(fs.existsSync(path.join(root, relativePath)), false, relativePath);
  }
  for (const relativePath of DESKTOP_GENERATED_FILES) {
    assert.equal(fs.existsSync(path.join(root, relativePath)), true, relativePath);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(root, DESKTOP_CONTRACT_ROOT, "native-bridge-manifest.v1.json"), "utf8"));
  const fixtures = JSON.parse(fs.readFileSync(path.join(root, DESKTOP_CONTRACT_ROOT, "fixtures", "native-bridge-fixtures.v1.json"), "utf8"));
  assert.deepEqual(Object.keys(fixtures.commands).sort(), Object.keys(manifest.commands).sort());
  assert.deepEqual(Object.keys(fixtures.events).sort(), Object.keys(manifest.events).sort());
  assert.deepEqual(desktopContractAuthorityTargets(
    "packages/contracts/src/runtime-method-policy-validator.mjs",
  ), []);
  assert.equal(buildRuntimeCopiesCanonicalPolicy(), true);
});

test("runtime build cannot silently replace the canonical packaged policy source", () => {
  const source = fs.readFileSync(
    path.join(root, "apps/orquesta-desktop-next/scripts/build-runtime.mjs"),
    "utf8",
  );
  assert.equal(buildRuntimeCopiesCanonicalPolicy(
    source.replace("desktopContractPaths.policy", "desktopContractPaths.manifest"),
  ), false);
  assert.equal(buildRuntimeCopiesCanonicalPolicy(
    source.replace("'runtime-method-policy.v1.json'", "'runtime-method-policy-copy.v1.json'"),
  ), false);
});

test("a canonical import cannot coexist with a rogue desktop-contract authority", () => {
  const fake = [
    "import { NATIVE_COMMANDS } from '../../../../../packages/contracts/generated/desktop/native-bridge-contract';",
    "import rogueManifest from '../../../../../packages/contracts/desktop/native-bridge-manifest.v1.json';",
    "export const value = [NATIVE_COMMANDS, rogueManifest];",
    "",
  ].join("\n");
  assert.deepEqual(
    desktopContractAuthorityTargets("apps/orquesta-desktop-next/src/adapters/tauri/native-bridge.ts", fake),
    [
      "packages/contracts/generated/desktop/native-bridge-contract.ts",
      "packages/contracts/desktop/native-bridge-manifest.v1.json",
    ],
  );
  assert.match(
    desktopContractAuthorityViolation("apps/orquesta-desktop-next/src/adapters/tauri/native-bridge.ts", fake),
    /must resolve exactly one canonical authority/u,
  );
});

test("dynamic import cannot hide a second desktop-contract authority", () => {
  const fake = [
    "import { NATIVE_COMMANDS } from '../../../../../packages/contracts/generated/desktop/native-bridge-contract';",
    "export const rogue = import('../../../../../packages/contracts/desktop/fixtures/native-bridge-fixtures.v1.json');",
    "export const value = NATIVE_COMMANDS;",
    "",
  ].join("\n");
  assert.match(
    desktopContractAuthorityViolation("apps/orquesta-desktop-next/src/adapters/tauri/native-bridge.ts", fake),
    /must resolve exactly one canonical authority/u,
  );
});

test("export-from cannot hide a second desktop-contract authority", () => {
  const fake = [
    "import { NATIVE_COMMANDS } from '../../../../../packages/contracts/generated/desktop/native-bridge-contract';",
    "export { default as rogue } from '../../../../../packages/contracts/desktop/native-bridge-manifest.v1.json';",
    "export const value = NATIVE_COMMANDS;",
    "",
  ].join("\n");
  assert.match(
    desktopContractAuthorityViolation("apps/orquesta-desktop-next/src/adapters/tauri/native-bridge.ts", fake),
    /must resolve exactly one canonical authority/u,
  );
});

test("require cannot hide a second desktop-contract authority", () => {
  const fake = [
    "import { NATIVE_COMMANDS } from '../../../../../packages/contracts/generated/desktop/native-bridge-contract';",
    "const rogue = require('../../../../../packages/contracts/desktop/runtime-method-policy.v1.json');",
    "export const value = [NATIVE_COMMANDS, rogue];",
    "",
  ].join("\n");
  assert.match(
    desktopContractAuthorityViolation("apps/orquesta-desktop-next/src/adapters/tauri/native-bridge.ts", fake),
    /must resolve exactly one canonical authority/u,
  );
});

test("a new production source cannot become an unregistered contract consumer", () => {
  const fake = "import manifest from '../../../packages/contracts/desktop/native-bridge-manifest.v1.json';\nexport default manifest;\n";
  assert.match(
    desktopContractAuthorityViolation("apps/orquesta-desktop-next/src/rogue-contract-consumer.ts", fake),
    /Unregistered Desktop source imports contract authority/u,
  );
  const production = activeProductionSourceFiles();
  assert.ok(production.includes("apps/orquesta-desktop-next/src/adapters/tauri/native-bridge.ts"));
  assert.ok(production.includes("apps/orquesta-desktop-next/vite.config.ts"));
  assert.ok(production.includes("packages/local-core/src/contracts/bridge.ts"));
  assert.ok(production.includes("orquesta/runtime/context-v2-runtime.cjs"));
});

test("Desktop config cannot become a rogue contract consumer", () => {
  const fake = "import manifest from '../../packages/contracts/desktop/native-bridge-manifest.v1.json';\nexport default manifest;\n";
  assert.match(
    desktopContractAuthorityViolation("apps/orquesta-desktop-next/vite.config.ts", fake),
    /Unregistered Desktop source imports contract authority/u,
  );
});

test("a package source cannot become a rogue contract consumer", () => {
  const fake = "import manifest from '../../contracts/desktop/native-bridge-manifest.v1.json';\nexport default manifest;\n";
  assert.match(
    desktopContractAuthorityViolation("packages/local-core/src/rogue-contract-consumer.ts", fake),
    /Unregistered Desktop source imports contract authority/u,
  );
});

test("the tracked production runtime bundle cannot import desktop-contract authority", () => {
  const fake = "const manifest = require('../../packages/contracts/desktop/native-bridge-manifest.v1.json');\nmodule.exports = manifest;\n";
  assert.match(
    desktopContractAuthorityViolation("orquesta/runtime/context-v2-runtime.cjs", fake),
    /Unregistered Desktop source imports contract authority/u,
  );
});

test("canonical authority literals cannot bypass the gate through alternate loaders", () => {
  const authority = "../../packages/contracts/desktop/native-bridge-manifest.v1.json";
  for (const [label, fake] of [
    ["module.require", `export const value = module.require('${authority}');\n`],
    ["aliased require", `const r = require;\nexport const value = r('${authority}');\n`],
    ["fs.readFileSync", `import fs from 'node:fs';\nexport const value = fs.readFileSync('${authority}');\n`],
    ["createRequire", `import { createRequire } from 'node:module';\nconst r = createRequire(import.meta.url);\nexport const value = r('${authority}');\n`],
  ]) {
    assert.match(
      desktopContractAuthorityViolation("apps/orquesta-desktop-next/vite.config.ts", fake),
      /Unregistered Desktop source imports contract authority/u,
      label,
    );
  }
});

test("computed module paths fail closed in every production source", () => {
  for (const [relativePath, fake] of [
    [
      "apps/orquesta-desktop-next/vite.config.ts",
      "const target = '../../packages/contracts/desktop/native-bridge-manifest.v1.json';\nexport default import(target);\n",
    ],
    [
      "packages/local-core/src/rogue-contract-consumer.ts",
      "const target = '../../contracts/desktop/native-bridge-manifest.v1.json';\nexport const value = import(target);\n",
    ],
  ]) {
    assert.match(
      desktopContractAuthorityViolation(relativePath, fake),
      /unapproved computed import\/require/u,
      relativePath,
    );
  }
});

test("comments and unrelated ordinary strings are not treated as contract authority", () => {
  const fake = [
    "// require('../../../../packages/contracts/desktop/runtime-method-policy.v1.json');",
    "const pathText = './ordinary-local-value.json';",
    "export { pathText };",
    "",
  ].join("\n");
  assert.deepEqual(
    desktopContractAuthorityTargets("apps/orquesta-desktop-next/src/adapters/tauri-client.ts", fake),
    [],
  );
});

test("distributed launcher imports only its selected product lifecycle modules", () => {
  const launcher = "orquesta/scripts/desktop-launch.js";
  const source = fs.readFileSync(path.join(root, launcher), "utf8");
  assert.equal(desktopContractAuthorityViolation(launcher, source), null);
  for (const fake of [
    source.replace('"build-frontend-generation.mjs"', '"other-module.mjs"'),
    source.replace('api.join(lifecycle.root, "scripts"', 'api.join(process.cwd(), "scripts"'),
    `${source}\nasync function rogue() { return import(process.env.MODULE); }\n`,
  ]) {
    assert.match(desktopContractAuthorityViolation(launcher, fake), /unapproved computed import\/require/u);
  }
  assert.match(desktopContractAuthorityViolation("orquesta/scripts/other.js", source), /unapproved computed import\/require/u);
});

test("central architecture guards reject retired parallel write and read paths", () => {
  const routedCommand = "pub async fn projection_conversation() { crate::projection_bridge::conversation(); }\n";
  const localRead = [
    "pub async fn conversation() {",
    "  let observed = runtime.observed_provider_connection_id().await;",
    "  projection.conversation_for_runtime(&query, generation, observed.as_deref());",
    "}",
  ].join("\n");
  assert.deepEqual(projectionReadBoundaryViolations(routedCommand, localRead), []);
  assert.notDeepEqual(projectionReadBoundaryViolations(
    routedCommand,
    localRead.replace('observed_provider_connection_id', 'current_provider_connection_id'),
  ), []);
  assert.notDeepEqual(projectionReadBoundaryViolations([
    "pub async fn projection_conversation() {",
    "  runtime.call(\"runtime.conversation\", input).await;",
    "}",
  ].join("\n")), []);
  assert.notDeepEqual(projectionReadBoundaryViolations(
    "pub async fn projection_conversation() { crate::projection_bridge::conversation(); }\n",
    [
      "pub async fn conversation() {",
      "  refresh_provider_projection().await;",
      "  projection.conversation(&query);",
      "}",
    ].join("\n"),
  ), []);
  assert.equal(hasRuntimeJournalAuthority(
    "apps/orquesta-desktop-next/runtime-node/sidecar-entry.ts",
    "export function write(store) { const key = 'journal'; return store[key].append({}); }\n",
  ), true);
  assert.notDeepEqual(applicationExecutionAuthorityViolations(
    "export interface ApplicationState { activeTurns: Record<string, unknown>; }\n",
    "export function view(state) { return state.activeTurns; }\n",
  ), []);
  assert.notDeepEqual(readOnlyProjectPathBoundaryViolations(
    [
      "repository.selectUninitialized(sanitizedRepositoryRequest);",
      "} else if (request.type === 'repository.get-snapshot') { writerLeases.add(root);",
      "} else if (request.type === 'business.work-orders.read') { }",
    ].join("\n"),
    "pub async fn project_open_folder_read_only() { state.runtime.authority().await; registry.select(); }\n",
  ), []);
  const sidecarSource = fs.readFileSync(
    path.join(root, "apps/orquesta-desktop-next/runtime-node/sidecar-entry.ts"),
    "utf8",
  );
  assert.deepEqual(sidecarHostBoundaryViolations(sidecarSource.replace(
    "const runtimeDirectory = requiredAbsoluteEnvironmentPath('ORQUESTA_NEXT_RUNTIME_DIST');",
    "const runtimeDirectory = process.cwd();",
  )), ["Desktop sidecar must use only the two Native-issued packaged path authorities."]);
  assert.deepEqual(sidecarHostBoundaryViolations(sidecarSource.replace(
    "inbound({ ...params, type: request.method, correlationId });",
    "inbound({ data: { ...params, type: request.method, correlationId } });",
  )), ["Desktop sidecar must deliver raw Core requests, never Electron envelopes."]);
  assert.deepEqual(sidecarHostBoundaryViolations(sidecarSource.replace(
    "runtimeGeneration !== nativeRuntimeGeneration",
    "runtimeGeneration === nativeRuntimeGeneration",
  )), [
    "Projection ingest binding must remain an internal Native-issued authority before policy dispatch.",
  ]);
  const projectionStart = sidecarSource.indexOf("  if (request.method === 'projection.ingest.bind'");
  const policyStart = sidecarSource.indexOf("  const method = Object.hasOwn(policy.methods, request.method)", projectionStart);
  const policyEnd = sidecarSource.indexOf(";\n", policyStart) + 2;
  const reorderedSidecar = sidecarSource.slice(0, projectionStart)
    + sidecarSource.slice(policyStart, policyEnd)
    + sidecarSource.slice(projectionStart, policyStart)
    + sidecarSource.slice(policyEnd);
  assert.deepEqual(sidecarHostBoundaryViolations(reorderedSidecar), [
    "Projection ingest binding must remain an internal Native-issued authority before policy dispatch.",
  ]);
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
  assert.equal(isAllowedCodexDependency("node_modules/unrelated", validSdk), false);
});

test("lockfile links accept only declared package workspaces", () => {
  assert.equal(isAllowedWorkspaceLink({ link: true, resolved: "packages/contracts" }), true);
  assert.equal(
    isAllowedWorkspaceLink({ link: true, resolved: "packages/business-orchestrator" }),
    true,
  );
  for (const entry of [
    { link: true, resolved: "apps/workbench" },
    { link: true, resolved: "C:/outside/contracts" },
    { link: true, resolved: "../packages/contracts" },
    { link: true, resolved: "https://registry.example/contracts.tgz" },
    { link: false, resolved: "packages/contracts" },
  ]) assert.equal(isAllowedWorkspaceLink(entry), false, JSON.stringify(entry));
});

test("ignore rules require active exact lines", () => {
  const rules = ".orquesta/\noutput/\nnode_modules/\n";
  for (const rule of [".orquesta/", "output/", "node_modules/"]) {
    assert.equal(hasActiveIgnoreRule(rules, rule), true);
    assert.equal(hasActiveIgnoreRule(`# ${rule}\n!${rule}\n`, rule), false);
  }
});

test("boundary check rejects unsupported Node versions", () => {
  assert.equal(isSupportedNodeVersion("v20.0.0"), true);
  assert.equal(isSupportedNodeVersion("v19.99.0"), false);
});

test("Business integration remains confined to its owned runtime boundary", () => {
  assert.deepEqual(
    businessRuntimeImportSpecifiers('const value = require("@orquesta/contracts");'),
    [],
  );
  assert.deepEqual(
    businessRuntimeImportSpecifiers(
      'const business = require("@orquesta/business-orchestrator");',
    ),
    ["@orquesta/business-orchestrator"],
  );
  assert.deepEqual(
    businessRuntimeImportSpecifiers(
      'import engine from "../../business-orchestrator/src/state-machine.js";',
    ),
    ["../../business-orchestrator/src/state-machine.js"],
  );
  assert.equal(
    localCoreIntegrationViolation(
      "packages/local-core/src/core/business-work-order-runtime.ts",
      'import business from "@orquesta/business-orchestrator";\nimport store from "@orquesta/event-store";',
    ),
    null,
  );
  assert.match(
    localCoreIntegrationViolation(
      "packages/local-core/src/core/business-work-order-runtime.ts",
      'import business from "@orquesta/business-orchestrator/src/index.js";\nimport store from "@orquesta/event-store";',
    ),
    /must import both public package entries exactly once/u,
  );
  assert.match(
    localCoreIntegrationViolation(
      "packages/local-core/src/core/rogue.ts",
      'import business from "@orquesta/business-orchestrator";',
    ),
    /escaped the single Local Core seam/u,
  );
  assert.match(
    localCoreIntegrationViolation(
      "packages/local-core/src/core/rogue.ts",
      'import store from "../../../../node_modules/@orquesta/event-store";',
    ),
    /escaped the single Local Core seam/u,
  );
  assert.deepEqual(
    localCoreIntegrationImportSpecifiers('import value from "@orquesta/contracts";'),
    [],
  );
});
