import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fakeAppServer = path.join(appRoot, 'tests', 'electron', 'fixtures', 'fake-codex-app-server.cjs');

interface InspectionState {
  runs: Array<{
    runId: string;
    kind: 'external_benchmark' | 'adversarial_audit';
    status: string;
    threadId: string | null;
    turnId: string | null;
    reportPath: string | null;
  }>;
}

async function readInspectionState(filename: string): Promise<InspectionState> {
  const source = await readFile(filename, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '{"runs":[]}';
    throw error;
  });
  return JSON.parse(source) as InspectionState;
}

async function readRuntimeLog(filename: string): Promise<Array<{ method: string; params: Record<string, unknown> }>> {
  const source = await readFile(filename, 'utf8').catch(() => '');
  return source.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
}

test('runs, records, and cancels read-only inspection agents without changing canonical organization state', async () => {
  test.setTimeout(90_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'orquesta-electron-inspection-'));
  const userData = await mkdtemp(path.join(os.tmpdir(), 'orquesta-electron-inspection-user-'));
  const stateDirectory = path.join(root, '.orquesta', 'state');
  const logPath = path.join(root, 'fake-codex-log.jsonl');
  const agentsPath = path.join(stateDirectory, 'agents.json');
  const tasksPath = path.join(stateDirectory, 'tasks.json');
  const inspectionsPath = path.join(stateDirectory, 'inspection-runs.json');
  await mkdir(stateDirectory, { recursive: true });
  await writeFile(agentsPath, `${JSON.stringify({
    updated_at: new Date().toISOString(),
    agents: [{ agent_id: 'orchestrator', role: 'orchestrator', display_name: 'Coordinator', status: 'standby', mission: 'Coordinate this project.' }]
  }, null, 2)}\n`, 'utf8');
  await writeFile(tasksPath, `${JSON.stringify({ updated_at: new Date().toISOString(), tasks: [] }, null, 2)}\n`, 'utf8');
  const canonicalAgentsBefore = await readFile(agentsPath, 'utf8');
  const canonicalTasksBefore = await readFile(tasksPath, 'utf8');

  const desktop = await electron.launch({
    args: [`--user-data-dir=${userData}`, '--lang=en-US', '.'],
    cwd: appRoot,
    env: {
      ...process.env,
      ORQUESTA_E2E: '1',
      ORQUESTA_E2E_PROJECT_ROOT: root,
      ORQUESTA_E2E_CODEX_SCRIPT: fakeAppServer,
      ORQUESTA_E2E_CODEX_LOG: logPath
    }
  });

  try {
    const window = await desktop.firstWindow();
    await expect(window.getByLabel('Orquesta Map')).toBeVisible();
    await window.getByRole('button', { name: 'Team Management' }).click();

    await window.getByRole('textbox', { name: 'Optional focus' }).fill('Desktop orchestration competitors');
    await window.getByRole('button', { name: 'Start external benchmark' }).click();
    await expect.poll(async () => (await readInspectionState(inspectionsPath)).runs.find((run) => run.kind === 'external_benchmark')?.status).toBe('report_ready');
    const external = (await readInspectionState(inspectionsPath)).runs.find((run) => run.kind === 'external_benchmark')!;
    expect(external.reportPath).not.toBeNull();
    expect(await readFile(external.reportPath!, 'utf8')).toContain('https://example.test/competitor');

    await window.getByRole('button', { name: 'Start adversarial audit' }).click();
    await expect.poll(async () => (await readInspectionState(inspectionsPath)).runs.find((run) => run.kind === 'adversarial_audit')?.status).toBe('report_ready');

    await window.getByRole('textbox', { name: 'Optional focus' }).fill('HOLD_FOR_CANCEL');
    await window.getByRole('button', { name: 'Start external benchmark' }).click();
    await expect(window.locator('[data-inspection-kind="external_benchmark"]')).toHaveCount(2);
    await expect(window.getByRole('button', { name: /External benchmark, Running/u })).toBeVisible();
    const runningState = await readInspectionState(inspectionsPath);
    const running = runningState.runs.find((run) => run.kind === 'external_benchmark' && run.status === 'running')!;
    await window.getByRole('button', { name: 'Cancel external benchmark' }).click();
    await expect.poll(async () => (await readInspectionState(inspectionsPath)).runs.find((run) => run.runId === running.runId)?.status).toBe('cancelled');

    const log = await readRuntimeLog(logPath);
    const threadStarts = log.filter((entry) => entry.method === 'thread/start');
    expect(threadStarts[0].params).toMatchObject({ sandbox: 'read-only', approvalPolicy: 'never', webSearchMode: 'live' });
    expect(threadStarts[1].params).toMatchObject({ sandbox: 'read-only', approvalPolicy: 'never', webSearchMode: 'disabled' });
    const interrupt = log.find((entry) => entry.method === 'turn/interrupt');
    expect(interrupt?.params).toMatchObject({ threadId: running.threadId, turnId: running.turnId });

    expect(await readFile(agentsPath, 'utf8')).toBe(canonicalAgentsBefore);
    expect(await readFile(tasksPath, 'utf8')).toBe(canonicalTasksBefore);
  } finally {
    await desktop.close();
    await Promise.all([rm(root, { recursive: true, force: true }), rm(userData, { recursive: true, force: true })]);
  }
});

