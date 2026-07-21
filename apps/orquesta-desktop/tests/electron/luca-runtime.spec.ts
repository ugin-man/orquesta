import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type TestInfo } from '@playwright/test';
import { _electron as electron, type Page } from 'playwright';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fakeAppServer = path.join(appRoot, 'tests', 'electron', 'fixtures', 'fake-codex-app-server.cjs');

type RuntimeLogEntry = { method: string; params: Record<string, unknown> };

async function readRuntimeLog(filename: string): Promise<RuntimeLogEntry[]> {
  const source = await readFile(filename, 'utf8').catch(() => '');
  return source.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as RuntimeLogEntry);
}

async function writeLucaProject(root: string): Promise<{ tasksPath: string }> {
  const now = new Date().toISOString();
  const state = path.join(root, '.orquesta', 'state');
  const failures = path.join(root, '.orquesta', 'failures');
  const reports = path.join(root, '.orquesta', 'reports', 'inspections');
  await Promise.all([mkdir(state, { recursive: true }), mkdir(failures, { recursive: true }), mkdir(reports, { recursive: true })]);
  const tasksPath = path.join(state, 'tasks.json');
  const reportPath = path.join(reports, 'BENCH-LUCA.md');
  await Promise.all([
    writeFile(path.join(state, 'agents.json'), `${JSON.stringify({
      updated_at: now,
      agents: [
        { agent_id: 'orchestrator', role: 'orchestrator', display_name: 'Coordinator', status: 'active', mission: 'Coordinate Luca verification.' },
        { agent_id: 'orquesta-admin', role: 'orquesta-admin', display_name: '管理係', status: 'standby', mission: 'Legacy Luca identity.' },
        { agent_id: 'builder', role: 'implementation', display_name: 'Builder', status: 'active', current_task: 'LIVE-LUCA', mission: 'Build Luca.' }
      ]
    }, null, 2)}\n`, 'utf8'),
    writeFile(tasksPath, `${JSON.stringify({
      updated_at: now,
      tasks: [{
        task_id: 'LIVE-LUCA', title: 'Verify Luca desktop flow', state: 'in_progress', owner_agent_id: 'builder', assigned_by_agent_id: 'orchestrator',
        progress_observed: true, progress_summary: 'Checking the read-only explanation path.', updated_at: now,
        acceptance_checks: ['Luca explains records without changing task state.']
      }]
    }, null, 2)}\n`, 'utf8'),
    writeFile(path.join(failures, 'incidents.json'), `${JSON.stringify({ incidents: [{
      incident_id: 'F-LUCA', status: 'open', severity: 'high', failure_class: 'luca.fixture', title: 'Luca fixture error',
      summary: 'A saved fixture error for explanation.', source_agent_id: 'builder', task_id: 'LIVE-LUCA', detected_at: now,
      suspected_cause: 'Fixture cause.', current_action: 'Explain only.', evidence: ['fixture evidence'], user_action_required: false
    }] }, null, 2)}\n`, 'utf8'),
    writeFile(path.join(state, 'inspection-runs.json'), `${JSON.stringify({ version: 1, runs: [{
      runId: 'BENCH-LUCA', kind: 'external_benchmark', requestedBy: 'user', target: { kind: 'project', ids: [] }, focus: 'Luca fixture',
      status: 'report_ready', threadId: 'thread-inspection-existing', turnId: 'turn-inspection-existing', reportPath, sourceCount: 1,
      errorCode: null, errorMessage: null, runtimeBoundary: { sandbox: 'read-only', approvalPolicy: 'never', webSearchMode: 'live' },
      createdAt: now, startedAt: now, completedAt: now, closedAt: null
    }] }, null, 2)}\n`, 'utf8'),
    writeFile(reportPath, '## Finding\n\nThe saved inspection confirms that Luca remains read-only.\n', 'utf8')
  ]);
  return { tasksPath };
}

function overlaps(left: NonNullable<Awaited<ReturnType<Locator['boundingBox']>>>, right: NonNullable<Awaited<ReturnType<Locator['boundingBox']>>>): boolean {
  return left.x < right.x + right.width && left.x + left.width > right.x
    && left.y < right.y + right.height && left.y + left.height > right.y;
}

