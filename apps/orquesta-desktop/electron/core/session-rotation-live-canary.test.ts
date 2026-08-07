import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { DesktopCodexService } from './desktop-codex-service';
import { ProjectThreadReconciler } from './project-thread-reconciler';
import { SessionRotationController } from './session-rotation-controller';

const liveRoot = process.env.ORQUESTA_LIVE_ROTATION_ROOT?.trim();
const liveAgent = process.env.ORQUESTA_LIVE_ROTATION_AGENT?.trim() || 'testing-001';

async function json(file: string): Promise<any> {
  return JSON.parse(await readFile(file, 'utf8'));
}

describe.skipIf(!liveRoot)('live session rotation canary', () => {
  test('cuts a pending owner over through the real Codex App Server after a verified receipt', async () => {
    const root = path.resolve(liveRoot!);
    const registryPath = path.join(root, '.orquesta', 'state', 'session-rotation.json');
    const before = await json(registryPath);
    const predecessor = Object.values(before.sessions as Record<string, any>).find((entry: any) => (
      entry.agent_id === liveAgent && entry.compaction_count >= 15
      && (entry.ownership_status === 'owner' || entry.rotation_state === 'superseded')
    )) as any;
    expect(predecessor?.compaction_count).toBeGreaterThanOrEqual(15);

    const runtime = new DesktopCodexService({ packaged: false, appRoot: process.cwd() });
    const controller = new SessionRotationController({ runtime });
    const reconciler = new ProjectThreadReconciler({ listProjectThreads: (rootPath) => runtime.listProjectThreads(rootPath) });
    const unsubscribe = runtime.subscribe((notification) => {
      void controller.observe(notification);
    });
    try {
      if (predecessor.rotation_state !== 'superseded') {
        expect(predecessor.rotation_state).toMatch(/rotation_pending|rotation_required/u);
        await controller.open(root, 'orquesta-session-rotation-live-canary');
      }
      const deadline = Date.now() + 180_000;
      let registry: any = before;
      while (Date.now() < deadline) {
        registry = await json(registryPath);
        const old = registry.sessions[predecessor.session_id];
        const successor = Object.values(registry.sessions as Record<string, any>).find((entry: any) => (
          entry.agent_id === liveAgent && entry.session_id !== predecessor.session_id
        )) as any;
        if (old?.rotation_state === 'superseded' || successor?.rotation_state === 'failed') break;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      await reconciler.reconcile(root);
      const old = registry.sessions[predecessor.session_id];
      const successor = Object.values(registry.sessions as Record<string, any>).find((entry: any) => (
        entry.agent_id === liveAgent && entry.session_id !== predecessor.session_id
      )) as any;
      const sessions = await json(path.join(root, '.orquesta', 'state', 'sessions.json'));
      const agents = await json(path.join(root, '.orquesta', 'state', 'agents.json'));
      const report = {
        schema_version: 1,
        status: old?.rotation_state === 'superseded' && successor?.ownership_status === 'owner' ? 'passed' : 'failed',
        agent_id: liveAgent,
        predecessor_session_id: predecessor.session_id,
        predecessor_thread_id: predecessor.thread_id,
        predecessor_compaction_count: predecessor.compaction_count,
        predecessor_final_state: old?.rotation_state ?? null,
        successor_session_id: successor?.session_id ?? null,
        successor_thread_id: successor?.thread_id ?? null,
        successor_generation: successor?.session_generation ?? null,
        successor_state: successor?.rotation_state ?? null,
        successor_ownership: successor?.ownership_status ?? null,
        canonical_session_bound: sessions.sessions?.some((entry: any) => entry.thread_id === successor?.thread_id && entry.ownership_status === 'owner') === true,
        canonical_agent_bound: agents.agents?.some((entry: any) => entry.agent_id === liveAgent && entry.thread_id === successor?.thread_id) === true,
        observed_at: new Date().toISOString(),
      };
      await writeFile(path.join(root, '.orquesta', 'reports', 'session-rotation-live-canary.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      expect(report).toMatchObject({ status: 'passed', successor_generation: predecessor.session_generation + 1, successor_ownership: 'owner', canonical_session_bound: true, canonical_agent_bound: true });
    } finally {
      unsubscribe();
      await runtime.shutdown();
    }
  }, 210_000);
});
