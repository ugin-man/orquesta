"use strict";

const { canonicalHash, canonicalJson } = require("@orquesta/contracts");
const {
  BUSINESS_ENGINE_CONTRACT_VERSION,
  EFFECT_PRESEND_FAILURE_OBSERVATION_NAMES,
  EFFECT_SEND_EXPIRY_OBSERVATION_NAMES,
  EFFECT_SETTLEMENT_OBSERVATION_NAMES,
  RUNTIME_OBSERVATION_NAMES,
  normalizeBusinessRuntimeObservationEnvelope,
  normalizeBusinessWorkOrderPlanV1,
} = require("./contract");
const {
  BUSINESS_EVENT_TYPES,
  OUTBOX_IMMUTABLE_FIELDS,
  businessProjectionConfigurationV1,
  projectBusinessEventV1,
} = require("./projector");
const {
  deriveSettlementDispositionV2,
  normalizeSettlementPolicyRecordV2,
} = require("./settlement-policy");
const { decideWorkOrderV1 } = require("./state-machine");

const BUSINESS_EVENT_TYPE_SET = new Set(BUSINESS_EVENT_TYPES);
const RECEIPT_TYPES = new Set([
  "business.command.received",
  "business.observation.received",
  "business.provider_settlement.received",
  "business.internal_action.received",
]);
const EVENT_ACTOR_TYPES = new Set(["agent", "user", "system"]);
const OBSERVATION_PRINCIPAL_TYPES = Object.freeze({
  runtime: new Set(["agent", "system"]),
  provider: new Set(["agent", "system"]),
  verifier: new Set(["agent", "user", "system"]),
});
const RECEIPT_NOT_FOUND = Symbol("business-observation-receipt-not-found");
const PROVIDER_SETTLEMENT_SOURCE_TYPE = "provider_settlement";
const PROVIDER_SETTLEMENT_RECEIPT_EVENT = "business.provider_settlement.received";
const AUTHORITY_FIELDS = new Set([
  "authorized",
  "principal_type",
  "principal_id",
  "project_ref",
  "work_order_id",
  "plan_snapshot_ref",
  "plan_hash",
  "allowed_observation_names",
  "allowed_branch_refs",
  "allowed_provider_refs",
  "allowed_verifier_refs",
]);
const OUTBOX_EFFECT_IDENTITY_FIELDS = OUTBOX_IMMUTABLE_FIELDS;
const DELIVERY_OBSERVATIONS = new Set([
  "provider.effect.delivery.recorded",
  "branch.dispatch.accepted",
  "branch.dispatch.not_sent",
  "branch.delivery_unknown",
]);
const DELIVERY_ATTESTATION_FIELDS = new Set([
  "effect_id",
  "idempotency_key",
  "provider_ref",
  "classification",
  "runtime_identity",
  "evidence_refs",
]);
const EFFECT_SETTLEMENT_OBSERVATION_NAME = EFFECT_SETTLEMENT_OBSERVATION_NAMES[0];
const EFFECT_SEND_EXPIRY_OBSERVATION_NAME = EFFECT_SEND_EXPIRY_OBSERVATION_NAMES[0];
const EFFECT_PRESEND_FAILURE_OBSERVATION_NAME = EFFECT_PRESEND_FAILURE_OBSERVATION_NAMES[0];
const SETTLEMENT_ATTESTATION_COMMON_FIELDS = Object.freeze([
  "effect_id",
  "idempotency_key",
  "provider_ref",
  "classification",
  "settlement_source",
  "runtime_identity",
  "evidence_refs",
]);
const WORKER_SETTLEMENT_ATTESTATION_FIELDS = new Set([
  ...SETTLEMENT_ATTESTATION_COMMON_FIELDS,
  "worker_fencing_token",
  "worker_result_ref",
]);
const RECOVERY_PROBE_SETTLEMENT_ATTESTATION_FIELDS = new Set([
  ...SETTLEMENT_ATTESTATION_COMMON_FIELDS,
  "recovery_probe",
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
const WORKER_FENCING_TOKEN_FIELDS = new Set(["lease_id", "owner_id", "generation"]);
const RECOVERY_PROBE_FIELDS = new Set([
  "probe_receipt_ref",
  "mutation_idempotency_key",
]);
const CONTENT_ADDRESS_REF_FIELDS = new Set(["id", "hash"]);
// Historical envelopes remain available to the pure engine and exact receipt
// replay. Only the V2 settlement successor may enter live provider ingress: it
// carries the callback's own fencing token (or a content-addressed recovery
// probe) instead of borrowing the lease currently visible in the projection.
// This is intentionally an allowlist, not the complement of a denylist. A new
// observation contract must opt into live ingress explicitly; otherwise it is
// historical/replay-only by default.
const LIVE_RUNTIME_OBSERVATION_NAMES = Object.freeze([
  "work_order.cancelled",
  "branch.timed_out",
  "verification.recorded",
  "review.recorded",
  EFFECT_SETTLEMENT_OBSERVATION_NAME,
  EFFECT_SEND_EXPIRY_OBSERVATION_NAME,
  EFFECT_PRESEND_FAILURE_OBSERVATION_NAME,
]);
const LIVE_RUNTIME_OBSERVATION_NAME_SET = new Set(LIVE_RUNTIME_OBSERVATION_NAMES);
const SUPPORTED_OBSERVATION_NAMES = Object.freeze([
  ...RUNTIME_OBSERVATION_NAMES,
  ...EFFECT_SETTLEMENT_OBSERVATION_NAMES,
  ...EFFECT_SEND_EXPIRY_OBSERVATION_NAMES,
  ...EFFECT_PRESEND_FAILURE_OBSERVATION_NAMES,
]);
const WITHHELD_LIVE_OBSERVATIONS = new Set(
  SUPPORTED_OBSERVATION_NAMES.filter((name) => !LIVE_RUNTIME_OBSERVATION_NAME_SET.has(name)),
);
const NONQUIESCENT_OUTBOX_STATES = new Set([
  "pending",
  "claimed",
  "sending",
  "delivery_unknown",
]);
const VERIFIER_OBSERVATIONS = new Set([
  "verification.recorded",
  "review.recorded",
]);
const PROVIDER_SCOPED_OBSERVATIONS = new Set([
  EFFECT_SETTLEMENT_OBSERVATION_NAME,
  EFFECT_SEND_EXPIRY_OBSERVATION_NAME,
  EFFECT_PRESEND_FAILURE_OBSERVATION_NAME,
  "provider.effect.delivery.recorded",
  "branch.dispatch.accepted",
  "branch.dispatch.not_sent",
  "branch.progress",
  "branch.result.submitted",
  "branch.failed",
  "branch.timed_out",
  "branch.delivery_unknown",
  "branch.cancelled",
  "user_input.requested",
  "provider.rate_limited",
  "provider.unavailable",
]);
const COMMON_FACT_FIELDS = ["observation_evidence_refs"];
const OBSERVATION_FACT_FIELDS = Object.freeze({
  "work_order.started": new Set(COMMON_FACT_FIELDS),
  "work_order.cancelled": new Set(COMMON_FACT_FIELDS),
  "provider.effect.delivery.recorded": new Set([
    ...COMMON_FACT_FIELDS,
    "provider_ref",
    "runtime_identity",
    "delivery_attestation",
    "reconciliation_resolution_ref",
    "retry_dispatch_packets",
    "cancel_packets",
    "attention_detail_ref",
  ]),
  "branch.dispatch.accepted": new Set([
    ...COMMON_FACT_FIELDS,
    "provider_ref",
    "runtime_identity",
    "delivery_attestation",
    "reconciliation_resolution_ref",
  ]),
  "branch.dispatch.not_sent": new Set([
    ...COMMON_FACT_FIELDS,
    "provider_ref",
    "retry_dispatch_packets",
    "reconciliation_resolution_ref",
    "delivery_attestation",
  ]),
  "branch.progress": new Set([...COMMON_FACT_FIELDS, "provider_ref"]),
  "branch.result.submitted": new Set([...COMMON_FACT_FIELDS, "provider_ref"]),
  "branch.failed": new Set([...COMMON_FACT_FIELDS, "provider_ref"]),
  "branch.timed_out": new Set([
    ...COMMON_FACT_FIELDS,
    "provider_ref",
    "cancel_packets",
    "attention_detail_ref",
  ]),
  "branch.delivery_unknown": new Set([
    ...COMMON_FACT_FIELDS,
    "provider_ref",
    "attention_detail_ref",
    "reconciliation_resolution_ref",
    "delivery_attestation",
  ]),
  "branch.cancelled": new Set([...COMMON_FACT_FIELDS, "provider_ref", "runtime_identity"]),
  "user_input.requested": new Set([...COMMON_FACT_FIELDS, "provider_ref", "current_attempt"]),
  "verification.recorded": new Set([
    ...COMMON_FACT_FIELDS,
    "verifier_ref",
    "current_result_hash",
  ]),
  "review.recorded": new Set([
    ...COMMON_FACT_FIELDS,
    "verifier_ref",
    "current_result_hash",
  ]),
  "provider.rate_limited": new Set([
    ...COMMON_FACT_FIELDS,
    "provider_ref",
    "attention_detail_ref",
  ]),
  "provider.unavailable": new Set([
    ...COMMON_FACT_FIELDS,
    "provider_ref",
    "attention_detail_ref",
  ]),
  [EFFECT_SETTLEMENT_OBSERVATION_NAME]: new Set([
    ...COMMON_FACT_FIELDS,
    "provider_ref",
    "runtime_identity",
    "settlement_attestation",
    "settlement_certainty_fact",
    "reconciliation_resolution_ref",
    "retry_dispatch_packets",
    "cancel_packets",
    "attention_detail_ref",
  ]),
  [EFFECT_SEND_EXPIRY_OBSERVATION_NAME]: new Set([
    ...COMMON_FACT_FIELDS,
    "provider_ref",
    "attention_detail_ref",
  ]),
  [EFFECT_PRESEND_FAILURE_OBSERVATION_NAME]: new Set([
    ...COMMON_FACT_FIELDS,
    "provider_ref",
    "presend_failure_attestation",
  ]),
});
const REQUIRED_OBSERVATION_FACT_FIELDS = Object.freeze({
  "work_order.started": new Set(COMMON_FACT_FIELDS),
  "work_order.cancelled": new Set(COMMON_FACT_FIELDS),
  "provider.effect.delivery.recorded": new Set([...COMMON_FACT_FIELDS, "provider_ref"]),
  "branch.dispatch.accepted": new Set([...COMMON_FACT_FIELDS, "provider_ref", "runtime_identity"]),
  "branch.dispatch.not_sent": new Set([...COMMON_FACT_FIELDS, "provider_ref"]),
  "branch.progress": new Set([...COMMON_FACT_FIELDS, "provider_ref"]),
  "branch.result.submitted": new Set([...COMMON_FACT_FIELDS, "provider_ref"]),
  "branch.failed": new Set([...COMMON_FACT_FIELDS, "provider_ref"]),
  "branch.timed_out": new Set([...COMMON_FACT_FIELDS, "provider_ref"]),
  "branch.delivery_unknown": new Set([
    ...COMMON_FACT_FIELDS,
    "provider_ref",
    "attention_detail_ref",
  ]),
  "branch.cancelled": new Set([...COMMON_FACT_FIELDS, "provider_ref"]),
  "user_input.requested": new Set([...COMMON_FACT_FIELDS, "provider_ref", "current_attempt"]),
  "verification.recorded": new Set([
    ...COMMON_FACT_FIELDS,
    "verifier_ref",
    "current_result_hash",
  ]),
  "review.recorded": new Set([
    ...COMMON_FACT_FIELDS,
    "verifier_ref",
    "current_result_hash",
  ]),
  "provider.rate_limited": new Set([
    ...COMMON_FACT_FIELDS,
    "provider_ref",
    "attention_detail_ref",
  ]),
  "provider.unavailable": new Set([
    ...COMMON_FACT_FIELDS,
    "provider_ref",
    "attention_detail_ref",
  ]),
  [EFFECT_SETTLEMENT_OBSERVATION_NAME]: new Set([
    ...COMMON_FACT_FIELDS,
    "provider_ref",
    "settlement_attestation",
    "settlement_certainty_fact",
  ]),
  [EFFECT_SEND_EXPIRY_OBSERVATION_NAME]: new Set([
    ...COMMON_FACT_FIELDS,
    "provider_ref",
    "attention_detail_ref",
  ]),
  [EFFECT_PRESEND_FAILURE_OBSERVATION_NAME]: new Set([
    ...COMMON_FACT_FIELDS,
    "provider_ref",
    "presend_failure_attestation",
  ]),
});

class BusinessObservationBoundaryError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "BusinessObservationBoundaryError";
    this.code = code;
    this.details = details;
  }
}

