"use strict";

const crypto = require("node:crypto");
const path = require("node:path");

const { canonicalHash, canonicalJson } = require("@orquesta/contracts");
const {
  V2_EFFECT_IDENTITY_FIELDS,
  V2_MUTATING_EFFECT_KINDS,
  deriveEffectOperationScopeHashV2,
} = require("./lifecycle");
const {
  normalizeDispatchPacketVerificationReceiptV1,
} = require("./packet-store");
const {
  PROVIDER_ENTRY_AUTHORIZATION_VERSION,
  normalizeProviderEntryAuthorizationProofV1,
} = require("./provider-entry-window");
const {
  SEND_AUTHORIZATION_CONTRACT_VERSION,
  deriveCommittedSendAuthorizationHashV2,
  normalizeCommittedSendAuthorizationProofV2,
  normalizeSendAuthorizationBundleV1,
} = require("./send-authorization");

const RECORDED_FAKE_PROVIDER_VERSION = 1;
const RECORDED_FAKE_RECORD_VERSION = 2;
const RECORDED_FAKE_EVIDENCE_VERSION = 2;
const RECORDED_FAKE_AUTHORIZATION_CONTRACT_VERSION = SEND_AUTHORIZATION_CONTRACT_VERSION;
const RECORDED_FAKE_LOOKUP_CONTRACT_VERSION = 1;
const MAX_RECORD_BYTES = 1_048_576;
const MAX_INPUT_DEPTH = 24;
const MAX_INPUT_NODES = 32_768;
const MAX_ARRAY_ITEMS = 512;
const MAX_REF_BYTES = 512;
const MAX_NATIVE_TIMER_DELAY_MS = 2_147_483_647;
const MAX_STATE_RACE_RETRIES = 8;

const RECORDED_FAKE_CRASH_POINTS = Object.freeze([
  "before_binding",
  "after_binding",
  "after_call_entered",
  "after_provider_outcome",
  "after_worker_result_persisted",
  "after_ack_returned",
]);

const RECORDED_FAKE_PROBE_CRASH_POINTS = Object.freeze([
  "after_probe_seal",
  "after_probe_evidence_persisted",
]);

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

const INVOCATION_FIELDS = new Set([
  "invocation_version",
  "effect",
  "mutation_idempotency_key",
  "send_authorization_receipt_ref",
  "provider_request_ref",
  "worker_fencing_token",
]);

const SEND_AUTHORIZATION_FIELDS = new Set([
  "authorization_version",
  "authorization_kind",
  "commit",
  "send_authorization_bundle",
  "send_event",
  "receipt_event",
  "internal_receipt",
  "packet_verification_receipt",
  "effect",
  "operation_scope_binding",
  "authorized_fencing_token",
  "send_begin_lease_expires_at",
  "provider_request_ref",
  "send_authorization_receipt_ref",
]);
const COMMIT_FIELDS = new Set(["batch_id", "event_ids", "event_hashes"]);
const EVENT_FIELDS = new Set(["event_id", "schema_version", "type", "payload", "evidence_refs"]);
const SEND_EVENT_PAYLOAD_FIELDS = new Set([
  "work_order_id",
  "plan_snapshot_ref",
  "plan_hash",
  "source_id",
  "prior_work_order_revision",
  "target_work_order_revision",
  "occurred_at",
  "effect_id",
  "effect",
  "lease_id",
  "lease_owner_id",
  "lease_generation",
  "lease_expires_at",
  "packet_verification_receipt",
  "provider_settlement_cutover_id",
  "operation_scope_binding",
  "send_authorization_contract_version",
]);
const RECEIPT_EVENT_PAYLOAD_FIELDS = new Set([
  "work_order_id",
  "plan_snapshot_ref",
  "plan_hash",
  "source_id",
  "prior_work_order_revision",
  "target_work_order_revision",
  "occurred_at",
  "receipt",
]);
const INTERNAL_RECEIPT_FIELDS = new Set([
  "source_id",
  "source_type",
  "identity_hash",
  "payload_hash",
  "work_order_id",
  "applied_revision",
  "batch_id",
  "event_ids",
  "result",
  "event_hashes",
]);
const JOURNAL_INTERNAL_RECEIPT_FIELDS = new Set(
  [...INTERNAL_RECEIPT_FIELDS].filter((field) => field !== "event_hashes"),
);
const SEND_RESULT_FIELDS = new Set([
  "internal_action_id",
  "work_order_id",
  "work_order_revision",
  "effect_id",
  "action",
  "outbox_status",
  "fencing_token",
  "packet_verification_receipt",
  "send_authorization_bundle",
]);
const OPERATION_SCOPE_BINDING_FIELDS = new Set([
  "effect_kind",
  "provider_ref",
  "packet_ref",
  "packet_hash",
  "predecessor_effect_id",
  "predecessor_delivery_hash",
  "target_runtime_identity",
  "request_id",
  "response_ref",
]);
const RECOVERY_AUTHORIZATION_FIELDS = new Set([
  "provider_entry_authorization",
  "recovery_eligibility",
]);
const RECOVERY_ELIGIBILITY_FIELDS = new Set([
  "eligibility_version",
  "eligible",
  "state",
  "eligibility_basis_ref",
  "eligible_at",
  "inspected_at",
  "recovery_authorization_ref",
]);

const PROVIDER_ENTRY_CORE_FIELDS = Object.freeze([
  "provider_entry_window_ref",
  "provider_entry_window_sequence",
  "provider_entry_window_lease_expires_at",
  "provider_entry_window_fencing_token",
]);

const OUTCOME_FIELDS = new Set([
  "outcome_version",
  "classification",
  "reason",
  "runtime_identity",
  "provider_result_ref",
  "evidence_refs",
]);

const CONTENT_REF_FIELDS = new Set(["id", "hash"]);
const FENCING_TOKEN_FIELDS = new Set(["lease_id", "owner_id", "generation"]);
const RUNTIME_IDENTITY_FIELDS = new Set(["operation_id", "thread_id", "turn_id"]);
const EFFECT_FIELDS = new Set(V2_EFFECT_IDENTITY_FIELDS);
const EFFECT_KIND_SET = new Set(V2_MUTATING_EFFECT_KINDS);
const ACCEPTED_REASONS = new Set(["provider_acknowledged"]);
const NOT_SENT_REASONS = new Set([
  "provider_rejected_no_mutation",
  "provider_boundary_not_entered",
  "provider_deferred_no_mutation",
]);

const BINDING_FIELDS = new Set([
  "record_version",
  "record_kind",
  "key_hash",
  "mutation_idempotency_key",
  "invocation",
  "invocation_hash",
  "authorization_hash",
  "authorization_ref",
  "authorized_fencing_token",
  "send_begin_lease_expires_at",
  ...PROVIDER_ENTRY_CORE_FIELDS,
  "recorded_outcome_hash",
]);

const CALL_FIELDS = new Set([
  "record_version",
  "record_kind",
  "key_hash",
  "mutation_idempotency_key",
  "effect_id",
  "binding_ref",
  "authorization_hash",
  ...PROVIDER_ENTRY_CORE_FIELDS,
  "entry_checked_at",
]);

const OUTCOME_MARKER_FIELDS = new Set([
  "record_version",
  "record_kind",
  "origin",
  "key_hash",
  "mutation_idempotency_key",
  "effect_id",
  "binding_ref",
  "call_entered_ref",
  "authorization_hash",
  "recovery_authorization_hash",
  ...PROVIDER_ENTRY_CORE_FIELDS,
  "mutation_entry_checked_at",
  "recorded_outcome",
  "classification",
  "reason",
  "runtime_identity",
  "provider_result_ref",
  "evidence_refs",
  "recorded_at",
]);

const ACK_FIELDS = new Set([
  "record_version",
  "record_kind",
  "key_hash",
  "mutation_idempotency_key",
  "effect_id",
  "binding_ref",
  "provider_outcome_ref",
  "worker_result_ref",
  "authorization_hash",
  ...PROVIDER_ENTRY_CORE_FIELDS,
  "classification",
  "acknowledged_at",
]);

const WORKER_RESULT_FIELDS = new Set([
  "evidence_version",
  "evidence_kind",
  "effect_id",
  "effect_contract_version",
  "effect_kind",
  "work_order_id",
  "branch_ref",
  "attempt",
  "dispatch_id",
  "provider_ref",
  "mutation_idempotency_key",
  "classification",
  "reason",
  "runtime_identity",
  "provider_result_ref",
  "evidence_refs",
  "worker_fencing_token",
  "send_authorization_receipt_ref",
  "provider_request_ref",
  "binding_ref",
  "call_entered_ref",
  "provider_outcome_ref",
  "authorization_hash",
  ...PROVIDER_ENTRY_CORE_FIELDS,
  "entry_checked_at",
  "mutation_entry_checked_at",
  "recorded_at",
  "retry_authorization",
]);

const PROBE_EVIDENCE_FIELDS = new Set([
  "evidence_version",
  "evidence_kind",
  "effect_id",
  "mutation_idempotency_key",
  "classification",
  "probe_classification",
  "reason",
  "runtime_identity",
  "provider_result_ref",
  "binding_ref",
  "call_entered_ref",
  "provider_outcome_ref",
  "worker_result_ref",
  "authorization_hash",
  "recovery_authorization_hash",
  ...PROVIDER_ENTRY_CORE_FIELDS,
  "inspected_at",
  "retry_authorization",
]);

const FAILURE_CLASS_BY_CODE = Object.freeze({
  BUSINESS_RECORDED_FAKE_CONFIGURATION_INVALID: "configuration_invalid",
  BUSINESS_RECORDED_FAKE_AUTHORIZATION_FAILED: "authorization_invalid",
  BUSINESS_RECORDED_FAKE_RECOVERY_NOT_AUTHORIZED: "recovery_not_authorized",
  BUSINESS_RECORDED_FAKE_EFFECT_IDENTITY_INVALID: "identity_conflict",
  BUSINESS_RECORDED_FAKE_ENTRY_EXPIRED: "control_plane_blocker",
  BUSINESS_RECORDED_FAKE_CLOCK_INVALID: "control_plane_blocker",
  BUSINESS_RECORDED_FAKE_SECURITY_UNVERIFIED: "storage_unavailable",
  BUSINESS_RECORDED_FAKE_RECOVERY_FAILED: "storage_unavailable",
  BUSINESS_RECORDED_FAKE_PATH_UNSAFE: "storage_unavailable",
  BUSINESS_RECORDED_FAKE_WRITE_FAILED: "storage_unavailable",
  BUSINESS_RECORDED_FAKE_DURABILITY_UNCERTAIN: "durability_uncertain",
  BUSINESS_RECORDED_FAKE_RECORD_CORRUPT: "durability_uncertain",
  BUSINESS_RECORDED_FAKE_MUTATION_CONFLICT: "identity_conflict",
  BUSINESS_RECORDED_FAKE_RECOVERY_REQUIRED: "delivery_unknown",
  BUSINESS_RECORDED_FAKE_MUTATION_SEALED: "authoritative_absence",
  BUSINESS_RECORDED_FAKE_EVIDENCE_NOT_FOUND: "evidence_missing",
  BUSINESS_RECORDED_FAKE_CRASH: "injected_crash",
});

class BusinessRecordedFakeProviderError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "BusinessRecordedFakeProviderError";
    this.code = code;
    this.disposition = "rejected";
    this.failure_class = FAILURE_CLASS_BY_CODE[code] || "invalid_input";
    this.retry_authorization = "not_evaluated";
    this.details = deepFreeze({ ...details });
  }
}

class RecordedFakeCrashError extends BusinessRecordedFakeProviderError {
  constructor(crashPoint) {
    super(
      "BUSINESS_RECORDED_FAKE_CRASH",
      `Recorded fake provider stopped at deterministic crash point ${crashPoint}`,
      { crash_point: crashPoint },
    );
    this.name = "RecordedFakeCrashError";
    this.crash_point = crashPoint;
  }
}

function fakeError(code, message, details) {
  return new BusinessRecordedFakeProviderError(code, message, details);
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactObject(value, fields, fieldPath, code = "BUSINESS_RECORDED_FAKE_INPUT_INVALID") {
  if (!isPlainObject(value)) {
    throw fakeError(code, `${fieldPath} must be an exact plain object`, { path: fieldPath });
  }
  const keys = Object.keys(value);
  if (keys.length !== fields.size
      || keys.some((key) => !fields.has(key))
      || [...fields].some((key) => !Object.hasOwn(value, key))) {
    throw fakeError(code, `${fieldPath} has unsupported or missing fields`, { path: fieldPath });
  }
  return value;
}

function exactDataObjectSnapshot(
  value,
  fields,
  fieldPath,
  code = "BUSINESS_RECORDED_FAKE_INPUT_INVALID",
) {
  let prototype;
  let ownKeys;
  try {
    prototype = value && typeof value === "object"
      ? Object.getPrototypeOf(value)
      : undefined;
    ownKeys = prototype === Object.prototype || prototype === null
      ? Reflect.ownKeys(value)
      : [];
  } catch (error) {
    throw fakeError(code, `${fieldPath} must expose a stable exact data shape`, {
      path: fieldPath,
      cause_code: error?.code || error?.name || null,
    });
  }
  if ((prototype !== Object.prototype && prototype !== null)
      || ownKeys.length !== fields.size
      || ownKeys.some((field) => typeof field !== "string" || !fields.has(field))) {
    throw fakeError(code, `${fieldPath} must be an exact plain data object`, {
      path: fieldPath,
    });
  }
  const snapshot = {};
  for (const field of fields) {
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, field);
    } catch (error) {
      throw fakeError(code, `${fieldPath}.${field} must expose a stable data property`, {
        path: `${fieldPath}.${field}`,
        cause_code: error?.code || error?.name || null,
      });
    }
    if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) {
      throw fakeError(code, `${fieldPath}.${field} must be an enumerable data property`, {
        path: `${fieldPath}.${field}`,
      });
    }
    snapshot[field] = descriptor.value;
  }
  return snapshot;
}

