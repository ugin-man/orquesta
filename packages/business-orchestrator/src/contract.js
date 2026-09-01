"use strict";

const { canonicalHash, canonicalJson } = require("@orquesta/contracts");
const { V2_PRESEND_FAILURE_REASONS } = require("./settlement-policy");

const BUSINESS_WORK_ORDER_PLAN_VERSION = 1;
const BUSINESS_ENGINE_CONTRACT_VERSION = 2;
const COMMAND_ENVELOPE_VERSION = 1;
const RUNTIME_OBSERVATION_ENVELOPE_VERSION = 1;
const EFFECT_SETTLEMENT_OBSERVATION_ENVELOPE_VERSION = 2;

const CONTRACT_LIMITS = deepFreeze({
  max_plan_bytes: 262_144,
  max_envelope_bytes: 98_304,
  max_payload_bytes: 65_536,
  max_input_depth: 16,
  max_input_nodes: 8_192,
  max_branches: 64,
  max_acceptance_criteria: 64,
  max_verification_requirements_per_criterion: 16,
  max_review_findings_per_severity: 10_000,
  max_dependencies_per_branch: 64,
  max_provider_refs: 16,
  max_evidence_refs: 128,
  max_ref_bytes: 256,
  max_text_bytes: 32_768,
});

const ACCEPTANCE_VERIFICATION_MODES = Object.freeze([
  "deterministic",
  "mixed",
  "human_only",
]);
const REVIEW_MINIMUMS = Object.freeze(["light", "normal", "strict"]);
const BRANCH_ROLES = Object.freeze(["work", "integration"]);
const BRANCH_ISOLATION_MODES = Object.freeze([
  "read-only",
  "worktree",
  "sandbox",
  "remote",
]);
const PERMISSION_MODES = Object.freeze(["read-only", "workspace-write"]);
const PROVIDER_SELECTION_MODES = Object.freeze(["fixed", "fallback_allowed"]);
// Automatic retry is only safe when the trusted runtime proves the provider
// effect was never attempted. Every post-send ambiguity requires reconciliation.
const RETRYABLE_RUNTIME_OBSERVATIONS = Object.freeze(["branch.dispatch.not_sent"]);
const COMMAND_ACTOR_TYPES = Object.freeze(["user", "orchestrator"]);
const RUNTIME_OBSERVATION_ACTOR_TYPES = Object.freeze([
  "runtime",
  "provider",
  "verifier",
]);
const WORK_ORDER_COMMAND_NAMES = Object.freeze([
  "work_order.start",
  "work_order.cancel.request",
  "work_order.resume",
  "branch.retry.request",
  "user_input.resolve",
  "acceptance.decision.record",
]);
const RUNTIME_OBSERVATION_NAMES = Object.freeze([
  "work_order.started",
  "work_order.cancelled",
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
  "verification.recorded",
  "review.recorded",
  "provider.rate_limited",
  "provider.unavailable",
]);
const EFFECT_SETTLEMENT_OBSERVATION_NAMES = Object.freeze([
  "provider.effect.settlement.recorded",
]);
const EFFECT_SEND_EXPIRY_OBSERVATION_NAMES = Object.freeze([
  "provider.effect.send_expiration.recorded",
]);
const EFFECT_PRESEND_FAILURE_OBSERVATION_NAMES = Object.freeze([
  "provider.effect.presend_failure.recorded",
]);
const EFFECT_SETTLEMENT_SOURCES = Object.freeze([
  "worker_result",
  "recovery_probe",
]);

const PLAN_REQUIRED_FIELDS = Object.freeze([
  "version",
  "project_ref",
  "revision",
  "supersedes_plan_ref",
  "title",
  "desired_outcome",
  "acceptance_policy",
  "task_intent_ref",
  "execution_plan_ref",
  "context_pack_ref",
  "branches",
  "integration_branch_ref",
  "max_concurrency",
  "context_duplication_budget_tokens",
  "retry_policy",
  "lease_policy",
  "provider_policy",
  "permission_mode",
]);
const PLAN_FIELDS = new Set([
  ...PLAN_REQUIRED_FIELDS,
  "plan_snapshot_id",
  "plan_hash",
]);
const ACCEPTANCE_POLICY_FIELDS = new Set(["criteria", "review_minimum"]);
const ACCEPTANCE_CRITERION_FIELDS = new Set([
  "criterion_id",
  "description",
  "verification",
  "verification_requirements",
]);
const VERIFICATION_REQUIREMENT_FIELDS = new Set(["kind", "verification_ref"]);
const VERIFICATION_REQUIREMENT_KINDS = Object.freeze(["deterministic", "human"]);
const BRANCH_FIELDS = new Set([
  "branch_ref",
  "task_intent_ref",
  "execution_plan_ref",
  "context_pack_ref",
  "dependencies",
  "role",
  "parallelizable",
  "isolation",
  "assignee_ref",
  "provider_ref",
  "permission_mode",
]);
const RETRY_POLICY_FIELDS = new Set([
  "max_attempts",
  "attempt_timeout_ms",
  "max_elapsed_ms",
  "backoff_initial_ms",
  "backoff_max_ms",
  "retryable_observations",
]);
const LEASE_POLICY_FIELDS = new Set([
  "lease_duration_ms",
  "heartbeat_interval_ms",
  "max_recovery_probes",
]);
const PROVIDER_POLICY_FIELDS = new Set([
  "allowed_provider_refs",
  "selection",
]);
const COMMAND_FIELDS = new Set([
  "version",
  "command_id",
  "work_order_id",
  "plan_snapshot_ref",
  "plan_hash",
  "expected_work_order_revision",
  "actor",
  "name",
  "payload",
  "payload_hash",
]);
const OBSERVATION_FIELDS = new Set([
  "version",
  "observation_id",
  "work_order_id",
  "plan_snapshot_ref",
  "plan_hash",
  "work_order_revision",
  "actor",
  "name",
  "payload",
  "payload_hash",
]);
const ACTOR_FIELDS = new Set(["type", "actor_id"]);
const CONTENT_REF_FIELDS = new Set(["id", "hash"]);
const REVIEW_FINDINGS_FIELDS = new Set(["critical", "important", "minor"]);
const EFFECT_SETTLEMENT_COMMON_PAYLOAD_FIELDS = Object.freeze([
  "effect_id",
  "effect_contract_version",
  "effect_kind",
  "branch_ref",
  "attempt",
  "dispatch_id",
  "classification",
  "settlement_source",
]);
const WORKER_SETTLEMENT_PAYLOAD_FIELDS = new Set([
  ...EFFECT_SETTLEMENT_COMMON_PAYLOAD_FIELDS,
  "worker_fencing_token",
  "worker_result_ref",
]);
const RECOVERY_PROBE_SETTLEMENT_PAYLOAD_FIELDS = new Set([
  ...EFFECT_SETTLEMENT_COMMON_PAYLOAD_FIELDS,
  "recovery_probe",
]);
const WORKER_FENCING_TOKEN_FIELDS = new Set(["lease_id", "owner_id", "generation"]);
const RECOVERY_PROBE_FIELDS = new Set([
  "probe_receipt_ref",
  "mutation_idempotency_key",
]);
const EFFECT_SEND_EXPIRY_PAYLOAD_FIELDS = new Set([
  "effect_id",
  "effect_contract_version",
  "effect_kind",
  "branch_ref",
  "attempt",
  "dispatch_id",
  "expired_fencing_token",
  "lease_expires_at",
  "expiry_receipt_ref",
]);
const EFFECT_PRESEND_FAILURE_PAYLOAD_FIELDS = new Set([
  "effect_id",
  "effect_contract_version",
  "effect_kind",
  "branch_ref",
  "attempt",
  "dispatch_id",
  "claimed_fencing_token",
  "failure_reason",
  "failure_record_ref",
]);

const COMMAND_PAYLOAD_FIELDS = Object.freeze({
  "work_order.start": new Set(),
  "work_order.cancel.request": new Set(["reason"]),
  "work_order.resume": new Set(["reason"]),
  "branch.retry.request": new Set(["branch_ref", "failed_attempt", "reason"]),
  "user_input.resolve": new Set(["request_id", "response_ref"]),
  "acceptance.decision.record": new Set(["decision", "evidence_refs", "comment"]),
});

const OBSERVATION_PAYLOAD_FIELDS = Object.freeze({
  "work_order.started": new Set(),
  "work_order.cancelled": new Set(["reason"]),
  "provider.effect.delivery.recorded": new Set([
    "effect_id",
    "effect_contract_version",
    "effect_kind",
    "branch_ref",
    "attempt",
    "dispatch_id",
    "classification",
  ]),
  "branch.dispatch.accepted": new Set(["branch_ref", "attempt", "dispatch_id"]),
  "branch.dispatch.not_sent": new Set(["branch_ref", "attempt", "dispatch_id", "reason"]),
  "branch.progress": new Set(["branch_ref", "attempt", "message"]),
  "branch.result.submitted": new Set([
    "branch_ref",
    "attempt",
    "artifact_refs",
    "evidence_refs",
  ]),
  "branch.failed": new Set(["branch_ref", "attempt", "failure_code"]),
  "branch.timed_out": new Set(["branch_ref", "attempt", "timeout_ms"]),
  "branch.delivery_unknown": new Set(["branch_ref", "attempt", "dispatch_id", "detail"]),
  "branch.cancelled": new Set(["branch_ref", "attempt", "reason"]),
  "user_input.requested": new Set(["branch_ref", "request_id", "prompt_ref"]),
  "verification.recorded": new Set([
    "branch_ref",
    "criterion_id",
    "verification_ref",
    "kind",
    "status",
    "evidence_refs",
  ]),
  "review.recorded": new Set([
    "branch_ref",
    "review_id",
    "status",
    "findings",
    "evidence_refs",
  ]),
  "provider.rate_limited": new Set(["branch_ref", "attempt", "retry_after_ms"]),
  "provider.unavailable": new Set(["branch_ref", "attempt", "detail"]),
});

