"use strict";

// The settlement boundary authenticates evidence. This module owns the pure
// meaning of the trusted control-plane certainty fact produced from it. The
// fact is not a provider callback payload: callbacks cannot directly create a
// fact, choose a reason, or select a retry disposition.

const V2_SETTLEMENT_CERTAINTY_FACT_VERSION = 2;

const V2_SETTLEMENT_SOURCES = Object.freeze([
  // Callback-owned, fencing-bound result evidence.
  "worker_result",
  // Receipt-backed inspection by exact mutation key.
  "recovery_probe",
  // Durable engine facts such as preflight failure or sending-lease expiry.
  "control_plane",
]);

const V2_SETTLEMENT_CLASSIFICATIONS = Object.freeze([
  "accepted",
  "not_sent",
  "delivery_unknown",
]);

const V2_SETTLEMENT_REASONS = Object.freeze([
  "provider_acknowledged",
  "provider_rejected_no_mutation",
  "provider_boundary_not_entered",
  "provider_deferred_no_mutation",
  "packet_integrity_failed",
  "authority_failed",
  "driver_capability_failed",
  "worker_transport_ambiguous",
  "worker_send_expired",
  "recovery_probe_found",
  "recovery_probe_authoritative_absence",
  "recovery_probe_inconclusive",
]);

const V2_PRESEND_FAILURE_REASONS = Object.freeze([
  "packet_integrity_failed",
  "authority_failed",
  "driver_capability_failed",
]);

const V2_SETTLEMENT_DISPOSITIONS = Object.freeze([
  "terminal",
  "retry_candidate",
  "reconciliation_required",
  "operator_attention",
]);

const V2_SETTLEMENT_RETRY_SCOPES = Object.freeze([
  "none",
  "effect_generation",
]);

const V2_SETTLEMENT_RETRY_MODES = Object.freeze([
  "none",
  "automatic",
  "explicit",
]);

const V2_SETTLEMENT_EFFECT_STAGES = Object.freeze({
  "provider.thread.create": "thread_create",
  "provider.turn.start": "turn_start",
  "provider.user_input.submit": "user_input_submit",
  "provider.turn.cancel": "turn_cancel",
});

const CERTAINTY_FACT_FIELDS = Object.freeze([
  "certainty_fact_version",
  "effect_contract_version",
  "effect_kind",
  "effect_stage",
  "settlement_source",
  "classification",
  "reason",
]);
const SETTLEMENT_POLICY_FIELDS = Object.freeze([
  "policy_version",
  ...CERTAINTY_FACT_FIELDS,
  "disposition",
  "retry",
]);
const RETRY_FIELDS = Object.freeze(["scope", "mode"]);
const RETRY_SCHEDULE_FIELDS = Object.freeze([
  "settlement_policy",
  "retry_policy",
  "completed_generation",
  "settled_at",
  "attempt_deadline_at",
  "work_order_deadline_at",
]);

const SOURCE_SET = new Set(V2_SETTLEMENT_SOURCES);
const CLASSIFICATION_SET = new Set(V2_SETTLEMENT_CLASSIFICATIONS);
const REASON_SET = new Set(V2_SETTLEMENT_REASONS);
const START_STAGE_SET = new Set(["thread_create", "turn_start"]);

