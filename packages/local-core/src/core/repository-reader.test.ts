import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import executionKernel from '@orquesta/execution-kernel';
import { afterEach, describe, expect, test } from 'vitest';
import { projectSnapshotFromDocuments, readRepositorySnapshot } from './repository-reader';
import { establishRuntimeBinding, readRuntimeBindingEvidence } from './runtime-binding-store';

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const PROJECT_ID = 'repo-1';
const RUNTIME_AUTHORITY_ID = 'runtime-authority-1';

function agent(agentId: string, roleId: string, mission: string, origin: 'foundation' | 'controller', createdFromId: string) {
  return {
    agent_id: agentId,
    role_id: roleId,
    role_version: 1,
    mission,
    context_scope: ['project'],
    lifecycle_state: 'active',
    origin,
    created_from_ref: { kind: origin === 'foundation' ? 'project_bootstrap' : 'task', id: createdFromId },
    retired_at: null
  };
}

function acceptedBinding(agentId: string, updatedAt: string) {
  return {
    session_id: `session-${agentId}`,
    agent_id: agentId,
    thread_id: `thread-${agentId}`,
    session_generation: 1,
    session_kind: 'persistent_agent',
    handoff_status: 'accepted',
    handoff_turn_id: `turn-${agentId}`,
    accepted_at: '2026-07-01T10:00:00.000Z',
    rotation_state: 'active',
    ownership_status: 'owner',
    accepts_new_work: true,
    binding_status: 'bound',
    replaces_session_id: null,
    retry_of_session_id: null,
    replaced_by_session_id: null,
    visibility: 'desktop_only',
    profile_id: `profile:${agentId}`,
    runtime_authority_id: RUNTIME_AUTHORITY_ID,
    provisioning_request_id: `request-${agentId}`,
    placement_intent_id: 'PI-0123456789ab',
    task_id: 'T1',
    ownership_started_at: '2026-07-01T10:00:00.000Z',
    ownership_ended_at: null,
    created_at: '2026-07-01T10:00:00.000Z',
    updated_at: updatedAt
  };
}

function documents(activityAt = '2026-07-18T10:59:30.000Z') {
  return {
    agents: {
      schema_version: 3,
      organization_revision: 1,
      agents: [
        agent('orchestrator', 'orchestrator', 'Coordinate the project.', 'foundation', 'bootstrap-test'),
        agent('orquesta-admin', 'orquesta-admin', 'Explain the project.', 'foundation', 'bootstrap-test'),
        agent('user-support', 'user-support', 'Support the user.', 'foundation', 'bootstrap-test'),
        agent('worker', 'implementation', 'Implement one bounded task.', 'controller', 'T1'),
        agent('idle', 'reviewer', 'Review completed work.', 'controller', 'T-idle')
      ]
    },
    tasks: {
      updated_at: '2026-07-18T11:00:00.000Z',
      tasks: [{
        task_id: 'T1', title: 'Build the reader', state: 'in_progress', owner_agent_id: 'worker',
        handoff_sent_at: '2026-07-18T10:58:00.000Z',
        handoff_attempts: [{ status: 'accepted', turn_start_status: 'verified', turn_started_at: '2026-07-18T10:58:30.000Z', actual_model: null }],
        routing_class: 'specialist_required', acceptance_checks: ['Snapshot is truthful.'], updated_at: activityAt
      }]
    },
    sessions: {
      schema_version: 1,
      project_id: PROJECT_ID,
      revision: 1,
      sessions: [acceptedBinding('worker', activityAt)]
    },
    runtimeBinding: { schema_version: 1, project_id: PROJECT_ID, runtime_authority_id: RUNTIME_AUTHORITY_ID, mode: 'standalone' },
    organization: {
      schema_version: 3,
      revision: 1,
      policy: { line_creation: 'review', max_concurrent_provisioning: 3, require_executable_task_per_new_agent: true, require_no_file_ownership_conflict: true },
      participants: [{ participant_id: 'user', display_name: 'User', participant_kind: 'human', lifecycle_state: 'active', joined_at: '2026-07-18T10:00:00.000Z' }],
      lines: [], teams: [], memberships: [],
      relationships: [
        { relationship_id: 'R-user', type: 'authority_over', subject_ref: { kind: 'participant', id: 'user' }, object_ref: { kind: 'agent', id: 'orchestrator' } },
        { relationship_id: 'R-worker', type: 'reports_to', subject_ref: { kind: 'agent', id: 'worker' }, object_ref: { kind: 'agent', id: 'orchestrator' } },
        { relationship_id: 'R-idle', type: 'reports_to', subject_ref: { kind: 'agent', id: 'idle' }, object_ref: { kind: 'agent', id: 'orchestrator' } }
      ],
      applied_decision_ids: [], applied_decision_bindings: []
    },
    formations: { schema_version: 1, organization_revision: 1, formations: [] },
    questions: { questions: [{ question_id: 'Q1', status: 'pending', question: 'Choose the next milestone.', source_agent_id: 'orchestrator', created_at: '2026-07-18T10:57:00.000Z' }] },
    incidents: { incidents: [{ incident_id: 'F1', status: 'open', severity: 'medium', title: 'Watcher retrying', current_action: 'Wait for the next read.', source_agent_id: 'worker', task_id: 'T1', detected_at: '2026-07-18T10:56:00.000Z', user_action_required: false }] },
    events: [{ ts: '2026-07-18T10:59:40.000Z', type: 'progress_observed', task_id: 'T1', summary: 'Reader tests are running.' }]
  };
}

