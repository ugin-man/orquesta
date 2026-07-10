#!/usr/bin/env node

"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  defaultModelPolicy,
  ensureModelPolicyState,
  recordModelRoute,
  recordModelRouteAtomic,
  recommendModelRoute,
  scoreControlSignals
} = require("./model-policy");
const { readModelPolicyState } = require("../dashboard-server");

function task(overrides = {}) {
  return {
    task_id: "T161-TEST",
    title: "Any domain label should not decide the model",
    owner_agent_id: "implementation-001",
    dependency_chain: "chain-a",
    control_signals: {
      ambiguity: "low",
      consequence: "low",
      reversibility: "high",
      context_breadth: "medium",
      aesthetic_judgment: "low",
      verifiability: "high",
      novelty: "medium",
      failure_history: "low"
    },
    model_route: { actual_model: null },
    ...overrides
  };
}

{
  const policy = defaultModelPolicy();
  assert.strictEqual(policy.budget.default_start, "Terra");
  assert.strictEqual(policy.budget.max_concurrent_specialist_turns, 2);
  assert.deepStrictEqual(policy.budget.thread_poll_backoff_seconds, [60, 120, 240]);
}

{
  const route = recommendModelRoute(task(), defaultModelPolicy(), { work_mode: "deterministic_triage" });
  assert.strictEqual(route.recommended_model, "Luna");
  assert.strictEqual(route.actual_model, null);
  assert.strictEqual(route.adapter, "repository_only");
  assert.strictEqual(route.adapter_status, "unsupported");
}

{
  const lowSignalTask = task({
    title: "A visual, protocol, or dashboard domain label must not force a route",
    control_signals: {
      ambiguity: "low",
      consequence: "low",
      reversibility: "low",
      context_breadth: "low",
      aesthetic_judgment: "low",
      verifiability: "high",
      novelty: "low",
      failure_history: "low"
    }
  });
  assert.strictEqual(recommendModelRoute(lowSignalTask, defaultModelPolicy(), { work_mode: "implementation" }).recommended_model, "Terra");
  assert.strictEqual(recommendModelRoute(lowSignalTask, defaultModelPolicy(), { work_mode: "deterministic_triage" }).recommended_model, "Luna");
}

{
  const route = recommendModelRoute(task({
    title: "A hard visual task still has normal deterministic signals",
    control_signals: { ...task().control_signals, consequence: "high" }
  }), defaultModelPolicy(), { work_mode: "implementation" });
  assert.strictEqual(route.recommended_model, "Terra");
  assert.strictEqual(route.required_review_model, "Sol");
  assert.strictEqual(route.requires_semantic_review, true);
  assert(route.reason_codes.includes("high_consequence_requires_semantic_review"));
}

{
  const route = recommendModelRoute(task({ control_signals: { ...task().control_signals, ambiguity: "high" } }), defaultModelPolicy(), {
    work_mode: "semantic_decision"
  });
  assert.strictEqual(route.recommended_model, "Sol");
  assert(route.reason_codes.includes("high_ambiguity"));
  assert(route.reason);
}

{
  const lowSignalTask = task({
    control_signals: {
      ambiguity: "low", consequence: "low", reversibility: "low", context_breadth: "low",
      aesthetic_judgment: "low", verifiability: "high", novelty: "low", failure_history: "low"
    }
  });
  const semantic = recommendModelRoute(lowSignalTask, defaultModelPolicy(), { work_mode: "semantic_decision" });
  const orchestration = recommendModelRoute(lowSignalTask, defaultModelPolicy(), { work_mode: "orchestration" });
  assert.strictEqual(semantic.recommended_model, "Sol");
  assert.strictEqual(orchestration.recommended_model, "Sol");
  assert(semantic.reason_codes.includes("policy_rule_MP002"));
  assert(orchestration.reason_codes.includes("policy_rule_MP002"));
}

{
  const policy = defaultModelPolicy();
  policy.rules = policy.rules.map((rule) => rule.rule_id === "MP001" ? { ...rule, recommend: "Terra", reason: "Test override." } : rule);
  const route = recommendModelRoute(task(), policy, { work_mode: "deterministic_triage" });
  assert.strictEqual(route.recommended_model, "Terra");
  assert(route.reason_codes.includes("policy_rule_MP001"));
}

{
  const capacity = {
    version: 1,
    policy: defaultModelPolicy().capacity_policy,
    orchestra: { mode: "normal" },
    dispatches: [],
    capacity_records: [{
      capacity_id: "CAP-UNAVAILABLE",
      scope: { agent_id: "implementation-001", scope_key: "thread:route-test", thread_id: "route-test" },
      state: "suspected_unavailable",
      circuit: { state: "open" },
      consecutive_prestart_failures: 2
    }]
  };
  const route = recommendModelRoute(task(), defaultModelPolicy(), {
    capacity,
    target: { agent_id: "implementation-001", scope_key: "thread:route-test", thread_id: "route-test" }
  });
  assert.strictEqual(route.status, "unavailable");
  assert.strictEqual(route.recommended_model, null);
  assert(route.reason_codes.includes("capacity_circuit_open"));
}

