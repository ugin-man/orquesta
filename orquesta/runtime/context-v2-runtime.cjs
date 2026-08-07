"use strict";
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};

// packages/contracts/src/canonical-json.js
var require_canonical_json = __commonJS({
  "packages/contracts/src/canonical-json.js"(exports2, module2) {
    var crypto = require("node:crypto");
    function normalize(value, stack = /* @__PURE__ */ new Set()) {
      if (value === void 0) throw new TypeError("canonical JSON does not allow undefined");
      if (value === null || typeof value === "string" || typeof value === "boolean") return value;
      if (typeof value === "number") {
        if (!Number.isFinite(value)) throw new TypeError("canonical JSON requires finite numbers");
        return value;
      }
      if (typeof value !== "object") throw new TypeError(`canonical JSON does not allow ${typeof value}`);
      if (stack.has(value)) throw new TypeError("canonical JSON does not allow circular references");
      if (Object.getOwnPropertySymbols(value).length > 0) {
        throw new TypeError("canonical JSON does not allow symbol-keyed objects");
      }
      stack.add(value);
      try {
        if (Array.isArray(value)) {
          for (const key of Object.getOwnPropertyNames(value)) {
            if (key === "length") continue;
            const index = Number(key);
            if (!Number.isInteger(index) || index < 0 || index >= value.length || String(index) !== key) {
              throw new TypeError("canonical JSON does not allow non-index array properties");
            }
          }
          const normalized2 = [];
          for (let index = 0; index < value.length; index += 1) {
            if (!Object.hasOwn(value, index)) throw new TypeError("canonical JSON does not allow sparse arrays");
            normalized2.push(normalize(value[index], stack));
          }
          return normalized2;
        }
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
          throw new TypeError("canonical JSON only allows plain objects");
        }
        const normalized = /* @__PURE__ */ Object.create(null);
        for (const key of Object.keys(value).sort()) normalized[key] = normalize(value[key], stack);
        return normalized;
      } finally {
        stack.delete(value);
      }
    }
    function canonicalJson(value) {
      return JSON.stringify(normalize(value));
    }
    function canonicalHash(value) {
      return crypto.createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
    }
    module2.exports = { canonicalJson, canonicalHash };
  }
});

