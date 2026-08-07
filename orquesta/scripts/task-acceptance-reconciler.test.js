"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const { createExecutionPlan } = require("../../packages/core/src/execution-policy");
const { createTaskIntent } = require("../../packages/core/src/task-intent");
const { checkDelegationGate } = require("./delegation-gate-check");
const {
  canonicalEnvelopeFromSpecialistResult,
  extractSpecialistResult,
  finalizeAcceptanceAudit,
  reconcileTaskAcceptanceAtomic,
  reconcileTaskAcceptanceBatchAtomic,
  safeRelativePath,
  sameAcceptanceClaim,
} = require("./task-acceptance-reconciler");

function writeJson(root, relative, value) {
  const filePath = path.join(root, ...relative.split("/"));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeText(root, relative, value) {
  const filePath = path.join(root, ...relative.split("/"));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, "utf8");
}

function reportText({
  taskId,
  agentId,
  reportPath,
  createdAt,
  questionCandidates = null,
  includeQuestionCandidates = true,
  changes = null,
  verification = null,
  noCommandsReason = null,
}) {
  const result = {
    version: 1,
    task_id: taskId,
    agent_id: agentId,
    status: "completed",
    summary: "Created the required artifact.",
    files_read: ["fixture.json"],
    changes: changes || [{
      path: "artifact.json",
      kind: "created",
      summary: "Created the required artifact.",
    }],
    verification: verification || [{
      command: "node verify.js",
      status: "passed",
      expected: "Artifact matches the fixture.",
      evidence: "Exit code 0.",
    }],
    not_verified: [],
    open_risks: [],
    completed_at: createdAt,
  };
  if (noCommandsReason) result.no_commands_reason = noCommandsReason;
  if (includeQuestionCandidates) {
    result.question_candidates = questionCandidates || {
      status: "none",
      none_reason: "purely_mechanical_change",
      none_rationale: "The deterministic fixture exposes no user decision.",
    };
  }
  return [
    "# Specialist Result",
    "",
    `task_id: ${taskId}`,
    `agent_id: ${agentId}`,
    "status: completed",
    "",
    "## Result",
    "",
    "```json",
    JSON.stringify({ specialist_result: result }, null, 2),
    "```",
    "",
  ].join("\n");
}

