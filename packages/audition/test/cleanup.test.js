"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { verifyAuditionCleanup } = require("../src");

function entry(filePath, identity, hash = "1".repeat(64), type = "file", realPath = filePath) {
  return { path: filePath, real_path: realPath, type, hash, identity };
}

function cleanupContext(maxPaths = 3) {
  const workspaceRoot = path.resolve("C:/workspace/project");
  const temporaryRoot = path.resolve("C:/workspace/temp");
  const auditionRoot = path.join(temporaryRoot, "audition-cleanup");
  const roots = { workspace_root: workspaceRoot, temporary_root: temporaryRoot, audition_root: auditionRoot };
  const plan = {
    audition_plan_id: "AP-1234567890ab",
    execution_root: { kind: "temporary", path: auditionRoot },
    cleanup_plan: [`max_paths:${maxPaths}`, `root:${auditionRoot}`].sort()
  };
  const verifiedRoots = {
    workspace: entry(workspaceRoot, "workspace-id", "1".repeat(64), "directory"),
    temporary: entry(temporaryRoot, "temporary-id", "1".repeat(64), "directory"),
    audition: entry(auditionRoot, "audition-id", "1".repeat(64), "directory")
  };
  return { plan, roots, verifiedRoots };
}

function cleanupAdapter(context, observed, remove) {
  const rootsByPath = new Map(Object.values(context.verifiedRoots).map((item) => [path.resolve(item.path), item]));
  return {
    inspect: async (target) => rootsByPath.get(path.resolve(target)) || observed(target),
    remove
  };
}

test("records created, modified, and deleted manifests and removes only created regular paths under the dedicated root", async () => {
  const context = cleanupContext();
  const existing = path.join(context.roots.workspace_root, "existing.js");
  const deleted = path.join(context.roots.workspace_root, "deleted.js");
  const created = path.join(context.roots.audition_root, "created.txt");
  const before = [entry(existing, "existing-before", "1".repeat(64)), entry(deleted, "deleted-before", "2".repeat(64))];
  const after = [entry(existing, "existing-after", "3".repeat(64)), entry(created, "created-id", "4".repeat(64))];
  const removed = [];
  const result = await verifyAuditionCleanup({
    ...context, before, after,
    fsAdapter: cleanupAdapter(context, async () => entry(created, "created-id", "4".repeat(64)), async (target, options) => removed.push({ target, options }))
  });

  assert.deepEqual(result.manifest.created.map((item) => item.path), [created]);
  assert.deepEqual(result.manifest.modified.map((item) => item.path), [existing]);
  assert.deepEqual(result.manifest.deleted.map((item) => item.path), [deleted]);
  assert.equal(result.status, "clean");
  assert.deepEqual(result.cleanup.removed, [created]);
  assert.deepEqual(removed, [{ target: created, options: { expected_identity: "created-id" } }]);
});

test("rejects root, path escape, symlink, junction, unknown, and replacement paths without removing them", async () => {
  const context = cleanupContext(8);
  const outside = path.resolve(context.roots.audition_root, "../outside.txt");
  const cases = [
    entry(context.roots.audition_root, "root-id", "1".repeat(64), "directory"),
    entry(outside, "outside-id"),
    entry(path.join(context.roots.audition_root, "link"), "link-id", "1".repeat(64), "symlink", outside),
    entry(path.join(context.roots.audition_root, "junction"), "junction-id", "1".repeat(64), "junction", outside),
    entry(path.join(context.roots.audition_root, "unknown"), "unknown-id", "1".repeat(64), "unknown")
  ];
  let removes = 0;
  const rejected = await verifyAuditionCleanup({
    ...context, before: [], after: cases,
    fsAdapter: cleanupAdapter(context, async (target) => cases.find((item) => item.path === target), async () => { removes += 1; })
  });
  assert.equal(rejected.status, "residue");
  assert.equal(rejected.cleanup.rejected.length, cases.length);
  assert.equal(removes, 0);

  const target = path.join(context.roots.audition_root, "replaced.txt");
  const replaced = await verifyAuditionCleanup({
    ...context, before: [], after: [entry(target, "original-id")],
    fsAdapter: cleanupAdapter(context, async () => entry(target, "replacement-id"), async () => { removes += 1; })
  });
  assert.equal(replaced.status, "residue");
  assert.equal(replaced.cleanup.rejected[0].reason, "replacement_after_manifest");
  assert.equal(removes, 0);
});

test("bounds cleanup attempts and preserves primary plus cleanup failure evidence", async () => {
  const context = cleanupContext();
  const created = ["a", "b", "c", "d"].map((name) => entry(path.join(context.roots.audition_root, `${name}.txt`), `${name}-id`));
  let removes = 0;
  const bounded = await verifyAuditionCleanup({
    ...context, before: [], after: created,
    fsAdapter: cleanupAdapter(context, async (target) => created.find((item) => item.path === target), async () => { removes += 1; })
  });
  assert.equal(bounded.status, "blocked");
  assert.equal(bounded.cleanup.reason, "cleanup_budget_exceeded");
  assert.equal(removes, 0);

  const failing = path.join(context.roots.audition_root, "failing.txt");
  const after = { entries: [entry(failing, "failing-id")], primary_error: { code: "HARNESS_FAILED", message: "primary failure" } };
  const combined = await verifyAuditionCleanup({
    ...context, before: { entries: [] }, after,
    fsAdapter: cleanupAdapter(context, async () => entry(failing, "failing-id"), async () => { const error = new Error("cleanup failure"); error.code = "CLEANUP_FAILED"; throw error; })
  });
  assert.equal(combined.status, "residue");
  assert.deepEqual(combined.primary_error, after.primary_error);
  assert.deepEqual(combined.cleanup.failures, [{ path: failing, error: { code: "CLEANUP_FAILED", message: "cleanup failure" } }]);
});

test("rejects cleanup when a verified root identity is replaced after preflight", async () => {
  const context = cleanupContext();
  const created = path.join(context.roots.audition_root, "created.txt");
  let removes = 0;
  const adapter = cleanupAdapter(context, async () => entry(created, "created-id"), async () => { removes += 1; });
  const originalInspect = adapter.inspect;
  adapter.inspect = async (target) => path.resolve(target) === context.roots.audition_root
    ? entry(context.roots.audition_root, "replacement-id", "1".repeat(64), "directory")
    : originalInspect(target);
  const result = await verifyAuditionCleanup({
    ...context, before: [], after: [entry(created, "created-id")], fsAdapter: adapter
  });
  assert.equal(removes, 0);
  assert.equal(result.status, "blocked");
  assert.equal(result.cleanup.reason, "root_identity_changed");
});
