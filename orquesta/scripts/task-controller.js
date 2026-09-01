#!/usr/bin/env node

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const {
  appendJsonlAtomic,
  readJsonFile,
  updateTextAtomic,
  updateJsonAtomic,
  writeTextAtomic,
} = require("./json-state");

const HASH = /^[a-f0-9]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const MAX_PACKET_BYTES = 1024 * 1024;
const MAX_EVIDENCE_BYTES = 64 * 1024 * 1024;
const MAX_EVIDENCE = 64;
const EDITABLE_TASK_STATES = new Set(["working", "in_progress"]);
const PROGRESS_CYCLE_STATES = new Set(["in_progress", "completed"]);
const CANONICAL_CYCLE_STATES = new Set(["in_progress", "completed", "accepted"]);
const STRUCTURED_EVIDENCE_EXTENSIONS = new Set([".json"]);
const PROGRESS_PACKET_DIRECTORY = [".orquesta", "state", "task-progress-packets"];
const CLI_USAGE = [
  "usage: task-controller.js inspect --state-root <root> --task-id <task-id>",
  "       task-controller.js progress --state-root <root> --packet <relative-json> --packet-sha256 <sha256>",
  "       task-controller.js accept --state-root <root> --packet <relative-json> --packet-sha256 <sha256>",
].join("\n");

class TaskControllerError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "TaskControllerError";
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new TaskControllerError(code, message, cause === undefined ? undefined : { cause });
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${stableJson(value[key])}`
  )).join(",")}}`;
}

