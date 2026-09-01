"use strict";

const { canonicalHash, canonicalJson } = require("@orquesta/contracts");
const {
  CONTRACT_LIMITS,
  EFFECT_PRESEND_FAILURE_OBSERVATION_NAMES,
  EFFECT_SEND_EXPIRY_OBSERVATION_NAMES,
  EFFECT_SETTLEMENT_OBSERVATION_NAMES,
  normalizeBusinessRuntimeObservationEnvelope,
  normalizeBusinessWorkOrderPlanV1,
} = require("./contract");
const {
  V2_EFFECT_IDENTITY_FIELDS,
  V2_UNRESOLVED_EFFECT_STATUSES,
  assertLifecycleInvariants,
  deriveEffectOperationScopeHashV2,
  deriveLifecycleSnapshot,
} = require("./lifecycle");
const {
  V2_PRESEND_FAILURE_REASONS,
  deriveEffectGenerationRetryScheduleV2,
  normalizeSettlementPolicyRecordV2,
} = require("./settlement-policy");
const V2_PRESEND_FAILURE_REASON_SET = new Set(V2_PRESEND_FAILURE_REASONS);
const {
  normalizeDispatchPacketVerificationReceiptV1,
} = require("./packet-store");
const {
  BusinessSendAuthorizationError,
  SEND_AUTHORIZATION_CONTRACT_VERSION,
  createCommittedSendAuthorizationProofV2,
  normalizeSendAuthorizationBundleV1,
  normalizeSendAuthorizationOperationScopeBindingV2,
} = require("./send-authorization");
const {
  BusinessProviderEntryWindowError,
  advanceProviderEntryWindowIndexV1,
  createProviderEntryWindowAnchorV1,
  createProviderEntryWindowIndexV1,
  normalizeProviderEntryWindowIndexV1,
  normalizeProviderEntryWindowReceiptClosureV1,
  normalizeProviderEntryWindowV1,
} = require("./provider-entry-window");
const {
  PROVIDER_SETTLEMENT_ACTIVATED_EVENT,
  PROVIDER_SETTLEMENT_CUTOVER_RECEIVED_EVENT,
  deriveProviderSettlementEpochFromBatchV1,
} = require("./provider-settlement-cutover-boundary");

const BUSINESS_EVENT_SCHEMA_VERSION = 1;
const BUSINESS_PROJECTION_VERSION = 2;
const EFFECT_SETTLEMENT_OBSERVATION_NAME = EFFECT_SETTLEMENT_OBSERVATION_NAMES[0];
const EFFECT_SEND_EXPIRY_OBSERVATION_NAME = EFFECT_SEND_EXPIRY_OBSERVATION_NAMES[0];
const EFFECT_PRESEND_FAILURE_OBSERVATION_NAME = EFFECT_PRESEND_FAILURE_OBSERVATION_NAMES[0];
const MAX_EVENT_BYTES = CONTRACT_LIMITS.max_plan_bytes;
const MAX_PROJECTION_BYTES = 64 * 1_024 * 1_024;
const MAX_EVENT_EVIDENCE_REFS = CONTRACT_LIMITS.max_evidence_refs;

const BUSINESS_EVENT_TYPES = Object.freeze([
  "business.work_order.created",
  "business.work_order.status_changed",
  "business.context_budget.verified",
  "business.branch.initialized",
  "business.branch.attempt_opened",
  "business.branch.status_changed",
  "business.branch.runtime_observed",
  "business.verification.recorded",
  "business.review.recorded",
  "business.acceptance.recorded",
  "business.late_observation.quarantined",
  "business.recovery_probe.recorded",
  "business.outbox.enqueued",
  "business.outbox.claimed",
  "business.outbox.send_begun",
  "business.outbox.lease_renewed",
  "business.outbox.requeued",
  "business.outbox.send_expired",
  "business.outbox.delivered",
  "business.outbox.not_sent",
  "business.outbox.delivery_unknown",
  "business.outbox.cancelled",
  "business.command.received",
  "business.observation.received",
  "business.provider_settlement.received",
  "business.internal_action.received",
  "business.attention.opened",
  "business.attention.resolved",
  PROVIDER_SETTLEMENT_ACTIVATED_EVENT,
  PROVIDER_SETTLEMENT_CUTOVER_RECEIVED_EVENT,
]);

const EVENT_TYPE_SET = new Set(BUSINESS_EVENT_TYPES);
const INTERNAL_ONLY_EVENT_TYPES = new Set([
  "business.outbox.claimed",
  "business.outbox.send_begun",
  "business.outbox.lease_renewed",
  "business.outbox.requeued",
  "business.outbox.send_expired",
  "business.internal_action.received",
]);
const RECEIPT_TYPES = Object.freeze({
  "business.command.received": ["command", "command_receipts"],
  "business.observation.received": ["observation", "observation_receipts"],
  "business.provider_settlement.received": ["provider_settlement", "observation_receipts"],
  "business.internal_action.received": ["internal_action", "internal_receipts"],
});
const COMMAND_BATCH_EVENT_TYPES = new Set([
  "business.work_order.created",
  "business.work_order.status_changed",
  "business.context_budget.verified",
  "business.branch.initialized",
  "business.branch.attempt_opened",
  "business.branch.status_changed",
  "business.acceptance.recorded",
  "business.outbox.enqueued",
  "business.outbox.cancelled",
  "business.attention.opened",
  "business.attention.resolved",
]);
const OBSERVATION_BATCH_EVENT_TYPES = new Set([
  "business.work_order.status_changed",
  "business.branch.attempt_opened",
  "business.branch.status_changed",
  "business.branch.runtime_observed",
  "business.verification.recorded",
  "business.review.recorded",
  "business.late_observation.quarantined",
  "business.recovery_probe.recorded",
  "business.outbox.enqueued",
  "business.outbox.delivered",
  "business.outbox.not_sent",
  "business.outbox.delivery_unknown",
  "business.outbox.send_expired",
  "business.outbox.cancelled",
  "business.attention.opened",
  "business.attention.resolved",
]);
const PROVIDER_SETTLEMENT_BATCH_EVENT_TYPES = new Set([
  "business.work_order.status_changed",
  "business.branch.status_changed",
  "business.branch.runtime_observed",
  "business.late_observation.quarantined",
  "business.recovery_probe.recorded",
  "business.outbox.enqueued",
  "business.outbox.delivered",
  "business.outbox.not_sent",
  "business.outbox.delivery_unknown",
  "business.outbox.send_expired",
  "business.outbox.cancelled",
  "business.attention.opened",
  "business.attention.resolved",
]);
const BATCH_EVENT_TYPES = Object.freeze({
  command: COMMAND_BATCH_EVENT_TYPES,
  observation: OBSERVATION_BATCH_EVENT_TYPES,
  provider_settlement: PROVIDER_SETTLEMENT_BATCH_EVENT_TYPES,
  internal_action: INTERNAL_ONLY_EVENT_TYPES,
});
const GLOBAL_EVENT_TYPES = new Set([
  PROVIDER_SETTLEMENT_ACTIVATED_EVENT,
  PROVIDER_SETTLEMENT_CUTOVER_RECEIVED_EVENT,
]);
const PROVIDER_SETTLEMENT_RECEIPT_EVENT = "business.provider_settlement.received";
const PROVIDER_SETTLEMENT_SOURCE_TYPE = "provider_settlement";
const PROVIDER_SETTLEMENT_CURRENT_OBSERVATIONS = new Set([
  EFFECT_SETTLEMENT_OBSERVATION_NAME,
  EFFECT_SEND_EXPIRY_OBSERVATION_NAME,
  EFFECT_PRESEND_FAILURE_OBSERVATION_NAME,
]);
const PROVIDER_SETTLEMENT_LEGACY_OBSERVATIONS = new Set([
  "provider.effect.delivery.recorded",
  "branch.dispatch.accepted",
  "branch.dispatch.not_sent",
  "branch.delivery_unknown",
]);
const PROVIDER_SETTLEMENT_SENSITIVE_EVENTS = new Set([
  "business.recovery_probe.recorded",
  "business.outbox.delivered",
  "business.outbox.not_sent",
  "business.outbox.delivery_unknown",
  "business.outbox.send_expired",
]);

const WORK_ORDER_STATES = Object.freeze([
  "starting",
  "running",
  "paused",
  "awaiting_acceptance",
  "cancelling",
  "accepted",
  "failed",
  "cancelled",
]);
const TERMINAL_WORK_ORDER_STATES = Object.freeze(["accepted", "failed", "cancelled"]);
const TERMINAL_WORK_ORDER_STATE_SET = new Set(TERMINAL_WORK_ORDER_STATES);
const EXECUTION_WINDOW_OBSERVATIONS = new Set([
  "branch.progress",
  "branch.result.submitted",
  "user_input.requested",
]);
const TURN_BOUND_OBSERVATIONS = new Set([
  "branch.progress",
  "branch.result.submitted",
  "branch.failed",
  "user_input.requested",
]);
const WORK_ORDER_TRANSITIONS = Object.freeze({
  starting: new Set(["running", "paused", "cancelling", "failed", "cancelled"]),
  running: new Set(["paused", "awaiting_acceptance", "cancelling", "failed", "cancelled"]),
  paused: new Set(["running", "cancelling", "failed", "cancelled"]),
  awaiting_acceptance: new Set(["paused", "cancelling", "accepted", "failed", "cancelled"]),
  cancelling: new Set(["failed", "cancelled"]),
  accepted: new Set(),
  failed: new Set(),
  cancelled: new Set(),
});

const BRANCH_STATES = Object.freeze([
  "blocked",
  "ready",
  "dispatch_pending",
  "running",
  "waiting_for_user",
  "verifying",
  "accepted",
  "retryable",
  "delivery_unknown",
  "cancelling",
  "failed",
  "cancelled",
]);
const TERMINAL_BRANCH_STATE_SET = new Set(["accepted", "failed", "cancelled"]);
const UNRESOLVED_MUTATING_EFFECT_STATES = new Set(V2_UNRESOLVED_EFFECT_STATUSES);
const ACTIVE_CANCEL_EFFECT_STATES = new Set([
  ...UNRESOLVED_MUTATING_EFFECT_STATES,
  "delivered",
]);
const BRANCH_TRANSITIONS = Object.freeze({
  blocked: new Set(["ready", "cancelling", "failed", "cancelled"]),
  ready: new Set(["dispatch_pending", "cancelling", "failed", "cancelled"]),
  dispatch_pending: new Set(["running", "retryable", "delivery_unknown", "cancelling", "failed", "cancelled"]),
  running: new Set(["waiting_for_user", "verifying", "retryable", "delivery_unknown", "cancelling", "failed", "cancelled"]),
  waiting_for_user: new Set(["running", "cancelling", "failed", "cancelled"]),
  verifying: new Set(["accepted", "cancelling", "failed", "cancelled"]),
  accepted: new Set(),
  retryable: new Set(["dispatch_pending", "cancelling", "failed", "cancelled"]),
  delivery_unknown: new Set([
    "dispatch_pending",
    "running",
    "retryable",
    "cancelling",
    "failed",
    "cancelled",
  ]),
  cancelling: new Set(["failed", "cancelled"]),
  failed: new Set(["dispatch_pending", "cancelling", "cancelled"]),
  cancelled: new Set(),
});

const OUTBOX_IMMUTABLE_FIELDS = V2_EFFECT_IDENTITY_FIELDS;
const LEGACY_OUTBOX_IMMUTABLE_FIELDS = Object.freeze([
  "effect_id",
  "work_order_id",
  "branch_ref",
  "attempt",
  "dispatch_id",
  "effect_kind",
  "provider_ref",
  "packet_ref",
  "packet_hash",
  "idempotency_key",
  "created_at",
]);
const OUTBOX_TRANSITIONS = Object.freeze({
  pending: new Set(["claimed", "cancelled"]),
  claimed: new Set(["pending", "sending", "not_sent", "cancelled"]),
  sending: new Set(["delivered", "not_sent", "delivery_unknown"]),
  delivery_unknown: new Set(["delivered", "not_sent"]),
  delivered: new Set(),
  not_sent: new Set(),
  cancelled: new Set(),
});

const EVENT_FIELDS = new Set(["event_id", "schema_version", "type", "payload", "evidence_refs"]);
const RECEIPT_FIELDS = new Set([
  "source_id",
  "source_type",
  "identity_hash",
  "payload_hash",
  "work_order_id",
  "applied_revision",
  "batch_id",
  "event_ids",
  "result",
]);
const PROVIDER_SETTLEMENT_BUNDLE_FIELDS = new Set([
  "bundle_schema_version",
  "settlement_contract_version",
  "cutover_id",
  "observation_name",
  "effect_binding",
  "ingress_kind",
  "provenance_ref",
  "effective_classification",
  "settlement_policy_hash",
  "domain_event_manifest_hash",
]);
const PROVIDER_SETTLEMENT_EFFECT_BINDING_FIELDS = new Set([
  "effect_id",
  "effect_contract_version",
  "effect_kind",
  "branch_ref",
  "attempt",
  "dispatch_id",
  "mutation_idempotency_key",
]);
const COMMON_PAYLOAD_FIELDS = Object.freeze([
  "work_order_id",
  "plan_snapshot_ref",
  "plan_hash",
  "source_id",
  "prior_work_order_revision",
  "target_work_order_revision",
  "occurred_at",
]);
const TRUSTED_PROJECTIONS = new WeakSet();

function receiptSourceType(type) {
  return RECEIPT_TYPES[type] ? RECEIPT_TYPES[type][0] : null;
}

class BusinessProjectionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "BusinessProjectionError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new BusinessProjectionError(code, message, details);
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function trustProjection(value) {
  const frozen = deepFreeze(value);
  TRUSTED_PROJECTIONS.add(frozen);
  return frozen;
}

function cloneJson(value, path, maximumBytes = MAX_EVENT_BYTES) {
  let serialized;
  try {
    serialized = canonicalJson(value);
  } catch (error) {
    fail("BUSINESS_PROJECTION_INVALID", `${path} must be canonical JSON`, {
      path,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (Buffer.byteLength(serialized, "utf8") > maximumBytes) {
    fail("BUSINESS_PROJECTION_LIMIT", `${path} exceeds the projection size limit`, { path });
  }
  return JSON.parse(serialized);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function object(value, path) {
  if (!isPlainObject(value)) fail("BUSINESS_PROJECTION_INVALID", `${path} must be an object`, { path });
  return value;
}

function exact(value, allowed, required, path) {
  const input = object(value, path);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) fail("BUSINESS_PROJECTION_INVALID", `${path}.${key} is not supported`, { path: `${path}.${key}` });
  }
  for (const key of required) {
    if (!Object.hasOwn(input, key)) fail("BUSINESS_PROJECTION_INVALID", `${path}.${key} is required`, { path: `${path}.${key}` });
  }
  return input;
}

function text(value, path, maximum = CONTRACT_LIMITS.max_text_bytes) {
  if (typeof value !== "string" || value.trim() === "") {
    fail("BUSINESS_PROJECTION_INVALID", `${path} must be a non-empty string`, { path });
  }
  const normalized = value.trim();
  if (Buffer.byteLength(normalized, "utf8") > maximum) {
    fail("BUSINESS_PROJECTION_LIMIT", `${path} is too large`, { path });
  }
  return normalized;
}

function portableRef(value, path) {
  const normalized = text(value, path, CONTRACT_LIMITS.max_ref_bytes);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@+\-]*$/u.test(normalized)) {
    fail("BUSINESS_PROJECTION_INVALID", `${path} must be a portable reference`, { path });
  }
  return normalized;
}

function integer(value, path, minimum = 0, maximum = 1_000_000_000) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail("BUSINESS_PROJECTION_INVALID", `${path} must be an integer from ${minimum} to ${maximum}`, { path });
  }
  return value;
}

function enumeration(value, allowed, path) {
  if (!allowed.includes(value)) {
    fail("BUSINESS_PROJECTION_INVALID", `${path} must be one of: ${allowed.join(", ")}`, { path });
  }
  return value;
}

function sha256(value, path) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    fail("BUSINESS_PROJECTION_INVALID", `${path} must be a lowercase SHA-256 hash`, { path });
  }
  return value;
}

function timestamp(value, path) {
  const normalized = text(value, path, 64);
  const milliseconds = Date.parse(normalized);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== normalized) {
    fail("BUSINESS_PROJECTION_INVALID", `${path} must be a canonical UTC timestamp`, { path });
  }
  return normalized;
}

function stringArray(value, path, { minimum = 0, maximum = MAX_EVENT_EVIDENCE_REFS } = {}) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    fail("BUSINESS_PROJECTION_LIMIT", `${path} must contain from ${minimum} to ${maximum} values`, { path });
  }
  const normalized = value.map((entry, index) => portableRef(entry, `${path}[${index}]`));
  if (new Set(normalized).size !== normalized.length) {
    fail("BUSINESS_PROJECTION_INVALID", `${path} must contain unique values`, { path });
  }
  return normalized;
}

function contentRef(value, path) {
  const ref = exact(value, new Set(["id", "hash"]), new Set(["id", "hash"]), path);
  return { id: portableRef(ref.id, `${path}.id`), hash: sha256(ref.hash, `${path}.hash`) };
}

