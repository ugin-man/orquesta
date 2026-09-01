"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { canonicalHash } = require("@orquesta/contracts");
const {
  CONTRACT_LIMITS,
  ContractValidationError,
  RETRYABLE_RUNTIME_OBSERVATIONS,
  normalizeBusinessRuntimeObservationEnvelope,
  normalizeBusinessWorkOrderPlanV1,
  normalizeCommandEnvelopeV1,
  normalizeEffectSettlementObservationEnvelopeV2,
  normalizeRuntimeObservationEnvelopeV1,
} = require("..");

const PLAN_HASH = "a".repeat(64);

function contentRef(id) {
  return { id, hash: canonicalHash({ id }) };
}

function verificationRequirement(kind, id) {
  return { kind, verification_ref: contentRef(id) };
}

function branch({
  branchRef,
  suffix,
  dependencies = [],
  role = "work",
  parallelizable = false,
  isolation = "worktree",
  assigneeRef = `assignee:${suffix}`,
  providerRef = "provider:local",
  permissionMode = "workspace-write",
}) {
  return {
    branch_ref: branchRef,
    task_intent_ref: contentRef(`TI-${suffix}`),
    execution_plan_ref: contentRef(`EP-${suffix}`),
    context_pack_ref: contentRef(`CP-${suffix}`),
    dependencies,
    role,
    parallelizable,
    isolation,
    assignee_ref: assigneeRef,
    provider_ref: providerRef,
    permission_mode: permissionMode,
  };
}

function basePlan(overrides = {}) {
  return {
    version: 1,
    project_ref: "project:example",
    revision: 1,
    supersedes_plan_ref: null,
    title: "Deliver a bounded change",
    desired_outcome: "The requested change is implemented and verified.",
    acceptance_policy: {
      criteria: [
        {
          criterion_id: "criterion:tests",
          description: "Deterministic tests pass.",
          verification: "deterministic",
          verification_requirements: [
            verificationRequirement(
              "deterministic",
              "verification:criterion-tests:deterministic",
            ),
          ],
        },
      ],
      review_minimum: "normal",
    },
    task_intent_ref: contentRef("TI-root"),
    execution_plan_ref: contentRef("EP-root"),
    context_pack_ref: contentRef("CP-root"),
    branches: [
      branch({ branchRef: "branch:solo", suffix: "solo", isolation: "sandbox" }),
    ],
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
      allowed_provider_refs: ["provider:local"],
      selection: "fixed",
    },
    permission_mode: "workspace-write",
    ...overrides,
  };
}

function multiPlan(overrides = {}) {
  return basePlan({
    branches: [
      branch({
        branchRef: "branch:beta",
        suffix: "beta",
        parallelizable: true,
        isolation: "remote",
      }),
      branch({
        branchRef: "branch:alpha",
        suffix: "alpha",
        parallelizable: true,
      }),
      branch({
        branchRef: "branch:integration",
        suffix: "integration",
        dependencies: ["branch:beta", "branch:alpha"],
        role: "integration",
      }),
    ],
    integration_branch_ref: "branch:integration",
    max_concurrency: 2,
    ...overrides,
  });
}

function command(name, payload, overrides = {}) {
  const actorType = ["user_input.resolve", "acceptance.decision.record"].includes(name)
    ? "user"
    : "orchestrator";
  return {
    version: 1,
    command_id: "CMD-11111111111111111111111111111111",
    work_order_id: "WO-11111111111111111111111111111111",
    plan_snapshot_ref: "BPS-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    plan_hash: PLAN_HASH,
    expected_work_order_revision: 0,
    actor: { type: actorType, actor_id: `${actorType}:primary` },
    name,
    payload,
    payload_hash: canonicalHash(payload),
    ...overrides,
  };
}

function observation(name, payload, overrides = {}) {
  const actorType = ["verification.recorded", "review.recorded"].includes(name)
    ? "verifier"
    : [
      "work_order.started",
      "work_order.cancelled",
      "branch.dispatch.not_sent",
      "branch.timed_out",
      "branch.delivery_unknown",
    ].includes(name)
      ? "runtime"
      : "provider";
  return {
    version: 1,
    observation_id: "OBS-22222222222222222222222222222222",
    work_order_id: "WO-11111111111111111111111111111111",
    plan_snapshot_ref: "BPS-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    plan_hash: PLAN_HASH,
    work_order_revision: 1,
    actor: { type: actorType, actor_id: `${actorType}:primary` },
    name,
    payload,
    payload_hash: canonicalHash(payload),
    ...overrides,
  };
}

