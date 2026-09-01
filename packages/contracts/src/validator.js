const fs = require("node:fs");
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");
const FOUNDATION_AGENT_IDS = require("./foundation-agent-ids");

const SUPPORTED_KEYWORDS = new Set([
  "$id", "$schema", "type", "required", "properties", "items",
  "enum", "const", "minItems", "maxItems", "uniqueItems",
  "minLength", "maxLength", "minimum", "maximum", "pattern",
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
  "role-definition",
  "agent-capability-profile",
  "agent-registry-v3",
  "organization-state-v3",
  "formation-state",
  "organization-agent-placement-persistent-v1",
  "placement-intent",
  "placement-task-state-v3",
  "session-binding-state-v1",
  "task-envelope",
  "context-requirement",
  "source-record",
  "context-pack-v2",
  "context-receipt",
  "project-control-plane",
  "session-handoff-manifest",
  "session-handoff-receipt",
  "project-layout",
  "lifecycle-registry",
  "lifecycle-context-receipt",
  "project-structure-setup",
  "project-structure-context-view",
  "project-structure-migration-plan",
  "placement-request",
  "placement-decision",
  "live-source-query",
  "live-source-result",
  "audition-plan",
  "audition-result",
  "install-approval-target",
  "runtime-evidence",
  "codex-dispatch"
];
const defaultSchemasDir = process.env.ORQUESTA_CONTRACTS_SCHEMA_DIR
  ? path.resolve(process.env.ORQUESTA_CONTRACTS_SCHEMA_DIR)
  : path.resolve(__dirname, "../schemas");

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
    if (["minItems", "maxItems", "minLength", "maxLength"].includes(keyword)
      && (!Number.isInteger(value) || value < 0)) {
      throw new TypeError(`Schema ${keyword} at ${schemaPath} must be a non-negative integer`);
    }
    if (keyword === "uniqueItems" && typeof value !== "boolean") {
      throw new TypeError(`Schema uniqueItems at ${schemaPath} must be boolean`);
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
  if (typeof value === "string") {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) {
      errors.push(schemaError(valuePath, "minLength", `must contain at least ${schema.minLength} character${schema.minLength === 1 ? "" : "s"}`));
    }
    if (schema.maxLength !== undefined && length > schema.maxLength) {
      errors.push(schemaError(valuePath, "maxLength", `must contain at most ${schema.maxLength} character${schema.maxLength === 1 ? "" : "s"}`));
    }
  }
  if (schema.minItems !== undefined && Array.isArray(value) && value.length < schema.minItems) {
    errors.push(schemaError(valuePath, "minItems", `must contain at least ${schema.minItems} item${schema.minItems === 1 ? "" : "s"}`));
  }
  if (schema.maxItems !== undefined && Array.isArray(value) && value.length > schema.maxItems) {
    errors.push(schemaError(valuePath, "maxItems", `must contain at most ${schema.maxItems} item${schema.maxItems === 1 ? "" : "s"}`));
  }
  if (schema.uniqueItems === true && Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (value.slice(0, index).some((entry) => isDeepStrictEqual(entry, value[index]))) {
        errors.push(schemaError(valuePath, "uniqueItems", "must not contain duplicate items"));
        break;
      }
    }
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
  const evidenceCandidateIds = new Set(value.source_evidence
    .filter(isPlainObject)
    .map((evidence) => evidence.candidate_id));
  for (const candidate of [...value.candidates].filter(isPlainObject).sort((left, right) => codeUnitCompare(left.candidate_id, right.candidate_id))) {
    if (!evidenceCandidateIds.has(candidate.candidate_id)) {
      errors.push(schemaError(`$.candidates.${candidate.candidate_id}`, "source_candidate_evidence_missing", "must have exactly one source evidence record"));
    }
  }
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
  const isV2 = value.policy_version === 2;
  const direct = isV2 ? value.execution_mode === "solo_direct" : value.lane === "fast";
  if (isV2 && !["solo_direct", "bounded_parallel", "durable_specialist"].includes(value.execution_mode)) {
    errors.push(schemaError("$.execution_mode", "execution_mode", "is required for policy version 2"));
  }
  if (isV2 && !["light", "normal", "strict"].includes(value.review_intensity)) {
    errors.push(schemaError("$.review_intensity", "review_intensity", "is required for policy version 2"));
  }
  const expectedRouting = direct
    ? { routing_class: "inline_verified", handoff_required: false, specialist_report_required: false }
    : { routing_class: "specialist_required", handoff_required: true, specialist_report_required: true };
  if (["fast", "standard", "critical"].includes(value.lane)
    && !isDeepStrictEqual(value.routing, expectedRouting)) {
    errors.push(schemaError("$.routing", "execution_routing", "must match the lane routing policy"));
  }
  const expectedReviewPolicy = isV2
    ? (value.review_intensity === "light" ? "none" : value.review_intensity === "normal" ? "independent_once" : value.review_intensity === "strict" ? "independent_twice" : null)
    : value.lane === "fast" ? "none"
      : value.lane === "standard" ? "independent_once"
        : value.lane === "critical" ? "independent_twice" : null;
  if (expectedReviewPolicy && value.review_policy !== expectedReviewPolicy) {
    errors.push(schemaError("$.review_policy", "execution_review_policy", "must match the lane review policy"));
  }
  return errors;
}

function uniqueRecordIds(value, field, pathValue, errors) {
  if (!Array.isArray(value)) return;
  const seen = new Set();
  for (const record of value) {
    const id = record && record[field];
    if (typeof id !== "string" || seen.has(id)) {
      errors.push(schemaError(pathValue, "organization_unique_id", "must contain unique record ids"));
      return;
    }
    seen.add(id);
  }
}

function sortedUniqueRefs(values) {
  return Array.isArray(values) && values.every((value, index) => {
    if (!isPlainObject(value) || typeof value.kind !== "string" || typeof value.id !== "string") return false;
    if (index === 0) return true;
    const previous = values[index - 1];
    return codeUnitCompare(previous.kind, value.kind) < 0
      || (previous.kind === value.kind && codeUnitCompare(previous.id, value.id) < 0);
  });
}

