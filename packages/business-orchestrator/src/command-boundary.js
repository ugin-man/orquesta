"use strict";

const { canonicalHash, canonicalJson } = require("@orquesta/contracts");
const {
  BUSINESS_ENGINE_CONTRACT_VERSION,
  normalizeBusinessWorkOrderPlanV1,
  normalizeCommandEnvelopeV1,
} = require("./contract");
const {
  BUSINESS_EVENT_TYPES,
  OUTBOX_IMMUTABLE_FIELDS,
  businessProjectionConfigurationV1,
  projectBusinessEventV1,
} = require("./projector");
const {
  assertLifecycleInvariants,
  deriveEffectOperationScopeHashV2,
  deriveLifecycleSnapshot,
} = require("./lifecycle");
const {
  deriveEffectGenerationRetryScheduleV2,
  normalizeSettlementPolicyRecordV2,
} = require("./settlement-policy");

const BUSINESS_EVENT_TYPE_SET = new Set(BUSINESS_EVENT_TYPES);
const EVENT_ACTOR_TYPES = new Set(["agent", "user", "system"]);
const COMMAND_PRINCIPAL_TYPES = Object.freeze({
  user: new Set(["user"]),
  orchestrator: new Set(["agent", "system"]),
});
const RECEIPT_NOT_FOUND = Symbol("business-receipt-not-found");
const PERMISSION_RANK = Object.freeze({ "read-only": 0, "workspace-write": 1 });
const REQUIRED_PROVIDER_EFFECTS = Object.freeze([
  "provider.thread.create",
  "provider.turn.start",
  "provider.user_input.submit",
  "provider.turn.cancel",
  "provider.thread.inspect",
  "provider.turn.inspect",
]);
const COMMAND_FACT_FIELDS = Object.freeze({
  "work_order.start": Object.freeze([
    "context_budget_receipt",
    "branch_criterion_ids",
    "dispatch_packets",
  ]),
  "work_order.cancel.request": Object.freeze([
    "cancellation_evidence_refs",
    "cancel_packets",
    "attention_detail_ref",
  ]),
  "work_order.resume": Object.freeze(["dispatch_packets"]),
  "branch.retry.request": Object.freeze(["dispatch_packets"]),
  "user_input.resolve": Object.freeze(["resolved_response_ref", "dispatch_packets"]),
  "acceptance.decision.record": Object.freeze([]),
});
const REQUIRED_COMMAND_FACT_FIELDS = Object.freeze({
  "work_order.start": new Set(COMMAND_FACT_FIELDS["work_order.start"]),
  "work_order.cancel.request": new Set(),
  "work_order.resume": new Set(COMMAND_FACT_FIELDS["work_order.resume"]),
  "branch.retry.request": new Set(COMMAND_FACT_FIELDS["branch.retry.request"]),
  "user_input.resolve": new Set(COMMAND_FACT_FIELDS["user_input.resolve"]),
  "acceptance.decision.record": new Set(),
});
const PLAN_ARTIFACT_FACT_FIELDS = new Set([
  "plan_snapshot_ref",
  "plan_hash",
  "project_ref",
  "verified_refs",
  "provider_capabilities",
]);
const CONTENT_REF_FIELDS = new Set(["id", "hash"]);
const PROVIDER_CAPABILITY_FIELDS = new Set([
  "provider_ref",
  "permission_modes",
  "isolation_modes",
  "effects",
]);
const COMMAND_AUTHORITY_FIELDS = new Set([
  "authorized",
  "principal_type",
  "principal_id",
  "project_ref",
  "permission_mode",
  "allowed_provider_refs",
  "allowed_effects",
]);

class BusinessCommandBoundaryError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "BusinessCommandBoundaryError";
    this.code = code;
    this.details = details;
  }
}

function boundaryError(code, message, details) {
  return new BusinessCommandBoundaryError(code, message, details);
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

function canonicalClone(value, code = "BUSINESS_COMMAND_DECISION_INVALID") {
  try {
    return JSON.parse(canonicalJson(value));
  } catch (error) {
    throw boundaryError(code, "Value must be bounded canonical JSON", {
      cause_code: error?.code || null,
    });
  }
}

function validateDependency(condition, name) {
  if (!condition) throw new TypeError(`${name} is required`);
}

function validateClockValue(value) {
  if (typeof value !== "string"
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
      || Number.isNaN(new Date(value).getTime())
      || new Date(value).toISOString() !== value) {
    throw boundaryError(
      "BUSINESS_COMMAND_CLOCK_INVALID",
      "Command clock must return a real millisecond UTC timestamp",
    );
  }
  return value;
}

function validateDependencyTimeout(value) {
  if (!Number.isSafeInteger(value) || value < 10 || value > 60_000) {
    throw new TypeError("dependencyTimeoutMs must be an integer from 10 to 60000");
  }
  return value;
}

function validateAbortSignal(signal) {
  if (signal === undefined) return null;
  if (!signal
      || typeof signal !== "object"
      || typeof signal.aborted !== "boolean"
      || typeof signal.addEventListener !== "function"
      || typeof signal.removeEventListener !== "function") {
    throw new TypeError("signal must be an AbortSignal");
  }
  return signal;
}

function dependencyControlError(error) {
  return error instanceof BusinessCommandBoundaryError
    && ["BUSINESS_COMMAND_ABORTED", "BUSINESS_COMMAND_DEPENDENCY_TIMEOUT"].includes(error.code);
}

function assertNotAborted(signal, dependency) {
  if (signal?.aborted) {
    throw boundaryError(
      "BUSINESS_COMMAND_ABORTED",
      "Command processing was aborted before the durable commit boundary",
      { dependency },
    );
  }
}

function awaitDependency(operation, { signal, timeoutMs, dependency }) {
  assertNotAborted(signal, dependency);
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    let timer = null;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => {
      controller.abort(signal?.reason);
      finish(reject, boundaryError(
        "BUSINESS_COMMAND_ABORTED",
        "Command processing was aborted before the durable commit boundary",
        { dependency },
      ));
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      controller.abort();
      finish(reject, boundaryError(
        "BUSINESS_COMMAND_DEPENDENCY_TIMEOUT",
        "A command dependency did not respond within the configured bound",
        { dependency, timeout_ms: timeoutMs },
      ));
    }, timeoutMs);
    timer.unref?.();
    Promise.resolve()
      .then(() => operation(controller.signal))
      .then(
        (value) => finish(resolve, value),
        (error) => finish(reject, error),
      );
  });
}

