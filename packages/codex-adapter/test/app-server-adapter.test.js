const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { spawn } = require("node:child_process");
const path = require("node:path");

const {
  APP_SERVER_MAX_LINE_BYTES,
  createAppServerAdapter
} = require("../src/app-server-adapter");
const { createJsonlTransport } = require("../src/jsonl-transport");
const { FakeAppServerProcess } = require("../fixtures/fake-app-server");

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

function dynamicToolCall(id, threadId, turnId) {
  return {
    id,
    method: "item/tool/call",
    params: {
      threadId,
      turnId,
      tool: "orquesta_attachment_read",
      arguments: { capability: "a".repeat(64), cursor: null },
      callId: `call-${id}`
    }
  };
}

function dynamicToolHandler(overrides = {}) {
  return {
    handle: async () => ({
      response: { success: true, contentItems: [{ type: "inputText", text: "attachment marker" }] },
      onResponseWriteFailure: () => {}
    }),
    expire: async () => {},
    ...overrides
  };
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
          runtimeWorkspaceRoots: ["C:\\repo"],
          instructionSources: ["C:\\repo\\AGENTS.md"],
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
    } else if (message.method === "thread/name/set") {
      process.send({ id: message.id, result: {} });
    } else if (message.method === "thread/archive") {
      process.send({ id: message.id, result: {} });
    } else if (message.method === "thread/list") {
      process.send({
        id: message.id,
        result: {
          data: [makeThread("thread-listed")],
          nextCursor: null
        }
      });
    } else if (message.method === "model/list") {
      process.send({
        id: message.id,
        result: {
          data: [{
            id: "gpt-5.6-sol",
            model: "gpt-5.6-sol",
            displayName: "GPT-5.6-Sol",
            description: "Frontier agentic coding model.",
            hidden: false,
            isDefault: true,
            defaultReasoningEffort: "xhigh",
            supportedReasoningEfforts: [
              { reasoningEffort: "high", description: "Deep reasoning." },
              { reasoningEffort: "xhigh", description: "Maximum practical reasoning." }
            ],
            serviceTiers: [{ id: "fast", name: "Fast", description: "1.5x faster; uses more credits." }]
          }],
          nextCursor: null
        }
      });
    } else if (message.method === "thread/read") {
      process.send({
        id: message.id,
        result: { thread: makeThread(message.params.threadId) }
      });
    } else if (message.method === "thread/turns/list") {
      process.send({
        id: message.id,
        result: {
          data: [makeTurn("turn-paged", "completed")],
          nextCursor: "older-cursor",
          backwardsCursor: null
        }
      });
    } else if (message.method === "turn/start") {
      process.send({ id: message.id, result: { turn: makeTurn("turn-1") } });
    } else if (message.method === "turn/steer") {
      process.send({ id: message.id, result: { turnId: message.params.expectedTurnId } });
    } else if (message.method === "turn/interrupt") {
      process.send({ id: message.id, result: {} });
    } else if (message.method === "account/read") {
      process.send({
        id: message.id,
        result: { account: { type: "chatgpt", email: "user@example.test", planType: "plus" }, requiresOpenaiAuth: true }
      });
    } else if (message.method === "account/login/start") {
      process.send({
        id: message.id,
        result: { type: "chatgpt", loginId: "login-1", authUrl: "https://auth.openai.com/authorize" }
      });
    }
  });
}

