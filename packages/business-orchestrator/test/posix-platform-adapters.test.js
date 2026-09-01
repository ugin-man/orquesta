"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { canonicalHash } = require("@orquesta/contracts");
const {
  createDispatchPacketStore,
  normalizeDispatchPacketV1,
} = require("../src/packet-store");
const {
  createDispatchPacketStorePosixPlatformAdapter,
  createPresendFailureStorePosixAdapter,
  createRecordedFakeProviderPosixPlatformAdapter,
} = require("../src/posix-platform-adapters");

const CHILD = path.join(__dirname, "support", "posix-platform-adapter-child.js");

function target(character = "a") {
  return `dispatch-packet-${character.repeat(64)}.json`;
}

function temp(targetName, character = "b") {
  return `.${targetName}.${character.repeat(48)}.tmp`;
}

function ref(id) {
  return { id, hash: canonicalHash({ id }) };
}

function packet() {
  return {
    schema_version: 1,
    work_order: {
      work_order_id: "wo:posix-adapter",
      work_order_revision: 4,
      engine_contract_version: 2,
    },
    plan: {
      plan_snapshot_ref: "plan:posix-adapter",
      plan_hash: "1".repeat(64),
    },
    branch: {
      branch_ref: "branch:one",
      next_attempt: 2,
      task_intent_ref: ref("intent:posix-adapter"),
      execution_plan_ref: ref("execution:posix-adapter"),
      attempt_packet_ref: null,
    },
    provider: {
      provider_ref: "provider:neutral",
      configuration_ref: ref("provider-config:posix-adapter"),
    },
    workspace: {
      workspace_ref: "workspace:posix-adapter",
      checkpoint_ref: ref("checkpoint:posix-adapter"),
      isolation_mode: "sandbox",
    },
    context: {
      context_pack_ref: ref("context-pack:posix-adapter"),
      context_manifest_ref: ref("context-manifest:posix-adapter"),
      request_payload: { messages: [{ role: "user", content: "adapter integration" }] },
      user_input_request_id: null,
      user_input_response_ref: null,
    },
    authority: {
      authority_ref: ref("authority:posix-adapter"),
      principal_type: "system",
      principal_id: "runtime:posix-adapter",
      project_ref: "project:posix-adapter",
      permission_mode: "workspace-write",
      allowed_provider_refs: ["provider:neutral"],
      allowed_effects: [
        "provider.thread.create",
        "provider.turn.start",
        "provider.user_input.submit",
        "provider.turn.cancel",
      ],
    },
    effect_ceiling: {
      allowed_effect_kinds: ["provider.thread.create"],
      deadline_at: "2026-08-10T00:00:00.000Z",
      max_runtime_ms: 120_000,
      max_output_bytes: 1_048_576,
      max_tool_calls: 32,
    },
  };
}

async function fixture(t, label) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `orquesta-posix-${label}-`));
  await fsp.chmod(root, 0o700);
  t.after(async () => fsp.rm(root, { recursive: true, force: true }));
  return root;
}

async function publish(adapter, handle, targetName, bytes, nonce = "b") {
  const tempName = temp(targetName, nonce);
  const file = await adapter.openTempExclusive({
    store_handle: handle,
    name: tempName,
    mode: 0o600,
  });
  await adapter.writeAll({ file_handle: file, bytes: Buffer.from(bytes) });
  await adapter.fsyncFile({ file_handle: file });
  await adapter.closeFile({ file_handle: file });
  await adapter.renameTempNoReplace({
    store_handle: handle,
    from_name: tempName,
    to_name: targetName,
  });
  await adapter.fsyncDirectory({ store_handle: handle });
}

function childProcess(args) {
  const child = spawn(process.execPath, [CHILD, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  child.stdout.setEncoding("utf8");
  let stderr = "";
  let buffer = "";
  const messages = [];
  const waiters = [];
  const exitPromise = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, stderr }));
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line === "") continue;
      const value = JSON.parse(line);
      messages.push(value);
      for (const waiter of [...waiters]) waiter();
    }
  });
  return {
    child,
    messages,
    stderr: () => stderr,
    async waitFor(event, timeoutMs = 5_000) {
      const existing = messages.find((message) => message.event === event);
      if (existing) return existing;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`timed out waiting for ${event}; stderr=${stderr}`));
        }, timeoutMs);
        const inspect = () => {
          const found = messages.find((message) => message.event === event);
          if (!found) return;
          clearTimeout(timeout);
          const position = waiters.indexOf(inspect);
          if (position >= 0) waiters.splice(position, 1);
          resolve(found);
        };
        waiters.push(inspect);
      });
    },
    waitForExit() {
      return exitPromise;
    },
  };
}