function agentRegistryV3Errors(value) {
  if (!isPlainObject(value)) return [];
  const errors = [];
  const seen = new Set();
  const provenanceKinds = {
    foundation: new Set(["project_bootstrap"]),
    workflow: new Set(["workflow_run"]),
    inspection: new Set(["inspection"]),
    user: new Set(["user"]),
    controller: new Set(["task", "organization_decision"])
  };
  const agents = Array.isArray(value.agents) ? value.agents : [];
  for (const agent of agents) {
    if (!isPlainObject(agent) || typeof agent.agent_id !== "string" || seen.has(agent.agent_id)) {
      errors.push(schemaError("$.agents", "agent_registry_unique_id", "must contain unique agent ids"));
      break;
    }
    seen.add(agent.agent_id);
    if (agent.mission === null) {
      errors.push(schemaError(`$.agents.${agent.agent_id}.mission`, "agent_registry_mission", "operational v3 agents require a mission"));
    }
    if (!Array.isArray(agent.context_scope) || agent.context_scope.length === 0) {
      errors.push(schemaError(`$.agents.${agent.agent_id}.context_scope`, "agent_registry_context_scope", "operational v3 agents require a context scope"));
    }
    if (agent.origin === null) {
      errors.push(schemaError(`$.agents.${agent.agent_id}.origin`, "agent_registry_origin", "operational v3 agents require an origin"));
    }
    if (agent.created_from_ref === null) {
      errors.push(schemaError(`$.agents.${agent.agent_id}.created_from_ref`, "agent_registry_created_from_ref", "operational v3 agents require creation provenance"));
    }
    if (agent.origin !== null && agent.created_from_ref !== null
      && !provenanceKinds[agent.origin]?.has(agent.created_from_ref?.kind)) {
      errors.push(schemaError(`$.agents.${agent.agent_id}.created_from_ref`, "agent_registry_provenance_compatibility", "agent origin and creation provenance must describe the same authority path"));
    }
    if (agent.retired_at !== null && !isValidUtcTimestamp(agent.retired_at)) {
      errors.push(schemaError(`$.agents.${agent.agent_id}.retired_at`, "timestamp", "must be a valid UTC timestamp"));
    }
    if (agent.lifecycle_state === "retired" && agent.retired_at === null) {
      errors.push(schemaError(`$.agents.${agent.agent_id}.retired_at`, "agent_registry_retirement", "retired agents require retired_at"));
    }
    if (agent.lifecycle_state !== "retired" && agent.retired_at !== null) {
      errors.push(schemaError(`$.agents.${agent.agent_id}.retired_at`, "agent_registry_retirement", "non-retired agents cannot have retired_at"));
    }
    if (!sortedUnique(agent.context_scope)) {
      errors.push(schemaError(`$.agents.${agent.agent_id}.context_scope`, "sorted_unique", "must be sorted with no duplicate entries"));
    }
  }
  return errors;
}