// packages/contracts/src/validator.js
var require_validator = __commonJS({
  "packages/contracts/src/validator.js"(exports2, module2) {
    var fs = require("node:fs");
    var path = require("node:path");
    var { isDeepStrictEqual } = require("node:util");
    var SUPPORTED_KEYWORDS = /* @__PURE__ */ new Set([
      "$id",
      "$schema",
      "type",
      "required",
      "properties",
      "items",
      "enum",
      "const",
      "minItems",
      "minimum",
      "maximum",
      "pattern",
      "additionalProperties",
      "anyOf",
      "oneOf"
    ]);
    var SUPPORTED_TYPES = /* @__PURE__ */ new Set(["null", "boolean", "string", "number", "integer", "array", "object"]);
    var UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    var SCHEMA_NAMES = [
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
      "organization-state",
      "organization-decision",
      "specialist-plan-v2",
      "task-envelope",
      "context-requirement",
      "source-record",
      "context-pack-v2",
      "context-receipt",
      "project-control-plane",
      "session-rotation-registry",
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
    var defaultSchemasDir = path.resolve(__dirname, "../schemas");
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
      if (schema.minimum !== void 0 && typeof value === "number" && value < schema.minimum) {
        errors.push(schemaError(valuePath, "minimum", `must be at least ${schema.minimum}`));
      }
      if (schema.maximum !== void 0 && typeof value === "number" && value > schema.maximum) {
        errors.push(schemaError(valuePath, "maximum", `must be at most ${schema.maximum}`));
      }
      if (schema.pattern && typeof value === "string" && !new RegExp(schema.pattern).test(value)) {
        errors.push(schemaError(valuePath, "pattern", "must match the required pattern"));
      }
      if (schema.minItems !== void 0 && Array.isArray(value) && value.length < schema.minItems) {
        errors.push(schemaError(valuePath, "minItems", `must contain at least ${schema.minItems} item${schema.minItems === 1 ? "" : "s"}`));
      }
      if (schema.items && Array.isArray(value)) {
        value.forEach((item, index) => errors.push(...validateSchema(schema.items, item, `${valuePath}[${index}]`)));
      }
      if (isPlainObject(value) && (schema.type === "object" || schema.properties || schema.required || schema.additionalProperties !== void 0)) {
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
      if (isValidUtcTimestamp(value.captured_at) && isValidUtcTimestamp(value.expires_at) && new Date(value.expires_at).getTime() <= new Date(value.captured_at).getTime()) {
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
    var EXECUTION_BUDGETS = {
      fast: { max_handoffs: 0, max_independent_reviews: 0, max_correction_batches: 1, max_reports: 0, max_auxiliary_tasks: 0 },
      standard: { max_handoffs: 2, max_independent_reviews: 1, max_correction_batches: 1, max_reports: 1, max_auxiliary_tasks: 0 },
      critical: { max_handoffs: 4, max_independent_reviews: 2, max_correction_batches: 2, max_reports: 2, max_auxiliary_tasks: 0 }
    };
    var ACQUISITION_LIMITS = {
      max_requests_per_need: 8,
      max_requests_per_connector: 2,
      max_candidates: 3
    };
    function sortedUnique(values) {
      return Array.isArray(values) && values.every((value, index) => typeof value === "string" && (index === 0 || codeUnitCompare(values[index - 1], value) < 0));
    }
    function sortedUniqueBy(values, key) {
      return Array.isArray(values) && values.every((value, index) => isPlainObject(value) && typeof value[key] === "string" && (index === 0 || codeUnitCompare(values[index - 1][key], value[key]) < 0));
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
      if (isValidUtcTimestamp(value.fetched_at) && isValidUtcTimestamp(value.expires_at) && new Date(value.expires_at).getTime() <= new Date(value.fetched_at).getTime()) {
        errors.push(schemaError("$.expires_at", "source_expiry_order", "must be later than fetched_at"));
      }
      if (!Array.isArray(value.candidates) || !Array.isArray(value.source_evidence)) return errors;
      const records = new Map(value.candidates.map((candidate) => [candidate && candidate.candidate_id, candidate]));
      const evidenceCandidateIds = new Set(value.source_evidence.filter(isPlainObject).map((evidence) => evidence.candidate_id));
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
        if (!isPlainObject(evidence.facts) || candidate.trust_tier !== evidence.facts.trust || candidate.freshness !== evidence.freshness || candidate.freshness !== evidence.facts.freshness) {
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
      if (value.actual_model !== null && (!value.payload_ref || !value.payload_hash || value.event_kind !== "model_observed" || !["app_server", "approved_hook"].includes(value.source))) {
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
      if (Object.prototype.hasOwnProperty.call(EXECUTION_BUDGETS, value.lane) && !isDeepStrictEqual(value.budget, EXECUTION_BUDGETS[value.lane])) {
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
      const expectedRouting = direct ? { routing_class: "inline_verified", handoff_required: false, specialist_report_required: false } : { routing_class: "specialist_required", handoff_required: true, specialist_report_required: true };
      if (["fast", "standard", "critical"].includes(value.lane) && !isDeepStrictEqual(value.routing, expectedRouting)) {
        errors.push(schemaError("$.routing", "execution_routing", "must match the lane routing policy"));
      }
      const expectedReviewPolicy = isV2 ? value.review_intensity === "light" ? "none" : value.review_intensity === "normal" ? "independent_once" : value.review_intensity === "strict" ? "independent_twice" : null : value.lane === "fast" ? "none" : value.lane === "standard" ? "independent_once" : value.lane === "critical" ? "independent_twice" : null;
      if (expectedReviewPolicy && value.review_policy !== expectedReviewPolicy) {
        errors.push(schemaError("$.review_policy", "execution_review_policy", "must match the lane review policy"));
      }
      return errors;
    }
    function uniqueRecordIds(value, field, pathValue, errors) {
      if (!Array.isArray(value)) return;
      const seen = /* @__PURE__ */ new Set();
      for (const record of value) {
        const id = record && record[field];
        if (typeof id !== "string" || seen.has(id)) {
          errors.push(schemaError(pathValue, "organization_unique_id", "must contain unique record ids"));
          return;
        }
        seen.add(id);
      }
    }
    function organizationDecisionErrors(value) {
      if (!isPlainObject(value)) return [];
      const errors = [];
      const lineAction = value.selected_action === "propose_line";
      if (lineAction !== value.requires_user_approval) {
        errors.push(schemaError("$.requires_user_approval", "organization_line_approval", "must be true only for propose_line"));
      }
      if (lineAction) {
        if (!isPlainObject(value.proposed_line) || !["pending_user", "approved"].includes(value.approval_state)) {
          errors.push(schemaError("$.approval_state", "organization_line_approval", "propose_line requires a proposed line and pending_user or approved approval"));
        }
      } else if (value.approval_state !== "not_required" || value.proposed_line !== null) {
        errors.push(schemaError("$.approval_state", "organization_approval_scope", "must be not_required with no proposed line outside propose_line"));
      }
      return errors;
    }
    function organizationStateErrors(value) {
      if (!isPlainObject(value)) return [];
      const errors = [];
      for (const [field, id] of [["agents", "agent_id"], ["teams", "team_id"], ["memberships", "membership_id"], ["relationships", "relationship_id"], ["lines", "line_id"]]) {
        uniqueRecordIds(value[field], id, `$.${field}`, errors);
      }
      if (errors.length > 0) return errors;
      const agents = new Map((value.agents || []).map((agent) => [agent.agent_id, agent]));
      const teams = new Map((value.teams || []).map((team) => [team.team_id, team]));
      const lines = new Map((value.lines || []).map((line) => [line.line_id, line]));
      for (const team of value.teams || []) {
        if (team.line_id !== null && !lines.has(team.line_id)) errors.push(schemaError("$.teams", "organization_team_line_reference", "team line_id must reference an existing line"));
      }
      const activeMemberships = (value.memberships || []).filter((membership) => membership.active_to === null);
      for (const membership of activeMemberships) {
        if (!agents.has(membership.agent_id) || !teams.has(membership.team_id)) {
          errors.push(schemaError("$.memberships", "organization_membership_reference", "membership must reference existing agent and team"));
        }
      }
      for (const agent of agents.values()) {
        const memberships = activeMemberships.filter((membership) => membership.agent_id === agent.agent_id);
        if (agent.organization_scope === "line") {
          const lineIds = new Set(memberships.map((membership) => teams.get(membership.team_id)?.line_id).filter(Boolean));
          if (lineIds.size !== 1) errors.push(schemaError("$.memberships", "organization_line_membership", "line-scoped agents must have one active line membership"));
        }
        if (agent.organization_scope === "project" && memberships.some((membership) => teams.get(membership.team_id)?.line_id !== null)) {
          errors.push(schemaError("$.memberships", "organization_project_scope", "project-scoped agents cannot join a production line"));
        }
      }
      for (const team of teams.values()) {
        if (team.line_id === null || team.lifecycle_state !== "active") continue;
        const members = activeMemberships.filter((membership) => membership.team_id === team.team_id);
        const leads = members.filter((membership) => membership.position === "lead");
        const requiredLeadCount = members.length >= 3 ? 1 : 0;
        if (leads.length !== requiredLeadCount) {
          errors.push(schemaError("$.memberships", "organization_team_lead", "an active production team requires no lead below three members and exactly one existing lead at three or more"));
        }
      }
      const activeLines = [...lines.values()].filter((line) => line.status === "active");
      for (const line of lines.values()) {
        if (!agents.has(line.owner_agent_id)) errors.push(schemaError("$.lines", "organization_line_owner", "line owner must reference an existing agent"));
        const lineMemberIds = new Set(activeMemberships.filter((membership) => teams.get(membership.team_id)?.line_id === line.line_id).map((membership) => membership.agent_id));
        if (line.dedicated_lead_agent_id !== null && !lineMemberIds.has(line.dedicated_lead_agent_id)) {
          errors.push(schemaError("$.lines", "organization_line_lead", "dedicated lead must reference an active existing member of the same line"));
        }
        if (activeLines.length >= 2 && line.status === "active" && lineMemberIds.size > 0 && line.dedicated_lead_agent_id === null) {
          errors.push(schemaError("$.lines", "organization_line_responsibility", "each populated active line requires one existing responsible member when multiple active lines exist"));
        }
      }
      const reportsTo = /* @__PURE__ */ new Map();
      for (const relationship of value.relationships || []) {
        if (!agents.has(relationship.from_agent_id) || !agents.has(relationship.to_agent_id)) {
          errors.push(schemaError("$.relationships", "organization_relationship_reference", "relationship must reference existing agents"));
          continue;
        }
        reportsTo.set(relationship.from_agent_id, relationship.to_agent_id);
      }
      for (const agentId of reportsTo.keys()) {
        const seen = /* @__PURE__ */ new Set();
        let current = agentId;
        while (reportsTo.has(current)) {
          if (seen.has(current)) {
            errors.push(schemaError("$.relationships", "organization_reports_to_cycle", "reports_to relationships must be acyclic"));
            break;
          }
          seen.add(current);
          current = reportsTo.get(current);
        }
      }
      return errors;
    }
    function organizationRecordErrors(name, value) {
      if (!isPlainObject(value)) return [];
      if (name === "role-definition") return phase2ArrayErrors(value, ["aliases", "capability_ids"]);
      if (name === "agent-capability-profile") return phase2ArrayErrors(value, [], [["capabilities", "capability_id"]]);
      if (name === "organization-state") return organizationStateErrors(value);
      if (name === "organization-decision") return organizationDecisionErrors(value);
      if (name === "specialist-plan-v2") {
        const errors = phase2ArrayErrors(value, ["first_executable_batch"], [["future_candidates", "role_id"]]);
        const selectedKeys = /* @__PURE__ */ new Set();
        for (const specialist of value.selected_specialists || []) {
          const key = specialist && `${specialist.role_id}\0${specialist.line_id}\0${specialist.team_id}`;
          if (selectedKeys.has(key)) {
            errors.push(schemaError("$.selected_specialists", "organization_selected_specialist_duplicate", "must not repeat the same role, line, and team"));
            break;
          }
          selectedKeys.add(key);
        }
        return errors;
      }
      return [];
    }
    function codeUnitCompare(left, right) {
      if (left < right) return -1;
      if (left > right) return 1;
      return 0;
    }
    function sortErrors(errors) {
      return errors.sort((left, right) => codeUnitCompare(left.path, right.path) || codeUnitCompare(left.code, right.code) || codeUnitCompare(left.message, right.message));
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
      if (["role-definition", "agent-capability-profile", "organization-state", "organization-decision", "specialist-plan-v2"].includes(name)) {
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
      if (typeof phaseReview.phase_id !== "string" || !phaseReview.phase_id || !Number.isInteger(phaseReview.review_cycle_revision) || phaseReview.review_cycle_revision < 0 || typeof phaseReview.review_packet_hash !== "string" || !/^[a-f0-9]{64}$/.test(phaseReview.review_packet_hash)) {
        errors.push(schemaError("$.phaseReview", "approval_phase_review_invalid", "phase review binding fields are invalid"));
      }
      if (!isValidUtcTimestamp(phaseReview.reviewed_at)) {
        const code = phaseReview.reviewed_at === null || phaseReview.reviewed_at === void 0 ? "approval_reference_time_missing" : "approval_reference_time_invalid";
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
      if (isValidUtcTimestamp(phaseReview.reviewed_at) && isValidUtcTimestamp(attestation.captured_at) && isValidUtcTimestamp(attestation.expires_at)) {
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
    module2.exports = {
      SCHEMA_NAMES,
      loadSchema,
      validateContract,
      assertContract,
      validatePhaseApprovalBinding
    };
  }
});

// packages/contracts/src/index.js
var require_src = __commonJS({
  "packages/contracts/src/index.js"(exports2, module2) {
    var { canonicalJson, canonicalHash } = require_canonical_json();
    var {
      SCHEMA_NAMES,
      loadSchema,
      validateContract,
      assertContract,
      validatePhaseApprovalBinding
    } = require_validator();
    module2.exports = {
      SCHEMA_NAMES,
      canonicalJson,
      canonicalHash,
      loadSchema,
      validateContract,
      assertContract,
      validatePhaseApprovalBinding
    };
  }
});

// packages/context-compiler/src/v2.js
var require_v2 = __commonJS({
  "packages/context-compiler/src/v2.js"(exports2, module2) {
    "use strict";
    var crypto = require("node:crypto");
    var fs = require("node:fs");
    var path = require("node:path");
    var { assertContract, canonicalHash } = require_src();
    var PROJECT_SCOPES = /* @__PURE__ */ new Set(["none", "local", "component", "global"]);
    var DETAIL_LEVELS = /* @__PURE__ */ new Set(["minimal", "bounded", "deep"]);
    var DECISION_AUTHORITIES = /* @__PURE__ */ new Set(["read_only", "proposal_only", "bounded_execution", "user_only"]);
    var EXECUTION_CHANNELS = /* @__PURE__ */ new Set([
      "coordination",
      "live_operation",
      "product_implementation",
      "independent_review",
      "creative_production",
      "research"
    ]);
    var CONTINUE_POLICIES = /* @__PURE__ */ new Set(["continue_until_terminal", "return_after_local", "await_user"]);
    var CHECKPOINT_POLICIES = /* @__PURE__ */ new Set(["non_blocking", "blocking_canary", "final_acceptance"]);
    var HISTORY_POLICIES = /* @__PURE__ */ new Set(["fresh", "filtered", "existing_delta"]);
    var BUDGETS = Object.freeze({
      none: Object.freeze({ initial: 2e3, expansion: 2e3 }),
      local: Object.freeze({ initial: 6e3, expansion: 4e3 }),
      component: Object.freeze({ initial: 1e4, expansion: 8e3 }),
      global: Object.freeze({ initial: 12e3, expansion: 12e3 })
    });
    function clone(value) {
      return value === void 0 ? void 0 : JSON.parse(JSON.stringify(value));
    }
    function compareText(left, right) {
      return left < right ? -1 : left > right ? 1 : 0;
    }
    function sortUnique(values) {
      return [...new Set(values.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))].sort(compareText);
    }
    function object(value) {
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    }
    function records(value) {
      return Array.isArray(value) ? value.filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry)) : [];
    }
    function boundedInteger(value, fallback) {
      return Number.isInteger(value) && value >= 0 ? value : fallback;
    }
    function id(prefix, value) {
      return `${prefix}-${canonicalHash(value).slice(0, 12)}`;
    }
    function validateChoice(value, choices, fallback) {
      return choices.has(value) ? value : fallback;
    }
    function normalizeWorkspaceReference(value) {
      if (typeof value !== "string" || !value.trim()) return null;
      const candidate = value.trim().replace(/\\/g, "/");
      if (candidate === "." || candidate.startsWith("/") || /^[A-Za-z]:\//u.test(candidate)) return null;
      if (/^[a-z][a-z0-9+.-]*:/iu.test(candidate)) return null;
      const normalized = path.posix.normalize(candidate);
      if (normalized === ".." || normalized.startsWith("../")) return null;
      return normalized;
    }
    function createTaskEnvelopeV2({ taskIntent, options = {} } = {}) {
      const intent = clone(assertContract("task-intent", taskIntent));
      const input = object(options);
      const parentGoalId = typeof input.parent_goal_id === "string" && input.parent_goal_id.trim() ? input.parent_goal_id.trim() : null;
      const continuePolicy = validateChoice(
        input.continue_policy,
        CONTINUE_POLICIES,
        parentGoalId ? "continue_until_terminal" : "return_after_local"
      );
      const executionChannel = validateChoice(
        input.execution_channel,
        EXECUTION_CHANNELS,
        "product_implementation"
      );
      const checkpointPolicy = validateChoice(input.checkpoint_policy, CHECKPOINT_POLICIES, "non_blocking");
      const historyPolicy = validateChoice(input.conversation_history_policy, HISTORY_POLICIES, "filtered");
      const content = {
        schema_version: 2,
        task_intent_id: intent.task_intent_id,
        parent_goal_id: parentGoalId,
        workstream_id: String(input.workstream_id || `workstream:${intent.task_intent_id}`),
        terminal_outcome: String(input.terminal_outcome || intent.desired_outcome),
        local_deliverable: String(input.local_deliverable || intent.desired_outcome),
        continue_policy: continuePolicy,
        checkpoint_policy: checkpointPolicy,
        escalation_conditions: sortUnique(Array.isArray(input.escalation_conditions) ? input.escalation_conditions : ["external_access_blocked", "required_user_action", "terminal_outcome_impossible"]),
        notification_policy: {
          silent_progress: input.silent_progress !== false,
          notify_on: sortUnique(Array.isArray(input.notify_on) ? input.notify_on : ["blocker", "exceptional_duration", "terminal", "user_action"])
        },
        execution: {
          execution_channel: executionChannel,
          inbox_policy: input.inbox_policy === "queued" ? "queued" : "exclusive",
          accepted_command_types: sortUnique(Array.isArray(input.accepted_command_types) ? input.accepted_command_types : [`${executionChannel}.execute`]),
          exclusive_active_command: input.exclusive_active_command !== false,
          conversation_history_policy: historyPolicy
        },
        status: input.status === "superseded" ? "superseded" : input.status === "draft" ? "draft" : "ready"
      };
      const envelope = {
        ...content,
        task_envelope_id: id("TE", content)
      };
      return Object.freeze(assertContract("task-envelope", envelope));
    }
    function inferProjectScope(workItem) {
      const explicit = workItem.project_scope;
      if (PROJECT_SCOPES.has(explicit)) return explicit;
      const boundaries = sortUnique(Array.isArray(workItem.scope_boundaries) ? workItem.scope_boundaries : []);
      if (!boundaries.length) return "none";
      if (boundaries.includes(".")) return "global";
      return boundaries.length === 1 ? "local" : "component";
    }
    function inferDecisionAuthority(intent, workItem) {
      if (DECISION_AUTHORITIES.has(workItem.decision_authority)) return workItem.decision_authority;
      const authority = object(intent.authority_boundary);
      const agentMay = sortUnique(Array.isArray(authority.agent_may) ? authority.agent_may : []);
      const userOnly = sortUnique(Array.isArray(authority.user_only) ? authority.user_only : []);
      if (!agentMay.length && userOnly.length) return "user_only";
      if (agentMay.length && agentMay.every((entry) => /^(?:read|inspect|review|analyze)$/iu.test(entry))) return "read_only";
      return userOnly.length ? "proposal_only" : "bounded_execution";
    }
    function dependencyInputs(workItem) {
      return records(workItem.dependency_inputs).filter((entry) => typeof entry.task_id === "string" && entry.task_id.trim() && typeof entry.required_output === "string" && entry.required_output.trim()).map((entry) => ({
        task_id: entry.task_id.trim(),
        required_output: entry.required_output.trim()
      })).sort((left, right) => compareText(`${left.task_id}:${left.required_output}`, `${right.task_id}:${right.required_output}`));
    }
    function capabilityDomains(capabilityNeeds) {
      const values = [];
      for (const need of records(capabilityNeeds)) {
        if (typeof need.capability_id === "string") values.push(need.capability_id);
        else if (typeof need.kind === "string") values.push(`capability.${need.kind}`);
        if (Array.isArray(need.knowledge_domains)) values.push(...need.knowledge_domains);
      }
      return sortUnique(values);
    }
    function deriveContextRequirementV2({
      taskIntent,
      taskEnvelope,
      workItem = {},
      capabilityNeeds = []
    } = {}) {
      const intent = clone(assertContract("task-intent", taskIntent));
      const envelope = clone(assertContract("task-envelope", taskEnvelope));
      if (envelope.task_intent_id !== intent.task_intent_id) {
        throw new TypeError("TaskEnvelope must bind the same TaskIntent.");
      }
      const work = object(workItem);
      const projectScope = inferProjectScope(work);
      const budget = BUDGETS[projectScope];
      const requiredReading = sortUnique([
        ...Array.isArray(object(work.context_manifest).required_reading) ? object(work.context_manifest).required_reading : [],
        ...Array.isArray(work.required_reading) ? work.required_reading : []
      ]);
      const exclusions = sortUnique([
        ...Array.isArray(object(work.context_manifest).excluded_context) ? object(work.context_manifest).excluded_context : [],
        ...Array.isArray(work.excluded_context) ? work.excluded_context : [],
        "superseded",
        "unrelated_private_context"
      ]);
      const explicitDomains = Array.isArray(work.knowledge_domains) ? work.knowledge_domains : [];
      const artifactTypes = sortUnique(Array.isArray(work.artifact_types) && work.artifact_types.length ? work.artifact_types : ["task_intent"]);
      const evidenceNeeds = intent.acceptance_criteria.map((criterion, index) => typeof criterion === "string" && criterion.trim() ? `acceptance:${index + 1}` : null).filter(Boolean);
      const content = {
        version: 2,
        task_intent_id: intent.task_intent_id,
        task_envelope_id: envelope.task_envelope_id,
        project_scope: projectScope,
        knowledge_domains: sortUnique([...explicitDomains, ...capabilityDomains(capabilityNeeds)]),
        artifact_types: artifactTypes,
        dependency_inputs: dependencyInputs(work),
        decision_authority: inferDecisionAuthority(intent, work),
        detail_level: validateChoice(
          work.detail_level,
          DETAIL_LEVELS,
          projectScope === "global" || projectScope === "component" ? "deep" : projectScope === "local" ? "bounded" : "minimal"
        ),
        freshness: work.freshness === "allow_stale_with_warning" ? "allow_stale_with_warning" : "current",
        evidence_needs: evidenceNeeds.length ? evidenceNeeds : ["acceptance:1"],
        must_include: sortUnique([
          `task_intent:${intent.task_intent_id}`,
          `task_envelope:${envelope.task_envelope_id}`,
          ...requiredReading
        ]),
        must_exclude: exclusions,
        initial_token_budget: boundedInteger(work.initial_token_budget, budget.initial),
        expansion_budget: boundedInteger(work.expansion_budget, budget.expansion),
        missing_context_policy: ["needs_user", "stop"].includes(work.missing_context_policy) ? work.missing_context_policy : "request_bounded_expansion",
        status: work.context_requirement_status === "needs_user" ? "needs_user" : work.context_requirement_status === "draft" ? "draft" : "ready"
      };
      const requirement = {
        ...content,
        requirement_id: id("CR", content)
      };
      return Object.freeze(assertContract("context-requirement", requirement));
    }
    function sourceType(reference) {
      if (reference === ".orquesta/state/tasks.json") return "task_record";
      if (reference.includes("/directives") || reference.includes("/decisions")) return "accepted_decision";
      if (reference.startsWith("interfaces/") || reference.includes("/interfaces/")) return "interface";
      if (reference.startsWith("tests/") || reference.includes("/test/") || reference.includes("/tests/")) return "test";
      if (reference.includes("/reports/") || reference.startsWith("reports/")) return "report";
      return "project_file";
    }
    function artifactType(reference) {
      const extension = path.posix.extname(reference).toLowerCase();
      if ([".js", ".cjs", ".mjs", ".ts", ".tsx", ".jsx"].includes(extension)) return "source_code";
      if (extension === ".json" || extension === ".jsonl") return "structured_state";
      if (extension === ".md" || extension === ".txt") return "documentation";
      if ([".png", ".jpg", ".jpeg", ".svg", ".webp"].includes(extension)) return "visual_reference";
      return "project_file";
    }
    function sourceRecordForValue({
      sourceRef,
      value,
      sourceType: kind,
      authority,
      artifactTypes,
      knowledgeDomains = [],
      supportsCriteria = [],
      status = "current",
      freshness = "current"
    }) {
      const serialized = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === "string" ? value : JSON.stringify(value), "utf8");
      const sourceHash = crypto.createHash("sha256").update(serialized).digest("hex");
      const content = {
        schema_version: 2,
        source_ref: sourceRef,
        source_hash: sourceHash,
        source_type: kind,
        authority,
        freshness,
        knowledge_domains: sortUnique(knowledgeDomains),
        artifact_types: sortUnique(artifactTypes),
        supports_criteria: sortUnique(supportsCriteria),
        token_estimate: status === "missing" ? 0 : Math.max(1, Math.ceil(serialized.byteLength / 4)),
        content_mode: "reference",
        summary: null,
        status
      };
      return assertContract("source-record", {
        ...content,
        source_id: id("SRC", { source_ref: sourceRef, source_hash: sourceHash })
      });
    }
    function buildSourceCatalogV2({
      workspaceRoot,
      taskIntent,
      taskEnvelope,
      contextRequirement,
      sourceRefs = [],
      sourceRecords = []
    } = {}) {
      const intent = clone(assertContract("task-intent", taskIntent));
      const envelope = clone(assertContract("task-envelope", taskEnvelope));
      const requirement = clone(assertContract("context-requirement", contextRequirement));
      if (intent.task_intent_id !== envelope.task_intent_id || intent.task_intent_id !== requirement.task_intent_id || envelope.task_envelope_id !== requirement.task_envelope_id) {
        throw new TypeError("Source catalog inputs must bind the same task and envelope.");
      }
      const criteria = intent.acceptance_criteria.map((_, index) => `acceptance:${index + 1}`);
      const catalog = [
        sourceRecordForValue({
          sourceRef: `task_intent:${intent.task_intent_id}`,
          value: intent,
          sourceType: "task_record",
          authority: "canonical",
          artifactTypes: ["task_intent"],
          knowledgeDomains: requirement.knowledge_domains
        }),
        sourceRecordForValue({
          sourceRef: `task_envelope:${envelope.task_envelope_id}`,
          value: envelope,
          sourceType: "task_record",
          authority: "canonical",
          artifactTypes: ["task_envelope"],
          knowledgeDomains: requirement.knowledge_domains
        })
      ];
      for (const record of sourceRecords) catalog.push(clone(assertContract("source-record", record)));
      const requestedRefs = sortUnique([
        ...sourceRefs,
        ...requirement.must_include.map(normalizeWorkspaceReference).filter(Boolean)
      ]);
      const root = typeof workspaceRoot === "string" && workspaceRoot ? fs.realpathSync(workspaceRoot) : null;
      for (const reference of requestedRefs) {
        const target = root ? path.resolve(root, ...reference.split("/")) : null;
        const relative = root && target ? path.relative(root, target) : null;
        const inside = root && target && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
        let body = "";
        let status = "missing";
        if (inside && fs.existsSync(target) && fs.statSync(target).isFile()) {
          body = fs.readFileSync(target);
          status = "current";
        }
        const supported = intent.acceptance_criteria.map((criterion, index) => typeof criterion === "string" && criterion.includes(reference) ? criteria[index] : null).filter(Boolean);
        catalog.push(sourceRecordForValue({
          sourceRef: reference,
          value: body,
          sourceType: sourceType(reference),
          authority: reference.startsWith(".orquesta/") ? "canonical" : "workspace",
          artifactTypes: [artifactType(reference)],
          // A path being present in a task's bounded candidate catalog is not
          // evidence that it belongs to every requested knowledge domain. Domain
          // tags must come from an explicit SourceRecord or a later indexer.
          knowledgeDomains: [],
          supportsCriteria: supported,
          status,
          freshness: status === "current" ? "current" : "unknown"
        }));
      }
      const byIdentity = /* @__PURE__ */ new Map();
      for (const record of catalog) {
        const key = `${record.source_ref}:${record.source_hash}`;
        if (!byIdentity.has(key)) byIdentity.set(key, record);
      }
      return Object.freeze([...byIdentity.values()].sort((left, right) => compareText(`${left.source_ref}:${left.source_id}`, `${right.source_ref}:${right.source_id}`)).map((record) => Object.freeze(record)));
    }
    function intersects(left, right) {
      const values = new Set(left);
      return right.some((value) => values.has(value));
    }
    function isExcluded(record, requirement) {
      return requirement.must_exclude.some((entry) => entry === record.source_id || entry === record.source_ref || entry === record.source_type || entry === record.status);
    }
    function relevance(record, requirement) {
      const mandatory = requirement.must_include.includes(record.source_id) || requirement.must_include.includes(record.source_ref);
      const criterionMatches = record.supports_criteria.length;
      const domainMatch = intersects(record.knowledge_domains, requirement.knowledge_domains);
      const artifactMatch = intersects(record.artifact_types, requirement.artifact_types);
      if (!mandatory && criterionMatches === 0 && !domainMatch && !artifactMatch) {
        return { mandatory: false, score: -1 };
      }
      let score = mandatory ? 1e4 : 0;
      score += criterionMatches * 500;
      if (domainMatch) score += 100;
      if (artifactMatch) score += 75;
      if (record.authority === "canonical") score += 40;
      else if (record.authority === "accepted") score += 30;
      else if (record.authority === "workspace") score += 20;
      if (record.freshness === "current") score += 25;
      score -= Math.min(record.token_estimate, 1e4) / 1e4;
      return { mandatory, score };
    }
    function compileContextPackV2Shadow({
      taskIntent,
      taskEnvelope,
      contextRequirement,
      agentCapabilityProfile,
      sourceCatalog
    } = {}) {
      const intent = clone(assertContract("task-intent", taskIntent));
      const envelope = clone(assertContract("task-envelope", taskEnvelope));
      const requirement = clone(assertContract("context-requirement", contextRequirement));
      const capability = clone(assertContract("agent-capability-profile", agentCapabilityProfile));
      if (intent.task_intent_id !== envelope.task_intent_id || intent.task_intent_id !== requirement.task_intent_id || envelope.task_envelope_id !== requirement.task_envelope_id) {
        throw new TypeError("Context Pack V2 inputs must bind the same task and envelope.");
      }
      const catalog = sourceCatalog.map((record) => clone(assertContract("source-record", record)));
      const candidates = [];
      const omitted = [];
      for (const record of catalog) {
        if (isExcluded(record, requirement)) {
          omitted.push({ source_id: record.source_id, reason: "excluded" });
          continue;
        }
        if (record.status === "superseded") {
          omitted.push({ source_id: record.source_id, reason: "superseded" });
          continue;
        }
        if (record.status === "missing") continue;
        if (record.status === "stale" && requirement.freshness === "current") {
          omitted.push({ source_id: record.source_id, reason: "stale" });
          continue;
        }
        candidates.push({ record, ...relevance(record, requirement) });
      }
      candidates.sort((left, right) => Number(right.mandatory) - Number(left.mandatory) || right.score - left.score || compareText(left.record.source_ref, right.record.source_ref));
      const deduplicated = [];
      const seenHashes = /* @__PURE__ */ new Set();
      for (const candidate of candidates) {
        if (seenHashes.has(candidate.record.source_hash)) {
          omitted.push({ source_id: candidate.record.source_id, reason: "duplicate" });
          continue;
        }
        seenHashes.add(candidate.record.source_hash);
        deduplicated.push(candidate);
      }
      const selected = [];
      let selectedTokens = 0;
      let mandatoryTokens = 0;
      for (const candidate of deduplicated) {
        if (candidate.mandatory) {
          selected.push(candidate.record);
          selectedTokens += candidate.record.token_estimate;
          mandatoryTokens += candidate.record.token_estimate;
          continue;
        }
        if (candidate.score <= 0) {
          omitted.push({ source_id: candidate.record.source_id, reason: "low_relevance" });
          continue;
        }
        if (selectedTokens + candidate.record.token_estimate > requirement.initial_token_budget) {
          omitted.push({ source_id: candidate.record.source_id, reason: "budget" });
          continue;
        }
        selected.push(candidate.record);
        selectedTokens += candidate.record.token_estimate;
      }
      const selectedIds = new Set(selected.map((record) => record.source_id));
      const coverageMatrix = intent.acceptance_criteria.map((_, index) => {
        const criterionId = `acceptance:${index + 1}`;
        const supporting = selected.filter((record) => record.supports_criteria.includes(criterionId)).map((record) => record.source_ref).sort(compareText);
        const known = catalog.some((record) => record.supports_criteria.includes(criterionId));
        return {
          criterion_id: criterionId,
          status: supporting.length ? "covered" : known ? "partial" : "uncovered",
          source_refs: supporting
        };
      });
      const staleIds = selected.filter((record) => record.freshness !== "current" || record.status === "stale").map((record) => record.source_id).sort(compareText);
      const omittedTokens = catalog.filter((record) => !selectedIds.has(record.source_id)).reduce((total, record) => total + record.token_estimate, 0);
      const incomplete = coverageMatrix.some((entry) => entry.status !== "covered");
      const mandatoryOverflow = Math.max(0, mandatoryTokens - requirement.initial_token_budget);
      const fallbackReason = mandatoryOverflow > 0 ? "mandatory_context_exceeds_initial_budget" : incomplete ? "acceptance_coverage_incomplete" : null;
      const provenance = selected.map((record) => ({
        source_ref: record.source_ref,
        source_hash: record.source_hash,
        reason: requirement.must_include.includes(record.source_ref) || requirement.must_include.includes(record.source_id) ? "must_include" : record.supports_criteria.length ? "acceptance_coverage" : "relevance_rank"
      })).sort((left, right) => compareText(left.source_ref, right.source_ref));
      const content = {
        version: 2,
        requirement_id: requirement.requirement_id,
        task_intent_id: intent.task_intent_id,
        task_envelope_id: envelope.task_envelope_id,
        owner_agent_id: capability.agent_id,
        status: "shadow",
        pack_layers: [
          { layer: "universal_contract", source_refs: ["contract:universal-operating-v2"] },
          { layer: "task_envelope", source_refs: [`task_envelope:${envelope.task_envelope_id}`] },
          { layer: "capability_slice", source_refs: [`agent-capability:${capability.agent_id}`] },
          { layer: "project_sources", source_refs: selected.map((record) => record.source_ref).sort(compareText) }
        ],
        selected_sources: selected.map((record) => record.source_id).sort(compareText),
        coverage_matrix: coverageMatrix,
        budget_receipt: {
          initial_budget: requirement.initial_token_budget,
          selected_tokens: selectedTokens,
          omitted_tokens: omittedTokens,
          mandatory_overflow: mandatoryOverflow
        },
        retrieval_permissions: {
          search: true,
          open: true,
          expand: requirement.expansion_budget > 0,
          explain: true,
          max_expansion_tokens: requirement.expansion_budget
        },
        staleness: {
          state: staleIds.length ? "contains_stale" : "current",
          stale_source_ids: staleIds
        },
        omitted_context: omitted.sort((left, right) => compareText(`${left.source_id}:${left.reason}`, `${right.source_id}:${right.reason}`)),
        fallback_reason: fallbackReason,
        provenance
      };
      const contextPack = assertContract("context-pack-v2", {
        ...content,
        context_pack_id: id("CP2", content)
      });
      return Object.freeze({
        context_pack: Object.freeze(contextPack),
        selected_source_records: Object.freeze(selected.map((record) => Object.freeze(record))),
        shadow_assessment: Object.freeze({
          would_be_ready: fallbackReason === null && staleIds.length === 0,
          fallback_reason: fallbackReason
        })
      });
    }
    function createContextReceiptV2({
      contextPack,
      agentId,
      usedSourceIds = [],
      additionalTokens = 0,
      readEvents = [],
      missingContext = [],
      userCorrections = 0,
      incorrectProjectFacts = 0,
      compactionCount = 0,
      acceptanceResults = [],
      createdAt
    } = {}) {
      const pack = clone(assertContract("context-pack-v2", contextPack));
      const used = sortUnique(usedSourceIds);
      const selected = sortUnique(pack.selected_sources);
      const usedSet = new Set(used);
      const reads = records(readEvents).filter((entry) => typeof entry.source_id === "string" && typeof entry.source_ref === "string").map((entry) => ({
        source_id: entry.source_id,
        source_ref: entry.source_ref,
        bytes: boundedInteger(entry.bytes, 0),
        tokens: boundedInteger(entry.tokens, 0),
        truncated: entry.truncated === true
      }));
      const content = {
        version: 2,
        context_pack_id: pack.context_pack_id,
        task_intent_id: pack.task_intent_id,
        agent_id: String(agentId || pack.owner_agent_id),
        initial_token_estimate: pack.budget_receipt.selected_tokens,
        additional_tokens: boundedInteger(additionalTokens, 0),
        opened_bytes: reads.reduce((total, entry) => total + entry.bytes, 0),
        opened_tokens: reads.reduce((total, entry) => total + entry.tokens, 0),
        read_events: reads,
        used_source_ids: used,
        unused_source_ids: selected.filter((sourceId) => !usedSet.has(sourceId)),
        missing_context: sortUnique(missingContext),
        user_corrections: boundedInteger(userCorrections, 0),
        incorrect_project_facts: boundedInteger(incorrectProjectFacts, 0),
        compaction_count: boundedInteger(compactionCount, 0),
        acceptance_results: records(acceptanceResults).filter((entry) => typeof entry.criterion_id === "string").map((entry) => ({
          criterion_id: entry.criterion_id,
          status: ["passed", "failed"].includes(entry.status) ? entry.status : "unknown",
          evidence_refs: sortUnique(Array.isArray(entry.evidence_refs) ? entry.evidence_refs : [])
        })).sort((left, right) => compareText(left.criterion_id, right.criterion_id)),
        created_at: createdAt || (/* @__PURE__ */ new Date()).toISOString()
      };
      return Object.freeze(assertContract("context-receipt", {
        ...content,
        receipt_id: id("CE", content)
      }));
    }
    function createProjectControlPlaneV2({
      projectId,
      revision = 0,
      activeWorkstream = null,
      projectBrief = {},
      userIntent = {},
      workGraph = {},
      organizationMap = {},
      decisionLedger = [],
      riskAndApproval = {},
      backgroundWorkstreams = [],
      updatedAt
    } = {}) {
      return Object.freeze(assertContract("project-control-plane", {
        version: 2,
        project_id: String(projectId || "orquesta-project"),
        revision: boundedInteger(revision, 0),
        active_workstream: activeWorkstream ? clone(activeWorkstream) : null,
        project_brief: clone(object(projectBrief)),
        user_intent: clone(object(userIntent)),
        work_graph: clone(object(workGraph)),
        organization_map: clone(object(organizationMap)),
        decision_ledger: clone(Array.isArray(decisionLedger) ? decisionLedger : []),
        risk_and_approval: clone(object(riskAndApproval)),
        background_workstreams: records(backgroundWorkstreams).map((entry) => ({
          workstream_id: String(entry.workstream_id || ""),
          state: String(entry.state || ""),
          summary: String(entry.summary || "")
        })).filter((entry) => entry.workstream_id && entry.state && entry.summary).sort((left, right) => compareText(left.workstream_id, right.workstream_id)),
        updated_at: updatedAt || (/* @__PURE__ */ new Date()).toISOString()
      }));
    }
    module2.exports = {
      buildSourceCatalogV2,
      compileContextPackV2Shadow,
      createContextReceiptV2,
      createProjectControlPlaneV2,
      createTaskEnvelopeV2,
      deriveContextRequirementV2
    };
  }
});

// packages/context-compiler/src/broker.js
var require_broker = __commonJS({
  "packages/context-compiler/src/broker.js"(exports2, module2) {
    "use strict";
    var fs = require("node:fs");
    var path = require("node:path");
    var crypto = require("node:crypto");
    var { assertContract } = require_src();
    var { createContextReceiptV2 } = require_v2();
    function clone(value) {
      return value === void 0 ? void 0 : JSON.parse(JSON.stringify(value));
    }
    function nonempty(value, field) {
      if (typeof value !== "string" || !value.trim()) throw new TypeError(`${field} must be a non-empty string`);
      return value.trim();
    }
    function boundedInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
      return Number.isInteger(value) && value >= 0 ? Math.min(value, maximum) : fallback;
    }
    function words(value) {
      return [...new Set(String(value || "").toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(Boolean))];
    }
    function safeWorkspaceFile(workspaceRoot, sourceRef) {
      if (!workspaceRoot || sourceRef.includes(":")) return null;
      const root = fs.realpathSync(workspaceRoot);
      const candidate = path.resolve(root, ...sourceRef.split("/"));
      const relative = path.relative(root, candidate);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`source_outside_workspace:${sourceRef}`);
      }
      if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) return null;
      const real = fs.realpathSync(candidate);
      const realRelative = path.relative(root, real);
      if (realRelative === ".." || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
        throw new Error(`source_symlink_outside_workspace:${sourceRef}`);
      }
      return real;
    }
    function createContextBrokerV22({
      workspaceRoot = null,
      contextPack,
      contextRequirement,
      sourceCatalog,
      inlineSources = {},
      session = {}
    } = {}) {
      const pack = clone(assertContract("context-pack-v2", contextPack));
      const requirement = clone(assertContract("context-requirement", contextRequirement));
      if (pack.requirement_id !== requirement.requirement_id || pack.task_intent_id !== requirement.task_intent_id || pack.task_envelope_id !== requirement.task_envelope_id) {
        throw new TypeError("Context Broker inputs must bind the same requirement, task, and envelope.");
      }
      const catalog = (Array.isArray(sourceCatalog) ? sourceCatalog : []).map((record) => clone(assertContract("source-record", record)));
      const byId = new Map(catalog.map((record) => [record.source_id, record]));
      const byRef = new Map(catalog.map((record) => [record.source_ref, record]));
      const selected = new Set(pack.selected_sources);
      const initialSelected = new Set(pack.selected_sources);
      const used = /* @__PURE__ */ new Set();
      const missingContext = /* @__PURE__ */ new Set();
      const expansions = [];
      const readEvents = [];
      let expansionTokens = 0;
      for (const sourceId of Array.isArray(session.expanded_source_ids) ? session.expanded_source_ids : []) {
        const record = byId.get(sourceId);
        if (!record || selected.has(record.source_id)) continue;
        if (record.status !== "current" || expansionTokens + record.token_estimate > pack.retrieval_permissions.max_expansion_tokens) continue;
        selected.add(record.source_id);
        expansionTokens += record.token_estimate;
        expansions.push({
          source_id: record.source_id,
          source_ref: record.source_ref,
          token_estimate: record.token_estimate,
          already_selected: false
        });
      }
      for (const sourceId of Array.isArray(session.used_source_ids) ? session.used_source_ids : []) {
        if (selected.has(sourceId)) used.add(sourceId);
      }
      for (const description of Array.isArray(session.missing_context) ? session.missing_context : []) {
        if (typeof description === "string" && description.trim()) missingContext.add(description.trim());
      }
      for (const event of Array.isArray(session.read_events) ? session.read_events : []) {
        if (!event || typeof event !== "object" || typeof event.source_id !== "string") continue;
        readEvents.push({
          source_id: event.source_id,
          source_ref: String(event.source_ref || ""),
          bytes: boundedInteger(event.bytes, 0),
          tokens: boundedInteger(event.tokens, 0),
          truncated: event.truncated === true
        });
      }
      function recordFor(source) {
        const key = nonempty(source, "source");
        const record = byId.get(key) || byRef.get(key);
        if (!record) throw new Error(`source_not_cataloged:${key}`);
        return record;
      }
      function provenanceFor(record) {
        return pack.provenance.find((entry) => entry.source_ref === record.source_ref)?.reason || (selected.has(record.source_id) ? "selected" : "not_selected");
      }
      function sourceBytes(record) {
        let content = inlineSources[record.source_ref];
        if (content === void 0) content = inlineSources[record.source_id];
        if (content === void 0) {
          const file = safeWorkspaceFile(workspaceRoot, record.source_ref);
          if (file) content = fs.readFileSync(file);
        }
        if (content === void 0) return null;
        return Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8");
      }
      function sourceIndex() {
        return [...selected].map((sourceId) => byId.get(sourceId)).filter(Boolean).map((record) => ({
          source_id: record.source_id,
          source_ref: record.source_ref,
          source_type: record.source_type,
          authority: record.authority,
          freshness: record.freshness,
          summary: record.summary,
          token_estimate: record.token_estimate,
          supports_criteria: [...record.supports_criteria],
          initial: initialSelected.has(record.source_id),
          expanded: !initialSelected.has(record.source_id),
          used: used.has(record.source_id),
          provenance_reason: provenanceFor(record)
        })).sort((left, right) => left.source_ref.localeCompare(right.source_ref));
      }
      function search(query, {
        limit = 10,
        knowledgeDomains = [],
        artifactTypes = []
      } = {}) {
        if (!pack.retrieval_permissions.search) throw new Error("context_search_not_permitted");
        const terms = words(nonempty(query, "query"));
        const domainSet = new Set(knowledgeDomains);
        const artifactSet = new Set(artifactTypes);
        return catalog.filter((record) => record.status !== "missing" && record.status !== "superseded").map((record) => {
          const haystack = words([
            record.source_ref,
            record.summary || "",
            ...record.knowledge_domains,
            ...record.artifact_types,
            ...record.supports_criteria
          ].join(" "));
          const wordSet = new Set(haystack);
          const matches = terms.filter((term) => wordSet.has(term)).length;
          const domainMatches = record.knowledge_domains.filter((item) => domainSet.has(item)).length;
          const artifactMatches = record.artifact_types.filter((item) => artifactSet.has(item)).length;
          return {
            source_id: record.source_id,
            source_ref: record.source_ref,
            selected: selected.has(record.source_id),
            status: record.status,
            token_estimate: record.token_estimate,
            score: matches * 100 + domainMatches * 25 + artifactMatches * 20
          };
        }).filter((result) => result.score > 0).sort((left, right) => right.score - left.score || left.source_ref.localeCompare(right.source_ref)).slice(0, boundedInteger(limit, 10, 50));
      }
      function expand(sources) {
        if (!pack.retrieval_permissions.expand) throw new Error("context_expansion_not_permitted");
        const requested = [...new Set((Array.isArray(sources) ? sources : [sources]).map((source) => nonempty(source, "source")))];
        const added = [];
        const rejected = [];
        for (const source of requested) {
          const record = recordFor(source);
          if (selected.has(record.source_id)) {
            added.push({ source_id: record.source_id, source_ref: record.source_ref, token_estimate: 0, already_selected: true });
            continue;
          }
          const omission = pack.omitted_context.find((entry) => entry.source_id === record.source_id);
          if (["excluded", "superseded", "stale", "duplicate"].includes(omission?.reason) || record.status !== "current") {
            rejected.push({ source_id: record.source_id, source_ref: record.source_ref, reason: omission?.reason || record.status });
            continue;
          }
          if (expansionTokens + record.token_estimate > pack.retrieval_permissions.max_expansion_tokens) {
            rejected.push({ source_id: record.source_id, source_ref: record.source_ref, reason: "expansion_budget" });
            continue;
          }
          selected.add(record.source_id);
          expansionTokens += record.token_estimate;
          const addition = {
            source_id: record.source_id,
            source_ref: record.source_ref,
            token_estimate: record.token_estimate,
            already_selected: false
          };
          expansions.push(addition);
          added.push(addition);
        }
        return {
          added,
          rejected,
          expansion_tokens: expansionTokens,
          remaining_expansion_tokens: Math.max(0, pack.retrieval_permissions.max_expansion_tokens - expansionTokens)
        };
      }
      function open(source, { maxTokens = null } = {}) {
        if (!pack.retrieval_permissions.open) throw new Error("context_open_not_permitted");
        const record = recordFor(source);
        if (!selected.has(record.source_id)) throw new Error(`source_not_selected:${record.source_ref}`);
        const tokenLimit = Math.max(1, boundedInteger(maxTokens, record.token_estimate || 1, record.token_estimate || 1));
        const byteLimit = tokenLimit * 4;
        const bytes = sourceBytes(record);
        if (!bytes) {
          missingContext.add(record.source_ref);
          return {
            source_id: record.source_id,
            source_ref: record.source_ref,
            content: null,
            truncated: false,
            token_estimate: 0,
            status: "unavailable"
          };
        }
        const sliced = bytes.subarray(0, byteLimit);
        used.add(record.source_id);
        const readEvent = {
          source_id: record.source_id,
          source_ref: record.source_ref,
          bytes: sliced.byteLength,
          tokens: Math.max(1, Math.ceil(sliced.byteLength / 4)),
          truncated: sliced.byteLength < bytes.byteLength
        };
        readEvents.push(readEvent);
        return {
          source_id: record.source_id,
          source_ref: record.source_ref,
          content: sliced.toString("utf8"),
          truncated: readEvent.truncated,
          byte_count: readEvent.bytes,
          token_estimate: readEvent.tokens,
          status: "opened"
        };
      }
      function explain(source) {
        if (!pack.retrieval_permissions.explain) throw new Error("context_explain_not_permitted");
        const record = recordFor(source);
        const provenance = pack.provenance.find((entry) => entry.source_ref === record.source_ref);
        const omission = pack.omitted_context.find((entry) => entry.source_id === record.source_id);
        return {
          source_id: record.source_id,
          source_ref: record.source_ref,
          selected: selected.has(record.source_id),
          initially_selected: initialSelected.has(record.source_id),
          reason: selected.has(record.source_id) && !initialSelected.has(record.source_id) ? "bounded_expansion" : provenance?.reason || omission?.reason || (selected.has(record.source_id) ? "selected" : "not_selected"),
          authority: record.authority,
          freshness: record.freshness,
          supports_criteria: [...record.supports_criteria]
        };
      }
      function reportMissingContext(description) {
        missingContext.add(nonempty(description, "description"));
      }
      function rehydrate() {
        const index = sourceIndex();
        const opened = [];
        const deferred = [];
        const staleSourceIds = [];
        for (const entry of index) {
          const record = byId.get(entry.source_id);
          const taskAnchor = record.source_type === "task_record" && record.authority === "canonical";
          const acceptedAnchor = ["accepted_decision", "user_directive"].includes(record.source_type) && record.authority === "accepted";
          const covered = ["must_include", "acceptance_coverage"].includes(entry.provenance_reason);
          if (!taskAnchor && !acceptedAnchor && !covered) {
            deferred.push(entry);
            continue;
          }
          const bytes = sourceBytes(record);
          const actualHash = bytes && crypto.createHash("sha256").update(bytes).digest("hex");
          if (!bytes || actualHash !== record.source_hash) {
            staleSourceIds.push(record.source_id);
            continue;
          }
          opened.push(open(record.source_id));
        }
        const status = staleSourceIds.length ? "needs_refresh" : "rehydrated";
        return {
          strategy: "post_compaction_progressive_rehydration",
          status,
          index,
          opened,
          deferred,
          stale_source_ids: staleSourceIds.sort(),
          opened_tokens: opened.reduce((total, entry) => total + (entry.token_estimate || 0), 0),
          next_action: staleSourceIds.length ? "refresh_source_index" : deferred.length ? "open_deferred_from_index" : "continue_task"
        };
      }
      function snapshot() {
        return {
          context_pack_id: pack.context_pack_id,
          requirement_id: requirement.requirement_id,
          initially_selected_source_ids: [...initialSelected].sort(),
          currently_selected_source_ids: [...selected].sort(),
          used_source_ids: [...used].sort(),
          expansion_tokens: expansionTokens,
          remaining_expansion_tokens: Math.max(0, pack.retrieval_permissions.max_expansion_tokens - expansionTokens),
          expansions: clone(expansions),
          missing_context: [...missingContext].sort(),
          read_events: clone(readEvents),
          opened_bytes: readEvents.reduce((total, event) => total + event.bytes, 0),
          opened_tokens: readEvents.reduce((total, event) => total + event.tokens, 0)
        };
      }
      function finalize({
        userCorrections = 0,
        incorrectProjectFacts = 0,
        compactionCount = 0,
        acceptanceResults = [],
        createdAt
      } = {}) {
        return createContextReceiptV2({
          contextPack: pack,
          agentId: pack.owner_agent_id,
          usedSourceIds: [...used],
          additionalTokens: expansionTokens,
          missingContext: [...missingContext],
          readEvents,
          userCorrections,
          incorrectProjectFacts,
          compactionCount,
          acceptanceResults,
          createdAt
        });
      }
      return Object.freeze({
        explain,
        expand,
        finalize,
        open,
        reportMissingContext,
        rehydrate,
        search,
        sourceIndex,
        snapshot
      });
    }
    module2.exports = { createContextBrokerV2: createContextBrokerV22 };
  }
});

// packages/context-compiler/src/activation.js
var require_activation = __commonJS({
  "packages/context-compiler/src/activation.js"(exports2, module2) {
    "use strict";
    var REQUIRED_VARIANTS = Object.freeze([
      "v1",
      "fixed_minimal",
      "v2_initial",
      "v2_bounded_retrieval"
    ]);
    function normalizeVariantRows(rows) {
      const byScenario = /* @__PURE__ */ new Map();
      for (const row of Array.isArray(rows) ? rows : []) {
        if (!row || typeof row !== "object" || !REQUIRED_VARIANTS.includes(row.variant)) continue;
        const scenarioId = typeof row.scenario_id === "string" && row.scenario_id.trim() ? row.scenario_id.trim() : "default";
        const byVariant = byScenario.get(scenarioId) || /* @__PURE__ */ new Map();
        byVariant.set(row.variant, {
          scenario_id: scenarioId,
          variant: row.variant,
          quality_passed: row.quality_passed === true,
          major_regression: row.major_regression === true,
          user_corrections: Number.isInteger(row.user_corrections) ? row.user_corrections : null,
          incorrect_project_facts: Number.isInteger(row.incorrect_project_facts) ? row.incorrect_project_facts : null,
          cold_cost_explainable: row.cold_cost_explainable === true,
          steady_cost_explainable: row.steady_cost_explainable === true,
          prompt_tokens: Number.isInteger(row.prompt_tokens) ? row.prompt_tokens : null,
          wall_time_ms: Number.isInteger(row.wall_time_ms) ? row.wall_time_ms : null,
          retrieval_required: row.retrieval_required === true
        });
        byScenario.set(scenarioId, byVariant);
      }
      return byScenario;
    }
    function summarizeContextVariantComparison2(rows) {
      const scenarios = normalizeVariantRows(rows);
      const blockers = [];
      if (scenarios.size === 0) blockers.push("missing_scenarios");
      const scenarioSummaries = [];
      for (const [scenarioId, variants] of [...scenarios.entries()].sort(([left], [right]) => left.localeCompare(right))) {
        const missing = REQUIRED_VARIANTS.filter((variant) => !variants.has(variant));
        if (missing.length) blockers.push(`${scenarioId}:missing_variants:${missing.join(",")}`);
        const baseline = variants.get("v1");
        const retrievalRequired = [...variants.values()].some((row) => row.retrieval_required === true);
        for (const variant of ["v2_initial", "v2_bounded_retrieval"]) {
          const row = variants.get(variant);
          if (!row || !baseline) continue;
          const expectedInsufficientInitial = retrievalRequired && variant === "v2_initial";
          if (!expectedInsufficientInitial) {
            if (!row.quality_passed || row.major_regression) blockers.push(`${scenarioId}:${variant}:quality_regression`);
            if (row.user_corrections === null || baseline.user_corrections === null || row.user_corrections > baseline.user_corrections) {
              blockers.push(`${scenarioId}:${variant}:user_corrections_not_bounded`);
            }
            if (row.incorrect_project_facts === null || baseline.incorrect_project_facts === null || row.incorrect_project_facts > baseline.incorrect_project_facts) {
              blockers.push(`${scenarioId}:${variant}:project_fact_regression`);
            }
          }
          if (!row.cold_cost_explainable || !row.steady_cost_explainable) {
            blockers.push(`${scenarioId}:${variant}:cost_not_explainable`);
          }
        }
        scenarioSummaries.push({
          scenario_id: scenarioId,
          retrieval_required: retrievalRequired,
          rows: REQUIRED_VARIANTS.map((variant) => variants.get(variant)).filter(Boolean)
        });
      }
      return Object.freeze({
        version: 2,
        required_variants: [...REQUIRED_VARIANTS],
        scenario_count: scenarioSummaries.length,
        scenarios: scenarioSummaries,
        rows: scenarioSummaries.flatMap((scenario) => scenario.rows),
        blockers: [...new Set(blockers)].sort(),
        passed: blockers.length === 0
      });
    }
    function structuralEligibility(requirement) {
      const authority = requirement?.decision_authority;
      const scope = requirement?.project_scope;
      const domainCount = Array.isArray(requirement?.knowledge_domains) ? requirement.knowledge_domains.length : 0;
      if (authority === "read_only" || authority === "proposal_only") {
        return {
          eligible: true,
          class: domainCount >= 2 ? "multi_domain_read_or_plan" : "read_or_proposal"
        };
      }
      if (authority === "bounded_execution" && scope === "local") {
        return { eligible: true, class: "bounded_local_execution" };
      }
      return { eligible: false, class: "outside_limited_boundary" };
    }
    function evaluateContextV2Activation2({
      featureMode = "shadow",
      contextRequirement,
      contextPack,
      variantComparison = null
    } = {}) {
      if (!["shadow", "limited", "disabled"].includes(featureMode)) {
        throw new TypeError("featureMode must be disabled, shadow, or limited");
      }
      const eligibility = structuralEligibility(contextRequirement);
      const reasons = [];
      if (featureMode !== "limited") reasons.push(`feature_mode:${featureMode}`);
      if (!eligibility.eligible) reasons.push(`structural_class:${eligibility.class}`);
      if (contextRequirement?.status !== "ready") reasons.push("requirement_not_ready");
      if (contextPack?.fallback_reason) reasons.push(`pack_fallback:${contextPack.fallback_reason}`);
      if (contextPack?.staleness?.state !== "current") reasons.push("pack_not_current");
      if (contextPack?.budget_receipt?.mandatory_overflow > 0) reasons.push("mandatory_budget_overflow");
      if (!variantComparison?.passed) reasons.push("variant_comparison_not_passed");
      const fallback = reasons.length > 0;
      return Object.freeze({
        version: 2,
        feature_mode: featureMode,
        structural_class: eligibility.class,
        route: fallback ? "v1_fallback" : contextPack?.retrieval_permissions?.expand ? "v2_bounded_retrieval" : "v2_initial",
        fallback,
        reasons: [...new Set(reasons)].sort(),
        context_pack_id: contextPack?.context_pack_id || null
      });
    }
    module2.exports = {
      REQUIRED_VARIANTS,
      evaluateContextV2Activation: evaluateContextV2Activation2,
      structuralEligibility,
      summarizeContextVariantComparison: summarizeContextVariantComparison2
    };
  }
});

// packages/context-compiler/src/project-map.js
var require_project_map = __commonJS({
  "packages/context-compiler/src/project-map.js"(exports2, module2) {
    "use strict";
    var crypto = require("node:crypto");
    var fs = require("node:fs");
    var path = require("node:path");
    var { assertContract, canonicalHash } = require_src();
    var CODE_EXTENSIONS = /* @__PURE__ */ new Set([".js", ".cjs", ".mjs", ".ts", ".tsx", ".jsx"]);
    var TEXT_EXTENSIONS = /* @__PURE__ */ new Set([
      ...CODE_EXTENSIONS,
      ".c",
      ".cpp",
      ".css",
      ".csv",
      ".h",
      ".html",
      ".json",
      ".jsonl",
      ".md",
      ".ps1",
      ".py",
      ".sh",
      ".sql",
      ".svg",
      ".toml",
      ".txt",
      ".xml",
      ".yaml",
      ".yml"
    ]);
    function clone(value) {
      return value === void 0 ? void 0 : JSON.parse(JSON.stringify(value));
    }
    function compareText(left, right) {
      return left < right ? -1 : left > right ? 1 : 0;
    }
    function uniqueStrings(values) {
      return [...new Set((Array.isArray(values) ? values : []).filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))].sort(compareText);
    }
    function safeReference(workspaceRoot, reference) {
      if (typeof reference !== "string" || !reference || reference.includes(":")) return null;
      const normalized = reference.replace(/\\/gu, "/");
      if (normalized.startsWith("/") || /^[A-Za-z]:\//u.test(normalized)) return null;
      const root = fs.realpathSync(workspaceRoot);
      const candidate = path.resolve(root, ...normalized.split("/"));
      const relative = path.relative(root, candidate);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
      return candidate;
    }
    function sourceType(reference) {
      if (reference === ".orquesta/state/tasks.json") return "task_record";
      if (reference.includes("/directives") || reference.includes("/decisions")) return "accepted_decision";
      if (reference.startsWith("interfaces/") || reference.includes("/interfaces/")) return "interface";
      if (reference.startsWith("tests/") || reference.includes("/test/") || reference.includes("/tests/")) return "test";
      if (reference.includes("/reports/") || reference.startsWith("reports/")) return "report";
      return "project_file";
    }
    function artifactType(reference) {
      const extension = path.posix.extname(reference).toLowerCase();
      if (CODE_EXTENSIONS.has(extension)) return "source_code";
      if (extension === ".json" || extension === ".jsonl") return "structured_state";
      if (extension === ".md" || extension === ".txt") return "documentation";
      if ([".png", ".jpg", ".jpeg", ".svg", ".webp"].includes(extension)) return "visual_reference";
      return "project_file";
    }
    function recordForFile(reference, content, { status = "current" } = {}) {
      const bytes = Buffer.isBuffer(content) ? content : Buffer.from(String(content || ""), "utf8");
      const sourceHash = status === "missing" ? crypto.createHash("sha256").update(`missing\0${reference}`).digest("hex") : crypto.createHash("sha256").update(bytes).digest("hex");
      const record = {
        schema_version: 2,
        source_id: `SRC-${canonicalHash({ source_ref: reference, source_hash: sourceHash }).slice(0, 12)}`,
        source_ref: reference,
        source_hash: sourceHash,
        source_type: sourceType(reference),
        authority: reference.startsWith(".orquesta/") ? "canonical" : "workspace",
        freshness: status === "current" ? "current" : "unknown",
        knowledge_domains: [],
        artifact_types: [artifactType(reference)],
        supports_criteria: [],
        token_estimate: status === "missing" ? 0 : Math.max(1, Math.ceil(bytes.byteLength / 4)),
        content_mode: "reference",
        summary: null,
        status
      };
      return assertContract("source-record", record);
    }
    function refreshSourceCatalogV22({
      workspaceRoot,
      previousRecords = [],
      sourceRefs = []
    } = {}) {
      if (typeof workspaceRoot !== "string" || !workspaceRoot) {
        throw new TypeError("workspaceRoot is required");
      }
      const previous = (Array.isArray(previousRecords) ? previousRecords : []).map((record) => clone(assertContract("source-record", record)));
      const workspaceRefs = uniqueStrings([
        ...sourceRefs,
        ...previous.filter((record) => !record.source_ref.includes(":")).map((record) => record.source_ref)
      ]);
      const preservedSynthetic = previous.filter((record) => record.source_ref.includes(":"));
      const next = [...preservedSynthetic];
      const added = [];
      const changed = [];
      const removed = [];
      const unchanged = [];
      for (const reference of workspaceRefs) {
        const target = safeReference(workspaceRoot, reference);
        const exists = target && fs.existsSync(target) && fs.statSync(target).isFile();
        const current = recordForFile(reference, exists ? fs.readFileSync(target) : "", {
          status: exists ? "current" : "missing"
        });
        const priorForRef = previous.filter((record) => record.source_ref === reference);
        const priorCurrent = priorForRef.find((record) => record.status === "current") || priorForRef.find((record) => record.status === "missing");
        const same = priorCurrent && priorCurrent.source_hash === current.source_hash && priorCurrent.status === current.status;
        if (same) {
          next.push(...priorForRef);
          unchanged.push(priorCurrent.source_id);
          continue;
        }
        for (const prior of priorForRef) {
          next.push(prior.status === "current" || prior.status === "missing" ? { ...prior, status: "superseded", freshness: "stale" } : prior);
        }
        next.push(current);
        if (!priorCurrent && current.status === "current") added.push(current.source_id);
        else if (current.status === "missing") removed.push(reference);
        else changed.push(current.source_id);
      }
      const byIdentity = /* @__PURE__ */ new Map();
      for (const record of next) {
        const validated = assertContract("source-record", record);
        byIdentity.set(`${validated.source_id}:${validated.status}`, validated);
      }
      const records = [...byIdentity.values()].sort((left, right) => compareText(`${left.source_ref}:${left.status}:${left.source_id}`, `${right.source_ref}:${right.status}:${right.source_id}`));
      const delta = {
        added_source_ids: added.sort(compareText),
        changed_source_ids: changed.sort(compareText),
        removed_source_refs: removed.sort(compareText),
        unchanged_source_ids: unchanged.sort(compareText)
      };
      return Object.freeze({ records: Object.freeze(records), delta: Object.freeze(delta) });
    }
    function extractCodeMetadata(content) {
      const text = String(content || "");
      const symbols = [];
      const symbolPattern = /\b(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var)\s+([A-Za-z_$][\w$]*)/gu;
      for (const match of text.matchAll(symbolPattern)) symbols.push(match[1]);
      const dependencies = [];
      const patterns = [
        /\bfrom\s+["']([^"']+)["']/gu,
        /\brequire\(\s*["']([^"']+)["']\s*\)/gu,
        /\bimport\(\s*["']([^"']+)["']\s*\)/gu
      ];
      for (const pattern of patterns) {
        for (const match of text.matchAll(pattern)) dependencies.push(match[1]);
      }
      return { symbols: uniqueStrings(symbols), dependencies: uniqueStrings(dependencies) };
    }
    function firstDescription(content, reference) {
      const text = String(content || "");
      const line = text.split(/\r?\n/u).map((entry) => entry.trim()).find((entry) => entry && !/^(?:[{}[\],]|\/\/|\/\*|\*)$/u.test(entry));
      return (line || `${artifactType(reference)} artifact`).slice(0, 240);
    }
    function componentFor(reference) {
      const parts = reference.split("/").filter(Boolean);
      if (parts.length <= 1) return ".";
      if (parts[0] === "packages" || parts[0] === "apps") return parts.slice(0, 2).join("/");
      return parts[0];
    }
    function buildProjectMapV22({
      workspaceRoot,
      sourceCatalog,
      projectControlPlane = null,
      priorMap = null,
      relatedTaskIdsByRef = {},
      generatedAt
    } = {}) {
      const currentRecords = (Array.isArray(sourceCatalog) ? sourceCatalog : []).map((record) => clone(assertContract("source-record", record))).filter((record) => record.status === "current" && !record.source_ref.includes(":")).sort((left, right) => compareText(left.source_ref, right.source_ref));
      const details = [];
      for (const record of currentRecords) {
        const target = safeReference(workspaceRoot, record.source_ref);
        const extension = path.posix.extname(record.source_ref).toLowerCase();
        const content2 = target && TEXT_EXTENSIONS.has(extension) && fs.existsSync(target) && fs.statSync(target).isFile() ? fs.readFileSync(target, "utf8") : "";
        const code = CODE_EXTENSIONS.has(extension);
        const metadata = code ? extractCodeMetadata(content2) : { symbols: [], dependencies: [] };
        details.push({
          source_id: record.source_id,
          source_ref: record.source_ref,
          source_hash: record.source_hash,
          component: componentFor(record.source_ref),
          artifact_type: record.artifact_types[0],
          description: firstDescription(content2, record.source_ref),
          symbols: metadata.symbols,
          dependencies: metadata.dependencies,
          related_task_ids: uniqueStrings(relatedTaskIdsByRef[record.source_ref])
        });
      }
      const componentMap = /* @__PURE__ */ new Map();
      for (const detail of details) {
        const component = componentMap.get(detail.component) || {
          component: detail.component,
          source_count: 0,
          artifact_types: /* @__PURE__ */ new Set(),
          source_refs: [],
          dependency_refs: /* @__PURE__ */ new Set()
        };
        component.source_count += 1;
        component.artifact_types.add(detail.artifact_type);
        component.source_refs.push(detail.source_ref);
        for (const dependency of detail.dependencies) component.dependency_refs.add(dependency);
        componentMap.set(detail.component, component);
      }
      const components = [...componentMap.values()].map((component) => ({
        component: component.component,
        source_count: component.source_count,
        artifact_types: [...component.artifact_types].sort(compareText),
        source_refs: component.source_refs.sort(compareText),
        dependency_refs: [...component.dependency_refs].sort(compareText),
        summary: `${component.source_count} sources; ${[...component.artifact_types].sort(compareText).join(", ")}`
      })).sort((left, right) => compareText(left.component, right.component));
      const signature = {
        project_id: projectControlPlane?.project_id || "orquesta-project",
        source_hashes: details.map(({ source_ref, source_hash }) => ({ source_ref, source_hash })),
        work_graph: projectControlPlane?.work_graph || {},
        decision_ledger: projectControlPlane?.decision_ledger || []
      };
      const priorSignatureHash = priorMap?.source_signature_hash || null;
      const sourceSignatureHash = canonicalHash(signature);
      const priorByRef = new Map((Array.isArray(priorMap?.details) ? priorMap.details : []).map((detail) => [detail.source_ref, detail]));
      const currentRefs = new Set(details.map((detail) => detail.source_ref));
      const changedRefs = details.filter((detail) => priorByRef.get(detail.source_ref)?.source_hash !== detail.source_hash).map((detail) => detail.source_ref);
      const removedRefs = [...priorByRef.keys()].filter((reference) => !currentRefs.has(reference));
      const revision = priorMap && priorSignatureHash === sourceSignatureHash ? priorMap.revision : (Number.isInteger(priorMap?.revision) ? priorMap.revision : 0) + 1;
      const content = {
        version: 2,
        project_id: signature.project_id,
        revision,
        source_signature_hash: sourceSignatureHash,
        global_summary: {
          source_count: details.length,
          component_count: components.length,
          active_workstream_id: projectControlPlane?.active_workstream?.workstream_id || null,
          accepted_decision_count: Array.isArray(projectControlPlane?.decision_ledger) ? projectControlPlane.decision_ledger.length : 0
        },
        components,
        details,
        delta: {
          changed_source_refs: changedRefs.sort(compareText),
          removed_source_refs: removedRefs.sort(compareText)
        },
        generated_at: generatedAt || (/* @__PURE__ */ new Date()).toISOString()
      };
      const mapIdentity = {
        version: content.version,
        project_id: content.project_id,
        revision: content.revision,
        source_signature_hash: content.source_signature_hash,
        global_summary: content.global_summary,
        components: content.components,
        details: content.details,
        delta: content.delta
      };
      return Object.freeze({
        ...content,
        project_map_id: `PM-${canonicalHash(mapIdentity).slice(0, 16)}`
      });
    }
    module2.exports = {
      buildProjectMapV2: buildProjectMapV22,
      extractCodeMetadata,
      refreshSourceCatalogV2: refreshSourceCatalogV22
    };
  }
});

// packages/execution-kernel/src/context-reconciler.js
var require_context_reconciler = __commonJS({
  "packages/execution-kernel/src/context-reconciler.js"(exports2, module2) {
    "use strict";
    var crypto = require("node:crypto");
    function clone(value) {
      return value === void 0 ? void 0 : JSON.parse(JSON.stringify(value));
    }
    function object(value, field) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${field} must be an object`);
      return clone(value);
    }
    function canonical(value) {
      if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
      if (value && typeof value === "object") {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
      }
      return JSON.stringify(value);
    }
    function branchDeltaId(content) {
      return `BD-${crypto.createHash("sha256").update(canonical(content)).digest("hex").slice(0, 16)}`;
    }
    function timestamp(value, field) {
      if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new TypeError(`${field} must be an ISO timestamp`);
      return new Date(value).toISOString();
    }
    function acceptanceState(receipt, pack) {
      const results = Array.isArray(receipt.acceptance_results) ? receipt.acceptance_results : [];
      if (receipt.incorrect_project_facts > 0 || receipt.user_corrections > 0) {
        return {
          state: "correction_required",
          attention: "blocker",
          action: "review_correction",
          summary: "The execution used incorrect project facts or required user correction."
        };
      }
      if (Array.isArray(receipt.missing_context) && receipt.missing_context.length) {
        return {
          state: "needs_context",
          attention: "blocker",
          action: "request_context_expansion",
          summary: "The bounded context was insufficient and needs explicit expansion."
        };
      }
      if (results.some(({ status }) => status === "failed")) {
        return {
          state: "correction_required",
          attention: "blocker",
          action: "schedule_correction",
          summary: "At least one acceptance criterion failed."
        };
      }
      const expectedCriteria = [...new Set((Array.isArray(pack.coverage_matrix) ? pack.coverage_matrix : []).map((entry) => entry?.criterion_id).filter((criterionId) => typeof criterionId === "string" && criterionId.trim()))];
      const observedCriteria = results.map((entry) => entry?.criterion_id).filter((criterionId) => typeof criterionId === "string" && criterionId.trim());
      const observedSet = new Set(observedCriteria);
      const duplicateCriterion = observedSet.size !== observedCriteria.length;
      const unknownCriterion = expectedCriteria.length > 0 && observedCriteria.some((criterionId) => !expectedCriteria.includes(criterionId));
      const missingCriterion = expectedCriteria.some((criterionId) => !observedSet.has(criterionId));
      if (!results.length || results.some(({ status }) => status !== "passed") || duplicateCriterion || unknownCriterion || missingCriterion) {
        return {
          state: "verification_incomplete",
          attention: "none",
          action: "continue_verification",
          summary: "Acceptance evidence is incomplete or does not match the Context Pack criteria."
        };
      }
      return null;
    }
    function successfulState(envelope, terminalOutcomeCompleted) {
      if (terminalOutcomeCompleted) {
        return {
          state: "terminal_accepted",
          attention: "terminal",
          action: "complete_workstream",
          summary: "The terminal outcome is accepted."
        };
      }
      if (envelope.continue_policy === "continue_until_terminal") {
        return {
          state: "continuation_ready",
          attention: "none",
          action: "schedule_continuation",
          summary: "The local deliverable passed and the parent workstream should continue."
        };
      }
      if (envelope.continue_policy === "await_user") {
        return {
          state: "waiting_for_user",
          attention: "user_action",
          action: "request_user_input",
          summary: "The local deliverable passed and the task is waiting for the user."
        };
      }
      return {
        state: "local_accepted",
        attention: "none",
        action: "accept_local_result",
        summary: "The bounded local deliverable is accepted."
      };
    }
    function reconcileContextReceiptV22({
      projectControlPlane,
      taskEnvelope,
      contextPack,
      contextReceipt,
      terminalOutcomeCompleted = false,
      priorBranchDeltaIds = [],
      observedAt
    } = {}) {
      const controlPlane = object(projectControlPlane, "projectControlPlane");
      const envelope = object(taskEnvelope, "taskEnvelope");
      const pack = object(contextPack, "contextPack");
      const receipt = object(contextReceipt, "contextReceipt");
      const time = timestamp(observedAt || receipt.created_at, "observedAt");
      if (receipt.context_pack_id !== pack.context_pack_id || receipt.task_intent_id !== pack.task_intent_id || pack.task_intent_id !== envelope.task_intent_id || pack.task_envelope_id !== envelope.task_envelope_id) {
        throw new Error("context_receipt_binding_mismatch");
      }
      const decision = acceptanceState(receipt, pack) || successfulState(envelope, terminalOutcomeCompleted);
      const active = controlPlane.active_workstream;
      const content = {
        version: 2,
        project_id: controlPlane.project_id,
        workstream_id: envelope.workstream_id,
        task_intent_id: envelope.task_intent_id,
        task_envelope_id: envelope.task_envelope_id,
        context_pack_id: pack.context_pack_id,
        receipt_id: receipt.receipt_id,
        transition: decision.state,
        attention: decision.attention,
        orchestrator_action: decision.action,
        summary: decision.summary,
        acceptance: {
          passed: decision.state === "local_accepted" || decision.state === "continuation_ready" || decision.state === "terminal_accepted" || decision.state === "waiting_for_user",
          results: clone(receipt.acceptance_results || [])
        },
        context_observation: {
          initial_token_estimate: receipt.initial_token_estimate,
          additional_tokens: receipt.additional_tokens,
          compaction_count: receipt.compaction_count,
          missing_context: clone(receipt.missing_context || []),
          user_corrections: receipt.user_corrections,
          incorrect_project_facts: receipt.incorrect_project_facts
        },
        observed_at: time
      };
      const delta = { ...content, branch_delta_id: branchDeltaId(content) };
      const duplicate = new Set(priorBranchDeltaIds).has(delta.branch_delta_id);
      const nextControlPlane = clone(controlPlane);
      if (!duplicate) {
        nextControlPlane.revision = Number.isInteger(nextControlPlane.revision) ? nextControlPlane.revision + 1 : 1;
        nextControlPlane.updated_at = time;
        if (nextControlPlane.active_workstream?.workstream_id === envelope.workstream_id) {
          nextControlPlane.active_workstream.next_decision = decision.action;
          nextControlPlane.active_workstream.current_goal = terminalOutcomeCompleted ? "Terminal outcome accepted." : envelope.terminal_outcome;
        } else if (Array.isArray(nextControlPlane.background_workstreams)) {
          nextControlPlane.background_workstreams = nextControlPlane.background_workstreams.map((workstream) => workstream.workstream_id === envelope.workstream_id ? {
            ...workstream,
            state: decision.state,
            summary: terminalOutcomeCompleted ? "Terminal outcome accepted." : decision.summary
          } : workstream);
        }
      }
      const notifyOn = new Set(envelope.notification_policy?.notify_on || []);
      const userNotification = decision.attention !== "none" && notifyOn.has(decision.attention);
      return Object.freeze({
        branch_delta: Object.freeze(delta),
        project_control_plane: Object.freeze(nextControlPlane),
        duplicate,
        notification: Object.freeze({
          wake_orchestrator: !duplicate && ["blocker", "user_action", "terminal"].includes(decision.attention),
          notify_user: !duplicate && userNotification,
          attention: decision.attention,
          reason: decision.action
        })
      });
    }
    module2.exports = { reconcileContextReceiptV2: reconcileContextReceiptV22 };
  }
});

// packages/execution-kernel/src/orchestrator-loop.js
var require_orchestrator_loop = __commonJS({
  "packages/execution-kernel/src/orchestrator-loop.js"(exports2, module2) {
    "use strict";
    function clone(value) {
      return value === void 0 ? void 0 : JSON.parse(JSON.stringify(value));
    }
    function uniqueStrings(values) {
      return [...new Set((Array.isArray(values) ? values : []).filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))].sort();
    }
    function actionForDelta(delta) {
      const action = delta.orchestrator_action;
      if (action === "request_context_expansion") return "expand_context";
      if (action === "schedule_correction" || action === "review_correction") return "schedule_correction";
      if (action === "request_user_input") return "queue_user_task";
      if (action === "schedule_continuation") return "dispatch_continuation";
      if (action === "accept_terminal_result") return "close_parent_goal";
      if (action === "verify_local_result") return "schedule_verification";
      return "record_result";
    }
    function createOrchestratorResumePlan2({
      projectControlPlane,
      branchDeltas = [],
      orchestrationState = {},
      observedAt,
      maxReceipts = 25
    } = {}) {
      if (!projectControlPlane || typeof projectControlPlane !== "object") {
        throw new TypeError("projectControlPlane is required");
      }
      const consumed = new Set(uniqueStrings(orchestrationState.consumed_branch_delta_ids));
      const pending = (Array.isArray(branchDeltas) ? branchDeltas : []).filter((delta) => delta && typeof delta === "object" && typeof delta.branch_delta_id === "string" && !consumed.has(delta.branch_delta_id)).sort((left, right) => String(left.observed_at).localeCompare(String(right.observed_at)) || left.branch_delta_id.localeCompare(right.branch_delta_id)).slice(0, Math.max(1, Number.isInteger(maxReceipts) ? maxReceipts : 25));
      const actions = pending.map((delta) => ({
        branch_delta_id: delta.branch_delta_id,
        receipt_id: delta.receipt_id,
        workstream_id: delta.workstream_id,
        task_intent_id: delta.task_intent_id,
        action: actionForDelta(delta),
        transition: delta.transition,
        attention: delta.attention,
        summary: delta.summary,
        evidence_refs: [delta.receipt_id, delta.branch_delta_id]
      }));
      const wakeReasons = uniqueStrings(actions.filter((action) => ["blocker", "user_action", "terminal"].includes(action.attention)).map((action) => `${action.attention}:${action.action}`));
      const processedIds = actions.map((action) => action.branch_delta_id);
      const nextState = {
        version: 2,
        project_id: projectControlPlane.project_id,
        control_plane_revision: projectControlPlane.revision,
        consumed_branch_delta_ids: uniqueStrings([...consumed, ...processedIds]),
        last_processed_at: observedAt || (/* @__PURE__ */ new Date()).toISOString()
      };
      const resumePacket = actions.length ? {
        version: 2,
        project_id: projectControlPlane.project_id,
        control_plane_revision: projectControlPlane.revision,
        active_workstream: clone(projectControlPlane.active_workstream),
        project_goal: clone(projectControlPlane.project_brief || {}),
        accepted_decisions: clone(projectControlPlane.decision_ledger || []),
        unresolved_issues: clone(projectControlPlane.risk_and_approval || {}),
        actions
      } : null;
      return Object.freeze({
        version: 2,
        resume_required: actions.length > 0,
        wake_orchestrator: wakeReasons.length > 0,
        wake_reasons: wakeReasons,
        resume_packet: resumePacket,
        next_state: nextState
      });
    }
    function verifyControlPlaneContinuity(before, after) {
      const missing = [];
      const beforeGoal = JSON.stringify(before?.project_brief || {});
      const afterGoal = JSON.stringify(after?.project_brief || {});
      if (beforeGoal !== afterGoal) missing.push("project_brief");
      const beforeIntent = JSON.stringify(before?.user_intent || {});
      const afterIntent = JSON.stringify(after?.user_intent || {});
      if (beforeIntent !== afterIntent) missing.push("user_intent");
      const beforeDecisions = new Set((Array.isArray(before?.decision_ledger) ? before.decision_ledger : []).map((entry) => JSON.stringify(entry)));
      const afterDecisions = new Set((Array.isArray(after?.decision_ledger) ? after.decision_ledger : []).map((entry) => JSON.stringify(entry)));
      for (const decision of beforeDecisions) {
        if (!afterDecisions.has(decision)) missing.push(`decision:${decision}`);
      }
      const beforeRisk = JSON.stringify(before?.risk_and_approval || {});
      const afterRisk = JSON.stringify(after?.risk_and_approval || {});
      if (beforeRisk !== afterRisk) missing.push("risk_and_approval");
      return Object.freeze({
        preserved: missing.length === 0,
        missing: uniqueStrings(missing)
      });
    }
    module2.exports = { createOrchestratorResumePlan: createOrchestratorResumePlan2, verifyControlPlaneContinuity };
  }
});

// packages/execution-kernel/src/session-rotation.js
var require_session_rotation = __commonJS({
  "packages/execution-kernel/src/session-rotation.js"(exports2, module2) {
    "use strict";
    var DEFAULT_SESSION_ROTATION_POLICY = Object.freeze({
      prepare_at: 12,
      pending_at: 15,
      required_at: 20
    });
    var ROTATION_STATES = Object.freeze([
      "active",
      "rotation_preparing",
      "rotation_pending",
      "rotation_required",
      "draining",
      "checkpointed",
      "successor_warming",
      "successor_verified",
      "superseded",
      "failed"
    ]);
    function clone(value) {
      return value === void 0 ? void 0 : JSON.parse(JSON.stringify(value));
    }
    function nonempty(value, field) {
      if (typeof value !== "string" || !value.trim()) {
        throw new TypeError(`${field} must be a non-empty string`);
      }
      return value.trim();
    }
    function positiveInteger(value, field, fallback) {
      if (value === void 0 || value === null) return fallback;
      const number = Number(value);
      if (!Number.isInteger(number) || number < 1) {
        throw new TypeError(`${field} must be a positive integer`);
      }
      return number;
    }
    function timestamp(value, field = "timestamp") {
      const parsed = Date.parse(value ?? "");
      if (!Number.isFinite(parsed)) throw new TypeError(`${field} must be an ISO timestamp`);
      return new Date(parsed).toISOString();
    }
    function normalizeRotationPolicy(input = {}) {
      const policy = {
        prepare_at: positiveInteger(input.prepare_at, "prepare_at", DEFAULT_SESSION_ROTATION_POLICY.prepare_at),
        pending_at: positiveInteger(input.pending_at, "pending_at", DEFAULT_SESSION_ROTATION_POLICY.pending_at),
        required_at: positiveInteger(input.required_at, "required_at", DEFAULT_SESSION_ROTATION_POLICY.required_at)
      };
      if (!(policy.prepare_at < policy.pending_at && policy.pending_at < policy.required_at)) {
        throw new TypeError("session rotation thresholds must satisfy prepare_at < pending_at < required_at");
      }
      return Object.freeze(policy);
    }
    function rotationStateForCount(count, inputPolicy = DEFAULT_SESSION_ROTATION_POLICY) {
      const policy = normalizeRotationPolicy(inputPolicy);
      const normalizedCount = Number(count);
      if (!Number.isInteger(normalizedCount) || normalizedCount < 0) {
        throw new TypeError("compaction count must be a non-negative integer");
      }
      if (normalizedCount >= policy.required_at) return "rotation_required";
      if (normalizedCount >= policy.pending_at) return "rotation_pending";
      if (normalizedCount >= policy.prepare_at) return "rotation_preparing";
      return "active";
    }
    function createSessionRotationRegistry(input = {}) {
      return {
        schema_version: 1,
        revision: 0,
        policy: { ...normalizeRotationPolicy(input.policy) },
        sessions: {},
        applied_event_ids: [],
        updated_at: input.updated_at ? timestamp(input.updated_at, "updated_at") : null
      };
    }
    function normalizeRegistry(input) {
      const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
      const sessions = source.sessions && typeof source.sessions === "object" && !Array.isArray(source.sessions) ? clone(source.sessions) : {};
      return {
        schema_version: 1,
        revision: Number.isInteger(source.revision) && source.revision >= 0 ? source.revision : 0,
        policy: { ...normalizeRotationPolicy(source.policy) },
        sessions,
        applied_event_ids: Array.isArray(source.applied_event_ids) ? source.applied_event_ids.filter((item) => typeof item === "string").slice(-256) : [],
        updated_at: typeof source.updated_at === "string" ? source.updated_at : null
      };
    }
    function sessionRecord(input, event, now) {
      const prior = input && typeof input === "object" && !Array.isArray(input) ? input : {};
      const generation = positiveInteger(
        event.session_generation ?? prior.session_generation,
        "session_generation",
        1
      );
      return {
        session_id: event.session_id,
        thread_id: event.thread_id ?? prior.thread_id ?? event.session_id,
        agent_id: event.agent_id ?? prior.agent_id ?? null,
        session_generation: generation,
        compaction_count: Number.isInteger(prior.compaction_count) && prior.compaction_count >= 0 ? prior.compaction_count : 0,
        rotation_state: typeof prior.rotation_state === "string" ? prior.rotation_state : "active",
        ownership_status: typeof prior.ownership_status === "string" ? prior.ownership_status : "owner",
        accepts_new_work: prior.accepts_new_work !== false,
        replaces_session_id: prior.replaces_session_id ?? null,
        replaced_by_session_id: prior.replaced_by_session_id ?? null,
        handoff_manifest_path: prior.handoff_manifest_path ?? null,
        handoff_manifest_hash: prior.handoff_manifest_hash ?? null,
        successor_receipt_path: prior.successor_receipt_path ?? null,
        successor_receipt_hash: prior.successor_receipt_hash ?? null,
        last_compaction: prior.last_compaction ?? null,
        created_at: prior.created_at ?? now,
        updated_at: now
      };
    }
    function recordCompaction(inputRegistry, event) {
      const sessionId = nonempty(event?.session_id, "session_id");
      const eventId = nonempty(event?.event_id, "event_id");
      const now = timestamp(event?.observed_at, "observed_at");
      const registry = normalizeRegistry(inputRegistry);
      if (registry.applied_event_ids.includes(eventId)) {
        return { registry, duplicate: true, threshold_crossed: null, session: clone(registry.sessions[sessionId] ?? null) };
      }
      const prior = sessionRecord(registry.sessions[sessionId], { ...event, session_id: sessionId }, now);
      if (["superseded", "failed"].includes(prior.rotation_state)) {
        const error = new Error(`cannot record compaction for ${prior.rotation_state} session ${sessionId}`);
        error.code = "SESSION_ROTATION_TERMINAL";
        throw error;
      }
      const previousState = prior.rotation_state;
      const compactionCount = prior.compaction_count + 1;
      const thresholdState = rotationStateForCount(compactionCount, registry.policy);
      const protectedStates = /* @__PURE__ */ new Set(["draining", "checkpointed", "successor_warming", "successor_verified"]);
      const rotationState = protectedStates.has(previousState) ? previousState : thresholdState;
      const acceptsNewWork = rotationState !== "rotation_required" && prior.accepts_new_work !== false;
      const nextSession = {
        ...prior,
        compaction_count: compactionCount,
        rotation_state: rotationState,
        accepts_new_work: acceptsNewWork,
        last_compaction: {
          event_id: eventId,
          turn_id: event.turn_id ?? null,
          trigger: event.trigger === "manual" ? "manual" : "auto",
          transcript_path: event.transcript_path ?? null,
          transcript_fingerprint: event.transcript_fingerprint ?? null,
          model: event.model ?? null,
          observed_at: now
        },
        updated_at: now
      };
      const next = {
        ...registry,
        revision: registry.revision + 1,
        sessions: { ...registry.sessions, [sessionId]: nextSession },
        applied_event_ids: [...registry.applied_event_ids, eventId].slice(-256),
        updated_at: now
      };
      return {
        registry: next,
        duplicate: false,
        threshold_crossed: previousState === rotationState ? null : rotationState,
        session: clone(nextSession)
      };
    }
    function transitionSession(inputRegistry, input, expectedStates, patch) {
      const registry = normalizeRegistry(inputRegistry);
      const sessionId = nonempty(input?.session_id, "session_id");
      const now = timestamp(input?.observed_at, "observed_at");
      if (input.expected_revision !== void 0 && input.expected_revision !== registry.revision) {
        const error = new Error(`session rotation revision conflict: expected ${input.expected_revision}, observed ${registry.revision}`);
        error.code = "SESSION_ROTATION_REVISION_CONFLICT";
        throw error;
      }
      const current = registry.sessions[sessionId];
      if (!current) throw new Error(`unknown session ${sessionId}`);
      if (!expectedStates.includes(current.rotation_state)) {
        const error = new Error(`session ${sessionId} cannot transition from ${current.rotation_state}`);
        error.code = "SESSION_ROTATION_INVALID_TRANSITION";
        throw error;
      }
      const nextSession = { ...current, ...patch(current), updated_at: now };
      return {
        ...registry,
        revision: registry.revision + 1,
        sessions: { ...registry.sessions, [sessionId]: nextSession },
        updated_at: now
      };
    }
    function beginSessionDrain(inputRegistry, input) {
      return transitionSession(
        inputRegistry,
        input,
        ["rotation_pending", "rotation_required"],
        () => ({ rotation_state: "draining", accepts_new_work: false })
      );
    }
    function markSessionCheckpointed(inputRegistry, input) {
      const manifestPath = nonempty(input?.handoff_manifest_path, "handoff_manifest_path");
      const manifestHash = nonempty(input?.handoff_manifest_hash, "handoff_manifest_hash");
      return transitionSession(
        inputRegistry,
        input,
        ["draining"],
        () => ({
          rotation_state: "checkpointed",
          accepts_new_work: false,
          handoff_manifest_path: manifestPath,
          handoff_manifest_hash: manifestHash
        })
      );
    }
    function registerSessionSuccessor(inputRegistry, input) {
      const registry = normalizeRegistry(inputRegistry);
      const predecessorId = nonempty(input?.predecessor_session_id, "predecessor_session_id");
      const successorId = nonempty(input?.successor_session_id, "successor_session_id");
      const successorThreadId = nonempty(input?.successor_thread_id, "successor_thread_id");
      const now = timestamp(input?.observed_at, "observed_at");
      if (input.expected_revision !== void 0 && input.expected_revision !== registry.revision) {
        const error = new Error(`session rotation revision conflict: expected ${input.expected_revision}, observed ${registry.revision}`);
        error.code = "SESSION_ROTATION_REVISION_CONFLICT";
        throw error;
      }
      const predecessor = registry.sessions[predecessorId];
      if (!predecessor || predecessor.rotation_state !== "checkpointed") {
        throw new Error(`predecessor ${predecessorId} is not checkpointed`);
      }
      if (registry.sessions[successorId]) throw new Error(`successor session already exists: ${successorId}`);
      const successor = {
        session_id: successorId,
        thread_id: successorThreadId,
        agent_id: predecessor.agent_id,
        session_generation: predecessor.session_generation + 1,
        compaction_count: 0,
        rotation_state: "successor_warming",
        ownership_status: "candidate",
        accepts_new_work: false,
        replaces_session_id: predecessorId,
        replaced_by_session_id: null,
        handoff_manifest_path: predecessor.handoff_manifest_path,
        handoff_manifest_hash: predecessor.handoff_manifest_hash,
        successor_receipt_path: null,
        successor_receipt_hash: null,
        last_compaction: null,
        created_at: now,
        updated_at: now
      };
      return {
        ...registry,
        revision: registry.revision + 1,
        sessions: {
          ...registry.sessions,
          [predecessorId]: { ...predecessor, replaced_by_session_id: successorId, updated_at: now },
          [successorId]: successor
        },
        updated_at: now
      };
    }
    function verifySuccessorReceipt(inputRegistry, input) {
      const registry = normalizeRegistry(inputRegistry);
      const successorId = nonempty(input?.successor_session_id, "successor_session_id");
      const receipt = input?.receipt;
      if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
        throw new TypeError("receipt must be an object");
      }
      const successor = registry.sessions[successorId];
      if (!successor || successor.rotation_state !== "successor_warming") {
        throw new Error(`successor ${successorId} is not warming`);
      }
      const predecessor = registry.sessions[successor.replaces_session_id];
      const reasons = [];
      if (receipt.agent_id !== successor.agent_id) reasons.push("agent_id_mismatch");
      if (receipt.expected_generation !== successor.session_generation) reasons.push("expected_generation_mismatch");
      if (receipt.observed_generation !== successor.session_generation) reasons.push("observed_generation_mismatch");
      if (receipt.handoff_manifest_hash !== predecessor?.handoff_manifest_hash) reasons.push("manifest_hash_mismatch");
      if (receipt.ready_to_assume_ownership !== true) reasons.push("successor_not_ready");
      if (!Array.isArray(receipt.evidence_checked) || receipt.evidence_checked.length === 0) reasons.push("evidence_not_checked");
      if (typeof receipt.next_action !== "string" || !receipt.next_action.trim()) reasons.push("next_action_missing");
      return { valid: reasons.length === 0, reasons, successor: clone(successor) };
    }
    function markSuccessorVerified(inputRegistry, input) {
      const verification = verifySuccessorReceipt(inputRegistry, input);
      if (!verification.valid) {
        const error = new Error(`successor receipt rejected: ${verification.reasons.join(", ")}`);
        error.code = "SESSION_ROTATION_RECEIPT_REJECTED";
        error.reasons = verification.reasons;
        throw error;
      }
      const receiptPath = nonempty(input?.receipt_path, "receipt_path");
      const receiptHash = nonempty(input?.receipt_hash, "receipt_hash");
      return transitionSession(
        inputRegistry,
        { ...input, session_id: input.successor_session_id },
        ["successor_warming"],
        () => ({
          rotation_state: "successor_verified",
          successor_receipt_path: receiptPath,
          successor_receipt_hash: receiptHash
        })
      );
    }
    function activateSessionSuccessor(inputRegistry, input) {
      const registry = normalizeRegistry(inputRegistry);
      const successorId = nonempty(input?.successor_session_id, "successor_session_id");
      const now = timestamp(input?.observed_at, "observed_at");
      if (input.expected_revision !== void 0 && input.expected_revision !== registry.revision) {
        const error = new Error(`session rotation revision conflict: expected ${input.expected_revision}, observed ${registry.revision}`);
        error.code = "SESSION_ROTATION_REVISION_CONFLICT";
        throw error;
      }
      const successor = registry.sessions[successorId];
      if (!successor || successor.rotation_state !== "successor_verified") {
        throw new Error(`successor ${successorId} is not verified`);
      }
      const predecessorId = successor.replaces_session_id;
      const predecessor = registry.sessions[predecessorId];
      if (!predecessor || predecessor.ownership_status !== "owner") {
        throw new Error(`predecessor ${predecessorId} is not the current owner`);
      }
      return {
        ...registry,
        revision: registry.revision + 1,
        sessions: {
          ...registry.sessions,
          [predecessorId]: {
            ...predecessor,
            rotation_state: "superseded",
            ownership_status: "superseded",
            accepts_new_work: false,
            updated_at: now
          },
          [successorId]: {
            ...successor,
            rotation_state: "active",
            ownership_status: "owner",
            accepts_new_work: true,
            updated_at: now
          }
        },
        updated_at: now
      };
    }
    function selectActiveAgentSession(sessions, agentId) {
      const targetAgentId = nonempty(agentId, "agent_id");
      const candidates = (Array.isArray(sessions) ? sessions : []).filter((session) => session && session.agent_id === targetAgentId).filter((session) => !["superseded", "failed"].includes(session.rotation_state)).filter((session) => session.binding_status === void 0 || session.binding_status === "bound");
      const explicitOwners = candidates.filter((session) => session.ownership_status === "owner");
      const pool = explicitOwners.length ? explicitOwners : candidates.filter((session) => session.ownership_status !== "candidate");
      if (!pool.length) return null;
      const ordered = [...pool].sort((left, right) => {
        const generationDelta = (Number(right.session_generation) || 1) - (Number(left.session_generation) || 1);
        if (generationDelta) return generationDelta;
        return Date.parse(right.updated_at ?? "") - Date.parse(left.updated_at ?? "");
      });
      if (explicitOwners.length > 1) {
        const topGeneration = Number(ordered[0].session_generation) || 1;
        const sameGenerationOwners = explicitOwners.filter((session) => (Number(session.session_generation) || 1) === topGeneration);
        if (sameGenerationOwners.length > 1) {
          const error = new Error(`multiple active owners for agent ${targetAgentId}`);
          error.code = "SESSION_ROTATION_MULTIPLE_OWNERS";
          throw error;
        }
      }
      return clone(ordered[0]);
    }
    module2.exports = {
      DEFAULT_SESSION_ROTATION_POLICY,
      ROTATION_STATES,
      activateSessionSuccessor,
      beginSessionDrain,
      createSessionRotationRegistry,
      markSessionCheckpointed,
      markSuccessorVerified,
      normalizeRotationPolicy,
      recordCompaction,
      registerSessionSuccessor,
      rotationStateForCount,
      selectActiveAgentSession,
      verifySuccessorReceipt
    };
  }
});

// packages/project-structure/src/audit.js
var require_audit = __commonJS({
  "packages/project-structure/src/audit.js"(exports2, module2) {
    "use strict";
    function compareText(left, right) {
      return left < right ? -1 : left > right ? 1 : 0;
    }
    var SEVERITY_ORDER = /* @__PURE__ */ new Map([["error", 0], ["warning", 1], ["suggestion", 2]]);
    function issue(severity, code, message, sourceRefs = [], details = {}) {
      return {
        severity,
        code,
        message,
        source_refs: [...new Set(sourceRefs)].sort(compareText),
        details
      };
    }
    function groupBy(values, keyFor) {
      const result = /* @__PURE__ */ new Map();
      for (const value of values) {
        const key = keyFor(value);
        if (!result.has(key)) result.set(key, []);
        result.get(key).push(value);
      }
      return result;
    }
    function directDirectoryCounts(files) {
      const counts = /* @__PURE__ */ new Map();
      for (const file of files) {
        const parts = file.source_ref.split("/");
        const directory = parts.length === 1 ? "." : parts.slice(0, -1).join("/");
        counts.set(directory, (counts.get(directory) || 0) + 1);
      }
      return counts;
    }
    function auditProjectStructure({ inventory, layout, lifecycleRegistry, wideDirectoryThreshold = 100 } = {}) {
      if (!inventory || !Array.isArray(inventory.files)) throw new TypeError("inventory is required");
      if (!layout || !lifecycleRegistry) throw new TypeError("layout and lifecycleRegistry are required");
      const issues = [];
      const filesByRef = new Map(inventory.files.map((file) => [file.source_ref, file]));
      const claimsByKey = groupBy(lifecycleRegistry.canonical_claims, (claim) => claim.claim_key);
      for (const [claimKey, claims] of claimsByKey) {
        const uniqueRefs = [...new Set(claims.map((claim) => claim.source_ref))];
        if (uniqueRefs.length > 1) {
          issues.push(issue(
            "error",
            "canonical_claim_conflict",
            `Multiple sources claim current authority for ${claimKey}.`,
            uniqueRefs,
            { claim_key: claimKey }
          ));
        }
        for (const reference of uniqueRefs) {
          const file = filesByRef.get(reference);
          if (!file) {
            issues.push(issue(
              "error",
              "canonical_claim_missing_source",
              `Canonical claim ${claimKey} points to a missing or skipped source.`,
              [reference],
              { claim_key: claimKey }
            ));
          } else if (file.lifecycle !== "current") {
            issues.push(issue(
              "error",
              "canonical_claim_not_current",
              `Canonical claim ${claimKey} points to a ${file.lifecycle} source.`,
              [reference],
              { claim_key: claimKey, lifecycle: file.lifecycle }
            ));
          } else if (file.read_policy === "never") {
            issues.push(issue(
              "error",
              "canonical_claim_never_read",
              `Canonical claim ${claimKey} is blocked from all normal reads.`,
              [reference],
              { claim_key: claimKey }
            ));
          }
        }
      }
      const supersededReadable = inventory.files.filter((file) => file.lifecycle === "superseded" && ["bootstrap_candidate", "task_candidate"].includes(file.read_policy));
      if (supersededReadable.length > 0) {
        issues.push(issue(
          "error",
          "superseded_source_is_read_candidate",
          `${supersededReadable.length} superseded sources remain normal read candidates.`,
          supersededReadable.slice(0, 30).map((file) => file.source_ref),
          { count: supersededReadable.length }
        ));
      }
      const derivedReadable = inventory.files.filter((file) => file.authority === "derived" && ["bootstrap_candidate", "task_candidate"].includes(file.read_policy));
      if (derivedReadable.length > 0) {
        issues.push(issue(
          "warning",
          "derived_source_is_read_candidate",
          `${derivedReadable.length} derived sources remain normal read candidates.`,
          derivedReadable.slice(0, 30).map((file) => file.source_ref),
          { count: derivedReadable.length }
        ));
      }
      const unclassified = inventory.files.filter((file) => file.unclassified);
      if (unclassified.length > 0) {
        issues.push(issue(
          "warning",
          "unclassified_sources",
          `${unclassified.length} sources are outside declared component rules.`,
          unclassified.slice(0, 30).map((file) => file.source_ref),
          { count: unclassified.length }
        ));
      }
      const runtimeEphemeral = inventory.files.filter((file) => file.source_ref.startsWith(".orquesta/state/") && (file.source_ref.endsWith(".bak") || /\.tmp(?:[-.].*)?$/u.test(file.source_ref)));
      if (runtimeEphemeral.length > 0) {
        issues.push(issue(
          "warning",
          "runtime_ephemeral_next_to_canonical_state",
          `${runtimeEphemeral.length} backup or temporary files sit beside canonical runtime state.`,
          runtimeEphemeral.slice(0, 30).map((file) => file.source_ref),
          { count: runtimeEphemeral.length }
        ));
      }
      const duplicateGroups = [...groupBy(
        inventory.files.filter((file) => file.sha256 && file.authority !== "derived" && file.lifecycle === "current"),
        (file) => file.sha256
      ).entries()].filter(([, files]) => files.length > 1);
      for (const [hash, files] of duplicateGroups.slice(0, 20)) {
        issues.push(issue(
          "suggestion",
          "duplicate_current_content",
          "Multiple current non-derived sources have identical content.",
          files.map((file) => file.source_ref),
          { sha256: hash, count: files.length }
        ));
      }
      const wideDirectories = [...directDirectoryCounts(inventory.files).entries()].filter(([, count]) => count > wideDirectoryThreshold).sort((left, right) => right[1] - left[1] || compareText(left[0], right[0]));
      for (const [directory, count] of wideDirectories.slice(0, 20)) {
        issues.push(issue(
          "warning",
          "wide_directory",
          `Directory contains ${count} direct files and should be reviewed for component boundaries.`,
          [directory],
          { direct_file_count: count, threshold: wideDirectoryThreshold }
        ));
      }
      issues.sort((left, right) => SEVERITY_ORDER.get(left.severity) - SEVERITY_ORDER.get(right.severity) || compareText(left.code, right.code) || compareText(left.source_refs[0] || "", right.source_refs[0] || ""));
      const counts = { error: 0, warning: 0, suggestion: 0 };
      for (const item of issues) counts[item.severity] += 1;
      return Object.freeze({
        schema_version: 1,
        mode: "shadow",
        project_id: layout.project_id,
        generated_at: inventory.generated_at,
        blocked: counts.error > 0,
        summary: {
          ...counts,
          issue_count: issues.length,
          indexed_files: inventory.stats.indexed_files,
          unclassified_files: inventory.stats.unclassified_files
        },
        issues
      });
    }
    module2.exports = { auditProjectStructure };
  }
});

// packages/project-structure/src/patterns.js
var require_patterns = __commonJS({
  "packages/project-structure/src/patterns.js"(exports2, module2) {
    "use strict";
    var path = require("node:path");
    function normalizeRef(value) {
      if (typeof value !== "string") throw new TypeError("path reference must be a string");
      const slashed = value.replace(/\\/gu, "/").replace(/^\.\//u, "");
      if (!slashed || slashed === ".") return ".";
      const normalized = path.posix.normalize(slashed).replace(/^\/+|\/+$/gu, "");
      if (!normalized || normalized === ".") return ".";
      if (normalized === ".." || normalized.startsWith("../") || /^[A-Za-z]:\//u.test(normalized)) {
        throw new RangeError(`path reference escapes the project: ${value}`);
      }
      return normalized;
    }
    function escapeRegexCharacter(character) {
      return /[|\\{}()[\]^$+?.]/u.test(character) ? `\\${character}` : character;
    }
    function globToRegExp(pattern) {
      const source = String(pattern || "").replace(/\\/gu, "/").replace(/^\.\//u, "");
      let output = "^";
      for (let index = 0; index < source.length; index += 1) {
        const character = source[index];
        if (character === "*" && source[index + 1] === "*") {
          if (source[index + 2] === "/") {
            output += "(?:.*/)?";
            index += 2;
          } else {
            output += ".*";
            index += 1;
          }
        } else if (character === "*") {
          output += "[^/]*";
        } else if (character === "?") {
          output += "[^/]";
        } else {
          output += escapeRegexCharacter(character);
        }
      }
      output += "$";
      return new RegExp(output, "u");
    }
    var cache = /* @__PURE__ */ new Map();
    function matchesGlob(reference, pattern) {
      const ref = normalizeRef(reference);
      const rawPattern = String(pattern || "").replace(/\\/gu, "/").replace(/^\.\//u, "");
      const variants = [rawPattern];
      if (rawPattern.endsWith("/**")) variants.push(rawPattern.slice(0, -3));
      return variants.some((variant) => {
        const key = variant;
        if (!cache.has(key)) cache.set(key, globToRegExp(variant));
        return cache.get(key).test(ref);
      });
    }
    function matchesAny(reference, patterns) {
      return (Array.isArray(patterns) ? patterns : []).some((pattern) => matchesGlob(reference, pattern));
    }
    function relativeToRoot(reference, root) {
      const ref = normalizeRef(reference);
      const normalizedRoot = normalizeRef(root);
      if (normalizedRoot === ".") return ref;
      if (ref === normalizedRoot) return ".";
      if (!ref.startsWith(`${normalizedRoot}/`)) return null;
      return ref.slice(normalizedRoot.length + 1);
    }
    module2.exports = {
      globToRegExp,
      matchesAny,
      matchesGlob,
      normalizeRef,
      relativeToRoot
    };
  }
});

// packages/project-structure/src/inventory.js
var require_inventory = __commonJS({
  "packages/project-structure/src/inventory.js"(exports2, module2) {
    "use strict";
    var crypto = require("node:crypto");
    var fs = require("node:fs");
    var path = require("node:path");
    var { assertContract } = require_src();
    var { matchesAny, normalizeRef, relativeToRoot } = require_patterns();
    var HARD_IGNORED_DIRECTORY_NAMES = /* @__PURE__ */ new Set([".git", "node_modules"]);
    var DEFAULT_MAX_HASH_BYTES = 8 * 1024 * 1024;
    var TEXT_EXTENSIONS = /* @__PURE__ */ new Set([
      ".c",
      ".cjs",
      ".cpp",
      ".css",
      ".csv",
      ".h",
      ".html",
      ".js",
      ".json",
      ".jsonl",
      ".jsx",
      ".md",
      ".mjs",
      ".ps1",
      ".py",
      ".sh",
      ".sql",
      ".toml",
      ".ts",
      ".tsx",
      ".txt",
      ".xml",
      ".yaml",
      ".yml"
    ]);
    function compareText(left, right) {
      return left < right ? -1 : left > right ? 1 : 0;
    }
    function safeWorkspaceRoot(workspaceRoot) {
      if (typeof workspaceRoot !== "string" || !workspaceRoot) throw new TypeError("workspaceRoot is required");
      const resolved = fs.realpathSync(workspaceRoot);
      if (!fs.statSync(resolved).isDirectory()) throw new TypeError("workspaceRoot must be a directory");
      return resolved;
    }
    function componentMatch(reference, component) {
      const candidates = [];
      for (const root of component.roots) {
        const relative = relativeToRoot(reference, root);
        if (relative === null) continue;
        const included = component.include.length === 0 || matchesAny(relative, component.include);
        const excluded = matchesAny(relative, component.exclude);
        if (included && !excluded) candidates.push({ component, root: normalizeRef(root), relative });
      }
      return candidates.sort((left, right) => right.root.length - left.root.length)[0] || null;
    }
    function findComponent(reference, components) {
      const matches = components.map((component, index) => ({ ...componentMatch(reference, component), index })).filter((item) => item.component).sort((left, right) => right.root.length - left.root.length || left.index - right.index || compareText(left.component.component_id, right.component.component_id));
      return matches[0] || null;
    }
    function applicableRules(reference, rules) {
      return (Array.isArray(rules) ? rules : []).filter((rule) => matchesAny(reference, rule.match));
    }
    function classifyReference(reference, layout, lifecycleRegistry) {
      const ref = normalizeRef(reference);
      const componentMatchValue = findComponent(ref, layout.components);
      const component = componentMatchValue?.component || null;
      const classification = {
        component_id: component?.component_id || null,
        lifecycle: component?.default_lifecycle || "current",
        authority: component?.default_authority || "supporting",
        read_policy: component?.default_read_policy || "explicit_only",
        storage_policy: "versioned",
        unclassified: component === null,
        matched_rule_ids: [],
        classification_reason: component ? `component:${component.component_id}` : "no_declared_component"
      };
      for (const rule of applicableRules(ref, lifecycleRegistry.rules)) {
        classification.lifecycle = rule.lifecycle;
        classification.authority = rule.authority;
        classification.read_policy = rule.read_policy;
        classification.storage_policy = rule.storage_policy;
        classification.matched_rule_ids.push(rule.rule_id);
        classification.classification_reason = `rule:${rule.rule_id}`;
      }
      const override = lifecycleRegistry.overrides.find((item) => normalizeRef(item.source_ref) === ref);
      if (override) {
        classification.lifecycle = override.lifecycle;
        classification.authority = override.authority;
        classification.read_policy = override.read_policy;
        classification.storage_policy = override.storage_policy;
        classification.classification_reason = `override:${override.source_ref}`;
      }
      const claimKeys = lifecycleRegistry.canonical_claims.filter((claim) => normalizeRef(claim.source_ref) === ref).map((claim) => claim.claim_key).sort(compareText);
      if (claimKeys.length > 0) classification.authority = "canonical";
      return Object.freeze({ ...classification, claim_keys: Object.freeze(claimKeys) });
    }
    function isGeneratedDirectory(reference, layout, classification) {
      return matchesAny(reference, layout.generated_roots) || classification.authority === "derived" && classification.read_policy === "never";
    }
    function fileHash(absolutePath, size, maxHashBytes) {
      if (size > maxHashBytes) return { hash: null, hash_state: "skipped_large" };
      const hash = crypto.createHash("sha256").update(fs.readFileSync(absolutePath)).digest("hex");
      return { hash, hash_state: "hashed" };
    }
    function scanProjectStructure({
      workspaceRoot,
      layout,
      lifecycleRegistry,
      generatedAt,
      maxHashBytes = DEFAULT_MAX_HASH_BYTES
    } = {}) {
      const root = safeWorkspaceRoot(workspaceRoot);
      const validatedLayout = assertContract("project-layout", layout);
      const validatedLifecycle = assertContract("lifecycle-registry", lifecycleRegistry);
      const files = [];
      const skipped = [];
      function visit(absoluteDirectory, relativeDirectory = ".") {
        const entries = fs.readdirSync(absoluteDirectory, { withFileTypes: true }).sort((left, right) => compareText(left.name, right.name));
        for (const entry of entries) {
          const reference = normalizeRef(relativeDirectory === "." ? entry.name : `${relativeDirectory}/${entry.name}`);
          const absolutePath = path.join(absoluteDirectory, entry.name);
          if (entry.isSymbolicLink()) {
            skipped.push({ source_ref: reference, kind: "symlink", reason: "symlink_not_followed" });
            continue;
          }
          if (entry.isDirectory()) {
            const classification2 = classifyReference(reference, validatedLayout, validatedLifecycle);
            if (HARD_IGNORED_DIRECTORY_NAMES.has(entry.name) || isGeneratedDirectory(reference, validatedLayout, classification2)) {
              skipped.push({
                source_ref: reference,
                kind: "directory",
                reason: HARD_IGNORED_DIRECTORY_NAMES.has(entry.name) ? "hard_ignore" : "generated_or_never_read",
                component_id: classification2.component_id
              });
              continue;
            }
            visit(absolutePath, reference);
            continue;
          }
          if (!entry.isFile()) {
            skipped.push({ source_ref: reference, kind: "other", reason: "unsupported_file_type" });
            continue;
          }
          if (reference === ".git") {
            skipped.push({ source_ref: reference, kind: "worktree_pointer", reason: "hard_ignore" });
            continue;
          }
          const stat = fs.statSync(absolutePath);
          const classification = classifyReference(reference, validatedLayout, validatedLifecycle);
          const hash = fileHash(absolutePath, stat.size, maxHashBytes);
          files.push({
            source_ref: reference,
            component_id: classification.component_id,
            lifecycle: classification.lifecycle,
            authority: classification.authority,
            read_policy: classification.read_policy,
            storage_policy: classification.storage_policy,
            unclassified: classification.unclassified,
            matched_rule_ids: [...classification.matched_rule_ids],
            classification_reason: classification.classification_reason,
            claim_keys: [...classification.claim_keys],
            extension: path.posix.extname(reference).toLowerCase(),
            size_bytes: stat.size,
            mtime_ms: Math.trunc(stat.mtimeMs),
            sha256: hash.hash,
            hash_state: hash.hash_state
          });
        }
      }
      visit(root);
      files.sort((left, right) => compareText(left.source_ref, right.source_ref));
      skipped.sort((left, right) => compareText(left.source_ref, right.source_ref));
      const componentCounts = {};
      for (const file of files) {
        const key = file.component_id || "unclassified";
        componentCounts[key] = (componentCounts[key] || 0) + 1;
      }
      const totalBytes = files.reduce((sum, file) => sum + file.size_bytes, 0);
      const inventory = {
        schema_version: 1,
        mode: "shadow",
        project_id: validatedLayout.project_id,
        manifest_status: validatedLayout.status,
        generated_at: generatedAt || (/* @__PURE__ */ new Date()).toISOString(),
        stats: {
          indexed_files: files.length,
          indexed_bytes: totalBytes,
          hashed_files: files.filter((file) => file.hash_state === "hashed").length,
          unhashed_large_files: files.filter((file) => file.hash_state === "skipped_large").length,
          unclassified_files: files.filter((file) => file.unclassified).length,
          skipped_entries: skipped.length,
          component_counts: componentCounts
        },
        files,
        skipped
      };
      return Object.freeze(inventory);
    }
    function createLifecycleProjection(inventory) {
      const selected = [];
      const excluded = [];
      for (const file of inventory.files) {
        let reason = null;
        if (["archived", "quarantined", "delete_candidate", "superseded"].includes(file.lifecycle)) reason = file.lifecycle;
        else if (file.read_policy === "never" || file.read_policy === "explicit_only") reason = file.read_policy;
        else if (file.authority === "derived") reason = "derived";
        if (reason) excluded.push({ source_ref: file.source_ref, reason });
        else selected.push({
          source_ref: file.source_ref,
          component_id: file.component_id,
          authority: file.authority,
          lifecycle: file.lifecycle,
          read_policy: file.read_policy,
          token_estimate: TEXT_EXTENSIONS.has(file.extension) ? Math.max(1, Math.ceil(file.size_bytes / 4)) : 64,
          sha256: file.sha256
        });
      }
      return Object.freeze({
        schema_version: 1,
        mode: "shadow",
        generated_at: inventory.generated_at,
        selected,
        excluded,
        stats: {
          selected_files: selected.length,
          excluded_files: excluded.length,
          selected_token_estimate: selected.reduce((sum, file) => sum + file.token_estimate, 0)
        }
      });
    }
    module2.exports = {
      classifyReference,
      createLifecycleProjection,
      scanProjectStructure
    };
  }
});

// packages/project-structure/src/report.js
var require_report = __commonJS({
  "packages/project-structure/src/report.js"(exports2, module2) {
    "use strict";
    function formatBytes(bytes) {
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
      return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
    }
    function renderIssue(item) {
      const refs = item.source_refs.length > 0 ? `
  - \u5BFE\u8C61: ${item.source_refs.slice(0, 8).map((ref) => `\`${ref}\``).join(", ")}` : "";
      const count = Number.isInteger(item.details?.count) ? `\uFF08${item.details.count}\u4EF6\uFF09` : "";
      return `- [${item.severity}] \`${item.code}\`${count}: ${item.message}${refs}`;
    }
    function renderShadowAuditReport({ inventory, audit, projection, layoutPath, lifecyclePath } = {}) {
      const components = Object.entries(inventory.stats.component_counts).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).map(([name, count]) => `| \`${name}\` | ${count} |`).join("\n");
      const issues = audit.issues.length > 0 ? audit.issues.map(renderIssue).join("\n") : "- \u554F\u984C\u306F\u691C\u51FA\u3055\u308C\u306A\u304B\u3063\u305F\u3002";
      return `# Project Structure Phase 1 shadow audit

- \u751F\u6210\u65E5\u6642: ${inventory.generated_at}
- project: \`${inventory.project_id}\`
- manifest: \`${layoutPath}\`
- lifecycle: \`${lifecyclePath}\`

## \u7D50\u8AD6

\u3053\u306E\u76E3\u67FB\u306Fshadow\u5B9F\u884C\u3067\u3042\u308A\u3001\u65E2\u5B58\u30D5\u30A1\u30A4\u30EB\u306E\u79FB\u52D5\u3001\u524A\u9664\u3001Context V2\u306E\u5207\u66FF\u3001Desktop\u5909\u66F4\u3092\u884C\u3063\u3066\u3044\u306A\u3044\u3002

\u76E3\u67FB\u72B6\u614B: ${audit.blocked ? "\u6B63\u672C\u307E\u305F\u306F\u8AAD\u53D6\u5883\u754C\u306B\u8981\u4FEE\u6B63\u9805\u76EE\u3042\u308A" : "hard blocker\u306A\u3057"}

## \u96C6\u8A08

- \u7D22\u5F15\u30D5\u30A1\u30A4\u30EB: ${inventory.stats.indexed_files}
- \u7D22\u5F15\u5BB9\u91CF: ${formatBytes(inventory.stats.indexed_bytes)}
- hash\u8A08\u6E2C: ${inventory.stats.hashed_files}
- \u5927\u5BB9\u91CF\u306E\u305F\u3081hash\u672A\u8A08\u6E2C: ${inventory.stats.unhashed_large_files}
- \u672A\u5206\u985E: ${inventory.stats.unclassified_files}
- \u8D70\u67FB\u3092\u7701\u7565\u3057\u305F\u9818\u57DF: ${inventory.stats.skipped_entries}
- \u65B0\u3057\u3044\u8AAD\u53D6\u5019\u88DC: ${projection.stats.selected_files}
- \u660E\u793A\u6642\u3060\u3051\u8AAD\u3080\u3001\u307E\u305F\u306F\u9664\u5916: ${projection.stats.excluded_files}
- \u8AAD\u53D6\u5019\u88DC\u306E\u6982\u7B97token: ${projection.stats.selected_token_estimate}

## \u30B3\u30F3\u30DD\u30FC\u30CD\u30F3\u30C8

| component | files |
|---|---:|
${components}

## \u691C\u51FA\u4E8B\u9805

${issues}

## \u3053\u306E\u6BB5\u968E\u3067\u884C\u3063\u3066\u3044\u306A\u3044\u3053\u3068

- \u30D5\u30A1\u30A4\u30EB\u79FB\u52D5
- \u30D5\u30A1\u30A4\u30EB\u524A\u9664
- lifecycle\u306E\u672C\u756A\u6709\u52B9\u5316
- Source Catalog V2\u3078\u306E\u63A5\u7D9A
- specialist handoff\u306E\u5909\u66F4
- Desktop\u8868\u793A\u306E\u5909\u66F4

## \u6B21\u306E\u5224\u65AD

\u307E\u305Amanifest\u306E\u5206\u985E\u3068\u691C\u51FA\u4E8B\u9805\u3092\u30E6\u30FC\u30B6\u30FC\u304C\u78BA\u8A8D\u3059\u308B\u3002\u627F\u8A8D\u5F8C\u306B\u6BB5\u968E2\u3068\u3057\u3066Lifecycle Projection\u3092Context V2\u306E\u5019\u88DC\u751F\u6210\u3078\u63A5\u7D9A\u3059\u308B\u3002
`;
    }
    function renderLifecycleContextReport({ inventory, projection, audit, boundary, sourceCatalog, projectMap, projectMapView } = {}) {
      const exclusionCounts = {};
      for (const entry of boundary.exclusions) exclusionCounts[entry.reason] = (exclusionCounts[entry.reason] || 0) + 1;
      const exclusions = Object.entries(exclusionCounts).sort(([left], [right]) => left.localeCompare(right)).map(([reason, count]) => `| \`${reason}\` | ${count} |`).join("\n") || "| \u306A\u3057 | 0 |";
      const components = projectMap?.lifecycle_summary?.components || [];
      const componentRows = components.map((component) => `| \`${component.component_id}\` | ${component.indexed_sources} | ${component.candidate_sources} | ${component.excluded_sources} |`).join("\n") || "| \u306A\u3057 | 0 | 0 | 0 |";
      const canonicalErrors = boundary.canonical_claim_errors.length > 0 ? boundary.canonical_claim_errors.map((entry) => `- \`${entry.code}\` / \`${entry.claim_key}\`: ${entry.source_refs.join(", ")}`).join("\n") : "- \u7AF6\u5408\u306A\u3057";
      const effectiveSources = sourceCatalog.records.filter((record) => record.status === "current").length;
      const projectMapViewBytes = projectMapView ? Buffer.byteLength(`${JSON.stringify(projectMapView, null, 2)}
`, "utf8") : 0;
      return `# Project Structure Phase 2 Context V2 shadow report

- \u751F\u6210\u65E5\u6642: ${inventory.generated_at}
- project: \`${inventory.project_id}\`

## \u7D50\u8AD6

Lifecycle Projection\u3092Context V2\u306ESource Catalog\u3068Project Map\u3078shadow\u63A5\u7D9A\u3057\u305F\u3002\u672C\u756A\u306E\`.orquesta/context/source_catalog.json\`\u3001\u65E2\u5B58Context Pack\u3001\u7269\u7406\u30D5\u30A1\u30A4\u30EB\u306F\u5909\u66F4\u3057\u3066\u3044\u306A\u3044\u3002

shadow\u72B6\u614B: ${audit.blocked ? "blocked" : "ready"}

## \u8AAD\u53D6\u5883\u754C

- \u7D22\u5F15\u30D5\u30A1\u30A4\u30EB: ${inventory.stats.indexed_files}
- lifecycle\u5019\u88DC: ${projection.stats.selected_files}
- lifecycle\u9664\u5916: ${projection.stats.excluded_files}
- \u6709\u52B9\u306Ashadow Source Record: ${effectiveSources}
- \u5019\u88DC\u306E\u6982\u7B97token: ${projection.stats.selected_token_estimate}
- \u65E2\u5B58catalog\u306Ecurrent source: ${boundary.previous_current_sources}
- Project Map: ${projectMap?.project_map_id || "\u672A\u751F\u6210"}
- lifecycle overlay: ${projectMap?.lifecycle_overlay_id || "\u672A\u751F\u6210"}
- \u7D71\u62EC\u8005\u5411\u3051Project Map View: ${projectMapView?.project_map_view_id || "\u672A\u751F\u6210"} / ${formatBytes(projectMapViewBytes)} / \u7D04${Math.ceil(projectMapViewBytes / 4)} token

\u3053\u3053\u3067\u3044\u3046\u5019\u88DC\u306E\u6982\u7B97token\u306F\u3001Source Catalog\u304C\u691C\u7D22\u3067\u304D\u308B\u5168\u5019\u88DC\u306E\u5408\u8A08\u3067\u3042\u308A\u3001\u5404\u30A8\u30FC\u30B8\u30A7\u30F3\u30C8\u3078\u4E00\u62EC\u6295\u5165\u3059\u308B\u91CF\u3067\u306F\u306A\u3044\u3002\u521D\u671F\u8AAD\u53D6\u306B\u306F\u4E0A\u8A18\u306E\u77ED\u3044Project Map View\u3068\u3001\u30BF\u30B9\u30AF\u3054\u3068\u306B\u9078\u3070\u308C\u305FContext Pack\u3060\u3051\u3092\u4F7F\u3046\u3002

## \u9664\u5916\u7406\u7531

| reason | files |
|---|---:|
${exclusions}

## \u6B63\u672C\u7AF6\u5408

${canonicalErrors}

## \u30B3\u30F3\u30DD\u30FC\u30CD\u30F3\u30C8\u5225\u306E\u8AAD\u53D6\u5019\u88DC

| component | indexed | candidate | excluded |
|---|---:|---:|---:|
${componentRows}

## \u3053\u306E\u6BB5\u968E\u3067\u884C\u3063\u3066\u3044\u306A\u3044\u3053\u3068

- production Source Catalog\u306E\u4E0A\u66F8\u304D
- Context Pack V2\u306E\u672C\u756A\u5207\u66FF
- \u30D5\u30A1\u30A4\u30EB\u79FB\u52D5\u307E\u305F\u306F\u524A\u9664
- Desktop\u5909\u66F4
`;
    }
    module2.exports = { renderLifecycleContextReport, renderShadowAuditReport };
  }
});

// packages/project-structure/src/context-v2.js
var require_context_v2 = __commonJS({
  "packages/project-structure/src/context-v2.js"(exports2, module2) {
    "use strict";
    var { assertContract, canonicalHash } = require_src();
    function compareText(left, right) {
      return left < right ? -1 : left > right ? 1 : 0;
    }
    function countBy(values, keyFor) {
      const counts = {};
      for (const value of values) {
        const key = keyFor(value) || "unclassified";
        counts[key] = (counts[key] || 0) + 1;
      }
      return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => compareText(left, right)));
    }
    function canonicalClaimErrors(audit) {
      return audit.issues.filter((item) => item.severity === "error" && item.code.startsWith("canonical_claim_")).map((item) => ({
        code: item.code,
        claim_key: String(item.details?.claim_key || "unknown"),
        source_refs: [...item.source_refs].sort(compareText)
      })).sort((left, right) => compareText(`${left.claim_key}:${left.code}`, `${right.claim_key}:${right.code}`));
    }
    function createLifecycleReadBoundary({ inventory, projection, audit, previousRecords = [] } = {}) {
      if (!inventory || !Array.isArray(inventory.files)) throw new TypeError("inventory is required");
      if (!projection || !Array.isArray(projection.selected) || !Array.isArray(projection.excluded)) {
        throw new TypeError("projection is required");
      }
      if (!audit || !Array.isArray(audit.issues)) throw new TypeError("audit is required");
      const filesByRef = new Map(inventory.files.map((file) => [file.source_ref, file]));
      const candidateSourceRefs = projection.selected.map((file) => file.source_ref).sort(compareText);
      const candidateSet = new Set(candidateSourceRefs);
      const previous = Array.isArray(previousRecords) ? previousRecords : [];
      const eligiblePreviousRecords = previous.filter((record) => candidateSet.has(record.source_ref));
      const exclusions = projection.excluded.map((entry) => {
        const file = filesByRef.get(entry.source_ref);
        return {
          source_ref: entry.source_ref,
          reason: entry.reason,
          component_id: file?.component_id || null,
          lifecycle: file?.lifecycle || "current",
          authority: file?.authority || "supporting",
          read_policy: file?.read_policy || "explicit_only"
        };
      }).sort((left, right) => compareText(left.source_ref, right.source_ref));
      const errors = canonicalClaimErrors(audit);
      const boundary = {
        schema_version: 1,
        mode: "shadow",
        status: audit.blocked ? "blocked" : "ready",
        project_id: inventory.project_id,
        generated_at: inventory.generated_at,
        candidate_source_refs: Object.freeze(candidateSourceRefs),
        effective_source_refs: Object.freeze(audit.blocked ? [] : [...candidateSourceRefs]),
        previous_current_sources: previous.filter((record) => record.status === "current").length,
        exclusions: Object.freeze(exclusions),
        canonical_claim_errors: Object.freeze(errors)
      };
      Object.defineProperty(boundary, "eligible_previous_records", {
        value: Object.freeze(eligiblePreviousRecords),
        enumerable: false
      });
      return Object.freeze(boundary);
    }
    function createComponentLifecycleSummary(inventory, projection) {
      const selected = new Set(projection.selected.map((file) => file.source_ref));
      const grouped = /* @__PURE__ */ new Map();
      for (const file of inventory.files) {
        const componentId = file.component_id || "unclassified";
        if (!grouped.has(componentId)) grouped.set(componentId, []);
        grouped.get(componentId).push(file);
      }
      return [...grouped.entries()].map(([componentId, files]) => ({
        component_id: componentId,
        indexed_sources: files.length,
        candidate_sources: files.filter((file) => selected.has(file.source_ref)).length,
        excluded_sources: files.filter((file) => !selected.has(file.source_ref)).length,
        lifecycle_counts: countBy(files, (file) => file.lifecycle),
        authority_counts: countBy(files, (file) => file.authority),
        read_policy_counts: countBy(files, (file) => file.read_policy)
      })).sort((left, right) => compareText(left.component_id, right.component_id));
    }
    function enrichProjectMapWithLifecycle({ projectMap, inventory, projection, audit } = {}) {
      if (!projectMap || typeof projectMap !== "object") throw new TypeError("projectMap is required");
      const components = createComponentLifecycleSummary(inventory, projection);
      const lifecycleSummary = {
        mode: "shadow",
        status: audit.blocked ? "blocked" : "ready",
        inventory_generated_at: inventory.generated_at,
        indexed_sources: inventory.stats.indexed_files,
        candidate_sources: projection.stats.selected_files,
        excluded_sources: projection.stats.excluded_files,
        estimated_candidate_tokens: projection.stats.selected_token_estimate,
        lifecycle_counts: countBy(inventory.files, (file) => file.lifecycle),
        authority_counts: countBy(inventory.files, (file) => file.authority),
        read_policy_counts: countBy(inventory.files, (file) => file.read_policy),
        components
      };
      const overlayIdentity = {
        project_map_id: projectMap.project_map_id,
        status: lifecycleSummary.status,
        components
      };
      return Object.freeze({
        ...projectMap,
        global_summary: {
          ...projectMap.global_summary,
          lifecycle_candidate_source_count: projection.stats.selected_files,
          lifecycle_excluded_source_count: projection.stats.excluded_files
        },
        lifecycle_summary: lifecycleSummary,
        lifecycle_overlay_id: `LO-${canonicalHash(overlayIdentity).slice(0, 16)}`
      });
    }
    function createCompactProjectMapView(projectMap) {
      if (!projectMap || typeof projectMap !== "object") throw new TypeError("projectMap is required");
      const content = {
        version: 1,
        mode: "lifecycle_shadow",
        project_id: projectMap.project_id,
        project_map_id: projectMap.project_map_id,
        lifecycle_overlay_id: projectMap.lifecycle_overlay_id,
        revision: projectMap.revision,
        global_summary: projectMap.global_summary,
        components: (Array.isArray(projectMap.components) ? projectMap.components : []).map((component) => ({
          component: component.component,
          source_count: component.source_count,
          artifact_types: [...component.artifact_types],
          dependency_count: component.dependency_refs.length,
          summary: component.summary
        })),
        lifecycle_components: (projectMap.lifecycle_summary?.components || []).map((component) => ({
          component_id: component.component_id,
          indexed_sources: component.indexed_sources,
          candidate_sources: component.candidate_sources,
          excluded_sources: component.excluded_sources,
          lifecycle_counts: component.lifecycle_counts,
          authority_counts: component.authority_counts,
          read_policy_counts: component.read_policy_counts
        })),
        generated_at: projectMap.generated_at
      };
      const identity = { ...content };
      delete identity.generated_at;
      return Object.freeze({
        ...content,
        project_map_view_id: `PMV-${canonicalHash(identity).slice(0, 16)}`
      });
    }
    function createLifecycleContextReceipt({ boundary, projection, sourceCatalog = [], projectMap = null, createdAt } = {}) {
      if (!boundary || !projection) throw new TypeError("boundary and projection are required");
      const effective = (Array.isArray(sourceCatalog) ? sourceCatalog : []).filter((record) => record.status === "current");
      const content = {
        version: 1,
        mode: "shadow",
        status: boundary.status,
        project_id: boundary.project_id,
        inventory_generated_at: boundary.generated_at,
        project_map_id: projectMap?.project_map_id || null,
        lifecycle_overlay_id: projectMap?.lifecycle_overlay_id || null,
        source_catalog: {
          previous_current_sources: boundary.previous_current_sources,
          candidate_sources: boundary.candidate_source_refs.length,
          effective_sources: effective.length,
          excluded_sources: boundary.exclusions.length,
          estimated_candidate_tokens: projection.stats.selected_token_estimate
        },
        exclusions: [...boundary.exclusions],
        canonical_claim_errors: [...boundary.canonical_claim_errors],
        created_at: createdAt || (/* @__PURE__ */ new Date()).toISOString()
      };
      return Object.freeze(assertContract("lifecycle-context-receipt", {
        ...content,
        receipt_id: `LCR-${canonicalHash(content).slice(0, 12)}`
      }));
    }
    module2.exports = {
      createComponentLifecycleSummary,
      createCompactProjectMapView,
      createLifecycleContextReceipt,
      createLifecycleReadBoundary,
      enrichProjectMapWithLifecycle
    };
  }
});

