#!/usr/bin/env node

"use strict";

const crypto = require("crypto");
const path = require("path");
const { readJsonFile, updateJsonAtomic } = require("./json-state");

const EVENT_TYPES = new Set(["command_failure", "ineffective_repeat", "quality_degradation"]);
const SEVERITIES = new Set(["low", "medium", "high", "blocker"]);
const OWNERS = new Set(["codex", "user", "shared", "unknown"]);

function hasText(value) {
  return String(value || "").trim().length > 0;
}

function invalid(message) {
  const error = new Error(message);
  error.code = "INCIDENT_INTAKE_INVALID";
  return error;
}

function defaultIncidentCandidateInbox() {
  return { version: 1, updated_at: null, candidates: [] };
}

function defaultIncidentClusterInbox() {
  return { version: 1, updated_at: null, clusters: [] };
}

function canonicalizeFingerprintText(value) {
  return String(value || "")
    .replace(/[A-Za-z]:\\(?:[^\\\s]+\\)*?(?:temp|tmp)\\[^\s]+/gi, "[temp-path]")
    .replace(/\/(?:tmp|var\/folders)\/[^\s]+/gi, "[temp-path]")
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, "[timestamp]")
    .replace(/\bthread(?:[_ -]?id)?\s*[:= -]+[A-Za-z0-9-]+/gi, "thread:[id]")
    .replace(/\b(127\.0\.0\.1|localhost):\d{2,5}\b/gi, "$1:[port]")
    .replace(/--port\s+\d{2,5}\b/gi, "--port [port]")
    .replace(/\bport\s*[:= ]\s*\d{2,5}\b/gi, "port:[port]")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function shortHash(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex").slice(0, 20);
}

function fingerprintIncident(input = {}) {
  const canonical = canonicalizeFingerprintText([
    input.event_type,
    input.failure_class,
    input.command_or_action,
    input.summary,
    ...(Array.isArray(input.evidence) ? input.evidence : [])
  ].join("\n"));
  const scope = `${input.task_id || "unassigned"}|${input.source_agent_id || "unknown"}`;
  return {
    fingerprint: `IF-${shortHash(`${scope}|${canonical}`)}`,
    global_fingerprint: `GF-${shortHash(canonical)}`
  };
}

function fallbackQuality(input = {}) {
  const impact = String(input.fallback?.quality_impact || input.quality_impact || "").toLowerCase();
  return {
    same_quality: impact === "same_quality",
    weakens_proof: /weakens_(browser|visual|runtime|acceptance)_proof/.test(impact) || impact === "quality_degrading"
  };
}

function classifyIncidentCandidate(candidate = {}) {
  const quality = fallbackQuality(candidate);
  if (quality.same_quality) {
    return { status: "noise", requires_user_approval: false, cluster_eligible: false, reason: "same_quality_fallback" };
  }
  if (quality.weakens_proof || candidate.event_type === "quality_degradation") {
    return { status: "candidate", requires_user_approval: true, cluster_eligible: true, reason: "quality_degradation_requires_review" };
  }
  return { status: "candidate", requires_user_approval: false, cluster_eligible: true, reason: "failure_candidate" };
}

function createIncidentCandidate(input, options = {}) {
  if (!input || typeof input !== "object") throw invalid("Incident intake input must be an object.");
  const eventType = input.event_type || "command_failure";
  const occurredAt = input.occurred_at || input.created_at || options.now || new Date().toISOString();
  if (!EVENT_TYPES.has(eventType)) throw invalid(`Unsupported incident event_type: ${eventType}`);
  if (!Number.isFinite(Date.parse(occurredAt))) throw invalid("Incident intake requires a valid occurred_at timestamp.");
  for (const field of ["task_id", "source_agent_id", "command_or_action", "failure_class", "summary"]) {
    if (!hasText(input[field])) throw invalid(`Incident intake requires ${field}.`);
  }
  const severity = input.severity || "medium";
  if (!SEVERITIES.has(severity)) throw invalid(`Unsupported incident severity: ${severity}`);
  const suspectedOwner = input.suspected_owner || "unknown";
  if (!OWNERS.has(suspectedOwner)) throw invalid(`Unsupported suspected_owner: ${suspectedOwner}`);

  const fingerprints = fingerprintIncident({ ...input, event_type: eventType });
  const classification = classifyIncidentCandidate({ ...input, event_type: eventType });
  return {
    candidate_id: null,
    status: classification.status,
    event_type: eventType,
    task_id: input.task_id,
    source_agent_id: input.source_agent_id,
    command_or_action: input.command_or_action,
    failure_class: input.failure_class,
    severity,
    summary: input.summary,
    evidence: Array.isArray(input.evidence) ? input.evidence.map(String) : [],
    attempted_fixes: Array.isArray(input.attempted_fixes) ? input.attempted_fixes.map(String) : [],
    suspected_owner: suspectedOwner,
    fingerprint: fingerprints.fingerprint,
    global_fingerprint: fingerprints.global_fingerprint,
    cluster_id: null,
    fallback_id: input.fallback?.fallback_id || input.fallback_id || null,
    fallback: input.fallback || null,
    requires_user_approval: classification.requires_user_approval,
    classification_reason: classification.reason,
    source_event_id: input.source_event_id || null,
    created_at: occurredAt,
    reviewed_at: null,
    review_decision: null
  };
}

function nextCandidateId(candidates, taskId) {
  const prefix = `IC-${String(taskId || "UNASSIGNED").replace(/[^A-Za-z0-9]+/g, "-").toUpperCase()}`;
  const max = candidates
    .map((candidate) => String(candidate.candidate_id || "").match(new RegExp(`^${prefix}-(\\d+)$`))?.[1])
    .filter(Boolean)
    .map(Number)
    .reduce((current, value) => Math.max(current, value), 0);
  return `${prefix}-${String(max + 1).padStart(3, "0")}`;
}

