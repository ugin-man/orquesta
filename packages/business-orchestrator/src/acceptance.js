"use strict";

const { normalizeBusinessWorkOrderPlanV1 } = require("./contract");

const MAX_INPUT_BYTES = 262_144;
const MAX_INPUT_DEPTH = 16;
const MAX_INPUT_NODES = 8_192;
const MAX_ARRAY_ITEMS = 1_024;
const MAX_REF_BYTES = 256;
const MAX_TEXT_BYTES = 32_768;

const REVIEW_MINIMUM_COUNTS = Object.freeze({ light: 0, normal: 1, strict: 2 });
const ACCEPTED_WORK_BRANCH_STATUSES = new Set(["verified", "accepted"]);
const ACCEPTED_VERIFICATION_STATUSES = new Set(["passed"]);

const INPUT_FIELDS = new Set(["plan", "snapshot"]);
const SNAPSHOT_FIELDS = new Set([
  "work_order_id",
  "project_ref",
  "plan_snapshot_id",
  "plan_hash",
  "plan_revision",
  "work_order_revision",
  "branches",
  "criterion_results",
  "reviews",
  "pending_attention_refs",
  "open_risk_refs",
  "unverified_refs",
  "verification_checks",
]);
const BRANCH_RESULT_FIELDS = new Set([
  "branch_ref",
  "status",
  "artifact_refs",
  "evidence_refs",
]);
const CRITERION_RESULT_FIELDS = new Set(["criterion_id", "status", "evidence_refs"]);
const REVIEW_FIELDS = new Set([
  "branch_ref",
  "review_id",
  "reviewer_ref",
  "status",
  "findings",
  "evidence_refs",
]);
const REVIEW_FINDING_FIELDS = new Set(["critical", "important", "minor"]);
const CONTENT_REF_FIELDS = new Set(["id", "hash"]);
const VERIFICATION_CHECK_FIELDS = new Set([
  "branch_ref",
  "criterion_id",
  "kind",
  "verifier_ref",
  "verification_ref",
  "status",
  "evidence_refs",
]);

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactFields(value, fields) {
  if (!isPlainRecord(value)) return false;
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== fields.size || Object.getOwnPropertySymbols(value).length !== 0) {
    return false;
  }
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) return false;
  }
  return names.every((name) => fields.has(name));
}

function isPortableRef(value) {
  return typeof value === "string"
    && value.trim() === value
    && value.length > 0
    && byteLength(value) <= MAX_REF_BYTES
    && /^[A-Za-z0-9][A-Za-z0-9._:/@+\-]*$/u.test(value);
}

function isContentAddressedRef(value) {
  return hasExactFields(value, CONTENT_REF_FIELDS)
    && isPortableRef(value.id)
    && typeof value.hash === "string"
    && /^[a-f0-9]{64}$/u.test(value.hash);
}

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Reject hostile or accidentally enormous values before contract hashing or
 * validation. The walk is iterative so deeply nested input fails closed
 * without overflowing the JavaScript call stack.
 */
function preflightInput(root) {
  const stack = [{ value: root, depth: 0 }];
  const seen = new WeakSet();
  let nodes = 0;
  let bytes = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    nodes += 1;
    if (nodes > MAX_INPUT_NODES || current.depth > MAX_INPUT_DEPTH) return false;

    const value = current.value;
    if (value === null || typeof value === "boolean") {
      bytes += 4;
    } else if (typeof value === "string") {
      const valueBytes = byteLength(value);
      if (valueBytes > MAX_TEXT_BYTES * 2) return false;
      bytes += valueBytes + 2;
    } else if (typeof value === "number") {
      if (!Number.isFinite(value)) return false;
      bytes += 24;
    } else if (!value || typeof value !== "object") {
      return false;
    } else {
      if (seen.has(value)) return false;
      seen.add(value);

      const prototype = Object.getPrototypeOf(value);
      if (Array.isArray(value)) {
        if (prototype !== Array.prototype || value.length > MAX_ARRAY_ITEMS) return false;
        const names = Object.getOwnPropertyNames(value);
        if (Object.getOwnPropertySymbols(value).length !== 0 || names.length !== value.length + 1) {
          return false;
        }
        for (let index = 0; index < value.length; index += 1) {
          const name = String(index);
          if (names[index] !== name) return false;
          const descriptor = Object.getOwnPropertyDescriptor(value, name);
          if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) {
            return false;
          }
          stack.push({ value: descriptor.value, depth: current.depth + 1 });
        }
      } else {
        if (prototype !== Object.prototype && prototype !== null) return false;
        const names = Object.getOwnPropertyNames(value);
        if (Object.getOwnPropertySymbols(value).length !== 0) return false;
        for (const name of names) {
          const descriptor = Object.getOwnPropertyDescriptor(value, name);
          if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) {
            return false;
          }
          bytes += byteLength(name) + 3;
          stack.push({ value: descriptor.value, depth: current.depth + 1 });
        }
      }
      bytes += 2;
    }

    if (bytes > MAX_INPUT_BYTES) return false;
  }

  return true;
}

