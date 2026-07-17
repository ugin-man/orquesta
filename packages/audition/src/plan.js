"use strict";

const path = require("node:path");
const { assertContract, canonicalHash } = require("@orquesta/contracts");

const EFFECTS = new Set(["dependency_change", "network_access", "workspace_write"]);
const HASH = /^[a-f0-9]{64}$/;

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort(compareText).map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function auditionError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function requiredText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requiredHash(value) {
  return typeof value === "string" && HASH.test(value) ? value : null;
}

function strictDescendant(rootPath, targetPath) {
  const relative = path.relative(rootPath, targetPath);
  return Boolean(relative) && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

function uniqueSortedStrings(value, code, allowed) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw auditionError(code, "Expected a non-empty string array.");
  }
  const normalized = value.map((item) => item.trim());
  if (new Set(normalized).size !== normalized.length) throw auditionError(code, "Duplicate values are not allowed.");
  if (allowed && normalized.some((item) => !allowed.has(item))) throw auditionError(code, "Unsupported value.");
  return normalized.sort(compareText);
}

function createAuditionPlan(input = {}) {
  const candidate = input.candidate;
  const binding = {
    task_intent_id: requiredText(input.task_intent_id),
    task_intent_hash: requiredHash(input.task_intent_hash),
    resolution_id: requiredText(input.resolution_id),
    resolution_revision: Number.isInteger(input.resolution_revision) && input.resolution_revision > 0 ? input.resolution_revision : null,
    resolution_hash: requiredHash(input.resolution_hash),
    candidate_id: candidate && requiredText(candidate.candidate_id),
    candidate_version: candidate && requiredText(candidate.version),
    candidate_source_hash: candidate && requiredHash(candidate.source_hash)
  };
  if (Object.values(binding).some((value) => value === null)) {
    throw auditionError("AUDITION_PLAN_INVALID", "Audition plan requires exact TaskIntent, Resolution, candidate, version, and hash bindings.");
  }

  const workspaceRoot = requiredText(input.workspace_root) && path.resolve(input.workspace_root);
  const temporaryRoot = requiredText(input.temporary_root) && path.resolve(input.temporary_root);
  const auditionRoot = requiredText(input.audition_root) && path.resolve(input.audition_root);
  if (!workspaceRoot || !temporaryRoot || !auditionRoot || !strictDescendant(temporaryRoot, auditionRoot)) {
    throw auditionError("AUDITION_ROOT_INVALID", "Audition root must be a dedicated child of the temporary root.");
  }
  if (workspaceRoot === temporaryRoot || strictDescendant(workspaceRoot, temporaryRoot) || strictDescendant(temporaryRoot, workspaceRoot)) {
    throw auditionError("AUDITION_ROOT_INVALID", "Workspace and temporary roots must be separate containment roots.");
  }

  const permittedEffects = uniqueSortedStrings(input.permitted_effects, "AUDITION_EFFECT_INVALID", EFFECTS);
  const expectedProfile = input.expected_profile;
  if (!expectedProfile || !Array.isArray(expectedProfile.allowed_roots) || !Array.isArray(expectedProfile.effects)) {
    throw auditionError("AUDITION_PLAN_INVALID", "Audition plan requires an expected Codex profile.");
  }
  const profileRoots = uniqueSortedStrings(expectedProfile.allowed_roots, "AUDITION_PLAN_INVALID").map((item) => path.resolve(item)).sort(compareText);
  const exactRoots = [workspaceRoot, auditionRoot].sort(compareText);
  if (stableJson(profileRoots) !== stableJson(exactRoots)) {
    throw auditionError("AUDITION_PLAN_INVALID", "Expected profile must bind the exact workspace and Audition roots.");
  }
  const profileEffects = uniqueSortedStrings(expectedProfile.effects, "AUDITION_EFFECT_INVALID", EFFECTS);
  if (stableJson(profileEffects) !== stableJson(permittedEffects)) {
    throw auditionError("AUDITION_EFFECT_INVALID", "Expected profile must bind the exact permitted effects.");
  }

  if (!Array.isArray(input.steps) || !input.steps.length || input.steps.some((step) => !step || !requiredText(step.step_id) || !requiredText(step.action))) {
    throw auditionError("AUDITION_PLAN_INVALID", "Audition plan requires explicit steps.");
  }
  const steps = uniqueSortedStrings(input.steps.map((step) => step.action), "AUDITION_PLAN_INVALID");
  const expectedEvidence = uniqueSortedStrings(input.expected_evidence, "AUDITION_PLAN_INVALID");
  const approvalRefs = uniqueSortedStrings(input.approval_refs, "AUDITION_PLAN_INVALID");
  const expectedProfileId = requiredText(expectedProfile.profile_id);
  if (!expectedProfileId) throw auditionError("AUDITION_PLAN_INVALID", "Audition plan requires a named Codex profile.");
  const cleanup = input.cleanup_plan;
  if (!cleanup || path.resolve(cleanup.root || "") !== auditionRoot || !Number.isInteger(cleanup.max_paths) || cleanup.max_paths < 1 || cleanup.max_paths > 128) {
    throw auditionError("AUDITION_PLAN_INVALID", "Cleanup must bind the dedicated Audition root with a bounded path count.");
  }

  const content = {
    candidate_id: binding.candidate_id,
    candidate_version: binding.candidate_version,
    candidate_hash: binding.candidate_source_hash,
    task_intent_id: binding.task_intent_id,
    resolution_id: binding.resolution_id,
    execution_root: { kind: "temporary", path: auditionRoot },
    expected_codex_profile: expectedProfileId,
    permitted_effects: permittedEffects,
    steps,
    expected_evidence: expectedEvidence,
    cleanup_plan: [`max_paths:${cleanup.max_paths}`, `root:${auditionRoot}`].sort(compareText),
    approval_refs: approvalRefs
  };
  const plan = { audition_plan_id: `AP-${canonicalHash(content).slice(0, 12)}`, ...content };
  try {
    return assertContract("audition-plan", plan);
  } catch (error) {
    throw auditionError("AUDITION_PLAN_INVALID", "Audition plan does not satisfy the registered durable contract.", { errors: error.errors || [] });
  }
}

module.exports = { auditionError, clone, compareText, createAuditionPlan, stableJson, strictDescendant };
