import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaFiles = Object.freeze({
  agent: "agent-registry-v3.schema.json",
  formation: "formation-state.schema.json",
  organization: "organization-state-v3.schema.json",
  agentPlacementPersistent: "organization-agent-placement-persistent-v1.schema.json",
  placement: "placement-intent.schema.json",
  placementTaskState: "placement-task-state-v3.schema.json",
  sessionBinding: "session-binding-state-v1.schema.json"
});
const outputPath = path.join(packageRoot, "src", "organization-v3-contracts.generated.d.ts");
const skillReferencesRoot = path.resolve(packageRoot, "..", "..", "orquesta", "references");
const skillSchemasRoot = path.resolve(packageRoot, "..", "..", "orquesta", "schemas");
const distributedPlacementSchemaPath = path.join(skillReferencesRoot, "organization-agent-placement-persistent-v1.schema.json");
const placementInstructionPath = path.join(skillReferencesRoot, "organization-agent-placement-persistent-v1.md");
const operationCatalogPath = path.join(skillReferencesRoot, "desktop-operation-catalog.generated.json");

function distributedSchemaEntries() {
  return [...new Set(Object.values(schemaFiles))].map((fileName) => ({
    fileName,
    source: path.join(packageRoot, "schemas", fileName),
    distributed: path.join(skillSchemasRoot, fileName),
  }));
}

function readSchemas() {
  const hash = crypto.createHash("sha256");
  const schemas = {};
  for (const [key, fileName] of Object.entries(schemaFiles)) {
    const bytes = fs.readFileSync(path.join(packageRoot, "schemas", fileName));
    hash.update(fileName);
    hash.update("\0");
    hash.update(bytes);
    hash.update("\0");
    schemas[key] = JSON.parse(bytes.toString("utf8"));
  }
  return { schemas, hash: hash.digest("hex") };
}

function at(root, segments) {
  return segments.reduce((value, segment) => value[segment], root);
}

function propertyName(value) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value) ? value : JSON.stringify(value);
}

function literal(value) {
  return value === null ? "null" : JSON.stringify(value);
}

function schemaType(schema, indent = 0) {
  if (schema.anyOf) return schema.anyOf.map((entry) => schemaType(entry, indent)).join(" | ");
  if (schema.oneOf) return schema.oneOf.map((entry) => schemaType(entry, indent)).join(" | ");
  if (Object.hasOwn(schema, "const")) return literal(schema.const);
  if (schema.enum) return schema.enum.map(literal).join(" | ");
  if (schema.type === "null") return "null";
  if (schema.type === "boolean") return "boolean";
  if (schema.type === "integer" || schema.type === "number") return "number";
  if (schema.type === "string") return "string";
  if (schema.type === "array") return `Array<${schemaType(schema.items, indent)}>`;
  if (schema.type === "object" || schema.properties) {
    const required = new Set(schema.required || []);
    const padding = "  ".repeat(indent);
    const childPadding = "  ".repeat(indent + 1);
    const fields = Object.entries(schema.properties || {}).map(([name, child]) => (
      `${childPadding}${propertyName(name)}${required.has(name) ? "" : "?"}: ${schemaType(child, indent + 1)};`
    ));
    return fields.length === 0 ? "Record<string, never>" : `{\n${fields.join("\n")}\n${padding}}`;
  }
  throw new TypeError(`unsupported schema node: ${JSON.stringify(schema)}`);
}

