"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { assertContract, canonicalHash } = require("@orquesta/contracts");
const { classifyReference } = require("./inventory");
const { normalizeRef } = require("./patterns");

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function issue(code, message, sourceRefs = []) {
  return {
    code,
    message,
    source_refs: [...new Set(sourceRefs)].sort(compareText),
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
      read_policy: component?.default_read_policy === "never" ? "never" : "explicit_only",
    };
  }
  if (request.authority_intent === "external") {
    return { lifecycle: "current", authority: "external", read_policy: "explicit_only" };
  }
  return {
    lifecycle: request.retention === "permanent" ? component?.default_lifecycle || "current" : "draft",
    authority: "supporting",
    read_policy: request.retention === "temporary"
      ? "explicit_only"
      : component?.default_read_policy || "task_candidate",
  };
}

function normalizedStem(reference) {
  return path.posix.basename(reference, path.posix.extname(reference))
    .toLowerCase()
    .replace(/(?:^|[-_.])(?:v|version)?\d+(?:[-_.]\d+)*(?=$|[-_.])/gu, "-")
    .replace(/(?:^|[-_.])\d{4}[-_.]\d{2}[-_.]\d{2}(?=$|[-_.])/gu, "-")
    .replace(/[-_.]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

function detectSupersedesCandidates({ targetPath, componentId, claimKey, inventory, lifecycleRegistry, explicitRefs = [] } = {}) {
  const candidates = new Map();
  for (const reference of explicitRefs) {
    const safe = safeReference(reference);
    if (safe.value && safe.value !== targetPath) {
      candidates.set(safe.value, {
        source_ref: safe.value,
        reason: "Explicit replacement declared by the placement request.",
        confidence: "high",
      });
    }
  }
  if (claimKey) {
    for (const claim of lifecycleRegistry.canonical_claims.filter((entry) => entry.claim_key === claimKey)) {
      if (claim.source_ref !== targetPath) {
        candidates.set(claim.source_ref, {
          source_ref: claim.source_ref,
          reason: `Existing canonical source for ${claimKey}.`,
          confidence: "high",
        });
      }
    }
  }
  const stem = normalizedStem(targetPath || "");
  if (stem.length >= 4) {
    for (const file of inventory.files) {
      if (
        file.source_ref !== targetPath
        && file.component_id === componentId
        && file.lifecycle === "current"
        && path.posix.extname(file.source_ref).toLowerCase() === path.posix.extname(targetPath).toLowerCase()
        && normalizedStem(file.source_ref) === stem
        && !candidates.has(file.source_ref)
      ) {
        candidates.set(file.source_ref, {
          source_ref: file.source_ref,
          reason: "Same normalized artifact name in the same component; manual supersedes review is required.",
          confidence: "low",
        });
      }
    }
  }
  return [...candidates.values()].sort((left, right) => compareText(left.source_ref, right.source_ref));
}

function auditCanonicalClaimsForPlacement({ workspaceRoot, layout, lifecycleRegistry } = {}) {
  const claims = new Map();
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
        details: { claim_key: claimKey },
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
        details: { claim_key: claimKey },
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
        details: { claim_key: claimKey },
      });
    } else if (classification.read_policy === "never") {
      issues.push({
        severity: "error",
        code: "canonical_claim_never_read",
        message: `Canonical claim ${claimKey} is blocked from normal reads.`,
        source_refs: [reference],
        details: { claim_key: claimKey },
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
    decision_id: `PD-${canonicalHash(identity).slice(0, 12)}`,
  }));
}

