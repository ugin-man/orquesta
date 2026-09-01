"use strict";

const {
  createPosixDurableStoreCore,
} = require("./posix-durable-store");

const SHA256 = "[a-f0-9]{64}";
const PACKET_TARGET = new RegExp(`^dispatch-packet-${SHA256}\\.json$`, "u");
const RECORDED_FAKE_TARGET = new RegExp(
  `^(?:recorded-fake-${SHA256}-(?:binding|call-entered|provider-accepted|not-mutated|ack-returned)|recorded-fake-evidence-${SHA256})\\.json$`,
  "u",
);
const PRESEND_FAILURE_TARGET = new RegExp(
  `^presend-failure-(?:id|ref)-${SHA256}\\.json$`,
  "u",
);

function adapterOptions(value, unsafeErrorCode, validator) {
  if (value === undefined) value = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    const error = new TypeError("POSIX adapter options must be an object");
    error.code = "POSIX_DURABLE_STORE_CONFIGURATION_INVALID";
    throw error;
  }
  const allowed = new Set([
    "lock_timeout_ms",
    "lock_poll_interval_ms",
    "fault_injector",
  ]);
  if (Object.keys(value).some((field) => !allowed.has(field))) {
    const error = new TypeError("POSIX adapter options contain an unknown field");
    error.code = "POSIX_DURABLE_STORE_CONFIGURATION_INVALID";
    throw error;
  }
  return {
    ...value,
    unsafe_error_code: unsafeErrorCode,
    target_name_validator: validator,
  };
}

function wrapCore(core, proofFactory, recoveryProofFactory) {
  return Object.freeze({
    async openStore(input) {
      const handle = await core.openStore(input);
      return Object.freeze({
        handle,
        proof: Object.freeze(proofFactory(handle)),
      });
    },
    async recoverInterruptedWrites(input) {
      const proof = await core.recoverInterruptedWrites(input);
      return Object.freeze(recoveryProofFactory(proof));
    },
    readFileNoFollow: (input) => core.readFileNoFollow(input),
    openTempExclusive: (input) => core.openTempExclusive(input),
    writeAll: (input) => core.writeAll(input),
    fsyncFile: (input) => core.fsyncFile(input),
    closeFile: (input) => core.closeFile(input),
    renameTempNoReplace: (input) => core.renameTempNoReplace(input),
    unlinkTempNoFollow: (input) => core.unlinkTempNoFollow(input),
    fsyncDirectory: (input) => core.fsyncDirectory(input),
    closeStore: (input) => core.closeStore(input),
  });
}

function commonProof(handle) {
  return {
    proof_version: 1,
    platform: "linux",
    root_realpath: handle.root_realpath,
    privacy_enforcement:
      "same-pid-namespace-exclusive-create-fstat-uid-exact-mode-verification",
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
  };
}

function createDispatchPacketStorePosixPlatformAdapter(options) {
  const core = createPosixDurableStoreCore(adapterOptions(
    options,
    "PACKET_STORE_UNSAFE_PATH",
    (name) => PACKET_TARGET.test(name),
  ));
  return wrapCore(
    core,
    commonProof,
    (proof) => ({
      recovery_version: 1,
      root_realpath: proof.root_realpath,
      exclusive_recovery: true,
      stale_temps_handled: true,
      directory_fsynced: true,
    }),
  );
}

function createRecordedFakeProviderPosixPlatformAdapter(options) {
  const core = createPosixDurableStoreCore(adapterOptions(
    options,
    "RECORDED_FAKE_UNSAFE_PATH",
    (name) => RECORDED_FAKE_TARGET.test(name),
  ));
  return wrapCore(
    core,
    (handle) => ({
      ...commonProof(handle),
      proof_scope: "production",
      exclusive_store_sessions: true,
      process_local_exclusive_store_sessions: false,
      atomic_mutation_index: true,
    }),
    (proof) => ({ ...proof }),
  );
}

function createPresendFailureStorePosixAdapter(options) {
  const core = createPosixDurableStoreCore(adapterOptions(
    options,
    "PRESEND_FAILURE_STORE_UNSAFE_PATH",
    (name) => PRESEND_FAILURE_TARGET.test(name),
  ));
  return wrapCore(
    core,
    (handle) => ({
      ...commonProof(handle),
      proof_scope: "production",
      exclusive_store_sessions: true,
      process_local_exclusive_store_sessions: false,
      atomic_mutation_index: true,
    }),
    (proof) => ({ ...proof }),
  );
}

module.exports = Object.freeze({
  createDispatchPacketStorePosixPlatformAdapter,
  createPresendFailureStorePosixAdapter,
  createRecordedFakeProviderPosixPlatformAdapter,
});
