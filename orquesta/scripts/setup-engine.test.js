"use strict";

const assert = require("node:assert/strict");
const { access, mkdir, mkdtemp, readFile, rm } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createSetupEngine } = require("./setup-engine");

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
