"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  appendJsonlAtomic,
  readJsonFile,
  recoverJsonFile,
  updateTextAtomic,
  updateJsonAtomic,
  writeJsonAtomic,
} = require("../orquesta/scripts/json-state");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-json-state-current-"));
const helperPath = path.resolve(__dirname, "../orquesta/scripts/json-state.js");

test.after(() => fs.rmSync(testRoot, { recursive: true, force: true }));

function fixturePath(...parts) {
  return path.join(testRoot, ...parts);
}

function lockMetadata(targetPath, ownerToken) {
  return {
    version: 1,
    pid: 2147483647,
    owner_token: ownerToken,
    target_path: targetPath,
    acquired_at: "2000-01-01T00:00:00.000Z",
  };
}

function tempFilesFor(filePath) {
  const directory = path.dirname(filePath);
  if (!fs.existsSync(directory)) return [];
  const prefix = `${path.basename(filePath)}.tmp-`;
  return fs.readdirSync(directory).filter((name) => name.startsWith(prefix));
}

async function runConcurrentWorkers(mode, filePath, count) {
  const startPath = fixturePath(`start-${mode}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const source = [
    'const fs = require("node:fs");',
    'const { appendJsonlAtomic, updateJsonAtomic } = require(process.argv[1]);',
    'const [mode, filePath, id, startPath] = process.argv.slice(2);',
    'process.stdout.write("ready\\n");',
    'while (!fs.existsSync(startPath)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);',
    'if (mode === "append") appendJsonlAtomic(filePath, { id: Number(id), text: `event-${id}` });',
    'if (mode === "increment") updateJsonAtomic(filePath, { count: 0 }, (state) => ({ count: Number(state.count || 0) + 1 }));',
  ].join(" ");

  const workers = Array.from({ length: count }, (_, id) => {
    const child = spawn(process.execPath, ["-e", source, helperPath, mode, filePath, String(id), startPath], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let readyResolve;
    const ready = new Promise((resolve) => { readyResolve = resolve; });
    const exited = new Promise((resolve) => {
      child.once("error", (error) => {
        stderr += error.stack || error.message;
        readyResolve();
      });
      child.once("exit", (code, signal) => {
        readyResolve();
        resolve({ id, code, signal, stdout, stderr });
      });
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("ready")) readyResolve();
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    return { ready, exited };
  });

  await Promise.all(workers.map((worker) => worker.ready));
  fs.writeFileSync(startPath, "go\n", "utf8");
  const results = await Promise.all(workers.map((worker) => worker.exited));
  fs.rmSync(startPath, { force: true });
  return results;
}

test("event replay is idempotent only when the entire body matches", () => {
  const filePath = fixturePath("event-collision", "events.jsonl");
  const event = { event_id: "task:1:proof", type: "task_accepted", summary: "正しい結果" };
  appendJsonlAtomic(filePath, event);
  const replay = appendJsonlAtomic(filePath, { summary: "正しい結果", type: "task_accepted", event_id: "task:1:proof" });
  assert.equal(replay.status, "already_present");

  assert.throws(
    () => appendJsonlAtomic(filePath, { ...event, type: "task_rejected" }),
    (error) => error.code === "JSON_STATE_EVENT_ID_COLLISION" && error.blocker === true,
  );
  assert.deepEqual(fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/u).map(JSON.parse), [event]);
});

test("locked validation runs after ownership is acquired and before target mutation", () => {
  const filePath = fixturePath("locked-validation", "state.json");
  let observedLock = false;
  assert.throws(
    () => writeJsonAtomic(filePath, { version: 1 }, {
      validateLocked(targetPath) {
        assert.equal(targetPath, filePath);
        observedLock = fs.existsSync(`${filePath}.lock`);
        const error = new Error("target containment changed");
        error.code = "TARGET_CONTAINMENT_CHANGED";
        throw error;
      },
    }),
    { code: "TARGET_CONTAINMENT_CHANGED" },
  );
  assert.equal(observedLock, true);
  assert.equal(fs.existsSync(filePath), false);
  assert.equal(fs.existsSync(`${filePath}.lock`), false);
});

test("parent binding uses relative I/O but preserves absolute evidence and restores cwd", () => {
  const filePath = fixturePath("bound-parent", "state.json");
  const backupPath = fixturePath("bound-parent", "custom-backup.json");
  const originalCwd = process.cwd();
  writeJsonAtomic(filePath, { count: 1, path: "caller-relative-data" });
  const originalOpen = fs.openSync;
  const opened = [];
  fs.openSync = function (target, flags, ...args) {
    if (flags === "wx") opened.push(target);
    return originalOpen.call(this, target, flags, ...args);
  };
  let result;
  try {
    result = updateJsonAtomic(filePath, null, (state) => ({ ...state, count: 2 }), {
      bindParentDirectory: true,
      backup: true,
      backupPath,
      validateLocked(target) {
        assert.equal(target, filePath);
        assert.equal(process.cwd(), path.dirname(filePath));
        assert.equal(readJsonFile(`${filePath}.lock`).target_path, filePath);
      },
    });
  } finally {
    fs.openSync = originalOpen;
  }
  assert.equal(process.cwd(), originalCwd);
  assert.equal(result.path, filePath);
  assert.equal(result.backupPath, backupPath);
  assert.equal(result.lock.path, `${filePath}.lock`);
  assert.equal(path.dirname(result.tempPath), path.dirname(filePath));
  assert.ok(opened.length >= 3);
  assert.ok(opened.every((target) => target === path.basename(target)));
  assert.deepEqual(readJsonFile(filePath), { count: 2, path: "caller-relative-data" });
  assert.deepEqual(readJsonFile(backupPath), { count: 1, path: "caller-relative-data" });

  updateJsonAtomic(filePath, null, (state) => {
    assert.equal(process.cwd(), originalCwd);
    return state;
  });
});

test("a parent swap before chdir is rejected before any lock write", () => {
  const parent = fixturePath("bound-before-chdir");
  const saved = fixturePath("bound-before-chdir-saved");
  const outside = fixturePath("bound-before-chdir-outside");
  fs.mkdirSync(parent);
  fs.mkdirSync(outside);
  const originalChdir = process.chdir;
  let swapped = false;
  process.chdir = function (target) {
    if (target === parent && !swapped) {
      fs.renameSync(parent, saved);
      fs.symlinkSync(outside, parent, process.platform === "win32" ? "junction" : "dir");
      swapped = true;
    }
    return originalChdir.call(process, target);
  };
  try {
    assert.throws(() => writeJsonAtomic(path.join(parent, "state.json"), { value: 1 }, {
      bindParentDirectory: true,
    }), { code: "JSON_STATE_PARENT_BINDING_LOST" });
    assert.deepEqual(fs.readdirSync(outside), []);
    assert.deepEqual(fs.readdirSync(saved), []);
  } finally {
    process.chdir = originalChdir;
    if (swapped) {
      fs.rmdirSync(parent);
      fs.renameSync(saved, parent);
    }
  }
});

test("bound lock, temp and release writes stay on the original parent during a directory swap", async (t) => {
  for (const phase of ["lock", "temp", "release"]) {
    await t.test(phase, () => {
      const parent = fixturePath(`bound-during-${phase}`);
      const saved = fixturePath(`bound-during-${phase}-saved`);
      const outside = fixturePath(`bound-during-${phase}-outside`);
      fs.mkdirSync(parent);
      fs.mkdirSync(outside);
      const target = path.join(parent, "state.json");
      const originalCwd = process.cwd();
      const originalOpen = fs.openSync;
      let attempted = false;
      let swapped = false;
      fs.openSync = function (file, flags, ...args) {
        const matches = phase === "lock" ? String(file).startsWith("state.json.lock.tmp-")
          : phase === "temp" ? String(file).startsWith("state.json.tmp-")
            : String(file).startsWith("state.json.lock.transition.tmp-");
        if (flags === "wx" && matches && !attempted) {
          attempted = true;
          try {
            fs.renameSync(parent, saved);
            swapped = true;
            fs.symlinkSync(outside, parent, process.platform === "win32" ? "junction" : "dir");
          } catch (error) {
            assert.equal(process.platform, "win32");
            assert.ok(["EPERM", "EACCES", "EBUSY"].includes(error.code), error.message);
          }
        }
        return originalOpen.call(this, file, flags, ...args);
      };
      try {
        const result = writeJsonAtomic(target, { value: phase }, { bindParentDirectory: true });
        assert.equal(result.status, "written");
        assert.equal(result.path, target);
        assert.equal(attempted, true);
        assert.equal(process.cwd(), originalCwd);
        assert.deepEqual(readJsonFile(path.join(swapped ? saved : parent, "state.json")), { value: phase });
        assert.deepEqual(fs.readdirSync(outside), []);
      } finally {
        fs.openSync = originalOpen;
        if (swapped) {
          fs.rmdirSync(parent);
          fs.renameSync(saved, parent);
        }
      }
    });
  }
});

test("bound writers reject thenable callbacks before writing the target", async (t) => {
  const cases = {
    validation: (file) => writeJsonAtomic(file, { changed: true }, {
      bindParentDirectory: true, validateLocked: () => Promise.resolve(),
    }),
    jsonUpdater: (file) => updateJsonAtomic(file, null, () => Promise.resolve({ changed: true }), { bindParentDirectory: true }),
    textUpdater: (file) => updateTextAtomic(file, "", () => ({ then() {} }), { bindParentDirectory: true }),
  };
  for (const [name, action] of Object.entries(cases)) {
    await t.test(name, () => {
      const file = fixturePath(`bound-async-${name}`, "state.json");
      writeJsonAtomic(file, { changed: false });
      const before = fs.readFileSync(file);
      const originalCwd = process.cwd();
      assert.throws(() => action(file), { code: "JSON_STATE_ASYNC_UNSUPPORTED" });
      assert.deepEqual(fs.readFileSync(file), before);
      assert.equal(process.cwd(), originalCwd);
      assert.equal(fs.existsSync(`${file}.lock`), false);
      assert.deepEqual(tempFilesFor(file), []);
    });
  }
});

test("parent binding rejects unsafe backups and recovery before mutation", () => {
  const file = fixturePath("bound-unsupported", "state.json");
  writeJsonAtomic(file, { value: "original" });
  for (const backupPath of [fixturePath("outside-backup.json"), file]) {
    assert.throws(() => writeJsonAtomic(file, {}, { bindParentDirectory: true, backup: true, backupPath }), {
      code: "JSON_STATE_BACKUP_UNSAFE",
    });
  }
  let notified = false;
  assert.throws(() => recoverJsonFile(file, { bindParentDirectory: true, onIncident() { notified = true; } }), {
    code: "JSON_STATE_RECOVERY_BINDING_UNSUPPORTED",
  });
  assert.equal(notified, false);
  assert.equal(fs.existsSync(`${file}.lock`), false);
  assert.deepEqual(readJsonFile(file), { value: "original" });
});

test("cwd restoration failure is reported even when the write committed", () => {
  const file = fixturePath("bound-restore-failure", "state.json");
  fs.mkdirSync(path.dirname(file));
  const originalCwd = process.cwd();
  const originalChdir = process.chdir;
  process.chdir = function (target) {
    if (target === originalCwd) throw Object.assign(new Error("injected restore failure"), { code: "EPERM" });
    return originalChdir.call(process, target);
  };
  try {
    assert.throws(() => writeJsonAtomic(file, { committed: true }, { bindParentDirectory: true }), (error) => {
      assert.equal(error.code, "JSON_STATE_CWD_RESTORE_FAILED");
      assert.equal(error.blocker, true);
      assert.equal(error.result.status, "written");
      return true;
    });
  } finally {
    process.chdir = originalChdir;
    originalChdir.call(process, originalCwd);
  }
  assert.deepEqual(readJsonFile(file), { committed: true });
  assert.equal(fs.existsSync(`${file}.lock`), false);
});

test("a callback that changes cwd cannot redirect the target or lock release", () => {
  const file = fixturePath("bound-callback-cwd", "state.json");
  const outside = fixturePath("bound-callback-cwd-outside");
  fs.mkdirSync(outside);
  writeJsonAtomic(file, { original: true });
  const originalCwd = process.cwd();
  assert.throws(() => updateJsonAtomic(file, null, () => {
    process.chdir(outside);
    return { redirected: true };
  }, { bindParentDirectory: true }), (error) => {
    assert.equal(error.code, "JSON_STATE_PARENT_BINDING_LOST");
    assert.equal(error.lock.path, `${file}.lock`);
    assert.equal(error.lock.released, false);
    return true;
  });
  assert.equal(process.cwd(), originalCwd);
  assert.deepEqual(readJsonFile(file), { original: true });
  assert.deepEqual(fs.readdirSync(outside), []);
  fs.unlinkSync(`${file}.lock`);
});

test("backup and restore copies never follow a destination symlink", async (t) => {
  for (const mode of ["dangling-backup", "raced-backup", "dangling-restore"]) {
    await t.test(mode, () => {
      const file = fixturePath(mode, "state.json");
      const backup = `${file}.bak`;
      const outside = fixturePath(`${mode}-outside.json`);
      writeJsonAtomic(file, { original: true });
      const originalLink = fs.linkSync;
      const originalRename = fs.renameSync;
      if (mode === "dangling-backup") fs.symlinkSync(outside, backup, "file");
      if (mode === "raced-backup") {
        fs.writeFileSync(backup, "old backup", "utf8");
        fs.linkSync = function (source, target) {
          if (target === backup) {
            fs.symlinkSync(outside, backup, "file");
          }
          return originalLink.call(this, source, target);
        };
      }
      if (mode === "dangling-restore") {
        fs.renameSync = function (source, target) {
          if (target === file && String(source).startsWith(`${file}.tmp-`)) {
            fs.unlinkSync(file);
            fs.symlinkSync(outside, file, "file");
            throw Object.assign(new Error("injected final rename failure"), { code: "EIO" });
          }
          return originalRename.call(this, source, target);
        };
      }
      try {
        assert.throws(() => writeJsonAtomic(file, { changed: true }, { backup: true }), (error) => {
          if (mode === "dangling-restore") {
            assert.equal(error.code, "EIO");
            assert.ok(error.cleanupFailures.some((failure) => failure.phase === "target_restore"
              && failure.code === "JSON_STATE_FILE_UNSAFE"));
          }
          return true;
        });
        assert.equal(fs.existsSync(outside), false);
        assert.deepEqual(readJsonFile(mode === "dangling-restore" ? backup : file), { original: true });
        assert.equal(fs.existsSync(`${file}.lock`), false);
      } finally {
        fs.linkSync = originalLink;
        fs.renameSync = originalRename;
      }
    });
  }
});

test("fixed lock and transition paths reject dangling links without external writes", async (t) => {
  for (const phase of ["existing-lock", "raced-lock", "raced-transition"]) {
    await t.test(phase, () => {
      const file = fixturePath(phase, "state.json");
      const outside = fixturePath(`${phase}-outside.json`);
      writeJsonAtomic(file, { original: true });
      const unsafePath = phase === "raced-transition" ? `${file}.lock.transition` : `${file}.lock`;
      const originalLink = fs.linkSync;
      if (phase === "existing-lock") fs.symlinkSync(outside, unsafePath, "file");
      else {
        fs.linkSync = function (source, target) {
          if (target === unsafePath) fs.symlinkSync(outside, unsafePath, "file");
          return originalLink.call(this, source, target);
        };
      }
      try {
        assert.throws(() => writeJsonAtomic(file, { changed: true }, { lockTimeoutMs: 0 }), (error) => {
          assert.equal(error.blocker, true);
          return true;
        });
        assert.equal(fs.existsSync(outside), false);
        assert.equal(fs.lstatSync(unsafePath).isSymbolicLink(), true);
        assert.deepEqual(readJsonFile(file), phase === "raced-transition" ? { changed: true } : { original: true });
      } finally {
        fs.linkSync = originalLink;
      }
    });
  }
});

test("backup publication has an independent inode and cleanup preserves a replaced staging file", () => {
  const file = fixturePath("owned-backup-publication", "state.json");
  const backup = `${file}.bak`;
  writeJsonAtomic(file, { original: true });
  const originalLink = fs.linkSync;
  let foreignStage;
  fs.linkSync = function (source, target) {
    const result = originalLink.call(this, source, target);
    if (target === backup) {
      assert.notEqual(fs.statSync(file, { bigint: true }).ino, fs.statSync(backup, { bigint: true }).ino);
      fs.renameSync(source, `${source}.owned`);
      fs.writeFileSync(source, "foreign replacement", "utf8");
      foreignStage = source;
    }
    return result;
  };
  try {
    assert.throws(() => writeJsonAtomic(file, { changed: true }, { backup: true }), (error) => {
      assert.ok(error.cleanupFailures.some((failure) => failure.code === "JSON_STATE_TEMP_OWNERSHIP_LOST"));
      return true;
    });
    assert.equal(fs.readFileSync(foreignStage, "utf8"), "foreign replacement");
    assert.deepEqual(readJsonFile(file), { original: true });
    assert.deepEqual(readJsonFile(backup), { original: true });
  } finally {
    fs.linkSync = originalLink;
  }
});

test("cross-process updates and appends do not lose state", async () => {
  const workerCount = 8;
  const counterPath = fixturePath("concurrent", "counter.json");
  const eventPath = fixturePath("concurrent", "events.jsonl");
  const [increments, appends] = await Promise.all([
    runConcurrentWorkers("increment", counterPath, workerCount),
    runConcurrentWorkers("append", eventPath, workerCount),
  ]);
  for (const result of [...increments, ...appends]) {
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.signal, null);
  }
  assert.deepEqual(readJsonFile(counterPath), { count: workerCount });
  const events = fs.readFileSync(eventPath, "utf8").trim().split(/\r?\n/u).map(JSON.parse);
  assert.equal(events.length, workerCount);
  assert.equal(new Set(events.map((event) => event.id)).size, workerCount);
});

test("stale target and release-transition locks remain fail-closed", async (t) => {
  for (const kind of ["target", "transition"]) {
    await t.test(kind, () => {
      const filePath = fixturePath(`stale-${kind}`, "state.json");
      const lockPath = `${filePath}.lock`;
      const artifactPath = kind === "target" ? lockPath : `${lockPath}.transition`;
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(artifactPath, `${JSON.stringify(lockMetadata(
        kind === "target" ? filePath : lockPath,
        `stale-${kind}`,
      ))}\n`, "utf8");
      try {
        assert.throws(
          () => updateJsonAtomic(filePath, { count: 0 }, (state) => ({ count: state.count + 1 }), {
            lockTimeoutMs: 50,
            lockRetryDelayMs: 1,
            staleLockMs: 1,
          }),
          (error) => error.code === "JSON_STATE_STALE_LOCK" && error.blocker === true,
        );
        assert.equal(fs.existsSync(artifactPath), true);
        assert.equal(fs.existsSync(filePath), false);
      } finally {
        fs.rmSync(artifactPath, { force: true });
      }
    });
  }
});

test("transient Windows rename failures are retried within one bounded write", () => {
  const filePath = fixturePath("rename-retry", "state.json");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '{"version":0}\n', "utf8");
  const originalRenameSync = fs.renameSync;
  const transientCodes = ["EPERM", "EBUSY", "EACCES"];
  let attempts = 0;
  fs.renameSync = (source, target) => {
    if (!String(source).includes(".tmp-") || target !== filePath) return originalRenameSync(source, target);
    attempts += 1;
    const code = transientCodes[attempts - 1];
    if (code) throw Object.assign(new Error(`transient ${code}`), { code });
    return originalRenameSync(source, target);
  };
  let result;
  try {
    result = writeJsonAtomic(filePath, { version: 1 }, {
      backup: true,
      renameRetries: 3,
      renameRetryDelayMs: 1,
    });
  } finally {
    fs.renameSync = originalRenameSync;
  }
  assert.equal(attempts, 4);
  assert.equal(result.replaceAttempts, 4);
  assert.deepEqual(readJsonFile(filePath), { version: 1 });
});

test("a final rename failure keeps the old target readable and removes its temp", () => {
  const filePath = fixturePath("rename-failure", "state.json");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '{"version":0}\n', "utf8");
  const originalRenameSync = fs.renameSync;
  fs.renameSync = (source, target) => {
    if (String(source).includes(".tmp-") && target === filePath) {
      throw Object.assign(new Error("injected final rename failure"), { code: "EINVAL" });
    }
    return originalRenameSync(source, target);
  };
  try {
    assert.throws(() => writeJsonAtomic(filePath, { version: 1 }, { backup: true }), /final rename failure/u);
  } finally {
    fs.renameSync = originalRenameSync;
  }
  assert.deepEqual(readJsonFile(filePath), { version: 0 });
  assert.deepEqual(tempFilesFor(filePath), []);
  assert.equal(fs.existsSync(`${filePath}.lock`), false);
});

test("a replacement lock owner is never removed during release", () => {
  const filePath = fixturePath("release-owner", "state.json");
  const lockPath = `${filePath}.lock`;
  const replacementOwner = {
    ...lockMetadata(filePath, "replacement-during-release"),
    pid: process.pid,
    acquired_at: new Date().toISOString(),
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
      () => writeJsonAtomic(filePath, { value: "committed-before-release" }),
      (error) => error.code === "JSON_STATE_LOCK_OWNERSHIP_LOST" && error.blocker === true,
    );
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
  try {
    assert.equal(replacementInstalled, true);
    assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).owner_token, replacementOwner.owner_token);
    assert.deepEqual(readJsonFile(filePath), { value: "committed-before-release" });
  } finally {
    fs.rmSync(lockPath, { force: true });
  }
});
