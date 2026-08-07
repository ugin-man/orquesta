"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { updateJsonAtomic } = require("./json-state");

function nonempty(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function option(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

function comparableRoot(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function bindHostedSessionSuccessor({
  root,
  agentId,
  successorThreadId,
  expectedGeneration,
  now = () => new Date().toISOString()
}) {
  const canonicalRoot = fs.realpathSync(path.resolve(nonempty(root, "root")));
  const safeAgentId = nonempty(agentId, "agentId");
  const safeThreadId = nonempty(successorThreadId, "successorThreadId");
  const generation = Number(expectedGeneration);
  if (!Number.isInteger(generation) || generation < 2) {
    throw new Error("expectedGeneration must be an integer of at least 2");
  }
  const statePath = path.join(canonicalRoot, ".orquesta", "state", "session-rotation-recovery.json");
  if (!fs.existsSync(statePath)) throw new Error("session_rotation_recovery_missing");
  let result = null;
  updateJsonAtomic(statePath, { schema_version: 1, requests: [] }, (state) => {
    if (!state || typeof state !== "object" || Array.isArray(state) || !Array.isArray(state.requests)) {
      throw new Error("session_rotation_recovery_invalid");
    }
    const index = state.requests.findIndex((request) => (
      request
      && typeof request === "object"
      && request.agent_id === safeAgentId
      && Number(request.expected_successor_generation) === generation
    ));
    if (index < 0) throw new Error(`session_rotation_request_missing:${safeAgentId}:generation-${generation}`);
    const request = state.requests[index];
    const targetRoot = nonempty(request.target_project_root, "target_project_root");
    if (comparableRoot(targetRoot) !== comparableRoot(canonicalRoot)) {
      throw new Error("session_rotation_target_root_mismatch");
    }
    if (!["manual_recovery", "bound"].includes(String(request.status))) {
      throw new Error(`session_rotation_request_not_bindable:${request.status}`);
    }
    if (request.status === "bound" && request.successor_thread_id !== safeThreadId) {
      throw new Error("session_rotation_successor_binding_conflict");
    }
    const timestamp = now();
    const nextRequest = {
      ...request,
      status: "bound",
      reason: null,
      successor_thread_id: safeThreadId,
      bound_by: "codex_hosted_thread_tool",
      bound_at: request.bound_at || timestamp,
      updated_at: timestamp
    };
    const requests = [...state.requests];
    requests[index] = nextRequest;
    result = {
      status: "bound",
      agent_id: safeAgentId,
      successor_thread_id: safeThreadId,
      expected_successor_generation: generation,
      target_project_root: canonicalRoot
    };
    return { ...state, requests, updated_at: timestamp };
  });
  return result;
}

function runCli(argv = process.argv.slice(2), stdout = process.stdout) {
  const result = bindHostedSessionSuccessor({
    root: option(argv, "--root") || process.cwd(),
    agentId: option(argv, "--agent-id"),
    successorThreadId: option(argv, "--thread-id"),
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
  bindHostedSessionSuccessor,
  runCli
};
