# Orquesta V4 Phase 1.5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Add a deterministic fast/standard/critical execution policy that bounds Orquesta handoffs, reviews, corrections, reports, and task-entry growth while preserving legacy tasks and the Codex harness safety boundary.

**Architecture:** packages/core creates a schema-valid Execution Plan and records it in the existing Event Journal. The existing delegation gate validates Phase 1.5 task state against that plan, while tasks without execution_policy_version continue through the legacy path. Review and correction work is recorded as execution_cycles on one task rather than as auxiliary task entries.

**Tech Stack:** Node.js 20+, CommonJS, node:test, JSON Schema through @orquesta/contracts, existing V4 EventStore, existing file-backed Orquesta state.

## Global Constraints

- Use the existing isolated worktree at C:\Users\kouki\OneDrive\ドキュメント\Orquesta\.worktrees\orquesta-v4-phase1 on branch codex/orquesta-v4-phase1.
- Preserve the V3 dashboard and npm run check command exactly.
- Preserve all existing Phase 1 fixtures and their 18 batches / 42 events unless the new Execution Plan command is explicitly invoked.
- Do not add live Web exploration, install, Audition, Codex dispatch, Desktop, Experience Ledger, Intent Graph, or dashboard redesign.
- Do not build a second OS sandbox, firewall, credential vault, command risk parser, identity layer, or security approval system above the Codex harness.
- execution_policy_version absent means legacy behavior.
- execution_policy_version 1 means Phase 1.5 behavior.
- Phase 1.5 corrections and reviews remain execution_cycles on the original task. Do not create R, F, or RR task entries.
- Write every production behavior with a failing test first and observe the expected RED before implementation.
- Keep actual_model null unless independent runtime evidence proves it.
- Use the canonical checkout state at C:\Users\kouki\OneDrive\ドキュメント\Orquesta\.orquesta for Orquesta routing evidence. The product worktree .orquesta snapshot is not authoritative.
- Do not push.

## File Map

- Create packages/contracts/schemas/execution-plan.schema.json: durable Execution Plan contract.
- Modify packages/contracts/src/validator.js: register execution-plan.
- Modify packages/contracts/test/contracts.test.js: valid and invalid Execution Plan coverage.
- Create packages/core/src/execution-policy.js: lane classification, budgets, budget assessment, escalation.
- Create packages/core/test/execution-policy.test.js: classification, determinism, budget, escalation tests.
- Modify packages/core/src/index.js: export Phase 1.5 policy surface.
- Modify packages/core/src/commands.js: add execution-plan.create and execution-plan.escalate.
- Modify packages/core/src/projectors.js: replay execution.plan.created.
- Modify packages/core/test/commands.test.js: command order, event, replay, and idempotency tests.
- Modify orquesta/scripts/delegation-gate-check.js: legacy and Phase 1.5 task-state gates plus canonical state root resolution.
- Modify orquesta/scripts/delegation-gate-check.test.js: lane, budget, telemetry, child-task, and state-root coverage.
- Modify orquesta/SKILL.md: make inline_verified a normal route and define lane rules.
- Modify orquesta/references/orchestration-protocol.md: replace universal specialist delegation with risk-adaptive execution.
- Modify orquesta/references/state-schema.md: document Execution Plan, cycles, metrics, and canonical state root.
- Create scripts/v4/verify-phase15.js: generate three deterministic scenario plans and validate representative task-state gates.
- Create scripts/v4/verify-phase15.test.js: focused verifier regression.
- Modify package.json: add test:v4:phase15 and check:v4:phase15 without changing the existing check script.

---

### Task 1: Add the Execution Plan contract and deterministic lane classification

**Files:**

- Create: packages/contracts/schemas/execution-plan.schema.json
- Modify: packages/contracts/src/validator.js
- Modify: packages/contracts/test/contracts.test.js
- Create: packages/core/src/execution-policy.js
- Create: packages/core/test/execution-policy.test.js
- Modify: packages/core/src/index.js

**Interfaces:**

