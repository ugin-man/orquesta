"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { canonicalHash } = require("@orquesta/contracts");
const { createEventStore } = require("@orquesta/event-store");
const { normalizeBusinessWorkOrderPlanV1 } = require("../src/contract");
const { deriveEffectOperationScopeHashV2 } = require("../src/lifecycle");
const {
  BUSINESS_EVENT_TYPES,
  initialBusinessProjectionV1,
  projectBusinessEventV1,
} = require("../src/projector");
const {
  REQUIRED_PROVIDER_EFFECTS,
  BusinessCommandBoundaryError,
  createBusinessCommandBoundary,
} = require("../src/command-boundary");
const { deriveSettlementDispositionV2 } = require("../src/settlement-policy");

function contentRef(id) {
  return { id, hash: canonicalHash({ id }) };
}

function validPlan(overrides = {}) {
  return {
    version: 1,
    project_ref: "project:boundary-test",
    revision: 1,
    supersedes_plan_ref: null,
    title: "Exercise the durable command boundary",
    desired_outcome: "The command and its receipt commit atomically.",
    acceptance_policy: {
      criteria: [{
        criterion_id: "criterion:durability",
        description: "The durable boundary passes its deterministic tests.",
        verification: "deterministic",
        verification_requirements: [{
          kind: "deterministic",
          verification_ref: contentRef("verification:boundary-tests"),
        }],
      }],
      review_minimum: "light",
    },
    task_intent_ref: contentRef("TI-boundary-root"),
    execution_plan_ref: contentRef("EP-boundary-root"),
    context_pack_ref: contentRef("CP-boundary-root"),
    branches: [{
      branch_ref: "branch:solo",
      task_intent_ref: contentRef("TI-boundary-solo"),
      execution_plan_ref: contentRef("EP-boundary-solo"),
      context_pack_ref: contentRef("CP-boundary-solo"),
      dependencies: [],
      role: "work",
      parallelizable: false,
      isolation: "sandbox",
      assignee_ref: "assignee:solo",
      provider_ref: "provider:recorded-fake",
      permission_mode: "workspace-write",
    }],
    integration_branch_ref: null,
    max_concurrency: 1,
    context_duplication_budget_tokens: 1_000,
    retry_policy: {
      max_attempts: 3,
      attempt_timeout_ms: 60_000,
      max_elapsed_ms: 300_000,
      backoff_initial_ms: 1_000,
      backoff_max_ms: 30_000,
      retryable_observations: ["branch.dispatch.not_sent"],
    },
    lease_policy: {
      lease_duration_ms: 30_000,
      heartbeat_interval_ms: 10_000,
      max_recovery_probes: 3,
    },
    provider_policy: {
      allowed_provider_refs: ["provider:recorded-fake"],
      selection: "fixed",
    },
    permission_mode: "workspace-write",
    ...overrides,
  };
}

function command(plan, {
  name = "work_order.start",
  commandDigit = "1",
  workOrderDigit = "a",
  expectedRevision = 0,
  actorId = "principal:orchestrator",
  payload = name === "work_order.start" ? {} : { reason: "User requested cancellation." },
} = {}) {
  return {
    version: 1,
    command_id: `CMD-${commandDigit.repeat(32)}`,
    work_order_id: `WO-${workOrderDigit.repeat(32)}`,
    plan_snapshot_ref: plan.plan_snapshot_id,
    plan_hash: plan.plan_hash,
    expected_work_order_revision: expectedRevision,
    actor: { type: "orchestrator", actor_id: actorId },
    name,
    payload,
    payload_hash: canonicalHash(payload),
  };
}