function boundaryError(code, message, details) {
  return new BusinessObservationBoundaryError(code, message, details);
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

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function canonicalClone(value, code = "BUSINESS_OBSERVATION_FACTS_UNVERIFIED") {
  try {
    const serialized = canonicalJson(value);
    if (Buffer.byteLength(serialized, "utf8") > 1_048_576) {
      throw boundaryError(code, "Value exceeds the one-megabyte boundary limit");
    }
    return JSON.parse(serialized);
  } catch (error) {
    if (error instanceof BusinessObservationBoundaryError) throw error;
    throw boundaryError(code, "Value must be bounded canonical JSON", {
      cause_code: error?.code || null,
    });
  }
}

function portableRef(value, path) {
  if (typeof value !== "string"
      || value.trim() === ""
      || value.trim() !== value
      || Buffer.byteLength(value, "utf8") > 256
      || !/^[A-Za-z0-9][A-Za-z0-9._:/@+\-]*$/u.test(value)) {
    throw boundaryError("BUSINESS_OBSERVATION_SCOPE_INVALID", `${path} is not a portable reference`);
  }
  return value;
}

function sha256(value, path) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw boundaryError("BUSINESS_OBSERVATION_SCOPE_INVALID", `${path} is not a SHA-256 hash`);
  }
  return value;
}

function validateDependency(condition, name) {
  if (!condition) throw new TypeError(`${name} is required`);
}

function validateSignal(signal) {
  if (signal === undefined) return null;
  if (!signal || typeof signal.aborted !== "boolean"
      || typeof signal.addEventListener !== "function"
      || typeof signal.removeEventListener !== "function") {
    throw new TypeError("signal must be an AbortSignal");
  }
  return signal;
}

async function invokeReadDependency(name, operation, parentSignal, timeoutMs) {
  if (parentSignal?.aborted) {
    throw boundaryError("BUSINESS_OBSERVATION_ABORTED", "Observation request was aborted", {
      dependency: name,
    });
  }
  const controller = new AbortController();
  let timeout = null;
  let rejectAbort;
  const aborted = new Promise((resolve, reject) => {
    void resolve;
    rejectAbort = reject;
  });
  const onParentAbort = () => {
    controller.abort(parentSignal.reason);
    rejectAbort(boundaryError(
      "BUSINESS_OBSERVATION_ABORTED",
      "Observation request was aborted",
      { dependency: name },
    ));
  };
  if (parentSignal) parentSignal.addEventListener("abort", onParentAbort, { once: true });
  timeout = setTimeout(() => {
    controller.abort(new Error(`dependency timeout: ${name}`));
    rejectAbort(boundaryError(
      "BUSINESS_OBSERVATION_DEPENDENCY_TIMEOUT",
      "Observation dependency timed out",
      { dependency: name, timeout_ms: timeoutMs },
    ));
  }, timeoutMs);
  timeout.unref?.();
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      aborted,
    ]);
  } finally {
    clearTimeout(timeout);
    if (parentSignal) parentSignal.removeEventListener("abort", onParentAbort);
  }
}

function validateClockValue(value) {
  if (typeof value !== "string"
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
      || Number.isNaN(new Date(value).getTime())
      || new Date(value).toISOString() !== value) {
    throw boundaryError(
      "BUSINESS_OBSERVATION_CLOCK_INVALID",
      "Observation clock must return a real millisecond UTC timestamp",
    );
  }
  return value;
}

function normalizePrincipal(value) {
  if (!isPlainObject(value)
      || !EVENT_ACTOR_TYPES.has(value.type)
      || typeof value.id !== "string"
      || value.id.trim() === ""
      || value.id.trim() !== value.id
      || Buffer.byteLength(value.id, "utf8") > 256) {
    throw boundaryError(
      "BUSINESS_OBSERVATION_AUTHENTICATION_INVALID",
      "Authenticator returned an invalid principal binding",
    );
  }
  return Object.freeze({ type: value.type, id: value.id });
}

function validateActorBinding(observation, principal) {
  const allowed = OBSERVATION_PRINCIPAL_TYPES[observation.actor.type];
  if (!allowed
      || !allowed.has(principal.type)
      || observation.actor.actor_id !== principal.id) {
    throw boundaryError(
      "BUSINESS_OBSERVATION_ACTOR_BINDING_MISMATCH",
      "The asserted observation actor does not match the authenticated principal",
    );
  }
}

async function authenticate(authorizer, authentication, signal, timeoutMs) {
  let authenticated;
  try {
    authenticated = await invokeReadDependency(
      "authorizer.authenticate",
      (dependencySignal) => authorizer.authenticate({
        authentication,
        signal: dependencySignal,
      }),
      signal,
      timeoutMs,
    );
  } catch (error) {
    if (error instanceof BusinessObservationBoundaryError) throw error;
    throw boundaryError(
      "BUSINESS_OBSERVATION_AUTHENTICATION_FAILED",
      "Observation authentication failed",
      { cause_code: error?.code || null },
    );
  }
  if (!authenticated) {
    throw boundaryError(
      "BUSINESS_OBSERVATION_AUTHENTICATION_FAILED",
      "Observation authentication failed",
    );
  }
  return normalizePrincipal(authenticated.principal || authenticated);
}

function projectorConfiguration() {
  return businessProjectionConfigurationV1();
}

function normalizeProjection(replay) {
  if (!isPlainObject(replay)
      || !isPlainObject(replay.state)
      || !isPlainObject(replay.watermark)
      || !Number.isSafeInteger(replay.watermark.journal_sequence)
      || replay.watermark.journal_sequence < 0
      || !isPlainObject(replay.state.work_orders)
      || !isPlainObject(replay.state.command_receipts)
      || !isPlainObject(replay.state.observation_receipts)
      || !isPlainObject(replay.state.internal_receipts)
      || !isPlainObject(replay.state.outbox)) {
    throw boundaryError(
      "BUSINESS_OBSERVATION_PROJECTION_INVALID",
      "EventStore replay returned an invalid Business projection",
    );
  }
  if (replay.state.schema_version !== 2
      || !Object.hasOwn(replay.state, "provider_settlement_epoch")) {
    throw boundaryError(
      "BUSINESS_OBSERVATION_PROJECTION_INVALID",
      "EventStore replay must expose the canonical Business projection schema and cutover epoch",
    );
  }
  return replay;
}

async function replayProjection(eventStore, projectionConfig, signal, timeoutMs) {
  try {
    return normalizeProjection(await invokeReadDependency(
      "eventStore.replay",
      () => eventStore.replay(projectionConfig),
      signal,
      timeoutMs,
    ));
  } catch (error) {
    if (error instanceof BusinessObservationBoundaryError) throw error;
    throw boundaryError(
      "BUSINESS_OBSERVATION_PROJECTION_FAILED",
      "Business projection replay failed",
      { cause_code: error?.code || null },
    );
  }
}

function normalizedPlan(workOrder, observation) {
  if (!isPlainObject(workOrder) || !Object.hasOwn(workOrder, "plan")) {
    throw boundaryError(
      "BUSINESS_OBSERVATION_WORK_ORDER_INVALID",
      "Work Order projection does not retain its normalized plan",
    );
  }
  let plan;
  try {
    plan = normalizeBusinessWorkOrderPlanV1(workOrder.plan);
  } catch (error) {
    throw boundaryError(
      "BUSINESS_OBSERVATION_PLAN_INVALID",
      "Retained Work Order plan is invalid",
      { cause_code: error?.code || null },
    );
  }
  if (workOrder.work_order_id !== observation.work_order_id
      || workOrder.plan_snapshot_ref !== observation.plan_snapshot_ref
      || workOrder.plan_hash !== observation.plan_hash
      || plan.plan_snapshot_id !== observation.plan_snapshot_ref
      || plan.plan_hash !== observation.plan_hash) {
    throw boundaryError(
      "BUSINESS_OBSERVATION_PLAN_BINDING_MISMATCH",
      "Observation does not bind the authoritative Work Order and immutable plan",
    );
  }
  return plan;
}

async function resolveProject(resolvers, plan, principal, signal, timeoutMs) {
  let project;
  try {
    project = await invokeReadDependency(
      "resolvers.resolveProject",
      (dependencySignal) => resolvers.resolveProject({
        project_ref: plan.project_ref,
        principal,
        signal: dependencySignal,
      }),
      signal,
      timeoutMs,
    );
  } catch (error) {
    if (error instanceof BusinessObservationBoundaryError) throw error;
    throw boundaryError(
      "BUSINESS_OBSERVATION_PROJECT_RESOLUTION_FAILED",
      "Observation project resolution failed",
      { cause_code: error?.code || null },
    );
  }
  if (!isPlainObject(project)) {
    throw boundaryError("BUSINESS_OBSERVATION_PROJECT_NOT_FOUND", "Project was not found");
  }
  if ((project.project_ref ?? project.id) !== plan.project_ref) {
    throw boundaryError(
      "BUSINESS_OBSERVATION_PROJECT_BINDING_MISMATCH",
      "Resolved project does not match the immutable plan",
    );
  }
  return project;
}

function branchFor(workOrder, observation) {
  if (!Object.hasOwn(observation.payload, "branch_ref")) return null;
  const branch = workOrder.branches?.[observation.payload.branch_ref];
  if (!isPlainObject(branch)) {
    // Unknown branches are deliberately left to the official decider so they
    // become durable quarantined facts, but they receive no provider scope.
    return null;
  }
  return branch;
}