function same(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function initialBusinessProjectionV1() {
  return trustProjection({
    schema_version: BUSINESS_PROJECTION_VERSION,
    work_orders: {},
    command_receipts: {},
    observation_receipts: {},
    internal_receipts: {},
    provider_entry_windows: {},
    outbox: {},
    late_observations: {},
    provider_settlement_epoch: null,
  });
}

function normalizeProjection(input) {
  if (input && typeof input === "object" && TRUSTED_PROJECTIONS.has(input)) return input;
  const projection = cloneJson(input, "projection", MAX_PROJECTION_BYTES);
  exact(
    projection,
    new Set([
      "schema_version",
      "work_orders",
      "command_receipts",
      "observation_receipts",
      "internal_receipts",
      "provider_entry_windows",
      "outbox",
      "late_observations",
      "provider_settlement_epoch",
    ]),
    new Set([
      "schema_version",
      "work_orders",
      "command_receipts",
      "observation_receipts",
      "internal_receipts",
      "provider_entry_windows",
      "outbox",
      "late_observations",
      "provider_settlement_epoch",
    ]),
    "projection",
  );
  if (projection.schema_version !== BUSINESS_PROJECTION_VERSION) {
    fail("BUSINESS_PROJECTION_VERSION", "Unsupported business projection version", {
      version: projection.schema_version,
    });
  }
  for (const field of [
    "work_orders",
    "command_receipts",
    "observation_receipts",
    "internal_receipts",
    "provider_entry_windows",
    "outbox",
    "late_observations",
  ]) object(projection[field], `projection.${field}`);
  if (projection.provider_settlement_epoch !== null) {
    object(projection.provider_settlement_epoch, "projection.provider_settlement_epoch");
  }
  return trustProjection(projection);
}

function normalizeEvent(input) {
  const event = cloneJson(input, "event");
  exact(event, EVENT_FIELDS, EVENT_FIELDS, "event");
  const type = text(event.type, "event.type", 128);
  if (!EVENT_TYPE_SET.has(type)) {
    fail("BUSINESS_PROJECTION_EVENT_UNKNOWN", `Unsupported business event: ${type}`, { type });
  }
  if (event.schema_version !== BUSINESS_EVENT_SCHEMA_VERSION) {
    fail("BUSINESS_PROJECTION_EVENT_VERSION", "Unsupported business event schema version", {
      version: event.schema_version,
    });
  }
  const evidenceRefs = stringArray(event.evidence_refs, "event.evidence_refs");
  const payload = object(event.payload, "event.payload");
  if (GLOBAL_EVENT_TYPES.has(type)) {
    return {
      event_id: portableRef(event.event_id, "event.event_id"),
      schema_version: BUSINESS_EVENT_SCHEMA_VERSION,
      type,
      payload,
      evidence_refs: evidenceRefs,
    };
  }
  for (const field of COMMON_PAYLOAD_FIELDS) {
    if (!Object.hasOwn(payload, field)) {
      fail("BUSINESS_PROJECTION_INVALID", `event.payload.${field} is required`, { path: `event.payload.${field}` });
    }
  }
  return {
    event_id: portableRef(event.event_id, "event.event_id"),
    schema_version: BUSINESS_EVENT_SCHEMA_VERSION,
    type,
    payload: {
      ...payload,
      work_order_id: normalizeWorkOrderId(payload.work_order_id, "event.payload.work_order_id"),
      plan_snapshot_ref: normalizePlanSnapshotRef(payload.plan_snapshot_ref, "event.payload.plan_snapshot_ref"),
      plan_hash: sha256(payload.plan_hash, "event.payload.plan_hash"),
      source_id: portableRef(payload.source_id, "event.payload.source_id"),
      prior_work_order_revision: integer(payload.prior_work_order_revision, "event.payload.prior_work_order_revision"),
      target_work_order_revision: integer(payload.target_work_order_revision, "event.payload.target_work_order_revision"),
      occurred_at: timestamp(payload.occurred_at, "event.payload.occurred_at"),
    },
    evidence_refs: evidenceRefs,
  };
}

function normalizeWorkOrderId(value, path) {
  const normalized = portableRef(value, path);
  if (!/^WO-[a-f0-9]{32}$/u.test(normalized)) {
    fail("BUSINESS_PROJECTION_INVALID", `${path} must be a V1 Work Order identifier`, { path });
  }
  return normalized;
}

function normalizePlanSnapshotRef(value, path) {
  const normalized = portableRef(value, path);
  if (!/^BPS-[a-f0-9]{32}$/u.test(normalized)) {
    fail("BUSINESS_PROJECTION_INVALID", `${path} must be a V1 plan snapshot reference`, { path });
  }
  return normalized;
}

function workOrderEngineContractVersion(workOrder) {
  const version = workOrder.engine_contract_version === undefined
    ? 1
    : workOrder.engine_contract_version;
  if (version !== 1 && version !== 2) {
    fail(
      "BUSINESS_PROJECTION_VERSION",
      "The Work Order engine contract version is not supported",
      { engine_contract_version: version },
    );
  }
  return version;
}

function requireLifecycleSnapshot(projection, workOrder) {
  try {
    return assertLifecycleInvariants(deriveLifecycleSnapshot({
      workOrder,
      outbox: projection.outbox,
      attention: workOrder.attention,
    }));
  } catch (error) {
    if (error?.code !== "BUSINESS_LIFECYCLE_INVARIANT") throw error;
    fail(
      "BUSINESS_PROJECTION_RECEIPT_BINDING",
      "The receipt does not close one coherent provider-effect lifecycle",
      {
        violations: Array.isArray(error.details?.violations)
          ? error.details.violations.map((violation) => violation.code)
          : [],
      },
    );
  }
}

function withMapEntry(map, key, value) {
  return { ...map, [key]: value };
}

function replaceWorkOrder(projection, workOrder) {
  return {
    ...projection,
    work_orders: withMapEntry(projection.work_orders, workOrder.work_order_id, workOrder),
  };
}

function findReceipt(projection, sourceId) {
  const matches = [
    ["command_receipts", projection.command_receipts[sourceId]],
    ["observation_receipts", projection.observation_receipts[sourceId]],
    ["internal_receipts", projection.internal_receipts[sourceId]],
  ].filter(([, receipt]) => receipt !== undefined);
  if (matches.length > 1) {
    fail("BUSINESS_PROJECTION_ID_CONFLICT", "A source identifier exists in multiple receipt namespaces", {
      source_id: sourceId,
    });
  }
  return matches[0] || null;
}

function findPendingSource(projection, sourceId) {
  const matches = Object.values(projection.work_orders).filter(
    (workOrder) => workOrder.pending_projection_input
      && workOrder.pending_projection_input.source_id === sourceId,
  );
  if (matches.length > 1) {
    fail("BUSINESS_PROJECTION_ID_CONFLICT", "A source identifier is pending for multiple Work Orders", {
      source_id: sourceId,
    });
  }
  return matches[0] || null;
}

function normalizedBatchId(batchContext) {
  if (batchContext === undefined || batchContext === null) return null;
  object(batchContext, "batch");
  if (!Object.hasOwn(batchContext, "batch_id")) return null;
  return portableRef(batchContext.batch_id, "batch.batch_id");
}

function inferSourceType(event) {
  if (event.type === "business.work_order.created") return "command";
  if (INTERNAL_ONLY_EVENT_TYPES.has(event.type)) return "internal_action";
  if ([
    "business.branch.runtime_observed",
    "business.verification.recorded",
    "business.review.recorded",
    "business.late_observation.quarantined",
    "business.recovery_probe.recorded",
    "business.outbox.delivered",
    "business.outbox.not_sent",
    "business.outbox.delivery_unknown",
  ].includes(event.type)) return "observation";
  return receiptSourceType(event.type);
}

function assertEventAllowedForSource(type, sourceType) {
  if (receiptSourceType(type) === sourceType) return;
  if (!BATCH_EVENT_TYPES[sourceType] || !BATCH_EVENT_TYPES[sourceType].has(type)) {
    fail(
      "BUSINESS_PROJECTION_SOURCE_CLASS",
      `Event ${type} is not allowed in a ${sourceType || "unknown"} input`,
      { type, source_type: sourceType || null },
    );
  }
}

function nestedObservationName(event) {
  const observation = event.payload?.observation || event.payload?.record?.observation;
  return isPlainObject(observation) && typeof observation.name === "string"
    ? observation.name
    : null;
}

function validateProviderSettlementBatchRoute(projection, events, sourceType) {
  const domainEvents = events.slice(0, -1);
  const observationNames = domainEvents
    .map(nestedObservationName)
    .filter((name) => name !== null);
  const currentNames = observationNames.filter(
    (name) => PROVIDER_SETTLEMENT_CURRENT_OBSERVATIONS.has(name),
  );
  const legacyNames = observationNames.filter(
    (name) => PROVIDER_SETTLEMENT_LEGACY_OBSERVATIONS.has(name),
  );
  const sensitive = currentNames.length > 0
    || legacyNames.length > 0
    || domainEvents.some((entry) => PROVIDER_SETTLEMENT_SENSITIVE_EVENTS.has(entry.type));
  const activated = projection.provider_settlement_epoch !== null;

  if (sourceType === PROVIDER_SETTLEMENT_SOURCE_TYPE) {
    if (!activated) {
      fail(
        "BUSINESS_PROJECTION_PROVIDER_SETTLEMENT_CUTOVER",
        "The dedicated provider-settlement source cannot precede its durable cutover epoch",
      );
    }
    if (!sensitive || currentNames.length === 0 || legacyNames.length !== 0) {
      fail(
        "BUSINESS_PROJECTION_PROVIDER_SETTLEMENT_ROUTE",
        "The dedicated provider-settlement source requires one current V2 settlement envelope",
      );
    }
    if (new Set(currentNames).size !== 1
        || observationNames.some(
          (name) => !PROVIDER_SETTLEMENT_CURRENT_OBSERVATIONS.has(name),
        )) {
      fail(
        "BUSINESS_PROJECTION_PROVIDER_SETTLEMENT_ROUTE",
        "A provider-settlement batch cannot mix current, legacy, or unrelated observation contracts",
      );
    }
    return;
  }

  if (activated && sensitive) {
    fail(
      "BUSINESS_PROJECTION_PROVIDER_SETTLEMENT_ROUTE",
      "Post-cutover provider settlement must use the dedicated source and receipt",
      { source_type: sourceType },
    );
  }
}

function validateAtomicBatchStart(projection, event, batchContext) {
  if (!batchContext || !Array.isArray(batchContext.events)) return null;
  if (batchContext.events.length < 2 || batchContext.events.length > 513) {
    fail(
      "BUSINESS_PROJECTION_RECEIPT_BINDING",
      "A Business batch must contain domain events followed by one receipt",
    );
  }
  const events = batchContext.events.map((entry) => normalizeEvent(entry));
  if (events.some((entry) => !EVENT_TYPE_SET.has(entry.type))) {
    fail(
      "BUSINESS_PROJECTION_SOURCE_CLASS",
      "A Business receipt cannot share an atomic batch with a foreign event type",
    );
  }
  if (events[0]?.event_id !== event.event_id) return null;
  const receipt = events.at(-1);
  const sourceType = receiptSourceType(receipt.type);
  if (!sourceType
      || events.slice(0, -1).some((entry) => receiptSourceType(entry.type) !== null)) {
    fail(
      "BUSINESS_PROJECTION_RECEIPT_BINDING",
      "A Business batch must end with its single receipt event",
    );
  }
  const binding = events[0].payload;
  for (const entry of events) {
    if (entry.payload.work_order_id !== binding.work_order_id
        || entry.payload.plan_snapshot_ref !== binding.plan_snapshot_ref
        || entry.payload.plan_hash !== binding.plan_hash
        || entry.payload.source_id !== binding.source_id
        || entry.payload.prior_work_order_revision !== binding.prior_work_order_revision
        || entry.payload.target_work_order_revision !== binding.target_work_order_revision
        || entry.payload.occurred_at !== binding.occurred_at) {
      fail(
        "BUSINESS_PROJECTION_RECEIPT_BINDING",
        "Every event in an atomic input must carry one exact source and revision binding",
      );
    }
  }
  for (const entry of events.slice(0, -1)) assertEventAllowedForSource(entry.type, sourceType);
  validateProviderSettlementBatchRoute(projection, events, sourceType);
  const expectedTarget = sourceType === "internal_action"
    ? binding.prior_work_order_revision
    : binding.prior_work_order_revision + 1;
  if (binding.target_work_order_revision !== expectedTarget) {
    fail(
      "BUSINESS_PROJECTION_REVISION",
      "The receipt source class does not match its business revision window",
    );
  }
  return sourceType;
}

function beginInput(projection, event, batchContext, batchSourceType) {
  const binding = event.payload;
  const workOrder = projection.work_orders[binding.work_order_id];
  const batchId = normalizedBatchId(batchContext);
  const receiptMatch = findReceipt(projection, binding.source_id);

  if (receiptMatch) {
    const [, receipt] = receiptMatch;
    const storedHash = receipt.event_hashes && receipt.event_hashes[event.event_id];
    const incomingHash = canonicalHash(event);
    if (!workOrder
      || receipt.work_order_id !== binding.work_order_id
      || !storedHash
      || storedHash !== incomingHash) {
      fail("BUSINESS_PROJECTION_ID_CONFLICT", "A received source or event identifier was reused with conflicting content", {
        source_id: binding.source_id,
        event_id: event.event_id,
      });
    }
    return { projection, workOrder, duplicate: true, batchId };
  }

  const pendingElsewhere = findPendingSource(projection, binding.source_id);
  if (pendingElsewhere && pendingElsewhere.work_order_id !== binding.work_order_id) {
    fail("BUSINESS_PROJECTION_ID_CONFLICT", "A pending source identifier was reused for another Work Order", {
      source_id: binding.source_id,
    });
  }

  if (!workOrder) {
    if (event.type !== "business.work_order.created") {
      fail("BUSINESS_PROJECTION_WORK_ORDER_MISSING", "The event references an unknown Work Order", {
        work_order_id: binding.work_order_id,
      });
    }
    if (binding.prior_work_order_revision !== 0 || binding.target_work_order_revision !== 1) {
      fail("BUSINESS_PROJECTION_REVISION", "A Work Order must be created from revision 0 to revision 1", {
        prior: binding.prior_work_order_revision,
        target: binding.target_work_order_revision,
      });
    }
    if ((batchSourceType || inferSourceType(event)) !== "command") {
      fail("BUSINESS_PROJECTION_SOURCE_CLASS", "Only a command may create a Work Order");
    }
    return {
      projection,
      workOrder: null,
      duplicate: false,
      batchId,
      sourceType: "command",
    };
  }

  workOrderEngineContractVersion(workOrder);

  if (workOrder.plan_snapshot_ref !== binding.plan_snapshot_ref || workOrder.plan_hash !== binding.plan_hash) {
    fail("BUSINESS_PROJECTION_PLAN_BINDING", "The event plan binding does not match the Work Order", {
      work_order_id: binding.work_order_id,
    });
  }
  if (Date.parse(binding.occurred_at) < Date.parse(workOrder.created_at)) {
    fail("BUSINESS_PROJECTION_INVALID", "An event cannot predate its Work Order");
  }

  const pending = workOrder.pending_projection_input;
  if (pending) {
    if (pending.source_id !== binding.source_id
      || pending.prior_work_order_revision !== binding.prior_work_order_revision
      || pending.target_work_order_revision !== binding.target_work_order_revision
      || pending.occurred_at !== binding.occurred_at
      || (pending.batch_id !== null && batchId !== null && pending.batch_id !== batchId)) {
      fail("BUSINESS_PROJECTION_REVISION", "A different input cannot enter an incomplete projection input", {
        active_source_id: pending.source_id,
        source_id: binding.source_id,
      });
    }
    const eventSourceType = receiptSourceType(event.type);
    if (TERMINAL_WORK_ORDER_STATE_SET.has(workOrder.status) && eventSourceType === null) {
      fail(
        "BUSINESS_PROJECTION_TRANSITION",
        "Only the current receipt may follow a terminal transition in the same input",
      );
    }
    if (eventSourceType !== null) {
      if (pending.source_type && pending.source_type !== eventSourceType) {
        fail("BUSINESS_PROJECTION_SOURCE_CLASS", "Receipt type does not match its input events");
      }
      for (const type of pending.event_types) assertEventAllowedForSource(type, eventSourceType);
    } else if (pending.source_type) {
      assertEventAllowedForSource(event.type, pending.source_type);
    }
    const incomingHash = canonicalHash(event);
    if (Object.hasOwn(pending.event_hashes, event.event_id)) {
      if (pending.event_hashes[event.event_id] !== incomingHash) {
        fail("BUSINESS_PROJECTION_ID_CONFLICT", "An event identifier was reused with conflicting content", {
          event_id: event.event_id,
        });
      }
      return { projection, workOrder, duplicate: true, batchId };
    }
    const nextPending = {
      ...pending,
      source_type: pending.source_type || batchSourceType || inferSourceType(event),
      event_ids: [...pending.event_ids, event.event_id],
      event_types: [...pending.event_types, event.type],
      event_hashes: withMapEntry(pending.event_hashes, event.event_id, incomingHash),
    };
    const nextWorkOrder = { ...workOrder, pending_projection_input: nextPending };
    return {
      projection: replaceWorkOrder(projection, nextWorkOrder),
      workOrder: nextWorkOrder,
      duplicate: false,
      batchId,
      sourceType: nextPending.source_type,
    };
  }

  if (TERMINAL_WORK_ORDER_STATE_SET.has(workOrder.status)
    && event.type !== "business.late_observation.quarantined") {
    fail("BUSINESS_PROJECTION_TRANSITION", "A new input cannot mutate a terminal Work Order; late facts must be quarantined", {
      work_order_id: workOrder.work_order_id,
      status: workOrder.status,
      type: event.type,
    });
  }

  const sourceType = batchSourceType || inferSourceType(event);
  if (!sourceType) {
    fail(
      "BUSINESS_PROJECTION_SOURCE_CLASS",
      "The first event requires an atomic batch receipt to establish its source class",
    );
  }
  assertEventAllowedForSource(event.type, sourceType);
  const isInternal = sourceType === "internal_action";
  const expectedTarget = isInternal ? workOrder.revision : workOrder.revision + 1;
  if (binding.prior_work_order_revision !== workOrder.revision
    || binding.target_work_order_revision !== expectedTarget) {
    fail("BUSINESS_PROJECTION_REVISION", "The event does not advance the Work Order revision correctly", {
      current: workOrder.revision,
      prior: binding.prior_work_order_revision,
      target: binding.target_work_order_revision,
      internal: isInternal,
    });
  }
  const pendingInput = {
    source_id: binding.source_id,
    source_type: sourceType,
    prior_work_order_revision: binding.prior_work_order_revision,
    target_work_order_revision: binding.target_work_order_revision,
    occurred_at: binding.occurred_at,
    batch_id: batchId,
    event_ids: [event.event_id],
    event_types: [event.type],
    event_hashes: { [event.event_id]: canonicalHash(event) },
  };
  const nextWorkOrder = {
    ...workOrder,
    revision: expectedTarget,
    pending_projection_input: pendingInput,
  };
  return {
    projection: replaceWorkOrder(projection, nextWorkOrder),
    workOrder: nextWorkOrder,
    duplicate: false,
    batchId,
    sourceType,
  };
}

function requireSpecificFields(event, allowedSpecific, requiredSpecific = allowedSpecific) {
  const allowed = new Set([...COMMON_PAYLOAD_FIELDS, ...allowedSpecific]);
  const required = new Set([...COMMON_PAYLOAD_FIELDS, ...requiredSpecific]);
  return exact(event.payload, allowed, required, "event.payload");
}

function requireWorkOrder(projection, event) {
  const workOrder = projection.work_orders[event.payload.work_order_id];
  if (!workOrder) fail("BUSINESS_PROJECTION_WORK_ORDER_MISSING", "The Work Order does not exist");
  return workOrder;
}

function requireBranch(workOrder, branchRef) {
  const normalized = portableRef(branchRef, "event.payload.branch_ref");
  const branch = workOrder.branches[normalized];
  if (!branch) {
    fail("BUSINESS_PROJECTION_BRANCH_MISSING", "The event references an unknown branch", {
      branch_ref: normalized,
    });
  }
  return branch;
}

function normalizeReason(value, path = "event.payload.reason") {
  return text(value, path, 4_096);
}

function allBranchesAccepted(workOrder) {
  const branches = Object.values(workOrder.branches);
  return branches.length === workOrder.plan.branches.length
    && branches.every((branch) => branch.state === "accepted");
}

function acceptedReviewCount(workOrder) {
  const assignees = new Set(workOrder.plan.branches.map((branch) => branch.assignee_ref));
  const finalBranchRef = workOrder.plan.integration_branch_ref || workOrder.plan.branches[0].branch_ref;
  const finalResult = workOrder.branches[finalBranchRef]?.result;
  if (!finalResult) return -1;
  const finalResultHash = canonicalHash(finalResult);
  const reviewers = new Set();
  for (const review of Object.values(workOrder.acceptance.reviews)) {
    if (review.result_hash !== finalResultHash) continue;
    if (review.status !== "accepted"
        || review.findings.critical !== 0
        || review.findings.important !== 0
        || assignees.has(review.reviewer_ref)) return -1;
    reviewers.add(review.reviewer_ref);
  }
  return reviewers.size;
}

function assertAwaitingAcceptanceGates(workOrder) {
  const requiredReviews = { light: 0, normal: 1, strict: 2 }[
    workOrder.plan.acceptance_policy.review_minimum
  ];
  const reviewCount = acceptedReviewCount(workOrder);
  if (!workOrder.acceptance.context_budget
      || !allBranchesAccepted(workOrder)
      || Object.values(workOrder.attention).some((attention) => attention.status === "open")
      || reviewCount < requiredReviews) {
    fail(
      "BUSINESS_PROJECTION_ACCEPTANCE_GATES",
      "The Work Order does not satisfy its immutable acceptance gates",
    );
  }
}

function branchVerificationComplete(workOrder, branch) {
  if (!branch.result) return false;
  for (const criterionId of branch.required_criterion_ids) {
    const criterion = workOrder.plan.acceptance_policy.criteria.find(
      (entry) => entry.criterion_id === criterionId,
    );
    if (!criterion) return false;
    for (const requirement of criterion.verification_requirements) {
      const record = branch.verification_by_criterion[criterionId]
        && branch.verification_by_criterion[criterionId][requirement.verification_ref.id];
      if (!record
          || record.status !== "passed"
          || record.kind !== requirement.kind
          || !same(record.verification_ref, requirement.verification_ref)) return false;
    }
  }
  return true;
}

function reduceWorkOrderCreated(projection, event, batchId) {
  const payload = requireSpecificFields(
    event,
    ["plan", "deadline_at", "engine_contract_version", "revision", "status", "created_at"],
    ["plan", "deadline_at"],
  );
  let plan;
  try {
    plan = normalizeBusinessWorkOrderPlanV1(payload.plan);
  } catch (error) {
    fail("BUSINESS_PROJECTION_INVALID", "The Work Order plan is not a valid normalized V1 plan", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (plan.plan_snapshot_id !== payload.plan_snapshot_ref || plan.plan_hash !== payload.plan_hash) {
    fail("BUSINESS_PROJECTION_PLAN_BINDING", "The created Work Order does not match its plan snapshot binding", {
      plan_snapshot_ref: payload.plan_snapshot_ref,
    });
  }
  const deadlineAt = timestamp(payload.deadline_at, "event.payload.deadline_at");
  if (Date.parse(deadlineAt) <= Date.parse(payload.occurred_at)) {
    fail("BUSINESS_PROJECTION_INVALID", "The Work Order deadline must be after creation", { path: "event.payload.deadline_at" });
  }
  if ((Object.hasOwn(payload, "revision") && payload.revision !== 1)
    || (Object.hasOwn(payload, "status") && payload.status !== "starting")
    || (Object.hasOwn(payload, "created_at")
      && timestamp(payload.created_at, "event.payload.created_at") !== payload.occurred_at)) {
    fail("BUSINESS_PROJECTION_INVALID", "Created-event derived fields do not match the V1 initial state");
  }
  const engineContractVersion = Object.hasOwn(payload, "engine_contract_version")
    ? integer(
      payload.engine_contract_version,
      "event.payload.engine_contract_version",
      1,
      2,
    )
    : 1;
  const pending = {
    source_id: payload.source_id,
    source_type: "command",
    prior_work_order_revision: 0,
    target_work_order_revision: 1,
    occurred_at: payload.occurred_at,
    batch_id: batchId,
    event_ids: [event.event_id],
    event_types: [event.type],
    event_hashes: { [event.event_id]: canonicalHash(event) },
  };
  const workOrder = {
    work_order_id: payload.work_order_id,
    plan_snapshot_ref: payload.plan_snapshot_ref,
    plan_hash: payload.plan_hash,
    plan,
    engine_contract_version: engineContractVersion,
    revision: 1,
    status: "starting",
    created_at: payload.occurred_at,
    started_at: null,
    deadline_at: deadlineAt,
    stop_reason: null,
    branches: {},
    attention: {},
    acceptance: {
      context_budget: null,
      reviews: {},
      decision: null,
      decision_history: [],
    },
    pending_projection_input: pending,
  };
  return replaceWorkOrder(projection, workOrder);
}

function reduceWorkOrderStatus(projection, event) {
  const payload = requireSpecificFields(event, ["from", "to", "reason"]);
  const workOrder = requireWorkOrder(projection, event);
  const from = enumeration(payload.from, WORK_ORDER_STATES, "event.payload.from");
  const to = enumeration(payload.to, WORK_ORDER_STATES, "event.payload.to");
  if (workOrder.status !== from || !WORK_ORDER_TRANSITIONS[from].has(to)) {
    fail("BUSINESS_PROJECTION_TRANSITION", `Illegal Work Order transition: ${workOrder.status} -> ${to}`, {
      current: workOrder.status,
      from,
      to,
    });
  }
  if (TERMINAL_WORK_ORDER_STATE_SET.has(workOrder.status)) {
    fail("BUSINESS_PROJECTION_TRANSITION", "A terminal Work Order cannot be reopened");
  }
  const reason = normalizeReason(payload.reason);
  if (to === "awaiting_acceptance") assertAwaitingAcceptanceGates(workOrder);
  if (to === "accepted") {
    assertAwaitingAcceptanceGates(workOrder);
    if (!workOrder.acceptance.decision
        || workOrder.acceptance.decision.decision !== "accepted") {
      fail(
        "BUSINESS_PROJECTION_ACCEPTANCE_GATES",
        "A terminal accepted state requires the current accepted decision",
      );
    }
  }
  if (from === "awaiting_acceptance" && to === "paused"
      && (!workOrder.acceptance.decision
        || workOrder.acceptance.decision.decision !== "rejected")) {
    fail(
      "BUSINESS_PROJECTION_ACCEPTANCE_GATES",
      "Leaving acceptance for rework requires a recorded rejection",
    );
  }
  const next = {
    ...workOrder,
    status: to,
    started_at: to === "running" && workOrder.started_at === null ? payload.occurred_at : workOrder.started_at,
    stop_reason: TERMINAL_WORK_ORDER_STATE_SET.has(to) || to === "cancelling" ? reason : workOrder.stop_reason,
  };
  return replaceWorkOrder(projection, next);
}

function normalizeContextBudgetReceipt(value, plan) {
  const receipt = exact(
    value,
    new Set(["budget_tokens", "duplicate_context_tokens", "evidence_refs"]),
    new Set(["budget_tokens", "duplicate_context_tokens", "evidence_refs"]),
    "event.payload.receipt",
  );
  const budget = integer(receipt.budget_tokens, "event.payload.receipt.budget_tokens", 0, 100_000_000);
  const duplicate = integer(receipt.duplicate_context_tokens, "event.payload.receipt.duplicate_context_tokens", 0, 100_000_000);
  if (budget !== plan.context_duplication_budget_tokens || duplicate > budget) {
    fail("BUSINESS_PROJECTION_INVALID", "The context budget receipt does not satisfy the immutable plan budget");
  }
  return {
    budget_tokens: budget,
    duplicate_context_tokens: duplicate,
    evidence_refs: stringArray(receipt.evidence_refs, "event.payload.receipt.evidence_refs", { minimum: 1 }),
  };
}

function reduceContextBudget(projection, event) {
  const payload = requireSpecificFields(event, ["receipt"]);
  const workOrder = requireWorkOrder(projection, event);
  const receipt = normalizeContextBudgetReceipt(payload.receipt, workOrder.plan);
  if (workOrder.acceptance.context_budget !== null) {
    if (same(workOrder.acceptance.context_budget, receipt)) return projection;
    fail("BUSINESS_PROJECTION_ID_CONFLICT", "The context budget receipt cannot be replaced");
  }
  return replaceWorkOrder(projection, {
    ...workOrder,
    acceptance: { ...workOrder.acceptance, context_budget: receipt },
  });
}

function reduceBranchInitialized(projection, event) {
  const payload = requireSpecificFields(event, ["branch", "state", "required_criterion_ids"]);
  const workOrder = requireWorkOrder(projection, event);
  const branchDefinition = object(payload.branch, "event.payload.branch");
  const branchRef = portableRef(branchDefinition.branch_ref, "event.payload.branch.branch_ref");
  const planned = workOrder.plan.branches.find((branch) => branch.branch_ref === branchRef);
  if (!planned || !same(planned, branchDefinition)) {
    fail("BUSINESS_PROJECTION_PLAN_BINDING", "The initialized branch does not match the immutable plan", {
      branch_ref: branchRef,
    });
  }
  const state = enumeration(payload.state, ["blocked", "ready"], "event.payload.state");
  const requiredCriterionIds = stringArray(
    payload.required_criterion_ids,
    "event.payload.required_criterion_ids",
    { minimum: 1, maximum: CONTRACT_LIMITS.max_acceptance_criteria },
  ).sort();
  const planCriterionIds = workOrder.plan.acceptance_policy.criteria
    .map((criterion) => criterion.criterion_id)
    .sort();
  if (requiredCriterionIds.some((criterionId) => !planCriterionIds.includes(criterionId))
    || (planned.role === "integration" && !same(requiredCriterionIds, planCriterionIds))) {
    fail("BUSINESS_PROJECTION_PLAN_BINDING", "Branch criterion bindings do not match the immutable plan", {
      branch_ref: branchRef,
    });
  }
  const branch = {
    ...planned,
    required_criterion_ids: requiredCriterionIds,
    state,
    attempt: 0,
    dispatch_id: null,
    packet_ref: null,
    attempt_started_at: null,
    attempt_deadline_at: null,
    retry_at: null,
    delivery: null,
    thread_identity: null,
    runtime_identity: null,
    open_user_input: null,
    pending_user_input_effect_id: null,
    pending_user_input_response_ref: null,
    result: null,
    verification_by_criterion: {},
    last_progress_at: null,
    finished_at: null,
    attempt_history: {},
    last_runtime_observation: null,
    thread_create_effect_id: null,
    thread_create_delivery_hash: null,
    turn_start_effect_id: null,
    turn_start_delivery_hash: null,
    cancel_effect_id: null,
  };
  const existing = workOrder.branches[branchRef];
  if (existing) {
    if (same(existing, branch)) return projection;
    fail("BUSINESS_PROJECTION_ID_CONFLICT", "A branch identifier was reused with conflicting content", {
      branch_ref: branchRef,
    });
  }
  return replaceWorkOrder(projection, {
    ...workOrder,
    branches: withMapEntry(workOrder.branches, branchRef, branch),
  });
}

function dispatchIdInUse(workOrder, dispatchId) {
  for (const branch of Object.values(workOrder.branches)) {
    if (branch.dispatch_id === dispatchId) return true;
    for (const attempt of Object.values(branch.attempt_history || {})) {
      if (attempt.dispatch_id === dispatchId) return true;
    }
  }
  return false;
}

function reduceAttemptOpened(projection, event) {
  const payload = requireSpecificFields(event, [
    "branch_ref",
    "attempt",
    "dispatch_id",
    "attempt_started_at",
    "attempt_deadline_at",
    "packet_ref",
    "packet_hash",
    "retry_at",
  ], [
    "branch_ref",
    "attempt",
    "dispatch_id",
    "attempt_started_at",
    "attempt_deadline_at",
    "packet_ref",
  ]);
  const workOrder = requireWorkOrder(projection, event);
  const branch = requireBranch(workOrder, payload.branch_ref);
  if (!["ready", "retryable", "failed"].includes(branch.state)) {
    fail("BUSINESS_PROJECTION_TRANSITION", `Cannot open an attempt from branch state ${branch.state}`);
  }
  if (workOrderEngineContractVersion(workOrder) === 2) {
    const lifecycle = requireLifecycleSnapshot(projection, workOrder).branches[branch.branch_ref];
    if (lifecycle.unresolved_effect_ids.length !== 0) {
      fail(
        "BUSINESS_PROJECTION_TRANSITION",
        "A new attempt cannot start while an earlier provider mutation remains unresolved",
        { unresolved_effect_ids: lifecycle.unresolved_effect_ids },
      );
    }
  }
  const attempt = integer(payload.attempt, "event.payload.attempt", 1, workOrder.plan.retry_policy.max_attempts);
  if (attempt !== branch.attempt + 1) {
    fail("BUSINESS_PROJECTION_TRANSITION", "Branch attempts must increase by exactly one", {
      current_attempt: branch.attempt,
      attempt,
    });
  }
  const dispatchId = portableRef(payload.dispatch_id, "event.payload.dispatch_id");
  if (dispatchIdInUse(workOrder, dispatchId)) {
    fail("BUSINESS_PROJECTION_ID_CONFLICT", "A dispatch identifier was reused", { dispatch_id: dispatchId });
  }
  const startedAt = timestamp(payload.attempt_started_at, "event.payload.attempt_started_at");
  const deadlineAt = timestamp(payload.attempt_deadline_at, "event.payload.attempt_deadline_at");
  if (Date.parse(deadlineAt) <= Date.parse(startedAt) || Date.parse(deadlineAt) > Date.parse(workOrder.deadline_at)) {
    fail("BUSINESS_PROJECTION_INVALID", "The attempt deadline is outside its bounded Work Order window");
  }
  const packetRef = contentRef(payload.packet_ref, "event.payload.packet_ref");
  if (Object.hasOwn(payload, "packet_hash")
    && sha256(payload.packet_hash, "event.payload.packet_hash") !== packetRef.hash) {
    fail("BUSINESS_PROJECTION_PLAN_BINDING", "Attempt packet hash does not match its content reference");
  }
  if (Object.hasOwn(payload, "retry_at") && payload.retry_at !== null) {
    fail("BUSINESS_PROJECTION_INVALID", "A newly opened attempt cannot retain a retry timer");
  }
  const history = { ...branch.attempt_history };
  if (branch.attempt > 0) {
    history[String(branch.attempt)] = {
      attempt: branch.attempt,
      dispatch_id: branch.dispatch_id,
      state: branch.state,
      delivery: branch.delivery,
      result: branch.result,
      finished_at: branch.finished_at,
    };
  }
  const nextBranch = {
    ...branch,
    state: "dispatch_pending",
    attempt,
    dispatch_id: dispatchId,
    packet_ref: packetRef,
    attempt_started_at: startedAt,
    attempt_deadline_at: deadlineAt,
    retry_at: null,
    delivery: null,
    thread_identity: null,
    runtime_identity: null,
    open_user_input: null,
    pending_user_input_effect_id: null,
    pending_user_input_response_ref: null,
    result: null,
    verification_by_criterion: {},
    last_progress_at: null,
    finished_at: null,
    attempt_history: history,
    last_runtime_observation: null,
    thread_create_effect_id: null,
    thread_create_delivery_hash: null,
    turn_start_effect_id: null,
    turn_start_delivery_hash: null,
    cancel_effect_id: null,
  };
  return replaceWorkOrder(projection, {
    ...workOrder,
    branches: withMapEntry(workOrder.branches, branch.branch_ref, nextBranch),
  });
}

function executionWindowElapsed(workOrder, branch, occurredAt) {
  if (!branch.attempt_deadline_at) return true;
  const eventTime = Date.parse(occurredAt);
  return eventTime >= Date.parse(branch.attempt_deadline_at)
    || eventTime >= Date.parse(workOrder.deadline_at);
}

function effectIdentityForDeliveryHash(effect) {
  const fields = effect.effect_contract_version === 2
    ? OUTBOX_IMMUTABLE_FIELDS
    : LEGACY_OUTBOX_IMMUTABLE_FIELDS;
  return Object.fromEntries(fields.map((field) => [field, effect[field]]));
}

function effectDeliveryHash(effect) {
  return effect.delivery === null
    ? null
    : canonicalHash({ effect: effectIdentityForDeliveryHash(effect), ...effect.delivery });
}

function effectMatchesCurrentAttempt(effect, workOrder, branch) {
  return effect.work_order_id === workOrder.work_order_id
    && effect.branch_ref === branch.branch_ref
    && effect.attempt === branch.attempt
    && effect.dispatch_id === branch.dispatch_id
    && effect.provider_ref === branch.provider_ref;
}

function assertEffectMatchesEngineContract(workOrder, effect) {
  const engineContractVersion = workOrderEngineContractVersion(workOrder);
  const effectContractVersion = effect.effect_contract_version === undefined
    ? 1
    : effect.effect_contract_version;
  if (effectContractVersion !== engineContractVersion) {
    fail(
      "BUSINESS_PROJECTION_VERSION",
      "An outbox effect cannot implicitly change the Work Order engine contract",
      {
        engine_contract_version: engineContractVersion,
        effect_contract_version: effectContractVersion,
        effect_id: effect.effect_id,
      },
    );
  }
}

function assertWorkOrderEffectContracts(projection, workOrder) {
  const engineContractVersion = workOrderEngineContractVersion(workOrder);
  const mixedEffect = Object.values(projection.outbox).find((effect) => (
    effect.work_order_id === workOrder.work_order_id
      && (effect.effect_contract_version === undefined ? 1 : effect.effect_contract_version)
        !== engineContractVersion
  ));
  if (mixedEffect) {
    fail(
      "BUSINESS_PROJECTION_VERSION",
      "A Work Order stream cannot mix or implicitly upgrade engine effect contracts",
      {
        engine_contract_version: engineContractVersion,
        effect_contract_version: mixedEffect.effect_contract_version === undefined
          ? 1
          : mixedEffect.effect_contract_version,
        effect_id: mixedEffect.effect_id,
      },
    );
  }
}

function acceptedCurrentTurn(projection, workOrder, branch) {
  if (branch.delivery?.classification !== "accepted" || branch.runtime_identity === null) return false;
  const effect = branch.turn_start_effect_id === null
    ? null
    : projection.outbox[branch.turn_start_effect_id];
  return Boolean(effect
    && effect.effect_contract_version === 2
    && effect.effect_kind === "provider.turn.start"
    && effectMatchesCurrentAttempt(effect, workOrder, branch)
    && effect.status === "delivered"
    && effect.delivery?.classification === "accepted"
    && same(effect.delivery.runtime_identity, branch.runtime_identity)
    && same(effect.target_runtime_identity, branch.thread_identity)
    && effect.predecessor_effect_id === branch.thread_create_effect_id
    && effect.predecessor_delivery_hash === branch.thread_create_delivery_hash
    && branch.turn_start_delivery_hash === effectDeliveryHash(effect));
}

function acceptedThreadWithoutTurnAfterDeadline(projection, workOrder, branch, occurredAt) {
  const effect = branch.thread_create_effect_id === null
    ? null
    : projection.outbox[branch.thread_create_effect_id];
  if (!effect
      || effect.effect_contract_version !== 2
      || effect.effect_kind !== "provider.thread.create"
      || !effectMatchesCurrentAttempt(effect, workOrder, branch)
      || effect.status !== "delivered"
      || effect.delivery?.classification !== "accepted"
      || !same(effect.delivery.runtime_identity, branch.thread_identity)
      || effect.predecessor_effect_id !== null
      || effect.predecessor_delivery_hash !== null
      || effect.target_runtime_identity !== null
      || branch.thread_create_delivery_hash !== effectDeliveryHash(effect)
      || branch.turn_start_effect_id !== null
      || Object.values(projection.outbox).some((candidate) => (
        candidate.effect_contract_version === 2
          && effectMatchesCurrentAttempt(candidate, workOrder, branch)
          && candidate.effect_kind === "provider.turn.start"
      ))) return false;
  return executionWindowElapsed(workOrder, branch, occurredAt);
}

function hasOpenCancelAttention(workOrder, branch) {
  return Object.values(workOrder.attention).some((attention) => (
    attention.status === "open"
      && attention.branch_ref === branch.branch_ref
      && [
        "cancel_requires_runtime_identity",
        "cancel_requires_dispatch_reconciliation",
        "cancel_not_sent",
      ].includes(attention.kind)
  ));
}

function hasOpenDeliveryReconciliationAttention(projection, workOrder, branch, effect) {
  return Object.values(workOrder.attention).some((attention) => (
    attention.status === "open"
      && attention.branch_ref === branch.branch_ref
      && [
        "delivery_unknown",
        "timeout_requires_reconciliation",
        "cancel_requires_dispatch_reconciliation",
      ].includes(attention.kind)
      && attention.effect_id === effect.effect_id
  ));
}

function exactCurrentCancelEffect(projection, workOrder, branch) {
  const effect = branch.cancel_effect_id === null
    ? null
    : projection.outbox[branch.cancel_effect_id];
  if (!effect
      || effect.effect_contract_version !== 2
      || effect.effect_kind !== "provider.turn.cancel"
      || !effectMatchesCurrentAttempt(effect, workOrder, branch)
      || !ACTIVE_CANCEL_EFFECT_STATES.has(effect.status)
      || effect.predecessor_effect_id !== branch.turn_start_effect_id
      || effect.predecessor_delivery_hash !== branch.turn_start_delivery_hash
      || !same(effect.target_runtime_identity, branch.runtime_identity)) return false;
  if (effect.status === "delivered") {
    return effect.delivery?.classification === "accepted"
      && same(effect.delivery.runtime_identity, branch.runtime_identity);
  }
  if (effect.status === "delivery_unknown") {
    return effect.delivery?.classification === "delivery_unknown";
  }
  return effect.delivery === null;
}

function reduceBranchStatus(projection, event) {
  const allowedSpecific = [
    "branch_ref",
    "from",
    "to",
    "reason",
    "retry_at",
    "resolved_request_id",
    "response_ref",
  ];
  const requiredSpecific = ["branch_ref", "from", "to", "reason"];
  const payload = requireSpecificFields(event, allowedSpecific, requiredSpecific);
  const workOrder = requireWorkOrder(projection, event);
  const branch = requireBranch(workOrder, payload.branch_ref);
  const from = enumeration(payload.from, BRANCH_STATES, "event.payload.from");
  const to = enumeration(payload.to, BRANCH_STATES, "event.payload.to");
  if (branch.state !== from || !BRANCH_TRANSITIONS[from].has(to)) {
    fail("BUSINESS_PROJECTION_TRANSITION", `Illegal branch transition: ${branch.state} -> ${to}`, {
      branch_ref: branch.branch_ref,
      current: branch.state,
      from,
      to,
    });
  }
  if (from === "dispatch_pending" && to === "failed"
      && branch.delivery?.classification !== "not_sent"
      && !acceptedThreadWithoutTurnAfterDeadline(
        projection,
        workOrder,
        branch,
        payload.occurred_at,
      )) {
    fail(
      "BUSINESS_PROJECTION_TRANSITION",
      "A pending dispatch may fail only when not sent or when an accepted thread cannot start a turn after deadline",
      { branch_ref: branch.branch_ref },
    );
  }
  const reason = normalizeReason(payload.reason);
  const resolvesUserInput = from === "waiting_for_user" && to === "running";
  const carriesUserInputResolution = Object.hasOwn(payload, "resolved_request_id")
    || Object.hasOwn(payload, "response_ref");
  let resolvedUserInput = null;
  if (resolvesUserInput) {
    const legacyInputEffects = Object.values(projection.outbox).filter((effect) => (
      effect.effect_contract_version === undefined
        && effect.work_order_id === workOrder.work_order_id
        && effect.branch_ref === branch.branch_ref
        && effect.attempt === branch.attempt
        && effect.dispatch_id === branch.dispatch_id
        && effect.provider_ref === branch.provider_ref
        && effect.effect_kind === "provider.user_input.submit"
        && effect.status === "pending"
        && effect.created_at === payload.occurred_at
    ));
    const legacyResolution = branch.pending_user_input_effect_id === null
      && branch.pending_user_input_response_ref === null
      && workOrderEngineContractVersion(workOrder) === 1
      && legacyInputEffects.length === 1;
    const pendingInputEffect = branch.pending_user_input_effect_id === null
      ? null
      : projection.outbox[branch.pending_user_input_effect_id];
    const durableV2Resolution = pendingInputEffect
      && pendingInputEffect.effect_contract_version === 2
      && pendingInputEffect.work_order_id === workOrder.work_order_id
      && pendingInputEffect.branch_ref === branch.branch_ref
      && pendingInputEffect.attempt === branch.attempt
      && pendingInputEffect.dispatch_id === branch.dispatch_id
      && pendingInputEffect.provider_ref === branch.provider_ref
      && pendingInputEffect.effect_kind === "provider.user_input.submit"
      && pendingInputEffect.status === "delivered"
      && pendingInputEffect.delivery?.classification === "accepted"
      && same(pendingInputEffect.delivery.runtime_identity, branch.runtime_identity);
    if (executionWindowElapsed(workOrder, branch, payload.occurred_at)) {
      fail(
        "BUSINESS_PROJECTION_TRANSITION",
        "User input cannot resume an attempt after its execution deadline",
      );
    }
    if (!Object.hasOwn(payload, "resolved_request_id")
        || !Object.hasOwn(payload, "response_ref")
        || !branch.open_user_input
        || portableRef(payload.resolved_request_id, "event.payload.resolved_request_id")
          !== branch.open_user_input.request_id
        || (!legacyResolution
          && (!durableV2Resolution
            || branch.pending_user_input_effect_id === null
            || branch.pending_user_input_response_ref === null
            || !same(
              contentRef(payload.response_ref, "event.payload.response_ref"),
              branch.pending_user_input_response_ref,
            )))) {
      fail(
        "BUSINESS_PROJECTION_TRANSITION",
        "Resolving user input must bind the one current request and response reference",
      );
    }
    resolvedUserInput = {
      request_id: branch.open_user_input.request_id,
      response_ref: contentRef(payload.response_ref, "event.payload.response_ref"),
      resolved_at: payload.occurred_at,
    };
  } else if (carriesUserInputResolution) {
    fail(
      "BUSINESS_PROJECTION_INVALID",
      "Only a waiting-for-user transition may carry a user-input resolution",
    );
  }
  let retryAt = null;
  if (to === "retryable") {
    if (!Object.hasOwn(payload, "retry_at")) {
      fail("BUSINESS_PROJECTION_INVALID", "A retryable branch transition requires its durable retry time");
    }
    retryAt = timestamp(payload.retry_at, "event.payload.retry_at");
    if (Date.parse(retryAt) < Date.parse(payload.occurred_at)
      || Date.parse(retryAt) >= Date.parse(workOrder.deadline_at)) {
      fail("BUSINESS_PROJECTION_INVALID", "The retry time must be within the remaining Work Order window");
    }
  } else if (Object.hasOwn(payload, "retry_at")) {
    fail("BUSINESS_PROJECTION_INVALID", "Only a retryable transition may carry a retry time");
  }
  if (to === "accepted" && !branchVerificationComplete(workOrder, branch)) {
    fail(
      "BUSINESS_PROJECTION_ACCEPTANCE_GATES",
      "A branch requires a current result and every plan-bound verification before acceptance",
    );
  }
  if (to === "accepted") {
    const finalBranchRef = workOrder.plan.integration_branch_ref
      || workOrder.plan.branches[0].branch_ref;
    const requiredReviews = { light: 0, normal: 1, strict: 2 }[
      workOrder.plan.acceptance_policy.review_minimum
    ];
    if (branch.branch_ref === finalBranchRef
        && acceptedReviewCount(workOrder) < requiredReviews) {
      fail(
        "BUSINESS_PROJECTION_ACCEPTANCE_GATES",
        "The final branch requires clean independent reviews of its current result",
      );
    }
  }
  const abandonsSettledUserInput = from === "waiting_for_user"
    && branch.pending_user_input_effect_id === null
    && (to === "cancelling" || TERMINAL_BRANCH_STATE_SET.has(to));
  const nextBranch = {
    ...branch,
    state: to,
    retry_at: retryAt,
    finished_at: ["accepted", "failed", "cancelled"].includes(to) ? payload.occurred_at : null,
    last_transition_reason: reason,
    open_user_input: resolvesUserInput || abandonsSettledUserInput
      ? null
      : branch.open_user_input,
    pending_user_input_effect_id: resolvesUserInput
      ? null
      : branch.pending_user_input_effect_id,
    pending_user_input_response_ref: resolvesUserInput
      ? null
      : branch.pending_user_input_response_ref,
    last_resolved_user_input: resolvesUserInput
      ? resolvedUserInput
      : (branch.last_resolved_user_input || null),
  };
  return replaceWorkOrder(projection, {
    ...workOrder,
    branches: withMapEntry(workOrder.branches, branch.branch_ref, nextBranch),
  });
}

function normalizeRuntimeIdentity(value, path) {
  if (value === null) return null;
  const identity = exact(
    value,
    new Set(["operation_id", "thread_id", "turn_id"]),
    new Set(),
    path,
  );
  const normalized = {};
  for (const field of ["operation_id", "thread_id", "turn_id"]) {
    normalized[field] = identity[field] === undefined || identity[field] === null
      ? null
      : portableRef(identity[field], `${path}.${field}`);
  }
  if (Object.values(normalized).every((entry) => entry === null)) {
    fail("BUSINESS_PROJECTION_INVALID", `${path} must identify at least one provider operation`, { path });
  }
  return normalized;
}

function normalizeObservationFromEvent(value, event) {
  let observation;
  try {
    observation = normalizeBusinessRuntimeObservationEnvelope(value);
  } catch (error) {
    fail("BUSINESS_PROJECTION_INVALID", "The retained runtime observation is invalid", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (observation.observation_id !== event.payload.source_id
    || observation.work_order_id !== event.payload.work_order_id
    || observation.plan_snapshot_ref !== event.payload.plan_snapshot_ref
    || observation.plan_hash !== event.payload.plan_hash) {
    fail("BUSINESS_PROJECTION_PLAN_BINDING", "The retained runtime observation does not match the event binding");
  }
  return observation;
}

function observationBranch(workOrder, observation) {
  if (!Object.hasOwn(observation.payload, "branch_ref")) return null;
  return requireBranch(workOrder, observation.payload.branch_ref);
}

function reduceRecoveryProbeRecorded(projection, event) {
  const payload = requireSpecificFields(
    event,
    ["observation", "effect", "recovery_probe_ledger"],
  );
  const observation = normalizeObservationFromEvent(payload.observation, event);
  if (observation.name !== EFFECT_SETTLEMENT_OBSERVATION_NAME
      || observation.payload.settlement_source !== "recovery_probe") {
    fail(
      "BUSINESS_PROJECTION_RECOVERY_PROBE",
      "Recovery probe journal must retain an exact V2 recovery settlement",
    );
  }
  const identity = exact(
    payload.effect,
    new Set(OUTBOX_IMMUTABLE_FIELDS),
    new Set(OUTBOX_IMMUTABLE_FIELDS),
    "event.payload.effect",
  );
  const effect = projection.outbox[identity.effect_id];
  if (!effect
      || effect.effect_contract_version !== 2
      || effect.status !== "delivery_unknown"
      || !immutableEffectMatches(effect, identity)) {
    fail(
      "BUSINESS_PROJECTION_RECOVERY_PROBE",
      "Recovery probe must target the exact durably ambiguous V2 effect",
    );
  }
  const ledger = exact(
    payload.recovery_probe_ledger,
    new Set([
      "version",
      "effect_id",
      "probe_receipt_ref",
      "mutation_idempotency_key",
      "classification",
      "settlement_policy",
    ]),
    new Set([
      "version",
      "effect_id",
      "probe_receipt_ref",
      "mutation_idempotency_key",
      "classification",
      "settlement_policy",
    ]),
    "event.payload.recovery_probe_ledger",
  );
  if (ledger.version !== 1
      || ledger.effect_id !== effect.effect_id
      || !same(
        contentRef(ledger.probe_receipt_ref, "event.payload.recovery_probe_ledger.probe_receipt_ref"),
        observation.payload.recovery_probe.probe_receipt_ref,
      )
      || ledger.mutation_idempotency_key !== effect.idempotency_key
      || ledger.mutation_idempotency_key
        !== observation.payload.recovery_probe.mutation_idempotency_key
      || ledger.classification !== observation.payload.classification) {
    fail(
      "BUSINESS_PROJECTION_RECOVERY_PROBE",
      "Recovery probe ledger does not bind the exact effect mutation and outcome",
    );
  }
  normalizeSettlementPolicyRecord(ledger.settlement_policy, observation);
  return projection;
}

function normalizeSettlementPolicyRecord(value, observation) {
  let record;
  try {
    record = cloneJson(value, "event.payload.settlement_policy");
  } catch (error) {
    fail("BUSINESS_PROJECTION_SETTLEMENT_POLICY", "Settlement policy must be canonical JSON", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  let derived;
  try {
    derived = normalizeSettlementPolicyRecordV2(record);
  } catch (error) {
    fail(
      "BUSINESS_PROJECTION_SETTLEMENT_POLICY",
      "Settlement policy does not satisfy the shared V2 certainty rules",
      { cause_code: error?.code || null, cause_reason: error?.reason || null },
    );
  }
  const expiryObservation = observation.name === EFFECT_SEND_EXPIRY_OBSERVATION_NAME;
  const presendFailureObservation = observation.name === EFFECT_PRESEND_FAILURE_OBSERVATION_NAME;
  const expectedSource = expiryObservation || presendFailureObservation
    ? "control_plane"
    : observation.payload.settlement_source;
  const expectedClassification = expiryObservation
    ? "delivery_unknown"
    : presendFailureObservation
      ? "not_sent"
      : observation.payload.classification;
  if (!same(record, derived)
      || derived.effect_kind !== observation.payload.effect_kind
      || derived.settlement_source !== expectedSource
      || derived.classification !== expectedClassification) {
    fail(
      "BUSINESS_PROJECTION_SETTLEMENT_POLICY",
      "Settlement policy does not bind the retained provider settlement envelope",
    );
  }
  return derived;
}

function reduceRuntimeObserved(projection, event) {
  const payload = requireSpecificFields(
    event,
    [
      "observation",
      "runtime_identity",
      "delivery_effect_id",
      "effect_kind",
      "active_turn_effect_id",
      "active_runtime_identity",
      "settlement_policy",
    ],
    ["observation"],
  );
  const workOrder = requireWorkOrder(projection, event);
  const observation = normalizeObservationFromEvent(payload.observation, event);
  if ([
    EFFECT_SETTLEMENT_OBSERVATION_NAME,
    EFFECT_SEND_EXPIRY_OBSERVATION_NAME,
    EFFECT_PRESEND_FAILURE_OBSERVATION_NAME,
  ]
    .includes(observation.name)) {
    if (!Object.hasOwn(payload, "settlement_policy")) {
      fail(
        "BUSINESS_PROJECTION_SETTLEMENT_POLICY",
        "A V2 provider lifecycle observation must retain its shared certainty policy",
      );
    }
    normalizeSettlementPolicyRecord(payload.settlement_policy, observation);
  } else if (Object.hasOwn(payload, "settlement_policy")) {
    fail(
      "BUSINESS_PROJECTION_SETTLEMENT_POLICY",
      "Only a V2 provider lifecycle observation may retain a settlement policy",
    );
  }
  const runtimeIdentity = Object.hasOwn(payload, "runtime_identity")
    ? normalizeRuntimeIdentity(payload.runtime_identity, "event.payload.runtime_identity")
    : null;
  const branch = observationBranch(workOrder, observation);
  if (!branch) return projection;
  const allowedStates = {
    [EFFECT_SETTLEMENT_OBSERVATION_NAME]: [
      "dispatch_pending",
      "delivery_unknown",
      "waiting_for_user",
      "cancelling",
    ],
    [EFFECT_SEND_EXPIRY_OBSERVATION_NAME]: [
      "dispatch_pending",
      "delivery_unknown",
      "waiting_for_user",
      "cancelling",
    ],
    [EFFECT_PRESEND_FAILURE_OBSERVATION_NAME]: [
      "dispatch_pending",
      "waiting_for_user",
      "cancelling",
    ],
    "provider.effect.delivery.recorded": [
      "dispatch_pending",
      "delivery_unknown",
      "waiting_for_user",
      "cancelling",
    ],
    "branch.dispatch.accepted": ["dispatch_pending", "delivery_unknown"],
    "branch.dispatch.not_sent": ["dispatch_pending", "delivery_unknown"],
    "branch.progress": ["running", "waiting_for_user", "cancelling"],
    "branch.result.submitted": ["running"],
    "branch.failed": ["running", "waiting_for_user", "verifying", "cancelling"],
    "branch.timed_out": ["dispatch_pending", "running", "waiting_for_user"],
    "branch.delivery_unknown": ["dispatch_pending", "running", "delivery_unknown"],
    "branch.cancelled": ["cancelling"],
    "user_input.requested": ["running"],
    "provider.rate_limited": ["dispatch_pending", "running", "waiting_for_user", "delivery_unknown"],
    "provider.unavailable": ["dispatch_pending", "running", "waiting_for_user", "delivery_unknown"],
  }[observation.name];
  if (!allowedStates || !allowedStates.includes(branch.state)) {
    fail(
      "BUSINESS_PROJECTION_TRANSITION",
      "A runtime observation cannot mutate a non-current or terminal branch",
      { branch_ref: branch.branch_ref, state: branch.state, observation: observation.name },
    );
  }
  if (Object.hasOwn(observation.payload, "attempt") && observation.payload.attempt !== branch.attempt) {
    fail("BUSINESS_PROJECTION_TRANSITION", "A current runtime observation must match the current branch attempt");
  }
  if (Object.hasOwn(observation.payload, "dispatch_id") && observation.payload.dispatch_id !== branch.dispatch_id) {
    fail("BUSINESS_PROJECTION_TRANSITION", "A current runtime observation must match the current dispatch identifier");
  }
  if (EXECUTION_WINDOW_OBSERVATIONS.has(observation.name)
      && executionWindowElapsed(workOrder, branch, payload.occurred_at)) {
    fail(
      "BUSINESS_PROJECTION_TRANSITION",
      "A forward runtime observation cannot advance an attempt after its execution deadline",
    );
  }
  const deliveryClassification = [
    "provider.effect.delivery.recorded",
    EFFECT_SETTLEMENT_OBSERVATION_NAME,
    EFFECT_SEND_EXPIRY_OBSERVATION_NAME,
    EFFECT_PRESEND_FAILURE_OBSERVATION_NAME,
  ].includes(observation.name)
    ? (observation.name === EFFECT_SEND_EXPIRY_OBSERVATION_NAME
      ? "delivery_unknown"
      : observation.name === EFFECT_PRESEND_FAILURE_OBSERVATION_NAME
        ? "not_sent"
        : observation.payload.classification)
    : ({
      "branch.dispatch.accepted": "accepted",
      "branch.dispatch.not_sent": "not_sent",
      "branch.delivery_unknown": "delivery_unknown",
    })[observation.name];
  let deliveryEffect = null;
  let deliveryHash = null;
  let legacyDelivery = false;
  if (deliveryClassification !== undefined) {
    const hasDeliveryEffectId = Object.hasOwn(payload, "delivery_effect_id");
    const hasEffectKind = Object.hasOwn(payload, "effect_kind");
    if (hasDeliveryEffectId !== hasEffectKind) {
      fail(
        "BUSINESS_PROJECTION_OUTBOX_BINDING",
        "A provider delivery observation must carry both effect annotations or neither",
      );
    }
    const expectedStatus = {
      accepted: "delivered",
      not_sent: "not_sent",
      delivery_unknown: "delivery_unknown",
    }[deliveryClassification];
    let effectKind;
    if (hasDeliveryEffectId) {
      deliveryEffect = projection.outbox[
        portableRef(payload.delivery_effect_id, "event.payload.delivery_effect_id")
      ];
      effectKind = enumeration(payload.effect_kind, [
        "provider.thread.create",
        "provider.turn.start",
        "provider.user_input.submit",
        "provider.turn.cancel",
      ], "event.payload.effect_kind");
    } else {
      if (!["branch.dispatch.accepted", "branch.dispatch.not_sent", "branch.delivery_unknown"]
        .includes(observation.name)) {
        fail(
          "BUSINESS_PROJECTION_OUTBOX_BINDING",
          "A V2 provider delivery observation must identify its exact effect and stage",
        );
      }
      if (workOrderEngineContractVersion(workOrder) === 2) {
        fail(
          "BUSINESS_PROJECTION_OUTBOX_BINDING",
          "An unannotated legacy delivery cannot cross a V2 provider stage",
        );
      }
      const legacyMatches = Object.values(projection.outbox).filter((candidate) => (
        candidate.effect_contract_version === undefined
          && candidate.work_order_id === workOrder.work_order_id
          && candidate.branch_ref === branch.branch_ref
          && candidate.attempt === branch.attempt
          && candidate.dispatch_id === branch.dispatch_id
          && candidate.provider_ref === branch.provider_ref
          && candidate.effect_kind === "provider.turn.start"
          && candidate.status === expectedStatus
          && candidate.delivery
          && candidate.delivery.classification === deliveryClassification
          && (candidate.delivery.recorded_at === payload.occurred_at
            || (deliveryClassification === "delivery_unknown"
              && Date.parse(candidate.delivery.recorded_at) <= Date.parse(payload.occurred_at)))
          && same(candidate.delivery.runtime_identity, runtimeIdentity)
      ));
      if (legacyMatches.length !== 1) {
        fail(
          "BUSINESS_PROJECTION_OUTBOX_BINDING",
          "A legacy delivery event must resolve one exact historical V1 effect",
        );
      }
      [deliveryEffect] = legacyMatches;
      effectKind = deliveryEffect.effect_kind;
      legacyDelivery = true;
    }
    if (!deliveryEffect
        || deliveryEffect.effect_kind !== effectKind
        || deliveryEffect.status !== expectedStatus
        || deliveryEffect.branch_ref !== branch.branch_ref
        || deliveryEffect.attempt !== branch.attempt
        || deliveryEffect.dispatch_id !== branch.dispatch_id
        || !deliveryEffect.delivery
        || deliveryEffect.delivery.classification !== deliveryClassification
        || (deliveryEffect.delivery.recorded_at !== payload.occurred_at
          && !(legacyDelivery
            && deliveryClassification === "delivery_unknown"
            && Date.parse(deliveryEffect.delivery.recorded_at) <= Date.parse(payload.occurred_at)))
        || !same(deliveryEffect.delivery.runtime_identity, runtimeIdentity)) {
      fail(
        "BUSINESS_PROJECTION_OUTBOX_BINDING",
        "The runtime observation does not bind the exact settled provider effect",
      );
    }
    if ([
      "provider.effect.delivery.recorded",
      EFFECT_SETTLEMENT_OBSERVATION_NAME,
      EFFECT_SEND_EXPIRY_OBSERVATION_NAME,
      EFFECT_PRESEND_FAILURE_OBSERVATION_NAME,
    ]
      .includes(observation.name)) {
      if (observation.payload.effect_id !== deliveryEffect.effect_id
          || observation.payload.effect_contract_version !== deliveryEffect.effect_contract_version
          || observation.payload.effect_kind !== deliveryEffect.effect_kind
          || (![EFFECT_SEND_EXPIRY_OBSERVATION_NAME, EFFECT_PRESEND_FAILURE_OBSERVATION_NAME]
            .includes(observation.name)
            && observation.payload.classification !== deliveryClassification)) {
        fail(
          "BUSINESS_PROJECTION_OUTBOX_BINDING",
          "The V2 delivery payload does not bind the exact provider effect",
        );
      }
    } else if (deliveryEffect.effect_kind !== "provider.turn.start") {
      fail(
        "BUSINESS_PROJECTION_OUTBOX_BINDING",
        "Legacy branch.dispatch observations are aliases only for final turn start delivery",
      );
    }
    deliveryHash = canonicalHash({
      effect: Object.fromEntries(
        (legacyDelivery ? LEGACY_OUTBOX_IMMUTABLE_FIELDS : OUTBOX_IMMUTABLE_FIELDS)
          .map((field) => [field, deliveryEffect[field]]),
      ),
      ...deliveryEffect.delivery,
    });
    if (!legacyDelivery && deliveryEffect.effect_kind === "provider.thread.create"
        && (branch.thread_create_effect_id !== null || branch.thread_identity !== null)) {
      fail(
        "BUSINESS_PROJECTION_OUTBOX_BINDING",
        "Thread creation delivery is not the current provider stage",
      );
    }
    if (!legacyDelivery && deliveryEffect.effect_kind === "provider.turn.start"
        && (branch.turn_start_effect_id !== null
          || deliveryEffect.predecessor_effect_id !== branch.thread_create_effect_id
          || deliveryEffect.predecessor_delivery_hash !== branch.thread_create_delivery_hash
          || !same(deliveryEffect.target_runtime_identity, branch.thread_identity))) {
      fail(
        "BUSINESS_PROJECTION_OUTBOX_BINDING",
        "Turn start delivery is not bound to the current thread stage",
      );
    }
    if (deliveryEffect.effect_kind === "provider.user_input.submit"
        && branch.pending_user_input_effect_id !== deliveryEffect.effect_id) {
      fail(
        "BUSINESS_PROJECTION_OUTBOX_BINDING",
        "User-input delivery is not the current pending submission",
      );
    }
    if (deliveryEffect.effect_kind === "provider.turn.cancel"
        && (branch.state !== "cancelling"
          || (branch.cancel_effect_id !== deliveryEffect.effect_id
            && !(deliveryClassification === "not_sent"
              && branch.cancel_effect_id === null))
          || !same(deliveryEffect.target_runtime_identity, branch.runtime_identity))) {
      fail(
        "BUSINESS_PROJECTION_OUTBOX_BINDING",
        "Cancel delivery is not bound to the current cancelling turn",
      );
    }
  } else if (Object.hasOwn(payload, "delivery_effect_id") || Object.hasOwn(payload, "effect_kind")) {
    fail(
      "BUSINESS_PROJECTION_OUTBOX_BINDING",
      "Only a provider delivery observation may carry effect stage annotations",
    );
  }
  if (TURN_BOUND_OBSERVATIONS.has(observation.name)) {
    const hasActiveEffect = Object.hasOwn(payload, "active_turn_effect_id");
    const hasActiveIdentity = Object.hasOwn(payload, "active_runtime_identity");
    if (hasActiveEffect !== hasActiveIdentity) {
      fail(
        "BUSINESS_PROJECTION_OUTBOX_BINDING",
        "A current-turn binding must carry both the effect and runtime identity",
      );
    }
    if (hasActiveEffect) {
      const activeTurnEffectId = portableRef(
        payload.active_turn_effect_id,
        "event.payload.active_turn_effect_id",
      );
      const activeRuntimeIdentity = normalizeRuntimeIdentity(
        payload.active_runtime_identity,
        "event.payload.active_runtime_identity",
      );
      const activeTurn = projection.outbox[activeTurnEffectId];
      if (!activeTurn
          || activeTurn.effect_contract_version !== 2
          || activeTurn.effect_kind !== "provider.turn.start"
          || activeTurn.status !== "delivered"
          || activeTurn.effect_id !== branch.turn_start_effect_id
          || activeTurn.branch_ref !== branch.branch_ref
          || activeTurn.attempt !== branch.attempt
          || activeTurn.dispatch_id !== branch.dispatch_id
          || !same(activeRuntimeIdentity, branch.runtime_identity)
          || !same(activeRuntimeIdentity, activeTurn.delivery?.runtime_identity)) {
        fail(
          "BUSINESS_PROJECTION_OUTBOX_BINDING",
          "The runtime fact is not bound to the exact accepted current turn",
        );
      }
    } else {
      if (workOrderEngineContractVersion(workOrder) === 2) {
        fail(
          "BUSINESS_PROJECTION_OUTBOX_BINDING",
          "An unannotated legacy runtime fact cannot cross a V2 provider stage",
        );
      }
      const legacyTurns = Object.values(projection.outbox).filter((candidate) => (
        candidate.effect_contract_version === undefined
          && candidate.work_order_id === workOrder.work_order_id
          && candidate.branch_ref === branch.branch_ref
          && candidate.attempt === branch.attempt
          && candidate.dispatch_id === branch.dispatch_id
          && candidate.provider_ref === branch.provider_ref
          && candidate.effect_kind === "provider.turn.start"
          && candidate.status === "delivered"
          && same(candidate.delivery?.runtime_identity, branch.runtime_identity)
      ));
      if (legacyTurns.length !== 1) {
        fail(
          "BUSINESS_PROJECTION_OUTBOX_BINDING",
          "An unannotated historical runtime fact must resolve one exact legacy V1 turn",
        );
      }
    }
  } else if (Object.hasOwn(payload, "active_turn_effect_id")
      || Object.hasOwn(payload, "active_runtime_identity")) {
    fail(
      "BUSINESS_PROJECTION_OUTBOX_BINDING",
      "This runtime observation cannot carry a current-turn binding",
    );
  }
  if (observation.name === "branch.timed_out"
      && (!branch.attempt_deadline_at
        || Date.parse(payload.occurred_at) < Date.parse(branch.attempt_deadline_at))) {
    fail(
      "BUSINESS_PROJECTION_TRANSITION",
      "An attempt timeout cannot be recorded before its immutable deadline",
    );
  }
  let nextBranch = { ...branch, last_runtime_observation: observation };
  if (deliveryClassification === "accepted") {
    if (legacyDelivery) {
      nextBranch.delivery = { classification: "accepted", observed_at: payload.occurred_at };
      nextBranch.runtime_identity = runtimeIdentity;
    } else if (deliveryEffect.effect_kind === "provider.thread.create") {
      if (!runtimeIdentity
          || runtimeIdentity.thread_id === null
          || runtimeIdentity.turn_id !== null
          || branch.thread_create_effect_id !== null
          || branch.thread_identity !== null) {
        fail(
          "BUSINESS_PROJECTION_OUTBOX_BINDING",
          "Thread creation must persist one exact thread-only identity",
        );
      }
      // Thread creation resolves only the first provider stage. Clear the
      // stage-local ambiguity before the branch advances to pending turn start.
      nextBranch.delivery = null;
      nextBranch.thread_identity = runtimeIdentity;
      nextBranch.thread_create_effect_id = deliveryEffect.effect_id;
      nextBranch.thread_create_delivery_hash = deliveryHash;
    } else if (deliveryEffect.effect_kind === "provider.turn.start") {
      if (!runtimeIdentity
          || runtimeIdentity.thread_id === null
          || runtimeIdentity.turn_id === null
          || !same(deliveryEffect.target_runtime_identity, branch.thread_identity)
          || runtimeIdentity.thread_id !== branch.thread_identity.thread_id
          || deliveryEffect.predecessor_effect_id !== branch.thread_create_effect_id
          || deliveryEffect.predecessor_delivery_hash !== branch.thread_create_delivery_hash) {
        fail(
          "BUSINESS_PROJECTION_OUTBOX_BINDING",
          "Turn start must persist a turn on the exact accepted thread predecessor",
        );
      }
      nextBranch.delivery = { classification: "accepted", observed_at: payload.occurred_at };
      nextBranch.runtime_identity = runtimeIdentity;
      nextBranch.turn_start_effect_id = deliveryEffect.effect_id;
      nextBranch.turn_start_delivery_hash = deliveryHash;
    } else if (deliveryEffect.effect_kind === "provider.user_input.submit") {
      if (!["waiting_for_user", "cancelling"].includes(branch.state)
          || branch.pending_user_input_effect_id !== deliveryEffect.effect_id
          || branch.pending_user_input_response_ref === null
          || !runtimeIdentity
          || !same(runtimeIdentity, branch.runtime_identity)
          || !same(runtimeIdentity, deliveryEffect.target_runtime_identity)
          || !branch.open_user_input) {
        fail(
          "BUSINESS_PROJECTION_OUTBOX_BINDING",
          "User-input delivery must bind the one pending current request",
        );
      }
      if (branch.state === "cancelling") {
        nextBranch.pending_user_input_effect_id = null;
        nextBranch.pending_user_input_response_ref = null;
        nextBranch.open_user_input = null;
      }
    } else if (deliveryEffect.effect_kind === "provider.turn.cancel") {
      if (branch.state !== "cancelling"
          || !runtimeIdentity
          || !same(runtimeIdentity, branch.runtime_identity)
          || !same(runtimeIdentity, deliveryEffect.delivery.runtime_identity)
          || !same(deliveryEffect.target_runtime_identity, branch.runtime_identity)) {
        fail(
          "BUSINESS_PROJECTION_OUTBOX_BINDING",
          "Cancel delivery must bind the exact current cancelling turn",
        );
      }
    }
  } else if (deliveryClassification === "not_sent") {
    if (["provider.thread.create", "provider.turn.start"].includes(deliveryEffect.effect_kind)) {
      nextBranch.delivery = { classification: "not_sent", observed_at: payload.occurred_at };
    } else if (deliveryEffect.effect_kind === "provider.user_input.submit") {
      if (branch.pending_user_input_effect_id !== deliveryEffect.effect_id
          || branch.pending_user_input_response_ref === null) {
        fail(
          "BUSINESS_PROJECTION_OUTBOX_BINDING",
          "Not-sent user input does not bind the pending submission",
        );
      }
      nextBranch.pending_user_input_effect_id = null;
      nextBranch.pending_user_input_response_ref = null;
      if (branch.state === "cancelling") nextBranch.open_user_input = null;
    }
  } else if (deliveryClassification === "delivery_unknown") {
    if (["provider.thread.create", "provider.turn.start"].includes(deliveryEffect.effect_kind)) {
      nextBranch.delivery = { classification: "delivery_unknown", observed_at: payload.occurred_at };
    }
  } else if (observation.name === "branch.progress") {
    nextBranch.last_progress_at = payload.occurred_at;
  } else if (observation.name === "branch.result.submitted") {
    nextBranch.result = {
      attempt: branch.attempt,
      artifact_refs: observation.payload.artifact_refs,
      evidence_refs: observation.payload.evidence_refs,
      submitted_at: payload.occurred_at,
    };
  } else if (observation.name === "user_input.requested") {
    nextBranch.open_user_input = {
      request_id: observation.payload.request_id,
      prompt_ref: observation.payload.prompt_ref,
      requested_at: payload.occurred_at,
    };
  } else if (observation.name === "branch.cancelled") {
    nextBranch.runtime_identity = runtimeIdentity || branch.runtime_identity;
    nextBranch.cancel_effect_id = null;
  }
  return replaceWorkOrder(projection, {
    ...workOrder,
    branches: withMapEntry(workOrder.branches, branch.branch_ref, nextBranch),
  });
}

function reduceVerification(projection, event) {
  const payload = requireSpecificFields(event, ["observation", "result_hash"]);
  const workOrder = requireWorkOrder(projection, event);
  const observation = normalizeObservationFromEvent(payload.observation, event);
  if (observation.name !== "verification.recorded") {
    fail("BUSINESS_PROJECTION_INVALID", "A verification event must retain a verification observation");
  }
  const branch = requireBranch(workOrder, observation.payload.branch_ref);
  if (!branch.result
      || branch.state !== "verifying"
      || canonicalHash(branch.result) !== sha256(payload.result_hash, "event.payload.result_hash")) {
    fail("BUSINESS_PROJECTION_TRANSITION", "Verification requires a submitted current result");
  }
  const criterion = workOrder.plan.acceptance_policy.criteria.find(
    (entry) => entry.criterion_id === observation.payload.criterion_id,
  );
  if (!branch.required_criterion_ids.includes(observation.payload.criterion_id)) {
    fail("BUSINESS_PROJECTION_PLAN_BINDING", "Verification criterion is not assigned to this branch");
  }
  const requirement = criterion && criterion.verification_requirements.find(
    (entry) => entry.verification_ref.id === observation.payload.verification_ref.id,
  );
  if (!requirement
    || requirement.kind !== observation.payload.kind
    || !same(requirement.verification_ref, observation.payload.verification_ref)) {
    fail("BUSINESS_PROJECTION_PLAN_BINDING", "Verification does not match an immutable plan requirement");
  }
  if (observation.payload.kind === "human"
      && workOrder.plan.branches.some(
        (plannedBranch) => plannedBranch.assignee_ref === observation.actor.actor_id,
      )) {
    fail("BUSINESS_PROJECTION_PLAN_BINDING", "Human verification must be independent of all assignees");
  }
  const byCriterion = branch.verification_by_criterion[criterion.criterion_id] || {};
  const key = requirement.verification_ref.id;
  const record = {
    criterion_id: criterion.criterion_id,
    verification_ref: requirement.verification_ref,
    kind: observation.payload.kind,
    status: observation.payload.status,
    evidence_refs: observation.payload.evidence_refs,
    verifier_ref: observation.actor.actor_id,
    recorded_at: payload.occurred_at,
  };
  const existing = byCriterion[key];
  if (existing && !same(existing, record)) {
    fail("BUSINESS_PROJECTION_ID_CONFLICT", "A verification identifier was reused with conflicting content", {
      verification_ref: key,
    });
  }
  const nextBranch = {
    ...branch,
    verification_by_criterion: withMapEntry(
      branch.verification_by_criterion,
      criterion.criterion_id,
      withMapEntry(byCriterion, key, record),
    ),
  };
  return replaceWorkOrder(projection, {
    ...workOrder,
    branches: withMapEntry(workOrder.branches, branch.branch_ref, nextBranch),
  });
}

function reduceReview(projection, event) {
  const payload = requireSpecificFields(event, ["observation", "result_hash"]);
  const workOrder = requireWorkOrder(projection, event);
  const observation = normalizeObservationFromEvent(payload.observation, event);
  if (observation.name !== "review.recorded") {
    fail("BUSINESS_PROJECTION_INVALID", "A review event must retain a review observation");
  }
  const branch = requireBranch(workOrder, observation.payload.branch_ref);
  if (!branch.result
      || !["verifying", "accepted"].includes(branch.state)
      || canonicalHash(branch.result) !== sha256(payload.result_hash, "event.payload.result_hash")) {
    fail("BUSINESS_PROJECTION_TRANSITION", "Review requires a submitted final-branch result");
  }
  const finalBranchRef = workOrder.plan.integration_branch_ref || workOrder.plan.branches[0].branch_ref;
  if (branch.branch_ref !== finalBranchRef
      || workOrder.plan.branches.some(
        (plannedBranch) => plannedBranch.assignee_ref === observation.actor.actor_id,
      )) {
    fail("BUSINESS_PROJECTION_PLAN_BINDING", "Review must be independent and target the final result branch");
  }
  const record = {
    review_id: observation.payload.review_id,
    branch_ref: branch.branch_ref,
    result_hash: sha256(payload.result_hash, "event.payload.result_hash"),
    status: observation.payload.status,
    findings: observation.payload.findings,
    evidence_refs: observation.payload.evidence_refs,
    reviewer_ref: observation.actor.actor_id,
    recorded_at: payload.occurred_at,
  };
  const existing = workOrder.acceptance.reviews[record.review_id];
  if (existing && !same(existing, record)) {
    fail("BUSINESS_PROJECTION_ID_CONFLICT", "A review identifier was reused with conflicting content", {
      review_id: record.review_id,
    });
  }
  return replaceWorkOrder(projection, {
    ...workOrder,
    acceptance: {
      ...workOrder.acceptance,
      reviews: withMapEntry(workOrder.acceptance.reviews, record.review_id, record),
    },
  });
}

function normalizeAcceptanceRecord(value, event) {
  const record = exact(
    value,
    new Set(["decision", "evidence_refs", "comment", "decided_by", "decided_at"]),
    new Set(["decision", "evidence_refs", "comment", "decided_by", "decided_at"]),
    "event.payload.record",
  );
  const decidedAt = timestamp(record.decided_at, "event.payload.record.decided_at");
  if (decidedAt !== event.payload.occurred_at) {
    fail("BUSINESS_PROJECTION_INVALID", "Acceptance decision time must equal the event time");
  }
  return {
    decision: enumeration(record.decision, ["accepted", "rejected"], "event.payload.record.decision"),
    evidence_refs: stringArray(record.evidence_refs, "event.payload.record.evidence_refs", { minimum: 1 }),
    comment: text(record.comment, "event.payload.record.comment", 8_192),
    decided_by: portableRef(record.decided_by, "event.payload.record.decided_by"),
    decided_at: decidedAt,
  };
}

function reduceAcceptance(projection, event) {
  const payload = requireSpecificFields(event, ["record"]);
  const workOrder = requireWorkOrder(projection, event);
  if (workOrder.status !== "awaiting_acceptance") {
    fail("BUSINESS_PROJECTION_TRANSITION", "Acceptance can only be recorded while awaiting acceptance");
  }
  const record = normalizeAcceptanceRecord(payload.record, event);
  if (workOrder.acceptance.decision?.decision === "accepted") {
    fail("BUSINESS_PROJECTION_ID_CONFLICT", "An accepted decision cannot be replaced");
  }
  const history = Array.isArray(workOrder.acceptance.decision_history)
    ? workOrder.acceptance.decision_history
    : [];
  if (history.some((entry) => entry.source_id === payload.source_id)) {
    fail("BUSINESS_PROJECTION_ID_CONFLICT", "An acceptance decision source was reused");
  }
  const historyEntry = {
    ...record,
    source_id: payload.source_id,
    applied_revision: payload.target_work_order_revision,
  };
  return replaceWorkOrder(projection, {
    ...workOrder,
    acceptance: {
      ...workOrder.acceptance,
      decision: record,
      decision_history: [...history, historyEntry],
    },
  });
}

function normalizeLateObservation(value, event) {
  const record = exact(
    value,
    new Set(["observation", "reason", "artifact_refs", "evidence_refs"]),
    new Set(["observation", "reason", "artifact_refs", "evidence_refs"]),
    "event.payload.record",
  );
  const observation = normalizeObservationFromEvent(record.observation, event);
  return {
    observation,
    reason: portableRef(record.reason, "event.payload.record.reason"),
    artifact_refs: (() => {
      if (!Array.isArray(record.artifact_refs)
        || record.artifact_refs.length > CONTRACT_LIMITS.max_evidence_refs) {
        fail("BUSINESS_PROJECTION_LIMIT", "event.payload.record.artifact_refs contains too many values");
      }
      return record.artifact_refs.map(
        (entry, index) => contentRef(entry, `event.payload.record.artifact_refs[${index}]`),
      );
    })(),
    evidence_refs: stringArray(record.evidence_refs, "event.payload.record.evidence_refs", { minimum: 1 }),
    quarantined_at: event.payload.occurred_at,
  };
}

function reduceLateObservation(projection, event) {
  const payload = requireSpecificFields(event, ["record"]);
  const record = normalizeLateObservation(payload.record, event);
  const id = record.observation.observation_id;
  const existing = projection.late_observations[id];
  if (existing) {
    if (same(existing, record)) return projection;
    fail("BUSINESS_PROJECTION_ID_CONFLICT", "A quarantined observation identifier was reused", {
      observation_id: id,
    });
  }
  return { ...projection, late_observations: withMapEntry(projection.late_observations, id, record) };
}

function effectSeed(effect) {
  return {
    effect_contract_version: effect.effect_contract_version,
    work_order_id: effect.work_order_id,
    branch_ref: effect.branch_ref,
    attempt: effect.attempt,
    dispatch_id: effect.dispatch_id,
    effect_kind: effect.effect_kind,
    origin_source_id: effect.origin_source_id,
    operation_scope_hash: effect.operation_scope_hash,
    operation_generation: effect.operation_generation,
    generation_predecessor_effect_id: effect.generation_predecessor_effect_id,
    provider_ref: effect.provider_ref,
    packet_ref: effect.packet_ref,
    packet_hash: effect.packet_hash,
    predecessor_effect_id: effect.predecessor_effect_id,
    predecessor_delivery_hash: effect.predecessor_delivery_hash,
    target_runtime_identity: effect.target_runtime_identity,
  };
}

function deterministicEffectId(prefix, effect) {
  return `${prefix}-${canonicalHash(effectSeed(effect)).slice(0, 32)}`;
}

function normalizeLegacyEffect(value) {
  const legacyFields = new Set([
    ...LEGACY_OUTBOX_IMMUTABLE_FIELDS,
    "status",
    "lease",
    "delivery",
    "updated_at",
  ]);
  const legacy = exact(value, legacyFields, legacyFields, "event.payload.effect");
  return legacy;
}

function normalizeEffect(value, event) {
  const candidate = object(value, "event.payload.effect");
  const v2Fields = new Set([
    ...OUTBOX_IMMUTABLE_FIELDS,
    "status",
    "lease",
    "delivery",
    "updated_at",
  ]);
  const isV2 = Object.hasOwn(candidate, "effect_contract_version");
  const effect = isV2
    ? exact(candidate, v2Fields, v2Fields, "event.payload.effect")
    : normalizeLegacyEffect(candidate);
  if (!isV2) {
    const normalizedLegacy = {
      effect_id: portableRef(effect.effect_id, "event.payload.effect.effect_id"),
      work_order_id: normalizeWorkOrderId(effect.work_order_id, "event.payload.effect.work_order_id"),
      branch_ref: portableRef(effect.branch_ref, "event.payload.effect.branch_ref"),
      attempt: integer(effect.attempt, "event.payload.effect.attempt", 1),
      dispatch_id: portableRef(effect.dispatch_id, "event.payload.effect.dispatch_id"),
      effect_kind: enumeration(effect.effect_kind, [
        "provider.thread.create",
        "provider.turn.start",
        "provider.user_input.submit",
        "provider.turn.cancel",
      ], "event.payload.effect.effect_kind"),
      provider_ref: portableRef(effect.provider_ref, "event.payload.effect.provider_ref"),
      packet_ref: portableRef(effect.packet_ref, "event.payload.effect.packet_ref"),
      packet_hash: sha256(effect.packet_hash, "event.payload.effect.packet_hash"),
      idempotency_key: portableRef(effect.idempotency_key, "event.payload.effect.idempotency_key"),
      status: enumeration(effect.status, ["pending"], "event.payload.effect.status"),
      lease: effect.lease === null
        ? null
        : fail("BUSINESS_PROJECTION_INVALID", "A new outbox effect cannot already be leased"),
      delivery: effect.delivery === null
        ? null
        : fail("BUSINESS_PROJECTION_INVALID", "A new outbox effect cannot already have delivery evidence"),
      lease_generation: 0,
      last_lease_id: null,
      created_at: timestamp(effect.created_at, "event.payload.effect.created_at"),
      updated_at: timestamp(effect.updated_at, "event.payload.effect.updated_at"),
    };
    if (normalizedLegacy.work_order_id !== event.payload.work_order_id
        || normalizedLegacy.created_at !== event.payload.occurred_at
        || normalizedLegacy.updated_at !== event.payload.occurred_at) {
      fail("BUSINESS_PROJECTION_PLAN_BINDING", "The legacy outbox effect does not match its event binding");
    }
    return normalizedLegacy;
  }
  const normalized = {
    effect_id: portableRef(effect.effect_id, "event.payload.effect.effect_id"),
    effect_contract_version: integer(
      effect.effect_contract_version,
      "event.payload.effect.effect_contract_version",
      2,
      2,
    ),
    work_order_id: normalizeWorkOrderId(effect.work_order_id, "event.payload.effect.work_order_id"),
    branch_ref: portableRef(effect.branch_ref, "event.payload.effect.branch_ref"),
    attempt: integer(effect.attempt, "event.payload.effect.attempt", 1),
    dispatch_id: portableRef(effect.dispatch_id, "event.payload.effect.dispatch_id"),
    effect_kind: enumeration(effect.effect_kind, [
      "provider.thread.create",
      "provider.turn.start",
      "provider.user_input.submit",
      "provider.turn.cancel",
    ], "event.payload.effect.effect_kind"),
    origin_source_id: portableRef(
      effect.origin_source_id,
      "event.payload.effect.origin_source_id",
    ),
    operation_scope_hash: sha256(
      effect.operation_scope_hash,
      "event.payload.effect.operation_scope_hash",
    ),
    operation_generation: integer(
      effect.operation_generation,
      "event.payload.effect.operation_generation",
      1,
    ),
    generation_predecessor_effect_id: effect.generation_predecessor_effect_id === null
      ? null
      : portableRef(
        effect.generation_predecessor_effect_id,
        "event.payload.effect.generation_predecessor_effect_id",
      ),
    provider_ref: portableRef(effect.provider_ref, "event.payload.effect.provider_ref"),
    packet_ref: portableRef(effect.packet_ref, "event.payload.effect.packet_ref"),
    packet_hash: sha256(effect.packet_hash, "event.payload.effect.packet_hash"),
    predecessor_effect_id: effect.predecessor_effect_id === null
      ? null
      : portableRef(effect.predecessor_effect_id, "event.payload.effect.predecessor_effect_id"),
    predecessor_delivery_hash: effect.predecessor_delivery_hash === null
      ? null
      : sha256(effect.predecessor_delivery_hash, "event.payload.effect.predecessor_delivery_hash"),
    target_runtime_identity: effect.target_runtime_identity === null
      ? null
      : normalizeRuntimeIdentity(
        effect.target_runtime_identity,
        "event.payload.effect.target_runtime_identity",
      ),
    idempotency_key: portableRef(effect.idempotency_key, "event.payload.effect.idempotency_key"),
    status: enumeration(effect.status, ["pending"], "event.payload.effect.status"),
    lease: effect.lease === null ? null : fail("BUSINESS_PROJECTION_INVALID", "A new outbox effect cannot already be leased"),
    delivery: effect.delivery === null ? null : fail("BUSINESS_PROJECTION_INVALID", "A new outbox effect cannot already have delivery evidence"),
    lease_generation: 0,
    last_lease_id: null,
    // Projector-derived issuance history is authoritative. It is not inferred
    // from the opaque receipt result, and it is retained across requeue so a
    // later callback can prove which historical worker token it actually held.
    fencing_history: [],
    settlement_policy: null,
    created_at: timestamp(effect.created_at, "event.payload.effect.created_at"),
    updated_at: timestamp(effect.updated_at, "event.payload.effect.updated_at"),
  };
  if (normalized.work_order_id !== event.payload.work_order_id
    || normalized.origin_source_id !== event.payload.source_id
    || normalized.created_at !== event.payload.occurred_at
    || normalized.updated_at !== event.payload.occurred_at) {
    fail("BUSINESS_PROJECTION_PLAN_BINDING", "The outbox effect does not match its event binding");
  }
  if ((normalized.predecessor_effect_id === null)
      !== (normalized.predecessor_delivery_hash === null)) {
    fail(
      "BUSINESS_PROJECTION_PLAN_BINDING",
      "An effect predecessor identifier and delivery hash must be present together",
    );
  }
  if ((normalized.operation_generation === 1)
      !== (normalized.generation_predecessor_effect_id === null)) {
    fail(
      "BUSINESS_PROJECTION_PLAN_BINDING",
      "Effect generation 1 must be a root and every successor must name its generation predecessor",
    );
  }
  if (normalized.effect_id !== deterministicEffectId("FX", normalized)
      || normalized.idempotency_key !== deterministicEffectId("IDEM", normalized)) {
    fail(
      "BUSINESS_PROJECTION_PLAN_BINDING",
      "The effect identifiers do not hash the exact immutable V2 effect identity",
    );
  }
  return normalized;
}

function reduceOutboxEnqueued(projection, event) {
  const payload = requireSpecificFields(
    event,
    ["effect", "user_input_response_ref"],
    ["effect"],
  );
  const workOrder = requireWorkOrder(projection, event);
  const effect = normalizeEffect(payload.effect, event);
  assertEffectMatchesEngineContract(workOrder, effect);
  const hasUserInputResponseRef = Object.hasOwn(payload, "user_input_response_ref");
  if (hasUserInputResponseRef !== (effect.effect_kind === "provider.user_input.submit")) {
    if (effect.effect_contract_version !== undefined || hasUserInputResponseRef) {
      fail(
        "BUSINESS_PROJECTION_OUTBOX_BINDING",
        "Only a V2 user-input submission may bind one response content reference",
      );
    }
  }
  const userInputResponseRef = hasUserInputResponseRef
    ? contentRef(payload.user_input_response_ref, "event.payload.user_input_response_ref")
    : null;
  const branch = requireBranch(workOrder, effect.branch_ref);
  if (branch.attempt !== effect.attempt
      || branch.dispatch_id !== effect.dispatch_id
      || branch.provider_ref !== effect.provider_ref
      || !workOrder.plan.provider_policy.allowed_provider_refs.includes(effect.provider_ref)) {
    fail("BUSINESS_PROJECTION_PLAN_BINDING", "The outbox effect does not match the current branch attempt");
  }
  const expectedBranchState = {
    "provider.thread.create": "dispatch_pending",
    "provider.turn.start": "dispatch_pending",
    "provider.user_input.submit": "waiting_for_user",
    "provider.turn.cancel": "cancelling",
  }[effect.effect_kind];
  const startGenerationActivation = effect.effect_contract_version === 2
    && effect.operation_generation > 1
    && ["provider.thread.create", "provider.turn.start"].includes(effect.effect_kind);
  const branchStateAllowed = startGenerationActivation
    ? ["dispatch_pending", "retryable"].includes(branch.state)
    : branch.state === expectedBranchState;
  if (!branchStateAllowed) {
    fail(
      "BUSINESS_PROJECTION_TRANSITION",
      "A new outbox effect does not match the current branch lifecycle",
    );
  }
  if (effect.effect_contract_version === 2
      && effect.effect_kind === "provider.user_input.submit"
      && (!branch.open_user_input || userInputResponseRef === null)) {
    fail(
      "BUSINESS_PROJECTION_PLAN_BINDING",
      "A user-input effect operation scope requires one exact open request and response",
    );
  }
  if (effect.effect_contract_version === 2) {
    const expectedOperationScopeHash = deriveEffectOperationScopeHashV2({
      effect_kind: effect.effect_kind,
      provider_ref: effect.provider_ref,
      packet_ref: effect.packet_ref,
      packet_hash: effect.packet_hash,
      predecessor_effect_id: effect.predecessor_effect_id,
      predecessor_delivery_hash: effect.predecessor_delivery_hash,
      target_runtime_identity: effect.target_runtime_identity,
      request_id: effect.effect_kind === "provider.user_input.submit"
        ? branch.open_user_input?.request_id
        : undefined,
      response_ref: effect.effect_kind === "provider.user_input.submit"
        ? userInputResponseRef
        : undefined,
    });
    if (effect.operation_scope_hash !== expectedOperationScopeHash) {
      fail(
        "BUSINESS_PROJECTION_PLAN_BINDING",
        "The outbox effect operation scope does not bind the exact semantic provider mutation",
        { effect_id: effect.effect_id, effect_kind: effect.effect_kind },
      );
    }
  }
  const generationPredecessor = effect.effect_contract_version === 2
    && effect.operation_generation > 1
    ? projection.outbox[effect.generation_predecessor_effect_id]
    : null;
  if (effect.effect_contract_version === 2 && effect.operation_generation > 1) {
    if (!generationPredecessor
        || generationPredecessor.effect_contract_version !== 2
        || generationPredecessor.status !== "not_sent"
        || generationPredecessor.work_order_id !== effect.work_order_id
        || generationPredecessor.branch_ref !== effect.branch_ref
        || generationPredecessor.attempt !== effect.attempt
        || generationPredecessor.dispatch_id !== effect.dispatch_id
        || generationPredecessor.effect_kind !== effect.effect_kind
        || generationPredecessor.provider_ref !== effect.provider_ref
        || generationPredecessor.operation_scope_hash !== effect.operation_scope_hash
        || generationPredecessor.operation_generation !== effect.operation_generation - 1) {
      fail(
        "BUSINESS_PROJECTION_OUTBOX_BINDING",
        "An Effect generation successor requires the exact proven-not-sent predecessor",
        { effect_id: effect.effect_id },
      );
    }
    if (generationPredecessor.settlement_policy !== null
        && generationPredecessor.settlement_policy !== undefined) {
      const predecessorPolicy = normalizeSettlementPolicyRecordV2(
        generationPredecessor.settlement_policy,
      );
      if (predecessorPolicy.disposition !== "retry_candidate"
          || predecessorPolicy.retry.scope !== "effect_generation") {
        fail(
          "BUSINESS_PROJECTION_SETTLEMENT_POLICY",
          "The predecessor settlement does not authorize an Effect generation",
        );
      }
      const retrySchedule = deriveEffectGenerationRetryScheduleV2({
        settlement_policy: predecessorPolicy,
        retry_policy: {
          backoff_initial_ms: workOrder.plan.retry_policy.backoff_initial_ms,
          backoff_max_ms: workOrder.plan.retry_policy.backoff_max_ms,
          max_attempts: workOrder.plan.retry_policy.max_attempts,
        },
        completed_generation: generationPredecessor.operation_generation,
        settled_at: generationPredecessor.delivery.recorded_at,
        attempt_deadline_at: branch.attempt_deadline_at,
        work_order_deadline_at: workOrder.deadline_at,
      });
      if (!retrySchedule.permitted
          || Date.parse(event.payload.occurred_at) < Date.parse(retrySchedule.eligible_at)) {
        fail(
          "BUSINESS_PROJECTION_TRANSITION",
          "The Effect generation is exhausted or has not reached its durable retry time",
          { eligible_at: retrySchedule.eligible_at },
        );
      }
      const sourceType = workOrder.pending_projection_input?.source_type;
      if (startGenerationActivation && branch.state === "dispatch_pending") {
        if (!["observation", PROVIDER_SETTLEMENT_SOURCE_TYPE].includes(sourceType)
            || predecessorPolicy.retry.mode !== "automatic"
            || retrySchedule.delay_ms !== 0
            || event.payload.occurred_at !== generationPredecessor.delivery.recorded_at) {
          fail(
            "BUSINESS_PROJECTION_SETTLEMENT_POLICY",
            "An in-batch start successor requires an immediate automatic generation policy",
          );
        }
      } else if (sourceType !== "command") {
        fail(
          "BUSINESS_PROJECTION_SOURCE_CLASS",
          "A deferred or explicit Effect generation requires a command input",
        );
      }
      if (startGenerationActivation && branch.state === "retryable"
          && branch.retry_at !== retrySchedule.eligible_at) {
        fail(
          "BUSINESS_PROJECTION_SETTLEMENT_POLICY",
          "A deferred start generation must consume its exact durable retry time",
        );
      }
    }
  }
  if (effect.effect_kind !== "provider.turn.cancel"
      && executionWindowElapsed(workOrder, branch, event.payload.occurred_at)) {
    fail(
      "BUSINESS_PROJECTION_TRANSITION",
      "A forward outbox effect cannot be enqueued after its execution deadline",
    );
  }
  if (["provider.thread.create", "provider.turn.start"].includes(effect.effect_kind)
    && (!branch.packet_ref
      || effect.packet_ref !== branch.packet_ref.id
      || effect.packet_hash !== branch.packet_ref.hash)) {
    fail("BUSINESS_PROJECTION_PLAN_BINDING", "The outbox effect packet does not match the immutable attempt packet");
  }
  if (effect.effect_contract_version === undefined) {
    const existingLegacy = projection.outbox[effect.effect_id];
    if (existingLegacy) {
      if (same(existingLegacy, effect)) return projection;
      fail("BUSINESS_PROJECTION_ID_CONFLICT", "A legacy outbox effect identifier was reused", {
        effect_id: effect.effect_id,
      });
    }
    return { ...projection, outbox: withMapEntry(projection.outbox, effect.effect_id, effect) };
  }
  const predecessor = effect.predecessor_effect_id === null
    ? null
    : projection.outbox[effect.predecessor_effect_id];
  const predecessorHash = predecessor && predecessor.delivery
    ? canonicalHash({
      effect: Object.fromEntries(
        OUTBOX_IMMUTABLE_FIELDS.map((field) => [field, predecessor[field]]),
      ),
      ...predecessor.delivery,
    })
    : null;
  if (effect.effect_kind === "provider.thread.create") {
    if (effect.predecessor_effect_id !== null
        || effect.predecessor_delivery_hash !== null
        || effect.target_runtime_identity !== null
        || branch.thread_identity !== null
        || branch.thread_create_effect_id !== null
        || branch.turn_start_effect_id !== null) {
      fail(
        "BUSINESS_PROJECTION_PLAN_BINDING",
        "Thread creation must be the first exact provider effect of an attempt",
      );
    }
  } else if (effect.effect_kind === "provider.turn.start") {
    if (!predecessor
        || predecessor.effect_kind !== "provider.thread.create"
        || predecessor.status !== "delivered"
        || predecessor.work_order_id !== effect.work_order_id
        || predecessor.branch_ref !== effect.branch_ref
        || predecessor.attempt !== effect.attempt
        || predecessor.dispatch_id !== effect.dispatch_id
        || branch.thread_create_effect_id !== predecessor.effect_id
        || branch.thread_create_delivery_hash !== predecessorHash
        || effect.predecessor_delivery_hash !== predecessorHash
        || !same(effect.target_runtime_identity, branch.thread_identity)
        || branch.turn_start_effect_id !== null) {
      fail(
        "BUSINESS_PROJECTION_PLAN_BINDING",
        "Turn start must bind the exact accepted thread creation and target thread",
      );
    }
  } else {
    if (!predecessor
        || predecessor.effect_kind !== "provider.turn.start"
        || predecessor.status !== "delivered"
        || branch.turn_start_effect_id !== predecessor.effect_id
        || branch.turn_start_delivery_hash !== predecessorHash
        || effect.predecessor_delivery_hash !== predecessorHash
        || !same(effect.target_runtime_identity, branch.runtime_identity)) {
      fail(
        "BUSINESS_PROJECTION_PLAN_BINDING",
        "A turn mutation must bind the exact accepted current turn",
      );
    }
  }
  if (["provider.thread.create", "provider.turn.start"].includes(effect.effect_kind)) {
    const activeStart = Object.values(projection.outbox).filter((candidateEffect) => (
      candidateEffect.work_order_id === effect.work_order_id
        && candidateEffect.branch_ref === effect.branch_ref
        && candidateEffect.attempt === effect.attempt
        && candidateEffect.dispatch_id === effect.dispatch_id
        && ["provider.thread.create", "provider.turn.start"].includes(candidateEffect.effect_kind)
        && ["pending", "claimed", "sending", "delivery_unknown"].includes(candidateEffect.status)
    ));
    if (activeStart.length !== 0) {
      fail(
        "BUSINESS_PROJECTION_TRANSITION",
        "Only one nonterminal provider start stage may exist for an attempt",
      );
    }
  }
  if (effect.effect_kind === "provider.turn.cancel") {
    const activeCancel = Object.values(projection.outbox).filter((candidateEffect) => (
      candidateEffect.effect_contract_version === 2
        && effectMatchesCurrentAttempt(candidateEffect, workOrder, branch)
        && candidateEffect.effect_kind === "provider.turn.cancel"
        && ACTIVE_CANCEL_EFFECT_STATES.has(candidateEffect.status)
    ));
    if (branch.cancel_effect_id !== null || activeCancel.length !== 0) {
      fail(
        "BUSINESS_PROJECTION_TRANSITION",
        "Only one current V2 cancellation effect may remain active for an attempt",
      );
    }
  }
  const existing = projection.outbox[effect.effect_id];
  if (existing) {
    if (same(existing, effect)) return projection;
    fail("BUSINESS_PROJECTION_ID_CONFLICT", "An outbox effect identifier was reused with conflicting content", {
      effect_id: effect.effect_id,
    });
  }
  let next = { ...projection, outbox: withMapEntry(projection.outbox, effect.effect_id, effect) };
  if (startGenerationActivation) {
    next = replaceWorkOrder(next, {
      ...workOrder,
      branches: withMapEntry(workOrder.branches, branch.branch_ref, {
        ...branch,
        state: "dispatch_pending",
        retry_at: null,
        delivery: null,
        finished_at: null,
        last_transition_reason: "effect_generation_activated",
      }),
    });
  }
  if (effect.effect_kind === "provider.user_input.submit") {
    if (branch.pending_user_input_effect_id !== null) {
      fail(
        "BUSINESS_PROJECTION_TRANSITION",
        "Only one user-input submission may be active for the current request",
      );
    }
    next = replaceWorkOrder(next, {
      ...workOrder,
      branches: withMapEntry(workOrder.branches, branch.branch_ref, {
        ...branch,
        pending_user_input_effect_id: effect.effect_id,
        pending_user_input_response_ref: userInputResponseRef,
      }),
    });
  } else if (effect.effect_kind === "provider.turn.cancel") {
    next = replaceWorkOrder(next, {
      ...workOrder,
      branches: withMapEntry(workOrder.branches, branch.branch_ref, {
        ...branch,
        cancel_effect_id: effect.effect_id,
      }),
    });
  }
  return next;
}

function normalizeLease(value, path) {
  const lease = exact(
    value,
    new Set(["lease_id", "owner_id", "generation", "claimed_at", "heartbeat_at", "expires_at"]),
    new Set(["lease_id", "owner_id", "generation", "claimed_at", "heartbeat_at", "expires_at"]),
    path,
  );
  const normalized = {
    lease_id: portableRef(lease.lease_id, `${path}.lease_id`),
    owner_id: portableRef(lease.owner_id, `${path}.owner_id`),
    generation: integer(lease.generation, `${path}.generation`, 1),
    claimed_at: timestamp(lease.claimed_at, `${path}.claimed_at`),
    heartbeat_at: timestamp(lease.heartbeat_at, `${path}.heartbeat_at`),
    expires_at: timestamp(lease.expires_at, `${path}.expires_at`),
  };
  if (Date.parse(normalized.claimed_at) > Date.parse(normalized.heartbeat_at)
    || Date.parse(normalized.heartbeat_at) >= Date.parse(normalized.expires_at)) {
    fail("BUSINESS_PROJECTION_INVALID", `${path} has an invalid time window`, { path });
  }
  return normalized;
}

function expectedLeaseExpiry(workOrder, occurredAt) {
  const duration = workOrder.plan.lease_policy.lease_duration_ms;
  return new Date(Date.parse(occurredAt) + duration).toISOString();
}

function immutableEffectMatches(current, candidate) {
  const fields = current.effect_contract_version === 2
    ? OUTBOX_IMMUTABLE_FIELDS
    : LEGACY_OUTBOX_IMMUTABLE_FIELDS;
  for (const field of fields) {
    if (!Object.hasOwn(candidate, field) || !same(current[field], candidate[field])) return false;
  }
  return true;
}

function requireOutboxEffect(projection, event, payload) {
  const effectId = portableRef(payload.effect_id, "event.payload.effect_id");
  const effect = projection.outbox[effectId];
  if (!effect) fail("BUSINESS_PROJECTION_OUTBOX_MISSING", "The outbox effect does not exist", { effect_id: effectId });
  if (effect.work_order_id !== event.payload.work_order_id) {
    fail(
      "BUSINESS_PROJECTION_OUTBOX_BINDING",
      "An outbox update cannot cross its immutable Work Order boundary",
      { effect_id: effectId, effect_work_order_id: effect.work_order_id },
    );
  }
  assertEffectMatchesEngineContract(requireWorkOrder(projection, event), effect);
  const identityFields = new Set(effect.effect_contract_version === 2
    ? OUTBOX_IMMUTABLE_FIELDS
    : LEGACY_OUTBOX_IMMUTABLE_FIELDS);
  const candidate = exact(
    payload.effect,
    identityFields,
    identityFields,
    "event.payload.effect",
  );
  if (!immutableEffectMatches(effect, candidate)) {
    fail("BUSINESS_PROJECTION_OUTBOX_IMMUTABLE", "An outbox update attempted to mutate immutable request data", {
      effect_id: effectId,
    });
  }
  return effect;
}

function assertOutboxWorkerActionEligible(projection, event, effect) {
  const workOrder = requireWorkOrder(projection, event);
  assertEffectMatchesEngineContract(workOrder, effect);
  assertWorkOrderEffectContracts(projection, workOrder);
  const branch = requireBranch(workOrder, effect.branch_ref);
  if (effect.work_order_id !== workOrder.work_order_id
      || effect.attempt !== branch.attempt
      || effect.dispatch_id !== branch.dispatch_id
      || effect.provider_ref !== branch.provider_ref) {
    fail(
      "BUSINESS_PROJECTION_OUTBOX_BINDING",
      "The outbox effect no longer binds the current branch attempt",
      { effect_id: effect.effect_id, branch_ref: effect.branch_ref },
    );
  }

  if (["provider.thread.create", "provider.turn.start"].includes(effect.effect_kind)) {
    if (branch.state !== "dispatch_pending"
        || !["starting", "running"].includes(workOrder.status)) {
      fail(
        "BUSINESS_PROJECTION_TRANSITION",
        "A start effect requires a current pending branch in a runnable Work Order",
      );
    }
    if (effect.effect_contract_version === 2
        && ((effect.effect_kind === "provider.thread.create"
          && (branch.thread_create_effect_id !== null || branch.thread_identity !== null))
        || (effect.effect_kind === "provider.turn.start"
          && (effect.predecessor_effect_id !== branch.thread_create_effect_id
            || effect.predecessor_delivery_hash !== branch.thread_create_delivery_hash
            || !same(effect.target_runtime_identity, branch.thread_identity)
            || branch.turn_start_effect_id !== null)))) {
      fail(
        "BUSINESS_PROJECTION_OUTBOX_BINDING",
        "The start effect is not the one current V2 provider stage",
      );
    }
  } else if (effect.effect_kind === "provider.user_input.submit") {
    const eligible = effect.effect_contract_version === undefined
      ? branch.state === "running" && workOrder.status === "running"
      : branch.state === "waiting_for_user"
        && workOrder.status === "running"
        && branch.pending_user_input_effect_id === effect.effect_id;
    if (!eligible) {
      fail(
        "BUSINESS_PROJECTION_TRANSITION",
        "A user-input effect requires the one current waiting submission",
      );
    }
  } else if (effect.effect_kind === "provider.turn.cancel") {
    if (branch.state !== "cancelling"
        || (effect.effect_contract_version === 2
          && (!same(effect.target_runtime_identity, branch.runtime_identity)
            || effect.predecessor_effect_id !== branch.turn_start_effect_id
            || effect.predecessor_delivery_hash !== branch.turn_start_delivery_hash))) {
      fail(
        "BUSINESS_PROJECTION_TRANSITION",
        "A cancel effect requires the exact current cancelling branch",
      );
    }
    return;
  } else {
    fail("BUSINESS_PROJECTION_INVALID", "The outbox effect kind is not executable");
  }

  if (!branch.attempt_deadline_at
      || Date.parse(event.payload.occurred_at) >= Date.parse(branch.attempt_deadline_at)
      || Date.parse(event.payload.occurred_at) >= Date.parse(workOrder.deadline_at)) {
    fail(
      "BUSINESS_PROJECTION_TRANSITION",
      "A forward effect cannot start or renew after its attempt or Work Order deadline",
    );
  }
}

function transitionOutbox(projection, event, to, mutate, allowedSpecific, requiredSpecific) {
  const payload = requireSpecificFields(
    event,
    allowedSpecific,
    requiredSpecific.includes("effect") ? requiredSpecific : [...requiredSpecific, "effect"],
  );
  const effect = requireOutboxEffect(projection, event, payload);
  if (!OUTBOX_TRANSITIONS[effect.status] || !OUTBOX_TRANSITIONS[effect.status].has(to)) {
    fail("BUSINESS_PROJECTION_TRANSITION", `Illegal outbox transition: ${effect.status} -> ${to}`, {
      effect_id: effect.effect_id,
    });
  }
  if (Date.parse(payload.occurred_at) < Date.parse(effect.updated_at)) {
    fail("BUSINESS_PROJECTION_TRANSITION", "An outbox transition cannot move its durable time backwards");
  }
  const next = mutate(
    { ...effect, status: to, updated_at: payload.occurred_at },
    payload,
    effect,
  );
  if (!immutableEffectMatches(effect, next)) {
    fail("BUSINESS_PROJECTION_OUTBOX_IMMUTABLE", "An outbox transition mutated immutable request data", {
      effect_id: effect.effect_id,
    });
  }
  return { ...projection, outbox: withMapEntry(projection.outbox, effect.effect_id, next) };
}

function reduceOutboxClaimed(projection, event) {
  const payload = requireSpecificFields(event, ["effect_id", "lease", "effect"]);
  const workOrder = requireWorkOrder(projection, event);
  assertOutboxWorkerActionEligible(
    projection,
    event,
    requireOutboxEffect(projection, event, payload),
  );
  return transitionOutbox(
    projection,
    event,
    "claimed",
    (effect, payload) => {
      const lease = normalizeLease(payload.lease, "event.payload.lease");
      if (lease.generation !== effect.lease_generation + 1
          || lease.claimed_at !== payload.occurred_at
          || lease.heartbeat_at !== payload.occurred_at
          || lease.expires_at !== expectedLeaseExpiry(workOrder, payload.occurred_at)) {
        fail(
          "BUSINESS_PROJECTION_TRANSITION",
          "A claim must advance one generation and use the plan-bound lease window",
        );
      }
      return {
        ...effect,
        lease,
        lease_generation: lease.generation,
        last_lease_id: lease.lease_id,
        ...(effect.effect_contract_version === 2
          ? {
            fencing_history: (() => {
              if (!Array.isArray(effect.fencing_history)
                  || effect.fencing_history.length !== effect.lease_generation) {
                fail(
                  "BUSINESS_PROJECTION_TRANSITION",
                  "A V2 claim requires contiguous projector-derived fencing history",
                );
              }
              return [...effect.fencing_history, {
                lease_id: lease.lease_id,
                owner_id: lease.owner_id,
                generation: lease.generation,
              }];
            })(),
          }
          : {}),
      };
    },
    ["effect_id", "lease", "effect"],
    ["effect_id", "lease", "effect"],
  );
}

function reduceOutboxSendBegun(projection, event) {
  const authorizationFields = [
    "send_authorization_contract_version",
    "lease_expires_at",
    "provider_settlement_cutover_id",
    "operation_scope_binding",
  ];
  const payload = requireSpecificFields(
    event,
    [
      "effect_id",
      "lease_id",
      "lease_owner_id",
      "lease_generation",
      "effect",
      "packet_verification_receipt",
      ...authorizationFields,
    ],
    ["effect_id", "lease_id", "lease_owner_id", "lease_generation", "effect"],
  );
  const currentEffect = requireOutboxEffect(projection, event, payload);
  const currentEffectIdentity = Object.fromEntries(
    OUTBOX_IMMUTABLE_FIELDS.map((field) => [field, currentEffect[field]]),
  );
  assertOutboxWorkerActionEligible(projection, event, currentEffect);
  let packetReceipt = null;
  const packetVerificationRequired = currentEffect.effect_contract_version === 2
    && projection.provider_settlement_epoch !== null;
  let operationScopeBinding = null;
  if (packetVerificationRequired) {
    if (!Object.hasOwn(payload, "packet_verification_receipt")
        || authorizationFields.some((field) => !Object.hasOwn(payload, field))) {
      fail(
        "BUSINESS_PROJECTION_PACKET_VERIFICATION",
        "An Effect V2 send begin requires the complete send-authorization V2 event",
      );
    }
    try {
      packetReceipt = normalizeDispatchPacketVerificationReceiptV1(
        payload.packet_verification_receipt,
      );
    } catch (error) {
      fail(
        "BUSINESS_PROJECTION_PACKET_VERIFICATION",
        "Send begin requires one valid content-addressed packet verification receipt",
        { cause_code: error?.code || null },
      );
    }
    const workOrder = requireWorkOrder(projection, event);
    const planBranch = workOrder.plan?.branches?.find(
      (branch) => branch.branch_ref === currentEffect.branch_ref,
    );
    if (!same(packetReceipt.effect_identity, currentEffectIdentity)
        || packetReceipt.packet_binding.work_order_id !== workOrder.work_order_id
        || packetReceipt.packet_binding.work_order_revision > workOrder.revision
        || packetReceipt.packet_binding.plan_snapshot_ref !== workOrder.plan_snapshot_ref
        || packetReceipt.packet_binding.plan_hash !== workOrder.plan_hash
        || packetReceipt.packet_binding.engine_contract_version !== workOrder.engine_contract_version
        || packetReceipt.packet_binding.permission_mode !== planBranch?.permission_mode
        || packetReceipt.packet_binding.project_ref !== workOrder.plan.project_ref
        || packetReceipt.packet_binding.isolation_mode !== planBranch?.isolation
        || !planBranch
        || packetReceipt.packet_binding.task_intent_ref.id !== planBranch.task_intent_ref.id
        || packetReceipt.packet_binding.task_intent_ref.hash !== planBranch.task_intent_ref.hash
        || packetReceipt.packet_binding.execution_plan_ref.id !== planBranch.execution_plan_ref.id
        || packetReceipt.packet_binding.execution_plan_ref.hash !== planBranch.execution_plan_ref.hash
        || packetReceipt.packet_binding.context_pack_ref.id !== planBranch.context_pack_ref.id
        || packetReceipt.packet_binding.context_pack_ref.hash !== planBranch.context_pack_ref.hash) {
      fail(
        "BUSINESS_PROJECTION_PACKET_VERIFICATION",
        "Packet verification receipt does not bind the current immutable Work Order plan and Effect",
      );
    }
    try {
      operationScopeBinding = normalizeSendAuthorizationOperationScopeBindingV2(
        payload.operation_scope_binding,
        currentEffectIdentity,
      );
    } catch (error) {
      if (!(error instanceof BusinessSendAuthorizationError)) throw error;
      fail(
        "BUSINESS_PROJECTION_PACKET_VERIFICATION",
        "Send authorization operation scope does not bind the projected Effect",
        { cause_code: error.code },
      );
    }
    if (projection.provider_settlement_epoch.send_authorization_contract_version
          !== SEND_AUTHORIZATION_CONTRACT_VERSION
        || payload.send_authorization_contract_version
          !== SEND_AUTHORIZATION_CONTRACT_VERSION
        || payload.provider_settlement_cutover_id
          !== projection.provider_settlement_epoch.cutover_id
        || timestamp(payload.lease_expires_at, "event.payload.lease_expires_at")
          !== currentEffect.lease?.expires_at) {
      fail(
        "BUSINESS_PROJECTION_PROVIDER_SETTLEMENT_CUTOVER",
        "Send authorization must bind the active V2 cutover and exact entry lease window",
      );
    }
  } else if (Object.hasOwn(payload, "packet_verification_receipt")
      || authorizationFields.some((field) => Object.hasOwn(payload, field))) {
    fail(
      "BUSINESS_PROJECTION_PROVIDER_SETTLEMENT_CUTOVER",
      "Packet-authorized send begin requires the durable provider-settlement cutover epoch",
    );
  }
  return transitionOutbox(
    projection,
    event,
    "sending",
    (effect, payload) => {
      const leaseId = portableRef(payload.lease_id, "event.payload.lease_id");
      const leaseOwnerId = portableRef(payload.lease_owner_id, "event.payload.lease_owner_id");
      const leaseGeneration = integer(payload.lease_generation, "event.payload.lease_generation", 1);
      if (!effect.lease
          || effect.lease.lease_id !== leaseId
          || effect.lease.owner_id !== leaseOwnerId
          || effect.lease.generation !== leaseGeneration
          || Date.parse(payload.occurred_at) >= Date.parse(effect.lease.expires_at)) {
        fail("BUSINESS_PROJECTION_TRANSITION", "Send begin requires the current lease token");
      }
      return packetVerificationRequired
        ? { ...effect, packet_verification_receipt: packetReceipt }
        : effect;
    },
    [
      "effect_id",
      "lease_id",
      "lease_owner_id",
      "lease_generation",
      "effect",
      "packet_verification_receipt",
      ...authorizationFields,
    ],
    ["effect_id", "lease_id", "lease_owner_id", "lease_generation", "effect"],
  );
}

function reduceOutboxLeaseRenewed(projection, event) {
  const payload = requireSpecificFields(event, ["effect_id", "lease", "effect"]);
  const workOrder = requireWorkOrder(projection, event);
  const effect = requireOutboxEffect(projection, event, payload);
  assertOutboxWorkerActionEligible(projection, event, effect);
  if (!["claimed", "sending"].includes(effect.status) || !effect.lease) {
    fail("BUSINESS_PROJECTION_TRANSITION", "Only a currently leased outbox effect may renew its lease");
  }
  const lease = normalizeLease(payload.lease, "event.payload.lease");
  if (lease.lease_id !== effect.lease.lease_id
    || lease.owner_id !== effect.lease.owner_id
    || lease.generation !== effect.lease.generation
    || lease.claimed_at !== effect.lease.claimed_at
    || Date.parse(lease.heartbeat_at) <= Date.parse(effect.lease.heartbeat_at)
    || Date.parse(lease.expires_at) <= Date.parse(effect.lease.expires_at)
    || lease.heartbeat_at !== payload.occurred_at
    || lease.expires_at !== expectedLeaseExpiry(workOrder, payload.occurred_at)
    || Date.parse(payload.occurred_at) >= Date.parse(effect.lease.expires_at)
    || Date.parse(payload.occurred_at) < Date.parse(effect.updated_at)) {
    fail("BUSINESS_PROJECTION_TRANSITION", "A lease renewal must extend the current immutable lease token");
  }
  return {
    ...projection,
    outbox: withMapEntry(projection.outbox, effect.effect_id, {
      ...effect,
      lease,
      updated_at: payload.occurred_at,
    }),
  };
}

function reduceOutboxRequeued(projection, event) {
  return transitionOutbox(
    projection,
    event,
    "pending",
    (effect, payload) => {
      const leaseId = portableRef(payload.lease_id, "event.payload.lease_id");
      const leaseOwnerId = portableRef(payload.lease_owner_id, "event.payload.lease_owner_id");
      const leaseGeneration = integer(payload.lease_generation, "event.payload.lease_generation", 1);
      if (!effect.lease
          || effect.lease.lease_id !== leaseId
          || effect.lease.owner_id !== leaseOwnerId
          || effect.lease.generation !== leaseGeneration
          || Date.parse(payload.occurred_at) < Date.parse(effect.lease.expires_at)) {
        fail("BUSINESS_PROJECTION_TRANSITION", "Requeue requires the current lease token");
      }
      return {
        ...effect,
        lease: null,
        ...(effect.effect_contract_version === 2
          && (projection.provider_settlement_epoch !== null
            || Object.hasOwn(effect, "packet_verification_receipt"))
          ? { packet_verification_receipt: null }
          : {}),
        last_delivery_reason: normalizeReason(payload.reason),
      };
    },
    ["effect_id", "lease_id", "lease_owner_id", "lease_generation", "reason", "effect"],
    ["effect_id", "lease_id", "lease_owner_id", "lease_generation", "reason", "effect"],
  );
}

function reduceOutboxSendExpired(projection, event) {
  const next = transitionOutbox(
    projection,
    event,
    "delivery_unknown",
    (effect, payload, currentEffect) => {
      if (!currentEffect.lease
          || Date.parse(payload.occurred_at) < Date.parse(currentEffect.lease.expires_at)) {
        fail(
          "BUSINESS_PROJECTION_TRANSITION",
          "Only an expired sending lease may become delivery unknown",
        );
      }
      const delivery = normalizeDelivery(
        payload.delivery,
        "delivery_unknown",
        "event.payload.delivery",
      );
      if (delivery.runtime_identity !== null
          || delivery.recorded_at !== payload.occurred_at) {
        fail(
          "BUSINESS_PROJECTION_INVALID",
          "An expired send must record local ambiguity without inventing runtime identity",
        );
      }
      if (currentEffect.effect_contract_version === 2) {
        const workOrder = requireWorkOrder(projection, event);
        if (!["observation", PROVIDER_SETTLEMENT_SOURCE_TYPE]
          .includes(workOrder.pending_projection_input?.source_type)) {
          fail(
            "BUSINESS_PROJECTION_SOURCE_CLASS",
            "A live V2 send expiration must be an atomic observation input",
          );
        }
        const token = exact(
          payload.fencing_token,
          new Set(["lease_id", "owner_id", "generation"]),
          new Set(["lease_id", "owner_id", "generation"]),
          "event.payload.fencing_token",
        );
        const expiresAt = timestamp(
          payload.lease_expires_at,
          "event.payload.lease_expires_at",
        );
        contentRef(payload.expiry_trigger_ref, "event.payload.expiry_trigger_ref");
        if (token.lease_id !== currentEffect.lease.lease_id
            || token.owner_id !== currentEffect.lease.owner_id
            || token.generation !== currentEffect.lease.generation
            || expiresAt !== currentEffect.lease.expires_at) {
          fail(
            "BUSINESS_PROJECTION_TRANSITION",
            "V2 send expiration must bind the exact current lease token and window",
          );
        }
        const settlementPolicy = normalizeSettlementPolicyRecord(payload.settlement_policy, {
          name: EFFECT_SEND_EXPIRY_OBSERVATION_NAME,
          payload: { effect_kind: currentEffect.effect_kind },
        });
        effect.settlement_policy = settlementPolicy;
      } else if ([
        "fencing_token",
        "lease_expires_at",
        "expiry_trigger_ref",
        "settlement_policy",
      ].some((field) => Object.hasOwn(payload, field))) {
        fail(
          "BUSINESS_PROJECTION_INVALID",
          "Historical V1 send expiration cannot carry V2 lifecycle fields",
        );
      }
      return { ...effect, lease: null, delivery };
    },
    [
      "effect_id",
      "delivery",
      "effect",
      "fencing_token",
      "lease_expires_at",
      "expiry_trigger_ref",
      "settlement_policy",
    ],
    ["effect_id", "delivery", "effect"],
  );
  const effect = next.outbox[event.payload.effect_id];
  if (effect.effect_contract_version !== 2
      || !["provider.thread.create", "provider.turn.start"].includes(effect.effect_kind)) {
    return next;
  }
  const workOrder = requireWorkOrder(next, event);
  const branch = requireBranch(workOrder, effect.branch_ref);
  return replaceWorkOrder(next, {
    ...workOrder,
    branches: withMapEntry(workOrder.branches, branch.branch_ref, {
      ...branch,
      delivery: {
        classification: "delivery_unknown",
        observed_at: event.payload.occurred_at,
      },
    }),
  });
}

function normalizeDelivery(value, expected, path) {
  const delivery = exact(
    value,
    new Set(["classification", "evidence_refs", "runtime_identity", "recorded_at"]),
    new Set(["classification", "evidence_refs", "runtime_identity", "recorded_at"]),
    path,
  );
  if (delivery.classification !== expected) {
    fail("BUSINESS_PROJECTION_INVALID", `${path}.classification must be ${expected}`, { path });
  }
  return {
    classification: expected,
    evidence_refs: stringArray(delivery.evidence_refs, `${path}.evidence_refs`, { minimum: 1 }),
    runtime_identity: normalizeRuntimeIdentity(delivery.runtime_identity, `${path}.runtime_identity`),
    recorded_at: timestamp(delivery.recorded_at, `${path}.recorded_at`),
  };
}

function reduceOutboxSettled(projection, event, status) {
  const next = transitionOutbox(
    projection,
    event,
    status,
    (effect, payload, currentEffect) => {
      const token = payload.fencing_token === null
        ? null
        : exact(
          payload.fencing_token,
          new Set(["lease_id", "owner_id", "generation"]),
          new Set(["lease_id", "owner_id", "generation"]),
          "event.payload.fencing_token",
        );
      if (currentEffect.status === "delivery_unknown") {
        if (token !== null) {
          fail(
            "BUSINESS_PROJECTION_TRANSITION",
            "Ambiguous-delivery reconciliation cannot reuse an expired worker lease",
          );
        }
      } else {
        const leaseId = portableRef(token?.lease_id, "event.payload.fencing_token.lease_id");
        const ownerId = portableRef(token?.owner_id, "event.payload.fencing_token.owner_id");
        const generation = integer(
          token?.generation,
          "event.payload.fencing_token.generation",
          1,
        );
        if (!currentEffect.lease
            || currentEffect.lease.lease_id !== leaseId
            || currentEffect.lease.owner_id !== ownerId
            || currentEffect.lease.generation !== generation
            || Date.parse(payload.occurred_at) >= Date.parse(currentEffect.lease.expires_at)) {
          fail(
            "BUSINESS_PROJECTION_TRANSITION",
            "Delivery settlement requires the current lease fencing token",
          );
        }
      }
      const delivery = normalizeDelivery(payload.delivery, status === "delivered" ? "accepted" : status, "event.payload.delivery");
      if (delivery.recorded_at !== payload.occurred_at) {
        fail("BUSINESS_PROJECTION_INVALID", "Delivery evidence time must equal the event time");
      }
      let settlementPolicy = currentEffect.settlement_policy || null;
      if (Object.hasOwn(payload, "settlement_policy")) {
        const workOrder = requireWorkOrder(projection, event);
        if (currentEffect.effect_contract_version !== 2
            || !["observation", PROVIDER_SETTLEMENT_SOURCE_TYPE]
              .includes(workOrder.pending_projection_input?.source_type)) {
          fail(
            "BUSINESS_PROJECTION_SETTLEMENT_POLICY",
            "Only an atomic V2 observation settlement may persist shared policy",
          );
        }
        settlementPolicy = normalizeSettlementPolicyRecord(payload.settlement_policy, {
          name: EFFECT_SETTLEMENT_OBSERVATION_NAME,
          payload: {
            effect_kind: currentEffect.effect_kind,
            settlement_source: payload.settlement_policy.settlement_source,
            classification: delivery.classification,
          },
        });
      } else if (settlementPolicy !== null) {
        fail(
          "BUSINESS_PROJECTION_SETTLEMENT_POLICY",
          "A settled V2 generation cannot replace its durable settlement policy",
        );
      }
      return { ...effect, lease: null, delivery, settlement_policy: settlementPolicy };
    },
    ["effect_id", "fencing_token", "delivery", "effect", "settlement_policy"],
    ["effect_id", "fencing_token", "delivery", "effect"],
  );
  const effect = next.outbox[event.payload.effect_id];
  if (effect.effect_contract_version !== 2
      || effect.effect_kind !== "provider.turn.cancel") return next;
  const workOrder = requireWorkOrder(next, event);
  const branch = requireBranch(workOrder, effect.branch_ref);
  if (branch.cancel_effect_id !== effect.effect_id) {
    fail(
      "BUSINESS_PROJECTION_OUTBOX_BINDING",
      "A cancellation settlement must bind the one current cancel effect",
    );
  }
  if (status !== "not_sent") return next;
  return replaceWorkOrder(next, {
    ...workOrder,
    branches: withMapEntry(workOrder.branches, branch.branch_ref, {
      ...branch,
      cancel_effect_id: null,
    }),
  });
}

function reduceOutboxCancelled(projection, event) {
  const next = transitionOutbox(
    projection,
    event,
    "cancelled",
    (effect, payload) => ({ ...effect, lease: null, last_delivery_reason: normalizeReason(payload.reason) }),
    ["effect_id", "reason", "effect"],
    ["effect_id", "reason", "effect"],
  );
  const effect = next.outbox[event.payload.effect_id];
  if (effect.effect_contract_version === 2
      && effect.effect_kind === "provider.turn.cancel") {
    const workOrder = requireWorkOrder(next, event);
    const branch = requireBranch(workOrder, effect.branch_ref);
    if (branch.cancel_effect_id !== effect.effect_id) {
      fail(
        "BUSINESS_PROJECTION_OUTBOX_BINDING",
        "A locally cancelled provider cancellation must be the one current effect",
      );
    }
    return replaceWorkOrder(next, {
      ...workOrder,
      branches: withMapEntry(workOrder.branches, branch.branch_ref, {
        ...branch,
        cancel_effect_id: null,
      }),
    });
  }
  if (effect.effect_contract_version === undefined
      || effect.effect_kind !== "provider.user_input.submit") return next;
  const workOrder = requireWorkOrder(next, event);
  const branch = requireBranch(workOrder, effect.branch_ref);
  if (branch.pending_user_input_effect_id !== effect.effect_id) {
    fail(
      "BUSINESS_PROJECTION_OUTBOX_BINDING",
      "A locally cancelled user-input effect must be the one pending submission",
    );
  }
  return replaceWorkOrder(next, {
    ...workOrder,
    branches: withMapEntry(workOrder.branches, branch.branch_ref, {
      ...branch,
      open_user_input: null,
      pending_user_input_effect_id: null,
      pending_user_input_response_ref: null,
    }),
  });
}

function normalizeProviderSettlementBundle(value) {
  const bundle = exact(
    value,
    PROVIDER_SETTLEMENT_BUNDLE_FIELDS,
    PROVIDER_SETTLEMENT_BUNDLE_FIELDS,
    "event.payload.receipt.settlement_bundle",
  );
  const effectBinding = exact(
    bundle.effect_binding,
    PROVIDER_SETTLEMENT_EFFECT_BINDING_FIELDS,
    PROVIDER_SETTLEMENT_EFFECT_BINDING_FIELDS,
    "event.payload.receipt.settlement_bundle.effect_binding",
  );
  return {
    bundle_schema_version: enumeration(
      bundle.bundle_schema_version,
      [1],
      "event.payload.receipt.settlement_bundle.bundle_schema_version",
    ),
    settlement_contract_version: enumeration(
      bundle.settlement_contract_version,
      [2],
      "event.payload.receipt.settlement_bundle.settlement_contract_version",
    ),
    cutover_id: portableRef(bundle.cutover_id, "event.payload.receipt.settlement_bundle.cutover_id"),
    observation_name: enumeration(
      bundle.observation_name,
      [...PROVIDER_SETTLEMENT_CURRENT_OBSERVATIONS],
      "event.payload.receipt.settlement_bundle.observation_name",
    ),
    effect_binding: {
      effect_id: portableRef(
        effectBinding.effect_id,
        "event.payload.receipt.settlement_bundle.effect_binding.effect_id",
      ),
      effect_contract_version: enumeration(
        effectBinding.effect_contract_version,
        [2],
        "event.payload.receipt.settlement_bundle.effect_binding.effect_contract_version",
      ),
      effect_kind: enumeration(
        effectBinding.effect_kind,
        [
          "provider.thread.create",
          "provider.turn.start",
          "provider.user_input.submit",
          "provider.turn.cancel",
        ],
        "event.payload.receipt.settlement_bundle.effect_binding.effect_kind",
      ),
      branch_ref: portableRef(
        effectBinding.branch_ref,
        "event.payload.receipt.settlement_bundle.effect_binding.branch_ref",
      ),
      attempt: integer(
        effectBinding.attempt,
        "event.payload.receipt.settlement_bundle.effect_binding.attempt",
      ),
      dispatch_id: portableRef(
        effectBinding.dispatch_id,
        "event.payload.receipt.settlement_bundle.effect_binding.dispatch_id",
      ),
      mutation_idempotency_key: portableRef(
        effectBinding.mutation_idempotency_key,
        "event.payload.receipt.settlement_bundle.effect_binding.mutation_idempotency_key",
      ),
    },
    ingress_kind: enumeration(
      bundle.ingress_kind,
      ["worker_result", "recovery_probe", "expiry_receipt", "control_plane_failure"],
      "event.payload.receipt.settlement_bundle.ingress_kind",
    ),
    provenance_ref: contentRef(
      bundle.provenance_ref,
      "event.payload.receipt.settlement_bundle.provenance_ref",
    ),
    effective_classification: enumeration(
      bundle.effective_classification,
      ["accepted", "not_sent", "delivery_unknown"],
      "event.payload.receipt.settlement_bundle.effective_classification",
    ),
    settlement_policy_hash: bundle.settlement_policy_hash === null
      ? null
      : sha256(
        bundle.settlement_policy_hash,
        "event.payload.receipt.settlement_bundle.settlement_policy_hash",
      ),
    domain_event_manifest_hash: sha256(
      bundle.domain_event_manifest_hash,
      "event.payload.receipt.settlement_bundle.domain_event_manifest_hash",
    ),
  };
}

function normalizeReceipt(value, sourceType, event, pending, batchId) {
  const receiptFields = sourceType === PROVIDER_SETTLEMENT_SOURCE_TYPE
    ? new Set([...RECEIPT_FIELDS, "settlement_bundle"])
    : RECEIPT_FIELDS;
  const receipt = exact(
    value,
    receiptFields,
    receiptFields,
    "event.payload.receipt",
  );
  const normalized = {
    source_id: portableRef(receipt.source_id, "event.payload.receipt.source_id"),
    source_type: enumeration(receipt.source_type, [sourceType], "event.payload.receipt.source_type"),
    identity_hash: sha256(receipt.identity_hash, "event.payload.receipt.identity_hash"),
    payload_hash: sha256(receipt.payload_hash, "event.payload.receipt.payload_hash"),
    work_order_id: normalizeWorkOrderId(receipt.work_order_id, "event.payload.receipt.work_order_id"),
    applied_revision: integer(receipt.applied_revision, "event.payload.receipt.applied_revision"),
    batch_id: portableRef(receipt.batch_id, "event.payload.receipt.batch_id"),
    event_ids: stringArray(receipt.event_ids, "event.payload.receipt.event_ids", { minimum: 1, maximum: 511 }),
    result: cloneJson(receipt.result, "event.payload.receipt.result"),
    ...(sourceType === PROVIDER_SETTLEMENT_SOURCE_TYPE
      ? { settlement_bundle: normalizeProviderSettlementBundle(receipt.settlement_bundle) }
      : {}),
  };
  if (normalized.source_id !== event.payload.source_id
    || normalized.work_order_id !== event.payload.work_order_id
    || normalized.applied_revision !== event.payload.target_work_order_revision
    || pending.event_ids.at(-1) !== event.event_id
    || !same(normalized.event_ids, pending.event_ids.slice(0, -1))
    || (pending.batch_id !== null && normalized.batch_id !== pending.batch_id)
    || (batchId !== null && normalized.batch_id !== batchId)) {
    fail("BUSINESS_PROJECTION_RECEIPT_BINDING", "The receipt does not bind the complete atomic input", {
      source_id: event.payload.source_id,
    });
  }
  return { ...normalized, event_hashes: { ...pending.event_hashes } };
}

function normalizeProviderSettlementObservationFromBatch(batchContext) {
  const candidates = batchContext.events
    .slice(0, -1)
    .map((event) => event.payload?.observation || event.payload?.record?.observation)
    .filter((observation) => isPlainObject(observation)
      && PROVIDER_SETTLEMENT_CURRENT_OBSERVATIONS.has(observation.name));
  if (candidates.length === 0) {
    fail(
      "BUSINESS_PROJECTION_PROVIDER_SETTLEMENT_BUNDLE",
      "A provider-settlement bundle requires its original current V2 observation envelope",
    );
  }
  let normalized;
  try {
    normalized = normalizeBusinessRuntimeObservationEnvelope(candidates[0]);
  } catch (error) {
    fail(
      "BUSINESS_PROJECTION_PROVIDER_SETTLEMENT_BUNDLE",
      "The provider-settlement bundle contains an invalid observation envelope",
      { cause_code: error?.code || null },
    );
  }
  for (const candidate of candidates.slice(1)) {
    let other;
    try {
      other = normalizeBusinessRuntimeObservationEnvelope(candidate);
    } catch (error) {
      fail(
        "BUSINESS_PROJECTION_PROVIDER_SETTLEMENT_BUNDLE",
        "The provider-settlement bundle contains an invalid repeated observation envelope",
        { cause_code: error?.code || null },
      );
    }
    if (!same(other, normalized)) {
      fail(
        "BUSINESS_PROJECTION_PROVIDER_SETTLEMENT_BUNDLE",
        "Every provider-settlement audit event must retain the same original observation",
      );
    }
  }
  return normalized;
}

function providerSettlementManifestHash(batchContext) {
  return canonicalHash(batchContext.events.slice(0, -1).map((event) => ({
    event_id: event.event_id,
    type: event.type,
    event_hash: canonicalHash(event),
  })));
}

function validateProviderSettlementReceiptBundle(
  projection,
  receipt,
  batchContext,
) {
  if (receipt.source_type !== PROVIDER_SETTLEMENT_SOURCE_TYPE) return;
  const epoch = projection.provider_settlement_epoch;
  if (!isPlainObject(epoch)) {
    fail(
      "BUSINESS_PROJECTION_PROVIDER_SETTLEMENT_CUTOVER",
      "A provider-settlement receipt requires the durable global cutover epoch",
    );
  }
  const bundle = receipt.settlement_bundle;
  const observation = normalizeProviderSettlementObservationFromBatch(batchContext);
  const payload = observation.payload;
  const effect = projection.outbox[bundle.effect_binding.effect_id];
  if (!isPlainObject(effect)) {
    fail(
      "BUSINESS_PROJECTION_PROVIDER_SETTLEMENT_BUNDLE",
      "A provider-settlement receipt must bind one projected provider effect",
    );
  }
  const expectedEffectBinding = {
    effect_id: effect.effect_id,
    effect_contract_version: effect.effect_contract_version,
    effect_kind: effect.effect_kind,
    branch_ref: effect.branch_ref,
    attempt: effect.attempt,
    dispatch_id: effect.dispatch_id,
    mutation_idempotency_key: effect.idempotency_key,
  };
  if (bundle.cutover_id !== epoch.cutover_id
      || bundle.observation_name !== observation.name
      || !same(bundle.effect_binding, expectedEffectBinding)
      || payload.effect_id !== effect.effect_id
      || payload.effect_contract_version !== effect.effect_contract_version
      || payload.effect_kind !== effect.effect_kind
      || payload.branch_ref !== effect.branch_ref
      || payload.attempt !== effect.attempt
      || payload.dispatch_id !== effect.dispatch_id) {
    fail(
      "BUSINESS_PROJECTION_PROVIDER_SETTLEMENT_BUNDLE",
      "The provider-settlement bundle does not bind its epoch, observation, and immutable effect",
    );
  }

  let expectedIngressKind;
  let expectedProvenanceRef;
  if (observation.name === EFFECT_SEND_EXPIRY_OBSERVATION_NAME) {
    expectedIngressKind = "expiry_receipt";
    expectedProvenanceRef = payload.expiry_receipt_ref;
  } else if (observation.name === EFFECT_PRESEND_FAILURE_OBSERVATION_NAME) {
    expectedIngressKind = "control_plane_failure";
    expectedProvenanceRef = payload.failure_record_ref;
  } else if (payload.settlement_source === "recovery_probe") {
    expectedIngressKind = "recovery_probe";
    expectedProvenanceRef = payload.recovery_probe.probe_receipt_ref;
  } else {
    expectedIngressKind = "worker_result";
    expectedProvenanceRef = payload.worker_result_ref;
  }
  const policy = canonicalSettlementPolicyFromBatch(batchContext);
  const expectedPolicyHash = policy === null ? null : canonicalHash(policy);
  const expectedClassification = policy?.classification || payload.classification;
  if (bundle.ingress_kind !== expectedIngressKind
      || !same(bundle.provenance_ref, expectedProvenanceRef)
      || bundle.effective_classification !== expectedClassification
      || bundle.settlement_policy_hash !== expectedPolicyHash
      || bundle.domain_event_manifest_hash !== providerSettlementManifestHash(batchContext)) {
    fail(
      "BUSINESS_PROJECTION_PROVIDER_SETTLEMENT_BUNDLE",
      "The provider-settlement bundle does not bind its provenance, policy, or complete event manifest",
    );
  }
  if (policy === null) {
    const domainEvents = batchContext.events.slice(0, -1);
    if (domainEvents.length !== 1
        || domainEvents[0].type !== "business.late_observation.quarantined") {
      fail(
        "BUSINESS_PROJECTION_PROVIDER_SETTLEMENT_BUNDLE",
        "Only a stale settlement quarantine may close without a canonical settlement policy",
      );
    }
  }
}

function validateReceiptBatch(event, batchContext) {
  if (!batchContext || !Array.isArray(batchContext.events)) return;
  if (batchContext.events.length < 2
    || batchContext.events.at(-1).event_id !== event.event_id
    || batchContext.events.at(-1).type !== event.type
    || batchContext.events.some((entry) => !EVENT_TYPE_SET.has(entry.type))
    || batchContext.events.filter((entry) => Object.hasOwn(RECEIPT_TYPES, entry.type)).length !== 1) {
    fail("BUSINESS_PROJECTION_RECEIPT_BINDING", "The receipt must be the single final receipt event in its atomic batch");
  }
}

function validateRecoveryProbeReceipt(projection, receiptPayload, batchContext) {
  if (!batchContext || !Array.isArray(batchContext.events)) return;
  const recoveryEvents = batchContext.events.filter(
    (entry) => entry.type === "business.recovery_probe.recorded",
  );
  const resultLedger = receiptPayload.receipt?.result?.recovery_probe_ledger;
  if (recoveryEvents.length === 0) {
    if (resultLedger !== undefined) {
      fail(
        "BUSINESS_PROJECTION_RECOVERY_PROBE",
        "Only a semantic recovery-probe event may create a probe ledger receipt",
      );
    }
    return;
  }
  if (recoveryEvents.length !== 1
      || !isPlainObject(resultLedger)
      || !same(resultLedger, recoveryEvents[0].payload.recovery_probe_ledger)) {
    fail(
      "BUSINESS_PROJECTION_RECOVERY_PROBE",
      "Recovery probe event and observation receipt must carry one exact ledger entry",
    );
  }
  for (const existing of Object.values(projection.observation_receipts)) {
    const prior = existing?.result?.recovery_probe_ledger;
    if (prior?.version === 1
        && prior.probe_receipt_ref?.id === resultLedger.probe_receipt_ref?.id) {
      fail(
        "BUSINESS_PROJECTION_RECOVERY_PROBE_REUSED",
        "Recovery probe receipt identifier cannot be reused by another observation",
      );
    }
  }
}

function settlementPolicyEntriesFromBatch(batchContext) {
  const policyEntries = [];
  for (const event of batchContext.events) {
    if (event.type === "business.branch.runtime_observed"
        && [
          EFFECT_SETTLEMENT_OBSERVATION_NAME,
          EFFECT_SEND_EXPIRY_OBSERVATION_NAME,
          EFFECT_PRESEND_FAILURE_OBSERVATION_NAME,
        ]
          .includes(event.payload.observation?.name)) {
      if (!event.payload.settlement_policy) {
        fail(
          "BUSINESS_PROJECTION_SETTLEMENT_POLICY",
          "A current provider settlement runtime audit requires its canonical policy",
        );
      }
      policyEntries.push(event.payload.settlement_policy);
    }
    if ([
      "business.outbox.delivered",
      "business.outbox.not_sent",
      "business.outbox.delivery_unknown",
      "business.outbox.send_expired",
    ].includes(event.type)
        && event.payload.effect?.effect_contract_version === 2
        && event.payload.settlement_policy) {
      policyEntries.push(event.payload.settlement_policy);
    }
    if (event.type === "business.recovery_probe.recorded"
        && event.payload.observation?.name === EFFECT_SETTLEMENT_OBSERVATION_NAME) {
      if (!event.payload.recovery_probe_ledger?.settlement_policy) {
        fail(
          "BUSINESS_PROJECTION_SETTLEMENT_POLICY",
          "A current recovery probe requires its canonical settlement policy",
        );
      }
      policyEntries.push(event.payload.recovery_probe_ledger.settlement_policy);
    }
  }
  return policyEntries;
}

function canonicalSettlementPolicyFromBatch(batchContext) {
  const entries = settlementPolicyEntriesFromBatch(batchContext);
  if (entries.length === 0) return null;
  const policies = entries.map((policy) => normalizeSettlementPolicyRecordV2(policy));
  const policy = policies[0];
  if (policies.some((candidate) => !same(candidate, policy))) {
    fail(
      "BUSINESS_PROJECTION_SETTLEMENT_POLICY",
      "Every event in one provider settlement must carry the same canonical policy",
    );
  }
  return policy;
}

function validateSettlementPolicyEventCoherence(projection, workOrder, batchContext) {
  if (!batchContext || !Array.isArray(batchContext.events)) return;
  const policyEntries = settlementPolicyEntriesFromBatch(batchContext);
  const semanticObservationNames = [];
  const settlementEvents = [];
  const successorEvents = [];
  for (const event of batchContext.events) {
    if (event.type === "business.branch.runtime_observed"
        && [
          EFFECT_SETTLEMENT_OBSERVATION_NAME,
          EFFECT_SEND_EXPIRY_OBSERVATION_NAME,
          EFFECT_PRESEND_FAILURE_OBSERVATION_NAME,
        ]
          .includes(event.payload.observation?.name)) {
      semanticObservationNames.push(event.payload.observation.name);
    }
    if ([
      "business.outbox.delivered",
      "business.outbox.not_sent",
      "business.outbox.delivery_unknown",
      "business.outbox.send_expired",
    ].includes(event.type) && event.payload.effect?.effect_contract_version === 2) {
      settlementEvents.push(event);
    }
    if (event.type === "business.recovery_probe.recorded"
        && event.payload.observation?.name === EFFECT_SETTLEMENT_OBSERVATION_NAME) {
      semanticObservationNames.push(event.payload.observation.name);
    }
    if (event.type === "business.outbox.enqueued"
        && event.payload.effect?.effect_contract_version === 2
        && event.payload.effect?.generation_predecessor_effect_id !== null) {
      successorEvents.push(event);
    }
  }
  const semanticBatch = semanticObservationNames.length !== 0
    || batchContext.events.some((event) => (
      event.type === "business.outbox.send_expired"
        && event.payload.effect?.effect_contract_version === 2
    ));
  if (!semanticBatch) return;
  if (policyEntries.length === 0) {
    fail(
      "BUSINESS_PROJECTION_SETTLEMENT_POLICY",
      "A current provider settlement batch requires one canonical policy",
    );
  }
  const policy = canonicalSettlementPolicyFromBatch(batchContext);
  if (batchContext.events.some((event) => event.type === "business.branch.attempt_opened")) {
    fail(
      "BUSINESS_PROJECTION_SETTLEMENT_POLICY",
      "A provider settlement may authorize only an Effect generation, never a branch attempt",
    );
  }
  const policySettlementEvents = settlementEvents.filter((event) => (
    event.payload.effect_id
      && event.payload.effect_kind === undefined
        ? event.payload.effect?.effect_kind === policy.effect_kind
        : event.payload.effect_kind === policy.effect_kind
  ));
  if (policy.classification !== "delivery_unknown" || policySettlementEvents.length !== 0) {
    if (policySettlementEvents.length !== 1) {
      fail(
        "BUSINESS_PROJECTION_SETTLEMENT_POLICY",
        "One provider settlement policy must bind one exact outbox terminal transition",
      );
    }
  } else {
    // An inconclusive recovery probe records a durable ledger without
    // re-transitioning an Effect that is already delivery_unknown.
    const inconclusiveProbe = batchContext.events.some((event) => (
      event.type === "business.recovery_probe.recorded"
        && event.payload.recovery_probe_ledger?.classification === "delivery_unknown"
    ));
    if (!inconclusiveProbe) {
      fail(
        "BUSINESS_PROJECTION_SETTLEMENT_POLICY",
        "A delivery ambiguity requires either one outbox transition or one inconclusive probe ledger",
      );
    }
  }
  const settlementEvent = policySettlementEvents[0] || null;
  const expectedSettlementType = {
    accepted: "business.outbox.delivered",
    not_sent: "business.outbox.not_sent",
    delivery_unknown: settlementEvent?.type === "business.outbox.send_expired"
      ? "business.outbox.send_expired"
      : "business.outbox.delivery_unknown",
  }[policy.classification];
  if (settlementEvent && settlementEvent.type !== expectedSettlementType) {
    fail(
      "BUSINESS_PROJECTION_SETTLEMENT_POLICY",
      "Settlement classification does not match its exact outbox transition",
    );
  }
  const effectId = settlementEvent?.payload.effect_id
    || batchContext.events.find((event) => event.type === "business.recovery_probe.recorded")
      ?.payload.recovery_probe_ledger?.effect_id
    || null;
  if (effectId === null) {
    fail(
      "BUSINESS_PROJECTION_SETTLEMENT_POLICY",
      "A provider settlement policy must bind one Effect identifier",
    );
  }
  const policySuccessors = successorEvents.filter((event) => (
    event.payload.effect.generation_predecessor_effect_id === effectId
  ));
  if (successorEvents.length !== policySuccessors.length) {
    fail(
      "BUSINESS_PROJECTION_SETTLEMENT_POLICY",
      "A settlement batch cannot activate an unrelated Effect generation",
    );
  }
  const settledEffect = projection.outbox[effectId];
  if (settlementEvent
      && settledEffect?.settlement_policy
      && !same(normalizeSettlementPolicyRecordV2(settledEffect.settlement_policy), policy)) {
    fail(
      "BUSINESS_PROJECTION_SETTLEMENT_POLICY",
      "The projected Effect does not retain the settlement batch policy",
    );
  }
  if (policy.disposition !== "retry_candidate") {
    if (policySuccessors.length !== 0) {
      fail(
        "BUSINESS_PROJECTION_SETTLEMENT_POLICY",
        "Only a retry-candidate settlement may activate an Effect generation",
      );
    }
    if (V2_PRESEND_FAILURE_REASON_SET.has(policy.reason)) {
      const observations = batchContext.events.filter((event) => (
        event.type === "business.branch.runtime_observed"
          && event.payload.observation?.name === EFFECT_PRESEND_FAILURE_OBSERVATION_NAME
          && event.payload.delivery_effect_id === effectId
      ));
      const attention = batchContext.events.filter((event) => (
        event.type === "business.attention.opened"
          && event.payload.attention?.kind === "provider_effect_presend_failure"
          && event.payload.attention?.effect_id === effectId
      ));
      const failures = batchContext.events.filter((event) => (
        event.type === "business.branch.status_changed"
          && event.payload.branch_ref === settledEffect?.branch_ref
          && event.payload.to === "failed"
      ));
      const branch = workOrder.branches[settledEffect?.branch_ref];
      const observation = observations[0]?.payload.observation;
      const attentionRecord = attention[0]?.payload.attention;
      if (policy.settlement_source !== "control_plane"
          || policy.classification !== "not_sent"
          || policy.disposition !== "operator_attention"
          || policy.retry.scope !== "none"
          || policy.retry.mode !== "none"
          || !settledEffect
          || settledEffect.status !== "not_sent"
          || settledEffect.lease !== null
          || branch?.state !== "failed"
          || observations.length !== 1
          || attention.length !== 1
          || failures.length !== 1
          || batchContext.actor?.type !== "system"
          || batchContext.actor?.id !== observation?.actor?.actor_id
          || observation?.payload?.failure_reason !== policy.reason
          || !same(
            observation?.payload?.claimed_fencing_token,
            settlementEvent?.payload?.fencing_token,
          )
          || !same(attentionRecord?.detail_ref, observation?.payload?.failure_record_ref)
          || !settlementEvent?.evidence_refs?.includes(observation?.payload?.failure_record_ref?.id)
          || !attention[0]?.evidence_refs?.includes(observation?.payload?.failure_record_ref?.id)) {
        fail(
          "BUSINESS_PROJECTION_SETTLEMENT_POLICY",
          "A pre-send control-plane failure must close one claimed Effect into operator-only recovery",
        );
      }
    }
    return;
  }
  if (!settledEffect
      || settledEffect.status !== "not_sent"
      || policy.retry.scope !== "effect_generation") {
    fail(
      "BUSINESS_PROJECTION_SETTLEMENT_POLICY",
      "A retry candidate must retain one exact proven-not-sent Effect generation",
    );
  }
  if (!["provider.thread.create", "provider.turn.start"].includes(policy.effect_kind)) {
    if (policySuccessors.length !== 0) {
      fail(
        "BUSINESS_PROJECTION_SETTLEMENT_POLICY",
        "Input and cancel generations are activated only by their explicit command lifecycle",
      );
    }
    return;
  }
  const branch = workOrder.branches[settledEffect.branch_ref];
  const schedule = deriveEffectGenerationRetryScheduleV2({
    settlement_policy: policy,
    retry_policy: {
      backoff_initial_ms: workOrder.plan.retry_policy.backoff_initial_ms,
      backoff_max_ms: workOrder.plan.retry_policy.backoff_max_ms,
      max_attempts: workOrder.plan.retry_policy.max_attempts,
    },
    completed_generation: settledEffect.operation_generation,
    settled_at: settledEffect.delivery.recorded_at,
    attempt_deadline_at: branch.attempt_deadline_at,
    work_order_deadline_at: workOrder.deadline_at,
  });
  const immediateSuccessor = schedule.permitted
    && schedule.automatic
    && schedule.delay_ms === 0;
  if (policySuccessors.length !== (immediateSuccessor ? 1 : 0)) {
    fail(
      "BUSINESS_PROJECTION_SETTLEMENT_POLICY",
      "The settlement batch does not contain its exact authorized Effect-generation action",
    );
  }
  if (immediateSuccessor) {
    if (branch.state !== "dispatch_pending"
        || policySuccessors[0].payload.effect.operation_generation !== schedule.next_generation) {
      fail(
        "BUSINESS_PROJECTION_SETTLEMENT_POLICY",
        "An immediate successor must reactivate the same pending dispatch generation",
      );
    }
  } else if (schedule.permitted) {
    if (branch.state !== "retryable" || branch.retry_at !== schedule.eligible_at) {
      fail(
        "BUSINESS_PROJECTION_SETTLEMENT_POLICY",
        "A deferred or explicit generation must retain its exact durable retry schedule",
      );
    }
  } else if (branch.state !== "failed") {
    fail(
      "BUSINESS_PROJECTION_SETTLEMENT_POLICY",
      "An exhausted Effect generation must fail without falling back to a branch attempt",
    );
  }
}

function validateSendExpiryReceipt(receiptPayload, batchContext) {
  if (!batchContext || !Array.isArray(batchContext.events)) return;
  const expirations = batchContext.events.filter(
    (entry) => entry.type === "business.outbox.send_expired"
      && entry.payload.effect?.effect_contract_version === 2,
  );
  if (expirations.length === 0) return;
  if (expirations.length !== 1) {
    fail("BUSINESS_PROJECTION_SEND_EXPIRY", "One observation may expire only one V2 send");
  }
  const expiration = expirations[0];
  const effectId = expiration.payload.effect_id;
  const attention = batchContext.events.filter((entry) => (
    entry.type === "business.attention.opened"
      && entry.payload.attention?.effect_id === effectId
      && entry.payload.attention?.kind === "delivery_unknown"
  ));
  const runtimeAudit = batchContext.events.filter((entry) => (
    entry.type === "business.branch.runtime_observed"
      && entry.payload.observation?.name === EFFECT_SEND_EXPIRY_OBSERVATION_NAME
      && entry.payload.delivery_effect_id === effectId
  ));
  const lateCallback = batchContext.events.filter((entry) => (
    entry.type === "business.late_observation.quarantined"
      && entry.payload.record?.observation?.name === EFFECT_SETTLEMENT_OBSERVATION_NAME
      && entry.payload.record?.observation?.payload?.effect_id === effectId
      && entry.payload.record?.reason === "stale_effect_lease"
  ));
  if (attention.length !== 1
      || runtimeAudit.length + lateCallback.length !== 1
      || (lateCallback.length === 1
        && (receiptPayload.receipt?.result?.status !== "quarantined"
          || receiptPayload.receipt?.result?.reason !== "stale_effect_lease"))) {
    fail(
      "BUSINESS_PROJECTION_SEND_EXPIRY",
      "V2 send expiration requires exact effect attention and one authoritative audit outcome",
    );
  }
}

function validateSendAuthorizationReceipt(receipt, batchContext) {
  if (!batchContext || !Array.isArray(batchContext.events)) return;
  const sends = batchContext.events.filter(
    (entry) => entry.type === "business.outbox.send_begun"
      && entry.payload.effect?.effect_contract_version === 2
      && Object.hasOwn(entry.payload, "packet_verification_receipt"),
  );
  if (sends.length === 0) return;
  if (sends.length !== 1 || receipt.source_type !== "internal_action") {
    fail(
      "BUSINESS_PROJECTION_PACKET_VERIFICATION",
      "One packet-authorized send must close with one internal-action receipt",
    );
  }
  const send = sends[0];
  const usesAuthorizationV2 = send.payload.send_authorization_contract_version
    === SEND_AUTHORIZATION_CONTRACT_VERSION;
  const resultFields = new Set([
    "internal_action_id",
    "work_order_id",
    "work_order_revision",
    "effect_id",
    "action",
    "outbox_status",
    "fencing_token",
    "packet_verification_receipt",
    ...(usesAuthorizationV2 ? ["send_authorization_bundle"] : []),
  ]);
  const result = exact(
    receipt.result,
    resultFields,
    resultFields,
    "event.payload.receipt.result",
  );
  const expectedToken = {
    lease_id: send.payload.lease_id,
    owner_id: send.payload.lease_owner_id,
    generation: send.payload.lease_generation,
  };
  if (result.internal_action_id !== receipt.source_id
      || result.work_order_id !== receipt.work_order_id
      || result.work_order_revision !== receipt.applied_revision
      || result.effect_id !== send.payload.effect_id
      || result.action !== "outbox.send.begin"
      || result.outbox_status !== "sending"
      || !same(result.fencing_token, expectedToken)
      || !same(
        result.packet_verification_receipt,
        send.payload.packet_verification_receipt,
      )) {
    fail(
      "BUSINESS_PROJECTION_PACKET_VERIFICATION",
      "Send authorization result must repeat the exact durable lease and packet proof",
    );
  }
  if (usesAuthorizationV2) {
    let bundle;
    try {
      bundle = normalizeSendAuthorizationBundleV1(result.send_authorization_bundle);
    } catch (error) {
      if (!(error instanceof BusinessSendAuthorizationError)) throw error;
      fail(
        "BUSINESS_PROJECTION_PACKET_VERIFICATION",
        "Send authorization receipt does not contain one exact content-addressed bundle",
        { cause_code: error.code },
      );
    }
    if (!same(bundle.send_event, send)
        || bundle.batch_id !== receipt.batch_id) {
      fail(
        "BUSINESS_PROJECTION_PACKET_VERIFICATION",
        "Send authorization bundle does not bind the exact atomic send event and batch",
      );
    }
  }
}

function providerEntryWindowFailure(message, error, effectId = null) {
  if (!(error instanceof BusinessProviderEntryWindowError)
      && !(error instanceof BusinessSendAuthorizationError)) throw error;
  fail(
    "BUSINESS_PROJECTION_PROVIDER_ENTRY_WINDOW",
    message,
    { effect_id: effectId, cause_code: error.code },
  );
}

function committedSendProofFromReceipt(receipt, effectId = null) {
  try {
    return createCommittedSendAuthorizationProofV2({
      send_authorization_bundle: receipt?.result?.send_authorization_bundle,
      internal_receipt: receipt,
    });
  } catch (error) {
    providerEntryWindowFailure(
      "Provider entry window requires the exact projected send receipt closure",
      error,
      effectId,
    );
  }
}

function currentProviderEntryWindow(projection, index, proof) {
  const currentReceipt = projection.internal_receipts[index.current_window_receipt_id];
  if (!currentReceipt) {
    fail(
      "BUSINESS_PROJECTION_PROVIDER_ENTRY_WINDOW",
      "Provider entry window index points to a missing internal receipt",
      { effect_id: proof.effect.effect_id },
    );
  }
  let window;
  try {
    window = index.current_window_sequence === 0
      ? createProviderEntryWindowAnchorV1({ committed_send_authorization: proof })
      : normalizeProviderEntryWindowV1(
        currentReceipt.result?.provider_entry_window_continuation,
        { committed_send_authorization: proof },
      );
    normalizeProviderEntryWindowIndexV1(index, {
      committed_send_authorization: proof,
      current_window: window,
      current_window_internal_receipt: window.window_sequence === 0 ? null : currentReceipt,
    });
  } catch (error) {
    providerEntryWindowFailure(
      "Provider entry window index does not resolve to its exact current receipt",
      error,
      proof.effect.effect_id,
    );
  }
  return { window, currentReceipt };
}

function materializeProviderEntryWindow(projection, receipt, batchContext) {
  if (!batchContext || !Array.isArray(batchContext.events)) return projection;
  const send = batchContext.events.find((event) => (
    event.type === "business.outbox.send_begun"
      && event.payload.send_authorization_contract_version
        === SEND_AUTHORIZATION_CONTRACT_VERSION
  ));
  if (send) {
    const proof = committedSendProofFromReceipt(receipt, send.payload.effect_id);
    if (Object.hasOwn(projection.provider_entry_windows, proof.effect.effect_id)) {
      fail(
        "BUSINESS_PROJECTION_PROVIDER_ENTRY_WINDOW",
        "A send authorization Effect may materialize only one base provider entry window",
        { effect_id: proof.effect.effect_id },
      );
    }
    let index;
    try {
      index = createProviderEntryWindowIndexV1({ committed_send_authorization: proof });
    } catch (error) {
      providerEntryWindowFailure(
        "Send receipt could not materialize its base provider entry window",
        error,
        proof.effect.effect_id,
      );
    }
    return {
      ...projection,
      provider_entry_windows: withMapEntry(
        projection.provider_entry_windows,
        proof.effect.effect_id,
        index,
      ),
    };
  }

  const renewal = batchContext.events.find(
    (event) => event.type === "business.outbox.lease_renewed",
  );
  if (!renewal) return projection;
  const effect = projection.outbox[renewal.payload.effect_id];
  const continuationSupplied = isPlainObject(receipt.result)
    && Object.hasOwn(receipt.result, "provider_entry_window_continuation");
  const continuationRequired = projection.provider_settlement_epoch !== null
    && effect?.effect_contract_version === 2
    && effect.status === "sending";
  if (!continuationRequired) {
    if (continuationSupplied) {
      fail(
        "BUSINESS_PROJECTION_PROVIDER_ENTRY_WINDOW",
        "Only a post-cutover sending V2 lease renewal may carry a provider entry continuation",
        { effect_id: effect?.effect_id || null },
      );
    }
    return projection;
  }
  if (!continuationSupplied) {
    fail(
      "BUSINESS_PROJECTION_PROVIDER_ENTRY_WINDOW",
      "Post-cutover sending V2 lease renewal requires its committed provider entry continuation",
      { effect_id: effect.effect_id },
    );
  }
  const index = projection.provider_entry_windows[effect.effect_id];
  if (!index) {
    fail(
      "BUSINESS_PROJECTION_PROVIDER_ENTRY_WINDOW",
      "Sending renewal has no materialized base provider entry window",
      { effect_id: effect.effect_id },
    );
  }
  const sendReceipt = projection.internal_receipts[index.send_authorization_receipt_id];
  const proof = committedSendProofFromReceipt(sendReceipt, effect.effect_id);
  if (!same(proof.effect, Object.fromEntries(
    OUTBOX_IMMUTABLE_FIELDS.map((field) => [field, effect[field]]),
  ))) {
    fail(
      "BUSINESS_PROJECTION_PROVIDER_ENTRY_WINDOW",
      "Provider entry window base authorization does not bind the renewed Effect",
      { effect_id: effect.effect_id },
    );
  }
  const current = currentProviderEntryWindow(projection, index, proof);
  let nextWindow;
  let nextIndex;
  try {
    nextWindow = normalizeProviderEntryWindowV1(
      receipt.result.provider_entry_window_continuation,
      { committed_send_authorization: proof },
    );
    normalizeProviderEntryWindowReceiptClosureV1({
      committed_send_authorization: proof,
      provider_entry_window: nextWindow,
      internal_receipt: receipt,
    });
    nextIndex = advanceProviderEntryWindowIndexV1({
      committed_send_authorization: proof,
      current_index: index,
      current_window: current.window,
      current_window_internal_receipt: current.window.window_sequence === 0
        ? null
        : current.currentReceipt,
      next_window: nextWindow,
      next_window_internal_receipt: receipt,
    });
  } catch (error) {
    providerEntryWindowFailure(
      "Lease renewal does not extend the exact committed provider entry window chain",
      error,
      effect.effect_id,
    );
  }
  if (nextWindow.source_event.event_id !== renewal.event_id
      || nextWindow.lease_expires_at !== effect.lease?.expires_at
      || !same(nextWindow.authorized_fencing_token, {
        lease_id: effect.lease?.lease_id,
        owner_id: effect.lease?.owner_id,
        generation: effect.lease?.generation,
      })) {
    fail(
      "BUSINESS_PROJECTION_PROVIDER_ENTRY_WINDOW",
      "Provider entry continuation does not bind the current renewed lease",
      { effect_id: effect.effect_id },
    );
  }
  return {
    ...projection,
    provider_entry_windows: withMapEntry(
      projection.provider_entry_windows,
      effect.effect_id,
      nextIndex,
    ),
  };
}

function validateDurableInputClosure(projection, workOrder) {
  const engineContractVersion = workOrderEngineContractVersion(workOrder);
  assertWorkOrderEffectContracts(projection, workOrder);
  if (engineContractVersion === 1) return;
  const lifecycleSnapshot = requireLifecycleSnapshot(projection, workOrder);
  for (const branch of Object.values(workOrder.branches)) {
    const currentMutations = Object.values(projection.outbox).filter((effect) => (
      effectMatchesCurrentAttempt(effect, workOrder, branch)
    ));
    const unresolvedStarts = currentMutations.filter((effect) => (
      ["provider.thread.create", "provider.turn.start"].includes(effect.effect_kind)
        && UNRESOLVED_MUTATING_EFFECT_STATES.has(effect.status)
    ));
    if (branch.pending_user_input_effect_id !== null) {
      const inputEffect = projection.outbox[branch.pending_user_input_effect_id];
      if (!inputEffect
          || inputEffect.effect_contract_version !== 2
          || inputEffect.work_order_id !== workOrder.work_order_id
          || inputEffect.branch_ref !== branch.branch_ref
          || inputEffect.effect_kind !== "provider.user_input.submit"
          || !["pending", "claimed", "sending", "delivery_unknown"].includes(inputEffect.status)) {
        fail(
          "BUSINESS_PROJECTION_RECEIPT_BINDING",
          "A retained user-input submission must remain one unresolved exact V2 effect",
        );
      }
    }
    if (branch.state === "dispatch_pending") {
      const currentStarts = Object.values(projection.outbox).filter((effect) => (
        effect.work_order_id === workOrder.work_order_id
          && effect.branch_ref === branch.branch_ref
          && effect.attempt === branch.attempt
          && effect.dispatch_id === branch.dispatch_id
          && ["provider.thread.create", "provider.turn.start"].includes(effect.effect_kind)
          && ["pending", "claimed", "sending"].includes(effect.status)
      ));
      if (currentStarts.length !== 1) {
        fail(
          "BUSINESS_PROJECTION_RECEIPT_BINDING",
          "A dispatch-pending branch must close with exactly one unresolved provider start stage",
        );
      }
    }
    if (branch.state === "delivery_unknown") {
      const ambiguousStart = unresolvedStarts.length === 1 ? unresolvedStarts[0] : null;
      if (!ambiguousStart
          || !["sending", "delivery_unknown"].includes(ambiguousStart.status)
          || (ambiguousStart.status === "delivery_unknown"
            && branch.delivery?.classification !== "delivery_unknown")
          || currentMutations.some((effect) => (
            UNRESOLVED_MUTATING_EFFECT_STATES.has(effect.status)
              && effect.effect_id !== ambiguousStart.effect_id
          ))
          || !hasOpenDeliveryReconciliationAttention(
            projection,
            workOrder,
            branch,
            ambiguousStart,
          )) {
        fail(
          "BUSINESS_PROJECTION_RECEIPT_BINDING",
          "A delivery-unknown branch must retain one exact ambiguous start and reconciliation attention",
        );
      }
    } else if (branch.state !== "dispatch_pending"
        && unresolvedStarts.length !== 0) {
      fail(
        "BUSINESS_PROJECTION_RECEIPT_BINDING",
        "Only a dispatch or reconciliation branch may retain an unresolved provider start",
      );
    }
    if (["running", "waiting_for_user", "verifying", "cancelling"].includes(branch.state)
        && !acceptedCurrentTurn(projection, workOrder, branch)) {
      fail(
        "BUSINESS_PROJECTION_RECEIPT_BINDING",
        "A turn-bound branch must retain one accepted current provider turn",
      );
    }
    if (TERMINAL_BRANCH_STATE_SET.has(branch.state)) {
      const unresolved = Object.values(projection.outbox).filter((effect) => (
        effectMatchesCurrentAttempt(effect, workOrder, branch)
          && UNRESOLVED_MUTATING_EFFECT_STATES.has(effect.status)
      ));
      if (unresolved.length !== 0) {
        fail(
          "BUSINESS_PROJECTION_RECEIPT_BINDING",
          "A terminal branch cannot retain an unresolved current provider mutation",
        );
      }
      if (branch.open_user_input !== null) {
        fail(
          "BUSINESS_PROJECTION_RECEIPT_BINDING",
          "A terminal branch cannot retain an open user-input request",
        );
      }
    }
    if (branch.state === "cancelling" && branch.open_user_input !== null) {
      const inputEffect = branch.pending_user_input_effect_id === null
        ? null
        : projection.outbox[branch.pending_user_input_effect_id];
      if (!inputEffect || !["sending", "delivery_unknown"].includes(inputEffect.status)) {
        fail(
          "BUSINESS_PROJECTION_RECEIPT_BINDING",
          "A cancelling branch may retain an open user-input request only while its exact submission may already have been sent",
        );
      }
    }
    if (branch.state === "cancelling"
        && !exactCurrentCancelEffect(projection, workOrder, branch)
        && !hasOpenCancelAttention(workOrder, branch)) {
      fail(
        "BUSINESS_PROJECTION_RECEIPT_BINDING",
        "A cancelling runtime must retain one exact cancel effect or explicit cancel attention",
      );
    }
  }
  if (TERMINAL_WORK_ORDER_STATE_SET.has(workOrder.status)) {
    const nonterminalBranches = Object.values(workOrder.branches).filter((branch) => (
      !TERMINAL_BRANCH_STATE_SET.has(branch.state)
    ));
    const unresolvedEffects = Object.values(projection.outbox).filter((effect) => (
      effect.work_order_id === workOrder.work_order_id
        && UNRESOLVED_MUTATING_EFFECT_STATES.has(effect.status)
    ));
    if (nonterminalBranches.length !== 0 || unresolvedEffects.length !== 0) {
      fail(
        "BUSINESS_PROJECTION_RECEIPT_BINDING",
        "A terminal Work Order requires terminal branches and no unresolved effect from any attempt",
      );
    }
  }
  if (workOrder.status === "paused") {
    const invalidBranches = Object.values(workOrder.branches).filter((branch) => (
      !["blocked", "delivery_unknown", "cancelling", "accepted", "failed", "cancelled"]
        .includes(branch.state)
    ));
    if (invalidBranches.length !== 0) {
      fail(
        "BUSINESS_PROJECTION_RECEIPT_BINDING",
        "A paused Work Order cannot retain forward-runnable branch views",
        { automation_state: lifecycleSnapshot.automation.state },
      );
    }
  }
  if (workOrder.status === "cancelling") {
    const invalidBranches = Object.values(workOrder.branches).filter((branch) => (
      !["delivery_unknown", "cancelling", "accepted", "failed", "cancelled"]
        .includes(branch.state)
    ));
    const orphanedUnsentStarts = Object.values(projection.outbox).filter((effect) => (
      effect.work_order_id === workOrder.work_order_id
        && ["provider.thread.create", "provider.turn.start"].includes(effect.effect_kind)
        && ["pending", "claimed"].includes(effect.status)
    ));
    if (invalidBranches.length !== 0 || orphanedUnsentStarts.length !== 0) {
      fail(
        "BUSINESS_PROJECTION_RECEIPT_BINDING",
        "A cancelling Work Order cannot retain runnable branches or orphaned unsent starts",
      );
    }
  }
}

function reduceReceipt(projection, event, batchContext) {
  const [sourceType, mapName] = RECEIPT_TYPES[event.type];
  const payload = requireSpecificFields(event, ["receipt"]);
  const workOrder = requireWorkOrder(projection, event);
  const pending = workOrder.pending_projection_input;
  if (!pending || pending.source_id !== payload.source_id) {
    fail("BUSINESS_PROJECTION_RECEIPT_BINDING", "A receipt must close its current projection input");
  }
  if (pending.source_type && pending.source_type !== sourceType) {
    fail("BUSINESS_PROJECTION_SOURCE_CLASS", "Receipt source type does not match its domain events");
  }
  for (const type of pending.event_types || []) assertEventAllowedForSource(type, sourceType);
  if (sourceType === "internal_action") {
    if (payload.target_work_order_revision !== payload.prior_work_order_revision) {
      fail("BUSINESS_PROJECTION_REVISION", "Internal actions must not advance the business revision");
    }
  } else if (payload.target_work_order_revision !== payload.prior_work_order_revision + 1) {
    fail("BUSINESS_PROJECTION_REVISION", "Commands and observations must advance the business revision once");
  }
  validateReceiptBatch(event, batchContext);
  if (["observation", PROVIDER_SETTLEMENT_SOURCE_TYPE].includes(sourceType)) {
    validateRecoveryProbeReceipt(projection, payload, batchContext);
    validateSettlementPolicyEventCoherence(projection, workOrder, batchContext);
    validateSendExpiryReceipt(payload, batchContext);
  }
  const receipt = normalizeReceipt(
    payload.receipt,
    sourceType,
    event,
    pending,
    normalizedBatchId(batchContext),
  );
  validateSendAuthorizationReceipt(receipt, batchContext);
  validateProviderSettlementReceiptBundle(projection, receipt, batchContext);
  validateDurableInputClosure(projection, workOrder);
  const collision = findReceipt(projection, receipt.source_id);
  if (collision) {
    if (collision[0] === mapName && same(collision[1], receipt)) return projection;
    fail("BUSINESS_PROJECTION_ID_CONFLICT", "A receipt identifier was reused with conflicting content", {
      source_id: receipt.source_id,
    });
  }
  const withProviderEntryWindow = materializeProviderEntryWindow(
    projection,
    receipt,
    batchContext,
  );
  const nextWorkOrder = { ...workOrder, pending_projection_input: null };
  return {
    ...replaceWorkOrder(withProviderEntryWindow, nextWorkOrder),
    [mapName]: withMapEntry(
      withProviderEntryWindow[mapName],
      receipt.source_id,
      receipt,
    ),
  };
}

function normalizeAttention(value, event) {
  const attention = exact(
    value,
    new Set([
      "attention_id",
      "kind",
      "branch_ref",
      "effect_id",
      "detail_ref",
      "evidence_refs",
      "opened_at",
    ]),
    new Set(["attention_id", "kind", "branch_ref", "detail_ref", "evidence_refs", "opened_at"]),
    "event.payload.attention",
  );
  const normalized = {
    attention_id: portableRef(attention.attention_id, "event.payload.attention.attention_id"),
    kind: portableRef(attention.kind, "event.payload.attention.kind"),
    branch_ref: attention.branch_ref === null ? null : portableRef(attention.branch_ref, "event.payload.attention.branch_ref"),
    effect_id: attention.effect_id === undefined || attention.effect_id === null
      ? null
      : portableRef(attention.effect_id, "event.payload.attention.effect_id"),
    detail_ref: contentRef(attention.detail_ref, "event.payload.attention.detail_ref"),
    evidence_refs: stringArray(attention.evidence_refs, "event.payload.attention.evidence_refs", { minimum: 1 }),
    opened_at: timestamp(attention.opened_at, "event.payload.attention.opened_at"),
    status: "open",
    resolution: null,
  };
  if (normalized.opened_at !== event.payload.occurred_at) {
    fail("BUSINESS_PROJECTION_INVALID", "Attention open time must equal the event time");
  }
  return normalized;
}

function reduceAttentionOpened(projection, event) {
  const payload = requireSpecificFields(event, ["attention"]);
  const workOrder = requireWorkOrder(projection, event);
  const attention = normalizeAttention(payload.attention, event);
  if (attention.branch_ref !== null) requireBranch(workOrder, attention.branch_ref);
  if (attention.effect_id !== null) {
    const effect = projection.outbox[attention.effect_id];
    if (!effect
        || effect.work_order_id !== workOrder.work_order_id
        || effect.branch_ref !== attention.branch_ref) {
      fail(
        "BUSINESS_PROJECTION_OUTBOX_BINDING",
        "Effect-scoped attention must bind an effect in the same Work Order branch",
      );
    }
  }
  const existing = workOrder.attention[attention.attention_id];
  if (existing) {
    if (same(existing, attention)) return projection;
    fail("BUSINESS_PROJECTION_ID_CONFLICT", "An attention identifier was reused", {
      attention_id: attention.attention_id,
    });
  }
  return replaceWorkOrder(projection, {
    ...workOrder,
    attention: withMapEntry(workOrder.attention, attention.attention_id, attention),
  });
}

function reduceAttentionResolved(projection, event) {
  const payload = requireSpecificFields(event, ["attention_id", "resolution_ref", "evidence_refs"]);
  const workOrder = requireWorkOrder(projection, event);
  const attentionId = portableRef(payload.attention_id, "event.payload.attention_id");
  const attention = workOrder.attention[attentionId];
  if (!attention) fail("BUSINESS_PROJECTION_ATTENTION_MISSING", "The attention record does not exist");
  if (attention.status !== "open") fail("BUSINESS_PROJECTION_TRANSITION", "Attention is already resolved");
  const resolution = {
    resolution_ref: contentRef(payload.resolution_ref, "event.payload.resolution_ref"),
    evidence_refs: stringArray(payload.evidence_refs, "event.payload.evidence_refs", { minimum: 1 }),
    resolved_at: payload.occurred_at,
  };
  return replaceWorkOrder(projection, {
    ...workOrder,
    attention: withMapEntry(workOrder.attention, attentionId, {
      ...attention,
      status: "resolved",
      resolution,
    }),
  });
}

const REDUCERS = Object.freeze({
  "business.work_order.created": reduceWorkOrderCreated,
  "business.work_order.status_changed": reduceWorkOrderStatus,
  "business.context_budget.verified": reduceContextBudget,
  "business.branch.initialized": reduceBranchInitialized,
  "business.branch.attempt_opened": reduceAttemptOpened,
  "business.branch.status_changed": reduceBranchStatus,
  "business.branch.runtime_observed": reduceRuntimeObserved,
  "business.verification.recorded": reduceVerification,
  "business.review.recorded": reduceReview,
  "business.acceptance.recorded": reduceAcceptance,
  "business.late_observation.quarantined": reduceLateObservation,
  "business.recovery_probe.recorded": reduceRecoveryProbeRecorded,
  "business.outbox.enqueued": reduceOutboxEnqueued,
  "business.outbox.claimed": reduceOutboxClaimed,
  "business.outbox.send_begun": reduceOutboxSendBegun,
  "business.outbox.lease_renewed": reduceOutboxLeaseRenewed,
  "business.outbox.requeued": reduceOutboxRequeued,
  "business.outbox.send_expired": reduceOutboxSendExpired,
  "business.outbox.delivered": (projection, event) => reduceOutboxSettled(projection, event, "delivered"),
  "business.outbox.not_sent": (projection, event) => reduceOutboxSettled(projection, event, "not_sent"),
  "business.outbox.delivery_unknown": (projection, event) => reduceOutboxSettled(projection, event, "delivery_unknown"),
  "business.outbox.cancelled": reduceOutboxCancelled,
  "business.command.received": reduceReceipt,
  "business.observation.received": reduceReceipt,
  "business.provider_settlement.received": reduceReceipt,
  "business.internal_action.received": reduceReceipt,
  "business.attention.opened": reduceAttentionOpened,
  "business.attention.resolved": reduceAttentionResolved,
});

function providerSettlementCutoverBatchCore(batchContext) {
  if (!isPlainObject(batchContext) || !Array.isArray(batchContext.events)) {
    fail(
      "BUSINESS_PROJECTION_PROVIDER_SETTLEMENT_CUTOVER",
      "Provider-settlement cutover events require their complete atomic batch",
    );
  }
  return {
    expected_revision: batchContext.expected_revision,
    batch_id: batchContext.batch_id,
    actor: batchContext.actor,
    correlation_id: batchContext.correlation_id,
    events: batchContext.events,
  };
}

function projectProviderSettlementCutoverEvent(projection, event, batchContext) {
  const core = providerSettlementCutoverBatchCore(batchContext);
  let epoch;
  try {
    epoch = deriveProviderSettlementEpochFromBatchV1(core);
  } catch (error) {
    fail(
      "BUSINESS_PROJECTION_PROVIDER_SETTLEMENT_CUTOVER",
      "Provider-settlement cutover batch is not the exact canonical activation unit",
      { cause_code: error?.code || null },
    );
  }
  const ordinal = event.type === PROVIDER_SETTLEMENT_ACTIVATED_EVENT ? 0 : 1;
  if (!same(event, normalizeEvent(core.events[ordinal]))) {
    fail(
      "BUSINESS_PROJECTION_PROVIDER_SETTLEMENT_CUTOVER",
      "The projected cutover event is not in its canonical batch position",
    );
  }
  if (projection.provider_settlement_epoch !== null) {
    if (same(projection.provider_settlement_epoch, epoch)) return projection;
    fail(
      "BUSINESS_PROJECTION_ID_CONFLICT",
      "Provider-settlement contract was already activated by a different epoch",
      { active_cutover_id: projection.provider_settlement_epoch.cutover_id },
    );
  }
  if (event.type !== PROVIDER_SETTLEMENT_ACTIVATED_EVENT) {
    fail(
      "BUSINESS_PROJECTION_PROVIDER_SETTLEMENT_CUTOVER",
      "The cutover receipt cannot be projected before its activation event",
    );
  }
  const actualProjectionHash = canonicalHash(projection);
  if (epoch.pre_cutover_projection_hash !== actualProjectionHash) {
    fail(
      "BUSINESS_PROJECTION_PROVIDER_SETTLEMENT_CUTOVER",
      "Cutover readiness does not bind the exact pre-activation Business projection",
      {
        expected_projection_hash: epoch.pre_cutover_projection_hash,
        actual_projection_hash: actualProjectionHash,
      },
    );
  }
  return {
    ...projection,
    provider_settlement_epoch: epoch,
  };
}

function projectBusinessEventV1(inputProjection, inputEvent, batchContext) {
  let projection = normalizeProjection(inputProjection);
  const event = normalizeEvent(inputEvent);
  if (GLOBAL_EVENT_TYPES.has(event.type)) {
    return trustProjection(projectProviderSettlementCutoverEvent(
      projection,
      event,
      batchContext,
    ));
  }
  const batchSourceType = validateAtomicBatchStart(projection, event, batchContext);
  const begun = beginInput(projection, event, batchContext, batchSourceType);
  if (begun.duplicate) return trustProjection(begun.projection);
  projection = begun.projection;
  const reducer = REDUCERS[event.type];
  projection = event.type === "business.work_order.created"
    ? reducer(projection, event, begun.batchId)
    : RECEIPT_TYPES[event.type]
      ? reducer(projection, event, batchContext)
      : reducer(projection, event);
  return trustProjection(projection);
}

function replayBusinessProjectionV1(entries, initialProjection = initialBusinessProjectionV1()) {
  if (!Array.isArray(entries)) {
    fail("BUSINESS_PROJECTION_INVALID", "Replay entries must be an array", { path: "entries" });
  }
  let projection = initialProjection;
  for (const [index, entry] of entries.entries()) {
    if (isPlainObject(entry) && Array.isArray(entry.events)) {
      for (const event of entry.events) projection = projectBusinessEventV1(projection, event, entry);
    } else {
      projection = projectBusinessEventV1(projection, entry);
    }
  }
  for (const workOrder of Object.values(projection.work_orders)) {
    if (workOrder.pending_projection_input !== null) {
      fail("BUSINESS_PROJECTION_RECEIPT_BINDING", "Replay ended with an input that has no durable receipt", {
        work_order_id: workOrder.work_order_id,
        source_id: workOrder.pending_projection_input.source_id,
      });
    }
  }
  return projection;
}

function businessProjectionConfigurationV1() {
  return {
    initialState: initialBusinessProjectionV1(),
    reducers: Object.fromEntries(BUSINESS_EVENT_TYPES.map((type) => [
      type,
      (state, event, batch) => projectBusinessEventV1(state, event, batch),
    ])),
  };
}

module.exports = {
  BRANCH_STATES,
  BUSINESS_EVENT_TYPES,
  BUSINESS_PROJECTION_VERSION,
  BusinessProjectionError,
  OUTBOX_IMMUTABLE_FIELDS,
  TERMINAL_WORK_ORDER_STATES,
  WORK_ORDER_STATES,
  businessProjectionConfigurationV1,
  initialBusinessProjectionV1,
  projectBusinessEventV1,
  replayBusinessProjectionV1,
};
