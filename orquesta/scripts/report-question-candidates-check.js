#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { updateJsonAtomic, writeJsonAtomic } = require("./json-state");

const VALID_NONE_REASONS = new Set([
  "purely_mechanical_change",
  "no_new_user_choice",
  "already_covered_by_existing_question",
  "duplicate_or_low_value",
  "report_only_readiness_no_new_ambiguity",
  "blocked_before_domain_insight",
  "emergency_or_recovery_no_question_yet"
]);

const VALID_PRIORITIES = new Set(["low", "medium", "high"]);
const VALID_CATEGORIES = new Set([
  "scope",
  "design",
  "workflow",
  "quality",
  "risk",
  "roadmap",
  "user_preference",
  "technical_direction",
  "release",
  "other"
]);
const VALID_TIMINGS = new Set(["now", "before_next_task", "before_acceptance", "batch_later", "roadmap_review"]);
const VALID_CANDIDATE_STATUSES = new Set([
  "pending_curator_review",
  "observation",
  "clustered",
  "curator_accepted",
  "curator_rejected",
  "merged_duplicate",
  "promoted_to_question",
  "retired"
]);
const VALID_OBSERVATION_VALUE_TYPES = new Set([
  "user_emergence",
  "operating_rule",
  "maintenance_note",
  "duplicate",
  "low_value"
]);
const VALID_USER_EMERGENCE_VALUES = new Set(["low", "medium", "high"]);
const VALID_OBSERVATION_ACTIONS = new Set(["ignore", "keep_as_note", "curator_review", "ask_user"]);

const REQUIRED_ITEM_FIELDS = [
  "priority",
  "category",
  "question",
  "why_now",
  "user_impact",
  "suggested_timing",
  "source_task_id",
  "source_agent_id",
  "source_report_path"
];

const REQUIRED_INBOX_FIELDS = [
  "candidate_id",
  "status",
  "priority",
  "category",
  "question",
  "why_now",
  "user_impact",
  "suggested_timing",
  "source_task_id",
  "source_agent_id",
  "source_report_path",
  "created_at"
];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function hasText(value) {
  return String(value || "").trim().length > 0;
}

function parseJsonBlocks(text) {
  const blocks = [];
  const fencePattern = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match;
  while ((match = fencePattern.exec(text)) !== null) {
    const raw = match[1].trim();
    if (!raw.includes("question_candidates")) continue;
    try {
      blocks.push({ value: JSON.parse(raw), error: null });
    } catch (error) {
      blocks.push({ value: null, error });
    }
  }
  return blocks;
}

function extractQuestionCandidates(text) {
  const blocks = parseJsonBlocks(text);
  const parseErrors = blocks.filter((block) => block.error).map((block) => block.error.message);
  const parsed = blocks
    .filter((block) => block.value && block.value.question_candidates)
    .map((block) => block.value.question_candidates);
  return {
    metadata: parsed[0] || null,
    parseErrors,
    blockCount: blocks.length
  };
}

function validateCandidateItem(item, index) {
  const errors = [];
  const prefix = `item ${index + 1}`;
  REQUIRED_ITEM_FIELDS.forEach((field) => {
    if (!hasText(item[field])) errors.push(`${prefix}: missing ${field}`);
  });
  if (hasText(item.priority) && !VALID_PRIORITIES.has(item.priority)) {
    errors.push(`${prefix}: invalid priority ${item.priority}`);
  }
  if (hasText(item.category) && !VALID_CATEGORIES.has(item.category)) {
    errors.push(`${prefix}: invalid category ${item.category}`);
  }
  if (hasText(item.suggested_timing) && !VALID_TIMINGS.has(item.suggested_timing)) {
    errors.push(`${prefix}: invalid suggested_timing ${item.suggested_timing}`);
  }
  if (item.observation !== undefined && item.observation !== null) {
    errors.push(...validateObservation(item.observation, prefix));
  }
  return errors;
}

function defaultObservation() {
  return {
    value_type: "maintenance_note",
    user_emergence_value: "low",
    decision_cluster_id: null,
    suggested_action: "curator_review",
    reason: "Legacy candidate awaiting curator review."
  };
}

function normalizeObservation(observation) {
  if (!observation || typeof observation !== "object" || Array.isArray(observation)) return defaultObservation();
  return {
    value_type: observation.value_type,
    user_emergence_value: observation.user_emergence_value,
    decision_cluster_id: observation.decision_cluster_id ?? null,
    suggested_action: observation.suggested_action,
    reason: observation.reason
  };
}

