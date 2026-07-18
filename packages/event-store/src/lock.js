"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { eventStoreError } = require("./errors");

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
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)
    || !Number.isInteger(metadata.owner_pid) || metadata.owner_pid <= 0
    || typeof metadata.host_id !== "string" || !metadata.host_id.trim()
    || typeof metadata.nonce !== "string" || !metadata.nonce
    || !isUtcTimestamp(metadata.acquired_at)
    || !Number.isInteger(metadata.target_revision) || metadata.target_revision < 0) {
    throw eventStoreError("EVENT_LOCK_INVALID", "Journal lock metadata is invalid", { file_path: filePath });
  }
  return metadata;
}

function inspectJournalLock(journalPath) {
  const lockPath = lockPathFor(journalPath);
  if (!fs.existsSync(lockPath)) return { exists: false, path: lockPath, transitions: transitionPaths(lockPath) };
  try {
    return { exists: true, path: lockPath, metadata: readMetadata(lockPath), transitions: transitionPaths(lockPath) };
  } catch (error) {
    return {
      exists: true,
      path: lockPath,
      metadata: null,
      transitions: transitionPaths(lockPath),
      error: { code: error.code || "EVENT_LOCK_INVALID", message: error.message },
    };
  }
}

function processIsLive(metadata, hostId) {
  if (!metadata || metadata.host_id !== hostId) return false;
  try {
    process.kill(metadata.owner_pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

function callHook(hooks, name, value) {
  if (hooks && typeof hooks[name] === "function") hooks[name](value);
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

function acquireJournalLock({ journalPath, hostId, targetRevision, timeoutMs = 250, testHooks } = {}) {
  const lockPath = lockPathFor(journalPath);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  const metadata = {
    owner_pid: process.pid,
    host_id: hostId,
    nonce: crypto.randomBytes(16).toString("hex"),
    acquired_at: new Date().toISOString(),
    target_revision: targetRevision,
  };

  for (;;) {
    if (transitionPaths(lockPath).length > 0) {
      if (Date.now() >= deadline) throw staleTransitionError(lockPath);
      sleep(5);
      continue;
    }
    callHook(testHooks, "afterTransitionPrecheck", { lockPath, metadata });
    let descriptor;
    try {
      descriptor = fs.openSync(lockPath, "wx");
      fs.writeFileSync(descriptor, Buffer.from(`${JSON.stringify(metadata)}\n`, "utf8"));
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      callHook(testHooks, "afterAcquire", { lockPath, metadata });
      if (transitionPaths(lockPath).length > 0) throw staleTransitionError(lockPath);
      return { journalPath, lockPath, metadata };
    } catch (error) {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      if (error?.code === "EVENT_STALE_LOCK") throw error;
      if (error.code !== "EEXIST") {
        throw eventStoreError("EVENT_LOCK_ACQUIRE_FAILED", "Could not initialize journal lock", {
          lock_path: lockPath,
          cause_code: error.code || null,
        });
      }
      callHook(testHooks, "onContention", { lockPath, metadata });
      if (Date.now() >= deadline) {
        const observed = inspectJournalLock(journalPath);
        if (observed.metadata && processIsLive(observed.metadata, hostId)) {
          throw eventStoreError("EVENT_LOCK_TIMEOUT", "Journal lock is owned by a live local process", { lock_path: lockPath, metadata: observed.metadata });
        }
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

function releaseJournalLock(lock, options = {}) {
  const current = inspectJournalLock(lock.journalPath);
  if (!current.exists || !current.metadata || current.metadata.nonce !== lock.metadata.nonce) {
    throw eventStoreError("EVENT_LOCK_OWNERSHIP_LOST", "Journal lock ownership changed before release", { lock_path: lock.lockPath });
  }
  const markerPath = `${lock.lockPath}.transition-${lock.metadata.nonce}`;
  try {
    writeJsonLineFsync(markerPath, {
      transition_version: 1,
      owner_nonce: lock.metadata.nonce,
      owner_pid: lock.metadata.owner_pid,
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

  const releasePath = `${lock.lockPath}.release-${lock.metadata.nonce}`;
  callHook(options.testHooks, "beforeReleaseMove", { lock, markerPath, releasePath });
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
  if (moved.nonce !== lock.metadata.nonce) {
    let restored = false;
    if (!fs.existsSync(lock.lockPath)) {
      try {
        fs.renameSync(releasePath, lock.lockPath);
        restored = true;
      } catch {
        restored = false;
      }
    }
    if (restored) {
      try {
        removeTransitionMarker(markerPath);
      } catch {
        // A remaining marker blocks later writers rather than hiding a failed transition.
      }
    }
    throw eventStoreError("EVENT_LOCK_OWNERSHIP_LOST", "Journal lock ownership changed during release move", {
      lock_path: lock.lockPath,
      marker_path: markerPath,
      release_path: releasePath,
      replacement_restored: restored,
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

module.exports = { acquireJournalLock, releaseJournalLock, inspectJournalLock };
