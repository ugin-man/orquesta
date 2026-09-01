"use strict";

const { canonicalHash, canonicalJson } = require("@orquesta/contracts");
const {
  deriveCommittedSendAuthorizationHashV2,
  normalizeCommittedSendAuthorizationProofV2,
} = require("./send-authorization");

const PROVIDER_ENTRY_WINDOW_VERSION = 1;
const PROVIDER_ENTRY_WINDOW_INDEX_VERSION = 1;
const PROVIDER_ENTRY_AUTHORIZATION_VERSION = 1;
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
const RENEWAL_EVENT_PAYLOAD_FIELDS = new Set([
  "work_order_id",
  "plan_snapshot_ref",
  "plan_hash",
  "source_id",
  "prior_work_order_revision",
  "target_work_order_revision",
  "occurred_at",
  "effect_id",
  "effect",
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
const WINDOW_BODY_FIELDS = new Set([
  "provider_entry_window_version",
  "window_kind",
  "send_authorization_bundle_ref",
  "committed_send_authorization_hash",
  "effect_id",
  "authorized_fencing_token",
  "window_sequence",
  "previous_window_ref",
  "previous_lease_expires_at",
  "lease_expires_at",
  "source_event",
  "source_event_ref",
  "batch_id",
  "domain_event_manifest_hash",
]);
const WINDOW_FIELDS = new Set([...WINDOW_BODY_FIELDS, "window_ref"]);
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
const RENEWAL_RESULT_FIELDS = new Set([
  "internal_action_id",
  "work_order_id",
  "work_order_revision",
  "effect_id",
  "action",
  "outbox_status",
  "fencing_token",
  "provider_entry_window_continuation",
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
const INDEX_FIELDS = new Set([
  "index_version",
  "effect_id",
  "send_authorization_bundle_ref",
  "committed_send_authorization_hash",
  "authorized_fencing_token",
  "current_window_ref",
  "current_window_sequence",
  "current_lease_expires_at",
  "send_authorization_receipt_id",
  "send_authorization_receipt_ref",
  "current_window_receipt_id",
  "current_window_receipt_ref",
]);
const ENTRY_AUTHORIZATION_PROOF_FIELDS = new Set([
  "provider_entry_authorization_version",
  "committed_send_authorization",
  "committed_send_authorization_hash",
  "entry_window",
  "entry_window_internal_receipt",
  "continuation_chain",
  "current_window_index",
]);
const ENTRY_AUTHORIZATION_CHAIN_FIELDS = new Set([
  "provider_entry_window",
  "internal_receipt",
]);

class BusinessProviderEntryWindowError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "BusinessProviderEntryWindowError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details = {}) {
  throw new BusinessProviderEntryWindowError(code, message, details);
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
      "BUSINESS_PROVIDER_ENTRY_WINDOW_INVALID",
      `${path} must be one exact object`,
      { path },
    );
  }
  return value;
}

function exactDataObjectSnapshot(value, fields, path) {
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
    fail(
      "BUSINESS_PROVIDER_ENTRY_WINDOW_INVALID",
      `${path} must expose a stable exact data shape`,
      { path, cause_code: error?.code || error?.name || null },
    );
  }
  if (prototype !== Object.prototype && prototype !== null) {
    fail(
      "BUSINESS_PROVIDER_ENTRY_WINDOW_INVALID",
      `${path} must be one exact data object`,
      { path },
    );
  }
  if (ownKeys.length !== fields.size
      || ownKeys.some((field) => typeof field !== "string" || !fields.has(field))) {
    fail(
      "BUSINESS_PROVIDER_ENTRY_WINDOW_INVALID",
      `${path} must be one exact data object`,
      { path },
    );
  }
  const snapshot = {};
  for (const field of fields) {
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, field);
    } catch (error) {
      fail(
        "BUSINESS_PROVIDER_ENTRY_WINDOW_INVALID",
        `${path}.${field} must expose a stable data property`,
        { path: `${path}.${field}`, cause_code: error?.code || error?.name || null },
      );
    }
    if (!descriptor
        || !("value" in descriptor)
        || descriptor.enumerable !== true) {
      fail(
        "BUSINESS_PROVIDER_ENTRY_WINDOW_INVALID",
        `${path}.${field} must be an enumerable data property`,
        { path: `${path}.${field}` },
      );
    }
    snapshot[field] = descriptor.value;
  }
  return snapshot;
}

