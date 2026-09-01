"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const recorded = require("../protocol/recorded-contract.v1.json");
const schema = require("../protocol/app-server-schema.json");
const version = require("../protocol/app-server-version.json");
const {
  CODEX_APP_SERVER_PROVIDER_PROFILE,
  CODEX_APP_SERVER_RECORDED_CONTRACT,
  PROVIDER_CAPABILITY_KEYS,
  PROVIDER_CAPABILITY_STATES,
  PROVIDER_HISTORY_POLICY,
  PINNED_RECORDED_CONTRACT_SHA256,
  defineProviderCapabilityProfile,
  normalizeAppServerFrame,
  replayRecordedContract,
  validateRecordedContract
} = require("../src/provider-contract");

test("pins a tri-state provider profile to the recorded Codex runtime", () => {
  assert.equal(CODEX_APP_SERVER_PROVIDER_PROFILE.contract_version, 1);
  assert.equal(CODEX_APP_SERVER_PROVIDER_PROFILE.provider, "codex_app_server");
  assert.equal(CODEX_APP_SERVER_PROVIDER_PROFILE.runtime_version, "0.144.5");
  assert.equal(version.cli_version, "0.144.5");
  assert.equal(recorded.capture.schema_source_canonical_sha256, schema.source.canonical_sha256);
  assert.deepEqual(
    Object.keys(CODEX_APP_SERVER_PROVIDER_PROFILE.capabilities).sort(),
    [...PROVIDER_CAPABILITY_KEYS].sort()
  );
  for (const capability of Object.values(CODEX_APP_SERVER_PROVIDER_PROFILE.capabilities)) {
    assert.ok(PROVIDER_CAPABILITY_STATES.includes(capability.state));
    assert.match(capability.evidence_ref, /\S/u);
    assert.match(capability.note, /\S/u);
  }
  assert.equal(CODEX_APP_SERVER_PROVIDER_PROFILE.capabilities.thread_read.state, "supported");
  assert.equal(CODEX_APP_SERVER_PROVIDER_PROFILE.capabilities.approval_reconnect_recovery.state, "unsupported");
  assert.equal(CODEX_APP_SERVER_PROVIDER_PROFILE.capabilities.request_user_input.state, "unsupported");
  assert.equal(CODEX_APP_SERVER_PROVIDER_PROFILE.capabilities.actual_model_read.state, "unsupported");
  assert.equal(CODEX_APP_SERVER_PROVIDER_PROFILE.capabilities.request_user_input.provider_state, "unknown");
  assert.equal(CODEX_APP_SERVER_PROVIDER_PROFILE.capabilities.request_user_input.adapter_state, "unsupported");
  assert.equal(PROVIDER_HISTORY_POLICY.raw_codex_file_access, "migration_only");
  assert.equal(Object.isFrozen(CODEX_APP_SERVER_PROVIDER_PROFILE), true);
  assert.equal(Object.isFrozen(CODEX_APP_SERVER_PROVIDER_PROFILE.capabilities), true);
});

test("requires every provider capability and rejects boolean or invented states", () => {
  const valid = CODEX_APP_SERVER_PROVIDER_PROFILE.capabilities;
  const missing = { ...valid };
  delete missing.thread_read;
  assert.throws(
    () => defineProviderCapabilityProfile({ provider: "fixture", runtimeVersion: "1", capabilities: missing }),
    /contain exactly/u
  );
  assert.throws(
    () => defineProviderCapabilityProfile({
      provider: "fixture",
      runtimeVersion: "1",
      capabilities: { ...valid, thread_read: true }
    }),
    /must be an object/u
  );
  assert.throws(
    () => defineProviderCapabilityProfile({
      provider: "fixture",
      runtimeVersion: "1",
      capabilities: {
        ...valid,
        thread_read: { ...valid.thread_read, state: "probably" }
      }
    }),
    /unknown provider capability state/u
  );
  assert.throws(
    () => defineProviderCapabilityProfile({
      provider: "fixture",
      runtimeVersion: "1",
      capabilities: {
        ...valid,
        thread_read: {
          ...valid.thread_read,
          state: "supported",
          provider_state: "unsupported",
          adapter_state: "unsupported"
        }
      }
    }),
    /aggregate capability state/u
  );
});

