"use strict";

const fs = require("fs");
const path = require("path");
const { writeJsonAtomic } = require("./json-state");

const FOUNDATION_AGENT_IDS = ["user-support", "orquesta-admin"];
const OPEN_USER_TASK_STATES = new Set(["ready", "active", "pending", "blocked", "needs_review", "needs_user_review"]);
const CLOSED_STATES = new Set(["accepted", "adopted", "curated", "resolved", "retired", "skipped", "rejected", "done", "completed", "archived"]);
const SESSION_STALE_MINUTES = 60;
const LIVE_CLAIM_STALE_MINUTES = 5;
const HEARTBEAT_STALE_HOURS = 24;
const QUESTION_CANDIDATE_BATCH_THRESHOLD = 5;
const QUESTION_CANDIDATE_STALE_HOURS = 24;
const QUESTION_CANDIDATE_EVIDENCE_LIMIT = 8;

const QUESTION_CANDIDATE_REASON_TEXT = {
  pending_high_priority_question_candidate: "Pending high-priority question candidates need user-support triage.",
  pending_question_candidates_threshold_met: "Pending question candidates meet the batch curation threshold.",
  stale_pending_question_candidate: "Old pending question candidates meet the stale-age curation threshold.",
  question_candidate_blocks_acceptance: "A question candidate marked before_acceptance needs curator review before affected acceptance/routing proceeds."
};

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return { ...fallback, _read_error: String(error.message || error) };
  }
}

