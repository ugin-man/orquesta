"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const {
  applyOrganizationControllerCommand,
  organizationV3HeadHash,
} = require("./organization-controller-v3");
const { createOrganizationV3Bundle } = require("./organization-v3");
const {
  acquireExclusiveProcessLock,
  releaseExclusiveProcessLock,
} = require("./exclusive-process-lock-v1");

const CONTROLLER_VERSION = 1;
const TRANSITION_VERSION = 1;
const STORE_DIRECTORY = path.join(".orquesta", "runtime", "organization-store-v3");
const TARGET_NAMES = Object.freeze(["agents.json", "organization.json", "formations.json"]);
const WRITER_EPOCH = "organization-v3-store";
const TRANSIENT_OPERATION_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const LEGACY_FOUNDATION_SETUP_FILES = Object.freeze([
  "setup_state.json",
  "provisioning_batch.json",
]);

function fail(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  throw error;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalRoot(rootPath) {
  if (typeof rootPath !== "string" || !path.isAbsolute(rootPath)) {
    fail("ORGANIZATION_STORE_ROOT_INVALID", "Organization v3 store requires an absolute project root");
  }
  return fs.realpathSync(rootPath);
}

function assertInside(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail("ORGANIZATION_STORE_PATH_UNSAFE", `Organization v3 path escapes the project root: ${candidatePath}`);
  }
}

function verifyOwnedDirectory(rootPath, directoryPath, create) {
  assertInside(rootPath, directoryPath);
  if (create) fs.mkdirSync(directoryPath, { recursive: true });
  if (!fs.existsSync(directoryPath)) return false;
  const details = fs.lstatSync(directoryPath);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    fail("ORGANIZATION_STORE_PATH_UNSAFE", `Organization v3 owned directory is not a real directory: ${directoryPath}`);
  }
  const resolved = fs.realpathSync(directoryPath);
  assertInside(rootPath, resolved);
  return true;
}

function verifyOwnedPaths(paths, create) {
  const orquestaRoot = path.join(paths.root, ".orquesta");
  if (!verifyOwnedDirectory(paths.root, orquestaRoot, create)) return false;
  if (!verifyOwnedDirectory(paths.root, paths.state, create)) return false;
  const runtimeRoot = path.join(paths.root, ".orquesta", "runtime");
  if (!verifyOwnedDirectory(paths.root, runtimeRoot, create)) return false;
  return verifyOwnedDirectory(paths.root, paths.staging, create);
}

function verifyOwnedFile(rootPath, filePath, allowMissing = true) {
  assertInside(rootPath, filePath);
  if (!fs.existsSync(filePath)) {
    if (allowMissing) return false;
    fail("ORGANIZATION_STORE_PATH_UNSAFE", `Required Organization v3 file is missing: ${filePath}`);
  }
  const details = fs.lstatSync(filePath);
  if (!details.isFile() || details.isSymbolicLink()) {
    fail("ORGANIZATION_STORE_PATH_UNSAFE", `Organization v3 owned file is not a real file: ${filePath}`);
  }
  assertInside(rootPath, fs.realpathSync(filePath));
  return true;
}

function inspectLegacyFoundationV2Markers(rootPath) {
  const root = canonicalRoot(rootPath);
  const setupRoot = path.join(root, ".orquesta", "setup");
  if (!fs.existsSync(setupRoot)) return [];
  verifyOwnedDirectory(root, path.join(root, ".orquesta"), false);
  verifyOwnedDirectory(root, setupRoot, false);
  const markers = [];
  for (const name of LEGACY_FOUNDATION_SETUP_FILES) {
    const markerPath = path.join(setupRoot, name);
    if (!fs.existsSync(markerPath)) continue;
    verifyOwnedFile(root, markerPath, false);
    markers.push(`setup/${name}`);
  }
  const provisioningRoot = path.join(setupRoot, "foundation-provisioning");
  if (fs.existsSync(provisioningRoot)) {
    verifyOwnedDirectory(root, provisioningRoot, false);
    markers.push("setup/foundation-provisioning/");
  }
  return markers;
}

