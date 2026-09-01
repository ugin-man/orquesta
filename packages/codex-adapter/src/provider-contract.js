"use strict";

const { createHash } = require("node:crypto");

const schema = require("../protocol/app-server-schema.json");
const version = require("../protocol/app-server-version.json");
const recordedContract = require("../protocol/recorded-contract.v1.json");
const { deepFreeze } = require("./contract");

const PROVIDER_CONTRACT_VERSION = 1;
const PROVIDER_ID = "codex_app_server";
const RECORDED_CONTRACT_ID = "codex-app-server-0.144.5-recorded-v1";
const PINNED_RECORDED_CONTRACT_SHA256 = "3fdd8867fea7f85faa8dc263c08478e3e15516da42ad5e5b86e2c15e4707d96d";
const PROVIDER_CAPABILITY_STATES = Object.freeze([
  "supported",
  "unsupported",
  "unknown"
]);

const PROVIDER_CAPABILITY_KEYS = Object.freeze([
  "initialize",
  "account_read",
  "account_login_start",
  "thread_create",
  "thread_resume",
  "thread_rename",
  "thread_archive",
  "thread_list_paginated",
  "thread_read",
  "thread_turns_list_paginated",
  "turn_start",
  "turn_steer",
  "turn_interrupt",
  "item_lifecycle_events",
  "agent_message_streaming",
  "command_approval",
  "file_change_approval",
  "approval_reconnect_recovery",
  "request_user_input",
  "actual_model_read"
]);

function canonicalJson(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function cloneJson(value) {
  return JSON.parse(canonicalJson(value));
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function capabilityEntry(state, evidenceRef, note, {
  providerState = state,
  adapterState = state
} = {}) {
  if (!PROVIDER_CAPABILITY_STATES.includes(state)) {
    throw new TypeError(`unknown provider capability state: ${state}`);
  }
  if (!PROVIDER_CAPABILITY_STATES.includes(providerState)
      || !PROVIDER_CAPABILITY_STATES.includes(adapterState)) {
    throw new TypeError("provider and adapter capability states must be tri-state values");
  }
  const derivedState = providerState === "unsupported" || adapterState === "unsupported"
    ? "unsupported"
    : providerState === "supported" && adapterState === "supported"
      ? "supported"
      : "unknown";
  if (state !== derivedState) {
    throw new TypeError(`aggregate capability state must be ${derivedState} for provider=${providerState}, adapter=${adapterState}`);
  }
  return deepFreeze({
    state,
    provider_state: providerState,
    adapter_state: adapterState,
    evidence_ref: nonEmptyString(evidenceRef, "capability evidence ref"),
    note: nonEmptyString(note, "capability note")
  });
}

function defineProviderCapabilityProfile({ provider, runtimeVersion, capabilities }) {
  nonEmptyString(provider, "provider");
  nonEmptyString(runtimeVersion, "runtime version");
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
    throw new TypeError("provider capabilities must be an object");
  }
  const declared = Object.keys(capabilities).sort();
  const expected = [...PROVIDER_CAPABILITY_KEYS].sort();
  if (declared.length !== expected.length
      || declared.some((key, index) => key !== expected[index])) {
    throw new TypeError(`provider capabilities must contain exactly: ${PROVIDER_CAPABILITY_KEYS.join(", ")}`);
  }
  for (const key of PROVIDER_CAPABILITY_KEYS) {
    const value = capabilities[key];
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError(`${key} capability must be an object`);
    }
    capabilityEntry(value.state, value.evidence_ref, value.note, {
      providerState: value.provider_state,
      adapterState: value.adapter_state
    });
  }
  return deepFreeze({
    contract_version: PROVIDER_CONTRACT_VERSION,
    provider,
    runtime_version: runtimeVersion,
    capabilities: cloneJson(capabilities)
  });
}

