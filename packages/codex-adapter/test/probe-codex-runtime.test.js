const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
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
  const schemaOut = path.resolve("temporary-schema");
  const result = probeCodexRuntime({
    expectVersion: "0.144.5",
    schemaOut,
    sdkPackageRoot: "C:\\sdk",
    resolveRuntime: () => runtimeEvidence(),
    spawnSyncImpl(command, args, options) {
      calls.push({ command, args, options });
      return args[0] === "--version"
        ? { status: 0, stdout: "codex-cli 0.144.5", stderr: "" }
        : { status: 0, stdout: "schema generated", stderr: "" };
    }
  });

  assert.equal(result.schema_out, schemaOut);
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