function taskSnapshotSha256(task) {
  return sha256(Buffer.from(stableJson(task), "utf8"));
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("TASK_CONTROL_PACKET_INVALID", `${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail("TASK_CONTROL_PACKET_INVALID", `${label} must contain exactly: ${wanted.join(", ")}`);
  }
}

function nonemptyText(value, label, maximum = 4096) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    fail("TASK_CONTROL_PACKET_INVALID", `${label} must be nonempty and at most ${maximum} characters`);
  }
  return value.trim();
}

function identifier(value, label) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    fail("TASK_CONTROL_PACKET_INVALID", `${label} is invalid`);
  }
  return value;
}

function hash(value, label) {
  if (typeof value !== "string" || !HASH.test(value)) {
    fail("TASK_CONTROL_PACKET_INVALID", `${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function canonicalTimestamp(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    fail("TASK_CONTROL_PACKET_INVALID", `${label} must be an ISO timestamp`);
  }
  const canonical = new Date(value).toISOString();
  if (canonical !== value) {
    fail("TASK_CONTROL_PACKET_INVALID", `${label} must use canonical UTC millisecond form`);
  }
  return value;
}

function canonicalStateTimestamp(value, label) {
  const match = typeof value === "string"
    && /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(?:Z|[+-]\d{2}:\d{2})$/u.exec(value);
  const wallTime = match && `${match[1]}.${(match[2] || "").padEnd(3, "0").slice(0, 3)}Z`;
  if (!match || !Number.isFinite(Date.parse(value)) || !Number.isFinite(Date.parse(wallTime))
      || new Date(wallTime).toISOString() !== wallTime) {
    fail("TASK_CONTROL_STATE_UNSUPPORTED", `${label} must be a valid ISO timestamp`);
  }
  return value;
}

function latestTimestamp(left, right) {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function trustedRoot(rootPath) {
  if (typeof rootPath !== "string" || !path.isAbsolute(rootPath)) {
    fail("TASK_CONTROL_ROOT_INVALID", "state root must be an absolute path");
  }
  const requested = path.resolve(rootPath);
  let canonical;
  try {
    canonical = fs.realpathSync(requested);
  } catch (error) {
    fail("TASK_CONTROL_ROOT_UNAVAILABLE", "state root is unavailable", error);
  }
  const details = fs.lstatSync(requested);
  if (!details.isDirectory() || details.isSymbolicLink()
      || comparable(requested) !== comparable(canonical)) {
    fail("TASK_CONTROL_ROOT_UNSAFE", "state root must be one canonical real directory");
  }
  return canonical;
}

function comparable(value) {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function assertInside(rootPath, candidatePath, label) {
  const relative = path.relative(rootPath, candidatePath);
  if (!relative || relative === "." || relative.startsWith("..") || path.isAbsolute(relative)) {
    fail("TASK_CONTROL_PATH_UNSAFE", `${label} must be a file below the state root`);
  }
}

function assertPlainComponent(rootPath, candidatePath, label, expectedKind, options = {}) {
  const resolved = path.resolve(candidatePath);
  assertInside(rootPath, resolved, label);
  let details;
  try {
    details = fs.lstatSync(resolved);
  } catch (error) {
    if (options.allowMissing && error.code === "ENOENT") return null;
    fail("TASK_CONTROL_STATE_MISSING", `${label} is missing`, error);
  }
  const expected = expectedKind === "directory" ? details.isDirectory() : details.isFile();
  if (!expected || details.isSymbolicLink()) {
    fail("TASK_CONTROL_ROOT_UNSAFE", `${label} must be one canonical real ${expectedKind}`);
  }
  let canonical;
  try {
    canonical = fs.realpathSync(resolved);
  } catch (error) {
    fail("TASK_CONTROL_ROOT_UNSAFE", `${label} cannot be resolved`, error);
  }
  assertInside(rootPath, canonical, label);
  if (comparable(resolved) !== comparable(canonical)) {
    fail("TASK_CONTROL_ROOT_UNSAFE", `${label} must not traverse a link or junction`);
  }
  return canonical;
}

function canonicalStatePaths(rootPath) {
  const orchestraPath = path.join(rootPath, ".orquesta");
  const statePath = path.join(orchestraPath, "state");
  const tasksPath = path.join(statePath, "tasks.json");
  const currentPath = path.join(orchestraPath, "CURRENT_ORCHESTRA.md");
  const eventsPath = path.join(statePath, "events.jsonl");
  assertPlainComponent(rootPath, orchestraPath, ".orquesta", "directory");
  assertPlainComponent(rootPath, statePath, ".orquesta/state", "directory");
  assertPlainComponent(rootPath, tasksPath, "canonical tasks.json", "file");
  assertPlainComponent(rootPath, currentPath, "CURRENT_ORCHESTRA.md", "file", { allowMissing: true });
  assertPlainComponent(rootPath, eventsPath, "canonical events.jsonl", "file", { allowMissing: true });
  return { orchestraPath, statePath, tasksPath, currentPath, eventsPath };
}

function stateWriterOptions(rootPath, options = {}) {
  const callerValidation = options.validateLocked;
  return {
    ...options,
    bindParentDirectory: true,
    validateLocked() {
      canonicalStatePaths(rootPath);
      if (typeof callerValidation === "function") return callerValidation();
    },
  };
}

function assertTaskCanonicalRoot(task, rootPath) {
  if (task.canonical_state_root !== rootPath) {
    fail("TASK_CONTROL_ROOT_MISMATCH", "task canonical_state_root does not exactly match the selected real root");
  }
}

function validateCanonicalTask(task, rootPath, previousTask) {
  assertTaskCanonicalRoot(task, rootPath);
  if (typeof task.owner_agent_id !== "string" || !IDENTIFIER.test(task.owner_agent_id)) {
    fail("TASK_CONTROL_STATE_UNSUPPORTED", "canonical task owner must be a valid identity");
  }
  const createdAt = Date.parse(canonicalStateTimestamp(task.created_at, "canonical task created_at"));
  const updatedAt = Date.parse(canonicalStateTimestamp(task.updated_at || task.created_at, "canonical task updated_at"));
  if (previousTask && updatedAt <= Date.parse(previousTask.updated_at || previousTask.created_at)) {
    fail("TASK_CONTROL_STATE_CHANGED", "task timestamp must advance the canonical revision");
  }
  if (updatedAt < createdAt) fail("TASK_CONTROL_STATE_UNSUPPORTED", "task revision precedes its creation");
  for (const field of ["blocked_by", "dependencies"]) {
    if (task[field] !== undefined && (!Array.isArray(task[field])
        || task[field].some((id) => typeof id !== "string" || !IDENTIFIER.test(id)))) {
      fail("TASK_CONTROL_STATE_UNSUPPORTED", `canonical task ${field} must be an array of identities`);
    }
  }
  const cycles = task.execution_cycles === undefined ? [] : task.execution_cycles;
  if (!Array.isArray(cycles)) {
    fail("TASK_CONTROL_STATE_UNSUPPORTED", "canonical execution_cycles must be an array");
  }
  for (const [index, cycle] of cycles.entries()) {
    if (!cycle || typeof cycle !== "object" || Array.isArray(cycle)
        || !Number.isInteger(cycle.cycle) || cycle.cycle < 1) {
      fail("TASK_CONTROL_STATE_UNSUPPORTED", "canonical execution cycle numbers must be positive integers");
    }
    if (cycle.cycle !== index + 1) {
      fail("TASK_CONTROL_CYCLE_SEQUENCE_INVALID", "canonical execution cycles must be consecutive from 1");
    }
    if (!CANONICAL_CYCLE_STATES.has(cycle.status)) {
      fail("TASK_CONTROL_STATE_UNSUPPORTED", `cycle ${cycle.cycle} has an unsupported status`);
    }
    const startedAt = Date.parse(canonicalStateTimestamp(cycle.started_at, `cycle ${cycle.cycle} started_at`));
    if (startedAt < createdAt || startedAt > updatedAt) {
      fail("TASK_CONTROL_STATE_UNSUPPORTED", `cycle ${cycle.cycle} start is outside the task timeline`);
    }
    if (cycle.status === "completed" || cycle.status === "accepted") {
      canonicalStateTimestamp(cycle.completed_at, `cycle ${cycle.cycle} completed_at`);
      if (Date.parse(cycle.completed_at) < startedAt || Date.parse(cycle.completed_at) > updatedAt) {
        fail("TASK_CONTROL_STATE_UNSUPPORTED", `cycle ${cycle.cycle} completion is outside the task timeline`);
      }
    } else if (cycle.completed_at !== undefined && cycle.completed_at !== null) {
      fail("TASK_CONTROL_STATE_UNSUPPORTED", `cycle ${cycle.cycle} in_progress state cannot have completed_at`);
    }
    for (const receipt of Array.isArray(cycle.progress_packets) ? cycle.progress_packets : []) {
      const recordedAt = Date.parse(canonicalStateTimestamp(receipt?.recorded_at, `cycle ${cycle.cycle} progress packet recorded_at`));
      if (recordedAt < startedAt || recordedAt > updatedAt) {
        fail("TASK_CONTROL_STATE_UNSUPPORTED", `cycle ${cycle.cycle} progress packet is outside the task timeline`);
      }
    }
  }
  return task;
}

function assertTaskTransition(task, operation) {
  const editable = operation === "progress"
    ? EDITABLE_TASK_STATES.has(task.state)
    : task.state === "in_progress";
  if (!editable || (task.blocked_by || []).length > 0) {
    fail("TASK_CONTROL_TRANSITION_INVALID", `task cannot ${operation} from ${task.state} with open blockers`);
  }
}

function ensurePlainDirectory(rootPath, segments, label) {
  let current = rootPath;
  for (const segment of segments) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) fs.mkdirSync(current);
    assertPlainComponent(rootPath, current, label, "directory");
  }
  return current;
}

function portableRelativePath(value, label) {
  const relative = nonemptyText(value, label, 1024);
  if (path.isAbsolute(relative) || relative.includes("\\")
      || relative.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    fail("TASK_CONTROL_PATH_UNSAFE", `${label} must be a canonical portable relative path`);
  }
  return relative;
}

function readBoundedRealFile(rootPath, relativePath, maximumBytes, label) {
  const relative = portableRelativePath(relativePath, label);
  const candidate = path.resolve(rootPath, ...relative.split("/"));
  assertInside(rootPath, candidate, label);
  let details;
  try {
    details = fs.lstatSync(candidate);
  } catch (error) {
    fail("TASK_CONTROL_EVIDENCE_MISSING", `${label} is missing: ${relative}`, error);
  }
  if (!details.isFile() || details.isSymbolicLink() || details.size > maximumBytes) {
    fail("TASK_CONTROL_PATH_UNSAFE", `${label} must be a bounded canonical real file: ${relative}`);
  }
  const canonical = fs.realpathSync(candidate);
  assertInside(rootPath, canonical, label);
  if (comparable(candidate) !== comparable(canonical)) {
    fail("TASK_CONTROL_PATH_UNSAFE", `${label} must not traverse a link: ${relative}`);
  }
  return { relative, absolute: canonical, bytes: fs.readFileSync(canonical) };
}

function readControlPacket(rootPath, packetPath, expectedPacketSha256) {
  const expected = hash(expectedPacketSha256, "packetSha256");
  const file = readBoundedRealFile(rootPath, packetPath, MAX_PACKET_BYTES, "packetPath");
  const observed = sha256(file.bytes);
  if (observed !== expected) {
    fail("TASK_CONTROL_PACKET_HASH_MISMATCH", `control packet hash mismatch: expected ${expected}, observed ${observed}`);
  }
  let packetText;
  try {
    packetText = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
  } catch (error) {
    fail("TASK_CONTROL_PACKET_INVALID", "control packet is not valid UTF-8", error);
  }
  let packet;
  try {
    packet = JSON.parse(packetText);
  } catch (error) {
    fail("TASK_CONTROL_PACKET_INVALID", "control packet is not valid JSON", error);
  }
  return {
    packet,
    text: packetText,
    identity: {
      path: file.relative,
      sha256: observed,
      ref: `${file.relative}#sha256=${observed}`,
    },
  };
}

function validateDurableProgressPath(relativePath, taskId, label) {
  const relative = portableRelativePath(relativePath, label);
  const allowedPrefixes = [
    `workbench/inbox/${taskId}/`,
    `.orquesta/evidence/${taskId}/`,
  ];
  if (!allowedPrefixes.some((prefix) => relative.startsWith(prefix))) {
    fail(
      "TASK_CONTROL_EVIDENCE_NOT_DURABLE",
      `${label} must be stored below the canonical evidence root for ${taskId}`,
    );
  }
  const extension = path.posix.extname(relative).toLowerCase();
  if (!STRUCTURED_EVIDENCE_EXTENSIONS.has(extension)) {
    fail("TASK_CONTROL_EVIDENCE_NOT_STRUCTURED", `${label} must reference structured JSON evidence`);
  }
  const forbiddenSegments = new Set([
    ".build-generations",
    "build",
    "dist",
    "node_modules",
    "target",
    "temp",
    "tmp",
  ]);
  if (relative.toLowerCase().split("/").some((segment) => forbiddenSegments.has(segment))) {
    fail("TASK_CONTROL_EVIDENCE_NOT_DURABLE", `${label} must not reference temporary build output`);
  }
  return relative;
}

function validateEvidence(rootPath, rawEvidence, options = {}) {
  if (!Array.isArray(rawEvidence) || rawEvidence.length === 0 || rawEvidence.length > MAX_EVIDENCE) {
    fail("TASK_CONTROL_PACKET_INVALID", `evidence must contain between 1 and ${MAX_EVIDENCE} entries`);
  }
  const ids = new Set();
  const paths = new Set();
  const evidence = new Map();
  for (const [index, item] of rawEvidence.entries()) {
    exactKeys(item, ["id", "path", "sha256"], `evidence[${index}]`);
    const id = identifier(item.id, `evidence[${index}].id`);
    if (ids.has(id)) fail("TASK_CONTROL_PACKET_INVALID", `duplicate evidence id: ${id}`);
    ids.add(id);
    const expected = hash(item.sha256, `evidence[${index}].sha256`);
    const file = readBoundedRealFile(rootPath, item.path, MAX_EVIDENCE_BYTES, `evidence[${index}].path`);
    if (options.progressTaskId) {
      validateDurableProgressPath(file.relative, options.progressTaskId, `evidence[${index}].path`);
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
        const parsed = JSON.parse(text);
        if (parsed === null || typeof parsed !== "object") throw new TypeError("structured evidence must be an object or array");
      } catch (error) {
        fail("TASK_CONTROL_EVIDENCE_NOT_STRUCTURED", `evidence[${index}].path must contain valid structured JSON`, error);
      }
    }
    if (paths.has(file.relative)) fail("TASK_CONTROL_PACKET_INVALID", `duplicate evidence path: ${file.relative}`);
    paths.add(file.relative);
    const observed = sha256(file.bytes);
    if (observed !== expected) {
      fail("TASK_CONTROL_EVIDENCE_HASH_MISMATCH", `evidence hash mismatch for ${file.relative}`);
    }
    evidence.set(id, {
      id,
      path: file.relative,
      sha256: observed,
      ref: `${file.relative}#sha256=${observed}`,
    });
  }
  return evidence;
}

function validateProgressPacket(rootPath, packet, packetIdentity, task) {
  exactKeys(packet, [
    "cycle",
    "evidence",
    "expected_task_sha256",
    "operation",
    "recorded_at",
    "recorded_by",
    "schema_version",
    "summary",
    "target_state",
    "task_id",
  ], "packet");
  if (packet.schema_version !== 1 || packet.operation !== "progress") {
    fail("TASK_CONTROL_PACKET_INVALID", "packet must be schema version 1 with operation progress");
  }
  const taskId = identifier(packet.task_id, "packet.task_id");
  if (taskId !== task.task_id) fail("TASK_CONTROL_TASK_MISMATCH", "packet task does not match canonical task");
  const committedArchive = packetIdentity.path === canonicalProgressPacketIdentity(packetIdentity).path
    && storedProgressPacketMatches(task, packetIdentity);
  if (!committedArchive) {
    validateDurableProgressPath(packetIdentity.path, taskId, "packetPath");
  }
  const recordedBy = identifier(packet.recorded_by, "packet.recorded_by");
  if (recordedBy !== task.owner_agent_id) {
    fail("TASK_CONTROL_OWNER_MISMATCH", "progress actor does not match the canonical task owner");
  }
  if (packet.target_state !== "in_progress") {
    fail("TASK_CONTROL_TRANSITION_INVALID", "progress may only advance an editable task to in_progress");
  }
  const expectedTaskSha256 = hash(packet.expected_task_sha256, "packet.expected_task_sha256");
  const recordedAt = canonicalTimestamp(packet.recorded_at, "packet.recorded_at");
  const summary = nonemptyText(packet.summary, "packet.summary", 8192);
  if (Date.parse(recordedAt) < Date.parse(task.created_at)) {
    fail("TASK_CONTROL_PACKET_INVALID", "recorded_at precedes task creation");
  }

  exactKeys(packet.cycle, [
    "completed_at",
    "cycle",
    "cycle_id",
    "evidence_ids",
    "kind",
    "started_at",
    "status",
  ], "packet.cycle");
  if (!Number.isInteger(packet.cycle.cycle) || packet.cycle.cycle < 1) {
    fail("TASK_CONTROL_PACKET_INVALID", "packet.cycle.cycle must be a positive integer");
  }
  const cycleId = identifier(packet.cycle.cycle_id, "packet.cycle.cycle_id");
  const kind = identifier(packet.cycle.kind, "packet.cycle.kind");
  if (!PROGRESS_CYCLE_STATES.has(packet.cycle.status)) {
    fail("TASK_CONTROL_PACKET_INVALID", "packet.cycle.status must be in_progress or completed");
  }
  const startedAt = canonicalTimestamp(packet.cycle.started_at, "packet.cycle.started_at");
  let completedAt = null;
  if (packet.cycle.status === "completed") {
    completedAt = canonicalTimestamp(packet.cycle.completed_at, "packet.cycle.completed_at");
    if (Date.parse(completedAt) < Date.parse(startedAt) || Date.parse(completedAt) > Date.parse(recordedAt)) {
      fail("TASK_CONTROL_PACKET_INVALID", "completed_at must fall between started_at and recorded_at");
    }
  } else if (packet.cycle.completed_at !== null) {
    fail("TASK_CONTROL_PACKET_INVALID", "an in_progress cycle must use completed_at null");
  }
  if (Date.parse(startedAt) > Date.parse(recordedAt)) {
    fail("TASK_CONTROL_PACKET_INVALID", "started_at must not be later than recorded_at");
  }

  const evidence = validateEvidence(rootPath, packet.evidence, { progressTaskId: taskId });
  const cycleEvidenceIds = evidenceIds(packet.cycle.evidence_ids, evidence, "packet.cycle.evidence_ids");
  if (cycleEvidenceIds.length !== evidence.size) {
    fail("TASK_CONTROL_PACKET_INVALID", "progress packet contains unreferenced evidence");
  }
  return {
    operation: "progress",
    taskId,
    expectedTaskSha256,
    recordedAt,
    recordedBy,
    taskState: "in_progress",
    summary,
    cycle: {
      cycle: packet.cycle.cycle,
      cycleId,
      kind,
      status: packet.cycle.status,
      startedAt,
      completedAt,
      evidenceIds: cycleEvidenceIds,
    },
    evidence,
    packetIdentity,
  };
}

function evidenceIds(value, evidence, label) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_EVIDENCE) {
    fail("TASK_CONTROL_PACKET_INVALID", `${label} must be a nonempty bounded array`);
  }
  const result = [];
  const seen = new Set();
  for (const [index, raw] of value.entries()) {
    const id = identifier(raw, `${label}[${index}]`);
    if (!evidence.has(id)) fail("TASK_CONTROL_PACKET_INVALID", `${label} refers to unknown evidence: ${id}`);
    if (seen.has(id)) fail("TASK_CONTROL_PACKET_INVALID", `${label} contains duplicate evidence: ${id}`);
    seen.add(id);
    result.push(id);
  }
  return result;
}

