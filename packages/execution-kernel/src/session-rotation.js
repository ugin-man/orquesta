"use strict";

const DEFAULT_SESSION_ROTATION_POLICY = Object.freeze({
  prepare_at: 12,
  pending_at: 15,
  required_at: 20,
});

const ROTATION_STATES = Object.freeze([
  "active",
  "rotation_preparing",
  "rotation_pending",
  "rotation_required",
  "draining",
  "checkpointed",
  "successor_warming",
  "successor_verified",
  "superseded",
  "failed",
]);

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function nonempty(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function positiveInteger(value, field, fallback) {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return number;
}

function timestamp(value, field = "timestamp") {
  const parsed = Date.parse(value ?? "");
  if (!Number.isFinite(parsed)) throw new TypeError(`${field} must be an ISO timestamp`);
  return new Date(parsed).toISOString();
}

function normalizeRotationPolicy(input = {}) {
  const policy = {
    prepare_at: positiveInteger(input.prepare_at, "prepare_at", DEFAULT_SESSION_ROTATION_POLICY.prepare_at),
    pending_at: positiveInteger(input.pending_at, "pending_at", DEFAULT_SESSION_ROTATION_POLICY.pending_at),
    required_at: positiveInteger(input.required_at, "required_at", DEFAULT_SESSION_ROTATION_POLICY.required_at),
  };
  if (!(policy.prepare_at < policy.pending_at && policy.pending_at < policy.required_at)) {
    throw new TypeError("session rotation thresholds must satisfy prepare_at < pending_at < required_at");
  }
  return Object.freeze(policy);
}

function rotationStateForCount(count, inputPolicy = DEFAULT_SESSION_ROTATION_POLICY) {
  const policy = normalizeRotationPolicy(inputPolicy);
  const normalizedCount = Number(count);
  if (!Number.isInteger(normalizedCount) || normalizedCount < 0) {
    throw new TypeError("compaction count must be a non-negative integer");
  }
  if (normalizedCount >= policy.required_at) return "rotation_required";
  if (normalizedCount >= policy.pending_at) return "rotation_pending";
  if (normalizedCount >= policy.prepare_at) return "rotation_preparing";
  return "active";
}

function createSessionRotationRegistry(input = {}) {
  return {
    schema_version: 1,
    revision: 0,
    policy: { ...normalizeRotationPolicy(input.policy) },
    sessions: {},
    applied_event_ids: [],
    updated_at: input.updated_at ? timestamp(input.updated_at, "updated_at") : null,
  };
}

function normalizeRegistry(input) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const sessions = source.sessions && typeof source.sessions === "object" && !Array.isArray(source.sessions)
    ? clone(source.sessions)
    : {};
  return {
    schema_version: 1,
    revision: Number.isInteger(source.revision) && source.revision >= 0 ? source.revision : 0,
    policy: { ...normalizeRotationPolicy(source.policy) },
    sessions,
    applied_event_ids: Array.isArray(source.applied_event_ids)
      ? source.applied_event_ids.filter((item) => typeof item === "string").slice(-256)
      : [],
    updated_at: typeof source.updated_at === "string" ? source.updated_at : null,
  };
}

function sessionRecord(input, event, now) {
  const prior = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const generation = positiveInteger(
    event.session_generation ?? prior.session_generation,
    "session_generation",
    1,
  );
  return {
    session_id: event.session_id,
    thread_id: event.thread_id ?? prior.thread_id ?? event.session_id,
    agent_id: event.agent_id ?? prior.agent_id ?? null,
    session_generation: generation,
    compaction_count: Number.isInteger(prior.compaction_count) && prior.compaction_count >= 0
      ? prior.compaction_count
      : 0,
    rotation_state: typeof prior.rotation_state === "string" ? prior.rotation_state : "active",
    ownership_status: typeof prior.ownership_status === "string" ? prior.ownership_status : "owner",
    accepts_new_work: prior.accepts_new_work !== false,
    replaces_session_id: prior.replaces_session_id ?? null,
    replaced_by_session_id: prior.replaced_by_session_id ?? null,
    handoff_manifest_path: prior.handoff_manifest_path ?? null,
    handoff_manifest_hash: prior.handoff_manifest_hash ?? null,
    successor_receipt_path: prior.successor_receipt_path ?? null,
    successor_receipt_hash: prior.successor_receipt_hash ?? null,
    last_compaction: prior.last_compaction ?? null,
    created_at: prior.created_at ?? now,
    updated_at: now,
  };
}

