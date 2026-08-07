import assert from "node:assert/strict";
import test from "node:test";

import { auditEnvironment } from "../scripts/lib/environment-evidence.mjs";

const runtime = {
  model: "gpt-5.6-sol",
  reasoning_effort: "high",
  sandbox: "workspace-write",
  approval_policy: "never"
};

function observed(overrides = {}) {
  return {
    ...runtime,
    multi_agent: false,
    loaded_skills: [],
    loaded_plugins: [],
    mcp_servers: [],
    instruction_sources: ["system"],
    ...overrides
  };
}

test("accepts a clean plain environment", () => {
  assert.deepEqual(auditEnvironment({
    mode: "plain",
    expectedRuntime: runtime,
    observed: observed()
  }), {
    valid: true,
    status: "clean",
    violations: []
  });
});

test("rejects user skills, plugins, MCP, memory, and multi-agent in plain", () => {
  const result = auditEnvironment({
    mode: "plain",
    expectedRuntime: runtime,
    observed: observed({
      multi_agent: true,
      loaded_skills: [{ name: "brainstorming", source: "user" }],
      loaded_plugins: ["superpowers"],
      mcp_servers: ["browser"],
      instruction_sources: ["system", "user", "memory"]
    })
  });
  assert.equal(result.valid, false);
  assert.equal(result.status, "environment_contamination");
  assert.match(result.violations.join("\n"), /multi-agent/i);
  assert.match(result.violations.join("\n"), /skill/i);
  assert.match(result.violations.join("\n"), /plugin/i);
  assert.match(result.violations.join("\n"), /MCP/i);
  assert.match(result.violations.join("\n"), /instruction/i);
});

test("skills permits common skills but rejects Orquesta and multi-agent", () => {
  const clean = auditEnvironment({
    mode: "skills",
    expectedRuntime: runtime,
    observed: observed({
      loaded_skills: [{ name: "brainstorming", source: "user" }],
      loaded_plugins: ["superpowers"]
    })
  });
  assert.equal(clean.valid, true);

  const contaminated = auditEnvironment({
    mode: "skills",
    expectedRuntime: runtime,
    observed: observed({
      multi_agent: true,
      loaded_skills: [{ name: "orquesta", source: "repository" }]
    })
  });
  assert.equal(contaminated.valid, false);
  assert.match(contaminated.violations.join("\n"), /Orquesta/i);
  assert.match(contaminated.violations.join("\n"), /multi-agent/i);
});

test("orquesta requires multi-agent and the frozen repository skill", () => {
  const missing = auditEnvironment({
    mode: "orquesta",
    expectedRuntime: runtime,
    observed: observed()
  });
  assert.equal(missing.valid, false);
  assert.match(missing.violations.join("\n"), /multi-agent/i);
  assert.match(missing.violations.join("\n"), /Orquesta/i);

  const clean = auditEnvironment({
    mode: "orquesta",
    expectedRuntime: runtime,
    observed: observed({
      multi_agent: true,
      loaded_skills: [{
        name: "orquesta",
        source: "repository",
        runtime_snapshot_hash: "abc123"
      }]
    })
  });
  assert.equal(clean.valid, true);
});

test("rejects a runtime profile that differs from the shared contract", () => {
  const result = auditEnvironment({
    mode: "plain",
    expectedRuntime: runtime,
    observed: observed({ reasoning_effort: "medium" })
  });
  assert.equal(result.valid, false);
  assert.match(result.violations.join("\n"), /reasoning_effort/i);
});
