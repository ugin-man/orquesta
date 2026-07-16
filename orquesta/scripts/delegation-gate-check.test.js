#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { checkDelegationGate, checkTask, resolveStateRoot } = require("./delegation-gate-check");

const BUDGETS = {
  fast: { max_handoffs: 0, max_independent_reviews: 0, max_correction_batches: 1, max_reports: 0, max_auxiliary_tasks: 0 },
  standard: { max_handoffs: 2, max_independent_reviews: 1, max_correction_batches: 1, max_reports: 1, max_auxiliary_tasks: 0 },
  critical: { max_handoffs: 4, max_independent_reviews: 2, max_correction_batches: 2, max_reports: 2, max_auxiliary_tasks: 0 }
};

function writeTasks(root, tasks) {
  const tasksPath = path.join(root, ".orquesta", "state", "tasks.json");
  fs.mkdirSync(path.dirname(tasksPath), { recursive: true });
  fs.writeFileSync(tasksPath, JSON.stringify({ version: 1, tasks }, null, 2), "utf8");
}

function executionPlan(lane) {
  return {
    execution_plan_id: `EP-${lane.padEnd(12, "a").slice(0, 12)}`,
    task_intent_id: "TI-4c2eea2b9e6d",
    policy_version: 1,
    lane,
    risk_profile: { reversibility: "easy", scope: lane === "fast" ? "single_boundary" : "multiple_boundaries", verification: "deterministic", uncertainty: "low", effects: ["workspace_write"], repeated_failures: 0, user_review: "default" },
    reason_codes: lane === "fast" ? [] : ["multiple_boundaries"],
    routing: lane === "fast"
      ? { routing_class: "inline_verified", handoff_required: false, specialist_report_required: false }
      : { routing_class: "specialist_required", handoff_required: true, specialist_report_required: true },
    budget: BUDGETS[lane],
    review_policy: lane === "fast" ? "none" : lane === "standard" ? "independent_once" : "independent_twice",
    escalation_triggers: ["budget_exhausted", "critical_risk_discovered", "scope_drift", "semantic_finding_not_machine_verifiable"],
    revision: 1,
    supersedes_execution_plan_id: null
  };
}

function phase15Task(lane, overrides = {}) {
  const requiresReview = lane !== "fast";
  const cycles = [
    { cycle_id: "implementation-1", kind: "implementation", owner_agent_id: "implementation-001", status: "completed", evidence_refs: ["commit:abc"] },
    ...(requiresReview ? [{ cycle_id: "review-1", kind: "review", owner_agent_id: "protocol-architect-001", status: "accepted", findings: { critical: 0, important: 0, minor: 0 }, evidence_refs: [".orquesta/reports/P15-review.md"] }] : [])
  ];
  const metrics = {
    wall_time_ms: 1000,
    agent_turns: requiresReview ? 2 : 1,
    handoffs: requiresReview ? 1 : 0,
    independent_reviews: requiresReview ? 1 : 0,
    correction_batches: 0,
    reports: requiresReview ? 1 : 0,
    token_usage: { coverage: "unknown", known_total: null, by_thread: [] }
  };
  return {
    task_id: `P15-${lane.toUpperCase()}`,
    state: "accepted",
    owner_agent_id: "implementation-001",
    routing_class: lane === "fast" ? "inline_verified" : "specialist_required",
    routing_gate_status: "passed",
    handoff_required: requiresReview,
    handoff_sent_at: requiresReview ? "2026-07-16T00:00:00.000Z" : null,
    handoff_attempts: requiresReview ? [{ sent_at: "2026-07-16T00:00:00.000Z" }] : [],
    specialist_report_required: requiresReview,
    specialist_report_path: requiresReview ? ".orquesta/reports/P15-review.md" : null,
    execution_policy_version: 1,
    canonical_state_root: "C:\\project",
    execution_plan: executionPlan(lane),
    execution_cycles: cycles,
    completion_evidence: [{ kind: "test", ref: "npm run check:v4:phase15", status: "passed" }],
    execution_metrics: metrics,
    ...overrides
  };
}

test("legacy tasks remain on the existing delegation path", () => {
  assert.deepEqual(checkTask({
    task_id: "T001", state: "accepted", owner_agent_id: "implementation-001", routing_class: "specialist_required",
    routing_gate_status: "passed", handoff_required: true, handoff_sent_at: "2026-06-23T00:00:00.000Z",
    specialist_report_required: true, specialist_report_path: ".orquesta/reports/T001.md"
  }).errors, []);
});

