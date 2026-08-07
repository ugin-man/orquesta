"use strict";

const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { promisify } = require("node:util");
const { createDefaultPhaseHandlers } = require("./setup-phase-handlers");
const { createSetupEngine } = require("./setup-engine");
const { runCli } = require("./context-v2-broker");

const NOW = "2026-07-31T00:00:00.000Z";
const roots = [];
const execFileAsync = promisify(execFile);

test.afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const parent = await mkdtemp(path.join(os.tmpdir(), "orquesta-context-cli-"));
  roots.push(parent);
  const root = path.join(parent, "project");
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "README.md"), "# Demo\n", "utf8");
  await writeFile(path.join(root, "src", "app.js"), "export const app = true;\n", "utf8");
  const engine = createSetupEngine({ now: () => NOW, randomUUID: () => "11111111-2222-4333-8444-555555555555" });
  const started = await engine.start({
    rootPath: root,
    draft: {
      revision: 1,
      status: "draft",
      source: { kind: "detected_root", rootPath: root },
      projectName: "Context CLI",
      description: "Implement a small local application.",
      questions: [],
      answers: [],
    },
  });
  const handlers = createDefaultPhaseHandlers({
    now: () => NOW,
    provisionFoundation: async ({ agentIds }) => agentIds.map((agentId) => ({
      agent_id: agentId,
      status: "accepted",
      thread_id: `thread-${agentId}`,
      turn_id: `turn-${agentId}`,
    })),
    provisionSpecialists: async ({ batch }) => ({
      ...batch,
      requests: batch.requests.map((request, index) => ({
        ...request,
        status: "standby",
        handoff_status: "accepted",
        thread_id: `thread-${index}`,
        turn_id: `turn-${index}`,
        completed_at: NOW,
      })),
    }),
  });
  await handlers.understanding({ rootPath: root, setupState: started.setup_state });
  await handlers.foundation({ rootPath: root, setupState: started.setup_state });
  await handlers.planning({ rootPath: root, setupState: started.setup_state });
  const completionPath = path.join(root, ".orquesta", "project", "completion_map.json");
  const completion = JSON.parse(await readFile(completionPath, "utf8"));
  completion.tasks[0].context_manifest = {
    required_reading: ["README.md"],
    allowed_files: ["src/app.js"],
    excluded_context: ["unrelated_project_context"],
  };
  await writeFile(completionPath, JSON.stringify(completion), "utf8");
  await handlers.specialists({ rootPath: root, setupState: started.setup_state });
  const tasks = JSON.parse(await readFile(path.join(root, ".orquesta", "state", "tasks.json"), "utf8"));
  return { root, taskId: tasks.tasks[0].task_id };
}

function capture() {
  let value = "";
  return { stdout: { write(chunk) { value += chunk; } }, value: () => value };
}

test("file-backed CLI opens selected context and persists one receipt", async () => {
  const { root, taskId } = await fixture();
  const statusOutput = capture();
  const status = await runCli(["--root", root, "--task", taskId, "status"], { stdout: statusOutput.stdout, now: () => NOW });
  assert.equal(status.context_pack_id.startsWith("CP2-"), true);
  const selectedRef = JSON.parse(await readFile(path.join(root, ".orquesta", "context", "source_catalog.json"), "utf8"))
    .records.find((record) => status.initially_selected_source_ids.includes(record.source_id)
      && !record.source_ref.includes(":"))?.source_ref;
  assert.ok(selectedRef);

  const openOutput = capture();
  const opened = await runCli(
    ["--root", root, "--task", taskId, "open", "--source", selectedRef, "--max-tokens", "50"],
    { stdout: openOutput.stdout, now: () => NOW },
  );
  assert.equal(opened.status, "opened");

  const receiptOutput = capture();
  const receipt = await runCli(
    ["--root", root, "--task", taskId, "receipt"],
    { stdout: receiptOutput.stdout, now: () => NOW },
  );
  assert.equal(receipt.receipt.used_source_ids.length, 1);
  assert.equal(receipt.reconciliation.branch_delta.transition, "verification_incomplete");
  await readFile(path.join(root, ".orquesta", "context", "receipts", `${receipt.receipt.receipt_id}.json`), "utf8");
  await readFile(
    path.join(root, ".orquesta", "context", "branch_deltas", `${receipt.reconciliation.branch_delta.branch_delta_id}.json`),
    "utf8",
  );
  const receiptIndex = JSON.parse(await readFile(
    path.join(root, ".orquesta", "context", "receipt_index.json"),
    "utf8",
  ));
  assert.deepEqual(receiptIndex.receipts.map((entry) => entry.receipt_id), [receipt.receipt.receipt_id]);
});