- Consumes: a schema-valid TaskIntent and a risk profile.
- Produces: createExecutionPlan, EXECUTION_LANES, EXECUTION_BUDGETS, and a schema-valid Execution Plan.

- [ ] **Step 1: Write the failing contract and classification tests**

Add a valid executionPlan fixture to packages/contracts/test/contracts.test.js and assert that execution-plan appears in SCHEMA_NAMES, accepts the fixture, and rejects an unknown lane, a raised budget, duplicate or unknown effects, and an unbound task_intent_id.

Create packages/core/test/execution-policy.test.js with these first cases:

~~~js
const test = require("node:test");
const assert = require("node:assert/strict");
const { assertContract } = require("@orquesta/contracts");
const { createExecutionPlan, EXECUTION_BUDGETS } = require("../src");

const taskIntent = require("../../../fixtures/v4/phase1/local-reuse/task-intent.json");

test("classifies a reversible local deterministic task as fast", () => {
  const plan = createExecutionPlan({
    taskIntent,
    riskProfile: {
      reversibility: "easy",
      scope: "single_boundary",
      verification: "deterministic",
      uncertainty: "low",
      effects: ["workspace_write"],
      repeated_failures: 0,
      user_review: "default"
    }
  });
  assert.equal(plan.lane, "fast");
  assert.equal(plan.routing.routing_class, "inline_verified");
  assert.deepEqual(plan.budget, EXECUTION_BUDGETS.fast);
  assert.equal(assertContract("execution-plan", plan), plan);
});

test("classifies multiple ownership boundaries as standard", () => {
  const plan = createExecutionPlan({
    taskIntent,
    riskProfile: {
      reversibility: "easy",
      scope: "multiple_boundaries",
      verification: "deterministic",
      uncertainty: "low",
      effects: ["workspace_write"],
      repeated_failures: 0,
      user_review: "default"
    }
  });
  assert.equal(plan.lane, "standard");
  assert.deepEqual(plan.reason_codes, ["multiple_boundaries"]);
});

test("classifies external writes and strict review as critical", () => {
  const plan = createExecutionPlan({
    taskIntent,
    riskProfile: {
      reversibility: "easy",
      scope: "single_boundary",
      verification: "deterministic",
      uncertainty: "low",
      effects: ["external_write"],
      repeated_failures: 0,
      user_review: "strict"
    }
  });
  assert.equal(plan.lane, "critical");
  assert.deepEqual(plan.reason_codes, ["critical_effect:external_write", "strict_review_requested"]);
});
~~~

Add cases proving effect order does not change execution_plan_id and an incomplete profile becomes standard with incomplete_profile in reason_codes.

- [ ] **Step 2: Run the tests and observe RED**

Run:

~~~powershell
node --test packages/contracts/test/contracts.test.js packages/core/test/execution-policy.test.js
~~~

Expected: FAIL because execution-plan is unknown and packages/core/src/execution-policy.js does not exist.

- [ ] **Step 3: Add the execution-plan schema**

The schema must require:

- execution_plan_id matching ^EP-[a-f0-9]{12}$
- task_intent_id
- policy_version equal to 1
- lane in fast, standard, critical
- complete risk_profile
- sorted reason_codes
- routing with routing_class, handoff_required, specialist_report_required
- exact budget fields
- review_policy
- escalation_triggers
- revision at least 1
- supersedes_execution_plan_id as null or an Execution Plan ID

Register execution-plan in SCHEMA_NAMES.

- [ ] **Step 4: Implement the minimal classification**

packages/core/src/execution-policy.js must export:

~~~js
const EXECUTION_LANES = Object.freeze(["fast", "standard", "critical"]);

const EXECUTION_BUDGETS = deepFreeze({
  fast: {
    max_handoffs: 0,
    max_independent_reviews: 0,
    max_correction_batches: 1,
    max_reports: 0,
    max_auxiliary_tasks: 0
  },
  standard: {
    max_handoffs: 2,
    max_independent_reviews: 1,
    max_correction_batches: 1,
    max_reports: 1,
    max_auxiliary_tasks: 0
  },
  critical: {
    max_handoffs: 4,
    max_independent_reviews: 2,
    max_correction_batches: 2,
    max_reports: 2,
    max_auxiliary_tasks: 0
  }
});

