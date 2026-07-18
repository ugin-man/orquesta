"use strict";

const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function inventoryError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function normalizeRef(value) {
  return value.split(path.sep).join("/");
}

function isWithin(rootPath, targetPath) {
  const relative = path.relative(rootPath, targetPath);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function readGitRevision(projectRoot) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    throw inventoryError("INVENTORY_GIT_REVISION_UNAVAILABLE", "Repository providers require a Git revision.");
  }
}

function collectRepositorySource({ projectRoot }) {
  const manifestPath = path.join(projectRoot, "orquesta.capabilities.json");
  if (!fs.existsSync(manifestPath)) {
    return {
      sources: [{ source_type: "repository", source_ref: "orquesta.capabilities.json", status: "absent" }],
      providers: []
    };
  }

  const manifestStat = fs.statSync(manifestPath);
  if (!manifestStat.isFile()) {
    throw inventoryError("INVENTORY_MANIFEST_NOT_REGULAR_FILE", "orquesta.capabilities.json must be a regular file.");
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.version !== 1 || !Array.isArray(manifest.providers)) {
    throw inventoryError("INVENTORY_MANIFEST_INVALID", "orquesta.capabilities.json must contain version 1 providers.");
  }

  const projectRealPath = fs.realpathSync(projectRoot);
  const gitRevision = readGitRevision(projectRoot);
  const providers = manifest.providers.map((raw, index) => {
    if (!raw || typeof raw !== "object" || typeof raw.provider_id !== "string" || !raw.provider_id.trim()) {
      throw inventoryError("INVENTORY_PROVIDER_INVALID", `Repository provider ${index} needs provider_id.`);
    }
    if (typeof raw.source_ref !== "string" || !raw.source_ref.trim()) {
      throw inventoryError("INVENTORY_PROVIDER_INVALID", `Repository provider ${raw.provider_id} needs source_ref.`);
    }
    if (!Array.isArray(raw.capabilities) || !raw.capabilities.every((item) => typeof item === "string" && item.trim())) {
      throw inventoryError("INVENTORY_PROVIDER_INVALID", `Repository provider ${raw.provider_id} needs capabilities.`);
    }

    const resolvedPath = path.resolve(projectRoot, raw.source_ref);
    if (!fs.existsSync(resolvedPath)) {
      throw inventoryError("INVENTORY_SOURCE_MISSING", `Repository provider source does not exist: ${raw.source_ref}`);
    }
    const realPath = fs.realpathSync(resolvedPath);
    if (!isWithin(projectRealPath, realPath)) {
      throw inventoryError("INVENTORY_SOURCE_OUTSIDE_WORKSPACE", `Repository provider source is outside the workspace: ${raw.source_ref}`);
    }
    if (!fs.statSync(realPath).isFile()) {
      throw inventoryError("INVENTORY_SOURCE_NOT_REGULAR_FILE", `Repository provider source is not a regular file: ${raw.source_ref}`);
    }

    const sourceRef = normalizeRef(path.relative(projectRealPath, realPath));
    const sha256 = sha256File(realPath);
    return {
      provider_id: raw.provider_id.trim(),
      provider_type: typeof raw.provider_type === "string" && raw.provider_type.trim() ? raw.provider_type.trim() : "repository_code",
      source_type: "repository",
      source_ref: sourceRef,
      source_uri: `workspace:${sourceRef}`,
      capabilities: [...raw.capabilities],
      trust_tier: typeof raw.trust_tier === "string" ? raw.trust_tier : "local",
      availability: "available",
      version: typeof raw.version === "string" && raw.version ? raw.version : gitRevision,
      license: typeof raw.license === "string" ? raw.license : "unknown",
      evidence_refs: [`workspace:${sourceRef}`, `sha256:${sha256}`, `git:${gitRevision}`],
      evidence: { sha256, git_revision: gitRevision, regular_file: true }
    };
  });

  return {
    sources: [{
      source_type: "repository",
      source_ref: "orquesta.capabilities.json",
      status: "available",
      sha256: sha256File(manifestPath),
      git_revision: gitRevision
    }],
    providers
  };
}

module.exports = { collectRepositorySource };
