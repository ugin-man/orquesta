"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { canonicalHash, validateContract } = require("@orquesta/contracts");
const {
  acquireExclusiveProcessLock,
  releaseExclusiveProcessLock,
} = require("./exclusive-process-lock-v1");

const INTENT_ID = /^PI-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PHASES = Object.freeze([
  "intent_recorded",
  "tasks_appended",
  "organization_registered",
  "sessions_requested",
  "sessions_accepted",
  "organization_activated",
  "complete",
]);
const TRANSIENT_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function clone(value) {
  return structuredClone(value);
}

function comparable(value) {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function assertInside(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    fail("PLACEMENT_SAGA_PATH_ESCAPE", "Placement saga path escaped its trusted project root");
  }
}

function trustedRoot(rootPath) {
  if (typeof rootPath !== "string" || !rootPath.trim()) fail("PLACEMENT_SAGA_ROOT_INVALID", "Placement saga project root is required");
  const requested = path.resolve(rootPath);
  let canonical;
  try {
    canonical = fs.realpathSync(requested);
  } catch (error) {
    fail("PLACEMENT_SAGA_ROOT_UNAVAILABLE", `Placement saga project root is unavailable: ${error.message}`);
  }
  const details = fs.lstatSync(requested);
  if (!details.isDirectory() || details.isSymbolicLink() || comparable(requested) !== comparable(canonical)) {
    fail("PLACEMENT_SAGA_ROOT_UNSAFE", "Placement saga project root must be a canonical real directory");
  }
  return canonical;
}

function directoryBoundary(rootPath, directoryPath, create) {
  assertInside(rootPath, directoryPath);
  const relative = path.relative(rootPath, directoryPath);
  let current = rootPath;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    const next = path.join(current, segment);
    if (!fs.existsSync(next)) {
      if (!create) return false;
      fs.mkdirSync(next);
    }
    const details = fs.lstatSync(next);
    if (!details.isDirectory() || details.isSymbolicLink() || comparable(fs.realpathSync(next)) !== comparable(next)) {
      fail("PLACEMENT_SAGA_PATH_UNSAFE", `Placement saga directory boundary is unsafe: ${next}`);
    }
    current = next;
  }
  return true;
}

function verifyFile(rootPath, filePath, allowMissing = true) {
  assertInside(rootPath, filePath);
  if (!directoryBoundary(rootPath, path.dirname(filePath), false)) {
    if (allowMissing) return false;
    fail("PLACEMENT_SAGA_FILE_MISSING", `Placement saga file is missing: ${filePath}`);
  }
  if (!fs.existsSync(filePath)) {
    if (allowMissing) return false;
    fail("PLACEMENT_SAGA_FILE_MISSING", `Placement saga file is missing: ${filePath}`);
  }
  const details = fs.lstatSync(filePath);
  if (!details.isFile() || details.isSymbolicLink() || comparable(fs.realpathSync(filePath)) !== comparable(filePath)) {
    fail("PLACEMENT_SAGA_PATH_UNSAFE", `Placement saga file is unsafe: ${filePath}`);
  }
  return true;
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function fileHash(filePath) {
  return sha256(fs.readFileSync(filePath));
}

function readJson(rootPath, filePath) {
  verifyFile(rootPath, filePath, false);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail("PLACEMENT_SAGA_INVALID", `Placement saga JSON is invalid: ${error.message}`);
  }
}

