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

test('shadow mode observes two existing sends with zero additional Codex turns', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'orquesta-shadow-e2e-project-'));
  const userData = await mkdtemp(path.join(os.tmpdir(), 'orquesta-shadow-e2e-user-'));
  const logPath = path.join(root, 'fake-app-server.jsonl');
  const shadowPath = path.join(root, '.orquesta', 'state', 'execution-kernel-shadow-v2.json');
  await writeProject(root);

  const launch = () => electron.launch({
    cwd: appRoot,
    args: [`--user-data-dir=${userData}`, '--lang=en-US', '.'],
    env: {
      ...process.env,
      ORQUESTA_E2E: '1',
      ORQUESTA_E2E_PROJECT_ROOT: root,
      ORQUESTA_E2E_CODEX_SCRIPT: fakeAppServer,
      ORQUESTA_E2E_CODEX_LOG: logPath,
      ORQUESTA_EXECUTION_KERNEL_V2: '0',
      ORQUESTA_EXECUTION_KERNEL_SHADOW_V2: '1'
    }
  });

  let observationIds: string[] = [];
  try {
    let desktop = await launch();
    try {
      const window = await desktop.firstWindow();
      const composer = window.getByRole('textbox', { name: 'Give an instruction or ask a question…' });
      await expect(composer).toBeVisible();

      await composer.fill('小さい状態確認を一つ行ってください。');
      await window.getByRole('button', { name: 'Send message' }).click();
      await expect.poll(async () => {
        const state = JSON.parse(await readFile(shadowPath, 'utf8')) as {
          metrics: { completed_turns: number };
        };
        return state.metrics.completed_turns;
      }).toBe(1);

      await composer.fill('Perform a differently worded second check.');
      await window.getByRole('button', { name: 'Send message' }).click();
      await expect.poll(async () => {
        const state = JSON.parse(await readFile(shadowPath, 'utf8')) as {
          metrics: { completed_turns: number };
        };
        return state.metrics.completed_turns;
      }).toBe(2);

      const state = JSON.parse(await readFile(shadowPath, 'utf8')) as {
        observations: Array<{ observation_id: string; predicted_action: string; actual_action: string }>;
        metrics: Record<string, number>;
      };
      observationIds = state.observations.map((item) => item.observation_id);
      expect(state.observations.map((item) => [item.predicted_action, item.actual_action])).toEqual([
        ['dispatch', 'dispatch_accepted'],
        ['dispatch', 'dispatch_accepted']
      ]);
      expect(state.metrics).toMatchObject({
        observed_dispatches: 2,
        actual_dispatches: 2,
        matching_dispatches: 2,
        divergences: 0,
        completed_turns: 2,
        additional_codex_turns: 0
      });
      expect(await turnStartCount(logPath)).toBe(2);
    } finally {
      await desktop.close();
    }

    desktop = await launch();
    try {
      const window = await desktop.firstWindow();
      await expect(window.getByRole('textbox', { name: 'Give an instruction or ask a question…' })).toBeVisible();
      await expect.poll(() => turnStartCount(logPath)).toBe(2);
      const state = JSON.parse(await readFile(shadowPath, 'utf8')) as {
        observations: Array<{ observation_id: string }>;
        metrics: { additional_codex_turns: number };
      };
      expect(state.observations.map((item) => item.observation_id)).toEqual(observationIds);
      expect(state.metrics.additional_codex_turns).toBe(0);
    } finally {
      await desktop.close();
    }
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(userData, { recursive: true, force: true })
    ]);
  }
});
