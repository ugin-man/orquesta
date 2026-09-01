"use strict";

const crypto = require("node:crypto");
const path = require("node:path");

const { canonicalHash, canonicalJson } = require("@orquesta/contracts");
const {
  V2_EFFECT_IDENTITY_FIELDS,
  V2_MUTATING_EFFECT_KINDS,
} = require("./lifecycle");

const PRESEND_FAILURE_RECORDER_CONTRACT_VERSION = 1;
const PRESEND_FAILURE_RECORD_VERSION = 1;
const PRESEND_FAILURE_SOURCES = Object.freeze([
  "packet_store",
  "authority",
  "driver_capability",
]);
const PRESEND_FAILURE_REASON_BY_SOURCE = Object.freeze({
  packet_store: "packet_integrity_failed",
  authority: "authority_failed",
  driver_capability: "driver_capability_failed",
});
const PRESEND_FAILURE_RECORDER_CAPABILITIES = Object.freeze({
  recorder_contract_version: 1,
  storage: "durable_content_addressed",
  idempotency: "presend_failure_id",
  verification: "source_specific_internal",
  observation_attestation: "trusted_resolver_readable",
});

const PLATFORM_ADAPTER_METHODS = Object.freeze([
  "openStore",
  "recoverInterruptedWrites",
  "readFileNoFollow",
  "openTempExclusive",
  "writeAll",
  "fsyncFile",
  "closeFile",
  "renameTempNoReplace",
  "unlinkTempNoFollow",
  "fsyncDirectory",
  "closeStore",
]);

const SECURITY_PROOF_FIELDS = new Set([
  "proof_version",
  "proof_scope",
  "platform",
  "root_realpath",
  "privacy_enforcement",
  "owner_only_directories",
  "owner_only_files",
  "private_acl_verified",
  "symlink_components_rejected",
  "no_follow_reads",
  "exclusive_store_sessions",
  "process_local_exclusive_store_sessions",
  "exclusive_temp_creation",
  "atomic_no_replace_rename",
  "atomic_mutation_index",
  "file_fsync",
  "directory_fsync",
  "coordinated_recovery",
  "directory_handle_pinned",
]);
const RECOVERY_PROOF_FIELDS = new Set([
  "recovery_version",
  "root_realpath",
  "exclusive_recovery",
  "session_lock_held",
  "stale_temps_handled",
  "directory_fsynced",
]);
const CONTENT_REF_FIELDS = new Set(["id", "hash"]);
const FENCING_TOKEN_FIELDS = new Set(["lease_id", "owner_id", "generation"]);
const RUNTIME_IDENTITY_FIELDS = new Set(["operation_id", "thread_id", "turn_id"]);
const VERIFICATION_RESULT_FIELDS = new Set([
  "verification_contract_version",
  "verification_status",
  "failure_source",
  "failure_reason",
  "binding_hash",
  "evidence_refs",
]);
const FAILURE_RECORD_FIELDS = new Set([
  "failure_record_version",
  "failure_record_kind",
  "presend_failure_id",
  "effect_identity",
  "claimed_fencing_token",
  "failure_source",
  "failure_reason",
  "evidence_refs",
]);
const BINDING_RECORD_FIELDS = new Set([
  "binding_version",
  "presend_failure_id",
  "failure_record_ref",
]);

const EFFECT_KIND_SET = new Set(V2_MUTATING_EFFECT_KINDS);
const SOURCE_SET = new Set(PRESEND_FAILURE_SOURCES);
const MAX_RECORD_BYTES = 1_048_576;
// Keep durable evidence identifiers identical to the Business ingress
// contract. A recorder must never persist an idempotent record that its only
// consumer cannot later attest.
const MAX_REF_BYTES = 256;
const MAX_EVIDENCE_REFS = 128;
const DEFAULT_DEPENDENCY_TIMEOUT_MS = 5_000;

class BusinessPresendFailureRecorderError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "BusinessPresendFailureRecorderError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new BusinessPresendFailureRecorderError(code, message, details);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactObject(value, fields, field) {
  if (!isPlainObject(value)
      || Object.keys(value).length !== fields.size
      || Object.keys(value).some((key) => !fields.has(key))) {
    fail(
      "BUSINESS_PRESEND_FAILURE_RECORD_INVALID",
      `${field} must contain the exact contract fields`,
    );
  }
  return value;
}

function portableRef(value, field) {
  if (typeof value !== "string"
      || value.trim() === ""
      || value.trim() !== value
      || Buffer.byteLength(value, "utf8") > MAX_REF_BYTES
      || !/^[A-Za-z0-9][A-Za-z0-9._:/@+\-]*$/u.test(value)) {
    fail("BUSINESS_PRESEND_FAILURE_RECORD_INVALID", `${field} is invalid`);
  }
  return value;
}

