import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import eventStoreModule from '../../../../packages/event-store/src/index.js';
import coreModule from '../../../../packages/core/src/index.js';
import {
  emptyV4OperationsSnapshot,
  isV4OperationsSnapshot,
  type V4AcquisitionSnapshotUi,
  type V4AuditTimelineItemUi,
  type V4CandidateEvaluationUi,
  type V4EvidenceItemUi,
  type V4OperationsSnapshot,
} from '../../src/contracts/orquesta-ui';

const { createEventStore } = eventStoreModule as { createEventStore(options: Record<string, unknown>): { replay(options?: Record<string, unknown>): { state: Record<string, unknown>; watermark?: { journal_sequence?: number } } } };
const { createProjectors, initialProjection } = coreModule as {
  createProjectors(): Record<string, unknown>;
  initialProjection(): Record<string, unknown>;
};

const MAX_TIMELINE_ITEMS = 500;
const MAX_EVIDENCE_ITEMS = 32;
const MAX_EVIDENCE_CORRELATIONS = 128;
const MAX_COLLECTION_ITEMS = 128;

function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

function records(value: unknown): Array<Record<string, any>> {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object' && !Array.isArray(item)) : [];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function nullableText(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function currentById(state: Record<string, any>, collection: string, currentId: string, idField: string): Record<string, any> | null {
  const id = text(state[currentId]);
  return records(state[collection]).find((item) => text(item[idField]) === id) ?? null;
}

function candidateEvaluation(item: Record<string, any>): V4CandidateEvaluationUi {
  return {
    id: text(item.evaluation_id),
    candidateId: text(item.candidate_id),
    needId: text(item.need_id),
    score: numberValue(item.candidate_score),
    eligibility: text(item.eligibility, 'unknown'),
    hardGates: records(item.hard_gate_results).map((gate) => ({
      name: text(gate.gate),
      status: text(gate.status, 'unknown'),
      reason: text(gate.reason),
    })),
    actualModel: nullableText(item.actual_model),
  };
}

function acquisitionSnapshot(item: Record<string, any>): V4AcquisitionSnapshotUi {
  const query = record(item.query);
  const requestBudget = record(query.request_budget);
  const budget = record(item.budget);
  return {
    queryId: text(item.query_id),
    needId: text(query.need_id),
    queryTerms: strings(query.query_terms),
    requestedAt: text(query.requested_at),
    maxRequests: numberValue(requestBudget.max_requests_per_need),
    consumedRequests: numberValue(budget.consumed_total),
    remainingRequests: numberValue(budget.remaining_total),
    sources: records(item.source_results).map((source) => ({
      connectorId: text(source.connector_id),
      trustTier: text(source.trust_tier, 'unknown'),
      status: text(source.status, 'unknown'),
      fetchedAt: text(source.fetched_at),
      expiresAt: text(source.expires_at),
      candidateIds: records(source.candidates).map((candidate) => text(candidate.candidate_id)).filter(Boolean),
      sourceEvidenceRefs: records(source.source_evidence).map((evidence) => text(evidence.source_ref)).filter(Boolean),
      cacheStatus: text(source.cache_status, 'unknown'),
    })).sort((left, right) => compareText(left.connectorId, right.connectorId)),
  };
}

function evidenceItem(item: Record<string, any>): V4EvidenceItemUi {
  return {
    id: text(item.evidence_id),
    kind: text(item.kind, 'unknown'),
    correlationId: text(item.correlation_id),
    threadId: nullableText(item.thread_id),
    turnId: nullableText(item.turn_id),
    predecessorId: nullableText(item.predecessor_evidence_id),
    ref: nullableText(item.artifact_ref) ?? nullableText(item.report_ref) ?? nullableText(item.acceptance_ref) ?? nullableText(item.request_ref),
    sequence: numberValue(item.sequence),
  };
}

function timelineItem(item: Record<string, any>): V4AuditTimelineItemUi {
  const actor = record(item.actor);
  const command = record(item.command_identity);
  return {
    sequence: numberValue(item.sequence),
    eventId: text(item.event_id),
    type: text(item.type),
    actorId: text(actor.id, 'unknown'),
    responsibility: text(item.responsibility, 'unattributed'),
    commandName: nullableText(command.name),
    scoutSkipReason: nullableText(item.scout_skip_reason),
    evidenceRefs: strings(item.evidence_refs),
  };
}

