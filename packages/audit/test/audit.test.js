"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { assertContract } = require("@orquesta/contracts");
const { WEIGHTS_V1, auditCandidate, evaluateCandidate, scoreCandidate } = require("../src");

const need = {
  need_id: "CN-AUDIT-001",
  description: "Browser verification evidence",
  kind: "evidence",
  required_level: "required",
  hard_constraints: [],
  dependencies: [],
  verification_method: "Record a repeatable local browser check",
  status: "open",
  confidence: 100,
};

function axes(value = 80) {
  return {
    task_fit: { value, reason: "fixture task fit" },
    integration_ease: { value, reason: "fixture runtime" },
    evidence_strength: { value, reason: "fixture evidence" },
    maintainability: { value, reason: "fixture maintenance" },
    security: { value, reason: "fixture metadata" },
    license_fit: { value, reason: "fixture license" },
    exit_option: { value, reason: "fixture removal" },
    cost: { value, reason: "fixture cost" },
  };
}

function candidate(overrides = {}) {
  return {
    provider_id: "fixture-browser-check",
    provider_type: "fixture",
    source_uri: "fixture:browser-check",
    capabilities: ["browser verification evidence"],
    trust_tier: "local",
    availability: "available",
    version: "1.0.0",
    evidence_refs: ["fixture:browser-check"],
    static_metadata: {
      license: "MIT",
      runtime: "compatible",
      security: "no_critical_finding",
    },
    axes: axes(),
    uncertainty_penalty: 5,
    ...overrides,
  };
}

test("audit uses immutable weights, two-decimal contribution evidence, and a schema-valid evaluation", () => {
  assert.deepEqual(WEIGHTS_V1, {
    task_fit: 30,
    integration_ease: 15,
    evidence_strength: 15,
    maintainability: 10,
    security: 10,
    license_fit: 10,
    exit_option: 5,
    cost: 5,
  });
  assert.equal(Object.isFrozen(WEIGHTS_V1), true);

  const result = auditCandidate({ candidate: candidate({ axes: axes(98), uncertainty_penalty: 10 }), need });
  assert.equal(result.audit_mode, "phase1_static_metadata");
  assert.equal(result.evaluation.weighted_sum, 98);
  assert.equal(result.evaluation.candidate_score, 88);
  assert.equal(result.score_contributions.task_fit, "29.40");
  assert.equal(result.score_contributions.cost, "4.90");
  assert.equal(result.evaluation.eligibility, "eligible");
  assert.equal(result.evaluation.actual_model, null);
  assert.deepEqual(result.responsibility, {
    scout: "candidate_and_evidence_only",
    audit: "metadata_checks_only",
    audition: "disabled_until_phase2",
    orchestrator: "proposal_and_evidence_reconciliation",
    user: "all_phase1_adoption_approval",
  });
  assert.doesNotThrow(() => assertContract("candidate-evaluation", result.evaluation));
  assert.doesNotThrow(() => assertContract("candidate-evaluation", evaluateCandidate({ candidate: candidate(), need })));

  const score = scoreCandidate({ axes: axes(98), uncertaintyPenalty: 10 });
  assert.equal(score.contributions.task_fit, "29.40");
  assert.equal(score.weighted_sum, 98);
  assert.equal(score.candidate_score, 88);
});

test("audit clamps below zero and rejects axis values above one hundred", () => {
  const low = evaluateCandidate({ candidate: candidate({ axes: axes(0), uncertainty_penalty: 100 }), need });
  assert.equal(low.weighted_sum, 0);
  assert.equal(low.candidate_score, 0);
  assert.throws(
    () => evaluateCandidate({ candidate: candidate({ axes: { ...axes(), task_fit: { value: 101, reason: "invalid" } } }), need }),
    (error) => error && error.code === "AUDIT_AXIS_VALUE_INVALID",
  );
});

test("audit evaluates hard gates before it rejects an invalid score axis", () => {
  let licenseRead = false;
  const metadata = new Proxy({ license: "unknown", runtime: "compatible", security: "no_critical_finding" }, {
    get(target, key, receiver) {
      if (key === "license") licenseRead = true;
      return Reflect.get(target, key, receiver);
    },
  });
  assert.throws(
    () => evaluateCandidate({ candidate: candidate({ static_metadata: metadata, axes: { ...axes(), task_fit: { value: 101, reason: "invalid" } } }), need }),
    (error) => error && error.code === "AUDIT_AXIS_VALUE_INVALID",
  );
  assert.equal(licenseRead, true);
});

test("audit separates static hard rejection from pending user decisions without keyword inference", () => {
  const rejected = [
    ["security", candidate({ static_metadata: { license: "MIT", runtime: "compatible", security: "critical" } })],
    ["license", candidate({ static_metadata: { license: "unknown", runtime: "compatible", security: "no_critical_finding" } })],
    ["license", candidate({ static_metadata: { license: "forbidden", runtime: "compatible", security: "no_critical_finding" } })],
    ["runtime", candidate({ static_metadata: { license: "MIT", runtime: "incompatible", security: "no_critical_finding" } })],
    ["accessibility", candidate({ static_metadata: { license: "MIT", runtime: "compatible", security: "no_critical_finding", accessibility: "unmet" } })],
  ];
  for (const [gate, item] of rejected) {
    const auditedNeed = gate === "accessibility" ? { ...need, hard_constraints: ["accessibility_required"] } : need;
    const evaluation = evaluateCandidate({ candidate: item, need: auditedNeed });
    assert.equal(evaluation.eligibility, "ineligible", gate);
    assert.ok(evaluation.hard_gate_results.some((result) => result.gate === gate && result.status === "fail"), gate);
  }

  for (const field of ["payment", "login", "secret", "external_send"]) {
    const evaluation = evaluateCandidate({
      candidate: candidate({ static_metadata: { license: "MIT", runtime: "compatible", security: "no_critical_finding", [field]: true } }),
      need,
    });
    assert.equal(evaluation.eligibility, "blocked", field);
    assert.ok(evaluation.hard_gate_results.some((result) => result.gate === field && result.status === "blocked"), field);
  }

  const nameOnly = auditCandidate({ candidate: candidate({ provider_id: "safe-secure-package", static_metadata: {} }), need });
  assert.equal(nameOnly.evaluation.eligibility, "ineligible");
  assert.ok(nameOnly.unknowns.includes("license"));
  assert.equal(nameOnly.facts.some((fact) => /safe|secure/i.test(fact)), false);
});

test("audit treats the exact license unknown code as a hard license failure without broad unknown heuristics", () => {
  const licenseUnknown = evaluateCandidate({
    candidate: candidate({ unknowns: ["license"] }),
    need,
  });
  assert.equal(licenseUnknown.eligibility, "ineligible");
  assert.ok(licenseUnknown.hard_gate_results.some((result) => result.gate === "license" && result.status === "fail"));

  const otherUnknowns = evaluateCandidate({
    candidate: candidate({ unknowns: ["runtime", "security", "license_notes"] }),
    need,
  });
  assert.equal(otherUnknowns.eligibility, "eligible");
  assert.ok(otherUnknowns.hard_gate_results.every((result) => result.status !== "fail"));
});
