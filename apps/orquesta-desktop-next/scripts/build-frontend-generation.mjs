import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { buildIdPattern, generationMarkerName } from './frontend-generation-policy.mjs';
import { buildDesktopRuntime } from './build-runtime.mjs';
import { generateDesktopBindings } from '../../../packages/contracts/scripts/generate-desktop-bindings.mjs';
import {
  defaultDesktopLifecycleRoot,
  desktopProductRoot,
  withDesktopLifecycleLock,
} from './desktop-lifecycle-lock.mjs';

const require = createRequire(import.meta.url);
const {
  assertExactInstallerSet,
  currentIdentity,
  sha256File,
  snapshotDesktopBuildInputs,
  verifyDesktopReleaseAttestation,
  verifyDesktopReleaseSet,
  writeDesktopReleaseSetReceipt,
  writeDesktopReleaseAttestation,
} = require('../../../orquesta/scripts/desktop-release-attestation.js');
const scriptRoot = dirname(fileURLToPath(import.meta.url));
export const productRoot = desktopProductRoot;
export const defaultStagingRoot = defaultDesktopLifecycleRoot;
const receiptSchemaVersion = 1;
const currentReleasePointerName = 'current-release.json';
const releasePromotionName = 'release-promotion.json';
const releaseAttestationName = 'orquesta-desktop-next.release-attestation.json';
const releaseSetName = 'orquesta-desktop-next.release-set.json';
const releasePromotionSchemaVersion = 1;
const externalCargoOwnerMarkerName = '.orquesta-desktop-build-owner.json';
const defaultCapacity = Object.freeze({
  // One bounded rollover slot lets a verified replacement become current
  // before any previous current generation is eligible for retirement.
  maxGenerationEntries: 9,
  maxReceiptEntries: 16,
  maxReleaseEntries: 32,
  maxReleaseStagingEntries: 1,
  maxTreeEntries: 128,
  maxTotalBytes: 64 * 1024 * 1024,
});
const maxViteBundleEntries = 120;
const maxViteBundleBytes = 60 * 1024 * 1024;

export function boundedViteCapacity({ remainingTreeEntries, remainingBytes }) {
  if (
    !Number.isSafeInteger(remainingTreeEntries) || remainingTreeEntries < 0
    || !Number.isSafeInteger(remainingBytes) || remainingBytes < 0
  ) {
    throw new Error('frontend_generation_invalid_remaining_capacity');
  }
  return {
    maxEntries: Math.min(maxViteBundleEntries, remainingTreeEntries),
    maxBytes: Math.min(maxViteBundleBytes, remainingBytes),
  };
}

function normalizeRelativePath(value) {
  return value.split(sep).join('/');
}

function ensureWithin(root, candidate, label) {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  if (
    normalizedCandidate !== normalizedRoot &&
    !normalizedCandidate.startsWith(`${normalizedRoot}${sep}`)
  ) {
    throw new Error(`${label}_outside_generation`);
  }
  return normalizedCandidate;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function listFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolutePath = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(root, absolutePath)));
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`frontend_generation_non_regular_entry:${normalizeRelativePath(relative(root, absolutePath))}`);
    }
    files.push(normalizeRelativePath(relative(root, absolutePath)));
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function stripUrlSuffix(value) {
  const hashIndex = value.indexOf('#');
  const queryIndex = value.indexOf('?');
  const firstSuffix = [hashIndex, queryIndex]
    .filter((index) => index >= 0)
    .reduce((lowest, index) => Math.min(lowest, index), value.length);
  return value.slice(0, firstSuffix);
}

function localReference(value, fromFile, root) {
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed.startsWith('#') ||
    /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(trimmed)
  ) {
    return null;
  }

  let decoded;
  try {
    decoded = decodeURIComponent(stripUrlSuffix(trimmed));
  } catch {
    throw new Error(`frontend_generation_invalid_reference:${trimmed}`);
  }
  if (!decoded) return null;

  if (!decoded.startsWith('/') && !decoded.startsWith('./') && !decoded.startsWith('../')) {
    return null;
  }

  const absolutePath = decoded.startsWith('/')
    ? resolve(root, `.${decoded}`)
    : resolve(root, dirname(fromFile), decoded);
  ensureWithin(root, absolutePath, 'frontend_reference');
  return normalizeRelativePath(relative(root, absolutePath));
}

function collectMatches(text, expressions) {
  const matches = [];
  for (const expression of expressions) {
    for (const match of text.matchAll(expression)) {
      if (match[1]) matches.push(match[1]);
    }
  }
  return matches;
}

function referencesFor(relativePath, text, root) {
  const extension = extname(relativePath).toLowerCase();
  const references = [];
  if (extension === '.html') {
    references.push(...collectMatches(text, [/(?:src|href)\s*=\s*["']([^"'<>]+)["']/giu]));
  }
  if (extension === '.css') {
    references.push(
      ...collectMatches(text, [
        /url\(\s*["']?([^"')\s]+)["']?\s*\)/giu,
        /@import\s+(?:url\()?\s*["']([^"']+)["']/giu,
      ]),
    );
  }
  if (['.js', '.mjs', '.cjs'].includes(extension)) {
    references.push(
      ...collectMatches(text, [
        /\b(?:import|export)\s*(?:[^"'()]*?\sfrom\s*)?["']([^"']+)["']/gu,
        /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
        /\bnew\s+URL\s*\(\s*["']([^"']+)["']/gu,
        /["'`](\/(?:assets|brand)\/[^"'`?#\s]+(?:[?#][^"'`\s]*)?)["'`]/gu,
      ]),
    );
  }
  return references
    .map((value) => localReference(value, relativePath, root))
    .filter((value) => value !== null);
}

export async function verifyFrontendGeneration(generationDir) {
  const root = resolve(generationDir);
  const rootMetadata = await stat(root);
  if (!rootMetadata.isDirectory()) throw new Error('frontend_generation_not_directory');

  const files = await listFiles(root);
  if (!files.includes('index.html')) throw new Error('frontend_generation_missing_index');

  const available = new Set(files);
  const reached = new Set();
  const queue = ['index.html'];
  while (queue.length > 0) {
    const current = queue.shift();
    if (reached.has(current)) continue;
    if (!available.has(current)) throw new Error(`frontend_generation_missing_asset:${current}`);
    reached.add(current);

    const extension = extname(current).toLowerCase();
    if (!['.html', '.css', '.js', '.mjs', '.cjs'].includes(extension)) continue;
    const text = await readFile(join(root, current), 'utf8');
    for (const referenced of referencesFor(current, text, root)) {
      if (!available.has(referenced)) {
        throw new Error(`frontend_generation_missing_asset:${referenced}`);
      }
      if (!reached.has(referenced)) queue.push(referenced);
    }
  }

  const orphanFiles = files.filter((file) => !reached.has(file));
  if (orphanFiles.length > 0) {
    throw new Error(`frontend_generation_orphan_files:${orphanFiles.join(',')}`);
  }

  const fileRecords = [];
  for (const file of files) {
    const bytes = await readFile(join(root, file));
    fileRecords.push({ path: file, sizeBytes: bytes.byteLength, sha256: sha256(bytes) });
  }
  return {
    files: fileRecords,
    totalBytes: fileRecords.reduce((sum, file) => sum + file.sizeBytes, 0),
  };
}

function canonicalBuildId(value) {
  const buildId = value.trim().toLowerCase();
  if (!buildIdPattern.test(buildId)) throw new Error('frontend_generation_invalid_build_id');
  return buildId;
}

export function generationPaths(stagingRoot, buildId) {
  const canonicalId = canonicalBuildId(buildId);
  const root = resolve(stagingRoot);
  return {
    buildId: canonicalId,
    stagingRoot: root,
    generationDir: join(root, 'generations', canonicalId),
    receiptPath: join(root, 'receipts', `${canonicalId}.json`),
  };
}

export function releasePromotionPaths(stagingRoot, buildId) {
  const paths = generationPaths(stagingRoot, buildId);
  const releasesRoot = join(paths.stagingRoot, 'releases');
  const releaseStagingRoot = join(releasesRoot, 'staging');
  const releaseRoot = join(releasesRoot, paths.buildId);
  return {
    ...paths,
    releasesRoot,
    releaseStagingRoot,
    releaseRoot,
    attestationCopyPath: join(releaseRoot, releaseAttestationName),
    releaseSetCopyPath: join(releaseRoot, releaseSetName),
    promotionPath: join(releaseRoot, releasePromotionName),
    pointerPath: join(paths.stagingRoot, currentReleasePointerName),
  };
}

export function externalCargoTargetDirectory(root = productRoot, environment = process.env) {
  const configured = environment.CARGO_TARGET_DIR;
  if (configured === undefined) return null;
  if (typeof configured !== 'string' || !configured || !isAbsolute(configured)) {
    throw new Error('desktop_release_external_cargo_target_requires_absolute_path');
  }
  const targetRoot = resolve(configured);
  const resolvedProductRoot = resolve(root);
  const repositoryRoot = resolve(resolvedProductRoot, '..', '..');
  if (!samePath(resolvedProductRoot, join(repositoryRoot, 'apps', 'orquesta-desktop-next'))) {
    throw new Error('desktop_release_external_cargo_product_root_invalid');
  }
  const canonicalTargetRoot = join(resolvedProductRoot, 'src-tauri', 'target');
  if (samePath(targetRoot, canonicalTargetRoot)) return null;
  const relativeToProduct = relative(resolvedProductRoot, targetRoot);
  if (
    !relativeToProduct
    || (!relativeToProduct.startsWith(`..${sep}`) && relativeToProduct !== '..' && !isAbsolute(relativeToProduct))
  ) {
    throw new Error('desktop_release_external_cargo_target_inside_product');
  }
  const relativeToRepository = relative(repositoryRoot, targetRoot);
  if (
    !relativeToRepository
    || (!relativeToRepository.startsWith(`..${sep}`) && relativeToRepository !== '..' && !isAbsolute(relativeToRepository))
  ) {
    throw new Error('desktop_release_external_cargo_target_inside_repository');
  }
  return targetRoot;
}

export function desktopReleaseMaterializationPaths({
  root = productRoot,
  buildId,
  ownerId,
  cargoTargetDir,
} = {}) {
  const canonicalBuild = canonicalBuildId(buildId);
  if (!buildIdPattern.test(ownerId ?? '')) {
    throw new Error('desktop_release_materialization_owner_invalid');
  }
  const externalTargetRoot = externalCargoTargetDirectory(root, {
    CARGO_TARGET_DIR: cargoTargetDir,
  });
  if (externalTargetRoot === null) {
    throw new Error('desktop_release_materialization_target_must_be_external');
  }
  const canonicalTargetRoot = join(resolve(root), 'src-tauri', 'target');
  const canonicalReleaseRoot = join(canonicalTargetRoot, 'release');
  return {
    buildId: canonicalBuild,
    ownerId,
    externalTargetRoot,
    externalReleaseRoot: join(externalTargetRoot, 'release'),
    externalOwnerMarkerPath: join(externalTargetRoot, externalCargoOwnerMarkerName),
    canonicalTargetRoot,
    canonicalReleaseRoot,
    temporaryReleaseRoot: join(canonicalTargetRoot, `release.${canonicalBuild}.${ownerId}.tmp`),
  };
}

function externalCargoOwnerMarkerBytes(paths) {
  return Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    kind: 'orquesta-desktop-external-cargo-target-owner',
    buildId: paths.buildId,
    ownerId: paths.ownerId,
  }, null, 2)}\n`, 'utf8');
}

export function tauriBuildOverride(generationDir, root = productRoot) {
  const srcTauriRoot = join(root, 'src-tauri');
  const frontendDist = normalizeRelativePath(relative(srcTauriRoot, resolve(generationDir)));
  if (!frontendDist || isAbsolute(frontendDist)) {
    throw new Error('frontend_generation_invalid_tauri_path');
  }
  return {
    build: {
      beforeBuildCommand: '',
      frontendDist,
    },
  };
}

async function writeReceipt(paths, snapshot, root = productRoot, ownerId = randomUUID()) {
  if (!buildIdPattern.test(ownerId)) throw new Error('frontend_generation_receipt_owner_invalid');
  const receipt = {
    schemaVersion: receiptSchemaVersion,
    buildId: paths.buildId,
    generationDir: paths.generationDir,
    tauriFrontendDist: tauriBuildOverride(paths.generationDir, root).build.frontendDist,
    files: snapshot.files,
    totalBytes: snapshot.totalBytes,
  };
  const temporaryPath = `${paths.receiptPath}.${ownerId}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  await rename(temporaryPath, paths.receiptPath);
  return receipt;
}

