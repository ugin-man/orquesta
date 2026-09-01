"use strict";

const { canonicalHash, canonicalJson } = require("@orquesta/contracts");
const {
  V2_EFFECT_IDENTITY_FIELDS,
} = require("./lifecycle");
const {
  normalizeDispatchPacketVerificationReceiptV1,
} = require("./packet-store");
const {
  businessProjectionConfigurationV1,
} = require("./projector");
const {
  PROVIDER_ENTRY_AUTHORIZATION_VERSION,
  BusinessProviderEntryWindowError,
  createProviderEntryWindowAnchorV1,
  normalizeProviderEntryAuthorizationProofV1,
  normalizeProviderEntryWindowReceiptClosureV1,
  normalizeProviderEntryWindowV1,
} = require("./provider-entry-window");
const {
  BusinessSendAuthorizationError,
  SEND_AUTHORIZATION_CONTRACT_VERSION,
  createCommittedSendAuthorizationProofV2,
  deriveCommittedSendAuthorizationHashV2,
  normalizeCommittedSendAuthorizationProofV2,
} = require("./send-authorization");

const COMMITTED_SEND_QUERY_FIELDS = new Set([
  "authorization_contract_version",
  "effect_id",
  "mutation_idempotency_key",
  "send_authorization_receipt_ref",
  "provider_request_ref",
  "worker_fencing_token",
]);
const PROVIDER_ENTRY_QUERY_FIELDS = new Set([
  ...COMMITTED_SEND_QUERY_FIELDS,
  "minimum_provider_entry_window_ref",
]);
const RECOVERY_QUERY_FIELDS = new Set([
  "authorization_contract_version",
  "effect_id",
  "mutation_idempotency_key",
  "send_authorization_receipt_ref",
  "inspected_at",
  "minimum_provider_entry_window_ref",
]);
const CONTENT_REF_FIELDS = new Set(["id", "hash"]);
const FENCING_TOKEN_FIELDS = new Set(["lease_id", "owner_id", "generation"]);
const RECOVERY_ATTENTION_KINDS = new Set([
  "delivery_unknown",
  "timeout_requires_reconciliation",
  "cancel_requires_dispatch_reconciliation",
]);

class BusinessSendAuthorizationResolverError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "BusinessSendAuthorizationResolverError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function resolverError(code, message, details = {}) {
  return new BusinessSendAuthorizationResolverError(code, message, details);
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
    throw resolverError(
      "BUSINESS_SEND_AUTHORIZATION_QUERY_INVALID",
      `${path} must be one exact object`,
      { path },
    );
  }
  return value;
}

function portableRef(value, path) {
  if (typeof value !== "string"
      || value.length === 0
      || value.trim() !== value
      || Buffer.byteLength(value, "utf8") > 512
      || !/^[A-Za-z0-9][A-Za-z0-9._:/@+\-]*$/u.test(value)) {
    throw resolverError(
      "BUSINESS_SEND_AUTHORIZATION_QUERY_INVALID",
      `${path} must be a bounded portable reference`,
      { path },
    );
  }
  return value;
}

function sha256(value, path) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw resolverError(
      "BUSINESS_SEND_AUTHORIZATION_QUERY_INVALID",
      `${path} must be a lowercase SHA-256`,
      { path },
    );
  }
  return value;
}

function timestamp(value, path) {
  if (typeof value !== "string"
      || Number.isNaN(Date.parse(value))
      || new Date(value).toISOString() !== value) {
    throw resolverError(
      "BUSINESS_SEND_AUTHORIZATION_QUERY_INVALID",
      `${path} must be a canonical UTC timestamp`,
      { path },
    );
  }
  return value;
}

function contentRef(input, path) {
  const value = exactObject(input, CONTENT_REF_FIELDS, path);
  return {
    id: portableRef(value.id, `${path}.id`),
    hash: sha256(value.hash, `${path}.hash`),
  };
}

