"use strict";

const fs = require("node:fs");
const path = require("node:path");

function normalizeRef(value) {
  return value.split(path.sep).join("/");
}

function fixtureError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function containedRelative(rootPath, targetPath) {
  const relative = path.relative(rootPath, targetPath);
  if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) return null;
  return relative;
}

function collectFixtureSource({ projectRoot, fixtureCatalogPath }) {
  const resolvedRoot = path.resolve(projectRoot);
  const resolvedCatalog = path.resolve(fixtureCatalogPath);
  const lexicalRelative = containedRelative(resolvedRoot, resolvedCatalog);
  if (!lexicalRelative) {
    throw fixtureError("INVENTORY_FIXTURE_OUTSIDE_WORKSPACE", "Fixture catalog must be inside the workspace.");
  }
  const sourceRef = normalizeRef(lexicalRelative);
  if (!fs.existsSync(resolvedCatalog)) {
    return {
      sources: [{ source_type: "fixture", source_ref: sourceRef, status: "absent" }],
      providers: []
    };
  }
  const realRoot = fs.realpathSync(resolvedRoot);
  const realCatalog = fs.realpathSync(resolvedCatalog);
  if (!containedRelative(realRoot, realCatalog)) {
    throw fixtureError("INVENTORY_FIXTURE_OUTSIDE_WORKSPACE", "Fixture catalog must resolve inside the workspace.");
  }
  if (!fs.statSync(realCatalog).isFile()) {
    throw fixtureError("INVENTORY_FIXTURE_NOT_REGULAR_FILE", "Fixture catalog must be a regular file.");
  }
  const catalog = JSON.parse(fs.readFileSync(realCatalog, "utf8"));
  if (catalog.version !== 1 || !Array.isArray(catalog.providers)) {
    const error = new Error("Fixture catalog must contain version 1 providers.");
    error.code = "INVENTORY_FIXTURE_INVALID";
    throw error;
  }
  const providers = catalog.providers.map((raw, index) => {
    const providerId = raw && typeof raw.provider_id === "string" ? raw.provider_id.trim() : "";
    const capabilities = raw && Array.isArray(raw.capabilities)
      ? raw.capabilities.map((item) => typeof item === "string" ? item.trim() : null)
      : null;
    if (!providerId || !capabilities || capabilities.length === 0 || capabilities.some((item) => !item)) {
      const error = new Error(`Fixture provider ${index} is invalid.`);
      error.code = "INVENTORY_FIXTURE_INVALID";
      throw error;
    }
    const provider = {
      provider_id: providerId,
      provider_type: typeof raw.provider_type === "string" && raw.provider_type ? raw.provider_type : "fixture",
      source_type: "fixture",
      source_ref: sourceRef,
      source_uri: `workspace:${sourceRef}`,
      capabilities,
      trust_tier: typeof raw.trust_tier === "string" ? raw.trust_tier : "unverified",
      availability: "available",
      version: typeof raw.version === "string" && raw.version ? raw.version : "fixture",
      evidence_refs: [`workspace:${sourceRef}#${providerId}`]
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
