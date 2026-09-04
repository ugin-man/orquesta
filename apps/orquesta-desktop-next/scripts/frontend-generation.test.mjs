import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';

import {
  assertBuildOutputCapacity,
  boundedViteCapacity,
  cleanupOwnedExternalCargoTarget,
  desktopReleaseMaterializationPaths,
  ensureBuildRoots,
  externalCargoTargetDirectory,
  generationPaths,
  materializeExternalDesktopRelease,
  preflightExternalDesktopReleaseMaterialization,
  pruneObsoleteDesktopBuildHistory,
  promoteDesktopRelease,
  productRoot,
  readAndVerifyReceipt,
  releasePromotionPaths,
  rollbackUnpromotedFrontendBuildArtifacts,
  rollbackMaterializedDesktopRelease,
  tauriBuildOverride,
  verifyCurrentDesktopRelease,
  verifyDesktopReleaseArchive,
  verifyFrontendGeneration,
  verifyRetiredDesktopReleaseArchive,
  verifyRetiredGenerationReceipt,
} from './build-frontend-generation.mjs';
import {
  acquireDesktopLifecycleLock,
  desktopLifecycleLockName,
  releaseDesktopLifecycleLock,
  withDesktopLifecycleLock,
} from './desktop-lifecycle-lock.mjs';
import {
  desktopLifecycleCommandPlan,
  desktopLifecycleOperationNeedsLock,
  parseDesktopLifecycleArguments,
  retireDesktopGeneration,
  verifyCanonicalReleaseAuthority,
} from './run-desktop-lifecycle.mjs';
import {
  assertViteBundleCapacity,
  generationMarkerName,
  explicitLoadTestExclusions,
  validateGenerationOutput,
} from './frontend-generation-policy.mjs';

const require = createRequire(import.meta.url);
const {
  currentIdentity,
  expectedReleaseInstallers,
  writeDesktopReleaseAttestation,
  writeDesktopReleaseSetReceipt,
} = require('../../../orquesta/scripts/desktop-release-attestation.js');

const canonicalRepositoryRoot = resolve(productRoot, '..', '..');
const materializationIdentity = currentIdentity(canonicalRepositoryRoot);

const testIds = [
  '10000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002',
  '30000000-0000-4000-8000-000000000003',
  '40000000-0000-4000-8000-000000000004',
];
const testNonce = '0123456789abcdef0123456789abcdef';
const fixtureDesktopExecutable = process.platform === 'win32'
  ? 'orquesta-desktop-next.exe'
  : 'orquesta-desktop-next';
const buildInputManifest = JSON.parse(await readFile(
  join(productRoot, 'scripts', 'desktop-build-inputs.v1.json'),
  'utf8',
));

