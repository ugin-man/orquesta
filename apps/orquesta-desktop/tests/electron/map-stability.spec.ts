import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { _electron as electron, type ElectronApplication } from 'playwright';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const captureRoot = path.join(appRoot, 'artifacts', 'screenshots');
const variants = [
  { label: '100pct-1440x900', scale: 1, width: 1440, height: 900 },
  { label: '125pct-1366x768', scale: 1.25, width: 1366, height: 768 },
  { label: '150pct-1440x900', scale: 1.5, width: 1440, height: 900 },
  { label: '200pct-1366x768', scale: 2, width: 1366, height: 768 }
] as const;

async function launchVariant(variant: typeof variants[number]): Promise<{ desktop: ElectronApplication; window: Page }> {
  const desktop = await electron.launch({
    args: ['--force-prefers-reduced-motion=reduce', '.'],
    cwd: appRoot,
    env: { ...process.env, ORQUESTA_E2E: '1', ORQUESTA_E2E_FIXTURE: 'large-roster' }
  });
  const window = await desktop.firstWindow();
  const session = await window.context().newCDPSession(window);
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: variant.width,
    height: variant.height,
    deviceScaleFactor: variant.scale,
    mobile: false
  });
  await expect(window.getByRole('application', { name: 'Orquesta Desktop' })).toBeVisible();
  return { desktop, window };
}

async function startLongTaskObserver(window: Page) {
  await window.evaluate(() => {
    const scope = globalThis as typeof globalThis & { __orquestaLongTasks?: number[]; __orquestaLongTaskObserver?: PerformanceObserver };
    scope.__orquestaLongTasks = [];
    scope.__orquestaLongTaskObserver = new PerformanceObserver((list) => {
      scope.__orquestaLongTasks?.push(...list.getEntries().map((entry) => entry.duration));
    });
    scope.__orquestaLongTaskObserver.observe({ entryTypes: ['longtask'] });
  });
}

test('keeps the complete hierarchy crisp and responsive in Electron', async () => {
  await mkdir(captureRoot, { recursive: true });
  const results: Array<{ label: string; width: number; height: number; requestedScale: number; actualScale: number; agentCount: number; overlapCount: number; maxLongTaskMs: number }> = [];

  for (const variant of variants) {
    const { desktop, window } = await launchVariant(variant);
    try {
      await expect(window.locator('[data-node-kind="agent"]')).toHaveCount(35);
      await expect(window.locator('.map-edge--base')).toHaveCount(35);
      const actualScale = await window.evaluate(() => window.devicePixelRatio);
      expect(actualScale).toBeCloseTo(variant.scale, 1);
      await startLongTaskObserver(window);

      await window.getByRole('button', { name: 'Fit' }).click();
      const projectedOverlaps = await window.locator('[data-node-kind="agent"]').evaluateAll((nodes) => {
        const rectangles = nodes.map((node) => ({ id: node.getAttribute('data-agent-id'), rect: node.getBoundingClientRect() }));
        return rectangles.flatMap((left, index) => rectangles.slice(index + 1).flatMap((right) => {
          const intersects = left.rect.left < right.rect.right && left.rect.right > right.rect.left
            && left.rect.top < right.rect.bottom && left.rect.bottom > right.rect.top;
          return intersects ? [`${left.id}:${right.id}`] : [];
        }));
      });
      expect(projectedOverlaps).toEqual([]);
      const orchestratorBefore = await window.locator('[data-agent-id="orchestrator"]').boundingBox();
      const dragPoint = await window.evaluate(() => {
        for (let y = 150; y < innerHeight - 150; y += 30) {
          for (let x = 310; x < innerWidth - 310; x += 30) {
            const element = document.elementFromPoint(x, y);
            if (element?.classList.contains('map-world') || element?.classList.contains('map-viewport')) return { x, y };
          }
        }
        throw new Error('No unobstructed map drag point was found');
      });
      await window.mouse.move(dragPoint.x, dragPoint.y);
      await window.mouse.down();
      await window.mouse.move(dragPoint.x + 70, dragPoint.y + 45, { steps: 5 });
      await window.mouse.up();
      const orchestratorAfter = await window.locator('[data-agent-id="orchestrator"]').boundingBox();
      expect(orchestratorAfter?.x).toBeGreaterThan((orchestratorBefore?.x ?? 0) + 45);

      for (let index = 0; index < 5; index += 1) await window.getByRole('button', { name: 'Zoom in' }).click();
      for (let index = 0; index < 5; index += 1) await window.getByRole('button', { name: 'Zoom out' }).click();
      await window.getByRole('button', { name: 'Fit' }).click();
      await window.locator('[data-agent-id="agent-15"]').click();
      await expect(window.locator('aside[aria-label$="detail"]')).toBeVisible();
      await window.keyboard.press('Escape');
      await expect(window.locator('aside[aria-label$="detail"]')).toHaveCount(0);
      await window.getByRole('button', { name: 'Fit' }).click();

      await window.screenshot({ path: path.join(captureRoot, `electron-map-${variant.label}.png`), animations: 'disabled' });
      await expect(window).toHaveScreenshot(`map-stability-${variant.label}.png`, { animations: 'disabled', maxDiffPixelRatio: 0.003 });
      const longTasks = await window.evaluate(() => (globalThis as typeof globalThis & { __orquestaLongTasks?: number[] }).__orquestaLongTasks ?? []);
      expect(longTasks.filter((duration) => duration >= 500)).toEqual([]);
      results.push({
        label: variant.label,
        width: variant.width,
        height: variant.height,
        requestedScale: variant.scale,
        actualScale,
        agentCount: 35,
        overlapCount: projectedOverlaps.length,
        maxLongTaskMs: Math.max(0, ...longTasks)
      });
    } finally {
      await desktop.close();
    }
  }

  await writeFile(path.join(appRoot, 'artifacts', 'map-stability-metrics.json'), `${JSON.stringify({ measuredAt: new Date().toISOString(), results }, null, 2)}\n`, 'utf8');
});
