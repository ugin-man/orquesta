"use strict";

const { canonicalHash, canonicalJson } = require("@orquesta/contracts");
const {
  V2_EFFECT_IDENTITY_FIELDS,
  V2_MUTATING_EFFECT_KINDS,
  deriveEffectOperationScopeHashV2,
} = require("./lifecycle");

const SEND_AUTHORIZATION_CONTRACT_VERSION = 2;
const SEND_AUTHORIZATION_BUNDLE_VERSION = 1;
const MAX_CANONICAL_BYTES = 1_048_576;
const CONTENT_REF_FIELDS = new Set(["id", "hash"]);
const FENCING_TOKEN_FIELDS = new Set(["lease_id", "owner_id", "generation"]);
const EVENT_FIELDS = new Set([
  "event_id",
  "schema_version",
  "type",
  "payload",
  "evidence_refs",
]);
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
const RUNTIME_IDENTITY_FIELDS = new Set(["operation_id", "thread_id", "turn_id"]);
const SEND_AUTHORIZATION_BUNDLE_BODY_FIELDS = new Set([
  "bundle_version",
  "authorization_contract_version",
  "authorization_kind",
  "send_event",
  "send_event_ref",
  "batch_id",
  "domain_event_manifest_hash",
]);
const SEND_AUTHORIZATION_BUNDLE_FIELDS = new Set([
  ...SEND_AUTHORIZATION_BUNDLE_BODY_FIELDS,
  "bundle_ref",
]);
const COMMITTED_SEND_AUTHORIZATION_PROOF_FIELDS = new Set([
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
const COMMIT_CLOSURE_FIELDS = new Set(["batch_id", "event_ids", "event_hashes"]);
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
const EFFECT_KIND_SET = new Set(V2_MUTATING_EFFECT_KINDS);

class BusinessSendAuthorizationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "BusinessSendAuthorizationError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details) {
  throw new BusinessSendAuthorizationError(code, message, details);
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

function exactObject(value, fields, path) {
  if (!isPlainObject(value)
      || Object.keys(value).length !== fields.size
      || Object.keys(value).some((field) => !fields.has(field))
      || [...fields].some((field) => !Object.hasOwn(value, field))) {
    fail(
      "BUSINESS_SEND_AUTHORIZATION_INVALID",
      `${path} must be one exact object`,
      { path },
    );
  }
  return value;
}

function canonicalClone(value, path) {
  let serialized;
  try {
    serialized = canonicalJson(value);
  } catch (error) {
    fail("BUSINESS_SEND_AUTHORIZATION_INVALID", `${path} must be canonical JSON`, {
      path,
      cause_code: error?.code || null,
    });
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_CANONICAL_BYTES) {
    fail("BUSINESS_SEND_AUTHORIZATION_INVALID", `${path} exceeds the boundary limit`, { path });
  }
  return JSON.parse(serialized);
}

function text(value, path, maximumBytes = 512) {
  if (typeof value !== "string"
      || value.trim() === ""
      || value.trim() !== value
      || Buffer.byteLength(value, "utf8") > maximumBytes
      || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail("BUSINESS_SEND_AUTHORIZATION_INVALID", `${path} must be bounded non-empty text`, {
      path,
    });
  }
  return value;
}

function portableRef(value, path) {
  const normalized = text(value, path);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@+\-]*$/u.test(normalized)) {
    fail("BUSINESS_SEND_AUTHORIZATION_INVALID", `${path} must be a portable reference`, { path });
  }
  return normalized;
}

function sha256(value, path) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    fail("BUSINESS_SEND_AUTHORIZATION_INVALID", `${path} must be a lowercase SHA-256`, { path });
  }
  return value;
}

function integer(value, path, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    fail("BUSINESS_SEND_AUTHORIZATION_INVALID", `${path} must be a bounded integer`, { path });
  }
  return value;
}

function timestamp(value, path) {
  if (typeof value !== "string"
      || Number.isNaN(Date.parse(value))
      || new Date(value).toISOString() !== value) {
    fail("BUSINESS_SEND_AUTHORIZATION_INVALID", `${path} must be a canonical UTC timestamp`, {
      path,
    });
  }
  return value;
}

