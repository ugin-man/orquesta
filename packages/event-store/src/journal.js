"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { canonicalHash, canonicalJson, validateContract } = require("@orquesta/contracts");
const { replaceFileAtomic, unlinkIfPresent } = require("./atomic-replace");
const { acquireJournalLock, releaseJournalLock } = require("./lock");
const { eventStoreError } = require("./errors");

const CRASH_POINTS = [
  "before_pending_write",
  "after_pending_fsync",
  "after_temp_journal_fsync",
  "after_journal_rename",
  "after_journal_verify",
  "after_projection_write",
  "before_pending_delete",
];
const PENDING_FIELDS = [
  "batch_id", "created_at", "expected_revision", "journal_path", "next_sequence",
  "pending_version", "serialized_batch", "sha256", "workspace_id",
];
function isUtcTimestamp(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && !Number.isNaN(new Date(value).getTime()) && new Date(value).toISOString() === value;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function journalError(message, details = {}) {
  return eventStoreError("EVENT_JOURNAL_INVALID", message, details);
}

function pendingVerifyError(message, details = {}) {
  return eventStoreError("EVENT_PENDING_VERIFY_FAILED", message, details);
}

function canonicalFailure(error) {
  return eventStoreError("EVENT_BATCH_INVALID", "Commit request cannot be canonicalized", {
    cause_code: "CANONICALIZATION_FAILED",
    cause_message: error?.message || String(error),
  });
}

function safeCanonicalJson(value) {
  try {
    return canonicalJson(value);
  } catch (error) {
    throw canonicalFailure(error);
  }
}

function sha256Text(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function readJournal(journalPath) {
  if (!fs.existsSync(journalPath)) return { entries: [], text: "" };
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(journalPath));
  } catch (error) {
    throw journalError("Journal is not valid UTF-8", { journal_path: journalPath, cause_code: error.code || null });
  }
  if (text === "") return { entries: [], text };
  if (!text.endsWith("\n")) throw journalError("Journal must end with a newline", { journal_path: journalPath });
  const lines = text.slice(0, -1).split("\n");
  const seenBatches = new Set();
  const seenEvents = new Set();
  const entries = lines.map((line, index) => {
    if (!line) throw journalError("Journal contains a blank line", { journal_path: journalPath, line: index + 1 });
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      throw journalError("Journal contains invalid JSON", { journal_path: journalPath, line: index + 1 });
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || entry.journal_version !== 1 || entry.sequence !== index + 1
      || entry.expected_revision !== index || !isUtcTimestamp(entry.committed_at)) {
      throw journalError("Journal wrapper is invalid", { journal_path: journalPath, line: index + 1 });
    }
    const core = { ...entry };
    delete core.journal_version;
    delete core.committed_at;
    const validation = validateContract("event-batch", core);
    if (!validation.ok) throw journalError("Journal EventBatch is invalid", { journal_path: journalPath, line: index + 1, errors: validation.errors });
    if (seenBatches.has(entry.batch_id)) throw journalError("Journal batch id is duplicated", { journal_path: journalPath, line: index + 1 });
    seenBatches.add(entry.batch_id);
    for (const event of entry.events) {
      if (seenEvents.has(event.event_id)) throw journalError("Journal event id is duplicated", { journal_path: journalPath, line: index + 1 });
      seenEvents.add(event.event_id);
    }
    return entry;
  });
  return { entries, text };
}

function requestIdentity(request) {
  try {
    return canonicalHash({
      expected_revision: request.expected_revision,
      batch_id: request.batch_id,
      actor: request.actor,
      correlation_id: request.correlation_id,
      events: request.events,
    });
  } catch (error) {
    throw canonicalFailure(error);
  }
}

function assertRequestObject(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw eventStoreError("EVENT_BATCH_INVALID", "Commit request must be an EventBatch request object");
  }
}

function validateRequest(request, nextSequence) {
  assertRequestObject(request);
  if (Object.hasOwn(request, "sequence") || Object.hasOwn(request, "journal_version") || Object.hasOwn(request, "committed_at")) {
    throw eventStoreError("EVENT_BATCH_INVALID", "Commit request must contain only EventBatch request fields");
  }
  const core = { ...request, sequence: nextSequence };
  const validation = validateContract("event-batch", core);
  if (!validation.ok) throw eventStoreError("EVENT_BATCH_INVALID", "Commit request does not satisfy EventBatch", { errors: validation.errors });
  const ids = new Set();
  for (const event of request.events) {
    if (ids.has(event.event_id)) throw eventStoreError("EVENT_DUPLICATE_EVENT_ID", "Commit request repeats an event id", { event_id: event.event_id });
    ids.add(event.event_id);
  }
  return core;
}