function sha256(value, field) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    fail("BUSINESS_PRESEND_FAILURE_RECORD_INVALID", `${field} must be sha256 hex`);
  }
  return value;
}

function integer(value, field, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail("BUSINESS_PRESEND_FAILURE_RECORD_INVALID", `${field} is invalid`);
  }
  return value;
}

function timestamp(value, field) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))
      || new Date(value).toISOString() !== value) {
    fail("BUSINESS_PRESEND_FAILURE_RECORD_INVALID", `${field} must be canonical UTC`);
  }
  return value;
}

function canonicalClone(value, field) {
  try {
    return JSON.parse(canonicalJson(value));
  } catch {
    fail("BUSINESS_PRESEND_FAILURE_RECORD_INVALID", `${field} must be canonical JSON`);
  }
}

function same(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function normalizeRuntimeIdentity(value, field) {
  if (value === null) return null;
  exactObject(value, RUNTIME_IDENTITY_FIELDS, field);
  const normalized = {
    operation_id: value.operation_id === null ? null : portableRef(value.operation_id, `${field}.operation_id`),
    thread_id: value.thread_id === null ? null : portableRef(value.thread_id, `${field}.thread_id`),
    turn_id: value.turn_id === null ? null : portableRef(value.turn_id, `${field}.turn_id`),
  };
  if (Object.values(normalized).every((candidate) => candidate === null)) {
    fail("BUSINESS_PRESEND_FAILURE_RECORD_INVALID", `${field} cannot be empty`);
  }
  return normalized;
}

function normalizeEffectIdentity(candidate, field = "effect_identity") {
  const fields = new Set(V2_EFFECT_IDENTITY_FIELDS);
  exactObject(candidate, fields, field);
  const effect = {
    effect_id: portableRef(candidate.effect_id, `${field}.effect_id`),
    effect_contract_version: integer(candidate.effect_contract_version, `${field}.effect_contract_version`, 2, 2),
    work_order_id: portableRef(candidate.work_order_id, `${field}.work_order_id`),
    branch_ref: portableRef(candidate.branch_ref, `${field}.branch_ref`),
    attempt: integer(candidate.attempt, `${field}.attempt`, 1, 1_000_000),
    dispatch_id: portableRef(candidate.dispatch_id, `${field}.dispatch_id`),
    effect_kind: portableRef(candidate.effect_kind, `${field}.effect_kind`),
    origin_source_id: portableRef(candidate.origin_source_id, `${field}.origin_source_id`),
    operation_scope_hash: sha256(candidate.operation_scope_hash, `${field}.operation_scope_hash`),
    operation_generation: integer(candidate.operation_generation, `${field}.operation_generation`, 1, 1_000_000),
    generation_predecessor_effect_id: candidate.generation_predecessor_effect_id === null
      ? null
      : portableRef(candidate.generation_predecessor_effect_id, `${field}.generation_predecessor_effect_id`),
    provider_ref: portableRef(candidate.provider_ref, `${field}.provider_ref`),
    packet_ref: portableRef(candidate.packet_ref, `${field}.packet_ref`),
    packet_hash: sha256(candidate.packet_hash, `${field}.packet_hash`),
    predecessor_effect_id: candidate.predecessor_effect_id === null
      ? null
      : portableRef(candidate.predecessor_effect_id, `${field}.predecessor_effect_id`),
    predecessor_delivery_hash: candidate.predecessor_delivery_hash === null
      ? null
      : sha256(candidate.predecessor_delivery_hash, `${field}.predecessor_delivery_hash`),
    target_runtime_identity: normalizeRuntimeIdentity(candidate.target_runtime_identity, `${field}.target_runtime_identity`),
    idempotency_key: portableRef(candidate.idempotency_key, `${field}.idempotency_key`),
    created_at: timestamp(candidate.created_at, `${field}.created_at`),
  };
  const seed = Object.fromEntries(V2_EFFECT_IDENTITY_FIELDS
    .filter((name) => !["effect_id", "idempotency_key", "created_at"].includes(name))
    .map((name) => [name, effect[name]]));
  const expectedEffectId = `FX-${canonicalHash(seed).slice(0, 32)}`;
  const expectedIdempotency = `IDEM-${canonicalHash(seed).slice(0, 32)}`;
  const rootGeneration = effect.operation_generation === 1;
  const threadCreate = effect.effect_kind === "provider.thread.create";
  if (!EFFECT_KIND_SET.has(effect.effect_kind)
      || rootGeneration !== (effect.generation_predecessor_effect_id === null)
      || ((effect.predecessor_effect_id === null)
        !== (effect.predecessor_delivery_hash === null))
      || (threadCreate
        ? (effect.predecessor_effect_id !== null || effect.target_runtime_identity !== null)
        : (effect.predecessor_effect_id === null || effect.target_runtime_identity === null))
      || effect.effect_id !== expectedEffectId
      || effect.idempotency_key !== expectedIdempotency) {
    fail(
      "BUSINESS_PRESEND_FAILURE_EFFECT_BINDING",
      "Pre-send failure does not bind a valid immutable Effect V2 identity",
    );
  }
  return Object.freeze(effect);
}

function normalizeFencingToken(value, field = "claimed_fencing_token") {
  exactObject(value, FENCING_TOKEN_FIELDS, field);
  return Object.freeze({
    lease_id: portableRef(value.lease_id, `${field}.lease_id`),
    owner_id: portableRef(value.owner_id, `${field}.owner_id`),
    generation: integer(value.generation, `${field}.generation`, 1, 1_000_000_000),
  });
}

function normalizeContentRef(value, field = "failure_record_ref") {
  exactObject(value, CONTENT_REF_FIELDS, field);
  const ref = {
    id: portableRef(value.id, `${field}.id`),
    hash: sha256(value.hash, `${field}.hash`),
  };
  if (ref.id !== `PFR-${ref.hash.slice(0, 32)}`) {
    fail("BUSINESS_PRESEND_FAILURE_RECORD_INVALID", `${field} is not content addressed`);
  }
  return Object.freeze(ref);
}

function normalizeEvidenceRefs(value, field = "evidence_refs") {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_EVIDENCE_REFS) {
    fail("BUSINESS_PRESEND_FAILURE_VERIFICATION_INVALID", `${field} must be non-empty and bounded`);
  }
  const refs = value.map((entry, index) => portableRef(entry, `${field}[${index}]`));
  if (new Set(refs).size !== refs.length) {
    fail("BUSINESS_PRESEND_FAILURE_VERIFICATION_INVALID", `${field} must be unique`);
  }
  return Object.freeze(refs);
}