function nullablePortableRef(value, path) {
  return value === null ? null : portableRef(value, path);
}

function contentRef(value, path) {
  const ref = exactObject(value, CONTENT_REF_FIELDS, path);
  return {
    id: portableRef(ref.id, `${path}.id`),
    hash: sha256(ref.hash, `${path}.hash`),
  };
}

function stringArray(value, path, { minimum = 0, maximum = 512 } = {}) {
  if (!Array.isArray(value)
      || value.length < minimum
      || value.length > maximum
      || new Set(value).size !== value.length) {
    fail("BUSINESS_SEND_AUTHORIZATION_INVALID", `${path} must be one bounded unique array`, {
      path,
    });
  }
  return value.map((entry, index) => portableRef(entry, `${path}[${index}]`));
}

function nullableContentRef(value, path) {
  return value === null ? null : contentRef(value, path);
}

function normalizeRuntimeIdentity(value, path) {
  if (value === null) return null;
  const identity = exactObject(value, RUNTIME_IDENTITY_FIELDS, path);
  const normalized = {
    operation_id: nullablePortableRef(identity.operation_id, `${path}.operation_id`),
    thread_id: nullablePortableRef(identity.thread_id, `${path}.thread_id`),
    turn_id: nullablePortableRef(identity.turn_id, `${path}.turn_id`),
  };
  if (Object.values(normalized).every((entry) => entry === null)) {
    fail(
      "BUSINESS_SEND_AUTHORIZATION_INVALID",
      `${path} must identify at least one provider operation`,
      { path },
    );
  }
  return normalized;
}

function normalizeFencingToken(value, path) {
  const token = exactObject(value, FENCING_TOKEN_FIELDS, path);
  return {
    lease_id: portableRef(token.lease_id, `${path}.lease_id`),
    owner_id: portableRef(token.owner_id, `${path}.owner_id`),
    generation: integer(token.generation, `${path}.generation`, 1),
  };
}

function normalizeEffectIdentity(value, path) {
  const effectFields = new Set(V2_EFFECT_IDENTITY_FIELDS);
  const effect = exactObject(canonicalClone(value, path), effectFields, path);
  const normalized = {
    effect_id: portableRef(effect.effect_id, `${path}.effect_id`),
    effect_contract_version: integer(
      effect.effect_contract_version,
      `${path}.effect_contract_version`,
      2,
    ),
    work_order_id: portableRef(effect.work_order_id, `${path}.work_order_id`),
    branch_ref: portableRef(effect.branch_ref, `${path}.branch_ref`),
    attempt: integer(effect.attempt, `${path}.attempt`, 1),
    dispatch_id: portableRef(effect.dispatch_id, `${path}.dispatch_id`),
    effect_kind: portableRef(effect.effect_kind, `${path}.effect_kind`),
    origin_source_id: portableRef(effect.origin_source_id, `${path}.origin_source_id`),
    operation_scope_hash: sha256(effect.operation_scope_hash, `${path}.operation_scope_hash`),
    operation_generation: integer(
      effect.operation_generation,
      `${path}.operation_generation`,
      1,
    ),
    generation_predecessor_effect_id: nullablePortableRef(
      effect.generation_predecessor_effect_id,
      `${path}.generation_predecessor_effect_id`,
    ),
    provider_ref: portableRef(effect.provider_ref, `${path}.provider_ref`),
    packet_ref: portableRef(effect.packet_ref, `${path}.packet_ref`),
    packet_hash: sha256(effect.packet_hash, `${path}.packet_hash`),
    predecessor_effect_id: nullablePortableRef(
      effect.predecessor_effect_id,
      `${path}.predecessor_effect_id`,
    ),
    predecessor_delivery_hash: effect.predecessor_delivery_hash === null
      ? null
      : sha256(effect.predecessor_delivery_hash, `${path}.predecessor_delivery_hash`),
    target_runtime_identity: normalizeRuntimeIdentity(
      effect.target_runtime_identity,
      `${path}.target_runtime_identity`,
    ),
    idempotency_key: portableRef(effect.idempotency_key, `${path}.idempotency_key`),
    created_at: timestamp(effect.created_at, `${path}.created_at`),
  };
  const isThreadCreate = normalized.effect_kind === "provider.thread.create";
  const hasPredecessor = normalized.predecessor_effect_id !== null
    && normalized.predecessor_delivery_hash !== null
    && normalized.target_runtime_identity !== null;
  const seed = Object.fromEntries(V2_EFFECT_IDENTITY_FIELDS
    .filter((field) => !["effect_id", "idempotency_key", "created_at"].includes(field))
    .map((field) => [field, normalized[field]]));
  const expectedHashPrefix = canonicalHash(seed).slice(0, 32);
  if (normalized.effect_contract_version !== 2
      || !EFFECT_KIND_SET.has(normalized.effect_kind)
      || ((normalized.operation_generation === 1)
        !== (normalized.generation_predecessor_effect_id === null))
      || (isThreadCreate
        ? (normalized.predecessor_effect_id !== null
          || normalized.predecessor_delivery_hash !== null
          || normalized.target_runtime_identity !== null)
        : !hasPredecessor)
      || normalized.effect_id !== `FX-${expectedHashPrefix}`
      || normalized.idempotency_key !== `IDEM-${expectedHashPrefix}`) {
    fail(
      "BUSINESS_SEND_AUTHORIZATION_INVALID",
      `${path} must be one mutating immutable Effect V2 identity`,
      { path },
    );
  }
  return normalized;
}

