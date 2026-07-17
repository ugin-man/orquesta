"use strict";

const path = require("node:path");
const { assertContract } = require("@orquesta/contracts");
const { auditionError, clone, compareText, strictDescendant } = require("./plan");
const { compareCodexProfile } = require("./profile");
const { verifyAuditionCleanup } = require("./cleanup");
const { normalizeRoots, preflightAuditionRoots } = require("./roots");

function sortedStrings(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()))].sort(compareText);
}

function auditionResult(plan, { observedProfile, stepStatus, sideEffects, evidenceRefs, verdict, cleanupEvidence }) {
  const result = {
    audition_plan_id: plan.audition_plan_id,
    observed_codex_profile: typeof observedProfile === "string" && observedProfile.trim() ? observedProfile.trim() : "unavailable",
    steps: plan.steps.map((step) => ({ step, status: stepStatus })),
    side_effects: sortedStrings(sideEffects),
    evidence_refs: sortedStrings(evidenceRefs),
    verdict,
    cleanup_evidence: sortedStrings(cleanupEvidence)
  };
  try {
    return assertContract("audition-result", result);
  } catch (error) {
    throw auditionError("AUDITION_RESULT_INVALID", "Audition result does not satisfy the registered durable contract.", { errors: error.errors || [] });
  }
}

function manifestContained(roots, manifest) {
  if (!Array.isArray(manifest)) return false;
  return manifest.every((entry) => {
    if (!entry || typeof entry.path !== "string") return false;
    const target = path.resolve(entry.path);
    return target === roots.workspace_root || strictDescendant(roots.workspace_root, target)
      || target === roots.audition_root || strictDescendant(roots.audition_root, target);
  });
}

function cleanupEvidence(cleanup) {
  const values = [`cleanup:${cleanup.status}`];
  if (cleanup.cleanup && cleanup.cleanup.reason) values.push(`cleanup:${cleanup.cleanup.reason}`);
  for (const target of cleanup.cleanup && cleanup.cleanup.removed || []) values.push(`cleanup:removed:${target}`);
  for (const item of cleanup.cleanup && cleanup.cleanup.rejected || []) values.push(`cleanup:rejected:${item.reason}:${item.path}`);
  for (const target of cleanup.cleanup && cleanup.cleanup.residue || []) values.push(`cleanup:residue:${target}`);
  return sortedStrings(values);
}

async function record(evidenceSink, result) {
  if (!evidenceSink || typeof evidenceSink.record !== "function") throw auditionError("AUDITION_EVIDENCE_SINK_REQUIRED", "Audition requires an evidence sink.");
  await evidenceSink.record(clone(result));
}

async function runAudition({ plan, roots, harness, evidenceSink, fsAdapter } = {}) {
  if (!plan || !harness || typeof harness.inspectProfile !== "function" || typeof harness.run !== "function") {
    throw auditionError("AUDITION_HARNESS_INVALID", "Audition requires injected inspectProfile and run operations.");
  }
  try {
    assertContract("audition-plan", plan);
  } catch (error) {
    throw auditionError("AUDITION_PLAN_INVALID", "Audition requires a registered durable plan.", { errors: error.errors || [] });
  }
  const normalizedRoots = normalizeRoots(plan, roots);
  let actual;
  try {
    actual = await harness.inspectProfile();
  } catch {
    const result = auditionResult(plan, { stepStatus: "skipped", sideEffects: [], evidenceRefs: [], verdict: "inconclusive", cleanupEvidence: ["cleanup:not_required"] });
    await record(evidenceSink, result);
    return result;
  }
  const comparison = compareCodexProfile({
    planned: { profile_id: plan.expected_codex_profile, allowed_roots: [normalizedRoots.workspace_root, normalizedRoots.audition_root], effects: plan.permitted_effects },
    actual
  });
  if (comparison.status !== "compatible") {
    const result = auditionResult(plan, { observedProfile: actual && actual.profile_id, stepStatus: "skipped", sideEffects: [], evidenceRefs: [], verdict: "inconclusive", cleanupEvidence: ["cleanup:not_required"] });
    await record(evidenceSink, result);
    return result;
  }

  let verifiedRoots;
  try {
    verifiedRoots = await preflightAuditionRoots({ plan, roots: normalizedRoots, fsAdapter });
  } catch {
    const result = auditionResult(plan, { observedProfile: actual.profile_id, stepStatus: "skipped", sideEffects: [], evidenceRefs: [], verdict: "inconclusive", cleanupEvidence: ["cleanup:not_required"] });
    await record(evidenceSink, result);
    return result;
  }

  let runtime;
  try {
    runtime = await harness.run(plan);
  } catch {
    const result = auditionResult(plan, { observedProfile: actual.profile_id, stepStatus: "failed", sideEffects: [], evidenceRefs: [], verdict: "failed", cleanupEvidence: ["cleanup:unverified"] });
    await record(evidenceSink, result);
    return result;
  }
  const effects = sortedStrings(runtime && runtime.effects);
  const before = runtime && runtime.before_manifest;
  const after = runtime && runtime.after_manifest;
  const invalidRuntime = !runtime || runtime.status !== "completed"
    || effects.some((effect) => !plan.permitted_effects.includes(effect))
    || !manifestContained(normalizedRoots, before) || !manifestContained(normalizedRoots, after);
  if (invalidRuntime) {
    const result = auditionResult(plan, { observedProfile: actual.profile_id, stepStatus: "failed", sideEffects: effects, evidenceRefs: [], verdict: "failed", cleanupEvidence: ["cleanup:unverified"] });
    await record(evidenceSink, result);
    return result;
  }

  const cleanup = await verifyAuditionCleanup({ plan, roots: normalizedRoots, before, after, fsAdapter, verifiedRoots });
  const passed = cleanup.status === "clean";
  const result = auditionResult(plan, {
    observedProfile: actual.profile_id,
    stepStatus: passed ? "passed" : "failed",
    sideEffects: effects,
    evidenceRefs: runtime.evidence_refs,
    verdict: passed ? "passed" : "failed",
    cleanupEvidence: cleanupEvidence(cleanup)
  });
  await record(evidenceSink, result);
  return result;
}

module.exports = { runAudition };