async function resolveObservationFacts(
  resolvers,
  context,
  signal,
  timeoutMs,
) {
  let value;
  try {
    value = await invokeReadDependency(
      "resolvers.resolveObservationFacts",
      (dependencySignal) => resolvers.resolveObservationFacts({
        observation: context.observation,
        work_order: context.workOrder,
        plan: context.plan,
        project: context.project,
        principal: context.principal,
        branch: context.branch,
        delivery_effect: context.deliveryEffect
          ? Object.freeze(Object.fromEntries(
            OUTBOX_EFFECT_IDENTITY_FIELDS.map((field) => [
              field,
              context.deliveryEffect[field],
            ]),
          ))
          : null,
        // Resolver attestation may bind immutable effect identity, but never
        // receives the projection's current lease. Callback provenance must
        // come from the normalized settlement envelope itself.
        settlement_effect: context.settlementEffect
          ? Object.freeze(Object.fromEntries(
            OUTBOX_EFFECT_IDENTITY_FIELDS.map((field) => [
              field,
              context.settlementEffect[field],
            ]),
          ))
          : null,
        presend_failure_effect: context.presendFailureEffect
          ? Object.freeze(Object.fromEntries(
            OUTBOX_EFFECT_IDENTITY_FIELDS.map((field) => [
              field,
              context.presendFailureEffect[field],
            ]),
          ))
          : null,
        signal: dependencySignal,
      }),
      signal,
      timeoutMs,
    );
  } catch (error) {
    if (error instanceof BusinessObservationBoundaryError) throw error;
    throw boundaryError(
      "BUSINESS_OBSERVATION_FACT_RESOLUTION_FAILED",
      "Observation fact resolution failed",
      { cause_code: error?.code || null },
    );
  }
  if (!isPlainObject(value)) {
    throw boundaryError(
      "BUSINESS_OBSERVATION_FACTS_UNVERIFIED",
      "Observation facts must be a bounded object",
    );
  }
  const facts = canonicalClone(value);
  const allowed = OBSERVATION_FACT_FIELDS[context.observation.name];
  const required = REQUIRED_OBSERVATION_FACT_FIELDS[context.observation.name];
  if (!allowed
      || Object.keys(facts).some((field) => !allowed.has(field))
      || [...required].some((field) => !Object.hasOwn(facts, field))) {
    throw boundaryError(
      "BUSINESS_OBSERVATION_FACTS_UNVERIFIED",
      "Resolved facts do not exactly match the observation's trusted fact surface",
    );
  }
  return facts;
}

function uniqueRefs(value, path) {
  if (!Array.isArray(value) || value.length > 128) {
    throw boundaryError("BUSINESS_OBSERVATION_AUTHORITY_INVALID", `${path} must be a bounded array`);
  }
  const refs = value.map((entry, index) => portableRef(entry, `${path}[${index}]`));
  if (new Set(refs).size !== refs.length) {
    throw boundaryError("BUSINESS_OBSERVATION_AUTHORITY_INVALID", `${path} must be unique`);
  }
  return refs.sort(compareText);
}

async function authorize(authorizer, context, signal, timeoutMs) {
  let value;
  const trustedScope = {
    branch_ref: context.branch?.branch_ref || null,
    provider_ref: PROVIDER_SCOPED_OBSERVATIONS.has(context.observation.name)
      ? context.branch?.provider_ref || null
      : null,
    verifier_ref: VERIFIER_OBSERVATIONS.has(context.observation.name)
      ? context.principal.id
      : null,
  };
  try {
    value = await invokeReadDependency(
      "authorizer.authorize",
      (dependencySignal) => authorizer.authorize({
        principal: context.principal,
        action: context.observation.name,
        observation: context.observation,
        work_order: context.workOrder,
        plan: context.plan,
        project: context.project,
        trusted_scope: trustedScope,
        signal: dependencySignal,
      }),
      signal,
      timeoutMs,
    );
  } catch (error) {
    if (error instanceof BusinessObservationBoundaryError) throw error;
    throw boundaryError(
      "BUSINESS_OBSERVATION_AUTHORIZATION_DENIED",
      "Observation authorization failed",
      { cause_code: error?.code || null },
    );
  }
  if (!value) {
    throw boundaryError(
      "BUSINESS_OBSERVATION_AUTHORIZATION_DENIED",
      "Observation is not authorized",
    );
  }
  if (!hasExactFields(value, AUTHORITY_FIELDS)) {
    throw boundaryError(
      "BUSINESS_OBSERVATION_AUTHORITY_INVALID",
      "Authorization must return an exact fail-closed observation authority",
    );
  }
  const authority = {
    authorized: value.authorized,
    principal_type: value.principal_type,
    principal_id: portableRef(value.principal_id, "authority.principal_id"),
    project_ref: portableRef(value.project_ref, "authority.project_ref"),
    work_order_id: portableRef(value.work_order_id, "authority.work_order_id"),
    plan_snapshot_ref: portableRef(value.plan_snapshot_ref, "authority.plan_snapshot_ref"),
    plan_hash: sha256(value.plan_hash, "authority.plan_hash"),
    allowed_observation_names: uniqueRefs(
      value.allowed_observation_names,
      "authority.allowed_observation_names",
    ),
    allowed_branch_refs: uniqueRefs(value.allowed_branch_refs, "authority.allowed_branch_refs"),
    allowed_provider_refs: uniqueRefs(
      value.allowed_provider_refs,
      "authority.allowed_provider_refs",
    ),
    allowed_verifier_refs: uniqueRefs(
      value.allowed_verifier_refs,
      "authority.allowed_verifier_refs",
    ),
  };
  const observation = context.observation;
  if (!EVENT_ACTOR_TYPES.has(authority.principal_type)) {
    throw boundaryError(
      "BUSINESS_OBSERVATION_AUTHORITY_INVALID",
      "Authorization principal_type is invalid",
    );
  }
  const bindingMatches = authority.authorized === true
    && authority.principal_type === context.principal.type
    && authority.principal_id === context.principal.id
    && authority.project_ref === context.plan.project_ref
    && authority.work_order_id === observation.work_order_id
    && authority.plan_snapshot_ref === observation.plan_snapshot_ref
    && authority.plan_hash === observation.plan_hash;
  const nameAllowed = authority.allowed_observation_names.includes(observation.name);
  const branchAllowed = context.branch === null
    ? !Object.hasOwn(observation.payload, "branch_ref")
    : authority.allowed_branch_refs.includes(context.branch.branch_ref);
  const providerAllowed = !PROVIDER_SCOPED_OBSERVATIONS.has(observation.name)
    || (context.branch !== null
      && authority.allowed_provider_refs.includes(context.branch.provider_ref));
  const verifierAllowed = !VERIFIER_OBSERVATIONS.has(observation.name)
    || (context.principal.id === observation.actor.actor_id
      && authority.allowed_verifier_refs.includes(context.principal.id));
  if (!bindingMatches || !nameAllowed || !branchAllowed || !providerAllowed || !verifierAllowed) {
    throw boundaryError(
      "BUSINESS_OBSERVATION_AUTHORIZATION_DENIED",
      "Observation is outside its exact project, Work Order, plan, branch, provider, or verifier scope",
    );
  }
  return Object.freeze(authority);
}

function deliveryEffect(projection, observation, branch) {
  const payload = observation.payload;
  const genericDelivery = observation.name === "provider.effect.delivery.recorded";
  const candidates = genericDelivery
    ? [projection.outbox[payload.effect_id]]
    : Object.values(projection.outbox);
  const matches = candidates.filter((effect) => (
    isPlainObject(effect)
      && effect.work_order_id === observation.work_order_id
      && effect.branch_ref === branch.branch_ref
      && effect.attempt === payload.attempt
      && effect.dispatch_id === payload.dispatch_id
      && effect.provider_ref === branch.provider_ref
      && (genericDelivery
        ? effect.effect_id === payload.effect_id
          && effect.effect_contract_version === payload.effect_contract_version
          && effect.effect_kind === payload.effect_kind
        : effect.effect_kind === "provider.turn.start")
  ));
  if (matches.length !== 1) {
    throw boundaryError(
      "BUSINESS_OBSERVATION_DELIVERY_EFFECT_INVALID",
      "Observation does not resolve one exact authoritative turn-start outbox effect",
      { matches: matches.length },
    );
  }
  const effect = matches[0];
  const identity = Object.fromEntries(OUTBOX_EFFECT_IDENTITY_FIELDS.map((field) => [
    field,
    effect[field],
  ]));
  return {
    ...identity,
    fencing_token: effect.lease === null
      ? null
      : {
        lease_id: effect.lease.lease_id,
        owner_id: effect.lease.owner_id,
        generation: effect.lease.generation,
      },
    status: effect.status,
  };
}

function currentDeliveryEffect(projection, observation, branch) {
  const genericDelivery = observation.name === "provider.effect.delivery.recorded";
  if (!DELIVERY_OBSERVATIONS.has(observation.name)
      || !branch
      || observation.payload.attempt !== branch.attempt
      || observation.payload.dispatch_id !== branch.dispatch_id
      || (!genericDelivery
        && !["dispatch_pending", "delivery_unknown"].includes(branch.state))) {
    return null;
  }
  const effect = deliveryEffect(projection, observation, branch);
  if (genericDelivery && ["delivered", "not_sent", "cancelled"].includes(effect.status)) {
    return effect;
  }
  return ["claimed", "sending", "delivery_unknown"].includes(effect.status)
    ? effect
    : null;
}

