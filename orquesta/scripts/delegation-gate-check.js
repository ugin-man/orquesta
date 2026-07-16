#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const crypto = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");

const REVIEW_STATES = new Set([
  "active",
  "completed",
  "report_submitted",
  "needs_review",
  "needs_orchestrator_review",
  "accepted"
]);

const SPECIALIST_HINTS = [
  "dashboard",
  "visualizer",
  "ui",
  "readme",
  "docs",
  "documentation",
  "protocol",
  "schema",
  "bootstrap",
  "setup",
  "implementation",
  "server",
  "script",
  "encoding",
  "github"
];

const PHASE15_BUDGETS = Object.freeze({
  fast: Object.freeze({ max_handoffs: 0, max_independent_reviews: 0, max_correction_batches: 1, max_reports: 0, max_auxiliary_tasks: 0 }),
  standard: Object.freeze({ max_handoffs: 2, max_independent_reviews: 1, max_correction_batches: 1, max_reports: 1, max_auxiliary_tasks: 0 }),
  critical: Object.freeze({ max_handoffs: 4, max_independent_reviews: 2, max_correction_batches: 2, max_reports: 2, max_auxiliary_tasks: 0 })
});

const PHASE15_METRICS = Object.freeze({
  handoffs: "max_handoffs",
  independent_reviews: "max_independent_reviews",
  correction_batches: "max_correction_batches",
  reports: "max_reports"
});

const EXECUTION_PLAN_FIELDS = Object.freeze([
  "execution_plan_id",
  "task_intent_id",
  "policy_version",
  "lane",
  "risk_profile",
  "reason_codes",
  "routing",
  "budget",
  "review_policy",
  "escalation_triggers",
  "revision",
  "supersedes_execution_plan_id"
]);

const EXECUTION_PLAN_EFFECTS = new Set([
  "local_read",
  "workspace_write",
  "dependency_change",
  "network_access",
  "external_write",
  "public_release",
  "credential_access",
  "payment",
  "destructive_operation",
  "data_migration",
  "security_boundary"
]);

const EXECUTION_PLAN_TRIGGERS = new Set([
  "acceptance_uncertain",
  "budget_exhausted",
  "critical_risk_discovered",
  "new_risk",
  "scope_drift",
  "semantic_finding_not_machine_verifiable",
  "test_failure"
]);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactFields(value, fields) {
  return isPlainObject(value)
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.hasOwn(value, field));
}

function canonicalNormalize(value, stack = new Set()) {
  if (value === undefined) throw new TypeError("canonical JSON does not allow undefined");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON requires finite numbers");
    return value;
  }
  if (typeof value !== "object") throw new TypeError(`canonical JSON does not allow ${typeof value}`);
  if (stack.has(value)) throw new TypeError("canonical JSON does not allow circular references");
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError("canonical JSON does not allow symbol-keyed objects");
  }

  stack.add(value);
  try {
    if (Array.isArray(value)) {
      for (const key of Object.getOwnPropertyNames(value)) {
        if (key === "length") continue;
        const index = Number(key);
        if (!Number.isInteger(index) || index < 0 || index >= value.length || String(index) !== key) {
          throw new TypeError("canonical JSON does not allow non-index array properties");
        }
      }
      const normalized = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw new TypeError("canonical JSON does not allow sparse arrays");
        normalized.push(canonicalNormalize(value[index], stack));
      }
      return normalized;
    }

    if (!isPlainObject(value)) throw new TypeError("canonical JSON only allows plain objects");
    const normalized = Object.create(null);
    for (const key of Object.keys(value).sort()) normalized[key] = canonicalNormalize(value[key], stack);
    return normalized;
  } finally {
    stack.delete(value);
  }
}

function canonicalHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalNormalize(value)), "utf8").digest("hex");
}

function sortedUniqueStrings(values) {
  return Array.isArray(values) && values.every((value, index) => (
    typeof value === "string" && (index === 0 || values[index - 1] < value)
 ));
}

