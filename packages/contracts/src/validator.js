const fs = require("node:fs");
const path = require("node:path");

const SUPPORTED_KEYWORDS = new Set([
  "$id", "$schema", "type", "required", "properties", "items",
  "enum", "const", "minItems", "minimum", "maximum", "pattern",
  "additionalProperties", "anyOf", "oneOf"
]);
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

function assertSupportedSchema(schema, schemaPath = "$") {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new TypeError(`Schema at ${schemaPath} must be an object`);
  }
  for (const [keyword, value] of Object.entries(schema)) {
    if (!SUPPORTED_KEYWORDS.has(keyword)) {
      throw new TypeError(`Unsupported schema keyword at ${schemaPath}: ${keyword}`);
    }
    if (keyword === "properties") {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError(`Schema properties at ${schemaPath} must be an object`);
      }
      for (const [property, child] of Object.entries(value)) {
        assertSupportedSchema(child, `${schemaPath}.properties.${property}`);
      }
    } else if (keyword === "items") {
      assertSupportedSchema(value, `${schemaPath}.items`);
    } else if (keyword === "additionalProperties" && value && typeof value === "object") {
      assertSupportedSchema(value, `${schemaPath}.additionalProperties`);
    } else if (keyword === "anyOf" || keyword === "oneOf") {
      if (!Array.isArray(value)) throw new TypeError(`Schema ${keyword} at ${schemaPath} must be an array`);
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
  if (expectedType === "object") return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  if (expectedType === "integer") return Number.isInteger(value);
  if (expectedType === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === expectedType;
}

function validateSchema(schema, value, valuePath = "$") {
  const errors = [];
  if (schema.anyOf || schema.oneOf) {
    const alternatives = schema.anyOf || schema.oneOf;
    const matches = alternatives.filter((alternative) => validateSchema(alternative, value, valuePath).length === 0);
    const requiredMatches = schema.oneOf ? 1 : 1;
    if ((schema.oneOf && matches.length !== requiredMatches) || (schema.anyOf && matches.length < requiredMatches)) {
      return [schemaError(valuePath, schema.oneOf ? "oneOf" : "anyOf", "must match an allowed schema")];
    }
    return errors;
  }

  if (schema.type && !typeMatches(value, schema.type)) {
    return [schemaError(valuePath, "type", `must be ${schema.type}`)];
  }
  if (schema.const !== undefined && value !== schema.const) {
    errors.push(schemaError(valuePath, "const", `must equal ${JSON.stringify(schema.const)}`));
  }
  if (schema.enum && !schema.enum.includes(value)) {
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
  if (schema.type === "object" && value && typeof value === "object" && !Array.isArray(value)) {
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
      } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        errors.push(...validateSchema(schema.additionalProperties, value[property], `${valuePath}.${property}`));
      }
    }
  }
  return errors;
}

function phaseReviewErrors(value) {
  if (!value || !["ready_for_user_review", "approved"].includes(value.status)) return [];
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
  if (!value.artifact_hashes || typeof value.artifact_hashes !== "object" || Array.isArray(value.artifact_hashes) || Object.keys(value.artifact_hashes).length === 0) {
    errors.push(schemaError("$.artifact_hashes", "phase_review_evidence", "must contain artifact hashes before user review"));
  }
  return errors;
}

function sortErrors(errors) {
  return errors.sort((left, right) => (
    left.path.localeCompare(right.path)
    || left.code.localeCompare(right.code)
    || left.message.localeCompare(right.message)
  ));
}

function validateContract(name, value) {
  const errors = validateSchema(loadSchema(name), value, "$");
  if (name === "phase-review") errors.push(...phaseReviewErrors(value));
  return { ok: errors.length === 0, errors: sortErrors(errors) };
}

function assertContract(name, value) {
  const result = validateContract(name, value);
  if (!result.ok) {
    const error = new TypeError(`${name} contract validation failed: ${result.errors.map((item) => `${item.path} ${item.code}`).join(", ")}`);
    error.errors = result.errors;
    throw error;
  }
  return value;
}

function validatePhaseApprovalBinding({ phaseReview, attestation } = {}) {
  const errors = [];
  if (phaseReview?.review_packet_hash !== attestation?.review_packet_hash) {
    errors.push(schemaError("$.review_packet_hash", "approval_packet_hash_mismatch", "approval attestation review packet hash must match phase review"));
  }
  if (phaseReview?.journal_revision !== attestation?.target_revision) {
    errors.push(schemaError("$.target_revision", "approval_revision_mismatch", "approval attestation target revision must match phase review journal revision"));
  }
  return { ok: errors.length === 0, errors };
}

module.exports = {
  SCHEMA_NAMES,
  loadSchema,
  validateContract,
  assertContract,
  validatePhaseApprovalBinding
};
