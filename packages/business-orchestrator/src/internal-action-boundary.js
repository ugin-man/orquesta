"use strict";

const { canonicalHash, canonicalJson } = require("@orquesta/contracts");
const { BUSINESS_ENGINE_CONTRACT_VERSION } = require("./contract");
const {
  BUSINESS_EVENT_TYPES,
  OUTBOX_IMMUTABLE_FIELDS,
  businessProjectionConfigurationV1,
  projectBusinessEventV1,
} = require("./projector");
const {
  normalizeDispatchPacketSendAuthorizationVerificationV1,
} = require("./packet-store");
const {
  BusinessSendAuthorizationError,
  SEND_AUTHORIZATION_CONTRACT_VERSION,
  createCommittedSendAuthorizationProofV2,
  createSendAuthorizationBundleV1,
} = require("./send-authorization");
const {
  BusinessProviderEntryWindowError,
  createProviderEntryWindowAnchorV1,
  createProviderEntryWindowContinuationV1,
  normalizeProviderEntryWindowIndexV1,
  normalizeProviderEntryWindowV1,
} = require("./provider-entry-window");

const INTERNAL_ACTION_ENVELOPE_VERSION = 1;
const MAX_ENVELOPE_BYTES = 65_536;
const MAX_REF_BYTES = 256;
const MAX_REASON_BYTES = 4_096;
const RECEIPT_NOT_FOUND = Symbol("business-internal-action-receipt-not-found");
const ACTION_NAMES = Object.freeze([
  "outbox.claim",
  "outbox.send.begin",
  "outbox.lease.renew",
  "outbox.requeue",
]);
const ACTION_NAME_SET = new Set(ACTION_NAMES);
const ENVELOPE_FIELDS = new Set([
  "version",
  "internal_action_id",
  "work_order_id",
  "plan_snapshot_ref",
  "plan_hash",
  "expected_work_order_revision",
  "actor",
  "name",
  "payload",
  "payload_hash",
]);
const ACTOR_FIELDS = new Set(["type", "actor_id"]);
const LEASE_TOKEN_FIELDS = Object.freeze(["lease_id", "owner_id", "generation"]);
const PAYLOAD_FIELDS = Object.freeze({
  "outbox.claim": new Set(["effect_id", "lease_id", "owner_id"]),
  "outbox.send.begin": new Set(["effect_id", ...LEASE_TOKEN_FIELDS]),
  "outbox.lease.renew": new Set(["effect_id", ...LEASE_TOKEN_FIELDS]),
  "outbox.requeue": new Set(["effect_id", ...LEASE_TOKEN_FIELDS, "reason"]),
});
const PRINCIPAL_FIELDS = new Set(["type", "id"]);
const AUTHORITY_FIELDS = new Set([
  "authorized",
  "principal_type",
  "principal_id",
  "work_order_id",
  "effect_id",
  "action",
]);
const EFFECT_FACT_FIELDS = new Set([
  "work_order_id",
  "effect_id",
  "effect",
  "status",
  "lease",
]);
const LEASE_FIELDS = new Set([
  "lease_id",
  "owner_id",
  "generation",
  "claimed_at",
  "heartbeat_at",
  "expires_at",
]);
const BUSINESS_EVENT_TYPE_SET = new Set(BUSINESS_EVENT_TYPES);

class BusinessInternalActionBoundaryError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "BusinessInternalActionBoundaryError";
    this.code = code;
    this.details = details;
  }
}

function boundaryError(code, message, details) {
  return new BusinessInternalActionBoundaryError(code, message, details);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactFields(value, fields) {
  if (!isPlainObject(value)) return false;
  const names = Object.keys(value);
  return names.length === fields.size
    && names.every((name) => fields.has(name))
    && [...fields].every((name) => Object.hasOwn(value, name));
}

function canonicalClone(value, code = "BUSINESS_INTERNAL_ACTION_INVALID") {
  let serialized;
  try {
    serialized = canonicalJson(value);
  } catch (error) {
    throw boundaryError(code, "Value must be bounded canonical JSON", {
      cause_code: error?.code || null,
    });
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_ENVELOPE_BYTES) {
    throw boundaryError(code, "Value exceeds the internal action size limit");
  }
  return JSON.parse(serialized);
}

function text(value, path, maximumBytes = MAX_REF_BYTES) {
  if (typeof value !== "string"
      || value.trim() === ""
      || value.trim() !== value
      || Buffer.byteLength(value, "utf8") > maximumBytes
      || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw boundaryError(
      "BUSINESS_INTERNAL_ACTION_INVALID",
      `${path} must be a bounded, non-empty portable string`,
      { path },
    );
  }
  return value;
}

function integer(value, path, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw boundaryError(
      "BUSINESS_INTERNAL_ACTION_INVALID",
      `${path} must be an integer greater than or equal to ${minimum}`,
      { path },
    );
  }
  return value;
}

function sha256(value, path) {
  const normalized = text(value, path, 64);
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    throw boundaryError(
      "BUSINESS_INTERNAL_ACTION_INVALID",
      `${path} must be a lowercase SHA-256 digest`,
      { path },
    );
  }
  return normalized;
}

function timestamp(value, path) {
  if (typeof value !== "string"
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
      || Number.isNaN(Date.parse(value))
      || new Date(value).toISOString() !== value) {
    throw boundaryError(
      "BUSINESS_INTERNAL_ACTION_FACTS_INVALID",
      `${path} must be a real millisecond UTC timestamp`,
      { path },
    );
  }
  return value;
}

