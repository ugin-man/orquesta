import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPreflightReady,
  runPreflightMatrix
} from "../scripts/preflight.mjs";

test("probes exactly the three conditions with one shared runtime contract", async () => {
  const calls = [];
  const result = await runPreflightMatrix({
    execution: {
      model: "gpt-5.6-sol",
      reasoning_effort: "high",
      sandbox: "workspace-write",
      approval_policy: "never"
    },
    async probe({ mode, execution }) {
      calls.push(mode);
      return {
        mode,
        valid: true,
        observed: { ...execution },
        process_id: `process-${mode}`,
        write_probe: "passed"
      };
    }
  });

  assert.deepEqual(calls, ["plain", "skills", "orquesta"]);
  assert.equal(result.valid, true);
  assert.equal(new Set(result.conditions.map(({ process_id }) => process_id)).size, 3);
  assert.doesNotThrow(() => assertPreflightReady(result));
});

test("fails the whole gate when one condition cannot apply the shared sandbox", async () => {
  const result = await runPreflightMatrix({
    execution: {
      model: "gpt-5.6-sol",
      reasoning_effort: "high",
      sandbox: "workspace-write",
      approval_policy: "never"
    },
    async probe({ mode, execution }) {
      return {
        mode,
        valid: mode !== "skills",
        observed: {
          ...execution,
          sandbox: mode === "skills" ? "read-only" : execution.sandbox
        },
        process_id: `process-${mode}`,
        write_probe: mode === "skills" ? "failed" : "passed"
      };
    }
  });

  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /skills/i);
  assert.throws(() => assertPreflightReady(result), /preflight/i);
});

test("rejects reused App Server process evidence", async () => {
  const result = await runPreflightMatrix({
    execution: {
      model: "gpt-5.6-sol",
      reasoning_effort: "high",
      sandbox: "workspace-write",
      approval_policy: "never"
    },
    async probe({ mode, execution }) {
      return {
        mode,
        valid: true,
        observed: execution,
        process_id: "same-process",
        write_probe: "passed"
      };
    }
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /independent App Server/i);
});
