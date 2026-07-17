"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { assertContract } = require("@orquesta/contracts");

const { createAuditionPlan, runAudition } = require("../src");

function fixture() {
  const workspaceRoot = path.resolve("C:/workspace/project");
  const temporaryRoot = path.resolve("C:/workspace/temp");
  const auditionRoot = path.join(temporaryRoot, "audition-runner");
  const roots = { workspace_root: workspaceRoot, temporary_root: temporaryRoot, audition_root: auditionRoot };
  const plan = createAuditionPlan({
    task_intent_id: "TI-1234567890ab", task_intent_hash: "1".repeat(64),
    resolution_id: "RES-1234567890ab", resolution_revision: 2, resolution_hash: "2".repeat(64),
    candidate: { candidate_id: "candidate-runner", version: "1.0.0", source_hash: "3".repeat(64) },
    workspace_root: workspaceRoot, temporary_root: temporaryRoot, audition_root: auditionRoot,
    expected_profile: { profile_id: "phase2-audition", allowed_roots: [workspaceRoot, auditionRoot], effects: ["workspace_write"] },
    permitted_effects: ["workspace_write"], steps: [{ step_id: "run", action: "exercise candidate" }],
    expected_evidence: ["evidence:codex-run"],
    cleanup_plan: { root: auditionRoot, max_paths: 128 }, approval_refs: ["approval:runner"]
  });
  return { plan, roots };
}

function compatibleProfile({ plan, roots }) {
  return {
    status: "available", verified: true, profile_id: plan.expected_codex_profile, source: "codex-runtime-profile",
    captured_at: "2026-07-17T00:00:00.000Z",
    allowed_roots: [roots.workspace_root, roots.audition_root],
    effects: [...plan.permitted_effects]
  };
}

function rootEntry(target, identity, overrides = {}) {
  return { path: target, real_path: target, type: "directory", identity, ...overrides };
}

function makeFsAdapter(roots, fileEntries = [], rootOverrides = {}) {
  const rootEntries = new Map([
    [roots.workspace_root, rootEntry(roots.workspace_root, "workspace-id", rootOverrides.workspace)],
    [roots.temporary_root, rootEntry(roots.temporary_root, "temporary-id", rootOverrides.temporary)],
    [roots.audition_root, rootEntry(roots.audition_root, "audition-id", rootOverrides.audition)]
  ]);
  const files = new Map(fileEntries.map((entry) => [path.resolve(entry.path), entry]));
  const removed = [];
  return {
    removed,
    inspect: async (target) => rootEntries.get(path.resolve(target)) || files.get(path.resolve(target)),
    remove: async (target, options) => removed.push({ target, options })
  };
}

test("emits a registered inconclusive result and blocks before harness.run for missing, unavailable, or broader profiles", async () => {
  for (const selectProfile of [
    () => null,
    () => ({ status: "unavailable" }),
    (context) => ({ ...compatibleProfile(context), effects: ["network_access", "workspace_write"] })
  ]) {
    const context = fixture();
    let runs = 0;
    const result = await runAudition({
      ...context,
      harness: { inspectProfile: async () => selectProfile(context), run: async () => { runs += 1; } },
      fsAdapter: makeFsAdapter(context.roots),
      evidenceSink: { record: async () => {} }
    });
    assert.equal(runs, 0);
    assert.equal(result.verdict, "inconclusive");
    assert.doesNotThrow(() => assertContract("audition-result", result));
  }
});

test("blocks before harness.run when the profile omits a required root or effect", async () => {
  for (const omit of ["root", "effect"]) {
    const context = fixture();
    const profile = compatibleProfile(context);
    const selected = omit === "root"
      ? { ...profile, allowed_roots: [context.roots.workspace_root] }
      : { ...profile, effects: [] };
    let runs = 0;
    const result = await runAudition({
      ...context,
      harness: { inspectProfile: async () => selected, run: async () => { runs += 1; } },
      fsAdapter: makeFsAdapter(context.roots),
      evidenceSink: { record: async () => {} }
    });
    assert.equal(runs, 0);
    assert.equal(result.verdict, "inconclusive");
  }
});