test("normalizes every recorded frame deterministically", () => {
  let sequence = 0;
  for (const fixture of recorded.cases) {
    sequence += 1;
    const first = normalizeAppServerFrame({
      ...fixture.input,
      sequence
    });
    const second = normalizeAppServerFrame({
      ...fixture.input,
      sequence
    });
    assert.deepEqual(first, second, fixture.case_id);
    assert.equal(first.event_type, fixture.expected_event_type, fixture.case_id);
    assert.match(first.source.frame_sha256, /^[a-f0-9]{64}$/u, fixture.case_id);
    assert.equal(first.provider, "codex_app_server", fixture.case_id);
    assert.equal(first.provider_stream_id, "fixture-stream-1", fixture.case_id);
    assert.equal(first.provider_sequence, sequence, fixture.case_id);
    assert.equal(first.sequence_scope, "provider_connection", fixture.case_id);
    assert.equal(Object.isFrozen(first), true, fixture.case_id);
    assert.equal(Object.isFrozen(first.source), true, fixture.case_id);
    assert.equal(Object.isFrozen(first.scope), true, fixture.case_id);
  }
});

test("normalizes only bounded public agent answer deltas", () => {
  const event = normalizeAppServerFrame({
    streamId: "delta-stream",
    direction: "provider_to_client",
    sequence: 1,
    frame: {
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-a",
        turnId: "turn-a",
        itemId: "item-answer-a",
        delta: "返答の一部"
      }
    }
  });
  assert.equal(event.event_type, "message.agent.delta");
  assert.deepEqual(event.scope, {
    thread_id: "thread-a",
    turn_id: "turn-a",
    item_id: "item-answer-a"
  });
  assert.deepEqual(event.payload, { item_id: "item-answer-a", delta: "返答の一部" });
  assert.doesNotMatch(JSON.stringify(event.payload), /frame_sha256|reasoning/u);
  assert.throws(() => normalizeAppServerFrame({
    streamId: "delta-stream",
    direction: "provider_to_client",
    sequence: 2,
    frame: {
      method: "item/agentMessage/delta",
      params: { threadId: "thread-a", turnId: "turn-a", itemId: "item-a", delta: "x".repeat(64 * 1024 + 1) }
    }
  }), /agent message delta/u);
});

test("validates and replays the recorded contract as one pinned evidence set", () => {
  assert.equal(CODEX_APP_SERVER_RECORDED_CONTRACT.contract_id, recorded.contract_id);
  assert.match(CODEX_APP_SERVER_RECORDED_CONTRACT.contract_sha256, /^[a-f0-9]{64}$/u);
  assert.equal(CODEX_APP_SERVER_RECORDED_CONTRACT.capture.live_runtime_capture, "bounded_normalized_evidence");
  assert.equal(CODEX_APP_SERVER_RECORDED_CONTRACT.capture.raw_frame_capture, false);
  assert.equal(CODEX_APP_SERVER_RECORDED_CONTRACT.contract_sha256, PINNED_RECORDED_CONTRACT_SHA256);
  assert.equal(
    validateRecordedContract(CODEX_APP_SERVER_RECORDED_CONTRACT).contract_sha256,
    CODEX_APP_SERVER_RECORDED_CONTRACT.contract_sha256
  );
  assert.deepEqual(
    replayRecordedContract().map((event) => event.event_type),
    recorded.cases.map((fixture) => fixture.expected_event_type)
  );
  const duplicate = structuredClone(recorded);
  duplicate.cases.push(structuredClone(duplicate.cases[0]));
  assert.throws(() => validateRecordedContract(duplicate), /duplicate recorded contract case ID/u);
  const wrongRuntime = structuredClone(recorded);
  wrongRuntime.capture.cli_version = "future";
  assert.throws(() => validateRecordedContract(wrongRuntime), /does not match the pinned provider contract/u);

  const changedWithOldHash = structuredClone(recorded);
  changedWithOldHash.capture.note += " changed";
  assert.throws(() => validateRecordedContract(changedWithOldHash), /SHA-256 does not match/u);

  const changedWithNewHash = structuredClone(changedWithOldHash);
  delete changedWithNewHash.contract_sha256;
  changedWithNewHash.contract_sha256 = createHash("sha256")
    .update(require("../src/provider-contract").canonicalJson(changedWithNewHash), "utf8")
    .digest("hex");
  assert.throws(() => validateRecordedContract(changedWithNewHash), /pinned contract identity/u);
});

