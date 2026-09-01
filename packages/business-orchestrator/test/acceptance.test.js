"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { normalizeBusinessWorkOrderPlanV1 } = require("../src/contract");
const {
  evaluateBusinessAcceptance,
  evaluateBusinessAcceptanceV1,
} = require("..");

test("exports the versioned acceptance boundary from the package root", () => {
  assert.equal(typeof evaluateBusinessAcceptanceV1, "function");
  assert.equal(evaluateBusinessAcceptance, evaluateBusinessAcceptanceV1);
});

function branch({
  branchRef,
  suffix,
  dependencies = [],
  role = "work",
  parallelizable = true,
  isolation = "worktree",
  assigneeRef = `agent:${suffix}`,
}) {
  return {
    branch_ref: branchRef,
    task_intent_ref: { id: `TI-${suffix}`, hash: "a".repeat(64) },
    execution_plan_ref: { id: `EP-${suffix}`, hash: "b".repeat(64) },
    context_pack_ref: { id: `CP2-${suffix}`, hash: "c".repeat(64) },
    dependencies,
    role,
    parallelizable,
    isolation,
    assignee_ref: assigneeRef,
    provider_ref: "provider:codex",
    permission_mode: "workspace-write",
  };
}

function verificationRequirement(criterionId, kind) {
  const suffix = criterionId.replace(":", "-");
  return {
    kind,
    verification_ref: {
      id: `verification:${suffix}:${kind}`,
      hash: (kind === "deterministic" ? "1" : "2").repeat(64),
    },
  };
}

function validPlan(overrides = {}) {
  return {
    version: 1,
    project_ref: "project:orquesta-v5",
    revision: 1,
    supersedes_plan_ref: null,
    title: "Ship the bounded business change",
    desired_outcome: "Implement, verify, and independently integrate the approved change.",
    acceptance_policy: {
      criteria: [
        {
          criterion_id: "criterion:tests",
          description: "The deterministic test suite passes.",
          verification: "deterministic",
          verification_requirements: [
            verificationRequirement("criterion:tests", "deterministic"),
          ],
        },
        {
          criterion_id: "criterion:outcome",
          description: "The integrated result matches the requested outcome.",
          verification: "mixed",
          verification_requirements: [
            verificationRequirement("criterion:outcome", "deterministic"),
            verificationRequirement("criterion:outcome", "human"),
          ],
        },
      ],
      review_minimum: "strict",
    },
    task_intent_ref: { id: "TI-parent000001", hash: "d".repeat(64) },
    execution_plan_ref: { id: "EP-parent000001", hash: "e".repeat(64) },
    context_pack_ref: { id: "CP2-parent000001", hash: "f".repeat(64) },
    branches: [
      branch({ branchRef: "branch:implementation", suffix: "implementation" }),
      branch({ branchRef: "branch:tests", suffix: "tests", isolation: "sandbox" }),
      branch({
        branchRef: "branch:integration",
        suffix: "integration",
        dependencies: ["branch:implementation", "branch:tests"],
        role: "integration",
        parallelizable: false,
      }),
    ],
    integration_branch_ref: "branch:integration",
    max_concurrency: 2,
    context_duplication_budget_tokens: 2_000,
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
      heartbeat_interval_ms: 5_000,
      max_recovery_probes: 3,
    },
    provider_policy: {
      allowed_provider_refs: ["provider:codex"],
      selection: "fixed",
    },
    permission_mode: "workspace-write",
    ...overrides,
  };
}

function review(index, overrides = {}) {
  return {
    branch_ref: "branch:integration",
    review_id: `review:${index}`,
    reviewer_ref: `agent:reviewer-${index}`,
    status: "accepted",
    findings: { critical: 0, important: 0, minor: 0 },
    evidence_refs: [`evidence:review-${index}`],
    ...overrides,
  };
}

