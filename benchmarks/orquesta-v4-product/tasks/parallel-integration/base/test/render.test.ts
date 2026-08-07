import assert from "node:assert/strict";
import test from "node:test";
import { renderReport } from "../src/render.ts";

test("renders team summaries in stable order with a final newline", () => {
  const output = renderReport([], [
    { team: "ops", itemCount: 1, totalHours: 2 },
    { team: "data", itemCount: 1, totalHours: 3 }
  ]);
  assert.equal(output, `${JSON.stringify({ items: [], teams: [
    { team: "data", itemCount: 1, totalHours: 3 },
    { team: "ops", itemCount: 1, totalHours: 2 }
  ] }, null, 2)}\n`);
});
