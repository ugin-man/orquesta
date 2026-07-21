"use strict";

const assert = require("node:assert/strict");
const { mkdir, mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createSetupEngine } = require("./setup-engine");
const { createDefaultPhaseHandlers } = require("./setup-phase-handlers");

const roots = [];
const NOW = "2026-07-22T05:00:00.000Z";

test.afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function json(root, relativePath) {
  return JSON.parse(await readFile(path.join(root, ".orquesta", ...relativePath.split("/")), "utf8"));
}

async function repository() {
  const parent = await mkdtemp(path.join(os.tmpdir(), "orquesta-setup-phases-"));
  roots.push(parent);
  const root = path.join(parent, "project");
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "README.md"), "# Demo Desktop\nA React and Electron desktop interface.\n", "utf8");
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "demo-desktop", dependencies: { react: "19.0.0", electron: "43.0.0" } }), "utf8");
  await writeFile(path.join(root, "src", "App.tsx"), "export function App() { return null; }\n", "utf8");
  const engine = createSetupEngine({ now: () => NOW, randomUUID: () => "11111111-2222-4333-8444-555555555555" });
  const started = await engine.start({
    rootPath: root,
    draft: {
      revision: 1,
      status: "draft",
      source: { kind: "detected_root", rootPath: root },
      projectName: "Demo Desktop",
      description: "Build a polished desktop UI with React and Electron.",
      questions: [],
      answers: [],
    },
  });
  return { root, setupState: started.setup_state };
}

test("environment writes a durable complete checkpoint", async () => {
  const { root, setupState } = await repository();
  const handlers = createDefaultPhaseHandlers({ now: () => NOW });

  const result = await handlers.environment({ rootPath: root, setupState });
  const checkpoint = await json(root, "setup/checkpoints/environment.json");

  assert.equal(result.checkpointRef, "setup/checkpoints/environment.json");
  assert.equal(checkpoint.status, "complete");
  assert.equal(checkpoint.setup_id, setupState.setup_id);
  assert.equal(checkpoint.root_path, root);
});

test("understanding inspects bounded project evidence and stack", async () => {
  const { root, setupState } = await repository();
  const handlers = createDefaultPhaseHandlers({ now: () => NOW });

  const result = await handlers.understanding({ rootPath: root, setupState });
  const understanding = await json(root, "project/project_understanding.json");

  assert.equal(result.output.goal, "Build a polished desktop UI with React and Electron.");
  assert.deepEqual(understanding.stack, ["electron", "node", "react", "typescript"]);
  assert.ok(understanding.evidence.some(({ path: evidencePath }) => evidencePath === "README.md"));
  assert.ok(understanding.existing_assets.includes("src/App.tsx"));
});

test("foundation creates exactly the three base agents and is idempotent", async () => {
  const { root, setupState } = await repository();
  const handlers = createDefaultPhaseHandlers({ now: () => NOW });

  await handlers.foundation({ rootPath: root, setupState });
  const firstOrganization = await json(root, "state/organization.json");
  await handlers.foundation({ rootPath: root, setupState });
  const secondOrganization = await json(root, "state/organization.json");
  const agents = await json(root, "state/agents.json");

  assert.deepEqual(agents.agents.map(({ agent_id }) => agent_id).sort(), ["orchestrator", "orquesta-admin", "user-support"]);
  assert.equal(firstOrganization.revision, 1);
  assert.equal(secondOrganization.revision, 1);
});

test("planning creates executable work and an adaptive specialist plan once", async () => {
  const { root, setupState } = await repository();
  const handlers = createDefaultPhaseHandlers({ now: () => NOW });
  await handlers.understanding({ rootPath: root, setupState });
  await handlers.foundation({ rootPath: root, setupState });

  await handlers.planning({ rootPath: root, setupState });
  const firstMap = await json(root, "project/completion_map.json");
  const firstPlan = await json(root, "setup/specialist_plan.json");
  await handlers.planning({ rootPath: root, setupState });
  const secondMap = await json(root, "project/completion_map.json");
  const secondPlan = await json(root, "setup/specialist_plan.json");

  assert.ok(firstMap.tasks.length >= 1);
  assert.ok(firstMap.tasks.every(({ status }) => status === "ready"));
  assert.equal(firstPlan.schema_version, 2);
  assert.ok(firstPlan.selected_specialists.some(({ role_id }) => role_id === "implementation"));
  assert.deepEqual(secondMap, firstMap);
  assert.deepEqual(secondPlan, firstPlan);
});