function createExecutionPlan({ taskIntent, riskProfile, revision = 1, supersedesExecutionPlanId = null }) {}
~~~

Normalize effects by code-unit sort and de-duplicate them before classification. Missing fields use conservative values that force standard and add incomplete_profile. Invalid supplied enum values throw a TypeError.

Build the ID from canonicalHash of every field except execution_plan_id. Return a deeply frozen detached object and validate it with assertContract.

- [ ] **Step 5: Run focused GREEN**

Run:

~~~powershell
node --test packages/contracts/test/contracts.test.js packages/core/test/execution-policy.test.js
~~~

Expected: PASS.

- [ ] **Step 6: Commit Task 1**

~~~powershell
git add packages/contracts packages/core/src/execution-policy.js packages/core/src/index.js packages/core/test/execution-policy.test.js
git commit -m "feat(v4): classify risk-adaptive execution plans"
~~~

---

### Task 2: Add budget assessment and same-task escalation

**Files:**

- Modify: packages/core/src/execution-policy.js
- Modify: packages/core/src/index.js
- Modify: packages/core/test/execution-policy.test.js

**Interfaces:**

- Consumes: Execution Plan, measured counts, and a named escalation trigger.
- Produces: assessExecutionBudget and escalateExecutionPlan.

- [ ] **Step 1: Write failing budget tests**

Add:

~~~js
test("requires escalation when a standard task exceeds one review", () => {
  const plan = standardPlan();
  assert.deepEqual(assessExecutionBudget(plan, {
    handoffs: 2,
    independent_reviews: 2,
    correction_batches: 0,
    reports: 1,
    auxiliary_tasks: 0
  }), {
    status: "escalation_required",
    exceeded: ["max_independent_reviews"]
  });
});

test("requires a user decision when a critical task exceeds budget", () => {
  const plan = criticalPlan();
  assert.equal(assessExecutionBudget(plan, {
    handoffs: 5,
    independent_reviews: 2,
    correction_batches: 2,
    reports: 2,
    auxiliary_tasks: 0
  }).status, "user_decision_required");
});

test("escalates fast to standard without changing the task intent", () => {
  const next = escalateExecutionPlan({
    executionPlan: fastPlan(),
    trigger: "test_failure"
  });
  assert.equal(next.lane, "standard");
  assert.equal(next.revision, 2);
  assert.equal(next.supersedes_execution_plan_id, fastPlan().execution_plan_id);
  assert.equal(next.task_intent_id, fastPlan().task_intent_id);
});
~~~

Also test standard to critical, critical escalation refusal, unknown trigger refusal, and no de-escalation API.

- [ ] **Step 2: Run RED**

Run:

~~~powershell
node --test packages/core/test/execution-policy.test.js
~~~

Expected: FAIL because assessExecutionBudget and escalateExecutionPlan are not exported.

- [ ] **Step 3: Implement budget assessment**

Validate every count as a non-negative integer. Compare:

~~~js
const METRIC_TO_BUDGET = {
  handoffs: "max_handoffs",
  independent_reviews: "max_independent_reviews",
  correction_batches: "max_correction_batches",
  reports: "max_reports",
  auxiliary_tasks: "max_auxiliary_tasks"
};
~~~

Return within_budget when no value exceeds the plan. Return escalation_required for fast or standard and user_decision_required for critical.

- [ ] **Step 4: Implement escalation**

Allow:

- fast plus test_failure, scope_drift, new_risk, or acceptance_uncertain to standard
- standard plus critical_risk_discovered, semantic_finding_not_machine_verifiable, scope_drift, or budget_exhausted to critical

Keep task_intent_id and risk_profile. Increment revision, bind supersedes_execution_plan_id, use the target lane policy, and create a new canonical ID.

- [ ] **Step 5: Run GREEN and commit**

Run:

~~~powershell
node --test packages/core/test/execution-policy.test.js
~~~

Expected: PASS.

Commit:

