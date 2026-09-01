"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  BusinessSettlementPolicyError,
  V2_SETTLEMENT_CLASSIFICATIONS,
  V2_SETTLEMENT_DISPOSITIONS,
  V2_SETTLEMENT_EFFECT_STAGES,
  V2_SETTLEMENT_REASONS,
  V2_SETTLEMENT_RETRY_MODES,
  V2_SETTLEMENT_RETRY_SCOPES,
  V2_SETTLEMENT_SOURCES,
  deriveEffectGenerationRetryScheduleV2,
  deriveSettlementDispositionV2,
  isAutomaticEffectGenerationCandidateV2,
  isGenerationSuccessorCandidateV2,
} = require("../src/settlement-policy");

const EFFECTS = Object.entries(V2_SETTLEMENT_EFFECT_STAGES).map(
  ([effect_kind, effect_stage]) => ({ effect_kind, effect_stage }),
);

const REASON_EXPECTATIONS = Object.freeze({
  provider_acknowledged: ["worker_result", "accepted", "terminal", "none"],
  provider_rejected_no_mutation: [
    "worker_result",
    "not_sent",
    "retry_candidate",
    "explicit",
  ],
  provider_boundary_not_entered: ["worker_result", "not_sent", "retry_candidate", "stage_default"],
  provider_deferred_no_mutation: ["worker_result", "not_sent", "retry_candidate", "stage_default"],
  packet_integrity_failed: ["control_plane", "not_sent", "operator_attention", "none"],
  authority_failed: ["control_plane", "not_sent", "operator_attention", "none"],
  driver_capability_failed: ["control_plane", "not_sent", "operator_attention", "none"],
  worker_transport_ambiguous: [
    "worker_result",
    "delivery_unknown",
    "reconciliation_required",
    "none",
  ],
  worker_send_expired: [
    "control_plane",
    "delivery_unknown",
    "reconciliation_required",
    "none",
  ],
  recovery_probe_found: ["recovery_probe", "accepted", "terminal", "none"],
  recovery_probe_authoritative_absence: [
    "recovery_probe",
    "not_sent",
    "retry_candidate",
    "explicit",
  ],
  recovery_probe_inconclusive: [
    "recovery_probe",
    "delivery_unknown",
    "reconciliation_required",
    "none",
  ],
});

function certaintyFact(overrides = {}) {
  return {
    certainty_fact_version: 2,
    effect_contract_version: 2,
    effect_kind: "provider.turn.start",
    effect_stage: "turn_start",
    settlement_source: "worker_result",
    classification: "accepted",
    reason: "provider_acknowledged",
    ...overrides,
  };
}

function expectedPolicy(reason, stage) {
  const [,, disposition, configuredMode] = REASON_EXPECTATIONS[reason];
  const mode = configuredMode === "stage_default"
    ? (["thread_create", "turn_start"].includes(stage) ? "automatic" : "explicit")
    : configuredMode;
  return {
    disposition,
    retry: {
      scope: disposition === "retry_candidate" ? "effect_generation" : "none",
      mode,
    },
  };
}

function isPolicyError(expectedReason = null) {
  return (error) => {
    assert.ok(error instanceof BusinessSettlementPolicyError);
    assert.equal(error.code, "BUSINESS_SETTLEMENT_POLICY_INVALID");
    if (expectedReason !== null) assert.equal(error.reason, expectedReason);
    return true;
  };
}

test("the complete source/classification/reason/effect cross-product is fail-closed", () => {
  let validCases = 0;
  let invalidCases = 0;

  for (const settlementSource of V2_SETTLEMENT_SOURCES) {
    for (const classification of V2_SETTLEMENT_CLASSIFICATIONS) {
      for (const reason of V2_SETTLEMENT_REASONS) {
        for (const effect of EFFECTS) {
          const fact = certaintyFact({
            ...effect,
            settlement_source: settlementSource,
            classification,
            reason,
          });
          const [expectedSource, expectedClassification] = REASON_EXPECTATIONS[reason];
          if (settlementSource !== expectedSource || classification !== expectedClassification) {
            invalidCases += 1;
            assert.throws(() => deriveSettlementDispositionV2(fact), isPolicyError());
            continue;
          }

          validCases += 1;
          const result = deriveSettlementDispositionV2(fact);
          const expected = expectedPolicy(reason, effect.effect_stage);
          assert.equal(result.disposition, expected.disposition);
          assert.equal(result.settlement_source, settlementSource);
          assert.equal(result.classification, classification);
          assert.equal(result.reason, reason);
          assert.equal(result.effect_kind, effect.effect_kind);
          assert.equal(result.effect_stage, effect.effect_stage);
          assert.equal(
            result.retry.scope,
            expected.retry.scope,
          );
          assert.equal(
            result.retry.mode,
            expected.retry.mode,
          );
          assert.equal(
            isGenerationSuccessorCandidateV2(fact),
            result.retry.scope === "effect_generation",
          );
          assert.equal(
            isAutomaticEffectGenerationCandidateV2(fact),
            result.retry.mode === "automatic",
          );
        }
      }
    }
  }

  assert.equal(validCases, V2_SETTLEMENT_REASONS.length * EFFECTS.length);
  assert.equal(
    invalidCases,
    V2_SETTLEMENT_SOURCES.length
      * V2_SETTLEMENT_CLASSIFICATIONS.length
      * V2_SETTLEMENT_REASONS.length
      * EFFECTS.length
      - validCases,
  );
});

