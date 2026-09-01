const TOOL_NAME = "orquesta_attachment_read";
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_REQUEST_IDS_PER_PROVIDER_CONNECTION = 65_536;

function bounded(value, maximum = 1024) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function requestKey(providerConnectionId, requestId) {
  const type = typeof requestId;
  if ((type !== "string" || !bounded(requestId))
      && (type !== "number" || !Number.isSafeInteger(requestId) || Object.is(requestId, -0))) {
    throw new TypeError("dynamic tool request ID is invalid");
  }
  return `${providerConnectionId.length}:${providerConnectionId}|${type}:${JSON.stringify(requestId)}`;
}

function turnKey(providerConnectionId, correlationId, threadId, turnId) {
  return [providerConnectionId, correlationId, threadId, turnId]
    .map((value) => `${value.length}:${value}`).join("|");
}

function reservationKey(providerConnectionId, correlationId, threadId) {
  return [providerConnectionId, correlationId, threadId]
    .map((value) => `${value.length}:${value}`).join("|");
}

function failure(code) {
  return {
    success: false,
    contentItems: [{ type: "inputText", text: String(code).slice(0, 256) }]
  };
}

function validResponse(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || typeof value.success !== "boolean" || !Array.isArray(value.contentItems)
      || value.contentItems.length > 8) return false;
  if (!value.contentItems.every((item) => item && typeof item === "object" && !Array.isArray(item)
    && item.type === "inputText" && typeof item.text === "string")) return false;
  return Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_RESPONSE_BYTES;
}