const CODEX_APP_SERVER_PROVIDER_PROFILE = defineProviderCapabilityProfile({
  provider: PROVIDER_ID,
  runtimeVersion: version.cli_version,
  capabilities: {
    initialize: capabilityEntry("supported", "schema:client_requests:initialize", "Pinned schema exposes initialization."),
    account_read: capabilityEntry("supported", "schema:client_requests:account/read", "Pinned schema exposes account state reads."),
    account_login_start: capabilityEntry("supported", "schema:client_requests:account/login/start", "Pinned schema exposes login start, not a complete login session guarantee."),
    thread_create: capabilityEntry("supported", "schema:client_requests:thread/start", "Pinned schema exposes thread creation."),
    thread_resume: capabilityEntry("supported", "schema:client_requests:thread/resume", "Pinned schema exposes thread resume."),
    thread_rename: capabilityEntry("supported", "schema:client_requests:thread/name/set", "Pinned schema exposes thread naming."),
    thread_archive: capabilityEntry("supported", "schema:client_requests:thread/archive", "Pinned schema exposes thread archive."),
    thread_list_paginated: capabilityEntry("supported", "schema:client_requests:thread/list", "Thread pages may return data and an optional next cursor."),
    thread_read: capabilityEntry("supported", "schema:client_requests:thread/read", "Pinned schema exposes a thread snapshot."),
    thread_turns_list_paginated: capabilityEntry("supported", "schema:client_requests:thread/turns/list", "Pinned schema exposes turn pages for one thread."),
    turn_start: capabilityEntry("supported", "schema:client_requests:turn/start", "Pinned schema exposes turn start."),
    turn_steer: capabilityEntry("supported", "schema:client_requests:turn/steer", "Pinned schema exposes in-flight steering."),
    turn_interrupt: capabilityEntry("supported", "schema:client_requests:turn/interrupt", "Pinned schema exposes turn interruption."),
    item_lifecycle_events: capabilityEntry("supported", "schema:server_notifications:item/started,item/completed", "Pinned schema exposes item lifecycle notifications."),
    agent_message_streaming: capabilityEntry("supported", "schema:server_notifications:item/agentMessage/delta", "Pinned schema exposes bounded public agent-answer deltas."),
    command_approval: capabilityEntry("supported", "schema:server_requests:item/commandExecution/requestApproval", "Pinned schema exposes command approval while the request is live."),
    file_change_approval: capabilityEntry("supported", "schema:server_requests:item/fileChange/requestApproval", "Pinned schema exposes file-change approval while the request is live."),
    approval_reconnect_recovery: capabilityEntry("unsupported", "schema:server_requests", "The pinned schema does not expose a list or replay operation for unresolved approvals.", { providerState: "unknown", adapterState: "unsupported" }),
    request_user_input: capabilityEntry("unsupported", "schema:server_requests", "The pinned schema subset contains no verified request-user-input server method.", { providerState: "unknown", adapterState: "unsupported" }),
    actual_model_read: capabilityEntry("unsupported", "adapter:APP_SERVER_CAPABILITIES:readActualModel", "Model reroute can be observed, but an authoritative current-model read is not exposed.", { providerState: "unknown", adapterState: "unsupported" })
  }
});

const PROVIDER_HISTORY_POLICY = deepFreeze({
  normal_history_source: "app_server_thread_apis",
  raw_codex_file_access: "migration_only",
  provider_event_payloads: "bounded_non_secret_projection",
  raw_frame_owner: "P0-B_ingestion_journal",
  digest_disclosure: "internal_integrity_only_not_a_secrecy_boundary"
});

const MAX_PROVIDER_ID_LENGTH = 1024;
const MAX_STREAM_ID_LENGTH = 1024;
const MAX_AGENT_MESSAGE_DELTA_BYTES = 64 * 1024;
const MAX_PUBLIC_ACTIVITY_TEXT_BYTES = 16 * 1024;
const MAX_PUBLIC_PLAN_STEPS = 64;
const MAX_PUBLIC_FILE_CHANGES = 128;
const MAX_PUBLIC_ACTION_TYPES = 16;
const ACTIVITY_ITEM_TYPES = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "webSearch",
  "plan"
]);

function typedProviderId(value, label = "provider request ID") {
  if (typeof value === "string") {
    if (value.trim() === "" || value.length > MAX_PROVIDER_ID_LENGTH) {
      throw new TypeError(`${label} must contain 1-${MAX_PROVIDER_ID_LENGTH} characters`);
    }
    return { type: "string", value };
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0)) {
    return { type: "number", value };
  }
  throw new TypeError(`${label} must be a bounded string or safe integer`);
}

function boundedStreamId(value) {
  nonEmptyString(value, "provider stream ID");
  if (value.length > MAX_STREAM_ID_LENGTH) {
    throw new TypeError(`provider stream ID must contain 1-${MAX_STREAM_ID_LENGTH} characters`);
  }
  return value;
}

function requireFields(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) throw new TypeError(`${label} missing ${field}`);
  }
}

function validateClientRequest(request) {
  requireFields(request, ["id", "method", "params"], "provider request context");
  typedProviderId(request.id, "provider request context ID");
  const definition = schema.client_requests[request.method];
  if (!definition) throw new TypeError(`unsupported provider request context method: ${request.method}`);
  requireFields(request.params, definition.params_required, `${request.method} request params`);
  return definition;
}

