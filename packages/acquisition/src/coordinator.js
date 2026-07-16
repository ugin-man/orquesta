"use strict";

const { assertContract, canonicalHash } = require("@orquesta/contracts");
const { ACQUISITION_LIMITS, compareCodeUnit, sortedUniqueConnectors } = require("./policy");

function sourceFailure(connectorId, error) {
  return {
    connector_id: connectorId,
    code: "source_failure",
    message: error && error.message ? String(error.message) : "Connector failed."
  };
}

function candidateKey(candidate) {
  return `${candidate.candidate_id}\u0000${candidate.source_hash}`;
}

async function searchLiveSources({ query, connectors, cache, clock } = {}) {
  const validQuery = assertContract("live-source-query", query);
  const cacheEvidence = [];
  const cacheIdentity = "acquisition-coordinator-v1";
  if (cache) {
    const cached = cache.read({ query: validQuery, sourceIdentity: cacheIdentity });
    if (cached.status === "hit") return { ...cached.value, cache_evidence: [{ status: "hit" }] };
    if (cached.status !== "miss") cacheEvidence.push({ status: cached.status });
  }

  const selected = sortedUniqueConnectors(connectors, new Set(validQuery.allowed_connector_ids));
  const candidates = new Map();
  const source_results = [];
  const source_failures = [];
  const perConnector = new Map();
  let consumedTotal = 0;

  for (const connector of selected) {
    if (consumedTotal >= ACQUISITION_LIMITS.max_requests_per_need || candidates.size >= ACQUISITION_LIMITS.max_candidates) break;
    const used = perConnector.get(connector.id) || 0;
    if (used >= ACQUISITION_LIMITS.max_requests_per_connector) continue;

    consumedTotal += 1;
    perConnector.set(connector.id, used + 1);
    const budget = Object.freeze({
      remaining_total: ACQUISITION_LIMITS.max_requests_per_need - consumedTotal,
      remaining_connector: ACQUISITION_LIMITS.max_requests_per_connector - used - 1
    });
    try {
      const result = assertContract("live-source-result", await connector.search({ query: validQuery, budget }));
      source_results.push(result);
      for (const candidate of result.candidates) {
        if (candidates.size >= ACQUISITION_LIMITS.max_candidates) break;
        const key = candidateKey(candidate);
        if (!candidates.has(key)) candidates.set(key, candidate);
      }
    } catch (error) {
      source_failures.push(sourceFailure(connector.id, error));
    }
  }

  const output = {
    candidates: [...candidates.values()].sort((left, right) => (
      compareCodeUnit(left.candidate_id, right.candidate_id)
      || compareCodeUnit(left.source_hash, right.source_hash)
    )),
    source_results,
    source_failures,
    cache_evidence: cacheEvidence,
    budget: {
      consumed_total: consumedTotal,
      remaining_total: ACQUISITION_LIMITS.max_requests_per_need - consumedTotal,
      per_connector: Object.fromEntries([...perConnector.entries()].sort(([left], [right]) => compareCodeUnit(left, right)))
    }
  };

  if (cache && source_results.length > 0 && typeof clock === "function") {
    const expiresAt = source_results.map((result) => result.expires_at).sort(compareCodeUnit)[0];
    cache.write({
      query: validQuery,
      sourceIdentity: cacheIdentity,
      fetchedAt: clock(),
      expiresAt,
      value: output,
      redactedHeaders: {}
    });
  }
  return output;
}

module.exports = { searchLiveSources };
