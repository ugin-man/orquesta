import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('boots the packaged renderer behind the bounded desktop API', async () => {
  const desktop = await electron.launch({
    args: ['.'],
    cwd: appRoot,
    env: {
      ...process.env,
      ORQUESTA_E2E: '1'
    }
  });

  try {
    const window = await desktop.firstWindow();

    await expect(window).toHaveTitle('Orquesta Desktop Renderer');
    await expect(window.getByRole('application', { name: 'Orquesta Desktop' })).toBeVisible();
    await expect(window.getByLabel('Orquesta Map')).toBeVisible();

    const rendererBoundary = await window.evaluate(async () => {
      const api = globalThis.orquestaDesktop;
      const host = await api.getHostInfo();
      const ping = await api.pingCore('desktop-smoke');

      return {
        host,
        ping,
        requireType: typeof (globalThis as typeof globalThis & { require?: unknown }).require
      };
    });

    expect(rendererBoundary.requireType).toBe('undefined');
    expect(rendererBoundary.host).toEqual({ platform: 'win32', coreStatus: 'ready' });
    expect(rendererBoundary.ping).toEqual({ correlationId: 'desktop-smoke' });
  } finally {
    await desktop.close();
  }
});