test("exposes exact PacketStore and production mutation-store proof facades", async (t) => {
  const roots = await Promise.all([
    fixture(t, "proof-packet"),
    fixture(t, "proof-recorded"),
    fixture(t, "proof-presend"),
  ]);
  const adapters = [
    createDispatchPacketStorePosixPlatformAdapter(),
    createRecordedFakeProviderPosixPlatformAdapter(),
    createPresendFailureStorePosixAdapter(),
  ];
  const sessions = [];
  for (let index = 0; index < adapters.length; index += 1) {
    sessions.push(await adapters[index].openStore({ root_path: roots[index] }));
  }
  assert.deepEqual(Object.keys(sessions[0].proof).sort(), [
    "atomic_no_replace_rename",
    "coordinated_recovery",
    "directory_fsync",
    "directory_handle_pinned",
    "exclusive_temp_creation",
    "file_fsync",
    "no_follow_reads",
    "owner_only_directories",
    "owner_only_files",
    "platform",
    "privacy_enforcement",
    "private_acl_verified",
    "proof_version",
    "root_realpath",
    "symlink_components_rejected",
  ]);
  for (const session of sessions.slice(1)) {
    assert.equal(session.proof.proof_scope, "production");
    assert.equal(session.proof.exclusive_store_sessions, true);
    assert.equal(session.proof.process_local_exclusive_store_sessions, false);
    assert.equal(session.proof.atomic_mutation_index, true);
  }
  await Promise.all(adapters.map((adapter, index) => adapter.closeStore({
    store_handle: sessions[index].handle,
  })));
});

test("PacketStore writes and verifies real content through the production POSIX facade", async (t) => {
  const root = await fixture(t, "packet-integration");
  const store = createDispatchPacketStore({
    root_path: root,
    platform_adapter: createDispatchPacketStorePosixPlatformAdapter(),
  });
  const expected = packet();
  const packetRef = await store.create(expected);
  assert.match(packetRef.id, /^dispatch-packet:[a-f0-9]{64}$/u);
  assert.deepEqual(await store.read(packetRef), normalizeDispatchPacketV1(expected));
  const names = await fsp.readdir(root);
  assert.deepEqual(names, [`dispatch-packet-${packetRef.hash}.json`]);
  assert.equal((await fsp.stat(path.join(root, names[0]))).mode & 0o777, 0o600);
});

test("rejects traversal, symlink roots and leaves, weak modes, and foreign entries", async (t) => {
  const root = await fixture(t, "unsafe");
  const adapter = createDispatchPacketStorePosixPlatformAdapter();
  await fsp.chmod(root, 0o755);
  await assert.rejects(
    adapter.openStore({ root_path: root }),
    (error) => error?.code === "PACKET_STORE_UNSAFE_PATH",
  );
  await fsp.chmod(root, 0o700);

  const link = `${root}-link`;
  await fsp.symlink(root, link);
  t.after(async () => fsp.rm(link, { force: true }));
  await assert.rejects(
    adapter.openStore({ root_path: link }),
    (error) => error?.code === "PACKET_STORE_UNSAFE_PATH",
  );

  await fsp.writeFile(path.join(root, "foreign.txt"), "foreign", { mode: 0o600 });
  await assert.rejects(
    adapter.openStore({ root_path: root }),
    (error) => error?.code === "PACKET_STORE_UNSAFE_PATH",
  );
  await fsp.unlink(path.join(root, "foreign.txt"));

  const weakTarget = target("d");
  await fsp.writeFile(path.join(root, weakTarget), "weak", { mode: 0o600 });
  await fsp.chmod(path.join(root, weakTarget), 0o644);
  await assert.rejects(
    adapter.openStore({ root_path: root }),
    (error) => error?.code === "PACKET_STORE_UNSAFE_PATH",
  );
  await fsp.unlink(path.join(root, weakTarget));

  const session = await adapter.openStore({ root_path: root });
  await assert.rejects(
    adapter.readFileNoFollow({
      store_handle: session.handle,
      name: "../outside.json",
      max_bytes: 1024,
    }),
    (error) => error?.code === "PACKET_STORE_UNSAFE_PATH",
  );
  const validTarget = target("e");
  await fsp.symlink("/etc/passwd", path.join(root, validTarget));
  await assert.rejects(
    adapter.readFileNoFollow({
      store_handle: session.handle,
      name: validTarget,
      max_bytes: 1024,
    }),
    (error) => error?.code === "ELOOP",
  );
  await fsp.unlink(path.join(root, validTarget));
  await adapter.closeStore({ store_handle: session.handle });
});