function normalizePayload(name, input) {
  const fields = PAYLOAD_FIELDS[name];
  if (!fields || !hasExactFields(input, fields)) {
    throw boundaryError(
      "BUSINESS_INTERNAL_ACTION_INVALID",
      `payload must exactly match the ${name} action surface`,
    );
  }
  const normalized = {
    effect_id: text(input.effect_id, "payload.effect_id"),
  };
  if (name === "outbox.claim") {
    normalized.lease_id = text(input.lease_id, "payload.lease_id");
    normalized.owner_id = text(input.owner_id, "payload.owner_id");
  } else {
    normalized.lease_id = text(input.lease_id, "payload.lease_id");
    normalized.owner_id = text(input.owner_id, "payload.owner_id");
    normalized.generation = integer(input.generation, "payload.generation", 1);
  }
  if (name === "outbox.requeue") {
    normalized.reason = text(input.reason, "payload.reason", MAX_REASON_BYTES);
  }
  return normalized;
}

function normalizeInternalActionEnvelopeV1(input) {
  const action = canonicalClone(input);
  if (!hasExactFields(action, ENVELOPE_FIELDS)) {
    throw boundaryError(
      "BUSINESS_INTERNAL_ACTION_INVALID",
      "Internal action envelope fields must match V1 exactly",
    );
  }
  if (action.version !== INTERNAL_ACTION_ENVELOPE_VERSION) {
    throw boundaryError(
      "BUSINESS_INTERNAL_ACTION_VERSION",
      `Unsupported internal action envelope version: ${action.version}`,
    );
  }
  const internalActionId = text(action.internal_action_id, "internal_action_id");
  if (!/^INT-[a-f0-9]{32}$/u.test(internalActionId)) {
    throw boundaryError(
      "BUSINESS_INTERNAL_ACTION_INVALID",
      "internal_action_id must be a V1 internal action identifier",
    );
  }
  const workOrderId = text(action.work_order_id, "work_order_id");
  if (!/^WO-[a-f0-9]{32}$/u.test(workOrderId)) {
    throw boundaryError(
      "BUSINESS_INTERNAL_ACTION_INVALID",
      "work_order_id must be a V1 Work Order identifier",
    );
  }
  const planSnapshotRef = text(action.plan_snapshot_ref, "plan_snapshot_ref");
  if (!/^BPS-[a-f0-9]{32}$/u.test(planSnapshotRef)) {
    throw boundaryError(
      "BUSINESS_INTERNAL_ACTION_INVALID",
      "plan_snapshot_ref must be a V1 plan snapshot reference",
    );
  }
  if (!hasExactFields(action.actor, ACTOR_FIELDS)
      || action.actor.type !== "system") {
    throw boundaryError(
      "BUSINESS_INTERNAL_ACTION_ACTOR_INVALID",
      "Internal actions may only assert a system actor",
    );
  }
  const name = text(action.name, "name", 128);
  if (!ACTION_NAME_SET.has(name)) {
    throw boundaryError(
      "BUSINESS_INTERNAL_ACTION_NAME_INVALID",
      `Unsupported internal action: ${name}`,
    );
  }
  const payload = normalizePayload(name, action.payload);
  const payloadHash = sha256(action.payload_hash, "payload_hash");
  if (payloadHash !== canonicalHash(payload)) {
    throw boundaryError(
      "BUSINESS_INTERNAL_ACTION_HASH_MISMATCH",
      "payload_hash does not bind the normalized internal action payload",
    );
  }
  return Object.freeze({
    version: INTERNAL_ACTION_ENVELOPE_VERSION,
    internal_action_id: internalActionId,
    work_order_id: workOrderId,
    plan_snapshot_ref: planSnapshotRef,
    plan_hash: sha256(action.plan_hash, "plan_hash"),
    expected_work_order_revision: integer(
      action.expected_work_order_revision,
      "expected_work_order_revision",
      1,
    ),
    actor: Object.freeze({
      type: "system",
      actor_id: text(action.actor.actor_id, "actor.actor_id"),
    }),
    name,
    payload: Object.freeze(payload),
    payload_hash: payloadHash,
  });
}

function normalizePrincipal(input) {
  const value = input?.principal || input;
  if (!hasExactFields(value, PRINCIPAL_FIELDS)
      || value.type !== "system") {
    throw boundaryError(
      "BUSINESS_INTERNAL_AUTHENTICATION_INVALID",
      "Authenticator must return one exact system principal",
    );
  }
  return Object.freeze({ type: "system", id: text(value.id, "principal.id") });
}

function normalizeAuthority(value, action, principal) {
  if (!hasExactFields(value, AUTHORITY_FIELDS)
      || value.authorized !== true
      || value.principal_type !== principal.type
      || value.principal_id !== principal.id
      || value.work_order_id !== action.work_order_id
      || value.effect_id !== action.payload.effect_id
      || value.action !== action.name) {
    throw boundaryError(
      "BUSINESS_INTERNAL_AUTHORIZATION_DENIED",
      "Authorization must return an exact grant for this system action and effect",
    );
  }
  return Object.freeze(canonicalClone(
    value,
    "BUSINESS_INTERNAL_AUTHORIZATION_DENIED",
  ));
}

function validateAbortSignal(signal) {
  if (signal === undefined || signal === null) return null;
  if (typeof signal !== "object"
      || typeof signal.aborted !== "boolean"
      || typeof signal.addEventListener !== "function"
      || typeof signal.removeEventListener !== "function") {
    throw new TypeError("signal must be an AbortSignal");
  }
  return signal;
}

function throwIfAborted(signal, dependency = null) {
  if (signal?.aborted) {
    throw boundaryError(
      "BUSINESS_INTERNAL_ACTION_ABORTED",
      "Internal action execution was aborted",
      dependency ? { dependency } : {},
    );
  }
}

