import { open, lstat, mkdir, realpath, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptRoot = dirname(fileURLToPath(import.meta.url));

export const desktopProductRoot = resolve(scriptRoot, '..');
export const defaultDesktopLifecycleRoot = join(desktopProductRoot, '.build-generations');
// Keep the historical path so an older or crashed coordinator cannot be
// silently bypassed during the lifecycle-lock cutover.
export const desktopLifecycleLockName = 'build.lock';

function comparable(value) {
  const normalized = resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function assertInside(root, candidate) {
  const child = relative(root, candidate);
  if (child.startsWith('..') || isAbsolute(child)) {
    throw new Error('desktop_lifecycle_lock_path_escaped_product_root');
  }
}

async function assertPlainDirectory(directory, label) {
  const metadata = await lstat(directory);
  const canonical = await realpath(directory);
  if (
    !metadata.isDirectory()
    || metadata.isSymbolicLink()
    || comparable(canonical) !== comparable(directory)
  ) {
    throw new Error(`desktop_lifecycle_reparse_directory:${label}`);
  }
}

export async function ensureDesktopLifecycleRoot({
  root = desktopProductRoot,
  stagingRoot = defaultDesktopLifecycleRoot,
} = {}) {
  const normalizedRoot = resolve(root);
  const normalizedStagingRoot = resolve(stagingRoot);
  assertInside(normalizedRoot, normalizedStagingRoot);
  if (comparable(normalizedStagingRoot) !== comparable(join(normalizedRoot, '.build-generations'))) {
    throw new Error('desktop_lifecycle_noncanonical_lock_root');
  }
  await assertPlainDirectory(normalizedRoot, 'product');
  try {
    await mkdir(normalizedStagingRoot, { recursive: false });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  await assertPlainDirectory(normalizedStagingRoot, 'lifecycle');
  return normalizedStagingRoot;
}

export async function acquireDesktopLifecycleLock({
  root = desktopProductRoot,
  stagingRoot = defaultDesktopLifecycleRoot,
  operation = 'unspecified',
  ownerId = null,
} = {}) {
  const lifecycleRoot = await ensureDesktopLifecycleRoot({ root, stagingRoot });
  const lockPath = join(lifecycleRoot, desktopLifecycleLockName);
  let handle;
  try {
    handle = await open(lockPath, 'wx');
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error('desktop_lifecycle_maintenance_required:lock_exists');
    }
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify({
      schemaVersion: 1,
      operation: String(operation),
      ownerId: ownerId === null ? null : String(ownerId),
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    })}\n`, 'utf8');
    const identity = await handle.stat();
    return { handle, identity, lockPath };
  } catch (error) {
    try {
      await handle.close();
    } catch {
      // The original acquisition failure remains the useful error.
    }
    throw error;
  }
}

export async function releaseDesktopLifecycleLock(lock) {
  await lock.handle.close();
  const observed = await lstat(lock.lockPath);
  if (
    !observed.isFile()
    || observed.isSymbolicLink()
    || observed.dev !== lock.identity.dev
    || observed.ino !== lock.identity.ino
  ) {
    throw new Error('desktop_lifecycle_lock_identity_changed');
  }
  await unlink(lock.lockPath);
}

export async function preserveDesktopLifecycleLock(lock) {
  await lock.handle.close();
  const observed = await lstat(lock.lockPath);
  if (
    !observed.isFile()
    || observed.isSymbolicLink()
    || observed.dev !== lock.identity.dev
    || observed.ino !== lock.identity.ino
  ) {
    throw new Error('desktop_lifecycle_lock_identity_changed');
  }
}

export async function withDesktopLifecycleLock(options, operation) {
  const lock = await acquireDesktopLifecycleLock(options);
  let result;
  let operationError;
  try {
    result = await operation();
  } catch (error) {
    operationError = error;
  }

  try {
    if (operationError?.desktopLifecyclePreserveLock === true) {
      await preserveDesktopLifecycleLock(lock);
    } else {
      await releaseDesktopLifecycleLock(lock);
    }
  } catch (releaseError) {
    if (!operationError) throw releaseError;
    operationError.lifecycleLockReleaseError = releaseError instanceof Error
      ? releaseError.message
      : String(releaseError);
  }

  if (operationError) throw operationError;
  return result;
}