function normalizeInput(input) {
  const fields = new Set([
    "recorder_contract_version",
    "presend_failure_id",
    "effect_identity",
    "claimed_fencing_token",
    "failure_source",
  ]);
  exactObject(input, fields, "input");
  if (input.recorder_contract_version !== PRESEND_FAILURE_RECORDER_CONTRACT_VERSION
      || typeof input.presend_failure_id !== "string"
      || !/^PSF-[a-f0-9]{32}$/u.test(input.presend_failure_id)
      || !SOURCE_SET.has(input.failure_source)) {
    fail("BUSINESS_PRESEND_FAILURE_RECORD_INVALID", "Pre-send failure input is invalid");
  }
  const normalized = Object.freeze({
    recorder_contract_version: 1,
    presend_failure_id: input.presend_failure_id,
    effect_identity: normalizeEffectIdentity(input.effect_identity),
    claimed_fencing_token: normalizeFencingToken(input.claimed_fencing_token),
    failure_source: input.failure_source,
  });
  const expectedId = `PSF-${canonicalHash({
    reactor_contract_version: 1,
    effect_id: normalized.effect_identity.effect_id,
    claimed_fencing_token: normalized.claimed_fencing_token,
    failure_source: normalized.failure_source,
  }).slice(0, 32)}`;
  if (normalized.presend_failure_id !== expectedId) {
    fail(
      "BUSINESS_PRESEND_FAILURE_EFFECT_BINDING",
      "presend_failure_id does not derive from the exact Effect, claim, and source",
    );
  }
  return normalized;
}

function verificationRequest(input) {
  return Object.freeze({
    verification_contract_version: 1,
    presend_failure_id: input.presend_failure_id,
    effect_identity: input.effect_identity,
    claimed_fencing_token: input.claimed_fencing_token,
    failure_source: input.failure_source,
  });
}

function normalizeVerification(value, request) {
  exactObject(value, VERIFICATION_RESULT_FIELDS, "source_verification");
  const expectedReason = PRESEND_FAILURE_REASON_BY_SOURCE[request.failure_source];
  const expectedBindingHash = canonicalHash(request);
  const evidenceRefs = normalizeEvidenceRefs(value.evidence_refs, "source_verification.evidence_refs");
  if (value.verification_contract_version !== 1
      || value.verification_status !== "verified_failure"
      || value.failure_source !== request.failure_source
      || value.failure_reason !== expectedReason
      || value.binding_hash !== expectedBindingHash) {
    fail(
      "BUSINESS_PRESEND_FAILURE_VERIFICATION_INVALID",
      "Source verifier did not prove the exact failure binding",
      { failure_source: request.failure_source },
    );
  }
  return Object.freeze({
    verification_contract_version: 1,
    verification_status: "verified_failure",
    failure_source: request.failure_source,
    failure_reason: expectedReason,
    binding_hash: expectedBindingHash,
    evidence_refs: evidenceRefs,
  });
}

