import { benchmarkRoot } from "./lib/paths.mjs";
import { prepareTasks } from "./lib/tasks.mjs";

try {
  const tasks = await prepareTasks({ benchmarkRoot });
  process.stdout.write(`${JSON.stringify({ status: "ready", tasks }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`Benchmark prepare failed: ${error.message}\n`);
  process.exitCode = 1;
}