function validateCommandId(commandId) {
  if (typeof commandId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(commandId)) {
    fail("ORGANIZATION_STORE_COMMAND_INVALID", "Organization v3 command id is invalid");
  }
  return commandId;
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

function storePaths(rootPath) {
  const root = canonicalRoot(rootPath);
  const state = path.join(root, ".orquesta", "state");
  const staging = path.join(root, STORE_DIRECTORY);
  return {
    root,
    state,
    staging,
    lock: path.join(staging, "organization-store-lock-v1.lock"),
    agents: path.join(state, "agents.json"),
    organization: path.join(state, "organization.json"),
    formations: path.join(state, "formations.json"),
    controller: path.join(state, "organization-controller.json"),
    transition: path.join(state, "organization-controller-transition.json"),
  };
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/u, ""));
  } catch (error) {
    fail("ORGANIZATION_STORE_STATE_INVALID", `Cannot read canonical JSON: ${filePath}`, error);
  }
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function fileHash(filePath) {
  return sha256(fs.readFileSync(filePath));
}

function syncDirectory(directoryPath) {
  const descriptor = fs.openSync(directoryPath, "r");
  try {
    try {
      fs.fsyncSync(descriptor);
    } catch (error) {
      // Windows does not support fsync on directory handles. File handles are
      // still fsynced before every rename, so this is a platform limitation,
      // not permission to skip durable file writes.
      if (process.platform !== "win32" || !["EPERM", "EINVAL"].includes(error.code)) throw error;
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function writeAtomic(filePath, value, stagingDirectory) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.mkdirSync(stagingDirectory, { recursive: true });
  if (fs.existsSync(filePath)) verifyOwnedFile(path.resolve(stagingDirectory, "..", "..", ".."), filePath, false);
  const candidate = path.join(stagingDirectory, `.metadata-${process.pid}-${crypto.randomUUID()}.json`);
  const descriptor = fs.openSync(candidate, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, jsonBytes(value));
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    retryOperational(() => fs.renameSync(candidate, filePath));
    syncDirectory(path.dirname(filePath));
  } finally {
    if (fs.existsSync(candidate)) {
      verifyOwnedFile(path.resolve(stagingDirectory, "..", "..", ".."), candidate, false);
      retryOperational(() => fs.unlinkSync(candidate));
      syncDirectory(stagingDirectory);
    }
  }
}

function defaultController() {
  return {
    schema_version: CONTROLLER_VERSION,
    status: "active",
    writer_epoch: WRITER_EPOCH,
    organization_revision: null,
    head_hash: null,
    applied_command_ids: [],
    last_command_id: null,
    updated_at: null,
  };
}

function validateController(value) {
  const expectedKeys = ["schema_version", "status", "writer_epoch", "organization_revision", "head_hash", "applied_command_ids", "last_command_id", "updated_at"];
  if (!value || typeof value !== "object" || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys.sort())
    || value.schema_version !== CONTROLLER_VERSION
    || value.status !== "active"
    || value.writer_epoch !== WRITER_EPOCH
    || !Number.isSafeInteger(value.organization_revision) || value.organization_revision < 0
    || typeof value.head_hash !== "string" || !/^[a-f0-9]{64}$/.test(value.head_hash)
    || !Array.isArray(value.applied_command_ids)
    || new Set(value.applied_command_ids).size !== value.applied_command_ids.length
    || value.applied_command_ids.some((id) => typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id))
    || typeof value.last_command_id !== "string" || !value.applied_command_ids.includes(value.last_command_id)
    || typeof value.updated_at !== "string" || !Number.isFinite(Date.parse(value.updated_at))) {
    fail("ORGANIZATION_STORE_CONTROLLER_INVALID", "Organization controller state is invalid");
  }
  return value;
}

function readController(paths) {
  if (!fs.existsSync(paths.controller)) return null;
  return validateController(readJson(paths.controller));
}

function readBundle(paths) {
  return createOrganizationV3Bundle({
    agentRegistry: readJson(paths.agents),
    organization: readJson(paths.organization),
    formations: readJson(paths.formations),
  });
}

