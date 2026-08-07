import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fakeAppServer = path.join(appRoot, 'tests', 'electron', 'fixtures', 'fake-codex-app-server.cjs');

async function writeProject(root: string): Promise<void> {
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
        mission: 'Coordinate this project.'
      }]
    }, null, 2)}\n`, 'utf8'),
    writeFile(path.join(state, 'tasks.json'), '{"tasks":[]}\n', 'utf8'),
    writeFile(path.join(state, 'sessions.json'), `${JSON.stringify({
      sessions: [{
        agent_id: 'orchestrator',
        thread_id: 'thread-e2e',
        binding_status: 'bound',
        status: 'standby'
      }]
    }, null, 2)}\n`, 'utf8')
  ]);
}

async function turnStartCount(logPath: string): Promise<number> {
  try {
    return (await readFile(logPath, 'utf8'))
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { method?: string })
      .filter((entry) => entry.method === 'turn/start')
      .length;
  } catch {
    return 0;
  }
}

test('packaged Desktop routes two tasks through the V2 kernel and never redispatches on restart', async () => {
  test.skip(Boolean(process.env.ORQUESTA_PACKAGED_EXE),
    'Packaged Desktop deliberately rejects the external fake App Server; use the live runtime spec instead.');
  const root = await mkdtemp(path.join(os.tmpdir(), 'orquesta-kernel-e2e-project-'));
  const userData = await mkdtemp(path.join(os.tmpdir(), 'orquesta-kernel-e2e-user-'));
  const logPath = path.join(root, 'fake-app-server.jsonl');
  const kernelPath = path.join(root, '.orquesta', 'state', 'execution-kernel-v2.json');
  await writeProject(root);
  const packagedExecutable = process.env.ORQUESTA_PACKAGED_EXE;
  const launch = () => electron.launch({
    ...(packagedExecutable ? { executablePath: packagedExecutable } : { cwd: appRoot }),
    args: packagedExecutable
      ? [`--user-data-dir=${userData}`, '--lang=en-US']
      : [`--user-data-dir=${userData}`, '--lang=en-US', '.'],
    env: {
      ...process.env,
      ORQUESTA_E2E: '1',
      ORQUESTA_E2E_PROJECT_ROOT: root,
      ORQUESTA_E2E_CODEX_SCRIPT: fakeAppServer,
      ORQUESTA_E2E_CODEX_LOG: logPath,
      ORQUESTA_EXECUTION_KERNEL_V2: '1'
    }
  });

  let desktop = await launch();
  try {
    const window = await desktop.firstWindow();
    const composer = window.getByRole('textbox', { name: 'Give an instruction or ask a question…' });
    await composer.fill('First kernel task.');
    await window.getByRole('button', { name: 'Send message' }).click();
    await expect(window.getByText('Fake coordinator accepted the desktop instruction.')).toBeVisible();

    await composer.fill('DELAY_TURN');
    await window.getByRole('button', { name: 'Send message' }).click();
    await expect.poll(async () => {
      const state = JSON.parse(await readFile(kernelPath, 'utf8')) as { tasks: Record<string, unknown> };
      return Object.keys(state.tasks).length;
    }).toBe(2);
    expect(await turnStartCount(logPath)).toBe(2);
  } finally {
    await desktop.close();
  }

  desktop = await launch();
  try {
    const window = await desktop.firstWindow();
    await expect(window.getByRole('textbox', { name: 'Give an instruction or ask a question…' })).toBeVisible();
    await expect.poll(() => turnStartCount(logPath)).toBe(2);
    const state = JSON.parse(await readFile(kernelPath, 'utf8')) as {
      tasks: Record<string, { thread_id: string | null; turn_id: string | null }>;
    };
    const tasks = Object.values(state.tasks);
    expect(tasks).toHaveLength(2);
    expect(tasks.every((task) => task.thread_id === 'thread-e2e' && Boolean(task.turn_id))).toBe(true);
  } finally {
    await desktop.close();
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(userData, { recursive: true, force: true })
    ]);
  }
});