test("normal start, input, and cancel settlements derive policy instead of accepting it", () => {
  const startFact = certaintyFact({
    reason: "provider_deferred_no_mutation",
    classification: "not_sent",
  });
  const start = deriveSettlementDispositionV2(startFact);
  assert.equal(start.disposition, "retry_candidate");
  assert.deepEqual(start.retry, { scope: "effect_generation", mode: "automatic" });
  assert.equal(isGenerationSuccessorCandidateV2(startFact), true);
  assert.equal(isAutomaticEffectGenerationCandidateV2(startFact), true);

  const rejectedStartFact = certaintyFact({
    reason: "provider_rejected_no_mutation",
    classification: "not_sent",
  });
  const rejectedStart = deriveSettlementDispositionV2(rejectedStartFact);
  assert.equal(rejectedStart.disposition, "retry_candidate");
  assert.deepEqual(rejectedStart.retry, { scope: "effect_generation", mode: "explicit" });
  assert.equal(isGenerationSuccessorCandidateV2(rejectedStartFact), true);
  assert.equal(isAutomaticEffectGenerationCandidateV2(rejectedStartFact), false);

  const inputFact = certaintyFact({
    effect_kind: "provider.user_input.submit",
    effect_stage: "user_input_submit",
    reason: "provider_rejected_no_mutation",
    classification: "not_sent",
  });
  const input = deriveSettlementDispositionV2(inputFact);
  assert.equal(input.disposition, "retry_candidate");
  assert.deepEqual(input.retry, { scope: "effect_generation", mode: "explicit" });
  assert.equal(isGenerationSuccessorCandidateV2(inputFact), true);
  assert.equal(isAutomaticEffectGenerationCandidateV2(inputFact), false);

  const cancelFact = certaintyFact({
    effect_kind: "provider.turn.cancel",
    effect_stage: "turn_cancel",
    reason: "worker_transport_ambiguous",
    classification: "delivery_unknown",
  });
  const cancel = deriveSettlementDispositionV2(cancelFact);
  assert.equal(cancel.disposition, "reconciliation_required");
  assert.equal(isGenerationSuccessorCandidateV2(cancelFact), false);
  assert.equal(isAutomaticEffectGenerationCandidateV2(cancelFact), false);

  const acceptedInput = deriveSettlementDispositionV2(certaintyFact({
    effect_kind: "provider.user_input.submit",
    effect_stage: "user_input_submit",
  }));
  assert.equal(acceptedInput.disposition, "terminal");
  assert.deepEqual(acceptedInput.retry, { scope: "none", mode: "none" });
});

test("packet, authority, and driver failures never become retry candidates", () => {
  for (const reason of [
    "packet_integrity_failed",
    "authority_failed",
    "driver_capability_failed",
  ]) {
    for (const effect of EFFECTS) {
      const fact = certaintyFact({
        ...effect,
        settlement_source: "control_plane",
        classification: "not_sent",
        reason,
      });
      const result = deriveSettlementDispositionV2(fact);
      assert.equal(result.classification, "not_sent");
      assert.equal(result.disposition, "operator_attention");
      assert.deepEqual(result.retry, { scope: "none", mode: "none" });
      assert.equal(isGenerationSuccessorCandidateV2(fact), false);
      assert.equal(isAutomaticEffectGenerationCandidateV2(fact), false);
    }
  }
});

test("worker callbacks cannot assert control-plane failure or expiry reasons", () => {
  for (const [reason, classification] of [
    ["packet_integrity_failed", "not_sent"],
    ["authority_failed", "not_sent"],
    ["driver_capability_failed", "not_sent"],
    ["worker_send_expired", "delivery_unknown"],
  ]) {
    assert.throws(
      () => deriveSettlementDispositionV2(certaintyFact({
        settlement_source: "worker_result",
        classification,
        reason,
      })),
      isPolicyError("source_reason_mismatch"),
    );
  }

  const expired = deriveSettlementDispositionV2(certaintyFact({
    settlement_source: "control_plane",
    classification: "delivery_unknown",
    reason: "worker_send_expired",
  }));
  assert.equal(expired.disposition, "reconciliation_required");
  assert.deepEqual(expired.retry, { scope: "none", mode: "none" });
});

