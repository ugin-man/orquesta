"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { verifyPhase15 } = require("./verify-phase15");

test("verifies all three lanes and same-task budget enforcement", () => {
  const result = verifyPhase15();

  assert.equal(result.status, "passed");
  assert.deepEqual(result.lanes, ["fast", "standard", "critical"]);
  assert.equal(result.legacy_compatible, true);
  assert.equal(result.auxiliary_task_rejected, true);
  assert.equal(result.token_unknown_preserved, true);
  assert.equal(result.escalation.fast_to_standard, true);
  assert.equal(result.escalation.standard_to_critical, true);
});
