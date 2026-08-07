import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const DEFAULT_V4_FAST_RUNTIME_PATHS = Object.freeze([
  "orquesta",
  "packages/codex-adapter",
  "packages/contracts",
  "packages/context-compiler",
  "packages/core",
  "packages/execution-kernel",
  "apps/orquesta-desktop/electron/core",
  "apps/orquesta-desktop/electron/main",
  "apps/orquesta-desktop/package.json",
  "scripts/v4",
  "package.json"
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function gitBuffer(sourceRoot, args) {
  return execFileSync("git", args, {
    cwd: sourceRoot,
    encoding: "buffer",
    maxBuffer: 128 * 1024 * 1024
  });
}

function gitText(sourceRoot, args) {
  return gitBuffer(sourceRoot, args).toString("utf8").trim();
}

function nulList(buffer) {
  return buffer
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((value) => value.replaceAll("\\", "/"))
    .sort();
}

async function hashFiles(sourceRoot, files) {
  const entries = [];
  for (const relative of files) {
    const bytes = await fs.readFile(path.join(sourceRoot, ...relative.split("/")));
    entries.push({
      path: relative,
      sha256: sha256(bytes),
      size_bytes: bytes.length
    });
  }
  return entries;
}

function treeHash(entries) {
  return sha256(entries
    .map((entry) => `${entry.path}\0${entry.sha256}\0${entry.size_bytes}\n`)
    .join(""));
}

async function captureIdentity({ sourceRoot, includePaths }) {
  const pathspec = ["--", ...includePaths];
  const baseCommit = gitText(sourceRoot, ["rev-parse", "HEAD"]);
  const trackedDiff = gitBuffer(sourceRoot, ["diff", "--binary", "HEAD", ...pathspec]);
  const untrackedPaths = nulList(gitBuffer(
    sourceRoot,
    ["ls-files", "-z", "--others", "--exclude-standard", ...pathspec]
  ));
  const runtimePaths = nulList(gitBuffer(
    sourceRoot,
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", ...pathspec]
  ));
  const runtimeFiles = await hashFiles(sourceRoot, runtimePaths);
  const untrackedSet = new Set(untrackedPaths);
  const untrackedFiles = runtimeFiles.filter((entry) => untrackedSet.has(entry.path));
  const skillFiles = runtimeFiles.filter((entry) => entry.path.startsWith("orquesta/"));

  return {
    schema_version: 1,
    base_commit: baseCommit,
    include_paths: [...includePaths],
    tracked_diff_sha256: sha256(trackedDiff),
    untracked_files: untrackedFiles,
    skill_tree_sha256: treeHash(skillFiles),
    runtime_files: runtimeFiles,
    runtime_snapshot_sha256: treeHash(runtimeFiles)
  };
}

async function copyRuntimeFiles({ sourceRoot, runtimeRoot, runtimeFiles }) {
  for (const entry of runtimeFiles) {
    const source = path.join(sourceRoot, ...entry.path.split("/"));
    const target = path.join(runtimeRoot, ...entry.path.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
  }
}

export async function createV4FastSnapshot({
  sourceRoot,
  destination,
  includePaths = DEFAULT_V4_FAST_RUNTIME_PATHS
}) {
  const identity = await captureIdentity({ sourceRoot, includePaths });
  await fs.rm(destination, { recursive: true, force: true });
  const runtimeRoot = path.join(destination, "runtime");
  await fs.mkdir(runtimeRoot, { recursive: true });
  await copyRuntimeFiles({
    sourceRoot,
    runtimeRoot,
    runtimeFiles: identity.runtime_files
  });
  await fs.writeFile(
    path.join(destination, "snapshot.json"),
    `${JSON.stringify(identity, null, 2)}\n`,
    "utf8"
  );
  return identity;
}

export async function verifyV4FastSource({ sourceRoot, identity }) {
  const current = await captureIdentity({
    sourceRoot,
    includePaths: identity.include_paths
  });
  const changed = [];
  for (const field of [
    "tracked_diff_sha256",
    "skill_tree_sha256",
    "runtime_snapshot_sha256"
  ]) {
    if (current[field] !== identity[field]) changed.push(field);
  }

  const expectedUntracked = JSON.stringify(identity.untracked_files);
  const currentUntracked = JSON.stringify(current.untracked_files);
  if (expectedUntracked !== currentUntracked) changed.push("untracked_files");

  return {
    valid: changed.length === 0,
    status: changed.length === 0 ? "stable" : "runtime_drift",
    changed,
    metadata_changed: current.base_commit === identity.base_commit
      ? []
      : ["base_commit"]
  };
}
