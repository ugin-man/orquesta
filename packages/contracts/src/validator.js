const fs = require("node:fs");
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");

const SUPPORTED_KEYWORDS = new Set([
  "$id", "$schema", "type", "required", "properties", "items",
  "enum", "const", "minItems", "minimum", "maximum", "pattern",
  "additionalProperties", "anyOf", "oneOf"
]);
const SUPPORTED_TYPES = new Set(["null", "boolean", "string", "number", "integer", "array", "object"]);
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SCHEMA_NAMES = [
  "task-intent",
  "capability-need",
  "capability-provider",
  "candidate-evaluation",
  "audition",
  "resolution",
  "context-pack",
  "event-batch",
  "phase-review",
  "approval-attestation",
  "execution-plan",
  "live-source-query",
  "live-source-result",
  "audition-plan",
  "audition-result",
  "install-approval-target",
  "runtime-evidence",
  "codex-dispatch"
];
const defaultSchemasDir = path.resolve(__dirname, "../schemas");

function schemaError(pathValue, code, message) {
  return { path: pathValue, code, message };
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertSupportedSchema(schema, schemaPath = "$") {
  if (!isPlainObject(schema)) throw new TypeError(`Schema at ${schemaPath} must be an object`);

  for (const [keyword, value] of Object.entries(schema)) {
    if (!SUPPORTED_KEYWORDS.has(keyword)) {
      throw new TypeError(`Unsupported schema keyword at ${schemaPath}: ${keyword}`);
    }
    if ((keyword === "$id" || keyword === "$schema") && typeof value !== "string") {
      throw new TypeError(`Schema ${keyword} at ${schemaPath} must be a string`);
    }
    if (keyword === "type" && (typeof value !== "string" || !SUPPORTED_TYPES.has(value))) {
      throw new TypeError(`Schema type at ${schemaPath} must be a supported type`);
    }
    if (keyword === "required" && (!Array.isArray(value) || value.some((item) => typeof item !== "string"))) {
      throw new TypeError(`Schema required at ${schemaPath} must be an array of strings`);
    }
    if (keyword === "properties") {
      if (!isPlainObject(value)) throw new TypeError(`Schema properties at ${schemaPath} must be an object`);
      for (const [property, child] of Object.entries(value)) {
        assertSupportedSchema(child, `${schemaPath}.properties.${property}`);
      }
    }
    if (keyword === "items") assertSupportedSchema(value, `${schemaPath}.items`);
    if (keyword === "enum" && (!Array.isArray(value) || value.length === 0)) {
      throw new TypeError(`Schema enum at ${schemaPath} must be a non-empty array`);
    }
    if (keyword === "minItems" && (!Number.isInteger(value) || value < 0)) {
      throw new TypeError(`Schema minItems at ${schemaPath} must be a non-negative integer`);
    }
    if ((keyword === "minimum" || keyword === "maximum") && (typeof value !== "number" || !Number.isFinite(value))) {
      throw new TypeError(`Schema ${keyword} at ${schemaPath} must be a finite number`);
    }
    if (keyword === "pattern") {
      if (typeof value !== "string") throw new TypeError(`Schema pattern at ${schemaPath} must be a string`);
      try {
        new RegExp(value);
      } catch {
        throw new TypeError(`Schema pattern at ${schemaPath} must be a valid regular expression`);
      }
    }
    if (keyword === "additionalProperties") {
      if (typeof value !== "boolean" && !isPlainObject(value)) {
        throw new TypeError(`Schema additionalProperties at ${schemaPath} must be boolean or an object`);
      }
      if (isPlainObject(value)) assertSupportedSchema(value, `${schemaPath}.additionalProperties`);
    }
    if (keyword === "anyOf" || keyword === "oneOf") {
      if (!Array.isArray(value) || value.length === 0) {
        throw new TypeError(`Schema ${keyword} at ${schemaPath} must be a non-empty array`);
      }
      value.forEach((child, index) => assertSupportedSchema(child, `${schemaPath}.${keyword}[${index}]`));
    }
  }
}

function loadSchema(name, schemasDir = defaultSchemasDir) {
  if (!SCHEMA_NAMES.includes(name)) throw new RangeError(`Unknown contract schema: ${name}`);
  const filePath = path.join(schemasDir, `${name}.schema.json`);
  const schema = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assertSupportedSchema(schema);
  return schema;
}

function typeMatches(value, expectedType) {
  if (expectedType === "null") return value === null;
  if (expectedType === "array") return Array.isArray(value);
  if (expectedType === "object") return isPlainObject(value);
  if (expectedType === "integer") return Number.isInteger(value);
  if (expectedType === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === expectedType;
}

function validateSchema(schema, value, valuePath = "$") {
  const errors = [];
  if (schema.anyOf) {
    const matches = schema.anyOf.filter((alternative) => validateSchema(alternative, value, valuePath).length === 0);
    if (matches.length === 0) errors.push(schemaError(valuePath, "anyOf", "must match an allowed schema"));
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((alternative) => validateSchema(alternative, value, valuePath).length === 0);
    if (matches.length !== 1) errors.push(schemaError(valuePath, "oneOf", "must match exactly one allowed schema"));
  }
  if (schema.type && !typeMatches(value, schema.type)) {
    errors.push(schemaError(valuePath, "type", `must be ${schema.type}`));
  }
  if (Object.hasOwn(schema, "const") && !isDeepStrictEqual(value, schema.const)) {
    errors.push(schemaError(valuePath, "const", `must equal ${JSON.stringify(schema.const)}`));
  }
  if (schema.enum && !schema.enum.some((entry) => isDeepStrictEqual(entry, value))) {
    errors.push(schemaError(valuePath, "enum", "must be one of the allowed values"));
  }
  if (schema.minimum !== undefined && typeof value === "number" && value < schema.minimum) {
    errors.push(schemaError(valuePath, "minimum", `must be at least ${schema.minimum}`));
  }
  if (schema.maximum !== undefined && typeof value === "number" && value > schema.maximum) {
    errors.push(schemaError(valuePath, "maximum", `must be at most ${schema.maximum}`));
  }
  if (schema.pattern && typeof value === "string" && !(new RegExp(schema.pattern).test(value))) {
    errors.push(schemaError(valuePath, "pattern", "must match the required pattern"));
  }
  if (schema.minItems !== undefined && Array.isArray(value) && value.length < schema.minItems) {
    errors.push(schemaError(valuePath, "minItems", `must contain at least ${schema.minItems} item${schema.minItems === 1 ? "" : "s"}`));
  }
  if (schema.items && Array.isArray(value)) {
    value.forEach((item, index) => errors.push(...validateSchema(schema.items, item, `${valuePath}[${index}]`)));
  }
  if (isPlainObject(value) && (schema.type === "object" || schema.properties || schema.required || schema.additionalProperties !== undefined)) {
    for (const property of schema.required || []) {
      if (!Object.hasOwn(value, property)) errors.push(schemaError(`${valuePath}.${property}`, "required", "is required"));
    }
    const properties = schema.properties || {};
    for (const property of Object.keys(properties).sort()) {
      if (Object.hasOwn(value, property)) errors.push(...validateSchema(properties[property], value[property], `${valuePath}.${property}`));
    }
    for (const property of Object.keys(value).sort()) {
      if (Object.hasOwn(properties, property)) continue;
      if (schema.additionalProperties === false) {
        errors.push(schemaError(`${valuePath}.${property}`, "additionalProperties", "is not allowed"));
      } else if (isPlainObject(schema.additionalProperties)) {
        errors.push(...validateSchema(schema.additionalProperties, value[property], `${valuePath}.${property}`));
      }
    }
  }
  return errors;
}

function isValidUtcTimestamp(value) {
  if (typeof value !== "string" || !UTC_TIMESTAMP_PATTERN.test(value)) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function approvalAttestationErrors(value) {
  if (!isPlainObject(value)) return [];
  const errors = [];
  if (!isValidUtcTimestamp(value.captured_at)) {
    errors.push(schemaError("$.captured_at", "timestamp", "must be a valid UTC timestamp"));
  }
  if (!isValidUtcTimestamp(value.expires_at)) {
    errors.push(schemaError("$.expires_at", "timestamp", "must be a valid UTC timestamp"));
  }
  if (isValidUtcTimestamp(value.captured_at) && isValidUtcTimestamp(value.expires_at)
    && new Date(value.expires_at).getTime() <= new Date(value.captured_at).getTime()) {
    errors.push(schemaError("$.expires_at", "approval_expiry_order", "must be later than captured_at"));
  }
  return errors;
}

function timestampFieldErrors(value, fields) {
  if (!isPlainObject(value)) return [];
  const errors = [];
  for (const field of fields) {
    if (value[field] !== null && !isValidUtcTimestamp(value[field])) {
      errors.push(schemaError(`$.${field}`, "timestamp", "must be a valid UTC timestamp"));
    }
  }
  return errors;
}

function phaseReviewErrors(value) {
  if (!isPlainObject(value) || !["ready_for_user_review", "approved"].includes(value.status)) return [];
  const errors = [];
  if (typeof value.review_packet_ref !== "string" || !value.review_packet_ref) {
    errors.push(schemaError("$.review_packet_ref", "phase_review_evidence", "is required before user review"));
  }
  if (typeof value.review_packet_hash !== "string" || !/^[a-f0-9]{64}$/.test(value.review_packet_hash)) {
    errors.push(schemaError("$.review_packet_hash", "phase_review_evidence", "must be a SHA-256 hash before user review"));
  }
  if (typeof value.build_ref !== "string" || !value.build_ref) {
    errors.push(schemaError("$.build_ref", "phase_review_evidence", "is required before user review"));
  }
  if (!isPlainObject(value.artifact_hashes) || Object.keys(value.artifact_hashes).length === 0) {
    errors.push(schemaError("$.artifact_hashes", "phase_review_evidence", "must contain artifact hashes before user review"));
  }
  if (value.status === "approved") {
    const decision = value.user_decision;
    if (!isPlainObject(decision) || decision.decision !== "approved") {
      errors.push(schemaError("$.user_decision", "approval_user_decision_required", "must record an explicit approved user decision"));
    } else if (!isPlainObject(decision.attestation)) {
      errors.push(schemaError("$.user_decision.attestation", "approval_attestation_required", "must contain a redacted approval attestation"));
    } else {
      const binding = validatePhaseApprovalBinding({
        phaseReview: value,
        attestation: decision.attestation
      });
      errors.push(...binding.errors);
    }
  }
  return errors;
}

const EXECUTION_BUDGETS = {
  fast: { max_handoffs: 0, max_independent_reviews: 0, max_correction_batches: 1, max_reports: 0, max_auxiliary_tasks: 0 },
  standard: { max_handoffs: 2, max_independent_reviews: 1, max_correction_batches: 1, max_reports: 1, max_auxiliary_tasks: 0 },
  critical: { max_handoffs: 4, max_independent_reviews: 2, max_correction_batches: 2, max_reports: 2, max_auxiliary_tasks: 0 }
};

const ACQUISITION_LIMITS = {
  max_requests_per_need: 8,
  max_requests_per_connector: 2,
  max_candidates: 3
};

function sortedUnique(values) {
  return Array.isArray(values) && values.every((value, index) => (
    typeof value === "string" && (index === 0 || codeUnitCompare(values[index - 1], value) < 0)
  ));
}

function sortedUniqueBy(values, key) {
  return Array.isArray(values) && values.every((value, index) => (
    isPlainObject(value)
    && typeof value[key] === "string"
    && (index === 0 || codeUnitCompare(values[index - 1][key], value[key]) < 0)
  ));
}

function phase2ArrayErrors(value, fields, recordFields = []) {
  if (!isPlainObject(value)) return [];
  const errors = [];
  for (const field of fields) {
    if (!sortedUnique(value[field])) {
      errors.push(schemaError(`$.${field}`, "sorted_unique", "must be sorted with no duplicate entries"));
    }
  }
  for (const [field, key] of recordFields) {
    if (!sortedUniqueBy(value[field], key)) {
      errors.push(schemaError(`$.${field}`, "sorted_unique", "must be sorted with no duplicate entries"));
    }
  }
  return errors;
}

function liveSourceQueryErrors(value) {
  if (!isPlainObject(value)) return [];
  const errors = phase2ArrayErrors(value, ["query_terms", "allowed_connector_ids"]);
  if (!isDeepStrictEqual(value.request_budget, {
    max_requests_per_need: ACQUISITION_LIMITS.max_requests_per_need,
    max_requests_per_connector: ACQUISITION_LIMITS.max_requests_per_connector
  })) {
    errors.push(schemaError("$.request_budget", "acquisition_budget", "must match the fixed acquisition budget"));
  }
  if (value.candidate_limit !== ACQUISITION_LIMITS.max_candidates) {
    errors.push(schemaError("$.candidate_limit", "acquisition_candidate_limit", "must match the fixed candidate limit"));
  }
  return errors;
}

function liveSourceResultErrors(value) {
  if (!isPlainObject(value)) return [];
  const domains = ["license", "maintenance", "security", "compatibility", "accessibility", "cost", "trust", "freshness"];
  const errors = timestampFieldErrors(value, ["fetched_at", "expires_at"]);
  errors.push(...phase2ArrayErrors(value, [], [["candidates", "candidate_id"], ["source_evidence", "candidate_id"]]));
  if (isValidUtcTimestamp(value.fetched_at) && isValidUtcTimestamp(value.expires_at)
    && new Date(value.expires_at).getTime() <= new Date(value.fetched_at).getTime()) {
    errors.push(schemaError("$.expires_at", "source_expiry_order", "must be later than fetched_at"));
  }
  if (!Array.isArray(value.candidates) || !Array.isArray(value.source_evidence)) return errors;
  const records = new Map(value.candidates.map((candidate) => [candidate && candidate.candidate_id, candidate]));
  for (const evidence of value.source_evidence) {
    if (!isPlainObject(evidence)) continue;
    const candidate = records.get(evidence.candidate_id);
    if (!candidate || candidate.source_ref !== evidence.source_ref || candidate.source_hash !== evidence.source_hash) {
      errors.push(schemaError("$.source_evidence", "source_candidate_binding", "must bind one current candidate source ref and hash"));
      continue;
    }
    if (!isPlainObject(evidence.facts)
      || candidate.trust_tier !== evidence.facts.trust
      || candidate.freshness !== evidence.freshness
      || candidate.freshness !== evidence.facts.freshness) {
      errors.push(schemaError(`$.source_evidence.${evidence.candidate_id}`, "source_record_binding", "must bind the candidate trust and freshness evidence"));
    }
    if (!sortedUnique(evidence.authoritative_fields) || !sortedUnique(evidence.unknowns)) {
      errors.push(schemaError(`$.source_evidence.${evidence.candidate_id}`, "sorted_unique", "authority and unknown fields must be sorted with no duplicates"));
    }
    const facts = isPlainObject(evidence.facts) ? Object.keys(evidence.facts).sort(codeUnitCompare) : [];
    const authorities = Array.isArray(evidence.authoritative_fields) ? evidence.authoritative_fields : [];
    if (!isDeepStrictEqual(facts, authorities)) {
      errors.push(schemaError(`$.source_evidence.${evidence.candidate_id}.facts`, "source_fact_authority", "must exactly match authoritative fields"));
    }
    const unknowns = Array.isArray(evidence.unknowns) ? evidence.unknowns : [];
    for (const domain of domains) {
      const coverage = Number(authorities.includes(domain)) + Number(unknowns.includes(domain));
      if (coverage !== 1) {
        errors.push(schemaError(`$.source_evidence.${evidence.candidate_id}`, "source_domain_coverage", "must record every source domain as exactly fact or unknown"));
        break;
      }
    }
  }
  return errors;
}

function auditionPlanErrors(value) {
  return phase2ArrayErrors(value, ["permitted_effects", "steps", "expected_evidence", "cleanup_plan", "approval_refs"]);
}

function auditionResultErrors(value) {
  return phase2ArrayErrors(value, ["side_effects", "evidence_refs", "cleanup_evidence"], [["steps", "step"]]);
}

function installApprovalTargetErrors(value) {
  const errors = timestampFieldErrors(value, ["expires_at"]);
  errors.push(...phase2ArrayErrors(value, ["effects"]));
  return errors;
}

function runtimeEvidenceErrors(value) {
  if (!isPlainObject(value)) return [];
  const errors = timestampFieldErrors(value, ["captured_at"]);
  if (value.actual_model !== null && (!value.payload_ref || !value.payload_hash
    || value.event_kind !== "model_observed"
    || !["app_server", "approved_hook"].includes(value.source))) {
    errors.push(schemaError("$.actual_model", "actual_model_evidence", "requires bound App Server or approved-hook model observation evidence"));
  }
  return errors;
}

function codexDispatchErrors(value) {
  if (!isPlainObject(value)) return [];
  const errors = phase2ArrayErrors(value, ["evidence_refs"]);
  if (value.request_status === "turn_started" && (!value.turn_id || !value.turn_started_evidence_ref)) {
    errors.push(schemaError("$.turn_started_evidence_ref", "turn_started_evidence", "is required for turn_started dispatches"));
  }
  if (value.request_status !== "turn_started" && value.turn_started_evidence_ref !== null) {
    errors.push(schemaError("$.turn_started_evidence_ref", "turn_started_evidence", "must be null before turn_started"));
  }
  if (value.adapter_kind === "repository_only" && value.request_status === "turn_started") {
    errors.push(schemaError("$.request_status", "repository_turn_started", "repository_only cannot claim turn_started"));
  }
  return errors;
}

function executionPlanErrors(value) {
  if (!isPlainObject(value)) return [];
  const errors = [];
  if (!sortedUnique(value.reason_codes)) {
    errors.push(schemaError("$.reason_codes", "sorted_unique", "must be sorted with no duplicate entries"));
  }
  if (isPlainObject(value.risk_profile) && !sortedUnique(value.risk_profile.effects)) {
    errors.push(schemaError("$.risk_profile.effects", "sorted_unique", "must be sorted with no duplicate entries"));
  }
  if (!sortedUnique(value.escalation_triggers)) {
    errors.push(schemaError("$.escalation_triggers", "sorted_unique", "must be sorted with no duplicate entries"));
  }
  if (Object.prototype.hasOwnProperty.call(EXECUTION_BUDGETS, value.lane)
    && !isDeepStrictEqual(value.budget, EXECUTION_BUDGETS[value.lane])) {
    errors.push(schemaError("$.budget", "execution_budget", "must match the lane budget"));
  }
  const expectedRouting = value.lane === "fast"
    ? { routing_class: "inline_verified", handoff_required: false, specialist_report_required: false }
    : { routing_class: "specialist_required", handoff_required: true, specialist_report_required: true };
  if (["fast", "standard", "critical"].includes(value.lane)
    && !isDeepStrictEqual(value.routing, expectedRouting)) {
    errors.push(schemaError("$.routing", "execution_routing", "must match the lane routing policy"));
  }
  const expectedReviewPolicy = value.lane === "fast" ? "none"
    : value.lane === "standard" ? "independent_once"
      : value.lane === "critical" ? "independent_twice" : null;
  if (expectedReviewPolicy && value.review_policy !== expectedReviewPolicy) {
    errors.push(schemaError("$.review_policy", "execution_review_policy", "must match the lane review policy"));
  }
  return errors;
}

function codeUnitCompare(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sortErrors(errors) {
  return errors.sort((left, right) => (
    codeUnitCompare(left.path, right.path)
    || codeUnitCompare(left.code, right.code)
    || codeUnitCompare(left.message, right.message)
  ));
}

function validateContract(name, value, options = {}) {
  const errors = validateSchema(loadSchema(name, options.schemasDir), value, "$");
  if (name === "approval-attestation") errors.push(...approvalAttestationErrors(value));
  if (name === "capability-provider") errors.push(...timestampFieldErrors(value, ["last_verified_at"]));
  if (name === "context-pack") errors.push(...timestampFieldErrors(value, ["expires_at"]));
  if (name === "phase-review") {
    errors.push(...timestampFieldErrors(value, ["review_requested_at", "reviewed_at"]));
    errors.push(...phaseReviewErrors(value));
  }
  if (name === "execution-plan") errors.push(...executionPlanErrors(value));
  if (name === "live-source-query") {
    errors.push(...timestampFieldErrors(value, ["requested_at"]));
    errors.push(...liveSourceQueryErrors(value));
  }
  if (name === "live-source-result") errors.push(...liveSourceResultErrors(value));
  if (name === "audition-plan") errors.push(...auditionPlanErrors(value));
  if (name === "audition-result") errors.push(...auditionResultErrors(value));
  if (name === "install-approval-target") errors.push(...installApprovalTargetErrors(value));
  if (name === "runtime-evidence") errors.push(...runtimeEvidenceErrors(value));
  if (name === "codex-dispatch") errors.push(...codexDispatchErrors(value));
  return { ok: errors.length === 0, errors: sortErrors(errors) };
}

function assertContract(name, value, options) {
  const result = validateContract(name, value, options);
  if (!result.ok) {
    const error = new TypeError(`${name} contract validation failed: ${result.errors.map((item) => `${item.path} ${item.code}`).join(", ")}`);
    error.errors = result.errors;
    throw error;
  }
  return value;
}

function validatePhaseApprovalBinding({ phaseReview, attestation } = {}) {
  const errors = [];
  if (!isPlainObject(phaseReview)) {
    errors.push(schemaError("$.phaseReview", "approval_phase_review_missing", "phase review is required"));
  }
  if (!isPlainObject(attestation)) {
    errors.push(schemaError("$.attestation", "approval_attestation_missing", "approval attestation is required"));
  }
  if (errors.length > 0) return { ok: false, errors: sortErrors(errors) };

  if (typeof phaseReview.phase_id !== "string" || !phaseReview.phase_id
    || !Number.isInteger(phaseReview.review_cycle_revision) || phaseReview.review_cycle_revision < 0
    || typeof phaseReview.review_packet_hash !== "string" || !/^[a-f0-9]{64}$/.test(phaseReview.review_packet_hash)) {
    errors.push(schemaError("$.phaseReview", "approval_phase_review_invalid", "phase review binding fields are invalid"));
  }
  if (!isValidUtcTimestamp(phaseReview.reviewed_at)) {
    const code = phaseReview.reviewed_at === null || phaseReview.reviewed_at === undefined
      ? "approval_reference_time_missing"
      : "approval_reference_time_invalid";
    errors.push(schemaError("$.reviewed_at", code, "phase review reviewed_at must be a valid UTC approval reference time"));
  }

  const attestationResult = validateContract("approval-attestation", attestation);
  if (!attestationResult.ok) {
    errors.push(schemaError("$.attestation", "approval_attestation_invalid", "approval attestation is malformed or unverified"));
  }

  if (phaseReview.phase_id !== attestation.target_id) {
    errors.push(schemaError("$.target_id", "approval_target_mismatch", "approval attestation target must match phase review"));
  }
  if (phaseReview.review_packet_hash !== attestation.review_packet_hash) {
    errors.push(schemaError("$.review_packet_hash", "approval_packet_hash_mismatch", "approval attestation review packet hash must match phase review"));
  }
  if (phaseReview.review_cycle_revision !== attestation.target_revision) {
    errors.push(schemaError("$.target_revision", "approval_revision_mismatch", "approval attestation target revision must match phase review review cycle revision"));
  }

  if (isValidUtcTimestamp(phaseReview.reviewed_at)
    && isValidUtcTimestamp(attestation.captured_at)
    && isValidUtcTimestamp(attestation.expires_at)) {
    const reviewedAt = new Date(phaseReview.reviewed_at).getTime();
    const capturedAt = new Date(attestation.captured_at).getTime();
    const expiresAt = new Date(attestation.expires_at).getTime();
    if (capturedAt > reviewedAt) {
      errors.push(schemaError("$.captured_at", "approval_capture_after_review", "approval attestation must be captured on or before reviewed_at"));
    }
    if (reviewedAt >= expiresAt) {
      errors.push(schemaError("$.expires_at", "approval_attestation_expired", "approval attestation must expire after reviewed_at"));
    }
  }
  return { ok: errors.length === 0, errors: sortErrors(errors) };
}

module.exports = {
  SCHEMA_NAMES,
  loadSchema,
  validateContract,
  assertContract,
  validatePhaseApprovalBinding
};