function validatePacket(rootPath, packet, packetIdentity, task) {
  exactKeys(packet, [
    "accepted_at",
    "accepted_by",
    "accepted_cycle_numbers",
    "completion_evidence",
    "criterion_results",
    "decision",
    "done_signal",
    "evidence",
    "expected_task_sha256",
    "result_summary",
    "review",
    "schema_version",
    "task_id",
  ], "packet");
  if (packet.schema_version !== 1 || packet.decision !== "accepted") {
    fail("TASK_CONTROL_PACKET_INVALID", "packet must be schema version 1 with decision accepted");
  }
  const taskId = identifier(packet.task_id, "packet.task_id");
  if (taskId !== task.task_id) fail("TASK_CONTROL_TASK_MISMATCH", "packet task does not match canonical task");
  if (typeof task.review_agent_id !== "string" || !IDENTIFIER.test(task.review_agent_id)) {
    fail("TASK_CONTROL_STATE_UNSUPPORTED", "canonical task review owner must be a valid identity");
  }
  const ownerAgentId = task.owner_agent_id;
  const expectedTaskSha256 = hash(packet.expected_task_sha256, "packet.expected_task_sha256");
  const acceptedAt = canonicalTimestamp(packet.accepted_at, "packet.accepted_at");
  const acceptedBy = identifier(packet.accepted_by, "packet.accepted_by");
  const resultSummary = nonemptyText(packet.result_summary, "packet.result_summary", 8192);
  const evidence = validateEvidence(rootPath, packet.evidence);
  const usedEvidence = new Set();

  if (!Array.isArray(task.acceptance_checks) || task.acceptance_checks.length === 0) {
    fail("TASK_CONTROL_STATE_UNSUPPORTED", "canonical task has no acceptance checks");
  }
  if (!Array.isArray(packet.criterion_results)
      || packet.criterion_results.length !== task.acceptance_checks.length) {
    fail("TASK_CONTROL_PACKET_INVALID", "criterion_results must cover every canonical acceptance check exactly once");
  }
  const criterionIndexes = new Set();
  const criterionResults = packet.criterion_results.map((result, index) => {
    exactKeys(result, ["criterion_index", "criterion_sha256", "evidence_ids", "status"], `criterion_results[${index}]`);
    if (!Number.isInteger(result.criterion_index)
        || result.criterion_index < 0 || result.criterion_index >= task.acceptance_checks.length
        || criterionIndexes.has(result.criterion_index)) {
      fail("TASK_CONTROL_PACKET_INVALID", `criterion_results[${index}].criterion_index is invalid`);
    }
    criterionIndexes.add(result.criterion_index);
    if (result.status !== "passed") fail("TASK_CONTROL_ACCEPTANCE_REJECTED", "every criterion must pass");
    const expectedCriterionHash = sha256(Buffer.from(task.acceptance_checks[result.criterion_index], "utf8"));
    if (hash(result.criterion_sha256, `criterion_results[${index}].criterion_sha256`) !== expectedCriterionHash) {
      fail("TASK_CONTROL_CRITERION_MISMATCH", `criterion ${result.criterion_index} no longer matches the packet`);
    }
    const ids = evidenceIds(result.evidence_ids, evidence, `criterion_results[${index}].evidence_ids`);
    ids.forEach((id) => usedEvidence.add(id));
    return { ...result, evidence_ids: ids };
  });

  exactKeys(packet.review, ["evidence_ids", "findings", "reviewed_at", "reviewer_id", "status", "summary"], "packet.review");
  if (packet.review.status !== "accepted") fail("TASK_CONTROL_ACCEPTANCE_REJECTED", "independent review did not accept the task");
  const reviewerId = identifier(packet.review.reviewer_id, "packet.review.reviewer_id");
  if (reviewerId !== task.review_agent_id) {
    fail("TASK_CONTROL_REVIEWER_MISMATCH", "reviewer does not match the canonical review owner");
  }
  if (reviewerId === ownerAgentId) {
    fail("TASK_CONTROL_REVIEW_NOT_INDEPENDENT", "reviewer must differ from the task owner");
  }
  const reviewedAt = canonicalTimestamp(packet.review.reviewed_at, "packet.review.reviewed_at");
  if (Date.parse(reviewedAt) > Date.parse(acceptedAt)) {
    fail("TASK_CONTROL_PACKET_INVALID", "reviewed_at must not be later than accepted_at");
  }
  exactKeys(packet.review.findings, ["critical", "important", "minor"], "packet.review.findings");
  for (const key of ["critical", "important", "minor"]) {
    if (!Number.isInteger(packet.review.findings[key]) || packet.review.findings[key] < 0) {
      fail("TASK_CONTROL_PACKET_INVALID", `packet.review.findings.${key} is invalid`);
    }
  }
  if (packet.review.findings.critical !== 0 || packet.review.findings.important !== 0) {
    fail("TASK_CONTROL_ACCEPTANCE_REJECTED", "Critical or Important findings remain open");
  }
  const reviewEvidenceIds = evidenceIds(packet.review.evidence_ids, evidence, "packet.review.evidence_ids");
  reviewEvidenceIds.forEach((id) => usedEvidence.add(id));
  const reviewSummary = nonemptyText(packet.review.summary, "packet.review.summary", 4096);

  if (!task.execution_cycles?.length) {
    fail("TASK_CONTROL_STATE_UNSUPPORTED", "canonical task has no numbered execution cycles");
  }
  if (!Array.isArray(packet.accepted_cycle_numbers)
      || packet.accepted_cycle_numbers.length !== task.execution_cycles.length
      || packet.accepted_cycle_numbers.some((cycle) => !Number.isInteger(cycle))) {
    fail("TASK_CONTROL_PACKET_INVALID", "accepted_cycle_numbers must cover every canonical cycle");
  }
  const expectedCycles = task.execution_cycles.map((cycle) => cycle.cycle);
  const acceptedCycles = [...new Set(packet.accepted_cycle_numbers)].sort((left, right) => left - right);
  if (acceptedCycles.length !== packet.accepted_cycle_numbers.length
      || acceptedCycles.length !== expectedCycles.length
      || acceptedCycles.some((cycle, index) => cycle !== expectedCycles[index])) {
    fail("TASK_CONTROL_PACKET_INVALID", "accepted_cycle_numbers do not match canonical execution cycles");
  }

  if (!Array.isArray(packet.completion_evidence)
      || packet.completion_evidence.length === 0 || packet.completion_evidence.length > MAX_EVIDENCE) {
    fail("TASK_CONTROL_PACKET_INVALID", "completion_evidence must be a nonempty bounded array");
  }
  const completionEvidence = packet.completion_evidence.map((item, index) => {
    exactKeys(item, ["evidence_id", "kind", "status"], `completion_evidence[${index}]`);
    const kind = identifier(item.kind, `completion_evidence[${index}].kind`);
    if (item.status !== "passed") fail("TASK_CONTROL_ACCEPTANCE_REJECTED", "completion evidence must pass");
    const [id] = evidenceIds([item.evidence_id], evidence, `completion_evidence[${index}].evidence_id`);
    usedEvidence.add(id);
    return { kind, status: "passed", evidence_id: id };
  });

  exactKeys(packet.done_signal, ["done_signal_sha256", "evidence_ids", "satisfied"], "packet.done_signal");
  if (packet.done_signal.satisfied !== true) fail("TASK_CONTROL_ACCEPTANCE_REJECTED", "canonical done signal is not satisfied");
  const canonicalDoneSignal = nonemptyText(task.done_signal, "task.done_signal", 16384);
  if (hash(packet.done_signal.done_signal_sha256, "packet.done_signal.done_signal_sha256")
      !== sha256(Buffer.from(canonicalDoneSignal, "utf8"))) {
    fail("TASK_CONTROL_DONE_SIGNAL_MISMATCH", "canonical done signal no longer matches the packet");
  }
  const doneEvidenceIds = evidenceIds(packet.done_signal.evidence_ids, evidence, "packet.done_signal.evidence_ids");
  doneEvidenceIds.forEach((id) => usedEvidence.add(id));

  if (usedEvidence.size !== evidence.size) {
    fail("TASK_CONTROL_PACKET_INVALID", "packet contains unreferenced evidence");
  }
  if (task.specialist_report_required !== false || task.completion_transport !== "direct") {
    fail("TASK_CONTROL_ROUTE_UNSUPPORTED", "this controller accepts only direct report-free tasks");
  }
  if (Date.parse(acceptedAt) < Date.parse(task.created_at || "")) {
    fail("TASK_CONTROL_PACKET_INVALID", "accepted_at precedes task creation");
  }

  return {
    taskId,
    expectedTaskSha256,
    acceptedAt,
    acceptedBy,
    resultSummary,
    evidence,
    criterionResults,
    review: {
      reviewerId,
      reviewedAt,
      findings: { ...packet.review.findings },
      summary: reviewSummary,
      evidenceIds: reviewEvidenceIds,
    },
    acceptedCycles,
    completionEvidence,
    doneEvidenceIds,
    packetIdentity,
  };
}

