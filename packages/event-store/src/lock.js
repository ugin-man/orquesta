"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { eventStoreError } = require("./errors");

const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const LOCK_V1_FIELDS = Object.freeze(["acquired_at", "host_id", "nonce", "owner_pid", "target_revision"]);
const LOCK_V2_FIELDS = Object.freeze([...LOCK_V1_FIELDS, "lock_version", "owner_incarnation"].sort());
const TRANSITION_V2_FIELDS = Object.freeze([
  "created_at", "host_id", "owner_incarnation", "owner_nonce", "owner_pid", "transition_kind", "transition_version",
].sort());
const currentProcessIncarnation = processIncarnation(process.pid) || crypto.randomBytes(32).toString("hex");

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function lockPathFor(journalPath) {
  return `${journalPath}.lock`;
}

function isUtcTimestamp(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && !Number.isNaN(new Date(value).getTime()) && new Date(value).toISOString() === value;
}

function sameFields(value, fields) {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify(fields);
}

function processIncarnation(pid) {
  if (process.platform !== "linux" || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const closing = stat.lastIndexOf(")");
    if (closing < 0) return null;
    const tail = stat.slice(closing + 2).trim().split(/\s+/u);
    const startTicks = tail[19];
    const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const pidNamespace = fs.readlinkSync(`/proc/${pid}/ns/pid`);
    if (!/^\d+$/u.test(startTicks) || !bootId || !pidNamespace) return null;
    return crypto.createHash("sha256").update(`${bootId}\0${pidNamespace}\0${pid}\0${startTicks}`, "utf8").digest("hex");
  } catch {
    return null;
  }
}

function monotonicNow() {
  return process.hrtime.bigint();
}

function deadlineAfter(milliseconds) {
  return monotonicNow() + BigInt(Math.max(0, milliseconds)) * 1_000_000n;
}

function deadlineReached(deadline) {
  return monotonicNow() >= deadline;
}

function transitionPaths(lockPath) {
  const base = path.basename(lockPath);
  try {
    return fs.readdirSync(path.dirname(lockPath))
      .filter((entry) => entry.startsWith(`${base}.transition-`) || entry.startsWith(`${base}.release-`))
      .map((entry) => path.join(path.dirname(lockPath), entry));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function readMetadata(filePath) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(filePath));
  if (!text.endsWith("\n") || text.slice(0, -1).includes("\n")) {
    throw eventStoreError("EVENT_LOCK_INVALID", "Journal lock metadata must be one JSON line", { file_path: filePath });
  }
  const metadata = JSON.parse(text);
  const version = metadata?.lock_version === 2 ? 2 : 1;
  const fieldsValid = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    && (version === 2 ? sameFields(metadata, LOCK_V2_FIELDS) : sameFields(metadata, LOCK_V1_FIELDS));
  if (!fieldsValid
    || !Number.isInteger(metadata.owner_pid) || metadata.owner_pid <= 0
    || typeof metadata.host_id !== "string" || !metadata.host_id.trim()
    || typeof metadata.nonce !== "string" || !metadata.nonce
    || !isUtcTimestamp(metadata.acquired_at)
    || (version === 2 && (typeof metadata.owner_incarnation !== "string" || !/^[a-f0-9]{64}$/u.test(metadata.owner_incarnation)
      || !/^[a-f0-9]{32}$/u.test(metadata.nonce)))
    || !Number.isInteger(metadata.target_revision) || metadata.target_revision < 0) {
    throw eventStoreError("EVENT_LOCK_INVALID", "Journal lock metadata is invalid", { file_path: filePath });
  }
  return metadata;
}

