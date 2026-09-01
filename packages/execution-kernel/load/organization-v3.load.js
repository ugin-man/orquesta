"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { validateOrganizationV3Bundle } = require("../src/organization-v3");
const { createOrganizationV3BoundaryFixture } = require("../test-support/organization-v3-boundary-fixture");

test("the in-memory model remains valid at 1,600 agents across 800 lines", () => {
  const { agents, lines, bundle } = createOrganizationV3BoundaryFixture(800);
  assert.equal(agents.length, 1600);
  assert.equal(lines.length, 800);
  assert.equal(validateOrganizationV3Bundle(bundle).ok, true);
});
