"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { canonicalHash } = require("@orquesta/contracts");
const { createAcquisitionCache } = require("../src");

const query = {
  need_id: "NEED-cache",
  query_terms: ["json", "validation"],
  allowed_connector_ids: ["official_docs", "registry"],
  request_budget: { max_requests_per_need: 8, max_requests_per_connector: 2 },
  candidate_limit: 3,
  requested_at: "2026-07-16T00:00:00.000Z"
};

function removeProbeTree(root) {
  for (const entry of fs.readdirSync(root)) fs.unlinkSync(path.join(root, entry));
  fs.rmdirSync(root);
}

function cachePath(root) {
  return path.join(root, `${canonicalHash(query)}.json`);
}

test("acquisition cache hits before expiry and serializes only redacted headers", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-acquisition-cache-"));
  try {
    const cache = createAcquisitionCache({ cacheRoot: root, clock: () => "2026-07-16T00:30:00.000Z" });
    cache.write({
      query,
      sourceIdentity: "official_docs:https://platform.openai.com/docs",
      fetchedAt: "2026-07-16T00:00:00.000Z",
      expiresAt: "2026-07-16T01:00:00.000Z",
      value: { candidates: ["candidate-a"] },
      redactedHeaders: { "x-request-id": "request-1" },
      headers: { authorization: "Bearer never-persist-this" }
    });

    const hit = cache.read({ query, sourceIdentity: "official_docs:https://platform.openai.com/docs" });
    assert.equal(hit.status, "hit");
    assert.deepEqual(hit.value, { candidates: ["candidate-a"] });
    assert.equal(fs.readFileSync(cachePath(root), "utf8").includes("never-persist-this"), false);
  } finally {
    removeProbeTree(root);
  }
});

test("acquisition cache treats exact expiry as stale and rejects tampered evidence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-acquisition-cache-"));
  try {
    const cache = createAcquisitionCache({ cacheRoot: root, clock: () => "2026-07-16T01:00:00.000Z" });
    cache.write({
      query,
      sourceIdentity: "official_docs:https://platform.openai.com/docs",
      fetchedAt: "2026-07-16T00:00:00.000Z",
      expiresAt: "2026-07-16T01:00:00.000Z",
      value: { candidates: [] },
      redactedHeaders: {}
    });
    assert.equal(cache.read({ query, sourceIdentity: "official_docs:https://platform.openai.com/docs" }).status, "stale");
    assert.equal(cache.read({ query, sourceIdentity: "registry:https://registry.npmjs.org" }).status, "invalid");

    fs.writeFileSync(cachePath(root), "{", "utf8");
    assert.equal(cache.read({ query, sourceIdentity: "official_docs:https://platform.openai.com/docs" }).status, "invalid");
  } finally {
    removeProbeTree(root);
  }
});
