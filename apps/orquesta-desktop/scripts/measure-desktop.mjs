import { access, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import { createMeasurementReport, evaluateDesktopGates, formatBytes, selectProcessTree } from './desktop-metrics.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptDirectory, '..');
const executableArgument = process.argv[2];

if (!executableArgument) throw new Error('Usage: node scripts/measure-desktop.mjs <path-to-Orquesta.exe>');

const executablePath = path.resolve(appRoot, executableArgument);
await access(executablePath);
const execFileAsync = promisify(execFile);
const validationDirectory = path.join(appRoot, 'docs', 'validation');
const foundationJsonPath = path.join(validationDirectory, 'desktop-foundation.json');
const foundationMarkdownPath = path.join(validationDirectory, 'desktop-foundation.md');

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function queryProcesses() {
  const command = [
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new();',
    '$OutputEncoding = [Console]::OutputEncoding;',
    '$rows = Get-CimInstance Win32_Process |',
    "Select-Object @{N='processId';E={$_.ProcessId}},@{N='parentProcessId';E={$_.ParentProcessId}},@{N='name';E={$_.Name}},@{N='workingSetBytes';E={[double]$_.WorkingSetSize}},@{N='executablePath';E={$_.ExecutablePath}},@{N='commandLine';E={$_.CommandLine}};",
    'ConvertTo-Json -Compress -InputObject @($rows)'
  ].join(' ');
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    windowsHide: true,
    maxBuffer: 16 * 1_048_576
  });
  const parsed = JSON.parse(stdout.trim() || '[]');
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function processTree(rootProcessId) {
  return selectProcessTree(await queryProcesses(), rootProcessId);
}

async function waitForRenderer(rootProcessId, timeoutMs = 15_000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const tree = await processTree(rootProcessId);
    if (tree.some((entry) => entry.commandLine?.includes('--type=renderer'))) return tree;
    await delay(100);
  }
  throw new Error('Packaged runtime did not create a renderer process in time');
}

async function waitForExit(rootProcessId, timeoutMs = 10_000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if ((await processTree(rootProcessId)).length === 0) return;
    await delay(100);
  }
  throw new Error(`Packaged process tree ${rootProcessId} did not exit cleanly`);
}

async function directorySize(directoryPath) {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const sizes = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) return directorySize(entryPath);
    if (entry.isFile()) return (await stat(entryPath)).size;
    return 0;
  }));
  return sizes.reduce((total, size) => total + size, 0);
}

async function createProjectFixture(root) {
  const state = path.join(root, '.orquesta', 'state');
  await mkdir(state, { recursive: true });
  const now = new Date().toISOString();
  await Promise.all([
    writeFile(path.join(state, 'agents.json'), `${JSON.stringify({
      updated_at: now,
      agents: [{ agent_id: 'orchestrator', role: 'orchestrator', display_name: 'Coordinator', status: 'standby', mission: 'Measure selected-project idle state.' }]
    }, null, 2)}\n`, 'utf8'),
    writeFile(path.join(state, 'tasks.json'), `${JSON.stringify({ updated_at: now, tasks: [] }, null, 2)}\n`, 'utf8')
  ]);
}

async function launchMeasured({ userData, projectRoot }) {
  const env = { ...process.env, ORQUESTA_E2E: '1' };
  delete env.ORQUESTA_E2E_CODEX_SCRIPT;
  delete env.ORQUESTA_E2E_FIXTURE;
  if (projectRoot) env.ORQUESTA_E2E_PROJECT_ROOT = projectRoot;
  else delete env.ORQUESTA_E2E_PROJECT_ROOT;
  const args = [`--user-data-dir=${userData}`, '--lang=en-US'];
  if (process.env.ORQUESTA_MEASURE_REDUCED_MOTION === '1') args.push('--force-prefers-reduced-motion=reduce');
  const desktop = await electron.launch({ executablePath, args, env });
  const rootProcessId = desktop.process().pid;
  const window = await desktop.firstWindow();
  await window.getByRole('application', { name: 'Orquesta Desktop' }).waitFor({ state: 'visible' });
  if (projectRoot) await window.getByLabel('Orquesta Map').waitFor({ state: 'visible' });
  else await window.getByRole('heading', { name: 'Open your first Orquesta project' }).waitFor({ state: 'visible' });
  await waitForRenderer(rootProcessId);
  return { desktop, rootProcessId, window };
}