function settlementObservation(payload, overrides = {}) {
  return {
    version: 2,
    observation_id: "OBS-99999999999999999999999999999999",
    work_order_id: "WO-11111111111111111111111111111111",
    plan_snapshot_ref: "BPS-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    plan_hash: PLAN_HASH,
    work_order_revision: 1,
    actor: { type: "runtime", actor_id: "runtime:settlement" },
    name: "provider.effect.settlement.recorded",
    payload,
    payload_hash: canonicalHash(payload),
    ...overrides,
  };
}

function isValidationError(reason) {
  return (error) => {
    assert.ok(error instanceof ContractValidationError);
    assert.equal(error.code, "ERR_ORQUESTA_CONTRACT_VALIDATION");
    if (reason) assert.equal(error.reason, reason);
    return true;
  };
}

test("exports a solo content-addressed immutable plan snapshot from the package root", () => {
  const normalized = normalizeBusinessWorkOrderPlanV1(basePlan());

  assert.match(normalized.plan_snapshot_id, /^BPS-[a-f0-9]{32}$/u);
  assert.match(normalized.plan_hash, /^[a-f0-9]{64}$/u);
  assert.equal(normalized.project_ref, "project:example");
  assert.equal(normalized.revision, 1);
  assert.equal(normalized.supersedes_plan_ref, null);
  assert.equal(normalized.integration_branch_ref, null);
  assert.equal(normalized.branches[0].assignee_ref, "assignee:solo");
  assert.ok(Object.isFrozen(normalized));
  assert.ok(Object.isFrozen(normalized.acceptance_policy.criteria[0]));
  assert.ok(Object.isFrozen(
    normalized.acceptance_policy.criteria[0].verification_requirements[0].verification_ref,
  ));
  assert.ok(Object.isFrozen(normalized.branches[0].task_intent_ref));
});

test("normalizes a multi-agent plan with a terminal integration branch", () => {
  const normalized = normalizeBusinessWorkOrderPlanV1(multiPlan());

  assert.deepEqual(normalized.branches.map((entry) => entry.branch_ref), [
    "branch:alpha",
    "branch:beta",
    "branch:integration",
  ]);
  assert.deepEqual(normalized.branches[2].dependencies, ["branch:alpha", "branch:beta"]);
  assert.equal(normalized.branches[0].isolation, "worktree");
  assert.equal(normalized.branches[1].isolation, "remote");

  const missingIntegration = multiPlan({
    branches: multiPlan().branches.filter((entry) => entry.role === "work"),
    integration_branch_ref: null,
  });
  assert.throws(
    () => normalizeBusinessWorkOrderPlanV1(missingIntegration),
    isValidationError("integration_required"),
  );
});

test("binds root and branch artifact contents and validates revision chains", () => {
  const first = normalizeBusinessWorkOrderPlanV1(basePlan());
  const changed = basePlan();
  changed.branches[0].context_pack_ref.hash = "f".repeat(64);
  const second = normalizeBusinessWorkOrderPlanV1(changed);
  assert.notEqual(second.plan_hash, first.plan_hash);

  const changedVerification = basePlan();
  changedVerification.acceptance_policy.criteria[0]
    .verification_requirements[0].verification_ref.hash = "e".repeat(64);
  assert.notEqual(
    normalizeBusinessWorkOrderPlanV1(changedVerification).plan_hash,
    first.plan_hash,
  );

  const revision = normalizeBusinessWorkOrderPlanV1(basePlan({
    revision: 2,
    supersedes_plan_ref: first.plan_snapshot_id,
  }));
  assert.equal(revision.revision, 2);
  assert.equal(revision.supersedes_plan_ref, first.plan_snapshot_id);

  assert.throws(
    () => normalizeBusinessWorkOrderPlanV1(basePlan({ revision: 2 })),
    isValidationError("revision_chain"),
  );
  assert.throws(
    () => normalizeBusinessWorkOrderPlanV1({ ...basePlan(), plan_hash: "0".repeat(64) }),
    isValidationError("hash_mismatch"),
  );

  const collidingRef = basePlan();
  collidingRef.branches[0].context_pack_ref = {
    id: collidingRef.task_intent_ref.id,
    hash: "f".repeat(64),
  };
  assert.throws(
    () => normalizeBusinessWorkOrderPlanV1(collidingRef),
    isValidationError("content_ref_id_conflict"),
  );

  const collidingVerificationRef = basePlan();
  collidingVerificationRef.acceptance_policy.criteria[0]
    .verification_requirements[0].verification_ref = {
      ...collidingVerificationRef.task_intent_ref,
    };
  assert.throws(
    () => normalizeBusinessWorkOrderPlanV1(collidingVerificationRef),
    isValidationError("content_ref_id_conflict"),
  );
});