function writeJson(filePath, value) {
  return writeJsonAtomic(filePath, value);
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function ageMinutes(value, now) {
  const date = parseDate(value);
  if (!date) return null;
  return Math.max(0, Math.round((now.getTime() - date.getTime()) / 60000));
}

function ageHours(value, now) {
  const minutes = ageMinutes(value, now);
  return minutes === null ? null : Math.round((minutes / 60) * 10) / 10;
}

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function includesAny(value, terms) {
  const text = normalize(Array.isArray(value) ? value.join(" ") : value);
  return terms.some((term) => text.includes(term));
}

function openState(value) {
  const state = normalize(value);
  return state && !CLOSED_STATES.has(state);
}

function openUserTask(task) {
  const status = normalize(task.status);
  return OPEN_USER_TASK_STATES.has(status) || (status && !CLOSED_STATES.has(status));
}

function taskHasOpenUserTask(task, openUserTasks) {
  const id = task.task_id;
  if (!id) return false;
  return openUserTasks.some((userTask) => {
    const sourceIds = Array.isArray(userTask.source_ids) ? userTask.source_ids : [];
    return userTask.source_task_id === id || sourceIds.includes(id);
  });
}

function summarizeTask(task) {
  return {
    task_id: task.task_id || null,
    title: task.title || null,
    state: task.state || null,
    owner_agent_id: task.owner_agent_id || null
  };
}

function setupState(root) {
  const setupRoot = path.join(root, ".orquesta", "setup");
  return {
    options: readJson(path.join(setupRoot, "options.json"), {}),
    wizard: readJson(path.join(setupRoot, "wizard.json"), {}),
    specialistPlan: readJson(path.join(setupRoot, "specialist_plan.json"), {}),
    productionStart: readJson(path.join(setupRoot, "production_start.json"), {})
  };
}

function sessionFreshness(sessionsState, tasks, now) {
  const syncedAt = sessionsState.synced_at || null;
  const minutes = ageMinutes(syncedAt, now);
  const activeWork = tasks.some((task) => ["active", "needs_review", "needs_revision", "needs_user_review", "blocked"].includes(normalize(task.state)));
  const reasons = [];
  let status = "fresh";
  if (minutes === null) {
    status = "missing";
    reasons.push("sessions.json has no parseable synced_at timestamp.");
  } else {
    if (minutes > LIVE_CLAIM_STALE_MINUTES) {
      reasons.push(`sessions.json is older than ${LIVE_CLAIM_STALE_MINUTES} minutes; refresh before live dashboard/session claims.`);
    }
    if (activeWork && minutes > SESSION_STALE_MINUTES) {
      status = "stale";
      reasons.push(`sessions.json is older than ${SESSION_STALE_MINUTES} minutes during active Orquesta work.`);
    } else if (minutes > LIVE_CLAIM_STALE_MINUTES) {
      status = "live_claim_stale";
    }
  }
  return {
    synced_at: syncedAt,
    age_minutes: minutes,
    status,
    active_work_observed: activeWork,
    reasons
  };
}

function questionCandidatePolicy(questionCandidatesState) {
  const policy = questionCandidatesState.policy || {};
  return {
    pending_candidates_gte: Number(policy.pending_candidates_gte || policy.pending_candidate_threshold || QUESTION_CANDIDATE_BATCH_THRESHOLD),
    pending_candidates_age_hours_gte: Number(policy.pending_candidates_age_hours_gte || policy.pending_candidate_age_hours_gte || QUESTION_CANDIDATE_STALE_HOURS),
    pending_high_priority_candidate: true,
    candidate_blocks_acceptance: true
  };
}

function questionCandidateWakeSummary(questionCandidatesState, now) {
  const candidates = Array.isArray(questionCandidatesState.candidates) ? questionCandidatesState.candidates : [];
  const pending = candidates.filter((candidate) => normalize(candidate.status) === "pending_curator_review");
  const policy = questionCandidatePolicy(questionCandidatesState);
  const ages = pending.map((candidate) => ({
    candidate,
    age_hours: ageHours(candidate.created_at, now)
  }));
  const oldest = ages
    .filter((item) => item.age_hours !== null)
    .sort((first, second) => second.age_hours - first.age_hours)[0] || null;
  const suggestedTimingCounts = pending.reduce((counts, candidate) => {
    const key = candidate.suggested_timing || "unknown";
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});

  return {
    pending,
    ages,
    oldest,
    policy,
    summary: {
      type: "question_candidate_wake_summary",
      pending_count: pending.length,
      high_priority_count: pending.filter((candidate) => normalize(candidate.priority) === "high").length,
      before_acceptance_count: pending.filter((candidate) => normalize(candidate.suggested_timing) === "before_acceptance").length,
      oldest_pending_candidate_id: oldest?.candidate?.candidate_id || null,
      oldest_pending_age_hours: oldest?.age_hours ?? null,
      candidate_ids: pending.map((candidate) => candidate.candidate_id).filter(Boolean),
      source_task_ids: [...new Set(pending.map((candidate) => candidate.source_task_id).filter(Boolean))],
      source_agent_ids: [...new Set(pending.map((candidate) => candidate.source_agent_id).filter(Boolean))],
      suggested_timing_counts: suggestedTimingCounts,
      policy_thresholds: policy,
      basis: "A004/Q020 curated strong signal: surface pending question-candidate curator wake state in trigger audit."
    }
  };
}

function questionCandidateTriggers(questionCandidatesState, now) {
  const reasons = [];
  const reasonCodes = [];
  const evidence = [];
  const wakeSummary = questionCandidateWakeSummary(questionCandidatesState, now);
  const { pending, ages, oldest, policy, summary } = wakeSummary;

  if (!pending.length) {
    return { reasons, reason_codes: reasonCodes, evidence, recommended_action: undefined, trigger_status: undefined };
  }

  const highPriorityCount = summary.high_priority_count;
  const beforeAcceptanceCount = summary.before_acceptance_count;
  const thresholdMet = pending.length >= policy.pending_candidates_gte;
  const staleAgeMet = oldest?.age_hours !== null && oldest?.age_hours >= policy.pending_candidates_age_hours_gte;

  if (highPriorityCount > 0) reasonCodes.push("pending_high_priority_question_candidate");
  if (thresholdMet) reasonCodes.push("pending_question_candidates_threshold_met");
  if (staleAgeMet) reasonCodes.push("stale_pending_question_candidate");
  if (beforeAcceptanceCount > 0) reasonCodes.push("question_candidate_blocks_acceptance");

  reasonCodes.forEach((code) => reasons.push(QUESTION_CANDIDATE_REASON_TEXT[code]));

  evidence.push(summary);
  evidence.push(...ages.slice(0, QUESTION_CANDIDATE_EVIDENCE_LIMIT).map(({ candidate, age_hours }) => {
    const wakeReason = [];
    if (normalize(candidate.priority) === "high") wakeReason.push("pending_high_priority_question_candidate");
    if (normalize(candidate.suggested_timing) === "before_acceptance") wakeReason.push("question_candidate_blocks_acceptance");
    if (age_hours !== null && age_hours >= policy.pending_candidates_age_hours_gte) wakeReason.push("stale_pending_question_candidate");
    return {
      type: "question_candidate",
      candidate_id: candidate.candidate_id || null,
      priority: candidate.priority || null,
      category: candidate.category || null,
      suggested_timing: candidate.suggested_timing || null,
      source_task_id: candidate.source_task_id || null,
      source_agent_id: candidate.source_agent_id || null,
      created_at: candidate.created_at || null,
      age_hours,
      wake_reason: wakeReason.length ? wakeReason : ["pending_below_threshold"]
    };
  }));

  const triggerStatus = beforeAcceptanceCount > 0
    ? "wake_needed"
    : reasonCodes.length
      ? "trigger_ready"
      : undefined;
  const recommendedAction = beforeAcceptanceCount > 0
    ? "hold_affected_acceptance_and_wake_vision_curator_for_blocking_question_candidate"
    : reasonCodes.length
      ? "wake_vision_curator_for_question_candidate_batch_or_record_deferred_wake_reason"
      : "no_wake_required_batch_candidates_until_threshold_or_user_request";

  return {
    reasons,
    reason_codes: reasonCodes,
    evidence,
    recommended_action: recommendedAction,
    trigger_status: triggerStatus
  };
}

function visionTriggers(questionsState, answersState, questionCandidatesState, now) {
  const questions = questionsState.questions || [];
  const batches = answersState.answer_batches || [];
  const reasons = [];
  const evidence = [];
  const reasonCodes = [];

  const needsCuration = batches.filter((batch) => includesAny(batch.status, ["needs_curation", "pending_curation", "needs curator"]));
  if (needsCuration.length) {
    reasons.push("Answer batches need user-support curation.");
    evidence.push(...needsCuration.map((batch) => ({ batch_id: batch.batch_id, status: batch.status })));
  }

  const curatorQuestionStatuses = ["ready", "draft", "needs_curation", "needs_curator", "pending_curation"];
  const curatorQuestions = questions.filter((question) => {
    const status = normalize(question.status);
    return curatorQuestionStatuses.includes(status)
      || (status === "answered" && !question.curated_by)
      || (question.required_for_setup && !question.curated_by)
      || (question.priority === "high" && ["ready", "draft"].includes(status));
  });
  if (curatorQuestions.length) {
    reasons.push("Questions indicate curator work is waiting.");
    evidence.push(...curatorQuestions.slice(0, 8).map((question) => ({
      question_id: question.question_id,
      status: question.status,
      priority: question.priority,
      setup_gate: Boolean(question.setup_gate || question.required_for_setup)
    })));
  }

  const candidateTriggers = questionCandidateTriggers(questionCandidatesState, now);
  reasons.push(...candidateTriggers.reasons);
  reasonCodes.push(...candidateTriggers.reason_codes);
  evidence.push(...candidateTriggers.evidence);

  return {
    reasons,
    reason_codes: reasonCodes,
    evidence,
    recommended_action: candidateTriggers.recommended_action,
    trigger_status: candidateTriggers.trigger_status
  };
}

function failureTriggers(incidentsState, actionsState, tasks, incidentCandidatesState = {}, incidentClustersState = {}) {
  const incidents = incidentsState.incidents || [];
  const actions = actionsState.actions || [];
  const incidentCandidates = incidentCandidatesState.candidates || [];
  const incidentClusters = incidentClustersState.clusters || [];
  const reasons = [];
  const evidence = [];

  const openIncidents = incidents.filter((incident) => normalize(incident.status) === "open");
  if (openIncidents.length) {
    reasons.push("Open failure incidents need concierge review.");
    evidence.push(...openIncidents.map((incident) => ({
      incident_id: incident.incident_id,
      failure_class: incident.failure_class,
      status: incident.status,
      severity: incident.severity
    })));
  }

  const repeatedClasses = Object.entries(openIncidents.reduce((counts, incident) => {
    const key = incident.failure_class || "unknown";
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {})).filter(([, count]) => count >= 2);
  if (repeatedClasses.length) {
    reasons.push("Repeated open failure classes meet concierge wake policy.");
    evidence.push(...repeatedClasses.map(([failure_class, count]) => ({ failure_class, count })));
  }

  const activeCandidateStatuses = new Set(["candidate", "promoted", "clustered"]);
  const activeCandidates = incidentCandidates.filter((candidate) => activeCandidateStatuses.has(normalize(candidate.status)));
  const repeatedCandidateFingerprints = Object.entries(activeCandidates.reduce((counts, candidate) => {
    const key = candidate.global_fingerprint || candidate.fingerprint || "unknown";
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {})).filter(([, count]) => count >= 2);
  if (repeatedCandidateFingerprints.length) {
    reasons.push("Repeated incident candidates need user-support clustering review.");
    evidence.push(...repeatedCandidateFingerprints.map(([global_fingerprint, count]) => ({
      type: "repeated_incident_candidate",
      global_fingerprint,
      count
    })));
  }
  const qualityCandidates = activeCandidates.filter((candidate) => candidate.requires_user_approval);
  if (qualityCandidates.length) {
    reasons.push("Quality-degradation incident candidates need review before any user-facing repair action.");
    evidence.push(...qualityCandidates.map((candidate) => ({
      type: "quality_degradation_candidate",
      candidate_id: candidate.candidate_id || null,
      failure_class: candidate.failure_class || null,
      severity: candidate.severity || null,
      requires_user_approval: true
    })));
  }
  const openClusters = incidentClusters.filter((cluster) => normalize(cluster.status) === "open");
  if (openClusters.length) {
    reasons.push("Open incident clusters need user-support review.");
    evidence.push(...openClusters.map((cluster) => ({
      type: "incident_cluster",
      cluster_id: cluster.cluster_id || null,
      primary_class: cluster.primary_class || null,
      occurrence_count: cluster.occurrence_count || 0,
      requires_user_approval: Boolean(cluster.requires_user_approval)
    })));
  }

  const openRepairCards = actions.filter((action) => openState(action.status));
  if (openRepairCards.length) {
    reasons.push("Open user-action repair cards need user-support coordination.");
    evidence.push(...openRepairCards.map((action) => ({ action_id: action.action_id, status: action.status, title: action.title })));
  }

  const envBlockedTasks = tasks.filter((task) => {
    const blockers = task.blocked_by || [];
    return openState(task.state) && includesAny(blockers, ["environment", "permission", "dependency", "local_server", "missing_dependency", "quality_lowering_fallback"]);
  });
  if (envBlockedTasks.length) {
    reasons.push("Environment, permission, dependency, or quality-lowering fallback blockers exist in task state.");
    evidence.push(...envBlockedTasks.map(summarizeTask));
  }

  return { reasons, evidence };
}

function userLiaisonTriggers(tasks, userTasksState, answersState, actionsState) {
  const openUserTasks = (userTasksState.tasks || []).filter(openUserTask);
  const reasons = [];
  const evidence = [];

  const userReviewTasks = tasks.filter((task) => normalize(task.state) === "needs_user_review" && !taskHasOpenUserTask(task, openUserTasks));
  const revisionWithFeedback = tasks.filter((task) => normalize(task.state) === "needs_revision" && task.user_feedback && !taskHasOpenUserTask(task, openUserTasks));
  const approvalWaits = tasks.filter((task) => includesAny(task.blocked_by || [], ["user_approval_required", "approval_wait", "approval"]) && !taskHasOpenUserTask(task, openUserTasks));
  const visionReviewBatches = (answersState.answer_batches || []).filter((batch) => {
    const needs = Array.isArray(batch.needs_user_review) && batch.needs_user_review.length;
    return needs && openState(batch.status) && !openUserTasks.some((task) => (task.source_ids || []).includes(batch.batch_id));
  });
  const repairCards = (actionsState.actions || []).filter((action) => openState(action.status) && !openUserTasks.some((task) => (task.source_ids || []).includes(action.action_id)));

  if (userReviewTasks.length) {
    reasons.push("Task state has needs_user_review items without matching open user-task entries.");
    evidence.push(...userReviewTasks.map(summarizeTask));
  }
  if (revisionWithFeedback.length) {
    reasons.push("Task state has needs_revision items with user feedback but no matching open user-task entry.");
    evidence.push(...revisionWithFeedback.map(summarizeTask));
  }
  if (approvalWaits.length) {
    reasons.push("Approval-wait task blockers lack matching open user-task entries.");
    evidence.push(...approvalWaits.map(summarizeTask));
  }
  if (visionReviewBatches.length) {
    reasons.push("Vision answer batches need user review presentation.");
    evidence.push(...visionReviewBatches.map((batch) => ({ batch_id: batch.batch_id, status: batch.status })));
  }
  if (repairCards.length) {
    reasons.push("Open repair cards lack matching open user-task entries.");
    evidence.push(...repairCards.map((action) => ({ action_id: action.action_id, status: action.status, title: action.title })));
  }

  return {
    reasons,
    evidence,
    open_user_tasks: openUserTasks.map((task) => ({
      user_task_id: task.user_task_id,
      source: task.source,
      status: task.status,
      source_ids: task.source_ids || []
    }))
  };
}

function adminTriggers(setup, sessionAudit, agents, tasks) {
  const reasons = [];
  const evidence = [];

  if (["stale", "missing"].includes(sessionAudit.status)) {
    reasons.push("Session snapshot is stale or missing.");
    evidence.push({
      synced_at: sessionAudit.synced_at,
      age_minutes: sessionAudit.age_minutes,
      status: sessionAudit.status
    });
  }

  const adminAgent = agents.find((agent) => agent.agent_id === "orquesta-admin");
  if (adminAgent?.current_task) {
    const current = tasks.find((task) => task.task_id === adminAgent.current_task);
    if (!current || !["active", "needs_review", "needs_revision", "blocked"].includes(normalize(current.state))) {
      reasons.push("orquesta-admin has a standby-looking stale current_task value.");
      evidence.push({ agent_id: "orquesta-admin", current_task: adminAgent.current_task, task_state: current?.state || null });
    }
  }

  const options = setup.options || {};
  const wizard = setup.wizard || {};
  if (["pending", "proposal_ready", "needs_review", "blocked"].includes(normalize(options.bootstrap_status || options.setup_status))) {
    reasons.push("Setup options indicate pending or review-needed setup state.");
    evidence.push({ setup_status: options.setup_status, bootstrap_status: options.bootstrap_status });
  }
  if (["pending", "active", "needs_review", "blocked"].includes(normalize(wizard.status)) && normalize(wizard.status) !== "ready_for_operation") {
    reasons.push("Setup wizard is not ready for operation.");
    evidence.push({ wizard_status: wizard.status, current_step: wizard.current_step });
  }

  const tuningTasks = tasks.filter((task) => {
    if (!openState(task.state)) return false;
    const text = [task.title, task.source, task.owner_agent_id, task.task_id].join(" ");
    return includesAny(text, ["orquesta-admin", "setup", "dashboard url", "session", "configuration", "config", "tuning", "option pack"]);
  });
  if (tuningTasks.length) {
    reasons.push("Open setup/session/configuration tasks may require Orquesta Admin review.");
    evidence.push(...tuningTasks.slice(0, 8).map(summarizeTask));
  }

  return { reasons, evidence };
}

function classifyAgent(agent, trigger, now) {
  const heartbeatHours = ageHours(agent?.last_heartbeat, now);
  const heartbeatStale = heartbeatHours === null || heartbeatHours > HEARTBEAT_STALE_HOURS;
  let triggerStatus = trigger.trigger_status || (trigger.reasons.length ? "trigger_ready" : "clear");
  let severity = trigger.reasons.length ? "warning" : "ok";
  let recommendedAction = trigger.recommended_action || (trigger.reasons.length ? "orchestrator_should_wake_or_defer_with_reason" : "remain_event_driven_standby");

  if (triggerStatus === "wake_needed") {
    severity = "blocker";
    recommendedAction = trigger.recommended_action || "wake_foundation_agent_or_record_deferred_wake_reason";
  } else if (heartbeatStale && trigger.reasons.length) {
    triggerStatus = "wake_needed";
    severity = "blocker";
    recommendedAction = trigger.recommended_action || "wake_foundation_agent_or_record_deferred_wake_reason";
  } else if (heartbeatStale) {
    triggerStatus = "standby_stale";
    severity = "info";
    recommendedAction = trigger.recommended_action || "no_wake_required_without_trigger; refresh heartbeat when the agent next runs";
  }

  return {
    agent_id: agent?.agent_id || trigger.agent_id,
    role: agent?.role || trigger.agent_id,
    status: agent?.status || "unknown",
    last_heartbeat: agent?.last_heartbeat || null,
    heartbeat_age_hours: heartbeatHours,
    trigger_status: triggerStatus,
    severity,
    wake_required: triggerStatus === "wake_needed",
    reason_codes: trigger.reason_codes || [],
    reasons: trigger.reasons,
    evidence: trigger.evidence,
    open_user_tasks: trigger.open_user_tasks || undefined,
    recommended_action: recommendedAction
  };
}

function buildAudit(root, now = new Date()) {
  const stateRoot = path.join(root, ".orquesta", "state");
  const visionRoot = path.join(root, ".orquesta", "vision");
  const failuresRoot = path.join(root, ".orquesta", "failures");
  const userTasksRoot = path.join(root, ".orquesta", "user_tasks");

  const agentsState = readJson(path.join(stateRoot, "agents.json"), { agents: [] });
  const sessionsState = readJson(path.join(stateRoot, "sessions.json"), { sessions: [] });
  const tasksState = readJson(path.join(stateRoot, "tasks.json"), { tasks: [] });
  const questionsState = readJson(path.join(visionRoot, "questions.json"), { questions: [], curation_policy: {} });
  const answersState = readJson(path.join(visionRoot, "answers.json"), { answer_batches: [] });
  const questionCandidatesState = readJson(path.join(visionRoot, "question_candidates.json"), { version: 1, candidates: [], policy: {} });
  const incidentsState = readJson(path.join(failuresRoot, "incidents.json"), { incidents: [], wake_policy: {} });
  const incidentCandidatesState = readJson(path.join(failuresRoot, "incident_candidates.json"), { version: 1, candidates: [] });
  const incidentClustersState = readJson(path.join(failuresRoot, "incident_clusters.json"), { version: 1, clusters: [] });
  const actionsState = readJson(path.join(failuresRoot, "user_actions.json"), { actions: [] });
  const userTasksState = readJson(path.join(userTasksRoot, "queue.json"), { tasks: [], policy: {} });
  const setup = setupState(root);

  const agents = agentsState.agents || [];
  const tasks = tasksState.tasks || [];
  const sessionAudit = sessionFreshness(sessionsState, tasks, now);
  const supportTriggers = [
    visionTriggers(questionsState, answersState, questionCandidatesState, now),
    failureTriggers(incidentsState, actionsState, tasks, incidentCandidatesState, incidentClustersState),
    userLiaisonTriggers(tasks, userTasksState, answersState, actionsState)
  ];
  const supportReasons = supportTriggers.flatMap((trigger) => trigger.reasons || []);
  const statusRank = { clear: 0, trigger_ready: 1, wake_needed: 2 };
  const explicitSupportStatus = supportTriggers.reduce((status, trigger) => (
    (statusRank[trigger.trigger_status] || 0) > (statusRank[status] || 0) ? trigger.trigger_status : status
  ), "clear");
  const supportStatus = explicitSupportStatus === "clear" && supportReasons.length
    ? "trigger_ready"
    : explicitSupportStatus;
  const supportReasonCodes = [...new Set(supportTriggers.flatMap((trigger) => trigger.reason_codes || []))];
  const supportBlocksAcceptance = supportReasonCodes.includes("question_candidate_blocks_acceptance");
  const supportRecommendedAction = supportBlocksAcceptance
    ? "hold_affected_acceptance_and_wake_user_support"
    : supportStatus === "wake_needed"
      ? "wake_user_support_now_for_combined_triage"
      : supportStatus === "trigger_ready"
        ? "wake_user_support_for_combined_triage_or_record_deferred_wake_reason"
        : "no_wake_required_batch_support_events_until_threshold_or_user_request";
  const triggerByAgent = {
    "user-support": {
      agent_id: "user-support",
      trigger_status: supportStatus,
      reason_codes: supportReasonCodes,
      reasons: supportReasons,
      evidence: supportTriggers.flatMap((trigger) => trigger.evidence || []),
      open_user_tasks: supportTriggers.flatMap((trigger) => trigger.open_user_tasks || []),
      recommended_action: supportRecommendedAction
    },
    "orquesta-admin": { agent_id: "orquesta-admin", ...adminTriggers(setup, sessionAudit, agents, tasks) }
  };

  const foundationAgents = FOUNDATION_AGENT_IDS.map((agentId) => classifyAgent(
    agents.find((agent) => agent.agent_id === agentId) || { agent_id: agentId, role: agentId },
    triggerByAgent[agentId],
    now
  ));

  const summary = foundationAgents.reduce((counts, item) => {
    counts[item.trigger_status] = (counts[item.trigger_status] || 0) + 1;
    if (item.wake_required) counts.wake_required += 1;
    return counts;
  }, { clear: 0, trigger_ready: 0, standby_stale: 0, wake_needed: 0, wake_required: 0 });

  const overallStatus = summary.wake_needed
    ? "wake_needed"
    : summary.trigger_ready
      ? "trigger_ready"
      : summary.standby_stale
        ? "standby_stale"
        : "clear";

  return {
    version: 1,
    generated_at: now.toISOString(),
    generated_by: "orquesta/scripts/foundation-trigger-audit.js",
    status: overallStatus,
    policy: {
      session_stale_after_minutes: SESSION_STALE_MINUTES,
      live_claim_stale_after_minutes: LIVE_CLAIM_STALE_MINUTES,
      foundation_heartbeat_stale_after_hours: HEARTBEAT_STALE_HOURS
    },
    sources: [
      ".orquesta/state/agents.json",
      ".orquesta/state/sessions.json",
      ".orquesta/state/tasks.json",
      ".orquesta/vision/question_candidates.json",
      ".orquesta/vision/questions.json",
      ".orquesta/vision/answers.json",
      ".orquesta/failures/incidents.json",
      ".orquesta/failures/incident_candidates.json",
      ".orquesta/failures/incident_clusters.json",
      ".orquesta/failures/user_actions.json",
      ".orquesta/user_tasks/queue.json",
      ".orquesta/setup/options.json",
      ".orquesta/setup/wizard.json",
      ".orquesta/setup/specialist_plan.json",
      ".orquesta/setup/production_start.json"
    ],
    summary,
    sessions: sessionAudit,
    foundation_agents: foundationAgents,
    notes: [
      "Event-driven foundation agents are not failed just because their heartbeat is old.",
      "standby_stale means no wake trigger is active; wake_needed means a trigger is active and the heartbeat is stale.",
      "This audit does not message agents, create threads, create watchers, or mutate user_tasks."
    ]
  };
}

function main() {
  const root = path.resolve(process.argv[2] || process.cwd());
  const now = process.env.ORQUESTA_AUDIT_NOW ? new Date(process.env.ORQUESTA_AUDIT_NOW) : new Date();
  if (Number.isNaN(now.getTime())) {
    throw new Error("ORQUESTA_AUDIT_NOW must be a parseable date when provided.");
  }
  const audit = buildAudit(root, now);
  const outputPath = path.join(root, ".orquesta", "state", "trigger_audit.json");
  writeJson(outputPath, audit);
  console.log(`foundation trigger audit ${audit.status}: ${outputPath}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  buildAudit,
  FOUNDATION_AGENT_IDS
};
