"use strict";

const { compareText, normalizeText } = require("./normalize");

const KINDS = new Set(["code", "tool", "knowledge", "data", "permission", "runtime", "service", "asset", "human_judgment", "evidence"]);

function compilerError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function requireString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw compilerError("CAPABILITY_RULE_CATALOG_INVALID", `${field} must be a non-empty string`);
  }
  return value;
}

function requireTerms(value, field) {
  if (!Array.isArray(value) || value.length === 0 || value.some((term) => typeof term !== "string" || !term.trim())) {
    throw compilerError("CAPABILITY_RULE_CATALOG_INVALID", `${field} must be a non-empty string array`);
  }
  return value;
}

function isAsciiAlphaNumeric(value) {
  if (typeof value !== "string" || value.length !== 1) return false;
  const code = value.charCodeAt(0);
  return (code >= 48 && code <= 57) || (code >= 97 && code <= 122);
}

function isAsciiAlphaNumericTerm(value) {
  return value.length > 0 && [...value].every(isAsciiAlphaNumeric);
}

function previousCodePoint(text, index) {
  if (index <= 0) return "";
  const last = text.charCodeAt(index - 1);
  if (last >= 0xdc00 && last <= 0xdfff && index > 1) {
    const first = text.charCodeAt(index - 2);
    if (first >= 0xd800 && first <= 0xdbff) return text.slice(index - 2, index);
  }
  return text[index - 1];
}

function nextCodePoint(text, index) {
  if (index >= text.length) return "";
  return String.fromCodePoint(text.codePointAt(index));
}

function isTokenRunNeighbor(value) {
  return /^(?:[a-z0-9]|\p{Script=Latin}|\p{Nd})$/u.test(value);
}

function matchesTerm(text, term) {
  const normalizedTerm = normalizeText(term);
  if (!isAsciiAlphaNumericTerm(normalizedTerm)) return text.includes(normalizedTerm);
  let start = 0;
  while (start < text.length) {
    const index = text.indexOf(normalizedTerm, start);
    if (index === -1) return false;
    const before = previousCodePoint(text, index);
    const after = nextCodePoint(text, index + normalizedTerm.length);
    if (!isTokenRunNeighbor(before) && !isTokenRunNeighbor(after)) return true;
    start = index + normalizedTerm.length;
  }
  return false;
}

function validateCatalog(catalog) {
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)
    || catalog.catalog_version !== 1 || !Array.isArray(catalog.rules)) {
    throw compilerError("CAPABILITY_RULE_CATALOG_INVALID", "Compiler rules must be a version 1 catalog");
  }
  const ids = new Set();
  const validated = catalog.rules.map((rule) => {
    if (!rule || typeof rule !== "object" || Array.isArray(rule) || Object.keys(rule).some((key) => !["rule_id", "match", "emits"].includes(key))) {
      throw compilerError("CAPABILITY_RULE_CATALOG_INVALID", "Rule has an invalid field set");
    }
    const ruleId = requireString(rule.rule_id, "rule_id");
    if (ids.has(ruleId)) throw compilerError("CAPABILITY_RULE_CATALOG_INVALID", "Rule ids must be unique", { rule_id: ruleId });
    ids.add(ruleId);
    if (!rule.match || typeof rule.match !== "object" || Array.isArray(rule.match)
      || Object.keys(rule.match).some((key) => !["any_terms", "acceptance_terms"].includes(key))) {
      throw compilerError("CAPABILITY_RULE_CATALOG_INVALID", "Rule match has an invalid field set", { rule_id: ruleId });
    }
    const anyTerms = rule.match.any_terms === undefined ? [] : requireTerms(rule.match.any_terms, "match.any_terms");
    const acceptanceTerms = rule.match.acceptance_terms === undefined ? [] : requireTerms(rule.match.acceptance_terms, "match.acceptance_terms");
    if (anyTerms.length === 0 && acceptanceTerms.length === 0) throw compilerError("CAPABILITY_RULE_CATALOG_INVALID", "Rule must match a bounded TaskIntent field", { rule_id: ruleId });
    if (!Array.isArray(rule.emits) || rule.emits.length === 0) throw compilerError("CAPABILITY_RULE_CATALOG_INVALID", "Rule emits must not be empty", { rule_id: ruleId });
    const emits = rule.emits.map((emit, index) => {
      if (!emit || typeof emit !== "object" || Array.isArray(emit)
        || Object.keys(emit).some((key) => !["kind", "description", "verification_method", "depends_on_emit"].includes(key))) {
        throw compilerError("CAPABILITY_RULE_CATALOG_INVALID", "Rule emit has an invalid field set", { rule_id: ruleId, emit_index: index });
      }
      if (!KINDS.has(emit.kind)) throw compilerError("CAPABILITY_RULE_CATALOG_INVALID", "Rule emit kind is invalid", { rule_id: ruleId, emit_index: index });
      requireString(emit.description, "emit.description");
      requireString(emit.verification_method, "emit.verification_method");
      if (emit.depends_on_emit !== undefined && (!Array.isArray(emit.depends_on_emit) || emit.depends_on_emit.some((item) => !Number.isInteger(item) || item < 0))) {
        throw compilerError("CAPABILITY_RULE_CATALOG_INVALID", "Rule emit dependencies must be non-negative integers", { rule_id: ruleId, emit_index: index });
      }
      return { ...emit, depends_on_emit: emit.depends_on_emit || [] };
    });
    return { rule_id: ruleId, match: { any_terms: anyTerms, acceptance_terms: acceptanceTerms }, emits };
  });
  return validated.sort((left, right) => compareText(left.rule_id, right.rule_id));
}

function matchingFields(rule, taskIntent) {
  const desiredOutcome = normalizeText(taskIntent.desired_outcome);
  const criteria = taskIntent.acceptance_criteria.map(normalizeText).join(" ");
  const fields = [];
  if (rule.match.any_terms.length > 0 && rule.match.any_terms.some((term) => matchesTerm(desiredOutcome, term))) {
    fields.push("desired_outcome");
  }
  if (rule.match.acceptance_terms.length > 0 && rule.match.acceptance_terms.some((term) => matchesTerm(criteria, term))) {
    fields.push("acceptance_criteria");
  }
  const needsOutcome = rule.match.any_terms.length > 0;
  const needsCriteria = rule.match.acceptance_terms.length > 0;
  if ((needsOutcome && !fields.includes("desired_outcome")) || (needsCriteria && !fields.includes("acceptance_criteria"))) return [];
  return fields;
}

function matchedRules(catalog, taskIntent) {
  return validateCatalog(catalog).map((rule) => ({ rule, matched_fields: matchingFields(rule, taskIntent) }))
    .filter((entry) => entry.matched_fields.length > 0);
}

module.exports = { compilerError, matchedRules, validateCatalog };
