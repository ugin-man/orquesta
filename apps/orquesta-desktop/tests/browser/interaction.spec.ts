import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { openFixture } from './helpers';

async function openProjectSwitcher(page: Page) {
  const launcher = page.getByLabel('Project launcher');
  await launcher.getByRole('button', { name: 'Project actions' }).click();
  await launcher.getByRole('button', { name: 'Switch project' }).click();
}

async function openSettingsSection(page: Page, section: 'Startup & project' | 'Status & diagnostics') {
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: section }).click();
}

async function openOperations(page: Page) {
  await openSettingsSection(page, 'Status & diagnostics');
  await page.getByRole('button', { name: 'Open Operations' }).click();
}

test('renders the full active roster and opens agent and task details', async ({ page }) => {
  await openFixture(page, 'active-project');
  await expect(page.locator('[data-node-kind="agent"]')).toHaveCount(7);
  await page.getByRole('button', { name: 'Analyst, Working' }).click();
  await expect(page.locator('aside[aria-label="Analyst detail"]')).toBeVisible();
  await page.locator('.agent-current-task').click();
  const detail = page.getByRole('dialog', { name: 'Task T68 detail' });
  await expect(detail).toBeVisible();
  await expect(detail.getByText('Dispatch accepted', { exact: true })).toBeVisible();
  await expect(detail.getByText('Turn started', { exact: true })).toBeVisible();
});

test('keeps dispatch-only work static and actual model unknown', async ({ page }) => {
  await openFixture(page, 'unknown-evidence');
  await expect(page.locator('.map-edge-flow')).toHaveCount(0);
  await page.getByRole('button', { name: 'Planner, Assigned · waiting' }).click();
  await page.locator('.agent-current-task').click();
  const detail = page.getByRole('dialog', { name: 'Task U12 detail' });
  await expect(detail).toBeVisible();
  await expect(detail.getByRole('heading', { name: 'Model routing' })).toBeVisible();
  await expect(detail.getByText('Actual', { exact: true })).toBeVisible();
  await expect(detail.getByText('— · unknown', { exact: true })).toBeVisible();
});