function requiredPlanRefs(plan) {
  const refs = [
    plan.task_intent_ref,
    plan.execution_plan_ref,
    plan.context_pack_ref,
  ];
  for (const branch of plan.branches) {
    refs.push(branch.task_intent_ref, branch.execution_plan_ref, branch.context_pack_ref);
  }
  for (const criterion of plan.acceptance_policy.criteria) {
    for (const requirement of criterion.verification_requirements) {
      refs.push(requirement.verification_ref);
    }
  }
  return refs
    .map((ref) => ({ id: ref.id, hash: ref.hash }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function artifactFacts(plan, overrides = {}) {
  return {
    plan_snapshot_ref: plan.plan_snapshot_id,
    plan_hash: plan.plan_hash,
    project_ref: plan.project_ref,
    verified_refs: requiredPlanRefs(plan),
    provider_capabilities: plan.provider_policy.allowed_provider_refs.map((providerRef) => ({
      provider_ref: providerRef,
      permission_modes: [plan.permission_mode],
      isolation_modes: [...new Set(plan.branches.map((branch) => branch.isolation))],
      effects: [...REQUIRED_PROVIDER_EFFECTS],
    })),
    ...overrides,
  };
}

function createDecider(calls) {
  return async (state, normalizedCommand, trustedFacts) => {
    calls.push({ state, normalizedCommand, trustedFacts });
    const targetRevision = normalizedCommand.expected_work_order_revision + 1;
    if (normalizedCommand.name === "work_order.start") {
      return {
        applied_revision: targetRevision,
        events: [{
          type: "business.work_order.created",
          payload: {
            work_order_id: normalizedCommand.work_order_id,
            plan_snapshot_ref: normalizedCommand.plan_snapshot_ref,
            plan_hash: normalizedCommand.plan_hash,
            source_id: normalizedCommand.command_id,
            prior_work_order_revision: 0,
            target_work_order_revision: targetRevision,
            occurred_at: trustedFacts.occurred_at,
            plan: trustedFacts.plan,
            engine_contract_version: 2,
            deadline_at: new Date(
              Date.parse(trustedFacts.occurred_at)
                + trustedFacts.plan.retry_policy.max_elapsed_ms,
            ).toISOString(),
          },
          evidence_refs: [],
        }],
        result: {
          work_order_id: normalizedCommand.work_order_id,
          work_order_revision: targetRevision,
          status: "starting",
        },
      };
    }
    return {
      applied_revision: targetRevision,
      events: [{
        type: "business.work_order.status_changed",
        payload: {
          work_order_id: normalizedCommand.work_order_id,
          plan_snapshot_ref: normalizedCommand.plan_snapshot_ref,
          plan_hash: normalizedCommand.plan_hash,
          source_id: normalizedCommand.command_id,
          prior_work_order_revision: normalizedCommand.expected_work_order_revision,
          target_work_order_revision: targetRevision,
          occurred_at: trustedFacts.occurred_at,
          from: "starting",
          to: "cancelling",
          reason: normalizedCommand.payload.reason,
        },
        evidence_refs: [],
      }],
      result: {
        work_order_id: normalizedCommand.work_order_id,
        work_order_revision: targetRevision,
        status: "cancelling",
      },
    };
  };
}

function tempStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-command-boundary-"));
  const store = createEventStore({
    stateRoot: root,
    workspaceId: "command-boundary-tests",
    clock: () => "2026-08-09T06:30:00.000Z",
  });
  return {
    root,
    store,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function dependencies(store, plan, overrides = {}) {
  const order = [];
  const deciderCalls = [];
  const counters = {
    authenticate: 0,
    authorize: 0,
    resolvePlan: 0,
    resolveProject: 0,
    resolvePlanArtifacts: 0,
    resolveCommandFacts: 0,
  };
  const authorizer = overrides.authorizer || {
    async authenticate({ authentication }) {
      counters.authenticate += 1;
      order.push("authenticate");
      return authentication === "valid-token"
        ? { type: "agent", id: "principal:orchestrator" }
        : null;
    },
    async authorize({ principal, project }) {
      counters.authorize += 1;
      order.push("authorize");
      return principal.id === "principal:orchestrator"
        && project.project_ref === plan.project_ref
        ? {
          authorized: true,
          principal_type: principal.type,
          principal_id: principal.id,
          project_ref: project.project_ref,
          permission_mode: plan.permission_mode,
          allowed_provider_refs: [...plan.provider_policy.allowed_provider_refs],
          allowed_effects: [...REQUIRED_PROVIDER_EFFECTS],
        }
        : null;
    },
  };
  const resolvers = overrides.resolvers || {
    async resolvePlan() {
      counters.resolvePlan += 1;
      order.push("resolve-plan");
      return plan;
    },
    async resolveProject({ project_ref: projectRef }) {
      counters.resolveProject += 1;
      order.push("resolve-project");
      return { project_ref: projectRef };
    },
    async resolvePlanArtifacts() {
      counters.resolvePlanArtifacts += 1;
      order.push("resolve-plan-artifacts");
      return overrides.planArtifactFacts || artifactFacts(plan);
    },
    async resolveCommandFacts({ command: normalizedCommand }) {
      counters.resolveCommandFacts += 1;
      order.push("resolve-command-facts");
      if (Object.hasOwn(overrides, "commandFacts")) {
        return typeof overrides.commandFacts === "function"
          ? overrides.commandFacts(normalizedCommand)
          : overrides.commandFacts;
      }
      if (normalizedCommand.name === "work_order.start") {
        return {
          context_budget_receipt: {},
          branch_criterion_ids: {},
          dispatch_packets: {},
        };
      }
      if (["work_order.resume", "branch.retry.request"].includes(normalizedCommand.name)) {
        return { dispatch_packets: {} };
      }
      if (normalizedCommand.name === "user_input.resolve") {
        return { resolved_response_ref: contentRef("response:resolved"), dispatch_packets: {} };
      }
      return {};
    },
  };
  const baseDecider = overrides.decider || createDecider(deciderCalls);
  const decider = async (...args) => {
    order.push("decide");
    return baseDecider(...args);
  };
  return {
    order,
    counters,
    deciderCalls,
    boundary: createBusinessCommandBoundary({
      eventStore: store,
      authorizer,
      resolvers,
      clock: overrides.clock || (() => "2026-08-09T06:29:59.000Z"),
      decider,
      maxGlobalCasRetries: overrides.maxGlobalCasRetries ?? 3,
      dependencyTimeoutMs: overrides.dependencyTimeoutMs ?? 5_000,
    }),
  };
}

function readJournal(root) {
  const target = path.join(root, "events.jsonl");
  if (!fs.existsSync(target)) return [];
  return fs.readFileSync(target, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
}

function isBoundaryError(code) {
  return (error) => {
    assert.ok(error instanceof BusinessCommandBoundaryError);
    assert.equal(error.code, code);
    return true;
  };
}

function projectionStore(plan, workOrder, outbox = {}) {
  const state = structuredClone(initialBusinessProjectionV1());
  state.work_orders[workOrder.work_order_id] = workOrder;
  state.outbox = structuredClone(outbox);
  let commitCalls = 0;
  return {
    get commitCalls() { return commitCalls; },
    async replay() {
      return { state, watermark: { journal_sequence: 1 } };
    },
    async commit() {
      commitCalls += 1;
      throw new Error("the regression decider must stop before commit");
    },
  };
}

function branchProjection(planBranch, overrides = {}) {
  return {
    ...structuredClone(planBranch),
    state: "failed",
    attempt: 1,
    dispatch_id: "dispatch:boundary:attempt-1",
    open_user_input: null,
    ...overrides,
  };
}

function failedRuntimeObservation(plan, workOrderId, branchRef, attempt = 1) {
  const payload = {
    branch_ref: branchRef,
    attempt,
    failure_code: "provider_run_terminal",
  };
  return {
    version: 1,
    observation_id: `OBS-${"f".repeat(32)}`,
    work_order_id: workOrderId,
    plan_snapshot_ref: plan.plan_snapshot_id,
    plan_hash: plan.plan_hash,
    work_order_revision: 2,
    actor: { type: "provider", actor_id: "provider:recorded-fake" },
    name: "branch.failed",
    payload,
    payload_hash: canonicalHash(payload),
  };
}

function acceptedFailureBranch(plan, workOrderId, overrides = {}) {
  const branchRef = plan.branches[0].branch_ref;
  return branchProjection(plan.branches[0], {
    delivery: {
      classification: "accepted",
      observed_at: "2026-08-09T06:00:00.000Z",
    },
    last_runtime_observation: failedRuntimeObservation(plan, workOrderId, branchRef),
    result: null,
    ...overrides,
  });
}

function retryCandidatePolicy(effectKind, reason) {
  const classification = "not_sent";
  const settlementSource = reason === "recovery_probe_authoritative_absence"
    ? "recovery_probe"
    : "worker_result";
  return deriveSettlementDispositionV2({
    certainty_fact_version: 2,
    effect_contract_version: 2,
    effect_kind: effectKind,
    effect_stage: effectKind === "provider.thread.create" ? "thread_create" : "turn_start",
    settlement_source: settlementSource,
    classification,
    reason,
  });
}

function retryableGenerationFixture(plan, {
  reason = "provider_boundary_not_entered",
  settledAt = "2026-08-09T06:29:58.000Z",
  revision = 3,
} = {}) {
  const workOrderId = `WO-${"a".repeat(32)}`;
  const branchPlan = plan.branches[0];
  const packet = contentRef("packet:generation-retry");
  const dispatchId = "DSP-11111111111111111111111111111111";
  const operationScopeHash = deriveEffectOperationScopeHashV2({
    effect_kind: "provider.thread.create",
    provider_ref: branchPlan.provider_ref,
    packet_ref: packet.id,
    packet_hash: packet.hash,
  });
  const identity = {
    effect_contract_version: 2,
    work_order_id: workOrderId,
    branch_ref: branchPlan.branch_ref,
    attempt: 1,
    dispatch_id: dispatchId,
    effect_kind: "provider.thread.create",
    origin_source_id: `CMD-${"e".repeat(32)}`,
    operation_scope_hash: operationScopeHash,
    operation_generation: 1,
    generation_predecessor_effect_id: null,
    provider_ref: branchPlan.provider_ref,
    packet_ref: packet.id,
    packet_hash: packet.hash,
    predecessor_effect_id: null,
    predecessor_delivery_hash: null,
    target_runtime_identity: null,
  };
  const effectId = `FX-${canonicalHash(identity).slice(0, 32)}`;
  const effect = {
    effect_id: effectId,
    ...identity,
    idempotency_key: `IDEM-${canonicalHash(identity).slice(0, 32)}`,
    status: "not_sent",
    lease: null,
    delivery: {
      classification: "not_sent",
      runtime_identity: null,
      evidence_refs: ["evidence:generation-not-sent"],
      recorded_at: settledAt,
    },
    settlement_policy: retryCandidatePolicy("provider.thread.create", reason),
    created_at: "2026-08-09T06:29:50.000Z",
    updated_at: settledAt,
  };
  const delayMs = effect.settlement_policy.retry.mode === "automatic"
    ? plan.retry_policy.backoff_initial_ms
    : 0;
  const retryAt = new Date(Date.parse(settledAt) + delayMs).toISOString();
  const branch = branchProjection(branchPlan, {
    state: "retryable",
    attempt: 1,
    dispatch_id: dispatchId,
    packet_ref: packet,
    attempt_started_at: effect.created_at,
    attempt_deadline_at: "2026-08-09T06:31:00.000Z",
    retry_at: retryAt,
    delivery: { classification: "not_sent", observed_at: settledAt },
    thread_identity: null,
    runtime_identity: null,
    thread_create_effect_id: null,
    thread_create_delivery_hash: null,
    turn_start_effect_id: null,
    turn_start_delivery_hash: null,
    result: null,
    last_runtime_observation: null,
  });
  const workOrder = {
    work_order_id: workOrderId,
    engine_contract_version: 2,
    plan,
    revision,
    status: "paused",
    deadline_at: "2026-08-09T06:32:00.000Z",
    attention: {},
    branches: { [branchPlan.branch_ref]: branch },
  };
  return { workOrderId, workOrder, effect, effectId, retryAt };
}

test("authenticates independently of asserted actor and persists nothing when authentication fails", async () => {
  const fixture = tempStore();
  try {
    const plan = normalizeBusinessWorkOrderPlanV1(validPlan());
    const deps = dependencies(fixture.store, plan);
    const asserted = command(plan, { actorId: "trusted-looking-but-unverified" });

    await assert.rejects(
      deps.boundary.execute({ command: asserted, authentication: "invalid-token" }),
      isBoundaryError("BUSINESS_AUTHENTICATION_FAILED"),
    );
    assert.equal(deps.counters.resolvePlan, 0);
    assert.equal(deps.counters.authorize, 0);
    assert.equal(deps.deciderCalls.length, 0);
    assert.deepEqual(readJournal(fixture.root), []);
  } finally {
    fixture.cleanup();
  }
});

test("rejects an asserted actor that impersonates a different authenticated principal", async () => {
  const fixture = tempStore();
  try {
    const plan = normalizeBusinessWorkOrderPlanV1(validPlan());
    const deps = dependencies(fixture.store, plan);
    const impersonated = command(plan, { actorId: "principal:someone-else" });

    await assert.rejects(
      deps.boundary.execute({ command: impersonated, authentication: "valid-token" }),
      isBoundaryError("BUSINESS_ACTOR_BINDING_MISMATCH"),
    );
    assert.equal(deps.counters.resolvePlan, 0);
    assert.equal(deps.counters.authorize, 0);
    assert.deepEqual(readJournal(fixture.root), []);
  } finally {
    fixture.cleanup();
  }
});

test("resolves the exact plan, project, and authority before deciding a start", async () => {
  const fixture = tempStore();
  try {
    const plan = normalizeBusinessWorkOrderPlanV1(validPlan());
    const deps = dependencies(fixture.store, plan);
    const result = await deps.boundary.execute({
      command: command(plan),
      authentication: "valid-token",
    });

    assert.deepEqual(result, {
      status: "starting",
      work_order_id: `WO-${"a".repeat(32)}`,
      work_order_revision: 1,
    });
    assert.ok(deps.order.indexOf("authenticate") < deps.order.indexOf("resolve-plan"));
    assert.ok(deps.order.indexOf("resolve-plan") < deps.order.indexOf("authorize"));
    assert.ok(deps.order.indexOf("resolve-project") < deps.order.indexOf("authorize"));
    assert.ok(deps.order.indexOf("authorize") < deps.order.indexOf("decide"));
    assert.ok(deps.order.indexOf("authorize") < deps.order.indexOf("resolve-plan-artifacts"));
    assert.ok(deps.order.indexOf("resolve-plan-artifacts") < deps.order.indexOf("decide"));
    assert.equal(deps.deciderCalls[0].trustedFacts.authenticated_principal.id, "principal:orchestrator");
    assert.equal(deps.deciderCalls[0].trustedFacts.plan.plan_hash, plan.plan_hash);
    assert.equal(
      deps.deciderCalls[0].trustedFacts.resolved_plan_artifacts.verified_refs.length,
      requiredPlanRefs(plan).length,
    );

    const journal = readJournal(fixture.root);
    assert.equal(journal.length, 1);
    assert.deepEqual(journal[0].events.map((event) => event.type), [
      "business.work_order.created",
      "business.command.received",
    ]);
    assert.equal(journal[0].actor.id, "principal:orchestrator");
  } finally {
    fixture.cleanup();
  }
});

test("requires every newly created Work Order to declare engine contract V2", async () => {
  const fixture = tempStore();
  try {
    const plan = normalizeBusinessWorkOrderPlanV1(validPlan());
    const base = createDecider([]);
    const deps = dependencies(fixture.store, plan, {
      decider: async (...args) => {
        const decision = await base(...args);
        delete decision.events[0].payload.engine_contract_version;
        return decision;
      },
    });

    await assert.rejects(
      deps.boundary.execute({ command: command(plan), authentication: "valid-token" }),
      isBoundaryError("BUSINESS_COMMAND_DECISION_INVALID"),
    );
    assert.deepEqual(readJournal(fixture.root), []);
  } finally {
    fixture.cleanup();
  }
});

test("rejects missing or undeclared trusted command facts before deciding", async () => {
  const fixture = tempStore();
  try {
    const plan = normalizeBusinessWorkOrderPlanV1(validPlan());
    const missing = dependencies(fixture.store, plan, {
      commandFacts: {
        context_budget_receipt: {},
        branch_criterion_ids: {},
      },
    });
    await assert.rejects(
      missing.boundary.execute({ command: command(plan), authentication: "valid-token" }),
      isBoundaryError("BUSINESS_COMMAND_FACTS_UNVERIFIED"),
    );
    assert.equal(missing.deciderCalls.length, 0);

    const undeclared = dependencies(fixture.store, plan, {
      commandFacts: {
        context_budget_receipt: {},
        branch_criterion_ids: {},
        dispatch_packets: {},
        raw_prompt: "must never enter trusted facts",
      },
    });
    await assert.rejects(
      undeclared.boundary.execute({ command: command(plan), authentication: "valid-token" }),
      isBoundaryError("BUSINESS_COMMAND_FACTS_UNVERIFIED"),
    );
    assert.equal(undeclared.deciderCalls.length, 0);
    assert.deepEqual(readJournal(fixture.root), []);
  } finally {
    fixture.cleanup();
  }
});

test("rejects an unauthorized or plan-mismatched start before the decider and commit", async () => {
  const fixture = tempStore();
  try {
    const plan = normalizeBusinessWorkOrderPlanV1(validPlan());
    const denied = dependencies(fixture.store, plan, {
      authorizer: {
        async authenticate() { return { type: "agent", id: "principal:orchestrator" }; },
        async authorize() { return null; },
      },
    });
    await assert.rejects(
      denied.boundary.execute({ command: command(plan), authentication: "ignored" }),
      isBoundaryError("BUSINESS_AUTHORIZATION_DENIED"),
    );
    assert.equal(denied.deciderCalls.length, 0);

    const otherPlan = normalizeBusinessWorkOrderPlanV1(validPlan({ title: "Different plan" }));
    const mismatched = dependencies(fixture.store, plan, {
      resolvers: {
        async resolvePlan() { return otherPlan; },
        async resolveProject({ project_ref: projectRef }) { return { project_ref: projectRef }; },
        async resolvePlanArtifacts() { return artifactFacts(otherPlan); },
        async resolveCommandFacts() {
          return { context_budget_receipt: {}, branch_criterion_ids: {}, dispatch_packets: {} };
        },
      },
    });
    await assert.rejects(
      mismatched.boundary.execute({ command: command(plan), authentication: "valid-token" }),
      isBoundaryError("BUSINESS_PLAN_BINDING_MISMATCH"),
    );
    assert.equal(mismatched.deciderCalls.length, 0);
    assert.deepEqual(readJournal(fixture.root), []);
  } finally {
    fixture.cleanup();
  }
});

test("fails closed on incomplete authority and fallback-provider capabilities", async () => {
  const fixture = tempStore();
  try {
    const plan = normalizeBusinessWorkOrderPlanV1(validPlan({
      provider_policy: {
        allowed_provider_refs: ["provider:recorded-fake", "provider:fallback"],
        selection: "fallback_allowed",
      },
    }));
    const insufficientAuthority = dependencies(fixture.store, plan, {
      authorizer: {
        async authenticate() { return { type: "agent", id: "principal:orchestrator" }; },
        async authorize() {
          return {
            authorized: true,
            principal_type: "agent",
            principal_id: "principal:orchestrator",
            project_ref: plan.project_ref,
            permission_mode: plan.permission_mode,
            allowed_provider_refs: ["provider:recorded-fake"],
            allowed_effects: [...REQUIRED_PROVIDER_EFFECTS],
          };
        },
      },
    });
    await assert.rejects(
      insufficientAuthority.boundary.execute({
        command: command(plan),
        authentication: "valid-token",
      }),
      isBoundaryError("BUSINESS_AUTHORITY_CEILING_INVALID"),
    );
    assert.equal(insufficientAuthority.deciderCalls.length, 0);

    const explicitDenial = dependencies(fixture.store, plan, {
      authorizer: {
        async authenticate() { return { type: "agent", id: "principal:orchestrator" }; },
        async authorize() {
          return {
            authorized: false,
            principal_type: "agent",
            principal_id: "principal:orchestrator",
            project_ref: plan.project_ref,
            permission_mode: plan.permission_mode,
            allowed_provider_refs: [...plan.provider_policy.allowed_provider_refs],
            allowed_effects: [...REQUIRED_PROVIDER_EFFECTS],
          };
        },
      },
    });
    await assert.rejects(
      explicitDenial.boundary.execute({
        command: command(plan),
        authentication: "valid-token",
      }),
      isBoundaryError("BUSINESS_AUTHORITY_CEILING_INVALID"),
    );
    assert.equal(explicitDenial.deciderCalls.length, 0);

    const wrongPrincipalAuthority = dependencies(fixture.store, plan, {
      authorizer: {
        async authenticate() { return { type: "agent", id: "principal:orchestrator" }; },
        async authorize() {
          return {
            authorized: true,
            principal_type: "system",
            principal_id: "principal:orchestrator",
            project_ref: plan.project_ref,
            permission_mode: plan.permission_mode,
            allowed_provider_refs: [...plan.provider_policy.allowed_provider_refs],
            allowed_effects: [...REQUIRED_PROVIDER_EFFECTS],
          };
        },
      },
    });
    await assert.rejects(
      wrongPrincipalAuthority.boundary.execute({
        command: command(plan),
        authentication: "valid-token",
      }),
      isBoundaryError("BUSINESS_AUTHORITY_CEILING_INVALID"),
    );
    assert.equal(wrongPrincipalAuthority.deciderCalls.length, 0);

    const incompleteFacts = artifactFacts(plan);
    incompleteFacts.provider_capabilities = incompleteFacts.provider_capabilities
      .filter((capability) => capability.provider_ref !== "provider:fallback");
    const missingFallbackCapability = dependencies(fixture.store, plan, {
      planArtifactFacts: incompleteFacts,
    });
    await assert.rejects(
      missingFallbackCapability.boundary.execute({
        command: command(plan),
        authentication: "valid-token",
      }),
      isBoundaryError("BUSINESS_PLAN_ARTIFACTS_UNVERIFIED"),
    );
    assert.equal(missingFallbackCapability.deciderCalls.length, 0);
    assert.deepEqual(readJournal(fixture.root), []);
  } finally {
    fixture.cleanup();
  }
});

test("looks up an exact receipt before revision checks and rejects a conflicting command ID", async () => {
  const fixture = tempStore();
  try {
    const plan = normalizeBusinessWorkOrderPlanV1(validPlan());
    const deps = dependencies(fixture.store, plan);
    const original = command(plan);
    const first = await deps.boundary.execute({ command: original, authentication: "valid-token" });
    const replay = await deps.boundary.execute({ command: original, authentication: "valid-token" });

    assert.deepEqual(replay, first);
    assert.equal(deps.deciderCalls.length, 1);
    assert.equal(readJournal(fixture.root).length, 1);

    const conflict = command(plan, { workOrderDigit: "b" });
    await assert.rejects(
      deps.boundary.execute({ command: conflict, authentication: "valid-token" }),
      isBoundaryError("BUSINESS_COMMAND_ID_CONFLICT"),
    );
    assert.equal(deps.deciderCalls.length, 1);
    assert.equal(readJournal(fixture.root).length, 1);
  } finally {
    fixture.cleanup();
  }
});

test("replays a frozen V1 receipt but rejects every new command until explicit migration", async () => {
  const producer = tempStore();
  const fixture = tempStore();
  try {
    const plan = normalizeBusinessWorkOrderPlanV1(validPlan());
    const original = command(plan);
    const produced = dependencies(producer.store, plan);
    const first = await produced.boundary.execute({
      command: original,
      authentication: "valid-token",
    });
    const legacyBatch = structuredClone(readJournal(producer.root)[0]);
    delete legacyBatch.events[0].payload.engine_contract_version;
    fixture.store.commit({
      expected_revision: 0,
      batch_id: legacyBatch.batch_id,
      actor: legacyBatch.actor,
      correlation_id: legacyBatch.correlation_id,
      events: legacyBatch.events,
    });

    const deps = dependencies(fixture.store, plan);
    assert.deepEqual(
      await deps.boundary.execute({ command: original, authentication: "valid-token" }),
      first,
    );
    assert.equal(deps.deciderCalls.length, 0, "exact replay must not re-decide V1 history");

    await assert.rejects(
      deps.boundary.execute({
        command: command(plan, {
          name: "work_order.cancel.request",
          commandDigit: "2",
          expectedRevision: 1,
        }),
        authentication: "valid-token",
      }),
      isBoundaryError("BUSINESS_ENGINE_MIGRATION_REQUIRED"),
    );
    assert.equal(deps.deciderCalls.length, 0);
    assert.equal(readJournal(fixture.root).length, 1);
  } finally {
    producer.cleanup();
    fixture.cleanup();
  }
});

test("rejects a new stale command against the authoritative Work Order revision", async () => {
  const fixture = tempStore();
  try {
    const plan = normalizeBusinessWorkOrderPlanV1(validPlan());
    const deps = dependencies(fixture.store, plan);
    await deps.boundary.execute({ command: command(plan), authentication: "valid-token" });

    const staleCancel = command(plan, {
      name: "work_order.cancel.request",
      commandDigit: "2",
      expectedRevision: 0,
    });
    await assert.rejects(
      deps.boundary.execute({ command: staleCancel, authentication: "valid-token" }),
      (error) => {
        assert.equal(error.code, "BUSINESS_WORK_ORDER_STALE");
        assert.deepEqual(error.details, {
          work_order_id: staleCancel.work_order_id,
          expected_revision: 0,
          actual_revision: 1,
        });
        return true;
      },
    );
    assert.equal(deps.deciderCalls.length, 1);
    assert.equal(readJournal(fixture.root).length, 1);
  } finally {
    fixture.cleanup();
  }
});

test("reconciles the atomic receipt before returning after the durable commit response is lost", async () => {
  const fixture = tempStore();
  try {
    const plan = normalizeBusinessWorkOrderPlanV1(validPlan());
    let loseResponse = true;
    const uncertainStore = {
      replay: (...args) => fixture.store.replay(...args),
      commit(request) {
        const committed = fixture.store.commit(request);
        if (loseResponse) {
          loseResponse = false;
          throw Object.assign(new Error("simulated response loss"), {
            code: "TEST_COMMIT_RESPONSE_LOST",
          });
        }
        return committed;
      },
    };
    const deps = dependencies(uncertainStore, plan);
    const start = command(plan);

    const result = await deps.boundary.execute({ command: start, authentication: "valid-token" });
    assert.equal(result.status, "starting");
    assert.equal(readJournal(fixture.root).length, 1);

    const replay = await deps.boundary.execute({ command: start, authentication: "valid-token" });
    assert.equal(replay.status, "starting");
    assert.equal(deps.deciderCalls.length, 1);
    assert.equal(readJournal(fixture.root).length, 1);
  } finally {
    fixture.cleanup();
  }
});

test("wraps an unreconciled EventStore failure without leaking its raw path", async () => {
  const fixture = tempStore();
  try {
    const plan = normalizeBusinessWorkOrderPlanV1(validPlan());
    const failingStore = {
      replay: (...args) => fixture.store.replay(...args),
      commit() {
        throw Object.assign(new Error("/private/path/events.jsonl: permission denied"), {
          code: "EACCES",
        });
      },
    };
    const deps = dependencies(failingStore, plan);

    await assert.rejects(
      deps.boundary.execute({ command: command(plan), authentication: "valid-token" }),
      (error) => {
        assert.ok(error instanceof BusinessCommandBoundaryError);
        assert.equal(error.code, "BUSINESS_COMMAND_EVENT_STORE_COMMIT_FAILED");
        assert.equal(error.details.cause_code, "EACCES");
        assert.ok(!error.message.includes("/private/path"));
        return true;
      },
    );
    assert.deepEqual(readJournal(fixture.root), []);
  } finally {
    fixture.cleanup();
  }
});

test("bounds a stalled dependency before any durable command write", async () => {
  const fixture = tempStore();
  try {
    const plan = normalizeBusinessWorkOrderPlanV1(validPlan());
    let dependencySignal = null;
    const deps = dependencies(fixture.store, plan, {
      dependencyTimeoutMs: 10,
      authorizer: {
        authenticate({ signal }) {
          dependencySignal = signal;
          return new Promise(() => {});
        },
        async authorize() { throw new Error("unreachable"); },
      },
    });

    await assert.rejects(
      deps.boundary.execute({ command: command(plan), authentication: "valid-token" }),
      isBoundaryError("BUSINESS_COMMAND_DEPENDENCY_TIMEOUT"),
    );
    assert.equal(dependencySignal?.aborted, true);
    assert.equal(deps.deciderCalls.length, 0);
    assert.deepEqual(readJournal(fixture.root), []);
  } finally {
    fixture.cleanup();
  }
});

test("honors AbortSignal before the durable command boundary", async () => {
  const fixture = tempStore();
  try {
    const plan = normalizeBusinessWorkOrderPlanV1(validPlan());
    const deps = dependencies(fixture.store, plan);
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      deps.boundary.execute({
        command: command(plan),
        authentication: "valid-token",
        signal: controller.signal,
      }),
      isBoundaryError("BUSINESS_COMMAND_ABORTED"),
    );
    assert.equal(deps.counters.authenticate, 0);
    assert.equal(deps.deciderCalls.length, 0);
    assert.deepEqual(readJournal(fixture.root), []);
  } finally {
    fixture.cleanup();
  }
});

test("reloads the projected receipt when a concurrent exact batch makes commit idempotent", async () => {
  const fixture = tempStore();
  try {
    const plan = normalizeBusinessWorkOrderPlanV1(validPlan());
    let precommit = true;
    const concurrentStore = {
      replay: (...args) => fixture.store.replay(...args),
      commit(request) {
        if (precommit) {
          precommit = false;
          fixture.store.commit(request);
        }
        return fixture.store.commit(request);
      },
    };
    const deps = dependencies(concurrentStore, plan);
    const result = await deps.boundary.execute({
      command: command(plan),
      authentication: "valid-token",
    });

    assert.equal(result.status, "starting");
    assert.equal(deps.deciderCalls.length, 1);
    assert.equal(readJournal(fixture.root).length, 1);
    const replay = fixture.store.replay({
      reducers: Object.fromEntries(BUSINESS_EVENT_TYPES.map((type) => [
        type,
        (state, event, batch) => projectBusinessEventV1(state, event, batch),
      ])),
      initialState: initialBusinessProjectionV1(),
    });
    assert.ok(replay.state.command_receipts[`CMD-${"1".repeat(32)}`]);
  } finally {
    fixture.cleanup();
  }
});

test("exactly replays a durable null result instead of treating it as a missing receipt", async () => {
  const fixture = tempStore();
  try {
    const plan = normalizeBusinessWorkOrderPlanV1(validPlan());
    const base = createDecider([]);
    const deps = dependencies(fixture.store, plan, {
      decider: async (...args) => ({ ...(await base(...args)), result: null }),
    });
    const start = command(plan);

    assert.equal(await deps.boundary.execute({ command: start, authentication: "valid-token" }), null);
    assert.equal(await deps.boundary.execute({ command: start, authentication: "valid-token" }), null);
    assert.equal(readJournal(fixture.root).length, 1);
  } finally {
    fixture.cleanup();
  }
});

test("concurrent exact commands with different decision times return one durable result", async () => {
  const fixture = tempStore();
  try {
    const plan = normalizeBusinessWorkOrderPlanV1(validPlan());
    let initialReplays = 0;
    let releaseInitialReplays;
    const bothReplayed = new Promise((resolve) => { releaseInitialReplays = resolve; });
    const racingStore = {
      async replay(...args) {
        const replay = fixture.store.replay(...args);
        initialReplays += 1;
        if (initialReplays === 2) releaseInitialReplays();
        if (initialReplays <= 2) await bothReplayed;
        return replay;
      },
      commit: (...args) => fixture.store.commit(...args),
    };
    let clockTick = 0;
    const deps = dependencies(racingStore, plan, {
      clock: () => `2026-08-09T06:29:59.${String(clockTick++).padStart(3, "0")}Z`,
    });
    const start = command(plan);
    const [left, right] = await Promise.all([
      deps.boundary.execute({ command: start, authentication: "valid-token" }),
      deps.boundary.execute({ command: start, authentication: "valid-token" }),
    ]);

    assert.deepEqual(left, right);
    assert.equal(readJournal(fixture.root).length, 1);
  } finally {
    fixture.cleanup();
  }
});

test("prevalidates candidate events with the authoritative projector before journal commit", async () => {
  const fixture = tempStore();
  try {
    const plan = normalizeBusinessWorkOrderPlanV1(validPlan());
    const deps = dependencies(fixture.store, plan, {
      decider: async () => ({
        events: [{ type: "business.work_order.created", payload: {}, evidence_refs: [] }],
        result: { status: "starting", work_order_revision: 1 },
      }),
    });

    await assert.rejects(
      deps.boundary.execute({ command: command(plan), authentication: "valid-token" }),
      isBoundaryError("BUSINESS_COMMAND_DECISION_INVALID"),
    );
    assert.deepEqual(readJournal(fixture.root), []);
  } finally {
    fixture.cleanup();
  }
});

test("rejects a decider result without a domain event", async () => {
  const fixture = tempStore();
  try {
    const plan = normalizeBusinessWorkOrderPlanV1(validPlan());
    const deps = dependencies(fixture.store, plan, {
      decider: async () => ({
        events: [],
        result: { work_order_revision: 1 },
      }),
    });
    await assert.rejects(
      deps.boundary.execute({ command: command(plan), authentication: "valid-token" }),
      isBoundaryError("BUSINESS_COMMAND_DECISION_INVALID"),
    );
    assert.deepEqual(readJournal(fixture.root), []);
  } finally {
    fixture.cleanup();
  }
});

test("boundary leaves safe failed-attempt retry policy to the official decider", async () => {
  const plan = normalizeBusinessWorkOrderPlanV1(validPlan());
  const workOrderId = `WO-${"a".repeat(32)}`;
  const workOrder = {
    work_order_id: workOrderId,
    engine_contract_version: 2,
    plan,
    revision: 3,
    status: "paused",
    attention: {},
    branches: {
      "branch:solo": acceptedFailureBranch(plan, workOrderId),
    },
  };
  const store = projectionStore(plan, workOrder);
  const sentinel = new Error("decider-owned-retry-policy");
  let observedFacts = null;
  const deps = dependencies(store, plan, {
    decider: async (_state, _command, trustedFacts) => {
      observedFacts = trustedFacts;
      throw sentinel;
    },
  });
  const retry = command(plan, {
    name: "branch.retry.request",
    commandDigit: "2",
    expectedRevision: 3,
    payload: {
      branch_ref: "branch:solo",
      failed_attempt: 1,
      reason: "Verification failed and requires a bounded retry.",
    },
  });

  await assert.rejects(
    deps.boundary.execute({ command: retry, authentication: "valid-token" }),
    (error) => error === sentinel,
  );
  assert.ok(observedFacts, "the lifecycle boundary must reach the policy-owning decider");
  assert.equal(observedFacts.retry_basis.kind, "branch_attempt");
  assert.equal(
    observedFacts.retry_basis.terminal_evidence.kind,
    "accepted_runtime_failure",
  );
  assert.ok(Object.hasOwn(observedFacts, "dispatch_packets"));
  assert.equal(store.commitCalls, 0);
});

for (const scenario of [
  {
    label: "delayed automatic",
    reason: "provider_boundary_not_entered",
    commandFacts: {},
  },
  {
    label: "explicit",
    reason: "provider_rejected_no_mutation",
    // Compatibility adapters may still return the old packet field. It must
    // not become trusted input for a same-operation Effect generation.
    commandFacts: { dispatch_packets: { "branch:solo": contentRef("packet:forged-new") } },
  },
]) {
  test(`boundary derives the ${scenario.label} Effect-generation retry basis`, async () => {
    const plan = normalizeBusinessWorkOrderPlanV1(validPlan());
    const fixture = retryableGenerationFixture(plan, { reason: scenario.reason });
    const store = projectionStore(
      plan,
      fixture.workOrder,
      { [fixture.effectId]: fixture.effect },
    );
    const sentinel = new Error(`derived-${scenario.label}-generation-basis`);
    let observedFacts = null;
    const deps = dependencies(store, plan, {
      commandFacts: scenario.commandFacts,
      decider: async (_state, _command, trustedFacts) => {
        observedFacts = trustedFacts;
        throw sentinel;
      },
    });
    const retry = command(plan, {
      name: "branch.retry.request",
      commandDigit: scenario.reason === "provider_boundary_not_entered" ? "6" : "7",
      expectedRevision: fixture.workOrder.revision,
      payload: {
        branch_ref: "branch:solo",
        failed_attempt: 1,
        reason: `Exercise the ${scenario.label} generation retry.`,
      },
    });

    await assert.rejects(
      deps.boundary.execute({ command: retry, authentication: "valid-token" }),
      (error) => error === sentinel,
    );
    assert.equal(observedFacts.retry_basis.kind, "effect_generation");
    assert.equal(observedFacts.retry_basis.predecessor.effect_id, fixture.effectId);
    assert.equal(observedFacts.retry_basis.predecessor.status, "not_sent");
    assert.equal(
      observedFacts.retry_basis.settlement_policy.retry.mode,
      scenario.label === "explicit" ? "explicit" : "automatic",
    );
    assert.equal(observedFacts.retry_basis.eligible_at, fixture.retryAt);
    assert.equal(Object.hasOwn(observedFacts, "dispatch_packets"), false);
    assert.equal(store.commitCalls, 0);
  });
}

test("accepted result failure remains a branch-attempt retry and requires packets", async () => {
  const plan = normalizeBusinessWorkOrderPlanV1(validPlan());
  const workOrderId = `WO-${"a".repeat(32)}`;
  const result = {
    attempt: 1,
    artifact_refs: [contentRef("artifact:failed-verification")],
    evidence_refs: ["evidence:failed-verification"],
    submitted_at: "2026-08-09T06:00:01.000Z",
  };
  const workOrder = {
    work_order_id: workOrderId,
    engine_contract_version: 2,
    plan,
    revision: 3,
    status: "paused",
    attention: {},
    branches: {
      "branch:solo": acceptedFailureBranch(plan, workOrderId, {
        last_runtime_observation: null,
        result,
      }),
    },
  };
  const store = projectionStore(plan, workOrder);
  let deciderCalls = 0;
  const deps = dependencies(store, plan, {
    commandFacts: {},
    decider: async () => {
      deciderCalls += 1;
      throw new Error("must-not-decide-without-attempt-packet");
    },
  });
  const retry = command(plan, {
    name: "branch.retry.request",
    commandDigit: "8",
    expectedRevision: 3,
    payload: {
      branch_ref: "branch:solo",
      failed_attempt: 1,
      reason: "Retry a result that failed verification.",
    },
  });

  await assert.rejects(
    deps.boundary.execute({ command: retry, authentication: "valid-token" }),
    isBoundaryError("BUSINESS_COMMAND_FACTS_UNVERIFIED"),
  );
  assert.equal(deciderCalls, 0);
  assert.equal(store.commitCalls, 0);
});

test("resolver cannot forge the projection-derived retry basis", async () => {
  const plan = normalizeBusinessWorkOrderPlanV1(validPlan());
  const fixture = retryableGenerationFixture(plan, {
    reason: "provider_rejected_no_mutation",
  });
  const store = projectionStore(
    plan,
    fixture.workOrder,
    { [fixture.effectId]: fixture.effect },
  );
  let deciderCalls = 0;
  const deps = dependencies(store, plan, {
    commandFacts: {
      retry_basis: {
        kind: "branch_attempt",
        terminal_evidence: { kind: "caller_selected" },
      },
    },
    decider: async () => {
      deciderCalls += 1;
      throw new Error("forged-retry-basis-must-not-reach-decider");
    },
  });
  const retry = command(plan, {
    name: "branch.retry.request",
    commandDigit: "9",
    expectedRevision: fixture.workOrder.revision,
    payload: {
      branch_ref: "branch:solo",
      failed_attempt: 1,
      reason: "The projection alone must choose retry scope.",
    },
  });

  await assert.rejects(
    deps.boundary.execute({ command: retry, authentication: "valid-token" }),
    isBoundaryError("BUSINESS_COMMAND_FACTS_UNVERIFIED"),
  );
  assert.equal(deciderCalls, 0);
  assert.equal(store.commitCalls, 0);
});

test("one branch cleanup hold does not revoke an independent branch retry", async () => {
  const base = validPlan();
  const workBranch = (suffix, dependenciesList = [], role = "work") => ({
    ...structuredClone(base.branches[0]),
    branch_ref: `branch:${suffix}`,
    task_intent_ref: contentRef(`TI-boundary-${suffix}`),
    execution_plan_ref: contentRef(`EP-boundary-${suffix}`),
    context_pack_ref: contentRef(`CP-boundary-${suffix}`),
    dependencies: dependenciesList,
    role,
    assignee_ref: `assignee:${suffix}`,
  });
  const plan = normalizeBusinessWorkOrderPlanV1({
    ...base,
    branches: [
      workBranch("unknown"),
      workBranch("retry"),
      workBranch("integration", ["branch:unknown", "branch:retry"], "integration"),
    ],
    integration_branch_ref: "branch:integration",
    max_concurrency: 2,
  });
  const workOrderId = `WO-${"a".repeat(32)}`;
  const packet = contentRef("packet:unknown-branch");
  const effectSeed = {
    effect_contract_version: 2,
    work_order_id: workOrderId,
    branch_ref: "branch:unknown",
    attempt: 1,
    dispatch_id: "dispatch:unknown:attempt-1",
    effect_kind: "provider.thread.create",
    origin_source_id: `CMD-${"8".repeat(32)}`,
    operation_scope_hash: deriveEffectOperationScopeHashV2({
      effect_kind: "provider.thread.create",
      provider_ref: "provider:recorded-fake",
      packet_ref: packet.id,
      packet_hash: packet.hash,
    }),
    operation_generation: 1,
    generation_predecessor_effect_id: null,
    provider_ref: "provider:recorded-fake",
    packet_ref: packet.id,
    packet_hash: packet.hash,
    predecessor_effect_id: null,
    predecessor_delivery_hash: null,
    target_runtime_identity: null,
  };
  const effectId = `FX-${canonicalHash(effectSeed).slice(0, 32)}`;
  const effect = {
    effect_id: effectId,
    ...effectSeed,
    idempotency_key: `IDEM-${canonicalHash(effectSeed).slice(0, 32)}`,
    status: "delivery_unknown",
    lease: null,
    delivery: {
      classification: "delivery_unknown",
      runtime_identity: null,
      evidence_refs: ["evidence:unknown-branch"],
      recorded_at: "2026-08-09T06:00:00.000Z",
    },
    created_at: "2026-08-09T05:59:00.000Z",
    updated_at: "2026-08-09T06:00:00.000Z",
  };
  const workOrder = {
    work_order_id: workOrderId,
    engine_contract_version: 2,
    plan,
    revision: 4,
    status: "paused",
    attention: {
      "attention:unknown-branch": {
        attention_id: "attention:unknown-branch",
        kind: "delivery_unknown",
        branch_ref: "branch:unknown",
        effect_id: effectId,
        status: "open",
      },
    },
    branches: {
      "branch:unknown": branchProjection(
        plan.branches.find((branch) => branch.branch_ref === "branch:unknown"), {
        state: "delivery_unknown",
        dispatch_id: effect.dispatch_id,
      }),
      "branch:retry": branchProjection(
        plan.branches.find((branch) => branch.branch_ref === "branch:retry"), {
          delivery: {
            classification: "accepted",
            observed_at: "2026-08-09T06:00:00.000Z",
          },
          last_runtime_observation: failedRuntimeObservation(
            plan,
            workOrderId,
            "branch:retry",
          ),
          result: null,
        },
      ),
      "branch:integration": branchProjection(
        plan.branches.find((branch) => branch.branch_ref === "branch:integration"), {
        state: "blocked",
        attempt: 0,
        dispatch_id: null,
      }),
    },
  };
  const store = projectionStore(plan, workOrder, { [effectId]: effect });
  const sentinel = new Error("independent-branch-retry-reached-decider");
  let deciderCalls = 0;
  let retryBasis = null;
  const deps = dependencies(store, plan, {
    decider: async (_state, _command, trustedFacts) => {
      deciderCalls += 1;
      retryBasis = trustedFacts.retry_basis;
      throw sentinel;
    },
  });
  const retry = command(plan, {
    name: "branch.retry.request",
    commandDigit: "3",
    expectedRevision: 4,
    payload: {
      branch_ref: "branch:retry",
      failed_attempt: 1,
      reason: "Retry only the independent branch.",
    },
  });

  await assert.rejects(
    deps.boundary.execute({ command: retry, authentication: "valid-token" }),
    (error) => error === sentinel,
  );
  assert.equal(deciderCalls, 1);
  assert.equal(retryBasis.kind, "branch_attempt");
  assert.equal(store.commitCalls, 0);
});

test("boundary derives a same-scope not-sent cancel predecessor from projection", async () => {
  const plan = normalizeBusinessWorkOrderPlanV1(validPlan());
  const workOrderId = `WO-${"a".repeat(32)}`;
  const branchPlan = plan.branches[0];
  const runtimeIdentity = {
    operation_id: "operation:boundary-lineage",
    thread_id: "thread:boundary-lineage",
    turn_id: "turn:boundary-lineage",
  };
  const turnEffectId = `FX-${"4".repeat(32)}`;
  const turnDeliveryHash = "4".repeat(64);
  const packet = contentRef("packet:prior-cancel");
  const operationScopeHash = deriveEffectOperationScopeHashV2({
    effect_kind: "provider.turn.cancel",
    provider_ref: branchPlan.provider_ref,
    predecessor_effect_id: turnEffectId,
    predecessor_delivery_hash: turnDeliveryHash,
    target_runtime_identity: runtimeIdentity,
  });
  const effectSeed = {
    effect_contract_version: 2,
    work_order_id: workOrderId,
    branch_ref: branchPlan.branch_ref,
    attempt: 1,
    dispatch_id: "dispatch:boundary:attempt-1",
    effect_kind: "provider.turn.cancel",
    origin_source_id: `CMD-${"4".repeat(32)}`,
    operation_scope_hash: operationScopeHash,
    operation_generation: 1,
    generation_predecessor_effect_id: null,
    provider_ref: branchPlan.provider_ref,
    packet_ref: packet.id,
    packet_hash: packet.hash,
    predecessor_effect_id: turnEffectId,
    predecessor_delivery_hash: turnDeliveryHash,
    target_runtime_identity: runtimeIdentity,
  };
  const effectId = `FX-${canonicalHash(effectSeed).slice(0, 32)}`;
  const prior = {
    effect_id: effectId,
    ...effectSeed,
    idempotency_key: `IDEM-${canonicalHash(effectSeed).slice(0, 32)}`,
    status: "not_sent",
    lease: null,
    delivery: {
      classification: "not_sent",
      runtime_identity: null,
      evidence_refs: ["evidence:cancel-not-sent"],
      recorded_at: "2026-08-09T06:00:00.000Z",
    },
    created_at: "2026-08-09T05:59:00.000Z",
    updated_at: "2026-08-09T06:00:00.000Z",
  };
  const workOrder = {
    work_order_id: workOrderId,
    engine_contract_version: 2,
    plan,
    revision: 5,
    status: "cancelling",
    attention: {},
    branches: {
      "branch:solo": branchProjection(branchPlan, {
        state: "cancelling",
        runtime_identity: runtimeIdentity,
        turn_start_effect_id: turnEffectId,
        turn_start_delivery_hash: turnDeliveryHash,
        open_user_input: null,
        pending_user_input_effect_id: null,
        pending_user_input_response_ref: null,
        cancel_effect_id: null,
      }),
    },
  };
  const store = projectionStore(plan, workOrder, { [effectId]: prior });
  const sentinel = new Error("generation-predecessor-derived");
  let predecessor = null;
  const deps = dependencies(store, plan, {
    decider: async (_state, _command, trustedFacts) => {
      predecessor = trustedFacts.generation_predecessors["branch:solo"];
      throw sentinel;
    },
  });
  const retryCancel = command(plan, {
    name: "work_order.cancel.request",
    commandDigit: "5",
    expectedRevision: 5,
    payload: { reason: "Retry the exact cancel after proof it was not sent." },
  });

  await assert.rejects(
    deps.boundary.execute({ command: retryCancel, authentication: "valid-token" }),
    (error) => error === sentinel,
  );
  assert.equal(predecessor.effect_id, effectId);
  assert.equal(predecessor.status, "not_sent");
  assert.equal(predecessor.operation_scope_hash, operationScopeHash);
  assert.equal(store.commitCalls, 0);
});

test("reloads and re-decides after an unrelated global EventStore CAS winner", async () => {
  const fixture = tempStore();
  try {
    const plan = normalizeBusinessWorkOrderPlanV1(validPlan());
    let injectUnrelatedBatch = true;
    const racingStore = {
      replay: (...args) => fixture.store.replay(...args),
      commit(request) {
        if (injectUnrelatedBatch) {
          injectUnrelatedBatch = false;
          fixture.store.commit({
            expected_revision: request.expected_revision,
            batch_id: "unrelated-global-batch",
            actor: { type: "system", id: "test:other-work-order" },
            correlation_id: "unrelated-global-correlation",
            events: [{
              event_id: "unrelated-global-event",
              schema_version: 1,
              type: "task.updated",
              payload: { unrelated: true },
              evidence_refs: [],
            }],
          });
        }
        return fixture.store.commit(request);
      },
    };
    const decisionTimes = [
      "2026-08-09T06:29:59.000Z",
      "2026-08-09T06:30:00.001Z",
    ];
    let clockCalls = 0;
    const deps = dependencies(racingStore, plan, {
      maxGlobalCasRetries: 2,
      clock() {
        const value = decisionTimes[clockCalls];
        clockCalls += 1;
        return value;
      },
    });
    const result = await deps.boundary.execute({
      command: command(plan),
      authentication: "valid-token",
    });

    assert.equal(result.status, "starting");
    assert.equal(deps.deciderCalls.length, 2);
    assert.equal(clockCalls, 2);
    assert.deepEqual(
      deps.deciderCalls.map((call) => call.trustedFacts.occurred_at),
      decisionTimes,
    );
    const journal = readJournal(fixture.root);
    assert.equal(journal.length, 2);
    assert.equal(journal[0].batch_id, "unrelated-global-batch");
    assert.equal(journal[1].batch_id, `business:CMD-${"1".repeat(32)}`);
    assert.equal(journal[1].expected_revision, 1);
    assert.equal(journal[1].events.at(-1).type, "business.command.received");
  } finally {
    fixture.cleanup();
  }
});

test("re-resolves project authority and plan artifacts after a global CAS loss", async () => {
  const fixture = tempStore();
  try {
    const plan = normalizeBusinessWorkOrderPlanV1(validPlan());
    let active = true;
    let projectResolutions = 0;
    let injectUnrelatedBatch = true;
    const racingStore = {
      replay: (...args) => fixture.store.replay(...args),
      commit(request) {
        if (injectUnrelatedBatch) {
          injectUnrelatedBatch = false;
          fixture.store.commit({
            expected_revision: request.expected_revision,
            batch_id: "authority-revocation-race",
            actor: { type: "system", id: "test:authority-revoker" },
            correlation_id: "authority-revocation-race",
            events: [{
              event_id: "authority-revocation-event",
              schema_version: 1,
              type: "task.updated",
              payload: { revoked: true },
              evidence_refs: [],
            }],
          });
          active = false;
        }
        return fixture.store.commit(request);
      },
    };
    const resolvers = {
      async resolvePlan() { return plan; },
      async resolveProject({ project_ref: projectRef }) {
        projectResolutions += 1;
        return active ? { project_ref: projectRef } : null;
      },
      async resolvePlanArtifacts() { return artifactFacts(plan); },
      async resolveCommandFacts() {
        return { context_budget_receipt: {}, branch_criterion_ids: {}, dispatch_packets: {} };
      },
    };
    const deps = dependencies(racingStore, plan, { resolvers, maxGlobalCasRetries: 2 });

    await assert.rejects(
      deps.boundary.execute({ command: command(plan), authentication: "valid-token" }),
      isBoundaryError("BUSINESS_PROJECT_NOT_FOUND"),
    );
    assert.equal(projectResolutions, 2);
    assert.equal(readJournal(fixture.root).length, 1);
    assert.equal(readJournal(fixture.root)[0].batch_id, "authority-revocation-race");
  } finally {
    fixture.cleanup();
  }
});

test("bounds repeated global CAS conflicts and never invokes a provider effect", async () => {
  const fixture = tempStore();
  try {
    const plan = normalizeBusinessWorkOrderPlanV1(validPlan());
    let commitCalls = 0;
    const alwaysConflictingStore = {
      replay: (...args) => fixture.store.replay(...args),
      commit() {
        commitCalls += 1;
        throw Object.assign(new Error("global race"), { code: "EVENT_REVISION_CONFLICT" });
      },
    };
    const deps = dependencies(alwaysConflictingStore, plan, { maxGlobalCasRetries: 2 });

    await assert.rejects(
      deps.boundary.execute({ command: command(plan), authentication: "valid-token" }),
      isBoundaryError("BUSINESS_GLOBAL_CAS_EXHAUSTED"),
    );
    assert.equal(commitCalls, 3);
    assert.equal(deps.deciderCalls.length, 3);
    assert.deepEqual(readJournal(fixture.root), []);
    // No provider/driver is accepted by createBusinessCommandBoundary at all;
    // decisions can only persist events and durable outbox intent.
  } finally {
    fixture.cleanup();
  }
});
