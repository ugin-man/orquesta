#!/usr/bin/env node

const assert = require("assert");
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  appendJsonlAtomic,
  readJsonFile,
  recoverJsonFile,
  updateJsonAtomic,
  writeJsonAtomic
} = require("./json-state");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-json-state-"));
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function makePath(...parts) {
  return path.join(testRoot, ...parts);
}

function tempFilesFor(filePath) {
  const directory = path.dirname(filePath);
  if (!fs.existsSync(directory)) return [];
  const prefix = `${path.basename(filePath)}.tmp-`;
  return fs.readdirSync(directory).filter((name) => name.startsWith(prefix));
}

function lockPathFor(filePath) {
  return `${filePath}.lock`;
}

function liveWorkspaceProbePath() {
  return path.resolve(
    __dirname,
    "../..",
    ".orquesta/state",
    `.t166-json-state-live-probe-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );
}

function removeConfirmedProbeArtifacts(filePath, childPid) {
  const directory = path.dirname(filePath);
  const baseName = path.basename(filePath);
  const lockPath = lockPathFor(filePath);
  const artifacts = fs.readdirSync(directory)
    .filter((name) => name === `${baseName}.lock.transition` || name.startsWith(`${baseName}.lock.release-`))
    .map((name) => path.join(directory, name));

  for (const artifactPath of artifacts) {
    const metadata = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
    assert.strictEqual(metadata.pid, childPid, `probe artifact owner pid mismatch: ${artifactPath}`);
    const expectedTarget = artifactPath.endsWith(".transition") ? lockPath : filePath;
    assert.strictEqual(metadata.target_path, expectedTarget, `probe artifact target mismatch: ${artifactPath}`);
    fs.unlinkSync(artifactPath);
  }

  const directLockPath = lockPathFor(filePath);
  if (fs.existsSync(directLockPath)) {
    const metadata = JSON.parse(fs.readFileSync(directLockPath, "utf8"));
    assert.strictEqual(metadata.pid, childPid, `probe lock owner pid mismatch: ${directLockPath}`);
    assert.strictEqual(metadata.target_path, filePath, `probe lock target mismatch: ${directLockPath}`);
    fs.unlinkSync(directLockPath);
  }
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

function runLiveWorkspaceCleanupProbe(filePath) {
  const helperPath = path.resolve(__dirname, "json-state.js");
  const source = [
    'const { writeJsonAtomic } = require(process.argv[1]);',
    'writeJsonAtomic(process.argv[2], { probe: "T166", text: "OneDrive cleanup" });',
    'process.stdout.write("live workspace atomic write completed\\n");'
  ].join(" ");
  return spawnSync(process.execPath, ["-e", source, helperPath, filePath], {
    encoding: "utf8",
    windowsHide: true
  });
}

async function runConcurrentWorkers(mode, filePath, count) {
  const helperPath = path.resolve(__dirname, "json-state.js");
  const startPath = makePath(`start-${mode}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const workerSource = [
    'const fs = require("fs");',
    'const { appendJsonlAtomic, updateJsonAtomic } = require(process.argv[1]);',
    'const mode = process.argv[2];',
    'const filePath = process.argv[3];',
    'const id = Number(process.argv[4]);',
    'const startPath = process.argv[5];',
    'process.stdout.write("ready\\n");',
    'while (!fs.existsSync(startPath)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);',
    'if (mode === "append") appendJsonlAtomic(filePath, { id, text: `event-${id}` });',
    'if (mode === "increment") updateJsonAtomic(filePath, { count: 0 }, (state) => ({ count: Number(state.count || 0) + 1 }));'
  ].join(" ");

  const workers = Array.from({ length: count }, (_, id) => {
    const child = spawn(process.execPath, ["-e", workerSource, helperPath, mode, filePath, String(id), startPath], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let readyResolve;
    const ready = new Promise((resolve) => { readyResolve = resolve; });
    const exited = new Promise((resolve) => {
      child.on("exit", (code, signal) => {
        readyResolve();
        resolve({ id, code, signal, stdout, stderr });
      });
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("ready")) readyResolve();
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      stderr += error.stack || error.message;
      readyResolve();
    });
    return { ready, exited };
  });

  await Promise.all(workers.map((worker) => worker.ready));
  fs.writeFileSync(startPath, "go\n", "utf8");
  const results = await Promise.all(workers.map((worker) => worker.exited));
  fs.rmSync(startPath, { force: true });
  return results;
}

try {
  test("readJsonFile returns the provided default for a missing file", () => {
    const fallback = { version: 1, items: [] };
    assert.deepStrictEqual(readJsonFile(makePath("missing.json"), fallback), fallback);
  });

  test("writeJsonAtomic creates parents and writes UTF-8 JSON with a trailing newline", () => {
    const filePath = makePath("nested", "state.json");
    const data = { title: "オルケスタ", detail: "日本語を保持する" };
    const result = writeJsonAtomic(filePath, data);

    const raw = fs.readFileSync(filePath, "utf8");
    assert.deepStrictEqual(JSON.parse(raw), data);
    assert.ok(raw.endsWith("\n"));
    assert.strictEqual(result.status, "written");
    assert.strictEqual(result.path, filePath);
    assert.match(path.basename(result.tempPath), /^state\.json\.tmp-/);
    assert.strictEqual(fs.existsSync(result.tempPath), false);
    assert.deepStrictEqual(tempFilesFor(filePath), []);
  });

  test("single-file state cleanup uses unlink rather than fs.rmSync", () => {
    const filePath = makePath("unlink-cleanup", "state.json");
    const originalRmSync = fs.rmSync;
    let forbiddenRmCalls = 0;
    fs.rmSync = (targetPath, options) => {
      if (String(targetPath).startsWith(filePath)) {
        forbiddenRmCalls += 1;
        const error = new Error("single-file cleanup used fs.rmSync");
        error.code = "EIO";
        throw error;
      }
      return originalRmSync(targetPath, options);
    };
    try {
      writeJsonAtomic(filePath, { value: "unlink-cleanup" }, { backup: true });
    } finally {
      fs.rmSync = originalRmSync;
    }
    assert.strictEqual(forbiddenRmCalls, 0);
    assert.strictEqual(fs.existsSync(lockPathFor(filePath)), false);
    assert.strictEqual(fs.existsSync(`${lockPathFor(filePath)}.transition`), false);
  });

  test("live OneDrive child process releases every single-file artifact without native exit", () => {
    const filePath = liveWorkspaceProbePath();
    let result;
    try {
      result = runLiveWorkspaceCleanupProbe(filePath);
      assert.strictEqual(result.status, 0, `child status=${result.status}, signal=${result.signal}, stdout=${result.stdout}, stderr=${result.stderr}`);
      assert.match(result.stdout, /live workspace atomic write completed/);
      assert.strictEqual(fs.existsSync(filePath), true);
      assert.strictEqual(fs.existsSync(lockPathFor(filePath)), false);
      assert.strictEqual(fs.existsSync(`${lockPathFor(filePath)}.lock.transition`), false);
      assert.deepStrictEqual(
        fs.readdirSync(path.dirname(filePath)).filter((name) => name.startsWith(`${path.basename(filePath)}.lock.release-`)),
        []
      );
    } finally {
      if (result?.pid) removeConfirmedProbeArtifacts(filePath, result.pid);
      else if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
  });

  test("writeJsonAtomic preserves the previous target as .bak when requested", () => {
    const filePath = makePath("backup", "state.json");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '{"version":1,"value":"before"}\n', "utf8");

    const result = writeJsonAtomic(filePath, { version: 2, value: "after" }, { backup: true });

    assert.deepStrictEqual(readJsonFile(filePath), { version: 2, value: "after" });
    assert.deepStrictEqual(readJsonFile(`${filePath}.bak`), { version: 1, value: "before" });
    assert.strictEqual(result.backupPath, `${filePath}.bak`);
  });

  test("updateJsonAtomic leaves the target unchanged when the updater throws", () => {
    const filePath = makePath("update", "state.json");
    writeJsonAtomic(filePath, { count: 2 });
    const before = fs.readFileSync(filePath, "utf8");

    assert.throws(
      () => updateJsonAtomic(filePath, { count: 0 }, () => {
        throw new Error("updater failed");
      }),
      /updater failed/
    );

    assert.strictEqual(fs.readFileSync(filePath, "utf8"), before);
    assert.deepStrictEqual(tempFilesFor(filePath), []);
  });

  test("recoverJsonFile restores a valid backup when the target is invalid", () => {
    const filePath = makePath("recover-backup", "state.json");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "{broken", "utf8");
    fs.writeFileSync(`${filePath}.bak`, '{"version":1,"title":"復旧"}\n', "utf8");
    const incidents = [];

    const result = recoverJsonFile(filePath, { onIncident: (incident) => incidents.push(incident) });

    assert.strictEqual(result.status, "restored_backup");
    assert.deepStrictEqual(result.data, { version: 1, title: "復旧" });
    assert.deepStrictEqual(readJsonFile(filePath), result.data);
    assert.strictEqual(incidents.length, 1);
    assert.strictEqual(incidents[0].type, "json_state_recovered_from_backup");
  });

  test("recoverJsonFile promotes a valid temp when the target is missing", () => {
    const filePath = makePath("recover-temp", "state.json");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.tmp-123-456`;
    fs.writeFileSync(tempPath, '{"version":3,"source":"temp"}\n', "utf8");

    const result = recoverJsonFile(filePath);

    assert.strictEqual(result.status, "promoted_temp");
    assert.deepStrictEqual(result.data, { version: 3, source: "temp" });
    assert.strictEqual(fs.existsSync(tempPath), false);
    assert.deepStrictEqual(readJsonFile(filePath), result.data);
  });

  test("recoverJsonFile blocks when target and backup are both invalid", () => {
    const filePath = makePath("unrecoverable", "state.json");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "{bad target", "utf8");
    fs.writeFileSync(`${filePath}.bak`, "{bad backup", "utf8");

    assert.throws(
      () => recoverJsonFile(filePath),
      (error) => error.code === "JSON_STATE_UNRECOVERABLE" && error.blocker === true
    );
    assert.strictEqual(fs.readFileSync(filePath, "utf8"), "{bad target");
  });

  test("writeJsonAtomic removes its temp file when final rename fails", () => {
    const filePath = makePath("rename-failure", "state.json");
    const lockPath = lockPathFor(filePath);
    const originalRenameSync = fs.renameSync;
    let sawOwnedLockDuringRename = false;
    fs.renameSync = (sourcePath, targetPath) => {
      if (String(sourcePath).includes(".tmp-") && targetPath === filePath) {
        sawOwnedLockDuringRename = fs.existsSync(lockPath);
        const error = new Error("rename failed");
        error.code = "EIO";
        throw error;
      }
      return originalRenameSync(sourcePath, targetPath);
    };
    try {
      assert.throws(() => writeJsonAtomic(filePath, { version: 1 }), /rename failed/);
    } finally {
      fs.renameSync = originalRenameSync;
    }

    assert.strictEqual(fs.existsSync(filePath), false);
    assert.strictEqual(sawOwnedLockDuringRename, true);
    assert.strictEqual(fs.existsSync(lockPath), false);
    assert.deepStrictEqual(tempFilesFor(filePath), []);
  });

  test("appendJsonlAtomic preserves valid JSON lines through atomic replacement", () => {
    const filePath = makePath("events", "events.jsonl");
    appendJsonlAtomic(filePath, { type: "first", text: "開始" });
    const result = appendJsonlAtomic(filePath, { type: "second", text: "終了" });

    const lines = fs.readFileSync(filePath, "utf8").trimEnd().split(/\r?\n/).map(JSON.parse);
    assert.deepStrictEqual(lines, [
      { type: "first", text: "開始" },
      { type: "second", text: "終了" }
    ]);
    assert.strictEqual(result.status, "appended");
    assert.deepStrictEqual(tempFilesFor(filePath), []);
  });

  test("recoverJsonFile does not rewrite a valid Japanese UTF-8 file", () => {
    const filePath = makePath("display-only", "state.json");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const raw = '{"message":"日本語は壊れていない"}\n';
    fs.writeFileSync(filePath, raw, "utf8");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    const before = fs.statSync(filePath).mtimeMs;

    const result = recoverJsonFile(filePath);

    assert.strictEqual(result.status, "valid");
    assert.deepStrictEqual(result.data, { message: "日本語は壊れていない" });
    assert.strictEqual(fs.readFileSync(filePath, "utf8"), raw);
    assert.strictEqual(fs.statSync(filePath).mtimeMs, before);
    assert.deepStrictEqual(tempFilesFor(filePath), []);
  });

  test("cross-process append preserves every distinct event", async () => {
    const filePath = makePath("concurrent-append", "events.jsonl");
    const requested = 24;
    const workers = await runConcurrentWorkers("append", filePath, requested);
    const failures = workers.filter((worker) => worker.code !== 0);
    assert.deepStrictEqual(failures, [], failures.map((worker) => worker.stderr).join("\n"));

    const events = fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
    assert.strictEqual(events.length, requested);
    assert.strictEqual(new Set(events.map((event) => event.id)).size, requested);
  });

  test("cross-process update serializes read-modify-write increments", async () => {
    const filePath = makePath("concurrent-update", "counter.json");
    const requested = 24;
    const workers = await runConcurrentWorkers("increment", filePath, requested);
    const failures = workers.filter((worker) => worker.code !== 0);
    assert.deepStrictEqual(failures, [], failures.map((worker) => worker.stderr).join("\n"));
    assert.deepStrictEqual(readJsonFile(filePath), { count: requested });
  });

  test("target lock exists during update and is removed after success and updater failure", () => {
    const filePath = makePath("lock-lifecycle", "state.json");
    const lockPath = lockPathFor(filePath);
    let sawLockOnSuccess = false;
    const result = updateJsonAtomic(filePath, { count: 0 }, (state) => {
      sawLockOnSuccess = fs.existsSync(lockPath);
      return { count: state.count + 1 };
    });

    assert.strictEqual(sawLockOnSuccess, true);
    assert.strictEqual(result.lock.released, true);
    assert.strictEqual(fs.existsSync(lockPath), false);

    let sawLockOnFailure = false;
    assert.throws(() => updateJsonAtomic(filePath, { count: 0 }, () => {
      sawLockOnFailure = fs.existsSync(lockPath);
      throw new Error("updater failure under lock");
    }), /updater failure under lock/);
    assert.strictEqual(sawLockOnFailure, true);
    assert.strictEqual(fs.existsSync(lockPath), false);
  });

  test("stale dead-owner lock blocks with structured evidence instead of being stolen", () => {
    const filePath = makePath("stale-lock", "state.json");
    const lockPath = lockPathFor(filePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(lockPath, `${JSON.stringify({
      version: 1,
      pid: 2147483647,
      owner_token: "stale-owner",
      target_path: filePath,
      acquired_at: "2000-01-01T00:00:00.000Z"
    })}\n`, "utf8");

    try {
      assert.throws(
        () => updateJsonAtomic(filePath, { count: 0 }, (state) => ({ count: state.count + 1 }), {
          lockTimeoutMs: 250,
          lockRetryDelayMs: 5,
          staleLockMs: 10
        }),
        (error) => (
          error.code === "JSON_STATE_STALE_LOCK"
          && error.blocker === true
          && error.lockPath === lockPath
          && error.owner?.owner_token === "stale-owner"
          && error.ageMs >= 10
        )
      );
      assert.strictEqual(fs.existsSync(filePath), false);
      assert.strictEqual(JSON.parse(fs.readFileSync(lockPath, "utf8")).owner_token, "stale-owner");
    } finally {
      fs.rmSync(lockPath, { force: true });
    }
  });

  test("owner replacement after stale observation is preserved and never entered", () => {
    const filePath = makePath("stale-replacement", "state.json");
    const lockPath = lockPathFor(filePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const staleOwner = {
      version: 1,
      pid: 2147483647,
      owner_token: "observed-stale-owner",
      target_path: filePath,
      acquired_at: "2000-01-01T00:00:00.000Z"
    };
    const replacementOwner = {
      version: 1,
      pid: process.pid,
      owner_token: "fresh-replacement-owner",
      target_path: filePath,
      acquired_at: new Date().toISOString()
    };
    fs.writeFileSync(lockPath, `${JSON.stringify(staleOwner)}\n`, "utf8");

    const originalReadFileSync = fs.readFileSync;
    let replacementInstalled = false;
    let updaterEntered = false;
    fs.readFileSync = (targetPath, ...args) => {
      const value = originalReadFileSync(targetPath, ...args);
      if (targetPath === lockPath && !replacementInstalled) {
        fs.writeFileSync(lockPath, `${JSON.stringify(replacementOwner)}\n`, "utf8");
        replacementInstalled = true;
      }
      return value;
    };

    try {
      assert.throws(
        () => updateJsonAtomic(filePath, { count: 0 }, (state) => {
          updaterEntered = true;
          return { count: state.count + 1 };
        }, { staleLockMs: 10, lockTimeoutMs: 100, lockRetryDelayMs: 5 }),
        (error) => error.code === "JSON_STATE_STALE_LOCK" && error.owner?.owner_token === staleOwner.owner_token
      );
    } finally {
      fs.readFileSync = originalReadFileSync;
    }

    try {
      assert.strictEqual(replacementInstalled, true);
      assert.strictEqual(updaterEntered, false);
      assert.strictEqual(JSON.parse(fs.readFileSync(lockPath, "utf8")).owner_token, replacementOwner.owner_token);
      assert.strictEqual(fs.existsSync(filePath), false);
    } finally {
      fs.rmSync(lockPath, { force: true });
    }
  });

  test("fresh live lock times out without being stolen", () => {
    const filePath = makePath("live-lock", "state.json");
    const lockPath = lockPathFor(filePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const owner = {
      version: 1,
      pid: process.pid,
      owner_token: "live-owner",
      target_path: filePath,
      acquired_at: new Date().toISOString()
    };
    fs.writeFileSync(lockPath, `${JSON.stringify(owner)}\n`, "utf8");

    try {
      assert.throws(
        () => writeJsonAtomic(filePath, { value: "blocked" }, {
          lockTimeoutMs: 40,
          lockRetryDelayMs: 5,
          staleLockMs: 10000
        }),
        (error) => (
          error.code === "JSON_STATE_LOCK_TIMEOUT"
          && error.blocker === true
          && error.lockPath === lockPath
          && error.owner?.owner_token === owner.owner_token
          && error.timeoutMs === 40
        )
      );
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(lockPath, "utf8")), owner);
      assert.strictEqual(fs.existsSync(filePath), false);
    } finally {
      fs.rmSync(lockPath, { force: true });
    }
  });

  test("owner replacement after release check is preserved", () => {
    const filePath = makePath("release-replacement", "state.json");
    const lockPath = lockPathFor(filePath);
    const replacementOwner = {
      version: 1,
      pid: process.pid,
      owner_token: "replacement-during-release",
      target_path: filePath,
      acquired_at: new Date().toISOString()
    };
    const originalReadFileSync = fs.readFileSync;
    let replacementInstalled = false;
    fs.readFileSync = (targetPath, ...args) => {
      const value = originalReadFileSync(targetPath, ...args);
      if (targetPath === lockPath && !replacementInstalled) {
        fs.writeFileSync(lockPath, `${JSON.stringify(replacementOwner)}\n`, "utf8");
        replacementInstalled = true;
      }
      return value;
    };

    try {
      assert.throws(
        () => writeJsonAtomic(filePath, { value: "written-before-release" }),
        (error) => error.code === "JSON_STATE_LOCK_OWNERSHIP_LOST" && error.blocker === true
      );
    } finally {
      fs.readFileSync = originalReadFileSync;
    }

    try {
      assert.strictEqual(replacementInstalled, true);
      assert.strictEqual(JSON.parse(fs.readFileSync(lockPath, "utf8")).owner_token, replacementOwner.owner_token);
    } finally {
      fs.rmSync(lockPath, { force: true });
    }
  });

  test("acquisition fsync failure never deletes a replacement owner lock", () => {
    const filePath = makePath("acquisition-replacement", "state.json");
    const lockPath = lockPathFor(filePath);
    const replacementOwner = {
      version: 1,
      pid: process.pid,
      owner_token: "replacement-after-acquisition-failure",
      target_path: filePath,
      acquired_at: new Date().toISOString()
    };
    const originalOpenSync = fs.openSync;
    const originalFsyncSync = fs.fsyncSync;
    const originalRmSync = fs.rmSync;
    const originalWriteFileSync = fs.writeFileSync;
    let lockHandle;
    let cleanupAttempted = false;

    fs.openSync = (targetPath, ...args) => {
      const handle = originalOpenSync(targetPath, ...args);
      if (targetPath === lockPath) lockHandle = handle;
      return handle;
    };
    fs.fsyncSync = (handle) => {
      if (handle === lockHandle) {
        const error = new Error("injected acquisition metadata fsync failure");
        error.code = "EIO";
        throw error;
      }
      return originalFsyncSync(handle);
    };
    fs.rmSync = (targetPath, options) => {
      if (targetPath === lockPath) {
        cleanupAttempted = true;
        originalWriteFileSync(lockPath, `${JSON.stringify(replacementOwner)}\n`, "utf8");
      }
      return originalRmSync(targetPath, options);
    };

    let caught;
    try {
      writeJsonAtomic(filePath, { value: "must-not-write" });
    } catch (error) {
      caught = error;
    } finally {
      fs.openSync = originalOpenSync;
      fs.fsyncSync = originalFsyncSync;
      fs.rmSync = originalRmSync;
    }

    if (!cleanupAttempted) {
      originalWriteFileSync(lockPath, `${JSON.stringify(replacementOwner)}\n`, "utf8");
    }

    try {
      assert.strictEqual(caught?.code, "EIO");
      assert.strictEqual(cleanupAttempted, false);
      assert.strictEqual(caught?.blocker, true);
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(lockPath, "utf8")), replacementOwner);
      assert.throws(
        () => writeJsonAtomic(filePath, { value: "second-writer" }, {
          lockTimeoutMs: 40,
          lockRetryDelayMs: 5,
          staleLockMs: 10000
        }),
        (error) => error.code === "JSON_STATE_LOCK_TIMEOUT" && error.blocker === true
      );
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(lockPath, "utf8")), replacementOwner);
      assert.strictEqual(fs.existsSync(filePath), false);
    } finally {
      fs.rmSync(lockPath, { force: true });
    }
  });

  test("acquisition cleanup failure is attached to the initialization error", () => {
    const filePath = makePath("acquisition-cleanup-evidence", "state.json");
    const lockPath = lockPathFor(filePath);
    const originalOpenSync = fs.openSync;
    const originalWriteFileSync = fs.writeFileSync;
    const originalCloseSync = fs.closeSync;
    let lockHandle;
    let metadataWriteFailed = false;
    let cleanupFailureInjected = false;

    fs.openSync = (targetPath, ...args) => {
      const handle = originalOpenSync(targetPath, ...args);
      if (targetPath === lockPath) lockHandle = handle;
      return handle;
    };
    fs.writeFileSync = (target, ...args) => {
      if (target === lockHandle) {
        metadataWriteFailed = true;
        const error = new Error("injected acquisition metadata write failure");
        error.code = "EIO";
        throw error;
      }
      return originalWriteFileSync(target, ...args);
    };
    fs.closeSync = (handle) => {
      if (handle === lockHandle && metadataWriteFailed && !cleanupFailureInjected) {
        cleanupFailureInjected = true;
        originalCloseSync(handle);
        const error = new Error("injected acquisition handle cleanup failure");
        error.code = "EBUSY";
        throw error;
      }
      return originalCloseSync(handle);
    };

    let caught;
    try {
      writeJsonAtomic(filePath, { value: "must-not-write" });
    } catch (error) {
      caught = error;
    } finally {
      fs.openSync = originalOpenSync;
      fs.writeFileSync = originalWriteFileSync;
      fs.closeSync = originalCloseSync;
    }

    try {
      assert.strictEqual(caught?.message, "injected acquisition metadata write failure");
      assert.strictEqual(caught?.code, "EIO");
      assert.strictEqual(caught?.blocker, true);
      assert.deepStrictEqual(caught?.acquisitionFailure, {
        phase: "metadata_initialization",
        path: lockPath,
        code: "EIO",
        message: "injected acquisition metadata write failure"
      });
      assert.deepStrictEqual(caught?.cleanupFailures, [{
        phase: "handle_close",
        path: lockPath,
        code: "EBUSY",
        message: "injected acquisition handle cleanup failure"
      }]);
      assert.strictEqual(fs.existsSync(lockPath), true);
      assert.strictEqual(fs.existsSync(filePath), false);
    } finally {
      fs.rmSync(lockPath, { force: true });
    }
  });

  test("transition metadata creation failure blocks later writers and preserves artifacts", () => {
    const filePath = makePath("transition-create-failure", "state.json");
    const lockPath = lockPathFor(filePath);
    const transitionPath = `${lockPath}.transition`;
    const originalOpenSync = fs.openSync;
    const originalWriteFileSync = fs.writeFileSync;
    let transitionHandle;

    fs.openSync = (targetPath, ...args) => {
      const handle = originalOpenSync(targetPath, ...args);
      if (targetPath === transitionPath) transitionHandle = handle;
      return handle;
    };
    fs.writeFileSync = (target, ...args) => {
      if (target === transitionHandle) {
        const error = new Error("injected transition metadata creation failure");
        error.code = "EIO";
        throw error;
      }
      return originalWriteFileSync(target, ...args);
    };

    let caught;
    try {
      writeJsonAtomic(filePath, { value: "first-writer-committed" });
    } catch (error) {
      caught = error;
    } finally {
      fs.openSync = originalOpenSync;
      fs.writeFileSync = originalWriteFileSync;
    }

    try {
      assert.strictEqual(caught?.code, "EIO");
      assert.strictEqual(caught?.blocker, true);
      assert.deepStrictEqual(caught?.transitionFailure, {
        phase: "metadata_initialization",
        path: transitionPath,
        code: "EIO",
        message: "injected transition metadata creation failure"
      });
      assert.strictEqual(fs.existsSync(lockPath), true);
      assert.strictEqual(fs.existsSync(transitionPath), true);
      assert.deepStrictEqual(readJsonFile(filePath), { value: "first-writer-committed" });
      assert.throws(
        () => writeJsonAtomic(filePath, { value: "second-writer" }, {
          lockTimeoutMs: 40,
          lockRetryDelayMs: 5,
          staleLockMs: 10000
        }),
        (error) => error.code === "JSON_STATE_LOCK_TIMEOUT" && error.blocker === true
      );
      assert.deepStrictEqual(readJsonFile(filePath), { value: "first-writer-committed" });
    } finally {
      fs.rmSync(transitionPath, { force: true });
      fs.rmSync(lockPath, { force: true });
    }
  });

  test("transition removal failure blocks later writers and preserves fail-closed state", () => {
    const filePath = makePath("transition-remove-failure", "state.json");
    const lockPath = lockPathFor(filePath);
    const transitionPath = `${lockPath}.transition`;
    const originalUnlinkSync = fs.unlinkSync;
    fs.unlinkSync = (targetPath) => {
      if (targetPath === transitionPath) {
        const error = new Error("injected transition removal failure");
        error.code = "EIO";
        throw error;
      }
      return originalUnlinkSync(targetPath);
    };

    let caught;
    try {
      writeJsonAtomic(filePath, { value: "first-writer-committed" });
    } catch (error) {
      caught = error;
    } finally {
      fs.unlinkSync = originalUnlinkSync;
    }

    try {
      assert.strictEqual(caught?.code, "EIO");
      assert.strictEqual(caught?.blocker, true);
      assert.deepStrictEqual(caught?.transitionFailure, {
        phase: "artifact_removal",
        path: transitionPath,
        code: "EIO",
        message: "injected transition removal failure"
      });
      assert.strictEqual(fs.existsSync(lockPath), false);
      assert.strictEqual(fs.existsSync(transitionPath), true);
      assert.deepStrictEqual(readJsonFile(filePath), { value: "first-writer-committed" });
      assert.throws(
        () => writeJsonAtomic(filePath, { value: "second-writer" }, {
          lockTimeoutMs: 40,
          lockRetryDelayMs: 5,
          staleLockMs: 10000
        }),
        (error) => error.code === "JSON_STATE_LOCK_TIMEOUT" && error.blocker === true
      );
      assert.deepStrictEqual(readJsonFile(filePath), { value: "first-writer-committed" });
    } finally {
      fs.rmSync(transitionPath, { force: true });
    }
  });

  test("non-transient temp cleanup failure is attached to the original write error", () => {
    const filePath = makePath("cleanup-evidence", "state.json");
    const originalRenameSync = fs.renameSync;
    const originalUnlinkSync = fs.unlinkSync;
    let tempPath;
    fs.renameSync = (sourcePath, targetPath) => {
      if (String(sourcePath).includes(".tmp-") && targetPath === filePath) {
        tempPath = sourcePath;
        const error = new Error("primary replace failure");
        error.code = "EIO";
        throw error;
      }
      return originalRenameSync(sourcePath, targetPath);
    };
    fs.unlinkSync = (targetPath) => {
      if (targetPath === tempPath) {
        const error = new Error("cleanup artifact retained");
        error.code = "EIO";
        throw error;
      }
      return originalUnlinkSync(targetPath);
    };

    let caught;
    try {
      writeJsonAtomic(filePath, { value: "cannot-commit" });
    } catch (error) {
      caught = error;
    } finally {
      fs.renameSync = originalRenameSync;
      fs.unlinkSync = originalUnlinkSync;
    }

    try {
      assert.strictEqual(caught?.message, "primary replace failure");
      assert.strictEqual(caught?.code, "EIO");
      assert.deepStrictEqual(caught?.cleanupFailures, [{
        path: tempPath,
        code: "EIO",
        message: "cleanup artifact retained"
      }]);
      assert.strictEqual(fs.existsSync(tempPath), true);
    } finally {
      if (tempPath) fs.rmSync(tempPath, { force: true });
    }
  });

  test("transient Windows rename errors are retried within a bounded policy", () => {
    const filePath = makePath("rename-retry", "state.json");
    const originalRenameSync = fs.renameSync;
    const transientCodes = ["EPERM", "EBUSY", "EACCES"];
    let attempts = 0;
    fs.renameSync = (source, target) => {
      if (!String(source).includes(".tmp-") || target !== filePath) {
        return originalRenameSync(source, target);
      }
      attempts += 1;
      const code = transientCodes[attempts - 1];
      if (code) {
        const error = new Error(`transient ${code}`);
        error.code = code;
        throw error;
      }
      return originalRenameSync(source, target);
    };

    let result;
    try {
      result = writeJsonAtomic(filePath, { version: 1 }, {
        renameRetries: 3,
        renameRetryDelayMs: 1
      });
    } finally {
      fs.renameSync = originalRenameSync;
    }

    assert.strictEqual(attempts, 4);
    assert.strictEqual(result.replaceAttempts, 4);
    assert.deepStrictEqual(readJsonFile(filePath), { version: 1 });
    assert.strictEqual(fs.existsSync(lockPathFor(filePath)), false);
  });

  test("non-transient rename errors are surfaced without retry", () => {
    const filePath = makePath("rename-no-retry", "state.json");
    const originalRenameSync = fs.renameSync;
    let attempts = 0;
    fs.renameSync = (source, target) => {
      if (!String(source).includes(".tmp-") || target !== filePath) {
        return originalRenameSync(source, target);
      }
      attempts += 1;
      const error = new Error("non-transient rename failure");
      error.code = "EINVAL";
      throw error;
    };

    try {
      assert.throws(
        () => writeJsonAtomic(filePath, { version: 1 }, { renameRetries: 5, renameRetryDelayMs: 1 }),
        (error) => error.code === "EINVAL"
      );
    } finally {
      fs.renameSync = originalRenameSync;
    }

    assert.strictEqual(attempts, 1);
    assert.strictEqual(fs.existsSync(lockPathFor(filePath)), false);
    assert.deepStrictEqual(tempFilesFor(filePath), []);
  });

} catch (error) {
  fs.rmSync(testRoot, { recursive: true, force: true });
  throw error;
}

(async () => {
  const failures = [];
  try {
    for (const { name, fn } of tests) {
      try {
        await fn();
        console.log(`ok - ${name}`);
      } catch (error) {
        failures.push({ name, error });
        console.error(`not ok - ${name}`);
        console.error(error.stack || error.message || error);
      }
    }
  } finally {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }

  if (failures.length) {
    const error = new Error(`json-state test failed: ${failures.length} failure(s)`);
    error.failures = failures;
    throw error;
  }
  console.log("json-state tests passed");
})().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
