"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const { acquireExclusiveProcessLock, releaseExclusiveProcessLock } = require("../src/exclusive-process-lock-v1");

const CHILD = path.join(__dirname, "..", "support", "exclusive-process-lock-child.cjs");

function fixture(prefix = "orquesta-process-lock-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { root, dispose: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function child(root, lockPath, marker, mode = "hold") {
  const processHandle = spawn(process.execPath, [CHILD, root, lockPath, marker, mode], {
    cwd: __dirname,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  processHandle.stdout.setEncoding("utf8");
  processHandle.stderr.setEncoding("utf8");
  processHandle.stdout.on("data", (chunk) => { stdout += chunk; });
  processHandle.stderr.on("data", (chunk) => { stderr += chunk; });
  return new Promise((resolve) => processHandle.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr })));
}

async function deadOwnerFixture() {
  const project = fixture("orquesta-dead-lock-");
  const lockPath = path.join(project.root, ".orquesta", "runtime", "proof.lock");
  const seeded = await child(project.root, lockPath, path.join(project.root, "callbacks.txt"), "crash");
  assert.equal(seeded.code, 0, seeded.stderr);
  const metadata = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  return {
    ...project,
    lockPath,
    metadata,
    recoveryPath: `${lockPath}.recovery-${metadata.nonce}.json`,
    acquire: () => acquireExclusiveProcessLock({ rootPath: project.root, lockPath, codePrefix: "LOCK_PROBE" }),
  };
}

test("hard-link process lock admits exactly one contender and recovers after process exit", async () => {
  const project = fixture();
  try {
    const staging = path.join(project.root, ".orquesta", "runtime", "lock-proof");
    const lockPath = path.join(staging, "proof-lock-v1.lock");
    const marker = path.join(project.root, "callbacks.txt");
    const pair = await Promise.all([child(project.root, lockPath, marker), child(project.root, lockPath, marker)]);
    assert.deepEqual(pair.map((result) => result.code).sort(), [0, 2], pair.map((result) => result.stderr).join("\n"));
    assert.equal(fs.readFileSync(marker, "utf8").trim().split(/\r?\n/u).length, 1);

    assert.equal((await child(project.root, lockPath, marker, "crash")).code, 0);
    const afterCrash = await Promise.all([child(project.root, lockPath, marker), child(project.root, lockPath, marker)]);
    assert.equal(afterCrash.filter((result) => result.code === 0).length, 1);
    const contender = afterCrash.find((result) => result.code !== 0);
    assert.ok(contender.code === 2 || (contender.code === 1
      && contender.stderr.startsWith("LOCK_PROBE_LOCK_RECOVERY_REQUIRED:")), contender.stderr);
    assert.equal(fs.readFileSync(marker, "utf8").trim().split(/\r?\n/u).length, 3);
  } finally {
    project.dispose();
  }
});

test("a stale recovery observer cannot remove a new live owner's lock", async (t) => {
  const project = await deadOwnerFixture();
  const originalOpen = fs.openSync.bind(fs);
  let successor = null;
  let interleaved = false;
  t.mock.method(fs, "openSync", (filePath, ...args) => {
    if (filePath === project.recoveryPath && !interleaved) {
      interleaved = true;
      successor = project.acquire();
    }
    return originalOpen(filePath, ...args);
  });
  try {
    assert.throws(project.acquire, { code: "LOCK_PROBE_LOCKED" });
    assert.ok(successor);
    assert.equal(JSON.parse(fs.readFileSync(project.lockPath, "utf8")).nonce, successor.metadata.nonce);
    assert.throws(project.acquire, { code: "LOCK_PROBE_LOCKED" });
    releaseExclusiveProcessLock(successor);
  } finally {
    t.mock.restoreAll();
    project.dispose();
  }
});

