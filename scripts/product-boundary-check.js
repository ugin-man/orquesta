#!/usr/bin/env node

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const workspacePackages = {
  "packages/contracts": { version: "0.5.0-next.0", dependencies: {} },
  "packages/event-store": { version: "0.5.0-next.0", dependencies: { "@orquesta/contracts": "*" } },
  "packages/business-orchestrator": { version: "0.5.0-preview.0", dependencies: { "@orquesta/contracts": "*" } },
  "packages/codex-adapter": { version: "0.5.0-next.0", dependencies: { "@openai/codex-sdk": "0.144.5" } },
  "packages/context-compiler": { version: "0.5.0-next.0", dependencies: { "@orquesta/contracts": "*" } },
  "packages/execution-kernel": { version: "0.5.0-next.0", dependencies: { "@orquesta/codex-adapter": "*", "@orquesta/contracts": "*" } },
  "packages/project-structure": { version: "0.5.0-next.0", dependencies: { "@orquesta/contracts": "*" } },
  "packages/local-core": {
    version: "0.5.0-next.0",
    dependencies: {
      "@openai/codex-sdk": "0.144.5",
      "@orquesta/business-orchestrator": "file:../business-orchestrator",
      "@orquesta/codex-adapter": "file:../codex-adapter",
      "@orquesta/contracts": "file:../contracts",
      "@orquesta/event-store": "file:../event-store",
      "@orquesta/execution-kernel": "file:../execution-kernel",
    },
  },
};
const WORKSPACE_PATHS = Object.freeze(Object.keys(workspacePackages).sort());
const DESKTOP_CONTRACT_ROOT = "packages/contracts/desktop";
const DESKTOP_CONTRACT_FILES = Object.freeze([
  "native-bridge-manifest.v1.json",
  "fixtures/native-bridge-fixtures.v1.json",
  "runtime-method-policy.v1.json",
]);
const DESKTOP_GENERATED_FILES = Object.freeze([
  "packages/contracts/generated/desktop/native_bridge_contract.rs",
  "packages/contracts/generated/desktop/native_bridge_handler.rs",
  "packages/contracts/generated/desktop/native-bridge-contract.ts",
]);
const RETIRED_DESKTOP_CONTRACT_PATHS = Object.freeze([
  "apps/orquesta-desktop-next/runtime-node/native-bridge-contract.v1.json",
  "apps/orquesta-desktop-next/runtime-node/runtime-method-policy.v1.json",
  "packages/contracts/desktop/native-bridge-contract.v1.json",
  "packages/contracts/schemas/desktop/native-bridge-contract.v1.json",
  "packages/contracts/schemas/desktop/runtime-method-policy.v1.json",
]);
const RETIRED_LOCAL_CORE_ROOTS = Object.freeze([
  "packages/local-core/electron/core",
  "packages/local-core/electron/shared",
]);
const RETIRED_LOCAL_CORE_MARKERS = Object.freeze([
  "ORQUESTA_EXECUTION_KERNEL_SHADOW_V2",
  "DesktopExecutionShadowController",
  "execution-kernel-shadow-v2.json",
  "process.parentPort",
  "ELECTRON_RUN_AS_NODE",
]);
const DESKTOP_CONTRACT_CONSUMERS = Object.freeze({
  "apps/orquesta-desktop-next/src/adapters/tauri/native-bridge.ts": "packages/contracts/generated/desktop/native-bridge-contract.ts",
  "apps/orquesta-desktop-next/src/domain/validation.ts": "packages/contracts/generated/desktop/native-bridge-contract.ts",
  "apps/orquesta-desktop-next/runtime-node/sidecar-entry.ts": "apps/orquesta-desktop-next/runtime-node/method-policy.mjs",
  "apps/orquesta-desktop-next/runtime-node/method-policy.mjs": "packages/contracts/src/runtime-method-policy-validator.mjs",
  "apps/orquesta-desktop-next/scripts/build-runtime.mjs": "packages/contracts/scripts/generate-desktop-bindings.mjs",
  "apps/orquesta-desktop-next/scripts/build-frontend-generation.mjs": "packages/contracts/scripts/generate-desktop-bindings.mjs",
  "apps/orquesta-desktop-next/scripts/run-desktop-lifecycle.mjs": "packages/contracts/scripts/generate-desktop-bindings.mjs",
  "packages/local-core/src/core/attachment-capability-broker.ts": "packages/contracts/generated/desktop/native-bridge-contract.ts",
  "packages/local-core/src/core/protocol.ts": "packages/contracts/generated/desktop/native-bridge-contract.ts",
});
const DESKTOP_CONTRACT_INTERNAL_CONSUMERS = Object.freeze({
  "packages/contracts/scripts/generate-desktop-bindings.mjs": "packages/contracts/src/runtime-method-policy-validator.mjs",
});
const DESKTOP_CONTRACT_ALLOWED_IMPORTS = Object.freeze({
  ...DESKTOP_CONTRACT_CONSUMERS,
  ...DESKTOP_CONTRACT_INTERNAL_CONSUMERS,
});
const ACTIVE_PRODUCTION_ROOTS = Object.freeze([
  "apps/orquesta-desktop-next",
  "packages",
  "orquesta/runtime",
  "orquesta/scripts",
  "scripts",
]);
const parsedModuleCache = new Map();

const REMOVED_BROWSER_PATHS = Object.freeze([
  "apps/workbench",
  "orquesta/assets/dashboard",
  "orquesta/dashboard-server.js",
  "orquesta/scripts/dashboard-dom-smoke.js",
  "orquesta/scripts/dashboard-port-selection.js",
  "orquesta/scripts/dashboard-port-selection.test.js",
  "orquesta/scripts/dashboard-report-review.test.js",
  "orquesta/scripts/dashboard-state-cache.js",
  "orquesta/scripts/dashboard-state-cache.test.js",
  "orquesta/scripts/current-orchestra.js",
  "scripts/v4/browser-preflight.js",
  "scripts/v4/verify-phase1.js",
]);

