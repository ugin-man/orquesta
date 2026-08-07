"use strict";

const assert = require("node:assert/strict");
const { access, mkdir, mkdtemp, readFile, rm } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { buildCurrentOrchestra, createSetupEngine } = require("./setup-engine");

const roots = [];
test.afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function input(rootPath) {
  return {
    rootPath,
    draft: {
      revision: 1,
      status: "draft",
      source: { kind: "detected_root", rootPath },
      projectName: "Test Project",
      description: "A bounded setup engine test.",
      questions: [{ questionId: "goal", prompt: "First goal?", required: false }],
      answers: [{ questionId: "goal", answer: "Reach phase one" }]
    }
  };
}

async function missing(filePath) {
  try { await access(filePath); return false; } catch { return true; }
}

test("starts an atomic idempotent six-phase setup before creating foundation agents", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "orquesta-setup-engine-"));
  roots.push(parent);
  const root = path.join(parent, "project");
  await mkdir(root);
  const engine = createSetupEngine({
    now: () => "2026-07-22T05:00:00.000Z",
    randomUUID: () => "11111111-2222-4333-8444-555555555555"
  });

  assert.equal(await missing(path.join(root, ".orquesta")), true);
  const first = await engine.start(input(root));
  assert.equal(first.setup_state.schema_version, 3);
  assert.equal(first.setup_state.current_phase_id, "environment");
  assert.equal(first.setup_state.phases.length, 6);

  const second = await engine.start(input(root));
  assert.equal(second.setup_state.setup_id, first.setup_state.setup_id);
  const persisted = JSON.parse(await readFile(path.join(root, ".orquesta", "setup", "setup_state.json"), "utf8"));
  assert.equal(persisted.setup_id, first.setup_state.setup_id);
  const agents = JSON.parse(await readFile(path.join(root, ".orquesta", "state", "agents.json"), "utf8"));
  assert.deepEqual(agents.agents, []);
  const organization = JSON.parse(await readFile(path.join(root, ".orquesta", "state", "organization.json"), "utf8"));
  assert.equal(organization.revision, 0);
  assert.deepEqual(organization.agents, []);
  const options = JSON.parse(await readFile(path.join(root, ".orquesta", "setup", "options.json"), "utf8"));
  assert.equal(options.setup_status, "in_progress");
  assert.equal(options.bootstrap_status, "in_progress");
  assert.equal(options.desktop_project_root, root);
  assert.equal(options.foundation_session_status, "pending");
  const wizard = JSON.parse(await readFile(path.join(root, ".orquesta", "setup", "wizard.json"), "utf8"));
  assert.equal(wizard.status, "in_progress");
  assert.equal(wizard.current_step, "auto_finalize");
  assert.equal(wizard.gates.setup_autopilot_finalized, false);
  const directives = JSON.parse(await readFile(path.join(root, ".orquesta", "state", "directives.json"), "utf8"));
  assert.deepEqual(directives.directives, []);
  const currentOrchestra = await readFile(path.join(root, ".orquesta", "CURRENT_ORCHESTRA.md"), "utf8");
  assert.match(currentOrchestra, /Setup status: in_progress/u);
  assert.match(currentOrchestra, /Current phase: environment/u);
});

test("starts setup when .orquesta contains only empty directories", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "orquesta-setup-engine-empty-state-"));
  roots.push(parent);
  const root = path.join(parent, "project");
  await mkdir(path.join(root, ".orquesta", "v4"), { recursive: true });
  const engine = createSetupEngine({
    now: () => "2026-07-22T05:00:00.000Z",
    randomUUID: () => "66666666-7777-4888-8999-000000000000"
  });

  const result = await engine.start(input(root));

  assert.equal(result.setup_state.current_phase_id, "environment");
  assert.equal(await missing(path.join(root, ".orquesta", "v4")), true);
  assert.equal(await missing(path.join(root, ".orquesta", "setup", "setup_state.json")), false);
});

test("leaves no partial .orquesta tree when preparation fails", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "orquesta-setup-engine-fail-"));
  roots.push(parent);
  const root = path.join(parent, "project");
  await mkdir(root);
  const engine = createSetupEngine({
    now: () => "2026-07-22T05:00:00.000Z",
    randomUUID: () => "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    beforeCommit: async () => { throw new Error("injected setup failure"); }
  });

  await assert.rejects(engine.start(input(root)), /injected setup failure/u);
  assert.equal(await missing(path.join(root, ".orquesta")), true);
});

test("current orchestra does not claim superseded initial tasks are queued", () => {
  const markdown = buildCurrentOrchestra({
    setupState: { project_title: "Test Project", project_id: "repo-test" },
    now: "2026-07-22T05:00:00.000Z",
    status: "ready",
    tasksState: {
      tasks: [{ task_id: "SETUP-OLD-001", state: "superseded", owner_agent_id: "implementation-001" }],
    },
  });

  assert.doesNotMatch(markdown, /initial queued tasks/u);
  assert.match(markdown, /No initial work is open/u);
});