function acceptedInput(planOverrides = {}, snapshotOverrides = {}) {
  const plan = validPlan(planOverrides);
  const normalized = normalizeBusinessWorkOrderPlanV1(plan);
  const acceptanceBranchRef = normalized.integration_branch_ref
    ?? normalized.branches.find((item) => item.role === "work").branch_ref;
  const verificationChecks = normalized.acceptance_policy.criteria.flatMap((criterion) => {
    return criterion.verification_requirements.map((requirement) => (
      {
        branch_ref: acceptanceBranchRef,
        criterion_id: criterion.criterion_id,
        kind: requirement.kind,
        verifier_ref: `verifier:${requirement.verification_ref.id}`,
        verification_ref: { ...requirement.verification_ref },
        status: "passed",
        evidence_refs: [`evidence:${requirement.verification_ref.id}`],
      }
    ));
  });
  return {
    plan,
    snapshot: {
      work_order_id: `WO-${"1".repeat(32)}`,
      project_ref: normalized.project_ref,
      plan_snapshot_id: normalized.plan_snapshot_id,
      plan_hash: normalized.plan_hash,
      plan_revision: normalized.revision,
      work_order_revision: 12,
      branches: normalized.branches.map((item) => ({
        branch_ref: item.branch_ref,
        status: item.role === "integration" ? "accepted" : "verified",
        artifact_refs: [{
          id: `artifact:${item.branch_ref}`,
          hash: "7".repeat(64),
        }],
        evidence_refs: [`evidence:${item.branch_ref.replace(":", "-")}`],
      })),
      criterion_results: normalized.acceptance_policy.criteria.map((criterion) => ({
        criterion_id: criterion.criterion_id,
        status: "passed",
        evidence_refs: verificationChecks
          .filter((check) => check.criterion_id === criterion.criterion_id)
          .flatMap((check) => check.evidence_refs),
      })),
      reviews: [
        review(1, { branch_ref: acceptanceBranchRef }),
        review(2, { branch_ref: acceptanceBranchRef }),
      ],
      pending_attention_refs: [],
      open_risk_refs: [],
      unverified_refs: [],
      verification_checks: verificationChecks,
      ...snapshotOverrides,
    },
  };
}

test("accepts a plan-bound strict snapshot and permits extra valid reviews", () => {
  const input = acceptedInput();
  input.snapshot.reviews.push(review(3));

  assert.deepEqual(evaluateBusinessAcceptanceV1(input), {
    accepted: true,
    reason_codes: [],
    evidence_refs: [
      "evidence:branch-implementation",
      "evidence:branch-integration",
      "evidence:branch-tests",
      "evidence:review-1",
      "evidence:review-2",
      "evidence:review-3",
      "evidence:verification:criterion-outcome:deterministic",
      "evidence:verification:criterion-outcome:human",
      "evidence:verification:criterion-tests:deterministic",
    ],
  });
});

test("rejects branch aliases and duplicate fake branches instead of letting them override the plan", () => {
  const aliasSpoof = acceptedInput();
  aliasSpoof.snapshot.required_branches = aliasSpoof.snapshot.branches.map((item) => ({
    ...item,
    artifact_refs: item.artifact_refs.map((ref) => ({ ...ref })),
    evidence_refs: [...item.evidence_refs],
  }));
  aliasSpoof.snapshot.branches[0].status = "failed";
  assert.deepEqual(evaluateBusinessAcceptanceV1(aliasSpoof).reason_codes, [
    "business_acceptance_snapshot_invalid",
  ]);

  const duplicateSpoof = acceptedInput();
  duplicateSpoof.snapshot.branches[0].status = "failed";
  duplicateSpoof.snapshot.branches.push({
    ...duplicateSpoof.snapshot.branches[0],
    status: "accepted",
    artifact_refs: duplicateSpoof.snapshot.branches[0].artifact_refs.map((ref) => ({ ...ref })),
    evidence_refs: ["evidence:fake-override"],
  });
  const result = evaluateBusinessAcceptanceV1(duplicateSpoof);
  assert.equal(result.accepted, false);
  assert.deepEqual(result.reason_codes, [
    "branch_result_duplicate",
    "work_branch_not_verified_or_accepted",
  ]);
});