function decisionOption(decision) {
  if (typeof decision === "string") return decision;
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) return null;
  const keys = Object.keys(decision);
  return keys.length === 1 ? keys[0] : null;
}

function validateServerRequestContext(request) {
  requireFields(request, ["id", "method", "params"], "server request context");
  typedProviderId(request.id, "server request context ID");
  const definition = schema.server_requests[request.method];
  if (!definition) throw new TypeError(`unsupported server request context method: ${request.method}`);
  if (request.method !== "item/tool/call") {
    requireFields(request.params, definition.params_required, `${request.method} request context params`);
  }
  return definition;
}

function validateKnownFrame({ direction, kind, frame, request }) {
  if (direction === "provider_to_client" && (kind === "response" || kind === "error_response")) {
    if (!request) throw new TypeError("provider response requires its exact request context");
    const definition = validateClientRequest(request);
    if (canonicalJson(typedProviderId(frame.id)) !== canonicalJson(typedProviderId(request.id))) {
      throw new TypeError("provider response ID does not match its request context");
    }
    if (kind === "response") requireFields(frame.result, definition.response_required, `${request.method} response`);
    else requireFields(frame.error, ["message"], `${request.method} error response`);
    return;
  }
  if (direction === "client_to_provider" && kind === "response") {
    if (!request) throw new TypeError("client response requires its exact server request context");
    const definition = validateServerRequestContext(request);
    if (canonicalJson(typedProviderId(frame.id)) !== canonicalJson(typedProviderId(request.id))) {
      throw new TypeError("client response ID does not match its server request context");
    }
    if (request.method === "item/tool/call") {
      requireFields(frame.result, definition.response_required, `${request.method} client response`);
      if (typeof frame.result.success !== "boolean" || !Array.isArray(frame.result.contentItems)
        || !frame.result.contentItems.every((item) => item && typeof item === "object" && !Array.isArray(item)
          && item.type === "inputText" && typeof item.text === "string")
        || Buffer.byteLength(JSON.stringify(frame.result), "utf8") > 64 * 1024) {
        throw new TypeError("item/tool/call client response is invalid");
      }
      return;
    }
    requireFields(frame.result, [definition.response_field], `${request.method} client response`);
    const option = decisionOption(frame.result[definition.response_field]);
    if (!definition.response_options.includes(option)) {
      throw new TypeError(`${request.method} client response has an unsupported decision`);
    }
    return;
  }
  if (request !== null && request !== undefined) {
    throw new TypeError("request context is valid only for a provider response");
  }
  if (direction === "provider_to_client" && kind === "server_request") {
    requireFields(frame, ["id", "method", "params"], "server request");
    typedProviderId(frame.id);
    const definition = schema.server_requests[frame.method];
    if (frame.method !== "item/tool/call") {
      requireFields(frame.params, definition?.params_required ?? [], `${frame.method} params`);
    }
    return;
  }
  if (direction === "provider_to_client" && kind === "notification") {
    requireFields(frame, ["method", "params"], "server notification");
    const definition = schema.server_notifications[frame.method];
    requireFields(frame.params, definition?.params_required ?? [], `${frame.method} params`);
    if (frame.method === "item/started" || frame.method === "item/completed") {
      validateThreadItem(frame.params.item);
    }
    return;
  }
  if (direction === "client_to_provider" && kind === "client_request") {
    validateClientRequest(frame);
    return;
  }
  if (direction === "client_to_provider" && kind === "notification") {
    requireFields(frame, ["method"], "client notification");
    if (!schema.client_notifications[frame.method]) {
      throw new TypeError(`unsupported client notification: ${frame.method}`);
    }
    return;
  }
  throw new TypeError("provider frame has no recognized protocol shape");
}

function validateThreadItem(item) {
  requireFields(item, ["id", "type"], "thread item");
  const definition = schema.thread_items?.[item.type];
  if (!definition) return;
  requireFields(item, definition.required, `${item.type} thread item`);
  if (definition.status_options && !definition.status_options.includes(item.status)) {
    throw new TypeError(`${item.type} thread item has an unsupported status`);
  }
}

function sourceKind(direction, frame) {
  const hasMethod = typeof frame.method === "string" && frame.method !== "";
  const hasId = Object.hasOwn(frame, "id");
  if (hasMethod && hasId) return direction === "provider_to_client" ? "server_request" : "client_request";
  if (hasMethod) return "notification";
  if (hasId && Object.hasOwn(frame, "error")) return "error_response";
  if (hasId) return "response";
  return "unknown_frame";
}