function organizationStateV3Errors(value) {
  if (!isPlainObject(value)) return [];
  const errors = [];
  for (const [field, id] of [["participants", "participant_id"], ["lines", "line_id"], ["teams", "team_id"], ["memberships", "membership_id"], ["relationships", "relationship_id"]]) {
    uniqueRecordIds(value[field], id, `$.${field}`, errors);
  }
  if (errors.length > 0) return errors;
  const participantRecords = Array.isArray(value.participants) ? value.participants : [];
  const lineRecords = Array.isArray(value.lines) ? value.lines : [];
  const teamRecords = Array.isArray(value.teams) ? value.teams : [];
  const membershipRecords = Array.isArray(value.memberships) ? value.memberships : [];
  const relationshipRecords = Array.isArray(value.relationships) ? value.relationships : [];
  const decisionIds = Array.isArray(value.applied_decision_ids) ? value.applied_decision_ids : [];
  const decisionBindings = Array.isArray(value.applied_decision_bindings) ? value.applied_decision_bindings : [];
  const participants = new Map(participantRecords.map((item) => [item.participant_id, item]));
  const lines = new Map(lineRecords.map((item) => [item.line_id, item]));
  const teams = new Map(teamRecords.map((item) => [item.team_id, item]));
  const activeMemberships = membershipRecords.filter((item) => item.active_to === null);
  const activeAgentTeamKeys = new Set();
  const activeTeamOrdinalKeys = new Set();
  if (!sortedUnique(value.applied_decision_ids)) {
    errors.push(schemaError("$.applied_decision_ids", "sorted_unique", "must be sorted with no duplicate entries"));
  }
  uniqueRecordIds(value.applied_decision_bindings, "decision_id", "$.applied_decision_bindings", errors);
  if (!sortedUniqueBy(value.applied_decision_bindings, "decision_id")) {
    errors.push(schemaError("$.applied_decision_bindings", "sorted_unique", "must be sorted by decision_id with no duplicates"));
  }
  const boundDecisionIds = new Set(decisionBindings.map((binding) => binding.decision_id));
  for (const decisionId of decisionIds) {
    if (!boundDecisionIds.has(decisionId)) {
      errors.push(schemaError(`$.applied_decision_ids.${decisionId}`, "organization_v3_decision_binding_missing", "every applied decision id requires a canonical content binding"));
    }
  }
  for (const decisionId of boundDecisionIds) {
    if (!decisionIds.includes(decisionId)) {
      errors.push(schemaError(`$.applied_decision_bindings.${decisionId}`, "organization_v3_decision_binding_reference", "decision bindings must reference an applied decision id"));
    }
  }
  for (const participant of participantRecords) {
    if (participant.joined_at !== null && !isValidUtcTimestamp(participant.joined_at)) {
      errors.push(schemaError(`$.participants.${participant.participant_id}.joined_at`, "timestamp", "must be a valid UTC timestamp"));
    }
  }
  for (const line of lines.values()) {
    if (line.owner_ref?.kind === "participant" && !participants.has(line.owner_ref.id)) {
      errors.push(schemaError(`$.lines.${line.line_id}.owner_ref`, "organization_v3_owner_reference", "participant owner must exist"));
    }
    if (line.status === "active" && line.owner_ref?.kind === "participant"
      && participants.get(line.owner_ref.id)?.lifecycle_state !== "active") {
      errors.push(schemaError(`$.lines.${line.line_id}.owner_ref`, "organization_v3_active_line_owner_state", "an active line requires an active participant owner"));
    }
    for (const field of ["deliverable_ids", "completion_root_ids", "scope"]) {
      if (!sortedUnique(line[field])) {
        errors.push(schemaError(`$.lines.${line.line_id}.${field}`, "sorted_unique", "must be sorted with no duplicate entries"));
      }
    }
  }
  for (const team of teams.values()) {
    if (team.line_id !== null && !lines.has(team.line_id)) {
      errors.push(schemaError(`$.teams.${team.team_id}.line_id`, "organization_v3_team_line_reference", "team line must exist"));
    }
    if (team.lifecycle_state === "active" && team.line_id !== null && lines.get(team.line_id)?.status === "retired") {
      errors.push(schemaError(`$.teams.${team.team_id}.line_id`, "organization_v3_active_team_line_state", "an active team cannot belong to a retired line"));
    }
    const members = activeMemberships.filter((item) => item.team_id === team.team_id);
    const leads = members.filter((item) => item.position === "lead");
    if (team.coordination_mode === "peer" && (team.lead_agent_id !== null || leads.length > 0)) {
      errors.push(schemaError(`$.teams.${team.team_id}`, "organization_v3_peer_lead", "peer teams cannot have a fixed lead"));
    }
    if (team.coordination_mode === "supervised"
      && (team.lead_agent_id === null || leads.length !== 1 || leads[0].agent_id !== team.lead_agent_id)) {
      errors.push(schemaError(`$.teams.${team.team_id}`, "organization_v3_supervised_lead", "supervised teams require exactly one matching active lead"));
    }
    if (team.coordination_mode === "workflow_managed"
      && (leads.length > 1 || (team.lead_agent_id !== null && (leads.length !== 1 || leads[0].agent_id !== team.lead_agent_id)))) {
      errors.push(schemaError(`$.teams.${team.team_id}`, "organization_v3_workflow_lead", "workflow-managed team lead must be absent or match one active lead"));
    }
  }
  for (const membership of membershipRecords) {
    if (!teams.has(membership.team_id)) {
      errors.push(schemaError(`$.memberships.${membership.membership_id}.team_id`, "organization_v3_membership_team_reference", "membership team must exist"));
    }
    if (!isValidUtcTimestamp(membership.active_from)) {
      errors.push(schemaError(`$.memberships.${membership.membership_id}.active_from`, "timestamp", "must be a valid UTC timestamp"));
    }
    if (membership.active_to !== null && !isValidUtcTimestamp(membership.active_to)) {
      errors.push(schemaError(`$.memberships.${membership.membership_id}.active_to`, "timestamp", "must be a valid UTC timestamp"));
    }
    if (isValidUtcTimestamp(membership.active_from)
      && membership.active_to !== null
      && isValidUtcTimestamp(membership.active_to)
      && membership.active_to < membership.active_from) {
      errors.push(schemaError(`$.memberships.${membership.membership_id}.active_to`, "organization_v3_membership_chronology", "active_to must not precede active_from"));
    }
    if (membership.active_to === null) {
      const team = teams.get(membership.team_id);
      if (team && team.lifecycle_state !== "active") {
        errors.push(schemaError(`$.memberships.${membership.membership_id}.team_id`, "organization_v3_active_membership_team_state", "an active membership requires an active team"));
      }
      const agentTeamKey = `${membership.agent_id}\u0000${membership.team_id}`;
      if (activeAgentTeamKeys.has(agentTeamKey)) {
        errors.push(schemaError(`$.memberships.${membership.membership_id}`, "organization_v3_active_agent_team_unique", "an agent can have at most one active membership in a team"));
      }
      activeAgentTeamKeys.add(agentTeamKey);
      const teamOrdinalKey = `${membership.team_id}\u0000${membership.ordinal}`;
      if (activeTeamOrdinalKeys.has(teamOrdinalKey)) {
        errors.push(schemaError(`$.memberships.${membership.membership_id}`, "organization_v3_active_team_ordinal_unique", "active membership ordinals must be unique within a team"));
      }
      activeTeamOrdinalKeys.add(teamOrdinalKey);
    }
  }
  const reportsTo = new Map();
  const relationshipSignatures = new Set();
  for (const relationship of relationshipRecords) {
    const signature = `${relationship.type}\u0000${relationship.subject_ref?.kind}\u0000${relationship.subject_ref?.id}\u0000${relationship.object_ref?.kind}\u0000${relationship.object_ref?.id}`;
    if (relationshipSignatures.has(signature)) {
      errors.push(schemaError(`$.relationships.${relationship.relationship_id}`, "organization_v3_relationship_semantic_unique", "semantically identical relationships must not be duplicated under different ids"));
    }
    relationshipSignatures.add(signature);
    for (const [field, ref] of [["subject_ref", relationship.subject_ref], ["object_ref", relationship.object_ref]]) {
      const exists = ref?.kind === "participant" ? participants.has(ref.id)
        : ref?.kind === "line" ? lines.has(ref.id)
          : ref?.kind === "team" ? teams.has(ref.id)
            : true;
      if (!exists) {
        errors.push(schemaError(`$.relationships.${relationship.relationship_id}.${field}`, "organization_v3_relationship_reference", "participant, line, and team relationship references must exist in organization-state-v3"));
      } else {
        const current = ref?.kind === "participant" ? participants.get(ref.id)?.lifecycle_state === "active"
          : ref?.kind === "line" ? lines.get(ref.id)?.status !== "retired"
            : ref?.kind === "team" ? teams.get(ref.id)?.lifecycle_state === "active"
              : true;
        if (!current) {
          errors.push(schemaError(`$.relationships.${relationship.relationship_id}.${field}`, "organization_v3_relationship_endpoint_state", "current relationships cannot reference inactive or retired organization records"));
        }
      }
    }
    if (relationship.type !== "reports_to") continue;
    if (relationship.subject_ref?.kind !== "agent" || relationship.object_ref?.kind !== "agent") {
      errors.push(schemaError(`$.relationships.${relationship.relationship_id}`, "organization_v3_reports_to_kind", "reports_to must connect agent to agent"));
      continue;
    }
    const subjectId = relationship.subject_ref.id;
    if (!reportsTo.has(subjectId)) reportsTo.set(subjectId, []);
    reportsTo.get(subjectId).push(relationship.object_ref.id);
  }
  for (const [agentId, targets] of reportsTo.entries()) {
    if (targets.length > 1) {
      errors.push(schemaError(`$.relationships.${agentId}`, "organization_v3_reports_to_unique", "an agent can have at most one reports_to relationship"));
    }
  }
  const visiting = new Set();
  const visited = new Set();
  let cycleFound = false;
  function visitReportsTo(agentId) {
    if (visiting.has(agentId)) {
      cycleFound = true;
      return;
    }
    if (visited.has(agentId)) return;
    visiting.add(agentId);
    for (const targetId of reportsTo.get(agentId) || []) visitReportsTo(targetId);
    visiting.delete(agentId);
    visited.add(agentId);
  }
  for (const agentId of reportsTo.keys()) visitReportsTo(agentId);
  if (cycleFound) {
    errors.push(schemaError("$.relationships", "organization_v3_reports_to_cycle", "reports_to relationships must be acyclic"));
  }
  return errors;
}

