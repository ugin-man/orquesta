#!/usr/bin/env node

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createRequire } = require("module");

const {
  buildControlAudit,
  runControlAudit
} = require("./control-audit");
const { createEmptyCapacityLedger } = require("./capacity-gate");
const { writeJsonAtomic } = require("./json-state");

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function makeRoot(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `orquesta-control-audit-${name}-`));
}

function makeTask(taskId, overrides = {}) {
  return {
    task_id: taskId,
    title: `Task ${taskId}`,
    state: "accepted",
    owner_agent_id: "implementation-001",
    routing_class: "specialist_required",
    routing_gate_status: "handoff_sent",
    handoff_required: true,
    handoff_sent_at: "2026-07-10T06:00:00.000Z",
    specialist_report_required: true,
    specialist_report_path: `.orquesta/reports/${taskId}.md`,
    direct_exception_reason: null,
    bypass_review_owner: null,
    control_signals: { risk_level: "high" },
    model_route: {
      recommended_model: "Sol",
      requested_model: "gpt-5.6-sol",
      actual_model: null
    },
    ...overrides
  };
}

function completionEnvelope(task, overrides = {}) {
  const base = {
    version: 1,
    task_id: task.task_id,
    agent_id: task.owner_agent_id,
    status: "submitted",
    risk_level: task.control_signals?.risk_level || "low",
    required_reading: {
      status: "done",
      files: ["docs/spec.md"],
      not_read: []
    },
    delegation_evidence: {
      routing_class: task.routing_class,
      handoff_sent_at: task.handoff_sent_at,
      specialist_report_path: task.specialist_report_path,
      direct_exception_reason: task.direct_exception_reason || null,
      bypass_review_owner: task.bypass_review_owner || null
    },
    model_route: {
      recommended_model: "Sol",
      requested_model: task.model_route?.requested_model || null,
      requested_model_evidence: task.model_route?.requested_model ? "Task state requested this route." : null,
      actual_model: null,
      actual_model_evidence: null,
      confidence: "medium",
      reason: "Fixture route.",
      adapter: "codex_product"
    },
    changes: [
      { path: "orquesta/scripts/example.js", kind: "modified", summary: "Fixture change." }
    ],
    verification: {
      commands: [
        { command: "npm run check", status: "passed", expected: "pass", evidence: "exit 0" }
      ],
      browser: { status: "not_required", evidence: null },
      live_thread: { status: "not_required", evidence: null }
    },
    not_verified: [],
    fallbacks: [],
    open_risks: [],
    question_candidates_status: "none",
    created_at: "2026-07-10T06:10:00.000Z"
  };
  return {
    ...base,
    ...overrides,
    model_route: { ...base.model_route, ...(overrides.model_route || {}) },
    delegation_evidence: { ...base.delegation_evidence, ...(overrides.delegation_evidence || {}) },
    verification: { ...base.verification, ...(overrides.verification || {}) }
  };
}

function writeReport(root, task, envelope = completionEnvelope(task)) {
  const reportPath = path.join(root, task.specialist_report_path);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  const body = envelope
    ? `\`\`\`json\n${JSON.stringify({ completion_envelope: envelope }, null, 2)}\n\`\`\``
    : "Legacy report without completion metadata.";
  fs.writeFileSync(reportPath, `# ${task.task_id}\n\n${body}\n`, "utf8");
  return reportPath;
}

function writeReviewReport(root, task, envelope) {
  const reportPath = path.join(root, task.specialist_report_path);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  const completionBlock = envelope
    ? `\n\`\`\`json\n${JSON.stringify({ completion_envelope: envelope }, null, 2)}\n\`\`\``
    : "";
  fs.writeFileSync(reportPath, `# ${task.task_id}\n\n\`\`\`json\n${JSON.stringify({
    question_candidates: {
      status: "none",
      none_reason: "no_new_user_choice",
      none_rationale: "The fixture introduces no new user choice."
    }
  }, null, 2)}\n\`\`\`${completionBlock}\n`, "utf8");
  return reportPath;
}

