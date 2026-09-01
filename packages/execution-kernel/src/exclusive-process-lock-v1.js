"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

function error(code, message, cause) {
  const value = new Error(message, cause ? { cause } : undefined);
  value.code = code;
  return value;
}

function comparable(value) {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function trustedRoot(rootPath, codePrefix) {
  if (typeof rootPath !== "string" || !path.isAbsolute(rootPath)) {
    throw error(`${codePrefix}_LOCK_ROOT_INVALID`, "Process lock requires an absolute trusted root");
  }
  const requested = path.resolve(rootPath);
  let canonical;
  try {
    canonical = fs.realpathSync(requested);
  } catch (cause) {
    throw error(`${codePrefix}_LOCK_ROOT_UNAVAILABLE`, "Process lock trusted root is unavailable", cause);
  }
  const details = fs.lstatSync(requested);
  if (!details.isDirectory() || details.isSymbolicLink() || comparable(requested) !== comparable(canonical)) {
    throw error(`${codePrefix}_LOCK_ROOT_UNSAFE`, "Process lock trusted root must be a canonical real directory");
  }
  return canonical;
}

function assertInside(rootPath, candidatePath, codePrefix) {
  const relative = path.relative(rootPath, candidatePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw error(`${codePrefix}_LOCK_PATH_UNSAFE`, "Process lock path escaped its trusted root");
  }
}

function ensureDirectoryChain(rootPath, directoryPath, codePrefix) {
  assertInside(rootPath, directoryPath, codePrefix);
  const segments = path.relative(rootPath, directoryPath).split(path.sep).filter(Boolean);
  let current = rootPath;
  for (const segment of segments) {
    const next = path.join(current, segment);
    if (!fs.existsSync(next)) {
      try {
        fs.mkdirSync(next);
      } catch (cause) {
        // Another contender may create the same directory after the existence
        // check. EEXIST is accepted only after the canonical-directory checks
        // below prove that the winner created the expected safe boundary.
        if (cause?.code !== "EEXIST") throw cause;
      }
    }
    const details = fs.lstatSync(next);
    if (!details.isDirectory() || details.isSymbolicLink()
      || comparable(fs.realpathSync(next)) !== comparable(next)) {
      throw error(`${codePrefix}_LOCK_PATH_UNSAFE`, `Process lock directory is unsafe: ${next}`);
    }
    current = next;
  }
}

function safeNonce(value) {
  return typeof value === "string" && /^[A-Za-z0-9-]{1,128}$/u.test(value);
}

function candidatePathFor(lockPath, nonce) {
  return `${lockPath}.candidate-${nonce}.json`;
}

function recoveryPathFor(lockPath, nonce) {
  return `${lockPath}.recovery-${nonce}.json`;
}

function realRegularFile(filePath, rootPath, codePrefix) {
  assertInside(rootPath, filePath, codePrefix);
  let details;
  let canonical;
  try {
    details = fs.lstatSync(filePath, { bigint: true });
    canonical = fs.realpathSync(filePath);
  } catch (cause) {
    if (cause?.code === "ENOENT") return null;
    throw cause;
  }
  if (!details.isFile() || details.isSymbolicLink()
    || comparable(canonical) !== comparable(filePath)) {
    throw error(`${codePrefix}_LOCK_PATH_UNSAFE`, "Process lock artifacts must be canonical real files");
  }
  return details;
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function exactMetadata(value, lockPath, codePrefix) {
  const keys = value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value).sort()
    : [];
  const expected = ["schema_version", "pid", "nonce", "lock_path", "candidate_path", "acquired_at"].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])
    || value.schema_version !== 1
    || !Number.isSafeInteger(value.pid) || value.pid <= 0
    || !safeNonce(value.nonce)
    || comparable(value.lock_path) !== comparable(lockPath)
    || comparable(value.candidate_path) !== comparable(candidatePathFor(lockPath, value.nonce))
    || typeof value.acquired_at !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value.acquired_at)
    || !Number.isFinite(Date.parse(value.acquired_at))
    || new Date(value.acquired_at).toISOString() !== value.acquired_at) {
    throw error(`${codePrefix}_LOCK_UNVERIFIABLE`, "Process lock metadata is not exact");
  }
  return value;
}

