"use strict";

const assert = require("node:assert/strict");
const {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  BUILD_INPUT_MANIFEST_RELATIVE_PATH,
  buildDesktopReleaseAttestation,
  snapshotDesktopBuildInputs,
  verifyDesktopReleaseSet,
  verifyDesktopLaunchIdentity,
  verifyDesktopReleaseAttestation,
  writeDesktopReleaseSetReceipt,
  writeDesktopReleaseAttestation,
} = require("./desktop-release-attestation");

const repositoryRoot = path.resolve(__dirname, "..", "..");
const buildInputManifest = JSON.parse(readFileSync(
  path.join(repositoryRoot, BUILD_INPUT_MANIFEST_RELATIVE_PATH),
  "utf8",
));

const roots = [];
test.afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(root, relativePath, value) {
  const target = path.join(root, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, value);
  return target;
}

function bundleExecutable(value, bundleType) {
  const sourceMarker = Buffer.from("__TAURI_BUNDLE_TYPE_VAR_UNK", "ascii");
  const targetMarker = Buffer.from(
    bundleType === "nsis" ? "__TAURI_BUNDLE_TYPE_VAR_NSS" : "__TAURI_BUNDLE_TYPE_VAR_MSI",
    "ascii",
  );
  const bytes = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value);
  const markerOffset = bytes.indexOf(sourceMarker);
  assert.notEqual(markerOffset, -1);
  targetMarker.copy(bytes, markerOffset);
  return bytes;
}

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "orquesta-release-attestation-"));
  roots.push(root);
  write(root, BUILD_INPUT_MANIFEST_RELATIVE_PATH, `${JSON.stringify(buildInputManifest, null, 2)}\n`);
  for (const relativePath of buildInputManifest.files) {
    if (relativePath !== BUILD_INPUT_MANIFEST_RELATIVE_PATH) write(root, relativePath, `fixture:${relativePath}\n`);
  }
  for (const relativePath of buildInputManifest.directories) {
    write(root, path.join(relativePath, "fixture-input.txt"), `fixture:${relativePath}\n`);
  }
  write(root, "apps/orquesta-desktop-next/package.json", JSON.stringify({
    name: "@orquesta/desktop-next",
    productName: "Orquesta Next",
    version: "0.5.0-next.0",
  }));
  write(root, "apps/orquesta-desktop-next/src-tauri/tauri.conf.json", JSON.stringify({
    productName: "Orquesta Next",
    version: "0.5.0-0",
    identifier: "com.orquesta.desktop.next",
  }));
  write(root, "apps/orquesta-desktop-next/src-tauri/Cargo.toml", "[package]\nname='orquesta-desktop-next'\n");
  for (const relativePath of [
    "runtime-dist/sidecar.cjs",
    "codex-runtime/runtime.exe",
  ]) {
    const content = `current:${relativePath}`;
    write(root, `apps/orquesta-desktop-next/${relativePath}`, content);
    write(root, `apps/orquesta-desktop-next/src-tauri/target/release/${relativePath}`, content);
  }
  const runtimeManifest = JSON.stringify({ schemaVersion: 1, files: [] });
  write(root, "apps/orquesta-desktop-next/codex-runtime/runtime-manifest.json", runtimeManifest);
  write(root, "apps/orquesta-desktop-next/src-tauri/target/release/codex-runtime/runtime-manifest.json", runtimeManifest);
  const executable = write(
    root,
    "apps/orquesta-desktop-next/src-tauri/target/release/orquesta-desktop-next.exe",
    "current desktop executable __TAURI_BUNDLE_TYPE_VAR_UNK",
  );
  write(root, "apps/orquesta-desktop-next/src-tauri/target/release/bundle/msi/Orquesta Next_0.5.0-0_x64_en-US.msi", "msi");
  write(root, "apps/orquesta-desktop-next/src-tauri/target/release/bundle/nsis/Orquesta Next_0.5.0-0_x64-setup.exe", "nsis");
  const frontendBuildId = "338872ce-b8bb-47c8-9615-9029fb87173c";
  const frontendReceiptPath = write(
    root,
    `apps/orquesta-desktop-next/.build-generations/receipts/${frontendBuildId}.json`,
    JSON.stringify({ buildId: frontendBuildId, files: [] }),
  );
  return { root, executable, frontendBuildId, frontendReceiptPath };
}