function boundedIdentifier(value) {
  return typeof value === "string" && value !== "" && value.length <= MAX_PROVIDER_ID_LENGTH
    ? value
    : null;
}

function utf8Prefix(value, maximumBytes) {
  const source = Buffer.from(value, "utf8");
  if (source.length <= maximumBytes) return value;
  for (let length = maximumBytes; length >= Math.max(0, maximumBytes - 4); length -= 1) {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(source.subarray(0, length)); }
    catch { /* Remove an incomplete final UTF-8 code point. */ }
  }
  return "";
}

function redactPublicText(value) {
  return value
    .replace(/\b[A-Za-z]:[\\/]Users[\\/][^\\/\s]+/giu, "%USERPROFILE%")
    .replace(/\/(?:Users|home)\/[^/\s]+/giu, "$HOME")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/giu, "Bearer [REDACTED]")
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs])-[-A-Za-z0-9_]{8,}/giu, "[REDACTED]")
    .replace(/\b(?:password|passwd|token|secret|api[_-]?key)[-_][A-Za-z0-9._~+\/-]{4,}/giu, "[REDACTED]")
    .replace(/\b(password|passwd|token|secret|api[_-]?key)\s*([=:])\s*([^\s,;]+)/giu, "$1$2[REDACTED]")
    .replace(/(--(?:password|token|secret|api-key)\s+)([^\s]+)/giu, "$1[REDACTED]");
}

function publicText(value, maximumBytes = MAX_PUBLIC_ACTIVITY_TEXT_BYTES) {
  if (typeof value !== "string") return null;
  const originalBytes = Buffer.byteLength(value, "utf8");
  const redacted = redactPublicText(value).replace(/\u0000/gu, "");
  const text = utf8Prefix(redacted, maximumBytes);
  return {
    text,
    original_bytes: originalBytes,
    truncated: Buffer.byteLength(redacted, "utf8") > maximumBytes,
    redacted: redacted !== value
  };
}

function publicIdentifier(value, fallback) {
  if (typeof value !== "string" || value.trim() === "") return fallback;
  const candidate = redactPublicText(value.trim()).replace(/[\u0000-\u001f\u007f]/gu, "");
  return utf8Prefix(candidate, 256) || fallback;
}

function publicCommandName(command) {
  if (typeof command !== "string") return "command";
  const first = command.trim().match(/^(?:[&]\s*)?(?:"([^"]+)"|'([^']+)'|([^\s|;&]+))/u);
  const token = first?.[1] ?? first?.[2] ?? first?.[3] ?? "command";
  const name = token.split(/[\\/]/u).filter(Boolean).at(-1) ?? "command";
  return /^[A-Za-z0-9_.@+-]{1,128}$/u.test(name) ? name : "command";
}

function publicPath(value) {
  if (typeof value !== "string" || value.trim() === "") return "file";
  const normalized = redactPublicText(value.trim()).replace(/\\/gu, "/");
  const segments = normalized.split("/").filter(Boolean);
  const tail = segments.slice(-4).map((segment) => publicIdentifier(segment, "file"));
  return `${segments.length > tail.length ? "…/" : ""}${tail.join("/") || "file"}`;
}

function diffStats(value) {
  if (typeof value !== "string") return { original_bytes: 0, added_lines: 0, removed_lines: 0 };
  let added = 0;
  let removed = 0;
  for (const line of value.split(/\r?\n/u)) {
    if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
  }
  return { original_bytes: Buffer.byteLength(value, "utf8"), added_lines: added, removed_lines: removed };
}

function activityState(status, fallback) {
  if (status === undefined || status === null) return fallback;
  if (status === "inProgress") return "running";
  if (["completed", "failed", "declined"].includes(status)) return status;
  return "unknown";
}

function fileChanges(changes) {
  if (!Array.isArray(changes)) throw new TypeError("fileChange changes must be an array");
  const items = changes.slice(0, MAX_PUBLIC_FILE_CHANGES).map((change) => {
    requireFields(change, ["diff", "kind", "path"], "file update change");
    return {
      path: publicPath(change.path),
      kind: publicIdentifier(change.kind, "unknown"),
      ...diffStats(change.diff)
    };
  });
  return { items, total: changes.length, truncated: changes.length > items.length };
}

