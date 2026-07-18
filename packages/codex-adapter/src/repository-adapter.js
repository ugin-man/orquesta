const {
  ADAPTER_PACKAGE,
  CAPABILITY_METHODS,
  assertCorrelationId,
  createAdapterFailure,
  deepFreeze,
  defineCodexAdapter
} = require("./contract");

const REPOSITORY_CAPABILITIES = Object.freeze(
  Object.fromEntries(CAPABILITY_METHODS.map((method) => [
    method,
    ["runtimeInfo", "shutdown"].includes(method)
  ]))
);

function createRepositoryAdapter() {
  const unsupported = (operation, correlationId) => createAdapterFailure({
    adapter: "repository_only",
    status: "unsupported",
    correlationId,
    operation,
    code: "runtime_unsupported",
    message: "Repository-only mode does not execute Codex runtime actions.",
    evidence: {
      dispatch_accepted: false,
      turn_started: false,
      actual_model: null
    }
  });

  const methods = {
    capabilities: ({ correlationId }) => deepFreeze({
      ok: true,
      status: "completed",
      adapter: "repository_only",
      execution: "unsupported",
      correlation_id: correlationId,
      actual_model: null,
      capabilities: { ...REPOSITORY_CAPABILITIES }
    }),

    runtimeInfo: ({ correlationId }) => deepFreeze({
      ok: true,
      status: "completed",
      adapter: "repository_only",
      operation: "runtimeInfo",
      correlation_id: correlationId,
      thread_id: null,
      turn_id: null,
      approval_id: null,
      actual_model: null,
      adapter_package: ADAPTER_PACKAGE.name,
      adapter_package_version: ADAPTER_PACKAGE.version,
      sdk_package: null,
      sdk_version: null,
      codex_package: null,
      codex_version: null,
      runtime_package: null,
      runtime_package_version: null,
      target_triple: null,
      platform_family: null,
      platform_os: null,
      user_agent: null
    }),

    shutdown: ({ correlationId }) => deepFreeze({
      ok: true,
      status: "completed",
      adapter: "repository_only",
      operation: "shutdown",
      correlation_id: correlationId,
      thread_id: null,
      turn_id: null,
      approval_id: null,
      actual_model: null
    })
  };

  for (const method of CAPABILITY_METHODS) {
    if (!methods[method]) {
      methods[method] = ({ correlationId }) => unsupported(method, correlationId);
    }
  }

  const adapter = defineCodexAdapter({
    adapter: "repository_only",
    capabilities: REPOSITORY_CAPABILITIES,
    methods
  });

  return deepFreeze({
    ...adapter,
    createHandoffDraft({ correlationId, taskIntentId, contextPackId, prompt }) {
      assertCorrelationId(correlationId);
      if (typeof taskIntentId !== "string" || taskIntentId.trim() === "") {
        throw new TypeError("taskIntentId must be a non-empty string");
      }
      if (typeof contextPackId !== "string" || contextPackId.trim() === "") {
        throw new TypeError("contextPackId must be a non-empty string");
      }
      if (typeof prompt !== "string" || prompt.trim() === "") {
        throw new TypeError("prompt must be a non-empty string");
      }
      return deepFreeze({
        ok: true,
        status: "drafted",
        adapter: "repository_only",
        execution: "unsupported",
        correlation_id: correlationId,
        actual_model: null,
        draft: {
          task_intent_id: taskIntentId,
          context_pack_id: contextPackId,
          prompt
        }
      });
    }
  });
}

module.exports = {
  REPOSITORY_CAPABILITIES,
  createRepositoryAdapter
};