test("binds the schema fixtures to an existing successful live App Server proof", () => {
  const proofPath = path.resolve(__dirname, "../../..", recorded.capture.live_evidence_ref);
  const bytes = fs.readFileSync(proofPath);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), recorded.capture.live_evidence_sha256);
  const proof = JSON.parse(bytes.toString("utf8"));
  assert.equal(proof.source.raw_frame_capture, false);
  assert.equal(proof.source.provider_runtime_version_observed, false);
  assert.equal(proof.observation.status, "passed");
  assert.equal(proof.observation.distinct_thread_count, 2);
  assert.equal(proof.observation.distinct_turn_count, 2);
  assert.deepEqual(
    proof.observation.contract_categories_observed,
    recorded.capture.live_observed_categories
  );
  assert.equal(proof.observation.event_counts.turn_started, 2);
  assert.equal(proof.observation.event_counts.turn_completed, 2);
  assert.equal(proof.limits.streamed_item_frames_observed, false);
  assert.ok(recorded.capture.schema_fixture_categories.includes("streamed_items"));
});

test("recorded contract covers every P0-A lifecycle category", () => {
  const categories = new Set(recorded.cases.map((entry) => entry.category));
  assert.deepEqual(
    [...categories].sort(),
    [
      "approval",
      "failure",
      "initialize",
      "request_user_input",
      "streamed_items",
      "thread_pagination",
      "thread_read",
      "turn_lifecycle"
    ]
  );
  assert.deepEqual(recorded.explicit_unknowns, [
    {
      capability: "approval_reconnect_recovery",
      state: "unknown",
      reason: "No list or replay method for unresolved approval requests exists in the pinned schema subset."
    },
    {
      capability: "request_user_input",
      state: "unknown",
      reason: "No verified request-user-input method exists in the pinned schema subset; the fixture only proves unknown requests remain visible."
    }
  ]);
});

test("keeps unknown requests visible without promoting them to a supported capability", () => {
  const fixture = recorded.cases.find((entry) => entry.category === "request_user_input");
  assert.equal(fixture.verified_runtime_method, false);
  const event = normalizeAppServerFrame({ ...fixture.input, sequence: 1 });
  assert.equal(event.event_type, "provider.unknown_request");
  assert.equal(event.source.method, "future/requestUserInput");
  assert.deepEqual(event.payload.frame_keys, ["id", "method", "params"]);
  assert.deepEqual(event.payload.body_keys, ["prompt", "threadId", "turnId"]);
  assert.match(event.payload.body_sha256, /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(event.payload), /fixture-only forward-compatible request/u);
  assert.equal(CODEX_APP_SERVER_PROVIDER_PROFILE.capabilities.request_user_input.state, "unsupported");
});

test("redacts approval reason and command payloads at the provider-neutral boundary", () => {
  const event = normalizeAppServerFrame({
    streamId: "secret-test",
    direction: "provider_to_client",
    sequence: 1,
    frame: {
      id: "approval-secret",
      method: "item/commandExecution/requestApproval",
      params: {
        itemId: "item-secret",
        startedAtMs: 1,
        threadId: "thread-secret",
        turnId: "turn-secret",
        reason: "contains secret-token",
        command: "tool --token raw-secret"
      }
    }
  });
  assert.deepEqual(event.payload, {
    item_id: "item-secret",
    reason_present: true,
    response_options: schema.server_requests["item/commandExecution/requestApproval"].response_options
  });
  assert.doesNotMatch(JSON.stringify(event.payload), /secret-token|raw-secret/u);
});