~~~powershell
git add packages/core
git commit -m "feat(v4): bound execution reviews and escalation"
~~~

---

### Task 3: Record Execution Plans in the V4 Event Journal

**Files:**

- Modify: packages/core/src/commands.js
- Modify: packages/core/src/projectors.js
- Modify: packages/core/test/commands.test.js

**Interfaces:**

- Consumes: current TaskIntent, current Capability Graph, risk_profile, or an escalation trigger.
- Produces: execution.plan.created events, execution_plans projection, current_execution_plan_id.

- [ ] **Step 1: Write failing command tests**

Extend the COMMAND_NAMES assertion with execution-plan.create and execution-plan.escalate immediately after capability.compile.

Add tests that:

- execution-plan.create fails before task-intent.create and capability.compile
- execution-plan.create commits one execution.plan.created event
- replay restores current_execution_plan_id
- an identical command is idempotent
- execution-plan.escalate requires a current plan
- escalation records revision 2 and supersedes the first plan
- existing fixture histories stay unchanged when neither command is used

Use the existing createTestBoundary and execute helpers in commands.test.js.

- [ ] **Step 2: Run RED**

Run:

~~~powershell
node --test packages/core/test/commands.test.js
~~~

Expected: FAIL because the command names and projector do not exist.

- [ ] **Step 3: Add projection state**

initialProjection must add:

~~~js
execution_plans: [],
current_execution_plan_id: null,
~~~

createProjectors must add:

~~~js
"execution.plan.created": withTimeline((state, event) => ({
  ...state,
  execution_plans: replaceById(state.execution_plans, event.payload.execution_plan, "execution_plan_id"),
  current_execution_plan_id: event.payload.execution_plan.execution_plan_id
})),
~~~

- [ ] **Step 4: Add commands**

execution-plan.create:

- require current TaskIntent and Capability Graph
- createExecutionPlan from command.payload.risk_profile
- commit execution.plan.created with responsibility orchestrator

execution-plan.escalate:

- require current Execution Plan
- escalateExecutionPlan from command.payload.trigger
- commit execution.plan.created with previous plan ID in evidence payload

- [ ] **Step 5: Run GREEN and the Core suite**

Run:

~~~powershell
node --test packages/core/test/commands.test.js packages/core/test/execution-policy.test.js
npm test --workspace @orquesta/core
~~~

Expected: PASS.

- [ ] **Step 6: Commit Task 3**

~~~powershell
git add packages/core
git commit -m "feat(v4): journal execution policy decisions"
~~~

---

### Task 4: Enforce Phase 1.5 lanes in the Delegation Gate

**Files:**

- Modify: orquesta/scripts/delegation-gate-check.js
- Modify: orquesta/scripts/delegation-gate-check.test.js

**Interfaces:**

- Consumes: tasks.json from an explicit canonical state root.
- Produces: deterministic errors and warnings for legacy and Phase 1.5 tasks.

- [ ] **Step 1: Replace the procedural test file with node:test cases and write RED**

Keep the legacy cases, then add validFastTask, validStandardTask, and validCriticalTask fixtures.

The standard task must contain:

~~~js
{
  task_id: "P15-STANDARD",
  state: "accepted",
  owner_agent_id: "implementation-001",
  routing_class: "specialist_required",
  routing_gate_status: "passed",
  handoff_required: true,
  handoff_sent_at: "2026-07-16T00:00:00.000Z",
  handoff_attempts: [{ sent_at: "2026-07-16T00:00:00.000Z" }],
  specialist_report_required: true,
  specialist_report_path: ".orquesta/reports/P15-STANDARD-review.md",
  execution_policy_version: 1,
  canonical_state_root: "C:\\project",
  execution_plan: standardExecutionPlan,
  execution_cycles: [
    {
      cycle_id: "implementation-1",
      kind: "implementation",
      owner_agent_id: "implementation-001",
      status: "completed",
      evidence_refs: ["commit:abc"]
    },
    {
      cycle_id: "review-1",
      kind: "review",
      owner_agent_id: "protocol-architect-001",
      status: "accepted",
      findings: { critical: 0, important: 0, minor: 0 },
      evidence_refs: [".orquesta/reports/P15-STANDARD-review.md"]
    }
  ],
  completion_evidence: [
    { kind: "test", ref: "npm run check:v4:phase15", status: "passed" }
  ],
  execution_metrics: {
    wall_time_ms: 1000,
    agent_turns: 2,
    handoffs: 1,
    independent_reviews: 1,
    correction_batches: 0,
    reports: 1,
    token_usage: { coverage: "unknown", known_total: null, by_thread: [] }
  }
}
~~~

