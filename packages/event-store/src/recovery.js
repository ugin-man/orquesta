"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { canonicalJson, validateContract } = require("@orquesta/contracts");
const { eventStoreError } = require("./errors");
const { snapshot, recoveryId } = require("./diagnostics");
const { projectionPath } = require("./projection-store");
const { replaceFileAtomic } = require("./atomic-replace");
const { releaseJournalLock } = require("./lock");
const PENDING_FIELDS = ["batch_id", "created_at", "expected_revision", "journal_path", "next_sequence", "pending_version", "serialized_batch", "sha256", "workspace_id"];

function sha256(value) { return crypto.createHash("sha256").update(value, "utf8").digest("hex"); }
function requestFromEntry(entry) { const request = { ...entry }; delete request.journal_version; delete request.sequence; delete request.committed_at; return request; }
function pendingFiles(stateRoot) { const dir = path.join(stateRoot, "pending"); return fs.existsSync(dir) ? fs.readdirSync(dir).sort().map((name) => path.join(dir, name)) : []; }
function transitions(journalPath) {
  const directory = path.dirname(journalPath); const base = path.basename(`${journalPath}.lock`);
  return fs.existsSync(directory) ? fs.readdirSync(directory).filter((name) => name.startsWith(`${base}.transition-`) || name.startsWith(`${base}.release-`)).sort().map((name) => path.join(directory, name)) : [];
}
function isStrictUtcMillisecond(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}
function parseLock(lockPath, hostId) {
  if (!fs.existsSync(lockPath)) return { exists: false, eligible: false, transitions: [] };
  const markerPaths = transitions(lockPath.slice(0, -5));
  let metadata;
  try { metadata = JSON.parse(fs.readFileSync(lockPath, "utf8")); } catch { return { exists: true, eligible: false, reason: "invalid_metadata", transitions: markerPaths }; }
  const valid = metadata && Number.isInteger(metadata.owner_pid) && metadata.owner_pid > 0 && typeof metadata.host_id === "string" && metadata.host_id && /^[a-f0-9]{32}$/u.test(metadata.nonce || "") && isStrictUtcMillisecond(metadata.acquired_at) && Number.isInteger(metadata.target_revision) && metadata.target_revision >= 0;
  if (!valid) return { exists: true, eligible: false, reason: "invalid_metadata", metadata, transitions: markerPaths };
  if (markerPaths.length) return { exists: true, eligible: false, reason: "transition_present", metadata, transitions: markerPaths };
  if (metadata.host_id !== hostId) return { exists: true, eligible: false, reason: "host_unproven", metadata, transitions: markerPaths };
  try { process.kill(metadata.owner_pid, 0); return { exists: true, eligible: false, reason: "owner_live", metadata, transitions: markerPaths }; } catch (error) {
    if (error.code !== "ESRCH") return { exists: true, eligible: false, reason: "owner_unproven", metadata, transitions: markerPaths };
  }
  return { exists: true, eligible: true, reason: "dead_local_owner", metadata, transitions: markerPaths };
}
function finalizeLockEligibility(lock, currentRevision, pending) {
  if (!lock.exists || !lock.eligible) return lock;
  if (lock.metadata.target_revision === currentRevision) return lock;
  const journaledPending = currentRevision === lock.metadata.target_revision + 1
    && pending.kind === "finalize_pending_commit"
    && pending.pending.expected_revision === lock.metadata.target_revision
    && pending.pending.next_sequence === currentRevision;
  if (journaledPending) return { ...lock, reason: "dead_local_owner_journaled_pending" };
  return { ...lock, eligible: false, reason: "target_revision_mismatch" };
}
function diagnoseJournal(journalPath, readJournal) {
  try { const journal = readJournal(journalPath); return { valid: true, journal, last_valid_sequence: journal.entries.length, corruption_line: null }; } catch (error) {
    let text = "";
    try { text = fs.readFileSync(journalPath, "utf8"); } catch { return { valid: false, journal: null, last_valid_sequence: 0, corruption_line: 1, error: error.code || "EVENT_JOURNAL_INVALID" }; }
    const strictFailureLine = Number.isInteger(error?.details?.line) ? error.details.line : null;
    if (strictFailureLine) return { valid: false, journal: null, last_valid_sequence: Math.max(0, strictFailureLine - 1), corruption_line: strictFailureLine, error: error.code || "EVENT_JOURNAL_INVALID" };
    const hasFinalNewline = text.endsWith("\n"); const lines = text.split("\n");
    lines.pop();
    let last = 0;
    for (let index = 0; index < lines.length; index += 1) {
      try {
        const entry = JSON.parse(lines[index]);
        if (!entry || entry.sequence !== index + 1 || entry.expected_revision !== index) throw new Error("invalid journal wrapper");
        last = index + 1;
      } catch { return { valid: false, journal: null, last_valid_sequence: last, corruption_line: index + 1, error: error.code || "EVENT_JOURNAL_INVALID" }; }
    }
    return { valid: false, journal: null, last_valid_sequence: last, corruption_line: hasFinalNewline ? Math.max(1, lines.length) : lines.length + 1, error: error.code || "EVENT_JOURNAL_INVALID" };
  }
}
function readBackup(journalPath, readJournal) {
  const backupPath = `${journalPath}.bak`;
  if (!fs.existsSync(backupPath)) return null;
  try { return readJournal(backupPath); } catch { return null; }
}
function backupMatchesBrokenJournal(journalPath, backup, pending) {
  if (!backup || !pending?.pending || !fs.existsSync(journalPath)) return false;
  try {
    const broken = fs.readFileSync(journalPath);
    const backupBytes = Buffer.from(backup.text, "utf8"); const serialized = Buffer.from(pending.pending.serialized_batch, "utf8");
    if (broken.length <= backupBytes.length || !broken.subarray(0, backupBytes.length).equals(backupBytes)) return false;
    const suffix = broken.subarray(backupBytes.length);
    return suffix.length > 0 && suffix.length <= serialized.length && serialized.subarray(0, suffix.length).equals(suffix);
  } catch { return false; }
}
function matchingQuarantineJournals(stateRoot, backup, pending) {
  const directory = path.join(stateRoot, "quarantine");
  if (!fs.existsSync(directory) || !backup || !pending?.pending) return [];
  const expected = Buffer.concat([Buffer.from(backup.text, "utf8"), Buffer.from(pending.pending.serialized_batch, "utf8"), Buffer.from("\n", "utf8")]);
  return fs.readdirSync(directory).filter((name) => /^events-[a-f0-9]{64}\.jsonl$/u.test(name)).sort().map((name) => path.join(directory, name)).filter((target) => {
    try {
      const bytes = fs.readFileSync(target);
      return bytes.length > Buffer.byteLength(backup.text, "utf8") && bytes.length < expected.length && expected.subarray(0, bytes.length).equals(bytes);
    } catch { return false; }
  });
}
function bytesHash(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function conflictDirectory(stateRoot) { return path.join(stateRoot, "quarantine"); }
function conflictManifestPath(stateRoot, id) { return path.join(conflictDirectory(stateRoot), `conflict-${id}.json`); }
const CONFLICT_FIELDS = ["conflict_version", "id", "journal_sha256", "pending_name", "pending_sha256", "required_user_decision", "status"];
function conflictArtifactPaths(stateRoot, journalPath, value) {
  const directory = conflictDirectory(stateRoot);
  return {
    journal: {
      canonical_path: journalPath,
      transition_path: `${journalPath}.conflict-${value.id}`,
      quarantine_path: path.join(directory, `events-${value.journal_sha256}.jsonl`),
      sha256: value.journal_sha256,
    },
    pending: {
      canonical_path: path.join(stateRoot, "pending", value.pending_name),
      transition_path: path.join(stateRoot, "pending", `${value.pending_name}.conflict-${value.id}`),
      quarantine_path: path.join(directory, `pending-${value.pending_sha256}.json`),
      sha256: value.pending_sha256,
    },
  };
}
function strictConflictManifest(stateRoot, journalPath, manifestPath, value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(CONFLICT_FIELDS)) throw new Error("invalid fields");
  if (value.conflict_version !== 1 || value.status !== "in_progress" && value.status !== "user_decision" || value.required_user_decision !== "user_decision") throw new Error("invalid metadata");
  if (!/^[a-f0-9]{64}$/u.test(value.id) || !/^[a-f0-9]{64}$/u.test(value.journal_sha256) || !/^[a-f0-9]{64}$/u.test(value.pending_sha256) || !/^[a-f0-9]{64}\.json$/u.test(value.pending_name)) throw new Error("invalid identifiers");
  if (path.resolve(manifestPath) !== path.resolve(conflictManifestPath(stateRoot, value.id))) throw new Error("manifest path mismatch");
  const artifacts = conflictArtifactPaths(stateRoot, journalPath, value);
  if (sha256(`${value.journal_sha256}:${value.pending_sha256}`) !== value.id) throw new Error("manifest evidence mismatch");
  return { manifestPath, value, ...artifacts };
}
function readConflictManifests(stateRoot, journalPath) {
  const directory = conflictDirectory(stateRoot);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter((name) => /^conflict-[a-f0-9]{64}\.json$/u.test(name)).sort().map((name) => {
    const manifestPath = path.join(directory, name);
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(manifestPath));
      if (!text.endsWith("\n") || text.slice(0, -1).includes("\n")) throw new Error("manifest JSON line shape");
      return strictConflictManifest(stateRoot, journalPath, manifestPath, JSON.parse(text.slice(0, -1)));
    } catch {
      return { manifestPath, value: null };
    }
  });
}
function bytesEqualAt(filePath, expected) {
  try { return fs.readFileSync(filePath).equals(expected); } catch { return false; }
}
function conflictProgress(manifest) {
  if (!manifest?.value) return "invalid";
  const { journal, pending, value } = manifest;
  const evidence = (item) => {
    try { const bytes = fs.readFileSync(item.quarantine_path); return bytesHash(bytes) === item.sha256 ? bytes : null; } catch { return null; }
  };
  const journalBytes = evidence(journal); const pendingBytes = evidence(pending);
  if (!journalBytes || !pendingBytes) return "invalid";
  const stateAt = (filePath, expected) => {
    if (!fs.existsSync(filePath)) return "absent";
    return bytesEqualAt(filePath, expected) ? "exact" : "replacement";
  };
  const states = [journal, pending].map((item, index) => ({
    canonical: stateAt(item.canonical_path, index === 0 ? journalBytes : pendingBytes),
    transition: stateAt(item.transition_path, index === 0 ? journalBytes : pendingBytes),
  }));
  if (value.status === "user_decision") {
    if (states.some((state) => state.transition !== "absent" || state.canonical === "exact")) return "completed_artifacts_present";
    return "complete";
  }
  if (states.some((state) => state.canonical === "replacement" || state.transition === "replacement")) return "replacement";
  if (states.some((state) => state.canonical === "exact" && state.transition === "exact")) return "invalid";
  return states.every((state) => state.canonical === "absent" && state.transition === "absent") ? "ready" : "incomplete";
}
function writeVerifiedEvidence(target, bytes) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) {
    if (!bytesEqualAt(target, bytes)) throw eventStoreError("RECOVERY_CONFLICT_VERIFY_FAILED", "Existing quarantine evidence differs from the conflict artifact", { path: target });
    return;
  }
  let descriptor;
  try {
    descriptor = fs.openSync(target, "wx"); fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor);
  } catch (error) {
    throw eventStoreError("RECOVERY_CONFLICT_QUARANTINE_FAILED", "Could not create quarantine evidence", { path: target, cause_code: error.code || null });
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  if (!bytesEqualAt(target, bytes)) throw eventStoreError("RECOVERY_CONFLICT_VERIFY_FAILED", "Quarantine evidence reread differs from the conflict artifact", { path: target });
}
function manifestForConflict(stateRoot, journalPath, pendingPath, journalBytes, pendingBytes) {
  const journalHash = bytesHash(journalBytes); const pendingHash = bytesHash(pendingBytes); const id = sha256(`${journalHash}:${pendingHash}`);
  const manifestPath = conflictManifestPath(stateRoot, id);
  const value = {
    conflict_version: 1,
    id,
    required_user_decision: "user_decision",
    status: "in_progress",
    journal_sha256: journalHash,
    pending_name: path.basename(pendingPath),
    pending_sha256: pendingHash,
  };
  return { manifestPath, value, bytes: Buffer.from(`${canonicalJson(value)}\n`, "utf8"), ...conflictArtifactPaths(stateRoot, journalPath, value) };
}
function expectedArtifactHash(inspection, target) {
  return inspection.artifacts.find((artifact) => artifact.path === target)?.sha256 || null;
}
function createConflictManifest(stateRoot, journalPath, inspection) {
  const manifests = readConflictManifests(stateRoot, journalPath);
  if (manifests.length === 1 && manifests[0].value) return manifests[0];
  if (manifests.length) throw eventStoreError("RECOVERY_CONFLICT_VERIFY_FAILED", "Conflict manifest state is ambiguous", { manifests: manifests.map((item) => item.manifestPath) });
  const [pendingPath] = pendingFiles(stateRoot);
  if (!pendingPath || !fs.existsSync(journalPath)) throw eventStoreError("RECOVERY_CONFLICT_VERIFY_FAILED", "Conflict artifacts disappeared before quarantine", { journal_path: journalPath, pending_path: pendingPath || null });
  const journalBytes = fs.readFileSync(journalPath); const pendingBytes = fs.readFileSync(pendingPath);
  if (expectedArtifactHash(inspection, journalPath) !== bytesHash(journalBytes) || expectedArtifactHash(inspection, pendingPath) !== bytesHash(pendingBytes)) {
    throw eventStoreError("RECOVERY_STATE_CHANGED", "Conflict artifacts changed after inspection");
  }
  const manifest = manifestForConflict(stateRoot, journalPath, pendingPath, journalBytes, pendingBytes);
  writeVerifiedEvidence(manifest.journal.quarantine_path, journalBytes);
  writeVerifiedEvidence(manifest.pending.quarantine_path, pendingBytes);
  writeVerifiedEvidence(manifest.manifestPath, manifest.bytes);
  return strictConflictManifest(stateRoot, journalPath, manifest.manifestPath, manifest.value);
}
function completeConflictManifest(manifest, hooks) {
  if (hooks?.beforeConflictManifestComplete) hooks.beforeConflictManifestComplete({ manifest });
  const completed = { ...manifest.value, status: "user_decision" };
  replaceFileAtomic(manifest.manifestPath, `${canonicalJson(completed)}\n`);
  const verified = readConflictManifests(path.dirname(path.dirname(manifest.manifestPath)), manifest.journal.canonical_path);
  const same = verified.find((item) => item.manifestPath === manifest.manifestPath);
  if (!same?.value || same.value.status !== "user_decision") throw eventStoreError("RECOVERY_CONFLICT_VERIFY_FAILED", "Conflict completion manifest was not atomically verified", { manifest_path: manifest.manifestPath });
  return same;
}
function transitionConflictArtifact(item, hooks, beforeHookName, afterHookName) {
  let expected;
  try { expected = fs.readFileSync(item.quarantine_path); } catch (error) { throw eventStoreError("RECOVERY_CONFLICT_VERIFY_FAILED", "Conflict quarantine evidence could not be reread", { path: item.quarantine_path, cause_code: error.code || null }); }
  if (bytesHash(expected) !== item.sha256) throw eventStoreError("RECOVERY_CONFLICT_VERIFY_FAILED", "Conflict quarantine evidence hash changed", { path: item.quarantine_path });
  if (hooks?.[beforeHookName]) hooks[beforeHookName]({ item });
  if (fs.existsSync(item.canonical_path)) {
    if (!bytesEqualAt(item.canonical_path, expected)) throw eventStoreError("RECOVERY_CONFLICT_VERIFY_FAILED", "Canonical conflict artifact changed before quarantine move", { path: item.canonical_path });
    try { fs.renameSync(item.canonical_path, item.transition_path); } catch (error) { throw eventStoreError("RECOVERY_CONFLICT_QUARANTINE_FAILED", "Could not move canonical conflict artifact", { path: item.canonical_path, transition_path: item.transition_path, cause_code: error.code || null }); }
    if (!bytesEqualAt(item.transition_path, expected)) {
      if (!fs.existsSync(item.canonical_path)) {
        try { fs.renameSync(item.transition_path, item.canonical_path); } catch { /* The transition remains blocking evidence. */ }
      }
      throw eventStoreError("RECOVERY_CONFLICT_VERIFY_FAILED", "Conflict transition differs from verified evidence", { path: item.canonical_path, transition_path: item.transition_path });
    }
    if (hooks?.[afterHookName]) hooks[afterHookName]({ item });
  }
  if (fs.existsSync(item.transition_path)) {
    if (!bytesEqualAt(item.transition_path, expected)) throw eventStoreError("RECOVERY_CONFLICT_VERIFY_FAILED", "Conflict transition changed before completion", { transition_path: item.transition_path });
    try { fs.unlinkSync(item.transition_path); } catch (error) { throw eventStoreError("RECOVERY_CONFLICT_QUARANTINE_FAILED", "Could not remove verified conflict transition", { transition_path: item.transition_path, cause_code: error.code || null }); }
  } else if (fs.existsSync(item.canonical_path)) {
    throw eventStoreError("RECOVERY_CONFLICT_QUARANTINE_FAILED", "Canonical conflict artifact remains after transition", { path: item.canonical_path });
  }
}
function readPending(pendingPaths, lastValid, journal, workspaceId) {
  if (!pendingPaths.length) return { kind: "none" };
  if (pendingPaths.length !== 1) return { kind: "blocked_pending", reason: "multiple_pending" };
  const pendingPath = pendingPaths[0]; let pending; let entry;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(pendingPath));
    if (!text.endsWith("\n") || text.slice(0, -1).includes("\n")) throw new Error("pending JSON line shape");
    pending = JSON.parse(text.slice(0, -1)); entry = JSON.parse(pending.serialized_batch);
  } catch { return { kind: "blocked_pending", reason: "invalid_pending", pendingPath }; }
  const batchId = typeof pending?.batch_id === "string" ? pending.batch_id : null;
  const expectedName = batchId ? `${crypto.createHash("sha256").update(batchId, "utf8").digest("hex")}.json` : null;
  const wrapperFields = pending && typeof pending === "object" && !Array.isArray(pending) && JSON.stringify(Object.keys(pending).sort()) === JSON.stringify(PENDING_FIELDS);
  const entryCore = entry && typeof entry === "object" ? { ...entry } : null;
  if (entryCore) { delete entryCore.journal_version; delete entryCore.committed_at; }
  const shapeValid = wrapperFields && pending.pending_version === 1 && pending.workspace_id === workspaceId && pending.journal_path === ".orquesta/v4/events.jsonl" && batchId !== null && typeof pending.serialized_batch === "string" && /^[a-f0-9]{64}$/u.test(pending.sha256 || "") && path.basename(pendingPath) === expectedName && entry && entry.journal_version === 1 && isStrictUtcMillisecond(pending.created_at) && pending.created_at === entry.committed_at && validateContract("event-batch", entryCore).ok && entry.batch_id === pending.batch_id && entry.expected_revision === pending.expected_revision && entry.sequence === pending.next_sequence;
  if (!shapeValid) return { kind: "blocked_pending", reason: "pending_mismatch", pendingPath, pending, entry };
  const existing = journal?.entries.find((item) => item.batch_id === pending.batch_id);
  const hashValid = /^[a-f0-9]{64}$/.test(pending.sha256 || "") && pending.sha256 === sha256(pending.serialized_batch);
  if (existing && !hashValid) return { kind: "blocked_conflict", reason: "pending_journal_hash_mismatch", pendingPath, pending, entry };
  if (!hashValid) return { kind: "blocked_pending", reason: "pending_hash_mismatch", pendingPath, pending, entry };
  if (!existing) {
    if (pending.expected_revision !== lastValid || entry.sequence !== lastValid + 1) return { kind: "blocked_pending", reason: "pending_revision_mismatch", pendingPath, pending, entry };
    return { kind: "retry_pending_commit", pendingPath, pending, entry };
  }
  if (entry.sequence !== existing.sequence || pending.expected_revision !== existing.sequence - 1) return { kind: "blocked_pending", reason: "pending_revision_mismatch", pendingPath, pending, entry };
  const physical = journal.text.slice(0, -1).split("\n").find((line) => JSON.parse(line).batch_id === pending.batch_id);
  if (!physical || sha256(physical) !== pending.sha256) return { kind: "blocked_conflict", reason: "pending_journal_hash_mismatch", pendingPath, pending, entry };
  return { kind: "finalize_pending_commit", pendingPath, pending, entry };
}
function recoverySummary(stateRoot, journalPath, diagnosis, lock) {
  const projection = projectionPath(stateRoot); const quarantine = path.join(stateRoot, "quarantine");
  return {
    journal: { exists: fs.existsSync(journalPath), sequence: diagnosis.last_valid_sequence, valid: diagnosis.valid },
    projection: { exists: fs.existsSync(projection) },
    pending: { count: pendingFiles(stateRoot).length },
    lock: { exists: lock.exists, eligible_for_explicit_release: Boolean(lock.eligible), reason: lock.reason || null },
    quarantine: { paths: fs.existsSync(quarantine) ? fs.readdirSync(quarantine).sort().map((name) => path.join(quarantine, name)) : [] },
  };
}
function inspect({ stateRoot, journalPath, readJournal, replay, hostId, workspaceId }) {
  const projection = projectionPath(stateRoot); const artifacts = snapshot(stateRoot, journalPath, projection); const id = recoveryId(artifacts); const diagnosis = diagnoseJournal(journalPath, readJournal); let lock = parseLock(`${journalPath}.lock`, hostId); const conflictPaths = fs.existsSync(stateRoot) ? fs.readdirSync(stateRoot).filter((name) => /conflicted copy/i.test(name)).sort().map((name) => path.join(stateRoot, name)) : [];
  const pendingPaths = pendingFiles(stateRoot); let pending = readPending(pendingPaths, diagnosis.last_valid_sequence, diagnosis.journal, workspaceId);
  const manifests = readConflictManifests(stateRoot, journalPath); const manifest = manifests.length === 1 ? manifests[0] : null;
  let action = "none"; let required = null; let quarantinePaths = []; let conflictReason = null;
  const resumeBackup = !fs.existsSync(journalPath) ? readBackup(journalPath, readJournal) : null;
  lock = finalizeLockEligibility(lock, diagnosis.last_valid_sequence, pending);
  const resumeQuarantine = !fs.existsSync(journalPath) && resumeBackup ? matchingQuarantineJournals(stateRoot, resumeBackup, readPending(pendingPaths, resumeBackup.entries.length, null, workspaceId)) : [];
  if (conflictPaths.length) { action = "blocked_conflict"; required = "user_decision"; }
  else if (manifest?.value) {
    const progress = conflictProgress(manifest);
    action = progress === "incomplete" || progress === "ready" ? "quarantine_conflict" : "blocked_conflict";
    if (progress !== "complete" && progress !== "incomplete") conflictReason = progress;
    required = "user_decision";
    quarantinePaths = [manifest.journal.quarantine_path, manifest.pending.quarantine_path, manifest.manifestPath];
  } else if (manifests.length > 1 || (manifests.length === 1 && !manifests[0].value)) { action = "blocked_conflict"; required = "user_decision"; }
  else if (lock.exists) { action = lock.eligible ? "stale_lock" : "blocked_lock"; required = lock.eligible ? "explicit_lock_recovery" : "manual_lock_repair"; }
  else if (!fs.existsSync(journalPath) && (resumeBackup || resumeQuarantine.length)) {
    const backup = resumeBackup; const quarantined = resumeQuarantine; const backupPending = backup ? readPending(pendingPaths, backup.entries.length, null, workspaceId) : { kind: "none" };
    if (quarantined.length === 1 && backup && backupPending.kind === "retry_pending_commit" && backup.entries.length === backupPending.pending.expected_revision) { action = "restore_backup_retry"; required = "explicit_recovery"; quarantinePaths = quarantined; }
    else if (backupPending.kind === "blocked_pending") { action = "blocked_pending"; required = "manual_pending_repair"; }
    else { action = "blocked_corruption"; required = "manual_recovery"; }
  } else if (!diagnosis.valid) {
    const backup = readBackup(journalPath, readJournal);
    if (backup) pending = readPending(pendingPaths, backup.entries.length, null, workspaceId);
    if (pending.kind === "retry_pending_commit" && backup && backup.entries.length === pending.pending.expected_revision && backupMatchesBrokenJournal(journalPath, backup, pending)) { action = "restore_backup_retry"; required = "explicit_recovery"; quarantinePaths = [path.join(stateRoot, "quarantine", `events-${id}.jsonl`)]; }
    else if (pending.kind === "blocked_pending") { action = "blocked_pending"; required = "manual_pending_repair"; quarantinePaths = [path.join(stateRoot, "quarantine", `pending-${id}.json`)]; }
    else { action = "blocked_corruption"; required = "manual_recovery"; quarantinePaths = [path.join(stateRoot, "quarantine", `events-${id}.jsonl`)]; }
  } else if (pending.kind !== "none") {
    action = pending.kind === "blocked_conflict" && pending.reason === "pending_journal_hash_mismatch" ? "quarantine_conflict" : pending.kind; required = pending.kind === "blocked_pending" ? "manual_pending_repair" : pending.kind === "blocked_conflict" ? "user_decision" : "explicit_recovery";
    if (pending.kind === "blocked_pending") quarantinePaths = [path.join(stateRoot, "quarantine", `pending-${id}.json`)];
    if (pending.kind === "blocked_conflict") quarantinePaths = [path.join(stateRoot, "quarantine", `events-${id}.jsonl`), path.join(stateRoot, "quarantine", `pending-${id}.json`)];
  } else {
    try {
      const data = fs.existsSync(projection) ? JSON.parse(fs.readFileSync(projection, "utf8")) : null; const expected = replay();
      if (!data || data.projection_version !== 1 || data.journal_sequence !== expected.watermark.journal_sequence || data.last_batch_id !== expected.watermark.last_batch_id || data.journal_hash !== expected.watermark.journal_hash || canonicalJson(data.data) !== canonicalJson(expected.state)) action = "rebuild_projection";
    } catch { action = "rebuild_projection"; }
  }
  const conflicts = conflictPaths.map((target) => { const stat = fs.statSync(target); return { path: target, size: stat.size, mtime_ms: stat.mtimeMs, sha256: crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex") }; });
  return { recovery_id: id, action, last_valid_sequence: diagnosis.last_valid_sequence, quarantine_paths: quarantinePaths, required_user_decision: required, artifacts, conflicts, diagnostics: { corruption_line: diagnosis.corruption_line, journal_error: diagnosis.error || null, pending_reason: pending.reason || null, lock_reason: lock.reason || null, conflict_reason: conflictReason }, summary: recoverySummary(stateRoot, journalPath, diagnosis, lock) };
}
function apply({ inspection, input, stateRoot, journalPath, readJournal, replay, rebuild, retry, hostId, workspaceId, hooks }) {
  if (!input?.operator || input.operator.type !== "local_operator" || input.operator.id !== "explicit-recovery-command") throw eventStoreError("RECOVERY_OPERATOR_INVALID", "Recovery requires the fixed local operator");
  const current = inspect({ stateRoot, journalPath, readJournal, replay, hostId, workspaceId });
  if (input.recoveryId !== inspection.recovery_id || current.recovery_id !== inspection.recovery_id) throw eventStoreError("RECOVERY_STATE_CHANGED", "Recovery artifacts changed after inspection");
  if (input.action !== inspection.action || input.action !== current.action) throw eventStoreError("RECOVERY_ACTION_MISMATCH", "Recovery action does not match the current inspection", { expected_action: current.action, requested_action: input.action });
  const result = (status, extra = {}) => ({ status, ...extra, summary: inspect({ stateRoot, journalPath, readJournal, replay, hostId, workspaceId }).summary });
  if (input.action === "blocked_lock") throw eventStoreError("RECOVERY_LOCK_NOT_ELIGIBLE", "Lock ownership is not safe to release", { reason: current.diagnostics.lock_reason });
  if (input.action === "blocked_pending") throw eventStoreError("RECOVERY_PENDING_INVALID", "Pending evidence is not safe to retry", { reason: current.diagnostics.pending_reason });
  if (["blocked_conflict", "blocked_corruption", "none"].includes(input.action)) throw eventStoreError("RECOVERY_ACTION_BLOCKED", "Recovery action is not safe in Phase 1", { action: input.action });
  if (input.action === "quarantine_conflict") {
    const manifest = createConflictManifest(stateRoot, journalPath, current);
    const progress = conflictProgress(manifest);
    if (progress === "invalid" || progress === "replacement") throw eventStoreError("RECOVERY_CONFLICT_VERIFY_FAILED", "Conflict quarantine evidence is invalid or was replaced", { manifest_path: manifest.manifestPath, progress });
    if (progress === "incomplete") {
      transitionConflictArtifact(manifest.journal, hooks, "beforeConflictJournalMove", "afterConflictJournalTransition");
      transitionConflictArtifact(manifest.pending, hooks, "beforeConflictPendingMove", "afterConflictPendingTransition");
    }
    const completed = conflictProgress(manifest);
    if (completed !== "ready") throw eventStoreError("RECOVERY_CONFLICT_VERIFY_FAILED", "Conflict quarantine transition did not finish safely", { manifest_path: manifest.manifestPath, progress: completed });
    completeConflictManifest(manifest, hooks);
    const after = inspect({ stateRoot, journalPath, readJournal, replay, hostId, workspaceId });
    if (after.action !== "blocked_conflict" || after.required_user_decision !== "user_decision") throw eventStoreError("RECOVERY_CONFLICT_VERIFY_FAILED", "Conflict quarantine did not leave a durable user-decision blocker", { manifest_path: manifest.manifestPath });
    return { status: "conflict_quarantined", quarantine_paths: after.quarantine_paths, summary: after.summary };
  }
  if (input.action === "stale_lock") {
    if (current.action !== "stale_lock") throw eventStoreError("RECOVERY_LOCK_NOT_ELIGIBLE", "Lock ownership is not safe to release");
    let journal;
    try { journal = readJournal(journalPath); } catch { throw eventStoreError("RECOVERY_LOCK_NOT_ELIGIBLE", "Journal state is not safe to release a stale lock"); }
    const pending = readPending(pendingFiles(stateRoot), journal.entries.length, journal, workspaceId);
    const lock = finalizeLockEligibility(parseLock(`${journalPath}.lock`, hostId), journal.entries.length, pending);
    if (!lock.eligible || !lock.metadata) throw eventStoreError("RECOVERY_LOCK_NOT_ELIGIBLE", "Lock ownership is not safe to release", { reason: lock.reason || null });
    releaseJournalLock({ journalPath, lockPath: `${journalPath}.lock`, metadata: lock.metadata }, { testHooks: hooks });
    const after = inspect({ stateRoot, journalPath, readJournal, replay, hostId, workspaceId });
    return { status: "lock_released", next_action: after.action, summary: after.summary };
  }
  if (input.action === "rebuild_projection") return result("projection_rebuilt", rebuild());
  if (input.action === "finalize_pending_commit") {
    const pendingPath = pendingFiles(stateRoot)[0]; const pending = readPending([pendingPath], current.last_valid_sequence, readJournal(journalPath), workspaceId); const retried = retry(requestFromEntry(pending.entry), pendingPath); return result("pending_committed_rebuilt", { retried });
  }
  if (input.action === "restore_backup_retry") {
    const pendingPath = pendingFiles(stateRoot)[0]; const copyPath = inspection.quarantine_paths[0];
    if (fs.existsSync(journalPath)) {
      const broken = fs.readFileSync(journalPath); fs.mkdirSync(path.dirname(copyPath), { recursive: true }); fs.writeFileSync(copyPath, broken);
      if (!fs.readFileSync(copyPath).equals(broken) || sha256(broken) !== crypto.createHash("sha256").update(fs.readFileSync(copyPath)).digest("hex")) throw eventStoreError("RECOVERY_QUARANTINE_VERIFY_FAILED", "Quarantine copy verification failed");
      try { if (hooks?.beforeQuarantineMove) hooks.beforeQuarantineMove({ journalPath, copyPath }); fs.renameSync(journalPath, copyPath); } catch (error) { throw eventStoreError("RECOVERY_QUARANTINE_MOVE_FAILED", "Could not move the broken journal after verified quarantine", { journal_path: journalPath, quarantine_path: copyPath, cause_code: error.code || null }); }
      if (hooks?.afterQuarantineMove) hooks.afterQuarantineMove({ journalPath, copyPath });
    }
    const backup = fs.readFileSync(`${journalPath}.bak`); replaceFileAtomic(journalPath, backup.toString("utf8")); if (!fs.readFileSync(journalPath).equals(backup)) throw eventStoreError("RECOVERY_BACKUP_VERIFY_FAILED", "Restored backup bytes did not match");
    const after = inspect({ stateRoot, journalPath, readJournal, replay, hostId, workspaceId }); return apply({ inspection: after, input: { ...input, recoveryId: after.recovery_id, action: after.action }, stateRoot, journalPath, readJournal, replay, rebuild, retry, hostId, workspaceId, hooks });
  }
  if (input.action === "retry_pending_commit") {
    const pendingPath = pendingFiles(stateRoot)[0]; const pending = readPending([pendingPath], current.last_valid_sequence, readJournal(journalPath), workspaceId); const retried = retry(requestFromEntry(pending.entry), pendingPath); return result(retried.status, { sequence: retried.sequence, retried });
  }
  throw eventStoreError("RECOVERY_ACTION_BLOCKED", "Recovery action is not safe in Phase 1", { action: input.action });
}

module.exports = { inspect, apply };