test("derives review minimum only from the plan", () => {
  const topLevelOverride = acceptedInput({}, { reviews: [review(1)] });
  topLevelOverride.review_intensity = "light";
  assert.deepEqual(evaluateBusinessAcceptanceV1(topLevelOverride).reason_codes, [
    "business_acceptance_input_invalid",
  ]);

  const snapshotOverride = acceptedInput({}, { reviews: [review(1)] });
  snapshotOverride.snapshot.review_intensity = "light";
  assert.deepEqual(evaluateBusinessAcceptanceV1(snapshotOverride).reason_codes, [
    "business_acceptance_snapshot_invalid",
  ]);

  assert.deepEqual(
    evaluateBusinessAcceptanceV1(acceptedInput({}, { reviews: [review(1)] })).reason_codes,
    ["review_count_below_minimum"],
  );
  assert.equal(evaluateBusinessAcceptanceV1(acceptedInput()).accepted, true);
});

test("rejects blank and object evidence references", () => {
  const blank = acceptedInput();
  blank.snapshot.branches[0].evidence_refs = [" "];
  assert.deepEqual(evaluateBusinessAcceptanceV1(blank).reason_codes, [
    "branch_evidence_invalid",
  ]);

  const object = acceptedInput();
  object.snapshot.criterion_results[0].evidence_refs = [{ ref: "evidence:not-a-string" }];
  assert.deepEqual(evaluateBusinessAcceptanceV1(object).reason_codes, [
    "criterion_evidence_invalid",
  ]);
});

test("accepted branches require non-empty unique content-addressed artifacts", () => {
  const empty = acceptedInput();
  empty.snapshot.branches[0].artifact_refs = [];
  assert.deepEqual(evaluateBusinessAcceptanceV1(empty).reason_codes, [
    "branch_artifact_refs_invalid",
  ]);

  const rawString = acceptedInput();
  rawString.snapshot.branches[0].artifact_refs = ["artifact:raw-string"];
  assert.deepEqual(evaluateBusinessAcceptanceV1(rawString).reason_codes, [
    "branch_artifact_refs_invalid",
  ]);

  const duplicate = acceptedInput();
  duplicate.snapshot.branches[0].artifact_refs.push({
    ...duplicate.snapshot.branches[0].artifact_refs[0],
  });
  assert.deepEqual(evaluateBusinessAcceptanceV1(duplicate).reason_codes, [
    "branch_artifact_refs_invalid",
  ]);
});

test("rejects a failed work branch and a merely verified integration branch", () => {
  const failed = acceptedInput();
  failed.snapshot.branches.find((item) => item.branch_ref === "branch:tests").status = "failed";
  failed.snapshot.branches.find((item) => item.branch_ref === "branch:integration").status = "verified";

  assert.deepEqual(evaluateBusinessAcceptanceV1(failed).reason_codes, [
    "integration_branch_not_accepted",
    "work_branch_not_verified_or_accepted",
  ]);
});

test("separates the plan revision from the aggregate revision and validates both", () => {
  const mismatched = acceptedInput();
  mismatched.snapshot.project_ref = "project:other";
  mismatched.snapshot.plan_snapshot_id = `BPS-${"0".repeat(32)}`;
  mismatched.snapshot.plan_hash = "0".repeat(64);
  mismatched.snapshot.plan_revision += 1;
  mismatched.snapshot.work_order_id = "work-order:not-canonical";
  assert.deepEqual(evaluateBusinessAcceptanceV1(mismatched).reason_codes, [
    "snapshot_plan_hash_mismatch",
    "snapshot_plan_revision_mismatch",
    "snapshot_plan_snapshot_id_mismatch",
    "snapshot_project_ref_mismatch",
    "work_order_id_invalid",
  ]);

  const invalidRevisions = acceptedInput();
  invalidRevisions.snapshot.plan_revision = "1";
  invalidRevisions.snapshot.work_order_revision = 0;
  assert.deepEqual(evaluateBusinessAcceptanceV1(invalidRevisions).reason_codes, [
    "snapshot_plan_revision_invalid",
    "snapshot_work_order_revision_invalid",
  ]);

  const laterAggregateRevision = acceptedInput();
  laterAggregateRevision.snapshot.work_order_revision = 98;
  assert.equal(evaluateBusinessAcceptanceV1(laterAggregateRevision).accepted, true);
});

