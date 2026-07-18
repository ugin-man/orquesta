import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { isV4OperationsSnapshot } from '../../src/contracts/orquesta-ui';
import { projectV4Operations } from './v4-operations-projection';

const require = createRequire(import.meta.url);
const { createEventStore } = require('../../../../packages/event-store/src');
const { createProjectors, initialProjection } = require('../../../../packages/core/src');
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(label: string): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), `orquesta-desktop-v4-${label}-`));
  temporaryRoots.push(value);
  return value;
}

function createJournal(projectRoot: string) {
  const stateRoot = path.join(projectRoot, '.orquesta', 'v4');
  const store = createEventStore({
    stateRoot,
    workspaceId: 'desktop-v4-projection',
    clock: () => '2026-07-19T00:00:00.000Z',
    reducers: createProjectors(),
    initialState: initialProjection(),
  });
  let revision = 0;
  return {
    commit(type: string, payload: Record<string, unknown>, evidenceRefs: string[] = []) {
      revision += 1;
      store.commit({
        expected_revision: revision - 1,
        batch_id: `batch-${revision}`,
        actor: { type: 'agent', id: 'fixture' },
        correlation_id: `corr-${revision}`,
        events: [{
          event_id: `event-${revision}`,
          schema_version: 1,
          type,
          payload: { ...payload, responsibility: 'fixture' },
          evidence_refs: evidenceRefs,
        }],
      });
    },
    commitAll(events: Array<{ type: string; payload: Record<string, unknown> }>) {
      revision += 1;
      store.commit({
        expected_revision: revision - 1,
        batch_id: `batch-${revision}`,
        actor: { type: 'agent', id: 'fixture' },
        correlation_id: `corr-${revision}`,
        events: events.map((event, index) => ({
          event_id: `event-${revision}-${index}`,
          schema_version: 1,
          type: event.type,
          payload: { ...event.payload, responsibility: 'fixture' },
          evidence_refs: [],
        })),
      });
    },
  };
}

function phase1Journal(projectRoot: string) {
  const journal = createJournal(projectRoot);
  journal.commit('task.intent.created', {
    task_intent: {
      task_intent_id: 'TI-desktop', raw_request_ref: 'request:desktop', desired_outcome: 'Ship Orquesta Desktop',
      acceptance_criteria: ['Desktop is reviewable'], constraints: [], risk: { impact: 'low', reversible: true },
      authority_boundary: { agent_may: ['propose'], user_only: ['approve'] }, assumptions: [], status: 'compiled',
    },
  });
  journal.commit('capability.graph.compiled', {
    graph: {
      graph_id: 'GRAPH-desktop', task_intent_id: 'TI-desktop', status: 'compiled',
      needs: [{
        need_id: 'NEED-runtime', description: 'Pinned runtime', kind: 'runtime', required_level: 'exact',
        hard_constraints: [], dependencies: [], verification_method: 'package test', status: 'open', confidence: 95,
      }],
    },
  });
  journal.commit('capability.provider.discovered', {
    provider: {
      provider_id: 'provider-codex', provider_type: 'package', source_uri: 'npm:@openai/codex', capabilities: ['runtime'],
      trust_tier: 'trusted', availability: 'available', version: '0.144.5', last_verified_at: '2026-07-19T00:00:00.000Z',
      evidence_refs: ['package-lock:@openai/codex'],
    },
  });
  journal.commit('candidate.evaluated', {
    evaluation: {
      evaluation_id: 'EVAL-provider-codex', need_id: 'NEED-runtime', candidate_id: 'provider-codex',
      candidate_score: 91, eligibility: 'eligible', hard_gate_results: [{ gate: 'version', status: 'pass', reason: 'exact' }], actual_model: null,
    },
  });
  journal.commit('resolution.proposed', {
    resolution: {
      resolution_id: 'RES-runtime', need_id: 'NEED-runtime', mode: 'reuse', status: 'approved', selected_provider_id: 'provider-codex',
      rejected_provider_ids: [], rationale: 'Pinned package', evidence_refs: ['package-lock:@openai/codex'], total_cost: 0,
      approval_status: 'approved', reevaluate_when: [],
    },
  });
  journal.commit('context.pack.created', {
    context_pack: {
      context_pack_id: 'CP-desktop', task_intent_id: 'TI-desktop', owner_agent_id: 'implementation-001', objective: 'Ship Orquesta Desktop',
      acceptance_criteria: ['Desktop is reviewable'], adopted_decisions: [], capability_resolutions: ['RES-runtime'], required_reading: ['README.md'],
      relevant_state_excerpts: [], interfaces: [], allowed_files: [], forbidden_actions: [], excluded_context: [], evidence_requirements: [],
      provenance: [], token_budget: null, expires_at: null, status: 'ready',
    },
  });
  return journal;
}