function normalizePrincipal(value) {
  if (!isPlainObject(value)
      || !EVENT_ACTOR_TYPES.has(value.type)
      || typeof value.id !== "string"
      || value.id.trim() === ""
      || value.id.trim() !== value.id
      || Buffer.byteLength(value.id, "utf8") > 256) {
    throw boundaryError(
      "BUSINESS_AUTHENTICATION_INVALID",
      "Authenticator returned an invalid principal binding",
    );
  }
  return Object.freeze({ type: value.type, id: value.id });
}

function validateCommandActorBinding(command, principal) {
  const allowedPrincipalTypes = COMMAND_PRINCIPAL_TYPES[command.actor.type];
  if (!allowedPrincipalTypes
      || !allowedPrincipalTypes.has(principal.type)
      || command.actor.actor_id !== principal.id) {
    throw boundaryError(
      "BUSINESS_ACTOR_BINDING_MISMATCH",
      "The asserted command actor does not match the authenticated principal",
    );
  }
}

async function authenticate(authorizer, authentication, dependencyOptions) {
  let authenticated;
  try {
    // The asserted command.actor is deliberately not an authentication input.
    authenticated = await awaitDependency(
      (signal) => authorizer.authenticate({ authentication, signal }),
      { ...dependencyOptions, dependency: "authorizer.authenticate" },
    );
  } catch (error) {
    if (dependencyControlError(error)) throw error;
    throw boundaryError("BUSINESS_AUTHENTICATION_FAILED", "Authentication failed", {
      cause_code: error?.code || null,
    });
  }
  if (!authenticated) {
    throw boundaryError("BUSINESS_AUTHENTICATION_FAILED", "Authentication failed");
  }
  return normalizePrincipal(authenticated.principal || authenticated);
}

async function authorize(authorizer, facts, dependencyOptions) {
  let authority;
  try {
    authority = await awaitDependency(
      (signal) => authorizer.authorize({ ...facts, signal }),
      { ...dependencyOptions, dependency: "authorizer.authorize" },
    );
  } catch (error) {
    if (dependencyControlError(error)) throw error;
    throw boundaryError("BUSINESS_AUTHORIZATION_DENIED", "Command authorization failed", {
      cause_code: error?.code || null,
    });
  }
  if (!authority) {
    throw boundaryError("BUSINESS_AUTHORIZATION_DENIED", "Command is not authorized");
  }
  return authority === true ? Object.freeze({ authorized: true }) : authority;
}

function normalizeResolvedPlan(value, command) {
  let normalized;
  try {
    normalized = normalizeBusinessWorkOrderPlanV1(value?.plan || value);
  } catch (error) {
    throw boundaryError("BUSINESS_PLAN_INVALID", "Resolved plan is invalid", {
      cause_code: error?.code || null,
    });
  }
  if (normalized.plan_snapshot_id !== command.plan_snapshot_ref
      || normalized.plan_hash !== command.plan_hash) {
    throw boundaryError(
      "BUSINESS_PLAN_BINDING_MISMATCH",
      "Resolved plan does not match the command plan identity",
      {
        plan_snapshot_ref: command.plan_snapshot_ref,
        plan_hash: command.plan_hash,
      },
    );
  }
  return normalized;
}

async function resolveStartPlan(resolvers, command, principal, dependencyOptions) {
  let resolved;
  try {
    resolved = await awaitDependency(
      (signal) => resolvers.resolvePlan({
        plan_snapshot_ref: command.plan_snapshot_ref,
        plan_hash: command.plan_hash,
        principal,
        signal,
      }),
      { ...dependencyOptions, dependency: "resolvers.resolvePlan" },
    );
  } catch (error) {
    if (dependencyControlError(error)) throw error;
    throw boundaryError("BUSINESS_PLAN_RESOLUTION_FAILED", "Plan resolution failed", {
      cause_code: error?.code || null,
    });
  }
  if (!resolved) {
    throw boundaryError("BUSINESS_PLAN_NOT_FOUND", "Plan snapshot was not found");
  }
  return normalizeResolvedPlan(resolved, command);
}

async function resolveProject(resolvers, plan, principal, dependencyOptions) {
  let project;
  try {
    project = await awaitDependency(
      (signal) => resolvers.resolveProject({
        project_ref: plan.project_ref,
        principal,
        signal,
      }),
      { ...dependencyOptions, dependency: "resolvers.resolveProject" },
    );
  } catch (error) {
    if (dependencyControlError(error)) throw error;
    throw boundaryError("BUSINESS_PROJECT_RESOLUTION_FAILED", "Project resolution failed", {
      cause_code: error?.code || null,
    });
  }
  if (!isPlainObject(project)) {
    throw boundaryError("BUSINESS_PROJECT_NOT_FOUND", "Project was not found");
  }
  const resolvedRef = project.project_ref ?? project.id;
  if (resolvedRef !== plan.project_ref) {
    throw boundaryError(
      "BUSINESS_PROJECT_BINDING_MISMATCH",
      "Resolved project does not match the plan project_ref",
    );
  }
  return project;
}

function planContentRefs(plan) {
  const refs = [
    plan.task_intent_ref,
    plan.execution_plan_ref,
    plan.context_pack_ref,
  ];
  for (const branch of plan.branches) {
    refs.push(branch.task_intent_ref, branch.execution_plan_ref, branch.context_pack_ref);
  }
  for (const criterion of plan.acceptance_policy.criteria) {
    for (const requirement of criterion.verification_requirements) {
      refs.push(requirement.verification_ref);
    }
  }
  return refs
    .map((ref) => ({ id: ref.id, hash: ref.hash }))
    .sort((left, right) => compareText(left.id, right.id));
}

function validateStringSet(value, { required, allowed = null }) {
  if (!Array.isArray(value)
      || value.some((entry) => typeof entry !== "string" || entry.trim() === "")
      || new Set(value).size !== value.length) return false;
  const actual = new Set(value);
  if (required.some((entry) => !actual.has(entry))) return false;
  return !allowed || value.every((entry) => allowed.includes(entry));
}

