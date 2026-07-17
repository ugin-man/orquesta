"use strict";

const { createJsonConnector } = require("../normalize");

function createUiCatalogConnector({ baseUrl, transport, clock }) {
  return createJsonConnector({
    id: "ui_catalog",
    trustTier: "curated",
    baseUrl,
    allowedOrigins: [new URL(baseUrl).origin],
    transport,
    clock,
    ttlMs: 24 * 60 * 60 * 1000,
    cacheConfig: { source_uri: baseUrl, trust_policy: "curated_catalog", parser_version: "ui-catalog-json-v1" },
  });
}

module.exports = { createUiCatalogConnector };
