#!/usr/bin/env node

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  checkDelegationGate,
  checkTask
} = require("./delegation-gate-check");

function writeTasks(root, tasks) {
  const tasksPath = path.join(root, ".orquesta", "state", "tasks.json");
  fs.mkdirSync(path.dirname(tasksPath), { recursive: true });
  fs.writeFileSync(tasksPath, JSON.stringify({ version: 1, tasks }, null, 2), "utf8");
}

function main() {
  assert.deepStrictEqual(checkTask({
    task_id: "T001",
    state: "accepted",
    owner_agent_id: "implementation-001",
    routing_class: "specialist_required",
    routing_gate_status: "passed",
    handoff_required: true,
    handoff_sent_at: "2026-06-23T00:00:00.000Z",
    specialist_report_required: true,
    specialist_report_path: ".orquesta/reports/T001-implementation.md"
  }).errors, []);

  assert.match(checkTask({
    task_id: "T002",
    state: "accepted",
    owner_agent_id: "implementation-001",
    routing_class: "specialist_required",
    routing_gate_status: "passed",
    handoff_required: true,
    specialist_report_required: true
  }).errors.join("\n"), /handoff_sent_at/);

  assert.match(checkTask({
    task_id: "T003",
    state: "accepted",
    owner_agent_id: "implementation-001",
    routing_class: "specialist_required",
    routing_gate_status: "passed",
    handoff_required: true,
    handoff_sent_at: "2026-06-23T00:00:00.000Z",
    specialist_report_required: true
  }).errors.join("\n"), /specialist report/);

  assert.match(checkTask({
    task_id: "T004",
    state: "active",
    owner_agent_id: "orchestrator",
    routing_class: "direct_exception",
    routing_gate_status: "passed"
  }).errors.join("\n"), /direct_exception_reason/);

  const warningResult = checkTask({
    task_id: "T005",
    state: "accepted",
    owner_agent_id: "orchestrator",
    title: "Update dashboard UX"
  });
  assert.strictEqual(warningResult.errors.length, 0);
  assert.match(warningResult.warnings.join("\n"), /specialist-domain/);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-delegation-gate-"));
  try {
    writeTasks(root, [
      {
        task_id: "T006",
        state: "accepted",
        owner_agent_id: "docs-release-001",
        routing_class: "specialist_required",
        routing_gate_status: "passed",
        handoff_required: true,
        handoff_sent_at: "2026-06-23T00:00:00.000Z",
        specialist_report_required: true,
        artifacts: [".orquesta/reports/T006-docs-release.md"]
      }
    ]);
    assert.deepStrictEqual(checkDelegationGate(root).errors, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log("delegation gate tests passed");
}

main();
