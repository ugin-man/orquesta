#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { canonicalHash } = require("@orquesta/contracts");
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
  const escalationTriggers = lane === "fast"
    ? ["acceptance_uncertain", "new_risk", "scope_drift", "test_failure"]
    : lane === "standard"
      ? ["budget_exhausted", "critical_risk_discovered", "scope_drift", "semantic_finding_not_machine_verifiable"]
      : [];
  const content = {
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
    escalation_triggers: escalationTriggers,
    revision: 1,
    supersedes_execution_plan_id: null
  };
  return { execution_plan_id: `EP-${canonicalHash(content).slice(0, 12)}`, ...content };
}

function phase15Task(lane, overrides = {}) {
  const requiresReview = lane !== "fast";
  const implementation = { cycle_id: "implementation-1", kind: "implementation", owner_agent_id: "implementation-001", status: "completed", evidence_refs: ["commit:abc"] };
  const cycles = [
    implementation,
    ...(requiresReview ? [{ cycle_id: "review-1", kind: "review", owner_agent_id: "protocol-architect-001", status: "accepted", findings: { critical: 0, important: 0, minor: 0 }, evidence_refs: [".orquesta/reports/P15-review.md"] }] : [])
  ];
  const review = cycles.find((cycle) => cycle.kind === "review");
  const handoffAttempts = requiresReview ? [
    { cycle_id: implementation.cycle_id, owner_agent_id: implementation.owner_agent_id, sent_at: "2026-07-16T00:00:00.000Z" },
    { cycle_id: review.cycle_id, owner_agent_id: review.owner_agent_id, sent_at: "2026-07-16T00:01:00.000Z" }
  ] : [];
  const metrics = {
    wall_time_ms: 1000,
    agent_turns: requiresReview ? 2 : 1,
    handoffs: handoffAttempts.length,
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
    handoff_attempts: handoffAttempts,
    specialist_report_required: requiresReview,
    specialist_report_path: requiresReview ? ".orquesta/reports/P15-review.md" : null,
    execution_policy_version: 1,
    canonical_state_root: "C:\\project",
    execution_plan: executionPlan(lane),
    execution_cycles: cycles,
    completion_evidence: [
      { kind: "implementation", ref: "commit:abc", status: "passed" },
      { kind: "test", ref: "npm run check:v4:phase15", status: "passed" }
    ],
    execution_metrics: metrics,
    ...(lane === "critical" ? { user_approval_evidence: { status: "approved", source: "user-goal:phase15", scope: "task acceptance" } } : {}),
    ...overrides
  };
}