function failureRecord(input, verification) {
  return Object.freeze({
    failure_record_version: PRESEND_FAILURE_RECORD_VERSION,
    failure_record_kind: "verified_provider_presend_failure",
    presend_failure_id: input.presend_failure_id,
    effect_identity: input.effect_identity,
    claimed_fencing_token: input.claimed_fencing_token,
    failure_source: input.failure_source,
    failure_reason: verification.failure_reason,
    evidence_refs: verification.evidence_refs,
  });
}

function failureRecordRef(record) {
  const hash = canonicalHash(record);
  return Object.freeze({ id: `PFR-${hash.slice(0, 32)}`, hash });
}

function attestation(record, recordRef) {
  return Object.freeze({
    effect_id: record.effect_identity.effect_id,
    idempotency_key: record.effect_identity.idempotency_key,
    provider_ref: record.effect_identity.provider_ref,
    claimed_fencing_token: record.claimed_fencing_token,
    failure_reason: record.failure_reason,
    failure_record_ref: recordRef,
    evidence_refs: record.evidence_refs,
  });
}

function resultFromRecord(record) {
  const ref = failureRecordRef(record);
  return Object.freeze({
    recorder_contract_version: 1,
    presend_failure_id: record.presend_failure_id,
    failure_record: record,
    failure_record_ref: ref,
    presend_failure_attestation: attestation(record, ref),
  });
}

function normalizeStoredRecord(value, expected = {}) {
  exactObject(value, FAILURE_RECORD_FIELDS, "failure_record");
  const input = normalizeInput({
    recorder_contract_version: 1,
    presend_failure_id: value.presend_failure_id,
    effect_identity: value.effect_identity,
    claimed_fencing_token: value.claimed_fencing_token,
    failure_source: value.failure_source,
  });
  const evidenceRefs = normalizeEvidenceRefs(value.evidence_refs, "failure_record.evidence_refs");
  const reason = PRESEND_FAILURE_REASON_BY_SOURCE[input.failure_source];
  const normalized = Object.freeze({
    failure_record_version: integer(value.failure_record_version, "failure_record.failure_record_version", 1, 1),
    failure_record_kind: value.failure_record_kind,
    presend_failure_id: input.presend_failure_id,
    effect_identity: input.effect_identity,
    claimed_fencing_token: input.claimed_fencing_token,
    failure_source: input.failure_source,
    failure_reason: value.failure_reason,
    evidence_refs: evidenceRefs,
  });
  if (normalized.failure_record_kind !== "verified_provider_presend_failure"
      || normalized.failure_reason !== reason
      || (expected.input && (!same(input.effect_identity, expected.input.effect_identity)
        || !same(input.claimed_fencing_token, expected.input.claimed_fencing_token)
        || input.failure_source !== expected.input.failure_source
        || input.presend_failure_id !== expected.input.presend_failure_id))
      || (expected.ref && !same(failureRecordRef(normalized), expected.ref))) {
    fail(
      "BUSINESS_PRESEND_FAILURE_CONFLICT",
      "Stored pre-send failure conflicts with the exact requested identity",
    );
  }
  return normalized;
}

function normalizeBindingRecord(value, expectedRef = null) {
  exactObject(value, BINDING_RECORD_FIELDS, "failure_record_binding");
  const normalized = Object.freeze({
    binding_version: integer(value.binding_version, "failure_record_binding.binding_version", 1, 1),
    presend_failure_id: portableRef(value.presend_failure_id, "failure_record_binding.presend_failure_id"),
    failure_record_ref: normalizeContentRef(value.failure_record_ref, "failure_record_binding.failure_record_ref"),
  });
  if (!/^PSF-[a-f0-9]{32}$/u.test(normalized.presend_failure_id)
      || (expectedRef && !same(normalized.failure_record_ref, expectedRef))) {
    fail("BUSINESS_PRESEND_FAILURE_CONFLICT", "Failure record binding is inconsistent");
  }
  return normalized;
}

function validateRootPath(rootPath) {
  if (typeof rootPath !== "string" || rootPath !== path.resolve(rootPath)
      || path.normalize(rootPath) !== rootPath) {
    fail("BUSINESS_PRESEND_FAILURE_CONFIGURATION_INVALID", "root_path must be normalized absolute path");
  }
  return rootPath;
}

