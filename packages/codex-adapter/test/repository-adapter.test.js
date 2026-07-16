const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CODEX_ADAPTER_METHODS,
  createRepositoryAdapter
} = require("../src");

test("repository adapter reports repository-only capability truth", async () => {
  const adapter = createRepositoryAdapter();
  const result = await adapter.capabilities({ correlationId: "corr-capabilities" });

  assert.equal(result.ok, true);
  assert.equal(result.status, "completed");
  assert.equal(result.adapter, "repository_only");
  assert.equal(result.execution, "unsupported");
  assert.equal(result.correlation_id, "corr-capabilities");
  assert.equal(result.actual_model, null);
  assert.deepEqual(result.capabilities, Object.fromEntries(
    CODEX_ADAPTER_METHODS
      .filter((method) => method !== "capabilities")
      .map((method) => [method, false])
  ));
});

test("repository adapter returns unsupported without runtime evidence for every runtime action", async () => {
  const adapter = createRepositoryAdapter();
  const runtimeMethods = CODEX_ADAPTER_METHODS.filter(
    (method) => method !== "capabilities"
  );

  for (const method of runtimeMethods) {
    const result = await adapter[method]({ correlationId: `corr-${method}` });
    assert.equal(result.ok, false, method);
    assert.equal(result.status, "unsupported", method);
    assert.equal(result.adapter, "repository_only", method);
    assert.equal(result.correlation_id, `corr-${method}`, method);
    assert.equal(result.thread_id, null, method);
    assert.equal(result.turn_id, null, method);
    assert.equal(result.approval_id, null, method);
    assert.deepEqual(result.evidence, {
      dispatch_accepted: false,
      turn_started: false,
      actual_model: null
    }, method);
  }
});

test("repository adapter creates only an explicit detached handoff draft", () => {
  const adapter = createRepositoryAdapter();
  assert.equal(CODEX_ADAPTER_METHODS.includes("createHandoffDraft"), false);

  const input = {
    correlationId: "corr-handoff",
    taskIntentId: "TI-1",
    contextPackId: "CP-1",
    prompt: "Implement the accepted task."
  };
  const result = adapter.createHandoffDraft(input);
  input.prompt = "mutated";

  assert.deepEqual(result, {
    ok: true,
    status: "drafted",
    adapter: "repository_only",
    execution: "unsupported",
    correlation_id: "corr-handoff",
    actual_model: null,
    draft: {
      task_intent_id: "TI-1",
      context_pack_id: "CP-1",
      prompt: "Implement the accepted task."
    }
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.draft), true);
});
