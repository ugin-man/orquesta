"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  BusinessLifecycleInvariantError,
  assertLifecycleInvariants,
  classifyEffectLifecycleV2,
  deriveBranchLifecycleSnapshot,
  deriveEffectOperationScopeHashV2,
  deriveLifecycleSnapshot,
} = require("../src/lifecycle");

const WORK_ORDER_ID = "WO-11111111111111111111111111111111";
const HASH = "a".repeat(64);

function branchFixture({
  branchRef = "branch:one",
  attempt = 1,
  dispatchId = "dispatch:one:1",
  state = "delivery_unknown",
} = {}) {
  return {
    branch_ref: branchRef,
    attempt,
    dispatch_id: dispatchId,
    state,
  };
}

function workOrderFixture({
  engineContractVersion = 2,
  status = "running",
  branches = [branchFixture()],
} = {}) {
  const workOrder = {
    work_order_id: WORK_ORDER_ID,
    status,
    branches: Object.fromEntries(branches.map((branch) => [branch.branch_ref, branch])),
    attention: {},
  };
  if (engineContractVersion !== undefined) {
    workOrder.engine_contract_version = engineContractVersion;
  }
  return workOrder;
}

function effectFixture({
  effectId = "effect:one",
  branchRef = "branch:one",
  attempt = 1,
  dispatchId = "dispatch:one:1",
  effectKind = "provider.turn.start",
  originSourceId = `source:${effectId}`,
  idempotencyKey = `idempotency:${effectId}`,
  packetRef = "packet:one",
  packetHash = HASH,
  status = "delivery_unknown",
  createdAt = "2026-08-09T00:00:00.000Z",
  operationGeneration = 1,
  generationPredecessorEffectId = null,
  operationScopeHash = null,
  requestId = "request:one",
  responseRef = { id: "response:one", hash: "d".repeat(64) },
} = {}) {
  const effect = {
    effect_id: effectId,
    effect_contract_version: 2,
    work_order_id: WORK_ORDER_ID,
    branch_ref: branchRef,
    attempt,
    dispatch_id: dispatchId,
    effect_kind: effectKind,
    origin_source_id: originSourceId,
    operation_scope_hash: null,
    operation_generation: operationGeneration,
    generation_predecessor_effect_id: generationPredecessorEffectId,
    provider_ref: "provider:recorded",
    packet_ref: packetRef,
    packet_hash: packetHash,
    predecessor_effect_id: null,
    predecessor_delivery_hash: null,
    target_runtime_identity: null,
    idempotency_key: idempotencyKey,
    status,
    lease: null,
    delivery: null,
    created_at: createdAt,
    updated_at: createdAt,
  };
  effect.operation_scope_hash = operationScopeHash || deriveEffectOperationScopeHashV2({
    ...effect,
    request_id: requestId,
    response_ref: responseRef,
  });
  return effect;
}

function recoveryAttention(effect, {
  attentionId = `attention:${effect.effect_id}`,
  branchRef = effect.branch_ref,
  effectId = effect.effect_id,
  kind = "delivery_unknown",
} = {}) {
  return {
    attention_id: attentionId,
    kind,
    branch_ref: branchRef,
    effect_id: effectId,
    status: "open",
  };
}

function snapshotFor(workOrder, effects, attentions = []) {
  return deriveLifecycleSnapshot({
    workOrder,
    outbox: Object.fromEntries(effects.map((effect) => [effect.effect_id, effect])),
    attention: Object.fromEntries(
      attentions.map((attention) => [attention.attention_id, attention]),
    ),
  });
}

test("an unversioned V1 Work Order is replay-only without lifecycle inference", () => {
  const workOrder = workOrderFixture();
  delete workOrder.engine_contract_version;
  const snapshot = snapshotFor(workOrder, [effectFixture()], []);

  assert.equal(snapshot.mode, "replay_only");
  assert.equal(snapshot.automation.state, "replay_only");
  assert.deepEqual(snapshot.branches["branch:one"].effects, []);
  assert.equal(assertLifecycleInvariants(snapshot), snapshot);
});

