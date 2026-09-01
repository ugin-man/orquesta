"use strict";

const { canonicalHash, canonicalJson } = require("@orquesta/contracts");
const { SEND_AUTHORIZATION_CONTRACT_VERSION } = require("./send-authorization");

const PROVIDER_SETTLEMENT_CUTOVER_ENVELOPE_VERSION = 1;
const PROVIDER_SETTLEMENT_CUTOVER_SCHEMA_VERSION = 1;
const PROVIDER_SETTLEMENT_CONTRACT_VERSION = 2;
const PROVIDER_SETTLEMENT_CUTOVER_PROJECTION_SCHEMA_VERSION = 2;
const PROVIDER_SETTLEMENT_CUTOVER_SOURCE_TYPE = "provider_settlement_cutover";
const PROVIDER_SETTLEMENT_CUTOVER_ACTION = "provider_settlement.v2.activate";
const PROVIDER_SETTLEMENT_ACTIVATED_EVENT = "business.provider_settlement.v2_activated";
const PROVIDER_SETTLEMENT_CUTOVER_RECEIVED_EVENT =
  "business.provider_settlement.cutover_received";

const MAX_VALUE_BYTES = 1_048_576;
const MAX_PROJECTION_BYTES = 64 * 1_024 * 1_024;
const MAX_REF_BYTES = 256;
const RECEIPT_NOT_FOUND = Symbol("business-provider-settlement-cutover-receipt-not-found");
const UNSAFE_PROVIDER_EFFECT_STATES = new Set([
  "claimed",
  "sending",
  "delivery_unknown",
]);
const LEGACY_UNRESOLVED_PROVIDER_EFFECT_STATES = new Set([
  "pending",
  ...UNSAFE_PROVIDER_EFFECT_STATES,
]);

const CUTOVER_FIELDS = new Set([
  "version",
  "cutover_id",
  "actor",
  "settlement_contract_version",
  "send_authorization_contract_version",
  "payload_hash",
]);
const ACTOR_FIELDS = new Set(["type", "actor_id"]);
const PRINCIPAL_FIELDS = new Set(["type", "id"]);
const AUTHORITY_FIELDS = new Set([
  "authorized",
  "principal_type",
  "principal_id",
  "action",
  "cutover_id",
  "settlement_contract_version",
  "send_authorization_contract_version",
]);
const READINESS_EVIDENCE_FIELDS = new Set([
  "readiness_assessment_ref",
  "assessment",
]);
const READINESS_ASSESSMENT_FIELDS = new Set([
  "assessment_schema_version",
  "status",
  "event_store_recovery",
  "settlement_ingress",
  "provider_reactors",
  "send_authorization_contract_version",
  "projected_readiness",
]);
const PROJECTED_READINESS_FIELDS = new Set([
  "readiness_schema_version",
  "journal_sequence",
  "pre_cutover_projection_hash",
  "provider_settlement_epoch",
  "send_authorization_contract_version",
  "pending_projection_inputs",
  "unsafe_provider_effects",
]);
const PENDING_INPUT_FIELDS = new Set([
  "work_order_id",
  "source_id",
  "source_type",
  "batch_id",
]);
const UNSAFE_EFFECT_FIELDS = new Set([
  "effect_id",
  "effect_contract_version",
  "status",
  "reason",
]);
const CONTENT_REF_FIELDS = new Set(["id", "hash"]);
const ACTIVATION_PAYLOAD_FIELDS = new Set([
  "cutover_id",
  "cutover_schema_version",
  "settlement_contract_version",
  "send_authorization_contract_version",
  "pre_cutover_projection_hash",
  "readiness_assessment_ref",
  "occurred_at",
]);
const RECEIPT_PAYLOAD_FIELDS = new Set([
  "cutover_id",
  "source_type",
  "identity_hash",
  "payload_hash",
  "batch_id",
  "applied_journal_sequence",
  "event_ids",
  "result",
  "occurred_at",
]);
const RESULT_FIELDS = new Set([
  "status",
  "settlement_contract_version",
  "send_authorization_contract_version",
]);
const EVENT_FIELDS = new Set([
  "event_id",
  "schema_version",
  "type",
  "payload",
  "evidence_refs",
]);
const BATCH_FIELDS = new Set([
  "expected_revision",
  "batch_id",
  "actor",
  "correlation_id",
  "events",
]);
const BATCH_ACTOR_FIELDS = new Set(["type", "id"]);
const EPOCH_FIELDS = new Set([
  "epoch_schema_version",
  "settlement_contract_version",
  "send_authorization_contract_version",
  "cutover_id",
  "legacy_tail_sequence",
  "activation_journal_sequence",
  "activation_batch_id",
  "activation_event_id",
  "activation_receipt_event_id",
  "activation_batch_core_hash",
  "pre_cutover_projection_hash",
  "readiness_assessment_ref",
  "activated_at",
  "receipt",
]);

class BusinessProviderSettlementCutoverBoundaryError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "BusinessProviderSettlementCutoverBoundaryError";
    this.code = code;
    this.details = deepFreeze({ ...details });
  }
}

function boundaryError(code, message, details) {
  return new BusinessProviderSettlementCutoverBoundaryError(code, message, details);
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

function hasExactFields(value, fields) {
  if (!isPlainObject(value)) return false;
  const names = Object.keys(value);
  return names.length === fields.size
    && names.every((name) => fields.has(name))
    && [...fields].every((name) => Object.hasOwn(value, name));
}

function canonicalClone(value, code = "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_INVALID") {
  let serialized;
  try {
    serialized = canonicalJson(value);
  } catch (error) {
    throw boundaryError(code, "Value must be bounded canonical JSON", {
      cause_code: error?.code || null,
    });
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_VALUE_BYTES) {
    throw boundaryError(code, "Value exceeds the cutover boundary size limit");
  }
  return JSON.parse(serialized);
}

function immutableProjectionSnapshot(value) {
  let serialized;
  try {
    serialized = canonicalJson(value);
  } catch (error) {
    throw boundaryError(
      "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_PROJECTION_INVALID",
      "Business projection must be canonical JSON",
      { cause_code: error?.code || null },
    );
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_PROJECTION_BYTES) {
    throw boundaryError(
      "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_PROJECTION_INVALID",
      "Business projection exceeds the cutover boundary size limit",
    );
  }
  return deepFreeze(JSON.parse(serialized));
}

function same(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function text(value, path, maximumBytes = MAX_REF_BYTES) {
  if (typeof value !== "string"
      || value.trim() === ""
      || value.trim() !== value
      || Buffer.byteLength(value, "utf8") > maximumBytes
      || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw boundaryError(
      "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_INVALID",
      `${path} must be bounded non-empty text`,
      { path },
    );
  }
  return value;
}

function portableRef(value, path) {
  const normalized = text(value, path);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@+\-]*$/u.test(normalized)) {
    throw boundaryError(
      "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_INVALID",
      `${path} must be a portable reference`,
      { path },
    );
  }
  return normalized;
}

