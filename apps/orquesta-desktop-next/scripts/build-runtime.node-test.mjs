import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  analyzeRuntimeBuildInputs,
  assertRuntimeExplicitBuildInputFiles,
  assertRetiredRuntimeSemanticsAbsent,
  desktopOperationAssetRelativePaths,
  promoteRuntimeGeneration,
  stageDesktopOperationAssets,
} from './build-runtime.mjs';

const roots = [];
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
test.afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function generationFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'orquesta-runtime-generation-'));
  roots.push(root);
  const paths = Object.fromEntries([
    'stagedRuntimeOut', 'stagedCodexRuntimeOut', 'currentRuntimeOut', 'currentCodexRuntimeOut',
  ].map((name) => [name, path.join(root, name)]));
  for (const [name, directory] of Object.entries(paths)) {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'identity.txt'), name.startsWith('staged') ? 'next' : 'previous', 'utf8');
  }
  return { root, paths, transactionRoot: path.join(root, 'transaction') };
}

test('promotes both verified runtime roots as one generation', async () => {
  const fixture = await generationFixture();
  await promoteRuntimeGeneration({ ...fixture.paths, transactionRoot: fixture.transactionRoot });
  assert.equal(await readFile(path.join(fixture.paths.currentRuntimeOut, 'identity.txt'), 'utf8'), 'next');
  assert.equal(await readFile(path.join(fixture.paths.currentCodexRuntimeOut, 'identity.txt'), 'utf8'), 'next');
});

test('restores both last-known-good roots when promotion fails between the two renames', async () => {
  const fixture = await generationFixture();
  await assert.rejects(promoteRuntimeGeneration({
    ...fixture.paths,
    transactionRoot: fixture.transactionRoot,
    beforeCodexPromotion: async () => { throw new Error('injected promotion failure'); },
  }), /injected promotion failure/u);
  assert.equal(await readFile(path.join(fixture.paths.currentRuntimeOut, 'identity.txt'), 'utf8'), 'previous');
  assert.equal(await readFile(path.join(fixture.paths.currentCodexRuntimeOut, 'identity.txt'), 'utf8'), 'previous');
});

test('marks an incomplete runtime rollback fail-closed for the lifecycle owner', async () => {
  const fixture = await generationFixture();
  let moveCount = 0;
  let failure;
  try {
    await promoteRuntimeGeneration({
      ...fixture.paths,
      transactionRoot: fixture.transactionRoot,
      move: async (source, destination) => {
        moveCount += 1;
        if (moveCount === 4) throw Object.assign(new Error('injected codex promotion failure'), { code: 'EBUSY' });
        if (moveCount === 5) throw Object.assign(new Error('injected runtime rollback failure'), { code: 'EPERM' });
        await rename(source, destination);
      },
    });
  } catch (error) {
    failure = error;
  }

  assert.ok(failure instanceof AggregateError);
  assert.equal(failure.message, 'runtime_generation_promotion_rollback_failed');
  assert.equal(failure.desktopLifecyclePreserveLock, true);
  assert.equal(moveCount, 7);
});

test('rejects every retired runtime marker, including the Electron e2e environment', () => {
  assert.doesNotThrow(() => assertRetiredRuntimeSemanticsAbsent('ordinary sidecar'));
  for (const marker of [
    'ORQUESTA_EXECUTION_KERNEL_SHADOW_V2',
    'DesktopExecutionShadowController',
    'execution-kernel-shadow-v2.json',
    'Orquesta Core must run as an Electron utility process',
    'process.parentPort',
    'ELECTRON_RUN_AS_NODE',
  ]) assert.throws(() => assertRetiredRuntimeSemanticsAbsent(marker), /retired_runtime_semantics_present/u);
});

test('the attested build-input manifest covers the actual runtime dependency graph and staged assets', async () => {
  const coverage = await analyzeRuntimeBuildInputs();
  assert.ok(coverage.required.includes('packages/business-orchestrator/src/index.js'));
  assert.ok(coverage.required.includes('packages/event-store/src/index.js'));
  assert.ok(coverage.required.includes('packages/contracts/scripts/generate-desktop-bindings.mjs'));
  assert.ok(coverage.required.includes('packages/contracts/desktop/runtime-method-policy.v1.json'));
  assert.ok(!coverage.required.includes('packages/contracts/generated/desktop/runtime-method-policy.v1.json'));
  for (const relativePath of desktopOperationAssetRelativePaths) {
    assert.ok(coverage.required.includes(relativePath));
  }
});

test('requires every explicit runtime file input to exist as a file', async () => {
  const productRoot = await mkdtemp(path.join(os.tmpdir(), 'orquesta-runtime-explicit-inputs-'));
  roots.push(productRoot);
  const relativePaths = ['present.txt', 'missing.txt'];
  await writeFile(path.join(productRoot, relativePaths[0]), 'present', 'utf8');

  await assert.rejects(
    assertRuntimeExplicitBuildInputFiles({ productRoot, relativePaths }),
    /runtime_explicit_build_input_not_file:missing\.txt/u,
  );

  await mkdir(path.join(productRoot, relativePaths[1]));
  await assert.rejects(
    assertRuntimeExplicitBuildInputFiles({ productRoot, relativePaths }),
    /runtime_explicit_build_input_not_file:missing\.txt/u,
  );

  await rm(path.join(productRoot, relativePaths[1]), { recursive: true, force: true });
  await writeFile(path.join(productRoot, relativePaths[1]), 'present', 'utf8');
  await assert.doesNotReject(assertRuntimeExplicitBuildInputFiles({ productRoot, relativePaths }));
});

test('stages only the immutable Desktop operation assets under runtime-dist', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'orquesta-runtime-assets-'));
  roots.push(root);
  const productRoot = path.join(root, 'product');
  const runtimeOut = path.join(root, 'runtime-dist');
  for (const relativePath of desktopOperationAssetRelativePaths) {
    const source = path.join(productRoot, ...relativePath.split('/'));
    await mkdir(path.dirname(source), { recursive: true });
    await cp(path.join(repositoryRoot, ...relativePath.split('/')), source);
  }
  const unrelated = path.join(productRoot, 'orquesta', 'references', 'unrelated.md');
  await writeFile(unrelated, 'must not be packaged', 'utf8');

  await stageDesktopOperationAssets({ productRoot, runtimeOut });

  for (const relativePath of desktopOperationAssetRelativePaths) {
    assert.equal(
      await readFile(path.join(runtimeOut, ...relativePath.split('/')), 'utf8'),
      await readFile(path.join(productRoot, ...relativePath.split('/')), 'utf8'),
    );
  }
  await assert.rejects(readFile(path.join(runtimeOut, 'orquesta', 'references', 'unrelated.md'), 'utf8'), {
    code: 'ENOENT',
  });
});

test('rejects corrupted Desktop operation assets before runtime generation promotion', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'orquesta-runtime-assets-corrupt-'));
  roots.push(root);
  const productRoot = path.join(root, 'product');
  const runtimeOut = path.join(root, 'runtime-dist');
  for (const relativePath of desktopOperationAssetRelativePaths) {
    const source = path.join(productRoot, ...relativePath.split('/'));
    await mkdir(path.dirname(source), { recursive: true });
    await cp(path.join(repositoryRoot, ...relativePath.split('/')), source);
  }
  await writeFile(
    path.join(productRoot, 'orquesta', 'references', 'organization-agent-placement-persistent-v1.md'),
    'corrupted instruction',
    'utf8',
  );

  await assert.rejects(
    stageDesktopOperationAssets({ productRoot, runtimeOut }),
    /Desktop operation assets do not match the generated catalog/u,
  );
});