function invalidResult(reasonCode) {
  return {
    accepted: false,
    reason_codes: [reasonCode],
    evidence_refs: [],
  };
}

function validateEvidenceRefs(value, reasons, reasonCode, evidence) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 128) {
    reasons.add(reasonCode);
    return false;
  }
  let valid = true;
  const local = new Set();
  for (const ref of value) {
    if (!isPortableRef(ref) || local.has(ref)) {
      valid = false;
      continue;
    }
    local.add(ref);
    evidence.add(ref);
  }
  if (!valid) reasons.add(reasonCode);
  return valid;
}

function validateArtifactRefs(value, reasons, reasonCode) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 128) {
    reasons.add(reasonCode);
    return false;
  }
  let valid = true;
  const ids = new Set();
  for (const ref of value) {
    if (!isContentAddressedRef(ref) || ids.has(ref.id)) {
      valid = false;
      continue;
    }
    ids.add(ref.id);
  }
  if (!valid) reasons.add(reasonCode);
  return valid;
}

function validateEmptyRefList(value, reasons, invalidCode, presentCode) {
  if (!Array.isArray(value) || value.length > 128) {
    reasons.add(invalidCode);
    return;
  }
  if (value.length > 0) reasons.add(presentCode);
  if (value.some((ref) => !isPortableRef(ref))) reasons.add(invalidCode);
}

function validateSnapshotIdentity(snapshot, plan, reasons) {
  if (typeof snapshot.work_order_id !== "string"
      || !/^WO-[a-f0-9]{32}$/u.test(snapshot.work_order_id)) {
    reasons.add("work_order_id_invalid");
  }

  if (!isPortableRef(snapshot.project_ref)) {
    reasons.add("snapshot_project_ref_invalid");
  } else if (snapshot.project_ref !== plan.project_ref) {
    reasons.add("snapshot_project_ref_mismatch");
  }

  if (typeof snapshot.plan_snapshot_id !== "string"
      || !/^BPS-[a-f0-9]{32}$/u.test(snapshot.plan_snapshot_id)) {
    reasons.add("snapshot_plan_snapshot_id_invalid");
  } else if (snapshot.plan_snapshot_id !== plan.plan_snapshot_id) {
    reasons.add("snapshot_plan_snapshot_id_mismatch");
  }

  if (typeof snapshot.plan_hash !== "string" || !/^[a-f0-9]{64}$/u.test(snapshot.plan_hash)) {
    reasons.add("snapshot_plan_hash_invalid");
  } else if (snapshot.plan_hash !== plan.plan_hash) {
    reasons.add("snapshot_plan_hash_mismatch");
  }

  if (!Number.isSafeInteger(snapshot.plan_revision) || snapshot.plan_revision < 1) {
    reasons.add("snapshot_plan_revision_invalid");
  } else if (snapshot.plan_revision !== plan.revision) {
    reasons.add("snapshot_plan_revision_mismatch");
  }

  if (!Number.isSafeInteger(snapshot.work_order_revision) || snapshot.work_order_revision < 1) {
    reasons.add("snapshot_work_order_revision_invalid");
  }
}

function validateBranches(snapshot, plan, reasons, evidence) {
  if (!Array.isArray(snapshot.branches) || snapshot.branches.length > 64) {
    reasons.add("branch_results_invalid");
    reasons.add("branch_set_mismatch");
    return;
  }

  const planByRef = new Map(plan.branches.map((branch) => [branch.branch_ref, branch]));
  const resultRefs = new Set();
  for (const result of snapshot.branches) {
    if (!hasExactFields(result, BRANCH_RESULT_FIELDS)) {
      reasons.add("branch_result_invalid");
      continue;
    }
    if (!isPortableRef(result.branch_ref)) {
      reasons.add("branch_ref_invalid");
      continue;
    }
    if (resultRefs.has(result.branch_ref)) reasons.add("branch_result_duplicate");
    resultRefs.add(result.branch_ref);
    validateEvidenceRefs(
      result.evidence_refs,
      reasons,
      "branch_evidence_invalid",
      evidence,
    );
    validateArtifactRefs(
      result.artifact_refs,
      reasons,
      "branch_artifact_refs_invalid",
    );

    const planned = planByRef.get(result.branch_ref);
    if (!planned) continue;
    if (planned.role === "integration") {
      if (result.status !== "accepted") reasons.add("integration_branch_not_accepted");
    } else if (!ACCEPTED_WORK_BRANCH_STATUSES.has(result.status)) {
      reasons.add("work_branch_not_verified_or_accepted");
    }
  }

  if (resultRefs.size !== planByRef.size
      || [...resultRefs].some((branchRef) => !planByRef.has(branchRef))) {
    reasons.add("branch_set_mismatch");
  }
}

