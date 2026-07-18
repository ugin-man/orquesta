const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { resolveBundledCodexRuntime } = require("../src/runtime-path");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createRuntimeFixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nodeModules = path.join(root, "node_modules");
  const sdkPackageRoot = path.join(nodeModules, "@openai", "codex-sdk");
  const codexPackageRoot = path.join(nodeModules, "@openai", "codex");
  const runtimePackageRoot = path.join(nodeModules, "@openai", "codex-win32-x64");
  const executablePath = path.join(
    runtimePackageRoot,
    "vendor",
    "x86_64-pc-windows-msvc",
    "bin",
    "codex.exe"
  );

  writeJson(path.join(sdkPackageRoot, "package.json"), {
    name: "@openai/codex-sdk",
    version: overrides.sdkVersion || "0.144.5",
    dependencies: { "@openai/codex": "0.144.5" }
  });
  writeJson(path.join(codexPackageRoot, "package.json"), {
    name: "@openai/codex",
    version: overrides.codexVersion || "0.144.5",
    optionalDependencies: {
      "@openai/codex-win32-x64": "npm:@openai/codex@0.144.5-win32-x64"
    }
  });
  writeJson(path.join(runtimePackageRoot, "package.json"), {
    name: "@openai/codex",
    version: overrides.runtimeVersion || "0.144.5-win32-x64",
    os: overrides.runtimeOs || ["win32"],
    cpu: overrides.runtimeCpu || ["x64"]
  });
  fs.mkdirSync(path.dirname(executablePath), { recursive: true });
  fs.writeFileSync(executablePath, "fixture", "utf8");

  return {
    root,
    sdkPackageRoot,
    codexPackageRoot,
    runtimePackageRoot,
    executablePath
  };
}

test("resolves the pinned Windows runtime to an absolute regular executable", (t) => {
  const fixture = createRuntimeFixture(t);
  const result = resolveBundledCodexRuntime({
    sdkPackageRoot: fixture.sdkPackageRoot,
    platform: "win32",
    arch: "x64"
  });

  assert.deepEqual(result, {
    sdk_package: "@openai/codex-sdk",
    sdk_version: "0.144.5",
    codex_package: "@openai/codex",
    codex_version: "0.144.5",
    runtime_package: "@openai/codex-win32-x64",
    runtime_package_version: "0.144.5-win32-x64",
    target_triple: "x86_64-pc-windows-msvc",
    executable_path: fs.realpathSync(fixture.executablePath)
  });
  assert.equal(path.isAbsolute(result.executable_path), true);
});

test("rejects a missing pinned Codex package", (t) => {
  const fixture = createRuntimeFixture(t);
  fs.rmSync(fixture.codexPackageRoot, { recursive: true, force: true });

  assert.throws(
    () => resolveBundledCodexRuntime({
      sdkPackageRoot: fixture.sdkPackageRoot,
      platform: "win32",
      arch: "x64"
    }),
    /missing.*@openai\/codex/i
  );
});

test("rejects an unpinned SDK or Codex version", (t) => {
  const badSdk = createRuntimeFixture(t, { sdkVersion: "0.144.6" });
  assert.throws(
    () => resolveBundledCodexRuntime({
      sdkPackageRoot: badSdk.sdkPackageRoot,
      platform: "win32",
      arch: "x64"
    }),
    /SDK.*0\.144\.5/i
  );

  const badCodex = createRuntimeFixture(t, { codexVersion: "0.144.6" });
  assert.throws(
    () => resolveBundledCodexRuntime({
      sdkPackageRoot: badCodex.sdkPackageRoot,
      platform: "win32",
      arch: "x64"
    }),
    /Codex.*0\.144\.5/i
  );
});

test("rejects a runtime package with the wrong platform or architecture", (t) => {
  const wrongPlatform = createRuntimeFixture(t, { runtimeOs: ["linux"] });
  assert.throws(
    () => resolveBundledCodexRuntime({
      sdkPackageRoot: wrongPlatform.sdkPackageRoot,
      platform: "win32",
      arch: "x64"
    }),
    /platform.*win32/i
  );

  const wrongArch = createRuntimeFixture(t, { runtimeCpu: ["arm64"] });
  assert.throws(
    () => resolveBundledCodexRuntime({
      sdkPackageRoot: wrongArch.sdkPackageRoot,
      platform: "win32",
      arch: "x64"
    }),
    /architecture.*x64/i
  );
});

test("rejects unsupported platform and architecture pairs", (t) => {
  const fixture = createRuntimeFixture(t);
  assert.throws(
    () => resolveBundledCodexRuntime({
      sdkPackageRoot: fixture.sdkPackageRoot,
      platform: "aix",
      arch: "ppc64"
    }),
    /unsupported platform/i
  );
});

test("rejects package resolution that escapes the SDK installation boundary", (t) => {
  const fixture = createRuntimeFixture(t);
  const outsideRoot = path.join(fixture.root, "outside-runtime");
  writeJson(path.join(outsideRoot, "package.json"), {
    name: "@openai/codex",
    version: "0.144.5-win32-x64",
    os: ["win32"],
    cpu: ["x64"]
  });
  const fsAdapter = Object.create(fs);
  fsAdapter.resolvePackageRoot = (packageName) => {
    if (packageName === "@openai/codex") return fixture.codexPackageRoot;
    if (packageName === "@openai/codex-win32-x64") return outsideRoot;
    throw new Error(`unexpected package: ${packageName}`);
  };

  assert.throws(
    () => resolveBundledCodexRuntime({
      sdkPackageRoot: fixture.sdkPackageRoot,
      platform: "win32",
      arch: "x64",
      fsAdapter
    }),
    /path escape/i
  );
});

test("rejects a runtime package root junction or symlink outside real node_modules", (t) => {
  const fixture = createRuntimeFixture(t);
  const outsideRuntimeRoot = path.join(fixture.root, "outside-runtime-package");
  fs.renameSync(fixture.runtimePackageRoot, outsideRuntimeRoot);
  fs.symlinkSync(
    outsideRuntimeRoot,
    fixture.runtimePackageRoot,
    process.platform === "win32" ? "junction" : "dir"
  );

  assert.throws(
    () => resolveBundledCodexRuntime({
      sdkPackageRoot: fixture.sdkPackageRoot,
      platform: "win32",
      arch: "x64"
    }),
    /runtime package.*(?:junction|symlink|realpath).*escape/i
  );
});

test("rejects a symlink escape from the selected runtime package", (t) => {
  const fixture = createRuntimeFixture(t);
  const outsideExecutable = path.join(fixture.root, "outside", "codex.exe");
  fs.mkdirSync(path.dirname(outsideExecutable), { recursive: true });
  fs.writeFileSync(outsideExecutable, "outside", "utf8");
  const fsAdapter = Object.create(fs);
  fsAdapter.realpathSync = (candidate) => (
    path.resolve(candidate) === path.resolve(fixture.executablePath)
      ? outsideExecutable
      : fs.realpathSync(candidate)
  );

  assert.throws(
    () => resolveBundledCodexRuntime({
      sdkPackageRoot: fixture.sdkPackageRoot,
      platform: "win32",
      arch: "x64",
      fsAdapter
    }),
    /symlink escape/i
  );
});

test("rejects a non-regular executable", (t) => {
  const fixture = createRuntimeFixture(t);
  fs.rmSync(fixture.executablePath);
  fs.mkdirSync(fixture.executablePath);

  assert.throws(
    () => resolveBundledCodexRuntime({
      sdkPackageRoot: fixture.sdkPackageRoot,
      platform: "win32",
      arch: "x64"
    }),
    /regular file/i
  );
});