test("all recoverers of the same dead owner honor its claim before unlink", async (t) => {
  const project = await deadOwnerFixture();
  const originalUnlink = fs.unlinkSync.bind(fs);
  let interleaved = false;
  t.mock.method(fs, "unlinkSync", (filePath) => {
    if (filePath === project.lockPath && !interleaved) {
      interleaved = true;
      const claim = JSON.parse(fs.readFileSync(project.recoveryPath, "utf8"));
      const details = fs.lstatSync(project.lockPath, { bigint: true });
      assert.equal(claim.pid, process.pid);
      assert.equal(claim.observed_owner.pid, project.metadata.pid);
      assert.equal(claim.observed_owner.nonce, project.metadata.nonce);
      assert.equal(claim.observed_owner.dev, String(details.dev));
      assert.equal(claim.observed_owner.ino, String(details.ino));
      assert.throws(project.acquire, { code: "LOCK_PROBE_LOCK_RECOVERY_REQUIRED" });
      assert.equal(fs.lstatSync(project.lockPath, { bigint: true }).ino, details.ino);
    }
    return originalUnlink(filePath);
  });
  try {
    const recovered = project.acquire();
    assert.equal(interleaved, true);
    assert.equal(fs.existsSync(project.recoveryPath), false);
    releaseExclusiveProcessLock(recovered);
  } finally {
    t.mock.restoreAll();
    project.dispose();
  }
});

test("a successor published after dead-lock unlink survives the old owner's cleanup", async (t) => {
  const project = await deadOwnerFixture();
  const originalUnlink = fs.unlinkSync.bind(fs);
  let successor = null;
  let interleaved = false;
  t.mock.method(fs, "unlinkSync", (filePath) => {
    const result = originalUnlink(filePath);
    if (filePath === project.lockPath && !interleaved) {
      interleaved = true;
      assert.equal(fs.existsSync(project.recoveryPath), true);
      successor = project.acquire();
    }
    return result;
  });
  try {
    assert.throws(project.acquire, { code: "LOCK_PROBE_LOCKED" });
    assert.ok(successor);
    assert.equal(fs.existsSync(project.recoveryPath), false);
    assert.equal(fs.existsSync(project.metadata.candidate_path), false);
    assert.equal(JSON.parse(fs.readFileSync(project.lockPath, "utf8")).nonce, successor.metadata.nonce);
    releaseExclusiveProcessLock(successor);
  } finally {
    t.mock.restoreAll();
    project.dispose();
  }
});

test("crashed or incomplete recovery claims require explicit maintenance and are never reclaimed", async (t) => {
  for (const incomplete of [false, true]) {
    await t.test(incomplete ? "incomplete claim" : "dead recoverer claim", async () => {
      const project = await deadOwnerFixture();
      try {
        const details = fs.lstatSync(project.lockPath, { bigint: true });
        const claimBytes = incomplete ? "{" : JSON.stringify({
          schema_version: 1,
          pid: project.metadata.pid,
          nonce: "crashed-recoverer",
          lock_path: project.lockPath,
          observed_owner: {
            pid: project.metadata.pid,
            nonce: project.metadata.nonce,
            dev: String(details.dev),
            ino: String(details.ino),
          },
        });
        fs.writeFileSync(project.recoveryPath, claimBytes, { flag: "wx" });
        const before = fs.readdirSync(path.dirname(project.lockPath)).sort();
        assert.throws(project.acquire, { code: "LOCK_PROBE_LOCK_RECOVERY_REQUIRED" });
        assert.equal(fs.lstatSync(project.lockPath, { bigint: true }).ino, details.ino);
        assert.equal(fs.readFileSync(project.recoveryPath, "utf8"), claimBytes);
        assert.deepEqual(fs.readdirSync(path.dirname(project.lockPath)).sort(), before);
      } finally {
        project.dispose();
      }
    });
  }
});