test("binds exact bounded verification requirements to every acceptance mode", () => {
  const humanPlan = basePlan();
  humanPlan.acceptance_policy.criteria[0] = {
    criterion_id: "criterion:judgment",
    description: "An independent human verifies the outcome.",
    verification: "human_only",
    verification_requirements: [
      verificationRequirement("human", "verification:judgment:human"),
    ],
  };
  assert.equal(
    normalizeBusinessWorkOrderPlanV1(humanPlan)
      .acceptance_policy.criteria[0].verification,
    "human_only",
  );

  const mixedPlan = basePlan();
  mixedPlan.acceptance_policy.criteria[0] = {
    criterion_id: "criterion:mixed",
    description: "Tests and a human independently verify the outcome.",
    verification: "mixed",
    verification_requirements: [
      verificationRequirement("human", "verification:mixed:z-human"),
      verificationRequirement("deterministic", "verification:mixed:a-deterministic"),
    ],
  };
  assert.deepEqual(
    normalizeBusinessWorkOrderPlanV1(mixedPlan)
      .acceptance_policy.criteria[0].verification_requirements
      .map((requirement) => requirement.verification_ref.id),
    ["verification:mixed:a-deterministic", "verification:mixed:z-human"],
  );

  const missing = basePlan();
  delete missing.acceptance_policy.criteria[0].verification_requirements;
  assert.throws(
    () => normalizeBusinessWorkOrderPlanV1(missing),
    isValidationError("required"),
  );

  for (const criterion of [
    {
      criterion_id: "criterion:deterministic-with-human",
      description: "Invalid deterministic criterion.",
      verification: "deterministic",
      verification_requirements: [
        verificationRequirement("human", "verification:invalid:human-only"),
      ],
    },
    {
      criterion_id: "criterion:human-with-deterministic",
      description: "Invalid human-only criterion.",
      verification: "human_only",
      verification_requirements: [
        verificationRequirement("deterministic", "verification:invalid:deterministic-only"),
      ],
    },
    {
      criterion_id: "criterion:mixed-with-one-kind",
      description: "Invalid mixed criterion.",
      verification: "mixed",
      verification_requirements: [
        verificationRequirement("deterministic", "verification:invalid:mixed-incomplete"),
      ],
    },
  ]) {
    const mismatched = basePlan();
    mismatched.acceptance_policy.criteria = [criterion];
    assert.throws(
      () => normalizeBusinessWorkOrderPlanV1(mismatched),
      isValidationError("verification_mode_mismatch"),
    );
  }

  const duplicated = basePlan();
  const duplicatedRef = verificationRequirement(
    "deterministic",
    "verification:duplicate",
  );
  duplicated.acceptance_policy.criteria[0].verification_requirements = [
    duplicatedRef,
    { kind: "deterministic", verification_ref: { ...duplicatedRef.verification_ref } },
  ];
  assert.throws(
    () => normalizeBusinessWorkOrderPlanV1(duplicated),
    isValidationError("duplicate"),
  );

  const oversized = basePlan();
  oversized.acceptance_policy.criteria[0].verification_requirements = Array.from(
    { length: CONTRACT_LIMITS.max_verification_requirements_per_criterion + 1 },
    (_, index) => verificationRequirement(
      "deterministic",
      `verification:too-many:${index}`,
    ),
  );
  assert.throws(
    () => normalizeBusinessWorkOrderPlanV1(oversized),
    isValidationError("array_limit"),
  );
});

