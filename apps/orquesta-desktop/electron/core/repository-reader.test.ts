import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { projectSnapshotFromDocuments, readRepositorySnapshot } from './repository-reader';

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function documents(lastSeen = '2026-07-18T10:59:30.000Z') {
  return {
    agents: {
      updated_at: '2026-07-18T11:00:00.000Z',
      agents: [
        { agent_id: 'orchestrator', role: 'orchestrator', display_name: '統括者', status: 'active', current_task: null, mission: 'Coordinate the project.', last_heartbeat: lastSeen },
        { agent_id: 'worker', role: 'implementation', display_name: '実装係', status: 'active', current_task: 'T1', assigned_by_agent_id: 'orchestrator', mission: 'Implement one bounded task.', last_heartbeat: lastSeen },
        { agent_id: 'idle', role: 'reviewer', display_name: '確認係', status: 'standby', current_task: null, mission: 'Review completed work.' }
      ]
    },
    tasks: {
      updated_at: '2026-07-18T11:00:00.000Z',
      tasks: [{
        task_id: 'T1', title: 'Build the reader', state: 'in_progress', owner_agent_id: 'worker',
        handoff_sent_at: '2026-07-18T10:58:00.000Z',
        handoff_attempts: [{ status: 'accepted', turn_start_status: 'verified', turn_started_at: '2026-07-18T10:58:30.000Z', actual_model: null }],
        routing_class: 'specialist_required', acceptance_checks: ['Snapshot is truthful.'], updated_at: '2026-07-18T10:59:40.000Z'
      }]
    },
    sessions: { synced_at: '2026-07-18T11:00:00.000Z', sessions: [{ agent_id: 'worker', status: 'active', last_seen: lastSeen }] },
    questions: { questions: [{ question_id: 'Q1', status: 'pending', question: 'Choose the next milestone.', source_agent_id: 'orchestrator', created_at: '2026-07-18T10:57:00.000Z' }] },
    incidents: { incidents: [{ incident_id: 'F1', status: 'open', severity: 'medium', title: 'Watcher retrying', current_action: 'Wait for the next read.', source_agent_id: 'worker', task_id: 'T1', detected_at: '2026-07-18T10:56:00.000Z', user_action_required: false }] },
    events: [{ ts: '2026-07-18T10:59:40.000Z', type: 'progress_observed', task_id: 'T1', summary: 'Reader tests are running.' }]
  };
}