function projectState(state: Record<string, any>, revision: number): V4OperationsSnapshot {
  const taskIntent = currentById(state, 'task_intents', 'current_task_intent_id', 'task_intent_id');
  const graph = currentById(state, 'capability_graphs', 'current_capability_graph_id', 'graph_id');
  const contextPack = currentById(state, 'context_packs', 'current_context_pack_id', 'context_pack_id');
  const evaluationMap = new Map<string, Record<string, any>>();
  for (const item of [...records(state.candidate_evaluations), ...records(state.audit_evaluations)]) {
    const id = text(item.evaluation_id);
    if (id) evaluationMap.set(id, item);
  }
  const latestResolutions = Object.values(record(state.latest_resolution_by_need))
    .sort((left, right) => numberValue(record(left).sequence) - numberValue(record(right).sequence))
    .map((entry) => records(state.resolutions).find((item) => item.resolution_id === record(entry).resolution_id))
    .filter((item): item is Record<string, any> => Boolean(item));
  const install = record(state.current_install_request);
  const target = record(install.target);
  const evidenceChains = Object.entries(record(state.evidence_by_correlation))
    .map(([correlationId, chain]) => ({
      correlationId,
      items: records(chain).slice(-MAX_EVIDENCE_ITEMS).map(evidenceItem).sort((left, right) => left.sequence - right.sequence || compareText(left.id, right.id)),
    }))
    .filter((chain) => chain.items.length > 0)
    .sort((left, right) => {
      const sequence = (right.items.at(-1)?.sequence ?? 0) - (left.items.at(-1)?.sequence ?? 0);
      return sequence || compareText(left.correlationId, right.correlationId);
    })
    .slice(0, MAX_EVIDENCE_CORRELATIONS)
    .sort((left, right) => compareText(left.correlationId, right.correlationId));
  const runtimeCorrelations = Object.entries(record(state.runtime_by_correlation)).map(([correlationId, raw]) => {
    const runtime = record(raw);
    const active = record(runtime.active_turn);
    return {
      correlationId,
      dispatchEvidenceId: nullableText(runtime.dispatch_evidence_id),
      activeThreadId: nullableText(active.thread_id),
      activeTurnId: nullableText(active.turn_id),
    };
  }).sort((left, right) => compareText(left.correlationId, right.correlationId));

  return {
    available: true,
    revision,
    taskIntent: taskIntent ? {
      id: text(taskIntent.task_intent_id),
      desiredOutcome: text(taskIntent.desired_outcome),
      acceptanceCriteria: strings(taskIntent.acceptance_criteria),
      rawRequestRef: text(taskIntent.raw_request_ref),
    } : null,
    capabilityNeeds: records(graph?.needs).map((need) => ({
      id: text(need.need_id),
      description: text(need.description),
      kind: text(need.kind),
      requiredLevel: text(need.required_level),
      status: text(need.status, 'unknown'),
      confidence: numberValue(need.confidence),
    })).sort((left, right) => compareText(left.id, right.id)).slice(0, MAX_COLLECTION_ITEMS),
    providers: records(state.providers).map((provider) => ({
      id: text(provider.provider_id),
      type: text(provider.provider_type),
      sourceUri: text(provider.source_uri),
      capabilities: strings(provider.capabilities),
      trustTier: text(provider.trust_tier, 'unknown'),
      availability: text(provider.availability, 'unknown'),
      version: text(provider.version),
      lastVerifiedAt: text(provider.last_verified_at),
      evidenceRefs: strings(provider.evidence_refs),
    })).sort((left, right) => compareText(left.id, right.id)).slice(0, MAX_COLLECTION_ITEMS),
    candidateEvaluations: [...evaluationMap.values()].map(candidateEvaluation)
      .sort((left, right) => compareText(left.id, right.id)).slice(-MAX_COLLECTION_ITEMS),
    latestResolutions: latestResolutions.slice(-MAX_COLLECTION_ITEMS).map((resolution) => ({
      id: text(resolution.resolution_id),
      needId: text(resolution.need_id),
      mode: text(resolution.mode),
      providerId: nullableText(resolution.selected_provider_id),
      approvalStatus: text(resolution.approval_status, 'unknown'),
      totalCost: numberValue(resolution.total_cost),
    })),
    contextPack: contextPack ? {
      id: text(contextPack.context_pack_id),
      ownerAgentId: text(contextPack.owner_agent_id),
      objective: text(contextPack.objective),
      requiredReading: strings(contextPack.required_reading),
      resolutionIds: strings(contextPack.capability_resolutions),
      status: text(contextPack.status, 'unknown'),
    } : null,
    acquisitionSnapshots: records(state.acquisition_snapshots).slice(-MAX_COLLECTION_ITEMS)
      .map(acquisitionSnapshot).sort((left, right) => compareText(left.queryId, right.queryId)),
    auditionResults: records(state.audition_results).slice(-MAX_COLLECTION_ITEMS).map((result) => ({
      planId: text(result.audition_plan_id),
      verdict: text(result.verdict, 'unknown'),
      observedProfile: text(result.observed_codex_profile),
      cleanupEvidence: strings(result.cleanup_evidence),
      evidenceRefs: strings(result.evidence_refs),
    })).sort((left, right) => compareText(left.planId, right.planId)),
    installRequest: text(install.request_id) ? {
      id: text(install.request_id),
      status: text(install.status, 'unknown'),
      candidateId: text(target.candidate_id),
      expiresAt: nullableText(target.expires_at),
    } : null,
    evidenceChains,
    runtimeCorrelations: runtimeCorrelations.slice(0, MAX_COLLECTION_ITEMS),
    auditTimeline: records(state.timeline).slice(-MAX_TIMELINE_ITEMS).map(timelineItem)
      .sort((left, right) => left.sequence - right.sequence || compareText(left.eventId, right.eventId)),
    phaseReviews: records(state.phase_reviews).map((review) => ({
      phaseId: text(review.phase_id),
      status: text(review.status, 'unknown'),
      reviewPacketRef: text(review.review_packet_ref),
      buildRef: text(review.build_ref),
    })).sort((left, right) => compareText(left.phaseId, right.phaseId)).slice(-MAX_COLLECTION_ITEMS),
    limitation: null,
  };
}

export async function projectV4Operations(rootPath: string): Promise<V4OperationsSnapshot> {
  const stateRoot = path.join(rootPath, '.orquesta', 'v4');
  const journalPath = path.join(stateRoot, 'events.jsonl');
  try {
    if (!existsSync(journalPath) || !statSync(journalPath).isFile()) {
      return emptyV4OperationsSnapshot('V4 journal unavailable');
    }
    const store = createEventStore({ stateRoot, reducers: createProjectors(), initialState: initialProjection() });
    const replayed = store.replay();
    const projected = projectState(replayed.state, numberValue(replayed.watermark?.journal_sequence));
    return isV4OperationsSnapshot(projected)
      ? projected
      : emptyV4OperationsSnapshot('V4 projection exceeded the bounded Desktop contract');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return emptyV4OperationsSnapshot(`V4 journal unavailable · ${reason.slice(0, 160)}`);
  }
}