async function callDependency(name, invoke, externalSignal, timeoutMs) {
  throwIfAborted(externalSignal, name);
  const controller = new AbortController();
  let timer = null;
  let onExternalAbort = null;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(boundaryError(
        "BUSINESS_INTERNAL_DEPENDENCY_TIMEOUT",
        `Dependency ${name} exceeded its bounded execution time`,
        { dependency: name, timeout_ms: timeoutMs },
      ));
    }, timeoutMs);
    if (externalSignal) {
      onExternalAbort = () => {
        controller.abort(externalSignal.reason);
        reject(boundaryError(
          "BUSINESS_INTERNAL_ACTION_ABORTED",
          "Internal action execution was aborted",
          { dependency: name },
        ));
      };
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => invoke(controller.signal)),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
    if (externalSignal && onExternalAbort) {
      externalSignal.removeEventListener("abort", onExternalAbort);
    }
  }
}

function effectIdentity(effect) {
  return Object.fromEntries(
    OUTBOX_IMMUTABLE_FIELDS.map((field) => [field, effect[field]]),
  );
}

function normalizeLeaseFact(value) {
  if (value === null) return null;
  if (!hasExactFields(value, LEASE_FIELDS)) {
    throw boundaryError(
      "BUSINESS_INTERNAL_ACTION_FACTS_INVALID",
      "Resolved lease facts must match the current lease surface exactly",
    );
  }
  return {
    lease_id: text(value.lease_id, "facts.lease.lease_id"),
    owner_id: text(value.owner_id, "facts.lease.owner_id"),
    generation: integer(value.generation, "facts.lease.generation", 1),
    claimed_at: timestamp(value.claimed_at, "facts.lease.claimed_at"),
    heartbeat_at: timestamp(value.heartbeat_at, "facts.lease.heartbeat_at"),
    expires_at: timestamp(value.expires_at, "facts.lease.expires_at"),
  };
}

function normalizeEffectFacts(input, action, projectedEffect) {
  const value = canonicalClone(input, "BUSINESS_INTERNAL_ACTION_FACTS_INVALID");
  if (!hasExactFields(value, EFFECT_FACT_FIELDS)
      || !hasExactFields(value.effect, new Set(OUTBOX_IMMUTABLE_FIELDS))) {
    throw boundaryError(
      "BUSINESS_INTERNAL_ACTION_FACTS_INVALID",
      "Resolver must return the exact bounded effect and lease fact surface",
    );
  }
  const normalized = {
    work_order_id: text(value.work_order_id, "facts.work_order_id"),
    effect_id: text(value.effect_id, "facts.effect_id"),
    effect: value.effect,
    status: text(value.status, "facts.status", 64),
    lease: normalizeLeaseFact(value.lease),
  };
  const expectedIdentity = effectIdentity(projectedEffect);
  if (normalized.work_order_id !== action.work_order_id
      || normalized.effect_id !== action.payload.effect_id
      || normalized.effect_id !== projectedEffect.effect_id
      || normalized.status !== projectedEffect.status
      || canonicalJson(normalized.effect) !== canonicalJson(expectedIdentity)
      || canonicalJson(normalized.lease) !== canonicalJson(projectedEffect.lease)) {
    throw boundaryError(
      "BUSINESS_INTERNAL_ACTION_FACTS_STALE",
      "Resolved effect or lease facts do not match the authoritative projection",
      { effect_id: action.payload.effect_id },
    );
  }
  return Object.freeze(normalized);
}

function assertLeaseToken(action, lease) {
  if (!lease
      || action.payload.lease_id !== lease.lease_id
      || action.payload.owner_id !== lease.owner_id
      || action.payload.generation !== lease.generation) {
    throw boundaryError(
      "BUSINESS_INTERNAL_ACTION_LEASE_MISMATCH",
      "Internal action does not possess the current lease fencing token",
      { effect_id: action.payload.effect_id },
    );
  }
}

function validateClockValue(value) {
  try {
    return timestamp(value, "clock");
  } catch (error) {
    throw boundaryError(
      "BUSINESS_INTERNAL_ACTION_CLOCK_INVALID",
      "Internal action clock must return a real millisecond UTC timestamp",
      { cause_code: error?.code || null },
    );
  }
}

function expectedLeaseExpiry(workOrder, occurredAt) {
  const duration = workOrder?.plan?.lease_policy?.lease_duration_ms;
  if (!Number.isSafeInteger(duration) || duration <= 0) {
    throw boundaryError(
      "BUSINESS_WORK_ORDER_PROJECTION_INVALID",
      "Work Order projection is missing its immutable lease duration",
    );
  }
  const expiresAt = new Date(Date.parse(occurredAt) + duration).toISOString();
  return expiresAt;
}

function commonPayload(action, revision, occurredAt) {
  return {
    work_order_id: action.work_order_id,
    plan_snapshot_ref: action.plan_snapshot_ref,
    plan_hash: action.plan_hash,
    source_id: action.internal_action_id,
    prior_work_order_revision: revision,
    target_work_order_revision: revision,
    occurred_at: occurredAt,
  };
}