test("the same immutable plan snapshot can back distinct work order instances", () => {
  const plan = normalizeBusinessWorkOrderPlanV1(basePlan());
  const payload = {};
  const first = normalizeCommandEnvelopeV1(command("work_order.start", payload, {
    work_order_id: "WO-11111111111111111111111111111111",
    plan_snapshot_ref: plan.plan_snapshot_id,
    plan_hash: plan.plan_hash,
  }));
  const second = normalizeCommandEnvelopeV1(command("work_order.start", payload, {
    command_id: "CMD-22222222222222222222222222222222",
    work_order_id: "WO-22222222222222222222222222222222",
    plan_snapshot_ref: plan.plan_snapshot_id,
    plan_hash: plan.plan_hash,
  }));

  assert.equal(first.plan_snapshot_ref, second.plan_snapshot_ref);
  assert.equal(first.plan_hash, second.plan_hash);
  assert.notEqual(first.work_order_id, second.work_order_id);
  assert.equal(first.expected_work_order_revision, 0);
});

test("fails closed on unknown fields, dangling dependencies, cycles, and unsafe isolation", () => {
  assert.throws(
    () => normalizeBusinessWorkOrderPlanV1({ ...basePlan(), debug: true }),
    isValidationError("unknown_field"),
  );
  const dangling = multiPlan();
  dangling.branches[0].dependencies = ["branch:missing"];
  assert.throws(
    () => normalizeBusinessWorkOrderPlanV1(dangling),
    isValidationError("unknown_dependency"),
  );
  const cycle = multiPlan();
  cycle.branches[0].dependencies = ["branch:alpha"];
  cycle.branches[1].dependencies = ["branch:beta"];
  assert.throws(
    () => normalizeBusinessWorkOrderPlanV1(cycle),
    isValidationError("dependency_cycle"),
  );
  const unsafe = basePlan();
  unsafe.branches[0].isolation = "read-only";
  assert.throws(
    () => normalizeBusinessWorkOrderPlanV1(unsafe),
    isValidationError("isolation_permission"),
  );

  const sharedContext = multiPlan();
  sharedContext.branches[1].context_pack_ref = {
    ...sharedContext.branches[0].context_pack_ref,
  };
  assert.throws(
    () => normalizeBusinessWorkOrderPlanV1(sharedContext),
    isValidationError("duplicate"),
  );
});

test("freezes bounded lease and heartbeat recovery behavior", () => {
  const normalized = normalizeBusinessWorkOrderPlanV1(basePlan());
  assert.deepEqual(normalized.lease_policy, {
    lease_duration_ms: 30_000,
    heartbeat_interval_ms: 10_000,
    max_recovery_probes: 3,
  });
  assert.ok(Object.isFrozen(normalized.lease_policy));

  assert.throws(
    () => normalizeBusinessWorkOrderPlanV1(basePlan({
      lease_policy: {
        lease_duration_ms: 30_000,
        heartbeat_interval_ms: 30_000,
        max_recovery_probes: 3,
      },
    })),
    isValidationError("inconsistent_limit"),
  );
});

test("only proven not-sent dispatches may be automatically retried", () => {
  assert.deepEqual(RETRYABLE_RUNTIME_OBSERVATIONS, ["branch.dispatch.not_sent"]);
  assert.throws(
    () => normalizeBusinessWorkOrderPlanV1(basePlan({
      retry_policy: {
        ...basePlan().retry_policy,
        retryable_observations: ["branch.delivery_unknown"],
      },
    })),
    isValidationError("delivery_ambiguity"),
  );
  assert.throws(
    () => normalizeBusinessWorkOrderPlanV1(basePlan({
      retry_policy: {
        ...basePlan().retry_policy,
        retryable_observations: ["branch.failed"],
      },
    })),
    isValidationError("enum"),
  );

  const payload = {
    branch_ref: "branch:solo",
    attempt: 1,
    dispatch_id: "DSP-33333333333333333333333333333333",
    reason: "transport_not_opened",
  };
  assert.equal(
    normalizeRuntimeObservationEnvelopeV1(
      observation("branch.dispatch.not_sent", payload),
    ).name,
    "branch.dispatch.not_sent",
  );
});

