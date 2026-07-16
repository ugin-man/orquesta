"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { verifyAuditionCleanup } = require("../src");

function cleanupPlan(maxPaths = 3) {
  const workspaceRoot = path.resolve("C:/workspace/project");
  const temporaryRoot = path.resolve("C:/workspace/temp");
  const auditionRoot = path.join(temporaryRoot, "audition-cleanup");
  return {
    workspace_root: workspaceRoot,
    temporary_root: temporaryRoot,
    audition_root: auditionRoot,
    cleanup_plan: { root: auditionRoot, max_paths: maxPaths }
  };
}

function entry(filePath, identity, hash = "1".repeat(64), type = "file", realPath = filePath) {
  return { path: filePath, real_path: realPath, type, hash, identity };
}

test("records created, modified, and deleted manifests and removes only created regular paths under the dedicated root", async () => {
  const plan = cleanupPlan();
  const existing = path.join(plan.workspace_root, "existing.js");
  const deleted = path.join(plan.workspace_root, "deleted.js");
  const created = path.join(plan.audition_root, "created.txt");
  const before = [entry(existing, "existing-before", "1".repeat(64)), entry(deleted, "deleted-before", "2".repeat(64))];
  const after = [entry(existing, "existing-after", "3".repeat(64)), entry(created, "created-id", "4".repeat(64))];
  const removed = [];
  const result = await verifyAuditionCleanup({
    plan, before, after,
    fsAdapter: {
      inspect: async () => entry(created, "created-id", "4".repeat(64)),
      remove: async (target, options) => removed.push({ target, options })
    }
  });

  assert.deepEqual(result.manifest.created.map((item) => item.path), [created]);
  assert.deepEqual(result.manifest.modified.map((item) => item.path), [existing]);
  assert.deepEqual(result.manifest.deleted.map((item) => item.path), [deleted]);
  assert.equal(result.status, "clean");
  assert.deepEqual(result.cleanup.removed, [created]);
  assert.deepEqual(removed, [{ target: created, options: { expected_identity: "created-id" } }]);
});

test("rejects root, path escape, symlink, junction, unknown, and replacement paths without removing them", async () => {
  const plan = cleanupPlan(8);
  const outside = path.resolve(plan.audition_root, "../outside.txt");
  const cases = [
    entry(plan.audition_root, "root-id", "1".repeat(64), "directory"),
    entry(outside, "outside-id"),
    entry(path.join(plan.audition_root, "link"), "link-id", "1".repeat(64), "symlink", outside),
    entry(path.join(plan.audition_root, "junction"), "junction-id", "1".repeat(64), "junction", outside),
    entry(path.join(plan.audition_root, "unknown"), "unknown-id", "1".repeat(64), "unknown")
  ];
  let removes = 0;
  const rejected = await verifyAuditionCleanup({
    plan, before: [], after: cases,
    fsAdapter: { inspect: async (target) => cases.find((item) => item.path === target), remove: async () => { removes += 1; } }
  });
  assert.equal(rejected.status, "residue");
  assert.equal(rejected.cleanup.rejected.length, cases.length);
  assert.equal(removes, 0);

  const target = path.join(plan.audition_root, "replaced.txt");
  const replaced = await verifyAuditionCleanup({
    plan, before: [], after: [entry(target, "original-id")],
    fsAdapter: { inspect: async () => entry(target, "replacement-id"), remove: async () => { removes += 1; } }
  });
  assert.equal(replaced.status, "residue");
  assert.equal(replaced.cleanup.rejected[0].reason, "replacement_after_manifest");
  assert.equal(removes, 0);
});

test("bounds cleanup attempts and preserves primary plus cleanup failure evidence", async () => {
  const plan = cleanupPlan();
  const created = ["a", "b", "c", "d"].map((name) => entry(path.join(plan.audition_root, `${name}.txt`), `${name}-id`));
  let removes = 0;
  const bounded = await verifyAuditionCleanup({
    plan, before: [], after: created,
    fsAdapter: { inspect: async (target) => created.find((item) => item.path === target), remove: async () => { removes += 1; } }
  });
  assert.equal(bounded.status, "blocked");
  assert.equal(bounded.cleanup.reason, "cleanup_budget_exceeded");
  assert.equal(removes, 0);

  const failing = path.join(plan.audition_root, "failing.txt");
  const after = { entries: [entry(failing, "failing-id")], primary_error: { code: "HARNESS_FAILED", message: "primary failure" } };
  const combined = await verifyAuditionCleanup({
    plan, before: { entries: [] }, after,
    fsAdapter: {
      inspect: async () => entry(failing, "failing-id"),
      remove: async () => { const error = new Error("cleanup failure"); error.code = "CLEANUP_FAILED"; throw error; }
    }
  });
  assert.equal(combined.status, "residue");
  assert.deepEqual(combined.primary_error, after.primary_error);
  assert.deepEqual(combined.cleanup.failures, [{ path: failing, error: { code: "CLEANUP_FAILED", message: "cleanup failure" } }]);
});
