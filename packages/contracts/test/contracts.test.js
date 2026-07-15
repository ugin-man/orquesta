const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  SCHEMA_NAMES,
  canonicalJson,
  canonicalHash,
  loadSchema,
  validateContract,
  assertContract,
  validatePhaseApprovalBinding
} = require("../src");

const hash = "a".repeat(64);
const laterHash = "b".repeat(64);
const timestamp = "2026-07-15T00:00:00.000Z";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

const taskIntent = {
  task_intent_id: "TI-local-reuse",
  raw_request_ref: "fixture:local-reuse",
  desired_outcome: "Reuse a local helper safely.",
  acceptance_criteria: ["A source hash is recorded."],
  constraints: ["No network"],
  risk: { impact: "low", reversible: true },
  authority_boundary: { agent_may: ["propose"], user_only: ["approve"] },
  assumptions: [],
  status: "compiled"
};

const capabilityNeed = {
  need_id: "NEED-contracts",
  description: "Validate a deterministic contract.",
  kind: "code",
  required_level: "required",
  hard_constraints: ["No external dependency"],
  dependencies: [],
  verification_method: "node:test",
  status: "open",
  confidence: 80
};

const capabilityProvider = {
  provider_id: "PROVIDER-local",
  provider_type: "local_code",
  source_uri: "file:packages/contracts",
  capabilities: ["validation"],
  trust_tier: "local",
  availability: "available",
  version: "0.4.0-preview.1",
  last_verified_at: timestamp,
  evidence_refs: ["fixture:provider"]
};

const axes = Object.fromEntries([
  "task_fit",
  "integration_ease",
  "evidence_strength",
  "maintainability",
  "security",
  "license_fit",
  "exit_option",
  "cost"
].map((name) => [name, { value: 80, reason: `${name} fixture evidence` }]));

const candidateEvaluation = {
  evaluation_id: "CE-local",
  need_id: capabilityNeed.need_id,
  candidate_id: capabilityProvider.provider_id,
  policy_version: "phase1-v1",
  axes,
  uncertainty_penalty: 5,
  weighted_sum: 80,
  candidate_score: 75,
  hard_gate_results: [{ gate: "license", status: "pass", reason: "local fixture" }],
  eligibility: "eligible",
  actual_model: null
};

const audition = {
  audition_id: "AUD-local",
  candidate_id: capabilityProvider.provider_id,
  hypothesis: "The local fixture validates deterministically.",
  sandbox: "temp",
  steps: ["run test"],
  expected_evidence: ["pass"],
  observed_evidence: ["pass"],
  side_effects: [],
  verdict: "pass",
  cleanup_status: "clean"
};

const resolution = {
  resolution_id: "RES-local",
  need_id: capabilityNeed.need_id,
  mode: "reuse",
  status: "proposed",
  selected_provider_id: capabilityProvider.provider_id,
  rejected_provider_ids: [],
  rationale: "Local implementation is sufficient.",
  evidence_refs: ["fixture:resolution"],
  total_cost: 0,
  approval_status: "pending_user",
  reevaluate_when: []
};

const contextPack = {
  context_pack_id: "CP-local",
  task_intent_id: taskIntent.task_intent_id,
  owner_agent_id: "implementation-001",
  objective: "Validate contracts.",
  acceptance_criteria: taskIntent.acceptance_criteria,
  adopted_decisions: [],
  capability_resolutions: [],
  required_reading: [],
  relevant_state_excerpts: [],
  interfaces: [],
  allowed_files: ["packages/contracts/**"],
  forbidden_actions: ["network"],
  excluded_context: [],
  evidence_requirements: [],
  provenance: [],
  token_budget: null,
  expires_at: null,
  status: "draft"
};

const eventBatch = {
  sequence: 1,
  expected_revision: 0,
  batch_id: "BATCH-local",
  actor: { type: "agent", id: "implementation-001" },
  correlation_id: "CORR-local",
  events: [{ type: "contract.checked", payload: { source: "fixture" } }]
};

const phaseReview = {
  phase_id: "phase-1",
  status: "in_progress",
  build_ref: null,
  artifacts: [],
  artifact_hashes: {},
  review_packet_ref: null,
  review_packet_hash: null,
  checks: [],
  demo_script: null,
  screenshots: [],
  known_gaps: [],
  review_requested_at: null,
  reviewed_at: null
};

const approvalAttestation = {
  source: "local_workbench_confirmation",
  challenge_id: "CHALLENGE-local",
  target_id: resolution.resolution_id,
  target_revision: 12,
  review_packet_hash: hash,
  token_hash: laterHash,
  captured_at: timestamp,
  expires_at: "2026-07-15T00:10:00.000Z",
  identity_assurance: "local_interaction_unverified_identity"
};

