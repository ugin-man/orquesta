"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");

const {
  setPersistentAgentLifecycleCommand,
} = require("./organization-controller-v3");
const {
  createOrganizationV3Store,
  inspectLegacyFoundationV2Markers,
} = require("./organization-store-v3");
const {
  FOUNDATION_AGENT_IDS,
  createFoundationOrganizationV3Bundle,
} = require("./organization-v3");
const {
  acquireExclusiveProcessLock,
  releaseExclusiveProcessLock,
} = require("./exclusive-process-lock-v1");
const {
  projectRootBindingSha256,
} = require("./project-execution-context");

const BOOTSTRAP_SCHEMA_VERSION = 1;
const BOOTSTRAP_PHASES = Object.freeze([
  "organization_initialized_with_provisioning_agents",
  "foundation_sessions_provisioning",
  "foundation_sessions_bound",
  "organization_agents_activated",
  "complete",
]);
const CLASSIFICATIONS = Object.freeze([
  "fresh",
  "ready",
  "prepared",
  "incomplete",
  "legacy_v2",
  "mixed_v2",
  "partial",
  "unsupported",
]);
const HASH = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const TRANSIENT_OPERATION_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const AUTHORITY_FILES = Object.freeze([
  "agents.json",
  "organization.json",
  "formations.json",
  "organization-controller.json",
]);

function fail(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  throw error;
}

function clone(value) {
  return structuredClone(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function comparable(value) {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function canonicalRoot(projectRoot) {
  if (typeof projectRoot !== "string" || !path.isAbsolute(projectRoot)) {
    fail("FOUNDATION_BOOTSTRAP_ROOT_INVALID", "Foundation bootstrap requires an absolute native project root");
  }
  const requested = path.resolve(projectRoot);
  let canonical;
  try {
    canonical = fs.realpathSync(requested);
  } catch (cause) {
    fail("FOUNDATION_BOOTSTRAP_ROOT_UNAVAILABLE", "Foundation bootstrap project root is unavailable", cause);
  }
  const details = fs.lstatSync(requested);
  if (!details.isDirectory() || details.isSymbolicLink() || comparable(requested) !== comparable(canonical)) {
    fail("FOUNDATION_BOOTSTRAP_ROOT_UNSAFE", "Foundation bootstrap project root must be a canonical real directory");
  }
  return canonical;
}

function assertInside(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    fail("FOUNDATION_BOOTSTRAP_PATH_UNSAFE", "Foundation bootstrap path escaped the native project root");
  }
}

function pathsFor(rootPath) {
  const root = canonicalRoot(rootPath);
  const state = path.join(root, ".orquesta", "state");
  const staging = path.join(root, ".orquesta", "runtime", "foundation-bootstrap-v3");
  return {
    root,
    state,
    staging,
    saga: path.join(state, "project-bootstrap.json"),
    lock: path.join(staging, "foundation-bootstrap-lock-v1.lock"),
  };
}

function verifyDirectory(rootPath, directoryPath, allowMissing = true) {
  assertInside(rootPath, directoryPath);
  if (!fs.existsSync(directoryPath)) {
    if (allowMissing) return false;
    fail("FOUNDATION_BOOTSTRAP_PATH_UNSAFE", `Required directory is missing: ${directoryPath}`);
  }
  const details = fs.lstatSync(directoryPath);
  if (!details.isDirectory() || details.isSymbolicLink()
    || comparable(fs.realpathSync(directoryPath)) !== comparable(directoryPath)) {
    fail("FOUNDATION_BOOTSTRAP_PATH_UNSAFE", `Foundation bootstrap directory is unsafe: ${directoryPath}`);
  }
  return true;
}

function verifyFile(rootPath, filePath, allowMissing = true) {
  assertInside(rootPath, filePath);
  if (!fs.existsSync(filePath)) {
    if (allowMissing) return false;
    fail("FOUNDATION_BOOTSTRAP_STATE_MISSING", `Required file is missing: ${filePath}`);
  }
  const details = fs.lstatSync(filePath);
  if (!details.isFile() || details.isSymbolicLink()
    || comparable(fs.realpathSync(filePath)) !== comparable(filePath)) {
    fail("FOUNDATION_BOOTSTRAP_PATH_UNSAFE", `Foundation bootstrap file is unsafe: ${filePath}`);
  }
  return true;
}

function exactKeys(value, expected, label) {
  const keys = value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value).sort()
    : [];
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    fail("FOUNDATION_BOOTSTRAP_STATE_INVALID", `${label} has an invalid exact shape`);
  }
}

function assertSafeId(value, label) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    fail("FOUNDATION_BOOTSTRAP_INPUT_INVALID", `${label} is invalid`);
  }
  return value;
}

function assertTimestamp(value, label) {
  if (typeof value !== "string" || !UTC.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail("FOUNDATION_BOOTSTRAP_STATE_INVALID", `${label} must be a canonical UTC timestamp`);
  }
  return value;
}

function nowIso(clock) {
  const value = clock();
  const iso = value instanceof Date ? value.toISOString() : String(value);
  assertTimestamp(iso, "clock result");
  return iso;
}

function defaultBootstrapId(projectId) {
  return `foundation-${sha256(projectId).slice(0, 12)}`;
}

function foundationRequestId(bootstrapId, agentId) {
  return `foundation-session-${sha256(`${bootstrapId}\u0000${agentId}`).slice(0, 20)}`;
}

