const fs = require("node:fs");
const path = require("node:path");

const PINNED_CODEX_VERSION = "0.144.5";

const RUNTIME_TARGETS = Object.freeze({
  "linux:x64": Object.freeze({
    packageName: "@openai/codex-linux-x64",
    packageVersion: "0.144.5-linux-x64",
    targetTriple: "x86_64-unknown-linux-musl",
    executableName: "codex"
  }),
  "linux:arm64": Object.freeze({
    packageName: "@openai/codex-linux-arm64",
    packageVersion: "0.144.5-linux-arm64",
    targetTriple: "aarch64-unknown-linux-musl",
    executableName: "codex"
  }),
  "darwin:x64": Object.freeze({
    packageName: "@openai/codex-darwin-x64",
    packageVersion: "0.144.5-darwin-x64",
    targetTriple: "x86_64-apple-darwin",
    executableName: "codex"
  }),
  "darwin:arm64": Object.freeze({
    packageName: "@openai/codex-darwin-arm64",
    packageVersion: "0.144.5-darwin-arm64",
    targetTriple: "aarch64-apple-darwin",
    executableName: "codex"
  }),
  "win32:x64": Object.freeze({
    packageName: "@openai/codex-win32-x64",
    packageVersion: "0.144.5-win32-x64",
    targetTriple: "x86_64-pc-windows-msvc",
    executableName: "codex.exe"
  }),
  "win32:arm64": Object.freeze({
    packageName: "@openai/codex-win32-arm64",
    packageVersion: "0.144.5-win32-arm64",
    targetTriple: "aarch64-pc-windows-msvc",
    executableName: "codex.exe"
  })
});

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertWithin(parent, candidate, message) {
  if (!isWithin(path.resolve(parent), path.resolve(candidate))) {
    throw new Error(message);
  }
}

function findNodeModulesRoot(sdkPackageRoot) {
  let current = path.resolve(sdkPackageRoot);
  const filesystemRoot = path.parse(current).root;
  while (current !== filesystemRoot) {
    if (path.basename(current).toLowerCase() === "node_modules") {
      return current;
    }
    current = path.dirname(current);
  }
  throw new Error("SDK package root is not inside a node_modules installation boundary");
}

function packagePath(nodeModulesRoot, packageName) {
  return path.join(nodeModulesRoot, ...packageName.split("/"));
}

function readPackage(fsAdapter, packageRoot, label) {
  const packagePathname = path.join(packageRoot, "package.json");
  let source;
  try {
    source = fsAdapter.readFileSync(packagePathname, "utf8");
  } catch (error) {
    throw new Error(`missing ${label} package metadata at ${packagePathname}`, {
      cause: error
    });
  }
  try {
    return JSON.parse(source.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`invalid ${label} package metadata at ${packagePathname}`, {
      cause: error
    });
  }
}

function realPackageRoot(fsAdapter, realNodeModulesRoot, packageRoot, label) {
  let resolved;
  try {
    resolved = fsAdapter.realpathSync(packageRoot);
  } catch (error) {
    throw new Error(`missing ${label} package root at ${packageRoot}`, {
      cause: error
    });
  }
  if (!isWithin(realNodeModulesRoot, resolved)) {
    throw new Error(`${label} package realpath escape detected`);
  }
  return resolved;
}

