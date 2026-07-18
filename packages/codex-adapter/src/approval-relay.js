const schema = require("../protocol/app-server-schema.json");
const { deepFreeze } = require("./contract");

const EFFECT_KINDS = Object.freeze({
  "item/commandExecution/requestApproval": "command_execution",
  "item/fileChange/requestApproval": "file_change"
});

function nonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function requestId(value) {
  if ((typeof value !== "string" && typeof value !== "number")
      || (typeof value === "string" && value.trim() === "")
      || (typeof value === "number" && !Number.isFinite(value))) {
    throw new TypeError("approval request ID must be a string or finite number");
  }
  return value;
}

function normalizeApprovalRequest({ message, correlationId, threadId, turnId }) {
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

  const effect = {
    kind: EFFECT_KINDS[method],
    item_id: nonEmptyString(params.itemId, "approval item ID")
  };
  return deepFreeze({
    request_id: requestId(message.id),
    method,
    thread_id: boundThreadId,
    turn_id: boundTurnId,
    correlation_id: nonEmptyString(correlationId, "approval correlation ID"),
    reason: typeof params.reason === "string" && params.reason !== ""
      ? "[redacted approval reason]"
      : null,
    requested_effect: effect,
    response_options: [...definition.response_options]
  });
}

function decisionOption(decision) {
  if (typeof decision === "string") return decision;
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) return null;
  const keys = Object.keys(decision);
  return keys.length === 1 ? keys[0] : null;
}

function createApprovalRelay() {
  const pending = new Map();

  return Object.freeze({
    register(input) {
      const normalized = normalizeApprovalRequest(input);
      if (pending.has(normalized.request_id)) {
        throw new Error(`duplicate pending approval request ID: ${normalized.request_id}`);
      }
      pending.set(normalized.request_id, normalized);
      return normalized;
    },

    consume({ requestId: id, method, threadId, turnId, correlationId, decision }) {
      const normalized = pending.get(id);
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
      pending.delete(id);
      return deepFreeze({ id, result: { decision } });
    },

    pendingCount() {
      return pending.size;
    },

    reset() {
      pending.clear();
    }
  });
}

module.exports = {
  EFFECT_KINDS,
  createApprovalRelay,
  normalizeApprovalRequest
};