function validateAbortSignal(signal) {
  if (signal === undefined || signal === null) return null;
  if (!signal || typeof signal.aborted !== "boolean"
      || typeof signal.addEventListener !== "function"
      || typeof signal.removeEventListener !== "function") {
    fail("BUSINESS_PRESEND_FAILURE_CONFIGURATION_INVALID", "signal must be an AbortSignal");
  }
  return signal;
}

function assertNotAborted(signal) {
  if (signal?.aborted) {
    fail("BUSINESS_PRESEND_FAILURE_ABORTED", "Pre-send failure recording was aborted before commit");
  }
}

function validateAdapter(adapter) {
  if (!adapter || typeof adapter !== "object" || Array.isArray(adapter)
      || PLATFORM_ADAPTER_METHODS.some((method) => typeof adapter[method] !== "function")) {
    fail("BUSINESS_PRESEND_FAILURE_CONFIGURATION_INVALID", "A complete platform adapter is required");
  }
  return adapter;
}

function validateVerifiers(verifiers) {
  if (!isPlainObject(verifiers)
      || Object.keys(verifiers).length !== PRESEND_FAILURE_SOURCES.length
      || PRESEND_FAILURE_SOURCES.some((source) => typeof verifiers[source] !== "function")) {
    fail(
      "BUSINESS_PRESEND_FAILURE_CONFIGURATION_INVALID",
      "Every pre-send failure source requires one trusted verifier",
    );
  }
  return verifiers;
}

function validateSecurityProof(proof, rootPath, allowTestOnly) {
  const testOnly = proof?.proof_scope === "single_process_test_only";
  if (process.platform === "win32" || proof?.platform === "win32"
      || !isPlainObject(proof)
      || Object.keys(proof).length !== SECURITY_PROOF_FIELDS.size
      || Object.keys(proof).some((field) => !SECURITY_PROOF_FIELDS.has(field))
      || proof.proof_version !== 1
      || !["production", "single_process_test_only"].includes(proof.proof_scope)
      || proof.root_realpath !== rootPath
      || typeof proof.privacy_enforcement !== "string"
      || proof.privacy_enforcement.length === 0
      || /chmod/iu.test(proof.privacy_enforcement)
      || proof.owner_only_directories !== true
      || proof.owner_only_files !== true
      || proof.private_acl_verified !== true
      || proof.symlink_components_rejected !== true
      || proof.no_follow_reads !== true
      || (testOnly
        ? (!allowTestOnly
          || proof.exclusive_store_sessions !== false
          || proof.process_local_exclusive_store_sessions !== true)
        : (proof.exclusive_store_sessions !== true
          || proof.process_local_exclusive_store_sessions !== false))
      || proof.exclusive_temp_creation !== true
      || proof.atomic_no_replace_rename !== true
      || proof.atomic_mutation_index !== true
      || proof.file_fsync !== true
      || proof.directory_fsync !== true
      || proof.coordinated_recovery !== true
      || proof.directory_handle_pinned !== true) {
    fail(
      "BUSINESS_PRESEND_FAILURE_SECURITY_UNVERIFIED",
      "Platform adapter did not prove a private serialized durable evidence store",
    );
  }
}

function validateRecoveryProof(proof, rootPath) {
  if (!isPlainObject(proof)
      || Object.keys(proof).length !== RECOVERY_PROOF_FIELDS.size
      || Object.keys(proof).some((field) => !RECOVERY_PROOF_FIELDS.has(field))
      || proof.recovery_version !== 1
      || proof.root_realpath !== rootPath
      || proof.exclusive_recovery !== true
      || proof.session_lock_held !== true
      || proof.stale_temps_handled !== true
      || proof.directory_fsynced !== true) {
    fail("BUSINESS_PRESEND_FAILURE_RECOVERY_FAILED", "Interrupted-write recovery was not proven");
  }
}

function adapterCode(error) {
  return typeof error?.code === "string" ? error.code : null;
}

function isMissing(error) {
  return adapterCode(error) === "ENOENT";
}

function isExists(error) {
  return adapterCode(error) === "EEXIST";
}

function recordName(presendFailureId) {
  return `presend-failure-id-${canonicalHash({ presend_failure_id: presendFailureId })}.json`;
}

function bindingName(recordRef) {
  return `presend-failure-ref-${recordRef.hash}.json`;
}

function temporaryName(target) {
  return `.${target}.${crypto.randomBytes(24).toString("hex")}.tmp`;
}

