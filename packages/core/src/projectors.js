"use strict";

const { canonicalHash } = require("@orquesta/contracts");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function initialProjection() {
  return {
    task_intents: [], current_task_intent_id: null, capability_graphs: [], current_capability_graph_id: null,
    providers: [], inventory: null, candidate_evaluations: [], resolutions: [], artifacts: [], latest_resolution_by_need: {}, resolution_bindings: {},
    context_packs: [], current_context_pack_id: null, current_context_pack_sequence: null, phase_reviews: [], timeline: [],
  };
}

function replaceById(items, value, field) {
  const next = items.filter((item) => item[field] !== value[field]);
  next.push(clone(value));
  return next.sort((left, right) => compareText(String(left[field]), String(right[field])));
}

function timeline(state, event, batch) {
  const base = { ...initialProjection(), ...state };
  return {
    ...base,
    timeline: [...base.timeline, {
      sequence: batch.sequence,
      batch_id: batch.batch_id,
      event_id: event.event_id,
      type: event.type,
      actor: clone(batch.actor),
      responsibility: event.payload && typeof event.payload.responsibility === "string" && event.payload.responsibility
        ? event.payload.responsibility
        : "unattributed",
      command_identity: event.payload.command_identity ? clone(event.payload.command_identity) : null,
      scout_skip_reason: event.payload.scout_skip_reason || null,
      evidence_refs: [...event.evidence_refs],
    }],
  };
}

function withTimeline(reducer) {
  return (state, event, batch) => reducer(timeline(state, event, batch), event, batch);
}

function createProjectors() {
  return {
    "task.intent.created": withTimeline((state, event) => ({
      ...state,
      task_intents: replaceById(state.task_intents, event.payload.task_intent, "task_intent_id"),
      current_task_intent_id: event.payload.task_intent.task_intent_id,
    })),
    "capability.need.declared": withTimeline((state, event) => state),
    "capability.graph.compiled": withTimeline((state, event) => ({
      ...state,
      capability_graphs: replaceById(state.capability_graphs, event.payload.graph, "graph_id"),
      current_capability_graph_id: event.payload.graph.graph_id,
    })),
    "capability.provider.discovered": withTimeline((state, event) => ({
      ...state,
      providers: replaceById(state.providers, event.payload.provider, "provider_id"),
    })),
    "capability.inventory.refreshed": withTimeline((state, event) => ({
      ...state,
      providers: state.providers
        .filter((provider) => event.payload.provider_ids.includes(provider.provider_id))
        .sort((left, right) => compareText(left.provider_id, right.provider_id)),
      inventory: {
        inventory_id: event.payload.inventory_id,
        provider_ids: [...event.payload.provider_ids],
        conflicts: clone(event.payload.conflicts || []),
      },
    })),
    "candidate.evaluated": withTimeline((state, event) => ({
      ...state,
      candidate_evaluations: replaceById(state.candidate_evaluations, event.payload.evaluation, "evaluation_id"),
    })),
    "resolution.proposed": withTimeline((state, event, batch) => ({
      ...state,
      resolutions: replaceById(state.resolutions, event.payload.resolution, "resolution_id"),
      resolution_bindings: {
        ...state.resolution_bindings,
        [event.payload.resolution.resolution_id]: event.payload.proposal_binding ? clone(event.payload.proposal_binding) : null,
      },
      latest_resolution_by_need: {
        ...state.latest_resolution_by_need,
        [event.payload.resolution.need_id]: { resolution_id: event.payload.resolution.resolution_id, sequence: batch.sequence },
      },
    })),
    "resolution.approved": withTimeline((state, event) => ({
      ...state,
      resolutions: state.resolutions.map((resolution) => resolution.resolution_id === event.payload.resolution_id
        ? { ...resolution, status: "approved", approval_status: "approved", reevaluate_when: [...resolution.reevaluate_when] }
        : resolution),
    })),
    "context.pack.created": withTimeline((state, event, batch) => ({
      ...state,
      context_packs: replaceById(state.context_packs, event.payload.context_pack, "context_pack_id"),
      current_context_pack_id: event.payload.context_pack.context_pack_id,
      current_context_pack_sequence: batch.sequence,
    })),
    "artifact.produced": withTimeline((state, event) => ({
      ...state,
      artifacts: replaceById(state.artifacts, event.payload.artifact, "artifact_ref"),
    })),
    "phase.review.requested": withTimeline((state, event) => ({
      ...state,
      phase_reviews: replaceById(state.phase_reviews, event.payload.review, "phase_id"),
    })),
    "phase.review.ready_for_user_review": withTimeline((state, event) => ({
      ...state,
      phase_reviews: replaceById(state.phase_reviews, event.payload.review, "phase_id"),
    })),
    "phase.review.changes_requested": withTimeline((state, event) => ({
      ...state,
      phase_reviews: replaceById(state.phase_reviews, event.payload.review, "phase_id"),
    })),
    "phase.review.approved": withTimeline((state, event) => ({
      ...state,
      phase_reviews: replaceById(state.phase_reviews, event.payload.review, "phase_id"),
    })),
  };
}

function replayProjection(entries) {
  let state = initialProjection();
  const reducers = createProjectors();
  for (const batch of entries || []) for (const event of batch.events || []) {
    const reducer = reducers[event.type];
    if (reducer) state = reducer(state, event, batch);
  }
  return state;
}

function projectionHash(state) {
  return canonicalHash(state);
}

module.exports = { createProjectors, initialProjection, replayProjection, projectionHash };
