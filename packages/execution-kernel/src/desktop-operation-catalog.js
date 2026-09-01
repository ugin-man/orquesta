"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_CATALOG_PATH = "orquesta/references/desktop-operation-catalog.generated.json";
const OPERATION_ID = /^[a-z][a-z0-9.-]*$/;
const SHA256 = /^[a-f0-9]{64}$/;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function comparable(value) {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function assertInside(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    fail("DESKTOP_OPERATION_PATH_ESCAPE", "Desktop operation asset escaped its trusted product root");
  }
}

function trustedRoot(rootPath) {
  if (typeof rootPath !== "string" || !rootPath.trim()) {
    fail("DESKTOP_OPERATION_ROOT_INVALID", "Desktop operation product root is required");
  }
  const requested = path.resolve(rootPath);
  let canonical;
  try {
    canonical = fs.realpathSync(requested);
  } catch (error) {
    fail("DESKTOP_OPERATION_ROOT_UNAVAILABLE", `Desktop operation product root is unavailable: ${error.message}`);
  }
  const metadata = fs.lstatSync(requested);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || comparable(requested) !== comparable(canonical)) {
    fail("DESKTOP_OPERATION_ROOT_UNSAFE", "Desktop operation product root must be a canonical real directory");
  }
  return canonical;
}

function exactAsset(rootPath, relativePath, label) {
  if (typeof relativePath !== "string" || !relativePath.trim()
    || path.isAbsolute(relativePath)
    || relativePath.includes("\\")
    || relativePath.split("/").some((part) => !part || part === "." || part === "..")) {
    fail("DESKTOP_OPERATION_REFERENCE_INVALID", `${label} must be a canonical product-relative path`);
  }
  const candidate = path.resolve(rootPath, ...relativePath.split("/"));
  assertInside(rootPath, candidate);
  let metadata;
  try {
    metadata = fs.lstatSync(candidate);
  } catch (error) {
    fail("DESKTOP_OPERATION_ASSET_MISSING", `${label} is unavailable: ${error.message}`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail("DESKTOP_OPERATION_ASSET_UNSAFE", `${label} must be a real file`);
  }
  const canonical = fs.realpathSync(candidate);
  if (comparable(canonical) !== comparable(candidate)) {
    fail("DESKTOP_OPERATION_ASSET_UNSAFE", `${label} cannot traverse an alias or symlink`);
  }
  assertInside(rootPath, canonical);
  return canonical;
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function readJsonBytes(filePath, label) {
  const bytes = fs.readFileSync(filePath);
  try {
    return { bytes, value: JSON.parse(bytes.toString("utf8")) };
  } catch (error) {
    fail("DESKTOP_OPERATION_ASSET_INVALID", `${label} is not valid UTF-8 JSON: ${error.message}`);
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function validateSelectedOperation(operation, operationId) {
  const expectedKeys = [
    "operation_id", "version", "description", "schema_id", "schema_ref", "instruction_ref",
    "schema_sha256", "instruction_sha256",
  ].sort();
  if (!operation || typeof operation !== "object" || Array.isArray(operation)
    || JSON.stringify(Object.keys(operation).sort()) !== JSON.stringify(expectedKeys)
    || operation.operation_id !== operationId
    || !OPERATION_ID.test(operation.operation_id)
    || !Number.isSafeInteger(operation.version) || operation.version < 1
    || typeof operation.description !== "string" || !operation.description.trim()
    || typeof operation.schema_id !== "string" || !/^[a-z][a-z0-9-]*$/.test(operation.schema_id)
    || !SHA256.test(operation.schema_sha256)
    || !SHA256.test(operation.instruction_sha256)) {
    fail("DESKTOP_OPERATION_ENTRY_INVALID", `Desktop operation entry is invalid: ${operationId}`);
  }
}

function loadDesktopOperation({
  productRoot,
  operationId,
  catalogRelativePath = DEFAULT_CATALOG_PATH,
} = {}) {
  if (typeof operationId !== "string" || !OPERATION_ID.test(operationId)) {
    fail("DESKTOP_OPERATION_ID_INVALID", "A canonical Desktop operation id is required");
  }
  const root = trustedRoot(productRoot);
  const catalogPath = exactAsset(root, catalogRelativePath, "Desktop operation catalog");
  const { value: catalog } = readJsonBytes(catalogPath, "Desktop operation catalog");
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)
    || JSON.stringify(Object.keys(catalog).sort()) !== JSON.stringify(["operations", "schema_version"])
    || catalog.schema_version !== 1 || !Array.isArray(catalog.operations)) {
    fail("DESKTOP_OPERATION_CATALOG_INVALID", "Desktop operation catalog envelope is invalid");
  }
  // An unrelated operation can be unavailable or malformed without making the
  // selected operation unreadable. Only duplicate selected ids are ambiguous.
  const matches = catalog.operations.filter((entry) => entry && entry.operation_id === operationId);
  if (matches.length === 0) fail("DESKTOP_OPERATION_NOT_FOUND", `Desktop operation is not registered: ${operationId}`);
  if (matches.length !== 1) fail("DESKTOP_OPERATION_AMBIGUOUS", `Desktop operation id is duplicated: ${operationId}`);
  const operation = matches[0];
  validateSelectedOperation(operation, operationId);

  const schemaPath = exactAsset(root, operation.schema_ref, "Desktop operation schema");
  const instructionPath = exactAsset(root, operation.instruction_ref, "Desktop operation instruction");
  const schemaAsset = readJsonBytes(schemaPath, "Desktop operation schema");
  const instructionBytes = fs.readFileSync(instructionPath);
  if (sha256(schemaAsset.bytes) !== operation.schema_sha256
    || sha256(instructionBytes) !== operation.instruction_sha256) {
    fail("DESKTOP_OPERATION_ASSET_HASH_MISMATCH", `Desktop operation assets do not match the generated catalog: ${operationId}`);
  }
  if (!schemaAsset.value || typeof schemaAsset.value !== "object"
    || Array.isArray(schemaAsset.value)
    || schemaAsset.value.$id !== operation.schema_id) {
    fail("DESKTOP_OPERATION_SCHEMA_INVALID", `Desktop operation schema identity is invalid: ${operationId}`);
  }
  const instruction = instructionBytes.toString("utf8");
  if (!instruction.trim()) fail("DESKTOP_OPERATION_INSTRUCTION_INVALID", `Desktop operation instruction is empty: ${operationId}`);
  return deepFreeze({
    operation: structuredClone(operation),
    schema: structuredClone(schemaAsset.value),
    instruction,
    catalog_path: catalogPath,
    schema_path: schemaPath,
    instruction_path: instructionPath,
  });
}

module.exports = {
  DEFAULT_CATALOG_PATH,
  loadDesktopOperation,
};
