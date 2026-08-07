"use strict";

const { copyFileSync, mkdirSync, readdirSync } = require("node:fs");
const path = require("node:path");

function loadEsbuild() {
  try {
    return require("esbuild");
  } catch (error) {
    if (error?.code !== "MODULE_NOT_FOUND") throw error;
    return require("../apps/orquesta-desktop/node_modules/esbuild");
  }
}

async function main() {
  const root = path.resolve(__dirname, "..");
  const output = path.join(root, "orquesta", "runtime", "context-v2-runtime.cjs");
  const sourceSchemas = path.join(root, "packages", "contracts", "schemas");
  const outputSchemas = path.join(root, "orquesta", "schemas");
  mkdirSync(path.dirname(output), { recursive: true });
  mkdirSync(outputSchemas, { recursive: true });
  await loadEsbuild().build({
    entryPoints: [path.join(root, "scripts", "context-v2-runtime-entry.js")],
    outfile: output,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    packages: "bundle",
    logLevel: "silent",
    legalComments: "none",
  });
  for (const entry of readdirSync(sourceSchemas, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".schema.json")) continue;
    copyFileSync(path.join(sourceSchemas, entry.name), path.join(outputSchemas, entry.name));
  }
  process.stdout.write(`${output}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main };
