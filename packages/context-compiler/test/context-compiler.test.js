"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { assertContract, canonicalHash } = require("@orquesta/contracts");
const { compileContextPackV1, loadAgentContract } = require("../src");

function removeTree(root) {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) removeTree(target);
    else fs.unlinkSync(target);
  }
  fs.rmdirSync(root);
}

function writeFile(root, reference, body = reference) {
  const target = path.join(root, reference);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body, "utf8");
  return target;
}

function taskIntent(overrides = {}) {
  return {
    task_intent_id: "TI-context-001",
    raw_request_ref: "request:context-fixture",
    desired_outcome: "Compile a minimal deterministic context pack.",
    acceptance_criteria: ["Read interfaces/api.js and test tests/api.test.js."],
    constraints: [],
    risk: { impact: "medium", reversible: true },
    authority_boundary: { agent_may: ["compile"], user_only: ["approve"] },
    assumptions: [],
    status: "approved",
    ...overrides,
  };
}

function resolution(overrides = {}) {
  return {
    resolution_id: "RES-context-001",
    need_id: "CN-context-001",
    mode: "reuse",
    status: "approved",
    selected_provider_id: "provider-local",
    rejected_provider_ids: [],
    rationale: "Use the bounded local evidence.",
    evidence_refs: ["workspace:providers/selected.js", "evidence/decision.md", "excluded/private.md"],
    total_cost: 0,
    approval_status: "approved",
    reevaluate_when: [],
    ...overrides,
  };
}

function agentFixture(overrides = {}) {
  return {
    agent_id: "implementation-001",
    required_reading: [
      { source_ref: "baseline/task-owned.md", tags: ["task-owned"] },
      { source_ref: "excluded/private.md", tags: ["task-owned"] },
      "docs/irrelevant-specialist.md",
    ],
    allowed_files: ["baseline/**", "interfaces/**", "tests/**"],
    forbidden_actions: ["network", "intent_graph"],
    excluded_context: ["excluded/private.md"],
    ...overrides,
  };
}

function fixtureRoot(contract = agentFixture()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-context-compiler-"));
  writeFile(root, "providers/selected.js", "module.exports = 'selected';\n");
  writeFile(root, "evidence/decision.md", "approved evidence\n");
  writeFile(root, "interfaces/api.js", "module.exports = {};\n");
  writeFile(root, "tests/api.test.js", "test('api', () => {});\n");
  writeFile(root, "baseline/task-owned.md", "task baseline\n");
  writeFile(root, "excluded/private.md", "do not include\n");
  writeFile(root, "docs/irrelevant-specialist.md", "whole specialist history\n");
  const agentsPath = writeFile(root, ".orquesta/state/agents.json", JSON.stringify({
    agents: [
      contract,
      { agent_id: "other-agent", private_notes: "must not enter the selected contract" },
    ],
  }, null, 2));
  return { root, agentsPath };
}

function expectCode(run, code) {
  assert.throws(run, (error) => error && error.code === code);
}

function containsOwnKey(value, key) {
  if (!value || typeof value !== "object") return false;
  if (Object.prototype.hasOwnProperty.call(value, key)) return true;
  return Object.values(value).some((entry) => containsOwnKey(entry, key));
}

function expectedContextPackId(contextPack) {
  const { context_pack_id: ignored, ...content } = contextPack;
  return `CP-${canonicalHash(content).slice(0, 12)}`;
}

test("loadAgentContract returns one named contract and records only its file provenance", () => {
  const fixture = fixtureRoot();
  try {
    const contract = loadAgentContract({ agentsPath: fixture.agentsPath, agentId: "implementation-001" });
    assert.equal(contract.agent_id, "implementation-001");
    assert.equal(JSON.stringify(contract).includes("other-agent"), false);
    assert.equal(JSON.stringify(contract).includes("private_notes"), false);
    assert.equal(Object.keys(contract).includes("contract_path"), false);
    expectCode(() => loadAgentContract({ agentsPath: fixture.agentsPath, agentId: "missing" }), "CONTEXT_AGENT_NOT_FOUND");
    fs.writeFileSync(fixture.agentsPath, JSON.stringify({ agents: [agentFixture(), agentFixture()] }), "utf8");
    expectCode(() => loadAgentContract({ agentsPath: fixture.agentsPath, agentId: "implementation-001" }), "CONTEXT_AGENT_DUPLICATE");
    expectCode(() => loadAgentContract({ agentsPath: path.join(fixture.root, "missing.json"), agentId: "implementation-001" }), "CONTEXT_AGENT_FILE_INVALID");
  } finally {
    removeTree(fixture.root);
  }
});

