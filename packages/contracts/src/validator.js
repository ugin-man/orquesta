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
  "approval-attestation"
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
