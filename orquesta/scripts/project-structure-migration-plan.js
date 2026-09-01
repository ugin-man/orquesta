"use strict";

const { execFileSync } = require("node:child_process");
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

const {
  auditProjectStructure,
  createProjectStructureMigrationPlan,
  renderMigrationPlanReview,
  scanProjectStructure,
} = loadRuntime();

function parseArguments(argv) {
  const result = {
    root: process.cwd(),
    layout: ".orquesta/project/layout.json",
    lifecycle: ".orquesta/project/lifecycle.json",
    candidates: null,
    output: ".orquesta/project/migration-plan.json",
    report: ".orquesta/reports/V4F-PROJECT-STRUCTURE-PHASE5-PLAN.md",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--root") result.root = argv[++index];
    else if (argument === "--layout") result.layout = argv[++index];
    else if (argument === "--lifecycle") result.lifecycle = argv[++index];
    else if (argument === "--candidates") result.candidates = argv[++index];
    else if (argument === "--output") result.output = argv[++index];
    else if (argument === "--report") result.report = argv[++index];
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return result;
}

function resolveInside(root, reference) {
  const absolute = path.resolve(root, reference);
  const relative = path.relative(root, absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new RangeError(`Path escapes project root: ${reference}`);
  }
  return absolute;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
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

function dirtyPathCount(root) {
  try {
    const output = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output.split(/\r?\n/gu).filter(Boolean).filter((line) => (
      !line.endsWith(" .orquesta/project/migration-plan.json")
      && !line.endsWith(" .orquesta/reports/V4F-PROJECT-STRUCTURE-PHASE5-PLAN.md")
    )).length;
  } catch {
    return 0;
  }
}

function generateMigrationPlan({
  rootPath,
  layoutReference = ".orquesta/project/layout.json",
  lifecycleReference = ".orquesta/project/lifecycle.json",
  candidates = [],
  generatedAt = new Date().toISOString(),
} = {}) {
  const root = fs.realpathSync(rootPath);
  const layout = readJson(resolveInside(root, layoutReference));
  const lifecycleRegistry = readJson(resolveInside(root, lifecycleReference));
  const inventory = scanProjectStructure({ workspaceRoot: root, layout, lifecycleRegistry, generatedAt });
  const audit = auditProjectStructure({ inventory, layout, lifecycleRegistry });
  return createProjectStructureMigrationPlan({
    workspaceRoot: root,
    layout,
    lifecycleRegistry,
    inventory,
    audit,
    candidates,
    generatedAt,
    dirtyPathCount: dirtyPathCount(root),
  });
}

function main(argv = process.argv.slice(2)) {
  const input = parseArguments(argv);
  const root = fs.realpathSync(input.root);
  const candidates = input.candidates ? readJson(resolveInside(root, input.candidates)) : [];
  if (!Array.isArray(candidates)) throw new TypeError("Migration candidates file must contain an array");
  const plan = generateMigrationPlan({
    rootPath: root,
    layoutReference: input.layout,
    lifecycleReference: input.lifecycle,
    candidates,
  });
  const outputPath = resolveInside(root, input.output);
  const reportPath = resolveInside(root, input.report);
  writeAtomic(outputPath, `${JSON.stringify(plan, null, 2)}\n`);
  writeAtomic(reportPath, renderMigrationPlanReview(plan));
  const summary = {
    plan_id: plan.plan_id,
    status: plan.status,
    dry_run: plan.dry_run,
    planned_operations: plan.operations.filter((item) => item.status === "planned").length,
    blocked_operations: plan.operations.filter((item) => item.status === "blocked").length,
    reference_rewrite_files: plan.reference_rewrites.length,
    rollback_reversible: plan.rollback.reversible,
    approval_required: plan.approval.required,
    output: path.relative(root, outputPath).replace(/\\/gu, "/"),
    report: path.relative(root, reportPath).replace(/\\/gu, "/"),
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return { plan, summary };
}

if (require.main === module) {
  try { main(); } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = { dirtyPathCount, generateMigrationPlan, main, parseArguments, resolveInside, writeAtomic };
