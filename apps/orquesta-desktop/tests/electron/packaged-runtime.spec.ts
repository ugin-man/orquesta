import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const packagedExecutable = path.resolve(process.env.ORQUESTA_PACKAGED_EXE ?? path.join(appRoot, 'out', 'Orquesta-win32-x64', 'Orquesta.exe'));
const execFileAsync = promisify(execFile);

async function writeProject(root: string): Promise<void> {
  const state = path.join(root, '.orquesta', 'state');
  const now = new Date().toISOString();
  await mkdir(state, { recursive: true });
  await Promise.all([
    writeFile(path.join(state, 'agents.json'), `${JSON.stringify({
      updated_at: now,
      agents: [{ agent_id: 'orchestrator', role: 'orchestrator', display_name: 'Coordinator', status: 'standby', mission: 'Validate the packaged runtime.' }]
    }, null, 2)}\n`, 'utf8'),
    writeFile(path.join(state, 'tasks.json'), `${JSON.stringify({ updated_at: now, tasks: [] }, null, 2)}\n`, 'utf8')
  ]);
}

async function queryProcesses() {
  const command = [
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new();',
    '$rows = Get-CimInstance Win32_Process |',
    "Select-Object @{N='processId';E={$_.ProcessId}},@{N='parentProcessId';E={$_.ParentProcessId}},@{N='name';E={$_.Name}},@{N='executablePath';E={$_.ExecutablePath}},@{N='commandLine';E={$_.CommandLine}};",
    'ConvertTo-Json -Compress -InputObject @($rows)'
  ].join(' ');
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    windowsHide: true,
    maxBuffer: 16 * 1_048_576
  });
  const parsed = JSON.parse(stdout.trim() || '[]');
  return (Array.isArray(parsed) ? parsed : [parsed]) as Array<{
    processId: number;
    parentProcessId: number;
    name: string;
    executablePath: string | null;
    commandLine: string | null;
  }>;
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

test('uses the bundled real Codex App Server for a complete packaged turn and clean shutdown', async () => {
  test.setTimeout(240_000);
  await access(packagedExecutable);
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'orquesta-packaged-project-'));
  const userData = await mkdtemp(path.join(os.tmpdir(), 'orquesta-packaged-user-'));
  await writeProject(projectRoot);
  const runtimeEnvironment = { ...process.env, ORQUESTA_E2E: '1', ORQUESTA_E2E_PROJECT_ROOT: projectRoot };
  for (const key of ['ORQUESTA_E2E_CODEX_SCRIPT', 'ORQUESTA_CODEX_PATH', 'CODEX_PATH', 'ORQUESTA_RENDERER_URL']) delete runtimeEnvironment[key];
  const desktop = await electron.launch({
    executablePath: packagedExecutable,
    args: [`--user-data-dir=${userData}`, '--lang=en-US'],
    env: runtimeEnvironment
  });
  const rootProcessId = desktop.process().pid;
  let observedProcessIds: number[] = [];
  let evidence: Record<string, unknown> | null = null;

  try {
    const window = await desktop.firstWindow();
    await expect(window.getByRole('button', { name: 'Coordinator, Idle' })).toBeVisible();
    await window.evaluate(() => {
      const scope = globalThis as typeof globalThis & { __orquestaPackagedRuntimeEvents?: string[] };
      scope.__orquestaPackagedRuntimeEvents = [];
      globalThis.orquestaDesktop.subscribeRuntime((event) => scope.__orquestaPackagedRuntimeEvents?.push(event.kind));
    });

    const runtimeInfo = await window.evaluate(() => globalThis.orquestaDesktop.getRuntimeInfo({ probe: true }));
    if (runtimeInfo.status !== 'ready') {
      const diagnostic = await window.evaluate(() => globalThis.orquestaDesktop.sendMessage({
        targetAgentId: 'orchestrator',
        text: 'Runtime diagnostic only.',
        attachmentIds: [],
        selectedContextIds: []
      }));
      throw new Error(`Packaged runtime probe failed: ${JSON.stringify({ runtimeInfo, diagnostic })}`);
    }
    expect(runtimeInfo).toMatchObject({ status: 'ready', adapter: 'app_server', integrity: 'verified' });
    expect(runtimeInfo.sdkVersion).toBe('0.144.5');
    expect(runtimeInfo.codexVersion).toBe('0.144.5');
    expect(runtimeInfo.runtimeVersion).toBe('0.144.5-win32-x64');

    const prompt = 'Reply with exactly ORQUESTA_RUNTIME_OK. Do not modify files or run commands.';
    const composer = window.getByRole('textbox', { name: 'Give an instruction or ask a question…' });
    await composer.fill(prompt);
    await window.getByRole('button', { name: 'Send message' }).click();
    await expect(composer).toHaveValue('');
    await expect.poll(() => window.evaluate(() => (globalThis as typeof globalThis & { __orquestaPackagedRuntimeEvents?: string[] }).__orquestaPackagedRuntimeEvents ?? []), { timeout: 60_000 })
      .toContain('turn_started');
    await expect.poll(() => window.evaluate(() => (globalThis as typeof globalThis & { __orquestaPackagedRuntimeEvents?: string[] }).__orquestaPackagedRuntimeEvents ?? []), { timeout: 180_000 })
      .toContain('turn_completed');

    const history = await window.evaluate(() => globalThis.orquestaDesktop.listConversation({ targetAgentId: 'orchestrator', limit: 100 }));
    expect(history.items.some((message) => message.role === 'user' && message.text === prompt)).toBe(true);
    expect(history.items.some((message) => message.role === 'agent' && message.text.trim().length > 0)).toBe(true);

    const tree = descendants(await queryProcesses(), rootProcessId);
    const codexProcesses = tree.filter((process) => process.name.toLowerCase() === 'codex.exe');
    expect(codexProcesses.length).toBeGreaterThan(0);
    const packagedRuntimeRoot = path.join(path.dirname(packagedExecutable), 'resources', 'codex-runtime').toLowerCase();
    for (const process of codexProcesses) {
      expect(process.executablePath?.toLowerCase().startsWith(packagedRuntimeRoot)).toBe(true);
    }
    observedProcessIds = tree.map((process) => process.processId);

    evidence = {
      measuredAt: new Date().toISOString(),
      packagedExecutable,
      runtimeOverrideEnvironmentPresent: false,
      runtimeInfo,
      runtimeEvents: await window.evaluate(() => (globalThis as typeof globalThis & { __orquestaPackagedRuntimeEvents?: string[] }).__orquestaPackagedRuntimeEvents ?? []),
      prompt,
      historyMessageCount: history.items.length,
      codexProcesses,
      processTree: tree,
      temporaryUserData: true,
      temporaryProject: true
    };
  } finally {
    await desktop.close();
    await expect.poll(async () => {
      const alive = new Set((await queryProcesses()).map((process) => process.processId));
      return observedProcessIds.filter((processId) => alive.has(processId));
    }, { timeout: 15_000 }).toEqual([]);
    await Promise.all([
      rm(projectRoot, { recursive: true, force: true }),
      rm(userData, { recursive: true, force: true })
    ]);
  }
  if (!evidence) throw new Error('Packaged runtime evidence was not captured');
  const validationDirectory = path.join(appRoot, 'docs', 'validation');
  await mkdir(validationDirectory, { recursive: true });
  await writeFile(path.join(validationDirectory, 'packaged-runtime.json'), `${JSON.stringify({
    ...evidence,
    shutdownNoOrphans: true,
    temporaryUserDataDeleted: true,
    temporaryProjectDeleted: true
  }, null, 2)}\n`, 'utf8');
});