function validateCriterionResults(snapshot, plan, reasons, evidence) {
  if (!Array.isArray(snapshot.criterion_results) || snapshot.criterion_results.length > 64) {
    reasons.add("criterion_results_invalid");
    reasons.add("criterion_result_set_mismatch");
    return new Map();
  }

  const expectedIds = new Set(
    plan.acceptance_policy.criteria.map((criterion) => criterion.criterion_id),
  );
  const resultIds = new Set();
  const resultsById = new Map();
  for (const result of snapshot.criterion_results) {
    if (!hasExactFields(result, CRITERION_RESULT_FIELDS)) {
      reasons.add("criterion_result_invalid");
      continue;
    }
    if (!isPortableRef(result.criterion_id)) {
      reasons.add("criterion_id_invalid");
      continue;
    }
    const firstResult = !resultIds.has(result.criterion_id);
    if (!firstResult) {
      reasons.add("criterion_result_duplicate");
    } else {
      resultIds.add(result.criterion_id);
    }
    if (result.status !== "passed") reasons.add("criterion_not_passed");
    const evidenceValid = validateEvidenceRefs(
      result.evidence_refs,
      reasons,
      "criterion_evidence_invalid",
      evidence,
    );
    if (firstResult && evidenceValid) resultsById.set(result.criterion_id, result);
  }

  if (resultIds.size !== expectedIds.size
      || [...resultIds].some((criterionId) => !expectedIds.has(criterionId))) {
    reasons.add("criterion_result_set_mismatch");
  }

  return resultsById;
}

function validateReviews(snapshot, plan, reasons, evidence) {
  if (!Array.isArray(snapshot.reviews) || snapshot.reviews.length > 64) {
    reasons.add("reviews_invalid");
    reasons.add("review_count_below_minimum");
    return;
  }

  const assigneeRefs = new Set(plan.branches.map((branch) => branch.assignee_ref));
  const acceptanceBranchRef = plan.integration_branch_ref
    ?? plan.branches.find((branch) => branch.role === "work").branch_ref;
  const reviewIds = new Set();
  const reviewerRefs = new Set();
  let validReviewCount = 0;

  for (const review of snapshot.reviews) {
    let valid = true;
    if (!hasExactFields(review, REVIEW_FIELDS)) {
      reasons.add("review_invalid");
      continue;
    }

    if (!isPortableRef(review.branch_ref)) {
      reasons.add("review_branch_ref_invalid");
      valid = false;
    } else if (review.branch_ref !== acceptanceBranchRef) {
      reasons.add("review_branch_mismatch");
      valid = false;
    }

    if (!isPortableRef(review.review_id)) {
      reasons.add("review_id_invalid");
      valid = false;
    } else if (reviewIds.has(review.review_id)) {
      reasons.add("review_duplicate");
      valid = false;
    } else {
      reviewIds.add(review.review_id);
    }

    if (!isPortableRef(review.reviewer_ref)) {
      reasons.add("reviewer_ref_invalid");
      valid = false;
    } else {
      if (reviewerRefs.has(review.reviewer_ref)) {
        reasons.add("reviewer_duplicate");
        valid = false;
      }
      reviewerRefs.add(review.reviewer_ref);
      if (assigneeRefs.has(review.reviewer_ref)) {
        reasons.add("review_not_independent");
        valid = false;
      }
    }

    if (review.status !== "accepted") {
      reasons.add("review_not_accepted");
      valid = false;
    }

    if (!hasExactFields(review.findings, REVIEW_FINDING_FIELDS)
        || !isCount(review.findings.critical)
        || !isCount(review.findings.important)
        || !isCount(review.findings.minor)) {
      reasons.add("review_findings_invalid");
      valid = false;
    } else if (review.findings.critical > 0 || review.findings.important > 0) {
      reasons.add("review_blocking_findings_present");
      valid = false;
    }

    if (!validateEvidenceRefs(
      review.evidence_refs,
      reasons,
      "review_evidence_invalid",
      evidence,
    )) valid = false;

    if (valid) validReviewCount += 1;
  }

  const requiredCount = REVIEW_MINIMUM_COUNTS[plan.acceptance_policy.review_minimum];
  if (!Number.isInteger(requiredCount) || validReviewCount < requiredCount) {
    reasons.add("review_count_below_minimum");
  }
}

