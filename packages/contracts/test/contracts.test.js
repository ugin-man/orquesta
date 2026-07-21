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

function withTaskIntentSchema(schema, callback) {
  const schemaDir = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-contract-schema-"));
  const schemaPath = path.join(schemaDir, "task-intent.schema.json");
  fs.writeFileSync(schemaPath, JSON.stringify(schema), "utf8");
  try {
    return callback(schemaDir);
  } finally {
    fs.rmSync(schemaDir, { recursive: true, force: true });
  }
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
  events: [{
    event_id: "EVENT-contract-checked",
    schema_version: 1,
    type: "contract.checked",
    payload: { source: "fixture" },
    evidence_refs: []
  }]
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
  reviewed_at: null,
  review_cycle_revision: 12,
  user_decision: null
};

const approvalAttestation = {
  source: "local_workbench_confirmation",
  challenge_id: "CHALLENGE-local",
  target_id: phaseReview.phase_id,
  target_revision: 12,
  review_packet_hash: hash,
  token_hash: laterHash,
  captured_at: "2099-07-15T00:00:00.000Z",
  expires_at: "2099-07-15T00:10:00.000Z",
  identity_assurance: "local_interaction_unverified_identity"
};

const executionPlan = {
  execution_plan_id: "EP-06b6cf27e77f",
  task_intent_id: "TI-4c2eea2b9e6d",
  policy_version: 1,
  lane: "standard",
  risk_profile: {
    reversibility: "easy",
    scope: "multiple_boundaries",
    verification: "deterministic",
    uncertainty: "low",
    effects: ["workspace_write"],
    repeated_failures: 0,
    user_review: "default"
  },
  reason_codes: ["multiple_boundaries"],
  routing: {
    routing_class: "specialist_required",
    handoff_required: true,
    specialist_report_required: true
  },
  budget: {
    max_handoffs: 2,
    max_independent_reviews: 1,
    max_correction_batches: 1,
    max_reports: 1,
    max_auxiliary_tasks: 0
  },
  review_policy: "independent_once",
  escalation_triggers: [
    "budget_exhausted",
    "critical_risk_discovered",
    "scope_drift",
    "semantic_finding_not_machine_verifiable"
  ],
  revision: 1,
  supersedes_execution_plan_id: null
};

const roleDefinition = {
  role_id: "implementation",
  version: 1,
  display_names: { en: "Implementation", ja: "実装係" },
  aliases: ["coder", "developer"],
  capability_ids: ["code.change", "code.test"],
  default_contract_template: "specialist-implementation-v1",
  lifecycle_state: "active"
};

const agentCapabilityProfile = {
  agent_id: "implementation-001",
  capabilities: [{
    capability_id: "code.change",
    status: "verified",
    evidence_refs: ["evidence:code-change"],
    scope: ["packages/core"]
  }],
  availability: "available",
  organization_revision: 1
};

const organizationState = {
  schema_version: 2,
  revision: 1,
  policy: {
    organization_changes: "autonomous_except_new_line",
    max_concurrent_provisioning: 3,
    require_executable_task_per_new_agent: true,
    require_no_file_ownership_conflict: true
  },
  agents: [
    { agent_id: "implementation-001", role_id: "implementation", organization_scope: "line", lifecycle_state: "active", operational_status: "working" },
    { agent_id: "orchestrator", role_id: "orchestrator", organization_scope: "project", lifecycle_state: "active", operational_status: "working" }
  ],
  teams: [{ team_id: "core-implementation", line_id: "core-line", display_name: "Core implementation", purpose: "Core work", lifecycle_state: "active" }],
  memberships: [{ membership_id: "membership-implementation", agent_id: "implementation-001", team_id: "core-implementation", position: "member", ordinal: 1, active_from: timestamp, active_to: null }],
  relationships: [{ relationship_id: "relationship-implementation", type: "reports_to", from_agent_id: "implementation-001", to_agent_id: "orchestrator" }],
  lines: [{ line_id: "core-line", display_name: "Core", goal: "Core deliverable", deliverable_ids: ["core"], completion_root_ids: ["CM-CORE"], scope: ["packages/core"], owner_agent_id: "orchestrator", dedicated_lead_agent_id: null, status: "active", approval_source: "setup_confirmation" }],
  applied_decision_ids: []
};