function readJson(rootPath, filePath) {
  verifyFile(rootPath, filePath, false);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/u, ""));
  } catch (cause) {
    fail("FOUNDATION_BOOTSTRAP_STATE_INVALID", `Cannot read Foundation bootstrap JSON: ${filePath}`, cause);
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

function retryOperational(operation) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      if (!TRANSIENT_OPERATION_CODES.has(error.code) || attempt >= 5) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(80, 5 * (2 ** attempt)));
    }
  }
}

function ensureOwnedDirectories(paths) {
  for (const directoryPath of [path.join(paths.root, ".orquesta"), paths.state, path.join(paths.root, ".orquesta", "runtime"), paths.staging]) {
    assertInside(paths.root, directoryPath);
    if (!fs.existsSync(directoryPath)) fs.mkdirSync(directoryPath);
    verifyDirectory(paths.root, directoryPath, false);
  }
}

function writeAtomic(paths, value) {
  ensureOwnedDirectories(paths);
  if (fs.existsSync(paths.saga)) verifyFile(paths.root, paths.saga, false);
  const candidate = path.join(paths.staging, `.bootstrap-state-${process.pid}-${crypto.randomUUID()}.json`);
  const descriptor = fs.openSync(candidate, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    retryOperational(() => fs.renameSync(candidate, paths.saga));
    syncDirectory(paths.state);
  } finally {
    if (fs.existsSync(candidate)) {
      verifyFile(paths.root, candidate, false);
      retryOperational(() => fs.unlinkSync(candidate));
    }
  }
}

function cleanOwnedStagingCandidates(paths) {
  if (!fs.existsSync(paths.staging)) return false;
  verifyDirectory(paths.root, paths.staging, false);
  let changed = false;
  for (const name of fs.readdirSync(paths.staging)) {
    if (!/^\.bootstrap-state-\d+-[a-f0-9-]{36}\.json$/u.test(name)) continue;
    const candidate = path.join(paths.staging, name);
    verifyFile(paths.root, candidate, false);
    retryOperational(() => fs.unlinkSync(candidate));
    changed = true;
  }
  if (changed) syncDirectory(paths.staging);
  return changed;
}

function normalizeAcceptedBinding(value, expectedAgentId, expectedRuntimeAuthorityId = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("FOUNDATION_BOOTSTRAP_SESSION_INVALID", `Session port did not return an accepted binding for ${expectedAgentId}`);
  }
  const status = value.status ?? value.handoff_status;
  const normalized = {
    status: "accepted",
    agent_id: value.agent_id,
    thread_id: value.thread_id,
    session_id: value.session_id,
    handoff_turn_id: value.handoff_turn_id,
    accepted_at: value.accepted_at,
    runtime_authority_id: value.runtime_authority_id,
  };
  if (status !== "accepted" || normalized.agent_id !== expectedAgentId
    || (expectedRuntimeAuthorityId !== null && normalized.runtime_authority_id !== expectedRuntimeAuthorityId)) {
    fail("FOUNDATION_BOOTSTRAP_SESSION_INVALID", `Session binding identity is invalid for ${expectedAgentId}`);
  }
  for (const field of ["agent_id", "thread_id", "session_id", "handoff_turn_id", "runtime_authority_id"]) {
    assertSafeId(normalized[field], `binding.${field}`);
  }
  assertTimestamp(normalized.accepted_at, "binding.accepted_at");
  return normalized;
}

function controllerAcceptedBinding(binding) {
  return {
    status: binding.status,
    agent_id: binding.agent_id,
    thread_id: binding.thread_id,
    session_id: binding.session_id,
    accepted_at: binding.accepted_at,
  };
}

