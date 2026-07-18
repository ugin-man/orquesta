const test = require("node:test");
const assert = require("node:assert/strict");

const schema = require("../protocol/app-server-schema.json");
const version = require("../protocol/app-server-version.json");

test("pins the generated App Server v2 lifecycle subset", () => {
  assert.equal(schema.protocol_version, "app-server-v2");
  assert.equal(schema.source.cli_version, "0.144.5");
  assert.equal(schema.source.canonicalization, "recursive-key-sort-json-v1");
  assert.match(schema.source.canonical_sha256, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(schema.source, "sha256"), false);
  assert.deepEqual(Object.keys(schema.client_requests), [
    "initialize",
    "thread/start",
    "thread/resume",
    "thread/read",
    "turn/start",
    "turn/steer",
    "turn/interrupt"
  ]);
  assert.deepEqual(schema.client_requests["turn/start"].params_required, [
    "input",
    "threadId"
  ]);
  assert.deepEqual(schema.client_requests["thread/read"], {
    required: ["id", "method", "params"],
    params_required: ["threadId"],
    response_required: ["thread"]
  });
  assert.deepEqual(schema.client_requests["turn/steer"].params_required, [
    "expectedTurnId",
    "input",
    "threadId"
  ]);
  assert.deepEqual(schema.client_requests["turn/interrupt"].params_required, [
    "threadId",
    "turnId"
  ]);
  assert.deepEqual(schema.client_notifications.initialized.required, ["method"]);
  assert.deepEqual(schema.server_notifications["turn/started"].params_required, [
    "threadId",
    "turn"
  ]);
  assert.deepEqual(schema.server_notifications.error.params_required, [
    "error",
    "threadId",
    "turnId",
    "willRetry"
  ]);
});

test("pins exact turn-start approval methods and decision shapes", () => {
  assert.deepEqual(Object.keys(schema.server_requests), [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval"
  ]);
  assert.deepEqual(
    schema.server_requests["item/commandExecution/requestApproval"].params_required,
    ["itemId", "startedAtMs", "threadId", "turnId"]
  );
  assert.deepEqual(
    schema.server_requests["item/commandExecution/requestApproval"].response_options,
    [
      "accept",
      "acceptForSession",
      "acceptWithExecpolicyAmendment",
      "applyNetworkPolicyAmendment",
      "decline",
      "cancel"
    ]
  );
  assert.deepEqual(
    schema.server_requests["item/fileChange/requestApproval"].response_options,
    ["accept", "acceptForSession", "decline", "cancel"]
  );
});

test("pins runtime package, executable hash, and canonical generated schema hash", () => {
  assert.deepEqual(version, {
    cli_version: "0.144.5",
    sdk_package: "@openai/codex-sdk",
    sdk_version: "0.144.5",
    codex_package: "@openai/codex",
    codex_version: "0.144.5",
    runtime_package: "@openai/codex-win32-x64",
    runtime_package_version: "0.144.5-win32-x64",
    target_triple: "x86_64-pc-windows-msvc",
    executable_sha256: "efdb3540ef74b9909408c8d38da79483454797b36f471e3e004fc2bf2b70e22a",
    schema_source: "codex_app_server_protocol.v2.schemas.json",
    schema_source_canonicalization: "recursive-key-sort-json-v1",
    schema_source_canonical_sha256: "f76d741a299026cf4a1c75847b41562078d54c6f0aab9faae8781831e73d97d4",
    probe_shell: false
  });
  assert.equal(
    schema.source.canonicalization,
    version.schema_source_canonicalization
  );
  assert.equal(
    schema.source.canonical_sha256,
    version.schema_source_canonical_sha256
  );
});
