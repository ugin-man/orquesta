import { lstat, mkdir, readFile, readdir, realpath, rename } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  desktopProductRoot,
  withDesktopLifecycleLock,
} from './desktop-lifecycle-lock.mjs';
import { buildIdPattern } from './frontend-generation-policy.mjs';
import {
  readAndVerifyReceipt,
  verifyDesktopReleaseArchive,
  verifyCurrentDesktopRelease,
  verifyRetiredDesktopReleaseArchive,
  verifyRetiredGenerationReceipt,
} from './build-frontend-generation.mjs';
import { generateDesktopBindings } from '../../../packages/contracts/scripts/generate-desktop-bindings.mjs';

const require = createRequire(import.meta.url);

const npmOperations = new Set([
  'check:desktop-bindings',
  'generate:desktop-bindings',
  'typecheck',
  'typecheck:local-core',
  'test',
  'test:load',
  'test:focused',
  'test:runtime',
  'test:native-contract',
  'clean:native',
]);
const maxRetiredGenerationPairs = 32;

function comparable(value) {
  const normalized = resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function parseDesktopLifecycleArguments(argv) {
  const [operation, ...args] = argv;
  if (npmOperations.has(operation)) {
    if (args.length !== 0) throw new Error('desktop_lifecycle_unexpected_arguments');
    return { operation, kind: 'fixed-operation' };
  }
  if (operation === 'exec-file' || operation === 'install-release') {
    throw new Error('desktop_lifecycle_generic_execution_retired');
  }
  if (operation === 'retire-generation') {
    if (args.length !== 1 || !buildIdPattern.test(args[0])) {
      throw new Error('desktop_lifecycle_retire_generation_requires_build_id');
    }
    return { operation, kind: 'retire-generation', buildId: args[0] };
  }
  throw new Error('desktop_lifecycle_usage');
}

async function assertPlainExecutable(executable) {
  const metadata = await lstat(executable);
  const canonical = await realpath(executable);
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || comparable(canonical) !== comparable(executable)
  ) {
    throw new Error('desktop_lifecycle_executable_is_not_plain_file');
  }
}

async function assertPathExecutable(executable, name) {
  try {
    await assertPlainExecutable(executable);
    return;
  } catch (error) {
    if (error?.message !== 'desktop_lifecycle_executable_is_not_plain_file' || name !== 'cargo') {
      throw error;
    }
  }

  // rustup installs cargo as a same-directory proxy symlink. Accept that one
  // bounded shape while keeping arbitrary PATH links out of the lifecycle plan.
  const canonical = await realpath(executable);
  const rustupProxy = join(dirname(executable), process.platform === 'win32' ? 'rustup.exe' : 'rustup');
  if (comparable(canonical) !== comparable(rustupProxy)) {
    throw new Error('desktop_lifecycle_executable_is_not_plain_file');
  }
  await assertPlainExecutable(canonical);
}

async function assertPlainPath(path, kind, label) {
  const metadata = await lstat(path);
  const canonical = await realpath(path);
  if (
    (kind === 'directory' ? !metadata.isDirectory() : !metadata.isFile())
    || metadata.isSymbolicLink()
    || comparable(canonical) !== comparable(path)
  ) {
    throw new Error(`desktop_lifecycle_retire_invalid_${label}`);
  }
}

