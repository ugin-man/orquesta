"use strict";

const { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } = require("node:fs");
const path = require("node:path");

const FORBIDDEN_RUNTIME_SYMBOLS = Object.freeze([
  "migrateOrganizationV2ToV3",
  "createSessionRotationRegistry",
  "runSessionRotationHook",
  "session-rotation.json",
  "organization-controller-v3.js",
]);

function loadEsbuild() {
  try {
    return require("esbuild");
  } catch (error) {
    if (error?.code !== "MODULE_NOT_FOUND") throw error;
    return require("../apps/orquesta-desktop-next/node_modules/esbuild");
  }
}

function schemaFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".schema.json"))
    .map((entry) => entry.name)
    .sort();
}

async function main(argv = process.argv.slice(2)) {
  const root = path.resolve(__dirname, "..");
  const outputRoot = process.env.ORQUESTA_SKILL_OUTPUT_ROOT
    ? path.resolve(process.env.ORQUESTA_SKILL_OUTPUT_ROOT)
    : path.join(root, "orquesta");
  const output = path.join(outputRoot, "runtime", "context-v2-runtime.cjs");
  const sourceSchemas = path.join(root, "packages", "contracts", "schemas");
  const outputSchemas = path.join(outputRoot, "schemas");
  const check = argv.includes("--check");
  mkdirSync(path.dirname(output), { recursive: true });
  mkdirSync(outputSchemas, { recursive: true });
  const result = await loadEsbuild().build({
    entryPoints: [path.join(root, "scripts", "context-v2-runtime-entry.js")],
    outfile: output,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    packages: "bundle",
    logLevel: "silent",
    legalComments: "none",
    write: !check,
  });
  const runtimeBytes = check ? result.outputFiles?.[0]?.contents : readFileSync(output);
  const runtimeText = runtimeBytes ? Buffer.from(runtimeBytes).toString("utf8") : "";
  const forbiddenSymbol = FORBIDDEN_RUNTIME_SYMBOLS.find((symbol) => runtimeText.includes(symbol));
  if (forbiddenSymbol) throw new Error(`Bundled runtime contains retired authority: ${forbiddenSymbol}`);
  const approvedSchemas = schemaFiles(sourceSchemas);
  if (check) {
    if (!runtimeBytes || !existsSync(output) || !Buffer.from(runtimeBytes).equals(readFileSync(output))) {
      throw new Error(`Bundled runtime is stale: ${output}`);
    }
    const emittedSchemas = schemaFiles(outputSchemas);
    if (JSON.stringify(emittedSchemas) !== JSON.stringify(approvedSchemas)) {
      throw new Error("Bundled contract schema set is stale");
    }
    for (const name of approvedSchemas) {
      if (!readFileSync(path.join(sourceSchemas, name)).equals(readFileSync(path.join(outputSchemas, name)))) {
        throw new Error(`Bundled contract schema is stale: ${name}`);
      }
    }
  } else {
    const approvedSet = new Set(approvedSchemas);
    for (const name of schemaFiles(outputSchemas)) {
      if (!approvedSet.has(name)) unlinkSync(path.join(outputSchemas, name));
    }
    for (const name of approvedSchemas) {
      copyFileSync(path.join(sourceSchemas, name), path.join(outputSchemas, name));
    }
  }
  process.stdout.write(`${output}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { FORBIDDEN_RUNTIME_SYMBOLS, main };
