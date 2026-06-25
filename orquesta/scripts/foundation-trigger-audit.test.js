#!/usr/bin/env node

"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { buildAudit } = require("./foundation-trigger-audit");

const NOW = new Date("2026-06-25T12:00:00.000Z");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeBaseState(root, candidates) {
  writeJson(path.join(root, ".orquesta", "state", "agents.json"), {
    version: 1,
    agents: [
      {
        agent_id: "vision-curator",
        role: "vision-curator",
        status: "standby",
        last_heartbeat: NOW.toISOString()
      }
    ]
  });
  writeJson(path.join(root, ".orquesta", "state", "sessions.json"), {
    version: 1,
    synced_at: NOW.toISOString(),
    sessions: []
  });
  writeJson(path.join(root, ".orquesta", "state", "tasks.json"), { version: 1, tasks: [] });
  writeJson(path.join(root, ".orquesta", "vision", "questions.json"), { version: 1, questions: [] });
  writeJson(path.join(root, ".orquesta", "vision", "answers.json"), { version: 1, answer_batches: [] });
  writeJson(path.join(root, ".orquesta", "vision", "question_candidates.json"), {
    version: 1,
    candidates,
    policy: {
      pending_candidates_gte: 5,
      pending_candidates_age_hours_gte: 24
    }
  });
  writeJson(path.join(root, ".orquesta", "failures", "incidents.json"), { version: 1, incidents: [] });
  writeJson(path.join(root, ".orquesta", "failures", "user_actions.json"), { version: 1, actions: [] });
  writeJson(path.join(root, ".orquesta", "user_tasks", "queue.json"), { version: 1, tasks: [] });
  writeJson(path.join(root, ".orquesta", "setup", "options.json"), { version: 1, setup_status: "ready" });
  writeJson(path.join(root, ".orquesta", "setup", "wizard.json"), { version: 1, status: "ready_for_operation" });
  writeJson(path.join(root, ".orquesta", "setup", "specialist_plan.json"), { version: 1, candidates: [] });
  writeJson(path.join(root, ".orquesta", "setup", "production_start.json"), { version: 1, activation_requests: [] });
}

function candidate(id, overrides = {}) {
  return {
    candidate_id: id,
    status: "pending_curator_review",
    priority: "medium",
    category: "workflow",
    question: `Raw candidate text ${id}`,
    why_now: "test",
    user_impact: "test",
    suggested_timing: "batch_later",
    source_task_id: "T999",
    source_agent_id: "implementation-001",
    source_report_path: ".orquesta/reports/T999.md",
    created_at: "2026-06-25T11:00:00.000Z",
    ...overrides
  };
}

function runCase(candidates) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-trigger-audit-"));
  try {
    writeBaseState(root, candidates);
    const audit = buildAudit(root, NOW);
    return audit.foundation_agents.find((agent) => agent.agent_id === "vision-curator");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

{
  const curator = runCase([candidate("QC-HIGH", { priority: "high" })]);
  assert.strictEqual(curator.trigger_status, "trigger_ready");
  assert(curator.reason_codes.includes("pending_high_priority_question_candidate"));
  assert.strictEqual(curator.recommended_action, "wake_vision_curator_for_question_candidate_batch_or_record_deferred_wake_reason");
}

{
  const curator = runCase(["1", "2", "3", "4", "5"].map((id) => candidate(`QC-${id}`)));
  assert.strictEqual(curator.trigger_status, "trigger_ready");
  assert(curator.reason_codes.includes("pending_question_candidates_threshold_met"));
  assert.strictEqual(curator.evidence.find((item) => item.type === "question_candidate_wake_summary").pending_count, 5);
}

{
  const curator = runCase([candidate("QC-OLD", { created_at: "2026-06-24T11:00:00.000Z" })]);
  assert.strictEqual(curator.trigger_status, "trigger_ready");
  assert(curator.reason_codes.includes("stale_pending_question_candidate"));
}

{
  const curator = runCase([candidate("QC-BLOCK", { suggested_timing: "before_acceptance" })]);
  assert.strictEqual(curator.trigger_status, "wake_needed");
  assert.strictEqual(curator.wake_required, true);
  assert(curator.reason_codes.includes("question_candidate_blocks_acceptance"));
  assert.strictEqual(curator.recommended_action, "hold_affected_acceptance_and_wake_vision_curator_for_blocking_question_candidate");
}

{
  const curator = runCase([
    candidate("QC-LOW", { priority: "low" }),
    candidate("QC-DONE", { status: "promoted_to_question", priority: "high", suggested_timing: "before_acceptance" })
  ]);
  assert.strictEqual(curator.trigger_status, "clear");
  assert.deepStrictEqual(curator.reason_codes, []);
  assert.strictEqual(curator.recommended_action, "no_wake_required_batch_candidates_until_threshold_or_user_request");
  const summary = curator.evidence.find((item) => item.type === "question_candidate_wake_summary");
  assert.strictEqual(summary.pending_count, 1);
  const excerpt = curator.evidence.find((item) => item.type === "question_candidate");
  assert(!Object.prototype.hasOwnProperty.call(excerpt, "question"));
}

console.log("foundation trigger audit tests passed");
