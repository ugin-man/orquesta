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
  const normalizedCandidates = candidates.map((candidate) => ({
    ...candidate,
    version: null,
    revision: null,
    trust_tier: connectorId === "github" ? "community" : "official",
    freshness: "fresh",
  }));
  return {
    connector_id: connectorId,
    trust_tier: connectorId === "github" ? "community" : "official",
    fetched_at: "2026-07-16T00:00:00.000Z",
    expires_at: "2026-07-16T01:00:00.000Z",
    status: "success",
    candidates: normalizedCandidates,
    source_evidence: normalizedCandidates.map((candidate) => ({
      source_id: `source:${connectorId}:${candidate.candidate_id}`,
      candidate_id: candidate.candidate_id,
      source_ref: candidate.source_ref,
      source_hash: candidate.source_hash,
      freshness: "fresh",
      authoritative_fields: ["freshness", "trust"],
      facts: { freshness: "fresh", trust: candidate.trust_tier },
      unknowns: ["accessibility", "compatibility", "cost", "license", "maintenance", "security"],
    })),
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
  assert.equal(calls[0].budget.remaining_total, 8);
  assert.equal(output.candidates.length, 3);
  assert.deepEqual(output.candidates.map((candidate) => candidate.candidate_id), ["a", "b", "z"]);
  assert.equal(output.budget.consumed_total, 0);
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

test("shared transport budget consumes before every connector request and never exceeds the fixed 8/2 limits", async () => {
  const requests = [];
  const connector = (id) => createLiveSourceConnector({
    id,
    trustTier: "official",
    transport: {
      async request() {
        requests.push(id);
        return { status: 200, headers: {}, body: "{}" };
      },
    },
    async search({ transport }) {
      await transport.request({ method: "GET", url: `https://example.test/${id}/1` });
      await transport.request({ method: "GET", url: `https://example.test/${id}/2` });
      await transport.request({ method: "GET", url: `https://example.test/${id}/3` });
      return result(id, []);
    },
  });

  await searchLiveSources({
    query,
    connectors: [connector("ui_catalog"), connector("registry"), connector("official_docs"), connector("github")],
    cache: null,
  });

  assert.equal(requests.length, 8);
  assert.deepEqual(Object.fromEntries([...new Set(requests)].map((id) => [id, requests.filter((value) => value === id).length])), {
    github: 2,
    official_docs: 2,
    registry: 2,
    ui_catalog: 2,
  });
});

test("coordinator cache identity binds sorted credential-free connector configuration", async () => {
  const identities = [];
  const cache = {
    read({ sourceIdentity }) {
      identities.push(sourceIdentity);
      return { status: "miss" };
    },
    write() {},
  };
  const connector = (sourceUri, trustPolicy) => createLiveSourceConnector({
    id: "official_docs",
    trustTier: "official",
    transport: { request() {} },
    cacheConfig: {
      source_uri: sourceUri,
      trust_policy: trustPolicy,
      parser_version: "json-v1",
      authorization: "must-never-join-cache-identity",
    },
    search() { return result("official_docs", []); },
  });

  await searchLiveSources({ query, connectors: [connector("https://docs.example.test/a", "official")], cache, clock: () => "2026-07-16T00:00:00.000Z" });
  await searchLiveSources({ query, connectors: [connector("https://docs.example.test/b", "curated")], cache, clock: () => "2026-07-16T00:00:00.000Z" });

  assert.notEqual(identities[0], identities[1]);
  assert.equal(identities.every((identity) => !identity.includes("must-never-join-cache-identity")), true);
});
