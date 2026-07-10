#!/usr/bin/env node

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { writeJsonAtomic } = require("./json-state");

const {
  applyCapacityEvent,
  createEmptyCapacityLedger,
  evaluateCapacityGate,
  evaluateOrchestraMode,
  expireCapacity,
  reconcileProducedReportsAtomic,
  selectEligibleFallbacks
} = require("./capacity-gate");

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function event(type, overrides = {}) {
  return {
    type,
    task_id: "T200",
    agent_id: "implementation-001",
    thread_id: "thread-implementation-001",
    dispatch_id: "DSP-T200-001",
    observed_at: "2026-07-10T06:00:00.000Z",
    scope: {
      scope_type: "thread",
      scope_key: "thread:thread-implementation-001",
      scope_confidence: "high",
      agent_id: "implementation-001",
      thread_id: "thread-implementation-001",
      host_id: null,
      account_id: null,
      model: null
    },
    ...overrides
  };
}

function stagedTask(overrides = {}) {
  return {
    task_id: "T200",
    state: "in_progress",
    routing_class: "specialist_required",
    owner_agent_id: "implementation-001",
    critical_path: true,
    control_signals: { risk_level: "high" },
    model_route: {
      recommended_model: "Sol",
      requested_model: "gpt-5.6-sol"
    },
    ...overrides
  };
}

function recordFor(ledger, agentId = "implementation-001") {
  return ledger.capacity_records.find((record) => record.scope?.agent_id === agentId);
}

test("dispatch accepted is not turn started", () => {
  let ledger = createEmptyCapacityLedger();
  ledger = applyCapacityEvent(ledger, event("dispatch_queued"));
  ledger = applyCapacityEvent(ledger, event("dispatch_accepted", {
    observed_at: "2026-07-10T06:00:05.000Z"
  }));
  const dispatch = ledger.dispatches[0];
  assert.strictEqual(dispatch.state, "dispatch_accepted");
  assert.strictEqual(dispatch.dispatch_accepted_at, "2026-07-10T06:00:05.000Z");
  assert.strictEqual(dispatch.turn_started_at, null);
  assert.strictEqual(recordFor(ledger).state, "probing");
  assert.notStrictEqual(recordFor(ledger).circuit.state, "closed");
});

test("one ambiguous pre-start error is not usage exhaustion", () => {
  let ledger = createEmptyCapacityLedger();
  ledger = applyCapacityEvent(ledger, event("dispatch_queued"));
  ledger = applyCapacityEvent(ledger, event("prestart_system_error", {
    error_fingerprint: "system-error:immediate"
  }));
  const record = recordFor(ledger);
  assert.strictEqual(record.state, "suspected_unavailable");
  assert.strictEqual(record.cause, "unknown");
  assert.strictEqual(record.classification, "machine_ambiguous");
  assert.strictEqual(record.consecutive_prestart_failures, 1);
});

test("two correlated pre-start failures open an unknown-cause circuit", () => {
  let ledger = createEmptyCapacityLedger();
  ledger = applyCapacityEvent(ledger, event("dispatch_queued"));
  ledger = applyCapacityEvent(ledger, event("prestart_system_error", {
    error_fingerprint: "system-error:immediate"
  }));
  ledger = applyCapacityEvent(ledger, event("dispatch_queued", {
    dispatch_id: "DSP-T200-002",
    observed_at: "2026-07-10T06:05:00.000Z"
  }));
  ledger = applyCapacityEvent(ledger, event("prestart_system_error", {
    dispatch_id: "DSP-T200-002",
    observed_at: "2026-07-10T06:05:01.000Z",
    error_fingerprint: "system-error:immediate"
  }));
  const record = recordFor(ledger);
  assert.strictEqual(record.state, "unavailable");
  assert.strictEqual(record.cause, "unknown");
  assert.strictEqual(record.evidence_level, "E2");
  assert.strictEqual(record.circuit.state, "open");
  assert.strictEqual(record.consecutive_prestart_failures, 2);
});

