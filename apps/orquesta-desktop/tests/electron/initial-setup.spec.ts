import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication } from 'playwright';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fakeAppServer = path.join(appRoot, 'tests', 'electron', 'fixtures', 'fake-codex-app-server.cjs');
const phaseIds = ['environment', 'understanding', 'foundation', 'planning', 'specialists', 'operation'] as const;

async function launchDesktop(userData: string, projectRoot: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [`--user-data-dir=${userData}`, '--lang=en-US', '.'],
    cwd: appRoot,
    env: {
      ...process.env,
      ORQUESTA_E2E: '1',
      ORQUESTA_E2E_PROJECT_ROOT: projectRoot,
      ORQUESTA_E2E_CODEX_SCRIPT: fakeAppServer
    }
  });
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf8')) as T;
}

test('runs all six Desktop setup phases, opens Home, and keeps the completed setup after restart', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'orquesta-initial-setup-project-'));
  const userData = await mkdtemp(path.join(os.tmpdir(), 'orquesta-initial-setup-user-'));
  const statePath = path.join(projectRoot, '.orquesta', 'setup', 'setup_state.json');
  const eventsPath = path.join(projectRoot, '.orquesta', 'state', 'events.jsonl');
  const agentsPath = path.join(projectRoot, '.orquesta', 'state', 'agents.json');
  let desktop: ElectronApplication | null = null;

  try {
    desktop = await launchDesktop(userData, projectRoot);
    let window = await desktop.firstWindow();
    await expect(window.getByRole('heading', { name: 'Start Orquesta' })).toBeVisible();
    await expect(window.getByText('Connected with ChatGPT', { exact: true })).toBeVisible();
    await expect(window.getByLabel('Project', { exact: true }).getByText(projectRoot, { exact: true })).toBeVisible();

    await window.getByLabel('Project name').fill('Initial Setup Fixture');
    await window.getByLabel('Description').fill('Verify the complete six-phase Desktop setup journey.');
    await expect(access(statePath)).rejects.toMatchObject({ code: 'ENOENT' });

    await window.getByRole('button', { name: 'Start setup' }).click();
    const setup = window.getByLabel('Orquesta initial setup');
    await expect(setup).toBeVisible();
    await expect(setup.locator('[data-setup-phase]')).toHaveCount(6);
    await expect(window.getByRole('region', { name: 'Pipe organ build status' })).toBeVisible();
    await expect(window.getByRole('progressbar', { name: 'Setup progress' })).toBeVisible();
    await expect(setup).not.toContainText(/[\u3040-\u30ff\u3400-\u9fff]/u);

    await expect.poll(async () => {
      const state = await readJson<{ status: string; current_phase_id: string; completed_at: string | null }>(statePath);
      return { status: state.status, phase: state.current_phase_id, completed: Boolean(state.completed_at) };
    }, { timeout: 30_000 }).toEqual({ status: 'completed', phase: 'operation', completed: true });

    const setupState = await readJson<{
      setup_id: string;
      phases: Array<{ phase_id: string; status: string }>;
    }>(statePath);
    expect(setupState.phases.map((phase) => [phase.phase_id, phase.status])).toEqual(
      phaseIds.map((phaseId) => [phaseId, 'complete'])
    );

    const events = (await readFile(eventsPath, 'utf8')).trim().split(/\r?\n/u).map((line) => JSON.parse(line) as {
      type: string; phase_id?: string;
    });
    expect(events.filter((event) => event.type === 'setup_phase_started').map((event) => event.phase_id)).toEqual(phaseIds);
    expect(events.filter((event) => event.type === 'setup_phase_completed').map((event) => event.phase_id)).toEqual(phaseIds);
    expect(events.at(-1)?.type).toBe('initial_setup_completed');

    const agents = await readJson<{ agents: Array<{ agent_id: string }> }>(agentsPath);
    expect(agents.agents.map((agent) => agent.agent_id)).toEqual(expect.arrayContaining([
      'orchestrator', 'user-support', 'orquesta-admin'
    ]));

    await expect(window.getByRole('application', { name: 'Orquesta Desktop' })).toBeVisible({ timeout: 5_000 });
    await expect(setup).not.toBeVisible();

    await desktop.close();
    desktop = await launchDesktop(userData, projectRoot);
    window = await desktop.firstWindow();
    await expect(window.getByRole('application', { name: 'Orquesta Desktop' })).toBeVisible();
    await expect(window.getByLabel('Orquesta initial setup')).not.toBeVisible();
    const resumedState = await readJson<{ setup_id: string; status: string }>(statePath);
    expect(resumedState).toMatchObject({ setup_id: setupState.setup_id, status: 'completed' });
  } finally {
    await desktop?.close().catch(() => undefined);
    await Promise.all([
      rm(projectRoot, { recursive: true, force: true }),
      rm(userData, { recursive: true, force: true })
    ]);
  }
});