function actionIntent(
  action,
  workOrder,
  effect,
  occurredAt,
  sendAuthorizationVerification = null,
  providerSettlementCutoverId = null,
) {
  const common = commonPayload(action, workOrder.revision, occurredAt);
  const identity = effectIdentity(effect);
  if (action.name === "outbox.claim") {
    return {
      type: "business.outbox.claimed",
      payload: {
        ...common,
        effect_id: effect.effect_id,
        effect: identity,
        lease: {
          lease_id: action.payload.lease_id,
          owner_id: action.payload.owner_id,
          generation: effect.lease_generation + 1,
          claimed_at: occurredAt,
          heartbeat_at: occurredAt,
          expires_at: expectedLeaseExpiry(workOrder, occurredAt),
        },
      },
      evidence_refs: [],
      outboxStatus: "claimed",
    };
  }
  assertLeaseToken(action, effect.lease);
  if (action.name === "outbox.send.begin") {
    const packetVerificationReceipt = sendAuthorizationVerification
      ?.packet_verification_receipt || null;
    const operationScopeBinding = sendAuthorizationVerification
      ?.operation_scope_binding || null;
    if (effect.effect_contract_version !== 2
        || effect.status !== "claimed"
        || packetVerificationReceipt === null
        || operationScopeBinding === null
        || providerSettlementCutoverId === null
        || Date.parse(occurredAt) >= Date.parse(effect.lease.expires_at)) {
      throw boundaryError(
        "BUSINESS_INTERNAL_SEND_NOT_AUTHORIZED",
        "Send begin requires one current claimed Effect V2, lease, and packet verification receipt",
        { effect_id: effect.effect_id },
      );
    }
    return {
      type: "business.outbox.send_begun",
      payload: {
        ...common,
        effect_id: effect.effect_id,
        effect: identity,
        lease_id: effect.lease.lease_id,
        lease_owner_id: effect.lease.owner_id,
        lease_generation: effect.lease.generation,
        lease_expires_at: effect.lease.expires_at,
        packet_verification_receipt: packetVerificationReceipt,
        provider_settlement_cutover_id: providerSettlementCutoverId,
        operation_scope_binding: operationScopeBinding,
        send_authorization_contract_version: SEND_AUTHORIZATION_CONTRACT_VERSION,
      },
      evidence_refs: [],
      outboxStatus: "sending",
    };
  }
  if (action.name === "outbox.lease.renew") {
    return {
      type: "business.outbox.lease_renewed",
      payload: {
        ...common,
        effect_id: effect.effect_id,
        effect: identity,
        lease: {
          ...effect.lease,
          heartbeat_at: occurredAt,
          expires_at: expectedLeaseExpiry(workOrder, occurredAt),
        },
      },
      evidence_refs: [],
      outboxStatus: effect.status,
    };
  }
  if (action.name === "outbox.requeue") {
    return {
      type: "business.outbox.requeued",
      payload: {
        ...common,
        effect_id: effect.effect_id,
        effect: identity,
        lease_id: effect.lease.lease_id,
        lease_owner_id: effect.lease.owner_id,
        lease_generation: effect.lease.generation,
        reason: action.payload.reason,
      },
      evidence_refs: [],
      outboxStatus: "pending",
    };
  }
  throw boundaryError(
    "BUSINESS_INTERNAL_ACTION_NAME_INVALID",
    "The internal action has no supported lifecycle transition",
  );
}

function normalizeEvent(intent, sourceId, ordinal) {
  if (!isPlainObject(intent)
      || !BUSINESS_EVENT_TYPE_SET.has(intent.type)
      || !isPlainObject(intent.payload)
      || !Array.isArray(intent.evidence_refs)) {
    throw boundaryError(
      "BUSINESS_INTERNAL_ACTION_DECISION_INVALID",
      "Internal action produced an unsupported event",
    );
  }
  const payload = canonicalClone(intent.payload, "BUSINESS_INTERNAL_ACTION_DECISION_INVALID");
  const evidenceRefs = canonicalClone(
    intent.evidence_refs,
    "BUSINESS_INTERNAL_ACTION_DECISION_INVALID",
  );
  return {
    event_id: `BVE-${canonicalHash({
      source_id: sourceId,
      ordinal,
      type: intent.type,
      payload,
      evidence_refs: evidenceRefs,
    }).slice(0, 32)}`,
    schema_version: 1,
    type: intent.type,
    payload,
    evidence_refs: evidenceRefs,
  };
}

function actionIdentityHash(action, principal) {
  return canonicalHash({
    source_type: "internal_action",
    internal_action: action,
    authenticated_principal: principal,
  });
}

function resultFor(
  action,
  workOrder,
  intent,
  sendAuthorizationBundle = null,
  providerEntryWindowContinuation = null,
) {
  const result = {
    internal_action_id: action.internal_action_id,
    work_order_id: action.work_order_id,
    work_order_revision: workOrder.revision,
    effect_id: action.payload.effect_id,
    action: action.name,
    outbox_status: intent.outboxStatus,
  };
  if (action.name === "outbox.claim") {
    result.fencing_token = {
      lease_id: intent.payload.lease.lease_id,
      owner_id: intent.payload.lease.owner_id,
      generation: intent.payload.lease.generation,
    };
  } else if (action.name === "outbox.send.begin") {
    result.fencing_token = {
      lease_id: intent.payload.lease_id,
      owner_id: intent.payload.lease_owner_id,
      generation: intent.payload.lease_generation,
    };
    result.packet_verification_receipt = intent.payload.packet_verification_receipt;
    result.send_authorization_bundle = sendAuthorizationBundle;
  } else if (action.name === "outbox.lease.renew"
      && providerEntryWindowContinuation !== null) {
    result.fencing_token = {
      lease_id: intent.payload.lease.lease_id,
      owner_id: intent.payload.lease.owner_id,
      generation: intent.payload.lease.generation,
    };
    result.provider_entry_window_continuation = providerEntryWindowContinuation;
  }
  return result;
}

