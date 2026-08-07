import assert from "node:assert/strict";
import test from "node:test";

import {
  createProfiledSpawn,
  runAppServerTask
} from "../scripts/lib/app-server-runner.mjs";

const profile = {
  mode: "plain",
  codex_home: "C:\\benchmark\\plain-home",
  environment: { CODEX_HOME: "C:\\benchmark\\plain-home" },
  app_server_args: ["--disable", "multi_agent", "app-server"],
  execution: {
    model: "gpt-5.6-sol",
    reasoning_effort: "high",
    sandbox: "workspace-write",
    approval_policy: "never",
    agent_timeout_sec: 900,
    verifier_timeout_sec: 60
  }
};

function fakeAdapter({
  createThreadResult,
  onStart,
  onInterrupt
} = {}) {
  let listener = () => {};
  const calls = [];
  const adapter = {
    calls,
    async subscribeEvents({ listener: next }) {
      listener = next;
      calls.push(["subscribeEvents"]);
      return {
        ok: true,
        subscription: { unsubscribe: () => calls.push(["unsubscribe"]) }
      };
    },
    async createThread(input) {
      calls.push(["createThread", input]);
      return createThreadResult || {
        ok: true,
        thread_id: "thread-1",
        applied_model: "gpt-5.6-sol",
        runtime_profile: {
          cwd: "C:\\benchmark\\workspace",
          sandbox: "workspace-write",
          approval_policy: "never",
          requested_web_search_mode: null
        }
      };
    },
    async startTurn(input) {
      calls.push(["startTurn", input]);
      queueMicrotask(() => onStart?.({ input, emit: listener }));
      return {
        ok: true,
        thread_id: "thread-1",
        turn_id: "turn-1"
      };
    },
    async interruptTurn(input) {
      calls.push(["interruptTurn", input]);
      queueMicrotask(() => onInterrupt?.({ input, emit: listener }));
      return {
        ok: true,
        thread_id: input.threadId,
        turn_id: input.turnId
      };
    },
    async readThread(input) {
      calls.push(["readThread", input]);
      return {
        ok: true,
        thread_id: input.threadId,
        thread: { id: input.threadId, turns: [] }
      };
    },
    async archiveThread(input) {
      calls.push(["archiveThread", input]);
      return { ok: true, thread_id: input.threadId };
    },
    async shutdown(input) {
      calls.push(["shutdown", input]);
      return { ok: true };
    }
  };
  return adapter;
}

test("profiled spawn replaces App Server args and isolates CODEX_HOME", () => {
  const calls = [];
  const spawn = createProfiledSpawn({
    profile,
    baseEnvironment: { PATH: "fixture-path", CODEX_HOME: "wrong-home" },
    spawnImpl(executable, args, options) {
      calls.push({ executable, args, options });
      return { pid: 1 };
    }
  });

  assert.deepEqual(
    spawn("codex.exe", ["app-server"], { stdio: ["pipe", "pipe", "pipe"] }),
    { pid: 1 }
  );
  assert.deepEqual(calls[0].args, profile.app_server_args);
  assert.equal(calls[0].options.env.CODEX_HOME, profile.codex_home);
  assert.equal(calls[0].options.env.PATH, "fixture-path");
});

test("runs one App Server thread to a terminal completion", async () => {
  const adapter = fakeAdapter({
    onStart({ emit }) {
      emit({
        type: "turn_started",
        correlation_id: "benchmark-turn",
        thread_id: "thread-1",
        turn_id: "turn-1"
      });
      emit({
        type: "model_observed",
        correlation_id: "benchmark-turn",
        thread_id: "thread-1",
        turn_id: "turn-1",
        model: "gpt-5.6-sol"
      });
      emit({
        type: "turn_completed",
        correlation_id: "benchmark-turn",
        thread_id: "thread-1",
        turn_id: "turn-1",
        status: "completed"
      });
    }
  });

  const result = await runAppServerTask({
    adapter,
    profile,
    workspaceRoot: "C:\\benchmark\\workspace",
    prompt: "Create organization.json",
    timeoutMs: 1000,
    correlationPrefix: "benchmark"
  });

  assert.equal(result.status, "completed");
  assert.equal(result.thread_id, "thread-1");
  assert.equal(result.turn_id, "turn-1");
  assert.equal(result.actual_model, "gpt-5.6-sol");
  assert.equal(result.events.some((event) => event.type === "turn_completed"), true);
  const start = adapter.calls.find(([name]) => name === "startTurn")[1];
  assert.equal(start.params.effort, "high");
  assert.equal(start.input[0].text, "Create organization.json");
  assert.deepEqual(
    adapter.calls.find(([name]) => name === "archiveThread")[1].threadId,
    "thread-1"
  );
  assert.equal(adapter.calls.some(([name]) => name === "shutdown"), true);
});

