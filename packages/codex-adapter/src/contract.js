const {
  ADAPTER_FAILURE_STATUSES,
  AdapterContractError
} = require("./errors");

const CODEX_ADAPTER_METHODS = Object.freeze([
  "capabilities",
  "createThread",
  "resumeThread",
  "startTurn",
  "steerTurn",
  "interruptTurn",
  "respondToApproval",
  "subscribeEvents",
  "readActualModel"
]);

const CAPABILITY_METHODS = Object.freeze(
  CODEX_ADAPTER_METHODS.filter((method) => method !== "capabilities")
);

const SAFE_EVIDENCE_FIELDS = Object.freeze([
  "dispatch_accepted",
  "turn_started",
  "actual_model",
  "actual_model_evidence_ref"
]);

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AdapterContractError(`${label} must be a non-empty string`);
  }
  return value;
}

function assertCorrelationId(correlationId) {
  return assertNonEmptyString(correlationId, "correlation ID");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

function safeEvidence(evidence = {}) {
  const detached = {};
  for (const field of SAFE_EVIDENCE_FIELDS) {
    if (Object.hasOwn(evidence, field)) {
      detached[field] = evidence[field];
    }
  }
  return detached;
}

function createAdapterFailure({
  adapter,
  status,
  correlationId,
  operation,
  code,
  message,
  threadId = null,
  turnId = null,
  approvalId = null,
  evidence = {}
}) {
  assertNonEmptyString(adapter, "adapter");
  assertCorrelationId(correlationId);
  assertNonEmptyString(operation, "operation");
  assertNonEmptyString(code, "error code");
  assertNonEmptyString(message, "error message");
  if (!ADAPTER_FAILURE_STATUSES.includes(status)) {
    throw new AdapterContractError(`unknown adapter failure status: ${status}`);
  }

  return deepFreeze({
    ok: false,
    status,
    adapter,
    operation,
    correlation_id: correlationId,
    thread_id: threadId,
    turn_id: turnId,
    approval_id: approvalId,
    error: { code, message },
    evidence: safeEvidence(evidence)
  });
}

function validateCapabilities(capabilities) {
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
    throw new AdapterContractError("capability declaration must be an object");
  }

  const declared = Object.keys(capabilities).sort();
  const expected = [...CAPABILITY_METHODS].sort();
  if (declared.length !== expected.length
      || declared.some((name, index) => name !== expected[index])) {
    throw new AdapterContractError(
      `capability declaration must contain exactly: ${CAPABILITY_METHODS.join(", ")}`
    );
  }

  for (const method of CAPABILITY_METHODS) {
    if (typeof capabilities[method] !== "boolean") {
      throw new AdapterContractError(`${method} capability must be boolean`);
    }
  }

  return deepFreeze({ ...capabilities });
}

function defineCodexAdapter({ adapter, capabilities, methods }) {
  assertNonEmptyString(adapter, "adapter");
  const declaredCapabilities = validateCapabilities(capabilities);
  if (!methods || typeof methods !== "object") {
    throw new AdapterContractError("adapter methods must be an object");
  }

  const defined = { adapter, declaredCapabilities };
  for (const method of CODEX_ADAPTER_METHODS) {
    if (typeof methods[method] !== "function") {
      throw new AdapterContractError(`${method} adapter method must be a function`);
    }
    defined[method] = async (input = {}) => {
      assertCorrelationId(input.correlationId);
      return methods[method](input);
    };
  }

  return deepFreeze(defined);
}

module.exports = {
  CODEX_ADAPTER_METHODS,
  CAPABILITY_METHODS,
  assertCorrelationId,
  createAdapterFailure,
  deepFreeze,
  defineCodexAdapter
};
