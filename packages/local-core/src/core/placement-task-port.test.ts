import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import executionKernel from '@orquesta/execution-kernel';
import type { PlacementTaskV3 } from '@orquesta/contracts';
import { PlacementTaskPort } from './placement-task-port';

const roots: string[] = [];
const INTENT_ID = 'PI-0123456789ab';
const NOW = '2026-08-24T06:00:00.000Z';

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'orquesta-placement-task-port-'));
  roots.push(root);
  return root;
}

async function appendInChildProcess(rootPath: string, index: number): Promise<void> {
  const packageRoot = path.resolve(import.meta.dirname, '..', '..');
  const vitestEntry = path.resolve(packageRoot, '..', '..', 'node_modules', 'vitest', 'vitest.mjs');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [
      vitestEntry,
      'run',
      'src/core/placement-task-port.process-worker.test.ts',
      '--pool=forks',
      '--maxWorkers=1'
    ], {
      cwd: packageRoot,
      env: {
        ...process.env,
        ORQUESTA_PLACEMENT_TASK_PROCESS_ROOT: rootPath,
        ORQUESTA_PLACEMENT_TASK_PROCESS_INDEX: String(index)
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Placement Task child ${index} failed (${code}): ${stdout}\n${stderr}`));
    });
  });
}

function task(overrides: Partial<PlacementTaskV3> = {}): PlacementTaskV3 {
  const base = {
    task_id: 'placement:0123456789ab:1',
    task_kind: 'specialist_work' as const,
    placement_intent_id: INTENT_ID,
    assigned_agent_id: 'implementation-0123456789ab-1',
    owner_agent_id: 'implementation-0123456789ab-1',
    role_id: 'implementation',
    role_version: 1,
    purpose: 'Implement the bounded feature.',
    acceptance_criteria: ['The accepted specialist session exists.'],
    state: 'queued' as const,
    dependencies: [],
    blocked_by: [],
    result_summary: null,
    accepted_at: null,
    specialist_report_required: true as const,
    created_at: NOW,
    updated_at: NOW
  };
  const record = { ...base, ...overrides } as Omit<PlacementTaskV3, 'placement_fingerprint'>;
  return { ...record, placement_fingerprint: executionKernel.taskFingerprint(record) };
}

function tasksPath(rootPath: string): string {
  return path.join(rootPath, '.orquesta', 'state', 'placement-tasks.json');
}

function coordinationTasksPath(rootPath: string): string {
  return path.join(rootPath, '.orquesta', 'state', 'tasks.json');
}

describe('PlacementTaskPort', () => {
  test('requires explicit initialization, then reconciles and inspects immutable tasks idempotently', async () => {
    const rootPath = await project();
    const port = new PlacementTaskPort(rootPath);
    await expect(port.reconcilePlacementTasks({ projectId: 'project-a', placementIntentId: INTENT_ID, tasks: [task()] }))
      .rejects.toMatchObject({ code: 'PLACEMENT_TASK_STATE_NOT_INITIALIZED' });
    await expect(readFile(tasksPath(rootPath), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    expect(await port.initializeFresh({ projectId: 'project-a' }))
      .toMatchObject({ status: 'ready', state_revision: 0, tasks: [] });
    const written = await port.reconcilePlacementTasks({ projectId: 'project-a', placementIntentId: INTENT_ID, tasks: [task()] });
    expect(written).toMatchObject({ status: 'ready', state_revision: 1, tasks: [{ task_id: 'placement:0123456789ab:1' }] });
    const inspected = await port.inspectPlacementTasks({
      projectId: 'project-a',
      placementIntentId: INTENT_ID,
      taskIds: ['placement:0123456789ab:1']
    });
    expect(inspected).toEqual(written);
    expect(await port.reconcilePlacementTasks({ projectId: 'project-a', placementIntentId: INTENT_ID, tasks: [task()] }))
      .toEqual(written);
  });

  test('keeps the coordination V1 ledger byte-stable while creating independent Placement authority', async () => {
    const rootPath = await project();
    const coordinationBytes = `${JSON.stringify({ version: 1, tasks: [{ id: 'coordination-task' }] })}\n`;
    await mkdir(path.dirname(coordinationTasksPath(rootPath)), { recursive: true });
    await writeFile(coordinationTasksPath(rootPath), coordinationBytes, 'utf8');
    const port = new PlacementTaskPort(rootPath);

    expect(port.read('project-a')).toMatchObject({ status: 'missing', filePath: tasksPath(rootPath) });
    await expect(port.initializeFresh({ projectId: 'project-a' }))
      .resolves.toMatchObject({ status: 'ready', state_revision: 0 });
    expect(await readFile(coordinationTasksPath(rootPath), 'utf8')).toBe(coordinationBytes);
    expect(port.read('project-a')).toMatchObject({ status: 'ready', state: { schema_version: 3 } });
  });

  test('copies a valid legacy shared-path Placement V3 authority and leaves the old owner path untouched', async () => {
    const rootPath = await project();
    const legacyBytes = `${JSON.stringify({ schema_version: 3, project_id: 'project-a', revision: 0, tasks: [] })}\n`;
    await mkdir(path.dirname(coordinationTasksPath(rootPath)), { recursive: true });
    await writeFile(coordinationTasksPath(rootPath), legacyBytes, 'utf8');
    const port = new PlacementTaskPort(rootPath);

    await expect(port.initializeFresh({ projectId: 'project-a' }))
      .resolves.toMatchObject({ status: 'ready', state_revision: 0 });
    expect(await readFile(tasksPath(rootPath), 'utf8')).toBe(legacyBytes);
    expect(await readFile(coordinationTasksPath(rootPath), 'utf8')).toBe(legacyBytes);
    await expect(port.initializeFresh({ projectId: 'project-a' }))
      .resolves.toMatchObject({ status: 'ready', state_revision: 0 });
  });

  test('never reads or retires a shared-path file after the dedicated Placement authority is ready', async () => {
    const rootPath = await project();
    const port = new PlacementTaskPort(rootPath);
    await port.initializeFresh({ projectId: 'project-a' });
    const currentBytes = await readFile(tasksPath(rootPath), 'utf8');
    const conflictingBytes = `${JSON.stringify({ schema_version: 3, project_id: 'project-a', revision: 1, tasks: [] })}\n`;
    await writeFile(coordinationTasksPath(rootPath), conflictingBytes, 'utf8');
    expect(port.read('project-a')).toMatchObject({ status: 'ready', state: { revision: 0 } });
    await expect(port.ensureAuthority({ projectId: 'project-a', policy: 'require_existing' }))
      .resolves.toMatchObject({ status: 'ready', state_revision: 0, changed: false, source: 'existing' });
    expect(await readFile(tasksPath(rootPath), 'utf8')).toBe(currentBytes);
    expect(await readFile(coordinationTasksPath(rootPath), 'utf8')).toBe(conflictingBytes);
  });

  test('strict authority policies migrate an exact old authority but never create an absent one', async () => {
    const absentRoot = await project();
    const absentPort = new PlacementTaskPort(absentRoot);
    await expect(absentPort.ensureAuthority({ projectId: 'project-a', policy: 'require_existing' }))
      .rejects.toMatchObject({ code: 'PLACEMENT_TASK_STATE_NOT_INITIALIZED' });
    await expect(readFile(tasksPath(absentRoot), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    const legacyRoot = await project();
    const legacyBytes = `${JSON.stringify({ schema_version: 3, project_id: 'project-a', revision: 0, tasks: [] })}\n`;
    await mkdir(path.dirname(coordinationTasksPath(legacyRoot)), { recursive: true });
    await writeFile(coordinationTasksPath(legacyRoot), legacyBytes, 'utf8');
    const legacyPort = new PlacementTaskPort(legacyRoot);
    await expect(legacyPort.ensureAuthority({ projectId: 'project-a', policy: 'migrate_only' }))
      .resolves.toMatchObject({ status: 'ready', state_revision: 0, changed: true, source: 'legacy_copy' });
    expect(await readFile(tasksPath(legacyRoot), 'utf8')).toBe(legacyBytes);
    expect(await readFile(coordinationTasksPath(legacyRoot), 'utf8')).toBe(legacyBytes);
  });

  test('does not manufacture Placement authority from an ambiguous shared task file', async () => {
    const rootPath = await project();
    const ambiguousBytes = '{broken';
    await mkdir(path.dirname(coordinationTasksPath(rootPath)), { recursive: true });
    await writeFile(coordinationTasksPath(rootPath), ambiguousBytes, 'utf8');
    const port = new PlacementTaskPort(rootPath);
    expect(port.read('project-a')).toMatchObject({ status: 'unsupported', reason: 'legacy_shared_task_state_ambiguous' });
    await expect(port.initializeFresh({ projectId: 'project-a' }))
      .rejects.toMatchObject({ code: 'PLACEMENT_TASK_STATE_UNSUPPORTED' });
    await expect(readFile(tasksPath(rootPath), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(coordinationTasksPath(rootPath), 'utf8')).toBe(ambiguousBytes);
  });

  test('does not let malformed foreign coordination state disable ready Placement authority', async () => {
    const rootPath = await project();
    const port = new PlacementTaskPort(rootPath);
    await port.initializeFresh({ projectId: 'project-a' });
    const placementBytes = await readFile(tasksPath(rootPath), 'utf8');
    const foreignBytes = '{coordination-write-in-progress';
    await writeFile(coordinationTasksPath(rootPath), foreignBytes, 'utf8');

    expect(port.read('project-a')).toMatchObject({ status: 'ready' });
    await port.initializeFresh({ projectId: 'project-a' });
    expect(await readFile(tasksPath(rootPath), 'utf8')).toBe(placementBytes);
    expect(await readFile(coordinationTasksPath(rootPath), 'utf8')).toBe(foreignBytes);
  });

  test('preserves the whole file when separate port instances append different tasks', async () => {
    const rootPath = await project();
    const first = new PlacementTaskPort(rootPath);
    const second = new PlacementTaskPort(rootPath);
    await first.initializeFresh({ projectId: 'project-a' });
    await first.reconcilePlacementTasks({ projectId: 'project-a', placementIntentId: INTENT_ID, tasks: [task()] });
    const secondTask = task({
      task_id: 'placement:0123456789ab:2',
      assigned_agent_id: 'implementation-0123456789ab-2',
      owner_agent_id: 'implementation-0123456789ab-2'
    });
    expect(await second.reconcilePlacementTasks({ projectId: 'project-a', placementIntentId: INTENT_ID, tasks: [secondTask] }))
      .toMatchObject({ state_revision: 2 });
    expect(first.read('project-a')).toMatchObject({
      status: 'ready',
      state: {
        revision: 2,
        tasks: [{ task_id: 'placement:0123456789ab:1' }, { task_id: 'placement:0123456789ab:2' }]
      }
    });
  });

  test('serializes concurrent cross-process appends through the live TaskPort boundary', async () => {
    const rootPath = await project();
    const port = new PlacementTaskPort(rootPath);
    await port.initializeFresh({ projectId: 'project-a' });
    await Promise.all(Array.from({ length: 4 }, (_, index) => appendInChildProcess(rootPath, index + 1)));
    const observed = port.read('project-a');
    expect(observed).toMatchObject({ status: 'ready', state: { revision: 4 } });
    if (observed.status !== 'ready') throw new Error('Placement Task state is not ready');
    expect(observed.state.tasks).toHaveLength(4);
    expect(new Set(observed.state.tasks.map((item) => item.task_id)).size).toBe(4);
    const runtime = path.join(rootPath, '.orquesta', 'runtime', 'placement-task-port');
    const staging = path.join(runtime, 'staging');
    expect((await readdir(staging)).filter((name) => name.startsWith('tasks-json.write-'))).toEqual([]);
    expect((await readdir(runtime)).filter((name) => name.includes('.candidate-') || name.includes('.recovery-'))).toEqual([]);
  }, 30_000);

  test('rejects immutable identity conflicts and leaves canonical bytes unchanged', async () => {
    const rootPath = await project();
    const port = new PlacementTaskPort(rootPath);
    await port.initializeFresh({ projectId: 'project-a' });
    await port.reconcilePlacementTasks({ projectId: 'project-a', placementIntentId: INTENT_ID, tasks: [task()] });
    const before = await readFile(tasksPath(rootPath), 'utf8');
    await expect(port.reconcilePlacementTasks({
      projectId: 'project-a',
      placementIntentId: INTENT_ID,
      tasks: [task({ purpose: 'Different immutable work.' })]
    })).rejects.toMatchObject({ code: 'PLACEMENT_TASK_IDENTITY_CONFLICT' });
    expect(await readFile(tasksPath(rootPath), 'utf8')).toBe(before);
  });

  test('requires every newly appended task to enter through the queued lifecycle boundary', async () => {
    const rootPath = await project();
    const port = new PlacementTaskPort(rootPath);
    await port.initializeFresh({ projectId: 'project-a' });
    const acceptedTask = task({
      state: 'accepted',
      result_summary: 'Bypassed the lifecycle.',
      accepted_at: NOW
    });
    await expect(port.reconcilePlacementTasks({
      projectId: 'project-a', placementIntentId: INTENT_ID, tasks: [acceptedTask]
    })).rejects.toMatchObject({ code: 'PLACEMENT_TASK_INITIAL_STATE_INVALID' });
    expect(port.read('project-a')).toMatchObject({ status: 'ready', state: { revision: 0, tasks: [] } });
  });

  test('owns mutable task lifecycle without changing immutable placement provenance', async () => {
    const rootPath = await project();
    const port = new PlacementTaskPort(rootPath);
    await port.initializeFresh({ projectId: 'project-a' });
    const created = await port.reconcilePlacementTasks({
      projectId: 'project-a', placementIntentId: INTENT_ID, tasks: [task()]
    });
    const transition: Parameters<PlacementTaskPort['transitionPlacementTask']>[0] = {
      projectId: 'project-a',
      expectedRevision: created.state_revision,
      taskId: 'placement:0123456789ab:1',
      expectedState: 'queued',
      next: {
        state: 'assigned',
        blockedBy: [],
        resultSummary: null,
        acceptedAt: null,
        changedAt: '2026-08-24T06:00:01.000Z'
      }
    };
    const assigned = await port.transitionPlacementTask(transition);
    expect(assigned).toMatchObject({
      state_revision: 2,
      tasks: [{ state: 'assigned', placement_fingerprint: task().placement_fingerprint }]
    });
    expect(await port.transitionPlacementTask(transition)).toEqual(assigned);
    const replay = await port.reconcilePlacementTasks({
      projectId: 'project-a', placementIntentId: INTENT_ID, tasks: [task()]
    });
    expect(replay).toEqual(assigned);
    await expect(port.transitionPlacementTask({
      projectId: 'project-a',
      expectedRevision: assigned.state_revision,
      taskId: 'placement:0123456789ab:1',
      expectedState: 'assigned',
      next: {
        state: 'accepted',
        blockedBy: [],
        resultSummary: 'Skipped mandatory review state.',
        acceptedAt: '2026-08-24T06:00:02.000Z',
        changedAt: '2026-08-24T06:00:02.000Z'
      }
    })).rejects.toMatchObject({ code: 'PLACEMENT_TASK_TRANSITION_INVALID' });
  });

  test('keeps blocked state and blocker evidence consistent and clears blockers on recovery', async () => {
    const rootPath = await project();
    const port = new PlacementTaskPort(rootPath);
    await port.initializeFresh({ projectId: 'project-a' });
    const created = await port.reconcilePlacementTasks({
      projectId: 'project-a', placementIntentId: INTENT_ID, tasks: [task()]
    });
    await expect(port.transitionPlacementTask({
      projectId: 'project-a', expectedRevision: created.state_revision,
      taskId: 'placement:0123456789ab:1', expectedState: 'queued',
      next: {
        state: 'blocked', blockedBy: [], resultSummary: null, acceptedAt: null,
        changedAt: '2026-08-24T06:00:01.000Z'
      }
    })).rejects.toMatchObject({ code: 'PLACEMENT_TASK_INPUT_INVALID' });
    await expect(port.transitionPlacementTask({
      projectId: 'project-a', expectedRevision: created.state_revision,
      taskId: 'placement:0123456789ab:1', expectedState: 'queued',
      next: {
        state: 'assigned', blockedBy: ['approval-required'], resultSummary: null, acceptedAt: null,
        changedAt: '2026-08-24T06:00:01.000Z'
      }
    })).rejects.toMatchObject({ code: 'PLACEMENT_TASK_INPUT_INVALID' });
    const blocked = await port.transitionPlacementTask({
      projectId: 'project-a', expectedRevision: created.state_revision,
      taskId: 'placement:0123456789ab:1', expectedState: 'queued',
      next: {
        state: 'blocked', blockedBy: ['approval-required'], resultSummary: null, acceptedAt: null,
        changedAt: '2026-08-24T06:00:01.000Z'
      }
    });
    await expect(port.transitionPlacementTask({
      projectId: 'project-a', expectedRevision: blocked.state_revision,
      taskId: 'placement:0123456789ab:1', expectedState: 'blocked',
      next: {
        state: 'in_progress', blockedBy: [], resultSummary: null, acceptedAt: null,
        changedAt: '2026-08-24T06:00:02.000Z'
      }
    })).rejects.toMatchObject({ code: 'PLACEMENT_TASK_TRANSITION_INVALID' });
    const recovered = await port.transitionPlacementTask({
      projectId: 'project-a', expectedRevision: blocked.state_revision,
      taskId: 'placement:0123456789ab:1', expectedState: 'blocked',
      next: {
        state: 'assigned', blockedBy: [], resultSummary: null, acceptedAt: null,
        changedAt: '2026-08-24T06:00:02.000Z'
      }
    });
    expect(recovered.tasks[0]).toMatchObject({ state: 'assigned', blocked_by: [] });
  });

  test('rejects noncanonical task order on disk and canonicalizes incoming task sets', async () => {
    const rootPath = await project();
    const port = new PlacementTaskPort(rootPath);
    await port.initializeFresh({ projectId: 'project-a' });
    const first = task();
    const second = task({
      task_id: 'placement:0123456789ab:2',
      assigned_agent_id: 'implementation-0123456789ab-2',
      owner_agent_id: 'implementation-0123456789ab-2'
    });
    const receipt = await port.reconcilePlacementTasks({
      projectId: 'project-a',
      placementIntentId: INTENT_ID,
      tasks: [second, first]
    });
    expect(receipt.tasks.map((item) => item.task_id)).toEqual([
      'placement:0123456789ab:1',
      'placement:0123456789ab:2'
    ]);
    const state = JSON.parse(await readFile(tasksPath(rootPath), 'utf8'));
    state.tasks.reverse();
    await writeFile(tasksPath(rootPath), `${JSON.stringify(state)}\n`, 'utf8');
    expect(port.read('project-a')).toMatchObject({ status: 'unsupported' });
  });

  test('classifies legacy and mixed task files as migration-required without rewriting them', async () => {
    for (const value of [
      { version: 1, tasks: [] },
      { schema_version: 3, project_id: 'project-a', revision: 0, tasks: [{ task_id: 'legacy-task', state: 'queued' }] }
    ]) {
      const rootPath = await project();
      await mkdir(path.dirname(tasksPath(rootPath)), { recursive: true });
      const bytes = `${JSON.stringify(value)}\n`;
      await writeFile(tasksPath(rootPath), bytes, 'utf8');
      const port = new PlacementTaskPort(rootPath);
      expect(port.read('project-a')).toMatchObject({ status: 'migration_required' });
      await expect(port.initializeFresh({ projectId: 'project-a' }))
        .rejects.toMatchObject({ code: 'PLACEMENT_TASK_MIGRATION_REQUIRED' });
      expect(await readFile(tasksPath(rootPath), 'utf8')).toBe(bytes);
    }
  });

  test('recovers only owned crash artifacts from isolated staging before the next write', async () => {
    const rootPath = await project();
    const port = new PlacementTaskPort(rootPath);
    await port.initializeFresh({ projectId: 'project-a' });
    const before = await readFile(tasksPath(rootPath), 'utf8');
    const staging = path.join(rootPath, '.orquesta', 'runtime', 'placement-task-port', 'staging');
    await mkdir(staging, { recursive: true });
    await writeFile(
      path.join(staging, 'tasks-json.write-01234567-89ab-4cde-8fab-0123456789ab.tmp'),
      'crash residue',
      'utf8'
    );
    await writeFile(path.join(staging, 'unowned-note.txt'), 'preserve', 'utf8');
    await port.reconcilePlacementTasks({ projectId: 'project-a', placementIntentId: INTENT_ID, tasks: [task()] });
    expect(await readdir(staging)).toEqual(['unowned-note.txt']);
    expect(await readFile(tasksPath(rootPath), 'utf8')).not.toBe(before);
  });

  test('fails closed when an owned staging name is not a canonical real file', async () => {
    const rootPath = await project();
    const port = new PlacementTaskPort(rootPath);
    await port.initializeFresh({ projectId: 'project-a' });
    const before = await readFile(tasksPath(rootPath), 'utf8');
    const unsafe = path.join(
      rootPath,
      '.orquesta',
      'runtime',
      'placement-task-port',
      'staging',
      'tasks-json.write-01234567-89ab-4cde-8fab-0123456789ab.tmp'
    );
    await mkdir(unsafe, { recursive: true });
    await expect(port.reconcilePlacementTasks({
      projectId: 'project-a', placementIntentId: INTENT_ID, tasks: [task()]
    })).rejects.toMatchObject({ code: 'PLACEMENT_TASK_PATH_UNSAFE' });
    expect(await readFile(tasksPath(rootPath), 'utf8')).toBe(before);
  });
});
