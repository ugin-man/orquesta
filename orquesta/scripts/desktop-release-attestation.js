"use strict";

const { createHash, randomUUID } = require("node:crypto");
const {
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  closeSync,
  lstatSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} = require("node:fs");
const path = require("node:path");

const SCHEMA_VERSION = 2;
const RELEASE_SET_RECEIPT_NAME = "orquesta-desktop-next.release-set.json";
const BUILD_INPUT_SCOPE_VERSION = 1;
const BUILD_INPUT_MANIFEST_RELATIVE_PATH = "apps/orquesta-desktop-next/scripts/desktop-build-inputs.v1.json";
const BUNDLE_EXECUTABLE_DERIVATION = "tauri-bundle-type-marker-v1";
const SOURCE_BUNDLE_MARKER = "__TAURI_BUNDLE_TYPE_VAR_UNK";
const BUNDLE_EXECUTABLE_MARKERS = Object.freeze({
  msi: "__TAURI_BUNDLE_TYPE_VAR_MSI",
  nsis: "__TAURI_BUNDLE_TYPE_VAR_NSS",
});
const EXPECTED_IDENTITY = Object.freeze({
  packageName: "@orquesta/desktop-next",
  productName: "Orquesta Next",
  identifier: "com.orquesta.desktop.next",
  executableName: process.platform === "win32" ? "orquesta-desktop-next.exe" : "orquesta-desktop-next",
});
const SOURCE_SENTINELS = Object.freeze([
  "apps/orquesta-desktop-next/package.json",
  "apps/orquesta-desktop-next/src-tauri/tauri.conf.json",
  "apps/orquesta-desktop-next/src-tauri/Cargo.toml",
]);

