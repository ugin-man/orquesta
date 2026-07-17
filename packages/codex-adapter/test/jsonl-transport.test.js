const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");

const { createJsonlTransport } = require("../src/jsonl-transport");
const { FakeAppServerProcess } = require("./fixtures/fake-app-server");

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("parses partial and multiple JSONL notifications without merging lines", async () => {
  const process = new FakeAppServerProcess();
  const notifications = [];
  const transport = createJsonlTransport({ process });
  transport.onNotification((message) => notifications.push(message));

  const first = { method: "turn/started", params: { threadId: "th-1", turn: { id: "tu-1" } } };
  const second = { method: "item/started", params: { threadId: "th-1", turnId: "tu-1", item: {}, startedAtMs: 1 } };
  const firstLine = Buffer.from(`${JSON.stringify(first)}\n`, "utf8");
  process.sendRaw(firstLine.subarray(0, 7));
  assert.deepEqual(notifications, []);
  process.sendRaw(Buffer.concat([
    firstLine.subarray(7),
    Buffer.from(`${JSON.stringify(second)}\n`, "utf8")
  ]));
  await nextTurn();

  assert.deepEqual(notifications, [first, second]);
});

test("rejects pending requests on invalid UTF-8, invalid JSON, and oversized lines", async (t) => {
  const cases = [
    { name: "invalid UTF-8", bytes: Buffer.from([0xc3, 0x28, 0x0a]), pattern: /UTF-8/i },
    { name: "invalid JSON", bytes: Buffer.from("{nope}\n"), pattern: /JSON/i },
    { name: "oversized", bytes: Buffer.from("123456789\n"), pattern: /maximum JSONL line/i }
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const process = new FakeAppServerProcess();
      const errors = [];
      const transport = createJsonlTransport({
        process,
        maxLineBytes: entry.name === "oversized" ? 8 : 1024,
        onProtocolError: (error) => errors.push(error)
      });
      const pending = transport.request("initialize", {});
      process.sendRaw(entry.bytes);
      await assert.rejects(pending, entry.pattern);
      assert.match(errors[0].message, entry.pattern);
    });
  }
});

test("resolves matching responses and rejects duplicate or unknown response IDs", async (t) => {
  await t.test("matching and duplicate", async () => {
    const process = new FakeAppServerProcess();
    const errors = [];
    const transport = createJsonlTransport({
      process,
      onProtocolError: (error) => errors.push(error)
    });
    const outbound = once(process, "clientMessage");
    const pending = transport.request("initialize", { clientInfo: {} });
    const [request] = await outbound;
    process.send({ id: request.id, result: { userAgent: "codex" } });
    assert.deepEqual(await pending, { userAgent: "codex" });

    process.send({ id: request.id, result: {} });
    await nextTurn();
    assert.match(errors[0].message, /duplicate response ID/i);
  });

  await t.test("unknown", async () => {
    const process = new FakeAppServerProcess();
    const errors = [];
    createJsonlTransport({ process, onProtocolError: (error) => errors.push(error) });
    process.send({ id: 999, result: {} });
    await nextTurn();
    assert.match(errors[0].message, /unknown response ID/i);
  });
});

test("rejects every pending request when the process exits", async () => {
  const process = new FakeAppServerProcess();
  const transport = createJsonlTransport({ process });
  const first = transport.request("initialize", {});
  const second = transport.request("thread/start", {});
  process.exit(17);

  await assert.rejects(first, /exited.*17/i);
  await assert.rejects(second, /exited.*17/i);
});

test("redacts stderr diagnostics and bounds the pending request map", async () => {
  const process = new FakeAppServerProcess();
  const diagnostics = [];
  const transport = createJsonlTransport({
    process,
    maxPending: 2,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
  });
  const first = transport.request("initialize", {});
  const second = transport.request("thread/start", {});
  await assert.rejects(
    transport.request("turn/start", {}),
    /pending request limit.*2/i
  );

  process.writeStderr("Authorization: Bearer super-secret-token api_key=hidden\n");
  await nextTurn();
  assert.equal(JSON.stringify(diagnostics).includes("super-secret-token"), false);
  assert.equal(JSON.stringify(diagnostics).includes("hidden"), false);

  process.exit(1);
  await assert.rejects(first);
  await assert.rejects(second);
});

test("keeps notifications and server requests separate and writes explicit responses", async () => {
  const process = new FakeAppServerProcess();
  const notifications = [];
  const serverRequests = [];
  const transport = createJsonlTransport({ process });
  transport.onNotification((message) => notifications.push(message));
  transport.onServerRequest((message) => serverRequests.push(message));

  process.send({ method: "turn/started", params: { threadId: "th", turn: { id: "tu" } } });
  process.send({ id: "approval-1", method: "item/fileChange/requestApproval", params: { threadId: "th", turnId: "tu" } });
  await nextTurn();
  assert.equal(notifications.length, 1);
  assert.equal(serverRequests.length, 1);

  const outbound = once(process, "clientMessage");
  transport.respond("approval-1", { decision: "decline" });
  const [response] = await outbound;
  assert.deepEqual(response, { id: "approval-1", result: { decision: "decline" } });
});
