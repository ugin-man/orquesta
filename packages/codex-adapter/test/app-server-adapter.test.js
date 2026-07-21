const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");

const { createAppServerAdapter } = require("../src/app-server-adapter");
const { FakeAppServerProcess } = require("./fixtures/fake-app-server");

function makeThread(id) {
  return {
    cliVersion: "0.144.5",
    createdAt: 1,
    cwd: "C:\\repo",
    ephemeral: false,
    id,
    modelProvider: "openai",
    preview: "",
    sessionId: `session-${id}`,
    source: "appServer",
    status: "idle",
    turns: [],
    updatedAt: 1
  };
}

function makeTurn(id, status = "inProgress") {
  return { id, items: [], status };
}

function bundledRuntime(executablePath = "C:\\runtime\\codex.exe") {
  return {
    sdk_package: "@openai/codex-sdk",
    sdk_version: "0.144.5",
    codex_package: "@openai/codex",
    codex_version: "0.144.5",
    runtime_package: "@openai/codex-win32-x64",
    runtime_package_version: "0.144.5-win32-x64",
    target_triple: "x86_64-pc-windows-msvc",
    executable_path: executablePath
  };
}

function attachSuccessfulServer(process) {
  process.on("clientMessage", (message) => {
    if (message.method === "initialize") {
      process.send({
        id: message.id,
        result: {
          codexHome: "C:\\codex-home",
          platformFamily: "windows",
          platformOs: "windows",
          userAgent: "codex-cli/0.144.5"
        }
      });
    } else if (message.method === "thread/start") {
      process.send({
        id: message.id,
        result: {
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          cwd: "C:\\repo",
          model: "requested-model",
          modelProvider: "openai",
          sandbox: "workspace-write",
          thread: makeThread("thread-1")
        }
      });
    } else if (message.method === "thread/resume") {
      process.send({
        id: message.id,
        result: {
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          cwd: "C:\\repo",
          model: "requested-model",
          modelProvider: "openai",
          sandbox: "workspace-write",
          thread: makeThread(message.params.threadId)
        }
      });
    } else if (message.method === "thread/read") {
      process.send({
        id: message.id,
        result: { thread: makeThread(message.params.threadId) }
      });
    } else if (message.method === "turn/start") {
      process.send({ id: message.id, result: { turn: makeTurn("turn-1") } });
    } else if (message.method === "turn/steer") {
      process.send({ id: message.id, result: { turnId: message.params.expectedTurnId } });
    } else if (message.method === "turn/interrupt") {
      process.send({ id: message.id, result: {} });
    }
  });
}

function createHarness() {
  const process = new FakeAppServerProcess();
  const spawnCalls = [];
  attachSuccessfulServer(process);
  const adapter = createAppServerAdapter({
    resolveRuntime: () => bundledRuntime(),
    spawnProcess(command, args, options) {
      spawnCalls.push({ command, args, options });
      return process;
    }
  });
  return { adapter, process, spawnCalls };
}

test("spawns App Server without a shell and initializes exactly once before thread requests", async () => {
  const { adapter, process, spawnCalls } = createHarness();
  const first = await adapter.createThread({
    correlationId: "corr-thread-1",
    params: { cwd: "C:\\repo", model: "requested-model" }
  });
  const second = await adapter.resumeThread({
    correlationId: "corr-thread-2",
    threadId: "thread-1",
    params: {}
  });

  assert.equal(first.ok, true);
  assert.equal(first.thread_id, "thread-1");
  assert.equal(first.actual_model, null);
  assert.equal(second.thread_id, "thread-1");
  assert.deepEqual(spawnCalls, [{
    command: "C:\\runtime\\codex.exe",
    args: ["app-server"],
    options: {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    }
  }]);
  assert.deepEqual(process.clientMessages.map((message) => message.method), [
    "initialize",
    "initialized",
    "thread/start",
    "thread/resume"
  ]);
});