test("paused plus delivery unknown is a valid explicit cleanup hold", () => {
  const workOrder = workOrderFixture({ status: "paused" });
  const effect = effectFixture();
  const snapshot = snapshotFor(workOrder, [effect], [recoveryAttention(effect)]);

  assert.equal(snapshot.automation.state, "cleanup_hold");
  assert.equal(snapshot.automation.may_schedule_forward_work, false);
  assert.equal(snapshot.automation.may_reconcile, true);
  assert.deepEqual(snapshot.automation.blocking_effect_ids, [effect.effect_id]);
  assert.equal(snapshot.branches["branch:one"].cleanup_hold, true);
  assert.doesNotThrow(() => assertLifecycleInvariants(snapshot));
});

test("paused parks a current unsent effect without inventing a cleanup hold", () => {
  const workOrder = workOrderFixture({ status: "paused" });
  const effect = effectFixture({ status: "pending" });
  const snapshot = snapshotFor(workOrder, [effect]);

  assert.equal(snapshot.automation.state, "paused");
  assert.equal(snapshot.automation.may_reconcile, false);
  assert.deepEqual(snapshot.automation.blocking_effect_ids, []);
  assert.equal(snapshot.branches["branch:one"].cleanup_hold, false);
  assert.doesNotThrow(() => assertLifecycleInvariants(snapshot));
});

test("recovery attention is scoped to its exact effect", () => {
  const workOrder = workOrderFixture();
  const first = effectFixture({ effectId: "effect:first", packetRef: "packet:first" });
  const second = effectFixture({ effectId: "effect:second", packetRef: "packet:second" });
  const snapshot = snapshotFor(workOrder, [first, second], [recoveryAttention(first)]);

  assert.throws(
    () => assertLifecycleInvariants(snapshot),
    (error) => {
      assert.ok(error instanceof BusinessLifecycleInvariantError);
      assert.ok(error.details.violations.some((violation) => (
        violation.code === "delivery_unknown_recovery_attention_missing"
          && violation.effect_id === second.effect_id
      )));
      return true;
    },
  );
});

test("two unrelated unknown operation goals remain representable", () => {
  const workOrder = workOrderFixture({
    status: "cancelling",
    branches: [branchFixture({ state: "cancelling" })],
  });
  const first = effectFixture({
    effectId: "effect:first",
    effectKind: "provider.user_input.submit",
    packetRef: "packet:first",
  });
  const second = effectFixture({
    effectId: "effect:second",
    effectKind: "provider.turn.cancel",
    packetRef: "packet:cancel",
  });
  const snapshot = snapshotFor(workOrder, [first, second], [
    recoveryAttention(first),
    recoveryAttention(second),
  ]);
  const branch = snapshot.branches["branch:one"];

  assert.equal(branch.operation_goals.length, 2);
  assert.deepEqual(branch.ambiguous_effect_ids, ["effect:first", "effect:second"]);
  assert.equal(snapshot.automation.state, "cleanup_hold");
  assert.doesNotThrow(() => assertLifecycleInvariants(snapshot));
});

test("an unresolved prior attempt blocks retry but remains a valid cleanup state", () => {
  const currentBranch = branchFixture({ attempt: 2, dispatchId: "dispatch:one:2", state: "retryable" });
  const workOrder = workOrderFixture({ branches: [currentBranch] });
  const stale = effectFixture({
    effectId: "effect:prior",
    attempt: 1,
    dispatchId: "dispatch:one:1",
    status: "sending",
  });
  const snapshot = snapshotFor(workOrder, [stale], [recoveryAttention(stale, {
    kind: "timeout_requires_reconciliation",
  })]);
  const branch = snapshot.branches["branch:one"];

  assert.deepEqual(branch.stale_unresolved_effect_ids, [stale.effect_id]);
  assert.equal(branch.retry_allowed, false);
  assert.equal(snapshot.automation.state, "cleanup_hold");
  assert.doesNotThrow(() => assertLifecycleInvariants(snapshot));
});

test("effect terminality is distinct from operation-goal terminality", () => {
  const branch = branchFixture({ state: "retryable" });
  const notSent = classifyEffectLifecycleV2(
    effectFixture({ status: "not_sent" }),
    branch,
  );
  const delivered = classifyEffectLifecycleV2(
    effectFixture({ effectId: "effect:delivered", status: "delivered" }),
    branch,
  );

  assert.equal(notSent.effect_terminal, true);
  assert.equal(notSent.goal_terminal, false);
  assert.equal(notSent.goal_disposition, "retryable");
  assert.equal(delivered.effect_terminal, true);
  assert.equal(delivered.goal_terminal, true);
  assert.equal(delivered.goal_disposition, "achieved");
});

