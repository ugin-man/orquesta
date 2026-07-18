import { access, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import { createMeasurementReport, evaluateDesktopGates, selectProcessTree } from './desktop-metrics.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptDirectory, '..');
const executableArgument = process.argv[2];

if (!executableArgument) {
  throw new Error('Usage: node scripts/measure-desktop.mjs <path-to-Orquesta.exe>');
}

const executablePath = path.resolve(appRoot, executableArgument);
await access(executablePath);
const execFileAsync = promisify(execFile);

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function queryPackagedProcesses() {
  const command = [
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new();',
    '$OutputEncoding = [Console]::OutputEncoding;',
    "$rows = Get-CimInstance Win32_Process -Filter \"Name = 'Orquesta.exe'\" |",
    'Where-Object { $_.ExecutablePath -ieq $env:ORQUESTA_METRIC_EXE } |',
    "Select-Object @{N='processId';E={$_.ProcessId}},@{N='parentProcessId';E={$_.ParentProcessId}},@{N='workingSetBytes';E={[double]$_.WorkingSetSize}},@{N='commandLine';E={$_.CommandLine}};",
    'ConvertTo-Json -Compress -InputObject @($rows)'
  ].join(' ');
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    env: { ...process.env, ORQUESTA_METRIC_EXE: executablePath },
    windowsHide: true
  });
  const parsed = JSON.parse(stdout.trim() || '[]');
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function waitForRuntimeTree(rootProcessId, timeoutMs = 10_000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const tree = selectProcessTree(await queryPackagedProcesses(), rootProcessId);
    if (tree.some((process) => process.commandLine?.includes('--type=renderer'))) return tree;
    await delay(100);
  }
  throw new Error('Packaged runtime did not create a renderer process in time');
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

const idleWaitMs = Number.parseInt(process.env.ORQUESTA_MEASURE_IDLE_MS ?? '60000', 10);
if (!Number.isFinite(idleWaitMs) || idleWaitMs < 0) {
  throw new Error('ORQUESTA_MEASURE_IDLE_MS must be a non-negative integer');
}

const startedAt = performance.now();
const coldStartProfile = await mkdtemp(path.join(os.tmpdir(), 'orquesta-cold-start-'));
const idleProfile = await mkdtemp(path.join(os.tmpdir(), 'orquesta-idle-'));
let desktop;
let runtime;

try {
  desktop = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${coldStartProfile}`],
    env: { ...process.env, ORQUESTA_E2E: '1' }
  });
  const window = await desktop.firstWindow();
  await window.getByRole('application', { name: 'Orquesta Desktop' }).waitFor({ state: 'visible' });
  await window.getByLabel('Orquesta Map').waitFor({ state: 'visible' });
  const coldStartMs = performance.now() - startedAt;
  await desktop.close();
  desktop = undefined;

  const runtimeArguments = [`--user-data-dir=${idleProfile}`];
  if (process.env.ORQUESTA_MEASURE_REDUCED_MOTION === '1') {
    runtimeArguments.push('--force-prefers-reduced-motion=reduce');
  }
  runtime = spawn(executablePath, runtimeArguments, {
    env: { ...process.env, ORQUESTA_E2E: '1' },
    stdio: 'ignore',
    windowsHide: false
  });
  await waitForRuntimeTree(runtime.pid);
  await delay(idleWaitMs);
  const processMetrics = selectProcessTree(await queryPackagedProcesses(), runtime.pid);
  if (!processMetrics.length) throw new Error('Packaged runtime exited before memory measurement');
  const workingSetBytes = processMetrics.reduce((total, metric) => total + metric.workingSetBytes, 0);
  const footprintBytes = await directorySize(path.dirname(executablePath));
  const measurement = {
    measuredAt: new Date().toISOString(),
    executablePath,
    coldStartMs,
    idleWaitMs,
    workingSetBytes,
    footprintBytes,
    processCount: processMetrics.length,
    processMetrics
  };
  const validationDirectory = path.join(appRoot, 'docs', 'validation');

  await mkdir(validationDirectory, { recursive: true });
  await Promise.all([
    writeFile(path.join(validationDirectory, 'desktop-foundation.json'), `${JSON.stringify(measurement, null, 2)}\n`, 'utf8'),
    writeFile(path.join(validationDirectory, 'desktop-foundation.md'), createMeasurementReport(measurement), 'utf8')
  ]);

  const gates = evaluateDesktopGates(measurement);
  console.log(JSON.stringify({ ...measurement, gates }, null, 2));
  if (!Object.values(gates).every(Boolean)) process.exitCode = 1;
} finally {
  if (desktop) await desktop.close();
  if (runtime && !runtime.killed) runtime.kill();
  await delay(500);
  await Promise.all([
    rm(coldStartProfile, { force: true, recursive: true }),
    rm(idleProfile, { force: true, recursive: true })
  ]);
}
