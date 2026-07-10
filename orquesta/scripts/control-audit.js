#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const {
  inspectCompletionEnvelope,
  isStagedInTask
} = require("./completion-envelope-check");
const {
  createEmptyCapacityLedger,
  findCapacityRecord,
  normalizeCapacityLedger
} = require("./capacity-gate");
const {
  readJsonFile,
  writeJsonAtomic
} = require("./json-state");

const DEFAULT_SESSION_FRESHNESS_MS = 5 * 60 * 1000;
const DEFAULT_ROLLOUT_STARTED_AT = "2026-07-10T06:07:27.949Z";
const COMPLETION_STATES = new Set([
  "completed",
  "needs_review",
  "needs_orchestrator_review",
  "needs_revision",
  "accepted"
]);
const ACTIVE_STATES = new Set(["active", "in_progress", "accepted"]);

function asArray(value, key) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value[key])) return value[key];
  return [];
}

function safeReportPath(root, reportPath) {
  if (!reportPath) return null;
  const projectRoot = path.resolve(root);
  const absolute = path.resolve(projectRoot, reportPath);
  if (absolute !== projectRoot && !absolute.startsWith(`${projectRoot}${path.sep}`)) return null;
  return absolute;
}

function reportExists(root, reportPath) {
  const absolute = safeReportPath(root, reportPath);
  return Boolean(absolute && fs.existsSync(absolute));
}

function reportPathForTask(task) {
  const candidates = [
    task?.specialist_report_path,
    task?.report,
    task?.review_report,
    ...(Array.isArray(task?.artifacts) ? task.artifacts : [])
  ].filter(Boolean);
  return candidates.find((artifact) => (
    String(artifact).replace(/\\/g, "/").startsWith(".orquesta/reports/")
    && String(artifact).endsWith(".md")
  )) || null;
}

