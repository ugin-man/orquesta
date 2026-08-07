import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";

import {
  createV4FastSnapshot,
  verifyV4FastSource
} from "../scripts/lib/v4-fast-snapshot.mjs";

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

async function write(root, relative, contents) {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents, "utf8");
}

test("freezes tracked and untracked V4-fast runtime files without copying benchmark noise", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "orquesta-v4-fast-snapshot-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const source = path.join(temp, "source");
  const destination = path.join(temp, "snapshot");
  await fs.mkdir(source, { recursive: true });
  git(source, ["init"]);
  git(source, ["config", "user.email", "benchmark@example.invalid"]);
  git(source, ["config", "user.name", "Benchmark Test"]);

  await write(source, "orquesta/SKILL.md", "version one\n");
  await write(source, "orquesta/scripts/setup.js", "export const setup = 1;\n");
  await write(source, "packages/codex-adapter/src/index.js", "export const adapter = 1;\n");
  await write(source, "packages/context-compiler/src/index.js", "export const compile = 1;\n");
  await write(source, "apps/orquesta-desktop/electron/core/runtime.ts", "export const core = 1;\n");
  await write(source, "package.json", "{\"name\":\"fixture\"}\n");
  await write(source, "benchmarks/orquesta-v4-product/result.json", "{\"noise\":true}\n");
  await write(source, "Orquesta-Devpost-Demo-Final-V2.mp4", "video noise\n");
  git(source, ["add", "."]);
  git(source, ["commit", "-m", "fixture baseline"]);
  const baseCommit = git(source, ["rev-parse", "HEAD"]);

  await write(source, "orquesta/SKILL.md", "version two dirty\n");
  await write(source, "orquesta/references/new-policy.md", "untracked runtime policy\n");
  await write(source, "benchmarks/orquesta-v4-product/new-result.json", "{\"noise\":2}\n");
  const sourceBefore = await fs.readFile(path.join(source, "orquesta", "SKILL.md"), "utf8");

  const snapshot = await createV4FastSnapshot({
    sourceRoot: source,
    destination
  });

  assert.equal(snapshot.base_commit, baseCommit);
  assert.equal(snapshot.untracked_files.length, 1);
  assert.equal(snapshot.untracked_files[0].path, "orquesta/references/new-policy.md");
  assert.match(snapshot.tracked_diff_sha256, /^[0-9a-f]{64}$/);
  assert.match(snapshot.skill_tree_sha256, /^[0-9a-f]{64}$/);
  assert.match(snapshot.runtime_snapshot_sha256, /^[0-9a-f]{64}$/);
  assert.equal(
    await fs.readFile(path.join(destination, "runtime", "orquesta", "SKILL.md"), "utf8"),
    "version two dirty\n"
  );
  assert.equal(
    await fs.readFile(
      path.join(destination, "runtime", "packages", "context-compiler", "src", "index.js"),
      "utf8"
    ),
    "export const compile = 1;\n"
  );
  await assert.rejects(
    fs.access(path.join(destination, "runtime", "benchmarks")),
    /ENOENT/
  );
  await assert.rejects(
    fs.access(path.join(destination, "runtime", "Orquesta-Devpost-Demo-Final-V2.mp4")),
    /ENOENT/
  );
  assert.equal(
    await fs.readFile(path.join(source, "orquesta", "SKILL.md"), "utf8"),
    sourceBefore
  );

  assert.deepEqual(await verifyV4FastSource({ sourceRoot: source, identity: snapshot }), {
    valid: true,
    status: "stable",
    changed: [],
    metadata_changed: []
  });

  await write(source, "benchmarks/orquesta-v4-product/ignored-after.json", "{}\n");
  assert.equal(
    (await verifyV4FastSource({ sourceRoot: source, identity: snapshot })).valid,
    true
  );
  git(source, ["add", "benchmarks/orquesta-v4-product/ignored-after.json"]);
  git(source, ["commit", "-m", "benchmark-only change"]);
  assert.deepEqual(await verifyV4FastSource({ sourceRoot: source, identity: snapshot }), {
    valid: true,
    status: "stable",
    changed: [],
    metadata_changed: ["base_commit"]
  });

  await write(source, "orquesta/scripts/setup.js", "export const setup = 2;\n");
  const drift = await verifyV4FastSource({ sourceRoot: source, identity: snapshot });
  assert.equal(drift.valid, false);
  assert.equal(drift.status, "runtime_drift");
  assert.ok(drift.changed.length > 0);
});

test("produces the same runtime hash for identical trees at different destinations", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "orquesta-v4-fast-repeat-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const source = path.join(temp, "source");
  await fs.mkdir(source, { recursive: true });
  git(source, ["init"]);
  git(source, ["config", "user.email", "benchmark@example.invalid"]);
  git(source, ["config", "user.name", "Benchmark Test"]);
  await write(source, "orquesta/SKILL.md", "same\n");
  await write(source, "packages/codex-adapter/src/index.js", "same\n");
  await write(source, "package.json", "{}\n");
  git(source, ["add", "."]);
  git(source, ["commit", "-m", "same"]);

  const first = await createV4FastSnapshot({
    sourceRoot: source,
    destination: path.join(temp, "first")
  });
  const second = await createV4FastSnapshot({
    sourceRoot: source,
    destination: path.join(temp, "second")
  });
  assert.equal(first.runtime_snapshot_sha256, second.runtime_snapshot_sha256);
  assert.equal(first.skill_tree_sha256, second.skill_tree_sha256);
});