function validateAuthorityCeiling(authority, plan, principal) {
  if (!hasExactFields(authority, COMMAND_AUTHORITY_FIELDS)
      || authority.authorized !== true
      || authority.principal_type !== principal.type
      || authority.principal_id !== principal.id
      || authority.project_ref !== plan.project_ref
      || !Object.hasOwn(PERMISSION_RANK, authority.permission_mode)
      || PERMISSION_RANK[authority.permission_mode] < PERMISSION_RANK[plan.permission_mode]
      || !validateStringSet(authority.allowed_provider_refs, {
        required: plan.provider_policy.allowed_provider_refs,
      })
      || !validateStringSet(authority.allowed_effects, {
        required: REQUIRED_PROVIDER_EFFECTS,
      })) {
    throw boundaryError(
      "BUSINESS_AUTHORITY_CEILING_INVALID",
      "Authorization result does not cover the plan permission, provider, and effect ceilings",
    );
  }
  return Object.freeze({
    authorized: true,
    principal_type: authority.principal_type,
    principal_id: authority.principal_id,
    project_ref: authority.project_ref,
    permission_mode: authority.permission_mode,
    allowed_provider_refs: [...authority.allowed_provider_refs].sort(compareText),
    allowed_effects: [...authority.allowed_effects].sort(compareText),
  });
}

function validateVerifiedRefs(value, plan) {
  if (!Array.isArray(value)) return false;
  const expected = planContentRefs(plan);
  if (value.length !== expected.length) return false;
  const actual = [];
  const ids = new Set();
  for (const ref of value) {
    if (!hasExactFields(ref, CONTENT_REF_FIELDS)
        || typeof ref.id !== "string"
        || typeof ref.hash !== "string"
        || !/^[a-f0-9]{64}$/u.test(ref.hash)
        || ids.has(ref.id)) return false;
    ids.add(ref.id);
    actual.push({ id: ref.id, hash: ref.hash });
  }
  actual.sort((left, right) => compareText(left.id, right.id));
  return canonicalJson(actual) === canonicalJson(expected);
}

function validateProviderCapabilities(value, plan) {
  if (!Array.isArray(value)) return false;
  const expectedProviders = plan.provider_policy.allowed_provider_refs;
  if (value.length !== expectedProviders.length) return false;
  const byProvider = new Map();
  for (const capability of value) {
    if (!hasExactFields(capability, PROVIDER_CAPABILITY_FIELDS)
        || typeof capability.provider_ref !== "string"
        || byProvider.has(capability.provider_ref)
        || !validateStringSet(capability.permission_modes, {
          required: [...new Set([
            plan.permission_mode,
            ...plan.branches.map((branch) => branch.permission_mode),
          ])],
          allowed: Object.keys(PERMISSION_RANK),
        })
        || !validateStringSet(capability.isolation_modes, {
          required: [...new Set(plan.branches.map((branch) => branch.isolation))],
          allowed: ["read-only", "worktree", "sandbox", "remote"],
        })
        || !validateStringSet(capability.effects, {
          required: REQUIRED_PROVIDER_EFFECTS,
        })) return false;
    byProvider.set(capability.provider_ref, capability);
  }
  return expectedProviders.every((providerRef) => byProvider.has(providerRef));
}

async function resolvePlanArtifacts(
  resolvers,
  { plan, project, principal, authority },
  dependencyOptions,
) {
  let facts;
  try {
    facts = await awaitDependency(
      (signal) => resolvers.resolvePlanArtifacts({
        plan,
        project,
        principal,
        authority,
        required_refs: planContentRefs(plan),
        required_provider_effects: [...REQUIRED_PROVIDER_EFFECTS],
        signal,
      }),
      { ...dependencyOptions, dependency: "resolvers.resolvePlanArtifacts" },
    );
  } catch (error) {
    if (dependencyControlError(error)) throw error;
    throw boundaryError(
      "BUSINESS_PLAN_ARTIFACT_RESOLUTION_FAILED",
      "Plan artifact or provider capability resolution failed",
      { cause_code: error?.code || null },
    );
  }
  if (!hasExactFields(facts, PLAN_ARTIFACT_FACT_FIELDS)
      || facts.plan_snapshot_ref !== plan.plan_snapshot_id
      || facts.plan_hash !== plan.plan_hash
      || facts.project_ref !== plan.project_ref
      || !validateVerifiedRefs(facts.verified_refs, plan)
      || !validateProviderCapabilities(facts.provider_capabilities, plan)) {
    throw boundaryError(
      "BUSINESS_PLAN_ARTIFACTS_UNVERIFIED",
      "Plan content references or provider capability ceilings were not verified exactly",
    );
  }
  return Object.freeze(canonicalClone(facts, "BUSINESS_PLAN_ARTIFACTS_UNVERIFIED"));
}

async function resolveCommandFacts(
  resolvers,
  {
    command,
    workOrder,
    plan,
    project,
    principal,
    authority,
    resolvedPlanArtifacts,
    retryBasis,
  },
  dependencyOptions,
) {
  let facts;
  try {
    facts = await awaitDependency(
      (signal) => resolvers.resolveCommandFacts({
        command,
        work_order: workOrder,
        plan,
        project,
        principal,
        authority,
        resolved_plan_artifacts: resolvedPlanArtifacts,
        allowed_fact_fields: [...COMMAND_FACT_FIELDS[command.name]],
        signal,
      }),
      { ...dependencyOptions, dependency: "resolvers.resolveCommandFacts" },
    );
  } catch (error) {
    if (dependencyControlError(error)) throw error;
    throw boundaryError(
      "BUSINESS_COMMAND_FACT_RESOLUTION_FAILED",
      "Command preflight fact resolution failed",
      { cause_code: error?.code || null },
    );
  }
  if (!isPlainObject(facts)) {
    throw boundaryError(
      "BUSINESS_COMMAND_FACTS_UNVERIFIED",
      "Command preflight facts must be a bounded object",
    );
  }
  const allowed = new Set(COMMAND_FACT_FIELDS[command.name]);
  const required = command.name === "branch.retry.request"
      && retryBasis?.kind === "effect_generation"
    ? new Set()
    : REQUIRED_COMMAND_FACT_FIELDS[command.name];
  if (Object.keys(facts).some((field) => !allowed.has(field))
      || [...required].some((field) => !Object.hasOwn(facts, field))) {
    throw boundaryError(
      "BUSINESS_COMMAND_FACTS_UNVERIFIED",
      "Command preflight facts do not exactly match the command's trusted fact surface",
    );
  }
  const normalized = canonicalClone(facts, "BUSINESS_COMMAND_FACTS_UNVERIFIED");
  // An Effect-generation retry reuses the predecessor's immutable Packet V1
  // binding. A resolver-provided packet is tolerated for adapter compatibility
  // but is deliberately excluded from the trusted fact surface.
  if (command.name === "branch.retry.request"
      && retryBasis?.kind === "effect_generation") {
    delete normalized.dispatch_packets;
  }
  return Object.freeze(normalized);
}