test("compileContextPackV1 emits a deterministic schema-valid minimal pack and companion omissions", () => {
  const fixture = fixtureRoot();
  try {
    const agentContract = loadAgentContract({ agentsPath: fixture.agentsPath, agentId: "implementation-001" });
    const input = { taskIntent: taskIntent(), resolutions: [resolution()], agentContract, workspaceRoot: fixture.root };
    const first = compileContextPackV1(input);
    const second = compileContextPackV1(input);
    assert.deepEqual(first, second);
    assert.doesNotThrow(() => assertContract("context-pack", first.context_pack));
    assert.match(first.context_pack.context_pack_id, /^CP-[0-9a-f]{12}$/);
    assert.equal(first.context_pack.status, "ready");
    assert.deepEqual(first.context_pack.adopted_decisions, []);
    assert.equal(first.context_pack.token_budget, null);
    assert.deepEqual(first.context_pack.allowed_files, agentContract.allowed_files);
    assert.deepEqual(first.context_pack.forbidden_actions, agentContract.forbidden_actions);
    assert.deepEqual(first.context_pack.excluded_context, agentContract.excluded_context);
    assert.deepEqual(first.context_pack.required_reading, [
      "baseline/task-owned.md",
      "evidence/decision.md",
      "interfaces/api.js",
      "providers/selected.js",
      "tests/api.test.js",
    ]);
    assert.equal(first.context_pack.required_reading.includes("docs/irrelevant-specialist.md"), false);
    assert.equal(containsOwnKey(first, "intent_graph"), false);
    assert.deepEqual(first.omitted_context, [{ source_ref: "excluded/private.md", reason: "excluded_by_agent_contract" }]);
    assert.ok(first.context_pack.provenance.every((entry) => entry.source_ref && /^[0-9a-f]{64}$/.test(entry.source_hash)));
    const contractProvenance = first.context_pack.provenance.find((entry) => entry.kind === "agent_contract");
    assert.deepEqual(contractProvenance, {
      kind: "agent_contract",
      source_ref: ".orquesta/state/agents.json",
      source_hash: crypto.createHash("sha256").update(fs.readFileSync(fixture.agentsPath)).digest("hex"),
      target_agent_id: "implementation-001",
    });
    assert.ok(first.context_pack.provenance.some((entry) => entry.kind === "resolution_evidence" && entry.source_ref === "providers/selected.js"));
  } finally {
    removeTree(fixture.root);
  }
});

test("compileContextPackV1 canonicalizes workspace evidence files without treating fragments as filenames", () => {
  const fixture = fixtureRoot();
  try {
    const agentContract = loadAgentContract({ agentsPath: fixture.agentsPath, agentId: "implementation-001" });
    const result = compileContextPackV1({
      taskIntent: taskIntent(),
      resolutions: [resolution({
        evidence_refs: [
          "workspace:providers/selected.js#provider-local",
          "providers/./selected.js",
          "sha256:deadbeef",
          "git:abc123",
        ],
      })],
      agentContract,
      workspaceRoot: fixture.root,
    });
    assert.deepEqual(result.context_pack.required_reading, [
      "baseline/task-owned.md",
      "interfaces/api.js",
      "providers/selected.js",
      "tests/api.test.js",
    ]);
    assert.equal(result.context_pack.provenance.filter((entry) => entry.kind === "resolution_evidence" && entry.source_ref === "providers/selected.js").length, 1);
    assert.equal(JSON.stringify(result).includes("#provider-local"), false);
    assert.equal(JSON.stringify(result).includes("sha256:deadbeef"), false);
    assert.equal(JSON.stringify(result).includes("git:abc123"), false);
  } finally {
    removeTree(fixture.root);
  }
});