function formationStateErrors(value) {
  if (!isPlainObject(value)) return [];
  const errors = [];
  const seen = new Set();
  const sourceSignatures = new Set();
  const formations = Array.isArray(value.formations) ? value.formations : [];
  for (const formation of formations) {
    if (!isPlainObject(formation) || typeof formation.formation_id !== "string" || seen.has(formation.formation_id)) {
      errors.push(schemaError("$.formations", "formation_unique_id", "must contain unique formation ids"));
      break;
    }
    seen.add(formation.formation_id);
    const sourceSignature = `${formation.formation_kind}\u0000${formation.source_ref?.kind}\u0000${formation.source_ref?.id}`;
    if (sourceSignatures.has(sourceSignature)) {
      errors.push(schemaError(`$.formations.${formation.formation_id}.source_ref`, "formation_source_unique", "one formation kind and source can identify at most one formation"));
    }
    sourceSignatures.add(sourceSignature);
    if ((formation.formation_kind === "work_cell" && formation.source_ref?.kind !== "workflow_run")
      || (formation.formation_kind === "inspection" && formation.source_ref?.kind !== "task")) {
      errors.push(schemaError(`$.formations.${formation.formation_id}.source_ref`, "formation_source_kind", "formation kind and source kind must describe the same execution path"));
    }
    if (formation.formation_kind === "work_cell" && (formation.target_refs || []).length !== 0) {
      errors.push(schemaError(`$.formations.${formation.formation_id}.target_refs`, "formation_workflow_targets", "work cells do not carry inspection targets"));
    }
    if (formation.formation_kind === "inspection" && (formation.target_refs || []).length === 0) {
      errors.push(schemaError(`$.formations.${formation.formation_id}.target_refs`, "formation_inspection_targets", "inspection formations require at least one target"));
    }
    if (!sortedUnique(formation.member_agent_ids)) {
      errors.push(schemaError(`$.formations.${formation.formation_id}.member_agent_ids`, "sorted_unique", "must be sorted with no duplicate entries"));
    }
    if (!sortedUniqueRefs(formation.target_refs)) {
      errors.push(schemaError(`$.formations.${formation.formation_id}.target_refs`, "sorted_unique", "must be sorted by kind and id with no duplicate entries"));
    }
    if (formation.coordination_mode === "peer" && formation.lead_agent_id !== null) {
      errors.push(schemaError(`$.formations.${formation.formation_id}`, "formation_peer_lead", "peer formations cannot have a fixed lead"));
    }
    if (formation.coordination_mode === "supervised"
      && (formation.lead_agent_id === null || !formation.member_agent_ids?.includes(formation.lead_agent_id))) {
      errors.push(schemaError(`$.formations.${formation.formation_id}`, "formation_supervised_lead", "supervised formations require a member lead"));
    }
    if (formation.lead_agent_id !== null && !formation.member_agent_ids?.includes(formation.lead_agent_id)) {
      errors.push(schemaError(`$.formations.${formation.formation_id}.lead_agent_id`, "formation_lead_membership", "formation lead must be a member"));
    }
    if (formation.formation_kind === "inspection" && (!Array.isArray(formation.target_refs) || formation.target_refs.length === 0)) {
      errors.push(schemaError(`$.formations.${formation.formation_id}.target_refs`, "formation_inspection_target", "inspection formations require at least one target"));
    }
    if (!isValidUtcTimestamp(formation.created_at)) {
      errors.push(schemaError(`$.formations.${formation.formation_id}.created_at`, "timestamp", "must be a valid UTC timestamp"));
    }
    if (formation.lifecycle_state === "retired" && !isValidUtcTimestamp(formation.retired_at)) {
      errors.push(schemaError(`$.formations.${formation.formation_id}.retired_at`, "formation_retirement", "retired formations require retired_at"));
    }
    if (formation.lifecycle_state !== "retired" && formation.retired_at !== null) {
      errors.push(schemaError(`$.formations.${formation.formation_id}.retired_at`, "formation_retirement", "active formations cannot have retired_at"));
    }
    if (isValidUtcTimestamp(formation.created_at)
      && formation.retired_at !== null
      && isValidUtcTimestamp(formation.retired_at)
      && formation.retired_at < formation.created_at) {
      errors.push(schemaError(`$.formations.${formation.formation_id}.retired_at`, "formation_retirement_chronology", "retired_at must not precede created_at"));
    }
  }
  return errors;
}

function placementIntentErrors(value) {
  if (!isPlainObject(value)) return [];
  return phase2ArrayErrors(value, ["capability_needs"]);
}

