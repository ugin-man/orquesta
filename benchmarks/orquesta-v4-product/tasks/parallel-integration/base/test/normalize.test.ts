import assert from "node:assert/strict";
import test from "node:test";
import { normalizeItem } from "../src/normalize.ts";

test("normalizes identifiers, labels, teams, and hours", () => {
  assert.deepEqual(normalizeItem({ id: " wk-7 ", title: "  Ship report  ", team: " DATA ", hours: "4" }), {
    id: "WK-7",
    title: "Ship report",
    team: "data",
    hours: 4
  });
});