test("compileContextPackV1 rejects explicit workspace escapes but ignores non-file evidence metadata", () => {
  const fixture = fixtureRoot();
  try {
    const agentContract = loadAgentContract({ agentsPath: fixture.agentsPath, agentId: "implementation-001" });
    for (const evidenceRef of ["workspace:/outside", "workspace:C:\\outside", path.join(fixture.root, "providers", "selected.js")]) {
      expectCode(() => compileContextPackV1({
        taskIntent: taskIntent(),
        resolutions: [resolution({ evidence_refs: [evidenceRef] })],
        agentContract,
        workspaceRoot: fixture.root,
      }), "CONTEXT_WORKSPACE_ESCAPE");
    }
    assert.doesNotThrow(() => compileContextPackV1({
      taskIntent: taskIntent(),
      resolutions: [resolution({ evidence_refs: ["sha256:deadbeef", "git:abc123"] })],
      agentContract,
      workspaceRoot: fixture.root,
    }));
  } finally {
    removeTree(fixture.root);
  }
});

test("compileContextPackV1 normalizes exclusions without changing the public agent contract", () => {
  const fixture = fixtureRoot(agentFixture({
    required_reading: [{ source_ref: "baseline/task-owned.md", tags: ["task-owned"] }],
    excluded_context: ["providers/./selected.js#private"],
  }));
  try {
    const agentContract = loadAgentContract({ agentsPath: fixture.agentsPath, agentId: "implementation-001" });
    const result = compileContextPackV1({
      taskIntent: taskIntent(),
      resolutions: [resolution({ evidence_refs: ["providers/selected.js"] })],
      agentContract,
      workspaceRoot: fixture.root,
    });
    assert.deepEqual(result.context_pack.excluded_context, ["providers/./selected.js#private"]);
    assert.equal(result.context_pack.required_reading.includes("providers/selected.js"), false);
    assert.deepEqual(result.omitted_context, [{ source_ref: "providers/selected.js", reason: "excluded_by_agent_contract" }]);
  } finally {
    removeTree(fixture.root);
  }
});

test("compileContextPackV1 previews proposed resolutions and rejects explicit expired evidence deterministically", () => {
  const fixture = fixtureRoot();
  try {
    const agentContract = loadAgentContract({ agentsPath: fixture.agentsPath, agentId: "implementation-001" });
    const preview = compileContextPackV1({
      taskIntent: taskIntent(),
      resolutions: [resolution({ status: "proposed", approval_status: "pending_user" })],
      agentContract,
      workspaceRoot: fixture.root,
    });
    assert.equal(preview.context_pack.status, "draft");

    expectCode(() => compileContextPackV1({
      taskIntent: taskIntent(),
      resolutions: [resolution({
        reevaluate_when: [{ type: "evidence_expiry", expires_at: "2026-07-15T00:00:00.000Z" }],
      })],
      agentContract,
      workspaceRoot: fixture.root,
      referenceTime: "2026-07-15T00:00:01.000Z",
    }), "CONTEXT_INPUT_EXPIRED");
    expectCode(() => compileContextPackV1({
      taskIntent: taskIntent(),
      resolutions: [resolution({
        reevaluate_when: [{ type: "evidence_expiry", expires_at: "2026-07-15T00:00:00.000Z" }],
      })],
      agentContract,
      workspaceRoot: fixture.root,
      referenceTime: "2026-07-15T00:00:00.000Z",
    }), "CONTEXT_INPUT_EXPIRED");
    expectCode(() => compileContextPackV1({
      taskIntent: taskIntent(),
      resolutions: [],
      agentContract,
      workspaceRoot: fixture.root,
    }), "CONTEXT_RESOLUTION_REQUIRED");
    expectCode(() => compileContextPackV1({
      taskIntent: taskIntent(),
      resolutions: [resolution({
        reevaluate_when: [{ type: "evidence_expiry", expires_at: "2026-99-99T00:00:00.000Z" }],
      })],
      agentContract,
      workspaceRoot: fixture.root,
      referenceTime: "2026-07-15T00:00:01.000Z",
    }), "CONTEXT_INPUT_INVALID");
    expectCode(() => compileContextPackV1({
      taskIntent: taskIntent({ status: "superseded" }),
      resolutions: [resolution()],
      agentContract,
      workspaceRoot: fixture.root,
    }), "CONTEXT_INPUT_STALE");
    for (const status of ["changes_requested", "rejected"]) {
      expectCode(() => compileContextPackV1({
        taskIntent: taskIntent(),
        resolutions: [resolution({ status })],
        agentContract,
        workspaceRoot: fixture.root,
      }), "CONTEXT_RESOLUTION_STATUS_INVALID");
    }
    expectCode(() => compileContextPackV1({
      taskIntent: taskIntent(),
      resolutions: [resolution(), resolution({ need_id: "CN-context-002" })],
      agentContract,
      workspaceRoot: fixture.root,
    }), "CONTEXT_RESOLUTION_DUPLICATE");
  } finally {
    removeTree(fixture.root);
  }
});

