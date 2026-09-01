const fs = require("fs");
const path = require("path");
const { randomUUID } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");

const TRANSIENT_RENAME_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const DEFAULT_LOCK_TIMEOUT_MS = 10000;
const DEFAULT_LOCK_RETRY_DELAY_MS = 10;
const DEFAULT_STALE_LOCK_MS = 30000;
const DEFAULT_RENAME_RETRIES = 8;
const DEFAULT_RENAME_RETRY_DELAY_MS = 8;
const DEFAULT_RENAME_RETRY_MAX_DELAY_MS = 100;
const BOUND_PARENT = Symbol("bound-parent-directory");

function bindingError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.blocker = true;
  return error;
}

function samePath(left, right) {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function assertBoundParent(options) {
  const binding = options[BOUND_PARENT];
  if (!binding) return;
  const current = fs.statSync(".", { bigint: true });
  if (current.dev !== binding.identity.dev || current.ino !== binding.identity.ino) {
    throw bindingError("JSON_STATE_PARENT_BINDING_LOST", "JSON state parent directory binding changed");
  }
}

function synchronousResult(value, options = {}) {
  if (value !== null && (typeof value === "object" || typeof value === "function")
      && typeof value.then === "function") {
    throw bindingError("JSON_STATE_ASYNC_UNSUPPORTED", "JSON state writers require synchronous values and callbacks");
  }
  assertBoundParent(options);
  return value;
}

function reportedPath(filePath, options) {
  return options[BOUND_PARENT] ? path.resolve(options[BOUND_PARENT].parent, filePath) : filePath;
}

function reportBoundEvidence(value, parent) {
  if (!value || typeof value !== "object") return value;
  // Only the helper's transport envelope is rewritten, never caller JSON data.
  for (const key of ["path", "dest", "backupPath", "tempPath", "lockPath", "artifactPath", "target_path"]) {
    if (typeof value[key] === "string") value[key] = path.resolve(parent, value[key]);
  }
  for (const key of ["lock", "owner", "observedOwner", "restoreError", "recoveredLock", "acquisitionFailure", "transitionFailure"]) {
    reportBoundEvidence(value[key], parent);
  }
  if (Array.isArray(value.cleanupFailures)) value.cleanupFailures.forEach((item) => reportBoundEvidence(item, parent));
  return value;
}

function withParentDirectory(filePath, options, operation) {
  if (!options.bindParentDirectory) return operation(filePath, options);
  // Opt-in for synchronous CLI transactions only: chdir is process-global. Do not
  // combine this with worker threads or already-running asynchronous relative I/O.
  // Callbacks must stay synchronous and must not change the working directory.
  const absolute = path.resolve(filePath);
  const parent = path.dirname(absolute);
  const identity = fs.lstatSync(parent, { bigint: true });
  if (!identity.isDirectory() || identity.isSymbolicLink() || !samePath(parent, fs.realpathSync(parent))) {
    throw bindingError("JSON_STATE_PARENT_UNSAFE", "JSON state parent must be one canonical real directory");
  }
  const boundOptions = { ...options, [BOUND_PARENT]: { parent, identity } };
  if (options.backupPath !== undefined) {
    const backup = path.resolve(options.backupPath);
    if (!samePath(path.dirname(backup), parent) || samePath(backup, absolute)) {
      throw bindingError("JSON_STATE_BACKUP_UNSAFE", "JSON state backup must be a different file in the target parent directory");
    }
    boundOptions.backupPath = path.basename(backup);
  }
  const originalCwd = process.cwd();
  let result;
  let operationError;
  try {
    process.chdir(parent);
    assertBoundParent(boundOptions);
    result = reportBoundEvidence(operation(path.basename(absolute), boundOptions), parent);
  } catch (error) {
    operationError = reportBoundEvidence(error, parent);
  }
  try {
    process.chdir(originalCwd);
  } catch (cause) {
    const error = bindingError("JSON_STATE_CWD_RESTORE_FAILED", `Cannot restore working directory: ${originalCwd}`);
    error.cause = cause;
    error.operationError = operationError;
    error.result = result;
    throw error;
  }
  if (operationError) throw operationError;
  return result;
}

function readJsonFile(filePath, defaultValue) {
  if (!fs.existsSync(filePath)) return defaultValue;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function createTempPath(filePath) {
  return `${filePath}.tmp-${process.pid}-${randomUUID()}`;
}

function sleepSync(milliseconds) {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function numericOption(options, name, fallback) {
  const value = Number(options?.[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function retryDelay(options, retryIndex) {
  const initial = numericOption(options, "renameRetryDelayMs", DEFAULT_RENAME_RETRY_DELAY_MS);
  const maximum = numericOption(options, "renameRetryMaxDelayMs", DEFAULT_RENAME_RETRY_MAX_DELAY_MS);
  return Math.min(maximum, initial * (2 ** Math.max(0, retryIndex - 1)));
}

function renameWithRetry(sourcePath, targetPath, options = {}) {
  const retries = numericOption(options, "renameRetries", DEFAULT_RENAME_RETRIES);
  let attempts = 0;

  while (true) {
    attempts += 1;
    try {
      fs.renameSync(sourcePath, targetPath);
      return attempts;
    } catch (error) {
      error.renameAttempts = attempts;
      if (!TRANSIENT_RENAME_CODES.has(error.code) || attempts > retries) throw error;
      sleepSync(retryDelay(options, attempts));
    }
  }
}

function removeWithRetry(filePath, options = {}) {
  const retries = numericOption(options, "renameRetries", DEFAULT_RENAME_RETRIES);
  let attempts = 0;
  while (fs.existsSync(filePath)) {
    attempts += 1;
    try {
      // Atomic-state artifacts are single files. unlink avoids the OneDrive fs.rmSync native-exit path.
      fs.unlinkSync(filePath);
      return attempts;
    } catch (error) {
      if (error.code === "ENOENT") return attempts;
      if (!TRANSIENT_RENAME_CODES.has(error.code) || attempts > retries) throw error;
      sleepSync(retryDelay(options, attempts));
    }
  }
  return attempts;
}

function cleanupTemp(tempPath, options = {}, identity) {
  if (!tempPath) return null;
  try {
    if (identity) assertOwnedTemp({ path: tempPath, identity });
    removeWithRetry(tempPath, options);
    return null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    return {
      path: tempPath,
      code: error.code || null,
      message: error.message
    };
  }
}

function artifactFailure(phase, artifactPath, error) {
  return {
    phase,
    path: artifactPath,
    code: error.code || null,
    message: error.message
  };
}

function attachCleanupFailure(error, phase, artifactPath, cleanupError) {
  error.cleanupFailures = [
    ...(error.cleanupFailures || []),
    artifactFailure(phase, artifactPath, cleanupError)
  ];
}

function markLockBlocker(error, lockPath, field, phase, artifactPath = lockPath) {
  error.blocker = true;
  error.lockPath = lockPath;
  error[field] = artifactFailure(phase, artifactPath, error);
  return error;
}

function lockPathFor(filePath) {
  return `${filePath}.lock`;
}

function transitionPathFor(lockPath) {
  return `${lockPath}.transition`;
}

function newOwnerToken() {
  return `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function readLockState(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const stat = fs.statSync(lockPath);
    try {
      return { exists: true, metadata: JSON.parse(raw), raw, stat, error: null };
    } catch (error) {
      return { exists: true, metadata: null, raw, stat, error };
    }
  } catch (error) {
    if (error.code === "ENOENT") return { exists: false, metadata: null, raw: null, stat: null, error: null };
    if (TRANSIENT_RENAME_CODES.has(error.code)) {
      return { exists: true, metadata: null, raw: null, stat: null, error };
    }
    throw error;
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function lockAgeMs(lockState, now = Date.now()) {
  const acquiredAt = Date.parse(lockState.metadata?.acquired_at || "");
  const timestamp = Number.isFinite(acquiredAt) ? acquiredAt : lockState.stat?.mtimeMs;
  return Number.isFinite(timestamp) ? Math.max(0, now - timestamp) : 0;
}

function lockCanBeRecovered(lockState, staleLockMs) {
  if (!lockState.exists || lockAgeMs(lockState) < staleLockMs) return false;
  return !processIsAlive(Number(lockState.metadata?.pid));
}

function createLockTimeoutError(filePath, lockPath, options, startedAt, owner) {
  const timeoutMs = numericOption(options, "lockTimeoutMs", DEFAULT_LOCK_TIMEOUT_MS);
  const error = new Error(`Timed out waiting for JSON state lock: ${filePath}`);
  error.code = "JSON_STATE_LOCK_TIMEOUT";
  error.blocker = true;
  error.path = filePath;
  error.lockPath = lockPath;
  error.timeoutMs = timeoutMs;
  error.waitedMs = Date.now() - startedAt;
  error.owner = owner || null;
  return error;
}

function createStaleLockError(filePath, lockPath, owner, ageMs, kind = "target_lock") {
  const error = new Error(`Stale JSON state lock requires manual recovery: ${filePath}`);
  error.code = "JSON_STATE_STALE_LOCK";
  error.blocker = true;
  error.path = filePath;
  error.lockPath = lockPath;
  error.owner = owner || null;
  error.ageMs = ageMs;
  error.kind = kind;
  return error;
}

function acquireTargetLock(filePath, options = {}) {
  const directory = path.dirname(filePath);
  const lockPath = lockPathFor(filePath);
  const ownerToken = newOwnerToken();
  const startedAt = Date.now();
  const timeoutMs = numericOption(options, "lockTimeoutMs", DEFAULT_LOCK_TIMEOUT_MS);
  const retryDelayMs = numericOption(options, "lockRetryDelayMs", DEFAULT_LOCK_RETRY_DELAY_MS);
  const staleLockMs = numericOption(options, "staleLockMs", DEFAULT_STALE_LOCK_MS);
  let waitAttempts = 0;

  fs.mkdirSync(directory, { recursive: true });

  while (true) {
    const transitionPath = transitionPathFor(lockPath);
    const transition = readLockState(transitionPath);
    if (transition.exists) {
      const transitionAge = lockAgeMs(transition);
      if (transitionAge >= staleLockMs) {
        throw createStaleLockError(filePath, transitionPath, transition.metadata, transitionAge, "release_transition");
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw createLockTimeoutError(filePath, transitionPath, options, startedAt, transition.metadata);
      }
      waitAttempts += 1;
      sleepSync(retryDelayMs);
      continue;
    }

    const acquiredAt = new Date().toISOString();
    const metadata = {
      version: 1,
      pid: process.pid,
      owner_token: ownerToken,
      target_path: reportedPath(filePath, options),
      acquired_at: acquiredAt
    };

    try {
      publishFileExclusive(lockPath, `${JSON.stringify(metadata)}\n`, options);
      return {
        path: lockPath,
        ownerToken,
        acquiredAt,
        recovered: false,
        recoveredLock: null,
        waitAttempts,
        waitedMs: Date.now() - startedAt
      };
    } catch (error) {
      if (error.published || error.cleanupFailures?.length) {
        markLockBlocker(error, lockPath, "acquisitionFailure", "metadata_initialization");
        error.path = filePath;
        throw error;
      }
      const lockContention = error.code === "EEXIST" || TRANSIENT_RENAME_CODES.has(error.code);
      if (!lockContention) {
        throw error;
      }
    }

    const observed = readLockState(lockPath);
    if (lockCanBeRecovered(observed, staleLockMs)) {
      throw createStaleLockError(filePath, lockPath, observed.metadata, lockAgeMs(observed));
    }

    if (Date.now() - startedAt >= timeoutMs) {
      throw createLockTimeoutError(filePath, lockPath, options, startedAt, observed.metadata);
    }
    waitAttempts += 1;
    sleepSync(retryDelayMs);
  }
}

function releaseTargetLock(lock, options = {}) {
  const observed = readLockState(lock.path);
  if (!observed.exists) return false;
  if (observed.metadata?.owner_token !== lock.ownerToken) {
    const error = new Error(`JSON state lock ownership was lost: ${lock.path}`);
    error.code = "JSON_STATE_LOCK_OWNERSHIP_LOST";
    error.blocker = true;
    error.lockPath = lock.path;
    error.expectedOwnerToken = lock.ownerToken;
    error.observedOwner = observed.metadata;
    throw error;
  }

  const transitionPath = transitionPathFor(lock.path);
  const releasePath = `${lock.path}.release-${lock.ownerToken}`;
  const transitionMetadata = {
    version: 1,
    pid: process.pid,
    owner_token: lock.ownerToken,
    target_path: reportedPath(lock.path, options),
    acquired_at: new Date().toISOString()
  };
  try {
    publishFileExclusive(transitionPath, `${JSON.stringify(transitionMetadata)}\n`, options);
  } catch (error) {
    markLockBlocker(error, lock.path, "transitionFailure", "metadata_initialization", transitionPath);
    throw error;
  }

  let releaseError = null;
  let released = false;
  try {
    renameWithRetry(lock.path, releasePath, options);
    const moved = readLockState(releasePath);
    if (moved.metadata?.owner_token !== lock.ownerToken) {
      let restoreError = null;
      try {
        renameWithRetry(releasePath, lock.path, options);
      } catch (error) {
        restoreError = error;
      }
      const error = new Error(`JSON state lock owner changed during release: ${lock.path}`);
      error.code = "JSON_STATE_LOCK_OWNERSHIP_LOST";
      error.blocker = true;
      error.lockPath = lock.path;
      error.expectedOwnerToken = lock.ownerToken;
      error.observedOwner = moved.metadata;
      error.restoreError = restoreError ? {
        code: restoreError.code || null,
        message: restoreError.message,
        artifactPath: releasePath
      } : null;
      throw error;
    }
    removeWithRetry(releasePath, options);
    released = true;
  } catch (error) {
    releaseError = error;
  }

  let transitionRemovalError = null;
  try {
    removeWithRetry(transitionPath, options);
  } catch (error) {
    markLockBlocker(error, lock.path, "transitionFailure", "artifact_removal", transitionPath);
    transitionRemovalError = error;
  }

  if (releaseError) {
    if (transitionRemovalError) {
      attachCleanupFailure(
        releaseError,
        "transition_artifact_removal",
        transitionPath,
        transitionRemovalError
      );
      releaseError.blocker = true;
      releaseError.lockPath = lock.path;
    }
    throw releaseError;
  }
  if (transitionRemovalError) throw transitionRemovalError;
  return released;
}

function lockEvidence(lock, released) {
  return {
    path: lock.path,
    ownerToken: lock.ownerToken,
    acquiredAt: lock.acquiredAt,
    recovered: lock.recovered,
    recoveredLock: lock.recoveredLock,
    waitAttempts: lock.waitAttempts,
    waitedMs: lock.waitedMs,
    released
  };
}

function withTargetLock(filePath, options, operation) {
  return withParentDirectory(filePath, options, (targetPath, writerOptions) => (
    runWithTargetLock(targetPath, writerOptions, operation)
  ));
}

function plainFileExists(filePath) {
  let details;
  try {
    details = fs.lstatSync(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  if (!details.isFile() || details.isSymbolicLink()) {
    const error = bindingError("JSON_STATE_FILE_UNSAFE", `JSON state copy requires a plain file: ${filePath}`);
    error.path = filePath;
    throw error;
  }
  return true;
}

function copyFileExclusive(sourcePath, targetPath, options) {
  plainFileExists(sourcePath);
  plainFileExists(targetPath);
  publishFileExclusive(targetPath, fs.readFileSync(sourcePath), options);
}

function assertOwnedTemp(temp) {
  const observed = fs.lstatSync(temp.path, { bigint: true });
  if (!observed.isFile() || observed.isSymbolicLink()
      || observed.dev !== temp.identity.dev || observed.ino !== temp.identity.ino) {
    const error = bindingError("JSON_STATE_TEMP_OWNERSHIP_LOST", `JSON state temporary file identity changed: ${temp.path}`);
    error.path = temp.path;
    throw error;
  }
}

function writeOwnedTemp(filePath, data, options) {
  assertBoundParent(options);
  const tempPath = createTempPath(filePath);
  let handle;
  let temp;
  let failure;
  try {
    handle = fs.openSync(tempPath, "wx");
    temp = { path: tempPath, identity: fs.fstatSync(handle, { bigint: true }) };
    assertOwnedTemp(temp);
    fs.writeFileSync(handle, data, "utf8");
    if (options.flush !== false && typeof fs.fsyncSync === "function") fs.fsyncSync(handle);
  } catch (error) {
    failure = error;
  }
  if (handle !== undefined) {
    try { fs.closeSync(handle); } catch (error) {
      if (failure) attachCleanupFailure(failure, "handle_close", tempPath, error);
      else failure = error;
    }
  }
  if (failure) {
    if (temp) {
      const cleanupFailure = cleanupTemp(tempPath, options, temp.identity);
      if (cleanupFailure) failure.cleanupFailures = [...(failure.cleanupFailures || []), cleanupFailure];
    }
    throw failure;
  }
  return temp;
}

function publishFileExclusive(filePath, data, options = {}) {
  // Windows copyFile(COPYFILE_EXCL) and open('wx') can follow a dangling link.
  // Publish a complete owned file with link(), which rejects any existing entry.
  // Staging uses an unpredictable name; this is not a defense against arbitrary
  // same-privilege active attackers modifying every newly created staging file.
  const temp = writeOwnedTemp(filePath, data, options);
  let published = false;
  let failure;
  try {
    assertOwnedTemp(temp);
    fs.linkSync(temp.path, filePath);
    published = true;
  } catch (error) {
    failure = error;
  }
  const cleanupFailure = cleanupTemp(temp.path, options, temp.identity);
  if (cleanupFailure) {
    failure ||= bindingError("JSON_STATE_TEMP_CLEANUP_FAILED", `JSON state staging cleanup failed: ${temp.path}`);
    failure.cleanupFailures = [...(failure.cleanupFailures || []), cleanupFailure];
  }
  if (failure) {
    failure.published = published;
    throw failure;
  }
}

function runWithTargetLock(filePath, options, operation) {
  const lock = acquireTargetLock(filePath, options);
  let result;
  let operationError;
  try {
    if (typeof options.validateLocked === "function") {
      synchronousResult(options.validateLocked(reportedPath(filePath, options)), options);
    }
    result = synchronousResult(operation(filePath, options), options);
  } catch (error) {
    operationError = error;
  }

  let released = false;
  let releaseError;
  try {
    assertBoundParent(options);
    released = releaseTargetLock(lock, options);
  } catch (error) {
    releaseError = error;
  }
  const evidence = lockEvidence(lock, released);

  if (operationError) {
    operationError.lock = evidence;
    if (releaseError) operationError.lockReleaseError = releaseError.message;
    throw operationError;
  }
  if (releaseError || !released) {
    const error = releaseError || new Error(`JSON state lock ownership was lost: ${filePath}`);
    error.code = error.code || "JSON_STATE_LOCK_RELEASE_FAILED";
    error.blocker = true;
    error.path = filePath;
    error.lock = evidence;
    throw error;
  }
  return result && typeof result === "object" ? { ...result, lock: evidence } : { value: result, lock: evidence };
}

function writeTextUnlocked(filePath, text, options = {}) {
  assertBoundParent(options);
  const directory = path.dirname(filePath);
  const backupPath = options.backup ? (options.backupPath || `${filePath}.bak`) : null;
  const writtenAt = options.writtenAt || new Date().toISOString();
  let backedUpTarget = false;

  fs.mkdirSync(directory, { recursive: true });
  const temp = writeOwnedTemp(filePath, text, options);
  const tempPath = temp.path;

  try {
    if (backupPath && fs.existsSync(filePath)) {
      if (plainFileExists(backupPath)) removeWithRetry(backupPath, options);
      copyFileExclusive(filePath, backupPath, options);
      backedUpTarget = true;
    }

    assertOwnedTemp(temp);
    const replaceAttempts = renameWithRetry(tempPath, filePath, options);
    return {
      status: "written",
      path: filePath,
      backupPath,
      tempPath,
      writtenAt,
      replaceAttempts
    };
  } catch (error) {
    const cleanupFailure = cleanupTemp(tempPath, options, temp.identity);
    if (cleanupFailure) {
      error.cleanupFailures = [...(error.cleanupFailures || []), cleanupFailure];
    }
    if (backedUpTarget && !fs.existsSync(filePath)) {
      try {
        copyFileExclusive(backupPath, filePath, options);
      } catch (restoreError) {
        attachCleanupFailure(error, "target_restore", filePath, restoreError);
      }
    }
    throw error;
  }
}

function serializeJson(data) {
  const serialized = `${JSON.stringify(data, null, 2)}\n`;
  if (serialized === "undefined\n") throw new TypeError("JSON state data must be serializable");
  return serialized;
}

function writeJsonUnlocked(filePath, data, options = {}) {
  return writeTextUnlocked(filePath, serializeJson(synchronousResult(data, options)), options);
}

function writeJsonAtomic(filePath, data, options = {}) {
  return withTargetLock(filePath, options, (targetPath, writerOptions) => writeJsonUnlocked(targetPath, data, writerOptions));
}

function writeTextAtomic(filePath, data, options = {}) {
  return withTargetLock(filePath, options, (targetPath, writerOptions) => (
    writeTextUnlocked(targetPath, String(synchronousResult(data, writerOptions)), writerOptions)
  ));
}

function updateTextAtomic(filePath, defaultValue, updater, options = {}) {
  return withTargetLock(filePath, options, (targetPath, writerOptions) => {
    const current = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, "utf8") : String(defaultValue);
    const next = String(synchronousResult(updater(current), writerOptions));
    if (next === current) return { status: "unchanged", path: targetPath };
    return writeTextUnlocked(targetPath, next, writerOptions);
  });
}

function updateJsonAtomic(filePath, defaultValue, updater, options = {}) {
  return withTargetLock(filePath, options, (targetPath, writerOptions) => {
    const current = readJsonFile(targetPath, defaultValue);
    const next = synchronousResult(updater(current), writerOptions);
    return writeJsonUnlocked(targetPath, next, writerOptions);
  });
}

function appendJsonlAtomic(filePath, event, options = {}) {
  return withTargetLock(filePath, options, (targetPath, writerOptions) => {
    const existing = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, "utf8") : "";
    if (event?.event_id) {
      const duplicate = existing.split(/\r?\n/).filter(Boolean)
        .map((line) => JSON.parse(line))
        .find((candidate) => candidate.event_id === event.event_id);
      if (duplicate) {
        if (!isDeepStrictEqual(duplicate, event)) {
          const error = new Error(`JSONL event_id collision: ${event.event_id}`);
          error.code = "JSON_STATE_EVENT_ID_COLLISION";
          error.blocker = true;
          error.path = targetPath;
          error.eventId = event.event_id;
          throw error;
        }
        return { path: targetPath, status: "already_present" };
      }
    }
    const prefix = existing && !existing.endsWith("\n") ? `${existing}\n` : existing;
    const result = writeTextUnlocked(targetPath, `${prefix}${JSON.stringify(event)}\n`, writerOptions);
    return { ...result, status: "appended" };
  });
}

function tryReadJson(filePath) {
  if (!fs.existsSync(filePath)) return { exists: false, valid: false, data: undefined, error: null };
  try {
    return {
      exists: true,
      valid: true,
      data: JSON.parse(fs.readFileSync(filePath, "utf8")),
      error: null
    };
  } catch (error) {
    return { exists: true, valid: false, data: undefined, error };
  }
}

function listTempPaths(filePath) {
  const directory = path.dirname(filePath);
  if (!fs.existsSync(directory)) return [];
  const prefix = `${path.basename(filePath)}.tmp-`;
  return fs.readdirSync(directory)
    .filter((name) => name.startsWith(prefix))
    .map((name) => path.join(directory, name))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
}

function unrecoverableError(filePath, target, backup, tempPaths) {
  const error = new Error(`JSON state is unrecoverable: ${filePath}`);
  error.code = "JSON_STATE_UNRECOVERABLE";
  error.blocker = true;
  error.path = filePath;
  error.targetError = target.error?.message || null;
  error.backupError = backup.error?.message || null;
  error.tempPaths = tempPaths;
  return error;
}

function notifyIncident(options, incident) {
  if (typeof options.onIncident === "function") options.onIncident(incident);
}

function recoverJsonUnlocked(filePath, options = {}) {
  const backupPath = options.backupPath || `${filePath}.bak`;
  const target = tryReadJson(filePath);
  if (target.valid) {
    return {
      status: "valid",
      path: filePath,
      backupPath,
      tempPath: null,
      writtenAt: null,
      data: target.data
    };
  }

  const backup = tryReadJson(backupPath);
  const tempPaths = listTempPaths(filePath);

  if (target.exists && backup.valid) {
    const writeResult = writeJsonUnlocked(filePath, backup.data, { ...options, backup: false });
    const incident = {
      type: "json_state_recovered_from_backup",
      path: filePath,
      backup_path: backupPath,
      detected_at: options.detectedAt || new Date().toISOString(),
      error: target.error?.message || "invalid target JSON"
    };
    notifyIncident(options, incident);
    return { ...writeResult, status: "restored_backup", data: backup.data, incident };
  }

  if (!target.exists) {
    const validTempPath = tempPaths.find((tempPath) => tryReadJson(tempPath).valid);
    if (validTempPath) {
      const temp = tryReadJson(validTempPath);
      const replaceAttempts = renameWithRetry(validTempPath, filePath, options);
      const cleanupFailures = tempPaths
        .filter((tempPath) => tempPath !== validTempPath)
        .map((tempPath) => cleanupTemp(tempPath, options))
        .filter(Boolean);
      const incident = {
        type: "json_state_promoted_temp",
        path: filePath,
        temp_path: validTempPath,
        detected_at: options.detectedAt || new Date().toISOString()
      };
      notifyIncident(options, incident);
      return {
        status: "promoted_temp",
        path: filePath,
        backupPath,
        tempPath: validTempPath,
        writtenAt: incident.detected_at,
        replaceAttempts,
        cleanupFailures,
        data: temp.data,
        incident
      };
    }

    if (backup.valid) {
      const writeResult = writeJsonUnlocked(filePath, backup.data, { ...options, backup: false });
      return { ...writeResult, status: "restored_backup", data: backup.data };
    }

    if (!backup.exists && tempPaths.length === 0) {
      return {
        status: "missing",
        path: filePath,
        backupPath,
        tempPath: null,
        writtenAt: null,
        data: options.defaultValue
      };
    }
  }

  throw unrecoverableError(filePath, target, backup, tempPaths);
}

function recoverJsonFile(filePath, options = {}) {
  // Recovery has post-write onIncident callbacks and is outside the synchronous
  // pinned task-writer contract. Existing non-opt-in recovery keeps its behavior.
  if (options.bindParentDirectory) {
    throw bindingError("JSON_STATE_RECOVERY_BINDING_UNSUPPORTED", "Parent-bound recovery is not supported");
  }
  return withTargetLock(filePath, options, () => recoverJsonUnlocked(filePath, options));
}

module.exports = {
  appendJsonlAtomic,
  readJsonFile,
  recoverJsonFile,
  updateTextAtomic,
  updateJsonAtomic,
  writeJsonAtomic,
  writeTextAtomic
};