test("opens a selected source batch and persists one complete session update", async () => {
  const { root, taskId } = await fixture();
  const status = await runCli(
    ["--root", root, "--task", taskId, "status"],
    { stdout: capture().stdout, now: () => NOW },
  );
  const sourceIds = status.initially_selected_source_ids.slice(0, 2);
  assert.equal(sourceIds.length, 2);

  const result = await runCli(
    ["--root", root, "--task", taskId, "open", "--source", sourceIds.join(",")],
    { stdout: capture().stdout, now: () => NOW },
  );
  assert.equal(result.opened.length, 2);
  assert.deepEqual(result.opened.map((entry) => entry.source_id).sort(), [...sourceIds].sort());

  const session = JSON.parse(await readFile(
    path.join(root, ".orquesta", "context", "sessions", `${encodeURIComponent(taskId)}.json`),
    "utf8",
  ));
  assert.deepEqual(session.used_source_ids.sort(), [...sourceIds].sort());
  assert.equal(session.read_events.length, 2);
});

test("bootstraps all initially selected context with one command and one session update", async () => {
  const { root, taskId } = await fixture();

  const result = await runCli(
    ["--root", root, "--task", taskId, "bootstrap"],
    { stdout: capture().stdout, now: () => NOW },
  );

  assert.equal(result.status, "bootstrapped");
  assert.ok(result.initially_selected_source_ids.length > 0);
  assert.deepEqual(
    result.opened.map((entry) => entry.source_id).sort(),
    [...result.initially_selected_source_ids].sort(),
  );
  assert.equal(result.opened.every((entry) => entry.status === "opened"), true);
  assert.equal(result.opened_tokens > 0, true);

  const session = JSON.parse(await readFile(
    path.join(root, ".orquesta", "context", "sessions", `${encodeURIComponent(taskId)}.json`),
    "utf8",
  ));
  assert.deepEqual(
    session.used_source_ids.sort(),
    [...result.initially_selected_source_ids].sort(),
  );
  assert.equal(session.read_events.length, result.initially_selected_source_ids.length);
  assert.equal(session.opened_tokens, result.opened_tokens);
});

test("file-backed CLI indexes without bodies and persists rehydration as one session update", async () => {
  const { root, taskId } = await fixture();
  const index = await runCli(
    ["--root", root, "--task", taskId, "index"],
    { stdout: capture().stdout, now: () => NOW },
  );
  assert.ok(index.length > 0);
  assert.equal(index.some((entry) => Object.hasOwn(entry, "content")), false);

  const result = await runCli(
    ["--root", root, "--task", taskId, "rehydrate"],
    { stdout: capture().stdout, now: () => NOW },
  );
  assert.equal(result.status, "rehydrated");
  assert.ok(result.opened.some((entry) => entry.source_ref.startsWith("task_intent:")));
  const session = JSON.parse(await readFile(
    path.join(root, ".orquesta", "context", "sessions", `${encodeURIComponent(taskId)}.json`),
    "utf8",
  ));
  assert.equal(session.updated_at, NOW);
});

test("portable skill broker supports index and rehydrate without monorepo packages", async () => {
  const { root, taskId } = await fixture();
  const portableRoot = path.join(path.dirname(root), "portable-skill");
  const portableScripts = path.join(portableRoot, "scripts");
  const portableRuntime = path.join(portableRoot, "runtime");
  await mkdir(portableScripts, { recursive: true });
  await mkdir(portableRuntime, { recursive: true });
  await copyFile(
    path.join(__dirname, "context-v2-broker.js"),
    path.join(portableScripts, "context-v2-broker.js"),
  );
  await copyFile(
    path.join(__dirname, "..", "runtime", "context-v2-runtime.cjs"),
    path.join(portableRuntime, "context-v2-runtime.cjs"),
  );
  await cp(
    path.join(__dirname, "..", "schemas"),
    path.join(portableRoot, "schemas"),
    { recursive: true },
  );

  const { stdout } = await execFileAsync(process.execPath, [
    path.join(portableScripts, "context-v2-broker.js"),
    "--root",
    root,
    "--task",
    taskId,
    "index",
  ], { encoding: "utf8" });
  const index = JSON.parse(stdout);

  assert.ok(index.length > 0);
  assert.equal(index.some((entry) => Object.hasOwn(entry, "content")), false);

  const rehydrated = await execFileAsync(process.execPath, [
    path.join(portableScripts, "context-v2-broker.js"),
    "--root",
    root,
    "--task",
    taskId,
    "rehydrate",
  ], { encoding: "utf8" });
  const result = JSON.parse(rehydrated.stdout);

  assert.equal(result.status, "rehydrated");
  assert.ok(result.opened.length > 0);
});