function recordCompaction(inputRegistry, event) {
  const sessionId = nonempty(event?.session_id, "session_id");
  const eventId = nonempty(event?.event_id, "event_id");
  const now = timestamp(event?.observed_at, "observed_at");
  const registry = normalizeRegistry(inputRegistry);
  if (registry.applied_event_ids.includes(eventId)) {
    return { registry, duplicate: true, threshold_crossed: null, session: clone(registry.sessions[sessionId] ?? null) };
  }

  const prior = sessionRecord(registry.sessions[sessionId], { ...event, session_id: sessionId }, now);
  if (["superseded", "failed"].includes(prior.rotation_state)) {
    const error = new Error(`cannot record compaction for ${prior.rotation_state} session ${sessionId}`);
    error.code = "SESSION_ROTATION_TERMINAL";
    throw error;
  }
  const previousState = prior.rotation_state;
  const compactionCount = prior.compaction_count + 1;
  const thresholdState = rotationStateForCount(compactionCount, registry.policy);
  const protectedStates = new Set(["draining", "checkpointed", "successor_warming", "successor_verified"]);
  const rotationState = protectedStates.has(previousState) ? previousState : thresholdState;
  const acceptsNewWork = rotationState !== "rotation_required" && prior.accepts_new_work !== false;
  const nextSession = {
    ...prior,
    compaction_count: compactionCount,
    rotation_state: rotationState,
    accepts_new_work: acceptsNewWork,
    last_compaction: {
      event_id: eventId,
      turn_id: event.turn_id ?? null,
      trigger: event.trigger === "manual" ? "manual" : "auto",
      transcript_path: event.transcript_path ?? null,
      transcript_fingerprint: event.transcript_fingerprint ?? null,
      model: event.model ?? null,
      observed_at: now,
    },
    updated_at: now,
  };
  const next = {
    ...registry,
    revision: registry.revision + 1,
    sessions: { ...registry.sessions, [sessionId]: nextSession },
    applied_event_ids: [...registry.applied_event_ids, eventId].slice(-256),
    updated_at: now,
  };
  return {
    registry: next,
    duplicate: false,
    threshold_crossed: previousState === rotationState ? null : rotationState,
    session: clone(nextSession),
  };
}

function transitionSession(inputRegistry, input, expectedStates, patch) {
  const registry = normalizeRegistry(inputRegistry);
  const sessionId = nonempty(input?.session_id, "session_id");
  const now = timestamp(input?.observed_at, "observed_at");
  if (input.expected_revision !== undefined && input.expected_revision !== registry.revision) {
    const error = new Error(`session rotation revision conflict: expected ${input.expected_revision}, observed ${registry.revision}`);
    error.code = "SESSION_ROTATION_REVISION_CONFLICT";
    throw error;
  }
  const current = registry.sessions[sessionId];
  if (!current) throw new Error(`unknown session ${sessionId}`);
  if (!expectedStates.includes(current.rotation_state)) {
    const error = new Error(`session ${sessionId} cannot transition from ${current.rotation_state}`);
    error.code = "SESSION_ROTATION_INVALID_TRANSITION";
    throw error;
  }
  const nextSession = { ...current, ...patch(current), updated_at: now };
  return {
    ...registry,
    revision: registry.revision + 1,
    sessions: { ...registry.sessions, [sessionId]: nextSession },
    updated_at: now,
  };
}

function beginSessionDrain(inputRegistry, input) {
  return transitionSession(
    inputRegistry,
    input,
    ["rotation_pending", "rotation_required"],
    () => ({ rotation_state: "draining", accepts_new_work: false }),
  );
}