function normalizeSendAuthorizationOperationScopeBindingV2(input, effectInput) {
  const effect = normalizeEffectIdentity(effectInput, "effect");
  const candidate = exactObject(
    canonicalClone(input, "operation_scope_binding"),
    OPERATION_SCOPE_BINDING_FIELDS,
    "operation_scope_binding",
  );
  const binding = {
    effect_kind: portableRef(candidate.effect_kind, "operation_scope_binding.effect_kind"),
    provider_ref: portableRef(candidate.provider_ref, "operation_scope_binding.provider_ref"),
    packet_ref: portableRef(candidate.packet_ref, "operation_scope_binding.packet_ref"),
    packet_hash: sha256(candidate.packet_hash, "operation_scope_binding.packet_hash"),
    predecessor_effect_id: nullablePortableRef(
      candidate.predecessor_effect_id,
      "operation_scope_binding.predecessor_effect_id",
    ),
    predecessor_delivery_hash: candidate.predecessor_delivery_hash === null
      ? null
      : sha256(
        candidate.predecessor_delivery_hash,
        "operation_scope_binding.predecessor_delivery_hash",
      ),
    target_runtime_identity: normalizeRuntimeIdentity(
      candidate.target_runtime_identity,
      "operation_scope_binding.target_runtime_identity",
    ),
    request_id: nullablePortableRef(candidate.request_id, "operation_scope_binding.request_id"),
    response_ref: nullableContentRef(
      candidate.response_ref,
      "operation_scope_binding.response_ref",
    ),
  };
  const isUserInput = effect.effect_kind === "provider.user_input.submit";
  const isThreadCreate = effect.effect_kind === "provider.thread.create";
  const predecessorFieldsAreNull = binding.predecessor_effect_id === null
    && binding.predecessor_delivery_hash === null
    && binding.target_runtime_identity === null;
  const predecessorFieldsArePresent = binding.predecessor_effect_id !== null
    && binding.predecessor_delivery_hash !== null
    && binding.target_runtime_identity !== null;
  if (binding.effect_kind !== effect.effect_kind
      || binding.provider_ref !== effect.provider_ref
      || binding.packet_ref !== effect.packet_ref
      || binding.packet_hash !== effect.packet_hash
      || binding.predecessor_effect_id !== effect.predecessor_effect_id
      || binding.predecessor_delivery_hash !== effect.predecessor_delivery_hash
      || canonicalJson(binding.target_runtime_identity)
        !== canonicalJson(effect.target_runtime_identity)
      || (isThreadCreate ? !predecessorFieldsAreNull : !predecessorFieldsArePresent)
      || (isUserInput
        ? (binding.request_id === null || binding.response_ref === null)
        : (binding.request_id !== null || binding.response_ref !== null))
      || deriveEffectOperationScopeHashV2(binding) !== effect.operation_scope_hash) {
    fail(
      "BUSINESS_SEND_AUTHORIZATION_SCOPE_INVALID",
      "Operation scope does not derive from the exact immutable Effect V2 identity",
      { effect_id: effect.effect_id },
    );
  }
  return deepFreeze(binding);
}