test("forwards Luca thread profile and high turn effort without renaming parameters", async () => {
  const { adapter, process } = createHarness();
  await adapter.createThread({
    correlationId: "corr-luca-thread",
    recommendedModel: "Luna",
    requestedModel: "gpt-5.6-luna",
    params: {
      cwd: "C:\\repo",
      model: "gpt-5.6-luna",
      sandbox: "read-only",
      approvalPolicy: "never",
      developerInstructions: "You are Luca, the read-only user explainer."
    }
  });
  await adapter.startTurn({
    correlationId: "corr-luca-turn",
    threadId: "thread-1",
    input: [{ type: "text", text: "{}", text_elements: [] }],
    params: { effort: "high" }
  });

  const startedThread = process.clientMessages.find((message) => message.method === "thread/start");
  assert.deepEqual(startedThread.params, {
    cwd: "C:\\repo",
    model: "gpt-5.6-luna",
    sandbox: "read-only",
    approvalPolicy: "never",
    developerInstructions: "You are Luca, the read-only user explainer."
  });
  const startedTurn = process.clientMessages.find((message) => message.method === "turn/start");
  assert.deepEqual(startedTurn.params, {
    effort: "high",
    input: [{ type: "text", text: "{}", text_elements: [] }],
    threadId: "thread-1"
  });
});

test("returns the applied inspection runtime profile from thread start", async () => {
  const process = new FakeAppServerProcess();
  process.on("clientMessage", (message) => {
    if (message.method === "initialize") {
      process.send({
        id: message.id,
        result: {
          codexHome: "C:\\codex-home",
          platformFamily: "windows",
          platformOs: "windows",
          userAgent: "codex-cli/0.144.5"
        }
      });
    } else if (message.method === "thread/start") {
      process.send({
        id: message.id,
        result: {
          approvalPolicy: "never",
          approvalsReviewer: "user",
          cwd: "C:\\repo",
          model: "requested-model",
          modelProvider: "openai",
          sandbox: "read-only",
          thread: makeThread("thread-inspection")
        }
      });
    }
  });
  const adapter = createAppServerAdapter({
    resolveRuntime: () => bundledRuntime(),
    spawnProcess: () => process
  });

  const result = await adapter.createThread({
    correlationId: "corr-inspection",
    params: {
      cwd: "C:\\repo",
      sandbox: "read-only",
      approvalPolicy: "never",
      webSearchMode: "live"
    }
  });

  assert.deepEqual(result.runtime_profile, {
    cwd: "C:\\repo",
    sandbox: "read-only",
    approval_policy: "never",
    requested_web_search_mode: "live"
  });
});

test("reads canonical thread history with turns included by default", async () => {
  const { adapter, process } = createHarness();
  const result = await adapter.readThread({
    correlationId: "corr-read",
    threadId: "thread-history"
  });

  assert.equal(result.ok, true);
  assert.equal(result.operation, "readThread");
  assert.equal(result.thread_id, "thread-history");
  assert.equal(result.thread.id, "thread-history");
  const message = process.clientMessages.find((entry) => entry.method === "thread/read");
  assert.deepEqual(message.params, { threadId: "thread-history", includeTurns: true });
});

test("reports non-secret pinned runtime metadata without probing unless explicitly requested", async () => {
  const process = new FakeAppServerProcess();
  attachSuccessfulServer(process);
  const spawnCalls = [];
  const adapter = createAppServerAdapter({
    resolveRuntime: () => bundledRuntime(),
    spawnProcess: (...args) => {
      spawnCalls.push(args);
      return process;
    }
  });

  const unprobed = await adapter.runtimeInfo({ correlationId: "corr-info", probe: false });
  assert.equal(unprobed.ok, true);
  assert.equal(unprobed.operation, "runtimeInfo");
  assert.equal(unprobed.sdk_package, "@openai/codex-sdk");
  assert.equal(unprobed.sdk_version, "0.144.5");
  assert.equal(unprobed.codex_package, "@openai/codex");
  assert.equal(unprobed.codex_version, "0.144.5");
  assert.equal(unprobed.runtime_package, "@openai/codex-win32-x64");
  assert.equal(unprobed.runtime_package_version, "0.144.5-win32-x64");
  assert.equal(unprobed.target_triple, "x86_64-pc-windows-msvc");
  assert.equal(unprobed.platform_family, null);
  assert.equal(unprobed.platform_os, null);
  assert.equal(unprobed.user_agent, null);
  assert.equal(spawnCalls.length, 0);
  assert.equal(JSON.stringify(unprobed).includes("executable_path"), false);
  assert.equal(JSON.stringify(unprobed).includes("codexHome"), false);

  const probed = await adapter.runtimeInfo({ correlationId: "corr-probe", probe: true });
  assert.equal(spawnCalls.length, 1);
  assert.equal(probed.platform_family, "windows");
  assert.equal(probed.platform_os, "windows");
  assert.equal(probed.user_agent, "codex-cli/0.144.5");
  assert.equal(JSON.stringify(probed).includes("C:\\codex-home"), false);
});