test("two unresolved generations of one operation goal violate intrinsic closure", () => {
  const workOrder = workOrderFixture();
  const first = effectFixture({
    effectId: "effect:generation-one",
    effectKind: "provider.turn.cancel",
    originSourceId: "source:generation-one",
    idempotencyKey: "idempotency:generation-one",
    status: "sending",
  });
  const second = effectFixture({
    effectId: "effect:generation-two",
    effectKind: "provider.turn.cancel",
    originSourceId: "source:generation-two",
    idempotencyKey: "idempotency:generation-two",
    status: "pending",
    createdAt: "2026-08-09T00:00:01.000Z",
    operationGeneration: 2,
    generationPredecessorEffectId: first.effect_id,
  });
  const snapshot = snapshotFor(workOrder, [first, second], [recoveryAttention(first)]);

  assert.throws(
    () => assertLifecycleInvariants(snapshot),
    (error) => error.details.violations.some((violation) => (
      violation.code === "multiple_unresolved_generations_for_operation_goal"
        && violation.effect_ids.length === 2
    )),
  );
});

test("a not-sent generation may have one unresolved successor for the same goal", () => {
  const workOrder = workOrderFixture();
  const first = effectFixture({
    effectId: "effect:z-generation-one",
    effectKind: "provider.turn.cancel",
    originSourceId: "source:generation-one",
    idempotencyKey: "idempotency:generation-one",
    status: "not_sent",
  });
  const successor = effectFixture({
    effectId: "effect:a-generation-two",
    effectKind: "provider.turn.cancel",
    originSourceId: "source:generation-two",
    idempotencyKey: "idempotency:generation-two",
    packetRef: "packet:successor",
    packetHash: "b".repeat(64),
    status: "pending",
    createdAt: "2026-08-09T00:00:00.000Z",
    operationGeneration: 2,
    generationPredecessorEffectId: first.effect_id,
  });
  const snapshot = snapshotFor(workOrder, [first, successor]);
  const [goal] = snapshot.branches["branch:one"].operation_goals;

  assert.equal(snapshot.branches["branch:one"].operation_goals.length, 1);
  assert.equal(goal.latest_generation, 2);
  assert.deepEqual(goal.unresolved_effect_ids, [successor.effect_id]);
  assert.doesNotThrow(() => assertLifecycleInvariants(snapshot));
});

test("operation scope hashing separates payload scope from retry generation", () => {
  const shared = {
    effect_kind: "provider.turn.cancel",
    provider_ref: "provider:recorded",
    predecessor_effect_id: "effect:turn",
    predecessor_delivery_hash: HASH,
    target_runtime_identity: { operation_id: null, thread_id: "thread:one", turn_id: "turn:one" },
  };
  const cancelFirst = deriveEffectOperationScopeHashV2({
    ...shared,
    packet_ref: "packet:first",
    packet_hash: "1".repeat(64),
  });
  const cancelRetry = deriveEffectOperationScopeHashV2({
    ...shared,
    packet_ref: "packet:retry",
    packet_hash: "2".repeat(64),
  });
  const turnFirst = deriveEffectOperationScopeHashV2({
    ...shared,
    effect_kind: "provider.turn.start",
    packet_ref: "packet:first",
    packet_hash: "1".repeat(64),
  });
  const turnChanged = deriveEffectOperationScopeHashV2({
    ...shared,
    effect_kind: "provider.turn.start",
    packet_ref: "packet:changed",
    packet_hash: "2".repeat(64),
  });

  assert.match(cancelFirst, /^[a-f0-9]{64}$/u);
  assert.equal(cancelFirst, cancelRetry);
  assert.notEqual(turnFirst, turnChanged);
});

test("a changed user response after not-sent starts a new explicit goal at generation one", () => {
  const workOrder = workOrderFixture();
  const notSent = effectFixture({
    effectId: "effect:input-not-sent",
    effectKind: "provider.user_input.submit",
    status: "not_sent",
    requestId: "request:one",
    responseRef: { id: "response:first", hash: "1".repeat(64) },
  });
  const changedResponse = effectFixture({
    effectId: "effect:input-changed",
    effectKind: "provider.user_input.submit",
    status: "pending",
    requestId: "request:one",
    responseRef: { id: "response:changed", hash: "2".repeat(64) },
  });
  const snapshot = snapshotFor(workOrder, [notSent, changedResponse]);
  const goals = snapshot.branches["branch:one"].operation_goals;

  assert.equal(goals.length, 2);
  assert.ok(goals.every((goal) => goal.latest_generation === 1));
  assert.doesNotThrow(() => assertLifecycleInvariants(snapshot));
});

