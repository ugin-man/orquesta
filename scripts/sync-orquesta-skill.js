"use strict";

const {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} = require("node:fs");
const path = require("node:path");

function canonical(value) {
  return path.resolve(value);
}

function sourceFiles(root, relative = "") {
  const directory = path.join(root, relative);
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(root, child));
    else if (entry.isFile()) files.push(child);
    else throw new Error(`Unsupported skill entry: ${child}`);
  }
  return files;
}

function assertDistinct(source, target) {
  if (canonical(source).toLowerCase() === canonical(target).toLowerCase()) {
    throw new Error("Source and target skill directories must differ");
  }
}

function compareSourceToTarget({ source, target }) {
  const sourceRoot = canonical(source);
  const targetRoot = canonical(target);
  assertDistinct(sourceRoot, targetRoot);
  const differences = [];
  for (const relativePath of sourceFiles(sourceRoot)) {
    const sourcePath = path.join(sourceRoot, relativePath);
    const targetPath = path.join(targetRoot, relativePath);
    let targetStat;
    try {
      targetStat = statSync(targetPath);
    } catch (error) {
      if (error && error.code === "ENOENT") {
        differences.push({ kind: "missing", path: relativePath });
        continue;
      }
      throw error;
    }
    if (!targetStat.isFile() || !readFileSync(sourcePath).equals(readFileSync(targetPath))) {
      differences.push({ kind: "content_mismatch", path: relativePath });
    }
  }
  return differences;
}

function syncSkillTree({ source, target }) {
  const sourceRoot = canonical(source);
  const targetRoot = canonical(target);
  assertDistinct(sourceRoot, targetRoot);
  const files = sourceFiles(sourceRoot);
  for (const relativePath of files) {
    const sourcePath = path.join(sourceRoot, relativePath);
    const targetPath = path.join(targetRoot, relativePath);
    mkdirSync(path.dirname(targetPath), { recursive: true });
    copyFileSync(sourcePath, targetPath);
  }
  return {
    source: sourceRoot,
    target: targetRoot,
    copiedFiles: files.length,
    remainingDifferences: compareSourceToTarget({ source: sourceRoot, target: targetRoot }),
  };
}

function parseArguments(argv) {
  const result = {
    source: path.resolve(__dirname, "..", "orquesta"),
    targets: [],
    check: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--source") result.source = argv[++index];
    else if (argument === "--target") result.targets.push(argv[++index]);
    else if (argument === "--check") result.check = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (result.targets.length === 0) throw new Error("At least one explicit --target is required");
  return result;
}

function main() {
  const input = parseArguments(process.argv.slice(2));
  const results = input.targets.map((target) => (
    input.check
      ? { target: canonical(target), differences: compareSourceToTarget({ source: input.source, target }) }
      : syncSkillTree({ source: input.source, target })
  ));
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  if (input.check && results.some((result) => result.differences.length > 0)) process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  compareSourceToTarget,
  parseArguments,
  syncSkillTree,
};
