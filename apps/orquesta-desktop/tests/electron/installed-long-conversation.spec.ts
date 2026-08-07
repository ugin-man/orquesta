import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';

const installedExecutable = process.env.ORQUESTA_PACKAGED_EXE;
const projectRoot = process.env.ORQUESTA_LIVE_PROJECT_ROOT;

interface SessionRecord {
  agent_id?: string;
  thread_id?: string;
  session_generation?: number;
  rotation_state?: string;
  ownership_status?: string;
}

test('loads a superseded large conversation through the installed Desktop projection', async () => {
  test.skip(process.env.ORQUESTA_LIVE_LONG_HISTORY_UAT !== '1', 'Set ORQUESTA_LIVE_LONG_HISTORY_UAT=1 for the explicit live read-only canary.');
  test.skip(!installedExecutable || !projectRoot, 'Set the installed executable and canonical project root.');
  test.setTimeout(120_000);
  await access(installedExecutable!);

  const sessionState = JSON.parse(await readFile(path.join(projectRoot!, '.orquesta', 'state', 'sessions.json'), 'utf8'));
  const sessions: SessionRecord[] = Array.isArray(sessionState) ? sessionState : sessionState.sessions ?? [];
  const coordinatorSessions = sessions
    .filter((session) => session.agent_id === 'orchestrator' && session.thread_id)
    .sort((left, right) => (left.session_generation ?? 1) - (right.session_generation ?? 1));
  const current = coordinatorSessions.find((session) => session.ownership_status === 'owner' && session.rotation_state === 'active');
  const oldest = coordinatorSessions.find((session) => session.ownership_status === 'superseded' && session.rotation_state === 'superseded');
  expect(current?.thread_id).toBeTruthy();
  expect(oldest?.thread_id).toBeTruthy();

  const userData = await mkdtemp(path.join(os.tmpdir(), 'orquesta-installed-long-history-'));
  const desktop = await electron.launch({
    executablePath: installedExecutable!,
    args: [
      `--user-data-dir=${userData}`,
      '--lang=en-US',
      '--orquesta-project', projectRoot!
    ],
    env: {
      ...process.env,
      // This is a read-only installed-app canary, not a request to rebind the
      // temporary Desktop launch to the Codex task running this test.
      CODEX_THREAD_ID: '',
      ORQUESTA_E2E: '1',
      ORQUESTA_E2E_PROJECT_ROOT: projectRoot!
    }
  });

  let evidence: Record<string, unknown> | null = null;
  try {
    const window = await desktop.firstWindow();
    await expect(window.getByRole('application', { name: 'Orquesta Desktop' })).toBeVisible();
    const bridgeProbe = await window.evaluate(async () => {
      try {
        const first = await globalThis.orquestaDesktop.listConversation({ targetAgentId: 'orchestrator', limit: 40 });
        const second = first.nextCursor
          ? await globalThis.orquestaDesktop.listConversation({ targetAgentId: 'orchestrator', cursor: first.nextCursor, limit: 40 })
          : null;
        return {
          error: null,
          firstItems: first.items.length,
          firstCursor: first.nextCursor,
          secondItems: second?.items.length ?? null,
          secondCursor: second?.nextCursor ?? null,
          secondGenerations: second?.items.map((item) => item.sessionGeneration) ?? []
        };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    });
    console.log(`ORQUESTA_LONG_HISTORY_BRIDGE_PROBE=${JSON.stringify(bridgeProbe)}`);
    expect(bridgeProbe.error).toBeNull();
    const historyButton = window.getByRole('button', { name: /Conversation history/u }).first();
    await expect(historyButton).toBeVisible();

    const openStarted = performance.now();
    await historyButton.click();
    const loadOlder = window.getByRole('button', { name: 'Load older messages' });
    await expect(loadOlder).toBeVisible({ timeout: 30_000 });
    const openMs = performance.now() - openStarted;

    const loadDurations: number[] = [];
    const visibleConversationItemCount = async () => (
      await window.locator('.workspace-message, .session-boundary').count()
    );
    let reachedOldestGeneration = false;
    for (let attempt = 0; attempt < 8 && !reachedOldestGeneration; attempt += 1) {
      const beforeCount = await visibleConversationItemCount();
      const started = performance.now();
      await loadOlder.click();
      await expect.poll(visibleConversationItemCount, {
        timeout: 30_000,
        intervals: [100, 250, 500]
      }).toBeGreaterThan(beforeCount);
      await expect(loadOlder).toBeEnabled();
      loadDurations.push(performance.now() - started);
      reachedOldestGeneration = await window
        .getByText('Execution continued in generation 2 while preserving this conversation.')
        .isVisible()
        .catch(() => false);
    }
    expect(reachedOldestGeneration).toBe(true);

    const beforeWarmCount = await visibleConversationItemCount();
    const warmStarted = performance.now();
    await loadOlder.click();
    await expect.poll(visibleConversationItemCount, {
      timeout: 10_000,
      intervals: [50, 100, 250]
    }).toBeGreaterThan(beforeWarmCount);
    await expect(loadOlder).toBeEnabled();
    const warmLoadMs = performance.now() - warmStarted;

    const projectionPath = path.join(userData, 'conversation-history', `${oldest!.thread_id}.jsonl`);
    const projectionIndexPath = path.join(userData, 'conversation-history', `${oldest!.thread_id}.index.json`);
    const projection = await readFile(projectionPath, 'utf8');
    const projectionIndex = JSON.parse(await readFile(projectionIndexPath, 'utf8'));
    const projectionBytes = (await stat(projectionPath)).size;
    expect(projectionIndex.entries.length).toBeGreaterThan(100);
    expect(projectionBytes).toBeLessThan(5 * 1024 * 1024);
    expect(projection).not.toContain('data:image');
    expect(warmLoadMs).toBeLessThan(2_000);

    evidence = {
      measuredAt: new Date().toISOString(),
      installedExecutable,
      projectRoot,
      currentThreadId: current!.thread_id,
      oldestThreadId: oldest!.thread_id,
      openMs: Number(openMs.toFixed(1)),
      olderPageDurationsMs: loadDurations.map((value) => Number(value.toFixed(1))),
      warmLoadMs: Number(warmLoadMs.toFixed(1)),
      projectionRecords: projectionIndex.entries.length,
      projectionBytes,
      imagePayloadExcluded: true,
      sentCodexTurn: false
    };
  } finally {
    await desktop.close();
    await rm(userData, { recursive: true, force: true });
  }

  if (!evidence) throw new Error('Installed long-conversation evidence was not captured');
  console.log(`ORQUESTA_LIVE_LONG_HISTORY_UAT_EVIDENCE=${JSON.stringify(evidence)}`);
});