test('switches to offline project without claiming live work', async ({ page }) => {
  await openFixture(page, 'active-project');
  await openProjectSwitcher(page);
  await expect(page.getByRole('dialog', { name: 'Switch project' })).toBeVisible();
  await page.getByRole('button', { name: /Disconnected Repository/ }).click();
  await expect(page.locator('.stale-ribbon')).toBeVisible();
  await expect(page.getByText('No proven active work')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
  await expect(page.locator('.map-edge-flow')).toHaveCount(0);
});

test('keeps Home fixed and Attention ready for panel-local scrolling', async ({ page }) => {
  await openFixture(page, 'attention-heavy', { width: 1366, height: 768 });
  const fixed = await page.evaluate(() => ({
    html: document.documentElement.scrollHeight === document.documentElement.clientHeight,
    body: document.body.scrollHeight === document.body.clientHeight
  }));
  expect(fixed).toEqual({ html: true, body: true });
  const attention = page.getByTestId('attention-scroll');
  const overflowY = await attention.evaluate((element) => getComputedStyle(element).overflowY);
  expect(overflowY).toBe('auto');
});

test('large roster keeps all thirty-five agents as individual nodes', async ({ page }) => {
  await openFixture(page, 'large-roster');
  await expect(page.locator('[data-node-kind="agent"]')).toHaveCount(35);
  await page.getByRole('button', { name: 'Fit' }).click();
  const occluded = await page.locator('[data-node-kind="agent"]').evaluateAll((nodes) => nodes.flatMap((node) => {
    const rect = node.getBoundingClientRect();
    const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return target && node.contains(target) ? [] : [node.getAttribute('data-agent-id')];
  }));
  expect(occluded).toEqual([]);
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await page.getByRole('button', { name: 'Reset' }).click();
});

for (const [fixture, count] of [['nested-roster', 18], ['wide-roster', 80]] as const) {
  test(`${fixture} keeps every agent in the DOM without document scroll`, async ({ page }) => {
    await openFixture(page, fixture, { width: 1440, height: 900 });
    await expect(page.locator('[data-node-kind="agent"]')).toHaveCount(count);
    expect(await page.locator('.map-edge--base').count()).toBeGreaterThanOrEqual(count);
    const overlaps = await page.locator('[data-node-kind="agent"]').evaluateAll((nodes) => {
      const rectangles = nodes.map((node) => ({ id: node.getAttribute('data-agent-id'), rect: node.getBoundingClientRect() }));
      return rectangles.flatMap((left, index) => rectangles.slice(index + 1).flatMap((right) => {
        const intersects = left.rect.left < right.rect.right && left.rect.right > right.rect.left
          && left.rect.top < right.rect.bottom && left.rect.bottom > right.rect.top;
        return intersects ? [`${left.id}:${right.id}`] : [];
      }));
    });
    expect(overlaps).toEqual([]);
    const occluded = await page.locator('[data-node-kind="agent"]').evaluateAll((nodes) => nodes.flatMap((node) => {
      const rect = node.getBoundingClientRect();
      const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return target && node.contains(target) ? [] : [node.getAttribute('data-agent-id')];
    }));
    expect(occluded).toEqual([]);
    const pageScroll = await page.evaluate(() => ({
      html: document.documentElement.scrollHeight - document.documentElement.clientHeight,
      body: document.body.scrollHeight - document.body.clientHeight
    }));
    expect(pageScroll).toEqual({ html: 0, body: 0 });
  });
}

test('preserves the map camera when a same-project snapshot updates', async ({ page }) => {
  await openFixture(page, 'active-project');
  const world = page.locator('.map-world');
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await page.getByRole('button', { name: 'Zoom in' }).click();
  const zoomBefore = await world.getAttribute('data-zoom');
  await openProjectSwitcher(page);
  await page.getByRole('dialog', { name: 'Switch project' })
    .getByRole('button', { name: /Local Multi-Agent Orchestration/ })
    .click();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(world).toHaveAttribute('data-zoom', zoomBefore ?? '');
});

test('persists a manually moved agent and Reset restores the organization layout', async ({ page }) => {
  await openFixture(page, 'active-project', { width: 1440, height: 900 });
  await page.evaluate(() => window.localStorage.removeItem('orquesta.desktop.map-layout.active-project'));
  await page.reload();
  const coder = page.locator('[data-agent-id="coder"]');
  await expect(coder).toBeVisible();
  const initial = await coder.boundingBox();
  if (!initial) throw new Error('Coder node did not expose a bounding box');

  await page.mouse.move(initial.x + initial.width / 2, initial.y + initial.height / 2);
  await page.mouse.down();
  await page.mouse.move(initial.x + initial.width / 2 + 72, initial.y + initial.height / 2 - 36, { steps: 5 });
  await page.mouse.up();
  const moved = await coder.boundingBox();
  expect(moved?.x).toBeGreaterThan(initial.x + 45);
  const savedOffset = await page.evaluate(() => JSON.parse(window.localStorage.getItem('orquesta.desktop.map-layout.active-project') ?? '{}').coder?.x ?? 0);
  expect(savedOffset).toBeGreaterThan(45);

  await page.reload();
  await expect(page.locator('[data-agent-id="coder"]')).toBeVisible();
  const restoredOffset = await page.evaluate(() => JSON.parse(window.localStorage.getItem('orquesta.desktop.map-layout.active-project') ?? '{}').coder?.x ?? 0);
  expect(restoredOffset).toBeCloseTo(savedOffset, 3);

  await page.getByRole('button', { name: 'Reset' }).click();
  expect(await page.evaluate(() => window.localStorage.getItem('orquesta.desktop.map-layout.active-project'))).toBeNull();
  const reset = await page.locator('[data-agent-id="coder"]').boundingBox();
  expect(Math.abs((reset?.x ?? 0) - initial.x)).toBeLessThan(6);
});

test('closes Project Route with Escape and reaches Conversation and Operations', async ({ page }) => {
  await openFixture(page, 'active-project');
  await openSettingsSection(page, 'Startup & project');
  await page.getByRole('button', { name: 'Open Project Route' }).click();
  await expect(page.getByRole('dialog', { name: 'Project Route' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Project Route' })).toHaveCount(0);
  await page.getByRole('button', { name: /Conversation history/ }).click();
  await expect(page.getByRole('heading', { name: 'Conversation · Orchestrator' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Records' })).toHaveAttribute('aria-current', 'page');
  await openOperations(page);
  await expect(page.getByRole('dialog', { name: 'Operations' })).toBeVisible();
});

for (const viewport of [{ width: 1366, height: 768 }, { width: 1440, height: 900 }]) {
  test(`keeps V4 Operations bounded and keyboard-accessible at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await openFixture(page, 'active-project', viewport);
    await openOperations(page);
    const dialog = page.getByRole('dialog', { name: 'Operations' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('tab')).toHaveCount(4);

    const bounds = await page.evaluate(() => {
      const overlay = document.querySelector<HTMLElement>('.operations-overlay');
      const panel = document.querySelector<HTMLElement>('.operations-panel__scroll');
      if (!overlay || !panel) throw new Error('Operations layout missing');
      const box = overlay.getBoundingClientRect();
      return {
        bodyOverflow: getComputedStyle(document.body).overflow,
        panelOverflow: getComputedStyle(panel).overflowY,
        box: { left: box.left, right: box.right, top: box.top, bottom: box.bottom },
        viewport: { width: window.innerWidth, height: window.innerHeight },
      };
    });
    expect(bounds.bodyOverflow).toBe('hidden');
    expect(bounds.panelOverflow).toBe('auto');
    expect(bounds.box.left).toBeGreaterThanOrEqual(0);
    expect(bounds.box.top).toBeGreaterThanOrEqual(0);
    expect(bounds.box.right).toBeLessThanOrEqual(bounds.viewport.width);
    expect(bounds.box.bottom).toBeLessThanOrEqual(bounds.viewport.height);

    const capability = dialog.getByRole('tab', { name: 'Capability' });
    await capability.focus();
    await page.keyboard.press('ArrowRight');
    await expect(dialog.getByRole('tab', { name: 'Acquisition' })).toBeFocused();
    await page.keyboard.press('End');
    await expect(dialog.getByRole('tab', { name: 'Evidence' })).toBeFocused();
    await expect(dialog.locator('.operations-runtime-card').getByText('unavailable')).toBeVisible();
    for (const tabName of ['Capability', 'Acquisition', 'Audit', 'Evidence']) {
      await dialog.getByRole('tab', { name: tabName }).click();
      const overflow = await dialog.getByRole('tabpanel').evaluate((panel) => ({
        horizontal: panel.scrollWidth - panel.clientWidth,
        document: document.documentElement.scrollHeight - document.documentElement.clientHeight,
      }));
      expect(overflow.horizontal).toBeLessThanOrEqual(0);
      expect(overflow.document).toBe(0);
    }
  });
}


test('keeps map controls clear of the user node and team action clear of the composer', async ({ page }) => {
  await openFixture(page, 'active-project');
  const boxes = await page.evaluate(() => {
    const rect = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`Missing ${selector}`);
      const box = element.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
    };
    return {
      controls: rect('.map-controls'),
      user: rect('.map-user-node'),
      team: rect('.add-agent-button'),
      composer: rect('.command-composer')
    };
  });
  const overlaps = (a: typeof boxes.controls, b: typeof boxes.controls) =>
    a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  expect(overlaps(boxes.controls, boxes.user)).toBe(false);
  expect(overlaps(boxes.team, boxes.composer)).toBe(false);
});


test('keeps large-roster map controls clear of the user node', async ({ page }) => {
  await openFixture(page, 'large-roster');
  const [controls, user] = await Promise.all([
    page.locator('.map-controls').boundingBox(),
    page.locator('.map-user-node').boundingBox()
  ]);
  expect(controls).not.toBeNull();
  expect(user).not.toBeNull();
  const overlaps = Boolean(
    controls && user &&
    controls.x < user.x + user.width && controls.x + controls.width > user.x &&
    controls.y < user.y + user.height && controls.y + controls.height > user.y
  );
  expect(overlaps).toBe(false);
});

test('has no serious accessibility violations or browser errors in the standard fixture', async ({ page }) => {
  const browserErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  page.on('pageerror', (error) => browserErrors.push(error.message));

  await openFixture(page, 'active-project');
  const results = await new AxeBuilder({ page }).disableRules(['region']).analyze();
  expect(results.violations.filter((item) => ['serious', 'critical'].includes(item.impact ?? ''))).toEqual([]);
  expect(browserErrors).toEqual([]);
});

test('has no serious accessibility violations in every V4 Operations panel', async ({ page }) => {
  await openFixture(page, 'active-project');
  await openOperations(page);
  const dialog = page.getByRole('dialog', { name: 'Operations' });
  for (const tabName of ['Capability', 'Acquisition', 'Audit', 'Evidence']) {
    await dialog.getByRole('tab', { name: tabName }).click();
    const results = await new AxeBuilder({ page }).include('.operations-overlay').disableRules(['region']).analyze();
    expect(results.violations.filter((item) => ['serious', 'critical'].includes(item.impact ?? ''))).toEqual([]);
  }
});
