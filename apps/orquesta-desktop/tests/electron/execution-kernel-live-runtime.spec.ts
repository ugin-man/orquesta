import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as canonicalAdapterModule from '@orquesta/codex-adapter';
import { expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';

type UnknownRecord = Record<string, unknown>;
type LiveAdapter = {
  createThread(input: UnknownRecord): Promise<UnknownRecord>;
  setThreadName(input: UnknownRecord): Promise<UnknownRecord>;
  archiveThread(input: UnknownRecord): Promise<UnknownRecord>;
  startTurn(input: UnknownRecord): Promise<UnknownRecord>;
  readThread(input: UnknownRecord): Promise<UnknownRecord>;
  shutdown(input: UnknownRecord): Promise<UnknownRecord>;
};

const packagedExecutable = process.env.ORQUESTA_PACKAGED_EXE;
const liveEnabled = process.env.ORQUESTA_LIVE_DESKTOP_E2E === '1';

function createLiveAdapter(): LiveAdapter {
  const imported = canonicalAdapterModule as unknown as {
    createAppServerAdapter?: () => LiveAdapter;
    default?: { createAppServerAdapter?: () => LiveAdapter };
  };
  const factory = imported.createAppServerAdapter ?? imported.default?.createAppServerAdapter;
  if (!factory) throw new Error('Codex App Server adapter factory is unavailable');
  return factory();
}

function successful(result: UnknownRecord, operation: string): UnknownRecord {
  if (result.ok === true) return result;
  const error = result.error && typeof result.error === 'object'
    ? result.error as UnknownRecord
    : null;
  throw new Error(typeof error?.message === 'string' ? error.message : `${operation} failed`);
}

async function createLiveThread(root: string): Promise<string> {
  const adapter = createLiveAdapter();
  try {
    const created = successful(await adapter.createThread({
      correlationId: randomUUID(),
      params: {
        cwd: root,
        sandbox: 'read-only',
        approvalPolicy: 'never'
      }
    }), 'createThread');
    const threadId = typeof created.thread_id === 'string' ? created.thread_id : null;
    if (!threadId) throw new Error('createThread returned no thread id');
    successful(await adapter.setThreadName({
      correlationId: randomUUID(),
      threadId,
      name: 'Temporary Orquesta Desktop kernel verification'
    }), 'setThreadName');
    const bootstrap = successful(await adapter.startTurn({
      correlationId: randomUUID(),
      threadId,
      input: [{
        type: 'text',
        text: 'Reply with exactly READY. Do not use tools.',
        text_elements: []
      }]
    }), 'startTurn');
    const bootstrapTurnId = typeof bootstrap.turn_id === 'string' ? bootstrap.turn_id : null;
    if (!bootstrapTurnId) throw new Error('bootstrap startTurn returned no turn id');
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const read = successful(await adapter.readThread({
        correlationId: randomUUID(),
        threadId,
        includeTurns: true
      }), 'readThread');
      const thread = read.thread && typeof read.thread === 'object'
        ? read.thread as UnknownRecord
        : null;
      const turns = Array.isArray(thread?.turns) ? thread.turns as UnknownRecord[] : [];
      const turn = turns.find((candidate) => candidate.id === bootstrapTurnId);
      if (turn?.status === 'completed') return threadId;
      if (['failed', 'interrupted', 'cancelled'].includes(String(turn?.status))) {
        throw new Error(`bootstrap turn ended as ${String(turn?.status)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('bootstrap turn did not complete within 60 seconds');
  } finally {
    await adapter.shutdown({ correlationId: randomUUID() }).catch(() => ({}));
  }
}

async function writeProject(root: string, threadId: string): Promise<void> {
  const state = path.join(root, '.orquesta', 'state');
  await mkdir(state, { recursive: true });
  await Promise.all([
    writeFile(path.join(state, 'agents.json'), `${JSON.stringify({
      updated_at: new Date().toISOString(),
      agents: [{
        agent_id: 'orchestrator',
        role: 'orchestrator',
        display_name: 'Coordinator',
        status: 'standby',
        mission: 'Coordinate this temporary verification project.'
      }]
    }, null, 2)}\n`, 'utf8'),
    writeFile(path.join(state, 'tasks.json'), '{"tasks":[]}\n', 'utf8'),
    writeFile(path.join(state, 'sessions.json'), `${JSON.stringify({
      sessions: [{
        agent_id: 'orchestrator',
        thread_id: threadId,
        binding_status: 'bound',
        status: 'standby'
      }]
    }, null, 2)}\n`, 'utf8')
  ]);
}

async function readKernelTasks(kernelPath: string): Promise<Record<string, UnknownRecord>> {
  const state = JSON.parse(await readFile(kernelPath, 'utf8')) as {
    tasks?: Record<string, UnknownRecord>;
  };
  return state.tasks ?? {};
}

async function readLiveThread(threadId: string): Promise<UnknownRecord> {
  const adapter = createLiveAdapter();
  try {
    const result = successful(await adapter.readThread({
      correlationId: randomUUID(),
      threadId,
      includeTurns: true
    }), 'readThread');
    return result.thread as UnknownRecord;
  } finally {
    await adapter.shutdown({ correlationId: randomUUID() }).catch(() => ({}));
  }
}

async function archiveLiveThread(threadId: string): Promise<void> {
  const adapter = createLiveAdapter();
  try {
    successful(await adapter.archiveThread({
      correlationId: randomUUID(),
      threadId
    }), 'archiveThread');
  } finally {
    await adapter.shutdown({ correlationId: randomUUID() }).catch(() => ({}));
  }
}

test('live packaged Desktop persists two real turns and never redispatches them on restart', async () => {
  test.skip(!liveEnabled || !packagedExecutable,
    'Set ORQUESTA_LIVE_DESKTOP_E2E=1 and ORQUESTA_PACKAGED_EXE to run the real packaged proof.');
  test.setTimeout(180_000);

  const root = await mkdtemp(path.join(os.tmpdir(), 'orquesta-kernel-live-project-'));
  const firstUserData = await mkdtemp(path.join(os.tmpdir(), 'orquesta-kernel-live-user-a-'));
  const secondUserData = await mkdtemp(path.join(os.tmpdir(), 'orquesta-kernel-live-user-b-'));
  const kernelPath = path.join(root, '.orquesta', 'state', 'execution-kernel-v2.json');
  let threadId: string | null = null;
  try {
    threadId = await createLiveThread(root);
    await writeProject(root, threadId);

    const launch = (userData: string) => electron.launch({
      executablePath: packagedExecutable,
      args: [`--user-data-dir=${userData}`, '--lang=en-US'],
      env: {
        ...process.env,
        ORQUESTA_E2E: '1',
        ORQUESTA_E2E_PROJECT_ROOT: root,
        ORQUESTA_EXECUTION_KERNEL_V2: '1'
      }
    });

    let desktop = await launch(firstUserData);
    try {
      const window = await desktop.firstWindow();
      const composer = window.getByRole('textbox', { name: 'Give an instruction or ask a question…' });
      await expect(composer).toBeVisible();

      await composer.fill('Reply with exactly DESKTOP_KERNEL_TASK_1. Do not use tools.');
      await window.getByRole('button', { name: 'Send message' }).click();
      await expect.poll(async () => {
        const tasks = Object.values(await readKernelTasks(kernelPath));
        return tasks.length === 1 ? tasks[0]?.state : null;
      }, { timeout: 90_000 }).toBe('verifying');

      await composer.fill('Reply with exactly DESKTOP_KERNEL_TASK_2. Do not use tools.');
      await window.getByRole('button', { name: 'Send message' }).click();
      await expect.poll(async () => {
        const tasks = Object.values(await readKernelTasks(kernelPath));
        return tasks.length === 2 && tasks.every((task) => task.state === 'verifying');
      }, { timeout: 90_000 }).toBe(true);
    } finally {
      await desktop.close();
    }

    const beforeRestart = await readKernelTasks(kernelPath);
    expect(Object.keys(beforeRestart)).toHaveLength(2);
    expect(Object.values(beforeRestart).every((task) => (
      task.thread_id === threadId && typeof task.turn_id === 'string' && Boolean(task.turn_id)
    ))).toBe(true);

    desktop = await launch(secondUserData);
    try {
      const window = await desktop.firstWindow();
      await expect(window.getByRole('textbox', { name: 'Give an instruction or ask a question…' })).toBeVisible();
      await expect.poll(async () => Object.keys(await readKernelTasks(kernelPath)).length).toBe(2);
    } finally {
      await desktop.close();
    }

    const afterRestart = await readKernelTasks(kernelPath);
    expect(Object.keys(afterRestart)).toEqual(Object.keys(beforeRestart));
    expect(Object.values(afterRestart).map((task) => task.turn_id))
      .toEqual(Object.values(beforeRestart).map((task) => task.turn_id));

    const thread = await readLiveThread(threadId);
    const turns = Array.isArray(thread.turns) ? thread.turns as UnknownRecord[] : [];
    const kernelTurnIds = new Set(Object.values(afterRestart).map((task) => task.turn_id));
    const completedKernelTurns = turns.filter((turn) => (
      turn.status === 'completed' && kernelTurnIds.has(turn.id)
    ));
    expect(completedKernelTurns).toHaveLength(2);
  } finally {
    try {
      if (threadId) await archiveLiveThread(threadId);
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(firstUserData, { recursive: true, force: true }),
        rm(secondUserData, { recursive: true, force: true })
      ]);
    }
  }
});
