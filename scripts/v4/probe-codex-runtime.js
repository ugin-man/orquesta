#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const {
  resolveBundledCodexRuntime
} = require("../../packages/codex-adapter/src/runtime-path");

const SCHEMA_SOURCE = "codex_app_server_protocol.v2.schemas.json";
const SCHEMA_CANONICALIZATION = "recursive-key-sort-json-v1";

function canonicalizeJson(value) {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalizeJson(value[key])])
  );
}

function canonicalJsonSha256(source) {
  const parsed = JSON.parse(String(source));
  const canonical = JSON.stringify(canonicalizeJson(parsed));
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

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
  readFileSyncImpl = readFileSync,
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
    const schemaSourcePath = path.join(absoluteSchemaOut, SCHEMA_SOURCE);
    let schemaSource;
    try {
      schemaSource = readFileSyncImpl(schemaSourcePath, "utf8");
    } catch (error) {
      throw new Error(`App Server schema verification failed: ${error.message}`);
    }
    result.schema_out = absoluteSchemaOut;
    result.schema_source = SCHEMA_SOURCE;
    result.schema_canonicalization = SCHEMA_CANONICALIZATION;
    result.schema_canonical_sha256 = canonicalJsonSha256(schemaSource);
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
  SCHEMA_CANONICALIZATION,
  SCHEMA_SOURCE,
  canonicalJsonSha256,
  canonicalizeJson,
  parseArgs,
  parseCliVersion,
  probeCodexRuntime
};
