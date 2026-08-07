"use strict";

const path = require("path");

const { readJsonFile, writeJsonAtomic } = require("./json-state");

const CLOSED_SESSION_STATES = new Set(["archived", "closed", "failed", "retired", "superseded"]);

function timestampValue(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function activeUserSupportSession(root) {
  const state = readJsonFile(
    path.join(root, ".orquesta", "state", "sessions.json"),
    { version: 1, sessions: [] },
  );
  return (state.sessions || [])
    .filter((session) => (
      session?.agent_id === "user-support"
      && typeof session.thread_id === "string"
      && session.thread_id.trim()
      && session.binding_status !== "unbound"
      && session.accepts_new_work !== false
      && !CLOSED_SESSION_STATES.has(String(session.rotation_state || "").toLowerCase())
      && !CLOSED_SESSION_STATES.has(String(session.ownership_status || "").toLowerCase())
      && !CLOSED_SESSION_STATES.has(String(session.status || "").toLowerCase())
    ))
    .sort((left, right) => {
      const generationDelta = Number(right.session_generation || 1) - Number(left.session_generation || 1);
      if (generationDelta) return generationDelta;
      return timestampValue(right.updated_at || right.last_seen) - timestampValue(left.updated_at || left.last_seen);
    })[0] || null;
}

function buildUserSupportWakeRequest(root, triggerAudit, now = new Date().toISOString()) {
  const support = (triggerAudit?.foundation_agents || [])
    .find((agent) => agent.agent_id === "user-support");
  const actionable = support && ["trigger_ready", "wake_needed"].includes(support.trigger_status);
  if (!actionable) {
    return {
      version: 1,
      generated_at: now,
      agent_id: "user-support",
      status: "not_required",
      dispatch_required: false,
      trigger_status: support?.trigger_status || "clear",
      reason_codes: support?.reason_codes || [],
      preferred_transport: null,
      thread_id: null,
      host_id: null,
      prompt: null,
    };
  }

  const session = activeUserSupportSession(root);
  return {
    version: 1,
    generated_at: now,
    agent_id: "user-support",
    status: session ? "ready" : "manual_recovery",
    dispatch_required: true,
    trigger_status: support.trigger_status,
    reason_codes: support.reason_codes || [],
    preferred_transport: session ? "send_message_to_thread" : "manual_recovery",
    thread_id: session?.thread_id || null,
    host_id: session?.host_id || session?.hostId || null,
    prompt: [
      "Orquesta user-support trigger is ready.",
      "Read .orquesta/state/trigger_audit.json and only the canonical queue records referenced by its current user-support evidence.",
      "Curate the current meaningful items into at most three user-facing questions, decisions, or manual tasks.",
      "Do not scan full conversation histories. Do not ask what repository inspection, live research, or a cheap reversible test can answer.",
      "Persist the curated result in the existing .orquesta vision, failure, or user_tasks state and return a compact receipt to the orchestrator.",
    ].join(" "),
  };
}

function persistUserSupportWakeRequest(root, triggerAudit, now = new Date().toISOString()) {
  const request = buildUserSupportWakeRequest(root, triggerAudit, now);
  writeJsonAtomic(
    path.join(root, ".orquesta", "state", "user_support_wake.json"),
    request,
  );
  return request;
}

module.exports = {
  activeUserSupportSession,
  buildUserSupportWakeRequest,
  persistUserSupportWakeRequest,
};