function scanCanonicalInput(value, rootPath = "input") {
  let nodes = 0;
  const ancestors = new Set();

  function visit(entry, depth, fieldPath) {
    nodes += 1;
    if (nodes > MAX_INPUT_NODES || depth > MAX_INPUT_DEPTH) {
      throw fakeError(
        "BUSINESS_RECORDED_FAKE_INPUT_INVALID",
        "Recorded fake input exceeds its structural limit",
        { path: fieldPath },
      );
    }
    if (entry === null || typeof entry === "boolean") return;
    if (typeof entry === "number") {
      if (!Number.isFinite(entry)) {
        throw fakeError(
          "BUSINESS_RECORDED_FAKE_INPUT_INVALID",
          `${fieldPath} contains a non-finite number`,
          { path: fieldPath },
        );
      }
      return;
    }
    if (typeof entry === "string") {
      if (Buffer.byteLength(entry, "utf8") > MAX_RECORD_BYTES) {
        throw fakeError(
          "BUSINESS_RECORDED_FAKE_INPUT_INVALID",
          `${fieldPath} contains oversized text`,
          { path: fieldPath },
        );
      }
      return;
    }
    if (typeof entry !== "object" || ancestors.has(entry)) {
      throw fakeError(
        "BUSINESS_RECORDED_FAKE_INPUT_INVALID",
        `${fieldPath} is not acyclic canonical JSON`,
        { path: fieldPath },
      );
    }
    if (Object.getOwnPropertySymbols(entry).length !== 0) {
      throw fakeError(
        "BUSINESS_RECORDED_FAKE_INPUT_INVALID",
        `${fieldPath} contains symbol fields`,
        { path: fieldPath },
      );
    }
    ancestors.add(entry);
    try {
      if (Array.isArray(entry)) {
        if (entry.length > MAX_ARRAY_ITEMS
            || Object.getOwnPropertyNames(entry).some((name) => (
              name !== "length" && (!/^\d+$/u.test(name) || Number(name) >= entry.length)
            ))) {
          throw fakeError(
            "BUSINESS_RECORDED_FAKE_INPUT_INVALID",
            `${fieldPath} is not a bounded dense array`,
            { path: fieldPath },
          );
        }
        for (let index = 0; index < entry.length; index += 1) {
          if (!Object.hasOwn(entry, index)) {
            throw fakeError(
              "BUSINESS_RECORDED_FAKE_INPUT_INVALID",
              `${fieldPath} is not a dense array`,
              { path: fieldPath },
            );
          }
          visit(entry[index], depth + 1, `${fieldPath}[${index}]`);
        }
        return;
      }
      if (!isPlainObject(entry)) {
        throw fakeError(
          "BUSINESS_RECORDED_FAKE_INPUT_INVALID",
          `${fieldPath} contains a non-plain object`,
          { path: fieldPath },
        );
      }
      const descriptors = Object.getOwnPropertyDescriptors(entry);
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
          throw fakeError(
            "BUSINESS_RECORDED_FAKE_INPUT_INVALID",
            `${fieldPath} contains hidden or computed fields`,
            { path: fieldPath },
          );
        }
        visit(descriptor.value, depth + 1, `${fieldPath}.${key}`);
      }
    } finally {
      ancestors.delete(entry);
    }
  }

  visit(value, 0, rootPath);
}

function canonicalClone(value, rootPath = "input") {
  scanCanonicalInput(value, rootPath);
  let serialized;
  try {
    serialized = canonicalJson(value);
  } catch (error) {
    throw fakeError(
      "BUSINESS_RECORDED_FAKE_INPUT_INVALID",
      `${rootPath} must be canonical JSON`,
      { cause_code: error?.code || null },
    );
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_RECORD_BYTES) {
    throw fakeError(
      "BUSINESS_RECORDED_FAKE_INPUT_INVALID",
      `${rootPath} exceeds its byte limit`,
    );
  }
  return JSON.parse(serialized);
}

function text(value, fieldPath, maximumBytes = MAX_REF_BYTES) {
  if (typeof value !== "string"
      || value.trim() === ""
      || value.trim() !== value
      || Buffer.byteLength(value, "utf8") > maximumBytes) {
    throw fakeError(
      "BUSINESS_RECORDED_FAKE_INPUT_INVALID",
      `${fieldPath} must be bounded non-empty text`,
      { path: fieldPath },
    );
  }
  return value;
}

function portableRef(value, fieldPath) {
  const normalized = text(value, fieldPath);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@+\-]*$/u.test(normalized)) {
    throw fakeError(
      "BUSINESS_RECORDED_FAKE_INPUT_INVALID",
      `${fieldPath} must be a portable reference`,
      { path: fieldPath },
    );
  }
  return normalized;
}

function sha256(value, fieldPath) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw fakeError(
      "BUSINESS_RECORDED_FAKE_INPUT_INVALID",
      `${fieldPath} must be a lowercase SHA-256 hash`,
      { path: fieldPath },
    );
  }
  return value;
}

function integer(value, fieldPath, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw fakeError(
      "BUSINESS_RECORDED_FAKE_INPUT_INVALID",
      `${fieldPath} must be an integer from ${minimum} to ${maximum}`,
      { path: fieldPath },
    );
  }
  return value;
}

function timestamp(value, fieldPath) {
  if (typeof value !== "string" || value.length > 64) {
    throw fakeError(
      "BUSINESS_RECORDED_FAKE_INPUT_INVALID",
      `${fieldPath} must be a canonical UTC timestamp`,
      { path: fieldPath },
    );
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw fakeError(
      "BUSINESS_RECORDED_FAKE_INPUT_INVALID",
      `${fieldPath} must be a canonical UTC timestamp`,
      { path: fieldPath },
    );
  }
  return value;
}

function trustedClockValue(clock, purpose = "provider_entry") {
  let value;
  try {
    value = clock({ purpose });
  } catch (error) {
    throw fakeError(
      "BUSINESS_RECORDED_FAKE_CLOCK_INVALID",
      "Trusted provider-entry clock failed",
      { cause_code: error?.code || null },
    );
  }
  try {
    return timestamp(value, "clock");
  } catch {
    throw fakeError(
      "BUSINESS_RECORDED_FAKE_CLOCK_INVALID",
      "Trusted provider-entry clock returned a non-canonical timestamp",
    );
  }
}

function committedAuthorization(authorization) {
  return authorization?.committed_send_authorization || authorization;
}

function currentProviderEntryWindow(authorization) {
  return authorization.continuation_chain.at(-1)?.provider_entry_window
    || authorization.entry_window;
}

function providerEntryCore(authorization) {
  const window = currentProviderEntryWindow(authorization);
  return deepFreeze({
    provider_entry_window_ref: window.window_ref,
    provider_entry_window_sequence: window.window_sequence,
    provider_entry_window_lease_expires_at: window.lease_expires_at,
    provider_entry_window_fencing_token: window.authorized_fencing_token,
  });
}

function normalizeStoredProviderEntryCore(
  record,
  fieldPath,
  code = "BUSINESS_RECORDED_FAKE_RECORD_CORRUPT",
) {
  try {
    const normalized = {
      provider_entry_window_ref: contentRef(
        record.provider_entry_window_ref,
        `${fieldPath}.provider_entry_window_ref`,
      ),
      provider_entry_window_sequence: integer(
        record.provider_entry_window_sequence,
        `${fieldPath}.provider_entry_window_sequence`,
      ),
      provider_entry_window_lease_expires_at: timestamp(
        record.provider_entry_window_lease_expires_at,
        `${fieldPath}.provider_entry_window_lease_expires_at`,
      ),
      provider_entry_window_fencing_token: normalizeFencingToken(
        record.provider_entry_window_fencing_token,
        `${fieldPath}.provider_entry_window_fencing_token`,
      ),
    };
    if (normalized.provider_entry_window_ref.id
        !== `PEW-${normalized.provider_entry_window_ref.hash.slice(0, 32)}`) {
      throw fakeError(
        code,
        `${fieldPath}.provider_entry_window_ref is not a derived PEW content reference`,
      );
    }
    return normalized;
  } catch (error) {
    if (error?.code === code) throw error;
    throw fakeError(code, `${fieldPath} has an invalid provider-entry window core`, {
      cause_code: error?.code || null,
    });
  }
}

function assertEntryWindow(authorization, checkedAt, phase) {
  const stableAuthorization = committedAuthorization(authorization);
  const entryWindow = currentProviderEntryWindow(authorization);
  if (Date.parse(checkedAt) >= Date.parse(entryWindow.lease_expires_at)) {
    throw fakeError(
      "BUSINESS_RECORDED_FAKE_ENTRY_EXPIRED",
      "Provider mutation entry crossed the exact authorized lease window",
      {
        control_plane_disposition: "send_expiration_required",
        phase,
        durable_stage: phase === "after_call_entered"
          ? "call_entered"
          : (phase === "before_call_entered" ? "binding" : "none"),
        effect_id: stableAuthorization.effect.effect_id,
        mutation_idempotency_key: stableAuthorization.effect.idempotency_key,
        authorized_fencing_token: stableAuthorization.authorized_fencing_token,
        send_begin_lease_expires_at: stableAuthorization.send_begin_lease_expires_at,
        provider_entry_window_ref: entryWindow.window_ref,
        provider_entry_window_sequence: entryWindow.window_sequence,
        provider_entry_window_lease_expires_at: entryWindow.lease_expires_at,
        provider_entry_window_fencing_token: entryWindow.authorized_fencing_token,
        entry_checked_at: checkedAt,
      },
    );
  }
}

function assertClockDidNotMoveBackward(prior, current, phase) {
  if (Date.parse(current) < Date.parse(prior)) {
    throw fakeError(
      "BUSINESS_RECORDED_FAKE_CLOCK_INVALID",
      "Trusted provider-entry clock moved backwards",
      { phase, prior_checked_at: prior, entry_checked_at: current },
    );
  }
}

function contentRef(value, fieldPath) {
  const ref = exactObject(value, CONTENT_REF_FIELDS, fieldPath);
  return {
    id: portableRef(ref.id, `${fieldPath}.id`),
    hash: sha256(ref.hash, `${fieldPath}.hash`),
  };
}

function nullableContentRef(value, fieldPath) {
  return value === null ? null : contentRef(value, fieldPath);
}

function normalizeRuntimeIdentity(value, fieldPath, { required = false } = {}) {
  if (value === null) {
    if (required) {
      throw fakeError(
        "BUSINESS_RECORDED_FAKE_INPUT_INVALID",
        `${fieldPath} is required for an accepted outcome`,
        { path: fieldPath },
      );
    }
    return null;
  }
  const identity = exactObject(value, RUNTIME_IDENTITY_FIELDS, fieldPath);
  const normalized = {
    operation_id: identity.operation_id === null
      ? null
      : portableRef(identity.operation_id, `${fieldPath}.operation_id`),
    thread_id: identity.thread_id === null
      ? null
      : portableRef(identity.thread_id, `${fieldPath}.thread_id`),
    turn_id: identity.turn_id === null
      ? null
      : portableRef(identity.turn_id, `${fieldPath}.turn_id`),
  };
  if (required && Object.values(normalized).every((entry) => entry === null)) {
    throw fakeError(
      "BUSINESS_RECORDED_FAKE_INPUT_INVALID",
      `${fieldPath} must identify the accepted provider operation`,
      { path: fieldPath },
    );
  }
  return normalized;
}

function normalizeFencingToken(value, fieldPath) {
  const token = exactObject(value, FENCING_TOKEN_FIELDS, fieldPath);
  return {
    lease_id: portableRef(token.lease_id, `${fieldPath}.lease_id`),
    owner_id: portableRef(token.owner_id, `${fieldPath}.owner_id`),
    generation: integer(token.generation, `${fieldPath}.generation`, 1),
  };
}

function normalizeContentRefs(value, fieldPath) {
  if (!Array.isArray(value) || value.length > MAX_ARRAY_ITEMS) {
    throw fakeError(
      "BUSINESS_RECORDED_FAKE_INPUT_INVALID",
      `${fieldPath} must be a bounded list`,
      { path: fieldPath },
    );
  }
  const normalized = value.map((entry, index) => contentRef(entry, `${fieldPath}[${index}]`));
  if (new Set(normalized.map((entry) => entry.id)).size !== normalized.length) {
    throw fakeError(
      "BUSINESS_RECORDED_FAKE_INPUT_INVALID",
      `${fieldPath} must not repeat an evidence identifier`,
      { path: fieldPath },
    );
  }
  return normalized.sort((left, right) => left.id.localeCompare(right.id));
}

function normalizeEffectIdentity(value, fieldPath = "invocation.effect") {
  const effect = exactObject(value, EFFECT_FIELDS, fieldPath);
  const normalized = { ...effect };
  normalized.effect_id = portableRef(effect.effect_id, `${fieldPath}.effect_id`);
  normalized.effect_contract_version = integer(
    effect.effect_contract_version,
    `${fieldPath}.effect_contract_version`,
    2,
    2,
  );
  normalized.work_order_id = portableRef(effect.work_order_id, `${fieldPath}.work_order_id`);
  normalized.branch_ref = portableRef(effect.branch_ref, `${fieldPath}.branch_ref`);
  normalized.attempt = integer(effect.attempt, `${fieldPath}.attempt`, 1);
  normalized.dispatch_id = portableRef(effect.dispatch_id, `${fieldPath}.dispatch_id`);
  normalized.effect_kind = portableRef(effect.effect_kind, `${fieldPath}.effect_kind`);
  if (!EFFECT_KIND_SET.has(normalized.effect_kind)) {
    throw fakeError(
      "BUSINESS_RECORDED_FAKE_INPUT_INVALID",
      `${fieldPath}.effect_kind is not a supported mutating Effect V2 kind`,
    );
  }
  normalized.origin_source_id = portableRef(
    effect.origin_source_id,
    `${fieldPath}.origin_source_id`,
  );
  normalized.operation_scope_hash = sha256(
    effect.operation_scope_hash,
    `${fieldPath}.operation_scope_hash`,
  );
  normalized.operation_generation = integer(
    effect.operation_generation,
    `${fieldPath}.operation_generation`,
    1,
  );
  normalized.generation_predecessor_effect_id = effect.generation_predecessor_effect_id === null
    ? null
    : portableRef(
      effect.generation_predecessor_effect_id,
      `${fieldPath}.generation_predecessor_effect_id`,
    );
  normalized.provider_ref = portableRef(effect.provider_ref, `${fieldPath}.provider_ref`);
  normalized.packet_ref = portableRef(effect.packet_ref, `${fieldPath}.packet_ref`);
  normalized.packet_hash = sha256(effect.packet_hash, `${fieldPath}.packet_hash`);
  normalized.predecessor_effect_id = effect.predecessor_effect_id === null
    ? null
    : portableRef(effect.predecessor_effect_id, `${fieldPath}.predecessor_effect_id`);
  normalized.predecessor_delivery_hash = effect.predecessor_delivery_hash === null
    ? null
    : sha256(effect.predecessor_delivery_hash, `${fieldPath}.predecessor_delivery_hash`);
  normalized.target_runtime_identity = normalizeRuntimeIdentity(
    effect.target_runtime_identity,
    `${fieldPath}.target_runtime_identity`,
  );
  normalized.idempotency_key = portableRef(
    effect.idempotency_key,
    `${fieldPath}.idempotency_key`,
  );
  normalized.created_at = timestamp(effect.created_at, `${fieldPath}.created_at`);
  if ((normalized.operation_generation === 1)
        !== (normalized.generation_predecessor_effect_id === null)
      || ((normalized.predecessor_effect_id === null)
        !== (normalized.predecessor_delivery_hash === null))) {
    throw fakeError(
      "BUSINESS_RECORDED_FAKE_EFFECT_IDENTITY_INVALID",
      `${fieldPath} has an invalid generation or predecessor binding`,
    );
  }
  const threadCreate = normalized.effect_kind === "provider.thread.create";
  if (threadCreate
    ? (normalized.predecessor_effect_id !== null
      || normalized.target_runtime_identity !== null)
    : (normalized.predecessor_effect_id === null
      || normalized.target_runtime_identity === null)) {
    throw fakeError(
      "BUSINESS_RECORDED_FAKE_EFFECT_IDENTITY_INVALID",
      `${fieldPath} has an invalid provider-stage predecessor binding`,
    );
  }
  return normalized;
}

function normalizeInvocation(input) {
  const invocation = exactObject(
    canonicalClone(input, "invocation"),
    INVOCATION_FIELDS,
    "invocation",
  );
  if (invocation.invocation_version !== RECORDED_FAKE_PROVIDER_VERSION) {
    throw fakeError(
      "BUSINESS_RECORDED_FAKE_INPUT_INVALID",
      "invocation.invocation_version is unsupported",
    );
  }
  const effect = normalizeEffectIdentity(invocation.effect);
  const mutationKey = portableRef(
    invocation.mutation_idempotency_key,
    "invocation.mutation_idempotency_key",
  );
  if (mutationKey !== effect.idempotency_key) {
    throw fakeError(
      "BUSINESS_RECORDED_FAKE_MUTATION_CONFLICT",
      "Mutation key must equal the immutable Effect V2 idempotency key",
      { key_hash: mutationKeyHash(mutationKey) },
    );
  }
  return deepFreeze({
    invocation_version: RECORDED_FAKE_PROVIDER_VERSION,
    effect,
    mutation_idempotency_key: mutationKey,
    send_authorization_receipt_ref: contentRef(
      invocation.send_authorization_receipt_ref,
      "invocation.send_authorization_receipt_ref",
    ),
    provider_request_ref: contentRef(
      invocation.provider_request_ref,
      "invocation.provider_request_ref",
    ),
    worker_fencing_token: normalizeFencingToken(
      invocation.worker_fencing_token,
      "invocation.worker_fencing_token",
    ),
  });
}

