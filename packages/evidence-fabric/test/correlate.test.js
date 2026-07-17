"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { correlateEvidence, normalizeEvidence } = require("../src");

const hashes = Object.freeze({
  dispatch: "a".repeat(64),
  started: "b".repeat(64),
  artifact: "c".repeat(64),
  report: "d".repeat(64),
  acceptance: "e".repeat(64),
});

function bindings(overrides = {}) {
  return {
    task_intent_id: "TI-evidence",
    resolution_id: "RES-evidence",
    context_pack_id: "CP-evidence",
    correlation_id: "CORR-evidence",
    source_evidence_refs: ["source:fixture"],
    ...overrides,
  };
}

function state(overrides = {}) {
  return {
    current_task_intent_id: "TI-evidence",
    current_resolution_ids: ["RES-evidence"],
    current_context_pack_id: "CP-evidence",
    evidence_by_id: {},
    evidence_by_correlation: {},
    ...overrides,
  };
}

function withEvidence(current, evidence) {
  return {
    ...current,
    evidence_by_id: { ...current.evidence_by_id, [evidence.evidence_id]: evidence },
    evidence_by_correlation: {
      ...current.evidence_by_correlation,
      [evidence.correlation_id]: [...(current.evidence_by_correlation[evidence.correlation_id] || []), evidence],
    },
  };
}

function evidence(kind, fields = {}) {
  return normalizeEvidence({
    kind,
    ...bindings(),
    evidence_id: "EVD-default",
    evidence_hash: hashes.dispatch,
    request_ref: "request:fixture",
    thread_id: "thread-evidence",
    turn_id: null,
    predecessor_evidence_id: null,
    ...fields,
  });
}

test("correlates bounded runtime evidence in order and rejects missing or conflicting predecessors", () => {
  const dispatch = evidence("runtime_dispatch", { evidence_id: "EVD-dispatch" });
  const first = correlateEvidence(state(), dispatch);
  assert.equal(first.status, "ready");
  assert.equal(first.event_type, "runtime.dispatch.accepted");
  assert.equal(Object.hasOwn(dispatch, "body"), false);

  const afterDispatch = withEvidence(state(), dispatch);
  assert.equal(correlateEvidence(afterDispatch, dispatch).status, "idempotent");
  assert.throws(
    () => correlateEvidence(afterDispatch, { ...dispatch, evidence_hash: "f".repeat(64) }),
    { code: "EVIDENCE_ID_CONFLICT" },
  );

  const missingPredecessor = evidence("runtime_event", {
    evidence_id: "EVD-start-missing", evidence_hash: hashes.started, event_kind: "turn_started", turn_id: "turn-evidence",
  });
  assert.throws(() => correlateEvidence(afterDispatch, missingPredecessor), { code: "EVIDENCE_PREDECESSOR_REQUIRED" });

  const wrongCorrelation = evidence("runtime_event", {
    evidence_id: "EVD-start-wrong", evidence_hash: hashes.started, event_kind: "turn_started", turn_id: "turn-evidence",
    predecessor_evidence_id: dispatch.evidence_id, correlation_id: "CORR-other",
  });
  assert.throws(() => correlateEvidence(afterDispatch, wrongCorrelation), { code: "EVIDENCE_CORRELATION_MISMATCH" });

  const started = evidence("runtime_event", {
    evidence_id: "EVD-started", evidence_hash: hashes.started, event_kind: "turn_started", turn_id: "turn-evidence",
    predecessor_evidence_id: dispatch.evidence_id,
  });
  const afterStarted = withEvidence(afterDispatch, started);
  assert.equal(correlateEvidence(afterDispatch, started).status, "ready");

  const inactiveArtifact = evidence("artifact", {
    evidence_id: "EVD-artifact-inactive", evidence_hash: hashes.artifact, turn_id: "turn-other",
    predecessor_evidence_id: started.evidence_id, artifact_ref: "artifact:runtime", artifact_hash: hashes.artifact,
  });
  assert.throws(() => correlateEvidence(afterStarted, inactiveArtifact), { code: "EVIDENCE_RUNTIME_INACTIVE" });

  const artifact = evidence("artifact", {
    evidence_id: "EVD-artifact", evidence_hash: hashes.artifact, turn_id: "turn-evidence",
    predecessor_evidence_id: started.evidence_id, artifact_ref: "artifact:runtime", artifact_hash: hashes.artifact,
  });
  const afterArtifact = withEvidence(afterStarted, artifact);
  assert.equal(correlateEvidence(afterStarted, artifact).status, "ready");

  const reportMissingEvidence = evidence("report", {
    evidence_id: "EVD-report-missing", evidence_hash: hashes.report, request_ref: null, turn_id: "turn-evidence",
  });
  assert.throws(() => correlateEvidence(afterArtifact, reportMissingEvidence), { code: "EVIDENCE_REPORT_PREDECESSOR_REQUIRED" });

  const report = evidence("report", {
    evidence_id: "EVD-report", evidence_hash: hashes.report, predecessor_evidence_id: artifact.evidence_id,
    turn_id: "turn-evidence", report_ref: "report:fixture", report_hash: hashes.report,
  });
  const afterReport = withEvidence(afterArtifact, report);
  assert.equal(correlateEvidence(afterArtifact, report).status, "ready");

  const acceptanceMissingEvidence = evidence("acceptance", {
    evidence_id: "EVD-acceptance-missing", evidence_hash: hashes.acceptance, turn_id: "turn-evidence",
  });
  assert.throws(() => correlateEvidence(afterReport, acceptanceMissingEvidence), { code: "EVIDENCE_ACCEPTANCE_EVIDENCE_REQUIRED" });

  const acceptance = evidence("acceptance", {
    evidence_id: "EVD-acceptance", evidence_hash: hashes.acceptance, predecessor_evidence_id: report.evidence_id,
    turn_id: "turn-evidence", acceptance_ref: "acceptance:fixture",
  });
  assert.equal(correlateEvidence(afterReport, acceptance).status, "ready");
});

test("rejects stale lifecycle binding and dispatches without a request reference", () => {
  const staleResolution = evidence("runtime_dispatch", { resolution_id: "RES-stale" });
  assert.throws(() => correlateEvidence(state(), staleResolution), { code: "EVIDENCE_BINDING_STALE" });

  const missingRequest = evidence("runtime_dispatch", { request_ref: null });
  assert.throws(() => correlateEvidence(state(), missingRequest), { code: "EVIDENCE_REQUEST_REQUIRED" });
});
