"use strict";

const { readFile } = require("node:fs/promises");
const path = require("node:path");

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") return fallback;
    throw error;
  }
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim()))].sort();
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function coverageSummary(matrix) {
  const rows = Array.isArray(matrix) ? matrix : [];
  const covered = rows.filter((row) => row && row.status === "covered").length;
  return {
    total: rows.length,
    covered,
    uncovered: rows.length - covered,
    ratio: rows.length ? covered / rows.length : 0,
  };
}

function catalogLookup(records) {
  const byId = new Map();
  const byRef = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    if (!record || typeof record !== "object") continue;
    if (typeof record.source_id === "string") byId.set(record.source_id, record);
    if (typeof record.source_ref === "string") byRef.set(record.source_ref, record);
  }
  return { byId, byRef };
}

function tokenEstimateForRefs(refs, byRef) {
  const unknown = [];
  let tokens = 0;
  for (const ref of refs) {
    const record = byRef.get(ref);
    if (!record || !Number.isInteger(record.token_estimate)) unknown.push(ref);
    else tokens += record.token_estimate;
  }
  return { known_tokens: tokens, unknown_refs: unknown };
}

function comparableWorkspaceRefs(refs) {
  return refs.filter((ref) => !ref.includes(":"));
}

async function createContextV2ShadowReport(root, { generatedAt = new Date().toISOString() } = {}) {
  const contextRoot = path.join(path.resolve(root), ".orquesta", "context");
  const [shadowIndex, sourceCatalog, receipts] = await Promise.all([
    readJson(path.join(contextRoot, "shadow_index.json")),
    readJson(path.join(contextRoot, "source_catalog.json")),
    readJson(path.join(contextRoot, "receipt_index.json"), { receipts: [] }),
  ]);
  if (!shadowIndex || !Array.isArray(shadowIndex.comparisons)) {
    throw new Error("context_v2_shadow_index_missing");
  }
  if (!sourceCatalog || !Array.isArray(sourceCatalog.records)) {
    throw new Error("context_v2_source_catalog_missing");
  }
  const { byId, byRef } = catalogLookup(sourceCatalog.records);
  const receiptRows = Array.isArray(receipts.receipts) ? receipts.receipts : [];
  const latestReceiptByTask = new Map();
  for (const entry of receiptRows) {
    if (!entry || typeof entry.task_id !== "string" || typeof entry.receipt_id !== "string") continue;
    latestReceiptByTask.set(entry.task_id, entry);
  }

  const tasks = [];
  for (const comparison of shadowIndex.comparisons) {
    const v1Refs = uniqueStrings(comparison.v1_required_reading);
    const v2Refs = uniqueStrings(comparison.v2_selected_source_refs);
    const v1Comparable = comparableWorkspaceRefs(v1Refs);
    const v2Comparable = comparableWorkspaceRefs(v2Refs);
    const v1Tokens = tokenEstimateForRefs(v1Comparable, byRef);
    const v2Tokens = tokenEstimateForRefs(v2Comparable, byRef);
    const coverage = coverageSummary(comparison.coverage_matrix);
    const receiptIndexEntry = latestReceiptByTask.get(comparison.task_id);
    const receipt = receiptIndexEntry
      ? await readJson(path.join(contextRoot, "receipts", `${receiptIndexEntry.receipt_id}.json`))
      : null;
    const usedRefs = receipt
      ? uniqueStrings(receipt.used_source_ids.map((sourceId) => byId.get(sourceId)?.source_ref).filter(Boolean))
      : [];
    const unusedRefs = receipt
      ? uniqueStrings(receipt.unused_source_ids.map((sourceId) => byId.get(sourceId)?.source_ref).filter(Boolean))
      : [];
    tasks.push({
      task_id: comparison.task_id,
      owner_agent_id: comparison.owner_agent_id,
      context_pack_id: comparison.context_pack_id,
      v1: {
        required_source_count: v1Refs.length,
        comparable_workspace_source_count: v1Comparable.length,
        comparable_workspace_known_tokens: v1Tokens.known_tokens,
        unknown_token_refs: v1Tokens.unknown_refs,
      },
      v2: {
        selected_source_count: v2Refs.length,
        selected_token_estimate: comparison.v2_selected_tokens,
        comparable_workspace_source_count: v2Comparable.length,
        comparable_workspace_known_tokens: v2Tokens.known_tokens,
        unknown_token_refs: v2Tokens.unknown_refs,
        only_in_v1: uniqueStrings(comparison.only_in_v1),
        only_in_v2: uniqueStrings(comparison.only_in_v2),
        coverage,
        fallback_reason: comparison.fallback_reason || null,
      },
      runtime_receipt: receipt ? {
        receipt_id: receipt.receipt_id,
        used_source_count: usedRefs.length,
        unused_source_count: unusedRefs.length,
        used_source_refs: usedRefs,
        unused_source_refs: unusedRefs,
        additional_tokens: receipt.additional_tokens,
        compaction_count: receipt.compaction_count,
        missing_context_count: receipt.missing_context.length,
        user_corrections: receipt.user_corrections,
        incorrect_project_facts: receipt.incorrect_project_facts,
      } : null,
    });
  }
  tasks.sort((left, right) => left.task_id.localeCompare(right.task_id));
  const comparableTasks = tasks.filter((task) => (
    task.v1.unknown_token_refs.length === 0
    && task.v2.unknown_token_refs.length === 0
  ));
  return {
    version: 2,
    mode: shadowIndex.mode || "shadow",
    generated_at: generatedAt,
    assessment: "shadow_only_not_runtime_savings",
    tasks,
    totals: {
      task_count: tasks.length,
      receipt_count: tasks.filter((task) => task.runtime_receipt).length,
      comparable_task_count: comparableTasks.length,
      v1_comparable_workspace_known_tokens: sum(tasks.map((task) => task.v1.comparable_workspace_known_tokens)),
      v2_comparable_workspace_known_tokens: sum(tasks.map((task) => task.v2.comparable_workspace_known_tokens)),
      v2_selected_token_estimate: sum(tasks.map((task) => Number(task.v2.selected_token_estimate) || 0)),
      acceptance_criteria_total: sum(tasks.map((task) => task.v2.coverage.total)),
      acceptance_criteria_covered: sum(tasks.map((task) => task.v2.coverage.covered)),
      runtime_additional_tokens: sum(tasks.map((task) => task.runtime_receipt?.additional_tokens || 0)),
      runtime_compaction_count: sum(tasks.map((task) => task.runtime_receipt?.compaction_count || 0)),
      runtime_missing_context_count: sum(tasks.map((task) => task.runtime_receipt?.missing_context_count || 0)),
      runtime_user_corrections: sum(tasks.map((task) => task.runtime_receipt?.user_corrections || 0)),
      runtime_incorrect_project_facts: sum(tasks.map((task) => task.runtime_receipt?.incorrect_project_facts || 0)),
    },
    interpretation: {
      token_estimates_are_runtime_proof: false,
      comparable_workspace_tokens_exclude_task_envelope_and_task_intent: true,
      cutover_allowed_by_this_report: false,
    },
  };
}

async function runCli(argv = process.argv.slice(2), { stdout = process.stdout } = {}) {
  const rootIndex = argv.indexOf("--root");
  if (rootIndex === -1 || !argv[rootIndex + 1]) throw new Error("missing_option:root");
  const generatedAtIndex = argv.indexOf("--generated-at");
  const report = await createContextV2ShadowReport(argv[rootIndex + 1], {
    generatedAt: generatedAtIndex === -1 ? undefined : argv[generatedAtIndex + 1],
  });
  stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (require.main === module) {
  runCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { createContextV2ShadowReport, runCli };