describe('V4 operations projection', () => {
  test('returns a bounded unavailable snapshot without creating a missing journal', async () => {
    const projectRoot = await root('missing');
    const result = await projectV4Operations(projectRoot);
    expect(result).toMatchObject({ available: false, revision: 0, limitation: expect.stringContaining('unavailable') });
    await expect(stat(path.join(projectRoot, '.orquesta', 'v4'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('projects Phase 1 and 1.5 state using the current canonical revisions', async () => {
    const projectRoot = await root('phase15');
    const journal = phase1Journal(projectRoot);
    journal.commit('candidate.install.requested', {
      install_request: { request_id: 'INSTALL-1', status: 'pending_user', target: { candidate_id: 'provider-codex', expires_at: null } },
    });
    journal.commit('phase.review.ready_for_user_review', {
      review: { phase_id: 'phase-1.5', status: 'ready_for_user_review', review_packet_ref: 'report:phase15', build_ref: 'build:phase15' },
    });

    const result = await projectV4Operations(projectRoot);
    expect(result).toMatchObject({
      available: true,
      revision: 8,
      taskIntent: { id: 'TI-desktop', desiredOutcome: 'Ship Orquesta Desktop' },
      capabilityNeeds: [{ id: 'NEED-runtime', confidence: 95 }],
      providers: [{ id: 'provider-codex', version: '0.144.5' }],
      latestResolutions: [{ id: 'RES-runtime', providerId: 'provider-codex' }],
      contextPack: { id: 'CP-desktop', requiredReading: ['README.md'] },
      installRequest: { id: 'INSTALL-1', candidateId: 'provider-codex' },
      phaseReviews: [{ phaseId: 'phase-1.5', status: 'ready_for_user_review' }],
      limitation: null,
    });
  });

  test('projects Phase 2 acquisition, Audit, Audition, evidence, runtime, and deterministic timeline ordering', async () => {
    const projectRoot = await root('phase2');
    const journal = phase1Journal(projectRoot);
    journal.commit('acquisition.snapshot.recorded', {
      acquisition_snapshot: {
        query_id: 'LSQ-desktop',
        query: { need_id: 'NEED-runtime', query_terms: ['codex'], requested_at: '2026-07-19T00:00:00.000Z', request_budget: { max_requests_per_need: 8 } },
        budget: { consumed_total: 1, remaining_total: 7 },
        source_results: [{
          connector_id: 'official_docs', trust_tier: 'official', status: 'success', fetched_at: '2026-07-19T00:00:00.000Z',
          expires_at: '2026-07-20T00:00:00.000Z', candidates: [{ candidate_id: 'provider-codex' }], source_evidence: [{ source_ref: 'docs:codex' }], cache_status: 'fresh',
        }],
      },
    });
    journal.commit('candidate.audit.recorded', {
      evaluation: {
        evaluation_id: 'EVAL-phase2', need_id: 'NEED-runtime', candidate_id: 'provider-codex', candidate_score: 94,
        eligibility: 'eligible', hard_gate_results: [{ gate: 'runtime', status: 'pass', reason: 'verified' }], actual_model: null,
      },
    });
    journal.commit('candidate.audition.recorded', {
      audition_result: {
        audition_plan_id: 'AP-1234567890ab', observed_codex_profile: 'workspace-write', verdict: 'passed',
        cleanup_evidence: ['cleanup:verified'], evidence_refs: ['artifact:audition'],
      },
    });
    journal.commit('runtime.dispatch.accepted', {
      evidence: {
        evidence_id: 'EVID-dispatch', kind: 'runtime_dispatch', correlation_id: 'CORR-desktop', thread_id: 'thread-1', turn_id: null,
        predecessor_evidence_id: null, request_ref: 'request:1', artifact_ref: null, report_ref: null, acceptance_ref: null,
      },
    });
    journal.commit('runtime.turn.started', {
      evidence: {
        evidence_id: 'EVID-started', kind: 'runtime_event', event_kind: 'turn_started', correlation_id: 'CORR-desktop', thread_id: 'thread-1', turn_id: 'turn-1',
        predecessor_evidence_id: 'EVID-dispatch', request_ref: null, artifact_ref: null, report_ref: null, acceptance_ref: null,
      },
    });

    const result = await projectV4Operations(projectRoot);
    expect(result.acquisitionSnapshots).toEqual([expect.objectContaining({ queryId: 'LSQ-desktop', consumedRequests: 1 })]);
    expect(result.candidateEvaluations).toContainEqual(expect.objectContaining({ id: 'EVAL-phase2', score: 94, actualModel: null }));
    expect(result.auditionResults).toEqual([expect.objectContaining({ planId: 'AP-1234567890ab', verdict: 'passed' })]);
    expect(result.evidenceChains).toEqual([{ correlationId: 'CORR-desktop', items: expect.arrayContaining([
      expect.objectContaining({ id: 'EVID-dispatch', kind: 'runtime_dispatch' }),
      expect.objectContaining({ id: 'EVID-started', predecessorId: 'EVID-dispatch' }),
    ]) }]);
    expect(result.runtimeCorrelations).toEqual([expect.objectContaining({
      correlationId: 'CORR-desktop', dispatchEvidenceId: 'EVID-dispatch', activeThreadId: 'thread-1', activeTurnId: 'turn-1',
    })]);
    expect(result.auditTimeline.map((item) => item.sequence)).toEqual([...result.auditTimeline.map((item) => item.sequence)].sort((a, b) => a - b));
  });

  test('bounds every repeated collection before it crosses the Desktop protocol', async () => {
    const projectRoot = await root('bounded');
    const journal = createJournal(projectRoot);
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    for (let index = 0; index < 140; index += 1) {
      const suffix = String(index).padStart(3, '0');
      events.push({ type: 'capability.provider.discovered', payload: {
        provider: {
          provider_id: `provider-${suffix}`, provider_type: 'package', source_uri: `npm:provider-${suffix}`,
          capabilities: ['runtime'], trust_tier: 'trusted', availability: 'available', version: '1.0.0',
          last_verified_at: '2026-07-19T00:00:00.000Z', evidence_refs: [],
        },
      } });
      events.push({ type: 'candidate.evaluated', payload: {
        evaluation: {
          evaluation_id: `evaluation-${suffix}`, need_id: 'need-runtime', candidate_id: `provider-${suffix}`,
          candidate_score: index, eligibility: 'eligible', hard_gate_results: [], actual_model: null,
        },
      } });
      events.push({ type: 'runtime.dispatch.accepted', payload: {
        evidence: {
          evidence_id: `evidence-${suffix}`, kind: 'runtime_dispatch', correlation_id: `correlation-${suffix}`,
          thread_id: `thread-${suffix}`, turn_id: null, predecessor_evidence_id: null,
          request_ref: `request:${suffix}`, artifact_ref: null, report_ref: null, acceptance_ref: null,
        },
      } });
      events.push({ type: 'phase.review.ready_for_user_review', payload: {
        review: {
          phase_id: `phase-${suffix}`, status: 'ready_for_user_review',
          review_packet_ref: `report:${suffix}`, build_ref: `build:${suffix}`,
        },
      } });
    }
    journal.commitAll(events);

    const result = await projectV4Operations(projectRoot);
    expect(result.providers).toHaveLength(128);
    expect(result.candidateEvaluations).toHaveLength(128);
    expect(result.runtimeCorrelations).toHaveLength(128);
    expect(result.phaseReviews).toHaveLength(128);
    expect(result.auditTimeline).toHaveLength(500);
    expect(isV4OperationsSnapshot(result)).toBe(true);
  });
});
