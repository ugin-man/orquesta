"use strict";

const { createJsonConnector } = require("../normalize");

function createGitHubConnector({ baseUrl = "https://api.github.com", configuredOwners = [], transport, clock }) {
  const trustTier = configuredOwners.length > 0 ? "curated" : "community";
  return createJsonConnector({
    id: "github",
    trustTier,
    baseUrl,
    allowedOrigins: ["https://api.github.com", "https://github.com"],
    transport,
    clock,
    ttlMs: 60 * 60 * 1000
  });
}

module.exports = { createGitHubConnector };