function effectSettlementBinding(projection, observation, branch) {
  if (observation.name !== EFFECT_SETTLEMENT_OBSERVATION_NAME || !branch) return null;
  const payload = observation.payload;
  const effect = projection.outbox[payload.effect_id];
  if (!isPlainObject(effect)
      || effect.effect_id !== payload.effect_id
      || effect.effect_contract_version !== payload.effect_contract_version
      || effect.effect_kind !== payload.effect_kind
      || effect.work_order_id !== observation.work_order_id
      || effect.branch_ref !== payload.branch_ref
      || effect.branch_ref !== branch.branch_ref
      || effect.attempt !== payload.attempt
      || effect.dispatch_id !== payload.dispatch_id
      || effect.provider_ref !== branch.provider_ref
      || !Number.isSafeInteger(effect.lease_generation)
      || effect.lease_generation < 0
      || (effect.last_lease_id !== null && typeof effect.last_lease_id !== "string")
      || !Array.isArray(effect.fencing_history)
      || effect.fencing_history.length !== effect.lease_generation) {
    throw boundaryError(
      "BUSINESS_OBSERVATION_SETTLEMENT_EFFECT_INVALID",
      "Settlement does not bind one exact authoritative V2 provider effect",
      { effect_id: payload.effect_id },
    );
  }
  const fencingHistory = effect.fencing_history.map((entry, index) => {
    if (!hasExactFields(entry, WORKER_FENCING_TOKEN_FIELDS)
        || typeof entry.lease_id !== "string"
        || typeof entry.owner_id !== "string"
        || entry.generation !== index + 1) {
      throw boundaryError(
        "BUSINESS_OBSERVATION_SETTLEMENT_EFFECT_INVALID",
        "Authoritative effect has non-contiguous projector-derived fencing history",
        { effect_id: payload.effect_id, generation: index + 1 },
      );
    }
    return Object.freeze({
      lease_id: entry.lease_id,
      owner_id: entry.owner_id,
      generation: entry.generation,
    });
  });
  const lastIssuedToken = fencingHistory.at(-1) || null;
  if ((lastIssuedToken === null) !== (effect.last_lease_id === null)
      || (lastIssuedToken !== null && lastIssuedToken.lease_id !== effect.last_lease_id)) {
    throw boundaryError(
      "BUSINESS_OBSERVATION_SETTLEMENT_EFFECT_INVALID",
      "Authoritative fencing history does not match the last lease marker",
      { effect_id: payload.effect_id },
    );
  }
  const issuedCallbackToken = payload.settlement_source === "worker_result"
    ? fencingHistory[payload.worker_fencing_token.generation - 1] || null
    : null;
  const currentFencingToken = effect.lease === null
    ? null
    : (() => {
      if (!isPlainObject(effect.lease)
          || typeof effect.lease.lease_id !== "string"
          || typeof effect.lease.owner_id !== "string"
          || !Number.isSafeInteger(effect.lease.generation)
          || effect.lease.generation < 1) {
        throw boundaryError(
          "BUSINESS_OBSERVATION_SETTLEMENT_EFFECT_INVALID",
          "Authoritative effect has an invalid current lease projection",
          { effect_id: payload.effect_id },
        );
      }
      return Object.freeze({
        lease_id: effect.lease.lease_id,
        owner_id: effect.lease.owner_id,
        generation: effect.lease.generation,
      });
    })();
  if (currentFencingToken !== null
      && canonicalJson(currentFencingToken) !== canonicalJson(lastIssuedToken)) {
    throw boundaryError(
      "BUSINESS_OBSERVATION_SETTLEMENT_EFFECT_INVALID",
      "Authoritative current lease is not the last issued fencing token",
      { effect_id: payload.effect_id },
    );
  }
  return Object.freeze({
    ...Object.fromEntries(OUTBOX_EFFECT_IDENTITY_FIELDS.map((field) => [field, effect[field]])),
    status: effect.status,
    lease_generation: effect.lease_generation,
    last_lease_id: effect.last_lease_id,
    fencing_history: Object.freeze(fencingHistory),
    issued_callback_fencing_token: issuedCallbackToken,
    current_fencing_token: currentFencingToken,
    current_lease_expires_at: effect.lease?.expires_at || null,
  });
}

function effectSendExpiryBinding(projection, observation, branch) {
  if (observation.name !== EFFECT_SEND_EXPIRY_OBSERVATION_NAME || !branch) return null;
  const payload = observation.payload;
  const effect = projection.outbox[payload.effect_id];
  if (!isPlainObject(effect)
      || effect.effect_contract_version !== 2
      || effect.effect_id !== payload.effect_id
      || effect.effect_kind !== payload.effect_kind
      || effect.work_order_id !== observation.work_order_id
      || effect.branch_ref !== payload.branch_ref
      || effect.branch_ref !== branch.branch_ref
      || effect.attempt !== payload.attempt
      || effect.dispatch_id !== payload.dispatch_id
      || effect.provider_ref !== branch.provider_ref
      || !Array.isArray(effect.fencing_history)) {
    throw boundaryError(
      "BUSINESS_OBSERVATION_SEND_EXPIRY_EFFECT_INVALID",
      "Send expiration does not bind one exact authoritative V2 provider effect",
      { effect_id: payload.effect_id },
    );
  }
  const issued = effect.fencing_history[payload.expired_fencing_token.generation - 1] || null;
  if (!issued
      || canonicalJson(issued) !== canonicalJson(payload.expired_fencing_token)) {
    throw boundaryError(
      "BUSINESS_OBSERVATION_SEND_EXPIRY_FENCING_MISMATCH",
      "Send expiration token was not durably issued for this effect",
      { effect_id: payload.effect_id },
    );
  }
  const currentToken = effect.lease === null ? null : {
    lease_id: effect.lease.lease_id,
    owner_id: effect.lease.owner_id,
    generation: effect.lease.generation,
  };
  const staleReason = ["delivered", "not_sent", "cancelled"].includes(effect.status)
    ? "stale_effect_stage"
    : currentToken === null
      || canonicalJson(currentToken) !== canonicalJson(payload.expired_fencing_token)
      || effect.lease.expires_at !== payload.lease_expires_at
      ? "stale_effect_lease"
      : effect.status !== "sending"
        ? "stale_effect_stage"
        : null;
  return Object.freeze({
    ...Object.fromEntries(OUTBOX_EFFECT_IDENTITY_FIELDS.map((field) => [field, effect[field]])),
    status: effect.status,
    current_fencing_token: currentToken,
    current_lease_expires_at: effect.lease?.expires_at || null,
    stale_reason: staleReason,
  });
}

function effectPresendFailureBinding(projection, observation, branch) {
  if (observation.name !== EFFECT_PRESEND_FAILURE_OBSERVATION_NAME || !branch) return null;
  const payload = observation.payload;
  const effect = projection.outbox[payload.effect_id];
  const lease = effect?.lease;
  const token = lease === null || lease === undefined ? null : {
    lease_id: lease.lease_id,
    owner_id: lease.owner_id,
    generation: lease.generation,
  };
  if (!isPlainObject(effect)
      || effect.effect_contract_version !== 2
      || effect.effect_id !== payload.effect_id
      || effect.effect_kind !== payload.effect_kind
      || effect.work_order_id !== observation.work_order_id
      || effect.branch_ref !== payload.branch_ref
      || effect.branch_ref !== branch.branch_ref
      || effect.attempt !== payload.attempt
      || effect.dispatch_id !== payload.dispatch_id
      || effect.provider_ref !== branch.provider_ref
      || effect.status !== "claimed"
      || !isPlainObject(lease)
      || canonicalJson(token) !== canonicalJson(payload.claimed_fencing_token)) {
    throw boundaryError(
      "BUSINESS_OBSERVATION_PRESEND_FAILURE_EFFECT_INVALID",
      "Pre-send failure must bind one exact currently claimed Effect V2 and lease",
      { effect_id: payload.effect_id },
    );
  }
  return Object.freeze({
    ...Object.fromEntries(OUTBOX_EFFECT_IDENTITY_FIELDS.map((field) => [field, effect[field]])),
    fencing_token: Object.freeze(token),
    status: effect.status,
  });
}

function currentTimeoutEffect(projection, observation, branch) {
  if (observation.name !== "branch.timed_out"
      || !branch
      || !["dispatch_pending", "waiting_for_user"].includes(branch.state)
      || observation.payload.attempt !== branch.attempt) {
    return null;
  }
  if (branch.state === "waiting_for_user" && !branch.pending_user_input_effect_id) {
    return null;
  }
  const expectedKinds = branch.state === "waiting_for_user"
    ? ["provider.user_input.submit"]
    : ["provider.thread.create", "provider.turn.start"];
  const matches = Object.values(projection.outbox).filter((effect) => (
    isPlainObject(effect)
      && effect.effect_contract_version === 2
      && effect.work_order_id === observation.work_order_id
      && effect.branch_ref === branch.branch_ref
      && effect.attempt === branch.attempt
      && effect.dispatch_id === branch.dispatch_id
      && effect.provider_ref === branch.provider_ref
      && expectedKinds.includes(effect.effect_kind)
      && ["pending", "claimed", "sending", "delivery_unknown"].includes(effect.status)
  ));
  if (matches.length !== 1) {
    throw boundaryError(
      "BUSINESS_OBSERVATION_TIMEOUT_EFFECT_INVALID",
      "A current timeout must resolve one exact V2 provider effect",
      { matches: matches.length },
    );
  }
  const effect = matches[0];
  return Object.freeze({
    ...Object.fromEntries(OUTBOX_EFFECT_IDENTITY_FIELDS.map((field) => [field, effect[field]])),
    status: effect.status,
  });
}

function expectedDeliveryClassification(observation) {
  if (observation.name === "provider.effect.delivery.recorded") {
    return observation.payload.classification;
  }
  return {
    "branch.dispatch.accepted": "accepted",
    "branch.dispatch.not_sent": "not_sent",
    "branch.delivery_unknown": "delivery_unknown",
  }[observation.name] || null;
}

function validateDeliveryAttestation(context, facts) {
  if (!DELIVERY_OBSERVATIONS.has(context.observation.name)) return;
  const classification = expectedDeliveryClassification(context.observation);
  const supplied = Object.hasOwn(facts, "delivery_attestation");
  if (!context.deliveryEffect) {
    if (supplied) {
      throw boundaryError(
        "BUSINESS_OBSERVATION_FACTS_UNVERIFIED",
        "A stale delivery observation cannot attest a current provider effect",
      );
    }
    return;
  }
  if (context.observation.name === "provider.effect.delivery.recorded") {
    if (classification === "accepted" && !isPlainObject(facts.runtime_identity)) {
      throw boundaryError(
        "BUSINESS_OBSERVATION_DELIVERY_ATTESTATION_INVALID",
        "An accepted provider effect requires a structured runtime identity",
      );
    }
    if (classification !== "accepted" && Object.hasOwn(facts, "runtime_identity")) {
      throw boundaryError(
        "BUSINESS_OBSERVATION_DELIVERY_ATTESTATION_INVALID",
        "A non-accepted provider effect cannot assert a runtime identity",
      );
    }
    if (classification === "delivery_unknown") {
      portableRef(facts.attention_detail_ref, "facts.attention_detail_ref");
    }
    if (classification === "not_sent"
        && context.deliveryEffect.effect_kind === "provider.turn.cancel") {
      portableRef(facts.attention_detail_ref, "facts.attention_detail_ref");
    }
  }
  if (!supplied || !hasExactFields(facts.delivery_attestation, DELIVERY_ATTESTATION_FIELDS)) {
    throw boundaryError(
      "BUSINESS_OBSERVATION_DELIVERY_ATTESTATION_INVALID",
      "A current delivery observation requires one exact effect-bound attestation",
    );
  }
  const attestation = facts.delivery_attestation;
  const evidenceRefs = Array.isArray(attestation.evidence_refs)
    ? attestation.evidence_refs.map((entry, index) => portableRef(
      entry,
      `facts.delivery_attestation.evidence_refs[${index}]`,
    ))
    : null;
  const expectedRuntimeIdentity = classification === "accepted"
    ? facts.runtime_identity
    : null;
  if (!evidenceRefs
      || evidenceRefs.length === 0
      || new Set(evidenceRefs).size !== evidenceRefs.length
      || attestation.effect_id !== context.deliveryEffect.effect_id
      || attestation.idempotency_key !== context.deliveryEffect.idempotency_key
      || attestation.provider_ref !== context.deliveryEffect.provider_ref
      || attestation.provider_ref !== facts.provider_ref
      || attestation.classification !== classification
      || canonicalJson(attestation.runtime_identity) !== canonicalJson(expectedRuntimeIdentity)
      || canonicalJson(evidenceRefs) !== canonicalJson(facts.observation_evidence_refs)) {
    throw boundaryError(
      "BUSINESS_OBSERVATION_DELIVERY_ATTESTATION_MISMATCH",
      "Delivery evidence does not bind the exact provider effect, mutation key, and outcome",
    );
  }
}