function projectorConfiguration() {
  return businessProjectionConfigurationV1();
}

function authoritativeCancellationFacts(projection, workOrder) {
  const result = {};
  for (const branch of Object.values(workOrder.branches)) {
    let candidates = [];
    if (branch.state === "dispatch_pending") {
      candidates = Object.values(projection.outbox).filter((effect) => (
        effect.effect_contract_version === 2
          && effect.work_order_id === workOrder.work_order_id
          && effect.branch_ref === branch.branch_ref
          && effect.attempt === branch.attempt
          && effect.dispatch_id === branch.dispatch_id
          && effect.provider_ref === branch.provider_ref
          && ["provider.thread.create", "provider.turn.start"].includes(effect.effect_kind)
          && ["pending", "claimed", "sending", "delivery_unknown"].includes(effect.status)
      ));
    } else if (branch.state === "waiting_for_user" && branch.pending_user_input_effect_id) {
      const effect = projection.outbox[branch.pending_user_input_effect_id];
      if (effect
          && effect.effect_contract_version === 2
          && effect.work_order_id === workOrder.work_order_id
          && effect.branch_ref === branch.branch_ref
          && effect.attempt === branch.attempt
          && effect.dispatch_id === branch.dispatch_id
          && effect.provider_ref === branch.provider_ref
          && effect.effect_kind === "provider.user_input.submit"
          && ["pending", "claimed", "sending", "delivery_unknown"].includes(effect.status)) {
        candidates = [effect];
      }
    }
    if (candidates.length === 0) continue;
    if (candidates.length !== 1) {
      throw boundaryError(
        "BUSINESS_CANCELLATION_EFFECT_INVALID",
        "Cancellation must resolve one exact current provider effect per branch",
        { branch_ref: branch.branch_ref, matches: candidates.length },
      );
    }
    const effect = candidates[0];
    result[branch.branch_ref] = {
      ...Object.fromEntries(OUTBOX_IMMUTABLE_FIELDS.map((field) => [field, effect[field]])),
      status: effect.status,
    };
  }
  return Object.freeze(canonicalClone(result, "BUSINESS_CANCELLATION_EFFECT_INVALID"));
}

function immutableEffectFact(effect) {
  return {
    ...Object.fromEntries(OUTBOX_IMMUTABLE_FIELDS.map((field) => [field, effect[field]])),
    status: effect.status,
  };
}

function latestNotSentGeneration(projection, workOrder, branch, effectKind, operationScopeHash) {
  const matching = Object.values(projection.outbox).filter((effect) => (
    effect.effect_contract_version === BUSINESS_ENGINE_CONTRACT_VERSION
      && effect.work_order_id === workOrder.work_order_id
      && effect.branch_ref === branch.branch_ref
      && effect.attempt === branch.attempt
      && effect.dispatch_id === branch.dispatch_id
      && effect.provider_ref === branch.provider_ref
      && effect.effect_kind === effectKind
      && effect.operation_scope_hash === operationScopeHash
  ));
  if (matching.length === 0) return null;
  matching.sort((left, right) => left.operation_generation - right.operation_generation);
  const latest = matching.at(-1);
  return latest.status === "not_sent" ? immutableEffectFact(latest) : null;
}

function authoritativeGenerationPredecessors(projection, workOrder, command) {
  if (!["work_order.cancel.request", "user_input.resolve"].includes(command.name)) {
    return Object.freeze({});
  }
  // Validate the complete effect graph once before selecting any predecessor.
  // The command processor derives lineage from the authoritative projection;
  // resolvers and callers can never nominate a predecessor.
  authoritativeLifecycleSnapshot(projection, workOrder);
  const predecessors = {};
  const candidateBranches = command.name === "user_input.resolve"
    ? Object.values(workOrder.branches).filter((branch) => (
      branch.open_user_input?.request_id === command.payload.request_id
    ))
    : Object.values(workOrder.branches);
  for (const branch of candidateBranches) {
    if (!branch.runtime_identity
        || !branch.turn_start_effect_id
        || !branch.turn_start_delivery_hash) continue;
    const effectKind = command.name === "user_input.resolve"
      ? "provider.user_input.submit"
      : "provider.turn.cancel";
    const operationScopeHash = deriveEffectOperationScopeHashV2({
      effect_kind: effectKind,
      provider_ref: branch.provider_ref,
      predecessor_effect_id: branch.turn_start_effect_id,
      predecessor_delivery_hash: branch.turn_start_delivery_hash,
      target_runtime_identity: branch.runtime_identity,
      request_id: command.name === "user_input.resolve"
        ? command.payload.request_id
        : undefined,
      response_ref: command.name === "user_input.resolve"
        ? command.payload.response_ref
        : undefined,
    });
    const predecessor = latestNotSentGeneration(
      projection,
      workOrder,
      branch,
      effectKind,
      operationScopeHash,
    );
    if (predecessor) predecessors[branch.branch_ref] = predecessor;
  }
  return Object.freeze(canonicalClone(
    predecessors,
    "BUSINESS_EFFECT_GENERATION_PREDECESSOR_INVALID",
  ));
}

function projectionRetryError(message, details = {}) {
  return boundaryError(
    "BUSINESS_WORK_ORDER_PROJECTION_INVALID",
    message,
    details,
  );
}

function currentStartStage(branch) {
  if (branch.turn_start_effect_id) return null;
  return branch.thread_create_effect_id
    ? "provider.turn.start"
    : "provider.thread.create";
}

function currentStartOperationScopeHash(branch, effectKind) {
  if (!branch.packet_ref) return null;
  return deriveEffectOperationScopeHashV2({
    effect_kind: effectKind,
    provider_ref: branch.provider_ref,
    packet_ref: branch.packet_ref.id,
    packet_hash: branch.packet_ref.hash,
    predecessor_effect_id: effectKind === "provider.turn.start"
      ? branch.thread_create_effect_id
      : null,
    predecessor_delivery_hash: effectKind === "provider.turn.start"
      ? branch.thread_create_delivery_hash
      : null,
    target_runtime_identity: effectKind === "provider.turn.start"
      ? branch.thread_identity
      : null,
  });
}