const fixtures = {
  "task-intent": [taskIntent, (value) => { value.acceptance_criteria = []; }],
  "capability-need": [capabilityNeed, (value) => { value.kind = "unknown"; }],
  "capability-provider": [capabilityProvider, (value) => { value.extra = true; }],
  "candidate-evaluation": [candidateEvaluation, (value) => { value.actual_model = "invented"; }],
  audition: [audition, (value) => { value.verdict = "maybe"; }],
  resolution: [resolution, (value) => { value.mode = "automatic"; }],
  "context-pack": [contextPack, (value) => { value.status = "published"; }],
  "event-batch": [eventBatch, (value) => { value.events = []; }],
  "phase-review": [phaseReview, (value) => { value.status = "ready_for_user_review"; }],
  "approval-attestation": [approvalAttestation, (value) => { value.actor = { type: "user" }; }]
};

test("public contract surface is stable", () => {
  assert.deepEqual(Object.keys(require("../src")).sort(), [
    "SCHEMA_NAMES",
    "assertContract",
    "canonicalHash",
    "canonicalJson",
    "loadSchema",
    "validateContract",
    "validatePhaseApprovalBinding"
  ].sort());
  assert.deepEqual(SCHEMA_NAMES, Object.keys(fixtures));
});

test("every approved schema accepts its fixture and rejects a meaningful invalid value", () => {
  for (const [schemaName, [valid, mutate]] of Object.entries(fixtures)) {
    assert.equal(validateContract(schemaName, valid).ok, true, schemaName);
    const invalid = clone(valid);
    mutate(invalid);
    assert.equal(validateContract(schemaName, invalid).ok, false, schemaName);
  }
});

test("TaskIntent rejects an empty acceptance criteria list with stable error shape", () => {
  const invalid = clone(taskIntent);
  invalid.acceptance_criteria = [];
  const result = validateContract("task-intent", invalid);
  assert.deepEqual(result, {
    ok: false,
    errors: [{ path: "$.acceptance_criteria", code: "minItems", message: "must contain at least 1 item" }]
  });
  assert.throws(() => assertContract("task-intent", invalid), /minItems/);
});

test("canonical JSON is key-order invariant, preserves arrays, and rejects nested undefined", () => {
  assert.equal(canonicalJson({ b: 1, a: [2, 1] }), '{"a":[2,1],"b":1}');
  assert.equal(canonicalHash({ b: 1, a: 2 }), canonicalHash({ a: 2, b: 1 }));
  assert.notEqual(canonicalHash([1, 2]), canonicalHash([2, 1]));
  assert.throws(() => canonicalJson({ nested: { value: undefined } }), /undefined/);
});

test("schema loading rejects unknown keywords instead of ignoring them", () => {
  const schemaDir = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-contract-schema-"));
  const schemaPath = path.join(schemaDir, "task-intent.schema.json");
  try {
    fs.writeFileSync(schemaPath, JSON.stringify({ type: "object", unsupported_keyword: true }), "utf8");
    assert.throws(() => loadSchema("task-intent", schemaDir), /Unsupported schema keyword/);
  } finally {
    fs.unlinkSync(schemaPath);
    fs.rmdirSync(schemaDir);
  }
});

test("candidate evaluation requires every axis, bounded values, reasons, and actual_model null", () => {
  const invalid = clone(candidateEvaluation);
  delete invalid.axes.cost;
  invalid.axes.task_fit.value = 101;
  invalid.axes.security.reason = "";
  invalid.actual_model = "gpt-5.6-terra";
  const result = validateContract("candidate-evaluation", invalid);
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((error) => error.path), [
    "$.actual_model",
    "$.axes.cost",
    "$.axes.security.reason",
    "$.axes.task_fit.value"
  ]);
});

test("approval attestation rejects raw token, secret, and request-supplied actor", () => {
  for (const forbiddenField of ["raw_token", "secret", "actor"]) {
    const invalid = { ...approvalAttestation, [forbiddenField]: forbiddenField === "actor" ? { type: "user" } : "secret" };
    assert.equal(validateContract("approval-attestation", invalid).ok, false, forbiddenField);
  }
});

test("phase review evidence is required for user-review and approved states", () => {
  const ready = { ...phaseReview, status: "ready_for_user_review" };
  assert.equal(validateContract("phase-review", ready).ok, false);
  const complete = {
    ...ready,
    build_ref: "6be6d7f",
    artifacts: ["output/v4-phase1-review/workbench.png"],
    artifact_hashes: { "output/v4-phase1-review/workbench.png": hash },
    review_packet_ref: "output/v4-phase1-review/phase-1-review.md",
    review_packet_hash: laterHash
  };
  assert.equal(validateContract("phase-review", complete).ok, true);
  assert.equal(validateContract("phase-review", { ...complete, status: "approved" }).ok, true);
});

test("phase approval binding reports packet and revision mismatch in deterministic order", () => {
  const result = validatePhaseApprovalBinding({
    phaseReview: { review_packet_hash: hash, journal_revision: 12 },
    attestation: { review_packet_hash: laterHash, target_revision: 11 }
  });
  assert.deepEqual(result, {
    ok: false,
    errors: [
      { path: "$.review_packet_hash", code: "approval_packet_hash_mismatch", message: "approval attestation review packet hash must match phase review" },
      { path: "$.target_revision", code: "approval_revision_mismatch", message: "approval attestation target revision must match phase review journal revision" }
    ]
  });
});
