"use strict";

const { canonicalHash, canonicalJson } = require("@orquesta/contracts");
const {
  BUSINESS_ENGINE_CONTRACT_VERSION,
  CONTRACT_LIMITS,
  EFFECT_PRESEND_FAILURE_OBSERVATION_NAMES,
  EFFECT_SEND_EXPIRY_OBSERVATION_NAMES,
  EFFECT_SETTLEMENT_OBSERVATION_NAMES,
  normalizeBusinessRuntimeObservationEnvelope,
  normalizeBusinessWorkOrderPlanV1,
  normalizeCommandEnvelopeV1,
} = require("./contract");
const {
  V2_EFFECT_IDENTITY_FIELDS,
  deriveEffectOperationScopeHashV2,
} = require("./lifecycle");
const {
  deriveEffectGenerationRetryScheduleV2,
  deriveSettlementDispositionV2,
  normalizeSettlementPolicyRecordV2,
} = require("./settlement-policy");

const BUSINESS_EVENT_SCHEMA_VERSION = 1;
const EFFECT_SETTLEMENT_OBSERVATION_NAME = EFFECT_SETTLEMENT_OBSERVATION_NAMES[0];
const EFFECT_SEND_EXPIRY_OBSERVATION_NAME = EFFECT_SEND_EXPIRY_OBSERVATION_NAMES[0];
const EFFECT_PRESEND_FAILURE_OBSERVATION_NAME = EFFECT_PRESEND_FAILURE_OBSERVATION_NAMES[0];

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

const TERMINAL_WORK_ORDER_STATES = new Set(["accepted", "failed", "cancelled"]);
const TERMINAL_BRANCH_STATES = new Set(["accepted", "failed", "cancelled"]);
const SLOT_BRANCH_STATES = new Set([
  "dispatch_pending",
  "running",
  "waiting_for_user",
  "delivery_unknown",
  "cancelling",
]);
const CURRENT_ATTEMPT_OBSERVATIONS = new Set([
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
  "provider.rate_limited",
  "provider.unavailable",
]);
const CURRENT_DISPATCH_OBSERVATIONS = new Set([
  EFFECT_SETTLEMENT_OBSERVATION_NAME,
  EFFECT_SEND_EXPIRY_OBSERVATION_NAME,
  EFFECT_PRESEND_FAILURE_OBSERVATION_NAME,
  "provider.effect.delivery.recorded",
  "branch.dispatch.accepted",
  "branch.dispatch.not_sent",
  "branch.delivery_unknown",
]);
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
const REVIEW_COUNTS = Object.freeze({ light: 0, normal: 1, strict: 2 });
const OUTBOX_EFFECT_IDENTITY_FIELDS = V2_EFFECT_IDENTITY_FIELDS;

class BusinessDecisionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "BusinessDecisionError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new BusinessDecisionError(code, message, details);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function object(value, path) {
  if (!isPlainObject(value)) fail("BUSINESS_DECISION_INVALID", `${path} must be an object`, { path });
  return value;
}

function cloneJson(value, path) {
  let serialized;
  try {
    serialized = canonicalJson(value);
  } catch (error) {
    fail("BUSINESS_DECISION_INVALID", `${path} must be canonical JSON`, {
      path,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (Buffer.byteLength(serialized, "utf8") > CONTRACT_LIMITS.max_plan_bytes * 4) {
    fail("BUSINESS_DECISION_LIMIT", `${path} is too large`, { path });
  }
  return JSON.parse(serialized);
}

function portableRef(value, path) {
  if (typeof value !== "string" || value.trim() === "") {
    fail("BUSINESS_DECISION_INVALID", `${path} must be a non-empty reference`, { path });
  }
  const normalized = value.trim();
  if (Buffer.byteLength(normalized, "utf8") > CONTRACT_LIMITS.max_ref_bytes
      || !/^[A-Za-z0-9][A-Za-z0-9._:/@+\-]*$/u.test(normalized)) {
    fail("BUSINESS_DECISION_INVALID", `${path} must be a portable reference`, { path });
  }
  return normalized;
}

function sha256(value, path) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    fail("BUSINESS_DECISION_INVALID", `${path} must be a lowercase SHA-256 hash`, { path });
  }
  return value;
}

function integer(value, path, minimum = 0, maximum = 1_000_000_000) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail("BUSINESS_DECISION_INVALID", `${path} must be an integer from ${minimum} to ${maximum}`, {
      path,
    });
  }
  return value;
}

function timestamp(value, path) {
  if (typeof value !== "string" || value.length > 64) {
    fail("BUSINESS_DECISION_INVALID", `${path} must be a canonical UTC timestamp`, { path });
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    fail("BUSINESS_DECISION_INVALID", `${path} must be a canonical UTC timestamp`, { path });
  }
  return value;
}

function contentRef(value, path) {
  const ref = object(value, path);
  const keys = Object.keys(ref).sort();
  if (keys.length !== 2 || keys[0] !== "hash" || keys[1] !== "id") {
    fail("BUSINESS_DECISION_INVALID", `${path} must contain only id and hash`, { path });
  }
  return { id: portableRef(ref.id, `${path}.id`), hash: sha256(ref.hash, `${path}.hash`) };
}