function readTransitionMetadata(filePath) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(filePath));
  if (!text.endsWith("\n") || text.slice(0, -1).includes("\n")) throw eventStoreError("EVENT_LOCK_INVALID", "Journal lock transition must be one JSON line", { file_path: filePath });
  const metadata = JSON.parse(text);
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)
    || !sameFields(metadata, TRANSITION_V2_FIELDS)
    || metadata.transition_version !== 2
    || !["release", "publication"].includes(metadata.transition_kind)
    || !Number.isInteger(metadata.owner_pid) || metadata.owner_pid <= 0
    || typeof metadata.host_id !== "string" || !metadata.host_id.trim()
    || typeof metadata.owner_nonce !== "string" || !/^[a-f0-9]{32}$/u.test(metadata.owner_nonce)
    || typeof metadata.owner_incarnation !== "string" || !/^[a-f0-9]{64}$/u.test(metadata.owner_incarnation)
    || !isUtcTimestamp(metadata.created_at)) {
    throw eventStoreError("EVENT_LOCK_INVALID", "Journal lock transition metadata is invalid", { file_path: filePath });
  }
  return metadata;
}

function inspectJournalLock(journalPath) {
  const lockPath = lockPathFor(journalPath);
  try {
    return { exists: true, path: lockPath, metadata: readMetadata(lockPath), transitions: transitionPaths(lockPath) };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, path: lockPath, transitions: transitionPaths(lockPath) };
    return {
      exists: true,
      path: lockPath,
      metadata: null,
      transitions: transitionPaths(lockPath),
      error: { code: error.code || "EVENT_LOCK_INVALID", message: error.message },
    };
  }
}

function classifyOwner(metadata, hostId) {
  if (!metadata) return "unproven";
  if (metadata.host_id !== hostId) return "remote";
  try {
    process.kill(metadata.owner_pid, 0);
    if (metadata.lock_version === 2) {
      const observed = processIncarnation(metadata.owner_pid);
      if (observed && observed !== metadata.owner_incarnation) return "incarnation_mismatch";
    }
    return "live";
  } catch (error) {
    return error.code === "ESRCH" ? "dead" : "unproven";
  }
}

function callHook(hooks, name, value) {
  if (hooks && typeof hooks[name] === "function") hooks[name](value);
}

function sameLockIdentity(left, right) {
  return Boolean(left && right)
    && left.owner_pid === right.owner_pid
    && left.host_id === right.host_id
    && left.nonce === right.nonce
    && left.acquired_at === right.acquired_at
    && left.target_revision === right.target_revision
    && (left.lock_version || 1) === (right.lock_version || 1)
    && (left.owner_incarnation || null) === (right.owner_incarnation || null);
}

function assertJournalLockOwned(lock) {
  let current;
  try {
    current = readMetadata(lock.lockPath);
  } catch (error) {
    throw eventStoreError("EVENT_LOCK_OWNERSHIP_LOST", "Journal lock ownership could not be verified", {
      lock_path: lock.lockPath,
      cause_code: error.code || null,
    });
  }
  if (!sameLockIdentity(current, lock.metadata)) {
    throw eventStoreError("EVENT_LOCK_OWNERSHIP_LOST", "Journal lock ownership changed", { lock_path: lock.lockPath });
  }
  return current;
}

function writeJsonLineFsync(filePath, value) {
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, "wx");
    fs.writeFileSync(descriptor, Buffer.from(`${JSON.stringify(value)}\n`, "utf8"));
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function staleTransitionError(lockPath) {
  return eventStoreError("EVENT_STALE_LOCK", "Journal lock transition requires explicit manual repair", {
    lock_path: lockPath,
    transitions: transitionPaths(lockPath),
  });
}

function busyError(lockPath, observed) {
  return eventStoreError("EVENT_LOCK_BUSY", "Journal lock is temporarily owned by a live local operation", {
    lock_path: lockPath,
    outcome: "not_started",
    retryable: true,
    observed,
  });
}

