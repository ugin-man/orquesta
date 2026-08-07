import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parseArgs } from "./lib/cli.mjs";
import {
  createDefaultAppServerAdapter,
  runAppServerTask
} from "./lib/app-server-runner.mjs";
import { prepareRuntimeProfile } from "./lib/runtime-profiles.mjs";

export async function executeRun({
  mode,
  workspaceRoot,
  prompt,
  currentCodexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
  tempRoot = path.join(os.tmpdir(), "orquesta-benchmark-runtime"),
  adapterFactory = createDefaultAppServerAdapter
}) {
  const profile = await prepareRuntimeProfile({
    mode,
    currentCodexHome,
    tempRoot: path.join(tempRoot, mode)
  });
  const adapter = adapterFactory({ profile });
  return runAppServerTask({
    adapter,
    profile,
    workspaceRoot,
    prompt
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.mode || !args.workspace || !args.prompt_file) {
    throw new Error("--mode, --workspace, and --prompt-file are required");
  }
  const result = await executeRun({
    mode: args.mode,
    workspaceRoot: path.resolve(args.workspace),
    prompt: await fs.readFile(path.resolve(args.prompt_file), "utf8")
  });
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (args.output) {
    const output = path.resolve(args.output);
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, serialized, "utf8");
  } else {
    process.stdout.write(serialized);
  }
  if (result.status !== "completed") process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
