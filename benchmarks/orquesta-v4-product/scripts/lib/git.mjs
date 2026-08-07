import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

function git(args, { cwd, allowFailure = false } = {}) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, shell: false, maxBuffer: 16 * 1024 * 1024 });
  if (!allowFailure && result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout || result.error?.message || "unknown error").trim()}`);
  return result;
}

export function initializeGitWorkspace(workspaceRoot) {
  for (const args of [["init", "--quiet"], ["config", "user.email", "benchmark@orquesta.local"], ["config", "user.name", "Orquesta Benchmark"], ["add", "."], ["commit", "--quiet", "-m", "benchmark base"]]) git(args, { cwd: workspaceRoot });
  assertGitClean(workspaceRoot);
}

export function assertGitClean(workspaceRoot) {
  const result = git(["status", "--porcelain"], { cwd: workspaceRoot });
  if (result.stdout.trim()) throw new Error(`benchmark workspace is dirty:\n${result.stdout.trim()}`);
}

export function captureWorkspacePatch(workspaceRoot) {
  git(["add", "-A"], { cwd: workspaceRoot });
  try {
    return git(["diff", "--cached", "--binary", "HEAD"], { cwd: workspaceRoot }).stdout;
  } finally {
    git(["reset", "--quiet", "HEAD"], { cwd: workspaceRoot, allowFailure: true });
  }
}

export async function workspaceFingerprint(workspaceRoot) {
  const rows = [];
  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".git") continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) {
        const relative = path.relative(workspaceRoot, target).replaceAll("\\", "/");
        const digest = createHash("sha256").update(await fs.readFile(target)).digest("hex");
        rows.push(`${relative}\0${digest}`);
      }
    }
  }
  await visit(workspaceRoot);
  return { sha256: createHash("sha256").update(rows.join("\n"), "utf8").digest("hex"), files: rows.length };
}

export function resolveV4Ref(repositoryUrl, ref) {
  if (typeof ref !== "string" || !ref.trim()) throw new Error("V4 ref is required");
  const value = ref.trim();
  const patterns = [value, `refs/heads/${value}`, `refs/tags/${value}`, `refs/tags/${value}^{}`];
  let result = git(["ls-remote", "--heads", "--tags", repositoryUrl, ...patterns], { allowFailure: true });
  let rows = result.status === 0 ? result.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => line.split(/\s+/)) : [];
  if (/^[0-9a-f]{40}$/i.test(value) && !rows.some(([sha]) => sha.toLowerCase() === value.toLowerCase())) {
    result = git(["ls-remote", repositoryUrl], { allowFailure: true });
    rows = result.status === 0 ? result.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => line.split(/\s+/)) : [];
  }
  const dereferenced = rows.find(([, name]) => name === `refs/tags/${value}^{}`);
  const exact = rows.find(([sha, name]) => sha.toLowerCase() === value.toLowerCase() || [value, `refs/heads/${value}`, `refs/tags/${value}`].includes(name));
  const sha = dereferenced?.[0] || exact?.[0];
  if (!/^[0-9a-f]{40}$/i.test(sha || "")) throw new Error(`V4 ref was not found in ${repositoryUrl}: ${value}`);
  return sha.toLowerCase();
}