function sha256(value, path) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw boundaryError(
      "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_INVALID",
      `${path} must be a lowercase SHA-256 hash`,
      { path },
    );
  }
  return value;
}

function integer(value, path, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw boundaryError(
      "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_INVALID",
      `${path} must be an integer greater than or equal to ${minimum}`,
      { path },
    );
  }
  return value;
}

function timestamp(value, path) {
  if (typeof value !== "string"
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
      || Number.isNaN(Date.parse(value))
      || new Date(value).toISOString() !== value) {
    throw boundaryError(
      "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_INVALID",
      `${path} must be a real millisecond UTC timestamp`,
      { path },
    );
  }
  return value;
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function normalizeContentRef(value, path, { derivedPrefix = null } = {}) {
  if (!hasExactFields(value, CONTENT_REF_FIELDS)) {
    throw boundaryError(
      "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_READINESS_INVALID",
      `${path} must be an exact content-addressed reference`,
      { path },
    );
  }
  const normalized = {
    id: portableRef(value.id, `${path}.id`),
    hash: sha256(value.hash, `${path}.hash`),
  };
  if (derivedPrefix
      && normalized.id !== `${derivedPrefix}-${normalized.hash.slice(0, 32)}`) {
    throw boundaryError(
      "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_READINESS_INVALID",
      `${path}.id must be derived from its content hash`,
      { path },
    );
  }
  return normalized;
}

function normalizeProviderSettlementCutoverEnvelopeV1(input) {
  const value = canonicalClone(input);
  if (!hasExactFields(value, CUTOVER_FIELDS)) {
    throw boundaryError(
      "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_INVALID",
      "Cutover envelope fields must match V1 exactly",
    );
  }
  if (value.version !== PROVIDER_SETTLEMENT_CUTOVER_ENVELOPE_VERSION) {
    throw boundaryError(
      "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_VERSION",
      `Unsupported provider-settlement cutover version: ${value.version}`,
    );
  }
  const cutoverId = portableRef(value.cutover_id, "cutover.cutover_id");
  if (!/^PSC-[a-f0-9]{32}$/u.test(cutoverId)) {
    throw boundaryError(
      "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_INVALID",
      "cutover_id must be a V1 provider-settlement cutover identifier",
    );
  }
  if (!hasExactFields(value.actor, ACTOR_FIELDS) || value.actor.type !== "system") {
    throw boundaryError(
      "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_ACTOR_INVALID",
      "Provider-settlement cutover may only assert a system actor",
    );
  }
  if (value.settlement_contract_version !== PROVIDER_SETTLEMENT_CONTRACT_VERSION) {
    throw boundaryError(
      "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_VERSION",
      "Cutover can only activate provider-settlement contract V2",
    );
  }
  if (value.send_authorization_contract_version !== SEND_AUTHORIZATION_CONTRACT_VERSION) {
    throw boundaryError(
      "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_VERSION",
      "Cutover can only activate send-authorization contract V2",
    );
  }
  const payload = {
    settlement_contract_version: PROVIDER_SETTLEMENT_CONTRACT_VERSION,
    send_authorization_contract_version: SEND_AUTHORIZATION_CONTRACT_VERSION,
  };
  const payloadHash = sha256(value.payload_hash, "cutover.payload_hash");
  if (payloadHash !== canonicalHash(payload)) {
    throw boundaryError(
      "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_HASH_MISMATCH",
      "payload_hash does not bind the normalized cutover intent",
    );
  }
  return deepFreeze({
    version: PROVIDER_SETTLEMENT_CUTOVER_ENVELOPE_VERSION,
    cutover_id: cutoverId,
    actor: {
      type: "system",
      actor_id: portableRef(value.actor.actor_id, "cutover.actor.actor_id"),
    },
    settlement_contract_version: PROVIDER_SETTLEMENT_CONTRACT_VERSION,
    send_authorization_contract_version: SEND_AUTHORIZATION_CONTRACT_VERSION,
    payload_hash: payloadHash,
  });
}

function normalizePrincipal(value) {
  const principal = value?.principal || value;
  if (!hasExactFields(principal, PRINCIPAL_FIELDS) || principal.type !== "system") {
    throw boundaryError(
      "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_AUTHENTICATION_INVALID",
      "Authenticator must return one exact system principal",
    );
  }
  return deepFreeze({
    type: "system",
    id: portableRef(principal.id, "principal.id"),
  });
}

function normalizeAuthority(value, cutover, principal) {
  if (!hasExactFields(value, AUTHORITY_FIELDS)
      || value.authorized !== true
      || value.principal_type !== "system"
      || value.principal_id !== principal.id
      || value.action !== PROVIDER_SETTLEMENT_CUTOVER_ACTION
      || value.cutover_id !== cutover.cutover_id
      || value.settlement_contract_version !== PROVIDER_SETTLEMENT_CONTRACT_VERSION
      || value.send_authorization_contract_version
        !== SEND_AUTHORIZATION_CONTRACT_VERSION) {
    throw boundaryError(
      "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_AUTHORIZATION_DENIED",
      "Authorization must return an exact grant for the journal-global V2 cutover",
    );
  }
  return deepFreeze(canonicalClone(
    value,
    "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_AUTHORIZATION_DENIED",
  ));
}

function cutoverIdentityHash(cutover, principal) {
  return canonicalHash({
    source_type: PROVIDER_SETTLEMENT_CUTOVER_SOURCE_TYPE,
    cutover,
    authenticated_principal: principal,
  });
}

function normalizeReplay(value) {
  if (!isPlainObject(value)
      || !isPlainObject(value.state)
      || !isPlainObject(value.watermark)
      || !Number.isSafeInteger(value.watermark.journal_sequence)
      || value.watermark.journal_sequence < 0
      || !isPlainObject(value.state.work_orders)
      || !isPlainObject(value.state.command_receipts)
      || !isPlainObject(value.state.observation_receipts)
      || !isPlainObject(value.state.internal_receipts)
      || !isPlainObject(value.state.outbox)
      || value.state.schema_version !== PROVIDER_SETTLEMENT_CUTOVER_PROJECTION_SCHEMA_VERSION
      || !Object.hasOwn(value.state, "provider_settlement_epoch")) {
    throw boundaryError(
      "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_PROJECTION_INVALID",
      "Replay must return the authoritative V2 Business projection and journal watermark",
    );
  }
  return value;
}

function normalizeReceiptResult(value) {
  if (!hasExactFields(value, RESULT_FIELDS)
      || value.status !== "activated"
      || value.settlement_contract_version !== PROVIDER_SETTLEMENT_CONTRACT_VERSION
      || value.send_authorization_contract_version
        !== SEND_AUTHORIZATION_CONTRACT_VERSION) {
    throw boundaryError(
      "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_RECEIPT_INVALID",
      "Cutover receipt result is malformed",
    );
  }
  return {
    status: "activated",
    settlement_contract_version: PROVIDER_SETTLEMENT_CONTRACT_VERSION,
    send_authorization_contract_version: SEND_AUTHORIZATION_CONTRACT_VERSION,
  };
}

function normalizeCutoverReceipt(value) {
  if (!hasExactFields(value, RECEIPT_PAYLOAD_FIELDS)) {
    throw boundaryError(
      "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_RECEIPT_INVALID",
      "Stored cutover receipt has an invalid shape",
    );
  }
  const eventIds = Array.isArray(value.event_ids)
    ? value.event_ids.map((entry, index) => portableRef(entry, `receipt.event_ids[${index}]`))
    : null;
  if (!eventIds || eventIds.length !== 1) {
    throw boundaryError(
      "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_RECEIPT_INVALID",
      "Cutover receipt must bind exactly the activation event",
    );
  }
  return {
    cutover_id: portableRef(value.cutover_id, "receipt.cutover_id"),
    source_type: value.source_type,
    identity_hash: sha256(value.identity_hash, "receipt.identity_hash"),
    payload_hash: sha256(value.payload_hash, "receipt.payload_hash"),
    batch_id: portableRef(value.batch_id, "receipt.batch_id"),
    applied_journal_sequence: integer(
      value.applied_journal_sequence,
      "receipt.applied_journal_sequence",
      1,
    ),
    event_ids: eventIds,
    result: normalizeReceiptResult(value.result),
    occurred_at: timestamp(value.occurred_at, "receipt.occurred_at"),
  };
}

function normalizeProviderSettlementEpochV1(value) {
  if (!hasExactFields(value, EPOCH_FIELDS)) {
    throw boundaryError(
      "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_RECEIPT_INVALID",
      "Projected provider-settlement epoch is malformed",
    );
  }
  const receipt = normalizeCutoverReceipt(value.receipt);
  const epoch = {
    epoch_schema_version: integer(value.epoch_schema_version, "epoch.epoch_schema_version", 1),
    settlement_contract_version: integer(
      value.settlement_contract_version,
      "epoch.settlement_contract_version",
      1,
    ),
    send_authorization_contract_version: integer(
      value.send_authorization_contract_version,
      "epoch.send_authorization_contract_version",
      SEND_AUTHORIZATION_CONTRACT_VERSION,
    ),
    cutover_id: portableRef(value.cutover_id, "epoch.cutover_id"),
    legacy_tail_sequence: integer(value.legacy_tail_sequence, "epoch.legacy_tail_sequence"),
    activation_journal_sequence: integer(
      value.activation_journal_sequence,
      "epoch.activation_journal_sequence",
      1,
    ),
    activation_batch_id: portableRef(value.activation_batch_id, "epoch.activation_batch_id"),
    activation_event_id: portableRef(value.activation_event_id, "epoch.activation_event_id"),
    activation_receipt_event_id: portableRef(
      value.activation_receipt_event_id,
      "epoch.activation_receipt_event_id",
    ),
    activation_batch_core_hash: sha256(
      value.activation_batch_core_hash,
      "epoch.activation_batch_core_hash",
    ),
    pre_cutover_projection_hash: sha256(
      value.pre_cutover_projection_hash,
      "epoch.pre_cutover_projection_hash",
    ),
    readiness_assessment_ref: normalizeContentRef(
      value.readiness_assessment_ref,
      "epoch.readiness_assessment_ref",
      { derivedPrefix: "PSA" },
    ),
    activated_at: timestamp(value.activated_at, "epoch.activated_at"),
    receipt,
  };
  if (epoch.epoch_schema_version !== PROVIDER_SETTLEMENT_CUTOVER_SCHEMA_VERSION
      || epoch.settlement_contract_version !== PROVIDER_SETTLEMENT_CONTRACT_VERSION
      || epoch.send_authorization_contract_version
        !== SEND_AUTHORIZATION_CONTRACT_VERSION
      || !/^PSC-[a-f0-9]{32}$/u.test(epoch.cutover_id)
      || epoch.activation_journal_sequence !== epoch.legacy_tail_sequence + 1
      || receipt.cutover_id !== epoch.cutover_id
      || receipt.source_type !== PROVIDER_SETTLEMENT_CUTOVER_SOURCE_TYPE
      || receipt.batch_id !== epoch.activation_batch_id
      || receipt.applied_journal_sequence !== epoch.activation_journal_sequence
      || receipt.event_ids[0] !== epoch.activation_event_id
      || receipt.occurred_at !== epoch.activated_at) {
    throw boundaryError(
      "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_RECEIPT_INVALID",
      "Projected cutover epoch does not close over its exact receipt and journal position",
    );
  }
  return deepFreeze(epoch);
}

function assertExactEpochReceiptClosure(epoch, cutover, identityHash) {
  const activationPayload = {
    cutover_id: epoch.cutover_id,
    cutover_schema_version: epoch.epoch_schema_version,
    settlement_contract_version: epoch.settlement_contract_version,
    send_authorization_contract_version: epoch.send_authorization_contract_version,
    pre_cutover_projection_hash: epoch.pre_cutover_projection_hash,
    readiness_assessment_ref: epoch.readiness_assessment_ref,
    occurred_at: epoch.activated_at,
  };
  const activationEvidenceRefs = [epoch.readiness_assessment_ref.id];
  const activation = {
    event_id: eventId(
      epoch.cutover_id,
      0,
      PROVIDER_SETTLEMENT_ACTIVATED_EVENT,
      activationPayload,
      activationEvidenceRefs,
    ),
    schema_version: 1,
    type: PROVIDER_SETTLEMENT_ACTIVATED_EVENT,
    payload: activationPayload,
    evidence_refs: activationEvidenceRefs,
  };
  const receiptEvent = {
    event_id: eventId(
      epoch.cutover_id,
      1,
      PROVIDER_SETTLEMENT_CUTOVER_RECEIVED_EVENT,
      epoch.receipt,
      [],
    ),
    schema_version: 1,
    type: PROVIDER_SETTLEMENT_CUTOVER_RECEIVED_EVENT,
    payload: epoch.receipt,
    evidence_refs: [],
  };
  const request = {
    expected_revision: epoch.legacy_tail_sequence,
    batch_id: epoch.activation_batch_id,
    actor: { type: "system", id: cutover.actor.actor_id },
    correlation_id: epoch.cutover_id,
    events: [activation, receiptEvent],
  };
  let derived;
  try {
    derived = deriveProviderSettlementEpochFromBatchV1(request);
  } catch (error) {
    throw boundaryError(
      "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_RECEIPT_INVALID",
      "Projected cutover receipt cannot reconstruct its activation batch",
      { cause_code: error?.code || null },
    );
  }
  if (epoch.receipt.identity_hash !== identityHash
      || !same(epoch, derived)) {
    throw boundaryError(
      "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_RECEIPT_INVALID",
      "Projected cutover receipt does not bind its exact marker events, actor, and batch core",
    );
  }
}

function readReceipt(projection, cutover, identityHash) {
  const value = projection.provider_settlement_epoch;
  if (value === null) return RECEIPT_NOT_FOUND;
  const epoch = normalizeProviderSettlementEpochV1(value);
  if (epoch.cutover_id !== cutover.cutover_id) return RECEIPT_NOT_FOUND;
  if (epoch.receipt.identity_hash !== identityHash
      || epoch.receipt.payload_hash !== cutover.payload_hash) {
    throw boundaryError(
      "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_ID_CONFLICT",
      "Cutover ID is already bound to different immutable content or principal",
      { cutover_id: cutover.cutover_id },
    );
  }
  assertExactEpochReceiptClosure(epoch, cutover, identityHash);
  return canonicalClone(
    epoch.receipt.result,
    "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_RECEIPT_INVALID",
  );
}

function pendingProjectionInputs(projection) {
  const inputs = [];
  for (const [workOrderId, workOrder] of Object.entries(projection.work_orders)) {
    if (!isPlainObject(workOrder)) {
      throw boundaryError(
        "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_PROJECTION_INVALID",
        "Business projection contains a malformed Work Order",
        { work_order_id: workOrderId },
      );
    }
    const pending = workOrder.pending_projection_input;
    if (pending === null || pending === undefined) continue;
    if (!isPlainObject(pending)) {
      throw boundaryError(
        "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_PROJECTION_INVALID",
        "Work Order pending input is malformed",
        { work_order_id: workOrderId },
      );
    }
    const entry = {
      work_order_id: portableRef(workOrderId, "readiness.pending.work_order_id"),
      source_id: portableRef(pending.source_id, "readiness.pending.source_id"),
      source_type: portableRef(pending.source_type, "readiness.pending.source_type"),
      batch_id: portableRef(pending.batch_id, "readiness.pending.batch_id"),
    };
    inputs.push(entry);
  }
  return inputs.sort((left, right) => compareText(left.work_order_id, right.work_order_id));
}

function unsafeProviderEffects(projection) {
  const effects = [];
  for (const [effectId, effect] of Object.entries(projection.outbox)) {
    if (!isPlainObject(effect)) {
      throw boundaryError(
        "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_PROJECTION_INVALID",
        "Business projection contains a malformed outbox effect",
        { effect_id: effectId },
      );
    }
    const version = effect.effect_contract_version === undefined
      ? 1
      : effect.effect_contract_version;
    const status = effect.status;
    let reason = null;
    if (UNSAFE_PROVIDER_EFFECT_STATES.has(status)) reason = "in_flight_or_ambiguous";
    else if (version !== PROVIDER_SETTLEMENT_CONTRACT_VERSION
      && LEGACY_UNRESOLVED_PROVIDER_EFFECT_STATES.has(status)) reason = "legacy_unresolved";
    if (!reason) continue;
    effects.push({
      effect_id: portableRef(effectId, "readiness.effect.effect_id"),
      effect_contract_version: integer(version, "readiness.effect.effect_contract_version", 1),
      status: portableRef(status, "readiness.effect.status"),
      reason,
    });
  }
  return effects.sort((left, right) => compareText(left.effect_id, right.effect_id));
}

function deriveProviderSettlementCutoverReadinessV1(projection, journalSequence) {
  if (!isPlainObject(projection)
      || !isPlainObject(projection.work_orders)
      || !isPlainObject(projection.outbox)
      || projection.schema_version !== PROVIDER_SETTLEMENT_CUTOVER_PROJECTION_SCHEMA_VERSION
      || !Object.hasOwn(projection, "provider_settlement_epoch")) {
    throw boundaryError(
      "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_PROJECTION_INVALID",
      "Projected readiness requires the authoritative V2 Business projection",
    );
  }
  const sequence = integer(journalSequence, "watermark.journal_sequence");
  let projectionHash;
  try {
    projectionHash = canonicalHash(projection);
  } catch (error) {
    throw boundaryError(
      "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_PROJECTION_INVALID",
      "Business projection cannot be canonically bound for cutover",
      { cause_code: error?.code || null },
    );
  }
  return deepFreeze({
    readiness_schema_version: 1,
    journal_sequence: sequence,
    pre_cutover_projection_hash: projectionHash,
    provider_settlement_epoch: projection.provider_settlement_epoch,
    send_authorization_contract_version: SEND_AUTHORIZATION_CONTRACT_VERSION,
    pending_projection_inputs: pendingProjectionInputs(projection),
    unsafe_provider_effects: unsafeProviderEffects(projection),
  });
}

function normalizePendingInput(value, index) {
  if (!hasExactFields(value, PENDING_INPUT_FIELDS)) {
    throw boundaryError(
      "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_READINESS_INVALID",
      `assessment.projected_readiness.pending_projection_inputs[${index}] is malformed`,
    );
  }
  return {
    work_order_id: portableRef(value.work_order_id, `pending[${index}].work_order_id`),
    source_id: portableRef(value.source_id, `pending[${index}].source_id`),
    source_type: portableRef(value.source_type, `pending[${index}].source_type`),
    batch_id: portableRef(value.batch_id, `pending[${index}].batch_id`),
  };
}

function normalizeUnsafeEffect(value, index) {
  if (!hasExactFields(value, UNSAFE_EFFECT_FIELDS)) {
    throw boundaryError(
      "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_READINESS_INVALID",
      `assessment.projected_readiness.unsafe_provider_effects[${index}] is malformed`,
    );
  }
  const reason = portableRef(value.reason, `unsafe_effects[${index}].reason`);
  if (!["in_flight_or_ambiguous", "legacy_unresolved"].includes(reason)) {
    throw boundaryError(
      "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_READINESS_INVALID",
      "Unsafe provider-effect readiness reason is unsupported",
    );
  }
  return {
    effect_id: portableRef(value.effect_id, `unsafe_effects[${index}].effect_id`),
    effect_contract_version: integer(
      value.effect_contract_version,
      `unsafe_effects[${index}].effect_contract_version`,
      1,
    ),
    status: portableRef(value.status, `unsafe_effects[${index}].status`),
    reason,
  };
}

function normalizeProjectedReadiness(value) {
  if (!hasExactFields(value, PROJECTED_READINESS_FIELDS)) {
    throw boundaryError(
      "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_READINESS_INVALID",
      "Assessment must contain the exact projected-readiness surface",
    );
  }
  if (value.readiness_schema_version !== 1
      || !Array.isArray(value.pending_projection_inputs)
      || !Array.isArray(value.unsafe_provider_effects)) {
    throw boundaryError(
      "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_READINESS_INVALID",
      "Projected readiness has an unsupported version or inventory",
    );
  }
  return {
    readiness_schema_version: 1,
    journal_sequence: integer(value.journal_sequence, "readiness.journal_sequence"),
    pre_cutover_projection_hash: sha256(
      value.pre_cutover_projection_hash,
      "readiness.pre_cutover_projection_hash",
    ),
    provider_settlement_epoch: value.provider_settlement_epoch,
    send_authorization_contract_version: integer(
      value.send_authorization_contract_version,
      "readiness.send_authorization_contract_version",
      SEND_AUTHORIZATION_CONTRACT_VERSION,
    ),
    pending_projection_inputs: value.pending_projection_inputs.map(normalizePendingInput),
    unsafe_provider_effects: value.unsafe_provider_effects.map(normalizeUnsafeEffect),
  };
}

function normalizeProviderSettlementCutoverReadinessEvidenceV1(
  input,
  expectedProjectedReadiness,
) {
  const value = canonicalClone(
    input,
    "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_READINESS_INVALID",
  );
  if (!hasExactFields(value, READINESS_EVIDENCE_FIELDS)
      || !hasExactFields(value.assessment, READINESS_ASSESSMENT_FIELDS)) {
    throw boundaryError(
      "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_READINESS_INVALID",
      "Readiness resolver must return one exact assessment and content reference",
    );
  }
  const assessment = {
    assessment_schema_version: value.assessment.assessment_schema_version,
    status: value.assessment.status,
    event_store_recovery: value.assessment.event_store_recovery,
    settlement_ingress: value.assessment.settlement_ingress,
    provider_reactors: value.assessment.provider_reactors,
    send_authorization_contract_version:
      value.assessment.send_authorization_contract_version,
    projected_readiness: normalizeProjectedReadiness(value.assessment.projected_readiness),
  };
  if (assessment.assessment_schema_version !== 1
      || assessment.status !== "ready"
      || assessment.event_store_recovery !== "clean"
      || assessment.settlement_ingress !== "stopped"
      || assessment.provider_reactors !== "stopped"
      || assessment.send_authorization_contract_version
        !== SEND_AUTHORIZATION_CONTRACT_VERSION
      || assessment.projected_readiness.send_authorization_contract_version
        !== SEND_AUTHORIZATION_CONTRACT_VERSION) {
    throw boundaryError(
      "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_NOT_READY",
      "Cutover requires clean recovery and stopped settlement ingress/reactors",
    );
  }
  if (!same(assessment.projected_readiness, expectedProjectedReadiness)) {
    throw boundaryError(
      "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_READINESS_STALE",
      "Readiness assessment does not bind the exact authoritative projection and watermark",
    );
  }
  if (assessment.projected_readiness.provider_settlement_epoch !== null
      || assessment.projected_readiness.pending_projection_inputs.length !== 0
      || assessment.projected_readiness.unsafe_provider_effects.length !== 0) {
    throw boundaryError(
      "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_NOT_READY",
      "Projected Business state contains an existing epoch, incomplete input, or unsafe effect",
      {
        pending_projection_inputs:
          assessment.projected_readiness.pending_projection_inputs.length,
        unsafe_provider_effects: assessment.projected_readiness.unsafe_provider_effects.length,
      },
    );
  }
  const assessmentHash = canonicalHash(assessment);
  const ref = normalizeContentRef(
    value.readiness_assessment_ref,
    "readiness.readiness_assessment_ref",
    { derivedPrefix: "PSA" },
  );
  if (ref.hash !== assessmentHash) {
    throw boundaryError(
      "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_READINESS_HASH_MISMATCH",
      "Readiness assessment reference does not bind the exact normalized assessment",
    );
  }
  return deepFreeze({ readiness_assessment_ref: ref, assessment });
}

function eventId(sourceId, ordinal, type, payload, evidenceRefs) {
  return `BVE-${canonicalHash({
    source_id: sourceId,
    ordinal,
    type,
    payload,
    evidence_refs: evidenceRefs,
  }).slice(0, 32)}`;
}

function buildProviderSettlementCutoverBatchV1(input) {
  if (!isPlainObject(input)) {
    throw new TypeError("build input must be an object");
  }
  const cutover = normalizeProviderSettlementCutoverEnvelopeV1(input.cutover);
  const principal = normalizePrincipal(input.principal);
  if (cutover.actor.actor_id !== principal.id) {
    throw boundaryError(
      "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_ACTOR_BINDING_MISMATCH",
      "Asserted cutover actor does not match the authenticated principal",
    );
  }
  const readiness = normalizeProviderSettlementCutoverReadinessEvidenceV1(
    input.readiness,
    deriveProviderSettlementCutoverReadinessV1(input.projection, input.journal_sequence),
  );
  const occurredAt = timestamp(input.occurred_at, "occurred_at");
  const expectedRevision = integer(input.journal_sequence, "journal_sequence");
  const identityHash = cutoverIdentityHash(cutover, principal);
  const batchId = `business:${cutover.cutover_id}`;
  const result = {
    status: "activated",
    settlement_contract_version: PROVIDER_SETTLEMENT_CONTRACT_VERSION,
    send_authorization_contract_version: SEND_AUTHORIZATION_CONTRACT_VERSION,
  };
  const activationPayload = {
    cutover_id: cutover.cutover_id,
    cutover_schema_version: PROVIDER_SETTLEMENT_CUTOVER_SCHEMA_VERSION,
    settlement_contract_version: PROVIDER_SETTLEMENT_CONTRACT_VERSION,
    send_authorization_contract_version: SEND_AUTHORIZATION_CONTRACT_VERSION,
    pre_cutover_projection_hash: readiness.assessment.projected_readiness
      .pre_cutover_projection_hash,
    readiness_assessment_ref: readiness.readiness_assessment_ref,
    occurred_at: occurredAt,
  };
  const activationEvidenceRefs = [readiness.readiness_assessment_ref.id];
  const activation = {
    event_id: eventId(
      cutover.cutover_id,
      0,
      PROVIDER_SETTLEMENT_ACTIVATED_EVENT,
      activationPayload,
      activationEvidenceRefs,
    ),
    schema_version: 1,
    type: PROVIDER_SETTLEMENT_ACTIVATED_EVENT,
    payload: activationPayload,
    evidence_refs: activationEvidenceRefs,
  };
  const receiptPayload = {
    cutover_id: cutover.cutover_id,
    source_type: PROVIDER_SETTLEMENT_CUTOVER_SOURCE_TYPE,
    identity_hash: identityHash,
    payload_hash: cutover.payload_hash,
    batch_id: batchId,
    applied_journal_sequence: expectedRevision + 1,
    event_ids: [activation.event_id],
    result,
    occurred_at: occurredAt,
  };
  const receipt = {
    event_id: eventId(
      cutover.cutover_id,
      1,
      PROVIDER_SETTLEMENT_CUTOVER_RECEIVED_EVENT,
      receiptPayload,
      [],
    ),
    schema_version: 1,
    type: PROVIDER_SETTLEMENT_CUTOVER_RECEIVED_EVENT,
    payload: receiptPayload,
    evidence_refs: [],
  };
  const request = {
    expected_revision: expectedRevision,
    batch_id: batchId,
    actor: { type: "system", id: principal.id },
    correlation_id: cutover.cutover_id,
    events: [activation, receipt],
  };
  const epoch = deriveProviderSettlementEpochFromBatchV1(request);
  return deepFreeze({
    request,
    epoch,
    result,
    identity_hash: identityHash,
    readiness,
  });
}

function normalizeCutoverEvent(value, type, payloadFields) {
  if (!hasExactFields(value, EVENT_FIELDS)
      || value.schema_version !== 1
      || value.type !== type
      || !hasExactFields(value.payload, payloadFields)
      || !Array.isArray(value.evidence_refs)) {
    throw boundaryError(
      "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_BATCH_INVALID",
      `Cutover batch contains an invalid ${type} event`,
    );
  }
  return value;
}

function deriveProviderSettlementEpochFromBatchV1(input) {
  const request = canonicalClone(
    input,
    "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_BATCH_INVALID",
  );
  if (!hasExactFields(request, BATCH_FIELDS)
      || !hasExactFields(request.actor, BATCH_ACTOR_FIELDS)
      || request.actor.type !== "system"
      || !Array.isArray(request.events)
      || request.events.length !== 2) {
    throw boundaryError(
      "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_BATCH_INVALID",
      "Cutover must be one exact system-authored two-event batch",
    );
  }
  const expectedRevision = integer(request.expected_revision, "batch.expected_revision");
  const activation = normalizeCutoverEvent(
    request.events[0],
    PROVIDER_SETTLEMENT_ACTIVATED_EVENT,
    ACTIVATION_PAYLOAD_FIELDS,
  );
  const receiptEvent = normalizeCutoverEvent(
    request.events[1],
    PROVIDER_SETTLEMENT_CUTOVER_RECEIVED_EVENT,
    RECEIPT_PAYLOAD_FIELDS,
  );
  const activationPayload = activation.payload;
  const receipt = normalizeCutoverReceipt(receiptEvent.payload);
  const readinessRef = normalizeContentRef(
    activationPayload.readiness_assessment_ref,
    "activation.readiness_assessment_ref",
    { derivedPrefix: "PSA" },
  );
  const cutoverId = portableRef(activationPayload.cutover_id, "activation.cutover_id");
  const actorId = portableRef(request.actor.id, "batch.actor.id");
  const expectedPayloadHash = canonicalHash({
    settlement_contract_version: PROVIDER_SETTLEMENT_CONTRACT_VERSION,
    send_authorization_contract_version: SEND_AUTHORIZATION_CONTRACT_VERSION,
  });
  const identityCutover = {
    version: PROVIDER_SETTLEMENT_CUTOVER_ENVELOPE_VERSION,
    cutover_id: cutoverId,
    actor: { type: "system", actor_id: actorId },
    settlement_contract_version: PROVIDER_SETTLEMENT_CONTRACT_VERSION,
    send_authorization_contract_version: SEND_AUTHORIZATION_CONTRACT_VERSION,
    payload_hash: expectedPayloadHash,
  };
  const expectedIdentityHash = cutoverIdentityHash(
    identityCutover,
    { type: "system", id: actorId },
  );
  const expectedActivationId = eventId(
    cutoverId,
    0,
    activation.type,
    activation.payload,
    activation.evidence_refs,
  );
  const expectedReceiptId = eventId(
    cutoverId,
    1,
    receiptEvent.type,
    receiptEvent.payload,
    receiptEvent.evidence_refs,
  );
  if (!/^PSC-[a-f0-9]{32}$/u.test(cutoverId)
      || activationPayload.cutover_schema_version
        !== PROVIDER_SETTLEMENT_CUTOVER_SCHEMA_VERSION
      || activationPayload.settlement_contract_version
        !== PROVIDER_SETTLEMENT_CONTRACT_VERSION
      || activationPayload.send_authorization_contract_version
        !== SEND_AUTHORIZATION_CONTRACT_VERSION
      || sha256(
        activationPayload.pre_cutover_projection_hash,
        "activation.pre_cutover_projection_hash",
      ) !== activationPayload.pre_cutover_projection_hash
      || !same(activationPayload.readiness_assessment_ref, readinessRef)
      || timestamp(activationPayload.occurred_at, "activation.occurred_at")
        !== activationPayload.occurred_at
      || !same(activation.evidence_refs, [readinessRef.id])
      || activation.event_id !== expectedActivationId
      || receiptEvent.event_id !== expectedReceiptId
      || receiptEvent.evidence_refs.length !== 0
      || receipt.cutover_id !== cutoverId
      || receipt.source_type !== PROVIDER_SETTLEMENT_CUTOVER_SOURCE_TYPE
      || receipt.payload_hash !== expectedPayloadHash
      || receipt.identity_hash !== expectedIdentityHash
      || receipt.batch_id !== request.batch_id
      || receipt.applied_journal_sequence !== expectedRevision + 1
      || !same(receipt.event_ids, [activation.event_id])
      || receipt.occurred_at !== activationPayload.occurred_at
      || request.batch_id !== `business:${cutoverId}`
      || request.correlation_id !== cutoverId) {
    throw boundaryError(
      "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_BATCH_INVALID",
      "Cutover activation and receipt do not close over one journal-global epoch",
    );
  }
  return deepFreeze({
    epoch_schema_version: PROVIDER_SETTLEMENT_CUTOVER_SCHEMA_VERSION,
    settlement_contract_version: PROVIDER_SETTLEMENT_CONTRACT_VERSION,
    send_authorization_contract_version: SEND_AUTHORIZATION_CONTRACT_VERSION,
    cutover_id: cutoverId,
    legacy_tail_sequence: expectedRevision,
    activation_journal_sequence: expectedRevision + 1,
    activation_batch_id: request.batch_id,
    activation_event_id: activation.event_id,
    activation_receipt_event_id: receiptEvent.event_id,
    activation_batch_core_hash: canonicalHash(request),
    pre_cutover_projection_hash: activationPayload.pre_cutover_projection_hash,
    readiness_assessment_ref: readinessRef,
    activated_at: activationPayload.occurred_at,
    receipt,
  });
}

function assertPrevalidatedCandidate(projection, candidate, expectedEpoch) {
  if (!isPlainObject(candidate)) {
    throw boundaryError(
      "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_PREVALIDATION_INVALID",
      "Cutover prevalidator must return the candidate Business projection",
    );
  }
  const expected = { ...projection, provider_settlement_epoch: expectedEpoch };
  if (!same(candidate, expected)) {
    throw boundaryError(
      "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_PREVALIDATION_INVALID",
      "Cutover candidate may add only the exact journal-global epoch",
    );
  }
  return candidate;
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
      "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_ABORTED",
      "Provider-settlement cutover was aborted before the durable commit boundary",
      dependency ? { dependency } : {},
    );
  }
}