function syncDirectory(directoryPath) {
  const descriptor = fs.openSync(directoryPath, "r");
  try {
    try {
      fs.fsyncSync(descriptor);
    } catch (error) {
      if (process.platform !== "win32" || !["EPERM", "EINVAL"].includes(error.code)) throw error;
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function retryOperational(operation, attempts = 5) {
  let last;
  for (let index = 0; index < attempts; index += 1) {
    try {
      return operation();
    } catch (error) {
      last = error;
      if (!TRANSIENT_CODES.has(error.code) || index === attempts - 1) throw error;
    }
  }
  throw last;
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    fail("PLACEMENT_SAGA_INVALID", `${label} has an invalid exact shape`);
  }
}

function timestamp(value, label) {
  if (typeof value !== "string" || !UTC.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail("PLACEMENT_SAGA_INVALID", `${label} must be a canonical UTC timestamp`);
  }
}

function taskFingerprint(task) {
  const content = clone(task);
  delete content.placement_fingerprint;
  delete content.state;
  delete content.blocked_by;
  delete content.result_summary;
  delete content.accepted_at;
  delete content.updated_at;
  return canonicalHash(content);
}

function validateTask(task) {
  const fields = [
    "task_id", "task_kind", "placement_intent_id", "assigned_agent_id", "owner_agent_id",
    "role_id", "role_version", "purpose", "acceptance_criteria", "state", "dependencies",
    "blocked_by", "result_summary", "accepted_at", "specialist_report_required",
    "created_at", "updated_at", "placement_fingerprint",
  ];
  exactKeys(task, fields, "placement task");
  if (typeof task.task_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(task.task_id)
    || typeof task.placement_intent_id !== "string" || !INTENT_ID.test(task.placement_intent_id)
    || typeof task.assigned_agent_id !== "string" || !task.assigned_agent_id
    || task.owner_agent_id !== task.assigned_agent_id
    || task.task_kind !== "specialist_work"
    || typeof task.role_id !== "string" || !/^[a-z][a-z0-9-]*$/.test(task.role_id)
    || !Number.isSafeInteger(task.role_version) || task.role_version < 1
    || typeof task.purpose !== "string" || !task.purpose.trim()
    || !Array.isArray(task.acceptance_criteria) || task.acceptance_criteria.length === 0
    || task.acceptance_criteria.some((item) => typeof item !== "string" || !item.trim())
    || task.state !== "queued" || !Array.isArray(task.dependencies)
    || !Array.isArray(task.blocked_by) || task.blocked_by.length !== 0
    || task.result_summary !== null || task.accepted_at !== null
    || task.specialist_report_required !== true
    || typeof task.placement_fingerprint !== "string" || !HASH.test(task.placement_fingerprint)
    || taskFingerprint(task) !== task.placement_fingerprint) {
    fail("PLACEMENT_SAGA_INVALID", `Placement task is invalid: ${task.task_id || "<unknown>"}`);
  }
  timestamp(task.created_at, "task.created_at");
  timestamp(task.updated_at, "task.updated_at");
}

function validateStateEvidence(value, label) {
  if (value === null) return;
  exactKeys(value, ["state_revision", "state_hash"], label);
  if (!Number.isSafeInteger(value.state_revision) || value.state_revision < 0
    || typeof value.state_hash !== "string" || !HASH.test(value.state_hash)) {
    fail("PLACEMENT_SAGA_INVALID", `${label} is invalid`);
  }
}

function validateOrganizationEvidence(value, label) {
  if (value === null) return;
  exactKeys(value, ["organization_revision", "head_hash", "command_id"], label);
  if (!Number.isSafeInteger(value.organization_revision) || value.organization_revision < 0
    || typeof value.head_hash !== "string" || !HASH.test(value.head_hash)
    || (value.command_id !== null && (typeof value.command_id !== "string" || !value.command_id))) {
    fail("PLACEMENT_SAGA_INVALID", `${label} is invalid`);
  }
}

function validateBinding(value, agentId) {
  exactKeys(value, ["status", "agent_id", "thread_id", "session_id", "accepted_at"], "accepted session binding");
  if (value.status !== "accepted" || value.agent_id !== agentId
    || typeof value.thread_id !== "string" || !value.thread_id
    || typeof value.session_id !== "string" || !value.session_id) {
    fail("PLACEMENT_SAGA_INVALID", `Accepted session binding is invalid for ${agentId}`);
  }
  timestamp(value.accepted_at, "binding.accepted_at");
}

function validateOrganizationPlan(value, saga, agentIds) {
  exactKeys(value, ["memberships", "relationships", "placement_evidence"], "placement organization plan");
  if (!Array.isArray(value.memberships) || !Array.isArray(value.relationships)
    || !Array.isArray(value.placement_evidence)) {
    fail("PLACEMENT_SAGA_INVALID", "Placement organization plan arrays are required");
  }
  const ids = new Set(agentIds);
  const taskByAgent = new Map(saga.task_records.map((task) => [task.assigned_agent_id, task]));
  const seenMemberships = new Set();
  for (const membership of value.memberships) {
    exactKeys(membership, [
      "membership_id", "agent_id", "team_id", "position", "ordinal", "active_from", "active_to",
    ], "placement membership");
    if (typeof membership.membership_id !== "string" || !membership.membership_id
      || seenMemberships.has(membership.membership_id) || !ids.has(membership.agent_id)
      || typeof membership.team_id !== "string" || !membership.team_id
      || membership.position !== "member" || !Number.isSafeInteger(membership.ordinal) || membership.ordinal < 1
      || membership.active_to !== null) {
      fail("PLACEMENT_SAGA_INVALID", "Placement membership is invalid");
    }
    timestamp(membership.active_from, "membership.active_from");
    seenMemberships.add(membership.membership_id);
  }
  const seenRelationships = new Set();
  for (const relationship of value.relationships) {
    exactKeys(relationship, ["relationship_id", "type", "subject_ref", "object_ref"], "placement relationship");
    if (typeof relationship.relationship_id !== "string" || !relationship.relationship_id
      || seenRelationships.has(relationship.relationship_id) || relationship.type !== "reports_to"
      || relationship.subject_ref?.kind !== "agent" || !ids.has(relationship.subject_ref.id)
      || relationship.object_ref?.kind !== "agent" || typeof relationship.object_ref.id !== "string"
      || !relationship.object_ref.id) {
      fail("PLACEMENT_SAGA_INVALID", "Placement relationship is invalid");
    }
    exactKeys(relationship.subject_ref, ["kind", "id"], "placement relationship subject");
    exactKeys(relationship.object_ref, ["kind", "id"], "placement relationship object");
    seenRelationships.add(relationship.relationship_id);
  }
  if (value.placement_evidence.length !== ids.size) {
    fail("PLACEMENT_SAGA_INVALID", "Placement evidence must cover every planned agent exactly once");
  }
  const seenEvidence = new Set();
  for (const evidence of value.placement_evidence) {
    exactKeys(evidence, ["agent_id", "placement_intent_id", "executable_task_id"], "placement evidence");
    const task = taskByAgent.get(evidence.agent_id);
    if (!ids.has(evidence.agent_id) || seenEvidence.has(evidence.agent_id)
      || evidence.placement_intent_id !== saga.placement_intent_id
      || !task || evidence.executable_task_id !== task.task_id) {
      fail("PLACEMENT_SAGA_INVALID", "Placement evidence provenance is invalid");
    }
    seenEvidence.add(evidence.agent_id);
  }
}

function validateSaga(saga) {
  exactKeys(saga, [
    "schema_version", "revision", "placement_intent_id", "operation_id", "operation_version",
    "template_sha256", "intent", "intent_hash", "phase", "task_records", "agents", "organization_plan",
    "task_evidence", "organization_registration", "session_bindings", "activations",
    "created_at", "updated_at",
  ], "placement saga");
  if (saga.schema_version !== 1 || !Number.isSafeInteger(saga.revision) || saga.revision < 0
    || typeof saga.placement_intent_id !== "string" || !INTENT_ID.test(saga.placement_intent_id)
    || typeof saga.operation_id !== "string" || !saga.operation_id
    || !Number.isSafeInteger(saga.operation_version) || saga.operation_version < 1
    || typeof saga.template_sha256 !== "string" || !HASH.test(saga.template_sha256)
    || !validateContract("placement-intent", saga.intent).ok
    || saga.intent.placement_intent_id !== saga.placement_intent_id
    || typeof saga.intent_hash !== "string" || !HASH.test(saga.intent_hash)
    || canonicalHash(saga.intent) !== saga.intent_hash
    || !PHASES.includes(saga.phase)
    || !Array.isArray(saga.task_records) || saga.task_records.length !== saga.intent.requested_count
    || !Array.isArray(saga.agents) || saga.agents.length !== saga.intent.requested_count) {
    fail("PLACEMENT_SAGA_INVALID", "Placement saga identity or plan is invalid");
  }
  timestamp(saga.created_at, "saga.created_at");
  timestamp(saga.updated_at, "saga.updated_at");
  saga.task_records.forEach(validateTask);
  const agentContract = validateContract("agent-registry-v3", {
    schema_version: 3,
    organization_revision: 0,
    agents: saga.agents,
  });
  if (!agentContract.ok) fail("PLACEMENT_SAGA_INVALID", "Placement saga agents failed the canonical agent contract");
  const taskByAgent = new Map(saga.task_records.map((task) => [task.assigned_agent_id, task]));
  const agents = new Set();
  for (const agent of saga.agents) {
    if (agents.has(agent.agent_id) || agent.lifecycle_state !== "provisioning"
      || agent.origin !== "controller" || agent.created_from_ref?.kind !== "task") {
      fail("PLACEMENT_SAGA_INVALID", "Placement saga agent plan is duplicated or not provisioning");
    }
    agents.add(agent.agent_id);
    const task = taskByAgent.get(agent.agent_id);
    if (!task || task.task_id !== agent.created_from_ref.id
      || task.role_id !== agent.role_id || task.role_version !== agent.role_version
      || task.placement_intent_id !== saga.placement_intent_id) {
      fail("PLACEMENT_SAGA_INVALID", `Placement task/agent provenance is inconsistent: ${agent.agent_id}`);
    }
  }
  exactKeys(saga.session_bindings, [...agents], "placement session bindings");
  exactKeys(saga.activations, [...agents], "placement activation bindings");
  validateOrganizationPlan(saga.organization_plan, saga, agents);
  let requested = 0;
  let accepted = 0;
  let activated = 0;
  for (const agentId of agents) {
    const session = saga.session_bindings[agentId];
    exactKeys(session, ["agent_id", "task_id", "request_id", "status", "binding"], "placement session entry");
    if (session.agent_id !== agentId || session.task_id !== taskByAgent.get(agentId).task_id
      || typeof session.request_id !== "string" || !session.request_id
      || !["not_requested", "requested", "accepted"].includes(session.status)
      || (session.status === "accepted") !== (session.binding !== null)) {
      fail("PLACEMENT_SAGA_INVALID", `Placement session entry is invalid: ${agentId}`);
    }
    if (session.status !== "not_requested") requested += 1;
    if (session.status === "accepted") {
      validateBinding(session.binding, agentId);
      accepted += 1;
    }
    const activation = saga.activations[agentId];
    exactKeys(activation, ["agent_id", "status", "evidence"], "placement activation entry");
    if (activation.agent_id !== agentId || !["pending", "active"].includes(activation.status)
      || (activation.status === "active") !== (activation.evidence !== null)) {
      fail("PLACEMENT_SAGA_INVALID", `Placement activation entry is invalid: ${agentId}`);
    }
    if (activation.status === "active") {
      validateOrganizationEvidence(activation.evidence, `activation evidence ${agentId}`);
      activated += 1;
    }
  }
  validateStateEvidence(saga.task_evidence, "task evidence");
  validateOrganizationEvidence(saga.organization_registration, "organization registration evidence");
  const phase = PHASES.indexOf(saga.phase);
  if ((phase === 0 && (saga.task_evidence !== null || saga.organization_registration !== null || requested !== 0 || activated !== 0))
    || (phase >= 1 && saga.task_evidence === null)
    || (phase === 1 && (saga.organization_registration !== null || requested !== 0 || activated !== 0))
    || (phase >= 2 && saga.organization_registration === null)
    || (phase === 2 && (requested !== 0 || activated !== 0))
    || (phase === 3 && requested === 0)
    || (phase >= 4 && accepted !== agents.size)
    || (phase < 4 && activated !== 0)
    || (phase >= 5 && activated !== agents.size)) {
    fail("PLACEMENT_SAGA_INVALID", `Placement saga evidence does not support phase ${saga.phase}`);
  }
  return clone(saga);
}

function assertTransition(previous, next) {
  if (next.revision !== previous.revision + 1
    || next.created_at !== previous.created_at
    || canonicalHash({
      id: next.placement_intent_id, operation: next.operation_id, version: next.operation_version,
      template: next.template_sha256, intent: next.intent, intent_hash: next.intent_hash,
       tasks: next.task_records, agents: next.agents, organization_plan: next.organization_plan,
    }) !== canonicalHash({
      id: previous.placement_intent_id, operation: previous.operation_id, version: previous.operation_version,
      template: previous.template_sha256, intent: previous.intent, intent_hash: previous.intent_hash,
       tasks: previous.task_records, agents: previous.agents, organization_plan: previous.organization_plan,
    })) {
    fail("PLACEMENT_SAGA_TRANSITION_INVALID", "Placement saga immutable plan or revision changed");
  }
  const priorPhase = PHASES.indexOf(previous.phase);
  const nextPhase = PHASES.indexOf(next.phase);
  if (nextPhase < priorPhase || nextPhase > priorPhase + 1) {
    fail("PLACEMENT_SAGA_TRANSITION_INVALID", `Placement saga phase cannot move ${previous.phase} -> ${next.phase}`);
  }
  if (previous.task_evidence !== null && canonicalHash(previous.task_evidence) !== canonicalHash(next.task_evidence)) {
    fail("PLACEMENT_SAGA_TRANSITION_INVALID", "Placement task evidence is immutable once recorded");
  }
  if (previous.organization_registration !== null
    && canonicalHash(previous.organization_registration) !== canonicalHash(next.organization_registration)) {
    fail("PLACEMENT_SAGA_TRANSITION_INVALID", "Placement organization evidence is immutable once recorded");
  }
  const sessionOrder = { not_requested: 0, requested: 1, accepted: 2 };
  for (const agentId of Object.keys(previous.session_bindings)) {
    const before = previous.session_bindings[agentId];
    const after = next.session_bindings[agentId];
    if (sessionOrder[after.status] < sessionOrder[before.status]
      || sessionOrder[after.status] > sessionOrder[before.status] + 1
      || (before.status === "accepted" && canonicalHash(before) !== canonicalHash(after))) {
      fail("PLACEMENT_SAGA_TRANSITION_INVALID", `Placement session evidence cannot roll back: ${agentId}`);
    }
    const activationBefore = previous.activations[agentId];
    const activationAfter = next.activations[agentId];
    if ((activationBefore.status === "active" && canonicalHash(activationBefore) !== canonicalHash(activationAfter))
      || (activationBefore.status === "pending" && !["pending", "active"].includes(activationAfter.status))) {
      fail("PLACEMENT_SAGA_TRANSITION_INVALID", `Placement activation evidence cannot roll back: ${agentId}`);
    }
  }
  if (canonicalHash(previous) === canonicalHash(next)) fail("PLACEMENT_SAGA_TRANSITION_INVALID", "Placement saga no-op revision is forbidden");
}

function writeAtomic(root, filePath, value, stagingPath, expectedHash) {
  const candidate = path.join(stagingPath, `.saga-${process.pid}-${crypto.randomUUID()}.tmp`);
  const descriptor = fs.openSync(candidate, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, jsonBytes(value));
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    const observed = verifyFile(root, filePath, true) ? fileHash(filePath) : null;
    if (observed !== expectedHash) fail("PLACEMENT_SAGA_REVISION_CONFLICT", "Placement saga changed before publish");
    retryOperational(() => fs.renameSync(candidate, filePath));
    syncDirectory(path.dirname(filePath));
  } finally {
    if (fs.existsSync(candidate)) {
      verifyFile(root, candidate, false);
      retryOperational(() => fs.unlinkSync(candidate));
      syncDirectory(stagingPath);
    }
  }
}

function createPlacementSagaStore({ rootPath, clock = () => new Date().toISOString() } = {}) {
  const root = trustedRoot(rootPath);
  const sagasPath = path.join(root, ".orquesta", "state", "placement-sagas");
  const stagingPath = path.join(root, ".orquesta", "runtime", "placement-saga-v1");

  function filePath(intentId) {
    if (typeof intentId !== "string" || !INTENT_ID.test(intentId)) fail("PLACEMENT_INTENT_ID_INVALID", "Placement intent id is invalid");
    return path.join(sagasPath, `${intentId}.json`);
  }

  function read(intentId) {
    const target = filePath(intentId);
    if (!verifyFile(root, target, true)) return { status: "missing", file_path: target };
    return { status: "ready", file_path: target, file_hash: fileHash(target), saga: validateSaga(readJson(root, target)) };
  }

  async function withIntentLock(intentId, operation) {
    const target = filePath(intentId);
    if (typeof operation !== "function") fail("PLACEMENT_SAGA_OPERATION_INVALID", "Placement saga operation is required");
    directoryBoundary(root, sagasPath, true);
    directoryBoundary(root, stagingPath, true);
    const lockPath = path.join(stagingPath, `saga-${intentId}-lock-v1.lock`);
    const lock = acquireExclusiveProcessLock({
      rootPath: root,
      lockPath,
      codePrefix: "PLACEMENT_SAGA",
    });
    let operationError;
    try {
      let current = read(intentId);

    function publish(next) {
      const validated = validateSaga(next);
      if (current.status === "missing") {
        if (validated.revision !== 0 || validated.phase !== "intent_recorded") {
          fail("PLACEMENT_SAGA_TRANSITION_INVALID", "New placement saga must start at revision 0 intent_recorded");
        }
      } else {
        assertTransition(current.saga, validated);
      }
      writeAtomic(root, target, validated, stagingPath, current.status === "missing" ? null : current.file_hash);
      current = { status: "ready", file_path: target, file_hash: fileHash(target), saga: validated };
      return clone(current);
    }

    function next(changes) {
      if (current.status !== "ready") fail("PLACEMENT_SAGA_NOT_INITIALIZED", "Placement saga must be created first");
      return {
        ...clone(current.saga),
        ...clone(changes),
        revision: current.saga.revision + 1,
        updated_at: clock(),
      };
    }

    const api = Object.freeze({
      read: () => clone(current),
      create: (initial) => {
        if (current.status !== "missing") return clone(current);
        return publish(initial);
      },
      recordTasks: (evidence) => {
        if (current.saga.phase !== "intent_recorded") return clone(current);
        return publish(next({ phase: "tasks_appended", task_evidence: clone(evidence) }));
      },
      recordOrganization: (evidence) => {
        if (current.saga.phase !== "tasks_appended") return clone(current);
        return publish(next({ phase: "organization_registered", organization_registration: clone(evidence) }));
      },
      markSessionRequested: (agentId) => {
        const entry = current.saga.session_bindings[agentId];
        if (!entry) fail("PLACEMENT_SAGA_AGENT_UNKNOWN", `Placement saga does not contain ${agentId}`);
        if (entry.status !== "not_requested") return clone(current);
        const sessions = clone(current.saga.session_bindings);
        sessions[agentId].status = "requested";
        return publish(next({ phase: "sessions_requested", session_bindings: sessions }));
      },
      recordSessionAccepted: (agentId, binding) => {
        const entry = current.saga.session_bindings[agentId];
        if (!entry) fail("PLACEMENT_SAGA_AGENT_UNKNOWN", `Placement saga does not contain ${agentId}`);
        if (entry.status === "accepted") {
          if (canonicalHash(entry.binding) !== canonicalHash(binding)) fail("PLACEMENT_SAGA_SESSION_CONFLICT", `Accepted binding differs for ${agentId}`);
          return clone(current);
        }
        if (entry.status !== "requested") fail("PLACEMENT_SAGA_TRANSITION_INVALID", `Session must be requested before acceptance: ${agentId}`);
        const sessions = clone(current.saga.session_bindings);
        sessions[agentId] = { ...sessions[agentId], status: "accepted", binding: clone(binding) };
        return publish(next({ phase: "sessions_requested", session_bindings: sessions }));
      },
      markSessionsAccepted: () => {
        if (current.saga.phase === "sessions_accepted" || PHASES.indexOf(current.saga.phase) > 4) return clone(current);
        return publish(next({ phase: "sessions_accepted" }));
      },
      recordActivation: (agentId, evidence) => {
        const entry = current.saga.activations[agentId];
        if (!entry) fail("PLACEMENT_SAGA_AGENT_UNKNOWN", `Placement saga does not contain ${agentId}`);
        if (entry.status === "active") {
          if (canonicalHash(entry.evidence) !== canonicalHash(evidence)) fail("PLACEMENT_SAGA_ACTIVATION_CONFLICT", `Activation evidence differs for ${agentId}`);
          return clone(current);
        }
        const activations = clone(current.saga.activations);
        activations[agentId] = { agent_id: agentId, status: "active", evidence: clone(evidence) };
        return publish(next({ activations }));
      },
      markOrganizationActivated: () => {
        if (PHASES.indexOf(current.saga.phase) >= 5) return clone(current);
        return publish(next({ phase: "organization_activated" }));
      },
      markComplete: () => {
        if (current.saga.phase === "complete") return clone(current);
        return publish(next({ phase: "complete" }));
      },
    });
      return await operation(api);
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      try {
        releaseExclusiveProcessLock(lock);
      } catch (releaseError) {
        if (!operationError) throw releaseError;
        if (operationError && typeof operationError === "object") operationError.lockReleaseError = releaseError;
      }
    }
  }

  return Object.freeze({ read, withIntentLock });
}

module.exports = {
  PHASES,
  createPlacementSagaStore,
  taskFingerprint,
};