test("verifies ownership where permitted instead of treating chmod as proof", async (t) => {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    t.skip("chown ownership rejection requires a privileged test runner");
    return;
  }
  const root = await fixture(t, "ownership");
  try {
    await fsp.chown(root, 65534, 65534);
  } catch (error) {
    if (["EINVAL", "EPERM", "ENOTSUP"].includes(error?.code)) {
      t.skip(`filesystem does not permit ownership mutation (${error.code})`);
      return;
    }
    throw error;
  }
  await assert.rejects(
    createDispatchPacketStorePosixPlatformAdapter().openStore({ root_path: root }),
    (error) => error?.code === "PACKET_STORE_UNSAFE_PATH",
  );
  await fsp.chown(root, 0, 0);
  await fsp.chmod(root, 0o700);
});

test("recovers target-derived stale temps and preserves atomic no-replace winners", async (t) => {
  const root = await fixture(t, "recovery");
  const adapter = createDispatchPacketStorePosixPlatformAdapter();
  const targetName = target("f");
  const tempName = temp(targetName, "1");
  let session = await adapter.openStore({ root_path: root });
  const file = await adapter.openTempExclusive({
    store_handle: session.handle,
    name: tempName,
    mode: 0o600,
  });
  await adapter.writeAll({ file_handle: file, bytes: Buffer.from("partial") });
  await adapter.fsyncFile({ file_handle: file });
  await adapter.closeFile({ file_handle: file });
  await adapter.closeStore({ store_handle: session.handle });

  session = await adapter.openStore({ root_path: root });
  const recovery = await adapter.recoverInterruptedWrites({
    store_handle: session.handle,
    target_name: targetName,
    temp_prefix: `.${targetName}.`,
  });
  assert.equal(recovery.exclusive_recovery, true);
  assert.equal(recovery.directory_fsynced, true);
  assert.equal((await fsp.readdir(root)).includes(tempName), false);

  await publish(adapter, session.handle, targetName, "winner", "2");
  const losingTemp = temp(targetName, "3");
  const losingFile = await adapter.openTempExclusive({
    store_handle: session.handle,
    name: losingTemp,
    mode: 0o600,
  });
  await adapter.writeAll({ file_handle: losingFile, bytes: Buffer.from("loser") });
  await adapter.fsyncFile({ file_handle: losingFile });
  await adapter.closeFile({ file_handle: losingFile });
  await assert.rejects(
    adapter.renameTempNoReplace({
      store_handle: session.handle,
      from_name: losingTemp,
      to_name: targetName,
    }),
    (error) => error?.code === "EEXIST",
  );
  assert.equal((await adapter.readFileNoFollow({
    store_handle: session.handle,
    name: targetName,
    max_bytes: 64,
  })).toString("utf8"), "winner");
  await adapter.unlinkTempNoFollow({ store_handle: session.handle, name: losingTemp });
  await adapter.closeStore({ store_handle: session.handle });
});

test("forward-recovers a crash between no-replace link and temporary-name unlink", async (t) => {
  const root = await fixture(t, "linked-temp-recovery");
  const targetName = target("9");
  const tempName = temp(targetName, "9");
  await fsp.writeFile(path.join(root, tempName), "linked", { mode: 0o600 });
  const native = await fsp.open(path.join(root, tempName), "r");
  await native.sync();
  await native.close();
  await fsp.link(path.join(root, tempName), path.join(root, targetName));
  assert.equal((await fsp.stat(path.join(root, targetName))).nlink, 2);

  const adapter = createDispatchPacketStorePosixPlatformAdapter();
  const session = await adapter.openStore({ root_path: root });
  await adapter.recoverInterruptedWrites({
    store_handle: session.handle,
    target_name: targetName,
    temp_prefix: `.${targetName}.`,
  });
  assert.equal((await fsp.stat(path.join(root, targetName))).nlink, 1);
  assert.equal((await adapter.readFileNoFollow({
    store_handle: session.handle,
    name: targetName,
    max_bytes: 64,
  })).toString("utf8"), "linked");
  await adapter.closeStore({ store_handle: session.handle });
});

test("keeps all relative I/O on the pinned directory after the root pathname moves", async (t) => {
  const parent = await fixture(t, "pinned-parent");
  const root = path.join(parent, "store");
  const moved = path.join(parent, "moved");
  await fsp.mkdir(root, { mode: 0o700 });
  const adapter = createDispatchPacketStorePosixPlatformAdapter();
  const session = await adapter.openStore({ root_path: root });
  await fsp.rename(root, moved);
  await fsp.mkdir(root, { mode: 0o700 });
  const targetName = target("6");
  await publish(adapter, session.handle, targetName, "pinned");
  assert.equal((await fsp.readdir(root)).length, 0);
  assert.deepEqual(await fsp.readdir(moved), [
    ".orquesta-posix-store.lock",
    targetName,
  ]);
  await adapter.closeStore({ store_handle: session.handle });
  assert.deepEqual(await fsp.readdir(moved), [targetName]);
});