function acceptedPhase15Task(lane, root) {
  const task = phase15Task(lane, {
    canonical_state_root: root,
    completion_evidence: [
      { kind: "implementation", ref: "commit:phase15", status: "passed" },
      { kind: "test", ref: "npm run check:v4:phase15", status: "passed" }
    ]
  });
  if (lane !== "fast") {
    const implementation = task.execution_cycles.find((cycle) => cycle.kind === "implementation");
    const review = task.execution_cycles.find((cycle) => cycle.kind === "review");
    task.handoff_attempts = [
      { cycle_id: implementation.cycle_id, owner_agent_id: implementation.owner_agent_id, sent_at: "2026-07-16T00:00:00.000Z" },
      { cycle_id: review.cycle_id, owner_agent_id: review.owner_agent_id, sent_at: "2026-07-16T00:01:00.000Z" }
    ];
    task.handoff_sent_at = "2026-07-16T00:00:00.000Z";
    task.specialist_report_path = review.evidence_refs[0];
    task.execution_metrics.handoffs = 2;
  }
  if (lane === "critical") {
    task.user_approval_evidence = { status: "approved", source: "user-goal:phase15", scope: "task acceptance" };
  }
  return task;
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

test("installed gate validates Phase 1.5 plans without the monorepo contracts package", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-installed-gate-"));
  try {
    const installedRoot = path.join(root, "installed");
    const installedGate = path.join(installedRoot, "orquesta", "scripts", "delegation-gate-check.js");
    const stateRoot = path.join(root, "state");
    fs.mkdirSync(path.dirname(installedGate), { recursive: true });
    fs.copyFileSync(path.join(__dirname, "delegation-gate-check.js"), installedGate);

    const valid = acceptedPhase15Task("standard", stateRoot);
    writeTasks(stateRoot, [valid]);
    const command = [installedGate, "--state-root", stateRoot];
    const options = {
      cwd: installedRoot,
      encoding: "utf8",
      env: { ...process.env, NODE_PATH: "" }
    };
    const success = spawnSync(process.execPath, command, options);
    assert.equal(success.status, 0, success.stderr);
    assert.match(success.stdout, /delegation gate check passed/);
    assert.doesNotMatch(success.stderr, /Cannot find module '@orquesta\/contracts'/);

    valid.execution_plan.extra_field = true;
    writeTasks(stateRoot, [valid]);
    const invalid = spawnSync(process.execPath, command, options);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /execution_plan contract is invalid/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Phase 1.5 gate rejects unsupported versions and binds contract, root, and routing flags", () => {
  assert.match(checkTask({ ...phase15Task("standard"), execution_policy_version: 2 }).errors.join("\n"), /unsupported execution_policy_version/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-phase15-binding-"));
  try {
    const valid = acceptedPhase15Task("standard", root);
    writeTasks(root, [valid]);
    assert.deepEqual(checkDelegationGate(root).errors, []);

    const invalidCases = [
      ["wrong root", (task) => { task.canonical_state_root = path.join(root, "other"); }, /canonical_state_root/],
      ["wrong handoff flag", (task) => { task.handoff_required = false; }, /handoff_required/],
      ["wrong report flag", (task) => { task.specialist_report_required = false; }, /specialist_report_required/],
      ["invalid plan", (task) => { task.execution_plan.execution_plan_id = "EP-000000000000"; }, /execution_plan integrity/],
    ];
    for (const [label, mutate, expected] of invalidCases) {
      const task = acceptedPhase15Task("standard", root);
      mutate(task);
      writeTasks(root, [task]);
      assert.match(checkDelegationGate(root).errors.join("\n"), expected, label);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("accepted Phase 1.5 tasks bind implementation, review, completion, approval, and token evidence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-phase15-acceptance-"));
  try {
    const valid = acceptedPhase15Task("critical", root);
    valid.execution_metrics.token_usage = {
      coverage: "complete",
      known_total: 13,
      by_thread: [
        { thread_id: "implementation-thread", measured_tokens: 8, evidence_source: "observed" },
        { thread_id: "review-thread", measured_tokens: 5, evidence_source: "observed" }
      ],
      participating_thread_ids: ["implementation-thread", "review-thread"]
    };
    writeTasks(root, [valid]);
    assert.deepEqual(checkDelegationGate(root).errors, []);

    const invalidCases = [
      ["missing implementation", (task) => { task.execution_cycles = task.execution_cycles.filter((cycle) => cycle.kind !== "implementation"); }, /implementation cycle/],
      ["missing implementation completion evidence", (task) => { task.completion_evidence = task.completion_evidence.filter((evidence) => evidence.kind !== "implementation"); }, /implementation completion evidence/],
      ["failed completion", (task) => { task.completion_evidence.push({ kind: "test", ref: "failed", status: "failed" }); }, /all completion evidence/],
      ["non-independent review", (task) => { task.execution_cycles.find((cycle) => cycle.kind === "review").owner_agent_id = "implementation-001"; }, /independent review owner/],
      ["unbound review handoff", (task) => { task.handoff_attempts = task.handoff_attempts.filter((attempt) => attempt.cycle_id !== "review-1"); }, /handoff bound/],
      ["unbound report", (task) => { task.specialist_report_path = ".orquesta/reports/other.md"; }, /review report/],
      ["missing critical approval", (task) => { delete task.user_approval_evidence; }, /user_approval_evidence/],
      ["meaningless partial tokens", (task) => { task.execution_metrics.token_usage = { coverage: "partial", known_total: 0, by_thread: [{}] }; }, /token_usage/],
      ["incomplete complete coverage", (task) => { task.execution_metrics.token_usage.participating_thread_ids = ["implementation-thread"]; }, /participating_thread_ids/],
    ];
    for (const [label, mutate, expected] of invalidCases) {
      const task = acceptedPhase15Task("critical", root);
      task.execution_metrics.token_usage = JSON.parse(JSON.stringify(valid.execution_metrics.token_usage));
      mutate(task);
      writeTasks(root, [task]);
      assert.match(checkDelegationGate(root).errors.join("\n"), expected, label);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Phase 1.5 source documentation describes lanes, same-task cycles, canonical state, and token coverage", () => {
  const root = path.resolve(__dirname, "..", "..");
  const skill = fs.readFileSync(path.join(root, "orquesta", "SKILL.md"), "utf8");
  const protocol = fs.readFileSync(path.join(root, "orquesta", "references", "orchestration-protocol.md"), "utf8");
  const schema = fs.readFileSync(path.join(root, "orquesta", "references", "state-schema.md"), "utf8");
  const source = `${skill}\n${protocol}\n${schema}`;

  for (const required of ["inline_verified", "fast", "standard", "critical", "execution_cycles", "canonical_state_root", "complete", "partial", "unknown"]) {
    assert.match(source, new RegExp(required));
  }
  assert.match(source, /auxiliary task|auxiliary_task|R, F, RR/i);
  assert.doesNotMatch(skill, /no handoff, no implementation/i);
  assert.doesNotMatch(protocol, /If a specialist exists and the task touches that lane, the short rule is: no handoff, no implementation/i);
  assert.match(`${skill}\n${protocol}`, /fast.*inline_verified/i);
});
