#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const {
  resolveBundledCodexRuntime
} = require("../../packages/codex-adapter/src/runtime-path");

function safeProcessError(result) {
  const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
  return stderr.slice(0, 500) || "no stderr";
}

function parseCliVersion(stdout) {
  const match = String(stdout || "").match(/\b(\d+\.\d+\.\d+)\b/);
  return match ? match[1] : null;
}

function probeCodexRuntime({
  expectVersion,
  schemaOut,
  sdkPackageRoot,
  resolveRuntime = resolveBundledCodexRuntime,
  spawnSyncImpl = spawnSync
}) {
  if (typeof expectVersion !== "string" || expectVersion.trim() === "") {
    throw new TypeError("expectVersion must be a non-empty string");
  }
  const runtime = resolveRuntime({
    sdkPackageRoot,
    platform: process.platform,
    arch: process.arch
  });
  const spawnOptions = {
    shell: false,
    windowsHide: true,
    encoding: "utf8"
  };
  const versionResult = spawnSyncImpl(
    runtime.executable_path,
    ["--version"],
    spawnOptions
  );
  if (versionResult.error) {
    throw new Error(`Codex runtime probe failed: ${versionResult.error.message}`);
  }
  if (versionResult.status !== 0) {
    throw new Error(
      `Codex runtime probe exited with exit code ${versionResult.status}: ${safeProcessError(versionResult)}`
    );
  }

  const cliVersion = parseCliVersion(versionResult.stdout);
  if (cliVersion !== expectVersion) {
    throw new Error(
      `expected Codex runtime ${expectVersion}, observed ${cliVersion || "unknown"}`
    );
  }

  const result = {
    ...runtime,
    cli_version: cliVersion,
    probe_shell: false
  };

  if (schemaOut) {
    const absoluteSchemaOut = path.resolve(schemaOut);
    const schemaResult = spawnSyncImpl(
      runtime.executable_path,
      ["app-server", "generate-json-schema", "--out", absoluteSchemaOut],
      spawnOptions
    );
    if (schemaResult.error) {
      throw new Error(`App Server schema capture failed: ${schemaResult.error.message}`);
    }
    if (schemaResult.status !== 0) {
      throw new Error(
        `App Server schema capture exited with exit code ${schemaResult.status}: ${safeProcessError(schemaResult)}`
      );
    }
    result.schema_out = absoluteSchemaOut;
  }

  return Object.freeze(result);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--expect-version") {
      options.expectVersion = argv[index += 1];
    } else if (value === "--schema-out") {
      options.schemaOut = argv[index += 1];
    } else if (value === "--sdk-package-root") {
      options.sdkPackageRoot = argv[index += 1];
    } else {
      throw new Error(`unknown argument: ${value}`);
    }
  }
  return options;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (!options.sdkPackageRoot) {
    options.sdkPackageRoot = path.resolve(
      __dirname,
      "..",
      "..",
      "node_modules",
      "@openai",
      "codex-sdk"
    );
  }
  const result = probeCodexRuntime(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  parseArgs,
  parseCliVersion,
  probeCodexRuntime
};
