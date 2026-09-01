"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const LOCK_NAME = ".orquesta-posix-store.lock";
const CLAIM_NAME_PATTERN = /^\.orquesta-posix-store-claim-[1-9][0-9]*-[a-f0-9]{48}\.json$/u;
const LOCK_RECORD_VERSION = 1;
const LOCK_RECORD_MAX_BYTES = 4096;
const REQUIRED_DIRECTORY_MODE = 0o700;
const REQUIRED_FILE_MODE = 0o600;
const SESSION_BRAND = Symbol("orquesta.posix-durable-store.session");
const FILE_BRAND = Symbol("orquesta.posix-durable-store.file");

function codedError(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = Object.freeze({ ...details });
  return error;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateIntegerOption(value, fallback, field, minimum, maximum) {
  const selected = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    throw codedError(
      "POSIX_DURABLE_STORE_CONFIGURATION_INVALID",
      `${field} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return selected;
}

function requireLinuxPrimitives() {
  if (process.platform !== "linux"
      || typeof process.getuid !== "function"
      || !Number.isInteger(fs.constants.O_NOFOLLOW)
      || fs.constants.O_NOFOLLOW === 0
      || !Number.isInteger(fs.constants.O_DIRECTORY)
      || fs.constants.O_DIRECTORY === 0) {
    throw codedError(
      "POSIX_DURABLE_STORE_UNSUPPORTED_PLATFORM",
      "The durable local store adapter supports Linux POSIX primitives only",
    );
  }
}

function validateRootPath(rootPath) {
  if (typeof rootPath !== "string"
      || rootPath === ""
      || rootPath.includes("\0")
      || rootPath !== path.resolve(rootPath)
      || path.normalize(rootPath) !== rootPath
      || rootPath === path.parse(rootPath).root) {
    throw codedError(
      "POSIX_DURABLE_STORE_CONFIGURATION_INVALID",
      "root_path must be one normalized absolute non-root path",
    );
  }
  return rootPath;
}

function numericMode(stat) {
  return stat.mode & 0o7777;
}

function sameInode(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function validateOwnedDirectoryStat(stat, uid, field) {
  if (!stat.isDirectory()
      || stat.isSymbolicLink()
      || stat.uid !== uid
      || numericMode(stat) !== REQUIRED_DIRECTORY_MODE) {
    throw codedError(
      "POSIX_DURABLE_STORE_UNSAFE_PATH",
      `${field} must be an owned 0700 real directory`,
      {
        actual_uid: stat.uid,
        expected_uid: uid,
        actual_mode: numericMode(stat),
      },
    );
  }
}

function validateOwnedFileStat(stat, uid, field, { allowMultipleLinks = false } = {}) {
  if (!stat.isFile()
      || stat.isSymbolicLink()
      || stat.uid !== uid
      || numericMode(stat) !== REQUIRED_FILE_MODE
      || (allowMultipleLinks
        ? (stat.nlink < 1 || stat.nlink > 2)
        : stat.nlink !== 1)) {
    throw codedError(
      "POSIX_DURABLE_STORE_UNSAFE_PATH",
      `${field} must be an owned 0600 single-link regular file`,
      {
        actual_uid: stat.uid,
        expected_uid: uid,
        actual_mode: numericMode(stat),
        actual_links: stat.nlink,
      },
    );
  }
}

function rootComponents(rootPath) {
  const parsed = path.parse(rootPath);
  const relative = rootPath.slice(parsed.root.length);
  const parts = relative.split(path.sep).filter(Boolean);
  const components = [parsed.root];
  let current = parsed.root;
  for (const part of parts) {
    current = path.join(current, part);
    components.push(current);
  }
  return components;
}

async function validateRootComponents(rootPath, uid) {
  const components = rootComponents(rootPath);
  let rootStat = null;
  for (let index = 0; index < components.length; index += 1) {
    const component = components[index];
    const stat = await fsp.lstat(component);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw codedError(
        "POSIX_DURABLE_STORE_UNSAFE_PATH",
        "Every root path component must be a real directory",
        { component },
      );
    }
    if (index === components.length - 1) {
      validateOwnedDirectoryStat(stat, uid, "root_path");
      rootStat = stat;
      continue;
    }

    // Ancestors need not be private (for example / or a deployment mount),
    // but they must be controlled by this uid or root. A root-owned sticky
    // directory such as /tmp is the only writable ancestor accepted.
    const mode = numericMode(stat);
    const controlledOwner = stat.uid === uid || stat.uid === 0;
    const writableByOthers = (mode & 0o022) !== 0;
    const protectedStickyRoot = stat.uid === 0 && (mode & 0o1000) !== 0;
    if (!controlledOwner || (writableByOthers && !protectedStickyRoot)) {
      throw codedError(
        "POSIX_DURABLE_STORE_UNSAFE_PATH",
        "A root path ancestor is replaceable by an untrusted principal",
        { component, actual_uid: stat.uid, actual_mode: mode },
      );
    }
  }

  const real = await fsp.realpath(rootPath);
  if (real !== rootPath) {
    throw codedError(
      "POSIX_DURABLE_STORE_UNSAFE_PATH",
      "root_path must equal its canonical real path",
      { root_path: rootPath, root_realpath: real },
    );
  }
  return rootStat;
}

function parseProcessIdentity(statText) {
  const close = statText.lastIndexOf(")");
  const open = statText.indexOf(" (");
  if (open < 1 || close < open) {
    throw codedError(
      "POSIX_DURABLE_STORE_PROCESS_IDENTITY_UNAVAILABLE",
      "Linux process identity record is malformed",
    );
  }
  const pidText = statText.slice(0, open);
  const remaining = statText.slice(close + 1).trim().split(/\s+/u);
  const startTicks = remaining[19];
  if (!/^[1-9][0-9]*$/u.test(pidText)
      || !/^[0-9]+$/u.test(startTicks || "")) {
    throw codedError(
      "POSIX_DURABLE_STORE_PROCESS_IDENTITY_UNAVAILABLE",
      "Linux process start identity is unavailable",
    );
  }
  return Object.freeze({ pid: Number(pidText), start_ticks: startTicks });
}

async function readPidNamespace(pidPath = "self") {
  let value;
  try {
    value = await fsp.readlink(`/proc/${pidPath}/ns/pid`);
  } catch (error) {
    if (error?.code === "ENOENT" && pidPath !== "self") return null;
    throw codedError(
      "POSIX_DURABLE_STORE_PROCESS_IDENTITY_UNAVAILABLE",
      "Linux PID namespace identity is unavailable",
      { cause_code: typeof error?.code === "string" ? error.code : null },
    );
  }
  if (!/^pid:\[[1-9][0-9]*\]$/u.test(value)) {
    throw codedError(
      "POSIX_DURABLE_STORE_PROCESS_IDENTITY_UNAVAILABLE",
      "Linux PID namespace identity is malformed",
    );
  }
  return value;
}

async function readBootId() {
  let value;
  try {
    value = (await fsp.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  } catch (error) {
    throw codedError(
      "POSIX_DURABLE_STORE_PROCESS_IDENTITY_UNAVAILABLE",
      "Linux boot identity is unavailable",
      { cause_code: typeof error?.code === "string" ? error.code : null },
    );
  }
  if (!/^[a-f0-9-]{16,64}$/iu.test(value)) {
    throw codedError(
      "POSIX_DURABLE_STORE_PROCESS_IDENTITY_UNAVAILABLE",
      "Linux boot identity is malformed",
    );
  }
  return value.toLowerCase();
}

async function readProcessStartTicks(pid) {
  try {
    const value = await fsp.readFile(`/proc/${pid}/stat`, "utf8");
    const identity = parseProcessIdentity(value);
    if (identity.pid !== pid) {
      throw codedError(
        "POSIX_DURABLE_STORE_PROCESS_IDENTITY_UNAVAILABLE",
        "Linux process identity changed while it was read",
      );
    }
    return identity.start_ticks;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error?.code?.startsWith?.("POSIX_DURABLE_STORE_")) throw error;
    throw codedError(
      "POSIX_DURABLE_STORE_PROCESS_IDENTITY_UNAVAILABLE",
      "Linux process identity could not be read safely",
      { pid, cause_code: typeof error?.code === "string" ? error.code : null },
    );
  }
}

async function currentProcessIdentity(uid) {
  let selfIdentity;
  const [bootId, selfStat, pidNamespace] = await Promise.all([
    readBootId(),
    fsp.readFile("/proc/self/stat", "utf8"),
    readPidNamespace(),
  ]);
  selfIdentity = parseProcessIdentity(selfStat);
  return Object.freeze({
    lock_record_version: LOCK_RECORD_VERSION,
    token: crypto.randomBytes(32).toString("hex"),
    // /proc may expose host PIDs while process.pid uses a nested namespace.
    // Recording the ID from /proc/self keeps later liveness checks in the
    // same observable namespace as /proc/<pid>/stat.
    pid: selfIdentity.pid,
    uid,
    boot_id: bootId,
    pid_namespace: pidNamespace,
    process_start_ticks: selfIdentity.start_ticks,
  });
}

function normalizeLockRecord(value, expectedUid) {
  const fields = new Set([
    "lock_record_version",
    "token",
    "pid",
    "uid",
    "boot_id",
    "pid_namespace",
    "process_start_ticks",
  ]);
  if (!isPlainObject(value)
      || Object.keys(value).length !== fields.size
      || Object.keys(value).some((field) => !fields.has(field))
      || value.lock_record_version !== LOCK_RECORD_VERSION
      || !/^[a-f0-9]{64}$/u.test(value.token || "")
      || !Number.isSafeInteger(value.pid)
      || value.pid <= 0
      || value.uid !== expectedUid
      || !/^[a-f0-9-]{16,64}$/u.test(value.boot_id || "")
      || !/^pid:\[[1-9][0-9]*\]$/u.test(value.pid_namespace || "")
      || !/^[0-9]+$/u.test(value.process_start_ticks || "")) {
    throw codedError(
      "POSIX_DURABLE_STORE_UNSAFE_PATH",
      "The cross-process lock record is malformed or belongs to another uid",
    );
  }
  return value;
}

function lockBytes(record) {
  return Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
}

async function isLockOwnerAlive(record, bootId) {
  if (record.boot_id !== bootId) return false;
  const [currentStartTicks, currentPidNamespace] = await Promise.all([
    readProcessStartTicks(record.pid),
    readPidNamespace(String(record.pid)),
  ]);
  return currentStartTicks !== null
    && currentPidNamespace === record.pid_namespace
    && currentStartTicks === record.process_start_ticks;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function createPosixDurableStoreCore({
  target_name_validator: targetNameValidator,
  unsafe_error_code: unsafeErrorCode,
  lock_timeout_ms: inputLockTimeoutMs,
  lock_poll_interval_ms: inputLockPollIntervalMs,
  fault_injector: faultInjector,
} = {}) {
  requireLinuxPrimitives();
  if (typeof targetNameValidator !== "function") {
    throw codedError(
      "POSIX_DURABLE_STORE_CONFIGURATION_INVALID",
      "target_name_validator must be a function",
    );
  }
  if (typeof unsafeErrorCode !== "string" || unsafeErrorCode === "") {
    throw codedError(
      "POSIX_DURABLE_STORE_CONFIGURATION_INVALID",
      "unsafe_error_code must be a non-empty string",
    );
  }
  if (faultInjector !== undefined && typeof faultInjector !== "function") {
    throw codedError(
      "POSIX_DURABLE_STORE_CONFIGURATION_INVALID",
      "fault_injector must be a function when supplied",
    );
  }

  const lockTimeoutMs = validateIntegerOption(
    inputLockTimeoutMs,
    30_000,
    "lock_timeout_ms",
    1,
    300_000,
  );
  const lockPollIntervalMs = validateIntegerOption(
    inputLockPollIntervalMs,
    20,
    "lock_poll_interval_ms",
    1,
    1_000,
  );
  if (lockPollIntervalMs > lockTimeoutMs) {
    throw codedError(
      "POSIX_DURABLE_STORE_CONFIGURATION_INVALID",
      "lock_poll_interval_ms cannot exceed lock_timeout_ms",
    );
  }

  async function maybeFault(operation) {
    if (faultInjector !== undefined) await faultInjector(Object.freeze({ operation }));
  }

  function unsafe(message, details) {
    return codedError(unsafeErrorCode, message, details);
  }

  function mapCoreUnsafe(error) {
    if (error?.code === "POSIX_DURABLE_STORE_UNSAFE_PATH") {
      return unsafe(error.message, error.details);
    }
    return error;
  }

  function targetName(name) {
    if (typeof name !== "string"
        || name === ""
        || name.includes("\0")
        || name !== path.basename(name)
        || !targetNameValidator(name)) {
      throw unsafe("Durable store target name is not content-addressed", { name });
    }
    return name;
  }

  function tempTarget(name) {
    if (typeof name !== "string"
        || name === ""
        || name !== path.basename(name)) {
      throw unsafe("Durable store temporary name is unsafe", { name });
    }
    const match = /^\.(.+)\.([a-f0-9]{48})\.tmp$/u.exec(name);
    if (!match || !targetNameValidator(match[1])) {
      throw unsafe("Durable store temporary name is not target-derived", { name });
    }
    return Object.freeze({ name, target_name: match[1] });
  }

  function pinnedPath(directoryHandle, name = "") {
    const base = `/proc/self/fd/${directoryHandle.fd}`;
    return name === "" ? base : `${base}/${name}`;
  }

  async function nativeReadOwnedFile(directoryHandle, name, uid, maxBytes, options = {}) {
    const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;
    const fileHandle = await fsp.open(pinnedPath(directoryHandle, name), flags);
    try {
      const before = await fileHandle.stat();
      validateOwnedFileStat(before, uid, name, options);
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || before.size > maxBytes) {
        const error = codedError("EFBIG", "Durable store file exceeds its read ceiling");
        throw error;
      }
      const bytes = await fileHandle.readFile();
      const after = await fileHandle.stat();
      validateOwnedFileStat(after, uid, name, options);
      if (!sameInode(before, after) || bytes.length > maxBytes || bytes.length !== after.size) {
        throw unsafe("Durable store file changed while it was read", { name });
      }
      return Object.freeze({ bytes, stat: after });
    } finally {
      await fileHandle.close();
    }
  }

  async function nativeUnlinkChecked(
    directoryHandle,
    name,
    uid,
    expectedStat = null,
    options = {},
  ) {
    const target = pinnedPath(directoryHandle, name);
    const stat = await fsp.lstat(target);
    validateOwnedFileStat(stat, uid, name, options);
    if (expectedStat !== null && !sameInode(stat, expectedStat)) {
      throw unsafe("Durable store entry changed before unlink", { name });
    }
    await fsp.unlink(target);
  }

  async function discardExclusivelyCreatedEntry(directoryHandle, name, expectedStat) {
    try {
      const current = await fsp.lstat(pinnedPath(directoryHandle, name));
      if (expectedStat !== null && !sameInode(current, expectedStat)) {
        throw unsafe("Exclusively created entry changed before cleanup", { name });
      }
      await fsp.unlink(pinnedPath(directoryHandle, name));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  async function syncDirectory(directoryHandle, operation) {
    await maybeFault(operation);
    await directoryHandle.sync();
  }

  async function readLock(directoryHandle, uid) {
    const result = await nativeReadOwnedFile(
      directoryHandle,
      LOCK_NAME,
      uid,
      LOCK_RECORD_MAX_BYTES,
      { allowMultipleLinks: true },
    );
    let parsed;
    try {
      parsed = JSON.parse(result.bytes.toString("utf8"));
    } catch {
      throw unsafe("The cross-process lock record is not valid JSON");
    }
    try {
      return Object.freeze({
        record: normalizeLockRecord(parsed, uid),
        stat: result.stat,
      });
    } catch (error) {
      throw mapCoreUnsafe(error);
    }
  }

  async function discardOwnClaim(directoryHandle, claimName, uid) {
    try {
      await nativeUnlinkChecked(
        directoryHandle,
        claimName,
        uid,
        null,
        { allowMultipleLinks: true },
      );
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  async function createClaimFile(directoryHandle, claimName, record, uid) {
    const flags = fs.constants.O_CREAT
      | fs.constants.O_EXCL
      | fs.constants.O_WRONLY
      | fs.constants.O_NOFOLLOW;
    const fileHandle = await fsp.open(
      pinnedPath(directoryHandle, claimName),
      flags,
      REQUIRED_FILE_MODE,
    );
    let createdStat = null;
    try {
      const stat = await fileHandle.stat();
      createdStat = stat;
      try {
        validateOwnedFileStat(stat, uid, claimName);
      } catch (error) {
        throw mapCoreUnsafe(error);
      }
      const bytes = lockBytes(record);
      await fileHandle.writeFile(bytes);
      const written = await fileHandle.stat();
      if (written.size !== bytes.length || !sameInode(stat, written)) {
        throw unsafe("The cross-process claim was not written completely");
      }
      await maybeFault("lock_file_fsync");
      await fileHandle.sync();
    } catch (error) {
      try {
        await discardExclusivelyCreatedEntry(
          directoryHandle,
          claimName,
          createdStat,
        );
      } catch {
        // Preserve the primary failure. The claim is never the fixed lock and
        // is removed by the next exclusive owner's stale-claim pass.
      }
      throw error;
    } finally {
      await fileHandle.close();
    }
  }

  async function removeStaleLock(directoryHandle, uid, observed) {
    try {
      await nativeUnlinkChecked(
        directoryHandle,
        LOCK_NAME,
        uid,
        observed.stat,
        { allowMultipleLinks: true },
      );
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    await syncDirectory(directoryHandle, "stale_lock_directory_fsync");
  }

  async function acquireLock(directoryHandle, uid) {
    const identity = await currentProcessIdentity(uid);
    const startedAt = process.hrtime.bigint();
    const timeoutNanoseconds = BigInt(lockTimeoutMs) * 1_000_000n;
    while (true) {
      const claimName = `.orquesta-posix-store-claim-${identity.pid}-${crypto.randomBytes(24).toString("hex")}.json`;
      await createClaimFile(directoryHandle, claimName, identity, uid);
      let acquired = false;
      try {
        try {
          await fsp.link(
            pinnedPath(directoryHandle, claimName),
            pinnedPath(directoryHandle, LOCK_NAME),
          );
          acquired = true;
        } catch (error) {
          if (error?.code !== "EEXIST") throw error;
        }

        if (acquired) {
          // Persist the new lock before removing the unique claim name. Both
          // names address the same fsynced inode; link() is the no-replace CAS.
          await syncDirectory(directoryHandle, "lock_acquire_directory_fsync");
          await discardOwnClaim(directoryHandle, claimName, uid);
          await syncDirectory(directoryHandle, "lock_claim_cleanup_directory_fsync");
          const owned = await readLock(directoryHandle, uid);
          if (owned.record.token !== identity.token) {
            throw unsafe("The acquired cross-process lock changed identity");
          }
          return identity;
        }
      } catch (error) {
        if (acquired) {
          try {
            const observed = await readLock(directoryHandle, uid);
            if (observed.record.token === identity.token) {
              await nativeUnlinkChecked(
                directoryHandle,
                LOCK_NAME,
                uid,
                observed.stat,
                { allowMultipleLinks: true },
              );
              await syncDirectory(directoryHandle, "failed_lock_cleanup_directory_fsync");
            }
          } catch {
            // The PID/start-time-bound record remains safely recoverable if
            // cleanup itself is interrupted.
          }
        }
        try {
          await discardOwnClaim(directoryHandle, claimName, uid);
        } catch {
          // A failed lock acquisition remains fail-closed. A future exclusive
          // owner can remove the target-derived stale claim.
        }
        throw error;
      }

      await discardOwnClaim(directoryHandle, claimName, uid);
      let observed;
      try {
        observed = await readLock(directoryHandle, uid);
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
      // A PID number and start tick are meaningful only inside the namespace
      // that produced them. A foreign namespace must never be interpreted as
      // a dead owner and automatically unlinked. Such a root requires explicit
      // operator recovery from the namespace that owns the lock.
      if (observed.record.boot_id === identity.boot_id
          && observed.record.pid_namespace !== identity.pid_namespace) {
        throw codedError(
          "POSIX_DURABLE_STORE_PID_NAMESPACE_MISMATCH",
          "Refusing to recover a durable store lock from another PID namespace",
          {
            expected_pid_namespace: identity.pid_namespace,
            observed_pid_namespace: observed.record.pid_namespace,
          },
        );
      }
      const alive = await isLockOwnerAlive(observed.record, identity.boot_id);
      if (!alive) {
        await removeStaleLock(directoryHandle, uid, observed);
        continue;
      }
      const elapsedNanoseconds = process.hrtime.bigint() - startedAt;
      if (elapsedNanoseconds >= timeoutNanoseconds) {
        throw codedError(
          "POSIX_DURABLE_STORE_LOCK_TIMEOUT",
          "Timed out waiting for the exclusive durable store session",
          { owner_pid: observed.record.pid },
        );
      }
      const remainingMilliseconds = Number(
        (timeoutNanoseconds - elapsedNanoseconds) / 1_000_000n,
      );
      await delay(Math.min(lockPollIntervalMs, Math.max(1, remainingMilliseconds)));
    }
  }

  async function verifyOwnedLock(session) {
    const observed = await readLock(session.directory_handle, session.uid);
    if (observed.record.token !== session.lock.token) {
      throw unsafe("The durable store session no longer owns its process lock");
    }
  }

  async function releaseOwnedLock(session) {
    const observed = await readLock(session.directory_handle, session.uid);
    if (observed.record.token !== session.lock.token) {
      throw unsafe("Refusing to release a cross-process lock owned by another session");
    }
    await nativeUnlinkChecked(
      session.directory_handle,
      LOCK_NAME,
      session.uid,
      observed.stat,
      { allowMultipleLinks: true },
    );
    await syncDirectory(session.directory_handle, "lock_release_directory_fsync");
  }

  async function validatePinnedRoot(session) {
    if (!session
        || session[SESSION_BRAND] !== true
        || session.closed === true
        || !session.directory_handle
        || session.lock === null) {
      throw codedError("EBADF", "Durable store session is closed or foreign");
    }
    const stat = await session.directory_handle.stat();
    try {
      validateOwnedDirectoryStat(stat, session.uid, "pinned root");
    } catch (error) {
      throw mapCoreUnsafe(error);
    }
    if (!sameInode(stat, session.root_stat)) {
      throw unsafe("Pinned root directory identity changed");
    }
    await verifyOwnedLock(session);
    return session;
  }

  function validateFileHandle(handle) {
    if (!handle
        || handle[FILE_BRAND] !== true
        || handle.closed === true
        || !handle.native_handle) {
      throw codedError("EBADF", "Durable store file handle is closed or foreign");
    }
    return handle;
  }

  async function verifyStoreEntries(session) {
    const names = await fsp.readdir(pinnedPath(session.directory_handle));
    let removedClaim = false;
    for (const name of names) {
      const target = pinnedPath(session.directory_handle, name);
      const stat = await fsp.lstat(target);
      try {
        validateOwnedFileStat(
          stat,
          session.uid,
          name,
          { allowMultipleLinks: name !== LOCK_NAME },
        );
      } catch (error) {
        throw mapCoreUnsafe(error);
      }
      if (name === LOCK_NAME || targetNameValidator(name)) continue;
      if (CLAIM_NAME_PATTERN.test(name)) {
        await fsp.unlink(target);
        removedClaim = true;
        continue;
      }
      try {
        tempTarget(name);
      } catch {
        throw unsafe("Durable store contains an unrecognized entry", { name });
      }
    }
    if (removedClaim) {
      await syncDirectory(session.directory_handle, "stale_claim_directory_fsync");
    }
  }

  async function openStore({ root_path: rootPath } = {}) {
    requireLinuxPrimitives();
    const normalizedRoot = validateRootPath(rootPath);
    const uid = process.getuid();
    let baseline;
    try {
      baseline = await validateRootComponents(normalizedRoot, uid);
    } catch (error) {
      throw mapCoreUnsafe(error);
    }

    const flags = fs.constants.O_RDONLY
      | fs.constants.O_DIRECTORY
      | fs.constants.O_NOFOLLOW;
    const directoryHandle = await fsp.open(normalizedRoot, flags);
    let session = null;
    let lock = null;
    try {
      const pinnedStat = await directoryHandle.stat();
      try {
        validateOwnedDirectoryStat(pinnedStat, uid, "pinned root");
      } catch (error) {
        throw mapCoreUnsafe(error);
      }
      if (!sameInode(baseline, pinnedStat)) {
        throw unsafe("root_path changed while its directory handle was pinned");
      }
      const pinnedRealpath = await fsp.realpath(pinnedPath(directoryHandle));
      if (pinnedRealpath !== normalizedRoot) {
        throw unsafe("Pinned root directory does not match root_path", {
          root_path: normalizedRoot,
          pinned_realpath: pinnedRealpath,
        });
      }
      let finalRoot;
      try {
        finalRoot = await validateRootComponents(normalizedRoot, uid);
      } catch (error) {
        throw mapCoreUnsafe(error);
      }
      if (!sameInode(finalRoot, pinnedStat)) {
        throw unsafe("root_path changed during component verification");
      }

      lock = await acquireLock(directoryHandle, uid);
      session = {
        [SESSION_BRAND]: true,
        root_path: normalizedRoot,
        root_realpath: normalizedRoot,
        root_stat: pinnedStat,
        uid,
        directory_handle: directoryHandle,
        lock,
        closed: false,
      };
      await verifyStoreEntries(session);
      return session;
    } catch (error) {
      if (session !== null && lock !== null) {
        try {
          await releaseOwnedLock(session);
        } catch {
          // Preserve the primary failure. The PID-bound lock is recoverable.
        }
      }
      try {
        await directoryHandle.close();
      } catch {
        // Preserve the primary failure.
      }
      throw error;
    }
  }

  async function recoverInterruptedWrites({
    store_handle: inputSession,
    target_name: inputTargetName,
    temp_prefix: tempPrefix,
  } = {}) {
    const session = await validatePinnedRoot(inputSession);
    const selectedTarget = targetName(inputTargetName);
    if (tempPrefix !== `.${selectedTarget}.`) {
      throw unsafe("Recovery prefix does not bind the exact content-addressed target");
    }
    const names = await fsp.readdir(pinnedPath(session.directory_handle));
    for (const name of names) {
      if (!name.startsWith(tempPrefix)) continue;
      const parsed = tempTarget(name);
      if (parsed.target_name !== selectedTarget) {
        throw unsafe("Recovery candidate does not bind the exact target", { name });
      }
      await nativeUnlinkChecked(
        session.directory_handle,
        name,
        session.uid,
        null,
        { allowMultipleLinks: true },
      );
    }
    await syncDirectory(session.directory_handle, "recovery_directory_fsync");
    return Object.freeze({
      recovery_version: 1,
      root_realpath: session.root_realpath,
      exclusive_recovery: true,
      session_lock_held: true,
      stale_temps_handled: true,
      directory_fsynced: true,
    });
  }

  async function readFileNoFollow({
    store_handle: inputSession,
    name: inputName,
    max_bytes: maxBytes,
  } = {}) {
    const session = await validatePinnedRoot(inputSession);
    const name = targetName(inputName);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw codedError("EINVAL", "max_bytes must be a positive safe integer");
    }
    const result = await nativeReadOwnedFile(
      session.directory_handle,
      name,
      session.uid,
      maxBytes,
    );
    return result.bytes;
  }

  async function openTempExclusive({
    store_handle: inputSession,
    name: inputName,
    mode,
  } = {}) {
    const session = await validatePinnedRoot(inputSession);
    const parsed = tempTarget(inputName);
    if (mode !== REQUIRED_FILE_MODE) {
      throw unsafe("Temporary files must be requested with mode 0600");
    }
    const flags = fs.constants.O_CREAT
      | fs.constants.O_EXCL
      | fs.constants.O_WRONLY
      | fs.constants.O_NOFOLLOW;
    const nativeHandle = await fsp.open(
      pinnedPath(session.directory_handle, parsed.name),
      flags,
      REQUIRED_FILE_MODE,
    );
    let createdStat = null;
    try {
      const stat = await nativeHandle.stat();
      createdStat = stat;
      try {
        validateOwnedFileStat(stat, session.uid, parsed.name);
      } catch (error) {
        throw mapCoreUnsafe(error);
      }
    } catch (error) {
      try {
        await nativeHandle.close();
      } finally {
        try {
          await discardExclusivelyCreatedEntry(
            session.directory_handle,
            parsed.name,
            createdStat,
          );
        } catch {
          // The exclusive session recovery pass owns uncertain cleanup.
        }
      }
      throw error;
    }
    return {
      [FILE_BRAND]: true,
      native_handle: nativeHandle,
      session,
      name: parsed.name,
      target_name: parsed.target_name,
      closed: false,
    };
  }

  async function writeAll({ file_handle: inputFileHandle, bytes } = {}) {
    const fileHandle = validateFileHandle(inputFileHandle);
    await validatePinnedRoot(fileHandle.session);
    if (!Buffer.isBuffer(bytes)) {
      throw codedError("EINVAL", "Durable store writes require Buffer bytes");
    }
    const before = await fileHandle.native_handle.stat();
    try {
      validateOwnedFileStat(before, fileHandle.session.uid, fileHandle.name);
    } catch (error) {
      throw mapCoreUnsafe(error);
    }
    if (before.size !== 0) {
      throw unsafe("Exclusive temporary file was already written", { name: fileHandle.name });
    }
    await fileHandle.native_handle.writeFile(bytes);
    const after = await fileHandle.native_handle.stat();
    if (!sameInode(before, after) || after.size !== bytes.length) {
      throw codedError("EIO", "Durable store could not prove a complete write");
    }
  }

  async function fsyncFile({ file_handle: inputFileHandle } = {}) {
    const fileHandle = validateFileHandle(inputFileHandle);
    await validatePinnedRoot(fileHandle.session);
    const stat = await fileHandle.native_handle.stat();
    try {
      validateOwnedFileStat(stat, fileHandle.session.uid, fileHandle.name);
    } catch (error) {
      throw mapCoreUnsafe(error);
    }
    await maybeFault("file_fsync");
    await fileHandle.native_handle.sync();
  }

  async function closeFile({ file_handle: inputFileHandle } = {}) {
    const fileHandle = validateFileHandle(inputFileHandle);
    fileHandle.closed = true;
    await fileHandle.native_handle.close();
  }

  async function renameTempNoReplace({
    store_handle: inputSession,
    from_name: inputFromName,
    to_name: inputToName,
  } = {}) {
    const session = await validatePinnedRoot(inputSession);
    const from = tempTarget(inputFromName);
    const to = targetName(inputToName);
    if (from.target_name !== to) {
      throw unsafe("Temporary publication does not bind its target");
    }
    const sourcePath = pinnedPath(session.directory_handle, from.name);
    const targetPath = pinnedPath(session.directory_handle, to);
    const sourceStat = await fsp.lstat(sourcePath);
    try {
      validateOwnedFileStat(sourceStat, session.uid, from.name);
    } catch (error) {
      throw mapCoreUnsafe(error);
    }
    await fsp.link(sourcePath, targetPath);
    const publishedStat = await fsp.lstat(targetPath);
    try {
      validateOwnedFileStat(publishedStat, session.uid, to, { allowMultipleLinks: true });
    } catch (error) {
      throw mapCoreUnsafe(error);
    }
    if (!sameInode(sourceStat, publishedStat) || publishedStat.nlink !== 2) {
      throw unsafe("Atomic no-replace publication did not preserve inode identity");
    }
    await fsp.unlink(sourcePath);
    const finalStat = await fsp.lstat(targetPath);
    try {
      validateOwnedFileStat(finalStat, session.uid, to);
    } catch (error) {
      throw mapCoreUnsafe(error);
    }
    if (!sameInode(sourceStat, finalStat)) {
      throw unsafe("Published target changed after atomic link publication");
    }
  }

  async function unlinkTempNoFollow({
    store_handle: inputSession,
    name: inputName,
  } = {}) {
    const session = await validatePinnedRoot(inputSession);
    const parsed = tempTarget(inputName);
    await nativeUnlinkChecked(
      session.directory_handle,
      parsed.name,
      session.uid,
      null,
      { allowMultipleLinks: true },
    );
  }

  async function fsyncDirectory({ store_handle: inputSession } = {}) {
    const session = await validatePinnedRoot(inputSession);
    await syncDirectory(session.directory_handle, "directory_fsync");
  }

  async function closeStore({ store_handle: inputSession } = {}) {
    if (!inputSession || inputSession[SESSION_BRAND] !== true || inputSession.closed === true) return;
    const session = inputSession;
    let primary = null;
    try {
      await validatePinnedRoot(session);
      await releaseOwnedLock(session);
      session.lock = null;
    } catch (error) {
      primary = error;
    }
    session.closed = true;
    try {
      await session.directory_handle.close();
    } catch (error) {
      if (primary === null) primary = error;
    }
    if (primary !== null) throw primary;
  }

  return Object.freeze({
    openStore,
    recoverInterruptedWrites,
    readFileNoFollow,
    openTempExclusive,
    writeAll,
    fsyncFile,
    closeFile,
    renameTempNoReplace,
    unlinkTempNoFollow,
    fsyncDirectory,
    closeStore,
  });
}

module.exports = Object.freeze({
  createPosixDurableStoreCore,
});
