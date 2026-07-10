#!/usr/bin/env node

"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  appendIncidentCandidate,
  classifyIncidentCandidate,
  clusterIncidentCandidates,
  createIncidentCandidate,
  fingerprintIncident
} = require("./incident-intake");

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-incident-intake-"));
}

function commandFailure(overrides = {}) {
  return {
    event_type: "command_failure",
    task_id: "T160",
    source_agent_id: "implementation-001",
    command_or_action: "node tool.js --port 4177 --thread thread-volatile-123",
    failure_class: "environment.browser_runtime",
    severity: "medium",
    summary: "Browser runtime failed at 2026-07-10T10:00:00.000Z in C:\\Users\\test\\AppData\\Local\\Temp\\probe-123.",
    evidence: ["exit 1"],
    attempted_fixes: ["retried once"],
    suspected_owner: "shared",
    occurred_at: "2026-07-10T10:00:00.000Z",
    ...overrides
  };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

{
  const root = makeRoot();
  try {
    const candidate = createIncidentCandidate(commandFailure());
    const appended = appendIncidentCandidate(root, candidate);
    const clusters = clusterIncidentCandidates(root);
    const candidates = readJson(path.join(root, ".orquesta", "failures", "incident_candidates.json"));
    assert.strictEqual(candidate.status, "candidate");
    assert.strictEqual(candidate.requires_user_approval, false);
    assert.strictEqual(appended.recorded, 1);
    assert.strictEqual(candidates.candidates.length, 1);
    assert.strictEqual(clusters.clusters.length, 0);
    assert.strictEqual(fs.existsSync(path.join(root, ".orquesta", "failures", "user_actions.json")), false);
    assert.strictEqual(fs.existsSync(path.join(root, ".orquesta", "user_tasks", "queue.json")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = makeRoot();
  try {
    appendIncidentCandidate(root, createIncidentCandidate(commandFailure()));
    appendIncidentCandidate(root, createIncidentCandidate(commandFailure({ occurred_at: "2026-07-10T10:01:00.000Z" })));
    const result = clusterIncidentCandidates(root);
    const candidates = readJson(path.join(root, ".orquesta", "failures", "incident_candidates.json"));
    assert.strictEqual(result.clusters.length, 1);
    assert.strictEqual(result.clusters[0].status, "open");
    assert.strictEqual(result.clusters[0].occurrence_count, 2);
    assert(candidates.candidates.every((candidate) => candidate.status === "clustered" && candidate.cluster_id === result.clusters[0].cluster_id));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = makeRoot();
  try {
    const degrading = createIncidentCandidate(commandFailure({
      event_type: "quality_degradation",
      fallback: { quality_impact: "weakens_browser_proof" }
    }));
    assert.strictEqual(classifyIncidentCandidate(degrading).requires_user_approval, true);
    appendIncidentCandidate(root, degrading);
    const clusters = clusterIncidentCandidates(root);
    assert.strictEqual(clusters.clusters[0].status, "open");
    assert.strictEqual(clusters.clusters[0].repair_card_id, null);

    const sameQuality = createIncidentCandidate(commandFailure({
      event_type: "quality_degradation",
      fallback: { quality_impact: "same_quality" }
    }));
    assert.strictEqual(sameQuality.status, "noise");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

{
  assert.throws(
    () => createIncidentCandidate(commandFailure({ occurred_at: "not-a-timestamp" })),
    (error) => error.code === "INCIDENT_INTAKE_INVALID"
  );
  const first = fingerprintIncident(commandFailure());
  const second = fingerprintIncident(commandFailure({
    command_or_action: "node tool.js --port 49152 --thread thread-other-999",
    summary: "Browser runtime failed at 2026-07-11T12:00:00.000Z in C:\\Users\\other\\AppData\\Local\\Temp\\probe-999."
  }));
  assert.strictEqual(first.global_fingerprint, second.global_fingerprint);
  assert(!first.global_fingerprint.includes("4177"));
  assert(!first.global_fingerprint.includes("Temp"));
}

console.log("incident-intake tests passed");