function resolvePlacement({ workspaceRoot, layout, lifecycleRegistry, inventory, audit, request } = {}) {
  if (typeof workspaceRoot !== "string" || !workspaceRoot) throw new TypeError("workspaceRoot is required");
  const validatedRequest = assertContract("placement-request", request);
  assertContract("project-layout", layout);
  assertContract("lifecycle-registry", lifecycleRegistry);
  if (!inventory || !Array.isArray(inventory.files)) throw new TypeError("inventory is required");
  const warnings = [];
  const hardErrors = (audit?.issues || [])
    .filter((item) => item.severity === "error" && item.code.startsWith("canonical_claim_"))
    .map((item) => issue(item.code, item.message, item.source_refs));
  const component = layout.components.find((entry) => entry.component_id === validatedRequest.target_component_id) || null;
  let target = validatedRequest.proposed_path;
  if (!component) {
    warnings.push(issue(
      validatedRequest.target_component_id ? "unknown_target_component" : "target_component_missing",
      "The target component is not declared, so the artifact remains in the placement inbox.",
    ));
    target = inboxTarget(validatedRequest);
  } else if (!target) {
    target = normalizeRef(`${component.roots[0]}/${validatedRequest.suggested_name}`);
  }
  const safe = safeReference(target);
  if (!safe.value) {
    hardErrors.push(issue("project_write_escape", "The proposed output path escapes the declared project root.", [String(target)]));
    const defaults = placementDefaults(validatedRequest, component);
    return finalizeDecision({
      version: 1,
      task_id: validatedRequest.task_id,
      status: "blocked",
      target_path: null,
      component_id: component?.component_id || null,
      ...defaults,
      supersedes: [],
      supersedes_candidates: [],
      warnings,
      hard_errors: hardErrors,
      reason: "Project-external writes are a hard placement boundary.",
      created_at: validatedRequest.created_at,
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
      [target],
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
  if (
    rootLevel
    && !exists
    && !validatedRequest.root_placement_reason
    && validatedRequest.authority_intent !== "canonical_update"
  ) {
    warnings.push(issue(
      "unjustified_root_placement",
      "A new root-level artifact requires an explicit project-level reason; it remains in the placement inbox.",
      [target],
    ));
    target = inboxTarget(validatedRequest);
    classification = classifyReference(target, layout, lifecycleRegistry);
  }
  if (
    target !== inboxTarget(validatedRequest)
    && classification.read_policy === "never"
    && validatedRequest.authority_intent !== "derived"
  ) {
    warnings.push(issue(
      "normal_artifact_in_never_read_area",
      "A non-derived artifact cannot be proposed inside a never-read generated area; it remains in the placement inbox.",
      [target],
    ));
    target = inboxTarget(validatedRequest);
    classification = classifyReference(target, layout, lifecycleRegistry);
  }
  const inbox = target.startsWith("workbench/inbox/");
  const resolvedComponent = inbox
    ? layout.components.find((entry) => entry.component_id === "placement-inbox") || null
    : component;
  const defaults = inbox
    ? { lifecycle: "draft", authority: "supporting", read_policy: "explicit_only" }
    : placementDefaults(validatedRequest, resolvedComponent);
  if (validatedRequest.authority_intent === "canonical_update" && !validatedRequest.claim_key) {
    warnings.push(issue(
      "canonical_claim_key_missing",
      "The canonical update has no claim key; only entry points, contracts, settings, and accepted decisions normally need one.",
      [target],
    ));
  }
  const supersedesCandidates = detectSupersedesCandidates({
    targetPath: target,
    componentId: resolvedComponent?.component_id || classification.component_id,
    claimKey: validatedRequest.claim_key,
    inventory,
    lifecycleRegistry,
    explicitRefs: validatedRequest.replaces,
  });
  const explicitSet = new Set(validatedRequest.replaces.map((reference) => safeReference(reference).value).filter(Boolean));
  const supersedes = supersedesCandidates
    .filter((candidate) => explicitSet.has(candidate.source_ref))
    .map((candidate) => candidate.source_ref);
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
    reason: inbox
      ? "The final component or safe path is not yet certain, so the artifact remains task-scoped and visible for completion review."
      : exists
        ? "The request updates an existing file inside its declared component."
        : "The requested component and proposed path agree with the project layout manifest.",
    created_at: validatedRequest.created_at,
  });
}

function inspectTaskPlacementCompletion({ taskId, changedPaths, layout, lifecycleRegistry, inventory, audit, checkedAt } = {}) {
  const warnings = [];
  const hardErrors = (audit?.issues || [])
    .filter((item) => item.severity === "error" && item.code.startsWith("canonical_claim_"))
    .map((item) => issue(item.code, item.message, item.source_refs));
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
    checked_at: checkedAt || new Date().toISOString(),
    changed_paths: [...new Set(Array.isArray(changedPaths) ? changedPaths : [])].sort(compareText),
    warnings,
    hard_errors: hardErrors,
    inventory_file_count: Array.isArray(inventory?.files) ? inventory.files.length : 0,
  });
}

module.exports = {
  auditCanonicalClaimsForPlacement,
  detectSupersedesCandidates,
  inspectTaskPlacementCompletion,
  resolvePlacement,
};