export async function readAndVerifyReceipt(stagingRoot, buildId, root = productRoot) {
  const paths = generationPaths(stagingRoot, buildId);
  const receipt = JSON.parse(await readFile(paths.receiptPath, 'utf8'));
  if (
    receipt?.schemaVersion !== receiptSchemaVersion ||
    receipt?.buildId !== paths.buildId ||
    receipt?.generationDir !== paths.generationDir ||
    receipt?.tauriFrontendDist !== tauriBuildOverride(paths.generationDir, root).build.frontendDist
  ) {
    throw new Error('frontend_generation_receipt_identity_mismatch');
  }
  const current = await verifyFrontendGeneration(paths.generationDir);
  if (JSON.stringify(current.files) !== JSON.stringify(receipt.files) || current.totalBytes !== receipt.totalBytes) {
    throw new Error('frontend_generation_receipt_content_mismatch');
  }
  return { paths, receipt };
}

function exactKeys(value, expected) {
  return (
    value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort())
  );
}

function validSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function validIsoTimestamp(value) {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

async function readPlainFileBytes(filePath, label) {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || !samePath(await realpath(filePath), filePath)) {
    throw new Error(`desktop_release_${label}_not_plain_file`);
  }
  return readFile(filePath);
}

async function collectPlainTreeRecords(releaseRoot, directory, records) {
  await assertPlainDirectory(directory, 'materialized_release_tree');
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolutePath = join(directory, entry.name);
    const metadata = await lstat(absolutePath);
    if (metadata.isSymbolicLink()) throw new Error('desktop_release_materialization_reparse_entry');
    if (metadata.isDirectory()) {
      if (!samePath(await realpath(absolutePath), absolutePath)) {
        throw new Error('desktop_release_materialization_reparse_entry');
      }
      await collectPlainTreeRecords(releaseRoot, absolutePath, records);
      continue;
    }
    if (!metadata.isFile() || !samePath(await realpath(absolutePath), absolutePath)) {
      throw new Error('desktop_release_materialization_non_regular_entry');
    }
    const bytes = await readFile(absolutePath);
    records.push({
      path: normalizeRelativePath(relative(releaseRoot, absolutePath)),
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
    });
  }
}

async function snapshotDesktopReleaseSubset(
  releaseRoot,
  { exactRoot = false, allowedReceiptFiles = [], identity } = {},
) {
  const resolvedReleaseRoot = resolve(releaseRoot);
  await assertPlainDirectory(resolvedReleaseRoot, 'materialized_release_root');
  if (exactRoot) {
    const rootEntries = await readdir(resolvedReleaseRoot, { withFileTypes: true });
    const expectedRootEntries = [
      identity.executableName,
      'runtime-dist',
      'codex-runtime',
      'bundle',
      ...allowedReceiptFiles,
    ].sort();
    if (
      rootEntries.some((entry) => entry.isSymbolicLink())
      || JSON.stringify(rootEntries.map((entry) => entry.name).sort()) !== JSON.stringify(expectedRootEntries)
    ) {
      throw new Error('desktop_release_materialization_root_set_invalid');
    }
    const bundleEntries = await readdir(join(resolvedReleaseRoot, 'bundle'), { withFileTypes: true });
    if (
      bundleEntries.some((entry) => !entry.isDirectory() || entry.isSymbolicLink())
      || JSON.stringify(bundleEntries.map((entry) => entry.name).sort()) !== JSON.stringify(['msi', 'nsis'])
    ) {
      throw new Error('desktop_release_materialization_bundle_set_invalid');
    }
    for (const receiptName of allowedReceiptFiles) {
      await readPlainFileBytes(join(resolvedReleaseRoot, receiptName), 'materialized_receipt');
    }
  }

  const records = [];
  const executablePath = join(resolvedReleaseRoot, identity.executableName);
  const executableBytes = await readPlainFileBytes(executablePath, 'materialized_executable');
  records.push({
    path: identity.executableName,
    bytes: executableBytes.byteLength,
    sha256: sha256(executableBytes),
  });
  assertExactInstallerSet(resolvedReleaseRoot, identity);
  for (const relativeDirectory of ['runtime-dist', 'codex-runtime', 'bundle/msi', 'bundle/nsis']) {
    const before = records.length;
    await collectPlainTreeRecords(
      resolvedReleaseRoot,
      join(resolvedReleaseRoot, ...relativeDirectory.split('/')),
      records,
    );
    if (records.length === before) {
      throw new Error(`desktop_release_materialization_empty_subset:${relativeDirectory}`);
    }
  }
  return records.sort((left, right) => left.path.localeCompare(right.path));
}

