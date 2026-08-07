"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createProjectors, initialProjection, replayProjection } = require("../src/projectors");

function batch(sequence, type, payload, id = `${type}-${sequence}`) {
  return {
    sequence,
    batch_id: `batch-${sequence}`,
    actor: { type: "agent", id: "fixture" },
    events: [{
      event_id: id,
      schema_version: 1,
      type,
      payload: { ...payload, responsibility: "fixture" },
      evidence_refs: [],
    }],
  };
}

test("initial projection exposes bounded Phase 2 operational collections", () => {
  const state = initialProjection();
  assert.deepEqual(state.acquisition_snapshots, []);
  assert.deepEqual(state.audit_evaluations, []);
  assert.deepEqual(state.audition_results, []);
  assert.deepEqual(state.task_profiles, []);
  const projectors = createProjectors();
  assert.equal(typeof projectors["acquisition.snapshot.recorded"], "function");
  assert.equal(typeof projectors["candidate.audit.recorded"], "function");
  assert.equal(typeof projectors["candidate.audition.recorded"], "function");
});

test("execution plan projection retains the task profile evidence trace", () => {
  const taskProfile = {
    task_intent_id: "TI-123456789abc",
    reason_codes: ["critical_effect:external_write"],
    evidence_refs: ["work_item:effects"],
  };
  const state = replayProjection([batch(1, "execution.plan.created", {
    execution_plan: { execution_plan_id: "EP-123456789abc", task_intent_id: taskProfile.task_intent_id },
    task_profile: taskProfile,
  })]);
  assert.deepEqual(state.task_profiles[0].reason_codes, taskProfile.reason_codes);
  assert.deepEqual(state.task_profiles[0].evidence_refs, taskProfile.evidence_refs);
  assert.equal(state.current_task_profile_id, taskProfile.task_intent_id);
});

test("Phase 2 projectors replace stable identities and retain the newest 128 records", () => {
  const entries = [];
  for (let sequence = 1; sequence <= 130; sequence += 1) {
    entries.push(batch(sequence, "acquisition.snapshot.recorded", {
      acquisition_snapshot: { query_id: `LSQ-${String(sequence).padStart(3, "0")}`, marker: sequence },
    }));
    entries.push(batch(200 + sequence, "candidate.audit.recorded", {
      evaluation: { evaluation_id: `EVAL-${String(sequence).padStart(3, "0")}`, marker: sequence },
    }));
    entries.push(batch(400 + sequence, "candidate.audition.recorded", {
      audition_result: { audition_plan_id: `AP-${String(sequence).padStart(12, "0")}`, marker: sequence },
    }));
  }
  entries.push(batch(700, "acquisition.snapshot.recorded", {
    acquisition_snapshot: { query_id: "LSQ-130", marker: "replacement" },
  }, "acquisition-replacement"));

  const state = replayProjection(entries);
  assert.equal(state.acquisition_snapshots.length, 128);
  assert.equal(state.audit_evaluations.length, 128);
  assert.equal(state.audition_results.length, 128);
  assert.equal(state.acquisition_snapshots.find((item) => item.query_id === "LSQ-130").marker, "replacement");
  assert.equal(state.acquisition_snapshots.at(-1).sequence, 700);
  assert.deepEqual(state.timeline.slice(-4).map((item) => item.type), [
    "acquisition.snapshot.recorded",
    "candidate.audit.recorded",
    "candidate.audition.recorded",
    "acquisition.snapshot.recorded",
  ]);
});
