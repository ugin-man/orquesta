import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { OrquestaUiSnapshot } from '../../src/contracts/orquesta-ui';
import { emptyV4OperationsSnapshot } from '../../src/contracts/orquesta-ui';
import { RepositoryRuntime } from './repository-runtime';

const temporaryRepositories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(temporaryRepositories.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function snapshot(id: string, rootPath: string): OrquestaUiSnapshot {
  return {
    project: {
      id,
      title: path.win32.basename(rootPath),
      rootPathLabel: rootPath,
      status: 'ready',
      connectionLabel: 'Live repository',
      isDemoData: false,
      repositoryDisplayState: 'snapshot',
      lastSyncedAt: '2026-07-18T00:00:00.000Z',
      currentPhaseId: null,
      agentCount: 1,
      provenWorkingAgentCount: 0,
      summary: 'Ready',
      nextMilestone: null
    },
    agents: [{
      id: 'orchestrator',
      displayName: 'Coordinator',
      role: 'orchestrator',
      roleSummary: 'Coordinates work.',
      iconKey: 'network',
      status: 'standby',
      statusLabel: 'Idle',
      statusEvidence: 'proven',
      currentTaskId: null,
      currentTaskTitle: null,
      assignedByAgentId: null,
      blockedReason: null,
      waitingOn: null,
      contextScope: null,
      requiredReadingCount: 0,
      expectedArtifact: null,
      lastEvidenceAt: null,
      lastHeartbeatAt: null,
      recentEvidence: [],
      history: [],
      forbiddenActions: []
    }],
    tasks: [],
    attention: [],
    phases: [],
    recentEvents: [],
    v4Operations: emptyV4OperationsSnapshot()
  };
}

describe('RepositoryRuntime', () => {
  test('migrates a legacy organization before the first Desktop projection', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'orquesta-desktop-legacy-'));
    temporaryRepositories.push(root);
    const stateRoot = path.join(root, '.orquesta', 'state');
    await writeJson(path.join(stateRoot, 'agents.json'), {
      version: 1,
      agents: [
        { agent_id: 'orchestrator', role: 'orchestrator', status: 'active', thread_id: 'thread-orchestrator' },
        { agent_id: 'implementation-001', role: 'implementation', status: 'working', thread_id: 'thread-implementation' },
        { agent_id: 'user-liaison', role: 'user-liaison', status: 'standby', thread_id: 'thread-liaison' }
      ]
    });
    await writeJson(path.join(stateRoot, 'sessions.json'), { version: 1, sessions: [] });
    await writeJson(path.join(stateRoot, 'tasks.json'), { version: 1, tasks: [] });
    const runtime = new RepositoryRuntime({
      watchDirectory: vi.fn(() => ({ close: vi.fn() }))
    });

    const selected = await runtime.select({ projectId: 'legacy-project', rootPath: root });

    expect(selected.organization).toMatchObject({ source: 'explicit', revision: 1 });
    expect(selected.agents.map((agent) => agent.id)).toEqual(expect.arrayContaining([
      'orchestrator', 'implementation-001', 'user-liaison', 'user-support'
    ]));
    const migratedAgents = JSON.parse(await readFile(path.join(stateRoot, 'agents.json'), 'utf8')) as {
      schema_version: number;
      agents: Array<{ agent_id: string; lifecycle_state: string; superseded_by?: string | null }>;
    };
    expect(migratedAgents.schema_version).toBe(2);
    expect(migratedAgents.agents).toEqual(expect.arrayContaining([
      expect.objectContaining({ agent_id: 'implementation-001', lifecycle_state: 'active', organization_scope: 'line' }),
      expect.objectContaining({ agent_id: 'user-liaison', lifecycle_state: 'superseded', superseded_by: 'user-support' }),
      expect.objectContaining({ agent_id: 'user-support', lifecycle_state: 'active', organization_parent_agent_id: 'user' }),
      expect.objectContaining({ agent_id: 'orquesta-admin', lifecycle_state: 'active', organization_parent_agent_id: 'user' })
    ]));
  });

  test('repairs the malformed first Desktop migration without deleting agent history', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'orquesta-desktop-repair-'));
    temporaryRepositories.push(root);
    const stateRoot = path.join(root, '.orquesta', 'state');
    await writeJson(path.join(stateRoot, 'agents.json'), {
      version: 1,
      agents: [
        { agent_id: 'orchestrator', role: 'orchestrator', status: 'active', thread_id: 'thread-orchestrator' },
        { agent_id: 'implementation-001', role: 'implementation', status: 'working', thread_id: 'thread-implementation' },
        { agent_id: 'user-liaison', role: 'user-liaison', status: 'standby', thread_id: 'thread-liaison' }
      ]
    });
    await writeJson(path.join(stateRoot, 'sessions.json'), { version: 1, sessions: [] });
    await writeJson(path.join(stateRoot, 'tasks.json'), { version: 1, tasks: [] });
    const firstRuntime = new RepositoryRuntime({ watchDirectory: vi.fn(() => ({ close: vi.fn() })) });
    await firstRuntime.select({ projectId: 'repair-project', rootPath: root });
    await firstRuntime.stop();

    const agentsState = JSON.parse(await readFile(path.join(stateRoot, 'agents.json'), 'utf8')) as {
      agents: Array<Record<string, unknown>>;
    };
    const organizationState = JSON.parse(await readFile(path.join(stateRoot, 'organization.json'), 'utf8')) as {
      revision: number;
      agents: Array<Record<string, unknown>>;
      relationships: Array<Record<string, unknown>>;
    };
    agentsState.agents = agentsState.agents.map((agent) => ({ ...agent, organization_scope: 'project', organization_parent_agent_id: undefined }));
    organizationState.agents = organizationState.agents.map((agent) => ({ ...agent, organization_scope: 'project' }));
    organizationState.relationships = [
      { relationship_id: 'relationship-orquesta-admin-orchestrator', type: 'reports_to', from_agent_id: 'orquesta-admin', to_agent_id: 'orchestrator' },
      { relationship_id: 'relationship-user-support-orchestrator', type: 'reports_to', from_agent_id: 'user-support', to_agent_id: 'orchestrator' }
    ];
    await writeJson(path.join(stateRoot, 'agents.json'), agentsState);
    await writeJson(path.join(stateRoot, 'organization.json'), organizationState);

    const repairedRuntime = new RepositoryRuntime({ watchDirectory: vi.fn(() => ({ close: vi.fn() })) });
    const selected = await repairedRuntime.select({ projectId: 'repair-project', rootPath: root });
    const repairedAgents = JSON.parse(await readFile(path.join(stateRoot, 'agents.json'), 'utf8')) as {
      organization_revision: number;
      agents: Array<Record<string, unknown>>;
    };
    const repairedOrganization = JSON.parse(await readFile(path.join(stateRoot, 'organization.json'), 'utf8')) as {
      revision: number;
      relationships: Array<Record<string, unknown>>;
    };

    expect(selected.organization).toMatchObject({ source: 'explicit', revision: 2 });
    expect(selected.agents.find((agent) => agent.id === 'implementation-001')).toMatchObject({ organizationScope: 'line' });
    expect(selected.agents.find((agent) => agent.id === 'user-support')).toMatchObject({ organizationParentAgentId: 'user' });
    expect(selected.agents.find((agent) => agent.id === 'orquesta-admin')).toMatchObject({ organizationParentAgentId: 'user' });
    expect(repairedAgents.organization_revision).toBe(2);
    expect(repairedAgents.agents.find((agent) => agent.agent_id === 'user-liaison')).toMatchObject({
      lifecycle_state: 'superseded',
      thread_id: 'thread-liaison'
    });
    expect(repairedOrganization.revision).toBe(2);
    expect(repairedOrganization.relationships.some((relationship) => ['user-support', 'orquesta-admin'].includes(String(relationship.from_agent_id)))).toBe(false);
  });

  test('refuses to overwrite a partial organization migration', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'orquesta-desktop-partial-'));
    temporaryRepositories.push(root);
    const stateRoot = path.join(root, '.orquesta', 'state');
    const legacyAgents = {
      version: 1,
      agents: [{ agent_id: 'orchestrator', role: 'orchestrator', status: 'active', thread_id: 'thread-orchestrator' }]
    };
    await writeJson(path.join(stateRoot, 'agents.json'), legacyAgents);
    await writeJson(path.join(stateRoot, 'roles.json'), { schema_version: 1, organization_revision: 1, roles: [] });
    const runtime = new RepositoryRuntime({
      readSnapshot: vi.fn(async () => snapshot('partial-project', root)),
      watchDirectory: vi.fn(() => ({ close: vi.fn() }))
    });

    await expect(runtime.select({ projectId: 'partial-project', rootPath: root })).rejects.toThrow(/incomplete organization state/i);
    expect(JSON.parse(await readFile(path.join(stateRoot, 'agents.json'), 'utf8'))).toEqual(legacyAgents);
  });

  test('provisions pending setup specialists before projecting the selected repository', async () => {
    const first = snapshot('repo-first', 'C:\\first');
    const events: string[] = [];
    const runtime = new RepositoryRuntime({
      readSnapshot: vi.fn(async () => {
        events.push('snapshot');
        return first;
      }),
      readProvisioningBatch: vi.fn(async () => ({
        provisioning_batch_id: 'PB-0123456789ab',
        organization_revision: 2,
        max_concurrent_provisioning: 3,
        created_at: '2026-07-20T15:00:00.000Z',
        requests: [{
          agent_id: 'implementation-001', role_id: 'implementation', team_id: 'desktop-team', line_id: 'desktop-line',
          task_id: 'T001', status: 'pending', created_at: '2026-07-20T15:00:00.000Z'
        }]
      })),
      provisionSetupSpecialists: vi.fn(async () => {
        events.push('provision');
      }),
      watchDirectory: vi.fn(() => ({ close: vi.fn() }))
    });

    await runtime.select({ projectId: 'repo-first', rootPath: 'C:\\first' });

    expect(events).toEqual(['provision', 'snapshot']);
  });

  test('marks repository state watching only after a canonical watcher starts', async () => {
    const first = snapshot('repo-first', 'C:\\first');
    const runtime = new RepositoryRuntime({
      readSnapshot: vi.fn(async () => first),
      watchDirectory: vi.fn(() => ({ close: vi.fn() }))
    });

    const selected = await runtime.select({ projectId: 'repo-first', rootPath: 'C:\\first' });

    expect(selected.project.repositoryDisplayState).toBe('watching');
  });

  test('stops claiming a live watcher after the watcher reports an error', async () => {
    const first = snapshot('repo-first', 'C:\\first');
    let reportWatchError = (_error: Error) => undefined;
    const runtime = new RepositoryRuntime({
      readSnapshot: vi.fn(async () => first),
      watchDirectory: vi.fn((...args: unknown[]) => {
        reportWatchError = (args[2] as ((error: Error) => void) | undefined) ?? reportWatchError;
        return { close: vi.fn() };
      })
    });

    await runtime.select({ projectId: 'repo-first', rootPath: 'C:\\first' });
    reportWatchError(new Error('watcher failed'));

    expect(runtime.getSnapshot().project).toMatchObject({
      repositoryDisplayState: 'snapshot',
      connectionLabel: 'Watcher stopped · watcher failed'
    });
  });

  test('ignores a delayed watcher error from the previously selected project', async () => {
    const first = snapshot('repo-first', 'C:\\first');
    const second = snapshot('repo-second', 'C:\\second');
    const callbacks: Array<(error: Error) => void> = [];
    const close = vi.fn();
    const runtime = new RepositoryRuntime({
      readSnapshot: vi.fn(async (rootPath: string) => rootPath === 'C:\\first' ? first : second),
      watchDirectory: vi.fn((_directory, _onChange, onError) => {
        callbacks.push(onError);
        return { close };
      })
    });

    await runtime.select({ projectId: 'repo-first', rootPath: 'C:\\first' });
    await runtime.select({ projectId: 'repo-second', rootPath: 'C:\\second' });
    callbacks[0](new Error('late failure from first project'));

    expect(close).toHaveBeenCalledTimes(6);
    expect(runtime.getSnapshot().project).toMatchObject({
      id: 'repo-second',
      repositoryDisplayState: 'watching',
      connectionLabel: 'Live repository'
    });
  });

  test('merges canonical V4 operations on selection and refresh without changing the base snapshot', async () => {
    const first = snapshot('repo-first', 'C:\\first');
    const readSnapshot = vi.fn(async () => first);
    const readV4Operations = vi.fn(async () => ({
      ...emptyV4OperationsSnapshot(),
      available: true,
      revision: 12,
      limitation: null,
    }));
    const runtime = new RepositoryRuntime({
      readSnapshot,
      readV4Operations,
      watchDirectory: vi.fn(() => ({ close: vi.fn() })),
    });

    const selected = await runtime.select({ projectId: 'repo-first', rootPath: 'C:\\first' });
    expect(selected).toMatchObject({ project: { id: 'repo-first', status: 'ready' }, v4Operations: { available: true, revision: 12 } });
    await runtime.refresh();
    expect(readSnapshot).toHaveBeenCalledTimes(2);
    expect(readV4Operations).toHaveBeenCalledTimes(2);
    expect(readV4Operations).toHaveBeenLastCalledWith('C:\\first');
  });

  test('keeps valid repository state online when only the V4 journal is unavailable', async () => {
    const first = snapshot('repo-first', 'C:\\first');
    const runtime = new RepositoryRuntime({
      readSnapshot: vi.fn(async () => first),
      readV4Operations: vi.fn(async () => emptyV4OperationsSnapshot('V4 journal recovery required')),
      watchDirectory: vi.fn(() => ({ close: vi.fn() })),
    });

    const selected = await runtime.select({ projectId: 'repo-first', rootPath: 'C:\\first' });
    expect(selected).toMatchObject({
      project: { status: 'ready' },
      agents: [{ id: 'orchestrator', status: 'standby' }],
      v4Operations: { available: false, limitation: 'V4 journal recovery required' },
    });
  });

  test('watches all projection directories and closes every watcher on switch and shutdown', async () => {
    const first = snapshot('repo-first', 'C:\\first');
    const second = snapshot('repo-second', 'C:\\second');
    const readSnapshot = vi.fn(async (rootPath: string) => rootPath === 'C:\\first' ? first : second);
    const close = vi.fn();
    const watchDirectory = vi.fn((_directory: string, _onChange: () => void) => ({ close }));
    const runtime = new RepositoryRuntime({ readSnapshot, watchDirectory, debounceMs: 1 });

    await expect(runtime.select({ projectId: 'repo-first', rootPath: 'C:\\first' })).resolves.toMatchObject({
      project: { id: 'repo-first', repositoryDisplayState: 'watching' }
    });
    expect(first.project.repositoryDisplayState).toBe('snapshot');
    expect(watchDirectory.mock.calls.map(([directory]) => directory)).toEqual([
      path.join('C:\\first', '.orquesta', 'state'),
      path.join('C:\\first', '.orquesta', 'vision'),
      path.join('C:\\first', '.orquesta', 'user_tasks'),
      path.join('C:\\first', '.orquesta', 'failures'),
      path.join('C:\\first', '.orquesta', 'v4'),
      path.join('C:\\first', '.orquesta', 'setup')
    ]);

    await runtime.select({ projectId: 'repo-second', rootPath: 'C:\\second' });
    expect(close).toHaveBeenCalledTimes(6);
    await runtime.stop();
    expect(close).toHaveBeenCalledTimes(12);
  });

  test('debounces changes and retains the last snapshot as offline when a read fails', async () => {
    vi.useFakeTimers();
    const first = snapshot('repo-first', 'C:\\first');
    const readSnapshot = vi.fn().mockResolvedValueOnce(first).mockRejectedValueOnce(new Error('broken state'));
    let onChange = () => undefined;
    const runtime = new RepositoryRuntime({
      readSnapshot,
      watchDirectory: vi.fn((_directory, callback) => {
        onChange = callback;
        return { close: vi.fn() };
      }),
      debounceMs: 10
    });
    const listener = vi.fn();
    runtime.subscribe(listener);
    await runtime.select({ projectId: 'repo-first', rootPath: 'C:\\first' });

    onChange();
    onChange();
    await vi.advanceTimersByTimeAsync(10);

    expect(readSnapshot).toHaveBeenCalledTimes(2);
    expect(runtime.getSnapshot()).toMatchObject({
      project: { id: 'repo-first', title: 'first', status: 'offline' },
      agents: [{ id: 'orchestrator' }]
    });
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({
      project: expect.objectContaining({ status: 'offline' })
    }));
  });

  test('projects live runtime approvals without writing canonical state and keeps local resolved history', async () => {
    const first = snapshot('repo-first', 'C:\\first');
    const runtime = new RepositoryRuntime({
      readSnapshot: vi.fn(async () => first),
      watchDirectory: vi.fn(() => ({ close: vi.fn() }))
    });
    await runtime.select({ projectId: 'repo-first', rootPath: 'C:\\first' });
    runtime.addRuntimeApproval({
      projectId: 'repo-first', correlationId: 'corr-approval', requestId: 'approval-1', method: 'item/fileChange/requestApproval',
      threadId: 'thread-1', turnId: 'turn-1', reason: '[redacted approval reason]',
      responseOptions: ['accept', 'decline', 'cancel']
    });

    const item = runtime.getSnapshot().attention[0];
    expect(item).toMatchObject({
      id: 'runtime-approval-approval-1', type: 'approval', blocking: true, priority: 'blocker',
      runtimeApproval: { requestId: 'approval-1', responseOptions: ['accept', 'decline', 'cancel'] }
    });
    expect(runtime.runtimeApproval(item.id)).toMatchObject({ requestId: 'approval-1' });

    runtime.resolveRuntimeApproval(item.id, 'decline');
    expect(runtime.getSnapshot().attention).toEqual([]);
    expect(runtime.listAttentionHistory()).toEqual([
      expect.objectContaining({ id: item.id, resolvedAt: expect.any(String), resolutionLabel: 'decline' })
    ]);
  });
});