function normalizeAttestedWorkerToken(value, path) {
  if (!hasExactFields(value, WORKER_FENCING_TOKEN_FIELDS)) {
    throw boundaryError(
      "BUSINESS_OBSERVATION_SETTLEMENT_ATTESTATION_INVALID",
      `${path} must contain the exact callback-owned lease token`,
    );
  }
  if (!Number.isSafeInteger(value.generation)
      || value.generation < 1
      || value.generation > 1_000_000_000) {
    throw boundaryError(
      "BUSINESS_OBSERVATION_SETTLEMENT_ATTESTATION_INVALID",
      `${path}.generation must be a positive bounded generation`,
    );
  }
  return {
    lease_id: portableRef(value.lease_id, `${path}.lease_id`),
    owner_id: portableRef(value.owner_id, `${path}.owner_id`),
    generation: value.generation,
  };
}

function normalizeAttestedDerivedContentRef(value, path, prefix) {
  if (!hasExactFields(value, CONTENT_ADDRESS_REF_FIELDS)) {
    throw boundaryError(
      "BUSINESS_OBSERVATION_SETTLEMENT_ATTESTATION_INVALID",
      `${path} must be an exact content-addressed reference`,
    );
  }
  const ref = {
    id: portableRef(value.id, `${path}.id`),
    hash: sha256(value.hash, `${path}.hash`),
  };
  const pattern = new RegExp(`^${prefix}-[a-f0-9]{32}$`, "u");
  if (!pattern.test(ref.id) || ref.id !== `${prefix}-${ref.hash.slice(0, 32)}`) {
    throw boundaryError(
      "BUSINESS_OBSERVATION_SETTLEMENT_ATTESTATION_INVALID",
      `${path} must bind its content hash`,
    );
  }
  return ref;
}

function normalizeAttestedRecoveryProbe(value, path) {
  if (!hasExactFields(value, RECOVERY_PROBE_FIELDS)
      || !hasExactFields(value.probe_receipt_ref, CONTENT_ADDRESS_REF_FIELDS)) {
    throw boundaryError(
      "BUSINESS_OBSERVATION_SETTLEMENT_ATTESTATION_INVALID",
      `${path} must contain one exact content-addressed recovery probe`,
    );
  }
  const receipt = normalizeAttestedDerivedContentRef(
    value.probe_receipt_ref,
    `${path}.probe_receipt_ref`,
    "PRB",
  );
  return {
    probe_receipt_ref: receipt,
    mutation_idempotency_key: portableRef(
      value.mutation_idempotency_key,
      `${path}.mutation_idempotency_key`,
    ),
  };
}

function validateSettlementAttestation(context, facts) {
  if (context.observation.name !== EFFECT_SETTLEMENT_OBSERVATION_NAME) return;
  const { observation, settlementEffect } = context;
  if (!settlementEffect) {
    throw boundaryError(
      "BUSINESS_OBSERVATION_SETTLEMENT_EFFECT_INVALID",
      "Settlement cannot attest a missing authoritative provider effect",
    );
  }
  const payload = observation.payload;
  let settlementPolicy;
  try {
    settlementPolicy = deriveSettlementDispositionV2(facts.settlement_certainty_fact);
  } catch (error) {
    throw boundaryError(
      "BUSINESS_OBSERVATION_SETTLEMENT_POLICY_INVALID",
      "Trusted settlement certainty does not satisfy the shared V2 policy",
      { cause_code: error?.code || null, cause_reason: error?.reason || null },
    );
  }
  if (settlementPolicy.effect_kind !== settlementEffect.effect_kind
      || settlementPolicy.effect_stage === null
      || settlementPolicy.settlement_source !== payload.settlement_source
      || settlementPolicy.classification !== payload.classification) {
    throw boundaryError(
      "BUSINESS_OBSERVATION_SETTLEMENT_POLICY_MISMATCH",
      "Trusted settlement certainty does not bind the immutable effect and callback outcome",
      { effect_id: settlementEffect.effect_id },
    );
  }
  // The pure decider and projector independently rederive this policy from the
  // raw certainty fact. Retaining it here only avoids recomputing during the
  // rest of this boundary validation pass.
  context.settlementPolicy = settlementPolicy;
  const attestation = facts.settlement_attestation;
  const attestationFields = payload.settlement_source === "worker_result"
    ? WORKER_SETTLEMENT_ATTESTATION_FIELDS
    : RECOVERY_PROBE_SETTLEMENT_ATTESTATION_FIELDS;
  if (!hasExactFields(attestation, attestationFields)) {
    throw boundaryError(
      "BUSINESS_OBSERVATION_SETTLEMENT_ATTESTATION_INVALID",
      "Settlement requires an exact source-specific resolver attestation",
    );
  }
  const evidenceRefs = Array.isArray(attestation.evidence_refs)
    ? attestation.evidence_refs.map((entry, index) => portableRef(
      entry,
      `facts.settlement_attestation.evidence_refs[${index}]`,
    ))
    : null;
  const expectedRuntimeIdentity = payload.classification === "accepted"
    ? facts.runtime_identity
    : null;
  if (payload.classification === "accepted" && !isPlainObject(facts.runtime_identity)) {
    throw boundaryError(
      "BUSINESS_OBSERVATION_SETTLEMENT_ATTESTATION_INVALID",
      "An accepted settlement requires a structured runtime identity",
    );
  }
  if (payload.classification !== "accepted" && Object.hasOwn(facts, "runtime_identity")) {
    throw boundaryError(
      "BUSINESS_OBSERVATION_SETTLEMENT_ATTESTATION_INVALID",
      "A non-accepted settlement cannot assert a runtime identity",
    );
  }
  if (!evidenceRefs
      || evidenceRefs.length === 0
      || evidenceRefs.length > 128
      || new Set(evidenceRefs).size !== evidenceRefs.length
      || attestation.effect_id !== settlementEffect.effect_id
      || attestation.idempotency_key !== settlementEffect.idempotency_key
      || attestation.provider_ref !== settlementEffect.provider_ref
      || attestation.provider_ref !== facts.provider_ref
      || attestation.classification !== payload.classification
      || attestation.settlement_source !== payload.settlement_source
      || canonicalJson(attestation.runtime_identity) !== canonicalJson(expectedRuntimeIdentity)
      || canonicalJson(evidenceRefs) !== canonicalJson(facts.observation_evidence_refs)) {
    throw boundaryError(
      "BUSINESS_OBSERVATION_SETTLEMENT_ATTESTATION_MISMATCH",
      "Settlement evidence does not bind the exact effect, mutation key, source, and outcome",
    );
  }
  if (payload.classification === "delivery_unknown") {
    portableRef(facts.attention_detail_ref, "facts.attention_detail_ref");
  }
  if (payload.classification === "not_sent"
      && settlementEffect.effect_kind === "provider.turn.cancel") {
    portableRef(facts.attention_detail_ref, "facts.attention_detail_ref");
  }

  if (payload.settlement_source === "recovery_probe") {
    const attestedProbe = normalizeAttestedRecoveryProbe(
      attestation.recovery_probe,
      "facts.settlement_attestation.recovery_probe",
    );
    if (canonicalJson(attestedProbe) !== canonicalJson(payload.recovery_probe)
        || attestedProbe.mutation_idempotency_key !== settlementEffect.idempotency_key) {
      throw boundaryError(
        "BUSINESS_OBSERVATION_SETTLEMENT_ATTESTATION_MISMATCH",
        "Recovery probe does not bind the exact receipt and provider mutation key",
      );
    }
    return;
  }

  const callbackToken = normalizeAttestedWorkerToken(
    attestation.worker_fencing_token,
    "facts.settlement_attestation.worker_fencing_token",
  );
  if (canonicalJson(callbackToken) !== canonicalJson(payload.worker_fencing_token)) {
    throw boundaryError(
      "BUSINESS_OBSERVATION_SETTLEMENT_ATTESTATION_MISMATCH",
      "Resolver attestation does not bind the callback-owned worker token",
    );
  }
  if (!settlementEffect.issued_callback_fencing_token
      || canonicalJson(callbackToken)
        !== canonicalJson(settlementEffect.issued_callback_fencing_token)) {
    throw boundaryError(
      "BUSINESS_OBSERVATION_SETTLEMENT_FENCING_MISMATCH",
      "Worker callback does not bind a fencing token durably issued for this effect",
    );
  }
  const workerResultRef = normalizeAttestedDerivedContentRef(
    attestation.worker_result_ref,
    "facts.settlement_attestation.worker_result_ref",
    "WRR",
  );
  if (canonicalJson(workerResultRef) !== canonicalJson(payload.worker_result_ref)) {
    throw boundaryError(
      "BUSINESS_OBSERVATION_SETTLEMENT_ATTESTATION_MISMATCH",
      "Resolver attestation does not bind the content-addressed worker result",
    );
  }
  if (callbackToken.generation < settlementEffect.lease_generation) {
    context.staleDeliveryReason = "stale_effect_generation";
    return;
  }
  const currentToken = settlementEffect.current_fencing_token;
  if (currentToken === null) {
    context.staleDeliveryReason = ["delivered", "not_sent", "cancelled"]
      .includes(settlementEffect.status)
      ? "stale_effect_stage"
      : "stale_effect_lease";
    return;
  }
  if (canonicalJson(callbackToken) !== canonicalJson(currentToken)) {
    throw boundaryError(
      "BUSINESS_OBSERVATION_SETTLEMENT_FENCING_MISMATCH",
      "Worker callback does not bind the exact current authoritative lease",
    );
  }
  if (settlementEffect.status !== "sending") {
    throw boundaryError(
      "BUSINESS_OBSERVATION_SETTLEMENT_PHASE_INVALID",
      "Worker settlement is only valid after the durable send-begun boundary",
      { effect_id: settlementEffect.effect_id, effect_status: settlementEffect.status },
    );
  }
}

