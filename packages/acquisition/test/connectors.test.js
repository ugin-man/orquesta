"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  createOfficialDocsConnector,
  createRegistryConnector,
  createGitHubConnector,
  createUiCatalogConnector
} = require("../src");

const fixturesRoot = path.resolve(__dirname, "../../../fixtures/v4/phase2/transports");
const query = {
  need_id: "NEED-connectors",
  query_terms: ["codex"],
  allowed_connector_ids: ["github", "official_docs", "registry", "ui_catalog"],
  request_budget: { max_requests_per_need: 8, max_requests_per_connector: 2 },
  candidate_limit: 3,
  requested_at: "2026-07-16T00:00:00.000Z"
};

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(fixturesRoot, `${name}.json`), "utf8"));
}

function transport(response) {
  const calls = [];
  return {
    calls,
    request(request) {
      calls.push(request);
      return response;
    }
  };
}

const factories = [
  ["official_docs", createOfficialDocsConnector, "official-docs", { baseUrl: "https://platform.openai.com/docs" }],
  ["registry", createRegistryConnector, "registry", { baseUrl: "https://registry.npmjs.org" }],
  ["github", createGitHubConnector, "github", { baseUrl: "https://api.github.com", configuredOwners: ["openai"] }],
  ["ui_catalog", createUiCatalogConnector, "ui-catalog", { baseUrl: "https://catalog.example.test" }]
];

test("four connectors parse injected allowlisted fixtures into bounded source evidence", async () => {
  for (const [id, factory, fixtureName, options] of factories) {
    const injected = transport(fixture(fixtureName));
    const connector = factory({ ...options, transport: injected, clock: () => "2026-07-16T00:00:00.000Z" });
    const result = await connector.search({ query, budget: { remaining_total: 7, remaining_connector: 1 } });
    assert.equal(result.connector_id, id);
    assert.equal(result.status, "success");
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].source_hash.length, 64);
    assert.equal(result.source_evidence.every((entry) => entry.source_hash.length === 64), true);
    assert.equal(injected.calls.length, 1);
  }
});

test("connectors keep source order stable, dedupe records, and retain missing license as unknown evidence", async () => {
  const response = fixture("ui-catalog");
  response.body = "{\"items\":[{\"id\":\"z\",\"source_uri\":\"https://catalog.example.test/z\"},{\"id\":\"a\",\"source_uri\":\"https://catalog.example.test/a\"},{\"id\":\"a\",\"source_uri\":\"https://catalog.example.test/a\"}]}";
  const connector = createUiCatalogConnector({ baseUrl: "https://catalog.example.test", transport: transport(response), clock: () => "2026-07-16T00:00:00.000Z" });
  const result = await connector.search({ query, budget: { remaining_total: 7, remaining_connector: 1 } });
  assert.deepEqual(result.candidates.map((candidate) => candidate.candidate_id), ["ui_catalog:a", "ui_catalog:z"]);
  assert.equal(result.source_evidence.some((entry) => entry.source_ref.endsWith("#license")), false);
});

test("connectors classify bounded transport failures without direct network or command execution", async () => {
  const base = { baseUrl: "https://platform.openai.com/docs", clock: () => "2026-07-16T00:00:00.000Z" };
  const empty = createOfficialDocsConnector({ ...base, transport: transport({ status: 404, headers: {}, body: "", captured_at: "2026-07-16T00:00:00.000Z" }) });
  assert.equal((await empty.search({ query, budget: {} })).status, "empty");

  const rateLimited = createOfficialDocsConnector({ ...base, transport: transport({ status: 429, headers: { "retry-after": "30" }, body: "", captured_at: "2026-07-16T00:00:00.000Z" }) });
  await assert.rejects(rateLimited.search({ query, budget: {} }), (error) => error.code === "SOURCE_RATE_LIMITED" && error.retry_after_ms === 30000);

  const serverError = createOfficialDocsConnector({ ...base, transport: transport({ status: 503, headers: {}, body: "", captured_at: "2026-07-16T00:00:00.000Z" }) });
  await assert.rejects(serverError.search({ query, budget: {} }), /SOURCE_SERVER_ERROR/);

  const malformed = createOfficialDocsConnector({ ...base, transport: transport({ status: 200, headers: {}, body: "{", captured_at: "2026-07-16T00:00:00.000Z" }) });
  await assert.rejects(malformed.search({ query, budget: {} }), /SOURCE_JSON_INVALID/);

  const oversized = createOfficialDocsConnector({ ...base, transport: transport({ status: 200, headers: {}, body: "x".repeat(1024 * 1024 + 1), captured_at: "2026-07-16T00:00:00.000Z" }) });
  await assert.rejects(oversized.search({ query, budget: {} }), /SOURCE_BODY_TOO_LARGE/);

  const redirected = createOfficialDocsConnector({ ...base, transport: transport({ ...fixture("official-docs"), url: "https://outside.example.test/docs" }) });
  await assert.rejects(redirected.search({ query, budget: {} }), /SOURCE_REDIRECT_OUTSIDE_ALLOWLIST/);

  assert.throws(() => createOfficialDocsConnector({ ...base, baseUrl: "https://token@example.test/docs", transport: transport(fixture("official-docs")) }), /SOURCE_URL_CREDENTIALS/);
  const source = fs.readFileSync(path.resolve(__dirname, "../src/normalize.js"), "utf8");
  assert.equal(/child_process|https?\.request|\bfetch\s*\(/.test(source), false);
});
