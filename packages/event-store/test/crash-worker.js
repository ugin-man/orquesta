"use strict";

const [mode, stateRoot, batchId = "crash-batch", eventId = "crash-event"] = process.argv.slice(2);

if (!mode) process.exit(0);

const { createEventStore } = require("../src");

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

if (mode === "barrier") {
  const fs = require("node:fs");
  const path = require("node:path");
  fs.writeFileSync(path.join(stateRoot, `.ready-${batchId}`), "ready\n", "utf8");
  const startPath = path.join(stateRoot, ".start");
  const deadline = Date.now() + 2000;
  while (!fs.existsSync(startPath) && Date.now() < deadline) sleep(5);
  if (!fs.existsSync(startPath)) {
    process.stderr.write('{"code":"EVENT_TEST_BARRIER_TIMEOUT"}\n');
    process.exit(2);
  }
}

const request = {
  expected_revision: 0,
  batch_id: batchId,
  actor: { type: "agent", id: "implementation-001" },
  correlation_id: `correlation-${batchId}`,
  events: [{
    event_id: eventId,
    schema_version: 1,
    type: "task.updated",
    payload: { worker: mode },
    evidence_refs: ["test://crash-worker"],
  }],
};

try {
  const store = createEventStore({
    stateRoot,
    workspaceId: "workspace-a",
    lockTimeoutMs: mode === "barrier" ? 500 : 50,
    testLockHooks: mode === "barrier" ? {
      afterAcquire() { sleep(75); },
      onContention() {
        require("node:fs").writeFileSync(require("node:path").join(stateRoot, ".contention-observed"), "yes\n", "utf8");
      },
    } : undefined,
    testFailureInjector(point) {
      if (mode === "crash" && point === "after_pending_fsync") {
        process.exit(86);
      }
    },
  });
  const result = store.commit(request);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ code: error.code, message: error.message })}\n`);
  process.exitCode = 1;
}