function assertSameMaterializedRelease(left, right, label) {
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error(`desktop_release_materialization_${label}_mismatch`);
  }
}

export async function preflightExternalDesktopReleaseMaterialization(options = {}) {
  const paths = desktopReleaseMaterializationPaths(options);
  await assertPlainDirectory(dirname(paths.externalTargetRoot), 'external_cargo_target_parent');
  await assertMissingPath(paths.externalTargetRoot, 'external_cargo_target');
  const targetMetadata = await metadataOrNull(paths.canonicalTargetRoot);
  if (targetMetadata !== null) {
    await assertPlainDirectory(paths.canonicalTargetRoot, 'canonical_target_root');
  }
  await assertMissingPath(paths.canonicalReleaseRoot, 'canonical_release');
  await assertMissingPath(paths.temporaryReleaseRoot, 'temporary_release');
  let claimed = false;
  try {
    await mkdir(paths.externalTargetRoot, { recursive: false });
    claimed = true;
    await assertPlainDirectory(paths.externalTargetRoot, 'external_cargo_target');
    const markerBytes = externalCargoOwnerMarkerBytes(paths);
    await writeFile(paths.externalOwnerMarkerPath, markerBytes, { flag: 'wx' });
    const persistedMarker = await readPlainFileBytes(paths.externalOwnerMarkerPath, 'external_cargo_owner');
    if (!persistedMarker.equals(markerBytes)) {
      throw new Error('desktop_release_external_cargo_owner_mismatch');
    }
    return paths;
  } catch (error) {
    if (claimed) {
      try {
        await rm(paths.externalTargetRoot, { recursive: true, force: false });
      } catch (cleanupError) {
        error.desktopReleaseExternalClaimCleanupError = cleanupError instanceof Error
          ? cleanupError.message
          : String(cleanupError);
        error.desktopLifecyclePreserveLock = true;
      }
    }
    throw error;
  }
}

export async function cleanupOwnedExternalCargoTarget({
  root = productRoot,
  buildId,
  ownerId,
  cargoTargetDir,
} = {}) {
  try {
    const paths = desktopReleaseMaterializationPaths({ root, buildId, ownerId, cargoTargetDir });
    await assertPlainDirectory(dirname(paths.externalTargetRoot), 'external_cargo_target_parent');
    const metadata = await metadataOrNull(paths.externalTargetRoot);
    if (metadata === null) return { targetRoot: paths.externalTargetRoot, removed: false };
    await assertPlainDirectory(paths.externalTargetRoot, 'external_cargo_target');
    const markerBytes = await readPlainFileBytes(paths.externalOwnerMarkerPath, 'external_cargo_owner');
    if (!markerBytes.equals(externalCargoOwnerMarkerBytes(paths))) {
      throw new Error('desktop_release_external_cargo_owner_mismatch');
    }
    await rm(paths.externalTargetRoot, { recursive: true, force: false });
    return { targetRoot: paths.externalTargetRoot, removed: true };
  } catch (error) {
    error.desktopLifecyclePreserveLock = true;
    throw error;
  }
}

export async function materializeExternalDesktopRelease(options = {}) {
  const paths = desktopReleaseMaterializationPaths(options);
  const identity = currentIdentity(options.repositoryRoot ?? resolve(options.root ?? productRoot, '..', '..'));
  let staged = false;
  let materialized = false;
  let externalTargetRemoved = false;
  try {
    await assertPlainDirectory(dirname(paths.externalTargetRoot), 'external_cargo_target_parent');
    await assertPlainDirectory(paths.externalTargetRoot, 'external_cargo_target');
    const markerBytes = await readPlainFileBytes(paths.externalOwnerMarkerPath, 'external_cargo_owner');
    if (!markerBytes.equals(externalCargoOwnerMarkerBytes(paths))) {
      throw new Error('desktop_release_external_cargo_owner_mismatch');
    }
    const targetMetadata = await metadataOrNull(paths.canonicalTargetRoot);
    if (targetMetadata !== null) {
      await assertPlainDirectory(paths.canonicalTargetRoot, 'canonical_target_root');
    }
    await assertMissingPath(paths.canonicalReleaseRoot, 'canonical_release');
    await assertMissingPath(paths.temporaryReleaseRoot, 'temporary_release');
    const sourceBefore = await snapshotDesktopReleaseSubset(paths.externalReleaseRoot, { identity });
    try {
      await mkdir(paths.canonicalTargetRoot, { recursive: false });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    await assertPlainDirectory(paths.canonicalTargetRoot, 'canonical_target_root');
    await assertMissingPath(paths.canonicalReleaseRoot, 'canonical_release');
    await assertMissingPath(paths.temporaryReleaseRoot, 'temporary_release');
    await mkdir(paths.temporaryReleaseRoot, { recursive: false });
    staged = true;
    await cp(
      join(paths.externalReleaseRoot, identity.executableName),
      join(paths.temporaryReleaseRoot, identity.executableName),
      { force: false, errorOnExist: true },
    );
    for (const relativeDirectory of ['runtime-dist', 'codex-runtime']) {
      await cp(
        join(paths.externalReleaseRoot, relativeDirectory),
        join(paths.temporaryReleaseRoot, relativeDirectory),
        { recursive: true, force: false, errorOnExist: true },
      );
    }
    await mkdir(join(paths.temporaryReleaseRoot, 'bundle'), { recursive: false });
    for (const relativeDirectory of ['msi', 'nsis']) {
      await cp(
        join(paths.externalReleaseRoot, 'bundle', relativeDirectory),
        join(paths.temporaryReleaseRoot, 'bundle', relativeDirectory),
        { recursive: true, force: false, errorOnExist: true },
      );
    }

    const stagedSnapshot = await snapshotDesktopReleaseSubset(
      paths.temporaryReleaseRoot,
      { exactRoot: true, identity },
    );
    assertSameMaterializedRelease(stagedSnapshot, sourceBefore, 'staged_tree');
    const sourceAfter = await snapshotDesktopReleaseSubset(paths.externalReleaseRoot, { identity });
    assertSameMaterializedRelease(sourceAfter, sourceBefore, 'source_changed_during_copy');
    await cleanupOwnedExternalCargoTarget({
      root: options.root,
      buildId: paths.buildId,
      ownerId: paths.ownerId,
      cargoTargetDir: paths.externalTargetRoot,
    });
    externalTargetRemoved = true;
    await rename(paths.temporaryReleaseRoot, paths.canonicalReleaseRoot);
    staged = false;
    materialized = true;
    const materializedSnapshot = await snapshotDesktopReleaseSubset(
      paths.canonicalReleaseRoot,
      { exactRoot: true, identity },
    );
    assertSameMaterializedRelease(materializedSnapshot, sourceBefore, 'renamed_tree');
    return { paths, snapshot: materializedSnapshot, externalTargetRemoved };
  } catch (error) {
    const cleanupErrors = [];
    try {
      if (materialized) {
        await rename(paths.canonicalReleaseRoot, paths.temporaryReleaseRoot);
        materialized = false;
        staged = true;
      }
      if (staged) {
        await scanTree(paths.temporaryReleaseRoot);
        await rm(paths.temporaryReleaseRoot, { recursive: true, force: false });
      }
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
    }
    if (!externalTargetRemoved) {
      try {
        await cleanupOwnedExternalCargoTarget({
          root: options.root,
          buildId: paths.buildId,
          ownerId: paths.ownerId,
          cargoTargetDir: paths.externalTargetRoot,
        });
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
      }
    }
    if (cleanupErrors.length > 0) {
      error.desktopReleaseMaterializationCleanupError = cleanupErrors.join(';');
      error.desktopLifecyclePreserveLock = true;
    }
    throw error;
  }
}

export async function rollbackMaterializedDesktopRelease({
  expectedSnapshot,
  attestationCreated = false,
  releaseSetCreated = false,
  repositoryRoot,
  ...options
} = {}) {
  const paths = desktopReleaseMaterializationPaths(options);
  const identity = currentIdentity(repositoryRoot ?? resolve(options.root ?? productRoot, '..', '..'));
  const allowedReceiptFiles = [
    ...(attestationCreated ? [releaseAttestationName] : []),
    ...(releaseSetCreated ? [releaseSetName] : []),
  ];
  try {
    await assertMissingPath(paths.temporaryReleaseRoot, 'temporary_release');
    const current = await snapshotDesktopReleaseSubset(paths.canonicalReleaseRoot, {
      exactRoot: true,
      allowedReceiptFiles,
      identity,
    });
    assertSameMaterializedRelease(current, expectedSnapshot, 'rollback_tree');
    await rename(paths.canonicalReleaseRoot, paths.temporaryReleaseRoot);
    const staged = await snapshotDesktopReleaseSubset(paths.temporaryReleaseRoot, {
      exactRoot: true,
      allowedReceiptFiles,
      identity,
    });
    assertSameMaterializedRelease(staged, expectedSnapshot, 'rollback_staged_tree');
    await rm(paths.temporaryReleaseRoot, { recursive: true, force: false });
    return { paths, removed: true };
  } catch (error) {
    error.desktopLifecyclePreserveLock = true;
    throw error;
  }
}

function parseJsonBytes(bytes, label) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`desktop_release_${label}_invalid_json`);
  }
}