function validateSaga(value, { projectId = null } = {}) {
  exactKeys(value, [
    "schema_version", "revision", "project_id", "bootstrap_id", "phase", "organization",
    "session_bindings", "activations", "created_at", "updated_at",
  ], "project bootstrap saga");
  if (value.schema_version !== BOOTSTRAP_SCHEMA_VERSION
    || !Number.isSafeInteger(value.revision) || value.revision < 0
    || !BOOTSTRAP_PHASES.includes(value.phase)) {
    fail("FOUNDATION_BOOTSTRAP_STATE_INVALID", "Project bootstrap saga header is invalid");
  }
  assertSafeId(value.project_id, "saga.project_id");
  assertSafeId(value.bootstrap_id, "saga.bootstrap_id");
  if (projectId !== null && value.project_id !== projectId) {
    fail("FOUNDATION_BOOTSTRAP_PROJECT_CONFLICT", "Project bootstrap saga belongs to a different project");
  }
  assertTimestamp(value.created_at, "saga.created_at");
  assertTimestamp(value.updated_at, "saga.updated_at");
  if (value.updated_at < value.created_at) fail("FOUNDATION_BOOTSTRAP_STATE_INVALID", "Project bootstrap chronology is invalid");
  exactKeys(value.organization, ["revision", "head_hash"], "saga.organization");
  if (!Number.isSafeInteger(value.organization.revision) || value.organization.revision < 1
    || typeof value.organization.head_hash !== "string" || !HASH.test(value.organization.head_hash)) {
    fail("FOUNDATION_BOOTSTRAP_STATE_INVALID", "Project bootstrap organization evidence is invalid");
  }
  exactKeys(value.session_bindings, FOUNDATION_AGENT_IDS, "saga.session_bindings");
  exactKeys(value.activations, FOUNDATION_AGENT_IDS, "saga.activations");
  let acceptedCount = 0;
  let activeCount = 0;
  for (const agentId of FOUNDATION_AGENT_IDS) {
    const entry = value.session_bindings[agentId];
    exactKeys(entry, ["request_id", "status", "binding"], `saga.session_bindings.${agentId}`);
    if (entry.request_id !== foundationRequestId(value.bootstrap_id, agentId)
      || !["not_requested", "requested", "accepted"].includes(entry.status)
      || (entry.status === "accepted") !== (entry.binding !== null)) {
      fail("FOUNDATION_BOOTSTRAP_STATE_INVALID", `Foundation session saga entry is invalid for ${agentId}`);
    }
    if (entry.binding !== null) {
      entry.binding = normalizeAcceptedBinding(entry.binding, agentId);
      acceptedCount += 1;
    }
    const activation = value.activations[agentId];
    exactKeys(activation, ["status", "command", "evidence"], `saga.activations.${agentId}`);
    if (!["pending", "requested", "active"].includes(activation.status)
      || (activation.status === "pending") !== (activation.command === null)
      || (activation.status === "active") !== (activation.evidence !== null)) {
      fail("FOUNDATION_BOOTSTRAP_STATE_INVALID", `Foundation activation saga entry is invalid for ${agentId}`);
    }
    if (activation.command !== null) {
      const command = activation.command;
      if (command.kind !== "set_persistent_agent_lifecycle"
        || command.payload?.agent_id !== agentId
        || command.payload?.lifecycle_state !== "active"
        || !isDeepStrictEqual(command.payload?.accepted_session_binding, controllerAcceptedBinding(value.session_bindings[agentId].binding))) {
        fail("FOUNDATION_BOOTSTRAP_STATE_INVALID", `Foundation activation command is invalid for ${agentId}`);
      }
    }
    if (activation.evidence !== null) {
      exactKeys(activation.evidence, ["organization_revision", "head_hash", "command_id"], `saga.activations.${agentId}.evidence`);
      if (!Number.isSafeInteger(activation.evidence.organization_revision) || activation.evidence.organization_revision < 1
        || typeof activation.evidence.head_hash !== "string" || !HASH.test(activation.evidence.head_hash)
        || activation.evidence.command_id !== activation.command.command_id) {
        fail("FOUNDATION_BOOTSTRAP_STATE_INVALID", `Foundation activation evidence is invalid for ${agentId}`);
      }
      activeCount += 1;
    }
  }
  const phaseIndex = BOOTSTRAP_PHASES.indexOf(value.phase);
  if (phaseIndex >= BOOTSTRAP_PHASES.indexOf("foundation_sessions_bound") && acceptedCount !== FOUNDATION_AGENT_IDS.length) {
    fail("FOUNDATION_BOOTSTRAP_STATE_INVALID", "Bound Foundation bootstrap phase requires every accepted session binding");
  }
  if (phaseIndex >= BOOTSTRAP_PHASES.indexOf("organization_agents_activated") && activeCount !== FOUNDATION_AGENT_IDS.length) {
    fail("FOUNDATION_BOOTSTRAP_STATE_INVALID", "Activated Foundation bootstrap phase requires every activation receipt");
  }
  return value;
}

function readSaga(paths, projectId = null) {
  if (!fs.existsSync(paths.saga)) return null;
  return validateSaga(readJson(paths.root, paths.saga), { projectId });
}

function organizationEvidence(snapshot) {
  return {
    revision: snapshot.bundle.organization.revision,
    head_hash: snapshot.head_hash,
  };
}

function initialSaga({ projectId, bootstrapId, organization, createdAt }) {
  const sessionBindings = {};
  const activations = {};
  for (const agentId of FOUNDATION_AGENT_IDS) {
    sessionBindings[agentId] = {
      request_id: foundationRequestId(bootstrapId, agentId),
      status: "not_requested",
      binding: null,
    };
    activations[agentId] = { status: "pending", command: null, evidence: null };
  }
  return validateSaga({
    schema_version: BOOTSTRAP_SCHEMA_VERSION,
    revision: 0,
    project_id: projectId,
    bootstrap_id: bootstrapId,
    phase: "organization_initialized_with_provisioning_agents",
    organization,
    session_bindings: sessionBindings,
    activations,
    created_at: createdAt,
    updated_at: createdAt,
  }, { projectId });
}

function mutateSaga(paths, saga, clock, mutation) {
  const next = clone(saga);
  mutation(next);
  next.revision = saga.revision + 1;
  next.updated_at = nowIso(clock);
  validateSaga(next, { projectId: saga.project_id });
  writeAtomic(paths, next);
  return next;
}

function phaseAtLeast(current, minimum) {
  return BOOTSTRAP_PHASES.indexOf(current) >= BOOTSTRAP_PHASES.indexOf(minimum);
}

function sessionAuthorityMayBeCreated(saga) {
  return saga.phase === "organization_initialized_with_provisioning_agents"
    && FOUNDATION_AGENT_IDS.every((agentId) => saga.session_bindings[agentId].status === "not_requested");
}

function mutationChanged(result) {
  return result !== null && typeof result === "object" && result.changed === true;
}