function waitForTransitions(lockPath, hostId, deadline) {
  for (;;) {
    const paths = transitionPaths(lockPath);
    if (paths.length === 0) return null;
    if (!deadlineReached(deadline)) {
      sleep(5);
      continue;
    }
    const observed = inspectJournalLock(lockPath.slice(0, -5));
    if (observed.transitions.length === 0) return null;
    const owners = [];
    const observedPaths = [...observed.transitions].sort();
    try {
      for (const transitionPath of observedPaths) {
        if (transitionPath.includes(".transition-")) {
          const transition = readTransitionMetadata(transitionPath);
          owners.push(classifyOwner({
            lock_version: 2,
            owner_pid: transition.owner_pid,
            host_id: transition.host_id,
            owner_incarnation: transition.owner_incarnation,
          }, hostId));
        } else {
          owners.push(classifyOwner(readMetadata(transitionPath), hostId));
        }
      }
    } catch {
      const currentPaths = transitionPaths(lockPath).sort();
      if (JSON.stringify(currentPaths) !== JSON.stringify(observedPaths)) continue;
      throw staleTransitionError(lockPath);
    }
    const currentPaths = transitionPaths(lockPath).sort();
    if (JSON.stringify(currentPaths) !== JSON.stringify(observedPaths)) continue;
    if (owners.includes("live")) throw busyError(lockPath, observed);
    throw staleTransitionError(lockPath);
  }
}

function acquireJournalLock({ journalPath, hostId, targetRevision, timeoutMs = DEFAULT_LOCK_TIMEOUT_MS, testHooks } = {}) {
  const lockPath = lockPathFor(journalPath);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = deadlineAfter(timeoutMs);
  const metadata = {
    lock_version: 2,
    owner_pid: process.pid,
    host_id: hostId,
    owner_incarnation: currentProcessIncarnation,
    nonce: crypto.randomBytes(16).toString("hex"),
    acquired_at: new Date().toISOString(),
    target_revision: targetRevision,
  };

  for (;;) {
    waitForTransitions(lockPath, hostId, deadline);
    callHook(testHooks, "afterTransitionPrecheck", { lockPath, metadata });
    let descriptor;
    try {
      descriptor = fs.openSync(lockPath, "wx");
      fs.writeFileSync(descriptor, Buffer.from(`${JSON.stringify(metadata)}\n`, "utf8"));
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      callHook(testHooks, "afterAcquire", { lockPath, metadata });
      waitForTransitions(lockPath, hostId, deadline);
      return { journalPath, lockPath, metadata };
    } catch (error) {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      if (["EVENT_LOCK_BUSY", "EVENT_STALE_LOCK"].includes(error?.code)) {
        try {
          const current = readMetadata(lockPath);
          if (sameLockIdentity(current, metadata)) fs.unlinkSync(lockPath);
        } catch (cleanupError) {
          if (cleanupError?.code !== "ENOENT") {
            throw eventStoreError("EVENT_LOCK_OWNERSHIP_LOST", "A failed acquisition could not release its own journal lock", {
              lock_path: lockPath,
              cause_code: cleanupError.code || null,
              blocked_by: error.code,
            });
          }
        }
        throw error;
      }
      if (error.code !== "EEXIST") {
        throw eventStoreError("EVENT_LOCK_ACQUIRE_FAILED", "Could not initialize journal lock", {
          lock_path: lockPath,
          cause_code: error.code || null,
        });
      }
      callHook(testHooks, "onContention", { lockPath, metadata });
      if (deadlineReached(deadline)) {
        const observed = inspectJournalLock(journalPath);
        if (!observed.exists && observed.transitions.length === 0) continue;
        if (classifyOwner(observed.metadata, hostId) === "live") throw busyError(lockPath, observed);
        throw eventStoreError("EVENT_STALE_LOCK", "Journal lock requires explicit manual repair", { lock_path: lockPath, observed });
      }
      sleep(5);
    }
  }
}