function appendIncidentCandidate(root, candidate) {
  const candidatePath = path.join(root, ".orquesta", "failures", "incident_candidates.json");
  let outcome = { recorded: 0, skipped: 0, candidate: null };
  const transaction = updateJsonAtomic(candidatePath, defaultIncidentCandidateInbox(), (current) => {
    const inbox = current && typeof current === "object" ? current : defaultIncidentCandidateInbox();
    inbox.version = 1;
    inbox.candidates = Array.isArray(inbox.candidates) ? inbox.candidates : [];
    const duplicate = candidate.source_event_id && inbox.candidates.some((item) => item.source_event_id === candidate.source_event_id);
    if (duplicate) {
      outcome = { recorded: 0, skipped: 1, candidate: null };
      return inbox;
    }
    const stored = { ...candidate, candidate_id: nextCandidateId(inbox.candidates, candidate.task_id) };
    inbox.candidates.push(stored);
    inbox.updated_at = stored.created_at;
    outcome = { recorded: 1, skipped: 0, candidate: stored };
    return inbox;
  });
  return { ...outcome, lock: transaction.lock };
}

function clusterIncidentCandidates(root, options = {}) {
  const candidatePath = path.join(root, ".orquesta", "failures", "incident_candidates.json");
  const clusterPath = path.join(root, ".orquesta", "failures", "incident_clusters.json");
  const now = options.now || new Date().toISOString();
  const candidateInbox = readJsonFile(candidatePath, defaultIncidentCandidateInbox());
  const groups = new Map();
  (candidateInbox.candidates || []).filter((candidate) => candidate.status !== "noise").forEach((candidate) => {
    const key = candidate.global_fingerprint || candidate.fingerprint;
    if (!key) return;
    const group = groups.get(key) || [];
    group.push(candidate);
    groups.set(key, group);
  });
  const clusterInputs = [...groups.entries()]
    .filter(([, candidates]) => candidates.length >= 2 || candidates.some((candidate) => candidate.requires_user_approval))
    .map(([globalFingerprint, candidates]) => ({ global_fingerprint: globalFingerprint, candidates }));

  let output = [];
  const clusterTransaction = updateJsonAtomic(clusterPath, defaultIncidentClusterInbox(), (current) => {
    const inbox = current && typeof current === "object" ? current : defaultIncidentClusterInbox();
    inbox.version = 1;
    inbox.clusters = Array.isArray(inbox.clusters) ? inbox.clusters : [];
    let nextId = inbox.clusters
      .map((cluster) => String(cluster.cluster_id || "").match(/^FC(\d+)$/)?.[1])
      .filter(Boolean)
      .map(Number)
      .reduce((currentMax, value) => Math.max(currentMax, value), 0);
    const clusters = clusterInputs.map((group) => {
      const existing = inbox.clusters.find((cluster) => cluster.global_fingerprint === group.global_fingerprint);
      const candidates = group.candidates;
      const first = candidates.slice().sort((left, right) => Date.parse(left.created_at) - Date.parse(right.created_at))[0];
      const latest = candidates.slice().sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))[0];
      return {
        cluster_id: existing?.cluster_id || `FC${String(++nextId).padStart(3, "0")}`,
        status: "open",
        primary_class: first.failure_class,
        severity: candidates.some((candidate) => candidate.severity === "blocker") ? "blocker" : candidates.some((candidate) => candidate.severity === "high") ? "high" : first.severity,
        suspected_owner: first.suspected_owner,
        candidate_ids: candidates.map((candidate) => candidate.candidate_id),
        incident_ids: existing?.incident_ids || [],
        related_task_ids: [...new Set(candidates.map((candidate) => candidate.task_id))],
        occurrence_count: candidates.length,
        first_seen_at: first.created_at,
        last_seen_at: latest.created_at,
        latest_evidence: latest.evidence.slice(0, 4),
        repair_card_id: null,
        codex_route_task_id: existing?.codex_route_task_id || null,
        resolution_evidence: null,
        global_fingerprint: group.global_fingerprint,
        requires_user_approval: candidates.some((candidate) => candidate.requires_user_approval)
      };
    });
    const touched = new Set(clusters.map((cluster) => cluster.cluster_id));
    inbox.clusters = [...inbox.clusters.filter((cluster) => !touched.has(cluster.cluster_id)), ...clusters];
    if (clusters.length) inbox.updated_at = now;
    output = clusters;
    return inbox;
  });

  let candidateTransaction = null;
  if (output.length) {
    const clusterByFingerprint = new Map(output.map((cluster) => [cluster.global_fingerprint, cluster.cluster_id]));
    candidateTransaction = updateJsonAtomic(candidatePath, defaultIncidentCandidateInbox(), (current) => {
      const inbox = current && typeof current === "object" ? current : defaultIncidentCandidateInbox();
      inbox.version = 1;
      inbox.candidates = Array.isArray(inbox.candidates) ? inbox.candidates : [];
      inbox.candidates = inbox.candidates.map((candidate) => {
        const clusterId = clusterByFingerprint.get(candidate.global_fingerprint || candidate.fingerprint);
        return clusterId ? { ...candidate, status: "clustered", cluster_id: clusterId } : candidate;
      });
      inbox.updated_at = now;
      return inbox;
    });
  }

  return { clusters: output, candidate_lock: candidateTransaction?.lock || null, cluster_lock: clusterTransaction.lock };
}

module.exports = {
  appendIncidentCandidate,
  classifyIncidentCandidate,
  clusterIncidentCandidates,
  createIncidentCandidate,
  defaultIncidentCandidateInbox,
  defaultIncidentClusterInbox,
  fingerprintIncident
};
