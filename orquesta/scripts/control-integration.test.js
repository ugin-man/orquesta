#!/usr/bin/env node

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { ensureBetaV3ReleaseState } = require("./beta-v3-state-init");
const { writeJsonAtomic, readJsonFile } = require("./json-state");
const { inspectCompletionEnvelope } = require("./completion-envelope-check");
const {
  applyCapacityEvent,
  createEmptyCapacityLedger,
  expireCapacity,
  selectEligibleFallbacks
} = require("./capacity-gate");
const {
  appendSubmittedQuestionCandidates
} = require("./report-question-candidates-check");
const {
  appendIncidentCandidate,
  clusterIncidentCandidates,
  createIncidentCandidate
} = require("./incident-intake");
const { recordModelRoute } = require("./model-policy");
const { buildAudit } = require("./foundation-trigger-audit");
const { reviewTaskControl, runControlAudit } = require("./control-audit");

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-control-integration-"));
}

function statePath(root, fileName) {
  return path.join(root, ".orquesta", "state", fileName);
}

function writeState(root, relativePath, value) {
  return writeJsonAtomic(path.join(root, relativePath), value);
}

function task(overrides = {}) {
  return {
    task_id: "T900",
    title: "Temp integration task",
    state: "needs_review",
    owner_agent_id: "implementation-001",
    routing_class: "specialist_required",
    routing_gate_status: "handoff_sent",
    handoff_required: true,
    handoff_sent_at: "2026-07-10T06:00:00.000Z",
    specialist_report_required: true,
    specialist_report_path: ".orquesta/reports/T900.md",
    control_rollout: "beta_v3",
    control_signals: { risk_level: "high" },
    model_route: {
      recommended_model: "Terra",
      requested_model: "gpt-5.6-terra",
      applied_model: null,
      actual_model: null,
      adapter: "repository_only"
    },
    ...overrides
  };
}

function envelope(subject, overrides = {}) {
  return {
    version: 1,
    task_id: subject.task_id,
    agent_id: subject.owner_agent_id,
    status: "submitted",
    risk_level: "high",
    required_reading: { status: "done", files: ["docs/spec.md"], not_read: [] },
    delegation_evidence: {
      routing_class: subject.routing_class,
      handoff_sent_at: subject.handoff_sent_at,
      specialist_report_path: subject.specialist_report_path,
      direct_exception_reason: null,
      bypass_review_owner: null
    },
    model_route: {
      recommended_model: "Terra",
      requested_model: "gpt-5.6-terra",
      requested_model_evidence: "Accepted dispatch requests Terra.",
      actual_model: null,
      actual_model_evidence: null,
      confidence: "high",
      reason: "Fixture implementation route.",
      adapter: "repository_only"
    },
    changes: [{ path: "orquesta/scripts/example.js", kind: "modified", summary: "Fixture change." }],
    verification: {
      commands: [{ command: "node fixture", status: "passed", expected: "fixture passes", evidence: "exit 0" }],
      browser: { status: "not_required", evidence: "This is a deterministic temp fixture." },
      live_thread: { status: "not_required", evidence: "Fixture does not claim a live turn." }
    },
    not_verified: [],
    fallbacks: [],
    open_risks: [],
    question_candidates_status: "none",
    created_at: "2026-07-10T06:20:00.000Z",
    ...overrides
  };
}

function writeReport(root, subject, reportEnvelope) {
  const reportPath = path.join(root, subject.specialist_report_path);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `# ${subject.task_id}\n\n\`\`\`json\n${JSON.stringify({
    question_candidates: {
      status: "none",
      none_reason: "no_new_user_choice",
      none_rationale: "The fixture does not introduce a new user choice."
    }
  }, null, 2)}\n\`\`\`\n\n\`\`\`json\n${JSON.stringify({ completion_envelope: reportEnvelope }, null, 2)}\n\`\`\`\n`, "utf8");
  return reportPath;
}