test("the same operation scope requires an explicit next generation", () => {
  const workOrder = workOrderFixture();
  const notSent = effectFixture({
    effectId: "effect:cancel-first",
    effectKind: "provider.turn.cancel",
    status: "not_sent",
  });
  const unlinked = effectFixture({
    effectId: "effect:cancel-unlinked",
    effectKind: "provider.turn.cancel",
    status: "pending",
  });
  const snapshot = snapshotFor(workOrder, [notSent, unlinked]);

  assert.throws(
    () => assertLifecycleInvariants(snapshot),
    (error) => error.details.violations.some((violation) => (
      violation.code === "operation_generation_duplicate"
    )),
  );
});

test("explicit lineage rejects orphan, gap, fork, and cycle", () => {
  const workOrder = workOrderFixture();
  const root = effectFixture({
    effectId: "effect:root",
    effectKind: "provider.turn.cancel",
    status: "not_sent",
  });
  const orphan = effectFixture({
    effectId: "effect:orphan",
    effectKind: "provider.turn.cancel",
    status: "pending",
    operationGeneration: 2,
    generationPredecessorEffectId: "effect:missing",
  });
  const orphanSnapshot = snapshotFor(workOrder, [orphan]);
  assert.ok(orphanSnapshot.violations.some((entry) => (
    entry.code === "operation_generation_predecessor_orphaned"
  )));

  const gap = effectFixture({
    effectId: "effect:gap",
    effectKind: "provider.turn.cancel",
    status: "pending",
    operationGeneration: 3,
    generationPredecessorEffectId: root.effect_id,
  });
  const gapSnapshot = snapshotFor(workOrder, [root, gap]);
  assert.ok(gapSnapshot.violations.some((entry) => entry.code === "operation_generation_gap"));

  const forkOne = effectFixture({
    effectId: "effect:fork-one",
    effectKind: "provider.turn.cancel",
    status: "pending",
    operationGeneration: 2,
    generationPredecessorEffectId: root.effect_id,
  });
  const forkTwo = effectFixture({
    effectId: "effect:fork-two",
    effectKind: "provider.turn.cancel",
    status: "pending",
    operationGeneration: 2,
    generationPredecessorEffectId: root.effect_id,
  });
  const forkSnapshot = snapshotFor(workOrder, [root, forkOne, forkTwo]);
  assert.ok(forkSnapshot.violations.some((entry) => entry.code === "operation_generation_fork"));

  const cycleOne = effectFixture({
    effectId: "effect:cycle-one",
    effectKind: "provider.turn.cancel",
    status: "not_sent",
    generationPredecessorEffectId: "effect:cycle-two",
  });
  const cycleTwo = effectFixture({
    effectId: "effect:cycle-two",
    effectKind: "provider.turn.cancel",
    status: "pending",
    operationGeneration: 2,
    generationPredecessorEffectId: cycleOne.effect_id,
  });
  const cycleSnapshot = snapshotFor(workOrder, [cycleOne, cycleTwo]);
  assert.ok(cycleSnapshot.violations.some((entry) => entry.code === "operation_generation_cycle"));
});

test("cleanup rollup does not revoke an unrelated failed branch retry candidate", () => {
  const unknownBranch = branchFixture({
    branchRef: "branch:unknown",
    dispatchId: "dispatch:unknown:1",
    state: "delivery_unknown",
  });
  const failedBranch = branchFixture({
    branchRef: "branch:failed",
    dispatchId: "dispatch:failed:1",
    state: "failed",
  });
  const workOrder = workOrderFixture({
    status: "paused",
    branches: [unknownBranch, failedBranch],
  });
  const unknown = effectFixture({
    effectId: "effect:unknown",
    branchRef: unknownBranch.branch_ref,
    dispatchId: unknownBranch.dispatch_id,
  });
  const snapshot = snapshotFor(workOrder, [unknown], [recoveryAttention(unknown)]);

  assert.equal(snapshot.automation.state, "cleanup_hold");
  assert.equal(snapshot.branches["branch:unknown"].cleanup_blocked, true);
  assert.equal(snapshot.branches["branch:failed"].cleanup_blocked, false);
  assert.equal(snapshot.branches["branch:failed"].retry_candidate, true);
  assert.equal(snapshot.branches["branch:failed"].lifecycle_retry_clear, true);
  assert.equal(snapshot.automation.may_retry, true);
  assert.doesNotThrow(() => assertLifecycleInvariants(snapshot));
});