test("a crashed process leaves a recoverable lock and fsynced stale temp", async (t) => {
  const root = await fixture(t, "crash");
  const crashed = childProcess(["crash-with-temp", root, "0", "7"]);
  await crashed.waitFor("temp-fsynced");
  const exit = await crashed.waitForExit();
  assert.equal(exit.code, 23, exit.stderr);
  assert.equal((await fsp.readdir(root)).includes(".orquesta-posix-store.lock"), true);

  const adapter = createDispatchPacketStorePosixPlatformAdapter();
  const session = await adapter.openStore({ root_path: root });
  const targetName = target("7");
  await adapter.recoverInterruptedWrites({
    store_handle: session.handle,
    target_name: targetName,
    temp_prefix: `.${targetName}.`,
  });
  assert.deepEqual(await fsp.readdir(root), [".orquesta-posix-store.lock"]);
  await adapter.closeStore({ store_handle: session.handle });
  assert.deepEqual(await fsp.readdir(root), []);
});

test("serializes two subprocesses through the filesystem lock", async (t) => {
  const root = await fixture(t, "cross-process");
  const first = childProcess(["hold", root, "300"]);
  await first.waitFor("acquired");
  const second = childProcess(["hold", root, "0"]);
  const early = await Promise.race([
    second.waitFor("acquired").then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 100)),
  ]);
  assert.equal(early, false, "the second process must not enter the live session");
  await first.waitFor("released");
  await second.waitFor("acquired");
  const [firstExit, secondExit] = await Promise.all([
    first.waitForExit(),
    second.waitForExit(),
  ]);
  assert.equal(firstExit.code, 0, firstExit.stderr);
  assert.equal(secondExit.code, 0, secondExit.stderr);
});

test("never unlinks a live-looking or missing-PID lock from another PID namespace", async (t) => {
  const root = await fixture(t, "pid-namespace");
  const adapter = createDispatchPacketStorePosixPlatformAdapter({
    lock_timeout_ms: 100,
    lock_poll_interval_ms: 5,
  });
  const session = await adapter.openStore({ root_path: root });
  const lockPath = path.join(root, ".orquesta-posix-store.lock");
  const ownRecord = JSON.parse(await fsp.readFile(lockPath, "utf8"));
  await adapter.closeStore({ store_handle: session.handle });

  for (const pid of [ownRecord.pid, 2_147_483_647]) {
    const foreignRecord = {
      ...ownRecord,
      pid,
      pid_namespace: "pid:[999999999]",
    };
    const bytes = `${JSON.stringify(foreignRecord)}\n`;
    const lock = await fsp.open(lockPath, "wx", 0o600);
    await lock.writeFile(bytes);
    await lock.sync();
    await lock.close();

    await assert.rejects(
      adapter.openStore({ root_path: root }),
      (error) => error?.code === "POSIX_DURABLE_STORE_PID_NAMESPACE_MISMATCH",
    );
    assert.equal(await fsp.readFile(lockPath, "utf8"), bytes);
    assert.deepEqual(await fsp.readdir(root), [".orquesta-posix-store.lock"]);
    await fsp.unlink(lockPath);
  }
});

test("surfaces injected file and directory fsync failures without weakening recovery", async (t) => {
  const root = await fixture(t, "fsync");
  const faults = new Set(["file_fsync", "directory_fsync"]);
  const adapter = createDispatchPacketStorePosixPlatformAdapter({
    async fault_injector({ operation }) {
      if (!faults.delete(operation)) return;
      throw Object.assign(new Error(`injected ${operation}`), { code: "EIO" });
    },
  });
  const session = await adapter.openStore({ root_path: root });
  const targetName = target("8");
  const tempName = temp(targetName, "8");
  const file = await adapter.openTempExclusive({
    store_handle: session.handle,
    name: tempName,
    mode: 0o600,
  });
  await adapter.writeAll({ file_handle: file, bytes: Buffer.from("durability") });
  await assert.rejects(
    adapter.fsyncFile({ file_handle: file }),
    (error) => error?.code === "EIO",
  );
  await adapter.fsyncFile({ file_handle: file });
  await adapter.closeFile({ file_handle: file });
  await adapter.renameTempNoReplace({
    store_handle: session.handle,
    from_name: tempName,
    to_name: targetName,
  });
  await assert.rejects(
    adapter.fsyncDirectory({ store_handle: session.handle }),
    (error) => error?.code === "EIO",
  );
  await adapter.closeStore({ store_handle: session.handle });

  const recovered = createDispatchPacketStorePosixPlatformAdapter();
  const reopened = await recovered.openStore({ root_path: root });
  assert.equal((await recovered.readFileNoFollow({
    store_handle: reopened.handle,
    name: targetName,
    max_bytes: 64,
  })).toString("utf8"), "durability");
  await recovered.closeStore({ store_handle: reopened.handle });
});