function exactFoundationState(snapshot, { lifecycle = null } = {}) {
  if (snapshot?.status !== "ready") return false;
  const { bundle } = snapshot;
  if (bundle.agentRegistry.agents.length !== FOUNDATION_AGENT_IDS.length
    || bundle.organization.participants.length !== 1
    || bundle.organization.lines.length !== 0
    || bundle.organization.teams.length !== 0
    || bundle.organization.memberships.length !== 0
    || bundle.organization.relationships.length !== 1
    || bundle.formations.formations.length !== 0) return false;
  return FOUNDATION_AGENT_IDS.every((agentId) => {
    const agent = bundle.agentRegistry.agents.find((record) => record.agent_id === agentId);
    return agent?.origin === "foundation"
      && agent.role_id === agentId
      && agent.created_from_ref?.kind === "project_bootstrap"
      && (lifecycle === null || agent.lifecycle_state === lifecycle);
  });
}

function foundationAgentsActive(snapshot) {
  return snapshot?.status === "ready" && FOUNDATION_AGENT_IDS.every((agentId) => (
    snapshot.bundle.agentRegistry.agents.some((agent) => agent.agent_id === agentId && agent.lifecycle_state === "active")
  ));
}

function activationReceiptsMatch(snapshot, saga) {
  return snapshot?.status === "ready" && FOUNDATION_AGENT_IDS.every((agentId) => {
    const activation = saga.activations[agentId];
    return activation.status === "active"
      && snapshot.controller.applied_command_ids.includes(activation.command.command_id)
      && activation.evidence.command_id === activation.command.command_id
      && activation.evidence.organization_revision <= snapshot.bundle.organization.revision;
  });
}

function verifyWriterLeaseMarker(paths, projectId, expectedOwnerPid = null) {
  const leaseRoot = path.join(paths.state, "desktop-writer.lock");
  if (!fs.existsSync(leaseRoot)) {
    if (expectedOwnerPid !== null) {
      fail("FOUNDATION_BOOTSTRAP_STATE_INVALID", "Desktop writer lease is required for a mutating bootstrap run");
    }
    return;
  }
  verifyDirectory(paths.root, leaseRoot, false);
  const entries = fs.readdirSync(leaseRoot).sort();
  if (!isDeepStrictEqual(entries, ["owner.json"])) {
    fail("FOUNDATION_BOOTSTRAP_STATE_INVALID", "Desktop writer lease has an invalid exact shape");
  }
  const owner = readJson(paths.root, path.join(leaseRoot, "owner.json"));
  exactKeys(owner, [
    "schema_version",
    "pid",
    "nonce",
    "project_id",
    "canonical_root",
    "acquired_at",
  ], "Desktop writer lease owner");
  if (owner.schema_version !== 1
    || !Number.isSafeInteger(owner.pid)
    || owner.pid <= 0
    || (expectedOwnerPid !== null && owner.pid !== expectedOwnerPid)
    || typeof owner.nonce !== "string"
    || !SAFE_ID.test(owner.nonce)
    || typeof owner.project_id !== "string"
    || !SAFE_ID.test(owner.project_id)
    || (projectId !== null && owner.project_id !== projectId)
    || typeof owner.canonical_root !== "string"
    || !path.isAbsolute(owner.canonical_root)
    || comparable(owner.canonical_root) !== comparable(paths.root)) {
    fail("FOUNDATION_BOOTSTRAP_STATE_INVALID", expectedOwnerPid === null
      ? "Desktop writer lease marker is not bound to this project"
      : "Desktop writer lease is not owned by this project process");
  }
  assertTimestamp(owner.acquired_at, "Desktop writer lease acquired_at");
}

function markerInventory(paths, projectId, expectedWriterPid = null) {
  const result = {
    authority: Object.fromEntries(AUTHORITY_FILES.map((name) => [name, false])),
    transition: false,
    legacy: [],
    v3_authority: [],
    unsupported_authority: [],
  };
  // Read-only classification may inspect an unleased project. A bootstrap run
  // supplies the current process id and must prove that this exact process owns
  // the outer Desktop writer lease before any canonical mutation can begin.
  verifyWriterLeaseMarker(paths, projectId, expectedWriterPid);
  const orquestaRoot = path.join(paths.root, ".orquesta");
  if (!fs.existsSync(orquestaRoot)) return result;
  verifyDirectory(paths.root, orquestaRoot, false);
  result.legacy.push(...inspectLegacyFoundationV2Markers(paths.root));
  if (!fs.existsSync(paths.state)) return result;
  verifyDirectory(paths.root, paths.state, false);
  for (const name of AUTHORITY_FILES) result.authority[name] = fs.existsSync(path.join(paths.state, name));
  result.transition = fs.existsSync(path.join(paths.state, "organization-controller-transition.json"));
  for (const name of ["agents.json", "organization.json"]) {
    const authorityPath = path.join(paths.state, name);
    if (!fs.existsSync(authorityPath)) continue;
    const raw = readJson(paths.root, authorityPath);
    if (raw?.schema_version === 3) result.v3_authority.push(name);
    else if (raw?.schema_version === 2) result.legacy.push(`${name}:schema=2`);
    else result.unsupported_authority.push(`${name}:schema=${String(raw?.schema_version ?? "missing")}`);
  }
  for (const name of ["formations.json", "organization-controller.json"]) {
    if (fs.existsSync(path.join(paths.state, name))) result.v3_authority.push(name);
  }
  return result;
}

function classification(status, reason, extra = {}) {
  if (!CLASSIFICATIONS.includes(status)) fail("FOUNDATION_BOOTSTRAP_CLASSIFICATION_INVALID", "Unknown classification");
  return { status, reason, no_write: true, ...extra };
}

