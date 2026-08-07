"use strict";

const assert = require("node:assert/strict");
const { mkdir, mkdtemp, readFile, readdir, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { initializeProjectStructure } = require("./project-structure-setup");

const roots = [];
const NOW = "2026-08-01T00:00:00.000Z";
test.afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function json(root, reference) {
  return JSON.parse(await readFile(path.join(root, ...reference.split("/")), "utf8"));
}

test("existing projects receive a repeatable shadow structure without moving project files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orquesta-structure-existing-"));
  roots.push(root);
  await mkdir(path.join(root, "src"), { recursive: true });
  await Promise.all([
    writeFile(path.join(root, "README.md"), "# Existing\n", "utf8"),
    writeFile(path.join(root, "package.json"), "{}\n", "utf8"),
    writeFile(path.join(root, "src", "index.js"), "module.exports = {};\n", "utf8"),
  ]);
  const before = await readFile(path.join(root, "src", "index.js"), "utf8");
  const result = await initializeProjectStructure({
    rootPath: root,
    projectId: "existing",
    projectName: "Existing",
    description: "Maintain a software application.",
    sourceKind: "existing_folder",
    setupAnswers: [{ questionId: "SETUP-Q1", answer: "Keep current paths." }],
    generatedAt: NOW,
  });
  assert.equal(result.mode, "existing_shadow");
  assert.deepEqual(result.physical_changes, { created_directories: [], created_files: [], moved_paths: [] });
  assert.equal(await readFile(path.join(root, "src", "index.js"), "utf8"), before);
  const setup = await json(root, ".orquesta/project/structure-setup.json");
  assert.equal(setup.template_version, "project-structure-v1");
  assert.equal(setup.setup_answers[0].answer, "Keep current paths.");
  assert.match((await json(root, ".orquesta/context/initial-context-view.json")).view_id, /^PSCV-/u);

  const second = await initializeProjectStructure({
    rootPath: root,
    projectId: "existing",
    projectName: "Existing",
    description: "Maintain a software application.",
    sourceKind: "existing_folder",
    setupAnswers: setup.setup_answers,
    generatedAt: NOW,
  });
  assert.equal(second.manifest_source, "generated");
  assert.deepEqual(second.physical_changes.moved_paths, []);
});

test("new projects create one entry document and one primary directory instead of a template tree", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "orquesta-structure-new-"));
  roots.push(root);
  const result = await initializeProjectStructure({
    rootPath: root,
    projectId: "new-project",
    projectName: "New Project",
    description: "Build a desktop app.",
    sourceKind: "new_project",
    generatedAt: NOW,
  });
  assert.equal(result.mode, "new_minimal");
  assert.deepEqual(result.physical_changes, {
    created_directories: ["src"],
    created_files: ["README.md"],
    moved_paths: [],
  });
  const rootEntries = (await readdir(root)).filter((entry) => entry !== ".orquesta").sort();
  assert.deepEqual(rootEntries, ["README.md", "src"]);
  assert.match(await readFile(path.join(root, "README.md"), "utf8"), /New Project/u);
});
