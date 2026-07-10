#!/usr/bin/env node

"use strict";

const fs = require("fs");
const { evaluateCapacityGate } = require("./capacity-gate");
const { readJsonFile, updateJsonAtomic, writeJsonAtomic } = require("./json-state");

const SIGNAL_LEVELS = new Set(["low", "medium", "high"]);
const ESCALATION_REASONS = new Set([
  "failed_check",
  "low_confidence",
  "repeated_failure",
  "broad_cross_module_consequence",
  "unresolved_judgment"
]);

function defaultModelPolicy() {
  return {
    version: 1,
    signals: [
      "ambiguity",
      "consequence",
      "reversibility",
      "context_breadth",
      "aesthetic_judgment",
      "verifiability",
      "novelty",
      "failure_history"
    ],
    rules: [
      {
        rule_id: "MP001",
        match: { work_modes: ["deterministic_triage"] },
        recommend: "Luna",
        reason: "Deterministic triage starts with Luna."
      },
      {
        rule_id: "MP002",
        match: { work_modes: ["semantic_decision", "orchestration"] },
        recommend: "Sol",
        reason: "Semantic decisions and orchestration require Sol judgment."
      },
      {
        rule_id: "MP003",
        match: { default: true },
        recommend: "Terra",
        reason: "Normal implementation starts with Terra."
      },
      {
        rule_id: "MP004",
        if_any_high: ["ambiguity", "consequence", "reversibility", "context_breadth", "failure_history"],
        action: "require_semantic_review",
        review_model: "Sol",
        reason: "High consequence signal requires a separate Sol review."
      }
    ],
    budget: {
      default_start: "Terra",
      max_concurrent_specialist_turns: 2,
      max_concurrent_turns_per_dependency_chain: 1,
      max_escalations_per_task: 1,
      max_semantic_review_rounds: 1,
      require_reason_for_sol: true,
      record_reason_when_not_escalating: true,
      prefer_file_backed_briefs: true,
      handoff_mode: "delta_plus_artifact_paths",
      thread_poll_backoff_seconds: [60, 120, 240]
    },
    capacity_policy: {
      same_target_prestart_retry_limit: 2
    },
    adapters: {
      repository_only: {
        can_switch_model: false,
        records_recommendation: true
      }
    }
  };
}

function normalizeLevel(value) {
  const level = String(value || "low").toLowerCase();
  return SIGNAL_LEVELS.has(level) ? level : "low";
}

function normalizeModelPolicy(input = {}) {
  const defaults = defaultModelPolicy();
  return {
    ...defaults,
    ...input,
    signals: Array.isArray(input.signals) && input.signals.length ? [...input.signals] : [...defaults.signals],
    rules: Array.isArray(input.rules) && input.rules.length ? input.rules.map((rule) => ({ ...rule })) : defaults.rules.map((rule) => ({ ...rule })),
    budget: { ...defaults.budget, ...(input.budget || {}) },
    capacity_policy: { ...defaults.capacity_policy, ...(input.capacity_policy || {}) },
    adapters: { ...defaults.adapters, ...(input.adapters || {}) }
  };
}

function scoreControlSignals(task = {}, context = {}, policyInput = defaultModelPolicy()) {
  const policy = normalizeModelPolicy(policyInput);
  const source = { ...(task.control_signals || {}), ...(context.control_signals || {}) };
  const signals = {};
  for (const name of policy.signals) signals[name] = normalizeLevel(source[name]);
  const high = Object.entries(signals).filter(([, level]) => level === "high").map(([name]) => name);
  const medium = Object.entries(signals).filter(([, level]) => level === "medium").map(([name]) => name);
  return {
    signals,
    high_signals: high,
    medium_signals: medium,
    risk_level: high.length ? "high" : medium.length ? "medium" : "low"
  };
}

function repositoryOnlyAdapter() {
  return {
    adapter_id: "repository_only",
    capabilities: {
      thread_message_dispatch: false,
      thread_model_override: false,
      tool_event_stream: false,
      thread_state_read: false
    },
    action_status: "unsupported"
  };
}

function policyRule(policy, ruleId) {
  return policy.rules.find((rule) => rule.rule_id === ruleId) || null;
}

function matchingWorkModeRule(policy, workMode) {
  return policy.rules.find((rule) => Array.isArray(rule.match?.work_modes) && rule.match.work_modes.includes(workMode))
    || policy.rules.find((rule) => rule.match?.default)
    || null;
}