// These rules are deliberately semantic rather than a collection of transport
// error codes. Adding a provider must translate its evidence into one of these
// bounded reasons before the shared policy can interpret it.
const REASON_RULES = deepFreeze({
  provider_acknowledged: {
    settlement_source: "worker_result",
    classification: "accepted",
    disposition: "terminal",
    retry_mode: "none",
  },
  provider_rejected_no_mutation: {
    settlement_source: "worker_result",
    classification: "not_sent",
    // A provider rejection is authoritative no-mutation evidence, but repeating
    // the same rejected operation is never an automatic scheduler decision.
    disposition: "retry_candidate",
    retry_mode: "explicit",
  },
  provider_boundary_not_entered: {
    settlement_source: "worker_result",
    classification: "not_sent",
    disposition: "retry_candidate",
    retry_mode: "stage_default",
  },
  provider_deferred_no_mutation: {
    settlement_source: "worker_result",
    classification: "not_sent",
    disposition: "retry_candidate",
    retry_mode: "stage_default",
  },
  // These are trusted control-plane failures, never worker/provider settlement
  // claims. Even when no provider mutation was sent, retrying cannot repair a
  // broken packet, authority, or driver contract.
  packet_integrity_failed: {
    settlement_source: "control_plane",
    classification: "not_sent",
    disposition: "operator_attention",
    retry_mode: "none",
  },
  authority_failed: {
    settlement_source: "control_plane",
    classification: "not_sent",
    disposition: "operator_attention",
    retry_mode: "none",
  },
  driver_capability_failed: {
    settlement_source: "control_plane",
    classification: "not_sent",
    disposition: "operator_attention",
    retry_mode: "none",
  },
  worker_transport_ambiguous: {
    settlement_source: "worker_result",
    classification: "delivery_unknown",
    disposition: "reconciliation_required",
    retry_mode: "none",
  },
  worker_send_expired: {
    // Lease expiry is derived by the durable control plane. A late worker may
    // provide evidence, but it cannot author this transition.
    settlement_source: "control_plane",
    classification: "delivery_unknown",
    disposition: "reconciliation_required",
    retry_mode: "none",
  },
  recovery_probe_found: {
    settlement_source: "recovery_probe",
    classification: "accepted",
    disposition: "terminal",
    retry_mode: "none",
  },
  recovery_probe_authoritative_absence: {
    settlement_source: "recovery_probe",
    classification: "not_sent",
    // A probe resolves ambiguity for one effect. It permits an explicit new
    // generation, but must not discard an accepted thread by automatically
    // reopening the whole branch attempt.
    disposition: "retry_candidate",
    retry_mode: "explicit",
  },
  recovery_probe_inconclusive: {
    settlement_source: "recovery_probe",
    classification: "delivery_unknown",
    disposition: "reconciliation_required",
    retry_mode: "none",
  },
});

class BusinessSettlementPolicyError extends TypeError {
  constructor(path, reason, message, details = {}) {
    super(`${path}: ${message}`);
    this.name = "BusinessSettlementPolicyError";
    this.code = "BUSINESS_SETTLEMENT_POLICY_INVALID";
    this.path = path;
    this.reason = reason;
    this.details = deepFreeze({ ...details });
  }
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function invalid(path, reason, message, details) {
  throw new BusinessSettlementPolicyError(path, reason, message, details);
}

function exactDataObject(input, expectedFields, path) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    invalid(path, "object", "must be a plain data object");
  }

  let prototype;
  let keys;
  try {
    prototype = Object.getPrototypeOf(input);
    keys = Reflect.ownKeys(input);
  } catch {
    invalid(path, "object", "must be an inspectable plain data object");
  }
  if (prototype !== Object.prototype && prototype !== null) {
    invalid(path, "object", "must be a plain data object");
  }

  const expected = new Set(expectedFields);
  const unknown = keys.filter((key) => typeof key !== "string" || !expected.has(key));
  if (unknown.length !== 0) {
    invalid(path, "unknown_field", "contains fields outside the V2 certainty fact");
  }
  const missing = expectedFields.filter((field) => !keys.includes(field));
  if (missing.length !== 0) {
    invalid(`${path}.${missing[0]}`, "missing_field", "is required");
  }

  const result = {};
  for (const field of expectedFields) {
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(input, field);
    } catch {
      invalid(`${path}.${field}`, "data_property", "must be an inspectable data property");
    }
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      invalid(`${path}.${field}`, "data_property", "must be a data property, not an accessor");
    }
    result[field] = descriptor.value;
  }
  return result;
}

function exactInteger(value, expected, path, reason = "version") {
  if (!Number.isSafeInteger(value) || value !== expected) {
    invalid(path, reason, `must be exactly ${expected}`, { expected, actual: value ?? null });
  }
  return value;
}

function exactEnum(value, allowed, path) {
  if (typeof value !== "string" || !allowed.has(value)) {
    invalid(path, "unknown_value", "is not a supported V2 value", {
      actual: typeof value === "string" ? value : null,
    });
  }
  return value;
}

function exactTimestamp(value, path) {
  if (typeof value !== "string"
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
      || Number.isNaN(Date.parse(value))
      || new Date(value).toISOString() !== value) {
    invalid(path, "timestamp", "must be a canonical millisecond UTC timestamp");
  }
  return value;
}