function normalizedActivityItem(item, eventType) {
  const fallbackState = eventType.endsWith(".started") ? "running" : "completed";
  const state = activityState(item.status, fallbackState);
  if (item.type === "commandExecution") {
    const actionTypes = Array.isArray(item.commandActions)
      ? item.commandActions.slice(0, MAX_PUBLIC_ACTION_TYPES)
        .map((action) => publicIdentifier(action?.type, "unknown"))
      : [];
    const output = publicText(item.aggregatedOutput);
    const outputBytes = output?.original_bytes ?? 0;
    return {
      activity_kind: "command",
      activity_state: state,
      title: `${publicCommandName(item.command)} command`,
      command_name: publicCommandName(item.command),
      action_types: actionTypes,
      action_types_truncated: Array.isArray(item.commandActions) && item.commandActions.length > actionTypes.length,
      exit_code: Number.isSafeInteger(item.exitCode) ? item.exitCode : null,
      duration_ms: Number.isSafeInteger(item.durationMs) && item.durationMs >= 0 ? item.durationMs : null,
      output_present: outputBytes > 0,
      output_bytes: outputBytes,
      // Use one no-output representation across Adapter, Core and SQLite.
      // An empty provider string is semantically no output; forwarding ""
      // made the stricter downstream validators discard the entire activity.
      output_text: outputBytes > 0 ? output?.text ?? null : null,
      output_truncated: output?.truncated ?? false,
      output_redacted: output?.redacted ?? false,
      cwd_omitted: true,
      command_arguments_omitted: true,
      content_omitted: true
    };
  }
  if (item.type === "fileChange") {
    const changes = fileChanges(item.changes);
    return {
      activity_kind: "file_change",
      activity_state: state,
      title: changes.total === 1 ? "1 file change" : `${changes.total} file changes`,
      changes: changes.items,
      change_count: changes.total,
      changes_truncated: changes.truncated,
      content_omitted: true
    };
  }
  if (["mcpToolCall", "dynamicToolCall", "collabAgentToolCall", "webSearch"].includes(item.type)) {
    const toolName = item.type === "webSearch" ? "webSearch" : publicIdentifier(item.tool, item.type);
    return {
      activity_kind: "tool",
      activity_state: state,
      title: `${toolName} tool`,
      tool_kind: item.type,
      tool_name: toolName,
      tool_namespace: item.type === "mcpToolCall"
        ? publicIdentifier(item.server, null)
        : publicIdentifier(item.namespace, null),
      duration_ms: Number.isSafeInteger(item.durationMs) && item.durationMs >= 0 ? item.durationMs : null,
      success: typeof item.success === "boolean" ? item.success : null,
      arguments_omitted: true,
      result_omitted: true,
      content_omitted: true
    };
  }
  if (item.type === "plan") {
    const text = publicText(item.text);
    if (!text) throw new TypeError("plan item text must be a string");
    return {
      activity_kind: "plan",
      activity_state: state,
      title: "Plan",
      text: text.text,
      original_bytes: text.original_bytes,
      truncated: text.truncated,
      redacted: text.redacted
    };
  }
  return null;
}

function normalizedTurnDiff(body) {
  if (typeof body?.diff !== "string") throw new TypeError("turn diff must be a string");
  return {
    activity_kind: "diff",
    activity_state: "updated",
    title: "Turn diff",
    ...diffStats(body.diff),
    content_omitted: true
  };
}

function normalizedTurnPlan(body) {
  if (!Array.isArray(body?.plan)) throw new TypeError("turn plan must be an array");
  const steps = body.plan.slice(0, MAX_PUBLIC_PLAN_STEPS).map((step) => {
    requireFields(step, ["status", "step"], "turn plan step");
    const text = publicText(step.step, 2 * 1024);
    if (!text) throw new TypeError("turn plan step text must be a string");
    return { status: publicIdentifier(step.status, "pending"), text: text.text, truncated: text.truncated, redacted: text.redacted };
  });
  const explanation = publicText(body.explanation, 4 * 1024);
  return {
    activity_kind: "plan",
    activity_state: "updated",
    title: "Plan",
    steps,
    step_count: body.plan.length,
    steps_truncated: body.plan.length > steps.length,
    explanation: explanation?.text ?? null,
    explanation_truncated: explanation?.truncated ?? false,
    explanation_redacted: explanation?.redacted ?? false
  };
}

function frameScope(frame) {
  const body = frame.params ?? frame.result ?? frame.error ?? {};
  const thread = body.thread;
  const turn = body.turn;
  const item = body.item;
  return {
    thread_id: boundedIdentifier(body.threadId ?? thread?.id),
    turn_id: boundedIdentifier(body.turnId ?? turn?.id),
    item_id: boundedIdentifier(body.itemId ?? item?.id)
  };
}

