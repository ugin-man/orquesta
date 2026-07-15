"use strict";

const fs = require("node:fs");
const path = require("node:path");

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function safeVersionSpec(value) {
  if (/^[0-9A-Za-z.*^~<>=|&!+_ -]+$/.test(value) && !/(token|secret|password|api[_-]?key)/i.test(value)) return value;
  return "redacted";
}

function safeStringEntries(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value)
    .filter(([name, version]) => typeof name === "string" && typeof version === "string")
    .map(([name, version]) => [name, safeVersionSpec(version)])
    .sort(([left], [right]) => compareText(left, right));
}

function collectPackageSources({ projectRoot }) {
  const manifestPath = path.join(projectRoot, "package.json");
  const lockPath = path.join(projectRoot, "package-lock.json");
  const sources = [];
  const providers = [];

  if (!fs.existsSync(manifestPath)) {
    sources.push({ source_type: "package_manifest", source_ref: "package.json", status: "absent" });
  } else {
    const manifest = readJson(manifestPath);
    const scriptNames = manifest.scripts && typeof manifest.scripts === "object"
      ? Object.keys(manifest.scripts).sort()
      : [];
    const exportNames = manifest.exports && typeof manifest.exports === "object"
      ? Object.keys(manifest.exports).sort()
      : [];
    const dependencyEntries = [
      ...safeStringEntries(manifest.dependencies),
      ...safeStringEntries(manifest.devDependencies)
    ];
    sources.push({
      source_type: "package_manifest",
      source_ref: "package.json",
      status: "available",
      metadata: {
        name: typeof manifest.name === "string" ? manifest.name : null,
        version: typeof manifest.version === "string" ? manifest.version : null,
        exports: exportNames,
        scripts: scriptNames,
        dependencies: dependencyEntries.map(([name, version]) => ({ name, version }))
      }
    });

    const projectName = typeof manifest.name === "string" && manifest.name ? manifest.name : "workspace-root";
    providers.push({
      provider_id: `package:${projectName}`,
      provider_type: "package_manifest",
      source_type: "package_manifest",
      source_ref: "package.json",
      source_uri: "workspace:package.json",
      name: projectName,
      version: typeof manifest.version === "string" && manifest.version ? manifest.version : "unknown",
      capabilities: [
        ...exportNames.map((name) => `package export ${name}`),
        ...scriptNames.map((name) => `package script ${name}`)
      ].concat(exportNames.length || scriptNames.length ? [] : ["package metadata"]),
      trust_tier: "local",
      availability: "available",
      evidence_refs: ["workspace:package.json"]
    });

    for (const [name, version] of dependencyEntries) {
      providers.push({
        provider_id: `package:${name}`,
        provider_type: "npm_package",
        source_type: "package_manifest",
        source_ref: "package.json",
        source_uri: "workspace:package.json",
        name,
        version,
        capabilities: [`package ${name}`],
        trust_tier: "local",
        availability: "available",
        evidence_refs: [`workspace:package.json#${name}`]
      });
    }
  }

  if (!fs.existsSync(lockPath)) {
    sources.push({ source_type: "package_lock", source_ref: "package-lock.json", status: "absent" });
  } else {
    const lock = readJson(lockPath);
    const packages = lock.packages && typeof lock.packages === "object"
      ? Object.entries(lock.packages)
        .filter(([packagePath, metadata]) => packagePath && metadata && typeof metadata.version === "string")
        .map(([packagePath, metadata]) => ({
          package_path: /[?]|:\/\/|(token|secret|password|api[_-]?key)/i.test(packagePath) ? "redacted" : packagePath,
          version: safeVersionSpec(metadata.version)
        }))
        .sort((left, right) => compareText(left.package_path, right.package_path))
      : [];
    sources.push({
      source_type: "package_lock",
      source_ref: "package-lock.json",
      status: "available",
      metadata: {
        lockfile_version: Number.isInteger(lock.lockfileVersion) ? lock.lockfileVersion : null,
        packages
      }
    });
  }

  return { sources, providers };
}

module.exports = { collectPackageSources };