const organizationDecision = {
  decision_id: "OD-0123456789ab",
  task_intent_id: "TI-0123456789ab",
  organization_revision: 1,
  input_hash: hash,
  mode: "deep",
  selected_action: "add_role",
  reason_codes: ["CAPABILITY_GAP"],
  requires_user_approval: false,
  approval_state: "not_required",
  proposed_line: null,
  created_at: timestamp
};

const specialistPlanV2 = {
  schema_version: 2,
  source_understanding_hash: hash,
  source_completion_map_revision: 1,
  first_executable_batch: ["T001"],
  selected_specialists: [{
    role_id: "implementation",
    quantity: 1,
    line_id: "core-line",
    team_id: "core-implementation",
    reason_codes: ["CAPABILITY_MATCH"],
    task_ids: ["T001"]
  }],
  future_candidates: [{ role_id: "release", activation_condition: "release milestone becomes executable" }],
  approval_source: "setup_confirmation"
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
  "approval-attestation": [approvalAttestation, (value) => { value.actor = { type: "user" }; }],
  "execution-plan": [executionPlan, (value) => { value.lane = "unknown"; }],
  "role-definition": [roleDefinition, (value) => { value.role_id = ""; }],
  "agent-capability-profile": [agentCapabilityProfile, (value) => { value.availability = "unknown"; }],
  "organization-state": [organizationState, (value) => { value.agents.push(clone(value.agents[0])); }],
  "organization-decision": [organizationDecision, (value) => { value.selected_action = "unknown"; }],
  "specialist-plan-v2": [specialistPlanV2, (value) => { value.schema_version = 1; }]
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
  assert.deepEqual(SCHEMA_NAMES, [...Object.keys(fixtures), ...Object.keys(phase2Contracts)]);
});

test("every approved schema accepts its fixture and rejects a meaningful invalid value", () => {
  for (const [schemaName, [valid, mutate]] of Object.entries(fixtures)) {
    assert.equal(validateContract(schemaName, valid).ok, true, schemaName);
    const invalid = clone(valid);
    mutate(invalid);
    assert.equal(validateContract(schemaName, invalid).ok, false, schemaName);
  }
});

test("organization decisions reserve user approval for a proposed new line", () => {
  const line = {
    ...organizationDecision,
    decision_id: "OD-abcdef012345",
    selected_action: "propose_line",
    requires_user_approval: true,
    approval_state: "pending_user",
    proposed_line: {
      line_id: "desktop-line",
      display_name: "Desktop",
      goal: "Desktop deliverable",
      deliverable_ids: ["desktop"],
      completion_root_ids: ["CM-DESKTOP"],
      scope: ["apps/orquesta-desktop"],
      owner_agent_id: "orchestrator"
    }
  };
  assert.equal(validateContract("organization-decision", line).ok, true);
  assert.equal(validateContract("organization-decision", { ...line, requires_user_approval: false }).ok, false);
  assert.equal(validateContract("organization-decision", { ...organizationDecision, requires_user_approval: true, approval_state: "pending_user" }).ok, false);
});

test("organization state rejects temporary assignments and invalid cross-record references", () => {
  assert.equal(validateContract("organization-state", organizationState).ok, true);
  assert.equal(validateContract("organization-state", { ...organizationState, temporary_assignment: true }).ok, false);
  const invalid = clone(organizationState);
  invalid.memberships[0].team_id = "missing-team";
  assert.equal(validateContract("organization-state", invalid).ok, false);
});

