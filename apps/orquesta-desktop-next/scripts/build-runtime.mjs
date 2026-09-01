import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, mkdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec as packageExecutable } from '@yao-pkg/pkg';
import { build } from 'esbuild';
import {
  desktopContractPaths,
  generateDesktopBindings,
} from '../../../packages/contracts/scripts/generate-desktop-bindings.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { loadDesktopOperation } = require('../../../packages/execution-kernel/src/desktop-operation-catalog.js');
const stableRuntimeOut = path.join(appRoot, 'runtime-dist');
const stableCodexRuntimeOut = path.join(appRoot, 'codex-runtime');
const runtimeBuildRoot = path.join(appRoot, '.runtime-build');
const sourceProductRoot = path.resolve(appRoot, '..', '..');
const buildInputManifestPath = path.join(appRoot, 'scripts', 'desktop-build-inputs.v1.json');
export const desktopOperationAssetRelativePaths = Object.freeze([
  'orquesta/references/desktop-operation-catalog.generated.json',
  'orquesta/references/organization-agent-placement-persistent-v1.schema.json',
  'orquesta/references/organization-agent-placement-persistent-v1.md',
]);
export const runtimeExplicitBuildInputFilePaths = Object.freeze([
  'packages/contracts/scripts/generate-desktop-bindings.mjs',
  'packages/contracts/desktop/runtime-method-policy.v1.json',
  ...desktopOperationAssetRelativePaths,
]);
export const runtimeExplicitBuildInputPaths = Object.freeze([
  ...runtimeExplicitBuildInputFilePaths,
  'packages/contracts/schemas',
]);
const retiredRuntimeMarkers = Object.freeze([
  'ORQUESTA_EXECUTION_KERNEL_SHADOW_V2',
  'DesktopExecutionShadowController',
  'execution-kernel-shadow-v2.json',
  'Orquesta Core must run as an Electron utility process',
  'process.parentPort',
  'ELECTRON_RUN_AS_NODE',
]);

export function assertRetiredRuntimeSemanticsAbsent(source, label = 'Desktop Next runtime') {
  const found = retiredRuntimeMarkers.filter((marker) => source.includes(marker));
  if (found.length > 0) throw new Error(`retired_runtime_semantics_present:${label}:${found.join(',')}`);
}

function normalizedRelativePath(root, candidate) {
  const relativePath = path.relative(root, path.resolve(candidate));
  if (relativePath === '' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    throw new Error(`runtime_build_input_outside_product_root:${candidate}`);
  }
  return relativePath.split(path.sep).join('/');
}

async function readBuildInputManifest() {
  const manifest = JSON.parse(await readFile(buildInputManifestPath, 'utf8'));
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.files) || !Array.isArray(manifest.directories)) {
    throw new Error('runtime_build_input_manifest_invalid');
  }
  return manifest;
}

export async function assertRuntimeExplicitBuildInputFiles({
  productRoot = sourceProductRoot,
  relativePaths = runtimeExplicitBuildInputFilePaths,
} = {}) {
  for (const relativePath of relativePaths) {
    let metadata;
    try {
      metadata = await stat(path.join(productRoot, ...relativePath.split('/')));
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new Error(`runtime_explicit_build_input_not_file:${relativePath}`, { cause: error });
      }
      throw error;
    }
    if (!metadata.isFile()) throw new Error(`runtime_explicit_build_input_not_file:${relativePath}`);
  }
}

export async function assertRuntimeBuildInputCoverage(metafile) {
  if (!metafile || typeof metafile.inputs !== 'object' || metafile.inputs === null) {
    throw new Error('runtime_build_metafile_invalid');
  }
  await assertRuntimeExplicitBuildInputFiles();
  const manifest = await readBuildInputManifest();
  const declaredFiles = new Set(manifest.files);
  const declaredDirectories = [...manifest.directories];
  const isCovered = (relativePath) => declaredFiles.has(relativePath)
    || declaredDirectories.some((directory) => relativePath === directory || relativePath.startsWith(`${directory}/`));
  const actualWorkspaceInputs = Object.keys(metafile.inputs).map((inputPath) => (
    normalizedRelativePath(sourceProductRoot, path.isAbsolute(inputPath)
      ? inputPath
      : path.join(sourceProductRoot, inputPath))
  )).filter((relativePath) => !relativePath.split('/').includes('node_modules'));
  const required = [...new Set([...actualWorkspaceInputs, ...runtimeExplicitBuildInputPaths])].sort();
  const missing = required.filter((relativePath) => !isCovered(relativePath));
  if (missing.length > 0) throw new Error(`runtime_build_input_scope_missing:${missing.join(',')}`);
  return { required, manifest };
}