function parseBytes(bytes, field) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_RECORD_BYTES) {
    fail("BUSINESS_PRESEND_FAILURE_TAMPERED", `${field} bytes are invalid`);
  }
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("BUSINESS_PRESEND_FAILURE_TAMPERED", `${field} is not JSON`);
  }
}

function canonicalBytes(value) {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}

function createPresendFailureRecorder({
  root_path: rootPath,
  platform_adapter: inputAdapter,
  source_verifiers: inputVerifiers,
  allow_test_only_platform_adapter: allowTestOnly = false,
  dependency_timeout_ms: inputDependencyTimeoutMs = DEFAULT_DEPENDENCY_TIMEOUT_MS,
} = {}) {
  if (process.platform === "win32") {
    fail("BUSINESS_PRESEND_FAILURE_UNTRUSTED_PLATFORM", "Pre-send evidence is fail-closed on Windows");
  }
  const normalizedRootPath = validateRootPath(rootPath);
  const adapter = validateAdapter(inputAdapter);
  const sourceVerifiers = validateVerifiers(inputVerifiers);
  if (typeof allowTestOnly !== "boolean") {
    fail("BUSINESS_PRESEND_FAILURE_CONFIGURATION_INVALID", "allow_test_only_platform_adapter must be boolean");
  }
  const dependencyTimeoutMs = integer(
    inputDependencyTimeoutMs,
    "dependency_timeout_ms",
    10,
    60_000,
  );

  async function callSourceVerifier(verifier, request, parentSignal) {
    const controller = new AbortController();
    let timer = null;
    let parentListener = null;
    try {
      return await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback, value) => {
          if (settled) return;
          settled = true;
          callback(value);
        };
        timer = setTimeout(() => {
          controller.abort();
          finish(reject, new BusinessPresendFailureRecorderError(
            "BUSINESS_PRESEND_FAILURE_DEPENDENCY_TIMEOUT",
            "Trusted source verification exceeded its bounded deadline",
            { dependency_timeout_ms: dependencyTimeoutMs },
          ));
        }, dependencyTimeoutMs);
        timer.unref?.();
        if (parentSignal !== null) {
          parentListener = () => {
            controller.abort();
            finish(reject, new BusinessPresendFailureRecorderError(
              "BUSINESS_PRESEND_FAILURE_ABORTED",
              "Pre-send failure verification was aborted before commit",
            ));
          };
          parentSignal.addEventListener("abort", parentListener, { once: true });
          if (parentSignal.aborted) parentListener();
        }
        Promise.resolve()
          .then(() => verifier(request, Object.freeze({ signal: controller.signal })))
          .then(
            (value) => finish(resolve, value),
            (error) => finish(reject, error),
          );
      });
    } finally {
      if (timer !== null) clearTimeout(timer);
      if (parentSignal !== null && parentListener !== null) {
        parentSignal.removeEventListener("abort", parentListener);
      }
    }
  }

  async function withStore(operation) {
    let session;
    try {
      session = await adapter.openStore({ root_path: normalizedRootPath });
    } catch (error) {
      fail(
        "BUSINESS_PRESEND_FAILURE_SECURITY_UNVERIFIED",
        "Could not open the durable pre-send evidence store",
        { cause_code: adapterCode(error) },
      );
    }
    if (!isPlainObject(session) || session.handle === null || session.handle === undefined) {
      fail("BUSINESS_PRESEND_FAILURE_SECURITY_UNVERIFIED", "Platform adapter returned invalid session");
    }
    let primary = null;
    try {
      validateSecurityProof(session.proof, normalizedRootPath, allowTestOnly);
      return await operation(session.handle);
    } catch (error) {
      primary = error;
      throw error;
    } finally {
      try {
        await adapter.closeStore({ store_handle: session.handle });
      } catch (error) {
        if (primary === null) {
          fail(
            "BUSINESS_PRESEND_FAILURE_STORAGE_UNAVAILABLE",
            "Could not close the durable pre-send evidence store",
            { cause_code: adapterCode(error) },
          );
        }
      }
    }
  }

  async function recover(handle, target) {
    let proof;
    try {
      proof = await adapter.recoverInterruptedWrites({
        store_handle: handle,
        target_name: target,
        temp_prefix: `.${target}.`,
      });
    } catch (error) {
      fail(
        "BUSINESS_PRESEND_FAILURE_RECOVERY_FAILED",
        "Could not recover interrupted pre-send evidence writes",
        { cause_code: adapterCode(error) },
      );
    }
    validateRecoveryProof(proof, normalizedRootPath);
  }

  async function readBytes(handle, name, { optional = false } = {}) {
    try {
      return await adapter.readFileNoFollow({
        store_handle: handle,
        name,
        max_bytes: MAX_RECORD_BYTES,
      });
    } catch (error) {
      if (optional && isMissing(error)) return null;
      fail(
        isMissing(error) ? "BUSINESS_PRESEND_FAILURE_NOT_FOUND" : "BUSINESS_PRESEND_FAILURE_STORAGE_UNAVAILABLE",
        isMissing(error) ? "Pre-send failure evidence was not found" : "Could not read pre-send evidence",
        { cause_code: adapterCode(error) },
      );
    }
  }

  async function writeNoReplace(handle, target, value) {
    const bytes = canonicalBytes(value);
    if (bytes.length > MAX_RECORD_BYTES) {
      fail("BUSINESS_PRESEND_FAILURE_RECORD_INVALID", "Pre-send failure record exceeds size limit");
    }
    const temp = temporaryName(target);
    let file = null;
    let renamed = false;
    try {
      file = await adapter.openTempExclusive({ store_handle: handle, name: temp, mode: 0o600 });
      await adapter.writeAll({ file_handle: file, bytes });
      await adapter.fsyncFile({ file_handle: file });
      await adapter.closeFile({ file_handle: file });
      file = null;
      try {
        await adapter.renameTempNoReplace({ store_handle: handle, from_name: temp, to_name: target });
        renamed = true;
      } catch (error) {
        if (!isExists(error)) throw error;
      }
      if (!renamed) {
        try {
          await adapter.unlinkTempNoFollow({ store_handle: handle, name: temp });
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
      }
      await adapter.fsyncDirectory({ store_handle: handle });
      const stored = await readBytes(handle, target);
      if (!stored.equals(bytes)) {
        fail("BUSINESS_PRESEND_FAILURE_CONFLICT", "Existing pre-send evidence differs from candidate");
      }
    } catch (error) {
      if (file !== null) {
        try { await adapter.closeFile({ file_handle: file }); } catch {}
      }
      if (!renamed) {
        try { await adapter.unlinkTempNoFollow({ store_handle: handle, name: temp }); } catch {}
      }
      if (error instanceof BusinessPresendFailureRecorderError) throw error;
      fail(
        "BUSINESS_PRESEND_FAILURE_STORAGE_UNAVAILABLE",
        "Could not durably write pre-send failure evidence",
        { cause_code: adapterCode(error) },
      );
    }
  }

  async function readByInput(handle, input, { optional = false } = {}) {
    const name = recordName(input.presend_failure_id);
    await recover(handle, name);
    const bytes = await readBytes(handle, name, { optional });
    if (bytes === null) return null;
    const record = normalizeStoredRecord(parseBytes(bytes, "failure_record"), { input });
    const ref = failureRecordRef(record);
    const aliasName = bindingName(ref);
    await recover(handle, aliasName);
    const aliasBytes = await readBytes(handle, aliasName, { optional: true });
    if (aliasBytes !== null) {
      const binding = normalizeBindingRecord(parseBytes(aliasBytes, "failure_record_binding"), ref);
      if (binding.presend_failure_id !== input.presend_failure_id) {
        fail("BUSINESS_PRESEND_FAILURE_CONFLICT", "Failure record alias binds another id");
      }
    }
    return { record, ref, aliasMissing: aliasBytes === null };
  }

  async function ensureAlias(handle, record, ref) {
    const binding = Object.freeze({
      binding_version: 1,
      presend_failure_id: record.presend_failure_id,
      failure_record_ref: ref,
    });
    await recover(handle, bindingName(ref));
    await writeNoReplace(handle, bindingName(ref), binding);
  }

  async function recordVerifiedFailure(rawInput, operationOptions = {}) {
    if (!isPlainObject(operationOptions)
        || Object.keys(operationOptions).some((field) => field !== "signal")) {
      fail("BUSINESS_PRESEND_FAILURE_CONFIGURATION_INVALID", "record options are invalid");
    }
    const signal = validateAbortSignal(operationOptions.signal);
    assertNotAborted(signal);
    const input = normalizeInput(rawInput);
    const existing = await withStore(async (handle) => readByInput(handle, input, { optional: true }));
    if (existing !== null) {
      if (existing.aliasMissing) {
        await withStore((handle) => ensureAlias(handle, existing.record, existing.ref));
      }
      return resultFromRecord(existing.record);
    }

    const request = verificationRequest(input);
    let verification;
    try {
      verification = normalizeVerification(
        canonicalClone(
          await callSourceVerifier(sourceVerifiers[input.failure_source], request, signal),
          "source_verification",
        ),
        request,
      );
    } catch (error) {
      if (error instanceof BusinessPresendFailureRecorderError) throw error;
      fail(
        "BUSINESS_PRESEND_FAILURE_VERIFICATION_FAILED",
        "Trusted source verifier could not prove the pre-send failure",
        { failure_source: input.failure_source, cause_code: adapterCode(error) },
      );
    }
    const candidate = failureRecord(input, verification);
    const candidateRef = failureRecordRef(candidate);
    assertNotAborted(signal);

    // Once the durable id/ref publication starts, caller cancellation is no
    // longer observed. The operation must converge to one exact record rather
    // than turn an already-published write into an ambiguous outcome.
    return withStore(async (handle) => {
      const raced = await readByInput(handle, input, { optional: true });
      if (raced !== null) {
        if (raced.aliasMissing) await ensureAlias(handle, raced.record, raced.ref);
        return resultFromRecord(raced.record);
      }
      const name = recordName(input.presend_failure_id);
      await recover(handle, name);
      await writeNoReplace(handle, name, candidate);
      await ensureAlias(handle, candidate, candidateRef);
      return resultFromRecord(candidate);
    });
  }

  async function readVerifiedFailure({ failure_record_ref: rawRef } = {}) {
    const ref = normalizeContentRef(rawRef);
    return withStore(async (handle) => {
      const aliasName = bindingName(ref);
      await recover(handle, aliasName);
      const alias = normalizeBindingRecord(
        parseBytes(await readBytes(handle, aliasName), "failure_record_binding"),
        ref,
      );
      const inputName = recordName(alias.presend_failure_id);
      await recover(handle, inputName);
      const record = normalizeStoredRecord(
        parseBytes(await readBytes(handle, inputName), "failure_record"),
        { ref },
      );
      if (record.presend_failure_id !== alias.presend_failure_id) {
        fail("BUSINESS_PRESEND_FAILURE_CONFLICT", "Failure record alias does not bind stored record");
      }
      return resultFromRecord(record);
    });
  }

  return Object.freeze({
    capabilities: () => PRESEND_FAILURE_RECORDER_CAPABILITIES,
    readVerifiedFailure,
    recordVerifiedFailure,
  });
}