const SESSION_BINDING_LIFECYCLE = Object.freeze({
  active: Object.freeze({ ownership: "owner", handoff: "accepted", bindings: Object.freeze(["bound"]), accepts: true, acceptedEvidence: true, runtimeAuthority: "required", replacedBy: "none", ownershipWindow: "open" }),
  rotation_preparing: Object.freeze({ ownership: "owner", handoff: "accepted", bindings: Object.freeze(["bound"]), accepts: true, acceptedEvidence: true, runtimeAuthority: "required", replacedBy: "none", ownershipWindow: "open" }),
  rotation_pending: Object.freeze({ ownership: "owner", handoff: "accepted", bindings: Object.freeze(["bound"]), accepts: true, acceptedEvidence: true, runtimeAuthority: "required", replacedBy: "none", ownershipWindow: "open" }),
  rotation_required: Object.freeze({ ownership: "owner", handoff: "accepted", bindings: Object.freeze(["bound"]), accepts: false, acceptedEvidence: true, runtimeAuthority: "required", replacedBy: "none", ownershipWindow: "open" }),
  draining: Object.freeze({ ownership: "owner", handoff: "accepted", bindings: Object.freeze(["bound"]), accepts: false, acceptedEvidence: true, runtimeAuthority: "required", replacedBy: "none", ownershipWindow: "open" }),
  checkpointed: Object.freeze({ ownership: "owner", handoff: "accepted", bindings: Object.freeze(["bound"]), accepts: false, acceptedEvidence: true, runtimeAuthority: "required", replacedBy: "none", ownershipWindow: "open" }),
  successor_warming: Object.freeze({ ownership: "candidate", handoff: "pending", bindings: Object.freeze(["provisioning"]), accepts: false, acceptedEvidence: false, runtimeAuthority: "null", replacedBy: "none", ownershipWindow: "none" }),
  successor_verified: Object.freeze({ ownership: "candidate", handoff: "accepted", bindings: Object.freeze(["bound"]), accepts: false, acceptedEvidence: true, runtimeAuthority: "required", replacedBy: "none", ownershipWindow: "none" }),
  superseded: Object.freeze({ ownership: "superseded", handoff: "accepted", bindings: Object.freeze(["bound"]), accepts: false, acceptedEvidence: true, runtimeAuthority: "required", replacedBy: "required", ownershipWindow: "closed" }),
  failed: Object.freeze({ ownership: "candidate", handoff: "failed", bindings: Object.freeze(["authority_unverified", "conflict"]), accepts: false, acceptedEvidence: false, runtimeAuthority: "null", replacedBy: "none", ownershipWindow: "none" }),
  // `retired` is the single non-rotation terminal. It preserves accepted thread/runtime
  // evidence while closing ownership without inventing a replacement session.
  retired: Object.freeze({ ownership: "retired", handoff: "accepted", bindings: Object.freeze(["bound"]), accepts: false, acceptedEvidence: true, runtimeAuthority: "required", replacedBy: "none", ownershipWindow: "closed" })
});

function sessionBindingLifecycleErrors(session, basePath) {
  const errors = [];
  const lifecycle = SESSION_BINDING_LIFECYCLE[session.rotation_state];
  if (!lifecycle) return errors;
  if (session.ownership_status !== lifecycle.ownership
    || session.handoff_status !== lifecycle.handoff
    || !lifecycle.bindings.includes(session.binding_status)
    || session.accepts_new_work !== lifecycle.accepts) {
    errors.push(schemaError(basePath, "session_binding_lifecycle_matrix", "ownership, handoff, binding, and work authority must match rotation_state"));
  }
  if (typeof session.thread_id !== "string") {
    errors.push(schemaError(`${basePath}.thread_id`, "session_binding_thread_required", "every persisted session lifecycle row requires a thread binding"));
  }
  if (session.session_generation === 1 && session.replaces_session_id !== null) {
    errors.push(schemaError(`${basePath}.replaces_session_id`, "session_binding_initial_lineage", "generation one is an initial binding and cannot replace another session"));
  }
  if (session.session_generation === 1 && lifecycle.ownership === "candidate") {
    errors.push(schemaError(basePath, "session_binding_initial_candidate", "generation one must be an accepted owner lineage, not a rotation attempt"));
  }
  if (session.session_generation > 1 && session.replaces_session_id === null) {
    errors.push(schemaError(`${basePath}.replaces_session_id`, "session_binding_successor_lineage", "every generation after one requires predecessor lineage"));
  }
  if (lifecycle.replacedBy === "required" && session.replaced_by_session_id === null) {
    errors.push(schemaError(`${basePath}.replaced_by_session_id`, "session_binding_superseded_successor", "superseded session must name its active successor"));
  }
  if (lifecycle.replacedBy === "none" && session.replaced_by_session_id !== null) {
    errors.push(schemaError(`${basePath}.replaced_by_session_id`, "session_binding_cutover_state", "only an atomically superseded predecessor may name its successor"));
  }
  const provenance = [session.provisioning_request_id, session.placement_intent_id, session.task_id];
  const hasPlacementProvenance = provenance.every((item) => typeof item === "string");
  const hasNoPlacementProvenance = provenance.every((item) => item === null);
  if (!hasPlacementProvenance && !hasNoPlacementProvenance) {
    errors.push(schemaError(basePath, "session_binding_placement_provenance_partial", "placement request, intent, and task provenance must be all present or all null"));
  }
  if (session.session_generation === 1) {
    const reservedFoundation = FOUNDATION_AGENT_IDS.includes(session.agent_id);
    const canonicalFoundation = reservedFoundation && session.profile_id === `foundation:${session.agent_id}:v1`;
    const claimsFoundationNamespace = typeof session.profile_id === "string" && session.profile_id.startsWith("foundation:");
    if (reservedFoundation && (!canonicalFoundation || !hasNoPlacementProvenance)) {
      errors.push(schemaError(basePath, "session_binding_foundation_identity", "reserved foundation agents require their exact foundation profile and cannot claim placement provenance"));
    } else if (!reservedFoundation && claimsFoundationNamespace) {
      errors.push(schemaError(`${basePath}.profile_id`, "session_binding_foundation_namespace", "foundation profile namespace is reserved for canonical foundation agents"));
    } else if (!reservedFoundation && !hasPlacementProvenance) {
      errors.push(schemaError(basePath, "session_binding_placement_provenance_required", "nonfoundation initial bindings require exact placement provenance"));
    }
  }

  const hasAcceptedEvidence = typeof session.thread_id === "string"
    && typeof session.handoff_turn_id === "string"
    && isValidUtcTimestamp(session.accepted_at);
  if (lifecycle.acceptedEvidence && !hasAcceptedEvidence) {
    errors.push(schemaError(basePath, "session_binding_accepted_evidence", "accepted lifecycle requires thread_id, handoff_turn_id, and a valid accepted_at timestamp"));
  }
  if (!lifecycle.acceptedEvidence && (session.handoff_turn_id !== null || session.accepted_at !== null)) {
    errors.push(schemaError(basePath, "session_binding_unaccepted_evidence", "pending or failed lifecycle cannot carry accepted turn or timestamp evidence"));
  }
  if (session.accepted_at !== null && !isValidUtcTimestamp(session.accepted_at)) {
    errors.push(schemaError(`${basePath}.accepted_at`, "timestamp", "must be a real UTC timestamp"));
  }
  if (!isValidUtcTimestamp(session.created_at) || !isValidUtcTimestamp(session.updated_at)) {
    errors.push(schemaError(basePath, "session_binding_timestamp", "created_at and updated_at must be real UTC timestamps"));
  } else {
    if (session.updated_at < session.created_at) {
      errors.push(schemaError(`${basePath}.updated_at`, "session_binding_update_chronology", "updated_at must not precede created_at"));
    }
    if (lifecycle.acceptedEvidence && isValidUtcTimestamp(session.accepted_at)
      && (session.accepted_at < session.created_at || session.accepted_at > session.updated_at)) {
      errors.push(schemaError(`${basePath}.accepted_at`, "session_binding_acceptance_chronology", "accepted_at must fall between created_at and updated_at"));
    }
  }
  if (lifecycle.runtimeAuthority === "required" && typeof session.runtime_authority_id !== "string") {
    errors.push(schemaError(`${basePath}.runtime_authority_id`, "session_binding_runtime_authority", "accepted binding requires runtime authority evidence"));
  }
  if (lifecycle.runtimeAuthority === "null" && session.runtime_authority_id !== null) {
    errors.push(schemaError(`${basePath}.runtime_authority_id`, "session_binding_unaccepted_authority", "pending and failed sessions cannot claim runtime authority"));
  }
  const ownershipStarted = isValidUtcTimestamp(session.ownership_started_at);
  const ownershipEnded = isValidUtcTimestamp(session.ownership_ended_at);
  if (lifecycle.ownershipWindow === "none"
    && (session.ownership_started_at !== null || session.ownership_ended_at !== null)) {
    errors.push(schemaError(basePath, "session_binding_ownership_window", "candidate sessions cannot claim an ownership interval"));
  }
  if (lifecycle.ownershipWindow === "open"
    && (!ownershipStarted || session.ownership_ended_at !== null)) {
    errors.push(schemaError(basePath, "session_binding_ownership_window", "current owner requires a started and open ownership interval"));
  }
  if (lifecycle.ownershipWindow === "closed"
    && (!ownershipStarted || !ownershipEnded)) {
    errors.push(schemaError(basePath, "session_binding_ownership_window", "terminal owner history requires a closed ownership interval"));
  }
  if (ownershipStarted && isValidUtcTimestamp(session.accepted_at)
    && session.ownership_started_at < session.accepted_at) {
    errors.push(schemaError(`${basePath}.ownership_started_at`, "session_binding_ownership_chronology", "ownership cannot begin before accepted handoff evidence"));
  }
  if (ownershipStarted && isValidUtcTimestamp(session.created_at)
    && session.ownership_started_at < session.created_at) {
    errors.push(schemaError(`${basePath}.ownership_started_at`, "session_binding_ownership_chronology", "ownership cannot begin before the session row exists"));
  }
  if (ownershipStarted && ownershipEnded && session.ownership_ended_at <= session.ownership_started_at) {
    errors.push(schemaError(`${basePath}.ownership_ended_at`, "session_binding_ownership_chronology", "ownership must end after it begins"));
  }
  if (ownershipStarted && isValidUtcTimestamp(session.updated_at)
    && session.ownership_started_at > session.updated_at) {
    errors.push(schemaError(`${basePath}.ownership_started_at`, "session_binding_ownership_chronology", "ownership start cannot follow the row update timestamp"));
  }
  if (ownershipEnded && session.ownership_ended_at !== session.updated_at) {
    errors.push(schemaError(`${basePath}.ownership_ended_at`, "session_binding_ownership_chronology", "terminal row update must be the immutable ownership end timestamp"));
  }
  return errors;
}