test("confirmed usage exhaustion enters cooldown", () => {
  let ledger = createEmptyCapacityLedger();
  ledger = applyCapacityEvent(ledger, event("usage_limit_confirmed", {
    source: "user",
    reset_at: "2026-07-10T07:00:00.000Z"
  }));
  const record = recordFor(ledger);
  assert.strictEqual(record.state, "cooldown");
  assert.strictEqual(record.cause, "usage_window_exhausted");
  assert.strictEqual(record.classification, "user_confirmed");
  assert.strictEqual(record.circuit.state, "open");
  assert.strictEqual(record.cooldown_until, "2026-07-10T07:00:00.000Z");
});

test("cooldown expiry allows one probe but does not restore availability", () => {
  let ledger = createEmptyCapacityLedger();
  ledger = applyCapacityEvent(ledger, event("usage_limit_confirmed", {
    source: "product",
    reset_at: "2026-07-10T06:30:00.000Z"
  }));
  ledger = expireCapacity(ledger, "2026-07-10T06:31:00.000Z");
  const record = recordFor(ledger);
  assert.strictEqual(record.state, "probing");
  assert.strictEqual(record.circuit.state, "half_open");
  const gate = evaluateCapacityGate({
    task: stagedTask(),
    target: { agent_id: "implementation-001", scope_key: "thread:thread-implementation-001" },
    ledger,
    now: "2026-07-10T06:31:00.000Z"
  });
  assert.strictEqual(gate.allowed, true);
  assert.strictEqual(gate.probe, true);
});

test("only correlated turn start closes the circuit", () => {
  let ledger = createEmptyCapacityLedger();
  ledger = applyCapacityEvent(ledger, event("dispatch_queued"));
  ledger = applyCapacityEvent(ledger, event("dispatch_accepted"));
  ledger = applyCapacityEvent(ledger, event("report_produced", {
    report_path: ".orquesta/reports/T200.md",
    observed_at: "2026-07-10T06:10:00.000Z"
  }));
  assert.notStrictEqual(recordFor(ledger).circuit.state, "closed");

  ledger = applyCapacityEvent(ledger, event("turn_started", {
    observed_at: "2026-07-10T06:11:00.000Z"
  }));
  assert.strictEqual(recordFor(ledger).state, "available");
  assert.strictEqual(recordFor(ledger).circuit.state, "closed");
});

test("progress without explicit turn-start evidence does not close the circuit", () => {
  let ledger = createEmptyCapacityLedger();
  ledger = applyCapacityEvent(ledger, event("dispatch_queued"));
  ledger = applyCapacityEvent(ledger, event("dispatch_accepted"));
  ledger = applyCapacityEvent(ledger, event("progress_observed", {
    observed_at: "2026-07-10T06:12:00.000Z"
  }));
  const dispatch = ledger.dispatches[0];
  assert.strictEqual(dispatch.state, "progress_observed");
  assert.strictEqual(dispatch.turn_started_at, null);
  assert.strictEqual(dispatch.progress_observed_at, "2026-07-10T06:12:00.000Z");
  assert.strictEqual(recordFor(ledger).state, "probing");
  assert.strictEqual(recordFor(ledger).circuit.state, "half_open");
});

test("late report is reconciled without inventing turn_started_at", () => {
  let ledger = createEmptyCapacityLedger();
  ledger = applyCapacityEvent(ledger, event("dispatch_queued"));
  ledger = applyCapacityEvent(ledger, event("dispatch_accepted"));
  ledger = applyCapacityEvent(ledger, event("report_produced", {
    report_path: ".orquesta/reports/T200.md",
    observed_at: "2026-07-10T06:20:00.000Z"
  }));
  const dispatch = ledger.dispatches[0];
  assert.strictEqual(dispatch.state, "report_produced");
  assert.strictEqual(dispatch.turn_started_at, null);
  assert.strictEqual(dispatch.report_produced_at, "2026-07-10T06:20:00.000Z");
});