test("blocks before harness.run when a workspace, temporary, or Audition root is linked, aliased, or escapes after realpath", async () => {
  const cases = [
    { workspace: { type: "symlink" } },
    { temporary: { type: "junction" } },
    { audition: { real_path: path.resolve("C:/outside/audition") } },
    { audition: { identity: "temporary-id" } }
  ];
  for (const overrides of cases) {
    const context = fixture();
    let runs = 0;
    const result = await runAudition({
      ...context,
      harness: { inspectProfile: async () => compatibleProfile(context), run: async () => { runs += 1; } },
      fsAdapter: makeFsAdapter(context.roots, [], overrides),
      evidenceSink: { record: async () => {} }
    });
    assert.equal(runs, 0);
    assert.equal(result.verdict, "inconclusive");
    assert.doesNotThrow(() => assertContract("audition-result", result));
  }
});

test("runs only through the injected harness, verifies cleanup, and records a registered passed result", async () => {
  const context = fixture();
  const existing = { path: path.join(context.roots.audition_root, "existing.txt"), real_path: path.join(context.roots.audition_root, "existing.txt"), type: "file", hash: "4".repeat(64), identity: "existing-id" };
  const created = { path: path.join(context.roots.audition_root, "created.txt"), real_path: path.join(context.roots.audition_root, "created.txt"), type: "file", hash: "5".repeat(64), identity: "created-id" };
  const fsAdapter = makeFsAdapter(context.roots, [created]);
  const evidence = [];
  let passedPlan = null;
  const result = await runAudition({
    ...context,
    harness: {
      inspectProfile: async () => compatibleProfile(context),
      run: async (value) => {
        passedPlan = value;
        return { status: "completed", before_manifest: [existing], after_manifest: [existing, created], effects: ["workspace_write"], evidence_refs: ["evidence:codex-run"] };
      }
    },
    fsAdapter,
    evidenceSink: { record: async (item) => evidence.push(item) }
  });

  assert.equal(passedPlan, context.plan);
  assert.equal(result.verdict, "passed");
  assert.deepEqual(result.side_effects, ["workspace_write"]);
  assert.deepEqual(result.evidence_refs, ["evidence:codex-run"]);
  assert.ok(result.cleanup_evidence.includes("cleanup:clean"));
  assert.deepEqual(fsAdapter.removed, [{ target: created.path, options: { expected_identity: "created-id" } }]);
  assert.equal(evidence.length, 1);
  assert.doesNotThrow(() => assertContract("audition-result", result));
});

test("records a registered failed result when the primary harness operation fails", async () => {
  const context = fixture();
  const result = await runAudition({
    ...context,
    harness: {
      inspectProfile: async () => compatibleProfile(context),
      run: async () => { const error = new Error("primary failure"); error.code = "HARNESS_FAILED"; throw error; }
    },
    fsAdapter: makeFsAdapter(context.roots),
    evidenceSink: { record: async () => {} }
  });
  assert.equal(result.verdict, "failed");
  assert.deepEqual(result.evidence_refs, []);
  assert.deepEqual(result.cleanup_evidence, ["cleanup:unverified"]);
  assert.doesNotThrow(() => assertContract("audition-result", result));
});

test("rechecks the preflight root identity before cleanup and rejects replacement", async () => {
  const context = fixture();
  const created = { path: path.join(context.roots.audition_root, "created.txt"), real_path: path.join(context.roots.audition_root, "created.txt"), type: "file", hash: "5".repeat(64), identity: "created-id" };
  const base = makeFsAdapter(context.roots, [created]);
  let auditionChecks = 0;
  let removes = 0;
  const fsAdapter = {
    inspect: async (target) => {
      if (path.resolve(target) === context.roots.audition_root) {
        auditionChecks += 1;
        return rootEntry(context.roots.audition_root, auditionChecks === 1 ? "audition-id" : "replacement-id");
      }
      return base.inspect(target);
    },
    remove: async () => { removes += 1; }
  };
  const result = await runAudition({
    ...context,
    harness: {
      inspectProfile: async () => compatibleProfile(context),
      run: async () => ({ status: "completed", before_manifest: [], after_manifest: [created], effects: ["workspace_write"], evidence_refs: [] })
    },
    fsAdapter,
    evidenceSink: { record: async () => {} }
  });
  assert.equal(removes, 0);
  assert.equal(result.verdict, "failed");
  assert.ok(result.cleanup_evidence.includes("cleanup:root_identity_changed"));
  assert.doesNotThrow(() => assertContract("audition-result", result));
});