function generate() {
  const { schemas, hash } = readSchemas();
  const definitions = [
    ["AgentLifecycleState", "agent", ["properties", "agents", "items", "properties", "lifecycle_state"]],
    ["AgentOrigin", "agent", ["properties", "agents", "items", "properties", "origin", "anyOf", 0]],
    ["AgentCreationRefKind", "agent", ["properties", "agents", "items", "properties", "created_from_ref", "anyOf", 0, "properties", "kind"]],
    ["AgentCreationRef", "agent", ["properties", "agents", "items", "properties", "created_from_ref", "anyOf", 0]],
    ["AgentV3", "agent", ["properties", "agents", "items"]],
    ["AgentRegistryV3", "agent", []],
    ["CoordinationMode", "organization", ["properties", "teams", "items", "properties", "coordination_mode"]],
    ["OrganizationReferenceKind", "organization", ["properties", "relationships", "items", "properties", "subject_ref", "properties", "kind"]],
    ["OrganizationReferenceV3", "organization", ["properties", "relationships", "items", "properties", "subject_ref"]],
    ["OrganizationParticipantV3", "organization", ["properties", "participants", "items"]],
    ["OrganizationLineV3", "organization", ["properties", "lines", "items"]],
    ["OrganizationTeamV3", "organization", ["properties", "teams", "items"]],
    ["OrganizationMembershipV3", "organization", ["properties", "memberships", "items"]],
    ["OrganizationRelationshipV3", "organization", ["properties", "relationships", "items"]],
    ["OrganizationPolicyV3", "organization", ["properties", "policy"]],
    ["OrganizationStateV3", "organization", []],
    ["FormationReferenceKind", "formation", ["properties", "formations", "items", "properties", "scope_ref", "properties", "kind"]],
    ["FormationReferenceV3", "formation", ["properties", "formations", "items", "properties", "scope_ref"]],
    ["FormationV3", "formation", ["properties", "formations", "items"]],
    ["FormationState", "formation", []],
    ["PlacementIntent", "placement", []],
    ["PlacementTaskV3", "placementTaskState", ["properties", "tasks", "items"]],
    ["PlacementTaskStateV3", "placementTaskState", []],
    ["OrganizationAgentPlacementPersistentV1", "agentPlacementPersistent", []],
    ["SessionBindingHandoffStatus", "sessionBinding", ["properties", "sessions", "items", "properties", "handoff_status"]],
    ["SessionBindingRotationState", "sessionBinding", ["properties", "sessions", "items", "properties", "rotation_state"]],
    ["SessionBindingOwnershipStatus", "sessionBinding", ["properties", "sessions", "items", "properties", "ownership_status"]],
    ["SessionBindingStatus", "sessionBinding", ["properties", "sessions", "items", "properties", "binding_status"]],
    ["SessionBindingVisibility", "sessionBinding", ["properties", "sessions", "items", "properties", "visibility"]],
    ["SessionBindingV1", "sessionBinding", ["properties", "sessions", "items"]],
    ["SessionBindingStateV1", "sessionBinding", []]
  ];
  const body = definitions.map(([name, schemaKey, segments]) => (
    `export type ${name} = ${schemaType(at(schemas[schemaKey], segments))};`
  ));
  body.push(
    "export type OrganizationV3Bundle = {",
    "  agentRegistry: AgentRegistryV3;",
    "  organization: OrganizationStateV3;",
    "  formations: FormationState;",
    "};",
    "export type OrganizationV3ContractMap = {",
    '  "agent-registry-v3": AgentRegistryV3;',
    '  "organization-state-v3": OrganizationStateV3;',
    '  "formation-state": FormationState;',
    '  "organization-agent-placement-persistent-v1": OrganizationAgentPlacementPersistentV1;',
    '  "placement-intent": PlacementIntent;',
    '  "placement-task-state-v3": PlacementTaskStateV3;',
    "};",
    "export type SessionBindingContractMap = {",
    '  "session-binding-state-v1": SessionBindingStateV1;',
    "};",
    "export type CanonicalContractMap = OrganizationV3ContractMap & SessionBindingContractMap;",
  );
  return `// Generated by scripts/generate-organization-v3-types.mjs. Do not edit.\n// schema-bundle-sha256: ${hash}\n\n${body.join("\n\n")}\n`;
}

const generated = generate();
const placementSchemaBytes = fs.readFileSync(path.join(packageRoot, "schemas", schemaFiles.agentPlacementPersistent));
const placementInstructionBytes = fs.readFileSync(placementInstructionPath);
const operationCatalog = `${JSON.stringify({
  schema_version: 1,
  operations: [{
    operation_id: "organization.agent-placement.persistent.v1",
    version: 1,
    description: "Create one or more persistent specialist agents from an AI-normalized semantic template.",
    schema_id: "organization-agent-placement-persistent-v1",
    schema_ref: "orquesta/references/organization-agent-placement-persistent-v1.schema.json",
    instruction_ref: "orquesta/references/organization-agent-placement-persistent-v1.md",
    schema_sha256: crypto.createHash("sha256").update(placementSchemaBytes).digest("hex"),
    instruction_sha256: crypto.createHash("sha256").update(placementInstructionBytes).digest("hex")
  }]
}, null, 2)}\n`;
if (process.argv.includes("--check")) {
  const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : null;
  const distributedSchema = fs.existsSync(distributedPlacementSchemaPath)
    ? fs.readFileSync(distributedPlacementSchemaPath)
    : null;
  const distributedCatalog = fs.existsSync(operationCatalogPath)
    ? fs.readFileSync(operationCatalogPath, "utf8")
    : null;
  const distributedSchemasCurrent = distributedSchemaEntries().every(({ source, distributed }) => (
    fs.existsSync(distributed) && fs.readFileSync(distributed).equals(fs.readFileSync(source))
  ));
  if (current !== generated
    || !distributedSchema?.equals(placementSchemaBytes)
    || distributedCatalog !== operationCatalog
    || !distributedSchemasCurrent) {
    console.error("Organization v3 generated contract types are stale");
    process.exitCode = 1;
  }
} else if (process.argv.includes("--print")) {
  process.stdout.write(generated);
} else {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, generated, "utf8");
  fs.mkdirSync(skillReferencesRoot, { recursive: true });
  fs.writeFileSync(distributedPlacementSchemaPath, placementSchemaBytes);
  fs.writeFileSync(operationCatalogPath, operationCatalog, "utf8");
  fs.mkdirSync(skillSchemasRoot, { recursive: true });
  for (const { source, distributed } of distributedSchemaEntries()) {
    fs.copyFileSync(source, distributed);
  }
}