function relativeArtifactRecord(stagingRoot, filePath, bytes) {
  const relativePath = normalizeRelativePath(relative(resolve(stagingRoot), resolve(filePath)));
  if (!relativePath || relativePath === '..' || relativePath.startsWith('../') || isAbsolute(relativePath)) {
    throw new Error('desktop_release_promotion_path_outside_staging');
  }
  return { path: relativePath, bytes: bytes.byteLength, sha256: sha256(bytes) };
}

function assertPromotionArtifactRecord(record, expectedPath, label) {
  if (
    !exactKeys(record, ['path', 'bytes', 'sha256'])
    || record.path !== expectedPath
    || !Number.isSafeInteger(record.bytes)
    || record.bytes <= 0
    || !validSha256(record.sha256)
  ) {
    throw new Error(`desktop_release_promotion_${label}_record_invalid`);
  }
}

function assertBytesMatchRecord(bytes, record, label) {
  if (bytes.byteLength !== record.bytes || sha256(bytes) !== record.sha256) {
    throw new Error(`desktop_release_promotion_${label}_hash_mismatch`);
  }
}

async function assertMissingPath(filePath, label) {
  try {
    await lstat(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`desktop_release_${label}_already_exists`);
}

function assertOwnedReleaseStagingPath(paths, stagingReleaseRoot, ownerId) {
  const expected = join(paths.releaseStagingRoot, `${paths.buildId}.${ownerId}.tmp`);
  if (!samePath(stagingReleaseRoot, expected) || !buildIdPattern.test(ownerId)) {
    throw new Error('desktop_release_staging_ownership_invalid');
  }
}

async function writeAtomicPointer(pointerPath, pointerBytes) {
  const temporaryPath = `${pointerPath}.${randomUUID()}.tmp`;
  let writeCompleted = false;
  try {
    await writeFile(temporaryPath, pointerBytes, { flag: 'wx' });
    writeCompleted = true;
    await rename(temporaryPath, pointerPath);
  } catch (error) {
    if (writeCompleted || error?.code !== 'EEXIST') {
      try {
        const temporaryMetadata = await metadataOrNull(temporaryPath);
        if (temporaryMetadata !== null) {
          const actualBytes = await readPlainFileBytes(temporaryPath, 'pointer_temporary');
          if (!actualBytes.equals(pointerBytes)) {
            throw new Error('desktop_release_pointer_temporary_content_mismatch');
          }
          await unlink(temporaryPath);
        }
      } catch (cleanupError) {
        error.desktopReleasePointerCleanupError = cleanupError instanceof Error
          ? cleanupError.message
          : String(cleanupError);
        error.desktopLifecyclePreserveLock = true;
      }
    }
    throw error;
  }
}

export async function promoteDesktopRelease({
  stagingRoot = defaultStagingRoot,
  buildId,
  root = productRoot,
  repositoryRoot = resolve(root, '..', '..'),
  attestationPath = join(root, 'src-tauri', 'target', 'release', releaseAttestationName),
  releaseSetPath = join(root, 'src-tauri', 'target', 'release', releaseSetName),
  desktopExe = join(
    root,
    'src-tauri',
    'target',
    'release',
    process.platform === 'win32' ? 'orquesta-desktop-next.exe' : 'orquesta-desktop-next',
  ),
  promotedAt = new Date().toISOString(),
  ownerId = randomUUID(),
} = {}) {
  const paths = releasePromotionPaths(stagingRoot, buildId);
  if (!samePath(paths.stagingRoot, join(resolve(root), '.build-generations'))) {
    throw new Error('desktop_release_promotion_staging_root_mismatch');
  }
  if (!validIsoTimestamp(promotedAt)) throw new Error('desktop_release_promotion_timestamp_invalid');

  const attestationBytesBefore = await readPlainFileBytes(attestationPath, 'source_attestation');
  const releaseSetBytesBefore = await readPlainFileBytes(releaseSetPath, 'source_release_set');
  const attestation = verifyDesktopReleaseAttestation({
    repositoryRoot,
    attestationPath,
    desktopExe,
  });
  const verifiedSet = verifyDesktopReleaseSet({ releaseSetPath, attestationPath, desktopExe });
  const attestationBytes = await readPlainFileBytes(attestationPath, 'source_attestation');
  const releaseSetBytes = await readPlainFileBytes(releaseSetPath, 'source_release_set');
  if (!attestationBytes.equals(attestationBytesBefore) || !releaseSetBytes.equals(releaseSetBytesBefore)) {
    throw new Error('desktop_release_promotion_source_changed_during_verification');
  }
  if (
    attestation.frontendBuildId !== paths.buildId
    || verifiedSet.attestation.frontendBuildId !== paths.buildId
    || verifiedSet.receipt.frontendBuildId !== paths.buildId
  ) {
    throw new Error('desktop_release_promotion_build_id_mismatch');
  }
  if (sha256File(desktopExe) !== attestation.executable.sha256) {
    throw new Error('desktop_release_promotion_executable_changed_after_verification');
  }
  if (JSON.stringify(snapshotDesktopBuildInputs(repositoryRoot)) !== JSON.stringify(attestation.buildInputs)) {
    throw new Error('desktop_release_promotion_build_inputs_changed_after_verification');
  }

  await readAndVerifyReceipt(paths.stagingRoot, paths.buildId, root);
  const frontendReceiptBytes = await readPlainFileBytes(paths.receiptPath, 'frontend_receipt');
  if (
    frontendReceiptBytes.byteLength !== attestation.frontendReceipt.bytes
    || sha256(frontendReceiptBytes) !== attestation.frontendReceipt.sha256
  ) {
    throw new Error('desktop_release_promotion_frontend_receipt_binding_mismatch');
  }

  const promotion = {
    schemaVersion: releasePromotionSchemaVersion,
    kind: 'orquesta-desktop-release-promotion',
    buildId: paths.buildId,
    promotedAt,
    frontendReceipt: relativeArtifactRecord(paths.stagingRoot, paths.receiptPath, frontendReceiptBytes),
    attestation: relativeArtifactRecord(paths.stagingRoot, paths.attestationCopyPath, attestationBytes),
    releaseSet: relativeArtifactRecord(paths.stagingRoot, paths.releaseSetCopyPath, releaseSetBytes),
    buildInputsSha256: attestation.buildInputs.sha256,
    executableSha256: attestation.executable.sha256,
  };
  const promotionBytes = Buffer.from(`${JSON.stringify(promotion, null, 2)}\n`, 'utf8');
  const pointer = {
    schemaVersion: releasePromotionSchemaVersion,
    kind: 'orquesta-desktop-current-release-pointer',
    buildId: paths.buildId,
    promotion: relativeArtifactRecord(paths.stagingRoot, paths.promotionPath, promotionBytes),
  };
  const pointerBytes = Buffer.from(`${JSON.stringify(pointer, null, 2)}\n`, 'utf8');
  await assertBuildOutputCapacity(paths.stagingRoot, {
    reserveReleaseEntries: 1,
    reserveReleaseStagingEntries: 1,
    reserveTreeEntries: 5,
    reserveBytes:
      attestationBytes.byteLength
      + releaseSetBytes.byteLength
      + promotionBytes.byteLength
      + pointerBytes.byteLength,
  });
  await assertPlainDirectory(paths.releasesRoot, 'release_archive_root');
  await assertPlainDirectory(paths.releaseStagingRoot, 'release_archive_staging_root');
  await assertMissingPath(paths.releaseRoot, 'release_archive_build');

  const stagedReleaseRoot = join(paths.releaseStagingRoot, `${paths.buildId}.${ownerId}.tmp`);
  assertOwnedReleaseStagingPath(paths, stagedReleaseRoot, ownerId);
  let staged = false;
  let promoted = false;
  try {
    await mkdir(stagedReleaseRoot, { recursive: false });
    staged = true;
    await assertPlainDirectory(stagedReleaseRoot, 'release_staging_build_root');
    const stagedAttestationPath = join(stagedReleaseRoot, releaseAttestationName);
    const stagedReleaseSetPath = join(stagedReleaseRoot, releaseSetName);
    const stagedPromotionPath = join(stagedReleaseRoot, releasePromotionName);
    await writeFile(stagedAttestationPath, attestationBytes, { flag: 'wx' });
    await writeFile(stagedReleaseSetPath, releaseSetBytes, { flag: 'wx' });
    await writeFile(stagedPromotionPath, promotionBytes, { flag: 'wx' });

    const stagedEntries = await readdir(stagedReleaseRoot, { withFileTypes: true });
    if (
      stagedEntries.some((entry) => !entry.isFile() || entry.isSymbolicLink())
      || JSON.stringify(stagedEntries.map((entry) => entry.name).sort()) !== JSON.stringify([
        releaseAttestationName,
        releasePromotionName,
        releaseSetName,
      ].sort())
    ) {
      throw new Error('desktop_release_promotion_staging_set_invalid');
    }
    const stagedAttestationBytes = await readPlainFileBytes(stagedAttestationPath, 'staged_attestation');
    const stagedReleaseSetBytes = await readPlainFileBytes(stagedReleaseSetPath, 'staged_release_set');
    const stagedPromotionBytes = await readPlainFileBytes(stagedPromotionPath, 'staged_promotion');
    if (
      !stagedAttestationBytes.equals(attestationBytes)
      || !stagedReleaseSetBytes.equals(releaseSetBytes)
      || !stagedPromotionBytes.equals(promotionBytes)
    ) {
      throw new Error('desktop_release_promotion_staging_bytes_mismatch');
    }
    assertBytesMatchRecord(stagedAttestationBytes, promotion.attestation, 'attestation');
    assertBytesMatchRecord(stagedReleaseSetBytes, promotion.releaseSet, 'release_set');
    if (JSON.stringify(parseJsonBytes(stagedPromotionBytes, 'staged_promotion')) !== JSON.stringify(promotion)) {
      throw new Error('desktop_release_promotion_staging_receipt_mismatch');
    }

    await rename(stagedReleaseRoot, paths.releaseRoot);
    staged = false;
    promoted = true;
    await assertPlainDirectory(paths.releaseRoot, 'release_archive_build_root');
    const persistedPromotionBytes = await readPlainFileBytes(paths.promotionPath, 'promotion_receipt');
    const persistedAttestationBytes = await readPlainFileBytes(paths.attestationCopyPath, 'attestation_copy');
    const persistedReleaseSetBytes = await readPlainFileBytes(paths.releaseSetCopyPath, 'release_set_copy');
    if (
      !persistedPromotionBytes.equals(promotionBytes)
      || !persistedAttestationBytes.equals(attestationBytes)
      || !persistedReleaseSetBytes.equals(releaseSetBytes)
    ) {
      throw new Error('desktop_release_promotion_archive_bytes_mismatch');
    }
    await writeAtomicPointer(paths.pointerPath, pointerBytes);
    return { paths, pointer, promotion };
  } catch (error) {
    try {
      if (promoted) {
        await rename(paths.releaseRoot, stagedReleaseRoot);
        promoted = false;
        staged = true;
      }
      if (staged) {
        assertOwnedReleaseStagingPath(paths, stagedReleaseRoot, ownerId);
        await rm(stagedReleaseRoot, { recursive: true, force: false });
      }
    } catch (cleanupError) {
      error.desktopReleasePromotionCleanupError = cleanupError instanceof Error
        ? cleanupError.message
        : String(cleanupError);
      error.desktopLifecyclePreserveLock = true;
    }
    throw error;
  }
}

async function verifyDesktopReleaseArchiveAt({
  stagingRoot,
  buildId,
  root,
  releaseRoot,
  receiptPath,
  verifyFrontendReceipt,
}) {
  const paths = releasePromotionPaths(stagingRoot, buildId);
  if (!samePath(paths.stagingRoot, join(resolve(root), '.build-generations'))) {
    throw new Error('desktop_release_archive_staging_root_mismatch');
  }
  await assertPlainDirectory(releaseRoot, 'release_archive_build_root');
  const archiveEntries = await readdir(releaseRoot, { withFileTypes: true });
  if (
    archiveEntries.some((entry) => !entry.isFile() || entry.isSymbolicLink())
    || JSON.stringify(archiveEntries.map((entry) => entry.name).sort()) !== JSON.stringify([
      releaseAttestationName,
      releasePromotionName,
      releaseSetName,
    ].sort())
  ) {
    throw new Error('desktop_release_archive_set_invalid');
  }

  const promotionPath = join(releaseRoot, releasePromotionName);
  const attestationPath = join(releaseRoot, releaseAttestationName);
  const releaseSetPath = join(releaseRoot, releaseSetName);
  const promotionBytes = await readPlainFileBytes(promotionPath, 'promotion_receipt');
  const promotion = parseJsonBytes(promotionBytes, 'promotion_receipt');
  if (
    !exactKeys(promotion, [
      'schemaVersion',
      'kind',
      'buildId',
      'promotedAt',
      'frontendReceipt',
      'attestation',
      'releaseSet',
      'buildInputsSha256',
      'executableSha256',
    ])
    || promotion.schemaVersion !== releasePromotionSchemaVersion
    || promotion.kind !== 'orquesta-desktop-release-promotion'
    || promotion.buildId !== paths.buildId
    || !validIsoTimestamp(promotion.promotedAt)
    || !validSha256(promotion.buildInputsSha256)
    || !validSha256(promotion.executableSha256)
  ) {
    throw new Error('desktop_release_promotion_receipt_invalid');
  }

  assertPromotionArtifactRecord(
    promotion.frontendReceipt,
    `receipts/${paths.buildId}.json`,
    'frontend_receipt',
  );
  assertPromotionArtifactRecord(
    promotion.attestation,
    `releases/${paths.buildId}/${releaseAttestationName}`,
    'attestation',
  );
  assertPromotionArtifactRecord(
    promotion.releaseSet,
    `releases/${paths.buildId}/${releaseSetName}`,
    'release_set',
  );

  const frontendReceiptBytesBefore = await readPlainFileBytes(receiptPath, 'frontend_receipt');
  assertBytesMatchRecord(frontendReceiptBytesBefore, promotion.frontendReceipt, 'frontend_receipt');
  const verifiedFrontend = await verifyFrontendReceipt();
  const frontendReceiptBytesAfter = await readPlainFileBytes(receiptPath, 'frontend_receipt');
  if (!frontendReceiptBytesAfter.equals(frontendReceiptBytesBefore)) {
    throw new Error('desktop_release_frontend_receipt_changed_during_verification');
  }

  const attestationBytes = await readPlainFileBytes(attestationPath, 'attestation_copy');
  const releaseSetBytes = await readPlainFileBytes(releaseSetPath, 'release_set_copy');
  assertBytesMatchRecord(attestationBytes, promotion.attestation, 'attestation');
  assertBytesMatchRecord(releaseSetBytes, promotion.releaseSet, 'release_set');
  const attestation = parseJsonBytes(attestationBytes, 'attestation_copy');
  const releaseSet = parseJsonBytes(releaseSetBytes, 'release_set_copy');
  const repositoryRoot = resolve(root, '..', '..');
  const expectedFrontendReceiptPath = normalizeRelativePath(relative(repositoryRoot, paths.receiptPath));
  if (
    attestation?.schemaVersion !== 2
    || attestation.frontendBuildId !== paths.buildId
    || attestation.frontendReceipt?.path !== expectedFrontendReceiptPath
    || attestation.frontendReceipt?.bytes !== promotion.frontendReceipt.bytes
    || attestation.frontendReceipt?.sha256 !== promotion.frontendReceipt.sha256
    || attestation.buildInputs?.sha256 !== promotion.buildInputsSha256
    || attestation.executable?.sha256 !== promotion.executableSha256
  ) {
    throw new Error('desktop_release_promotion_attestation_binding_mismatch');
  }
  if (
    releaseSet?.schemaVersion !== 1
    || releaseSet.kind !== 'orquesta-desktop-release-set'
    || releaseSet.frontendBuildId !== paths.buildId
    || releaseSet.attestation?.name !== releaseAttestationName
    || releaseSet.attestation?.bytes !== promotion.attestation.bytes
    || releaseSet.attestation?.sha256 !== promotion.attestation.sha256
    || releaseSet.executable?.sha256 !== promotion.executableSha256
  ) {
    throw new Error('desktop_release_promotion_release_set_binding_mismatch');
  }
  return {
    frontendBuildId: paths.buildId,
    paths,
    archivePaths: { releaseRoot, promotionPath, attestationPath, releaseSetPath, receiptPath },
    promotion,
    promotionBytes,
    attestation,
    releaseSet,
    frontendReceipt: verifiedFrontend.receipt,
  };
}

export async function verifyDesktopReleaseArchive({
  stagingRoot = defaultStagingRoot,
  buildId,
  root = productRoot,
} = {}) {
  const paths = releasePromotionPaths(stagingRoot, buildId);
  return verifyDesktopReleaseArchiveAt({
    stagingRoot: paths.stagingRoot,
    buildId: paths.buildId,
    root,
    releaseRoot: paths.releaseRoot,
    receiptPath: paths.receiptPath,
    verifyFrontendReceipt: () => readAndVerifyReceipt(paths.stagingRoot, paths.buildId, root),
  });
}

export async function verifyRetiredDesktopReleaseArchive({
  stagingRoot = defaultStagingRoot,
  buildId,
  root = productRoot,
} = {}) {
  const paths = releasePromotionPaths(stagingRoot, buildId);
  const retiredRoot = join(paths.stagingRoot, 'retired');
  const retiredReleaseRoot = join(retiredRoot, 'releases', paths.buildId);
  const retiredReceiptPath = join(retiredRoot, 'receipts', `${paths.buildId}.json`);
  return verifyDesktopReleaseArchiveAt({
    stagingRoot: paths.stagingRoot,
    buildId: paths.buildId,
    root,
    releaseRoot: retiredReleaseRoot,
    receiptPath: retiredReceiptPath,
    verifyFrontendReceipt: () => verifyRetiredGenerationReceipt(paths.stagingRoot, paths.buildId, root),
  });
}

export async function verifyCurrentDesktopRelease({
  stagingRoot = defaultStagingRoot,
  root = productRoot,
} = {}) {
  const expectedStagingRoot = join(resolve(root), '.build-generations');
  if (!samePath(stagingRoot, expectedStagingRoot)) {
    throw new Error('desktop_release_current_staging_root_mismatch');
  }
  const pointerPath = join(resolve(stagingRoot), currentReleasePointerName);
  const pointerBytes = await readPlainFileBytes(pointerPath, 'current_pointer');
  const pointer = parseJsonBytes(pointerBytes, 'current_pointer');
  if (
    !exactKeys(pointer, ['schemaVersion', 'kind', 'buildId', 'promotion'])
    || pointer.schemaVersion !== releasePromotionSchemaVersion
    || pointer.kind !== 'orquesta-desktop-current-release-pointer'
    || typeof pointer.buildId !== 'string'
    || !buildIdPattern.test(pointer.buildId)
  ) {
    throw new Error('desktop_release_current_pointer_invalid');
  }

  const verified = await verifyDesktopReleaseArchive({
    stagingRoot: expectedStagingRoot,
    buildId: pointer.buildId,
    root,
  });
  const expectedPromotionPath = `releases/${pointer.buildId}/${releasePromotionName}`;
  assertPromotionArtifactRecord(pointer.promotion, expectedPromotionPath, 'pointer');
  assertBytesMatchRecord(verified.promotionBytes, pointer.promotion, 'pointer');
  return { ...verified, pointer };
}

export async function verifyRetiredGenerationReceipt(stagingRoot, buildId, root = productRoot) {
  const paths = generationPaths(stagingRoot, buildId);
  if (!samePath(paths.stagingRoot, join(resolve(root), '.build-generations'))) {
    throw new Error('frontend_generation_retired_staging_root_mismatch');
  }
  const retiredGenerationDir = join(paths.stagingRoot, 'retired', 'generations', paths.buildId);
  const retiredReceiptPath = join(paths.stagingRoot, 'retired', 'receipts', `${paths.buildId}.json`);
  await assertPlainDirectory(retiredGenerationDir, 'retired_generation');
  const receiptBytes = await readPlainFileBytes(retiredReceiptPath, 'retired_frontend_receipt');
  const receipt = parseJsonBytes(receiptBytes, 'retired_frontend_receipt');
  if (
    receipt?.schemaVersion !== receiptSchemaVersion
    || receipt.buildId !== paths.buildId
    || !samePath(receipt.generationDir ?? '', paths.generationDir)
    || receipt.tauriFrontendDist !== tauriBuildOverride(paths.generationDir, root).build.frontendDist
  ) {
    throw new Error('frontend_generation_retired_receipt_identity_mismatch');
  }
  const current = await verifyFrontendGeneration(retiredGenerationDir);
  if (JSON.stringify(current.files) !== JSON.stringify(receipt.files) || current.totalBytes !== receipt.totalBytes) {
    throw new Error('frontend_generation_retired_receipt_content_mismatch');
  }
  return {
    paths: { ...paths, retiredGenerationDir, retiredReceiptPath },
    receipt,
    receiptSha256: sha256(receiptBytes),
  };
}

async function metadataOrNull(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function removeOwnedPlainFile(path, label) {
  const metadata = await metadataOrNull(path);
  if (metadata === null) return false;
  if (!metadata.isFile() || metadata.isSymbolicLink() || !samePath(await realpath(path), path)) {
    throw new Error(`frontend_generation_rollback_invalid_${label}`);
  }
  await unlink(path);
  return true;
}

async function removeOwnedPlainDirectory(path, label) {
  const metadata = await metadataOrNull(path);
  if (metadata === null) return false;
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || !samePath(await realpath(path), path)) {
    throw new Error(`frontend_generation_rollback_invalid_${label}`);
  }
  await scanTree(path);
  await rm(path, { recursive: true, force: false });
  return true;
}

export async function rollbackUnpromotedFrontendBuildArtifacts({
  stagingRoot = defaultStagingRoot,
  buildId,
  root = productRoot,
  ownerId,
  generationCreated = false,
  receiptCreated = false,
} = {}) {
  const paths = releasePromotionPaths(stagingRoot, buildId);
  if (!samePath(paths.stagingRoot, join(resolve(root), '.build-generations'))) {
    throw new Error('frontend_generation_rollback_staging_root_mismatch');
  }
  if (!buildIdPattern.test(ownerId ?? '')) {
    throw new Error('frontend_generation_rollback_owner_invalid');
  }
  const stagedReleaseRoot = join(paths.releaseStagingRoot, `${paths.buildId}.${ownerId}.tmp`);
  const temporaryReceiptPath = `${paths.receiptPath}.${ownerId}.tmp`;
  assertOwnedReleaseStagingPath(paths, stagedReleaseRoot, ownerId);

  try {
    if (await metadataOrNull(paths.releaseRoot)) {
      throw new Error('frontend_generation_rollback_promoted_release_refused');
    }
    const pointerMetadata = await metadataOrNull(paths.pointerPath);
    if (pointerMetadata !== null) {
      const pointerBytes = await readPlainFileBytes(paths.pointerPath, 'current_pointer');
      const pointer = parseJsonBytes(pointerBytes, 'current_pointer');
      if (
        !exactKeys(pointer, ['schemaVersion', 'kind', 'buildId', 'promotion'])
        || pointer.schemaVersion !== releasePromotionSchemaVersion
        || pointer.kind !== 'orquesta-desktop-current-release-pointer'
        || !buildIdPattern.test(pointer.buildId ?? '')
      ) {
        throw new Error('frontend_generation_rollback_current_pointer_invalid');
      }
      if (pointer.buildId === paths.buildId) {
        throw new Error('frontend_generation_rollback_current_release_refused');
      }
    }

    const removed = {
      releaseStaging: await removeOwnedPlainDirectory(stagedReleaseRoot, 'release_staging'),
      receiptTemporary: await removeOwnedPlainFile(temporaryReceiptPath, 'receipt_temporary'),
      receipt: false,
      generation: false,
    };
    if (receiptCreated) {
      removed.receipt = await removeOwnedPlainFile(paths.receiptPath, 'receipt');
    }
    if (generationCreated) {
      removed.generation = await removeOwnedPlainDirectory(paths.generationDir, 'generation');
    }
    return { paths, removed };
  } catch (error) {
    error.desktopLifecyclePreserveLock = true;
    throw error;
  }
}

async function runNodeCli(moduleId, args, options = {}) {
  const packageName = moduleId === 'vite'
    ? 'vite'
    : moduleId === 'typescript'
      ? 'typescript'
      : '@tauri-apps/cli';
  const packageRoot = dirname(require.resolve(`${packageName}/package.json`));
  const cliPath = moduleId === 'vite'
    ? join(packageRoot, 'bin', 'vite.js')
    : moduleId === 'typescript'
      ? join(packageRoot, 'bin', 'tsc')
      : join(packageRoot, 'tauri.js');
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: options.cwd ?? productRoot,
      env: options.env ?? process.env,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', rejectPromise);
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`frontend_generation_child_failed:${moduleId}:${code ?? signal}`));
    });
  });
}