function validatePresendFailure(context, facts) {
  if (context.observation.name !== EFFECT_PRESEND_FAILURE_OBSERVATION_NAME) return;
  if (!context.presendFailureEffect) {
    throw boundaryError(
      "BUSINESS_OBSERVATION_PRESEND_FAILURE_EFFECT_INVALID",
      "Pre-send control-plane failure cannot target a missing claimed Effect V2",
    );
  }
  const { payload } = context.observation;
  const attestation = facts.presend_failure_attestation;
  if (!hasExactFields(attestation, PRESEND_FAILURE_ATTESTATION_FIELDS)) {
    throw boundaryError(
      "BUSINESS_OBSERVATION_PRESEND_FAILURE_ATTESTATION_INVALID",
      "Pre-send failure requires one exact trusted control-plane attestation",
    );
  }
  const evidenceRefs = Array.isArray(attestation.evidence_refs)
    ? attestation.evidence_refs.map((entry, index) => portableRef(
      entry,
      `facts.presend_failure_attestation.evidence_refs[${index}]`,
    ))
    : null;
  const claimedToken = normalizeAttestedWorkerToken(
    attestation.claimed_fencing_token,
    "facts.presend_failure_attestation.claimed_fencing_token",
  );
  const failureRecordRef = normalizeAttestedDerivedContentRef(
    attestation.failure_record_ref,
    "facts.presend_failure_attestation.failure_record_ref",
    "PFR",
  );
  if (!evidenceRefs
      || evidenceRefs.length === 0
      || evidenceRefs.length > 128
      || new Set(evidenceRefs).size !== evidenceRefs.length
      || attestation.effect_id !== context.presendFailureEffect.effect_id
      || attestation.idempotency_key !== context.presendFailureEffect.idempotency_key
      || attestation.provider_ref !== context.presendFailureEffect.provider_ref
      || attestation.provider_ref !== facts.provider_ref
      || canonicalJson(claimedToken) !== canonicalJson(payload.claimed_fencing_token)
      || canonicalJson(claimedToken)
        !== canonicalJson(context.presendFailureEffect.fencing_token)
      || attestation.failure_reason !== payload.failure_reason
      || canonicalJson(failureRecordRef) !== canonicalJson(payload.failure_record_ref)
      || canonicalJson(evidenceRefs) !== canonicalJson(facts.observation_evidence_refs)) {
    throw boundaryError(
      "BUSINESS_OBSERVATION_PRESEND_FAILURE_ATTESTATION_MISMATCH",
      "Pre-send failure evidence does not bind the exact Effect, lease, reason, and record",
    );
  }
  const stage = {
    "provider.thread.create": "thread_create",
    "provider.turn.start": "turn_start",
    "provider.user_input.submit": "user_input_submit",
    "provider.turn.cancel": "turn_cancel",
  }[context.presendFailureEffect.effect_kind];
  try {
    context.settlementPolicy = deriveSettlementDispositionV2({
      certainty_fact_version: 2,
      effect_contract_version: 2,
      effect_kind: context.presendFailureEffect.effect_kind,
      effect_stage: stage,
      settlement_source: "control_plane",
      classification: "not_sent",
      reason: payload.failure_reason,
    });
  } catch (error) {
    throw boundaryError(
      "BUSINESS_OBSERVATION_SETTLEMENT_POLICY_INVALID",
      "Pre-send failure does not satisfy the shared V2 control-plane policy",
      { cause_code: error?.code || null, cause_reason: error?.reason || null },
    );
  }
  if (context.settlementPolicy.disposition !== "operator_attention"
      || context.settlementPolicy.retry.scope !== "none"
      || context.settlementPolicy.retry.mode !== "none") {
    throw boundaryError(
      "BUSINESS_OBSERVATION_SETTLEMENT_POLICY_MISMATCH",
      "Pre-send control-plane failures must require operator attention without retry",
    );
  }
}

function mutatingEffectsQuiescent(projection, workOrderId) {
  return !Object.values(projection.outbox).some((effect) => (
    isPlainObject(effect)
      && effect.work_order_id === workOrderId
      && NONQUIESCENT_OUTBOX_STATES.has(effect.status)
  ));
}

function validateResolvedBindings(context, facts) {
  const { observation, branch, principal } = context;
  if (PROVIDER_SCOPED_OBSERVATIONS.has(observation.name)) {
    portableRef(facts.provider_ref, "facts.provider_ref");
    if (!branch || facts.provider_ref !== branch.provider_ref) {
      throw boundaryError(
        "BUSINESS_OBSERVATION_PROVIDER_BINDING_MISMATCH",
        "Resolved provider does not match the authoritative branch provider",
      );
    }
  }
  if (VERIFIER_OBSERVATIONS.has(observation.name)) {
    portableRef(facts.verifier_ref, "facts.verifier_ref");
    if (facts.verifier_ref !== principal.id || facts.verifier_ref !== observation.actor.actor_id) {
      throw boundaryError(
        "BUSINESS_OBSERVATION_VERIFIER_BINDING_MISMATCH",
        "Resolved verifier does not match the authenticated observation actor",
      );
    }
    const result = branch?.result;
    sha256(facts.current_result_hash, "facts.current_result_hash");
    if (result && facts.current_result_hash !== canonicalHash(result)) {
      throw boundaryError(
        "BUSINESS_OBSERVATION_RESULT_BINDING_MISMATCH",
        "Verifier evidence does not bind the current authoritative branch result",
      );
    }
  }
  if (observation.name === "user_input.requested") {
    const attempt = facts.current_attempt;
    if (!isPlainObject(attempt)
        || Object.keys(attempt).sort(compareText).join(",") !== "attempt,dispatch_id"
        || attempt.attempt !== branch.attempt
        || attempt.dispatch_id !== branch.dispatch_id) {
      throw boundaryError(
        "BUSINESS_OBSERVATION_ATTEMPT_BINDING_MISMATCH",
        "User-input observation does not bind the current branch attempt",
      );
    }
  }
  validateDeliveryAttestation(context, facts);
  validateSettlementAttestation(context, facts);
  validatePresendFailure(context, facts);
}

function decisionFacts(context, facts, projection, occurredAt) {
  const trusted = { ...facts };
  delete trusted.provider_ref;
  delete trusted.verifier_ref;
  delete trusted.delivery_attestation;
  delete trusted.settlement_attestation;
  delete trusted.presend_failure_attestation;
  if (context.presendFailureEffect) {
    const failureRef = context.observation.payload.failure_record_ref;
    trusted.observation_evidence_refs = [...new Set([
      ...trusted.observation_evidence_refs,
      failureRef.id,
    ])];
    trusted.attention_detail_ref = failureRef;
    trusted.delivery_effect = context.presendFailureEffect;
    trusted.settlement_certainty_fact = {
      certainty_fact_version: 2,
      effect_contract_version: 2,
      effect_kind: context.presendFailureEffect.effect_kind,
      effect_stage: context.settlementPolicy.effect_stage,
      settlement_source: "control_plane",
      classification: "not_sent",
      reason: context.observation.payload.failure_reason,
    };
  }
  // The official decider must be allowed to quarantine stale/replaced delivery
  // facts before it asks for settlement. Only a live settlement receives the
  // authoritative outbox effect and fencing token.
  if (context.deliveryEffect) {
    trusted.delivery_effect = context.deliveryEffect;
    if (["delivered", "not_sent", "cancelled"].includes(context.deliveryEffect.status)) {
      trusted.stale_delivery_effect = true;
    }
  }
  if (context.settlementEffect
      && context.observation.payload.settlement_source === "worker_result") {
    trusted.delivery_effect = {
      ...Object.fromEntries(OUTBOX_EFFECT_IDENTITY_FIELDS.map((field) => [
        field,
        context.settlementEffect[field],
      ])),
      // This is copied from the normalized callback, after an exact comparison
      // with the projection. It is never filled from current_fencing_token.
      fencing_token: context.observation.payload.worker_fencing_token,
      status: context.settlementEffect.status,
    };
    if (context.staleDeliveryReason !== null) {
      trusted.stale_delivery_reason = context.staleDeliveryReason;
      trusted.stale_delivery_effect = true;
    }
  }
  if (context.settlementEffect
      && context.observation.payload.settlement_source === "recovery_probe") {
    trusted.delivery_effect = {
      ...Object.fromEntries(OUTBOX_EFFECT_IDENTITY_FIELDS.map((field) => [
        field,
        context.settlementEffect[field],
      ])),
      fencing_token: null,
      status: context.settlementEffect.status,
    };
    if (context.settlementEffect.status !== "delivery_unknown") {
      trusted.stale_delivery_reason = "stale_effect_stage";
      trusted.stale_delivery_effect = true;
    }
  }
  const expiryEffect = context.sendExpiryEffect || context.settlementEffect;
  const callbackExpired = context.settlementEffect
    && context.observation.payload.settlement_source === "worker_result"
    && context.staleDeliveryReason === null
    && context.settlementEffect.status === "sending"
    && context.settlementEffect.current_lease_expires_at !== null
    && Date.parse(occurredAt) >= Date.parse(context.settlementEffect.current_lease_expires_at);
  if (context.sendExpiryEffect || callbackExpired) {
    if (context.sendExpiryEffect?.stale_reason) {
      trusted.stale_delivery_reason = context.sendExpiryEffect.stale_reason;
      trusted.stale_delivery_effect = true;
    } else {
      const payload = context.observation.payload;
      const token = context.sendExpiryEffect
        ? payload.expired_fencing_token
        : payload.worker_fencing_token;
      const expiresAt = context.sendExpiryEffect
        ? payload.lease_expires_at
        : context.settlementEffect.current_lease_expires_at;
      if (Date.parse(occurredAt) < Date.parse(expiresAt)) {
        throw boundaryError(
          "BUSINESS_OBSERVATION_SEND_NOT_EXPIRED",
          "The exact sending lease has not expired",
          { effect_id: expiryEffect.effect_id, lease_expires_at: expiresAt },
        );
      }
      trusted.send_expiry = {
        effect: Object.fromEntries(OUTBOX_EFFECT_IDENTITY_FIELDS.map((field) => [
          field,
          expiryEffect[field],
        ])),
        status: expiryEffect.status,
        fencing_token: token,
        lease_expires_at: expiresAt,
        trigger_ref: context.sendExpiryEffect
          ? payload.expiry_receipt_ref
          : payload.worker_result_ref,
        quarantine_original: callbackExpired === true,
      };
      if (trusted.attention_detail_ref === undefined) {
        trusted.attention_detail_ref = trusted.send_expiry.trigger_ref;
      }
    }
  }
  if (context.timeoutEffect) {
    trusted.timeout_effect = context.timeoutEffect;
  }
  if (context.observation.name === "work_order.cancelled") {
    trusted.mutating_effects_quiescent = mutatingEffectsQuiescent(
      projection,
      context.observation.work_order_id,
    );
  }
  return Object.freeze({
    occurred_at: occurredAt,
    authenticated_principal: context.principal,
    ...trusted,
  });
}

function observationIdentityHash(observation, principal, sourceType = "observation") {
  return canonicalHash({
    source_type: sourceType,
    observation,
    authenticated_principal: principal,
  });
}

function observationIdentityHashes(observation, principal) {
  return Object.freeze({
    observation: observationIdentityHash(observation, principal, "observation"),
    [PROVIDER_SETTLEMENT_SOURCE_TYPE]: observationIdentityHash(
      observation,
      principal,
      PROVIDER_SETTLEMENT_SOURCE_TYPE,
    ),
  });
}

function readReceipt(projection, observation, identityHashes) {
  for (const mapName of ["command_receipts", "internal_receipts"]) {
    if (projection[mapName][observation.observation_id] !== undefined) {
      throw boundaryError(
        "BUSINESS_OBSERVATION_ID_CONFLICT",
        "Observation ID is already used in another receipt namespace",
        { observation_id: observation.observation_id },
      );
    }
  }
  const receipt = projection.observation_receipts[observation.observation_id];
  if (receipt === undefined) return RECEIPT_NOT_FOUND;
  const expectedIdentityHash = identityHashes[receipt.source_type];
  if (!isPlainObject(receipt)
      || receipt.source_id !== observation.observation_id
      || !["observation", PROVIDER_SETTLEMENT_SOURCE_TYPE].includes(receipt.source_type)
      || expectedIdentityHash === undefined
      || receipt.identity_hash !== expectedIdentityHash
      || receipt.payload_hash !== observation.payload_hash
      || receipt.work_order_id !== observation.work_order_id
      || receipt.batch_id !== `business:${observation.observation_id}`
      || !Number.isSafeInteger(receipt.applied_revision)
      || !Array.isArray(receipt.event_ids)
      || receipt.event_ids.length === 0
      || !Object.hasOwn(receipt, "result")) {
    if (isPlainObject(receipt) && receipt.identity_hash !== expectedIdentityHash) {
      throw boundaryError(
        "BUSINESS_OBSERVATION_ID_CONFLICT",
        "Observation ID is bound to different immutable content or principal",
        { observation_id: observation.observation_id },
      );
    }
    throw boundaryError(
      "BUSINESS_OBSERVATION_RECEIPT_INVALID",
      "Stored observation receipt is malformed or does not exactly bind the envelope",
      { observation_id: observation.observation_id },
    );
  }
  return canonicalClone(receipt.result, "BUSINESS_OBSERVATION_RECEIPT_INVALID");
}