function runtimeBundleOptions({ outfile, write = true }) {
  return {
    absWorkingDir: sourceProductRoot,
    entryPoints: [path.join(appRoot, 'runtime-node', 'sidecar-entry.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    sourcemap: false,
    packages: 'bundle',
    define: { 'process.env.ORQUESTA_DESKTOP_NEXT': '"1"' },
    metafile: true,
    write,
  };
}

export async function analyzeRuntimeBuildInputs() {
  const result = await build(runtimeBundleOptions({ outfile: path.join(appRoot, '.runtime-input-analysis.cjs'), write: false }));
  return assertRuntimeBuildInputCoverage(result.metafile);
}

export async function stageDesktopOperationAssets({ productRoot, runtimeOut }) {
  for (const relativePath of desktopOperationAssetRelativePaths) {
    const segments = relativePath.split('/');
    const source = path.join(productRoot, ...segments);
    const destination = path.join(runtimeOut, ...segments);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination);
  }
  loadDesktopOperation({
    productRoot: runtimeOut,
    operationId: 'organization.agent-placement.persistent.v1',
  });
}

async function pathExists(candidate) {
  try {
    await stat(candidate);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function removeEmptyDirectory(candidate) {
  try {
    await rmdir(candidate);
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error?.code)) throw error;
  }
}

export async function promoteRuntimeGeneration({
  stagedRuntimeOut,
  stagedCodexRuntimeOut,
  currentRuntimeOut,
  currentCodexRuntimeOut,
  transactionRoot,
  beforeCodexPromotion = async () => {},
  move = rename,
}) {
  const backupRuntimeOut = path.join(transactionRoot, 'runtime-dist.previous');
  const backupCodexRuntimeOut = path.join(transactionRoot, 'codex-runtime.previous');
  await mkdir(transactionRoot, { recursive: true });
  const moved = {
    previousRuntime: false,
    previousCodex: false,
    nextRuntime: false,
    nextCodex: false,
  };
  try {
    if (await pathExists(currentRuntimeOut)) {
      await move(currentRuntimeOut, backupRuntimeOut);
      moved.previousRuntime = true;
    }
    if (await pathExists(currentCodexRuntimeOut)) {
      await move(currentCodexRuntimeOut, backupCodexRuntimeOut);
      moved.previousCodex = true;
    }
    await move(stagedRuntimeOut, currentRuntimeOut);
    moved.nextRuntime = true;
    await beforeCodexPromotion();
    await move(stagedCodexRuntimeOut, currentCodexRuntimeOut);
    moved.nextCodex = true;
  } catch (error) {
    const rollbackErrors = [];
    for (const [active, staged, didMove] of [
      [currentCodexRuntimeOut, stagedCodexRuntimeOut, moved.nextCodex],
      [currentRuntimeOut, stagedRuntimeOut, moved.nextRuntime],
    ]) {
      if (!didMove) continue;
      try { await move(active, staged); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    for (const [backup, active, didMove] of [
      [backupCodexRuntimeOut, currentCodexRuntimeOut, moved.previousCodex],
      [backupRuntimeOut, currentRuntimeOut, moved.previousRuntime],
    ]) {
      if (!didMove) continue;
      try { await move(backup, active); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    if (rollbackErrors.length > 0) {
      const failure = new AggregateError(
        [error, ...rollbackErrors],
        'runtime_generation_promotion_rollback_failed',
      );
      failure.desktopLifecyclePreserveLock = true;
      throw failure;
    }
    throw error;
  }
  await rm(transactionRoot, { recursive: true, force: true });
}

export async function buildDesktopRuntime() {
  await generateDesktopBindings({ check: true });
  const buildId = randomUUID();
  const stagingRoot = path.join(runtimeBuildRoot, 'staging', buildId);
  const transactionRoot = path.join(runtimeBuildRoot, 'transactions', buildId);
  const out = path.join(stagingRoot, 'runtime-dist');
  const codexRuntimeOut = path.join(stagingRoot, 'codex-runtime');
  const sidecarEntry = path.join(out, 'sidecar.cjs');
  await mkdir(out, { recursive: true });
  try {
    const bundleResult = await build(runtimeBundleOptions({ outfile: sidecarEntry }));
    await assertRuntimeBuildInputCoverage(bundleResult.metafile);
    assertRetiredRuntimeSemanticsAbsent(await readFile(sidecarEntry, 'utf8'), 'sidecar.cjs');
    await cp(desktopContractPaths.policy, path.join(out, 'runtime-method-policy.v1.json'));
    await cp(
      path.join(appRoot, '..', '..', 'packages', 'contracts', 'schemas'),
      path.join(out, 'schemas'),
      { recursive: true },
    );
    await stageDesktopOperationAssets({ productRoot: sourceProductRoot, runtimeOut: out });

    const pinnedCodexPackages = [
    { directory: 'codex-sdk', name: '@openai/codex-sdk', version: '0.144.5' },
    { directory: 'codex', name: '@openai/codex', version: '0.144.5' },
    { directory: 'codex-win32-x64', name: '@openai/codex', version: '0.144.5-win32-x64' },
  ];
    const sourceOpenAi = path.join(appRoot, 'node_modules', '@openai');
    const bundledOpenAi = path.join(codexRuntimeOut, 'node_modules', '@openai');
    await mkdir(bundledOpenAi, { recursive: true });
    for (const pinnedPackage of pinnedCodexPackages) {
    const source = path.join(sourceOpenAi, pinnedPackage.directory);
    const metadata = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
    if (metadata.name !== pinnedPackage.name || metadata.version !== pinnedPackage.version) {
      throw new Error(`Pinned Codex package mismatch: ${pinnedPackage.directory}`);
    }
    await cp(source, path.join(bundledOpenAi, pinnedPackage.directory), { recursive: true, dereference: true });
    }

    const manifestPaths = [
    ...pinnedCodexPackages.map(({ directory }) => `node_modules/@openai/${directory}/package.json`),
    'node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe',
  ];
    async function digest(relativePath) {
    const filename = path.join(codexRuntimeOut, ...relativePath.split('/'));
    const hash = createHash('sha256');
    await new Promise((resolve, reject) => {
      const stream = createReadStream(filename);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.once('error', reject);
      stream.once('end', resolve);
    });
    return { path: relativePath, bytes: (await stat(filename)).size, sha256: hash.digest('hex') };
    }
    await writeFile(path.join(codexRuntimeOut, 'runtime-manifest.json'), `${JSON.stringify({
    schemaVersion: 1,
    packages: pinnedCodexPackages,
    files: await Promise.all(manifestPaths.map(digest)),
  }, null, 2)}\n`, 'utf8');

    const pkgPlatform = { win32: 'win', linux: 'linux', darwin: 'macos' }[process.platform];
    const pkgArch = { x64: 'x64', arm64: 'arm64' }[process.arch];
    if (!pkgPlatform || !pkgArch) {
    throw new Error(`Desktop Next runtime packaging is unsupported on ${process.platform}/${process.arch}`);
    }
    const runtimeExecutable = path.join(out, process.platform === 'win32' ? 'orquesta-runtime.exe' : 'orquesta-runtime');
    await packageExecutable({
    input: sidecarEntry,
    targets: [`node22-${pkgPlatform}-${pkgArch}`],
    output: runtimeExecutable,
    bytecode: false,
    public: true,
    });
    await promoteRuntimeGeneration({
      stagedRuntimeOut: out,
      stagedCodexRuntimeOut: codexRuntimeOut,
      currentRuntimeOut: stableRuntimeOut,
      currentCodexRuntimeOut: stableCodexRuntimeOut,
      transactionRoot,
    });
    console.log(`Desktop Next runtime written to ${stableRuntimeOut}; pinned Codex runtime written to ${stableCodexRuntimeOut}`);
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
    await removeEmptyDirectory(path.join(runtimeBuildRoot, 'staging'));
    await removeEmptyDirectory(path.join(runtimeBuildRoot, 'transactions'));
    await removeEmptyDirectory(runtimeBuildRoot);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  throw new Error('build_runtime_coordinator_required: use `npm run build:runtime`');
}