test("recovery absence permits a generation without reopening a whole branch attempt", () => {
  for (const effect of EFFECTS) {
    const absentFact = certaintyFact({
      ...effect,
      settlement_source: "recovery_probe",
      classification: "not_sent",
      reason: "recovery_probe_authoritative_absence",
    });
    const absent = deriveSettlementDispositionV2(absentFact);
    assert.equal(absent.disposition, "retry_candidate");
    assert.deepEqual(absent.retry, { scope: "effect_generation", mode: "explicit" });
    assert.equal(isGenerationSuccessorCandidateV2(absentFact), true);
    assert.equal(isAutomaticEffectGenerationCandidateV2(absentFact), false);

    const found = deriveSettlementDispositionV2(certaintyFact({
      ...effect,
      settlement_source: "recovery_probe",
      classification: "accepted",
      reason: "recovery_probe_found",
    }));
    assert.equal(found.disposition, "terminal");

    const inconclusive = deriveSettlementDispositionV2(certaintyFact({
      ...effect,
      settlement_source: "recovery_probe",
      classification: "delivery_unknown",
      reason: "recovery_probe_inconclusive",
    }));
    assert.equal(inconclusive.disposition, "reconciliation_required");
  }
});

test("unversioned and V1 settlement records remain uninterpreted replay data", () => {
  const unversioned = certaintyFact();
  delete unversioned.effect_contract_version;
  assert.throws(
    () => deriveSettlementDispositionV2(unversioned),
    isPolicyError("missing_field"),
  );
  assert.throws(
    () => deriveSettlementDispositionV2(certaintyFact({ effect_contract_version: 1 })),
    isPolicyError("effect_contract_version"),
  );
  assert.throws(
    () => deriveSettlementDispositionV2(certaintyFact({ certainty_fact_version: 1 })),
    isPolicyError("version"),
  );
});

test("future values and inconsistent immutable bindings fail with typed errors", () => {
  assert.throws(
    () => deriveSettlementDispositionV2(certaintyFact({ certainty_fact_version: 3 })),
    isPolicyError("version"),
  );
  assert.throws(
    () => deriveSettlementDispositionV2(certaintyFact({ effect_contract_version: 3 })),
    isPolicyError("effect_contract_version"),
  );
  assert.throws(
    () => deriveSettlementDispositionV2(certaintyFact({ settlement_source: "future_probe" })),
    isPolicyError("unknown_value"),
  );
  assert.throws(
    () => deriveSettlementDispositionV2(certaintyFact({ classification: "maybe_sent" })),
    isPolicyError("unknown_value"),
  );
  assert.throws(
    () => deriveSettlementDispositionV2(certaintyFact({ reason: "provider_says_retry" })),
    isPolicyError("unknown_value"),
  );
  assert.throws(
    () => deriveSettlementDispositionV2(certaintyFact({
      effect_kind: "provider.future.mutation",
      effect_stage: "future_mutation",
    })),
    isPolicyError("unknown_value"),
  );
  assert.throws(
    () => deriveSettlementDispositionV2(certaintyFact({ effect_stage: "thread_create" })),
    isPolicyError("effect_stage_mismatch"),
  );
  assert.throws(
    () => deriveSettlementDispositionV2(certaintyFact({
      settlement_source: "recovery_probe",
    })),
    isPolicyError("source_reason_mismatch"),
  );
  assert.throws(
    () => deriveSettlementDispositionV2(certaintyFact({ classification: "not_sent" })),
    isPolicyError("classification_reason_mismatch"),
  );
});

