"use strict";

const { access, mkdir, readFile, rename, writeFile } = require("node:fs/promises");
const path = require("node:path");

function loadRuntime() {
  try {
    return require("../../packages/project-structure/src");
  } catch (error) {
    if (error?.code !== "MODULE_NOT_FOUND") throw error;
    return require("../runtime/context-v2-runtime.cjs");
  }
}

const {
  auditProjectStructure,
  createInitialStructureContextView,
  createLifecycleProjection,
  createPreservedProjectStructureSetup,
  createProjectStructureSetupPlan,
  inferProjectArchetype,
  inspectProjectStructureEvidence,
  scanProjectStructure,
} = loadRuntime();

async function exists(filePath) {
  try { await access(filePath); return true; } catch { return false; }
}

async function readJson(filePath, fallback = null) {
  try { return JSON.parse(await readFile(filePath, "utf8")); } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

async function applyMinimalPhysicalChanges(rootPath, plan) {
  if (plan.setup.mode !== "new_minimal") return { created_directories: [], created_files: [], moved_paths: [] };
  const createdDirectories = [];
  for (const reference of plan.setup.physical_changes.created_directories) {
    const target = path.join(rootPath, ...reference.split("/"));
    if (!(await exists(target))) {
      await mkdir(target, { recursive: true });
      createdDirectories.push(reference);
    }
  }
  const createdFiles = [];
  if (plan.entry) {
    const target = path.join(rootPath, ...plan.entry.source_ref.split("/"));
    if (!(await exists(target))) {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, plan.entry.content, { encoding: "utf8", flag: "wx" });
      createdFiles.push(plan.entry.source_ref);
    }
  }
  return { created_directories: createdDirectories, created_files: createdFiles, moved_paths: [] };
}

async function initializeProjectStructure({
  rootPath,
  projectId,
  projectName,
  description = "",
  sourceKind = "detected_root",
  setupAnswers = [],
  generatedAt = new Date().toISOString(),
} = {}) {
  const workspaceRoot = path.resolve(rootPath);
  const projectRoot = path.join(workspaceRoot, ".orquesta", "project");
  const layoutPath = path.join(projectRoot, "layout.json");
  const lifecyclePath = path.join(projectRoot, "lifecycle.json");
  const setupPath = path.join(projectRoot, "structure-setup.json");
  const evidence = inspectProjectStructureEvidence({ workspaceRoot });
  const archetypeResult = inferProjectArchetype({ evidence, description });
  const [existingLayout, existingLifecycle, previousSetup] = await Promise.all([
    readJson(layoutPath),
    readJson(lifecyclePath),
    readJson(setupPath),
  ]);
  if (Boolean(existingLayout) !== Boolean(existingLifecycle)) throw new Error("project_structure_manifest_pair_incomplete");

  let layout;
  let lifecycle;
  let setup;
  let physicalChanges;
  if (existingLayout && existingLifecycle) {
    layout = existingLayout;
    lifecycle = existingLifecycle;
    setup = createPreservedProjectStructureSetup({
      projectId,
      sourceKind,
      archetypeResult: { ...archetypeResult, archetype: existingLayout.project_kind },
      setupAnswers,
      previousSetup,
      generatedAt,
    });
    physicalChanges = setup.physical_changes;
  } else {
    const plan = createProjectStructureSetupPlan({
      projectId,
      projectName,
      description,
      sourceKind,
      setupAnswers,
      evidence,
      generatedAt,
    });
    layout = plan.layout;
    lifecycle = plan.lifecycle;
    physicalChanges = await applyMinimalPhysicalChanges(workspaceRoot, plan);
    setup = {
      ...plan.setup,
      physical_changes: physicalChanges,
    };
  }

  await Promise.all([
    existingLayout ? Promise.resolve() : writeJsonAtomic(layoutPath, layout),
    existingLifecycle ? Promise.resolve() : writeJsonAtomic(lifecyclePath, lifecycle),
    writeJsonAtomic(setupPath, setup),
  ]);
  const inventory = scanProjectStructure({ workspaceRoot, layout, lifecycleRegistry: lifecycle, generatedAt });
  const projection = createLifecycleProjection(inventory);
  const audit = auditProjectStructure({ inventory, layout, lifecycleRegistry: lifecycle });
  const contextView = createInitialStructureContextView({
    layout,
    setup,
    inventory,
    projection,
    audit,
    goal: description,
    generatedAt,
  });
  await Promise.all([
    writeJsonAtomic(path.join(projectRoot, "derived", "structure-inventory.json"), inventory),
    writeJsonAtomic(path.join(projectRoot, "derived", "lifecycle-projection.json"), projection),
    writeJsonAtomic(path.join(projectRoot, "derived", "structure-audit.json"), audit),
    writeJsonAtomic(path.join(workspaceRoot, ".orquesta", "context", "initial-context-view.json"), contextView),
  ]);
  return {
    mode: setup.mode,
    archetype: setup.archetype,
    template_version: setup.template_version,
    manifest_source: setup.manifests.manifest_source,
    physical_changes: physicalChanges,
    context_view_id: contextView.view_id,
    layout,
    lifecycle,
    setup,
    context_view: contextView,
    audit,
  };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--root") { options.rootPath = value; index += 1; }
    else if (argument === "--project-id") { options.projectId = value; index += 1; }
    else if (argument === "--project-name") { options.projectName = value; index += 1; }
    else if (argument === "--description") { options.description = value; index += 1; }
    else if (argument === "--source-kind") { options.sourceKind = value; index += 1; }
    else if (argument === "--generated-at") { options.generatedAt = value; index += 1; }
    else throw new Error(`unknown_option:${argument}`);
  }
  if (!options.rootPath) throw new Error("missing_option:root");
  return options;
}

async function runCli(argv = process.argv.slice(2), { stdout = process.stdout } = {}) {
  const input = parseArguments(argv);
  const rootPath = path.resolve(input.rootPath);
  const setupState = await readJson(path.join(rootPath, ".orquesta", "setup", "setup_state.json"), {});
  const intake = await readJson(path.join(rootPath, ".orquesta", "setup", "project_intake.json"), {});
  const result = await initializeProjectStructure({
    rootPath,
    projectId: input.projectId || setupState.project_id || `project-${path.basename(rootPath).toLowerCase().replace(/[^a-z0-9]+/gu, "-")}`,
    projectName: input.projectName || setupState.project_title || intake.project_title || path.basename(rootPath),
    description: input.description ?? intake.project_description ?? setupState.input_snapshot?.description ?? "",
    sourceKind: input.sourceKind || setupState.input_snapshot?.source?.kind || "existing_folder",
    setupAnswers: intake.answers || setupState.input_snapshot?.answers || [],
    generatedAt: input.generatedAt,
  });
  stdout.write(`${JSON.stringify({
    mode: result.mode,
    archetype: result.archetype,
    template_version: result.template_version,
    manifest_source: result.manifest_source,
    physical_changes: result.physical_changes,
    context_view_id: result.context_view_id,
    audit_status: result.audit.blocked ? "blocked" : "ready",
  }, null, 2)}\n`);
  return result;
}

if (require.main === module) {
  runCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { initializeProjectStructure, parseArguments, runCli };
