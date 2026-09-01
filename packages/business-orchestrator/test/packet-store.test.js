"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { canonicalHash, canonicalJson } = require("@orquesta/contracts");
const {
  DISPATCH_PACKET_STORE_LIMITS,
  createDispatchPacketStore,
  normalizeDispatchPacketV1,
  normalizeDispatchPacketVerificationReceiptV1,
} = require("../src/packet-store");
const {
  V2_EFFECT_IDENTITY_FIELDS,
  deriveEffectOperationScopeHashV2,
} = require("../src/lifecycle");

const ROOT = path.resolve("/tmp/orquesta-packet-store-test");

function codedError(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function ref(id) {
  return { id, hash: canonicalHash({ id }) };
}

function packet(overrides = {}) {
  const base = {
    schema_version: 1,
    work_order: {
      work_order_id: "wo:packet-test",
      work_order_revision: 4,
      engine_contract_version: 2,
    },
    plan: {
      plan_snapshot_ref: "plan:packet-test",
      plan_hash: "1".repeat(64),
    },
    branch: {
      branch_ref: "branch:one",
      next_attempt: 2,
      task_intent_ref: ref("intent:branch-one"),
      execution_plan_ref: ref("execution:branch-one"),
      attempt_packet_ref: null,
    },
    provider: {
      provider_ref: "provider:neutral",
      configuration_ref: ref("provider-config:neutral"),
    },
    workspace: {
      workspace_ref: "workspace:packet-test",
      checkpoint_ref: ref("checkpoint:packet-test"),
      isolation_mode: "sandbox",
    },
    context: {
      context_pack_ref: ref("context-pack:packet-test"),
      context_manifest_ref: ref("context-manifest:packet-test"),
      request_payload: {
        messages: [{ role: "user", content: "raw prompt only the packet may contain" }],
      },
      user_input_request_id: null,
      user_input_response_ref: null,
    },
    authority: {
      authority_ref: ref("authority:packet-test"),
      principal_type: "system",
      principal_id: "runtime:packet-test",
      project_ref: "project:packet-test",
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
      allowed_effect_kinds: ["provider.thread.create", "provider.turn.start"],
      deadline_at: "2026-08-10T00:00:00.000Z",
      max_runtime_ms: 120_000,
      max_output_bytes: 1_048_576,
      max_tool_calls: 32,
    },
  };
  return merge(base, overrides);
}

function merge(base, overrides) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) return overrides;
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value && typeof value === "object" && !Array.isArray(value)
        && base[key] && typeof base[key] === "object" && !Array.isArray(base[key])) {
      result[key] = merge(base[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

class FakePlatformAdapter {
  constructor({ root = ROOT, proof = {}, delays = {} } = {}) {
    this.root = root;
    this.files = new Map();
    this.temps = new Map();
    this.failures = new Map();
    this.calls = [];
    this.delays = delays;
    this.proof = {
      proof_version: 1,
      platform: "linux",
      root_realpath: root,
      privacy_enforcement: "verified-posix-acl",
      owner_only_directories: true,
      owner_only_files: true,
      private_acl_verified: true,
      symlink_components_rejected: true,
      no_follow_reads: true,
      exclusive_temp_creation: true,
      atomic_no_replace_rename: true,
      file_fsync: true,
      directory_fsync: true,
      coordinated_recovery: true,
      directory_handle_pinned: true,
      ...proof,
    };
  }

  failOnce(method, code) {
    const queue = this.failures.get(method) || [];
    queue.push(code);
    this.failures.set(method, queue);
  }

  maybeFail(method) {
    this.calls.push(method);
    const queue = this.failures.get(method);
    if (queue?.length) throw codedError(queue.shift());
  }

  async maybeDelay(method) {
    const delay = this.delays[method];
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
  }

  async openStore() {
    this.maybeFail("openStore");
    return { handle: { root: this.root }, proof: { ...this.proof } };
  }

  async recoverInterruptedWrites({ temp_prefix: tempPrefix }) {
    this.maybeFail("recoverInterruptedWrites");
    for (const [name, temporary] of this.temps) {
      if (name.startsWith(tempPrefix) && temporary.closed === true) this.temps.delete(name);
    }
    return {
      recovery_version: 1,
      root_realpath: this.root,
      exclusive_recovery: true,
      stale_temps_handled: true,
      directory_fsynced: true,
    };
  }

  async readFileNoFollow({ name, max_bytes: maxBytes }) {
    this.maybeFail("readFileNoFollow");
    const value = this.files.get(name);
    if (value === undefined) throw codedError("ENOENT");
    if (value?.type === "symlink") throw codedError("ELOOP");
    if (value.length > maxBytes) return Buffer.from(value.subarray(0, maxBytes + 1));
    return Buffer.from(value);
  }

  async openTempExclusive({ name, mode }) {
    this.maybeFail("openTempExclusive");
    assert.equal(mode, 0o600);
    if (this.temps.has(name)) throw codedError("EEXIST");
    const handle = { name, bytes: Buffer.alloc(0), closed: false };
    this.temps.set(name, handle);
    return handle;
  }

  async writeAll({ file_handle: handle, bytes }) {
    this.maybeFail("writeAll");
    assert.equal(handle.closed, false);
    handle.bytes = Buffer.from(bytes);
  }

  async fsyncFile({ file_handle: handle }) {
    this.maybeFail("fsyncFile");
    assert.equal(handle.closed, false);
    handle.fsynced = true;
  }

  async closeFile({ file_handle: handle }) {
    this.maybeFail("closeFile");
    handle.closed = true;
  }

  async renameTempNoReplace({ from_name: fromName, to_name: toName }) {
    this.maybeFail("renameTempNoReplace");
    await this.maybeDelay("renameTempNoReplace");
    if (this.files.has(toName)) throw codedError("EEXIST");
    const temporary = this.temps.get(fromName);
    if (!temporary) throw codedError("ENOENT");
    assert.equal(temporary.closed, true);
    assert.equal(temporary.fsynced, true);
    this.files.set(toName, Buffer.from(temporary.bytes));
    this.temps.delete(fromName);
  }

  async unlinkTempNoFollow({ name }) {
    this.maybeFail("unlinkTempNoFollow");
    if (!this.temps.delete(name)) throw codedError("ENOENT");
  }

  async fsyncDirectory() {
    this.maybeFail("fsyncDirectory");
  }

  async closeStore() {
    this.maybeFail("closeStore");
  }
}

function store(adapter, options = {}) {
  return createDispatchPacketStore({
    root_path: adapter.root,
    platform_adapter: adapter,
    ...options,
  });
}

function effectSeed(effect) {
  return Object.fromEntries(V2_EFFECT_IDENTITY_FIELDS
    .filter((field) => !["effect_id", "idempotency_key", "created_at"].includes(field))
    .map((field) => [field, effect[field]]));
}

function identifier(prefix, seed) {
  return `${prefix}-${canonicalHash(seed).slice(0, 32)}`;
}

function effectForPacket(packetRef, sourcePacket = packet(), overrides = {}) {
  const attemptPacketRef = sourcePacket.branch.attempt_packet_ref || packetRef;
  const effectKind = overrides.effect_kind || "provider.thread.create";
  const predecessorEffectId = overrides.predecessor_effect_id ?? null;
  const predecessorDeliveryHash = overrides.predecessor_delivery_hash ?? null;
  const runtimeIdentity = overrides.target_runtime_identity ?? null;
  const operationScopeHash = deriveEffectOperationScopeHashV2({
    effect_kind: effectKind,
    provider_ref: sourcePacket.provider.provider_ref,
    packet_ref: packetRef.id,
    packet_hash: packetRef.hash,
    predecessor_effect_id: predecessorEffectId,
    predecessor_delivery_hash: predecessorDeliveryHash,
    target_runtime_identity: runtimeIdentity,
    request_id: sourcePacket.context.user_input_request_id,
    response_ref: sourcePacket.context.user_input_response_ref,
  });
  const identity = {
    effect_contract_version: 2,
    work_order_id: sourcePacket.work_order.work_order_id,
    branch_ref: sourcePacket.branch.branch_ref,
    attempt: sourcePacket.branch.next_attempt,
    dispatch_id: identifier("DSP", {
      work_order_id: sourcePacket.work_order.work_order_id,
      branch_ref: sourcePacket.branch.branch_ref,
      attempt: sourcePacket.branch.next_attempt,
      packet_ref: attemptPacketRef,
    }),
    effect_kind: effectKind,
    origin_source_id: "source:packet-test",
    operation_scope_hash: operationScopeHash,
    operation_generation: overrides.operation_generation ?? 1,
    generation_predecessor_effect_id: overrides.generation_predecessor_effect_id ?? null,
    provider_ref: sourcePacket.provider.provider_ref,
    packet_ref: packetRef.id,
    packet_hash: packetRef.hash,
    predecessor_effect_id: predecessorEffectId,
    predecessor_delivery_hash: predecessorDeliveryHash,
    target_runtime_identity: runtimeIdentity,
  };
  const seed = effectSeed(identity);
  return {
    effect_id: identifier("FX", seed),
    ...identity,
    idempotency_key: identifier("IDEM", seed),
    created_at: "2026-08-09T23:00:00.000Z",
  };
}

async function rejectsCode(operation, code, failureClass = null) {
  await assert.rejects(operation, (error) => {
    assert.equal(error.code, code);
    assert.equal(error.disposition, "rejected");
    assert.equal(error.retry_authorization, "not_evaluated");
    if (failureClass !== null) assert.equal(error.failure_class, failureClass);
    return true;
  });
}

test("normalizes one strict provider-neutral DispatchPacketV1 with canonical limits", () => {
  const reversed = packet({
    authority: {
      allowed_provider_refs: ["provider:z", "provider:neutral"],
      allowed_effects: ["provider.turn.start", "provider.thread.create"],
    },
    effect_ceiling: {
      allowed_effect_kinds: ["provider.turn.start", "provider.thread.create"],
    },
  });
  const normalized = normalizeDispatchPacketV1(reversed);
  assert.equal(normalized.schema_version, 1);
  assert.deepEqual(normalized.authority.allowed_provider_refs, ["provider:neutral", "provider:z"]);
  assert.deepEqual(normalized.effect_ceiling.allowed_effect_kinds, [
    "provider.thread.create",
    "provider.turn.start",
  ]);
  assert.equal(Object.isFrozen(normalized.context.request_payload), true);
  assert.equal(DISPATCH_PACKET_STORE_LIMITS.max_packet_bytes, 1_048_576);

  assert.throws(
    () => normalizeDispatchPacketV1(packet({ dispatch_id: "DSP-forged" })),
    { code: "BUSINESS_DISPATCH_PACKET_INVALID" },
  );
  assert.throws(
    () => normalizeDispatchPacketV1(packet({
      context: { request_payload: { nested: { effect_id: "FX-forged" } } },
    })),
    { code: "BUSINESS_DISPATCH_PACKET_INVALID" },
  );
  assert.throws(
    () => normalizeDispatchPacketV1(packet({
      context: { request_payload: { text: "x".repeat(262_145) } },
    })),
    { code: "BUSINESS_DISPATCH_PACKET_LIMIT" },
  );
  let nested = "leaf";
  for (let index = 0; index < 25; index += 1) nested = { nested };
  assert.throws(
    () => normalizeDispatchPacketV1(packet({ context: { request_payload: nested } })),
    { code: "BUSINESS_DISPATCH_PACKET_LIMIT" },
  );
  assert.throws(
    () => normalizeDispatchPacketV1(packet(), { max_packet_bytes: 100 }),
    { code: "BUSINESS_DISPATCH_PACKET_LIMIT" },
  );
});

test("creates immutable canonical content, reads it, and returns only its content reference", async () => {
  const adapter = new FakePlatformAdapter();
  const packetStore = store(adapter);
  const input = packet();
  const expectedHash = canonicalHash(normalizeDispatchPacketV1(input));
  const packetRef = await packetStore.create(input);

  assert.deepEqual(packetRef, {
    id: `dispatch-packet:${expectedHash}`,
    hash: expectedHash,
  });
  assert.equal(Object.isFrozen(packetRef), true);
  input.context.request_payload.messages[0].content = "mutated after create";
  const stored = await packetStore.read(packetRef);
  assert.equal(stored.context.request_payload.messages[0].content, "raw prompt only the packet may contain");
  assert.equal(Object.isFrozen(stored), true);
  assert.deepEqual(adapter.calls.slice(0, 9), [
    "openStore",
    "recoverInterruptedWrites",
    "readFileNoFollow",
    "openTempExclusive",
    "writeAll",
    "fsyncFile",
    "closeFile",
    "renameTempNoReplace",
    "fsyncDirectory",
  ]);
});

test("verification receipt binds the exact Effect V2 identity without exposing raw request content", async () => {
  const adapter = new FakePlatformAdapter();
  const packetStore = store(adapter);
  const sourcePacket = packet();
  const packetRef = await packetStore.create(sourcePacket);
  const effect = effectForPacket(packetRef, sourcePacket);
  const receipt = await packetStore.verifyForEffect(effect);

  assert.equal(receipt.schema_version, 1);
  assert.equal(receipt.disposition, "verified");
  assert.equal(receipt.failure_class, null);
  assert.equal(receipt.failure_taxonomy_version, 1);
  assert.equal(receipt.delivery_disposition, "not_evaluated");
  assert.equal(receipt.verification_scope, "packet_integrity_and_effect_binding_only");
  assert.equal(receipt.retry_authorization, "not_evaluated");
  assert.deepEqual(receipt.effect_identity, effect);
  assert.deepEqual(
    Object.keys(receipt.effect_identity).sort(),
    [...V2_EFFECT_IDENTITY_FIELDS].sort(),
  );
  const body = { ...receipt };
  delete body.receipt_ref;
  delete body.receipt_hash;
  assert.equal(receipt.receipt_hash, canonicalHash(body));
  assert.equal(receipt.receipt_ref, `dispatch-packet-verification:${receipt.receipt_hash}`);
  assert.equal(receipt.effect_identity_hash, canonicalHash(effect));
  assert.equal(receipt.effect_identifier_seed_hash, canonicalHash(effectSeed(effect)));
  const serialized = canonicalJson(receipt);
  assert.equal(serialized.includes("raw prompt only the packet may contain"), false);
  assert.equal(serialized.includes("request_payload"), false);
  assert.equal(Object.isFrozen(receipt), true);
  assert.deepEqual(normalizeDispatchPacketVerificationReceiptV1(receipt), receipt);

  const forged = structuredClone(receipt);
  forged.packet_binding.provider_ref = "provider:forged";
  const forgedBody = { ...forged };
  delete forgedBody.receipt_ref;
  delete forgedBody.receipt_hash;
  forged.receipt_hash = canonicalHash(forgedBody);
  forged.receipt_ref = `dispatch-packet-verification:${forged.receipt_hash}`;
  assert.throws(
    () => normalizeDispatchPacketVerificationReceiptV1(forged),
    { code: "BUSINESS_DISPATCH_PACKET_EFFECT_BINDING" },
  );
});

test("verifies follow-on user input against the original attempt dispatch basis", async () => {
  const adapter = new FakePlatformAdapter();
  const packetStore = store(adapter);
  const attemptPacket = packet();
  const attemptRef = await packetStore.create(attemptPacket);
  const responseRef = ref("response:user-input");
  const inputPacket = packet({
    branch: { attempt_packet_ref: attemptRef },
    context: {
      request_payload: { response: "raw response only the packet may contain" },
      user_input_request_id: "request:user-input",
      user_input_response_ref: responseRef,
    },
    effect_ceiling: { allowed_effect_kinds: ["provider.user_input.submit"] },
  });
  const inputRef = await packetStore.create(inputPacket);
  const effect = effectForPacket(inputRef, inputPacket, {
    effect_kind: "provider.user_input.submit",
    predecessor_effect_id: "FX-predecessor",
    predecessor_delivery_hash: "a".repeat(64),
    target_runtime_identity: {
      operation_id: "operation:one",
      thread_id: "thread:one",
      turn_id: "turn:one",
    },
    operation_generation: 2,
    generation_predecessor_effect_id: "FX-not-sent-predecessor",
  });
  const receipt = await packetStore.verifyForEffect(effect);
  assert.deepEqual(receipt.packet_binding.dispatch_packet_ref, attemptRef);
  assert.equal(canonicalJson(receipt).includes("raw response only the packet may contain"), false);
});

test("fails closed without platform ACL, no-follow, atomic rename, and directory fsync proof", async (t) => {
  const cases = [
    ["win32", { platform: "win32" }],
    ["chmod-only", { privacy_enforcement: "chmod-0600" }],
    ["private-acl", { private_acl_verified: false }],
    ["no-follow", { no_follow_reads: false }],
    ["atomic-rename", { atomic_no_replace_rename: false }],
    ["directory-fsync", { directory_fsync: false }],
    ["pinned-directory", { directory_handle_pinned: false }],
  ];
  for (const [name, proof] of cases) {
    await t.test(name, async () => {
      const adapter = new FakePlatformAdapter({ proof });
      await rejectsCode(
        () => store(adapter).create(packet()),
        proof.platform === "win32"
          ? "BUSINESS_PACKET_STORE_UNTRUSTED_PLATFORM"
          : "BUSINESS_PACKET_STORE_SECURITY_UNVERIFIED",
        "storage_unavailable",
      );
      assert.equal(adapter.files.size, 0);
    });
  }
});

test("rejects traversal-shaped references and link targets before returning bytes", async () => {
  const adapter = new FakePlatformAdapter();
  const packetStore = store(adapter);
  await rejectsCode(
    () => packetStore.read({ id: "dispatch-packet:../../escape", hash: "b".repeat(64) }),
    "BUSINESS_DISPATCH_PACKET_REFERENCE_INVALID",
    "packet_invalid",
  );

  const packetRef = {
    id: `dispatch-packet:${"c".repeat(64)}`,
    hash: "c".repeat(64),
  };
  adapter.files.set(`dispatch-packet-${packetRef.hash}.json`, { type: "symlink" });
  await rejectsCode(
    () => packetStore.read(packetRef),
    "BUSINESS_PACKET_STORE_PATH_UNSAFE",
    "storage_unavailable",
  );
});

test("recovers cleanly from temp creation, write, file fsync, and rename failures", async (t) => {
  const cases = [
    ["openTempExclusive", "EIO"],
    ["writeAll", "ENOSPC"],
    ["fsyncFile", "EIO"],
    ["renameTempNoReplace", "EIO"],
  ];
  for (const [method, code] of cases) {
    await t.test(method, async () => {
      const adapter = new FakePlatformAdapter();
      const packetStore = store(adapter);
      adapter.failOnce(method, code);
      await rejectsCode(
        () => packetStore.create(packet()),
        "BUSINESS_PACKET_STORE_WRITE_FAILED",
        "storage_unavailable",
      );
      assert.equal(adapter.files.size, 0);
      assert.equal(adapter.temps.size, 0);
      const packetRef = await packetStore.create(packet());
      assert.deepEqual(await packetStore.read(packetRef), normalizeDispatchPacketV1(packet()));
    });
  }
});

test("forward-recovers a target after directory fsync reports uncertain durability", async () => {
  const adapter = new FakePlatformAdapter();
  const packetStore = store(adapter);
  adapter.failOnce("fsyncDirectory", "EIO");
  await rejectsCode(
    () => packetStore.create(packet()),
    "BUSINESS_PACKET_STORE_DURABILITY_UNCERTAIN",
    "durability_uncertain",
  );
  assert.equal(adapter.files.size, 1, "rename succeeded before directory fsync failed");
  const packetRef = await packetStore.create(packet());
  assert.deepEqual(await packetStore.read(packetRef), normalizeDispatchPacketV1(packet()));
  assert.ok(adapter.calls.filter((name) => name === "recoverInterruptedWrites").length >= 2);
});

test("coordinated recovery removes a closed stale temp before a new write", async () => {
  const adapter = new FakePlatformAdapter();
  const normalized = normalizeDispatchPacketV1(packet());
  const hash = canonicalHash(normalized);
  const targetName = `dispatch-packet-${hash}.json`;
  adapter.temps.set(`.${targetName}.stale.tmp`, {
    name: `.${targetName}.stale.tmp`,
    bytes: Buffer.from("partial"),
    closed: true,
  });
  const packetRef = await store(adapter).create(packet());
  assert.equal(adapter.temps.size, 0);
  assert.equal(packetRef.hash, hash);
});

test("concurrent identical writers converge while conflicting existing bytes are never overwritten", async () => {
  const adapter = new FakePlatformAdapter({ delays: { renameTempNoReplace: 5 } });
  const packetStore = store(adapter);
  const [left, right] = await Promise.all([
    packetStore.create(packet()),
    packetStore.create(packet()),
  ]);
  assert.deepEqual(left, right);
  assert.equal(adapter.files.size, 1);
  assert.equal(adapter.temps.size, 0);

  const targetName = `dispatch-packet-${left.hash}.json`;
  adapter.files.set(targetName, Buffer.from("{\"tampered\":true}\n", "utf8"));
  await rejectsCode(
    () => packetStore.create(packet()),
    "BUSINESS_DISPATCH_PACKET_CONFLICT",
    "packet_tampered",
  );
  assert.equal(adapter.files.get(targetName).toString("utf8"), "{\"tampered\":true}\n");
  await rejectsCode(
    () => packetStore.read(left),
    "BUSINESS_DISPATCH_PACKET_TAMPERED",
    "packet_tampered",
  );
});

test("verifyForEffect rejects independently forged dispatch, scope, effect, idempotency, and generation", async (t) => {
  const adapter = new FakePlatformAdapter();
  const packetStore = store(adapter);
  const sourcePacket = packet();
  const packetRef = await packetStore.create(sourcePacket);
  const valid = effectForPacket(packetRef, sourcePacket);
  const cases = [
    ["dispatch", { dispatch_id: "DSP-forged" }],
    ["scope", { operation_scope_hash: "b".repeat(64) }],
    ["effect", { effect_id: "FX-forged" }],
    ["idempotency", { idempotency_key: "IDEM-forged" }],
    ["generation", {
      operation_generation: 2,
      generation_predecessor_effect_id: null,
    }],
  ];
  for (const [name, override] of cases) {
    await t.test(name, async () => {
      await rejectsCode(
        () => packetStore.verifyForEffect({ ...valid, ...override }),
        "BUSINESS_DISPATCH_PACKET_EFFECT_BINDING",
        "policy_mismatch",
      );
    });
  }
});

test("verifyForEffect keeps capability and policy failures separate from provider not_sent", async () => {
  const adapter = new FakePlatformAdapter();
  const packetStore = store(adapter);
  const sourcePacket = packet();
  const packetRef = await packetStore.create(sourcePacket);
  const valid = effectForPacket(packetRef, sourcePacket);

  const expiredPacket = packet({ effect_ceiling: { deadline_at: "2026-08-09T22:00:00.000Z" } });
  const expiredRef = await packetStore.create(expiredPacket);
  const expiredEffect = effectForPacket(expiredRef, expiredPacket);
  await rejectsCode(
    () => packetStore.verifyForEffect(expiredEffect),
    "BUSINESS_DISPATCH_PACKET_POLICY_MISMATCH",
    "policy_mismatch",
  );

  const threadOnlyPacket = packet({
    effect_ceiling: { allowed_effect_kinds: ["provider.thread.create"] },
  });
  const threadOnlyRef = await packetStore.create(threadOnlyPacket);
  const unsupportedTurn = effectForPacket(threadOnlyRef, threadOnlyPacket, {
    effect_kind: "provider.turn.start",
    predecessor_effect_id: "FX-thread-create",
    predecessor_delivery_hash: "d".repeat(64),
    target_runtime_identity: {
      operation_id: "operation:capability",
      thread_id: "thread:capability",
      turn_id: null,
    },
  });
  await rejectsCode(
    () => packetStore.verifyForEffect(unsupportedTurn),
    "BUSINESS_DISPATCH_PACKET_CAPABILITY_MISMATCH",
    "capability_mismatch",
  );
});

test("missing and tampered packet failures never include raw prompt or response data", async () => {
  const adapter = new FakePlatformAdapter();
  const packetStore = store(adapter);
  const sourcePacket = packet();
  const packetRef = await packetStore.create(sourcePacket);
  const valid = effectForPacket(packetRef, sourcePacket);
  adapter.files.clear();
  await assert.rejects(() => packetStore.verifyForEffect(valid), (error) => {
    assert.equal(error.code, "BUSINESS_DISPATCH_PACKET_NOT_FOUND");
    assert.equal(error.failure_class, "packet_missing");
    assert.equal(canonicalJson(error.details).includes("raw prompt"), false);
    return true;
  });

  const recreatedRef = await packetStore.create(sourcePacket);
  const targetName = `dispatch-packet-${recreatedRef.hash}.json`;
  adapter.files.set(targetName, Buffer.from("{\"tampered\":true}\n", "utf8"));
  await rejectsCode(
    () => packetStore.verifyForEffect({
      ...valid,
      operation_generation: 2,
      generation_predecessor_effect_id: null,
    }),
    "BUSINESS_DISPATCH_PACKET_TAMPERED",
    "packet_tampered",
  );

  const sensitiveKey = "raw-response-as-an-object-key";
  assert.throws(
    () => normalizeDispatchPacketV1(packet({
      context: { request_payload: { [sensitiveKey]: "x".repeat(262_145) } },
    })),
    (error) => {
      assert.equal(error.code, "BUSINESS_DISPATCH_PACKET_LIMIT");
      assert.equal(canonicalJson(error.details).includes(sensitiveKey), false);
      assert.equal(error.message.includes(sensitiveKey), false);
      return true;
    },
  );
});