function classifyFoundationBootstrapV3({
  projectRoot,
  projectId = null,
  organizationStore = null,
  validatedRuntimeBindingSha256 = null,
  expectedWriterPid = null,
} = {}) {
  const paths = pathsFor(projectRoot);
  if (projectId !== null) assertSafeId(projectId, "projectId");
  const store = organizationStore ?? createOrganizationV3Store({
    rootPath: paths.root,
    validatedRuntimeBindingSha256,
  });
  if (store.project_root_binding_sha256 !== projectRootBindingSha256(paths.root)) {
    return classification("unsupported", "organization_store_root_binding_mismatch");
  }
  let markers;
  let snapshot;
  let saga;
  try {
    markers = markerInventory(paths, projectId, expectedWriterPid);
    snapshot = store.inspect();
    saga = readSaga(paths, projectId);
  } catch (error) {
    return classification("unsupported", error.code || "state_unreadable", { error_code: error.code || null });
  }
  const authorityCount = Object.values(markers.authority).filter(Boolean).length;
  const hasAnyAuthority = authorityCount > 0;
  const hasAllAuthority = authorityCount === AUTHORITY_FILES.length;
  if (markers.unsupported_authority.length > 0) {
    return classification("unsupported", "organization_authority_schema_unsupported", {
      unsupported_authority: markers.unsupported_authority,
    });
  }
  const legacySchemaAuthority = markers.legacy.filter((name) => name.endsWith(":schema=2"));
  if (snapshot.status === "migration_required"
    && markers.v3_authority.length === 0
    && (legacySchemaAuthority.length > 0 || snapshot.reason === "foundation_v2_migration_required")) {
    return classification("legacy_v2", "organization_v2_migration_required", {
      legacy_markers: markers.legacy,
    });
  }
  if (markers.legacy.length > 0 && (hasAnyAuthority || markers.transition || saga !== null)) {
    return classification("mixed_v2", "legacy_and_v3_authority_mixed", { legacy_markers: markers.legacy });
  }
  if (snapshot.status === "recovery_required") {
    return classification("prepared", "organization_transition_recovery_required", {
      transition: snapshot.transition ?? null,
      ...(saga === null ? {} : { saga }),
    });
  }
  if (snapshot.status === "ready") {
    if (markers.legacy.length > 0) return classification("mixed_v2", "legacy_marker_present", { legacy_markers: markers.legacy });
    if (!hasAllAuthority) return classification("partial", "organization_v3_authority_partial");
    if (saga === null) {
      return exactFoundationState(snapshot, { lifecycle: "provisioning" })
        ? classification("incomplete", "foundation_organization_committed_before_saga", { organization: snapshot })
        : classification("partial", "organization_ready_without_project_bootstrap_saga");
    }
    const provenanceIds = new Set(snapshot.bundle.agentRegistry.agents
      .filter((agent) => FOUNDATION_AGENT_IDS.includes(agent.agent_id))
      .map((agent) => agent.created_from_ref?.id));
    if (provenanceIds.size !== 1 || !provenanceIds.has(saga.bootstrap_id)
      || snapshot.bundle.organization.revision < saga.organization.revision) {
      return classification("partial", "project_bootstrap_organization_binding_mismatch");
    }
    if (saga.phase === "complete") {
      return foundationAgentsActive(snapshot) && activationReceiptsMatch(snapshot, saga)
        ? classification("ready", "foundation_bootstrap_complete", { saga, organization: snapshot })
        : classification("partial", "complete_saga_without_active_foundation_organization");
    }
    return classification("incomplete", "foundation_bootstrap_saga_incomplete", { saga, organization: snapshot });
  }
  if (snapshot.status === "migration_required") {
    if (markers.legacy.length > 0) {
      return classification("mixed_v2", "legacy_or_orphan_authority_requires_migration", { legacy_markers: markers.legacy });
    }
    return classification("partial", snapshot.reason || "organization_v3_authority_partial");
  }
  if (saga !== null && !hasAnyAuthority) return classification("partial", "orphan_project_bootstrap_saga");
  if (snapshot.status === "unsupported") return classification("unsupported", snapshot.reason || "organization_state_unsupported");
  if (hasAnyAuthority || markers.transition) return classification("partial", "partial_foundation_authority_present");
  if (markers.legacy.length > 0) {
    return classification("mixed_v2", "legacy_or_orphan_authority_requires_migration", { legacy_markers: markers.legacy });
  }
  if (snapshot.status !== "missing") return classification("unsupported", `organization_store_${snapshot.status}`);
  return classification("fresh", "all_foundation_authority_absent");
}

function assertSessionPort(sessionPort, { projectId, rootBinding }) {
  if (!sessionPort || typeof sessionPort.ensureAuthority !== "function"
    || typeof sessionPort.findAcceptedFoundationBinding !== "function"
    || typeof sessionPort.provisionFoundationAgent !== "function") {
    fail("FOUNDATION_BOOTSTRAP_SESSION_PORT_INVALID", "Foundation bootstrap requires the canonical injected session port");
  }
  if (sessionPort.project_id !== projectId) {
    fail("FOUNDATION_BOOTSTRAP_SESSION_PORT_INVALID", "Foundation session port project id does not match native authority");
  }
  if (sessionPort.project_root_binding_sha256 !== rootBinding) {
    fail("FOUNDATION_BOOTSTRAP_SESSION_PORT_INVALID", "Foundation session port root binding does not match native authority");
  }
  assertSafeId(sessionPort.runtime_authority_id, "sessionPort.runtime_authority_id");
}

