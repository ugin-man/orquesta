import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyStoredResult,
  validateManifest,
  validateRunResult
} from "../scripts/lib/contract.mjs";

const execution = {
  model: "gpt-5.6-sol",
  reasoning_effort: "high",
  sandbox: "workspace-write",
  approval_policy: "never",
  agent_timeout_sec: 900,
  verifier_timeout_sec: 60
};

const manifest = {
  schema_version: 2,
  benchmark_id: "orquesta-v4-product",
  modes: ["plain", "skills", "orquesta"],
  execution,
  tasks: [
    {
      id: "organization-json-generator",
      fixed_inputs: {
        organization_name: "Pilot Organization",
        organization_founded: "2020-01-01"
      }
    },
    {
      id: "parallel-integration"
    },
    {
      id: "conflicting-requirements-triage"
    }
  ]
};

const completeResult = {
  schema_version: 2,
  run_id: "20260730-organization-plain-001",
  matrix_id: "20260730-organization-001",
  benchmark_id: "orquesta-v4-product",
  task_id: "organization-json-generator",
  mode: "plain",
  status: "finalized",
  runtime: execution,
  started_at: "2026-07-30T00:00:00.000Z",
  ended_at: "2026-07-30T00:03:00.000Z",
  wall_time_ms: 180000,
  verifier: { status: "passed", passed: true, duration_ms: 210 },
  token_usage: {
    coverage: "complete",
    totals: {
      input_tokens: 100,
      uncached_input_tokens: 60,
      cached_input_tokens: 40,
      output_tokens: 20,
      reasoning_output_tokens: 5,
      total_tokens: 120
    },
    by_thread: [{
      thread_id: "thread-1",
      measured_tokens: 120,
      evidence_source: "codex_session_jsonl"
    }]
  },
  diagnostics: {
    participating_threads: 1,
    agent_turns: 1,
    handoffs: 0,
    independent_reviews: 0,
    correction_batches: 0,
    user_interventions: 0
  }
};

test("accepts exactly the three benchmark modes", () => {
  assert.deepEqual(validateManifest(manifest), { ok: true, errors: [] });

  for (const modes of [
    ["plain", "skills"],
    ["plain", "skills", "solo"],
    ["plain", "skills", "orquesta", "orquesta"]
  ]) {
    const invalid = structuredClone(manifest);
    invalid.modes = modes;
    const result = validateManifest(invalid);
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /modes/i);
  }
});

test("requires the fixed task inputs and one shared execution contract", () => {
  const invalid = structuredClone(manifest);
  invalid.execution.agent_timeout_sec = 360;
  invalid.tasks[0].fixed_inputs.organization_name = "";
  const result = validateManifest(invalid);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /900/);
  assert.match(result.errors.join("\n"), /organization_name/);
});

test("accepts multiple unique benchmark tasks and rejects duplicate ids", () => {
  assert.deepEqual(validateManifest(manifest), { ok: true, errors: [] });
  const invalid = structuredClone(manifest);
  invalid.tasks.push({ id: "parallel-integration" });
  const result = validateManifest(invalid);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /unique/i);
});

test("accepts a schema v2 complete run result", () => {
  assert.deepEqual(validateRunResult(completeResult, manifest), { ok: true, errors: [] });
});

test("rejects legacy solo as a new run mode", () => {
  const invalid = structuredClone(completeResult);
  invalid.mode = "solo";
  const result = validateRunResult(invalid, manifest);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /mode/i);
});

test("keeps schema v1 solo evidence as legacy_pilot without relabeling it", () => {
  const legacy = {
    schema_version: 1,
    run_id: "pilot-organization-solo-20260730-001",
    mode: "solo"
  };
  assert.deepEqual(classifyStoredResult(legacy), {
    classification: "legacy_pilot",
    original_mode: "solo",
    eligible_for_matrix: false
  });
  assert.equal(legacy.mode, "solo");
});

test("rejects runtime drift between the manifest and a run", () => {
  const invalid = structuredClone(completeResult);
  invalid.runtime.reasoning_effort = "medium";
  const result = validateRunResult(invalid, manifest);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /runtime/i);
});

test("requires complete thread evidence for complete token coverage", () => {
  const invalid = structuredClone(completeResult);
  invalid.token_usage.by_thread = [];
  const result = validateRunResult(invalid, manifest);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /complete coverage/i);
});
