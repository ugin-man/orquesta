import { parseArgs } from "./lib/cli.mjs";
import { recordUserIntervention } from "./lib/lifecycle.mjs";
import { benchmarkRoot } from "./lib/paths.mjs";

try {
  const args = parseArgs(process.argv.slice(2));
  const evidence = await recordUserIntervention({ storageRoot: benchmarkRoot, runId: args.run_id, kind: args.kind || "other" });
  process.stdout.write(`User intervention recorded: ${evidence.kind} at ${evidence.at}\n`);
} catch (error) {
  process.stderr.write(`Benchmark intervention failed: ${error.message}\n`);
  process.exitCode = 1;
}