async function assertMissing(path, label) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`desktop_lifecycle_retire_destination_exists:${label}`);
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function ensurePlainDirectory(path, label) {
  try {
    await mkdir(path, { recursive: false });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  await assertPlainPath(path, 'directory', label);
}

async function verifyRetiredPairCapacity(stagingRoot) {
  const generationRoot = join(stagingRoot, 'retired', 'generations');
  const receiptRoot = join(stagingRoot, 'retired', 'receipts');
  const releaseRoot = join(stagingRoot, 'retired', 'releases');
  const generations = await readdir(generationRoot, { withFileTypes: true });
  const receipts = await readdir(receiptRoot, { withFileTypes: true });
  const releases = await readdir(releaseRoot, { withFileTypes: true });
  const generationIds = generations.map((entry) => {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !buildIdPattern.test(entry.name)) {
      throw new Error(`desktop_lifecycle_retire_archive_invalid:generation:${entry.name}`);
    }
    return entry.name;
  }).sort();
  const receiptIds = receipts.map((entry) => {
    const match = /^([0-9a-f-]{36})\.json$/u.exec(entry.name);
    if (!entry.isFile() || entry.isSymbolicLink() || match === null || !buildIdPattern.test(match[1])) {
      throw new Error(`desktop_lifecycle_retire_archive_invalid:receipt:${entry.name}`);
    }
    return match[1];
  }).sort();
  if (JSON.stringify(generationIds) !== JSON.stringify(receiptIds)) {
    throw new Error('desktop_lifecycle_retire_archive_pair_mismatch');
  }
  const releaseIds = releases.map((entry) => {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !buildIdPattern.test(entry.name)) {
      throw new Error(`desktop_lifecycle_retire_archive_invalid:release:${entry.name}`);
    }
    return entry.name;
  }).sort();
  if (releaseIds.some((releaseId) => !generationIds.includes(releaseId))) {
    throw new Error('desktop_lifecycle_retire_archive_release_without_pair');
  }
  if (generationIds.length >= maxRetiredGenerationPairs) {
    throw new Error('desktop_lifecycle_retire_archive_capacity_exceeded');
  }
  return { generationIds, receiptIds, releaseIds };
}

export async function verifyCanonicalReleaseAuthority(root) {
  return verifyCurrentDesktopRelease({
    root: resolve(root),
    stagingRoot: join(resolve(root), '.build-generations'),
  });
}

export async function retireDesktopGeneration({
  buildId,
  root = desktopProductRoot,
  verifyReleaseAuthority = verifyCanonicalReleaseAuthority,
  verifyGenerationReceipt = readAndVerifyReceipt,
  verifyReleaseArchive = verifyDesktopReleaseArchive,
  verifyRetiredReleaseArchive = verifyRetiredDesktopReleaseArchive,
  move = rename,
} = {}) {
  if (typeof buildId !== 'string' || !buildIdPattern.test(buildId)) {
    throw new Error('desktop_lifecycle_retire_generation_requires_build_id');
  }

  const stagingRoot = join(resolve(root), '.build-generations');
  const activeGeneration = join(stagingRoot, 'generations', buildId);
  const activeReceipt = join(stagingRoot, 'receipts', `${buildId}.json`);
  const activeRelease = join(stagingRoot, 'releases', buildId);
  const retiredGenerationRoot = join(stagingRoot, 'retired', 'generations');
  const retiredReceiptRoot = join(stagingRoot, 'retired', 'receipts');
  const retiredReleaseRoot = join(stagingRoot, 'retired', 'releases');
  const retiredGeneration = join(retiredGenerationRoot, buildId);
  const retiredReceipt = join(retiredReceiptRoot, `${buildId}.json`);
  const retiredRelease = join(retiredReleaseRoot, buildId);

  await assertPlainPath(stagingRoot, 'directory', 'lifecycle_root');
  await assertPlainPath(join(stagingRoot, 'generations'), 'directory', 'active_generation_root');
  await assertPlainPath(join(stagingRoot, 'receipts'), 'directory', 'active_receipt_root');
  await assertPlainPath(join(stagingRoot, 'releases'), 'directory', 'active_release_root');
  await ensurePlainDirectory(join(stagingRoot, 'retired'), 'retired_root');
  await ensurePlainDirectory(retiredGenerationRoot, 'retired_generation_root');
  await ensurePlainDirectory(retiredReceiptRoot, 'retired_receipt_root');
  await ensurePlainDirectory(retiredReleaseRoot, 'retired_release_root');
  await verifyRetiredPairCapacity(stagingRoot);
  await assertPlainPath(activeGeneration, 'directory', 'active_generation');
  await assertPlainPath(activeReceipt, 'file', 'active_receipt');
  await assertMissing(retiredGeneration, 'generation');
  await assertMissing(retiredReceipt, 'receipt');
  await assertMissing(retiredRelease, 'release');

  const verifiedGeneration = await verifyGenerationReceipt(stagingRoot, buildId, resolve(root));
  const receipt = verifiedGeneration?.receipt ?? JSON.parse(await readFile(activeReceipt, 'utf8'));
  if (
    receipt?.schemaVersion !== 1
    || receipt?.buildId !== buildId
    || comparable(receipt?.generationDir ?? '') !== comparable(activeGeneration)
  ) {
    throw new Error('desktop_lifecycle_retire_receipt_identity_mismatch');
  }
  const releaseAuthority = await verifyReleaseAuthority(resolve(root));
  const currentBuildId = typeof releaseAuthority === 'string'
    ? releaseAuthority
    : releaseAuthority?.frontendBuildId;
  if (currentBuildId === buildId) {
    throw new Error('desktop_lifecycle_retire_current_release_refused');
  }
  const hasReleaseArchive = await pathExists(activeRelease);
  if (hasReleaseArchive) {
    await assertPlainPath(activeRelease, 'directory', 'active_release');
    await verifyReleaseArchive({ stagingRoot, buildId, root: resolve(root) });
  }

  const transitions = [
    [activeGeneration, retiredGeneration],
    [activeReceipt, retiredReceipt],
    ...(hasReleaseArchive ? [[activeRelease, retiredRelease]] : []),
  ];
  const completed = [];
  try {
    for (const [source, destination] of transitions) {
      await move(source, destination);
      completed.push([source, destination]);
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const [source, destination] of completed.reverse()) {
      try {
        await move(destination, source);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
      }
    }
    if (rollbackErrors.length > 0) {
      error.desktopLifecycleRollbackError = rollbackErrors.join(';');
      error.desktopLifecyclePreserveLock = true;
    }
    throw error;
  }
  try {
    await verifyRetiredGenerationReceipt(stagingRoot, buildId, resolve(root));
    if (hasReleaseArchive) {
      await verifyRetiredReleaseArchive({ stagingRoot, buildId, root: resolve(root) });
    }
  } catch (error) {
    error.desktopLifecyclePreserveLock = true;
    throw error;
  }
  return {
    buildId,
    retiredGeneration,
    retiredReceipt,
    retiredRelease: hasReleaseArchive ? retiredRelease : null,
  };
}

