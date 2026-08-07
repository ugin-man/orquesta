"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { installSessionRotationHook } = require("./session-rotation-hook-install");

test("installs once without deleting existing project hooks", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-hook-install-"));
  const configPath = path.join(root, ".codex", "hooks.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({
    description: "Existing",
    hooks: { Stop: [{ hooks: [{ type: "command", command: "node stop.js" }] }] },
  }, null, 2)}\n`, "utf8");
  const scriptPath = path.join(root, "skill", "session-rotation-hook.js");

  const first = installSessionRotationHook({ projectRoot: root, scriptPath });
  const second = installSessionRotationHook({ projectRoot: root, scriptPath });
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

  assert.equal(first.status, "installed");
  assert.equal(first.requiresTrustReview, true);
  assert.equal(second.status, "unchanged");
  assert.equal(config.hooks.Stop.length, 1);
  assert.equal(config.hooks.PostCompact.length, 1);
  assert.match(config.hooks.PostCompact[0].hooks[0].commandWindows, /session-rotation-hook\.js/u);
});

test("writes a project-local portable hook that records a compaction without the source checkout", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-portable-hook-"));
  const state = path.join(root, ".orquesta", "state");
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, "sessions.json"), JSON.stringify({
    sessions: [{ session_id: "session-1", thread_id: "thread-1", agent_id: "orchestrator", session_generation: 1 }],
  }), "utf8");

  const installed = installSessionRotationHook({ projectRoot: root });
  const result = spawnSync(process.execPath, [installed.runtimePath], {
    cwd: root,
    input: JSON.stringify({
      hook_event_name: "PostCompact",
      session_id: "thread-1",
      turn_id: "turn-1",
      trigger: "auto",
      cwd: root,
    }),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const registry = JSON.parse(fs.readFileSync(path.join(state, "session-rotation.json"), "utf8"));
  assert.equal(registry.sessions["session-1"].compaction_count, 1);
  assert.match(fs.readFileSync(path.join(root, ".codex", "hooks.json"), "utf8"), /session-rotation-hook\.cjs/u);
});

test("installs a canonical runtime into a recorded task placement and writes only canonical health state", () => {
  const canonicalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-canonical-hook-"));
  const placementRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-placement-hook-"));
  const state = path.join(canonicalRoot, ".orquesta", "state");
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, "sessions.json"), JSON.stringify({
    sessions: [{ session_id: "session-1", thread_id: "thread-1", agent_id: "orchestrator", session_generation: 1 }],
  }), "utf8");

  const first = installSessionRotationHook({ projectRoot: placementRoot, canonicalRoot });
  const second = installSessionRotationHook({ projectRoot: placementRoot, canonicalRoot });
  const result = spawnSync(process.execPath, [first.runtimePath], {
    cwd: placementRoot,
    input: JSON.stringify({
      hook_event_name: "PostCompact",
      session_id: "thread-1",
      turn_id: "turn-1",
      trigger: "auto",
      cwd: placementRoot,
    }),
    encoding: "utf8",
  });

  assert.equal(first.status, "installed");
  assert.equal(second.status, "unchanged");
  assert.equal(first.runtimePath, path.join(canonicalRoot, ".orquesta", "runtime", "session-rotation-hook.cjs"));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(placementRoot, ".orquesta", "runtime", "session-rotation-hook.cjs")), false);
  assert.equal(fs.existsSync(path.join(placementRoot, ".orquesta", "state", "session-rotation.json")), false);
  const registry = JSON.parse(fs.readFileSync(path.join(state, "session-rotation.json"), "utf8"));
  assert.equal(registry.sessions["session-1"].compaction_count, 1);
  const placementConfig = JSON.parse(fs.readFileSync(path.join(placementRoot, ".codex", "hooks.json"), "utf8"));
  assert.ok(placementConfig.hooks.PostCompact[0].hooks[0].commandWindows.includes(first.runtimePath));
});

test("migrates an older source-checkout hook to the project-local runtime", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-hook-migrate-"));
  const oldScript = path.join(root, "old-skill", "session-rotation-hook.js");
  installSessionRotationHook({ projectRoot: root, scriptPath: oldScript });

  const migrated = installSessionRotationHook({ projectRoot: root });
  const config = JSON.parse(fs.readFileSync(path.join(root, ".codex", "hooks.json"), "utf8"));

  assert.equal(migrated.status, "updated");
  assert.equal(config.hooks.PostCompact.length, 1);
  assert.match(config.hooks.PostCompact[0].hooks[0].commandWindows, /\.orquesta\\runtime\\session-rotation-hook\.cjs/u);
  assert.doesNotMatch(config.hooks.PostCompact[0].hooks[0].commandWindows, /old-skill/u);
});
