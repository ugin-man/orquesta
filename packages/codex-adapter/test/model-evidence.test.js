const test = require("node:test");
const assert = require("node:assert/strict");

const { createModelEvidence } = require("../src/model-evidence");

function observed(model = "observed-model", ref = "artifact:model-observation") {
  return {
    source: "app_server",
    event_kind: "model_observed",
    actual_model: model,
    payload_ref: ref
  };
}

test("keeps recommendation, request, and applied configuration separate", () => {
  assert.deepEqual(createModelEvidence({ recommended: "recommended-model" }), {
    recommended_model: "recommended-model",
    requested_model: null,
    applied_model: null,
    actual_model: null,
    actual_model_evidence_ref: null
  });
  assert.deepEqual(createModelEvidence({ requested: "requested-model" }), {
    recommended_model: null,
    requested_model: "requested-model",
    applied_model: null,
    actual_model: null,
    actual_model_evidence_ref: null
  });
  assert.deepEqual(createModelEvidence({ applied: "applied-model" }), {
    recommended_model: null,
    requested_model: null,
    applied_model: "applied-model",
    actual_model: null,
    actual_model_evidence_ref: null
  });
});

test("only an explicit App Server model observation populates actual model", () => {
  assert.deepEqual(createModelEvidence({
    recommended: "recommended-model",
    requested: "requested-model",
    applied: "applied-model",
    runtimeEvent: observed()
  }), {
    recommended_model: "recommended-model",
    requested_model: "requested-model",
    applied_model: "applied-model",
    actual_model: "observed-model",
    actual_model_evidence_ref: "artifact:model-observation"
  });
});

test("does not infer actual model from missing, unrelated, or fallback events", () => {
  const cases = [
    undefined,
    { source: "app_server", event_kind: "turn_started", actual_model: "not-proof", payload_ref: "artifact:turn" },
    { source: "sdk", event_kind: "model_observed", actual_model: "not-independent", payload_ref: "artifact:sdk" },
    { source: "repository_only", event_kind: "model_observed", actual_model: "not-runtime", payload_ref: "artifact:repo" }
  ];

  for (const runtimeEvent of cases) {
    const evidence = createModelEvidence({
      recommended: "same-model",
      requested: "same-model",
      applied: "same-model",
      runtimeEvent
    });
    assert.equal(evidence.actual_model, null);
    assert.equal(evidence.actual_model_evidence_ref, null);
  }
});

test("rejects malformed or conflicting explicit model observations", () => {
  assert.throws(
    () => createModelEvidence({ runtimeEvent: { ...observed(), payload_ref: null } }),
    /evidence ref/
  );
  assert.throws(
    () => createModelEvidence({ runtimeEvent: [observed("model-a", "artifact:a"), observed("model-b", "artifact:b")] }),
    /conflicting model observations/
  );
});

test("accepts an approved hook observation but not a hook label alone", () => {
  const runtimeEvent = {
    source: "approved_hook",
    event_kind: "model_observed",
    actual_model: "hook-model",
    payload_ref: "artifact:hook-model"
  };
  const evidence = createModelEvidence({ runtimeEvent });
  assert.equal(evidence.actual_model, "hook-model");
  assert.equal(evidence.actual_model_evidence_ref, "artifact:hook-model");

  const missing = createModelEvidence({
    runtimeEvent: { source: "approved_hook", event_kind: "turn_started" }
  });
  assert.equal(missing.actual_model, null);
});
