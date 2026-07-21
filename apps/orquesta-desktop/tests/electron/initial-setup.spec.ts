import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication } from 'playwright';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fakeAppServer = path.join(appRoot, 'tests', 'electron', 'fixtures', 'fake-codex-app-server.cjs');

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

test('starts canonical setup from the Desktop intake and resumes the same Phase 1 after restart', async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'orquesta-initial-setup-project-'));
  const userData = await mkdtemp(path.join(os.tmpdir(), 'orquesta-initial-setup-user-'));
  const statePath = path.join(projectRoot, '.orquesta', 'setup', 'setup_state.json');
  let desktop: ElectronApplication | null = null;

  try {
    desktop = await launchDesktop(userData, projectRoot);
    let window = await desktop.firstWindow();
    await expect(window.getByRole('heading', { name: 'Start Orquesta' })).toBeVisible();
    await expect(window.getByText('Connected with ChatGPT', { exact: true })).toBeVisible();
    await expect(window.getByLabel('Project', { exact: true }).getByText(projectRoot, { exact: true })).toBeVisible();

    await window.getByLabel('Project name').fill('Initial Setup Fixture');
    await window.getByLabel('Description').fill('Verify the Desktop-owned setup entry and canonical Phase 1.');
    await expect(access(statePath)).rejects.toMatchObject({ code: 'ENOENT' });

    await window.getByRole('button', { name: 'Start setup' }).click();
    await expect(window.getByLabel('Orquesta 初回セットアップ')).toBeVisible();
    await expect(window.getByRole('progressbar', { name: 'セットアップ進行状況' })).toHaveAttribute('aria-valuenow', '1');
    await expect(window.getByRole('heading', { name: '環境を確認中' })).toBeVisible();

    const firstState = JSON.parse(await readFile(statePath, 'utf8')) as {
      setup_id: string;
      current_phase_id: string;
      foundation_agents: Array<{ agent_id: string }>;
    };
    expect(firstState.current_phase_id).toBe('environment');
    expect(firstState.foundation_agents.map((agent) => agent.agent_id)).toEqual(['orchestrator', 'user-support', 'orquesta-admin']);

    await desktop.close();
    desktop = await launchDesktop(userData, projectRoot);
    window = await desktop.firstWindow();
    await expect(window.getByLabel('Orquesta 初回セットアップ')).toBeVisible();
    await expect(window.getByRole('progressbar', { name: 'セットアップ進行状況' })).toHaveAttribute('aria-valuenow', '1');
    const resumedState = JSON.parse(await readFile(statePath, 'utf8')) as { setup_id: string };
    expect(resumedState.setup_id).toBe(firstState.setup_id);
  } finally {
    await desktop?.close().catch(() => undefined);
    await Promise.all([
      rm(projectRoot, { recursive: true, force: true }),
      rm(userData, { recursive: true, force: true })
    ]);
  }
});