function slash(value) {
  return value.split(path.sep).join("/");
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(filePath) {
  const descriptor = openSync(filePath, "r");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

function installedExecutableVariants(executablePath, recordPath) {
  const original = readFileSync(executablePath);
  const sourceMarker = Buffer.from(SOURCE_BUNDLE_MARKER, "ascii");
  const markerOffset = original.indexOf(sourceMarker);
  if (markerOffset < 0) throw new Error("desktop_release_executable_bundle_marker_missing");
  if (original.indexOf(sourceMarker, markerOffset + sourceMarker.length) >= 0) {
    throw new Error("desktop_release_executable_bundle_marker_ambiguous");
  }
  const variants = {
    derivation: BUNDLE_EXECUTABLE_DERIVATION,
    markerOffset,
  };
  for (const [bundleType, marker] of Object.entries(BUNDLE_EXECUTABLE_MARKERS)) {
    const installed = Buffer.from(original);
    Buffer.from(marker, "ascii").copy(installed, markerOffset);
    variants[bundleType] = {
      path: recordPath,
      bundleType,
      marker,
      bytes: installed.length,
      sha256: sha256Bytes(installed),
    };
  }
  return variants;
}

function within(root, candidate, label) {
  const rootPath = path.resolve(root);
  const candidatePath = path.resolve(candidate);
  if (candidatePath !== rootPath && !candidatePath.startsWith(`${rootPath}${path.sep}`)) {
    throw new Error(`${label}_outside_artifact_root`);
  }
  return candidatePath;
}

function samePath(left, right) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function assertPlainDirectory(directoryPath, label) {
  const resolved = path.resolve(directoryPath);
  const metadata = lstatSync(resolved);
  if (
    !metadata.isDirectory()
    || metadata.isSymbolicLink()
    || !samePath(realpathSync(resolved), resolved)
  ) {
    throw new Error(`${label}_not_plain_directory`);
  }
  return resolved;
}

function assertPlainFile(filePath, label, requireExactPath = false) {
  const resolved = path.resolve(filePath);
  const metadata = lstatSync(resolved);
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || (requireExactPath && !samePath(realpathSync(resolved), resolved))
  ) {
    throw new Error(`${label}_not_plain_file`);
  }
  return { resolved, metadata };
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function removeOwnedAtomicTemporaryFile(temporaryPath, expectedBytes) {
  try {
    lstatSync(temporaryPath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  const { resolved } = assertPlainFile(temporaryPath, "desktop_release_atomic_temporary", true);
  const actualBytes = readFileSync(resolved);
  if (!actualBytes.equals(expectedBytes)) {
    throw new Error("desktop_release_atomic_temporary_content_mismatch");
  }
  unlinkSync(resolved);
}

function writeAtomicJson(outputPath, payload) {
  const expectedBytes = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
  const temporaryPath = `${outputPath}.${randomUUID()}.tmp`;
  let writeCompleted = false;
  try {
    writeFileSync(temporaryPath, expectedBytes, { flag: "wx" });
    writeCompleted = true;
    renameSync(temporaryPath, outputPath);
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    if (writeCompleted || failure.code !== "EEXIST") {
      try {
        removeOwnedAtomicTemporaryFile(temporaryPath, expectedBytes);
      } catch (cleanupError) {
        failure.desktopReleaseAtomicCleanupError = cleanupError instanceof Error
          ? cleanupError.message
          : String(cleanupError);
        failure.desktopLifecyclePreserveLock = true;
      }
    }
    throw failure;
  }
}

function readBuildInputManifest(repositoryRoot) {
  const manifest = readJson(path.join(repositoryRoot, BUILD_INPUT_MANIFEST_RELATIVE_PATH));
  if (
    manifest?.schemaVersion !== BUILD_INPUT_SCOPE_VERSION
    || !Array.isArray(manifest.files)
    || !Array.isArray(manifest.directories)
  ) {
    throw new Error("desktop_release_build_input_manifest_invalid");
  }
  const validateEntries = (entries, label) => {
    const normalized = entries.map((entry) => {
      if (
        typeof entry !== "string"
        || entry.length === 0
        || entry.includes("\\")
        || path.posix.isAbsolute(entry)
        || entry.split("/").includes("..")
      ) throw new Error(`desktop_release_build_input_manifest_${label}_invalid`);
      return entry;
    });
    if (
      new Set(normalized).size !== normalized.length
      || JSON.stringify(normalized) !== JSON.stringify([...normalized].sort())
    ) throw new Error(`desktop_release_build_input_manifest_${label}_not_canonical`);
    return normalized;
  };
  const files = validateEntries(manifest.files, "files");
  const directories = validateEntries(manifest.directories, "directories");
  if (!files.includes(BUILD_INPUT_MANIFEST_RELATIVE_PATH)) {
    throw new Error("desktop_release_build_input_manifest_not_self_bound");
  }
  return { schemaVersion: manifest.schemaVersion, files, directories };
}

function currentIdentity(repositoryRoot) {
  const packageJson = readJson(path.join(repositoryRoot, "apps", "orquesta-desktop-next", "package.json"));
  const tauriConfig = readJson(path.join(
    repositoryRoot,
    "apps",
    "orquesta-desktop-next",
    "src-tauri",
    "tauri.conf.json",
  ));
  const identity = {
    packageName: packageJson.name,
    productName: packageJson.productName,
    packageVersion: packageJson.version,
    identifier: tauriConfig.identifier,
    tauriVersion: tauriConfig.version,
    tauriProductName: tauriConfig.productName,
    executableName: EXPECTED_IDENTITY.executableName,
  };
  if (
    identity.packageName !== EXPECTED_IDENTITY.packageName
    || identity.productName !== EXPECTED_IDENTITY.productName
    || identity.identifier !== EXPECTED_IDENTITY.identifier
    || identity.tauriProductName !== EXPECTED_IDENTITY.productName
    || typeof identity.packageVersion !== "string"
    || typeof identity.tauriVersion !== "string"
  ) {
    throw new Error("desktop_release_source_identity_mismatch");
  }
  return identity;
}

function artifactRecord(artifactRoot, filePath) {
  const absolutePath = within(artifactRoot, filePath, "desktop_release_artifact");
  const { metadata: info } = assertPlainFile(absolutePath, "desktop_release_artifact", true);
  return {
    path: slash(path.relative(path.resolve(artifactRoot), absolutePath)),
    bytes: info.size,
    sha256: sha256File(absolutePath),
  };
}

function snapshotTree(root) {
  const resolvedRoot = assertPlainDirectory(root, "desktop_release_tree_root");
  const records = [];
  function visit(current) {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const target = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error("desktop_release_tree_symbolic_link");
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) records.push(artifactRecord(resolvedRoot, target));
      else throw new Error("desktop_release_tree_non_regular_entry");
    }
  }
  visit(resolvedRoot);
  const totalBytes = records.reduce((total, record) => total + record.bytes, 0);
  return {
    files: records.length,
    totalBytes,
    sha256: sha256Bytes(JSON.stringify(records)),
  };
}

function snapshotDesktopBuildInputs(repositoryRoot) {
  const artifactRoot = path.resolve(repositoryRoot);
  const manifest = readBuildInputManifest(artifactRoot);
  const records = [];
  function visit(target) {
    const metadata = lstatSync(target);
    if (metadata.isSymbolicLink()) throw new Error("desktop_release_build_input_symbolic_link");
    if (metadata.isFile()) {
      records.push(artifactRecord(artifactRoot, target));
      return;
    }
    if (!metadata.isDirectory()) throw new Error("desktop_release_build_input_non_regular_entry");
    for (const entry of readdirSync(target, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      visit(path.join(target, entry.name));
    }
  }
  for (const relativePath of manifest.files) visit(path.join(artifactRoot, relativePath));
  for (const relativePath of manifest.directories) visit(path.join(artifactRoot, relativePath));
  records.sort((left, right) => left.path.localeCompare(right.path));
  return {
    scopeVersion: BUILD_INPUT_SCOPE_VERSION,
    files: records.length,
    totalBytes: records.reduce((total, record) => total + record.bytes, 0),
    sha256: sha256Bytes(JSON.stringify(records)),
  };
}

function assertSameTree(source, packaged, label) {
  if (
    source.files !== packaged.files
    || source.totalBytes !== packaged.totalBytes
    || source.sha256 !== packaged.sha256
  ) {
    throw new Error(`desktop_release_${label}_tree_mismatch`);
  }
}

function expectedReleaseInstallers(releaseRoot, identity) {
  const architecture = { x64: "x64", arm64: "arm64" }[process.arch];
  if (!architecture) throw new Error("desktop_release_architecture_unsupported");
  const stem = `${identity.productName}_${identity.tauriVersion}_${architecture}`;
  return [
    path.join(releaseRoot, "bundle", "msi", `${stem}_en-US.msi`),
    path.join(releaseRoot, "bundle", "nsis", `${stem}-setup.exe`),
  ];
}

function assertExactInstallerSet(releaseRoot, identity) {
  const expected = expectedReleaseInstallers(releaseRoot, identity).map((entry) => path.resolve(entry)).sort();
  const actual = [];
  for (const bundleType of ["msi", "nsis"]) {
    const directory = assertPlainDirectory(
      path.join(releaseRoot, "bundle", bundleType),
      `desktop_release_${bundleType}_installer_root`,
    );
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error("desktop_release_installer_set_mismatch");
      }
      const installerPath = path.resolve(directory, entry.name);
      assertPlainFile(installerPath, "desktop_release_installer", true);
      actual.push(installerPath);
    }
  }
  actual.sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("desktop_release_installer_set_mismatch");
  }
  return expected;
}