function failpoint(value, expected) {
  if (value === expected) fail("FOUNDATION_BOOTSTRAP_FAILPOINT", `Simulated interruption at ${expected}`);
}

function failClosedResult(observed, noWrite = true) {
  if (["legacy_v2", "mixed_v2", "partial"].includes(observed.status)) {
    return { status: "migration_required", classification: observed.status, reason: observed.reason, no_write: noWrite };
  }
  if (observed.status === "unsupported") {
    return { status: "unsupported", classification: observed.status, reason: observed.reason, no_write: noWrite };
  }
  return null;
}

async function verifyRecordedBindings({ saga, sessionPort, projectId }) {
  const bindings = {};
  for (const agentId of FOUNDATION_AGENT_IDS) {
    const entry = saga.session_bindings[agentId];
    if (entry.status !== "accepted") return { ok: false, reason: `binding_not_recorded:${agentId}` };
    const observed = await sessionPort.findAcceptedFoundationBinding({
      projectId,
      bootstrapId: saga.bootstrap_id,
      requestId: entry.request_id,
      agentId,
    });
    if (!observed) return { ok: false, reason: `accepted_binding_missing:${agentId}` };
    const normalized = normalizeAcceptedBinding(observed, agentId, sessionPort.runtime_authority_id);
    if (!isDeepStrictEqual(normalized, entry.binding)) return { ok: false, reason: `accepted_binding_mismatch:${agentId}` };
    bindings[agentId] = normalized;
  }
  return { ok: true, bindings };
}

function readyResult(observed, bindings, noWrite) {
  return {
    status: "ready",
    classification: "ready",
    no_write: noWrite,
    project_id: observed.saga.project_id,
    bootstrap_id: observed.saga.bootstrap_id,
    agent_ids: [...FOUNDATION_AGENT_IDS],
    organization_revision: observed.organization.bundle.organization.revision,
    organization_head_hash: observed.organization.head_hash,
    saga_revision: observed.saga.revision,
    session_bindings: bindings,
  };
}

