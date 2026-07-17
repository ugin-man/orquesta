const {
  createAdapterFailure,
  deepFreeze,
  defineCodexAdapter
} = require("./contract");
const { createModelEvidence } = require("./model-evidence");

const SDK_CAPABILITIES = Object.freeze({
  createThread: true,
  resumeThread: true,
  startTurn: true,
  steerTurn: false,
  interruptTurn: true,
  respondToApproval: false,
  subscribeEvents: true,
  readActualModel: false
});

const THREAD_OPTION_FIELDS = Object.freeze([
  "model",
  "sandboxMode",
  "workingDirectory",
  "skipGitRepoCheck",
  "networkAccessEnabled",
  "webSearchMode",
  "approvalPolicy"
]);

function mapThreadOptions(profile = {}) {
  const options = {};
  for (const field of THREAD_OPTION_FIELDS) {
    if (profile[field] !== undefined) options[field] = profile[field];
  }
  return options;
}

async function defaultCodexFactory(options) {
  const { Codex } = await import("@openai/codex-sdk");
  return new Codex(options);
}

function createSdkAdapter({
  codexFactory = defaultCodexFactory,
  codexOptions,
  onDiagnostic = () => {}
} = {}) {
  const eventListeners = new Set();
  const threads = new Map();
  const activeTurns = new Map();
  let codexPromise = null;

  function getCodex() {
    if (!codexPromise) codexPromise = Promise.resolve().then(() => codexFactory(codexOptions));
    return codexPromise;
  }

  function emitEvent(event) {
    const frozen = deepFreeze({ adapter: "typescript_sdk", ...event });
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
      adapter: "typescript_sdk",
      operation,
      correlation_id: correlationId,
      thread_id: null,
      turn_id: null,
      approval_id: null,
      actual_model: null,
      ...fields
    });
  }

  function unsupported(operation, correlationId, message) {
    return createAdapterFailure({
      adapter: "typescript_sdk",
      status: "unsupported",
      correlationId,
      operation,
      code: "sdk_capability_unsupported",
      message,
      evidence: {
        dispatch_accepted: false,
        turn_started: false,
        actual_model: null
      }
    });
  }

  function failure(operation, correlationId, error) {
    const unavailable = error?.code === "ERR_MODULE_NOT_FOUND"
      || error?.code === "MODULE_NOT_FOUND";
    return createAdapterFailure({
      adapter: "typescript_sdk",
      status: unavailable ? "unavailable" : "failed",
      correlationId,
      operation,
      code: unavailable ? "sdk_unavailable" : "sdk_failed",
      message: error.message,
      evidence: {
        dispatch_accepted: false,
        turn_started: false,
        actual_model: null
      }
    });
  }

  function findThread(handle) {
    if (typeof handle !== "string" || handle === "") return null;
    return threads.get(handle) || null;
  }

  async function pumpEvents({ record, handle, correlationId, events }) {
    try {
      for await (const event of events) {
        const threadId = record.actualThreadId || record.thread.id || null;
        if (event.type === "thread.started") {
          record.actualThreadId = event.thread_id;
          threads.set(event.thread_id, record);
          emitEvent({
            type: "thread_started",
            correlation_id: correlationId,
            thread_id: event.thread_id,
            turn_id: null
          });
        } else if (event.type === "turn.started") {
          emitEvent({
            type: "turn_started",
            correlation_id: correlationId,
            thread_id: record.actualThreadId || record.thread.id || null,
            turn_id: null
          });
        } else if (["item.started", "item.updated", "item.completed"].includes(event.type)) {
          if (event.type === "item.completed"
              && event.item?.type === "agent_message"
              && typeof event.item.text === "string") {
            emitEvent({
              type: "artifact_produced",
              artifact_type: "final_response",
              content: event.item.text,
              correlation_id: correlationId,
              thread_id: record.actualThreadId || record.thread.id || null,
              turn_id: null
            });
          }
          emitEvent({
            type: "progress_observed",
            event_method: event.type,
            item_id: event.item?.id || null,
            correlation_id: correlationId,
            thread_id: record.actualThreadId || record.thread.id || null,
            turn_id: null
          });
        } else if (event.type === "turn.completed") {
          emitEvent({
            type: "turn_completed",
            correlation_id: correlationId,
            thread_id: record.actualThreadId || record.thread.id || null,
            turn_id: null,
            usage: event.usage ?? null
          });
          activeTurns.delete(handle);
        } else if (event.type === "turn.failed" || event.type === "error") {
          emitEvent({
            type: "runtime_error",
            correlation_id: correlationId,
            thread_id: record.actualThreadId || record.thread.id || null,
            turn_id: null,
            message: event.error?.message || event.message || "SDK stream failed"
          });
          activeTurns.delete(handle);
        }
      }
    } catch (error) {
      emitEvent({
        type: "runtime_error",
        correlation_id: correlationId,
        thread_id: record.actualThreadId || record.thread.id || null,
        turn_id: null,
        message: error.message
      });
    } finally {
      activeTurns.delete(handle);
    }
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
      capabilities: { ...SDK_CAPABILITIES }
    }),

    createThread: ({
      correlationId,
      recommendedModel,
      requestedModel,
      profile = {}
    }) => run("createThread", correlationId, async () => {
      const codex = await getCodex();
      const options = mapThreadOptions(profile);
      const thread = codex.startThread(options);
      if (!thread || typeof thread !== "object") {
        throw new Error("SDK startThread did not return a Thread");
      }
      const record = { thread, actualThreadId: thread.id || null };
      threads.set(correlationId, record);
      if (thread.id) threads.set(thread.id, record);
      return success("createThread", correlationId, {
        thread_id: thread.id || null,
        thread_handle: correlationId,
        model_evidence: createModelEvidence({
          recommended: recommendedModel,
          requested: requestedModel,
          applied: options.model
        })
      });
    }),

    resumeThread: ({
      correlationId,
      threadId,
      recommendedModel,
      requestedModel,
      profile = {}
    }) => run("resumeThread", correlationId, async () => {
      const codex = await getCodex();
      const options = mapThreadOptions(profile);
      const thread = codex.resumeThread(threadId, options);
      if (!thread || typeof thread !== "object") {
        throw new Error("SDK resumeThread did not return a Thread");
      }
      const record = { thread, actualThreadId: thread.id || threadId };
      threads.set(threadId, record);
      threads.set(correlationId, record);
      return success("resumeThread", correlationId, {
        thread_id: thread.id || threadId,
        thread_handle: threadId,
        model_evidence: createModelEvidence({
          recommended: recommendedModel,
          requested: requestedModel,
          applied: options.model
        })
      });
    }),

    startTurn: ({
      correlationId,
      threadHandle,
      threadId,
      input,
      outputSchema
    }) => run("startTurn", correlationId, async () => {
      const handle = threadHandle || threadId;
      const record = findThread(handle);
      if (!record || typeof record.thread.runStreamed !== "function") {
        throw new Error("SDK thread handle is unavailable");
      }
      if (activeTurns.has(handle)) {
        throw new Error("SDK thread already has an active turn");
      }
      const controller = new AbortController();
      const streamed = await record.thread.runStreamed(input, {
        ...(outputSchema === undefined ? {} : { outputSchema }),
        signal: controller.signal
      });
      if (!streamed?.events || typeof streamed.events[Symbol.asyncIterator] !== "function") {
        throw new Error("SDK runStreamed did not return an event stream");
      }
      activeTurns.set(handle, { controller, correlationId, record });
      emitEvent({
        type: "dispatch_accepted",
        correlation_id: correlationId,
        thread_id: record.actualThreadId || record.thread.id || null,
        turn_id: null
      });
      Promise.resolve().then(() => pumpEvents({
        record,
        handle,
        correlationId,
        events: streamed.events
      }));
      return success("startTurn", correlationId, {
        thread_id: record.actualThreadId || record.thread.id || null,
        turn_id: null,
        evidence: {
          dispatch_accepted: true,
          turn_started: false,
          actual_model: null
        }
      });
    }),

    steerTurn: ({ correlationId }) => unsupported(
      "steerTurn",
      correlationId,
      "Codex SDK 0.144.5 does not expose turn steering."
    ),

    interruptTurn: ({ correlationId, threadHandle, threadId }) => {
      const handle = threadHandle || threadId;
      const active = activeTurns.get(handle);
      if (!active) {
        return unsupported(
          "interruptTurn",
          correlationId,
          "No adapter-owned SDK turn is active for this thread."
        );
      }
      active.controller.abort();
      activeTurns.delete(handle);
      return success("interruptTurn", correlationId, {
        thread_id: active.record.actualThreadId || active.record.thread.id || null,
        turn_id: null
      });
    },

    respondToApproval: ({ correlationId }) => unsupported(
      "respondToApproval",
      correlationId,
      "Codex SDK 0.144.5 does not expose direct approval relay."
    ),

    subscribeEvents: ({ correlationId, listener }) => {
      if (typeof listener !== "function") throw new TypeError("listener must be a function");
      eventListeners.add(listener);
      return success("subscribeEvents", correlationId, {
        subscription: { unsubscribe: () => eventListeners.delete(listener) }
      });
    },

    readActualModel: ({ correlationId }) => unsupported(
      "readActualModel",
      correlationId,
      "Codex SDK 0.144.5 provides no independent actual-model evidence."
    )
  };

  return defineCodexAdapter({
    adapter: "typescript_sdk",
    capabilities: SDK_CAPABILITIES,
    methods
  });
}

module.exports = {
  SDK_CAPABILITIES,
  THREAD_OPTION_FIELDS,
  createSdkAdapter,
  defaultCodexFactory,
  mapThreadOptions
};