function validateLedger(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)
      || state.version !== 1 || !Array.isArray(state.tasks)) {
    fail("TASK_CONTROL_STATE_UNSUPPORTED", "coordination tasks.json must use schema version 1");
  }
  const ids = new Set();
  for (const task of state.tasks) {
    if (!task || typeof task !== "object" || Array.isArray(task)
        || typeof task.task_id !== "string" || ids.has(task.task_id)) {
      fail("TASK_CONTROL_STATE_UNSUPPORTED", "coordination task identities are invalid");
    }
    ids.add(task.task_id);
  }
  return state;
}

function readLedger(rootPath) {
  const { tasksPath } = canonicalStatePaths(rootPath);
  return { tasksPath, state: validateLedger(readJsonFile(tasksPath, null)) };
}

function canonicalProgressPacketIdentity(identity) {
  const relative = `${PROGRESS_PACKET_DIRECTORY.join("/")}/${identity.sha256}.json`;
  return { path: relative, sha256: identity.sha256, ref: `${relative}#sha256=${identity.sha256}` };
}

function materializeProgressPacket(rootPath, packetRead, options = {}) {
  const identity = canonicalProgressPacketIdentity(packetRead.identity);
  const packetDirectory = ensurePlainDirectory(rootPath, PROGRESS_PACKET_DIRECTORY, "progress packet directory");
  const packetPath = path.join(packetDirectory, `${identity.sha256}.json`);
  const expectedBytes = Buffer.from(packetRead.text, "utf8");
  const verify = () => {
    const stored = readBoundedRealFile(rootPath, identity.path, MAX_PACKET_BYTES, "canonical progress packet");
    if (sha256(stored.bytes) !== identity.sha256 || !stored.bytes.equals(expectedBytes)) {
      fail("TASK_CONTROL_IMMUTABLE_PACKET_CONFLICT", "canonical progress packet content address is not immutable");
    }
  };
  if (!fs.existsSync(packetPath)) {
    writeTextAtomic(packetPath, packetRead.text, stateWriterOptions(rootPath, {
      ...options,
      validateLocked() {
        assertPlainComponent(rootPath, packetDirectory, "progress packet directory", "directory");
        assertPlainComponent(rootPath, packetPath, "canonical progress packet", "file", { allowMissing: true });
      },
    }));
  }
  verify();
  return identity;
}