test('keeps active inspection beacons inside the map and clear of the orchestrator across display scales', async () => {
  test.setTimeout(60_000);
  const userData = await mkdtemp(path.join(os.tmpdir(), 'orquesta-electron-inspection-scale-user-'));
  const desktop = await electron.launch({
    args: [`--user-data-dir=${userData}`, '--lang=en-US', '--force-prefers-reduced-motion=reduce', '.'],
    cwd: appRoot,
    env: { ...process.env, ORQUESTA_E2E: '1', ORQUESTA_E2E_FIXTURE: 'inspection-running' }
  });

  try {
    const window = await desktop.firstWindow();
    await expect(window.getByRole('application', { name: 'Orquesta Desktop' })).toBeVisible();
    const session = await window.context().newCDPSession(window);
    const variants = [
      { width: 1440, height: 900, scale: 1 },
      { width: 1366, height: 768, scale: 1.25 },
      { width: 1440, height: 900, scale: 1.5 },
      { width: 1366, height: 768, scale: 2 }
    ];

    for (const variant of variants) {
      await session.send('Emulation.setDeviceMetricsOverride', {
        width: variant.width,
        height: variant.height,
        deviceScaleFactor: variant.scale,
        mobile: false
      });
      await expect.poll(() => window.evaluate(() => window.devicePixelRatio)).toBeCloseTo(variant.scale, 1);
      await window.getByRole('button', { name: 'Fit' }).click();
      await expect(window.locator('[data-node-kind="inspection"]')).toHaveCount(2);
      await expect.poll(() => window.evaluate(() => {
        const orchestrator = document.querySelector('[data-agent-id="orchestrator"] .agent-node__visual')!.getBoundingClientRect();
        return Array.from(document.querySelectorAll('.inspection-node__visual')).some((node) => {
          const beacon = node.getBoundingClientRect();
          return beacon.left < orchestrator.right && beacon.right > orchestrator.left
            && beacon.top < orchestrator.bottom && beacon.bottom > orchestrator.top;
        });
      })).toBe(false);

      const geometry = await window.evaluate(() => {
        const viewport = document.querySelector('.map-viewport')!.getBoundingClientRect();
        const orchestrator = document.querySelector('[data-agent-id="orchestrator"] .agent-node__visual')!.getBoundingClientRect();
        const beacons = Array.from(document.querySelectorAll('.inspection-node__visual')).map((node) => node.getBoundingClientRect());
        const plain = (rect: DOMRect) => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
        return { viewport: plain(viewport), orchestrator: plain(orchestrator), beacons: beacons.map(plain) };
      });

      for (const beacon of geometry.beacons) {
        expect(beacon.left).toBeGreaterThanOrEqual(geometry.viewport.left - 1);
        expect(beacon.right).toBeLessThanOrEqual(geometry.viewport.right + 1);
        expect(beacon.top).toBeGreaterThanOrEqual(geometry.viewport.top - 1);
        expect(beacon.bottom).toBeLessThanOrEqual(geometry.viewport.bottom + 1);
        const overlapsOrchestrator = beacon.left < geometry.orchestrator.right
          && beacon.right > geometry.orchestrator.left
          && beacon.top < geometry.orchestrator.bottom
          && beacon.bottom > geometry.orchestrator.top;
        expect(overlapsOrchestrator, JSON.stringify({ variant, beacon, orchestrator: geometry.orchestrator })).toBe(false);
      }
    }
  } finally {
    await desktop.close();
    await rm(userData, { recursive: true, force: true });
  }
});