function atomicRequest(
  action,
  principal,
  workOrder,
  effect,
  identityHash,
  occurredAt,
  sendAuthorizationVerification = null,
  providerSettlementCutoverId = null,
  providerEntryContext = null,
) {
  const intent = actionIntent(
    action,
    workOrder,
    effect,
    occurredAt,
    sendAuthorizationVerification,
    providerSettlementCutoverId,
  );
  const domainEvent = normalizeEvent(intent, action.internal_action_id, 0);
  const batchId = `business:${action.internal_action_id}`;
  let sendAuthorizationBundle = null;
  if (action.name === "outbox.send.begin") {
    try {
      sendAuthorizationBundle = createSendAuthorizationBundleV1({
        send_event: domainEvent,
        batch_id: batchId,
      });
    } catch (error) {
      if (!(error instanceof BusinessSendAuthorizationError)) throw error;
      throw boundaryError(
        "BUSINESS_INTERNAL_ACTION_DECISION_INVALID",
        "Send authorization bundle could not be derived from the exact send event",
        { cause_code: error.code },
      );
    }
  }
  let providerEntryWindowContinuation = null;
  if (providerEntryContext !== null) {
    try {
      providerEntryWindowContinuation = createProviderEntryWindowContinuationV1({
        committed_send_authorization: providerEntryContext.proof,
        previous_window: providerEntryContext.currentWindow,
        renewal_event: domainEvent,
        batch_id: batchId,
      });
    } catch (error) {
      if (!(error instanceof BusinessProviderEntryWindowError)) throw error;
      throw boundaryError(
        "BUSINESS_INTERNAL_ACTION_DECISION_INVALID",
        "Lease renewal continuation could not be derived from the current provider entry window",
        { effect_id: effect.effect_id, cause_code: error.code },
      );
    }
  }
  const result = resultFor(
    action,
    workOrder,
    intent,
    sendAuthorizationBundle,
    providerEntryWindowContinuation,
  );
  const receipt = {
    source_id: action.internal_action_id,
    source_type: "internal_action",
    identity_hash: identityHash,
    payload_hash: action.payload_hash,
    work_order_id: action.work_order_id,
    applied_revision: workOrder.revision,
    batch_id: batchId,
    event_ids: [domainEvent.event_id],
    result,
  };
  const receiptEvent = normalizeEvent({
    type: "business.internal_action.received",
    payload: {
      ...commonPayload(action, workOrder.revision, occurredAt),
      receipt,
    },
    evidence_refs: [],
  }, action.internal_action_id, 1);
  return {
    expected_revision: null,
    batch_id: batchId,
    actor: { type: "system", id: principal.id },
    correlation_id: action.internal_action_id,
    events: [domainEvent, receiptEvent],
    result,
  };
}

function projectorConfiguration() {
  return businessProjectionConfigurationV1();
}

function normalizeReplay(input) {
  if (!isPlainObject(input)
      || !isPlainObject(input.state)
      || !isPlainObject(input.watermark)
      || !Number.isSafeInteger(input.watermark.journal_sequence)
      || input.watermark.journal_sequence < 0
      || !isPlainObject(input.state.work_orders)
      || !isPlainObject(input.state.outbox)
      || !isPlainObject(input.state.internal_receipts)
      || !isPlainObject(input.state.provider_entry_windows)) {
    throw boundaryError(
      "BUSINESS_INTERNAL_PROJECTION_INVALID",
      "EventStore replay returned an invalid Business projection or watermark",
    );
  }
  return input;
}

function readReceipt(projection, action, identityHash) {
  const receipt = projection.internal_receipts[action.internal_action_id];
  if (receipt === undefined) return RECEIPT_NOT_FOUND;
  if (!isPlainObject(receipt)
      || receipt.source_id !== action.internal_action_id
      || receipt.source_type !== "internal_action"
      || typeof receipt.identity_hash !== "string"
      || !Object.hasOwn(receipt, "result")) {
    throw boundaryError(
      "BUSINESS_INTERNAL_ACTION_RECEIPT_INVALID",
      "Stored internal action receipt is malformed",
      { internal_action_id: action.internal_action_id },
    );
  }
  if (receipt.identity_hash !== identityHash) {
    throw boundaryError(
      "BUSINESS_INTERNAL_ACTION_ID_CONFLICT",
      "Internal action ID is already bound to different immutable content or principal",
      { internal_action_id: action.internal_action_id },
    );
  }
  return canonicalClone(receipt.result, "BUSINESS_INTERNAL_ACTION_RECEIPT_INVALID");
}

function providerEntryWindowContext(projection, effect) {
  const index = projection.provider_entry_windows?.[effect.effect_id];
  if (!isPlainObject(index)) {
    throw boundaryError(
      "BUSINESS_INTERNAL_PROVIDER_ENTRY_WINDOW_MISSING",
      "Sending lease renewal requires its materialized provider entry window index",
      { effect_id: effect.effect_id },
    );
  }
  const sendReceipt = projection.internal_receipts[index.send_authorization_receipt_id];
  const currentReceipt = projection.internal_receipts[index.current_window_receipt_id];
  if (!isPlainObject(sendReceipt) || !isPlainObject(currentReceipt)) {
    throw boundaryError(
      "BUSINESS_INTERNAL_PROVIDER_ENTRY_WINDOW_MISSING",
      "Provider entry window index points to a missing committed receipt",
      { effect_id: effect.effect_id },
    );
  }
  try {
    const proof = createCommittedSendAuthorizationProofV2({
      send_authorization_bundle: sendReceipt.result?.send_authorization_bundle,
      internal_receipt: sendReceipt,
    });
    const currentWindow = index.current_window_sequence === 0
      ? createProviderEntryWindowAnchorV1({ committed_send_authorization: proof })
      : normalizeProviderEntryWindowV1(
        currentReceipt.result?.provider_entry_window_continuation,
        { committed_send_authorization: proof },
      );
    normalizeProviderEntryWindowIndexV1(index, {
      committed_send_authorization: proof,
      current_window: currentWindow,
      current_window_internal_receipt: currentWindow.window_sequence === 0
        ? null
        : currentReceipt,
    });
    if (canonicalJson(proof.effect) !== canonicalJson(effectIdentity(effect))
        || effect.status !== "sending"
        || !effect.lease
        || currentWindow.lease_expires_at !== effect.lease.expires_at
        || canonicalJson(currentWindow.authorized_fencing_token) !== canonicalJson({
          lease_id: effect.lease.lease_id,
          owner_id: effect.lease.owner_id,
          generation: effect.lease.generation,
        })) {
      throw boundaryError(
        "BUSINESS_INTERNAL_PROVIDER_ENTRY_WINDOW_STALE",
        "Provider entry window index does not bind the current sending lease",
        { effect_id: effect.effect_id },
      );
    }
    return { proof, currentWindow };
  } catch (error) {
    if (error instanceof BusinessInternalActionBoundaryError) throw error;
    if (!(error instanceof BusinessProviderEntryWindowError)
        && !(error instanceof BusinessSendAuthorizationError)) throw error;
    throw boundaryError(
      "BUSINESS_INTERNAL_PROVIDER_ENTRY_WINDOW_INVALID",
      "Provider entry window index or receipt closure is invalid",
      { effect_id: effect.effect_id, cause_code: error.code },
    );
  }
}