function denseDataArraySnapshot(value, path) {
  let isArray;
  let prototype;
  let lengthDescriptor;
  let ownKeys;
  try {
    isArray = Array.isArray(value);
    prototype = isArray ? Object.getPrototypeOf(value) : undefined;
    lengthDescriptor = isArray
      ? Object.getOwnPropertyDescriptor(value, "length")
      : undefined;
    ownKeys = isArray ? Reflect.ownKeys(value) : [];
  } catch (error) {
    fail(
      "BUSINESS_PROVIDER_ENTRY_WINDOW_NOT_COVERED",
      `${path} must expose a stable ordered data-property list`,
      { path, cause_code: error?.code || error?.name || null },
    );
  }
  if (!isArray || prototype !== Array.prototype) {
    fail(
      "BUSINESS_PROVIDER_ENTRY_WINDOW_NOT_COVERED",
      `${path} must be an ordered dense data-property list`,
      { path },
    );
  }
  const length = lengthDescriptor?.value;
  if (!Number.isInteger(length)
      || length < 0
      || ownKeys.length !== length + 1
      || ownKeys.at(-1) !== "length") {
    fail(
      "BUSINESS_PROVIDER_ENTRY_WINDOW_NOT_COVERED",
      `${path} must be an ordered dense data-property list`,
      { path },
    );
  }
  const snapshot = [];
  for (let index = 0; index < length; index += 1) {
    const field = String(index);
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, field);
    } catch (error) {
      fail(
        "BUSINESS_PROVIDER_ENTRY_WINDOW_NOT_COVERED",
        `${path}[${index}] must expose a stable data property`,
        { path: `${path}[${index}]`, cause_code: error?.code || error?.name || null },
      );
    }
    if (ownKeys[index] !== field
        || !descriptor
        || !("value" in descriptor)
        || descriptor.enumerable !== true) {
      fail(
        "BUSINESS_PROVIDER_ENTRY_WINDOW_NOT_COVERED",
        `${path}[${index}] must be an enumerable data property`,
        { path: `${path}[${index}]` },
      );
    }
    snapshot.push(descriptor.value);
  }
  return snapshot;
}

function canonicalClone(value, path) {
  let serialized;
  try {
    serialized = canonicalJson(value);
  } catch (error) {
    fail(
      "BUSINESS_PROVIDER_ENTRY_WINDOW_INVALID",
      `${path} must be canonical JSON`,
      { path, cause_code: error?.code || null },
    );
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_CANONICAL_BYTES) {
    fail(
      "BUSINESS_PROVIDER_ENTRY_WINDOW_INVALID",
      `${path} exceeds the boundary limit`,
      { path },
    );
  }
  return JSON.parse(serialized);
}

function text(value, path, maximumBytes = 512) {
  if (typeof value !== "string"
      || value.trim() === ""
      || value.trim() !== value
      || Buffer.byteLength(value, "utf8") > maximumBytes
      || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(
      "BUSINESS_PROVIDER_ENTRY_WINDOW_INVALID",
      `${path} must be bounded non-empty text`,
      { path },
    );
  }
  return value;
}

function portableRef(value, path) {
  const normalized = text(value, path);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@+\-]*$/u.test(normalized)) {
    fail(
      "BUSINESS_PROVIDER_ENTRY_WINDOW_INVALID",
      `${path} must be a portable reference`,
      { path },
    );
  }
  return normalized;
}

function sha256(value, path) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    fail(
      "BUSINESS_PROVIDER_ENTRY_WINDOW_INVALID",
      `${path} must be a lowercase SHA-256`,
      { path },
    );
  }
  return value;
}

function integer(value, path, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    fail(
      "BUSINESS_PROVIDER_ENTRY_WINDOW_INVALID",
      `${path} must be a safe integer greater than or equal to ${minimum}`,
      { path },
    );
  }
  return value;
}

function timestamp(value, path) {
  if (typeof value !== "string"
      || Number.isNaN(Date.parse(value))
      || new Date(value).toISOString() !== value) {
    fail(
      "BUSINESS_PROVIDER_ENTRY_WINDOW_INVALID",
      `${path} must be a canonical UTC timestamp`,
      { path },
    );
  }
  return value;
}

function contentRef(value, path) {
  const candidate = exactObject(value, CONTENT_REF_FIELDS, path);
  return {
    id: portableRef(candidate.id, `${path}.id`),
    hash: sha256(candidate.hash, `${path}.hash`),
  };
}

function derivedRef(value, path, prefix) {
  const ref = contentRef(value, path);
  if (ref.id !== `${prefix}-${ref.hash.slice(0, 32)}`) {
    fail(
      "BUSINESS_PROVIDER_ENTRY_WINDOW_INVALID",
      `${path} must derive its identifier from its content hash`,
      { path },
    );
  }
  return ref;
}

function normalizeToken(value, path) {
  const token = exactObject(value, FENCING_TOKEN_FIELDS, path);
  return {
    lease_id: portableRef(token.lease_id, `${path}.lease_id`),
    owner_id: portableRef(token.owner_id, `${path}.owner_id`),
    generation: integer(token.generation, `${path}.generation`, 1),
  };
}

