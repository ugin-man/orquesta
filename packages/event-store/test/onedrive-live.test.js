"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createEventStore } = require("../src");

function cleanupTree(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) cleanupTree(target);
    else fs.unlinkSync(target);
  }
  fs.rmdirSync(directory);
}

function runLiveWorker(root, index) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "crash-worker.js"), "live", root, `live-${index}`, `live-event-${index}`], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr, pid: child.pid, index }));
  });
}

async function runBoundedLiveWorkers(root, total, concurrency) {
  const results = [];
  let next = 1;
  async function consume() {
    for (;;) {
      const index = next;
      next += 1;
      if (index > total) return;
      results.push(await runLiveWorker(root, index));
    }
  }
  await Promise.all(Array.from({ length: concurrency }, consume));
  return results.sort((left, right) => left.index - right.index);
}

test("OneDrive probe commits 24 unique batches from real child processes and removes verified probe artifacts", async () => {
  const workspace = path.resolve(__dirname, "../../..");
  const root = path.join(workspace, ".orquesta", "v4", `.probe-${process.pid}`);
  fs.mkdirSync(root, { recursive: true });
  try {
    const workers = await runBoundedLiveWorkers(root, 24, 4);
    assert.deepEqual(workers.map(({ code }) => code), Array(24).fill(0), workers.map(({ stderr }) => stderr).join("\n"));
    assert.equal(new Set(workers.map(({ pid }) => pid)).size, 24);
    const store = createEventStore({ stateRoot: root, workspaceId: "onedrive" });
    const replay = store.replay({ reducers: {}, initialState: {} });
    assert.equal(replay.watermark.journal_sequence, 24);
    const lines = fs.readFileSync(path.join(root, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(lines.map((entry) => entry.sequence), Array.from({ length: 24 }, (_, index) => index + 1));
    assert.equal(new Set(lines.map((entry) => entry.batch_id)).size, 24);
    assert.equal(new Set(lines.flatMap((entry) => entry.events.map((event) => event.event_id))).size, 24);
    assert.equal(fs.existsSync(path.join(root, "events.jsonl.lock")), false);
    store.removeProbeTree(root, workspace);
    assert.equal(fs.existsSync(root), false);
    assert.equal(fs.existsSync(root) ? fs.readdirSync(root).length : 0, 0);
  } finally {
    if (fs.existsSync(root)) cleanupTree(root);
  }
});

test("probe cleanup rejects path escapes, symlinks, and unknown artifacts", () => {
  const workspace = path.resolve(__dirname, "../../..");
  const root = path.join(workspace, ".orquesta", "v4", `.probe-cleanup-${process.pid}`);
  fs.mkdirSync(root, { recursive: true });
  try {
    const store = createEventStore({ stateRoot: root, workspaceId: "onedrive" });
    assert.throws(() => store.removeProbeTree(path.join(os.tmpdir(), ".probe-outside"), workspace), { code: "EVENT_PROBE_PATH_INVALID" });
    fs.writeFileSync(path.join(root, "surprise.json"), "{}\n");
    assert.throws(() => store.removeProbeTree(root, workspace), { code: "EVENT_PROBE_UNSAFE_ARTIFACT" });
    fs.unlinkSync(path.join(root, "surprise.json")); fs.mkdirSync(path.join(root, "unknown"));
    assert.throws(() => store.removeProbeTree(root, workspace), { code: "EVENT_PROBE_UNSAFE_ARTIFACT" });
    fs.rmdirSync(path.join(root, "unknown"));
    fs.symlinkSync(os.tmpdir(), path.join(root, "outside-link"), "junction");
    assert.throws(() => store.removeProbeTree(root, workspace), { code: "EVENT_PROBE_UNSAFE_ARTIFACT" });
    fs.unlinkSync(path.join(root, "outside-link")); fs.mkdirSync(path.join(root, "root-target")); fs.writeFileSync(path.join(root, "root-target", "events.jsonl"), "outside\n"); const rootLink = path.join(workspace, ".orquesta", "v4", `.probe-root-link-${process.pid}`); fs.symlinkSync(path.join(root, "root-target"), rootLink, "junction");
    assert.throws(() => store.removeProbeTree(rootLink, workspace), { code: "EVENT_PROBE_UNSAFE_ARTIFACT" }); assert.equal(fs.readFileSync(path.join(root, "root-target", "events.jsonl"), "utf8"), "outside\n"); fs.unlinkSync(rootLink);
  } finally { if (fs.existsSync(root)) cleanupTree(root); }
});