function retryModeFor(rule, effectStage) {
  if (rule.retry_mode !== "stage_default") return rule.retry_mode;
  return START_STAGE_SET.has(effectStage) ? "automatic" : "explicit";
}

function deriveSettlementDispositionV2(input) {
  const fact = exactDataObject(input, CERTAINTY_FACT_FIELDS, "certainty_fact");
  exactInteger(
    fact.certainty_fact_version,
    V2_SETTLEMENT_CERTAINTY_FACT_VERSION,
    "certainty_fact.certainty_fact_version",
  );
  // V1 and unversioned effects remain replay-only. This policy never upgrades
  // or guesses their settlement meaning.
  exactInteger(
    fact.effect_contract_version,
    2,
    "certainty_fact.effect_contract_version",
    "effect_contract_version",
  );

  const settlementSource = exactEnum(
    fact.settlement_source,
    SOURCE_SET,
    "certainty_fact.settlement_source",
  );
  const classification = exactEnum(
    fact.classification,
    CLASSIFICATION_SET,
    "certainty_fact.classification",
  );
  const reason = exactEnum(fact.reason, REASON_SET, "certainty_fact.reason");
  const expectedStage = V2_SETTLEMENT_EFFECT_STAGES[fact.effect_kind];
  if (!expectedStage) {
    invalid(
      "certainty_fact.effect_kind",
      "unknown_value",
      "is not a supported mutating Effect V2 kind",
      { actual: typeof fact.effect_kind === "string" ? fact.effect_kind : null },
    );
  }
  if (fact.effect_stage !== expectedStage) {
    invalid(
      "certainty_fact.effect_stage",
      "effect_stage_mismatch",
      "does not match the immutable Effect V2 kind",
      { effect_kind: fact.effect_kind, expected: expectedStage, actual: fact.effect_stage ?? null },
    );
  }

  const rule = REASON_RULES[reason];
  if (settlementSource !== rule.settlement_source) {
    invalid(
      "certainty_fact.reason",
      "source_reason_mismatch",
      "is not authoritative for this settlement source",
      { settlement_source: settlementSource, reason },
    );
  }
  if (classification !== rule.classification) {
    invalid(
      "certainty_fact.classification",
      "classification_reason_mismatch",
      "does not match the bounded certainty reason",
      { classification, reason, expected: rule.classification },
    );
  }

  const disposition = rule.disposition;
  const retryMode = retryModeFor(rule, expectedStage);
  const retryScope = disposition === "retry_candidate"
    ? "effect_generation"
    : "none";

  return deepFreeze({
    policy_version: 3,
    certainty_fact_version: V2_SETTLEMENT_CERTAINTY_FACT_VERSION,
    effect_contract_version: 2,
    effect_kind: fact.effect_kind,
    effect_stage: expectedStage,
    settlement_source: settlementSource,
    classification,
    reason,
    disposition,
    retry: {
      scope: retryScope,
      mode: retryMode,
    },
  });
}

function normalizeSettlementPolicyRecordV2(input) {
  const record = exactDataObject(input, SETTLEMENT_POLICY_FIELDS, "settlement_policy");
  exactInteger(record.policy_version, 3, "settlement_policy.policy_version");
  const retry = exactDataObject(record.retry, RETRY_FIELDS, "settlement_policy.retry");
  const derived = deriveSettlementDispositionV2(
    Object.fromEntries(CERTAINTY_FACT_FIELDS.map((field) => [field, record[field]])),
  );
  if (record.disposition !== derived.disposition
      || retry.scope !== derived.retry.scope
      || retry.mode !== derived.retry.mode) {
    invalid(
      "settlement_policy",
      "semantic_mismatch",
      "does not match the shared V2 certainty semantics",
    );
  }
  return derived;
}

