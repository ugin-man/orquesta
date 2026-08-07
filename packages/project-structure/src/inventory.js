"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { assertContract } = require("@orquesta/contracts");
const { matchesAny, normalizeRef, relativeToRoot } = require("./patterns");

const HARD_IGNORED_DIRECTORY_NAMES = new Set([".git", "node_modules"]);
const DEFAULT_MAX_HASH_BYTES = 8 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set([
  ".c", ".cjs", ".cpp", ".css", ".csv", ".h", ".html", ".js", ".json", ".jsonl",
  ".jsx", ".md", ".mjs", ".ps1", ".py", ".sh", ".sql", ".toml", ".ts", ".tsx",
  ".txt", ".xml", ".yaml", ".yml",
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
  const matches = components
    .map((component, index) => ({ ...componentMatch(reference, component), index }))
    .filter((item) => item.component)
    .sort((left, right) => (
      right.root.length - left.root.length
      || left.index - right.index
      || compareText(left.component.component_id, right.component.component_id)
    ));
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
    classification_reason: component ? `component:${component.component_id}` : "no_declared_component",
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

  const claimKeys = lifecycleRegistry.canonical_claims
    .filter((claim) => normalizeRef(claim.source_ref) === ref)
    .map((claim) => claim.claim_key)
    .sort(compareText);
  if (claimKeys.length > 0) classification.authority = "canonical";

  return Object.freeze({ ...classification, claim_keys: Object.freeze(claimKeys) });
}

function isGeneratedDirectory(reference, layout, classification) {
  return matchesAny(reference, layout.generated_roots)
    || (classification.authority === "derived" && classification.read_policy === "never");
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
  maxHashBytes = DEFAULT_MAX_HASH_BYTES,
} = {}) {
  const root = safeWorkspaceRoot(workspaceRoot);
  const validatedLayout = assertContract("project-layout", layout);
  const validatedLifecycle = assertContract("lifecycle-registry", lifecycleRegistry);
  const files = [];
  const skipped = [];

  function visit(absoluteDirectory, relativeDirectory = ".") {
    const entries = fs.readdirSync(absoluteDirectory, { withFileTypes: true })
      .sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const reference = normalizeRef(relativeDirectory === "." ? entry.name : `${relativeDirectory}/${entry.name}`);
      const absolutePath = path.join(absoluteDirectory, entry.name);
      if (entry.isSymbolicLink()) {
        skipped.push({ source_ref: reference, kind: "symlink", reason: "symlink_not_followed" });
        continue;
      }
      if (entry.isDirectory()) {
        const classification = classifyReference(reference, validatedLayout, validatedLifecycle);
        if (HARD_IGNORED_DIRECTORY_NAMES.has(entry.name) || isGeneratedDirectory(reference, validatedLayout, classification)) {
          skipped.push({
            source_ref: reference,
            kind: "directory",
            reason: HARD_IGNORED_DIRECTORY_NAMES.has(entry.name) ? "hard_ignore" : "generated_or_never_read",
            component_id: classification.component_id,
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
        hash_state: hash.hash_state,
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
    generated_at: generatedAt || new Date().toISOString(),
    stats: {
      indexed_files: files.length,
      indexed_bytes: totalBytes,
      hashed_files: files.filter((file) => file.hash_state === "hashed").length,
      unhashed_large_files: files.filter((file) => file.hash_state === "skipped_large").length,
      unclassified_files: files.filter((file) => file.unclassified).length,
      skipped_entries: skipped.length,
      component_counts: componentCounts,
    },
    files,
    skipped,
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
      token_estimate: TEXT_EXTENSIONS.has(file.extension)
        ? Math.max(1, Math.ceil(file.size_bytes / 4))
        : 64,
      sha256: file.sha256,
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
      selected_token_estimate: selected.reduce((sum, file) => sum + file.token_estimate, 0),
    },
  });
}

module.exports = {
  classifyReference,
  createLifecycleProjection,
  scanProjectStructure,
};