function readMetadata(filePath, lockPath, rootPath, codePrefix) {
  const before = realRegularFile(filePath, rootPath, codePrefix);
  if (!before) return null;
  let value;
  try {
    value = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (cause) {
    if (cause?.code === "ENOENT") return null;
    throw error(`${codePrefix}_LOCK_UNVERIFIABLE`, "Process lock metadata could not be read", cause);
  }
  const after = realRegularFile(filePath, rootPath, codePrefix);
  if (!after) return null;
  if (!sameFile(before, after)) {
    throw error(`${codePrefix}_LOCK_UNVERIFIABLE`, "Process lock changed while it was inspected");
  }
  return { metadata: exactMetadata(value, lockPath, codePrefix), details: after };
}

function processState(pid) {
  try {
    process.kill(pid, 0);
    return "live";
  } catch (cause) {
    if (cause?.code === "EPERM") return "live";
    if (cause?.code === "ESRCH") return "dead";
    return "unverifiable";
  }
}

function writeCandidate(candidatePath, content, rootPath, codePrefix) {
  assertInside(rootPath, candidatePath, codePrefix);
  const descriptor = fs.openSync(candidatePath, "wx", 0o600);
  const openedDetails = fs.fstatSync(descriptor, { bigint: true });
  let failure = null;
  try {
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
  } catch (cause) {
    failure = cause;
  } finally {
    try {
      fs.closeSync(descriptor);
    } catch (cause) {
      failure ||= cause;
    }
  }
  if (failure) {
    try {
      cleanupExactOwnedFile(candidatePath, openedDetails, null, codePrefix);
    } catch (cleanupCause) {
      failure.cleanupError = cleanupCause;
    }
    throw failure;
  }
  const details = realRegularFile(candidatePath, rootPath, codePrefix);
  if (!details || !sameFile(details, openedDetails)) {
    throw error(`${codePrefix}_LOCK_UNAVAILABLE`, "Process lock candidate identity changed after write");
  }
  return details;
}

function syncDirectory(directoryPath) {
  const descriptor = fs.openSync(directoryPath, "r");
  try {
    try {
      fs.fsyncSync(descriptor);
    } catch (cause) {
      if (process.platform !== "win32" || !["EPERM", "EINVAL"].includes(cause?.code)) throw cause;
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function exactDirectory(rootPath, directoryPath, codePrefix) {
  ensureDirectoryChain(rootPath, directoryPath, codePrefix);
  const details = fs.lstatSync(directoryPath, { bigint: true });
  if (!details.isDirectory() || details.isSymbolicLink()
    || comparable(fs.realpathSync(directoryPath)) !== comparable(directoryPath)) {
    throw error(`${codePrefix}_PATH_UNSAFE`, "Published file directory is not canonical");
  }
  return details;
}

function parseExactJson(bytes, expectedValue, validate, codePrefix, phase) {
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (cause) {
    throw error(`${codePrefix}_JSON_INVALID`, `${phase} JSON could not be parsed`, cause);
  }
  validate(parsed);
  if (JSON.stringify(parsed) !== JSON.stringify(expectedValue)) {
    throw error(`${codePrefix}_JSON_MISMATCH`, `${phase} JSON changed during publication`);
  }
  return parsed;
}

function cleanupExactOwnedFile(filePath, expectedDetails, expectedBytes, codePrefix) {
  let current;
  try {
    current = fs.lstatSync(filePath, { bigint: true });
  } catch (cause) {
    if (cause?.code === "ENOENT") return;
    throw cause;
  }
  if (!current.isFile() || current.isSymbolicLink() || !sameFile(current, expectedDetails)) {
    throw error(`${codePrefix}_PUBLISH_OWNERSHIP_LOST`, "Published file ownership changed during cleanup");
  }
  if (expectedBytes && !fs.readFileSync(filePath).equals(expectedBytes)) {
    throw error(`${codePrefix}_PUBLISH_OWNERSHIP_LOST`, "Published file bytes changed during cleanup");
  }
  fs.unlinkSync(filePath);
}

function publishExclusiveJsonFile({
  rootPath,
  filePath,
  value,
  validate,
  codePrefix,
  nonce = randomUUID,
} = {}) {
  if (typeof codePrefix !== "string" || !/^[A-Z][A-Z0-9_]*$/u.test(codePrefix)) {
    throw error("EXCLUSIVE_PUBLISH_PREFIX_INVALID", "Exclusive JSON publish error prefix is invalid");
  }
  if (typeof validate !== "function") {
    throw error(`${codePrefix}_JSON_VALIDATOR_INVALID`, "Exclusive JSON publish requires a validator");
  }
  const root = trustedRoot(rootPath, codePrefix);
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
    throw error(`${codePrefix}_PUBLISH_PATH_UNSAFE`, "Exclusive JSON publish path must be absolute");
  }
  const target = path.resolve(filePath);
  assertInside(root, target, codePrefix);
  const directory = path.dirname(target);
  const directoryDetails = exactDirectory(root, directory, codePrefix);
  const stagingDirectory = path.join(root, ".orquesta", "runtime", "exclusive-json-publish-v1");
  exactDirectory(root, stagingDirectory, codePrefix);
  if (realRegularFile(target, root, codePrefix)) {
    throw error(`${codePrefix}_PUBLISH_EXISTS`, "Exclusive JSON publish never overwrites an existing file");
  }
  validate(value);
  const serialized = JSON.stringify(value, null, 2);
  if (typeof serialized !== "string") {
    throw error(`${codePrefix}_JSON_INVALID`, "Exclusive JSON publish value is not serializable");
  }
  const expectedBytes = Buffer.from(`${serialized}\n`, "utf8");
  const candidateNonce = nonce();
  if (!safeNonce(candidateNonce)) {
    throw error(`${codePrefix}_PUBLISH_NONCE_INVALID`, "Exclusive JSON publish nonce is invalid");
  }
  const candidatePath = path.join(stagingDirectory, `.publish-${candidateNonce}.tmp`);
  let candidateDetails = null;
  let published = false;
  try {
    candidateDetails = writeCandidate(candidatePath, expectedBytes, root, codePrefix);
    const stagedBytes = fs.readFileSync(candidatePath);
    if (!stagedBytes.equals(expectedBytes)) {
      throw error(`${codePrefix}_JSON_MISMATCH`, "Staged JSON bytes changed during publication");
    }
    parseExactJson(stagedBytes, value, validate, codePrefix, "staged");
    if (!sameFile(exactDirectory(root, directory, codePrefix), directoryDetails)) {
      throw error(`${codePrefix}_PUBLISH_DIRECTORY_CHANGED`, "Published file directory identity changed");
    }
    if (realRegularFile(target, root, codePrefix)) {
      throw error(`${codePrefix}_PUBLISH_EXISTS`, "Exclusive JSON publish target appeared before promotion");
    }
    try {
      fs.linkSync(candidatePath, target);
      published = true;
    } catch (cause) {
      if (cause?.code === "EEXIST") {
        throw error(`${codePrefix}_PUBLISH_EXISTS`, "Exclusive JSON publish target already exists", cause);
      }
      throw cause;
    }
    const publishedDetails = realRegularFile(target, root, codePrefix);
    const currentCandidate = realRegularFile(candidatePath, root, codePrefix);
    if (!publishedDetails || !currentCandidate
      || !sameFile(publishedDetails, candidateDetails)
      || !sameFile(currentCandidate, candidateDetails)
      || !sameFile(exactDirectory(root, directory, codePrefix), directoryDetails)) {
      throw error(`${codePrefix}_PUBLISH_IDENTITY_MISMATCH`, "Promoted JSON did not retain its owned file identity");
    }
    const finalBytes = fs.readFileSync(target);
    if (!finalBytes.equals(expectedBytes)) {
      throw error(`${codePrefix}_JSON_MISMATCH`, "Published JSON bytes changed after promotion");
    }
    parseExactJson(finalBytes, value, validate, codePrefix, "published");
    unlinkOwned(candidatePath, candidateDetails, root, codePrefix);
    syncDirectory(stagingDirectory);
    syncDirectory(directory);
    return target;
  } catch (cause) {
    const cleanupFailures = [];
    if (published && candidateDetails) {
      try {
        cleanupExactOwnedFile(target, candidateDetails, expectedBytes, codePrefix);
      } catch (cleanupCause) {
        cleanupFailures.push(cleanupCause);
      }
    }
    if (candidateDetails) {
      try {
        cleanupExactOwnedFile(candidatePath, candidateDetails, null, codePrefix);
      } catch (cleanupCause) {
        cleanupFailures.push(cleanupCause);
      }
    }
    if (cleanupFailures.length > 0 && cause && typeof cause === "object") {
      cause.cleanupError = new AggregateError(cleanupFailures, `${codePrefix}_PUBLISH_CLEANUP_FAILED`);
    }
    throw cause;
  }
}

function unlinkOwned(filePath, expectedDetails, rootPath, codePrefix) {
  const current = realRegularFile(filePath, rootPath, codePrefix);
  if (!current || !sameFile(current, expectedDetails)) {
    throw error(`${codePrefix}_LOCK_LOST`, "Process lock artifact ownership changed");
  }
  fs.unlinkSync(filePath);
}

function recoverDeadLock(rootPath, lockPath, codePrefix) {
  const observed = readMetadata(lockPath, lockPath, rootPath, codePrefix);
  if (!observed) return "retry";
  const state = processState(observed.metadata.pid);
  if (state === "live") throw error(`${codePrefix}_LOCKED`, "Process lock is held by another live operation");
  if (state !== "dead") throw error(`${codePrefix}_LOCK_UNVERIFIABLE`, "Process lock owner liveness is unverifiable");

  // Every recoverer of this owner must acquire the same claim before touching
  // the lock path. Never reclaim claims: a crashed recoverer needs explicit
  // maintenance rather than another recursively racy recovery protocol.
  const recoveryPath = recoveryPathFor(lockPath, observed.metadata.nonce);
  const recoveryMetadata = {
    schema_version: 1,
    pid: process.pid,
    nonce: randomUUID(),
    lock_path: lockPath,
    observed_owner: {
      pid: observed.metadata.pid,
      nonce: observed.metadata.nonce,
      dev: String(observed.details.dev),
      ino: String(observed.details.ino),
    },
  };
  let recoveryDetails;
  try {
    recoveryDetails = writeCandidate(recoveryPath, `${JSON.stringify(recoveryMetadata)}\n`, rootPath, codePrefix);
  } catch (cause) {
    if (cause?.code === "EEXIST") {
      throw error(`${codePrefix}_LOCK_RECOVERY_REQUIRED`,
        "Dead-owner recovery is already claimed; retry after it finishes or explicitly resolve the stranded claim", cause);
    }
    throw error(`${codePrefix}_LOCK_RECOVERY_FAILED`, "Dead process lock could not be claimed for recovery", cause);
  }

  try {
    const current = readMetadata(lockPath, lockPath, rootPath, codePrefix);
    if (!current || !sameFile(current.details, observed.details)
      || current.metadata.nonce !== observed.metadata.nonce
      || current.metadata.pid !== observed.metadata.pid) return "retry";
    const currentState = processState(current.metadata.pid);
    if (currentState === "live") throw error(`${codePrefix}_LOCKED`, "Process lock owner is live after recovery claim");
    if (currentState !== "dead") throw error(`${codePrefix}_LOCK_UNVERIFIABLE`, "Process lock owner liveness is unverifiable");
    const candidatePath = current.metadata.candidate_path;
    const candidate = realRegularFile(candidatePath, rootPath, codePrefix);
    if (!candidate || !sameFile(candidate, current.details)) {
      throw error(`${codePrefix}_LOCK_RECOVERY_FAILED`, "Dead process lock candidate identity is unavailable");
    }
    unlinkOwned(lockPath, current.details, rootPath, codePrefix);
    // A new owner can publish immediately after unlink. Do not touch lockPath
    // again: only this dead owner's candidate and our own claim remain ours.
    unlinkOwned(candidatePath, candidate, rootPath, codePrefix);
    return "retry";
  } finally {
    unlinkOwned(recoveryPath, recoveryDetails, rootPath, codePrefix);
  }
}

function acquireExclusiveProcessLock({ rootPath, lockPath, codePrefix, nonce = randomUUID, now = () => new Date() } = {}) {
  if (typeof codePrefix !== "string" || !/^[A-Z][A-Z0-9_]*$/u.test(codePrefix)) {
    throw error("EXCLUSIVE_LOCK_PREFIX_INVALID", "Process lock error prefix is invalid");
  }
  const root = trustedRoot(rootPath, codePrefix);
  if (typeof lockPath !== "string" || !path.isAbsolute(lockPath)) {
    throw error(`${codePrefix}_LOCK_PATH_UNSAFE`, "Process lock path must be absolute");
  }
  const target = path.resolve(lockPath);
  assertInside(root, target, codePrefix);
  ensureDirectoryChain(root, path.dirname(target), codePrefix);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const candidateNonce = nonce();
    if (!safeNonce(candidateNonce)) throw error(`${codePrefix}_LOCK_NONCE_INVALID`, "Process lock nonce is invalid");
    const candidatePath = candidatePathFor(target, candidateNonce);
    const acquiredAt = now();
    const acquiredAtIso = acquiredAt instanceof Date ? acquiredAt.toISOString() : String(acquiredAt);
    const metadata = {
      schema_version: 1,
      pid: process.pid,
      nonce: candidateNonce,
      lock_path: target,
      candidate_path: candidatePath,
      acquired_at: acquiredAtIso,
    };
    exactMetadata(metadata, target, codePrefix);
    let candidateDetails;
    try {
      candidateDetails = writeCandidate(candidatePath, `${JSON.stringify(metadata)}\n`, root, codePrefix);
    } catch (cause) {
      if (cause?.code === "EEXIST") continue;
      throw cause;
    }
    try {
      fs.linkSync(candidatePath, target);
    } catch (cause) {
      unlinkOwned(candidatePath, candidateDetails, root, codePrefix);
      if (cause?.code !== "EEXIST") {
        throw error(`${codePrefix}_LOCK_UNAVAILABLE`, "Process lock could not be published atomically", cause);
      }
      recoverDeadLock(root, target, codePrefix);
      continue;
    }
    const published = readMetadata(target, target, root, codePrefix);
    const candidate = realRegularFile(candidatePath, root, codePrefix);
    if (!published || !candidate || !sameFile(published.details, candidate)
      || !sameFile(candidate, candidateDetails)) {
      throw error(`${codePrefix}_LOCK_UNVERIFIABLE`, "Published process lock identity is not exact");
    }
    return {
      root_path: root,
      lock_path: target,
      candidate_path: candidatePath,
      metadata,
      details: published.details,
      released: false,
      code_prefix: codePrefix,
    };
  }
  throw error(`${codePrefix}_LOCK_UNAVAILABLE`, "Process lock acquisition did not converge");
}

function releaseExclusiveProcessLock(lock) {
  if (!lock || lock.released === true || !lock.details) {
    throw error(`${lock?.code_prefix || "EXCLUSIVE"}_LOCK_LOST`, "Process lock is not held");
  }
  const published = readMetadata(lock.lock_path, lock.lock_path, lock.root_path, lock.code_prefix);
  const candidate = readMetadata(lock.candidate_path, lock.lock_path, lock.root_path, lock.code_prefix);
  if (!published || !candidate || !sameFile(published.details, lock.details)
    || !sameFile(candidate.details, lock.details)
    || published.metadata.nonce !== lock.metadata.nonce
    || candidate.metadata.nonce !== lock.metadata.nonce) {
    throw error(`${lock.code_prefix}_LOCK_LOST`, "Process lock ownership was lost before release");
  }
  unlinkOwned(lock.lock_path, lock.details, lock.root_path, lock.code_prefix);
  unlinkOwned(lock.candidate_path, lock.details, lock.root_path, lock.code_prefix);
  lock.released = true;
}

module.exports = {
  acquireExclusiveProcessLock,
  publishExclusiveJsonFile,
  releaseExclusiveProcessLock,
};