function same(left, right) {
  return canonicalJson(left) === canonicalJson(right);
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

function eventManifestHash(event) {
  return canonicalHash([{
    event_id: event.event_id,
    event_hash: canonicalHash(event),
  }]);
}

function normalizeBaseProof(input) {
  try {
    return normalizeCommittedSendAuthorizationProofV2(input);
  } catch (error) {
    fail(
      "BUSINESS_PROVIDER_ENTRY_WINDOW_BASE_INVALID",
      "Provider entry window requires one exact committed send authorization V2",
      { cause_code: error?.code || null },
    );
  }
}

function baseContext(input) {
  const proof = normalizeBaseProof(input);
  return {
    proof,
    hash: deriveCommittedSendAuthorizationHashV2(proof),
    bundleRef: proof.send_authorization_bundle.bundle_ref,
    effect: proof.effect,
    token: proof.authorized_fencing_token,
    sendEvent: proof.send_event,
  };
}

function normalizeRenewalEvent(input, context) {
  const event = exactObject(
    canonicalClone(input, "source_event"),
    EVENT_FIELDS,
    "source_event",
  );
  const payload = exactObject(
    event.payload,
    RENEWAL_EVENT_PAYLOAD_FIELDS,
    "source_event.payload",
  );
  const lease = exactObject(payload.lease, LEASE_FIELDS, "source_event.payload.lease");
  const normalizedLease = {
    lease_id: portableRef(lease.lease_id, "source_event.payload.lease.lease_id"),
    owner_id: portableRef(lease.owner_id, "source_event.payload.lease.owner_id"),
    generation: integer(lease.generation, "source_event.payload.lease.generation", 1),
    claimed_at: timestamp(lease.claimed_at, "source_event.payload.lease.claimed_at"),
    heartbeat_at: timestamp(lease.heartbeat_at, "source_event.payload.lease.heartbeat_at"),
    expires_at: timestamp(lease.expires_at, "source_event.payload.lease.expires_at"),
  };
  const normalizedPayload = {
    work_order_id: portableRef(payload.work_order_id, "source_event.payload.work_order_id"),
    plan_snapshot_ref: portableRef(
      payload.plan_snapshot_ref,
      "source_event.payload.plan_snapshot_ref",
    ),
    plan_hash: sha256(payload.plan_hash, "source_event.payload.plan_hash"),
    source_id: portableRef(payload.source_id, "source_event.payload.source_id"),
    prior_work_order_revision: integer(
      payload.prior_work_order_revision,
      "source_event.payload.prior_work_order_revision",
      1,
    ),
    target_work_order_revision: integer(
      payload.target_work_order_revision,
      "source_event.payload.target_work_order_revision",
      1,
    ),
    occurred_at: timestamp(payload.occurred_at, "source_event.payload.occurred_at"),
    effect_id: portableRef(payload.effect_id, "source_event.payload.effect_id"),
    effect: canonicalClone(payload.effect, "source_event.payload.effect"),
    lease: normalizedLease,
  };
  const normalized = {
    event_id: portableRef(event.event_id, "source_event.event_id"),
    schema_version: event.schema_version,
    type: event.type,
    payload: normalizedPayload,
    evidence_refs: canonicalClone(event.evidence_refs, "source_event.evidence_refs"),
  };
  const expectedId = eventIdFor({
    sourceId: normalizedPayload.source_id,
    ordinal: 0,
    type: normalized.type,
    payload: normalizedPayload,
    evidenceRefs: normalized.evidence_refs,
  });
  const sendPayload = context.sendEvent.payload;
  if (normalized.schema_version !== 1
      || normalized.type !== "business.outbox.lease_renewed"
      || !Array.isArray(normalized.evidence_refs)
      || normalized.evidence_refs.length !== 0
      || normalized.event_id !== expectedId
      || normalizedPayload.work_order_id !== context.effect.work_order_id
      || normalizedPayload.work_order_id !== sendPayload.work_order_id
      || normalizedPayload.plan_snapshot_ref !== sendPayload.plan_snapshot_ref
      || normalizedPayload.plan_hash !== sendPayload.plan_hash
      || normalizedPayload.prior_work_order_revision
        !== normalizedPayload.target_work_order_revision
      || normalizedPayload.prior_work_order_revision
        < sendPayload.target_work_order_revision
      || normalizedPayload.effect_id !== context.effect.effect_id
      || !same(normalizedPayload.effect, context.effect)
      || !same(normalizeToken({
        lease_id: normalizedLease.lease_id,
        owner_id: normalizedLease.owner_id,
        generation: normalizedLease.generation,
      }, "source_event.payload.lease.token"), context.token)
      || normalizedLease.heartbeat_at !== normalizedPayload.occurred_at
      || Date.parse(normalizedLease.claimed_at) > Date.parse(normalizedLease.heartbeat_at)
      || Date.parse(normalizedPayload.occurred_at) < Date.parse(sendPayload.occurred_at)) {
    fail(
      "BUSINESS_PROVIDER_ENTRY_WINDOW_EVENT_INVALID",
      "Provider entry continuation requires one exact same-token internal lease renewal event",
      { event_id: normalized.event_id },
    );
  }
  return deepFreeze(normalized);
}

function windowRef(body) {
  const hash = canonicalHash(body);
  return { id: `PEW-${hash.slice(0, 32)}`, hash };
}

function anchorBody(context) {
  return {
    provider_entry_window_version: PROVIDER_ENTRY_WINDOW_VERSION,
    window_kind: "send_begin",
    send_authorization_bundle_ref: context.bundleRef,
    committed_send_authorization_hash: context.hash,
    effect_id: context.effect.effect_id,
    authorized_fencing_token: context.token,
    window_sequence: 0,
    previous_window_ref: null,
    previous_lease_expires_at: null,
    lease_expires_at: context.proof.send_begin_lease_expires_at,
    source_event: context.sendEvent,
    source_event_ref: context.proof.send_authorization_bundle.send_event_ref,
    batch_id: context.proof.send_authorization_bundle.batch_id,
    domain_event_manifest_hash:
      context.proof.send_authorization_bundle.domain_event_manifest_hash,
  };
}

function createProviderEntryWindowAnchorV1({ committed_send_authorization: inputProof } = {}) {
  const context = baseContext(inputProof);
  const body = anchorBody(context);
  return deepFreeze({ ...body, window_ref: windowRef(body) });
}

function normalizeContinuationWindow(candidate, context) {
  const sourceEvent = normalizeRenewalEvent(candidate.source_event, context);
  const sequence = integer(candidate.window_sequence, "provider_entry_window.window_sequence", 1);
  const previousWindowRef = contentRef(
    candidate.previous_window_ref,
    "provider_entry_window.previous_window_ref",
  );
  const previousLeaseExpiresAt = timestamp(
    candidate.previous_lease_expires_at,
    "provider_entry_window.previous_lease_expires_at",
  );
  const leaseExpiresAt = timestamp(
    candidate.lease_expires_at,
    "provider_entry_window.lease_expires_at",
  );
  const sourceEventRef = contentRef(
    candidate.source_event_ref,
    "provider_entry_window.source_event_ref",
  );
  const batchId = portableRef(candidate.batch_id, "provider_entry_window.batch_id");
  const body = {
    provider_entry_window_version: candidate.provider_entry_window_version,
    window_kind: candidate.window_kind,
    send_authorization_bundle_ref: contentRef(
      candidate.send_authorization_bundle_ref,
      "provider_entry_window.send_authorization_bundle_ref",
    ),
    committed_send_authorization_hash: sha256(
      candidate.committed_send_authorization_hash,
      "provider_entry_window.committed_send_authorization_hash",
    ),
    effect_id: portableRef(candidate.effect_id, "provider_entry_window.effect_id"),
    authorized_fencing_token: normalizeToken(
      candidate.authorized_fencing_token,
      "provider_entry_window.authorized_fencing_token",
    ),
    window_sequence: sequence,
    previous_window_ref: previousWindowRef,
    previous_lease_expires_at: previousLeaseExpiresAt,
    lease_expires_at: leaseExpiresAt,
    source_event: sourceEvent,
    source_event_ref: sourceEventRef,
    batch_id: batchId,
    domain_event_manifest_hash: sha256(
      candidate.domain_event_manifest_hash,
      "provider_entry_window.domain_event_manifest_hash",
    ),
  };
  const expectedSourceRef = {
    id: sourceEvent.event_id,
    hash: canonicalHash(sourceEvent),
  };
  if (body.provider_entry_window_version !== PROVIDER_ENTRY_WINDOW_VERSION
      || body.window_kind !== "same_token_sending_lease_renewal"
      || !same(body.send_authorization_bundle_ref, context.bundleRef)
      || body.committed_send_authorization_hash !== context.hash
      || body.effect_id !== context.effect.effect_id
      || !same(body.authorized_fencing_token, context.token)
      || !same(body.source_event_ref, expectedSourceRef)
      || body.batch_id !== `business:${sourceEvent.payload.source_id}`
      || body.domain_event_manifest_hash !== eventManifestHash(sourceEvent)
      || body.lease_expires_at !== sourceEvent.payload.lease.expires_at
      || Date.parse(sourceEvent.payload.occurred_at) >= Date.parse(previousLeaseExpiresAt)
      || Date.parse(leaseExpiresAt) <= Date.parse(previousLeaseExpiresAt)) {
    fail(
      "BUSINESS_PROVIDER_ENTRY_WINDOW_CONTINUATION_INVALID",
      "Provider entry continuation does not bind one later same-token lease window",
      { effect_id: context.effect.effect_id, window_sequence: sequence },
    );
  }
  return body;
}

function normalizeProviderEntryWindowV1(
  input,
  { committed_send_authorization: inputProof } = {},
) {
  const context = baseContext(inputProof);
  const candidate = exactObject(
    canonicalClone(input, "provider_entry_window"),
    WINDOW_FIELDS,
    "provider_entry_window",
  );
  let body;
  if (candidate.window_kind === "send_begin") {
    body = anchorBody(context);
  } else {
    body = normalizeContinuationWindow(candidate, context);
  }
  const suppliedBody = Object.fromEntries(
    [...WINDOW_BODY_FIELDS].map((field) => [field, candidate[field]]),
  );
  const expectedRef = windowRef(body);
  if (!same(suppliedBody, body)
      || !same(
        derivedRef(candidate.window_ref, "provider_entry_window.window_ref", "PEW"),
        expectedRef,
      )) {
    fail(
      "BUSINESS_PROVIDER_ENTRY_WINDOW_INVALID",
      "Provider entry window does not content-address its exact authorization and source event",
      { effect_id: context.effect.effect_id },
    );
  }
  return deepFreeze({ ...body, window_ref: expectedRef });
}

function assertProviderEntryWindowContinuationV1({
  committed_send_authorization: inputProof,
  previous_window: inputPrevious,
  current_window: inputCurrent,
} = {}) {
  const options = { committed_send_authorization: inputProof };
  const previous = normalizeProviderEntryWindowV1(inputPrevious, options);
  const current = normalizeProviderEntryWindowV1(inputCurrent, options);
  if (current.window_kind !== "same_token_sending_lease_renewal"
      || current.window_sequence !== previous.window_sequence + 1
      || !same(current.previous_window_ref, previous.window_ref)
      || current.previous_lease_expires_at !== previous.lease_expires_at
      || (previous.window_kind === "same_token_sending_lease_renewal"
        && (Date.parse(current.source_event.payload.occurred_at)
            <= Date.parse(previous.source_event.payload.occurred_at)
          || current.source_event.payload.prior_work_order_revision
            < previous.source_event.payload.prior_work_order_revision
          || current.source_event.payload.lease.claimed_at
            !== previous.source_event.payload.lease.claimed_at))) {
    fail(
      "BUSINESS_PROVIDER_ENTRY_WINDOW_CONTINUATION_INVALID",
      "Provider entry continuation must extend the one exact immediately preceding window",
      {
        effect_id: current.effect_id,
        previous_sequence: previous.window_sequence,
        current_sequence: current.window_sequence,
      },
    );
  }
  return current;
}

function createProviderEntryWindowContinuationV1({
  committed_send_authorization: inputProof,
  previous_window: inputPrevious,
  renewal_event: inputRenewalEvent,
  batch_id: inputBatchId,
} = {}) {
  const context = baseContext(inputProof);
  const previous = normalizeProviderEntryWindowV1(inputPrevious, {
    committed_send_authorization: context.proof,
  });
  const renewalEvent = normalizeRenewalEvent(inputRenewalEvent, context);
  const batchId = portableRef(inputBatchId, "batch_id");
  const body = {
    provider_entry_window_version: PROVIDER_ENTRY_WINDOW_VERSION,
    window_kind: "same_token_sending_lease_renewal",
    send_authorization_bundle_ref: context.bundleRef,
    committed_send_authorization_hash: context.hash,
    effect_id: context.effect.effect_id,
    authorized_fencing_token: context.token,
    window_sequence: previous.window_sequence + 1,
    previous_window_ref: previous.window_ref,
    previous_lease_expires_at: previous.lease_expires_at,
    lease_expires_at: renewalEvent.payload.lease.expires_at,
    source_event: renewalEvent,
    source_event_ref: {
      id: renewalEvent.event_id,
      hash: canonicalHash(renewalEvent),
    },
    batch_id: batchId,
    domain_event_manifest_hash: eventManifestHash(renewalEvent),
  };
  const candidate = { ...body, window_ref: windowRef(body) };
  return assertProviderEntryWindowContinuationV1({
    committed_send_authorization: context.proof,
    previous_window: previous,
    current_window: candidate,
  });
}

function assertProviderEntryWindowCoverageV1({
  committed_send_authorization: inputProof,
  entry_window: inputEntry,
  current_window: inputCurrent,
  continuation_chain: inputContinuationChain = [],
} = {}) {
  const options = { committed_send_authorization: inputProof };
  const entry = normalizeProviderEntryWindowV1(inputEntry, options);
  const current = normalizeProviderEntryWindowV1(inputCurrent, options);
  if (!Array.isArray(inputContinuationChain)) {
    fail(
      "BUSINESS_PROVIDER_ENTRY_WINDOW_NOT_COVERED",
      "Provider entry coverage requires an ordered continuation chain",
      { effect_id: current.effect_id },
    );
  }
  const continuationChain = inputContinuationChain.map((window) => (
    normalizeProviderEntryWindowV1(window, options)
  ));
  const sameSequence = current.window_sequence === entry.window_sequence;
  if (sameSequence) {
    if (continuationChain.length !== 0 || !same(current, entry)) {
      fail(
        "BUSINESS_PROVIDER_ENTRY_WINDOW_NOT_COVERED",
        "The same provider entry sequence is covered only by its exact content-addressed window",
        { effect_id: current.effect_id, current_sequence: current.window_sequence },
      );
    }
    return current;
  }
  if (current.window_sequence < entry.window_sequence
      || continuationChain.length !== current.window_sequence - entry.window_sequence - 1) {
    fail(
      "BUSINESS_PROVIDER_ENTRY_WINDOW_NOT_COVERED",
      "Provider entry coverage chain does not span the exact sequence interval",
      {
        effect_id: current.effect_id,
        entry_sequence: entry.window_sequence,
        current_sequence: current.window_sequence,
      },
    );
  }
  let previous = entry;
  for (const next of [...continuationChain, current]) {
    try {
      previous = assertProviderEntryWindowContinuationV1({
        committed_send_authorization: inputProof,
        previous_window: previous,
        current_window: next,
      });
    } catch (error) {
      if (!(error instanceof BusinessProviderEntryWindowError)) throw error;
      fail(
        "BUSINESS_PROVIDER_ENTRY_WINDOW_NOT_COVERED",
        "Provider entry coverage contains a forked, orphaned, or discontinuous hop",
        {
          effect_id: current.effect_id,
          entry_sequence: entry.window_sequence,
          current_sequence: current.window_sequence,
          cause_code: error.code,
        },
      );
    }
  }
  return current;
}

function normalizeProjectedRenewalReceipt(input, window) {
  const receipt = exactObject(
    canonicalClone(input, "internal_receipt"),
    INTERNAL_RECEIPT_FIELDS,
    "internal_receipt",
  );
  const result = exactObject(
    receipt.result,
    RENEWAL_RESULT_FIELDS,
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
    event_ids: canonicalClone(receipt.event_ids, "internal_receipt.event_ids"),
    result: canonicalClone(result, "internal_receipt.result"),
    event_hashes: canonicalClone(receipt.event_hashes, "internal_receipt.event_hashes"),
  };
  const sourceEvent = window.source_event;
  if (normalized.source_type !== "internal_action"
      || !Array.isArray(normalized.event_ids)
      || normalized.event_ids.length !== 1
      || normalized.event_ids[0] !== sourceEvent.event_id
      || normalized.source_id !== sourceEvent.payload.source_id
      || normalized.work_order_id !== sourceEvent.payload.work_order_id
      || normalized.applied_revision !== sourceEvent.payload.target_work_order_revision
      || normalized.batch_id !== window.batch_id
      || result.internal_action_id !== normalized.source_id
      || result.work_order_id !== normalized.work_order_id
      || result.work_order_revision !== normalized.applied_revision
      || result.effect_id !== window.effect_id
      || result.action !== "outbox.lease.renew"
      || result.outbox_status !== "sending"
      || !same(result.fencing_token, window.authorized_fencing_token)
      || !same(result.provider_entry_window_continuation, window)
      || !isPlainObject(normalized.event_hashes)) {
    fail(
      "BUSINESS_PROVIDER_ENTRY_WINDOW_RECEIPT_INVALID",
      "Provider entry continuation requires one exact projected renewal receipt",
      { effect_id: window.effect_id },
    );
  }
  const { event_hashes: ignoredEventHashes, ...journalReceipt } = normalized;
  void ignoredEventHashes;
  exactObject(journalReceipt, JOURNAL_INTERNAL_RECEIPT_FIELDS, "journal_internal_receipt");
  const receiptPayload = {
    work_order_id: sourceEvent.payload.work_order_id,
    plan_snapshot_ref: sourceEvent.payload.plan_snapshot_ref,
    plan_hash: sourceEvent.payload.plan_hash,
    source_id: sourceEvent.payload.source_id,
    prior_work_order_revision: sourceEvent.payload.prior_work_order_revision,
    target_work_order_revision: sourceEvent.payload.target_work_order_revision,
    occurred_at: sourceEvent.payload.occurred_at,
    receipt: journalReceipt,
  };
  exactObject(receiptPayload, RECEIPT_EVENT_PAYLOAD_FIELDS, "receipt_event.payload");
  const receiptEvent = {
    event_id: eventIdFor({
      sourceId: normalized.source_id,
      ordinal: 1,
      type: "business.internal_action.received",
      payload: receiptPayload,
      evidenceRefs: [],
    }),
    schema_version: 1,
    type: "business.internal_action.received",
    payload: receiptPayload,
    evidence_refs: [],
  };
  const expectedHashes = {
    [sourceEvent.event_id]: canonicalHash(sourceEvent),
    [receiptEvent.event_id]: canonicalHash(receiptEvent),
  };
  if (!same(normalized.event_hashes, expectedHashes)) {
    fail(
      "BUSINESS_PROVIDER_ENTRY_WINDOW_RECEIPT_INVALID",
      "Projected renewal receipt does not close its exact two-event batch",
      { effect_id: window.effect_id },
    );
  }
  const hash = canonicalHash(normalized);
  return deepFreeze({
    internal_receipt: normalized,
    receipt_event: receiptEvent,
    receipt_ref: { id: `IAR-${hash.slice(0, 32)}`, hash },
  });
}

function normalizeProviderEntryWindowReceiptClosureV1({
  committed_send_authorization: inputProof,
  provider_entry_window: inputWindow,
  internal_receipt: inputReceipt,
} = {}) {
  const window = normalizeProviderEntryWindowV1(inputWindow, {
    committed_send_authorization: inputProof,
  });
  if (window.window_kind !== "same_token_sending_lease_renewal") {
    fail(
      "BUSINESS_PROVIDER_ENTRY_WINDOW_RECEIPT_INVALID",
      "Only a lease-renewal continuation has a separate PEW receipt closure",
      { effect_id: window.effect_id },
    );
  }
  return normalizeProjectedRenewalReceipt(inputReceipt, window);
}

function expectedIndex(context, window, currentReceiptId, currentReceiptRef) {
  return {
    index_version: PROVIDER_ENTRY_WINDOW_INDEX_VERSION,
    effect_id: context.effect.effect_id,
    send_authorization_bundle_ref: context.bundleRef,
    committed_send_authorization_hash: context.hash,
    authorized_fencing_token: context.token,
    current_window_ref: window.window_ref,
    current_window_sequence: window.window_sequence,
    current_lease_expires_at: window.lease_expires_at,
    send_authorization_receipt_id: context.proof.internal_receipt.source_id,
    send_authorization_receipt_ref: context.proof.send_authorization_receipt_ref,
    current_window_receipt_id: currentReceiptId,
    current_window_receipt_ref: currentReceiptRef,
  };
}

function createProviderEntryWindowIndexV1({ committed_send_authorization: inputProof } = {}) {
  const context = baseContext(inputProof);
  const anchor = createProviderEntryWindowAnchorV1({
    committed_send_authorization: context.proof,
  });
  return deepFreeze(expectedIndex(
    context,
    anchor,
    context.proof.internal_receipt.source_id,
    context.proof.send_authorization_receipt_ref,
  ));
}

function normalizeProviderEntryWindowIndexV1(
  input,
  {
    committed_send_authorization: inputProof,
    current_window: inputWindow,
    current_window_internal_receipt: inputCurrentReceipt = null,
  } = {},
) {
  const context = baseContext(inputProof);
  const window = normalizeProviderEntryWindowV1(inputWindow, {
    committed_send_authorization: context.proof,
  });
  let currentReceiptId;
  let currentReceiptRef;
  if (window.window_kind === "send_begin") {
    currentReceiptId = context.proof.internal_receipt.source_id;
    currentReceiptRef = context.proof.send_authorization_receipt_ref;
  } else {
    const closure = normalizeProviderEntryWindowReceiptClosureV1({
      committed_send_authorization: context.proof,
      provider_entry_window: window,
      internal_receipt: inputCurrentReceipt,
    });
    currentReceiptId = closure.internal_receipt.source_id;
    currentReceiptRef = closure.receipt_ref;
  }
  const candidate = exactObject(
    canonicalClone(input, "provider_entry_window_index"),
    INDEX_FIELDS,
    "provider_entry_window_index",
  );
  // Normalize every pointer before the exact deterministic comparison so an
  // index can never smuggle a non-content-addressed or non-portable alias.
  integer(candidate.index_version, "provider_entry_window_index.index_version", 1);
  portableRef(candidate.effect_id, "provider_entry_window_index.effect_id");
  contentRef(
    candidate.send_authorization_bundle_ref,
    "provider_entry_window_index.send_authorization_bundle_ref",
  );
  sha256(
    candidate.committed_send_authorization_hash,
    "provider_entry_window_index.committed_send_authorization_hash",
  );
  normalizeToken(
    candidate.authorized_fencing_token,
    "provider_entry_window_index.authorized_fencing_token",
  );
  derivedRef(
    candidate.current_window_ref,
    "provider_entry_window_index.current_window_ref",
    "PEW",
  );
  integer(
    candidate.current_window_sequence,
    "provider_entry_window_index.current_window_sequence",
  );
  timestamp(
    candidate.current_lease_expires_at,
    "provider_entry_window_index.current_lease_expires_at",
  );
  portableRef(
    candidate.send_authorization_receipt_id,
    "provider_entry_window_index.send_authorization_receipt_id",
  );
  derivedRef(
    candidate.send_authorization_receipt_ref,
    "provider_entry_window_index.send_authorization_receipt_ref",
    "IAR",
  );
  portableRef(
    candidate.current_window_receipt_id,
    "provider_entry_window_index.current_window_receipt_id",
  );
  derivedRef(
    candidate.current_window_receipt_ref,
    "provider_entry_window_index.current_window_receipt_ref",
    "IAR",
  );
  const expected = expectedIndex(context, window, currentReceiptId, currentReceiptRef);
  if (!same(candidate, expected)) {
    fail(
      "BUSINESS_PROVIDER_ENTRY_WINDOW_INDEX_INVALID",
      "Provider entry window index does not point to its exact base and latest receipt closure",
      { effect_id: context.effect.effect_id },
    );
  }
  return deepFreeze(expected);
}

function advanceProviderEntryWindowIndexV1({
  committed_send_authorization: inputProof,
  current_index: inputIndex,
  current_window: inputCurrentWindow,
  current_window_internal_receipt: inputCurrentReceipt = null,
  next_window: inputNextWindow,
  next_window_internal_receipt: inputNextReceipt,
} = {}) {
  const context = baseContext(inputProof);
  const currentWindow = normalizeProviderEntryWindowV1(inputCurrentWindow, {
    committed_send_authorization: context.proof,
  });
  normalizeProviderEntryWindowIndexV1(inputIndex, {
    committed_send_authorization: context.proof,
    current_window: currentWindow,
    current_window_internal_receipt: inputCurrentReceipt,
  });
  const nextWindow = assertProviderEntryWindowContinuationV1({
    committed_send_authorization: context.proof,
    previous_window: currentWindow,
    current_window: inputNextWindow,
  });
  const closure = normalizeProviderEntryWindowReceiptClosureV1({
    committed_send_authorization: context.proof,
    provider_entry_window: nextWindow,
    internal_receipt: inputNextReceipt,
  });
  return deepFreeze(expectedIndex(
    context,
    nextWindow,
    closure.internal_receipt.source_id,
    closure.receipt_ref,
  ));
}

function normalizeEntryWindowReceipt(inputReceipt, window, context) {
  if (window.window_kind === "send_begin") {
    const receipt = canonicalClone(
      inputReceipt,
      "provider_entry_authorization_proof.entry_window_internal_receipt",
    );
    if (!same(receipt, context.proof.internal_receipt)) {
      fail(
        "BUSINESS_PROVIDER_ENTRY_WINDOW_RECEIPT_INVALID",
        "The PEW anchor must use its committed send-authorization receipt closure",
        { effect_id: window.effect_id },
      );
    }
    return context.proof.internal_receipt;
  }
  return normalizeProviderEntryWindowReceiptClosureV1({
    committed_send_authorization: context.proof,
    provider_entry_window: window,
    internal_receipt: inputReceipt,
  }).internal_receipt;
}

function normalizeProviderEntryAuthorizationProofV1(input) {
  // The continuation history is deliberately not serialized under one fixed
  // aggregate byte cap: a valid same-token lease may be renewed arbitrarily
  // many times. Snapshot the exact outer data shape, then put every bounded
  // content-addressed constituent through its own canonical normalizer.
  const candidate = exactDataObjectSnapshot(
    input,
    ENTRY_AUTHORIZATION_PROOF_FIELDS,
    "provider_entry_authorization_proof",
  );
  if (candidate.provider_entry_authorization_version
      !== PROVIDER_ENTRY_AUTHORIZATION_VERSION) {
    fail(
      "BUSINESS_PROVIDER_ENTRY_WINDOW_INVALID",
      "Provider entry authorization proof version is unsupported",
    );
  }
  const context = baseContext(candidate.committed_send_authorization);
  const suppliedBaseHash = sha256(
    candidate.committed_send_authorization_hash,
    "provider_entry_authorization_proof.committed_send_authorization_hash",
  );
  if (suppliedBaseHash !== context.hash) {
    fail(
      "BUSINESS_PROVIDER_ENTRY_WINDOW_BASE_INVALID",
      "Provider entry authorization proof does not bind its committed SAB closure",
      { effect_id: context.effect.effect_id },
    );
  }
  const options = { committed_send_authorization: context.proof };
  const entryWindow = normalizeProviderEntryWindowV1(candidate.entry_window, options);
  const entryReceipt = normalizeEntryWindowReceipt(
    candidate.entry_window_internal_receipt,
    entryWindow,
    context,
  );
  const seenWindowIds = new Set([entryWindow.window_ref.id]);
  const seenEventIds = new Set(Object.keys(entryReceipt.event_hashes));
  const seenReceiptSourceIds = new Set([entryReceipt.source_id]);
  function registerHopIdentities(window, receipt, index) {
    const identities = [
      [seenWindowIds, window.window_ref.id, "window_ref.id"],
      [seenReceiptSourceIds, receipt.source_id, "internal_receipt.source_id"],
      ...Object.keys(receipt.event_hashes)
        .map((eventId) => [seenEventIds, eventId, "event_id"]),
    ];
    for (const [seen, identity, identityKind] of identities) {
      if (seen.has(identity)) {
        fail(
          "BUSINESS_PROVIDER_ENTRY_WINDOW_NOT_COVERED",
          "Provider entry authorization continuation identities must be globally unique",
          {
            effect_id: context.effect.effect_id,
            index,
            identity_kind: identityKind,
            identity,
          },
        );
      }
      seen.add(identity);
    }
  }
  const inputChain = denseDataArraySnapshot(
    candidate.continuation_chain,
    "provider_entry_authorization_proof.continuation_chain",
  );
  const continuationChain = inputChain.map((inputHop, index) => {
    const hop = exactDataObjectSnapshot(
      inputHop,
      ENTRY_AUTHORIZATION_CHAIN_FIELDS,
      `provider_entry_authorization_proof.continuation_chain[${index}]`,
    );
    const window = normalizeProviderEntryWindowV1(hop.provider_entry_window, options);
    if (window.window_kind !== "same_token_sending_lease_renewal") {
      fail(
        "BUSINESS_PROVIDER_ENTRY_WINDOW_NOT_COVERED",
        "Every provider entry authorization continuation hop must be one renewal",
        { effect_id: context.effect.effect_id, index },
      );
    }
    const receipt = normalizeProviderEntryWindowReceiptClosureV1({
      committed_send_authorization: context.proof,
      provider_entry_window: window,
      internal_receipt: hop.internal_receipt,
    }).internal_receipt;
    registerHopIdentities(window, receipt, index);
    return deepFreeze({ provider_entry_window: window, internal_receipt: receipt });
  });
  const currentHop = continuationChain.at(-1) || null;
  const currentWindow = currentHop?.provider_entry_window || entryWindow;
  const currentReceipt = currentHop?.internal_receipt || entryReceipt;
  assertProviderEntryWindowCoverageV1({
    committed_send_authorization: context.proof,
    entry_window: entryWindow,
    current_window: currentWindow,
    continuation_chain: continuationChain
      .slice(0, -1)
      .map((hop) => hop.provider_entry_window),
  });
  const currentIndex = normalizeProviderEntryWindowIndexV1(
    candidate.current_window_index,
    {
      committed_send_authorization: context.proof,
      current_window: currentWindow,
      current_window_internal_receipt: currentReceipt,
    },
  );
  return deepFreeze({
    provider_entry_authorization_version: PROVIDER_ENTRY_AUTHORIZATION_VERSION,
    committed_send_authorization: context.proof,
    committed_send_authorization_hash: context.hash,
    entry_window: entryWindow,
    entry_window_internal_receipt: entryReceipt,
    continuation_chain: continuationChain,
    current_window_index: currentIndex,
  });
}

module.exports = {
  PROVIDER_ENTRY_AUTHORIZATION_VERSION,
  PROVIDER_ENTRY_WINDOW_INDEX_VERSION,
  PROVIDER_ENTRY_WINDOW_VERSION,
  BusinessProviderEntryWindowError,
  advanceProviderEntryWindowIndexV1,
  assertProviderEntryWindowContinuationV1,
  assertProviderEntryWindowCoverageV1,
  createProviderEntryWindowAnchorV1,
  createProviderEntryWindowContinuationV1,
  createProviderEntryWindowIndexV1,
  normalizeProviderEntryWindowIndexV1,
  normalizeProviderEntryAuthorizationProofV1,
  normalizeProviderEntryWindowReceiptClosureV1,
  normalizeProviderEntryWindowV1,
};
