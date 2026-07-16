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
    ttlMs: 60 * 60 * 1000
  });
}

module.exports = { createRegistryConnector };