async function runTypeScriptChecks(root) {
  for (const project of ['tsconfig.app.json', 'tsconfig.node.json', 'tsconfig.runtime.json']) {
    await runNodeCli('typescript', ['-p', project], { cwd: root });
  }
}

function samePath(left, right) {
  const first = resolve(left);
  const second = resolve(right);
  return process.platform === 'win32' ? first.toLowerCase() === second.toLowerCase() : first === second;
}

async function assertPlainDirectory(directory, label) {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`frontend_generation_reparse_directory:${label}`);
  }
  const physicalPath = await realpath(directory);
  if (!samePath(physicalPath, directory)) {
    throw new Error(`frontend_generation_reparse_directory:${label}`);
  }
}

export async function ensureBuildRoots(stagingRoot, root = productRoot) {
  const expectedRoot = join(resolve(root), '.build-generations');
  if (!samePath(stagingRoot, expectedRoot)) {
    throw new Error('frontend_generation_staging_root_mismatch');
  }
  await assertPlainDirectory(resolve(root), 'product_root');
  for (const directory of [
    expectedRoot,
    join(expectedRoot, 'generations'),
    join(expectedRoot, 'receipts'),
    join(expectedRoot, 'releases'),
    join(expectedRoot, 'releases', 'staging'),
  ]) {
    try {
      await mkdir(directory, { recursive: false });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    await assertPlainDirectory(directory, normalizeRelativePath(relative(root, directory)));
  }
  return expectedRoot;
}

async function scanTree(directory) {
  let entries = 0;
  let totalBytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolutePath = join(directory, entry.name);
    const metadata = await lstat(absolutePath);
    if (metadata.isSymbolicLink()) throw new Error('frontend_generation_capacity_reparse_entry');
    entries += 1;
    if (metadata.isDirectory()) {
      const nested = await scanTree(absolutePath);
      entries += nested.entries;
      totalBytes += nested.totalBytes;
    } else if (metadata.isFile()) {
      totalBytes += metadata.size;
    } else {
      throw new Error('frontend_generation_capacity_non_regular_entry');
    }
  }
  return { entries, totalBytes };
}