function progressPacketReceipts(rootPath, task) {
  if (!Array.isArray(task.execution_cycles)) return [];
  const result = [];
  for (const cycle of task.execution_cycles) {
    if (cycle.progress_packet !== undefined) {
      fail("TASK_CONTROL_STATE_UNSUPPORTED", "legacy mutable progress_packet state requires explicit migration");
    }
    if (cycle.progress_packets === undefined) continue;
    if (!Array.isArray(cycle.progress_packets)) {
      fail("TASK_CONTROL_STATE_UNSUPPORTED", `cycle ${cycle.cycle} progress_packets must be an array`);
    }
    const seen = new Set();
    let previousTimestamp = null;
    for (const receipt of cycle.progress_packets) {
      if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)
          || receipt.schema_version !== 1 || receipt.operation !== "progress") {
        fail("TASK_CONTROL_STATE_UNSUPPORTED", `cycle ${cycle.cycle} has an invalid progress packet receipt`);
      }
      const digest = typeof receipt.sha256 === "string" && HASH.test(receipt.sha256)
        ? receipt.sha256
        : fail("TASK_CONTROL_STATE_UNSUPPORTED", `cycle ${cycle.cycle} has an invalid progress packet digest`);
      const expectedIdentity = canonicalProgressPacketIdentity({ sha256: digest });
      if (receipt.path !== expectedIdentity.path || seen.has(digest)) {
        fail("TASK_CONTROL_STATE_UNSUPPORTED", `cycle ${cycle.cycle} progress packet identities are not unique canonical objects`);
      }
      seen.add(digest);
      const recordedAt = canonicalStateTimestamp(receipt.recorded_at, `cycle ${cycle.cycle} progress packet recorded_at`);
      if (previousTimestamp !== null && Date.parse(recordedAt) <= Date.parse(previousTimestamp)) {
        fail("TASK_CONTROL_STATE_UNSUPPORTED", `cycle ${cycle.cycle} progress packet timestamps must increase`);
      }
      previousTimestamp = recordedAt;
      if (receipt.recorded_by !== task.owner_agent_id || !IDENTIFIER.test(receipt.recorded_by || "")
          || receipt.task_state !== "in_progress"
          || receipt.cycle !== cycle.cycle
          || !IDENTIFIER.test(receipt.cycle_id || "")
          || (cycle.cycle_id && receipt.cycle_id !== cycle.cycle_id)
          || !PROGRESS_CYCLE_STATES.has(receipt.cycle_status)
          || typeof receipt.summary !== "string" || !receipt.summary.trim()
          || !Array.isArray(receipt.evidence_refs)
          || receipt.evidence_refs.some((reference) => typeof reference !== "string" || !/#sha256=[a-f0-9]{64}$/u.test(reference))) {
        fail("TASK_CONTROL_STATE_UNSUPPORTED", `cycle ${cycle.cycle} has inconsistent progress packet metadata`);
      }
      const stored = readBoundedRealFile(rootPath, receipt.path, MAX_PACKET_BYTES, "canonical progress packet");
      if (sha256(stored.bytes) !== digest) {
        fail("TASK_CONTROL_IMMUTABLE_PACKET_CONFLICT", "canonical progress packet digest changed");
      }
      result.push({ ...receipt, packet_ref: expectedIdentity.ref });
    }
  }
  return result;
}