Write tests for:

- valid legacy, fast, standard, critical
- fast with handoff or review fails
- accepted standard without review evidence fails
- standard with two reviews or two corrections fails
- critical over any budget fails
- accepted Phase 1.5 task without metrics or completion evidence fails
- token coverage unknown with known_total 0 fails
- partial or complete token coverage without by_thread evidence fails
- metrics counts must match handoff_attempts and cycles
- task with execution_parent_task_id pointing at a Phase 1.5 task fails
- explicit --state-root wins over cwd and ORQUESTA_STATE_ROOT
- ORQUESTA_STATE_ROOT wins over cwd
- missing explicit state root fails rather than silently reading a different worktree

- [ ] **Step 2: Run RED**

Run:

~~~powershell
node --test orquesta/scripts/delegation-gate-check.test.js
~~~

Expected: FAIL because inline_verified, Phase 1.5 fields, and state-root resolution are not implemented.

- [ ] **Step 3: Implement the Phase 1.5 task gate**

Add:

~~~js
const PHASE15_BUDGETS = Object.freeze({
  fast: Object.freeze({ max_handoffs: 0, max_independent_reviews: 0, max_correction_batches: 1, max_reports: 0, max_auxiliary_tasks: 0 }),
  standard: Object.freeze({ max_handoffs: 2, max_independent_reviews: 1, max_correction_batches: 1, max_reports: 1, max_auxiliary_tasks: 0 }),
  critical: Object.freeze({ max_handoffs: 4, max_independent_reviews: 2, max_correction_batches: 2, max_reports: 2, max_auxiliary_tasks: 0 })
});
~~~

Keep checkTaskLegacy unchanged for tasks without execution_policy_version.

For version 1:

- require a known lane and exact budget
- require routing_class inline_verified for fast and specialist_required for standard or critical
- compute review and correction counts from execution_cycles
- compute handoffs from handoff_attempts
- require metrics to match computed counts
- validate token coverage semantics
- require accepted-task completion evidence
- require independent accepted review evidence with zero Critical and Important for standard and critical
- reject every over-budget count

- [ ] **Step 4: Add canonical state root resolution**

Export:

~~~js
function resolveStateRoot({ argv = process.argv.slice(2), env = process.env, cwd = process.cwd() } = {}) {}
~~~

Precedence:

1. --state-root PATH or --state-root=PATH
2. ORQUESTA_STATE_ROOT
3. cwd

The resolved directory must contain .orquesta/state/tasks.json. An explicit missing root is an error; do not fall back.

- [ ] **Step 5: Add cross-task auxiliary detection**

In checkDelegationGate, build the set of version 1 parent task IDs. Reject another task that has execution_parent_task_id equal to one of them. The error must tell the caller to append an execution_cycle to the parent instead.

- [ ] **Step 6: Run GREEN and V3 delegation regression**

Run:

~~~powershell
node --test orquesta/scripts/delegation-gate-check.test.js
npm run test:delegation
~~~

Expected: PASS.

- [ ] **Step 7: Commit Task 4**

~~~powershell
git add orquesta/scripts/delegation-gate-check.js orquesta/scripts/delegation-gate-check.test.js
git commit -m "feat(orquesta): enforce risk-adaptive delegation budgets"
~~~

---

### Task 5: Update the Skill, Protocol, and State Schema

**Files:**

- Modify: orquesta/SKILL.md
- Modify: orquesta/references/orchestration-protocol.md
- Modify: orquesta/references/state-schema.md

**Interfaces:**