function createPresendFailureObservationFactsResolver({ delegate, recorder } = {}) {
  if (!delegate || typeof delegate.resolveObservationFacts !== "function"
      || !recorder || typeof recorder.readVerifiedFailure !== "function") {
    fail(
      "BUSINESS_PRESEND_FAILURE_CONFIGURATION_INVALID",
      "A delegate facts resolver and durable pre-send recorder are required",
    );
  }
  return Object.freeze({
    async resolveObservationFacts(input) {
      const signal = validateAbortSignal(input?.signal);
      assertNotAborted(signal);
      const base = await delegate.resolveObservationFacts(input);
      if (!isPlainObject(base)) return base;
      if (input?.observation?.name !== "provider.effect.presend_failure.recorded") {
        return base;
      }
      if (Object.hasOwn(base, "presend_failure_attestation")) {
        fail(
          "BUSINESS_PRESEND_FAILURE_FACT_OWNERSHIP_CONFLICT",
          "The durable pre-send resolver exclusively owns failure attestation facts",
        );
      }
      const payload = input.observation.payload;
      if (!isPlainObject(payload) || !isPlainObject(input.presend_failure_effect)) {
        fail(
          "BUSINESS_PRESEND_FAILURE_EFFECT_BINDING",
          "Pre-send observation facts require an authoritative immutable Effect",
        );
      }
      const stored = await recorder.readVerifiedFailure({
        failure_record_ref: payload.failure_record_ref,
      });
      assertNotAborted(signal);
      const record = stored.failure_record;
      if (!same(record.effect_identity, input.presend_failure_effect)
          || !same(record.claimed_fencing_token, payload.claimed_fencing_token)
          || record.failure_reason !== payload.failure_reason
          || !same(stored.failure_record_ref, payload.failure_record_ref)) {
        fail(
          "BUSINESS_PRESEND_FAILURE_FACT_BINDING_MISMATCH",
          "Stored pre-send evidence does not bind the observation and projection",
        );
      }
      return Object.freeze({
        ...base,
        observation_evidence_refs: [...record.evidence_refs],
        presend_failure_attestation: stored.presend_failure_attestation,
      });
    },
  });
}

module.exports = {
  BusinessPresendFailureRecorderError,
  PRESEND_FAILURE_REASON_BY_SOURCE,
  PRESEND_FAILURE_RECORDER_CAPABILITIES,
  PRESEND_FAILURE_RECORDER_CONTRACT_VERSION,
  PRESEND_FAILURE_RECORD_VERSION,
  PRESEND_FAILURE_SOURCES,
  createPresendFailureObservationFactsResolver,
  createPresendFailureRecorder,
};