function validTime(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function taskRisk(task) {
  return task.control_signals?.risk_level || "low";
}

function isHardGateTask(task, options) {
  if (["superseded", "cancelled"].includes(task.state)) return false;
  const rolloutStartedAt = options.rolloutStartedAt || DEFAULT_ROLLOUT_STARTED_AT;
  if (options.rolloutMode !== "hard"
    && task.state === "accepted"
    && task.control_rollout !== "beta_v3"
    && validTime(task.accepted_at)
    && Date.parse(task.accepted_at) < Date.parse(rolloutStartedAt)) {
    return false;
  }
  if (!isStagedInTask(task, {
    rolloutMode: options.rolloutMode,
    rolloutStartedAt
  })) return false;
  return task.routing_class === "specialist_required" || ["medium", "high"].includes(taskRisk(task));
}

function finding(severity, category, code, message, values = {}) {
  return {
    finding_id: null,
    task_id: values.task_id || null,
    agent_id: values.agent_id || null,
    capacity_id: values.capacity_id || null,
    dispatch_id: values.dispatch_id || null,
    severity,
    category,
    code,
    message,
    evidence: values.evidence || {},
    recommended_action: values.recommended_action || null,
    created_at: values.created_at
  };
}

function addCompletionFindings(findings, check, task, hard, now) {
  for (const problem of check.errors) {
    findings.push(finding(hard ? "blocker" : "warning", "completion_envelope", problem.code, problem.message, {
      task_id: task.task_id,
      agent_id: task.owner_agent_id,
      evidence: {
        path: task.specialist_report_path || null,
        field: problem.field
      },
      recommended_action: "request_report_metadata",
      created_at: now
    }));
  }
  for (const warning of check.warnings) {
    findings.push(finding("warning", "completion_envelope", warning.code, warning.message, {
      task_id: task.task_id,
      agent_id: task.owner_agent_id,
      evidence: {
        path: task.specialist_report_path || null,
        field: warning.field
      },
      recommended_action: "preserve_legacy_acceptance",
      created_at: now
    }));
  }
}

function latestSessionTimestamp(session) {
  return session.updated_at || session.last_synced_at || session.last_heartbeat_at || null;
}

function auditCapacityEvidence(findings, task, envelope, now) {
  const capacityEvidence = envelope?.capacity_evidence;
  const taskHasFallback = Array.isArray(task.fallbacks) && task.fallbacks.length > 0;
  if (!capacityEvidence && !taskHasFallback) return;
  if (!capacityEvidence || typeof capacityEvidence !== "object") {
    findings.push(finding("blocker", "fallback", "fallback_capacity_evidence_incomplete", "Fallback acceptance is missing capacity_evidence.", {
      task_id: task.task_id,
      agent_id: task.owner_agent_id,
      recommended_action: "record_fallback_capacity_evidence",
      created_at: now
    }));
    return;
  }

  const required = [
    "source_capacity_id",
    "capacity_id",
    "dispatch_id",
    "dispatch_state",
    "capacity_state_at_dispatch",
    "role_compatibility",
    "independence",
    "requested_model",
    "actual_model",
    "evidence_downgrade",
    "acceptance_use"
  ];
  const downgrades = Array.isArray(capacityEvidence.evidence_downgrade)
    ? capacityEvidence.evidence_downgrade
    : [];
  const missing = required.filter((field) => (
    !Object.prototype.hasOwnProperty.call(capacityEvidence, field)
    || (capacityEvidence[field] === null && field !== "actual_model")
    || capacityEvidence[field] === ""
    || (field === "evidence_downgrade" && !Array.isArray(capacityEvidence[field]))
  ));
  if (capacityEvidence.actual_model === null && !downgrades.includes("model_unknown")) {
    missing.push("evidence_downgrade:model_unknown");
  }
  if (missing.length) {
    findings.push(finding("blocker", "fallback", "fallback_capacity_evidence_incomplete", `Fallback capacity evidence is missing: ${missing.join(", ")}.`, {
      task_id: task.task_id,
      agent_id: task.owner_agent_id,
      capacity_id: capacityEvidence.capacity_id || null,
      dispatch_id: capacityEvidence.dispatch_id || null,
      evidence: { fields: missing },
      recommended_action: "record_fallback_capacity_evidence",
      created_at: now
    }));
  }

  const requested = capacityEvidence.requested_model;
  const actual = capacityEvidence.actual_model;
  const modelMismatch = Boolean(requested && actual && requested !== actual);
  const modelDowngradeRecorded = downgrades.some((value) => ["model_unknown", "model_weaker", "model_mismatch"].includes(value));
  if (modelMismatch && !modelDowngradeRecorded) {
    findings.push(finding("blocker", "model_route", "actual_model_mismatch_hidden", "Fallback requested and actual model differ without a recorded evidence downgrade.", {
      task_id: task.task_id,
      agent_id: task.owner_agent_id,
      capacity_id: capacityEvidence.capacity_id || null,
      dispatch_id: capacityEvidence.dispatch_id || null,
      evidence: { requested_model: requested, actual_model: actual },
      recommended_action: "record_model_evidence_downgrade",
      created_at: now
    }));
  }

  const weakensEvidence = downgrades.length > 0 || modelMismatch;
  const positiveUse = !["fail_evidence_only", "diagnostic_only"].includes(capacityEvidence.acceptance_use);
  if (weakensEvidence && positiveUse && capacityEvidence.approval_status !== "approved") {
    findings.push(finding("blocker", "fallback", "fallback_evidence_downgrade_unapproved", "Evidence-weakening fallback cannot be used for positive acceptance without approval.", {
      task_id: task.task_id,
      agent_id: task.owner_agent_id,
      capacity_id: capacityEvidence.capacity_id || null,
      dispatch_id: capacityEvidence.dispatch_id || null,
      evidence: {
        evidence_downgrade: downgrades,
        acceptance_use: capacityEvidence.acceptance_use,
        approval_status: capacityEvidence.approval_status || null
      },
      recommended_action: "request_fallback_approval_or_re_review",
      created_at: now
    }));
  }
}

function finalizeFindingIds(findings) {
  const counters = new Map();
  for (const item of findings) {
    const key = item.task_id || item.capacity_id || "GLOBAL";
    const count = (counters.get(key) || 0) + 1;
    counters.set(key, count);
    item.finding_id = `CA-${String(key).replace(/[^A-Za-z0-9-]/g, "-")}-${String(count).padStart(3, "0")}`;
  }
}

function buildControlAudit(inputs = {}, options = {}) {
  const root = path.resolve(options.root || path.resolve(__dirname, "../.."));
  const now = options.now || new Date().toISOString();
  const nowMs = Date.parse(now);
  const rolloutMode = options.rolloutMode || "progressive";
  const tasks = asArray(inputs.tasks, "tasks").slice().sort((left, right) => String(left.task_id).localeCompare(String(right.task_id), "en"));
  const sessions = asArray(inputs.sessions, "sessions");
  const capacity = normalizeCapacityLedger(inputs.capacity || createEmptyCapacityLedger());
  const dispatches = capacity.dispatches;
  const findings = [];
  const sessionFreshnessMs = Number(options.sessionFreshnessMs || DEFAULT_SESSION_FRESHNESS_MS);

  for (const task of tasks) {
    const hard = isHardGateTask(task, { ...options, rolloutMode });
    const effectiveReportPath = reportPathForTask(task);
    const taskForEvidence = effectiveReportPath
      ? { ...task, specialist_report_path: effectiveReportPath }
      : task;
    const taskReportExists = reportExists(root, effectiveReportPath);
    const taskDispatches = dispatches.filter((dispatch) => dispatch.task_id === task.task_id);

    if (hard && task.routing_class === "specialist_required" && !validTime(task.handoff_sent_at)) {
      findings.push(finding("blocker", "delegation", "missing_specialist_handoff", "Staged-in specialist work has no valid handoff_sent_at.", {
        task_id: task.task_id,
        agent_id: task.owner_agent_id,
        evidence: { path: ".orquesta/state/tasks.json", field: "handoff_sent_at" },
        recommended_action: "record_specialist_handoff",
        created_at: now
      }));
    }
    if (hard && task.state === "accepted" && (!effectiveReportPath || !taskReportExists)) {
      findings.push(finding("blocker", "delegation", "missing_specialist_report", "Accepted staged-in task has no readable specialist report.", {
        task_id: task.task_id,
        agent_id: task.owner_agent_id,
        evidence: { path: effectiveReportPath || ".orquesta/state/tasks.json", field: "specialist_report_path" },
        recommended_action: "restore_specialist_report",
        created_at: now
      }));
    }

    if (COMPLETION_STATES.has(task.state)) {
      if (effectiveReportPath && taskReportExists) {
        const check = inspectCompletionEnvelope(safeReportPath(root, effectiveReportPath), taskForEvidence, {
          stagedIn: hard,
          rolloutMode
        });
        addCompletionFindings(findings, check, taskForEvidence, hard, now);
        if (check.envelope) auditCapacityEvidence(findings, task, check.envelope, now);
      } else if (hard) {
        findings.push(finding("blocker", "completion_envelope", "missing_completion_envelope", "Staged-in task cannot be accepted without a completion envelope.", {
          task_id: task.task_id,
          agent_id: task.owner_agent_id,
          evidence: { path: effectiveReportPath || null, field: "completion_envelope" },
          recommended_action: "request_report_metadata",
          created_at: now
        }));
      } else if (task.state === "accepted") {
        findings.push(finding("warning", "completion_envelope", "legacy_completion_envelope_missing", "Legacy accepted task has no completion envelope.", {
          task_id: task.task_id,
          agent_id: task.owner_agent_id,
          recommended_action: "preserve_legacy_acceptance",
          created_at: now
        }));
      }
    }

    if (hard && task.routing_class === "specialist_required" && task.state !== "queued" && taskDispatches.length === 0) {
      findings.push(finding("blocker", "capacity", "missing_capacity_dispatch", "Staged-in specialist task has no capacity dispatch record.", {
        task_id: task.task_id,
        agent_id: task.owner_agent_id,
        evidence: { path: ".orquesta/state/capacity.json", field: "dispatches" },
        recommended_action: "record_dispatch_lifecycle",
        created_at: now
      }));
    }

    const onlyDispatchAcceptance = taskDispatches.length > 0
      && taskDispatches.every((dispatch) => ["queued", "dispatch_accepted"].includes(dispatch.state))
      && !taskDispatches.some((dispatch) => dispatch.turn_started_at || dispatch.progress_observed_at || dispatch.report_produced_at)
      && !taskReportExists;
    if (hard && ACTIVE_STATES.has(task.state) && onlyDispatchAcceptance) {
      findings.push(finding("blocker", "capacity", "dispatch_without_turn_start", "Dispatch acceptance is not specialist turn-start or report evidence.", {
        task_id: task.task_id,
        agent_id: task.owner_agent_id,
        dispatch_id: taskDispatches[taskDispatches.length - 1].dispatch_id,
        evidence: { state: taskDispatches[taskDispatches.length - 1].state },
        recommended_action: "wait_for_turn_start_or_report",
        created_at: now
      }));
    }

    if (hard && ["active", "in_progress"].includes(task.state) && !taskReportExists) {
      const session = sessions.find((item) => item.agent_id === task.owner_agent_id);
      const latest = session && latestSessionTimestamp(session);
      if (session && (!validTime(latest) || nowMs - Date.parse(latest) > sessionFreshnessMs)) {
        findings.push(finding("blocker", "session_freshness", "stale_session_live_claim", "A stale session snapshot is being used for an active specialist claim.", {
          task_id: task.task_id,
          agent_id: task.owner_agent_id,
          evidence: { updated_at: latest, freshness_ms: sessionFreshnessMs },
          recommended_action: "refresh_session_state",
          created_at: now
        }));
      }
    }

    if (hard && task.execution_actor === "orchestrator") {
      const requiredAgent = task.required_specialist_agent_id || task.owner_agent_id;
      const record = findCapacityRecord(capacity, { agent_id: requiredAgent });
      if (record?.circuit?.state === "open") {
        findings.push(finding("blocker", "capacity", "orchestrator_substitution_after_capacity_loss", "The orchestrator is performing specialist-required work while the specialist circuit is open.", {
          task_id: task.task_id,
          agent_id: requiredAgent,
          capacity_id: record.capacity_id,
          recommended_action: "stop_direct_specialist_work",
          created_at: now
        }));
      }
    }
  }

  for (const record of capacity.capacity_records.slice().sort((left, right) => String(left.capacity_id).localeCompare(String(right.capacity_id), "en"))) {
    if (record.classification === "machine_ambiguous" && record.evidence_level === "E1" && record.cause === "usage_window_exhausted") {
      findings.push(finding("blocker", "capacity", "ambiguous_error_misclassified_as_usage_exhaustion", "Ambiguous pre-start evidence cannot prove usage exhaustion.", {
        agent_id: record.scope?.agent_id,
        capacity_id: record.capacity_id,
        recommended_action: "downgrade_capacity_cause_to_unknown",
        created_at: now
      }));
    }
    if (Number(record.consecutive_prestart_failures || 0) >= capacity.policy.same_target_prestart_retry_limit
      && record.circuit?.state !== "open") {
      findings.push(finding("blocker", "capacity", "correlated_failures_without_open_circuit", "Correlated pre-start failures reached the limit but the circuit is not open.", {
        agent_id: record.scope?.agent_id,
        capacity_id: record.capacity_id,
        recommended_action: "open_unknown_cause_circuit",
        created_at: now
      }));
    }
    if (["user_confirmed", "machine_confirmed"].includes(record.classification)
      && record.cause === "usage_window_exhausted"
      && record.cooldown_until
      && Date.parse(record.cooldown_until) > nowMs
      && record.state !== "cooldown") {
      findings.push(finding("blocker", "capacity", "confirmed_usage_not_in_cooldown", "Confirmed usage exhaustion must remain in cooldown before its reset or probe time.", {
        agent_id: record.scope?.agent_id,
        capacity_id: record.capacity_id,
        recommended_action: "enter_capacity_cooldown",
        created_at: now
      }));
    }
    if (record.state === "available" && record.expires_at && Date.parse(record.expires_at) <= nowMs) {
      findings.push(finding("blocker", "capacity", "stale_available_capacity", "Expired positive evidence cannot keep capacity available.", {
        agent_id: record.scope?.agent_id,
        capacity_id: record.capacity_id,
        evidence: { expires_at: record.expires_at },
        recommended_action: "expire_capacity_to_unknown",
        created_at: now
      }));
    }
    if (record.state === "cooldown" && record.cooldown_until && Date.parse(record.cooldown_until) <= nowMs) {
      findings.push(finding("blocker", "capacity", "cooldown_expired_not_probing", "Expired cooldown must move to probing, not remain cooldown or become available.", {
        agent_id: record.scope?.agent_id,
        capacity_id: record.capacity_id,
        evidence: { cooldown_until: record.cooldown_until },
        recommended_action: "open_one_recovery_probe",
        created_at: now
      }));
    }
  }

  const blockedCapacityTasks = tasks.filter((task) => {
    if (!isHardGateTask(task, { ...options, rolloutMode }) || task.routing_class !== "specialist_required") return false;
    const taskDispatches = dispatches.filter((dispatch) => dispatch.task_id === task.task_id);
    return taskDispatches.some((dispatch) => {
      const record = findCapacityRecord(capacity, { agent_id: dispatch.agent_id, thread_id: dispatch.thread_id });
      return record && record.circuit?.state === "open" && ["unavailable", "cooldown"].includes(record.state);
    });
  });
  if (blockedCapacityTasks.length && capacity.orchestra.mode === "normal") {
    findings.push(finding("blocker", "capacity", "required_capacity_unavailable_mode_normal", "Required specialist capacity is unavailable but orchestra mode remains normal.", {
      task_id: blockedCapacityTasks[0].task_id,
      agent_id: blockedCapacityTasks[0].owner_agent_id,
      evidence: { affected_task_ids: blockedCapacityTasks.map((task) => task.task_id) },
      recommended_action: "derive_degraded_or_paused_mode",
      created_at: now
    }));
  }

  finalizeFindingIds(findings);
  const blockers = findings.filter((item) => item.severity === "blocker").length;
  const warnings = findings.filter((item) => item.severity === "warning").length;
  const pendingQuestionObservations = asArray(inputs.questionCandidates, "candidates")
    .filter((candidate) => candidate.status === "pending_curator_review" && candidate.observation).length;
  const incidentCandidates = asArray(inputs.incidentCandidates, "candidates")
    .filter((candidate) => !["resolved", "dismissed", "accepted"].includes(candidate.status)).length;

  return {
    version: 1,
    generated_at: now,
    generated_by: "orquesta/scripts/control-audit.js",
    status: blockers ? "blockers" : warnings ? "warnings" : "clear",
    rollout: {
      mode: rolloutMode,
      hard_gate_scope: ["specialist_required", "medium_risk", "high_risk"],
      legacy_mode: "warn"
    },
    summary: {
      tasks_checked: tasks.length,
      blockers,
      warnings,
      missing_completion_envelopes: findings.filter((item) => item.code === "missing_completion_envelope").length,
      missing_specialist_reports: findings.filter((item) => item.code === "missing_specialist_report").length,
      fallbacks_requiring_user_approval: findings.filter((item) => item.code === "fallback_evidence_downgrade_unapproved").length,
      incident_candidates: incidentCandidates,
      question_observation_clusters: 0,
      question_observations_pending: pendingQuestionObservations,
      open_capacity_circuits: capacity.capacity_records.filter((record) => record.circuit?.state === "open").length
    },
    findings,
    sources: [
      ".orquesta/state/tasks.json",
      ".orquesta/state/trigger_audit.json",
      ".orquesta/state/sessions.json",
      ".orquesta/state/capacity.json",
      ".orquesta/vision/question_candidates.json",
      ".orquesta/failures/incidents.json",
      ".orquesta/failures/incident_candidates.json",
      ".orquesta/failures/incident_clusters.json"
    ]
  };
}

function readAuditInputs(root) {
  return {
    tasks: readJsonFile(path.join(root, ".orquesta/state/tasks.json"), { version: 1, tasks: [] }),
    triggerAudit: readJsonFile(path.join(root, ".orquesta/state/trigger_audit.json"), { version: 1, agents: [] }),
    sessions: readJsonFile(path.join(root, ".orquesta/state/sessions.json"), { version: 1, sessions: [] }),
    capacity: readJsonFile(path.join(root, ".orquesta/state/capacity.json"), createEmptyCapacityLedger()),
    questionCandidates: readJsonFile(path.join(root, ".orquesta/vision/question_candidates.json"), { version: 1, candidates: [] }),
    incidents: readJsonFile(path.join(root, ".orquesta/failures/incidents.json"), { version: 1, incidents: [] }),
    incidentCandidates: readJsonFile(path.join(root, ".orquesta/failures/incident_candidates.json"), { version: 1, candidates: [] }),
    incidentClusters: readJsonFile(path.join(root, ".orquesta/failures/incident_clusters.json"), { version: 1, clusters: [] })
  };
}

function runControlAudit(options = {}) {
  const root = path.resolve(options.root || path.resolve(__dirname, "../.."));
  const inputs = readAuditInputs(root);
  const audit = buildControlAudit(inputs, { ...options, root });
  const outputPath = path.join(root, ".orquesta/state/control_audit.json");
  const write = writeJsonAtomic(outputPath, audit, {
    renameRetries: 12,
    renameRetryDelayMs: 8,
    ...(options.writeOptions || {})
  });
  return { audit, write, outputPath };
}

function reviewTaskControl({ root, task, reportPath, now = new Date().toISOString(), rolloutMode = "progressive" }) {
  const projectRoot = path.resolve(root);
  const taskForReview = {
    ...task,
    specialist_report_path: reportPath || task.specialist_report_path
  };
  const inputs = readAuditInputs(projectRoot);
  inputs.tasks = { version: 1, tasks: [taskForReview] };
  const audit = buildControlAudit(inputs, { root: projectRoot, now, rolloutMode });
  const hard = isHardGateTask(taskForReview, { rolloutMode });
  const completion = reportPath
    ? inspectCompletionEnvelope(safeReportPath(projectRoot, reportPath), taskForReview, {
      stagedIn: hard,
      rolloutMode
    })
    : null;
  return {
    status: audit.status,
    blockers: audit.findings.filter((item) => item.severity === "blocker"),
    warnings: audit.findings.filter((item) => item.severity === "warning"),
    completion,
    audit
  };
}

if (require.main === module) {
  try {
    const result = runControlAudit();
    console.log(`control audit ${result.audit.status === "blockers" ? "blockers" : result.audit.status}: ${path.relative(process.cwd(), result.outputPath)}`);
  } catch (error) {
    console.error(`control audit failed: ${error.stack || error.message || error}`);
    process.exitCode = 1;
  }
}

module.exports = {
  buildControlAudit,
  readAuditInputs,
  reviewTaskControl,
  runControlAudit
};