function latestCurrentStartEffect(projection, workOrder, branch) {
  const effectKind = currentStartStage(branch);
  if (!effectKind) return null;
  const operationScopeHash = currentStartOperationScopeHash(branch, effectKind);
  if (operationScopeHash === null) return null;
  const candidates = Object.values(projection.outbox).filter((effect) => (
    effect.effect_contract_version === BUSINESS_ENGINE_CONTRACT_VERSION
      && effect.work_order_id === workOrder.work_order_id
      && effect.branch_ref === branch.branch_ref
      && effect.attempt === branch.attempt
      && effect.dispatch_id === branch.dispatch_id
      && effect.provider_ref === branch.provider_ref
      && effect.effect_kind === effectKind
      && effect.operation_scope_hash === operationScopeHash
      && effect.packet_ref === branch.packet_ref.id
      && effect.packet_hash === branch.packet_ref.hash
  ));
  if (candidates.length === 0) return null;
  candidates.sort((left, right) => left.operation_generation - right.operation_generation);
  return candidates.at(-1);
}

function effectGenerationRetryBasis(projection, workOrder, branch) {
  const predecessor = latestCurrentStartEffect(projection, workOrder, branch);
  if (!predecessor || predecessor.status !== "not_sent") return null;
  // A V2 not-sent effect is never allowed to fall back to a new branch
  // attempt. Only its stored, shared settlement policy may authorize another
  // mutation of the same semantic operation.
  if (predecessor.settlement_policy === null
      || predecessor.settlement_policy === undefined) return null;
  let settlementPolicy;
  let schedule;
  try {
    settlementPolicy = normalizeSettlementPolicyRecordV2(predecessor.settlement_policy);
    if (settlementPolicy.effect_kind !== predecessor.effect_kind
        || settlementPolicy.classification !== "not_sent"
        || settlementPolicy.disposition !== "retry_candidate"
        || settlementPolicy.retry.scope !== "effect_generation") {
      throw projectionRetryError(
        "The current not-sent start effect has a contradictory settlement policy",
        { effect_id: predecessor.effect_id },
      );
    }
    if (!isPlainObject(predecessor.delivery)
        || predecessor.delivery.classification !== "not_sent") {
      throw projectionRetryError(
        "The current not-sent start effect is missing its exact terminal delivery fact",
        { effect_id: predecessor.effect_id },
      );
    }
    schedule = deriveEffectGenerationRetryScheduleV2({
      settlement_policy: settlementPolicy,
      retry_policy: {
        backoff_initial_ms: workOrder.plan.retry_policy.backoff_initial_ms,
        backoff_max_ms: workOrder.plan.retry_policy.backoff_max_ms,
        max_attempts: workOrder.plan.retry_policy.max_attempts,
      },
      completed_generation: predecessor.operation_generation,
      settled_at: predecessor.delivery.recorded_at,
      attempt_deadline_at: branch.attempt_deadline_at,
      work_order_deadline_at: workOrder.deadline_at,
    });
  } catch (error) {
    if (error instanceof BusinessCommandBoundaryError) throw error;
    throw projectionRetryError(
      "The current not-sent start effect has invalid durable retry semantics",
      { effect_id: predecessor.effect_id, cause_code: error?.code || null },
    );
  }
  if (!schedule.permitted) {
    throw boundaryError(
      "BUSINESS_RETRY_EXHAUSTED",
      "The Effect generation retry is outside its bounded generation or deadline window",
      {
        effect_id: predecessor.effect_id,
        eligible_at: schedule.eligible_at,
        next_generation: schedule.next_generation,
      },
    );
  }
  if (branch.state === "retryable" && branch.retry_at !== schedule.eligible_at) {
    throw projectionRetryError(
      "The retryable branch does not retain the shared Effect-generation schedule",
      {
        branch_ref: branch.branch_ref,
        expected_retry_at: schedule.eligible_at,
        actual_retry_at: branch.retry_at ?? null,
      },
    );
  }
  return Object.freeze(canonicalClone({
    kind: "effect_generation",
    predecessor: immutableEffectFact(predecessor),
    settlement_policy: settlementPolicy,
    eligible_at: schedule.eligible_at,
  }, "BUSINESS_EFFECT_GENERATION_PREDECESSOR_INVALID"));
}

function branchAttemptRetryBasis(branch) {
  const acceptedDelivery = isPlainObject(branch.delivery)
    && branch.delivery.classification === "accepted";
  if (branch.state !== "failed" || !acceptedDelivery) return null;
  const runtimeObservation = branch.last_runtime_observation ?? null;
  const runtimeFailure = isPlainObject(runtimeObservation)
    && runtimeObservation.name === "branch.failed"
    && runtimeObservation.payload?.branch_ref === branch.branch_ref
    && runtimeObservation.payload?.attempt === branch.attempt;
  const resultFailure = isPlainObject(branch.result)
    && branch.result.attempt === branch.attempt;
  if (!runtimeFailure && !resultFailure) return null;
  return Object.freeze(canonicalClone({
    kind: "branch_attempt",
    terminal_evidence: {
      kind: runtimeFailure ? "accepted_runtime_failure" : "accepted_result_failure",
      attempt: branch.attempt,
      dispatch_id: branch.dispatch_id,
      delivery: branch.delivery,
      runtime_observation: runtimeObservation,
      result: branch.result ?? null,
    },
  }, "BUSINESS_WORK_ORDER_PROJECTION_INVALID"));
}

function authoritativeRetryBasis(projection, workOrder, command) {
  if (command.name !== "branch.retry.request") return null;
  const branch = workOrder.branches[command.payload.branch_ref];
  if (!branch || branch.attempt !== command.payload.failed_attempt) {
    throw boundaryError(
      "BUSINESS_RETRY_NOT_SAFE",
      "Retry does not target the current branch attempt",
      { branch_ref: command.payload.branch_ref },
    );
  }
  const generation = effectGenerationRetryBasis(projection, workOrder, branch);
  if (generation) return generation;
  const branchAttempt = branchAttemptRetryBasis(branch);
  if (branchAttempt) return branchAttempt;
  throw boundaryError(
    "BUSINESS_RETRY_NOT_SAFE",
    "Retry lacks authoritative Effect-generation or accepted-attempt terminal evidence",
    { branch_ref: branch.branch_ref, attempt: branch.attempt },
  );
}

function authoritativeLifecycleSnapshot(projection, workOrder) {
  try {
    return assertLifecycleInvariants(deriveLifecycleSnapshot({
      workOrder,
      outbox: projection.outbox,
      attention: workOrder.attention,
    }));
  } catch (error) {
    if (error?.code !== "BUSINESS_LIFECYCLE_INVARIANT") throw error;
    throw boundaryError(
      "BUSINESS_WORK_ORDER_PROJECTION_INVALID",
      "The Work Order provider-effect lifecycle is internally inconsistent",
      {
        violations: Array.isArray(error.details?.violations)
          ? error.details.violations.map((violation) => violation.code)
          : [],
      },
    );
  }
}

