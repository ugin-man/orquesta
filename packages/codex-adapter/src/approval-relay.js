const { createHash } = require("node:crypto");

const schema = require("../protocol/app-server-schema.json");
const { deepFreeze } = require("./contract");

const EFFECT_KINDS = Object.freeze({
  "item/commandExecution/requestApproval": "command_execution",
  "item/fileChange/requestApproval": "file_change"
});
const MAX_PROVIDER_STRING_ID_LENGTH = 1024;
const DEFAULT_MAX_PENDING_APPROVALS = 256;
const APPROVAL_IDENTITY_DOMAIN = "orquesta.codex-adapter.approval.identity.v1";
const APPROVAL_INSTANCE_DOMAIN = "orquesta.codex-adapter.approval.instance.v1";
const PUBLIC_APPROVAL_ID_PATTERN = /^(?:approval|adapter-approval|adapter-approval-instance)-[a-f0-9]{64}$/iu;

function nonEmptyString(value, label, maximumLength = 1024) {
  if (typeof value !== "string" || value.trim() === "" || value.length > maximumLength) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function providerRequestId(value) {
  if (typeof value === "string") {
    if (value.trim() === "" || value.length > MAX_PROVIDER_STRING_ID_LENGTH) {
      throw new TypeError(`approval request string ID must contain 1-${MAX_PROVIDER_STRING_ID_LENGTH} characters`);
    }
    if (PUBLIC_APPROVAL_ID_PATTERN.test(value)) {
      throw new TypeError("approval request ID collides with the Orquesta public approval namespace");
    }
    return Object.freeze({ type: "string", value });
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || Object.is(value, -0)) {
    throw new TypeError("approval request numeric ID must be a safe integer and must not be negative zero");
  }
  return Object.freeze({ type: "number", value });
}

function canonicalJson(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

function canonicalApprovalIdentity(
  { message, correlationId, threadId, turnId },
  requestInstanceSerial = "0"
) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw new TypeError("approval message must be an object");
  }
  const method = nonEmptyString(message.method, "approval method");
  const definition = schema.server_requests[method];
  if (!definition) throw new Error(`unsupported approval method: ${method}`);
  const params = message.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new TypeError("approval params must be an object");
  }

  const boundThreadId = nonEmptyString(threadId, "approval thread ID");
  const boundTurnId = nonEmptyString(turnId, "approval turn ID");
  if (params.threadId !== boundThreadId || params.turnId !== boundTurnId) {
    throw new Error("approval request does not match the caller thread and turn");
  }

  const rawProviderRequestId = providerRequestId(message.id);
  const requestedEffect = {
    kind: EFFECT_KINDS[method],
    item_id: nonEmptyString(params.itemId, "approval item ID")
  };
  const responseOptions = [...definition.response_options];
  const instanceFingerprint = createHash("sha256").update(canonicalJson({
    domain: APPROVAL_INSTANCE_DOMAIN,
    serial: String(requestInstanceSerial)
  }), "utf8").digest("hex");
  const requestInstanceId = `adapter-approval-instance-${instanceFingerprint}`;
  const material = {
    domain: APPROVAL_IDENTITY_DOMAIN,
    schema_version: 1,
    provider_request_id: rawProviderRequestId,
    request_instance_id: requestInstanceId,
    method,
    correlation_id: nonEmptyString(correlationId, "approval correlation ID"),
    thread_id: boundThreadId,
    turn_id: boundTurnId,
    requested_effect: requestedEffect,
    response_options: responseOptions
  };
  const canonicalMaterial = canonicalJson(material);
  const fingerprint = createHash("sha256").update(canonicalMaterial, "utf8").digest("hex");
  const requestId = `adapter-approval-${fingerprint}`;
  return {
    providerKey: canonicalJson(rawProviderRequestId),
    providerRequestId: rawProviderRequestId.value,
    normalized: deepFreeze({
      request_id: requestId,
      request_instance_id: requestInstanceId,
      method,
      thread_id: boundThreadId,
      turn_id: boundTurnId,
      correlation_id: material.correlation_id,
      reason: typeof params.reason === "string" && params.reason !== ""
        ? "[redacted approval reason]"
        : null,
      requested_effect: requestedEffect,
      response_options: responseOptions
    })
  };
}