// packages/project-structure/src/placement.js
var require_placement = __commonJS({
  "packages/project-structure/src/placement.js"(exports2, module2) {
    "use strict";
    var fs = require("node:fs");
    var path = require("node:path");
    var { assertContract, canonicalHash } = require_src();
    var { classifyReference } = require_inventory();
    var { normalizeRef } = require_patterns();
    function compareText(left, right) {
      return left < right ? -1 : left > right ? 1 : 0;
    }
    function issue(code, message, sourceRefs = []) {
      return {
        code,
        message,
        source_refs: [...new Set(sourceRefs)].sort(compareText)
      };
    }
    function safeReference(value) {
      if (typeof value !== "string" || /^[\\/]/u.test(value) || /^[A-Za-z]:/u.test(value)) {
        return { value: null, error: new RangeError(`path reference escapes the project: ${value}`) };
      }
      try {
        return { value: normalizeRef(value), error: null };
      } catch (error) {
        return { value: null, error };
      }
    }
    function taskSegment(taskId) {
      return String(taskId || "unassigned").replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "") || "unassigned";
    }
    function inboxTarget(request) {
      return `workbench/inbox/${taskSegment(request.task_id)}/${request.suggested_name}`;
    }
    function placementDefaults(request, component) {
      if (request.authority_intent === "canonical_update") {
        return { lifecycle: "current", authority: "canonical", read_policy: component?.default_read_policy || "task_candidate" };
      }
      if (request.authority_intent === "derived") {
        return {
          lifecycle: "current",
          authority: "derived",
          read_policy: component?.default_read_policy === "never" ? "never" : "explicit_only"
        };
      }
      if (request.authority_intent === "external") {
        return { lifecycle: "current", authority: "external", read_policy: "explicit_only" };
      }
      return {
        lifecycle: request.retention === "permanent" ? component?.default_lifecycle || "current" : "draft",
        authority: "supporting",
        read_policy: request.retention === "temporary" ? "explicit_only" : component?.default_read_policy || "task_candidate"
      };
    }
    function normalizedStem(reference) {
      return path.posix.basename(reference, path.posix.extname(reference)).toLowerCase().replace(/(?:^|[-_.])(?:v|version)?\d+(?:[-_.]\d+)*(?=$|[-_.])/gu, "-").replace(/(?:^|[-_.])\d{4}[-_.]\d{2}[-_.]\d{2}(?=$|[-_.])/gu, "-").replace(/[-_.]+/gu, "-").replace(/^-+|-+$/gu, "");
    }
    function detectSupersedesCandidates({ targetPath, componentId, claimKey, inventory, lifecycleRegistry, explicitRefs = [] } = {}) {
      const candidates = /* @__PURE__ */ new Map();
      for (const reference of explicitRefs) {
        const safe = safeReference(reference);
        if (safe.value && safe.value !== targetPath) {
          candidates.set(safe.value, {
            source_ref: safe.value,
            reason: "Explicit replacement declared by the placement request.",
            confidence: "high"
          });
        }
      }
      if (claimKey) {
        for (const claim of lifecycleRegistry.canonical_claims.filter((entry) => entry.claim_key === claimKey)) {
          if (claim.source_ref !== targetPath) {
            candidates.set(claim.source_ref, {
              source_ref: claim.source_ref,
              reason: `Existing canonical source for ${claimKey}.`,
              confidence: "high"
            });
          }
        }
      }
      const stem = normalizedStem(targetPath || "");
      if (stem.length >= 4) {
        for (const file of inventory.files) {
          if (file.source_ref !== targetPath && file.component_id === componentId && file.lifecycle === "current" && path.posix.extname(file.source_ref).toLowerCase() === path.posix.extname(targetPath).toLowerCase() && normalizedStem(file.source_ref) === stem && !candidates.has(file.source_ref)) {
            candidates.set(file.source_ref, {
              source_ref: file.source_ref,
              reason: "Same normalized artifact name in the same component; manual supersedes review is required.",
              confidence: "low"
            });
          }
        }
      }
      return [...candidates.values()].sort((left, right) => compareText(left.source_ref, right.source_ref));
    }
    function auditCanonicalClaimsForPlacement({ workspaceRoot, layout, lifecycleRegistry } = {}) {
      const claims = /* @__PURE__ */ new Map();
      const issues = [];
      for (const claim of lifecycleRegistry.canonical_claims) {
        if (!claims.has(claim.claim_key)) claims.set(claim.claim_key, []);
        claims.get(claim.claim_key).push(claim.source_ref);
      }
      for (const [claimKey, refs] of claims) {
        const uniqueRefs = [...new Set(refs)].sort(compareText);
        if (uniqueRefs.length > 1) {
          issues.push({
            severity: "error",
            code: "canonical_claim_conflict",
            message: `Multiple sources claim current authority for ${claimKey}.`,
            source_refs: uniqueRefs,
            details: { claim_key: claimKey }
          });
          continue;
        }
        const reference = uniqueRefs[0];
        const absolute = path.resolve(workspaceRoot, ...reference.split("/"));
        if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
          issues.push({
            severity: "error",
            code: "canonical_claim_missing_source",
            message: `Canonical claim ${claimKey} points to a missing source.`,
            source_refs: [reference],
            details: { claim_key: claimKey }
          });
          continue;
        }
        const classification = classifyReference(reference, layout, lifecycleRegistry);
        if (classification.lifecycle !== "current") {
          issues.push({
            severity: "error",
            code: "canonical_claim_not_current",
            message: `Canonical claim ${claimKey} points to a ${classification.lifecycle} source.`,
            source_refs: [reference],
            details: { claim_key: claimKey }
          });
        } else if (classification.read_policy === "never") {
          issues.push({
            severity: "error",
            code: "canonical_claim_never_read",
            message: `Canonical claim ${claimKey} is blocked from normal reads.`,
            source_refs: [reference],
            details: { claim_key: claimKey }
          });
        }
      }
      return Object.freeze({ blocked: issues.length > 0, issues: Object.freeze(issues) });
    }
    function finalizeDecision(content) {
      const identity = { ...content };
      delete identity.created_at;
      return Object.freeze(assertContract("placement-decision", {
        ...content,
        decision_id: `PD-${canonicalHash(identity).slice(0, 12)}`
      }));
    }
    function resolvePlacement({ workspaceRoot, layout, lifecycleRegistry, inventory, audit, request } = {}) {
      if (typeof workspaceRoot !== "string" || !workspaceRoot) throw new TypeError("workspaceRoot is required");
      const validatedRequest = assertContract("placement-request", request);
      assertContract("project-layout", layout);
      assertContract("lifecycle-registry", lifecycleRegistry);
      if (!inventory || !Array.isArray(inventory.files)) throw new TypeError("inventory is required");
      const warnings = [];
      const hardErrors = (audit?.issues || []).filter((item) => item.severity === "error" && item.code.startsWith("canonical_claim_")).map((item) => issue(item.code, item.message, item.source_refs));
      const component = layout.components.find((entry) => entry.component_id === validatedRequest.target_component_id) || null;
      let target = validatedRequest.proposed_path;
      if (!component) {
        warnings.push(issue(
          validatedRequest.target_component_id ? "unknown_target_component" : "target_component_missing",
          "The target component is not declared, so the artifact remains in the placement inbox."
        ));
        target = inboxTarget(validatedRequest);
      } else if (!target) {
        target = normalizeRef(`${component.roots[0]}/${validatedRequest.suggested_name}`);
      }
      const safe = safeReference(target);
      if (!safe.value) {
        hardErrors.push(issue("project_write_escape", "The proposed output path escapes the declared project root.", [String(target)]));
        const defaults2 = placementDefaults(validatedRequest, component);
        return finalizeDecision({
          version: 1,
          task_id: validatedRequest.task_id,
          status: "blocked",
          target_path: null,
          component_id: component?.component_id || null,
          ...defaults2,
          supersedes: [],
          supersedes_candidates: [],
          warnings,
          hard_errors: hardErrors,
          reason: "Project-external writes are a hard placement boundary.",
          created_at: validatedRequest.created_at
        });
      }
      target = safe.value;
      const absoluteTarget = path.resolve(workspaceRoot, ...target.split("/"));
      const exists = fs.existsSync(absoluteTarget);
      let classification = classifyReference(target, layout, lifecycleRegistry);
      if (component && classification.component_id !== component.component_id) {
        warnings.push(issue(
          "component_path_mismatch",
          `The proposed path belongs to ${classification.component_id || "no declared component"}, not ${component.component_id}.`,
          [target]
        ));
        target = inboxTarget(validatedRequest);
        classification = classifyReference(target, layout, lifecycleRegistry);
      }
      if (validatedRequest.retention === "temporary") {
        warnings.push(issue("temporary_artifact_staged", "Temporary artifacts remain in the task-scoped placement inbox.", [target]));
        target = inboxTarget(validatedRequest);
        classification = classifyReference(target, layout, lifecycleRegistry);
      }
      const rootLevel = !target.includes("/");
      if (rootLevel && !exists && !validatedRequest.root_placement_reason && validatedRequest.authority_intent !== "canonical_update") {
        warnings.push(issue(
          "unjustified_root_placement",
          "A new root-level artifact requires an explicit project-level reason; it remains in the placement inbox.",
          [target]
        ));
        target = inboxTarget(validatedRequest);
        classification = classifyReference(target, layout, lifecycleRegistry);
      }
      if (target !== inboxTarget(validatedRequest) && classification.read_policy === "never" && validatedRequest.authority_intent !== "derived") {
        warnings.push(issue(
          "normal_artifact_in_never_read_area",
          "A non-derived artifact cannot be proposed inside a never-read generated area; it remains in the placement inbox.",
          [target]
        ));
        target = inboxTarget(validatedRequest);
        classification = classifyReference(target, layout, lifecycleRegistry);
      }
      const inbox = target.startsWith("workbench/inbox/");
      const resolvedComponent = inbox ? layout.components.find((entry) => entry.component_id === "placement-inbox") || null : component;
      const defaults = inbox ? { lifecycle: "draft", authority: "supporting", read_policy: "explicit_only" } : placementDefaults(validatedRequest, resolvedComponent);
      if (validatedRequest.authority_intent === "canonical_update" && !validatedRequest.claim_key) {
        warnings.push(issue(
          "canonical_claim_key_missing",
          "The canonical update has no claim key; only entry points, contracts, settings, and accepted decisions normally need one.",
          [target]
        ));
      }
      const supersedesCandidates = detectSupersedesCandidates({
        targetPath: target,
        componentId: resolvedComponent?.component_id || classification.component_id,
        claimKey: validatedRequest.claim_key,
        inventory,
        lifecycleRegistry,
        explicitRefs: validatedRequest.replaces
      });
      const explicitSet = new Set(validatedRequest.replaces.map((reference) => safeReference(reference).value).filter(Boolean));
      const supersedes = supersedesCandidates.filter((candidate) => explicitSet.has(candidate.source_ref)).map((candidate) => candidate.source_ref);
      const status = hardErrors.length > 0 ? "blocked" : inbox ? "inbox" : "proposed";
      return finalizeDecision({
        version: 1,
        task_id: validatedRequest.task_id,
        status,
        target_path: hardErrors.length > 0 ? null : target,
        component_id: resolvedComponent?.component_id || classification.component_id,
        ...defaults,
        supersedes,
        supersedes_candidates: supersedesCandidates,
        warnings,
        hard_errors: hardErrors,
        reason: inbox ? "The final component or safe path is not yet certain, so the artifact remains task-scoped and visible for completion review." : exists ? "The request updates an existing file inside its declared component." : "The requested component and proposed path agree with the project layout manifest.",
        created_at: validatedRequest.created_at
      });
    }
    function inspectTaskPlacementCompletion({ taskId, changedPaths, layout, lifecycleRegistry, inventory, audit, checkedAt } = {}) {
      const warnings = [];
      const hardErrors = (audit?.issues || []).filter((item) => item.severity === "error" && item.code.startsWith("canonical_claim_")).map((item) => issue(item.code, item.message, item.source_refs));
      const claimRefs = new Set(lifecycleRegistry.canonical_claims.map((claim) => claim.source_ref));
      for (const rawPath of [...new Set(Array.isArray(changedPaths) ? changedPaths : [])]) {
        const safe = safeReference(rawPath);
        if (!safe.value) {
          hardErrors.push(issue("project_write_escape", "A reported output path escapes the project root.", [String(rawPath)]));
          continue;
        }
        const reference = safe.value;
        const classification = classifyReference(reference, layout, lifecycleRegistry);
        if (classification.unclassified) {
          warnings.push(issue("unclassified_task_output", "The completed task produced a file outside declared components.", [reference]));
        }
        if (reference.startsWith("workbench/inbox/")) {
          warnings.push(issue("unresolved_placement_inbox", "The completed task still has an artifact in the placement inbox.", [reference]));
        }
        if (!reference.includes("/") && !claimRefs.has(reference)) {
          warnings.push(issue("root_level_output_review", "A root-level task output is not registered as a canonical project entry.", [reference]));
        }
      }
      return Object.freeze({
        schema_version: 1,
        mode: "completion_hook",
        task_id: String(taskId),
        status: hardErrors.length > 0 ? "blocked" : warnings.length > 0 ? "warnings" : "clear",
        checked_at: checkedAt || (/* @__PURE__ */ new Date()).toISOString(),
        changed_paths: [...new Set(Array.isArray(changedPaths) ? changedPaths : [])].sort(compareText),
        warnings,
        hard_errors: hardErrors,
        inventory_file_count: Array.isArray(inventory?.files) ? inventory.files.length : 0
      });
    }
    module2.exports = {
      auditCanonicalClaimsForPlacement,
      detectSupersedesCandidates,
      inspectTaskPlacementCompletion,
      resolvePlacement
    };
  }
});