test("delivery ambiguity is a runtime observation, not a retry command or completion fact", () => {
  const payload = {
    branch_ref: "branch:solo",
    attempt: 1,
    dispatch_id: "DSP-33333333333333333333333333333333",
    detail: "Acknowledgement was not received after the provider request.",
  };
  const normalized = normalizeRuntimeObservationEnvelopeV1(
    observation("branch.delivery_unknown", payload),
  );
  assert.equal(normalized.name, "branch.delivery_unknown");
  assert.ok(Object.isFrozen(normalized.payload));

  assert.throws(
    () => normalizeCommandEnvelopeV1(command("branch.delivery_unknown", payload)),
    isValidationError("enum"),
  );
  assert.throws(
    () => normalizeRuntimeObservationEnvelopeV1(
      observation("work_order.completed", { outcome: "accepted" }),
    ),
    isValidationError("enum"),
  );
});

test("command actor/name provenance and exact payload schemas fail closed", () => {
  assert.throws(
    () => normalizeCommandEnvelopeV1(command("work_order.start", {}, {
      actor: { type: "user", actor_id: "user:one" },
    })),
    isValidationError("actor_name_mismatch"),
  );
  assert.throws(
    () => normalizeCommandEnvelopeV1(command("work_order.start", {}, {
      actor: { type: "provider", actor_id: "provider:one" },
    })),
    isValidationError("enum"),
  );
  assert.throws(
    () => normalizeCommandEnvelopeV1(command("work_order.start", { force: true })),
    isValidationError("unknown_field"),
  );
  assert.throws(
    () => normalizeCommandEnvelopeV1(command("unknown.command", {})),
    isValidationError("enum"),
  );
  assert.throws(
    () => normalizeCommandEnvelopeV1(command("work_order.start", {}, {
      work_order_id: "not-an-instance-id",
    })),
    isValidationError("format"),
  );
  assert.throws(
    () => normalizeCommandEnvelopeV1(command("work_order.start", {}, {
      plan_snapshot_ref: `BPS-${"b".repeat(32)}`,
    })),
    isValidationError("plan_identity_mismatch"),
  );
});

test("runtime observation actor/name provenance and payload schemas fail closed", () => {
  const threadDelivery = {
    effect_id: `FX-${"4".repeat(32)}`,
    effect_contract_version: 2,
    effect_kind: "provider.thread.create",
    branch_ref: "branch:solo",
    attempt: 1,
    dispatch_id: "DSP-33333333333333333333333333333333",
    classification: "accepted",
  };
  const normalizedThreadDelivery = normalizeRuntimeObservationEnvelopeV1(
    observation("provider.effect.delivery.recorded", threadDelivery),
  );
  assert.deepEqual(normalizedThreadDelivery.payload, threadDelivery);
  for (const [hostile, reason] of [
    [{ ...threadDelivery, effect_contract_version: 1 }, "integer_range"],
    [{ ...threadDelivery, effect_kind: "provider.thread.name" }, "enum"],
    [{ ...threadDelivery, classification: "completed" }, "enum"],
  ]) {
    assert.throws(
      () => normalizeRuntimeObservationEnvelopeV1(
        observation("provider.effect.delivery.recorded", hostile),
      ),
      isValidationError(reason),
    );
  }
  const unboundThreadDelivery = { ...threadDelivery };
  delete unboundThreadDelivery.effect_id;
  assert.throws(
    () => normalizeRuntimeObservationEnvelopeV1(
      observation("provider.effect.delivery.recorded", unboundThreadDelivery),
    ),
    isValidationError("required"),
  );

  const verification = {
    branch_ref: "branch:solo",
    criterion_id: "criterion:tests",
    verification_ref: contentRef("verification:criterion-tests:deterministic"),
    kind: "deterministic",
    status: "passed",
    evidence_refs: ["evidence:test"],
  };
  const normalizedVerification = normalizeRuntimeObservationEnvelopeV1(
    observation("verification.recorded", verification),
  );
  assert.deepEqual(normalizedVerification.payload, verification);
  assert.equal(normalizedVerification.actor.type, "verifier");

  assert.throws(
    () => normalizeRuntimeObservationEnvelopeV1(
      observation("verification.recorded", verification, {
        actor: { type: "provider", actor_id: "provider:one" },
      }),
    ),
    isValidationError("actor_name_mismatch"),
  );
  assert.throws(
    () => normalizeRuntimeObservationEnvelopeV1(
      observation("verification.recorded", {
        ...verification,
        status: "failed_expected",
      }),
    ),
    isValidationError("enum"),
  );
  const missingVerificationRef = observation("verification.recorded", verification);
  delete missingVerificationRef.payload.verification_ref;
  missingVerificationRef.payload_hash = canonicalHash(missingVerificationRef.payload);
  assert.throws(
    () => normalizeRuntimeObservationEnvelopeV1(missingVerificationRef),
    isValidationError("required"),
  );
  const dispatch = {
    branch_ref: "branch:solo",
    attempt: 1,
    dispatch_id: "DSP-33333333333333333333333333333333",
  };
  assert.throws(
    () => normalizeRuntimeObservationEnvelopeV1(
      observation("branch.dispatch.accepted", dispatch, {
        actor: { type: "verifier", actor_id: "verifier:one" },
      }),
    ),
    isValidationError("actor_name_mismatch"),
  );
  assert.throws(
    () => normalizeRuntimeObservationEnvelopeV1(
      observation("branch.dispatch.accepted", dispatch, {
        plan_hash: "b".repeat(64),
      }),
    ),
    isValidationError("plan_identity_mismatch"),
  );
  assert.throws(
    () => normalizeRuntimeObservationEnvelopeV1(observation("branch.failed", {
      branch_ref: "branch:solo",
      attempt: 1,
      failure_code: "provider_error",
      retryable: true,
    })),
    isValidationError("unknown_field"),
  );
});