export async function assertBuildOutputCapacity(
  stagingRoot,
  {
    reserveGenerationEntries = 0,
    reserveReceiptEntries = 0,
    reserveReleaseEntries = 0,
    reserveReleaseStagingEntries = 0,
    reserveTreeEntries = 0,
    reserveBytes = 0,
    limits = {},
  } = {},
) {
  const capacity = { ...defaultCapacity, ...limits };
  const generationRoot = join(stagingRoot, 'generations');
  const receiptRoot = join(stagingRoot, 'receipts');
  const releaseRoot = join(stagingRoot, 'releases');
  const releaseStagingRoot = join(releaseRoot, 'staging');
  const generationEntries = await readdir(generationRoot, { withFileTypes: true });
  for (const entry of generationEntries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !buildIdPattern.test(entry.name)) {
      throw new Error(`frontend_generation_maintenance_required:unexpected_generation:${entry.name}`);
    }
  }
  const receiptEntries = await readdir(receiptRoot, { withFileTypes: true });
  for (const entry of receiptEntries) {
    const receiptMatch = /^([0-9a-f-]{36})\.json$/u.exec(entry.name);
    const temporaryMatch = /^([0-9a-f-]{36})\.json\.([0-9a-f-]{36})\.tmp$/u.exec(entry.name);
    const validReceipt = receiptMatch !== null && buildIdPattern.test(receiptMatch[1]);
    const validTemporary =
      temporaryMatch !== null &&
      buildIdPattern.test(temporaryMatch[1]) &&
      buildIdPattern.test(temporaryMatch[2]);
    if (!entry.isFile() || entry.isSymbolicLink() || (!validReceipt && !validTemporary)) {
      throw new Error(`frontend_generation_maintenance_required:unexpected_receipt:${entry.name}`);
    }
  }
  const releaseEntries = await readdir(releaseRoot, { withFileTypes: true });
  const finalReleaseEntries = releaseEntries.filter((entry) => entry.name !== 'staging');
  const stagingRootEntry = releaseEntries.find((entry) => entry.name === 'staging');
  if (!stagingRootEntry || !stagingRootEntry.isDirectory() || stagingRootEntry.isSymbolicLink()) {
    throw new Error('frontend_generation_maintenance_required:release_staging_root_invalid');
  }
  for (const entry of finalReleaseEntries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !buildIdPattern.test(entry.name)) {
      throw new Error(`frontend_generation_maintenance_required:unexpected_release:${entry.name}`);
    }
  }
  const releaseStagingEntries = await readdir(releaseStagingRoot, { withFileTypes: true });
  for (const entry of releaseStagingEntries) {
    const match = /^([0-9a-f-]{36})\.([0-9a-f-]{36})\.tmp$/u.exec(entry.name);
    if (
      !entry.isDirectory()
      || entry.isSymbolicLink()
      || match === null
      || !buildIdPattern.test(match[1])
      || !buildIdPattern.test(match[2])
    ) {
      throw new Error(`frontend_generation_maintenance_required:unexpected_release_staging:${entry.name}`);
    }
  }
  let pointerEntries = 0;
  let pointerBytes = 0;
  const currentPointerPath = join(stagingRoot, currentReleasePointerName);
  try {
    const pointerMetadata = await lstat(currentPointerPath);
    if (
      !pointerMetadata.isFile()
      || pointerMetadata.isSymbolicLink()
      || !samePath(await realpath(currentPointerPath), currentPointerPath)
    ) {
      throw new Error('frontend_generation_maintenance_required:current_release_pointer_invalid');
    }
    pointerEntries = 1;
    pointerBytes = pointerMetadata.size;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const stagingRootEntries = await readdir(stagingRoot, { withFileTypes: true });
  const pointerTemps = stagingRootEntries.filter((entry) => entry.name.startsWith(`${currentReleasePointerName}.`));
  if (pointerTemps.length > 0) {
    throw new Error(`frontend_generation_maintenance_required:current_release_pointer_temp:${pointerTemps[0].name}`);
  }
  const generationTree = await scanTree(generationRoot);
  const receiptTree = await scanTree(receiptRoot);
  const releaseTree = await scanTree(releaseRoot);
  const generationCount = generationEntries.length + reserveGenerationEntries;
  const receiptCount = receiptEntries.length + reserveReceiptEntries;
  const releaseCount = finalReleaseEntries.length + reserveReleaseEntries;
  const releaseStagingCount = releaseStagingEntries.length + reserveReleaseStagingEntries;
  const treeEntries =
    generationTree.entries +
    receiptTree.entries +
    releaseTree.entries +
    pointerEntries +
    reserveGenerationEntries +
    reserveReceiptEntries +
    reserveTreeEntries;
  const totalBytes =
    generationTree.totalBytes +
    receiptTree.totalBytes +
    releaseTree.totalBytes +
    pointerBytes +
    reserveBytes;
  if (
    generationCount > capacity.maxGenerationEntries ||
    receiptCount > capacity.maxReceiptEntries ||
    releaseCount > capacity.maxReleaseEntries ||
    releaseStagingCount > capacity.maxReleaseStagingEntries ||
    treeEntries > capacity.maxTreeEntries ||
    totalBytes > capacity.maxTotalBytes
  ) {
    throw new Error(
      `frontend_generation_maintenance_required:${JSON.stringify({ generationCount, receiptCount, releaseCount, releaseStagingCount, treeEntries, totalBytes })}`,
    );
  }
  return {
    generationCount,
    receiptCount,
    releaseCount,
    releaseStagingCount,
    treeEntries,
    totalBytes,
    remainingTreeEntries: capacity.maxTreeEntries - treeEntries,
    remainingBytes: capacity.maxTotalBytes - totalBytes,
  };
}