test("organization state enforces adaptive team leads and multi-line responsibility", () => {
  const twoMembers = clone(organizationState);
  for (const ordinal of [2]) {
    twoMembers.agents.push({ ...twoMembers.agents[0], agent_id: `implementation-00${ordinal}` });
    twoMembers.memberships.push({ ...twoMembers.memberships[0], membership_id: `membership-${ordinal}`, agent_id: `implementation-00${ordinal}`, ordinal });
  }
  assert.equal(validateContract("organization-state", twoMembers).ok, true);
  const prematureLead = clone(twoMembers);
  prematureLead.memberships[0].position = "lead";
  assert.equal(validateContract("organization-state", prematureLead).ok, false);

  const threeMembers = clone(twoMembers);
  threeMembers.agents.push({ ...threeMembers.agents[0], agent_id: "implementation-003" });
  threeMembers.memberships.push({ ...threeMembers.memberships[0], membership_id: "membership-3", agent_id: "implementation-003", ordinal: 3 });
  assert.equal(validateContract("organization-state", threeMembers).ok, false);
  threeMembers.memberships[0].position = "lead";
  assert.equal(validateContract("organization-state", threeMembers).ok, true);

  const multiLine = clone(threeMembers);
  multiLine.lines.push({ ...multiLine.lines[0], line_id: "desktop-line", display_name: "Desktop", deliverable_ids: ["desktop"], completion_root_ids: ["CM-DESKTOP"], scope: ["apps/orquesta-desktop"], dedicated_lead_agent_id: null });
  assert.equal(validateContract("organization-state", multiLine).ok, false);
  multiLine.lines[0].dedicated_lead_agent_id = "implementation-001";
  assert.equal(validateContract("organization-state", multiLine).ok, true);
});

test("specialist plans keep the same role distinct across separate lines", () => {
  const plan = clone(specialistPlanV2);
  plan.selected_specialists.push({
    ...plan.selected_specialists[0],
    line_id: "desktop-line",
    team_id: "desktop-implementation",
    task_ids: ["T002"]
  });
  assert.equal(validateContract("specialist-plan-v2", plan).ok, true);
});

test("Execution Plan rejects unbound identity, noncanonical effects, and altered lane budgets", () => {
  for (const mutate of [
    (value) => { value.task_intent_id = "unbound"; },
    (value) => { value.risk_profile.effects = ["workspace_write", "workspace_write"]; },
    (value) => { value.risk_profile.effects = ["unknown_effect"]; },
    (value) => { value.budget.max_reports = 2; }
  ]) {
    const invalid = clone(executionPlan);
    mutate(invalid);
    assert.equal(validateContract("execution-plan", invalid).ok, false);
  }
});

test("Execution Plan accepts the documented fast trigger set and rejects invented triggers", () => {
  const fast = clone(executionPlan);
  fast.lane = "fast";
  fast.reason_codes = [];
  fast.routing = { routing_class: "inline_verified", handoff_required: false, specialist_report_required: false };
  fast.budget = { max_handoffs: 0, max_independent_reviews: 0, max_correction_batches: 1, max_reports: 0, max_auxiliary_tasks: 0 };
  fast.review_policy = "none";
  fast.escalation_triggers = ["acceptance_uncertain", "new_risk", "scope_drift", "test_failure"];
  assert.equal(validateContract("execution-plan", fast).ok, true);

  fast.escalation_triggers = ["invented_trigger"];
  assert.equal(validateContract("execution-plan", fast).ok, false);
});