test("V2 effect settlement separates callback-owned worker and recovery provenance", () => {
  const workerResultHash = canonicalHash({
    effect_id: `FX-${"4".repeat(32)}`,
    classification: "accepted",
    provider_receipt: "provider:opaque-result",
  });
  const common = {
    effect_id: `FX-${"4".repeat(32)}`,
    effect_contract_version: 2,
    effect_kind: "provider.thread.create",
    branch_ref: "branch:solo",
    attempt: 1,
    dispatch_id: `DSP-${"3".repeat(32)}`,
    classification: "accepted",
  };
  const workerPayload = {
    ...common,
    settlement_source: "worker_result",
    worker_fencing_token: {
      lease_id: "lease:settlement:one",
      owner_id: "worker:settlement:one",
      generation: 1,
    },
    worker_result_ref: {
      id: `WRR-${workerResultHash.slice(0, 32)}`,
      hash: workerResultHash,
    },
  };
  const normalizedWorker = normalizeEffectSettlementObservationEnvelopeV2(
    settlementObservation(workerPayload),
  );
  assert.deepEqual(
    normalizeBusinessRuntimeObservationEnvelope(settlementObservation(workerPayload)),
    normalizedWorker,
  );
  assert.deepEqual(normalizedWorker.payload, workerPayload);
  assert.ok(Object.isFrozen(normalizedWorker.payload.worker_fencing_token));
  assert.ok(Object.isFrozen(normalizedWorker.payload.worker_result_ref));

  const probeHash = canonicalHash({
    effect_id: common.effect_id,
    mutation_idempotency_key: `IDEM-${"5".repeat(32)}`,
    observed_outcome: "not_sent",
  });
  const probePayload = {
    ...common,
    classification: "not_sent",
    settlement_source: "recovery_probe",
    recovery_probe: {
      probe_receipt_ref: {
        id: `PRB-${probeHash.slice(0, 32)}`,
        hash: probeHash,
      },
      mutation_idempotency_key: `IDEM-${"5".repeat(32)}`,
    },
  };
  assert.deepEqual(
    normalizeEffectSettlementObservationEnvelopeV2(settlementObservation(probePayload)).payload,
    probePayload,
  );

  assert.throws(
    () => normalizeEffectSettlementObservationEnvelopeV2(settlementObservation({
      ...workerPayload,
      recovery_probe: probePayload.recovery_probe,
    })),
    isValidationError("unknown_field"),
  );
  assert.throws(
    () => normalizeEffectSettlementObservationEnvelopeV2(settlementObservation({
      ...probePayload,
      worker_fencing_token: workerPayload.worker_fencing_token,
    })),
    isValidationError("unknown_field"),
  );
  assert.throws(
    () => normalizeEffectSettlementObservationEnvelopeV2(settlementObservation({
      ...workerPayload,
      worker_result_ref: {
        ...workerPayload.worker_result_ref,
        id: `WRR-${"0".repeat(32)}`,
      },
    })),
    isValidationError("hash_mismatch"),
  );
  assert.throws(
    () => normalizeEffectSettlementObservationEnvelopeV2(settlementObservation({
      ...probePayload,
      recovery_probe: {
        ...probePayload.recovery_probe,
        probe_receipt_ref: {
          ...probePayload.recovery_probe.probe_receipt_ref,
          id: `PRB-${"0".repeat(32)}`,
        },
      },
    })),
    isValidationError("hash_mismatch"),
  );
  assert.throws(
    () => normalizeEffectSettlementObservationEnvelopeV2(
      settlementObservation(workerPayload, {
        actor: { type: "provider", actor_id: "provider:direct" },
      }),
    ),
    isValidationError("actor_name_mismatch"),
  );
  assert.throws(
    () => normalizeRuntimeObservationEnvelopeV1(settlementObservation(workerPayload)),
    isValidationError("version"),
  );
});