function setsEqual(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function verificationRequirementKey(kind, verificationRef) {
  return `${kind}\u0000${verificationRef.id}\u0000${verificationRef.hash}`;
}

function validateVerificationChecks(snapshot, plan, criterionResults, reasons, evidence) {
  if (!Array.isArray(snapshot.verification_checks) || snapshot.verification_checks.length > 128) {
    reasons.add("verification_checks_invalid");
    return;
  }

  const criteriaById = new Map(
    plan.acceptance_policy.criteria.map((criterion) => [criterion.criterion_id, criterion]),
  );
  const assigneeRefs = new Set(plan.branches.map((branch) => branch.assignee_ref));
  const acceptanceBranchRef = plan.integration_branch_ref
    ?? plan.branches.find((branch) => branch.role === "work").branch_ref;
  const verificationRefIds = new Set();
  const verifierRefs = new Set();
  const evidenceOwners = new Map();
  const acceptedChecksByCriterion = new Map(
    [...criteriaById].map(([criterionId]) => [criterionId, {
      deterministic: 0,
      human: 0,
      requirement_keys: new Set(),
      evidence_refs: new Set(),
    }]),
  );

  for (const check of snapshot.verification_checks) {
    let valid = true;
    if (!hasExactFields(check, VERIFICATION_CHECK_FIELDS)) {
      reasons.add("verification_check_invalid");
      continue;
    }

    if (!isPortableRef(check.branch_ref)) {
      reasons.add("verification_check_branch_ref_invalid");
      valid = false;
    } else if (check.branch_ref !== acceptanceBranchRef) {
      reasons.add("verification_check_branch_mismatch");
      valid = false;
    }

    if (!isPortableRef(check.criterion_id)) {
      reasons.add("verification_check_criterion_id_invalid");
      valid = false;
    } else if (!criteriaById.has(check.criterion_id)) {
      reasons.add("verification_check_criterion_unknown");
      valid = false;
    }

    if (check.kind !== "deterministic" && check.kind !== "human") {
      reasons.add("verification_check_kind_invalid");
      valid = false;
    }

    if (!isPortableRef(check.verifier_ref)) {
      reasons.add("verification_check_verifier_ref_invalid");
      valid = false;
    } else if (verifierRefs.has(check.verifier_ref)) {
      // A verifier identity may contribute at most one acceptance check. This
      // prevents duplicate projections or one synthetic identity from being
      // counted as every required verification lane.
      reasons.add("verification_check_verifier_duplicate");
      valid = false;
    } else {
      verifierRefs.add(check.verifier_ref);
    }

    if (check.kind === "human"
        && isPortableRef(check.verifier_ref)
        && assigneeRefs.has(check.verifier_ref)) {
      reasons.add("human_verifier_not_independent");
      valid = false;
    }

    const verificationRefValid = isContentAddressedRef(check.verification_ref);
    if (!verificationRefValid) {
      reasons.add("verification_check_ref_invalid");
      valid = false;
    } else if (verificationRefIds.has(check.verification_ref.id)) {
      reasons.add("verification_check_duplicate");
      valid = false;
    } else {
      verificationRefIds.add(check.verification_ref.id);
    }

    let requirementKey;
    if (criteriaById.has(check.criterion_id)
        && (check.kind === "deterministic" || check.kind === "human")
        && verificationRefValid) {
      requirementKey = verificationRequirementKey(check.kind, check.verification_ref);
      const plannedKeys = new Set(
        criteriaById.get(check.criterion_id).verification_requirements.map((requirement) => (
          verificationRequirementKey(requirement.kind, requirement.verification_ref)
        )),
      );
      if (!plannedKeys.has(requirementKey)) {
        reasons.add("verification_check_not_plan_bound");
        valid = false;
      }
    }

    if (!ACCEPTED_VERIFICATION_STATUSES.has(check.status)) {
      reasons.add("verification_check_not_passed");
      valid = false;
    }

    const localEvidence = new Set();
    if (!validateEvidenceRefs(
      check.evidence_refs,
      reasons,
      "verification_check_evidence_invalid",
      localEvidence,
    )) valid = false;

    for (const evidenceRef of localEvidence) {
      const owner = evidenceOwners.get(evidenceRef);
      if (owner !== undefined) {
        reasons.add("verification_check_evidence_reused");
        valid = false;
      } else {
        evidenceOwners.set(
          evidenceRef,
          verificationRefValid ? check.verification_ref.id : check,
        );
      }
      evidence.add(evidenceRef);
    }

    if (!valid) continue;
    const accepted = acceptedChecksByCriterion.get(check.criterion_id);
    accepted[check.kind] += 1;
    accepted.requirement_keys.add(requirementKey);
    for (const evidenceRef of localEvidence) accepted.evidence_refs.add(evidenceRef);
  }

  for (const [criterionId, criterion] of criteriaById) {
    const accepted = acceptedChecksByCriterion.get(criterionId);
    for (const requirement of criterion.verification_requirements) {
      const requirementKey = verificationRequirementKey(
        requirement.kind,
        requirement.verification_ref,
      );
      if (!accepted.requirement_keys.has(requirementKey)) {
        reasons.add("verification_requirement_missing");
      }
    }
    if ((criterion.verification === "deterministic" || criterion.verification === "mixed")
        && accepted.deterministic < 1) {
      reasons.add("criterion_deterministic_verification_missing");
    }
    if ((criterion.verification === "human_only" || criterion.verification === "mixed")
        && accepted.human < 1) {
      reasons.add("criterion_human_verification_missing");
    }

    const result = criterionResults.get(criterionId);
    if (!result || !Array.isArray(result.evidence_refs)) continue;
    const resultEvidence = new Set(
      result.evidence_refs.filter((ref) => isPortableRef(ref)),
    );
    // Criterion evidence is not an arbitrary assertion: it must equal the
    // unique union of evidence from every accepted check for that criterion.
    if (!setsEqual(resultEvidence, accepted.evidence_refs)) {
      reasons.add("criterion_evidence_not_bound_to_checks");
    }
  }
}

/**
 * SECURITY BOUNDARY: `input.snapshot` MUST be emitted by a trusted EventStore
 * projector which has authenticated verifier principals and resolved every
 * evidence/event reference. This pure evaluator only validates structural and
 * policy binding; it does not authorize verifiers or prove referenced evidence
 * exists. Runtime progress is deliberately absent: "turn completed" is not
 * acceptance.
 *
 * @param {{plan: object, snapshot: object}} input
 * @returns {{accepted: boolean, reason_codes: string[], evidence_refs: string[]}}
 */
function evaluateBusinessAcceptanceV1(input) {
  try {
    if (!preflightInput(input) || !hasExactFields(input, INPUT_FIELDS)) {
      return invalidResult("business_acceptance_input_invalid");
    }

    let plan;
    try {
      plan = normalizeBusinessWorkOrderPlanV1(input.plan);
    } catch {
      return invalidResult("business_acceptance_plan_invalid");
    }

    if (!hasExactFields(input.snapshot, SNAPSHOT_FIELDS)) {
      return invalidResult("business_acceptance_snapshot_invalid");
    }

    const snapshot = input.snapshot;
    const reasons = new Set();
    const evidence = new Set();

    validateSnapshotIdentity(snapshot, plan, reasons);
    validateBranches(snapshot, plan, reasons, evidence);
    const criterionResults = validateCriterionResults(snapshot, plan, reasons, evidence);
    validateReviews(snapshot, plan, reasons, evidence);
    validateEmptyRefList(
      snapshot.pending_attention_refs,
      reasons,
      "pending_attention_refs_invalid",
      "pending_attention_present",
    );
    validateEmptyRefList(
      snapshot.open_risk_refs,
      reasons,
      "open_risk_refs_invalid",
      "open_risks_present",
    );
    validateEmptyRefList(
      snapshot.unverified_refs,
      reasons,
      "unverified_refs_invalid",
      "unverified_refs_present",
    );
    validateVerificationChecks(snapshot, plan, criterionResults, reasons, evidence);

    const reasonCodes = [...reasons].sort();
    return {
      accepted: reasonCodes.length === 0,
      reason_codes: reasonCodes,
      evidence_refs: [...evidence].sort(),
    };
  } catch {
    return invalidResult("business_acceptance_input_invalid");
  }
}

// Compatibility name for the preview package. New callers should pin V1.
const evaluateBusinessAcceptance = evaluateBusinessAcceptanceV1;

module.exports = {
  evaluateBusinessAcceptance,
  evaluateBusinessAcceptanceV1,
};