test("shutdown completes without resolving or spawning a runtime when never started", async () => {
  let resolveCalls = 0;
  let spawnCalls = 0;
  const adapter = createAppServerAdapter({
    resolveRuntime: () => {
      resolveCalls += 1;
      return bundledRuntime();
    },
    spawnProcess: () => {
      spawnCalls += 1;
      return new FakeAppServerProcess();
    }
  });

  const result = await adapter.shutdown({ correlationId: "corr-shutdown" });
  assert.equal(result.ok, true);
  assert.equal(result.status, "completed");
  assert.equal(result.operation, "shutdown");
  assert.equal(resolveCalls, 0);
  assert.equal(spawnCalls, 0);
});

test("shutdown drains the current transport and a later operation starts cleanly", async () => {
  const processes = [];
  const adapter = createAppServerAdapter({
    resolveRuntime: () => bundledRuntime(),
    spawnProcess: () => {
      const process = new FakeAppServerProcess();
      process.kill = () => {
        process.exit(null, "SIGTERM");
        return true;
      };
      process.stdin.once("finish", () => process.exit(0));
      attachSuccessfulServer(process);
      processes.push(process);
      return process;
    }
  });

  await adapter.createThread({ correlationId: "corr-first", params: {} });
  const shutdown = await adapter.shutdown({ correlationId: "corr-shutdown" });
  assert.equal(shutdown.ok, true);
  assert.equal(processes[0].stdin.writableEnded, true);

  const restarted = await adapter.createThread({ correlationId: "corr-second", params: {} });
  assert.equal(restarted.ok, true);
  assert.equal(processes.length, 2);
  assert.equal(processes[1].clientMessages.filter((message) => message.method === "initialize").length, 1);
});

test("ignores direct runtime, executable, and PATH injection and spawns only the resolver result", async () => {
  const process = new FakeAppServerProcess();
  attachSuccessfulServer(process);
  const commands = [];
  const resolverCalls = [];
  let finderCalls = 0;
  const adapter = createAppServerAdapter({
    runtimeResult: bundledRuntime("C:\\direct\\codex.exe"),
    executablePath: "C:\\Program Files\\WindowsApps\\codex.exe",
    findExecutable: () => {
      finderCalls += 1;
      return "C:\\path\\codex.exe";
    },
    sdkPackageRoot: "C:\\sdk-root",
    resolveRuntime(input) {
      resolverCalls.push(input);
      return bundledRuntime("C:\\bundled\\codex.exe");
    },
    spawnProcess: (command) => {
      commands.push(command);
      return process;
    }
  });
  const result = await adapter.createThread({ correlationId: "corr-bundled", params: {} });

  assert.equal(result.ok, true);
  assert.deepEqual(resolverCalls, [{ sdkPackageRoot: "C:\\sdk-root" }]);
  assert.deepEqual(commands, ["C:\\bundled\\codex.exe"]);
  assert.equal(finderCalls, 0);
});

test("returns unavailable without spawning when bundled runtime resolution fails", async () => {
  const process = new FakeAppServerProcess();
  attachSuccessfulServer(process);
  let finderCalls = 0;
  let spawnCalls = 0;
  const adapter = createAppServerAdapter({
    findExecutable: () => {
      finderCalls += 1;
      return "C:\\path\\codex.exe";
    },
    resolveRuntime() {
      throw new Error("pinned bundled runtime missing");
    },
    spawnProcess: () => {
      spawnCalls += 1;
      return process;
    }
  });

  const result = await adapter.createThread({ correlationId: "corr-unavailable", params: {} });
  assert.equal(result.ok, false);
  assert.equal(result.status, "unavailable");
  assert.match(result.error.message, /pinned bundled runtime missing/i);
  assert.equal(finderCalls, 0);
  assert.equal(spawnCalls, 0);
});