function normalizedPayload(frame, normalizedEventType) {
  const body = frame.params ?? frame.result ?? frame.error ?? null;
  if (normalizedEventType === "attention.approval_requested") {
    const method = frame.method;
    return {
      item_id: body?.itemId ?? null,
      reason_present: typeof body?.reason === "string" && body.reason !== "",
      response_options: [...(schema.server_requests[method]?.response_options ?? [])]
    };
  }
  if (normalizedEventType === "tool.requested") {
    return {
      tool_name: frame.params?.tool === "orquesta_attachment_read" ? "orquesta_attachment_read" : "unknown",
      arguments_omitted: true,
      content_omitted: true
    };
  }
  if (normalizedEventType === "tool.response_submitted") {
    return {
      success: typeof frame.result?.success === "boolean" ? frame.result.success : null,
      arguments_omitted: true,
      content_omitted: true
    };
  }
  if (normalizedEventType.startsWith("provider.unknown")) {
    const bodyKeys = body && typeof body === "object" && !Array.isArray(body)
      ? Object.keys(body).sort()
      : [];
    return {
      unrecognized: true,
      frame_keys: Object.keys(frame).sort(),
      body_keys: bodyKeys,
      body_sha256: createHash("sha256").update(canonicalJson(body), "utf8").digest("hex")
    };
  }
  if (normalizedEventType === "runtime.initialized") {
    return {
      platform_family: body?.platformFamily ?? null,
      platform_os: body?.platformOs ?? null,
      user_agent: body?.userAgent ?? null,
      codex_home_present: typeof body?.codexHome === "string" && body.codexHome !== ""
    };
  }
  if (normalizedEventType === "history.page") {
    const records = Array.isArray(body?.data) ? body.data : [];
    return {
      record_count: records.length,
      record_ids: records.map((entry) => boundedIdentifier(entry?.id)).filter(Boolean),
      next_cursor_present: typeof body?.nextCursor === "string" && body.nextCursor !== "",
      backwards_cursor_present: typeof body?.backwardsCursor === "string" && body.backwardsCursor !== "",
      content_omitted: true
    };
  }
  if (normalizedEventType === "thread.snapshot" || normalizedEventType === "thread.accepted") {
    const thread = body?.thread ?? null;
    return {
      thread_id: boundedIdentifier(thread?.id),
      status: typeof thread?.status === "string" ? thread.status : thread?.status?.type ?? null,
      turn_count: Array.isArray(thread?.turns) ? thread.turns.length : null,
      model: typeof body?.model === "string" ? body.model : null,
      cwd_omitted: typeof body?.cwd === "string" || typeof thread?.cwd === "string",
      content_omitted: true
    };
  }
  if (["turn.accepted", "turn.started", "turn.completed", "turn.interrupt_accepted"].includes(normalizedEventType)) {
    const turn = body?.turn ?? null;
    return {
      turn_id: boundedIdentifier(turn?.id ?? body?.turnId),
      status: typeof turn?.status === "string" ? turn.status : null,
      item_count: Array.isArray(turn?.items) ? turn.items.length : null,
      content_omitted: true
    };
  }
  if (["tool.started", "tool.completed", "tool.failed", "command.started", "command.completed", "command.failed",
    "file.change.started", "file.change.completed", "file.change.failed", "plan.updated"].includes(normalizedEventType)
      && ACTIVITY_ITEM_TYPES.has(body?.item?.type)) {
    return normalizedActivityItem(
      body.item,
      frame.method === "item/started" ? "activity.started" : normalizedEventType
    );
  }
  if (normalizedEventType === "diff.updated") return normalizedTurnDiff(body);
  if (normalizedEventType === "plan.updated") return normalizedTurnPlan(body);
  if (normalizedEventType === "item.started" || normalizedEventType === "item.completed") {
    return {
      item_id: boundedIdentifier(body?.item?.id),
      item_type: typeof body?.item?.type === "string" ? body.item.type : null,
      item_status: typeof body?.item?.status === "string" ? body.item.status : null,
      content_omitted: true
    };
  }
  if (normalizedEventType === "message.agent.delta") {
    const delta = body?.delta;
    if (typeof delta !== "string" || delta.length === 0
        || Buffer.byteLength(delta, "utf8") > MAX_AGENT_MESSAGE_DELTA_BYTES) {
      throw new TypeError(`agent message delta must contain 1-${MAX_AGENT_MESSAGE_DELTA_BYTES} UTF-8 bytes`);
    }
    return {
      item_id: boundedIdentifier(body?.itemId),
      delta
    };
  }
  if (normalizedEventType === "provider.failure") {
    const error = body?.error ?? body;
    const message = typeof error?.message === "string" ? error.message : null;
    return {
      code: typeof error?.code === "string" || typeof error?.code === "number" ? error.code : null,
      will_retry: typeof body?.willRetry === "boolean" ? body.willRetry : null,
      message_present: message !== null,
      message_sha256: message === null ? null : createHash("sha256").update(message, "utf8").digest("hex")
    };
  }
  if (normalizedEventType === "model.observed") {
    return {
      from_model: typeof body?.fromModel === "string" ? body.fromModel : null,
      to_model: typeof body?.toModel === "string" ? body.toModel : null,
      reason_present: typeof body?.reason === "string" && body.reason !== ""
    };
  }
  if (normalizedEventType === "account.updated" || normalizedEventType === "account.login_completed") {
    return {
      auth_mode: typeof body?.authMode === "string" ? body.authMode : null,
      plan_type: typeof body?.planType === "string" ? body.planType : null,
      success: typeof body?.success === "boolean" ? body.success : null,
      error_present: body?.error !== null && body?.error !== undefined
    };
  }
  if (normalizedEventType === "attention.response_submitted") {
    return {
      decision_option: decisionOption(body?.decision)
    };
  }
  return {
    content_omitted: true,
    body_sha256: createHash("sha256").update(canonicalJson(body), "utf8").digest("hex")
  };
}