function pendingPathFor(stateRoot, batchId) {
  const pendingDir = path.join(stateRoot, "pending");
  const filename = `${crypto.createHash("sha256").update(batchId, "utf8").digest("hex")}.json`;
  const pendingPath = path.join(pendingDir, filename);
  if (path.relative(pendingDir, pendingPath).startsWith("..")) throw eventStoreError("EVENT_PENDING_PATH_INVALID", "Pending path escaped its directory");
  return pendingPath;
}

function assertNoUnresolvedPending(stateRoot) {
  const pendingDir = path.join(stateRoot, "pending");
  if (!fs.existsSync(pendingDir)) return;
  const artifacts = fs.readdirSync(pendingDir);
  if (artifacts.length > 0) {
    throw eventStoreError("EVENT_PENDING_RECOVERY_REQUIRED", "Pending journal evidence requires explicit recovery", {
      pending_dir: pendingDir,
      artifacts: artifacts.sort(),
    });
  }
}

function verifyPersistedPending(pendingPath, expected) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(pendingPath));
  } catch (error) {
    throw pendingVerifyError("Pending evidence cannot be reread as strict UTF-8", { pending_path: pendingPath, cause_code: error.code || null });
  }
  if (!text.endsWith("\n") || text.slice(0, -1).includes("\n")) {
    throw pendingVerifyError("Pending evidence must be one JSON line with a final newline", { pending_path: pendingPath });
  }
  let actual;
  try {
    actual = JSON.parse(text.slice(0, -1));
  } catch {
    throw pendingVerifyError("Pending evidence contains invalid JSON", { pending_path: pendingPath });
  }
  if (!isPlainObject(actual) || JSON.stringify(Object.keys(actual).sort()) !== JSON.stringify(PENDING_FIELDS)) {
    throw pendingVerifyError("Pending evidence fields do not match the commit protocol", { pending_path: pendingPath });
  }
  for (const field of PENDING_FIELDS) {
    if (actual[field] !== expected[field]) {
      throw pendingVerifyError("Pending evidence differs from the active commit", { pending_path: pendingPath, field });
    }
  }
  if (actual.pending_version !== 1 || actual.journal_path !== ".orquesta/v4/events.jsonl"
    || !isUtcTimestamp(actual.created_at) || !/^[a-f0-9]{64}$/.test(actual.sha256)
    || sha256Text(actual.serialized_batch) !== actual.sha256) {
    throw pendingVerifyError("Pending evidence has invalid protocol values", { pending_path: pendingPath });
  }
  return actual;
}

function invokeTestFailureInjector(injector, point, controlledFailure) {
  if (!injector) return;
  try {
    injector(point);
  } catch (error) {
    if (error && (typeof error === "object" || typeof error === "function")) {
      controlledFailure.error = error;
      throw error;
    }
    const wrapped = eventStoreError("EVENT_TEST_ABORT", "Test failure injector threw a non-error value", { point });
    controlledFailure.error = wrapped;
    throw wrapped;
  }
}

function removeControlledArtifacts({ pendingPath, journalPath, priorJournalText }) {
  unlinkIfPresent(pendingPath);
  if (priorJournalText === "") unlinkIfPresent(journalPath);
  else replaceFileAtomic(journalPath, priorJournalText);
}

function releaseFailure(lock, error) {
  return eventStoreError("EVENT_LOCK_RELEASE_FAILED", "Journal lock release failed", {
    lock_path: lock.lockPath,
    cause_code: error?.code || null,
    cause_message: error?.message || String(error),
  });
}

function attachReleaseFailure(primary, releaseError) {
  if (!primary || (typeof primary !== "object" && typeof primary !== "function")) return;
  primary.release_failure = {
    code: releaseError.code,
    message: releaseError.message,
    details: releaseError.details,
  };
}

