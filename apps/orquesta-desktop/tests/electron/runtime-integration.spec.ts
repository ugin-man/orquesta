import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fakeAppServer = path.join(appRoot, 'tests', 'electron', 'fixtures', 'fake-codex-app-server.cjs');

test('sends a composer instruction to a Codex App Server thread and reads its history', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'orquesta-electron-runtime-'));
  const userData = await mkdtemp(path.join(os.tmpdir(), 'orquesta-electron-runtime-user-'));
  const state = path.join(root, '.orquesta', 'state');
  await mkdir(state, { recursive: true });
  await writeFile(path.join(state, 'agents.json'), JSON.stringify({
    updated_at: new Date().toISOString(),
    agents: [{ agent_id: 'orchestrator', role: 'orchestrator', display_name: 'Coordinator', status: 'standby', mission: 'Coordinate this project.' }]
  }), 'utf8');
  await writeFile(path.join(state, 'tasks.json'), JSON.stringify({ updated_at: new Date().toISOString(), tasks: [] }), 'utf8');

  const desktop = await electron.launch({
    args: [`--user-data-dir=${userData}`, '.'],
    cwd: appRoot,
    env: {
      ...process.env,
      ORQUESTA_E2E: '1',
      ORQUESTA_E2E_PROJECT_ROOT: root,
      ORQUESTA_CODEX_PATH: process.execPath,
      ORQUESTA_E2E_CODEX_SCRIPT: fakeAppServer
    }
  });

  try {
    const window = await desktop.firstWindow();
    const composer = window.getByRole('textbox', { name: 'Give an instruction or ask a question…' });
    await composer.fill('Continue from desktop.');
    await window.getByRole('button', { name: 'Send message' }).click();
    await expect(composer).toHaveValue('');
    await expect(window.getByText('Fake coordinator accepted the desktop instruction.')).toBeVisible();

    await window.getByRole('button', { name: 'Conversation history · Coordinator' }).click();
    const history = window.getByRole('dialog', { name: 'Conversation · Coordinator' });
    await expect(history).toBeVisible();
    await expect(history.getByText('Continue from desktop.')).toBeVisible();
    await expect(history.getByText('Fake coordinator accepted the desktop instruction.')).toBeVisible();
  } finally {
    await desktop.close();
    await Promise.all([rm(root, { recursive: true, force: true }), rm(userData, { recursive: true, force: true })]);
  }
});
