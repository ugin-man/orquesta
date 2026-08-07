import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

test("the complete pipeline produces the exact integrated report", async () => {
  const workspace = process.env.BENCHMARK_WORKSPACE;
  assert.ok(workspace, "BENCHMARK_WORKSPACE is required");
  const moduleUrl = pathToFileURL(path.join(workspace, "src", "pipeline.ts")).href;
  const { buildReport } = await import(moduleUrl);
  const output = buildReport([
    { id: " t-2 ", title: "  Validate JSON ", team: " OPS ", hours: "2" },
    { id: " t-1 ", title: " Parse rows ", team: "Data", hours: 3 },
    { id: " t-3 ", title: " Aggregate ", team: " data ", hours: "5" }
  ]);
  assert.equal(output, `${JSON.stringify({
    items: [
      { id: "T-2", title: "Validate JSON", team: "ops", hours: 2 },
      { id: "T-1", title: "Parse rows", team: "data", hours: 3 },
      { id: "T-3", title: "Aggregate", team: "data", hours: 5 }
    ],
    teams: [
      { team: "data", itemCount: 2, totalHours: 8 },
      { team: "ops", itemCount: 1, totalHours: 2 }
    ]
  }, null, 2)}\n`);
});