function fencingToken(input, path) {
  const value = exactObject(input, FENCING_TOKEN_FIELDS, path);
  if (!Number.isSafeInteger(value.generation) || value.generation < 1) {
    throw resolverError(
      "BUSINESS_SEND_AUTHORIZATION_QUERY_INVALID",
      `${path}.generation must be a positive safe integer`,
      { path: `${path}.generation` },
    );
  }
  return {
    lease_id: portableRef(value.lease_id, `${path}.lease_id`),
    owner_id: portableRef(value.owner_id, `${path}.owner_id`),
    generation: value.generation,
  };
}

function same(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw resolverError(
      "BUSINESS_SEND_AUTHORIZATION_RESOLUTION_ABORTED",
      "Send authorization resolution was aborted",
    );
  }
}

function normalizeSignal(options) {
  if (options === undefined) return null;
  if (!isPlainObject(options)
      || Object.keys(options).some((field) => field !== "signal")) {
    throw new TypeError("resolver options may contain only signal");
  }
  const signal = options.signal === undefined ? null : options.signal;
  if (signal !== null
      && (typeof signal.aborted !== "boolean"
        || typeof signal.addEventListener !== "function"
        || typeof signal.removeEventListener !== "function")) {
    throw new TypeError("signal must be an AbortSignal");
  }
  return signal;
}

function effectIdentity(effect) {
  if (!isPlainObject(effect)) {
    throw resolverError(
      "BUSINESS_SEND_AUTHORIZATION_PROJECTION_INVALID",
      "Projected Effect is missing or malformed",
    );
  }
  return Object.fromEntries(V2_EFFECT_IDENTITY_FIELDS.map((field) => [field, effect[field]]));
}

function normalizeSendQuery(input, { providerEntry = false } = {}) {
  const query = exactObject(
    input,
    providerEntry ? PROVIDER_ENTRY_QUERY_FIELDS : COMMITTED_SEND_QUERY_FIELDS,
    "send_authorization_query",
  );
  if (query.authorization_contract_version !== SEND_AUTHORIZATION_CONTRACT_VERSION) {
    throw resolverError(
      "BUSINESS_SEND_AUTHORIZATION_QUERY_INVALID",
      "Send authorization query contract is unsupported",
    );
  }
  const normalized = {
    authorization_contract_version: SEND_AUTHORIZATION_CONTRACT_VERSION,
    effect_id: portableRef(query.effect_id, "send_authorization_query.effect_id"),
    mutation_idempotency_key: portableRef(
      query.mutation_idempotency_key,
      "send_authorization_query.mutation_idempotency_key",
    ),
    send_authorization_receipt_ref: contentRef(
      query.send_authorization_receipt_ref,
      "send_authorization_query.send_authorization_receipt_ref",
    ),
    provider_request_ref: contentRef(
      query.provider_request_ref,
      "send_authorization_query.provider_request_ref",
    ),
    worker_fencing_token: fencingToken(
      query.worker_fencing_token,
      "send_authorization_query.worker_fencing_token",
    ),
  };
  if (providerEntry) {
    normalized.minimum_provider_entry_window_ref =
      query.minimum_provider_entry_window_ref === null
        ? null
        : contentRef(
          query.minimum_provider_entry_window_ref,
          "send_authorization_query.minimum_provider_entry_window_ref",
        );
  }
  return deepFreeze(normalized);
}

function normalizeRecoveryQuery(input) {
  const query = exactObject(input, RECOVERY_QUERY_FIELDS, "recovery_authorization_query");
  if (query.authorization_contract_version !== SEND_AUTHORIZATION_CONTRACT_VERSION) {
    throw resolverError(
      "BUSINESS_SEND_AUTHORIZATION_QUERY_INVALID",
      "Recovery authorization query contract is unsupported",
    );
  }
  return deepFreeze({
    authorization_contract_version: SEND_AUTHORIZATION_CONTRACT_VERSION,
    effect_id: portableRef(query.effect_id, "recovery_authorization_query.effect_id"),
    mutation_idempotency_key: portableRef(
      query.mutation_idempotency_key,
      "recovery_authorization_query.mutation_idempotency_key",
    ),
    send_authorization_receipt_ref: contentRef(
      query.send_authorization_receipt_ref,
      "recovery_authorization_query.send_authorization_receipt_ref",
    ),
    inspected_at: timestamp(query.inspected_at, "recovery_authorization_query.inspected_at"),
    minimum_provider_entry_window_ref:
      query.minimum_provider_entry_window_ref === null
        ? null
        : contentRef(
          query.minimum_provider_entry_window_ref,
          "recovery_authorization_query.minimum_provider_entry_window_ref",
        ),
  });
}