function effectGenerationRetryDelayV2(settlementPolicy, retryPolicy, completedGeneration) {
  const policy = normalizeSettlementPolicyRecordV2(settlementPolicy);
  if (policy.disposition !== "retry_candidate"
      || policy.retry.scope !== "effect_generation") {
    invalid(
      "settlement_policy.retry.scope",
      "retry_scope",
      "must authorize an Effect-generation successor",
    );
  }
  if (!Number.isSafeInteger(completedGeneration) || completedGeneration < 1) {
    invalid(
      "completed_generation",
      "integer",
      "must be a positive Effect generation",
    );
  }
  const candidate = exactDataObject(
    retryPolicy,
    ["backoff_initial_ms", "backoff_max_ms", "max_attempts"],
    "retry_policy",
  );
  for (const field of ["backoff_initial_ms", "backoff_max_ms", "max_attempts"]) {
    if (!Number.isSafeInteger(candidate[field]) || candidate[field] < 0) {
      invalid(`retry_policy.${field}`, "integer", "must be a non-negative integer");
    }
  }
  if (candidate.max_attempts < 1 || candidate.backoff_max_ms < candidate.backoff_initial_ms) {
    invalid("retry_policy", "range", "contains an invalid generation retry bound");
  }
  if (policy.retry.mode === "explicit" || candidate.backoff_initial_ms === 0) return 0;
  return Math.min(
    candidate.backoff_initial_ms * (2 ** Math.max(0, completedGeneration - 1)),
    candidate.backoff_max_ms,
  );
}

function deriveEffectGenerationRetryScheduleV2(input) {
  const candidate = exactDataObject(input, RETRY_SCHEDULE_FIELDS, "retry_schedule");
  const policy = normalizeSettlementPolicyRecordV2(candidate.settlement_policy);
  const settledAt = exactTimestamp(candidate.settled_at, "retry_schedule.settled_at");
  const attemptDeadlineAt = exactTimestamp(
    candidate.attempt_deadline_at,
    "retry_schedule.attempt_deadline_at",
  );
  const workOrderDeadlineAt = exactTimestamp(
    candidate.work_order_deadline_at,
    "retry_schedule.work_order_deadline_at",
  );
  const delayMs = effectGenerationRetryDelayV2(
    policy,
    candidate.retry_policy,
    candidate.completed_generation,
  );
  const eligibleTime = Date.parse(settledAt) + delayMs;
  if (!Number.isSafeInteger(eligibleTime)) {
    invalid("retry_schedule.eligible_at", "range", "falls outside the supported time range");
  }
  const eligibleAt = new Date(eligibleTime).toISOString();
  const nextGeneration = candidate.completed_generation + 1;
  const retryPolicy = exactDataObject(
    candidate.retry_policy,
    ["backoff_initial_ms", "backoff_max_ms", "max_attempts"],
    "retry_policy",
  );
  return deepFreeze({
    eligible_at: eligibleAt,
    delay_ms: delayMs,
    next_generation: nextGeneration,
    automatic: policy.retry.mode === "automatic",
    permitted: Number.isSafeInteger(nextGeneration)
      && nextGeneration <= retryPolicy.max_attempts
      && eligibleTime < Date.parse(attemptDeadlineAt)
      && eligibleTime < Date.parse(workOrderDeadlineAt),
  });
}

// Predicates intentionally accept the trusted certainty fact, not an object
// carrying a caller-selected disposition. Consumers that already derived the
// result can use its frozen retry view directly.
function isGenerationSuccessorCandidateV2(certaintyFact) {
  return deriveSettlementDispositionV2(certaintyFact)
    .retry.scope === "effect_generation";
}

function isAutomaticEffectGenerationCandidateV2(certaintyFact) {
  return deriveSettlementDispositionV2(certaintyFact)
    .retry.mode === "automatic";
}

module.exports = {
  BusinessSettlementPolicyError,
  V2_SETTLEMENT_CERTAINTY_FACT_VERSION,
  V2_SETTLEMENT_CLASSIFICATIONS,
  V2_SETTLEMENT_DISPOSITIONS,
  V2_SETTLEMENT_EFFECT_STAGES,
  V2_SETTLEMENT_REASONS,
  V2_PRESEND_FAILURE_REASONS,
  V2_SETTLEMENT_RETRY_MODES,
  V2_SETTLEMENT_RETRY_SCOPES,
  V2_SETTLEMENT_SOURCES,
  deriveEffectGenerationRetryScheduleV2,
  deriveSettlementDispositionV2,
  effectGenerationRetryDelayV2,
  isAutomaticEffectGenerationCandidateV2,
  isGenerationSuccessorCandidateV2,
  normalizeSettlementPolicyRecordV2,
};
