"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { SCHEMA_NAMES, validateContract } = require("../src");

const acceptedAt = "2026-08-24T04:00:00.000Z";

function owner(overrides = {}) {
  return {
    session_id: "session-orchestrator-g1",
    agent_id: "orchestrator",
    thread_id: "thread-orchestrator-g1",
    session_generation: 1,
    session_kind: "persistent_agent",
    handoff_status: "accepted",
    handoff_turn_id: "turn-orchestrator-g1",
    accepted_at: acceptedAt,
    rotation_state: "active",
    ownership_status: "owner",
    accepts_new_work: true,
    binding_status: "bound",
    replaces_session_id: null,
    retry_of_session_id: null,
    replaced_by_session_id: null,
    visibility: "codex_task",
    profile_id: "foundation:orchestrator:v1",
    runtime_authority_id: "runtime-authority-a",
    provisioning_request_id: null,
    placement_intent_id: null,
    task_id: null,
    ownership_started_at: acceptedAt,
    ownership_ended_at: null,
    created_at: acceptedAt,
    updated_at: acceptedAt,
    ...overrides
  };
}

function state(sessions = [owner()]) {
  return {
    schema_version: 1,
    project_id: "orquesta-v5",
    revision: 1,
    sessions
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function codes(value) {
  return validateContract("session-binding-state-v1", value).errors.map((item) => item.code);
}

test("session binding v1 is registered and accepts only its bounded canonical shape", () => {
  assert.equal(SCHEMA_NAMES.includes("session-binding-state-v1"), true);
  assert.equal(validateContract("session-binding-state-v1", state()).ok, true);

  const accidentalState = { ...state(), synced_at: acceptedAt };
  assert.equal(validateContract("session-binding-state-v1", accidentalState).ok, false);
  const accidentalSession = state([{ ...owner(), title: "Orquesta orchestrator", cwd: "C:/repo", runtime_status: "working" }]);
  assert.equal(validateContract("session-binding-state-v1", accidentalSession).ok, false);
});

test("attachment tool state is optional for legacy bindings and otherwise exact", () => {
  assert.equal(validateContract("session-binding-state-v1", state([owner()])).ok, true);
  assert.equal(validateContract("session-binding-state-v1", state([owner({ attachment_tool_state: "supported" })])).ok, true);
  assert.equal(validateContract("session-binding-state-v1", state([owner({ attachment_tool_state: "unsupported" })])).ok, true);
  assert.equal(validateContract("session-binding-state-v1", state([owner({ attachment_tool_state: "unknown" })])).ok, false);
});

test("foundation identity and profile namespace come from one reserved authority", () => {
  const spoofedReservedAgent = owner({
    profile_id: "specialist:rogue:v1",
    provisioning_request_id: "placement:PI-0123456789ab:orchestrator",
    placement_intent_id: "PI-0123456789ab",
    task_id: "placement:0123456789ab:1"
  });
  assert(codes(state([spoofedReservedAgent])).includes("session_binding_foundation_identity"));
  const stolenProfile = owner({
    session_id: "session-implementer-g1",
    agent_id: "implementer",
    thread_id: "thread-implementer-g1",
    handoff_turn_id: "turn-implementer-g1",
    profile_id: "foundation:orchestrator:v1",
    provisioning_request_id: "placement:PI-0123456789ab:implementer",
    placement_intent_id: "PI-0123456789ab",
    task_id: "placement:0123456789ab:1"
  });
  assert(codes(state([stolenProfile])).includes("session_binding_foundation_namespace"));
});

test("accepted ownership is one exact active work authority", () => {
  assert(codes(state([owner({ handoff_status: "pending", handoff_turn_id: null, accepted_at: null, binding_status: "provisioning" })]))
    .includes("session_binding_lifecycle_matrix"));
  assert(codes(state([owner({ accepted_at: "2026-02-30T00:00:00.000Z" })])).includes("timestamp"));
  assert(codes(state([owner({ ownership_status: "candidate", accepts_new_work: true })])).includes("session_binding_lifecycle_matrix"));
  assert(codes(state([owner({ rotation_state: "superseded", ownership_status: "superseded", accepts_new_work: true })]))
    .includes("session_binding_lifecycle_matrix"));
  assert(codes(state([owner({ runtime_authority_id: null })])).includes("session_binding_runtime_authority"));
  assert(codes(state([owner({ created_at: "2026-08-24T04:01:00.000Z" })])).includes("session_binding_acceptance_chronology"));
});

test("all live bindings share one project runtime authority, including verified replacement lineage", () => {
  const secondOwner = owner({
    session_id: "session-support-g1",
    agent_id: "user-support",
    thread_id: "thread-support-g1",
    handoff_turn_id: "turn-support-g1",
    profile_id: "foundation:user-support:v1",
    runtime_authority_id: "runtime-authority-b"
  });
  const split = state([owner(), secondOwner].sort((left, right) => left.agent_id < right.agent_id ? -1 : 1));
  assert(codes(split).includes("session_binding_runtime_authority_unique"));

});

test("the current owner survives the full pre-cutover lifecycle with state-specific work authority", () => {
  for (const [rotationState, acceptsNewWork] of [
    ["active", true],
    ["rotation_preparing", true],
    ["rotation_pending", true],
    ["rotation_required", false],
    ["draining", false],
    ["checkpointed", false]
  ]) {
    assert.equal(validateContract("session-binding-state-v1", state([owner({
      rotation_state: rotationState,
      accepts_new_work: acceptsNewWork
    })])).ok, true, rotationState);
  }
  assert(codes(state([owner({ rotation_state: "draining", accepts_new_work: true })]))
    .includes("session_binding_lifecycle_matrix"));
});

test("session identity, generation, thread ownership, and deterministic ordering are unique", () => {
  const duplicateGeneration = state([
    owner({ ownership_status: "candidate", rotation_state: "rotation_pending", accepts_new_work: false, binding_status: "provisioning", handoff_status: "pending", handoff_turn_id: null, accepted_at: null }),
    owner({ session_id: "session-second", thread_id: "thread-second", ownership_status: "candidate", rotation_state: "rotation_pending", accepts_new_work: false })
  ]);
  assert(codes(duplicateGeneration).includes("session_binding_generation_unique"));

  const duplicateThread = state([
    owner(),
    owner({ session_id: "session-support", agent_id: "user-support", profile_id: "foundation:user-support:v1" })
  ].sort((left, right) => left.agent_id < right.agent_id ? -1 : 1));
  assert(codes(duplicateThread).includes("session_binding_thread_unique"));

  const unordered = state([
    owner({ session_id: "session-g2", session_generation: 2, ownership_status: "candidate", rotation_state: "rotation_pending", accepts_new_work: false, handoff_status: "pending", handoff_turn_id: null, accepted_at: null, binding_status: "provisioning", thread_id: null }),
    owner()
  ]);
  assert(codes(unordered).includes("session_binding_sorted"));
  assert.equal(validateContract("session-binding-state-v1", { ...state(), revision: Number.MAX_SAFE_INTEGER + 1 }).ok, false);
  assert.equal(validateContract("session-binding-state-v1", state([owner({ session_generation: Number.MAX_SAFE_INTEGER + 1 })])).ok, false);
});

test("replacement links are symmetric, same-agent, increasing, and acyclic", () => {
  const predecessor = owner({
    ownership_status: "superseded",
    rotation_state: "superseded",
    accepts_new_work: false,
    replaced_by_session_id: "session-orchestrator-g2",
    ownership_ended_at: "2026-08-24T04:01:00.000Z",
    updated_at: "2026-08-24T04:01:00.000Z"
  });
  const successor = owner({
    session_id: "session-orchestrator-g2",
    thread_id: "thread-orchestrator-g2",
    session_generation: 2,
    handoff_turn_id: "turn-orchestrator-g2",
    profile_id: "rotation:orchestrator:g2",
    replaces_session_id: predecessor.session_id,
    ownership_started_at: "2026-08-24T04:01:00.000Z",
    updated_at: "2026-08-24T04:01:00.000Z"
  });
  assert.equal(validateContract("session-binding-state-v1", state([predecessor, successor])).ok, true);

  const asymmetric = state([predecessor, { ...successor, replaces_session_id: null }]);
  assert(codes(asymmetric).includes("session_binding_replacement_symmetric"));

  const crossAgent = clone(state([predecessor, successor]));
  crossAgent.sessions[1].agent_id = "user-support";
  assert(codes(crossAgent).includes("session_binding_replacement_agent"));

  const cyclic = clone(state([predecessor, successor]));
  cyclic.sessions[0].replaces_session_id = successor.session_id;
  cyclic.sessions[1].replaced_by_session_id = predecessor.session_id;
  assert(codes(cyclic).includes("session_binding_replacement_cycle"));

  const partialCutover = state([
    { ...predecessor, ownership_ended_at: "2026-08-24T04:03:00.000Z", updated_at: "2026-08-24T04:03:00.000Z" },
    { ...successor, ownership_started_at: "2026-08-24T04:04:00.000Z", updated_at: "2026-08-24T04:04:00.000Z" }
  ]);
  assert(codes(partialCutover).includes("session_binding_cutover_timestamp"));
});

test("immutable ownership edges preserve a contiguous multi-generation chain", () => {
  const first = owner({
    rotation_state: "superseded",
    ownership_status: "superseded",
    accepts_new_work: false,
    replaced_by_session_id: "session-orchestrator-g2",
    ownership_ended_at: "2026-08-24T04:10:00.000Z",
    updated_at: "2026-08-24T04:10:00.000Z"
  });
  const second = owner({
    session_id: "session-orchestrator-g2",
    thread_id: "thread-orchestrator-g2",
    session_generation: 2,
    handoff_turn_id: "turn-orchestrator-g2",
    accepted_at: "2026-08-24T04:06:00.000Z",
    rotation_state: "superseded",
    ownership_status: "superseded",
    accepts_new_work: false,
    replaces_session_id: first.session_id,
    replaced_by_session_id: "session-orchestrator-g3",
    profile_id: "rotation:orchestrator:g2",
    ownership_started_at: "2026-08-24T04:10:00.000Z",
    ownership_ended_at: "2026-08-24T04:20:00.000Z",
    created_at: "2026-08-24T04:05:00.000Z",
    updated_at: "2026-08-24T04:20:00.000Z"
  });
  const third = owner({
    session_id: "session-orchestrator-g3",
    thread_id: "thread-orchestrator-g3",
    session_generation: 3,
    handoff_turn_id: "turn-orchestrator-g3",
    accepted_at: "2026-08-24T04:16:00.000Z",
    replaces_session_id: second.session_id,
    profile_id: "rotation:orchestrator:g3",
    ownership_started_at: "2026-08-24T04:20:00.000Z",
    created_at: "2026-08-24T04:15:00.000Z",
    updated_at: "2026-08-24T04:20:00.000Z"
  });
  assert.equal(validateContract("session-binding-state-v1", state([first, second, third])).ok, true);

  const brokenHistoricalEdge = clone(state([first, second, third]));
  brokenHistoricalEdge.sessions[1].ownership_started_at = "2026-08-24T04:11:00.000Z";
  assert(codes(brokenHistoricalEdge).includes("session_binding_cutover_timestamp"));
});

test("retired is an evidence-preserving non-rotation terminal binding", () => {
  const retired = owner({
    rotation_state: "retired",
    ownership_status: "retired",
    accepts_new_work: false,
    ownership_ended_at: "2026-08-24T04:01:00.000Z",
    updated_at: "2026-08-24T04:01:00.000Z"
  });
  assert.equal(validateContract("session-binding-state-v1", state([retired])).ok, true);
  assert(codes(state([{ ...retired, ownership_ended_at: null }])).includes("session_binding_ownership_window"));
  assert(codes(state([{ ...retired, replaced_by_session_id: "session-missing" }])).includes("session_binding_cutover_state"));

  const retainedFailure = owner({
    session_id: "session-orchestrator-attempt-a",
    thread_id: "thread-orchestrator-attempt-a",
    session_generation: 2,
    handoff_status: "failed",
    handoff_turn_id: null,
    accepted_at: null,
    rotation_state: "failed",
    ownership_status: "candidate",
    accepts_new_work: false,
    binding_status: "authority_unverified",
    replaces_session_id: retired.session_id,
    profile_id: "rotation:orchestrator:g2",
    runtime_authority_id: null,
    ownership_started_at: null,
    ownership_ended_at: null,
    created_at: "2026-08-24T04:00:10.000Z",
    updated_at: "2026-08-24T04:00:20.000Z"
  });
  assert.equal(validateContract("session-binding-state-v1", state([retired, retainedFailure])).ok, true);
  assert(codes(state([retired, { ...retainedFailure, updated_at: retired.ownership_ended_at }]))
    .includes("session_binding_failed_attempt_chronology"));
});

test("warming and verified successors preserve one-way lineage until atomic cutover", () => {
  const predecessor = owner({
    rotation_state: "checkpointed",
    accepts_new_work: false
  });
  const warming = owner({
    session_id: "session-orchestrator-g2",
    thread_id: "thread-orchestrator-g2",
    session_generation: 2,
    handoff_status: "pending",
    handoff_turn_id: null,
    accepted_at: null,
    rotation_state: "successor_warming",
    ownership_status: "candidate",
    accepts_new_work: false,
    binding_status: "provisioning",
    replaces_session_id: predecessor.session_id,
    profile_id: "rotation:orchestrator:g2",
    runtime_authority_id: null,
    ownership_started_at: null,
    ownership_ended_at: null,
    created_at: "2026-08-24T04:01:00.000Z",
    updated_at: "2026-08-24T04:01:00.000Z"
  });
  assert.equal(validateContract("session-binding-state-v1", state([predecessor, warming])).ok, true);

  const checkpointedLater = {
    ...predecessor,
    updated_at: "2026-08-24T04:05:00.000Z"
  };
  assert(codes(state([checkpointedLater, warming])).includes("session_binding_candidate_chronology"));

  const verified = {
    ...warming,
    handoff_status: "accepted",
    handoff_turn_id: "turn-orchestrator-g2",
    accepted_at: "2026-08-24T04:02:00.000Z",
    rotation_state: "successor_verified",
    binding_status: "bound",
    runtime_authority_id: "runtime-authority-a",
    updated_at: "2026-08-24T04:02:00.000Z"
  };
  assert.equal(validateContract("session-binding-state-v1", state([predecessor, verified])).ok, true);
  assert(codes(state([predecessor, { ...verified, runtime_authority_id: "runtime-authority-b" }]))
    .includes("session_binding_replacement_runtime_authority"));

  assert(codes(state([predecessor, { ...warming, replaces_session_id: null }]))
    .includes("session_binding_successor_lineage"));
  assert(codes(state([predecessor, { ...warming, session_generation: 3 }]))
    .includes("session_binding_replacement_generation"));
  const duplicateCandidate = {
    ...warming,
    session_id: "session-orchestrator-g3",
    thread_id: "thread-orchestrator-g3",
    session_generation: 3,
    profile_id: "rotation:orchestrator:g3"
  };
  assert(codes(state([predecessor, warming, duplicateCandidate])).includes("session_binding_candidate_unique"));

  const failed = {
    ...warming,
    handoff_status: "failed",
    rotation_state: "failed",
    binding_status: "authority_unverified",
    updated_at: "2026-08-24T04:02:00.000Z"
  };
  assert.equal(validateContract("session-binding-state-v1", state([predecessor, failed])).ok, true);
  assert(codes(state([predecessor, { ...failed, replaces_session_id: null }]))
    .includes("session_binding_successor_lineage"));
});

test("the lifecycle matrix rejects incomplete or contradictory persisted rows", () => {
  assert(codes(state([owner({
    session_generation: 2,
    session_id: "session-orchestrator-g2",
    thread_id: "thread-orchestrator-g2",
    handoff_turn_id: "turn-orchestrator-g2",
    replaces_session_id: null
  })])).includes("session_binding_successor_lineage"));

  const checkpointed = owner({ rotation_state: "checkpointed", accepts_new_work: false });
  const warming = owner({
    session_id: "session-orchestrator-g2",
    thread_id: null,
    session_generation: 2,
    handoff_status: "pending",
    handoff_turn_id: null,
    accepted_at: null,
    rotation_state: "successor_warming",
    ownership_status: "candidate",
    accepts_new_work: false,
    binding_status: "provisioning",
    replaces_session_id: checkpointed.session_id,
    profile_id: "rotation:orchestrator:g2",
    runtime_authority_id: null,
    ownership_started_at: null,
    ownership_ended_at: null,
    created_at: "2026-08-24T04:01:00.000Z",
    updated_at: "2026-08-24T04:01:00.000Z"
  });
  assert(codes(state([checkpointed, warming])).includes("type"));
  assert(codes(state([checkpointed, {
    ...warming,
    thread_id: "thread-orchestrator-g2",
    handoff_status: "failed",
    binding_status: "authority_unverified"
  }])).includes("session_binding_lifecycle_matrix"));
  assert(codes(state([owner({
    handoff_status: "failed",
    handoff_turn_id: null,
    accepted_at: null,
    rotation_state: "failed",
    ownership_status: "candidate",
    accepts_new_work: false,
    binding_status: "authority_unverified",
    runtime_authority_id: null
  })])).includes("session_binding_initial_candidate"));
});

test("failed rotation attempts remain durable while one retry owns the generation", () => {
  const predecessor = owner({ rotation_state: "checkpointed", accepts_new_work: false });
  const failedAttempt = (suffix, createdAt, updatedAt) => owner({
    session_id: `session-orchestrator-attempt-${suffix}`,
    thread_id: `thread-orchestrator-attempt-${suffix}`,
    session_generation: 2,
    handoff_status: "failed",
    handoff_turn_id: null,
    accepted_at: null,
    rotation_state: "failed",
    ownership_status: "candidate",
    accepts_new_work: false,
    binding_status: "authority_unverified",
    replaces_session_id: predecessor.session_id,
    profile_id: "rotation:orchestrator:g2",
    runtime_authority_id: null,
    ownership_started_at: null,
    ownership_ended_at: null,
    created_at: createdAt,
    updated_at: updatedAt
  });
  const attemptA = failedAttempt("a", "2026-08-24T04:01:00.000Z", "2026-08-24T04:02:00.000Z");
  const attemptB = failedAttempt("b", "2026-08-24T04:03:00.000Z", "2026-08-24T04:04:00.000Z");
  attemptB.retry_of_session_id = attemptA.session_id;
  const retry = {
    ...failedAttempt("c", "2026-08-24T04:05:00.000Z", "2026-08-24T04:05:00.000Z"),
    handoff_status: "pending",
    rotation_state: "successor_warming",
    binding_status: "provisioning",
    retry_of_session_id: attemptB.session_id
  };
  assert.equal(validateContract("session-binding-state-v1", state([predecessor, attemptA, attemptB, retry])).ok, true);
  assert(codes(state([predecessor, attemptA, attemptB, { ...retry, retry_of_session_id: attemptA.session_id }]))
    .includes("session_binding_retry_branch"));
  assert(codes(state([predecessor, attemptA, { ...retry, retry_of_session_id: null }]))
    .includes("session_binding_retry_lineage"));

  const successful = {
    ...retry,
    session_id: "session-orchestrator-g2",
    thread_id: "thread-orchestrator-g2",
    handoff_status: "accepted",
    handoff_turn_id: "turn-orchestrator-g2",
    accepted_at: "2026-08-24T04:06:00.000Z",
    rotation_state: "active",
    ownership_status: "owner",
    accepts_new_work: true,
    binding_status: "bound",
    runtime_authority_id: "runtime-authority-a",
    ownership_started_at: "2026-08-24T04:10:00.000Z",
    updated_at: "2026-08-24T04:10:00.000Z"
  };
  const superseded = {
    ...predecessor,
    rotation_state: "superseded",
    ownership_status: "superseded",
    replaced_by_session_id: successful.session_id,
    ownership_ended_at: "2026-08-24T04:10:00.000Z",
    updated_at: "2026-08-24T04:10:00.000Z"
  };
  assert.equal(validateContract("session-binding-state-v1", state([
    superseded,
    attemptA,
    attemptB,
    successful
  ])).ok, true);
});