function referenceArray(value, path, { minimum = 0 } = {}) {
  if (!Array.isArray(value) || value.length < minimum
      || value.length > CONTRACT_LIMITS.max_evidence_refs) {
    fail("BUSINESS_DECISION_LIMIT", `${path} has an invalid item count`, { path });
  }
  const normalized = value.map((entry, index) => portableRef(entry, `${path}[${index}]`));
  if (new Set(normalized).size !== normalized.length) {
    fail("BUSINESS_DECISION_INVALID", `${path} must contain unique references`, { path });
  }
  return normalized.sort(compareText);
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function same(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function addMilliseconds(iso, milliseconds) {
  return new Date(Date.parse(iso) + milliseconds).toISOString();
}

function minTimestamp(left, right) {
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

function normalizeRuntimeIdentity(value, path, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) fail("BUSINESS_RUNTIME_IDENTITY_REQUIRED", `${path} is required`, { path });
    return null;
  }
  const identity = object(value, path);
  const allowed = new Set(["operation_id", "thread_id", "turn_id"]);
  for (const key of Object.keys(identity)) {
    if (!allowed.has(key)) fail("BUSINESS_DECISION_INVALID", `${path}.${key} is not supported`, { path });
  }
  const normalized = {};
  for (const field of allowed) {
    normalized[field] = identity[field] === undefined || identity[field] === null
      ? null
      : portableRef(identity[field], `${path}.${field}`);
  }
  if (Object.values(normalized).every((entry) => entry === null)) {
    fail("BUSINESS_RUNTIME_IDENTITY_REQUIRED", `${path} must identify a provider operation`, { path });
  }
  return normalized;
}

function normalizeInput(input) {
  object(input, "input");
  const hasCommand = Object.hasOwn(input, "command_id");
  const hasObservation = Object.hasOwn(input, "observation_id");
  if (hasCommand === hasObservation) {
    fail(
      "BUSINESS_INPUT_KIND",
      "input must be exactly one normalized command or runtime observation",
    );
  }
  try {
    return hasCommand
      ? { kind: "command", envelope: normalizeCommandEnvelopeV1(input) }
      : { kind: "observation", envelope: normalizeBusinessRuntimeObservationEnvelope(input) };
  } catch (error) {
    fail("BUSINESS_INPUT_INVALID", "input does not satisfy an enabled public contract", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function normalizeState(input) {
  if (input === null || input === undefined) return null;
  const state = cloneJson(input, "state");
  object(state, "state");
  portableRef(state.work_order_id, "state.work_order_id");
  portableRef(state.plan_snapshot_ref, "state.plan_snapshot_ref");
  sha256(state.plan_hash, "state.plan_hash");
  state.engine_contract_version = state.engine_contract_version === undefined
    ? 1
    : integer(state.engine_contract_version, "state.engine_contract_version", 1, 2);
  integer(state.revision, "state.revision", 1);
  if (!WORK_ORDER_STATES.includes(state.status)) {
    fail("BUSINESS_STATE_INVALID", `unsupported Work Order state: ${state.status}`);
  }
  let plan;
  try {
    plan = normalizeBusinessWorkOrderPlanV1(state.plan);
  } catch (error) {
    fail("BUSINESS_STATE_INVALID", "state.plan is not a normalized V1 plan", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (plan.plan_snapshot_id !== state.plan_snapshot_ref || plan.plan_hash !== state.plan_hash) {
    fail("BUSINESS_PLAN_BINDING", "state plan binding is inconsistent");
  }
  state.plan = plan;
  timestamp(state.created_at, "state.created_at");
  timestamp(state.deadline_at, "state.deadline_at");
  object(state.branches, "state.branches");
  for (const planned of plan.branches) {
    const branch = state.branches[planned.branch_ref];
    if (!branch || !BRANCH_STATES.includes(branch.state)) {
      fail("BUSINESS_STATE_INVALID", `state is missing branch ${planned.branch_ref}`);
    }
    integer(branch.attempt, `state.branches.${planned.branch_ref}.attempt`, 0, plan.retry_policy.max_attempts);
    if (!Array.isArray(branch.required_criterion_ids) || branch.required_criterion_ids.length === 0) {
      fail("BUSINESS_STATE_INVALID", `branch ${planned.branch_ref} lacks required criterion bindings`);
    }
  }
  return state;
}

function validateBinding(state, envelope) {
  if (!state) return;
  if (state.work_order_id !== envelope.work_order_id) {
    fail("BUSINESS_WORK_ORDER_BINDING", "input targets a different Work Order");
  }
  if (state.plan_snapshot_ref !== envelope.plan_snapshot_ref || state.plan_hash !== envelope.plan_hash) {
    fail("BUSINESS_PLAN_BINDING", "input targets a different immutable plan snapshot");
  }
}

function normalizeTrustedFacts(input) {
  const facts = object(input, "trustedFacts");
  return { ...facts, occurred_at: timestamp(facts.occurred_at, "trustedFacts.occurred_at") };
}

function commandRevision(state, command) {
  const current = state ? state.revision : 0;
  if (command.expected_work_order_revision !== current) {
    fail("BUSINESS_STALE_WORK_ORDER", "command expected revision does not match current state", {
      expected: command.expected_work_order_revision,
      current,
    });
  }
}

function createContext(state, inputKind, envelope, facts) {
  const priorRevision = state ? state.revision : 0;
  const sourceId = inputKind === "command" ? envelope.command_id : envelope.observation_id;
  return {
    state,
    inputKind,
    envelope,
    facts,
    sourceId,
    priorRevision,
    targetRevision: priorRevision + 1,
    events: [],
  };
}

function eventEvidence(evidenceRefs) {
  return referenceArray(evidenceRefs || [], "event.evidence_refs");
}

function emit(context, type, specific = {}, evidenceRefs = []) {
  const payload = {
    work_order_id: context.envelope.work_order_id,
    plan_snapshot_ref: context.envelope.plan_snapshot_ref,
    plan_hash: context.envelope.plan_hash,
    source_id: context.sourceId,
    prior_work_order_revision: context.priorRevision,
    target_work_order_revision: context.targetRevision,
    occurred_at: context.facts.occurred_at,
    ...specific,
  };
  const normalizedEvidence = eventEvidence(evidenceRefs);
  const ordinal = context.events.length;
  const eventId = `BEV-${canonicalHash({
    source_id: context.sourceId,
    ordinal,
    type,
    payload,
    evidence_refs: normalizedEvidence,
  }).slice(0, 32)}`;
  context.events.push({
    event_id: eventId,
    schema_version: BUSINESS_EVENT_SCHEMA_VERSION,
    type,
    payload,
    evidence_refs: normalizedEvidence,
  });
}

function branchByRef(context, branchRef) {
  const branch = context.state && context.state.branches[branchRef];
  if (!branch) fail("BUSINESS_BRANCH_NOT_FOUND", `unknown branch: ${branchRef}`, { branch_ref: branchRef });
  return branch;
}

function transitionBranch(context, branchRef, to, reason, options = {}) {
  const branch = branchByRef(context, branchRef);
  if (branch.state === to) return;
  const specific = { branch_ref: branchRef, from: branch.state, to, reason };
  if (to === "retryable") {
    specific.retry_at = timestamp(options.retry_at, "retry_at");
  }
  if (options.resolved_request_id !== undefined || options.response_ref !== undefined) {
    specific.resolved_request_id = portableRef(
      options.resolved_request_id,
      "resolved_request_id",
    );
    specific.response_ref = contentRef(options.response_ref, "response_ref");
  }
  emit(context, "business.branch.status_changed", specific, options.evidence_refs);
  branch.state = to;
  branch.retry_at = to === "retryable" ? specific.retry_at : null;
  branch.finished_at = TERMINAL_BRANCH_STATES.has(to) ? context.facts.occurred_at : null;
  branch.last_transition_reason = reason;
}

function transitionWorkOrder(context, to, reason, evidenceRefs = []) {
  if (context.state.status === to) return;
  emit(context, "business.work_order.status_changed", {
    from: context.state.status,
    to,
    reason,
  }, evidenceRefs);
  context.state.status = to;
  if (to === "running" && context.state.started_at === null) {
    context.state.started_at = context.facts.occurred_at;
  }
  if (TERMINAL_WORK_ORDER_STATES.has(to) || to === "cancelling") {
    context.state.stop_reason = reason;
  }
}

function packetFor(facts, branchRef, path = "trustedFacts.dispatch_packets") {
  const field = path.slice(path.lastIndexOf(".") + 1);
  const collection = facts[field];
  const packets = collection === undefined ? {} : object(collection, path);
  const singularField = field.endsWith("s") ? field.slice(0, -1) : "dispatch_packet";
  const candidate = packets[branchRef] || facts[singularField] || facts.dispatch_packet;
  if (!candidate) {
    fail("BUSINESS_DISPATCH_PACKET_REQUIRED", `a resolved dispatch packet is required for ${branchRef}`, {
      branch_ref: branchRef,
    });
  }
  return contentRef(candidate, `${path}.${branchRef}`);
}

function deterministicId(prefix, value) {
  return `${prefix}-${canonicalHash(value).slice(0, 32)}`;
}

function effectIdentifierSeed(effect) {
  return Object.fromEntries(V2_EFFECT_IDENTITY_FIELDS
    .filter((field) => !["effect_id", "idempotency_key", "created_at"].includes(field))
    .map((field) => [field, effect[field]]));
}

function normalizeGenerationPredecessor(
  context,
  branch,
  effectKind,
  operationScopeHash,
  value,
  path,
) {
  const fact = object(value, path);
  const expectedFields = [...OUTBOX_EFFECT_IDENTITY_FIELDS, "status"].sort(compareText);
  if (!same(Object.keys(fact).sort(compareText), expectedFields)) {
    fail(
      "BUSINESS_OUTBOX_EFFECT_GENERATION_BINDING",
      `${path} must contain the exact immutable predecessor identity and status`,
    );
  }
  const identity = normalizeOutboxEffectIdentity(
    Object.fromEntries(OUTBOX_EFFECT_IDENTITY_FIELDS.map((field) => [field, fact[field]])),
    path,
  );
  const status = portableRef(fact.status, `${path}.status`);
  const seed = effectIdentifierSeed(identity);
  if (status !== "not_sent"
      || identity.work_order_id !== context.state.work_order_id
      || identity.branch_ref !== branch.branch_ref
      || identity.attempt !== branch.attempt
      || identity.dispatch_id !== branch.dispatch_id
      || identity.effect_kind !== effectKind
      || identity.provider_ref !== branch.provider_ref
      || identity.operation_scope_hash !== operationScopeHash
      || identity.effect_id !== deterministicId("FX", seed)
      || identity.idempotency_key !== deterministicId("IDEM", seed)) {
    fail(
      "BUSINESS_OUTBOX_EFFECT_GENERATION_BINDING",
      `${path} must be the exact proven-not-sent predecessor for this operation scope`,
      {
        branch_ref: branch.branch_ref,
        effect_kind: effectKind,
        operation_scope_hash: operationScopeHash,
      },
    );
  }
  return identity;
}

function generationPredecessor(
  context,
  branch,
  effectKind,
  operationScopeHash,
) {
  if (context.facts.generation_predecessors === undefined) return null;
  const predecessors = object(
    context.facts.generation_predecessors,
    "trustedFacts.generation_predecessors",
  );
  const value = predecessors[branch.branch_ref];
  if (value === undefined) return null;
  return normalizeGenerationPredecessor(
    context,
    branch,
    effectKind,
    operationScopeHash,
    value,
    `trustedFacts.generation_predecessors.${branch.branch_ref}`,
  );
}

function outboxEffect(context, branch, packetRef, effectKind, purpose, {
  predecessorEffectId = null,
  predecessorDeliveryHash = null,
  targetRuntimeIdentity = null,
  requestId = null,
  responseRef = null,
  allowGenerationSuccessor = false,
  generationPredecessorIdentity = null,
} = {}) {
  const predecessor = predecessorEffectId === null
    ? null
    : portableRef(predecessorEffectId, "predecessor_effect_id");
  const target = targetRuntimeIdentity === null
    ? null
    : normalizeRuntimeIdentity(targetRuntimeIdentity, "target_runtime_identity", { required: true });
  const predecessorDelivery = predecessorDeliveryHash === null
    ? null
    : sha256(predecessorDeliveryHash, "predecessor_delivery_hash");
  const operationScopeHash = deriveEffectOperationScopeHashV2({
    effect_kind: effectKind,
    provider_ref: branch.provider_ref,
    packet_ref: packetRef.id,
    packet_hash: packetRef.hash,
    predecessor_effect_id: predecessor,
    predecessor_delivery_hash: predecessorDelivery,
    target_runtime_identity: target,
    request_id: effectKind === "provider.user_input.submit"
      ? portableRef(requestId, "request_id")
      : undefined,
    response_ref: effectKind === "provider.user_input.submit"
      ? contentRef(responseRef, "response_ref")
      : undefined,
  });
  const resolvedGenerationPredecessor = generationPredecessorIdentity === null
    ? (allowGenerationSuccessor
      ? generationPredecessor(context, branch, effectKind, operationScopeHash)
      : null)
    : normalizeOutboxEffectIdentity(
      generationPredecessorIdentity,
      "generation_predecessor_effect",
    );
  if (resolvedGenerationPredecessor !== null
      && (resolvedGenerationPredecessor.work_order_id !== context.state.work_order_id
        || resolvedGenerationPredecessor.branch_ref !== branch.branch_ref
        || resolvedGenerationPredecessor.attempt !== branch.attempt
        || resolvedGenerationPredecessor.dispatch_id !== branch.dispatch_id
        || resolvedGenerationPredecessor.effect_kind !== effectKind
        || resolvedGenerationPredecessor.provider_ref !== branch.provider_ref
        || resolvedGenerationPredecessor.operation_scope_hash !== operationScopeHash)) {
    fail(
      "BUSINESS_OUTBOX_EFFECT_GENERATION_BINDING",
      "the direct generation predecessor must bind the same operation scope",
      {
        branch_ref: branch.branch_ref,
        effect_kind: effectKind,
        operation_scope_hash: operationScopeHash,
      },
    );
  }
  const operationGeneration = resolvedGenerationPredecessor === null
    ? 1
    : resolvedGenerationPredecessor.operation_generation + 1;
  const identity = {
    effect_contract_version: 2,
    work_order_id: context.state.work_order_id,
    branch_ref: branch.branch_ref,
    attempt: branch.attempt,
    dispatch_id: branch.dispatch_id,
    effect_kind: effectKind,
    origin_source_id: context.sourceId,
    operation_scope_hash: operationScopeHash,
    operation_generation: operationGeneration,
    generation_predecessor_effect_id: resolvedGenerationPredecessor?.effect_id || null,
    provider_ref: branch.provider_ref,
    packet_ref: packetRef.id,
    packet_hash: packetRef.hash,
    predecessor_effect_id: predecessor,
    predecessor_delivery_hash: predecessorDelivery,
    target_runtime_identity: target,
  };
  void purpose;
  return {
    effect_id: deterministicId("FX", identity),
    effect_contract_version: 2,
    work_order_id: context.state.work_order_id,
    branch_ref: branch.branch_ref,
    attempt: branch.attempt,
    dispatch_id: branch.dispatch_id,
    effect_kind: effectKind,
    origin_source_id: context.sourceId,
    operation_scope_hash: operationScopeHash,
    operation_generation: operationGeneration,
    generation_predecessor_effect_id: resolvedGenerationPredecessor?.effect_id || null,
    provider_ref: branch.provider_ref,
    packet_ref: packetRef.id,
    packet_hash: packetRef.hash,
    predecessor_effect_id: predecessor,
    predecessor_delivery_hash: predecessorDelivery,
    target_runtime_identity: target,
    idempotency_key: deterministicId("IDEM", identity),
    status: "pending",
    lease: null,
    delivery: null,
    created_at: context.facts.occurred_at,
    updated_at: context.facts.occurred_at,
  };
}

function normalizeOutboxEffectIdentity(value, path) {
  const effect = object(value, path);
  if (!same(Object.keys(effect).sort(compareText), [...OUTBOX_EFFECT_IDENTITY_FIELDS].sort(compareText))) {
    fail("BUSINESS_OUTBOX_EFFECT_BINDING", `${path} must contain the exact immutable effect identity`);
  }
  const normalized = {
    effect_id: portableRef(effect.effect_id, `${path}.effect_id`),
    effect_contract_version: integer(
      effect.effect_contract_version,
      `${path}.effect_contract_version`,
      2,
      2,
    ),
    work_order_id: portableRef(effect.work_order_id, `${path}.work_order_id`),
    branch_ref: portableRef(effect.branch_ref, `${path}.branch_ref`),
    attempt: integer(effect.attempt, `${path}.attempt`, 1, 5),
    dispatch_id: portableRef(effect.dispatch_id, `${path}.dispatch_id`),
    effect_kind: portableRef(effect.effect_kind, `${path}.effect_kind`),
    origin_source_id: portableRef(effect.origin_source_id, `${path}.origin_source_id`),
    operation_scope_hash: sha256(
      effect.operation_scope_hash,
      `${path}.operation_scope_hash`,
    ),
    operation_generation: integer(
      effect.operation_generation,
      `${path}.operation_generation`,
      1,
    ),
    generation_predecessor_effect_id: effect.generation_predecessor_effect_id === null
      ? null
      : portableRef(
        effect.generation_predecessor_effect_id,
        `${path}.generation_predecessor_effect_id`,
      ),
    provider_ref: portableRef(effect.provider_ref, `${path}.provider_ref`),
    packet_ref: portableRef(effect.packet_ref, `${path}.packet_ref`),
    packet_hash: sha256(effect.packet_hash, `${path}.packet_hash`),
    predecessor_effect_id: effect.predecessor_effect_id === null
      ? null
      : portableRef(effect.predecessor_effect_id, `${path}.predecessor_effect_id`),
    predecessor_delivery_hash: effect.predecessor_delivery_hash === null
      ? null
      : sha256(effect.predecessor_delivery_hash, `${path}.predecessor_delivery_hash`),
    target_runtime_identity: effect.target_runtime_identity === null
      ? null
      : normalizeRuntimeIdentity(
        effect.target_runtime_identity,
        `${path}.target_runtime_identity`,
        { required: true },
      ),
    idempotency_key: portableRef(effect.idempotency_key, `${path}.idempotency_key`),
    created_at: timestamp(effect.created_at, `${path}.created_at`),
  };
  if ((normalized.operation_generation === 1)
      !== (normalized.generation_predecessor_effect_id === null)) {
    fail(
      "BUSINESS_OUTBOX_EFFECT_GENERATION_BINDING",
      `${path} generation 1 must be a root and every successor must name its predecessor`,
    );
  }
  return normalized;
}

function currentDispatchStage(branch) {
  if (branch.turn_start_effect_id) return null;
  if (branch.thread_create_effect_id) return "provider.turn.start";
  return "provider.thread.create";
}

function assertEffectBindsBranch(context, branch, effect, path, expectedKind) {
  const isThreadCreate = expectedKind === "provider.thread.create";
  const isTurnStart = expectedKind === "provider.turn.start";
  const isStart = isThreadCreate || isTurnStart;
  const expectedPredecessor = isTurnStart
    ? branch.thread_create_effect_id
    : (isThreadCreate ? null : branch.turn_start_effect_id);
  const expectedPredecessorDelivery = isTurnStart
    ? branch.thread_create_delivery_hash
    : (isThreadCreate ? null : branch.turn_start_delivery_hash);
  const expectedTarget = isTurnStart
    ? branch.thread_identity
    : (isThreadCreate ? null : branch.runtime_identity);
  if (effect.work_order_id !== context.state.work_order_id
      || effect.branch_ref !== branch.branch_ref
      || effect.attempt !== branch.attempt
      || effect.dispatch_id !== branch.dispatch_id
      || effect.provider_ref !== branch.provider_ref
      || effect.effect_kind !== expectedKind
      || (isStart && (!branch.packet_ref
        || effect.packet_ref !== branch.packet_ref.id
        || effect.packet_hash !== branch.packet_ref.hash))
      || (isThreadCreate && effect.created_at !== branch.attempt_started_at)
      || (!isThreadCreate && Date.parse(effect.created_at) < Date.parse(branch.attempt_started_at))
      || effect.predecessor_effect_id !== expectedPredecessor
      || effect.predecessor_delivery_hash !== expectedPredecessorDelivery
      || !same(effect.target_runtime_identity, expectedTarget)) {
    fail(
      "BUSINESS_OUTBOX_EFFECT_BINDING",
      `${path} does not bind the current branch attempt and provider effect`,
      { branch_ref: branch.branch_ref, attempt: branch.attempt },
    );
  }
  if (expectedKind === "provider.user_input.submit"
      && branch.pending_user_input_effect_id !== effect.effect_id) {
    fail(
      "BUSINESS_OUTBOX_EFFECT_BINDING",
      `${path} is not the current user-input submission effect`,
    );
  }
}

function enqueueStartGenerationSuccessor(
  context,
  branch,
  generationPredecessorIdentity,
  evidenceRefs,
  reason,
) {
  const expectedKind = currentDispatchStage(branch);
  if (!expectedKind
      || generationPredecessorIdentity.effect_kind !== expectedKind
      || !branch.packet_ref
      || generationPredecessorIdentity.packet_ref !== branch.packet_ref.id
      || generationPredecessorIdentity.packet_hash !== branch.packet_ref.hash) {
    fail(
      "BUSINESS_OUTBOX_EFFECT_GENERATION_BINDING",
      "a start generation successor must preserve the current stage and packet",
      { branch_ref: branch.branch_ref, effect_kind: expectedKind },
    );
  }
  if (branch.state === "delivery_unknown") {
    transitionBranch(context, branch.branch_ref, "retryable", reason, {
      retry_at: context.facts.occurred_at,
      evidence_refs: evidenceRefs,
    });
  }
  if (!["dispatch_pending", "retryable"].includes(branch.state)) {
    fail(
      "BUSINESS_RETRY_NOT_SAFE",
      "an Effect generation successor requires one pending or retryable start stage",
      { branch_ref: branch.branch_ref, branch_state: branch.state },
    );
  }
  const effect = outboxEffect(
    context,
    branch,
    branch.packet_ref,
    expectedKind,
    reason,
    {
      predecessorEffectId: expectedKind === "provider.turn.start"
        ? branch.thread_create_effect_id
        : null,
      predecessorDeliveryHash: expectedKind === "provider.turn.start"
        ? branch.thread_create_delivery_hash
        : null,
      targetRuntimeIdentity: expectedKind === "provider.turn.start"
        ? branch.thread_identity
        : null,
      generationPredecessorIdentity,
    },
  );
  emit(context, "business.outbox.enqueued", { effect }, evidenceRefs);
  // The semantic enqueue is the activation event. The projector performs the
  // same materialization after validating the predecessor's durable policy.
  branch.state = "dispatch_pending";
  branch.retry_at = null;
  branch.delivery = null;
  branch.finished_at = null;
  branch.last_transition_reason = reason;
  return effect;
}

function openAttempt(context, branchRef, packetRef, reason) {
  const branch = branchByRef(context, branchRef);
  const attempt = branch.attempt + 1;
  if (attempt > context.state.plan.retry_policy.max_attempts) {
    fail("BUSINESS_RETRY_EXHAUSTED", `branch ${branchRef} exhausted its attempt limit`);
  }
  if (Date.parse(context.facts.occurred_at) >= Date.parse(context.state.deadline_at)) {
    fail("BUSINESS_ELAPSED_LIMIT", "the Work Order elapsed limit has expired");
  }
  const dispatchId = deterministicId("DSP", {
    work_order_id: context.state.work_order_id,
    branch_ref: branchRef,
    attempt,
    packet_ref: packetRef,
  });
  const attemptDeadline = minTimestamp(
    addMilliseconds(context.facts.occurred_at, context.state.plan.retry_policy.attempt_timeout_ms),
    context.state.deadline_at,
  );
  if (Date.parse(attemptDeadline) <= Date.parse(context.facts.occurred_at)) {
    fail("BUSINESS_ELAPSED_LIMIT", "there is no time remaining for another attempt");
  }
  emit(context, "business.branch.attempt_opened", {
    branch_ref: branchRef,
    attempt,
    dispatch_id: dispatchId,
    attempt_started_at: context.facts.occurred_at,
    attempt_deadline_at: attemptDeadline,
    packet_ref: packetRef,
  });
  branch.state = "dispatch_pending";
  branch.attempt = attempt;
  branch.dispatch_id = dispatchId;
  branch.packet_ref = packetRef;
  branch.attempt_started_at = context.facts.occurred_at;
  branch.attempt_deadline_at = attemptDeadline;
  branch.retry_at = null;
  branch.delivery = null;
  branch.runtime_identity = null;
  branch.thread_identity = null;
  branch.open_user_input = null;
  branch.pending_user_input_effect_id = null;
  branch.pending_user_input_response_ref = null;
  branch.result = null;
  branch.verification_by_criterion = {};
  branch.last_progress_at = null;
  branch.finished_at = null;
  branch.thread_create_effect_id = null;
  branch.thread_create_delivery_hash = null;
  branch.turn_start_effect_id = null;
  branch.turn_start_delivery_hash = null;
  branch.cancel_effect_id = null;
  const effect = outboxEffect(context, branch, packetRef, "provider.thread.create", reason);
  emit(context, "business.outbox.enqueued", { effect });
}

function activeSlotCount(state) {
  return Object.values(state.branches).filter((branch) => SLOT_BRANCH_STATES.has(branch.state)).length;
}

function availableSlotCount(state) {
  return state.plan.max_concurrency - activeSlotCount(state);
}

function dependenciesAccepted(state, branch) {
  return branch.dependencies.every((ref) => state.branches[ref].state === "accepted");
}

function releaseReadyBranches(context, evidenceRefs = []) {
  for (const branchRef of Object.keys(context.state.branches).sort(compareText)) {
    const branch = context.state.branches[branchRef];
    if (branch.state === "blocked" && dependenciesAccepted(context.state, branch)) {
      transitionBranch(context, branchRef, "ready", "dependencies_accepted", { evidence_refs: evidenceRefs });
    }
  }
}

function scheduleEligible(context, reason, evidenceRefs = []) {
  if (!["starting", "running"].includes(context.state.status)) return [];
  if (Date.parse(context.facts.occurred_at) >= Date.parse(context.state.deadline_at)) return [];
  releaseReadyBranches(context, evidenceRefs);
  const capacity = availableSlotCount(context.state);
  if (capacity <= 0) return [];
  const selected = Object.values(context.state.branches)
    .filter((branch) => branch.state === "ready" && dependenciesAccepted(context.state, branch))
    .sort((left, right) => compareText(left.branch_ref, right.branch_ref))
    .slice(0, capacity);
  const packets = selected.map((branch) => [
    branch.branch_ref,
    packetFor(context.facts, branch.branch_ref),
  ]);
  for (const [branchRef, packetRef] of packets) openAttempt(context, branchRef, packetRef, reason);
  return selected.map((branch) => branch.branch_ref);
}

function recomputeParentStatus(context, reason, evidenceRefs = []) {
  const state = context.state;
  if (TERMINAL_WORK_ORDER_STATES.has(state.status) || state.status === "cancelling") return;
  const branches = Object.values(state.branches);
  if (branches.every((branch) => branch.state === "accepted")) {
    transitionWorkOrder(context, "awaiting_acceptance", "all_required_branches_accepted", evidenceRefs);
    return;
  }
  const active = branches.some((branch) => (
    SLOT_BRANCH_STATES.has(branch.state) || branch.state === "verifying" || branch.state === "retryable"
  ));
  const runnable = branches.some((branch) => (
    branch.state === "ready" && dependenciesAccepted(state, branch)
  ));
  if (!active && !runnable) {
    transitionWorkOrder(context, "paused", reason || "unresolved_branch_blocker", evidenceRefs);
  } else if (state.status === "paused") {
    transitionWorkOrder(context, "running", reason || "runnable_work_available", evidenceRefs);
  }
}

function branchCriterionBindings(plan, facts) {
  const bindings = object(facts.branch_criterion_ids, "trustedFacts.branch_criterion_ids");
  const plannedRefs = plan.branches.map((branch) => branch.branch_ref).sort(compareText);
  const suppliedRefs = Object.keys(bindings).sort(compareText);
  if (!same(plannedRefs, suppliedRefs)) {
    fail("BUSINESS_CRITERION_BINDING", "criterion bindings must exactly cover every plan branch");
  }
  const allowed = new Set(plan.acceptance_policy.criteria.map((criterion) => criterion.criterion_id));
  const normalized = {};
  for (const branch of plan.branches) {
    const values = bindings[branch.branch_ref];
    if (!Array.isArray(values) || values.length === 0 || values.length > allowed.size) {
      fail("BUSINESS_CRITERION_BINDING", `branch ${branch.branch_ref} needs bounded criteria`);
    }
    normalized[branch.branch_ref] = values.map((value, index) => {
      const ref = portableRef(value, `trustedFacts.branch_criterion_ids.${branch.branch_ref}[${index}]`);
      if (!allowed.has(ref)) {
        fail("BUSINESS_CRITERION_BINDING", `branch ${branch.branch_ref} references unknown criterion ${ref}`);
      }
      return ref;
    }).sort(compareText);
    if (new Set(normalized[branch.branch_ref]).size !== normalized[branch.branch_ref].length) {
      fail("BUSINESS_CRITERION_BINDING", `branch ${branch.branch_ref} has duplicate criteria`);
    }
  }
  const finalRef = plan.integration_branch_ref || plan.branches[0].branch_ref;
  if (!same(normalized[finalRef], [...allowed].sort(compareText))) {
    fail("BUSINESS_CRITERION_BINDING", "the final branch must verify every acceptance criterion");
  }
  return normalized;
}

function startWorkOrder(context) {
  if (context.state !== null) fail("BUSINESS_WORK_ORDER_EXISTS", "the Work Order already exists");
  commandRevision(null, context.envelope);
  let plan;
  try {
    plan = normalizeBusinessWorkOrderPlanV1(context.facts.plan);
  } catch (error) {
    fail("BUSINESS_PLAN_INVALID", "trustedFacts.plan is not a valid V1 plan", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (plan.plan_snapshot_id !== context.envelope.plan_snapshot_ref
      || plan.plan_hash !== context.envelope.plan_hash) {
    fail("BUSINESS_PLAN_BINDING", "start command does not match the resolved plan snapshot");
  }
  const criterionBindings = branchCriterionBindings(plan, context.facts);
  const receipt = object(context.facts.context_budget_receipt, "trustedFacts.context_budget_receipt");
  const contextReceipt = {
    budget_tokens: integer(
      receipt.budget_tokens,
      "trustedFacts.context_budget_receipt.budget_tokens",
      0,
      100_000_000,
    ),
    duplicate_context_tokens: integer(
      receipt.duplicate_context_tokens,
      "trustedFacts.context_budget_receipt.duplicate_context_tokens",
      0,
      100_000_000,
    ),
    evidence_refs: referenceArray(
      receipt.evidence_refs,
      "trustedFacts.context_budget_receipt.evidence_refs",
      { minimum: 1 },
    ),
  };
  if (contextReceipt.budget_tokens !== plan.context_duplication_budget_tokens
      || contextReceipt.duplicate_context_tokens > contextReceipt.budget_tokens) {
    fail("BUSINESS_CONTEXT_BUDGET", "resolved context exceeds the immutable duplication budget");
  }
  const deadlineAt = addMilliseconds(context.facts.occurred_at, plan.retry_policy.max_elapsed_ms);
  emit(context, "business.work_order.created", {
    plan,
    deadline_at: deadlineAt,
    engine_contract_version: BUSINESS_ENGINE_CONTRACT_VERSION,
  });
  context.state = {
    work_order_id: context.envelope.work_order_id,
    engine_contract_version: BUSINESS_ENGINE_CONTRACT_VERSION,
    plan_snapshot_ref: plan.plan_snapshot_id,
    plan_hash: plan.plan_hash,
    plan,
    revision: 1,
    status: "starting",
    created_at: context.facts.occurred_at,
    started_at: null,
    deadline_at: deadlineAt,
    stop_reason: null,
    branches: {},
    attention: {},
    acceptance: {
      context_budget: contextReceipt,
      reviews: {},
      decision: null,
      decision_history: [],
    },
  };
  emit(context, "business.context_budget.verified", { receipt: contextReceipt }, contextReceipt.evidence_refs);
  for (const branch of plan.branches) {
    const initialState = branch.dependencies.length === 0 ? "ready" : "blocked";
    emit(context, "business.branch.initialized", {
      branch,
      state: initialState,
      required_criterion_ids: criterionBindings[branch.branch_ref],
    });
    context.state.branches[branch.branch_ref] = {
      ...cloneJson(branch, `branch.${branch.branch_ref}`),
      required_criterion_ids: criterionBindings[branch.branch_ref],
      state: initialState,
      attempt: 0,
      dispatch_id: null,
      packet_ref: null,
      attempt_started_at: null,
      attempt_deadline_at: null,
      retry_at: null,
      delivery: null,
      runtime_identity: null,
      open_user_input: null,
      result: null,
      verification_by_criterion: {},
      last_progress_at: null,
      finished_at: null,
      attempt_history: {},
      last_runtime_observation: null,
    };
  }
  const dispatched = scheduleEligible(context, "initial_dispatch");
  return {
    status: "starting",
    work_order_revision: 1,
    dispatched_branch_refs: dispatched,
  };
}

function observationEvidence(context) {
  return referenceArray(
    context.facts.observation_evidence_refs,
    "trustedFacts.observation_evidence_refs",
    { minimum: 1 },
  );
}

function authenticatedActor(context) {
  const principal = object(
    context.facts.authenticated_principal,
    "trustedFacts.authenticated_principal",
  );
  const keys = Object.keys(principal).sort(compareText);
  if (!same(keys, ["id", "type"])) {
    fail(
      "BUSINESS_AUTHENTICATED_PRINCIPAL_INVALID",
      "authenticated principal must contain exactly type and id",
    );
  }
  const id = portableRef(principal.id, "trustedFacts.authenticated_principal.id");
  portableRef(principal.type, "trustedFacts.authenticated_principal.type");
  if (id !== context.envelope.actor.actor_id) {
    fail(
      "BUSINESS_ACTOR_BINDING_MISMATCH",
      "asserted envelope actor does not match the authenticated principal",
    );
  }
  return id;
}

function quarantine(context, reason) {
  const observation = context.envelope;
  const evidenceRefs = observationEvidence(context);
  const artifactRefs = observation.name === "branch.result.submitted"
    ? observation.payload.artifact_refs
    : [];
  emit(context, "business.late_observation.quarantined", {
    record: { observation, reason, artifact_refs: artifactRefs, evidence_refs: evidenceRefs },
  }, evidenceRefs);
  return {
    status: "quarantined",
    reason,
    work_order_revision: context.targetRevision,
  };
}

function settlementPolicyFor(context) {
  if (![
    EFFECT_SETTLEMENT_OBSERVATION_NAME,
    EFFECT_SEND_EXPIRY_OBSERVATION_NAME,
    EFFECT_PRESEND_FAILURE_OBSERVATION_NAME,
  ]
    .includes(context.envelope.name)
      && context.facts.send_expiry === undefined) return null;
  if (context.settlementPolicy) return context.settlementPolicy;
  const expiryEffect = context.facts.send_expiry?.effect;
  const expiryStage = expiryEffect && ({
    "provider.thread.create": "thread_create",
    "provider.turn.start": "turn_start",
    "provider.user_input.submit": "user_input_submit",
    "provider.turn.cancel": "turn_cancel",
  })[expiryEffect.effect_kind];
  const certaintyFact = expiryEffect ? {
    certainty_fact_version: 2,
    effect_contract_version: 2,
    effect_kind: expiryEffect.effect_kind,
    effect_stage: expiryStage,
    settlement_source: "control_plane",
    classification: "delivery_unknown",
    reason: "worker_send_expired",
  } : context.facts.settlement_certainty_fact;
  let policy;
  try {
    policy = deriveSettlementDispositionV2(certaintyFact);
  } catch (error) {
    fail(
      "BUSINESS_SETTLEMENT_POLICY_INVALID",
      "trusted settlement certainty does not satisfy the shared V2 policy",
      { cause_code: error?.code || null, cause_reason: error?.reason || null },
    );
  }
  const payload = context.envelope.payload;
  const presendFailure = context.envelope.name === EFFECT_PRESEND_FAILURE_OBSERVATION_NAME;
  const expectedSource = expiryEffect || presendFailure
    ? "control_plane"
    : payload.settlement_source;
  const expectedClassification = expiryEffect
    ? "delivery_unknown"
    : presendFailure
      ? "not_sent"
      : payload.classification;
  if (policy.effect_kind !== payload.effect_kind
      || policy.settlement_source !== expectedSource
      || policy.classification !== expectedClassification) {
    fail(
      "BUSINESS_SETTLEMENT_POLICY_MISMATCH",
      "trusted settlement certainty does not bind the immutable callback outcome",
    );
  }
  context.settlementPolicy = policy;
  return policy;
}

function executionWindowElapsed(state, branch, occurredAt) {
  if (!branch.attempt_deadline_at) return true;
  const observedAt = Date.parse(occurredAt);
  return observedAt >= Date.parse(branch.attempt_deadline_at)
    || observedAt >= Date.parse(state.deadline_at);
}

function validateObservationCurrency(context) {
  const observation = context.envelope;
  if (observation.work_order_revision > context.state.revision) {
    fail("BUSINESS_FUTURE_OBSERVATION", "observation claims a Work Order revision that does not exist", {
      observed: observation.work_order_revision,
      current: context.state.revision,
    });
  }
  if (TERMINAL_WORK_ORDER_STATES.has(context.state.status)) return "terminal_work_order";
  if (!Object.hasOwn(observation.payload, "branch_ref")) return null;
  const branch = context.state.branches[observation.payload.branch_ref];
  if (!branch) return "unknown_branch";
  if (CURRENT_ATTEMPT_OBSERVATIONS.has(observation.name)
      && observation.payload.attempt !== branch.attempt) return "stale_attempt";
  if (CURRENT_DISPATCH_OBSERVATIONS.has(observation.name)
      && observation.payload.dispatch_id !== branch.dispatch_id) return "replaced_dispatch";
  if (Object.hasOwn(context.facts, "stale_delivery_reason")) {
    const staleReason = portableRef(
      context.facts.stale_delivery_reason,
      "trustedFacts.stale_delivery_reason",
    );
    if (context.facts.stale_delivery_effect !== true
        || !["stale_effect_generation", "stale_effect_stage", "stale_effect_lease"]
          .includes(staleReason)) {
      fail(
        "BUSINESS_DELIVERY_EFFECT_BINDING",
        "a stale delivery reason must be an enabled authoritative fencing classification",
      );
    }
    return staleReason;
  }
  if (context.facts.stale_delivery_effect === true) return "stale_effect_stage";
  if (observation.name === "user_input.requested") {
    const binding = object(context.facts.current_attempt, "trustedFacts.current_attempt");
    if (binding.attempt !== branch.attempt || binding.dispatch_id !== branch.dispatch_id) {
      return "stale_attempt";
    }
  }
  if (EXECUTION_WINDOW_OBSERVATIONS.has(observation.name)
      && executionWindowElapsed(context.state, branch, context.facts.occurred_at)) {
    return "execution_deadline_elapsed";
  }
  if (["verification.recorded", "review.recorded"].includes(observation.name)) {
    const resultHash = sha256(
      context.facts.current_result_hash,
      "trustedFacts.current_result_hash",
    );
    if (!branch.result || resultHash !== canonicalHash(branch.result)) return "stale_result";
  }
  return null;
}

function recordRuntimeObservation(
  context,
  runtimeIdentity,
  evidenceRefs,
  deliveryEffect = null,
  deliveryHash = null,
) {
  const specific = { observation: context.envelope };
  if ([
    EFFECT_SETTLEMENT_OBSERVATION_NAME,
    EFFECT_SEND_EXPIRY_OBSERVATION_NAME,
    EFFECT_PRESEND_FAILURE_OBSERVATION_NAME,
  ]
    .includes(context.envelope.name)) {
    specific.settlement_policy = settlementPolicyFor(context);
  }
  if (runtimeIdentity !== undefined) specific.runtime_identity = runtimeIdentity;
  if (deliveryEffect !== null) {
    specific.delivery_effect_id = deliveryEffect.effect_id;
    specific.effect_kind = deliveryEffect.effect_kind;
  }
  const payload = context.envelope.payload;
  const branch = Object.hasOwn(payload, "branch_ref")
    ? branchByRef(context, payload.branch_ref)
    : null;
  if (deliveryEffect === null && TURN_BOUND_OBSERVATIONS.has(context.envelope.name)) {
    if (!branch.turn_start_effect_id || !branch.runtime_identity) {
      fail(
        "BUSINESS_RUNTIME_TURN_BINDING",
        `${context.envelope.name} requires the exact accepted current turn`,
      );
    }
    specific.active_turn_effect_id = branch.turn_start_effect_id;
    specific.active_runtime_identity = branch.runtime_identity;
  }
  emit(context, "business.branch.runtime_observed", specific, evidenceRefs);
  if (branch === null) return;
  branch.last_runtime_observation = context.envelope;
  const deliveryClassification = [
    "provider.effect.delivery.recorded",
    EFFECT_SETTLEMENT_OBSERVATION_NAME,
    EFFECT_SEND_EXPIRY_OBSERVATION_NAME,
    EFFECT_PRESEND_FAILURE_OBSERVATION_NAME,
  ].includes(context.envelope.name)
    ? (context.envelope.name === EFFECT_SEND_EXPIRY_OBSERVATION_NAME
      ? "delivery_unknown"
      : context.envelope.name === EFFECT_PRESEND_FAILURE_OBSERVATION_NAME
        ? "not_sent"
        : payload.classification)
    : ({
      "branch.dispatch.accepted": "accepted",
      "branch.dispatch.not_sent": "not_sent",
      "branch.delivery_unknown": "delivery_unknown",
    })[context.envelope.name];
  if (deliveryClassification === "accepted") {
    if (deliveryEffect.effect_kind === "provider.thread.create") {
      // A recovered thread-create delivery closes the ambiguity for that stage.
      // The accepted thread is durable, but the branch is not running until its
      // turn-start successor is accepted.
      branch.delivery = null;
      branch.thread_identity = runtimeIdentity;
      branch.thread_create_effect_id = deliveryEffect.effect_id;
      branch.thread_create_delivery_hash = deliveryHash;
    } else if (deliveryEffect.effect_kind === "provider.turn.start") {
      branch.delivery = { classification: "accepted", observed_at: context.facts.occurred_at };
      branch.runtime_identity = runtimeIdentity;
      branch.turn_start_effect_id = deliveryEffect.effect_id;
      branch.turn_start_delivery_hash = deliveryHash;
    }
  } else if (deliveryClassification === "not_sent"
      && ["provider.thread.create", "provider.turn.start"].includes(deliveryEffect.effect_kind)) {
    branch.delivery = { classification: "not_sent", observed_at: context.facts.occurred_at };
  } else if (deliveryClassification === "delivery_unknown"
      && ["provider.thread.create", "provider.turn.start"].includes(deliveryEffect.effect_kind)) {
    branch.delivery = { classification: "delivery_unknown", observed_at: context.facts.occurred_at };
  } else if (context.envelope.name === "branch.progress") {
    branch.last_progress_at = context.facts.occurred_at;
  } else if (context.envelope.name === "branch.result.submitted") {
    branch.result = {
      attempt: branch.attempt,
      artifact_refs: payload.artifact_refs,
      evidence_refs: payload.evidence_refs,
      submitted_at: context.facts.occurred_at,
    };
  } else if (context.envelope.name === "user_input.requested") {
    branch.open_user_input = {
      request_id: payload.request_id,
      prompt_ref: payload.prompt_ref,
      requested_at: context.facts.occurred_at,
    };
  }
}

function retryDelay(policy, completedAttempt) {
  if (policy.backoff_initial_ms === 0) return 0;
  return Math.min(
    policy.backoff_initial_ms * (2 ** Math.max(0, completedAttempt - 1)),
    policy.backoff_max_ms,
  );
}

function canRetryAt(state, branch, retryAt) {
  return branch.attempt < state.plan.retry_policy.max_attempts
    && Date.parse(retryAt) < Date.parse(state.deadline_at);
}

function openAttention(
  context,
  kind,
  branchRef,
  evidenceRefs,
  { effectId = null } = {},
) {
  const detailRef = contentRef(context.facts.attention_detail_ref, "trustedFacts.attention_detail_ref");
  const attention = {
    attention_id: deterministicId("ATTN", {
      work_order_id: context.state.work_order_id,
      source_id: context.sourceId,
      kind,
      branch_ref: branchRef,
    }),
    kind,
    branch_ref: branchRef,
    effect_id: effectId === null
      ? null
      : portableRef(effectId, "attention.effect_id"),
    detail_ref: detailRef,
    evidence_refs: evidenceRefs,
    opened_at: context.facts.occurred_at,
  };
  emit(context, "business.attention.opened", { attention }, evidenceRefs);
  context.state.attention[attention.attention_id] = { ...attention, status: "open", resolution: null };
}

function resolveDeliveryAttention(
  context,
  branchRef,
  evidenceRefs,
  { effectId = null, includeCancelNotSent = false } = {},
) {
  const effectScopedKinds = new Set([
    "delivery_unknown",
    "timeout_requires_reconciliation",
    "cancel_requires_dispatch_reconciliation",
  ]);
  const open = Object.values(context.state.attention).filter((attention) => (
    attention.status === "open"
      && attention.branch_ref === branchRef
      && ((effectScopedKinds.has(attention.kind)
        && effectId !== null
        && attention.effect_id === effectId)
        || (includeCancelNotSent && attention.kind === "cancel_not_sent"))
  ));
  if (open.length === 0) return;
  const resolutionRef = contentRef(
    context.facts.reconciliation_resolution_ref,
    "trustedFacts.reconciliation_resolution_ref",
  );
  for (const attention of open.sort((left, right) => compareText(
    left.attention_id,
    right.attention_id,
  ))) {
    emit(context, "business.attention.resolved", {
      attention_id: attention.attention_id,
      resolution_ref: resolutionRef,
      evidence_refs: evidenceRefs,
    }, evidenceRefs);
    attention.status = "resolved";
    attention.resolution = {
      resolution_ref: resolutionRef,
      evidence_refs: evidenceRefs,
      resolved_at: context.facts.occurred_at,
    };
  }
}

function settleDispatchEffect(context, classification, runtimeIdentity, evidenceRefs, expectedKind) {
  const path = "trustedFacts.delivery_effect";
  const effect = object(context.facts.delivery_effect, path);
  const expectedFields = [...OUTBOX_EFFECT_IDENTITY_FIELDS, "fencing_token", "status"]
    .sort(compareText);
  if (!same(Object.keys(effect).sort(compareText), expectedFields)) {
    fail("BUSINESS_DELIVERY_EFFECT_BINDING", `${path} must contain the exact delivery identity`);
  }
  const payload = context.envelope.payload;
  const identity = normalizeOutboxEffectIdentity(
    Object.fromEntries(OUTBOX_EFFECT_IDENTITY_FIELDS.map((field) => [field, effect[field]])),
    path,
  );
  const fencingToken = effect.fencing_token === null
    ? null
    : (() => {
      const token = object(effect.fencing_token, `${path}.fencing_token`);
      const tokenFields = ["generation", "lease_id", "owner_id"].sort(compareText);
      if (!same(Object.keys(token).sort(compareText), tokenFields)) {
        fail(
          "BUSINESS_DELIVERY_EFFECT_BINDING",
          `${path}.fencing_token must contain the exact active lease identity`,
        );
      }
      return {
        lease_id: portableRef(token.lease_id, `${path}.fencing_token.lease_id`),
        owner_id: portableRef(token.owner_id, `${path}.fencing_token.owner_id`),
        generation: integer(token.generation, `${path}.fencing_token.generation`, 1),
      };
    })();
  const normalized = {
    ...identity,
    fencing_token: fencingToken,
    status: portableRef(effect.status, `${path}.status`),
  };
  if ([
    "provider.effect.delivery.recorded",
    EFFECT_SETTLEMENT_OBSERVATION_NAME,
    EFFECT_PRESEND_FAILURE_OBSERVATION_NAME,
  ]
    .includes(context.envelope.name)) {
    const payloadBinding = context.envelope.payload;
    if (payloadBinding.effect_id !== identity.effect_id
        || payloadBinding.effect_contract_version !== identity.effect_contract_version
        || payloadBinding.effect_kind !== identity.effect_kind
        || payloadBinding.branch_ref !== identity.branch_ref
        || payloadBinding.attempt !== identity.attempt
        || payloadBinding.dispatch_id !== identity.dispatch_id
        || (context.envelope.name === EFFECT_PRESEND_FAILURE_OBSERVATION_NAME
          && !same(payloadBinding.claimed_fencing_token, normalized.fencing_token))
        || (context.envelope.name !== EFFECT_PRESEND_FAILURE_OBSERVATION_NAME
          && payloadBinding.classification !== classification)) {
      fail(
        "BUSINESS_DELIVERY_EFFECT_BINDING",
        "the observation payload does not bind the exact provider effect delivery",
      );
    }
  }
  const branch = branchByRef(context, payload.branch_ref);
  if (["provider.thread.create", "provider.turn.start"].includes(expectedKind)) {
    const currentStage = currentDispatchStage(branch);
    if (currentStage === null) {
      fail("BUSINESS_DELIVERY_EFFECT_STATE", "the current dispatch is already accepted");
    }
    if (currentStage !== expectedKind) {
      fail(
        "BUSINESS_DELIVERY_EFFECT_STAGE",
        `the current dispatch stage is ${currentStage}, not ${expectedKind}`,
      );
    }
  }
  assertEffectBindsBranch(context, branch, identity, path, expectedKind);
  if (normalized.branch_ref !== payload.branch_ref
      || normalized.attempt !== payload.attempt
      || normalized.dispatch_id !== payload.dispatch_id) {
    fail("BUSINESS_DELIVERY_EFFECT_BINDING", "delivery fact does not bind the current turn-start effect");
  }
  const allowedStatuses = {
    accepted: ["sending", "delivery_unknown"],
    not_sent: ["claimed", "sending", "delivery_unknown"],
    delivery_unknown: ["sending", "delivery_unknown"],
  }[classification];
  if (!allowedStatuses.includes(normalized.status)) {
    fail(
      "BUSINESS_DELIVERY_EFFECT_STATE",
      `cannot record ${classification} from outbox state ${normalized.status}`,
    );
  }
  if (normalized.status === "delivery_unknown") {
    if (normalized.fencing_token !== null) {
      fail(
        "BUSINESS_DELIVERY_EFFECT_BINDING",
        "a reconciled ambiguous delivery must not reuse an expired worker lease",
      );
    }
  } else if (normalized.fencing_token === null) {
    fail(
      "BUSINESS_DELIVERY_EFFECT_BINDING",
      "a live delivery result requires the exact active worker lease token",
    );
  }
  const delivery = {
    classification,
    evidence_refs: evidenceRefs,
    runtime_identity: runtimeIdentity,
    recorded_at: context.facts.occurred_at,
  };
  const deliveryHash = canonicalHash({ effect: identity, ...delivery });
  if (classification === "delivery_unknown" && normalized.status === "delivery_unknown") {
    return { identity, deliveryHash, alreadySettled: true, priorStatus: normalized.status };
  }
  const type = {
    accepted: "business.outbox.delivered",
    not_sent: "business.outbox.not_sent",
    delivery_unknown: "business.outbox.delivery_unknown",
  }[classification];
  const settlementPolicy = [
    EFFECT_SETTLEMENT_OBSERVATION_NAME,
    EFFECT_PRESEND_FAILURE_OBSERVATION_NAME,
  ].includes(context.envelope.name)
    ? settlementPolicyFor(context)
    : null;
  emit(context, type, {
    effect_id: normalized.effect_id,
    effect: identity,
    fencing_token: normalized.fencing_token,
    delivery,
    ...(settlementPolicy === null ? {} : { settlement_policy: settlementPolicy }),
  }, evidenceRefs);
  return {
    identity,
    deliveryHash,
    settlementPolicy,
    alreadySettled: false,
    priorStatus: normalized.status,
  };
}

function observeWorkOrderStarted(context, evidenceRefs) {
  if (context.state.status !== "starting") return quarantine(context, "work_order_already_started");
  recordRuntimeObservation(context, undefined, evidenceRefs);
  transitionWorkOrder(context, "running", "runtime_started", evidenceRefs);
  recomputeParentStatus(context, "runtime_started", evidenceRefs);
  return { status: context.state.status, work_order_revision: context.targetRevision };
}

function branchesQuiescent(state) {
  return Object.values(state.branches).every((branch) => (
    branch.state === "accepted" || branch.state === "failed" || branch.state === "cancelled"
  ));
}

function observeWorkOrderCancelled(context, evidenceRefs) {
  recordRuntimeObservation(context, undefined, evidenceRefs);
  if (context.state.status !== "cancelling"
      || context.facts.mutating_effects_quiescent !== true
      || !branchesQuiescent(context.state)) {
    return quarantine(context, "cancellation_not_quiescent");
  }
  transitionWorkOrder(context, "cancelled", context.envelope.payload.reason, evidenceRefs);
  return { status: "cancelled", work_order_revision: context.targetRevision };
}

function observeStartAccepted(context, evidenceRefs, expectedKind) {
  const payload = context.envelope.payload;
  const branch = branchByRef(context, payload.branch_ref);
  if (!new Set(["dispatch_pending", "delivery_unknown"]).has(branch.state)) {
    return quarantine(context, "dispatch_not_pending");
  }
  const runtimeIdentity = normalizeRuntimeIdentity(
    context.facts.runtime_identity,
    "trustedFacts.runtime_identity",
    { required: true },
  );
  const settled = settleDispatchEffect(
    context,
    "accepted",
    runtimeIdentity,
    evidenceRefs,
    expectedKind,
  );
  if (settled.alreadySettled) {
    return quarantine(context, "recovery_probe_ledger_required");
  }
  const effect = settled.identity;
  const isThreadCreate = expectedKind === "provider.thread.create";
  if ((isThreadCreate && (runtimeIdentity.thread_id === null || runtimeIdentity.turn_id !== null))
      || (!isThreadCreate && (runtimeIdentity.thread_id === null
        || runtimeIdentity.turn_id === null
        || runtimeIdentity.thread_id !== effect.target_runtime_identity.thread_id))) {
    fail(
      "BUSINESS_RUNTIME_IDENTITY_STAGE",
      isThreadCreate
        ? "thread creation must return a thread identity without a turn identity"
        : "turn start must return a turn on the exact target thread",
    );
  }
  recordRuntimeObservation(
    context,
    runtimeIdentity,
    evidenceRefs,
    effect,
    settled.deliveryHash,
  );
  if (branch.state === "delivery_unknown") {
    resolveDeliveryAttention(context, branch.branch_ref, evidenceRefs, {
      effectId: effect.effect_id,
    });
  }
  const elapsed = executionWindowElapsed(context.state, branch, context.facts.occurred_at);
  if (isThreadCreate) {
    if (context.state.status === "cancelling" || elapsed) {
      transitionBranch(
        context,
        branch.branch_ref,
        context.state.status === "cancelling" ? "cancelled" : "failed",
        context.state.status === "cancelling"
          ? "thread_created_after_cancel_without_turn"
          : "thread_created_after_execution_deadline",
        { evidence_refs: evidenceRefs },
      );
      recomputeParentStatus(context, "thread_create_reconciled_without_turn", evidenceRefs);
      return {
        status: context.state.status,
        branch_state: branch.state,
        work_order_revision: context.targetRevision,
      };
    }
    if (branch.state === "delivery_unknown") {
      transitionBranch(
        context,
        branch.branch_ref,
        "dispatch_pending",
        "thread_create_recovered",
        { evidence_refs: evidenceRefs },
      );
    }
    const turnEffect = outboxEffect(
      context,
      branch,
      branch.packet_ref,
      "provider.turn.start",
      "thread_created_for_current_attempt",
      {
        predecessorEffectId: effect.effect_id,
        predecessorDeliveryHash: settled.deliveryHash,
        targetRuntimeIdentity: runtimeIdentity,
      },
    );
    emit(context, "business.outbox.enqueued", { effect: turnEffect }, evidenceRefs);
    return {
      status: context.state.status,
      branch_state: "dispatch_pending",
      work_order_revision: context.targetRevision,
    };
  }
  if (context.state.status === "cancelling" || elapsed) {
    if (branch.state !== "cancelling") {
      transitionBranch(context, branch.branch_ref, "cancelling", "turn_started_after_stop", {
        evidence_refs: evidenceRefs,
      });
    }
    if (!enqueueCancel(context, branch, evidenceRefs)) {
      openAttention(context, "cancel_requires_runtime_identity", branch.branch_ref, evidenceRefs);
    }
    return {
      status: context.state.status,
      branch_state: "cancelling",
      work_order_revision: context.targetRevision,
    };
  }
  if (context.state.status === "starting") {
    transitionWorkOrder(context, "running", "dispatch_accepted_implies_started", evidenceRefs);
  }
  transitionBranch(context, branch.branch_ref, "running", "dispatch_accepted", {
    evidence_refs: evidenceRefs,
  });
  recomputeParentStatus(context, "dispatch_accepted", evidenceRefs);
  return { status: context.state.status, branch_state: "running", work_order_revision: context.targetRevision };
}

function observeDispatchAccepted(context, evidenceRefs) {
  return observeStartAccepted(context, evidenceRefs, "provider.turn.start");
}

function observeNotSentStage(context, evidenceRefs, expectedKind) {
  const payload = context.envelope.payload;
  const branch = branchByRef(context, payload.branch_ref);
  if (!new Set(["dispatch_pending", "delivery_unknown"]).has(branch.state)) {
    return quarantine(context, "dispatch_not_pending_or_ambiguous");
  }
  const settled = settleDispatchEffect(
    context,
    "not_sent",
    null,
    evidenceRefs,
    expectedKind,
  );
  recordRuntimeObservation(
    context,
    undefined,
    evidenceRefs,
    settled.identity,
    settled.deliveryHash,
  );
  if (branch.state === "delivery_unknown") {
    resolveDeliveryAttention(context, branch.branch_ref, evidenceRefs, {
      effectId: settled.identity.effect_id,
    });
  }
  if (context.state.status === "cancelling") {
    transitionBranch(context, branch.branch_ref, "cancelled", "provider_start_proven_not_sent", {
      evidence_refs: evidenceRefs,
    });
    recomputeParentStatus(context, "provider_start_proven_not_sent", evidenceRefs);
    return {
      status: context.state.status,
      branch_state: "cancelled",
      automatic_retry: false,
      work_order_revision: context.targetRevision,
    };
  }
  const policy = context.state.plan.retry_policy;
  const settlementPolicy = settled.settlementPolicy;
  if (settlementPolicy !== null) {
    if (settlementPolicy.disposition !== "retry_candidate"
        || settlementPolicy.retry?.scope !== "effect_generation"
        || !["automatic", "explicit"].includes(settlementPolicy.retry?.mode)) {
      fail(
        "BUSINESS_SETTLEMENT_POLICY_MISMATCH",
        "a proven-not-sent start requires one Effect-generation retry semantic",
        { disposition: settlementPolicy.disposition },
      );
    }
    const retrySchedule = deriveEffectGenerationRetryScheduleV2({
      settlement_policy: settlementPolicy,
      retry_policy: {
        backoff_initial_ms: policy.backoff_initial_ms,
        backoff_max_ms: policy.backoff_max_ms,
        max_attempts: policy.max_attempts,
      },
      completed_generation: settled.identity.operation_generation,
      settled_at: context.facts.occurred_at,
      attempt_deadline_at: branch.attempt_deadline_at,
      work_order_deadline_at: context.state.deadline_at,
    });
    if (!policy.retryable_observations.includes("branch.dispatch.not_sent")
        || !retrySchedule.permitted) {
      transitionBranch(context, branch.branch_ref, "failed", "effect_generation_retry_exhausted", {
        evidence_refs: evidenceRefs,
      });
      recomputeParentStatus(context, "effect_generation_retry_exhausted", evidenceRefs);
      return {
        status: context.state.status,
        branch_state: "failed",
        work_order_revision: context.targetRevision,
      };
    }
    if (retrySchedule.automatic && retrySchedule.delay_ms === 0) {
      const successor = enqueueStartGenerationSuccessor(
        context,
        branch,
        settled.identity,
        evidenceRefs,
        "automatic_effect_generation_after_not_sent",
      );
      recomputeParentStatus(context, "automatic_effect_generation_enqueued", evidenceRefs);
      return {
        status: context.state.status,
        branch_state: "dispatch_pending",
        automatic_retry: true,
        successor_effect_id: successor.effect_id,
        retry_at: null,
        work_order_revision: context.targetRevision,
      };
    }
    transitionBranch(context, branch.branch_ref, "retryable", "effect_generation_proven_not_sent", {
      evidence_refs: evidenceRefs,
      retry_at: retrySchedule.eligible_at,
    });
    recomputeParentStatus(context, "effect_generation_retry_scheduled", evidenceRefs);
    return {
      status: context.state.status,
      branch_state: "retryable",
      automatic_retry: retrySchedule.automatic,
      retry_at: retrySchedule.eligible_at,
      work_order_revision: context.targetRevision,
    };
  }

  // Frozen V1 and pre-cutover aliases retain their historical branch-attempt
  // retry semantics. They are replay-only at the authenticated live boundary.
  const automaticAttempt = true;
  const delay = retryDelay(policy, branch.attempt);
  const retryAt = addMilliseconds(context.facts.occurred_at, delay);
  if (!policy.retryable_observations.includes("branch.dispatch.not_sent")
      || !canRetryAt(context.state, branch, retryAt)) {
    transitionBranch(context, branch.branch_ref, "failed", "automatic_retry_exhausted", {
      evidence_refs: evidenceRefs,
    });
    recomputeParentStatus(context, "automatic_retry_exhausted", evidenceRefs);
    return { status: context.state.status, branch_state: "failed", work_order_revision: context.targetRevision };
  }
  transitionBranch(context, branch.branch_ref, "retryable", "dispatch_proven_not_sent", {
    evidence_refs: evidenceRefs,
    retry_at: retryAt,
  });
  if (automaticAttempt && delay === 0) {
    openAttempt(
      context,
      branch.branch_ref,
      packetFor(context.facts, branch.branch_ref, "trustedFacts.retry_dispatch_packets"),
      "automatic_retry_after_not_sent",
    );
  }
  recomputeParentStatus(context, "automatic_retry_scheduled", evidenceRefs);
  return {
    status: context.state.status,
    branch_state: branch.state,
    retry_at: automaticAttempt && delay === 0 ? null : retryAt,
    work_order_revision: context.targetRevision,
  };
}

function observeNotSent(context, evidenceRefs) {
  return observeNotSentStage(context, evidenceRefs, "provider.turn.start");
}

function observeProgress(context, evidenceRefs) {
  const branch = branchByRef(context, context.envelope.payload.branch_ref);
  if (!["running", "waiting_for_user", "cancelling"].includes(branch.state)) {
    return quarantine(context, "progress_for_inactive_branch");
  }
  recordRuntimeObservation(context, undefined, evidenceRefs);
  return { status: context.state.status, branch_state: branch.state, work_order_revision: context.targetRevision };
}

function observeResult(context, evidenceRefs) {
  const branch = branchByRef(context, context.envelope.payload.branch_ref);
  if (branch.state !== "running") return quarantine(context, "result_for_non_running_branch");
  recordRuntimeObservation(context, undefined, evidenceRefs);
  transitionBranch(context, branch.branch_ref, "verifying", "result_submitted", {
    evidence_refs: evidenceRefs,
  });
  recomputeParentStatus(context, "result_awaiting_verification", evidenceRefs);
  return { status: context.state.status, branch_state: "verifying", work_order_revision: context.targetRevision };
}

function observeFailed(context, evidenceRefs) {
  const branch = branchByRef(context, context.envelope.payload.branch_ref);
  if (branch.state === "dispatch_pending") {
    return quarantine(context, "failure_before_delivery_certainty");
  }
  if (!["running", "waiting_for_user", "verifying", "cancelling"].includes(branch.state)) {
    return quarantine(context, "failure_for_inactive_branch");
  }
  recordRuntimeObservation(context, undefined, evidenceRefs);
  transitionBranch(context, branch.branch_ref, "failed", context.envelope.payload.failure_code, {
    evidence_refs: evidenceRefs,
  });
  recomputeParentStatus(context, "branch_failed", evidenceRefs);
  return { status: context.state.status, branch_state: "failed", work_order_revision: context.targetRevision };
}

function enqueueCancel(context, branch, evidenceRefs) {
  if (branch.cancel_effect_id) return true;
  if (!branch.runtime_identity
      || branch.runtime_identity.thread_id === null
      || branch.runtime_identity.turn_id === null
      || !branch.turn_start_effect_id
      || !branch.turn_start_delivery_hash) return false;
  const packetRef = packetFor(context.facts, branch.branch_ref, "trustedFacts.cancel_packets");
  const effect = outboxEffect(
    context,
    branch,
    packetRef,
    "provider.turn.cancel",
    "cancel_current_attempt",
    {
      predecessorEffectId: branch.turn_start_effect_id,
      predecessorDeliveryHash: branch.turn_start_delivery_hash,
      targetRuntimeIdentity: branch.runtime_identity,
      allowGenerationSuccessor: true,
    },
  );
  emit(context, "business.outbox.enqueued", { effect }, evidenceRefs);
  branch.cancel_effect_id = effect.effect_id;
  return true;
}

function observeTimedOut(context, evidenceRefs) {
  const branch = branchByRef(context, context.envelope.payload.branch_ref);
  if (!["dispatch_pending", "running", "waiting_for_user"].includes(branch.state)) {
    return quarantine(context, "timeout_for_inactive_branch");
  }
  if (!branch.attempt_deadline_at
      || Date.parse(context.facts.occurred_at) < Date.parse(branch.attempt_deadline_at)) {
    return quarantine(context, "attempt_deadline_not_reached");
  }
  recordRuntimeObservation(context, undefined, evidenceRefs);
  if (branch.state === "dispatch_pending") {
    const effect = cancellationEffect(
      context,
      branch,
      context.facts.timeout_effect,
      "trustedFacts.timeout_effect",
    );
    if (["pending", "claimed"].includes(effect.status)) {
      emit(context, "business.outbox.cancelled", {
        effect_id: effect.identity.effect_id,
        effect: effect.identity,
        reason: "attempt_deadline_before_send",
      }, evidenceRefs);
      transitionBranch(context, branch.branch_ref, "cancelled", "attempt_deadline_before_send", {
        evidence_refs: evidenceRefs,
      });
      recomputeParentStatus(context, "attempt_deadline_before_send", evidenceRefs);
      return {
        status: context.state.status,
        branch_state: "cancelled",
        work_order_revision: context.targetRevision,
      };
    }
    transitionBranch(context, branch.branch_ref, "delivery_unknown", "attempt_deadline_during_send", {
      evidence_refs: evidenceRefs,
    });
    openAttention(context, "timeout_requires_reconciliation", branch.branch_ref, evidenceRefs, {
      effectId: effect.identity.effect_id,
    });
    recomputeParentStatus(context, "attempt_deadline_during_send", evidenceRefs);
    return {
      status: context.state.status,
      branch_state: "delivery_unknown",
      work_order_revision: context.targetRevision,
    };
  }
  if (branch.state === "waiting_for_user" && branch.pending_user_input_effect_id) {
    const inputEffect = cancellationEffect(
      context,
      branch,
      context.facts.timeout_effect,
      "trustedFacts.timeout_effect",
      "provider.user_input.submit",
    );
    if (["pending", "claimed"].includes(inputEffect.status)) {
      emit(context, "business.outbox.cancelled", {
        effect_id: inputEffect.identity.effect_id,
        effect: inputEffect.identity,
        reason: "user_input_cancelled_at_attempt_deadline",
      }, evidenceRefs);
      branch.pending_user_input_effect_id = null;
      branch.pending_user_input_response_ref = null;
      branch.open_user_input = null;
    } else if (!["sending", "delivery_unknown"].includes(inputEffect.status)) {
      fail(
        "BUSINESS_CANCELLATION_EFFECT_BINDING",
        "the timed-out user-input effect has a contradictory terminal status",
      );
    }
  }
  if (branch.state === "waiting_for_user" && branch.pending_user_input_effect_id === null) {
    branch.open_user_input = null;
  }
  transitionBranch(context, branch.branch_ref, "cancelling", "attempt_timed_out", {
    evidence_refs: evidenceRefs,
  });
  if (!enqueueCancel(context, branch, evidenceRefs)) {
    openAttention(context, "timeout_requires_reconciliation", branch.branch_ref, evidenceRefs);
  }
  recomputeParentStatus(context, "attempt_timed_out", evidenceRefs);
  return { status: context.state.status, branch_state: "cancelling", work_order_revision: context.targetRevision };
}

function observeExpiredSend(context, evidenceRefs) {
  const fact = object(context.facts.send_expiry, "trustedFacts.send_expiry");
  const expectedFields = [
    "effect",
    "fencing_token",
    "lease_expires_at",
    "quarantine_original",
    "status",
    "trigger_ref",
  ].sort(compareText);
  if (Object.keys(fact).length !== expectedFields.length
      || !expectedFields.every((field) => Object.hasOwn(fact, field))
      || fact.status !== "sending"
      || typeof fact.quarantine_original !== "boolean") {
    fail(
      "BUSINESS_SEND_EXPIRY_BINDING",
      "send expiry must bind one exact currently-sending effect and lease window",
      { fields: Object.keys(fact).sort(compareText), status: fact.status || null },
    );
  }
  const payload = context.envelope.payload;
  const branch = branchByRef(context, payload.branch_ref);
  const identity = normalizeOutboxEffectIdentity(fact.effect, "trustedFacts.send_expiry.effect");
  assertEffectBindsBranch(
    context,
    branch,
    identity,
    "trustedFacts.send_expiry.effect",
    payload.effect_kind,
  );
  const token = object(fact.fencing_token, "trustedFacts.send_expiry.fencing_token");
  if (!same(Object.keys(token).sort(compareText), ["generation", "lease_id", "owner_id"])
      || !Number.isSafeInteger(token.generation)
      || token.generation < 1) {
    fail("BUSINESS_SEND_EXPIRY_BINDING", "send expiry must bind the exact fencing token");
  }
  portableRef(token.lease_id, "trustedFacts.send_expiry.fencing_token.lease_id");
  portableRef(token.owner_id, "trustedFacts.send_expiry.fencing_token.owner_id");
  const expiresAt = timestamp(
    fact.lease_expires_at,
    "trustedFacts.send_expiry.lease_expires_at",
  );
  if (Date.parse(context.facts.occurred_at) < Date.parse(expiresAt)) {
    fail("BUSINESS_SEND_NOT_EXPIRED", "the sending lease has not expired");
  }
  const triggerRef = contentRef(fact.trigger_ref, "trustedFacts.send_expiry.trigger_ref");
  const policy = settlementPolicyFor(context);
  const delivery = {
    classification: "delivery_unknown",
    evidence_refs: evidenceRefs,
    runtime_identity: null,
    recorded_at: context.facts.occurred_at,
  };
  emit(context, "business.outbox.send_expired", {
    effect_id: identity.effect_id,
    effect: identity,
    fencing_token: {
      lease_id: token.lease_id,
      owner_id: token.owner_id,
      generation: token.generation,
    },
    lease_expires_at: expiresAt,
    expiry_trigger_ref: triggerRef,
    settlement_policy: policy,
    delivery,
  }, evidenceRefs);
  const deliveryHash = canonicalHash({ effect: identity, ...delivery });
  if (!fact.quarantine_original) {
    recordRuntimeObservation(
      context,
      undefined,
      evidenceRefs,
      identity,
      deliveryHash,
    );
  } else if (context.envelope.name !== EFFECT_SETTLEMENT_OBSERVATION_NAME) {
    fail(
      "BUSINESS_SEND_EXPIRY_BINDING",
      "only an expired worker settlement may quarantine its original callback",
    );
  }
  if (["provider.thread.create", "provider.turn.start"].includes(identity.effect_kind)
      && branch.state !== "delivery_unknown") {
    branch.delivery = {
      classification: "delivery_unknown",
      observed_at: context.facts.occurred_at,
    };
    transitionBranch(context, branch.branch_ref, "delivery_unknown", "worker_send_expired", {
      evidence_refs: evidenceRefs,
    });
  }
  openAttention(context, "delivery_unknown", branch.branch_ref, evidenceRefs, {
    effectId: identity.effect_id,
  });
  if (["provider.thread.create", "provider.turn.start"].includes(identity.effect_kind)) {
    recomputeParentStatus(context, "worker_send_expired", evidenceRefs);
  }
  if (fact.quarantine_original) return quarantine(context, "stale_effect_lease");
  return {
    status: context.state.status,
    branch_state: branch.state,
    automatic_retry: false,
    work_order_revision: context.targetRevision,
  };
}

const PRESEND_FAILURE_STAGE_RULES = Object.freeze({
  "provider.thread.create": Object.freeze({ branch_states: new Set(["dispatch_pending"]) }),
  "provider.turn.start": Object.freeze({ branch_states: new Set(["dispatch_pending"]) }),
  "provider.user_input.submit": Object.freeze({ branch_states: new Set(["waiting_for_user"]) }),
  "provider.turn.cancel": Object.freeze({ branch_states: new Set(["cancelling"]) }),
});

function observePresendFailure(context, evidenceRefs) {
  const payload = context.envelope.payload;
  const branch = branchByRef(context, payload.branch_ref);
  const rule = PRESEND_FAILURE_STAGE_RULES[payload.effect_kind];
  const policy = settlementPolicyFor(context);
  if (!rule?.branch_states.has(branch.state)
      || policy.disposition !== "operator_attention"
      || policy.retry.scope !== "none"
      || policy.retry.mode !== "none") {
    fail(
      "BUSINESS_PRESEND_FAILURE_BINDING",
      "pre-send failure must bind one current non-retryable provider stage",
      { effect_kind: payload.effect_kind, branch_state: branch.state },
    );
  }
  if (["provider.thread.create", "provider.turn.start"].includes(payload.effect_kind)
      && currentDispatchStage(branch) !== payload.effect_kind) {
    fail(
      "BUSINESS_PRESEND_FAILURE_BINDING",
      "pre-send failure does not bind the current provider start stage",
    );
  }
  if (payload.effect_kind === "provider.user_input.submit"
      && branch.pending_user_input_effect_id !== payload.effect_id) {
    fail(
      "BUSINESS_PRESEND_FAILURE_BINDING",
      "pre-send failure does not bind the current user-input submission",
    );
  }
  if (payload.effect_kind === "provider.turn.cancel"
      && branch.cancel_effect_id !== payload.effect_id) {
    fail(
      "BUSINESS_PRESEND_FAILURE_BINDING",
      "pre-send failure does not bind the current cancellation",
    );
  }
  const settled = settleDispatchEffect(
    context,
    "not_sent",
    null,
    evidenceRefs,
    payload.effect_kind,
  );
  if (settled.priorStatus !== "claimed") {
    fail(
      "BUSINESS_PRESEND_FAILURE_BINDING",
      "pre-send control-plane failure requires the exact current claimed lease",
    );
  }
  recordRuntimeObservation(
    context,
    undefined,
    evidenceRefs,
    settled.identity,
    settled.deliveryHash,
  );
  if (payload.effect_kind === "provider.user_input.submit") {
    branch.pending_user_input_effect_id = null;
    branch.pending_user_input_response_ref = null;
    branch.open_user_input = null;
  }
  if (payload.effect_kind === "provider.turn.cancel") branch.cancel_effect_id = null;
  transitionBranch(context, branch.branch_ref, "failed", "provider_presend_control_plane_failure", {
    evidence_refs: evidenceRefs,
  });
  openAttention(context, "provider_effect_presend_failure", branch.branch_ref, evidenceRefs, {
    effectId: settled.identity.effect_id,
  });
  recomputeParentStatus(context, "provider_presend_control_plane_failure", evidenceRefs);
  return {
    status: context.state.status,
    branch_state: "failed",
    effect_id: settled.identity.effect_id,
    disposition: policy.disposition,
    automatic_retry: false,
    work_order_revision: context.targetRevision,
  };
}

function recordRecoveryProbe(context, evidenceRefs) {
  if (context.envelope.name !== EFFECT_SETTLEMENT_OBSERVATION_NAME
      || context.envelope.payload.settlement_source !== "recovery_probe") return null;
  const payload = context.envelope.payload;
  const deliveryEffect = object(
    context.facts.delivery_effect,
    "trustedFacts.delivery_effect",
  );
  const identity = normalizeOutboxEffectIdentity(
    Object.fromEntries(OUTBOX_EFFECT_IDENTITY_FIELDS.map((field) => [
      field,
      deliveryEffect[field],
    ])),
    "trustedFacts.delivery_effect",
  );
  const policy = settlementPolicyFor(context);
  const ledger = {
    version: 1,
    effect_id: identity.effect_id,
    probe_receipt_ref: payload.recovery_probe.probe_receipt_ref,
    mutation_idempotency_key: payload.recovery_probe.mutation_idempotency_key,
    classification: payload.classification,
    settlement_policy: policy,
  };
  emit(context, "business.recovery_probe.recorded", {
    observation: context.envelope,
    effect: identity,
    recovery_probe_ledger: ledger,
  }, evidenceRefs);
  context.recoveryProbeLedger = ledger;
  return ledger;
}

function observeDeliveryUnknownStage(context, evidenceRefs, expectedKind) {
  const branch = branchByRef(context, context.envelope.payload.branch_ref);
  if (!["dispatch_pending", "delivery_unknown"].includes(branch.state)) {
    return quarantine(context, "delivery_ambiguity_for_inactive_branch");
  }
  const observedEffectId = [
    "provider.effect.delivery.recorded",
    EFFECT_SETTLEMENT_OBSERVATION_NAME,
  ].includes(context.envelope.name)
    ? context.envelope.payload.effect_id
    : null;
  const priorUnknownCount = Object.values(context.state.attention).filter((attention) => (
    attention.kind === "delivery_unknown"
      && attention.branch_ref === branch.branch_ref
      && (observedEffectId === null
        ? attention.effect_id === null || attention.effect_id === undefined
        : attention.effect_id === observedEffectId)
  )).length;
  if (priorUnknownCount >= context.state.plan.lease_policy.max_recovery_probes) {
    return quarantine(context, "recovery_probe_limit_exhausted");
  }
  const settled = settleDispatchEffect(
    context,
    "delivery_unknown",
    null,
    evidenceRefs,
    expectedKind,
  );
  if (settled.alreadySettled) {
    return quarantine(context, "recovery_probe_ledger_required");
  }
  recordRuntimeObservation(
    context,
    undefined,
    evidenceRefs,
    settled.identity,
    settled.deliveryHash,
  );
  if (branch.state !== "delivery_unknown") {
    transitionBranch(context, branch.branch_ref, "delivery_unknown", "provider_delivery_unknown", {
      evidence_refs: evidenceRefs,
    });
  }
  openAttention(context, "delivery_unknown", branch.branch_ref, evidenceRefs, {
    effectId: settled.identity.effect_id,
  });
  recomputeParentStatus(context, "delivery_unknown", evidenceRefs);
  return {
    status: context.state.status,
    branch_state: "delivery_unknown",
    automatic_retry: false,
    work_order_revision: context.targetRevision,
  };
}

function observeDeliveryUnknown(context, evidenceRefs) {
  return observeDeliveryUnknownStage(context, evidenceRefs, "provider.turn.start");
}

function observeProviderEffectDelivery(context, evidenceRefs) {
  const payload = context.envelope.payload;
  if (context.facts.send_expiry !== undefined) {
    return observeExpiredSend(context, evidenceRefs);
  }
  if (context.envelope.name === EFFECT_SETTLEMENT_OBSERVATION_NAME) {
    settlementPolicyFor(context);
  }
  if (payload.effect_contract_version !== 2) {
    fail(
      "BUSINESS_DELIVERY_EFFECT_STAGE",
      "provider.effect.delivery.recorded requires an exact V2 effect",
    );
  }
  const recoveryProbe = recordRecoveryProbe(context, evidenceRefs);
  if (recoveryProbe && payload.classification === "delivery_unknown") {
    return {
      status: context.state.status,
      branch_state: branchByRef(context, payload.branch_ref).state,
      automatic_retry: false,
      work_order_revision: context.targetRevision,
    };
  }
  if (["provider.thread.create", "provider.turn.start"].includes(payload.effect_kind)) {
    if (payload.classification === "accepted") {
      return observeStartAccepted(context, evidenceRefs, payload.effect_kind);
    }
    if (payload.classification === "not_sent") {
      return observeNotSentStage(context, evidenceRefs, payload.effect_kind);
    }
    return observeDeliveryUnknownStage(context, evidenceRefs, payload.effect_kind);
  }
  const branch = branchByRef(context, payload.branch_ref);
  const allowedStates = payload.effect_kind === "provider.user_input.submit"
    ? new Set(["waiting_for_user", "cancelling"])
    : new Set(["cancelling"]);
  if (!allowedStates.has(branch.state)) {
    return quarantine(context, "provider_effect_for_inactive_branch");
  }
  if (payload.classification === "not_sent") {
    const settled = settleDispatchEffect(
      context,
      "not_sent",
      null,
      evidenceRefs,
      payload.effect_kind,
    );
    if (settled.alreadySettled) {
      return quarantine(context, "recovery_probe_ledger_required");
    }
    recordRuntimeObservation(
      context,
      undefined,
      evidenceRefs,
      settled.identity,
      settled.deliveryHash,
    );
    if (settled.priorStatus === "delivery_unknown") {
      resolveDeliveryAttention(context, branch.branch_ref, evidenceRefs, {
        effectId: settled.identity.effect_id,
      });
    }
    if (payload.effect_kind === "provider.user_input.submit") {
      branch.pending_user_input_effect_id = null;
      branch.pending_user_input_response_ref = null;
      if (branch.state === "cancelling") branch.open_user_input = null;
    } else {
      branch.cancel_effect_id = null;
      openAttention(context, "cancel_not_sent", branch.branch_ref, evidenceRefs, {
        effectId: settled.identity.effect_id,
      });
    }
    return {
      status: context.state.status,
      branch_state: branch.state,
      work_order_revision: context.targetRevision,
    };
  }
  if (payload.classification === "delivery_unknown") {
    const settled = settleDispatchEffect(
      context,
      "delivery_unknown",
      null,
      evidenceRefs,
      payload.effect_kind,
    );
    if (settled.alreadySettled) {
      return quarantine(context, "recovery_probe_ledger_required");
    }
    recordRuntimeObservation(
      context,
      undefined,
      evidenceRefs,
      settled.identity,
      settled.deliveryHash,
    );
    openAttention(context, "delivery_unknown", branch.branch_ref, evidenceRefs, {
      effectId: settled.identity.effect_id,
    });
    return {
      status: context.state.status,
      branch_state: branch.state,
      automatic_retry: false,
      work_order_revision: context.targetRevision,
    };
  }
  const mutationRuntimeIdentity = normalizeRuntimeIdentity(
    context.facts.runtime_identity,
    "trustedFacts.runtime_identity",
    { required: true },
  );
  if (!same(mutationRuntimeIdentity, branch.runtime_identity)) {
    fail(
      "BUSINESS_RUNTIME_IDENTITY_STAGE",
      "a turn mutation acknowledgement must bind the exact accepted current turn",
    );
  }
  const settled = settleDispatchEffect(
    context,
    "accepted",
    mutationRuntimeIdentity,
    evidenceRefs,
    payload.effect_kind,
  );
  recordRuntimeObservation(
    context,
    mutationRuntimeIdentity,
    evidenceRefs,
    settled.identity,
    settled.deliveryHash,
  );
  if (settled.priorStatus === "delivery_unknown"
      || payload.effect_kind === "provider.turn.cancel") {
    resolveDeliveryAttention(context, branch.branch_ref, evidenceRefs, {
      effectId: settled.identity.effect_id,
      includeCancelNotSent: payload.effect_kind === "provider.turn.cancel",
    });
  }
  if (payload.effect_kind === "provider.user_input.submit") {
    const responseRef = contentRef(
      branch.pending_user_input_response_ref,
      "branch.pending_user_input_response_ref",
    );
    const requestId = branch.open_user_input.request_id;
    branch.pending_user_input_effect_id = null;
    branch.pending_user_input_response_ref = null;
    branch.open_user_input = null;
    if (branch.state === "waiting_for_user") {
      transitionBranch(context, branch.branch_ref, "running", "user_input_delivered", {
        evidence_refs: evidenceRefs,
        resolved_request_id: requestId,
        response_ref: responseRef,
      });
    }
  }
  return {
    status: context.state.status,
    branch_state: branch.state,
    work_order_revision: context.targetRevision,
  };
}

function observeBranchCancelled(context, evidenceRefs) {
  const branch = branchByRef(context, context.envelope.payload.branch_ref);
  if (branch.state !== "cancelling") return quarantine(context, "cancel_for_non_cancelling_branch");
  const runtimeIdentity = normalizeRuntimeIdentity(context.facts.runtime_identity, "trustedFacts.runtime_identity");
  recordRuntimeObservation(context, runtimeIdentity === null ? undefined : runtimeIdentity, evidenceRefs);
  branch.cancel_effect_id = null;
  transitionBranch(context, branch.branch_ref, "cancelled", context.envelope.payload.reason, {
    evidence_refs: evidenceRefs,
  });
  recomputeParentStatus(context, "branch_cancelled", evidenceRefs);
  return { status: context.state.status, branch_state: "cancelled", work_order_revision: context.targetRevision };
}

function observeUserInput(context, evidenceRefs) {
  const branch = branchByRef(context, context.envelope.payload.branch_ref);
  if (branch.state !== "running" || branch.open_user_input !== null) {
    return quarantine(context, "user_input_request_not_current");
  }
  const duplicate = Object.values(context.state.branches).some((entry) => (
    entry.open_user_input && entry.open_user_input.request_id === context.envelope.payload.request_id
  ));
  if (duplicate) return quarantine(context, "user_input_request_id_conflict");
  recordRuntimeObservation(context, undefined, evidenceRefs);
  transitionBranch(context, branch.branch_ref, "waiting_for_user", "user_input_requested", {
    evidence_refs: evidenceRefs,
  });
  return {
    status: context.state.status,
    branch_state: "waiting_for_user",
    request_id: context.envelope.payload.request_id,
    work_order_revision: context.targetRevision,
  };
}

function verificationRequirement(state, payload) {
  const criterion = state.plan.acceptance_policy.criteria.find(
    (entry) => entry.criterion_id === payload.criterion_id,
  );
  const requirement = criterion && criterion.verification_requirements.find(
    (entry) => entry.verification_ref.id === payload.verification_ref.id,
  );
  if (!criterion || !requirement || requirement.kind !== payload.kind
      || !same(requirement.verification_ref, payload.verification_ref)) return null;
  return { criterion, requirement };
}

function allBranchVerificationsPassed(state, branch) {
  for (const criterionId of branch.required_criterion_ids) {
    const criterion = state.plan.acceptance_policy.criteria.find(
      (entry) => entry.criterion_id === criterionId,
    );
    for (const requirement of criterion.verification_requirements) {
      const record = branch.verification_by_criterion[criterionId]
        && branch.verification_by_criterion[criterionId][requirement.verification_ref.id];
      if (!record || record.status !== "passed") return false;
    }
  }
  return true;
}

function finalBranch(state) {
  const finalBranchRef = state.plan.integration_branch_ref || state.plan.branches[0].branch_ref;
  return state.branches[finalBranchRef];
}

function currentResultReviewSummary(state, branch = finalBranch(state)) {
  const required = REVIEW_COUNTS[state.plan.acceptance_policy.review_minimum];
  if (!branch || !branch.result) {
    return { required, accepted: 0, blocking: 0, result_hash: null };
  }
  const resultHash = canonicalHash(branch.result);
  const assignees = new Set(state.plan.branches.map((item) => item.assignee_ref));
  const reviewers = new Set();
  let blocking = 0;
  for (const review of Object.values(state.acceptance.reviews)) {
    if (review.branch_ref !== branch.branch_ref || review.result_hash !== resultHash) continue;
    const clean = review.status === "accepted"
      && review.findings.critical === 0
      && review.findings.important === 0
      && !assignees.has(review.reviewer_ref);
    if (clean) reviewers.add(review.reviewer_ref);
    else blocking += 1;
  }
  return {
    required,
    accepted: reviewers.size,
    blocking,
    result_hash: resultHash,
  };
}

function branchAcceptanceReady(state, branch) {
  if (!allBranchVerificationsPassed(state, branch)) return false;
  if (branch.branch_ref !== finalBranch(state).branch_ref) return true;
  const reviews = currentResultReviewSummary(state, branch);
  return reviews.blocking === 0 && reviews.accepted >= reviews.required;
}

function acceptVerifiedBranch(context, branch, evidenceRefs, reason) {
  if (!branchAcceptanceReady(context.state, branch)) return false;
  transitionBranch(context, branch.branch_ref, "accepted", reason, { evidence_refs: evidenceRefs });
  scheduleEligible(context, "dependency_released", evidenceRefs);
  return true;
}

function observeVerification(context, evidenceRefs) {
  const payload = context.envelope.payload;
  const branch = branchByRef(context, payload.branch_ref);
  if (branch.state !== "verifying" || !branch.result) {
    return quarantine(context, "verification_for_non_current_result");
  }
  const resolved = verificationRequirement(context.state, payload);
  if (!resolved || !branch.required_criterion_ids.includes(payload.criterion_id)) {
    return quarantine(context, "verification_not_required");
  }
  const verifierRef = authenticatedActor(context);
  if (payload.kind === "human"
      && context.state.plan.branches.some((planned) => planned.assignee_ref === verifierRef)) {
    return quarantine(context, "human_verification_not_independent");
  }
  const byCriterion = branch.verification_by_criterion[payload.criterion_id] || {};
  if (byCriterion[payload.verification_ref.id]) {
    return quarantine(context, "verification_already_recorded");
  }
  emit(context, "business.verification.recorded", {
    observation: context.envelope,
    result_hash: context.facts.current_result_hash,
  }, evidenceRefs);
  const record = {
    criterion_id: payload.criterion_id,
    verification_ref: payload.verification_ref,
    kind: payload.kind,
    status: payload.status,
    evidence_refs: payload.evidence_refs,
    verifier_ref: verifierRef,
    recorded_at: context.facts.occurred_at,
  };
  branch.verification_by_criterion[payload.criterion_id] = {
    ...byCriterion,
    [payload.verification_ref.id]: record,
  };
  if (payload.status === "failed") {
    transitionBranch(context, branch.branch_ref, "failed", "verification_failed", {
      evidence_refs: evidenceRefs,
    });
  } else if (allBranchVerificationsPassed(context.state, branch)) {
    acceptVerifiedBranch(
      context,
      branch,
      evidenceRefs,
      "all_required_verifications_and_reviews_passed",
    );
  }
  recomputeParentStatus(context, "verification_recorded", evidenceRefs);
  return { status: context.state.status, branch_state: branch.state, work_order_revision: context.targetRevision };
}

function observeReview(context, evidenceRefs) {
  const payload = context.envelope.payload;
  const branch = branchByRef(context, payload.branch_ref);
  const finalBranchRef = context.state.plan.integration_branch_ref
    || context.state.plan.branches[0].branch_ref;
  const assignees = new Set(context.state.plan.branches.map((item) => item.assignee_ref));
  if (payload.branch_ref !== finalBranchRef || !branch.result
      || branch.state !== "verifying"
      || assignees.has(context.envelope.actor.actor_id)) {
    return quarantine(context, "review_not_independent_or_final");
  }
  if (context.state.acceptance.reviews[payload.review_id]) {
    return quarantine(context, "review_id_already_recorded");
  }
  const reviewerRef = authenticatedActor(context);
  const resultHash = sha256(
    context.facts.current_result_hash,
    "trustedFacts.current_result_hash",
  );
  emit(context, "business.review.recorded", {
    observation: context.envelope,
    result_hash: resultHash,
  }, evidenceRefs);
  context.state.acceptance.reviews[payload.review_id] = {
    review_id: payload.review_id,
    branch_ref: payload.branch_ref,
    status: payload.status,
    findings: payload.findings,
    evidence_refs: payload.evidence_refs,
    reviewer_ref: reviewerRef,
    result_hash: resultHash,
    recorded_at: context.facts.occurred_at,
  };
  const blocking = payload.status !== "accepted"
    || payload.findings.critical > 0
    || payload.findings.important > 0;
  if (blocking) {
    transitionBranch(context, branch.branch_ref, "failed", "current_result_review_blocked", {
      evidence_refs: evidenceRefs,
    });
  } else {
    acceptVerifiedBranch(
      context,
      branch,
      evidenceRefs,
      "all_required_verifications_and_reviews_passed",
    );
  }
  recomputeParentStatus(context, blocking ? "current_result_review_blocked" : "review_recorded", evidenceRefs);
  return {
    status: context.state.status,
    branch_state: branch.state,
    review_id: payload.review_id,
    work_order_revision: context.targetRevision,
  };
}

function observeProviderAttention(context, evidenceRefs) {
  const branch = branchByRef(context, context.envelope.payload.branch_ref);
  if (!["dispatch_pending", "running", "waiting_for_user", "delivery_unknown"].includes(branch.state)) {
    return quarantine(context, "provider_status_for_inactive_branch");
  }
  recordRuntimeObservation(context, undefined, evidenceRefs);
  openAttention(context, context.envelope.name.replaceAll(".", "_"), branch.branch_ref, evidenceRefs);
  return { status: context.state.status, branch_state: branch.state, work_order_revision: context.targetRevision };
}

const OBSERVATION_DECIDERS = Object.freeze({
  "work_order.started": observeWorkOrderStarted,
  "work_order.cancelled": observeWorkOrderCancelled,
  "provider.effect.delivery.recorded": observeProviderEffectDelivery,
  [EFFECT_SETTLEMENT_OBSERVATION_NAME]: observeProviderEffectDelivery,
  [EFFECT_SEND_EXPIRY_OBSERVATION_NAME]: observeExpiredSend,
  [EFFECT_PRESEND_FAILURE_OBSERVATION_NAME]: observePresendFailure,
  "branch.dispatch.accepted": observeDispatchAccepted,
  "branch.dispatch.not_sent": observeNotSent,
  "branch.progress": observeProgress,
  "branch.result.submitted": observeResult,
  "branch.failed": observeFailed,
  "branch.timed_out": observeTimedOut,
  "branch.delivery_unknown": observeDeliveryUnknown,
  "branch.cancelled": observeBranchCancelled,
  "user_input.requested": observeUserInput,
  "verification.recorded": observeVerification,
  "review.recorded": observeReview,
  "provider.rate_limited": observeProviderAttention,
  "provider.unavailable": observeProviderAttention,
});

function decideObservation(context) {
  authenticatedActor(context);
  const evidenceRefs = observationEvidence(context);
  const staleReason = validateObservationCurrency(context);
  if (staleReason) return quarantine(context, staleReason);
  return OBSERVATION_DECIDERS[context.envelope.name](context, evidenceRefs);
}

function cancelFacts(context) {
  if (context.facts.cancellation === undefined) return {};
  return object(context.facts.cancellation, "trustedFacts.cancellation");
}

function cancellationEffect(
  context,
  branch,
  value,
  path = `trustedFacts.cancellation.${branch.branch_ref}`,
  expectedKindOverride = null,
) {
  const fact = object(value, path);
  const expectedFields = [...OUTBOX_EFFECT_IDENTITY_FIELDS, "status"].sort(compareText);
  if (!same(Object.keys(fact).sort(compareText), expectedFields)) {
    fail(
      "BUSINESS_CANCELLATION_EFFECT_BINDING",
      `${path} must contain the exact immutable effect identity and current status`,
    );
  }
  const identity = normalizeOutboxEffectIdentity(
    Object.fromEntries(OUTBOX_EFFECT_IDENTITY_FIELDS.map((field) => [field, fact[field]])),
    path,
  );
  const expectedKind = expectedKindOverride || currentDispatchStage(branch);
  if (expectedKind === null) {
    fail(
      "BUSINESS_CANCELLATION_EFFECT_BINDING",
      `${path} cannot target an already accepted dispatch effect`,
    );
  }
  assertEffectBindsBranch(context, branch, identity, path, expectedKind);
  const status = portableRef(fact.status, `${path}.status`);
  if (!["pending", "claimed", "sending", "delivery_unknown", "delivered", "not_sent", "cancelled"]
    .includes(status)) {
    fail("BUSINESS_CANCELLATION_EFFECT_BINDING", `${path}.status is not a supported outbox state`);
  }
  return { identity, status };
}

function cancelWorkOrder(context) {
  commandRevision(context.state, context.envelope);
  if (TERMINAL_WORK_ORDER_STATES.has(context.state.status)) {
    fail("BUSINESS_WORK_ORDER_TERMINAL", "a terminal Work Order cannot be cancelled again");
  }
  if (context.state.status === "cancelling") {
    const retryableCancel = Object.values(context.state.branches).some((branch) => (
      branch.state === "cancelling"
        && branch.cancel_effect_id === null
        && branch.runtime_identity
        && branch.runtime_identity.thread_id !== null
        && branch.runtime_identity.turn_id !== null
    ));
    if (!retryableCancel) {
      fail("BUSINESS_ALREADY_CANCELLING", "the Work Order already has an active cancellation");
    }
  }
  transitionWorkOrder(context, "cancelling", context.envelope.payload.reason);
  const facts = cancelFacts(context);
  for (const branchRef of Object.keys(context.state.branches).sort(compareText)) {
    const branch = context.state.branches[branchRef];
    if (["blocked", "ready", "retryable", "verifying"].includes(branch.state)) {
      transitionBranch(context, branchRef, "cancelled", "cancelled_before_provider_effect");
    } else if (branch.state === "dispatch_pending") {
      const branchFact = facts[branchRef];
      if (!branchFact) {
        fail(
          "BUSINESS_CANCELLATION_EFFECT_BINDING",
          `trustedFacts.cancellation.${branchRef} must bind the current start effect`,
        );
      }
      const effect = cancellationEffect(context, branch, branchFact);
      if (["pending", "claimed"].includes(effect.status)) {
        emit(context, "business.outbox.cancelled", {
          effect_id: effect.identity.effect_id,
          effect: effect.identity,
          reason: "cancelled_before_send",
        });
        transitionBranch(context, branchRef, "cancelled", "cancelled_before_send");
      } else {
        transitionBranch(context, branchRef, "delivery_unknown", "cancel_requires_dispatch_reconciliation");
        openAttention(
          context,
          "cancel_requires_dispatch_reconciliation",
          branchRef,
          referenceArray(
            context.facts.cancellation_evidence_refs,
            "trustedFacts.cancellation_evidence_refs",
            { minimum: 1 },
          ),
          { effectId: effect.identity.effect_id },
        );
      }
    } else if (["running", "waiting_for_user", "cancelling"].includes(branch.state)) {
      if (branch.state === "waiting_for_user" && branch.pending_user_input_effect_id) {
        const branchFact = facts[branchRef];
        if (!branchFact) {
          fail(
            "BUSINESS_CANCELLATION_EFFECT_BINDING",
            `trustedFacts.cancellation.${branchRef} must bind the pending user-input effect`,
          );
        }
        const inputEffect = cancellationEffect(
          context,
          branch,
          branchFact,
          `trustedFacts.cancellation.${branchRef}`,
          "provider.user_input.submit",
        );
        if (["pending", "claimed"].includes(inputEffect.status)) {
          emit(context, "business.outbox.cancelled", {
            effect_id: inputEffect.identity.effect_id,
            effect: inputEffect.identity,
            reason: "user_input_cancelled_before_send",
          });
          branch.pending_user_input_effect_id = null;
          branch.pending_user_input_response_ref = null;
          branch.open_user_input = null;
        } else if (!["sending", "delivery_unknown"].includes(inputEffect.status)) {
          fail(
            "BUSINESS_CANCELLATION_EFFECT_BINDING",
            "the pending user-input effect has a contradictory terminal status",
          );
        }
      }
      if (branch.state === "waiting_for_user" && branch.pending_user_input_effect_id === null) {
        branch.open_user_input = null;
      }
      if (branch.state !== "cancelling") transitionBranch(context, branchRef, "cancelling", "cancel_requested");
      if (!enqueueCancel(context, branch, [])) {
        openAttention(context, "cancel_requires_runtime_identity", branchRef, referenceArray(
          context.facts.cancellation_evidence_refs,
          "trustedFacts.cancellation_evidence_refs",
          { minimum: 1 },
        ));
      }
    }
  }
  return { status: "cancelling", work_order_revision: context.targetRevision };
}

function resumeWorkOrder(context) {
  commandRevision(context.state, context.envelope);
  if (context.state.status !== "paused") {
    fail("BUSINESS_NOT_PAUSED", "only a paused Work Order can resume");
  }
  if (Date.parse(context.facts.occurred_at) >= Date.parse(context.state.deadline_at)) {
    fail("BUSINESS_ELAPSED_LIMIT", "the Work Order elapsed limit has expired");
  }
  if (Object.values(context.state.branches).some((branch) => (
    branch.state === "delivery_unknown" || branch.open_user_input !== null
  ))) {
    fail("BUSINESS_RESUME_BLOCKED", "delivery ambiguity or user input must be resolved before resume");
  }
  transitionWorkOrder(context, "running", context.envelope.payload.reason);
  const dispatched = scheduleEligible(context, "resume_dispatch");
  recomputeParentStatus(context, "resume_found_no_runnable_work");
  if (context.state.status === "paused" && dispatched.length === 0) {
    fail("BUSINESS_RESUME_BLOCKED", "no branch is eligible to resume");
  }
  return { status: context.state.status, dispatched_branch_refs: dispatched, work_order_revision: context.targetRevision };
}

function currentStartOperationScopeHash(branch, effectKind) {
  if (!branch.packet_ref
      || !["provider.thread.create", "provider.turn.start"].includes(effectKind)) {
    fail(
      "BUSINESS_RETRY_BASIS_INVALID",
      "an Effect-generation retry requires one current start stage and packet",
      { branch_ref: branch.branch_ref, effect_kind: effectKind || null },
    );
  }
  const isTurnStart = effectKind === "provider.turn.start";
  return deriveEffectOperationScopeHashV2({
    effect_kind: effectKind,
    provider_ref: branch.provider_ref,
    packet_ref: branch.packet_ref.id,
    packet_hash: branch.packet_ref.hash,
    predecessor_effect_id: isTurnStart ? branch.thread_create_effect_id : null,
    predecessor_delivery_hash: isTurnStart ? branch.thread_create_delivery_hash : null,
    target_runtime_identity: isTurnStart ? branch.thread_identity : null,
  });
}

function retryBasis(context, branch) {
  const path = "trustedFacts.retry_basis";
  const basis = object(context.facts.retry_basis, path);
  const kind = portableRef(basis.kind, `${path}.kind`);
  if (kind === "effect_generation") {
    if (!same(Object.keys(basis).sort(compareText), [
      "eligible_at",
      "kind",
      "predecessor",
      "settlement_policy",
    ])) {
      fail(
        "BUSINESS_RETRY_BASIS_INVALID",
        "an Effect-generation retry basis must contain only its predecessor, policy, and eligibility",
      );
    }
    const effectKind = currentDispatchStage(branch);
    const operationScopeHash = currentStartOperationScopeHash(branch, effectKind);
    const predecessor = normalizeGenerationPredecessor(
      context,
      branch,
      effectKind,
      operationScopeHash,
      basis.predecessor,
      `${path}.predecessor`,
    );
    let settlementPolicy;
    try {
      settlementPolicy = normalizeSettlementPolicyRecordV2(basis.settlement_policy);
    } catch (error) {
      fail(
        "BUSINESS_RETRY_BASIS_INVALID",
        "the Effect-generation retry basis has no canonical settlement policy",
        { cause_code: error?.code || null, cause_reason: error?.reason || null },
      );
    }
    const eligibleAt = timestamp(basis.eligible_at, `${path}.eligible_at`);
    const lastObservation = branch.last_runtime_observation;
    if (branch.state !== "retryable"
        || branch.delivery?.classification !== "not_sent"
        || !lastObservation
        || lastObservation.name !== EFFECT_SETTLEMENT_OBSERVATION_NAME
        || lastObservation.payload?.effect_id !== predecessor.effect_id
        || lastObservation.payload?.effect_kind !== effectKind
        || lastObservation.payload?.classification !== "not_sent"
        || lastObservation.payload?.settlement_source !== settlementPolicy.settlement_source
        || settlementPolicy.effect_kind !== effectKind
        || settlementPolicy.classification !== "not_sent"
        || settlementPolicy.disposition !== "retry_candidate"
        || settlementPolicy.retry.scope !== "effect_generation") {
      fail(
        "BUSINESS_RETRY_BASIS_INVALID",
        "the Effect-generation retry basis does not bind the current proven-not-sent start stage",
        { branch_ref: branch.branch_ref },
      );
    }
    const schedule = deriveEffectGenerationRetryScheduleV2({
      settlement_policy: settlementPolicy,
      retry_policy: {
        backoff_initial_ms: context.state.plan.retry_policy.backoff_initial_ms,
        backoff_max_ms: context.state.plan.retry_policy.backoff_max_ms,
        max_attempts: context.state.plan.retry_policy.max_attempts,
      },
      completed_generation: predecessor.operation_generation,
      settled_at: branch.delivery.observed_at,
      attempt_deadline_at: branch.attempt_deadline_at,
      work_order_deadline_at: context.state.deadline_at,
    });
    if (eligibleAt !== schedule.eligible_at) {
      fail(
        "BUSINESS_RETRY_BASIS_INVALID",
        "the retry basis eligibility does not match the shared Effect-generation schedule",
        { eligible_at: eligibleAt, expected_eligible_at: schedule.eligible_at },
      );
    }
    return { kind, predecessor, settlementPolicy, schedule };
  }
  if (kind !== "branch_attempt"
      || !same(Object.keys(basis).sort(compareText), ["kind", "terminal_evidence"])) {
    fail(
      "BUSINESS_RETRY_BASIS_INVALID",
      "retry basis must be exactly one Effect generation or one terminal branch attempt",
    );
  }
  const evidence = object(basis.terminal_evidence, `${path}.terminal_evidence`);
  if (!same(Object.keys(evidence).sort(compareText), [
    "attempt",
    "delivery",
    "dispatch_id",
    "kind",
    "result",
    "runtime_observation",
  ])) {
    fail(
      "BUSINESS_RETRY_BASIS_INVALID",
      "terminal attempt evidence must bind the exact projected attempt outcome",
    );
  }
  const evidenceKind = portableRef(evidence.kind, `${path}.terminal_evidence.kind`);
  const commonBinding = branch.state === "failed"
    && integer(evidence.attempt, `${path}.terminal_evidence.attempt`, 1) === branch.attempt
    && portableRef(evidence.dispatch_id, `${path}.terminal_evidence.dispatch_id`) === branch.dispatch_id
    && same(evidence.delivery, branch.delivery)
    && same(evidence.runtime_observation, branch.last_runtime_observation)
    && same(evidence.result, branch.result)
    && branch.delivery?.classification === "accepted";
  const runtimeFailure = evidenceKind === "accepted_runtime_failure"
    && branch.last_runtime_observation?.name === "branch.failed"
    && branch.last_runtime_observation.payload?.attempt === branch.attempt;
  const resultFailure = evidenceKind === "accepted_result_failure" && branch.result !== null;
  if (!commonBinding || (!runtimeFailure && !resultFailure)) {
    fail(
      "BUSINESS_RETRY_BASIS_INVALID",
      "terminal attempt evidence does not bind an accepted current runtime or result failure",
      { branch_ref: branch.branch_ref },
    );
  }
  return { kind, evidence };
}

function retryBranch(context) {
  commandRevision(context.state, context.envelope);
  if (TERMINAL_WORK_ORDER_STATES.has(context.state.status) || context.state.status === "cancelling") {
    fail("BUSINESS_WORK_ORDER_NOT_RUNNABLE", "the Work Order cannot retry branches in its current state");
  }
  const payload = context.envelope.payload;
  const branch = branchByRef(context, payload.branch_ref);
  if (!["failed", "retryable"].includes(branch.state)
      || branch.attempt !== payload.failed_attempt) {
    fail("BUSINESS_RETRY_NOT_SAFE", "retry does not target a current authoritatively terminal attempt");
  }
  if ((branch.state === "failed" && branch.delivery?.classification !== "accepted")
      || (branch.state === "retryable" && branch.delivery?.classification !== "not_sent")) {
    fail(
      "BUSINESS_RETRY_NOT_SAFE",
      "retry requires accepted terminal execution evidence or a proven-not-sent Effect generation",
    );
  }
  const basis = retryBasis(context, branch);
  const retryAt = basis.kind === "effect_generation"
    ? basis.schedule.eligible_at
    : branch.retry_at;
  if (retryAt && Date.parse(context.facts.occurred_at) < Date.parse(retryAt)) {
    fail("BUSINESS_RETRY_TOO_EARLY", "the bounded retry backoff has not elapsed", {
      retry_at: retryAt,
    });
  }
  const exhausted = basis.kind === "effect_generation"
    ? !basis.schedule.permitted
    : branch.attempt >= context.state.plan.retry_policy.max_attempts
      || Date.parse(context.facts.occurred_at) >= Date.parse(context.state.deadline_at);
  if (exhausted) {
    fail("BUSINESS_RETRY_EXHAUSTED", "attempt or elapsed retry limit is exhausted");
  }
  const availableSlots = availableSlotCount(context.state);
  if (availableSlots <= 0) {
    fail(
      "BUSINESS_RETRY_CAPACITY_EXHAUSTED",
      "the provider execution concurrency limit has no available slot for this retry",
      {
        active_slot_count: activeSlotCount(context.state),
        max_concurrency: context.state.plan.max_concurrency,
      },
    );
  }
  if (context.state.status === "paused") transitionWorkOrder(context, "running", "explicit_branch_retry");
  if (basis.kind === "effect_generation") {
    enqueueStartGenerationSuccessor(
      context,
      branch,
      basis.predecessor,
      [],
      "explicit_effect_generation_retry",
    );
  } else {
    openAttempt(
      context,
      branch.branch_ref,
      packetFor(context.facts, branch.branch_ref),
      "explicit_branch_retry",
    );
  }
  recomputeParentStatus(context, "explicit_branch_retry");
  return {
    status: context.state.status,
    branch_state: "dispatch_pending",
    retry_kind: basis.kind,
    work_order_revision: context.targetRevision,
  };
}

function resolveUserInput(context) {
  commandRevision(context.state, context.envelope);
  if (TERMINAL_WORK_ORDER_STATES.has(context.state.status) || context.state.status === "cancelling") {
    fail("BUSINESS_WORK_ORDER_NOT_RUNNABLE", "user input cannot be applied to a stopped Work Order");
  }
  const matches = Object.values(context.state.branches).filter((branch) => (
    branch.open_user_input && branch.open_user_input.request_id === context.envelope.payload.request_id
  ));
  if (matches.length !== 1 || matches[0].state !== "waiting_for_user") {
    fail("BUSINESS_USER_INPUT_NOT_OPEN", "request_id does not identify one current open request");
  }
  const resolved = contentRef(context.facts.resolved_response_ref, "trustedFacts.resolved_response_ref");
  if (!same(resolved, context.envelope.payload.response_ref)) {
    fail("BUSINESS_CONTENT_BINDING", "resolved response does not match the command content reference");
  }
  const branch = matches[0];
  if (branch.pending_user_input_effect_id) {
    fail(
      "BUSINESS_USER_INPUT_DELIVERY_PENDING",
      "the current user response is still awaiting authoritative delivery settlement",
    );
  }
  if (executionWindowElapsed(context.state, branch, context.facts.occurred_at)) {
    fail(
      "BUSINESS_EXECUTION_DEADLINE_ELAPSED",
      "user input cannot resume an attempt after its execution deadline",
    );
  }
  const packet = packetFor(context.facts, branch.branch_ref);
  if (!branch.runtime_identity
      || !branch.turn_start_effect_id
      || !branch.turn_start_delivery_hash) {
    fail("BUSINESS_USER_INPUT_NOT_OPEN", "user input requires an accepted current turn identity");
  }
  const effect = outboxEffect(
    context,
    branch,
    packet,
    "provider.user_input.submit",
    "resolved_user_input",
    {
      predecessorEffectId: branch.turn_start_effect_id,
      predecessorDeliveryHash: branch.turn_start_delivery_hash,
      targetRuntimeIdentity: branch.runtime_identity,
      requestId: branch.open_user_input.request_id,
      responseRef: resolved,
      allowGenerationSuccessor: true,
    },
  );
  emit(context, "business.outbox.enqueued", {
    effect,
    user_input_response_ref: resolved,
  });
  branch.pending_user_input_effect_id = effect.effect_id;
  branch.pending_user_input_response_ref = resolved;
  return {
    status: context.state.status,
    branch_state: "waiting_for_user",
    delivery_pending: true,
    work_order_revision: context.targetRevision,
  };
}

function acceptedReviews(state) {
  return currentResultReviewSummary(state).accepted;
}

function recordAcceptance(context) {
  commandRevision(context.state, context.envelope);
  if (context.state.status !== "awaiting_acceptance") {
    fail("BUSINESS_ACCEPTANCE_NOT_READY", "acceptance requires awaiting_acceptance state");
  }
  const openAttention = Object.values(context.state.attention).filter((item) => item.status === "open");
  const requiredReviews = REVIEW_COUNTS[context.state.plan.acceptance_policy.review_minimum];
  const reviewSummary = currentResultReviewSummary(context.state);
  if (!context.state.acceptance.context_budget
      || Object.values(context.state.branches).some((branch) => branch.state !== "accepted")
      || openAttention.length > 0
      || reviewSummary.blocking > 0
      || acceptedReviews(context.state) < requiredReviews) {
    fail("BUSINESS_ACCEPTANCE_GATES", "mandatory evidence, review, or attention gates are not satisfied", {
      open_attention: openAttention.length,
      accepted_reviews: acceptedReviews(context.state),
      required_reviews: requiredReviews,
      blocking_reviews: reviewSummary.blocking,
    });
  }
  const payload = context.envelope.payload;
  const decidedBy = authenticatedActor(context);
  const record = {
    decision: payload.decision,
    evidence_refs: payload.evidence_refs,
    comment: payload.comment,
    decided_by: decidedBy,
    decided_at: context.facts.occurred_at,
  };
  emit(context, "business.acceptance.recorded", { record }, payload.evidence_refs);
  const decisionHistory = Array.isArray(context.state.acceptance.decision_history)
    ? context.state.acceptance.decision_history
    : context.state.acceptance.decision
      ? [context.state.acceptance.decision]
      : [];
  context.state.acceptance.decision_history = [...decisionHistory, {
    ...record,
    source_id: context.sourceId,
    applied_revision: context.targetRevision,
  }];
  context.state.acceptance.decision = record;
  transitionWorkOrder(
    context,
    payload.decision === "accepted" ? "accepted" : "paused",
    payload.decision === "accepted" ? "user_accepted" : "user_rejected",
    payload.evidence_refs,
  );
  return { status: context.state.status, decision: payload.decision, work_order_revision: context.targetRevision };
}

const COMMAND_DECIDERS = Object.freeze({
  "work_order.start": startWorkOrder,
  "work_order.cancel.request": cancelWorkOrder,
  "work_order.resume": resumeWorkOrder,
  "branch.retry.request": retryBranch,
  "user_input.resolve": resolveUserInput,
  "acceptance.decision.record": recordAcceptance,
});

function decideCommand(context) {
  if (context.envelope.name !== "work_order.start" && context.state === null) {
    fail("BUSINESS_WORK_ORDER_NOT_FOUND", "the Work Order does not exist");
  }
  if (context.envelope.name !== "work_order.start"
      && TERMINAL_WORK_ORDER_STATES.has(context.state.status)) {
    fail("BUSINESS_WORK_ORDER_TERMINAL", "a terminal Work Order cannot accept commands");
  }
  return COMMAND_DECIDERS[context.envelope.name](context);
}

function freezeDecision(context, result) {
  const output = cloneJson({ events: context.events, result }, "decision");
  const freeze = (value) => {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const child of Object.values(value)) freeze(child);
    }
    return value;
  };
  return freeze(output);
}

function decideWorkOrderV1(inputState, input, trustedFacts) {
  const normalized = normalizeInput(input);
  const state = normalizeState(inputState);
  const facts = normalizeTrustedFacts(trustedFacts);
  validateBinding(state, normalized.envelope);
  if (state !== null && state.engine_contract_version !== BUSINESS_ENGINE_CONTRACT_VERSION) {
    fail(
      "BUSINESS_ENGINE_MIGRATION_REQUIRED",
      "Frozen V1 Work Orders are projector-replayable but cannot accept new decisions",
      {
        work_order_id: state.work_order_id,
        engine_contract_version: state.engine_contract_version,
      },
    );
  }
  const context = createContext(state, normalized.kind, normalized.envelope, facts);
  let result = normalized.kind === "command"
    ? decideCommand(context)
      : state === null
        ? fail("BUSINESS_WORK_ORDER_NOT_FOUND", "the Work Order does not exist")
        : decideObservation(context);
  if (context.recoveryProbeLedger) {
    result = { ...result, recovery_probe_ledger: context.recoveryProbeLedger };
  }
  if (context.events.length > 512) {
    fail("BUSINESS_DECISION_LIMIT", "a single input produced too many events");
  }
  return freezeDecision(context, result);
}

module.exports = {
  BRANCH_STATES,
  BUSINESS_EVENT_SCHEMA_VERSION,
  BusinessDecisionError,
  WORK_ORDER_STATES,
  decideWorkOrder: decideWorkOrderV1,
  decideWorkOrderV1,
};
