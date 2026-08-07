"use strict";

const fs = require("node:fs");
const path = require("node:path");

function loadRuntime() {
  try {
    return require("../../packages/project-structure/src");
  } catch (error) {
    if (error?.code !== "MODULE_NOT_FOUND") throw error;
    return require("../runtime/context-v2-runtime.cjs");
  }
}

const { createProjectStructureSetupPlan, inspectProjectStructureEvidence } = loadRuntime();

function parseArguments(argv) {
  const result = {
    outputRoot: process.cwd(),
    output: ".orquesta/project/migrations/external-proposals.json",
    report: ".orquesta/reports/V4F-PROJECT-STRUCTURE-EXTERNAL-PROPOSALS.md",
    projects: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--output-root") result.outputRoot = argv[++index];
    else if (argument === "--output") result.output = argv[++index];
    else if (argument === "--report") result.report = argv[++index];
    else if (argument === "--project") result.projects.push({ name: argv[++index], root: argv[++index] });
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (result.projects.length === 0) throw new Error("At least one --project <name> <root> is required");
  return result;
}

function resolveInside(root, reference) {
  const absolute = path.resolve(root, reference);
  const relative = path.relative(root, absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new RangeError(`Output escapes output root: ${reference}`);
  }
  return absolute;
}

function writeAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, "utf8");
    fs.renameSync(temporary, filePath);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch (cleanupError) {
      if (cleanupError?.code !== "ENOENT") error.cleanupError = cleanupError;
    }
    throw error;
  }
}

function slug(value) {
  const normalized = String(value || "project").normalize("NFKD").toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
  return normalized || `project-${Buffer.from(String(value || "project"), "utf8").toString("hex").slice(0, 12)}`;
}

function topLevelEvidence(root) {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const legacyPattern = /(?:^|[-_. ])(?:v\d+|old|legacy|backup|archive|dust|deprecated)(?:$|[-_. ])/iu;
  const generatedNames = new Set(["node_modules", "dist", "out", "output", "outputs", "coverage", ".cache", "tmp", "temp"]);
  return {
    root_file_count: files.length,
    root_directory_count: directories.length,
    numbered_root_files: files.filter((name) => /^\d{1,4}[-_. ]/u.test(name)).slice(0, 30),
    legacy_named_entries: [...files, ...directories].filter((name) => legacyPattern.test(name)).slice(0, 30),
    generated_named_directories: directories.filter((name) => generatedNames.has(name.toLowerCase())).slice(0, 30),
  };
}

function readProjectDescription(root, top) {
  const intakePath = path.join(root, ".orquesta", "setup", "project_intake.json");
  if (fs.existsSync(intakePath)) {
    try {
      const intake = JSON.parse(fs.readFileSync(intakePath, "utf8"));
      if (typeof intake.project_description === "string" && intake.project_description.trim()) return intake.project_description.trim();
    } catch {
      // Invalid legacy intake is evidence for later review, not a reason to stop a read-only proposal.
    }
  }
  for (const name of ["README.md", "README.en.md"]) {
    const readmePath = path.join(root, name);
    if (!fs.existsSync(readmePath)) continue;
    const content = fs.readFileSync(readmePath, "utf8").slice(0, 4000).trim();
    if (content) return content;
  }
  return `Root directories: ${fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name.replace(/[_-]+/gu, " "))
    .join(", ")}. Root files: ${top.root_file_count}.`;
}

function buildProposal({ name, root, generatedAt }) {
  const realRoot = fs.realpathSync(root);
  const evidence = inspectProjectStructureEvidence({ workspaceRoot: realRoot });
  const top = topLevelEvidence(realRoot);
  const description = readProjectDescription(realRoot, top);
  const setup = createProjectStructureSetupPlan({
    projectId: slug(name),
    projectName: name,
    sourceKind: "existing_folder",
    description,
    evidence,
    generatedAt,
  });
  const warnings = [];
  if (top.root_file_count >= 40) warnings.push("root_file_volume");
  if (top.numbered_root_files.length > 0) warnings.push("numbered_root_documents");
  if (top.legacy_named_entries.length > 0) warnings.push("legacy_named_entries");
  if (top.generated_named_directories.length > 0) warnings.push("generated_root_present");
  return {
    project_id: setup.setup.project_id,
    project_name: name,
    project_root: realRoot,
    status: "shadow_review_proposed",
    archetype: setup.setup.archetype,
    archetype_candidates: setup.setup.archetype_candidates,
    evidence_bounded: evidence.bounded,
    top_level: top,
    proposed_components: setup.layout.components.map((component) => ({
      component_id: component.component_id,
      roots: component.roots,
      kind: component.kind,
    })),
    warnings,
    migration_sequence: [
      "adopt_shadow_manifests_without_moving_files",
      "review_root_and_legacy_classification",
      "generate_hash_bound_migration_plan",
      "approve_entire_plan",
      "apply_and_verify_or_rollback",
    ],
    physical_changes: [],
  };
}

function renderReport(document) {
  const lines = [
    "# External project migration proposals",
    "",
    "These are shadow-first proposals. No target project was modified.",
    "",
  ];
  for (const proposal of document.projects) {
    lines.push(
      `## ${proposal.project_name}`,
      "",
      `- Archetype: \`${proposal.archetype}\``,
      `- Root files: ${proposal.top_level.root_file_count}`,
      `- Root directories: ${proposal.top_level.root_directory_count}`,
      `- Warnings: ${proposal.warnings.length ? proposal.warnings.join(", ") : "none"}`,
      `- Proposed component roots: ${proposal.proposed_components.map((item) => item.roots.join(" + ")).join(", ")}`,
      "- First action: shadow manifests only; no move or deletion.",
      "",
    );
  }
  return `${lines.join("\n")}\n`;
}

function main(argv = process.argv.slice(2)) {
  const input = parseArguments(argv);
  const outputRoot = fs.realpathSync(input.outputRoot);
  const generatedAt = new Date().toISOString();
  const projects = input.projects.map((project) => buildProposal({ ...project, generatedAt }));
  const document = { version: 1, status: "review_required", physical_changes_applied: false, projects, generated_at: generatedAt };
  const outputPath = resolveInside(outputRoot, input.output);
  const reportPath = resolveInside(outputRoot, input.report);
  writeAtomic(outputPath, `${JSON.stringify(document, null, 2)}\n`);
  writeAtomic(reportPath, renderReport(document));
  const summary = {
    projects: projects.map((project) => ({
      project_name: project.project_name,
      archetype: project.archetype,
      root_files: project.top_level.root_file_count,
      warnings: project.warnings,
    })),
    physical_changes_applied: false,
    output: path.relative(outputRoot, outputPath).replace(/\\/gu, "/"),
    report: path.relative(outputRoot, reportPath).replace(/\\/gu, "/"),
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return { document, summary };
}

if (require.main === module) {
  try { main(); } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = { buildProposal, main, parseArguments, readProjectDescription, resolveInside, slug, topLevelEvidence };