test("builds and verifies one coherent release set", () => {
  const { root, executable, frontendBuildId, frontendReceiptPath } = fixture();
  const result = writeDesktopReleaseAttestation({
    repositoryRoot: root,
    frontendBuildId,
    frontendReceiptPath,
    generatedAt: "2026-08-28T00:00:00.000Z",
  });

  assert.equal(result.attestation.identity.identifier, "com.orquesta.desktop.next");
  assert.equal(result.attestation.installers.length, 2);
  assert.equal(result.attestation.installedExecutables.nsis.bundleType, "nsis");
  assert.notEqual(result.attestation.installedExecutables.nsis.sha256, result.attestation.executable.sha256);
  assert.equal(
    verifyDesktopReleaseAttestation({
      repositoryRoot: root,
      attestationPath: result.outputPath,
      desktopExe: executable,
    }).executable.sha256,
    result.attestation.executable.sha256,
  );
  const releaseSet = writeDesktopReleaseSetReceipt({
    repositoryRoot: root,
    attestationPath: result.outputPath,
    generatedAt: "2026-08-28T00:00:01.000Z",
  });
  assert.equal(
    verifyDesktopReleaseSet({
      releaseSetPath: releaseSet.outputPath,
      desktopExe: executable,
      attestationPath: result.outputPath,
    }).receipt.frontendBuildId,
    frontendBuildId,
  );
});

test("atomic release writers remove their owned temporary file when the final rename fails", () => {
  const { root, frontendBuildId, frontendReceiptPath } = fixture();
  const releaseRoot = path.join(root, "apps", "orquesta-desktop-next", "src-tauri", "target", "release");
  const attestationName = "orquesta-desktop-next.release-attestation.json";
  const attestationPath = path.join(releaseRoot, attestationName);
  mkdirSync(attestationPath);
  let attestationFailure;
  try {
    writeDesktopReleaseAttestation({ repositoryRoot: root, frontendBuildId, frontendReceiptPath });
  } catch (error) {
    attestationFailure = error;
  }
  assert.ok(attestationFailure instanceof Error);
  assert.equal(attestationFailure.desktopLifecyclePreserveLock, undefined);
  assert.deepEqual(
    readdirSync(releaseRoot).filter((name) => name.startsWith(`${attestationName}.`) && name.endsWith(".tmp")),
    [],
  );
  rmSync(attestationPath, { recursive: true });

  const attested = writeDesktopReleaseAttestation({ repositoryRoot: root, frontendBuildId, frontendReceiptPath });
  const releaseSetName = "orquesta-desktop-next.release-set.json";
  const releaseSetPath = path.join(releaseRoot, releaseSetName);
  mkdirSync(releaseSetPath);
  let releaseSetFailure;
  try {
    writeDesktopReleaseSetReceipt({ repositoryRoot: root, attestationPath: attested.outputPath });
  } catch (error) {
    releaseSetFailure = error;
  }
  assert.ok(releaseSetFailure instanceof Error);
  assert.equal(releaseSetFailure.desktopLifecyclePreserveLock, undefined);
  assert.deepEqual(
    readdirSync(releaseRoot).filter((name) => name.startsWith(`${releaseSetName}.`) && name.endsWith(".tmp")),
    [],
  );
});

test("rejects a renamed executable with the expected basename", () => {
  const { root, frontendBuildId, frontendReceiptPath } = fixture();
  const result = writeDesktopReleaseAttestation({
    repositoryRoot: root,
    frontendBuildId,
    frontendReceiptPath,
  });
  const fake = write(root, "fake/orquesta-desktop-next.exe", "retired executable renamed");

  assert.throws(
    () => verifyDesktopReleaseAttestation({ repositoryRoot: root, attestationPath: result.outputPath, desktopExe: fake }),
    /executable_hash_mismatch/u,
  );
});

test("rejects a release root redirected through another checkout", () => {
  const { root, frontendBuildId, frontendReceiptPath } = fixture();
  const releaseRoot = path.join(root, "apps", "orquesta-desktop-next", "src-tauri", "target", "release");
  const foreignRoot = mkdtempSync(path.join(os.tmpdir(), "orquesta-release-foreign-"));
  roots.push(foreignRoot);
  const foreignRelease = path.join(foreignRoot, "release");
  renameSync(releaseRoot, foreignRelease);
  symlinkSync(foreignRelease, releaseRoot, process.platform === "win32" ? "junction" : "dir");

  assert.throws(
    () => writeDesktopReleaseAttestation({ repositoryRoot: root, frontendBuildId, frontendReceiptPath }),
    /release_root_not_plain_directory/u,
  );
});

