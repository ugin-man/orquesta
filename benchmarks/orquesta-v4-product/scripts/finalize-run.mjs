import { loadRuntimeConfig, parseArgs } from "./lib/cli.mjs";
import { finalizeRun } from "./lib/lifecycle.mjs";
import { benchmarkRoot } from "./lib/paths.mjs";

try {
  const args = parseArgs(process.argv.slice(2));
  const config = await loadRuntimeConfig({ benchmarkRoot, configPath: args.config });
  const result = await finalizeRun({ benchmarkRoot, sessionsRoot: config.sessions_root, runId: args.run_id });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`Benchmark finalize failed: ${error.message}\n`);
  process.exitCode = 1;
}