const COMMAND_ACTORS_BY_NAME = Object.freeze({
  "work_order.start": Object.freeze(["orchestrator"]),
  "work_order.cancel.request": Object.freeze(["user", "orchestrator"]),
  "work_order.resume": Object.freeze(["user", "orchestrator"]),
  "branch.retry.request": Object.freeze(["orchestrator"]),
  "user_input.resolve": Object.freeze(["user"]),
  "acceptance.decision.record": Object.freeze(["user"]),
});

const OBSERVATION_ACTORS_BY_NAME = Object.freeze({
  "work_order.started": Object.freeze(["runtime"]),
  "work_order.cancelled": Object.freeze(["runtime"]),
  "provider.effect.delivery.recorded": Object.freeze(["runtime", "provider"]),
  "branch.dispatch.accepted": Object.freeze(["runtime", "provider"]),
  "branch.dispatch.not_sent": Object.freeze(["runtime"]),
  "branch.progress": Object.freeze(["runtime", "provider"]),
  "branch.result.submitted": Object.freeze(["runtime", "provider"]),
  "branch.failed": Object.freeze(["runtime", "provider"]),
  "branch.timed_out": Object.freeze(["runtime"]),
  "branch.delivery_unknown": Object.freeze(["runtime"]),
  "branch.cancelled": Object.freeze(["runtime", "provider"]),
  "user_input.requested": Object.freeze(["runtime", "provider"]),
  "verification.recorded": Object.freeze(["verifier"]),
  "review.recorded": Object.freeze(["verifier"]),
  "provider.rate_limited": Object.freeze(["runtime", "provider"]),
  "provider.unavailable": Object.freeze(["runtime", "provider"]),
});

const EFFECT_SETTLEMENT_OBSERVATION_ACTORS_BY_NAME = Object.freeze({
  // Lease and probe provenance are runtime capabilities. A provider identity
  // may supply evidence to the runtime, but cannot directly assert either.
  "provider.effect.settlement.recorded": Object.freeze(["runtime"]),
});
const EFFECT_SEND_EXPIRY_OBSERVATION_ACTORS_BY_NAME = Object.freeze({
  "provider.effect.send_expiration.recorded": Object.freeze(["runtime"]),
});
const EFFECT_PRESEND_FAILURE_OBSERVATION_ACTORS_BY_NAME = Object.freeze({
  // The authenticated boundary additionally requires a system principal. The
  // envelope retains the existing runtime provenance class so V2 observations
  // do not widen the public actor vocabulary.
  "provider.effect.presend_failure.recorded": Object.freeze(["runtime"]),
});

class ContractValidationError extends TypeError {
  constructor(path, reason, message) {
    super(`${path}: ${message}`);
    this.name = "ContractValidationError";
    this.code = "ERR_ORQUESTA_CONTRACT_VALIDATION";
    this.path = path;
    this.reason = reason;
  }
}

function invalid(path, reason, message) {
  throw new ContractValidationError(path, reason, message);
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function utf8Bytes(value) {
  return Buffer.byteLength(value, "utf8");
}

function preflightJson(value, path, maximumBytes) {
  const stack = [{ value, path, depth: 0 }];
  const seen = new WeakSet();
  let nodes = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    nodes += 1;
    if (nodes > CONTRACT_LIMITS.max_input_nodes) {
      invalid(path, "node_limit", `must contain at most ${CONTRACT_LIMITS.max_input_nodes} values`);
    }
    if (current.depth > CONTRACT_LIMITS.max_input_depth) {
      invalid(current.path, "depth_limit", `must not exceed depth ${CONTRACT_LIMITS.max_input_depth}`);
    }

    const entry = current.value;
    if (entry === null || typeof entry === "boolean") continue;
    if (typeof entry === "string") {
      if (utf8Bytes(entry) > CONTRACT_LIMITS.max_text_bytes * 2) {
        invalid(current.path, "string_limit", "contains an excessively large string");
      }
      continue;
    }
    if (typeof entry === "number") {
      if (!Number.isFinite(entry)) invalid(current.path, "type", "must be a finite JSON number");
      continue;
    }
    if (!entry || typeof entry !== "object") {
      invalid(current.path, "type", "must contain only JSON-compatible values");
    }
    if (seen.has(entry)) {
      invalid(current.path, "repeated_reference", "must not contain circular or repeated object references");
    }
    seen.add(entry);

    const prototype = Object.getPrototypeOf(entry);
    if (Array.isArray(entry)) {
      if (prototype !== Array.prototype) invalid(current.path, "type", "must be a plain array");
      const names = Object.getOwnPropertyNames(entry);
      if (entry.length > CONTRACT_LIMITS.max_input_nodes) {
        invalid(current.path, "node_limit", "contains too many array entries");
      }
      if (Object.getOwnPropertySymbols(entry).length > 0) {
        invalid(current.path, "symbol_field", "must not have symbol-keyed fields");
      }
      for (const name of names) {
        if (name === "length") continue;
        if (!/^(0|[1-9][0-9]*)$/u.test(name) || Number(name) >= entry.length) {
          invalid(current.path, "array_shape", "must not have non-index fields");
        }
      }
      for (let index = 0; index < entry.length; index += 1) {
        if (!Object.hasOwn(entry, index)) invalid(current.path, "array_shape", "must not be sparse");
        const descriptor = Object.getOwnPropertyDescriptor(entry, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) {
          invalid(`${current.path}[${index}]`, "accessor", "must not use accessors");
        }
        stack.push({
          value: descriptor.value,
          path: `${current.path}[${index}]`,
          depth: current.depth + 1,
        });
      }
      continue;
    }

    if (prototype !== Object.prototype && prototype !== null) {
      invalid(current.path, "type", "must be a plain object");
    }
    if (Object.getOwnPropertySymbols(entry).length > 0) {
      invalid(current.path, "symbol_field", "must not have symbol-keyed fields");
    }
    const names = Object.getOwnPropertyNames(entry);
    if (names.length > CONTRACT_LIMITS.max_input_nodes) {
      invalid(current.path, "node_limit", "contains too many object fields");
    }
    for (const key of names) {
      const descriptor = Object.getOwnPropertyDescriptor(entry, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value")) {
        invalid(`${current.path}.${key}`, "accessor", "must not use accessors");
      }
      if (!descriptor.enumerable) {
        invalid(`${current.path}.${key}`, "field_visibility", "must be enumerable");
      }
      stack.push({
        value: descriptor.value,
        path: `${current.path}.${key}`,
        depth: current.depth + 1,
      });
    }
  }

  let serialized;
  try {
    serialized = canonicalJson(value);
  } catch (error) {
    invalid(path, "serialization", error instanceof Error ? error.message : "cannot be serialized");
  }
  if (utf8Bytes(serialized) > maximumBytes) {
    invalid(path, "serialized_size", `must serialize to at most ${maximumBytes} bytes`);
  }
  return serialized;
}

function assertPlainObject(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid(path, "type", "must be an object");
  }
  return value;
}

function assertExactFields(value, allowed, required, path) {
  const object = assertPlainObject(value, path);
  for (const field of Object.keys(object)) {
    if (!allowed.has(field)) invalid(`${path}.${field}`, "unknown_field", "is not supported");
  }
  for (const field of required) {
    if (!Object.hasOwn(object, field)) invalid(`${path}.${field}`, "required", "is required");
  }
  return object;
}

function assertString(value, path, maximumBytes = CONTRACT_LIMITS.max_text_bytes) {
  if (typeof value !== "string" || value.trim() === "") {
    invalid(path, "type", "must be a non-empty string");
  }
  const normalized = value.trim();
  if (utf8Bytes(normalized) > maximumBytes) {
    invalid(path, "string_limit", `must be at most ${maximumBytes} UTF-8 bytes`);
  }
  return normalized;
}

function assertRef(value, path) {
  const normalized = assertString(value, path, CONTRACT_LIMITS.max_ref_bytes);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@+\-]*$/u.test(normalized)) {
    invalid(path, "format", "must be a portable reference");
  }
  return normalized;
}

function assertTimestamp(value, path) {
  const normalized = assertString(value, path, 64);
  const milliseconds = Date.parse(normalized);
  if (!Number.isFinite(milliseconds)
      || new Date(milliseconds).toISOString() !== normalized) {
    invalid(path, "timestamp", "must be a canonical millisecond UTC timestamp");
  }
  return normalized;
}

function normalizeContentRef(input, path) {
  const ref = assertExactFields(input, CONTENT_REF_FIELDS, CONTENT_REF_FIELDS, path);
  return {
    id: assertRef(ref.id, `${path}.id`),
    hash: assertPattern(
      ref.hash,
      `${path}.hash`,
      /^[a-f0-9]{64}$/u,
      "a lowercase SHA-256 hash",
    ),
  };
}

function assertPattern(value, path, pattern, description) {
  if (typeof value !== "string" || !pattern.test(value)) {
    invalid(path, "format", `must be ${description}`);
  }
  return value;
}

