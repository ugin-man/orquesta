"use strict";

const path = require("node:path");
const { auditionError, clone, compareText, strictDescendant } = require("./plan");
const { compareCodexProfile } = require("./profile");

function safeError(error) {
  return { code: error && typeof error.code === "string" ? error.code : "AUDITION_RUNTIME_FAILED", message: error instanceof Error ? error.message : "Audition runtime failed." };
}

function manifestContained(plan, manifest) {
  if (!Array.isArray(manifest)) return false;
  return manifest.every((entry) => {
    if (!entry || typeof entry.path !== "string") return false;
    const target = path.resolve(entry.path);
    return target === plan.workspace_root || strictDescendant(plan.workspace_root, target)
      || target === plan.audition_root || strictDescendant(plan.audition_root, target);
  });
}

async function record(evidenceSink, result) {
  if (!evidenceSink || typeof evidenceSink.record !== "function") throw auditionError("AUDITION_EVIDENCE_SINK_REQUIRED", "Audition requires an evidence sink.");
  await evidenceSink.record(clone(result));
}

async function runAudition({ plan, harness, evidenceSink } = {}) {
  if (!plan || !harness || typeof harness.inspectProfile !== "function" || typeof harness.run !== "function") {
    throw auditionError("AUDITION_HARNESS_INVALID", "Audition requires injected inspectProfile and run operations.");
  }
  let actual;
  try {
    actual = await harness.inspectProfile();
  } catch (error) {
    const result = { plan_id: plan.plan_id, status: "blocked", reasons: ["actual_profile_inspection_failed"], observed_profile: null, primary_error: safeError(error), evidence_refs: [] };
    await record(evidenceSink, result);
    return result;
  }
  const comparison = compareCodexProfile({ planned: plan.expected_profile, actual });
  if (comparison.status !== "compatible") {
    const result = { plan_id: plan.plan_id, status: "blocked", reasons: comparison.reasons, observed_profile: comparison.observed_profile, evidence_refs: [] };
    await record(evidenceSink, result);
    return result;
  }

  let runtime;
  try {
    runtime = await harness.run(plan);
  } catch (error) {
    const result = { plan_id: plan.plan_id, status: "failed", observed_profile: comparison.observed_profile, primary_error: safeError(error), evidence_refs: [] };
    await record(evidenceSink, result);
    return result;
  }
  const effects = runtime && Array.isArray(runtime.effects) ? [...runtime.effects].sort(compareText) : [];
  const before = runtime && runtime.before_manifest;
  const after = runtime && runtime.after_manifest;
  const invalidRuntime = !runtime || runtime.status !== "completed"
    || effects.some((effect) => !plan.permitted_effects.includes(effect))
    || !manifestContained(plan, before) || !manifestContained(plan, after);
  const result = invalidRuntime ? {
    plan_id: plan.plan_id,
    status: "failed",
    observed_profile: comparison.observed_profile,
    primary_error: { code: "AUDITION_RUNTIME_EVIDENCE_INVALID", message: "Runtime evidence exceeded or did not prove the Audition plan." },
    evidence_refs: []
  } : {
    plan_id: plan.plan_id,
    status: "completed",
    observed_profile: comparison.observed_profile,
    before_manifest: clone(before),
    after_manifest: clone(after),
    effects,
    evidence_refs: Array.isArray(runtime.evidence_refs) ? runtime.evidence_refs.filter((item) => typeof item === "string").sort(compareText) : []
  };
  await record(evidenceSink, result);
  return result;
}

module.exports = { runAudition };