function validateObservation(observation, prefix = "observation") {
  const errors = [];
  if (!observation || typeof observation !== "object" || Array.isArray(observation)) {
    return [`${prefix}: observation must be an object`];
  }
  if (!VALID_OBSERVATION_VALUE_TYPES.has(observation.value_type)) {
    errors.push(`${prefix}: invalid observation value_type ${observation.value_type}`);
  }
  if (!VALID_USER_EMERGENCE_VALUES.has(observation.user_emergence_value)) {
    errors.push(`${prefix}: invalid observation user_emergence_value ${observation.user_emergence_value}`);
  }
  if (observation.decision_cluster_id !== null && observation.decision_cluster_id !== undefined && !hasText(observation.decision_cluster_id)) {
    errors.push(`${prefix}: invalid observation decision_cluster_id`);
  }
  if (!VALID_OBSERVATION_ACTIONS.has(observation.suggested_action)) {
    errors.push(`${prefix}: invalid observation suggested_action ${observation.suggested_action}`);
  }
  if (!hasText(observation.reason)) errors.push(`${prefix}: missing observation reason`);
  return errors;
}

function validateQuestionCandidates(metadata) {
  const errors = [];
  const warnings = [];
  if (!metadata || typeof metadata !== "object") {
    return { errors: ["missing question_candidates metadata"], warnings, status: "missing", itemCount: 0 };
  }

  if (metadata.status === "none") {
    if (!VALID_NONE_REASONS.has(metadata.none_reason)) {
      errors.push("question_candidates none status needs a valid none_reason");
    }
    if (!hasText(metadata.none_rationale)) {
      errors.push("question_candidates none status needs none_rationale");
    }
    return { errors, warnings, status: "none", itemCount: 0 };
  }

  if (metadata.status !== "submitted") {
    errors.push("question_candidates status must be submitted or none");
    return { errors, warnings, status: String(metadata.status || "invalid"), itemCount: 0 };
  }

  if (!Array.isArray(metadata.items)) {
    errors.push("question_candidates submitted status needs items array");
    return { errors, warnings, status: "submitted", itemCount: 0 };
  }

  if (metadata.items.length > 3) {
    errors.push("question_candidates submitted status allows at most 3 items");
  }
  if (metadata.items.length === 0) {
    warnings.push("submitted question_candidates has 0 items; prefer status none when no useful candidates exist");
  }

  metadata.items.forEach((item, index) => {
    errors.push(...validateCandidateItem(item || {}, index));
  });

  return { errors, warnings, status: "submitted", itemCount: metadata.items.length };
}

function inspectReportQuestionCandidatesFromText(text) {
  const extracted = extractQuestionCandidates(text);
  const validation = validateQuestionCandidates(extracted.metadata);
  const errors = [...extracted.parseErrors.map((error) => `question_candidates JSON parse error: ${error}`), ...validation.errors];
  return {
    present: Boolean(extracted.metadata),
    metadata: extracted.metadata,
    errors,
    warnings: validation.warnings,
    status: validation.status,
    itemCount: validation.itemCount,
    blockCount: extracted.blockCount
  };
}

function inspectReportQuestionCandidates(reportPath) {
  if (!fs.existsSync(reportPath)) {
    return {
      present: false,
      metadata: null,
      errors: [`report not found: ${reportPath}`],
      warnings: [],
      status: "missing",
      itemCount: 0,
      blockCount: 0
    };
  }
  return inspectReportQuestionCandidatesFromText(fs.readFileSync(reportPath, "utf8"));
}

function validateQuestionCandidateInbox(inbox) {
  const errors = [];
  const warnings = [];
  if (!inbox || typeof inbox !== "object") return { errors: ["question candidate inbox is not an object"], warnings };
  if (inbox.version !== 1) errors.push("question candidate inbox version must be 1");
  if (!Array.isArray(inbox.candidates)) errors.push("question candidate inbox needs candidates array");
  (inbox.candidates || []).forEach((candidate, index) => {
    const prefix = candidate?.candidate_id || `candidate ${index + 1}`;
    REQUIRED_INBOX_FIELDS.forEach((field) => {
      if (!hasText(candidate?.[field])) errors.push(`${prefix}: missing ${field}`);
    });
    if (hasText(candidate?.status) && !VALID_CANDIDATE_STATUSES.has(candidate.status)) {
      errors.push(`${prefix}: invalid status ${candidate.status}`);
    }
    errors.push(...validateCandidateItem(candidate || {}, index).map((error) => `${prefix}: ${error}`));
  });
  return { errors, warnings };
}