{
  const escalated = recommendModelRoute(task(), defaultModelPolicy(), {
    escalation: { from_model: "Terra", reason_code: "failed_check", evidence: "focused suite failed" }
  });
  assert.strictEqual(escalated.recommended_model, "Sol");
  assert.strictEqual(escalated.escalation_history.length, 1);

  const deferred = recommendModelRoute(task(), defaultModelPolicy(), {
    escalation: { from_model: "Terra", reason_code: "failed_check", evidence: "another failure" },
    escalation_history: escalated.escalation_history
  });
  assert.strictEqual(deferred.status, "deferred");
  assert(deferred.reason_codes.includes("escalation_limit_reached"));
}

{
  const policy = defaultModelPolicy();
  const queuedByCount = recommendModelRoute(task(), policy, {
    active_turns: [{ task_id: "T-A", dependency_chain: "a" }, { task_id: "T-B", dependency_chain: "b" }]
  });
  assert.strictEqual(queuedByCount.status, "deferred");
  assert(queuedByCount.reason_codes.includes("specialist_turn_limit_reached"));

  const queuedByChain = recommendModelRoute(task(), policy, {
    active_turns: [{ task_id: "T-A", dependency_chain: "chain-a" }]
  });
  assert.strictEqual(queuedByChain.status, "deferred");
  assert(queuedByChain.reason_codes.includes("dependency_chain_busy"));
}

{
  const deferred = recommendModelRoute(task(), defaultModelPolicy(), {
    requires_additional_semantic_review: true,
    semantic_review_rounds: 1
  });
  assert.strictEqual(deferred.status, "deferred");
  assert(deferred.reason_codes.includes("semantic_review_limit_reached"));
  const allowed = recommendModelRoute(task(), defaultModelPolicy(), {
    requires_additional_semantic_review: true,
    semantic_review_rounds: 1,
    material_revision: true
  });
  assert.strictEqual(allowed.status, "proposed");
}

{
  const state = { version: 1, tasks: [task({ model_route: { actual_model: null, requested_model: null } })] };
  const route = recommendModelRoute(state.tasks[0], defaultModelPolicy(), { work_mode: "implementation" });
  const recorded = recordModelRoute(state, "T161-TEST", route);
  assert.strictEqual(recorded.tasks[0].model_route.recommended_model, "Terra");
  assert.strictEqual(recorded.tasks[0].model_route.applied_model, null);
  assert.strictEqual(recorded.tasks[0].model_route.actual_model, null);
}

{
  const state = { version: 1, tasks: [task({ model_route: { adapter: "codex_product", actual_model: null } })] };
  const route = recommendModelRoute(state.tasks[0], defaultModelPolicy(), {
    work_mode: "implementation",
    requested_model: "gpt-5.6-terra",
    requested_model_evidence: "Accepted dispatch requests gpt-5.6-terra."
  });
  const recorded = recordModelRoute(state, "T161-TEST", route, { control_signals: state.tasks[0].control_signals });
  const saved = recorded.tasks[0];
  assert.deepStrictEqual(saved.control_signals, state.tasks[0].control_signals);
  assert.strictEqual(saved.model_route.recommended_model, "Terra");
  assert.strictEqual(saved.model_route.requested_model, "gpt-5.6-terra");
  assert.strictEqual(saved.model_route.applied_model, null);
  assert.strictEqual(saved.model_route.actual_model, null);
  assert.strictEqual(saved.model_route.adapter, "repository_only");
}

{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-model-policy-"));
  try {
    const policyPath = path.join(root, ".orquesta", "state", "model_policy.json");
    const tasksPath = path.join(root, ".orquesta", "state", "tasks.json");
    const policy = ensureModelPolicyState(policyPath);
    assert.strictEqual(policy.budget.default_start, "Terra");
    assert.deepStrictEqual(readModelPolicyState(path.dirname(policyPath)), policy);
    fs.writeFileSync(tasksPath, `${JSON.stringify({ version: 1, tasks: [task()] })}\n`, "utf8");
    const route = recommendModelRoute(task(), policy, { work_mode: "implementation" });
    const result = recordModelRouteAtomic(tasksPath, "T161-TEST", route);
    assert.strictEqual(result.lock.released, true);
    assert.strictEqual(JSON.parse(fs.readFileSync(tasksPath, "utf8")).tasks[0].model_route.actual_model, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-model-policy-migration-"));
  try {
    const policyPath = path.join(root, "model_policy.json");
    fs.writeFileSync(policyPath, `${JSON.stringify({ version: 1, budget: { default_start: "Terra" } })}\n`, "utf8");
    const migrated = ensureModelPolicyState(policyPath);
    const saved = JSON.parse(fs.readFileSync(policyPath, "utf8"));
    assert.deepStrictEqual(migrated.rules.map((rule) => rule.rule_id), ["MP001", "MP002", "MP003", "MP004"]);
    assert.deepStrictEqual(saved.rules.map((rule) => rule.rule_id), ["MP001", "MP002", "MP003", "MP004"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

assert.strictEqual(scoreControlSignals(task()).risk_level, "high");
console.log("model-policy tests passed");
