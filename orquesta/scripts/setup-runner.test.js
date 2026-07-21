"use strict";

const assert = require("node:assert/strict");
const { mkdir, mkdtemp, readFile, rm } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createSetupEngine } = require("./setup-engine");
const { createSetupRunner, SetupBlockedError } = require("./setup-runner");

const roots = [];
const NOW = "2026-07-22T05:00:00.000Z";

test.afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function repository() {
  const parent = await mkdtemp(path.join(os.tmpdir(), "orquesta-setup-runner-"));
  roots.push(parent);
  const root = path.join(parent, "project");
  await mkdir(root);
  const engine = createSetupEngine({ now: () => NOW, randomUUID: () => "11111111-2222-4333-8444-555555555555" });
  const started = await engine.start({
    rootPath: root,
    draft: {
      revision: 1,
      status: "draft",
      source: { kind: "detected_root", rootPath: root },
      projectName: "Runner Test",
      description: "Run every setup phase.",
      questions: [],
      answers: [],
    },
  });
  return { root, setupId: started.result.setupId };
}

async function state(root) {
  return JSON.parse(await readFile(path.join(root, ".orquesta", "setup", "setup_state.json"), "utf8"));
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for setup runner test condition");
}

function handlers(calls, overrides = {}) {
  const result = {};
  for (const phaseId of ["environment", "understanding", "foundation", "planning", "specialists", "operation"]) {
    result[phaseId] = overrides[phaseId] || (async () => {
      calls.push(phaseId);
      return {
        checkpointRef: `setup/checkpoints/${phaseId}.json`,
        activity: { activity_id: `${phaseId}-done`, title: `${phaseId} done`, detail: `${phaseId} complete`, status: "complete", observed_at: NOW },
      };
    });
  }
  return result;
}

test("runs all six handlers in order and completes only after operation", async () => {
  const { root, setupId } = await repository();
  const calls = [];
  const progress = [];
  const runner = createSetupRunner({ handlers: handlers(calls), now: () => NOW, onProgress: (event) => progress.push(event) });

  const completed = await runner.run({ rootPath: root, setupId });

  assert.deepEqual(calls, ["environment", "understanding", "foundation", "planning", "specialists", "operation"]);
  assert.equal(completed.status, "completed");
  assert.equal(completed.current_phase_id, "operation");
  assert.ok(completed.completed_at);
  assert.equal(progress.at(-1).status, "completed");
});

test("blocks on the failing phase and resumes from that phase", async () => {
  const { root, setupId } = await repository();
  const calls = [];
  let fail = true;
  const phaseHandlers = handlers(calls, {
    understanding: async () => {
      calls.push("understanding");
      if (fail) throw new SetupBlockedError("PROJECT_UNDERSTANDING_FAILED", "Project understanding failed", true);
      return { checkpointRef: "setup/checkpoints/understanding.json", activity: { activity_id: "understanding-done", title: "understanding done", detail: "complete", status: "complete", observed_at: NOW } };
    },
  });
  const runner = createSetupRunner({ handlers: phaseHandlers, now: () => NOW });

  const blocked = await runner.run({ rootPath: root, setupId });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.current_phase_id, "understanding");
  assert.deepEqual(calls, ["environment", "understanding"]);

  fail = false;
  const completed = await runner.resume({ rootPath: root, setupId });
  assert.equal(completed.status, "completed");
  assert.deepEqual(calls, ["environment", "understanding", "understanding", "foundation", "planning", "specialists", "operation"]);
});

test("coalesces concurrent runs for the same project", async () => {
  const { root, setupId } = await repository();
  const calls = [];
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const phaseHandlers = handlers(calls, {
    environment: async () => {
      calls.push("environment");
      await waiting;
      return { checkpointRef: "setup/checkpoints/environment.json", activity: { activity_id: "environment-done", title: "environment done", detail: "complete", status: "complete", observed_at: NOW } };
    },
  });
  const runner = createSetupRunner({ handlers: phaseHandlers, now: () => NOW });

  const first = runner.run({ rootPath: root, setupId });
  const second = runner.run({ rootPath: root, setupId });
  await waitFor(() => calls.length === 1);
  assert.deepEqual(calls, ["environment"]);
  release();
  const [firstState, secondState] = await Promise.all([first, second]);
  assert.equal(firstState.status, "completed");
  assert.deepEqual(secondState, firstState);
  assert.equal(calls.filter((phaseId) => phaseId === "environment").length, 1);
});

test("cancels a resumable setup without marking it completed", async () => {
  const { root, setupId } = await repository();
  const runner = createSetupRunner({ handlers: handlers([]), now: () => NOW });

  const cancelled = await runner.cancel({ rootPath: root, setupId });

  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.completed_at, null);
  assert.equal((await state(root)).status, "cancelled");
});
