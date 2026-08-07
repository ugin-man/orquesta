"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { assertContract } = require("@orquesta/contracts");
const {
  buildSourceCatalogV2,
  compileContextPackV2Shadow,
  createContextReceiptV2,
  createProjectControlPlaneV2,
  createTaskEnvelopeV2,
  deriveContextRequirementV2,
} = require("../src");

const NOW = "2026-07-31T00:00:00.000Z";

function taskIntent(overrides = {}) {
  return {
    task_intent_id: "TI-context-v2",
    raw_request_ref: "test:context-v2",
    desired_outcome: "Implement a bounded context router.",
    acceptance_criteria: [
      "Read packages/example/src/router.js and preserve its public API.",
      "Run tests/router.test.js.",
    ],
    constraints: ["Do not load unrelated project history."],
    risk: { impact: "medium", reversible: true },
    authority_boundary: { agent_may: ["write", "test"], user_only: ["publish"] },
    assumptions: [],
    status: "approved",
    ...overrides,
  };
}

function capabilityProfile(agentId = "worldbuilding-001") {
  return {
    agent_id: agentId,
    capabilities: [{
      capability_id: "context.route",
      status: "verified",
      evidence_refs: ["test:context-v2"],
      scope: ["packages/example"],
    }],
    availability: "available",
    organization_revision: 1,
  };
}

function sourceRecord({
  ref,
  body,
  criteria = [],
  domains = ["context.routing"],
  artifactTypes = ["source_code"],
  status = "current",
  freshness = "current",
}) {
  const sourceHash = crypto.createHash("sha256").update(body).digest("hex");
  return {
    schema_version: 2,
    source_id: `SRC-${crypto.createHash("sha256").update(`${ref}:${sourceHash}`).digest("hex").slice(0, 12)}`,
    source_ref: ref,
    source_hash: sourceHash,
    source_type: ref.includes("test") ? "test" : "project_file",
    authority: "workspace",
    freshness,
    knowledge_domains: domains,
    artifact_types: artifactTypes,
    supports_criteria: criteria,
    token_estimate: Math.ceil(Buffer.byteLength(body) / 4),
    content_mode: "reference",
    summary: null,
    status,
  };
}

test("TaskEnvelope and ContextRequirement are deterministic and do not depend on role names", () => {
  const intent = taskIntent();
  const firstEnvelope = createTaskEnvelopeV2({
    taskIntent: intent,
    options: {
      parent_goal_id: "PROJECT-context-router",
      workstream_id: "context-router-v2",
      local_deliverable: "Compile the V2 shadow pack.",
      execution_channel: "product_implementation",
      conversation_history_policy: "existing_delta",
    },
  });
  const secondEnvelope = createTaskEnvelopeV2({
    taskIntent: intent,
    options: {
      parent_goal_id: "PROJECT-context-router",
      workstream_id: "context-router-v2",
      local_deliverable: "Compile the V2 shadow pack.",
      execution_channel: "product_implementation",
      conversation_history_policy: "existing_delta",
    },
  });
  assert.deepEqual(firstEnvelope, secondEnvelope);
  assert.equal(firstEnvelope.continue_policy, "continue_until_terminal");
  assert.equal(firstEnvelope.checkpoint_policy, "non_blocking");
  assert.equal(firstEnvelope.notification_policy.silent_progress, true);
  assert.doesNotThrow(() => assertContract("task-envelope", firstEnvelope));

  const requirement = deriveContextRequirementV2({
    taskIntent: intent,
    taskEnvelope: firstEnvelope,
    workItem: {
      scope_boundaries: ["packages/example/src/router.js"],
      knowledge_domains: ["context.routing"],
      artifact_types: ["source_code", "test"],
      context_manifest: {
        required_reading: ["packages/example/src/router.js", "tests/router.test.js"],
        excluded_context: ["docs/old-plan.md"],
      },
    },
    capabilityNeeds: [{ kind: "code" }],
  });
  assert.equal(requirement.project_scope, "local");
  assert.deepEqual(requirement.knowledge_domains, ["capability.code", "context.routing"]);
  assert.ok(requirement.must_include.includes("packages/example/src/router.js"));
  assert.ok(requirement.must_exclude.includes("docs/old-plan.md"));
  assert.equal(JSON.stringify(requirement).includes("worldbuilding-001"), false);
  assert.doesNotThrow(() => assertContract("context-requirement", requirement));
});