function prevalidateCandidateBatch(projection, request, action, identityHash) {
  let candidate = projection;
  try {
    for (const event of request.events) {
      candidate = projectBusinessEventV1(candidate, event, request);
    }
  } catch (error) {
    throw boundaryError(
      "BUSINESS_INTERNAL_ACTION_REJECTED",
      "Candidate events failed the authoritative Business projector",
      { cause_code: error?.code || null },
    );
  }
  const result = readReceipt(candidate, action, identityHash);
  if (result === RECEIPT_NOT_FOUND) {
    throw boundaryError(
      "BUSINESS_INTERNAL_ACTION_RECEIPT_MISSING",
      "Candidate batch did not close with its exact internal action receipt",
    );
  }
  return result;
}

function validateDependency(condition, name) {
  if (!condition) throw new TypeError(`${name} is required`);
}

function mapBatchConflict(error, action) {
  if (error?.code !== "EVENT_BATCH_ID_CONFLICT") return error;
  return boundaryError(
    "BUSINESS_INTERNAL_ACTION_ID_CONFLICT",
    "Internal action ID is already bound to a different atomic batch",
    { internal_action_id: action.internal_action_id },
  );
}

/**
 * Creates the system-only EventStore boundary for outbox lifecycle actions.
 * It records lifecycle intent and receipts only; it has no provider, file, or
 * process dependency and never performs the provider effect itself.
 */