async function runFoundationBootstrapV3({
  projectRoot,
  projectId,
  validatedRuntimeBindingSha256 = null,
  bootstrapId = null,
  userDisplayName = "User",
  organizationStore = null,
  sessionPort,
  sessionAuthorityPolicy,
  clock = () => new Date(),
  failpoint: configuredFailpoint = null,
} = {}) {
  const paths = pathsFor(projectRoot);
  assertSafeId(projectId, "projectId");
  const resolvedBootstrapId = bootstrapId === null ? defaultBootstrapId(projectId) : assertSafeId(bootstrapId, "bootstrapId");
  if (typeof userDisplayName !== "string" || !userDisplayName.trim()) {
    fail("FOUNDATION_BOOTSTRAP_INPUT_INVALID", "userDisplayName is required");
  }
  if (!["create_fresh", "migrate_only", "require_existing"].includes(sessionAuthorityPolicy)) {
    fail("FOUNDATION_BOOTSTRAP_INPUT_INVALID", "sessionAuthorityPolicy is invalid");
  }
  const rootBinding = projectRootBindingSha256(paths.root);
  const store = organizationStore ?? createOrganizationV3Store({
    rootPath: paths.root,
    validatedRuntimeBindingSha256,
    clock: () => nowIso(clock),
  });
  if (store.project_root_binding_sha256 !== rootBinding) {
    fail("FOUNDATION_BOOTSTRAP_ORGANIZATION_PORT_INVALID", "Organization store root binding does not match native authority");
  }
  assertSessionPort(sessionPort, { projectId, rootBinding });
  const classify = () => classifyFoundationBootstrapV3({
    projectRoot: paths.root,
    projectId,
    organizationStore: store,
    validatedRuntimeBindingSha256,
    // The public classifier is a read-only preflight and may legitimately see
    // a stale owner from the previous process. Mutating bootstrap runs happen
    // only after Core acquires/reaps the lease, so this boundary must require
    // the current runtime process as the exact owner.
    expectedWriterPid: process.pid,
  });

  let observed = classify();
  const rejected = failClosedResult(observed);
  if (rejected) return rejected;
  if (observed.status === "ready") {
    if (observed.saga.bootstrap_id !== resolvedBootstrapId) {
      return { status: "unsupported", classification: "unsupported", reason: "bootstrap_identity_conflict", no_write: true };
    }
    if (sessionAuthorityPolicy === "create_fresh") {
      return { status: "repair_required", classification: "ready", reason: "session_binding_authority_missing_after_foundation_ready", no_write: true };
    }
    const initialization = await sessionPort.ensureAuthority({ projectId, policy: sessionAuthorityPolicy });
    const sessionStateChanged = mutationChanged(initialization);
    const verified = await verifyRecordedBindings({ saga: observed.saga, sessionPort, projectId });
    return verified.ok
      ? readyResult(observed, verified.bindings, !sessionStateChanged)
      : { status: "repair_required", classification: "ready", reason: verified.reason, no_write: !sessionStateChanged };
  }

  const lock = acquireExclusiveProcessLock({
    rootPath: paths.root,
    lockPath: paths.lock,
    codePrefix: "FOUNDATION_BOOTSTRAP",
    now: () => new Date(nowIso(clock)),
  });
  let operationError;
  let changed = false;
  try {
    changed = cleanOwnedStagingCandidates(paths) || changed;
    observed = classify();
    if (observed.status === "prepared") {
      const recovery = store.recover();
      changed = recovery?.status !== "no_recovery_required" || changed;
      observed = classify();
    }
    const lockedRejected = failClosedResult(observed, !changed);
    if (lockedRejected) return lockedRejected;
    if (observed.status === "prepared") {
      return { status: "recovery_required", classification: "prepared", reason: observed.reason, no_write: !changed };
    }

    let saga = observed.saga ?? null;
    let snapshot = observed.organization ?? store.inspect();
    if (observed.status === "fresh") {
      const createdAt = nowIso(clock);
      const bundle = createFoundationOrganizationV3Bundle({
        createdAt,
        bootstrapId: resolvedBootstrapId,
        userDisplayName: userDisplayName.trim(),
      });
      store.initialize({
        bundle,
        commandId: `project-bootstrap-v3-${sha256(projectId).slice(0, 12)}`,
      });
      changed = true;
      failpoint(configuredFailpoint, "after_organization_initialized");
      snapshot = store.inspect();
      if (!exactFoundationState(snapshot, { lifecycle: "provisioning" })) {
        fail("FOUNDATION_BOOTSTRAP_ORGANIZATION_INVALID", "Fresh Foundation organization did not settle in provisioning state");
      }
      saga = initialSaga({
        projectId,
        bootstrapId: resolvedBootstrapId,
        organization: organizationEvidence(snapshot),
        createdAt,
      });
      writeAtomic(paths, saga);
      failpoint(configuredFailpoint, "after_saga_created");
    } else if (observed.status === "incomplete" && saga === null) {
      if (!exactFoundationState(snapshot, { lifecycle: "provisioning" })) {
        return { status: "migration_required", classification: "partial", reason: "unrecoverable_foundation_organization_without_saga", no_write: !changed };
      }
      const provenanceIds = new Set(snapshot.bundle.agentRegistry.agents.map((agent) => agent.created_from_ref?.id));
      if (provenanceIds.size !== 1 || !provenanceIds.has(resolvedBootstrapId)) {
        return { status: "unsupported", classification: "unsupported", reason: "bootstrap_identity_conflict", no_write: !changed };
      }
      const createdAt = snapshot.bundle.organization.participants[0].joined_at;
      saga = initialSaga({
        projectId,
        bootstrapId: resolvedBootstrapId,
        organization: organizationEvidence(snapshot),
        createdAt,
      });
      writeAtomic(paths, saga);
      changed = true;
      failpoint(configuredFailpoint, "after_saga_created");
    }
    if (!saga) fail("FOUNDATION_BOOTSTRAP_STATE_INVALID", "Foundation bootstrap saga is unavailable after initialization");
    if (saga.bootstrap_id !== resolvedBootstrapId) {
      return { status: "unsupported", classification: "unsupported", reason: "bootstrap_identity_conflict", no_write: !changed };
    }

    if (!sessionAuthorityMayBeCreated(saga) && sessionAuthorityPolicy === "create_fresh") {
      return {
        status: "repair_required",
        classification: observed.status,
        reason: "session_binding_authority_missing_after_foundation_progress",
        no_write: !changed,
      };
    }
    const sessionInitialization = await sessionPort.ensureAuthority({ projectId, policy: sessionAuthorityPolicy });
    changed = mutationChanged(sessionInitialization) || changed;
    for (const agentId of FOUNDATION_AGENT_IDS) {
      let entry = saga.session_bindings[agentId];
      if (entry.status === "not_requested") {
        saga = mutateSaga(paths, saga, clock, (next) => {
          next.phase = "foundation_sessions_provisioning";
          next.session_bindings[agentId].status = "requested";
        });
        changed = true;
        entry = saga.session_bindings[agentId];
        failpoint(configuredFailpoint, `after_session_requested:${agentId}`);
      }
      let accepted = await sessionPort.findAcceptedFoundationBinding({
        projectId,
        bootstrapId: saga.bootstrap_id,
        requestId: entry.request_id,
        agentId,
      });
      if (!accepted && entry.status === "accepted") {
        return { status: "repair_required", classification: "incomplete", reason: `accepted_binding_missing:${agentId}`, no_write: !changed };
      }
      if (!accepted) {
        const agent = snapshot.bundle.agentRegistry.agents.find((record) => record.agent_id === agentId);
        const acknowledged = normalizeAcceptedBinding(await sessionPort.provisionFoundationAgent({
          projectId,
          bootstrapId: saga.bootstrap_id,
          requestId: entry.request_id,
          agent: clone(agent),
        }), agentId, sessionPort.runtime_authority_id);
        accepted = await sessionPort.findAcceptedFoundationBinding({
          projectId,
          bootstrapId: saga.bootstrap_id,
          requestId: entry.request_id,
          agentId,
        });
        if (!accepted || !isDeepStrictEqual(normalizeAcceptedBinding(accepted, agentId, sessionPort.runtime_authority_id), acknowledged)) {
          fail("FOUNDATION_BOOTSTRAP_SESSION_PERSISTENCE_MISMATCH", `Session authority did not preserve the accepted binding for ${agentId}`);
        }
      }
      accepted = normalizeAcceptedBinding(accepted, agentId, sessionPort.runtime_authority_id);
      if (entry.status === "accepted") {
        if (!isDeepStrictEqual(entry.binding, accepted)) {
          return { status: "repair_required", classification: "incomplete", reason: `accepted_binding_mismatch:${agentId}`, no_write: !changed };
        }
      } else {
        saga = mutateSaga(paths, saga, clock, (next) => {
          next.session_bindings[agentId] = { ...next.session_bindings[agentId], status: "accepted", binding: accepted };
        });
        changed = true;
        failpoint(configuredFailpoint, `after_session_accepted:${agentId}`);
      }
    }
    if (!phaseAtLeast(saga.phase, "foundation_sessions_bound")) {
      saga = mutateSaga(paths, saga, clock, (next) => { next.phase = "foundation_sessions_bound"; });
      changed = true;
    }

    for (const agentId of FOUNDATION_AGENT_IDS) {
      let activation = saga.activations[agentId];
      snapshot = store.inspect();
      if (snapshot.status !== "ready") fail("FOUNDATION_BOOTSTRAP_ORGANIZATION_INVALID", `Organization store became ${snapshot.status}`);
      let agent = snapshot.bundle.agentRegistry.agents.find((record) => record.agent_id === agentId);
      if (!agent || !["provisioning", "active"].includes(agent.lifecycle_state)) {
        return { status: "repair_required", classification: "incomplete", reason: `foundation_agent_lifecycle_invalid:${agentId}`, no_write: !changed };
      }
      if (activation.status === "active") {
        if (agent.lifecycle_state !== "active"
          || !snapshot.controller.applied_command_ids.includes(activation.command.command_id)) {
          return { status: "repair_required", classification: "incomplete", reason: `foundation_activation_receipt_mismatch:${agentId}`, no_write: !changed };
        }
        continue;
      }
      if (activation.status === "pending") {
        if (agent.lifecycle_state === "active") {
          return { status: "repair_required", classification: "incomplete", reason: `unrecorded_foundation_activation:${agentId}`, no_write: !changed };
        }
        const command = setPersistentAgentLifecycleCommand({
          expectedRevision: snapshot.bundle.organization.revision,
          expectedHeadHash: snapshot.head_hash,
          agentId,
          lifecycleState: "active",
          changedAt: [nowIso(clock), saga.session_bindings[agentId].binding.accepted_at].sort().at(-1),
          acceptedSessionBinding: controllerAcceptedBinding(saga.session_bindings[agentId].binding),
        });
        saga = mutateSaga(paths, saga, clock, (next) => {
          next.activations[agentId] = { status: "requested", command, evidence: null };
        });
        changed = true;
        activation = saga.activations[agentId];
        failpoint(configuredFailpoint, `after_activation_requested:${agentId}`);
      }
      if (activation.status === "requested") {
        snapshot = store.inspect();
        agent = snapshot.status === "ready"
          ? snapshot.bundle.agentRegistry.agents.find((record) => record.agent_id === agentId)
          : null;
        const commandApplied = snapshot.status === "ready"
          && snapshot.controller.applied_command_ids.includes(activation.command.command_id);
        if (!commandApplied) {
          if (agent?.lifecycle_state !== "provisioning") {
            return { status: "repair_required", classification: "incomplete", reason: `foundation_activation_conflict:${agentId}`, no_write: !changed };
          }
          try {
            store.commit(activation.command);
          } catch (error) {
            if (!["ORGANIZATION_REVISION_CONFLICT", "ORGANIZATION_HEAD_CONFLICT"].includes(error.code)) throw error;
          }
          snapshot = store.inspect();
        }
        agent = snapshot.status === "ready"
          ? snapshot.bundle.agentRegistry.agents.find((record) => record.agent_id === agentId)
          : null;
        if (agent?.lifecycle_state !== "active"
          || !snapshot.controller.applied_command_ids.includes(activation.command.command_id)) {
          return { status: "repair_required", classification: "incomplete", reason: `foundation_activation_did_not_settle:${agentId}`, no_write: !changed };
        }
        failpoint(configuredFailpoint, `after_agent_commit:${agentId}`);
        saga = mutateSaga(paths, saga, clock, (next) => {
          next.activations[agentId] = {
            ...next.activations[agentId],
            status: "active",
            evidence: {
              organization_revision: snapshot.bundle.organization.revision,
              head_hash: snapshot.head_hash,
              command_id: activation.command.command_id,
            },
          };
        });
        changed = true;
        failpoint(configuredFailpoint, `after_activation_recorded:${agentId}`);
      }
    }
    if (!phaseAtLeast(saga.phase, "organization_agents_activated")) {
      saga = mutateSaga(paths, saga, clock, (next) => { next.phase = "organization_agents_activated"; });
      changed = true;
    }
    if (saga.phase !== "complete") {
      saga = mutateSaga(paths, saga, clock, (next) => { next.phase = "complete"; });
      changed = true;
    }
    observed = classify();
    if (observed.status !== "ready") {
      fail("FOUNDATION_BOOTSTRAP_COMPLETION_INVALID", `Foundation bootstrap completed into ${observed.status}`);
    }
    const verified = await verifyRecordedBindings({ saga: observed.saga, sessionPort, projectId });
    if (!verified.ok) {
      return { status: "repair_required", classification: "ready", reason: verified.reason, no_write: !changed };
    }
    return readyResult(observed, verified.bindings, !changed);
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      releaseExclusiveProcessLock(lock);
    } catch (releaseError) {
      if (!operationError) throw releaseError;
      operationError.lockReleaseError = releaseError;
    }
  }
}

module.exports = {
  BOOTSTRAP_PHASES,
  FOUNDATION_BOOTSTRAP_CLASSIFICATIONS: CLASSIFICATIONS,
  classifyFoundationBootstrapV3,
  runFoundationBootstrapV3,
};
