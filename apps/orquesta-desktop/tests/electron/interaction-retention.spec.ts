import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, test, type Page } from '@playwright/test';
import { _electron as electron, type CDPSession } from 'playwright';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const packagedExecutable = path.resolve(process.env.ORQUESTA_PACKAGED_EXE ?? path.join(appRoot, 'out', 'Orquesta-win32-x64', 'Orquesta.exe'));
const execFileAsync = promisify(execFile);
const mebibyte = 1_048_576;

interface ProcessMetric {
  processId: number;
  parentProcessId: number;
  name: string;
  workingSetBytes: number;
  commandLine: string | null;
}

interface MemorySnapshot {
  label: string;
  capturedAt: string;
  forcedGarbageCollection: boolean;
  totalWorkingSetBytes: number;
  processCount: number;
  workingSetByRole: Record<string, number>;
  jsHeapUsedBytes: number;
  jsHeapTotalBytes: number;
  documents: number;
  nodes: number;
  liveDomNodes: number;
  eventListeners: number;
  processMetrics: ProcessMetric[];
}

async function queryProcesses(): Promise<ProcessMetric[]> {
  const command = [
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new();',
    '$OutputEncoding = [Console]::OutputEncoding;',
    '$rows = Get-CimInstance Win32_Process |',
    "Select-Object @{N='processId';E={$_.ProcessId}},@{N='parentProcessId';E={$_.ParentProcessId}},@{N='name';E={$_.Name}},@{N='workingSetBytes';E={[double]$_.WorkingSetSize}},@{N='commandLine';E={$_.CommandLine}};",
    'ConvertTo-Json -Compress -InputObject @($rows)'
  ].join(' ');
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    windowsHide: true,
    maxBuffer: 16 * mebibyte
  });
  const parsed = JSON.parse(stdout.trim() || '[]');
  return (Array.isArray(parsed) ? parsed : [parsed]) as ProcessMetric[];
}

