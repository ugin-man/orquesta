"use strict";

const { assertContract, canonicalHash } = require("@orquesta/contracts");
const { canonicalRoleId } = require("./organization-model");

const FOUNDATION = Object.freeze([
  { agent_id: "orchestrator", role_id: "orchestrator", organization_scope: "project", operational_status: "working" },
  { agent_id: "user-support", role_id: "user-support", organization_scope: "project", operational_status: "standby" },
  { agent_id: "orquesta-admin", role_id: "orquesta-admin", organization_scope: "project", operational_status: "working" }
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUnique(values) {
  return [...new Set(values || [])].sort(compareText);
}

function normalizeProjectUnderstanding(input) {
  if (!input || typeof input !== "object" || typeof input.project_id !== "string" || !input.project_id
    || typeof input.goal !== "string" || !input.goal || !Array.isArray(input.deliverables) || !Array.isArray(input.evidence)) {
    throw new TypeError("project understanding requires project_id, goal, deliverables, and evidence");
  }
  return {
    project_id: input.project_id,
    goal: input.goal,
    stage: input.stage || "unknown",
    deliverables: clone(input.deliverables).sort((left, right) => compareText(left.deliverable_id, right.deliverable_id)),
    stack: sortedUnique(input.stack),
    constraints: sortedUnique(input.constraints),
    existing_assets: sortedUnique(input.existing_assets),
    unknowns: sortedUnique(input.unknowns),
    evidence: clone(input.evidence).sort((left, right) => compareText(left.path, right.path)),
    confidence: Number.isFinite(input.confidence) ? input.confidence : 0
  };
}

function selectFirstExecutableBatch(tasks) {
  const values = Array.isArray(tasks) ? tasks : [];
  const completed = new Set(values.filter((task) => task.status === "completed" || task.status === "accepted").map((task) => task.task_id));
  return values
    .filter((task) => task && ["ready", "executable"].includes(task.status)
      && (task.depends_on || []).every((dependency) => completed.has(dependency)))
    .map(clone)
    .sort((left, right) => compareText(left.task_id, right.task_id));
}

function createFoundationPlan() {
  return clone(FOUNDATION);
}

function specialistQuantity(tasks) {
  const slots = [];
  for (const task of tasks) {
    const scope = new Set(task.scope_boundaries || []);
    const collision = slots.find((slot) => [...scope].some((item) => slot.has(item)));
    if (collision) {
      for (const item of scope) collision.add(item);
    } else {
      slots.push(scope);
    }
  }
  return Math.max(1, slots.length);
}

function createAdaptiveSpecialistPlan(input) {
  const understanding = normalizeProjectUnderstanding(input && input.project_understanding);
  const completion = input && input.completion_map;
  if (!completion || !Number.isInteger(completion.revision) || !Array.isArray(completion.tasks)) {
    throw new TypeError("adaptive setup requires a revisioned Completion Map");
  }
  const firstBatch = selectFirstExecutableBatch(completion.tasks);
  const roles = Array.isArray(input.role_definitions) ? input.role_definitions : [];
  const missing = firstBatch.find((task) => !canonicalRoleId({ requestedRole: task.role_id, roles }));
  if (missing || firstBatch.length === 0) {
    return {
      status: "blocked_unknown",
      foundation_agents: createFoundationPlan(),
      specialist_plan: null,
      user_capability: {
        capability_id: "organization.clarification",
        task_id: missing ? missing.task_id : null,
        reason: "first executable work does not have a known role"
      }
    };
  }
  const groups = new Map();
  for (const task of firstBatch) {
    const role_id = canonicalRoleId({ requestedRole: task.role_id, roles });
    const line_id = task.line_id || null;
    const team_id = task.team_id || `${role_id}-team`;
    const key = `${role_id}\u0000${line_id}\u0000${team_id}`;
    const group = groups.get(key) || { role_id, line_id, team_id, tasks: [] };
    group.tasks.push(task);
    groups.set(key, group);
  }
  const selected_specialists = [...groups.values()]
    .sort((left, right) => compareText(left.role_id, right.role_id) || compareText(String(left.line_id), String(right.line_id)) || compareText(left.team_id, right.team_id))
    .map((group) => ({
      role_id: group.role_id,
      quantity: specialistQuantity(group.tasks),
      line_id: group.line_id,
      team_id: group.team_id,
      reason_codes: ["CAPABILITY_MATCH"],
      task_ids: group.tasks.map((task) => task.task_id).sort(compareText)
    }));
  const future = new Map();
  for (const task of completion.tasks.filter((task) => !["ready", "executable", "completed", "accepted"].includes(task.status))) {
    const role_id = canonicalRoleId({ requestedRole: task.role_id, roles });
    if (role_id && !future.has(role_id)) future.set(role_id, { role_id, activation_condition: task.activation_condition || `${task.task_id} becomes executable` });
  }
  const plan = {
    schema_version: 2,
    source_understanding_hash: canonicalHash(understanding),
    source_completion_map_revision: completion.revision,
    first_executable_batch: firstBatch.map((task) => task.task_id),
    selected_specialists,
    future_candidates: [...future.values()].sort((left, right) => compareText(left.role_id, right.role_id)),
    approval_source: input.approval_source || "setup_confirmation"
  };
  assertContract("specialist-plan-v2", plan);
  return plan;
}

module.exports = {
  FOUNDATION,
  normalizeProjectUnderstanding,
  selectFirstExecutableBatch,
  createFoundationPlan,
  createAdaptiveSpecialistPlan
};
