"use strict";

const path = require("node:path");
const { auditionError, clone, compareText, strictDescendant } = require("./plan");

function entries(value) {
  return Array.isArray(value) ? value : value && Array.isArray(value.entries) ? value.entries : null;
}

function safeError(error) {
  return { code: error && typeof error.code === "string" ? error.code : "AUDITION_CLEANUP_FAILED", message: error instanceof Error ? error.message : "Cleanup failed." };
}

function sortEntries(items) {
  return [...items].sort((left, right) => compareText(left.path, right.path));
}

function changed(left, right) {
  return left.type !== right.type || left.hash !== right.hash || left.identity !== right.identity || path.resolve(left.real_path || left.path) !== path.resolve(right.real_path || right.path);
}

function rejectionReason(plan, item) {
  const root = path.resolve(plan.audition_root);
  const target = path.resolve(item.path);
  const real = path.resolve(item.real_path || item.path);
  if (target === root) return "audition_root_forbidden";
  if (!strictDescendant(root, target)) return "path_escape";
  if (item.type !== "file" && item.type !== "directory") return `${item.type || "unknown"}_forbidden`;
  if (real === root || !strictDescendant(root, real)) return "resolved_path_escape";
  return null;
}

async function verifyAuditionCleanup({ plan, before, after, fsAdapter } = {}) {
  const beforeEntries = entries(before);
  const afterEntries = entries(after);
  if (!plan || !beforeEntries || !afterEntries || !fsAdapter || typeof fsAdapter.inspect !== "function" || typeof fsAdapter.remove !== "function") {
    throw auditionError("AUDITION_CLEANUP_INVALID", "Cleanup verification requires a plan, two manifests, and an injected filesystem adapter.");
  }
  if (!plan.cleanup_plan || path.resolve(plan.cleanup_plan.root || "") !== path.resolve(plan.audition_root) || !Number.isInteger(plan.cleanup_plan.max_paths)) {
    throw auditionError("AUDITION_CLEANUP_INVALID", "Cleanup plan is not bound to the Audition root.");
  }
  const beforeByPath = new Map(beforeEntries.map((item) => [path.resolve(item.path), clone(item)]));
  const afterByPath = new Map(afterEntries.map((item) => [path.resolve(item.path), clone(item)]));
  if (beforeByPath.size !== beforeEntries.length || afterByPath.size !== afterEntries.length) {
    throw auditionError("AUDITION_MANIFEST_INVALID", "Manifest paths must be unique.");
  }
  const created = sortEntries([...afterByPath].filter(([key]) => !beforeByPath.has(key)).map(([, item]) => item));
  const modified = sortEntries([...afterByPath].filter(([key, item]) => beforeByPath.has(key) && changed(beforeByPath.get(key), item)).map(([, item]) => item));
  const deleted = sortEntries([...beforeByPath].filter(([key]) => !afterByPath.has(key)).map(([, item]) => item));
  const manifest = { created, modified, deleted };
  const primaryError = after && !Array.isArray(after) && after.primary_error ? clone(after.primary_error) : null;
  if (created.length > plan.cleanup_plan.max_paths) {
    return {
      status: "blocked", primary_error: primaryError, manifest,
      cleanup: { reason: "cleanup_budget_exceeded", attempted: [], removed: [], rejected: [], failures: [], residue: created.map((item) => item.path) }
    };
  }

  const cleanup = { attempted: [], removed: [], rejected: [], failures: [], residue: [] };
  const candidates = [...created].sort((left, right) => {
    const depth = right.path.split(/[\\/]/).length - left.path.split(/[\\/]/).length;
    return depth || compareText(left.path, right.path);
  });
  for (const item of candidates) {
    const reason = rejectionReason(plan, item);
    if (reason) {
      cleanup.rejected.push({ path: item.path, reason });
      cleanup.residue.push(item.path);
      continue;
    }
    cleanup.attempted.push(item.path);
    let observed;
    try {
      observed = await fsAdapter.inspect(item.path);
    } catch (error) {
      cleanup.failures.push({ path: item.path, error: safeError(error) });
      cleanup.residue.push(item.path);
      continue;
    }
    if (!observed || observed.identity !== item.identity || observed.type !== item.type
      || path.resolve(observed.real_path || observed.path) !== path.resolve(item.real_path || item.path)) {
      cleanup.rejected.push({ path: item.path, reason: "replacement_after_manifest" });
      cleanup.residue.push(item.path);
      continue;
    }
    try {
      await fsAdapter.remove(item.path, { expected_identity: item.identity });
      cleanup.removed.push(item.path);
    } catch (error) {
      cleanup.failures.push({ path: item.path, error: safeError(error) });
      cleanup.residue.push(item.path);
    }
  }
  cleanup.removed.sort(compareText);
  cleanup.rejected.sort((left, right) => compareText(left.path, right.path));
  cleanup.failures.sort((left, right) => compareText(left.path, right.path));
  cleanup.residue.sort(compareText);
  return { status: cleanup.residue.length ? "residue" : "clean", primary_error: primaryError, manifest, cleanup };
}

module.exports = { verifyAuditionCleanup };