test("EventBatch matches the journal event contract and rejects obsolete event shapes", () => {
  assert.equal(validateContract("event-batch", eventBatch).ok, true);
  const validEvent = eventBatch.events[0];

  for (const field of ["event_id", "schema_version", "evidence_refs"]) {
    const invalid = clone(eventBatch);
    delete invalid.events[0][field];
    assert.equal(validateContract("event-batch", invalid).ok, false, field);
  }
  for (const [field, value] of [
    ["event_id", ""],
    ["schema_version", 0],
    ["evidence_refs", [1]],
    ["evidence", { obsolete: true }],
    ["unknown", true]
  ]) {
    const invalid = clone(eventBatch);
    invalid.events[0][field] = value;
    assert.equal(validateContract("event-batch", invalid).ok, false, field);
  }
  assert.deepEqual(validEvent.evidence_refs, []);
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

test("canonical JSON rejects value-collapsing input and preserves safe own keys", () => {
  const circularArray = [];
  circularArray.push(circularArray);
  const shared = { source: "shared" };
  const sparse = [];
  sparse[1] = "present";
  const protoKey = JSON.parse('{"__proto__":{"safe":true},"a":1}');

  assert.throws(() => canonicalJson(circularArray), TypeError, "circular arrays must not recurse until RangeError");
  assert.equal(canonicalJson([shared, shared]), '[{"source":"shared"},{"source":"shared"}]');
  assert.throws(() => canonicalJson(sparse), /sparse/);
  assert.throws(() => canonicalJson([undefined]), /undefined/);
  assert.throws(() => canonicalJson(new Date(timestamp)), /plain/);
  assert.throws(() => canonicalJson(new Map()), /plain/);
  assert.throws(() => canonicalJson(new Set()), /plain/);
  assert.throws(() => canonicalJson({ [Symbol("hidden")]: true }), /symbol/);
  assert.equal(canonicalJson(protoKey), '{"__proto__":{"safe":true},"a":1}');
});

test("canonical JSON rejects non-index own array properties instead of discarding them", () => {
  const enumerable = [1];
  enumerable.extra = "dropped";
  const nonEnumerable = [1];
  Object.defineProperty(nonEnumerable, "hidden", { value: "dropped" });
  const protoKey = [1];
  Object.defineProperty(protoKey, "__proto__", { value: "dropped", enumerable: true });

  assert.throws(() => canonicalJson(enumerable), /array properties/);
  assert.throws(() => canonicalJson(nonEnumerable), /array properties/);
  assert.throws(() => canonicalJson(protoKey), /array properties/);
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

test("schema loading rejects invalid supported keyword shapes and invalid patterns", () => {
  const invalidSchemas = [
    { type: "object", additionalProperties: "never" },
    { type: "array", minItems: -1 },
    { type: "string", pattern: "[" },
    { type: "object", properties: { nested: { unsupported_keyword: true } } }
  ];

  for (const schema of invalidSchemas) {
    withTaskIntentSchema(schema, (schemaDir) => {
      assert.throws(() => loadSchema("task-intent", schemaDir), TypeError);
    });
  }
});

test("schema combinators keep sibling constraints, both keywords, exact oneOf, and code-unit error order", () => {
  withTaskIntentSchema({
    type: "object",
    required: ["Z", "a"],
    properties: {
      Z: { type: "string", pattern: "^pass$", anyOf: [{ const: "pass" }, { const: "either" }], oneOf: [{ const: "pass" }, { const: "also" }] },
      a: { oneOf: [{ type: "number" }, { type: "string", pattern: "^pass$" }, { const: "pass" }] }
    },
    additionalProperties: false
  }, (schemaDir) => {
    assert.equal(validateContract("task-intent", { Z: "pass", a: 1 }, { schemasDir: schemaDir }).ok, true);

    const siblingFailure = validateContract("task-intent", { Z: "either", a: 1 }, { schemasDir: schemaDir });
    assert.deepEqual(siblingFailure.errors.map((error) => error.code), ["oneOf", "pattern"]);

    const multipleMatch = validateContract("task-intent", { Z: "pass", a: "pass" }, { schemasDir: schemaDir });
    assert.equal(multipleMatch.ok, false);
    assert.deepEqual(multipleMatch.errors.map((error) => error.code), ["oneOf"]);

    const zeroMatch = validateContract("task-intent", { Z: "no", a: 1 }, { schemasDir: schemaDir });
    assert.deepEqual(zeroMatch.errors.map((error) => error.code), ["anyOf", "oneOf", "pattern"]);
  });
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

test("phase review approval requires an explicit user decision and a bound redacted attestation", () => {
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

  const approved = {
    ...complete,
    status: "approved",
    reviewed_at: "2020-07-15T00:05:00.000Z",
    user_decision: {
      decision: "approved",
      attestation: {
        ...approvalAttestation,
        review_packet_hash: laterHash,
        captured_at: "2020-07-15T00:00:00.000Z",
        expires_at: "2020-07-15T00:10:00.000Z"
      }
    }
  };
  assert.equal(validateContract("phase-review", approved).ok, true);
  assert.equal(validateContract("phase-review", { ...complete, status: "approved" }).ok, false);
  assert.equal(validateContract("phase-review", {
    ...approved,
    user_decision: { decision: "approved", attestation: null }
  }).ok, false);
});

test("phase approval binding fails closed for missing, target, packet, revision, and expiry mismatches", () => {
  const binding = {
    phaseReview: {
      phase_id: phaseReview.phase_id,
      review_packet_hash: hash,
      review_cycle_revision: 12,
      reviewed_at: "2020-07-15T00:05:00.000Z"
    },
    attestation: {
      ...approvalAttestation,
      review_packet_hash: hash,
      captured_at: "2020-07-15T00:00:00.000Z",
      expires_at: "2020-07-15T00:10:00.000Z"
    }
  };
  assert.equal(validatePhaseApprovalBinding(binding).ok, true);
  assert.equal(validatePhaseApprovalBinding().ok, false);
  assert.equal(validatePhaseApprovalBinding({ phaseReview: binding.phaseReview }).ok, false);
  assert.equal(validatePhaseApprovalBinding({
    ...binding,
    attestation: { ...binding.attestation, target_id: "another-phase" }
  }).errors.some((error) => error.code === "approval_target_mismatch"), true);
  assert.equal(validatePhaseApprovalBinding({
    ...binding,
    attestation: { ...binding.attestation, review_packet_hash: laterHash }
  }).errors.some((error) => error.code === "approval_packet_hash_mismatch"), true);
  assert.equal(validatePhaseApprovalBinding({
    ...binding,
    attestation: { ...binding.attestation, target_revision: 11 }
  }).errors.some((error) => error.code === "approval_revision_mismatch"), true);
  assert.equal(validatePhaseApprovalBinding({
    ...binding,
    phaseReview: { ...binding.phaseReview, reviewed_at: "2020-07-15T00:10:00.000Z" }
  }).errors.some((error) => error.code === "approval_attestation_expired"), true);
});

test("approval uses saved reviewed_at as a deterministic reference time", () => {
  const binding = {
    phaseReview: {
      phase_id: phaseReview.phase_id,
      review_packet_hash: hash,
      review_cycle_revision: 12,
      reviewed_at: "2020-07-15T00:05:00.000Z"
    },
    attestation: {
      ...approvalAttestation,
      review_packet_hash: hash,
      captured_at: "2020-07-15T00:05:00.000Z",
      expires_at: "2020-07-15T00:10:00.000Z"
    }
  };
  const first = validatePhaseApprovalBinding(binding);
  const second = validatePhaseApprovalBinding(binding);

  assert.equal(first.ok, true, "historically valid evidence must not depend on the current machine date");
  assert.deepEqual(second, first);
  assert.equal(validatePhaseApprovalBinding({
    ...binding,
    phaseReview: { ...binding.phaseReview, reviewed_at: null }
  }).errors.some((error) => error.code === "approval_reference_time_missing"), true);
  assert.equal(validatePhaseApprovalBinding({
    ...binding,
    attestation: { ...binding.attestation, captured_at: "2020-07-15T00:06:00.000Z" }
  }).errors.some((error) => error.code === "approval_capture_after_review"), true);
  assert.equal(validatePhaseApprovalBinding({
    ...binding,
    phaseReview: { ...binding.phaseReview, reviewed_at: "2020-07-15T00:10:00.000Z" }
  }).errors.some((error) => error.code === "approval_attestation_expired"), true);
  assert.equal(validatePhaseApprovalBinding({
    ...binding,
    phaseReview: { ...binding.phaseReview, reviewed_at: "2020-07-15T00:11:00.000Z" }
  }).errors.some((error) => error.code === "approval_attestation_expired"), true);
});

test("UTC timestamp schemas and approval attestation semantics reject malformed and reversed evidence", () => {
  assert.equal(validateContract("approval-attestation", {
    ...approvalAttestation,
    captured_at: "not-a-timestamp",
    expires_at: "also-not-a-timestamp"
  }).ok, false);
  assert.equal(validateContract("approval-attestation", {
    ...approvalAttestation,
    captured_at: "2026-02-30T00:00:00.000Z"
  }).ok, false);
  assert.equal(validateContract("approval-attestation", {
    ...approvalAttestation,
    expires_at: approvalAttestation.captured_at
  }).ok, false);
  assert.equal(validateContract("capability-provider", {
    ...capabilityProvider,
    last_verified_at: "not-a-timestamp"
  }).ok, false);
  assert.equal(validateContract("capability-provider", {
    ...capabilityProvider,
    last_verified_at: "2026-02-30T00:00:00.000Z"
  }).ok, false);
  assert.equal(validateContract("context-pack", {
    ...contextPack,
    expires_at: "not-a-timestamp"
  }).ok, false);
  assert.equal(validateContract("context-pack", {
    ...contextPack,
    expires_at: "2026-02-30T00:00:00.000Z"
  }).ok, false);
  assert.equal(validateContract("phase-review", {
    ...phaseReview,
    review_requested_at: "not-a-timestamp"
  }).ok, false);
  assert.equal(validateContract("phase-review", {
    ...phaseReview,
    review_requested_at: "2026-02-30T00:00:00.000Z"
  }).ok, false);
});

test("validation errors use deterministic code-unit order", () => {
  withTaskIntentSchema({
    type: "object",
    required: ["Z", "a"],
    properties: { Z: { type: "string" }, a: { type: "string" } },
    additionalProperties: false
  }, (schemaDir) => {
    const result = validateContract("task-intent", { Z: 1, a: 1 }, { schemasDir: schemaDir });
    assert.deepEqual(result.errors.map((error) => error.path), ["$.Z", "$.a"]);
  });
});

const phase2Contracts = {
  "live-source-query": {
    value: {
      need_id: "NEED-live-source",
      query_terms: ["json", "validation"],
      allowed_connector_ids: ["official_docs", "registry"],
      request_budget: { max_requests_per_need: 8, max_requests_per_connector: 2 },
      candidate_limit: 3,
      requested_at: timestamp
    },
    invalid: (value) => { value.allowed_connector_ids = ["registry", "registry"]; }
  },
  "live-source-result": {
    value: {
      connector_id: "official_docs",
      trust_tier: "official",
      fetched_at: timestamp,
      expires_at: "2026-07-15T01:00:00.000Z",
      status: "success",
      candidates: [{ candidate_id: "candidate-a", source_ref: "https://example.test/a", source_hash: hash, version: "1.0.0", revision: null, trust_tier: "official", freshness: "fresh" }],
      source_evidence: [{
        source_id: "source:official_docs:candidate-a",
        candidate_id: "candidate-a",
        source_ref: "https://example.test/a",
        source_hash: hash,
        freshness: "fresh",
        authoritative_fields: ["freshness", "license", "trust"],
        facts: { freshness: "fresh", license: "MIT", trust: "official" },
        unknowns: ["accessibility", "compatibility", "cost", "maintenance", "security"],
      }],
      cache_status: "fresh",
      redaction_status: "redacted"
    },
    invalid: (value) => { value.candidates[0].source_hash = ""; }
  },
  "audition-plan": {
    value: {
      audition_plan_id: "AP-1234567890ab",
      candidate_id: "candidate-a",
      candidate_version: "1.0.0",
      candidate_hash: hash,
      task_intent_id: "TI-1234567890ab",
      resolution_id: "CR-1234567890ab",
      execution_root: { kind: "temporary", path: "output/v4-phase2/audition" },
      expected_codex_profile: "phase2-audition",
      permitted_effects: ["workspace_write"],
      steps: ["run focused verification"],
      expected_evidence: ["artifact:audition-result"],
      cleanup_plan: ["remove temporary files"],
      approval_refs: ["approval:audition"]
    },
    invalid: (value) => { value.unexpected = true; }
  },
  "audition-result": {
    value: {
      audition_plan_id: "AP-1234567890ab",
      observed_codex_profile: "phase2-audition",
      steps: [{ step: "run focused verification", status: "passed" }],
      side_effects: [],
      evidence_refs: ["artifact:audition-result"],
      verdict: "passed",
      cleanup_evidence: ["cleanup:verified"]
    },
    invalid: (value) => { value.observed_codex_profile = ""; }
  },
  "install-approval-target": {
    value: {
      candidate_id: "candidate-a",
      candidate_version: "1.0.0",
      source_hash: hash,
      dependency_preview_hash: hash,
      lockfile_preview_hash: laterHash,
      target_workspace: "packages/codex-adapter",
      effects: ["dependency_change"],
      expires_at: "2026-07-15T01:00:00.000Z",
      review_packet_ref: "artifact:install-review",
      review_packet_hash: hash
    },
    invalid: (value) => { value.review_packet_hash = ""; }
  },
  "runtime-evidence": {
    value: {
      source: "app_server",
      correlation_id: "CORR-phase2",
      event_kind: "turn_started",
      captured_at: timestamp,
      thread_id: "thread-phase2",
      turn_id: "turn-phase2",
      payload_hash: hash,
      payload_ref: "artifact:turn-started",
      redaction_status: "redacted",
      requested_model: "gpt-5.6-terra",
      applied_model: "gpt-5.6-terra",
      actual_model: null
    },
    invalid: (value) => { value.actual_model = "gpt-5.6-terra"; value.payload_ref = null; }
  },
  "codex-dispatch": {
    value: {
      adapter_kind: "app_server",
      request_status: "dispatch_accepted",
      thread_id: "thread-phase2",
      turn_id: "turn-phase2",
      requested_model: "gpt-5.6-terra",
      applied_model: "gpt-5.6-terra",
      evidence_refs: ["artifact:dispatch-accepted"],
      turn_started_evidence_ref: null
    },
    invalid: (value) => { value.request_status = "turn_started"; }
  }
};

test("Phase 2 durable evidence contracts accept bounded fixtures and reject semantic violations", () => {
  const names = Object.keys(phase2Contracts);
  assert.equal(names.every((name) => SCHEMA_NAMES.includes(name)), true, "Phase 2 schema names must be registered");

  for (const [name, fixture] of Object.entries(phase2Contracts)) {
    assert.equal(validateContract(name, fixture.value).ok, true, `${name} valid fixture`);
    const invalid = clone(fixture.value);
    fixture.invalid(invalid);
    assert.equal(validateContract(name, invalid).ok, false, `${name} semantic invalid fixture`);
  }
});

test("Phase 2 durable evidence contracts enforce fixed limits, timestamp order, and turn-start evidence", () => {
  const query = clone(phase2Contracts["live-source-query"].value);
  query.request_budget.max_requests_per_need = 9;
  assert.equal(validateContract("live-source-query", query).ok, false);

  query.request_budget.max_requests_per_need = 8;
  query.candidate_limit = 4;
  assert.equal(validateContract("live-source-query", query).ok, false);

  query.candidate_limit = 3;
  query.query_terms = ["validation", "json"];
  assert.equal(validateContract("live-source-query", query).ok, false);

  const result = clone(phase2Contracts["live-source-result"].value);
  result.expires_at = result.fetched_at;
  assert.equal(validateContract("live-source-result", result).ok, false);

  const dispatch = clone(phase2Contracts["codex-dispatch"].value);
  dispatch.request_status = "turn_started";
  dispatch.turn_started_evidence_ref = "artifact:turn-started";
  assert.equal(validateContract("codex-dispatch", dispatch).ok, true);
});

test("live source result binds record trust and freshness to its source evidence", () => {
  const trustMismatch = clone(phase2Contracts["live-source-result"].value);
  trustMismatch.candidates[0].trust_tier = "community";
  assert.equal(validateContract("live-source-result", trustMismatch).ok, false);

  const freshnessMismatch = clone(phase2Contracts["live-source-result"].value);
  freshnessMismatch.candidates[0].freshness = "stale";
  assert.equal(validateContract("live-source-result", freshnessMismatch).ok, false);
});

test("live source result requires exactly one source evidence record for every current candidate", () => {
  const missingEvidence = clone(phase2Contracts["live-source-result"].value);
  missingEvidence.source_evidence = [];
  const missingResult = validateContract("live-source-result", missingEvidence);
  assert.equal(missingResult.ok, false);
  assert.deepEqual(missingResult.errors.filter((error) => error.code === "source_candidate_evidence_missing").map((error) => error.path), ["$.candidates.candidate-a"]);

  const oneToOne = clone(phase2Contracts["live-source-result"].value);
  oneToOne.candidates.push({
    candidate_id: "candidate-b",
    source_ref: "https://example.test/b",
    source_hash: laterHash,
    version: "2.0.0",
    revision: "rev-b",
    trust_tier: "official",
    freshness: "fresh"
  });
  oneToOne.source_evidence.push({
    source_id: "source:official_docs:candidate-b",
    candidate_id: "candidate-b",
    source_ref: "https://example.test/b",
    source_hash: laterHash,
    freshness: "fresh",
    authoritative_fields: ["freshness", "license", "trust"],
    facts: { freshness: "fresh", license: "MIT", trust: "official" },
    unknowns: ["accessibility", "compatibility", "cost", "maintenance", "security"]
  });
  assert.equal(validateContract("live-source-result", oneToOne).ok, true);

  const duplicateCandidate = clone(oneToOne);
  duplicateCandidate.candidates[1].candidate_id = "candidate-a";
  const duplicateCandidateResult = validateContract("live-source-result", duplicateCandidate);
  assert.equal(duplicateCandidateResult.ok, false);
  assert.ok(duplicateCandidateResult.errors.some((error) => error.path === "$.candidates" && error.code === "sorted_unique"));

  const duplicateEvidence = clone(oneToOne);
  duplicateEvidence.source_evidence[1].candidate_id = "candidate-a";
  const duplicateEvidenceResult = validateContract("live-source-result", duplicateEvidence);
  assert.equal(duplicateEvidenceResult.ok, false);
  assert.ok(duplicateEvidenceResult.errors.some((error) => error.path === "$.source_evidence" && error.code === "sorted_unique"));
});

test("Phase 2 durable evidence contracts reject unknown durable fields", () => {
  for (const [name, fixture] of Object.entries(phase2Contracts)) {
    const invalid = clone(fixture.value);
    invalid.unknown_durable_field = true;
    assert.equal(validateContract(name, invalid).ok, false, name);
  }
});

test("runtime evidence binds a non-null actual model to model observation evidence", () => {
  const turnStarted = clone(phase2Contracts["runtime-evidence"].value);
  turnStarted.actual_model = "gpt-5.6-terra";
  assert.equal(validateContract("runtime-evidence", turnStarted).ok, false);

  const observed = clone(turnStarted);
  observed.event_kind = "model_observed";
  assert.equal(validateContract("runtime-evidence", observed).ok, true);
});