function same(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function derivedContentRef(prefix, body) {
  const hash = canonicalHash(body);
  return deepFreeze({ id: `${prefix}-${hash.slice(0, 32)}`, hash });
}

function sendAuthorizationHash(authorization) {
  try {
    return deriveCommittedSendAuthorizationHashV2(committedAuthorization(authorization));
  } catch (error) {
    throw fakeError(
      "BUSINESS_RECORDED_FAKE_AUTHORIZATION_FAILED",
      "Committed send authorization cannot derive its stable authority hash",
      { cause_code: error?.code || null },
    );
  }
}

function normalizeOperationScopeBinding(value) {
  const binding = exactObject(
    value,
    OPERATION_SCOPE_BINDING_FIELDS,
    "authorization.operation_scope_binding",
    "BUSINESS_RECORDED_FAKE_AUTHORIZATION_FAILED",
  );
  return {
    effect_kind: portableRef(binding.effect_kind, "authorization.operation_scope_binding.effect_kind"),
    provider_ref: portableRef(binding.provider_ref, "authorization.operation_scope_binding.provider_ref"),
    packet_ref: portableRef(binding.packet_ref, "authorization.operation_scope_binding.packet_ref"),
    packet_hash: sha256(binding.packet_hash, "authorization.operation_scope_binding.packet_hash"),
    predecessor_effect_id: binding.predecessor_effect_id === null
      ? null
      : portableRef(
        binding.predecessor_effect_id,
        "authorization.operation_scope_binding.predecessor_effect_id",
      ),
    predecessor_delivery_hash: binding.predecessor_delivery_hash === null
      ? null
      : sha256(
        binding.predecessor_delivery_hash,
        "authorization.operation_scope_binding.predecessor_delivery_hash",
      ),
    target_runtime_identity: normalizeRuntimeIdentity(
      binding.target_runtime_identity,
      "authorization.operation_scope_binding.target_runtime_identity",
    ),
    request_id: binding.request_id === null
      ? null
      : portableRef(binding.request_id, "authorization.operation_scope_binding.request_id"),
    response_ref: binding.response_ref === null
      ? null
      : contentRef(binding.response_ref, "authorization.operation_scope_binding.response_ref"),
  };
}

function effectIdentifierSeed(effect) {
  return Object.fromEntries(V2_EFFECT_IDENTITY_FIELDS
    .filter((field) => !["effect_id", "idempotency_key", "created_at"].includes(field))
    .map((field) => [field, effect[field]]));
}

function validateDerivedEffectIdentity(effect, packetReceipt, operationBinding) {
  const isUserInput = effect.effect_kind === "provider.user_input.submit";
  if (operationBinding.effect_kind !== effect.effect_kind
      || operationBinding.provider_ref !== effect.provider_ref
      || operationBinding.packet_ref !== effect.packet_ref
      || operationBinding.packet_hash !== effect.packet_hash
      || operationBinding.predecessor_effect_id !== effect.predecessor_effect_id
      || operationBinding.predecessor_delivery_hash !== effect.predecessor_delivery_hash
      || !same(operationBinding.target_runtime_identity, effect.target_runtime_identity)
      || (isUserInput
        ? (operationBinding.request_id === null || operationBinding.response_ref === null)
        : (operationBinding.request_id !== null || operationBinding.response_ref !== null))) {
    throw fakeError(
      "BUSINESS_RECORDED_FAKE_EFFECT_IDENTITY_INVALID",
      "Trusted authorization operation scope does not bind the exact Effect V2",
      { effect_id: effect.effect_id },
    );
  }
  let expectedScope;
  try {
    expectedScope = deriveEffectOperationScopeHashV2({
      ...operationBinding,
      request_id: isUserInput ? operationBinding.request_id : undefined,
      response_ref: isUserInput ? operationBinding.response_ref : undefined,
    });
  } catch (error) {
    throw fakeError(
      "BUSINESS_RECORDED_FAKE_EFFECT_IDENTITY_INVALID",
      "Effect V2 operation scope could not be independently derived",
      { effect_id: effect.effect_id, cause_code: error?.code || null },
    );
  }
  const dispatchSeed = {
    work_order_id: effect.work_order_id,
    branch_ref: effect.branch_ref,
    attempt: effect.attempt,
    packet_ref: packetReceipt.packet_binding.dispatch_packet_ref,
  };
  const seed = effectIdentifierSeed(effect);
  if (expectedScope !== effect.operation_scope_hash
      || effect.dispatch_id !== `DSP-${canonicalHash(dispatchSeed).slice(0, 32)}`
      || effect.effect_id !== `FX-${canonicalHash(seed).slice(0, 32)}`
      || effect.idempotency_key !== `IDEM-${canonicalHash(seed).slice(0, 32)}`
      || packetReceipt.effect_identifier_seed_hash !== canonicalHash(seed)
      || packetReceipt.generation_binding_hash !== canonicalHash({
        operation_scope_hash: effect.operation_scope_hash,
        operation_generation: effect.operation_generation,
        generation_predecessor_effect_id: effect.generation_predecessor_effect_id,
      })) {
    throw fakeError(
      "BUSINESS_RECORDED_FAKE_EFFECT_IDENTITY_INVALID",
      "Effect V2 dispatch, scope, generation, or mutation identifiers do not rederive",
      { effect_id: effect.effect_id },
    );
  }
}

function normalizeAuthorizationProof(input, { pathPrefix = "send_authorization" } = {}) {
  const supplied = exactObject(
    canonicalClone(input, pathPrefix),
    SEND_AUTHORIZATION_FIELDS,
    pathPrefix,
    "BUSINESS_RECORDED_FAKE_AUTHORIZATION_FAILED",
  );
  let candidate;
  try {
    candidate = normalizeCommittedSendAuthorizationProofV2(supplied);
  } catch (error) {
    throw fakeError(
      "BUSINESS_RECORDED_FAKE_AUTHORIZATION_FAILED",
      "Resolver proof is not one exact self-contained committed send authorization",
      { cause_code: error?.code || null },
    );
  }
  if (candidate.authorization_version !== RECORDED_FAKE_AUTHORIZATION_CONTRACT_VERSION
      || candidate.authorization_kind !== "committed_outbox_send_begin") {
    throw fakeError(
      "BUSINESS_RECORDED_FAKE_AUTHORIZATION_FAILED",
      "Resolver returned an unsupported provider send authorization",
    );
  }
  const commit = exactObject(
    candidate.commit,
    COMMIT_FIELDS,
    `${pathPrefix}.commit`,
    "BUSINESS_RECORDED_FAKE_AUTHORIZATION_FAILED",
  );
  const normalizedCommit = {
    batch_id: portableRef(commit.batch_id, `${pathPrefix}.commit.batch_id`),
    event_ids: Array.isArray(commit.event_ids)
      ? commit.event_ids.map((entry, index) => portableRef(
        entry,
        `${pathPrefix}.commit.event_ids[${index}]`,
      ))
      : null,
    event_hashes: canonicalClone(commit.event_hashes, `${pathPrefix}.commit.event_hashes`),
  };
  if (normalizedCommit.event_ids === null
      || normalizedCommit.event_ids.length !== 2
      || new Set(normalizedCommit.event_ids).size !== 2
      || !isPlainObject(normalizedCommit.event_hashes)
      || Object.keys(normalizedCommit.event_hashes).length !== 2
      || !same(Object.keys(normalizedCommit.event_hashes).sort(), [
        ...normalizedCommit.event_ids,
      ].sort())) {
    throw fakeError(
      "BUSINESS_RECORDED_FAKE_AUTHORIZATION_FAILED",
      "Committed send authorization must identify its exact two-event closure",
    );
  }
  for (const eventId of normalizedCommit.event_ids) {
    sha256(
      normalizedCommit.event_hashes[eventId],
      `${pathPrefix}.commit.event_hashes.${eventId}`,
    );
  }
  let sendAuthorizationBundle;
  try {
    sendAuthorizationBundle = normalizeSendAuthorizationBundleV1(
      candidate.send_authorization_bundle,
    );
  } catch (error) {
    throw fakeError(
      "BUSINESS_RECORDED_FAKE_AUTHORIZATION_FAILED",
      "Committed send authorization has an invalid self-contained SAB",
      { cause_code: error?.code || null },
    );
  }
  const sendEvent = exactObject(
    candidate.send_event,
    EVENT_FIELDS,
    `${pathPrefix}.send_event`,
    "BUSINESS_RECORDED_FAKE_AUTHORIZATION_FAILED",
  );
  const sendPayload = exactObject(
    sendEvent.payload,
    SEND_EVENT_PAYLOAD_FIELDS,
    `${pathPrefix}.send_event.payload`,
    "BUSINESS_RECORDED_FAKE_AUTHORIZATION_FAILED",
  );
  const receiptEvent = exactObject(
    candidate.receipt_event,
    EVENT_FIELDS,
    `${pathPrefix}.receipt_event`,
    "BUSINESS_RECORDED_FAKE_AUTHORIZATION_FAILED",
  );
  const receiptEventPayload = exactObject(
    receiptEvent.payload,
    RECEIPT_EVENT_PAYLOAD_FIELDS,
    `${pathPrefix}.receipt_event.payload`,
    "BUSINESS_RECORDED_FAKE_AUTHORIZATION_FAILED",
  );
  const journalReceipt = exactObject(
    receiptEventPayload.receipt,
    JOURNAL_INTERNAL_RECEIPT_FIELDS,
    `${pathPrefix}.receipt_event.payload.receipt`,
    "BUSINESS_RECORDED_FAKE_AUTHORIZATION_FAILED",
  );
  const effect = normalizeEffectIdentity(candidate.effect, `${pathPrefix}.effect`);
  const eventEffect = normalizeEffectIdentity(
    sendPayload.effect,
    `${pathPrefix}.send_event.payload.effect`,
  );
  let packetReceipt;
  let eventPacketReceipt;
  try {
    packetReceipt = normalizeDispatchPacketVerificationReceiptV1(
      candidate.packet_verification_receipt,
    );
    eventPacketReceipt = normalizeDispatchPacketVerificationReceiptV1(
      sendPayload.packet_verification_receipt,
    );
  } catch (error) {
    throw fakeError(
      "BUSINESS_RECORDED_FAKE_AUTHORIZATION_FAILED",
      "Committed send authorization has an invalid PacketStore receipt",
      { cause_code: error?.code || null },
    );
  }
  const token = normalizeFencingToken(
    candidate.authorized_fencing_token,
    `${pathPrefix}.authorized_fencing_token`,
  );
  const sendBeginLeaseExpiresAt = timestamp(
    candidate.send_begin_lease_expires_at,
    `${pathPrefix}.send_begin_lease_expires_at`,
  );
  const providerRequestRef = contentRef(
    candidate.provider_request_ref,
    `${pathPrefix}.provider_request_ref`,
  );
  const operationBinding = normalizeOperationScopeBinding(candidate.operation_scope_binding);
  const receipt = exactObject(
    candidate.internal_receipt,
    INTERNAL_RECEIPT_FIELDS,
    `${pathPrefix}.internal_receipt`,
    "BUSINESS_RECORDED_FAKE_AUTHORIZATION_FAILED",
  );
  const result = exactObject(
    receipt.result,
    SEND_RESULT_FIELDS,
    `${pathPrefix}.internal_receipt.result`,
    "BUSINESS_RECORDED_FAKE_AUTHORIZATION_FAILED",
  );
  const resultToken = normalizeFencingToken(
    result.fencing_token,
    `${pathPrefix}.internal_receipt.result.fencing_token`,
  );
  let resultPacketReceipt;
  try {
    resultPacketReceipt = normalizeDispatchPacketVerificationReceiptV1(
      result.packet_verification_receipt,
    );
  } catch (error) {
    throw fakeError(
      "BUSINESS_RECORDED_FAKE_AUTHORIZATION_FAILED",
      "Committed internal receipt has an invalid PacketStore receipt",
      { cause_code: error?.code || null },
    );
  }
  const normalizedSendEvent = {
    event_id: portableRef(sendEvent.event_id, `${pathPrefix}.send_event.event_id`),
    schema_version: integer(sendEvent.schema_version, `${pathPrefix}.send_event.schema_version`, 1, 1),
    type: sendEvent.type,
    payload: canonicalClone(sendPayload, `${pathPrefix}.send_event.payload`),
    evidence_refs: canonicalClone(sendEvent.evidence_refs, `${pathPrefix}.send_event.evidence_refs`),
  };
  const normalizedReceiptEvent = {
    event_id: portableRef(receiptEvent.event_id, `${pathPrefix}.receipt_event.event_id`),
    schema_version: integer(
      receiptEvent.schema_version,
      `${pathPrefix}.receipt_event.schema_version`,
      1,
      1,
    ),
    type: receiptEvent.type,
    payload: canonicalClone(receiptEventPayload, `${pathPrefix}.receipt_event.payload`),
    evidence_refs: canonicalClone(
      receiptEvent.evidence_refs,
      `${pathPrefix}.receipt_event.evidence_refs`,
    ),
  };
  portableRef(sendPayload.work_order_id, `${pathPrefix}.send_event.payload.work_order_id`);
  portableRef(sendPayload.plan_snapshot_ref, `${pathPrefix}.send_event.payload.plan_snapshot_ref`);
  sha256(sendPayload.plan_hash, `${pathPrefix}.send_event.payload.plan_hash`);
  portableRef(sendPayload.source_id, `${pathPrefix}.send_event.payload.source_id`);
  integer(
    sendPayload.prior_work_order_revision,
    `${pathPrefix}.send_event.payload.prior_work_order_revision`,
    1,
  );
  integer(
    sendPayload.target_work_order_revision,
    `${pathPrefix}.send_event.payload.target_work_order_revision`,
    1,
  );
  timestamp(sendPayload.lease_expires_at, `${pathPrefix}.send_event.payload.lease_expires_at`);
  portableRef(
    sendPayload.provider_settlement_cutover_id,
    `${pathPrefix}.send_event.payload.provider_settlement_cutover_id`,
  );
  portableRef(receipt.source_id, `${pathPrefix}.internal_receipt.source_id`);
  sha256(receipt.identity_hash, `${pathPrefix}.internal_receipt.identity_hash`);
  sha256(receipt.payload_hash, `${pathPrefix}.internal_receipt.payload_hash`);
  integer(receipt.applied_revision, `${pathPrefix}.internal_receipt.applied_revision`, 1);
  portableRef(result.internal_action_id, `${pathPrefix}.internal_receipt.result.internal_action_id`);
  integer(
    result.work_order_revision,
    `${pathPrefix}.internal_receipt.result.work_order_revision`,
    1,
  );
  const normalizedReceipt = canonicalClone(receipt, `${pathPrefix}.internal_receipt`);
  if (!isPlainObject(receipt.event_hashes)
      || Object.getPrototypeOf(receipt.event_hashes) !== Object.prototype
      || Object.keys(receipt.event_hashes).length !== normalizedCommit.event_ids.length
      || !same(Object.keys(receipt.event_hashes).sort(), [...normalizedCommit.event_ids].sort())) {
    throw fakeError(
      "BUSINESS_RECORDED_FAKE_AUTHORIZATION_FAILED",
      "Stored internal receipt must close the exact committed event-hash set",
    );
  }
  for (const eventId of normalizedCommit.event_ids) {
    sha256(receipt.event_hashes[eventId], `${pathPrefix}.internal_receipt.event_hashes.${eventId}`);
  }
  const storedReceiptWithoutEventHashes = { ...normalizedReceipt };
  delete storedReceiptWithoutEventHashes.event_hashes;
  if (sendEvent.type !== "business.outbox.send_begun"
      || !Array.isArray(sendEvent.evidence_refs)
      || sendEvent.evidence_refs.length !== 0
      || normalizedCommit.event_ids[0] !== normalizedSendEvent.event_id
      || normalizedCommit.event_ids[1] !== normalizedReceiptEvent.event_id
      || receiptEvent.type !== "business.internal_action.received"
      || !Array.isArray(receiptEvent.evidence_refs)
      || receiptEvent.evidence_refs.length !== 0
      || receipt.event_hashes[normalizedSendEvent.event_id]
        !== canonicalHash(normalizedSendEvent)
      || receipt.event_hashes[normalizedReceiptEvent.event_id]
        !== canonicalHash(normalizedReceiptEvent)
      || !same(receipt.event_hashes, normalizedCommit.event_hashes)
      || !same(journalReceipt, storedReceiptWithoutEventHashes)
      || normalizedCommit.batch_id !== receipt.batch_id
      || receipt.source_type !== "internal_action"
      || receipt.source_id !== sendPayload.source_id
      || receipt.source_id !== result.internal_action_id
      || receipt.work_order_id !== effect.work_order_id
      || receipt.work_order_id !== result.work_order_id
      || receipt.applied_revision !== result.work_order_revision
      || receipt.batch_id !== `business:${receipt.source_id}`
      || !Array.isArray(receipt.event_ids)
      || receipt.event_ids.length !== 1
      || receipt.event_ids[0] !== normalizedSendEvent.event_id
      || result.action !== "outbox.send.begin"
      || result.outbox_status !== "sending"
      || result.effect_id !== effect.effect_id
      || sendPayload.effect_id !== effect.effect_id
      || sendPayload.work_order_id !== effect.work_order_id
      || receiptEventPayload.work_order_id !== sendPayload.work_order_id
      || receiptEventPayload.plan_snapshot_ref !== sendPayload.plan_snapshot_ref
      || receiptEventPayload.plan_hash !== sendPayload.plan_hash
      || receiptEventPayload.source_id !== sendPayload.source_id
      || receiptEventPayload.prior_work_order_revision !== sendPayload.prior_work_order_revision
      || receiptEventPayload.target_work_order_revision !== sendPayload.target_work_order_revision
      || receiptEventPayload.occurred_at !== sendPayload.occurred_at
      || sendPayload.lease_id !== token.lease_id
      || sendPayload.lease_owner_id !== token.owner_id
      || sendPayload.lease_generation !== token.generation
      || !same(resultToken, token)
      || !same(effect, eventEffect)
      || !same(effect, packetReceipt.effect_identity)
      || !same(packetReceipt, eventPacketReceipt)
      || !same(packetReceipt, resultPacketReceipt)
      || !same(providerRequestRef, packetReceipt.packet_ref)
      || !same(sendAuthorizationBundle, candidate.send_authorization_bundle)
      || !same(sendAuthorizationBundle, result.send_authorization_bundle)
      || !same(sendAuthorizationBundle.send_event, normalizedSendEvent)
      || !same(operationBinding, sendPayload.operation_scope_binding)
      || sendPayload.send_authorization_contract_version
        !== RECORDED_FAKE_AUTHORIZATION_CONTRACT_VERSION
      || sendPayload.lease_expires_at !== sendBeginLeaseExpiresAt
      || Date.parse(sendPayload.occurred_at) >= Date.parse(sendBeginLeaseExpiresAt)
      || timestamp(sendPayload.occurred_at, `${pathPrefix}.send_event.payload.occurred_at`)
        !== sendPayload.occurred_at) {
    throw fakeError(
      "BUSINESS_RECORDED_FAKE_AUTHORIZATION_FAILED",
      "Resolver proof does not close the committed send event, receipt, Effect, lease, and packet",
      { effect_id: effect.effect_id },
    );
  }
  validateDerivedEffectIdentity(effect, packetReceipt, operationBinding);
  const authorizationBody = {
    authorization_version: RECORDED_FAKE_AUTHORIZATION_CONTRACT_VERSION,
    authorization_kind: "committed_outbox_send_begin",
    commit: normalizedCommit,
    send_authorization_bundle: sendAuthorizationBundle,
    send_event: normalizedSendEvent,
    receipt_event: normalizedReceiptEvent,
    internal_receipt: normalizedReceipt,
    packet_verification_receipt: packetReceipt,
    effect,
    operation_scope_binding: operationBinding,
    authorized_fencing_token: token,
    send_begin_lease_expires_at: sendBeginLeaseExpiresAt,
    provider_request_ref: providerRequestRef,
  };
  const expectedSendRef = derivedContentRef("IAR", normalizedReceipt);
  const suppliedSendRef = contentRef(
    candidate.send_authorization_receipt_ref,
    `${pathPrefix}.send_authorization_receipt_ref`,
  );
  if (!same(expectedSendRef, suppliedSendRef)) {
    throw fakeError(
      "BUSINESS_RECORDED_FAKE_AUTHORIZATION_FAILED",
      "Send authorization reference does not address the complete committed proof",
      { effect_id: effect.effect_id },
    );
  }
  const normalized = { ...authorizationBody, send_authorization_receipt_ref: suppliedSendRef };
  return deepFreeze(normalized);
}

function normalizeProviderEntryAuthorization(input, fieldPath) {
  let sharedProof;
  try {
    sharedProof = normalizeProviderEntryAuthorizationProofV1(input);
  } catch (error) {
    throw fakeError(
      "BUSINESS_RECORDED_FAKE_AUTHORIZATION_FAILED",
      `${fieldPath} is not one exact provider-entry authorization proof`,
      { cause_code: error?.code || null },
    );
  }
  const stableAuthorization = normalizeAuthorizationProof(
    sharedProof.committed_send_authorization,
    { pathPrefix: `${fieldPath}.committed_send_authorization` },
  );
  const stableHash = sendAuthorizationHash(stableAuthorization);
  if (sharedProof.provider_entry_authorization_version
        !== PROVIDER_ENTRY_AUTHORIZATION_VERSION
      || stableHash !== sharedProof.committed_send_authorization_hash
      || !same(stableAuthorization, sharedProof.committed_send_authorization)) {
    throw fakeError(
      "BUSINESS_RECORDED_FAKE_AUTHORIZATION_FAILED",
      `${fieldPath} does not close over its exact stable committed send authority`,
    );
  }
  return deepFreeze({
    ...sharedProof,
    committed_send_authorization: stableAuthorization,
    committed_send_authorization_hash: stableHash,
  });
}

function normalizeRecoveryAuthorization(input, inspectedAt) {
  const supplied = exactDataObjectSnapshot(
    input,
    RECOVERY_AUTHORIZATION_FIELDS,
    "recovery_authorization",
    "BUSINESS_RECORDED_FAKE_RECOVERY_NOT_AUTHORIZED",
  );
  const providerEntryAuthorization = normalizeProviderEntryAuthorization(
    supplied.provider_entry_authorization,
    "recovery_authorization.provider_entry_authorization",
  );
  const eligibility = exactObject(
    canonicalClone(
      supplied.recovery_eligibility,
      "recovery_authorization.recovery_eligibility",
    ),
    RECOVERY_ELIGIBILITY_FIELDS,
    "recovery_authorization.recovery_eligibility",
    "BUSINESS_RECORDED_FAKE_RECOVERY_NOT_AUTHORIZED",
  );
  const normalizedEligibilityBody = {
    eligibility_version: integer(
      eligibility.eligibility_version,
      "recovery_authorization.recovery_eligibility.eligibility_version",
      1,
      1,
    ),
    eligible: eligibility.eligible,
    state: eligibility.state,
    eligibility_basis_ref: contentRef(
      eligibility.eligibility_basis_ref,
      "recovery_authorization.recovery_eligibility.eligibility_basis_ref",
    ),
    eligible_at: timestamp(
      eligibility.eligible_at,
      "recovery_authorization.recovery_eligibility.eligible_at",
    ),
    inspected_at: timestamp(
      eligibility.inspected_at,
      "recovery_authorization.recovery_eligibility.inspected_at",
    ),
  };
  const stableAuthorization = providerEntryAuthorization.committed_send_authorization;
  if (normalizedEligibilityBody.eligible !== true
      || !["delivery_unknown", "expired_sending"].includes(normalizedEligibilityBody.state)
      || normalizedEligibilityBody.inspected_at !== inspectedAt
      || Date.parse(normalizedEligibilityBody.eligible_at) > Date.parse(inspectedAt)) {
    throw fakeError(
      "BUSINESS_RECORDED_FAKE_RECOVERY_NOT_AUTHORIZED",
      "Recovery inspection is not authorized by one committed eligible state",
      { effect_id: stableAuthorization.effect.effect_id },
    );
  }
  const expectedRecoveryRef = derivedContentRef("RAR", {
    authorization_hash: providerEntryAuthorization.committed_send_authorization_hash,
    recovery_eligibility: normalizedEligibilityBody,
    inspected_at: normalizedEligibilityBody.inspected_at,
  });
  const suppliedRecoveryRef = contentRef(
    eligibility.recovery_authorization_ref,
    "recovery_authorization.recovery_eligibility.recovery_authorization_ref",
  );
  if (!same(expectedRecoveryRef, suppliedRecoveryRef)) {
    throw fakeError(
      "BUSINESS_RECORDED_FAKE_RECOVERY_NOT_AUTHORIZED",
      "Recovery authorization reference does not address its committed eligibility proof",
      { effect_id: stableAuthorization.effect.effect_id },
    );
  }
  return deepFreeze({
    provider_entry_authorization: providerEntryAuthorization,
    recovery_eligibility: {
      ...normalizedEligibilityBody,
      recovery_authorization_ref: suppliedRecoveryRef,
    },
  });
}

function normalizeOutcome(input, fieldPath = "recorded_outcome") {
  const outcome = exactObject(canonicalClone(input, fieldPath), OUTCOME_FIELDS, fieldPath);
  if (outcome.outcome_version !== RECORDED_FAKE_PROVIDER_VERSION
      || !["accepted", "not_sent"].includes(outcome.classification)) {
    throw fakeError(
      "BUSINESS_RECORDED_FAKE_CONFIGURATION_INVALID",
      `${fieldPath} is not a supported recorded provider outcome`,
      { path: fieldPath },
    );
  }
  const accepted = outcome.classification === "accepted";
  const reasonSet = accepted ? ACCEPTED_REASONS : NOT_SENT_REASONS;
  if (!reasonSet.has(outcome.reason)) {
    throw fakeError(
      "BUSINESS_RECORDED_FAKE_CONFIGURATION_INVALID",
      `${fieldPath}.reason does not match its immutable classification`,
      { path: `${fieldPath}.reason` },
    );
  }
  const runtimeIdentity = normalizeRuntimeIdentity(
    outcome.runtime_identity,
    `${fieldPath}.runtime_identity`,
    { required: accepted },
  );
  const providerResultRef = nullableContentRef(
    outcome.provider_result_ref,
    `${fieldPath}.provider_result_ref`,
  );
  if ((accepted && providerResultRef === null)
      || (!accepted && (runtimeIdentity !== null || providerResultRef !== null))) {
    throw fakeError(
      "BUSINESS_RECORDED_FAKE_CONFIGURATION_INVALID",
      `${fieldPath} invents or omits provider mutation evidence`,
      { path: fieldPath },
    );
  }
  return deepFreeze({
    outcome_version: RECORDED_FAKE_PROVIDER_VERSION,
    classification: outcome.classification,
    reason: outcome.reason,
    runtime_identity: runtimeIdentity,
    provider_result_ref: providerResultRef,
    evidence_refs: normalizeContentRefs(outcome.evidence_refs, `${fieldPath}.evidence_refs`),
  });
}

function normalizeRecordedOutcomes(value) {
  if (!isPlainObject(value)) {
    throw fakeError(
      "BUSINESS_RECORDED_FAKE_CONFIGURATION_INVALID",
      "recorded_outcomes must be an exact in-memory recording keyed by mutation idempotency key",
    );
  }
  const result = {};
  for (const [key, outcome] of Object.entries(value)) {
    const normalizedKey = portableRef(key, "recorded_outcomes key");
    result[normalizedKey] = normalizeOutcome(outcome, "recorded_outcomes.*");
  }
  return deepFreeze(result);
}

function normalizeInspectInput(input) {
  const value = exactObject(
    canonicalClone(input, "probe"),
    new Set([
      "probe_version",
      "mutation_idempotency_key",
      "expected_effect_id",
      "send_authorization_receipt_ref",
      "inspected_at",
    ]),
    "probe",
  );
  if (value.probe_version !== RECORDED_FAKE_PROVIDER_VERSION) {
    throw fakeError(
      "BUSINESS_RECORDED_FAKE_INPUT_INVALID",
      "probe.probe_version is unsupported",
    );
  }
  return deepFreeze({
    probe_version: RECORDED_FAKE_PROVIDER_VERSION,
    mutation_idempotency_key: portableRef(
      value.mutation_idempotency_key,
      "probe.mutation_idempotency_key",
    ),
    expected_effect_id: portableRef(value.expected_effect_id, "probe.expected_effect_id"),
    send_authorization_receipt_ref: contentRef(
      value.send_authorization_receipt_ref,
      "probe.send_authorization_receipt_ref",
    ),
    inspected_at: timestamp(value.inspected_at, "probe.inspected_at"),
  });
}

function validateRootPath(rootPath) {
  if (typeof rootPath !== "string"
      || rootPath.trim() === ""
      || rootPath !== path.resolve(rootPath)
      || path.normalize(rootPath) !== rootPath) {
    throw fakeError(
      "BUSINESS_RECORDED_FAKE_CONFIGURATION_INVALID",
      "root_path must be one normalized absolute path",
    );
  }
  return rootPath;
}

function validatePlatformAdapter(adapter) {
  if (!adapter || typeof adapter !== "object" || Array.isArray(adapter)
      || PLATFORM_ADAPTER_METHODS.some((method) => typeof adapter[method] !== "function")) {
    throw fakeError(
      "BUSINESS_RECORDED_FAKE_CONFIGURATION_INVALID",
      "A complete trusted recorded-fake platform adapter is required",
    );
  }
  return adapter;
}

function validateAuthorizationResolver(resolver) {
  if (!resolver || typeof resolver !== "object" || Array.isArray(resolver)
      || typeof resolver.resolveSendAuthorization !== "function"
      || typeof resolver.resolveRetainedProviderEntryAuthorization !== "function"
      || typeof resolver.resolveRecoveryAuthorization !== "function") {
    throw fakeError(
      "BUSINESS_RECORDED_FAKE_CONFIGURATION_INVALID",
      "A trusted live, retained, and recovery provider-entry authorization resolver is required",
    );
  }
  return resolver;
}

function validateSecurityProof(proof, rootPath, allowTestOnlyPlatformAdapter) {
  if (process.platform === "win32" || proof?.platform === "win32") {
    throw fakeError(
      "BUSINESS_RECORDED_FAKE_SECURITY_UNVERIFIED",
      "Recorded fake evidence store is fail-closed on Windows",
    );
  }
  if (!isPlainObject(proof)
      || Object.keys(proof).length !== SECURITY_PROOF_FIELDS.size
      || Object.keys(proof).some((field) => !SECURITY_PROOF_FIELDS.has(field))
      || proof.proof_version !== 1
      || !["production", "single_process_test_only"].includes(proof.proof_scope)
      || typeof proof.platform !== "string"
      || proof.platform.trim() === ""
      || proof.platform === "win32"
      || proof.root_realpath !== rootPath
      || typeof proof.privacy_enforcement !== "string"
      || proof.privacy_enforcement.trim() === ""
      || proof.owner_only_directories !== true
      || proof.owner_only_files !== true
      || proof.private_acl_verified !== true
      || proof.symlink_components_rejected !== true
      || proof.no_follow_reads !== true
      || (proof.proof_scope === "production"
        ? (proof.exclusive_store_sessions !== true
          || proof.process_local_exclusive_store_sessions !== false)
        : (!allowTestOnlyPlatformAdapter
          || proof.exclusive_store_sessions !== false
          || proof.process_local_exclusive_store_sessions !== true))
      || proof.exclusive_temp_creation !== true
      || proof.atomic_no_replace_rename !== true
      || proof.atomic_mutation_index !== true
      || proof.file_fsync !== true
      || proof.directory_fsync !== true
      || proof.coordinated_recovery !== true
      || proof.directory_handle_pinned !== true) {
    throw fakeError(
      "BUSINESS_RECORDED_FAKE_SECURITY_UNVERIFIED",
      "Platform adapter did not prove a private, serialized, no-follow, durable mutation index",
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
    throw fakeError(
      "BUSINESS_RECORDED_FAKE_RECOVERY_FAILED",
      "Platform adapter did not prove exclusive interrupted-write recovery",
    );
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

function isUnsafe(error) {
  return ["ELOOP", "ENOTDIR", "RECORDED_FAKE_UNSAFE_PATH"].includes(adapterCode(error));
}

function mutationKeyHash(mutationKey) {
  return canonicalHash({ mutation_idempotency_key: mutationKey });
}

function fileNames(keyHash) {
  return Object.freeze({
    binding: `recorded-fake-${keyHash}-binding.json`,
    call_entered: `recorded-fake-${keyHash}-call-entered.json`,
    provider_accepted: `recorded-fake-${keyHash}-provider-accepted.json`,
    not_mutated: `recorded-fake-${keyHash}-not-mutated.json`,
    ack_returned: `recorded-fake-${keyHash}-ack-returned.json`,
  });
}

function evidenceFileName(hash) {
  return `recorded-fake-evidence-${hash}.json`;
}

function recordBytes(record) {
  const serialized = canonicalJson(record);
  if (Buffer.byteLength(serialized, "utf8") > MAX_RECORD_BYTES) {
    throw fakeError(
      "BUSINESS_RECORDED_FAKE_INPUT_INVALID",
      "Recorded fake durable record exceeds its byte limit",
    );
  }
  return Buffer.from(`${serialized}\n`, "utf8");
}

function parseStoredRecord(bytes, targetName) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_RECORD_BYTES + 1) {
    throw fakeError(
      "BUSINESS_RECORDED_FAKE_RECORD_CORRUPT",
      "Recorded fake durable record bytes are invalid",
      { target_name: targetName },
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw fakeError(
      "BUSINESS_RECORDED_FAKE_RECORD_CORRUPT",
      "Recorded fake durable record is not JSON",
      { target_name: targetName },
    );
  }
  let canonical;
  try {
    canonical = recordBytes(parsed);
  } catch {
    throw fakeError(
      "BUSINESS_RECORDED_FAKE_RECORD_CORRUPT",
      "Recorded fake durable record is not canonical",
      { target_name: targetName },
    );
  }
  if (!bytes.equals(canonical)) {
    throw fakeError(
      "BUSINESS_RECORDED_FAKE_RECORD_CORRUPT",
      "Recorded fake durable record bytes are not canonical",
      { target_name: targetName },
    );
  }
  return parsed;
}

function markerRef(record) {
  const hash = canonicalHash(record);
  return deepFreeze({
    id: `recorded-fake-marker:${record.record_kind}:${hash}`,
    hash,
  });
}

function evidenceRef(record) {
  const hash = canonicalHash(record);
  const prefix = record.evidence_kind === "worker_result" ? "WRR" : "PRB";
  return deepFreeze({ id: `${prefix}-${hash.slice(0, 32)}`, hash });
}

function refsEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function recordsEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function normalizeCrashPoint(value, allowed, fieldPath) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw fakeError(
      "BUSINESS_RECORDED_FAKE_INPUT_INVALID",
      `${fieldPath} is not a supported deterministic crash point`,
      { crash_point: typeof value === "string" ? value : null },
    );
  }
  return value;
}

function maybeCrash(selected, point) {
  if (selected === point) throw new RecordedFakeCrashError(point);
}

function createRecordedFakeProviderDriver({
  root_path: rootPath,
  platform_adapter: inputAdapter,
  recorded_outcomes: inputOutcomes,
  authorization_resolver: inputAuthorizationResolver,
  clock: inputClock,
  test_only_allow_process_local_adapter: allowTestOnlyPlatformAdapter = false,
} = {}) {
  const normalizedRootPath = validateRootPath(rootPath);
  const adapter = validatePlatformAdapter(inputAdapter);
  const authorizationResolver = validateAuthorizationResolver(inputAuthorizationResolver);
  if (typeof inputClock !== "function") {
    throw fakeError(
      "BUSINESS_RECORDED_FAKE_CONFIGURATION_INVALID",
      "A trusted provider-entry clock is required",
    );
  }
  const clock = inputClock;
  const recordedOutcomes = normalizeRecordedOutcomes(inputOutcomes);
  if (typeof allowTestOnlyPlatformAdapter !== "boolean") {
    throw fakeError(
      "BUSINESS_RECORDED_FAKE_CONFIGURATION_INVALID",
      "test_only_allow_process_local_adapter must be boolean",
    );
  }

  function providerEntryQuery(invocation, minimumProviderEntryWindowRef) {
    return {
      authorization_contract_version: RECORDED_FAKE_AUTHORIZATION_CONTRACT_VERSION,
      effect_id: invocation.effect.effect_id,
      mutation_idempotency_key: invocation.mutation_idempotency_key,
      send_authorization_receipt_ref: invocation.send_authorization_receipt_ref,
      provider_request_ref: invocation.provider_request_ref,
      worker_fencing_token: invocation.worker_fencing_token,
      minimum_provider_entry_window_ref: minimumProviderEntryWindowRef,
    };
  }

  function validateResolvedProviderEntryAuthorization(
    proof,
    invocation,
    minimumProviderEntryWindowRef,
    fieldPath,
  ) {
    const authorization = normalizeProviderEntryAuthorization(proof, fieldPath);
    const stableAuthorization = authorization.committed_send_authorization;
    const expectedEntryWindow = authorization.entry_window;
    const selectorMatches = minimumProviderEntryWindowRef === null
      ? (expectedEntryWindow.window_kind === "send_begin"
        && expectedEntryWindow.window_sequence === 0)
      : same(expectedEntryWindow.window_ref, minimumProviderEntryWindowRef);
    if (!selectorMatches
        || !same(stableAuthorization.effect, invocation.effect)
        || stableAuthorization.effect.idempotency_key !== invocation.mutation_idempotency_key
        || !same(
          stableAuthorization.send_authorization_receipt_ref,
          invocation.send_authorization_receipt_ref,
        )
        || !same(stableAuthorization.provider_request_ref, invocation.provider_request_ref)
        || !same(
          stableAuthorization.authorized_fencing_token,
          invocation.worker_fencing_token,
        )) {
      throw fakeError(
        "BUSINESS_RECORDED_FAKE_AUTHORIZATION_FAILED",
        "Provider-entry authorization does not bind the exact invocation and driver-derived minimum",
        { effect_id: invocation.effect.effect_id },
      );
    }
    return authorization;
  }

  async function resolveProviderEntryAuthorization(
    method,
    invocation,
    minimumProviderEntryWindowRef,
    { signal = null } = {},
  ) {
    let proof;
    try {
      const query = providerEntryQuery(invocation, minimumProviderEntryWindowRef);
      proof = signal === null
        ? await authorizationResolver[method](query)
        : await authorizationResolver[method](query, { signal });
    } catch (error) {
      throw fakeError(
        "BUSINESS_RECORDED_FAKE_AUTHORIZATION_FAILED",
        "Trusted resolver could not prove one exact provider-entry authorization chain",
        { cause_code: error?.code || null },
      );
    }
    return validateResolvedProviderEntryAuthorization(
      proof,
      invocation,
      minimumProviderEntryWindowRef,
      method === "resolveSendAuthorization"
        ? "send_authorization"
        : "retained_provider_entry_authorization",
    );
  }

  async function resolveSendAuthorization(
    invocation,
    minimumProviderEntryWindowRef,
    options = {},
  ) {
    return resolveProviderEntryAuthorization(
      "resolveSendAuthorization",
      invocation,
      minimumProviderEntryWindowRef,
      options,
    );
  }

  async function resolveRetainedProviderEntryAuthorization(
    invocation,
    minimumProviderEntryWindowRef,
  ) {
    return resolveProviderEntryAuthorization(
      "resolveRetainedProviderEntryAuthorization",
      invocation,
      minimumProviderEntryWindowRef,
    );
  }

  async function resolveSendAuthorizationBeforeExpiry(
    invocation,
    currentAuthorization,
    resolutionStartedAt,
  ) {
    const minimumProviderEntryWindowRef = providerEntryCore(
      currentAuthorization,
    ).provider_entry_window_ref;
    const leaseExpiresAt = providerEntryCore(
      currentAuthorization,
    ).provider_entry_window_lease_expires_at;
    const controller = new AbortController();
    let timer = null;
    let lastCheckedAt = resolutionStartedAt;
    let settled = false;
    let rejectExpiry;
    const expiry = new Promise((resolve, reject) => {
      void resolve;
      rejectExpiry = reject;
    });

    function rejectAndAbort(error) {
      if (settled) return;
      settled = true;
      rejectExpiry(error);
      controller.abort(error);
    }

    function armExactLeaseDeadline() {
      const remaining = Date.parse(leaseExpiresAt) - Date.parse(lastCheckedAt);
      if (remaining <= 0) {
        try {
          assertEntryWindow(
            currentAuthorization,
            lastCheckedAt,
            "during_authorization_recheck",
          );
        } catch (error) {
          rejectAndAbort(error);
        }
        return;
      }
      timer = setTimeout(() => {
        try {
          const checkedAt = trustedClockValue(clock);
          assertClockDidNotMoveBackward(
            lastCheckedAt,
            checkedAt,
            "during_authorization_recheck",
          );
          lastCheckedAt = checkedAt;
          if (Date.parse(checkedAt) < Date.parse(leaseExpiresAt)) {
            armExactLeaseDeadline();
            return;
          }
          assertEntryWindow(
            currentAuthorization,
            checkedAt,
            "during_authorization_recheck",
          );
        } catch (error) {
          rejectAndAbort(error);
        }
      }, Math.min(remaining, MAX_NATIVE_TIMER_DELAY_MS));
    }

    armExactLeaseDeadline();
    try {
      return await Promise.race([
        resolveSendAuthorization(
          invocation,
          minimumProviderEntryWindowRef,
          { signal: controller.signal },
        ),
        expiry,
      ]);
    } finally {
      settled = true;
      if (timer !== null) clearTimeout(timer);
    }
  }

  async function resolveRecoveryAuthorization(probe, minimumProviderEntryWindowRef) {
    let proof;
    try {
      proof = await authorizationResolver.resolveRecoveryAuthorization({
        authorization_contract_version: RECORDED_FAKE_AUTHORIZATION_CONTRACT_VERSION,
        effect_id: probe.expected_effect_id,
        mutation_idempotency_key: probe.mutation_idempotency_key,
        send_authorization_receipt_ref: probe.send_authorization_receipt_ref,
        inspected_at: probe.inspected_at,
        minimum_provider_entry_window_ref: minimumProviderEntryWindowRef,
      });
    } catch (error) {
      throw fakeError(
        "BUSINESS_RECORDED_FAKE_RECOVERY_NOT_AUTHORIZED",
        "Trusted resolver did not authorize exact-key recovery inspection",
        { cause_code: error?.code || null },
      );
    }
    const authorization = normalizeRecoveryAuthorization(proof, probe.inspected_at);
    const providerEntryAuthorization = authorization.provider_entry_authorization;
    const stableAuthorization = providerEntryAuthorization.committed_send_authorization;
    const selectorMatches = minimumProviderEntryWindowRef === null
      ? (providerEntryAuthorization.entry_window.window_kind === "send_begin"
        && providerEntryAuthorization.entry_window.window_sequence === 0)
      : same(
        providerEntryAuthorization.entry_window.window_ref,
        minimumProviderEntryWindowRef,
      );
    if (!selectorMatches
        || stableAuthorization.effect.effect_id !== probe.expected_effect_id
        || stableAuthorization.effect.idempotency_key !== probe.mutation_idempotency_key
        || !same(
          stableAuthorization.send_authorization_receipt_ref,
          probe.send_authorization_receipt_ref,
        )) {
      throw fakeError(
        "BUSINESS_RECORDED_FAKE_RECOVERY_NOT_AUTHORIZED",
        "Recovery authorization does not bind the exact committed send",
        { effect_id: probe.expected_effect_id },
      );
    }
    return authorization;
  }

  async function withStore(operation) {
    let session;
    try {
      session = await adapter.openStore({ root_path: normalizedRootPath });
    } catch (error) {
      throw fakeError(
        "BUSINESS_RECORDED_FAKE_SECURITY_UNVERIFIED",
        "Trusted platform adapter could not open the recorded fake store",
        { cause_code: adapterCode(error) },
      );
    }
    if (!isPlainObject(session) || session.handle === null || session.handle === undefined
        || !Object.hasOwn(session, "proof")) {
      throw fakeError(
        "BUSINESS_RECORDED_FAKE_SECURITY_UNVERIFIED",
        "Trusted platform adapter returned an invalid store session",
      );
    }
    let primaryError = null;
    try {
      validateSecurityProof(session.proof, normalizedRootPath, allowTestOnlyPlatformAdapter);
      return await operation(session.handle);
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      try {
        await adapter.closeStore({ store_handle: session.handle });
      } catch (error) {
        if (primaryError === null) {
          throw fakeError(
            "BUSINESS_RECORDED_FAKE_SECURITY_UNVERIFIED",
            "Trusted platform adapter could not close its exclusive store session",
            { cause_code: adapterCode(error) },
          );
        }
      }
    }
  }

  async function recoverTarget(storeHandle, targetName) {
    let proof;
    try {
      proof = await adapter.recoverInterruptedWrites({
        store_handle: storeHandle,
        target_name: targetName,
        temp_prefix: `.${targetName}.`,
      });
    } catch (error) {
      throw fakeError(
        "BUSINESS_RECORDED_FAKE_RECOVERY_FAILED",
        "Recorded fake interrupted-write recovery failed",
        { target_name: targetName, cause_code: adapterCode(error) },
      );
    }
    validateRecoveryProof(proof, normalizedRootPath);
  }

  async function readOptional(storeHandle, targetName) {
    await recoverTarget(storeHandle, targetName);
    let bytes;
    try {
      bytes = await adapter.readFileNoFollow({
        store_handle: storeHandle,
        name: targetName,
        max_bytes: MAX_RECORD_BYTES + 1,
      });
    } catch (error) {
      if (isMissing(error)) return null;
      if (isUnsafe(error)) {
        throw fakeError(
          "BUSINESS_RECORDED_FAKE_PATH_UNSAFE",
          "Recorded fake record path is not a no-follow regular-file boundary",
          { target_name: targetName, cause_code: adapterCode(error) },
        );
      }
      throw fakeError(
        "BUSINESS_RECORDED_FAKE_SECURITY_UNVERIFIED",
        "Recorded fake record could not be read through the no-follow boundary",
        { target_name: targetName, cause_code: adapterCode(error) },
      );
    }
    return parseStoredRecord(bytes, targetName);
  }

  async function removeTemp(storeHandle, tempName) {
    try {
      await adapter.unlinkTempNoFollow({ store_handle: storeHandle, name: tempName });
    } catch (error) {
      if (!isMissing(error)) {
        throw fakeError(
          "BUSINESS_RECORDED_FAKE_RECOVERY_FAILED",
          "Recorded fake temporary file could not be removed safely",
          { cause_code: adapterCode(error) },
        );
      }
    }
  }

  async function putImmutable(storeHandle, targetName, record) {
    const expectedBytes = recordBytes(record);
    const existing = await readOptional(storeHandle, targetName);
    if (existing !== null) {
      if (!recordsEqual(existing, record)) {
        throw fakeError(
          "BUSINESS_RECORDED_FAKE_MUTATION_CONFLICT",
          "Immutable recorded fake target already binds conflicting content",
          { target_name: targetName },
        );
      }
      return existing;
    }

    const tempName = `.${targetName}.${crypto.randomBytes(24).toString("hex")}.tmp`;
    let fileHandle = null;
    let tempExists = false;
    let renamed = false;
    try {
      try {
        fileHandle = await adapter.openTempExclusive({
          store_handle: storeHandle,
          name: tempName,
          mode: 0o600,
        });
        tempExists = true;
        await adapter.writeAll({ file_handle: fileHandle, bytes: expectedBytes });
        await adapter.fsyncFile({ file_handle: fileHandle });
      } catch (error) {
        throw fakeError(
          "BUSINESS_RECORDED_FAKE_WRITE_FAILED",
          "Recorded fake temporary write or file fsync failed",
          { target_name: targetName, cause_code: adapterCode(error) },
        );
      } finally {
        if (fileHandle !== null) {
          try {
            await adapter.closeFile({ file_handle: fileHandle });
            fileHandle = null;
          } catch (error) {
            throw fakeError(
              "BUSINESS_RECORDED_FAKE_WRITE_FAILED",
              "Recorded fake temporary file could not be closed",
              { target_name: targetName, cause_code: adapterCode(error) },
            );
          }
        }
      }

      try {
        await adapter.renameTempNoReplace({
          store_handle: storeHandle,
          from_name: tempName,
          to_name: targetName,
        });
        renamed = true;
        tempExists = false;
      } catch (error) {
        if (!isExists(error)) {
          throw fakeError(
            isUnsafe(error)
              ? "BUSINESS_RECORDED_FAKE_PATH_UNSAFE"
              : "BUSINESS_RECORDED_FAKE_WRITE_FAILED",
            "Recorded fake atomic no-replace publication failed",
            { target_name: targetName, cause_code: adapterCode(error) },
          );
        }
      }

      if (!renamed) {
        await removeTemp(storeHandle, tempName);
        tempExists = false;
        const winner = await readOptional(storeHandle, targetName);
        if (winner === null || !recordsEqual(winner, record)) {
          throw fakeError(
            "BUSINESS_RECORDED_FAKE_MUTATION_CONFLICT",
            "Concurrent recorded fake writer left conflicting immutable content",
            { target_name: targetName },
          );
        }
      }

      try {
        await adapter.fsyncDirectory({ store_handle: storeHandle });
      } catch (error) {
        throw fakeError(
          "BUSINESS_RECORDED_FAKE_DURABILITY_UNCERTAIN",
          "Recorded fake target exists but directory durability is unconfirmed",
          { target_name: targetName, cause_code: adapterCode(error) },
        );
      }
      const verified = await readOptional(storeHandle, targetName);
      if (verified === null || !recordsEqual(verified, record)) {
        throw fakeError(
          "BUSINESS_RECORDED_FAKE_RECORD_CORRUPT",
          "Recorded fake immutable target failed read-after-write verification",
          { target_name: targetName },
        );
      }
      return verified;
    } catch (error) {
      if (fileHandle !== null) {
        try {
          await adapter.closeFile({ file_handle: fileHandle });
        } catch {
          // The trusted recovery adapter owns leaked-handle recovery.
        }
      }
      if (tempExists) {
        try {
          await removeTemp(storeHandle, tempName);
        } catch (cleanupError) {
          throw fakeError(
            "BUSINESS_RECORDED_FAKE_RECOVERY_FAILED",
            "Recorded fake write failed and requires coordinated recovery",
            {
              cause_code: error?.code || adapterCode(error),
              cleanup_code: cleanupError?.code || adapterCode(cleanupError),
            },
          );
        }
      }
      throw error;
    }
  }

  function validateBinding(record, keyHash) {
    exactObject(
      record,
      BINDING_FIELDS,
      "stored binding",
      "BUSINESS_RECORDED_FAKE_RECORD_CORRUPT",
    );
    const invocation = normalizeInvocation(record.invocation);
    const authorizedToken = normalizeFencingToken(
      record.authorized_fencing_token,
      "stored binding.authorized_fencing_token",
    );
    const sendBeginLeaseExpiresAt = timestamp(
      record.send_begin_lease_expires_at,
      "stored binding.send_begin_lease_expires_at",
    );
    const entryCore = normalizeStoredProviderEntryCore(record, "stored binding");
    if (record.record_version !== RECORDED_FAKE_RECORD_VERSION
        || record.record_kind !== "binding"
        || record.key_hash !== keyHash
        || record.mutation_idempotency_key !== invocation.mutation_idempotency_key
        || record.invocation_hash !== canonicalHash(invocation)
        || !/^[a-f0-9]{64}$/u.test(record.authorization_hash || "")
        || !refsEqual(
          contentRef(record.authorization_ref, "stored binding.authorization_ref"),
          invocation.send_authorization_receipt_ref,
        )
        || !same(authorizedToken, invocation.worker_fencing_token)
        || !same(entryCore.provider_entry_window_fencing_token, authorizedToken)
        || sendBeginLeaseExpiresAt !== record.send_begin_lease_expires_at
        || !/^[a-f0-9]{64}$/u.test(record.recorded_outcome_hash || "")) {
      throw fakeError(
        "BUSINESS_RECORDED_FAKE_RECORD_CORRUPT",
        "Stored mutation binding is internally inconsistent",
        { key_hash: keyHash },
      );
    }
    return { record, invocation, entryCore, ref: markerRef(record) };
  }

  function validateCall(record, keyHash, binding) {
    exactObject(
      record,
      CALL_FIELDS,
      "stored call marker",
      "BUSINESS_RECORDED_FAKE_RECORD_CORRUPT",
    );
    const entryCore = normalizeStoredProviderEntryCore(record, "stored call marker");
    if (!binding
        || record.record_version !== RECORDED_FAKE_RECORD_VERSION
        || record.record_kind !== "call_entered"
        || record.key_hash !== keyHash
        || record.mutation_idempotency_key !== binding.invocation.mutation_idempotency_key
        || record.effect_id !== binding.invocation.effect.effect_id
        || !refsEqual(contentRef(record.binding_ref, "stored call marker.binding_ref"), binding.ref)
        || record.authorization_hash !== binding.record.authorization_hash
        || !same(entryCore, binding.entryCore)
        || timestamp(record.entry_checked_at, "stored call marker.entry_checked_at")
          !== record.entry_checked_at
        || Date.parse(record.entry_checked_at)
          >= Date.parse(binding.entryCore.provider_entry_window_lease_expires_at)) {
      throw fakeError(
        "BUSINESS_RECORDED_FAKE_RECORD_CORRUPT",
        "Stored call-entered marker does not bind the immutable invocation",
        { key_hash: keyHash },
      );
    }
    return { record, entryCore, ref: markerRef(record) };
  }

  function validateOutcomeMarker(record, keyHash, binding, call) {
    exactObject(
      record,
      OUTCOME_MARKER_FIELDS,
      "stored provider outcome marker",
      "BUSINESS_RECORDED_FAKE_RECORD_CORRUPT",
    );
    const entryCore = normalizeStoredProviderEntryCore(record, "stored provider outcome marker");
    if (record.record_version !== RECORDED_FAKE_RECORD_VERSION
        || !["provider_accepted", "not_mutated"].includes(record.record_kind)
        || !["recorded_provider", "recovery_probe_seal"].includes(record.origin)
        || record.key_hash !== keyHash
        || record.classification !== (record.record_kind === "provider_accepted" ? "accepted" : "not_sent")
        || record.mutation_idempotency_key === undefined
        || mutationKeyHash(record.mutation_idempotency_key) !== keyHash
        || timestamp(record.recorded_at, "stored provider outcome marker.recorded_at")
          !== record.recorded_at) {
      throw fakeError(
        "BUSINESS_RECORDED_FAKE_RECORD_CORRUPT",
        "Stored provider outcome marker is internally inconsistent",
        { key_hash: keyHash },
      );
    }
    if (record.origin === "recorded_provider") {
      const outcome = normalizeOutcome(record.recorded_outcome, "stored recorded outcome");
      if (!binding || !call
          || record.effect_id !== binding.invocation.effect.effect_id
          || !refsEqual(contentRef(record.binding_ref, "stored outcome.binding_ref"), binding.ref)
          || !refsEqual(
            contentRef(record.call_entered_ref, "stored outcome.call_entered_ref"),
            call.ref,
          )
          || record.authorization_hash !== binding.record.authorization_hash
          || !same(entryCore, binding.entryCore)
          || !same(entryCore, call.entryCore)
          || record.recovery_authorization_hash !== null
          || timestamp(
            record.mutation_entry_checked_at,
            "stored provider outcome.mutation_entry_checked_at",
          ) !== record.mutation_entry_checked_at
          || Date.parse(record.mutation_entry_checked_at)
            < Date.parse(call.record.entry_checked_at)
          || Date.parse(record.mutation_entry_checked_at)
            >= Date.parse(binding.entryCore.provider_entry_window_lease_expires_at)
          || canonicalHash(outcome) !== binding.record.recorded_outcome_hash
          || record.classification !== outcome.classification
          || record.reason !== outcome.reason
          || !recordsEqual(record.runtime_identity, outcome.runtime_identity)
          || !recordsEqual(record.provider_result_ref, outcome.provider_result_ref)
          || !recordsEqual(record.evidence_refs, outcome.evidence_refs)) {
        throw fakeError(
          "BUSINESS_RECORDED_FAKE_RECORD_CORRUPT",
          "Stored provider outcome does not bind the recorded invocation",
          { key_hash: keyHash },
        );
      }
    } else if (record.record_kind !== "not_mutated"
        || record.recorded_outcome !== null
        || record.reason !== "recovery_probe_authoritative_absence"
        || record.runtime_identity !== null
        || record.provider_result_ref !== null
        || !Array.isArray(record.evidence_refs)
        || record.evidence_refs.length !== 0
        || !/^[a-f0-9]{64}$/u.test(record.authorization_hash || "")
        || !/^[a-f0-9]{64}$/u.test(record.recovery_authorization_hash || "")
        || record.mutation_entry_checked_at !== null
        || (binding !== null && record.authorization_hash !== binding.record.authorization_hash)
        || (binding !== null && !same(entryCore, binding.entryCore))
        || (call !== null && !same(entryCore, call.entryCore))
        || (binding === null ? record.binding_ref !== null : !refsEqual(record.binding_ref, binding.ref))
        || (call === null ? record.call_entered_ref !== null : !refsEqual(record.call_entered_ref, call.ref))) {
      throw fakeError(
        "BUSINESS_RECORDED_FAKE_RECORD_CORRUPT",
        "Stored recovery-probe absence seal is inconsistent",
        { key_hash: keyHash },
      );
    }
    return { record, entryCore, ref: markerRef(record) };
  }

  function validateAck(record, keyHash, binding, outcome) {
    exactObject(
      record,
      ACK_FIELDS,
      "stored ack marker",
      "BUSINESS_RECORDED_FAKE_RECORD_CORRUPT",
    );
    const workerResultRef = contentRef(record.worker_result_ref, "stored ack.worker_result_ref");
    const entryCore = normalizeStoredProviderEntryCore(record, "stored ack");
    if (!binding || !outcome || outcome.record.origin !== "recorded_provider"
        || record.record_version !== RECORDED_FAKE_RECORD_VERSION
        || record.record_kind !== "ack_returned"
        || record.key_hash !== keyHash
        || record.mutation_idempotency_key !== binding.invocation.mutation_idempotency_key
        || record.effect_id !== binding.invocation.effect.effect_id
        || !refsEqual(contentRef(record.binding_ref, "stored ack.binding_ref"), binding.ref)
        || !refsEqual(
          contentRef(record.provider_outcome_ref, "stored ack.provider_outcome_ref"),
          outcome.ref,
        )
        || record.authorization_hash !== binding.record.authorization_hash
        || !same(entryCore, binding.entryCore)
        || !same(entryCore, outcome.entryCore)
        || !refsEqual(workerResultRef, record.worker_result_ref)
        || !["accepted", "not_sent"].includes(record.classification)
        || record.classification !== outcome.record.classification
        || timestamp(record.acknowledged_at, "stored ack.acknowledged_at")
          !== outcome.record.recorded_at) {
      throw fakeError(
        "BUSINESS_RECORDED_FAKE_RECORD_CORRUPT",
        "Stored acknowledgement does not bind the provider outcome",
        { key_hash: keyHash },
      );
    }
    return { record, entryCore, ref: markerRef(record) };
  }

  async function readState(storeHandle, mutationKey) {
    const keyHash = mutationKeyHash(mutationKey);
    const names = fileNames(keyHash);
    const rawBinding = await readOptional(storeHandle, names.binding);
    const binding = rawBinding === null ? null : validateBinding(rawBinding, keyHash);
    const rawCall = await readOptional(storeHandle, names.call_entered);
    const call = rawCall === null ? null : validateCall(rawCall, keyHash, binding);
    const rawAccepted = await readOptional(storeHandle, names.provider_accepted);
    const rawNotMutated = await readOptional(storeHandle, names.not_mutated);
    if (rawAccepted !== null && rawNotMutated !== null) {
      throw fakeError(
        "BUSINESS_RECORDED_FAKE_RECORD_CORRUPT",
        "Mutation index contains contradictory terminal provider outcomes",
        { key_hash: keyHash },
      );
    }
    const rawOutcome = rawAccepted || rawNotMutated;
    const outcome = rawOutcome === null
      ? null
      : validateOutcomeMarker(rawOutcome, keyHash, binding, call);
    const rawAck = await readOptional(storeHandle, names.ack_returned);
    const ack = rawAck === null ? null : validateAck(rawAck, keyHash, binding, outcome);
    let workerResult = null;
    if (binding !== null && call !== null && outcome?.record.origin === "recorded_provider") {
      const expectedWorkerResult = workerResultEvidence(
        binding.invocation,
        binding,
        call,
        outcome,
        binding.record.authorization_hash,
        outcome.record.recorded_at,
      );
      const expectedWorkerResultRef = evidenceRef(expectedWorkerResult);
      const rawWorkerResult = await readOptional(
        storeHandle,
        evidenceFileName(expectedWorkerResultRef.hash),
      );
      if (rawWorkerResult !== null
          && (!refsEqual(evidenceRef(rawWorkerResult), expectedWorkerResultRef)
            || !recordsEqual(rawWorkerResult, expectedWorkerResult))) {
        throw fakeError(
          "BUSINESS_RECORDED_FAKE_RECORD_CORRUPT",
          "Stored worker-result evidence does not close over its exact provider outcome",
          { key_hash: keyHash },
        );
      }
      if (ack !== null
          && (rawWorkerResult === null
            || !refsEqual(ack.record.worker_result_ref, expectedWorkerResultRef))) {
        throw fakeError(
          "BUSINESS_RECORDED_FAKE_RECORD_CORRUPT",
          "Stored acknowledgement does not close over its exact worker-result evidence",
          { key_hash: keyHash },
        );
      }
      if (rawWorkerResult !== null) {
        workerResult = { record: rawWorkerResult, ref: expectedWorkerResultRef };
      }
    } else if (ack !== null) {
      throw fakeError(
        "BUSINESS_RECORDED_FAKE_RECORD_CORRUPT",
        "Stored acknowledgement has no recorded provider outcome authority",
        { key_hash: keyHash },
      );
    }
    return { keyHash, names, binding, call, outcome, ack, workerResult };
  }

  function stateProviderEntryCore(state) {
    return state.binding?.entryCore || state.outcome?.entryCore || null;
  }

  function stateMinimumProviderEntryWindowRef(state) {
    return stateProviderEntryCore(state)?.provider_entry_window_ref || null;
  }

  function stateMarkerSnapshot(state) {
    return deepFreeze({
      binding_ref: state.binding?.ref || null,
      call_entered_ref: state.call?.ref || null,
      provider_outcome_ref: state.outcome?.ref || null,
      ack_returned_ref: state.ack?.ref || null,
      worker_result_ref: state.workerResult?.ref || null,
    });
  }

  function stateMatchesSnapshot(state, snapshot) {
    return same(stateMarkerSnapshot(state), snapshot);
  }

  function providerEntryAuthorizationCoversCore(authorization, entryCore) {
    if (entryCore === null) return false;
    const entryWindow = authorization.entry_window;
    return same(entryCore, {
      provider_entry_window_ref: entryWindow.window_ref,
      provider_entry_window_sequence: entryWindow.window_sequence,
      provider_entry_window_lease_expires_at: entryWindow.lease_expires_at,
      provider_entry_window_fencing_token: entryWindow.authorized_fencing_token,
    });
  }

  function bindingRecord(invocation, outcome, authorization) {
    const stableAuthorization = committedAuthorization(authorization);
    const entryCore = providerEntryCore(authorization);
    return deepFreeze({
      record_version: RECORDED_FAKE_RECORD_VERSION,
      record_kind: "binding",
      key_hash: mutationKeyHash(invocation.mutation_idempotency_key),
      mutation_idempotency_key: invocation.mutation_idempotency_key,
      invocation,
      invocation_hash: canonicalHash(invocation),
      authorization_hash: sendAuthorizationHash(authorization),
      authorization_ref: stableAuthorization.send_authorization_receipt_ref,
      authorized_fencing_token: stableAuthorization.authorized_fencing_token,
      send_begin_lease_expires_at: stableAuthorization.send_begin_lease_expires_at,
      ...entryCore,
      recorded_outcome_hash: canonicalHash(outcome),
    });
  }

  function bindingMatchesCurrentAuthorization(record, invocation, outcome, authorization) {
    const entryWindow = authorization.entry_window;
    const storedCore = normalizeStoredProviderEntryCore(record, "stored binding");
    const stableAuthorization = authorization.committed_send_authorization;
    return sendAuthorizationHash(authorization) === record.authorization_hash
      && same(storedCore, {
        provider_entry_window_ref: entryWindow.window_ref,
        provider_entry_window_sequence: entryWindow.window_sequence,
        provider_entry_window_lease_expires_at: entryWindow.lease_expires_at,
        provider_entry_window_fencing_token: entryWindow.authorized_fencing_token,
      })
      && record.record_version === RECORDED_FAKE_RECORD_VERSION
      && record.record_kind === "binding"
      && record.key_hash === mutationKeyHash(invocation.mutation_idempotency_key)
      && record.mutation_idempotency_key === invocation.mutation_idempotency_key
      && recordsEqual(record.invocation, invocation)
      && record.invocation_hash === canonicalHash(invocation)
      && recordsEqual(record.authorization_ref, stableAuthorization.send_authorization_receipt_ref)
      && recordsEqual(record.authorized_fencing_token, stableAuthorization.authorized_fencing_token)
      && record.send_begin_lease_expires_at === stableAuthorization.send_begin_lease_expires_at
      && record.recorded_outcome_hash === canonicalHash(outcome);
  }

  function callRecord(invocation, binding, authorization, entryCheckedAt) {
    return deepFreeze({
      record_version: RECORDED_FAKE_RECORD_VERSION,
      record_kind: "call_entered",
      key_hash: mutationKeyHash(invocation.mutation_idempotency_key),
      mutation_idempotency_key: invocation.mutation_idempotency_key,
      effect_id: invocation.effect.effect_id,
      binding_ref: binding.ref,
      authorization_hash: sendAuthorizationHash(authorization),
      ...binding.entryCore,
      entry_checked_at: entryCheckedAt,
    });
  }

  function providerOutcomeRecord(
    invocation,
    binding,
    call,
    outcome,
    authorization,
    mutationEntryCheckedAt,
  ) {
    return deepFreeze({
      record_version: RECORDED_FAKE_RECORD_VERSION,
      record_kind: outcome.classification === "accepted" ? "provider_accepted" : "not_mutated",
      origin: "recorded_provider",
      key_hash: mutationKeyHash(invocation.mutation_idempotency_key),
      mutation_idempotency_key: invocation.mutation_idempotency_key,
      effect_id: invocation.effect.effect_id,
      binding_ref: binding.ref,
      call_entered_ref: call.ref,
      authorization_hash: sendAuthorizationHash(authorization),
      recovery_authorization_hash: null,
      ...binding.entryCore,
      mutation_entry_checked_at: mutationEntryCheckedAt,
      recorded_outcome: outcome,
      classification: outcome.classification,
      reason: outcome.reason,
      runtime_identity: outcome.runtime_identity,
      provider_result_ref: outcome.provider_result_ref,
      evidence_refs: outcome.evidence_refs,
      recorded_at: mutationEntryCheckedAt,
    });
  }

  function absenceSealRecord(probe, state, authorization) {
    const providerAuthorization = authorization.provider_entry_authorization;
    const entryCore = state.binding?.entryCore || providerEntryCore(providerAuthorization);
    return deepFreeze({
      record_version: RECORDED_FAKE_RECORD_VERSION,
      record_kind: "not_mutated",
      origin: "recovery_probe_seal",
      key_hash: state.keyHash,
      mutation_idempotency_key: probe.mutation_idempotency_key,
      effect_id: probe.expected_effect_id,
      binding_ref: state.binding?.ref || null,
      call_entered_ref: state.call?.ref || null,
      authorization_hash: state.binding?.record.authorization_hash
        || sendAuthorizationHash(providerAuthorization),
      recovery_authorization_hash:
        authorization.recovery_eligibility.recovery_authorization_ref.hash,
      ...entryCore,
      mutation_entry_checked_at: null,
      recorded_outcome: null,
      classification: "not_sent",
      reason: "recovery_probe_authoritative_absence",
      runtime_identity: null,
      provider_result_ref: null,
      evidence_refs: [],
      recorded_at: probe.inspected_at,
    });
  }

  function workerResultEvidence(
    invocation,
    binding,
    call,
    outcome,
    authorizationHash,
    recordedAt,
  ) {
    const effect = invocation.effect;
    return deepFreeze({
      evidence_version: RECORDED_FAKE_EVIDENCE_VERSION,
      evidence_kind: "worker_result",
      effect_id: effect.effect_id,
      effect_contract_version: effect.effect_contract_version,
      effect_kind: effect.effect_kind,
      work_order_id: effect.work_order_id,
      branch_ref: effect.branch_ref,
      attempt: effect.attempt,
      dispatch_id: effect.dispatch_id,
      provider_ref: effect.provider_ref,
      mutation_idempotency_key: invocation.mutation_idempotency_key,
      classification: outcome.record.classification,
      reason: outcome.record.reason,
      runtime_identity: outcome.record.runtime_identity,
      provider_result_ref: outcome.record.provider_result_ref,
      evidence_refs: outcome.record.evidence_refs,
      worker_fencing_token: invocation.worker_fencing_token,
      send_authorization_receipt_ref: invocation.send_authorization_receipt_ref,
      provider_request_ref: invocation.provider_request_ref,
      binding_ref: binding.ref,
      call_entered_ref: call.ref,
      provider_outcome_ref: outcome.ref,
      authorization_hash: authorizationHash,
      ...binding.entryCore,
      entry_checked_at: call.record.entry_checked_at,
      mutation_entry_checked_at: outcome.record.mutation_entry_checked_at,
      recorded_at: recordedAt,
      retry_authorization: "not_evaluated",
    });
  }

  function ackRecord(invocation, binding, outcome, workerResultRef) {
    return deepFreeze({
      record_version: RECORDED_FAKE_RECORD_VERSION,
      record_kind: "ack_returned",
      key_hash: mutationKeyHash(invocation.mutation_idempotency_key),
      mutation_idempotency_key: invocation.mutation_idempotency_key,
      effect_id: invocation.effect.effect_id,
      binding_ref: binding.ref,
      provider_outcome_ref: outcome.ref,
      worker_result_ref: workerResultRef,
      authorization_hash: binding.record.authorization_hash,
      ...binding.entryCore,
      classification: outcome.record.classification,
      acknowledged_at: outcome.record.recorded_at,
    });
  }

  function probeEvidence(probe, state, outcome, authorization) {
    const accepted = outcome.record.record_kind === "provider_accepted";
    return deepFreeze({
      evidence_version: RECORDED_FAKE_EVIDENCE_VERSION,
      evidence_kind: "recovery_probe",
      effect_id: probe.expected_effect_id,
      mutation_idempotency_key: probe.mutation_idempotency_key,
      classification: accepted ? "accepted" : "not_sent",
      probe_classification: accepted ? "found" : "authoritative_absence",
      reason: accepted ? "recovery_probe_found" : "recovery_probe_authoritative_absence",
      runtime_identity: outcome.record.runtime_identity,
      provider_result_ref: outcome.record.provider_result_ref,
      binding_ref: state.binding?.ref || null,
      call_entered_ref: state.call?.ref || null,
      provider_outcome_ref: outcome.ref,
      worker_result_ref: state.workerResult?.ref || null,
      authorization_hash: outcome.record.authorization_hash,
      recovery_authorization_hash:
        authorization.recovery_eligibility.recovery_authorization_ref.hash,
      ...outcome.entryCore,
      inspected_at: probe.inspected_at,
      retry_authorization: "not_evaluated",
    });
  }

  async function persistEvidence(storeHandle, evidence) {
    exactObject(
      evidence,
      evidence.evidence_kind === "worker_result"
        ? WORKER_RESULT_FIELDS
        : PROBE_EVIDENCE_FIELDS,
      "evidence",
    );
    if (evidence.evidence_version !== RECORDED_FAKE_EVIDENCE_VERSION) {
      throw fakeError(
        "BUSINESS_RECORDED_FAKE_INPUT_INVALID",
        "Recorded fake evidence version is unsupported",
      );
    }
    const ref = evidenceRef(evidence);
    await putImmutable(storeHandle, evidenceFileName(ref.hash), evidence);
    return ref;
  }

  function executionResult(invocation, outcome, workerResultRef) {
    return deepFreeze({
      driver_contract_version: RECORDED_FAKE_PROVIDER_VERSION,
      effect_id: invocation.effect.effect_id,
      mutation_idempotency_key: invocation.mutation_idempotency_key,
      classification: outcome.record.classification,
      reason: outcome.record.reason,
      runtime_identity: outcome.record.runtime_identity,
      provider_result_ref: outcome.record.provider_result_ref,
      worker_result_ref: workerResultRef,
      callback_fencing_token: invocation.worker_fencing_token,
      retry_authorization: "not_evaluated",
    });
  }

  async function executeMutation(input, { crash_at: inputCrashPoint } = {}) {
    const invocation = normalizeInvocation(input);
    const crashPoint = normalizeCrashPoint(
      inputCrashPoint,
      RECORDED_FAKE_CRASH_POINTS,
      "options.crash_at",
    );
    const outcome = recordedOutcomes[invocation.mutation_idempotency_key];
    if (!outcome) {
      throw fakeError(
        "BUSINESS_RECORDED_FAKE_CONFIGURATION_INVALID",
        "No immutable recorded provider outcome exists for this mutation key",
        { key_hash: mutationKeyHash(invocation.mutation_idempotency_key) },
      );
    }

    for (let raceAttempt = 0; raceAttempt <= MAX_STATE_RACE_RETRIES; raceAttempt += 1) {
      const shortState = await withStore((storeHandle) => (
        readState(storeHandle, invocation.mutation_idempotency_key)
      ));
      const shortSnapshot = stateMarkerSnapshot(shortState);
      const minimumProviderEntryWindowRef = stateMinimumProviderEntryWindowRef(shortState);
      let authorization = minimumProviderEntryWindowRef === null
        ? await resolveSendAuthorization(invocation, null)
        : await resolveRetainedProviderEntryAuthorization(
          invocation,
          minimumProviderEntryWindowRef,
        );

      const attemptResult = await withStore(async (storeHandle) => {
        let state = await readState(storeHandle, invocation.mutation_idempotency_key);
        if (!stateMatchesSnapshot(state, shortSnapshot)) return { state_raced: true };

        if (state.binding !== null) {
          if (!bindingMatchesCurrentAuthorization(
            state.binding.record,
            invocation,
            outcome,
            authorization,
          )) {
            throw fakeError(
              "BUSINESS_RECORDED_FAKE_MUTATION_CONFLICT",
              "Mutation key is already bound to another invocation, authority, or recorded outcome",
              { key_hash: state.keyHash },
            );
          }
          if (state.outcome === null) {
            throw fakeError(
              "BUSINESS_RECORDED_FAKE_RECOVERY_REQUIRED",
              "An interrupted sending invocation must be inspected by exact key; it is never re-mutated on restart",
              { key_hash: state.keyHash, durable_stage: state.call ? "call_entered" : "binding" },
            );
          }
          if (state.outcome.record.origin === "recovery_probe_seal") {
            throw fakeError(
              "BUSINESS_RECORDED_FAKE_MUTATION_SEALED",
              "Recovery inspection durably sealed this mutation key as not mutated",
              { key_hash: state.keyHash },
            );
          }
          if (canonicalHash(outcome) !== state.binding.record.recorded_outcome_hash
              || !recordsEqual(state.outcome.record.recorded_outcome, outcome)) {
            throw fakeError(
              "BUSINESS_RECORDED_FAKE_MUTATION_CONFLICT",
              "Recorded provider outcome changed for an immutable mutation key",
              { key_hash: state.keyHash },
            );
          }
        } else if (state.outcome !== null) {
          const authorityMatches = state.outcome.record.origin === "recovery_probe_seal"
            && sendAuthorizationHash(authorization) === state.outcome.record.authorization_hash
            && providerEntryAuthorizationCoversCore(authorization, state.outcome.entryCore);
          if (!authorityMatches) {
            throw fakeError(
              "BUSINESS_RECORDED_FAKE_RECORD_CORRUPT",
              "Terminal mutation state without a binding is not covered by retained authority",
              { key_hash: state.keyHash },
            );
          }
          throw fakeError(
            "BUSINESS_RECORDED_FAKE_MUTATION_SEALED",
            "Recovery inspection durably sealed this mutation key as not mutated",
            { key_hash: state.keyHash },
          );
        } else {
          // The first live resolution is outside the exclusive store. The
          // short-read snapshot is rechecked under the lock, then a second
          // resolver call must start at that first tip and prove every later
          // continuation before any provider-call marker can exist.
          const resolutionStartedAt = trustedClockValue(clock);
          const firstTip = currentProviderEntryWindow(authorization);
          assertClockDidNotMoveBackward(
            firstTip.source_event.payload.occurred_at,
            resolutionStartedAt,
            "before_authorization_recheck",
          );
          assertEntryWindow(
            authorization,
            resolutionStartedAt,
            "before_authorization_recheck",
          );
          const firstStableHash = sendAuthorizationHash(authorization);
          authorization = await resolveSendAuthorizationBeforeExpiry(
            invocation,
            authorization,
            resolutionStartedAt,
          );
          if (sendAuthorizationHash(authorization) !== firstStableHash) {
            throw fakeError(
              "BUSINESS_RECORDED_FAKE_AUTHORIZATION_FAILED",
              "Second live provider-entry proof changed the stable committed send authority",
              { effect_id: invocation.effect.effect_id },
            );
          }
          const authorizationCheckedAt = trustedClockValue(clock);
          assertClockDidNotMoveBackward(
            resolutionStartedAt,
            authorizationCheckedAt,
            "before_binding",
          );
          assertEntryWindow(authorization, authorizationCheckedAt, "before_binding");
          const expectedBindingRecord = bindingRecord(invocation, outcome, authorization);
          maybeCrash(crashPoint, "before_binding");
          await putImmutable(storeHandle, state.names.binding, expectedBindingRecord);
          state = await readState(storeHandle, invocation.mutation_idempotency_key);
          maybeCrash(crashPoint, "after_binding");

          const entryCheckedAt = trustedClockValue(clock);
          assertClockDidNotMoveBackward(
            authorizationCheckedAt,
            entryCheckedAt,
            "before_call_entered",
          );
          assertEntryWindow(authorization, entryCheckedAt, "before_call_entered");
          const call = callRecord(invocation, state.binding, authorization, entryCheckedAt);
          await putImmutable(storeHandle, state.names.call_entered, call);
          state = await readState(storeHandle, invocation.mutation_idempotency_key);
          maybeCrash(crashPoint, "after_call_entered");

          const mutationEntryCheckedAt = trustedClockValue(clock);
          assertClockDidNotMoveBackward(
            entryCheckedAt,
            mutationEntryCheckedAt,
            "after_call_entered",
          );
          assertEntryWindow(authorization, mutationEntryCheckedAt, "after_call_entered");

          const providerOutcome = providerOutcomeRecord(
            invocation,
            state.binding,
            state.call,
            outcome,
            authorization,
            mutationEntryCheckedAt,
          );
          const outcomeTarget = outcome.classification === "accepted"
            ? state.names.provider_accepted
            : state.names.not_mutated;
          await putImmutable(storeHandle, outcomeTarget, providerOutcome);
          state = await readState(storeHandle, invocation.mutation_idempotency_key);
          maybeCrash(crashPoint, "after_provider_outcome");
        }

        const evidence = workerResultEvidence(
          invocation,
          state.binding,
          state.call,
          state.outcome,
          state.binding.record.authorization_hash,
          state.outcome.record.recorded_at,
        );
        const workerResultRef = await persistEvidence(storeHandle, evidence);
        maybeCrash(crashPoint, "after_worker_result_persisted");

        const ack = ackRecord(
          invocation,
          state.binding,
          state.outcome,
          workerResultRef,
        );
        await putImmutable(storeHandle, state.names.ack_returned, ack);
        maybeCrash(crashPoint, "after_ack_returned");
        return executionResult(invocation, state.outcome, workerResultRef);
      });
      if (!attemptResult.state_raced) return attemptResult;
    }
    throw fakeError(
      "BUSINESS_RECORDED_FAKE_MUTATION_CONFLICT",
      "Mutation state changed repeatedly while authority was resolved; no authority was reused",
      { key_hash: mutationKeyHash(invocation.mutation_idempotency_key) },
    );
  }

  async function readAuthorizedMutationResult(input) {
    const invocation = normalizeInvocation(input);
    const configuredOutcome = recordedOutcomes[invocation.mutation_idempotency_key];
    if (!configuredOutcome) {
      throw fakeError(
        "BUSINESS_RECORDED_FAKE_CONFIGURATION_INVALID",
        "No immutable recorded provider outcome exists for this mutation key",
        { key_hash: mutationKeyHash(invocation.mutation_idempotency_key) },
      );
    }
    for (let raceAttempt = 0; raceAttempt <= MAX_STATE_RACE_RETRIES; raceAttempt += 1) {
      const shortState = await withStore((storeHandle) => (
        readState(storeHandle, invocation.mutation_idempotency_key)
      ));
      const shortSnapshot = stateMarkerSnapshot(shortState);
      const minimumProviderEntryWindowRef = stateMinimumProviderEntryWindowRef(shortState);
      const authorization = await resolveRetainedProviderEntryAuthorization(
        invocation,
        minimumProviderEntryWindowRef,
      );
      const lookup = await withStore(async (storeHandle) => {
        const state = await readState(storeHandle, invocation.mutation_idempotency_key);
        if (!stateMatchesSnapshot(state, shortSnapshot)) return { state_raced: true };
        const common = {
          lookup_contract_version: RECORDED_FAKE_LOOKUP_CONTRACT_VERSION,
          effect_id: invocation.effect.effect_id,
          mutation_idempotency_key: invocation.mutation_idempotency_key,
        };
        if (state.binding === null) {
          if (state.outcome !== null
              && (state.outcome.record.origin !== "recovery_probe_seal"
                || sendAuthorizationHash(authorization)
                  !== state.outcome.record.authorization_hash
                || !providerEntryAuthorizationCoversCore(
                  authorization,
                  state.outcome.entryCore,
                ))) {
            throw fakeError(
              "BUSINESS_RECORDED_FAKE_RECORD_CORRUPT",
              "Authorized lookup found an uncovered terminal outcome without its invocation binding",
              { key_hash: state.keyHash },
            );
          }
          return deepFreeze({ ...common, status: "not_found" });
        }
        if (!bindingMatchesCurrentAuthorization(
          state.binding.record,
          invocation,
          configuredOutcome,
          authorization,
        )) {
          throw fakeError(
            "BUSINESS_RECORDED_FAKE_MUTATION_CONFLICT",
            "Authorized lookup does not bind the stored mutation invocation and entry window",
            { key_hash: state.keyHash },
          );
        }
        if (state.workerResult !== null) {
          return deepFreeze({
            ...common,
            status: "worker_result",
            result: executionResult(invocation, state.outcome, state.workerResult.ref),
            worker_result_ref: state.workerResult.ref,
          });
        }
        return deepFreeze({
          ...common,
          status: "recovery_required",
          durable_stage: state.outcome !== null
            ? "provider_outcome"
            : (state.call !== null ? "call_entered" : "binding"),
        });
      });
      if (!lookup.state_raced) return lookup;
    }
    throw fakeError(
      "BUSINESS_RECORDED_FAKE_MUTATION_CONFLICT",
      "Authorized lookup state changed repeatedly while retained authority was resolved",
      { key_hash: mutationKeyHash(invocation.mutation_idempotency_key) },
    );
  }

  async function inspectByExactKey(input, { crash_at: inputCrashPoint } = {}) {
    const probe = normalizeInspectInput(input);
    const crashPoint = normalizeCrashPoint(
      inputCrashPoint,
      RECORDED_FAKE_PROBE_CRASH_POINTS,
      "options.crash_at",
    );
    for (let raceAttempt = 0; raceAttempt <= MAX_STATE_RACE_RETRIES; raceAttempt += 1) {
      const shortState = await withStore((storeHandle) => (
        readState(storeHandle, probe.mutation_idempotency_key)
      ));
      const shortSnapshot = stateMarkerSnapshot(shortState);
      const minimumProviderEntryWindowRef = stateMinimumProviderEntryWindowRef(shortState);
      const authorization = await resolveRecoveryAuthorization(
        probe,
        minimumProviderEntryWindowRef,
      );
      const recoveryCheckedAt = trustedClockValue(clock, "recovery_inspection");
      if (Date.parse(probe.inspected_at) > Date.parse(recoveryCheckedAt)) {
        throw fakeError(
          "BUSINESS_RECORDED_FAKE_RECOVERY_NOT_AUTHORIZED",
          "Recovery inspection time is later than the trusted driver clock",
          {
            inspected_at: probe.inspected_at,
            recovery_checked_at: recoveryCheckedAt,
          },
        );
      }
      const providerAuthorization = authorization.provider_entry_authorization;
      const inspection = await withStore(async (storeHandle) => {
        let state = await readState(storeHandle, probe.mutation_idempotency_key);
        if (!stateMatchesSnapshot(state, shortSnapshot)) return { state_raced: true };
        if (state.binding
            && state.binding.invocation.effect.effect_id !== probe.expected_effect_id) {
          throw fakeError(
            "BUSINESS_RECORDED_FAKE_MUTATION_CONFLICT",
            "Probe effect identifier does not match the exact mutation-key binding",
            { key_hash: state.keyHash },
          );
        }
        if (state.binding
            && (sendAuthorizationHash(providerAuthorization)
                !== state.binding.record.authorization_hash
              || !providerEntryAuthorizationCoversCore(
                providerAuthorization,
                state.binding.entryCore,
              ))) {
          throw fakeError(
            "BUSINESS_RECORDED_FAKE_RECOVERY_NOT_AUTHORIZED",
            "Recovery proof does not cover the invocation's committed send and provider-entry window",
            { key_hash: state.keyHash },
          );
        }
        if (state.outcome?.record.origin === "recovery_probe_seal"
            && (state.outcome.record.authorization_hash !== (
              state.binding?.record.authorization_hash
                || sendAuthorizationHash(providerAuthorization)
            )
              || !providerEntryAuthorizationCoversCore(
                providerAuthorization,
                state.outcome.entryCore,
              ))) {
          throw fakeError(
            "BUSINESS_RECORDED_FAKE_RECOVERY_NOT_AUTHORIZED",
            "Existing authoritative absence is bound to another committed send or entry window",
            { key_hash: state.keyHash },
          );
        }
        if (state.outcome === null) {
          const seal = absenceSealRecord(probe, state, authorization);
          await putImmutable(storeHandle, state.names.not_mutated, seal);
          state = await readState(storeHandle, probe.mutation_idempotency_key);
          maybeCrash(crashPoint, "after_probe_seal");
        }
        if (state.outcome.record.effect_id !== probe.expected_effect_id) {
          throw fakeError(
            "BUSINESS_RECORDED_FAKE_MUTATION_CONFLICT",
            "Durable provider outcome does not match the probed effect",
            { key_hash: state.keyHash },
          );
        }
        const evidence = probeEvidence(probe, state, state.outcome, authorization);
        const probeReceiptRef = await persistEvidence(storeHandle, evidence);
        maybeCrash(crashPoint, "after_probe_evidence_persisted");
        return deepFreeze({
          probe_contract_version: RECORDED_FAKE_PROVIDER_VERSION,
          effect_id: probe.expected_effect_id,
          mutation_idempotency_key: probe.mutation_idempotency_key,
          classification: evidence.classification,
          probe_classification: evidence.probe_classification,
          reason: evidence.reason,
          runtime_identity: evidence.runtime_identity,
          provider_result_ref: evidence.provider_result_ref,
          probe_receipt_ref: probeReceiptRef,
          retry_authorization: "not_evaluated",
        });
      });
      if (!inspection.state_raced) return inspection;
    }
    throw fakeError(
      "BUSINESS_RECORDED_FAKE_MUTATION_CONFLICT",
      "Recovery state changed repeatedly while exact authorization was resolved",
      { key_hash: mutationKeyHash(probe.mutation_idempotency_key) },
    );
  }

  async function readEvidence(inputRef) {
    const ref = contentRef(canonicalClone(inputRef, "evidence_ref"), "evidence_ref");
    if (!/^(WRR|PRB)-[a-f0-9]{32}$/u.test(ref.id)) {
      throw fakeError(
        "BUSINESS_RECORDED_FAKE_INPUT_INVALID",
        "evidence_ref.id is not a recorded fake worker-result or probe reference",
      );
    }
    return withStore(async (storeHandle) => {
      const record = await readOptional(storeHandle, evidenceFileName(ref.hash));
      if (record === null) {
        throw fakeError(
          "BUSINESS_RECORDED_FAKE_EVIDENCE_NOT_FOUND",
          "Content-addressed recorded fake evidence is missing",
          { evidence_ref: ref.id },
        );
      }
      if (!isPlainObject(record)
          || record.evidence_version !== RECORDED_FAKE_EVIDENCE_VERSION
          || !["worker_result", "recovery_probe"].includes(record.evidence_kind)
          || !refsEqual(evidenceRef(record), ref)) {
        throw fakeError(
          "BUSINESS_RECORDED_FAKE_RECORD_CORRUPT",
          "Content-addressed recorded fake evidence failed hash or kind verification",
          { evidence_ref: ref.id },
        );
      }
      exactObject(
        record,
        record.evidence_kind === "worker_result"
          ? WORKER_RESULT_FIELDS
          : PROBE_EVIDENCE_FIELDS,
        "stored evidence",
        "BUSINESS_RECORDED_FAKE_RECORD_CORRUPT",
      );
      return deepFreeze(record);
    });
  }

  const capabilityProof = deepFreeze({
    authorization_contract_version: RECORDED_FAKE_AUTHORIZATION_CONTRACT_VERSION,
    provider_entry_authorization_version: PROVIDER_ENTRY_AUTHORIZATION_VERSION,
    driver_contract_version: RECORDED_FAKE_PROVIDER_VERSION,
    mutation_execution: "stable_committed_send_plus_current_provider_entry_window_required",
    provider_entry_window: "contiguous_resolver_chain_rechecked_before_provider_entry",
    recovery_inspection:
      "stable_committed_send_provider_entry_window_and_recovery_eligibility_required",
    authorized_result_lookup: "retained_provider_entry_authorization_read_only",
    process_local_test_adapter: "explicit_opt_in_only",
  });
  return deepFreeze({
    authorization_contract_version: RECORDED_FAKE_AUTHORIZATION_CONTRACT_VERSION,
    capabilities: () => capabilityProof,
    executeMutation,
    inspectByExactKey,
    readAuthorizedMutationResult,
    readEvidence,
  });
}

module.exports = {
  BusinessRecordedFakeProviderError,
  RECORDED_FAKE_CRASH_POINTS,
  RECORDED_FAKE_AUTHORIZATION_CONTRACT_VERSION,
  RECORDED_FAKE_EVIDENCE_VERSION,
  RECORDED_FAKE_LOOKUP_CONTRACT_VERSION,
  RECORDED_FAKE_PROBE_CRASH_POINTS,
  RECORDED_FAKE_PROVIDER_VERSION,
  RECORDED_FAKE_RECORD_VERSION,
  RecordedFakeCrashError,
  createRecordedFakeProviderDriver,
};
