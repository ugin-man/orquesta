"use strict";

const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function comparablePath(value) {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function canonicalProjectRoot(projectRoot) {
  if (typeof projectRoot !== "string" || !projectRoot.trim()) {
    fail("PROJECT_EXECUTION_ROOT_INVALID", "A canonical project root is required");
  }
  const requested = path.resolve(projectRoot);
  let canonical;
  let metadata;
  try {
    canonical = fs.realpathSync(requested);
    metadata = fs.lstatSync(requested);
  } catch (error) {
    fail("PROJECT_EXECUTION_ROOT_UNAVAILABLE", `Project root is unavailable: ${error.message}`);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()
    || comparablePath(requested) !== comparablePath(canonical)) {
    fail("PROJECT_EXECUTION_ROOT_UNSAFE", "Project root must be one canonical real directory");
  }
  return comparablePath(canonical);
}

function projectRootBindingSha256(projectRoot) {
  return createHash("sha256")
    .update("orquesta.project-root-binding.v1\0", "utf8")
    .update(canonicalProjectRoot(projectRoot), "utf8")
    .digest("hex");
}

function projectExecutionContext(projectRoot, projectId) {
  if (typeof projectId !== "string" || !PROJECT_ID.test(projectId)) {
    fail("PROJECT_EXECUTION_ID_INVALID", "A canonical project id is required");
  }
  return {
    project_id: projectId,
    project_root_binding_sha256: projectRootBindingSha256(projectRoot),
  };
}

module.exports = {
  projectExecutionContext,
  projectRootBindingSha256,
};
