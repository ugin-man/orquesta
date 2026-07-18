"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { ACQUISITION_LIMITS, createLiveSourceConnector } = require("../src");

test("acquisition policy fixes the approved request and candidate limits", () => {
  assert.deepEqual(ACQUISITION_LIMITS, {
    max_requests_per_need: 8,
    max_requests_per_connector: 2,
    max_candidates: 3
  });
});

test("live connectors require an injected transport and search function", () => {
  assert.throws(() => createLiveSourceConnector({ id: "official_docs", trustTier: "official" }), /transport/);
  const connector = createLiveSourceConnector({
    id: "official_docs",
    trustTier: "official",
    transport: { request() {} },
    search() { return null; }
  });
  assert.equal(connector.id, "official_docs");
  assert.equal(connector.trustTier, "official");
});