function buildDesktopReleaseAttestation({
  repositoryRoot,
  frontendBuildId,
  frontendReceiptPath,
  expectedBuildInputs,
  generatedAt = new Date().toISOString(),
} = {}) {
  const artifactRoot = path.resolve(repositoryRoot);
  const appRoot = path.join(artifactRoot, "apps", "orquesta-desktop-next");
  const releaseRoot = path.join(appRoot, "src-tauri", "target", "release");
  assertPlainDirectory(releaseRoot, "desktop_release_release_root");
  const executablePath = path.join(releaseRoot, EXPECTED_IDENTITY.executableName);
  const runtimeSource = snapshotTree(path.join(appRoot, "runtime-dist"));
  const runtimePackaged = snapshotTree(path.join(releaseRoot, "runtime-dist"));
  const codexSource = snapshotTree(path.join(appRoot, "codex-runtime"));
  const codexPackaged = snapshotTree(path.join(releaseRoot, "codex-runtime"));
  assertSameTree(runtimeSource, runtimePackaged, "runtime");
  assertSameTree(codexSource, codexPackaged, "codex_runtime");
  if (typeof frontendBuildId !== "string" || !/^[0-9a-f-]{36}$/u.test(frontendBuildId)) {
    throw new Error("desktop_release_frontend_build_id_invalid");
  }
  const identity = currentIdentity(artifactRoot);
  const buildInputs = snapshotDesktopBuildInputs(artifactRoot);
  if (expectedBuildInputs && JSON.stringify(expectedBuildInputs) !== JSON.stringify(buildInputs)) {
    throw new Error("desktop_release_build_inputs_changed_during_build");
  }
  const frontendReceipt = readJson(frontendReceiptPath);
  if (frontendReceipt?.buildId !== frontendBuildId) {
    throw new Error("desktop_release_frontend_receipt_identity_mismatch");
  }
  const executable = artifactRecord(artifactRoot, executablePath);
  return {
    schemaVersion: SCHEMA_VERSION,
    identity,
    frontendBuildId,
    generatedAt,
    buildInputs,
    frontendReceipt: artifactRecord(artifactRoot, frontendReceiptPath),
    sourceSentinels: SOURCE_SENTINELS.map((relativePath) => artifactRecord(artifactRoot, path.join(artifactRoot, relativePath))),
    runtimeTrees: {
      runtimeDist: runtimeSource,
      codexRuntime: codexSource,
    },
    codexRuntimeManifest: artifactRecord(artifactRoot, path.join(appRoot, "codex-runtime", "runtime-manifest.json")),
    executable,
    installedExecutables: installedExecutableVariants(executablePath, executable.path),
    installers: assertExactInstallerSet(releaseRoot, identity).map((filePath) => artifactRecord(artifactRoot, filePath)),
  };
}

