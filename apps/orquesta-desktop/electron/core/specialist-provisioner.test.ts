import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { readRepositorySnapshot } from './repository-reader';
import { provisionSpecialists, type ProvisioningBatch } from './specialist-provisioner';

const roots: string[] = [];
const NOW = '2026-07-20T15:00:00.000Z';

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRepository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'orquesta-provision-'));
  roots.push(root);
  const state = path.join(root, '.orquesta', 'state');
  const setup = path.join(root, '.orquesta', 'setup');
  await mkdir(state, { recursive: true });
  await mkdir(setup, { recursive: true });
  await writeFile(path.join(state, 'roles.json'), JSON.stringify({
    schema_version: 1,
    organization_revision: 2,
    roles: [
      {
        role_id: 'orchestrator',
        version: 1,
        display_names: { ja: '統括者', en: 'Orchestrator' },
        aliases: [],
        capability_ids: ['role:orchestrator'],
        default_contract_template: 'orchestrator-v1',
        lifecycle_state: 'active'
      },
      {
        role_id: 'implementation',
        version: 1,
        display_names: { ja: '実装係', en: 'Implementation' },
        aliases: [],
        capability_ids: ['role:implementation'],
        default_contract_template: 'implementation-v1',
        lifecycle_state: 'active'
      },
      ...['design', 'testing', 'docs'].map((roleId) => ({
        role_id: roleId,
        version: 1,
        display_names: { ja: roleId, en: roleId },
        aliases: [],
        capability_ids: [`role:${roleId}`],
        default_contract_template: `${roleId}-v1`,
        lifecycle_state: 'active'
      }))
    ],
    updated_at: NOW
  }), 'utf8');
  await writeFile(path.join(state, 'agents.json'), JSON.stringify({
    version: 1,
    schema_version: 2,
    organization_revision: 2,
    agents: [
      ['implementation-001', 'implementation', 'T001'],
      ['design-001', 'design', 'T002'],
      ['test-001', 'testing', 'T003'],
      ['docs-001', 'docs', 'T004']
    ].map(([agentId, roleId, taskId]) => ({
      agent_id: agentId,
      role: roleId,
      role_id: roleId,
      role_version: 1,
      team_id: 'desktop-team',
      line_id: 'desktop-line',
      organization_scope: 'line',
      lifecycle_state: 'provisioning',
      operational_status: 'standby',
      status: 'provisioning',
      provisioning_task_id: taskId,
      updated_at: NOW
    }))
  }), 'utf8');
  await writeFile(path.join(state, 'organization.json'), JSON.stringify({
    schema_version: 2,
    revision: 2,
    policy: {
      organization_changes: 'autonomous_except_new_line',
      max_concurrent_provisioning: 3,
      require_executable_task_per_new_agent: true,
      require_no_file_ownership_conflict: true
    },
    agents: [
      {
        agent_id: 'orchestrator',
        role_id: 'orchestrator',
        organization_scope: 'project',
        lifecycle_state: 'active',
        operational_status: 'working'
      },
      {
        agent_id: 'implementation-001',
        role_id: 'implementation',
        organization_scope: 'line',
        lifecycle_state: 'provisioning',
        operational_status: 'standby'
      },
      ...[
        ['design-001', 'design'],
        ['test-001', 'testing'],
        ['docs-001', 'docs']
      ].map(([agentId, roleId]) => ({
        agent_id: agentId,
        role_id: roleId,
        organization_scope: 'line',
        lifecycle_state: 'provisioning',
        operational_status: 'standby'
      }))
    ],
    teams: [{
      team_id: 'desktop-team',
      line_id: 'desktop-line',
      display_name: 'Desktop team',
      purpose: 'Implement the Desktop line',
      lifecycle_state: 'active'
    }],
    memberships: ['implementation-001', 'design-001', 'test-001', 'docs-001'].map((agentId, index) => ({
      membership_id: `membership-desktop-${agentId}`,
      agent_id: agentId,
      team_id: 'desktop-team',
      position: 'member',
      ordinal: index + 1,
      active_from: NOW,
      active_to: null
    })),
    relationships: ['implementation-001', 'design-001', 'test-001', 'docs-001'].map((agentId) => ({
      relationship_id: `relationship-${agentId}-orchestrator`,
      type: 'reports_to',
      from_agent_id: agentId,
      to_agent_id: 'orchestrator'
    })),
    lines: [{
      line_id: 'desktop-line',
      display_name: 'Desktop line',
      goal: 'Build the Desktop application',
      deliverable_ids: ['desktop-app'],
      completion_root_ids: ['T001', 'T002', 'T003', 'T004'],
      scope: ['apps/orquesta-desktop'],
      owner_agent_id: 'orchestrator',
      dedicated_lead_agent_id: null,
      status: 'active',
      approval_source: 'setup_confirmation'
    }],
    applied_decision_ids: []
  }), 'utf8');
  await writeFile(path.join(state, 'sessions.json'), JSON.stringify({ version: 1, sessions: [] }), 'utf8');
  await writeFile(path.join(state, 'tasks.json'), JSON.stringify({ version: 1, tasks: [
    { task_id: 'T001', state: 'queued', owner_agent_id: 'implementation-001' },
    { task_id: 'T002', state: 'queued', owner_agent_id: 'design-001' },
    { task_id: 'T003', state: 'queued', owner_agent_id: 'test-001' },
    { task_id: 'T004', state: 'queued', owner_agent_id: 'docs-001' }
  ] }), 'utf8');
  await writeFile(path.join(setup, 'setup_state.json'), JSON.stringify({
    schema_version: 1,
    status: 'running',
    current_phase: 'specialists',
    phases: ['environment', 'understanding', 'foundation', 'planning', 'specialists', 'operation'],
    updated_at: NOW
  }), 'utf8');
  return root;
}