test("V2 send expiration binds one exact lease window without caller-selected policy", () => {
  const expiryReceipt = {
    hash: canonicalHash({ effect_id: `FX-${"1".repeat(32)}`, expires: "2026-08-09T00:00:40.000Z" }),
  };
  expiryReceipt.id = `EXP-${expiryReceipt.hash.slice(0, 32)}`;
  const payload = {
    effect_id: `FX-${"1".repeat(32)}`,
    effect_contract_version: 2,
    effect_kind: "provider.thread.create",
    branch_ref: "branch:solo",
    attempt: 1,
    dispatch_id: `DSP-${"2".repeat(32)}`,
    expired_fencing_token: {
      lease_id: "lease:expiry",
      owner_id: "worker:expiry",
      generation: 1,
    },
    lease_expires_at: "2026-08-09T00:00:40.000Z",
    expiry_receipt_ref: expiryReceipt,
  };
  const envelope = {
    version: 2,
    observation_id: `OBS-${"3".repeat(32)}`,
    work_order_id: `WO-${"4".repeat(32)}`,
    plan_snapshot_ref: `BPS-${"6".repeat(32)}`,
    plan_hash: "6".repeat(64),
    work_order_revision: 1,
    actor: { type: "runtime", actor_id: "runtime:expiry" },
    name: "provider.effect.send_expiration.recorded",
    payload,
    payload_hash: canonicalHash(payload),
  };
  assert.deepEqual(normalizeBusinessRuntimeObservationEnvelope(envelope).payload, payload);
  assert.throws(
    () => normalizeBusinessRuntimeObservationEnvelope({
      ...envelope,
      payload: { ...payload, disposition: "automatic_attempt_candidate" },
      payload_hash: canonicalHash({ ...payload, disposition: "automatic_attempt_candidate" }),
    }),
    ContractValidationError,
  );
  assert.throws(
    () => normalizeBusinessRuntimeObservationEnvelope({
      ...envelope,
      payload: { ...payload, lease_expires_at: "not-a-time" },
      payload_hash: canonicalHash({ ...payload, lease_expires_at: "not-a-time" }),
    }),
    ContractValidationError,
  );
});

test("review records are bounded verifier-only runtime facts, never commands", () => {
  const reviewPayload = {
    branch_ref: "branch:solo",
    review_id: "review:independent-1",
    status: "accepted",
    findings: { critical: 0, important: 0, minor: 2 },
    evidence_refs: ["evidence:review-1"],
  };
  const normalized = normalizeRuntimeObservationEnvelopeV1(
    observation("review.recorded", reviewPayload),
  );
  assert.deepEqual(normalized.payload, reviewPayload);
  assert.equal(normalized.actor.type, "verifier");
  assert.ok(Object.isFrozen(normalized.payload.findings));

  assert.throws(
    () => normalizeRuntimeObservationEnvelopeV1(
      observation("review.recorded", reviewPayload, {
        actor: { type: "provider", actor_id: "provider:one" },
      }),
    ),
    isValidationError("actor_name_mismatch"),
  );
  assert.throws(
    () => normalizeCommandEnvelopeV1(command("review.recorded", reviewPayload)),
    isValidationError("enum"),
  );

  for (const findings of [
    { critical: -1, important: 0, minor: 0 },
    {
      critical: CONTRACT_LIMITS.max_review_findings_per_severity + 1,
      important: 0,
      minor: 0,
    },
  ]) {
    assert.throws(
      () => normalizeRuntimeObservationEnvelopeV1(
        observation("review.recorded", { ...reviewPayload, findings }),
      ),
      isValidationError("integer_range"),
    );
  }

  assert.throws(
    () => normalizeRuntimeObservationEnvelopeV1(
      observation("review.recorded", {
        ...reviewPayload,
        findings: { ...reviewPayload.findings, blocking: 0 },
      }),
    ),
    isValidationError("unknown_field"),
  );
});