function writeDesktopReleaseAttestation({
  repositoryRoot,
  frontendBuildId,
  frontendReceiptPath,
  expectedBuildInputs,
  generatedAt,
} = {}) {
  const artifactRoot = path.resolve(repositoryRoot);
  const releaseRoot = path.join(artifactRoot, "apps", "orquesta-desktop-next", "src-tauri", "target", "release");
  const outputPath = path.join(releaseRoot, "orquesta-desktop-next.release-attestation.json");
  const attestation = buildDesktopReleaseAttestation({
    repositoryRoot: artifactRoot,
    frontendBuildId,
    frontendReceiptPath,
    expectedBuildInputs,
    generatedAt,
  });
  writeAtomicJson(outputPath, attestation);
  return { attestation, outputPath };
}

function assertRecordMatches(artifactRoot, record, label, fileOverride) {
  if (!record || typeof record.path !== "string" || !/^[a-f0-9]{64}$/u.test(record.sha256 ?? "")) {
    throw new Error(`desktop_release_${label}_record_invalid`);
  }
  const filePath = fileOverride || within(artifactRoot, path.join(artifactRoot, record.path), label);
  const { metadata: info } = assertPlainFile(filePath, `desktop_release_${label}`);
  if (info.size !== record.bytes || sha256File(filePath) !== record.sha256) {
    throw new Error(`desktop_release_${label}_hash_mismatch`);
  }
}

function assertPortableAttestation(attestation) {
  if (attestation?.schemaVersion !== SCHEMA_VERSION) throw new Error("desktop_release_attestation_schema_mismatch");
  const identity = attestation?.identity;
  if (
    identity?.packageName !== EXPECTED_IDENTITY.packageName
    || identity?.productName !== EXPECTED_IDENTITY.productName
    || identity?.tauriProductName !== EXPECTED_IDENTITY.productName
    || identity?.identifier !== EXPECTED_IDENTITY.identifier
    || identity?.executableName !== EXPECTED_IDENTITY.executableName
    || typeof identity?.packageVersion !== "string"
    || typeof identity?.tauriVersion !== "string"
  ) {
    throw new Error("desktop_release_attestation_identity_mismatch");
  }
  if (!/^[0-9a-f-]{36}$/u.test(attestation.frontendBuildId ?? "")) {
    throw new Error("desktop_release_frontend_build_id_invalid");
  }
  if (!attestation.frontendReceipt || !attestation.codexRuntimeManifest) {
    throw new Error("desktop_release_build_receipts_missing");
  }
  if (
    attestation.buildInputs?.scopeVersion !== BUILD_INPUT_SCOPE_VERSION
    || !Number.isSafeInteger(attestation.buildInputs?.files)
    || !Number.isSafeInteger(attestation.buildInputs?.totalBytes)
    || !/^[a-f0-9]{64}$/u.test(attestation.buildInputs?.sha256 ?? "")
  ) {
    throw new Error("desktop_release_build_inputs_invalid");
  }
  if (!Array.isArray(attestation.installers) || attestation.installers.length !== 2) {
    throw new Error("desktop_release_installer_records_invalid");
  }
  if (
    attestation.installedExecutables?.derivation !== BUNDLE_EXECUTABLE_DERIVATION
    || !Number.isSafeInteger(attestation.installedExecutables?.markerOffset)
    || attestation.installedExecutables.markerOffset < 0
  ) {
    throw new Error("desktop_release_installed_executable_variants_invalid");
  }
  for (const [bundleType, marker] of Object.entries(BUNDLE_EXECUTABLE_MARKERS)) {
    const record = attestation.installedExecutables[bundleType];
    if (
      record?.bundleType !== bundleType
      || record?.path !== attestation.executable?.path
      || record?.marker !== marker
      || !Number.isSafeInteger(record?.bytes)
      || record.bytes <= 0
      || !/^[a-f0-9]{64}$/u.test(record?.sha256 ?? "")
    ) {
      throw new Error("desktop_release_installed_executable_variant_invalid");
    }
  }
}