function capacityEvent(type, overrides = {}) {
  return {
    type,
    task_id: "T900",
    agent_id: "implementation-001",
    thread_id: "thread-implementation-001",
    dispatch_id: "DSP-T900-001",
    observed_at: "2026-07-10T06:01:00.000Z",
    scope: {
      scope_type: "thread",
      scope_key: "thread:thread-implementation-001",
      scope_confidence: "high",
      agent_id: "implementation-001",
      thread_id: "thread-implementation-001"
    },
    ...overrides
  };
}

function foundationState(root) {
  writeState(root, ".orquesta/state/agents.json", {
    version: 1,
    agents: [
      { agent_id: "vision-curator", role: "vision-curator", status: "standby" },
      { agent_id: "error-concierge", role: "error-concierge", status: "standby" },
      { agent_id: "user-liaison", role: "user-liaison", status: "standby" },
      { agent_id: "orquesta-admin", role: "orquesta-admin", status: "standby" }
    ]
  });
  writeState(root, ".orquesta/state/sessions.json", { version: 1, sessions: [] });
  writeState(root, ".orquesta/vision/questions.json", { version: 1, questions: [] });
  writeState(root, ".orquesta/vision/answers.json", { version: 1, answer_batches: [] });
  writeState(root, ".orquesta/failures/incidents.json", { version: 1, incidents: [{ incident_id: "F-MITIGATED", status: "mitigated", failure_class: "fixture" }] });
  writeState(root, ".orquesta/failures/user_actions.json", { version: 1, actions: [] });
  writeState(root, ".orquesta/user_tasks/queue.json", { version: 1, tasks: [] });
  writeState(root, ".orquesta/setup/options.json", { version: 1, setup_status: "ready", bootstrap_status: "ready" });
}