function validExecutionPlan(plan) {
  if (!hasExactFields(plan, EXECUTION_PLAN_FIELDS)
    || !/^EP-[a-f0-9]{12}$/.test(plan.execution_plan_id)
    || !/^TI-[a-f0-9]{12}$/.test(plan.task_intent_id)
    || plan.policy_version !== 1
    || !Object.hasOwn(PHASE15_BUDGETS, plan.lane)
    || !Number.isInteger(plan.revision) || plan.revision < 1
    || (plan.supersedes_execution_plan_id !== null && !/^EP-[a-f0-9]{12}$/.test(plan.supersedes_execution_plan_id))
    || !Array.isArray(plan.reason_codes) || !plan.reason_codes.every((value) => typeof value === "string" && value.length > 0)
    || !sortedUniqueStrings(plan.reason_codes)
    || !Array.isArray(plan.escalation_triggers) || !plan.escalation_triggers.every((value) => EXECUTION_PLAN_TRIGGERS.has(value))
    || !sortedUniqueStrings(plan.escalation_triggers)) return false;

  const risk = plan.risk_profile;
  if (!hasExactFields(risk, ["reversibility", "scope", "verification", "uncertainty", "effects", "repeated_failures", "user_review"])
    || !["easy", "costly", "irreversible"].includes(risk.reversibility)
    || !["single_boundary", "multiple_boundaries"].includes(risk.scope)
    || !["deterministic", "mixed", "human_only"].includes(risk.verification)
    || !["low", "medium", "high"].includes(risk.uncertainty)
    || !Array.isArray(risk.effects) || risk.effects.length === 0 || !risk.effects.every((value) => EXECUTION_PLAN_EFFECTS.has(value))
    || !sortedUniqueStrings(risk.effects)
    || !Number.isInteger(risk.repeated_failures) || risk.repeated_failures < 0
    || !["default", "strict"].includes(risk.user_review)) return false;

  const routing = plan.routing;
  const budget = plan.budget;
  const expectedRouting = plan.lane === "fast"
    ? { routing_class: "inline_verified", handoff_required: false, specialist_report_required: false }
    : { routing_class: "specialist_required", handoff_required: true, specialist_report_required: true };
  const expectedReview = plan.lane === "fast" ? "none"
    : plan.lane === "standard" ? "independent_once" : "independent_twice";
  return hasExactFields(routing, ["routing_class", "handoff_required", "specialist_report_required"])
    && ["inline_verified", "specialist_required"].includes(routing.routing_class)
    && typeof routing.handoff_required === "boolean"
    && typeof routing.specialist_report_required === "boolean"
    && isDeepStrictEqual(routing, expectedRouting)
    && hasExactFields(budget, ["max_handoffs", "max_independent_reviews", "max_correction_batches", "max_reports", "max_auxiliary_tasks"])
    && Object.values(budget).every((value) => Number.isInteger(value) && value >= 0)
    && isDeepStrictEqual(budget, PHASE15_BUDGETS[plan.lane])
    && ["none", "independent_once", "independent_twice"].includes(plan.review_policy)
    && plan.review_policy === expectedReview;
}