function loadDashboardServerForRoot(root) {
  const serverPath = path.resolve(__dirname, "..", "dashboard-server.js");
  let source = fs.readFileSync(serverPath, "utf8");
  source = source.replace(
    'const root = path.resolve(__dirname, "..");',
    `const root = ${JSON.stringify(root)};`
  );
  const localRequire = createRequire(serverPath);
  const loaded = { exports: {} };
  new Function("require", "module", "exports", "__dirname", "__filename", source)(
    localRequire,
    loaded,
    loaded.exports,
    path.dirname(serverPath),
    serverPath
  );
  return loaded.exports;
}

function writeReviewFixture(root, task, envelope) {
  fs.mkdirSync(path.join(root, ".orquesta/state"), { recursive: true });
  writeReviewReport(root, task, envelope);
  writeJsonAtomic(path.join(root, ".orquesta/state/tasks.json"), {
    version: 1,
    tasks: [{ ...task, review_history: [], artifacts: [task.specialist_report_path] }]
  });
  writeJsonAtomic(path.join(root, ".orquesta/state/agents.json"), {
    version: 1,
    agents: [{
      agent_id: task.owner_agent_id,
      status: "active",
      current_task: task.task_id,
      artifacts: []
    }]
  });
  writeJsonAtomic(path.join(root, ".orquesta/state/capacity.json"), createEmptyCapacityLedger({
    dispatches: [{
      dispatch_id: `DSP-${task.task_id}-001`,
      task_id: task.task_id,
      agent_id: task.owner_agent_id,
      thread_id: `thread-${task.owner_agent_id}`,
      state: "dispatch_accepted",
      queued_at: "2026-07-10T06:00:00.000Z",
      dispatch_accepted_at: "2026-07-10T06:00:01.000Z",
      turn_started_at: null,
      progress_observed_at: null,
      report_produced_at: null,
      report_path: null
    }]
  }));
}