function validateRecoveryProbeLedgerAdmission(projection, workOrder, observation) {
  if (observation.name !== EFFECT_SETTLEMENT_OBSERVATION_NAME
      || observation.payload.settlement_source !== "recovery_probe") return;
  const probeId = observation.payload.recovery_probe.probe_receipt_ref.id;
  let effectProbeCount = 0;
  for (const receipt of Object.values(projection.observation_receipts)) {
    const entry = receipt?.result?.recovery_probe_ledger;
    if (!isPlainObject(entry) || entry.version !== 1) continue;
    if (entry.effect_id === observation.payload.effect_id) effectProbeCount += 1;
    if (entry.probe_receipt_ref?.id === probeId) {
      throw boundaryError(
        "BUSINESS_OBSERVATION_RECOVERY_PROBE_REUSED",
        "Recovery probe receipt is already bound to another observation receipt",
        { probe_receipt_id: probeId, source_id: receipt.source_id || null },
      );
    }
  }
  if (effectProbeCount >= workOrder.plan.lease_policy.max_recovery_probes) {
    throw boundaryError(
      "BUSINESS_OBSERVATION_RECOVERY_PROBE_LIMIT",
      "The immutable recovery probe limit is exhausted for this effect",
      { effect_id: observation.payload.effect_id, probe_count: effectProbeCount },
    );
  }
}

function normalizeDecision(decision, context, occurredAt) {
  if (!isPlainObject(decision)
      || !Array.isArray(decision.events)
      || decision.events.length === 0
      || decision.events.length > 511
      || !Object.hasOwn(decision, "result")) {
    throw boundaryError(
      "BUSINESS_OBSERVATION_DECISION_INVALID",
      "Official decider must return domain events and a result",
    );
  }
  const targetRevision = context.workOrder.revision + 1;
  const seen = new Set();
  const events = decision.events.map((input, ordinal) => {
    const event = canonicalClone(input, "BUSINESS_OBSERVATION_DECISION_INVALID");
    if (!isPlainObject(event)
        || !BUSINESS_EVENT_TYPE_SET.has(event.type)
        || RECEIPT_TYPES.has(event.type)
        || typeof event.event_id !== "string"
        || seen.has(event.event_id)
        || event.schema_version !== 1
        || !isPlainObject(event.payload)
        || !Array.isArray(event.evidence_refs)
        || event.payload.work_order_id !== context.observation.work_order_id
        || event.payload.plan_snapshot_ref !== context.observation.plan_snapshot_ref
        || event.payload.plan_hash !== context.observation.plan_hash
        || event.payload.source_id !== context.observation.observation_id
        || event.payload.prior_work_order_revision !== context.workOrder.revision
        || event.payload.target_work_order_revision !== targetRevision
        || event.payload.occurred_at !== occurredAt) {
      throw boundaryError(
        "BUSINESS_OBSERVATION_DECISION_INVALID",
        "Official decider returned an event outside the exact observation binding",
        { ordinal },
      );
    }
    seen.add(event.event_id);
    return event;
  });
  const result = canonicalClone(decision.result, "BUSINESS_OBSERVATION_DECISION_INVALID");
  if (isPlainObject(result)
      && Object.hasOwn(result, "work_order_revision")
      && result.work_order_revision !== targetRevision) {
    throw boundaryError(
      "BUSINESS_OBSERVATION_DECISION_INVALID",
      "Decision result does not bind the applied Work Order revision",
    );
  }
  return { events, result, appliedRevision: targetRevision };
}

function isProviderSettlementObservation(observation) {
  return [
    EFFECT_SETTLEMENT_OBSERVATION_NAME,
    EFFECT_SEND_EXPIRY_OBSERVATION_NAME,
    EFFECT_PRESEND_FAILURE_OBSERVATION_NAME,
  ]
    .includes(observation.name);
}

function settlementPolicyFromDecision(decision) {
  const entries = [];
  for (const event of decision.events) {
    if (event.payload?.settlement_policy) entries.push(event.payload.settlement_policy);
    if (event.payload?.recovery_probe_ledger?.settlement_policy) {
      entries.push(event.payload.recovery_probe_ledger.settlement_policy);
    }
  }
  if (entries.length === 0) return null;
  let policy;
  try {
    policy = normalizeSettlementPolicyRecordV2(entries[0]);
    if (entries.slice(1).some(
      (entry) => canonicalJson(normalizeSettlementPolicyRecordV2(entry)) !== canonicalJson(policy),
    )) {
      throw new Error("settlement policy copies differ");
    }
  } catch (error) {
    throw boundaryError(
      "BUSINESS_OBSERVATION_DECISION_INVALID",
      "Official settlement events do not retain one canonical shared policy",
      { cause_code: error?.code || null },
    );
  }
  return policy;
}

function providerSettlementManifestHash(events) {
  return canonicalHash(events.map((event) => ({
    event_id: event.event_id,
    type: event.type,
    event_hash: canonicalHash(event),
  })));
}

function providerSettlementBundle(context, decision, epoch) {
  if (!isPlainObject(epoch) || typeof epoch.cutover_id !== "string") {
    throw boundaryError(
      "BUSINESS_OBSERVATION_PROVIDER_SETTLEMENT_CUTOVER_REQUIRED",
      "Live provider settlement requires one durable journal-global cutover epoch",
    );
  }
  const observation = context.observation;
  const payload = observation.payload;
  const effect = context.settlementEffect
    || context.sendExpiryEffect
    || context.presendFailureEffect;
  if (!isPlainObject(effect)) {
    throw boundaryError(
      "BUSINESS_OBSERVATION_SETTLEMENT_EFFECT_INVALID",
      "Provider settlement receipt cannot bind a missing authoritative effect",
    );
  }
  let ingressKind;
  let provenanceRef;
  if (observation.name === EFFECT_SEND_EXPIRY_OBSERVATION_NAME) {
    ingressKind = "expiry_receipt";
    provenanceRef = payload.expiry_receipt_ref;
  } else if (observation.name === EFFECT_PRESEND_FAILURE_OBSERVATION_NAME) {
    ingressKind = "control_plane_failure";
    provenanceRef = payload.failure_record_ref;
  } else if (payload.settlement_source === "recovery_probe") {
    ingressKind = "recovery_probe";
    provenanceRef = payload.recovery_probe.probe_receipt_ref;
  } else {
    ingressKind = "worker_result";
    provenanceRef = payload.worker_result_ref;
  }
  const policy = settlementPolicyFromDecision(decision);
  return {
    bundle_schema_version: 1,
    settlement_contract_version: 2,
    cutover_id: epoch.cutover_id,
    observation_name: observation.name,
    effect_binding: {
      effect_id: effect.effect_id,
      effect_contract_version: effect.effect_contract_version,
      effect_kind: effect.effect_kind,
      branch_ref: effect.branch_ref,
      attempt: effect.attempt,
      dispatch_id: effect.dispatch_id,
      mutation_idempotency_key: effect.idempotency_key,
    },
    ingress_kind: ingressKind,
    provenance_ref: provenanceRef,
    effective_classification: policy?.classification
      || payload.classification
      || "delivery_unknown",
    settlement_policy_hash: policy === null ? null : canonicalHash(policy),
    domain_event_manifest_hash: providerSettlementManifestHash(decision.events),
  };
}

function receiptEvent(context, identityHashes, decision, occurredAt, providerSettlementEpoch) {
  const observation = context.observation;
  const batchId = `business:${observation.observation_id}`;
  const providerSettlement = isProviderSettlementObservation(observation);
  const sourceType = providerSettlement ? PROVIDER_SETTLEMENT_SOURCE_TYPE : "observation";
  const receiptType = providerSettlement
    ? PROVIDER_SETTLEMENT_RECEIPT_EVENT
    : "business.observation.received";
  const receipt = {
    source_id: observation.observation_id,
    source_type: sourceType,
    identity_hash: identityHashes[sourceType],
    payload_hash: observation.payload_hash,
    work_order_id: observation.work_order_id,
    applied_revision: decision.appliedRevision,
    batch_id: batchId,
    event_ids: decision.events.map((event) => event.event_id),
    result: decision.result,
    ...(providerSettlement
      ? { settlement_bundle: providerSettlementBundle(context, decision, providerSettlementEpoch) }
      : {}),
  };
  const payload = {
    work_order_id: observation.work_order_id,
    plan_snapshot_ref: observation.plan_snapshot_ref,
    plan_hash: observation.plan_hash,
    source_id: observation.observation_id,
    prior_work_order_revision: context.workOrder.revision,
    target_work_order_revision: decision.appliedRevision,
    occurred_at: occurredAt,
    receipt,
  };
  const ordinal = decision.events.length;
  const event = {
    event_id: `BEV-${canonicalHash({
      source_id: observation.observation_id,
      ordinal,
      type: receiptType,
      payload,
      evidence_refs: [],
    }).slice(0, 32)}`,
    schema_version: 1,
    type: receiptType,
    payload,
    evidence_refs: [],
  };
  return {
    batchId,
    event,
    actor: { type: context.principal.type, id: context.principal.id },
  };
}

function prevalidateCandidateBatch(projection, request, observation, identityHashes) {
  let candidate = projection;
  try {
    for (const event of request.events) {
      candidate = projectBusinessEventV1(candidate, event, request);
    }
  } catch (error) {
    throw boundaryError(
      "BUSINESS_OBSERVATION_DECISION_INVALID",
      "Candidate observation events failed the authoritative Business projector",
      { cause_code: error?.code || null },
    );
  }
  const result = readReceipt(candidate, observation, identityHashes);
  if (result === RECEIPT_NOT_FOUND) {
    throw boundaryError(
      "BUSINESS_OBSERVATION_RECEIPT_MISSING",
      "Candidate batch did not close with its exact observation receipt",
    );
  }
  return result;
}

function mapBatchConflict(error, observationId) {
  if (error?.code !== "EVENT_BATCH_ID_CONFLICT") return error;
  return boundaryError(
    "BUSINESS_OBSERVATION_ID_CONFLICT",
    "Observation ID is already bound to a different atomic batch",
    { observation_id: observationId },
  );
}

/**
 * Authenticated, receipt-idempotent ingress for provider/runtime/verifier facts.
 * It only appends Business events; it has no provider, filesystem, or process
 * mutation capability. Read-side dependencies are abortable and bounded. A
 * commit is intentionally not timed out because doing so would manufacture an
 * ambiguous write; commit errors are reconciled against the durable receipt.
 */
