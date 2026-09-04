const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const schema = require("../protocol/app-server-schema.json");
const {
  ADAPTER_PACKAGE,
  CAPABILITY_METHODS,
  createAdapterFailure,
  deepFreeze,
  defineCodexAdapter
} = require("./contract");
const { createApprovalRelay } = require("./approval-relay");
const { createDynamicToolRelay } = require("./dynamic-tool-relay");
const { createJsonlTransport } = require("./jsonl-transport");
const { createModelEvidence } = require("./model-evidence");
const { normalizeAppServerFrame } = require("./provider-contract");
const { resolveBundledCodexRuntime } = require("./runtime-path");

const APP_SERVER_MAX_LINE_BYTES = 64 * 1024 * 1024;
const MAX_ORPHAN_RUNTIME_FRAMES = 256;

const APP_SERVER_CAPABILITIES = Object.freeze({
  createThread: true,
  resumeThread: true,
  setThreadName: true,
  archiveThread: true,
  listThreads: true,
  startTurn: true,
  steerTurn: true,
  interruptTurn: true,
  respondToApproval: true,
  subscribeEvents: true,
  readActualModel: false,
  readThread: true,
  listThreadTurns: true,
  readAccount: true,
  startLogin: true,
  runtimeInfo: true,
  shutdown: true
});

class RuntimeUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "RuntimeUnavailableError";
  }
}

function requireFields(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`schema validation failed: ${label} must be an object`);
  }
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) {
      throw new Error(`schema validation failed: ${label} missing ${field}`);
    }
  }
}

function validateRequest(method, params) {
  const definition = schema.client_requests[method];
  if (!definition) throw new Error(`schema validation failed: unsupported method ${method}`);
  requireFields(params, definition.params_required, `${method} params`);
}

function validateResponse(method, result) {
  const definition = schema.client_requests[method];
  requireFields(result, definition.response_required, `${method} response`);
}

function normalizeSandboxMode(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.type === "readOnly") return "read-only";
  if (value.type === "workspaceWrite") return "workspace-write";
  if (value.type === "dangerFullAccess") return "danger-full-access";
  if (value.type === "externalSandbox") return "external-sandbox";
  return null;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    return null;
  }
  return value.map((entry) => entry.trim());
}

function validateServerMessage(collection, message, label) {
  const definition = collection[message?.method];
  if (!definition) throw new Error(`schema validation failed: unsupported ${label} ${message?.method}`);
  requireFields(message, definition.required, label);
  if (definition.params_required) {
    requireFields(message.params, definition.params_required, `${message.method} params`);
  }
  return definition;
}