function normalizeProjection(replay) {
  if (!isPlainObject(replay)
      || !isPlainObject(replay.state)
      || !isPlainObject(replay.watermark)
      || !Number.isSafeInteger(replay.watermark.journal_sequence)
      || replay.watermark.journal_sequence < 0) {
    throw boundaryError(
      "BUSINESS_PROJECTION_INVALID",
      "EventStore replay returned an invalid projection or watermark",
    );
  }
  if (!isPlainObject(replay.state.work_orders)
      || !isPlainObject(replay.state.command_receipts)) {
    throw boundaryError(
      "BUSINESS_PROJECTION_INVALID",
      "Business projection is missing work orders or command receipts",
    );
  }
  return replay;
}

function commandIdentityHash(command, principal) {
  return canonicalHash({
    source_type: "command",
    command,
    authenticated_principal: principal,
  });
}

function readReceipt(projection, command, identityHash) {
  const receipt = projection.command_receipts[command.command_id];
  if (receipt === undefined) return RECEIPT_NOT_FOUND;
  if (!isPlainObject(receipt)
      || receipt.source_id !== command.command_id
      || receipt.source_type !== "command"
      || typeof receipt.identity_hash !== "string"
      || !Object.hasOwn(receipt, "result")) {
    throw boundaryError(
      "BUSINESS_COMMAND_RECEIPT_INVALID",
      "Stored command receipt is malformed",
      { command_id: command.command_id },
    );
  }
  if (receipt.identity_hash !== identityHash) {
    throw boundaryError(
      "BUSINESS_COMMAND_ID_CONFLICT",
      "Command ID is already bound to different immutable content or principal",
      { command_id: command.command_id },
    );
  }
  return canonicalClone(receipt.result, "BUSINESS_COMMAND_RECEIPT_INVALID");
}

function currentWorkOrderRevision(workOrder) {
  if (!isPlainObject(workOrder)
      || !Number.isSafeInteger(workOrder.revision)
      || workOrder.revision < 1) {
    throw boundaryError(
      "BUSINESS_WORK_ORDER_PROJECTION_INVALID",
      "Work Order projection has an invalid revision",
    );
  }
  return workOrder.revision;
}

function assertExpectedRevision(command, workOrder) {
  const actualRevision = workOrder ? currentWorkOrderRevision(workOrder) : 0;
  if (command.expected_work_order_revision !== actualRevision) {
    throw boundaryError(
      "BUSINESS_WORK_ORDER_STALE",
      "Expected Work Order revision does not match the authoritative projection",
      {
        work_order_id: command.work_order_id,
        expected_revision: command.expected_work_order_revision,
        actual_revision: actualRevision,
      },
    );
  }
}

function normalizeDecisionEvent(intent, sourceId, ordinal) {
  if (!isPlainObject(intent)
      || !BUSINESS_EVENT_TYPE_SET.has(intent.type)
      || !isPlainObject(intent.payload)
      || (intent.evidence_refs !== undefined && !Array.isArray(intent.evidence_refs))) {
    throw boundaryError(
      "BUSINESS_COMMAND_DECISION_INVALID",
      "Decider returned an invalid or unsupported business event",
      { ordinal },
    );
  }
  const evidenceRefs = intent.evidence_refs || [];
  if (evidenceRefs.some((ref) => typeof ref !== "string" || ref.trim() === "")) {
    throw boundaryError(
      "BUSINESS_COMMAND_DECISION_INVALID",
      "Decider event evidence references must be non-empty strings",
      { ordinal },
    );
  }
  const payload = canonicalClone(intent.payload);
  const eventId = `BVE-${canonicalHash({
    source_id: sourceId,
    ordinal,
    type: intent.type,
    payload,
    evidence_refs: evidenceRefs,
  }).slice(0, 32)}`;
  return {
    event_id: eventId,
    schema_version: 1,
    type: intent.type,
    payload,
    evidence_refs: [...evidenceRefs],
  };
}

function normalizeDecision(decision, command) {
  if (!isPlainObject(decision) || !Array.isArray(decision.events)
      || decision.events.length === 0
      || !Object.hasOwn(decision, "result")) {
    throw boundaryError(
      "BUSINESS_COMMAND_DECISION_INVALID",
      "Decider must return at least one domain event and a result",
    );
  }
  const result = canonicalClone(decision.result);
  const targetRevision = command.expected_work_order_revision + 1;
  if (decision.applied_revision !== undefined && decision.applied_revision !== targetRevision) {
    throw boundaryError(
      "BUSINESS_COMMAND_DECISION_INVALID",
      "Decider applied_revision must advance the Work Order exactly once",
    );
  }
  if (isPlainObject(result)
      && Object.hasOwn(result, "work_order_revision")
      && result.work_order_revision !== targetRevision) {
    throw boundaryError(
      "BUSINESS_COMMAND_DECISION_INVALID",
      "Decision result work_order_revision does not match the command transition",
    );
  }
  if (command.name === "work_order.start") {
    const created = decision.events.filter((event) => (
      isPlainObject(event) && event.type === "business.work_order.created"
    ));
    if (created.length !== 1
        || created[0].payload.engine_contract_version !== BUSINESS_ENGINE_CONTRACT_VERSION) {
      throw boundaryError(
        "BUSINESS_COMMAND_DECISION_INVALID",
        "A new Work Order must declare exactly one current engine contract version",
        { engine_contract_version: BUSINESS_ENGINE_CONTRACT_VERSION },
      );
    }
  }
  return {
    events: decision.events.map((event, index) => (
      normalizeDecisionEvent(event, command.command_id, index)
    )),
    result,
    appliedRevision: targetRevision,
  };
}

function receiptEvent(command, principal, identityHash, decision, occurredAt) {
  const batchId = `business:${command.command_id}`;
  const receipt = {
    source_id: command.command_id,
    source_type: "command",
    identity_hash: identityHash,
    payload_hash: command.payload_hash,
    work_order_id: command.work_order_id,
    applied_revision: decision.appliedRevision,
    batch_id: batchId,
    event_ids: decision.events.map((event) => event.event_id),
    result: decision.result,
  };
  const ordinal = decision.events.length;
  const event = normalizeDecisionEvent(
    {
      type: "business.command.received",
      payload: {
        work_order_id: command.work_order_id,
        plan_snapshot_ref: command.plan_snapshot_ref,
        plan_hash: command.plan_hash,
        source_id: command.command_id,
        prior_work_order_revision: command.expected_work_order_revision,
        target_work_order_revision: decision.appliedRevision,
        occurred_at: occurredAt,
        receipt,
      },
      evidence_refs: [],
    },
    command.command_id,
    ordinal,
  );
  return { batchId, receipt, event, actor: { type: principal.type, id: principal.id } };
}

