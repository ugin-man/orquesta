"use strict";

const { createJsonConnector } = require("../normalize");

function createRegistryConnector({ baseUrl = "https://registry.npmjs.org", transport, clock }) {
  return createJsonConnector({
    id: "registry",
    trustTier: "official",
    baseUrl,
    allowedOrigins: ["https://registry.npmjs.org"],
    transport,
    clock,
    ttlMs: 60 * 60 * 1000,
    cacheConfig: { source_uri: baseUrl, trust_policy: "registry_metadata", parser_version: "registry-json-v1" },
  });
}

module.exports = { createRegistryConnector };