test("compileContextPackV1 rejects an agent contract symlink that resolves outside its workspace", () => {
  const fixture = fixtureRoot();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-context-agent-outside-"));
  try {
    const outsideAgents = writeFile(outside, "agents.json", fs.readFileSync(fixture.agentsPath, "utf8"));
    const linkedAgents = path.join(fixture.root, "linked-agents.json");
    fs.symlinkSync(outsideAgents, linkedAgents, "file");
    const agentContract = loadAgentContract({ agentsPath: linkedAgents, agentId: "implementation-001" });
    expectCode(() => compileContextPackV1({
      taskIntent: taskIntent(),
      resolutions: [resolution()],
      agentContract,
      workspaceRoot: fixture.root,
    }), "CONTEXT_WORKSPACE_ESCAPE");
  } finally {
    removeTree(fixture.root);
    removeTree(outside);
  }
});

test("compileContextPackV1 rejects unsafe references and task-owned writes before a pack is emitted", () => {
  const fixture = fixtureRoot();
  const restrictedContract = agentFixture({
    required_reading: [{ source_ref: "providers/selected.js", tags: ["task-owned"] }],
    allowed_files: ["baseline/**"],
  });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-context-outside-"));
  try {
    const agentContract = loadAgentContract({ agentsPath: fixture.agentsPath, agentId: "implementation-001" });
    expectCode(() => compileContextPackV1({
      taskIntent: taskIntent({ acceptance_criteria: ["Read ../outside.js."] }),
      resolutions: [resolution()],
      agentContract,
      workspaceRoot: fixture.root,
    }), "CONTEXT_WORKSPACE_ESCAPE");
    expectCode(() => compileContextPackV1({
      taskIntent: taskIntent({ acceptance_criteria: ["Read interfaces/missing.js."] }),
      resolutions: [resolution()],
      agentContract,
      workspaceRoot: fixture.root,
    }), "CONTEXT_FILE_MISSING");
    expectCode(() => compileContextPackV1({
      taskIntent: taskIntent(),
      resolutions: [resolution({ evidence_refs: ["interfaces"] })],
      agentContract,
      workspaceRoot: fixture.root,
    }), "CONTEXT_FILE_NOT_REGULAR");
    const restrictedAgentsPath = writeFile(fixture.root, ".orquesta/state/restricted-agents.json", JSON.stringify({ agents: [restrictedContract] }));
    const outsideContract = loadAgentContract({ agentsPath: restrictedAgentsPath, agentId: "implementation-001" });
    expectCode(() => compileContextPackV1({
      taskIntent: taskIntent(),
      resolutions: [resolution()],
      agentContract: outsideContract,
      workspaceRoot: fixture.root,
    }), "CONTEXT_TASK_WRITE_OUTSIDE_ALLOWED_FILES");

    writeFile(outside, "outside.js", "module.exports = 'outside';\n");
    fs.symlinkSync(path.join(outside, "outside.js"), path.join(fixture.root, "providers", "escape.js"), "file");
    expectCode(() => compileContextPackV1({
      taskIntent: taskIntent(),
      resolutions: [resolution({ evidence_refs: ["providers/escape.js"] })],
      agentContract: loadAgentContract({ agentsPath: fixture.agentsPath, agentId: "implementation-001" }),
      workspaceRoot: fixture.root,
    }), "CONTEXT_WORKSPACE_ESCAPE");
  } finally {
    removeTree(fixture.root);
    removeTree(outside);
  }
});