test("user input journals content-addressed handles rather than raw prompt or response text", () => {
  const responsePayload = {
    request_id: "REQ-44444444444444444444444444444444",
    response_ref: contentRef("secure-input:user-response"),
  };
  assert.deepEqual(
    normalizeCommandEnvelopeV1(command("user_input.resolve", responsePayload)).payload,
    responsePayload,
  );

  const promptPayload = {
    branch_ref: "branch:solo",
    request_id: "REQ-44444444444444444444444444444444",
    prompt_ref: contentRef("secure-input:prompt"),
  };
  assert.deepEqual(
    normalizeRuntimeObservationEnvelopeV1(
      observation("user_input.requested", promptPayload),
    ).payload,
    promptPayload,
  );
});

test("branch results journal content-addressed artifacts rather than message text", () => {
  const payload = {
    branch_ref: "branch:solo",
    attempt: 1,
    artifact_refs: [contentRef("artifact:patch")],
    evidence_refs: ["evidence:tests"],
  };
  const normalized = normalizeRuntimeObservationEnvelopeV1(
    observation("branch.result.submitted", payload),
  );
  assert.deepEqual(normalized.payload.artifact_refs, payload.artifact_refs);
  assert.ok(Object.isFrozen(normalized.payload.artifact_refs[0]));

  const rawArtifact = { ...payload, artifact_refs: ["raw result text"] };
  assert.throws(
    () => normalizeRuntimeObservationEnvelopeV1(
      observation("branch.result.submitted", rawArtifact),
    ),
    isValidationError("type"),
  );

  const emptyArtifacts = { ...payload, artifact_refs: [] };
  assert.throws(
    () => normalizeRuntimeObservationEnvelopeV1(
      observation("branch.result.submitted", emptyArtifacts),
    ),
    isValidationError("array_limit"),
  );
});

test("deep and oversized inputs return typed validation errors rather than RangeError", () => {
  let nested = { leaf: true };
  for (let index = 0; index < CONTRACT_LIMITS.max_input_depth + 5; index += 1) {
    nested = { nested };
  }
  const deep = command("work_order.start", {});
  deep.payload = nested;
  deep.payload_hash = "0".repeat(64);
  assert.throws(
    () => normalizeCommandEnvelopeV1(deep),
    (error) => {
      assert.ok(!(error instanceof RangeError));
      return isValidationError("depth_limit")(error);
    },
  );

  const oversized = command("work_order.cancel.request", {
    reason: "x".repeat(CONTRACT_LIMITS.max_envelope_bytes),
  });
  assert.throws(
    () => normalizeCommandEnvelopeV1(oversized),
    (error) => {
      assert.ok(!(error instanceof RangeError));
      assert.ok(error instanceof ContractValidationError);
      assert.ok(["string_limit", "serialized_size"].includes(error.reason));
      return true;
    },
  );

  const hostile = new Proxy({}, {
    getPrototypeOf() {
      throw new Error("hostile proxy trap");
    },
  });
  for (const normalize of [
    normalizeBusinessWorkOrderPlanV1,
    normalizeCommandEnvelopeV1,
    normalizeRuntimeObservationEnvelopeV1,
  ]) {
    assert.throws(
      () => normalize(hostile),
      isValidationError("hostile_input"),
    );
  }
});

test("payload hashes bind exact normalized payloads and outputs are deterministic", () => {
  const payload = {
    decision: "accepted",
    evidence_refs: ["evidence:a", "evidence:z"],
    comment: "Acceptance evidence is complete.",
  };
  const first = normalizeCommandEnvelopeV1(command("acceptance.decision.record", payload));
  const second = normalizeCommandEnvelopeV1(command("acceptance.decision.record", payload));
  assert.deepEqual(second, first);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.payload.evidence_refs));

  assert.throws(
    () => normalizeCommandEnvelopeV1(command("acceptance.decision.record", payload, {
      payload_hash: "0".repeat(64),
    })),
    isValidationError("hash_mismatch"),
  );
});