function sessionBindingStateV1Errors(value) {
  if (!isPlainObject(value) || !Array.isArray(value.sessions)) return [];
  const errors = [];
  const sessionsById = new Map();
  const generationsByAgent = new Map();
  const threadOwners = new Map();
  const ownersByAgent = new Map();
  const activeAgents = new Set();
  const liveCandidatesByPredecessor = new Map();
  const retryChildrenByFailedAttempt = new Map();
  const initialFailedAttemptsByLineage = new Map();
  const attemptsByLineage = new Map();
  const activeRuntimeAuthorities = new Set();
  const initialRequestOwners = new Map();
  const initialTaskOwners = new Map();

  const sessionKey = (session) => [session.agent_id, session.session_generation, session.session_id];
  const ordered = [...value.sessions].sort((left, right) => {
    const leftKey = sessionKey(left);
    const rightKey = sessionKey(right);
    return codeUnitCompare(String(leftKey[0]), String(rightKey[0]))
      || Number(leftKey[1]) - Number(rightKey[1])
      || codeUnitCompare(String(leftKey[2]), String(rightKey[2]));
  });
  if (!isDeepStrictEqual(value.sessions, ordered)) {
    errors.push(schemaError("$.sessions", "session_binding_sorted", "sessions must be sorted by agent_id, session_generation, and session_id"));
  }

  for (const [index, session] of value.sessions.entries()) {
    if (!isPlainObject(session)) continue;
    const basePath = `$.sessions[${index}]`;
    if (sessionsById.has(session.session_id)) {
      errors.push(schemaError(`${basePath}.session_id`, "session_binding_session_id_unique", "session_id must be unique"));
    } else {
      sessionsById.set(session.session_id, session);
    }

    if (session.rotation_state !== "failed") {
      const generations = generationsByAgent.get(session.agent_id) || new Set();
      if (generations.has(session.session_generation)) {
        errors.push(schemaError(`${basePath}.session_generation`, "session_binding_generation_unique", "each agent can have only one nonfailed session for a generation"));
      }
      generations.add(session.session_generation);
      generationsByAgent.set(session.agent_id, generations);
    }

    if (typeof session.thread_id === "string") {
      const prior = threadOwners.get(session.thread_id);
      if (prior && prior !== session.session_id) {
        errors.push(schemaError(`${basePath}.thread_id`, "session_binding_thread_unique", "thread_id must not bind more than one session"));
      } else {
        threadOwners.set(session.thread_id, session.session_id);
      }
    }

    const accepted = session.handoff_status === "accepted";
    errors.push(...sessionBindingLifecycleErrors(session, basePath));
    if (session.session_generation === 1 && session.replaces_session_id === null) {
      if (typeof session.provisioning_request_id === "string") {
        const prior = initialRequestOwners.get(session.provisioning_request_id);
        if (prior && prior !== session.session_id) {
          errors.push(schemaError(`${basePath}.provisioning_request_id`, "session_binding_request_unique", "one placement request cannot create multiple initial sessions"));
        } else {
          initialRequestOwners.set(session.provisioning_request_id, session.session_id);
        }
      }
      if (typeof session.task_id === "string") {
        const prior = initialTaskOwners.get(session.task_id);
        if (prior && prior !== session.session_id) {
          errors.push(schemaError(`${basePath}.task_id`, "session_binding_task_unique", "one placement task cannot create multiple initial sessions"));
        } else {
          initialTaskOwners.set(session.task_id, session.session_id);
        }
      }
    }

    const isBoundNonterminal = accepted
      && session.binding_status === "bound"
      && !["superseded", "failed", "retired"].includes(session.rotation_state);
    if (isBoundNonterminal) {
      activeAgents.add(session.agent_id);
      if (typeof session.runtime_authority_id === "string") activeRuntimeAuthorities.add(session.runtime_authority_id);
    }
    if (session.ownership_status === "owner") {
      const owners = ownersByAgent.get(session.agent_id) || [];
      owners.push(session.session_id);
      ownersByAgent.set(session.agent_id, owners);
    }
    if (["successor_warming", "successor_verified"].includes(session.rotation_state)
      && session.replaces_session_id !== null) {
      const candidates = liveCandidatesByPredecessor.get(session.replaces_session_id) || [];
      candidates.push(session.session_id);
      liveCandidatesByPredecessor.set(session.replaces_session_id, candidates);
    }
    if (session.retry_of_session_id !== null) {
      const children = retryChildrenByFailedAttempt.get(session.retry_of_session_id) || [];
      children.push(session.session_id);
      retryChildrenByFailedAttempt.set(session.retry_of_session_id, children);
    } else if (session.rotation_state === "failed" && session.replaces_session_id !== null) {
      const key = `${session.agent_id}\u0000${session.session_generation}\u0000${session.replaces_session_id}`;
      const roots = initialFailedAttemptsByLineage.get(key) || [];
      roots.push(session.session_id);
      initialFailedAttemptsByLineage.set(key, roots);
    }
    if (session.replaces_session_id !== null) {
      const key = `${session.agent_id}\u0000${session.session_generation}\u0000${session.replaces_session_id}`;
      const attempts = attemptsByLineage.get(key) || [];
      attempts.push(session);
      attemptsByLineage.set(key, attempts);
    }
  }

  for (const agentId of activeAgents) {
    if ((ownersByAgent.get(agentId) || []).length !== 1) {
      errors.push(schemaError("$.sessions", "session_binding_owner_unique", `agent ${agentId} must have exactly one current owner`));
    }
  }
  if (activeRuntimeAuthorities.size > 1) {
    errors.push(schemaError("$.sessions", "session_binding_runtime_authority_unique", "all nonterminal accepted bindings in one project must share one runtime authority"));
  }
  for (const [predecessorId, candidates] of liveCandidatesByPredecessor) {
    if (candidates.length > 1) {
      errors.push(schemaError("$.sessions", "session_binding_candidate_unique", `predecessor ${predecessorId} has more than one nonfailed successor candidate`));
    }
  }
  for (const [failedAttemptId, retries] of retryChildrenByFailedAttempt) {
    if (retries.length > 1) {
      errors.push(schemaError("$.sessions", "session_binding_retry_branch", `failed attempt ${failedAttemptId} has more than one direct retry`));
    }
  }
  for (const [lineage, roots] of initialFailedAttemptsByLineage) {
    if (roots.length > 1) {
      errors.push(schemaError("$.sessions", "session_binding_retry_root_unique", `replacement lineage ${lineage} has more than one initial failed attempt`));
    }
  }
  for (const [lineage, attempts] of attemptsByLineage) {
    if (!attempts.some((session) => session.rotation_state === "failed")) continue;
    const roots = attempts.filter((session) => session.retry_of_session_id === null);
    if (roots.length !== 1 || roots[0].rotation_state !== "failed") {
      errors.push(schemaError("$.sessions", "session_binding_retry_lineage", `replacement lineage ${lineage} must be one unbranched chain rooted at its first failed attempt`));
    }
  }

  for (const [index, session] of value.sessions.entries()) {
    if (!isPlainObject(session)) continue;
    const basePath = `$.sessions[${index}]`;
    if (session.replaces_session_id !== null) {
      const predecessor = sessionsById.get(session.replaces_session_id);
      if (!predecessor) {
        errors.push(schemaError(`${basePath}.replaces_session_id`, "session_binding_replacement_reference", "replaced session must exist"));
      } else {
        if (predecessor.agent_id !== session.agent_id) {
          errors.push(schemaError(`${basePath}.replaces_session_id`, "session_binding_replacement_agent", "replacement links must stay within one agent"));
        }
        if (predecessor.provisioning_request_id !== session.provisioning_request_id
          || predecessor.placement_intent_id !== session.placement_intent_id
          || predecessor.task_id !== session.task_id) {
          errors.push(schemaError(`${basePath}.replaces_session_id`, "session_binding_replacement_provenance", "replacement lineage must preserve immutable placement provenance"));
        }
        if (typeof predecessor.runtime_authority_id === "string"
          && typeof session.runtime_authority_id === "string"
          && predecessor.runtime_authority_id !== session.runtime_authority_id) {
          errors.push(schemaError(`${basePath}.runtime_authority_id`, "session_binding_replacement_runtime_authority", "replacement lineage cannot cross runtime authority"));
        }
        if (session.session_generation !== predecessor.session_generation + 1) {
          errors.push(schemaError(`${basePath}.session_generation`, "session_binding_replacement_generation", "successor generation must be exactly predecessor generation plus one"));
        }
        if (session.rotation_state === "failed"
          && ["superseded", "retired"].includes(predecessor.ownership_status)) {
          if (!isValidUtcTimestamp(session.updated_at)
            || !isValidUtcTimestamp(predecessor.ownership_ended_at)
            || session.updated_at >= predecessor.ownership_ended_at) {
            errors.push(schemaError(`${basePath}.updated_at`, "session_binding_failed_attempt_chronology", "a retained failed attempt must finish before its predecessor ownership ends"));
          }
        } else if (predecessor.replaced_by_session_id === null) {
          if (isValidUtcTimestamp(session.created_at)
            && isValidUtcTimestamp(predecessor.updated_at)
            && session.created_at <= predecessor.updated_at) {
            errors.push(schemaError(`${basePath}.created_at`, "session_binding_candidate_chronology", "a pre-cutover successor must be created after its checkpointed predecessor transition"));
          }
          if (session.ownership_status !== "candidate"
            || !["successor_warming", "successor_verified", "failed"].includes(session.rotation_state)
            || predecessor.ownership_status !== "owner"
            || predecessor.rotation_state !== "checkpointed") {
            errors.push(schemaError(`${basePath}.replaces_session_id`, "session_binding_replacement_pre_cutover", "one-way replacement is allowed only while a successor candidate waits for atomic cutover"));
          }
        } else if (predecessor.replaced_by_session_id !== session.session_id) {
          errors.push(schemaError(`${basePath}.replaces_session_id`, "session_binding_replacement_symmetric", "completed replacement links must be symmetric"));
        } else if (predecessor.ownership_ended_at !== session.ownership_started_at) {
          errors.push(schemaError(`${basePath}.ownership_started_at`, "session_binding_cutover_timestamp", "completed predecessor and successor rows must share immutable ownership-edge evidence"));
        }
      }
    }
    if (session.retry_of_session_id !== null) {
      const failedAttempt = sessionsById.get(session.retry_of_session_id);
      if (!failedAttempt) {
        errors.push(schemaError(`${basePath}.retry_of_session_id`, "session_binding_retry_reference", "retry source session must exist"));
      } else if (failedAttempt.rotation_state !== "failed"
        || failedAttempt.agent_id !== session.agent_id
        || failedAttempt.session_generation !== session.session_generation
        || failedAttempt.replaces_session_id !== session.replaces_session_id
        || !isValidUtcTimestamp(failedAttempt.updated_at)
        || !isValidUtcTimestamp(session.created_at)
        || session.created_at <= failedAttempt.updated_at) {
        errors.push(schemaError(`${basePath}.retry_of_session_id`, "session_binding_retry_provenance", "retry must bind the immediately failed attempt for the same agent, generation, and predecessor"));
      }
    }
    if (session.replaced_by_session_id !== null) {
      const successor = sessionsById.get(session.replaced_by_session_id);
      if (!successor) {
        errors.push(schemaError(`${basePath}.replaced_by_session_id`, "session_binding_replacement_reference", "successor session must exist"));
      } else {
        if (successor.agent_id !== session.agent_id) {
          errors.push(schemaError(`${basePath}.replaced_by_session_id`, "session_binding_replacement_agent", "replacement links must stay within one agent"));
        }
        if (successor.session_generation !== session.session_generation + 1) {
          errors.push(schemaError(`${basePath}.session_generation`, "session_binding_replacement_generation", "successor generation must be exactly predecessor generation plus one"));
        }
        if (successor.replaces_session_id !== session.session_id) {
          errors.push(schemaError(`${basePath}.replaced_by_session_id`, "session_binding_replacement_symmetric", "replacement links must be symmetric"));
        }
        if (session.ownership_status !== "superseded"
          || !["owner", "superseded", "retired"].includes(successor.ownership_status)) {
          errors.push(schemaError(`${basePath}.replaced_by_session_id`, "session_binding_replacement_cutover", "a completed replacement must lead to a current or historically superseded owner"));
        }
        if (session.ownership_ended_at !== successor.ownership_started_at) {
          errors.push(schemaError(`${basePath}.ownership_ended_at`, "session_binding_cutover_timestamp", "completed replacement must preserve immutable predecessor-end and successor-start evidence"));
        }
      }
    }
  }

  for (const session of value.sessions) {
    if (!isPlainObject(session)) continue;
    const visited = new Set();
    let cursor = session;
    while (cursor && cursor.replaced_by_session_id !== null) {
      if (visited.has(cursor.session_id)) {
        errors.push(schemaError("$.sessions", "session_binding_replacement_cycle", "replacement links must be acyclic"));
        break;
      }
      visited.add(cursor.session_id);
      cursor = sessionsById.get(cursor.replaced_by_session_id);
    }
  }
  for (const session of value.sessions) {
    if (!isPlainObject(session)) continue;
    const visited = new Set();
    let cursor = session;
    while (cursor && cursor.retry_of_session_id !== null) {
      if (visited.has(cursor.session_id)) {
        errors.push(schemaError("$.sessions", "session_binding_retry_cycle", "retry provenance must be acyclic"));
        break;
      }
      visited.add(cursor.session_id);
      cursor = sessionsById.get(cursor.retry_of_session_id);
    }
  }
  return errors;
}

