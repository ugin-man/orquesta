import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { openFixture } from '../browser/helpers';

async function saveReviewCapture(page: Page, filename: string) {
  const directory = resolve(process.cwd(), 'artifacts/screenshots');
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: resolve(directory, filename), animations: 'disabled' });
}

async function openOperations(page: Page) {
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('button', { name: /Operations/ }).click();
  return page.getByRole('dialog', { name: 'Operations' });
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

for (const viewport of [{ width: 1440, height: 900 }, { width: 1366, height: 768 }]) {
  test(`V4 Operations at ${viewport.width} × ${viewport.height} stays inside the desktop composition`, async ({ page }) => {
    await openFixture(page, 'active-project', viewport);
    await (await openOperations(page)).waitFor();
    await saveReviewCapture(page, `operations-${viewport.width}x${viewport.height}.png`);
    await expect(page).toHaveScreenshot(`operations-${viewport.width}x${viewport.height}.png`);
  });
}

for (const tabName of ['Acquisition', 'Audit', 'Evidence']) {
  test(`${tabName} view keeps the V4 Operations visual hierarchy`, async ({ page }) => {
    await openFixture(page, 'active-project', { width: 1440, height: 900 });
    const dialog = await openOperations(page);
    await dialog.getByRole('tab', { name: tabName }).click();
    const filename = `operations-${tabName.toLowerCase()}-1440x900.png`;
    await saveReviewCapture(page, filename);
    await expect(page).toHaveScreenshot(filename);
  });
}
