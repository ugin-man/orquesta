"use strict";

const { createJsonConnector } = require("../normalize");

function createOfficialDocsConnector({ baseUrl = "https://platform.openai.com/docs", transport, clock }) {
  return createJsonConnector({
    id: "official_docs",
    trustTier: "official",
    baseUrl,
    allowedOrigins: ["https://platform.openai.com"],
    transport,
    clock,
    ttlMs: 24 * 60 * 60 * 1000,
    cacheConfig: { source_uri: baseUrl, trust_policy: "official_docs", parser_version: "official-docs-json-v1" },
  });
}

module.exports = { createOfficialDocsConnector };