function normalizeSendEvent(input) {
  const event = exactObject(
    canonicalClone(input, "send_event"),
    EVENT_FIELDS,
    "send_event",
  );
  const payload = exactObject(
    event.payload,
    SEND_EVENT_PAYLOAD_FIELDS,
    "send_event.payload",
  );
  const effect = normalizeEffectIdentity(payload.effect, "send_event.payload.effect");
  const token = normalizeFencingToken({
    lease_id: payload.lease_id,
    owner_id: payload.lease_owner_id,
    generation: payload.lease_generation,
  }, "send_event.payload.fencing_token");
  const scope = normalizeSendAuthorizationOperationScopeBindingV2(
    payload.operation_scope_binding,
    effect,
  );
  if (event.schema_version !== 1
      || event.type !== "business.outbox.send_begun"
      || !Array.isArray(event.evidence_refs)
      || event.evidence_refs.length !== 0
      || payload.send_authorization_contract_version !== SEND_AUTHORIZATION_CONTRACT_VERSION
      || payload.effect_id !== effect.effect_id
      || payload.lease_id !== token.lease_id
      || payload.lease_owner_id !== token.owner_id
      || payload.lease_generation !== token.generation
      || !isPlainObject(payload.packet_verification_receipt)) {
    fail(
      "BUSINESS_SEND_AUTHORIZATION_INVALID",
      "Send event does not carry one exact authorization V2 payload",
      { event_id: event.event_id || null },
    );
  }
  portableRef(event.event_id, "send_event.event_id");
  portableRef(payload.work_order_id, "send_event.payload.work_order_id");
  portableRef(payload.plan_snapshot_ref, "send_event.payload.plan_snapshot_ref");
  sha256(payload.plan_hash, "send_event.payload.plan_hash");
  portableRef(payload.source_id, "send_event.payload.source_id");
  integer(payload.prior_work_order_revision, "send_event.payload.prior_work_order_revision");
  integer(payload.target_work_order_revision, "send_event.payload.target_work_order_revision");
  timestamp(payload.occurred_at, "send_event.payload.occurred_at");
  timestamp(payload.lease_expires_at, "send_event.payload.lease_expires_at");
  portableRef(
    payload.provider_settlement_cutover_id,
    "send_event.payload.provider_settlement_cutover_id",
  );
  if (payload.prior_work_order_revision !== payload.target_work_order_revision
      || Date.parse(payload.occurred_at) >= Date.parse(payload.lease_expires_at)) {
    fail(
      "BUSINESS_SEND_AUTHORIZATION_INVALID",
      "Send event must remain within one internal-action revision and lease window",
      { event_id: event.event_id },
    );
  }
  return deepFreeze({
    ...event,
    payload: {
      ...payload,
      effect,
      operation_scope_binding: scope,
    },
  });
}

function deriveSendAuthorizationDomainEventManifestHashV1(sendEventInput) {
  const sendEvent = normalizeSendEvent(sendEventInput);
  return canonicalHash([{
    event_id: sendEvent.event_id,
    event_hash: canonicalHash(sendEvent),
  }]);
}