function normalizeReplay(input) {
  if (!isPlainObject(input)
      || !isPlainObject(input.state)
      || !isPlainObject(input.watermark)
      || !Number.isSafeInteger(input.watermark.journal_sequence)
      || input.watermark.journal_sequence < 0
      || !isPlainObject(input.state.outbox)
      || !isPlainObject(input.state.internal_receipts)
      || !isPlainObject(input.state.provider_entry_windows)
      || !isPlainObject(input.state.work_orders)) {
    throw resolverError(
      "BUSINESS_SEND_AUTHORIZATION_PROJECTION_INVALID",
      "EventStore replay did not return one public Business projection",
    );
  }
  return input;
}

function activeAuthorizationEpoch(projection) {
  const epoch = projection.provider_settlement_epoch;
  if (!isPlainObject(epoch)
      || epoch.send_authorization_contract_version !== SEND_AUTHORIZATION_CONTRACT_VERSION) {
    throw resolverError(
      "BUSINESS_SEND_AUTHORIZATION_CUTOVER_REQUIRED",
      "Committed authorization V2 requires its active durable cutover epoch",
    );
  }
  return epoch;
}

function wrapProofError(error, effectId = null) {
  if (error instanceof BusinessSendAuthorizationResolverError) return error;
  if (error instanceof BusinessSendAuthorizationError) {
    return resolverError(
      "BUSINESS_SEND_AUTHORIZATION_PROOF_INVALID",
      "Projected send authorization closure is invalid",
      { effect_id: effectId, cause_code: error.code },
    );
  }
  return error;
}

function wrapProviderEntryError(error, effectId = null) {
  if (error instanceof BusinessSendAuthorizationResolverError) return error;
  if (error instanceof BusinessProviderEntryWindowError) {
    return resolverError(
      "BUSINESS_SEND_AUTHORIZATION_PROVIDER_ENTRY_PROOF_INVALID",
      "Projected provider-entry authorization closure is invalid",
      { effect_id: effectId, cause_code: error.code },
    );
  }
  return error;
}

function proofForProjection(projection, query) {
  const epoch = activeAuthorizationEpoch(projection);
  const effect = projection.outbox[query.effect_id];
  if (!isPlainObject(effect)
      || effect.idempotency_key !== query.mutation_idempotency_key) {
    throw resolverError(
      "BUSINESS_SEND_AUTHORIZATION_NOT_FOUND",
      "The exact projected Effect authorization does not exist",
      { effect_id: query.effect_id },
    );
  }
  const matchingReceipts = [];
  const continuationReceipts = [];
  for (const receipt of Object.values(projection.internal_receipts)) {
    if (!isPlainObject(receipt)
        || receipt.source_type !== "internal_action"
        || receipt.work_order_id !== effect.work_order_id
        || receipt.result?.effect_id !== effect.effect_id) continue;
    if (receipt.result?.action === "outbox.send.begin") matchingReceipts.push(receipt);
    if (receipt.result?.action === "outbox.lease.renew"
        && receipt.result?.provider_entry_window_continuation !== undefined) {
      continuationReceipts.push(receipt);
    }
  }
  if (matchingReceipts.length !== 1) {
    throw resolverError(
      "BUSINESS_SEND_AUTHORIZATION_RECEIPT_NOT_FOUND",
      "Projection must retain one unambiguous send-begin authorization receipt",
      { effect_id: effect.effect_id, matching_receipts: matchingReceipts.length },
    );
  }
  let proof;
  try {
    proof = createCommittedSendAuthorizationProofV2({
      send_authorization_bundle: matchingReceipts[0].result.send_authorization_bundle,
      internal_receipt: matchingReceipts[0],
    });
    proof = normalizeCommittedSendAuthorizationProofV2(proof);
  } catch (error) {
    throw wrapProofError(error, effect.effect_id);
  }
  let packetReceipt;
  try {
    packetReceipt = normalizeDispatchPacketVerificationReceiptV1(
      proof.packet_verification_receipt,
    );
  } catch (error) {
    throw resolverError(
      "BUSINESS_SEND_AUTHORIZATION_PACKET_PROOF_INVALID",
      "Committed authorization does not contain a valid full Packet verification receipt",
      { effect_id: effect.effect_id, cause_code: error?.code || null },
    );
  }
  const projectedIdentity = effectIdentity(effect);
  if (!same(proof.effect, projectedIdentity)
      || !same(proof.packet_verification_receipt, packetReceipt)
      || !same(packetReceipt.effect_identity, projectedIdentity)
      || (effect.packet_verification_receipt !== undefined
        && effect.packet_verification_receipt !== null
        && !same(effect.packet_verification_receipt, packetReceipt))
      || proof.send_event.payload.provider_settlement_cutover_id !== epoch.cutover_id
      || !same(proof.send_authorization_receipt_ref, query.send_authorization_receipt_ref)) {
    throw resolverError(
      "BUSINESS_SEND_AUTHORIZATION_PROJECTION_MISMATCH",
      "Committed send authorization does not bind the authoritative projection",
      { effect_id: effect.effect_id },
    );
  }
  return { effect, proof, continuationReceipts };
}

