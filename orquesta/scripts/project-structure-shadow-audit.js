"use strict";

const fs = require("node:fs");
const path = require("node:path");
function loadRuntime() {
  try {
    return require("../../packages/project-structure");
  } catch (error) {
    if (error?.code !== "MODULE_NOT_FOUND") throw error;
    return require("../runtime/context-v2-runtime.cjs");
  }
}

const {
  auditProjectStructure,
  createLifecycleProjection,
  renderShadowAuditReport,
  scanProjectStructure,
} = loadRuntime();

function parseArguments(argv) {
  const result = {
    root: process.cwd(),
    layout: ".orquesta/project/layout.json",
    lifecycle: ".orquesta/project/lifecycle.json",
    outputDir: ".orquesta/project/derived",
    report: ".orquesta/reports/V4F-PROJECT-STRUCTURE-PHASE1.md",
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--root") result.root = argv[++index];
    else if (argument === "--layout") result.layout = argv[++index];
    else if (argument === "--lifecycle") result.lifecycle = argv[++index];
    else if (argument === "--output-dir") result.outputDir = argv[++index];
    else if (argument === "--report") result.report = argv[++index];
    else if (argument === "--dry-run") result.dryRun = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return result;
}

function resolveInside(root, reference) {
  const absolute = path.resolve(root, reference);
  const relative = path.relative(root, absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new RangeError(`Output escapes project root: ${reference}`);
  }
  return absolute;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temporary, content, "utf8");
    fs.renameSync(temporary, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch (cleanupError) {
      if (cleanupError.code !== "ENOENT") error.cleanupError = cleanupError;
    }
    throw error;
  }
}

function main(argv = process.argv.slice(2)) {
  const input = parseArguments(argv);
  const root = fs.realpathSync(input.root);
  const layoutPath = resolveInside(root, input.layout);
  const lifecyclePath = resolveInside(root, input.lifecycle);
  const outputDir = resolveInside(root, input.outputDir);
  const reportPath = resolveInside(root, input.report);
  const layout = readJson(layoutPath);
  const lifecycleRegistry = readJson(lifecyclePath);
  const generatedAt = new Date().toISOString();
  const inventory = scanProjectStructure({ workspaceRoot: root, layout, lifecycleRegistry, generatedAt });
  const projection = createLifecycleProjection(inventory);
  const audit = auditProjectStructure({ inventory, layout, lifecycleRegistry });
  const report = renderShadowAuditReport({
    inventory,
    audit,
    projection,
    layoutPath: path.relative(root, layoutPath).replace(/\\/gu, "/"),
    lifecyclePath: path.relative(root, lifecyclePath).replace(/\\/gu, "/"),
  });
  if (!input.dryRun) {
    writeAtomic(path.join(outputDir, "structure-inventory.json"), `${JSON.stringify(inventory, null, 2)}\n`);
    writeAtomic(path.join(outputDir, "lifecycle-projection.json"), `${JSON.stringify(projection, null, 2)}\n`);
    writeAtomic(path.join(outputDir, "structure-audit.json"), `${JSON.stringify(audit, null, 2)}\n`);
    writeAtomic(reportPath, report);
  }
  const summary = {
    mode: "shadow",
    dry_run: input.dryRun,
    blocked: audit.blocked,
    indexed_files: inventory.stats.indexed_files,
    selected_files: projection.stats.selected_files,
    excluded_files: projection.stats.excluded_files,
    issues: audit.summary,
    output_dir: input.dryRun ? null : path.relative(root, outputDir).replace(/\\/gu, "/"),
    report: input.dryRun ? null : path.relative(root, reportPath).replace(/\\/gu, "/"),
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = { main, parseArguments, resolveInside, writeAtomic };