function createDynamicToolRelay({
  onDiagnostic = () => {},
  onProviderRetirementRequired = () => {},
  maxRequestIdsPerProviderConnection = MAX_REQUEST_IDS_PER_PROVIDER_CONNECTION
} = {}) {
  if (!Number.isInteger(maxRequestIdsPerProviderConnection) || maxRequestIdsPerProviderConnection < 1
    || maxRequestIdsPerProviderConnection > MAX_REQUEST_IDS_PER_PROVIDER_CONNECTION) {
    throw new TypeError("dynamic tool request ID capacity is invalid");
  }
  const turns = new Map();
  const reservations = new Map();
  const seenByProvider = new Map();
  const retiringProviders = new Set();

  function rememberRequest(providerConnectionId, key) {
    const seen = seenByProvider.get(providerConnectionId) ?? new Map();
    if (!seenByProvider.has(providerConnectionId)) seenByProvider.set(providerConnectionId, seen);
    const existing = seen.get(key);
    if (existing) {
      if (existing.status === "in_flight") existing.duplicate = true;
      return { accepted: false, state: existing };
    }
    if (seen.size >= maxRequestIdsPerProviderConnection) {
      return { accepted: false, capacityExhausted: true, state: null };
    }
    const state = { status: "in_flight", duplicate: false };
    seen.set(key, state);
    return { accepted: true, state };
  }

  function register({ providerConnectionId, correlationId, threadId, turnId, handler }) {
    if (![providerConnectionId, correlationId, threadId, turnId].every((value) => bounded(value))) {
      throw new TypeError("dynamic tool turn scope is invalid");
    }
    if (!handler || typeof handler.handle !== "function" || typeof handler.expire !== "function") {
      throw new TypeError("dynamic tool handler is invalid");
    }
    if (retiringProviders.has(providerConnectionId)) throw new Error("dynamic tool provider connection is retiring");
    const key = turnKey(providerConnectionId, correlationId, threadId, turnId);
    if (turns.has(key)) throw new Error("dynamic tool turn handler is already registered");
    turns.set(key, { providerConnectionId, correlationId, threadId, turnId, handler });
  }

  function reserve({ providerConnectionId, correlationId, threadId, handlerFactory }) {
    if (![providerConnectionId, correlationId, threadId].every((value) => bounded(value))
      || typeof handlerFactory !== "function") {
      throw new TypeError("dynamic tool reservation is invalid");
    }
    if (retiringProviders.has(providerConnectionId)) throw new Error("dynamic tool provider connection is retiring");
    if (typeof handlerFactory.preflight === "function") handlerFactory.preflight();
    const key = reservationKey(providerConnectionId, correlationId, threadId);
    if (reservations.has(key)) throw new Error("dynamic tool turn reservation is already registered");
    const entry = { providerConnectionId, correlationId, threadId, handlerFactory, state: "reserved" };
    reservations.set(key, entry);
    return Object.freeze({
      async commit(turnId) {
        if (entry.state !== "reserved" || reservations.get(key) !== entry || !bounded(turnId)) {
          throw new Error("dynamic tool reservation cannot be committed");
        }
        const exactKey = turnKey(providerConnectionId, correlationId, threadId, turnId);
        if (turns.has(exactKey)) {
          reservations.delete(key);
          entry.state = "failed";
          throw new Error("dynamic tool turn handler is already registered");
        }
        let handler = null;
        try {
          handler = handlerFactory({ providerConnectionId, correlationId, threadId, turnId });
          if (!handler || typeof handler.handle !== "function" || typeof handler.expire !== "function") {
            throw new TypeError("dynamic tool handler is invalid");
          }
          turns.set(exactKey, { providerConnectionId, correlationId, threadId, turnId, handler });
          reservations.delete(key);
          entry.state = "committed";
        } catch (error) {
          reservations.delete(key);
          entry.state = "failed";
          if (handler && typeof handler.expire === "function") {
            await Promise.resolve(handler.expire("registration_failed"));
          }
          throw error;
        }
      },
      cancel() {
        if (entry.state !== "reserved" || reservations.get(key) !== entry) return;
        reservations.delete(key);
        entry.state = "cancelled";
      }
    });
  }

  async function dispatch({ providerConnectionId, correlationId, message, respond }) {
    let idKey;
    try {
      if (!bounded(providerConnectionId) || typeof respond !== "function") {
        throw new TypeError("dynamic tool relay boundary is invalid");
      }
      idKey = requestKey(providerConnectionId, message?.id);
    } catch (error) {
      onDiagnostic({ type: "dynamic_tool_request_invalid", message: error.message });
      return;
    }
    if (retiringProviders.has(providerConnectionId)) {
      onDiagnostic({ type: "dynamic_tool_provider_connection_retiring", message: "dynamic tool request ignored on retiring connection" });
      return;
    }
    const admission = rememberRequest(providerConnectionId, idKey);
    if (admission.capacityExhausted) {
      retiringProviders.add(providerConnectionId);
      try {
        respond(message.id, failure("dynamic_tool_request_id_capacity_exhausted"));
      } catch (error) {
        onDiagnostic({ type: "dynamic_tool_response_write_failed", message: String(error?.message || error).slice(0, 256) });
      } finally {
        onProviderRetirementRequired(providerConnectionId, "dynamic_tool_request_id_capacity_exhausted");
      }
      return;
    }
    if (!admission.accepted) {
      onDiagnostic({ type: "dynamic_tool_request_duplicate", message: "duplicate dynamic tool request ID" });
      return;
    }

    let result = failure("attachment_read_scope_invalid");
    let onResponseWriteFailure = () => {};
    try {
      const params = message?.params;
      if (message?.method !== "item/tool/call" || !params || typeof params !== "object" || Array.isArray(params)
        || !bounded(params.threadId) || !bounded(params.turnId) || !bounded(params.callId)
        || params.tool !== TOOL_NAME || !Object.hasOwn(params, "arguments") || !bounded(correlationId)) {
        throw new Error("dynamic_tool_scope_invalid");
      }
      const entry = turns.get(turnKey(providerConnectionId, correlationId, params.threadId, params.turnId));
      if (!entry) throw new Error("dynamic_tool_handler_missing");
      const handled = await entry.handler.handle({
        method: message.method,
        tool: params.tool,
        arguments: params.arguments
      });
      if (!handled || !validResponse(handled.response)) throw new Error("dynamic_tool_response_invalid");
      result = handled.response;
      if (typeof handled.onResponseWriteFailure === "function") {
        onResponseWriteFailure = handled.onResponseWriteFailure;
      }
    } catch (error) {
      result = failure(error?.message || "attachment_read_failed");
    }

    if (admission.state.duplicate) {
      result = failure("dynamic_tool_request_duplicate");
      onResponseWriteFailure();
    }

    try {
      const outcome = respond(message.id, result);
      if (outcome?.overridden === true) onResponseWriteFailure();
    } catch (error) {
      onResponseWriteFailure();
      onDiagnostic({ type: "dynamic_tool_response_write_failed", message: String(error?.message || error).slice(0, 256) });
    } finally {
      admission.state.status = "settled";
    }
  }

  async function expireTurn(providerConnectionId, threadId, turnId, reason = "turn_terminal") {
    const expirations = [];
    for (const [key, entry] of turns) {
      if (entry.providerConnectionId === providerConnectionId
        && entry.threadId === threadId && entry.turnId === turnId) {
        turns.delete(key);
        expirations.push(Promise.resolve(entry.handler.expire(reason)));
      }
    }
    await Promise.all(expirations);
  }

  async function reset(providerConnectionId, reason = "provider_connection_lost") {
    const expirations = [];
    for (const [key, entry] of turns) {
      if (entry.providerConnectionId === providerConnectionId) {
        turns.delete(key);
        expirations.push(Promise.resolve(entry.handler.expire(reason)));
      }
    }
    for (const [key, entry] of reservations) {
      if (entry.providerConnectionId === providerConnectionId) {
        reservations.delete(key);
        entry.state = "cancelled";
      }
    }
    seenByProvider.delete(providerConnectionId);
    retiringProviders.delete(providerConnectionId);
    await Promise.all(expirations);
  }

  return Object.freeze({ dispatch, expireTurn, register, reserve, reset });
}

module.exports = { MAX_REQUEST_IDS_PER_PROVIDER_CONNECTION, TOOL_NAME, createDynamicToolRelay };