test("compileContextPackV1 applies the approval truth matrix before marking a pack ready", () => {
  const fixture = fixtureRoot();
  try {
    const agentContract = loadAgentContract({ agentsPath: fixture.agentsPath, agentId: "implementation-001" });
    for (const status of ["draft", "compiled"]) {
      const result = compileContextPackV1({
        taskIntent: taskIntent({ status }),
        resolutions: [resolution()],
        agentContract,
        workspaceRoot: fixture.root,
      });
      assert.equal(result.context_pack.status, "draft");
    }
    const preview = compileContextPackV1({
      taskIntent: taskIntent({ status: "approved" }),
      resolutions: [resolution({ status: "proposed", approval_status: "pending_user" })],
      agentContract,
      workspaceRoot: fixture.root,
    });
    assert.equal(preview.context_pack.status, "draft");
    const ready = compileContextPackV1({
      taskIntent: taskIntent({ status: "approved" }),
      resolutions: [resolution({ status: "approved", approval_status: "approved" })],
      agentContract,
      workspaceRoot: fixture.root,
    });
    assert.equal(ready.context_pack.status, "ready");
  } finally {
    removeTree(fixture.root);
  }
});

test("compileContextPackV1 rejects contradictory Resolution approval evidence", () => {
  const fixture = fixtureRoot();
  try {
    const agentContract = loadAgentContract({ agentsPath: fixture.agentsPath, agentId: "implementation-001" });
    for (const [status, approvalStatus] of [
      ["approved", "pending_user"],
      ["approved", "not_required"],
      ["proposed", "approved"],
      ["proposed", "not_required"],
    ]) {
      expectCode(() => compileContextPackV1({
        taskIntent: taskIntent({ status: "approved" }),
        resolutions: [resolution({ status, approval_status: approvalStatus })],
        agentContract,
        workspaceRoot: fixture.root,
      }), "CONTEXT_RESOLUTION_APPROVAL_CONTRADICTION");
    }
  } finally {
    removeTree(fixture.root);
  }
});

test("compileContextPackV1 includes only explicit canonical interface and test acceptance references", () => {
  const fixture = fixtureRoot(agentFixture({
    required_reading: [{ source_ref: "baseline/task-owned.md", tags: ["task-owned"] }],
    excluded_context: ["interfaces/./private.js#private"],
  }));
  try {
    writeFile(fixture.root, "interfaces/private.js", "module.exports = 'private';\n");
    writeFile(fixture.root, "docs/irrelevant-specialist.md", "not an interface\n");
    const agentContract = loadAgentContract({ agentsPath: fixture.agentsPath, agentId: "implementation-001" });
    const result = compileContextPackV1({
      taskIntent: taskIntent({
        acceptance_criteria: [
          "Read interfaces/api.js and test tests/api.test.js.",
          "Review interfaces/./api.js#alias and verify tests\\api.test.js.",
          "Read interfaces/./private.js.",
          "Do not read docs/irrelevant-specialist.md.",
          "Mention interfaces/private.js without a reading requirement.",
        ],
      }),
      resolutions: [resolution({ evidence_refs: [] })],
      agentContract,
      workspaceRoot: fixture.root,
    });
    assert.deepEqual(result.context_pack.required_reading, [
      "baseline/task-owned.md",
      "interfaces/api.js",
      "tests/api.test.js",
    ]);
    assert.deepEqual(result.context_pack.interfaces, ["interfaces/api.js"]);
    assert.deepEqual(result.omitted_context, [{ source_ref: "interfaces/private.js", reason: "excluded_by_agent_contract" }]);
    assert.equal(result.context_pack.provenance.filter((entry) => entry.kind === "acceptance_file" && entry.source_ref === "interfaces/api.js").length, 1);
    assert.equal(result.context_pack.required_reading.includes("docs/irrelevant-specialist.md"), false);
    assert.equal(result.context_pack.interfaces.includes("interfaces/private.js"), false);
    assert.equal(result.context_pack.provenance.some((entry) => entry.source_ref === "interfaces/private.js"), false);

    for (const sourceRef of ["C:\\outside\\test.js", "\\\\server\\share\\test.js"]) {
      expectCode(() => compileContextPackV1({
        taskIntent: taskIntent({ acceptance_criteria: [`Read ${sourceRef}.`] }),
        resolutions: [resolution({ evidence_refs: [] })],
        agentContract,
        workspaceRoot: fixture.root,
      }), "CONTEXT_WORKSPACE_ESCAPE");
    }
  } finally {
    removeTree(fixture.root);
  }
});