test("rejects changed source identity and installer bytes", () => {
  const first = fixture();
  const firstResult = writeDesktopReleaseAttestation({
    repositoryRoot: first.root,
    frontendBuildId: first.frontendBuildId,
    frontendReceiptPath: first.frontendReceiptPath,
  });
  write(first.root, "apps/orquesta-desktop-next/package.json", JSON.stringify({
    name: "@orquesta/desktop-next",
    productName: "Orquesta Next",
    version: "0.5.1-next.0",
  }));
  assert.throws(
    () => verifyDesktopReleaseAttestation({
      repositoryRoot: first.root,
      attestationPath: firstResult.outputPath,
      desktopExe: first.executable,
    }),
    /attestation_identity_mismatch/u,
  );

  const second = fixture();
  const secondResult = writeDesktopReleaseAttestation({
    repositoryRoot: second.root,
    frontendBuildId: second.frontendBuildId,
    frontendReceiptPath: second.frontendReceiptPath,
  });
  write(second.root, "apps/orquesta-desktop-next/src-tauri/target/release/bundle/msi/Orquesta Next_0.5.0-0_x64_en-US.msi", "changed");
  assert.throws(
    () => verifyDesktopReleaseAttestation({
      repositoryRoot: second.root,
      attestationPath: secondResult.outputPath,
      desktopExe: second.executable,
    }),
    /installer_hash_mismatch/u,
  );
});

test("rejects an old release after a renderer, Rust, or compile-time asset input changes", () => {
  const renderer = fixture();
  const rendererAttestation = writeDesktopReleaseAttestation({
    repositoryRoot: renderer.root,
    frontendBuildId: renderer.frontendBuildId,
    frontendReceiptPath: renderer.frontendReceiptPath,
  });
  write(renderer.root, "apps/orquesta-desktop-next/src/fixture-input.txt", "changed renderer source\n");
  assert.throws(
    () => verifyDesktopReleaseAttestation({
      repositoryRoot: renderer.root,
      attestationPath: rendererAttestation.outputPath,
      desktopExe: renderer.executable,
    }),
    /build_inputs_source_changed/u,
  );

  const rust = fixture();
  const rustAttestation = writeDesktopReleaseAttestation({
    repositoryRoot: rust.root,
    frontendBuildId: rust.frontendBuildId,
    frontendReceiptPath: rust.frontendReceiptPath,
  });
  write(rust.root, "apps/orquesta-desktop-next/src-tauri/src/fixture-input.txt", "changed Rust source\n");
  assert.throws(
    () => verifyDesktopReleaseAttestation({
      repositoryRoot: rust.root,
      attestationPath: rustAttestation.outputPath,
      desktopExe: rust.executable,
    }),
    /build_inputs_source_changed/u,
  );

  const assetCatalog = fixture();
  const assetCatalogAttestation = writeDesktopReleaseAttestation({
    repositoryRoot: assetCatalog.root,
    frontendBuildId: assetCatalog.frontendBuildId,
    frontendReceiptPath: assetCatalog.frontendReceiptPath,
  });
  write(assetCatalog.root, "docs/dependencies/desktop-assets.json", "changed compile-time asset catalog\n");
  assert.throws(
    () => verifyDesktopReleaseAttestation({
      repositoryRoot: assetCatalog.root,
      attestationPath: assetCatalogAttestation.outputPath,
      desktopExe: assetCatalog.executable,
    }),
    /build_inputs_source_changed/u,
  );
});

test("rejects a build when inputs change after the pre-build snapshot", () => {
  const { root, frontendBuildId, frontendReceiptPath } = fixture();
  const before = snapshotDesktopBuildInputs(root);
  write(root, "apps/orquesta-desktop-next/src/fixture-input.txt", "changed during build\n");
  assert.throws(
    () => buildDesktopReleaseAttestation({
      repositoryRoot: root,
      frontendBuildId,
      frontendReceiptPath,
      expectedBuildInputs: before,
    }),
    /build_inputs_changed_during_build/u,
  );
});

test("rejects stale packaged runtime before producing evidence", () => {
  const { root, frontendBuildId, frontendReceiptPath } = fixture();
  write(root, "apps/orquesta-desktop-next/src-tauri/target/release/runtime-dist/sidecar.cjs", "stale");

  assert.throws(
    () => buildDesktopReleaseAttestation({
      repositoryRoot: root,
      frontendBuildId,
      frontendReceiptPath,
    }),
    /runtime_tree_mismatch/u,
  );
});

test("rejects an extra installer left in the shared release bundle", () => {
  const { root, frontendBuildId, frontendReceiptPath } = fixture();
  write(root, "apps/orquesta-desktop-next/src-tauri/target/release/bundle/msi/stale-installer-note.txt", "old");
  assert.throws(
    () => buildDesktopReleaseAttestation({ repositoryRoot: root, frontendBuildId, frontendReceiptPath }),
    /installer_set_mismatch/u,
  );
});

