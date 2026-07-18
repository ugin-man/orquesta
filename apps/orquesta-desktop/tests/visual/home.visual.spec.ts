import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { openFixture } from '../browser/helpers';

async function saveReviewCapture(page: Page, filename: string) {
  const directory = resolve(process.cwd(), 'artifacts/screenshots');
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: resolve(directory, filename), animations: 'disabled' });
}

test('active Home at 1440 × 900 matches the reviewed Renderer baseline', async ({ page }) => {
  await openFixture(page, 'active-project', { width: 1440, height: 900 });
  await saveReviewCapture(page, 'renderer-active-1440x900.png');
  await expect(page).toHaveScreenshot('home-active-1440x900.png');
});

test('active Home at 1366 × 768 keeps the desktop composition intact', async ({ page }) => {
  await openFixture(page, 'active-project', { width: 1366, height: 768 });
  await saveReviewCapture(page, 'renderer-active-1366x768.png');
  await expect(page).toHaveScreenshot('home-active-1366x768.png');
});