function activeTurnScheduling(task, policy, activeTurns = []) {
  const turns = Array.isArray(activeTurns) ? activeTurns.filter(Boolean) : [];
  const budget = policy.budget || defaultModelPolicy().budget;
  if (turns.length >= Number(budget.max_concurrent_specialist_turns || 2)) {
    return { allowed: false, reason_code: "specialist_turn_limit_reached" };
  }
  const chain = task.dependency_chain || task.token_policy?.parallel_group || null;
  if (chain && turns.some((turn) => (turn.dependency_chain || turn.token_policy?.parallel_group) === chain)) {
    return { allowed: false, reason_code: "dependency_chain_busy" };
  }
  return { allowed: true, reason_code: null };
}

function capacityRoute(task, context = {}) {
  if (!context.capacity || !context.target) return { allowed: true, reason_codes: [] };
  const gate = evaluateCapacityGate({
    task,
    target: context.target,
    ledger: context.capacity,
    now: context.now || new Date().toISOString()
  });
  return {
    allowed: gate.allowed,
    reason_codes: (gate.blockers || []).map((blocker) => blocker.code),
    evidence: gate.capacity || null
  };
}

function baseRoute(task, policy, score, context) {
  const workMode = context.work_mode || "implementation";
  const high = new Set(score.high_signals);
  const reviewRule = policyRule(policy, "MP004");
  const reviewSignals = reviewRule?.if_any_high || ["ambiguity", "consequence", "reversibility", "context_breadth", "failure_history"];
  const requiresSemanticReview = reviewSignals.some((signal) => high.has(signal));
  const selectedRule = matchingWorkModeRule(policy, workMode);
  const directSemanticDecision = workMode === "semantic_decision" || workMode === "orchestration";
  const recommendedModel = directSemanticDecision ? "Sol" : selectedRule?.recommend || policy.budget.default_start;
  const reasonCodes = selectedRule ? [`policy_rule_${selectedRule.rule_id}`] : ["policy_rule_missing_default_start"];
  for (const signal of score.high_signals) reasonCodes.push(`high_${signal}`);
  if (requiresSemanticReview && recommendedModel !== "Sol") reasonCodes.push("high_consequence_requires_semantic_review");
  if (directSemanticDecision && recommendedModel !== "Sol") reasonCodes.push("semantic_policy_non_sol_override");
  return {
    status: "proposed",
    recommended_model: recommendedModel,
    required_review_model: requiresSemanticReview && recommendedModel !== "Sol" ? reviewRule?.review_model || "Sol" : null,
    requires_semantic_review: requiresSemanticReview,
    reason_codes: reasonCodes,
    reason: selectedRule?.reason || "Policy default route.",
    signals: score.signals,
    work_mode: workMode,
    escalation_history: []
  };
}

