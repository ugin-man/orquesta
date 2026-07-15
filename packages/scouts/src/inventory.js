"use strict";

const crypto = require("node:crypto");
const path = require("node:path");

const { collectCodexSources } = require("./codex-source");
const { collectFixtureSource } = require("./fixture-source");
const { collectPackageSources } = require("./package-source");
const { collectRepositorySource } = require("./repository-source");

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function providerHash(provider) {
  const fingerprint = { ...provider };
  delete fingerprint.provider_hash;
  delete fingerprint.last_verified_at;
  return crypto.createHash("sha256").update(stableJson(fingerprint), "utf8").digest("hex");
}

function requireOption(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    const error = new TypeError(`${name} is required.`);
    error.code = "INVENTORY_OPTION_REQUIRED";
    throw error;
  }
  return path.resolve(value);
}

function collectLocalInventory(options = {}) {
  const projectRoot = requireOption(options.projectRoot, "projectRoot");
  const codexHome = requireOption(options.codexHome, "codexHome");
  const fixtureCatalogPath = requireOption(options.fixtureCatalogPath, "fixtureCatalogPath");
  const clock = typeof options.clock === "function" ? options.clock : () => new Date().toISOString();
  const collectedAt = clock();

  const collections = [
    collectRepositorySource({ projectRoot }),
    collectPackageSources({ projectRoot }),
    collectCodexSources({ codexHome }),
    collectFixtureSource({ projectRoot, fixtureCatalogPath })
  ];
  const sources = collections.flatMap((collection) => collection.sources);
  const rawProviders = collections.flatMap((collection) => collection.providers);
  const providersById = new Map();
  const conflictsById = new Map();

  for (const rawProvider of rawProviders) {
    const provider = {
      ...rawProvider,
      last_verified_at: collectedAt,
      provider_hash: providerHash(rawProvider)
    };
    const existing = providersById.get(provider.provider_id);
    if (!existing) {
      providersById.set(provider.provider_id, provider);
      continue;
    }
    if (existing.provider_hash === provider.provider_hash) continue;
    const conflict = conflictsById.get(provider.provider_id) || {
      provider_id: provider.provider_id,
      status: "conflict",
      hashes: [existing.provider_hash]
    };
    if (!conflict.hashes.includes(provider.provider_hash)) conflict.hashes.push(provider.provider_hash);
    conflict.hashes.sort();
    conflictsById.set(provider.provider_id, conflict);
  }

  return {
    version: 1,
    collected_at: collectedAt,
    sources,
    providers: [...providersById.values()]
      .filter((provider) => !conflictsById.has(provider.provider_id))
      .sort((left, right) => compareText(left.provider_id, right.provider_id)),
    conflicts: [...conflictsById.values()].sort((left, right) => compareText(left.provider_id, right.provider_id))
  };
}

module.exports = { collectLocalInventory };
