import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';

const execFileAsync = promisify(execFile);
const installedExecutable = process.env.ORQUESTA_PACKAGED_EXE;
const projectRoot = process.env.ORQUESTA_LIVE_PROJECT_ROOT;
const targetAgentId = process.env.ORQUESTA_LIVE_AGENT_ID ?? 'testing-001';
const marker = process.env.ORQUESTA_LIVE_MARKER;
const acknowledgement = process.env.ORQUESTA_LIVE_ACK;

interface CanonicalSession {
  agent_id?: string;
  session_id?: string;
  thread_id?: string;
  ownership_status?: string;
  rotation_state?: string;
  accepts_new_work?: boolean;
}

async function readSessions(): Promise<CanonicalSession[]> {
  const parsed = JSON.parse(await readFile(path.join(projectRoot!, '.orquesta', 'state', 'sessions.json'), 'utf8'));
  return Array.isArray(parsed) ? parsed : parsed.sessions ?? [];
}

function activeOwners(sessions: CanonicalSession[]): CanonicalSession[] {
  return sessions.filter((session) => session.agent_id === targetAgentId
    && session.ownership_status === 'owner'
    && session.rotation_state === 'active'
    && session.accepts_new_work === true);
}

async function processIdsForExecutable(executablePath: string): Promise<number[]> {
  const escaped = executablePath.replace(/'/g, "''");
  const command = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '${escaped}' } | ForEach-Object { $_.ProcessId }) | ConvertTo-Json -Compress`;
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    windowsHide: true
  });
  const parsed = JSON.parse(stdout.trim() || '[]');
  return (Array.isArray(parsed) ? parsed : [parsed]).filter((value): value is number => Number.isInteger(value));
}

test('uses one host-created Codex task for installed Desktop history and messaging without creating another owner', async () => {
  test.skip(process.env.ORQUESTA_LIVE_HOST_UAT !== '1', 'Set ORQUESTA_LIVE_HOST_UAT=1 for the explicit live canary.');
  test.skip(!installedExecutable || !projectRoot, 'Set the installed executable and canonical project root.');
  test.skip(!marker || !acknowledgement, 'Set unique ORQUESTA_LIVE_MARKER and ORQUESTA_LIVE_ACK values.');
  test.setTimeout(300_000);

  const sessionsBefore = await readSessions();
  const ownersBefore = activeOwners(sessionsBefore);
  expect(ownersBefore).toHaveLength(1);
  const ownerBefore = ownersBefore[0];
  expect(ownerBefore.thread_id).toBeTruthy();

  const userData = await mkdtemp(path.join(os.tmpdir(), 'orquesta-host-bound-live-'));
  const desktop = await electron.launch({
    executablePath: installedExecutable!,
    args: [
      `--user-data-dir=${userData}`,
      '--lang=en-US',
      '--orquesta-project', projectRoot!,
      '--orquesta-calling-thread', ownerBefore.thread_id!,
      ...(process.env.ORQUESTA_LIVE_LEGACY_MIGRATION === '1' ? ['--orquesta-migrate-legacy-runtime'] : [])
    ],
    env: {
      ...process.env,
      ORQUESTA_E2E: '1',
      ORQUESTA_E2E_PROJECT_ROOT: projectRoot!
    }
  });

  let evidence: Record<string, unknown> | null = null;
  try {
    const window = await desktop.firstWindow();
    await expect(window.getByRole('application', { name: 'Orquesta Desktop' })).toBeVisible();

    await expect.poll(async () => {
      try {
        const binding = JSON.parse(await readFile(path.join(projectRoot!, '.orquesta', 'state', 'runtime-binding.json'), 'utf8'));
        return {
          mode: binding.mode,
          callingThreadId: binding.calling_thread_id,
          projectIdPresent: typeof binding.project_id === 'string' && binding.project_id.length > 0
        };
      } catch {
        return null;
      }
    }).toEqual({ mode: 'codex_hosted', callingThreadId: ownerBefore.thread_id, projectIdPresent: true });

    const historyBefore = await window.evaluate(async ({ targetAgentId }) => (
      globalThis.orquestaDesktop.listConversation({ targetAgentId, limit: 40 })
    ), { targetAgentId });
    expect(historyBefore.items.some((item) => item.role === 'user')).toBe(true);
    expect(historyBefore.items.some((item) => item.role === 'agent')).toBe(true);
    expect(historyBefore.items.some((item) => item.threadId === ownerBefore.thread_id)).toBe(true);
    expect(historyBefore.items.some((item) => item.text.includes(marker!))).toBe(false);

    const sendResult = await window.evaluate(async ({ targetAgentId, marker, acknowledgement }) => (
      globalThis.orquestaDesktop.sendMessage({
        targetAgentId,
        text: `[HOST UAT] ${marker}. Reply with exactly ${acknowledgement}. Do not edit files or use tools.`,
        attachmentIds: [],
        selectedContextIds: []
      })
    ), { targetAgentId, marker: marker!, acknowledgement: acknowledgement! });
    expect(sendResult.status).toBe('accepted');

    let historyAfter = historyBefore;
    await expect.poll(async () => {
      historyAfter = await window.evaluate(async ({ targetAgentId }) => (
        globalThis.orquestaDesktop.listConversation({ targetAgentId, limit: 40 })
      ), { targetAgentId });
      return {
        userMarker: historyAfter.items.some((item) => item.role === 'user' && item.text.includes(marker!)),
        agentAck: historyAfter.items.some((item) => item.role === 'agent' && item.text.trim() === acknowledgement)
      };
    }, { timeout: 240_000, intervals: [1_000, 2_000, 5_000] }).toEqual({ userMarker: true, agentAck: true });

    const sessionsAfter = await readSessions();
    const ownersAfter = activeOwners(sessionsAfter);
    expect(ownersAfter).toHaveLength(1);
    expect(ownersAfter[0].thread_id).toBe(ownerBefore.thread_id);
    expect(sessionsAfter).toHaveLength(sessionsBefore.length);

    evidence = {
      measuredAt: new Date().toISOString(),
      installedExecutable,
      projectRoot,
      targetAgentId,
      ownerThreadId: ownerBefore.thread_id,
      initialHostHistoryLoaded: true,
      desktopMessagePersisted: true,
      hostAcknowledgementPersisted: true,
      activeOwnerCountBefore: ownersBefore.length,
      activeOwnerCountAfter: ownersAfter.length,
      canonicalSessionCountBefore: sessionsBefore.length,
      canonicalSessionCountAfter: sessionsAfter.length,
      marker,
      acknowledgement,
      sendResult
    };
  } finally {
    await desktop.close();
    await rm(userData, { recursive: true, force: true });
  }

  await expect.poll(() => processIdsForExecutable(installedExecutable!), { timeout: 15_000 }).toEqual([]);
  if (!evidence) throw new Error('Live host-bound evidence was not captured');
  console.log(`ORQUESTA_LIVE_HOST_UAT_EVIDENCE=${JSON.stringify({ ...evidence, shutdownNoInstalledShellOrphans: true })}`);
});
