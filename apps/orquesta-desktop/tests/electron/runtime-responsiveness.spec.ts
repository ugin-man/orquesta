import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fakeAppServer = path.join(appRoot, 'tests', 'electron', 'fixtures', 'fake-codex-app-server.cjs');
const execFileAsync = promisify(execFile);

function projectId(rootPath: string): string {
  return `repo-${createHash('sha256').update(path.resolve(rootPath).replaceAll('\\', '/').toLowerCase()).digest('hex').slice(0, 16)}`;
}

async function writeProject(root: string, displayName: string): Promise<void> {
  const state = path.join(root, '.orquesta', 'state');
  const now = new Date().toISOString();
  await mkdir(state, { recursive: true });
  await Promise.all([
    writeFile(path.join(state, 'agents.json'), `${JSON.stringify({
      updated_at: now,
      agents: [{ agent_id: 'orchestrator', role: 'orchestrator', display_name: displayName, status: 'standby', mission: `Coordinate ${displayName}.` }]
    }, null, 2)}\n`, 'utf8'),
    writeFile(path.join(state, 'tasks.json'), `${JSON.stringify({ updated_at: now, tasks: [] }, null, 2)}\n`, 'utf8')
  ]);
}

async function queryProcesses() {
  const command = [
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new();',
    '$rows = Get-CimInstance Win32_Process |',
    "Select-Object @{N='processId';E={$_.ProcessId}},@{N='parentProcessId';E={$_.ParentProcessId}},@{N='name';E={$_.Name}},@{N='commandLine';E={$_.CommandLine}};",
    'ConvertTo-Json -Compress -InputObject @($rows)'
  ].join(' ');
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    windowsHide: true,
    maxBuffer: 16 * 1_048_576
  });
  return JSON.parse(stdout.trim() || '[]') as Array<{ processId: number; parentProcessId: number; name: string; commandLine: string | null }>;
}

function descendants(processes: Awaited<ReturnType<typeof queryProcesses>>, rootProcessId: number) {
  const ids = new Set([rootProcessId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const process of processes) {
      if (!ids.has(process.processId) && ids.has(process.parentProcessId)) {
        ids.add(process.processId);
        changed = true;
      }
    }
  }
  return processes.filter((process) => ids.has(process.processId));
}

