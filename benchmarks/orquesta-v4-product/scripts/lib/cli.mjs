import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new Error(`unexpected argument: ${argument}`);
    const key = argument.slice(2).replaceAll("-", "_");
    if (key === "dry_run") result[key] = true;
    else {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`missing value for ${argument}`);
      result[key] = value;
      index += 1;
    }
  }
  return result;
}

export async function loadRuntimeConfig({ benchmarkRoot, configPath }) {
  const source = configPath || path.join(benchmarkRoot, "benchmark.config.example.json");
  const config = JSON.parse(await fs.readFile(source, "utf8"));
  if (!configPath) config.sessions_root = path.join(os.homedir(), ".codex", "sessions");
  return config;
}