function workOrderPlan(workOrder, command) {
  if (!isPlainObject(workOrder) || !Object.hasOwn(workOrder, "plan")) {
    throw boundaryError(
      "BUSINESS_WORK_ORDER_PROJECTION_INVALID",
      "Work Order projection does not retain its normalized plan",
    );
  }
  return normalizeResolvedPlan(workOrder.plan, command);
}

function mapBatchConflict(error, commandId) {
  if (error?.code !== "EVENT_BATCH_ID_CONFLICT") return error;
  return boundaryError(
    "BUSINESS_COMMAND_ID_CONFLICT",
    "Command ID is already bound to a different atomic batch",
    { command_id: commandId },
  );
}

function prevalidateCandidateBatch(projection, request, command, identityHash) {
  let candidate = projection;
  try {
    for (const event of request.events) {
      candidate = projectBusinessEventV1(candidate, event, request);
    }
  } catch (error) {
    if (error instanceof BusinessCommandBoundaryError) throw error;
    throw boundaryError(
      "BUSINESS_COMMAND_DECISION_INVALID",
      "Candidate events failed the authoritative Business projector",
      { cause_code: error?.code || null },
    );
  }
  const storedResult = readReceipt(candidate, command, identityHash);
  if (storedResult === RECEIPT_NOT_FOUND) {
    throw boundaryError(
      "BUSINESS_COMMAND_RECEIPT_MISSING",
      "Candidate EventStore batch did not close with its exact command receipt",
      { command_id: command.command_id },
    );
  }
  return storedResult;
}

/**
 * Creates the authenticated, receipt-idempotent EventStore command boundary.
 * This component persists event and outbox intent only. It has no provider
 * dependency and never performs an external provider mutation.
 */