test("produced report reconciliation is one atomic capacity update without invented starts or models", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-capacity-reconcile-"));
  const capacityPath = path.join(root, "capacity.json");
  try {
    let ledger = createEmptyCapacityLedger();
    ledger = applyCapacityEvent(ledger, event("dispatch_queued"));
    ledger = applyCapacityEvent(ledger, event("dispatch_accepted", {
      observed_at: "2026-07-10T06:00:05.000Z"
    }));
    writeJsonAtomic(capacityPath, ledger);

    const result = reconcileProducedReportsAtomic(capacityPath, [
      {
        task_id: "T200",
        agent_id: "implementation-001",
        thread_id: "thread-implementation-001",
        dispatch_id: "DSP-T200-001",
        report_path: ".orquesta/reports/T200.md",
        report_produced_at: "2026-07-10T06:20:00.000Z"
      },
      {
        task_id: "T201",
        agent_id: "bootstrap-qa-001",
        thread_id: "thread-bootstrap-qa-001",
        dispatch_id: "DSP-T201-RECONCILED",
        dispatch_accepted_at: "2026-07-10T06:05:00.000Z",
        report_path: ".orquesta/reports/T201.md",
        report_produced_at: "2026-07-10T06:25:00.000Z"
      }
    ], { now: "2026-07-10T06:30:00.000Z" });

    const saved = JSON.parse(fs.readFileSync(capacityPath, "utf8"));
    const original = saved.dispatches.find((dispatch) => dispatch.dispatch_id === "DSP-T200-001");
    const reconstructed = saved.dispatches.find((dispatch) => dispatch.dispatch_id === "DSP-T201-RECONCILED");
    assert.strictEqual(result.write.lock.released, true);
    assert.strictEqual(original.state, "report_produced");
    assert.strictEqual(original.turn_started_at, null);
    assert.strictEqual(original.report_produced_at, "2026-07-10T06:20:00.000Z");
    assert.strictEqual(reconstructed.state, "report_produced");
    assert.strictEqual(reconstructed.dispatch_accepted_at, "2026-07-10T06:05:00.000Z");
    assert.strictEqual(reconstructed.turn_started_at, null);
    assert.strictEqual(reconstructed.report_produced_at, "2026-07-10T06:25:00.000Z");
    assert.strictEqual(saved.capacity_records.find((record) => record.scope.agent_id === "bootstrap-qa-001").scope.model, null);
    assert.strictEqual(fs.existsSync(`${capacityPath}.lock`), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("orchestra degrades when safe work remains and pauses when it does not", () => {
  const blocked = stagedTask();
  const safe = stagedTask({
    task_id: "T201",
    owner_agent_id: "docs-release-001",
    critical_path: false,
    safe_to_continue: true
  });
  assert.strictEqual(evaluateOrchestraMode({
    tasks: [blocked, safe],
    blockedTaskIds: ["T200"],
    eligibleFallbackTaskIds: []
  }).mode, "degraded");
  assert.strictEqual(evaluateOrchestraMode({
    tasks: [blocked],
    blockedTaskIds: ["T200"],
    eligibleFallbackTaskIds: []
  }).mode, "paused");
});

test("open specialist circuit blocks orchestrator substitution", () => {
  let ledger = createEmptyCapacityLedger();
  ledger = applyCapacityEvent(ledger, event("usage_limit_confirmed", { source: "user" }));
  const gate = evaluateCapacityGate({
    task: stagedTask({ execution_actor: "orchestrator" }),
    target: { agent_id: "implementation-001", scope_key: "thread:thread-implementation-001" },
    ledger,
    now: "2026-07-10T06:01:00.000Z"
  });
  assert.strictEqual(gate.allowed, false);
  assert.ok(gate.blockers.some((blocker) => blocker.code === "orchestrator_substitution_after_capacity_loss"));
});

test("fallback selection is role-compatible, independent, and bounded", () => {
  let ledger = createEmptyCapacityLedger();
  ledger = applyCapacityEvent(ledger, event("turn_started", {
    agent_id: "implementation-002",
    thread_id: "thread-implementation-002",
    dispatch_id: "DSP-T201-001",
    scope: {
      scope_type: "thread",
      scope_key: "thread:thread-implementation-002",
      scope_confidence: "high",
      agent_id: "implementation-002",
      thread_id: "thread-implementation-002"
    }
  }));
  ledger = applyCapacityEvent(ledger, event("turn_started", {
    agent_id: "implementation-003",
    thread_id: "thread-implementation-003",
    dispatch_id: "DSP-T202-001",
    scope: {
      scope_type: "thread",
      scope_key: "thread:thread-implementation-003",
      scope_confidence: "high",
      agent_id: "implementation-003",
      thread_id: "thread-implementation-003"
    }
  }));
  const candidates = [
    {
      agent_id: "implementation-002",
      scope_key: "thread:thread-implementation-002",
      role_compatibility: "exact",
      independence: "independent_from_implementation",
      actual_model: "gpt-5.6-sol",
      actual_model_evidence: "runtime event",
      evidence_downgrade: []
    },
    {
      agent_id: "implementation-003",
      scope_key: "thread:thread-implementation-003",
      role_compatibility: "approved_adjacent",
      independence: "independent_from_implementation",
      actual_model: "gpt-5.6-sol",
      actual_model_evidence: "runtime event",
      evidence_downgrade: []
    },
    {
      agent_id: "implementation-004",
      scope_key: "thread:thread-implementation-004",
      role_compatibility: "exact",
      independence: "independent_from_implementation",
      actual_model: "gpt-5.6-sol",
      actual_model_evidence: "runtime event",
      evidence_downgrade: []
    },
    {
      agent_id: "orchestrator",
      scope_key: "thread:orchestrator",
      role_compatibility: "incompatible",
      independence: "same_implementer",
      actual_model: "gpt-5.6-sol",
      actual_model_evidence: "runtime event",
      evidence_downgrade: []
    }
  ];
  const result = selectEligibleFallbacks(candidates, {
    task: stagedTask(),
    ledger,
    limit: 2,
    now: "2026-07-10T06:05:00.000Z"
  });
  assert.deepStrictEqual(result.eligible.map((candidate) => candidate.agent_id), [
    "implementation-002",
    "implementation-003"
  ]);
  assert.ok(result.rejected.some((candidate) => candidate.agent_id === "implementation-004" && candidate.reason === "fallback_limit_reached"));
  assert.ok(result.rejected.some((candidate) => candidate.agent_id === "orchestrator" && candidate.reason === "role_incompatible"));
});

test("unknown scope failure does not block another target", () => {
  let ledger = createEmptyCapacityLedger();
  ledger = applyCapacityEvent(ledger, event("usage_limit_confirmed", {
    scope: {
      scope_type: "unknown",
      scope_key: "unknown:observed-thread-a",
      scope_confidence: "low",
      agent_id: "implementation-001",
      thread_id: "thread-a"
    }
  }));
  const gate = evaluateCapacityGate({
    task: stagedTask({ owner_agent_id: "implementation-002" }),
    target: { agent_id: "implementation-002", scope_key: "thread:thread-b" },
    ledger,
    now: "2026-07-10T06:01:00.000Z"
  });
  assert.strictEqual(gate.allowed, true);
  assert.strictEqual(gate.probe, true);
  assert.strictEqual(gate.capacity.state, "unknown");
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

if (failed) throw new Error(`capacity-gate test failed: ${failed} failure(s)`);
console.log("capacity-gate tests passed");
