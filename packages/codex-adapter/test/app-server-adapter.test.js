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
    executablePath: "C:\\runtime\\codex.exe",
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

test("uses the default Codex command only after an injected spawnability lookup", async () => {
  const unavailable = createAppServerAdapter({
    findExecutable: () => null,
    spawnProcess: () => {
      throw new Error("must not spawn");
    }
  });
  const unavailableResult = await unavailable.createThread({
    correlationId: "corr-unavailable",
    params: {}
  });
  assert.equal(unavailableResult.ok, false);
  assert.equal(unavailableResult.status, "unavailable");

  const process = new FakeAppServerProcess();
  attachSuccessfulServer(process);
  const commands = [];
  const available = createAppServerAdapter({
    findExecutable: (command) => command === "codex" ? "C:\\resolved\\codex.exe" : null,
    spawnProcess: (command) => {
      commands.push(command);
      return process;
    }
  });
  const result = await available.createThread({ correlationId: "corr-available", params: {} });
  assert.equal(result.ok, true);
  assert.deepEqual(commands, ["C:\\resolved\\codex.exe"]);
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
  assert.equal(approval.request_id, "approval-1");
  assert.equal(approval.correlation_id, "corr-turn");

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
    executablePath: "C:\\runtime\\codex.exe",
    spawnProcess: () => process
  });

  const result = await adapter.createThread({ correlationId: "corr-invalid", params: {} });
  assert.equal(result.ok, false);
  assert.equal(result.status, "failed");
  assert.match(result.error.message, /schema.*approvalPolicy/i);
});