test("the owner nonce prevents ABA deletion even when PID and inode match an old observation", async (t) => {
  const project = await deadOwnerFixture();
  const originalOpen = fs.openSync.bind(fs);
  let replaced = false;
  const successorMetadata = {
    ...project.metadata,
    nonce: "successor-owner",
    candidate_path: `${project.lockPath}.candidate-successor-owner.json`,
  };
  t.mock.method(fs, "openSync", (filePath, ...args) => {
    if (filePath === project.recoveryPath && !replaced) {
      replaced = true;
      fs.linkSync(project.metadata.candidate_path, successorMetadata.candidate_path);
      fs.writeFileSync(project.lockPath, `${JSON.stringify(successorMetadata)}\n`);
    } else if (replaced && String(filePath).startsWith(`${project.lockPath}.candidate-`)) {
      const stopped = new Error("stop before a fresh acquisition can independently recover the successor");
      stopped.code = "STOP_AFTER_RECOVERY_CHECK";
      throw stopped;
    }
    return originalOpen(filePath, ...args);
  });
  try {
    assert.throws(project.acquire, { code: "STOP_AFTER_RECOVERY_CHECK" });
    assert.deepEqual(JSON.parse(fs.readFileSync(project.lockPath, "utf8")), successorMetadata);
    assert.equal(fs.existsSync(successorMetadata.candidate_path), true);
    assert.equal(fs.existsSync(project.recoveryPath), false);
  } finally {
    t.mock.restoreAll();
    project.dispose();
  }
});

test("process lock creates no implicit journal, WAL, or shared-memory sidecars", () => {
  const project = fixture();
  try {
    const lockPath = path.join(project.root, ".orquesta", "runtime", "lock-proof", "proof-lock-v1.lock");
    const lock = acquireExclusiveProcessLock({ rootPath: project.root, lockPath, codePrefix: "LOCK_PROBE" });
    const names = fs.readdirSync(path.dirname(lockPath));
    assert.equal(names.includes(path.basename(lockPath)), true);
    assert.equal(names.some((name) => /-journal$|-wal$|-shm$/u.test(name)), false);
    assert.equal(names.filter((name) => name.includes("candidate-")).length, 1);
    releaseExclusiveProcessLock(lock);
    assert.deepEqual(fs.readdirSync(path.dirname(lockPath)), []);
  } finally {
    project.dispose();
  }
});

test("a symlinked lock fails closed without altering its external target", (t) => {
  const project = fixture();
  const external = fixture("orquesta-process-lock-external-");
  try {
    const directory = path.join(project.root, ".orquesta", "runtime", "lock-proof");
    fs.mkdirSync(directory, { recursive: true });
    const lockPath = path.join(directory, "proof-lock-v1.lock");
    const sentinel = path.join(external.root, "sentinel.txt");
    fs.writeFileSync(sentinel, "preserve-me", "utf8");
    try {
      fs.symlinkSync(sentinel, lockPath, "file");
    } catch (cause) {
      t.skip(`file symlink creation unavailable: ${cause.code || cause.message}`);
      return;
    }
    assert.throws(
      () => acquireExclusiveProcessLock({ rootPath: project.root, lockPath, codePrefix: "LOCK_PROBE" }),
      { code: "LOCK_PROBE_LOCK_PATH_UNSAFE" }
    );
    assert.equal(fs.readFileSync(sentinel, "utf8"), "preserve-me");
    assert.equal(fs.lstatSync(lockPath).isSymbolicLink(), true);
  } finally {
    project.dispose();
    external.dispose();
  }
});

test("SQLite-shaped sidecar symlinks are inert because the lock never opens a database", (t) => {
  const project = fixture();
  const external = fixture("orquesta-process-lock-sidecar-");
  try {
    const directory = path.join(project.root, ".orquesta", "runtime", "lock-proof");
    fs.mkdirSync(directory, { recursive: true });
    const lockPath = path.join(directory, "proof-lock-v1.lock");
    const sidecarPath = `${lockPath}-journal`;
    const sentinel = path.join(external.root, "sentinel.txt");
    fs.writeFileSync(sentinel, "preserve-sidecar", "utf8");
    try {
      fs.symlinkSync(sentinel, sidecarPath, "file");
    } catch (cause) {
      t.skip(`file symlink creation unavailable: ${cause.code || cause.message}`);
      return;
    }
    const lock = acquireExclusiveProcessLock({ rootPath: project.root, lockPath, codePrefix: "LOCK_PROBE" });
    releaseExclusiveProcessLock(lock);
    assert.equal(fs.readFileSync(sentinel, "utf8"), "preserve-sidecar");
    assert.equal(fs.lstatSync(sidecarPath).isSymbolicLink(), true);
  } finally {
    project.dispose();
    external.dispose();
  }
});