function removeTransitionMarker(markerPath) {
  try {
    fs.unlinkSync(markerPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}


function armJournalLockGuard(lock, options = {}) {
  assertJournalLockOwned(lock);
  const markerPath = `${lock.lockPath}.transition-${lock.metadata.nonce}-publication`;
  try {
    writeJsonLineFsync(markerPath, {
      transition_version: 2,
      transition_kind: "publication",
      owner_nonce: lock.metadata.nonce,
      owner_pid: lock.metadata.owner_pid,
      host_id: lock.metadata.host_id,
      owner_incarnation: lock.metadata.owner_incarnation || currentProcessIncarnation,
      created_at: new Date().toISOString(),
    });
  } catch (error) {
    throw eventStoreError("EVENT_LOCK_GUARD_FAILED", "Could not arm the journal publication guard", {
      lock_path: lock.lockPath,
      marker_path: markerPath,
      cause_code: error.code || null,
    });
  }
  callHook(options.testHooks, "afterPublicationGuard", { lock, markerPath });
  try {
    assertJournalLockOwned(lock);
  } catch (error) {
    throw eventStoreError("EVENT_LOCK_OWNERSHIP_LOST", "Journal lock ownership changed while arming publication guard", {
      lock_path: lock.lockPath,
      marker_path: markerPath,
      cause_code: error.code || null,
    });
  }
  return { lock, markerPath };
}

function disarmJournalLockGuard(guard, options = {}) {
  const { lock, markerPath } = guard;
  assertJournalLockOwned(lock);
  let marker;
  try {
    marker = readTransitionMetadata(markerPath);
  } catch (error) {
    throw eventStoreError("EVENT_LOCK_GUARD_FAILED", "Journal publication guard could not be verified", {
      marker_path: markerPath,
      cause_code: error.code || null,
    });
  }
  if (marker.transition_kind !== "publication" || marker.owner_nonce !== lock.metadata.nonce) {
    throw eventStoreError("EVENT_LOCK_GUARD_FAILED", "Journal publication guard ownership changed", { marker_path: markerPath });
  }
  callHook(options.testHooks, "beforePublicationGuardRemoval", { lock, markerPath });
  assertJournalLockOwned(lock);
  try {
    removeTransitionMarker(markerPath);
  } catch (error) {
    throw eventStoreError("EVENT_LOCK_GUARD_FAILED", "Could not disarm the journal publication guard", {
      marker_path: markerPath,
      cause_code: error.code || null,
    });
  }
  return { disarmed: true };
}

function removeDeadJournalLockTransitions(lock, paths) {
  const expected = [...paths].sort();
  for (const transitionPath of expected) {
    if (!path.basename(transitionPath).startsWith(`${path.basename(lock.lockPath)}.transition-`)) {
      throw eventStoreError("EVENT_LOCK_OWNERSHIP_UNPROVEN", "Only exact owned transition markers can be removed during recovery", { transition_path: transitionPath });
    }
    const transition = readTransitionMetadata(transitionPath);
    if (transition.owner_nonce !== lock.metadata.nonce
        || transition.owner_pid !== lock.metadata.owner_pid
        || transition.host_id !== lock.metadata.host_id
        || transition.owner_incarnation !== lock.metadata.owner_incarnation) {
      throw eventStoreError("EVENT_LOCK_OWNERSHIP_UNPROVEN", "Journal lock transition ownership does not match the dead owner", { transition_path: transitionPath });
    }
  }
  if (JSON.stringify(transitionPaths(lock.lockPath).sort()) !== JSON.stringify(expected)) {
    throw eventStoreError("EVENT_LOCK_OWNERSHIP_UNPROVEN", "Journal lock transition set changed during recovery", { lock_path: lock.lockPath });
  }
  assertJournalLockOwned(lock);
  for (const transitionPath of expected) fs.unlinkSync(transitionPath);
  return { removed: expected };
}

function releaseJournalLock(lock, options = {}) {
  const current = inspectJournalLock(lock.journalPath);
  if (!current.exists || !current.metadata || current.metadata.nonce !== lock.metadata.nonce) {
    throw eventStoreError("EVENT_LOCK_OWNERSHIP_LOST", "Journal lock ownership changed before release", { lock_path: lock.lockPath });
  }
  const markerPath = `${lock.lockPath}.transition-${lock.metadata.nonce}`;
  try {
    writeJsonLineFsync(markerPath, {
      transition_version: 2,
      transition_kind: "release",
      owner_nonce: lock.metadata.nonce,
      owner_pid: lock.metadata.owner_pid,
      host_id: lock.metadata.host_id,
      owner_incarnation: lock.metadata.owner_incarnation || currentProcessIncarnation,
      created_at: new Date().toISOString(),
    });
  } catch (error) {
    throw eventStoreError("EVENT_LOCK_RELEASE_FAILED", "Could not create journal lock transition marker", {
      lock_path: lock.lockPath,
      marker_path: markerPath,
      cause_code: error.code || null,
    });
  }

  callHook(options.testHooks, "afterTransitionMarker", { lock, markerPath });
  const rechecked = inspectJournalLock(lock.journalPath);
  if (!rechecked.exists || !rechecked.metadata || rechecked.metadata.nonce !== lock.metadata.nonce) {
    try {
      removeTransitionMarker(markerPath);
    } catch {
      // A remaining owned transition is intentionally fail-closed.
    }
    throw eventStoreError("EVENT_LOCK_OWNERSHIP_LOST", "Journal lock ownership changed before release move", { lock_path: lock.lockPath, marker_path: markerPath });
  }

  const releasePath = `${lock.lockPath}.release-${lock.metadata.nonce}-${crypto.randomBytes(16).toString("hex")}`;
  callHook(options.testHooks, "beforeReleaseMove", { lock, markerPath, releasePath });
  try {
    assertJournalLockOwned(lock);
  } catch (error) {
    try { removeTransitionMarker(markerPath); } catch { /* Retain fail-closed evidence on cleanup failure. */ }
    throw error;
  }
  try {
    fs.renameSync(lock.lockPath, releasePath);
  } catch (error) {
    throw eventStoreError("EVENT_LOCK_RELEASE_FAILED", "Could not move journal lock into release transition", {
      lock_path: lock.lockPath,
      marker_path: markerPath,
      release_path: releasePath,
      cause_code: error.code || null,
    });
  }

  let moved;
  try {
    moved = readMetadata(releasePath);
  } catch (error) {
    throw eventStoreError("EVENT_LOCK_RELEASE_FAILED", "Could not reread moved journal lock metadata", {
      lock_path: lock.lockPath,
      marker_path: markerPath,
      release_path: releasePath,
      cause_code: error.code || null,
    });
  }
  if (!sameLockIdentity(moved, lock.metadata)) {
    throw eventStoreError("EVENT_LOCK_OWNERSHIP_LOST", "Journal lock ownership changed during release move", {
      lock_path: lock.lockPath,
      marker_path: markerPath,
      release_path: releasePath,
      replacement_retained: true,
    });
  }

  callHook(options.testHooks, "beforeDeleteReleaseArtifact", { lock, markerPath, releasePath });
  try {
    fs.unlinkSync(releasePath);
    removeTransitionMarker(markerPath);
  } catch (error) {
    throw eventStoreError("EVENT_LOCK_RELEASE_FAILED", "Could not finish journal lock release", {
      lock_path: lock.lockPath,
      marker_path: markerPath,
      release_path: releasePath,
      cause_code: error.code || null,
    });
  }
  return { released: true };
}

module.exports = {
  DEFAULT_LOCK_TIMEOUT_MS,
  acquireJournalLock,
  armJournalLockGuard,
  assertJournalLockOwned,
  classifyOwner,
  disarmJournalLockGuard,
  inspectJournalLock,
  readMetadata,
  readTransitionMetadata,
  removeDeadJournalLockTransitions,
  releaseJournalLock,
};
