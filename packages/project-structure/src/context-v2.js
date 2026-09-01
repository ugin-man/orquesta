"use strict";

const { assertContract, canonicalHash } = require("@orquesta/contracts");

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
  return audit.issues
    .filter((item) => item.severity === "error" && item.code.startsWith("canonical_claim_"))
    .map((item) => ({
      code: item.code,
      claim_key: String(item.details?.claim_key || "unknown"),
      source_refs: [...item.source_refs].sort(compareText),
    }))
    .sort((left, right) => compareText(`${left.claim_key}:${left.code}`, `${right.claim_key}:${right.code}`));
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
      read_policy: file?.read_policy || "explicit_only",
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
    canonical_claim_errors: Object.freeze(errors),
  };
  Object.defineProperty(boundary, "eligible_previous_records", {
    value: Object.freeze(eligiblePreviousRecords),
    enumerable: false,
  });
  return Object.freeze(boundary);
}

function createComponentLifecycleSummary(inventory, projection) {
  const selected = new Set(projection.selected.map((file) => file.source_ref));
  const grouped = new Map();
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
    read_policy_counts: countBy(files, (file) => file.read_policy),
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
    components,
  };
  const overlayIdentity = {
    project_map_id: projectMap.project_map_id,
    status: lifecycleSummary.status,
    components,
  };
  return Object.freeze({
    ...projectMap,
    global_summary: {
      ...projectMap.global_summary,
      lifecycle_candidate_source_count: projection.stats.selected_files,
      lifecycle_excluded_source_count: projection.stats.excluded_files,
    },
    lifecycle_summary: lifecycleSummary,
    lifecycle_overlay_id: `LO-${canonicalHash(overlayIdentity).slice(0, 16)}`,
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
      summary: component.summary,
    })),
    lifecycle_components: (projectMap.lifecycle_summary?.components || []).map((component) => ({
      component_id: component.component_id,
      indexed_sources: component.indexed_sources,
      candidate_sources: component.candidate_sources,
      excluded_sources: component.excluded_sources,
      lifecycle_counts: component.lifecycle_counts,
      authority_counts: component.authority_counts,
      read_policy_counts: component.read_policy_counts,
    })),
    generated_at: projectMap.generated_at,
  };
  const identity = { ...content };
  delete identity.generated_at;
  return Object.freeze({
    ...content,
    project_map_view_id: `PMV-${canonicalHash(identity).slice(0, 16)}`,
  });
}

function createLifecycleContextReceipt({ boundary, projection, sourceCatalog = [], projectMap = null, createdAt } = {}) {
  if (!boundary || !projection) throw new TypeError("boundary and projection are required");
  const effective = (Array.isArray(sourceCatalog) ? sourceCatalog : [])
    .filter((record) => record.status === "current");
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
      estimated_candidate_tokens: projection.stats.selected_token_estimate,
    },
    exclusions: [...boundary.exclusions],
    canonical_claim_errors: [...boundary.canonical_claim_errors],
    created_at: createdAt || new Date().toISOString(),
  };
  return Object.freeze(assertContract("lifecycle-context-receipt", {
    ...content,
    receipt_id: `LCR-${canonicalHash(content).slice(0, 12)}`,
  }));
}

module.exports = {
  createComponentLifecycleSummary,
  createCompactProjectMapView,
  createLifecycleContextReceipt,
  createLifecycleReadBoundary,
  enrichProjectMapWithLifecycle,
};