test("accepts valid fast, standard, and critical Phase 1.5 tasks", () => {
  for (const lane of ["fast", "standard", "critical"]) {
    assert.deepEqual(checkTask(phase15Task(lane)).errors, [], lane);
  }
});

test("rejects invalid Phase 1.5 lane routing, accepted review evidence, and budget counts", () => {
  const fast = phase15Task("fast", { handoff_attempts: [{ sent_at: "2026-07-16T00:00:00.000Z" }], execution_metrics: { ...phase15Task("fast").execution_metrics, handoffs: 1 } });
  assert.match(checkTask(fast).errors.join("\n"), /fast.*handoff/i);

  const withoutReview = phase15Task("standard", { execution_cycles: [phase15Task("standard").execution_cycles[0]], execution_metrics: { ...phase15Task("standard").execution_metrics, independent_reviews: 0, reports: 0 } });
  assert.match(checkTask(withoutReview).errors.join("\n"), /independent.*review/i);

  const overBudget = phase15Task("standard");
  overBudget.execution_cycles.push({ cycle_id: "review-2", kind: "review", owner_agent_id: "protocol-architect-001", status: "accepted", findings: { critical: 0, important: 0, minor: 0 }, evidence_refs: [".orquesta/reports/P15-review-2.md"] });
  overBudget.execution_metrics.independent_reviews = 2;
  overBudget.execution_metrics.reports = 2;
  assert.match(checkTask(overBudget).errors.join("\n"), /max_independent_reviews/);

  const critical = phase15Task("critical");
  critical.handoff_attempts = Array.from({ length: 5 }, () => ({ sent_at: "2026-07-16T00:00:00.000Z" }));
  critical.execution_metrics.handoffs = 5;
  assert.match(checkTask(critical).errors.join("\n"), /max_handoffs/);
});

test("requires completion evidence, matching metrics, and honest token evidence", () => {
  const missingEvidence = phase15Task("standard", { completion_evidence: [], execution_metrics: undefined });
  assert.match(checkTask(missingEvidence).errors.join("\n"), /completion evidence/);
  assert.match(checkTask(missingEvidence).errors.join("\n"), /execution_metrics/);

  const mismatch = phase15Task("standard");
  mismatch.execution_metrics.handoffs = 0;
  assert.match(checkTask(mismatch).errors.join("\n"), /handoffs/);

  const unknownTotal = phase15Task("fast");
  unknownTotal.execution_metrics.token_usage.known_total = 0;
  assert.match(checkTask(unknownTotal).errors.join("\n"), /known_total/);

  for (const coverage of ["partial", "complete"]) {
    const noThreads = phase15Task("fast");
    noThreads.execution_metrics.token_usage = { coverage, known_total: 1, by_thread: [] };
    assert.match(checkTask(noThreads).errors.join("\n"), /by_thread/);
  }
});

test("rejects a child task that tries to represent a Phase 1.5 review or correction", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-phase15-child-"));
  try {
    writeTasks(root, [phase15Task("standard"), { task_id: "P15-CHILD", state: "active", execution_parent_task_id: "P15-STANDARD" }]);
    assert.match(checkDelegationGate(root).errors.join("\n"), /execution_cycle/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolves canonical state root with explicit then environment then cwd precedence", () => {
  const roots = ["explicit", "environment", "cwd"].map((label) => fs.mkdtempSync(path.join(os.tmpdir(), `orquesta-phase15-${label}-`)));
  try {
    for (const root of roots) writeTasks(root, []);
    assert.equal(resolveStateRoot({ argv: ["--state-root", roots[0]], env: { ORQUESTA_STATE_ROOT: roots[1] }, cwd: roots[2] }), roots[0]);
    assert.equal(resolveStateRoot({ argv: [], env: { ORQUESTA_STATE_ROOT: roots[1] }, cwd: roots[2] }), roots[1]);
    assert.equal(resolveStateRoot({ argv: [], env: {}, cwd: roots[2] }), roots[2]);
    assert.throws(() => resolveStateRoot({ argv: ["--state-root", path.join(roots[0], "missing")], env: { ORQUESTA_STATE_ROOT: roots[1] }, cwd: roots[2] }), /tasks\.json/);
  } finally {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  }
});
