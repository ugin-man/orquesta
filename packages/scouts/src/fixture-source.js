"use strict";

const fs = require("node:fs");
const path = require("node:path");

function normalizeRef(value) {
  return value.split(path.sep).join("/");
}

function collectFixtureSource({ projectRoot, fixtureCatalogPath }) {
  const sourceRef = normalizeRef(path.relative(projectRoot, fixtureCatalogPath));
  if (!fs.existsSync(fixtureCatalogPath)) {
    return {
      sources: [{ source_type: "fixture", source_ref: sourceRef, status: "absent" }],
      providers: []
    };
  }
  const catalog = JSON.parse(fs.readFileSync(fixtureCatalogPath, "utf8"));
  if (catalog.version !== 1 || !Array.isArray(catalog.providers)) {
    const error = new Error("Fixture catalog must contain version 1 providers.");
    error.code = "INVENTORY_FIXTURE_INVALID";
    throw error;
  }
  const providers = catalog.providers.map((raw, index) => {
    if (!raw || typeof raw.provider_id !== "string" || !raw.provider_id || !Array.isArray(raw.capabilities)) {
      const error = new Error(`Fixture provider ${index} is invalid.`);
      error.code = "INVENTORY_FIXTURE_INVALID";
      throw error;
    }
    const provider = {
      provider_id: raw.provider_id,
      provider_type: typeof raw.provider_type === "string" && raw.provider_type ? raw.provider_type : "fixture",
      source_type: "fixture",
      source_ref: sourceRef,
      source_uri: `workspace:${sourceRef}`,
      capabilities: raw.capabilities.filter((item) => typeof item === "string" && item),
      trust_tier: typeof raw.trust_tier === "string" ? raw.trust_tier : "unverified",
      availability: "available",
      version: typeof raw.version === "string" && raw.version ? raw.version : "fixture",
      evidence_refs: [`workspace:${sourceRef}#${raw.provider_id}`]
    };
    if (typeof raw.name === "string") provider.name = raw.name;
    if (typeof raw.description === "string") provider.description = raw.description;
    if (typeof raw.license === "string") provider.license = raw.license;
    return provider;
  });
  return {
    sources: [{ source_type: "fixture", source_ref: sourceRef, status: "available", count: providers.length }],
    providers
  };
}

module.exports = { collectFixtureSource };