// packages/project-structure/src/setup.js
var require_setup = __commonJS({
  "packages/project-structure/src/setup.js"(exports2, module2) {
    "use strict";
    var fs = require("node:fs");
    var path = require("node:path");
    var { assertContract, canonicalHash } = require_src();
    var { normalizeRef } = require_patterns();
    var PROJECT_STRUCTURE_TEMPLATE_VERSION = "project-structure-v1";
    var ARCHETYPES = Object.freeze(["software", "writing_world", "data_research", "asset_heavy"]);
    var GENERATED_DIRECTORY_NAMES = /* @__PURE__ */ new Set([
      ".git",
      ".orquesta",
      ".cache",
      ".next",
      ".turbo",
      "coverage",
      "dist",
      "dist-electron",
      "node_modules",
      "out",
      "output",
      "release",
      "target"
    ]);
    var CODE_EXTENSIONS = /* @__PURE__ */ new Set([".c", ".cjs", ".cpp", ".cs", ".go", ".h", ".java", ".js", ".jsx", ".mjs", ".php", ".py", ".rb", ".rs", ".swift", ".ts", ".tsx"]);
    var DATA_EXTENSIONS = /* @__PURE__ */ new Set([".arrow", ".csv", ".db", ".feather", ".ipynb", ".parquet", ".r", ".rmd", ".sql", ".tsv"]);
    var ASSET_EXTENSIONS = /* @__PURE__ */ new Set([".aac", ".avi", ".blend", ".flac", ".gif", ".glb", ".gltf", ".jpeg", ".jpg", ".m4a", ".mov", ".mp3", ".mp4", ".ogg", ".png", ".psd", ".svg", ".wav", ".webm", ".webp"]);
    function compareText(left, right) {
      return left < right ? -1 : left > right ? 1 : 0;
    }
    function uniqueStrings(values) {
      return [...new Set((Array.isArray(values) ? values : []).filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))].sort(compareText);
    }
    function safeWorkspaceRoot(workspaceRoot) {
      if (typeof workspaceRoot !== "string" || !workspaceRoot) throw new TypeError("workspaceRoot is required");
      const root = fs.realpathSync(workspaceRoot);
      if (!fs.statSync(root).isDirectory()) throw new TypeError("workspaceRoot must be a directory");
      return root;
    }
    function inspectProjectStructureEvidence({ workspaceRoot, maxEntries = 384, maxDepth = 3 } = {}) {
      const root = safeWorkspaceRoot(workspaceRoot);
      const entries = [];
      const topLevelDirectories = /* @__PURE__ */ new Set();
      const extensionCounts = {};
      function visit(directory, relativeDirectory, depth) {
        if (entries.length >= maxEntries || depth > maxDepth) return;
        const children = fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => compareText(left.name.toLowerCase(), right.name.toLowerCase()));
        for (const child of children) {
          if (entries.length >= maxEntries) break;
          const reference = normalizeRef(relativeDirectory === "." ? child.name : `${relativeDirectory}/${child.name}`);
          if (child.isSymbolicLink()) continue;
          if (child.isDirectory()) {
            if (GENERATED_DIRECTORY_NAMES.has(child.name.toLowerCase())) continue;
            entries.push({ source_ref: reference, kind: "directory" });
            if (depth === 0) topLevelDirectories.add(child.name);
            visit(path.join(directory, child.name), reference, depth + 1);
            continue;
          }
          if (!child.isFile()) continue;
          const extension = path.posix.extname(reference).toLowerCase();
          entries.push({ source_ref: reference, kind: "file", extension });
          extensionCounts[extension || "(none)"] = (extensionCounts[extension || "(none)"] || 0) + 1;
        }
      }
      visit(root, ".", 0);
      return Object.freeze({
        workspace_root: root,
        bounded: entries.length >= maxEntries,
        max_entries: maxEntries,
        entries: Object.freeze(entries),
        source_refs: Object.freeze(entries.map((entry) => entry.source_ref)),
        top_level_directories: Object.freeze([...topLevelDirectories].sort(compareText)),
        extension_counts: Object.freeze(Object.fromEntries(Object.entries(extensionCounts).sort(([left], [right]) => compareText(left, right))))
      });
    }
    function inferProjectArchetype({ evidence, description = "" } = {}) {
      if (!evidence || !Array.isArray(evidence.source_refs)) throw new TypeError("evidence is required");
      const refs = evidence.source_refs.map((reference) => reference.toLowerCase());
      const scores = Object.fromEntries(ARCHETYPES.map((archetype2) => [archetype2, { score: 0, evidence: [] }]));
      const add = (archetype2, points, reason) => {
        scores[archetype2].score += points;
        if (!scores[archetype2].evidence.includes(reason)) scores[archetype2].evidence.push(reason);
      };
      const hasRef = (pattern) => refs.some((reference) => pattern.test(reference));
      const countExtensions = (extensions) => Object.entries(evidence.extension_counts || {}).reduce((total, [extension, count]) => total + (extensions.has(extension) ? Number(count) : 0), 0);
      if (hasRef(/(?:^|\/)(?:package\.json|cargo\.toml|go\.mod|pyproject\.toml|requirements\.txt)$/u)) add("software", 6, "software_manifest");
      if (hasRef(/^(?:src|app|apps|packages|lib|crates)(?:\/|$)/u)) add("software", 5, "software_source_root");
      const codeCount = countExtensions(CODE_EXTENSIONS);
      if (codeCount > 0) add("software", Math.min(5, 1 + Math.floor(Math.log2(codeCount + 1))), `code_files:${codeCount}`);
      if (hasRef(/^(?:manuscript|chapters|world|worldbuilding|lore|characters|locations|timeline|novel(?:[_-]world)?|story)(?:\/|$)/u)) add("writing_world", 6, "writing_or_world_root");
      const markdownCount = Number(evidence.extension_counts?.[".md"] || 0);
      if (markdownCount >= 3) add("writing_world", Math.min(4, Math.floor(markdownCount / 3)), `markdown_volume:${markdownCount}`);
      if (hasRef(/^(?:data|datasets|notebooks|analysis|experiments)(?:\/|$)/u)) add("data_research", 6, "data_or_analysis_root");
      const dataCount = countExtensions(DATA_EXTENSIONS);
      if (dataCount > 0) add("data_research", Math.min(6, 2 + Math.floor(Math.log2(dataCount + 1))), `data_files:${dataCount}`);
      if (hasRef(/^(?:assets|art|images|sprites|audio|video|media|renders|exports)(?:\/|$)/u)) add("asset_heavy", 6, "asset_root");
      const assetCount = countExtensions(ASSET_EXTENSIONS);
      if (assetCount > 0) add("asset_heavy", Math.min(6, 2 + Math.floor(Math.log2(assetCount + 1))), `asset_files:${assetCount}`);
      const text = String(description || "").toLowerCase();
      const descriptionSignals = [
        ["software", /(?:software|application|\bapp\b|desktop|web|api|library|code|実装|開発|アプリ|システム)/u, "description:software"],
        ["writing_world", /(?:novel|story|manuscript|worldbuilding|lore|小説|物語|世界観|設定資料)/u, "description:writing_world"],
        ["data_research", /(?:dataset|analytics|analysis|research data|データ|分析|統計|研究)/u, "description:data_research"],
        ["asset_heavy", /(?:asset|illustration|animation|video|audio|sprite|画像|映像|音声|素材)/u, "description:asset_heavy"]
      ];
      for (const [archetype2, pattern, reason] of descriptionSignals) {
        if (pattern.test(text)) add(archetype2, 2, reason);
      }
      const candidates = ARCHETYPES.map((archetype2) => ({ archetype: archetype2, ...scores[archetype2] })).sort((left, right) => right.score - left.score || compareText(left.archetype, right.archetype));
      const top = candidates[0];
      const meaningful = candidates.filter((candidate) => candidate.score >= 4 && candidate.score >= Math.max(4, Math.floor(top.score * 0.55)));
      const archetype = top.score === 0 || meaningful.length > 1 ? "hybrid" : top.archetype;
      const confidence = top.score === 0 ? "low" : meaningful.length > 1 ? "mixed" : top.score >= 9 ? "high" : "medium";
      return Object.freeze({
        archetype,
        confidence,
        candidates: Object.freeze(candidates.map((candidate) => Object.freeze({
          archetype: candidate.archetype,
          score: candidate.score,
          evidence: Object.freeze([...candidate.evidence].sort(compareText))
        })))
      });
    }
    function component({ componentId, kind, roots, owner = null, lifecycle = "current", authority = "supporting", readPolicy = "task_candidate", include = ["**"], exclude = [] }) {
      return {
        component_id: componentId,
        kind,
        roots: uniqueStrings(roots.map(normalizeRef)),
        owner,
        default_lifecycle: lifecycle,
        default_authority: authority,
        default_read_policy: readPolicy,
        include: uniqueStrings(include),
        exclude: uniqueStrings(exclude)
      };
    }
    function normalizeSetupAnswers(values) {
      return (Array.isArray(values) ? values : []).map((answer) => ({
        question_id: String(answer.question_id ?? answer.questionId ?? "").trim(),
        answer: String(answer.answer ?? "")
      })).filter((answer) => answer.question_id);
    }
    function hasRoot(evidence, root) {
      const normalized = root.toLowerCase();
      return (evidence.top_level_directories || []).some((directory) => directory.toLowerCase() === normalized);
    }
    function createComponents({ archetypeResult, evidence, isNewProject }) {
      const components = [];
      const usedRoots = /* @__PURE__ */ new Set([".", ".orquesta", "workbench/inbox"]);
      const add = (definition) => {
        const roots = definition.roots.filter((root) => !usedRoots.has(normalizeRef(root)));
        if (!roots.length) return;
        for (const root of roots) usedRoots.add(normalizeRef(root));
        components.push(component({ ...definition, roots }));
      };
      components.push(component({
        componentId: "repository-entry",
        kind: "repository_metadata",
        roots: ["."],
        readPolicy: "bootstrap_candidate",
        include: ["README*", "*.md", "*.txt", "*.json", "*.toml", "*.yaml", "*.yml", "LICENSE*", ".gitignore", ".gitattributes"]
      }));
      components.push(component({
        componentId: "runtime-state",
        kind: "orchestration_state",
        roots: [".orquesta"],
        readPolicy: "explicit_only"
      }));
      components.push(component({
        componentId: "placement-inbox",
        kind: "task_scoped_staging",
        roots: ["workbench/inbox"],
        lifecycle: "draft",
        readPolicy: "explicit_only"
      }));
      const activeArchetypes = archetypeResult.archetype === "hybrid" ? archetypeResult.candidates.filter((candidate) => candidate.score >= 4).map((candidate) => candidate.archetype) : [archetypeResult.archetype];
      const effectiveArchetypes = activeArchetypes;
      if (effectiveArchetypes.includes("software")) {
        if (hasRoot(evidence, "apps")) add({ componentId: "applications", kind: "application", roots: ["apps"], exclude: ["**/node_modules/**", "**/dist/**", "**/coverage/**"] });
        if (hasRoot(evidence, "packages")) add({ componentId: "libraries", kind: "software_modules", roots: ["packages"], exclude: ["**/node_modules/**", "**/dist/**", "**/coverage/**"] });
        const sourceRoots = ["src", "app", "lib", "crates"].filter((root) => hasRoot(evidence, root));
        if (sourceRoots.length) add({ componentId: "application-code", kind: "source_code", roots: sourceRoots, exclude: ["**/node_modules/**", "**/dist/**"] });
        else if (isNewProject) add({ componentId: "application-code", kind: "source_code", roots: ["src"] });
        const testRoots = ["test", "tests"].filter((root) => hasRoot(evidence, root));
        if (testRoots.length) add({ componentId: "tests", kind: "verification", roots: testRoots, readPolicy: "explicit_only" });
      }
      if (effectiveArchetypes.includes("writing_world")) {
        const manuscriptRoots = ["manuscript", "chapters", "novel", "story"].filter((root) => hasRoot(evidence, root));
        if (manuscriptRoots.length) add({ componentId: "manuscript", kind: "writing_manuscript", roots: manuscriptRoots });
        else if (isNewProject) add({ componentId: "manuscript", kind: "writing_manuscript", roots: ["manuscript"] });
        const canonRoots = ["world", "lore", "characters", "locations", "timeline"].filter((root) => hasRoot(evidence, root));
        if (canonRoots.length) add({ componentId: "world-canon", kind: "world_canon", roots: canonRoots, authority: "canonical" });
        if (hasRoot(evidence, "drafts")) add({ componentId: "writing-drafts", kind: "writing_draft", roots: ["drafts"], lifecycle: "draft" });
      }
      if (effectiveArchetypes.includes("data_research")) {
        const dataRoots = ["data", "datasets"].filter((root) => hasRoot(evidence, root));
        if (dataRoots.length) add({ componentId: "project-data", kind: "data", roots: dataRoots, readPolicy: "explicit_only" });
        else if (isNewProject) add({ componentId: "project-data", kind: "data", roots: ["data"], readPolicy: "explicit_only" });
        if (hasRoot(evidence, "notebooks")) add({ componentId: "notebooks", kind: "analysis_notebook", roots: ["notebooks"], readPolicy: "explicit_only" });
        if (hasRoot(evidence, "analysis")) add({ componentId: "analysis", kind: "analysis_code", roots: ["analysis"] });
      }
      if (effectiveArchetypes.includes("asset_heavy")) {
        const assetRoots = ["assets", "art", "images", "sprites", "audio", "video", "media"].filter((root) => hasRoot(evidence, root));
        if (assetRoots.length) add({ componentId: "source-assets", kind: "source_asset", roots: assetRoots, readPolicy: "explicit_only" });
        else if (isNewProject) add({ componentId: "source-assets", kind: "source_asset", roots: ["assets"], readPolicy: "explicit_only" });
        const exportRoots = ["exports", "renders"].filter((root) => hasRoot(evidence, root));
        if (exportRoots.length) add({ componentId: "asset-exports", kind: "asset_export", roots: exportRoots, authority: "derived", readPolicy: "explicit_only" });
      }
      if (hasRoot(evidence, "docs")) add({ componentId: "project-docs", kind: "documentation", roots: ["docs"] });
      if (hasRoot(evidence, "research")) add({ componentId: "research", kind: "research", roots: ["research"], readPolicy: "explicit_only" });
      if (hasRoot(evidence, "reports")) add({ componentId: "reports", kind: "report", roots: ["reports"], readPolicy: "explicit_only" });
      if (hasRoot(evidence, "tools")) add({ componentId: "tooling", kind: "development_tooling", roots: ["tools"] });
      if (hasRoot(evidence, "scripts")) add({ componentId: "scripts", kind: "development_tooling", roots: ["scripts"] });
      if (isNewProject && components.every((item) => ["repository-entry", "runtime-state", "placement-inbox"].includes(item.component_id))) {
        add({ componentId: "project-content", kind: "project_content", roots: ["project"] });
      }
      const uncovered = (evidence.top_level_directories || []).filter((root) => !GENERATED_DIRECTORY_NAMES.has(root.toLowerCase())).filter((root) => !usedRoots.has(normalizeRef(root)));
      if (uncovered.length) add({ componentId: "existing-project-content", kind: "project_content", roots: uncovered });
      return components;
    }
    function lifecycleRegistry(updatedAt, entryRef = null) {
      const claims = [
        { claim_key: "orquesta.project.structure.layout", source_ref: ".orquesta/project/layout.json" },
        { claim_key: "orquesta.project.structure.lifecycle", source_ref: ".orquesta/project/lifecycle.json" },
        { claim_key: "orquesta.project.structure.setup", source_ref: ".orquesta/project/structure-setup.json" }
      ];
      if (entryRef) claims.push({ claim_key: "project.entry", source_ref: entryRef });
      return {
        schema_version: 1,
        status: "draft",
        rules: [
          {
            rule_id: "generated-roots",
            match: ["**/node_modules/**", "**/dist/**", "**/dist-electron/**", "**/out/**", "**/output/**", "**/release/**", "**/coverage/**", "**/.cache/**"],
            lifecycle: "current",
            authority: "derived",
            read_policy: "never",
            storage_policy: "gitignored",
            reason: "Generated and dependency content is excluded from normal project context."
          },
          {
            rule_id: "canonical-orquesta-state",
            match: [".orquesta/state/*.json", ".orquesta/state/*.jsonl", ".orquesta/setup/*.json", ".orquesta/project/*.json", ".orquesta/user_tasks/*.json", ".orquesta/failures/*.json", ".orquesta/vision/*.json"],
            lifecycle: "current",
            authority: "canonical",
            read_policy: "task_candidate",
            storage_policy: "versioned",
            reason: "File-backed Orquesta project state."
          },
          {
            rule_id: "derived-orquesta-state",
            match: [".orquesta/project/derived/**", ".orquesta/context/shadow/**"],
            lifecycle: "current",
            authority: "derived",
            read_policy: "never",
            storage_policy: "ephemeral",
            reason: "Reconstructed structure and context artifacts do not enter normal task context."
          },
          {
            rule_id: "placement-inbox",
            match: ["workbench/inbox/**"],
            lifecycle: "draft",
            authority: "supporting",
            read_policy: "explicit_only",
            storage_policy: "versioned",
            reason: "Unresolved task outputs remain isolated until their component is known."
          }
        ],
        overrides: [],
        canonical_claims: claims,
        updated_at: updatedAt
      };
    }
    function createProjectStructureSetupPlan({
      projectId,
      projectName,
      description = "",
      sourceKind = "detected_root",
      setupAnswers = [],
      evidence,
      generatedAt
    } = {}) {
      if (!projectId || !projectName || !evidence || !generatedAt) throw new TypeError("projectId, projectName, evidence, and generatedAt are required");
      const nonOrquestaFiles = evidence.entries.filter((entry) => entry.kind === "file");
      const isNewProject = sourceKind === "new_project" || sourceKind === "detected_root" && nonOrquestaFiles.length === 0;
      const archetypeResult = inferProjectArchetype({ evidence, description });
      const components = createComponents({ archetypeResult, evidence, isNewProject });
      const readmeRef = evidence.source_refs.find((reference) => /^readme(?:\.[^/]+)?$/iu.test(reference)) || (isNewProject ? "README.md" : null);
      const layout = assertContract("project-layout", {
        schema_version: 1,
        status: "draft",
        project_id: projectId,
        project_kind: archetypeResult.archetype,
        components,
        generated_roots: ["**/node_modules/**", "**/dist/**", "**/dist-electron/**", "**/out/**", "**/output/**", "**/release/**", "**/coverage/**", "**/.cache/**"],
        external_storage_roots: [],
        updated_at: generatedAt
      });
      const lifecycle = assertContract("lifecycle-registry", lifecycleRegistry(generatedAt, readmeRef));
      const primaryDirectory = isNewProject ? components.find((item) => !["repository-entry", "runtime-state", "placement-inbox"].includes(item.component_id))?.roots[0] || null : null;
      const physicalChanges = {
        created_directories: primaryDirectory ? [primaryDirectory] : [],
        created_files: readmeRef === "README.md" ? ["README.md"] : [],
        moved_paths: []
      };
      const setup = assertContract("project-structure-setup", {
        schema_version: 1,
        template_version: PROJECT_STRUCTURE_TEMPLATE_VERSION,
        status: "ready",
        mode: isNewProject ? "new_minimal" : "existing_shadow",
        project_id: projectId,
        source_kind: sourceKind,
        archetype: archetypeResult.archetype,
        archetype_candidates: archetypeResult.candidates,
        setup_answers: normalizeSetupAnswers(setupAnswers),
        manifests: {
          layout_ref: ".orquesta/project/layout.json",
          lifecycle_ref: ".orquesta/project/lifecycle.json",
          manifest_source: "generated"
        },
        physical_changes: physicalChanges,
        created_at: generatedAt,
        updated_at: generatedAt
      });
      const entryContent = readmeRef === "README.md" ? [
        `# ${String(projectName).trim()}`,
        "",
        String(description || "Project initialized with Orquesta.").trim() || "Project initialized with Orquesta.",
        ""
      ].join("\n") : null;
      return Object.freeze({
        layout: Object.freeze(layout),
        lifecycle: Object.freeze(lifecycle),
        setup: Object.freeze(setup),
        entry: entryContent ? Object.freeze({ source_ref: "README.md", content: entryContent }) : null,
        evidence
      });
    }
    function createPreservedProjectStructureSetup({
      projectId,
      sourceKind = "existing_folder",
      archetypeResult,
      setupAnswers = [],
      previousSetup = null,
      generatedAt
    } = {}) {
      if (!projectId || !archetypeResult || !generatedAt) throw new TypeError("projectId, archetypeResult, and generatedAt are required");
      const previous = previousSetup && typeof previousSetup === "object" ? previousSetup : null;
      const archetype = archetypeResult.archetype === "hybrid_software_product" ? "hybrid" : archetypeResult.archetype;
      return assertContract("project-structure-setup", {
        schema_version: 1,
        template_version: previous?.template_version || PROJECT_STRUCTURE_TEMPLATE_VERSION,
        status: "ready",
        mode: previous?.mode || "existing_shadow",
        project_id: projectId,
        source_kind: previous?.source_kind || sourceKind,
        archetype: previous?.archetype || archetype,
        archetype_candidates: previous?.archetype_candidates || archetypeResult.candidates,
        setup_answers: normalizeSetupAnswers(setupAnswers.length ? setupAnswers : previous?.setup_answers),
        manifests: {
          layout_ref: ".orquesta/project/layout.json",
          lifecycle_ref: ".orquesta/project/lifecycle.json",
          manifest_source: previous?.manifests?.manifest_source || "preserved"
        },
        physical_changes: previous?.physical_changes || {
          created_directories: [],
          created_files: [],
          moved_paths: []
        },
        created_at: previous?.created_at || generatedAt,
        updated_at: generatedAt
      });
    }
    function extendProjectStructureComponents({ layout, components, updatedAt = (/* @__PURE__ */ new Date()).toISOString() } = {}) {
      const current = assertContract("project-layout", layout);
      const additions = Array.isArray(components) ? components : [];
      if (!additions.length) return current;
      const ids = new Set(current.components.map((item) => item.component_id));
      const normalized = additions.map((item) => component({
        componentId: item.component_id,
        kind: item.kind,
        roots: item.roots,
        owner: item.owner ?? null,
        lifecycle: item.default_lifecycle || "current",
        authority: item.default_authority || "supporting",
        readPolicy: item.default_read_policy || "task_candidate",
        include: Array.isArray(item.include) ? item.include : ["**"],
        exclude: Array.isArray(item.exclude) ? item.exclude : []
      }));
      for (const addition of normalized) {
        if (ids.has(addition.component_id)) throw new Error(`component already exists: ${addition.component_id}`);
        ids.add(addition.component_id);
      }
      return assertContract("project-layout", {
        ...current,
        components: [...current.components, ...normalized],
        updated_at: updatedAt
      });
    }
    function createInitialStructureContextView({ layout, setup, inventory, projection, audit, goal = "", generatedAt } = {}) {
      const projectLayout = assertContract("project-layout", layout);
      const setupRecord = assertContract("project-structure-setup", setup);
      if (!inventory || !projection || !audit || !generatedAt) throw new TypeError("inventory, projection, audit, and generatedAt are required");
      const candidateRefs = new Set(projection.selected.map((item) => item.source_ref));
      const components = projectLayout.components.map((item) => {
        const files = inventory.files.filter((file) => file.component_id === item.component_id);
        return {
          component_id: item.component_id,
          kind: item.kind,
          roots: [...item.roots],
          indexed_sources: files.length,
          candidate_sources: files.filter((file) => candidateRefs.has(file.source_ref)).length
        };
      });
      const content = {
        version: 1,
        project_id: projectLayout.project_id,
        template_version: setupRecord.template_version,
        archetype: setupRecord.archetype,
        setup_mode: setupRecord.mode,
        goal: String(goal || "").trim(),
        components,
        sources: {
          indexed_count: inventory.stats.indexed_files,
          candidate_count: projection.stats.selected_files,
          excluded_count: projection.stats.excluded_files,
          candidate_source_refs: projection.selected.map((item) => item.source_ref).slice(0, 24)
        },
        warnings: audit.issues.filter((issue) => issue.severity !== "suggestion").map((issue) => issue.code).slice(0, 12),
        generated_at: generatedAt
      };
      const identity = { ...content };
      delete identity.generated_at;
      return assertContract("project-structure-context-view", {
        ...content,
        view_id: `PSCV-${canonicalHash(identity).slice(0, 16)}`
      });
    }
    module2.exports = {
      PROJECT_STRUCTURE_TEMPLATE_VERSION,
      createInitialStructureContextView,
      createPreservedProjectStructureSetup,
      createProjectStructureSetupPlan,
      extendProjectStructureComponents,
      inferProjectArchetype,
      inspectProjectStructureEvidence,
      normalizeSetupAnswers
    };
  }
});