async function captureNoOverlap(page: Page, testInfo: TestInfo, label: string, primary: Locator, avoid: Locator[]): Promise<void> {
  const session = await page.context().newCDPSession(page);
  for (const viewport of [{ width: 1366, height: 768 }, { width: 1440, height: 900 }]) {
    await session.send('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1, mobile: false });
    const primaryBox = await primary.boundingBox();
    expect(primaryBox, `${label} primary bounds at ${viewport.width}x${viewport.height}`).not.toBeNull();
    for (const target of avoid) {
      const targetBox = await target.boundingBox();
      if (targetBox) expect(overlaps(primaryBox!, targetBox), `${label} overlaps ${await target.getAttribute('class')} at ${viewport.width}x${viewport.height}`).toBe(false);
    }
    await page.screenshot({ path: testInfo.outputPath(`${label}-${viewport.width}x${viewport.height}.png`), fullPage: false });
  }
  await session.detach();
}

test('runs Luca in a dedicated Luna thread, preserves canonical state, and keeps all entry layouts separate', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'orquesta-electron-luca-'));
  const userData = await mkdtemp(path.join(os.tmpdir(), 'orquesta-electron-luca-user-'));
  const logPath = path.join(root, 'fake-codex-log.jsonl');
  const { tasksPath } = await writeLucaProject(root);
  const tasksBefore = await readFile(tasksPath, 'utf8');
  const desktop = await electron.launch({
    args: [`--user-data-dir=${userData}`, '--lang=en-US', '--force-prefers-reduced-motion=reduce', '.'],
    cwd: appRoot,
    env: { ...process.env, ORQUESTA_E2E: '1', ORQUESTA_E2E_PROJECT_ROOT: root, ORQUESTA_E2E_CODEX_SCRIPT: fakeAppServer, ORQUESTA_E2E_CODEX_LOG: logPath }
  });

  try {
    const window = await desktop.firstWindow();
    await expect(window.getByLabel('Orquesta Map')).toBeVisible();
    await window.getByRole('button', { name: 'Ask Luca' }).click();
    await expect(window.getByRole('complementary', { name: 'Luca' })).toBeVisible();
    await captureNoOverlap(window, testInfo, 'luca-home', window.getByRole('complementary', { name: 'Luca' }), [window.locator('.project-launcher'), window.locator('.home-right-rail'), window.locator('.command-composer')]);
    await window.getByRole('button', { name: 'What is happening now?' }).click();
    await expect(window.getByRole('complementary', { name: 'Luca' })).toContainText('Luca explained What is happening now?');
    await window.getByRole('button', { name: 'Ask another question' }).click();
    await window.getByRole('button', { name: 'What important errors happened recently?' }).click();
    await expect(window.getByRole('complementary', { name: 'Luca' })).toContainText('Luca explained What important errors happened recently?');

    await expect.poll(async () => (await readRuntimeLog(logPath)).filter((entry) => entry.method === 'turn/start').length).toBe(2);
    const log = await readRuntimeLog(logPath);
    const lucaThreadStart = log.find((entry) => entry.method === 'thread/start' && entry.params.model === 'gpt-5.6-luna');
    expect(lucaThreadStart?.params).toMatchObject({ model: 'gpt-5.6-luna', sandbox: 'read-only', approvalPolicy: 'never' });
    expect(String(lucaThreadStart?.params.developerInstructions)).toContain('Never mutate tasks');
    expect(log.filter((entry) => entry.method === 'turn/start').at(-1)?.params).toMatchObject({ effort: 'high' });
    expect(log.filter((entry) => entry.method === 'thread/resume')).toHaveLength(1);
    expect(await readFile(tasksPath, 'utf8')).toBe(tasksBefore);

    await window.getByRole('button', { name: 'Close Luca' }).click();
    await window.getByRole('button', { name: 'Records' }).click();
    await window.getByRole('button', { name: /LIVE-LUCA · Verify Luca desktop flow/u }).click();
    await window.getByRole('button', { name: 'Ask Luca about this task' }).click();
    await captureNoOverlap(window, testInfo, 'luca-task', window.getByRole('complementary', { name: 'Luca' }), [window.locator('.task-record-detail'), window.locator('.command-composer')]);
    await window.getByRole('button', { name: 'Explain this task simply' }).click();
    await expect(window.getByRole('complementary', { name: 'Luca' })).toContainText('Luca explained Explain this task simply');
    await window.getByRole('button', { name: 'Close Luca' }).click();
    await window.getByRole('button', { name: 'Close task detail' }).click();

    await window.getByRole('button', { name: 'Errors' }).click();
    await window.getByRole('button', { name: /luca\.fixture/u }).click();
    await window.getByRole('button', { name: 'Ask Luca about this error' }).click();
    await captureNoOverlap(window, testInfo, 'luca-failure', window.getByRole('complementary', { name: 'Luca' }), [window.locator('.failure-record-detail'), window.locator('.command-composer')]);
    await window.getByRole('button', { name: 'Explain this error simply' }).click();
    await expect(window.getByRole('complementary', { name: 'Luca' })).toContainText('Luca explained Explain this error simply');
    await window.getByRole('button', { name: 'Close Luca' }).click();
    await window.getByRole('button', { name: 'Close error detail' }).click();

    await window.getByRole('button', { name: 'Inspections' }).click();
    await window.getByRole('button', { name: /BENCH-LUCA/u }).click();
    await expect(window.getByRole('heading', { name: 'Finding' })).toBeVisible();
    await window.getByRole('button', { name: 'Ask Luca about this inspection' }).click();
    await captureNoOverlap(window, testInfo, 'luca-inspection', window.getByRole('complementary', { name: 'Luca' }), [window.locator('.inspection-record-detail'), window.locator('.command-composer')]);
    await window.getByRole('button', { name: 'Explain this result simply' }).click();
    await expect(window.getByRole('complementary', { name: 'Luca' })).toContainText('Luca explained Explain this result simply');
    await window.getByRole('button', { name: 'Close Luca' }).click();

    await window.getByRole('button', { name: 'Conversation', exact: true }).click();
    await window.getByRole('button', { name: 'Luca · Project explainer' }).click();
    await expect(window.getByRole('heading', { name: 'Conversation · Luca' })).toBeVisible();
    await expect(window.getByText('Luca explained Explain this result simply.')).toBeVisible();
    expect(await readFile(tasksPath, 'utf8')).toBe(tasksBefore);
  } finally {
    await desktop.close();
    await Promise.all([rm(root, { recursive: true, force: true }), rm(userData, { recursive: true, force: true })]);
  }
});