function recommendModelRoute(task = {}, policyInput = defaultModelPolicy(), context = {}) {
  const policy = normalizeModelPolicy(policyInput);
  const score = scoreControlSignals(task, context, policy);
  const adapter = repositoryOnlyAdapter();
  const requestedModel = context.requested_model ?? task.model_route?.requested_model ?? null;
  const actualModel = task.model_route?.actual_model ?? null;
  const route = {
    ...baseRoute(task, policy, score, context),
    requested_model: requestedModel,
    requested_model_evidence: requestedModel ? context.requested_model_evidence || "Task state records a requested model." : null,
    applied_model: null,
    applied_model_evidence: null,
    actual_model: actualModel,
    actual_model_evidence: actualModel ? task.model_route?.actual_model_evidence || null : null,
    adapter: adapter.adapter_id,
    adapter_id: adapter.adapter_id,
    adapter_status: adapter.action_status,
    adapter_capabilities: adapter.capabilities,
    handoff: {
      mode: policy.budget.handoff_mode,
      prefer_file_backed_briefs: Boolean(policy.budget.prefer_file_backed_briefs),
      poll_backoff_seconds: [...policy.budget.thread_poll_backoff_seconds]
    },
    warnings: []
  };

  const capacity = capacityRoute(task, context);
  if (!capacity.allowed) {
    route.status = "unavailable";
    route.recommended_model = null;
    route.required_review_model = null;
    route.requires_semantic_review = false;
    route.reason_codes = [...route.reason_codes, ...capacity.reason_codes];
    route.reason = "Target capacity is unavailable; no model route is proposed.";
    route.capacity_evidence = capacity.evidence;
    return route;
  }

  const scheduling = activeTurnScheduling(task, policy, context.active_turns);
  if (!scheduling.allowed) {
    route.status = "deferred";
    route.reason_codes.push(scheduling.reason_code);
    route.reason = "Model route is deferred until the specialist scheduling limit allows another turn.";
    return route;
  }

  const history = Array.isArray(context.escalation_history) ? context.escalation_history : [];
  const escalation = context.escalation;
  if (escalation) {
    if (history.length >= Number(policy.budget.max_escalations_per_task)) {
      route.status = "deferred";
      route.reason_codes.push("escalation_limit_reached");
      route.reason = "A further Sol escalation needs explicit review after the bounded escalation limit.";
      route.escalation_history = history;
      return route;
    }
    if (!ESCALATION_REASONS.has(escalation.reason_code) || !String(escalation.evidence || "").trim()) {
      route.status = "deferred";
      route.reason_codes.push("escalation_evidence_missing");
      route.reason = "Sol escalation requires a recorded failure, confidence, consequence, or judgment reason.";
      route.escalation_history = history;
      return route;
    }
    route.recommended_model = "Sol";
    route.required_review_model = null;
    route.requires_semantic_review = true;
    route.reason_codes.push(`escalation_${escalation.reason_code}`);
    route.reason = `Bounded escalation from ${escalation.from_model || "Luna/Terra"} to Sol: ${escalation.reason_code}.`;
    route.escalation_history = [...history, {
      from_model: escalation.from_model || null,
      to_model: "Sol",
      reason_code: escalation.reason_code,
      evidence: escalation.evidence,
      recorded_at: context.now || new Date().toISOString()
    }];
  }

  if (context.requires_additional_semantic_review && Number(context.semantic_review_rounds || 0) >= Number(policy.budget.max_semantic_review_rounds)) {
    const materialRevision = Boolean(context.material_revision || context.failed_evidence);
    if (!materialRevision) {
      route.status = "deferred";
      route.reason_codes.push("semantic_review_limit_reached");
      route.reason = "A second semantic review needs failed evidence or a material revision.";
    }
  }
  if (requestedModel === "Sol" && route.recommended_model !== "Sol") {
    route.warnings.push("requested_sol_not_applied_without_recorded_escalation_or_semantic_reason");
  }
  return route;
}

function recordModelRoute(tasksState, taskId, route, options = {}) {
  const state = JSON.parse(JSON.stringify(tasksState || { version: 1, tasks: [] }));
  state.tasks = Array.isArray(state.tasks) ? state.tasks : [];
  const index = state.tasks.findIndex((task) => task.task_id === taskId);
  if (index < 0) throw new Error(`Task not found for model route: ${taskId}`);
  const prior = state.tasks[index].model_route || {};
  state.tasks[index] = {
    ...state.tasks[index],
    ...(options.control_signals ? { control_signals: { ...options.control_signals } } : {}),
    model_route: {
      ...prior,
      ...route,
      requested_model: route.requested_model ?? prior.requested_model ?? null,
      applied_model: route.applied_model ?? null,
      actual_model: route.actual_model ?? prior.actual_model ?? null,
      actual_model_evidence: route.actual_model ? route.actual_model_evidence || prior.actual_model_evidence || null : null,
      adapter: route.adapter || "repository_only",
      adapter_id: route.adapter_id || route.adapter || "repository_only",
      adapter_status: route.adapter_status || "unsupported",
      updated_at: options.now || new Date().toISOString()
    }
  };
  return state;
}

function recordModelRouteAtomic(tasksPath, taskId, route, options = {}) {
  return updateJsonAtomic(tasksPath, { version: 1, tasks: [] }, (state) => recordModelRoute(state, taskId, route, options), options);
}

function ensureModelPolicyState(policyPath, options = {}) {
  const current = fs.existsSync(policyPath) ? readJsonFile(policyPath, defaultModelPolicy()) : null;
  const policy = normalizeModelPolicy(current || defaultModelPolicy());
  if (!current || JSON.stringify(current) !== JSON.stringify(policy)) writeJsonAtomic(policyPath, policy, options);
  return policy;
}

module.exports = {
  defaultModelPolicy,
  ensureModelPolicyState,
  normalizeModelPolicy,
  recordModelRoute,
  recordModelRouteAtomic,
  recommendModelRoute,
  scoreControlSignals
};