function readEvents(root) {
  const filePath = path.join(root, ".orquesta/state/events.jsonl");
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

function findingCodes(audit, severity = null) {
  return audit.findings
    .filter((finding) => !severity || finding.severity === severity)
    .map((finding) => finding.code);
}

function emptyInputs(overrides = {}) {
  return {
    tasks: { version: 1, tasks: [] },
    sessions: { version: 1, sessions: [] },
    triggerAudit: { version: 1, agents: [] },
    capacity: createEmptyCapacityLedger(),
    questionCandidates: { version: 1, candidates: [] },
    incidents: { version: 1, incidents: [] },
    incidentCandidates: { version: 1, candidates: [] },
    incidentClusters: { version: 1, clusters: [] },
    ...overrides
  };
}

test("staged-in acceptance reports missing delegation, report, and envelope blockers", () => {
  const root = makeRoot("missing");
  try {
    const task = makeTask("T300", {
      handoff_sent_at: null,
      specialist_report_path: null
    });
    const audit = buildControlAudit(emptyInputs({
      tasks: { version: 1, tasks: [task] }
    }), { root, now: "2026-07-10T06:30:00.000Z" });
    const codes = findingCodes(audit, "blocker");
    assert.ok(codes.includes("missing_specialist_handoff"));
    assert.ok(codes.includes("missing_specialist_report"));
    assert.ok(codes.includes("missing_completion_envelope"));
    assert.ok(codes.includes("missing_capacity_dispatch"));
    assert.strictEqual(audit.status, "blockers");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("stale live session, pending observations, incidents, and legacy rollout are visible", () => {
  const root = makeRoot("rollout");
  try {
    const active = makeTask("T301", {
      state: "in_progress",
      specialist_report_path: null
    });
    const legacy = makeTask("T100", {
      state: "accepted",
      control_signals: undefined,
      completion_envelope: undefined,
      created_at: "2026-06-01T00:00:00.000Z"
    });
    writeReport(root, legacy, null);
    const capacity = createEmptyCapacityLedger({
      dispatches: [{
        dispatch_id: "DSP-T301-001",
        task_id: "T301",
        agent_id: "implementation-001",
        thread_id: "thread-1",
        state: "turn_started",
        queued_at: "2026-07-10T06:00:00.000Z",
        dispatch_accepted_at: "2026-07-10T06:00:01.000Z",
        turn_started_at: "2026-07-10T06:00:02.000Z",
        report_produced_at: null
      }]
    });
    const audit = buildControlAudit(emptyInputs({
      tasks: { version: 1, tasks: [active, legacy] },
      sessions: {
        version: 1,
        sessions: [{ agent_id: "implementation-001", status: "active", updated_at: "2026-07-10T05:00:00.000Z" }]
      },
      capacity,
      questionCandidates: {
        version: 1,
        candidates: [
          { candidate_id: "QC-1", status: "pending_curator_review", observation: { kind: "scope" } },
          { candidate_id: "QC-2", status: "pending_curator_review", observation: { kind: "risk" } }
        ]
      },
      incidentCandidates: {
        version: 1,
        candidates: [{ incident_candidate_id: "IC-1", status: "pending_triage" }]
      }
    }), { root, now: "2026-07-10T06:30:00.000Z", rolloutMode: "progressive" });
    assert.ok(findingCodes(audit, "blocker").includes("stale_session_live_claim"));
    assert.ok(findingCodes(audit, "warning").includes("legacy_completion_envelope_missing"));
    assert.strictEqual(audit.summary.question_observations_pending, 2);
    assert.strictEqual(audit.summary.incident_candidates, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("progressive rollout does not reopen task accepted before Phase 2 activation", () => {
  const root = makeRoot("accepted-migration");
  try {
    const legacyAccepted = makeTask("T302", {
      state: "accepted",
      accepted_at: "2026-07-10T05:30:00.000Z"
    });
    writeReport(root, legacyAccepted);
    const audit = buildControlAudit(emptyInputs({
      tasks: { version: 1, tasks: [legacyAccepted] }
    }), {
      root,
      now: "2026-07-10T06:30:00.000Z",
      rolloutMode: "progressive",
      rolloutStartedAt: "2026-07-10T06:00:00.000Z"
    });
    assert.ok(!findingCodes(audit, "blocker").includes("missing_capacity_dispatch"));
    assert.strictEqual(audit.status, "clear");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("superseded staged task does not enter active hard gates", () => {
  const root = makeRoot("superseded");
  try {
    const task = makeTask("T303", {
      state: "superseded",
      handoff_sent_at: null,
      specialist_report_path: null
    });
    const audit = buildControlAudit(emptyInputs({
      tasks: { version: 1, tasks: [task] }
    }), { root, now: "2026-07-10T06:30:00.000Z" });
    assert.deepStrictEqual(findingCodes(audit, "blocker"), []);
    assert.strictEqual(audit.status, "clear");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("capacity inconsistencies and fallback evidence become deterministic blockers", () => {
  const root = makeRoot("capacity");
  try {
    const substitution = makeTask("T310", {
      state: "in_progress",
      execution_actor: "orchestrator",
      required_specialist_agent_id: "implementation-001",
      specialist_report_path: null
    });
    const fallbackTask = makeTask("T311");
    writeReport(root, fallbackTask, completionEnvelope(fallbackTask, {
      model_route: {
        actual_model: "gpt-5",
        actual_model_evidence: "runtime model label"
      },
      capacity_evidence: {
        source_capacity_id: "CAP-PRIMARY-001",
        capacity_id: "CAP-FALLBACK-001",
        dispatch_id: "DSP-T311-001",
        dispatch_state: "report_produced",
        role_compatibility: null,
        independence: null,
        capacity_state_at_dispatch: "unknown",
        requested_model: "gpt-5.6-sol",
        actual_model: "gpt-5",
        evidence_downgrade: [],
        acceptance_use: "positive_acceptance",
        approval_status: "requested"
      }
    }));

    const capacity = createEmptyCapacityLedger({
      orchestra: {
        mode: "normal",
        reason_codes: [],
        affected_task_ids: ["T310"],
        safe_work_task_ids: []
      },
      capacity_records: [
        {
          capacity_id: "CAP-PRIMARY-001",
          scope: { scope_type: "thread", scope_key: "thread:primary", agent_id: "implementation-001", thread_id: "primary" },
          state: "unavailable",
          cause: "unknown",
          classification: "machine_inferred",
          evidence_level: "E2",
          observed_at: "2026-07-10T06:00:00.000Z",
          expires_at: "2026-07-10T07:00:00.000Z",
          cooldown_until: "2026-07-10T06:45:00.000Z",
          consecutive_prestart_failures: 2,
          circuit: { state: "open", generation: 1, probe_count: 0, next_probe_not_before: "2026-07-10T06:45:00.000Z" }
        },
        {
          capacity_id: "CAP-AMBIGUOUS-001",
          scope: { scope_type: "thread", scope_key: "thread:ambiguous", agent_id: "agent-ambiguous" },
          state: "suspected_unavailable",
          cause: "usage_window_exhausted",
          classification: "machine_ambiguous",
          evidence_level: "E1",
          observed_at: "2026-07-10T06:00:00.000Z",
          expires_at: "2026-07-10T07:00:00.000Z",
          consecutive_prestart_failures: 1,
          circuit: { state: "half_open", generation: 0, probe_count: 0 }
        },
        {
          capacity_id: "CAP-CORRELATED-001",
          scope: { scope_type: "thread", scope_key: "thread:correlated", agent_id: "agent-correlated" },
          state: "suspected_unavailable",
          cause: "unknown",
          classification: "machine_ambiguous",
          evidence_level: "E1",
          observed_at: "2026-07-10T06:00:00.000Z",
          expires_at: "2026-07-10T07:00:00.000Z",
          consecutive_prestart_failures: 2,
          circuit: { state: "half_open", generation: 0, probe_count: 0 }
        },
        {
          capacity_id: "CAP-CONFIRMED-001",
          scope: { scope_type: "thread", scope_key: "thread:confirmed", agent_id: "agent-confirmed" },
          state: "unavailable",
          cause: "usage_window_exhausted",
          classification: "user_confirmed",
          evidence_level: "E3",
          observed_at: "2026-07-10T06:00:00.000Z",
          cooldown_until: "2026-07-10T07:00:00.000Z",
          expires_at: "2026-07-10T12:00:00.000Z",
          circuit: { state: "open", generation: 1, probe_count: 0 }
        },
        {
          capacity_id: "CAP-EXPIRED-001",
          scope: { scope_type: "thread", scope_key: "thread:expired", agent_id: "agent-expired" },
          state: "available",
          cause: "none",
          classification: "machine_confirmed",
          evidence_level: "E3",
          observed_at: "2026-07-10T05:00:00.000Z",
          expires_at: "2026-07-10T05:15:00.000Z",
          circuit: { state: "closed", generation: 1, probe_count: 0 }
        },
        {
          capacity_id: "CAP-COOLDOWN-EXPIRED-001",
          scope: { scope_type: "thread", scope_key: "thread:cooldown", agent_id: "agent-cooldown" },
          state: "cooldown",
          cause: "usage_window_exhausted",
          classification: "machine_confirmed",
          evidence_level: "E3",
          observed_at: "2026-07-10T05:00:00.000Z",
          cooldown_until: "2026-07-10T06:00:00.000Z",
          expires_at: "2026-07-10T12:00:00.000Z",
          circuit: { state: "open", generation: 1, probe_count: 0 }
        }
      ],
      dispatches: [
        {
          dispatch_id: "DSP-T310-001",
          task_id: "T310",
          agent_id: "implementation-001",
          thread_id: "primary",
          state: "prestart_system_error",
          queued_at: "2026-07-10T06:00:00.000Z",
          turn_started_at: null,
          report_produced_at: null
        },
        {
          dispatch_id: "DSP-T311-001",
          task_id: "T311",
          agent_id: "implementation-002",
          thread_id: "fallback",
          state: "report_produced",
          queued_at: "2026-07-10T06:00:00.000Z",
          turn_started_at: null,
          report_produced_at: "2026-07-10T06:10:00.000Z",
          report_path: ".orquesta/reports/T311.md"
        }
      ]
    });

    const audit = buildControlAudit(emptyInputs({
      tasks: { version: 1, tasks: [substitution, fallbackTask] },
      capacity
    }), { root, now: "2026-07-10T06:30:00.000Z" });
    const codes = findingCodes(audit, "blocker");
    for (const code of [
      "orchestrator_substitution_after_capacity_loss",
      "required_capacity_unavailable_mode_normal",
      "ambiguous_error_misclassified_as_usage_exhaustion",
      "correlated_failures_without_open_circuit",
      "confirmed_usage_not_in_cooldown",
      "stale_available_capacity",
      "cooldown_expired_not_probing",
      "fallback_capacity_evidence_incomplete",
      "fallback_evidence_downgrade_unapproved",
      "actual_model_mismatch_hidden"
    ]) {
      assert.ok(codes.includes(code), `missing control audit code ${code}`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("unknown actual model is explicit downgrade rather than invented evidence", () => {
  const root = makeRoot("model-unknown-fallback");
  try {
    const task = makeTask("T312");
    writeReport(root, task, completionEnvelope(task, {
      capacity_evidence: {
        source_capacity_id: "CAP-PRIMARY-001",
        capacity_id: "CAP-FALLBACK-001",
        dispatch_id: "DSP-T312-001",
        dispatch_state: "report_produced",
        capacity_state_at_dispatch: "unknown",
        role_compatibility: "approved_adjacent",
        independence: "independent_from_implementation",
        requested_model: "gpt-5.6-sol",
        actual_model: null,
        evidence_downgrade: ["model_unknown"],
        acceptance_use: "fail_evidence_only",
        approval_status: "not_required"
      }
    }));
    const capacity = createEmptyCapacityLedger({
      dispatches: [{
        dispatch_id: "DSP-T312-001",
        task_id: "T312",
        agent_id: "protocol-architect-001",
        state: "report_produced",
        queued_at: "2026-07-10T06:00:00.000Z",
        turn_started_at: null,
        report_produced_at: "2026-07-10T06:10:00.000Z",
        report_path: task.specialist_report_path
      }]
    });
    const audit = buildControlAudit(emptyInputs({
      tasks: { version: 1, tasks: [task] },
      capacity
    }), { root, now: "2026-07-10T06:30:00.000Z" });
    const codes = findingCodes(audit, "blocker");
    assert.ok(!codes.includes("fallback_capacity_evidence_incomplete"));
    assert.ok(!codes.includes("fallback_evidence_downgrade_unapproved"));
    assert.ok(!codes.includes("actual_model_mismatch_hidden"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("dispatch acceptance without turn or report evidence is not a running specialist", () => {
  const root = makeRoot("dispatch");
  try {
    const task = makeTask("T320", { state: "in_progress", specialist_report_path: null });
    const capacity = createEmptyCapacityLedger({
      dispatches: [{
        dispatch_id: "DSP-T320-001",
        task_id: "T320",
        agent_id: "implementation-001",
        thread_id: "thread-320",
        state: "dispatch_accepted",
        queued_at: "2026-07-10T06:00:00.000Z",
        dispatch_accepted_at: "2026-07-10T06:00:01.000Z",
        turn_started_at: null,
        report_produced_at: null
      }]
    });
    const audit = buildControlAudit(emptyInputs({
      tasks: { version: 1, tasks: [task] },
      capacity
    }), { root, now: "2026-07-10T06:30:00.000Z" });
    assert.ok(findingCodes(audit, "blocker").includes("dispatch_without_turn_start"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("late report evidence ends stale live-session blocking without inventing a start", () => {
  const root = makeRoot("late-report-session");
  try {
    const task = makeTask("T321", { state: "in_progress" });
    writeReport(root, task);
    const reportPath = task.specialist_report_path;
    task.specialist_report_path = null;
    task.artifacts = [reportPath];
    const capacity = createEmptyCapacityLedger({
      dispatches: [{
        dispatch_id: "DSP-T321-001",
        task_id: "T321",
        agent_id: "implementation-001",
        thread_id: "thread-321",
        state: "dispatch_accepted",
        queued_at: "2026-07-10T06:00:00.000Z",
        dispatch_accepted_at: "2026-07-10T06:00:01.000Z",
        turn_started_at: null,
        report_produced_at: null
      }]
    });
    const audit = buildControlAudit(emptyInputs({
      tasks: { version: 1, tasks: [task] },
      sessions: {
        version: 1,
        sessions: [{ agent_id: "implementation-001", status: "active", updated_at: "2026-07-10T05:00:00.000Z" }]
      },
      capacity
    }), { root, now: "2026-07-10T06:30:00.000Z" });
    const codes = findingCodes(audit, "blocker");
    assert.ok(!codes.includes("stale_session_live_claim"));
    assert.ok(!codes.includes("dispatch_without_turn_start"));
    assert.strictEqual(capacity.dispatches[0].turn_started_at, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runControlAudit writes control_audit.json through the atomic helper", () => {
  const root = makeRoot("write");
  try {
    for (const directory of [".orquesta/state", ".orquesta/vision", ".orquesta/failures"]) {
      fs.mkdirSync(path.join(root, directory), { recursive: true });
    }
    writeJsonAtomic(path.join(root, ".orquesta/state/tasks.json"), { version: 1, tasks: [] });
    writeJsonAtomic(path.join(root, ".orquesta/state/sessions.json"), { version: 1, sessions: [] });
    writeJsonAtomic(path.join(root, ".orquesta/state/trigger_audit.json"), { version: 1, agents: [] });
    writeJsonAtomic(path.join(root, ".orquesta/state/capacity.json"), createEmptyCapacityLedger());
    writeJsonAtomic(path.join(root, ".orquesta/vision/question_candidates.json"), { version: 1, candidates: [] });
    writeJsonAtomic(path.join(root, ".orquesta/failures/incidents.json"), { version: 1, incidents: [] });
    writeJsonAtomic(path.join(root, ".orquesta/failures/incident_candidates.json"), { version: 1, candidates: [] });
    writeJsonAtomic(path.join(root, ".orquesta/failures/incident_clusters.json"), { version: 1, clusters: [] });

    const result = runControlAudit({ root, now: "2026-07-10T06:30:00.000Z" });
    const outputPath = path.join(root, ".orquesta/state/control_audit.json");
    assert.strictEqual(result.write.lock.released, true);
    assert.strictEqual(fs.existsSync(outputPath), true);
    assert.strictEqual(JSON.parse(fs.readFileSync(outputPath, "utf8")).status, "clear");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runControlAudit surfaces stale output lock blockers", () => {
  const root = makeRoot("stale-lock");
  try {
    fs.mkdirSync(path.join(root, ".orquesta/state"), { recursive: true });
    writeJsonAtomic(path.join(root, ".orquesta/state/tasks.json"), { version: 1, tasks: [] });
    const outputPath = path.join(root, ".orquesta/state/control_audit.json");
    fs.writeFileSync(`${outputPath}.lock`, `${JSON.stringify({
      version: 1,
      pid: 2147483647,
      owner_token: "stale-control-audit-owner",
      target_path: outputPath,
      acquired_at: "2000-01-01T00:00:00.000Z"
    })}\n`, "utf8");
    assert.throws(
      () => runControlAudit({
        root,
        now: "2026-07-10T06:30:00.000Z",
        writeOptions: { staleLockMs: 10, lockTimeoutMs: 50, lockRetryDelayMs: 5 }
      }),
      (error) => error.code === "JSON_STATE_STALE_LOCK" && error.blocker === true
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runControlAudit uses the shared Windows-safe single-file cleanup path", () => {
  const root = makeRoot("release-unlink");
  const originalUnlinkSync = fs.unlinkSync;
  const unlinkedArtifacts = [];
  try {
    fs.mkdirSync(path.join(root, ".orquesta/state"), { recursive: true });
    writeJsonAtomic(path.join(root, ".orquesta/state/tasks.json"), { version: 1, tasks: [] });
    fs.unlinkSync = (targetPath) => {
      if (String(targetPath).includes("control_audit.json")) {
        unlinkedArtifacts.push(String(targetPath));
      }
      return originalUnlinkSync(targetPath);
    };
    const result = runControlAudit({ root, now: "2026-07-10T06:30:00.000Z" });
    assert.strictEqual(result.write.lock.released, true);
    assert.ok(unlinkedArtifacts.some((targetPath) => targetPath.includes(".lock.release-")));
    assert.ok(unlinkedArtifacts.some((targetPath) => targetPath.endsWith(".lock.transition")));
  } finally {
    fs.unlinkSync = originalUnlinkSync;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("dashboard blocks invalid staged acceptance before mutation and records a blocked event", () => {
  const root = makeRoot("dashboard-blocked");
  try {
    const task = makeTask("T330", { state: "completed" });
    writeReviewFixture(root, task, null);
    const server = loadDashboardServerForRoot(root);
    let caught;
    try {
      server.reviewSpecialistReport({ task_id: task.task_id, decision: "accept", note: "accept" });
    } catch (error) {
      caught = error;
    }
    assert.strictEqual(caught?.statusCode, 409);
    assert.ok(caught?.controlReview?.blockers.some((blocker) => blocker.code === "missing_completion_envelope"));
    const savedTask = JSON.parse(fs.readFileSync(path.join(root, ".orquesta/state/tasks.json"), "utf8")).tasks[0];
    const savedAgent = JSON.parse(fs.readFileSync(path.join(root, ".orquesta/state/agents.json"), "utf8")).agents[0];
    assert.strictEqual(savedTask.state, "completed");
    assert.deepStrictEqual(savedTask.review_history, []);
    assert.strictEqual(savedAgent.status, "active");
    const capacity = JSON.parse(fs.readFileSync(path.join(root, ".orquesta/state/capacity.json"), "utf8"));
    assert.strictEqual(capacity.dispatches[0].state, "dispatch_accepted");
    assert.strictEqual(capacity.dispatches[0].report_produced_at, null);
    assert.ok(readEvents(root).some((event) => event.type === "control_review_blocked" && event.task_id === task.task_id));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("dashboard valid staged acceptance records pass evidence and preserves return contract", () => {
  const root = makeRoot("dashboard-passed");
  try {
    const task = makeTask("T331", { state: "completed" });
    writeReviewFixture(root, task, completionEnvelope(task));
    const server = loadDashboardServerForRoot(root);
    const result = server.reviewSpecialistReport({ task_id: task.task_id, decision: "accept", note: "accepted" });
    assert.strictEqual(result.saved, true);
    assert.strictEqual(result.task_id, task.task_id);
    assert.strictEqual(result.decision, "accept");
    assert.strictEqual(result.state, "accepted");
    assert.strictEqual(result.report, task.specialist_report_path);
    assert.strictEqual(result.question_candidates.status, "none");
    assert.strictEqual(result.task.state, "accepted");
    assert.deepStrictEqual(result.task.completion_envelope, {
      status: "accepted",
      path: task.specialist_report_path,
      validated_at: result.task.accepted_at
    });
    assert.strictEqual(result.task.control_rollout, "beta_v3");
    assert.ok(Object.prototype.hasOwnProperty.call(result, "productionStart"));
    assert.ok(Object.prototype.hasOwnProperty.call(result, "specialistPlan"));
    assert.strictEqual(result.control_review.status, "clear");
    const capacity = JSON.parse(fs.readFileSync(path.join(root, ".orquesta/state/capacity.json"), "utf8"));
    assert.strictEqual(capacity.dispatches[0].state, "report_produced");
    assert.strictEqual(capacity.dispatches[0].turn_started_at, null);
    assert.strictEqual(capacity.dispatches[0].report_path, task.specialist_report_path);
    const eventTypes = readEvents(root).map((event) => event.type);
    assert.ok(eventTypes.includes("control_review_passed"));
    assert.ok(eventTypes.includes("specialist_report_accepted"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok - ${name}`);
    console.error(error.stack || error.message || error);
  }
}

if (failed) throw new Error(`control-audit test failed: ${failed} failure(s)`);
console.log("control-audit tests passed");