test("separates dispatch acceptance from a matching streamed turn start", async () => {
  const { adapter, process } = createHarness();
  const events = [];
  await adapter.subscribeEvents({
    correlationId: "corr-subscribe",
    listener: (event) => events.push(event)
  });
  await adapter.createThread({ correlationId: "corr-thread", params: {} });
  const result = await adapter.startTurn({
    correlationId: "corr-turn",
    threadId: "thread-1",
    input: [{ type: "text", text: "hello" }]
  });

  assert.equal(result.evidence.dispatch_accepted, true);
  assert.equal(result.evidence.turn_started, false);
  assert.equal(events.filter((event) => event.type === "dispatch_accepted").length, 1);
  assert.equal(events.filter((event) => event.type === "turn_started").length, 0);

  process.send({
    method: "turn/started",
    params: { threadId: "other-thread", turn: makeTurn("other-turn") }
  });
  process.send({
    method: "turn/started",
    params: { threadId: "thread-1", turn: makeTurn("turn-1") }
  });
  await new Promise((resolve) => setImmediate(resolve));

  const started = events.filter((event) => event.type === "turn_started");
  assert.equal(started.length, 1);
  assert.equal(started[0].correlation_id, "corr-turn");
  assert.equal(started[0].thread_id, "thread-1");
  assert.equal(started[0].turn_id, "turn-1");
});