async function writeLiveAuthority(root: string, source = documents()): Promise<void> {
  await establishRuntimeBinding({
    rootPath: root,
    projectId: PROJECT_ID,
    launchContext: { source: 'standalone', callingThreadId: null },
    authorityId: () => RUNTIME_AUTHORITY_ID,
    now: () => new Date('2026-07-18T10:00:00.000Z')
  });
  const evidence = await readRuntimeBindingEvidence(root);
  if (!evidence) throw new Error('test runtime authority missing');
  executionKernel.createOrganizationV3Store({
    rootPath: root,
    validatedRuntimeBindingSha256: evidence.sha256,
    clock: () => '2026-07-18T10:00:00.000Z'
  }).initialize({
    bundle: executionKernel.createOrganizationV3Bundle({
      agentRegistry: source.agents,
      organization: source.organization,
      formations: source.formations
    } as never),
    commandId: 'bootstrap-reader-test'
  });
  const state = path.join(root, '.orquesta', 'state');
  const placementTasks = source.tasks.tasks.map((raw) => {
    const base = {
      task_id: raw.task_id,
      task_kind: 'specialist_work',
      placement_intent_id: 'PI-0123456789ab',
      assigned_agent_id: raw.owner_agent_id,
      owner_agent_id: raw.owner_agent_id,
      role_id: 'implementation',
      role_version: 1,
      purpose: raw.title,
      acceptance_criteria: raw.acceptance_checks,
      state: raw.state,
      dependencies: [],
      blocked_by: [],
      result_summary: null,
      accepted_at: null,
      specialist_report_required: true,
      created_at: '2026-07-18T10:58:00.000Z',
      updated_at: raw.updated_at
    };
    return { ...base, placement_fingerprint: executionKernel.taskFingerprint(base) };
  });
  await Promise.all([
    writeFile(path.join(state, 'placement-tasks.json'), JSON.stringify({
      schema_version: 3,
      project_id: PROJECT_ID,
      revision: placementTasks.length > 0 ? 1 : 0,
      tasks: placementTasks
    }), 'utf8'),
    writeFile(path.join(state, 'session-bindings.json'), JSON.stringify(source.sessions), 'utf8')
  ]);
}