async function isolateMeasurementInput(desktop, window) {
  const nativeWindow = await desktop.browserWindow(window);
  try {
    await nativeWindow.evaluate((browserWindow) => browserWindow.setIgnoreMouseEvents(true));
  } finally {
    await nativeWindow.dispose();
  }
}

function summarizeTree(tree) {
  return {
    workingSetBytes: tree.reduce((total, metric) => total + metric.workingSetBytes, 0),
    processCount: tree.length,
    processMetrics: tree
  };
}

async function closeMeasured(desktop, rootProcessId) {
  await desktop.close();
  await waitForExit(rootProcessId);
}

async function measureNormal(idleWaitMs) {
  const noProjectProfile = await mkdtemp(path.join(os.tmpdir(), 'orquesta-no-project-'));
  const selectedProfile = await mkdtemp(path.join(os.tmpdir(), 'orquesta-selected-project-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'orquesta-selected-repository-'));
  let noProject = null;
  let selected = null;
  try {
    await createProjectFixture(projectRoot);
    const startedAt = performance.now();
    noProject = await launchMeasured({ userData: noProjectProfile, projectRoot: null });
    const coldStartMs = performance.now() - startedAt;
    await isolateMeasurementInput(noProject.desktop, noProject.window);
    const noProjectHost = await noProject.window.evaluate(() => globalThis.orquestaDesktop.getHostInfo());
    await delay(idleWaitMs);
    const noProjectTree = summarizeTree(await processTree(noProject.rootProcessId));
    await closeMeasured(noProject.desktop, noProject.rootProcessId);
    noProject = null;

    selected = await launchMeasured({ userData: selectedProfile, projectRoot });
    await isolateMeasurementInput(selected.desktop, selected.window);
    const selectedHost = await selected.window.evaluate(() => globalThis.orquestaDesktop.getHostInfo());
    await delay(idleWaitMs);
    const selectedTree = summarizeTree(await processTree(selected.rootProcessId));

    const packageRoot = path.dirname(executablePath);
    const totalFootprint = await directorySize(packageRoot);
    const codexRuntimeFootprint = await directorySize(path.join(packageRoot, 'resources', 'codex-runtime'));
    const measurement = {
      measuredAt: new Date().toISOString(),
      executablePath,
      interactionIsolation: 'native mouse input disabled before idle timing',
      coldStartMs,
      idleWaitMs,
      noProjectWorkingSetBytes: noProjectTree.workingSetBytes,
      selectedProjectWorkingSetBytes: selectedTree.workingSetBytes,
      ui_core_footprint_bytes: totalFootprint - codexRuntimeFootprint,
      codex_runtime_footprint_bytes: codexRuntimeFootprint,
      total_footprint_bytes: totalFootprint,
      noProjectProcessCount: noProjectTree.processCount,
      selectedProjectProcessCount: selectedTree.processCount,
      noProjectHost,
      selectedProjectHost: selectedHost,
      noProjectProcessMetrics: noProjectTree.processMetrics,
      selectedProjectProcessMetrics: selectedTree.processMetrics
    };
    await mkdir(validationDirectory, { recursive: true });
    await Promise.all([
      writeFile(foundationJsonPath, `${JSON.stringify(measurement, null, 2)}\n`, 'utf8'),
      writeFile(foundationMarkdownPath, createMeasurementReport(measurement), 'utf8')
    ]);
    const gates = evaluateDesktopGates(measurement);
    console.log(JSON.stringify({ ...measurement, gates }, null, 2));
    if (!Object.values(gates).every(Boolean)) process.exitCode = 1;
  } finally {
    if (noProject) await closeMeasured(noProject.desktop, noProject.rootProcessId).catch(() => undefined);
    if (selected) await closeMeasured(selected.desktop, selected.rootProcessId).catch(() => undefined);
    await Promise.all([
      rm(noProjectProfile, { force: true, recursive: true }),
      rm(selectedProfile, { force: true, recursive: true }),
      rm(projectRoot, { force: true, recursive: true })
    ]);
  }
}

function leakReport(measurement) {
  const growthPass = measurement.leakGrowthBytes <= 75 * 1_048_576;
  const rows = measurement.samples.map((sample) => `| ${Math.round(sample.elapsedMs / 60_000)} | ${formatBytes(sample.workingSetBytes)} | ${sample.processCount} |`).join('\n');
  return `# Orquesta Desktop Leak Validation

Measured on ${measurement.measuredAt} using a selected idle project in the packaged Windows x64 application. Native mouse input was disabled before the timed interval so incidental cursor movement or clicking could not affect the result.

| Elapsed minutes | Total working set | Process count |
| ---: | ---: | ---: |
${rows}

- Growth from 5 to ${Math.round(measurement.idleWaitMs / 60_000)} minutes: ${formatBytes(measurement.leakGrowthBytes)} (limit 75 MiB) — ${growthPass ? 'PASS' : 'FAIL'}
- Result: ${growthPass ? 'PASS' : 'FAIL'}

Each sample in the JSON evidence includes the complete descendant process tree.
`;
}

async function measureLeak(idleWaitMs) {
  if (idleWaitMs < 5 * 60_000) throw new Error('Leak measurement requires at least five minutes');
  const userData = await mkdtemp(path.join(os.tmpdir(), 'orquesta-leak-project-'));
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'orquesta-leak-repository-'));
  let selected = null;
  try {
    await createProjectFixture(projectRoot);
    selected = await launchMeasured({ userData, projectRoot });
    await isolateMeasurementInput(selected.desktop, selected.window);
    const samples = [];
    const startedAt = performance.now();
    for (let checkpointMs = 5 * 60_000; checkpointMs <= idleWaitMs; checkpointMs += 5 * 60_000) {
      await delay(Math.max(0, checkpointMs - (performance.now() - startedAt)));
      const summary = summarizeTree(await processTree(selected.rootProcessId));
      samples.push({ elapsedMs: checkpointMs, ...summary });
      console.log(`Leak sample ${Math.round(checkpointMs / 60_000)}m: ${formatBytes(summary.workingSetBytes)} across ${summary.processCount} processes`);
    }
    const leakGrowthBytes = samples.at(-1).workingSetBytes - samples[0].workingSetBytes;
    const measurement = {
      measuredAt: new Date().toISOString(),
      executablePath,
      interactionIsolation: 'native mouse input disabled before idle timing',
      idleWaitMs,
      leakGrowthBytes,
      samples
    };
    await mkdir(validationDirectory, { recursive: true });
    await Promise.all([
      writeFile(path.join(validationDirectory, 'desktop-leak.json'), `${JSON.stringify(measurement, null, 2)}\n`, 'utf8'),
      writeFile(path.join(validationDirectory, 'desktop-leak.md'), leakReport(measurement), 'utf8')
    ]);
    console.log(JSON.stringify({ measuredAt: measurement.measuredAt, idleWaitMs, leakGrowthBytes, leakGrowthPass: leakGrowthBytes <= 75 * 1_048_576 }, null, 2));
    if (leakGrowthBytes > 75 * 1_048_576) process.exitCode = 1;
  } finally {
    if (selected) await closeMeasured(selected.desktop, selected.rootProcessId).catch(() => undefined);
    await Promise.all([rm(userData, { force: true, recursive: true }), rm(projectRoot, { force: true, recursive: true })]);
  }
}

const idleWaitMs = Number.parseInt(process.env.ORQUESTA_MEASURE_IDLE_MS ?? '60000', 10);
if (!Number.isFinite(idleWaitMs) || idleWaitMs < 0) throw new Error('ORQUESTA_MEASURE_IDLE_MS must be a non-negative integer');

if (idleWaitMs >= 5 * 60_000) await measureLeak(idleWaitMs);
else await measureNormal(idleWaitMs);