function itemActivityEventType(item, method) {
  const started = method === "item/started";
  const suffix = started ? "started" : item?.status === "failed" || item?.status === "declined" ? "failed" : "completed";
  if (["mcpToolCall", "dynamicToolCall", "collabAgentToolCall", "webSearch"].includes(item?.type)) return `tool.${suffix}`;
  if (item?.type === "commandExecution") return `command.${suffix}`;
  if (item?.type === "fileChange") return `file.change.${suffix}`;
  if (item?.type === "plan") return "plan.updated";
  return started ? "item.started" : "item.completed";
}

function eventType({ direction, frame, request, kind }) {
  const method = frame.method ?? request?.method ?? null;
  if (kind === "error_response" || method === "error") return "provider.failure";
  if (direction === "provider_to_client" && kind === "response") {
    if (method === "initialize") return "runtime.initialized";
    if (method === "thread/list" || method === "thread/turns/list") return "history.page";
    if (method === "thread/read") return "thread.snapshot";
    if (method === "thread/start" || method === "thread/resume") return "thread.accepted";
    if (method === "turn/start" || method === "turn/steer") return "turn.accepted";
    if (method === "turn/interrupt") return "turn.interrupt_accepted";
    return "provider.unknown_response";
  }
  if (direction === "provider_to_client" && kind === "server_request") {
    if (method === "item/tool/call") return "tool.requested";
    if (Object.hasOwn(schema.server_requests, method)) return "attention.approval_requested";
    return "provider.unknown_request";
  }
  if (direction === "provider_to_client" && kind === "notification") {
    if (method === "thread/started") return "thread.started";
    if (method === "turn/started") return "turn.started";
    if (method === "item/started" || method === "item/completed") return itemActivityEventType(frame.params?.item, method);
    if (method === "item/agentMessage/delta") return "message.agent.delta";
    if (method === "turn/diff/updated") return "diff.updated";
    if (method === "turn/plan/updated") return "plan.updated";
    if (method === "turn/completed") return "turn.completed";
    if (method === "model/rerouted") return "model.observed";
    if (method === "account/updated") return "account.updated";
    if (method === "account/login/completed") return "account.login_completed";
    return "provider.unknown_notification";
  }
  if (direction === "client_to_provider" && kind === "client_request") {
    return "provider.command_requested";
  }
  if (direction === "client_to_provider" && kind === "notification") {
    return "provider.command_notified";
  }
  if (direction === "client_to_provider" && kind === "response") {
    if (method === "item/tool/call") return "tool.response_submitted";
    return "attention.response_submitted";
  }
  return "provider.unknown_frame";
}