const REMOVED_BROWSER_SCRIPTS = Object.freeze([
  "dashboard",
  "workbench:v4",
  "review:v4:phase1",
  "smoke:dashboard",
  "test:ports",
  "test:cache",
  "test:report-review",
]);

const RETIRED_AUTHORITY_PATHS = Object.freeze([
  ".orquesta/product-authority.json",
]);

const forbiddenDirectories = [
  "apps/desktop",
  "apps/orquesta-desktop",
  "packages/experience",
  "packages/intent-graph",
  "plugins/orquesta",
];

function isSupportedNodeVersion(version = process.version) {
  const major = Number.parseInt(String(version).replace(/^v/, "").split(".")[0], 10);
  return Number.isInteger(major) && major >= 20;
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

function isAllowedRegistryArtifact(packagePath, entry) {
  if (isAllowedWorkspaceLink(entry)) return true;
  if (!Object.hasOwn(entry || {}, "resolved")) return true;
  if (packagePath === "node_modules/@openai/codex-sdk"
      || packagePath === "node_modules/@openai/codex"
      || packagePath.startsWith("node_modules/@openai/codex-")) {
    return isAllowedCodexDependency(packagePath, entry);
  }
  return typeof entry.resolved === "string"
    && entry.resolved.startsWith("https://registry.npmjs.org/")
    && hasRegistryIntegrity(entry);
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

function hasMaterialPath(targetPath) {
  if (!fs.existsSync(targetPath)) return false;
  const info = fs.lstatSync(targetPath);
  if (!info.isDirectory()) return true;
  return fs.readdirSync(targetPath).some((entry) => hasMaterialPath(path.join(targetPath, entry)));
}

function workspacePackageImportRecords(relativePath, content, packageNames) {
  const loads = parsedModuleLoads(relativePath, content);
  return loads.specifiers.flatMap((rawSpecifier) => {
    const specifier = rawSpecifier.replace(/\\/g, "/");
    const resolvedTargets = resolvedModuleTargets(loads.containingFile, [rawSpecifier]);
    const packageName = packageNames.find((candidate) => (
      specifier === `@orquesta/${candidate}`
      || specifier.startsWith(`@orquesta/${candidate}/`)
      || resolvedTargets.some((target) => (
        target === `packages/${candidate}`
        || target.startsWith(`packages/${candidate}/`)
      ))
    ));
    return packageName ? [{ specifier, packageName }] : [];
  });
}

function businessRuntimeImportSpecifiers(
  content,
  relativePath = "packages/execution-kernel/src/__product-boundary-probe.js",
) {
  return workspacePackageImportRecords(relativePath, content, ["business-orchestrator"])
    .map(({ specifier }) => specifier);
}

function localCoreIntegrationImportSpecifiers(
  content,
  relativePath = "packages/local-core/src/core/business-work-order-runtime.ts",
) {
  return workspacePackageImportRecords(
    relativePath,
    content,
    ["business-orchestrator", "event-store"],
  ).map(({ specifier }) => specifier);
}

function localCoreIntegrationViolation(relativePath, content) {
  const imports = localCoreIntegrationImportSpecifiers(content, relativePath);
  const allowedPath = "packages/local-core/src/core/business-work-order-runtime.ts";
  const allowedImports = [
    "@orquesta/business-orchestrator",
    "@orquesta/event-store",
  ];
  if (relativePath === allowedPath) {
    return JSON.stringify([...imports].sort()) === JSON.stringify(allowedImports)
      ? null
      : `Local Core Business seam must import both public package entries exactly once; found [${imports.join(", ")}]: ${relativePath}`;
  }
  return imports.length === 0
    ? null
    : `Business/Event Store integration escaped the single Local Core seam [${imports.join(", ")}]: ${relativePath}`;
}

function runtimeFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...runtimeFiles(target));
    else if (/\.(?:cjs|js|mjs)$/u.test(entry.name)
        && !/\.test\.(?:cjs|js|mjs)$/u.test(entry.name)) files.push(target);
  }
  return files;
}

