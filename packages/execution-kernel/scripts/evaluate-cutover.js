"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { evaluateExecutionKernelCutover } = require("../src");

function parseArgs(argv) {
  const result = { input: null, output: null, requirePass: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--input") result.input = argv[++index] ?? null;
    else if (value === "--output") result.output = argv[++index] ?? null;
    else if (value === "--require-pass") result.requirePass = true;
    else throw new Error(`unknown argument: ${value}`);
  }
  if (!result.input) throw new Error("--input is required");
  return result;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(args.input);
  const evidence = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const result = evaluateExecutionKernelCutover(evidence);
  const output = `${JSON.stringify(result, null, 2)}\n`;
  if (args.output) {
    const outputPath = path.resolve(args.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, output, "utf8");
    process.stdout.write(`${outputPath}\n`);
  } else {
    process.stdout.write(output);
  }
  if (args.requirePass && !result.cutover_allowed) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  process.stderr.write(`Cutover evaluation failed: ${error.message}\n`);
  process.exitCode = 1;
}