function portableArtifactRecord(filePath) {
  const { metadata: info } = assertPlainFile(filePath, "desktop_release_set_artifact");
  return { name: path.basename(filePath), bytes: info.size, sha256: sha256File(filePath) };
}

function assertPortableArtifactRecord(record, filePath, label) {
  if (
    !record
    || record.name !== path.basename(filePath)
    || !/^[a-f0-9]{64}$/u.test(record.sha256 ?? "")
  ) {
    throw new Error(`desktop_release_set_${label}_record_invalid`);
  }
  const { metadata: info } = assertPlainFile(filePath, `desktop_release_set_${label}`);
  if (info.size !== record.bytes || sha256File(filePath) !== record.sha256) {
    throw new Error(`desktop_release_set_${label}_hash_mismatch`);
  }
}

function writeDesktopReleaseSetReceipt({
  repositoryRoot,
  attestationPath,
  generatedAt = new Date().toISOString(),
} = {}) {
  const artifactRoot = path.resolve(repositoryRoot);
  const releaseRoot = path.join(artifactRoot, "apps", "orquesta-desktop-next", "src-tauri", "target", "release");
  assertPlainDirectory(releaseRoot, "desktop_release_release_root");
  const executablePath = path.join(releaseRoot, EXPECTED_IDENTITY.executableName);
  const outputPath = path.join(releaseRoot, RELEASE_SET_RECEIPT_NAME);
  const attestation = readJson(attestationPath);
  assertPortableAttestation(attestation);
  const receipt = {
    schemaVersion: 1,
    kind: "orquesta-desktop-release-set",
    generatedAt,
    frontendBuildId: attestation.frontendBuildId,
    identity: attestation.identity,
    executable: portableArtifactRecord(executablePath),
    attestation: portableArtifactRecord(attestationPath),
    installers: attestation.installers,
  };
  writeAtomicJson(outputPath, receipt);
  return { outputPath, receipt };
}

function verifyDesktopReleaseSet({ releaseSetPath, desktopExe, attestationPath, bundleType } = {}) {
  const receipt = readJson(releaseSetPath);
  if (receipt?.schemaVersion !== 1 || receipt?.kind !== "orquesta-desktop-release-set") {
    throw new Error("desktop_release_set_receipt_invalid");
  }
  const attestation = readJson(attestationPath);
  assertPortableAttestation(attestation);
  if (
    receipt.frontendBuildId !== attestation.frontendBuildId
    || JSON.stringify(receipt.identity) !== JSON.stringify(attestation.identity)
    || JSON.stringify(receipt.installers) !== JSON.stringify(attestation.installers)
  ) {
    throw new Error("desktop_release_set_identity_mismatch");
  }
  if (
    receipt.executable?.name !== path.basename(attestation.executable.path)
    || receipt.executable?.bytes !== attestation.executable.bytes
    || receipt.executable?.sha256 !== attestation.executable.sha256
  ) {
    throw new Error("desktop_release_set_executable_binding_mismatch");
  }
  assertPortableArtifactRecord(receipt.attestation, attestationPath, "attestation");
  verifyDesktopLaunchIdentity({ attestationPath, desktopExe, bundleType });
  return { receipt, attestation };
}

function verifyDesktopLaunchIdentity({ attestationPath, desktopExe, bundleType } = {}) {
  const attestation = readJson(attestationPath);
  assertPortableAttestation(attestation);
  const normalizedExe = path.resolve(desktopExe);
  if (path.basename(normalizedExe).toLowerCase() !== EXPECTED_IDENTITY.executableName.toLowerCase()) {
    throw new Error("desktop_release_executable_name_mismatch");
  }
  let executableRecord = attestation.executable;
  if (bundleType !== undefined) {
    if (!Object.hasOwn(BUNDLE_EXECUTABLE_MARKERS, bundleType)) {
      throw new Error("desktop_release_bundle_type_invalid");
    }
    executableRecord = attestation.installedExecutables[bundleType];
  }
  assertRecordMatches(path.dirname(normalizedExe), executableRecord, "executable", normalizedExe);
  return attestation;
}