test("portable launch verification needs only the attestation and installed executable", () => {
  const { root, executable, frontendBuildId, frontendReceiptPath } = fixture();
  const result = writeDesktopReleaseAttestation({ repositoryRoot: root, frontendBuildId, frontendReceiptPath });
  const installedRoot = mkdtempSync(path.join(os.tmpdir(), "orquesta-installed-"));
  roots.push(installedRoot);
  const installedExecutable = write(
    installedRoot,
    "orquesta-desktop-next.exe",
    bundleExecutable(readFileSync(executable), "nsis"),
  );

  assert.equal(
    verifyDesktopLaunchIdentity({
      attestationPath: result.outputPath,
      desktopExe: installedExecutable,
      bundleType: "nsis",
    }).identity.identifier,
    "com.orquesta.desktop.next",
  );
  assert.throws(
    () => verifyDesktopLaunchIdentity({ attestationPath: result.outputPath, desktopExe: installedExecutable }),
    /executable_hash_mismatch/u,
  );
  assert.notEqual(path.dirname(executable), path.dirname(installedExecutable));
});

test("portable release-set verification binds the copied executable and attestation", () => {
  const { root, frontendBuildId, frontendReceiptPath } = fixture();
  const attested = writeDesktopReleaseAttestation({ repositoryRoot: root, frontendBuildId, frontendReceiptPath });
  const releaseSet = writeDesktopReleaseSetReceipt({ repositoryRoot: root, attestationPath: attested.outputPath });
  const installedRoot = mkdtempSync(path.join(os.tmpdir(), "orquesta-installed-current-"));
  roots.push(installedRoot);
  const installedExecutable = path.join(installedRoot, "orquesta-desktop-next.exe");
  const installedAttestation = path.join(installedRoot, "orquesta-desktop-next.release-attestation.json");
  const installedReceipt = path.join(installedRoot, "orquesta-desktop-next.release-set.json");
  writeFileSync(
    installedExecutable,
    bundleExecutable(
      readFileSync(path.join(root, "apps/orquesta-desktop-next/src-tauri/target/release/orquesta-desktop-next.exe")),
      "nsis",
    ),
  );
  copyFileSync(attested.outputPath, installedAttestation);
  copyFileSync(releaseSet.outputPath, installedReceipt);
  assert.equal(
    verifyDesktopReleaseSet({
      releaseSetPath: installedReceipt,
      desktopExe: installedExecutable,
      attestationPath: installedAttestation,
      bundleType: "nsis",
    }).attestation.frontendBuildId,
    frontendBuildId,
  );
  writeFileSync(installedAttestation, "{}\n", "utf8");
  assert.throws(
    () => verifyDesktopReleaseSet({
      releaseSetPath: installedReceipt,
      desktopExe: installedExecutable,
      attestationPath: installedAttestation,
      bundleType: "nsis",
    }),
    /attestation|schema/u,
  );
});

test("rejects a release executable without exactly one Tauri bundle marker", () => {
  const missing = fixture();
  writeFileSync(missing.executable, "current desktop executable");
  assert.throws(
    () => buildDesktopReleaseAttestation({
      repositoryRoot: missing.root,
      frontendBuildId: missing.frontendBuildId,
      frontendReceiptPath: missing.frontendReceiptPath,
    }),
    /bundle_marker_missing/u,
  );

  const ambiguous = fixture();
  writeFileSync(
    ambiguous.executable,
    "__TAURI_BUNDLE_TYPE_VAR_UNK __TAURI_BUNDLE_TYPE_VAR_UNK",
  );
  assert.throws(
    () => buildDesktopReleaseAttestation({
      repositoryRoot: ambiguous.root,
      frontendBuildId: ambiguous.frontendBuildId,
      frontendReceiptPath: ambiguous.frontendReceiptPath,
    }),
    /bundle_marker_ambiguous/u,
  );
});

test("rejects the retired receipt that falsely claimed current authority", () => {
  const { root, executable, frontendBuildId, frontendReceiptPath } = fixture();
  const attested = writeDesktopReleaseAttestation({ repositoryRoot: root, frontendBuildId, frontendReceiptPath });
  const retiredReceipt = write(
    root,
    "apps/orquesta-desktop-next/src-tauri/target/release/orquesta-desktop-next.release-set.json",
    JSON.stringify({ schemaVersion: 1, kind: "orquesta-desktop-current-release" }),
  );
  assert.throws(
    () => verifyDesktopReleaseSet({
      releaseSetPath: retiredReceipt,
      desktopExe: executable,
      attestationPath: attested.outputPath,
    }),
    /release_set_receipt_invalid/u,
  );
});
