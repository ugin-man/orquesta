import assert from "node:assert/strict";
import test from "node:test";
import { summarizeTeams } from "../src/summarize.ts";

test("counts items and totals hours for every team", () => {
  assert.deepEqual(summarizeTeams([
    { id: "A", title: "One", team: "data", hours: 3 },
    { id: "B", title: "Two", team: "data", hours: 5 }
  ]), [{ team: "data", itemCount: 2, totalHours: 8 }]);
});