describe('repository reader', () => {
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
      agentCount: 3,
      provenWorkingAgentCount: 1,
      status: 'working'
    });
    expect(snapshot.agents.find((agent) => agent.id === 'worker')).toMatchObject({
      status: 'working', statusEvidence: 'proven', currentTaskId: 'T1', assignedByAgentId: 'orchestrator'
    });
    expect(snapshot.tasks[0]).toMatchObject({ turnStarted: true, progressObserved: true, actualModel: null, actualModelEvidence: 'unknown' });
    expect(snapshot.attention).toMatchObject([{ id: 'question:Q1', actionKind: 'answer' }]);
    expect(snapshot.recentEvents[0]).toMatchObject({ taskId: 'T1', message: 'Reader tests are running.' });
  });

  test('projects accepted incidents and repeated candidate clusters without changing user attention', () => {
    const source = documents();
    source.questions = { questions: [] };
    source.incidents = {
      incidents: [
        {
          incident_id: 'F-OPEN', status: 'open', severity: 'high', failure_class: 'filesystem.lock', title: 'State lock failed',
          summary: 'The state lock could not be created.', source_agent_id: 'worker', task_id: 'T1', detected_at: '2026-07-18T10:40:00.000Z',
          suspected_cause: 'The workspace was locked by another process.', attempted_fixes: ['Retried once.'], evidence: ['EACCES'], user_action_required: false
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

  test('does not infer a completed review task as an agent current task', () => {
    const source = documents();
    source.agents.agents[1].current_task = null;
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
    source.agents.agents[1].current_task = null;
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

  test('projects open user-facing ledgers into four action kinds', () => {
    const source = documents();
    const snapshot = projectSnapshotFromDocuments({
      rootPath: 'C:\\work\\sample',
      documents: {
        ...source,
        questions: {
          questions: [{ question_id: 'Q-action', status: 'pending', question: 'Choose a direction.', task_id: 'T1' }]
        },
        userTasks: {
          tasks: [{ user_task_id: 'UT1', status: 'pending', priority: 'high', title: 'Run locally', prompt: 'Open the packaged app.' }]
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
    delete source.agents.agents[1].assigned_by_agent_id;
    (source.tasks.tasks[0] as Record<string, unknown>).assigned_by_agent_id = 'idle';

    const fallback = projectSnapshotFromDocuments({ rootPath: 'C:\\work\\sample', documents: source });
    expect(fallback.agents.find((agent) => agent.id === 'worker')?.assignedByAgentId).toBe('orchestrator');

    (source.agents.agents[1] as Record<string, unknown>).organization_parent_agent_id = 'idle';
    const explicit = projectSnapshotFromDocuments({ rootPath: 'C:\\work\\sample', documents: source });
    expect(explicit.agents.find((agent) => agent.id === 'worker')?.assignedByAgentId).toBe('idle');
  });

  test('projects explicit v2 roles, teams, lines, and organization parent without name inference', () => {
    const source = documents();
    source.agents.agents[1] = {
      ...source.agents.agents[1],
      agent_id: 'alpha',
      role: 'opaque-label',
      display_name: 'Alpha',
      current_task: 'T1'
    };
    source.tasks.tasks[0].owner_agent_id = 'alpha';
    const snapshot = projectSnapshotFromDocuments({
      rootPath: 'C:\\work\\sample',
      documents: {
        ...source,
        roles: {
          schema_version: 1,
          organization_revision: 4,
          roles: [{ role_id: 'implementation', display_names: { en: 'Implementation', ja: '実装係' } }]
        },
        organization: {
          schema_version: 2,
          revision: 4,
          agents: [{ agent_id: 'alpha', role_id: 'implementation', organization_scope: 'line', lifecycle_state: 'active', operational_status: 'working' }],
          teams: [{ team_id: 'desktop-implementation', line_id: 'desktop-line' }],
          memberships: [{ membership_id: 'M1', agent_id: 'alpha', team_id: 'desktop-implementation', position: 'lead', ordinal: 1, active_to: null }],
          relationships: [{ relationship_id: 'R1', type: 'reports_to', from_agent_id: 'alpha', to_agent_id: 'orchestrator' }],
          lines: [{ line_id: 'desktop-line' }]
        }
      } as never
    });

    expect(snapshot.organization).toMatchObject({ revision: 4, source: 'explicit', diagnostics: [] });
    expect(snapshot.agents.find((agent) => agent.id === 'alpha')).toMatchObject({
      role: 'implementation',
      roleId: 'implementation',
      teamId: 'desktop-implementation',
      lineId: 'desktop-line',
      position: 'lead',
      organizationParentAgentId: 'orchestrator',
      delegatedByAgentId: 'orchestrator',
      organizationScope: 'line',
      lifecycleState: 'active',
      operationalStatus: 'working',
      organizationRevision: 4
    });
  });

  test('marks legacy organization inference and projects real six-phase setup state', () => {
    const snapshot = projectSnapshotFromDocuments({
      rootPath: 'C:\\work\\sample',
      documents: {
        ...documents(),
        setupState: {
          schema_version: 1,
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

    expect(snapshot.organization?.diagnostics).toContain('legacy_inferred_organization');
    expect(snapshot.setup).toMatchObject({ status: 'running', currentPhaseId: 'specialists' });
    expect(snapshot.setup?.phases).toHaveLength(6);
    expect(snapshot.setup?.phases.find((phase) => phase.id === 'specialists')?.status).toBe('active');
    expect(snapshot.setup?.technicalDetails).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'provisioning-batch', value: 'PB-1' })
    ]));
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
    await mkdir(state, { recursive: true });
    const source = documents();
    const agentsText = `${JSON.stringify(source.agents, null, 2)}\n`;
    const tasksText = `${JSON.stringify(source.tasks, null, 2)}\n`;
    await writeFile(path.join(state, 'agents.json'), agentsText, 'utf8');
    await writeFile(path.join(state, 'tasks.json'), tasksText, 'utf8');

    const snapshot = await readRepositorySnapshot(root, { now: new Date('2026-07-18T11:00:00.000Z') });

    expect(snapshot.agents).toHaveLength(3);
    expect(snapshot.v4Operations).toMatchObject({ available: false, revision: 0 });
    expect(await readFile(path.join(state, 'agents.json'), 'utf8')).toBe(agentsText);
    expect(await readFile(path.join(state, 'tasks.json'), 'utf8')).toBe(tasksText);
  });

  test('reads optional user-facing ledgers from their canonical paths', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'orquesta-reader-attention-'));
    temporaryRoots.push(root);
    const state = path.join(root, '.orquesta', 'state');
    const vision = path.join(root, '.orquesta', 'vision');
    const userTasks = path.join(root, '.orquesta', 'user_tasks');
    const failures = path.join(root, '.orquesta', 'failures');
    await Promise.all([
      mkdir(state, { recursive: true }),
      mkdir(vision, { recursive: true }),
      mkdir(userTasks, { recursive: true }),
      mkdir(failures, { recursive: true })
    ]);
    await Promise.all([
      writeFile(path.join(state, 'agents.json'), JSON.stringify({ agents: [] }), 'utf8'),
      writeFile(path.join(state, 'tasks.json'), JSON.stringify({ tasks: [] }), 'utf8'),
      writeFile(path.join(state, 'dashboard_actions.json'), JSON.stringify({ actions: [{ action_id: 'DA1', status: 'requested', type: 'report_review' }] }), 'utf8'),
      writeFile(path.join(vision, 'questions.json'), JSON.stringify({ questions: [{ question_id: 'Q1', status: 'pending', question: 'Choose.' }] }), 'utf8'),
      writeFile(path.join(userTasks, 'queue.json'), JSON.stringify({ tasks: [{ user_task_id: 'UT1', status: 'pending', title: 'Run locally' }] }), 'utf8'),
      writeFile(path.join(failures, 'user_actions.json'), JSON.stringify({ actions: [{ action_id: 'UA1', status: 'ready', title: 'Repair locally' }] }), 'utf8')
    ]);

    const snapshot = await readRepositorySnapshot(root);

    expect(snapshot.attention.map((item) => item.id)).toEqual([
      'question:Q1',
      'user-task:UT1',
      'user-action:UA1',
      'dashboard-action:DA1'
    ]);
  });

  test('rejects malformed required JSON with a bounded filename', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'orquesta-reader-bad-'));
    temporaryRoots.push(root);
    const state = path.join(root, '.orquesta', 'state');
    await mkdir(state, { recursive: true });
    await writeFile(path.join(state, 'agents.json'), '{ bad', 'utf8');
    await writeFile(path.join(state, 'tasks.json'), '{"tasks":[]}', 'utf8');

    await expect(readRepositorySnapshot(root)).rejects.toThrow('agents.json');
  });
});
