import { loadRuntimeConfig, parseArgs } from "./lib/cli.mjs";
import { startRun } from "./lib/lifecycle.mjs";
import { benchmarkRoot } from "./lib/paths.mjs";

try {
  const args = parseArgs(process.argv.slice(2));
  const config = await loadRuntimeConfig({ benchmarkRoot, configPath: args.config });
  const run = await startRun({
    benchmarkRoot,
    sessionsRoot: config.sessions_root,
    rateSnapshot: config.rate_snapshot,
    taskId: args.task,
    mode: args.mode,
    v4Ref: args.v4_ref,
    dryRun: Boolean(args.dry_run),
    runId: args.run_id
  });
  process.stdout.write(`Run: ${run.run_id}\nWorkspace: ${run.workspace_root}\nTimeout: ${run.agent_timeout_sec}s\n\nPrompt:\n${run.prompt}\n`);
} catch (error) {
  process.stderr.write(`Benchmark start failed: ${error.message}\n`);
  process.exitCode = 1;
}