function assertEnum(value, allowed, path) {
  if (!allowed.includes(value)) {
    invalid(path, "enum", `must be one of: ${allowed.join(", ")}`);
  }
  return value;
}

function assertInteger(value, path, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    invalid(path, "integer_range", `must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function assertBoolean(value, path) {
  if (typeof value !== "boolean") invalid(path, "type", "must be boolean");
  return value;
}

function assertArray(value, path, { minimum = 0, maximum }) {
  if (!Array.isArray(value)) invalid(path, "type", "must be an array");
  if (value.length < minimum || value.length > maximum) {
    invalid(path, "array_limit", `must contain from ${minimum} to ${maximum} items`);
  }
  return value;
}

function normalizeUniqueRefs(value, path, { minimum = 0, maximum }) {
  const input = assertArray(value, path, { minimum, maximum });
  const normalized = input.map((entry, index) => assertRef(entry, `${path}[${index}]`));
  if (new Set(normalized).size !== normalized.length) {
    invalid(path, "duplicate", "must contain unique references");
  }
  return normalized.sort(compareText);
}

function assertUniqueField(records, field, path) {
  const seen = new Set();
  for (const record of records) {
    if (seen.has(record[field])) invalid(`${path}.${field}`, "duplicate", "must be unique");
    seen.add(record[field]);
  }
}

function assertUniqueContentRefId(records, field, path) {
  const seen = new Set();
  for (const record of records) {
    const id = record[field].id;
    if (seen.has(id)) invalid(`${path}.${field}.id`, "duplicate", "must be unique");
    seen.add(id);
  }
}

function assertPlanContentRefIdsUnique(rootRefs, branches, acceptancePolicy) {
  const refs = [
    ...rootRefs,
    ...branches.flatMap((branch) => [
      branch.task_intent_ref,
      branch.execution_plan_ref,
      branch.context_pack_ref,
    ]),
    ...acceptancePolicy.criteria.flatMap((criterion) => (
      criterion.verification_requirements.map((requirement) => requirement.verification_ref)
    )),
  ];
  const seen = new Set();
  for (const ref of refs) {
    if (seen.has(ref.id)) {
      invalid(
        "plan.content_refs",
        "content_ref_id_conflict",
        `content reference id ${ref.id} must identify exactly one object within a plan`,
      );
    }
    seen.add(ref.id);
  }
}

function normalizeVerificationRequirements(input, path, verificationMode) {
  const requirements = assertArray(input, path, {
    minimum: 1,
    maximum: CONTRACT_LIMITS.max_verification_requirements_per_criterion,
  }).map((entry, index) => {
    const requirementPath = `${path}[${index}]`;
    const requirement = assertExactFields(
      entry,
      VERIFICATION_REQUIREMENT_FIELDS,
      VERIFICATION_REQUIREMENT_FIELDS,
      requirementPath,
    );
    return {
      kind: assertEnum(
        requirement.kind,
        VERIFICATION_REQUIREMENT_KINDS,
        `${requirementPath}.kind`,
      ),
      verification_ref: normalizeContentRef(
        requirement.verification_ref,
        `${requirementPath}.verification_ref`,
      ),
    };
  });

  const requirementIds = new Set();
  for (const requirement of requirements) {
    if (requirementIds.has(requirement.verification_ref.id)) {
      invalid(path, "duplicate", "must contain unique verification reference IDs");
    }
    requirementIds.add(requirement.verification_ref.id);
  }

  const deterministicCount = requirements.filter(
    (requirement) => requirement.kind === "deterministic",
  ).length;
  const humanCount = requirements.length - deterministicCount;
  const modeValid = (verificationMode === "deterministic"
      && deterministicCount >= 1
      && humanCount === 0)
    || (verificationMode === "human_only"
      && humanCount >= 1
      && deterministicCount === 0)
    || (verificationMode === "mixed"
      && deterministicCount >= 1
      && humanCount >= 1);
  if (!modeValid) {
    invalid(
      path,
      "verification_mode_mismatch",
      `must exactly satisfy the ${verificationMode} verification mode`,
    );
  }

  return requirements.sort((left, right) => (
    compareText(left.verification_ref.id, right.verification_ref.id)
      || compareText(left.kind, right.kind)
  ));
}

function normalizeAcceptancePolicy(input) {
  const policy = assertExactFields(
    input,
    ACCEPTANCE_POLICY_FIELDS,
    ACCEPTANCE_POLICY_FIELDS,
    "plan.acceptance_policy",
  );
  const criteria = assertArray(policy.criteria, "plan.acceptance_policy.criteria", {
    minimum: 1,
    maximum: CONTRACT_LIMITS.max_acceptance_criteria,
  }).map((entry, index) => {
    const path = `plan.acceptance_policy.criteria[${index}]`;
    const criterion = assertExactFields(
      entry,
      ACCEPTANCE_CRITERION_FIELDS,
      ACCEPTANCE_CRITERION_FIELDS,
      path,
    );
    const verification = assertEnum(
      criterion.verification,
      ACCEPTANCE_VERIFICATION_MODES,
      `${path}.verification`,
    );
    return {
      criterion_id: assertRef(criterion.criterion_id, `${path}.criterion_id`),
      description: assertString(criterion.description, `${path}.description`, 8_192),
      verification,
      verification_requirements: normalizeVerificationRequirements(
        criterion.verification_requirements,
        `${path}.verification_requirements`,
        verification,
      ),
    };
  });
  assertUniqueField(criteria, "criterion_id", "plan.acceptance_policy.criteria");
  return {
    criteria: criteria.sort((left, right) => compareText(left.criterion_id, right.criterion_id)),
    review_minimum: assertEnum(
      policy.review_minimum,
      REVIEW_MINIMUMS,
      "plan.acceptance_policy.review_minimum",
    ),
  };
}

function normalizeRetryPolicy(input) {
  const policy = assertExactFields(
    input,
    RETRY_POLICY_FIELDS,
    RETRY_POLICY_FIELDS,
    "plan.retry_policy",
  );
  const retryable = assertArray(
    policy.retryable_observations,
    "plan.retry_policy.retryable_observations",
    { minimum: 0, maximum: RETRYABLE_RUNTIME_OBSERVATIONS.length },
  ).map((name, index) => {
    if (name === "branch.delivery_unknown") {
      invalid(
        `plan.retry_policy.retryable_observations[${index}]`,
        "delivery_ambiguity",
        "delivery_unknown requires reconciliation and must never be automatically retryable",
      );
    }
    return assertEnum(
      name,
      RETRYABLE_RUNTIME_OBSERVATIONS,
      `plan.retry_policy.retryable_observations[${index}]`,
    );
  });
  if (new Set(retryable).size !== retryable.length) {
    invalid("plan.retry_policy.retryable_observations", "duplicate", "must be unique");
  }

  const normalized = {
    max_attempts: assertInteger(policy.max_attempts, "plan.retry_policy.max_attempts", {
      minimum: 1,
      maximum: 5,
    }),
    attempt_timeout_ms: assertInteger(
      policy.attempt_timeout_ms,
      "plan.retry_policy.attempt_timeout_ms",
      { minimum: 1_000, maximum: 86_400_000 },
    ),
    max_elapsed_ms: assertInteger(policy.max_elapsed_ms, "plan.retry_policy.max_elapsed_ms", {
      minimum: 1_000,
      maximum: 604_800_000,
    }),
    backoff_initial_ms: assertInteger(
      policy.backoff_initial_ms,
      "plan.retry_policy.backoff_initial_ms",
      { minimum: 0, maximum: 3_600_000 },
    ),
    backoff_max_ms: assertInteger(
      policy.backoff_max_ms,
      "plan.retry_policy.backoff_max_ms",
      { minimum: 0, maximum: 86_400_000 },
    ),
    retryable_observations: retryable.sort(compareText),
  };
  if (normalized.attempt_timeout_ms > normalized.max_elapsed_ms) {
    invalid(
      "plan.retry_policy.attempt_timeout_ms",
      "inconsistent_limit",
      "must not exceed max_elapsed_ms",
    );
  }
  if (normalized.backoff_initial_ms > normalized.backoff_max_ms) {
    invalid(
      "plan.retry_policy.backoff_initial_ms",
      "inconsistent_limit",
      "must not exceed backoff_max_ms",
    );
  }
  return normalized;
}

function normalizeLeasePolicy(input) {
  const policy = assertExactFields(
    input,
    LEASE_POLICY_FIELDS,
    LEASE_POLICY_FIELDS,
    "plan.lease_policy",
  );
  const normalized = {
    lease_duration_ms: assertInteger(
      policy.lease_duration_ms,
      "plan.lease_policy.lease_duration_ms",
      { minimum: 5_000, maximum: 3_600_000 },
    ),
    heartbeat_interval_ms: assertInteger(
      policy.heartbeat_interval_ms,
      "plan.lease_policy.heartbeat_interval_ms",
      { minimum: 1_000, maximum: 600_000 },
    ),
    max_recovery_probes: assertInteger(
      policy.max_recovery_probes,
      "plan.lease_policy.max_recovery_probes",
      { minimum: 1, maximum: 20 },
    ),
  };
  if (normalized.heartbeat_interval_ms >= normalized.lease_duration_ms) {
    invalid(
      "plan.lease_policy.heartbeat_interval_ms",
      "inconsistent_limit",
      "must be less than lease_duration_ms",
    );
  }
  return normalized;
}

function normalizeProviderPolicy(input) {
  const policy = assertExactFields(
    input,
    PROVIDER_POLICY_FIELDS,
    PROVIDER_POLICY_FIELDS,
    "plan.provider_policy",
  );
  const allowedProviderRefs = normalizeUniqueRefs(
    policy.allowed_provider_refs,
    "plan.provider_policy.allowed_provider_refs",
    { minimum: 1, maximum: CONTRACT_LIMITS.max_provider_refs },
  );
  const selection = assertEnum(
    policy.selection,
    PROVIDER_SELECTION_MODES,
    "plan.provider_policy.selection",
  );
  if (selection === "fixed" && allowedProviderRefs.length !== 1) {
    invalid(
      "plan.provider_policy.allowed_provider_refs",
      "provider_count",
      "fixed selection requires exactly one provider reference",
    );
  }
  if (selection === "fallback_allowed" && allowedProviderRefs.length < 2) {
    invalid(
      "plan.provider_policy.allowed_provider_refs",
      "provider_count",
      "fallback_allowed selection requires at least two provider references",
    );
  }
  return { allowed_provider_refs: allowedProviderRefs, selection };
}

function normalizeBranch(input, index) {
  const path = `plan.branches[${index}]`;
  const branch = assertExactFields(input, BRANCH_FIELDS, BRANCH_FIELDS, path);
  const normalized = {
    branch_ref: assertRef(branch.branch_ref, `${path}.branch_ref`),
    task_intent_ref: normalizeContentRef(branch.task_intent_ref, `${path}.task_intent_ref`),
    execution_plan_ref: normalizeContentRef(
      branch.execution_plan_ref,
      `${path}.execution_plan_ref`,
    ),
    context_pack_ref: normalizeContentRef(branch.context_pack_ref, `${path}.context_pack_ref`),
    dependencies: normalizeUniqueRefs(branch.dependencies, `${path}.dependencies`, {
      minimum: 0,
      maximum: CONTRACT_LIMITS.max_dependencies_per_branch,
    }),
    role: assertEnum(branch.role, BRANCH_ROLES, `${path}.role`),
    parallelizable: assertBoolean(branch.parallelizable, `${path}.parallelizable`),
    isolation: assertEnum(branch.isolation, BRANCH_ISOLATION_MODES, `${path}.isolation`),
    assignee_ref: assertRef(branch.assignee_ref, `${path}.assignee_ref`),
    provider_ref: assertRef(branch.provider_ref, `${path}.provider_ref`),
    permission_mode: assertEnum(branch.permission_mode, PERMISSION_MODES, `${path}.permission_mode`),
  };
  if (normalized.dependencies.includes(normalized.branch_ref)) {
    invalid(`${path}.dependencies`, "self_dependency", "must not contain its own branch_ref");
  }
  if (normalized.role === "integration" && normalized.parallelizable) {
    invalid(`${path}.parallelizable`, "integration_parallel", "must be false for integration");
  }
  if (normalized.isolation === "read-only" && normalized.permission_mode !== "read-only") {
    invalid(
      `${path}.permission_mode`,
      "isolation_permission",
      "must be read-only when isolation is read-only",
    );
  }
  if (normalized.parallelizable
      && normalized.permission_mode === "workspace-write"
      && !["worktree", "sandbox", "remote"].includes(normalized.isolation)) {
    invalid(
      `${path}.isolation`,
      "parallel_isolation",
      "must isolate parallel writes with worktree, sandbox, or remote",
    );
  }
  return normalized;
}

function assertAcyclic(branches) {
  const byRef = new Map(branches.map((branch) => [branch.branch_ref, branch]));
  for (const branch of branches) {
    for (const dependency of branch.dependencies) {
      if (!byRef.has(dependency)) {
        invalid(
          `plan.branches.${branch.branch_ref}.dependencies`,
          "unknown_dependency",
          `references unknown branch ${dependency}`,
        );
      }
    }
  }

  const visiting = new Set();
  const visited = new Set();
  function visit(branchRef) {
    if (visiting.has(branchRef)) {
      invalid("plan.branches", "dependency_cycle", "must form an acyclic dependency graph");
    }
    if (visited.has(branchRef)) return;
    visiting.add(branchRef);
    for (const dependency of byRef.get(branchRef).dependencies) visit(dependency);
    visiting.delete(branchRef);
    visited.add(branchRef);
  }
  for (const branchRef of byRef.keys()) visit(branchRef);
  return byRef;
}

function validateIntegration(branches, integrationBranchRef) {
  const integrationBranches = branches.filter((branch) => branch.role === "integration");
  if (integrationBranchRef === null) {
    if (integrationBranches.length !== 0) {
      invalid(
        "plan.integration_branch_ref",
        "integration_mismatch",
        "must identify the declared integration branch",
      );
    }
    return;
  }
  if (integrationBranches.length !== 1
      || integrationBranches[0].branch_ref !== integrationBranchRef) {
    invalid(
      "plan.integration_branch_ref",
      "integration_mismatch",
      "must identify the single declared integration branch",
    );
  }

  const byRef = new Map(branches.map((branch) => [branch.branch_ref, branch]));
  for (const branch of branches) {
    if (branch.branch_ref !== integrationBranchRef
        && branch.dependencies.includes(integrationBranchRef)) {
      invalid(
        `plan.branches.${branch.branch_ref}.dependencies`,
        "integration_terminal",
        "must not depend on the terminal integration branch",
      );
    }
  }

  const reachable = new Set();
  const stack = [...byRef.get(integrationBranchRef).dependencies];
  while (stack.length > 0) {
    const dependency = stack.pop();
    if (reachable.has(dependency)) continue;
    reachable.add(dependency);
    stack.push(...byRef.get(dependency).dependencies);
  }
  const missing = branches
    .filter((branch) => branch.role === "work" && !reachable.has(branch.branch_ref))
    .map((branch) => branch.branch_ref)
    .sort(compareText);
  if (missing.length > 0) {
    invalid(
      "plan.integration_branch_ref",
      "integration_coverage",
      `integration must transitively collect every work branch: ${missing.join(", ")}`,
    );
  }
}

function normalizeBusinessWorkOrderPlanV1(input) {
  preflightJson(input, "plan", CONTRACT_LIMITS.max_plan_bytes);
  const plan = assertExactFields(input, PLAN_FIELDS, PLAN_REQUIRED_FIELDS, "plan");
  if (plan.version !== BUSINESS_WORK_ORDER_PLAN_VERSION) {
    invalid("plan.version", "version", `must be ${BUSINESS_WORK_ORDER_PLAN_VERSION}`);
  }

  const projectRef = assertRef(plan.project_ref, "plan.project_ref");
  const revision = assertInteger(plan.revision, "plan.revision", { minimum: 1, maximum: 1_000_000 });
  let supersedesPlanRef = null;
  if (plan.supersedes_plan_ref !== null) {
    supersedesPlanRef = assertPattern(
      plan.supersedes_plan_ref,
      "plan.supersedes_plan_ref",
      /^BPS-[a-f0-9]{32}$/u,
      "a BPS- reference with 32 lowercase hexadecimal characters",
    );
  }
  if (revision === 1 && supersedesPlanRef !== null) {
    invalid("plan.supersedes_plan_ref", "revision_chain", "must be null for revision 1");
  }
  if (revision > 1 && supersedesPlanRef === null) {
    invalid("plan.supersedes_plan_ref", "revision_chain", "is required after revision 1");
  }

  const providerPolicy = normalizeProviderPolicy(plan.provider_policy);
  const permissionMode = assertEnum(plan.permission_mode, PERMISSION_MODES, "plan.permission_mode");
  const acceptancePolicy = normalizeAcceptancePolicy(plan.acceptance_policy);
  const taskIntentRef = normalizeContentRef(plan.task_intent_ref, "plan.task_intent_ref");
  const executionPlanRef = normalizeContentRef(
    plan.execution_plan_ref,
    "plan.execution_plan_ref",
  );
  const contextPackRef = normalizeContentRef(plan.context_pack_ref, "plan.context_pack_ref");
  const branches = assertArray(plan.branches, "plan.branches", {
    minimum: 1,
    maximum: CONTRACT_LIMITS.max_branches,
  }).map(normalizeBranch);
  assertUniqueField(branches, "branch_ref", "plan.branches");
  for (const field of ["task_intent_ref", "execution_plan_ref", "context_pack_ref"]) {
    assertUniqueContentRefId(branches, field, "plan.branches");
  }
  assertPlanContentRefIdsUnique(
    [taskIntentRef, executionPlanRef, contextPackRef],
    branches,
    acceptancePolicy,
  );
  assertAcyclic(branches);

  let integrationBranchRef = null;
  if (plan.integration_branch_ref !== null) {
    integrationBranchRef = assertRef(
      plan.integration_branch_ref,
      "plan.integration_branch_ref",
    );
  }
  validateIntegration(branches, integrationBranchRef);

  const allowedProviders = new Set(providerPolicy.allowed_provider_refs);
  const permissionRank = { "read-only": 0, "workspace-write": 1 };
  for (const branch of branches) {
    if (!allowedProviders.has(branch.provider_ref)) {
      invalid(
        `plan.branches.${branch.branch_ref}.provider_ref`,
        "provider_policy",
        "is outside provider_policy",
      );
    }
    if (permissionRank[branch.permission_mode] > permissionRank[permissionMode]) {
      invalid(
        `plan.branches.${branch.branch_ref}.permission_mode`,
        "permission_ceiling",
        "exceeds the plan permission_mode",
      );
    }
  }

  const workBranchCount = branches.filter((branch) => branch.role === "work").length;
  if (workBranchCount === 0) {
    invalid("plan.branches", "work_branch_missing", "must contain at least one work branch");
  }
  if (workBranchCount > 1 && integrationBranchRef === null) {
    invalid(
      "plan.integration_branch_ref",
      "integration_required",
      "is required when more than one work branch contributes to the outcome",
    );
  }
  const maxConcurrency = assertInteger(plan.max_concurrency, "plan.max_concurrency", {
    minimum: 1,
    maximum: CONTRACT_LIMITS.max_branches,
  });
  if (maxConcurrency > workBranchCount) {
    invalid(
      "plan.max_concurrency",
      "concurrency_limit",
      "must not exceed the number of work branches",
    );
  }

  const content = {
    version: BUSINESS_WORK_ORDER_PLAN_VERSION,
    project_ref: projectRef,
    revision,
    supersedes_plan_ref: supersedesPlanRef,
    title: assertString(plan.title, "plan.title", 1_024),
    desired_outcome: assertString(plan.desired_outcome, "plan.desired_outcome", 8_192),
    acceptance_policy: acceptancePolicy,
    task_intent_ref: taskIntentRef,
    execution_plan_ref: executionPlanRef,
    context_pack_ref: contextPackRef,
    branches: branches.sort((left, right) => compareText(left.branch_ref, right.branch_ref)),
    integration_branch_ref: integrationBranchRef,
    max_concurrency: maxConcurrency,
    context_duplication_budget_tokens: assertInteger(
      plan.context_duplication_budget_tokens,
      "plan.context_duplication_budget_tokens",
      { minimum: 0, maximum: 100_000_000 },
    ),
    retry_policy: normalizeRetryPolicy(plan.retry_policy),
    lease_policy: normalizeLeasePolicy(plan.lease_policy),
    provider_policy: providerPolicy,
    permission_mode: permissionMode,
  };
  const planHash = canonicalHash(content);
  const planSnapshotId = `BPS-${planHash.slice(0, 32)}`;
  if (plan.plan_hash !== undefined) {
    const suppliedHash = assertPattern(
      plan.plan_hash,
      "plan.plan_hash",
      /^[a-f0-9]{64}$/u,
      "a lowercase SHA-256 hash",
    );
    if (suppliedHash !== planHash) {
      invalid("plan.plan_hash", "hash_mismatch", "does not match canonical plan content");
    }
  }
  if (plan.plan_snapshot_id !== undefined) {
    const suppliedId = assertPattern(
      plan.plan_snapshot_id,
      "plan.plan_snapshot_id",
      /^BPS-[a-f0-9]{32}$/u,
      "a BPS- reference with 32 lowercase hexadecimal characters",
    );
    if (suppliedId !== planSnapshotId) {
      invalid("plan.plan_snapshot_id", "hash_mismatch", "does not match canonical plan content");
    }
  }
  return deepFreeze({
    version: BUSINESS_WORK_ORDER_PLAN_VERSION,
    plan_snapshot_id: planSnapshotId,
    plan_hash: planHash,
    ...content,
  });
}

function normalizeActor(input, path, allowedTypes) {
  const actor = assertExactFields(input, ACTOR_FIELDS, ACTOR_FIELDS, path);
  return {
    // This is an asserted caller identity, not an authorization decision.
    // The command processor must authorize it against trusted policy/state.
    type: assertEnum(actor.type, allowedTypes, `${path}.type`),
    actor_id: assertRef(actor.actor_id, `${path}.actor_id`),
  };
}

function assertActorProvenance(actor, name, matrix, path) {
  const allowed = matrix[name];
  if (!allowed || !allowed.includes(actor.type)) {
    invalid(
      `${path}.type`,
      "actor_name_mismatch",
      `cannot be used with ${name}; this validates provenance shape, not authorization`,
    );
  }
  return actor;
}

function normalizePayloadRefs(input, path, { minimum = 0 } = {}) {
  return normalizeUniqueRefs(input, path, {
    minimum,
    maximum: CONTRACT_LIMITS.max_evidence_refs,
  });
}

function normalizePayloadContentRefs(input, path, { minimum = 0 } = {}) {
  const refs = assertArray(input, path, {
    minimum,
    maximum: CONTRACT_LIMITS.max_evidence_refs,
  }).map((entry, index) => normalizeContentRef(entry, `${path}[${index}]`));
  const seen = new Set();
  for (const ref of refs) {
    if (seen.has(ref.id)) invalid(path, "duplicate", "must contain unique artifact IDs");
    seen.add(ref.id);
  }
  return refs.sort((left, right) => compareText(left.id, right.id));
}

function normalizeCommandPayload(name, input) {
  const fields = COMMAND_PAYLOAD_FIELDS[name];
  const payload = assertExactFields(input, fields, fields, "command.payload");
  switch (name) {
    case "work_order.start":
      return {};
    case "work_order.cancel.request":
    case "work_order.resume":
      return { reason: assertString(payload.reason, "command.payload.reason", 4_096) };
    case "branch.retry.request":
      return {
        branch_ref: assertRef(payload.branch_ref, "command.payload.branch_ref"),
        failed_attempt: assertInteger(payload.failed_attempt, "command.payload.failed_attempt", {
          minimum: 1,
          maximum: 5,
        }),
        reason: assertString(payload.reason, "command.payload.reason", 4_096),
      };
    case "user_input.resolve":
      return {
        request_id: assertPattern(
          payload.request_id,
          "command.payload.request_id",
          /^REQ-[a-f0-9]{32}$/u,
          "a REQ- identifier with 32 lowercase hexadecimal characters",
        ),
        response_ref: normalizeContentRef(
          payload.response_ref,
          "command.payload.response_ref",
        ),
      };
    case "acceptance.decision.record":
      return {
        decision: assertEnum(
          payload.decision,
          ["accepted", "rejected"],
          "command.payload.decision",
        ),
        evidence_refs: normalizePayloadRefs(
          payload.evidence_refs,
          "command.payload.evidence_refs",
          { minimum: 1 },
        ),
        comment: assertString(payload.comment, "command.payload.comment", 8_192),
      };
    default:
      invalid("command.name", "enum", "has no payload schema");
  }
}

function normalizeObservationPayload(name, input) {
  const fields = OBSERVATION_PAYLOAD_FIELDS[name];
  const payload = assertExactFields(input, fields, fields, "observation.payload");
  const branchAttempt = () => ({
    branch_ref: assertRef(payload.branch_ref, "observation.payload.branch_ref"),
    attempt: assertInteger(payload.attempt, "observation.payload.attempt", {
      minimum: 1,
      maximum: 5,
    }),
  });
  switch (name) {
    case "work_order.started":
      return {};
    case "work_order.cancelled":
      return { reason: assertString(payload.reason, "observation.payload.reason", 4_096) };
    case "provider.effect.delivery.recorded":
      return {
        effect_id: assertPattern(
          payload.effect_id,
          "observation.payload.effect_id",
          /^FX-[a-f0-9]{32}$/u,
          "an FX- identifier with 32 lowercase hexadecimal characters",
        ),
        effect_contract_version: assertInteger(
          payload.effect_contract_version,
          "observation.payload.effect_contract_version",
          { minimum: 2, maximum: 2 },
        ),
        effect_kind: assertEnum(
          payload.effect_kind,
          [
            "provider.thread.create",
            "provider.turn.start",
            "provider.user_input.submit",
            "provider.turn.cancel",
          ],
          "observation.payload.effect_kind",
        ),
        ...branchAttempt(),
        dispatch_id: assertPattern(
          payload.dispatch_id,
          "observation.payload.dispatch_id",
          /^DSP-[a-f0-9]{32}$/u,
          "a DSP- identifier with 32 lowercase hexadecimal characters",
        ),
        classification: assertEnum(
          payload.classification,
          ["accepted", "not_sent", "delivery_unknown"],
          "observation.payload.classification",
        ),
      };
    case "branch.dispatch.accepted":
      return {
        ...branchAttempt(),
        dispatch_id: assertPattern(
          payload.dispatch_id,
          "observation.payload.dispatch_id",
          /^DSP-[a-f0-9]{32}$/u,
          "a DSP- identifier with 32 lowercase hexadecimal characters",
        ),
      };
    case "branch.dispatch.not_sent":
      return {
        ...branchAttempt(),
        dispatch_id: assertPattern(
          payload.dispatch_id,
          "observation.payload.dispatch_id",
          /^DSP-[a-f0-9]{32}$/u,
          "a DSP- identifier with 32 lowercase hexadecimal characters",
        ),
        reason: assertString(payload.reason, "observation.payload.reason", 4_096),
      };
    case "branch.progress":
      return {
        ...branchAttempt(),
        message: assertString(payload.message, "observation.payload.message", 8_192),
      };
    case "branch.result.submitted":
      return {
        ...branchAttempt(),
        artifact_refs: normalizePayloadContentRefs(
          payload.artifact_refs,
          "observation.payload.artifact_refs",
          { minimum: 1 },
        ),
        evidence_refs: normalizePayloadRefs(
          payload.evidence_refs,
          "observation.payload.evidence_refs",
          { minimum: 1 },
        ),
      };
    case "branch.failed":
      return {
        ...branchAttempt(),
        failure_code: assertRef(payload.failure_code, "observation.payload.failure_code"),
      };
    case "branch.timed_out":
      return {
        ...branchAttempt(),
        timeout_ms: assertInteger(payload.timeout_ms, "observation.payload.timeout_ms", {
          minimum: 1_000,
          maximum: 86_400_000,
        }),
      };
    case "branch.delivery_unknown":
      return {
        ...branchAttempt(),
        dispatch_id: assertPattern(
          payload.dispatch_id,
          "observation.payload.dispatch_id",
          /^DSP-[a-f0-9]{32}$/u,
          "a DSP- identifier with 32 lowercase hexadecimal characters",
        ),
        detail: assertString(payload.detail, "observation.payload.detail", 8_192),
      };
    case "branch.cancelled":
      return {
        ...branchAttempt(),
        reason: assertString(payload.reason, "observation.payload.reason", 4_096),
      };
    case "user_input.requested":
      return {
        branch_ref: assertRef(payload.branch_ref, "observation.payload.branch_ref"),
        request_id: assertPattern(
          payload.request_id,
          "observation.payload.request_id",
          /^REQ-[a-f0-9]{32}$/u,
          "a REQ- identifier with 32 lowercase hexadecimal characters",
        ),
        prompt_ref: normalizeContentRef(
          payload.prompt_ref,
          "observation.payload.prompt_ref",
        ),
      };
    case "verification.recorded":
      return {
        branch_ref: assertRef(payload.branch_ref, "observation.payload.branch_ref"),
        criterion_id: assertRef(payload.criterion_id, "observation.payload.criterion_id"),
        verification_ref: normalizeContentRef(
          payload.verification_ref,
          "observation.payload.verification_ref",
        ),
        kind: assertEnum(
          payload.kind,
          VERIFICATION_REQUIREMENT_KINDS,
          "observation.payload.kind",
        ),
        status: assertEnum(
          payload.status,
          ["passed", "failed"],
          "observation.payload.status",
        ),
        evidence_refs: normalizePayloadRefs(
          payload.evidence_refs,
          "observation.payload.evidence_refs",
          { minimum: 1 },
        ),
      };
    case "review.recorded": {
      const findings = assertExactFields(
        payload.findings,
        REVIEW_FINDINGS_FIELDS,
        REVIEW_FINDINGS_FIELDS,
        "observation.payload.findings",
      );
      return {
        branch_ref: assertRef(payload.branch_ref, "observation.payload.branch_ref"),
        review_id: assertRef(payload.review_id, "observation.payload.review_id"),
        status: assertEnum(
          payload.status,
          ["accepted", "rejected"],
          "observation.payload.status",
        ),
        findings: {
          critical: assertInteger(
            findings.critical,
            "observation.payload.findings.critical",
            { minimum: 0, maximum: CONTRACT_LIMITS.max_review_findings_per_severity },
          ),
          important: assertInteger(
            findings.important,
            "observation.payload.findings.important",
            { minimum: 0, maximum: CONTRACT_LIMITS.max_review_findings_per_severity },
          ),
          minor: assertInteger(
            findings.minor,
            "observation.payload.findings.minor",
            { minimum: 0, maximum: CONTRACT_LIMITS.max_review_findings_per_severity },
          ),
        },
        evidence_refs: normalizePayloadRefs(
          payload.evidence_refs,
          "observation.payload.evidence_refs",
          { minimum: 1 },
        ),
      };
    }
    case "provider.rate_limited":
      return {
        ...branchAttempt(),
        retry_after_ms: assertInteger(
          payload.retry_after_ms,
          "observation.payload.retry_after_ms",
          { minimum: 0, maximum: 86_400_000 },
        ),
      };
    case "provider.unavailable":
      return {
        ...branchAttempt(),
        detail: assertString(payload.detail, "observation.payload.detail", 8_192),
      };
    default:
      invalid("observation.name", "enum", "has no payload schema");
  }
}

function normalizeWorkerFencingToken(input, path) {
  const token = assertExactFields(
    input,
    WORKER_FENCING_TOKEN_FIELDS,
    WORKER_FENCING_TOKEN_FIELDS,
    path,
  );
  return {
    lease_id: assertRef(token.lease_id, `${path}.lease_id`),
    owner_id: assertRef(token.owner_id, `${path}.owner_id`),
    generation: assertInteger(token.generation, `${path}.generation`, {
      minimum: 1,
      maximum: 1_000_000_000,
    }),
  };
}

function normalizeDerivedContentRef(input, path, prefix) {
  const ref = normalizeContentRef(input, path);
  const pattern = new RegExp(`^${prefix}-[a-f0-9]{32}$`, "u");
  if (!pattern.test(ref.id) || ref.id !== `${prefix}-${ref.hash.slice(0, 32)}`) {
    invalid(
      `${path}.id`,
      "hash_mismatch",
      `must be the ${prefix}- identifier derived from ${path}.hash`,
    );
  }
  return ref;
}

function normalizeRecoveryProbe(input, path) {
  const probe = assertExactFields(
    input,
    RECOVERY_PROBE_FIELDS,
    RECOVERY_PROBE_FIELDS,
    path,
  );
  const probeReceiptRef = normalizeDerivedContentRef(
    probe.probe_receipt_ref,
    `${path}.probe_receipt_ref`,
    "PRB",
  );
  return {
    probe_receipt_ref: probeReceiptRef,
    mutation_idempotency_key: assertPattern(
      probe.mutation_idempotency_key,
      `${path}.mutation_idempotency_key`,
      /^IDEM-[a-f0-9]{32}$/u,
      "an IDEM- identifier with 32 lowercase hexadecimal characters",
    ),
  };
}

function normalizeEffectBindingPayloadV2(payload) {
  return {
    effect_id: assertPattern(
      payload.effect_id,
      "observation.payload.effect_id",
      /^FX-[a-f0-9]{32}$/u,
      "an FX- identifier with 32 lowercase hexadecimal characters",
    ),
    effect_contract_version: assertInteger(
      payload.effect_contract_version,
      "observation.payload.effect_contract_version",
      { minimum: 2, maximum: 2 },
    ),
    effect_kind: assertEnum(
      payload.effect_kind,
      [
        "provider.thread.create",
        "provider.turn.start",
        "provider.user_input.submit",
        "provider.turn.cancel",
      ],
      "observation.payload.effect_kind",
    ),
    branch_ref: assertRef(payload.branch_ref, "observation.payload.branch_ref"),
    attempt: assertInteger(payload.attempt, "observation.payload.attempt", {
      minimum: 1,
      maximum: 5,
    }),
    dispatch_id: assertPattern(
      payload.dispatch_id,
      "observation.payload.dispatch_id",
      /^DSP-[a-f0-9]{32}$/u,
      "a DSP- identifier with 32 lowercase hexadecimal characters",
    ),
  };
}

function normalizeEffectSettlementPayloadV2(input) {
  const candidate = assertPlainObject(input, "observation.payload");
  const settlementSource = assertEnum(
    candidate.settlement_source,
    EFFECT_SETTLEMENT_SOURCES,
    "observation.payload.settlement_source",
  );
  const fields = settlementSource === "worker_result"
    ? WORKER_SETTLEMENT_PAYLOAD_FIELDS
    : RECOVERY_PROBE_SETTLEMENT_PAYLOAD_FIELDS;
  const payload = assertExactFields(candidate, fields, fields, "observation.payload");
  const normalized = {
    effect_id: assertPattern(
      payload.effect_id,
      "observation.payload.effect_id",
      /^FX-[a-f0-9]{32}$/u,
      "an FX- identifier with 32 lowercase hexadecimal characters",
    ),
    effect_contract_version: assertInteger(
      payload.effect_contract_version,
      "observation.payload.effect_contract_version",
      { minimum: 2, maximum: 2 },
    ),
    effect_kind: assertEnum(
      payload.effect_kind,
      [
        "provider.thread.create",
        "provider.turn.start",
        "provider.user_input.submit",
        "provider.turn.cancel",
      ],
      "observation.payload.effect_kind",
    ),
    branch_ref: assertRef(payload.branch_ref, "observation.payload.branch_ref"),
    attempt: assertInteger(payload.attempt, "observation.payload.attempt", {
      minimum: 1,
      maximum: 5,
    }),
    dispatch_id: assertPattern(
      payload.dispatch_id,
      "observation.payload.dispatch_id",
      /^DSP-[a-f0-9]{32}$/u,
      "a DSP- identifier with 32 lowercase hexadecimal characters",
    ),
    classification: assertEnum(
      payload.classification,
      ["accepted", "not_sent", "delivery_unknown"],
      "observation.payload.classification",
    ),
    settlement_source: settlementSource,
  };
  if (settlementSource === "worker_result") {
    return {
      ...normalized,
      worker_fencing_token: normalizeWorkerFencingToken(
        payload.worker_fencing_token,
        "observation.payload.worker_fencing_token",
      ),
      worker_result_ref: normalizeDerivedContentRef(
        payload.worker_result_ref,
        "observation.payload.worker_result_ref",
        "WRR",
      ),
    };
  }
  return {
    ...normalized,
    recovery_probe: normalizeRecoveryProbe(
      payload.recovery_probe,
      "observation.payload.recovery_probe",
    ),
  };
}

function normalizeEffectSendExpiryPayloadV2(input) {
  const payload = assertExactFields(
    input,
    EFFECT_SEND_EXPIRY_PAYLOAD_FIELDS,
    EFFECT_SEND_EXPIRY_PAYLOAD_FIELDS,
    "observation.payload",
  );
  return {
    effect_id: assertPattern(
      payload.effect_id,
      "observation.payload.effect_id",
      /^FX-[a-f0-9]{32}$/u,
      "an FX- identifier with 32 lowercase hexadecimal characters",
    ),
    effect_contract_version: assertInteger(
      payload.effect_contract_version,
      "observation.payload.effect_contract_version",
      { minimum: 2, maximum: 2 },
    ),
    effect_kind: assertEnum(
      payload.effect_kind,
      [
        "provider.thread.create",
        "provider.turn.start",
        "provider.user_input.submit",
        "provider.turn.cancel",
      ],
      "observation.payload.effect_kind",
    ),
    branch_ref: assertRef(payload.branch_ref, "observation.payload.branch_ref"),
    attempt: assertInteger(payload.attempt, "observation.payload.attempt", {
      minimum: 1,
      maximum: 5,
    }),
    dispatch_id: assertPattern(
      payload.dispatch_id,
      "observation.payload.dispatch_id",
      /^DSP-[a-f0-9]{32}$/u,
      "a DSP- identifier with 32 lowercase hexadecimal characters",
    ),
    expired_fencing_token: normalizeWorkerFencingToken(
      payload.expired_fencing_token,
      "observation.payload.expired_fencing_token",
    ),
    lease_expires_at: assertTimestamp(
      payload.lease_expires_at,
      "observation.payload.lease_expires_at",
    ),
    expiry_receipt_ref: normalizeDerivedContentRef(
      payload.expiry_receipt_ref,
      "observation.payload.expiry_receipt_ref",
      "EXP",
    ),
  };
}

function normalizeEffectPresendFailurePayloadV2(input) {
  const payload = assertExactFields(
    input,
    EFFECT_PRESEND_FAILURE_PAYLOAD_FIELDS,
    EFFECT_PRESEND_FAILURE_PAYLOAD_FIELDS,
    "observation.payload",
  );
  return {
    ...normalizeEffectBindingPayloadV2(payload),
    claimed_fencing_token: normalizeWorkerFencingToken(
      payload.claimed_fencing_token,
      "observation.payload.claimed_fencing_token",
    ),
    failure_reason: assertEnum(
      payload.failure_reason,
      V2_PRESEND_FAILURE_REASONS,
      "observation.payload.failure_reason",
    ),
    failure_record_ref: normalizeDerivedContentRef(
      payload.failure_record_ref,
      "observation.payload.failure_record_ref",
      "PFR",
    ),
  };
}

function normalizeEnvelopeIdentity(envelope, path) {
  const workOrderId = assertPattern(
    envelope.work_order_id,
    `${path}.work_order_id`,
    /^WO-[a-f0-9]{32}$/u,
    "a WO- identifier with 32 lowercase hexadecimal characters",
  );
  const planSnapshotRef = assertPattern(
    envelope.plan_snapshot_ref,
    `${path}.plan_snapshot_ref`,
    /^BPS-[a-f0-9]{32}$/u,
    "a BPS- reference with 32 lowercase hexadecimal characters",
  );
  const planHash = assertPattern(
    envelope.plan_hash,
    `${path}.plan_hash`,
    /^[a-f0-9]{64}$/u,
    "a lowercase SHA-256 hash",
  );
  if (planSnapshotRef !== `BPS-${planHash.slice(0, 32)}`) {
    invalid(
      `${path}.plan_snapshot_ref`,
      "plan_identity_mismatch",
      "must match the content-addressed plan_hash",
    );
  }
  return {
    work_order_id: workOrderId,
    plan_snapshot_ref: planSnapshotRef,
    plan_hash: planHash,
  };
}

function normalizeCommandEnvelopeV1(input) {
  preflightJson(input, "command", CONTRACT_LIMITS.max_envelope_bytes);
  const command = assertExactFields(input, COMMAND_FIELDS, COMMAND_FIELDS, "command");
  if (command.version !== COMMAND_ENVELOPE_VERSION) {
    invalid("command.version", "version", `must be ${COMMAND_ENVELOPE_VERSION}`);
  }
  const name = assertEnum(command.name, WORK_ORDER_COMMAND_NAMES, "command.name");
  preflightJson(command.payload, "command.payload", CONTRACT_LIMITS.max_payload_bytes);
  const payload = normalizeCommandPayload(name, command.payload);
  const payloadHash = canonicalHash(payload);
  const suppliedPayloadHash = assertPattern(
    command.payload_hash,
    "command.payload_hash",
    /^[a-f0-9]{64}$/u,
    "a lowercase SHA-256 hash",
  );
  if (suppliedPayloadHash !== payloadHash) {
    invalid("command.payload_hash", "hash_mismatch", "does not match canonical payload");
  }
  const actor = normalizeActor(command.actor, "command.actor", COMMAND_ACTOR_TYPES);
  assertActorProvenance(actor, name, COMMAND_ACTORS_BY_NAME, "command.actor");
  return deepFreeze({
    version: COMMAND_ENVELOPE_VERSION,
    command_id: assertPattern(
      command.command_id,
      "command.command_id",
      /^CMD-[a-f0-9]{32}$/u,
      "a CMD- identifier with 32 lowercase hexadecimal characters",
    ),
    ...normalizeEnvelopeIdentity(command, "command"),
    expected_work_order_revision: assertInteger(
      command.expected_work_order_revision,
      "command.expected_work_order_revision",
      { minimum: 0, maximum: 1_000_000_000 },
    ),
    actor,
    name,
    payload,
    payload_hash: payloadHash,
  });
}

function normalizeRuntimeObservationEnvelopeV1(input) {
  preflightJson(input, "observation", CONTRACT_LIMITS.max_envelope_bytes);
  const observation = assertExactFields(
    input,
    OBSERVATION_FIELDS,
    OBSERVATION_FIELDS,
    "observation",
  );
  if (observation.version !== RUNTIME_OBSERVATION_ENVELOPE_VERSION) {
    invalid(
      "observation.version",
      "version",
      `must be ${RUNTIME_OBSERVATION_ENVELOPE_VERSION}`,
    );
  }
  const name = assertEnum(
    observation.name,
    RUNTIME_OBSERVATION_NAMES,
    "observation.name",
  );
  preflightJson(observation.payload, "observation.payload", CONTRACT_LIMITS.max_payload_bytes);
  const payload = normalizeObservationPayload(name, observation.payload);
  const payloadHash = canonicalHash(payload);
  const suppliedPayloadHash = assertPattern(
    observation.payload_hash,
    "observation.payload_hash",
    /^[a-f0-9]{64}$/u,
    "a lowercase SHA-256 hash",
  );
  if (suppliedPayloadHash !== payloadHash) {
    invalid("observation.payload_hash", "hash_mismatch", "does not match canonical payload");
  }
  const actor = normalizeActor(
    observation.actor,
    "observation.actor",
    RUNTIME_OBSERVATION_ACTOR_TYPES,
  );
  assertActorProvenance(
    actor,
    name,
    OBSERVATION_ACTORS_BY_NAME,
    "observation.actor",
  );
  return deepFreeze({
    version: RUNTIME_OBSERVATION_ENVELOPE_VERSION,
    observation_id: assertPattern(
      observation.observation_id,
      "observation.observation_id",
      /^OBS-[a-f0-9]{32}$/u,
      "an OBS- identifier with 32 lowercase hexadecimal characters",
    ),
    ...normalizeEnvelopeIdentity(observation, "observation"),
    work_order_revision: assertInteger(
      observation.work_order_revision,
      "observation.work_order_revision",
      { minimum: 0, maximum: 1_000_000_000 },
    ),
    actor,
    name,
    payload,
    payload_hash: payloadHash,
  });
}

function normalizeEffectSettlementObservationEnvelopeV2(input) {
  preflightJson(input, "observation", CONTRACT_LIMITS.max_envelope_bytes);
  const observation = assertExactFields(
    input,
    OBSERVATION_FIELDS,
    OBSERVATION_FIELDS,
    "observation",
  );
  if (observation.version !== EFFECT_SETTLEMENT_OBSERVATION_ENVELOPE_VERSION) {
    invalid(
      "observation.version",
      "version",
      `must be ${EFFECT_SETTLEMENT_OBSERVATION_ENVELOPE_VERSION}`,
    );
  }
  const name = assertEnum(
    observation.name,
    EFFECT_SETTLEMENT_OBSERVATION_NAMES,
    "observation.name",
  );
  preflightJson(observation.payload, "observation.payload", CONTRACT_LIMITS.max_payload_bytes);
  const payload = normalizeEffectSettlementPayloadV2(observation.payload);
  const payloadHash = canonicalHash(payload);
  const suppliedPayloadHash = assertPattern(
    observation.payload_hash,
    "observation.payload_hash",
    /^[a-f0-9]{64}$/u,
    "a lowercase SHA-256 hash",
  );
  if (suppliedPayloadHash !== payloadHash) {
    invalid("observation.payload_hash", "hash_mismatch", "does not match canonical payload");
  }
  const actor = normalizeActor(
    observation.actor,
    "observation.actor",
    RUNTIME_OBSERVATION_ACTOR_TYPES,
  );
  assertActorProvenance(
    actor,
    name,
    EFFECT_SETTLEMENT_OBSERVATION_ACTORS_BY_NAME,
    "observation.actor",
  );
  return deepFreeze({
    version: EFFECT_SETTLEMENT_OBSERVATION_ENVELOPE_VERSION,
    observation_id: assertPattern(
      observation.observation_id,
      "observation.observation_id",
      /^OBS-[a-f0-9]{32}$/u,
      "an OBS- identifier with 32 lowercase hexadecimal characters",
    ),
    ...normalizeEnvelopeIdentity(observation, "observation"),
    work_order_revision: assertInteger(
      observation.work_order_revision,
      "observation.work_order_revision",
      { minimum: 0, maximum: 1_000_000_000 },
    ),
    actor,
    name,
    payload,
    payload_hash: payloadHash,
  });
}

function normalizeEffectSendExpiryObservationEnvelopeV2(input) {
  preflightJson(input, "observation", CONTRACT_LIMITS.max_envelope_bytes);
  const observation = assertExactFields(
    input,
    OBSERVATION_FIELDS,
    OBSERVATION_FIELDS,
    "observation",
  );
  if (observation.version !== EFFECT_SETTLEMENT_OBSERVATION_ENVELOPE_VERSION) {
    invalid(
      "observation.version",
      "version",
      `must be ${EFFECT_SETTLEMENT_OBSERVATION_ENVELOPE_VERSION}`,
    );
  }
  const name = assertEnum(
    observation.name,
    EFFECT_SEND_EXPIRY_OBSERVATION_NAMES,
    "observation.name",
  );
  preflightJson(observation.payload, "observation.payload", CONTRACT_LIMITS.max_payload_bytes);
  const payload = normalizeEffectSendExpiryPayloadV2(observation.payload);
  const payloadHash = canonicalHash(payload);
  const suppliedPayloadHash = assertPattern(
    observation.payload_hash,
    "observation.payload_hash",
    /^[a-f0-9]{64}$/u,
    "a lowercase SHA-256 hash",
  );
  if (suppliedPayloadHash !== payloadHash) {
    invalid("observation.payload_hash", "hash_mismatch", "does not match canonical payload");
  }
  const actor = normalizeActor(
    observation.actor,
    "observation.actor",
    RUNTIME_OBSERVATION_ACTOR_TYPES,
  );
  assertActorProvenance(
    actor,
    name,
    EFFECT_SEND_EXPIRY_OBSERVATION_ACTORS_BY_NAME,
    "observation.actor",
  );
  return deepFreeze({
    version: EFFECT_SETTLEMENT_OBSERVATION_ENVELOPE_VERSION,
    observation_id: assertPattern(
      observation.observation_id,
      "observation.observation_id",
      /^OBS-[a-f0-9]{32}$/u,
      "an OBS- identifier with 32 lowercase hexadecimal characters",
    ),
    ...normalizeEnvelopeIdentity(observation, "observation"),
    work_order_revision: assertInteger(
      observation.work_order_revision,
      "observation.work_order_revision",
      { minimum: 0, maximum: 1_000_000_000 },
    ),
    actor,
    name,
    payload,
    payload_hash: payloadHash,
  });
}

function normalizeEffectPresendFailureObservationEnvelopeV2(input) {
  preflightJson(input, "observation", CONTRACT_LIMITS.max_envelope_bytes);
  const observation = assertExactFields(
    input,
    OBSERVATION_FIELDS,
    OBSERVATION_FIELDS,
    "observation",
  );
  if (observation.version !== EFFECT_SETTLEMENT_OBSERVATION_ENVELOPE_VERSION) {
    invalid(
      "observation.version",
      "version",
      `must be ${EFFECT_SETTLEMENT_OBSERVATION_ENVELOPE_VERSION}`,
    );
  }
  const name = assertEnum(
    observation.name,
    EFFECT_PRESEND_FAILURE_OBSERVATION_NAMES,
    "observation.name",
  );
  preflightJson(observation.payload, "observation.payload", CONTRACT_LIMITS.max_payload_bytes);
  const payload = normalizeEffectPresendFailurePayloadV2(observation.payload);
  const payloadHash = canonicalHash(payload);
  const suppliedPayloadHash = assertPattern(
    observation.payload_hash,
    "observation.payload_hash",
    /^[a-f0-9]{64}$/u,
    "a lowercase SHA-256 hash",
  );
  if (suppliedPayloadHash !== payloadHash) {
    invalid("observation.payload_hash", "hash_mismatch", "does not match canonical payload");
  }
  const actor = normalizeActor(
    observation.actor,
    "observation.actor",
    RUNTIME_OBSERVATION_ACTOR_TYPES,
  );
  assertActorProvenance(
    actor,
    name,
    EFFECT_PRESEND_FAILURE_OBSERVATION_ACTORS_BY_NAME,
    "observation.actor",
  );
  return deepFreeze({
    version: EFFECT_SETTLEMENT_OBSERVATION_ENVELOPE_VERSION,
    observation_id: assertPattern(
      observation.observation_id,
      "observation.observation_id",
      /^OBS-[a-f0-9]{32}$/u,
      "an OBS- identifier with 32 lowercase hexadecimal characters",
    ),
    ...normalizeEnvelopeIdentity(observation, "observation"),
    work_order_revision: assertInteger(
      observation.work_order_revision,
      "observation.work_order_revision",
      { minimum: 0, maximum: 1_000_000_000 },
    ),
    actor,
    name,
    payload,
    payload_hash: payloadHash,
  });
}

function normalizeBusinessRuntimeObservationEnvelope(input) {
  preflightJson(input, "observation", CONTRACT_LIMITS.max_envelope_bytes);
  const observation = assertPlainObject(input, "observation");
  if (observation.version === RUNTIME_OBSERVATION_ENVELOPE_VERSION) {
    return normalizeRuntimeObservationEnvelopeV1(observation);
  }
  if (observation.version === EFFECT_SETTLEMENT_OBSERVATION_ENVELOPE_VERSION) {
    if (EFFECT_SETTLEMENT_OBSERVATION_NAMES.includes(observation.name)) {
      return normalizeEffectSettlementObservationEnvelopeV2(observation);
    }
    if (EFFECT_SEND_EXPIRY_OBSERVATION_NAMES.includes(observation.name)) {
      return normalizeEffectSendExpiryObservationEnvelopeV2(observation);
    }
    return normalizeEffectPresendFailureObservationEnvelopeV2(observation);
  }
  invalid(
    "observation.version",
    "version",
    `must be ${RUNTIME_OBSERVATION_ENVELOPE_VERSION} or ${EFFECT_SETTLEMENT_OBSERVATION_ENVELOPE_VERSION}`,
  );
}

function failClosedNormalizer(path, normalize) {
  return (input) => {
    try {
      return normalize(input);
    } catch (error) {
      if (error instanceof ContractValidationError) throw error;
      throw new ContractValidationError(
        path,
        "hostile_input",
        "could not be safely inspected as contract input",
      );
    }
  };
}

const normalizeBusinessWorkOrderPlanV1FailClosed = failClosedNormalizer(
  "plan",
  normalizeBusinessWorkOrderPlanV1,
);
const normalizeCommandEnvelopeV1FailClosed = failClosedNormalizer(
  "command",
  normalizeCommandEnvelopeV1,
);
const normalizeRuntimeObservationEnvelopeV1FailClosed = failClosedNormalizer(
  "observation",
  normalizeRuntimeObservationEnvelopeV1,
);
const normalizeEffectSettlementObservationEnvelopeV2FailClosed = failClosedNormalizer(
  "observation",
  normalizeEffectSettlementObservationEnvelopeV2,
);
const normalizeBusinessRuntimeObservationEnvelopeFailClosed = failClosedNormalizer(
  "observation",
  normalizeBusinessRuntimeObservationEnvelope,
);

module.exports = {
  ACCEPTANCE_VERIFICATION_MODES,
  BRANCH_ISOLATION_MODES,
  BRANCH_ROLES,
  BUSINESS_ENGINE_CONTRACT_VERSION,
  BUSINESS_WORK_ORDER_PLAN_VERSION,
  COMMAND_ACTOR_TYPES,
  COMMAND_ENVELOPE_VERSION,
  CONTRACT_LIMITS,
  ContractValidationError,
  EFFECT_SETTLEMENT_OBSERVATION_ENVELOPE_VERSION,
  EFFECT_SETTLEMENT_OBSERVATION_NAMES,
  EFFECT_SETTLEMENT_SOURCES,
  EFFECT_SEND_EXPIRY_OBSERVATION_NAMES,
  EFFECT_PRESEND_FAILURE_OBSERVATION_NAMES,
  PERMISSION_MODES,
  PROVIDER_SELECTION_MODES,
  RETRYABLE_RUNTIME_OBSERVATIONS,
  REVIEW_MINIMUMS,
  RUNTIME_OBSERVATION_ACTOR_TYPES,
  RUNTIME_OBSERVATION_ENVELOPE_VERSION,
  RUNTIME_OBSERVATION_NAMES,
  WORK_ORDER_COMMAND_NAMES,
  normalizeBusinessRuntimeObservationEnvelope:
    normalizeBusinessRuntimeObservationEnvelopeFailClosed,
  normalizeBusinessWorkOrderPlanV1: normalizeBusinessWorkOrderPlanV1FailClosed,
  normalizeCommandEnvelopeV1: normalizeCommandEnvelopeV1FailClosed,
  normalizeEffectSettlementObservationEnvelopeV2:
    normalizeEffectSettlementObservationEnvelopeV2FailClosed,
  normalizeRuntimeObservationEnvelopeV1: normalizeRuntimeObservationEnvelopeV1FailClosed,
};
