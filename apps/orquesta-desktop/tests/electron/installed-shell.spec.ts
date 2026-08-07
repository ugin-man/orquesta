import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';

const installedExecutable = process.env.ORQUESTA_PACKAGED_EXE;

test('boots the installed Windows application without sending a Codex turn', async () => {
  test.skip(!installedExecutable, 'Set ORQUESTA_PACKAGED_EXE to the installed Orquesta.exe.');
  await access(installedExecutable!);
  const userData = await mkdtemp(path.join(os.tmpdir(), 'orquesta-installed-shell-'));
  const desktop = await electron.launch({
    executablePath: installedExecutable,
    args: [`--user-data-dir=${userData}`, '--lang=en-US'],
    env: {
      ...process.env,
      ORQUESTA_E2E: '1',
      ORQUESTA_E2E_FIXTURE: 'active-project'
    }
  });

  try {
    const window = await desktop.firstWindow();
    await expect(window.getByRole('application', { name: 'Orquesta Desktop' })).toBeVisible();
    await expect(window.getByLabel('Orquesta Map')).toBeVisible();
    await expect(window.getByRole('textbox', { name: 'Give an instruction or ask a question…' })).toBeVisible();
  } finally {
    await desktop.close();
    await rm(userData, { recursive: true, force: true });
  }
});
