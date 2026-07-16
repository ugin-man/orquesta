"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { createAuditionPlan } = require("../src");

function planInput() {
  const workspaceRoot = path.resolve("C:/workspace/project");
  const temporaryRoot = path.resolve("C:/workspace/temp");
  const auditionRoot = path.join(temporaryRoot, "audition-1");
  return {
    task_intent_id: "TI-audition",
    task_intent_hash: "1".repeat(64),
    resolution_id: "RES-audition",
    resolution_revision: 7,
    resolution_hash: "2".repeat(64),
    candidate: {
      candidate_id: "candidate-a",
      version: "1.2.3",
      source_hash: "3".repeat(64)
    },
    workspace_root: workspaceRoot,
    temporary_root: temporaryRoot,
    audition_root: auditionRoot,
    expected_profile: {
      allowed_roots: [workspaceRoot, auditionRoot],
      effects: ["dependency_change", "workspace_write"]
    },
    permitted_effects: ["workspace_write", "dependency_change"],
    steps: [{ step_id: "inspect", action: "inspect candidate" }, { step_id: "exercise", action: "exercise candidate" }],
    expected_evidence: ["before_manifest", "after_manifest", "runtime_profile"],
    cleanup_plan: { root: auditionRoot, max_paths: 128 },
    approval_refs: ["approval:audition-1"]
  };
}

test("creates a deterministic plan bound to TaskIntent, Resolution, candidate, hashes, roots, and effects", () => {
  const input = planInput();
  const first = createAuditionPlan(input);
  const second = createAuditionPlan(JSON.parse(JSON.stringify(input)));

  assert.equal(first.plan_id, second.plan_id);
  assert.match(first.plan_id, /^AUD-[a-f0-9]{24}$/);
  assert.deepEqual(first.binding, {
    task_intent_id: input.task_intent_id,
    task_intent_hash: input.task_intent_hash,
    resolution_id: input.resolution_id,
    resolution_revision: input.resolution_revision,
    resolution_hash: input.resolution_hash,
    candidate_id: input.candidate.candidate_id,
    candidate_version: input.candidate.version,
    candidate_source_hash: input.candidate.source_hash
  });
  assert.deepEqual(first.permitted_effects, ["dependency_change", "workspace_write"]);
  assert.deepEqual(first.expected_profile.allowed_roots, [input.workspace_root, input.audition_root].sort());
  assert.equal(first.cleanup_plan.root, input.audition_root);
});

test("rejects incomplete bindings, unsupported effects, and non-dedicated or escaping audition roots", () => {
  const requiredCases = [
    ["task_intent_id", null],
    ["task_intent_hash", "bad"],
    ["resolution_id", ""],
    ["resolution_revision", 0],
    ["resolution_hash", "bad"],
    ["candidate", null]
  ];
  for (const [field, value] of requiredCases) {
    assert.throws(() => createAuditionPlan({ ...planInput(), [field]: value }), { code: "AUDITION_PLAN_INVALID" });
  }

  assert.throws(() => createAuditionPlan({ ...planInput(), permitted_effects: ["shell_escape"] }), { code: "AUDITION_EFFECT_INVALID" });
  const input = planInput();
  assert.throws(() => createAuditionPlan({ ...input, audition_root: input.temporary_root }), { code: "AUDITION_ROOT_INVALID" });
  assert.throws(
    () => createAuditionPlan({ ...input, audition_root: path.resolve(input.temporary_root, "../escape") }),
    { code: "AUDITION_ROOT_INVALID" }
  );
});
