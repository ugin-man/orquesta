import fs from "node:fs/promises";
import path from "node:path";

import { parseArgs } from "./lib/cli.mjs";
import { benchmarkRoot } from "./lib/paths.mjs";
import {
  compareMatrix,
  renderMarkdownReport,
  splitMatrixAndLegacy
} from "./lib/report.mjs";

async function resultFiles(root) {
  const result = [];
  let entries = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return result;
    throw error;
  }
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...await resultFiles(target));
    else if (entry.isFile() && entry.name === "result.json") result.push(target);
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runsRoot = args.runs_dir || path.join(benchmarkRoot, "runs");
  const results = await Promise.all(
    (await resultFiles(runsRoot)).map(async (file) => (
      JSON.parse(await fs.readFile(file, "utf8"))
    ))
  );
  const split = splitMatrixAndLegacy(results);
  const byMatrix = new Map();
  for (const result of split.matrix_runs) {
    const current = byMatrix.get(result.matrix_id) || new Map();
    const prior = current.get(result.mode);
    if (!prior || String(result.ended_at || "") > String(prior.ended_at || "")) {
      current.set(result.mode, result);
    }
    byMatrix.set(result.matrix_id, current);
  }
  const comparisons = [];
  for (const modes of byMatrix.values()) {
    if (modes.size !== 3) continue;
    comparisons.push(compareMatrix([...modes.values()]));
  }
  if (comparisons.length === 0) {
    throw new Error("no complete plain/skills/orquesta matrix was found");
  }
  const markdown = renderMarkdownReport(comparisons, split.legacy_pilots);
  if (args.output) {
    const output = path.resolve(args.output);
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, markdown, "utf8");
    process.stdout.write(`Report written: ${output}\n`);
  } else {
    process.stdout.write(markdown);
  }
}

main().catch((error) => {
  process.stderr.write(`Benchmark report failed: ${error.message}\n`);
  process.exitCode = 1;
});