function boundedLifecycleEnvironment(overrides = {}) {
  const entries = Object.entries(overrides);
  if (
    entries.some(([name, value]) => name !== 'ORQUESTA_EXPLICIT_LOAD_TESTS' || value !== '1')
  ) {
    throw new Error('desktop_lifecycle_environment_override_invalid');
  }
  return { ...process.env, ...overrides };
}

function runProcess(executable, args, cwd, envOverrides) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, {
      cwd,
      env: boundedLifecycleEnvironment(envOverrides),
      shell: false,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => {
      if (signal) {
        rejectRun(new Error(`desktop_lifecycle_child_signalled:${signal}`));
        return;
      }
      if (code !== 0) {
        rejectRun(new Error(`desktop_lifecycle_child_failed:${code}`));
        return;
      }
      resolveRun();
    });
  });
}

async function resolvePackageBin(packageName, binName) {
  const packagePath = require.resolve(`${packageName}/package.json`);
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
  const declaredBin = typeof packageJson.bin === 'string' ? packageJson.bin : packageJson.bin?.[binName];
  if (typeof declaredBin !== 'string' || declaredBin.length === 0) {
    throw new Error(`desktop_lifecycle_package_bin_missing:${packageName}:${binName}`);
  }
  const executable = resolve(dirname(packagePath), declaredBin);
  await assertPlainExecutable(executable);
  return executable;
}

async function resolvePathExecutable(name) {
  const suffixes = process.platform === 'win32' ? ['.exe'] : [''];
  for (const entry of (process.env.PATH ?? '').split(delimiter)) {
    if (!entry) continue;
    for (const suffix of suffixes) {
      const candidate = resolve(entry, `${name}${suffix}`);
      try {
        await assertPathExecutable(candidate, name);
        return candidate;
      } catch (error) {
        if (
          error?.code === 'ENOENT'
          || error?.message === 'desktop_lifecycle_executable_is_not_plain_file'
        ) {
          continue;
        }
        throw error;
      }
    }
  }
  throw new Error(`desktop_lifecycle_executable_not_found:${name}`);
}

async function matchingTestFiles(directory, suffix) {
  const entries = await readdir(join(desktopProductRoot, directory), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(suffix))
    .map((entry) => join(directory, entry.name))
    .sort();
}

