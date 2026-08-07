import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  prepareRuntimeProfile,
  sharedExecutionContract
} from "../scripts/lib/runtime-profiles.mjs";

test("plain uses a disposable CODEX_HOME and links auth without exposing its contents", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orquesta-benchmark-profile-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const currentHome = path.join(root, "current-home");
  const tempRoot = path.join(root, "temp");
  const workspaceRoot = path.join(root, "workspace");
  await fs.mkdir(currentHome, { recursive: true });
  for (const directory of [".sandbox", ".sandbox-bin", ".sandbox-secrets"]) {
    await fs.mkdir(path.join(currentHome, directory));
  }
  await fs.writeFile(path.join(currentHome, ".sandbox_migration"), "v1\n", "utf8");
  await fs.writeFile(path.join(currentHome, "auth.json"), "{\"secret\":\"do-not-log\"}\n", "utf8");
  await fs.writeFile(path.join(currentHome, "config.toml"), "approval_policy = \"on-request\"\n", "utf8");

  const profile = await prepareRuntimeProfile({
    mode: "plain",
    currentCodexHome: currentHome,
    tempRoot,
    workspaceRoot
  });

  assert.notEqual(profile.codex_home, currentHome);
  assert.equal(profile.environment.CODEX_HOME, profile.codex_home);
  assert.equal(JSON.stringify(profile).includes("do-not-log"), false);
  assert.equal(
    await fs.readFile(path.join(profile.codex_home, "auth.json"), "utf8"),
    "{\"secret\":\"do-not-log\"}\n"
  );
  assert.equal(
    (await fs.stat(path.join(profile.codex_home, ".sandbox-bin"))).isDirectory(),
    true
  );
  const config = await fs.readFile(path.join(profile.codex_home, "config.toml"), "utf8");
  assert.match(config, /approval_policy = "never"/);
  assert.doesNotMatch(config, /on-request/);
  assert.match(config, /trust_level = "trusted"/);
  assert.match(config, /workspace/);
  assert.match(config, /sandbox = "elevated"/);
  assert.equal(profile.multi_agent, false);
  assert.equal(profile.repo_orquesta_skill, "forbidden");
  assert.deepEqual(profile.disabled_features.sort(), [
    "apps",
    "memories",
    "multi_agent",
    "plugins"
  ]);
});

test("skills keeps the current home but forbids repository Orquesta and multi-agent", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orquesta-benchmark-skills-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "auth.json"), "{}\n", "utf8");

  const profile = await prepareRuntimeProfile({
    mode: "skills",
    currentCodexHome: root,
    tempRoot: path.join(root, "temp")
  });

  assert.equal(profile.codex_home, root);
  assert.equal(profile.multi_agent, false);
  assert.equal(profile.repo_orquesta_skill, "forbidden");
  assert.deepEqual(profile.disabled_features, ["multi_agent"]);
});

test("orquesta keeps common skills and requires the frozen repository skill", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orquesta-benchmark-orquesta-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "auth.json"), "{}\n", "utf8");

  const profile = await prepareRuntimeProfile({
    mode: "orquesta",
    currentCodexHome: root,
    tempRoot: path.join(root, "temp")
  });

  assert.equal(profile.codex_home, root);
  assert.equal(profile.multi_agent, true);
  assert.equal(profile.repo_orquesta_skill, "required");
  assert.deepEqual(profile.disabled_features, []);
});

test("every mode receives the same execution contract", () => {
  assert.deepEqual(sharedExecutionContract(), {
    model: "gpt-5.6-sol",
    reasoning_effort: "high",
    sandbox: "workspace-write",
    approval_policy: "never",
    agent_timeout_sec: 900,
    verifier_timeout_sec: 60
  });
});

test("rejects an unsupported mode before creating files", async () => {
  await assert.rejects(
    prepareRuntimeProfile({
      mode: "solo",
      currentCodexHome: "unused",
      tempRoot: "unused"
    }),
    /unsupported benchmark mode/i
  );
});