test("interrupts the active turn at the deadline and records a timeout", async () => {
  const adapter = fakeAdapter({
    onInterrupt({ emit }) {
      emit({
        type: "turn_completed",
        correlation_id: "benchmark-turn",
        thread_id: "thread-1",
        turn_id: "turn-1",
        status: "interrupted"
      });
    }
  });

  const result = await runAppServerTask({
    adapter,
    profile,
    workspaceRoot: "C:\\benchmark\\workspace",
    prompt: "Never completes",
    timeoutMs: 20,
    interruptGraceMs: 1000,
    correlationPrefix: "benchmark"
  });

  assert.equal(result.status, "timeout");
  assert.equal(result.interrupt_confirmed, true);
  assert.equal(adapter.calls.filter(([name]) => name === "interruptTurn").length, 1);
});

test("stops a preflight turn as soon as its success probe passes", async () => {
  let ready = false;
  const adapter = fakeAdapter({
    onStart() {
      ready = true;
    },
    onInterrupt({ emit }) {
      emit({
        type: "turn_completed",
        correlation_id: "benchmark-turn",
        thread_id: "thread-1",
        turn_id: "turn-1",
        status: "interrupted"
      });
    }
  });

  const result = await runAppServerTask({
    adapter,
    profile,
    workspaceRoot: "C:\\benchmark\\workspace",
    prompt: "Write the probe file",
    timeoutMs: 1000,
    interruptGraceMs: 1000,
    successProbe: async () => ready,
    successProbeIntervalMs: 1,
    correlationPrefix: "benchmark"
  });

  assert.equal(result.status, "probe_completed");
  assert.equal(result.interrupt_confirmed, true);
  assert.equal(adapter.calls.filter(([name]) => name === "interruptTurn").length, 1);
});

test("classifies an unexpected approval request as infrastructure_error", async () => {
  const adapter = fakeAdapter({
    onStart({ emit }) {
      emit({
        type: "approval_requested",
        correlation_id: "benchmark-turn",
        thread_id: "thread-1",
        turn_id: "turn-1",
        request_id: "approval-1"
      });
    },
    onInterrupt({ emit }) {
      emit({
        type: "turn_completed",
        correlation_id: "benchmark-turn",
        thread_id: "thread-1",
        turn_id: "turn-1",
        status: "interrupted"
      });
    }
  });

  const result = await runAppServerTask({
    adapter,
    profile,
    workspaceRoot: "C:\\benchmark\\workspace",
    prompt: "Requests approval",
    timeoutMs: 1000,
    interruptGraceMs: 1000,
    correlationPrefix: "benchmark"
  });

  assert.equal(result.status, "infrastructure_error");
  assert.equal(result.error.code, "unexpected_approval");
  assert.equal(adapter.calls.some(([name]) => name === "interruptTurn"), true);
});

test("rejects an applied runtime profile mismatch before starting the turn", async () => {
  const adapter = fakeAdapter({
    createThreadResult: {
      ok: true,
      thread_id: "thread-1",
      applied_model: "gpt-5.6-sol",
      runtime_profile: {
        cwd: "C:\\benchmark\\workspace",
        sandbox: "read-only",
        approval_policy: "never"
      }
    }
  });

  const result = await runAppServerTask({
    adapter,
    profile,
    workspaceRoot: "C:\\benchmark\\workspace",
    prompt: "Must not start",
    timeoutMs: 1000
  });

  assert.equal(result.status, "infrastructure_error");
  assert.equal(result.error.code, "runtime_profile_mismatch");
  assert.equal(adapter.calls.some(([name]) => name === "startTurn"), false);
  assert.equal(adapter.calls.some(([name]) => name === "archiveThread"), true);
});

test("classifies App Server launch failure separately from task failure", async () => {
  const adapter = fakeAdapter({
    createThreadResult: {
      ok: false,
      status: "unavailable",
      error: { code: "runtime_unavailable", message: "missing runtime" }
    }
  });

  const result = await runAppServerTask({
    adapter,
    profile,
    workspaceRoot: "C:\\benchmark\\workspace",
    prompt: "Must not start",
    timeoutMs: 1000
  });

  assert.equal(result.status, "infrastructure_error");
  assert.equal(result.error.code, "runtime_unavailable");
  assert.equal(adapter.calls.some(([name]) => name === "archiveThread"), false);
});
