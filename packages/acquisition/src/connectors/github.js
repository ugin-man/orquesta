"use strict";

const { createJsonConnector } = require("../normalize");

function createGitHubConnector({ baseUrl = "https://api.github.com", configuredOwners = [], transport, clock }) {
  const owners = new Set(configuredOwners.filter((owner) => typeof owner === "string" && owner).map((owner) => owner.toLowerCase()).sort());
  return createJsonConnector({
    id: "github",
    trustTier: "community",
    trustTierForItem(item, sourceRef) {
      const parsed = new URL(sourceRef);
      const owner = parsed.hostname === "github.com" ? parsed.pathname.split("/").filter(Boolean)[0] : "";
      return owner && owners.has(owner.toLowerCase()) ? "curated" : "community";
    },
    baseUrl,
    allowedOrigins: ["https://api.github.com", "https://github.com"],
    transport,
    clock,
    ttlMs: 60 * 60 * 1000,
    cacheConfig: { source_uri: baseUrl, trust_policy: `github-owners:${[...owners].join(",")}`, parser_version: "github-json-v1" },
  });
}

module.exports = { createGitHubConnector };