function defaultQuestionCandidateInbox() {
  return {
    version: 1,
    candidates: [],
    policy: {
      curator_agent_id: "vision-curator",
      wake_triggers: [
        "pending_high_priority_candidate",
        "pending_candidates_gte_5",
        "pending_candidates_age_hours_gte_24",
        "user_requests_question_review",
        "candidate_blocks_acceptance"
      ],
      default_batch_size: 8
    }
  };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function nextCandidateId(candidates, sourceTaskId) {
  const prefix = `QC-${sourceTaskId || "REPORT"}`;
  const max = candidates
    .map((candidate) => String(candidate.candidate_id || "").match(new RegExp(`^${escapeRegExp(prefix)}-(\\d+)$`))?.[1])
    .filter(Boolean)
    .map(Number)
    .reduce((current, value) => Math.max(current, value), 0);
  return `${prefix}-${String(max + 1).padStart(3, "0")}`;
}

function loadQuestionCandidateInbox(rootDir) {
  const inboxPath = path.join(rootDir, ".orquesta", "vision", "question_candidates.json");
  if (!fs.existsSync(inboxPath)) return defaultQuestionCandidateInbox();
  return readJson(inboxPath);
}

function saveQuestionCandidateInbox(rootDir, inbox) {
  const inboxPath = path.join(rootDir, ".orquesta", "vision", "question_candidates.json");
  return writeJsonAtomic(inboxPath, inbox);
}

function appendSubmittedQuestionCandidates(rootDir, metadata, now = new Date().toISOString()) {
  if (!metadata || metadata.status !== "submitted" || !Array.isArray(metadata.items) || metadata.items.length === 0) {
    return { recorded: 0, skipped: 0, candidates: [] };
  }

  const inboxPath = path.join(rootDir, ".orquesta", "vision", "question_candidates.json");
  let outcome = { recorded: 0, skipped: 0, candidates: [] };
  const transaction = updateJsonAtomic(inboxPath, defaultQuestionCandidateInbox(), (current) => {
    const inbox = current && typeof current === "object" ? current : defaultQuestionCandidateInbox();
    inbox.version = inbox.version || 1;
    inbox.candidates = Array.isArray(inbox.candidates) ? inbox.candidates : [];
    const recorded = [];
    let skipped = 0;

    metadata.items.forEach((item) => {
      const duplicate = inbox.candidates.some((candidate) => (
        candidate.source_report_path === item.source_report_path && candidate.question === item.question
      ));
      if (duplicate) {
        skipped += 1;
        return;
      }
      const candidate = {
        candidate_id: nextCandidateId(inbox.candidates, item.source_task_id),
        status: item.observation ? "observation" : "pending_curator_review",
        priority: item.priority,
        category: item.category,
        question: item.question,
        why_now: item.why_now,
        user_impact: item.user_impact,
        suggested_timing: item.suggested_timing,
        source_task_id: item.source_task_id,
        source_agent_id: item.source_agent_id,
        source_report_path: item.source_report_path,
        observation: normalizeObservation(item.observation),
        created_at: now,
        curated_by: null,
        curated_at: null,
        curator_decision: null,
        question_id: null,
        notes: []
      };
      inbox.candidates.push(candidate);
      recorded.push(candidate);
    });

    if (recorded.length) inbox.updated_at = now;
    outcome = { recorded: recorded.length, skipped, candidates: recorded };
    return inbox;
  });

  return { ...outcome, lock: transaction.lock };
}

function main() {
  const args = process.argv.slice(2);
  const reports = [];
  const inboxes = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--inbox") {
      inboxes.push(args[index + 1]);
      index += 1;
    } else {
      reports.push(arg);
    }
  }

  const errors = [];
  reports.forEach((reportPath) => {
    const result = inspectReportQuestionCandidates(path.resolve(reportPath));
    result.warnings.forEach((warning) => console.warn(`question-candidates warning: ${reportPath}: ${warning}`));
    result.errors.forEach((error) => errors.push(`${reportPath}: ${error}`));
    if (!result.errors.length) {
      console.log(`question-candidates ok: ${reportPath} (${result.status}, ${result.itemCount} items)`);
    }
  });

  inboxes.filter(Boolean).forEach((inboxPath) => {
    const result = validateQuestionCandidateInbox(readJson(path.resolve(inboxPath)));
    result.warnings.forEach((warning) => console.warn(`question-candidates inbox warning: ${inboxPath}: ${warning}`));
    result.errors.forEach((error) => errors.push(`${inboxPath}: ${error}`));
    if (!result.errors.length) console.log(`question-candidates inbox ok: ${inboxPath}`);
  });

  if (!reports.length && !inboxes.length) {
    console.log("usage: node orquesta/scripts/report-question-candidates-check.js <report.md> [--inbox .orquesta/vision/question_candidates.json]");
  }

  if (errors.length) {
    errors.forEach((error) => console.error(`question-candidates error: ${error}`));
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  VALID_NONE_REASONS,
  defaultObservation,
  appendSubmittedQuestionCandidates,
  extractQuestionCandidates,
  inspectReportQuestionCandidates,
  inspectReportQuestionCandidatesFromText,
  validateObservation,
  validateQuestionCandidateInbox,
  validateQuestionCandidates
};