- Consumes: the implemented Core and gate behavior.
- Produces: one operational contract that agents can follow without inventing review tasks.

- [ ] **Step 1: Write a failing documentation contract test**

Add assertions to orquesta/scripts/delegation-gate-check.test.js that the three source documents contain:

- inline_verified
- fast, standard, critical
- execution_cycles
- canonical_state_root
- token coverage complete, partial, unknown
- a prohibition on R, F, RR auxiliary tasks for Phase 1.5

The test must also assert that SKILL.md no longer contains the absolute sentence no handoff, no implementation as a universal rule.

- [ ] **Step 2: Run RED**

Run:

~~~powershell
node --test orquesta/scripts/delegation-gate-check.test.js
~~~

Expected: FAIL on missing Phase 1.5 documentation.

- [ ] **Step 3: Update SKILL.md**

Replace the current universal Delegation Gate with:

- classify once into fast, standard, or critical
- fast uses inline_verified
- standard uses one owner and one independent review
- critical allows up to two reviews and optional QA
- corrections and reviews are same-task cycles
- legacy direct_exception remains for older tasks and real emergency exceptions
- run the gate against canonical_state_root

- [ ] **Step 4: Update orchestration-protocol.md**

Add Execution Policy between Classification and Appointment. Document lane budgets, escalation, acceptance, and no auxiliary task entries.

Keep foundation roles, vision, failure concierge, user liaison, direct conversations, and dashboard verification unchanged.

- [ ] **Step 5: Update state-schema.md**

Add a complete Phase 1.5 task example with execution_plan, execution_cycles, completion_evidence, execution_metrics, and token usage coverage. Document legacy compatibility and canonical state root.

- [ ] **Step 6: Run GREEN, encoding, and commit**

Run:

~~~powershell
node --test orquesta/scripts/delegation-gate-check.test.js
node orquesta/scripts/validate-state-encoding.js
~~~

Expected: PASS with no encoding errors.

Commit:

~~~powershell
git add orquesta/SKILL.md orquesta/references/orchestration-protocol.md orquesta/references/state-schema.md orquesta/scripts/delegation-gate-check.test.js
git commit -m "docs(orquesta): adopt the Phase 1.5 execution protocol"
~~~

---

### Task 6: Add the focused Phase 1.5 verifier

**Files:**

- Create: scripts/v4/verify-phase15.js
- Create: scripts/v4/verify-phase15.test.js
- Modify: package.json

**Interfaces:**

- Consumes: one existing TaskIntent fixture, Core Execution Policy, and Delegation Gate.
- Produces: one deterministic verifier result for fast, standard, critical, escalation, and task-state enforcement.

- [ ] **Step 1: Write the failing verifier test**

scripts/v4/verify-phase15.test.js:

~~~js
const test = require("node:test");
const assert = require("node:assert/strict");
const { verifyPhase15 } = require("./verify-phase15");

test("verifies all three lanes and same-task budget enforcement", () => {
  const result = verifyPhase15();
  assert.equal(result.status, "passed");
  assert.deepEqual(result.lanes, ["fast", "standard", "critical"]);
  assert.equal(result.legacy_compatible, true);
  assert.equal(result.auxiliary_task_rejected, true);
  assert.equal(result.token_unknown_preserved, true);
  assert.equal(result.escalation.fast_to_standard, true);
  assert.equal(result.escalation.standard_to_critical, true);
});
~~~

- [ ] **Step 2: Run RED**

Run:

~~~powershell
node --test scripts/v4/verify-phase15.test.js
~~~

Expected: FAIL because verify-phase15.js does not exist.

- [ ] **Step 3: Implement the verifier**

The verifier must:

- load fixtures/v4/phase1/local-reuse/task-intent.json
- create one plan for each lane
- prove stable IDs on reordered effects
- assess one within-budget and one over-budget case
- escalate fast to standard and standard to critical
- create temporary representative task state
- run checkDelegationGate against that explicit root
- prove an execution_parent_task_id child is rejected
- prove unknown token coverage keeps known_total null
- remove only its temporary directory

Return a plain JSON-safe object and print it when run as a command.