function normalizeAppServerFrame({ streamId, direction, frame, sequence, request = null }) {
  boundedStreamId(streamId);
  if (direction !== "client_to_provider" && direction !== "provider_to_client") {
    throw new TypeError("provider frame direction must be client_to_provider or provider_to_client");
  }
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
    throw new TypeError("provider frame must be an object");
  }
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new TypeError("provider frame sequence must be a positive safe integer");
  }

  const kind = sourceKind(direction, frame);
  validateKnownFrame({ direction, kind, frame, request });
  const detached = cloneJson(frame);
  const detachedRequest = request === null ? null : cloneJson(request);
  const method = detached.method ?? detachedRequest?.method ?? null;
  const sourceCanonical = canonicalJson(detached);
  const normalizedEventType = eventType({ direction, frame: detached, request: detachedRequest, kind });
  const normalized = {
    contract_version: PROVIDER_CONTRACT_VERSION,
    provider: PROVIDER_ID,
    provider_stream_id: streamId,
    provider_sequence: sequence,
    sequence_scope: "provider_connection",
    direction,
    event_type: normalizedEventType,
    source: {
      kind,
      method,
      has_request_id: Object.hasOwn(detached, "id"),
      request_frame_sha256: detachedRequest === null
        ? null
        : createHash("sha256").update(canonicalJson(detachedRequest), "utf8").digest("hex"),
      frame_sha256: createHash("sha256").update(sourceCanonical, "utf8").digest("hex")
    },
    scope: frameScope(detached),
    payload: normalizedPayload(detached, normalizedEventType)
  };
  return deepFreeze(normalized);
}

function validateRecordedContract(value = recordedContract) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("recorded contract must be an object");
  }
  if (value.schema_version !== PROVIDER_CONTRACT_VERSION
      || value.contract_id !== RECORDED_CONTRACT_ID
      || value.provider !== PROVIDER_ID
      || value.capture?.cli_version !== version.cli_version
      || value.capture?.schema_source_canonical_sha256 !== schema.source.canonical_sha256) {
    throw new TypeError("recorded contract does not match the pinned provider contract");
  }
  nonEmptyString(value.capture?.live_evidence_ref, "recorded contract live evidence ref");
  if (!/^[a-f0-9]{64}$/u.test(value.capture?.live_evidence_sha256 ?? "")) {
    throw new TypeError("recorded contract requires a live evidence SHA-256");
  }
  if (!Array.isArray(value.cases) || value.cases.length === 0) {
    throw new TypeError("recorded contract requires cases");
  }
  const caseIds = new Set();
  let sequence = 0;
  for (const fixture of value.cases) {
    nonEmptyString(fixture.case_id, "recorded contract case ID");
    if (caseIds.has(fixture.case_id)) {
      throw new TypeError(`duplicate recorded contract case ID: ${fixture.case_id}`);
    }
    caseIds.add(fixture.case_id);
    sequence += 1;
    const event = normalizeAppServerFrame({ ...fixture.input, sequence });
    if (event.event_type !== fixture.expected_event_type) {
      throw new TypeError(`recorded contract expectation mismatch: ${fixture.case_id}`);
    }
  }
  const detached = cloneJson(value);
  const declaredHash = detached.contract_sha256;
  delete detached.contract_sha256;
  const computedHash = createHash("sha256").update(canonicalJson(detached), "utf8").digest("hex");
  if (declaredHash !== computedHash) {
    throw new TypeError("recorded contract SHA-256 does not match its canonical content");
  }
  if (declaredHash !== PINNED_RECORDED_CONTRACT_SHA256) {
    throw new TypeError("recorded contract content does not match the pinned contract identity");
  }
  return deepFreeze({
    ...detached,
    contract_sha256: declaredHash
  });
}

function replayRecordedContract(value = CODEX_APP_SERVER_RECORDED_CONTRACT) {
  const contract = validateRecordedContract(value);
  return deepFreeze(contract.cases.map((fixture, index) => normalizeAppServerFrame({
    ...fixture.input,
    sequence: index + 1
  })));
}

const CODEX_APP_SERVER_RECORDED_CONTRACT = validateRecordedContract(recordedContract);

module.exports = {
  CODEX_APP_SERVER_PROVIDER_PROFILE,
  CODEX_APP_SERVER_RECORDED_CONTRACT,
  PROVIDER_CAPABILITY_KEYS,
  PROVIDER_CAPABILITY_STATES,
  PROVIDER_CONTRACT_VERSION,
  PROVIDER_HISTORY_POLICY,
  PROVIDER_ID,
  PINNED_RECORDED_CONTRACT_SHA256,
  RECORDED_CONTRACT_ID,
  canonicalJson,
  defineProviderCapabilityProfile,
  normalizeAppServerFrame,
  replayRecordedContract,
  validateRecordedContract
};
