import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication } from 'playwright';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('renders the operation phase without viewport overflow', async () => {
  const userData = await mkdtemp(path.join(os.tmpdir(), 'orquesta-setup-visual-user-'));
  const screenshotPath = path.join(appRoot, 'test-results', 'setup-operation-desktop.png');
  let desktop: ElectronApplication | null = null;

  try {
    desktop = await electron.launch({
      args: [`--user-data-dir=${userData}`, '--lang=ja-JP', '.'],
      cwd: appRoot,
      env: { ...process.env, ORQUESTA_E2E: '1', ORQUESTA_E2E_FIXTURE: 'setup-operation' }
    });
    const window = await desktop.firstWindow();
    const setup = window.getByLabel('Orquesta 初回セットアップ');
    await expect(setup).toBeVisible();
    await expect(setup.locator('[data-setup-phase]')).toHaveCount(6);
    await expect(setup.locator('[data-setup-phase][data-state="active"]')).toHaveAttribute('aria-label', /フェーズ6/u);
    await expect(window.getByRole('region', { name: 'パイプオルガン構築状況' })).toBeVisible();

    const overflow = await window.evaluate(() => ({
      horizontal: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      vertical: document.documentElement.scrollHeight - document.documentElement.clientHeight
    }));
    expect(overflow).toEqual({ horizontal: 0, vertical: 0 });

    await mkdir(path.dirname(screenshotPath), { recursive: true });
    await window.screenshot({ path: screenshotPath });
  } finally {
    await desktop?.close().catch(() => undefined);
    await rm(userData, { recursive: true, force: true });
  }
});