test("reconciles an accepted specialist review without an orchestrator state-edit turn", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-acceptance-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const taskId = "TASK-1";
  const agentId = "implementation-001";
  const reportPath = `.orquesta/reports/${taskId}-${agentId}.md`;
  const reviewPath = `.orquesta/reviews/${taskId}-orchestrator.json`;
  const acceptedAt = "2026-07-30T00:05:00.000Z";
  const taskIntent = createTaskIntent({
    rawRequestRef: "test:TASK-1",
    desiredOutcome: "Create artifact.json.",
    acceptanceCriteria: ["artifact.json exists and matches the deterministic fixture."],
    constraints: ["Keep changes inside the project root."],
    risk: { impact: "medium", reversible: true },
    authorityBoundary: {
      agent_may: ["write artifact.json"],
      user_only: ["authorize destructive actions"],
    },
    assumptions: ["The fixture is complete."],
    status: "compiled",
  });
  const executionPlan = createExecutionPlan({
    taskIntent,
    riskProfile: {
      reversibility: "easy",
      scope: "multiple_boundaries",
      verification: "deterministic",
      uncertainty: "low",
      effects: ["workspace_write"],
      repeated_failures: 0,
      user_review: "default",
    },
  });
  const task = {
    task_id: taskId,
    title: "Fixture task",
    state: "completed",
    owner_agent_id: agentId,
    created_at: "2026-07-30T00:00:00.000Z",
    dependencies: [],
    blocked_by: [],
    task_intent: taskIntent,
    execution_policy_version: 1,
    canonical_state_root: root,
    execution_plan: executionPlan,
    routing_class: "specialist_required",
    routing_gate_status: "passed",
    handoff_required: true,
    handoff_sent_at: "2026-07-30T00:00:00.000Z",
    handoff_attempts: [{
      cycle_id: "implementation-1",
      owner_agent_id: agentId,
      sent_at: "2026-07-30T00:00:00.000Z",
      transport: "manual_recovery",
      evidence: "fixture receipt",
    }],
    specialist_report_required: true,
    specialist_report_path: reportPath,
    execution_cycles: [],
    completion_evidence: [],
    execution_metrics: {
      wall_time_ms: 0,
      agent_turns: 1,
      handoffs: 1,
      independent_reviews: 0,
      correction_batches: 0,
      reports: 0,
      token_usage: { coverage: "unknown", known_total: null, by_thread: [] },
    },
    completion_envelope: { status: "submitted", path: reportPath },
    model_route: {
      status: "recommended",
      recommended_model: "Terra",
      requested_model: null,
      actual_model: null,
      adapter: "repository_only",
    },
  };
  writeJson(root, ".orquesta/state/tasks.json", { version: 1, tasks: [task] });
  writeJson(root, ".orquesta/state/agents.json", {
    version: 1,
    agents: [
      {
        agent_id: agentId,
        operational_status: "standby",
        lifecycle_state: "active",
      },
      {
        agent_id: "user-support",
        operational_status: "standby",
        lifecycle_state: "active",
        last_heartbeat: "2026-07-30T00:04:00.000Z",
      },
    ],
  });
  writeJson(root, ".orquesta/state/sessions.json", {
    version: 1,
    sessions: [
      {
        session_id: `session-${agentId}`,
        agent_id: agentId,
        thread_id: "thread-1",
        handoff_turn_id: "turn-1",
        status: "standby",
      },
      {
        session_id: "session-user-support",
        agent_id: "user-support",
        thread_id: "thread-user-support",
        host_id: "local",
        handoff_status: "accepted",
        binding_status: "bound",
        status: "standby",
      },
    ],
    synced_at: "2026-07-30T00:04:00.000Z",
  });
  writeJson(root, ".orquesta/state/directives.json", { version: 1, directives: [] });
  writeJson(root, ".orquesta/project/completion_map.json", {
    version: 2,
    status: "in_progress",
    tasks: [{ task_id: taskId, status: "in_progress" }],
  });
  writeJson(root, ".orquesta/setup/setup_state.json", {
    setup_id: "SETUP-1",
    project_id: "project-1",
    project_title: "Acceptance fixture",
    status: "completed",
  });
  writeText(root, ".orquesta/state/events.jsonl", "");
  writeText(root, "artifact.json", "{\"ok\":true}\n");
  writeText(root, reportPath, reportText({
    taskId,
    agentId,
    reportPath,
    createdAt: "2026-07-30T00:03:00.000Z",
    questionCandidates: {
      status: "submitted",
      items: [{
        priority: "high",
        category: "technical_direction",
        question: "Should the next task preserve the current artifact format?",
        why_now: "The next task may otherwise introduce an incompatible format.",
        user_impact: "The choice changes compatibility for future work.",
        suggested_timing: "before_next_task",
        source_task_id: taskId,
        source_agent_id: agentId,
        source_report_path: reportPath,
      }],
    },
  }));
  const review = {
    schema_version: 1,
    task_id: taskId,
    review_owner_agent_id: "orchestrator",
    status: "accepted",
    findings: { critical: 0, important: 0, minor: 0 },
    evidence_refs: [reportPath, "artifact.json", reviewPath],
    completion_evidence: [
      { kind: "implementation", ref: "artifact.json", status: "passed" },
      { kind: "deterministic_check", ref: "node verify.js", status: "passed" },
    ],
    review_path: reviewPath,
    reviewed_at: acceptedAt,
    summary: "The deterministic fixture passed independent review.",
  };
  writeJson(root, reviewPath, review);
  const receipt = {
    agent_id: agentId,
    task_id: taskId,
    thread_id: "thread-1",
    turn_id: "turn-1",
    status: "completed",
    report_path: reportPath,
    actual_model: "gpt-5.6-terra",
    initial_turn_id: "turn-initial",
    correction_turn_id: "turn-1",
  };

  writeJson(root, reviewPath, { ...review, summary: "A different durable verdict." });
  assert.throws(() => reconcileTaskAcceptanceAtomic({
    rootPath: root,
    taskId,
    receipt,
    review,
    now: acceptedAt,
  }), (error) => error.code === "TASK_ACCEPTANCE_REVIEW_MISMATCH");
  writeJson(root, reviewPath, review);

  const unboundEvidenceReview = {
    ...review,
    completion_evidence: [
      { kind: "implementation", ref: "missing-artifact.json", status: "passed" },
      { kind: "deterministic_check", ref: "node verify.js", status: "passed" },
    ],
  };
  writeJson(root, reviewPath, unboundEvidenceReview);
  assert.throws(() => reconcileTaskAcceptanceAtomic({
    rootPath: root,
    taskId,
    receipt,
    review: unboundEvidenceReview,
    now: acceptedAt,
  }), (error) => error.code === "TASK_ACCEPTANCE_INVALID");
  writeJson(root, reviewPath, review);

  const reportBeforePathAttack = fs.readFileSync(
    path.join(root, ...reportPath.split("/")),
    "utf8",
  );
  writeText(root, reportPath, reportText({
    taskId,
    agentId,
    reportPath,
    createdAt: "2026-07-30T00:03:00.000Z",
    changes: [{
      path: "../outside-artifact.json",
      kind: "created",
      summary: "Attempted to claim a change outside the project.",
    }],
  }));
  assert.throws(() => reconcileTaskAcceptanceAtomic({
    rootPath: root,
    taskId,
    receipt,
    review,
    now: acceptedAt,
  }), (error) => error.code === "TASK_ACCEPTANCE_PATH_ESCAPE");
  writeText(root, reportPath, reportBeforePathAttack);

  const tasksBeforeClaimConflict = JSON.parse(
    fs.readFileSync(path.join(root, ".orquesta/state/tasks.json"), "utf8"),
  );
  tasksBeforeClaimConflict.tasks[0].acceptance_claim = {
    thread_id: "thread-competitor",
    turn_id: "turn-competitor",
    receipt_sha256: "d".repeat(64),
    report_sha256: "a".repeat(64),
    review_sha256: "b".repeat(64),
    task_snapshot_sha256: "c".repeat(64),
    claimed_at: acceptedAt,
  };
  writeJson(root, ".orquesta/state/tasks.json", tasksBeforeClaimConflict);
  const reportBeforeClaimConflict = fs.readFileSync(
    path.join(root, ...reportPath.split("/")),
    "utf8",
  );
  assert.throws(() => reconcileTaskAcceptanceAtomic({
    rootPath: root,
    taskId,
    receipt,
    review,
    now: acceptedAt,
  }), (error) => error.code === "TASK_ACCEPTANCE_IN_PROGRESS");
  assert.equal(
    fs.readFileSync(path.join(root, ...reportPath.split("/")), "utf8"),
    reportBeforeClaimConflict,
  );
  delete tasksBeforeClaimConflict.tasks[0].acceptance_claim;
  writeJson(root, ".orquesta/state/tasks.json", tasksBeforeClaimConflict);

  const reportFilePath = path.join(root, ...reportPath.split("/"));
  const reportBeforeInterruptedWrite = fs.readFileSync(reportFilePath, "utf8");
  const originalRenameSync = fs.renameSync;
  fs.renameSync = (sourcePath, targetPath) => {
    if (targetPath === reportFilePath && String(sourcePath).includes(".tmp-")) {
      const error = new Error("simulated report replacement failure");
      error.code = "EIO";
      throw error;
    }
    return originalRenameSync(sourcePath, targetPath);
  };
  try {
    assert.throws(() => reconcileTaskAcceptanceAtomic({
      rootPath: root,
      taskId,
      receipt,
      review,
      now: acceptedAt,
    }), /simulated report replacement failure/);
  } finally {
    fs.renameSync = originalRenameSync;
  }
  const claimedAfterInterruptedWrite = JSON.parse(
    fs.readFileSync(path.join(root, ".orquesta/state/tasks.json"), "utf8"),
  ).tasks[0];
  assert.equal(claimedAfterInterruptedWrite.state, "completed");
  assert.equal(claimedAfterInterruptedWrite.acceptance_claim.turn_id, receipt.turn_id);
  assert.equal(fs.readFileSync(reportFilePath, "utf8"), reportBeforeInterruptedWrite);

  const result = reconcileTaskAcceptanceAtomic({
    rootPath: root,
    taskId,
    receipt,
    review,
    now: acceptedAt,
  });

  assert.equal(result.status, "accepted");
  assert.equal(result.control_audit.status, "clear");
  assert.equal(result.question_candidate_intake.recorded_count, 1);
  assert.equal(result.support_wake.status, "ready");
  assert.equal(result.support_wake.thread_id, "thread-user-support");
  assert.equal(result.support_wake.preferred_transport, "send_message_to_thread");
  const tasks = JSON.parse(fs.readFileSync(path.join(root, ".orquesta/state/tasks.json"), "utf8"));
  assert.equal(tasks.tasks[0].state, "accepted");
  assert.equal(tasks.tasks[0].execution_metrics.handoffs, 2);
  assert.equal(tasks.tasks[0].execution_metrics.independent_reviews, 1);
  assert.equal(tasks.tasks[0].execution_metrics.correction_batches, 1);
  assert.equal(tasks.tasks[0].model_route.actual_model, "gpt-5.6-terra");
  assert.equal(Object.hasOwn(tasks.tasks[0], "acceptance_claim"), false);
  assert.equal(checkDelegationGate(root).errors.length, 0);
  const report = fs.readFileSync(path.join(root, ...reportPath.split("/")), "utf8");
  assert.match(report, /Canonical Completion Envelope/);
  assert.equal((report.match(/"question_candidates"/g) || []).length, 1);
  assert.match(report, /"actual_model": "gpt-5\.6-terra"/);
  const capacity = JSON.parse(fs.readFileSync(path.join(root, ".orquesta/state/capacity.json"), "utf8"));
  assert.equal(capacity.dispatches[0].state, "report_produced");
  assert.match(
    fs.readFileSync(path.join(root, ".orquesta/CURRENT_ORCHESTRA.md"), "utf8"),
    /TASK-1: accepted/,
  );
  const eventCount = fs.readFileSync(path.join(root, ".orquesta/state/events.jsonl"), "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .length;
  assert.equal(eventCount, 3);
  const questionInbox = JSON.parse(
    fs.readFileSync(path.join(root, ".orquesta/vision/question_candidates.json"), "utf8"),
  );
  assert.equal(questionInbox.candidates.length, 1);
  assert.equal(questionInbox.policy.curator_agent_id, "user-support");
  const wakeRequest = JSON.parse(
    fs.readFileSync(path.join(root, ".orquesta/state/user_support_wake.json"), "utf8"),
  );
  assert.equal(wakeRequest.status, "ready");
  assert.equal(wakeRequest.thread_id, "thread-user-support");

  assert.throws(() => reconcileTaskAcceptanceAtomic({
    rootPath: root,
    taskId,
    receipt: { ...receipt, turn_id: "turn-different" },
    review,
    now: acceptedAt,
  }), (error) => error.code === "TASK_ACCEPTANCE_ALREADY_RECONCILED");
  const acceptedAfterConflictingReceipt = JSON.parse(
    fs.readFileSync(path.join(root, ".orquesta/state/tasks.json"), "utf8"),
  ).tasks[0];
  assert.equal(acceptedAfterConflictingReceipt.specialist_receipt.turn_id, "turn-1");
  assert.equal(
    fs.readFileSync(path.join(root, ".orquesta/state/events.jsonl"), "utf8")
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .length,
    3,
  );

  const tasksWithUnrelatedBlocker = JSON.parse(
    fs.readFileSync(path.join(root, ".orquesta/state/tasks.json"), "utf8"),
  );
  tasksWithUnrelatedBlocker.tasks.push({
    task_id: "UNRELATED-BROKEN",
    state: "accepted",
    owner_agent_id: "broken-001",
    control_rollout: "beta_v3",
    routing_class: "specialist_required",
    handoff_required: true,
    specialist_report_required: true,
  });
  writeJson(root, ".orquesta/state/tasks.json", tasksWithUnrelatedBlocker);
  const diagnosticOnly = finalizeAcceptanceAudit(root, acceptedAt);
  assert.ok(diagnosticOnly.delegation_gate.errors.length > 0);
  assert.equal(diagnosticOnly.control_audit.status, "blockers");
  tasksWithUnrelatedBlocker.tasks.pop();
  writeJson(root, ".orquesta/state/tasks.json", tasksWithUnrelatedBlocker);

  const completionMapPath = path.join(root, ".orquesta/project/completion_map.json");
  const completionMapBeforeFailure = fs.readFileSync(completionMapPath, "utf8");
  fs.rmSync(completionMapPath, { force: true });
  fs.mkdirSync(completionMapPath);
  const repeatedWithProjectionFailure = reconcileTaskAcceptanceAtomic({
    rootPath: root,
    taskId,
    receipt,
    review,
    now: acceptedAt,
  });
  assert.equal(repeatedWithProjectionFailure.status, "already_reconciled");
  assert.ok(repeatedWithProjectionFailure.post_acceptance_errors.some((item) => (
    item.code === "post_acceptance_completion_map_unavailable"
  )));
  fs.rmSync(completionMapPath, { recursive: true, force: true });
  fs.writeFileSync(completionMapPath, completionMapBeforeFailure, "utf8");

  const incompleteCompletionMap = JSON.parse(completionMapBeforeFailure);
  incompleteCompletionMap.tasks[0].status = "in_progress";
  delete incompleteCompletionMap.tasks[0].completed_at;
  writeJson(root, ".orquesta/project/completion_map.json", incompleteCompletionMap);
  const eventsPath = path.join(root, ".orquesta/state/events.jsonl");
  const incompleteEvents = fs.readFileSync(eventsPath, "utf8")
    .trim()
    .split(/\r?\n/)
    .map(JSON.parse)
    .filter((event) => event.event_id !== `acceptance:${taskId}:accepted`);
  fs.writeFileSync(eventsPath, `${incompleteEvents.map(JSON.stringify).join("\n")}\n`, "utf8");

  const repeated = reconcileTaskAcceptanceAtomic({
    rootPath: root,
    taskId,
    receipt,
    review,
    now: acceptedAt,
  });
  assert.equal(repeated.status, "already_reconciled");
  assert.equal(repeated.question_candidate_intake.recorded_count, 0);
  assert.equal(repeated.question_candidate_intake.skipped_duplicate_count, 1);
  assert.equal(repeated.support_wake.status, "ready");
  assert.deepEqual(repeated.post_acceptance_errors, []);
  assert.equal(
    JSON.parse(fs.readFileSync(completionMapPath, "utf8")).tasks[0].status,
    "done",
  );
  assert.equal(
    fs.readFileSync(path.join(root, ".orquesta/state/events.jsonl"), "utf8")
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .length,
    3,
  );

  const acceptedTask = JSON.parse(
    fs.readFileSync(path.join(root, ".orquesta/state/tasks.json"), "utf8"),
  ).tasks[0];
  const batchItems = ["2", "3"].map((suffix) => {
    const nextTaskId = `TASK-${suffix}`;
    const nextAgentId = `implementation-00${suffix}`;
    const nextReportPath = `.orquesta/reports/${nextTaskId}-${nextAgentId}.md`;
    const nextReviewPath = `.orquesta/reviews/${nextTaskId}-orchestrator.json`;
    writeText(root, nextReportPath, reportText({
      taskId: nextTaskId,
      agentId: nextAgentId,
      reportPath: nextReportPath,
      createdAt: acceptedAt,
      includeQuestionCandidates: suffix !== "2",
    }));
    const nextReview = {
      ...review,
      task_id: nextTaskId,
      evidence_refs: [nextReportPath, "artifact.json", nextReviewPath],
      review_path: nextReviewPath,
    };
    writeJson(root, nextReviewPath, nextReview);
    return {
      task: {
        ...task,
        task_id: nextTaskId,
        owner_agent_id: nextAgentId,
        specialist_report_path: nextReportPath,
        completion_envelope: { status: "submitted", path: nextReportPath },
        handoff_attempts: [],
      },
      agent: {
        agent_id: nextAgentId,
        operational_status: "standby",
        lifecycle_state: "active",
      },
      session: {
        session_id: `session-${nextAgentId}`,
        agent_id: nextAgentId,
        thread_id: `thread-${suffix}`,
        handoff_turn_id: `turn-${suffix}`,
        status: "standby",
      },
      acceptance: {
        taskId: nextTaskId,
        receipt: {
          agent_id: nextAgentId,
          task_id: nextTaskId,
          thread_id: `thread-${suffix}`,
          turn_id: `turn-${suffix}`,
          status: "completed",
          report_path: nextReportPath,
          actual_model: "gpt-5.6-terra",
        },
        review: nextReview,
        now: acceptedAt,
      },
    };
  });
  writeJson(root, ".orquesta/state/tasks.json", {
    version: 1,
    tasks: [acceptedTask, ...batchItems.map((item) => item.task)],
  });
  writeJson(root, ".orquesta/state/agents.json", {
    version: 1,
    agents: [{
      agent_id: agentId,
      operational_status: "standby",
      lifecycle_state: "active",
    }, ...batchItems.map((item) => item.agent)],
  });
  writeJson(root, ".orquesta/state/sessions.json", {
    version: 1,
    sessions: [{
      session_id: `session-${agentId}`,
      agent_id: agentId,
      thread_id: "thread-1",
      handoff_turn_id: "turn-1",
      status: "standby",
    }, ...batchItems.map((item) => item.session)],
    synced_at: acceptedAt,
  });
  writeJson(root, ".orquesta/project/completion_map.json", {
    version: 2,
    status: "in_progress",
    tasks: [
      { task_id: taskId, status: "done" },
      ...batchItems.map((item) => ({ task_id: item.task.task_id, status: "in_progress" })),
    ],
  });

  const batch = reconcileTaskAcceptanceBatchAtomic({
    rootPath: root,
    items: batchItems.map((item) => item.acceptance),
    now: acceptedAt,
  });
  assert.equal(batch.status, "accepted");
  assert.equal(batch.control_audit.status, "clear");
  assert.equal(batch.support_wake.status, "manual_recovery");
  assert.equal(batch.support_wake.preferred_transport, "manual_recovery");
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(root, ".orquesta/state/tasks.json"), "utf8"))
      .tasks.map((item) => item.state),
    ["accepted", "accepted", "accepted"],
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(root, ".orquesta/state/capacity.json"), "utf8"))
      .dispatches.length,
    3,
  );
  const omittedQuestionReport = fs.readFileSync(
    path.join(root, ".orquesta", "reports", "TASK-2-implementation-002.md"),
    "utf8",
  );
  assert.match(omittedQuestionReport, /"question_candidates_status": "omitted"/);
  assert.doesNotMatch(omittedQuestionReport, /## Question Candidates/);

  const currentOrchestraPath = path.join(root, ".orquesta/CURRENT_ORCHESTRA.md");
  const currentOrchestraText = fs.readFileSync(currentOrchestraPath, "utf8");
  fs.rmSync(currentOrchestraPath, { force: true });
  fs.mkdirSync(currentOrchestraPath);
  let postAcceptanceFailure;
  try {
    postAcceptanceFailure = finalizeAcceptanceAudit(root, acceptedAt);
  } finally {
    fs.rmSync(currentOrchestraPath, { recursive: true, force: true });
    writeText(root, ".orquesta/CURRENT_ORCHESTRA.md", currentOrchestraText);
  }
  assert.equal(postAcceptanceFailure.control_audit.status, "blockers");
  assert.ok(postAcceptanceFailure.post_acceptance_errors.some((item) => (
    item.code === "post_acceptance_current_orchestra_unavailable"
  )));
  assert.ok(postAcceptanceFailure.delegation_gate.errors.some((item) => (
    item.includes("post_acceptance_current_orchestra_unavailable")
  )));
});