test("compileContextPackV1 ignores acceptance references in a negated clause", () => {
  const fixture = fixtureRoot(agentFixture({
    required_reading: [{ source_ref: "baseline/task-owned.md", tags: ["task-owned"] }],
    excluded_context: [],
  }));
  try {
    writeFile(fixture.root, "interfaces/private.js", "module.exports = 'private';\n");
    const agentContract = loadAgentContract({ agentsPath: fixture.agentsPath, agentId: "implementation-001" });
    const result = compileContextPackV1({
      taskIntent: taskIntent({ acceptance_criteria: ["Verify tests/api.test.js; do not read interfaces/private.js."] }),
      resolutions: [resolution({ evidence_refs: [] })],
      agentContract,
      workspaceRoot: fixture.root,
    });
    assert.deepEqual(result.context_pack.required_reading, ["baseline/task-owned.md", "tests/api.test.js"]);
    assert.deepEqual(result.context_pack.interfaces, []);
    assert.equal(result.context_pack.provenance.some((entry) => entry.source_ref === "interfaces/private.js"), false);
  } finally {
    removeTree(fixture.root);
  }
});

test("loadAgentContract returns an immutable detached snapshot tied to its selected provenance", () => {
  const fixture = fixtureRoot();
  try {
    const agentContract = loadAgentContract({ agentsPath: fixture.agentsPath, agentId: "implementation-001" });
    assert.throws(() => { agentContract.agent_id = "other-agent"; }, TypeError);
    assert.throws(() => { agentContract.allowed_files.push("**"); }, TypeError);
    assert.throws(() => { agentContract.forbidden_actions.push("shell"); }, TypeError);
    assert.throws(() => { agentContract.excluded_context.push("private.md"); }, TypeError);
    assert.throws(() => { agentContract.required_reading[0].source_ref = "docs/changed.md"; }, TypeError);
    const result = compileContextPackV1({
      taskIntent: taskIntent(),
      resolutions: [resolution()],
      agentContract,
      workspaceRoot: fixture.root,
    });
    assert.equal(result.context_pack.owner_agent_id, "implementation-001");
    assert.equal(result.context_pack.provenance.find((entry) => entry.kind === "agent_contract").target_agent_id, "implementation-001");
  } finally {
    removeTree(fixture.root);
  }
});

test("compileContextPackV1 detaches inputs and returns a deeply immutable identity-stable result", () => {
  const fixture = fixtureRoot();
  try {
    const inputIntent = taskIntent();
    const inputResolution = resolution();
    const agentContract = loadAgentContract({ agentsPath: fixture.agentsPath, agentId: "implementation-001" });
    const result = compileContextPackV1({
      taskIntent: inputIntent,
      resolutions: [inputResolution],
      agentContract,
      workspaceRoot: fixture.root,
    });
    const before = JSON.parse(JSON.stringify(result));
    inputIntent.acceptance_criteria.push("Read interfaces/private.js.");
    inputResolution.evidence_refs.push("interfaces/private.js");
    assert.deepEqual(result, before);
    assert.throws(() => { result.context_pack.acceptance_criteria.push("Read other.js."); }, TypeError);
    assert.throws(() => { result.context_pack.provenance[0].source_ref = "changed"; }, TypeError);
    assert.throws(() => { result.omitted_context.push({ source_ref: "other", reason: "changed" }); }, TypeError);
    assert.equal(result.context_pack.context_pack_id, expectedContextPackId(result.context_pack));
    assert.deepEqual(result, before);
  } finally {
    removeTree(fixture.root);
  }
});