function storedPacketMatches(task, identity) {
  return task.acceptance_packet?.schema_version === 1
    && task.acceptance_packet?.path === identity.path
    && task.acceptance_packet?.sha256 === identity.sha256
    && task.acceptance_packet?.decision === "accepted";
}

function storedProgressPacketMatches(task, identity) {
  return Array.isArray(task.execution_cycles)
    && task.execution_cycles.some((cycle) => Array.isArray(cycle.progress_packets)
      && cycle.progress_packets.some((receipt) => (
        receipt?.schema_version === 1
        && receipt.sha256 === identity.sha256
        && receipt.operation === "progress"
      )));
}

function buildProgressTask(task, validated) {
  const cycles = task.execution_cycles || [];
  const cycleNumber = validated.cycle.cycle;
  const index = cycles.findIndex((cycle) => cycle.cycle === cycleNumber);
  let current = null;
  if (index < 0) {
    if (cycleNumber !== cycles.length + 1) {
      fail("TASK_CONTROL_CYCLE_SEQUENCE_INVALID", `new execution cycle must be ${cycles.length + 1}`);
    }
    if (cycles.some((cycle) => cycle.status === "in_progress")) {
      fail("TASK_CONTROL_TRANSITION_INVALID", "a new execution cycle cannot start while another cycle is in progress");
    }
  } else {
    current = cycles[index];
    if (current.status !== "in_progress") {
      fail("TASK_CONTROL_TRANSITION_INVALID", `cycle ${cycleNumber} cannot transition from ${current.status}`);
    }
    if ((current.cycle_id && current.cycle_id !== validated.cycle.cycleId)
        || (current.kind && current.kind !== validated.cycle.kind)
        || (current.owner_agent_id && current.owner_agent_id !== task.owner_agent_id)
        || (current.started_at && Date.parse(current.started_at) !== Date.parse(validated.cycle.startedAt))) {
      fail("TASK_CONTROL_CYCLE_IDENTITY_CHANGED", `cycle ${cycleNumber} identity is immutable`);
    }
    if (current.evidence_refs !== undefined
        && (!Array.isArray(current.evidence_refs)
          || current.evidence_refs.some((reference) => typeof reference !== "string"))) {
      fail("TASK_CONTROL_STATE_UNSUPPORTED", `cycle ${cycleNumber} evidence_refs must be an array of strings`);
    }
  }

  const evidenceRefs = validated.cycle.evidenceIds.map((id) => validated.evidence.get(id).ref);
  const nextCycle = {
    ...(current || {}),
    cycle: cycleNumber,
    cycle_id: validated.cycle.cycleId,
    kind: validated.cycle.kind,
    owner_agent_id: task.owner_agent_id,
    status: validated.cycle.status,
    started_at: validated.cycle.startedAt,
    summary: validated.summary,
    evidence_refs: [...new Set([...(current?.evidence_refs || []), ...evidenceRefs])],
    progress_packets: [...(current?.progress_packets || []), {
      schema_version: 1,
      path: validated.packetIdentity.path,
      sha256: validated.packetIdentity.sha256,
      operation: "progress",
      recorded_at: validated.recordedAt,
      recorded_by: validated.recordedBy,
      task_state: validated.taskState,
      cycle: cycleNumber,
      cycle_id: validated.cycle.cycleId,
      cycle_status: validated.cycle.status,
      evidence_refs: evidenceRefs,
      summary: validated.summary,
    }],
  };
  delete nextCycle.progress_packet;
  if (validated.cycle.completedAt) nextCycle.completed_at = validated.cycle.completedAt;
  else delete nextCycle.completed_at;
  const executionCycles = index < 0
    ? [...cycles, nextCycle]
    : cycles.map((cycle, cycleIndex) => (cycleIndex === index ? nextCycle : cycle));
  return {
    ...task,
    task_id: task.task_id,
    state: validated.taskState,
    execution_cycles: executionCycles,
    result_summary: validated.summary,
    updated_at: validated.recordedAt,
  };
}

function buildAcceptedTask(task, validated) {
  const completionRefs = validated.completionEvidence.map((item) => {
    const evidence = validated.evidence.get(item.evidence_id);
    return evidence.ref;
  });
  return {
    ...task,
    state: "accepted",
    execution_cycles: task.execution_cycles.map((cycle) => ({
      ...cycle,
      status: "accepted",
      completed_at: cycle.completed_at || validated.acceptedAt,
    })),
    completion_evidence: completionRefs,
    completion_reason: validated.resultSummary,
    result_summary: validated.resultSummary,
    accepted_at: validated.acceptedAt,
    accepted_by: validated.acceptedBy,
    acceptance_packet: {
      schema_version: 1,
      path: validated.packetIdentity.path,
      sha256: validated.packetIdentity.sha256,
      decision: "accepted",
      reviewer_id: validated.review.reviewerId,
      reviewed_at: validated.review.reviewedAt,
      findings: validated.review.findings,
    },
    updated_at: validated.acceptedAt,
  };
}