function resolveBundledCodexRuntime({
  sdkPackageRoot,
  platform = process.platform,
  arch = process.arch,
  fsAdapter = fs
}) {
  if (typeof sdkPackageRoot !== "string" || sdkPackageRoot.trim() === "") {
    throw new TypeError("sdkPackageRoot must be a non-empty string");
  }

  const sdkRoot = path.resolve(sdkPackageRoot);
  const nodeModulesRoot = findNodeModulesRoot(sdkRoot);
  assertWithin(nodeModulesRoot, sdkRoot, "SDK package path escape detected");

  let realNodeModulesRoot;
  try {
    realNodeModulesRoot = fsAdapter.realpathSync(nodeModulesRoot);
  } catch (error) {
    throw new Error(`missing node_modules installation boundary at ${nodeModulesRoot}`, {
      cause: error
    });
  }
  const realSdkRoot = realPackageRoot(
    fsAdapter,
    realNodeModulesRoot,
    sdkRoot,
    "SDK"
  );

  const sdkPackage = readPackage(fsAdapter, realSdkRoot, "@openai/codex-sdk");
  if (sdkPackage.name !== "@openai/codex-sdk"
      || sdkPackage.version !== PINNED_CODEX_VERSION) {
    throw new Error(`Codex SDK must be pinned to ${PINNED_CODEX_VERSION}`);
  }
  if (sdkPackage.dependencies?.["@openai/codex"] !== PINNED_CODEX_VERSION) {
    throw new Error(`Codex SDK must declare @openai/codex ${PINNED_CODEX_VERSION}`);
  }

  const resolvePackageRoot = typeof fsAdapter.resolvePackageRoot === "function"
    ? (packageName) => path.resolve(fsAdapter.resolvePackageRoot(packageName, realSdkRoot))
    : (packageName) => packagePath(nodeModulesRoot, packageName);

  const codexRoot = resolvePackageRoot("@openai/codex");
  const realCodexRoot = realPackageRoot(
    fsAdapter,
    realNodeModulesRoot,
    codexRoot,
    "@openai/codex"
  );
  const codexPackage = readPackage(fsAdapter, realCodexRoot, "@openai/codex");
  if (codexPackage.name !== "@openai/codex"
      || codexPackage.version !== PINNED_CODEX_VERSION) {
    throw new Error(`Codex package must be pinned to ${PINNED_CODEX_VERSION}`);
  }

  const target = RUNTIME_TARGETS[`${platform}:${arch}`];
  if (!target) {
    throw new Error(`unsupported platform and architecture: ${platform} (${arch})`);
  }

  const expectedAlias = `npm:@openai/codex@${target.packageVersion}`;
  if (codexPackage.optionalDependencies?.[target.packageName] !== expectedAlias) {
    throw new Error(
      `Codex package must declare exact optional runtime ${target.packageName}@${expectedAlias}`
    );
  }

  const runtimeRoot = resolvePackageRoot(target.packageName);
  const realRuntimeRoot = realPackageRoot(
    fsAdapter,
    realNodeModulesRoot,
    runtimeRoot,
    "runtime"
  );
  const runtimePackage = readPackage(fsAdapter, realRuntimeRoot, target.packageName);
  if (runtimePackage.name !== "@openai/codex"
      || runtimePackage.version !== target.packageVersion) {
    throw new Error(`runtime package must be pinned to ${target.packageVersion}`);
  }
  if (!Array.isArray(runtimePackage.os) || !runtimePackage.os.includes(platform)) {
    throw new Error(`runtime package platform must include ${platform}`);
  }
  if (!Array.isArray(runtimePackage.cpu) || !runtimePackage.cpu.includes(arch)) {
    throw new Error(`runtime package architecture must include ${arch}`);
  }

  const executablePath = path.join(
    realRuntimeRoot,
    "vendor",
    target.targetTriple,
    "bin",
    target.executableName
  );
  assertWithin(realRuntimeRoot, executablePath, "runtime executable path escape detected");

  let realExecutablePath;
  try {
    realExecutablePath = fsAdapter.realpathSync(executablePath);
  } catch (error) {
    throw new Error(`missing declared runtime executable at ${executablePath}`, {
      cause: error
    });
  }
  if (!isWithin(realRuntimeRoot, realExecutablePath)) {
    throw new Error("runtime executable symlink escape detected");
  }
  if (!fsAdapter.statSync(realExecutablePath).isFile()) {
    throw new Error("runtime executable must be a regular file");
  }

  return Object.freeze({
    sdk_package: "@openai/codex-sdk",
    sdk_version: sdkPackage.version,
    codex_package: "@openai/codex",
    codex_version: codexPackage.version,
    runtime_package: target.packageName,
    runtime_package_version: runtimePackage.version,
    target_triple: target.targetTriple,
    executable_path: realExecutablePath
  });
}

module.exports = {
  PINNED_CODEX_VERSION,
  RUNTIME_TARGETS,
  resolveBundledCodexRuntime
};
