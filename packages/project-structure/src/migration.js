"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { assertContract } = require("@orquesta/contracts");
const { normalizeRef } = require("./patterns");

const TEXT_EXTENSIONS = new Set([
  ".c", ".cjs", ".cpp", ".css", ".csv", ".h", ".html", ".js", ".json", ".jsonl",
  ".jsx", ".md", ".mjs", ".ps1", ".py", ".sh", ".sql", ".toml", ".ts", ".tsx",
  ".txt", ".xml", ".yaml", ".yml",
]);
const DEFAULT_REFERENCE_SCAN_BYTES = 2 * 1024 * 1024;

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
  return sourceRef === ".orquesta/project/migration-plan.json"
    || sourceRef.startsWith(".orquesta/project/migrations/")
    || sourceRef === ".orquesta/reports/V4F-PROJECT-STRUCTURE-PHASE5-PLAN.md";
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
    file.authority,
  ].join("\u0000"));
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
        reference_policy: "none",
        });
      }
    } else if (issue.code === "duplicate_current_content") {
      decisions.push({
        code: "duplicate_content_not_auto_retired",
        decision: "manual_review",
        reason: "Identical bytes do not prove that two consumer paths are interchangeable.",
        source_refs: [...(issue.source_refs || [])].sort(compareText),
      });
    } else if (issue.severity === "error") {
      blockers.push({
        code: issue.code,
        message: issue.message,
        source_refs: [...(issue.source_refs || [])].sort(compareText),
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
  const searchable = operations.filter((operation) => (
    operation.target_ref && operation.status !== "blocked" && operation.reference_policy !== "none"
  ));
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
        occurrence_count: occurrenceCount,
      });
    }
  }
  return rewrites.sort((left, right) => (
    compareText(left.operation_id, right.operation_id) || compareText(left.referrer, right.referrer)
  ));
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
  maxReferenceScanBytes = DEFAULT_REFERENCE_SCAN_BYTES,
} = {}) {
  if (!workspaceRoot) throw new TypeError("workspaceRoot is required");
  const root = fs.realpathSync(workspaceRoot);
  assertContract("project-layout", layout);
  assertContract("lifecycle-registry", lifecycleRegistry);
  const generated = generatedAt || new Date().toISOString();
  const fingerprint = workspaceFingerprint(inventory);
  const planId = `PSMP-${sha256(`${layout.project_id}\u0000${fingerprint}\u0000${generated}`).slice(0, 16)}`;
  const derived = auditCandidateSet(audit);
  const requestedByKey = new Map();
  for (const candidate of [...derived.candidates, ...(Array.isArray(candidates) ? candidates : [])]) {
    requestedByKey.set(`${candidate.action || "move"}\u0000${candidate.source_ref}`, candidate);
  }
  const requested = [...requestedByKey.values()].sort((left, right) => (
    compareText(String(left.source_ref), String(right.source_ref))
    || compareText(String(left.action || "move"), String(right.action || "move"))
  ));
  const seenSources = new Set();
  const targetOwners = new Map();
  const blockers = [...derived.blockers];
  const operations = [];

  for (const [index, raw] of requested.entries()) {
    let sourceRef;
    let targetRef = null;
    let sourcePath = null;
    let sourceHash = null;
    let targetPrecondition = raw.action === "delete" ? "not_applicable" : "missing";
    let status = "planned";
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
      status = "blocked";
      blockers.push({
        code: "unsafe_migration_operation",
        message: localBlockers.join(", "),
        source_refs: [sourceRef],
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
      status,
    });
  }

  const referenceRewrites = referenceRewritesForOperations({
    workspaceRoot: root,
    inventory,
    operations,
    maxReferenceScanBytes,
  });
  for (const operation of operations) {
    operation.reference_count = referenceRewrites
      .filter((item) => item.operation_id === operation.operation_id)
      .reduce((sum, item) => sum + item.occurrence_count, 0);
  }

  const hasQuarantine = operations.some((operation) => operation.action === "quarantine");
  const alreadyHasArchiveRule = (lifecycleRegistry.rules || []).some((rule) => (
    (rule.match || []).some((pattern) => pattern === ".orquesta/archive/structure-migrations/**")
  ));
  const manifestUpdates = hasQuarantine && !alreadyHasArchiveRule ? [{
    action: "add_rule",
    rule_id: "structure-migration-archive",
    match: [".orquesta/archive/structure-migrations/**"],
    lifecycle: "archived",
    authority: "supporting",
    read_policy: "explicit_only",
    storage_policy: "versioned",
    reason: "Reversible migration quarantine is excluded from normal task context.",
  }] : [];
  const planned = operations.filter((operation) => operation.status === "planned");
  const rollbackSteps = planned
    .filter((operation) => operation.target_ref && operation.source_sha256 && !operation.destructive)
    .map((operation) => ({
      operation_id: operation.operation_id,
      action: "move",
      source_ref: operation.target_ref,
      target_ref: operation.source_ref,
      expected_sha256: operation.source_sha256,
    }))
    .reverse();
  const destructive = planned.some((operation) => operation.destructive);
  const reversible = !destructive && rollbackSteps.length === planned.length;
  if (planned.length > 0 && !reversible) {
    blockers.push({
      code: "rollback_incomplete",
      message: "Every planned physical operation must have a verified reverse move.",
      source_refs: planned.filter((operation) => operation.destructive || !operation.source_sha256).map((operation) => operation.source_ref),
    });
  }
  const checks = [
    {
      code: "dry_run_only",
      status: "passed",
      details: "Planner generated evidence only; no project source was moved, rewritten, or deleted.",
    },
    {
      code: "project_boundary",
      status: blockers.some((item) => item.message.includes("escapes the project")) ? "blocked" : "passed",
      details: "All planned source and target paths must remain inside the selected project root.",
    },
    {
      code: "symlink_boundary",
      status: blockers.some((item) => item.message.includes("symlink")) ? "blocked" : "passed",
      details: "Symlink migration candidates are rejected rather than followed.",
    },
    {
      code: "hash_and_rollback",
      status: planned.length === 0 || reversible ? "passed" : "blocked",
      details: planned.length === 0 ? "No physical operations require rollback." : "Each reversible move records its source hash and reverse operation.",
    },
    {
      code: "reference_rewrite_plan",
      status: "passed",
      details: `${referenceRewrites.length} referrer files require planned path rewrites.`,
    },
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
      dirty_path_count: Math.max(0, Number(dirtyPathCount) || 0),
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
      applied: false,
    },
    decisions: derived.decisions,
    blockers,
    generated_at: generated,
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
    "",
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
    plan.approval.required
      ? "This entire plan requires user approval before any move, reference rewrite, manifest update, or cleanup is applied."
      : "No physical change is waiting for approval.",
    "",
  );
  return `${lines.join("\n")}\n`;
}

module.exports = {
  createProjectStructureMigrationPlan,
  renderMigrationPlanReview,
  workspaceFingerprint,
};