function bundleBody(sendEvent, batchId) {
  const eventHash = canonicalHash(sendEvent);
  return {
    bundle_version: SEND_AUTHORIZATION_BUNDLE_VERSION,
    authorization_contract_version: SEND_AUTHORIZATION_CONTRACT_VERSION,
    authorization_kind: "committed_outbox_send_begin",
    send_event: sendEvent,
    send_event_ref: { id: sendEvent.event_id, hash: eventHash },
    batch_id: portableRef(batchId, "batch_id"),
    domain_event_manifest_hash: deriveSendAuthorizationDomainEventManifestHashV1(sendEvent),
  };
}

function createSendAuthorizationBundleV1({ send_event: inputEvent, batch_id: inputBatchId } = {}) {
  const sendEvent = normalizeSendEvent(inputEvent);
  const body = bundleBody(sendEvent, inputBatchId);
  const hash = canonicalHash(body);
  return deepFreeze({
    ...body,
    bundle_ref: { id: `SAB-${hash.slice(0, 32)}`, hash },
  });
}

function normalizeSendAuthorizationBundleV1(input) {
  const candidate = exactObject(
    canonicalClone(input, "send_authorization_bundle"),
    SEND_AUTHORIZATION_BUNDLE_FIELDS,
    "send_authorization_bundle",
  );
  const sendEvent = normalizeSendEvent(candidate.send_event);
  const expectedBody = bundleBody(sendEvent, candidate.batch_id);
  const suppliedBody = Object.fromEntries(
    [...SEND_AUTHORIZATION_BUNDLE_BODY_FIELDS].map((field) => [field, candidate[field]]),
  );
  const hash = canonicalHash(expectedBody);
  const expectedRef = { id: `SAB-${hash.slice(0, 32)}`, hash };
  if (canonicalJson(suppliedBody) !== canonicalJson(expectedBody)
      || canonicalJson(contentRef(candidate.bundle_ref, "send_authorization_bundle.bundle_ref"))
        !== canonicalJson(expectedRef)) {
    fail(
      "BUSINESS_SEND_AUTHORIZATION_INVALID",
      "Send authorization bundle does not content-address its exact event and batch",
      { event_id: sendEvent.event_id },
    );
  }
  return deepFreeze({ ...expectedBody, bundle_ref: expectedRef });
}

function eventIdFor({ sourceId, ordinal, type, payload, evidenceRefs }) {
  return `BVE-${canonicalHash({
    source_id: sourceId,
    ordinal,
    type,
    payload,
    evidence_refs: evidenceRefs,
  }).slice(0, 32)}`;
}

function normalizeProjectedInternalReceipt(input) {
  const receipt = exactObject(
    canonicalClone(input, "internal_receipt"),
    INTERNAL_RECEIPT_FIELDS,
    "internal_receipt",
  );
  const result = exactObject(
    receipt.result,
    SEND_RESULT_FIELDS,
    "internal_receipt.result",
  );
  const normalized = {
    source_id: portableRef(receipt.source_id, "internal_receipt.source_id"),
    source_type: text(receipt.source_type, "internal_receipt.source_type"),
    identity_hash: sha256(receipt.identity_hash, "internal_receipt.identity_hash"),
    payload_hash: sha256(receipt.payload_hash, "internal_receipt.payload_hash"),
    work_order_id: portableRef(receipt.work_order_id, "internal_receipt.work_order_id"),
    applied_revision: integer(receipt.applied_revision, "internal_receipt.applied_revision", 1),
    batch_id: portableRef(receipt.batch_id, "internal_receipt.batch_id"),
    event_ids: stringArray(receipt.event_ids, "internal_receipt.event_ids", {
      minimum: 1,
      maximum: 511,
    }),
    result: canonicalClone(result, "internal_receipt.result"),
    event_hashes: canonicalClone(receipt.event_hashes, "internal_receipt.event_hashes"),
  };
  if (normalized.source_type !== "internal_action"
      || !isPlainObject(normalized.event_hashes)
      || Object.keys(normalized.event_hashes).length !== normalized.event_ids.length + 1) {
    fail(
      "BUSINESS_SEND_AUTHORIZATION_INVALID",
      "Internal receipt must close one projected internal-action batch",
      { source_id: normalized.source_id },
    );
  }
  for (const [eventId, eventHash] of Object.entries(normalized.event_hashes)) {
    portableRef(eventId, `internal_receipt.event_hashes.${eventId}`);
    sha256(eventHash, `internal_receipt.event_hashes.${eventId}`);
  }
  return normalized;
}

