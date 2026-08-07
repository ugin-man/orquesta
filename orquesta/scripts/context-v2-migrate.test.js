"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { migrateContextV2 } = require("./context-v2-migrate");

test("migration binds only unstarted tasks and leaves working tasks byte-equivalent", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-context-migrate-"));
  try {
    fs.mkdirSync(path.join(root, ".orquesta", "state"), { recursive: true });
    fs.mkdirSync(path.join(root, ".orquesta", "project"), { recursive: true });
    fs.writeFileSync(path.join(root, "README.md"), "# Local project\n", "utf8");
    const working = { task_id: "T-WORK", title: "Existing work", state: "working", owner_agent_id: "implementation-001", started_at: "2026-07-31T00:00:00.000Z" };
    fs.writeFileSync(path.join(root, ".orquesta", "state", "tasks.json"), JSON.stringify({ version: 1, tasks: [
      { task_id: "T-READY", title: "Review README", state: "ready", owner_agent_id: "research-001", scope_boundaries: ["README.md"], work_mode: "report_only" },
      working,
    ] }), "utf8");
    fs.writeFileSync(path.join(root, ".orquesta", "project", "project_understanding.json"), JSON.stringify({ project_name: "Migration fixture", goal: "Review local project", evidence: [{ path: "README.md" }] }), "utf8");

    const result = migrateContextV2(root, { apply: true, now: () => "2026-08-01T00:00:00.000Z" });
    assert.deepEqual(result.migrated_task_ids, ["T-READY"]);
    const tasks = JSON.parse(fs.readFileSync(path.join(root, ".orquesta", "state", "tasks.json"), "utf8"));
    const ready = tasks.tasks.find((task) => task.task_id === "T-READY");
    assert.match(ready.task_profile.context_pack_id, /^CP2-/u);
    assert.ok(ready.task_profile.context_route.route);
    assert.deepEqual(tasks.tasks.find((task) => task.task_id === "T-WORK"), working);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("migration is a no-op when every task has started or terminated", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-context-migrate-noop-"));
  try {
    fs.mkdirSync(path.join(root, ".orquesta", "state"), { recursive: true });
    fs.writeFileSync(path.join(root, ".orquesta", "state", "tasks.json"), JSON.stringify({ tasks: [
      { task_id: "T-DONE", state: "accepted" }, { task_id: "T-RUN", state: "working" },
    ] }), "utf8");
    const before = fs.readFileSync(path.join(root, ".orquesta", "state", "tasks.json"), "utf8");
    const result = migrateContextV2(root, { apply: true });
    assert.equal(result.changed, false);
    assert.equal(fs.readFileSync(path.join(root, ".orquesta", "state", "tasks.json"), "utf8"), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