// packages/project-structure/src/migration.js
var require_migration = __commonJS({
  "packages/project-structure/src/migration.js"(exports2, module2) {
    "use strict";
    var crypto = require("node:crypto");
    var fs = require("node:fs");
    var path = require("node:path");
    var { assertContract } = require_src();
    var { normalizeRef } = require_patterns();
    var TEXT_EXTENSIONS = /* @__PURE__ */ new Set([
      ".c",
      ".cjs",
      ".cpp",
      ".css",
      ".csv",
      ".h",
      ".html",
      ".js",
      ".json",
      ".jsonl",
      ".jsx",
      ".md",
      ".mjs",
      ".ps1",
      ".py",
      ".sh",
      ".sql",
      ".toml",
      ".ts",
      ".tsx",
      ".txt",
      ".xml",
      ".yaml",
      ".yml"
    ]);
    var DEFAULT_REFERENCE_SCAN_BYTES = 2 * 1024 * 1024;
    function compareText(left, right) {
      return left < right ? -1 : left > right ? 1 : 0;
    }
    function sha256(value) {
      return crypto.createHash("sha256").update(value).digest("hex");
    }
    function hashFile(filePath) {
      return sha256(fs.readFileSync(filePath));
    }
    function isPlannerOutput(sourceRef) {
      return sourceRef === ".orquesta/project/migration-plan.json" || sourceRef.startsWith(".orquesta/project/migrations/") || sourceRef === ".orquesta/reports/V4F-PROJECT-STRUCTURE-PHASE5-PLAN.md";
    }
    function normalizeProjectRef(reference, label) {
      if (typeof reference !== "string" || !reference.trim()) throw new TypeError(`${label} is required`);
      if (path.isAbsolute(reference)) throw new RangeError(`${label} must be project-relative: ${reference}`);
      const normalized = normalizeRef(reference);
      if (normalized === ".." || normalized.startsWith("../")) {
        throw new RangeError(`${label} escapes the project: ${reference}`);
      }
      return normalized;
    }
    function resolveInside(root, reference, label) {
      const normalized = normalizeProjectRef(reference, label);
      const absolute = path.resolve(root, ...normalized.split("/"));
      const relative = path.relative(root, absolute);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new RangeError(`${label} escapes the project: ${reference}`);
      }
      return { normalized, absolute };
    }
    function workspaceFingerprint(inventory) {
      const rows = inventory.files.filter((file) => !isPlannerOutput(file.source_ref)).map((file) => [
        file.source_ref,
        file.sha256 || "unhashed",
        file.size_bytes,
        file.mtime_ms,
        file.lifecycle,
        file.authority
      ].join("\0"));
      return sha256(rows.join("\n"));
    }
    function auditCandidateSet(audit) {
      const candidates = [];
      const decisions = [];
      const blockers = [];
      for (const issue of audit?.issues || []) {
        if (issue.code === "runtime_ephemeral_next_to_canonical_state") {
          for (const sourceRef of issue.source_refs || []) {
            candidates.push({
              action: "quarantine",
              source_ref: sourceRef,
              target_ref: null,
              reason: "Runtime backup or temporary state sits beside canonical state.",
              confidence: "high",
              reference_policy: "none"
            });
          }
        } else if (issue.code === "duplicate_current_content") {
          decisions.push({
            code: "duplicate_content_not_auto_retired",
            decision: "manual_review",
            reason: "Identical bytes do not prove that two consumer paths are interchangeable.",
            source_refs: [...issue.source_refs || []].sort(compareText)
          });
        } else if (issue.severity === "error") {
          blockers.push({
            code: issue.code,
            message: issue.message,
            source_refs: [...issue.source_refs || []].sort(compareText)
          });
        }
      }
      return { candidates, decisions, blockers };
    }
    function archiveTarget(planId, sourceRef) {
      const stripped = sourceRef.startsWith(".orquesta/") ? sourceRef.slice(".orquesta/".length) : sourceRef;
      return `.orquesta/archive/structure-migrations/${planId}/runtime-ephemeral/${stripped}`;
    }
    function countOccurrences(content, needles) {
      let total = 0;
      for (const needle of new Set(needles.filter(Boolean))) {
        let cursor = 0;
        while (cursor < content.length) {
          const index = content.indexOf(needle, cursor);
          if (index === -1) break;
          total += 1;
          cursor = index + needle.length;
        }
      }
      return total;
    }
    function referenceRewritesForOperations({ workspaceRoot, inventory, operations, maxReferenceScanBytes }) {
      const searchable = operations.filter((operation) => operation.target_ref && operation.status !== "blocked" && operation.reference_policy !== "none");
      const rewrites = [];
      for (const file of inventory.files) {
        if (file.size_bytes > maxReferenceScanBytes || file.authority === "derived" || file.read_policy === "never") continue;
        if (isPlannerOutput(file.source_ref) || searchable.some((operation) => operation.source_ref === file.source_ref)) continue;
        if (!TEXT_EXTENSIONS.has(file.extension)) continue;
        const candidate = resolveInside(workspaceRoot, file.source_ref, "referrer");
        let content;
        try {
          content = fs.readFileSync(candidate.absolute, "utf8");
        } catch {
          continue;
        }
        for (const operation of searchable) {
          const occurrenceCount = countOccurrences(content, [operation.source_ref, operation.source_ref.replace(/\//gu, "\\")]);
          if (occurrenceCount === 0) continue;
          rewrites.push({
            operation_id: operation.operation_id,
            referrer: file.source_ref,
            from: operation.source_ref,
            to: operation.target_ref,
            occurrence_count: occurrenceCount
          });
        }
      }
      return rewrites.sort((left, right) => compareText(left.operation_id, right.operation_id) || compareText(left.referrer, right.referrer));
    }
    function createProjectStructureMigrationPlan({
      workspaceRoot,
      layout,
      lifecycleRegistry,
      inventory,
      audit,
      candidates = [],
      generatedAt,
      dirtyPathCount = 0,
      maxReferenceScanBytes = DEFAULT_REFERENCE_SCAN_BYTES
    } = {}) {
      if (!workspaceRoot) throw new TypeError("workspaceRoot is required");
      const root = fs.realpathSync(workspaceRoot);
      assertContract("project-layout", layout);
      assertContract("lifecycle-registry", lifecycleRegistry);
      const generated = generatedAt || (/* @__PURE__ */ new Date()).toISOString();
      const fingerprint = workspaceFingerprint(inventory);
      const planId = `PSMP-${sha256(`${layout.project_id}\0${fingerprint}\0${generated}`).slice(0, 16)}`;
      const derived = auditCandidateSet(audit);
      const requestedByKey = /* @__PURE__ */ new Map();
      for (const candidate of [...derived.candidates, ...Array.isArray(candidates) ? candidates : []]) {
        requestedByKey.set(`${candidate.action || "move"}\0${candidate.source_ref}`, candidate);
      }
      const requested = [...requestedByKey.values()].sort((left, right) => compareText(String(left.source_ref), String(right.source_ref)) || compareText(String(left.action || "move"), String(right.action || "move")));
      const seenSources = /* @__PURE__ */ new Set();
      const targetOwners = /* @__PURE__ */ new Map();
      const blockers = [...derived.blockers];
      const operations = [];
      for (const [index, raw] of requested.entries()) {
        let sourceRef;
        let targetRef = null;
        let sourcePath = null;
        let sourceHash = null;
        let targetPrecondition = raw.action === "delete" ? "not_applicable" : "missing";
        let status2 = "planned";
        const localBlockers = [];
        try {
          const source = resolveInside(root, raw.source_ref, "source_ref");
          sourceRef = source.normalized;
          sourcePath = source.absolute;
          if (seenSources.has(sourceRef)) localBlockers.push("duplicate_source_operation");
          seenSources.add(sourceRef);
          if (!fs.existsSync(sourcePath)) localBlockers.push("missing_source");
          else {
            const stat = fs.lstatSync(sourcePath);
            if (stat.isSymbolicLink()) localBlockers.push("symlink_source_rejected");
            else if (!stat.isFile()) localBlockers.push("non_file_source_rejected");
            else sourceHash = hashFile(sourcePath);
          }
          if (raw.action !== "delete") {
            const requestedTarget = raw.target_ref || archiveTarget(planId, sourceRef);
            const target = resolveInside(root, requestedTarget, "target_ref");
            targetRef = target.normalized;
            if (targetRef === sourceRef) localBlockers.push("source_equals_target");
            if (targetOwners.has(targetRef)) localBlockers.push("duplicate_target_operation");
            targetOwners.set(targetRef, sourceRef);
            if (fs.existsSync(target.absolute)) {
              const targetStat = fs.lstatSync(target.absolute);
              if (targetStat.isSymbolicLink()) targetPrecondition = "conflict";
              else if (targetStat.isFile() && sourceHash && hashFile(target.absolute) === sourceHash) targetPrecondition = "same_hash";
              else targetPrecondition = "conflict";
              localBlockers.push("target_already_exists");
            }
          }
        } catch (error) {
          sourceRef = typeof raw.source_ref === "string" ? raw.source_ref : "invalid";
          localBlockers.push(error instanceof Error ? error.message : String(error));
        }
        if (localBlockers.length > 0) {
          status2 = "blocked";
          blockers.push({
            code: "unsafe_migration_operation",
            message: localBlockers.join(", "),
            source_refs: [sourceRef]
          });
        }
        operations.push({
          operation_id: `MOVE-${String(index + 1).padStart(4, "0")}`,
          action: raw.action || "move",
          source_ref: sourceRef,
          target_ref: targetRef,
          reason: raw.reason || "Explicit migration candidate.",
          confidence: raw.confidence || "medium",
          destructive: raw.action === "delete",
          source_sha256: sourceHash,
          target_precondition: targetPrecondition,
          reference_policy: raw.reference_policy || "rewrite",
          reference_count: 0,
          status: status2
        });
      }
      const referenceRewrites = referenceRewritesForOperations({
        workspaceRoot: root,
        inventory,
        operations,
        maxReferenceScanBytes
      });
      for (const operation of operations) {
        operation.reference_count = referenceRewrites.filter((item) => item.operation_id === operation.operation_id).reduce((sum, item) => sum + item.occurrence_count, 0);
      }
      const hasQuarantine = operations.some((operation) => operation.action === "quarantine");
      const alreadyHasArchiveRule = (lifecycleRegistry.rules || []).some((rule) => (rule.match || []).some((pattern) => pattern === ".orquesta/archive/structure-migrations/**"));
      const manifestUpdates = hasQuarantine && !alreadyHasArchiveRule ? [{
        action: "add_rule",
        rule_id: "structure-migration-archive",
        match: [".orquesta/archive/structure-migrations/**"],
        lifecycle: "archived",
        authority: "supporting",
        read_policy: "explicit_only",
        storage_policy: "versioned",
        reason: "Reversible migration quarantine is excluded from normal task context."
      }] : [];
      const planned = operations.filter((operation) => operation.status === "planned");
      const rollbackSteps = planned.filter((operation) => operation.target_ref && operation.source_sha256 && !operation.destructive).map((operation) => ({
        operation_id: operation.operation_id,
        action: "move",
        source_ref: operation.target_ref,
        target_ref: operation.source_ref,
        expected_sha256: operation.source_sha256
      })).reverse();
      const destructive = planned.some((operation) => operation.destructive);
      const reversible = !destructive && rollbackSteps.length === planned.length;
      if (planned.length > 0 && !reversible) {
        blockers.push({
          code: "rollback_incomplete",
          message: "Every planned physical operation must have a verified reverse move.",
          source_refs: planned.filter((operation) => operation.destructive || !operation.source_sha256).map((operation) => operation.source_ref)
        });
      }
      const checks = [
        {
          code: "dry_run_only",
          status: "passed",
          details: "Planner generated evidence only; no project source was moved, rewritten, or deleted."
        },
        {
          code: "project_boundary",
          status: blockers.some((item) => item.message.includes("escapes the project")) ? "blocked" : "passed",
          details: "All planned source and target paths must remain inside the selected project root."
        },
        {
          code: "symlink_boundary",
          status: blockers.some((item) => item.message.includes("symlink")) ? "blocked" : "passed",
          details: "Symlink migration candidates are rejected rather than followed."
        },
        {
          code: "hash_and_rollback",
          status: planned.length === 0 || reversible ? "passed" : "blocked",
          details: planned.length === 0 ? "No physical operations require rollback." : "Each reversible move records its source hash and reverse operation."
        },
        {
          code: "reference_rewrite_plan",
          status: "passed",
          details: `${referenceRewrites.length} referrer files require planned path rewrites.`
        }
      ];
      const status = blockers.length > 0 ? "blocked" : planned.length > 0 ? "review_required" : "no_changes";
      const plan = {
        version: 1,
        plan_id: planId,
        project_id: layout.project_id,
        status,
        dry_run: true,
        source_snapshot: {
          inventory_generated_at: inventory.generated_at,
          workspace_fingerprint: fingerprint,
          indexed_files: inventory.files.filter((file) => !isPlannerOutput(file.source_ref)).length,
          hashed_files: inventory.files.filter((file) => !isPlannerOutput(file.source_ref) && file.hash_state === "hashed").length,
          dirty_worktree: Number(dirtyPathCount) > 0,
          dirty_path_count: Math.max(0, Number(dirtyPathCount) || 0)
        },
        operations,
        reference_rewrites: referenceRewrites,
        manifest_updates: manifestUpdates,
        checks,
        rollback: { reversible, steps: rollbackSteps },
        approval: {
          required: planned.length > 0,
          scope: "entire_plan",
          destructive_confirmation_required: destructive,
          applied: false
        },
        decisions: derived.decisions,
        blockers,
        generated_at: generated
      };
      return Object.freeze(assertContract("project-structure-migration-plan", plan));
    }
    function renderMigrationPlanReview(plan) {
      const lines = [
        "# Project Structure Migration Plan",
        "",
        `- Plan: \`${plan.plan_id}\``,
        `- Project: \`${plan.project_id}\``,
        `- Status: \`${plan.status}\``,
        `- Dry-run: \`${plan.dry_run}\``,
        `- Indexed files: ${plan.source_snapshot.indexed_files}`,
        `- Dirty paths observed: ${plan.source_snapshot.dirty_path_count}`,
        `- Planned operations: ${plan.operations.filter((item) => item.status === "planned").length}`,
        `- Reference rewrite files: ${plan.reference_rewrites.length}`,
        `- Rollback complete: \`${plan.rollback.reversible}\``,
        "",
        "## Planned operations",
        ""
      ];
      if (plan.operations.length === 0) lines.push("No physical operations are proposed.");
      for (const operation of plan.operations) {
        lines.push(`- ${operation.operation_id}: ${operation.action} \`${operation.source_ref}\`${operation.target_ref ? ` -> \`${operation.target_ref}\`` : ""} (${operation.status}, refs ${operation.reference_count})`);
      }
      lines.push("", "## Decisions that are not automatic", "");
      if (plan.decisions.length === 0) lines.push("None.");
      for (const decision of plan.decisions) lines.push(`- ${decision.code}: ${decision.decision}. ${decision.reason}`);
      lines.push("", "## Blockers", "");
      if (plan.blockers.length === 0) lines.push("None.");
      for (const blocker of plan.blockers) lines.push(`- ${blocker.code}: ${blocker.message}`);
      lines.push(
        "",
        "## Approval boundary",
        "",
        plan.approval.required ? "This entire plan requires user approval before any move, reference rewrite, manifest update, or cleanup is applied." : "No physical change is waiting for approval.",
        ""
      );
      return `${lines.join("\n")}
`;
    }
    module2.exports = {
      createProjectStructureMigrationPlan,
      renderMigrationPlanReview,
      workspaceFingerprint
    };
  }
});

// packages/project-structure/src/index.js
var require_src2 = __commonJS({
  "packages/project-structure/src/index.js"(exports2, module2) {
    "use strict";
    var { auditProjectStructure } = require_audit();
    var {
      classifyReference,
      createLifecycleProjection,
      scanProjectStructure
    } = require_inventory();
    var { matchesAny, matchesGlob, normalizeRef, relativeToRoot } = require_patterns();
    var { renderLifecycleContextReport, renderShadowAuditReport } = require_report();
    var {
      createComponentLifecycleSummary,
      createCompactProjectMapView,
      createLifecycleContextReceipt,
      createLifecycleReadBoundary,
      enrichProjectMapWithLifecycle
    } = require_context_v2();
    var {
      auditCanonicalClaimsForPlacement,
      detectSupersedesCandidates,
      inspectTaskPlacementCompletion,
      resolvePlacement
    } = require_placement();
    var {
      PROJECT_STRUCTURE_TEMPLATE_VERSION,
      createInitialStructureContextView,
      createPreservedProjectStructureSetup,
      createProjectStructureSetupPlan,
      extendProjectStructureComponents,
      inferProjectArchetype,
      inspectProjectStructureEvidence,
      normalizeSetupAnswers
    } = require_setup();
    var {
      createProjectStructureMigrationPlan,
      renderMigrationPlanReview,
      workspaceFingerprint
    } = require_migration();
    module2.exports = {
      auditProjectStructure,
      auditCanonicalClaimsForPlacement,
      classifyReference,
      createInitialStructureContextView,
      createComponentLifecycleSummary,
      createCompactProjectMapView,
      createLifecycleContextReceipt,
      createLifecycleProjection,
      createLifecycleReadBoundary,
      createProjectStructureMigrationPlan,
      createPreservedProjectStructureSetup,
      createProjectStructureSetupPlan,
      detectSupersedesCandidates,
      enrichProjectMapWithLifecycle,
      extendProjectStructureComponents,
      inferProjectArchetype,
      inspectProjectStructureEvidence,
      inspectTaskPlacementCompletion,
      matchesAny,
      matchesGlob,
      normalizeRef,
      normalizeSetupAnswers,
      PROJECT_STRUCTURE_TEMPLATE_VERSION,
      relativeToRoot,
      renderLifecycleContextReport,
      renderMigrationPlanReview,
      renderShadowAuditReport,
      resolvePlacement,
      scanProjectStructure,
      workspaceFingerprint
    };
  }
});

// scripts/context-v2-runtime-entry.js
var { createContextBrokerV2 } = require_broker();
var { evaluateContextV2Activation, summarizeContextVariantComparison } = require_activation();
var { buildProjectMapV2, refreshSourceCatalogV2 } = require_project_map();
var { reconcileContextReceiptV2 } = require_context_reconciler();
var { createOrchestratorResumePlan } = require_orchestrator_loop();
var sessionRotation = require_session_rotation();
var projectStructure = require_src2();
module.exports = {
  createContextBrokerV2,
  buildProjectMapV2,
  createOrchestratorResumePlan,
  evaluateContextV2Activation,
  reconcileContextReceiptV2,
  refreshSourceCatalogV2,
  summarizeContextVariantComparison,
  ...projectStructure,
  ...sessionRotation
};