async function callDependency(name, invoke, externalSignal, timeoutMs) {
  throwIfAborted(externalSignal, name);
  const controller = new AbortController();
  let timer = null;
  let onAbort = null;
  const control = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(boundaryError(
        "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_DEPENDENCY_TIMEOUT",
        `Dependency ${name} exceeded its bounded execution time`,
        { dependency: name, timeout_ms: timeoutMs },
      ));
    }, timeoutMs);
    timer.unref?.();
    if (externalSignal) {
      onAbort = () => {
        controller.abort(externalSignal.reason);
        reject(boundaryError(
          "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_ABORTED",
          "Provider-settlement cutover was aborted before the durable commit boundary",
          { dependency: name },
        ));
      };
      externalSignal.addEventListener("abort", onAbort, { once: true });
    }
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => invoke(controller.signal)),
      control,
    ]);
  } finally {
    clearTimeout(timer);
    if (externalSignal && onAbort) externalSignal.removeEventListener("abort", onAbort);
  }
}

function validateDependency(condition, name) {
  if (!condition) throw new TypeError(`${name} is required`);
}

function mapBatchConflict(error, cutover) {
  if (error?.code !== "EVENT_BATCH_ID_CONFLICT") return error;
  return boundaryError(
    "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_ID_CONFLICT",
    "Cutover ID is already bound to a different atomic batch",
    { cutover_id: cutover.cutover_id },
  );
}

