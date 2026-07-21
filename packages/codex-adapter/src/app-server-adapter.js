const { spawn } = require("node:child_process");
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
const { createJsonlTransport } = require("./jsonl-transport");
const { createModelEvidence } = require("./model-evidence");
const { resolveBundledCodexRuntime } = require("./runtime-path");

const APP_SERVER_CAPABILITIES = Object.freeze({
  createThread: true,
  resumeThread: true,
  startTurn: true,
  steerTurn: true,
  interruptTurn: true,
  respondToApproval: true,
  subscribeEvents: true,
  readActualModel: false,
  readThread: true,
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
  onDiagnostic = () => {}
} = {}) {
  const eventListeners = new Set();
  const activeTurns = new Map();
  const threadCorrelations = new Map();
  const approvalRelay = createApprovalRelay();
  let transport = null;
  let initializePromise = null;
  let initializeResult = null;
  let resolvedRuntime = null;

  function turnKey(threadId, turnId) {
    return `${threadId}\u0000${turnId}`;
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
    return createAdapterFailure({
      adapter: "app_server",
      status: unavailable ? "unavailable" : "failed",
      correlationId,
      operation,
      code: unavailable ? "runtime_unavailable" : "runtime_failed",
      message: error.message,
      evidence: {
        dispatch_accepted: false,
        turn_started: false,
        actual_model: null,
        ...evidence
      }
    });
  }

  function resolveRuntimeResult() {
    if (resolvedRuntime) return resolvedRuntime;
    try {
      const resolved = resolveRuntime({
        sdkPackageRoot: sdkPackageRoot || findInstalledSdkPackageRoot()
      });
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

  function handleNotification(message) {
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
      const correlationId = activeTurns.get(turnKey(params.threadId, turnId));
      if (!correlationId) return;

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
        emitEvent({
          type: "turn_completed",
          correlation_id: correlationId,
          thread_id: params.threadId,
          turn_id: turnId,
          status: params.turn.status
        });
        activeTurns.delete(turnKey(params.threadId, turnId));
      } else if (message.method === "error") {
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
    try {
      validateServerMessage(schema.server_requests, message, "server request");
      const correlationId = activeTurns.get(
        turnKey(message.params.threadId, message.params.turnId)
      );
      if (!correlationId) return;
      const request = approvalRelay.register({
        message,
        correlationId,
        threadId: message.params.threadId,
        turnId: message.params.turnId
      });
      emitEvent({
        type: "approval_requested",
        correlation_id: request.correlation_id,
        thread_id: request.thread_id,
        turn_id: request.turn_id,
        request_id: request.request_id,
        method: request.method,
        reason: request.reason,
        requested_effect: request.requested_effect,
        response_options: request.response_options
      });
    } catch (error) {
      transport?.close(error.message);
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
    transport = transportFactory({
      process: child,
      onDiagnostic,
      onProtocolError: () => approvalRelay.reset()
    });
    transport.onNotification(handleNotification);
    transport.onServerRequest(handleServerRequest);
    return transport;
  }

  async function ensureInitialized() {
    if (!initializePromise) {
      initializePromise = (async () => {
        const connection = startTransport();
        const params = {
          clientInfo: {
            name: "orquesta",
            title: "Orquesta",
            version: "0.4.0-preview.1"
          }
        };
        validateRequest("initialize", params);
        const result = await connection.request("initialize", params);
        validateResponse("initialize", result);
        connection.notify("initialized");
        initializeResult = deepFreeze({ ...result });
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
        const result = await transport.request("thread/start", params);
        validateResponse("thread/start", result);
        if (typeof result.thread?.id !== "string" || result.thread.id === "") {
          throw new Error("schema validation failed: thread/start response missing thread.id");
        }
        threadCorrelations.set(result.thread.id, correlationId);
        return success("createThread", correlationId, {
          thread_id: result.thread.id,
          applied_model: result.model ?? null,
          runtime_profile: {
            cwd: result.cwd ?? null,
            sandbox: result.sandbox ?? null,
            approval_policy: result.approvalPolicy ?? null,
            requested_web_search_mode: params.webSearchMode ?? null
          },
          model_evidence: createModelEvidence({
            recommended: recommendedModel,
            requested: requestedModel ?? params.model,
            applied: result.model
          })
        });
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
        const result = await transport.request("thread/resume", requestParams);
        validateResponse("thread/resume", result);
        if (typeof result.thread?.id !== "string" || result.thread.id === "") {
          throw new Error("schema validation failed: thread/resume response missing thread.id");
        }
        threadCorrelations.set(result.thread.id, correlationId);
        return success("resumeThread", correlationId, {
          thread_id: result.thread.id,
          applied_model: result.model ?? null,
          runtime_profile: {
            cwd: result.cwd ?? null,
            sandbox: result.sandbox ?? null,
            approval_policy: result.approvalPolicy ?? null,
            requested_web_search_mode: params.webSearchMode ?? null
          },
          model_evidence: createModelEvidence({
            recommended: recommendedModel,
            requested: requestedModel ?? params.model,
            applied: result.model
          })
        });
      }
    ),

    startTurn: ({ correlationId, threadId, input, params = {} }) => run(
      "startTurn",
      correlationId,
      async () => {
        await ensureInitialized();
        const requestParams = { ...params, input, threadId };
        validateRequest("turn/start", requestParams);
        const result = await transport.request("turn/start", requestParams);
        validateResponse("turn/start", result);
        if (typeof result.turn?.id !== "string" || result.turn.id === "") {
          throw new Error("schema validation failed: turn/start response missing turn.id");
        }
        activeTurns.set(turnKey(threadId, result.turn.id), correlationId);
        emitEvent({
          type: "dispatch_accepted",
          correlation_id: correlationId,
          thread_id: threadId,
          turn_id: result.turn.id
        });
        return success("startTurn", correlationId, {
          thread_id: threadId,
          turn_id: result.turn.id,
          evidence: {
            dispatch_accepted: true,
            turn_started: false,
            actual_model: null
          }
        });
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
      const response = approvalRelay.consume({
        requestId,
        method,
        threadId,
        turnId,
        correlationId,
        decision
      });
      transport.respond(response.id, response.result);
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
          user_agent: initialized?.userAgent ?? null
        });
      }
    ),

    shutdown: ({ correlationId }) => run("shutdown", correlationId, async () => {
      const connection = transport;
      approvalRelay.reset();
      activeTurns.clear();
      threadCorrelations.clear();
      eventListeners.clear();
      try {
        await connection?.shutdown();
      } finally {
        if (transport === connection) {
          transport = null;
          initializePromise = null;
          initializeResult = null;
          resolvedRuntime = null;
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
  createAppServerAdapter,
  findInstalledSdkPackageRoot,
  requireFields,
  validateRequest,
  validateResponse,
  validateServerMessage
};
