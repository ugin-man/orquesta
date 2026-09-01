"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { loadDesktopOperation } = require("../src/desktop-operation-catalog");

const OPERATION_ID = "organization.agent-placement.persistent.v1";
const PRODUCT_ROOT = path.resolve(__dirname, "..", "..", "..");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-operation-catalog-"));
  const source = path.join(PRODUCT_ROOT, "orquesta", "references");
  const target = path.join(root, "orquesta", "references");
  fs.mkdirSync(target, { recursive: true });
  for (const name of [
    "desktop-operation-catalog.generated.json",
    "organization-agent-placement-persistent-v1.schema.json",
    "organization-agent-placement-persistent-v1.md",
  ]) fs.copyFileSync(path.join(source, name), path.join(target, name));
  return { root, dispose: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

test("Desktop operation loader verifies and returns only the selected operation", () => {
  const loaded = loadDesktopOperation({ productRoot: PRODUCT_ROOT, operationId: OPERATION_ID });
  assert.equal(loaded.operation.operation_id, OPERATION_ID);
  assert.equal(loaded.schema.$id, "organization-agent-placement-persistent-v1");
  assert.match(loaded.instruction, /情報が足りない時/u);
  assert.equal(Object.isFrozen(loaded), true);
  assert.equal(Object.isFrozen(loaded.operation), true);
});

test("Malformed unrelated catalog entries do not poison the selected operation", () => {
  const project = fixture();
  try {
    const catalogPath = path.join(project.root, "orquesta", "references", "desktop-operation-catalog.generated.json");
    const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
    catalog.operations.unshift(null, { operation_id: "unrelated.operation" });
    fs.writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
    assert.equal(
      loadDesktopOperation({ productRoot: project.root, operationId: OPERATION_ID }).operation.operation_id,
      OPERATION_ID
    );
  } finally {
    project.dispose();
  }
});

test("Desktop operation loader derives schema identity from the selected catalog entry", () => {
  const project = fixture();
  try {
    const references = path.join(project.root, "orquesta", "references");
    const schemaBytes = Buffer.from(`${JSON.stringify({ $id: "unrelated-schema-v1", type: "object" }, null, 2)}\n`, "utf8");
    const instructionBytes = Buffer.from("# Unrelated operation\n", "utf8");
    fs.writeFileSync(path.join(references, "unrelated.schema.json"), schemaBytes);
    fs.writeFileSync(path.join(references, "unrelated.md"), instructionBytes);
    const catalogPath = path.join(references, "desktop-operation-catalog.generated.json");
    const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
    catalog.operations.push({
      operation_id: "unrelated.operation.v1",
      version: 1,
      description: "A second operation used to prove generic catalog loading.",
      schema_id: "unrelated-schema-v1",
      schema_ref: "orquesta/references/unrelated.schema.json",
      instruction_ref: "orquesta/references/unrelated.md",
      schema_sha256: digest(schemaBytes),
      instruction_sha256: digest(instructionBytes),
    });
    fs.writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
    const loaded = loadDesktopOperation({ productRoot: project.root, operationId: "unrelated.operation.v1" });
    assert.equal(loaded.schema.$id, "unrelated-schema-v1");
  } finally {
    project.dispose();
  }
});

test("Desktop operation loader fails closed on selected asset drift", () => {
  const project = fixture();
  try {
    const schemaPath = path.join(project.root, "orquesta", "references", "organization-agent-placement-persistent-v1.schema.json");
    fs.appendFileSync(schemaPath, " \n", "utf8");
    assert.throws(
      () => loadDesktopOperation({ productRoot: project.root, operationId: OPERATION_ID }),
      { code: "DESKTOP_OPERATION_ASSET_HASH_MISMATCH" }
    );
  } finally {
    project.dispose();
  }
});

test("Desktop operation loader rejects path escape in the selected entry", () => {
  const project = fixture();
  try {
    const catalogPath = path.join(project.root, "orquesta", "references", "desktop-operation-catalog.generated.json");
    const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
    catalog.operations[0].schema_ref = "../escape.json";
    fs.writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
    assert.throws(
      () => loadDesktopOperation({ productRoot: project.root, operationId: OPERATION_ID }),
      { code: "DESKTOP_OPERATION_REFERENCE_INVALID" }
    );
  } finally {
    project.dispose();
  }
});