function organizationRecordErrors(name, value) {
  if (!isPlainObject(value)) return [];
  if (name === "role-definition") return phase2ArrayErrors(value, ["aliases", "capability_ids"]);
  if (name === "agent-capability-profile") return phase2ArrayErrors(value, [], [["capabilities", "capability_id"]]);
  if (name === "agent-registry-v3") return agentRegistryV3Errors(value);
  if (name === "organization-state-v3") return organizationStateV3Errors(value);
  if (name === "formation-state") return formationStateErrors(value);
  if (name === "placement-intent" || name === "organization-agent-placement-persistent-v1") return placementIntentErrors(value);
  if (name === "session-binding-state-v1") return sessionBindingStateV1Errors(value);
  return [];
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
  if (name === "context-receipt") errors.push(...timestampFieldErrors(value, ["created_at"]));
  if (name === "project-control-plane") errors.push(...timestampFieldErrors(value, ["updated_at"]));
  if (name === "phase-review") {
    errors.push(...timestampFieldErrors(value, ["review_requested_at", "reviewed_at"]));
    errors.push(...phaseReviewErrors(value));
  }
  if (name === "execution-plan") errors.push(...executionPlanErrors(value));
  if (["role-definition", "agent-capability-profile", "agent-registry-v3", "organization-state-v3", "formation-state", "organization-agent-placement-persistent-v1", "placement-intent", "session-binding-state-v1"].includes(name)) {
    errors.push(...organizationRecordErrors(name, value));
  }
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