function assertSendQueryBinding(query, proof) {
  if (!same(query.provider_request_ref, proof.provider_request_ref)
      || !same(query.worker_fencing_token, proof.authorized_fencing_token)) {
    throw resolverError(
      "BUSINESS_SEND_AUTHORIZATION_QUERY_MISMATCH",
      "Caller selectors do not match the committed send authorization",
      { effect_id: proof.effect.effect_id },
    );
  }
}

function providerEntryAuthorizationForProjection(
  projection,
  { effect, proof, continuationReceipts },
  minimumWindowRef,
) {
  const index = projection.provider_entry_windows[effect.effect_id];
  if (!isPlainObject(index)) {
    throw resolverError(
      "BUSINESS_SEND_AUTHORIZATION_PROVIDER_ENTRY_NOT_FOUND",
      "Projection does not retain the exact provider-entry window index",
      { effect_id: effect.effect_id },
    );
  }
  try {
    const anchor = createProviderEntryWindowAnchorV1({
      committed_send_authorization: proof,
    });
    const windowByRefId = new Map();
    for (const receipt of continuationReceipts) {
      const rawWindow = receipt.result.provider_entry_window_continuation;
      const closure = normalizeProviderEntryWindowReceiptClosureV1({
        committed_send_authorization: proof,
        provider_entry_window: rawWindow,
        internal_receipt: receipt,
      });
      const window = normalizeProviderEntryWindowV1(rawWindow, {
        committed_send_authorization: proof,
      });
      if (windowByRefId.has(window.window_ref.id)) {
        throw resolverError(
          "BUSINESS_SEND_AUTHORIZATION_PROVIDER_ENTRY_AMBIGUOUS",
          "Projection contains duplicate provider-entry window identities",
          { effect_id: effect.effect_id, window_ref: window.window_ref },
        );
      }
      windowByRefId.set(window.window_ref.id, {
        provider_entry_window: window,
        internal_receipt: closure.internal_receipt,
      });
    }

    const currentRef = contentRef(
      index.current_window_ref,
      "projection.provider_entry_window_index.current_window_ref",
    );
    const reverseContinuationChain = [];
    const seenRefs = new Set();
    let cursorRef = currentRef;
    while (!same(cursorRef, anchor.window_ref)) {
      if (seenRefs.has(cursorRef.id)) {
        throw resolverError(
          "BUSINESS_SEND_AUTHORIZATION_PROVIDER_ENTRY_AMBIGUOUS",
          "Projection contains a cyclic provider-entry window history",
          { effect_id: effect.effect_id, window_ref: cursorRef },
        );
      }
      seenRefs.add(cursorRef.id);
      const pair = windowByRefId.get(cursorRef.id);
      if (!pair || !same(pair.provider_entry_window.window_ref, cursorRef)) {
        throw resolverError(
          "BUSINESS_SEND_AUTHORIZATION_PROVIDER_ENTRY_NOT_FOUND",
          "Projection does not retain a receipt-closed provider-entry continuation",
          { effect_id: effect.effect_id, window_ref: cursorRef },
        );
      }
      reverseContinuationChain.push(pair);
      cursorRef = pair.provider_entry_window.previous_window_ref;
    }
    const fullContinuationChain = reverseContinuationChain.reverse();
    const fullPairs = [
      { provider_entry_window: anchor, internal_receipt: proof.internal_receipt },
      ...fullContinuationChain,
    ];
    const entryIndex = minimumWindowRef === null
      ? 0
      : fullPairs.findIndex((pair) => (
        same(pair.provider_entry_window.window_ref, minimumWindowRef)
      ));
    if (entryIndex < 0) {
      throw resolverError(
        "BUSINESS_SEND_AUTHORIZATION_PROVIDER_ENTRY_NOT_COVERED",
        "Minimum provider-entry window is not an ancestor of the current retained tip",
        { effect_id: effect.effect_id, minimum_provider_entry_window_ref: minimumWindowRef },
      );
    }
    const entry = fullPairs[entryIndex];
    return normalizeProviderEntryAuthorizationProofV1({
      provider_entry_authorization_version: PROVIDER_ENTRY_AUTHORIZATION_VERSION,
      committed_send_authorization: proof,
      committed_send_authorization_hash: deriveCommittedSendAuthorizationHashV2(proof),
      entry_window: entry.provider_entry_window,
      entry_window_internal_receipt: entry.internal_receipt,
      continuation_chain: fullPairs.slice(entryIndex + 1),
      current_window_index: index,
    });
  } catch (error) {
    throw wrapProviderEntryError(error, effect.effect_id);
  }
}