test("normalizes report-only specialist results without commands only when a reason exists", () => {
  const task = {
    task_id: "REPORT-ONLY",
    owner_agent_id: "docs-001",
    task_intent: { risk: { impact: "low" } },
    routing_class: "specialist_required",
    handoff_sent_at: "2026-08-05T00:00:00.000Z",
    specialist_report_path: ".orquesta/reports/report-only.md",
    handoff_attempts: [{ transport: "manual_recovery" }],
  };
  const receipt = {
    agent_id: "docs-001",
    task_id: task.task_id,
    thread_id: "thread-docs",
    turn_id: "turn-docs",
    status: "completed",
    report_path: task.specialist_report_path,
  };
  const makeResult = (noCommandsReason) => extractSpecialistResult(reportText({
    taskId: task.task_id,
    agentId: task.owner_agent_id,
    reportPath: task.specialist_report_path,
    createdAt: "2026-08-05T00:01:00.000Z",
    changes: [{ path: task.specialist_report_path, kind: "report_only", summary: "Recorded the analysis." }],
    verification: [],
    noCommandsReason,
  }));
  const envelope = canonicalEnvelopeFromSpecialistResult({
    result: makeResult("The deliverable is analysis only and has no executable check."),
    task,
    receipt,
    evidence: null,
    createdAt: "2026-08-05T00:01:00.000Z",
  });
  assert.deepEqual(envelope.verification.commands, []);
  assert.match(envelope.verification.no_commands_reason, /analysis only/);
  assert.throws(() => canonicalEnvelopeFromSpecialistResult({
    result: makeResult(null),
    task,
    receipt,
    evidence: null,
    createdAt: "2026-08-05T00:01:00.000Z",
  }), /no_commands_reason/);
});

test("acceptance claim identity binds the full normalized receipt", () => {
  const claim = {
    thread_id: "thread-1",
    turn_id: "turn-1",
    receipt_sha256: "a".repeat(64),
    report_sha256: "b".repeat(64),
    review_sha256: "c".repeat(64),
    task_snapshot_sha256: "d".repeat(64),
  };
  assert.equal(sameAcceptanceClaim(claim, { ...claim }), true);
  assert.equal(sameAcceptanceClaim(claim, { ...claim, receipt_sha256: "e".repeat(64) }), false);
});

test("project path boundaries reject parent traversal without rejecting a legal dot-prefixed name", () => {
  const root = path.join(os.tmpdir(), "orquesta-path-boundary");
  assert.equal(
    safeRelativePath(root, "..safe-artifact.json", "fixture").resolved,
    path.resolve(root, "..safe-artifact.json"),
  );
  assert.throws(
    () => safeRelativePath(root, "../outside.json", "fixture"),
    (error) => error.code === "TASK_ACCEPTANCE_PATH_ESCAPE",
  );
});