function reconstructReceiptEvent(sendEvent, internalReceipt) {
  const { event_hashes: ignoredEventHashes, ...journalReceipt } = internalReceipt;
  void ignoredEventHashes;
  exactObject(
    journalReceipt,
    JOURNAL_INTERNAL_RECEIPT_FIELDS,
    "journal_internal_receipt",
  );
  const payload = {
    work_order_id: sendEvent.payload.work_order_id,
    plan_snapshot_ref: sendEvent.payload.plan_snapshot_ref,
    plan_hash: sendEvent.payload.plan_hash,
    source_id: sendEvent.payload.source_id,
    prior_work_order_revision: sendEvent.payload.prior_work_order_revision,
    target_work_order_revision: sendEvent.payload.target_work_order_revision,
    occurred_at: sendEvent.payload.occurred_at,
    receipt: journalReceipt,
  };
  exactObject(payload, RECEIPT_EVENT_PAYLOAD_FIELDS, "receipt_event.payload");
  const evidenceRefs = [];
  return {
    event_id: eventIdFor({
      sourceId: internalReceipt.source_id,
      ordinal: 1,
      type: "business.internal_action.received",
      payload,
      evidenceRefs,
    }),
    schema_version: 1,
    type: "business.internal_action.received",
    payload,
    evidence_refs: evidenceRefs,
  };
}

function committedProofFromClosure({
  send_authorization_bundle: inputBundle,
  internal_receipt: inputReceipt,
} = {}) {
  const bundle = normalizeSendAuthorizationBundleV1(inputBundle);
  const sendEvent = bundle.send_event;
  const receipt = normalizeProjectedInternalReceipt(inputReceipt);
  const result = receipt.result;
  const packetReceipt = canonicalClone(
    sendEvent.payload.packet_verification_receipt,
    "send_event.payload.packet_verification_receipt",
  );
  const effect = normalizeEffectIdentity(sendEvent.payload.effect, "send_event.payload.effect");
  const scope = normalizeSendAuthorizationOperationScopeBindingV2(
    sendEvent.payload.operation_scope_binding,
    effect,
  );
  const token = normalizeFencingToken({
    lease_id: sendEvent.payload.lease_id,
    owner_id: sendEvent.payload.lease_owner_id,
    generation: sendEvent.payload.lease_generation,
  }, "send_event.payload.fencing_token");
  const sendBeginLeaseExpiresAt = timestamp(
    sendEvent.payload.lease_expires_at,
    "send_event.payload.lease_expires_at",
  );
  if (!isPlainObject(packetReceipt)
      || !isPlainObject(packetReceipt.packet_ref)) {
    fail(
      "BUSINESS_SEND_AUTHORIZATION_INVALID",
      "Packet authorization receipt must expose its exact provider request reference",
      { event_id: sendEvent.event_id },
    );
  }
  const providerRequestRef = contentRef(
    packetReceipt.packet_ref,
    "packet_verification_receipt.packet_ref",
  );
  const expectedSendEventId = eventIdFor({
    sourceId: receipt.source_id,
    ordinal: 0,
    type: sendEvent.type,
    payload: sendEvent.payload,
    evidenceRefs: sendEvent.evidence_refs,
  });
  if (sendEvent.event_id !== expectedSendEventId
      || receipt.source_id !== sendEvent.payload.source_id
      || receipt.work_order_id !== sendEvent.payload.work_order_id
      || receipt.applied_revision !== sendEvent.payload.target_work_order_revision
      || receipt.batch_id !== bundle.batch_id
      || receipt.event_ids.length !== 1
      || receipt.event_ids[0] !== sendEvent.event_id
      || result.internal_action_id !== receipt.source_id
      || result.work_order_id !== receipt.work_order_id
      || result.work_order_revision !== receipt.applied_revision
      || result.effect_id !== effect.effect_id
      || result.action !== "outbox.send.begin"
      || result.outbox_status !== "sending"
      || canonicalJson(result.fencing_token) !== canonicalJson(token)
      || canonicalJson(result.packet_verification_receipt) !== canonicalJson(packetReceipt)
      || canonicalJson(result.send_authorization_bundle) !== canonicalJson(bundle)) {
    fail(
      "BUSINESS_SEND_AUTHORIZATION_INVALID",
      "Projected send receipt does not exactly repeat its immutable send authorization",
      { source_id: receipt.source_id },
    );
  }
  const receiptEvent = reconstructReceiptEvent(sendEvent, receipt);
  const eventIds = [sendEvent.event_id, receiptEvent.event_id];
  const eventHashes = {
    [sendEvent.event_id]: canonicalHash(sendEvent),
    [receiptEvent.event_id]: canonicalHash(receiptEvent),
  };
  if (canonicalJson(receipt.event_hashes) !== canonicalJson(eventHashes)) {
    fail(
      "BUSINESS_SEND_AUTHORIZATION_INVALID",
      "Projected receipt event hashes do not close the exact ordered atomic batch",
      { source_id: receipt.source_id },
    );
  }
  const receiptHash = canonicalHash(receipt);
  return {
    authorization_version: SEND_AUTHORIZATION_CONTRACT_VERSION,
    authorization_kind: "committed_outbox_send_begin",
    commit: {
      batch_id: receipt.batch_id,
      event_ids: eventIds,
      event_hashes: eventHashes,
    },
    send_authorization_bundle: bundle,
    send_event: sendEvent,
    receipt_event: receiptEvent,
    internal_receipt: receipt,
    packet_verification_receipt: packetReceipt,
    effect,
    operation_scope_binding: scope,
    authorized_fencing_token: token,
    send_begin_lease_expires_at: sendBeginLeaseExpiresAt,
    provider_request_ref: providerRequestRef,
    send_authorization_receipt_ref: {
      id: `IAR-${receiptHash.slice(0, 32)}`,
      hash: receiptHash,
    },
  };
}