test("accepts a fully evidenced solo plan without an integration branch", () => {
  const soloBranch = branch({
    branchRef: "branch:solo",
    suffix: "solo",
    parallelizable: false,
  });
  const input = acceptedInput({
    acceptance_policy: {
      criteria: [{
        criterion_id: "criterion:solo",
        description: "The solo output passes its deterministic verification.",
        verification: "deterministic",
        verification_requirements: [
          verificationRequirement("criterion:solo", "deterministic"),
        ],
      }],
      review_minimum: "light",
    },
    branches: [soloBranch],
    integration_branch_ref: null,
    max_concurrency: 1,
  });
  input.snapshot.reviews = [];

  assert.equal(evaluateBusinessAcceptanceV1(input).accepted, true);
});

test("requires exact criterion coverage and rejects non-passing results", () => {
  const input = acceptedInput();
  input.snapshot.criterion_results[0].status = "failed";
  input.snapshot.criterion_results.push({
    criterion_id: "criterion:invented",
    status: "passed",
    evidence_refs: ["evidence:invented"],
  });

  assert.deepEqual(evaluateBusinessAcceptanceV1(input).reason_codes, [
    "criterion_not_passed",
    "criterion_result_set_mismatch",
  ]);
});

test("requires every supplied review to be valid and independent of all assignees", () => {
  const input = acceptedInput({}, {
    reviews: [
      review(1),
      review(2),
      review(3, {
        reviewer_ref: "agent:implementation",
        findings: { critical: 0, important: 1, minor: 0 },
      }),
    ],
  });

  assert.deepEqual(evaluateBusinessAcceptanceV1(input).reason_codes, [
    "review_blocking_findings_present",
    "review_not_independent",
  ]);
});

test("a leaf branch review cannot approve the integrated result", () => {
  const input = acceptedInput();
  input.snapshot.reviews[0].branch_ref = "branch:implementation";

  const result = evaluateBusinessAcceptanceV1(input);
  assert.equal(result.accepted, false);
  assert.ok(result.reason_codes.includes("review_branch_mismatch"));
  assert.ok(result.reason_codes.includes("review_count_below_minimum"));
});

test("blocks pending attention, open risks, and unverified references", () => {
  const input = acceptedInput({}, {
    pending_attention_refs: ["attention:approval"],
    open_risk_refs: ["risk:rollback"],
    unverified_refs: ["verification:windows"],
  });

  assert.deepEqual(evaluateBusinessAcceptanceV1(input).reason_codes, [
    "open_risks_present",
    "pending_attention_present",
    "unverified_refs_present",
  ]);
});

test("accepts only passed verification checks with evidence", () => {
  const expectedFailure = acceptedInput();
  expectedFailure.snapshot.verification_checks[0].status = "failed_expected";
  const expectedFailureReasons = evaluateBusinessAcceptanceV1(expectedFailure).reason_codes;
  assert.ok(expectedFailureReasons.includes("verification_check_not_passed"));
  assert.ok(expectedFailureReasons.includes("criterion_deterministic_verification_missing"));

  const missingEvidence = acceptedInput();
  missingEvidence.snapshot.verification_checks[0].evidence_refs = [];
  const missingEvidenceReasons = evaluateBusinessAcceptanceV1(missingEvidence).reason_codes;
  assert.ok(missingEvidenceReasons.includes("verification_check_evidence_invalid"));
  assert.ok(missingEvidenceReasons.includes("criterion_deterministic_verification_missing"));

  const incomplete = acceptedInput();
  incomplete.snapshot.verification_checks[0].status = "not_run";
  const incompleteReasons = evaluateBusinessAcceptanceV1(incomplete).reason_codes;
  assert.ok(incompleteReasons.includes("verification_check_not_passed"));
  assert.ok(incompleteReasons.includes("criterion_deterministic_verification_missing"));
});