function descendants(processes: ProcessMetric[], rootProcessId: number): ProcessMetric[] {
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

function processRole(metric: ProcessMetric): string {
  if (metric.commandLine?.includes('--type=renderer')) return 'renderer';
  if (metric.commandLine?.includes('--type=gpu-process')) return 'gpu';
  if (metric.commandLine?.includes('node.mojom.NodeService')) return 'core';
  if (metric.commandLine?.includes('network.mojom.NetworkService')) return 'network';
  if (metric.name.toLowerCase() === 'cmd.exe') return 'launcher';
  return 'main';
}

async function captureMemory(
  label: string,
  rootProcessId: number,
  window: Page,
  session: CDPSession,
  forceGarbageCollection: boolean
): Promise<MemorySnapshot> {
  if (forceGarbageCollection) {
    await session.send('HeapProfiler.collectGarbage');
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  const [performanceMetrics, domCounters, liveDomNodes, tree] = await Promise.all([
    session.send('Performance.getMetrics') as Promise<{ metrics: Array<{ name: string; value: number }> }>,
    session.send('Memory.getDOMCounters') as Promise<{ documents: number; nodes: number; jsEventListeners: number }>,
    window.evaluate(() => document.getElementsByTagName('*').length),
    queryProcesses().then((processes) => descendants(processes, rootProcessId))
  ]);
  const values = new Map(performanceMetrics.metrics.map((metric) => [metric.name, metric.value]));
  const workingSetByRole: Record<string, number> = {};
  for (const metric of tree) {
    const role = processRole(metric);
    workingSetByRole[role] = (workingSetByRole[role] ?? 0) + metric.workingSetBytes;
  }
  return {
    label,
    capturedAt: new Date().toISOString(),
    forcedGarbageCollection: forceGarbageCollection,
    totalWorkingSetBytes: tree.reduce((total, metric) => total + metric.workingSetBytes, 0),
    processCount: tree.length,
    workingSetByRole,
    jsHeapUsedBytes: values.get('JSHeapUsedSize') ?? 0,
    jsHeapTotalBytes: values.get('JSHeapTotalSize') ?? 0,
    documents: domCounters.documents,
    nodes: domCounters.nodes,
    liveDomNodes,
    eventListeners: domCounters.jsEventListeners,
    processMetrics: tree
  };
}

async function unobstructedMapPoint(window: Page): Promise<{ x: number; y: number }> {
  return window.evaluate(() => {
    for (let y = 150; y < innerHeight - 150; y += 24) {
      for (let x = 300; x < innerWidth - 300; x += 24) {
        const element = document.elementFromPoint(x, y);
        if (element?.classList.contains('map-world') || element?.classList.contains('map-viewport')) return { x, y };
      }
    }
    throw new Error('No unobstructed map interaction point was found');
  });
}

async function runInteractionBatch(window: Page, batch: number): Promise<void> {
  for (let cycle = 0; cycle < 20; cycle += 1) {
    const point = await unobstructedMapPoint(window);
    const direction = (batch + cycle) % 2 === 0 ? 1 : -1;
    await window.mouse.move(point.x, point.y);
    await window.mouse.down();
    await window.mouse.move(point.x + 72 * direction, point.y + 44 * direction, { steps: 5 });
    await window.mouse.up();
    await window.mouse.wheel(0, -360 * direction);
    await window.mouse.wheel(0, 360 * direction);

    if (cycle % 4 === 0) {
      await window.evaluate(async (agentId) => {
        const clickButton = (label: string) => {
          const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
          if (!button) throw new Error(`Missing ${label} button`);
          button.click();
        };
        clickButton('Fit');
        const agent = document.querySelector<HTMLButtonElement>(`[data-agent-id="${agentId}"]`);
        if (!agent) throw new Error(`Missing ${agentId}`);
        agent.click();
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        clickButton('Zoom in');
        clickButton('Zoom out');
      }, `agent-${String(1 + ((batch + cycle) % 24)).padStart(2, '0')}`);
    }
  }
  await window.evaluate(() => document.querySelector<HTMLButtonElement>('button[aria-label="Fit"]')?.click());
  await window.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

function formatMiB(bytes: number): string {
  return `${(bytes / mebibyte).toFixed(2)} MiB`;
}

function createReport(evidence: {
  measuredAt: string;
  baseline: MemorySnapshot;
  batches: Array<{ batch: number; immediate: MemorySnapshot; afterGarbageCollection: MemorySnapshot }>;
  recovery: MemorySnapshot[];
  finalAfterGarbageCollection: MemorySnapshot;
  deltas: Record<string, number>;
  gates: Record<string, boolean>;
}): string {
  const rows = [
    evidence.baseline,
    ...evidence.batches.flatMap((batch) => [batch.immediate, batch.afterGarbageCollection]),
    ...evidence.recovery,
    evidence.finalAfterGarbageCollection
  ].map((snapshot) => `| ${snapshot.label} | ${formatMiB(snapshot.totalWorkingSetBytes)} | ${formatMiB(snapshot.workingSetByRole.renderer ?? 0)} | ${formatMiB(snapshot.workingSetByRole.gpu ?? 0)} | ${formatMiB(snapshot.jsHeapUsedBytes)} | ${snapshot.nodes} | ${snapshot.liveDomNodes} | ${snapshot.eventListeners} |`).join('\n');
  return `# Orquesta Desktop Interaction Retention\n\nMeasured on ${evidence.measuredAt} with the packaged Windows x64 app and the 35-agent fixture. Six identical batches exercised map pan, wheel zoom, native agent-detail open/close, Fit, and zoom controls. CDP garbage collection was used only for diagnosis, not to change product behavior.\n\n| Sample | Total working set | Renderer | GPU | JS heap used | DOM counter | Live DOM | Event listeners |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n${rows}\n\n- Final retained total working set: ${formatMiB(evidence.deltas.totalWorkingSetBytes)}\n- Working-set growth after the first warmed interaction batch: ${formatMiB(evidence.deltas.repeatedWorkingSetBytes)}\n- Final retained Renderer working set: ${formatMiB(evidence.deltas.rendererWorkingSetBytes)}\n- Final retained GPU working set: ${formatMiB(evidence.deltas.gpuWorkingSetBytes)}\n- Final retained JS heap after forced collection: ${formatMiB(evidence.deltas.jsHeapUsedBytes)}\n- Final DOM-counter delta: ${evidence.deltas.nodes}\n- Final live-DOM delta: ${evidence.deltas.liveDomNodes}\n- Final event-listener delta: ${evidence.deltas.eventListeners}\n- Stable process count: ${evidence.gates.stableProcessCount ? 'PASS' : 'FAIL'}\n- Total retained working set <= 75 MiB: ${evidence.gates.boundedWorkingSet ? 'PASS' : 'FAIL'}\n- Growth after the first warmed batch <= 30 MiB: ${evidence.gates.boundedRepeatedGrowth ? 'PASS' : 'FAIL'}\n- Post-GC JS heap growth <= 8 MiB: ${evidence.gates.boundedReachableHeap ? 'PASS' : 'FAIL'}\n- DOM-counter growth <= 10: ${evidence.gates.boundedDomCounters ? 'PASS' : 'FAIL'}\n- Live-DOM growth = 0: ${evidence.gates.stableLiveDom ? 'PASS' : 'FAIL'}\n- Event-listener growth <= 20: ${evidence.gates.boundedEventListeners ? 'PASS' : 'FAIL'}\n\nThe process working set is reported separately from reachable JavaScript heap. A first-use working-set increase that plateaus across repeated batches while post-GC heap, DOM nodes, and listeners stay bounded is retained Chromium/V8 capacity or graphics caching, not an accumulating product leak.\n`;
}

test('classifies memory retained after repeated map interaction', async () => {
  test.setTimeout(300_000);
  await access(packagedExecutable);
  const userData = await mkdtemp(path.join(os.tmpdir(), 'orquesta-interaction-retention-'));
  const runtimeEnvironment = { ...process.env, ORQUESTA_E2E: '1', ORQUESTA_E2E_FIXTURE: 'large-roster' };
  for (const key of ['ORQUESTA_E2E_CODEX_SCRIPT', 'ORQUESTA_E2E_PROJECT_ROOT', 'ORQUESTA_CODEX_PATH', 'CODEX_PATH', 'ORQUESTA_RENDERER_URL']) delete runtimeEnvironment[key];
  const desktop = await electron.launch({
    executablePath: packagedExecutable,
    args: [`--user-data-dir=${userData}`, '--lang=en-US', '--force-prefers-reduced-motion=reduce'],
    env: runtimeEnvironment
  });
  const rootProcessId = desktop.process().pid;

  try {
    const window = await desktop.firstWindow();
    await expect(window.locator('[data-node-kind="agent"]')).toHaveCount(35);
    const session = await window.context().newCDPSession(window);
    await session.send('Performance.enable');
    await session.send('HeapProfiler.enable');
    await window.getByRole('button', { name: 'Fit' }).click();
    await window.waitForTimeout(30_000);

    const baseline = await captureMemory('baseline after 30s + GC', rootProcessId, window, session, true);
    const batches: Array<{ batch: number; immediate: MemorySnapshot; afterGarbageCollection: MemorySnapshot }> = [];
    for (let batch = 1; batch <= 6; batch += 1) {
      await runInteractionBatch(window, batch);
      const immediate = await captureMemory(`batch ${batch} immediate`, rootProcessId, window, session, false);
      const afterGarbageCollection = await captureMemory(`batch ${batch} after GC`, rootProcessId, window, session, true);
      batches.push({ batch, immediate, afterGarbageCollection });
    }

    const nativeWindow = await desktop.browserWindow(window);
    await nativeWindow.evaluate((browserWindow) => browserWindow.setIgnoreMouseEvents(true));
    await nativeWindow.dispose();
    const recovery: MemorySnapshot[] = [];
    await window.waitForTimeout(60_000);
    recovery.push(await captureMemory('recovery 1m', rootProcessId, window, session, false));
    const finalAfterGarbageCollection = await captureMemory('recovery 1m after GC', rootProcessId, window, session, true);

    const deltas = {
      totalWorkingSetBytes: finalAfterGarbageCollection.totalWorkingSetBytes - baseline.totalWorkingSetBytes,
      repeatedWorkingSetBytes: finalAfterGarbageCollection.totalWorkingSetBytes - batches[0].afterGarbageCollection.totalWorkingSetBytes,
      rendererWorkingSetBytes: (finalAfterGarbageCollection.workingSetByRole.renderer ?? 0) - (baseline.workingSetByRole.renderer ?? 0),
      gpuWorkingSetBytes: (finalAfterGarbageCollection.workingSetByRole.gpu ?? 0) - (baseline.workingSetByRole.gpu ?? 0),
      jsHeapUsedBytes: finalAfterGarbageCollection.jsHeapUsedBytes - baseline.jsHeapUsedBytes,
      nodes: finalAfterGarbageCollection.nodes - baseline.nodes,
      liveDomNodes: finalAfterGarbageCollection.liveDomNodes - baseline.liveDomNodes,
      eventListeners: finalAfterGarbageCollection.eventListeners - baseline.eventListeners
    };
    const allSnapshots = [baseline, ...batches.flatMap((batch) => [batch.immediate, batch.afterGarbageCollection]), ...recovery, finalAfterGarbageCollection];
    const gates = {
      stableProcessCount: allSnapshots.every((snapshot) => snapshot.processCount === baseline.processCount),
      boundedWorkingSet: deltas.totalWorkingSetBytes <= 75 * mebibyte,
      boundedRepeatedGrowth: deltas.repeatedWorkingSetBytes <= 30 * mebibyte,
      boundedReachableHeap: deltas.jsHeapUsedBytes <= 8 * mebibyte,
      boundedDomCounters: deltas.nodes <= 10,
      stableLiveDom: deltas.liveDomNodes === 0,
      boundedEventListeners: deltas.eventListeners <= 20
    };
    const evidence = { measuredAt: new Date().toISOString(), packagedExecutable, baseline, batches, recovery, finalAfterGarbageCollection, deltas, gates };
    const validationDirectory = path.join(appRoot, 'docs', 'validation');
    await mkdir(validationDirectory, { recursive: true });
    await Promise.all([
      writeFile(path.join(validationDirectory, 'desktop-interaction-retention.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8'),
      writeFile(path.join(validationDirectory, 'desktop-interaction-retention.md'), createReport(evidence), 'utf8')
    ]);

    expect(gates).toEqual({
      stableProcessCount: true,
      boundedWorkingSet: true,
      boundedRepeatedGrowth: true,
      boundedReachableHeap: true,
      boundedDomCounters: true,
      stableLiveDom: true,
      boundedEventListeners: true
    });
  } finally {
    await desktop.close();
    await rm(userData, { recursive: true, force: true });
  }
});
