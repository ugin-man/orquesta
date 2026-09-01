"use strict";

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

const SEVERITY_ORDER = new Map([["error", 0], ["warning", 1], ["suggestion", 2]]);

function issue(severity, code, message, sourceRefs = [], details = {}) {
  return {
    severity,
    code,
    message,
    source_refs: [...new Set(sourceRefs)].sort(compareText),
    details,
  };
}

function groupBy(values, keyFor) {
  const result = new Map();
  for (const value of values) {
    const key = keyFor(value);
    if (!result.has(key)) result.set(key, []);
    result.get(key).push(value);
  }
  return result;
}

function directDirectoryCounts(files) {
  const counts = new Map();
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
        { claim_key: claimKey },
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
          { claim_key: claimKey },
        ));
      } else if (file.lifecycle !== "current") {
        issues.push(issue(
          "error",
          "canonical_claim_not_current",
          `Canonical claim ${claimKey} points to a ${file.lifecycle} source.`,
          [reference],
          { claim_key: claimKey, lifecycle: file.lifecycle },
        ));
      } else if (file.read_policy === "never") {
        issues.push(issue(
          "error",
          "canonical_claim_never_read",
          `Canonical claim ${claimKey} is blocked from all normal reads.`,
          [reference],
          { claim_key: claimKey },
        ));
      }
    }
  }

  const supersededReadable = inventory.files.filter((file) => (
    file.lifecycle === "superseded"
    && ["bootstrap_candidate", "task_candidate"].includes(file.read_policy)
  ));
  if (supersededReadable.length > 0) {
    issues.push(issue(
      "error",
      "superseded_source_is_read_candidate",
      `${supersededReadable.length} superseded sources remain normal read candidates.`,
      supersededReadable.slice(0, 30).map((file) => file.source_ref),
      { count: supersededReadable.length },
    ));
  }

  const derivedReadable = inventory.files.filter((file) => (
    file.authority === "derived"
    && ["bootstrap_candidate", "task_candidate"].includes(file.read_policy)
  ));
  if (derivedReadable.length > 0) {
    issues.push(issue(
      "warning",
      "derived_source_is_read_candidate",
      `${derivedReadable.length} derived sources remain normal read candidates.`,
      derivedReadable.slice(0, 30).map((file) => file.source_ref),
      { count: derivedReadable.length },
    ));
  }

  const unclassified = inventory.files.filter((file) => file.unclassified);
  if (unclassified.length > 0) {
    issues.push(issue(
      "warning",
      "unclassified_sources",
      `${unclassified.length} sources are outside declared component rules.`,
      unclassified.slice(0, 30).map((file) => file.source_ref),
      { count: unclassified.length },
    ));
  }

  const runtimeEphemeral = inventory.files.filter((file) => (
    file.source_ref.startsWith(".orquesta/state/")
    && (file.source_ref.endsWith(".bak") || /\.tmp(?:[-.].*)?$/u.test(file.source_ref))
  ));
  if (runtimeEphemeral.length > 0) {
    issues.push(issue(
      "warning",
      "runtime_ephemeral_next_to_canonical_state",
      `${runtimeEphemeral.length} backup or temporary files sit beside canonical runtime state.`,
      runtimeEphemeral.slice(0, 30).map((file) => file.source_ref),
      { count: runtimeEphemeral.length },
    ));
  }

  const duplicateGroups = [...groupBy(
    inventory.files.filter((file) => file.sha256 && file.authority !== "derived" && file.lifecycle === "current"),
    (file) => file.sha256,
  ).entries()].filter(([, files]) => files.length > 1);
  for (const [hash, files] of duplicateGroups.slice(0, 20)) {
    issues.push(issue(
      "suggestion",
      "duplicate_current_content",
      "Multiple current non-derived sources have identical content.",
      files.map((file) => file.source_ref),
      { sha256: hash, count: files.length },
    ));
  }

  const wideDirectories = [...directDirectoryCounts(inventory.files).entries()]
    .filter(([, count]) => count > wideDirectoryThreshold)
    .sort((left, right) => right[1] - left[1] || compareText(left[0], right[0]));
  for (const [directory, count] of wideDirectories.slice(0, 20)) {
    issues.push(issue(
      "warning",
      "wide_directory",
      `Directory contains ${count} direct files and should be reviewed for component boundaries.`,
      [directory],
      { direct_file_count: count, threshold: wideDirectoryThreshold },
    ));
  }

  issues.sort((left, right) => (
    SEVERITY_ORDER.get(left.severity) - SEVERITY_ORDER.get(right.severity)
    || compareText(left.code, right.code)
    || compareText(left.source_refs[0] || "", right.source_refs[0] || "")
  ));
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
      unclassified_files: inventory.stats.unclassified_files,
    },
    issues,
  });
}

module.exports = { auditProjectStructure };