function findInstalledSdkPackageRoot() {
  for (const nodeModulesRoot of module.paths) {
    const candidate = path.join(nodeModulesRoot, "@openai", "codex-sdk");
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error("installed @openai/codex-sdk package root was not found");
}

function createAppServerAdapter({
  resolveRuntime = resolveBundledCodexRuntime,
  sdkPackageRoot = null,
  spawnProcess = spawn,
  transportFactory = createJsonlTransport,
  maxLineBytes = APP_SERVER_MAX_LINE_BYTES,
  onDiagnostic = () => {},
  providerStreamIdFactory = () => `provider_${randomUUID()}`,
  dynamicToolRequestIdCapacity = undefined,
  providerRetirementTimeoutMs = 1_500
} = {}) {
  const eventListeners = new Set();
  const activeTurns = new Map();
  const threadCorrelations = new Map();
  const pendingThreadCorrelations = new Set();
  const pendingTurnStarts = new Map();
  const orphanThreadFrames = new Map();
  const orphanTurnFrames = new Map();
  const orphanOverflowThreads = new Set();
  const orphanOverflowProviders = new Set();
  const approvalRelay = createApprovalRelay();
  const dynamicToolRelay = createDynamicToolRelay({
    onDiagnostic,
    ...(dynamicToolRequestIdCapacity === undefined
      ? {}
      : { maxRequestIdsPerProviderConnection: dynamicToolRequestIdCapacity }),
    onProviderRetirementRequired: (providerConnectionId, reason) => {
      beginProviderRetirement(providerConnectionId, reason);
    }
  });
  let currentProviderStreamId = null;
  let orphanFrameCount = 0;
  let pendingThreadCreates = 0;
  let transport = null;
  let initializePromise = null;
  let initializeResult = null;
  let resolvedRuntime = null;
  let providerRetirementPromise = null;
  let modelCatalog = null;
  let modelCatalogPromise = null;

  function beginProviderRetirement(providerConnectionId, reason) {
    if (providerConnectionId !== currentProviderStreamId || !transport || providerRetirementPromise) return;
    const connection = transport;
    emitEvent({ type: "provider_connection", provider_connection_id: providerConnectionId, state: "disconnected" });
    providerRetirementPromise = (async () => {
      await connection.shutdown({ timeoutMs: providerRetirementTimeoutMs });
      await dynamicToolRelay.reset(providerConnectionId, reason);
      const expiredApprovals = approvalRelay.reset();
      for (const approval of expiredApprovals) {
        emitEvent({
          type: "approval_expired",
          thread_id: approval.thread_id,
          turn_id: approval.turn_id,
          correlation_id: approval.correlation_id,
          request_id: approval.request_id,
          reason
        });
      }
      if (transport === connection) {
        activeTurns.clear();
        threadCorrelations.clear();
        pendingThreadCorrelations.clear();
        pendingTurnStarts.clear();
        pendingThreadCreates = 0;
        clearOrphanFrames();
        orphanOverflowThreads.clear();
        orphanOverflowProviders.delete(providerConnectionId);
        transport = null;
        currentProviderStreamId = null;
        initializePromise = null;
        initializeResult = null;
        modelCatalog = null;
        modelCatalogPromise = null;
      }
    })().catch((error) => {
      onDiagnostic({ type: "provider_retirement_failed", message: String(error?.message || error).slice(0, 256) });
      throw error;
    });
    void providerRetirementPromise.catch(() => undefined);
  }

  function threadKeyPrefix(threadId) {
    if (typeof threadId !== "string") throw new Error("runtime thread ID must be a string");
    return `${threadId.length}:${threadId}|`;
  }

  function turnKey(threadId, turnId) {
    if (typeof turnId !== "string") throw new Error("runtime turn ID must be a string");
    return `${threadKeyPrefix(threadId)}${turnId.length}:${turnId}`;
  }

  function queueOrphanFrame(store, key, frame) {
    if (orphanFrameCount >= MAX_ORPHAN_RUNTIME_FRAMES) {
      throw new Error(`orphan runtime frame limit ${MAX_ORPHAN_RUNTIME_FRAMES} reached`);
    }
    const frames = store.get(key) ?? [];
    frames.push(frame);
    store.set(key, frames);
    orphanFrameCount += 1;
  }

  function takeOrphanFrames(store, key) {
    const frames = store.get(key) ?? [];
    store.delete(key);
    orphanFrameCount -= frames.length;
    return frames;
  }

  function clearOrphanFrames() {
    orphanThreadFrames.clear();
    orphanTurnFrames.clear();
    orphanFrameCount = 0;
  }

  function discardAllThreadOrphans() {
    for (const frames of orphanThreadFrames.values()) orphanFrameCount -= frames.length;
    orphanThreadFrames.clear();
  }

  function hasPendingTurnStart(threadId) {
    return (pendingTurnStarts.get(threadId) ?? 0) > 0;
  }

  function beginPendingTurnStart(threadId) {
    pendingTurnStarts.set(threadId, (pendingTurnStarts.get(threadId) ?? 0) + 1);
  }

  function endPendingTurnStart(threadId) {
    const remaining = (pendingTurnStarts.get(threadId) ?? 1) - 1;
    if (remaining > 0) pendingTurnStarts.set(threadId, remaining);
    else pendingTurnStarts.delete(threadId);
  }

  async function discardTurnOrphans(threadId, retainedKey = null) {
    const prefix = threadKeyPrefix(threadId);
    const drains = [];
    for (const [key, frames] of orphanTurnFrames) {
      if (key !== retainedKey && key.startsWith(prefix)) {
        orphanTurnFrames.delete(key);
        orphanFrameCount -= frames.length;
        for (const frame of frames) {
          if (frame.kind === "server_request" && frame.message?.method === "item/tool/call") {
            const connection = transport;
            drains.push(dynamicToolRelay.dispatch({
              providerConnectionId: currentProviderStreamId,
              correlationId: null,
              message: frame.message,
              respond: (id, result) => connection.respond(id, result)
            }));
          }
        }
      }
    }
    await Promise.all(drains);
  }

  async function drainDynamicOrphansForRetirement(connection, providerConnectionId) {
    const drains = [];
    for (const [key, frames] of orphanTurnFrames) {
      orphanTurnFrames.delete(key);
      orphanFrameCount -= frames.length;
      for (const frame of frames) {
        if (frame.kind === "server_request" && frame.message?.method === "item/tool/call") {
          drains.push(dynamicToolRelay.dispatch({
            providerConnectionId,
            correlationId: null,
            message: frame.message,
            respond: (id, result) => connection.respond(id, result)
          }));
        }
      }
    }
    await Promise.all(drains);
  }

  function handleDynamicOrphanOverflow(message, threadId, turnId) {
    const connection = transport;
    const providerConnectionId = currentProviderStreamId;
    if (!connection || !providerConnectionId) return;
    orphanOverflowProviders.add(providerConnectionId);
    orphanOverflowThreads.add(threadId);
    void (async () => {
      await dynamicToolRelay.dispatch({
        providerConnectionId,
        correlationId: null,
        message,
        respond: (id, result) => connection.respond(id, result)
      });
      await drainDynamicOrphansForRetirement(connection, providerConnectionId);
      beginProviderRetirement(providerConnectionId, "dynamic_tool_orphan_capacity_exhausted");
    })().catch((error) => {
      onDiagnostic({
        type: "dynamic_tool_orphan_retirement_failed",
        message: String(error?.message || error).slice(0, 256)
      });
      beginProviderRetirement(providerConnectionId, "dynamic_tool_orphan_capacity_exhausted");
    });
  }

  function emitEvent(event) {
    const frozen = deepFreeze({ adapter: "app_server", ...event });
    for (const listener of eventListeners) {
      try {
        listener(frozen);
      } catch (error) {
        onDiagnostic({ type: "event_listener_error", message: error.message });
      }
    }
  }

  function success(operation, correlationId, fields = {}) {
    return deepFreeze({
      ok: true,
      status: "completed",
      adapter: "app_server",
      operation,
      correlation_id: correlationId,
      thread_id: null,
      turn_id: null,
      approval_id: null,
      actual_model: null,
      ...fields
    });
  }

  function failure(operation, correlationId, error, evidence = {}) {
    const unavailable = error instanceof RuntimeUnavailableError;
    const dispatchAccepted = error?.dispatchAccepted === true;
    const outcomeUnknown = dispatchAccepted || error?.outcomeUnknown === true;
    return createAdapterFailure({
      adapter: "app_server",
      status: unavailable ? "unavailable" : "failed",
      correlationId,
      operation,
      code: unavailable
        ? "runtime_unavailable"
        : outcomeUnknown
          ? "runtime_outcome_unknown"
          : typeof error?.code === "string" && error.code
            ? error.code
            : "runtime_failed",
      message: error.message,
      threadId: dispatchAccepted ? error.threadId : null,
      turnId: dispatchAccepted ? error.turnId : null,
      evidence: {
        dispatch_accepted: dispatchAccepted,
        turn_started: false,
        actual_model: null,
        ...(typeof error.approval_response_phase === "string"
          ? { approval_response_phase: error.approval_response_phase }
          : {}),
        ...evidence
      }
    });
  }

  function resolveRuntimeResult() {
    if (resolvedRuntime) return resolvedRuntime;
    try {
      let resolvedSdkPackageRoot = sdkPackageRoot;
      if (!resolvedSdkPackageRoot) {
        try {
          resolvedSdkPackageRoot = findInstalledSdkPackageRoot();
        } catch (error) {
          if (resolveRuntime === resolveBundledCodexRuntime) throw error;
        }
      }
      const resolverInput = resolvedSdkPackageRoot ? { sdkPackageRoot: resolvedSdkPackageRoot } : {};
      const resolved = resolveRuntime(resolverInput);
      if (!resolved || typeof resolved !== "object" || Array.isArray(resolved)
          || typeof resolved.executable_path !== "string"
          || resolved.executable_path.trim() === "") {
        throw new Error("bundled runtime result must contain executable_path");
      }
      resolvedRuntime = deepFreeze({ ...resolved });
      return resolvedRuntime;
    } catch (error) {
      throw new RuntimeUnavailableError(
        `pinned bundled Codex runtime is unavailable: ${error.message}`
      );
    }
  }

  async function handleNotification(message) {
    try {
      if (!schema.server_notifications[message?.method]) {
        onDiagnostic({
          type: "ignored_server_notification",
          method: typeof message?.method === "string" ? message.method.slice(0, 256) : "unknown"
        });
        return;
      }
      validateServerMessage(schema.server_notifications, message, "server notification");
      const params = message.params;
      if (message.method === "account/updated") {
        emitEvent({
          type: "account_updated",
          auth_mode: params.authMode ?? null,
          plan_type: params.planType ?? null
        });
        return;
      }
      if (message.method === "account/login/completed") {
        emitEvent({
          type: "account_login_completed",
          login_id: params.loginId ?? null,
          success: params.success,
          error: params.error ?? null
        });
        return;
      }
      if (message.method === "thread/started") {
        if (pendingThreadCorrelations.has(params.thread.id) || pendingThreadCreates > 0) {
          queueOrphanFrame(orphanThreadFrames, params.thread.id, { kind: "notification", message });
          return;
        }
        const correlationId = threadCorrelations.get(params.thread.id);
        if (correlationId) {
          emitEvent({
            type: "thread_started",
            correlation_id: correlationId,
            thread_id: params.thread.id,
            turn_id: null
          });
        }
        return;
      }

      const turnId = params.turn?.id || params.turnId;
      const key = turnKey(params.threadId, turnId);
      const correlationId = activeTurns.get(key);
      if (!correlationId) {
        if (hasPendingTurnStart(params.threadId)) {
          queueOrphanFrame(orphanTurnFrames, key, { kind: "notification", message });
        } else {
          onDiagnostic({ type: "ignored_unbound_turn_notification", method: message.method });
        }
        return;
      }

      if (message.method === "turn/started") {
        emitEvent({
          type: "turn_started",
          correlation_id: correlationId,
          thread_id: params.threadId,
          turn_id: turnId
        });
      } else if (message.method === "model/rerouted") {
        emitEvent({
          type: "model_observed",
          correlation_id: correlationId,
          thread_id: params.threadId,
          turn_id: turnId,
          model: params.toModel,
          source_event: message.method
        });
      } else if (message.method === "item/started" || message.method === "item/completed") {
        emitEvent({
          type: "progress_observed",
          event_method: message.method,
          correlation_id: correlationId,
          thread_id: params.threadId,
          turn_id: turnId,
          item_id: params.item?.id || null
        });
      } else if (message.method === "turn/completed") {
        approvalRelay.expireTurn(params.threadId, turnId);
        await dynamicToolRelay.expireTurn(currentProviderStreamId, params.threadId, turnId, "turn_terminal");
        emitEvent({
          type: "turn_completed",
          correlation_id: correlationId,
          thread_id: params.threadId,
          turn_id: turnId,
          status: params.turn.status
        });
        activeTurns.delete(turnKey(params.threadId, turnId));
      } else if (message.method === "error") {
        if (params.willRetry !== true) {
          approvalRelay.expireTurn(params.threadId, turnId);
          await dynamicToolRelay.expireTurn(currentProviderStreamId, params.threadId, turnId, "turn_failed");
          activeTurns.delete(key);
        }
        emitEvent({
          type: "runtime_error",
          correlation_id: correlationId,
          thread_id: params.threadId,
          turn_id: turnId,
          will_retry: params.willRetry
        });
      }
    } catch (error) {
      transport?.close(error.message);
    }
  }

  function handleServerRequest(message) {
    if (message?.method === "item/tool/call") {
      const params = message?.params;
      const threadId = typeof params?.threadId === "string" ? params.threadId : null;
      const turnId = typeof params?.turnId === "string" ? params.turnId : null;
      if (currentProviderStreamId && orphanOverflowProviders.has(currentProviderStreamId)) {
        const connection = transport;
        return dynamicToolRelay.dispatch({
          providerConnectionId: currentProviderStreamId,
          correlationId: null,
          message,
          respond: (id, result) => connection.respond(id, result)
        });
      }
      if (threadId && turnId && hasPendingTurnStart(threadId)) {
        try {
          queueOrphanFrame(orphanTurnFrames, turnKey(threadId, turnId), { kind: "server_request", message });
        } catch (error) {
          if (!String(error?.message || error).includes("orphan runtime frame limit")) throw error;
          handleDynamicOrphanOverflow(message, threadId, turnId);
        }
        return;
      }
      const correlationId = threadId && turnId ? activeTurns.get(turnKey(threadId, turnId)) ?? null : null;
      const connection = transport;
      return dynamicToolRelay.dispatch({
        providerConnectionId: currentProviderStreamId,
        correlationId,
        message,
        respond: (id, result) => connection.respond(id, result)
      });
    }
    try {
      validateServerMessage(schema.server_requests, message, "server request");
      const correlationId = activeTurns.get(
        turnKey(message.params.threadId, message.params.turnId)
      );
      if (!correlationId) {
        if (hasPendingTurnStart(message.params.threadId)) {
          queueOrphanFrame(
            orphanTurnFrames,
            turnKey(message.params.threadId, message.params.turnId),
            { kind: "server_request", message }
          );
        } else {
          onDiagnostic({ type: "ignored_unbound_server_request", method: message.method });
        }
        return;
      }
      const request = approvalRelay.register({
        message,
        correlationId,
        threadId: message.params.threadId,
        turnId: message.params.turnId
      });
      emitEvent({
        type: "approval_requested",
        provider_connection_id: currentProviderStreamId,
        correlation_id: request.correlation_id,
        thread_id: request.thread_id,
        turn_id: request.turn_id,
        request_id: request.request_id,
        request_instance_id: request.request_instance_id,
        method: request.method,
        reason: request.reason,
        requested_effect: request.requested_effect,
        response_options: request.response_options
      });
    } catch (error) {
      transport?.close(error.message);
    }
  }

  async function flushOrphanFrames(store, key) {
    for (const frame of takeOrphanFrames(store, key)) {
      if (frame.kind === "notification") await handleNotification(frame.message);
      else await Promise.resolve(handleServerRequest(frame.message));
    }
  }

  function startTransport() {
    if (transport) return transport;
    const runtime = resolveRuntimeResult();
    let child;
    try {
      child = spawnProcess(runtime.executable_path, ["app-server"], {
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (error) {
      throw new RuntimeUnavailableError(`failed to spawn Codex App Server: ${error.message}`);
    }
    const providerStreamId = providerStreamIdFactory();
    currentProviderStreamId = providerStreamId;
    let providerSequence = 0;
    let connection = null;
    connection = transportFactory({
      process: child,
      maxLineBytes,
      onDiagnostic,
      onProtocolError: () => {
        if (transport !== connection) return;
        emitEvent({ type: "provider_connection", provider_connection_id: providerStreamId, state: "disconnected" });
        void dynamicToolRelay.reset(providerStreamId, "provider_connection_lost");
        const expiredApprovals = approvalRelay.reset();
        for (const approval of expiredApprovals) {
          emitEvent({
            type: "approval_expired",
            thread_id: approval.thread_id,
            turn_id: approval.turn_id,
            correlation_id: approval.correlation_id,
            request_id: approval.request_id,
            reason: "provider_connection_lost"
          });
        }
        // Never replay an operation whose provider outcome is unknown. Retire only the failed
        // connection so the caller observes that failure and a later, explicit operation can
        // initialize a fresh App Server process.
        activeTurns.clear();
        threadCorrelations.clear();
        pendingThreadCorrelations.clear();
        pendingTurnStarts.clear();
        pendingThreadCreates = 0;
        clearOrphanFrames();
        orphanOverflowThreads.clear();
        orphanOverflowProviders.delete(providerStreamId);
        transport = null;
        currentProviderStreamId = null;
        initializePromise = null;
        initializeResult = null;
      },
      onFrame: ({ direction, frame, request }) => {
        const providerEvent = normalizeAppServerFrame({
          streamId: providerStreamId,
          direction,
          frame,
          request,
          sequence: ++providerSequence
        });
        emitEvent({
          type: "provider_event",
          thread_id: providerEvent.scope.thread_id,
          turn_id: providerEvent.scope.turn_id,
          provider_event: providerEvent
        });
      }
    });
    transport = connection;
    transport.onNotification((message) => { void handleNotification(message); });
    transport.onServerRequest((message) => {
      try {
        void Promise.resolve(handleServerRequest(message)).catch((error) => {
          onDiagnostic({ type: "server_request_listener_failed", message: String(error?.message || error).slice(0, 256) });
          beginProviderRetirement(providerStreamId, "server_request_listener_failed");
        });
      } catch (error) {
        onDiagnostic({ type: "server_request_listener_failed", message: String(error?.message || error).slice(0, 256) });
        beginProviderRetirement(providerStreamId, "server_request_listener_failed");
      }
    });
    return transport;
  }

  async function ensureInitialized() {
    if (providerRetirementPromise) {
      const retirement = providerRetirementPromise;
      await retirement;
      if (providerRetirementPromise === retirement) providerRetirementPromise = null;
    }
    if (!initializePromise) {
      initializePromise = (async () => {
        const connection = startTransport();
        const params = {
          clientInfo: {
            name: "orquesta",
            title: "Orquesta",
            version: "0.5.0-next.0"
          },
          capabilities: { experimentalApi: true }
        };
        validateRequest("initialize", params);
        const result = await connection.request("initialize", params);
        validateResponse("initialize", result);
        connection.notify("initialized");
        if (transport !== connection || !currentProviderStreamId) {
          throw new RuntimeUnavailableError("Provider connection changed during initialization");
        }
        initializeResult = deepFreeze({ ...result });
        emitEvent({ type: "provider_connection", provider_connection_id: currentProviderStreamId, state: "connected" });
        return initializeResult;
      })();
    }
    return initializePromise;
  }

  async function run(operation, correlationId, action) {
    try {
      return await action();
    } catch (error) {
      return failure(operation, correlationId, error);
    }
  }

  async function readModelCatalog() {
    if (modelCatalog) return modelCatalog;
    if (!modelCatalogPromise) {
      modelCatalogPromise = (async () => {
        const models = [];
        let cursor = null;
        do {
          const params = { includeHidden: false, limit: 100, ...(cursor ? { cursor } : {}) };
          validateRequest("model/list", params);
          const result = await transport.request("model/list", params);
          validateResponse("model/list", result);
          for (const candidate of result.data) {
            if (!candidate || typeof candidate !== "object" || candidate.hidden === true
              || typeof candidate.id !== "string" || candidate.id === ""
              || typeof candidate.displayName !== "string" || candidate.displayName === ""
              || typeof candidate.isDefault !== "boolean"
              || typeof candidate.defaultReasoningEffort !== "string" || candidate.defaultReasoningEffort === ""
              || !Array.isArray(candidate.supportedReasoningEfforts)
              || !Array.isArray(candidate.serviceTiers)) {
              throw new Error("schema validation failed: model/list returned an invalid model entry");
            }
            const supportedReasoningEfforts = candidate.supportedReasoningEfforts.map((entry) => {
              if (!entry || typeof entry !== "object"
                || typeof entry.reasoningEffort !== "string" || entry.reasoningEffort === ""
                || typeof entry.description !== "string") {
                throw new Error("schema validation failed: model/list returned an invalid reasoning effort");
              }
              return { effort: entry.reasoningEffort, description: entry.description };
            });
            const serviceTiers = candidate.serviceTiers.map((entry) => {
              if (!entry || typeof entry !== "object"
                || typeof entry.id !== "string" || entry.id === ""
                || typeof entry.name !== "string" || entry.name === ""
                || typeof entry.description !== "string") {
                throw new Error("schema validation failed: model/list returned an invalid service tier");
              }
              return { id: entry.id, name: entry.name, description: entry.description };
            });
            models.push({
              id: candidate.id,
              displayName: candidate.displayName,
              isDefault: candidate.isDefault,
              defaultReasoningEffort: candidate.defaultReasoningEffort,
              supportedReasoningEfforts,
              serviceTiers
            });
          }
          cursor = typeof result.nextCursor === "string" && result.nextCursor !== "" ? result.nextCursor : null;
          if (models.length > 128) throw new Error("schema validation failed: model/list exceeded the desktop model limit");
        } while (cursor);
        modelCatalog = deepFreeze(models);
        return modelCatalog;
      })().catch((error) => {
        modelCatalogPromise = null;
        throw error;
      });
    }
    return modelCatalogPromise;
  }

  const methods = {
    capabilities: ({ correlationId }) => success("capabilities", correlationId, {
      capabilities: { ...APP_SERVER_CAPABILITIES }
    }),

    createThread: ({
      correlationId,
      recommendedModel,
      requestedModel,
      params = {}
    }) => run(
      "createThread",
      correlationId,
      async () => {
        await ensureInitialized();
        validateRequest("thread/start", params);
        pendingThreadCreates += 1;
        let pendingCreate = true;
        try {
          const result = await transport.request("thread/start", params);
          validateResponse("thread/start", result);
          if (typeof result.thread?.id !== "string" || result.thread.id === "") {
            throw new Error("schema validation failed: thread/start response missing thread.id");
          }
          threadCorrelations.set(result.thread.id, correlationId);
          pendingThreadCreates -= 1;
          pendingCreate = false;
          await flushOrphanFrames(orphanThreadFrames, result.thread.id);
          if (pendingThreadCreates === 0) discardAllThreadOrphans();
          return success("createThread", correlationId, {
            thread_id: result.thread.id,
            provider_connection_id: currentProviderStreamId,
            applied_model: result.model ?? null,
            runtime_profile: {
              cwd: result.cwd ?? null,
              runtime_workspace_roots: normalizeStringArray(result.runtimeWorkspaceRoots),
              instruction_sources: normalizeStringArray(result.instructionSources),
              sandbox: normalizeSandboxMode(result.sandbox),
              approval_policy: result.approvalPolicy ?? null,
              requested_web_search_mode: params.webSearchMode ?? null
            },
            model_evidence: createModelEvidence({
              recommended: recommendedModel,
              requested: requestedModel ?? params.model,
              applied: result.model
            })
          });
        } catch (error) {
          if (pendingCreate) {
            pendingThreadCreates -= 1;
            if (pendingThreadCreates === 0) discardAllThreadOrphans();
          }
          throw error;
        }
      }
    ),

    resumeThread: ({
      correlationId,
      threadId,
      recommendedModel,
      requestedModel,
      params = {}
    }) => run(
      "resumeThread",
      correlationId,
      async () => {
        await ensureInitialized();
        const requestParams = { ...params, threadId };
        validateRequest("thread/resume", requestParams);
        pendingThreadCorrelations.add(threadId);
        let pendingCorrelation = true;
        try {
          const result = await transport.request("thread/resume", requestParams);
          validateResponse("thread/resume", result);
          if (typeof result.thread?.id !== "string" || result.thread.id === "") {
            throw new Error("schema validation failed: thread/resume response missing thread.id");
          }
          threadCorrelations.set(result.thread.id, correlationId);
          pendingThreadCorrelations.delete(threadId);
          pendingCorrelation = false;
          await flushOrphanFrames(orphanThreadFrames, result.thread.id);
          return success("resumeThread", correlationId, {
            thread_id: result.thread.id,
            provider_connection_id: currentProviderStreamId,
            applied_model: result.model ?? null,
            runtime_profile: {
              cwd: result.cwd ?? null,
              runtime_workspace_roots: normalizeStringArray(result.runtimeWorkspaceRoots),
              instruction_sources: normalizeStringArray(result.instructionSources),
              sandbox: normalizeSandboxMode(result.sandbox),
              approval_policy: result.approvalPolicy ?? null,
              requested_web_search_mode: params.webSearchMode ?? null
            },
            model_evidence: createModelEvidence({
              recommended: recommendedModel,
              requested: requestedModel ?? params.model,
              applied: result.model
            })
          });
        } catch (error) {
          if (pendingCorrelation) {
            pendingThreadCorrelations.delete(threadId);
            takeOrphanFrames(orphanThreadFrames, threadId);
          }
          throw error;
        }
      }
    ),

    setThreadName: ({ correlationId, threadId, name }) => run(
      "setThreadName",
      correlationId,
      async () => {
        await ensureInitialized();
        const params = { threadId, name };
        validateRequest("thread/name/set", params);
        const result = await transport.request("thread/name/set", params);
        validateResponse("thread/name/set", result);
        return success("setThreadName", correlationId, {
          thread_id: threadId,
          name
        });
      }
    ),

    archiveThread: ({ correlationId, threadId }) => run(
      "archiveThread",
      correlationId,
      async () => {
        await ensureInitialized();
        const params = { threadId };
        validateRequest("thread/archive", params);
        const result = await transport.request("thread/archive", params);
        validateResponse("thread/archive", result);
        return success("archiveThread", correlationId, {
          thread_id: threadId
        });
      }
    ),

    listThreads: ({ correlationId, params = {} }) => run(
      "listThreads",
      correlationId,
      async () => {
        await ensureInitialized();
        validateRequest("thread/list", params);
        const result = await transport.request("thread/list", params);
        validateResponse("thread/list", result);
        return success("listThreads", correlationId, {
          threads: result.data,
          next_cursor: result.nextCursor ?? null,
          backwards_cursor: result.backwardsCursor ?? null
        });
      }
    ),

    startTurn: ({ correlationId, threadId, input, params = {}, dynamicToolHandlerFactory = null }) => run(
      "startTurn",
      correlationId,
      async () => {
        await ensureInitialized();
        if (!threadCorrelations.has(threadId)) {
          const error = new Error("thread is not loaded in the current Provider connection");
          error.code = "thread_not_loaded_in_provider_connection";
          throw error;
        }
        const requestParams = { ...params, input, threadId };
        validateRequest("turn/start", requestParams);
        let toolReservation = null;
        if (typeof dynamicToolHandlerFactory === "function") {
          try {
            toolReservation = dynamicToolRelay.reserve({
              providerConnectionId: currentProviderStreamId,
              correlationId,
              threadId,
              handlerFactory: dynamicToolHandlerFactory
            });
          } catch (error) {
            const candidate = String(error?.message || error);
            error.code = /^attachment_[a-z0-9_]{1,127}$/u.test(candidate)
              ? candidate
              : "attachment_dynamic_tool_preflight_failed";
            throw error;
          }
        }
        beginPendingTurnStart(threadId);
        let pendingStart = true;
        let acceptedReceipt = null;
        try {
          const result = await transport.request("turn/start", requestParams);
          validateResponse("turn/start", result);
          if (typeof result.turn?.id !== "string" || result.turn.id === "") {
            throw new Error("schema validation failed: turn/start response missing turn.id");
          }
          const activeTurnKey = turnKey(threadId, result.turn.id);
          acceptedReceipt = { threadId, turnId: result.turn.id };
          if (orphanOverflowThreads.has(threadId)) {
            throw new Error("dynamic_tool_orphan_capacity_exhausted");
          }
          // Commit the causal identity before releasing the pending-start marker.
          // The JSONL transport yields after each frame, so a coalesced frame which
          // follows the response cannot observe a half-committed active turn.
          if (activeTurns.has(activeTurnKey)) {
            throw new Error("Provider returned a turn identity that is already active");
          }
          activeTurns.set(activeTurnKey, correlationId);
          if (toolReservation) await toolReservation.commit(result.turn.id);
          endPendingTurnStart(threadId);
          pendingStart = false;
          emitEvent({
            type: "dispatch_accepted",
            correlation_id: correlationId,
            thread_id: threadId,
            turn_id: result.turn.id
          });
          await flushOrphanFrames(orphanTurnFrames, activeTurnKey);
          if (!hasPendingTurnStart(threadId)) {
            await discardTurnOrphans(threadId, activeTurnKey);
          }
          return success("startTurn", correlationId, {
            thread_id: threadId,
            turn_id: result.turn.id,
            evidence: {
              dispatch_accepted: true,
              turn_started: false,
              actual_model: null
            }
          });
        } catch (error) {
          toolReservation?.cancel();
          if (!acceptedReceipt && orphanOverflowThreads.has(threadId)) error.outcomeUnknown = true;
          orphanOverflowThreads.delete(threadId);
          if (pendingStart) {
            endPendingTurnStart(threadId);
            if (!hasPendingTurnStart(threadId)) await discardTurnOrphans(threadId);
          }
          if (acceptedReceipt) {
            error.dispatchAccepted = true;
            error.threadId = acceptedReceipt.threadId;
            error.turnId = acceptedReceipt.turnId;
          }
          throw error;
        }
      }
    ),

    steerTurn: ({ correlationId, threadId, turnId, input }) => run(
      "steerTurn",
      correlationId,
      async () => {
        await ensureInitialized();
        const params = { expectedTurnId: turnId, input, threadId };
        validateRequest("turn/steer", params);
        const result = await transport.request("turn/steer", params);
        validateResponse("turn/steer", result);
        return success("steerTurn", correlationId, {
          thread_id: threadId,
          turn_id: result.turnId
        });
      }
    ),

    interruptTurn: ({ correlationId, threadId, turnId }) => run(
      "interruptTurn",
      correlationId,
      async () => {
        await ensureInitialized();
        const params = { threadId, turnId };
        validateRequest("turn/interrupt", params);
        const result = await transport.request("turn/interrupt", params);
        validateResponse("turn/interrupt", result);
        return success("interruptTurn", correlationId, {
          thread_id: threadId,
          turn_id: turnId
        });
      }
    ),

    respondToApproval: ({
      correlationId,
      requestId,
      method,
      threadId,
      turnId,
      decision
    }) => run("respondToApproval", correlationId, async () => {
      let attempt;
      try {
        attempt = approvalRelay.beginResponse({
          requestId,
          method,
          threadId,
          turnId,
          correlationId,
          decision
        });
      } catch (error) {
        error.approval_response_phase = "pre_provider";
        throw error;
      }
      try {
        transport.respond(attempt.response.id, attempt.response.result);
        approvalRelay.commitResponse(attempt.key);
      } catch (error) {
        error.approval_response_phase = "provider_write_started";
        throw error;
      }
      return success("respondToApproval", correlationId, {
        thread_id: threadId,
        turn_id: turnId,
        approval_id: requestId
      });
    }),

    subscribeEvents: ({ correlationId, listener }) => {
      if (typeof listener !== "function") {
        throw new TypeError("listener must be a function");
      }
      eventListeners.add(listener);
      return success("subscribeEvents", correlationId, {
        subscription: {
          unsubscribe: () => eventListeners.delete(listener)
        }
      });
    },

    readActualModel: ({ correlationId }) => createAdapterFailure({
      adapter: "app_server",
      status: "unsupported",
      correlationId,
      operation: "readActualModel",
      code: "actual_model_unobserved",
      message: "No independent runtime model observation is available.",
      evidence: {
        dispatch_accepted: false,
        turn_started: false,
        actual_model: null
      }
    }),

    readThread: ({ correlationId, threadId, includeTurns = true }) => run(
      "readThread",
      correlationId,
      async () => {
        await ensureInitialized();
        const params = { threadId, includeTurns };
        validateRequest("thread/read", params);
        const result = await transport.request("thread/read", params);
        validateResponse("thread/read", result);
        return success("readThread", correlationId, {
          thread_id: threadId,
          thread: result.thread
        });
      }
    ),

    listThreadTurns: ({
      correlationId,
      threadId,
      cursor = null,
      limit = 50,
      sortDirection = "desc",
      itemsView = "summary"
    }) => run(
      "listThreadTurns",
      correlationId,
      async () => {
        await ensureInitialized();
        const params = { threadId, limit, sortDirection, itemsView };
        if (cursor) params.cursor = cursor;
        validateRequest("thread/turns/list", params);
        const result = await transport.request("thread/turns/list", params);
        validateResponse("thread/turns/list", result);
        return success("listThreadTurns", correlationId, {
          thread_id: threadId,
          turns: result.data,
          next_cursor: result.nextCursor ?? null,
          backwards_cursor: result.backwardsCursor ?? null
        });
      }
    ),

    readAccount: ({ correlationId, refreshToken = false }) => run(
      "readAccount",
      correlationId,
      async () => {
        await ensureInitialized();
        const params = { refreshToken: Boolean(refreshToken) };
        validateRequest("account/read", params);
        const result = await transport.request("account/read", params);
        validateResponse("account/read", result);
        return success("readAccount", correlationId, {
          account_type: result.account?.type ?? null,
          requires_openai_auth: result.requiresOpenaiAuth
        });
      }
    ),

    startLogin: ({ correlationId, loginType = "chatgpt" }) => run(
      "startLogin",
      correlationId,
      async () => {
        if (loginType !== "chatgpt" && loginType !== "chatgptDeviceCode") {
          throw new Error(`unsupported login type: ${loginType}`);
        }
        await ensureInitialized();
        const params = loginType === "chatgpt"
          ? { type: "chatgpt", useHostedLoginSuccessPage: true }
          : { type: "chatgptDeviceCode" };
        validateRequest("account/login/start", params);
        const result = await transport.request("account/login/start", params);
        validateResponse("account/login/start", result);
        return success("startLogin", correlationId, {
          login_type: result.type,
          login_id: result.loginId ?? null,
          auth_url: result.authUrl ?? null,
          verification_url: result.verificationUrl ?? null,
          user_code: result.userCode ?? null
        });
      }
    ),

    runtimeInfo: ({ correlationId, probe = false }) => run(
      "runtimeInfo",
      correlationId,
      async () => {
        const runtime = resolveRuntimeResult();
        const initialized = probe ? await ensureInitialized() : null;
        const models = initialized ? await readModelCatalog() : [];
        return success("runtimeInfo", correlationId, {
          adapter_package: ADAPTER_PACKAGE.name,
          adapter_package_version: ADAPTER_PACKAGE.version,
          sdk_package: runtime.sdk_package,
          sdk_version: runtime.sdk_version,
          codex_package: runtime.codex_package,
          codex_version: runtime.codex_version,
          runtime_package: runtime.runtime_package,
          runtime_package_version: runtime.runtime_package_version,
          target_triple: runtime.target_triple,
          platform_family: initialized?.platformFamily ?? null,
          platform_os: initialized?.platformOs ?? null,
          user_agent: initialized?.userAgent ?? null,
          provider_connection_id: initialized ? currentProviderStreamId : null,
          models
        });
      }
    ),

    shutdown: ({ correlationId }) => run("shutdown", correlationId, async () => {
      const connection = transport;
      if (currentProviderStreamId) {
        emitEvent({ type: "provider_connection", provider_connection_id: currentProviderStreamId, state: "disconnected" });
      }
      let drainConfirmed = false;
      try {
        await connection?.shutdown();
        drainConfirmed = true;
      } finally {
        if (drainConfirmed) {
          approvalRelay.reset();
          if (currentProviderStreamId) await dynamicToolRelay.reset(currentProviderStreamId, "provider_stopped");
          activeTurns.clear();
          threadCorrelations.clear();
          pendingThreadCorrelations.clear();
          pendingTurnStarts.clear();
          pendingThreadCreates = 0;
          clearOrphanFrames();
          orphanOverflowThreads.clear();
          orphanOverflowProviders.clear();
          eventListeners.clear();
          currentProviderStreamId = null;
        }
        if (drainConfirmed && transport === connection) {
          transport = null;
          initializePromise = null;
          initializeResult = null;
          resolvedRuntime = null;
          modelCatalog = null;
          modelCatalogPromise = null;
        }
      }
      return success("shutdown", correlationId);
    })
  };

  for (const method of CAPABILITY_METHODS) {
    if (typeof methods[method] !== "function") {
      throw new Error(`missing App Server adapter method: ${method}`);
    }
  }

  return defineCodexAdapter({
    adapter: "app_server",
    capabilities: APP_SERVER_CAPABILITIES,
    methods
  });
}

module.exports = {
  APP_SERVER_CAPABILITIES,
  APP_SERVER_MAX_LINE_BYTES,
  createAppServerAdapter,
  findInstalledSdkPackageRoot,
  requireFields,
  validateRequest,
  validateResponse,
  validateServerMessage
};
