"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const ROOT_LOCKS = new Map();

function unsafePath(message) {
  return Object.assign(new Error(message), { code: "RECORDED_FAKE_UNSAFE_PATH" });
}

function safeName(name) {
  if (typeof name !== "string"
      || name === ""
      || name !== path.basename(name)
      || !/^[A-Za-z0-9.\-]+$/u.test(name)) {
    throw unsafePath("recorded fake adapter name is unsafe");
  }
  return name;
}

function ownerOnly(mode) {
  return (mode & 0o077) === 0;
}

async function acquireRootLock(rootPath) {
  const previous = ROOT_LOCKS.get(rootPath) || Promise.resolve();
  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  const tail = previous.then(() => gate);
  ROOT_LOCKS.set(rootPath, tail);
  await previous;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseGate();
    if (ROOT_LOCKS.get(rootPath) === tail) {
      tail.then(() => {
        if (ROOT_LOCKS.get(rootPath) === tail) ROOT_LOCKS.delete(rootPath);
      });
    }
  };
}

async function verifyExistingEntries(rootPath) {
  for (const name of await fsp.readdir(rootPath)) {
    safeName(name);
    const stat = await fsp.lstat(path.join(rootPath, name));
    if (!stat.isFile() || stat.isSymbolicLink() || !ownerOnly(stat.mode)) {
      throw unsafePath("recorded fake store contains a non-private or non-regular entry");
    }
  }
}

function requireSession(handle) {
  if (!handle || handle.closed === true || !handle.lock_held || !handle.directory_handle) {
    throw Object.assign(new Error("recorded fake adapter session is closed"), { code: "EBADF" });
  }
  return handle;
}

function requireFileHandle(handle) {
  if (!handle || handle.closed === true || !handle.file_handle) {
    throw Object.assign(new Error("recorded fake adapter file is closed"), { code: "EBADF" });
  }
  return handle;
}