function dependentAfterAcceptance(task, acceptedTaskId, acceptedAt) {
  if (!Array.isArray(task.blocked_by) || !task.blocked_by.includes(acceptedTaskId)
      || !Array.isArray(task.dependencies) || !task.dependencies.includes(acceptedTaskId)) {
    return task;
  }
  return {
    ...task,
    blocked_by: task.blocked_by.filter((blocker) => blocker !== acceptedTaskId),
    updated_at: latestTimestamp(task.updated_at, acceptedAt),
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function projectCurrentOrchestra(rootPath, task, validated, options = {}) {
  const { currentPath } = canonicalStatePaths(rootPath);
  if (!fs.existsSync(currentPath)) fail("TASK_CONTROL_PROJECTION_MISSING", "CURRENT_ORCHESTRA.md is missing");
  const taskPattern = new RegExp(`^- ${escapeRegExp(task.task_id)}:.*$`, "mu");
  return updateTextAtomic(currentPath, "", (current) => {
    const { state } = readLedger(rootPath);
    const latest = state.tasks.find((candidate) => candidate.task_id === task.task_id);
    if (!latest) fail("TASK_CONTROL_TASK_MISSING", `unknown task: ${task.task_id}`);
    validateCanonicalTask(latest, rootPath);
    const summary = (latest.result_summary || latest.completion_reason
      || validated.resultSummary || validated.summary).replace(/[\r\n]+/gu, " ");
    const ledgerUpdatedAt = state.updated_at || latest.updated_at || latest.accepted_at
      || validated.recordedAt || validated.acceptedAt;
    if (!taskPattern.test(current)) {
      fail("TASK_CONTROL_PROJECTION_MISSING", `CURRENT_ORCHESTRA.md has no task line for ${task.task_id}`);
    }
    let next = current.replace(taskPattern, `- ${task.task_id}: ${latest.state} (${summary})`);
    const updatedPattern = /^Updated at:.*$/mu;
    if (updatedPattern.test(next)) next = next.replace(updatedPattern, `Updated at: ${ledgerUpdatedAt}`);
    return next;
  }, stateWriterOptions(rootPath, { ...options, backup: true }));
}

function projectProgressEvents(rootPath, task, _validated, options = {}) {
  const receipts = progressPacketReceipts(rootPath, task);
  const { eventsPath } = canonicalStatePaths(rootPath);
  return receipts.map((receipt) => appendJsonlAtomic(eventsPath, {
    event_id: `task-progress:${task.task_id}:${receipt.sha256}`,
    timestamp: receipt.recorded_at,
    type: "task_progress_recorded",
    actor: receipt.recorded_by,
    task_id: task.task_id,
    state: receipt.task_state,
    cycle: receipt.cycle,
    cycle_id: receipt.cycle_id,
    cycle_status: receipt.cycle_status,
    packet_ref: receipt.packet_ref,
    evidence_refs: receipt.evidence_refs,
    summary: receipt.summary,
  }, stateWriterOptions(rootPath, options)));
}

function projectAcceptanceEvent(rootPath, task, validated, options = {}) {
  const { eventsPath } = canonicalStatePaths(rootPath);
  return appendJsonlAtomic(eventsPath, {
    event_id: `task-acceptance:${task.task_id}:${validated.packetIdentity.sha256}`,
    timestamp: validated.acceptedAt,
    type: "task_accepted",
    actor: validated.acceptedBy,
    task_id: task.task_id,
    reviewer_id: validated.review.reviewerId,
    packet_ref: validated.packetIdentity.ref,
    summary: validated.resultSummary,
  }, stateWriterOptions(rootPath, options));
}

function reconcileDerivedProjections(rootPath, task, validated, options = {}) {
  const projectEvent = validated.operation === "progress"
    ? (options.projectProgressEvents || options.projectProgressEvent || projectProgressEvents)
    : (options.projectAcceptanceEvent || projectAcceptanceEvent);
  const implementations = {
    current: options.projectCurrentOrchestra || projectCurrentOrchestra,
    event: projectEvent,
  };
  if (validated.operation !== "progress") {
    implementations.progress_history = options.projectProgressEvents || projectProgressEvents;
  }
  const results = {};
  const errors = [];
  for (const [name, operation] of Object.entries(implementations)) {
    try {
      results[name] = operation(rootPath, task, validated, options.jsonStateOptions || {});
    } catch (error) {
      errors.push({ name, code: error.code || "TASK_CONTROL_PROJECTION_FAILED", message: error.message });
    }
  }
  return {
    status: errors.length === 0 ? "current" : "pending_replay",
    results,
    errors,
  };
}

function acceptDirectTaskAtomic({ rootPath, packetPath, packetSha256, options = {} }) {
  const root = trustedRoot(rootPath);
  const packetRead = readControlPacket(root, packetPath, packetSha256);
  const initial = readLedger(root);
  const initialTask = initial.state.tasks.find((task) => task.task_id === packetRead.packet.task_id);
  if (!initialTask) fail("TASK_CONTROL_TASK_MISSING", `unknown task: ${packetRead.packet.task_id}`);
  validateCanonicalTask(initialTask, root);

  if (initialTask.state === "accepted") {
    if (!storedPacketMatches(initialTask, packetRead.identity)) {
      fail("TASK_CONTROL_ALREADY_ACCEPTED", "task was accepted by a different acceptance packet");
    }
    // The stored content address proves this is the packet that committed the task.
    // Revalidate its evidence and canonical bindings before repairing projections,
    // but do not invent a lossy reconstruction of the pre-acceptance snapshot.
    const validated = validatePacket(root, packetRead.packet, packetRead.identity, initialTask);
    progressPacketReceipts(root, initialTask);
    const projection = reconcileDerivedProjections(root, initialTask, validated, options);
    return { status: "already_accepted", task: initialTask, unblocked_task_ids: [], projection };
  }

  const validated = validatePacket(root, packetRead.packet, packetRead.identity, initialTask);

  let acceptedTask = null;
  let mutationStatus = "accepted";
  let unblockedTaskIds = [];
  const write = updateJsonAtomic(initial.tasksPath, { version: 1, tasks: [] }, (rawState) => {
    const state = validateLedger(rawState);
    const index = state.tasks.findIndex((task) => task.task_id === validated.taskId);
    if (index < 0) fail("TASK_CONTROL_TASK_MISSING", `unknown task: ${validated.taskId}`);
    const current = state.tasks[index];
    validateCanonicalTask(current, root);
    progressPacketReceipts(root, current);
    if (current.state === "accepted") {
      if (!storedPacketMatches(current, validated.packetIdentity)) {
        fail("TASK_CONTROL_ALREADY_ACCEPTED", "task was accepted by a different acceptance packet");
      }
      mutationStatus = "already_accepted";
      acceptedTask = current;
      return state;
    }
    assertTaskTransition(current, "accept");
    if (taskSnapshotSha256(current) !== validated.expectedTaskSha256) {
      fail("TASK_CONTROL_STATE_CHANGED", "canonical task changed before acceptance could commit");
    }
    const taskById = new Map(state.tasks.map((task) => [task.task_id, task]));
    if ((current.dependencies || []).some((dependency) => taskById.get(dependency)?.state !== "accepted")) {
      fail("TASK_CONTROL_DEPENDENCY_OPEN", "canonical task has an unaccepted dependency");
    }
    acceptedTask = validateCanonicalTask(buildAcceptedTask(current, validated), root, current);
    const nextTasks = state.tasks.map((task) => {
      if (task.task_id === current.task_id) return acceptedTask;
      const next = dependentAfterAcceptance(task, current.task_id, validated.acceptedAt);
      if (next !== task) unblockedTaskIds.push(task.task_id);
      return next;
    });
    return { ...state, tasks: nextTasks, updated_at: latestTimestamp(state.updated_at, validated.acceptedAt) };
  }, stateWriterOptions(root, { ...options.jsonStateOptions, backup: true }));

  const projection = reconcileDerivedProjections(root, acceptedTask, validated, options);
  return {
    status: mutationStatus,
    task: acceptedTask,
    unblocked_task_ids: [...new Set(unblockedTaskIds)].sort(),
    write,
    projection,
  };
}

function recordTaskProgressAtomic({ rootPath, packetPath, packetSha256, options = {} }) {
  const root = trustedRoot(rootPath);
  const packetRead = readControlPacket(root, packetPath, packetSha256);
  const initial = readLedger(root);
  const initialTask = initial.state.tasks.find((task) => task.task_id === packetRead.packet.task_id);
  if (!initialTask) fail("TASK_CONTROL_TASK_MISSING", `unknown task: ${packetRead.packet.task_id}`);
  validateCanonicalTask(initialTask, root);
  const validated = validateProgressPacket(root, packetRead.packet, packetRead.identity, initialTask);
  if (storedProgressPacketMatches(initialTask, packetRead.identity)) {
    progressPacketReceipts(root, initialTask);
    const projection = reconcileDerivedProjections(root, initialTask, validated, options);
    return {
      status: "already_recorded",
      task: initialTask,
      task_sha256: taskSnapshotSha256(initialTask),
      projection,
    };
  }

  let progressedTask = null;
  let committedValidated = validated;
  let mutationStatus = "recorded";
  const write = updateJsonAtomic(initial.tasksPath, { version: 1, tasks: [] }, (rawState) => {
    const state = validateLedger(rawState);
    const index = state.tasks.findIndex((task) => task.task_id === validated.taskId);
    if (index < 0) fail("TASK_CONTROL_TASK_MISSING", `unknown task: ${validated.taskId}`);
    const current = state.tasks[index];
    validateCanonicalTask(current, root);
    progressPacketReceipts(root, current);
    if (storedProgressPacketMatches(current, validated.packetIdentity)) {
      mutationStatus = "already_recorded";
      progressedTask = current;
      return state;
    }
    assertTaskTransition(current, "progress");
    if (taskSnapshotSha256(current) !== validated.expectedTaskSha256) {
      fail("TASK_CONTROL_STATE_CHANGED", "canonical task changed before progress could commit");
    }
    committedValidated = { ...validated, packetIdentity: canonicalProgressPacketIdentity(validated.packetIdentity) };
    progressedTask = validateCanonicalTask(buildProgressTask(current, committedValidated), root, current);
    materializeProgressPacket(root, packetRead, options.jsonStateOptions || {});
    const nextTasks = state.tasks.map((task, taskIndex) => (
      taskIndex === index ? progressedTask : task
    ));
    return { ...state, tasks: nextTasks, updated_at: latestTimestamp(state.updated_at, validated.recordedAt) };
  }, stateWriterOptions(root, { ...options.jsonStateOptions, backup: true }));

  const projection = reconcileDerivedProjections(root, progressedTask, committedValidated, options);
  return {
    status: mutationStatus,
    task: progressedTask,
    task_sha256: taskSnapshotSha256(progressedTask),
    write,
    projection,
  };
}

function inspectTask({ rootPath, taskId }) {
  const root = trustedRoot(rootPath);
  const { state } = readLedger(root);
  const task = state.tasks.find((candidate) => candidate.task_id === taskId);
  if (!task) fail("TASK_CONTROL_TASK_MISSING", `unknown task: ${taskId}`);
  assertTaskCanonicalRoot(task, root);
  return { task_id: task.task_id, state: task.state, task_sha256: taskSnapshotSha256(task) };
}

function parseArguments(argv) {
  const command = argv[0];
  if (command !== "accept" && command !== "progress" && command !== "inspect") {
    fail("TASK_CONTROL_USAGE", CLI_USAGE);
  }
  const values = {};
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!["--state-root", "--packet", "--packet-sha256", "--task-id"].includes(argument)) {
      fail("TASK_CONTROL_USAGE", `unknown argument: ${argument}`);
    }
    if (values[argument] !== undefined || argv[index + 1] === undefined) {
      fail("TASK_CONTROL_USAGE", `invalid argument: ${argument}`);
    }
    values[argument] = argv[++index];
  }
  if (!values["--state-root"]) fail("TASK_CONTROL_USAGE", "--state-root is required");
  if ((command === "accept" || command === "progress")
      && (!values["--packet"] || !values["--packet-sha256"])) {
    fail("TASK_CONTROL_USAGE", `${command} requires --packet and --packet-sha256`);
  }
  if (command === "inspect" && !values["--task-id"]) {
    fail("TASK_CONTROL_USAGE", "inspect requires --task-id");
  }
  return {
    command,
    rootPath: path.resolve(values["--state-root"]),
    packetPath: values["--packet"],
    packetSha256: values["--packet-sha256"],
    taskId: values["--task-id"],
  };
}

function main() {
  try {
    const input = parseArguments(process.argv.slice(2));
    const result = input.command === "accept"
      ? acceptDirectTaskAtomic(input)
      : input.command === "progress"
        ? recordTaskProgressAtomic(input)
        : inspectTask(input);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.projection?.status === "pending_replay") process.exitCode = 2;
  } catch (error) {
    process.stderr.write(`${error.code || "TASK_CONTROL_FAILED"}: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  TaskControllerError,
  acceptDirectTaskAtomic,
  inspectTask,
  parseArguments,
  recordTaskProgressAtomic,
  reconcileDerivedProjections,
  taskSnapshotSha256,
};