function normalizeApprovalRequest(input) {
  return canonicalApprovalIdentity(input).normalized;
}

function decisionOption(decision) {
  if (typeof decision === "string") return decision;
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) return null;
  const keys = Object.keys(decision);
  return keys.length === 1 ? keys[0] : null;
}

function createApprovalRelay({
  maxPending = DEFAULT_MAX_PENDING_APPROVALS
} = {}) {
  if (!Number.isInteger(maxPending) || maxPending < 1) {
    throw new TypeError("maxPending must be a positive integer");
  }
  const pending = new Map();
  // JSON-RPC permits an ID to be reused after its response. Only concurrent
  // reuse is ambiguous. The monotonically unique instance commitment gives a
  // later request a new public handle while an old handle remains retired.
  const pendingProviderIds = new Map();
  let nextRequestInstance = 1n;

  return Object.freeze({
    register(input) {
      const identity = canonicalApprovalIdentity(input, nextRequestInstance);
      if (pendingProviderIds.has(identity.providerKey)) {
        throw new Error("approval provider request ID is already pending");
      }
      if (pending.size >= maxPending) {
        throw new Error(`pending approval limit ${maxPending} reached`);
      }
      const requestId = identity.normalized.request_id;
      if (pending.has(requestId)) {
        throw new Error("approval public identity collision detected");
      }
      nextRequestInstance += 1n;
      pendingProviderIds.set(identity.providerKey, requestId);
      pending.set(requestId, {
        normalized: identity.normalized,
        providerKey: identity.providerKey,
        providerRequestId: identity.providerRequestId
      });
      return identity.normalized;
    },

    beginResponse({ requestId, method, threadId, turnId, correlationId, decision }) {
      const entry = pending.get(requestId);
      const normalized = entry?.normalized;
      if (!normalized
          || normalized.method !== method
          || normalized.thread_id !== threadId
          || normalized.turn_id !== turnId
          || normalized.correlation_id !== correlationId) {
        throw new Error("approval response does not match a pending request");
      }
      const option = decisionOption(decision);
      if (!normalized.response_options.includes(option)) {
        throw new Error(`approval response option is not allowed: ${option}`);
      }
      return deepFreeze({
        key: requestId,
        response: { id: entry.providerRequestId, result: { decision } }
      });
    },

    commitResponse(key) {
      const entry = pending.get(key);
      if (!entry) return;
      pending.delete(key);
      pendingProviderIds.delete(entry.providerKey);
    },

    consume(input) {
      const attempt = this.beginResponse(input);
      this.commitResponse(attempt.key);
      return attempt.response;
    },

    expireTurn(threadId, turnId) {
      let expired = 0;
      for (const [key, entry] of pending) {
        const approval = entry.normalized;
        if (approval.thread_id === threadId && approval.turn_id === turnId) {
          pending.delete(key);
          pendingProviderIds.delete(entry.providerKey);
          expired += 1;
        }
      }
      return expired;
    },

    pendingCount() {
      return pending.size;
    },

    reset() {
      const expired = [...pending.values()].map((entry) => entry.normalized);
      pending.clear();
      pendingProviderIds.clear();
      return deepFreeze(expired);
    }
  });
}

module.exports = {
  APPROVAL_IDENTITY_DOMAIN,
  APPROVAL_INSTANCE_DOMAIN,
  DEFAULT_MAX_PENDING_APPROVALS,
  EFFECT_KINDS,
  MAX_PROVIDER_STRING_ID_LENGTH,
  createApprovalRelay,
  normalizeApprovalRequest
};
