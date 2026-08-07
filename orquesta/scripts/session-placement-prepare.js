"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { updateJsonAtomic } = require("./json-state");

const DEFAULT_POLICY = Object.freeze({ prepare_at: 12, pending_at: 15, required_at: 20 });

function nonempty(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function option(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function comparableRoot(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function readJson(filePath, errorCode) {
  if (!fs.existsSync(filePath)) throw new Error(errorCode);
  const value = record(JSON.parse(fs.readFileSync(filePath, "utf8")));
  if (!value) throw new Error(`${errorCode}_invalid`);
  return value;
}

function generationOf(session) {
  return Number.isInteger(session.session_generation) && session.session_generation > 0
    ? session.session_generation
    : 1;
}

function activeSessionOwner(sessions, agentId) {
  const candidates = sessions
    .filter((session) => record(session)?.agent_id === agentId)
    .filter((session) => !["candidate", "superseded"].includes(String(session.ownership_status || "owner")))
    .filter((session) => !["superseded", "failed"].includes(String(session.rotation_state || "active")))
    .sort((left, right) => generationOf(right) - generationOf(left));
  if (!candidates.length) throw new Error(`session_owner_missing:${agentId}`);
  if (candidates.length > 1 && generationOf(candidates[0]) === generationOf(candidates[1])) {
    throw new Error(`multiple_active_session_owners:${agentId}:generation-${generationOf(candidates[0])}`);
  }
  return candidates[0];
}

function baseRotationRecord(session, now) {
  const sessionId = nonempty(session.session_id || session.thread_id, "predecessor_session_id");
  return {
    session_id: sessionId,
    thread_id: nonempty(session.thread_id, "predecessor_thread_id"),
    agent_id: nonempty(session.agent_id, "agent_id"),
    session_generation: generationOf(session),
    compaction_count: 0,
    rotation_state: "rotation_pending",
    ownership_status: "owner",
    accepts_new_work: true,
    replaces_session_id: session.replaces_session_id || null,
    replaced_by_session_id: null,
    handoff_manifest_path: null,
    handoff_manifest_hash: null,
    successor_receipt_path: null,
    successor_receipt_hash: null,
    last_compaction: null,
    rotation_reason: "project_placement_migration",
    created_at: session.created_at || now,
    updated_at: now
  };
}

function prepareHostedSessionPlacement({
  root,
  agentId,
  expectedGeneration,
  now = () => new Date().toISOString()
}) {
  const canonicalRoot = fs.realpathSync(path.resolve(nonempty(root, "root")));
  const safeAgentId = nonempty(agentId, "agentId");
  const expected = Number(expectedGeneration);
  if (!Number.isInteger(expected) || expected < 2) {
    throw new Error("expectedGeneration must be an integer of at least 2");
  }
  const stateRoot = path.join(canonicalRoot, ".orquesta", "state");
  const binding = readJson(path.join(stateRoot, "runtime-binding.json"), "runtime_binding_missing");
  if (binding.mode !== "codex_hosted" || !nonempty(binding.project_id, "runtime project_id")) {
    throw new Error("codex_hosted_runtime_binding_required");
  }
  const sessionsState = readJson(path.join(stateRoot, "sessions.json"), "sessions_state_missing");
  if (!Array.isArray(sessionsState.sessions)) throw new Error("sessions_state_invalid");
  const predecessor = activeSessionOwner(sessionsState.sessions, safeAgentId);
  const predecessorGeneration = generationOf(predecessor);
  if (predecessorGeneration + 1 !== expected) {
    throw new Error(`session_placement_generation_mismatch:${safeAgentId}:expected-${expected}:observed-${predecessorGeneration + 1}`);
  }
  if (predecessor.binding_status === "bound"
    && predecessor.runtime_authority_id === binding.runtime_authority_id
    && predecessor.visibility === "codex_task") {
    throw new Error(`session_already_bound_to_runtime:${safeAgentId}`);
  }

  const timestamp = now();
  const registryPath = path.join(stateRoot, "session-rotation.json");
  let preparedRecord;
  updateJsonAtomic(registryPath, {
    schema_version: 1,
    revision: 0,
    policy: { ...DEFAULT_POLICY },
    sessions: {},
    applied_event_ids: [],
    updated_at: null
  }, (state) => {
    if (!record(state) || !record(state.sessions) || !Array.isArray(state.applied_event_ids)) {
      throw new Error("session_rotation_registry_invalid");
    }
    const predecessorId = nonempty(predecessor.session_id || predecessor.thread_id, "predecessor_session_id");
    const activeOwners = Object.values(state.sessions).filter((session) => (
      record(session)?.agent_id === safeAgentId
      && session.ownership_status === "owner"
      && !["superseded", "failed"].includes(String(session.rotation_state))
    ));
    if (activeOwners.some((session) => session.session_id !== predecessorId || session.thread_id !== predecessor.thread_id)) {
      throw new Error(`session_rotation_owner_conflict:${safeAgentId}`);
    }
    const current = record(state.sessions[predecessorId]);
    if (current && ["draining", "checkpointed", "successor_warming", "successor_verified"].includes(String(current.rotation_state))) {
      throw new Error(`session_rotation_already_in_progress:${safeAgentId}`);
    }
    if (current && ["superseded", "failed"].includes(String(current.rotation_state))) {
      throw new Error(`session_rotation_predecessor_terminal:${safeAgentId}`);
    }
    preparedRecord = {
      ...baseRotationRecord(predecessor, timestamp),
      ...(current || {}),
      rotation_state: "rotation_pending",
      ownership_status: "owner",
      accepts_new_work: true,
      rotation_reason: "project_placement_migration",
      updated_at: timestamp
    };
    const unchanged = current
      && current.rotation_state === "rotation_pending"
      && current.ownership_status === "owner"
      && current.accepts_new_work === true
      && current.rotation_reason === "project_placement_migration";
    return {
      ...state,
      revision: Number.isInteger(state.revision) ? state.revision + (unchanged ? 0 : 1) : 1,
      policy: record(state.policy) || { ...DEFAULT_POLICY },
      sessions: { ...state.sessions, [predecessorId]: preparedRecord },
      updated_at: timestamp
    };
  });

  const recoveryPath = path.join(stateRoot, "session-rotation-recovery.json");
  let recoveryRequest;
  updateJsonAtomic(recoveryPath, { schema_version: 1, requests: [] }, (state) => {
    if (!record(state) || !Array.isArray(state.requests)) throw new Error("session_rotation_recovery_invalid");
    const requestId = `${safeAgentId}:generation-${expected}`;
    const index = state.requests.findIndex((request) => record(request)?.request_id === requestId);
    const current = index >= 0 ? record(state.requests[index]) : null;
    const currentTargetRoot = current && typeof current.target_project_root === "string"
      ? current.target_project_root
      : null;
    if (current && (current.predecessor_session_id !== preparedRecord.session_id
      || !currentTargetRoot
      || comparableRoot(currentTargetRoot) !== comparableRoot(canonicalRoot))) {
      throw new Error(`session_rotation_recovery_conflict:${requestId}`);
    }
    if (current && !["manual_recovery", "bound"].includes(String(current.status))) {
      throw new Error(`session_rotation_recovery_not_preparable:${current.status}`);
    }
    recoveryRequest = {
      ...(current || {}),
      request_id: requestId,
      agent_id: safeAgentId,
      predecessor_session_id: preparedRecord.session_id,
      predecessor_thread_id: preparedRecord.thread_id,
      expected_successor_generation: expected,
      project_id: binding.project_id,
      target_project_root: canonicalRoot,
      completion_transport: "manual_recovery",
      status: current?.status === "bound" ? "bound" : "manual_recovery",
      reason: current?.status === "bound" ? null : "codex_hosted_successor_thread_binding_required",
      successor_thread_id: current?.successor_thread_id || null,
      prepared_by: "session-placement-prepare",
      created_at: current?.created_at || timestamp,
      updated_at: timestamp
    };
    const requests = [...state.requests];
    if (index >= 0) requests[index] = recoveryRequest;
    else requests.push(recoveryRequest);
    return { ...state, schema_version: 1, requests, updated_at: timestamp };
  });

  return {
    status: recoveryRequest.status,
    agent_id: safeAgentId,
    predecessor_session_id: preparedRecord.session_id,
    predecessor_thread_id: preparedRecord.thread_id,
    expected_successor_generation: expected,
    target_project_root: canonicalRoot,
    recovery_path: recoveryPath
  };
}

function runCli(argv = process.argv.slice(2), stdout = process.stdout) {
  const result = prepareHostedSessionPlacement({
    root: option(argv, "--root") || process.cwd(),
    agentId: option(argv, "--agent-id"),
    expectedGeneration: option(argv, "--expected-generation")
  });
  stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

if (require.main === module) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  prepareHostedSessionPlacement,
  runCli
};
