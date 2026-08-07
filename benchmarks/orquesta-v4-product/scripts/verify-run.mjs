import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "./lib/cli.mjs";
import { benchmarkRoot } from "./lib/paths.mjs";
import { loadRun } from "./lib/run-store.mjs";
import { verifyTask } from "./lib/tasks.mjs";

try {
  const args = parseArgs(process.argv.slice(2));
  const run = await loadRun(benchmarkRoot, args.run_id);
  const result = await verifyTask({ benchmarkRoot, taskId: run.task_id, workspaceRoot: run.workspace_root, timeoutMs: run.verifier_timeout_sec * 1000 });
  await fs.writeFile(path.join(run.run_dir, "verifier-preview.txt"), `${result.output || ""}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`Benchmark verify failed: ${error.message}\n`);
  process.exitCode = 1;
}
