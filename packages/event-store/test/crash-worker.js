"use strict";

const [mode, stateRoot, batchId = "crash-batch", eventId = "crash-event"] = process.argv.slice(2);

if (!mode) process.exit(0);

const { createEventStore } = require("../src");

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
    lockTimeoutMs: 50,
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
