import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTEXT_VARIANTS,
  contextPrompt,
} from "../scripts/lib/context-variant-canary.mjs";

test("context canary exposes four meaningfully different variants", () => {
  const prompts = Object.fromEntries(CONTEXT_VARIANTS.map((variant) => [
    variant,
    contextPrompt({
      variant,
      benchmarkPrompt: "Review the bounded sources.",
      workspaceRoot: "C:\\benchmark",
      taskId: "CTX-001",
    }),
  ]));
  assert.match(prompts.v1, /Legacy V1 context contract/);
  assert.match(prompts.v1, /legacy-project-history/);
  assert.match(prompts.fixed_minimal, /Read only the three task sources/);
  assert.doesNotMatch(prompts.fixed_minimal, /orchestration-protocol/);
  assert.match(prompts.v2_initial, /bootstrap/);
  assert.match(prompts.v2_initial, /Do not search for or expand/);
  assert.match(prompts.v2_bounded_retrieval, /expand only the smallest relevant source set/);
  assert.match(prompts.v2_bounded_retrieval, /\.agents\\skills\\orquesta\\scripts\\context-v2-broker\.js/);
});

test("context variant selection is semantic and does not accept role-specific variants", () => {
  assert.throws(() => contextPrompt({
    variant: "implementation_role",
    benchmarkPrompt: "Task",
    workspaceRoot: "C:\\benchmark",
    taskId: "CTX-001",
  }), /unsupported context variant/);
});