function batch(requests: ProvisioningBatch['requests']): ProvisioningBatch {
  return {
    provisioning_batch_id: 'PB-0123456789ab',
    organization_revision: 2,
    max_concurrent_provisioning: 3,
    requests,
    created_at: NOW
  };
}

function request(agentId: string, roleId: string, taskId: string): ProvisioningBatch['requests'][number] {
  return {
    agent_id: agentId,
    role_id: roleId,
    team_id: 'desktop-team',
    line_id: 'desktop-line',
    task_id: taskId,
    status: 'pending',
    created_at: NOW
  };
}

async function json(root: string, relativePath: string) {
  return JSON.parse(await readFile(path.join(root, relativePath), 'utf8')) as Record<string, unknown>;
}

describe('provisionSpecialists', () => {
  test('persists an agent, session, and active task only after Codex accepts the handoff', async () => {
    const root = await makeRepository();
    const runtime = {
      sendMessage: vi.fn(async () => ({
        threadId: 'thread-implementation-001',
        turnId: 'turn-implementation-001'
      }))
    };

    const result = await provisionSpecialists({
      root,
      batch: batch([request('implementation-001', 'implementation', 'T001')]),
      runtime,
      now: () => NOW
    });

    expect(runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      projectId: path.basename(root),
      rootPath: root,
      threadId: null,
      targetAgentId: 'implementation-001',
      text: expect.stringContaining('T001')
    }));
    expect(result.requests[0]).toMatchObject({
      agent_id: 'implementation-001',
      status: 'standby',
      thread_id: 'thread-implementation-001',
      turn_id: 'turn-implementation-001',
      handoff_status: 'accepted'
    });
    await expect(json(root, '.orquesta/state/agents.json')).resolves.toMatchObject({
      agents: expect.arrayContaining([expect.objectContaining({
        agent_id: 'implementation-001',
        lifecycle_state: 'active',
        operational_status: 'standby',
        thread_id: 'thread-implementation-001'
      })])
    });
    await expect(json(root, '.orquesta/state/organization.json')).resolves.toMatchObject({
      revision: 3,
      agents: expect.arrayContaining([expect.objectContaining({
        agent_id: 'implementation-001',
        lifecycle_state: 'active',
        operational_status: 'standby'
      })])
    });
    await expect(json(root, '.orquesta/setup/setup_state.json')).resolves.toMatchObject({
      status: 'completed',
      current_phase: 'operation',
      completed_at: NOW,
      current_activity: expect.objectContaining({ status: 'complete' })
    });
    await expect(json(root, '.orquesta/state/roles.json')).resolves.toMatchObject({ organization_revision: 3 });
    await expect(json(root, '.orquesta/state/agents.json')).resolves.toMatchObject({ organization_revision: 3 });
    await expect(json(root, '.orquesta/state/sessions.json')).resolves.toMatchObject({
      sessions: [expect.objectContaining({ agent_id: 'implementation-001', thread_id: 'thread-implementation-001' })]
    });
    const tasksState = await json(root, '.orquesta/state/tasks.json') as { tasks: Array<Record<string, unknown>> };
    expect(tasksState.tasks.find((task) => task.task_id === 'T001')).toMatchObject({
      task_id: 'T001',
      state: 'in_progress',
      handoff_turn_id: 'turn-implementation-001'
    });
    const snapshot = await readRepositorySnapshot(root);
    expect(snapshot.setup).toMatchObject({ status: 'completed', currentPhaseId: 'operation' });
    expect(snapshot.agents.find((agent) => agent.id === 'implementation-001')).toMatchObject({
      lifecycleState: 'active',
      operationalStatus: 'standby'
    });
  });

  test('reuses an accepted request without creating a duplicate Codex thread', async () => {
    const root = await makeRepository();
    const runtime = { sendMessage: vi.fn() };
    const accepted = {
      ...request('implementation-001', 'implementation', 'T001'),
      status: 'standby' as const,
      thread_id: 'thread-existing',
      turn_id: 'turn-existing',
      handoff_status: 'accepted' as const
    };

    const result = await provisionSpecialists({ root, batch: batch([accepted]), runtime, now: () => NOW });
    await provisionSpecialists({ root, batch: result, runtime, now: () => NOW });

    expect(runtime.sendMessage).not.toHaveBeenCalled();
    expect(result.requests[0]).toMatchObject({ thread_id: 'thread-existing', handoff_status: 'accepted' });
    await expect(json(root, '.orquesta/state/organization.json')).resolves.toMatchObject({ revision: 3 });
    await expect(json(root, '.orquesta/state/roles.json')).resolves.toMatchObject({ organization_revision: 3 });
    await expect(json(root, '.orquesta/state/agents.json')).resolves.toMatchObject({ organization_revision: 3 });
  });

  test('keeps the same agent id as provisioning_failed when Codex rejects the request', async () => {
    const root = await makeRepository();
    const runtime = { sendMessage: vi.fn(async () => { throw new Error('App Server unavailable'); }) };

    const result = await provisionSpecialists({
      root,
      batch: batch([request('implementation-001', 'implementation', 'T001')]),
      runtime,
      now: () => NOW
    });

    expect(result.requests[0]).toMatchObject({
      agent_id: 'implementation-001',
      status: 'provisioning_failed',
      handoff_status: 'failed',
      error: 'App Server unavailable'
    });
    await expect(json(root, '.orquesta/state/agents.json')).resolves.toMatchObject({
      agents: expect.arrayContaining([expect.objectContaining({
        agent_id: 'implementation-001',
        lifecycle_state: 'provisioning',
        operational_status: 'provisioning_failed',
        thread_id: null
      })])
    });
    await expect(json(root, '.orquesta/state/organization.json')).resolves.toMatchObject({
      revision: 3,
      agents: expect.arrayContaining([expect.objectContaining({
        agent_id: 'implementation-001',
        lifecycle_state: 'provisioning',
        operational_status: 'provisioning_failed'
      })])
    });
    await expect(json(root, '.orquesta/setup/setup_state.json')).resolves.toMatchObject({
      status: 'blocked',
      current_phase: 'specialists',
      current_activity: expect.objectContaining({ status: 'failed' }),
      provisioning_failures: [expect.objectContaining({ agent_id: 'implementation-001' })]
    });
    await expect(json(root, '.orquesta/state/sessions.json')).resolves.toMatchObject({ sessions: [] });
  });

  test('runs no more than three Codex handoffs concurrently and continues after a partial failure', async () => {
    const root = await makeRepository();
    let active = 0;
    let maximum = 0;
    const runtime = {
      sendMessage: vi.fn(async (input: { targetAgentId: string }) => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        if (input.targetAgentId === 'design-001') throw new Error('design handoff failed');
        return { threadId: `thread-${input.targetAgentId}`, turnId: `turn-${input.targetAgentId}` };
      })
    };

    const result = await provisionSpecialists({
      root,
      batch: batch([
        request('implementation-001', 'implementation', 'T001'),
        request('design-001', 'design', 'T002'),
        request('test-001', 'test', 'T003'),
        request('docs-001', 'docs', 'T004')
      ]),
      runtime,
      now: () => NOW
    });

    expect(maximum).toBe(3);
    expect(runtime.sendMessage).toHaveBeenCalledTimes(4);
    expect(result.requests.filter((item) => item.handoff_status === 'accepted')).toHaveLength(3);
    expect(result.requests.find((item) => item.agent_id === 'design-001')).toMatchObject({
      status: 'provisioning_failed',
      handoff_status: 'failed'
    });
    await expect(json(root, '.orquesta/state/organization.json')).resolves.toMatchObject({
      revision: 3,
      agents: expect.arrayContaining([
        expect.objectContaining({ agent_id: 'implementation-001', lifecycle_state: 'active' }),
        expect.objectContaining({ agent_id: 'design-001', operational_status: 'provisioning_failed' }),
        expect.objectContaining({ agent_id: 'test-001', lifecycle_state: 'active' }),
        expect.objectContaining({ agent_id: 'docs-001', lifecycle_state: 'active' })
      ])
    });
    await expect(json(root, '.orquesta/state/roles.json')).resolves.toMatchObject({ organization_revision: 3 });
    await expect(json(root, '.orquesta/state/agents.json')).resolves.toMatchObject({ organization_revision: 3 });
  });
});