function createBusinessInternalActionBoundary(options = {}) {
  const {
    eventStore,
    authorizer,
    resolvers,
    packetStore = null,
    clock = () => new Date().toISOString(),
    maxGlobalCasRetries = 3,
    dependencyTimeoutMs = 5_000,
  } = options;
  validateDependency(eventStore && typeof eventStore.replay === "function", "eventStore.replay");
  validateDependency(eventStore && typeof eventStore.commit === "function", "eventStore.commit");
  validateDependency(authorizer && typeof authorizer.authenticate === "function", "authorizer.authenticate");
  validateDependency(authorizer && typeof authorizer.authorize === "function", "authorizer.authorize");
  validateDependency(
    resolvers && typeof resolvers.resolveEffectFacts === "function",
    "resolvers.resolveEffectFacts",
  );
  if (packetStore !== null
      && typeof packetStore?.verifyForSendAuthorization !== "function") {
    throw new TypeError(
      "packetStore.verifyForSendAuthorization must be a function when packetStore is provided",
    );
  }
  validateDependency(typeof clock === "function", "clock");
  if (!Number.isSafeInteger(maxGlobalCasRetries)
      || maxGlobalCasRetries < 0
      || maxGlobalCasRetries > 10) {
    throw new TypeError("maxGlobalCasRetries must be an integer from 0 to 10");
  }
  if (!Number.isSafeInteger(dependencyTimeoutMs)
      || dependencyTimeoutMs < 10
      || dependencyTimeoutMs > 60_000) {
    throw new TypeError("dependencyTimeoutMs must be an integer from 10 to 60000");
  }
  const projectionConfig = projectorConfiguration();

  async function replayProjection(signal, dependency = "eventStore.replay") {
    try {
      return normalizeReplay(await callDependency(
        dependency,
        () => eventStore.replay(projectionConfig),
        signal,
        dependencyTimeoutMs,
      ));
    } catch (error) {
      if (error instanceof BusinessInternalActionBoundaryError) throw error;
      throw boundaryError(
        "BUSINESS_INTERNAL_EVENT_STORE_REPLAY_FAILED",
        "Business projection replay failed",
        { cause_code: error?.code || null },
      );
    }
  }

  async function execute(input) {
    if (!isPlainObject(input) || !Object.hasOwn(input, "internal_action")) {
      throw new TypeError("execute input must contain internal_action and authentication");
    }
    const externalSignal = validateAbortSignal(input.signal);
    const action = normalizeInternalActionEnvelopeV1(input.internal_action);
    let principal;
    try {
      const authenticated = await callDependency(
        "authorizer.authenticate",
        (signal) => authorizer.authenticate({ authentication: input.authentication, signal }),
        externalSignal,
        dependencyTimeoutMs,
      );
      principal = normalizePrincipal(authenticated);
    } catch (error) {
      if (error instanceof BusinessInternalActionBoundaryError) throw error;
      throw boundaryError(
        "BUSINESS_INTERNAL_AUTHENTICATION_FAILED",
        "System authentication failed",
        { cause_code: error?.code || null },
      );
    }
    if (action.actor.actor_id !== principal.id) {
      throw boundaryError(
        "BUSINESS_INTERNAL_ACTOR_BINDING_MISMATCH",
        "Asserted system actor does not match the authenticated principal",
      );
    }
    const identityHash = actionIdentityHash(action, principal);

    for (let casAttempt = 0; casAttempt <= maxGlobalCasRetries; casAttempt += 1) {
      throwIfAborted(externalSignal);
      const replay = await replayProjection(externalSignal);
      const projection = replay.state;
      const workOrder = projection.work_orders[action.work_order_id];
      if (!workOrder) {
        throw boundaryError(
          "BUSINESS_INTERNAL_WORK_ORDER_NOT_FOUND",
          "Work Order does not exist",
          { work_order_id: action.work_order_id },
        );
      }
      if (workOrder.plan_snapshot_ref !== action.plan_snapshot_ref
          || workOrder.plan_hash !== action.plan_hash) {
        throw boundaryError(
          "BUSINESS_INTERNAL_PLAN_BINDING_MISMATCH",
          "Internal action plan identity does not match the Work Order",
        );
      }
      const effect = projection.outbox[action.payload.effect_id];
      if (!effect) {
        throw boundaryError(
          "BUSINESS_INTERNAL_EFFECT_NOT_FOUND",
          "Outbox effect does not exist",
          { effect_id: action.payload.effect_id },
        );
      }
      if (effect.work_order_id !== action.work_order_id) {
        throw boundaryError(
          "BUSINESS_INTERNAL_EFFECT_BINDING_MISMATCH",
          "Outbox effect belongs to a different immutable Work Order",
          { effect_id: effect.effect_id, effect_work_order_id: effect.work_order_id },
        );
      }
      // Reauthorize the immutable Work Order/effect scope before receipt
      // replay. Mutable lease facts are deliberately resolved only for a new
      // action, so an exact historical receipt never depends on today's lease.
      let authority;
      try {
        authority = await callDependency(
          "authorizer.authorize",
          (signal) => authorizer.authorize({
            principal,
            action: action.name,
            internal_action: action,
            work_order: workOrder,
            effect,
            signal,
          }),
          externalSignal,
          dependencyTimeoutMs,
        );
      } catch (error) {
        if (error instanceof BusinessInternalActionBoundaryError) throw error;
        throw boundaryError(
          "BUSINESS_INTERNAL_AUTHORIZATION_DENIED",
          "Internal action authorization failed",
          { cause_code: error?.code || null },
        );
      }
      normalizeAuthority(authority, action, principal);

      const replayedResult = readReceipt(projection, action, identityHash);
      if (replayedResult !== RECEIPT_NOT_FOUND) return replayedResult;
      if (workOrder.engine_contract_version !== BUSINESS_ENGINE_CONTRACT_VERSION) {
        throw boundaryError(
          "BUSINESS_ENGINE_MIGRATION_REQUIRED",
          "Legacy Work Orders are replay-only until an explicit engine migration is committed",
          {
            work_order_id: action.work_order_id,
            engine_contract_version: workOrder.engine_contract_version ?? 1,
          },
        );
      }
      if (action.name === "outbox.send.begin"
          && (projection.provider_settlement_epoch === null
            || projection.provider_settlement_epoch.send_authorization_contract_version
              !== SEND_AUTHORIZATION_CONTRACT_VERSION)) {
        throw boundaryError(
          "BUSINESS_INTERNAL_PROVIDER_SETTLEMENT_CUTOVER_REQUIRED",
          "Send begin requires the durable provider-settlement and send-authorization cutover",
        );
      }
      const factsObservedAt = validateClockValue(clock());
      let resolvedFacts;
      try {
        resolvedFacts = await callDependency(
          "resolvers.resolveEffectFacts",
          (signal) => resolvers.resolveEffectFacts({
            internal_action: action,
            principal,
            action: action.name,
            work_order_id: action.work_order_id,
            effect_id: action.payload.effect_id,
            occurred_at: factsObservedAt,
            signal,
          }),
          externalSignal,
          dependencyTimeoutMs,
        );
      } catch (error) {
        if (error instanceof BusinessInternalActionBoundaryError) throw error;
        throw boundaryError(
          "BUSINESS_INTERNAL_ACTION_FACT_RESOLUTION_FAILED",
          "Authoritative effect fact resolution failed",
          { cause_code: error?.code || null },
        );
      }
      const facts = normalizeEffectFacts(resolvedFacts, action, effect);
      if (!Number.isSafeInteger(workOrder.revision) || workOrder.revision < 1) {
        throw boundaryError(
          "BUSINESS_WORK_ORDER_PROJECTION_INVALID",
          "Work Order projection has an invalid revision",
        );
      }
      if (action.expected_work_order_revision !== workOrder.revision) {
        throw boundaryError(
          "BUSINESS_INTERNAL_WORK_ORDER_STALE",
          "Expected Work Order revision does not match the authoritative projection",
          {
            expected_revision: action.expected_work_order_revision,
            actual_revision: workOrder.revision,
          },
        );
      }

      let sendAuthorizationVerification = null;
      if (action.name === "outbox.send.begin") {
        assertLeaseToken(action, effect.lease);
        if (effect.effect_contract_version !== 2
            || effect.status !== "claimed") {
          throw boundaryError(
            "BUSINESS_INTERNAL_SEND_NOT_AUTHORIZED",
            "Send begin requires one current unexpired claimed Effect V2",
            { effect_id: effect.effect_id },
          );
        }
        if (packetStore === null
            || typeof packetStore.verifyForSendAuthorization !== "function") {
          throw boundaryError(
            "BUSINESS_INTERNAL_PACKET_STORE_REQUIRED",
            "Send begin requires the restricted PacketStore authorization verifier",
          );
        }
        let verificationCandidate;
        try {
          verificationCandidate = await callDependency(
            "packetStore.verifyForSendAuthorization",
            () => packetStore.verifyForSendAuthorization(effectIdentity(effect)),
            externalSignal,
            dependencyTimeoutMs,
          );
          sendAuthorizationVerification = normalizeDispatchPacketSendAuthorizationVerificationV1(
            verificationCandidate,
          );
        } catch (error) {
          if (error instanceof BusinessInternalActionBoundaryError) throw error;
          throw boundaryError(
            "BUSINESS_INTERNAL_PACKET_VERIFICATION_FAILED",
            "DispatchPacket verification failed before provider send authorization",
            {
              cause_code: error?.code || null,
              failure_class: error?.failure_class || null,
            },
          );
        }
        if (canonicalJson(
          sendAuthorizationVerification.packet_verification_receipt.effect_identity,
        )
            !== canonicalJson(effectIdentity(effect))) {
          throw boundaryError(
            "BUSINESS_INTERNAL_PACKET_VERIFICATION_STALE",
            "Packet verification receipt does not bind the current immutable Effect",
            { effect_id: effect.effect_id },
          );
        }
      }
      const renewalProviderEntryContext = action.name === "outbox.lease.renew"
          && effect.effect_contract_version === 2
          && effect.status === "sending"
          && projection.provider_settlement_epoch !== null
        ? providerEntryWindowContext(projection, effect)
        : null;

      // Dependency reads may consume most of a lease window. The durable event
      // time is sampled only after the final pre-send verification, never
      // reused from an earlier fact-resolution snapshot.
      const occurredAt = validateClockValue(clock());
      if (Date.parse(occurredAt) < Date.parse(factsObservedAt)
          || Date.parse(occurredAt) < Date.parse(effect.updated_at)) {
        throw boundaryError(
          "BUSINESS_INTERNAL_ACTION_CLOCK_INVALID",
          "Internal action clock moved backwards across authoritative reads",
        );
      }
      if (action.name === "outbox.send.begin"
          && Date.parse(occurredAt) >= Date.parse(effect.lease.expires_at)) {
        throw boundaryError(
          "BUSINESS_INTERNAL_SEND_NOT_AUTHORIZED",
          "Packet verification completed after the current send lease expired",
          { effect_id: effect.effect_id },
        );
      }

      const candidate = atomicRequest(
        action,
        principal,
        workOrder,
        effect,
        identityHash,
        occurredAt,
        sendAuthorizationVerification,
        projection.provider_settlement_epoch?.cutover_id || null,
        renewalProviderEntryContext,
      );
      const request = {
        expected_revision: replay.watermark.journal_sequence,
        batch_id: candidate.batch_id,
        actor: candidate.actor,
        correlation_id: candidate.correlation_id,
        events: candidate.events,
      };
      const projectedResult = prevalidateCandidateBatch(
        projection,
        request,
        action,
        identityHash,
      );
      if (canonicalJson(projectedResult) !== canonicalJson(candidate.result)) {
        throw boundaryError(
          "BUSINESS_INTERNAL_ACTION_DECISION_INVALID",
          "Projected receipt result does not match the deterministic action result",
        );
      }

      throwIfAborted(externalSignal);
      try {
        const commitResult = await eventStore.commit(request);
        if (!isPlainObject(commitResult)
            || !["committed", "idempotent"].includes(commitResult.status)) {
          throw boundaryError(
            "BUSINESS_INTERNAL_EVENT_STORE_RESULT_INVALID",
            "EventStore returned an invalid commit result",
          );
        }
        if (commitResult.status === "idempotent") {
          const committedReplay = await replayProjection(
            null,
            "eventStore.replay_after_commit",
          );
          const storedResult = readReceipt(committedReplay.state, action, identityHash);
          if (storedResult === RECEIPT_NOT_FOUND) {
            throw boundaryError(
              "BUSINESS_INTERNAL_ACTION_RECEIPT_MISSING",
              "Idempotent EventStore batch has no projected internal action receipt",
            );
          }
          return storedResult;
        }
        return canonicalClone(candidate.result, "BUSINESS_INTERNAL_ACTION_RECEIPT_INVALID");
      } catch (error) {
        if (["EVENT_REVISION_CONFLICT", "EVENT_LOCK_BUSY"].includes(error?.code)) {
          if (casAttempt < maxGlobalCasRetries) continue;
          throw boundaryError(
            "BUSINESS_INTERNAL_GLOBAL_CAS_EXHAUSTED",
            "Global EventStore revision changed too many times",
            { attempts: casAttempt + 1 },
          );
        }
        let concurrentReplay = null;
        try {
          concurrentReplay = await replayProjection(
            null,
            "eventStore.replay_after_commit_error",
          );
          const storedResult = readReceipt(concurrentReplay.state, action, identityHash);
          if (storedResult !== RECEIPT_NOT_FOUND) return storedResult;
        } catch (replayError) {
          if (replayError?.code === "BUSINESS_INTERNAL_ACTION_ID_CONFLICT") {
            throw replayError;
          }
        }
        const mapped = mapBatchConflict(error, action);
        if (mapped instanceof BusinessInternalActionBoundaryError) throw mapped;
        throw boundaryError(
          "BUSINESS_INTERNAL_EVENT_STORE_COMMIT_FAILED",
          "Internal action commit failed without a matching durable receipt",
          { cause_code: mapped?.code || null },
        );
      }
    }
    throw boundaryError(
      "BUSINESS_INTERNAL_GLOBAL_CAS_EXHAUSTED",
      "Global EventStore revision retry bound was exhausted",
    );
  }

  return Object.freeze({ execute });
}

module.exports = {
  INTERNAL_ACTION_ENVELOPE_VERSION,
  INTERNAL_ACTION_NAMES: ACTION_NAMES,
  BusinessInternalActionBoundaryError,
  createBusinessInternalActionBoundary,
  normalizeInternalActionEnvelopeV1,
};