function markSessionCheckpointed(inputRegistry, input) {
  const manifestPath = nonempty(input?.handoff_manifest_path, "handoff_manifest_path");
  const manifestHash = nonempty(input?.handoff_manifest_hash, "handoff_manifest_hash");
  return transitionSession(
    inputRegistry,
    input,
    ["draining"],
    () => ({
      rotation_state: "checkpointed",
      accepts_new_work: false,
      handoff_manifest_path: manifestPath,
      handoff_manifest_hash: manifestHash,
    }),
  );
}

function registerSessionSuccessor(inputRegistry, input) {
  const registry = normalizeRegistry(inputRegistry);
  const predecessorId = nonempty(input?.predecessor_session_id, "predecessor_session_id");
  const successorId = nonempty(input?.successor_session_id, "successor_session_id");
  const successorThreadId = nonempty(input?.successor_thread_id, "successor_thread_id");
  const now = timestamp(input?.observed_at, "observed_at");
  if (input.expected_revision !== undefined && input.expected_revision !== registry.revision) {
    const error = new Error(`session rotation revision conflict: expected ${input.expected_revision}, observed ${registry.revision}`);
    error.code = "SESSION_ROTATION_REVISION_CONFLICT";
    throw error;
  }
  const predecessor = registry.sessions[predecessorId];
  if (!predecessor || predecessor.rotation_state !== "checkpointed") {
    throw new Error(`predecessor ${predecessorId} is not checkpointed`);
  }
  if (registry.sessions[successorId]) throw new Error(`successor session already exists: ${successorId}`);
  const successor = {
    session_id: successorId,
    thread_id: successorThreadId,
    agent_id: predecessor.agent_id,
    session_generation: predecessor.session_generation + 1,
    compaction_count: 0,
    rotation_state: "successor_warming",
    ownership_status: "candidate",
    accepts_new_work: false,
    replaces_session_id: predecessorId,
    replaced_by_session_id: null,
    handoff_manifest_path: predecessor.handoff_manifest_path,
    handoff_manifest_hash: predecessor.handoff_manifest_hash,
    successor_receipt_path: null,
    successor_receipt_hash: null,
    last_compaction: null,
    created_at: now,
    updated_at: now,
  };
  return {
    ...registry,
    revision: registry.revision + 1,
    sessions: {
      ...registry.sessions,
      [predecessorId]: { ...predecessor, replaced_by_session_id: successorId, updated_at: now },
      [successorId]: successor,
    },
    updated_at: now,
  };
}

function verifySuccessorReceipt(inputRegistry, input) {
  const registry = normalizeRegistry(inputRegistry);
  const successorId = nonempty(input?.successor_session_id, "successor_session_id");
  const receipt = input?.receipt;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new TypeError("receipt must be an object");
  }
  const successor = registry.sessions[successorId];
  if (!successor || successor.rotation_state !== "successor_warming") {
    throw new Error(`successor ${successorId} is not warming`);
  }
  const predecessor = registry.sessions[successor.replaces_session_id];
  const reasons = [];
  if (receipt.agent_id !== successor.agent_id) reasons.push("agent_id_mismatch");
  if (receipt.expected_generation !== successor.session_generation) reasons.push("expected_generation_mismatch");
  if (receipt.observed_generation !== successor.session_generation) reasons.push("observed_generation_mismatch");
  if (receipt.handoff_manifest_hash !== predecessor?.handoff_manifest_hash) reasons.push("manifest_hash_mismatch");
  if (receipt.ready_to_assume_ownership !== true) reasons.push("successor_not_ready");
  if (!Array.isArray(receipt.evidence_checked) || receipt.evidence_checked.length === 0) reasons.push("evidence_not_checked");
  if (typeof receipt.next_action !== "string" || !receipt.next_action.trim()) reasons.push("next_action_missing");
  return { valid: reasons.length === 0, reasons, successor: clone(successor) };
}