test("temp integration fixture keeps completion, capacity, intake, model, and audit evidence separate", () => {
  const root = makeRoot();
  try {
    ensureBetaV3ReleaseState(root);
    foundationState(root);
    const subject = task();
    const reportEnvelope = envelope(subject);
    const reportPath = writeReport(root, subject, reportEnvelope);
    writeState(root, ".orquesta/state/tasks.json", { version: 1, tasks: [subject] });

    const completion = inspectCompletionEnvelope(reportPath, subject, { stagedIn: true, rolloutMode: "hard" });
    assert.strictEqual(completion.status, "valid");

    let ledger = createEmptyCapacityLedger();
    ledger = applyCapacityEvent(ledger, capacityEvent("dispatch_queued"));
    ledger = applyCapacityEvent(ledger, capacityEvent("dispatch_accepted", { observed_at: "2026-07-10T06:02:00.000Z" }));
    assert.strictEqual(ledger.dispatches[0].turn_started_at, null);
    assert.strictEqual(ledger.dispatches[0].state, "dispatch_accepted");
    ledger = applyCapacityEvent(ledger, capacityEvent("turn_started", { observed_at: "2026-07-10T06:03:00.000Z" }));
    ledger = applyCapacityEvent(ledger, capacityEvent("report_produced", { observed_at: "2026-07-10T06:04:00.000Z", report_path: subject.specialist_report_path }));

    ledger = applyCapacityEvent(ledger, capacityEvent("dispatch_queued", {
      task_id: "T901",
      agent_id: "failure-agent",
      thread_id: "thread-failure-agent",
      dispatch_id: "DSP-T901-001",
      observed_at: "2026-07-10T06:05:00.000Z",
      scope: { scope_type: "thread", scope_key: "thread:failure-agent", scope_confidence: "high", agent_id: "failure-agent", thread_id: "thread-failure-agent" }
    }));
    ledger = applyCapacityEvent(ledger, capacityEvent("prestart_system_error", {
      task_id: "T901", agent_id: "failure-agent", thread_id: "thread-failure-agent", dispatch_id: "DSP-T901-001", error_fingerprint: "fixture-prestart", observed_at: "2026-07-10T06:05:01.000Z",
      scope: { scope_type: "thread", scope_key: "thread:failure-agent", scope_confidence: "high", agent_id: "failure-agent", thread_id: "thread-failure-agent" }
    }));
    ledger = applyCapacityEvent(ledger, capacityEvent("dispatch_queued", {
      task_id: "T901", agent_id: "failure-agent", thread_id: "thread-failure-agent", dispatch_id: "DSP-T901-002", observed_at: "2026-07-10T06:06:00.000Z",
      scope: { scope_type: "thread", scope_key: "thread:failure-agent", scope_confidence: "high", agent_id: "failure-agent", thread_id: "thread-failure-agent" }
    }));
    ledger = applyCapacityEvent(ledger, capacityEvent("prestart_system_error", {
      task_id: "T901", agent_id: "failure-agent", thread_id: "thread-failure-agent", dispatch_id: "DSP-T901-002", error_fingerprint: "fixture-prestart", observed_at: "2026-07-10T06:06:01.000Z",
      scope: { scope_type: "thread", scope_key: "thread:failure-agent", scope_confidence: "high", agent_id: "failure-agent", thread_id: "thread-failure-agent" }
    }));
    const failedRecord = ledger.capacity_records.find((record) => record.scope.agent_id === "failure-agent");
    assert.strictEqual(failedRecord.circuit.state, "open");

    ledger = applyCapacityEvent(ledger, capacityEvent("usage_limit_confirmed", {
      task_id: "T902", agent_id: "cooldown-agent", thread_id: "thread-cooldown-agent", dispatch_id: "DSP-T902-001", source: "product", reset_at: "2026-07-10T06:10:00.000Z", observed_at: "2026-07-10T06:07:00.000Z",
      scope: { scope_type: "thread", scope_key: "thread:cooldown-agent", scope_confidence: "high", agent_id: "cooldown-agent", thread_id: "thread-cooldown-agent" }
    }));
    ledger = expireCapacity(ledger, "2026-07-10T06:11:00.000Z");
    const cooldownRecord = ledger.capacity_records.find((record) => record.scope.agent_id === "cooldown-agent");
    assert.strictEqual(cooldownRecord.state, "probing");
    assert.strictEqual(cooldownRecord.circuit.state, "half_open");

    const fallback = selectEligibleFallbacks([
      { agent_id: "implementation-002", scope_key: "thread:two", role_compatibility: "exact", independence: "independent", actual_model: "gpt-5.6-sol", actual_model_evidence: "fixture", evidence_downgrade: [] },
      { agent_id: "implementation-003", scope_key: "thread:three", role_compatibility: "approved_adjacent", independence: "independent", actual_model: "gpt-5.6-sol", actual_model_evidence: "fixture", evidence_downgrade: [] },
      { agent_id: "orchestrator", scope_key: "thread:orchestrator", role_compatibility: "incompatible", independence: "same_implementer", actual_model: "gpt-5.6-sol", actual_model_evidence: "fixture", evidence_downgrade: [] }
    ], { task: subject, ledger, limit: 2, now: "2026-07-10T06:11:00.000Z" });
    assert.strictEqual(fallback.eligible.length, 2);
    assert.ok(fallback.rejected.some((candidate) => candidate.agent_id === "orchestrator"));

    const observationMetadata = {
      status: "submitted",
      items: [{
        priority: "low", category: "workflow", question: "Keep this as a fixture observation?", why_now: "The integration fixture needs dedupe coverage.", user_impact: "It must not become a user question.", suggested_timing: "batch_later",
        source_task_id: "T900", source_agent_id: "implementation-001", source_report_path: subject.specialist_report_path,
        observation: { value_type: "maintenance_note", user_emergence_value: "low", decision_cluster_id: null, suggested_action: "keep_as_note", reason: "Internal deterministic fixture note." }
      }]
    };
    const firstQuestionWrite = appendSubmittedQuestionCandidates(root, observationMetadata, "2026-07-10T06:12:00.000Z");
    const secondQuestionWrite = appendSubmittedQuestionCandidates(root, observationMetadata, "2026-07-10T06:13:00.000Z");
    const questionInbox = readJsonFile(path.join(root, ".orquesta/vision/question_candidates.json"), { candidates: [] });
    assert.strictEqual(firstQuestionWrite.recorded, 1);
    assert.strictEqual(secondQuestionWrite.skipped, 1);
    assert.strictEqual(questionInbox.candidates[0].status, "observation");
    assert.strictEqual(readJsonFile(path.join(root, ".orquesta/vision/questions.json"), { questions: [] }).questions.length, 0);

    const incidentA = createIncidentCandidate({ task_id: "T910", source_agent_id: "implementation-001", source_event_id: "event-a", command_or_action: "node fixture --port 4177", failure_class: "environment.fixture", summary: "Fixture server failed at 127.0.0.1:4177", evidence: ["thread id: test-a"], occurred_at: "2026-07-10T06:14:00.000Z" });
    const incidentB = createIncidentCandidate({ task_id: "T911", source_agent_id: "implementation-001", source_event_id: "event-b", command_or_action: "node fixture --port 4199", failure_class: "environment.fixture", summary: "Fixture server failed at 127.0.0.1:4199", evidence: ["thread id: test-b"], occurred_at: "2026-07-10T06:15:00.000Z" });
    assert.strictEqual(incidentA.global_fingerprint, incidentB.global_fingerprint);
    appendIncidentCandidate(root, incidentA);
    appendIncidentCandidate(root, incidentB);
    const clustered = clusterIncidentCandidates(root, { now: "2026-07-10T06:16:00.000Z" });
    assert.strictEqual(clustered.clusters.length, 1);
    const activeFailureAudit = buildAudit(root, new Date("2026-07-10T06:16:00.000Z"));
    assert.ok(activeFailureAudit.foundation_agents.find((agent) => agent.agent_id === "error-concierge").reasons.some((reason) => /Open incident clusters/.test(reason)));
    writeState(root, ".orquesta/failures/incident_clusters.json", { version: 1, clusters: [{ ...clustered.clusters[0], status: "resolved" }] });
    writeState(root, ".orquesta/failures/incident_candidates.json", { version: 1, candidates: readJsonFile(path.join(root, ".orquesta/failures/incident_candidates.json"), { candidates: [] }).candidates.map((candidate) => ({ ...candidate, status: "retired" })) });
    const resolvedFailureAudit = buildAudit(root, new Date("2026-07-10T06:17:00.000Z"));
    assert.ok(!resolvedFailureAudit.foundation_agents.find((agent) => agent.agent_id === "error-concierge").reasons.some((reason) => /Open incident clusters/.test(reason)));

    const mismatchedRoute = recordModelRoute({ version: 1, tasks: [subject] }, subject.task_id, {
      recommended_model: "Terra",
      requested_model: "gpt-5.6-terra",
      requested_model_evidence: "fixture requested Terra",
      applied_model: "gpt-5.6-terra",
      actual_model: "gpt-5.6-sol",
      actual_model_evidence: "fixture runtime proof",
      adapter: "repository_only"
    });
    assert.strictEqual(mismatchedRoute.tasks[0].model_route.requested_model, "gpt-5.6-terra");
    assert.strictEqual(mismatchedRoute.tasks[0].model_route.applied_model, "gpt-5.6-terra");
    assert.strictEqual(mismatchedRoute.tasks[0].model_route.actual_model, "gpt-5.6-sol");

    writeState(root, ".orquesta/state/tasks.json", { version: 1, tasks: [subject] });
    writeState(root, ".orquesta/state/capacity.json", ledger);
    const stagedReview = reviewTaskControl({ root, task: subject, reportPath: subject.specialist_report_path, now: "2026-07-10T06:17:00.000Z", rolloutMode: "hard" });
    assert.strictEqual(stagedReview.completion.status, "valid");
    assert.ok(!stagedReview.blockers.some((finding) => finding.code === "missing_completion_envelope"));
    const control = runControlAudit({ root, now: "2026-07-10T06:17:00.000Z", rolloutMode: "hard" });
    assert.ok(fs.existsSync(statePath(root, "control_audit.json")));
    assert.ok(control.audit.findings.every((finding) => finding.task_id !== subject.task_id || finding.severity !== "blocker"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const { name, fn } of tests) {
  fn();
  console.log(`ok - ${name}`);
}

console.log("control integration tests passed");