function parsedModuleLoads(relativePath, sourceOverride) {
  if (sourceOverride === undefined && parsedModuleCache.has(relativePath)) {
    return parsedModuleCache.get(relativePath);
  }
  const containingFile = path.join(root, relativePath);
  const source = sourceOverride === undefined
    ? fs.readFileSync(containingFile, "utf8")
    : String(sourceOverride);
  const scriptKind = /\.tsx$/iu.test(relativePath)
    ? ts.ScriptKind.TSX
    : /\.jsx$/iu.test(relativePath)
      ? ts.ScriptKind.JSX
      : /\.[cm]?js$/iu.test(relativePath)
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(containingFile, source, ts.ScriptTarget.ESNext, true, scriptKind);
  const specifiers = [];
  const stringLiterals = [];
  const nonLiteralLoads = [];

  function addLiteral(node) {
    if (node && ts.isStringLiteralLike(node)) specifiers.push(node.text);
  }

  function enclosingFunctionName(node) {
    for (let current = node.parent; current; current = current.parent) {
      if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
      if ((ts.isFunctionExpression(current) || ts.isArrowFunction(current))
          && ts.isVariableDeclaration(current.parent)
          && ts.isIdentifier(current.parent.name)) return current.parent.name.text;
    }
    return null;
  }

  function selectedLifecycleModule(node) {
    if (!node || !ts.isPropertyAccessExpression(node) || node.name.text !== "href") return null;
    const url = node.expression;
    if (!ts.isCallExpression(url) || !ts.isIdentifier(url.expression)
      || url.expression.text !== "pathToFileURL" || url.arguments.length !== 1) return null;
    const joined = url.arguments[0];
    if (!ts.isCallExpression(joined) || !ts.isPropertyAccessExpression(joined.expression)
      || joined.expression.name.text !== "join" || !ts.isIdentifier(joined.expression.expression)
      || !["api", "path"].includes(joined.expression.expression.text)
      || joined.arguments.length !== 3) return null;
    const [base, directory, filename] = joined.arguments;
    if (!ts.isPropertyAccessExpression(base) || !ts.isIdentifier(base.expression)
      || base.expression.text !== "lifecycle" || base.name.text !== "root"
      || !ts.isStringLiteralLike(directory) || !ts.isStringLiteralLike(filename)) return null;
    return `${directory.text}/${filename.text}`;
  }

  function visit(node) {
    if (ts.isStringLiteralLike(node)) stringLiterals.push(node.text);
    if (ts.isImportDeclaration(node)) {
      addLiteral(node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      addLiteral(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node)
        && ts.isExternalModuleReference(node.moduleReference)) {
      addLiteral(node.moduleReference.expression);
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (isDynamicImport || isRequire) {
        if (node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0])) {
          specifiers.push(node.arguments[0].text);
        } else {
          const argument = node.arguments.length === 1 && ts.isIdentifier(node.arguments[0])
            ? node.arguments[0].text
            : null;
          const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          nonLiteralLoads.push({
            kind: isDynamicImport ? "import" : "require",
            argument,
            functionName: enclosingFunctionName(node),
            lifecycleModule: node.arguments.length === 1 ? selectedLifecycleModule(node.arguments[0]) : null,
            line: location.line + 1,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  const result = { containingFile, sourceFile, specifiers, stringLiterals, nonLiteralLoads };
  if (sourceOverride === undefined) parsedModuleCache.set(relativePath, result);
  return result;
}

function resolvedModuleTargets(containingFile, specifiers) {
  const compilerOptions = {
    allowJs: true,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    resolveJsonModule: true,
    target: ts.ScriptTarget.ES2022,
  };
  const targets = [];
  for (const specifier of specifiers) {
    const resolved = ts.resolveModuleName(
      specifier,
      containingFile,
      compilerOptions,
      ts.sys,
    ).resolvedModule;
    if (!resolved) continue;
    const canonicalTarget = fs.existsSync(resolved.resolvedFileName)
      ? fs.realpathSync.native(resolved.resolvedFileName)
      : resolved.resolvedFileName;
    targets.push(path.relative(root, canonicalTarget).replace(/\\/g, "/"));
  }
  return targets;
}

function retiredLocalCoreImportTargets(relativePath, sourceOverride) {
  const loads = parsedModuleLoads(relativePath, sourceOverride);
  const targets = [];
  for (const specifier of loads.specifiers) {
    if (!specifier.startsWith(".") && !path.isAbsolute(specifier)) continue;
    const literalPath = specifier.split(/[?#]/u, 1)[0];
    const target = path.relative(
      root,
      path.resolve(path.dirname(loads.containingFile), literalPath),
    ).replace(/\\/g, "/");
    const normalizedTarget = target.toLowerCase();
    if (RETIRED_LOCAL_CORE_ROOTS.some((retiredRoot) => (
      normalizedTarget === retiredRoot
      || normalizedTarget.startsWith(`${retiredRoot}/`)
    ))) targets.push(target);
  }
  return [...new Set(targets)].sort();
}

function isDesktopContractAuthorityTarget(target) {
  return target.startsWith("packages/contracts/desktop/")
    || target.startsWith("packages/contracts/generated/desktop/")
    || target === "apps/orquesta-desktop-next/runtime-node/method-policy.mjs"
    || target === "packages/contracts/src/runtime-method-policy-validator.mjs"
    || target === "packages/contracts/scripts/generate-desktop-bindings.mjs";
}

function desktopContractAuthorityTargets(relativePath, sourceOverride) {
  const loads = parsedModuleLoads(relativePath, sourceOverride);
  const possibleAuthorityLiterals = loads.stringLiterals.filter((literal) => (
    /(?:contracts|method-policy)/iu.test(literal)
  ));
  return resolvedModuleTargets(loads.containingFile, possibleAuthorityLiterals)
    .filter(isDesktopContractAuthorityTarget);
}

function desktopContractAuthorityViolation(relativePath, sourceOverride) {
  const expected = DESKTOP_CONTRACT_ALLOWED_IMPORTS[relativePath];
  const targets = desktopContractAuthorityTargets(relativePath, sourceOverride);
  const { nonLiteralLoads } = parsedModuleLoads(relativePath, sourceOverride);
  // Distributed launchers cannot use their installation directory as product
  // authority. Only these selected-V5 lifecycle modules may be resolved at run
  // time; their root/release binding is exercised by the real launcher tests.
  const launcherModules = {
    resolveDesktopExecutable: "scripts/build-frontend-generation.mjs",
    main: "scripts/desktop-lifecycle-lock.mjs",
  };
  const unapprovedLoads = nonLiteralLoads.filter((load) => (
    relativePath !== "orquesta/scripts/desktop-launch.js" || load.kind !== "import"
    || !load.lifecycleModule || load.lifecycleModule !== launcherModules[load.functionName]
  ));
  if (unapprovedLoads.length > 0) {
    return `Production source has an unapproved computed import/require: ${relativePath}; found ${JSON.stringify(unapprovedLoads)}`;
  }
  if (expected) {
    if (targets.length !== 1 || targets[0] !== expected) {
      return `Desktop contract consumer must resolve exactly one canonical authority (${expected}); found [${targets.join(", ")}]: ${relativePath}`;
    }
    return null;
  }
  if (targets.length > 0) {
    return `Unregistered Desktop source imports contract authority [${targets.join(", ")}]: ${relativePath}`;
  }
  return null;
}

function buildRuntimeCopiesCanonicalPolicy(sourceOverride) {
  const relativePath = "apps/orquesta-desktop-next/scripts/build-runtime.mjs";
  const { sourceFile } = parsedModuleLoads(relativePath, sourceOverride);
  let importsCopy = false;
  let importsContractPaths = false;
  let policyCopyCount = 0;

  function hasNamedImport(node, localName) {
    const bindings = node.importClause?.namedBindings;
    return Boolean(bindings && ts.isNamedImports(bindings)
      && bindings.elements.some((element) => element.name.text === localName));
  }

  function visit(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      if (node.moduleSpecifier.text === "node:fs/promises" && hasNamedImport(node, "cp")) importsCopy = true;
      if (node.moduleSpecifier.text.endsWith("/packages/contracts/scripts/generate-desktop-bindings.mjs")
          && hasNamedImport(node, "desktopContractPaths")) importsContractPaths = true;
    }
    if (ts.isCallExpression(node)
        && ts.isIdentifier(node.expression)
        && node.expression.text === "cp"
        && node.arguments.length >= 2) {
      const [source, destination] = node.arguments;
      const canonicalSource = ts.isPropertyAccessExpression(source)
        && ts.isIdentifier(source.expression)
        && source.expression.text === "desktopContractPaths"
        && source.name.text === "policy";
      const packagedDestination = ts.isCallExpression(destination)
        && ts.isPropertyAccessExpression(destination.expression)
        && ts.isIdentifier(destination.expression.expression)
        && destination.expression.expression.text === "path"
        && destination.expression.name.text === "join"
        && destination.arguments.length === 2
        && ts.isIdentifier(destination.arguments[0])
        && destination.arguments[0].text === "out"
        && ts.isStringLiteralLike(destination.arguments[1])
        && destination.arguments[1].text === "runtime-method-policy.v1.json";
      if (canonicalSource && packagedDestination) policyCopyCount += 1;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return importsCopy && importsContractPaths && policyCopyCount === 1;
}

function activeProductionSourceFiles() {
  const files = [];
  const ignoredDirectories = new Set([
    "node_modules", "dist", "target", "runtime-dist", "codex-runtime", "coverage",
    "docs", "fixtures", "test", "tests",
  ]);
  function walk(directory) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        if (ignoredDirectories.has(entry.name)
            || relative === "packages/contracts/generated"
            || relative.startsWith("packages/contracts/generated/")) continue;
        walk(absolute);
      } else if (/\.(?:[cm]?[jt]sx?)$/iu.test(entry.name)
          && !/\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/iu.test(entry.name)) {
        files.push(relative);
      }
    }
  }
  for (const relativeRoot of ACTIVE_PRODUCTION_ROOTS) walk(path.join(root, relativeRoot));
  return [...new Set(files)].sort();
}

function retiredLocalCoreSemanticMarkers(relativePath, sourceOverride) {
  const normalized = relativePath.replace(/\\/g, "/");
  if (!normalized.startsWith("packages/local-core/src/")
      && !normalized.startsWith("apps/orquesta-desktop-next/runtime-node/")) return [];
  const source = sourceOverride ?? fs.readFileSync(path.join(root, normalized), "utf8");
  return RETIRED_LOCAL_CORE_MARKERS.filter((marker) => source.includes(marker));
}

function rustFunctionBody(source, functionName) {
  const signature = new RegExp(`\\b(?:pub\\s+)?async\\s+fn\\s+${functionName}\\b`, "u");
  const match = signature.exec(source);
  if (!match) return null;
  const open = source.indexOf("{", match.index + match[0].length);
  if (open < 0) return null;
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  return null;
}

function projectionReadBoundaryViolations(commandsSourceOverride, bridgeSourceOverride) {
  const commandsPath = "apps/orquesta-desktop-next/src-tauri/src/commands.rs";
  const bridgePath = "apps/orquesta-desktop-next/src-tauri/src/projection_bridge.rs";
  const commandsSource = commandsSourceOverride
    ?? fs.readFileSync(path.join(root, commandsPath), "utf8");
  const bridgeSource = bridgeSourceOverride
    ?? fs.readFileSync(path.join(root, bridgePath), "utf8");
  const commandBody = rustFunctionBody(commandsSource, "projection_conversation");
  const bridgeBody = rustFunctionBody(bridgeSource, "conversation");
  const violations = [];
  if (commandBody === null) {
    violations.push("Native projection_conversation command is missing or malformed.");
  } else if (!commandBody.includes("crate::projection_bridge::conversation(")) {
    violations.push("Native conversation reads must use the single projection bridge.");
  }
  if (commandBody !== null && (/\bruntime\s*\.\s*call\s*\(/u.test(commandBody)
      || /collect_project_provider_pages|provider_backfill|rebuild_from_provider/iu.test(commandBody))) {
    violations.push("Native conversation reads must not restore Provider backfill or direct runtime reads.");
  }
  if (bridgeBody === null) {
    violations.push("Native projection bridge conversation reader is missing or malformed.");
  } else {
    if (!/\bprojection\s*\.\s*conversation_for_runtime\s*\(\s*&query\s*,/u.test(bridgeBody)) {
      violations.push("Projection bridge conversation must read from ProjectionService.conversation_for_runtime.");
    }
    if (/\bruntime\s*\.\s*(?:call|current_provider_connection_id)\s*\(/u.test(bridgeBody)
        || /refresh_provider|provider_backfill|collect_project_provider_pages|rebuild_from_provider/iu.test(bridgeBody)) {
      violations.push("Projection bridge conversation must not restore Provider refresh or direct runtime reads.");
    }
  }
  return violations;
}

function hasRuntimeJournalAuthority(relativePath, sourceOverride) {
  const { sourceFile } = parsedModuleLoads(relativePath, sourceOverride);
  let found = false;
  function visit(node) {
    if (found) return;
    if ((ts.isIdentifier(node) && node.text === "journal")
        || (ts.isStringLiteralLike(node) && node.text === "journal")
        || (ts.isElementAccessExpression(node)
          && ts.isStringLiteralLike(node.argumentExpression)
          && node.argumentExpression.text === "journal")) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return found;
}

function applicationExecutionAuthorityViolations(stateSourceOverride, workspaceSourceOverride) {
  const statePath = "apps/orquesta-desktop-next/src/application/state.ts";
  const workspacePath = "apps/orquesta-desktop-next/src/features/workspace/WorkspaceView.tsx";
  const stateFile = parsedModuleLoads(statePath, stateSourceOverride).sourceFile;
  const workspaceFile = parsedModuleLoads(workspacePath, workspaceSourceOverride).sourceFile;
  const stateMembers = [];
  const workspaceStateAccesses = [];
  function visitState(node) {
    if (ts.isInterfaceDeclaration(node) && node.name.text === "ApplicationState") {
      for (const member of node.members) {
        if (member.name && (ts.isIdentifier(member.name) || ts.isStringLiteralLike(member.name))) {
          stateMembers.push(member.name.text);
        }
      }
    }
    ts.forEachChild(node, visitState);
  }
  function visitWorkspace(node) {
    if (ts.isPropertyAccessExpression(node)
        && ts.isIdentifier(node.expression)
        && node.expression.text === "state") {
      workspaceStateAccesses.push(node.name.text);
    }
    ts.forEachChild(node, visitWorkspace);
  }
  visitState(stateFile);
  visitWorkspace(workspaceFile);
  const violations = [];
  if (stateMembers.filter((name) => name === "executions").length !== 1) {
    violations.push("ApplicationState must keep exactly one executions authority.");
  }
  for (const retired of ["agentActivities", "activeTurns"]) {
    if (stateMembers.includes(retired) || workspaceStateAccesses.includes(retired)) {
      violations.push(`Renderer execution state must not restore ${retired} as a second authority.`);
    }
  }
  if (!workspaceStateAccesses.includes("executions")) {
    violations.push("Workspace must read execution activity from ApplicationState.executions.");
  }
  return violations;
}

function readOnlyProjectPathBoundaryViolations(coreSourceOverride, commandsSourceOverride) {
  const corePath = "packages/local-core/src/core/core-runner.ts";
  const commandsPath = "apps/orquesta-desktop-next/src-tauri/src/commands.rs";
  const core = coreSourceOverride ?? fs.readFileSync(path.join(root, corePath), "utf8");
  const commands = commandsSourceOverride ?? fs.readFileSync(path.join(root, commandsPath), "utf8");
  const snapshotStart = core.indexOf("} else if (request.type === 'repository.get-snapshot')");
  const snapshotEnd = snapshotStart < 0
    ? -1
    : core.indexOf("} else if (request.type === 'business.work-orders.read')", snapshotStart);
  const snapshotBranch = snapshotStart >= 0 && snapshotEnd > snapshotStart
    ? core.slice(snapshotStart, snapshotEnd)
    : null;
  const folderBody = rustFunctionBody(commands, "project_open_folder_read_only");
  const violations = [];
  if (!core.includes("repository.selectUninitialized(sanitizedRepositoryRequest)")) {
    violations.push("Uninitialized repository reads must retain the read-only selection path.");
  }
  if (snapshotBranch === null || snapshotBranch.includes("writerLeases")) {
    violations.push("Repository snapshot and attention reads must stay outside writer leases.");
  }
  if (folderBody === null || !folderBody.includes("register_read_only_named(&root, None)")) {
    violations.push("Folder-open inspection must register the project read-only.");
  }
  if (folderBody !== null
      && (/state\s*\.\s*runtime\s*\.\s*authority/u.test(folderBody)
        || /registry\s*\.\s*select/u.test(folderBody))) {
    violations.push("Folder-open inspection must not activate runtime authority or select a writer.");
  }
  return violations;
}

function sidecarHostBoundaryViolations(sourceOverride) {
  const relativePath = "apps/orquesta-desktop-next/runtime-node/sidecar-entry.ts";
  const source = sourceOverride ?? fs.readFileSync(path.join(root, relativePath), "utf8");
  const { sourceFile } = parsedModuleLoads(relativePath, source);
  const violations = [];

  function contains(node, predicate) {
    let found = false;
    function visit(current) {
      if (found) return;
      if (predicate(current)) {
        found = true;
        return;
      }
      ts.forEachChild(current, visit);
    }
    visit(node);
    return found;
  }

  function firstContainedNode(node, predicate) {
    let found = null;
    function visit(current) {
      if (found) return;
      if (predicate(current)) {
        found = current;
        return;
      }
      ts.forEachChild(current, visit);
    }
    visit(node);
    return found;
  }

  function exactEnvironmentInitializer(variableName, environmentName) {
    return sourceFile.statements.some((statement) => (
      ts.isVariableStatement(statement)
      && statement.declarationList.declarations.some((declaration) => (
        ts.isIdentifier(declaration.name)
        && declaration.name.text === variableName
        && declaration.initializer
        && ts.isCallExpression(declaration.initializer)
        && ts.isIdentifier(declaration.initializer.expression)
        && declaration.initializer.expression.text === "requiredAbsoluteEnvironmentPath"
        && declaration.initializer.arguments.length === 1
        && ts.isStringLiteralLike(declaration.initializer.arguments[0])
        && declaration.initializer.arguments[0].text === environmentName
      ))
    ));
  }

  const forbiddenPathFallback = contains(sourceFile, (node) => (
    (ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === "process"
      && node.expression.name.text === "cwd")
    || (ts.isPropertyAccessExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "process"
      && node.name.text === "argv")
  ));
  if (!exactEnvironmentInitializer("runtimeDirectory", "ORQUESTA_NEXT_RUNTIME_DIST")
      || !exactEnvironmentInitializer("resourcesPath", "ORQUESTA_NEXT_RESOURCES_PATH")
      || forbiddenPathFallback) {
    violations.push("Desktop sidecar must use only the two Native-issued packaged path authorities.");
  }

  const dispatch = sourceFile.statements.find((statement) => (
    ts.isFunctionDeclaration(statement) && statement.name?.text === "dispatch"
  ));
  const dispatchBody = dispatch && ts.isFunctionDeclaration(dispatch) ? dispatch.body : null;
  const inboundObjects = [];
  if (dispatchBody) {
    function collectInbound(node) {
      if (ts.isCallExpression(node)
          && ts.isIdentifier(node.expression)
          && node.expression.text === "inbound"
          && node.arguments.length === 1
          && ts.isObjectLiteralExpression(node.arguments[0])) {
        inboundObjects.push(node.arguments[0]);
      }
      ts.forEachChild(node, collectInbound);
    }
    collectInbound(dispatchBody);
  }
  const hasRawInbound = inboundObjects.some((object) => {
    const hasParams = object.properties.some((property) => (
      ts.isSpreadAssignment(property)
      && ts.isIdentifier(property.expression)
      && property.expression.text === "params"
    ));
    const hasType = object.properties.some((property) => (
      ts.isPropertyAssignment(property)
      && property.name
      && ((ts.isIdentifier(property.name) && property.name.text === "type")
        || (ts.isStringLiteralLike(property.name) && property.name.text === "type"))
      && ts.isPropertyAccessExpression(property.initializer)
      && ts.isIdentifier(property.initializer.expression)
      && property.initializer.expression.text === "request"
      && property.initializer.name.text === "method"
    ));
    const hasCorrelation = object.properties.some((property) => (
      ts.isShorthandPropertyAssignment(property) && property.name.text === "correlationId"
    ));
    return hasParams && hasType && hasCorrelation;
  });
  const hasElectronEnvelope = inboundObjects.some((object) => object.properties.some((property) => (
    (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property))
    && property.name
    && ((ts.isIdentifier(property.name) && property.name.text === "data")
      || (ts.isStringLiteralLike(property.name) && property.name.text === "data"))
  )));
  const hasShutdownInbound = contains(sourceFile, (node) => (
    ts.isCallExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === "inbound"
    && node.arguments.length === 1
    && ts.isObjectLiteralExpression(node.arguments[0])
    && node.arguments[0].properties.some((property) => (
      ts.isPropertyAssignment(property)
      && property.name
      && ((ts.isIdentifier(property.name) && property.name.text === "type")
        || (ts.isStringLiteralLike(property.name) && property.name.text === "type"))
      && ts.isStringLiteralLike(property.initializer)
      && property.initializer.text === "core.shutdown"
    ))
  ));
  if (!hasRawInbound || !hasShutdownInbound || hasElectronEnvelope) {
    violations.push("Desktop sidecar must deliver raw Core requests, never Electron envelopes.");
  }

  const statements = dispatchBody ? [...dispatchBody.statements] : [];
  const projectionIndex = statements.findIndex((statement) => (
    ts.isIfStatement(statement)
    && contains(statement.expression, (node) => (
      ts.isStringLiteralLike(node) && node.text === "projection.ingest.bind"
    ))
    && contains(statement.expression, (node) => (
      ts.isStringLiteralLike(node) && node.text === "projection.ingest.suspend"
    ))
  ));
  const policyIndex = statements.findIndex((statement) => contains(statement, (node) => (
    ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression)
    && node.expression.expression.text === "Object"
    && node.expression.name.text === "hasOwn"
    && node.arguments.length === 2
    && ts.isPropertyAccessExpression(node.arguments[0])
    && ts.isIdentifier(node.arguments[0].expression)
    && node.arguments[0].expression.text === "policy"
    && node.arguments[0].name.text === "methods"
  )));
  const projectionStatement = projectionIndex >= 0 ? statements[projectionIndex] : null;
  const hasNativeRuntimeGeneration = sourceFile.statements.some((statement) => (
    ts.isVariableStatement(statement)
    && statement.declarationList.declarations.some((declaration) => (
      ts.isIdentifier(declaration.name)
      && declaration.name.text === "nativeRuntimeGeneration"
      && declaration.initializer
      && contains(declaration.initializer, (node) => (
        ts.isPropertyAccessExpression(node)
        && node.name.text === "ORQUESTA_RUNTIME_GENERATION"
        && ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression)
        && node.expression.expression.text === "process"
        && node.expression.name.text === "env"
      ))
    ))
  ));
  const hasProjectionCall = (name) => projectionStatement !== null
    && contains(projectionStatement, (node) => (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === "projectionEvents"
      && node.expression.name.text === name
    ));
  const hasSelectedProjectFence = projectionStatement !== null
    ? firstContainedNode(projectionStatement, (node) => (
      ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
      && ts.isIdentifier(node.left)
      && node.left.text === "projectId"
      && ts.isIdentifier(node.right)
      && node.right.text === "selectedProjectId"
    ))
    : null;
  const hasRuntimeGenerationFence = projectionStatement !== null
    ? firstContainedNode(projectionStatement, (node) => (
      ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
      && ts.isIdentifier(node.left)
      && node.left.text === "runtimeGeneration"
      && ts.isIdentifier(node.right)
      && node.right.text === "nativeRuntimeGeneration"
    ))
    : null;
  const firstProjectionCall = projectionStatement !== null
    ? firstContainedNode(projectionStatement, (node) => (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === "projectionEvents"
      && (node.expression.name.text === "bind" || node.expression.name.text === "suspend")
    ))
    : null;
  const fencesPrecedeProjectionCalls = hasSelectedProjectFence !== null
    && hasRuntimeGenerationFence !== null
    && firstProjectionCall !== null
    && hasSelectedProjectFence.getStart(sourceFile) < firstProjectionCall.getStart(sourceFile)
    && hasRuntimeGenerationFence.getStart(sourceFile) < firstProjectionCall.getStart(sourceFile);
  if (projectionIndex < 0 || policyIndex < 0 || projectionIndex >= policyIndex
      || !hasProjectionCall("bind") || !hasProjectionCall("suspend")
      || !fencesPrecedeProjectionCalls || !hasNativeRuntimeGeneration) {
    violations.push("Projection ingest binding must remain an internal Native-issued authority before policy dispatch.");
  }
  return violations;
}

function sameStringSet(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function checkBoundary() {
  const errors = [];
  const pkg = readJson("package.json");
  const gitignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");

  addError(errors, pkg.private === false, "Root package must remain public.");
  addError(errors, JSON.stringify([...pkg.workspaces].sort()) === JSON.stringify(WORKSPACE_PATHS), "Root workspaces must equal the current product package set.");
  addError(errors, pkg.scripts?.["test:workspaces"] === "npm run test --workspaces --if-present", "Workspace regression command is missing.");
  addError(errors, typeof pkg.scripts?.["test:product-boundary"] === "string", "Product-boundary command is missing.");
  addError(errors, fs.existsSync(path.join(root, "apps", "orquesta-desktop-next", "package-lock.json")), "Desktop Next must keep an independent lockfile.");
  addError(errors, !fs.existsSync(path.join(root, "apps", "orquesta-desktop")), "Retired Desktop files returned.");
  addError(errors, isSupportedNodeVersion(), `Node ${process.version} is below the required major version 20.`);
  addError(errors, !(pkg.keywords || []).includes("local-dashboard"), "The removed browser product remains in package keywords.");

  for (const filename of DESKTOP_CONTRACT_FILES) {
    addError(
      errors,
      fs.existsSync(path.join(root, DESKTOP_CONTRACT_ROOT, filename)),
      `Canonical desktop contract is missing: ${filename}`,
    );
  }
  for (const relativePath of RETIRED_DESKTOP_CONTRACT_PATHS) {
    addError(errors, !fs.existsSync(path.join(root, relativePath)), `Retired desktop contract copy returned: ${relativePath}`);
  }
  for (const relativePath of DESKTOP_GENERATED_FILES) {
    addError(errors, fs.existsSync(path.join(root, relativePath)), `Generated desktop binding is missing: ${relativePath}`);
  }
  const bridgeManifestPath = path.join(root, DESKTOP_CONTRACT_ROOT, "native-bridge-manifest.v1.json");
  const bridgeFixturesPath = path.join(root, DESKTOP_CONTRACT_ROOT, "fixtures", "native-bridge-fixtures.v1.json");
  if (fs.existsSync(bridgeManifestPath) && fs.existsSync(bridgeFixturesPath)) {
    const bridgeManifest = JSON.parse(fs.readFileSync(bridgeManifestPath, "utf8"));
    const bridgeFixtures = JSON.parse(fs.readFileSync(bridgeFixturesPath, "utf8"));
    addError(errors, sameStringSet(Object.keys(bridgeFixtures.commands || {}), Object.keys(bridgeManifest.commands || {})), "Desktop command fixtures differ from the canonical command manifest.");
    addError(errors, sameStringSet(Object.keys(bridgeFixtures.events || {}), Object.keys(bridgeManifest.events || {})), "Desktop event fixtures differ from the canonical event manifest.");
  }

  const productionSources = activeProductionSourceFiles();
  for (const relativePath of Object.keys(DESKTOP_CONTRACT_ALLOWED_IMPORTS)) {
    addError(errors, productionSources.includes(relativePath), `Registered Desktop contract consumer is missing from the production source scan: ${relativePath}`);
  }
  for (const relativePath of productionSources) {
    const violation = desktopContractAuthorityViolation(relativePath);
    addError(errors, violation === null, violation || "");
    const retiredImports = retiredLocalCoreImportTargets(relativePath);
    addError(
      errors,
      retiredImports.length === 0,
      `Production source imports retired local-core Electron code [${retiredImports.join(", ")}]: ${relativePath}`,
    );
    const retiredMarkers = retiredLocalCoreSemanticMarkers(relativePath);
    addError(
      errors,
      retiredMarkers.length === 0,
      `Production source contains retired local-core semantics [${retiredMarkers.join(", ")}]: ${relativePath}`,
    );
    if (relativePath.startsWith("packages/local-core/src/")) {
      const violation = localCoreIntegrationViolation(relativePath);
      addError(
        errors,
        violation === null,
        violation || "",
      );
    }
    if (relativePath.startsWith("apps/orquesta-desktop-next/runtime-node/")) {
      addError(
        errors,
        !hasRuntimeJournalAuthority(relativePath),
        `Node runtime must not restore a second journal authority: ${relativePath}`,
      );
    }
  }
  for (const violation of projectionReadBoundaryViolations()) addError(errors, false, violation);
  for (const violation of applicationExecutionAuthorityViolations()) addError(errors, false, violation);
  for (const violation of readOnlyProjectPathBoundaryViolations()) addError(errors, false, violation);
  for (const violation of sidecarHostBoundaryViolations()) addError(errors, false, violation);
  addError(
    errors,
    buildRuntimeCopiesCanonicalPolicy(),
    "Desktop runtime build must copy the canonical method policy to the packaged runtime exactly once.",
  );

  for (const name of REMOVED_BROWSER_SCRIPTS) {
    addError(errors, pkg.scripts?.[name] === undefined, `Removed browser command returned: ${name}`);
  }
  const scriptText = Object.values(pkg.scripts || {}).join("\n");
  for (const marker of ["apps/workbench", "orquesta/dashboard-server.js", "orquesta/assets/dashboard", "dashboard-dom-smoke", "dashboard-port-selection", "dashboard-state-cache", "dashboard-report-review", "browser-preflight.js", "verify-phase1.js"]) {
    addError(errors, !scriptText.includes(marker), `Root scripts reference removed browser code: ${marker}`);
  }

  for (const ignoredPath of [".orquesta/", "output/", "node_modules/"]) {
    addError(errors, hasActiveIgnoreRule(gitignore, ignoredPath), `${ignoredPath} must be ignored.`);
  }
  for (const relativePath of [
    ...REMOVED_BROWSER_PATHS,
    ...RETIRED_AUTHORITY_PATHS,
    ...forbiddenDirectories,
    ...RETIRED_LOCAL_CORE_ROOTS,
  ]) {
    addError(errors, !hasMaterialPath(path.join(root, relativePath)), `Removed or forbidden product surface exists: ${relativePath}`);
  }
  for (const [relativePath, expected] of Object.entries(workspacePackages)) {
    const manifestPath = path.join(root, relativePath, "package.json");
    addError(errors, fs.existsSync(manifestPath), `Workspace manifest is missing: ${relativePath}`);
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    addError(errors, manifest.private === true, `${relativePath} must be private.`);
    addError(errors, manifest.version === expected.version, `${relativePath} has an invalid version.`);
    addError(errors, typeof manifest.scripts?.test === "string" && manifest.scripts.test.trim().length > 0, `${relativePath} must declare a test command.`);
    addError(errors, JSON.stringify(normalizeObject(manifest.dependencies)) === JSON.stringify(normalizeObject(expected.dependencies)), `${relativePath} has an invalid dependency graph.`);
  }

  const nonDesktopRuntimeRoots = [
    "orquesta/scripts",
    "scripts",
    ...Object.keys(workspacePackages)
      .filter((relativePath) => !["packages/business-orchestrator", "packages/local-core"].includes(relativePath))
      .map((relativePath) => `${relativePath}/src`),
  ];
  for (const relativeRoot of nonDesktopRuntimeRoots) {
    for (const filePath of runtimeFiles(path.join(root, relativeRoot))) {
      const relativePath = path.relative(root, filePath).replace(/\\/g, "/");
      const imports = businessRuntimeImportSpecifiers(
        fs.readFileSync(filePath, "utf8"),
        relativePath,
      );
      addError(
        errors,
        imports.length === 0,
        `Business integration escaped its owned runtime boundary: ${path.relative(root, filePath)}`,
      );
    }
  }

  addError(errors, Object.keys(pkg.dependencies || {}).length === 0, "Root package must not have runtime dependencies.");
  addError(errors, Object.keys(pkg.devDependencies || {}).length === 0, "Root browser review dependencies must remain removed.");

  const lockfilePath = path.join(root, "package-lock.json");
  addError(errors, fs.existsSync(lockfilePath), "package-lock.json is missing.");
  if (fs.existsSync(lockfilePath)) {
    const lockfile = JSON.parse(fs.readFileSync(lockfilePath, "utf8"));
    const packageEntries = lockfile.packages || {};
    addError(errors, JSON.stringify([...(packageEntries[""]?.workspaces || [])].sort()) === JSON.stringify(WORKSPACE_PATHS), "Lockfile workspace surface is stale.");
    addError(errors, !Object.hasOwn(packageEntries, "apps/workbench"), "Workbench remains in the lockfile.");
    addError(errors, !Object.hasOwn(packageEntries, "node_modules/@orquesta/workbench"), "Workbench link remains in the lockfile.");
    addError(errors, !Object.hasOwn(packageEntries, "node_modules/playwright-core"), "Root Playwright driver remains in the lockfile.");
    for (const [packagePath, entry] of Object.entries(packageEntries)) {
      addError(
        errors,
        isAllowedRegistryArtifact(packagePath, entry),
        `Lockfile contains an unsupported registry artifact: ${packagePath}`,
      );
    }
  }


  return errors;
}

function main() {
  const errors = checkBoundary();
  if (errors.length) {
    console.error("Orquesta product boundary check failed:");
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log("Orquesta product boundary check passed");
}

if (require.main === module) main();

module.exports = {
  REMOVED_BROWSER_PATHS,
  REMOVED_BROWSER_SCRIPTS,
  WORKSPACE_PATHS,
  DESKTOP_CONTRACT_FILES,
  DESKTOP_CONTRACT_ROOT,
  DESKTOP_GENERATED_FILES,
  RETIRED_DESKTOP_CONTRACT_PATHS,
  RETIRED_AUTHORITY_PATHS,
  RETIRED_LOCAL_CORE_ROOTS,
  RETIRED_LOCAL_CORE_MARKERS,
  checkBoundary,
  hasMaterialPath,
  hasActiveIgnoreRule,
  isAllowedCodexDependency,
  isAllowedRegistryArtifact,
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
};
