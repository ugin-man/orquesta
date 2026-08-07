import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  measureSessionDelta,
  measureSessionRootsDelta,
  snapshotSessions
} from "../scripts/lib/session-usage.mjs";

const fixtures = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "sessions"
);

async function copyFixture(name, target) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(path.join(fixtures, name), target);
}

test("separates uncached input and sums every matching thread", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orquesta-session-usage-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const day = path.join(root, "2026", "07", "22");
  const main = path.join(day, "main.jsonl");
  await copyFixture("main.before.jsonl", main);
  const baseline = await snapshotSessions({
    sessionsRoot: root,
    workspaceRoot: "C:\\bench\\workspace"
  });
  await copyFixture("main.after.jsonl", main);
  await copyFixture("child.after.jsonl", path.join(day, "child.jsonl"));
  await copyFixture("other.after.jsonl", path.join(day, "other.jsonl"));

  const evidence = await measureSessionDelta({
    baseline,
    sessionsRoot: root,
    workspaceRoot: "C:\\bench\\workspace",
    startedAt: "2026-07-22T00:00:30.000Z",
    endedAt: "2026-07-22T00:03:00.000Z"
  });

  assert.equal(evidence.coverage, "complete");
  assert.equal(evidence.by_thread.length, 2);
  assert.deepEqual(evidence.totals, {
    input_tokens: 100,
    uncached_input_tokens: 50,
    cached_input_tokens: 50,
    output_tokens: 25,
    reasoning_output_tokens: 6,
    total_tokens: 125
  });
  assert.equal(evidence.by_model["gpt-5.6-sol"].uncached_input_tokens, 20);
  assert.equal(evidence.by_model["gpt-5.6-terra"].uncached_input_tokens, 30);
  assert.equal(evidence.turn_count, 3);
});

test("aggregates multiple CODEX_HOME session roots without duplicate thread ids", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "orquesta-session-roots-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const first = path.join(temp, "plain-sessions");
  const second = path.join(temp, "common-sessions");
  await copyFixture("main.after.jsonl", path.join(first, "main.jsonl"));
  await copyFixture("child.after.jsonl", path.join(second, "child.jsonl"));

  const evidence = await measureSessionRootsDelta({
    roots: [
      { label: "plain", sessionsRoot: first, baseline: { sessions: {} } },
      { label: "common", sessionsRoot: second, baseline: { sessions: {} } }
    ],
    workspaceRoot: "C:\\bench\\workspace",
    startedAt: "2026-07-22T00:00:00.000Z",
    endedAt: "2026-07-22T00:03:00.000Z"
  });

  assert.equal(evidence.coverage, "complete");
  assert.deepEqual(
    evidence.by_thread.map(({ thread_id, source_root }) => [thread_id, source_root]),
    [
      ["thread-child", "common"],
      ["thread-main", "plain"]
    ]
  );
  assert.equal(evidence.totals.total_tokens, 245);
});

test("marks duplicate thread evidence across roots as partial instead of double-counting", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "orquesta-session-duplicate-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const first = path.join(temp, "first");
  const second = path.join(temp, "second");
  await copyFixture("main.after.jsonl", path.join(first, "main.jsonl"));
  await copyFixture("main.after.jsonl", path.join(second, "main.jsonl"));

  const evidence = await measureSessionRootsDelta({
    roots: [
      { label: "first", sessionsRoot: first, baseline: { sessions: {} } },
      { label: "second", sessionsRoot: second, baseline: { sessions: {} } }
    ],
    workspaceRoot: "C:\\bench\\workspace"
  });

  assert.equal(evidence.coverage, "partial");
  assert.deepEqual(evidence.duplicate_thread_ids, ["thread-main"]);
  assert.equal(evidence.by_thread.length, 1);
  assert.equal(evidence.totals.total_tokens, 195);
});

test("returns unknown instead of zero when no matching session exists", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orquesta-session-empty-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const baseline = await snapshotSessions({
    sessionsRoot: root,
    workspaceRoot: "C:\\bench\\workspace"
  });
  const evidence = await measureSessionDelta({
    baseline,
    sessionsRoot: root,
    workspaceRoot: "C:\\bench\\workspace"
  });
  assert.equal(evidence.coverage, "unknown");
  assert.equal(evidence.totals, null);
  assert.deepEqual(evidence.by_thread, []);
});

test("counts token deltas only inside the requested phase window", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orquesta-session-window-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "window.jsonl");
  const rows = [
    {
      timestamp: "2026-07-22T00:00:00.000Z",
      type: "session_meta",
      payload: { id: "thread-window", cwd: "C:\\bench\\workspace" }
    },
    {
      timestamp: "2026-07-22T00:00:30.000Z",
      type: "turn_context",
      payload: { model: "gpt-5.6-terra", effort: "medium" }
    },
    {
      timestamp: "2026-07-22T00:01:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 80,
            cached_input_tokens: 20,
            output_tokens: 20,
            reasoning_output_tokens: 4,
            total_tokens: 100
          }
        }
      }
    },
    {
      timestamp: "2026-07-22T00:05:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 160,
            cached_input_tokens: 40,
            output_tokens: 40,
            reasoning_output_tokens: 8,
            total_tokens: 200
          }
        }
      }
    }
  ];
  await fs.writeFile(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");

  const evidence = await measureSessionDelta({
    baseline: { sessions: {} },
    sessionsRoot: root,
    workspaceRoot: "C:\\bench\\workspace",
    startedAt: "2026-07-22T00:00:00.000Z",
    endedAt: "2026-07-22T00:02:00.000Z"
  });

  assert.equal(evidence.coverage, "complete");
  assert.equal(evidence.totals.total_tokens, 100);
  assert.equal(evidence.totals.uncached_input_tokens, 60);
  assert.equal(evidence.by_thread[0].measured_tokens, 100);
});