test("human-only acceptance cannot pass in light mode without a human check", () => {
  const soloBranch = branch({
    branchRef: "branch:solo-human",
    suffix: "solo-human",
    parallelizable: false,
  });
  const input = acceptedInput({
    acceptance_policy: {
      criteria: [{
        criterion_id: "criterion:human",
        description: "An independent human accepts the business outcome.",
        verification: "human_only",
        verification_requirements: [
          verificationRequirement("criterion:human", "human"),
        ],
      }],
      review_minimum: "light",
    },
    branches: [soloBranch],
    integration_branch_ref: null,
    max_concurrency: 1,
  });
  input.snapshot.reviews = [];
  input.snapshot.verification_checks = [];

  const result = evaluateBusinessAcceptanceV1(input);
  assert.equal(result.accepted, false);
  assert.ok(result.reason_codes.includes("criterion_human_verification_missing"));
});

test("mixed acceptance requires both deterministic and human checks", () => {
  const input = acceptedInput();
  input.snapshot.verification_checks = input.snapshot.verification_checks.filter(
    (check) => !(check.criterion_id === "criterion:outcome" && check.kind === "human"),
  );

  const result = evaluateBusinessAcceptanceV1(input);
  assert.equal(result.accepted, false);
  assert.ok(result.reason_codes.includes("criterion_human_verification_missing"));
});

test("criterion evidence must equal the unique evidence union of its accepted checks", () => {
  const fabricated = acceptedInput();
  fabricated.snapshot.criterion_results.find(
    (result) => result.criterion_id === "criterion:tests",
  ).evidence_refs = ["evidence:fabricated-unbound"];

  assert.deepEqual(evaluateBusinessAcceptanceV1(fabricated).reason_codes, [
    "criterion_evidence_not_bound_to_checks",
  ]);
});

test("a verification check for the wrong criterion cannot satisfy the planned criterion", () => {
  const input = acceptedInput();
  input.snapshot.verification_checks.find(
    (check) => check.criterion_id === "criterion:tests",
  ).criterion_id = "criterion:invented";

  const result = evaluateBusinessAcceptanceV1(input);
  assert.equal(result.accepted, false);
  assert.ok(result.reason_codes.includes("verification_check_criterion_unknown"));
  assert.ok(result.reason_codes.includes("criterion_deterministic_verification_missing"));
});

test("a leaf branch check cannot satisfy acceptance after an integration branch", () => {
  const input = acceptedInput();
  input.snapshot.verification_checks.find(
    (check) => check.criterion_id === "criterion:tests",
  ).branch_ref = "branch:tests";

  const result = evaluateBusinessAcceptanceV1(input);
  assert.equal(result.accepted, false);
  assert.ok(result.reason_codes.includes("verification_check_branch_mismatch"));
  assert.ok(result.reason_codes.includes("verification_requirement_missing"));
});

test("verification checks must exactly match the plan-bound content reference", () => {
  const input = acceptedInput();
  const check = input.snapshot.verification_checks.find(
    (candidate) => candidate.criterion_id === "criterion:tests",
  );
  check.verification_ref.hash = "8".repeat(64);

  const result = evaluateBusinessAcceptanceV1(input);
  assert.equal(result.accepted, false);
  assert.ok(result.reason_codes.includes("verification_check_not_plan_bound"));
  assert.ok(result.reason_codes.includes("verification_requirement_missing"));
});