function currentProviderEntryWindow(authorization) {
  const currentHop = authorization.continuation_chain.at(-1) || null;
  return currentHop?.provider_entry_window || authorization.entry_window;
}

function createBusinessSendAuthorizationResolver({ eventStore, clock = () => new Date().toISOString() } = {}) {
  if (!eventStore || typeof eventStore.replay !== "function") {
    throw new TypeError("eventStore.replay is required");
  }
  if (typeof clock !== "function") throw new TypeError("clock must be a function");
  const projectionConfiguration = businessProjectionConfigurationV1();

  async function replay(signal) {
    throwIfAborted(signal);
    const resolved = normalizeReplay(await eventStore.replay(projectionConfiguration));
    throwIfAborted(signal);
    return resolved;
  }

  async function resolveCommittedSendAuthorization(input, options) {
    const signal = normalizeSignal(options);
    const query = normalizeSendQuery(input);
    const current = await replay(signal);
    const { proof } = proofForProjection(current.state, query);
    assertSendQueryBinding(query, proof);
    return proof;
  }

  async function resolveSendAuthorization(input, options) {
    const signal = normalizeSignal(options);
    const query = normalizeSendQuery(input, { providerEntry: true });
    const current = await replay(signal);
    const context = proofForProjection(current.state, query);
    const { effect, proof } = context;
    assertSendQueryBinding(query, proof);
    const providerEntryAuthorization = providerEntryAuthorizationForProjection(
      current.state,
      context,
      query.minimum_provider_entry_window_ref,
    );
    const currentWindow = currentProviderEntryWindow(providerEntryAuthorization);
    const now = timestamp(clock(), "clock");
    const projectedToken = isPlainObject(effect.lease) ? {
      lease_id: effect.lease.lease_id,
      owner_id: effect.lease.owner_id,
      generation: effect.lease.generation,
    } : null;
    if (effect.status !== "sending"
        || !isPlainObject(effect.lease)
        || !same(
          fencingToken(projectedToken, "projection.effect.lease.fencing_token"),
          query.worker_fencing_token,
        )
        || !same(currentWindow.authorized_fencing_token, query.worker_fencing_token)
        || effect.lease.expires_at !== currentWindow.lease_expires_at
        || Date.parse(now) >= Date.parse(currentWindow.lease_expires_at)) {
      throw resolverError(
        "BUSINESS_SEND_AUTHORIZATION_ENTRY_WINDOW_CLOSED",
        "Provider entry requires the exact current receipt-closed sending window",
        { effect_id: effect.effect_id },
      );
    }
    throwIfAborted(signal);
    return providerEntryAuthorization;
  }

  async function resolveRetainedProviderEntryAuthorization(input, options) {
    const signal = normalizeSignal(options);
    const query = normalizeSendQuery(input, { providerEntry: true });
    const current = await replay(signal);
    const context = proofForProjection(current.state, query);
    assertSendQueryBinding(query, context.proof);
    const providerEntryAuthorization = providerEntryAuthorizationForProjection(
      current.state,
      context,
      query.minimum_provider_entry_window_ref,
    );
    throwIfAborted(signal);
    return providerEntryAuthorization;
  }

  async function resolveRecoveryAuthorization(input, options) {
    const signal = normalizeSignal(options);
    const query = normalizeRecoveryQuery(input);
    const now = timestamp(clock(), "clock");
    if (Date.parse(query.inspected_at) > Date.parse(now)) {
      throw resolverError(
        "BUSINESS_SEND_AUTHORIZATION_QUERY_INVALID",
        "Recovery inspection cannot be in the future",
      );
    }
    const current = await replay(signal);
    const context = proofForProjection(current.state, query);
    const { effect, proof } = context;
    const providerEntryAuthorization = providerEntryAuthorizationForProjection(
      current.state,
      context,
      query.minimum_provider_entry_window_ref,
    );
    const workOrder = current.state.work_orders[effect.work_order_id];
    const attention = isPlainObject(workOrder)
      ? Object.values(workOrder.attention || {}).filter((entry) => (
        isPlainObject(entry)
          && entry.status === "open"
          && entry.effect_id === effect.effect_id
          && RECOVERY_ATTENTION_KINDS.has(entry.kind)
      ))
      : [];
    if (effect.status !== "delivery_unknown" || attention.length !== 1) {
      throw resolverError(
        "BUSINESS_SEND_AUTHORIZATION_RECOVERY_NOT_ELIGIBLE",
        "Recovery requires one current projected delivery-unknown attention",
        { effect_id: effect.effect_id },
      );
    }
    const eligibleAt = timestamp(attention[0].opened_at, "recovery_attention.opened_at");
    if (Date.parse(eligibleAt) > Date.parse(query.inspected_at)) {
      throw resolverError(
        "BUSINESS_SEND_AUTHORIZATION_RECOVERY_NOT_ELIGIBLE",
        "Recovery inspection predates its authoritative attention",
        { effect_id: effect.effect_id },
      );
    }
    const eligibilityBody = {
      eligibility_version: 1,
      eligible: true,
      state: "delivery_unknown",
      eligibility_basis_ref: contentRef(
        attention[0].detail_ref,
        "recovery_attention.detail_ref",
      ),
      eligible_at: eligibleAt,
      inspected_at: query.inspected_at,
    };
    const hash = canonicalHash({
      authorization_hash: deriveCommittedSendAuthorizationHashV2(proof),
      recovery_eligibility: eligibilityBody,
      inspected_at: query.inspected_at,
    });
    throwIfAborted(signal);
    return deepFreeze({
      provider_entry_authorization: providerEntryAuthorization,
      recovery_eligibility: {
        ...eligibilityBody,
        recovery_authorization_ref: { id: `RAR-${hash.slice(0, 32)}`, hash },
      },
    });
  }

  return deepFreeze({
    authorization_contract_version: SEND_AUTHORIZATION_CONTRACT_VERSION,
    resolveCommittedSendAuthorization,
    resolveRetainedProviderEntryAuthorization,
    resolveSendAuthorization,
    resolveRecoveryAuthorization,
  });
}

module.exports = {
  BusinessSendAuthorizationResolverError,
  createBusinessSendAuthorizationResolver,
};
