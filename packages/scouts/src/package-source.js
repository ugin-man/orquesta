"use strict";

const fs = require("node:fs");
const path = require("node:path");

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function containsSensitiveMarker(value) {
  return /[?]|:\/\/|token|secret|password|authorization|auth|bearer|api[_-]?key/i.test(value);
}

function safeVersionSpec(value) {
  const trimmed = value.trim();
  if (trimmed && /^[0-9A-Za-z.*^~<>=|&!+_ -]+$/.test(trimmed) && !containsSensitiveMarker(trimmed)) return trimmed;
  return "redacted";
}

function safePackageName(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || containsSensitiveMarker(trimmed)) return null;
  if (/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(trimmed)) return trimmed;
  return null;
}

function safeScriptKey(value) {
  if (containsSensitiveMarker(value)) return "redacted";
  return /^[A-Za-z0-9][A-Za-z0-9:_-]*$/.test(value) ? value : "redacted";
}

function safeExportKey(value) {
  if (containsSensitiveMarker(value)) return "redacted";
  if (/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) return value;
  if (value === ".") return value;
  if (!/^\.\/[A-Za-z0-9*._/-]+$/.test(value)) return "redacted";
  return value.split("/").some((segment) => segment === "..") ? "redacted" : value;
}

function safeLockPackagePath(value) {
  const trimmed = value.trim();
  if (!trimmed || containsSensitiveMarker(trimmed) || path.isAbsolute(trimmed)) return "redacted";
  const segments = trimmed.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || !/^[A-Za-z0-9@._-]+$/.test(segment))) {
    return "redacted";
  }
  return trimmed;
}

function safeDependencyEntries(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value)
    .filter(([name, version]) => typeof name === "string" && typeof version === "string")
    .map(([name, version]) => ({ name: safePackageName(name) || "redacted", version: safeVersionSpec(version) }))
    .sort((left, right) => compareText(left.name, right.name));
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
      ? [...new Set(Object.keys(manifest.scripts).map(safeScriptKey))].sort(compareText)
      : [];
    const exportNames = manifest.exports && typeof manifest.exports === "object"
      ? [...new Set(Object.keys(manifest.exports).map(safeExportKey))].sort(compareText)
      : [];
    const dependencyEntries = [
      ...safeDependencyEntries(manifest.dependencies),
      ...safeDependencyEntries(manifest.devDependencies)
    ];
    const safeManifestName = safePackageName(manifest.name);
    const manifestVersion = typeof manifest.version === "string" ? safeVersionSpec(manifest.version) : null;
    sources.push({
      source_type: "package_manifest",
      source_ref: "package.json",
      status: "available",
      metadata: {
        name: safeManifestName || (typeof manifest.name === "string" ? "redacted" : null),
        version: manifestVersion,
        exports: exportNames,
        scripts: scriptNames,
        dependencies: dependencyEntries
      }
    });

    const projectName = safeManifestName || (typeof manifest.name === "string" ? "redacted-package" : "workspace-root");
    providers.push({
      provider_id: `package:${projectName}`,
      provider_type: "package_manifest",
      source_type: "package_manifest",
      source_ref: "package.json",
      source_uri: "workspace:package.json",
      name: projectName,
      version: manifestVersion || "unknown",
      capabilities: [
        ...exportNames.map((name) => `package export ${name}`),
        ...scriptNames.map((name) => `package script ${name}`)
      ].concat(exportNames.length || scriptNames.length ? [] : ["package metadata"]),
      trust_tier: "local",
      availability: "available",
      evidence_refs: ["workspace:package.json"]
    });

    for (const { name, version } of dependencyEntries) {
      if (name === "redacted") continue;
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
          package_path: safeLockPackagePath(packagePath),
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
