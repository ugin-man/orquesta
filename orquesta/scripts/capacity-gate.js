#!/usr/bin/env node

const { updateJsonAtomic } = require("./json-state");

const DEFAULT_POLICY = Object.freeze({
  dispatch_start_timeout_seconds: 300,
  same_target_prestart_retry_limit: 2,
  retry_correlation_window_minutes: 10,
  fallback_candidate_limit: 2,
  available_evidence_ttl_minutes: 15,
  suspected_evidence_ttl_minutes: 10,
  machine_unavailable_ttl_minutes: 30,
  confirmed_usage_max_ttl_minutes: 360,
  probe_backoff_minutes: [30, 60, 120],
  max_automatic_probes_per_incident: 3,
  notification_dedupe_minutes: 60
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function addMinutes(timestamp, minutes) {
  return new Date(Date.parse(timestamp) + Number(minutes || 0) * 60000).toISOString();
}

function createEmptyCapacityLedger(overrides = {}) {
  return {
    version: 1,
    updated_at: null,
    policy: { ...DEFAULT_POLICY, ...(overrides.policy || {}) },
    orchestra: {
      mode: "normal",
      reason_codes: [],
      affected_task_ids: [],
      safe_work_task_ids: [],
      changed_at: null,
      notification_key: null,
      ...(overrides.orchestra || {})
    },
    capacity_records: [],
    dispatches: [],
    evidence: [],
    notifications: [],
    ...overrides,
    policy: { ...DEFAULT_POLICY, ...(overrides.policy || {}) },
    orchestra: {
      mode: "normal",
      reason_codes: [],
      affected_task_ids: [],
      safe_work_task_ids: [],
      changed_at: null,
      notification_key: null,
      ...(overrides.orchestra || {})
    },
    capacity_records: Array.isArray(overrides.capacity_records) ? clone(overrides.capacity_records) : [],
    dispatches: Array.isArray(overrides.dispatches) ? clone(overrides.dispatches) : [],
    evidence: Array.isArray(overrides.evidence) ? clone(overrides.evidence) : [],
    notifications: Array.isArray(overrides.notifications) ? clone(overrides.notifications) : []
  };
}

function normalizeCapacityLedger(value) {
  return createEmptyCapacityLedger(value && typeof value === "object" ? value : {});
}

function normalizeScope(event = {}) {
  if (event.scope?.scope_key) {
    return {
      scope_type: event.scope.scope_type || "unknown",
      scope_key: event.scope.scope_key,
      scope_confidence: event.scope.scope_confidence || "low",
      agent_id: event.scope.agent_id ?? event.agent_id ?? null,
      thread_id: event.scope.thread_id ?? event.thread_id ?? null,
      host_id: event.scope.host_id ?? null,
      account_id: event.scope.account_id ?? null,
      model: event.scope.model ?? null
    };
  }
  if (event.thread_id) {
    return {
      scope_type: "thread",
      scope_key: `thread:${event.thread_id}`,
      scope_confidence: "high",
      agent_id: event.agent_id || null,
      thread_id: event.thread_id,
      host_id: null,
      account_id: null,
      model: null
    };
  }
  return {
    scope_type: "unknown",
    scope_key: `unknown:${event.agent_id || "unassigned"}`,
    scope_confidence: "low",
    agent_id: event.agent_id || null,
    thread_id: null,
    host_id: null,
    account_id: null,
    model: null
  };
}

function stableToken(value) {
  return String(value || "unknown").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toUpperCase();
}

function ensureCapacityRecord(ledger, event) {
  const scope = normalizeScope(event);
  let record = ledger.capacity_records.find((item) => item.scope?.scope_key === scope.scope_key);
  if (record) return record;
  record = {
    capacity_id: `CAP-${stableToken(scope.agent_id || scope.scope_key)}-${String(ledger.capacity_records.length + 1).padStart(3, "0")}`,
    scope,
    state: "unknown",
    cause: "none",
    classification: "unconfirmed",
    evidence_level: "E0",
    observed_at: null,
    confirmed_at: null,
    expires_at: null,
    cooldown_until: null,
    reset_at: null,
    last_success_at: null,
    consecutive_prestart_failures: 0,
    circuit: {
      state: "half_open",
      generation: 0,
      opened_at: null,
      reason_code: null,
      probe_count: 0,
      next_probe_not_before: null
    },
    evidence_refs: []
  };
  ledger.capacity_records.push(record);
  return record;
}

function ensureDispatch(ledger, event) {
  let dispatch = ledger.dispatches.find((item) => item.dispatch_id === event.dispatch_id);
  if (dispatch) return dispatch;
  dispatch = {
    dispatch_id: event.dispatch_id,
    task_id: event.task_id || null,
    agent_id: event.agent_id || null,
    thread_id: event.thread_id || null,
    state: "queued",
    queued_at: event.observed_at || null,
    dispatch_accepted_at: null,
    turn_started_at: null,
    progress_observed_at: null,
    report_produced_at: null,
    report_path: null,
    adapter_id: event.adapter_id || "repository_only",
    idempotency_key: event.idempotency_key || event.dispatch_id,
    attempt_number: event.attempt_number || 1,
    error_class: null,
    error_fingerprint: null,
    evidence_refs: []
  };
  ledger.dispatches.push(dispatch);
  return dispatch;
}

function addEvidence(ledger, record, event, values) {
  const evidence = {
    evidence_id: `CAPEV-${String(ledger.evidence.length + 1).padStart(4, "0")}`,
    kind: values.kind,
    source: values.source || event.source || "repository_only",
    level: values.level,
    supports: values.supports,
    classification: values.classification,
    summary: values.summary,
    task_id: event.task_id || null,
    dispatch_id: event.dispatch_id || null,
    incident_id: event.incident_id || null,
    observed_at: event.observed_at,
    expires_at: values.expires_at || null
  };
  ledger.evidence.push(evidence);
  record.evidence_refs.push(evidence.evidence_id);
  return evidence;
}

function applyCapacityEvent(value, event, options = {}) {
  const ledger = normalizeCapacityLedger(value);
  const observedAt = event.observed_at || options.now || new Date().toISOString();
  const normalizedEvent = { ...event, observed_at: observedAt };
  const policy = ledger.policy;
  const record = ensureCapacityRecord(ledger, normalizedEvent);
  ledger.updated_at = observedAt;
  record.observed_at = observedAt;

  if (event.type === "dispatch_queued") {
    ensureDispatch(ledger, normalizedEvent);
    if (record.state === "unknown") {
      record.state = "probing";
      record.cause = "none";
      record.circuit.state = "half_open";
    }
    return ledger;
  }

  if (event.type === "dispatch_accepted") {
    const dispatch = ensureDispatch(ledger, normalizedEvent);
    dispatch.state = "dispatch_accepted";
    dispatch.dispatch_accepted_at = observedAt;
    if (record.state === "unknown") record.state = "probing";
    record.circuit.state = record.circuit.state === "closed" ? "closed" : "half_open";
    return ledger;
  }

  if (event.type === "prestart_system_error") {
    const dispatch = ensureDispatch(ledger, normalizedEvent);
    dispatch.state = "prestart_system_error";
    dispatch.error_class = "system_error_before_turn_start";
    dispatch.error_fingerprint = event.error_fingerprint || "system_error_before_turn_start";
    const windowStart = Date.parse(observedAt) - policy.retry_correlation_window_minutes * 60000;
    const correlated = ledger.dispatches.filter((item) => (
      item.task_id === dispatch.task_id
      && item.agent_id === dispatch.agent_id
      && item.thread_id === dispatch.thread_id
      && item.state === "prestart_system_error"
      && item.error_fingerprint === dispatch.error_fingerprint
      && Date.parse(item.queued_at || observedAt) >= windowStart
    ));
    record.consecutive_prestart_failures = correlated.length;
    if (correlated.length >= policy.same_target_prestart_retry_limit) {
      record.state = "unavailable";
      record.cause = "unknown";
      record.classification = "machine_inferred";
      record.evidence_level = "E2";
      record.expires_at = addMinutes(observedAt, policy.machine_unavailable_ttl_minutes);
      record.circuit.state = "open";
      record.circuit.generation += 1;
      record.circuit.opened_at = observedAt;
      record.circuit.reason_code = "repeated_prestart_failure";
      record.circuit.next_probe_not_before = addMinutes(observedAt, policy.probe_backoff_minutes[0]);
      addEvidence(ledger, record, normalizedEvent, {
        kind: "correlated_dispatch_failure",
        level: "E2",
        supports: "capacity_unavailable",
        classification: "machine_inferred",
        summary: "Correlated pre-start failures reached the configured limit.",
        expires_at: record.expires_at
      });
    } else {
      record.state = "suspected_unavailable";
      record.cause = "unknown";
      record.classification = "machine_ambiguous";
      record.evidence_level = "E1";
      record.expires_at = addMinutes(observedAt, policy.suspected_evidence_ttl_minutes);
      record.circuit.state = "half_open";
      addEvidence(ledger, record, normalizedEvent, {
        kind: "dispatch_result",
        level: "E1",
        supports: "capacity_suspected_unavailable",
        classification: "machine_ambiguous",
        summary: "One ambiguous system error occurred before turn start.",
        expires_at: record.expires_at
      });
    }
    return ledger;
  }

  if (event.type === "usage_limit_confirmed") {
    record.state = "cooldown";
    record.cause = "usage_window_exhausted";
    record.classification = event.source === "user" ? "user_confirmed" : "machine_confirmed";
    record.evidence_level = "E3";
    record.confirmed_at = observedAt;
    record.reset_at = event.reset_at || null;
    record.cooldown_until = event.reset_at || addMinutes(observedAt, policy.probe_backoff_minutes[0]);
    record.expires_at = event.expires_at || addMinutes(observedAt, policy.confirmed_usage_max_ttl_minutes);
    record.circuit.state = "open";
    record.circuit.generation += 1;
    record.circuit.opened_at = observedAt;
    record.circuit.reason_code = "usage_window_exhausted";
    record.circuit.next_probe_not_before = record.cooldown_until;
    addEvidence(ledger, record, normalizedEvent, {
      kind: event.source === "user" ? "user_confirmation" : "product_capacity_error",
      source: event.source || "product",
      level: "E3",
      supports: "usage_window_exhausted",
      classification: record.classification,
      summary: "Usage window exhaustion was explicitly confirmed.",
      expires_at: record.expires_at
    });
    return ledger;
  }

  if (event.type === "turn_started" || event.type === "progress_observed") {
    const dispatch = ensureDispatch(ledger, normalizedEvent);
    if (event.type === "turn_started") {
      dispatch.state = "turn_started";
      dispatch.turn_started_at = observedAt;
    } else {
      dispatch.state = "progress_observed";
      dispatch.progress_observed_at = observedAt;
      if (!dispatch.turn_started_at && record.circuit.state !== "closed") {
        return ledger;
      }
    }
    record.state = "available";
    record.cause = "none";
    record.classification = "machine_confirmed";
    record.evidence_level = "E3";
    record.last_success_at = observedAt;
    record.expires_at = addMinutes(observedAt, policy.available_evidence_ttl_minutes);
    record.cooldown_until = null;
    record.consecutive_prestart_failures = 0;
    record.circuit.state = "closed";
    record.circuit.reason_code = null;
    record.circuit.next_probe_not_before = null;
    addEvidence(ledger, record, normalizedEvent, {
      kind: event.type === "turn_started" ? "correlated_turn_start" : "correlated_progress",
      level: "E3",
      supports: "capacity_available",
      classification: "machine_confirmed",
      summary: event.type === "turn_started" ? "A correlated specialist turn started." : "Correlated specialist progress was observed.",
      expires_at: record.expires_at
    });
    return ledger;
  }

  if (event.type === "report_produced") {
    const dispatch = ensureDispatch(ledger, normalizedEvent);
    dispatch.state = "report_produced";
    dispatch.report_produced_at = observedAt;
    dispatch.report_path = event.report_path || null;
    return ledger;
  }

  if (event.type === "start_timeout") {
    const dispatch = ensureDispatch(ledger, normalizedEvent);
    dispatch.state = "start_timeout";
    dispatch.error_class = "start_timeout_without_error_evidence";
    record.state = "unknown";
    record.cause = "unknown";
    record.classification = "unconfirmed";
    record.evidence_level = "E0";
    record.circuit.state = "half_open";
    return ledger;
  }

  throw new Error(`Unsupported capacity event: ${event.type}`);
}

function expireCapacity(value, now = new Date().toISOString()) {
  const ledger = normalizeCapacityLedger(value);
  const nowMs = Date.parse(now);
  ledger.updated_at = now;
  for (const record of ledger.capacity_records) {
    if (record.state === "cooldown" && record.cooldown_until && Date.parse(record.cooldown_until) <= nowMs) {
      record.state = "probing";
      record.circuit.state = "half_open";
      record.circuit.probe_count = Number(record.circuit.probe_count || 0) + 1;
      record.circuit.next_probe_not_before = null;
      continue;
    }
    if (record.expires_at && Date.parse(record.expires_at) <= nowMs) {
      if (["available", "suspected_unavailable", "unavailable"].includes(record.state)) {
        const wasOpen = record.circuit.state === "open";
        record.state = "unknown";
        record.cause = "unknown";
        record.classification = "unconfirmed";
        record.evidence_level = "E0";
        record.circuit.state = wasOpen ? "open" : "half_open";
      }
    }
  }
  return ledger;
}

function findCapacityRecord(ledger, target = {}) {
  if (target.scope_key) {
    return ledger.capacity_records.find((record) => record.scope?.scope_key === target.scope_key) || null;
  }
  if (target.thread_id) {
    return ledger.capacity_records.find((record) => record.scope?.thread_id === target.thread_id) || null;
  }
  if (target.agent_id) {
    return ledger.capacity_records.find((record) => record.scope?.agent_id === target.agent_id) || null;
  }
  return null;
}

function unknownCapacity(target = {}) {
  return {
    capacity_id: null,
    scope: {
      scope_type: target.scope_key?.startsWith("thread:") ? "thread" : "unknown",
      scope_key: target.scope_key || `unknown:${target.agent_id || "unassigned"}`,
      scope_confidence: "low",
      agent_id: target.agent_id || null,
      thread_id: target.thread_id || null
    },
    state: "unknown",
    cause: "none",
    classification: "unconfirmed",
    evidence_level: "E0",
    circuit: {
      state: "half_open",
      generation: 0,
      probe_count: 0,
      next_probe_not_before: null
    }
  };
}

function evaluateCapacityGate({ task = {}, target = {}, ledger: value, now = new Date().toISOString() }) {
  const ledger = expireCapacity(value || createEmptyCapacityLedger(), now);
  const capacity = findCapacityRecord(ledger, target) || unknownCapacity(target);
  const blockers = [];
  const circuitOpen = capacity.circuit?.state === "open";

  if (task.routing_class === "specialist_required" && task.execution_actor === "orchestrator" && circuitOpen) {
    blockers.push({
      code: "orchestrator_substitution_after_capacity_loss",
      message: "The orchestrator cannot absorb specialist-required work while its capacity circuit is open."
    });
  }

  if (blockers.length) return { allowed: false, probe: false, capacity, blockers };
  if (capacity.state === "available" && capacity.circuit?.state === "closed") {
    return { allowed: true, probe: false, capacity, blockers };
  }

  const inFlight = ledger.dispatches.some((dispatch) => (
    (target.agent_id ? dispatch.agent_id === target.agent_id : true)
    && ["queued", "dispatch_accepted"].includes(dispatch.state)
  ));
  if (["unknown", "probing"].includes(capacity.state) && !inFlight) {
    return { allowed: true, probe: true, capacity, blockers };
  }
  if (capacity.state === "suspected_unavailable" && Number(capacity.consecutive_prestart_failures || 0) < ledger.policy.same_target_prestart_retry_limit && !inFlight) {
    return { allowed: true, probe: true, capacity, blockers };
  }

  blockers.push({
    code: circuitOpen ? "capacity_circuit_open" : "capacity_probe_in_flight",
    message: circuitOpen ? "The target capacity circuit is open." : "A bounded capacity probe is already in flight."
  });
  return { allowed: false, probe: false, capacity, blockers };
}

function independentCandidate(value) {
  return value === true || (typeof value === "string" && value.startsWith("independent"));
}

function selectEligibleFallbacks(candidates = [], { task = {}, ledger: value, limit, now = new Date().toISOString() } = {}) {
  const ledger = expireCapacity(value || createEmptyCapacityLedger(), now);
  const maxCandidates = Number(limit || ledger.policy.fallback_candidate_limit || 2);
  const eligible = [];
  const rejected = [];
  const allowedRoles = new Set(["exact", "approved_adjacent"]);

  for (const candidate of candidates) {
    let reason = null;
    if (!allowedRoles.has(candidate.role_compatibility)) reason = "role_incompatible";
    else if (!independentCandidate(candidate.independence)) reason = "not_independent";
    else if (!candidate.actual_model || !candidate.actual_model_evidence) reason = "actual_model_unverified";
    else {
      const capacity = findCapacityRecord(ledger, {
        scope_key: candidate.scope_key,
        agent_id: candidate.agent_id
      });
      if (capacity && !["available", "unknown"].includes(capacity.state)) reason = "fallback_capacity_unavailable";
    }

    if (reason) {
      rejected.push({ ...candidate, reason });
      continue;
    }
    if (eligible.length >= maxCandidates) {
      rejected.push({ ...candidate, reason: "fallback_limit_reached" });
      continue;
    }
    eligible.push({
      ...candidate,
      probe_required: !findCapacityRecord(ledger, { scope_key: candidate.scope_key, agent_id: candidate.agent_id }),
      acceptance_use: Array.isArray(candidate.evidence_downgrade) && candidate.evidence_downgrade.length
        ? "fail_evidence_only"
        : "positive_evidence_allowed"
    });
  }
  return { eligible, rejected, limit: maxCandidates };
}

function evaluateOrchestraMode({ tasks = [], blockedTaskIds = [], eligibleFallbackTaskIds = [] } = {}) {
  const blocked = new Set(blockedTaskIds);
  if (blocked.size === 0) {
    return { mode: "normal", reason_codes: [], affected_task_ids: [], safe_work_task_ids: [] };
  }
  const safeWorkTaskIds = tasks
    .filter((task) => !blocked.has(task.task_id) && !["accepted", "completed", "superseded"].includes(task.state) && task.safe_to_continue !== false)
    .map((task) => task.task_id);
  const hasFallback = eligibleFallbackTaskIds.some((taskId) => blocked.has(taskId));
  const mode = safeWorkTaskIds.length || hasFallback ? "degraded" : "paused";
  return {
    mode,
    reason_codes: ["required_specialist_capacity_unavailable"],
    affected_task_ids: [...blocked],
    safe_work_task_ids: safeWorkTaskIds
  };
}

function validateProducedReport(report) {
  const required = ["task_id", "agent_id", "thread_id", "dispatch_id", "report_path", "report_produced_at"];
  for (const field of required) {
    if (typeof report?.[field] !== "string" || !report[field].trim()) {
      const error = new Error(`Produced report reconciliation requires ${field}.`);
      error.code = "CAPACITY_REPORT_RECONCILIATION_INVALID";
      throw error;
    }
  }
  if (!Number.isFinite(Date.parse(report.report_produced_at))) {
    const error = new Error("Produced report reconciliation requires an ISO report_produced_at timestamp.");
    error.code = "CAPACITY_REPORT_RECONCILIATION_INVALID";
    throw error;
  }
  if (report.dispatch_accepted_at && !Number.isFinite(Date.parse(report.dispatch_accepted_at))) {
    const error = new Error("Produced report reconciliation requires an ISO dispatch_accepted_at timestamp when provided.");
    error.code = "CAPACITY_REPORT_RECONCILIATION_INVALID";
    throw error;
  }
  return { ...report };
}

function capacityEventForReport(report, type, observedAt) {
  return {
    type,
    task_id: report.task_id,
    agent_id: report.agent_id,
    thread_id: report.thread_id,
    dispatch_id: report.dispatch_id,
    adapter_id: report.adapter_id || "repository_only",
    idempotency_key: report.idempotency_key || report.dispatch_id,
    observed_at: observedAt,
    report_path: report.report_path
  };
}

function reconcileProducedReportsAtomic(capacityPath, reports, options = {}) {
  const normalizedReports = (reports || []).map(validateProducedReport);
  const now = options.now || new Date().toISOString();
  const write = updateJsonAtomic(capacityPath, createEmptyCapacityLedger(), (current) => {
    let ledger = normalizeCapacityLedger(current);
    for (const report of normalizedReports) {
      const knownDispatch = ledger.dispatches.find((dispatch) => dispatch.dispatch_id === report.dispatch_id);
      if (!knownDispatch) {
        if (!report.dispatch_accepted_at) {
          const error = new Error(`Missing dispatch_accepted_at for reconstructed dispatch ${report.dispatch_id}.`);
          error.code = "CAPACITY_REPORT_RECONCILIATION_INVALID";
          throw error;
        }
        ledger = applyCapacityEvent(ledger, capacityEventForReport(report, "dispatch_queued", report.dispatch_accepted_at));
        ledger = applyCapacityEvent(ledger, capacityEventForReport(report, "dispatch_accepted", report.dispatch_accepted_at));
      }
      ledger = applyCapacityEvent(ledger, capacityEventForReport(report, "report_produced", report.report_produced_at));
    }
    ledger.updated_at = now;
    return ledger;
  }, options);
  return { write, reports: normalizedReports };
}

module.exports = {
  DEFAULT_POLICY,
  applyCapacityEvent,
  createEmptyCapacityLedger,
  evaluateCapacityGate,
  evaluateOrchestraMode,
  expireCapacity,
  findCapacityRecord,
  normalizeCapacityLedger,
  reconcileProducedReportsAtomic,
  selectEligibleFallbacks
};