function inspectOrganizationV3(rootPath, { validatedRuntimeBindingSha256 = null } = {}) {
  const paths = storePaths(rootPath);
  const orquestaRoot = path.join(paths.root, ".orquesta");
  if (!fs.existsSync(orquestaRoot)) return { status: "missing", paths };
  verifyOwnedDirectory(paths.root, orquestaRoot, false);
  if (fs.existsSync(paths.state)) verifyOwnedDirectory(paths.root, paths.state, false);
  if (fs.existsSync(paths.staging)) {
    verifyOwnedDirectory(paths.root, path.join(paths.root, ".orquesta", "runtime"), false);
    verifyOwnedDirectory(paths.root, paths.staging, false);
  }
  for (const filePath of [paths.agents, paths.organization, paths.formations, paths.controller, paths.transition]) {
    if (fs.existsSync(filePath)) verifyOwnedFile(paths.root, filePath, false);
  }
  const targetExists = TARGET_NAMES.map((name) => fs.existsSync(paths[path.parse(name).name]));
  const controllerExists = fs.existsSync(paths.controller);
  const transition = fs.existsSync(paths.transition) ? readJson(paths.transition) : null;
  const legacyFoundationMarkers = inspectLegacyFoundationV2Markers(paths.root);
  if (legacyFoundationMarkers.length > 0) {
    return {
      status: "migration_required",
      paths,
      reason: targetExists.some(Boolean) || controllerExists || transition !== null
        ? "foundation_v2_and_organization_v3_mixed"
        : "foundation_v2_migration_required",
      legacy_markers: legacyFoundationMarkers,
    };
  }
  if (["preparing", "prepared"].includes(transition?.status)) {
    return { status: "recovery_required", paths, transition };
  }
  if (!targetExists.some(Boolean) && !controllerExists) {
    // Organization owns only its three bundle files, controller, and transition.
    // Other state stores must not become implicit Organization migration markers.
    if (fs.existsSync(path.join(paths.state, "runtime-binding.json"))) {
      const bindingPath = path.join(paths.state, "runtime-binding.json");
      verifyOwnedFile(paths.root, bindingPath, false);
      if (typeof validatedRuntimeBindingSha256 !== "string"
        || !/^[a-f0-9]{64}$/.test(validatedRuntimeBindingSha256)
        || fileHash(bindingPath) !== validatedRuntimeBindingSha256) {
        return { status: "unsupported", paths, reason: "runtime_binding_requires_validated_receipt" };
      }
    }
    return { status: "missing", paths };
  }
  if (!targetExists.every(Boolean) || !controllerExists) {
    return { status: "migration_required", paths, reason: "organization_v3_authority_partial" };
  }
  const rawOrganization = readJson(paths.organization);
  if (rawOrganization.schema_version !== 3) {
    return { status: "migration_required", paths, reason: "organization_v3_migration_required" };
  }
  const bundle = readBundle(paths);
  const controller = readController(paths);
  const headHash = organizationV3HeadHash(bundle);
  if (controller.organization_revision !== bundle.organization.revision || controller.head_hash !== headHash) {
    return { status: "unsupported", paths, reason: "organization_v3_controller_head_mismatch" };
  }
  if (transition) {
    try {
      validateTransition(transition, paths);
      if (transition.status !== "committed"
        || transition.after_head_hash !== headHash
        || transition.organization_revision !== bundle.organization.revision
        || JSON.stringify(transition.controller_after) !== JSON.stringify(controller)) {
        return { status: "unsupported", paths, reason: "organization_v3_committed_transition_mismatch" };
      }
    } catch {
      return { status: "unsupported", paths, reason: "organization_v3_transition_invalid" };
    }
  }
  return { status: "ready", paths, bundle, controller, head_hash: headHash, transition };
}