function verifyDesktopReleaseAttestation({
  repositoryRoot,
  attestationPath,
  desktopExe,
} = {}) {
  const artifactRoot = path.resolve(repositoryRoot);
  const attestation = readJson(attestationPath);
  assertPortableAttestation(attestation);
  if (JSON.stringify(attestation.identity) !== JSON.stringify(currentIdentity(artifactRoot))) {
    throw new Error("desktop_release_attestation_identity_mismatch");
  }
  if (JSON.stringify(attestation.buildInputs) !== JSON.stringify(snapshotDesktopBuildInputs(artifactRoot))) {
    throw new Error("desktop_release_build_inputs_source_changed");
  }
  assertRecordMatches(artifactRoot, attestation.frontendReceipt, "frontend_receipt");
  if (!Array.isArray(attestation.sourceSentinels) || attestation.sourceSentinels.length !== SOURCE_SENTINELS.length) {
    throw new Error("desktop_release_source_sentinels_invalid");
  }
  for (let index = 0; index < SOURCE_SENTINELS.length; index += 1) {
    if (attestation.sourceSentinels[index]?.path !== SOURCE_SENTINELS[index]) {
      throw new Error("desktop_release_source_sentinel_path_mismatch");
    }
    assertRecordMatches(artifactRoot, attestation.sourceSentinels[index], "source_sentinel");
  }
  const appRoot = path.join(artifactRoot, "apps", "orquesta-desktop-next");
  const releaseRoot = path.join(appRoot, "src-tauri", "target", "release");
  assertPlainDirectory(releaseRoot, "desktop_release_release_root");
  const expectedInstallerPaths = assertExactInstallerSet(releaseRoot, attestation.identity);
  const runtimeSource = snapshotTree(path.join(appRoot, "runtime-dist"));
  const runtimePackaged = snapshotTree(path.join(releaseRoot, "runtime-dist"));
  const codexSource = snapshotTree(path.join(appRoot, "codex-runtime"));
  const codexPackaged = snapshotTree(path.join(releaseRoot, "codex-runtime"));
  assertRecordMatches(artifactRoot, attestation.codexRuntimeManifest, "codex_runtime_manifest");
  for (const [label, current, packaged] of [
    ["runtime", runtimeSource, runtimePackaged],
    ["codex_runtime", codexSource, codexPackaged],
  ]) {
    const expected = label === "runtime" ? attestation.runtimeTrees?.runtimeDist : attestation.runtimeTrees?.codexRuntime;
    if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error(`desktop_release_${label}_source_changed`);
    assertSameTree(current, packaged, label);
  }
  const normalizedExe = path.resolve(desktopExe);
  if (path.basename(normalizedExe).toLowerCase() !== EXPECTED_IDENTITY.executableName.toLowerCase()) {
    throw new Error("desktop_release_executable_name_mismatch");
  }
  assertRecordMatches(artifactRoot, attestation.executable, "executable", normalizedExe);
  if (
    JSON.stringify(attestation.installedExecutables)
    !== JSON.stringify(installedExecutableVariants(normalizedExe, attestation.executable.path))
  ) {
    throw new Error("desktop_release_installed_executable_variants_mismatch");
  }
  const expectedInstallerRecords = expectedInstallerPaths.map((entry) => slash(path.relative(artifactRoot, entry)));
  if (JSON.stringify(attestation.installers.map((record) => record.path)) !== JSON.stringify(expectedInstallerRecords)) {
    throw new Error("desktop_release_installer_record_path_mismatch");
  }
  for (const record of attestation.installers) assertRecordMatches(artifactRoot, record, "installer");
  return attestation;
}

module.exports = {
  BUILD_INPUT_MANIFEST_RELATIVE_PATH,
  BUILD_INPUT_SCOPE_VERSION,
  BUNDLE_EXECUTABLE_DERIVATION,
  BUNDLE_EXECUTABLE_MARKERS,
  RELEASE_SET_RECEIPT_NAME,
  EXPECTED_IDENTITY,
  SCHEMA_VERSION,
  SOURCE_SENTINELS,
  assertExactInstallerSet,
  buildDesktopReleaseAttestation,
  currentIdentity,
  expectedReleaseInstallers,
  readBuildInputManifest,
  sha256File,
  snapshotDesktopBuildInputs,
  snapshotTree,
  verifyDesktopReleaseAttestation,
  verifyDesktopReleaseSet,
  verifyDesktopLaunchIdentity,
  writeDesktopReleaseSetReceipt,
  writeDesktopReleaseAttestation,
};