test("a successor cannot hide an older unresolved generation", () => {
  const workOrder = workOrderFixture();
  const unresolved = effectFixture({
    effectId: "effect:unresolved",
    status: "pending",
  });
  const falseSettlement = effectFixture({
    effectId: "effect:false-successor",
    originSourceId: "source:false-successor",
    idempotencyKey: "idempotency:false-successor",
    status: "delivered",
    createdAt: "2026-08-09T00:00:01.000Z",
    operationGeneration: 2,
    generationPredecessorEffectId: unresolved.effect_id,
  });
  const snapshot = snapshotFor(workOrder, [unresolved, falseSettlement]);

  assert.equal(snapshot.automation.state, "invalid");
  assert.throws(
    () => assertLifecycleInvariants(snapshot),
    (error) => error.details.violations.some((violation) => (
      violation.code === "operation_generation_predecessor_not_retryable"
        && violation.generation_predecessor_effect_id === unresolved.effect_id
    )),
  );
});

test("a terminal lane epoch and a later operation remain distinct goals", () => {
  const workOrder = workOrderFixture();
  const deliveredInput = effectFixture({
    effectId: "effect:first-input",
    effectKind: "provider.user_input.submit",
    status: "delivered",
  });
  const laterInput = effectFixture({
    effectId: "effect:later-input",
    effectKind: "provider.user_input.submit",
    originSourceId: "source:later-input",
    idempotencyKey: "idempotency:later-input",
    packetRef: "packet:later-input",
    packetHash: "c".repeat(64),
    requestId: "request:two",
    responseRef: { id: "response:two", hash: "e".repeat(64) },
    status: "not_sent",
    createdAt: "2026-08-09T00:00:01.000Z",
  });
  const snapshot = snapshotFor(workOrder, [deliveredInput, laterInput]);
  const goals = snapshot.branches["branch:one"].operation_goals;

  assert.equal(goals.length, 2);
  assert.deepEqual(
    goals.map((goal) => [goal.terminal, goal.disposition]).sort(),
    [[false, "retryable"], [true, "achieved"]].sort(),
  );
  assert.doesNotThrow(() => assertLifecycleInvariants(snapshot));
});

test("V2 closure rejects version and durable map identity drift", () => {
  const workOrder = workOrderFixture();
  const effect = effectFixture();
  effect.effect_contract_version = 1;
  const snapshot = deriveLifecycleSnapshot({
    workOrder,
    outbox: { "effect:wrong-map-key": effect },
    attention: {},
  });

  assert.throws(
    () => assertLifecycleInvariants(snapshot),
    (error) => {
      const codes = error.details.violations.map((violation) => violation.code);
      assert.ok(codes.includes("effect_contract_version_mismatch"));
      assert.ok(codes.includes("effect_map_identity_mismatch"));
      return true;
    },
  );
});

test("the public branch derivation does not interpret an unknown engine version as V2", () => {
  const branch = branchFixture();
  const workOrder = workOrderFixture({ engineContractVersion: 3, branches: [branch] });
  const snapshot = deriveBranchLifecycleSnapshot({
    workOrder,
    branch,
    outbox: {},
    attention: {},
  });

  assert.equal(snapshot.mode, "unsupported");
  assert.throws(
    () => assertLifecycleInvariants(snapshot),
    (error) => error.details.violations[0].code === "engine_contract_version_unsupported",
  );
});

test("recovery attention cannot remain open on a settled effect", () => {
  const workOrder = workOrderFixture();
  const effect = effectFixture({ status: "delivered" });
  const snapshot = snapshotFor(workOrder, [effect], [recoveryAttention(effect)]);

  assert.throws(
    () => assertLifecycleInvariants(snapshot),
    (error) => error.details.violations.some((violation) => (
      violation.code === "recovery_attention_effect_not_recoverable"
    )),
  );
});