test("preserves scope and approval response direction without exposing provider request IDs", () => {
  const numeric = normalizeAppServerFrame({
    streamId: "id-test",
    direction: "provider_to_client",
    sequence: 1,
    frame: {
      id: 7,
      method: "item/fileChange/requestApproval",
      params: {
        itemId: "item-7",
        startedAtMs: 1,
        threadId: "thread-7",
        turnId: "turn-7"
      }
    }
  });
  assert.equal(numeric.source.has_request_id, true);
  assert.equal(Object.hasOwn(numeric.source, "request_ref"), false);
  assert.deepEqual(numeric.scope, {
    thread_id: "thread-7",
    turn_id: "turn-7",
    item_id: "item-7"
  });

  const response = normalizeAppServerFrame({
    streamId: "id-test",
    direction: "client_to_provider",
    sequence: 2,
    request: {
      id: 7,
      method: "item/fileChange/requestApproval",
      params: {
        itemId: "item-7",
        startedAtMs: 1,
        threadId: "thread-7",
        turnId: "turn-7"
      }
    },
    frame: { id: 7, result: { decision: "decline" } }
  });
  assert.equal(response.event_type, "attention.response_submitted");
  assert.equal(response.payload.decision_option, "decline");
  assert.equal(Object.hasOwn(response.source, "request_ref"), false);
});

test("fails closed on invalid frame metadata", () => {
  assert.throws(
    () => normalizeAppServerFrame({ streamId: "invalid", direction: "sideways", frame: {}, sequence: 1 }),
    /direction/u
  );
  assert.throws(
    () => normalizeAppServerFrame({ streamId: "invalid", direction: "provider_to_client", frame: [], sequence: 1 }),
    /must be an object/u
  );
  assert.throws(
    () => normalizeAppServerFrame({ streamId: "invalid", direction: "provider_to_client", frame: {}, sequence: 0 }),
    /positive safe integer/u
  );
  assert.throws(
    () => normalizeAppServerFrame({
      streamId: "invalid",
      direction: "provider_to_client",
      frame: { method: "item/started", params: {} },
      sequence: 1
    }),
    /missing item/u
  );
  assert.throws(
    () => normalizeAppServerFrame({
      streamId: "invalid",
      direction: "provider_to_client",
      frame: { id: -0, method: "future/request", params: {} },
      sequence: 1
    }),
    /safe integer/u
  );
  assert.throws(
    () => normalizeAppServerFrame({
      streamId: "x".repeat(1025),
      direction: "provider_to_client",
      frame: { method: "error", params: { error: {}, threadId: "t", turnId: "u", willRetry: false } },
      sequence: 1
    }),
    /stream ID must contain/u
  );
});

test("binds provider responses to the exact originating request", () => {
  const frame = { id: "list-1", result: { data: [] } };
  assert.throws(
    () => normalizeAppServerFrame({
      streamId: "causality",
      direction: "provider_to_client",
      frame,
      sequence: 1
    }),
    /requires its exact request context/u
  );
  assert.throws(
    () => normalizeAppServerFrame({
      streamId: "causality",
      direction: "provider_to_client",
      request: { id: "different", method: "thread/list", params: {} },
      frame,
      sequence: 1
    }),
    /does not match/u
  );
});

test("omits secrets from known history, item, failure, and request-ID projections", () => {
  const secret = "SECRET-provider-boundary";
  const events = [
    normalizeAppServerFrame({
      streamId: "secret-known",
      direction: "provider_to_client",
      sequence: 1,
      request: { id: `${secret}-read-id`, method: "thread/read", params: { threadId: "thread-secret" } },
      frame: {
        id: `${secret}-read-id`,
        result: {
          thread: {
            id: "thread-secret",
            cwd: `C:/${secret}`,
            status: "idle",
            turns: [{ id: "turn-secret", items: [{ type: "agentMessage", text: secret }] }]
          }
        }
      }
    }),
    normalizeAppServerFrame({
      streamId: "secret-known",
      direction: "provider_to_client",
      sequence: 2,
      frame: {
        method: "item/completed",
        params: {
          completedAtMs: 1,
          threadId: "thread-secret",
          turnId: "turn-secret",
          item: { id: "item-secret", type: "agentMessage", text: secret }
        }
      }
    }),
    normalizeAppServerFrame({
      streamId: "secret-known",
      direction: "provider_to_client",
      sequence: 3,
      request: { id: "failure-1", method: "turn/start", params: { threadId: "thread-secret", input: [] } },
      frame: { id: "failure-1", error: { code: -32000, message: secret } }
    })
  ];

  for (const event of events) {
    assert.doesNotMatch(JSON.stringify(event), new RegExp(secret, "u"));
  }
  assert.equal(events[0].payload.cwd_omitted, true);
  assert.equal(events[0].payload.content_omitted, true);
  assert.equal(events[1].payload.content_omitted, true);
  assert.equal(events[2].payload.message_present, true);
});