function withLock(paths, clock, operation) {
  verifyOwnedPaths(paths, true);
  const lock = acquireExclusiveProcessLock({
    rootPath: paths.root,
    lockPath: paths.lock,
    codePrefix: "ORGANIZATION_STORE",
  });
  let operationError;
  try {
    return operation();
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

function validateTransition(transition, paths) {
  const expectedKeys = ["schema_version", "status", "command_id", "before_head_hash", "after_head_hash", "organization_revision", "targets", "controller_before", "controller_after", "prepared_at", "staging_completed_at", "committed_at"];
  if (!transition || transition.schema_version !== TRANSITION_VERSION || !["preparing", "prepared", "committed"].includes(transition.status)
    || JSON.stringify(Object.keys(transition).sort()) !== JSON.stringify(expectedKeys.sort())
    || typeof transition.command_id !== "string" || !Array.isArray(transition.targets)
    || transition.targets.length !== TARGET_NAMES.length) {
    fail("ORGANIZATION_STORE_TRANSITION_INVALID", "Prepared Organization v3 transition is invalid");
  }
  validateCommandId(transition.command_id);
  if ((transition.before_head_hash !== null && (typeof transition.before_head_hash !== "string" || !/^[a-f0-9]{64}$/.test(transition.before_head_hash)))
    || typeof transition.after_head_hash !== "string" || !/^[a-f0-9]{64}$/.test(transition.after_head_hash)
    || !Number.isSafeInteger(transition.organization_revision) || transition.organization_revision < 0
    || typeof transition.prepared_at !== "string" || !Number.isFinite(Date.parse(transition.prepared_at))
    || (transition.status === "preparing" && transition.staging_completed_at !== null)
    || (transition.status !== "preparing" && (typeof transition.staging_completed_at !== "string" || !Number.isFinite(Date.parse(transition.staging_completed_at))))
    || (transition.status !== "committed" && transition.committed_at !== null)
    || (transition.status === "committed" && (typeof transition.committed_at !== "string" || !Number.isFinite(Date.parse(transition.committed_at))))
    || (transition.staging_completed_at !== null && transition.staging_completed_at < transition.prepared_at)
    || (transition.committed_at !== null && transition.committed_at < transition.staging_completed_at)) {
    fail("ORGANIZATION_STORE_TRANSITION_INVALID", "Prepared Organization v3 transition chronology or head binding is invalid");
  }
  if (new Set(transition.targets.map((target) => target?.name)).size !== TARGET_NAMES.length
    || !TARGET_NAMES.every((name) => transition.targets.some((target) => target?.name === name))) {
    fail("ORGANIZATION_STORE_TRANSITION_INVALID", "Prepared Organization v3 transition targets are not the exact authority set");
  }
  const controllerAfter = validateController(transition.controller_after);
  const controllerBefore = transition.controller_before === null
    ? null
    : validateController(transition.controller_before);
  if (controllerAfter.writer_epoch !== WRITER_EPOCH
    || controllerAfter.organization_revision !== transition.organization_revision
    || controllerAfter.head_hash !== transition.after_head_hash
    || controllerAfter.last_command_id !== transition.command_id
    || !controllerAfter.applied_command_ids.includes(transition.command_id)) {
    fail("ORGANIZATION_STORE_TRANSITION_INVALID", "Prepared Organization v3 transition controller binding is invalid");
  }
  if (transition.before_head_hash === null) {
    if (controllerBefore !== null || transition.targets.some((target) => target?.before_sha256 !== null)) {
      fail("ORGANIZATION_STORE_TRANSITION_INVALID", "Fresh Organization v3 transition cannot have a prior controller");
    }
  } else if (controllerBefore === null
    || controllerBefore.writer_epoch !== WRITER_EPOCH
    || controllerBefore.head_hash !== transition.before_head_hash
    || controllerBefore.organization_revision + 1 !== transition.organization_revision
    || transition.targets.some((target) => target?.before_sha256 === null)) {
    fail("ORGANIZATION_STORE_TRANSITION_INVALID", "Prepared Organization v3 transition prior controller binding is invalid");
  }
  for (const target of transition.targets) {
    const targetKeys = ["name", "target_path", "staging_path", "before_sha256", "sha256"];
    if (!target || JSON.stringify(Object.keys(target).sort()) !== JSON.stringify(targetKeys.sort())
      || !TARGET_NAMES.includes(target.name)
      || (target.before_sha256 !== null && (typeof target.before_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(target.before_sha256)))
      || typeof target.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(target.sha256)) {
      fail("ORGANIZATION_STORE_TRANSITION_INVALID", "Prepared Organization v3 transition target is invalid");
    }
    const expectedTarget = paths[path.parse(target.name).name];
    const expectedStage = path.join(paths.staging, `${transition.command_id}-${target.name}`);
    if (target.target_path !== path.relative(paths.root, expectedTarget).replaceAll("\\", "/")
      || target.staging_path !== path.relative(paths.root, expectedStage).replaceAll("\\", "/")) {
      fail("ORGANIZATION_STORE_TRANSITION_INVALID", "Prepared Organization v3 transition escapes its owned paths");
    }
  }
  return transition;
}

function observedHash(rootPath, filePath) {
  if (!fs.existsSync(filePath)) return null;
  verifyOwnedFile(rootPath, filePath, false);
  return fileHash(filePath);
}

function expectedControllerHash(controller) {
  return controller === null ? null : sha256(jsonBytes(controller));
}

function assertRecoverableTransitionState(paths, transition, { preparingOnly = false } = {}) {
  const targetStates = transition.targets.map((target) => {
    const targetPath = paths[path.parse(target.name).name];
    const stagingPath = path.join(paths.staging, `${transition.command_id}-${target.name}`);
    const currentHash = observedHash(paths.root, targetPath);
    const isBefore = currentHash === target.before_sha256;
    const isAfter = currentHash === target.sha256;
    if ((!isBefore && !isAfter) || (preparingOnly && !isBefore)) {
      fail("ORGANIZATION_STORE_RECOVERY_CONFLICT", `Canonical target changed outside the prepared transition: ${target.name}`);
    }
    const stagedHash = observedHash(paths.root, stagingPath);
    if (stagedHash !== null && stagedHash !== target.sha256) {
      fail("ORGANIZATION_STORE_RECOVERY_INCOMPLETE", `Staged target hash mismatch: ${target.name}`);
    }
    if (isBefore && !preparingOnly && stagedHash !== target.sha256) {
      fail("ORGANIZATION_STORE_RECOVERY_INCOMPLETE", `Missing verified staged target for ${target.name}`);
    }
    return isAfter ? "after" : "before";
  });
  const controllerHash = observedHash(paths.root, paths.controller);
  const beforeControllerHash = expectedControllerHash(transition.controller_before);
  const afterControllerHash = expectedControllerHash(transition.controller_after);
  const controllerIsBefore = controllerHash === beforeControllerHash;
  const controllerIsAfter = controllerHash === afterControllerHash;
  if ((!controllerIsBefore && !controllerIsAfter) || (preparingOnly && !controllerIsBefore)) {
    fail("ORGANIZATION_STORE_RECOVERY_CONFLICT", "Organization controller changed outside the prepared transition");
  }
  if (controllerIsAfter && targetStates.some((state) => state !== "after")) {
    fail("ORGANIZATION_STORE_RECOVERY_CONFLICT", "Organization controller advanced before every canonical target");
  }
  return { targetStates, controllerIsAfter };
}

function rollForwardPrepared(paths, transition, clock, failpoint) {
  validateTransition(transition, paths);
  if (transition.status !== "prepared") {
    fail("ORGANIZATION_STORE_RECOVERY_INCOMPLETE", "Organization v3 transition staging is not complete");
  }
  const recoverable = assertRecoverableTransitionState(paths, transition);
  let completed = 0;
  for (const [index, target] of transition.targets.entries()) {
    const targetPath = paths[path.parse(target.name).name];
    const stagingPath = path.join(paths.staging, `${transition.command_id}-${target.name}`);
    if (recoverable.targetStates[index] === "after") {
      completed += 1;
      continue;
    }
    retryOperational(() => fs.renameSync(stagingPath, targetPath));
    syncDirectory(paths.state);
    completed += 1;
    if (failpoint === "after_first_target" && completed === 1) {
      fail("ORGANIZATION_STORE_FAILPOINT", "Simulated interruption after first Organization v3 target");
    }
  }
  const bundle = readBundle(paths);
  const headHash = organizationV3HeadHash(bundle);
  if (headHash !== transition.after_head_hash || bundle.organization.revision !== transition.organization_revision) {
    fail("ORGANIZATION_STORE_POST_WRITE_MISMATCH", "Organization v3 roll-forward verification failed");
  }
  if (failpoint === "after_targets") fail("ORGANIZATION_STORE_FAILPOINT", "Simulated interruption after Organization v3 targets");
  if (!recoverable.controllerIsAfter) writeAtomic(paths.controller, transition.controller_after, paths.staging);
  const committed = { ...transition, status: "committed", committed_at: clock() };
  writeAtomic(paths.transition, committed, paths.staging);
  for (const target of transition.targets) {
    const stagingPath = path.join(paths.staging, `${transition.command_id}-${target.name}`);
    if (fs.existsSync(stagingPath)) retryOperational(() => fs.unlinkSync(stagingPath));
  }
  syncDirectory(paths.staging);
  return { bundle, controller: transition.controller_after, head_hash: headHash, transition: committed };
}

function prepareTransition({ paths, bundle, controllerBefore, controllerAfter, commandId, beforeHeadHash, clock, failpoint }) {
  validateCommandId(commandId);
  const values = {
    "agents.json": bundle.agentRegistry,
    "organization.json": bundle.organization,
    "formations.json": bundle.formations,
  };
  const targets = TARGET_NAMES.map((name) => {
    const bytes = jsonBytes(values[name]);
    const stagingPath = path.join(paths.staging, `${commandId}-${name}`);
    return {
      name,
      target_path: path.relative(paths.root, paths[path.parse(name).name]).replaceAll("\\", "/"),
      staging_path: path.relative(paths.root, stagingPath).replaceAll("\\", "/"),
      before_sha256: observedHash(paths.root, paths[path.parse(name).name]),
      sha256: sha256(bytes),
    };
  });
  const transition = {
    schema_version: TRANSITION_VERSION,
    status: "preparing",
    command_id: commandId,
    before_head_hash: beforeHeadHash,
    after_head_hash: organizationV3HeadHash(bundle),
    organization_revision: bundle.organization.revision,
    targets,
    controller_before: controllerBefore,
    controller_after: controllerAfter,
    prepared_at: clock(),
    staging_completed_at: null,
    committed_at: null,
  };
  writeAtomic(paths.transition, transition, paths.staging);
  for (const [index, target] of targets.entries()) {
    const stagingPath = path.join(paths.staging, `${commandId}-${target.name}`);
    if (fs.existsSync(stagingPath)) fail("ORGANIZATION_STORE_STAGING_CONFLICT", `Staging artifact already exists: ${target.name}`);
    const descriptor = fs.openSync(stagingPath, "wx", 0o600);
    try {
      fs.writeFileSync(descriptor, jsonBytes(values[target.name]));
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    if (failpoint === "after_first_stage" && index === 0) {
      fail("ORGANIZATION_STORE_FAILPOINT", "Simulated interruption during Organization v3 staging");
    }
  }
  const prepared = { ...transition, status: "prepared", staging_completed_at: clock() };
  writeAtomic(paths.transition, prepared, paths.staging);
  return prepared;
}

function createOrganizationV3Store({ rootPath, validatedRuntimeBindingSha256 = null, clock = () => new Date().toISOString(), failpoint = null } = {}) {
  const paths = storePaths(rootPath);
  const { projectRootBindingSha256 } = require("./project-execution-context");
  const projectRootBinding = projectRootBindingSha256(paths.root);

  function recover() {
    return withLock(paths, clock, () => {
      const legacyFoundationMarkers = inspectLegacyFoundationV2Markers(paths.root);
      if (legacyFoundationMarkers.length > 0) {
        fail("ORGANIZATION_STORE_MIGRATION_REQUIRED", "Legacy Foundation authority blocks Organization recovery");
      }
      if (!fs.existsSync(paths.transition)) return { status: "no_recovery_required" };
      verifyOwnedFile(paths.root, paths.transition, false);
      const transition = readJson(paths.transition);
      if (transition.status === "preparing") {
        validateTransition(transition, paths);
        assertRecoverableTransitionState(paths, transition, { preparingOnly: true });
        for (const target of transition.targets) {
          const targetPath = paths[path.parse(target.name).name];
          const stagingPath = path.join(paths.staging, `${transition.command_id}-${target.name}`);
          if (!fs.existsSync(stagingPath)) continue;
          if (fileHash(stagingPath) !== target.sha256) {
            fail("ORGANIZATION_STORE_RECOVERY_INCOMPLETE", `Preparing artifact hash mismatch: ${target.name}`);
          }
        retryOperational(() => fs.unlinkSync(stagingPath));
      }
        retryOperational(() => fs.unlinkSync(paths.transition));
        syncDirectory(paths.staging);
        syncDirectory(paths.state);
        return { status: "preparation_abandoned" };
      }
      if (transition.status !== "prepared") return { status: "no_recovery_required", transition_status: transition.status };
      const result = rollForwardPrepared(paths, transition, clock, null);
      return { status: "commit_finalized", ...result };
    });
  }

  function initialize({ bundle: rawBundle, commandId = "project-bootstrap-v3" } = {}) {
    return withLock(paths, clock, () => {
      const state = inspectOrganizationV3(paths.root, { validatedRuntimeBindingSha256 });
      if (state.status === "ready") return { ...state, status: "already_initialized" };
      if (state.status === "recovery_required") fail("ORGANIZATION_STORE_RECOVERY_REQUIRED", "Recover the prepared Organization v3 transition first");
      if (state.status !== "missing") fail("ORGANIZATION_STORE_MIGRATION_REQUIRED", `Cannot initialize Organization v3 from ${state.status}`);
      fs.mkdirSync(paths.state, { recursive: true });
      const bundle = createOrganizationV3Bundle(rawBundle);
      const headHash = organizationV3HeadHash(bundle);
      const controller = {
        ...defaultController(),
        writer_epoch: WRITER_EPOCH,
        organization_revision: bundle.organization.revision,
        head_hash: headHash,
        applied_command_ids: [commandId],
        last_command_id: commandId,
        updated_at: clock(),
      };
      const transition = prepareTransition({ paths, bundle, controllerBefore: null, controllerAfter: controller, commandId, beforeHeadHash: null, clock, failpoint });
      if (failpoint === "after_prepare") fail("ORGANIZATION_STORE_FAILPOINT", "Simulated interruption after Organization v3 prepare");
      const result = rollForwardPrepared(paths, transition, clock, failpoint);
      return { status: "initialized", ...result };
    });
  }

  function commit(command) {
    return withLock(paths, clock, () => {
      const state = inspectOrganizationV3(paths.root, { validatedRuntimeBindingSha256 });
      if (state.status === "recovery_required") fail("ORGANIZATION_STORE_RECOVERY_REQUIRED", "Recover the prepared Organization v3 transition first");
      if (state.status !== "ready") fail("ORGANIZATION_STORE_NOT_READY", `Organization v3 store is ${state.status}`);
      const applied = applyOrganizationControllerCommand({
        bundle: state.bundle,
        command,
        appliedCommandIds: state.controller.applied_command_ids,
      });
      const controller = {
        ...state.controller,
        writer_epoch: WRITER_EPOCH,
        organization_revision: applied.bundle.organization.revision,
        head_hash: applied.head_hash,
        applied_command_ids: [...state.controller.applied_command_ids, command.command_id],
        last_command_id: command.command_id,
        updated_at: clock(),
      };
      if (applied.status === "already_applied") {
        return { status: "already_applied", bundle: state.bundle, controller: state.controller, head_hash: state.head_hash };
      }
      if (applied.status === "no_change") {
        return { status: "no_change", bundle: state.bundle, controller: state.controller, head_hash: state.head_hash };
      }
      const transition = prepareTransition({
        paths,
        bundle: applied.bundle,
        controllerBefore: state.controller,
        controllerAfter: controller,
        commandId: command.command_id,
        beforeHeadHash: state.head_hash,
        clock,
        failpoint,
      });
      if (failpoint === "after_prepare") fail("ORGANIZATION_STORE_FAILPOINT", "Simulated interruption after Organization v3 prepare");
      const result = rollForwardPrepared(paths, transition, clock, failpoint);
      return { status: "committed", ...result };
    });
  }

  return Object.freeze({
    project_root_binding_sha256: projectRootBinding,
    inspect: () => inspectOrganizationV3(paths.root, { validatedRuntimeBindingSha256 }),
    recover,
    initialize,
    commit,
  });
}

module.exports = {
  createOrganizationV3Store,
  inspectLegacyFoundationV2Markers,
  inspectOrganizationV3,
};
