import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { openFixture } from './helpers';

test('renders the full active roster and opens agent and task details', async ({ page }) => {
  await openFixture(page, 'active-project');
  await expect(page.locator('[data-node-kind="agent"]')).toHaveCount(7);
  await page.getByRole('button', { name: 'Analyst, Working' }).click();
  await expect(page.locator('aside[aria-label="Analyst detail"]')).toBeVisible();
  await page.locator('.agent-current-task').click();
  const detail = page.locator('aside[aria-label="Task T68"]');
  await expect(detail).toBeVisible();
  await expect(detail.getByText('Dispatch accepted', { exact: true })).toBeVisible();
  await expect(detail.getByText('Turn started', { exact: true })).toBeVisible();
});

test('keeps dispatch-only work static and actual model unknown', async ({ page }) => {
  await openFixture(page, 'unknown-evidence');
  await expect(page.locator('.map-edge-flow')).toHaveCount(0);
  await page.getByRole('button', { name: 'Planner, Assigned · waiting' }).click();
  await page.locator('.agent-current-task').click();
  const detail = page.locator('aside[aria-label="Task U12"]');
  await expect(detail).toBeVisible();
  await expect(detail.getByText('Actual model', { exact: true })).toBeVisible();
  await expect(detail.getByText('Unknown', { exact: true }).first()).toBeVisible();
  await expect(detail.getByText('Not observed', { exact: true })).toHaveCount(2);
});

test('switches to offline project without claiming live work', async ({ page }) => {
  await openFixture(page, 'active-project');
  await page.locator('.project-status__summary').click();
  await page.getByRole('button', { name: 'Switch project' }).click();
  await expect(page.getByRole('dialog', { name: 'Switch project' })).toBeVisible();
  await page.getByRole('button', { name: /Disconnected Repository/ }).click();
  await expect(page.locator('.stale-ribbon')).toBeVisible();
  await expect(page.getByText('No proven active work')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
  await expect(page.locator('.map-edge-flow')).toHaveCount(0);
});

test('keeps Home fixed while Attention scrolls internally', async ({ page }) => {
  await openFixture(page, 'attention-heavy', { width: 1366, height: 768 });
  const fixed = await page.evaluate(() => ({
    html: document.documentElement.scrollHeight === document.documentElement.clientHeight,
    body: document.body.scrollHeight === document.body.clientHeight
  }));
  expect(fixed).toEqual({ html: true, body: true });
  const attention = page.getByTestId('attention-scroll');
  const metrics = await attention.evaluate((element) => ({ scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }));
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
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
  await page.locator('.project-status__summary').click();
  await page.getByRole('button', { name: 'Switch project' }).click();
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

test('opens route, conversation, operations, and returns with Escape', async ({ page }) => {
  await openFixture(page, 'active-project');
  await page.locator('.project-status__summary').click();
  await page.getByRole('button', { name: 'Open Project Route' }).click();
  await expect(page.getByRole('dialog', { name: 'Project Route' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Project Route' })).toHaveCount(0);
  await page.getByRole('button', { name: /Conversation history/ }).click();
  await expect(page.getByRole('dialog', { name: /Conversation · Orchestrator/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.locator('.project-status__summary').click();
  await page.getByRole('button', { name: 'Open operations' }).click();
  await expect(page.getByRole('dialog', { name: 'Advanced Operations' })).toBeVisible();
});


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