function attachTurnServer(process, onTurnStart) {
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
    } else if (message.method === "turn/start") {
      onTurnStart(message);
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

test("allows bounded large thread resume responses needed by long-lived projects", async () => {
  const process = new FakeAppServerProcess();
  attachSuccessfulServer(process);
  let configuredMaxLineBytes = null;
  const adapter = createAppServerAdapter({
    resolveRuntime: () => bundledRuntime(),
    spawnProcess: () => process,
    transportFactory: (options) => {
      configuredMaxLineBytes = options.maxLineBytes;
      return createJsonlTransport(options);
    }
  });

  const result = await adapter.runtimeInfo({ correlationId: "corr-large-line", probe: true });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(configuredMaxLineBytes, APP_SERVER_MAX_LINE_BYTES);
  assert.equal(APP_SERVER_MAX_LINE_BYTES, 64 * 1024 * 1024);
});

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

test("reads account state and starts ChatGPT login through the initialized App Server", async () => {
  const { adapter, process } = createHarness();

  const account = await adapter.readAccount({ correlationId: "corr-account" });
  const login = await adapter.startLogin({ correlationId: "corr-login", loginType: "chatgpt" });

  assert.deepEqual(account, {
    ok: true,
    status: "completed",
    adapter: "app_server",
    operation: "readAccount",
    correlation_id: "corr-account",
    thread_id: null,
    turn_id: null,
    approval_id: null,
    actual_model: null,
    account_type: "chatgpt",
    requires_openai_auth: true
  });
  assert.equal(login.login_type, "chatgpt");
  assert.equal(login.login_id, "login-1");
  assert.equal(login.auth_url, "https://auth.openai.com/authorize");
  assert.deepEqual(process.clientMessages.map((message) => message.method), [
    "initialize", "initialized", "account/read", "account/login/start"
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
          runtimeWorkspaceRoots: ["C:\\repo"],
          instructionSources: ["C:\\repo\\AGENTS.md"],
          model: "requested-model",
          modelProvider: "openai",
          sandbox: { type: "readOnly", networkAccess: false },
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
    runtime_workspace_roots: ["C:\\repo"],
    instruction_sources: ["C:\\repo\\AGENTS.md"],
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

test("pages persisted turns with the experimental App Server API", async () => {
  const { adapter, process } = createHarness();
  const result = await adapter.listThreadTurns({
    correlationId: "corr-turn-page",
    threadId: "thread-history",
    cursor: "current-cursor",
    limit: 12
  });

  assert.equal(result.ok, true);
  assert.equal(result.operation, "listThreadTurns");
  assert.equal(result.thread_id, "thread-history");
  assert.equal(result.turns[0].id, "turn-paged");
  assert.equal(result.next_cursor, "older-cursor");
  const initialize = process.clientMessages.find((entry) => entry.method === "initialize");
  assert.deepEqual(initialize.params.capabilities, { experimentalApi: true });
  const message = process.clientMessages.find((entry) => entry.method === "thread/turns/list");
  assert.deepEqual(message.params, {
    threadId: "thread-history",
    cursor: "current-cursor",
    limit: 12,
    sortDirection: "desc",
    itemsView: "summary"
  });
});

test("sets a persisted Codex thread user-facing name", async () => {
  const { adapter, process } = createHarness();

  const result = await adapter.setThreadName({
    correlationId: "corr-name",
    threadId: "thread-history",
    name: "Orquesta 実装係 2"
  });

  assert.equal(result.ok, true);
  assert.equal(result.operation, "setThreadName");
  assert.equal(result.thread_id, "thread-history");
  const message = process.clientMessages.find((entry) => entry.method === "thread/name/set");
  assert.deepEqual(message.params, {
    threadId: "thread-history",
    name: "Orquesta 実装係 2"
  });
});

test("archives a persisted disposable Codex thread", async () => {
  const { adapter, process } = createHarness();

  const result = await adapter.archiveThread({
    correlationId: "corr-archive",
    threadId: "thread-disposable"
  });

  assert.equal(result.ok, true);
  assert.equal(result.operation, "archiveThread");
  assert.equal(result.thread_id, "thread-disposable");
  const message = process.clientMessages.find((entry) => entry.method === "thread/archive");
  assert.deepEqual(message.params, { threadId: "thread-disposable" });
});

test("lists persisted Codex threads with an exact cwd filter", async () => {
  const { adapter, process } = createHarness();
  const result = await adapter.listThreads({
    correlationId: "corr-list",
    params: {
      cwd: "C:\\repo",
      archived: false,
      limit: 100,
      sortKey: "updated_at",
      sortDirection: "desc"
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.operation, "listThreads");
  assert.equal(result.threads[0].id, "thread-listed");
  const message = process.clientMessages.find((entry) => entry.method === "thread/list");
  assert.deepEqual(message.params, {
    cwd: "C:\\repo",
    archived: false,
    limit: 100,
    sortKey: "updated_at",
    sortDirection: "desc"
  });
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
  assert.equal(unprobed.provider_connection_id, null);
  assert.deepEqual(unprobed.models, []);
  assert.equal(spawnCalls.length, 0);
  assert.equal(JSON.stringify(unprobed).includes("executable_path"), false);
  assert.equal(JSON.stringify(unprobed).includes("codexHome"), false);

  const probed = await adapter.runtimeInfo({ correlationId: "corr-probe", probe: true });
  assert.equal(spawnCalls.length, 1);
  assert.equal(probed.platform_family, "windows");
  assert.equal(probed.platform_os, "windows");
  assert.equal(probed.user_agent, "codex-cli/0.144.5");
  assert.match(probed.provider_connection_id, /^provider_/u);
  assert.equal(probed.models[0].id, "gpt-5.6-sol");
  assert.deepEqual(probed.models[0].supportedReasoningEfforts, [
    { effort: "high", description: "Deep reasoning." },
    { effort: "xhigh", description: "Maximum practical reasoning." }
  ]);
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

test("does not replay a failed operation and starts the next operation on a fresh App Server", async () => {
  const processes = [];
  const connectionEvents = [];
  let connectionGeneration = 0;
  const adapter = createAppServerAdapter({
    resolveRuntime: () => bundledRuntime(),
    providerStreamIdFactory: () => `provider-test-${++connectionGeneration}`,
    spawnProcess: () => {
      const process = new FakeAppServerProcess();
      const index = processes.length;
      if (index === 0) {
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
            setImmediate(() => process.exit(9));
          }
        });
      } else {
        attachSuccessfulServer(process);
      }
      processes.push(process);
      return process;
    }
  });

  await adapter.subscribeEvents({ correlationId: "connection-observer", listener: (event) => {
    if (event.type === "provider_connection") connectionEvents.push([event.state, event.provider_connection_id]);
  } });
  const failed = await adapter.createThread({ correlationId: "corr-failed", params: {} });
  assert.equal(failed.ok, false);
  assert.equal(processes.length, 1, "an uncertain operation must not be replayed");

  const recovered = await adapter.createThread({ correlationId: "corr-recovered", params: {} });
  assert.equal(recovered.ok, true);
  assert.equal(processes.length, 2);
  assert.equal(processes[1].clientMessages.filter((message) => message.method === "initialize").length, 1);
  const recoveredInfo = await adapter.runtimeInfo({ correlationId: "corr-recovered-info", probe: true });
  assert.equal(recoveredInfo.provider_connection_id, "provider-test-2");
  assert.deepEqual(connectionEvents, [
    ["connected", "provider-test-1"],
    ["disconnected", "provider-test-1"],
    ["connected", "provider-test-2"],
  ]);
});

test("shutdown keeps event delivery alive until stdout closes and drains a terminal frame", async () => {
  const process = new FakeAppServerProcess();
  process.kill = () => true;
  attachSuccessfulServer(process);
  const adapter = createAppServerAdapter({ resolveRuntime: () => bundledRuntime(), spawnProcess: () => process });
  const events = [];
  await adapter.subscribeEvents({ correlationId: "sub", listener: (event) => events.push(event) });
  await adapter.createThread({ correlationId: "create", params: {} });
  await adapter.startTurn({ correlationId: "turn", threadId: "thread-1", input: [{ type: "text", text: "go" }] });
  process.stdin.once("finish", () => {
    process.send({ method: "turn/completed", params: { threadId: "thread-1", turn: makeTurn("turn-1", "completed") } });
    process.exit(0);
  });

  const result = await adapter.shutdown({ correlationId: "shutdown" });
  assert.equal(result.ok, true);
  assert.equal(events.some((event) => event.type === "turn_completed"), true);
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

  process.send({ method: "item/started", params: { item: { id: "reasoning-1", type: "reasoning" }, startedAtMs: 2, threadId: "thread-1", turnId: "turn-1" } });
  process.send({ method: "item/completed", params: { completedAtMs: 3, item: { id: "reasoning-1", type: "reasoning" }, threadId: "thread-1", turnId: "turn-1" } });
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
  assert.match(approval.request_id, /^adapter-approval-[a-f0-9]{64}$/u);
  assert.match(approval.request_instance_id, /^adapter-approval-instance-[a-f0-9]{64}$/u);
  assert.deepEqual(approval, {
    adapter: "app_server",
    type: "approval_requested",
    provider_connection_id: approval.provider_connection_id,
    correlation_id: "corr-turn",
    thread_id: "thread-1",
    turn_id: "turn-1",
    request_id: approval.request_id,
    request_instance_id: approval.request_instance_id,
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

  const preflight = await adapter.respondToApproval({
    correlationId: "corr-turn",
    requestId: approval.request_id,
    method: "item/fileChange/requestApproval",
    threadId: "thread-1",
    turnId: "turn-1",
    decision: "invented"
  });
  assert.equal(preflight.ok, false);
  assert.equal(preflight.evidence.approval_response_phase, "pre_provider");
  assert.equal(process.clientMessages.some((message) => message.id === "approval-1"), false);

  const outbound = once(process, "clientMessage");
  const response = await adapter.respondToApproval({
    correlationId: "corr-turn",
    requestId: approval.request_id,
    method: "item/fileChange/requestApproval",
    threadId: "thread-1",
    turnId: "turn-1",
    decision: "decline"
  });
  const [message] = await outbound;
  assert.equal(response.ok, true);
  assert.deepEqual(message, { id: "approval-1", result: { decision: "decline" } });
});

test("serializes a coalesced turn response before its following approval frame", async () => {
  const process = new FakeAppServerProcess();
  process.on("clientMessage", (message) => {
    if (message.method === "initialize") {
      process.send({ id: message.id, result: { codexHome: "C:\\codex", platformFamily: "windows", platformOs: "windows", userAgent: "test" } });
    } else if (message.method === "thread/start") {
      process.send({
        id: message.id,
        result: {
          approvalPolicy: "on-request", approvalsReviewer: "user", cwd: "C:\\repo",
          model: "model", modelProvider: "openai", sandbox: "workspace-write", thread: makeThread("thread-1")
        }
      });
    } else if (message.method === "turn/start") {
      const response = { id: message.id, result: { turn: makeTurn("turn-coalesced") } };
      const approval = {
        id: "approval-coalesced",
        method: "item/fileChange/requestApproval",
        params: { itemId: "item-1", startedAtMs: 1, threadId: "thread-1", turnId: "turn-coalesced" }
      };
      process.sendRaw(Buffer.from(`${JSON.stringify(response)}\n${JSON.stringify(approval)}\n`, "utf8"));
    }
  });
  const adapter = createAppServerAdapter({
    resolveRuntime: () => bundledRuntime(),
    spawnProcess: () => process
  });
  const events = [];
  await adapter.subscribeEvents({ correlationId: "sub", listener: (event) => events.push(event) });
  await adapter.createThread({ correlationId: "create", params: {} });
  const result = await adapter.startTurn({
    correlationId: "turn-correlation", threadId: "thread-1", input: [{ type: "text", text: "go" }]
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result.ok, true, JSON.stringify(result));
  const causalEvents = events.filter((event) => event.type !== "provider_event" && event.type !== "provider_connection");
  assert.deepEqual(causalEvents.map((event) => event.type), ["dispatch_accepted", "approval_requested"]);
  assert.equal(causalEvents[1].correlation_id, "turn-correlation");
  assert.match(causalEvents[1].request_id, /^adapter-approval-[a-f0-9]{64}$/u);
  assert.notEqual(causalEvents[1].request_id, "approval-coalesced");
});

test("commits turn identity before coalesced turn and approval frames from a real child process", async (t) => {
  const fixture = path.join(__dirname, "..", "fixtures", "coalesced-app-server-child.js");
  const adapter = createAppServerAdapter({
    sdkPackageRoot: "test-sdk-root",
    resolveRuntime: () => bundledRuntime(process.execPath),
    spawnProcess: () => spawn(process.execPath, [fixture], {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    })
  });
  const events = [];
  t.after(() => adapter.shutdown({ correlationId: "real-shutdown" }));
  await adapter.subscribeEvents({ correlationId: "real-sub", listener: (event) => events.push(event) });
  await adapter.createThread({ correlationId: "real-create", params: {} });
  const result = await adapter.startTurn({
    correlationId: "real-turn-correlation",
    threadId: "real-process-thread",
    input: [{ type: "text", text: "go" }]
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(result.ok, true, JSON.stringify(result));
  const causalEvents = events.filter((event) => event.type !== "provider_event" && event.type !== "provider_connection");
  assert.deepEqual(causalEvents.map((event) => event.type), [
    "dispatch_accepted",
    "turn_started",
    "approval_requested"
  ]);
  assert.equal(causalEvents.every((event) => event.correlation_id === "real-turn-correlation"), true);
  assert.match(causalEvents[2].request_id, /^adapter-approval-[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(events).includes("real-process-provider-approval"), false);
});

test("buffers attributable approval and thread notifications which precede their responses", async () => {
  const process = new FakeAppServerProcess();
  process.on("clientMessage", (message) => {
    if (message.method === "initialize") {
      process.send({ id: message.id, result: { codexHome: "C:\\codex", platformFamily: "windows", platformOs: "windows", userAgent: "test" } });
    } else if (message.method === "thread/start") {
      process.send({ method: "thread/started", params: { thread: makeThread("thread-before") } });
      process.send({
        id: message.id,
        result: {
          approvalPolicy: "on-request", approvalsReviewer: "user", cwd: "C:\\repo",
          model: "model", modelProvider: "openai", sandbox: "workspace-write", thread: makeThread("thread-before")
        }
      });
    } else if (message.method === "turn/start") {
      process.send({
        id: "approval-before",
        method: "item/commandExecution/requestApproval",
        params: { itemId: "item-before", startedAtMs: 1, threadId: "thread-before", turnId: "turn-before" }
      });
      process.send({ id: message.id, result: { turn: makeTurn("turn-before") } });
    }
  });
  const adapter = createAppServerAdapter({ resolveRuntime: () => bundledRuntime(), spawnProcess: () => process });
  const events = [];
  await adapter.subscribeEvents({ correlationId: "sub", listener: (event) => events.push(event) });
  await adapter.createThread({ correlationId: "create-before", params: {} });
  await adapter.startTurn({
    correlationId: "turn-before-correlation", threadId: "thread-before", input: [{ type: "text", text: "go" }]
  });
  await new Promise((resolve) => setImmediate(resolve));
  const causalEvents = events.filter((event) => event.type !== "provider_event" && event.type !== "provider_connection");
  assert.deepEqual(causalEvents.map((event) => event.type), ["thread_started", "dispatch_accepted", "approval_requested"]);
  assert.equal(causalEvents[0].correlation_id, "create-before");
  assert.equal(causalEvents[2].correlation_id, "turn-before-correlation");
});

test("does not discard a second concurrent start's causal frames when the first response commits", async () => {
  const process = new FakeAppServerProcess();
  const pendingStarts = [];
  process.on("clientMessage", (message) => {
    if (message.method === "initialize") {
      process.send({ id: message.id, result: { codexHome: "C:\\codex", platformFamily: "windows", platformOs: "windows", userAgent: "test" } });
    } else if (message.method === "thread/start") {
      process.send({
        id: message.id,
        result: {
          approvalPolicy: "on-request", approvalsReviewer: "user", cwd: "C:\\repo",
          model: "model", modelProvider: "openai", sandbox: "workspace-write", thread: makeThread("thread-concurrent")
        }
      });
    } else if (message.method === "turn/start") {
      pendingStarts.push(message);
      if (pendingStarts.length === 2) {
        process.send({
          id: "provider-before-second-response",
          method: "item/commandExecution/requestApproval",
          params: {
            itemId: "second-item", startedAtMs: 1,
            threadId: "thread-concurrent", turnId: "turn-second"
          }
        });
        process.send({ id: pendingStarts[0].id, result: { turn: makeTurn("turn-first") } });
        process.send({ id: pendingStarts[1].id, result: { turn: makeTurn("turn-second") } });
      }
    }
  });
  const adapter = createAppServerAdapter({ resolveRuntime: () => bundledRuntime(), spawnProcess: () => process });
  const events = [];
  await adapter.subscribeEvents({ correlationId: "sub", listener: (event) => events.push(event) });
  await adapter.createThread({ correlationId: "create", params: {} });
  const [first, second] = await Promise.all([
    adapter.startTurn({ correlationId: "first-correlation", threadId: "thread-concurrent", input: [{ type: "text", text: "first" }] }),
    adapter.startTurn({ correlationId: "second-correlation", threadId: "thread-concurrent", input: [{ type: "text", text: "second" }] })
  ]);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(first.turn_id, "turn-first");
  assert.equal(second.turn_id, "turn-second");
  const approval = events.find((event) => event.type === "approval_requested");
  assert.equal(approval.correlation_id, "second-correlation");
  assert.equal(approval.turn_id, "turn-second");
});

test("expires a pending provider approval when its turn becomes terminal", async () => {
  const { adapter, process } = createHarness();
  const events = [];
  await adapter.subscribeEvents({ correlationId: "sub", listener: (event) => events.push(event) });
  await adapter.createThread({ correlationId: "create", params: {} });
  await adapter.startTurn({ correlationId: "turn", threadId: "thread-1", input: [{ type: "text", text: "go" }] });
  process.send({
    id: "approval-late", method: "item/fileChange/requestApproval",
    params: { itemId: "item", startedAtMs: 1, threadId: "thread-1", turnId: "turn-1" }
  });
  process.send({ method: "turn/completed", params: { threadId: "thread-1", turn: makeTurn("turn-1", "completed") } });
  await new Promise((resolve) => setImmediate(resolve));
  const approval = events.find((event) => event.type === "approval_requested");
  const result = await adapter.respondToApproval({
    correlationId: "turn", requestId: approval.request_id, method: "item/fileChange/requestApproval",
    threadId: "thread-1", turnId: "turn-1", decision: "decline"
  });
  assert.equal(result.ok, false);
  assert.equal(process.clientMessages.some((message) => message.id === "approval-late"), false);
});

test("expires provider approval identity on a non-retryable runtime error", async () => {
  const { adapter, process } = createHarness();
  const events = [];
  await adapter.subscribeEvents({ correlationId: "sub", listener: (event) => events.push(event) });
  await adapter.createThread({ correlationId: "create", params: {} });
  await adapter.startTurn({ correlationId: "turn", threadId: "thread-1", input: [{ type: "text", text: "go" }] });
  process.send({
    id: "approval-before-error", method: "item/commandExecution/requestApproval",
    params: { itemId: "item", startedAtMs: 1, threadId: "thread-1", turnId: "turn-1" }
  });
  process.send({
    method: "error",
    params: { error: { message: "terminal" }, threadId: "thread-1", turnId: "turn-1", willRetry: false }
  });
  await new Promise((resolve) => setImmediate(resolve));
  const approval = events.find((event) => event.type === "approval_requested");
  const result = await adapter.respondToApproval({
    correlationId: "turn", requestId: approval.request_id,
    method: "item/commandExecution/requestApproval", threadId: "thread-1", turnId: "turn-1", decision: "decline"
  });
  assert.equal(result.ok, false);
  assert.equal(process.clientMessages.some((message) => message.id === "approval-before-error"), false);
});

test("expires every pending approval when its App Server connection is retired", async () => {
  const { adapter, process } = createHarness();
  const events = [];
  await adapter.subscribeEvents({ correlationId: "sub", listener: (event) => events.push(event) });
  await adapter.createThread({ correlationId: "create", params: {} });
  await adapter.startTurn({ correlationId: "turn", threadId: "thread-1", input: [{ type: "text", text: "go" }] });
  process.send({
    id: "approval-before-connection-loss", method: "item/fileChange/requestApproval",
    params: { itemId: "item", startedAtMs: 1, threadId: "thread-1", turnId: "turn-1" }
  });
  await new Promise((resolve) => setImmediate(resolve));
  const approval = events.find((event) => event.type === "approval_requested");
  assert.match(approval.provider_connection_id, /^provider_/u);
  assert.ok(approval);

  process.sendRaw(Buffer.from("{not-json}\n", "utf8"));
  await new Promise((resolve) => setImmediate(resolve));
  const expired = events.find((event) => event.type === "approval_expired");
  assert.deepEqual(expired, {
    adapter: "app_server",
    type: "approval_expired",
    thread_id: "thread-1",
    turn_id: "turn-1",
    correlation_id: "turn",
    request_id: approval.request_id,
    reason: "provider_connection_lost"
  });
  const result = await adapter.respondToApproval({
    correlationId: "turn", requestId: approval.request_id,
    method: "item/fileChange/requestApproval", threadId: "thread-1", turnId: "turn-1", decision: "decline"
  });
  assert.equal(result.ok, false);
  assert.equal(process.clientMessages.some((message) => message.id === "approval-before-connection-loss"), false);
});

test("allows sequential provider ID reuse for a different turn while retiring the old public handle", async () => {
  const process = new FakeAppServerProcess();
  let turnNumber = 0;
  process.on("clientMessage", (message) => {
    if (message.method === "initialize") {
      process.send({ id: message.id, result: { codexHome: "C:\\codex", platformFamily: "windows", platformOs: "windows", userAgent: "test" } });
    } else if (message.method === "thread/start") {
      process.send({
        id: message.id,
        result: {
          approvalPolicy: "on-request", approvalsReviewer: "user", cwd: "C:\\repo",
          model: "model", modelProvider: "openai", sandbox: "workspace-write", thread: makeThread("thread-reuse")
        }
      });
    } else if (message.method === "turn/start") {
      turnNumber += 1;
      process.send({ id: message.id, result: { turn: makeTurn(`turn-${turnNumber}`) } });
    }
  });
  const adapter = createAppServerAdapter({ resolveRuntime: () => bundledRuntime(), spawnProcess: () => process });
  const events = [];
  await adapter.subscribeEvents({ correlationId: "sub", listener: (event) => events.push(event) });
  await adapter.createThread({ correlationId: "create", params: {} });

  const publicHandles = [];
  for (const turnId of ["turn-1", "turn-2"]) {
    const correlationId = `correlation-${turnId}`;
    await adapter.startTurn({ correlationId, threadId: "thread-reuse", input: [{ type: "text", text: turnId }] });
    process.send({
      id: "provider-reused-id",
      method: "item/fileChange/requestApproval",
      params: { itemId: `item-${turnId}`, startedAtMs: 1, threadId: "thread-reuse", turnId }
    });
    await new Promise((resolve) => setImmediate(resolve));
    const approval = events.filter((event) => event.type === "approval_requested").at(-1);
    publicHandles.push(approval.request_id);
    const result = await adapter.respondToApproval({
      correlationId, requestId: approval.request_id,
      method: "item/fileChange/requestApproval", threadId: "thread-reuse", turnId, decision: "decline"
    });
    assert.equal(result.ok, true);
    process.send({ method: "turn/completed", params: { threadId: "thread-reuse", turn: makeTurn(turnId, "completed") } });
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.notEqual(publicHandles[0], publicHandles[1]);
  assert.equal(process.clientMessages.filter((message) => message.id === "provider-reused-id").length, 2);
  const retired = await adapter.respondToApproval({
    correlationId: "correlation-turn-1", requestId: publicHandles[0],
    method: "item/fileChange/requestApproval", threadId: "thread-reuse", turnId: "turn-1", decision: "decline"
  });
  assert.equal(retired.ok, false);
  assert.equal(process.clientMessages.filter((message) => message.id === "provider-reused-id").length, 2);
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

test("rejects a dynamic tool preflight before turn/start is written and permits a clean retry", async () => {
  const { adapter, process } = createHarness();
  await adapter.createThread({ correlationId: "corr-thread", params: {} });
  const rejectedFactory = Object.assign(
    () => dynamicToolHandler(),
    { preflight: () => { throw new Error("attachment preflight rejected"); } }
  );
  const rejected = await adapter.startTurn({
    correlationId: "corr-preflight",
    threadId: "thread-1",
    input: [{ type: "text", text: "hello" }],
    dynamicToolHandlerFactory: rejectedFactory
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, "attachment_dynamic_tool_preflight_failed");
  assert.equal(rejected.evidence.dispatch_accepted, false);
  assert.equal(process.clientMessages.filter((message) => message.method === "turn/start").length, 0);

  const accepted = await adapter.startTurn({
    correlationId: "corr-retry",
    threadId: "thread-1",
    input: [{ type: "text", text: "hello" }],
    dynamicToolHandlerFactory: Object.assign(() => dynamicToolHandler(), { preflight: () => {} })
  });
  assert.equal(accepted.ok, true);
  assert.equal(process.clientMessages.filter((message) => message.method === "turn/start").length, 1);
});

test("returns an exact accepted receipt when dynamic handler commit fails after Provider acceptance", async () => {
  const process = new FakeAppServerProcess();
  let turnNumber = 0;
  attachTurnServer(process, (message) => {
    turnNumber += 1;
    process.send({ id: message.id, result: { turn: makeTurn(`turn-${turnNumber}`) } });
  });
  const adapter = createAppServerAdapter({ resolveRuntime: () => bundledRuntime(), spawnProcess: () => process });
  await adapter.createThread({ correlationId: "corr-thread", params: {} });
  const rejected = await adapter.startTurn({
    correlationId: "corr-post-accept",
    threadId: "thread-1",
    input: [{ type: "text", text: "hello" }],
    dynamicToolHandlerFactory: Object.assign(
      () => { throw new Error("factory commit failed"); },
      { preflight: () => {} }
    )
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, "runtime_outcome_unknown");
  assert.equal(rejected.evidence.dispatch_accepted, true);
  assert.equal(rejected.thread_id, "thread-1");
  assert.equal(rejected.turn_id, "turn-1");

  process.send({ method: "turn/completed", params: { threadId: "thread-1", turn: makeTurn("turn-1", "failed") } });
  await new Promise((resolve) => setImmediate(resolve));
  const retry = await adapter.startTurn({
    correlationId: "corr-after-terminal",
    threadId: "thread-1",
    input: [{ type: "text", text: "retry" }],
    dynamicToolHandlerFactory: Object.assign(() => dynamicToolHandler(), { preflight: () => {} })
  });
  assert.equal(retry.ok, true);
  assert.equal(retry.turn_id, "turn-2");
});

test("drains an orphan dynamic request exactly once when turn/start times out and a duplicate follows", async () => {
  const process = new FakeAppServerProcess();
  attachTurnServer(process, (message) => {
    const request = dynamicToolCall("orphan-timeout", "thread-1", "turn-timeout");
    process.send(request);
    process.send(request);
    process.send({ id: message.id, error: { message: "turn/start timeout" } });
  });
  const adapter = createAppServerAdapter({ resolveRuntime: () => bundledRuntime(), spawnProcess: () => process });
  await adapter.createThread({ correlationId: "corr-thread", params: {} });
  const result = await adapter.startTurn({
    correlationId: "corr-timeout",
    threadId: "thread-1",
    input: [{ type: "text", text: "hello" }],
    dynamicToolHandlerFactory: Object.assign(() => dynamicToolHandler(), { preflight: () => {} })
  });
  assert.equal(result.ok, false);
  await new Promise((resolve) => setImmediate(resolve));
  const responses = process.clientMessages.filter((message) => message.id === "orphan-timeout" && !message.method);
  assert.equal(responses.length, 1);
  assert.equal(responses[0].result.success, false);
  assert.match(responses[0].result.contentItems[0].text, /duplicate|scope/u);
  process.send(dynamicToolCall("orphan-timeout", "thread-1", "turn-timeout"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(process.clientMessages.filter((message) => message.id === "orphan-timeout" && !message.method).length, 1);
});

test("drains 257 pending-turn dynamic orphans with bounded failures and retires the Provider process", async () => {
  const process = new FakeAppServerProcess();
  let processKills = 0;
  process.kill = () => {
    processKills += 1;
    process.exit(0, null, true);
  };
  attachTurnServer(process, () => {
    for (let index = 0; index < 257; index += 1) {
      process.send(dynamicToolCall(`orphan-overflow-${index}`, "thread-1", "turn-overflow"));
    }
  });
  const diagnostics = [];
  const adapter = createAppServerAdapter({
    resolveRuntime: () => bundledRuntime(),
    spawnProcess: () => process,
    providerRetirementTimeoutMs: 10,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
  });
  await adapter.createThread({ correlationId: "corr-thread", params: {} });
  const result = await adapter.startTurn({
    correlationId: "corr-orphan-overflow",
    threadId: "thread-1",
    input: [{ type: "text", text: "hello" }],
    dynamicToolHandlerFactory: Object.assign(() => dynamicToolHandler(), { preflight: () => {} })
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "runtime_outcome_unknown");
  assert.equal(result.evidence.dispatch_accepted, false);
  assert.equal(result.thread_id, null);
  assert.equal(result.turn_id, null);
  for (let attempt = 0; attempt < 20 && processKills === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const responses = process.clientMessages.filter((message) => (
    typeof message.id === "string" && message.id.startsWith("orphan-overflow-") && !message.method
  ));
  assert.equal(responses.length, 257);
  assert.equal(new Set(responses.map((message) => message.id)).size, 257);
  assert.equal(responses.every((message) => message.result.success === false), true);
  assert.equal(responses.every((message) => Buffer.byteLength(JSON.stringify(message.result), "utf8") <= 64 * 1024), true);
  assert.equal(processKills, 1);
  assert.equal(diagnostics.some((diagnostic) => diagnostic.type === "server_request_listener_failed"), false);
});

test("uses only the real turn/start response as receipt when overflow orphans claim a forged turn", async () => {
  const process = new FakeAppServerProcess();
  process.kill = () => process.exit(0, null, true);
  attachTurnServer(process, (message) => {
    for (let index = 0; index < 257; index += 1) {
      process.send(dynamicToolCall(`forged-overflow-${index}`, "thread-1", "turn-forged"));
    }
    process.send({ id: message.id, result: { turn: makeTurn("turn-real") } });
  });
  const adapter = createAppServerAdapter({
    resolveRuntime: () => bundledRuntime(),
    spawnProcess: () => process,
    providerRetirementTimeoutMs: 10
  });
  await adapter.createThread({ correlationId: "corr-thread", params: {} });
  const result = await adapter.startTurn({
    correlationId: "corr-forged-overflow",
    threadId: "thread-1",
    input: [{ type: "text", text: "hello" }],
    dynamicToolHandlerFactory: Object.assign(() => dynamicToolHandler(), { preflight: () => {} })
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "runtime_outcome_unknown");
  assert.equal(result.evidence.dispatch_accepted, true);
  assert.equal(result.thread_id, "thread-1");
  assert.equal(result.turn_id, "turn-real");
  assert.notEqual(result.turn_id, "turn-forged");
});

test("fails a mismatched orphan scope while serving the exact accepted turn", async () => {
  const process = new FakeAppServerProcess();
  attachTurnServer(process, (message) => {
    process.send(dynamicToolCall("tool-mismatch", "thread-1", "turn-other"));
    process.send(dynamicToolCall("tool-match", "thread-1", "turn-1"));
    process.send({ id: message.id, result: { turn: makeTurn("turn-1") } });
  });
  const adapter = createAppServerAdapter({ resolveRuntime: () => bundledRuntime(), spawnProcess: () => process });
  await adapter.createThread({ correlationId: "corr-thread", params: {} });
  const result = await adapter.startTurn({
    correlationId: "corr-turn",
    threadId: "thread-1",
    input: [{ type: "text", text: "hello" }],
    dynamicToolHandlerFactory: Object.assign(() => dynamicToolHandler(), { preflight: () => {} })
  });
  assert.equal(result.ok, true);
  const mismatch = process.clientMessages.find((message) => message.id === "tool-mismatch" && !message.method);
  const match = process.clientMessages.find((message) => message.id === "tool-match" && !message.method);
  assert.equal(mismatch.result.success, false);
  assert.equal(match.result.success, true);
});

test("awaits dynamic handler quiescence before emitting an exact terminal event", async () => {
  const { adapter, process } = createHarness();
  const events = [];
  let releaseExpiry;
  let expiryStarted;
  const expiryStartedPromise = new Promise((resolve) => { expiryStarted = resolve; });
  const expiryGate = new Promise((resolve) => { releaseExpiry = resolve; });
  await adapter.subscribeEvents({ correlationId: "corr-sub", listener: (event) => events.push(event) });
  await adapter.createThread({ correlationId: "corr-thread", params: {} });
  const started = await adapter.startTurn({
    correlationId: "corr-turn",
    threadId: "thread-1",
    input: [{ type: "text", text: "hello" }],
    dynamicToolHandlerFactory: Object.assign(() => dynamicToolHandler({
      expire: async () => {
        expiryStarted();
        await expiryGate;
      }
    }), { preflight: () => {} })
  });
  assert.equal(started.ok, true);
  process.send({ method: "turn/completed", params: { threadId: "thread-1", turn: makeTurn("turn-1", "completed") } });
  await expiryStartedPromise;
  assert.equal(events.some((event) => event.type === "turn_completed"), false);

  process.send(dynamicToolCall("tool-after-terminal", "thread-1", "turn-1"));
  await new Promise((resolve) => setImmediate(resolve));
  const postTerminal = process.clientMessages.find((message) => message.id === "tool-after-terminal" && !message.method);
  assert.equal(postTerminal.result.success, false);
  assert.equal(JSON.stringify(postTerminal).includes("attachment marker"), false);
  releaseExpiry();
  for (let attempt = 0; attempt < 10 && !events.some((event) => event.type === "turn_completed"); attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(events.some((event) => event.type === "turn_completed"), true);
});

test("retires an exhausted Provider connection, releases its handler map, and ignores old-connection frames", async () => {
  const firstProcess = new FakeAppServerProcess();
  const replacementProcess = new FakeAppServerProcess();
  attachSuccessfulServer(firstProcess);
  attachSuccessfulServer(replacementProcess);
  let firstProcessKills = 0;
  firstProcess.kill = () => {
    firstProcessKills += 1;
    firstProcess.exit(0, null, true);
  };
  const processes = [firstProcess, replacementProcess];
  const expired = [];
  const adapter = createAppServerAdapter({
    resolveRuntime: () => bundledRuntime(),
    spawnProcess: () => processes.shift(),
    dynamicToolRequestIdCapacity: 2,
    providerRetirementTimeoutMs: 10,
    providerStreamIdFactory: (() => {
      let value = 0;
      return () => `provider-${++value}`;
    })()
  });
  await adapter.createThread({ correlationId: "corr-first-thread", params: {} });
  await adapter.startTurn({
    correlationId: "corr-first-turn",
    threadId: "thread-1",
    input: [{ type: "text", text: "hello" }],
    dynamicToolHandlerFactory: Object.assign(() => dynamicToolHandler({
      expire: async (reason) => { expired.push(reason); }
    }), { preflight: () => {} })
  });
  for (const id of ["capacity-1", "capacity-2", "capacity-overflow"]) {
    firstProcess.send(dynamicToolCall(id, "thread-1", "turn-1"));
    await new Promise((resolve) => setImmediate(resolve));
  }
  const overflow = firstProcess.clientMessages.find((message) => message.id === "capacity-overflow" && !message.method);
  assert.equal(overflow.result.success, false);

  const responsesBeforeOldFrame = firstProcess.clientMessages.filter((message) => !message.method && typeof message.id === "string").length;
  firstProcess.send(dynamicToolCall("old-after-retire", "thread-1", "turn-1"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    firstProcess.clientMessages.filter((message) => !message.method && typeof message.id === "string").length,
    responsesBeforeOldFrame
  );

  await adapter.resumeThread({ correlationId: "corr-replacement-thread", threadId: "thread-1", params: {} });
  assert.equal(firstProcessKills, 1);
  assert.deepEqual(expired, ["dynamic_tool_request_id_capacity_exhausted"]);
  await adapter.startTurn({
    correlationId: "corr-replacement-turn",
    threadId: "thread-1",
    input: [{ type: "text", text: "replacement" }],
    dynamicToolHandlerFactory: Object.assign(() => dynamicToolHandler(), { preflight: () => {} })
  });
  replacementProcess.send(dynamicToolCall("capacity-1", "thread-1", "turn-1"));
  await new Promise((resolve) => setImmediate(resolve));
  const replacementResponse = replacementProcess.clientMessages.find((message) => message.id === "capacity-1" && !message.method);
  assert.equal(replacementResponse.result.success, true);
  const replacementMethods = replacementProcess.clientMessages
    .filter((message) => typeof message.method === "string")
    .map((message) => message.method);
  assert.ok(replacementMethods.indexOf("thread/resume") < replacementMethods.indexOf("turn/start"));
});
