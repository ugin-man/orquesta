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
    context_packs: [], current_context_pack_id: null, current_context_pack_sequence: null,
    execution_plans: [], current_execution_plan_id: null, phase_reviews: [],
    install_requests: [], current_install_request: null, install_authorizations: [],
    acquisition_snapshots: [], audit_evaluations: [], audition_results: [],
    evidence_by_id: {}, evidence_by_correlation: {}, runtime_by_correlation: {}, reports: [], acceptances: [], timeline: [],
  };
}

function replaceById(items, value, field) {
  const next = items.filter((item) => item[field] !== value[field]);
  next.push(clone(value));
  return next.sort((left, right) => compareText(String(left[field]), String(right[field])));
}

const MAX_OPERATION_RECORDS = 128;

function replaceBoundedById(items, value, field, sequence) {
  const stored = { ...clone(value), sequence };
  return items
    .filter((item) => item[field] !== stored[field])
    .concat(stored)
    .sort((left, right) => (left.sequence || 0) - (right.sequence || 0)
      || compareText(String(left[field]), String(right[field])))
    .slice(-MAX_OPERATION_RECORDS);
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

const MAX_CORRELATION_EVIDENCE = 32;
const MAX_EVIDENCE_CORRELATIONS = 128;

function retainEvidenceWindow(evidenceByCorrelation, runtimeByCorrelation) {
  const retainedIds = Object.entries(evidenceByCorrelation)
    .filter(([, chain]) => Array.isArray(chain) && chain.length > 0)
    .sort(([leftId, leftChain], [rightId, rightChain]) => {
      const sequenceOrder = (rightChain.at(-1).sequence || 0) - (leftChain.at(-1).sequence || 0);
      return sequenceOrder || compareText(leftId, rightId);
    })
    .slice(0, MAX_EVIDENCE_CORRELATIONS)
    .map(([correlationId]) => correlationId)
    .sort(compareText);
  const retainedCorrelations = {};
  const retainedEvidence = {};
  const retainedRuntime = {};
  for (const correlationId of retainedIds) {
    const chain = evidenceByCorrelation[correlationId];
    retainedCorrelations[correlationId] = chain;
    for (const evidence of chain) retainedEvidence[evidence.evidence_id] = evidence;
    if (runtimeByCorrelation[correlationId]) retainedRuntime[correlationId] = runtimeByCorrelation[correlationId];
  }
  return {
    evidence_by_id: retainedEvidence,
    evidence_by_correlation: retainedCorrelations,
    runtime_by_correlation: retainedRuntime,
  };
}

function projectEvidence(state, event, batch) {
  const evidence = event.payload && event.payload.evidence;
  if (!evidence || typeof evidence !== "object" || typeof evidence.evidence_id !== "string" || typeof evidence.correlation_id !== "string") return state;
  const stored = { ...clone(evidence), sequence: batch.sequence };
  const prior = state.evidence_by_correlation[evidence.correlation_id] || [];
  const chain = [...prior.filter((item) => item.evidence_id !== evidence.evidence_id), stored].slice(-MAX_CORRELATION_EVIDENCE);
  const runtime = state.runtime_by_correlation[evidence.correlation_id] || { dispatch_evidence_id: null, active_turn: null };
  let nextRuntime = runtime;
  if (evidence.kind === "runtime_dispatch") nextRuntime = { dispatch_evidence_id: evidence.evidence_id, active_turn: null };
  if (evidence.kind === "runtime_event" && evidence.event_kind === "turn_started") {
    nextRuntime = { ...runtime, active_turn: { evidence_id: evidence.evidence_id, thread_id: evidence.thread_id, turn_id: evidence.turn_id } };
  }
  if (evidence.kind === "runtime_event" && evidence.event_kind === "turn_completed") {
    nextRuntime = { ...runtime, active_turn: null };
  }
  const retained = retainEvidenceWindow(
    { ...state.evidence_by_correlation, [evidence.correlation_id]: chain },
    { ...state.runtime_by_correlation, [evidence.correlation_id]: nextRuntime },
  );
  return { ...state, ...retained };
}

function withEvidence(reducer) {
  return withTimeline((state, event, batch) => reducer(projectEvidence(state, event, batch), event, batch));
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
    "execution.plan.created": withTimeline((state, event) => ({
      ...state,
      execution_plans: replaceById(state.execution_plans, event.payload.execution_plan, "execution_plan_id"),
      current_execution_plan_id: event.payload.execution_plan.execution_plan_id,
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
    "candidate.install.requested": withTimeline((state, event) => ({
      ...state,
      install_requests: replaceById(state.install_requests, event.payload.install_request, "request_id"),
      current_install_request: clone(event.payload.install_request),
    })),
    "candidate.install.authorized": withTimeline((state, event) => ({
      ...state,
      install_requests: state.install_requests.map((request) => request.request_id === event.payload.authorization.request_id
        ? { ...request, status: "authorized", authorization_id: event.payload.authorization.authorization_id }
        : request),
      current_install_request: state.current_install_request && state.current_install_request.request_id === event.payload.authorization.request_id
        ? { ...state.current_install_request, status: "authorized", authorization_id: event.payload.authorization.authorization_id }
        : state.current_install_request,
      install_authorizations: replaceById(state.install_authorizations, event.payload.authorization, "authorization_id"),
    })),
    "acquisition.snapshot.recorded": withTimeline((state, event, batch) => ({
      ...state,
      acquisition_snapshots: replaceBoundedById(
        state.acquisition_snapshots,
        event.payload.acquisition_snapshot,
        "query_id",
        batch.sequence,
      ),
    })),
    "candidate.audit.recorded": withTimeline((state, event, batch) => ({
      ...state,
      audit_evaluations: replaceBoundedById(
        state.audit_evaluations,
        event.payload.evaluation,
        "evaluation_id",
        batch.sequence,
      ),
    })),
    "candidate.audition.recorded": withTimeline((state, event, batch) => ({
      ...state,
      audition_results: replaceBoundedById(
        state.audition_results,
        event.payload.audition_result,
        "audition_plan_id",
        batch.sequence,
      ),
    })),
    "runtime.dispatch.accepted": withEvidence((state) => state),
    "runtime.turn.started": withEvidence((state) => state),
    "runtime.progress.observed": withEvidence((state) => state),
    "runtime.turn.completed": withEvidence((state) => state),
    "artifact.produced": withEvidence((state, event) => ({
      ...state,
      artifacts: replaceById(state.artifacts, event.payload.artifact, "artifact_ref"),
    })),
    "report.produced": withEvidence((state, event) => ({
      ...state,
      reports: replaceById(state.reports, event.payload.evidence, "evidence_id"),
    })),
    "acceptance.completed": withEvidence((state, event) => ({
      ...state,
      acceptances: replaceById(state.acceptances, event.payload.evidence, "evidence_id"),
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