function markSuccessorVerified(inputRegistry, input) {
  const verification = verifySuccessorReceipt(inputRegistry, input);
  if (!verification.valid) {
    const error = new Error(`successor receipt rejected: ${verification.reasons.join(", ")}`);
    error.code = "SESSION_ROTATION_RECEIPT_REJECTED";
    error.reasons = verification.reasons;
    throw error;
  }
  const receiptPath = nonempty(input?.receipt_path, "receipt_path");
  const receiptHash = nonempty(input?.receipt_hash, "receipt_hash");
  return transitionSession(
    inputRegistry,
    { ...input, session_id: input.successor_session_id },
    ["successor_warming"],
    () => ({
      rotation_state: "successor_verified",
      successor_receipt_path: receiptPath,
      successor_receipt_hash: receiptHash,
    }),
  );
}

function activateSessionSuccessor(inputRegistry, input) {
  const registry = normalizeRegistry(inputRegistry);
  const successorId = nonempty(input?.successor_session_id, "successor_session_id");
  const now = timestamp(input?.observed_at, "observed_at");
  if (input.expected_revision !== undefined && input.expected_revision !== registry.revision) {
    const error = new Error(`session rotation revision conflict: expected ${input.expected_revision}, observed ${registry.revision}`);
    error.code = "SESSION_ROTATION_REVISION_CONFLICT";
    throw error;
  }
  const successor = registry.sessions[successorId];
  if (!successor || successor.rotation_state !== "successor_verified") {
    throw new Error(`successor ${successorId} is not verified`);
  }
  const predecessorId = successor.replaces_session_id;
  const predecessor = registry.sessions[predecessorId];
  if (!predecessor || predecessor.ownership_status !== "owner") {
    throw new Error(`predecessor ${predecessorId} is not the current owner`);
  }
  return {
    ...registry,
    revision: registry.revision + 1,
    sessions: {
      ...registry.sessions,
      [predecessorId]: {
        ...predecessor,
        rotation_state: "superseded",
        ownership_status: "superseded",
        accepts_new_work: false,
        updated_at: now,
      },
      [successorId]: {
        ...successor,
        rotation_state: "active",
        ownership_status: "owner",
        accepts_new_work: true,
        updated_at: now,
      },
    },
    updated_at: now,
  };
}

function selectActiveAgentSession(sessions, agentId) {
  const targetAgentId = nonempty(agentId, "agent_id");
  const candidates = (Array.isArray(sessions) ? sessions : [])
    .filter((session) => session && session.agent_id === targetAgentId)
    .filter((session) => !["superseded", "failed"].includes(session.rotation_state))
    .filter((session) => session.binding_status === undefined || session.binding_status === "bound");
  const explicitOwners = candidates.filter((session) => session.ownership_status === "owner");
  const pool = explicitOwners.length ? explicitOwners : candidates.filter((session) => session.ownership_status !== "candidate");
  if (!pool.length) return null;
  const ordered = [...pool].sort((left, right) => {
    const generationDelta = (Number(right.session_generation) || 1) - (Number(left.session_generation) || 1);
    if (generationDelta) return generationDelta;
    return Date.parse(right.updated_at ?? "") - Date.parse(left.updated_at ?? "");
  });
  if (explicitOwners.length > 1) {
    const topGeneration = Number(ordered[0].session_generation) || 1;
    const sameGenerationOwners = explicitOwners.filter((session) => (Number(session.session_generation) || 1) === topGeneration);
    if (sameGenerationOwners.length > 1) {
      const error = new Error(`multiple active owners for agent ${targetAgentId}`);
      error.code = "SESSION_ROTATION_MULTIPLE_OWNERS";
      throw error;
    }
  }
  return clone(ordered[0]);
}

module.exports = {
  DEFAULT_SESSION_ROTATION_POLICY,
  ROTATION_STATES,
  activateSessionSuccessor,
  beginSessionDrain,
  createSessionRotationRegistry,
  markSessionCheckpointed,
  markSuccessorVerified,
  normalizeRotationPolicy,
  recordCompaction,
  registerSessionSuccessor,
  rotationStateForCount,
  selectActiveAgentSession,
  verifySuccessorReceipt,
};