test('keeps Composer and the map responsive during a delayed Codex turn and cleans up old work', async () => {
  const firstRoot = await mkdtemp(path.join(os.tmpdir(), 'orquesta-responsive-first-'));
  const secondRoot = await mkdtemp(path.join(os.tmpdir(), 'orquesta-responsive-second-'));
  const userData = await mkdtemp(path.join(os.tmpdir(), 'orquesta-responsive-user-'));
  await Promise.all([writeProject(firstRoot, 'First Coordinator'), writeProject(secondRoot, 'Second Coordinator')]);
  const firstId = projectId(firstRoot);
  const secondId = projectId(secondRoot);
  const now = new Date().toISOString();
  await writeFile(path.join(userData, 'repositories.json'), `${JSON.stringify({
    version: 1,
    currentProjectId: firstId,
    projects: [
      { id: firstId, title: path.basename(firstRoot), rootPath: firstRoot, rootPathLabel: firstRoot, status: 'ready', connectionLabel: 'Saved project', lastOpenedAt: now, coordinatorThreadId: null },
      { id: secondId, title: path.basename(secondRoot), rootPath: secondRoot, rootPathLabel: secondRoot, status: 'ready', connectionLabel: 'Saved project', lastOpenedAt: now, coordinatorThreadId: null }
    ]
  }, null, 2)}\n`, 'utf8');

  const desktop = await electron.launch({
    args: [
      `--user-data-dir=${userData}`,
      '--lang=en-US',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '.'
    ],
    cwd: appRoot,
    env: { ...process.env, ORQUESTA_E2E: '1', ORQUESTA_E2E_PROJECT_ROOT: firstRoot, ORQUESTA_E2E_CODEX_SCRIPT: fakeAppServer }
  });
  const rootProcessId = desktop.process().pid;
  let observedProcessIds: number[] = [];

  try {
    const window = await desktop.firstWindow();
    await expect(window.getByRole('button', { name: 'First Coordinator, Idle' })).toBeVisible();
    await window.evaluate(() => {
      const scope = globalThis as typeof globalThis & {
        __orquestaFrameDeltas?: number[];
        __orquestaFramesActive?: boolean;
        __orquestaRepositoryEvents?: string[];
        __orquestaRuntimeEvents?: string[];
      };
      scope.__orquestaFrameDeltas = [];
      scope.__orquestaFramesActive = false;
      scope.__orquestaRepositoryEvents = [];
      scope.__orquestaRuntimeEvents = [];
      globalThis.orquestaDesktop.subscribeRepository((snapshot) => scope.__orquestaRepositoryEvents?.push(snapshot.project.id));
      globalThis.orquestaDesktop.subscribeRuntime((event) => scope.__orquestaRuntimeEvents?.push(event.kind));
    });

    const composer = window.getByRole('textbox', { name: 'Give an instruction or ask a question…' });
    await composer.fill('DELAY_TURN');
    await window.getByRole('button', { name: 'Send message' }).click();
    await expect.poll(() => window.evaluate(() => (globalThis as typeof globalThis & { __orquestaRuntimeEvents?: string[] }).__orquestaRuntimeEvents ?? []))
      .toContain('turn_started');
    await window.evaluate(async () => {
      const scope = globalThis as typeof globalThis & { __orquestaFrameDeltas?: number[]; __orquestaFramesActive?: boolean };
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      scope.__orquestaFrameDeltas = [];
      scope.__orquestaFramesActive = true;
      let previous = performance.now();
      const sample = (now: number) => {
        scope.__orquestaFrameDeltas?.push(now - previous);
        previous = now;
        if (scope.__orquestaFramesActive) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });

    const orderedInput = Array.from({ length: 100 }, (_, index) => String.fromCharCode(65 + (index % 26))).join('');
    await composer.pressSequentially(orderedInput, { delay: 2 });
    await expect(composer).toHaveValue(orderedInput);

    const map = window.getByLabel('Orquesta Map');
    const box = await map.boundingBox();
    if (!box) throw new Error('Map bounds are unavailable');
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await window.mouse.move(point.x, point.y);
    await window.mouse.down();
    await window.mouse.move(point.x + 80, point.y + 50, { steps: 6 });
    await window.mouse.up();
    const zoomBefore = Number(await window.locator('.map-world').getAttribute('data-zoom'));
    await window.mouse.wheel(0, -420);
    await expect.poll(async () => Number(await window.locator('.map-world').getAttribute('data-zoom'))).toBeGreaterThan(zoomBefore);

    const activeEvidence = await window.evaluate(() => {
      const scope = globalThis as typeof globalThis & { __orquestaFrameDeltas?: number[]; __orquestaRuntimeEvents?: string[] };
      return { frameDeltas: scope.__orquestaFrameDeltas ?? [], runtimeEvents: scope.__orquestaRuntimeEvents ?? [] };
    });
    expect(activeEvidence.runtimeEvents).not.toContain('turn_completed');
    expect(activeEvidence.frameDeltas.filter((duration) => duration >= 500)).toEqual([]);

    const switchResult = await window.evaluate((id) => globalThis.orquestaDesktop.switchRepository(id), secondId);
    expect(switchResult.status).toBe('accepted');
    await expect(window.getByRole('button', { name: 'Second Coordinator, Idle' })).toBeVisible();
    await window.waitForTimeout(350);
    await window.evaluate(() => { (globalThis as typeof globalThis & { __orquestaRepositoryEvents?: string[] }).__orquestaRepositoryEvents = []; });
    await writeFile(path.join(firstRoot, '.orquesta', 'state', 'tasks.json'), `${JSON.stringify({ updated_at: new Date().toISOString(), tasks: [{ task_id: 'STALE', title: 'Must not project', state: 'in_progress', owner_agent_id: 'orchestrator' }] })}\n`, 'utf8');
    await window.waitForTimeout(750);
    const repositoryEvents = await window.evaluate(() => (globalThis as typeof globalThis & { __orquestaRepositoryEvents?: string[] }).__orquestaRepositoryEvents ?? []);
    expect(repositoryEvents).not.toContain(firstId);
    expect((await window.evaluate(() => globalThis.orquestaDesktop.getRepositorySnapshot())).project.id).toBe(secondId);

    const tree = descendants(await queryProcesses(), rootProcessId);
    expect(tree.some((process) => process.commandLine?.includes(fakeAppServer))).toBe(true);
    observedProcessIds = tree.map((process) => process.processId);
    await window.evaluate(() => { (globalThis as typeof globalThis & { __orquestaFramesActive?: boolean }).__orquestaFramesActive = false; });
  } finally {
    await desktop.close();
    await expect.poll(async () => {
      const alive = new Set((await queryProcesses()).map((process) => process.processId));
      return observedProcessIds.filter((processId) => alive.has(processId));
    }, { timeout: 10_000 }).toEqual([]);
    await Promise.all([
      rm(firstRoot, { recursive: true, force: true }),
      rm(secondRoot, { recursive: true, force: true }),
      rm(userData, { recursive: true, force: true })
    ]);
  }
});