test("Source Catalog reads only bounded references and records missing sources without scanning the repository", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-context-v2-"));
  try {
    fs.mkdirSync(path.join(root, "packages/example/src"), { recursive: true });
    fs.mkdirSync(path.join(root, "tests"), { recursive: true });
    fs.mkdirSync(path.join(root, "docs"), { recursive: true });
    fs.writeFileSync(path.join(root, "packages/example/src/router.js"), "module.exports = {};\n", "utf8");
    fs.writeFileSync(path.join(root, "tests/router.test.js"), "test('router', () => {});\n", "utf8");
    fs.writeFileSync(path.join(root, "docs/unrelated.md"), "must not be catalogued\n", "utf8");

    const intent = taskIntent();
    const envelope = createTaskEnvelopeV2({ taskIntent: intent });
    const requirement = deriveContextRequirementV2({
      taskIntent: intent,
      taskEnvelope: envelope,
      workItem: {
        scope_boundaries: ["packages/example"],
        context_manifest: {
          required_reading: [
            "packages/example/src/router.js",
            "tests/router.test.js",
            "docs/missing.md",
          ],
        },
      },
    });
    const catalog = buildSourceCatalogV2({
      workspaceRoot: root,
      taskIntent: intent,
      taskEnvelope: envelope,
      contextRequirement: requirement,
    });
    assert.ok(catalog.some((source) => source.source_ref === "packages/example/src/router.js" && source.status === "current"));
    assert.ok(catalog.some((source) => source.source_ref === "tests/router.test.js" && source.status === "current"));
    assert.ok(catalog.some((source) => source.source_ref === "docs/missing.md" && source.status === "missing"));
    assert.equal(catalog.some((source) => source.source_ref === "docs/unrelated.md"), false);
    for (const source of catalog) assert.doesNotThrow(() => assertContract("source-record", source));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("bounded candidate files do not inherit task domains and enter the initial pack accidentally", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-context-candidate-"));
  try {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src/optional.js"), "export const optional = true;\n", "utf8");
    const intent = taskIntent({
      acceptance_criteria: ["Produce a bounded implementation result."],
    });
    const envelope = createTaskEnvelopeV2({ taskIntent: intent });
    const requirement = deriveContextRequirementV2({
      taskIntent: intent,
      taskEnvelope: envelope,
      workItem: {
        knowledge_domains: ["unknown.specialty"],
        context_manifest: { required_reading: [] },
      },
    });
    const catalog = buildSourceCatalogV2({
      workspaceRoot: root,
      taskIntent: intent,
      taskEnvelope: envelope,
      contextRequirement: requirement,
      sourceRefs: ["src/optional.js"],
    });
    const optional = catalog.find((record) => record.source_ref === "src/optional.js");
    assert.deepEqual(optional.knowledge_domains, []);
    const compiled = compileContextPackV2Shadow({
      taskIntent: intent,
      taskEnvelope: envelope,
      contextRequirement: requirement,
      agentCapabilityProfile: capabilityProfile("unknown-specialist-001"),
      sourceCatalog: catalog,
    });
    assert.equal(compiled.context_pack.selected_sources.includes(optional.source_id), false);
    assert.ok(compiled.context_pack.omitted_context.some((entry) => (
      entry.source_id === optional.source_id && entry.reason === "low_relevance"
    )));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("shadow compiler honors must-include, exclusions, deduplication, coverage, and token budget", () => {
  const intent = taskIntent();
  const envelope = createTaskEnvelopeV2({ taskIntent: intent });
  const baseRequirement = deriveContextRequirementV2({
    taskIntent: intent,
    taskEnvelope: envelope,
    workItem: {
      project_scope: "local",
      knowledge_domains: ["context.routing"],
      artifact_types: ["source_code", "test"],
      initial_token_budget: 20,
      expansion_budget: 100,
    },
  });
  const router = sourceRecord({
    ref: "packages/example/src/router.js",
    body: "export const router = true;\n",
    criteria: ["acceptance:1"],
  });
  const duplicate = {
    ...router,
    source_id: `SRC-${"d".repeat(12)}`,
    source_ref: "packages/example/src/router-copy.js",
  };
  const testSource = sourceRecord({
    ref: "tests/router.test.js",
    body: "test('router', () => {});\n",
    criteria: ["acceptance:2"],
    artifactTypes: ["test"],
  });
  const excluded = sourceRecord({
    ref: "docs/private.md",
    body: "private context\n",
  });
  const requirement = {
    ...baseRequirement,
    must_include: [...baseRequirement.must_include, router.source_ref].sort(),
    must_exclude: [...baseRequirement.must_exclude, excluded.source_ref].sort(),
  };
  requirement.requirement_id = `CR-${crypto.createHash("sha256").update(JSON.stringify({
    ...requirement,
    requirement_id: undefined,
  })).digest("hex").slice(0, 12)}`;
  assert.doesNotThrow(() => assertContract("context-requirement", requirement));

  const catalog = buildSourceCatalogV2({
    taskIntent: intent,
    taskEnvelope: envelope,
    contextRequirement: requirement,
    sourceRecords: [router, duplicate, testSource, excluded],
  });
  const result = compileContextPackV2Shadow({
    taskIntent: intent,
    taskEnvelope: envelope,
    contextRequirement: requirement,
    agentCapabilityProfile: capabilityProfile(),
    sourceCatalog: catalog,
  });
  assert.doesNotThrow(() => assertContract("context-pack-v2", result.context_pack));
  assert.equal(result.context_pack.status, "shadow");
  assert.ok(result.context_pack.selected_sources.includes(router.source_id));
  assert.equal(result.context_pack.selected_sources.includes(excluded.source_id), false);
  assert.ok(result.context_pack.omitted_context.some((entry) => entry.reason === "duplicate"));
  assert.equal(result.context_pack.coverage_matrix[0].status, "covered");
  assert.ok(["covered", "partial", "uncovered"].includes(result.context_pack.coverage_matrix[1].status));
  assert.ok(result.context_pack.budget_receipt.selected_tokens >= router.token_estimate);
});

test("Context Receipt and Project Control Plane preserve compact operational evidence", () => {
  const intent = taskIntent();
  const envelope = createTaskEnvelopeV2({ taskIntent: intent });
  const requirement = deriveContextRequirementV2({
    taskIntent: intent,
    taskEnvelope: envelope,
  });
  const source = sourceRecord({
    ref: "packages/example/src/router.js",
    body: "module.exports = {};\n",
    criteria: ["acceptance:1"],
    artifactTypes: ["task_intent"],
  });
  const pack = compileContextPackV2Shadow({
    taskIntent: intent,
    taskEnvelope: envelope,
    contextRequirement: requirement,
    agentCapabilityProfile: capabilityProfile("implementation-001"),
    sourceCatalog: buildSourceCatalogV2({
      taskIntent: intent,
      taskEnvelope: envelope,
      contextRequirement: requirement,
      sourceRecords: [source],
    }),
  }).context_pack;
  const receipt = createContextReceiptV2({
    contextPack: pack,
    agentId: "implementation-001",
    usedSourceIds: pack.selected_sources.slice(0, 1),
    additionalTokens: 50,
    missingContext: ["accepted design decision"],
    acceptanceResults: [{
      criterion_id: "acceptance:1",
      status: "passed",
      evidence_refs: ["test:router"],
    }],
    createdAt: NOW,
  });
  assert.doesNotThrow(() => assertContract("context-receipt", receipt));
  assert.equal(receipt.used_source_ids.length + receipt.unused_source_ids.length, pack.selected_sources.length);

  const plane = createProjectControlPlaneV2({
    projectId: "orquesta",
    revision: 2,
    activeWorkstream: {
      workstream_id: "context-router-v2",
      task_id: intent.task_intent_id,
      current_goal: intent.desired_outcome,
      next_decision: "Compare V1 and V2 shadow inputs.",
    },
    projectBrief: { goal: intent.desired_outcome },
    backgroundWorkstreams: [{
      workstream_id: "desktop",
      state: "standby",
      summary: "Unrelated Desktop work remains outside the active context.",
    }],
    updatedAt: NOW,
  });
  assert.doesNotThrow(() => assertContract("project-control-plane", plane));
  assert.equal(plane.active_workstream.workstream_id, "context-router-v2");
});
