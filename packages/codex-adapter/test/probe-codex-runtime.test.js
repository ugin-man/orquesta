const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  canonicalJsonSha256,
  probeCodexRuntime
} = require("../../../scripts/v4/probe-codex-runtime");

function runtimeEvidence() {
  return {
    runtime_package: "@openai/codex-win32-x64",
    runtime_package_version: "0.144.5-win32-x64",
    target_triple: "x86_64-pc-windows-msvc",
    executable_path: "C:\\runtime\\codex.exe"
  };
}

test("probes the resolved bundled runtime with shell disabled", () => {
  const calls = [];
  const result = probeCodexRuntime({
    expectVersion: "0.144.5",
    sdkPackageRoot: "C:\\sdk",
    resolveRuntime: () => runtimeEvidence(),
    spawnSyncImpl(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0, stdout: "codex-cli 0.144.5\n", stderr: "" };
    }
  });

  assert.equal(result.cli_version, "0.144.5");
  assert.equal(result.runtime_package, "@openai/codex-win32-x64");
  assert.deepEqual(calls, [{
    command: "C:\\runtime\\codex.exe",
    args: ["--version"],
    options: {
      shell: false,
      windowsHide: true,
      encoding: "utf8"
    }
  }]);
});

test("rejects a failed probe or a different runtime version", () => {
  assert.throws(
    () => probeCodexRuntime({
      expectVersion: "0.144.5",
      sdkPackageRoot: "C:\\sdk",
      resolveRuntime: () => runtimeEvidence(),
      spawnSyncImpl: () => ({ status: 1, stdout: "", stderr: "denied" })
    }),
    /exit code 1.*denied/i
  );

  assert.throws(
    () => probeCodexRuntime({
      expectVersion: "0.144.5",
      sdkPackageRoot: "C:\\sdk",
      resolveRuntime: () => runtimeEvidence(),
      spawnSyncImpl: () => ({ status: 0, stdout: "codex-cli 0.144.6", stderr: "" })
    }),
    /expected.*0\.144\.5.*0\.144\.6/i
  );
});

test("captures App Server schema with the same resolved runtime and no shell", () => {
  const calls = [];
  const reads = [];
  const schemaOut = path.resolve("temporary-schema");
  const schemaSource = path.join(schemaOut, "codex_app_server_protocol.v2.schemas.json");
  const firstSerialization = '{"z":{"b":2,"a":1},"a":[{"d":4,"c":3}]}';
  const secondSerialization = '{"a":[{"c":3,"d":4}],"z":{"a":1,"b":2}}';
  const expectedCanonicalSha256 = "4bc08b196ca8e8875a2e52bb91d29ba5e5a734ae5cf53c030d7f932ee245a439";

  assert.equal(canonicalJsonSha256(firstSerialization), expectedCanonicalSha256);
  assert.equal(canonicalJsonSha256(secondSerialization), expectedCanonicalSha256);
  const result = probeCodexRuntime({
    expectVersion: "0.144.5",
    schemaOut,
    sdkPackageRoot: "C:\\sdk",
    resolveRuntime: () => runtimeEvidence(),
    readFileSyncImpl(filePath, encoding) {
      reads.push({ filePath, encoding });
      return firstSerialization;
    },
    spawnSyncImpl(command, args, options) {
      calls.push({ command, args, options });
      return args[0] === "--version"
        ? { status: 0, stdout: "codex-cli 0.144.5", stderr: "" }
        : { status: 0, stdout: "schema generated", stderr: "" };
    }
  });

  assert.equal(result.schema_out, schemaOut);
  assert.equal(result.schema_source, "codex_app_server_protocol.v2.schemas.json");
  assert.equal(result.schema_canonicalization, "recursive-key-sort-json-v1");
  assert.equal(result.schema_canonical_sha256, expectedCanonicalSha256);
  assert.deepEqual(reads, [{ filePath: schemaSource, encoding: "utf8" }]);
  assert.deepEqual(calls[1], {
    command: "C:\\runtime\\codex.exe",
    args: ["app-server", "generate-json-schema", "--out", schemaOut],
    options: {
      shell: false,
      windowsHide: true,
      encoding: "utf8"
    }
  });
});
