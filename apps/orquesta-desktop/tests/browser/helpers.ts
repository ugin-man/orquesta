import type { Page } from '@playwright/test';

export async function openFixture(
  page: Page,
  fixture: string,
  viewport: { width: number; height: number } = { width: 1440, height: 900 }
) {
  await page.setViewportSize(viewport);
  await page.goto(`/?fixture=${encodeURIComponent(fixture)}`);
  await page.locator('.desktop-shell').waitFor();
  await page.locator('.prototype-badge').waitFor();
}