test("hostile objects cannot inject a disposition or execute accessors", () => {
  assert.throws(() => deriveSettlementDispositionV2(null), isPolicyError("object"));
  assert.throws(() => deriveSettlementDispositionV2([]), isPolicyError("object"));
  assert.throws(
    () => deriveSettlementDispositionV2(Object.assign(Object.create({ inherited: true }), certaintyFact())),
    isPolicyError("object"),
  );
  assert.throws(
    () => deriveSettlementDispositionV2({
      ...certaintyFact(),
      disposition: "retry_candidate",
    }),
    isPolicyError("unknown_field"),
  );
  assert.throws(
    () => deriveSettlementDispositionV2({
      ...certaintyFact(),
      retry: { scope: "effect_generation", mode: "automatic" },
    }),
    isPolicyError("unknown_field"),
  );

  let getterCalled = false;
  const accessor = certaintyFact();
  Object.defineProperty(accessor, "reason", {
    enumerable: true,
    get() {
      getterCalled = true;
      return "provider_acknowledged";
    },
  });
  assert.throws(() => deriveSettlementDispositionV2(accessor), isPolicyError("data_property"));
  assert.equal(getterCalled, false);

  const symbolField = certaintyFact();
  symbolField[Symbol("disposition")] = "retry_candidate";
  assert.throws(
    () => deriveSettlementDispositionV2(symbolField),
    isPolicyError("unknown_field"),
  );

  const hostileProxy = new Proxy({}, {
    getPrototypeOf() {
      throw new Error("hostile trap");
    },
  });
  assert.throws(() => deriveSettlementDispositionV2(hostileProxy), isPolicyError("object"));
});

test("derived outputs are deterministic, isolated from input, and deeply frozen", () => {
  const firstInput = certaintyFact({
    classification: "not_sent",
    reason: "provider_boundary_not_entered",
  });
  const reversedInput = Object.fromEntries(Object.entries(firstInput).reverse());
  const first = deriveSettlementDispositionV2(firstInput);
  const second = deriveSettlementDispositionV2(reversedInput);

  assert.deepEqual(first, second);
  assert.notEqual(first, second);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.retry));
  assert.ok(Object.isFrozen(V2_SETTLEMENT_SOURCES));
  assert.ok(Object.isFrozen(V2_SETTLEMENT_CLASSIFICATIONS));
  assert.ok(Object.isFrozen(V2_SETTLEMENT_REASONS));
  assert.ok(Object.isFrozen(V2_SETTLEMENT_DISPOSITIONS));
  assert.ok(Object.isFrozen(V2_SETTLEMENT_EFFECT_STAGES));
  assert.ok(Object.isFrozen(V2_SETTLEMENT_RETRY_SCOPES));
  assert.ok(Object.isFrozen(V2_SETTLEMENT_RETRY_MODES));

  firstInput.reason = "packet_integrity_failed";
  assert.equal(first.reason, "provider_boundary_not_entered");
  assert.throws(() => {
    first.disposition = "operator_attention";
  }, TypeError);
  assert.throws(() => {
    first.retry.mode = "explicit";
  }, TypeError);
});

test("retry predicates rederive trusted facts and reject caller-selected dispositions", () => {
  assert.throws(() => isGenerationSuccessorCandidateV2(null), isPolicyError("object"));
  assert.throws(
    () => isAutomaticEffectGenerationCandidateV2({
      policy_version: 3,
      disposition: "retry_candidate",
    }),
    isPolicyError("unknown_field"),
  );
  assert.throws(
    () => isGenerationSuccessorCandidateV2({
      ...certaintyFact(),
      disposition: "retry_candidate",
    }),
    isPolicyError("unknown_field"),
  );
});

test("Effect-generation schedule is one shared function of policy, generation, and deadlines", () => {
  const automatic = deriveSettlementDispositionV2(certaintyFact({
    classification: "not_sent",
    reason: "provider_deferred_no_mutation",
  }));
  const input = {
    settlement_policy: automatic,
    retry_policy: {
      backoff_initial_ms: 1_000,
      backoff_max_ms: 10_000,
      max_attempts: 3,
    },
    completed_generation: 2,
    settled_at: "2026-08-09T00:00:01.000Z",
    attempt_deadline_at: "2026-08-09T00:00:10.000Z",
    work_order_deadline_at: "2026-08-09T00:01:00.000Z",
  };
  assert.deepEqual(deriveEffectGenerationRetryScheduleV2(input), {
    eligible_at: "2026-08-09T00:00:03.000Z",
    delay_ms: 2_000,
    next_generation: 3,
    automatic: true,
    permitted: true,
  });
  assert.equal(deriveEffectGenerationRetryScheduleV2({
    ...input,
    completed_generation: 3,
  }).permitted, false);
  assert.equal(deriveEffectGenerationRetryScheduleV2({
    ...input,
    attempt_deadline_at: "2026-08-09T00:00:03.000Z",
  }).permitted, false);

  const explicit = deriveSettlementDispositionV2(certaintyFact({
    classification: "not_sent",
    reason: "provider_rejected_no_mutation",
  }));
  assert.deepEqual(deriveEffectGenerationRetryScheduleV2({
    ...input,
    settlement_policy: explicit,
    completed_generation: 1,
  }), {
    eligible_at: input.settled_at,
    delay_ms: 0,
    next_generation: 2,
    automatic: false,
    permitted: true,
  });
});
