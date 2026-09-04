import { open, lstat, mkdir, readFile, realpath, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptRoot = dirname(fileURLToPath(import.meta.url));

export const desktopProductRoot = resolve(scriptRoot, '..');
export const defaultDesktopLifecycleRoot = join(desktopProductRoot, '.build-generations');
// Keep the historical path so an older or crashed coordinator cannot be
// silently bypassed during the lifecycle-lock cutover.
export const desktopLifecycleLockName = 'build.lock';
const invalidLockGraceMs = 60_000;

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
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      handle = await open(lockPath, 'wx');
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (await desktopLifecycleLockIsActive(lockPath)) {
        throw new Error('desktop_lifecycle_maintenance_required:lock_exists');
      }
      try {
        await unlink(lockPath);
      } catch (unlinkError) {
        if (unlinkError?.code !== 'ENOENT') throw unlinkError;
      }
    }
  }
  if (!handle) throw new Error('desktop_lifecycle_maintenance_required:lock_exists');
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

async function desktopLifecycleLockIsActive(lockPath) {
  const metadata = await lstat(lockPath);
  const canonical = await realpath(lockPath);
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || comparable(canonical) !== comparable(lockPath)
  ) {
    throw new Error('desktop_lifecycle_lock_is_not_plain_file');
  }

  let owner = null;
  try {
    owner = JSON.parse(await readFile(lockPath, 'utf8'));
  } catch {
    // A newly-created lock can briefly be empty while its owner writes the
    // metadata. Give that short window time instead of stealing a live lock.
  }
  if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) {
    try {
      process.kill(owner.pid, 0);
      return true;
    } catch (error) {
      if (error?.code === 'EPERM') return true;
      if (error?.code === 'ESRCH') return false;
      throw error;
    }
  }
  return Date.now() - metadata.mtimeMs < invalidLockGraceMs;
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