function createBusinessCommandBoundary(options = {}) {
  const {
    eventStore,
    authorizer,
    resolvers,
    decider,
    clock = () => new Date().toISOString(),
    maxGlobalCasRetries = 3,
    dependencyTimeoutMs = 5_000,
  } = options;
  validateDependency(eventStore && typeof eventStore.replay === "function", "eventStore.replay");
  validateDependency(eventStore && typeof eventStore.commit === "function", "eventStore.commit");
  validateDependency(authorizer && typeof authorizer.authenticate === "function", "authorizer.authenticate");
  validateDependency(authorizer && typeof authorizer.authorize === "function", "authorizer.authorize");
  validateDependency(resolvers && typeof resolvers.resolvePlan === "function", "resolvers.resolvePlan");
  validateDependency(resolvers && typeof resolvers.resolveProject === "function", "resolvers.resolveProject");
  validateDependency(
    resolvers && typeof resolvers.resolvePlanArtifacts === "function",
    "resolvers.resolvePlanArtifacts",
  );
  validateDependency(
    resolvers && typeof resolvers.resolveCommandFacts === "function",
    "resolvers.resolveCommandFacts",
  );
  validateDependency(typeof decider === "function", "decider");
  validateDependency(typeof clock === "function", "clock");
  if (!Number.isSafeInteger(maxGlobalCasRetries)
      || maxGlobalCasRetries < 0
      || maxGlobalCasRetries > 10) {
    throw new TypeError("maxGlobalCasRetries must be an integer from 0 to 10");
  }
  validateDependencyTimeout(dependencyTimeoutMs);
  const projectionConfig = projectorConfiguration();

  async function execute(input) {
    if (!isPlainObject(input) || !Object.hasOwn(input, "command")) {
      throw new TypeError("execute input must contain command and authentication");
    }
    const command = normalizeCommandEnvelopeV1(input.command);
    const signal = validateAbortSignal(input.signal);
    const dependencyOptions = { signal, timeoutMs: dependencyTimeoutMs };
    const recoveryDependencyOptions = { signal: null, timeoutMs: dependencyTimeoutMs };
    const principal = await authenticate(authorizer, input.authentication, dependencyOptions);
    validateCommandActorBinding(command, principal);
    const identityHash = commandIdentityHash(command, principal);
    for (let casAttempt = 0; casAttempt <= maxGlobalCasRetries; casAttempt += 1) {
      const replay = normalizeProjection(await awaitDependency(
        () => eventStore.replay(projectionConfig),
        { ...dependencyOptions, dependency: "eventStore.replay" },
      ));
      const projection = replay.state;
      const workOrder = projection.work_orders[command.work_order_id] || null;
      if (command.name !== "work_order.start" && !workOrder) {
        throw boundaryError(
          "BUSINESS_WORK_ORDER_NOT_FOUND",
          "Work Order does not exist",
          { work_order_id: command.work_order_id },
        );
      }
      const startPlan = command.name === "work_order.start"
        ? await resolveStartPlan(resolvers, command, principal, dependencyOptions)
        : null;
      const plan = startPlan || workOrderPlan(workOrder, command);
      const project = await resolveProject(resolvers, plan, principal, dependencyOptions);
      const authorizedCeiling = await authorize(authorizer, {
        principal,
        action: command.name,
        command,
        work_order: workOrder,
        plan,
        project,
      }, dependencyOptions);
      const authority = validateAuthorityCeiling(authorizedCeiling, plan, principal);
      // Durable receipts precede all optimistic business-revision checks.
      const replayedResult = readReceipt(projection, command, identityHash);
      if (replayedResult !== RECEIPT_NOT_FOUND) return replayedResult;

      if (workOrder
          && workOrder.engine_contract_version !== BUSINESS_ENGINE_CONTRACT_VERSION) {
        throw boundaryError(
          "BUSINESS_ENGINE_MIGRATION_REQUIRED",
          "Legacy Work Orders are replay-only until an explicit engine migration is committed",
          {
            work_order_id: command.work_order_id,
            engine_contract_version: workOrder.engine_contract_version ?? 1,
          },
        );
      }
      let retryBasis = null;
      if (workOrder
          && ["work_order.resume", "branch.retry.request"].includes(command.name)) {
        const lifecycle = authoritativeLifecycleSnapshot(projection, workOrder);
        const retryBranch = command.name === "branch.retry.request"
          ? lifecycle.branches[command.payload.branch_ref]
          : null;
        // Lifecycle owns only provider-mutation clearance. Failure certainty,
        // backoff, attempts, and deadlines remain the decider's policy. An
        // unrelated branch cleanup hold must not revoke this branch's retry.
        if (retryBranch && !retryBranch.lifecycle_retry_clear) {
          throw boundaryError(
            "BUSINESS_COMMAND_LIFECYCLE_HOLD",
            "Forward automation cannot resume while a provider mutation still needs cleanup",
            {
              blocking_effect_ids: retryBranch.cleanup_blocking_effect_ids,
              branch_ref: command.payload.branch_ref || null,
            },
          );
        }
        if (command.name === "branch.retry.request") {
          retryBasis = authoritativeRetryBasis(projection, workOrder, command);
        }
      }

      if (command.name === "work_order.start" && workOrder) {
        throw boundaryError(
          "BUSINESS_WORK_ORDER_EXISTS",
          "Work Order already exists under a different command",
          { work_order_id: command.work_order_id },
        );
      }
      assertExpectedRevision(command, workOrder);
      // Every optimistic retry is a new decision over a newer projection.
      // Its durable time must therefore be sampled for that candidate rather
      // than inherited from the CAS loser.
      const occurredAt = validateClockValue(clock());
      const startArtifactFacts = startPlan
        ? await resolvePlanArtifacts(resolvers, {
          plan,
          project,
          principal,
          authority,
        }, dependencyOptions)
        : null;
      const commandFacts = await resolveCommandFacts(resolvers, {
        command,
        workOrder,
        plan,
        project,
        principal,
        authority,
        resolvedPlanArtifacts: startArtifactFacts,
        retryBasis,
      }, dependencyOptions);

      const trustedFacts = Object.freeze({
        occurred_at: occurredAt,
        authenticated_principal: principal,
        authority,
        plan,
        project,
        resolved_plan_artifacts: startArtifactFacts,
        ...commandFacts,
        ...(retryBasis === null ? {} : { retry_basis: retryBasis }),
        ...(command.name === "work_order.cancel.request"
          ? { cancellation: authoritativeCancellationFacts(projection, workOrder) }
          : {}),
        ...(["work_order.cancel.request", "user_input.resolve"].includes(command.name)
          ? {
            generation_predecessors: authoritativeGenerationPredecessors(
              projection,
              workOrder,
              command,
            ),
          }
          : {}),
      });
      const decision = normalizeDecision(
        await awaitDependency(
          () => decider(workOrder, command, trustedFacts),
          { ...dependencyOptions, dependency: "decider" },
        ),
        command,
      );
      const receipt = receiptEvent(command, principal, identityHash, decision, occurredAt);
      const request = {
        expected_revision: replay.watermark.journal_sequence,
        batch_id: receipt.batchId,
        actor: receipt.actor,
        correlation_id: command.command_id,
        events: [...decision.events, receipt.event],
      };
      const projectedResult = prevalidateCandidateBatch(
        projection,
        request,
        command,
        identityHash,
      );
      if (canonicalJson(projectedResult) !== canonicalJson(decision.result)) {
        throw boundaryError(
          "BUSINESS_COMMAND_DECISION_INVALID",
          "Candidate projection receipt result does not match the decision result",
        );
      }

      // Abort is honored only before entering the durable write boundary. Once
      // commit starts, its outcome must be reconciled rather than abandoned.
      assertNotAborted(signal, "eventStore.commit");
      try {
        const commitResult = await eventStore.commit(request);
        if (!isPlainObject(commitResult)
            || !["committed", "idempotent"].includes(commitResult.status)) {
          throw boundaryError(
            "BUSINESS_EVENT_STORE_RESULT_INVALID",
            "EventStore returned an invalid commit result",
          );
        }
        if (commitResult.status === "idempotent") {
          const committedReplay = normalizeProjection(await awaitDependency(
            () => eventStore.replay(projectionConfig),
            { ...recoveryDependencyOptions, dependency: "eventStore.replay_after_commit" },
          ));
          const storedResult = readReceipt(committedReplay.state, command, identityHash);
          if (storedResult === RECEIPT_NOT_FOUND) {
            throw boundaryError(
              "BUSINESS_COMMAND_RECEIPT_MISSING",
              "Idempotent EventStore batch has no projected command receipt",
              { command_id: command.command_id },
            );
          }
          return storedResult;
        }
        return canonicalClone(decision.result);
      } catch (error) {
        if (["EVENT_REVISION_CONFLICT", "EVENT_LOCK_BUSY"].includes(error?.code)) {
          if (casAttempt < maxGlobalCasRetries) continue;
          throw boundaryError(
            "BUSINESS_GLOBAL_CAS_EXHAUSTED",
            "Global EventStore revision changed too many times",
            { attempts: casAttempt + 1 },
          );
        }
        if (error?.code === "EVENT_BATCH_ID_CONFLICT") {
          const concurrentReplay = normalizeProjection(await awaitDependency(
            () => eventStore.replay(projectionConfig),
            { ...recoveryDependencyOptions, dependency: "eventStore.replay_after_conflict" },
          ));
          const storedResult = readReceipt(concurrentReplay.state, command, identityHash);
          if (storedResult !== RECEIPT_NOT_FOUND) return storedResult;
        }
        if (!dependencyControlError(error)) {
          try {
            const uncertainReplay = normalizeProjection(await awaitDependency(
              () => eventStore.replay(projectionConfig),
              { ...recoveryDependencyOptions, dependency: "eventStore.replay_after_commit_error" },
            ));
            const storedResult = readReceipt(uncertainReplay.state, command, identityHash);
            if (storedResult !== RECEIPT_NOT_FOUND) return storedResult;
          } catch {
            // Preserve the original commit failure when reconciliation itself
            // cannot prove that the exact receipt is durable.
          }
        }
        const mapped = mapBatchConflict(error, command.command_id);
        if (mapped instanceof BusinessCommandBoundaryError) throw mapped;
        throw boundaryError(
          "BUSINESS_COMMAND_EVENT_STORE_COMMIT_FAILED",
          "Command commit failed without a matching durable receipt",
          { cause_code: mapped?.code || null, commit_outcome: "not_observed" },
        );
      }
    }
    throw boundaryError(
      "BUSINESS_GLOBAL_CAS_EXHAUSTED",
      "Global EventStore revision retry bound was exhausted",
    );
  }

  return Object.freeze({ execute });
}

module.exports = {
  BUSINESS_EVENT_TYPES,
  REQUIRED_PROVIDER_EFFECTS,
  BusinessCommandBoundaryError,
  createBusinessCommandBoundary,
};
