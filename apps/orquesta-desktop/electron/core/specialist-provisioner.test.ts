import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { readRepositorySnapshot } from './repository-reader';
import { establishRuntimeBinding } from './runtime-binding-store';
import { provisionFoundationAgents, provisionSpecialists, type ProvisioningBatch } from './specialist-provisioner';
import * as provisioningModule from './specialist-provisioner';

const roots: string[] = [];
const NOW = '2026-07-20T15:00:00.000Z';

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRepository(mode: 'standalone' | 'codex_hosted' = 'standalone'): Promise<string> {
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
  await writeFile(path.join(state, 'sessions.json'), JSON.stringify({
    version: 1,
    source: 'legacy-session-cache',
    project_cwd: 'C:\\stale-project',
    synced_at: '2026-07-01T00:00:00.000Z',
    retained_marker: 'keep-me',
    sessions: []
  }), 'utf8');
  await writeFile(path.join(state, 'tasks.json'), JSON.stringify({ version: 1, tasks: [
    { task_id: 'T001', state: 'queued', owner_agent_id: 'implementation-001' },
    { task_id: 'T002', state: 'queued', owner_agent_id: 'design-001' },
    { task_id: 'T003', state: 'queued', owner_agent_id: 'test-001' },
    { task_id: 'T004', state: 'queued', owner_agent_id: 'docs-001' }
  ] }), 'utf8');
  await writeFile(path.join(setup, 'setup_state.json'), JSON.stringify({
    schema_version: 3,
    status: 'running',
    current_phase_id: 'specialists',
    phases: ['environment', 'understanding', 'foundation', 'planning', 'specialists', 'operation'].map((phaseId, index) => ({
      phase_id: phaseId,
      status: index < 4 ? 'complete' : index === 4 ? 'active' : 'waiting',
      started_at: index <= 4 ? NOW : null,
      completed_at: index < 4 ? NOW : null,
      checkpoint_ref: index < 4 ? `setup/checkpoints/${phaseId}.json` : null
    })),
    updated_at: NOW,
    completed_at: null
  }), 'utf8');
  await establishRuntimeBinding({
    rootPath: root,
    projectId: 'demo-project',
    launchContext: mode === 'codex_hosted'
      ? { source: 'argv', callingThreadId: 'thread-calling-chat' }
      : { source: 'standalone', callingThreadId: null },
    authorityId: () => `authority-${mode}`,
    now: () => new Date(NOW)
  });
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

async function configureReportFreeTask(root: string, input: {
  transport: 'wait_threads' | 'manual_recovery';
  doneSignal: string;
  evidenceRefs?: string[];
}): Promise<void> {
  const tasksPath = path.join(root, '.orquesta', 'state', 'tasks.json');
  const state = JSON.parse(await readFile(tasksPath, 'utf8')) as { tasks: Array<Record<string, unknown>> };
  state.tasks = state.tasks.map((task) => task.task_id === 'T001' ? {
    ...task,
    specialist_report_required: false,
    completion_transport: input.transport,
    done_signal: input.doneSignal,
    deterministic_evidence_refs: input.evidenceRefs ?? [],
  } : task);
  await writeFile(tasksPath, JSON.stringify(state), 'utf8');
}

describe('provisionSpecialists', () => {
  test('requires an explicit runtime binding before any persistent provisioning', async () => {
    const root = await makeRepository();
    await rm(path.join(root, '.orquesta', 'state', 'runtime-binding.json'));
    const runtime = {
      sendMessage: vi.fn(async () => ({ threadId: 'thread-created', turnId: 'turn-created' }))
    };

    await expect(provisionSpecialists({
      root,
      batch: batch([request('implementation-001', 'implementation', 'T001')]),
      runtime,
      now: () => NOW
    })).rejects.toThrow('runtime_binding_required');
    await expect(provisionFoundationAgents({
      root,
      projectId: 'demo-project',
      agentIds: ['orchestrator'],
      runtime,
      now: () => NOW
    })).rejects.toThrow('runtime_binding_required');
    expect(runtime.sendMessage).not.toHaveBeenCalled();
  });

  test('does not create or cross-send persistent seats in Codex-hosted mode', async () => {
    const root = await makeRepository('codex_hosted');
    const runtime = {
      listProjectThreads: vi.fn(async () => [
        { id: 'thread-design-in-project', archived: false },
        { id: 'thread-archived', archived: true }
      ]),
      sendMessage: vi.fn(async (input: { targetAgentId: string; threadId: string | null }) => ({
        threadId: input.threadId ?? `created-${input.targetAgentId}`,
        turnId: `turn-${input.targetAgentId}`
      }))
    };

    const result = await provisionSpecialists({
      root,
      batch: batch([
        request('implementation-001', 'implementation', 'T001'),
        { ...request('design-001', 'design', 'T002'), thread_id: 'thread-design-in-project' },
        { ...request('test-001', 'testing', 'T003'), thread_id: 'thread-other-project' }
      ]),
      runtime,
      now: () => NOW
    });

    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      targetAgentId: 'design-001',
      threadId: 'thread-design-in-project'
    }));
    expect(result.requests.find((item) => item.agent_id === 'implementation-001')).toMatchObject({
      status: 'provisioning_failed',
      error: 'codex_hosted_thread_binding_required:implementation-001'
    });
    expect(result.requests.find((item) => item.agent_id === 'test-001')).toMatchObject({
      status: 'provisioning_failed',
      error: 'codex_hosted_thread_not_in_project:test-001:thread-other-project'
    });
  });

  test('uses the evidence-gated V2 source list only when the persisted route is active', async () => {
    const root = await makeRepository();
    const runtime = {
      sendMessage: vi.fn(async () => ({
        threadId: 'thread-active-v2',
        turnId: 'turn-active-v2'
      }))
    };
    await provisionSpecialists({
      root,
      batch: batch([{
        ...request('implementation-001', 'implementation', 'T001'),
        recommended_model: 'Terra',
        task_profile: {
          context_manifest: {
            required_reading: ['legacy/full-context.md'],
            allowed_files: ['src/app.js'],
            excluded_context: []
          },
          task_envelope: {
            task_envelope_id: 'TE-123456789abc',
            terminal_outcome: 'Ship the bounded implementation.',
            local_deliverable: 'Update src/app.js.',
            continue_policy: 'return_after_local',
            checkpoint_policy: 'non_blocking',
            execution: {
              execution_channel: 'product_implementation',
              conversation_history_policy: 'filtered'
            }
          },
          context_requirement: {
            requirement_id: 'CR-123456789abc',
            initial_token_budget: 6000,
            expansion_budget: 4000,
            missing_context_policy: 'request_bounded_expansion'
          },
          context_pack_id: 'CP2-123456789abc',
          context_route: {
            route: 'v2_bounded_retrieval',
            fallback: false,
            selected_source_refs: ['src/app.js']
          }
        }
      } as ProvisioningBatch['requests'][number]]),
      runtime,
      now: () => NOW
    });
    const handoff = runtime.sendMessage.mock.calls[0][0].text;
    expect(handoff).toContain('<context_v2_active mode="v2_bounded_retrieval">');
    expect(handoff).toContain('src/app.js');
    expect(handoff).not.toContain('legacy/full-context.md');
    expect(handoff).toContain('.agents/skills/orquesta/scripts/context-v2-broker.js');
    expect(handoff).toContain('--task "T001" bootstrap');
    expect(handoff).toContain('Bootstrap the selected context and its contents once');
  });

  test('does not manufacture a report or question-candidate requirement for report-free work', async () => {
    const root = await makeRepository();
    await configureReportFreeTask(root, {
      transport: 'wait_threads',
      doneSignal: 'Return DONE with the assigned test evidence.',
    });
    const runtime = {
      sendMessage: vi.fn(async () => ({
        threadId: 'thread-report-free',
        turnId: 'turn-report-free'
      }))
    };

    await provisionSpecialists({
      root,
      batch: batch([{
        ...request('implementation-001', 'implementation', 'T001'),
        specialist_report_required: false,
        completion_transport: 'wait_threads',
        done_signal: 'Return DONE with the assigned test evidence.'
      }]),
      runtime,
      now: () => NOW
    });

    const handoff = runtime.sendMessage.mock.calls[0][0].text;
    expect(handoff).toContain('Do not write a specialist report');
    expect(handoff).toContain('transport="wait_threads"');
    expect(handoff).toContain('Return DONE with the assigned test evidence.');
    expect(handoff).not.toContain('<report>');
    expect(handoff).not.toContain('question_candidates');
  });

  test('fails report-free manual recovery before handoff when durable evidence refs are absent', async () => {
    const root = await makeRepository();
    await configureReportFreeTask(root, {
      transport: 'manual_recovery',
      doneSignal: 'Return DONE after writing the assigned evidence.',
      evidenceRefs: [],
    });
    const runtime = {
      sendMessage: vi.fn(async () => ({ threadId: 'unexpected', turnId: 'unexpected' }))
    };
    const result = await provisionSpecialists({
      root,
      batch: batch([{
        ...request('implementation-001', 'implementation', 'T001'),
        specialist_report_required: false,
        completion_transport: 'manual_recovery',
        done_signal: 'Return DONE after writing the assigned evidence.',
        deterministic_evidence_refs: [],
      }]),
      runtime,
      now: () => NOW,
    });
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    expect(result.requests[0]).toMatchObject({
      status: 'provisioning_failed',
      handoff_status: 'failed',
      error: 'report_free_evidence_refs_required:T001',
    });
  });

  test('rejects a stale report-free downgrade and a non-durable manual evidence ref', async () => {
    const downgradeRoot = await makeRepository();
    const downgradeRuntime = {
      sendMessage: vi.fn(async () => ({ threadId: 'unexpected', turnId: 'unexpected' }))
    };
    const downgraded = await provisionSpecialists({
      root: downgradeRoot,
      batch: batch([{
        ...request('implementation-001', 'implementation', 'T001'),
        specialist_report_required: false,
        completion_transport: 'wait_threads',
        done_signal: 'DONE',
      }]),
      runtime: downgradeRuntime,
      now: () => NOW,
    });
    expect(downgradeRuntime.sendMessage).not.toHaveBeenCalled();
    expect(downgraded.requests[0].error).toBe('specialist_report_requirement_mismatch:T001');

    const invalidRefRoot = await makeRepository();
    await configureReportFreeTask(invalidRefRoot, {
      transport: 'manual_recovery',
      doneSignal: 'DONE',
      evidenceRefs: ['../outside.txt'],
    });
    const invalidRefRuntime = {
      sendMessage: vi.fn(async () => ({ threadId: 'unexpected', turnId: 'unexpected' }))
    };
    const invalidRef = await provisionSpecialists({
      root: invalidRefRoot,
      batch: batch([{
        ...request('implementation-001', 'implementation', 'T001'),
        specialist_report_required: false,
        completion_transport: 'manual_recovery',
        done_signal: 'DONE',
        deterministic_evidence_refs: ['../outside.txt'],
      }]),
      runtime: invalidRefRuntime,
      now: () => NOW,
    });
    expect(invalidRefRuntime.sendMessage).not.toHaveBeenCalled();
    expect(invalidRef.requests[0].error).toBe('report_free_evidence_ref_invalid:T001:../outside.txt');
  });

  test('persists an agent, session, and active task only after Codex accepts the handoff', async () => {
    const root = await makeRepository();
    const setupStateBeforeProvisioning = await json(root, '.orquesta/setup/setup_state.json');
    const tasksPath = path.join(root, '.orquesta', 'state', 'tasks.json');
    const initialTasks = JSON.parse(await readFile(tasksPath, 'utf8')) as {
      tasks: Array<Record<string, unknown>>;
    };
    initialTasks.tasks = initialTasks.tasks.map((task) => task.task_id === 'T001'
      ? {
          ...task,
          execution_policy_version: 1,
          handoff_sent_at: null,
          handoff_attempts: [],
          execution_cycles: [],
          execution_metrics: {
            wall_time_ms: 0,
            agent_turns: 0,
            handoffs: 0,
            independent_reviews: 0,
            correction_batches: 0,
            reports: 0,
            token_usage: { coverage: 'unknown', known_total: null, by_thread: [] }
          }
        }
      : task);
    await writeFile(tasksPath, JSON.stringify(initialTasks), 'utf8');
    const runtime = {
      sendMessage: vi.fn(async () => ({
        threadId: 'thread-implementation-001',
        turnId: 'turn-implementation-001'
      }))
    };

    const result = await provisionSpecialists({
      root,
      batch: batch([{
        ...request('implementation-001', 'implementation', 'T001'),
        recommended_model: 'Terra',
        task_profile: {
          context_manifest: {
            required_reading: ['packages/core/src/example.js'],
            allowed_files: ['packages/core/src/example.js'],
            excluded_context: ['unrelated'],
            missing_context_behavior: 'needs_context'
          },
          task_envelope: {
            task_envelope_id: 'TE-123456789abc',
            terminal_outcome: 'Ship the bounded implementation.',
            local_deliverable: 'Update packages/core/src/example.js.',
            continue_policy: 'return_after_local',
            checkpoint_policy: 'non_blocking',
            execution: {
              execution_channel: 'product_implementation',
              conversation_history_policy: 'filtered'
            }
          },
          context_requirement: {
            requirement_id: 'CR-123456789abc',
            initial_token_budget: 6000,
            expansion_budget: 4000,
            missing_context_policy: 'request_bounded_expansion'
          },
          context_pack_id: 'CP2-123456789abc',
          context_v2_mode: 'shadow',
          control_signals: { ambiguity: 'low' }
        }
      } as ProvisioningBatch['requests'][number]]),
      runtime,
      now: () => NOW
    });

    expect(runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      projectId: path.basename(root),
      rootPath: root,
      threadId: null,
      targetAgentId: 'implementation-001',
      threadTitle: 'Orquesta 実装係',
      text: expect.stringContaining('T001'),
      recommendedModel: 'Terra',
      requestedModel: null,
      effort: 'medium'
    }));
    const handoff = runtime.sendMessage.mock.calls[0][0].text;
    expect(handoff).toContain('<bounded_specialist_task version="1">');
    expect(handoff).toContain('<mode>implementation_only</mode>');
    expect(handoff).toContain('Do not load coordinator skills');
    expect(handoff).toContain('specialist_result JSON record');
    expect(handoff).toContain('packages/core/src/example.js');
    expect(handoff).toContain('canonical_state_root');
    expect(handoff).toContain('<context_v2_shadow mode="observe_only">');
    expect(handoff).toContain('<context_pack_id>CP2-123456789abc</context_pack_id>');
    expect(handoff).toContain('<execution_channel>product_implementation</execution_channel>');
    expect(handoff).toContain('must not broaden the V1 required_reading');
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
    await expect(json(root, '.orquesta/setup/setup_state.json')).resolves.toEqual(setupStateBeforeProvisioning);
    await expect(json(root, '.orquesta/state/roles.json')).resolves.toMatchObject({ organization_revision: 3 });
    await expect(json(root, '.orquesta/state/agents.json')).resolves.toMatchObject({ organization_revision: 3 });
    await expect(json(root, '.orquesta/state/sessions.json')).resolves.toMatchObject({
      source: 'desktop_codex_provisioning',
      project_cwd: root,
      synced_at: NOW,
      retained_marker: 'keep-me',
      sessions: [expect.objectContaining({
        agent_id: 'implementation-001',
        thread_id: 'thread-implementation-001',
        execution_channel: 'product_implementation',
        conversation_history_policy: 'filtered'
      })]
    });
    const tasksState = await json(root, '.orquesta/state/tasks.json') as { tasks: Array<Record<string, unknown>> };
    expect(tasksState.tasks.find((task) => task.task_id === 'T001')).toMatchObject({
      task_id: 'T001',
      state: 'in_progress',
      handoff_turn_id: 'turn-implementation-001',
      handoff_sent_at: NOW,
      handoff_attempts: [
        expect.objectContaining({
          owner_agent_id: 'implementation-001',
          sent_at: NOW
        })
      ],
      execution_cycles: [
        expect.objectContaining({
          kind: 'implementation',
          owner_agent_id: 'implementation-001',
          status: 'in_progress'
        })
      ],
      execution_metrics: expect.objectContaining({
        agent_turns: 1,
        handoffs: 1
      })
    });
    const snapshot = await readRepositorySnapshot(root);
    expect(snapshot.setup).toMatchObject({ status: 'running', currentPhaseId: 'specialists' });
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
    const setupStateBeforeProvisioning = await json(root, '.orquesta/setup/setup_state.json');
    const tasksPath = path.join(root, '.orquesta', 'state', 'tasks.json');
    const initialTasks = JSON.parse(await readFile(tasksPath, 'utf8')) as {
      tasks: Array<Record<string, unknown>>;
    };
    initialTasks.tasks = initialTasks.tasks.map((task) => task.task_id === 'T001'
      ? {
          ...task,
          execution_policy_version: 1,
          handoff_sent_at: null,
          handoff_attempts: [],
          execution_cycles: [],
          execution_metrics: {
            wall_time_ms: 0,
            agent_turns: 0,
            handoffs: 0,
            independent_reviews: 0,
            correction_batches: 0,
            reports: 0,
            token_usage: { coverage: 'unknown', known_total: null, by_thread: [] }
          }
        }
      : task);
    await writeFile(tasksPath, JSON.stringify(initialTasks), 'utf8');
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
    await expect(json(root, '.orquesta/setup/setup_state.json')).resolves.toEqual(setupStateBeforeProvisioning);
    await expect(json(root, '.orquesta/state/sessions.json')).resolves.toMatchObject({
      source: 'desktop_codex_provisioning',
      project_cwd: root,
      synced_at: NOW,
      retained_marker: 'keep-me',
      sessions: []
    });
    const tasks = await json(root, '.orquesta/state/tasks.json') as { tasks: Array<Record<string, unknown>> };
    expect(tasks.tasks.find((task) => task.task_id === 'T001')).toMatchObject({
      handoff_attempts: [
        expect.objectContaining({
          owner_agent_id: 'implementation-001',
          status: 'failed'
        })
      ],
      execution_metrics: expect.objectContaining({
        agent_turns: 0,
        handoffs: 1
      })
    });
  });

  test('keeps one persistent specialist task across history policies and execution channels', async () => {
    const filteredRoot = await makeRepository();
    const filteredRuntime = {
      sendMessage: vi.fn(async () => ({ threadId: 'thread-filtered-new', turnId: 'turn-filtered-new' }))
    };
    const filteredRequest = {
      ...request('implementation-001', 'implementation', 'T001'),
      thread_id: 'thread-old',
      thread_execution_channel: 'product_implementation',
      task_profile: {
        task_envelope: {
          task_envelope_id: 'TE-filtered',
          execution: {
            execution_channel: 'product_implementation',
            conversation_history_policy: 'filtered'
          }
        },
        context_requirement: { requirement_id: 'CR-filtered' }
      }
    } as ProvisioningBatch['requests'][number];
    await provisionSpecialists({
      root: filteredRoot,
      batch: batch([filteredRequest]),
      runtime: filteredRuntime,
      now: () => NOW
    });
    expect(filteredRuntime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-old' }));

    const deltaRoot = await makeRepository();
    const deltaRuntime = {
      sendMessage: vi.fn(async () => ({ threadId: 'thread-old', turnId: 'turn-delta' }))
    };
    const deltaRequest = {
      ...filteredRequest,
      task_profile: {
        ...filteredRequest.task_profile,
        task_envelope: {
          task_envelope_id: 'TE-delta',
          execution: {
            execution_channel: 'product_implementation',
            conversation_history_policy: 'existing_delta'
          }
        }
      }
    } as ProvisioningBatch['requests'][number];
    await provisionSpecialists({
      root: deltaRoot,
      batch: batch([deltaRequest]),
      runtime: deltaRuntime,
      now: () => NOW
    });
    expect(deltaRuntime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-old' }));

    const crossChannelRoot = await makeRepository();
    const crossChannelRuntime = {
      sendMessage: vi.fn(async () => ({ threadId: 'thread-cross-channel-new', turnId: 'turn-cross-channel-new' }))
    };
    await provisionSpecialists({
      root: crossChannelRoot,
      batch: batch([{
        ...deltaRequest,
        thread_execution_channel: 'live_operation'
      }]),
      runtime: crossChannelRuntime,
      now: () => NOW
    });
    expect(crossChannelRuntime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread-old' }));
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

describe('foundation provisioning', () => {
  test('fails closed for unbound Codex-hosted foundation seats without creating hidden tasks', async () => {
    const root = await makeRepository('codex_hosted');
    const runtime = {
      listProjectThreads: vi.fn(async () => [{ id: 'thread-calling-chat', archived: false }]),
      sendMessage: vi.fn(async (input: { targetAgentId: string; threadId: string | null }) => ({
        threadId: input.threadId ?? `created-${input.targetAgentId}`,
        turnId: `turn-${input.targetAgentId}`
      }))
    };

    const results = await provisionFoundationAgents({
      root,
      projectId: 'demo-project',
      agentIds: ['orchestrator', 'orquesta-admin', 'user-support'],
      preferredThreadIds: { orchestrator: 'thread-calling-chat' },
      runtime,
      now: () => NOW
    });

    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      targetAgentId: 'orchestrator',
      threadId: 'thread-calling-chat'
    }));
    expect(results.find((result) => result.agent_id === 'orquesta-admin')).toMatchObject({
      status: 'failed',
      error: 'codex_hosted_thread_binding_required:orquesta-admin'
    });
    expect(results.find((result) => result.agent_id === 'user-support')).toMatchObject({
      status: 'failed',
      error: 'codex_hosted_thread_binding_required:user-support'
    });
  });

  test('reuses a preferred calling thread only for the foundation agent whose ledger is missing', async () => {
    const root = await makeRepository();
    const runtime = {
      sendMessage: vi.fn(async (input: {
        targetAgentId: string;
        threadId: string | null;
        onThreadReady?: (threadId: string) => Promise<void> | void;
      }) => {
        const threadId = input.threadId ?? `thread-${input.targetAgentId}`;
        await input.onThreadReady?.(threadId);
        return {
          threadId,
          turnId: `turn-${input.targetAgentId}`
        };
      })
    };

    const results = await provisionFoundationAgents({
      root,
      projectId: 'demo-project',
      agentIds: ['orchestrator', 'orquesta-admin', 'user-support'],
      preferredThreadIds: { orchestrator: 'thread-calling-chat' },
      runtime,
      now: () => NOW
    });

    expect(runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      targetAgentId: 'orchestrator',
      threadTitle: '★ Orquesta 統括者',
      threadId: 'thread-calling-chat'
    }));
    expect(runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      targetAgentId: 'orquesta-admin',
      threadTitle: 'Orquesta 管理係 Luca',
      threadId: null
    }));
    expect(runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      targetAgentId: 'user-support',
      threadTitle: 'Orquesta 利用者支援係',
      threadId: null
    }));
    expect(results.find((result) => result.agent_id === 'orchestrator')).toMatchObject({
      status: 'accepted',
      thread_id: 'thread-calling-chat',
      turn_id: 'turn-orchestrator'
    });
  });

  test('creates one bounded session per foundation agent and preserves partial success for retry', async () => {
    const root = await makeRepository();
    const runtime = {
      sendMessage: vi.fn(async (input: { targetAgentId: string }) => {
        if (input.targetAgentId === 'orquesta-admin') throw new Error('admin handoff failed');
        return {
          threadId: `thread-${input.targetAgentId}`,
          turnId: `turn-${input.targetAgentId}`
        };
      })
    };
    const provisionFoundationAgents = (
      provisioningModule as unknown as {
        provisionFoundationAgents?: (input: {
          root: string;
          projectId: string;
          agentIds: string[];
          runtime: typeof runtime;
          now: () => string;
        }) => Promise<Array<Record<string, unknown>>>;
      }
    ).provisionFoundationAgents;

    expect(provisionFoundationAgents).toBeTypeOf('function');
    const results = await provisionFoundationAgents!({
      root,
      projectId: 'demo-project',
      agentIds: ['orchestrator', 'orquesta-admin', 'user-support'],
      runtime,
      now: () => NOW
    });

    expect(runtime.sendMessage).toHaveBeenCalledTimes(3);
    expect(runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      targetAgentId: 'orchestrator',
      threadTitle: '★ Orquesta 統括者',
      recommendedModel: 'Sol',
      requestedModel: null,
      text: expect.stringContaining('<orquesta_foundation_handoff>')
    }));
    expect(runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      targetAgentId: 'user-support',
      threadTitle: 'Orquesta 利用者支援係',
      recommendedModel: 'Luna'
    }));
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        agent_id: 'orchestrator',
        status: 'accepted',
        thread_id: 'thread-orchestrator',
        turn_id: 'turn-orchestrator'
      }),
      expect.objectContaining({
        agent_id: 'orquesta-admin',
        status: 'failed',
        thread_id: null,
        turn_id: null,
        error: 'admin handoff failed'
      })
    ]));
  });

  test('reuses a durably recorded foundation thread after interruption instead of creating another thread', async () => {
    const root = await makeRepository();
    const interruptedRuntime = {
      sendMessage: vi.fn(async (input: { onThreadReady?: (threadId: string) => Promise<void> }) => {
        await input.onThreadReady?.('thread-orchestrator');
        throw new Error('turn interrupted');
      })
    };

    const first = await provisionFoundationAgents({
      root,
      projectId: 'demo-project',
      agentIds: ['orchestrator'],
      runtime: interruptedRuntime,
      now: () => NOW
    });
    expect(first[0]).toMatchObject({
      status: 'failed',
      thread_id: 'thread-orchestrator'
    });

    const resumedRuntime = {
      sendMessage: vi.fn(async () => ({
        threadId: 'thread-orchestrator',
        turnId: 'turn-orchestrator'
      }))
    };
    const resumed = await provisionFoundationAgents({
      root,
      projectId: 'demo-project',
      agentIds: ['orchestrator'],
      preferredThreadIds: { orchestrator: 'thread-calling-chat' },
      runtime: resumedRuntime,
      now: () => NOW
    });

    expect(resumedRuntime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      threadId: 'thread-orchestrator'
    }));
    expect(resumed[0]).toMatchObject({
      status: 'accepted',
      thread_id: 'thread-orchestrator',
      turn_id: 'turn-orchestrator'
    });
  });

  test('does not use a preferred thread after a ledger was created without a thread id', async () => {
    const root = await makeRepository();
    await provisionFoundationAgents({
      root,
      projectId: 'demo-project',
      agentIds: ['orchestrator'],
      runtime: {
        sendMessage: vi.fn(async () => {
          throw new Error('resume failed before a thread was ready');
        })
      },
      now: () => NOW
    });
    const resumedRuntime = {
      sendMessage: vi.fn(async () => ({
        threadId: 'thread-new',
        turnId: 'turn-new'
      }))
    };

    const resumed = await provisionFoundationAgents({
      root,
      projectId: 'demo-project',
      agentIds: ['orchestrator'],
      preferredThreadIds: { orchestrator: 'thread-calling-chat' },
      runtime: resumedRuntime,
      now: () => NOW
    });

    expect(resumedRuntime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      threadId: null
    }));
    expect(resumed[0]).toMatchObject({
      status: 'accepted',
      thread_id: 'thread-new',
      turn_id: 'turn-new'
    });
  });
});
