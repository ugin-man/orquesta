"use strict";

const { mkdir, readFile, rename, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { summarizeContextVariantComparison } = require("../../packages/context-compiler/src");

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

async function createVariantReport(root, inputFiles, { generatedAt = new Date().toISOString() } = {}) {
  if (!Array.isArray(inputFiles) || inputFiles.length === 0) throw new Error("variant_inputs_missing");
  const rows = [];
  for (const inputFile of inputFiles) {
    const value = JSON.parse(await readFile(path.resolve(inputFile), "utf8"));
    if (Array.isArray(value)) rows.push(...value);
    else if (Array.isArray(value.rows)) rows.push(...value.rows);
    else rows.push(value);
  }
  const summary = {
    ...summarizeContextVariantComparison(rows),
    generated_at: generatedAt,
  };
  const output = path.join(path.resolve(root), ".orquesta", "context", "variant_comparison.json");
  await writeJsonAtomic(output, summary);
  return { output, summary };
}

function values(argv, name) {
  return argv.reduce((result, value, index) => (
    value === name && argv[index + 1] ? [...result, argv[index + 1]] : result
  ), []);
}

function option(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1];
}

async function runCli(argv = process.argv.slice(2), { stdout = process.stdout } = {}) {
  const root = option(argv, "--root");
  if (!root) throw new Error("missing_option:--root");
  const result = await createVariantReport(root, values(argv, "--input"), {
    generatedAt: option(argv, "--generated-at") || undefined,
  });
  stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (require.main === module) {
  runCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { createVariantReport, runCli };