test("omits attachment capabilities, private paths, digests, handles, and content from dynamic tool projections", () => {
  const secret = "SECRET-attachment-boundary";
  const request = {
    id: "tool-secret",
    method: "item/tool/call",
    params: {
      threadId: "thread-secret",
      turnId: "turn-secret",
      tool: "orquesta_attachment_read",
      callId: "call-secret",
      arguments: {
        capability: "a".repeat(64),
        cursor: null,
        sealedAbsolutePath: `C:\\sealed\\${secret}`,
        sha256: secret,
        attachmentStoreHandle: secret
      }
    }
  };
  const requested = normalizeAppServerFrame({
    streamId: "dynamic-secret",
    direction: "provider_to_client",
    sequence: 1,
    frame: request
  });
  const submitted = normalizeAppServerFrame({
    streamId: "dynamic-secret",
    direction: "client_to_provider",
    sequence: 2,
    request,
    frame: {
      id: "tool-secret",
      result: { success: true, contentItems: [{ type: "inputText", text: secret }] }
    }
  });
  assert.deepEqual(requested.payload, {
    tool_name: "orquesta_attachment_read",
    arguments_omitted: true,
    content_omitted: true
  });
  assert.deepEqual(submitted.payload, {
    success: true,
    arguments_omitted: true,
    content_omitted: true
  });
  const serialized = JSON.stringify([requested, submitted]);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes("sealedAbsolutePath"), false);
  assert.equal(serialized.includes("attachmentStoreHandle"), false);
  assert.equal(serialized.includes("a".repeat(64)), false);
});

test("normalizes bounded structured activities without raw command, tool, diff, or file content", () => {
  const secret = "SECRET-activity-payload";
  const notification = (sequence, method, params) => normalizeAppServerFrame({
    streamId: "activity-stream",
    direction: "provider_to_client",
    sequence,
    frame: { method, params }
  });
  const command = notification(1, "item/started", {
    startedAtMs: 1,
    threadId: "thread-1",
    turnId: "turn-1",
    item: {
      id: "command-1",
      type: "commandExecution",
      command: `C:\\Users\\kouki\\bin\\powershell.exe --token ${secret}`,
      commandActions: [{ type: "unknown", command: secret }],
      cwd: "C:\\Users\\kouki\\private",
      status: "inProgress",
      aggregatedOutput: secret
    }
  });
  const fileChange = notification(2, "item/completed", {
    completedAtMs: 2,
    threadId: "thread-1",
    turnId: "turn-1",
    item: {
      id: "file-1",
      type: "fileChange",
      status: "completed",
      changes: [{
        path: "C:\\Users\\kouki\\project\\src\\secret.ts",
        kind: "update",
        diff: `--- a\n+++ b\n-${secret}\n+replacement`
      }]
    }
  });
  const tool = notification(3, "item/completed", {
    completedAtMs: 3,
    threadId: "thread-1",
    turnId: "turn-1",
    item: {
      id: "tool-1",
      type: "mcpToolCall",
      server: "github",
      tool: "read_issue",
      status: "completed",
      arguments: { token: secret },
      result: { content: secret },
      durationMs: 25
    }
  });
  const diff = notification(4, "turn/diff/updated", {
    threadId: "thread-1",
    turnId: "turn-1",
    diff: `--- a\n+++ b\n-${secret}\n+replacement`
  });

  assert.equal(command.event_type, "command.started");
  assert.equal(command.payload.activity_kind, "command");
  assert.equal(command.payload.activity_state, "running");
  assert.equal(command.payload.command_name, "powershell.exe");
  assert.equal(command.payload.output_present, true);
  assert.equal(command.payload.output_text, "[REDACTED]");
  assert.equal(command.payload.output_truncated, false);
  assert.equal(command.payload.output_redacted, true);
  assert.equal(command.payload.command_arguments_omitted, true);
  assert.equal(fileChange.event_type, "file.change.completed");
  assert.deepEqual(fileChange.payload.changes, [{
    path: "%USERPROFILE%/project/src/secret.ts",
    kind: "update",
    original_bytes: Buffer.byteLength(`--- a\n+++ b\n-${secret}\n+replacement`, "utf8"),
    added_lines: 1,
    removed_lines: 1
  }]);
  assert.equal(tool.event_type, "tool.completed");
  assert.equal(tool.payload.tool_name, "read_issue");
  assert.equal(tool.payload.arguments_omitted, true);
  assert.equal(tool.payload.result_omitted, true);
  assert.equal(diff.event_type, "diff.updated");
  assert.equal(diff.payload.added_lines, 1);
  assert.equal(diff.payload.removed_lines, 1);
  for (const event of [command, fileChange, tool, diff]) {
    const encoded = JSON.stringify(event.payload);
    assert.doesNotMatch(encoded, new RegExp(secret, "u"));
    assert.doesNotMatch(encoded, /C:\\\\Users\\\\kouki/u);
  }
});