- [ ] **Step 4: Add scripts without changing existing check**

Add:

~~~json
"test:v4:phase15": "node --test packages/core/test/execution-policy.test.js scripts/v4/verify-phase15.test.js && node --test orquesta/scripts/delegation-gate-check.test.js",
"check:v4:phase15": "npm run test:v4:phase15 && node scripts/v4/verify-phase15.js"
~~~

- [ ] **Step 5: Run GREEN and full regressions**

Run:

~~~powershell
npm run check:v4:phase15
npm run check:v4:phase1
npm run check
~~~

Expected:

- focused Phase 1.5 verifier passed
- V4 Phase 1 boundary and all workspace tests passed
- V3 check passed
- encoding check passed

- [ ] **Step 6: Commit Task 6**

~~~powershell
git add scripts/v4/verify-phase15.js scripts/v4/verify-phase15.test.js package.json
git commit -m "test(v4): add the Phase 1.5 execution gate"
~~~

---

### Task 7: Dogfood Phase 1.5 on its own implementation task

**Files:**

- Modify in canonical checkout only: .orquesta/state/tasks.json
- Modify in canonical checkout only: .orquesta/state/events.jsonl
- Create in canonical checkout only: .orquesta/reports/V4I150-protocol-review.md

**Interfaces:**

- Consumes: the fixed Phase 1.5 implementation commits and canonical Orquesta state.
- Produces: one standard-lane task with implementation, one review, optional one correction, complete metrics, and no auxiliary task entries.

- [ ] **Step 1: Create one V4I150 task before implementation handoff**

Use execution_policy_version 1, standard lane, canonical_state_root, exact standard budget, one implementation cycle in active state, and no child task IDs.

- [ ] **Step 2: Send one handoff to implementation-001**

The handoff must point to this plan, the design spec, the existing worktree, the allowed files, TDD, and the one-report final review policy. Do not request a specialist implementation Markdown report; completion evidence is commits and tests in V4I150 state.

- [ ] **Step 3: Record the implementation cycles and metrics**

After implementation, append completed implementation cycles in V4I150. Count every actual handoff and agent turn. Record token coverage as complete, partial, or unknown.

- [ ] **Step 4: Request one independent fixed-range review**

Use protocol-architect-001. The reviewer writes only .orquesta/reports/V4I150-protocol-review.md and returns Critical, Important, Minor counts.

- [ ] **Step 5: Handle findings inside V4I150**

If Critical or Important findings are mechanically verifiable, send one batched correction to implementation-001 and append correction-1 to V4I150. Do not create V4I150F1 or V4I150RR1.

If semantic closure cannot be proven without another review, escalate the same task to critical and use the second review allowance.

- [ ] **Step 6: Accept only with complete evidence**

Run the Delegation Gate against the canonical state root. Require Critical 0, Important 0, fresh full verification, matching metrics, and no auxiliary Phase 1.5 tasks.

---

## Final Verification Matrix

| Requirement | Evidence |
|---|---|
| deterministic lane classification | packages/core/test/execution-policy.test.js |
| schema-valid Execution Plan | packages/contracts/test/contracts.test.js |
| Event Journal and replay | packages/core/test/commands.test.js |
| fast/standard/critical gate | orquesta/scripts/delegation-gate-check.test.js |
| same-task correction policy | child-task rejection test plus V4I150 canonical state |
| honest token coverage | gate tests plus V4I150 execution_metrics |
| canonical state root | state-root precedence tests and V4I150 |
| legacy compatibility | legacy delegation tests and npm run check |
| Phase 1 regression | npm run check:v4:phase1 |
| focused Phase 1.5 proof | npm run check:v4:phase15 |
| independent semantic review | .orquesta/reports/V4I150-protocol-review.md |
| no Phase 2 work | git diff and Phase 1 boundary check |

## Completion Rule

Phase 1.5 is complete only when every matrix row has fresh evidence, V4I150 is accepted in canonical state, Critical and Important findings are zero, no Phase 1.5 auxiliary task exists, and Phase 2 remains unstarted.
