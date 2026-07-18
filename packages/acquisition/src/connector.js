"use strict";

function canonicalCacheConfig({ id, trustTier, cacheConfig } = {}) {
  const source = cacheConfig && typeof cacheConfig.source_uri === "string" ? cacheConfig.source_uri : "";
  let sourceUri = "";
  let sourceOrigin = "";
  if (source) {
    const parsed = new URL(source);
    if (parsed.username || parsed.password) throw new TypeError("Connector cache source must not contain credentials.");
    parsed.search = "";
    parsed.hash = "";
    sourceUri = parsed.toString();
    sourceOrigin = parsed.origin;
  }
  return Object.freeze({
    id,
    source_uri: sourceUri,
    source_origin: sourceOrigin,
    trust_policy: cacheConfig && Object.hasOwn(cacheConfig, "trust_policy") ? cacheConfig.trust_policy : trustTier,
    parser_version: cacheConfig && typeof cacheConfig.parser_version === "string" ? cacheConfig.parser_version : "v1",
  });
}

function createLiveSourceConnector({ id, trustTier, transport, search, cacheConfig } = {}) {
  if (typeof id !== "string" || !id) throw new TypeError("Live source connector requires an id.");
  if (typeof trustTier !== "string" || !trustTier) throw new TypeError("Live source connector requires a trustTier.");
  if (!transport || typeof transport.request !== "function") throw new TypeError("Live source connector requires an injected transport.");
  if (typeof search !== "function") throw new TypeError("Live source connector requires a search function.");
  return Object.freeze({
    id,
    trustTier,
    transport,
    cache_config: canonicalCacheConfig({ id, trustTier, cacheConfig }),
    async search(input) {
      return search({ ...input, transport: input && input.transport ? input.transport : transport });
    }
  });
}

module.exports = { createLiveSourceConnector };