export async function desktopLifecycleCommandPlan(operation) {
  if (operation === 'check:desktop-bindings' || operation === 'generate:desktop-bindings') {
    return [];
  }
  if (operation === 'typecheck') {
    const tsc = await resolvePackageBin('typescript', 'tsc');
    return ['tsconfig.app.json', 'tsconfig.node.json', 'tsconfig.runtime.json'].map((project) => ({
      executable: process.execPath,
      args: [tsc, '-p', project],
    }));
  }
  if (operation === 'typecheck:local-core') {
    const tsc = await resolvePackageBin('typescript', 'tsc');
    return [{
      executable: process.execPath,
      args: [tsc, '-p', '../../packages/local-core/tsconfig.json'],
    }];
  }
  if (operation === 'test') {
    const vitest = await resolvePackageBin('vitest', 'vitest');
    return [
      {
        executable: process.execPath,
        args: [
          vitest,
          'run',
          '--exclude',
          'tests/integration/**',
          '--exclude',
          'tests/load/**',
        ],
      },
      { executable: process.execPath, args: ['--test', ...await matchingTestFiles('scripts', '.node-test.mjs')] },
    ];
  }
  if (operation === 'test:load') {
    const [vitest, cargo] = await Promise.all([
      resolvePackageBin('vitest', 'vitest'),
      resolvePathExecutable('cargo'),
    ]);
    return [
      {
        executable: process.execPath,
        args: [vitest, 'run', 'tests/load/orquesta-map.test.tsx'],
        env: { ORQUESTA_EXPLICIT_LOAD_TESTS: '1' },
      },
      {
        executable: cargo,
        args: [
          'test',
          '--manifest-path',
          'src-tauri/Cargo.toml',
          'projection_service::tests::opens_latest_history_fifty_from_one_hundred_thousand_items',
          '--',
          '--ignored',
          '--exact',
        ],
      },
    ];
  }
  if (operation === 'test:focused') {
    const vitest = await resolvePackageBin('vitest', 'vitest');
    return [{
      executable: process.execPath,
      args: [
        vitest,
        'run',
        'tests/application-store.test.ts',
        'tests/workspace-view.test.tsx',
        'tests/projection-event-coordinator.test.ts',
      ],
    }];
  }
  if (operation === 'test:runtime') {
    return [{
      executable: process.execPath,
      args: [
        '--test',
        ...await matchingTestFiles('runtime-node', '.test.mjs'),
        'scripts/frontend-generation.test.mjs',
      ],
    }];
  }
  if (operation === 'test:native-contract') {
    const [vitest, cargo] = await Promise.all([
      resolvePackageBin('vitest', 'vitest'),
      resolvePathExecutable('cargo'),
    ]);
    return [
      { executable: process.execPath, args: [vitest, 'run', 'tests/integration'] },
      { executable: cargo, args: ['test', '--manifest-path', 'src-tauri/Cargo.toml'] },
    ];
  }
  if (operation === 'clean:native') {
    const cargo = await resolvePathExecutable('cargo');
    return [{
      executable: cargo,
      args: [
        'clean',
        '--manifest-path',
        'src-tauri/Cargo.toml',
        '--target-dir',
        'src-tauri/target',
      ],
    }];
  }
  throw new Error('desktop_lifecycle_operation_plan_missing');
}

export async function runDesktopLifecycle(argv = process.argv.slice(2)) {
  const request = parseDesktopLifecycleArguments(argv);
  return withDesktopLifecycleLock({ operation: request.operation }, async () => {
    if (request.kind === 'retire-generation') {
      const retired = await retireDesktopGeneration({ buildId: request.buildId });
      process.stdout.write(`desktop_generation_retired ${JSON.stringify(retired)}\n`);
      return;
    }

    if (request.operation === 'generate:desktop-bindings') {
      await generateDesktopBindings();
    } else if (
      request.operation === 'check:desktop-bindings'
      || request.operation === 'typecheck'
      || request.operation === 'typecheck:local-core'
    ) {
      await generateDesktopBindings({ check: true });
    }

    const commands = await desktopLifecycleCommandPlan(request.operation);
    for (const command of commands) {
      await runProcess(command.executable, command.args, desktopProductRoot, command.env);
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runDesktopLifecycle().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