test("bounds and redacts command output before it crosses the provider boundary", () => {
  const secret = "sk-super-secret-1234567890";
  const output = `C:\\Users\\kouki\\private\\log.txt token=${secret}\n${"x".repeat(20_000)}`;
  const event = normalizeAppServerFrame({
    streamId: "activity-output-stream",
    direction: "provider_to_client",
    sequence: 1,
    frame: { method: "item/completed", params: {
      completedAtMs: 1,
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "command-1", type: "commandExecution", command: "powershell.exe", commandActions: [], cwd: "C:\\Users\\kouki\\project", status: "completed", aggregatedOutput: output }
    } }
  });
  assert.equal(event.payload.output_present, true);
  assert.equal(event.payload.output_bytes, Buffer.byteLength(output, "utf8"));
  assert.equal(event.payload.output_truncated, true);
  assert.equal(event.payload.output_redacted, true);
  assert.ok(Buffer.byteLength(event.payload.output_text, "utf8") <= 16 * 1024);
  assert.doesNotMatch(event.payload.output_text, /C:\\Users\\kouki/u);
  assert.doesNotMatch(event.payload.output_text, /sk-super-secret/u);
});

test("uses the canonical null representation for empty command output", () => {
  const event = normalizeAppServerFrame({
    streamId: "activity-empty-output-stream",
    direction: "provider_to_client",
    sequence: 1,
    frame: { method: "item/completed", params: {
      completedAtMs: 1,
      threadId: "thread-empty-output",
      turnId: "turn-empty-output",
      item: {
        id: "command-empty-output",
        type: "commandExecution",
        command: "powershell.exe",
        commandActions: [],
        cwd: "C:\\Users\\kouki\\project",
        status: "completed",
        exitCode: 0,
        aggregatedOutput: ""
      }
    } }
  });

  assert.equal(event.event_type, "command.completed");
  assert.equal(event.payload.output_present, false);
  assert.equal(event.payload.output_bytes, 0);
  assert.equal(event.payload.output_text, null);
});

