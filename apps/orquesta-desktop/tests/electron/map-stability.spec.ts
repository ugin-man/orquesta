import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
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

async function launchVariant(variant: typeof variants[number]): Promise<{ desktop: ElectronApplication; window: Page; userData: string }> {
  const userData = await mkdtemp(path.join(os.tmpdir(), 'orquesta-electron-map-user-'));
  try {
    const desktop = await electron.launch({
      args: [
        `--user-data-dir=${userData}`,
        '--force-prefers-reduced-motion=reduce',
        '--lang=en-US',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        '.'
      ],
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
    return { desktop, window, userData };
  } catch (error) {
    await rm(userData, { recursive: true, force: true });
    throw error;
  }
}

async function startLongTaskObserver(window: Page) {
  await window.evaluate(async () => {
    const scope = globalThis as typeof globalThis & {
      __orquestaFrameDeltas?: number[];
      __orquestaFrameObserverActive?: boolean;
      __orquestaLongTasks?: number[];
      __orquestaLongTaskObserver?: PerformanceObserver;
    };
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    scope.__orquestaLongTasks = [];
    scope.__orquestaFrameDeltas = [];
    scope.__orquestaFrameObserverActive = true;
    let previous = performance.now();
    const sampleFrame = (now: number) => {
      scope.__orquestaFrameDeltas?.push(now - previous);
      previous = now;
      if (scope.__orquestaFrameObserverActive) requestAnimationFrame(sampleFrame);
    };
    requestAnimationFrame(sampleFrame);
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
    const { desktop, window, userData } = await launchVariant(variant);
    try {
      await expect(window.locator('[data-node-kind="agent"]')).toHaveCount(35);
      expect(await window.locator('.map-edge--base').count()).toBeGreaterThanOrEqual(35);
      const actualScale = await window.evaluate(() => window.devicePixelRatio);
      expect(actualScale).toBeCloseTo(variant.scale, 1);

      await window.getByRole('button', { name: 'Fit' }).click();
      const overflowingGlyphs = await window.locator('.agent-node__icon').evaluateAll((icons) => icons.flatMap((icon) => {
        const frame = icon.getBoundingClientRect();
        const svg = icon.querySelector('svg')?.getBoundingClientRect();
        return svg && (svg.width > frame.width + 0.5 || svg.height > frame.height + 0.5)
          ? [icon.closest('[data-agent-id]')?.getAttribute('data-agent-id') ?? 'user']
          : [];
      }));
      expect(overflowingGlyphs).toEqual([]);
      const documentBounds = await window.evaluate(() => ({
        bodyWidth: document.body.scrollWidth - document.body.clientWidth,
        bodyHeight: document.body.scrollHeight - document.body.clientHeight,
        documentWidth: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        documentHeight: document.documentElement.scrollHeight - document.documentElement.clientHeight
      }));
      expect(documentBounds).toEqual({ bodyWidth: 0, bodyHeight: 0, documentWidth: 0, documentHeight: 0 });
      for (const locator of [window.locator('.map-user-node strong'), window.locator('[data-agent-id="orchestrator"] strong')]) {
        await expect(locator).toBeVisible();
        const label = await locator.evaluate((element) => ({
          fontSize: Number.parseFloat(getComputedStyle(element).fontSize),
          opacity: Number.parseFloat(getComputedStyle(element).opacity),
          text: element.textContent?.trim() ?? ''
        }));
        expect(label.text.length).toBeGreaterThan(0);
        expect(label.fontSize).toBeGreaterThanOrEqual(5);
        expect(label.opacity).toBe(1);
      }
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
      await startLongTaskObserver(window);
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

      const zoomBeforeWheel = Number(await window.locator('.map-world').getAttribute('data-zoom'));
      await window.mouse.move(dragPoint.x, dragPoint.y);
      await window.mouse.wheel(0, -480);
      await expect.poll(async () => Number(await window.locator('.map-world').getAttribute('data-zoom'))).toBeGreaterThan(zoomBeforeWheel);
      await window.mouse.wheel(0, 480);
      await window.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const performanceSamples = await window.evaluate(() => {
        const scope = globalThis as typeof globalThis & {
          __orquestaFrameDeltas?: number[];
          __orquestaFrameObserverActive?: boolean;
          __orquestaLongTasks?: number[];
        };
        scope.__orquestaFrameObserverActive = false;
        return { frameDeltas: scope.__orquestaFrameDeltas ?? [], longTasks: scope.__orquestaLongTasks ?? [] };
      });
      const longTasks = performanceSamples.longTasks;
      expect(longTasks.filter((duration) => duration >= 500)).toEqual([]);
      expect(performanceSamples.frameDeltas.filter((duration) => duration >= 500)).toEqual([]);

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
      await rm(userData, { recursive: true, force: true });
    }
  }

  await writeFile(path.join(appRoot, 'artifacts', 'map-stability-metrics.json'), `${JSON.stringify({ measuredAt: new Date().toISOString(), results }, null, 2)}\n`, 'utf8');
});