export async function buildFrontendGeneration({
  stagingRoot = defaultStagingRoot,
  buildId = randomUUID(),
  desktop = false,
  runtimeOnly = false,
  devBrowser = false,
  devDesktop = false,
  tauriArgs = [],
  root = productRoot,
} = {}) {
  const paths = generationPaths(stagingRoot, buildId);
  return withDesktopLifecycleLock({
    root,
    stagingRoot: paths.stagingRoot,
    operation: desktop ? 'build:desktop' : runtimeOnly ? 'build:runtime' : devBrowser ? 'dev' : devDesktop ? 'dev:desktop' : 'build',
    ownerId: paths.buildId,
  }, async () => {
    await ensureBuildRoots(paths.stagingRoot, root);
    await generateDesktopBindings();
    await runTypeScriptChecks(root);
    if (runtimeOnly) {
      await buildDesktopRuntime();
      return { paths, runtimeOnly: true };
    }
    if (devBrowser) {
      await runNodeCli('vite', [], { cwd: root });
      return { paths, devBrowser: true };
    }
    if (devDesktop) {
      await buildDesktopRuntime();
      await runNodeCli('@tauri-apps/cli', ['dev', ...tauriArgs], { cwd: root });
      return { paths, devDesktop: true };
    }
    const transactionId = randomUUID();
    let generationCreated = false;
    let receiptCreated = false;
    let promotionCommitted = false;
    let materializedRelease = null;
    let releaseAttestationCreated = false;
    let releaseSetCreated = false;
    let externalCargoTarget = null;
    let externalCargoTargetClaimed = false;
    try {
      const brandSource = join(root, 'public', 'brand', 'orquesta-symbol.png');
      const brandMetadata = await lstat(brandSource);
      if (!brandMetadata.isFile() || brandMetadata.isSymbolicLink()) {
        throw new Error('frontend_generation_invalid_brand_asset');
      }
      await assertMissingPath(paths.generationDir, 'frontend_generation');
      await assertMissingPath(paths.receiptPath, 'frontend_receipt');
      await assertBuildOutputCapacity(paths.stagingRoot, {
        reserveGenerationEntries: 1,
        reserveReceiptEntries: 1,
        reserveTreeEntries: 3,
        reserveBytes: brandMetadata.size + 1024 * 1024,
      });
      const repositoryRoot = resolve(root, '..', '..');
      const desktopBuildInputs = desktop ? snapshotDesktopBuildInputs(repositoryRoot) : null;
      externalCargoTarget = desktop ? externalCargoTargetDirectory(root) : null;
      if (externalCargoTarget !== null) {
        await preflightExternalDesktopReleaseMaterialization({
          root,
          buildId: paths.buildId,
          ownerId: transactionId,
          cargoTargetDir: externalCargoTarget,
        });
        externalCargoTargetClaimed = true;
      }
      await buildDesktopRuntime();
      await mkdir(paths.generationDir, { recursive: false });
      generationCreated = true;
      const nonce = randomUUID().replaceAll('-', '');
      await writeFile(
        join(paths.generationDir, generationMarkerName),
        `${JSON.stringify({ buildId: paths.buildId, nonce })}\n`,
        { encoding: 'utf8', flag: 'wx' },
      );

      const bundleCapacity = await assertBuildOutputCapacity(paths.stagingRoot, {
        reserveReceiptEntries: 1,
        reserveTreeEntries: 2,
        reserveBytes: brandMetadata.size + 1024 * 1024,
      });
      const viteCapacity = boundedViteCapacity(bundleCapacity);
      await runNodeCli('vite', ['build'], {
        cwd: root,
        env: {
          ...process.env,
          ORQUESTA_FRONTEND_OUT_DIR: paths.generationDir,
          ORQUESTA_FRONTEND_BUILD_ID: paths.buildId,
          ORQUESTA_FRONTEND_BUILD_NONCE: nonce,
          ORQUESTA_FRONTEND_BUNDLE_MAX_ENTRIES: String(viteCapacity.maxEntries),
          ORQUESTA_FRONTEND_BUNDLE_MAX_BYTES: String(viteCapacity.maxBytes),
        },
      });
      await unlink(join(paths.generationDir, generationMarkerName));
      await assertBuildOutputCapacity(paths.stagingRoot, {
        reserveReceiptEntries: 1,
        reserveBytes: brandMetadata.size + 1024 * 1024,
      });
      await mkdir(join(paths.generationDir, 'brand'), { recursive: false });
      await cp(
        brandSource,
        join(paths.generationDir, 'brand', 'orquesta-symbol.png'),
        { force: false },
      );

      const snapshot = await verifyFrontendGeneration(paths.generationDir);
      const estimatedReceiptBytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8') + 4_096;
      await assertBuildOutputCapacity(paths.stagingRoot, {
        reserveReceiptEntries: 1,
        reserveBytes: estimatedReceiptBytes,
      });
      const receipt = await writeReceipt(paths, snapshot, root, transactionId);
      receiptCreated = true;
      process.stdout.write(
        `frontend_generation_verified ${JSON.stringify({ buildId: paths.buildId, files: snapshot.files.length, totalBytes: snapshot.totalBytes, generationDir: paths.generationDir })}\n`,
      );

      if (desktop) {
        const verified = await readAndVerifyReceipt(paths.stagingRoot, paths.buildId, root);
        const override = {
          build: {
            beforeBuildCommand: '',
            frontendDist: verified.receipt.tauriFrontendDist,
          },
        };
        await runNodeCli('@tauri-apps/cli', ['build', '--config', JSON.stringify(override), ...tauriArgs], {
          cwd: root,
          env: externalCargoTarget === null
            ? process.env
            : { ...process.env, CARGO_TARGET_DIR: externalCargoTarget },
        });
        if (externalCargoTarget !== null) {
          materializedRelease = await materializeExternalDesktopRelease({
            root,
            buildId: paths.buildId,
            ownerId: transactionId,
            cargoTargetDir: externalCargoTarget,
          });
          externalCargoTargetClaimed = false;
        }
        await readAndVerifyReceipt(paths.stagingRoot, paths.buildId, root);
        const releaseAttestation = writeDesktopReleaseAttestation({
          repositoryRoot,
          frontendBuildId: paths.buildId,
          frontendReceiptPath: paths.receiptPath,
          expectedBuildInputs: desktopBuildInputs,
        });
        releaseAttestationCreated = materializedRelease !== null;
        const releaseSet = writeDesktopReleaseSetReceipt({
          repositoryRoot,
          attestationPath: releaseAttestation.outputPath,
        });
        releaseSetCreated = materializedRelease !== null;
        const promotion = await promoteDesktopRelease({
          stagingRoot: paths.stagingRoot,
          buildId: paths.buildId,
          root,
          repositoryRoot,
          attestationPath: releaseAttestation.outputPath,
          releaseSetPath: releaseSet.outputPath,
          desktopExe: join(
            root,
            'src-tauri',
            'target',
            'release',
            process.platform === 'win32' ? 'orquesta-desktop-next.exe' : 'orquesta-desktop-next',
          ),
          ownerId: transactionId,
        });
        promotionCommitted = true;
        process.stdout.write(
          `desktop_release_attested ${JSON.stringify({ buildId: paths.buildId, attestationPath: releaseAttestation.outputPath, releaseSetPath: releaseSet.outputPath, promotionPath: promotion.paths.promotionPath, pointerPath: promotion.paths.pointerPath, executableSha256: releaseAttestation.attestation.executable.sha256, installers: releaseAttestation.attestation.installers })}\n`,
        );
      }

      return { paths, receipt };
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (!promotionCommitted && failure.desktopLifecyclePreserveLock !== true) {
        const cleanupErrors = [];
        if (externalCargoTargetClaimed && externalCargoTarget !== null) {
          try {
            await cleanupOwnedExternalCargoTarget({
              root,
              buildId: paths.buildId,
              ownerId: transactionId,
              cargoTargetDir: externalCargoTarget,
            });
            externalCargoTargetClaimed = false;
          } catch (cleanupError) {
            cleanupErrors.push(cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
          }
        }
        if (materializedRelease !== null) {
          try {
            await rollbackMaterializedDesktopRelease({
              root,
              buildId: paths.buildId,
              ownerId: transactionId,
              cargoTargetDir: materializedRelease.paths.externalTargetRoot,
              expectedSnapshot: materializedRelease.snapshot,
              attestationCreated: releaseAttestationCreated,
              releaseSetCreated,
            });
          } catch (cleanupError) {
            cleanupErrors.push(cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
          }
        }
        try {
          await rollbackUnpromotedFrontendBuildArtifacts({
            stagingRoot: paths.stagingRoot,
            buildId: paths.buildId,
            root,
            ownerId: transactionId,
            generationCreated,
            receiptCreated,
          });
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
        }
        if (cleanupErrors.length > 0) {
          failure.desktopBuildCleanupError = cleanupErrors.join(';');
          failure.desktopLifecyclePreserveLock = true;
        }
      }
      throw failure;
    }
  });
}

function parseCliArguments(argv) {
  const modes = ['--desktop', '--runtime-only', '--dev-browser', '--dev-desktop'].filter((mode) => argv.includes(mode));
  if (modes.length > 1) throw new Error('frontend_generation_conflicting_modes');
  return {
    desktop: modes[0] === '--desktop',
    runtimeOnly: modes[0] === '--runtime-only',
    devBrowser: modes[0] === '--dev-browser',
    devDesktop: modes[0] === '--dev-desktop',
    tauriArgs: modes.length > 0 ? argv.filter((argument) => argument !== modes[0]) : [],
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseCliArguments(process.argv.slice(2));
  buildFrontendGeneration(options).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