test("projects explicit plans while excluding reasoning and rejects malformed activity items", () => {
  const plan = normalizeAppServerFrame({
    streamId: "plan-stream",
    direction: "provider_to_client",
    sequence: 1,
    frame: {
      method: "turn/plan/updated",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        explanation: "token=private-value",
        plan: [
          { step: "Inspect the contract", status: "completed" },
          { step: "password: private-value", status: "inProgress" }
        ]
      }
    }
  });
  const reasoning = normalizeAppServerFrame({
    streamId: "plan-stream",
    direction: "provider_to_client",
    sequence: 2,
    frame: {
      method: "item/completed",
      params: {
        completedAtMs: 2,
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "reasoning-1", type: "reasoning", summary: ["PRIVATE"], content: ["PRIVATE"] }
      }
    }
  });
  assert.equal(plan.event_type, "plan.updated");
  assert.equal(plan.payload.activity_kind, "plan");
  assert.deepEqual(plan.payload.steps.map((step) => step.status), ["completed", "inProgress"]);
  assert.doesNotMatch(JSON.stringify(plan.payload), /private-value/u);
  assert.equal(reasoning.event_type, "item.completed");
  assert.deepEqual(reasoning.payload, {
    item_id: "reasoning-1",
    item_type: "reasoning",
    item_status: null,
    content_omitted: true
  });
  assert.doesNotMatch(JSON.stringify(reasoning.payload), /PRIVATE/u);
  assert.throws(() => normalizeAppServerFrame({
    streamId: "plan-stream",
    direction: "provider_to_client",
    sequence: 3,
    frame: {
      method: "item/started",
      params: {
        startedAtMs: 3,
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "broken", type: "commandExecution", command: "npm" }
      }
    }
  }), /missing commandActions/u);
});

test("normalizes every pinned tool item discriminator through one bounded tool contract", () => {
  const items = [
    {
      id: "dynamic-1", type: "dynamicToolCall", tool: "render", status: "completed",
      arguments: { private: "must-not-cross" }, result: { private: "must-not-cross" }
    },
    {
      id: "collab-1", type: "collabAgentToolCall", tool: "spawn_agent", status: "completed",
      senderThreadId: "thread-1", receiverThreadIds: ["thread-2"], agentsStates: { "thread-2": "completed" }
    },
    {
      id: "search-1", type: "webSearch", query: "private query must-not-cross"
    }
  ];
  const events = items.map((item, index) => normalizeAppServerFrame({
    streamId: "tool-types",
    direction: "provider_to_client",
    sequence: index + 1,
    frame: {
      method: "item/completed",
      params: { completedAtMs: index + 1, threadId: "thread-1", turnId: "turn-1", item }
    }
  }));
  assert.deepEqual(events.map((event) => event.event_type), ["tool.completed", "tool.completed", "tool.completed"]);
  assert.deepEqual(events.map((event) => event.payload.tool_kind), ["dynamicToolCall", "collabAgentToolCall", "webSearch"]);
  assert.deepEqual(events.map((event) => event.payload.tool_name), ["render", "spawn_agent", "webSearch"]);
  assert.doesNotMatch(JSON.stringify(events), /must-not-cross/u);
  for (const event of events) {
    assert.equal(event.payload.arguments_omitted, true);
    assert.equal(event.payload.result_omitted, true);
    assert.equal(event.payload.content_omitted, true);
  }
});

test("rejects unbound or invalid approval responses and preserves only the decision option", () => {
  const request = {
    id: "approval-response-1",
    method: "item/commandExecution/requestApproval",
    params: {
      itemId: "item-1",
      startedAtMs: 1,
      threadId: "thread-1",
      turnId: "turn-1"
    }
  };
  const base = {
    streamId: "approval-response",
    direction: "client_to_provider",
    sequence: 1,
    request
  };
  assert.throws(
    () => normalizeAppServerFrame({ ...base, request: null, frame: { id: request.id, result: { decision: "decline" } } }),
    /requires its exact server request context/u
  );
  assert.throws(
    () => normalizeAppServerFrame({ ...base, frame: { id: "wrong", result: { decision: "decline" } } }),
    /does not match/u
  );
  assert.throws(
    () => normalizeAppServerFrame({ ...base, frame: { id: request.id, result: { malicious: "x" } } }),
    /missing decision/u
  );
  assert.throws(
    () => normalizeAppServerFrame({ ...base, frame: { id: request.id, result: { decision: "allow-everything" } } }),
    /unsupported decision/u
  );
  const structured = normalizeAppServerFrame({
    ...base,
    frame: {
      id: request.id,
      result: { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: "secret" } } }
    }
  });
  assert.equal(structured.payload.decision_option, "acceptWithExecpolicyAmendment");
  assert.doesNotMatch(JSON.stringify(structured), /execpolicy_amendment|secret/u);
});