function fixtureBuildId(index) {
  return `${String(index).padStart(8, '0')}-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

test('Vite capacity is capped by both the per-build ceiling and actual remaining space', () => {
  assert.deepEqual(
    boundedViteCapacity({ remainingTreeEntries: 10_000, remainingBytes: 128 * 1024 * 1024 }),
    { maxEntries: 120, maxBytes: 60 * 1024 * 1024 },
  );
  assert.deepEqual(
    boundedViteCapacity({ remainingTreeEntries: 17, remainingBytes: 4096 }),
    { maxEntries: 17, maxBytes: 4096 },
  );
  assert.throws(
    () => boundedViteCapacity({ remainingTreeEntries: -1, remainingBytes: 4096 }),
    /frontend_generation_invalid_remaining_capacity/u,
  );
});

test('extreme renderer loads are excluded unless the bounded lifecycle opts in explicitly', () => {
  assert.deepEqual(explicitLoadTestExclusions({}), ['tests/load/**']);
  assert.deepEqual(explicitLoadTestExclusions({ ORQUESTA_EXPLICIT_LOAD_TESTS: '0' }), ['tests/load/**']);
  assert.deepEqual(explicitLoadTestExclusions({ ORQUESTA_EXPLICIT_LOAD_TESTS: '1' }), []);
});

async function withTemporaryDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), 'orquesta-frontend-generation-test-'));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

async function writeValidGeneration(root) {
  await mkdir(join(root, 'assets'), { recursive: true });
  await mkdir(join(root, 'brand'), { recursive: true });
  await writeFile(
    join(root, 'index.html'),
    '<link rel="icon" href="/brand/symbol.png"><link rel="stylesheet" href="/assets/main.css"><script type="module" src="/assets/main.js"></script>',
  );
  await writeFile(
    join(root, 'assets', 'main.js'),
    'import "./chunk.js"; new URL("/assets/worker.js", import.meta.url);',
  );
  await writeFile(join(root, 'assets', 'chunk.js'), 'export const value = 1;');
  await writeFile(join(root, 'assets', 'worker.js'), 'self.onmessage = () => {};');
  await writeFile(join(root, 'assets', 'main.css'), 'body { background: url("/assets/pixel.png"); }');
  await writeFile(join(root, 'assets', 'pixel.png'), Buffer.from([1, 2, 3]));
  await writeFile(join(root, 'brand', 'symbol.png'), Buffer.from([4, 5, 6]));
}

async function writeExternalReleaseFixture(cargoTargetRoot) {
  const releaseRoot = join(cargoTargetRoot, 'release');
  const [msiInstaller, nsisInstaller] = expectedReleaseInstallers(
    releaseRoot,
    materializationIdentity,
  );
  await writeFixtureFile(releaseRoot, fixtureDesktopExecutable, 'external executable');
  await writeFixtureFile(releaseRoot, 'runtime-dist/sidecar.cjs', 'runtime sidecar');
  await writeFixtureFile(releaseRoot, 'codex-runtime/runtime.exe', 'codex runtime');
  await writeFixtureFile(releaseRoot, 'codex-runtime/runtime-manifest.json', '{}\n');
  await writeFixtureFile(releaseRoot, join('bundle', 'msi', basename(msiInstaller)), 'msi installer');
  await writeFixtureFile(releaseRoot, join('bundle', 'nsis', basename(nsisInstaller)), 'nsis installer');
  await writeFixtureFile(releaseRoot, 'unrelated-debug-symbol.pdb', 'not part of the canonical subset');
  return releaseRoot;
}

async function writeFrontendReceipt(
  paths,
  root,
  generationDir = paths.generationDir,
  receiptPath = paths.receiptPath,
) {
  const snapshot = await verifyFrontendGeneration(generationDir);
  const receipt = {
    schemaVersion: 1,
    buildId: paths.buildId,
    generationDir: paths.generationDir,
    tauriFrontendDist: tauriBuildOverride(paths.generationDir, root).build.frontendDist,
    files: snapshot.files,
    totalBytes: snapshot.totalBytes,
  };
  const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  await writeFile(receiptPath, bytes);
  return { receipt, bytes };
}

async function writeFixtureFile(repositoryRoot, relativePath, value) {
  const target = join(repositoryRoot, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, value);
  return target;
}

async function prepareDesktopReleaseFixture(repositoryRoot, buildId, generatedAt) {
  const root = join(repositoryRoot, 'apps', 'orquesta-desktop-next');
  await writeFixtureFile(
    repositoryRoot,
    'apps/orquesta-desktop-next/scripts/desktop-build-inputs.v1.json',
    `${JSON.stringify(buildInputManifest, null, 2)}\n`,
  );
  for (const relativePath of buildInputManifest.files) {
    if (relativePath !== 'apps/orquesta-desktop-next/scripts/desktop-build-inputs.v1.json') {
      await writeFixtureFile(repositoryRoot, relativePath, `fixture:${relativePath}\n`);
    }
  }
  for (const relativePath of buildInputManifest.directories) {
    await writeFixtureFile(repositoryRoot, join(relativePath, 'fixture-input.txt'), `fixture:${relativePath}\n`);
  }
  await writeFixtureFile(repositoryRoot, 'apps/orquesta-desktop-next/package.json', JSON.stringify({
    name: '@orquesta/desktop-next',
    productName: 'Orquesta Next',
    version: '0.5.0-next.0',
  }));
  await writeFixtureFile(repositoryRoot, 'apps/orquesta-desktop-next/src-tauri/tauri.conf.json', JSON.stringify({
    productName: 'Orquesta Next',
    version: '0.5.0-0',
    identifier: 'com.orquesta.desktop.next',
  }));
  await writeFixtureFile(
    repositoryRoot,
    'apps/orquesta-desktop-next/src-tauri/Cargo.toml',
    "[package]\nname='orquesta-desktop-next'\n",
  );

  for (const relativePath of ['runtime-dist/sidecar.cjs', 'codex-runtime/runtime.exe']) {
    const content = `current:${relativePath}`;
    await writeFixtureFile(repositoryRoot, `apps/orquesta-desktop-next/${relativePath}`, content);
    await writeFixtureFile(
      repositoryRoot,
      `apps/orquesta-desktop-next/src-tauri/target/release/${relativePath}`,
      content,
    );
  }
  const runtimeManifest = JSON.stringify({ schemaVersion: 1, files: [] });
  await writeFixtureFile(
    repositoryRoot,
    'apps/orquesta-desktop-next/codex-runtime/runtime-manifest.json',
    runtimeManifest,
  );
  await writeFixtureFile(
    repositoryRoot,
    'apps/orquesta-desktop-next/src-tauri/target/release/codex-runtime/runtime-manifest.json',
    runtimeManifest,
  );
  const desktopExe = await writeFixtureFile(
    repositoryRoot,
    'apps/orquesta-desktop-next/src-tauri/target/release/orquesta-desktop-next.exe',
    'current desktop executable __TAURI_BUNDLE_TYPE_VAR_UNK',
  );
  const architecture = process.arch === 'arm64' ? 'arm64' : 'x64';
  await writeFixtureFile(
    repositoryRoot,
    `apps/orquesta-desktop-next/src-tauri/target/release/bundle/msi/Orquesta Next_0.5.0-0_${architecture}_en-US.msi`,
    'msi',
  );
  await writeFixtureFile(
    repositoryRoot,
    `apps/orquesta-desktop-next/src-tauri/target/release/bundle/nsis/Orquesta Next_0.5.0-0_${architecture}-setup.exe`,
    'nsis',
  );

  const stagingRoot = join(root, '.build-generations');
  await ensureBuildRoots(stagingRoot, root);
  const paths = generationPaths(stagingRoot, buildId);
  await mkdir(paths.generationDir);
  await writeValidGeneration(paths.generationDir);
  await writeFrontendReceipt(paths, root);
  const releaseAttestation = writeDesktopReleaseAttestation({
    repositoryRoot,
    frontendBuildId: buildId,
    frontendReceiptPath: paths.receiptPath,
    generatedAt,
  });
  const releaseSet = writeDesktopReleaseSetReceipt({
    repositoryRoot,
    attestationPath: releaseAttestation.outputPath,
    generatedAt,
  });
  return {
    root,
    stagingRoot,
    paths,
    desktopExe,
    attestationPath: releaseAttestation.outputPath,
    releaseSetPath: releaseSet.outputPath,
  };
}

async function preparePromotedReleasePair(repositoryRoot) {
  const first = await prepareDesktopReleaseFixture(
    repositoryRoot,
    testIds[0],
    '2026-08-31T03:00:00.000Z',
  );
  const firstPromotion = await promoteDesktopRelease({
    ...first,
    buildId: testIds[0],
    repositoryRoot,
    promotedAt: '2026-08-31T03:00:01.000Z',
  });
  const second = await prepareDesktopReleaseFixture(
    repositoryRoot,
    testIds[1],
    '2026-08-31T03:01:00.000Z',
  );
  const secondPromotion = await promoteDesktopRelease({
    ...second,
    buildId: testIds[1],
    repositoryRoot,
    promotedAt: '2026-08-31T03:01:01.000Z',
  });
  return { first, firstPromotion, second, secondPromotion };
}

test('accepts one fully reachable frontend generation', async () => {
  await withTemporaryDirectory(async (root) => {
    await writeValidGeneration(root);
    const snapshot = await verifyFrontendGeneration(root);
    assert.equal(snapshot.files.length, 7);
    assert.equal(snapshot.files.every((file) => /^[0-9a-f]{64}$/u.test(file.sha256)), true);
  });
});

test('rejects missing referenced assets', async () => {
  await withTemporaryDirectory(async (root) => {
    await writeValidGeneration(root);
    await rm(join(root, 'assets', 'worker.js'));
    await assert.rejects(verifyFrontendGeneration(root), /frontend_generation_missing_asset:assets\/worker\.js/u);
  });
});

test('rejects orphan files from another generation', async () => {
  await withTemporaryDirectory(async (root) => {
    await writeValidGeneration(root);
    await writeFile(join(root, 'assets', 'legacy.js'), 'const attachmentHandles = [];');
    await assert.rejects(verifyFrontendGeneration(root), /frontend_generation_orphan_files:assets\/legacy\.js/u);
  });
});

test('desktop override points to the exact selected generation and disables a second build', () => {
  const generationDir = join(productRoot, '.build-generations', 'generations', testIds[0]);
  const override = tauriBuildOverride(generationDir);
  assert.deepEqual(override, {
    build: {
      beforeBuildCommand: '',
      frontendDist: `../.build-generations/generations/${testIds[0]}`,
    },
  });
});

test('receipt verification rejects changed generation bytes', async () => {
  await withTemporaryDirectory(async (stagingRoot) => {
    const buildId = testIds[0];
    const paths = generationPaths(stagingRoot, buildId);
    await mkdir(paths.generationDir, { recursive: true });
    await writeValidGeneration(paths.generationDir);
    const snapshot = await verifyFrontendGeneration(paths.generationDir);
    const receipt = {
      schemaVersion: 1,
      buildId,
      generationDir: paths.generationDir,
      tauriFrontendDist: tauriBuildOverride(paths.generationDir).build.frontendDist,
      files: snapshot.files,
      totalBytes: snapshot.totalBytes,
    };
    await mkdir(resolve(stagingRoot, 'receipts'), { recursive: true });
    await writeFile(paths.receiptPath, `${JSON.stringify(receipt)}\n`);
    await writeFile(join(paths.generationDir, 'assets', 'chunk.js'), 'export const value = 2;');
    await assert.rejects(
      readAndVerifyReceipt(stagingRoot, buildId),
      /frontend_generation_receipt_content_mismatch/u,
    );
  });
});

test('verified releases promote through immutable copies and one atomic current pointer', async () => {
  await withTemporaryDirectory(async (repositoryRoot) => {
    const first = await prepareDesktopReleaseFixture(
      repositoryRoot,
      testIds[0],
      '2026-08-31T00:00:00.000Z',
    );
    const sourceAttestationBytes = await readFile(first.attestationPath);
    const sourceReleaseSetBytes = await readFile(first.releaseSetPath);
    const firstPromotion = await promoteDesktopRelease({
      ...first,
      buildId: testIds[0],
      repositoryRoot,
      promotedAt: '2026-08-31T00:00:01.000Z',
    });
    assert.deepEqual(Object.keys(firstPromotion.pointer).sort(), [
      'buildId',
      'kind',
      'promotion',
      'schemaVersion',
    ]);
    assert.deepEqual(Object.keys(firstPromotion.pointer.promotion).sort(), ['bytes', 'path', 'sha256']);
    assert.equal(firstPromotion.pointer.promotion.path, `releases/${testIds[0]}/release-promotion.json`);
    assert.equal((await readFile(firstPromotion.paths.attestationCopyPath)).equals(sourceAttestationBytes), true);
    assert.equal((await readFile(firstPromotion.paths.releaseSetCopyPath)).equals(sourceReleaseSetBytes), true);
    assert.equal(JSON.stringify(firstPromotion.pointer).includes(repositoryRoot), false);
    assert.equal(JSON.stringify(firstPromotion.promotion).includes(repositoryRoot), false);
    const firstPromotionBytes = await readFile(firstPromotion.paths.promotionPath);

    const second = await prepareDesktopReleaseFixture(
      repositoryRoot,
      testIds[1],
      '2026-08-31T00:01:00.000Z',
    );
    const secondPromotion = await promoteDesktopRelease({
      ...second,
      buildId: testIds[1],
      repositoryRoot,
      promotedAt: '2026-08-31T00:01:01.000Z',
    });
    const current = await verifyCurrentDesktopRelease({ root: second.root, stagingRoot: second.stagingRoot });
    assert.equal(current.frontendBuildId, testIds[1]);
    assert.equal((await readFile(firstPromotion.paths.promotionPath)).equals(firstPromotionBytes), true);
    assert.equal((await stat(secondPromotion.paths.pointerPath)).isFile(), true);
  });
});

test('tamper and failed replacement never change the previous current pointer', async () => {
  await withTemporaryDirectory(async (repositoryRoot) => {
    const first = await prepareDesktopReleaseFixture(
      repositoryRoot,
      testIds[0],
      '2026-08-31T01:00:00.000Z',
    );
    const promoted = await promoteDesktopRelease({
      ...first,
      buildId: testIds[0],
      repositoryRoot,
      promotedAt: '2026-08-31T01:00:01.000Z',
    });
    const pointerBefore = await readFile(promoted.paths.pointerPath);
    const second = await prepareDesktopReleaseFixture(
      repositoryRoot,
      testIds[1],
      '2026-08-31T01:01:00.000Z',
    );
    await writeFile(second.releaseSetPath, '{}\n');
    await assert.rejects(
      promoteDesktopRelease({
        ...second,
        buildId: testIds[1],
        repositoryRoot,
        promotedAt: '2026-08-31T01:01:01.000Z',
      }),
      /desktop_release_set_receipt_invalid/u,
    );
    assert.equal((await readFile(promoted.paths.pointerPath)).equals(pointerBefore), true);

    await writeFile(promoted.paths.attestationCopyPath, '{}\n');
    await assert.rejects(
      verifyCurrentDesktopRelease({ root: first.root, stagingRoot: first.stagingRoot }),
      /promotion_attestation_hash_mismatch/u,
    );
    assert.equal((await readFile(promoted.paths.pointerPath)).equals(pointerBefore), true);
  });
});

test('pointer rename failure removes only its exact temporary file and rolls the archive back', async () => {
  await withTemporaryDirectory(async (repositoryRoot) => {
    const fixture = await prepareDesktopReleaseFixture(
      repositoryRoot,
      testIds[0],
      '2026-08-31T01:30:00.000Z',
    );
    const paths = releasePromotionPaths(fixture.stagingRoot, testIds[0]);
    await mkdir(paths.pointerPath);
    let failure;
    try {
      await promoteDesktopRelease({
        ...fixture,
        buildId: testIds[0],
        repositoryRoot,
        promotedAt: '2026-08-31T01:30:01.000Z',
      });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof Error);
    assert.equal(failure.desktopLifecyclePreserveLock, undefined);
    assert.deepEqual(
      (await readdir(fixture.stagingRoot))
        .filter((name) => name.startsWith('current-release.json.') && name.endsWith('.tmp')),
      [],
    );
    await assert.rejects(stat(paths.releaseRoot), { code: 'ENOENT' });
    assert.equal((await stat(paths.pointerPath)).isDirectory(), true);
  });
});

test('current authority survives target cleanup and still refuses current retirement', async () => {
  await withTemporaryDirectory(async (repositoryRoot) => {
    const fixture = await prepareDesktopReleaseFixture(
      repositoryRoot,
      testIds[0],
      '2026-08-31T02:00:00.000Z',
    );
    await promoteDesktopRelease({
      ...fixture,
      buildId: testIds[0],
      repositoryRoot,
      promotedAt: '2026-08-31T02:00:01.000Z',
    });
    await rm(join(fixture.root, 'src-tauri', 'target'), { recursive: true, force: true });
    assert.equal((await verifyCanonicalReleaseAuthority(fixture.root)).frontendBuildId, testIds[0]);
    await mkdir(join(fixture.stagingRoot, 'retired'));
    await mkdir(join(fixture.stagingRoot, 'retired', 'generations'));
    await mkdir(join(fixture.stagingRoot, 'retired', 'receipts'));
    await assert.rejects(
      retireDesktopGeneration({ buildId: testIds[0], root: fixture.root }),
      /retire_current_release_refused/u,
    );
    assert.equal((await stat(fixture.paths.generationDir)).isDirectory(), true);
    assert.equal((await stat(fixture.paths.receiptPath)).isFile(), true);
  });
});

test('retired verifier keeps legacy active identity bytes while checking retired contents', async () => {
  await withTemporaryDirectory(async (fakeProductRoot) => {
    const stagingRoot = join(fakeProductRoot, '.build-generations');
    await ensureBuildRoots(stagingRoot, fakeProductRoot);
    const paths = generationPaths(stagingRoot, testIds[2]);
    const retiredGenerationDir = join(stagingRoot, 'retired', 'generations', testIds[2]);
    const retiredReceiptPath = join(stagingRoot, 'retired', 'receipts', `${testIds[2]}.json`);
    await mkdir(retiredGenerationDir, { recursive: true });
    await mkdir(dirname(retiredReceiptPath), { recursive: true });
    await writeValidGeneration(retiredGenerationDir);
    await writeFrontendReceipt(paths, fakeProductRoot, retiredGenerationDir, retiredReceiptPath);
    const receiptBytesBefore = await readFile(retiredReceiptPath);
    const verified = await verifyRetiredGenerationReceipt(stagingRoot, testIds[2], fakeProductRoot);
    assert.equal(verified.receipt.generationDir, paths.generationDir);
    assert.equal((await readFile(retiredReceiptPath)).equals(receiptBytesBefore), true);
    await writeFile(join(retiredGenerationDir, 'assets', 'chunk.js'), 'export const value = 3;');
    await assert.rejects(
      verifyRetiredGenerationReceipt(stagingRoot, testIds[2], fakeProductRoot),
      /retired_receipt_content_mismatch/u,
    );
  });
});

test('external Cargo target selection is absolute, outside the product, and leaves the canonical target on its old path', async () => {
  await withTemporaryDirectory(async (base) => {
    const fakeRepositoryRoot = join(base, 'repository');
    const root = join(fakeRepositoryRoot, 'apps', 'orquesta-desktop-next');
    const externalTarget = join(base, 'cargo-target');
    await mkdir(join(root, 'src-tauri'), { recursive: true });
    assert.equal(externalCargoTargetDirectory(root, {}), null);
    assert.equal(
      externalCargoTargetDirectory(root, { CARGO_TARGET_DIR: join(root, 'src-tauri', 'target') }),
      null,
    );
    assert.equal(externalCargoTargetDirectory(root, { CARGO_TARGET_DIR: externalTarget }), externalTarget);
    assert.throws(
      () => externalCargoTargetDirectory(root, { CARGO_TARGET_DIR: 'relative-target' }),
      /external_cargo_target_requires_absolute_path/u,
    );
    assert.throws(
      () => externalCargoTargetDirectory(root, { CARGO_TARGET_DIR: join(root, 'nested-target') }),
      /external_cargo_target_inside_product/u,
    );
    const repositoryTarget = join(fakeRepositoryRoot, 'cargo-target');
    assert.throws(
      () => externalCargoTargetDirectory(root, { CARGO_TARGET_DIR: repositoryTarget }),
      /external_cargo_target_inside_repository/u,
    );
    assert.throws(
      () => desktopReleaseMaterializationPaths({
        root,
        buildId: testIds[0],
        ownerId: testIds[1],
        cargoTargetDir: join(root, 'nested-target'),
      }),
      /external_cargo_target_inside_product/u,
    );
    const paths = desktopReleaseMaterializationPaths({
      root,
      buildId: testIds[0],
      ownerId: testIds[1],
      cargoTargetDir: externalTarget,
    });
    assert.equal(paths.externalReleaseRoot, join(externalTarget, 'release'));
    assert.equal(paths.canonicalReleaseRoot, join(root, 'src-tauri', 'target', 'release'));
    await preflightExternalDesktopReleaseMaterialization({
      root,
      buildId: testIds[0],
      ownerId: testIds[1],
      cargoTargetDir: externalTarget,
    });
    assert.equal((await stat(externalTarget)).isDirectory(), true);
    await cleanupOwnedExternalCargoTarget({
      root,
      buildId: testIds[0],
      ownerId: testIds[1],
      cargoTargetDir: externalTarget,
    });
    await assert.rejects(stat(externalTarget), { code: 'ENOENT' });

    await mkdir(paths.canonicalReleaseRoot, { recursive: true });
    const blockedExternalTarget = join(base, 'blocked-cargo-target');
    await assert.rejects(
      preflightExternalDesktopReleaseMaterialization({
        root,
        buildId: testIds[0],
        ownerId: testIds[1],
        cargoTargetDir: blockedExternalTarget,
      }),
      /desktop_release_canonical_release_already_exists/u,
    );
    await assert.rejects(stat(blockedExternalTarget), { code: 'ENOENT' });
  });
});

test('external release materialization copies only the exact subset and rollback removes only that owned release', async () => {
  await withTemporaryDirectory(async (base) => {
    const root = join(base, 'repository', 'apps', 'orquesta-desktop-next');
    const externalTarget = join(base, 'cargo-target');
    await mkdir(join(root, 'src-tauri'), { recursive: true });
    await preflightExternalDesktopReleaseMaterialization({
      root,
      buildId: testIds[0],
      ownerId: testIds[1],
      cargoTargetDir: externalTarget,
    });
    await writeExternalReleaseFixture(externalTarget);
    const materialized = await materializeExternalDesktopRelease({
      root,
      repositoryRoot: canonicalRepositoryRoot,
      buildId: testIds[0],
      ownerId: testIds[1],
      cargoTargetDir: externalTarget,
    });
    assert.equal((await stat(join(materialized.paths.canonicalReleaseRoot, fixtureDesktopExecutable))).isFile(), true);
    assert.equal((await stat(join(materialized.paths.canonicalReleaseRoot, 'runtime-dist', 'sidecar.cjs'))).isFile(), true);
    await assert.rejects(
      stat(join(materialized.paths.canonicalReleaseRoot, 'unrelated-debug-symbol.pdb')),
      { code: 'ENOENT' },
    );
    await assert.rejects(stat(externalTarget), { code: 'ENOENT' });

    await writeFile(join(materialized.paths.canonicalReleaseRoot, 'orquesta-desktop-next.release-attestation.json'), '{}\n');
    await writeFile(join(materialized.paths.canonicalReleaseRoot, 'orquesta-desktop-next.release-set.json'), '{}\n');
    const rolledBack = await rollbackMaterializedDesktopRelease({
      root,
      repositoryRoot: canonicalRepositoryRoot,
      buildId: testIds[0],
      ownerId: testIds[1],
      cargoTargetDir: externalTarget,
      expectedSnapshot: materialized.snapshot,
      attestationCreated: true,
      releaseSetCreated: true,
    });
    assert.equal(rolledBack.removed, true);
    await assert.rejects(stat(materialized.paths.canonicalReleaseRoot), { code: 'ENOENT' });
    await assert.rejects(stat(materialized.paths.temporaryReleaseRoot), { code: 'ENOENT' });
    await assert.rejects(stat(externalTarget), { code: 'ENOENT' });
  });
});

test('materialized release tamper prevents cleanup and preserves the lifecycle lock', async () => {
  await withTemporaryDirectory(async (base) => {
    const root = join(base, 'repository', 'apps', 'orquesta-desktop-next');
    const externalTarget = join(base, 'cargo-target');
    await mkdir(join(root, 'src-tauri'), { recursive: true });
    await preflightExternalDesktopReleaseMaterialization({
      root,
      buildId: testIds[0],
      ownerId: testIds[1],
      cargoTargetDir: externalTarget,
    });
    await writeExternalReleaseFixture(externalTarget);
    const materialized = await materializeExternalDesktopRelease({
      root,
      repositoryRoot: canonicalRepositoryRoot,
      buildId: testIds[0],
      ownerId: testIds[1],
      cargoTargetDir: externalTarget,
    });
    await writeFile(
      join(materialized.paths.canonicalReleaseRoot, 'runtime-dist', 'sidecar.cjs'),
      'tampered after materialization',
    );
    let failure;
    try {
      await rollbackMaterializedDesktopRelease({
        root,
        repositoryRoot: canonicalRepositoryRoot,
        buildId: testIds[0],
        ownerId: testIds[1],
        cargoTargetDir: externalTarget,
        expectedSnapshot: materialized.snapshot,
      });
    } catch (error) {
      failure = error;
    }
    assert.equal(failure?.message, 'desktop_release_materialization_rollback_tree_mismatch');
    assert.equal(failure?.desktopLifecyclePreserveLock, true);
    assert.equal((await stat(materialized.paths.canonicalReleaseRoot)).isDirectory(), true);
  });
});

test('external materialization rejects installer-directory extras and still removes its exact Cargo target', async () => {
  await withTemporaryDirectory(async (base) => {
    const root = join(base, 'repository', 'apps', 'orquesta-desktop-next');
    const externalTarget = join(base, 'cargo-target');
    await mkdir(join(root, 'src-tauri'), { recursive: true });
    await preflightExternalDesktopReleaseMaterialization({
      root,
      buildId: testIds[0],
      ownerId: testIds[1],
      cargoTargetDir: externalTarget,
    });
    await writeExternalReleaseFixture(externalTarget);
    await writeFile(join(externalTarget, 'release', 'bundle', 'msi', 'extra.txt'), 'unexpected');
    await assert.rejects(
      materializeExternalDesktopRelease({
        root,
        repositoryRoot: canonicalRepositoryRoot,
        buildId: testIds[0],
        ownerId: testIds[1],
        cargoTargetDir: externalTarget,
      }),
      /desktop_release_installer_set_mismatch/u,
    );
    await assert.rejects(stat(externalTarget), { code: 'ENOENT' });
    await assert.rejects(stat(join(root, 'src-tauri', 'target', 'release')), { code: 'ENOENT' });
  });
});

test('external Cargo target cleanup refuses an owner-marker mismatch and preserves the lock', async () => {
  await withTemporaryDirectory(async (base) => {
    const root = join(base, 'repository', 'apps', 'orquesta-desktop-next');
    const externalTarget = join(base, 'cargo-target');
    await mkdir(join(root, 'src-tauri'), { recursive: true });
    const claim = await preflightExternalDesktopReleaseMaterialization({
      root,
      buildId: testIds[0],
      ownerId: testIds[1],
      cargoTargetDir: externalTarget,
    });
    await writeFile(claim.externalOwnerMarkerPath, '{}\n');
    let failure;
    try {
      await cleanupOwnedExternalCargoTarget({
        root,
        buildId: testIds[0],
        ownerId: testIds[1],
        cargoTargetDir: externalTarget,
      });
    } catch (error) {
      failure = error;
    }
    assert.equal(failure?.message, 'desktop_release_external_cargo_owner_mismatch');
    assert.equal(failure?.desktopLifecyclePreserveLock, true);
    assert.equal((await stat(externalTarget)).isDirectory(), true);
  });
});

test('Vite output policy accepts only a marked UUID direct child', async () => {
  await withTemporaryDirectory(async (fakeProductRoot) => {
    const generationDir = join(fakeProductRoot, '.build-generations', 'generations', testIds[0]);
    await mkdir(generationDir, { recursive: true });
    await writeFile(
      join(generationDir, generationMarkerName),
      JSON.stringify({ buildId: testIds[0], nonce: testNonce }),
    );
    assert.equal(
      validateGenerationOutput({
        productRoot: fakeProductRoot,
        outDir: generationDir,
        buildId: testIds[0],
        nonce: testNonce,
      }),
      generationDir,
    );

    const rejected = [
      fakeProductRoot,
      join(fakeProductRoot, 'dist'),
      join(fakeProductRoot, '.build-generations'),
      join(fakeProductRoot, '.build-generations', 'generations', '..', testIds[0]),
      join(tmpdir(), testIds[0]),
      `..\\dist\\${testIds[0]}`,
    ];
    for (const outDir of rejected) {
      assert.throws(
        () =>
          validateGenerationOutput({
            productRoot: fakeProductRoot,
            outDir,
            buildId: testIds[0],
            nonce: testNonce,
          }),
        /frontend_generation_outside_allowed_root/u,
      );
    }
  });
});

test('Vite bundle gate rejects oversized bytes and too many chunks before write', () => {
  assert.deepEqual(
    assertViteBundleCapacity({
      'index.js': { type: 'chunk', code: '1234' },
      'index.css': { type: 'asset', source: '12' },
    }),
    { entries: 2, totalBytes: 6 },
  );
  assert.deepEqual(
    assertViteBundleCapacity({
      'assets/nested/index.js': { type: 'chunk', code: '1' },
    }),
    { entries: 3, totalBytes: 1 },
  );
  assert.throws(
    () =>
      assertViteBundleCapacity(
        {
          'index.js': { type: 'chunk', code: '1234' },
        },
        { maxBytes: 3 },
      ),
    /frontend_generation_bundle_capacity_exceeded/u,
  );
  assert.throws(
    () =>
      assertViteBundleCapacity(
        {
          'a.js': { type: 'chunk', code: '' },
          'b.js': { type: 'chunk', code: '' },
        },
        { maxEntries: 1 },
      ),
    /frontend_generation_bundle_capacity_exceeded/u,
  );
});

test('Vite output policy rejects a UUID child junction', async () => {
  await withTemporaryDirectory(async (fakeProductRoot) => {
    const generationParent = join(fakeProductRoot, '.build-generations', 'generations');
    const outside = join(fakeProductRoot, 'outside-generation');
    await mkdir(generationParent, { recursive: true });
    await mkdir(outside);
    await writeFile(
      join(outside, generationMarkerName),
      JSON.stringify({ buildId: testIds[0], nonce: testNonce }),
    );
    const generationDir = join(generationParent, testIds[0]);
    await symlink(outside, generationDir, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(
      () =>
        validateGenerationOutput({
          productRoot: fakeProductRoot,
          outDir: generationDir,
          buildId: testIds[0],
          nonce: testNonce,
        }),
      /frontend_generation_reparse_output_directory/u,
    );
  });
});

test('Vite output policy rejects a marker symlink', async () => {
  await withTemporaryDirectory(async (fakeProductRoot) => {
    const generationDir = join(fakeProductRoot, '.build-generations', 'generations', testIds[0]);
    await mkdir(generationDir, { recursive: true });
    const outsideMarker = join(fakeProductRoot, 'outside-marker.json');
    await writeFile(outsideMarker, JSON.stringify({ buildId: testIds[0], nonce: testNonce }));
    await symlink(outsideMarker, join(generationDir, generationMarkerName), 'file');
    assert.throws(
      () =>
        validateGenerationOutput({
          productRoot: fakeProductRoot,
          outDir: generationDir,
          buildId: testIds[0],
          nonce: testNonce,
        }),
      /frontend_generation_fresh_marker_missing/u,
    );
  });
});

test('capacity gate counts partial generations and receipt temps without deleting them', async () => {
  await withTemporaryDirectory(async (fakeProductRoot) => {
    const stagingRoot = join(fakeProductRoot, '.build-generations');
    await ensureBuildRoots(stagingRoot, fakeProductRoot);
    const partial = generationPaths(stagingRoot, testIds[0]);
    await mkdir(partial.generationDir, { recursive: false });
    await writeFile(join(partial.generationDir, generationMarkerName), Buffer.alloc(32));
    const temporaryReceipt = join(stagingRoot, 'receipts', `${testIds[0]}.json.${testIds[1]}.tmp`);
    await writeFile(temporaryReceipt, Buffer.alloc(32));

    await assert.rejects(
      assertBuildOutputCapacity(stagingRoot, {
        reserveGenerationEntries: 1,
        limits: { maxGenerationEntries: 1 },
      }),
      /frontend_generation_maintenance_required/u,
    );
    await assert.rejects(
      assertBuildOutputCapacity(stagingRoot, {
        limits: { maxTotalBytes: 16 },
      }),
      /frontend_generation_maintenance_required/u,
    );
    assert.equal((await stat(partial.generationDir)).isDirectory(), true);
    assert.equal((await stat(temporaryReceipt)).isFile(), true);
  });
});

test('capacity keeps exactly one rollover slot for replacement-before-retirement', async () => {
  await withTemporaryDirectory(async (fakeProductRoot) => {
    const stagingRoot = join(fakeProductRoot, '.build-generations');
    await ensureBuildRoots(stagingRoot, fakeProductRoot);
    for (let index = 1; index <= 8; index += 1) {
      await mkdir(join(stagingRoot, 'generations', fixtureBuildId(index)));
    }
    const eight = await assertBuildOutputCapacity(stagingRoot, { reserveGenerationEntries: 1 });
    assert.equal(eight.generationCount, 9);
    await mkdir(join(stagingRoot, 'generations', fixtureBuildId(9)));
    await assert.rejects(
      assertBuildOutputCapacity(stagingRoot, { reserveGenerationEntries: 1 }),
      /frontend_generation_maintenance_required/u,
    );
  });
});

test('a failed ninth build removes only its owned unpromoted artifacts so the rollover can retry', async () => {
  await withTemporaryDirectory(async (fakeProductRoot) => {
    const stagingRoot = join(fakeProductRoot, '.build-generations');
    await ensureBuildRoots(stagingRoot, fakeProductRoot);
    for (let index = 1; index <= 8; index += 1) {
      await mkdir(join(stagingRoot, 'generations', fixtureBuildId(index)));
    }
    const failedBuildId = fixtureBuildId(9);
    const ownerId = testIds[3];
    const paths = releasePromotionPaths(stagingRoot, failedBuildId);
    await mkdir(paths.generationDir);
    await writeFile(join(paths.generationDir, generationMarkerName), 'owned partial generation');
    await writeFile(paths.receiptPath, '{}\n');
    const ownedReleaseStaging = join(paths.releaseStagingRoot, `${failedBuildId}.${ownerId}.tmp`);
    await mkdir(ownedReleaseStaging);
    await assert.rejects(
      assertBuildOutputCapacity(stagingRoot, { reserveGenerationEntries: 1 }),
      /frontend_generation_maintenance_required/u,
    );

    const rolledBack = await rollbackUnpromotedFrontendBuildArtifacts({
      stagingRoot,
      buildId: failedBuildId,
      root: fakeProductRoot,
      ownerId,
      generationCreated: true,
      receiptCreated: true,
    });
    assert.deepEqual(rolledBack.removed, {
      releaseStaging: true,
      receiptTemporary: false,
      receipt: true,
      generation: true,
    });
    await assert.rejects(stat(paths.generationDir), { code: 'ENOENT' });
    await assert.rejects(stat(paths.receiptPath), { code: 'ENOENT' });
    await assert.rejects(stat(ownedReleaseStaging), { code: 'ENOENT' });
    const retry = await assertBuildOutputCapacity(stagingRoot, { reserveGenerationEntries: 1 });
    assert.equal(retry.generationCount, 9);
  });
});

test('unpromoted cleanup refuses a reparse-owned staging path and preserves the lifecycle lock', async () => {
  await withTemporaryDirectory(async (base) => {
    const fakeProductRoot = join(base, 'product');
    const outside = join(base, 'outside');
    await mkdir(fakeProductRoot);
    await mkdir(outside);
    const stagingRoot = join(fakeProductRoot, '.build-generations');
    await ensureBuildRoots(stagingRoot, fakeProductRoot);
    const ownerId = testIds[3];
    const paths = releasePromotionPaths(stagingRoot, testIds[2]);
    await mkdir(paths.generationDir);
    await writeFile(paths.receiptPath, '{}\n');
    const ownedReleaseStaging = join(paths.releaseStagingRoot, `${paths.buildId}.${ownerId}.tmp`);
    await symlink(outside, ownedReleaseStaging, process.platform === 'win32' ? 'junction' : 'dir');
    let failure;
    try {
      await rollbackUnpromotedFrontendBuildArtifacts({
        stagingRoot,
        buildId: paths.buildId,
        root: fakeProductRoot,
        ownerId,
        generationCreated: true,
        receiptCreated: true,
      });
    } catch (error) {
      failure = error;
    }
    assert.equal(failure?.message, 'frontend_generation_rollback_invalid_release_staging');
    assert.equal(failure?.desktopLifecyclePreserveLock, true);
    assert.equal((await stat(paths.generationDir)).isDirectory(), true);
    assert.equal((await stat(paths.receiptPath)).isFile(), true);
    assert.equal((await stat(outside)).isDirectory(), true);
  });
});

test('release lifecycle lock admits one coordinator and recovers a dead owner', async () => {
  await withTemporaryDirectory(async (fakeProductRoot) => {
    const stagingRoot = join(fakeProductRoot, '.build-generations');
    await ensureBuildRoots(stagingRoot, fakeProductRoot);
    const attempts = await Promise.allSettled([
      acquireDesktopLifecycleLock({ root: fakeProductRoot, stagingRoot, operation: 'build', ownerId: testIds[0] }),
      acquireDesktopLifecycleLock({ root: fakeProductRoot, stagingRoot, operation: 'test', ownerId: testIds[1] }),
      acquireDesktopLifecycleLock({ root: fakeProductRoot, stagingRoot, operation: 'clean', ownerId: testIds[2] }),
    ]);
    const fulfilled = attempts.filter((attempt) => attempt.status === 'fulfilled');
    const rejected = attempts.filter((attempt) => attempt.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 2);
    assert.equal(rejected.every((attempt) => /desktop_lifecycle_maintenance_required:lock_exists/u.test(attempt.reason.message)), true);
    await releaseDesktopLifecycleLock(fulfilled[0].value);

    const crashLockPath = join(stagingRoot, desktopLifecycleLockName);
    await assert.rejects(
      withDesktopLifecycleLock(
        { root: fakeProductRoot, stagingRoot, operation: 'retire-generation' },
        async () => {
          const error = new Error('retirement_pair_rollback_failed');
          error.desktopLifecyclePreserveLock = true;
          throw error;
        },
      ),
      /retirement_pair_rollback_failed/u,
    );
    assert.equal((await stat(crashLockPath)).isFile(), true);
    await rm(crashLockPath);

    await writeFile(crashLockPath, '{}', { flag: 'wx' });
    await assert.rejects(
      acquireDesktopLifecycleLock({ root: fakeProductRoot, stagingRoot, operation: 'build', ownerId: testIds[3] }),
      /desktop_lifecycle_maintenance_required:lock_exists/u,
    );
    assert.equal((await stat(crashLockPath)).isFile(), true);
    await rm(crashLockPath);

    await writeFile(crashLockPath, `${JSON.stringify({
      schemaVersion: 1,
      operation: 'build:desktop',
      ownerId: testIds[2],
      pid: 2_147_483_647,
      acquiredAt: new Date(0).toISOString(),
    })}\n`, { flag: 'wx' });
    const recovered = await acquireDesktopLifecycleLock({
      root: fakeProductRoot,
      stagingRoot,
      operation: 'build',
      ownerId: testIds[3],
    });
    await releaseDesktopLifecycleLock(recovered);
    await assert.rejects(stat(crashLockPath), { code: 'ENOENT' });
  });
});

test('lifecycle command routing locks mutations but leaves development checks concurrent', () => {
  assert.deepEqual(parseDesktopLifecycleArguments(['check:desktop-bindings']), {
    operation: 'check:desktop-bindings',
    kind: 'fixed-operation',
  });
  assert.deepEqual(parseDesktopLifecycleArguments(['generate:desktop-bindings']), {
    operation: 'generate:desktop-bindings',
    kind: 'fixed-operation',
  });
  assert.deepEqual(parseDesktopLifecycleArguments(['typecheck:local-core']), {
    operation: 'typecheck:local-core',
    kind: 'fixed-operation',
  });
  assert.deepEqual(parseDesktopLifecycleArguments(['test:native-contract']), {
    operation: 'test:native-contract',
    kind: 'fixed-operation',
  });
  assert.deepEqual(parseDesktopLifecycleArguments(['test:load']), {
    operation: 'test:load',
    kind: 'fixed-operation',
  });
  assert.throws(
    () => parseDesktopLifecycleArguments(['exec-file', resolve('C:/Windows/System32/cmd.exe')]),
    /generic_execution_retired/u,
  );
  assert.throws(
    () => parseDesktopLifecycleArguments(['install-release', resolve('C:/release/setup.exe')]),
    /generic_execution_retired/u,
  );
  assert.deepEqual(parseDesktopLifecycleArguments(['retire-generation', testIds[0]]), {
    operation: 'retire-generation',
    kind: 'retire-generation',
    buildId: testIds[0],
  });
  assert.throws(
    () => parseDesktopLifecycleArguments(['retire-generation', '../generation']),
    /requires_build_id/u,
  );
  assert.equal(desktopLifecycleOperationNeedsLock('generate:desktop-bindings'), true);
  assert.equal(desktopLifecycleOperationNeedsLock('clean:native'), true);
  assert.equal(desktopLifecycleOperationNeedsLock('retire-generation'), true);
  assert.equal(desktopLifecycleOperationNeedsLock('check:desktop-bindings'), false);
  assert.equal(desktopLifecycleOperationNeedsLock('typecheck'), false);
  assert.equal(desktopLifecycleOperationNeedsLock('test'), false);
  assert.equal(desktopLifecycleOperationNeedsLock('test:focused'), false);
});

test('release preflight automatically removes noncurrent and retired build history', async () => {
  await withTemporaryDirectory(async (fakeProductRoot) => {
    const stagingRoot = join(fakeProductRoot, '.build-generations');
    await ensureBuildRoots(stagingRoot, fakeProductRoot);
    const currentId = testIds[0];
    const obsoleteId = testIds[1];
    const retiredId = testIds[2];
    for (const buildId of [currentId, obsoleteId]) {
      await mkdir(join(stagingRoot, 'generations', buildId));
      await writeFile(join(stagingRoot, 'generations', buildId, 'artifact.txt'), buildId);
      await writeFile(join(stagingRoot, 'receipts', `${buildId}.json`), '{}\n');
      await mkdir(join(stagingRoot, 'releases', buildId));
      await writeFile(join(stagingRoot, 'releases', buildId, 'artifact.txt'), buildId);
    }
    await writeFile(join(stagingRoot, 'current-release.json'), `${JSON.stringify({
      schemaVersion: 1,
      kind: 'orquesta-desktop-current-release-pointer',
      buildId: currentId,
      promotion: {},
    })}\n`);
    for (const directory of ['generations', 'receipts', 'releases']) {
      await mkdir(join(stagingRoot, 'retired', directory), { recursive: true });
    }
    await mkdir(join(stagingRoot, 'retired', 'generations', retiredId));
    await writeFile(join(stagingRoot, 'retired', 'generations', retiredId, 'artifact.txt'), retiredId);
    await writeFile(join(stagingRoot, 'retired', 'receipts', `${retiredId}.json`), '{}\n');
    await mkdir(join(stagingRoot, 'retired', 'releases', retiredId));
    await writeFile(join(stagingRoot, 'retired', 'releases', retiredId, 'artifact.txt'), retiredId);

    const result = await pruneObsoleteDesktopBuildHistory({ stagingRoot, root: fakeProductRoot });
    assert.equal(result.protectedBuildId, currentId);
    assert.deepEqual(result.removedBuildIds, [obsoleteId]);
    assert.deepEqual(result.removedRetiredBuildIds, [retiredId]);
    assert.equal((await stat(join(stagingRoot, 'generations', currentId))).isDirectory(), true);
    await assert.rejects(stat(join(stagingRoot, 'generations', obsoleteId)), { code: 'ENOENT' });
    await assert.rejects(stat(join(stagingRoot, 'retired', 'generations', retiredId)), { code: 'ENOENT' });
  });
});

test('fixed lifecycle plans invoke only bounded tool entrypoints', async () => {
  const desktopPlan = await desktopLifecycleCommandPlan('test');
  assert.deepEqual(desktopPlan[0].args.slice(-4), [
    '--exclude',
    'tests/integration/**',
    '--exclude',
    'tests/load/**',
  ]);

  const loadPlan = await desktopLifecycleCommandPlan('test:load');
  assert.equal(loadPlan.length, 2);
  assert.match(loadPlan[0].args[0], /vitest\.mjs$/u);
  assert.deepEqual(loadPlan[0].args.slice(1), [
    'run',
    'tests/load/orquesta-map.test.tsx',
  ]);
  assert.deepEqual(loadPlan[0].env, { ORQUESTA_EXPLICIT_LOAD_TESTS: '1' });
  assert.match(loadPlan[1].executable, /cargo(?:\.exe)?$/u);
  assert.deepEqual(loadPlan[1].args, [
    'test',
    '--manifest-path',
    'src-tauri/Cargo.toml',
    'projection_service::tests::opens_latest_history_fifty_from_one_hundred_thousand_items',
    '--',
    '--ignored',
    '--exact',
  ]);
  assert.equal(loadPlan[1].env, undefined);
  assert.equal(loadPlan.flatMap((command) => Object.keys(command.env ?? {})).includes('CARGO_TARGET_DIR'), false);

  const runtimePlan = await desktopLifecycleCommandPlan('test:runtime');
  assert.equal(runtimePlan.length, 1);
  assert.equal(runtimePlan[0].executable, process.execPath);
  assert.equal(runtimePlan[0].args[0], '--test');
  assert.equal(runtimePlan[0].args.at(-1), 'scripts/frontend-generation.test.mjs');
  assert.equal(runtimePlan[0].args.some((argument) => argument.includes('*')), false);

  const nativePlan = await desktopLifecycleCommandPlan('test:native-contract');
  assert.equal(nativePlan.length, 2);
  assert.equal(nativePlan[0].executable, process.execPath);
  assert.match(nativePlan[0].args[0], /vitest\.mjs$/u);
  assert.equal(nativePlan[0].args.at(-1), 'tests/integration');
  assert.match(nativePlan[1].executable, /cargo(?:\.exe)?$/u);
  assert.deepEqual(nativePlan[1].args, ['test', '--manifest-path', 'src-tauri/Cargo.toml']);

  const cleanPlan = await desktopLifecycleCommandPlan('clean:native');
  assert.equal(cleanPlan.length, 1);
  assert.match(cleanPlan[0].executable, /cargo(?:\.exe)?$/u);
  assert.deepEqual(cleanPlan[0].args, [
    'clean',
    '--manifest-path',
    'src-tauri/Cargo.toml',
    '--target-dir',
    'src-tauri/target',
  ]);
  assert.equal(cleanPlan[0].env, undefined);
});

test('generation retirement preserves the verified pair and refuses the current release', async () => {
  await withTemporaryDirectory(async (fakeProductRoot) => {
    const stagingRoot = join(fakeProductRoot, '.build-generations');
    await ensureBuildRoots(stagingRoot, fakeProductRoot);
    await mkdir(join(stagingRoot, 'retired'));
    await mkdir(join(stagingRoot, 'retired', 'generations'));
    await mkdir(join(stagingRoot, 'retired', 'receipts'));
    const generation = generationPaths(stagingRoot, testIds[0]);
    await mkdir(generation.generationDir);
    await writeValidGeneration(generation.generationDir);
    await writeFrontendReceipt(generation, fakeProductRoot);
    const retired = await retireDesktopGeneration({
      buildId: testIds[0],
      root: fakeProductRoot,
      verifyReleaseAuthority: () => testIds[1],
    });
    assert.equal((await stat(retired.retiredGeneration)).isDirectory(), true);
    assert.equal((await stat(retired.retiredReceipt)).isFile(), true);
    await assert.rejects(stat(generation.generationDir), { code: 'ENOENT' });
    await assert.rejects(stat(generation.receiptPath), { code: 'ENOENT' });

    const current = generationPaths(stagingRoot, testIds[1]);
    await mkdir(current.generationDir);
    await writeValidGeneration(current.generationDir);
    await writeFrontendReceipt(current, fakeProductRoot);
    await assert.rejects(
      retireDesktopGeneration({
        buildId: testIds[1],
        root: fakeProductRoot,
        verifyReleaseAuthority: () => testIds[1],
      }),
      /retire_current_release_refused/u,
    );
    assert.equal((await stat(current.generationDir)).isDirectory(), true);
    assert.equal((await stat(current.receiptPath)).isFile(), true);
  });
});

test('noncurrent promotion retires its generation, unchanged receipt, and verified release archive together', async () => {
  await withTemporaryDirectory(async (repositoryRoot) => {
    const { first, firstPromotion, second } = await preparePromotedReleasePair(repositoryRoot);
    const receiptBytesBefore = await readFile(first.paths.receiptPath);
    assert.equal((await verifyDesktopReleaseArchive({
      stagingRoot: first.stagingRoot,
      buildId: first.paths.buildId,
      root: first.root,
    })).frontendBuildId, first.paths.buildId);

    const retired = await retireDesktopGeneration({
      buildId: first.paths.buildId,
      root: first.root,
    });
    assert.equal(retired.retiredRelease, join(first.stagingRoot, 'retired', 'releases', first.paths.buildId));
    assert.equal((await readFile(retired.retiredReceipt)).equals(receiptBytesBefore), true);
    assert.equal((await verifyRetiredDesktopReleaseArchive({
      stagingRoot: first.stagingRoot,
      buildId: first.paths.buildId,
      root: first.root,
    })).frontendBuildId, first.paths.buildId);
    await assert.rejects(stat(firstPromotion.paths.releaseRoot), { code: 'ENOENT' });
    assert.equal((await verifyCurrentDesktopRelease({
      stagingRoot: second.stagingRoot,
      root: second.root,
    })).frontendBuildId, second.paths.buildId);
    const postRetirementCapacity = await assertBuildOutputCapacity(first.stagingRoot);
    assert.equal(postRetirementCapacity.releaseCount, 1);
    assert.equal((await readFile(firstPromotion.paths.pointerPath, 'utf8')).includes(second.paths.buildId), true);
  });
});

test('tampered noncurrent release archive is rejected before any retirement move', async () => {
  await withTemporaryDirectory(async (repositoryRoot) => {
    const { first, firstPromotion } = await preparePromotedReleasePair(repositoryRoot);
    await writeFile(firstPromotion.paths.attestationCopyPath, '{}\n');
    await assert.rejects(
      retireDesktopGeneration({ buildId: first.paths.buildId, root: first.root }),
      /desktop_release_promotion_attestation_hash_mismatch/u,
    );
    assert.equal((await stat(first.paths.generationDir)).isDirectory(), true);
    assert.equal((await stat(first.paths.receiptPath)).isFile(), true);
    assert.equal((await stat(firstPromotion.paths.releaseRoot)).isDirectory(), true);
    await assert.rejects(
      stat(join(first.stagingRoot, 'retired', 'generations', first.paths.buildId)),
      { code: 'ENOENT' },
    );
  });
});

test('release archive move failure rolls the earlier pair moves back to active state', async () => {
  await withTemporaryDirectory(async (repositoryRoot) => {
    const { first, firstPromotion } = await preparePromotedReleasePair(repositoryRoot);
    const { rename: realRename } = await import('node:fs/promises');
    let moveCount = 0;
    const move = async (source, destination) => {
      moveCount += 1;
      if (moveCount === 3) throw new Error('release_archive_move_failed');
      await realRename(source, destination);
    };
    let failure;
    try {
      await retireDesktopGeneration({ buildId: first.paths.buildId, root: first.root, move });
    } catch (error) {
      failure = error;
    }
    assert.equal(failure?.message, 'release_archive_move_failed');
    assert.equal(failure?.desktopLifecyclePreserveLock, undefined);
    assert.equal((await stat(first.paths.generationDir)).isDirectory(), true);
    assert.equal((await stat(first.paths.receiptPath)).isFile(), true);
    assert.equal((await stat(firstPromotion.paths.releaseRoot)).isDirectory(), true);
  });
});

test('release archive rollback failure is surfaced and preserves the lifecycle lock', async () => {
  await withTemporaryDirectory(async (repositoryRoot) => {
    const { first, firstPromotion } = await preparePromotedReleasePair(repositoryRoot);
    const { rename: realRename } = await import('node:fs/promises');
    let moveCount = 0;
    const move = async (source, destination) => {
      moveCount += 1;
      if (moveCount === 3) throw new Error('release_archive_move_failed');
      if (moveCount === 4) throw new Error('receipt_rollback_failed');
      await realRename(source, destination);
    };
    let failure;
    try {
      await retireDesktopGeneration({ buildId: first.paths.buildId, root: first.root, move });
    } catch (error) {
      failure = error;
    }
    assert.equal(failure?.message, 'release_archive_move_failed');
    assert.equal(failure?.desktopLifecycleRollbackError, 'receipt_rollback_failed');
    assert.equal(failure?.desktopLifecyclePreserveLock, true);
    assert.equal((await stat(first.paths.generationDir)).isDirectory(), true);
    assert.equal((await stat(join(first.stagingRoot, 'retired', 'receipts', `${first.paths.buildId}.json`))).isFile(), true);
    assert.equal((await stat(firstPromotion.paths.releaseRoot)).isDirectory(), true);
  });
});

test('generation retirement marks an unrolled split fail-closed instead of hiding it', async () => {
  await withTemporaryDirectory(async (fakeProductRoot) => {
    const stagingRoot = join(fakeProductRoot, '.build-generations');
    await ensureBuildRoots(stagingRoot, fakeProductRoot);
    const generation = generationPaths(stagingRoot, testIds[2]);
    await mkdir(generation.generationDir);
    await writeValidGeneration(generation.generationDir);
    await writeFrontendReceipt(generation, fakeProductRoot);
    let moveCount = 0;
    const move = async (source, destination) => {
      moveCount += 1;
      if (moveCount === 1) {
        const { rename: realRename } = await import('node:fs/promises');
        await realRename(source, destination);
        return;
      }
      const error = new Error(moveCount === 2 ? 'receipt_move_failed' : 'generation_rollback_failed');
      error.code = moveCount === 2 ? 'EBUSY' : 'EPERM';
      throw error;
    };
    let failure;
    try {
      await retireDesktopGeneration({
        buildId: testIds[2],
        root: fakeProductRoot,
        verifyReleaseAuthority: () => testIds[3],
        move,
      });
    } catch (error) {
      failure = error;
    }
    assert.equal(failure?.message, 'receipt_move_failed');
    assert.equal(failure?.desktopLifecycleRollbackError, 'generation_rollback_failed');
    assert.equal(failure?.desktopLifecyclePreserveLock, true);
    assert.equal((await stat(join(stagingRoot, 'retired', 'generations', testIds[2]))).isDirectory(), true);
    assert.equal((await stat(generation.receiptPath)).isFile(), true);
  });
});

test('lifecycle lock root is exactly one canonical child of the selected product', async () => {
  await withTemporaryDirectory(async (fakeProductRoot) => {
    await assert.rejects(
      acquireDesktopLifecycleLock({
        root: fakeProductRoot,
        stagingRoot: join(fakeProductRoot, 'alternate-lock-root'),
        operation: 'test',
      }),
      /noncanonical_lock_root/u,
    );
  });
});

test('build root rejects a symlink or junction instead of writing through it', async () => {
  await withTemporaryDirectory(async (base) => {
    const fakeProductRoot = join(base, 'product');
    const outside = join(base, 'outside');
    await mkdir(fakeProductRoot);
    await mkdir(outside);
    const stagingRoot = join(fakeProductRoot, '.build-generations');
    await symlink(outside, stagingRoot, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(
      ensureBuildRoots(stagingRoot, fakeProductRoot),
      /frontend_generation_reparse_directory/u,
    );
  });
});

test('package scripts keep development direct and release packaging coordinated', async () => {
  const packageJson = JSON.parse(await readFile(join(productRoot, 'package.json'), 'utf8'));
  const expectedScripts = {
    build: 'node scripts/build-frontend-generation.mjs',
    'build:desktop': 'node scripts/build-frontend-generation.mjs --desktop',
    'build:runtime': 'node scripts/build-frontend-generation.mjs --runtime-only',
    dev: 'vite',
    'dev:desktop': 'node scripts/build-frontend-generation.mjs --dev-desktop',
    'generate:desktop-bindings': 'node scripts/run-desktop-lifecycle.mjs generate:desktop-bindings',
    'check:desktop-bindings': 'node scripts/run-desktop-lifecycle.mjs check:desktop-bindings',
    typecheck: 'node scripts/run-desktop-lifecycle.mjs typecheck',
    'typecheck:runtime': 'node scripts/run-desktop-lifecycle.mjs typecheck',
    test: 'node scripts/run-desktop-lifecycle.mjs test',
    'test:load': 'node scripts/run-desktop-lifecycle.mjs test:load',
    'test:native-contract': 'node scripts/run-desktop-lifecycle.mjs test:native-contract',
    'clean:native': 'node scripts/run-desktop-lifecycle.mjs clean:native',
  };
  for (const [name, command] of Object.entries(expectedScripts)) {
    assert.equal(packageJson.scripts[name], command);
  }
  assert.equal(packageJson.scripts['lifecycle:install-release'], undefined);
  assert.equal(packageJson.scripts['lifecycle:exec'], undefined);
  assert.equal(packageJson.scripts['lifecycle:retire-generation'], undefined);
  assert.deepEqual(Object.keys(packageJson.scripts).filter((name) => name.endsWith(':unlocked')), []);

  const tauriConfig = JSON.parse(await readFile(join(productRoot, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  assert.equal(tauriConfig.build.beforeBuildCommand, 'node scripts/require-frontend-generation.mjs');
  assert.equal(tauriConfig.build.frontendDist, '../.frontend-generation-not-selected');
  assert.match(tauriConfig.app.security.csp, /frame-ancestors 'none'/u);
  assert.match(tauriConfig.app.security.csp, /object-src 'none'/u);
  const sourceHtml = await readFile(join(productRoot, 'index.html'), 'utf8');
  assert.doesNotMatch(sourceHtml, /http-equiv=["']Content-Security-Policy["']/iu);
});