function createCommittedSendAuthorizationProofV2(input) {
  return deepFreeze(committedProofFromClosure(input));
}

function normalizeCommittedSendAuthorizationProofV2(input) {
  const candidate = exactObject(
    canonicalClone(input, "committed_send_authorization_proof"),
    COMMITTED_SEND_AUTHORIZATION_PROOF_FIELDS,
    "committed_send_authorization_proof",
  );
  exactObject(candidate.commit, COMMIT_CLOSURE_FIELDS, "committed_send_authorization_proof.commit");
  const expected = committedProofFromClosure({
    send_authorization_bundle: candidate.send_authorization_bundle,
    internal_receipt: candidate.internal_receipt,
  });
  if (canonicalJson(candidate) !== canonicalJson(expected)) {
    fail(
      "BUSINESS_SEND_AUTHORIZATION_INVALID",
      "Committed send authorization proof must equal its self-contained SAB and receipt closure",
      { effect_id: expected.effect.effect_id },
    );
  }
  return deepFreeze(expected);
}

function deriveCommittedSendAuthorizationHashV2(input) {
  return canonicalHash(normalizeCommittedSendAuthorizationProofV2(input));
}

module.exports = {
  BusinessSendAuthorizationError,
  SEND_AUTHORIZATION_BUNDLE_VERSION,
  SEND_AUTHORIZATION_CONTRACT_VERSION,
  createCommittedSendAuthorizationProofV2,
  createSendAuthorizationBundleV1,
  deriveCommittedSendAuthorizationHashV2,
  deriveSendAuthorizationDomainEventManifestHashV1,
  normalizeCommittedSendAuthorizationProofV2,
  normalizeSendAuthorizationBundleV1,
  normalizeSendAuthorizationOperationScopeBindingV2,
};
