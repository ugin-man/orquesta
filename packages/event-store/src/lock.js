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

function transitionPaths(lockPath) {
  const prefix = `${path.basename(lockPath)}.release-`;
  try {
    return fs.readdirSync(path.dirname(lockPath))
      .filter((entry) => entry.startsWith(prefix))
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
    || !Number.isInteger(metadata.owner_pid) || typeof metadata.host_id !== "string"
    || typeof metadata.nonce !== "string" || typeof metadata.acquired_at !== "string"
    || !Number.isInteger(metadata.target_revision)) {
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

function acquireJournalLock({ journalPath, hostId, targetRevision, timeoutMs = 250 }) {
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
      if (Date.now() >= deadline) {
        throw eventStoreError("EVENT_STALE_LOCK", "Journal lock release transition requires manual repair", { lock_path: lockPath });
      }
      sleep(5);
      continue;
    }
    let descriptor;
    try {
      descriptor = fs.openSync(lockPath, "wx");
      fs.writeFileSync(descriptor, Buffer.from(`${JSON.stringify(metadata)}\n`, "utf8"));
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      return { journalPath, lockPath, metadata };
    } catch (error) {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      if (error.code !== "EEXIST") {
        throw eventStoreError("EVENT_LOCK_ACQUIRE_FAILED", "Could not initialize journal lock", {
          lock_path: lockPath,
          cause_code: error.code || null,
        });
      }
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

function releaseJournalLock(lock) {
  const current = inspectJournalLock(lock.journalPath);
  if (!current.exists || !current.metadata || current.metadata.nonce !== lock.metadata.nonce) {
    throw eventStoreError("EVENT_LOCK_OWNERSHIP_LOST", "Journal lock ownership changed before release", { lock_path: lock.lockPath });
  }
  const transitionPath = `${lock.lockPath}.release-${lock.metadata.nonce}`;
  fs.renameSync(lock.lockPath, transitionPath);
  let transitioned;
  try {
    transitioned = readMetadata(transitionPath);
  } catch (error) {
    throw eventStoreError("EVENT_LOCK_OWNERSHIP_LOST", "Journal lock ownership changed during release", { lock_path: lock.lockPath, transition_path: transitionPath, cause: error.code || null });
  }
  if (transitioned.nonce !== lock.metadata.nonce) {
    throw eventStoreError("EVENT_LOCK_OWNERSHIP_LOST", "Journal lock ownership changed during release", { lock_path: lock.lockPath, transition_path: transitionPath });
  }
  fs.unlinkSync(transitionPath);
  return { released: true };
}

module.exports = { acquireJournalLock, releaseJournalLock, inspectJournalLock };