function createEventStore(options = {}) {
  const stateRoot = options.stateRoot;
  if (typeof stateRoot !== "string" || !stateRoot) throw new TypeError("stateRoot is required");
  const journalPath = path.join(stateRoot, "events.jsonl");
  const workspaceId = options.workspaceId || "workspace";
  const hostId = options.hostId || os.hostname();
  const clock = options.clock || (() => new Date().toISOString());
  const project = options.project || (() => undefined);
  const lockTimeoutMs = options.lockTimeoutMs === undefined ? 250 : options.lockTimeoutMs;

  return {
    commit(request) {
      let lock;
      let pendingPath;
      let priorJournalText = "";
      let result;
      let primaryError;
      const controlledFailure = { error: null };
      try {
        assertRequestObject(request);
        validateRequest(request, 0);
        lock = acquireJournalLock({
          journalPath,
          hostId,
          targetRevision: request.expected_revision,
          timeoutMs: lockTimeoutMs,
          testHooks: options.testLockHooks,
        });
        const journal = readJournal(journalPath);
        priorJournalText = journal.text;
        assertNoUnresolvedPending(stateRoot);
        const existing = journal.entries.find((entry) => entry.batch_id === request.batch_id);
        if (existing) {
          if (requestIdentity(existing) !== requestIdentity(request)) {
            throw eventStoreError("EVENT_BATCH_ID_CONFLICT", "Batch id was already committed with different immutable content", { batch_id: request.batch_id });
          }
          result = { status: "idempotent", sequence: existing.sequence };
        } else {
          if (request.expected_revision !== journal.entries.length) {
            throw eventStoreError("EVENT_REVISION_CONFLICT", "Expected revision does not match current journal revision", { expected_revision: request.expected_revision, actual_revision: journal.entries.length });
          }
          const core = validateRequest(request, journal.entries.length + 1);
          const committedEventIds = new Set(journal.entries.flatMap((entry) => entry.events.map((event) => event.event_id)));
          for (const event of request.events) {
            if (committedEventIds.has(event.event_id)) {
              throw eventStoreError("EVENT_DUPLICATE_EVENT_ID", "Event id was already committed", { event_id: event.event_id });
            }
          }

          pendingPath = pendingPathFor(stateRoot, request.batch_id);
          const committedAt = clock();
          if (!isUtcTimestamp(committedAt)) throw eventStoreError("EVENT_CLOCK_INVALID", "Clock must provide a real millisecond UTC timestamp");
          const entry = { journal_version: 1, ...core, committed_at: committedAt };
          const serializedBatch = safeCanonicalJson(entry);
          const pending = {
            pending_version: 1,
            workspace_id: workspaceId,
            journal_path: ".orquesta/v4/events.jsonl",
            batch_id: request.batch_id,
            expected_revision: request.expected_revision,
            next_sequence: entry.sequence,
            serialized_batch: serializedBatch,
            sha256: sha256Text(serializedBatch),
            created_at: committedAt,
          };

          invokeTestFailureInjector(options.testFailureInjector, "before_pending_write", controlledFailure);
          replaceFileAtomic(pendingPath, `${safeCanonicalJson(pending)}\n`);
          invokeTestFailureInjector(options.testFailureInjector, "after_pending_fsync", controlledFailure);
          const nextJournalText = `${journal.text}${serializedBatch}\n`;
          replaceFileAtomic(journalPath, nextJournalText, {
            onAfterTempFsync() {
              invokeTestFailureInjector(options.testFailureInjector, "after_temp_journal_fsync", controlledFailure);
            },
          });
          invokeTestFailureInjector(options.testFailureInjector, "after_journal_rename", controlledFailure);
          const verified = readJournal(journalPath);
          const physicalTail = verified.text.slice(0, -1).split("\n").at(-1);
          const tail = verified.entries.at(-1);
          const persistedPending = verifyPersistedPending(pendingPath, pending);
          if (tail.sequence !== entry.sequence || tail.batch_id !== entry.batch_id || sha256Text(physicalTail) !== persistedPending.sha256) {
            throw eventStoreError("EVENT_JOURNAL_VERIFY_FAILED", "Journal tail did not match the persisted pending evidence", {
              journal_path: journalPath,
              expected_sequence: entry.sequence,
              actual_sequence: tail.sequence,
              expected_batch_id: entry.batch_id,
              actual_batch_id: tail.batch_id,
            });
          }
          invokeTestFailureInjector(options.testFailureInjector, "after_journal_verify", controlledFailure);
          project(entry);
          invokeTestFailureInjector(options.testFailureInjector, "after_projection_write", controlledFailure);
          invokeTestFailureInjector(options.testFailureInjector, "before_pending_delete", controlledFailure);
          unlinkIfPresent(pendingPath);
          result = { status: "committed", sequence: entry.sequence };
        }
      } catch (error) {
        primaryError = error;
        if (controlledFailure.error === error && pendingPath) {
          try {
            removeControlledArtifacts({ pendingPath, journalPath, priorJournalText });
          } catch (cleanupError) {
            primaryError.cleanup_failure = {
              code: cleanupError.code || null,
              message: cleanupError.message,
            };
          }
        }
      }

      if (lock) {
        try {
          releaseJournalLock(lock, { testHooks: options.testLockHooks });
        } catch (error) {
          const structured = releaseFailure(lock, error);
          if (primaryError) attachReleaseFailure(primaryError, structured);
          else primaryError = structured;
        }
      }
      if (primaryError) throw primaryError;
      return result;
    },
  };
}

module.exports = { createEventStore, CRASH_POINTS, readJournal };