describe('repository reader', () => {
  test('rejects a retired Setup-only repository before agents and tasks exist', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'orquesta-active-setup-'));
    temporaryRoots.push(root);
    const setupRoot = path.join(root, '.orquesta', 'setup');
    await mkdir(setupRoot, { recursive: true });
    await writeFile(path.join(setupRoot, 'setup_state.json'), JSON.stringify({
      schema_version: 1,
      setup_id: 'setup-001',
      status: 'active',
      project_title: 'Fresh project',
      current_phase_id: 'environment',
      phases: ['environment', 'understanding', 'foundation', 'planning', 'specialists', 'operation'],
      created_at: '2026-07-22T00:00:00.000Z',
      updated_at: '2026-07-22T00:00:01.000Z'
    }), 'utf8');

    await expect(readRepositorySnapshot(root, {
      now: new Date('2026-07-22T00:00:02.000Z'), projectId: 'native-project-id'
    })).rejects.toThrow('repository_runtime_binding_required');
  });

  test('requires explicit migration before reading a nonempty legacy organization', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'orquesta-legacy-read-'));
    temporaryRoots.push(root);
    const stateRoot = path.join(root, '.orquesta', 'state');
    await mkdir(stateRoot, { recursive: true });
    await writeFile(path.join(stateRoot, 'agents.json'), JSON.stringify({
      version: 1,
      agents: [
        { agent_id: 'orchestrator', role: 'orchestrator', status: 'active' },
        { agent_id: 'implementation-001', role: 'implementation', status: 'standby' }
      ]
    }), 'utf8');
    await writeFile(path.join(stateRoot, 'tasks.json'), JSON.stringify({ version: 1, tasks: [] }), 'utf8');
    await writeFile(path.join(stateRoot, 'sessions.json'), JSON.stringify({ version: 1, sessions: [] }), 'utf8');

    await expect(readRepositorySnapshot(root)).rejects.toThrow('repository_runtime_binding_required');
    await expect(readFile(path.join(stateRoot, 'roles.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(path.join(stateRoot, 'organization.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('presents canonical orquesta-admin state as Luca without changing its machine identity', () => {
    const source = documents();

    const snapshot = projectSnapshotFromDocuments({ rootPath: 'C:\\work\\sample', documents: source });

    expect(snapshot.agents.find((agent) => agent.id === 'orquesta-admin')).toMatchObject({
      id: 'orquesta-admin',
      displayName: 'Luca',
      role: 'プロジェクト説明係',
      roleId: 'orquesta-admin',
      assignedByAgentId: 'user'
    });
  });

  test('projects canonical state into an evidence-honest UI snapshot', () => {
    const snapshot = projectSnapshotFromDocuments({
      rootPath: 'C:\\work\\sample',
      now: new Date('2026-07-18T11:00:00.000Z'),
      documents: documents()
    });

    expect(snapshot.project).toMatchObject({
      title: 'sample',
      isDemoData: false,
      repositoryDisplayState: 'snapshot',
      agentCount: 5,
      provenWorkingAgentCount: 1,
      status: 'working'
    });
    expect(snapshot.participants).toEqual([{
      id: 'user', displayName: 'User', roleLabel: 'OWNER', isCurrentUser: true,
      orchestratorAgentId: 'orchestrator'
    }]);
    expect(snapshot.agents.find((agent) => agent.id === 'orchestrator')).toMatchObject({
      assignedByAgentId: 'user', organizationParentAgentId: null
    });
    expect(snapshot.agents.find((agent) => agent.id === 'worker')).toMatchObject({
      status: 'working', statusEvidence: 'proven', currentTaskId: 'T1', assignedByAgentId: 'orchestrator'
    });
    expect(snapshot.tasks[0]).toMatchObject({ turnStarted: true, progressObserved: true, actualModel: null, actualModelEvidence: 'unknown' });
    expect(snapshot.attention).toMatchObject([{
      id: 'question:Q1', sourceKind: 'user_question', actionKind: 'answer'
    }]);
    expect(snapshot.recentEvents[0]).toMatchObject({ taskId: 'T1', message: 'Reader tests are running.' });
    expect(snapshot.inspectionTemplates.map((item) => item.kind)).toEqual([
      'external_benchmark',
      'adversarial_audit'
    ]);
    expect(snapshot.inspectionRuns).toEqual([]);
  });

  test('projects accepted incidents and repeated candidate clusters without changing user attention', () => {
    const source = documents();
    source.questions = { questions: [] };
    source.incidents = {
      incidents: [
        {
          incident_id: 'F-OPEN', status: 'open', severity: 'high', failure_class: 'filesystem.lock', title: 'State lock failed',
          summary: 'The state lock could not be created.', source_agent_id: 'worker', task_id: 'T1', detected_at: '2026-07-18T10:40:00.000Z',
          suspected_cause: 'The workspace was locked by another process.', attempted_fixes: ['Retried once.'], evidence: ['EACCES'], user_action_required: true
        },
        {
          incident_id: 'F-RESOLVED', status: 'resolved', severity: 'medium', failure_class: 'encoding.corruption', title: 'Text encoding was repaired',
          summary: 'A damaged JSON document was rebuilt.', source_agent_id: 'orchestrator', task_id: 'T0', detected_at: '2026-07-17T09:00:00.000Z',
          resolved_at: '2026-07-17T09:30:00.000Z', fix: 'Rebuilt the file as UTF-8.', prevention: ['Read with explicit UTF-8.'], evidence: ['JSON parsed.'], user_action_required: false
        }
      ]
    };
    const snapshot = projectSnapshotFromDocuments({
      rootPath: 'C:\\work\\sample',
      documents: {
        ...source,
        incidentCandidates: {
          candidates: [
            { candidate_id: 'IC-1', status: 'clustered', severity: 'medium', failure_class: 'network.timeout', summary: 'First timeout.', task_id: 'T1', source_agent_id: 'worker', global_fingerprint: 'GF-NET', cluster_id: 'FC-1', created_at: '2026-07-18T10:41:00.000Z', evidence: ['timeout 1'] },
            { candidate_id: 'IC-2', status: 'clustered', severity: 'high', failure_class: 'network.timeout', summary: 'Second timeout.', task_id: 'T2', source_agent_id: 'worker', global_fingerprint: 'GF-NET', cluster_id: 'FC-1', created_at: '2026-07-18T10:51:00.000Z', evidence: ['timeout 2'], attempted_fixes: ['Changed endpoint.'] }
          ]
        },
        incidentClusters: {
          clusters: [{ cluster_id: 'FC-1', status: 'open', primary_class: 'network.timeout', candidate_ids: ['IC-1', 'IC-2'], occurrence_count: 4, resolution_evidence: null }]
        }
      }
    });

    expect(snapshot.failures).toHaveLength(3);
    expect(snapshot.failures.find((failure) => failure.id === 'FC-1')).toMatchObject({
      source: 'cluster', failureClass: 'network.timeout', severity: 'high', resolution: 'open', occurrenceCount: 4,
      firstOccurredAt: '2026-07-18T10:41:00.000Z', lastOccurredAt: '2026-07-18T10:51:00.000Z', taskIds: ['T1', 'T2']
    });
    expect(snapshot.failures.find((failure) => failure.id === 'failure-class:encoding.corruption')).toMatchObject({
      source: 'incident', resolution: 'resolved', repairStatus: 'resolved', fix: 'Rebuilt the file as UTF-8.'
    });
    expect(snapshot.attention).toEqual([]);
  });

  test('does not call stale active metadata proven work', () => {
    const snapshot = projectSnapshotFromDocuments({
      rootPath: 'C:\\work\\sample',
      now: new Date('2026-07-18T11:00:00.000Z'),
      documents: documents('2026-07-18T09:00:00.000Z')
    });

    expect(snapshot.project.provenWorkingAgentCount).toBe(0);
    expect(snapshot.agents.find((agent) => agent.id === 'worker')).toMatchObject({ status: 'stale', statusEvidence: 'reported' });
  });

  test('fails closed when a session uses a non-canonical binding status', () => {
    const source = documents();
    source.sessions.sessions[0].binding_status = 'missing';
    expect(() => projectSnapshotFromDocuments({
      rootPath: 'C:\\work\\sample',
      now: new Date('2026-07-18T11:00:00.000Z'),
      documents: source
    })).toThrow('repository_session_binding_v1_required');
  });

  test('does not infer a completed review task as an agent current task', () => {
    const source = documents();
    source.tasks.tasks[0].state = 'completed';

    const snapshot = projectSnapshotFromDocuments({
      rootPath: 'C:\\work\\sample',
      now: new Date('2026-07-18T11:00:00.000Z'),
      documents: source
    });

    expect(snapshot.agents.find((agent) => agent.id === 'worker')).toMatchObject({
      currentTaskId: null,
      status: 'standby'
    });
  });

  test('still infers an execution-state task when current_task is empty', () => {
    const source = documents();
    source.tasks.tasks[0].state = 'assigned';

    const snapshot = projectSnapshotFromDocuments({
      rootPath: 'C:\\work\\sample',
      now: new Date('2026-07-18T11:00:00.000Z'),
      documents: source
    });

    expect(snapshot.agents.find((agent) => agent.id === 'worker')).toMatchObject({
      currentTaskId: 'T1',
      status: 'working'
    });
  });

  test('projects only curated questions, user tasks, and curated user actions into DECISIONS', () => {
    const source = documents();
    const snapshot = projectSnapshotFromDocuments({
      rootPath: 'C:\\work\\sample',
      documents: {
        ...source,
        questions: {
          questions: [{ question_id: 'Q-action', status: 'pending', question: 'Choose a direction.', task_id: 'T1' }]
        },
        userTasks: {
          tasks: [
            { user_task_id: 'UT-approve', status: 'pending', source: 'approval_wait', priority: 'high', title: 'Approve execution', prompt: 'Approve the requested action.' },
            { user_task_id: 'UT-review', status: 'pending', source: 'capability_review', priority: 'medium', title: 'Review locally', prompt: 'Open the packaged app.' }
          ]
        },
        userActions: {
          actions: [{ action_id: 'UA1', status: 'ready', title: 'Repair permission', why_this_helps: 'Runtime access is blocked.', user_steps: ['Grant access.'] }]
        },
        dashboardActions: {
          actions: [
            { action_id: 'DA1', status: 'requested', type: 'report_review', task_id: 'T1', payload: { title: 'Review UI' } },
            { action_id: 'DA2', status: 'requested', type: 'fallback_approval', task_id: 'T1', payload: { title: 'Approve fallback' } }
          ]
        }
      }
    });

    expect(snapshot.attention.map((item) => item.actionKind)).toEqual(
      expect.arrayContaining(['answer', 'approve', 'review', 'do'])
    );
    expect(snapshot.attention.map((item) => item.sourceKind)).toEqual([
      'user_question', 'user_task', 'user_task', 'user_action'
    ]);
    expect(snapshot.attention.some((item) => item.id.startsWith('dashboard-action:'))).toBe(false);
  });

  test('keeps distinct attention items when separate ledgers reuse the same canonical id', () => {
    const source = documents();
    const snapshot = projectSnapshotFromDocuments({
      rootPath: 'C:\\work\\sample',
      documents: {
        ...source,
        questions: {
          questions: [{ question_id: 'SHARED-1', status: 'pending', question: 'Choose a direction.' }]
        },
        userTasks: {
          tasks: [{ user_task_id: 'SHARED-1', status: 'pending', title: 'Run locally' }]
        }
      }
    });

    expect(snapshot.attention).toHaveLength(2);
    expect(new Set(snapshot.attention.map((item) => item.id)).size).toBe(2);
    expect(snapshot.attention.map((item) => item.actionKind)).toEqual(['answer', 'do']);
    expect(snapshot.attention.map((item) => item.sourceKind)).toEqual(['user_question', 'user_task']);
  });

  test('does not expose internal task review states as user attention', () => {
    const source = documents();
    source.questions = { questions: [] };
    source.tasks.tasks[0].state = 'changes_requested';

    const snapshot = projectSnapshotFromDocuments({ rootPath: 'C:\\work\\sample', documents: source });

    expect(snapshot.attention).toEqual([]);
  });

  test('does not turn an in_progress label into runtime or progress evidence', () => {
    const source = documents();
    source.tasks.tasks[0].handoff_attempts = [];
    delete source.tasks.tasks[0].progress_summary;
    source.events = [];
    const snapshot = projectSnapshotFromDocuments({
      rootPath: 'C:\\work\\sample',
      now: new Date('2026-07-18T11:00:00.000Z'),
      documents: source
    });

    expect(snapshot.project.provenWorkingAgentCount).toBe(0);
    expect(snapshot.tasks[0]).toMatchObject({ turnStarted: false, progressObserved: false });
    expect(snapshot.agents.find((agent) => agent.id === 'worker')).toMatchObject({ status: 'assigned_waiting', statusEvidence: 'reported' });
  });

  test('does not use the current task delegation source as the organization parent', () => {
    const source = documents();
    (source.tasks.tasks[0] as Record<string, unknown>).assigned_by_agent_id = 'idle';

    const fallback = projectSnapshotFromDocuments({ rootPath: 'C:\\work\\sample', documents: source });
    expect(fallback.agents.find((agent) => agent.id === 'worker')?.assignedByAgentId).toBe('orchestrator');

    const workerRelationship = source.organization.relationships.find((relationship) => relationship.relationship_id === 'R-worker');
    if (workerRelationship) workerRelationship.object_ref = { kind: 'agent', id: 'idle' };
    const explicit = projectSnapshotFromDocuments({ rootPath: 'C:\\work\\sample', documents: source });
    expect(explicit.agents.find((agent) => agent.id === 'worker')?.assignedByAgentId).toBe('idle');
  });

  test('projects explicit v3 teams, lines, formations, and organization parent without name inference', () => {
    const source = documents();
    source.agents.organization_revision = 4;
    source.agents.agents[3] = agent('alpha', 'implementation', 'Implement the desktop line.', 'controller', 'T1');
    source.agents.agents.push(agent('beta', 'implementation', 'Implement a separate bounded line.', 'controller', 'T-beta'));
    source.tasks.tasks[0].owner_agent_id = 'alpha';
    (source.tasks.tasks[0] as Record<string, unknown>).assigned_by_agent_id = 'orchestrator';
    source.sessions.sessions = [acceptedBinding('alpha', '2026-07-18T10:59:30.000Z')];
    source.sessions.sessions[0].task_id = 'T1';
    source.formations.organization_revision = 4;
    const snapshot = projectSnapshotFromDocuments({
      rootPath: 'C:\\work\\sample',
      documents: {
        ...source,
        organization: {
          schema_version: 3,
          revision: 4,
          policy: { line_creation: 'review', max_concurrent_provisioning: 3, require_executable_task_per_new_agent: true, require_no_file_ownership_conflict: true },
          participants: [{ participant_id: 'user', display_name: 'User', participant_kind: 'human', lifecycle_state: 'active', joined_at: '2026-07-18T10:00:00.000Z' }],
          teams: [
            { team_id: 'desktop-implementation', line_id: 'desktop-line', display_name: 'Desktop 実装チーム', purpose: 'Desktop rendererを実装する', coordination_mode: 'supervised', lead_agent_id: 'alpha', lifecycle_state: 'active' },
            { team_id: 'core-implementation', line_id: 'core-line', display_name: 'Core 実装チーム', purpose: 'Coreを実装する', coordination_mode: 'peer', lead_agent_id: null, lifecycle_state: 'active' }
          ],
          memberships: [
            { membership_id: 'M1', agent_id: 'alpha', team_id: 'desktop-implementation', position: 'lead', ordinal: 1, active_from: '2026-07-18T10:00:00.000Z', active_to: null },
            { membership_id: 'M2', agent_id: 'beta', team_id: 'core-implementation', position: 'member', ordinal: 1, active_from: '2026-07-18T10:00:00.000Z', active_to: null }
          ],
          relationships: [
            { relationship_id: 'R-user', type: 'authority_over', subject_ref: { kind: 'participant', id: 'user' }, object_ref: { kind: 'agent', id: 'orchestrator' } },
            { relationship_id: 'R1', type: 'reports_to', subject_ref: { kind: 'agent', id: 'alpha' }, object_ref: { kind: 'agent', id: 'orchestrator' } },
            { relationship_id: 'R2', type: 'reports_to', subject_ref: { kind: 'agent', id: 'beta' }, object_ref: { kind: 'agent', id: 'orchestrator' } }
          ],
          lines: [
            { line_id: 'desktop-line', display_name: 'Desktop', goal: 'Windowsアプリを完成させる', deliverable_ids: ['desktop'], completion_root_ids: ['desktop-root'], scope: ['desktop'], status: 'active', owner_ref: { kind: 'agent', id: 'orchestrator' }, approval_source: 'user_approval' },
            { line_id: 'core-line', display_name: 'Core', goal: '組織Coreを完成させる', deliverable_ids: ['core'], completion_root_ids: ['core-root'], scope: ['core'], status: 'active', owner_ref: { kind: 'agent', id: 'orchestrator' }, approval_source: 'user_approval' }
          ],
          applied_decision_ids: [], applied_decision_bindings: []
        }
      } as never
    });

    expect(snapshot.organization).toMatchObject({
      revision: 4,
      source: 'explicit',
      diagnostics: [],
      lines: [
        expect.objectContaining({ id: 'core-line', displayName: 'Core', dedicatedLeadAgentId: null, displayOrder: 1 }),
        expect.objectContaining({ id: 'desktop-line', displayName: 'Desktop', dedicatedLeadAgentId: 'alpha', displayOrder: 2 })
      ],
      teams: [
        expect.objectContaining({ id: 'core-implementation', lineId: 'core-line', displayName: 'Core 実装チーム' }),
        expect.objectContaining({ id: 'desktop-implementation', lineId: 'desktop-line', displayName: 'Desktop 実装チーム' })
      ],
      relationships: [
        expect.objectContaining({ id: 'R1', type: 'reports_to', fromAgentId: 'alpha', toAgentId: 'orchestrator' }),
        expect.objectContaining({ id: 'R2', type: 'reports_to', fromAgentId: 'beta', toAgentId: 'orchestrator' })
      ],
      lineProposals: []
    });
    expect(snapshot.agents.find((agent) => agent.id === 'alpha')).toMatchObject({
      roleId: 'implementation',
      teamId: 'desktop-implementation',
      lineId: 'desktop-line',
      position: 'lead',
      organizationParentAgentId: 'orchestrator',
      delegatedByAgentId: 'orchestrator',
      organizationScope: 'line',
      lifecycleState: 'active',
      membershipOrdinal: 1,
      organizationRevision: 4
    });
    expect(snapshot.agents.find((agent) => agent.id === 'beta')).toMatchObject({
      roleId: 'implementation',
      teamId: 'core-implementation',
      lineId: 'core-line',
      membershipOrdinal: 1,
      lifecycleState: 'active'
    });
  });

  test('uses the v3 registry lifecycle instead of reviving retired agent rows', () => {
    const source = documents();
    source.agents.agents[4].lifecycle_state = 'retired';
    source.agents.agents[4].retired_at = '2026-07-18T10:59:59.000Z';
    source.organization.relationships = source.organization.relationships
      .filter((relationship) => relationship.relationship_id !== 'R-idle');
    const snapshot = projectSnapshotFromDocuments({
      rootPath: 'C:\\work\\sample',
      documents: source
    });

    expect(snapshot.agents.map((agent) => agent.id)).toEqual(['orchestrator', 'orquesta-admin', 'user-support', 'worker']);
    expect(snapshot.project.agentCount).toBe(4);
    expect(snapshot.agents.some((agent) => agent.id === 'idle')).toBe(false);
  });

  test('fails closed for a foreign active runtime owner', () => {
    const source = documents();
    source.sessions.sessions[0].runtime_authority_id = 'foreign-runtime-authority';
    expect(() => projectSnapshotFromDocuments({
      rootPath: 'C:\\work\\sample',
      projectId: PROJECT_ID,
      documents: source
    })).toThrow('repository_session_binding_runtime_authority_conflict');
  });

  test('fails closed when the session state belongs to another project', () => {
    const source = documents();
    source.sessions.project_id = 'foreign-project';
    expect(() => projectSnapshotFromDocuments({
      rootPath: 'C:\\work\\sample',
      projectId: PROJECT_ID,
      documents: source
    })).toThrow('repository_session_binding_foreign_project');
  });

  test('fails closed before projecting two owner bindings for one agent', () => {
    const source = documents();
    source.sessions.sessions.push({
      ...acceptedBinding('worker', '2026-07-18T10:59:31.000Z'),
      session_id: 'session-worker-duplicate',
      thread_id: 'thread-worker-duplicate'
    });
    expect(() => projectSnapshotFromDocuments({
      rootPath: 'C:\\work\\sample',
      projectId: PROJECT_ID,
      documents: source
    })).toThrow('repository_session_binding_v1_required');
  });

  test('does not revive retired organization decisions as live line proposals', () => {
    const source = documents();
    const snapshot = projectSnapshotFromDocuments({
      rootPath: 'C:\\work\\sample',
      documents: {
        ...source,
        organizationDecisions: {
          schema_version: 1,
          decisions: [{
            decision_id: 'OD-0123456789ab',
            selected_action: 'propose_line',
            approval_state: 'pending_user',
            proposed_line: { line_id: 'retired-line', display_name: 'Retired', goal: 'Must not appear.' }
          }]
        }
      } as never
    });
    expect(snapshot.organization.lineProposals).toEqual([]);
  });

  test('does not expose retired Setup state through the v3 snapshot', () => {
    const snapshot = projectSnapshotFromDocuments({
      rootPath: 'C:\\work\\sample',
      documents: {
        ...documents(),
        setupState: {
          schema_version: 1,
          setup_id: 'SETUP-1',
          project_id: 'sample',
          status: 'running',
          current_phase: 'specialists',
          phases: ['environment', 'understanding', 'foundation', 'planning', 'specialists', 'operation'],
          created_at: '2026-07-18T10:00:00.000Z',
          updated_at: '2026-07-18T11:00:00.000Z'
        },
        provisioningBatch: {
          provisioning_batch_id: 'PB-1',
          max_concurrent_provisioning: 3,
          requests: [{ agent_id: 'implementation-001', task_id: 'T1', status: 'pending' }]
        }
      } as never
    });

    expect(snapshot.organization).toMatchObject({ source: 'explicit', diagnostics: [] });
    expect(Object.hasOwn(snapshot, 'setup')).toBe(false);
  });

  test('keeps actual model unknown unless separate evidence is recorded', () => {
    const source = documents();
    source.tasks.tasks[0].model_route = { requested_model: 'gpt-5.6-terra', actual_model: 'gpt-5.6-sol' };
    const unknown = projectSnapshotFromDocuments({ rootPath: 'C:\\work\\sample', documents: source });
    expect(unknown.tasks[0]).toMatchObject({ requestedModel: 'gpt-5.6-terra', actualModel: null, actualModelEvidence: 'unknown' });

    source.tasks.tasks[0].model_route.actual_model_evidence = 'proven';
    const proven = projectSnapshotFromDocuments({ rootPath: 'C:\\work\\sample', documents: source });
    expect(proven.tasks[0]).toMatchObject({ actualModel: 'gpt-5.6-sol', actualModelEvidence: 'proven' });
  });

  test('reads required files without changing repository bytes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'orquesta-reader-'));
    temporaryRoots.push(root);
    const state = path.join(root, '.orquesta', 'state');
    const source = documents();
    await writeLiveAuthority(root, source);
    const agentsBytes = await readFile(path.join(state, 'agents.json'));
    const tasksBytes = await readFile(path.join(state, 'placement-tasks.json'));

    const snapshot = await readRepositorySnapshot(root, { now: new Date('2026-07-18T11:00:00.000Z') });

    expect(snapshot.agents).toHaveLength(5);
    expect(await readFile(path.join(state, 'agents.json'))).toEqual(agentsBytes);
    expect(await readFile(path.join(state, 'placement-tasks.json'))).toEqual(tasksBytes);
  });

  test('reads optional user-facing ledgers from their canonical paths', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'orquesta-reader-attention-'));
    temporaryRoots.push(root);
    const state = path.join(root, '.orquesta', 'state');
    const vision = path.join(root, '.orquesta', 'vision');
    const userTasks = path.join(root, '.orquesta', 'user_tasks');
    const failures = path.join(root, '.orquesta', 'failures');
    const source = documents();
    source.tasks.tasks = [];
    source.sessions.sessions = [];
    await writeLiveAuthority(root, source);
    await Promise.all([
      mkdir(vision, { recursive: true }),
      mkdir(userTasks, { recursive: true }),
      mkdir(failures, { recursive: true })
    ]);
    await Promise.all([
      writeFile(path.join(state, 'dashboard_actions.json'), JSON.stringify({ actions: [{ action_id: 'DA1', status: 'requested', type: 'report_review' }] }), 'utf8'),
      writeFile(path.join(vision, 'questions.json'), JSON.stringify({ questions: [{ question_id: 'Q1', status: 'pending', question: 'Choose.' }] }), 'utf8'),
      writeFile(path.join(userTasks, 'queue.json'), JSON.stringify({ tasks: [{ user_task_id: 'UT1', status: 'pending', title: 'Run locally' }] }), 'utf8'),
      writeFile(path.join(failures, 'user_actions.json'), JSON.stringify({ actions: [{ action_id: 'UA1', status: 'ready', title: 'Repair locally' }] }), 'utf8')
    ]);

    const snapshot = await readRepositorySnapshot(root);

    expect(snapshot.attention.map((item) => item.id)).toEqual([
      'question:Q1',
      'user-task:UT1',
      'user-action:UA1'
    ]);
    expect(snapshot.attention.map((item) => item.sourceKind)).toEqual([
      'user_question', 'user_task', 'user_action'
    ]);
  });

  test('rejects malformed required JSON with a bounded filename', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'orquesta-reader-bad-'));
    temporaryRoots.push(root);
    const state = path.join(root, '.orquesta', 'state');
    await writeLiveAuthority(root);
    await writeFile(path.join(state, 'placement-tasks.json'), '{ bad', 'utf8');

    await expect(readRepositorySnapshot(root)).rejects.toThrow('repository_placement_task_unsupported');
  });

  test('fails closed when canonical organization bytes diverge from the controller head', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'orquesta-reader-head-mismatch-'));
    temporaryRoots.push(root);
    await writeLiveAuthority(root);
    const organizationPath = path.join(root, '.orquesta', 'state', 'organization.json');
    const organization = JSON.parse(await readFile(organizationPath, 'utf8')) as Record<string, unknown>;
    const policy = organization.policy as Record<string, unknown>;
    policy.max_concurrent_provisioning = 4;
    await writeFile(organizationPath, JSON.stringify(organization), 'utf8');

    await expect(readRepositorySnapshot(root)).rejects.toThrow('repository_organization_v3_unsupported');
  });

  test('projects a bounded read-only project structure summary', () => {
    const source = documents();
    source.tasks.tasks[0] = {
      ...source.tasks.tasks[0],
      task_id: 'T-STRUCTURE',
      title: 'Inspect structure',
      owner_agent_id: 'worker',
      state: 'in_progress',
      required_reading: ['docs/design.md', '.orquesta/project/layout.json']
    } as never;
    const snapshot = projectSnapshotFromDocuments({
      rootPath: 'C:\\work\\sample',
      documents: {
        ...source,
        structureInventory: {
          generated_at: '2026-08-01T10:00:00.000Z',
          stats: { indexed_files: 4 },
          files: [
            { source_ref: '.orquesta/project/layout.json', component_id: 'runtime-state', lifecycle: 'current', authority: 'canonical', read_policy: 'task_candidate' },
            { source_ref: 'docs/design.md', component_id: 'docs', lifecycle: 'current', authority: 'supporting', read_policy: 'task_candidate' },
            { source_ref: 'archive/old.md', component_id: 'docs', lifecycle: 'archived', authority: 'supporting', read_policy: 'explicit_only' },
            { source_ref: 'tmp/broken.json', component_id: 'runtime-state', lifecycle: 'quarantined', authority: 'supporting', read_policy: 'never' }
          ]
        },
        structureAudit: {
          blocked: false,
          summary: { error: 0, warning: 1, suggestion: 0 },
          issues: [{ severity: 'warning', code: 'stale_reference', message: 'A stale reference remains.', source_refs: ['docs/design.md'] }]
        },
        initialContextView: { view_id: 'PSCV-0123456789abcdef', sources: { candidate_count: 2, excluded_count: 2 }, warnings: [] },
        migrationPlan: { plan_id: 'PSMP-0123456789abcdef', status: 'review_required', operations: [{ action: 'quarantine', destructive: false }], rollback: { steps: [{}] } },
        migrationResult: { result_id: 'PSMR-0123456789abcdef', plan_id: 'PSMP-0123456789abcdef', status: 'applied', approval: { decision: 'accepted' }, operations: [{ action: 'quarantine', status: 'applied' }], verification: { runtime_ephemeral_warning: false, remaining_audit_summary: { error: 0, warning: 0 } }, rollback: { reverse_operations: [{}] }, applied_at: '2026-08-01T10:10:00.000Z' }
      } as never
    });

    expect(snapshot.projectStructure).toMatchObject({
      available: true,
      status: 'attention',
      indexedFileCount: 4,
      canonicalSourceCount: 1,
      lifecycleCounts: { current: 2, archived: 1, quarantined: 1 },
      issueCounts: { error: 0, warning: 1, suggestion: 0 },
      contextOverview: { viewId: 'PSCV-0123456789abcdef', candidateSourceCount: 2, excludedSourceCount: 2 },
      migration: { status: 'applied', operationCount: 1, destructiveOperationCount: 0, approvalDecision: 'accepted', verificationStatus: 'passed', rollbackStepCount: 1 }
    });
    expect(snapshot.projectStructure?.canonicalSources.map((item) => item.sourceRef)).toEqual(['.orquesta/project/layout.json']);
    expect(snapshot.projectStructure?.retiredSources.map((item) => item.sourceRef)).toEqual(['archive/old.md', 'tmp/broken.json']);
    expect(snapshot.projectStructure?.specialistContexts[0]).toMatchObject({ taskId: 'T-STRUCTURE', active: true, requiredReading: ['docs/design.md', '.orquesta/project/layout.json'] });
  });
});
