"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  activatePhase,
  blockPhase,
  completePhase,
  completeSetup,
  createSetupState,
  firstIncompletePhase,
} = require("./setup-state");

const NOW = "2026-07-22T05:00:00.000Z";
const LATER = "2026-07-22T05:01:00.000Z";
const draft = {
  revision: 1,
  status: "draft",
  source: { kind: "detected_root", rootPath: "C:\\repo" },
  projectName: "Test Project",
  description: "Test the setup state machine.",
  questions: [],
  answers: [],
};

function activity(id, status) {
  return { activity_id: id, title: id, detail: `${id} detail`, status, observed_at: status === "waiting" ? null : LATER };
}

test("creates one active phase in canonical schema v3", () => {
  const state = createSetupState({ setupId: "SETUP-1", projectId: "repo-1", draft, now: NOW });

  assert.equal(state.schema_version, 3);
  assert.equal(state.current_phase_id, "environment");
  assert.deepEqual(state.phases.map(({ status }) => status), ["active", "waiting", "waiting", "waiting", "waiting", "waiting"]);
  assert.equal(state.phases[0].attempt, 1);
  assert.equal(state.phases[0].started_at, NOW);
  assert.equal(state.completed_at, null);
});

test("completes and activates phases without losing cumulative progress", () => {
  const initial = createSetupState({ setupId: "SETUP-1", projectId: "repo-1", draft, now: NOW });
  const environmentDone = completePhase(initial, "environment", activity("environment done", "complete"), LATER, "setup/checkpoints/environment.json");
  const understanding = activatePhase(environmentDone, "understanding", activity("understanding active", "active"), LATER);

  assert.deepEqual(understanding.phases.map(({ status }) => status), ["complete", "active", "waiting", "waiting", "waiting", "waiting"]);
  assert.equal(understanding.current_phase_id, "understanding");
  assert.equal(understanding.phases[0].checkpoint_ref, "setup/checkpoints/environment.json");
  assert.equal(understanding.phases[1].attempt, 1);
});

test("blocks and resumes the same incomplete phase", () => {
  const initial = createSetupState({ setupId: "SETUP-1", projectId: "repo-1", draft, now: NOW });
  const environmentDone = completePhase(initial, "environment", activity("environment done", "complete"), LATER);
  const understanding = activatePhase(environmentDone, "understanding", activity("understanding active", "active"), LATER);
  const blocked = blockPhase(
    understanding,
    "understanding",
    { code: "README_UNAVAILABLE", message: "README could not be read", retryable: true },
    activity("understanding blocked", "failed"),
    LATER,
  );

  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.phases[1].status, "blocked");
  assert.equal(firstIncompletePhase(blocked), "understanding");

  const resumed = activatePhase(blocked, "understanding", activity("understanding resumed", "active"), LATER);
  assert.equal(resumed.status, "running");
  assert.equal(resumed.phases[1].status, "active");
  assert.equal(resumed.phases[1].attempt, 2);
  assert.equal(resumed.blocking_issue, null);
});

test("only finalizes after every phase is complete", () => {
  let state = createSetupState({ setupId: "SETUP-1", projectId: "repo-1", draft, now: NOW });
  assert.throws(() => completeSetup(state, activity("ready", "complete"), LATER), /all setup phases must be complete/u);

  for (const [index, phase] of state.phases.entries()) {
    if (index > 0) state = activatePhase(state, phase.phase_id, activity(`${phase.phase_id} active`, "active"), LATER);
    state = completePhase(state, phase.phase_id, activity(`${phase.phase_id} done`, "complete"), LATER);
  }
  const completed = completeSetup(state, activity("operation ready", "complete"), LATER);

  assert.equal(completed.status, "completed");
  assert.equal(completed.current_phase_id, "operation");
  assert.equal(completed.completed_at, LATER);
});