test("every plan requirement is required even when another check has the same kind", () => {
  const first = {
    kind: "deterministic",
    verification_ref: {
      id: "verification:multi:first",
      hash: "3".repeat(64),
    },
  };
  const second = {
    kind: "deterministic",
    verification_ref: {
      id: "verification:multi:second",
      hash: "4".repeat(64),
    },
  };
  const input = acceptedInput({
    acceptance_policy: {
      criteria: [{
        criterion_id: "criterion:multi",
        description: "Both independently defined deterministic checks pass.",
        verification: "deterministic",
        verification_requirements: [first, second],
      }],
      review_minimum: "strict",
    },
  });
  input.snapshot.verification_checks = input.snapshot.verification_checks.filter(
    (check) => check.verification_ref.id !== second.verification_ref.id,
  );

  const result = evaluateBusinessAcceptanceV1(input);
  assert.equal(result.accepted, false);
  assert.ok(result.reason_codes.includes("verification_requirement_missing"));
  assert.equal(result.reason_codes.includes("criterion_deterministic_verification_missing"), false);
});

test("one made-up check, verifier, or evidence ref cannot satisfy every criterion", () => {
  const input = acceptedInput();
  for (const check of input.snapshot.verification_checks) {
    check.verification_ref = {
      id: "verification:made-up",
      hash: "9".repeat(64),
    };
    check.verifier_ref = "verifier:made-up";
    check.evidence_refs = ["evidence:made-up"];
  }
  for (const result of input.snapshot.criterion_results) {
    result.evidence_refs = ["evidence:made-up"];
  }

  const reasons = evaluateBusinessAcceptanceV1(input).reason_codes;
  assert.ok(reasons.includes("verification_check_duplicate"));
  assert.ok(reasons.includes("verification_check_verifier_duplicate"));
  assert.ok(reasons.includes("verification_check_evidence_reused"));
});

test("human verification must be independent of every branch assignee", () => {
  const input = acceptedInput();
  input.snapshot.verification_checks.find(
    (check) => check.kind === "human",
  ).verifier_ref = "agent:implementation";

  const result = evaluateBusinessAcceptanceV1(input);
  assert.equal(result.accepted, false);
  assert.ok(result.reason_codes.includes("human_verifier_not_independent"));
  assert.ok(result.reason_codes.includes("criterion_human_verification_missing"));
});

test("a completed turn alone is never accepted", () => {
  const result = evaluateBusinessAcceptanceV1({
    plan: validPlan(),
    snapshot: { turn: "completed" },
  });
  assert.deepEqual(result, {
    accepted: false,
    reason_codes: ["business_acceptance_snapshot_invalid"],
    evidence_refs: [],
  });
});

test("fails closed on malformed, circular, deep, and oversized input without throwing", () => {
  const circular = acceptedInput();
  circular.snapshot.loop = circular;

  let deep = { terminal: true };
  for (let index = 0; index < 100; index += 1) deep = { next: deep };

  const oversized = acceptedInput();
  oversized.snapshot.work_order_id = `WO-${"x".repeat(300_000)}`;

  for (const input of [null, circular, deep, oversized]) {
    assert.doesNotThrow(() => evaluateBusinessAcceptanceV1(input));
    assert.deepEqual(evaluateBusinessAcceptanceV1(input), {
      accepted: false,
      reason_codes: ["business_acceptance_input_invalid"],
      evidence_refs: [],
    });
  }
});

test("does not mutate input and returns deterministic sorted output", () => {
  const input = acceptedInput({}, {
    pending_attention_refs: ["attention:z", "attention:a"],
  });
  const before = structuredClone(input);

  const first = evaluateBusinessAcceptanceV1(input);
  const second = evaluateBusinessAcceptanceV1(input);

  assert.deepEqual(input, before);
  assert.deepEqual(second, first);
  assert.deepEqual(first.reason_codes, [...first.reason_codes].sort());
  assert.deepEqual(first.evidence_refs, [...first.evidence_refs].sort());
});
