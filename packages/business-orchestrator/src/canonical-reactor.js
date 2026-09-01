"use strict";

const crypto = require("node:crypto");

const { canonicalHash, canonicalJson } = require("@orquesta/contracts");
const {
  normalizeBusinessRuntimeObservationEnvelope,
} = require("./contract");
const {
  normalizeInternalActionEnvelopeV1,
} = require("./internal-action-boundary");
const {
  V2_EFFECT_IDENTITY_FIELDS,
  assertLifecycleInvariants,
  deriveLifecycleSnapshot,
} = require("./lifecycle");
const {
  normalizeDispatchPacketVerificationReceiptV1,
} = require("./packet-store");
const {
  businessProjectionConfigurationV1,
} = require("./projector");
const {
  RECORDED_FAKE_EVIDENCE_VERSION,
} = require("./recorded-fake-provider");
const {
  PROVIDER_ENTRY_AUTHORIZATION_VERSION,
  normalizeProviderEntryAuthorizationProofV1,
} = require("./provider-entry-window");
const {
  deriveSettlementDispositionV2,
} = require("./settlement-policy");
const {
  SEND_AUTHORIZATION_CONTRACT_VERSION,
  deriveCommittedSendAuthorizationHashV2,
  normalizeCommittedSendAuthorizationProofV2,
  normalizeSendAuthorizationOperationScopeBindingV2,
} = require("./send-authorization");

const CANONICAL_REACTOR_CONTRACT_VERSION = 1;
const RECORDED_FAKE_CAPABILITIES = Object.freeze({
  authorization_contract_version: SEND_AUTHORIZATION_CONTRACT_VERSION,
  provider_entry_authorization_version: PROVIDER_ENTRY_AUTHORIZATION_VERSION,
  driver_contract_version: 1,
  mutation_execution: "stable_committed_send_plus_current_provider_entry_window_required",
  provider_entry_window: "contiguous_resolver_chain_rechecked_before_provider_entry",
  recovery_inspection:
    "stable_committed_send_provider_entry_window_and_recovery_eligibility_required",
  authorized_result_lookup: "retained_provider_entry_authorization_read_only",
  process_local_test_adapter: "explicit_opt_in_only",
});
const PRESEND_FAILURE_RECORDER_CAPABILITIES = Object.freeze({
  recorder_contract_version: 1,
  storage: "durable_content_addressed",
  idempotency: "presend_failure_id",
  verification: "source_specific_internal",
  observation_attestation: "trusted_resolver_readable",
});
const EXECUTABLE_EFFECT_STATUSES = new Set([
  "pending",
  "claimed",
  "sending",
  "delivery_unknown",
]);
const TERMINAL_WORK_ORDER_STATUSES = new Set(["accepted", "failed", "cancelled"]);
const DECISION_PRIORITY = Object.freeze({
  send: 0,
  expire_send: 1,
  requeue: 1,
  probe_delivery_unknown: 1,
  claim: 2,
  lookup_worker_result: 3,
});
const DECISION_PROVIDER_POLICY = Object.freeze({
  claim: "none",
  requeue: "none",
  send: "verified_presend_failure",
  lookup_worker_result: "required",
  expire_send: "none",
  probe_delivery_unknown: "required",
});
const CONTENT_REF_FIELDS = new Set(["id", "hash"]);
const FENCING_TOKEN_FIELDS = new Set(["lease_id", "owner_id", "generation"]);
const SEND_AUTHORIZATION_QUERY_FIELDS = new Set([
  "authorization_contract_version",
  "effect_id",
  "mutation_idempotency_key",
  "send_authorization_receipt_ref",
  "provider_request_ref",
  "worker_fencing_token",
]);
const PROVIDER_ENTRY_AUTHORIZATION_QUERY_FIELDS = new Set([
  ...SEND_AUTHORIZATION_QUERY_FIELDS,
  "minimum_provider_entry_window_ref",
]);
const RECOVERY_AUTHORIZATION_PROOF_FIELDS = new Set([
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
const PRESEND_FAILURE_RECORD_FIELDS = new Set([
  "failure_record_version",
  "failure_record_kind",
  "presend_failure_id",
  "effect_identity",
  "claimed_fencing_token",
  "failure_source",
  "failure_reason",
  "evidence_refs",
]);
const PRESEND_FAILURE_ATTESTATION_FIELDS = new Set([
  "effect_id",
  "idempotency_key",
  "provider_ref",
  "claimed_fencing_token",
  "failure_reason",
  "failure_record_ref",
  "evidence_refs",
]);
const PRESEND_FAILURE_RESULT_FIELDS = new Set([
  "recorder_contract_version",
  "presend_failure_id",
  "failure_record",
  "failure_record_ref",
  "presend_failure_attestation",
]);
const WORKER_RESULT_FIELDS = new Set([
  "driver_contract_version",
  "effect_id",
  "mutation_idempotency_key",
  "classification",
  "reason",
  "runtime_identity",
  "provider_result_ref",
  "worker_result_ref",
  "callback_fencing_token",
  "retry_authorization",
]);
const WORKER_EVIDENCE_FIELDS = new Set([
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
  "provider_entry_window_ref",
  "provider_entry_window_sequence",
  "provider_entry_window_lease_expires_at",
  "provider_entry_window_fencing_token",
  "entry_checked_at",
  "mutation_entry_checked_at",
  "recorded_at",
  "retry_authorization",
]);
const PROBE_RESULT_FIELDS = new Set([
  "probe_contract_version",
  "effect_id",
  "mutation_idempotency_key",
  "classification",
  "probe_classification",
  "reason",
  "runtime_identity",
  "provider_result_ref",
  "probe_receipt_ref",
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
  "provider_entry_window_ref",
  "provider_entry_window_sequence",
  "provider_entry_window_lease_expires_at",
  "provider_entry_window_fencing_token",
  "recovery_authorization_hash",
  "inspected_at",
  "retry_authorization",
]);
const STEP_INPUT_FIELDS = new Set(["effect_id", "signal"]);

class BusinessCanonicalReactorError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "BusinessCanonicalReactorError";
    this.code = code;
    this.details = deepFreeze({ ...details });
  }
}

function reactorError(code, message, details) {
  return new BusinessCanonicalReactorError(code, message, details);
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

function exactObject(value, fields, path, code = "BUSINESS_CANONICAL_REACTOR_PROOF_INVALID") {
  if (!isPlainObject(value)
      || Object.keys(value).length !== fields.size
      || Object.keys(value).some((field) => !fields.has(field))
      || [...fields].some((field) => !Object.hasOwn(value, field))) {
    throw reactorError(code, `${path} must be one exact object`, { path });
  }
  return value;
}

function exactDataObjectSnapshot(
  value,
  fields,
  path,
  code = "BUSINESS_CANONICAL_REACTOR_PROOF_INVALID",
) {
  if (!isPlainObject(value)) {
    throw reactorError(code, `${path} must be one exact data object`, { path });
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.size
      || keys.some((field) => typeof field !== "string" || !fields.has(field))) {
    throw reactorError(code, `${path} must be one exact data object`, { path });
  }
  const snapshot = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !("value" in descriptor)) {
      throw reactorError(code, `${path}.${field} must be a data property`, {
        path: `${path}.${field}`,
      });
    }
    snapshot[field] = descriptor.value;
  }
  return snapshot;
}

function canonicalClone(value, path, code = "BUSINESS_CANONICAL_REACTOR_INPUT_INVALID") {
  let serialized;
  try {
    serialized = canonicalJson(value);
  } catch (error) {
    throw reactorError(code, `${path} must be canonical JSON`, {
      path,
      cause_code: error?.code || null,
    });
  }
  if (Buffer.byteLength(serialized, "utf8") > 1_048_576) {
    throw reactorError(code, `${path} exceeds the reactor boundary limit`, { path });
  }
  return JSON.parse(serialized);
}

function text(value, path, maximumBytes = 512) {
  if (typeof value !== "string"
      || value.trim() === ""
      || value.trim() !== value
      || Buffer.byteLength(value, "utf8") > maximumBytes
      || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw reactorError(
      "BUSINESS_CANONICAL_REACTOR_INPUT_INVALID",
      `${path} must be bounded non-empty text`,
      { path },
    );
  }
  return value;
}

function portableRef(value, path) {
  const normalized = text(value, path);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@+\-]*$/u.test(normalized)) {
    throw reactorError(
      "BUSINESS_CANONICAL_REACTOR_INPUT_INVALID",
      `${path} must be a portable reference`,
      { path },
    );
  }
  return normalized;
}

function sha256(value, path) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw reactorError(
      "BUSINESS_CANONICAL_REACTOR_INPUT_INVALID",
      `${path} must be a lowercase SHA-256 digest`,
      { path },
    );
  }
  return value;
}

function integer(value, path, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw reactorError(
      "BUSINESS_CANONICAL_REACTOR_INPUT_INVALID",
      `${path} must be an integer greater than or equal to ${minimum}`,
      { path },
    );
  }
  return value;
}

function timestamp(value, path) {
  if (typeof value !== "string"
      || Number.isNaN(Date.parse(value))
      || new Date(value).toISOString() !== value) {
    throw reactorError(
      "BUSINESS_CANONICAL_REACTOR_INPUT_INVALID",
      `${path} must be a canonical UTC timestamp`,
      { path },
    );
  }
  return value;
}

function contentRef(value, path) {
  const ref = exactObject(value, CONTENT_REF_FIELDS, path);
  return {
    id: portableRef(ref.id, `${path}.id`),
    hash: sha256(ref.hash, `${path}.hash`),
  };
}

function fencingToken(value, path) {
  const token = exactObject(value, FENCING_TOKEN_FIELDS, path);
  return {
    lease_id: portableRef(token.lease_id, `${path}.lease_id`),
    owner_id: portableRef(token.owner_id, `${path}.owner_id`),
    generation: integer(token.generation, `${path}.generation`, 1),
  };
}