function defaultProjectionAdapter() {
  // Lazy loading keeps the cutover event constants available to projector.js
  // without creating a module-initialization cycle. The adapter itself is the
  // same canonical configuration used by every Business ingress boundary.
  const {
    businessProjectionConfigurationV1,
    projectBusinessEventV1,
  } = require("./projector");
  return Object.freeze({
    configuration: businessProjectionConfigurationV1(),
    prevalidateCutoverBatch({ projection, request, signal }) {
      throwIfAborted(signal, "projectionAdapter.prevalidateCutoverBatch");
      return request.events.reduce(
        (state, event) => projectBusinessEventV1(state, event, request),
        projection,
      );
    },
  });
}

/**
 * Creates the system-only, journal-global activation boundary for provider
 * settlement V2. Tests may inject a projection adapter, while production uses
 * the same canonical Business projector configuration as all ingress paths.
 */
function createBusinessProviderSettlementCutoverBoundary(options = {}) {
  const {
    eventStore,
    authorizer,
    resolvers,
    projectionAdapter,
    clock = () => new Date().toISOString(),
    maxGlobalCasRetries = 3,
    dependencyTimeoutMs = 5_000,
  } = options;
  const effectiveProjectionAdapter = projectionAdapter || defaultProjectionAdapter();
  validateDependency(eventStore && typeof eventStore.replay === "function", "eventStore.replay");
  validateDependency(eventStore && typeof eventStore.commit === "function", "eventStore.commit");
  validateDependency(authorizer && typeof authorizer.authenticate === "function", "authorizer.authenticate");
  validateDependency(authorizer && typeof authorizer.authorize === "function", "authorizer.authorize");
  validateDependency(
    resolvers && typeof resolvers.resolveReadiness === "function",
    "resolvers.resolveReadiness",
  );
  validateDependency(
    isPlainObject(effectiveProjectionAdapter.configuration),
    "projectionAdapter.configuration",
  );
  validateDependency(
    typeof effectiveProjectionAdapter.prevalidateCutoverBatch === "function",
    "projectionAdapter.prevalidateCutoverBatch",
  );
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

  async function replayProjection(signal, dependency = "eventStore.replay") {
    try {
      const replay = normalizeReplay(await callDependency(
        dependency,
        (dependencySignal) => eventStore.replay(
          effectiveProjectionAdapter.configuration,
          { signal: dependencySignal },
        ),
        signal,
        dependencyTimeoutMs,
      ));
      // Dependencies receive an immutable detached snapshot, never the
      // EventStore-owned projection object. Otherwise an in-place mutation by
      // an authorizer/resolver/prevalidator could evade the epoch-only diff.
      return deepFreeze({
        state: immutableProjectionSnapshot(replay.state),
        watermark: canonicalClone(
          replay.watermark,
          "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_PROJECTION_INVALID",
        ),
      });
    } catch (error) {
      if (error instanceof BusinessProviderSettlementCutoverBoundaryError) throw error;
      throw boundaryError(
        "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_REPLAY_FAILED",
        "Authoritative Business projection replay failed",
        { cause_code: error?.code || null },
      );
    }
  }

  async function execute(input) {
    if (!isPlainObject(input) || !Object.hasOwn(input, "cutover")) {
      throw new TypeError("execute input must contain cutover and authentication");
    }
    const cutover = normalizeProviderSettlementCutoverEnvelopeV1(input.cutover);
    const signal = validateAbortSignal(input.signal);
    let principal;
    try {
      principal = normalizePrincipal(await callDependency(
        "authorizer.authenticate",
        (dependencySignal) => authorizer.authenticate({
          authentication: input.authentication,
          signal: dependencySignal,
        }),
        signal,
        dependencyTimeoutMs,
      ));
    } catch (error) {
      if (error instanceof BusinessProviderSettlementCutoverBoundaryError) throw error;
      throw boundaryError(
        "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_AUTHENTICATION_FAILED",
        "System authentication failed",
        { cause_code: error?.code || null },
      );
    }
    if (cutover.actor.actor_id !== principal.id) {
      throw boundaryError(
        "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_ACTOR_BINDING_MISMATCH",
        "Asserted cutover actor does not match the authenticated system principal",
      );
    }
    const identityHash = cutoverIdentityHash(cutover, principal);

    for (let casAttempt = 0; casAttempt <= maxGlobalCasRetries; casAttempt += 1) {
      throwIfAborted(signal);
      const replay = await replayProjection(signal);
      let authority;
      try {
        authority = normalizeAuthority(await callDependency(
          "authorizer.authorize",
          (dependencySignal) => authorizer.authorize({
            principal,
            action: PROVIDER_SETTLEMENT_CUTOVER_ACTION,
            cutover,
            projection: replay.state,
            watermark: replay.watermark,
            signal: dependencySignal,
          }),
          signal,
          dependencyTimeoutMs,
        ), cutover, principal);
      } catch (error) {
        if (error instanceof BusinessProviderSettlementCutoverBoundaryError) throw error;
        throw boundaryError(
          "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_AUTHORIZATION_DENIED",
          "Provider-settlement cutover authorization failed",
          { cause_code: error?.code || null },
        );
      }

      // An exact historical receipt is authoritative before every readiness,
      // already-activated, or migration gate.
      const replayed = readReceipt(replay.state, cutover, identityHash);
      if (replayed !== RECEIPT_NOT_FOUND) return replayed;
      if (replay.state.provider_settlement_epoch !== null) {
        throw boundaryError(
          "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_ALREADY_ACTIVATED",
          "Provider-settlement V2 is already activated by another cutover",
          {
            cutover_id: cutover.cutover_id,
            active_cutover_id: replay.state.provider_settlement_epoch?.cutover_id || null,
          },
        );
      }

      const projectedReadiness = deriveProviderSettlementCutoverReadinessV1(
        replay.state,
        replay.watermark.journal_sequence,
      );
      let readiness;
      try {
        const resolved = await callDependency(
          "resolvers.resolveReadiness",
          (dependencySignal) => resolvers.resolveReadiness({
            cutover,
            principal,
            authority,
            projected_readiness: projectedReadiness,
            signal: dependencySignal,
          }),
          signal,
          dependencyTimeoutMs,
        );
        readiness = normalizeProviderSettlementCutoverReadinessEvidenceV1(
          resolved,
          projectedReadiness,
        );
      } catch (error) {
        if (error instanceof BusinessProviderSettlementCutoverBoundaryError) throw error;
        throw boundaryError(
          "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_READINESS_RESOLUTION_FAILED",
          "Authoritative cutover readiness resolution failed",
          { cause_code: error?.code || null },
        );
      }

      let occurredAt;
      try {
        occurredAt = timestamp(clock(), "clock");
      } catch (error) {
        if (error instanceof BusinessProviderSettlementCutoverBoundaryError) {
          throw boundaryError(
            "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_CLOCK_INVALID",
            "Cutover clock must return a real millisecond UTC timestamp",
            { cause_code: error.code },
          );
        }
        throw error;
      }
      const candidate = buildProviderSettlementCutoverBatchV1({
        cutover,
        principal,
        projection: replay.state,
        journal_sequence: replay.watermark.journal_sequence,
        readiness,
        occurred_at: occurredAt,
      });
      let candidateProjection;
      try {
        candidateProjection = await callDependency(
          "projectionAdapter.prevalidateCutoverBatch",
          (dependencySignal) => effectiveProjectionAdapter.prevalidateCutoverBatch({
            projection: replay.state,
            request: candidate.request,
            expected_epoch: candidate.epoch,
            signal: dependencySignal,
          }),
          signal,
          dependencyTimeoutMs,
        );
      } catch (error) {
        if (error instanceof BusinessProviderSettlementCutoverBoundaryError) throw error;
        throw boundaryError(
          "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_PREVALIDATION_FAILED",
          "Candidate marker failed the authoritative Business projector",
          { cause_code: error?.code || null },
        );
      }
      assertPrevalidatedCandidate(replay.state, candidateProjection, candidate.epoch);
      const projectedResult = readReceipt(candidateProjection, cutover, identityHash);
      if (projectedResult === RECEIPT_NOT_FOUND || !same(projectedResult, candidate.result)) {
        throw boundaryError(
          "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_PREVALIDATION_INVALID",
          "Candidate projection did not close with the exact cutover receipt",
        );
      }

      // Commit itself is not timed out: after entering the durable boundary,
      // an uncertain response must be reconciled through the exact receipt.
      throwIfAborted(signal, "eventStore.commit");
      try {
        const commitResult = await eventStore.commit(candidate.request);
        if (!isPlainObject(commitResult)
            || !["committed", "idempotent"].includes(commitResult.status)) {
          throw boundaryError(
            "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_EVENT_STORE_RESULT_INVALID",
            "EventStore returned an invalid cutover commit result",
          );
        }
        if (commitResult.status === "idempotent") {
          const committed = await replayProjection(null, "eventStore.replay_after_commit");
          const stored = readReceipt(committed.state, cutover, identityHash);
          if (stored === RECEIPT_NOT_FOUND) {
            throw boundaryError(
              "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_RECEIPT_MISSING",
              "Idempotent cutover batch has no exact projected receipt",
            );
          }
          return stored;
        }
        return canonicalClone(
          candidate.result,
          "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_RECEIPT_INVALID",
        );
      } catch (error) {
        if (["EVENT_REVISION_CONFLICT", "EVENT_LOCK_BUSY"].includes(error?.code)) {
          if (casAttempt < maxGlobalCasRetries) continue;
          throw boundaryError(
            "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_GLOBAL_CAS_EXHAUSTED",
            "Global EventStore revision changed too many times during cutover",
            { attempts: casAttempt + 1 },
          );
        }
        let recoveryFailure = null;
        try {
          const recovered = await replayProjection(
            null,
            "eventStore.replay_after_commit_error",
          );
          const stored = readReceipt(recovered.state, cutover, identityHash);
          if (stored !== RECEIPT_NOT_FOUND) return stored;
        } catch (replayError) {
          if (replayError?.code === "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_ID_CONFLICT") {
            throw replayError;
          }
          recoveryFailure = replayError;
        }
        if (recoveryFailure) {
          throw boundaryError(
            "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_COMMIT_OUTCOME_UNKNOWN",
            "Cutover commit outcome is unknown because durable receipt recovery failed",
            {
              cause_code: error?.code || null,
              recovery_code: recoveryFailure?.code || null,
              commit_outcome: "unknown",
              reconciliation_required: true,
            },
          );
        }
        const mapped = mapBatchConflict(error, cutover);
        if (mapped instanceof BusinessProviderSettlementCutoverBoundaryError) throw mapped;
        throw boundaryError(
          "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_COMMIT_FAILED",
          "Cutover commit failed without a matching durable receipt",
          { cause_code: mapped?.code || null, commit_outcome: "not_observed" },
        );
      }
    }
    throw boundaryError(
      "BUSINESS_PROVIDER_SETTLEMENT_CUTOVER_GLOBAL_CAS_EXHAUSTED",
      "Global EventStore revision retry bound was exhausted during cutover",
    );
  }

  return Object.freeze({ execute });
}

module.exports = {
  PROVIDER_SETTLEMENT_CUTOVER_ACTION,
  PROVIDER_SETTLEMENT_CUTOVER_ENVELOPE_VERSION,
  PROVIDER_SETTLEMENT_CUTOVER_PROJECTION_SCHEMA_VERSION,
  PROVIDER_SETTLEMENT_CUTOVER_RECEIVED_EVENT,
  PROVIDER_SETTLEMENT_CUTOVER_SCHEMA_VERSION,
  PROVIDER_SETTLEMENT_CUTOVER_SOURCE_TYPE,
  PROVIDER_SETTLEMENT_ACTIVATED_EVENT,
  PROVIDER_SETTLEMENT_CONTRACT_VERSION,
  BusinessProviderSettlementCutoverBoundaryError,
  buildProviderSettlementCutoverBatchV1,
  createBusinessProviderSettlementCutoverBoundary,
  deriveProviderSettlementCutoverReadinessV1,
  deriveProviderSettlementEpochFromBatchV1,
  normalizeProviderSettlementCutoverEnvelopeV1,
  normalizeProviderSettlementCutoverReadinessEvidenceV1,
  normalizeProviderSettlementEpochV1,
};
