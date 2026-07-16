"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createLiveSourceConnector, searchLiveSources } = require("../src");

const query = {
  need_id: "NEED-coordinator",
  query_terms: ["json", "validation"],
  allowed_connector_ids: ["github", "official_docs", "registry", "ui_catalog"],
  request_budget: { max_requests_per_need: 8, max_requests_per_connector: 2 },
  candidate_limit: 3,
  requested_at: "2026-07-16T00:00:00.000Z"
};

function result(connectorId, candidates) {
  return {
    connector_id: connectorId,
    trust_tier: connectorId === "github" ? "community" : "official",
    fetched_at: "2026-07-16T00:00:00.000Z",
    expires_at: "2026-07-16T01:00:00.000Z",
    status: "success",
    candidates,
    source_evidence: [{ source_ref: `https://example.test/${connectorId}`, source_hash: "a".repeat(64) }],
    cache_status: "miss",
    redaction_status: "redacted"
  };
}

test("coordinator consumes budget before sorted injected connector calls and caps deduped candidates", async () => {
  const calls = [];
  const connector = (id, candidates) => createLiveSourceConnector({
    id,
    trustTier: "official",
    transport: { request() {} },
    search({ budget }) {
      calls.push({ id, budget: { ...budget } });
      return result(id, candidates);
    }
  });
  const connectors = [
    connector("ui_catalog", [{ candidate_id: "z", source_ref: "ui:z", source_hash: "c".repeat(64) }]),
    connector("registry", [{ candidate_id: "a", source_ref: "registry:a", source_hash: "b".repeat(64) }]),
    connector("official_docs", [{ candidate_id: "a", source_ref: "docs:a", source_hash: "b".repeat(64) }]),
    connector("github", [{ candidate_id: "b", source_ref: "github:b", source_hash: "d".repeat(64) }])
  ];

  const output = await searchLiveSources({ query, connectors, cache: null, clock: () => "2026-07-16T00:00:00.000Z" });
  assert.deepEqual(calls.map((entry) => entry.id), ["github", "official_docs", "registry", "ui_catalog"]);
  assert.equal(calls[0].budget.remaining_total, 7);
  assert.equal(output.candidates.length, 3);
  assert.deepEqual(output.candidates.map((candidate) => candidate.candidate_id), ["a", "b", "z"]);
  assert.equal(output.budget.consumed_total, 4);
});

test("coordinator fails closed before calls for an incomplete fixed query budget", async () => {
  const invalid = { ...query, request_budget: { max_requests_per_need: 7, max_requests_per_connector: 2 } };
  let called = false;
  const connector = createLiveSourceConnector({
    id: "official_docs",
    trustTier: "official",
    transport: { request() {} },
    search() { called = true; return result("official_docs", []); }
  });
  await assert.rejects(searchLiveSources({ query: invalid, connectors: [connector], cache: null }), /live-source-query/);
  assert.equal(called, false);
});