function assertExecutionPlanContract(plan) {
  if (!validExecutionPlan(plan)) throw new TypeError("execution-plan contract validation failed");
  return plan;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function hasReportArtifact(task) {
  if (task.specialist_report_path || task.report) return true;
  return (task.artifacts || []).some((artifact) => {
    const value = String(artifact || "").toLowerCase();
    return value.includes(".orquesta/reports/") || value.includes("\\.orquesta\\reports\\");
  });
}

function looksLikeSpecialistDomain(task) {
  const text = [
    task.title,
    task.result_summary,
    ...(task.artifacts || [])
  ].join(" ").toLowerCase();
  return SPECIALIST_HINTS.some((hint) => text.includes(hint));
}

function checkTask(task, options = {}) {
  if (Object.hasOwn(task, "execution_policy_version")) {
    if (task.execution_policy_version === 1) return checkTaskPhase15(task, options);
    return { errors: [taskError(task, "unsupported execution_policy_version")], warnings: [] };
  }
  const errors = [];
  const warnings = [];
  const id = task.task_id || "(unknown task)";
  const stateNeedsGate = REVIEW_STATES.has(task.state);

  if (task.routing_class === "specialist_required" && stateNeedsGate) {
    if (task.handoff_required !== false && !task.handoff_sent_at) {
      errors.push(`${id}: specialist_required task is ${task.state} but has no handoff_sent_at`);
    }

    if (task.state === "accepted" && task.specialist_report_required !== false && !hasReportArtifact(task)) {
      errors.push(`${id}: specialist_required task is accepted but has no specialist report path or report artifact`);
    }

    if (task.routing_gate_status === "passed" && !task.handoff_sent_at) {
      errors.push(`${id}: routing_gate_status is passed but handoff_sent_at is missing`);
    }
  }

  if (task.routing_class === "direct_exception" && stateNeedsGate) {
    if (!task.direct_exception_reason) {
      errors.push(`${id}: direct_exception task is ${task.state} but has no direct_exception_reason`);
    }
    if (task.routing_gate_status !== "bypassed_with_reason") {
      errors.push(`${id}: direct_exception task must use routing_gate_status=bypassed_with_reason`);
    }
  }

  if (!task.routing_class && task.owner_agent_id === "orchestrator" && stateNeedsGate && looksLikeSpecialistDomain(task)) {
    warnings.push(`${id}: orchestrator-owned ${task.state} task looks like specialist-domain work; add routing_class or direct_exception on future tasks`);
  }

  return { errors, warnings };
}

function taskError(task, message) {
  return `${task.task_id || "(unknown task)"}: ${message}`;
}

function integer(value) {
  return Number.isInteger(value) && value >= 0;
}

function nonemptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function uniqueStrings(values) {
  return Array.isArray(values) && values.length > 0
    && values.every((value) => nonemptyString(value))
    && new Set(values).size === values.length;
}

function planIntegrityMatches(plan) {
  const content = { ...plan };
  delete content.execution_plan_id;
  return plan.execution_plan_id === `EP-${canonicalHash(content).slice(0, 12)}`;
}

function sameStateRoot(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function tokenUsageErrors(task, token) {
  if (!token || typeof token !== "object" || !["unknown", "partial", "complete"].includes(token.coverage) || !Array.isArray(token.by_thread)) {
    return [taskError(task, "execution_metrics.token_usage is invalid")];
  }
  if (token.coverage === "unknown") {
    return token.known_total === null && token.by_thread.length === 0
      && (!Object.hasOwn(token, "participating_thread_ids") || (Array.isArray(token.participating_thread_ids) && token.participating_thread_ids.length === 0))
      ? []
      : [taskError(task, "token_usage unknown coverage requires known_total null and empty by_thread")];
  }
  if (!Number.isFinite(token.known_total) || token.known_total < 0 || token.by_thread.length === 0) {
    return [taskError(task, "token_usage partial or complete coverage requires known_total and by_thread evidence")];
  }
  const entriesValid = token.by_thread.every((entry) => entry && typeof entry === "object"
    && nonemptyString(entry.thread_id) && Number.isFinite(entry.measured_tokens) && entry.measured_tokens >= 0
    && nonemptyString(entry.evidence_source));
  const threadIds = token.by_thread.map((entry) => entry && entry.thread_id);
  if (!entriesValid || new Set(threadIds).size !== threadIds.length) {
    return [taskError(task, "token_usage requires unique thread_id, measured_tokens, and evidence_source entries")];
  }
  const measuredTotal = token.by_thread.reduce((total, entry) => total + entry.measured_tokens, 0);
  if (measuredTotal !== token.known_total) {
    return [taskError(task, "token_usage known_total must equal measured per-thread tokens")];
  }
  if (token.coverage === "complete") {
    if (!uniqueStrings(token.participating_thread_ids) || token.participating_thread_ids.length !== threadIds.length
      || token.participating_thread_ids.some((threadId) => !threadIds.includes(threadId))) {
      return [taskError(task, "token_usage complete coverage requires matching participating_thread_ids")];
    }
  }
  return [];
}

function checkTaskPhase15(task, { stateRoot = null } = {}) {
  const errors = [];
  const warnings = [];
  const plan = task.execution_plan;
  const accepted = task.state === "accepted";
  if (!plan || typeof plan !== "object" || !PHASE15_BUDGETS[plan.lane]) {
    errors.push(taskError(task, "Phase 1.5 task requires a known execution plan lane"));
    return { errors, warnings };
  }
  try {
    assertExecutionPlanContract(plan);
  } catch {
    errors.push(taskError(task, "execution_plan contract is invalid"));
    return { errors, warnings };
  }
  if (!planIntegrityMatches(plan)) {
    errors.push(taskError(task, "execution_plan integrity does not match its canonical identifier"));
  }
  if (stateRoot && (!nonemptyString(task.canonical_state_root) || !sameStateRoot(task.canonical_state_root, stateRoot))) {
    errors.push(taskError(task, "canonical_state_root must match the resolved state root"));
  }
  if (!isDeepStrictEqual(plan.budget, PHASE15_BUDGETS[plan.lane])) {
    errors.push(taskError(task, "execution_plan budget must match the Phase 1.5 lane budget"));
  }
  const fast = plan.lane === "fast";
  if (task.routing_class !== (fast ? "inline_verified" : "specialist_required")) {
    errors.push(taskError(task, `${plan.lane} lane uses the wrong routing_class`));
  }
  if (task.handoff_required !== plan.routing.handoff_required) {
    errors.push(taskError(task, "handoff_required must match execution_plan.routing"));
  }
  if (task.specialist_report_required !== plan.routing.specialist_report_required) {
    errors.push(taskError(task, "specialist_report_required must match execution_plan.routing"));
  }
  const attempts = Array.isArray(task.handoff_attempts) ? task.handoff_attempts : null;
  const cycles = Array.isArray(task.execution_cycles) ? task.execution_cycles : null;
  if (!attempts || !cycles) {
    errors.push(taskError(task, "Phase 1.5 task requires handoff_attempts and execution_cycles"));
    return { errors, warnings };
  }
  const counts = {
    handoffs: attempts.length,
    independent_reviews: cycles.filter((cycle) => cycle && cycle.kind === "review").length,
    correction_batches: cycles.filter((cycle) => cycle && cycle.kind === "correction").length,
    reports: cycles.filter((cycle) => cycle && ["review", "qa"].includes(cycle.kind) && Array.isArray(cycle.evidence_refs) && cycle.evidence_refs.length > 0).length
  };
  if (fast && (counts.handoffs > 0 || counts.independent_reviews > 0 || counts.reports > 0)) {
    errors.push(taskError(task, "fast lane cannot record handoff or review evidence"));
  }
  const metrics = task.execution_metrics;
  if (!metrics || typeof metrics !== "object") {
    errors.push(taskError(task, "Phase 1.5 task requires execution_metrics"));
  } else {
    if (!integer(metrics.wall_time_ms) || !integer(metrics.agent_turns)) {
      errors.push(taskError(task, "execution_metrics wall_time_ms and agent_turns must be non-negative integers"));
    }
    for (const [metric, budgetField] of Object.entries(PHASE15_METRICS)) {
      if (!integer(metrics[metric])) {
        errors.push(taskError(task, `execution_metrics.${metric} must be a non-negative integer`));
      } else {
        if (metrics[metric] !== counts[metric]) {
          errors.push(taskError(task, `execution_metrics.${metric} must match recorded cycles and handoffs`));
        }
        if (metrics[metric] > plan.budget[budgetField]) {
          errors.push(taskError(task, `execution_metrics.${metric} exceeds ${budgetField}`));
        }
      }
    }
    errors.push(...tokenUsageErrors(task, metrics.token_usage));
  }
  if (accepted) {
    const completionEvidence = task.completion_evidence;
    if (!Array.isArray(completionEvidence) || completionEvidence.length === 0 || completionEvidence.some((evidence) => !evidence || evidence.status !== "passed")) {
      errors.push(taskError(task, "accepted Phase 1.5 task requires all completion evidence to be passed"));
    }
    if (!Array.isArray(completionEvidence) || !completionEvidence.some((evidence) => evidence && evidence.kind === "implementation" && evidence.status === "passed")) {
      errors.push(taskError(task, "accepted Phase 1.5 task requires implementation completion evidence"));
    }
    const implementation = cycles.find((cycle) => cycle && cycle.kind === "implementation" && cycle.status === "completed"
      && Array.isArray(cycle.evidence_refs) && cycle.evidence_refs.length > 0);
    if (!implementation) {
      errors.push(taskError(task, "accepted Phase 1.5 task requires a completed implementation cycle with evidence"));
    }
    if (!fast) {
      const acceptedReview = cycles.find((cycle) => cycle && cycle.kind === "review" && cycle.status === "accepted"
        && cycle.findings && cycle.findings.critical === 0 && cycle.findings.important === 0
        && Array.isArray(cycle.evidence_refs) && cycle.evidence_refs.length > 0);
      if (!acceptedReview) errors.push(taskError(task, "accepted standard or critical task requires independent accepted review evidence with zero Critical and Important findings"));
      else {
        if (!implementation || acceptedReview.owner_agent_id === implementation.owner_agent_id) {
          errors.push(taskError(task, "accepted task requires an independent review owner"));
        }
        const reviewHandoff = attempts.find((attempt) => attempt && attempt.cycle_id === acceptedReview.cycle_id
          && attempt.owner_agent_id === acceptedReview.owner_agent_id && nonemptyString(attempt.sent_at));
        if (!reviewHandoff) errors.push(taskError(task, "accepted review requires a handoff bound to the review cycle"));
        if (!nonemptyString(task.specialist_report_path) || !acceptedReview.evidence_refs.includes(task.specialist_report_path)) {
          errors.push(taskError(task, "accepted review report must be bound to the review cycle"));
        }
      }
      if (!nonemptyString(task.handoff_sent_at)) {
        errors.push(taskError(task, "accepted standard or critical task requires handoff_sent_at"));
      }
    }
    if (plan.lane === "critical") {
      const approval = task.user_approval_evidence;
      if (!approval || typeof approval !== "object" || approval.status !== "approved"
        || !nonemptyString(approval.source) || !nonemptyString(approval.scope)) {
        errors.push(taskError(task, "accepted critical task requires approved user_approval_evidence"));
      }
    }
  }
  return { errors, warnings };
}

function explicitStateRoot(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--state-root") {
      if (typeof argv[index + 1] !== "string" || !argv[index + 1]) throw new Error("--state-root requires a path");
      return argv[index + 1];
    }
    if (typeof argv[index] === "string" && argv[index].startsWith("--state-root=")) {
      const value = argv[index].slice("--state-root=".length);
      if (!value) throw new Error("--state-root requires a path");
      return value;
    }
  }
  return null;
}