function createRecordedFakePosixTestAdapter() {
  return Object.freeze({
    async openStore({ root_path: rootPath }) {
      const release = await acquireRootLock(rootPath);
      try {
        const real = await fsp.realpath(rootPath);
        if (real !== rootPath) throw unsafePath("recorded fake root is not its real path");
        const rootStat = await fsp.lstat(rootPath);
        if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !ownerOnly(rootStat.mode)) {
          throw unsafePath("recorded fake root is not a private real directory");
        }
        await verifyExistingEntries(rootPath);
        const flags = fs.constants.O_RDONLY
          | (fs.constants.O_DIRECTORY || 0)
          | (fs.constants.O_NOFOLLOW || 0);
        const directoryHandle = await fsp.open(rootPath, flags);
        const handle = {
          root_path: rootPath,
          directory_handle: directoryHandle,
          lock_held: true,
          release,
          closed: false,
        };
        return {
          handle,
          proof: {
            proof_version: 1,
            proof_scope: "single_process_test_only",
            platform: process.platform,
            root_realpath: real,
            privacy_enforcement: "creation-mode-and-stat-verification",
            owner_only_directories: true,
            owner_only_files: true,
            private_acl_verified: true,
            symlink_components_rejected: true,
            no_follow_reads: true,
            exclusive_store_sessions: false,
            process_local_exclusive_store_sessions: true,
            exclusive_temp_creation: true,
            atomic_no_replace_rename: true,
            atomic_mutation_index: true,
            file_fsync: true,
            directory_fsync: true,
            coordinated_recovery: true,
            directory_handle_pinned: true,
          },
        };
      } catch (error) {
        release();
        throw error;
      }
    },

    async recoverInterruptedWrites({ store_handle: inputHandle, target_name: targetName, temp_prefix: tempPrefix }) {
      const handle = requireSession(inputHandle);
      safeName(targetName);
      if (typeof tempPrefix !== "string"
          || !tempPrefix.startsWith(`.${targetName}.`)
          || !/^[A-Za-z0-9.\-]+$/u.test(tempPrefix)) {
        throw unsafePath("recorded fake recovery prefix is unsafe");
      }
      for (const name of await fsp.readdir(handle.root_path)) {
        if (!name.startsWith(tempPrefix)) continue;
        safeName(name);
        const target = path.join(handle.root_path, name);
        const stat = await fsp.lstat(target);
        if (!stat.isFile() || stat.isSymbolicLink()) {
          throw unsafePath("recorded fake recovery found an unsafe temporary entry");
        }
        await fsp.unlink(target);
      }
      await handle.directory_handle.sync();
      return {
        recovery_version: 1,
        root_realpath: handle.root_path,
        exclusive_recovery: true,
        session_lock_held: true,
        stale_temps_handled: true,
        directory_fsynced: true,
      };
    },

    async readFileNoFollow({ store_handle: inputHandle, name, max_bytes: maxBytes }) {
      const handle = requireSession(inputHandle);
      safeName(name);
      const target = path.join(handle.root_path, name);
      const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
      const fileHandle = await fsp.open(target, flags);
      try {
        const stat = await fileHandle.stat();
        if (!stat.isFile() || !ownerOnly(stat.mode)) {
          throw unsafePath("recorded fake target is not a private regular file");
        }
        const bytes = await fileHandle.readFile();
        if (bytes.length > maxBytes) {
          throw Object.assign(new Error("recorded fake target exceeds read limit"), { code: "EFBIG" });
        }
        return bytes;
      } finally {
        await fileHandle.close();
      }
    },

    async openTempExclusive({ store_handle: inputHandle, name, mode }) {
      const handle = requireSession(inputHandle);
      safeName(name);
      if (mode !== 0o600) throw unsafePath("recorded fake temp mode is not owner-only");
      const flags = fs.constants.O_CREAT
        | fs.constants.O_EXCL
        | fs.constants.O_WRONLY
        | (fs.constants.O_NOFOLLOW || 0);
      const fileHandle = await fsp.open(path.join(handle.root_path, name), flags, mode);
      return { file_handle: fileHandle, closed: false };
    },

    async writeAll({ file_handle: inputHandle, bytes }) {
      const handle = requireFileHandle(inputHandle);
      if (!Buffer.isBuffer(bytes)) {
        throw Object.assign(new Error("recorded fake write requires Buffer bytes"), { code: "EINVAL" });
      }
      await handle.file_handle.writeFile(bytes);
    },

    async fsyncFile({ file_handle: inputHandle }) {
      const handle = requireFileHandle(inputHandle);
      await handle.file_handle.sync();
    },

    async closeFile({ file_handle: inputHandle }) {
      const handle = requireFileHandle(inputHandle);
      handle.closed = true;
      await handle.file_handle.close();
    },

    async renameTempNoReplace({ store_handle: inputHandle, from_name: fromName, to_name: toName }) {
      const handle = requireSession(inputHandle);
      safeName(fromName);
      safeName(toName);
      const from = path.join(handle.root_path, fromName);
      const to = path.join(handle.root_path, toName);
      await fsp.link(from, to);
      await fsp.unlink(from);
    },

    async unlinkTempNoFollow({ store_handle: inputHandle, name }) {
      const handle = requireSession(inputHandle);
      safeName(name);
      const target = path.join(handle.root_path, name);
      let stat;
      try {
        stat = await fsp.lstat(target);
      } catch (error) {
        if (error?.code === "ENOENT") throw error;
        throw error;
      }
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw unsafePath("recorded fake temporary target is unsafe");
      }
      await fsp.unlink(target);
    },

    async fsyncDirectory({ store_handle: inputHandle }) {
      const handle = requireSession(inputHandle);
      await handle.directory_handle.sync();
    },

    async closeStore({ store_handle: inputHandle }) {
      if (!inputHandle || inputHandle.closed === true) return;
      inputHandle.closed = true;
      inputHandle.lock_held = false;
      let primary = null;
      try {
        await inputHandle.directory_handle.close();
      } catch (error) {
        primary = error;
      } finally {
        inputHandle.release();
      }
      if (primary) throw primary;
    },
  });
}

module.exports = { createRecordedFakePosixTestAdapter };
