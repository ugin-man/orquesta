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
    ttlMs: 24 * 60 * 60 * 1000
  });
}

module.exports = { createUiCatalogConnector };
