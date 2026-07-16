"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { createAuditionPlan, runAudition } = require("../src");

function plan() {
  const workspaceRoot = path.resolve("C:/workspace/project");
  const temporaryRoot = path.resolve("C:/workspace/temp");
  const auditionRoot = path.join(temporaryRoot, "audition-runner");
  return createAuditionPlan({
    task_intent_id: "TI-runner", task_intent_hash: "1".repeat(64),
    resolution_id: "RES-runner", resolution_revision: 2, resolution_hash: "2".repeat(64),
    candidate: { candidate_id: "candidate-runner", version: "1.0.0", source_hash: "3".repeat(64) },
    workspace_root: workspaceRoot, temporary_root: temporaryRoot, audition_root: auditionRoot,
    expected_profile: { allowed_roots: [workspaceRoot, auditionRoot], effects: ["workspace_write"] },
    permitted_effects: ["workspace_write"], steps: [{ step_id: "run", action: "exercise" }],
    expected_evidence: ["before_manifest", "after_manifest"],
    cleanup_plan: { root: auditionRoot, max_paths: 128 }, approval_refs: ["approval:runner"]
  });
}

function compatibleProfile(auditionPlan) {
  return {
    status: "available", verified: true, source: "codex-runtime-profile",
    captured_at: "2026-07-17T00:00:00.000Z",
    allowed_roots: auditionPlan.expected_profile.allowed_roots,
    effects: auditionPlan.expected_profile.effects
  };
}

test("blocks before harness.run when the actual profile is missing, unavailable, or broader", async () => {
  for (const profile of [null, { status: "unavailable" }, compatibleProfile(plan())]) {
    const auditionPlan = plan();
    const selected = profile && profile.status === "available"
      ? { ...profile, effects: [...profile.effects, "network_access"] }
      : profile;
    let runs = 0;
    const evidence = [];
    const result = await runAudition({
      plan: auditionPlan,
      harness: { inspectProfile: async () => selected, run: async () => { runs += 1; } },
      evidenceSink: { record: async (item) => evidence.push(item) }
    });
    assert.equal(result.status, "blocked");
    assert.equal(runs, 0);
    assert.equal(evidence.length, 1);
  }
});

test("runs only through the injected harness and records exact manifests, effects, and evidence", async () => {
  const auditionPlan = plan();
  const runtimeResult = {
    status: "completed",
    before_manifest: [{ path: path.join(auditionPlan.audition_root, "existing.txt"), type: "file", hash: "4".repeat(64), identity: "before" }],
    after_manifest: [{ path: path.join(auditionPlan.audition_root, "created.txt"), type: "file", hash: "5".repeat(64), identity: "after" }],
    effects: ["workspace_write"],
    evidence_refs: ["evidence:codex-run"]
  };
  const evidence = [];
  let passedPlan = null;
  const result = await runAudition({
    plan: auditionPlan,
    harness: {
      inspectProfile: async () => compatibleProfile(auditionPlan),
      run: async (value) => { passedPlan = value; return runtimeResult; }
    },
    evidenceSink: { record: async (item) => evidence.push(item) }
  });

  assert.equal(passedPlan, auditionPlan);
  assert.equal(result.status, "completed");
  assert.deepEqual(result.before_manifest, runtimeResult.before_manifest);
  assert.deepEqual(result.after_manifest, runtimeResult.after_manifest);
  assert.deepEqual(result.effects, ["workspace_write"]);
  assert.equal(evidence.length, 1);
});

test("records a primary harness failure without inventing successful runtime evidence", async () => {
  const auditionPlan = plan();
  const evidence = [];
  const result = await runAudition({
    plan: auditionPlan,
    harness: {
      inspectProfile: async () => compatibleProfile(auditionPlan),
      run: async () => { const error = new Error("primary failure"); error.code = "HARNESS_FAILED"; throw error; }
    },
    evidenceSink: { record: async (item) => evidence.push(item) }
  });
  assert.equal(result.status, "failed");
  assert.deepEqual(result.primary_error, { code: "HARNESS_FAILED", message: "primary failure" });
  assert.deepEqual(result.evidence_refs, []);
  assert.equal(evidence.length, 1);
});