function resolveStateRoot({ argv = process.argv.slice(2), env = process.env, cwd = process.cwd() } = {}) {
  const root = explicitStateRoot(argv) || env.ORQUESTA_STATE_ROOT || cwd;
  const resolved = path.resolve(root);
  if (!fs.existsSync(path.join(resolved, ".orquesta", "state", "tasks.json"))) {
    throw new Error(`No tasks.json found at ${path.join(resolved, ".orquesta", "state", "tasks.json")}`);
  }
  return resolved;
}

function checkDelegationGate(rootDir) {
  const tasksPath = path.join(rootDir, ".orquesta", "state", "tasks.json");
  if (!fs.existsSync(tasksPath)) {
    return { errors: [], warnings: [`No tasks.json found at ${tasksPath}; delegation gate skipped.`] };
  }

  const state = readJson(tasksPath);
  const tasks = Array.isArray(state.tasks) ? state.tasks : [];
  const result = { errors: [], warnings: [] };

  const phase15TaskIds = new Set(tasks.filter((task) => task && task.execution_policy_version === 1).map((task) => task.task_id));
  for (const task of tasks) {
    if (task && phase15TaskIds.has(task.execution_parent_task_id)) {
      result.errors.push(`${task.task_id || "(unknown task)"}: append an execution_cycle to Phase 1.5 parent ${task.execution_parent_task_id} instead of creating an auxiliary task`);
    }
    const taskResult = checkTask(task, { stateRoot: rootDir });
    result.errors.push(...taskResult.errors);
    result.warnings.push(...taskResult.warnings);
  }

  return result;
}

function main() {
  let rootDir;
  try {
    rootDir = resolveStateRoot();
  } catch (error) {
    console.error(`delegation error: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  const result = checkDelegationGate(rootDir);

  for (const warning of result.warnings) {
    console.warn(`delegation warning: ${warning}`);
  }

  if (result.errors.length > 0) {
    for (const error of result.errors) {
      console.error(`delegation error: ${error}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("delegation gate check passed");
}

if (require.main === module) {
  main();
}

module.exports = {
  checkDelegationGate,
  checkTask,
  checkTaskPhase15,
  hasReportArtifact,
  looksLikeSpecialistDomain,
  PHASE15_BUDGETS,
  resolveStateRoot
};
