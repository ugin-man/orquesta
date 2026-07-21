import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication } from 'playwright';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('runs the bilingual Home tutorial inside Electron Desktop', async () => {
  const userData = await mkdtemp(path.join(os.tmpdir(), 'orquesta-home-tutorial-user-'));
  let desktop: ElectronApplication | null = null;

  try {
    desktop = await electron.launch({
      args: [`--user-data-dir=${userData}`, '--lang=en-US', '.'],
      cwd: appRoot,
      env: {
        ...process.env,
        ORQUESTA_E2E: '1',
        ORQUESTA_E2E_FIXTURE: 'active-project'
      }
    });
    const window = await desktop.firstWindow();
    await expect(window.getByRole('application', { name: 'Orquesta Desktop' })).toBeVisible();

    await window.getByRole('button', { name: 'Settings' }).click();
    await window.getByRole('button', { name: 'Start tutorial' }).click();
    await expect(window.getByRole('dialog', { name: 'Orquesta map' })).toBeVisible();
    await expect(window.getByText('1 / 7')).toBeVisible();

    const remainingEnglishHeadings = [
      'Message the orchestrator',
      'User Tasks',
      'Now',
      'Switch workspaces',
      'Project controls and status',
      'Ask Luca'
    ];
    for (const heading of remainingEnglishHeadings) {
      await window.getByRole('button', { name: 'Next' }).click();
      await expect(window.getByRole('dialog', { name: heading })).toBeVisible();
    }
    await window.getByRole('button', { name: 'Complete' }).click();
    await expect(window.getByRole('dialog')).toHaveCount(0);

    await window.getByRole('button', { name: 'Settings' }).click();
    await window.getByRole('button', { name: '日本語' }).click();
    await window.getByRole('button', { name: 'ホーム画面のチュートリアルを開始' }).click();
    await expect(window.getByRole('dialog', { name: 'Orquestaマップ' })).toBeVisible();
    await expect(window.getByRole('button', { name: 'スキップ' })).toBeVisible();
    await window.getByRole('button', { name: 'スキップ' }).click();
    await expect(window.getByRole('dialog')).toHaveCount(0);
  } finally {
    await desktop?.close();
    await rm(userData, { recursive: true, force: true });
  }
});