function leaseToken(value, path) {
  if (!isPlainObject(value)) {
    throw reactorError(
      "BUSINESS_CANONICAL_REACTOR_PROJECTION_INVALID",
      `${path} must contain a lease`,
      { path },
    );
  }
  return fencingToken({
    lease_id: value.lease_id,
    owner_id: value.owner_id,
    generation: value.generation,
  }, path);
}

function same(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function effectIdentity(effect) {
  if (!isPlainObject(effect)) {
    throw reactorError(
      "BUSINESS_CANONICAL_REACTOR_PROJECTION_INVALID",
      "Projected Effect must be an object",
    );
  }
  const identity = {};
  for (const field of V2_EFFECT_IDENTITY_FIELDS) {
    if (!Object.hasOwn(effect, field)) {
      throw reactorError(
        "BUSINESS_CANONICAL_REACTOR_PROJECTION_INVALID",
        "Projected Effect is missing an immutable V2 identity field",
        { effect_id: effect.effect_id || null, field },
      );
    }
    identity[field] = effect[field];
  }
  return canonicalClone(identity, "effect_identity");
}

function effectIdentifierSeed(effect) {
  return Object.fromEntries(V2_EFFECT_IDENTITY_FIELDS
    .filter((field) => !["effect_id", "idempotency_key", "created_at"].includes(field))
    .map((field) => [field, effect[field]]));
}

function validateEffectIdentifiers(effect) {
  const seed = effectIdentifierSeed(effect);
  const effectId = `FX-${canonicalHash(seed).slice(0, 32)}`;
  const idempotencyKey = `IDEM-${canonicalHash(seed).slice(0, 32)}`;
  if (effect.effect_id !== effectId || effect.idempotency_key !== idempotencyKey) {
    throw reactorError(
      "BUSINESS_CANONICAL_REACTOR_EFFECT_IDENTITY_INVALID",
      "Effect identifiers do not derive from the immutable V2 identity",
      { effect_id: effect.effect_id || null },
    );
  }
}

function normalizeReplay(value) {
  if (!isPlainObject(value)
      || !isPlainObject(value.state)
      || !isPlainObject(value.watermark)
      || !Number.isSafeInteger(value.watermark.journal_sequence)
      || value.watermark.journal_sequence < 0
      || !isPlainObject(value.state.work_orders)
      || !isPlainObject(value.state.outbox)
      || !isPlainObject(value.state.internal_receipts)
      || !isPlainObject(value.state.provider_entry_windows)
      || !isPlainObject(value.state.observation_receipts)) {
    throw reactorError(
      "BUSINESS_CANONICAL_REACTOR_PROJECTION_INVALID",
      "EventStore replay did not return the canonical Business projection",
    );
  }
  return value;
}

function normalizeCleanRecoveryInspection(value) {
  if (!isPlainObject(value)
      || value.action !== "none"
      || value.required_user_decision !== null
      || !Number.isSafeInteger(value.last_valid_sequence)
      || value.last_valid_sequence < 0
      || !Array.isArray(value.quarantine_paths)
      || value.quarantine_paths.length !== 0) {
    throw reactorError(
      "BUSINESS_CANONICAL_REACTOR_RECOVERY_BLOCKED",
      "Canonical execution requires one clean read-only EventStore recovery inspection",
      {
        recovery_action: typeof value?.action === "string" ? value.action : null,
        required_user_decision: value?.required_user_decision ?? null,
      },
    );
  }
  return value;
}

function workOrderLifecycle(projection, workOrder) {
  try {
    return assertLifecycleInvariants(deriveLifecycleSnapshot({
      workOrder,
      outbox: projection.outbox,
      attention: workOrder.attention,
    }));
  } catch (error) {
    throw reactorError(
      "BUSINESS_CANONICAL_REACTOR_LIFECYCLE_INVALID",
      "Canonical lifecycle invariants reject reactor automation",
      {
        work_order_id: workOrder.work_order_id,
        cause_code: error?.code || null,
        violations: error?.details?.violations || [],
      },
    );
  }
}

function compareEffects(left, right) {
  for (const field of ["work_order_id", "branch_ref"]) {
    const comparison = String(left[field]).localeCompare(String(right[field]));
    if (comparison !== 0) return comparison;
  }
  return (left.attempt - right.attempt)
    || (left.operation_generation - right.operation_generation)
    || left.effect_id.localeCompare(right.effect_id);
}

function selectedEffects(projection, effectId) {
  if (effectId !== null) {
    const selected = projection.outbox[effectId];
    if (!selected) {
      throw reactorError(
        "BUSINESS_CANONICAL_REACTOR_EFFECT_NOT_FOUND",
        "Requested Effect does not exist in the canonical projection",
        { effect_id: effectId },
      );
    }
    return [selected];
  }
  return Object.values(projection.outbox)
    .filter((effect) => isPlainObject(effect)
      && effect.effect_contract_version === 2
      && EXECUTABLE_EFFECT_STATUSES.has(effect.status))
    .sort(compareEffects);
}

function lifecycleEntry(snapshot, effect) {
  const branch = snapshot.branches[effect.branch_ref];
  const matches = branch?.effects?.filter((entry) => entry.effect_id === effect.effect_id) || [];
  if (matches.length !== 1) {
    throw reactorError(
      "BUSINESS_CANONICAL_REACTOR_LIFECYCLE_INVALID",
      "Lifecycle snapshot does not identify the Effect exactly once",
      { effect_id: effect.effect_id },
    );
  }
  return matches[0];
}

function exactLease(effect) {
  if (!isPlainObject(effect.lease)) {
    throw reactorError(
      "BUSINESS_CANONICAL_REACTOR_PROJECTION_INVALID",
      "A leased Effect is missing its canonical lease",
      { effect_id: effect.effect_id },
    );
  }
  return {
    lease_id: portableRef(effect.lease.lease_id, "effect.lease.lease_id"),
    owner_id: portableRef(effect.lease.owner_id, "effect.lease.owner_id"),
    generation: integer(effect.lease.generation, "effect.lease.generation", 1),
    claimed_at: timestamp(effect.lease.claimed_at, "effect.lease.claimed_at"),
    heartbeat_at: timestamp(effect.lease.heartbeat_at, "effect.lease.heartbeat_at"),
    expires_at: timestamp(effect.lease.expires_at, "effect.lease.expires_at"),
  };
}

function assertProviderEntryWindow(projection, effect, expectedToken, now) {
  const checkedAt = timestamp(now, "provider_entry.checked_at");
  const index = projection.provider_entry_windows?.[effect.effect_id];
  if (effect.status !== "sending" || !isPlainObject(effect.lease) || !isPlainObject(index)) {
    throw reactorError(
      "BUSINESS_CANONICAL_REACTOR_PROVIDER_ENTRY_EXPIRED",
      "Provider entry requires one current projected sending window",
      {
        effect_id: effect.effect_id,
        checked_at: checkedAt,
        lease_expires_at: effect.lease?.expires_at || null,
      },
    );
  }
  const lease = exactLease(effect);
  const currentWindow = {
    provider_entry_window_ref: contentRef(
      index.current_window_ref,
      "provider_entry_window_index.current_window_ref",
    ),
    provider_entry_window_sequence: integer(
      index.current_window_sequence,
      "provider_entry_window_index.current_window_sequence",
    ),
    provider_entry_window_lease_expires_at: timestamp(
      index.current_lease_expires_at,
      "provider_entry_window_index.current_lease_expires_at",
    ),
    provider_entry_window_fencing_token: fencingToken(
      index.authorized_fencing_token,
      "provider_entry_window_index.authorized_fencing_token",
    ),
  };
  const token = leaseToken(lease, "effect.lease");
  if (!same(token, expectedToken)
      || !same(currentWindow.provider_entry_window_fencing_token, token)
      || currentWindow.provider_entry_window_lease_expires_at !== lease.expires_at
      || Date.parse(checkedAt) >= Date.parse(lease.expires_at)) {
    throw reactorError(
      "BUSINESS_CANONICAL_REACTOR_PROVIDER_ENTRY_EXPIRED",
      "Provider entry requires the exact current projector-validated sending lease window",
      {
        effect_id: effect.effect_id,
        checked_at: checkedAt,
        lease_expires_at: lease.expires_at,
      },
    );
  }
  return deepFreeze({ checked_at: checkedAt, ...currentWindow });
}

function decision(effect, workOrder, type, reason, details = {}) {
  return deepFreeze({
    reactor_contract_version: CANONICAL_REACTOR_CONTRACT_VERSION,
    work_order_id: workOrder.work_order_id,
    work_order_revision: workOrder.revision,
    effect_id: effect.effect_id,
    effect_status: effect.status,
    decision: type,
    reason,
    ...details,
  });
}

function idleDecision(reason, details = {}) {
  return deepFreeze({
    reactor_contract_version: CANONICAL_REACTOR_CONTRACT_VERSION,
    work_order_id: null,
    work_order_revision: null,
    effect_id: null,
    effect_status: null,
    decision: "idle",
    reason,
    ...details,
  });
}

function derivePlan(projection, now, freshClaims, effectId = null) {
  timestamp(now, "now");
  if (projection.provider_settlement_epoch === null) {
    return idleDecision("provider_settlement_cutover_required");
  }
  const candidates = selectedEffects(projection, effectId);
  if (candidates.length === 0) return idleDecision("no_unresolved_effect");
  const actions = [];
  const waits = [];
  for (const effect of candidates) {
    if (effect.effect_contract_version !== 2) {
      waits.push(decision(
        effect,
        projection.work_orders[effect.work_order_id],
        "wait",
        "replay_only_effect",
      ));
      continue;
    }
    validateEffectIdentifiers(effectIdentity(effect));
    const workOrder = projection.work_orders[effect.work_order_id];
    if (!isPlainObject(workOrder)) {
      throw reactorError(
        "BUSINESS_CANONICAL_REACTOR_PROJECTION_INVALID",
        "Effect has no canonical Work Order",
        { effect_id: effect.effect_id, work_order_id: effect.work_order_id },
      );
    }
    const snapshot = workOrderLifecycle(projection, workOrder);
    const lifecycle = lifecycleEntry(snapshot, effect);
    if (TERMINAL_WORK_ORDER_STATUSES.has(workOrder.status)) {
      waits.push(decision(effect, workOrder, "wait", "work_order_terminal"));
      continue;
    }
    if (!lifecycle.current_attempt) {
      waits.push(decision(
        effect,
        workOrder,
        "wait",
        "stale_attempt_requires_manual_reconciliation",
      ));
      continue;
    }
    if (effect.status === "pending") {
      const mayClaim = snapshot.automation.may_schedule_forward_work
        || (effect.effect_kind === "provider.turn.cancel" && snapshot.automation.may_run_cleanup);
      if (!mayClaim) {
        waits.push(decision(effect, workOrder, "wait", "lifecycle_blocks_claim"));
        continue;
      }
      actions.push(decision(effect, workOrder, "claim", "pending_effect"));
      continue;
    }
    if (effect.status === "claimed") {
      const lease = exactLease(effect);
      if (Date.parse(now) >= Date.parse(lease.expires_at)) {
        actions.push(decision(effect, workOrder, "requeue", "claimed_lease_expired", {
          not_before: lease.expires_at,
        }));
        continue;
      }
      const fresh = freshClaims.get(effect.effect_id);
      if (fresh && same(fresh, leaseToken(lease, "effect.lease"))) {
        actions.push(decision(effect, workOrder, "send", "claimed_in_current_reactor_run", {
          not_after: lease.expires_at,
        }));
        continue;
      }
      waits.push(decision(effect, workOrder, "wait", "claimed_by_prior_reactor_run", {
        not_before: lease.expires_at,
      }));
      continue;
    }
    if (effect.status === "sending") {
      const lease = exactLease(effect);
      if (Date.parse(now) >= Date.parse(lease.expires_at)) {
        actions.push(decision(effect, workOrder, "expire_send", "sending_lease_expired", {
          not_before: lease.expires_at,
        }));
        continue;
      }
      actions.push(decision(effect, workOrder, "lookup_worker_result", "sending_requires_read_only_recovery", {
        not_after: lease.expires_at,
      }));
      continue;
    }
    if (effect.status === "delivery_unknown") {
      actions.push(decision(
        effect,
        workOrder,
        "probe_delivery_unknown",
        "recovery_probe_required",
      ));
    }
  }
  if (actions.length !== 0) {
    return actions.sort((left, right) => (
      (DECISION_PRIORITY[left.decision] - DECISION_PRIORITY[right.decision])
      || left.effect_id.localeCompare(right.effect_id)
    ))[0];
  }
  if (waits.length === 0) return idleDecision("no_executable_effect");
  return waits.sort((left, right) => {
    const leftTime = left.not_before ? Date.parse(left.not_before) : Number.POSITIVE_INFINITY;
    const rightTime = right.not_before ? Date.parse(right.not_before) : Number.POSITIVE_INFINITY;
    return (leftTime - rightTime) || left.effect_id.localeCompare(right.effect_id);
  })[0];
}

function deriveBusinessCanonicalReactorPlanV1({ projection, now, effect_id: effectId = null } = {}) {
  if (!isPlainObject(projection)) {
    throw reactorError(
      "BUSINESS_CANONICAL_REACTOR_PROJECTION_INVALID",
      "projection must be the canonical Business projection",
    );
  }
  const selectedEffectId = effectId === null ? null : portableRef(effectId, "effect_id");
  return derivePlan(projection, timestamp(now, "now"), new Map(), selectedEffectId);
}

function deterministicId(prefix, value) {
  return `${prefix}-${canonicalHash(value).slice(0, 32)}`;
}

function buildInternalAction(workOrder, effect, actorId, name, payload, identity) {
  const normalizedPayload = canonicalClone(payload, "internal_action.payload");
  return normalizeInternalActionEnvelopeV1({
    version: 1,
    internal_action_id: deterministicId("INT", identity),
    work_order_id: workOrder.work_order_id,
    plan_snapshot_ref: workOrder.plan_snapshot_ref,
    plan_hash: workOrder.plan_hash,
    expected_work_order_revision: workOrder.revision,
    actor: { type: "system", actor_id: actorId },
    name,
    payload: normalizedPayload,
    payload_hash: canonicalHash(normalizedPayload),
  });
}

function validateInternalActionResult(result, action, expectedStatus) {
  if (!isPlainObject(result)
      || result.internal_action_id !== action.internal_action_id
      || result.work_order_id !== action.work_order_id
      || result.effect_id !== action.payload.effect_id
      || result.action !== action.name
      || result.outbox_status !== expectedStatus) {
    throw reactorError(
      "BUSINESS_CANONICAL_REACTOR_BOUNDARY_RESULT_INVALID",
      "Internal action boundary result does not bind the exact reactor action",
      { internal_action_id: action.internal_action_id, action: action.name },
    );
  }
  return result;
}

function claimAction(workOrder, effect, actorId, ownerId, runId) {
  const leaseId = `lease:${runId}:${effect.effect_id}`;
  return buildInternalAction(
    workOrder,
    effect,
    actorId,
    "outbox.claim",
    { effect_id: effect.effect_id, lease_id: leaseId, owner_id: ownerId },
    {
      reactor_contract_version: 1,
      run_id: runId,
      action: "outbox.claim",
      effect_id: effect.effect_id,
      next_lease_generation: effect.lease_generation + 1,
    },
  );
}

function leasedAction(workOrder, effect, actorId, name, reason = null) {
  const lease = exactLease(effect);
  const payload = {
    effect_id: effect.effect_id,
    lease_id: lease.lease_id,
    owner_id: lease.owner_id,
    generation: lease.generation,
    ...(reason === null ? {} : { reason }),
  };
  return buildInternalAction(workOrder, effect, actorId, name, payload, {
    reactor_contract_version: 1,
    action: name,
    effect_id: effect.effect_id,
    fencing_token: leaseToken(lease, "effect.lease"),
    ...(reason === null ? {} : { reason }),
  });
}

function receiptRef(receipt) {
  const hash = canonicalHash(receipt);
  return { id: `IAR-${hash.slice(0, 32)}`, hash };
}

function matchingSendReceipt(projection, effect) {
  if (!effect.packet_verification_receipt) {
    throw reactorError(
      "BUSINESS_CANONICAL_REACTOR_SEND_AUTHORIZATION_MISSING",
      "Sending Effect has no retained Packet verification receipt",
      { effect_id: effect.effect_id },
    );
  }
  const currentToken = effect.lease === null
    ? effect.fencing_history?.at(-1) || null
    : leaseToken(effect.lease, "effect.lease");
  if (currentToken === null) {
    throw reactorError(
      "BUSINESS_CANONICAL_REACTOR_SEND_AUTHORIZATION_MISSING",
      "Sent Effect has no projector-derived fencing token",
      { effect_id: effect.effect_id },
    );
  }
  const matches = Object.values(projection.internal_receipts).filter((receipt) => (
    isPlainObject(receipt)
      && receipt.source_type === "internal_action"
      && receipt.work_order_id === effect.work_order_id
      && receipt.result?.action === "outbox.send.begin"
      && receipt.result?.effect_id === effect.effect_id
      && receipt.result?.outbox_status === "sending"
      && isPlainObject(receipt.result?.send_authorization_bundle)
      && same(receipt.result?.fencing_token, currentToken)
      && same(receipt.result?.packet_verification_receipt, effect.packet_verification_receipt)
  ));
  if (matches.length !== 1) {
    throw reactorError(
      "BUSINESS_CANONICAL_REACTOR_SEND_AUTHORIZATION_MISSING",
      "Canonical projection must contain one exact send-begin receipt for the issued token",
      { effect_id: effect.effect_id, matching_receipts: matches.length },
    );
  }
  return canonicalClone(matches[0], "internal_receipt");
}

function sendAuthorizationQuery(projection, effect) {
  const internalReceipt = matchingSendReceipt(projection, effect);
  const packetReceipt = normalizeDispatchPacketVerificationReceiptV1(
    effect.packet_verification_receipt,
  );
  const query = {
    authorization_contract_version: SEND_AUTHORIZATION_CONTRACT_VERSION,
    effect_id: effect.effect_id,
    mutation_idempotency_key: effect.idempotency_key,
    send_authorization_receipt_ref: receiptRef(internalReceipt),
    provider_request_ref: packetReceipt.packet_ref,
    worker_fencing_token: canonicalClone(
      internalReceipt.result.fencing_token,
      "internal_receipt.result.fencing_token",
    ),
  };
  exactObject(query, SEND_AUTHORIZATION_QUERY_FIELDS, "send_authorization_query");
  return deepFreeze({ query, internalReceipt, packetReceipt });
}

function providerEntryAuthorizationQuery(queryContext, minimumWindowRef) {
  const query = {
    ...queryContext.query,
    minimum_provider_entry_window_ref: minimumWindowRef === null
      ? null
      : contentRef(
        minimumWindowRef,
        "minimum_provider_entry_window_ref",
      ),
  };
  exactObject(
    query,
    PROVIDER_ENTRY_AUTHORIZATION_QUERY_FIELDS,
    "provider_entry_authorization_query",
  );
  return deepFreeze({ ...queryContext, query });
}

function validateOperationScopeBinding(binding, effect, packet) {
  let value;
  try {
    value = normalizeSendAuthorizationOperationScopeBindingV2(binding, effect);
  } catch (error) {
    throw reactorError(
      "BUSINESS_CANONICAL_REACTOR_SEND_AUTHORIZATION_INVALID",
      "Authorization operation scope does not derive from the immutable Effect",
      { effect_id: effect.effect_id, cause_code: error?.code || null },
    );
  }
  if (!isPlainObject(packet?.context)
      || value.request_id !== packet.context.user_input_request_id
      || !same(value.response_ref, packet.context.user_input_response_ref)) {
    throw reactorError(
      "BUSINESS_CANONICAL_REACTOR_SEND_AUTHORIZATION_INVALID",
      "Authorization operation scope does not derive from the Effect and verified Packet",
      { effect_id: effect.effect_id },
    );
  }
  return value;
}

function normalizeSendAuthorizationProof({
  proof: inputProof,
  projection,
  effect,
  packet,
  queryContext,
}) {
  let proof;
  try {
    proof = normalizeCommittedSendAuthorizationProofV2(inputProof);
  } catch (error) {
    throw reactorError(
      "BUSINESS_CANONICAL_REACTOR_SEND_AUTHORIZATION_INVALID",
      "Authorization proof is not one self-contained committed SAB closure",
      { effect_id: effect.effect_id, cause_code: error?.code || null },
    );
  }
  const expectedEffect = effectIdentity(effect);
  let packetReceipt;
  try {
    packetReceipt = normalizeDispatchPacketVerificationReceiptV1(
      proof.packet_verification_receipt,
    );
  } catch (error) {
    throw reactorError(
      "BUSINESS_CANONICAL_REACTOR_SEND_AUTHORIZATION_INVALID",
      "Authorization proof does not contain one fully valid Packet receipt",
      { effect_id: effect.effect_id, cause_code: error?.code || null },
    );
  }
  const epoch = projection.provider_settlement_epoch;
  if (!same(proof.effect, expectedEffect)
      || !same(proof.internal_receipt, queryContext.internalReceipt)
      || !same(packetReceipt, queryContext.packetReceipt)
      || !same(proof.authorized_fencing_token, queryContext.query.worker_fencing_token)
      || !same(proof.provider_request_ref, queryContext.query.provider_request_ref)
      || !same(
        proof.send_authorization_receipt_ref,
        queryContext.query.send_authorization_receipt_ref,
      )
      || !isPlainObject(epoch)
      || epoch.send_authorization_contract_version !== SEND_AUTHORIZATION_CONTRACT_VERSION
      || proof.send_event.payload.provider_settlement_cutover_id !== epoch.cutover_id) {
    throw reactorError(
      "BUSINESS_CANONICAL_REACTOR_SEND_AUTHORIZATION_INVALID",
      "Authorization proof does not bind the canonical projection query",
      { effect_id: effect.effect_id },
    );
  }
  if (packet !== null) {
    validateOperationScopeBinding(proof.operation_scope_binding, expectedEffect, packet);
  }
  return deepFreeze(proof);
}

function normalizeProviderEntryAuthorization({
  proof: inputProof,
  projection,
  effect,
  queryContext,
}) {
  let providerEntryAuthorization;
  try {
    providerEntryAuthorization = normalizeProviderEntryAuthorizationProofV1(inputProof);
  } catch (error) {
    throw reactorError(
      "BUSINESS_CANONICAL_REACTOR_PROVIDER_ENTRY_AUTHORIZATION_INVALID",
      "Provider-entry authorization does not close its stable SAB, receipt chain, and tip index",
      { effect_id: effect.effect_id, cause_code: error?.code || null },
    );
  }
  const base = normalizeSendAuthorizationProof({
    proof: providerEntryAuthorization.committed_send_authorization,
    projection,
    effect,
    packet: null,
    queryContext,
  });
  const projectedIndex = projection.provider_entry_windows?.[effect.effect_id];
  const minimumWindowRef = queryContext.query.minimum_provider_entry_window_ref;
  const entryMatchesQuery = minimumWindowRef === null
    ? providerEntryAuthorization.entry_window.window_kind === "send_begin"
      && providerEntryAuthorization.entry_window.window_sequence === 0
    : same(providerEntryAuthorization.entry_window.window_ref, minimumWindowRef);
  if (providerEntryAuthorization.provider_entry_authorization_version
        !== PROVIDER_ENTRY_AUTHORIZATION_VERSION
      || !same(providerEntryAuthorization.committed_send_authorization, base)
      || providerEntryAuthorization.committed_send_authorization_hash
        !== deriveCommittedSendAuthorizationHashV2(base)
      || !same(providerEntryAuthorization.current_window_index, projectedIndex)
      || !entryMatchesQuery) {
    throw reactorError(
      "BUSINESS_CANONICAL_REACTOR_PROVIDER_ENTRY_AUTHORIZATION_INVALID",
      "Provider-entry authorization does not bind its canonical query and projected retained tip",
      { effect_id: effect.effect_id },
    );
  }
  return providerEntryAuthorization;
}

function currentProviderEntryWindow(authorization) {
  return authorization.continuation_chain.at(-1)?.provider_entry_window
    || authorization.entry_window;
}

function normalizeRecoveryAuthorizationProof({
  proof: inputProof,
  projection,
  effect,
  authorized,
  providerEntryQueryContext,
  inspectedAt,
  trustedNow,
}) {
  const candidate = exactDataObjectSnapshot(
    inputProof,
    RECOVERY_AUTHORIZATION_PROOF_FIELDS,
    "recovery_authorization_proof",
  );
  const providerEntryAuthorization = normalizeProviderEntryAuthorization({
    proof: candidate.provider_entry_authorization,
    projection,
    effect,
    queryContext: providerEntryQueryContext,
  });
  const base = providerEntryAuthorization.committed_send_authorization;
  if (!same(base, authorized.proof)) {
    throw reactorError(
      "BUSINESS_CANONICAL_REACTOR_RECOVERY_UNAUTHORIZED",
      "Recovery authorization does not extend the exact stable send authorization already resolved",
      { effect_id: effect.effect_id },
    );
  }
  const eligibility = exactObject(
    canonicalClone(candidate.recovery_eligibility, "recovery_eligibility"),
    RECOVERY_ELIGIBILITY_FIELDS,
    "recovery_authorization_proof.recovery_eligibility",
  );
  const eligibilityBody = {
    eligibility_version: integer(
      eligibility.eligibility_version,
      "recovery_eligibility.eligibility_version",
      1,
    ),
    eligible: eligibility.eligible,
    state: portableRef(eligibility.state, "recovery_eligibility.state"),
    eligibility_basis_ref: contentRef(
      eligibility.eligibility_basis_ref,
      "recovery_eligibility.eligibility_basis_ref",
    ),
    eligible_at: timestamp(eligibility.eligible_at, "recovery_eligibility.eligible_at"),
    inspected_at: timestamp(eligibility.inspected_at, "recovery_eligibility.inspected_at"),
  };
  const workOrder = projection.work_orders[effect.work_order_id];
  const openRecoveryAttention = Object.values(workOrder.attention || {}).filter((entry) => (
    isPlainObject(entry)
      && entry.status === "open"
      && entry.effect_id === effect.effect_id
      && [
        "delivery_unknown",
        "timeout_requires_reconciliation",
        "cancel_requires_dispatch_reconciliation",
      ].includes(entry.kind)
      && same(entry.detail_ref, eligibilityBody.eligibility_basis_ref)
  ));
  if (eligibilityBody.eligibility_version !== 1
      || eligibilityBody.eligible !== true
      || eligibilityBody.state !== effect.status
      || eligibilityBody.state !== "delivery_unknown"
      || eligibilityBody.inspected_at !== inspectedAt
      || Date.parse(eligibilityBody.eligible_at) > Date.parse(inspectedAt)
      || Date.parse(inspectedAt) > Date.parse(trustedNow)
      || openRecoveryAttention.length !== 1
      || eligibilityBody.eligible_at !== openRecoveryAttention[0]?.opened_at) {
    throw reactorError(
      "BUSINESS_CANONICAL_REACTOR_RECOVERY_UNAUTHORIZED",
      "Recovery eligibility does not bind one current open reconciliation state",
      { effect_id: effect.effect_id },
    );
  }
  const expectedBody = {
    authorization_hash: deriveCommittedSendAuthorizationHashV2(base),
    recovery_eligibility: eligibilityBody,
    inspected_at: inspectedAt,
  };
  const expectedHash = canonicalHash(expectedBody);
  const expectedRef = { id: `RAR-${expectedHash.slice(0, 32)}`, hash: expectedHash };
  if (!same(
    contentRef(
      eligibility.recovery_authorization_ref,
      "recovery_eligibility.recovery_authorization_ref",
    ),
    expectedRef,
  )) {
    throw reactorError(
      "BUSINESS_CANONICAL_REACTOR_RECOVERY_UNAUTHORIZED",
      "Recovery authorization reference is not content-addressed to its send and eligibility proof",
      { effect_id: effect.effect_id },
    );
  }
  return deepFreeze({
    provider_entry_authorization: providerEntryAuthorization,
    recovery_eligibility: {
      ...eligibilityBody,
      recovery_authorization_ref: expectedRef,
    },
  });
}

function authorizedInvocation(effect, query) {
  return deepFreeze({
    invocation_version: 1,
    effect: effectIdentity(effect),
    mutation_idempotency_key: effect.idempotency_key,
    send_authorization_receipt_ref: query.send_authorization_receipt_ref,
    provider_request_ref: query.provider_request_ref,
    worker_fencing_token: query.worker_fencing_token,
  });
}

function providerCapabilities(driver) {
  if (!driver
      || driver.authorization_contract_version !== SEND_AUTHORIZATION_CONTRACT_VERSION
      || typeof driver.capabilities !== "function"
      || typeof driver.executeMutation !== "function"
      || typeof driver.readAuthorizedMutationResult !== "function"
      || typeof driver.inspectByExactKey !== "function"
      || typeof driver.readEvidence !== "function") return null;
  const capabilities = driver.capabilities();
  return same(capabilities, RECORDED_FAKE_CAPABILITIES) ? capabilities : null;
}

function presendRecorderCapabilities(recorder) {
  if (!recorder
      || typeof recorder.capabilities !== "function"
      || typeof recorder.recordVerifiedFailure !== "function") return null;
  const capabilities = recorder.capabilities();
  return same(capabilities, PRESEND_FAILURE_RECORDER_CAPABILITIES)
    ? capabilities
    : null;
}

function stageFor(effect) {
  return {
    "provider.thread.create": "thread_create",
    "provider.turn.start": "turn_start",
    "provider.user_input.submit": "user_input_submit",
    "provider.turn.cancel": "turn_cancel",
  }[effect.effect_kind];
}

function workerEvidenceFacts(effect, evidence) {
  const certainty = {
    certainty_fact_version: 2,
    effect_contract_version: 2,
    effect_kind: effect.effect_kind,
    effect_stage: stageFor(effect),
    settlement_source: "worker_result",
    classification: evidence.classification,
    reason: evidence.reason,
  };
  deriveSettlementDispositionV2(certainty);
  return certainty;
}

function providerEntryWindowCoreFromEvidence(value, path) {
  return deepFreeze({
    provider_entry_window_ref: contentRef(
      value.provider_entry_window_ref,
      `${path}.provider_entry_window_ref`,
    ),
    provider_entry_window_sequence: integer(
      value.provider_entry_window_sequence,
      `${path}.provider_entry_window_sequence`,
      0,
    ),
    provider_entry_window_lease_expires_at: timestamp(
      value.provider_entry_window_lease_expires_at,
      `${path}.provider_entry_window_lease_expires_at`,
    ),
    provider_entry_window_fencing_token: fencingToken(
      value.provider_entry_window_fencing_token,
      `${path}.provider_entry_window_fencing_token`,
    ),
  });
}

function providerEntryWindowCoreForWindow(window) {
  return deepFreeze({
    provider_entry_window_ref: window.window_ref,
    provider_entry_window_sequence: window.window_sequence,
    provider_entry_window_lease_expires_at: window.lease_expires_at,
    provider_entry_window_fencing_token: window.authorized_fencing_token,
  });
}

function assertEvidenceProviderEntryWindow(authorization, core, effect, errorCode) {
  const windows = [
    authorization.entry_window,
    ...authorization.continuation_chain.map((hop) => hop.provider_entry_window),
  ];
  const matches = windows.filter((window) => same(window.window_ref, core.provider_entry_window_ref));
  if (matches.length !== 1
      || !same(providerEntryWindowCoreForWindow(matches[0]), core)
      || !same(core.provider_entry_window_fencing_token, authorization
        .committed_send_authorization.authorized_fencing_token)) {
    throw reactorError(
      errorCode,
      "Provider evidence does not bind one exact receipt-covered provider-entry window ancestor",
      { effect_id: effect.effect_id },
    );
  }
  return matches[0];
}

function normalizeWorkerEvidenceRecord(evidence) {
  const errorCode = "BUSINESS_CANONICAL_REACTOR_WORKER_EVIDENCE_INVALID";
  return exactObject(
    canonicalClone(evidence, "worker_result_evidence", errorCode),
    WORKER_EVIDENCE_FIELDS,
    "worker_result_evidence",
    errorCode,
  );
}

function validateWorkerEvidence(evidence, effect, authorized, workerResultRef, result) {
  const value = normalizeWorkerEvidenceRecord(evidence);
  const expectedEffect = effectIdentity(effect);
  const { query } = authorized;
  const entryCore = providerEntryWindowCoreFromEvidence(value, "worker_result_evidence");
  const entryWindow = assertEvidenceProviderEntryWindow(
    authorized.providerEntryAuthorization,
    entryCore,
    effect,
    "BUSINESS_CANONICAL_REACTOR_WORKER_EVIDENCE_INVALID",
  );
  if (!isPlainObject(value)
      || value.evidence_version !== RECORDED_FAKE_EVIDENCE_VERSION
      || value.evidence_kind !== "worker_result"
      || value.effect_id !== effect.effect_id
      || value.effect_contract_version !== 2
      || value.effect_kind !== effect.effect_kind
      || value.work_order_id !== effect.work_order_id
      || value.branch_ref !== effect.branch_ref
      || value.attempt !== effect.attempt
      || value.dispatch_id !== effect.dispatch_id
      || value.provider_ref !== effect.provider_ref
      || value.mutation_idempotency_key !== effect.idempotency_key
      || !same(value.worker_fencing_token, query.worker_fencing_token)
      || !same(value.send_authorization_receipt_ref, query.send_authorization_receipt_ref)
      || !same(value.provider_request_ref, query.provider_request_ref)
      || value.authorization_hash !== deriveCommittedSendAuthorizationHashV2(authorized.proof)
      || timestamp(value.entry_checked_at, "worker_result_evidence.entry_checked_at")
        !== value.entry_checked_at
      || timestamp(
        value.mutation_entry_checked_at,
        "worker_result_evidence.mutation_entry_checked_at",
      ) !== value.mutation_entry_checked_at
      || Date.parse(value.entry_checked_at) > Date.parse(value.mutation_entry_checked_at)
      || Date.parse(value.entry_checked_at)
        < Date.parse(entryWindow.source_event.payload.occurred_at)
      || Date.parse(value.mutation_entry_checked_at)
        >= Date.parse(entryWindow.lease_expires_at)
      || timestamp(value.recorded_at, "worker_result_evidence.recorded_at")
        !== value.recorded_at
      || Date.parse(value.mutation_entry_checked_at) > Date.parse(value.recorded_at)
      || result.driver_contract_version !== 1
      || result.classification !== value.classification
      || result.reason !== value.reason
      || !same(result.runtime_identity, value.runtime_identity)
      || !same(result.provider_result_ref, value.provider_result_ref)
      || !same(result.callback_fencing_token, query.worker_fencing_token)
      || result.retry_authorization !== "not_evaluated"
      || !same(
        workerResultRef,
        { id: `WRR-${canonicalHash(value).slice(0, 32)}`, hash: canonicalHash(value) },
      )) {
    throw reactorError(
      "BUSINESS_CANONICAL_REACTOR_WORKER_EVIDENCE_INVALID",
      "Worker result does not bind the exact authorized Effect, Packet, receipt, and token",
      { effect_id: effect.effect_id },
    );
  }
  workerEvidenceFacts(expectedEffect, value);
  return deepFreeze(value);
}

async function validateRecoveryEvidence({
  probe: inputProbe,
  loadEvidence,
  effect,
  authorized,
  recoveryProof,
  inspectedAt,
}) {
  const errorCode = "BUSINESS_CANONICAL_REACTOR_RECOVERY_EVIDENCE_INVALID";
  const probe = exactObject(
    canonicalClone(inputProbe, "recovery_probe_result", errorCode),
    PROBE_RESULT_FIELDS,
    "recovery_probe_result",
    errorCode,
  );
  const expectedDisposition = {
    accepted: {
      probe_classification: "found",
      reason: "recovery_probe_found",
    },
    not_sent: {
      probe_classification: "authoritative_absence",
      reason: "recovery_probe_authoritative_absence",
    },
  }[probe.classification];
  if (probe.probe_contract_version !== 1
      || probe.effect_id !== effect.effect_id
      || probe.mutation_idempotency_key !== effect.idempotency_key
      || expectedDisposition === undefined
      || probe.probe_classification !== expectedDisposition.probe_classification
      || probe.reason !== expectedDisposition.reason
      || probe.retry_authorization !== "not_evaluated") {
    throw reactorError(
      errorCode,
      "Recorded fake recovery result does not bind one supported exact disposition",
      { effect_id: effect.effect_id },
    );
  }
  const probeReceiptRef = contentRef(
    probe.probe_receipt_ref,
    "recovery_probe_result.probe_receipt_ref",
  );
  const evidence = exactObject(
    canonicalClone(
      await loadEvidence(probeReceiptRef),
      "recovery_probe_evidence",
      errorCode,
    ),
    PROBE_EVIDENCE_FIELDS,
    "recovery_probe_evidence",
    errorCode,
  );
  const entryCore = providerEntryWindowCoreFromEvidence(evidence, "recovery_probe_evidence");
  assertEvidenceProviderEntryWindow(
    recoveryProof.provider_entry_authorization,
    entryCore,
    effect,
    errorCode,
  );
  if (evidence.evidence_version !== RECORDED_FAKE_EVIDENCE_VERSION
      || evidence.evidence_kind !== "recovery_probe"
      || evidence.effect_id !== effect.effect_id
      || evidence.mutation_idempotency_key !== effect.idempotency_key
      || evidence.classification !== probe.classification
      || evidence.probe_classification !== probe.probe_classification
      || evidence.reason !== probe.reason
      || !same(evidence.runtime_identity, probe.runtime_identity)
      || !same(evidence.provider_result_ref, probe.provider_result_ref)
      || evidence.retry_authorization !== probe.retry_authorization
      || timestamp(evidence.inspected_at, "recovery_probe_evidence.inspected_at")
        !== inspectedAt
      || evidence.authorization_hash !== deriveCommittedSendAuthorizationHashV2(authorized.proof)
      || evidence.recovery_authorization_hash
        !== recoveryProof.recovery_eligibility.recovery_authorization_ref.hash
      || !same(
        probeReceiptRef,
        { id: `PRB-${canonicalHash(evidence).slice(0, 32)}`, hash: canonicalHash(evidence) },
      )) {
    throw reactorError(
      errorCode,
      "Recovery evidence is not the exact content-addressed authorized probe result",
      { effect_id: effect.effect_id },
    );
  }
  return deepFreeze({ probe, evidence, probeReceiptRef });
}

function observationEnvelope(workOrder, actorId, name, payload, identity) {
  const normalizedPayload = canonicalClone(payload, "observation.payload");
  return normalizeBusinessRuntimeObservationEnvelope({
    version: 2,
    observation_id: deterministicId("OBS", identity),
    work_order_id: workOrder.work_order_id,
    plan_snapshot_ref: workOrder.plan_snapshot_ref,
    plan_hash: workOrder.plan_hash,
    work_order_revision: workOrder.revision,
    actor: { type: "runtime", actor_id: actorId },
    name,
    payload: normalizedPayload,
    payload_hash: canonicalHash(normalizedPayload),
  });
}

function workerSettlementObservation(workOrder, effect, actorId, evidence, workerResultRef) {
  const payload = {
    effect_id: effect.effect_id,
    effect_contract_version: effect.effect_contract_version,
    effect_kind: effect.effect_kind,
    branch_ref: effect.branch_ref,
    attempt: effect.attempt,
    dispatch_id: effect.dispatch_id,
    classification: evidence.classification,
    settlement_source: "worker_result",
    worker_fencing_token: evidence.worker_fencing_token,
    worker_result_ref: workerResultRef,
  };
  return observationEnvelope(
    workOrder,
    actorId,
    "provider.effect.settlement.recorded",
    payload,
    {
      reactor_contract_version: 1,
      source: "worker_result",
      effect_id: effect.effect_id,
      worker_result_ref: workerResultRef,
    },
  );
}

function expiryObservation(workOrder, effect, actorId) {
  const lease = exactLease(effect);
  const token = leaseToken(lease, "effect.lease");
  const expiryBody = {
    effect_id: effect.effect_id,
    fencing_token: token,
    lease_expires_at: lease.expires_at,
  };
  const hash = canonicalHash(expiryBody);
  const payload = {
    effect_id: effect.effect_id,
    effect_contract_version: effect.effect_contract_version,
    effect_kind: effect.effect_kind,
    branch_ref: effect.branch_ref,
    attempt: effect.attempt,
    dispatch_id: effect.dispatch_id,
    expired_fencing_token: token,
    lease_expires_at: lease.expires_at,
    expiry_receipt_ref: { id: `EXP-${hash.slice(0, 32)}`, hash },
  };
  return observationEnvelope(
    workOrder,
    actorId,
    "provider.effect.send_expiration.recorded",
    payload,
    { reactor_contract_version: 1, source: "send_expiry", ...expiryBody },
  );
}

function presendFailureObservation(workOrder, effect, actorId, reason, failureRecordRef) {
  const token = leaseToken(exactLease(effect), "effect.lease");
  const payload = {
    effect_id: effect.effect_id,
    effect_contract_version: effect.effect_contract_version,
    effect_kind: effect.effect_kind,
    branch_ref: effect.branch_ref,
    attempt: effect.attempt,
    dispatch_id: effect.dispatch_id,
    claimed_fencing_token: token,
    failure_reason: reason,
    failure_record_ref: failureRecordRef,
  };
  return observationEnvelope(
    workOrder,
    actorId,
    "provider.effect.presend_failure.recorded",
    payload,
    {
      reactor_contract_version: 1,
      source: "presend_failure",
      effect_id: effect.effect_id,
      failure_reason: reason,
      failure_record_ref: failureRecordRef,
    },
  );
}

function presendFailureSource(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  if ([
    "BUSINESS_INTERNAL_PACKET_VERIFICATION_FAILED",
    "BUSINESS_INTERNAL_PACKET_VERIFICATION_STALE",
  ].includes(code)) return "packet_store";
  if ([
    "BUSINESS_INTERNAL_AUTHORIZATION_DENIED",
    "BUSINESS_INTERNAL_AUTHORITY_INVALID",
    "BUSINESS_INTERNAL_ACTOR_BINDING_MISMATCH",
  ].includes(code)) return "authority";
  if (code === "BUSINESS_INTERNAL_PACKET_STORE_REQUIRED") {
    return "driver_capability";
  }
  return null;
}

function recoverySettlementObservation(workOrder, effect, actorId, evidence, probeReceiptRef) {
  const certainty = {
    certainty_fact_version: 2,
    effect_contract_version: 2,
    effect_kind: effect.effect_kind,
    effect_stage: stageFor(effect),
    settlement_source: "recovery_probe",
    classification: evidence.classification,
    reason: evidence.reason,
  };
  deriveSettlementDispositionV2(certainty);
  const payload = {
    effect_id: effect.effect_id,
    effect_contract_version: effect.effect_contract_version,
    effect_kind: effect.effect_kind,
    branch_ref: effect.branch_ref,
    attempt: effect.attempt,
    dispatch_id: effect.dispatch_id,
    classification: evidence.classification,
    settlement_source: "recovery_probe",
    recovery_probe: {
      probe_receipt_ref: probeReceiptRef,
      mutation_idempotency_key: effect.idempotency_key,
    },
  };
  return observationEnvelope(
    workOrder,
    actorId,
    "provider.effect.settlement.recorded",
    payload,
    {
      reactor_contract_version: 1,
      source: "recovery_probe",
      effect_id: effect.effect_id,
      probe_receipt_ref: probeReceiptRef,
    },
  );
}

function validateAbortSignal(signal) {
  if (signal === undefined || signal === null) return null;
  if (!signal || typeof signal.aborted !== "boolean"
      || typeof signal.addEventListener !== "function"
      || typeof signal.removeEventListener !== "function") {
    throw new TypeError("signal must be an AbortSignal");
  }
  return signal;
}

function normalizeStepInput(input) {
  if (!isPlainObject(input)
      || Object.keys(input).some((field) => !STEP_INPUT_FIELDS.has(field))) {
    throw reactorError(
      "BUSINESS_CANONICAL_REACTOR_INPUT_INVALID",
      "Reactor step input may select only an Effect and AbortSignal",
    );
  }
  return input;
}

function assertNotAborted(signal) {
  if (signal?.aborted) {
    throw reactorError("BUSINESS_CANONICAL_REACTOR_ABORTED", "Reactor step was aborted");
  }
}

function optionalSignal(input, signal) {
  return signal === null ? input : { ...input, signal };
}

function validateDependencies(options) {
  const required = [
    [options.eventStore, "replay", "eventStore.replay"],
    [options.eventStore, "inspectRecovery", "eventStore.inspectRecovery"],
    [options.internalActionBoundary, "execute", "internalActionBoundary.execute"],
    [options.observationBoundary, "execute", "observationBoundary.execute"],
    [options.packetStore, "read", "packetStore.read"],
    [options.packetStore, "verifyForEffect", "packetStore.verifyForEffect"],
    [options.authorizationResolver, "resolveCommittedSendAuthorization", "authorizationResolver.resolveCommittedSendAuthorization"],
    [options.authorizationResolver, "resolveRetainedProviderEntryAuthorization", "authorizationResolver.resolveRetainedProviderEntryAuthorization"],
    [options.authorizationResolver, "resolveRecoveryAuthorization", "authorizationResolver.resolveRecoveryAuthorization"],
  ];
  for (const [target, method, name] of required) {
    if (!target || typeof target[method] !== "function") throw new TypeError(`${name} is required`);
  }
}

function createBusinessCanonicalReactor(options = {}) {
  validateDependencies(options);
  const {
    eventStore,
    internalActionBoundary,
    observationBoundary,
    packetStore,
    authorizationResolver,
    recordedFakeProvider = null,
    presendFailureRecorder = null,
    enabled = false,
    internalAuthentication,
    observationAuthentication,
    controlPlaneObservationAuthentication = observationAuthentication,
    systemActorId,
    runtimeActorId,
    ownerId,
    clock = () => new Date().toISOString(),
    runId: configuredRunId = null,
  } = options;
  if (enabled !== true && enabled !== false) throw new TypeError("enabled must be a boolean");
  if (typeof clock !== "function") throw new TypeError("clock must be a function");
  const systemActor = portableRef(systemActorId, "systemActorId");
  const runtimeActor = portableRef(runtimeActorId, "runtimeActorId");
  const workerOwner = portableRef(ownerId, "ownerId");
  const runId = configuredRunId === null
    ? crypto.randomBytes(16).toString("hex")
    : text(configuredRunId, "runId", 64);
  if (!/^[a-f0-9]{32}$/u.test(runId)) throw new TypeError("runId must be 32 lowercase hex characters");
  const capabilities = providerCapabilities(recordedFakeProvider);
  const presendCapabilities = presendRecorderCapabilities(presendFailureRecorder);
  const projectionConfig = businessProjectionConfigurationV1();
  const freshClaims = new Map();

  async function replay() {
    return normalizeReplay(await eventStore.replay(projectionConfig));
  }

  async function replayForExecution(signal) {
    assertNotAborted(signal);
    let inspection;
    try {
      inspection = normalizeCleanRecoveryInspection(await eventStore.inspectRecovery());
    } catch (error) {
      if (error instanceof BusinessCanonicalReactorError) throw error;
      throw reactorError(
        "BUSINESS_CANONICAL_REACTOR_RECOVERY_BLOCKED",
        "EventStore recovery inspection failed closed before reactor execution",
        { cause_code: error?.code || null },
      );
    }
    assertNotAborted(signal);
    const current = await replay();
    if (current.watermark.journal_sequence !== inspection.last_valid_sequence) {
      throw reactorError(
        "BUSINESS_CANONICAL_REACTOR_RECOVERY_BLOCKED",
        "Recovery inspection and canonical replay do not share one journal position",
        {
          inspected_sequence: inspection.last_valid_sequence,
          replayed_sequence: current.watermark.journal_sequence,
        },
      );
    }
    return current;
  }

  async function planOnce(input = {}) {
    const { effect_id: effectId = null, signal } = normalizeStepInput(input);
    const requestSignal = validateAbortSignal(signal);
    assertNotAborted(requestSignal);
    const normalizedEffectId = effectId === null ? null : portableRef(effectId, "effect_id");
    const current = await replay();
    assertNotAborted(requestSignal);
    return derivePlan(
      current.state,
      timestamp(clock(), "clock"),
      freshClaims,
      normalizedEffectId,
    );
  }

  function assertExecutionEnabled() {
    if (!enabled) {
      throw reactorError(
        "BUSINESS_CANONICAL_REACTOR_DISABLED",
        "Canonical reactor execution is disabled; planning remains read-only",
      );
    }
    if (presendCapabilities === null) {
      throw reactorError(
        "BUSINESS_CANONICAL_REACTOR_PRESEND_RECORDER_REQUIRED",
        "Execution requires a source-verifying durable pre-send failure recorder",
      );
    }
  }

  async function resolveCommittedSendAuthorization(
    projection,
    effect,
    { livePacketVerification = false } = {},
  ) {
    const queryContext = sendAuthorizationQuery(projection, effect);
    const packet = livePacketVerification
      ? await packetStore.read(queryContext.packetReceipt.packet_ref)
      : null;
    if (livePacketVerification) {
      const freshPacketReceipt = normalizeDispatchPacketVerificationReceiptV1(
        await packetStore.verifyForEffect(effectIdentity(effect)),
      );
      if (!same(freshPacketReceipt, queryContext.packetReceipt)) {
        throw reactorError(
          "BUSINESS_CANONICAL_REACTOR_PACKET_VERIFICATION_STALE",
          "Live provider entry requires the exact retained Packet verification receipt",
          { effect_id: effect.effect_id },
        );
      }
    }
    // This port proves historical journal commitment only. It deliberately
    // cannot grant provider-entry authority: the driver owns that separate
    // live resolver and repeats it immediately before durable call entry.
    const proof = await authorizationResolver.resolveCommittedSendAuthorization(
      queryContext.query,
    );
    const normalizedProof = normalizeSendAuthorizationProof({
      proof,
      projection,
      effect,
      packet,
      queryContext,
    });
    return { ...queryContext, packet, proof: normalizedProof };
  }

  async function resolveRetainedProviderEntryAuthorization(
    projection,
    effect,
    authorized,
    minimumWindowRef,
  ) {
    const queryContext = providerEntryAuthorizationQuery(authorized, minimumWindowRef);
    const providerEntryAuthorization = await authorizationResolver
      .resolveRetainedProviderEntryAuthorization(queryContext.query);
    return {
      ...authorized,
      providerEntryQueryContext: queryContext,
      providerEntryAuthorization: normalizeProviderEntryAuthorization({
        proof: providerEntryAuthorization,
        projection,
        effect,
        queryContext,
      }),
    };
  }

  async function settleWorkerResult(projection, effect, authorized, result, signal) {
    const normalizedResult = exactObject(
      canonicalClone(
        result,
        "worker_result",
        "BUSINESS_CANONICAL_REACTOR_WORKER_EVIDENCE_INVALID",
      ),
      WORKER_RESULT_FIELDS,
      "worker_result",
      "BUSINESS_CANONICAL_REACTOR_WORKER_EVIDENCE_INVALID",
    );
    if (normalizedResult.effect_id !== effect.effect_id
        || normalizedResult.mutation_idempotency_key !== effect.idempotency_key
        || !isPlainObject(normalizedResult.worker_result_ref)) {
      throw reactorError(
        "BUSINESS_CANONICAL_REACTOR_WORKER_EVIDENCE_INVALID",
        "Recorded fake result does not identify the exact worker evidence",
        { effect_id: effect.effect_id },
      );
    }
    const workerResultRef = contentRef(
      normalizedResult.worker_result_ref,
      "worker_result.worker_result_ref",
    );
    const latest = await replay();
    const settlementProjection = latest.state;
    const settlementEffect = settlementProjection.outbox[effect.effect_id];
    if (!isPlainObject(settlementEffect)
        || !same(effectIdentity(settlementEffect), effectIdentity(effect))) {
      throw reactorError(
        "BUSINESS_CANONICAL_REACTOR_WORKER_EVIDENCE_INVALID",
        "Worker settlement lost its exact immutable Effect while refreshing PEW authority",
        { effect_id: effect.effect_id },
      );
    }
    const rawEvidence = await recordedFakeProvider.readEvidence(workerResultRef);
    const normalizedEvidence = normalizeWorkerEvidenceRecord(rawEvidence);
    const entryCore = providerEntryWindowCoreFromEvidence(
      normalizedEvidence,
      "worker_result_evidence",
    );
    const entryAuthorized = await resolveRetainedProviderEntryAuthorization(
      settlementProjection,
      settlementEffect,
      authorized,
      entryCore.provider_entry_window_ref,
    );
    const evidence = validateWorkerEvidence(
      normalizedEvidence,
      settlementEffect,
      entryAuthorized,
      workerResultRef,
      normalizedResult,
    );
    const workOrder = settlementProjection.work_orders[settlementEffect.work_order_id];
    const observation = workerSettlementObservation(
      workOrder,
      settlementEffect,
      runtimeActor,
      evidence,
      workerResultRef,
    );
    const settlement = await observationBoundary.execute(optionalSignal({
      observation,
      authentication: observationAuthentication,
    }, signal));
    return deepFreeze({
      reactor_contract_version: 1,
      status: "settled",
      effect_id: settlementEffect.effect_id,
      source: "worker_result",
      worker_result_ref: workerResultRef,
      result: settlement,
    });
  }

  async function executeClaim(projection, effect, signal) {
    const workOrder = projection.work_orders[effect.work_order_id];
    const action = claimAction(workOrder, effect, systemActor, workerOwner, runId);
    const expectedToken = {
      lease_id: action.payload.lease_id,
      owner_id: action.payload.owner_id,
      generation: effect.lease_generation + 1,
    };
    const result = await internalActionBoundary.execute({
      internal_action: action,
      authentication: internalAuthentication,
      signal,
    });
    validateInternalActionResult(result, action, "claimed");
    const token = fencingToken(result.fencing_token, "claim_result.fencing_token");
    if (!same(token, expectedToken)) {
      throw reactorError(
        "BUSINESS_CANONICAL_REACTOR_BOUNDARY_RESULT_INVALID",
        "Claim result did not return the exact reactor-issued lease token",
        { effect_id: effect.effect_id },
      );
    }
    freshClaims.set(effect.effect_id, deepFreeze(token));
    return deepFreeze({
      reactor_contract_version: 1,
      status: "claimed",
      effect_id: effect.effect_id,
      fencing_token: token,
      result,
    });
  }

  async function executeRequeue(projection, effect, signal) {
    const workOrder = projection.work_orders[effect.work_order_id];
    const action = leasedAction(
      workOrder,
      effect,
      systemActor,
      "outbox.requeue",
      "claimed_lease_expired_before_send",
    );
    const result = await internalActionBoundary.execute({
      internal_action: action,
      authentication: internalAuthentication,
      signal,
    });
    validateInternalActionResult(result, action, "pending");
    freshClaims.delete(effect.effect_id);
    return deepFreeze({
      reactor_contract_version: 1,
      status: "requeued",
      effect_id: effect.effect_id,
      result,
    });
  }

  async function recordVerifiedPresendFailure(projection, effect, failureSource, signal) {
    const token = leaseToken(exactLease(effect), "effect.lease");
    const presendFailureId = deterministicId("PSF", {
      reactor_contract_version: 1,
      effect_id: effect.effect_id,
      claimed_fencing_token: token,
      failure_source: failureSource,
    });
    const recorded = exactObject(
      canonicalClone(await presendFailureRecorder.recordVerifiedFailure({
        recorder_contract_version: 1,
        presend_failure_id: presendFailureId,
        effect_identity: effectIdentity(effect),
        claimed_fencing_token: token,
        failure_source: failureSource,
      }, { signal }), "presend_failure_result"),
      PRESEND_FAILURE_RESULT_FIELDS,
      "presend_failure_result",
    );
    const record = exactObject(
      recorded.failure_record,
      PRESEND_FAILURE_RECORD_FIELDS,
      "presend_failure_result.failure_record",
    );
    const recordHash = canonicalHash(record);
    const recordRef = { id: `PFR-${recordHash.slice(0, 32)}`, hash: recordHash };
    const attestation = exactObject(
      recorded.presend_failure_attestation,
      PRESEND_FAILURE_ATTESTATION_FIELDS,
      "presend_failure_result.presend_failure_attestation",
    );
    if (recorded.recorder_contract_version !== 1
        || recorded.presend_failure_id !== presendFailureId
        || record.failure_record_version !== 1
        || record.failure_record_kind !== "verified_provider_presend_failure"
        || record.presend_failure_id !== presendFailureId
        || record.failure_source !== failureSource
        || !same(record.effect_identity, effectIdentity(effect))
        || !same(record.claimed_fencing_token, token)
        || !Array.isArray(record.evidence_refs)
        || record.evidence_refs.length === 0
        || !same(recorded.failure_record_ref, recordRef)
        || attestation.effect_id !== effect.effect_id
        || attestation.idempotency_key !== effect.idempotency_key
        || attestation.provider_ref !== effect.provider_ref
        || !same(attestation.claimed_fencing_token, token)
        || attestation.failure_reason !== record.failure_reason
        || !same(attestation.failure_record_ref, recordRef)
        || !same(attestation.evidence_refs, record.evidence_refs)) {
      throw reactorError(
        "BUSINESS_CANONICAL_REACTOR_PRESEND_RECORD_INVALID",
        "Trusted recorder did not return one exact source-verified content-addressed failure",
        { effect_id: effect.effect_id, failure_source: failureSource },
      );
    }
    deriveSettlementDispositionV2({
      certainty_fact_version: 2,
      effect_contract_version: 2,
      effect_kind: effect.effect_kind,
      effect_stage: stageFor(effect),
      settlement_source: "control_plane",
      classification: "not_sent",
      reason: record.failure_reason,
    });
    const workOrder = projection.work_orders[effect.work_order_id];
    const observation = presendFailureObservation(
      workOrder,
      effect,
      systemActor,
      record.failure_reason,
      recordRef,
    );
    const result = await observationBoundary.execute(optionalSignal({
      observation,
      authentication: controlPlaneObservationAuthentication,
    }, signal));
    return deepFreeze({
      reactor_contract_version: 1,
      status: "operator_attention",
      effect_id: effect.effect_id,
      source: "verified_presend_failure",
      failure_record_ref: recordRef,
      result,
    });
  }

  async function reconcileClosedProviderEntry(projection, effect, signal) {
    if (!isPlainObject(effect)) {
      throw reactorError(
        "BUSINESS_CANONICAL_REACTOR_PROJECTION_INVALID",
        "Provider-entry reconciliation lost its projected Effect",
      );
    }
    if (effect.status === "sending" && isPlainObject(effect.lease)) {
      return executeExpiry(projection, effect, signal);
    }
    return deepFreeze({
      reactor_contract_version: 1,
      status: "waiting",
      effect_id: effect.effect_id,
      reason: "provider_entry_state_advanced",
      not_before: null,
    });
  }

  async function executeSend(projection, effect, signal) {
    const workOrder = projection.work_orders[effect.work_order_id];
    const action = leasedAction(workOrder, effect, systemActor, "outbox.send.begin");
    try {
      await internalActionBoundary.execute({
        internal_action: action,
        authentication: internalAuthentication,
        signal,
      });
    } catch (error) {
      const failureSource = presendFailureSource(error);
      if (failureSource === null) {
        throw reactorError(
          "BUSINESS_CANONICAL_REACTOR_PRESEND_FAILURE_UNVERIFIED",
          "Send authorization failed without a source-specific verifiable failure",
          { effect_id: effect.effect_id, cause_code: error?.code || null },
        );
      }
      return recordVerifiedPresendFailure(projection, effect, failureSource, signal);
    }
    freshClaims.delete(effect.effect_id);
    const afterSend = await replay();
    const sendingEffect = afterSend.state.outbox[effect.effect_id];
    if (!sendingEffect || sendingEffect.status !== "sending") {
      throw reactorError(
        "BUSINESS_CANONICAL_REACTOR_BOUNDARY_RESULT_INVALID",
        "Send-begin receipt did not materialize one sending Effect",
        { effect_id: effect.effect_id },
      );
    }
    const authorized = await resolveCommittedSendAuthorization(
      afterSend.state,
      sendingEffect,
      { livePacketVerification: true },
    );
    const beforeProviderEntry = await replay();
    const entryEffect = beforeProviderEntry.state.outbox[effect.effect_id];
    if (!isPlainObject(entryEffect)
        || !same(effectIdentity(entryEffect), effectIdentity(sendingEffect))) {
      throw reactorError(
        "BUSINESS_CANONICAL_REACTOR_PROVIDER_ENTRY_EXPIRED",
        "Provider entry lost its exact immutable Effect before the local entry gate",
        { effect_id: effect.effect_id },
      );
    }
    try {
      assertProviderEntryWindow(
        beforeProviderEntry.state,
        entryEffect,
        authorized.query.worker_fencing_token,
        clock(),
      );
    } catch (error) {
      if (error?.code !== "BUSINESS_CANONICAL_REACTOR_PROVIDER_ENTRY_EXPIRED") throw error;
      return reconcileClosedProviderEntry(
        beforeProviderEntry.state,
        entryEffect,
        signal,
      );
    }
    const invocation = authorizedInvocation(entryEffect, authorized.query);
    let result;
    try {
      result = await recordedFakeProvider.executeMutation(invocation);
    } catch (error) {
      if (error?.code !== "BUSINESS_RECORDED_FAKE_ENTRY_EXPIRED"
          || error?.details?.control_plane_disposition !== "send_expiration_required") {
        throw error;
      }
      const afterExpiredEntry = await replay();
      const expiredEffect = afterExpiredEntry.state.outbox[effect.effect_id];
      return reconcileClosedProviderEntry(
        afterExpiredEntry.state,
        expiredEffect,
        signal,
      );
    }
    return settleWorkerResult(
      beforeProviderEntry.state,
      entryEffect,
      authorized,
      result,
      signal,
    );
  }

  async function executeLookup(projection, effect, signal) {
    const authorized = await resolveCommittedSendAuthorization(
      projection,
      effect,
    );
    const lookup = await recordedFakeProvider.readAuthorizedMutationResult(
      authorizedInvocation(effect, authorized.query),
    );
    if (!isPlainObject(lookup)
        || lookup.lookup_contract_version !== 1
        || lookup.effect_id !== effect.effect_id
        || lookup.mutation_idempotency_key !== effect.idempotency_key
        || !["not_found", "worker_result", "recovery_required"].includes(lookup.status)) {
      throw reactorError(
        "BUSINESS_CANONICAL_REACTOR_WORKER_LOOKUP_INVALID",
        "Recorded fake returned an invalid authorized read-only lookup",
        { effect_id: effect.effect_id },
      );
    }
    if (lookup.status === "worker_result") {
      return settleWorkerResult(projection, effect, authorized, lookup.result, signal);
    }
    return deepFreeze({
      reactor_contract_version: 1,
      status: "waiting",
      effect_id: effect.effect_id,
      reason: lookup.status,
      not_before: effect.lease.expires_at,
    });
  }

  async function executeExpiry(projection, effect, signal) {
    // An expiry is control-plane derived, but still requires closure to the
    // exact committed send receipt before it can create delivery ambiguity.
    await resolveCommittedSendAuthorization(projection, effect);
    const workOrder = projection.work_orders[effect.work_order_id];
    const observation = expiryObservation(workOrder, effect, systemActor);
    const result = await observationBoundary.execute(optionalSignal({
      observation,
      authentication: controlPlaneObservationAuthentication,
    }, signal));
    return deepFreeze({
      reactor_contract_version: 1,
      status: "delivery_unknown",
      effect_id: effect.effect_id,
      source: "send_expiry",
      result,
    });
  }

  async function executeProbe(projection, effect, signal) {
    const authorized = await resolveCommittedSendAuthorization(
      projection,
      effect,
    );
    const providerEntryQueryContext = providerEntryAuthorizationQuery(authorized, null);
    const inspectedAt = timestamp(clock(), "clock");
    const recoveryQuery = {
      authorization_contract_version: SEND_AUTHORIZATION_CONTRACT_VERSION,
      effect_id: effect.effect_id,
      mutation_idempotency_key: effect.idempotency_key,
      inspected_at: inspectedAt,
      send_authorization_receipt_ref: authorized.query.send_authorization_receipt_ref,
      minimum_provider_entry_window_ref: null,
    };
    const inputRecoveryProof = await authorizationResolver
      .resolveRecoveryAuthorization(recoveryQuery);
    const trustedNow = timestamp(clock(), "clock");
    const recoveryProof = normalizeRecoveryAuthorizationProof({
      proof: inputRecoveryProof,
      projection,
      effect,
      authorized,
      providerEntryQueryContext,
      inspectedAt,
      trustedNow,
    });
    const probe = await recordedFakeProvider.inspectByExactKey({
      probe_version: 1,
      mutation_idempotency_key: effect.idempotency_key,
      expected_effect_id: effect.effect_id,
      send_authorization_receipt_ref: authorized.query.send_authorization_receipt_ref,
      inspected_at: inspectedAt,
    });
    const { evidence, probeReceiptRef } = await validateRecoveryEvidence({
      probe,
      loadEvidence: (ref) => recordedFakeProvider.readEvidence(ref),
      effect,
      authorized,
      recoveryProof,
      inspectedAt,
    });
    const workOrder = projection.work_orders[effect.work_order_id];
    const observation = recoverySettlementObservation(
      workOrder,
      effect,
      runtimeActor,
      evidence,
      probeReceiptRef,
    );
    const result = await observationBoundary.execute(optionalSignal({
      observation,
      authentication: observationAuthentication,
    }, signal));
    return deepFreeze({
      reactor_contract_version: 1,
      status: "settled",
      effect_id: effect.effect_id,
      source: "recovery_probe",
      probe_receipt_ref: probeReceiptRef,
      result,
    });
  }

  const executeDecision = Object.freeze({
    claim: ({ projection, effect, signal }) => executeClaim(projection, effect, signal),
    requeue: ({ projection, effect, signal }) => executeRequeue(projection, effect, signal),
    send: ({ projection, effect, signal }) => executeSend(projection, effect, signal),
    lookup_worker_result: ({ projection, effect, signal }) => executeLookup(
      projection,
      effect,
      signal,
    ),
    expire_send: ({ projection, effect, signal }) => executeExpiry(
      projection,
      effect,
      signal,
    ),
    probe_delivery_unknown: ({ projection, effect, signal }) => executeProbe(
      projection,
      effect,
      signal,
    ),
  });

  async function executeOnce(input = {}) {
    assertExecutionEnabled();
    const normalizedInput = normalizeStepInput(input);
    const signal = validateAbortSignal(normalizedInput.signal);
    const requestedEffectId = normalizedInput.effect_id === undefined
      || normalizedInput.effect_id === null
      ? null
      : portableRef(normalizedInput.effect_id, "effect_id");
    const current = await replayForExecution(signal);
    const plan = derivePlan(
      current.state,
      timestamp(clock(), "clock"),
      freshClaims,
      requestedEffectId,
    );
    if (["idle", "wait"].includes(plan.decision)) {
      return deepFreeze({
        reactor_contract_version: 1,
        status: plan.decision === "idle" ? "idle" : "waiting",
        plan,
      });
    }
    const effect = current.state.outbox[plan.effect_id];
    if (!effect || effect.status !== plan.effect_status) {
      throw reactorError(
        "BUSINESS_CANONICAL_REACTOR_PLAN_STALE",
        "Canonical projection changed between plan and execution",
        { effect_id: plan.effect_id },
      );
    }
    const executor = executeDecision[plan.decision];
    if (!executor) {
      throw reactorError(
        "BUSINESS_CANONICAL_REACTOR_PLAN_INVALID",
        "Planner returned an unsupported reactor decision",
        { decision: plan.decision },
      );
    }
    const providerPolicy = DECISION_PROVIDER_POLICY[plan.decision];
    if (providerPolicy === undefined) {
      throw reactorError(
        "BUSINESS_CANONICAL_REACTOR_PLAN_INVALID",
        "Planner decision has no provider-entry policy",
        { decision: plan.decision },
      );
    }
    if (capabilities === null) {
      if (providerPolicy === "verified_presend_failure") {
        return recordVerifiedPresendFailure(
          current.state,
          effect,
          "driver_capability",
          signal,
        );
      }
      if (providerPolicy === "required") {
        throw reactorError(
          "BUSINESS_CANONICAL_REACTOR_DRIVER_UNAUTHORIZED",
          "This recovery action requires the exact authorized provider driver",
          { decision: plan.decision, effect_id: effect.effect_id },
        );
      }
    }
    return executor({
      projection: current.state,
      effect,
      signal,
    });
  }

  return deepFreeze({
    reactor_contract_version: CANONICAL_REACTOR_CONTRACT_VERSION,
    enabled,
    run_id: runId,
    capabilities: capabilities === null ? null : RECORDED_FAKE_CAPABILITIES,
    planOnce,
    executeOnce,
  });
}

module.exports = {
  CANONICAL_REACTOR_CONTRACT_VERSION,
  RECORDED_FAKE_CAPABILITIES,
  SEND_AUTHORIZATION_CONTRACT_VERSION,
  BusinessCanonicalReactorError,
  createBusinessCanonicalReactor,
  deriveBusinessCanonicalReactorPlanV1,
};