test("normalizes item and completion events only onto their matching correlation", async () => {
  const { adapter, process } = createHarness();
  const events = [];
  await adapter.subscribeEvents({ correlationId: "corr-sub", listener: (event) => events.push(event) });
  await adapter.createThread({ correlationId: "corr-thread", params: {} });
  await adapter.startTurn({
    correlationId: "corr-turn",
    threadId: "thread-1",
    input: [{ type: "text", text: "hello" }]
  });

  process.send({ method: "item/started", params: { item: { type: "reasoning" }, startedAtMs: 2, threadId: "thread-1", turnId: "turn-1" } });
  process.send({ method: "item/completed", params: { completedAtMs: 3, item: { type: "reasoning" }, threadId: "thread-1", turnId: "turn-1" } });
  process.send({ method: "turn/completed", params: { threadId: "thread-1", turn: makeTurn("turn-1", "completed") } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    events.filter((event) => ["progress_observed", "turn_completed"].includes(event.type)).map((event) => [event.type, event.correlation_id]),
    [
      ["progress_observed", "corr-turn"],
      ["progress_observed", "corr-turn"],
      ["turn_completed", "corr-turn"]
    ]
  );
});

test("sends exact steer and interrupt methods with caller-provided IDs", async () => {
  const { adapter, process } = createHarness();
  await adapter.createThread({ correlationId: "corr-thread", params: {} });
  const steer = await adapter.steerTurn({
    correlationId: "corr-steer",
    threadId: "thread-1",
    turnId: "turn-1",
    input: [{ type: "text", text: "change" }]
  });
  const interrupt = await adapter.interruptTurn({
    correlationId: "corr-interrupt",
    threadId: "thread-1",
    turnId: "turn-1"
  });

  assert.equal(steer.ok, true);
  assert.equal(interrupt.ok, true);
  const steerMessage = process.clientMessages.find((message) => message.method === "turn/steer");
  const interruptMessage = process.clientMessages.find((message) => message.method === "turn/interrupt");
  assert.deepEqual(steerMessage.params, {
    expectedTurnId: "turn-1",
    input: [{ type: "text", text: "change" }],
    threadId: "thread-1"
  });
  assert.deepEqual(interruptMessage.params, { threadId: "thread-1", turnId: "turn-1" });
});

test("relays a schema-pinned server approval request and only an explicit response", async () => {
  const { adapter, process } = createHarness();
  const events = [];
  await adapter.subscribeEvents({ correlationId: "corr-sub", listener: (event) => events.push(event) });
  await adapter.createThread({ correlationId: "corr-thread", params: {} });
  await adapter.startTurn({
    correlationId: "corr-turn",
    threadId: "thread-1",
    input: [{ type: "text", text: "hello" }]
  });

  process.send({
    id: "approval-1",
    method: "item/fileChange/requestApproval",
    params: {
      itemId: "item-1",
      startedAtMs: 4,
      threadId: "thread-1",
      turnId: "turn-1",
      reason: "Write file"
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  const approval = events.find((event) => event.type === "approval_requested");
  assert.deepEqual(approval, {
    adapter: "app_server",
    type: "approval_requested",
    correlation_id: "corr-turn",
    thread_id: "thread-1",
    turn_id: "turn-1",
    request_id: "approval-1",
    method: "item/fileChange/requestApproval",
    reason: "[redacted approval reason]",
    requested_effect: { kind: "file_change", item_id: "item-1" },
    response_options: ["accept", "acceptForSession", "decline", "cancel"]
  });
  assert.equal(
    process.clientMessages.some((message) => message.id === "approval-1"),
    false,
    "receiving an approval request must not auto-respond"
  );

  const outbound = once(process, "clientMessage");
  const response = await adapter.respondToApproval({
    correlationId: "corr-turn",
    requestId: "approval-1",
    method: "item/fileChange/requestApproval",
    threadId: "thread-1",
    turnId: "turn-1",
    decision: "decline"
  });
  const [message] = await outbound;
  assert.equal(response.ok, true);
  assert.deepEqual(message, { id: "approval-1", result: { decision: "decline" } });
});

test("separates recommended, requested, applied, and observed model evidence", async () => {
  const { adapter, process } = createHarness();
  const events = [];
  await adapter.subscribeEvents({ correlationId: "corr-sub", listener: (event) => events.push(event) });
  const thread = await adapter.createThread({
    correlationId: "corr-thread",
    recommendedModel: "recommended-model",
    requestedModel: "requested-model",
    params: { model: "requested-model" }
  });
  assert.deepEqual(thread.model_evidence, {
    recommended_model: "recommended-model",
    requested_model: "requested-model",
    applied_model: "requested-model",
    actual_model: null,
    actual_model_evidence_ref: null
  });

  await adapter.startTurn({
    correlationId: "corr-turn",
    threadId: "thread-1",
    input: [{ type: "text", text: "hello" }]
  });
  process.send({
    method: "model/rerouted",
    params: {
      fromModel: "requested-model",
      reason: "runtime routing",
      threadId: "thread-1",
      toModel: "observed-model",
      turnId: "turn-1"
    }
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(events.find((event) => event.type === "model_observed"), {
    adapter: "app_server",
    type: "model_observed",
    correlation_id: "corr-turn",
    thread_id: "thread-1",
    turn_id: "turn-1",
    model: "observed-model",
    source_event: "model/rerouted"
  });
  const actual = await adapter.readActualModel({ correlationId: "corr-model" });
  assert.equal(actual.ok, false);
  assert.equal(actual.status, "unsupported");
  assert.equal(actual.evidence.actual_model, null);
});

test("fails closed when a response does not satisfy the pinned schema", async () => {
  const process = new FakeAppServerProcess();
  process.on("clientMessage", (message) => {
    if (message.method === "initialize") {
      process.send({
        id: message.id,
        result: {
          codexHome: "C:\\codex-home",
          platformFamily: "windows",
          platformOs: "windows",
          userAgent: "codex-cli/0.144.5"
        }
      });
    } else if (message.method === "thread/start") {
      process.send({ id: message.id, result: { model: "not-enough" } });
    }
  });
  const adapter = createAppServerAdapter({
    resolveRuntime: () => bundledRuntime(),
    spawnProcess: () => process
  });

  const result = await adapter.createThread({ correlationId: "corr-invalid", params: {} });
  assert.equal(result.ok, false);
  assert.equal(result.status, "failed");
  assert.match(result.error.message, /schema.*approvalPolicy/i);
});

test("ignores forward-compatible server notifications without closing the transport", async () => {
  const process = new FakeAppServerProcess();
  const diagnostics = [];
  attachSuccessfulServer(process);
  const adapter = createAppServerAdapter({
    resolveRuntime: () => bundledRuntime(),
    spawnProcess: () => process,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
  });

  const runtime = await adapter.runtimeInfo({ correlationId: "corr-runtime", probe: true });
  assert.equal(runtime.ok, true);
  process.send({ method: "remoteControl/status/changed", params: { status: "disconnected" } });
  await new Promise((resolve) => setImmediate(resolve));
  const thread = await adapter.createThread({ correlationId: "corr-after-notification", params: { cwd: "C:\\repo" } });

  assert.equal(thread.ok, true);
  assert.deepEqual(diagnostics, [{ type: "ignored_server_notification", method: "remoteControl/status/changed" }]);
});