function createBusinessObservationBoundary(options = {}) {
  const {
    eventStore,
    authorizer,
    resolvers,
    clock = () => new Date().toISOString(),
    maxGlobalCasRetries = 3,
    dependencyTimeoutMs = 5_000,
  } = options;
  validateDependency(eventStore && typeof eventStore.replay === "function", "eventStore.replay");
  validateDependency(eventStore && typeof eventStore.commit === "function", "eventStore.commit");
  validateDependency(authorizer && typeof authorizer.authenticate === "function", "authorizer.authenticate");
  validateDependency(authorizer && typeof authorizer.authorize === "function", "authorizer.authorize");
  validateDependency(resolvers && typeof resolvers.resolveProject === "function", "resolvers.resolveProject");
  validateDependency(
    resolvers && typeof resolvers.resolveObservationFacts === "function",
    "resolvers.resolveObservationFacts",
  );
  validateDependency(typeof clock === "function", "clock");
  if (!Number.isSafeInteger(maxGlobalCasRetries)
      || maxGlobalCasRetries < 0
      || maxGlobalCasRetries > 10) {
    throw new TypeError("maxGlobalCasRetries must be an integer from 0 to 10");
  }
  if (!Number.isSafeInteger(dependencyTimeoutMs)
      || dependencyTimeoutMs < 1
      || dependencyTimeoutMs > 60_000) {
    throw new TypeError("dependencyTimeoutMs must be an integer from 1 to 60000");
  }
  const projectionConfig = projectorConfiguration();

  async function execute(input) {
    if (!isPlainObject(input) || !Object.hasOwn(input, "observation")) {
      throw new TypeError("execute input must contain observation and authentication");
    }
    if (input.replay_only !== undefined
        && input.replay_only !== true
        && input.replay_only !== false) {
      throw new TypeError("execute input replay_only must be a boolean when provided");
    }
    const executionMode = input.replay_only === true ? "receipt_replay" : "live";
    const requestSignal = validateSignal(input.signal);
    let observation;
    try {
      observation = normalizeBusinessRuntimeObservationEnvelope(input.observation);
    } catch (error) {
      throw boundaryError(
        "BUSINESS_OBSERVATION_ENVELOPE_INVALID",
        "Runtime observation does not satisfy an enabled exact contract",
        { cause_code: error?.code || null },
      );
    }
    for (let casAttempt = 0; casAttempt <= maxGlobalCasRetries; casAttempt += 1) {
      // Authentication, current project resolution, fact attestation, and
      // authorization are deliberately repeated after every global CAS loss.
      const principal = await authenticate(
        authorizer,
        input.authentication,
        requestSignal,
        dependencyTimeoutMs,
      );
      validateActorBinding(observation, principal);
      const identityHashes = observationIdentityHashes(observation, principal);
      const replay = await replayProjection(
        eventStore,
        projectionConfig,
        requestSignal,
        dependencyTimeoutMs,
      );
      const projection = replay.state;
      const workOrder = projection.work_orders[observation.work_order_id];
      if (!workOrder) {
        throw boundaryError(
          "BUSINESS_OBSERVATION_WORK_ORDER_NOT_FOUND",
          "Work Order does not exist",
          { work_order_id: observation.work_order_id },
        );
      }
      const plan = normalizedPlan(workOrder, observation);
      const project = await resolveProject(
        resolvers,
        plan,
        principal,
        requestSignal,
        dependencyTimeoutMs,
      );
      const branch = branchFor(workOrder, observation);
      const baseContext = {
        observation,
        workOrder,
        plan,
        project,
        branch,
        principal,
        deliveryEffect: null,
        settlementEffect: null,
        sendExpiryEffect: null,
        presendFailureEffect: null,
        staleDeliveryReason: null,
        timeoutEffect: null,
      };
      // Exact receipt replay depends only on authenticated identity and the
      // immutable current scope. It must not depend on a now-terminal effect or
      // on a resolver recreating the original delivery attestation.
      await authorize(
        authorizer,
        baseContext,
        requestSignal,
        dependencyTimeoutMs,
      );
      const replayedResult = readReceipt(projection, observation, identityHashes);
      if (replayedResult !== RECEIPT_NOT_FOUND) return replayedResult;
      if (executionMode === "receipt_replay") {
        throw boundaryError(
          "BUSINESS_OBSERVATION_RECEIPT_NOT_FOUND",
          "Replay-only observation ingress requires an existing exact receipt",
          { observation_id: observation.observation_id },
        );
      }
      if (observation.name === EFFECT_PRESEND_FAILURE_OBSERVATION_NAME
          && principal.type !== "system") {
        throw boundaryError(
          "BUSINESS_OBSERVATION_PRESEND_FAILURE_SYSTEM_REQUIRED",
          "Live pre-send control-plane failure requires an authenticated system principal",
        );
      }
      if (workOrder.engine_contract_version !== BUSINESS_ENGINE_CONTRACT_VERSION) {
        throw boundaryError(
          "BUSINESS_ENGINE_MIGRATION_REQUIRED",
          "Legacy Work Orders are replay-only until an explicit engine migration is committed",
          {
            work_order_id: observation.work_order_id,
            engine_contract_version: workOrder.engine_contract_version ?? 1,
          },
        );
      }
      if (isProviderSettlementObservation(observation)
          && projection.provider_settlement_epoch === null) {
        throw boundaryError(
          "BUSINESS_OBSERVATION_PROVIDER_SETTLEMENT_CUTOVER_REQUIRED",
          "Live provider settlement is disabled until the journal-global V2 cutover is durable",
          { observation_id: observation.observation_id },
        );
      }
      validateRecoveryProbeLedgerAdmission(projection, workOrder, observation);
      if (WITHHELD_LIVE_OBSERVATIONS.has(observation.name)) {
        throw boundaryError(
          "BUSINESS_OBSERVATION_TURN_BINDING_REQUIRED",
          "Live provider callbacks require the forthcoming effect-bound turn observation contract",
        );
      }

      const context = {
        ...baseContext,
        deliveryEffect: currentDeliveryEffect(
          projection,
          observation,
          branch,
        ),
        settlementEffect: effectSettlementBinding(
          projection,
          observation,
          branch,
        ),
        sendExpiryEffect: effectSendExpiryBinding(
          projection,
          observation,
          branch,
        ),
        presendFailureEffect: effectPresendFailureBinding(
          projection,
          observation,
          branch,
        ),
        timeoutEffect: currentTimeoutEffect(
          projection,
          observation,
          branch,
        ),
      };
      const resolvedFacts = await resolveObservationFacts(
        resolvers,
        context,
        requestSignal,
        dependencyTimeoutMs,
      );
      validateResolvedBindings(context, resolvedFacts);
      // A CAS retry is a fresh candidate built from a newer authoritative
      // projection. Reusing the previous candidate's timestamp can move an
      // outbox transition backwards after a concurrent lease renewal.
      const occurredAt = validateClockValue(clock());
      const trustedFacts = decisionFacts(context, resolvedFacts, projection, occurredAt);
      let rawDecision;
      try {
        rawDecision = decideWorkOrderV1(workOrder, observation, trustedFacts);
      } catch (error) {
        throw boundaryError(
          "BUSINESS_OBSERVATION_DECISION_INVALID",
          "Official Work Order decider rejected the trusted observation",
          {
            cause_code: error?.code || null,
            cause_message: error?.message || null,
            cause_details: error?.details || null,
          },
        );
      }
      const decision = normalizeDecision(rawDecision, context, occurredAt);
      const receipt = receiptEvent(
        context,
        identityHashes,
        decision,
        occurredAt,
        projection.provider_settlement_epoch,
      );
      const request = {
        expected_revision: replay.watermark.journal_sequence,
        batch_id: receipt.batchId,
        actor: receipt.actor,
        correlation_id: observation.observation_id,
        events: [...decision.events, receipt.event],
      };
      const projectedResult = prevalidateCandidateBatch(
        projection,
        request,
        observation,
        identityHashes,
      );
      if (canonicalJson(projectedResult) !== canonicalJson(decision.result)) {
        throw boundaryError(
          "BUSINESS_OBSERVATION_DECISION_INVALID",
          "Projected observation result differs from the official decision result",
        );
      }

      if (requestSignal?.aborted) {
        throw boundaryError(
          "BUSINESS_OBSERVATION_ABORTED",
          "Observation request was aborted before the durable commit boundary",
          { dependency: "eventStore.commit" },
        );
      }
      try {
        const commitResult = await eventStore.commit(request);
        if (!isPlainObject(commitResult)
            || !["committed", "idempotent"].includes(commitResult.status)) {
          throw boundaryError(
            "BUSINESS_OBSERVATION_EVENT_STORE_RESULT_INVALID",
            "EventStore returned an invalid commit result",
          );
        }
        if (commitResult.status === "idempotent") {
          // Once commit begins, caller cancellation cannot safely classify the
          // write. Finish bounded receipt reconciliation independently.
          const committed = await replayProjection(
            eventStore,
            projectionConfig,
            null,
            dependencyTimeoutMs,
          );
          const stored = readReceipt(committed.state, observation, identityHashes);
          if (stored === RECEIPT_NOT_FOUND) {
            throw boundaryError(
              "BUSINESS_OBSERVATION_RECEIPT_MISSING",
              "Idempotent EventStore batch has no observation receipt",
            );
          }
          return stored;
        }
        return canonicalClone(decision.result, "BUSINESS_OBSERVATION_DECISION_INVALID");
      } catch (error) {
        // A transport can lose the commit response after the durable append.
        // Reconcile by exact identity, never by batch ID alone.
        let concurrent;
        try {
          concurrent = await replayProjection(
            eventStore,
            projectionConfig,
            null,
            dependencyTimeoutMs,
          );
        } catch (recoveryError) {
          throw boundaryError(
            "BUSINESS_OBSERVATION_EVENT_STORE_COMMIT_FAILED",
            "Observation commit outcome could not be reconciled to an exact durable receipt",
            {
              cause_code: error?.code || null,
              recovery_code: recoveryError?.code || null,
              commit_outcome: "unknown",
            },
          );
        }
        const stored = readReceipt(concurrent.state, observation, identityHashes);
        if (stored !== RECEIPT_NOT_FOUND) return stored;
        if (["EVENT_REVISION_CONFLICT", "EVENT_LOCK_BUSY"].includes(error?.code)) {
          if (casAttempt < maxGlobalCasRetries) continue;
          throw boundaryError(
            "BUSINESS_OBSERVATION_GLOBAL_CAS_EXHAUSTED",
            "Global EventStore revision changed too many times",
            { attempts: casAttempt + 1 },
          );
        }
        const mapped = mapBatchConflict(error, observation.observation_id);
        if (mapped instanceof BusinessObservationBoundaryError) throw mapped;
        throw boundaryError(
          "BUSINESS_OBSERVATION_EVENT_STORE_COMMIT_FAILED",
          "Observation commit failed without a matching durable receipt",
          { cause_code: mapped?.code || null, commit_outcome: "not_observed" },
        );
      }
    }
    throw boundaryError(
      "BUSINESS_OBSERVATION_GLOBAL_CAS_EXHAUSTED",
      "Global EventStore revision retry bound was exhausted",
    );
  }

  return Object.freeze({ execute });
}

module.exports = {
  LIVE_RUNTIME_OBSERVATION_NAMES,
  BusinessObservationBoundaryError,
  createBusinessObservationBoundary,
};
