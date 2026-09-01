const readline = require("node:readline");

function thread(id) {
  return {
    cliVersion: "0.144.5",
    createdAt: 1,
    cwd: process.cwd(),
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

function turn(id, status = "inProgress") {
  return { id, items: [], status };
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({
      id: message.id,
      result: {
        codexHome: process.cwd(),
        platformFamily: process.platform,
        platformOs: process.platform,
        userAgent: "coalesced-test-child"
      }
    });
    return;
  }
  if (message.method === "thread/start") {
    send({
      id: message.id,
      result: {
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        cwd: process.cwd(),
        model: "test-model",
        modelProvider: "openai",
        sandbox: "workspace-write",
        thread: thread("real-process-thread")
      }
    });
    return;
  }
  if (message.method === "turn/start") {
    const frames = [
      { id: message.id, result: { turn: turn("real-process-turn") } },
      {
        method: "turn/started",
        params: { threadId: "real-process-thread", turn: turn("real-process-turn") }
      },
      {
        id: "real-process-provider-approval",
        method: "item/commandExecution/requestApproval",
        params: {
          itemId: "real-process-item",
          startedAtMs: 1,
          threadId: "real-process-thread",
          turnId: "real-process-turn"
        }
      }
    ];
    // One write is intentional: this exercises multiple JSONL frames coalesced in
    // a real child-process stdout chunk rather than only an in-memory fake stream.
    process.stdout.write(`${frames.map(JSON.stringify).join("\n")}\n`);
  }
});

input.on("close", () => {
  process.stdout.end();
});
