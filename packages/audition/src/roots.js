"use strict";

const path = require("node:path");
const { auditionError, clone, strictDescendant } = require("./plan");

const ROOT_KEYS = Object.freeze([
  ["workspace", "workspace_root"],
  ["temporary", "temporary_root"],
  ["audition", "audition_root"]
]);

function normalizeRoots(plan, roots) {
  if (!plan || !plan.execution_root || !roots) throw auditionError("AUDITION_ROOT_INVALID", "Audition roots are required.");
  const normalized = {};
  for (const [, field] of ROOT_KEYS) {
    if (typeof roots[field] !== "string" || !roots[field].trim()) throw auditionError("AUDITION_ROOT_INVALID", "Every Audition root must be explicit.");
    normalized[field] = path.resolve(roots[field]);
  }
  if (plan.execution_root.kind !== "temporary" || path.resolve(plan.execution_root.path) !== normalized.audition_root) {
    throw auditionError("AUDITION_ROOT_INVALID", "The durable execution root must be the exact Audition root.");
  }
  if (!strictDescendant(normalized.temporary_root, normalized.audition_root)
    || normalized.workspace_root === normalized.temporary_root
    || strictDescendant(normalized.workspace_root, normalized.temporary_root)
    || strictDescendant(normalized.temporary_root, normalized.workspace_root)) {
    throw auditionError("AUDITION_ROOT_INVALID", "Workspace, temporary, and Audition roots must be separate with Audition contained by temporary.");
  }
  return normalized;
}

function validRootObservation(expectedPath, observed) {
  return observed
    && observed.type === "directory"
    && typeof observed.identity === "string" && observed.identity.trim()
    && typeof observed.path === "string" && path.resolve(observed.path) === expectedPath
    && typeof observed.real_path === "string" && path.resolve(observed.real_path) === expectedPath;
}

async function preflightAuditionRoots({ plan, roots, fsAdapter } = {}) {
  if (!fsAdapter || typeof fsAdapter.inspect !== "function") throw auditionError("AUDITION_ROOT_ADAPTER_REQUIRED", "Audition root preflight requires an injected filesystem adapter.");
  const normalized = normalizeRoots(plan, roots);
  const verified = {};
  for (const [key, field] of ROOT_KEYS) {
    const observed = await fsAdapter.inspect(normalized[field]);
    if (!validRootObservation(normalized[field], observed)) throw auditionError("AUDITION_ROOT_UNVERIFIED", `The ${key} root is linked, aliased, replaced, or not a regular directory.`);
    verified[key] = clone(observed);
  }
  const identities = ROOT_KEYS.map(([key]) => verified[key].identity);
  const realPaths = ROOT_KEYS.map(([key]) => path.resolve(verified[key].real_path));
  if (new Set(identities).size !== identities.length || new Set(realPaths).size !== realPaths.length
    || !strictDescendant(realPaths[1], realPaths[2])) {
    throw auditionError("AUDITION_ROOT_UNVERIFIED", "Audition root identities must be distinct and real-path-contained.");
  }
  return verified;
}

async function recheckAuditionRoots({ verifiedRoots, fsAdapter } = {}) {
  if (!verifiedRoots || !fsAdapter || typeof fsAdapter.inspect !== "function") return false;
  for (const [key] of ROOT_KEYS) {
    const expected = verifiedRoots[key];
    if (!expected) return false;
    let observed;
    try {
      observed = await fsAdapter.inspect(expected.path);
    } catch {
      return false;
    }
    if (!validRootObservation(path.resolve(expected.path), observed)
      || observed.identity !== expected.identity
      || path.resolve(observed.real_path) !== path.resolve(expected.real_path)) return false;
  }
  return true;
}

module.exports = { normalizeRoots, preflightAuditionRoots, recheckAuditionRoots };
