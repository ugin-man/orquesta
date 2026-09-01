import { access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from 'vitest';
import {
  DesktopCodexService,
  dispatchActionFingerprintForSend,
  type CanonicalCodexAdapter
} from './desktop-codex-service';
import { MessageLedger } from './message-ledger-v2';

const rootPath = process.env.ORQUESTA_MESSAGE_RACE_ROOT;
const workerIndex = process.env.ORQUESTA_MESSAGE_RACE_INDEX;

if (!rootPath || !workerIndex) {
  test.skip('cross-process Desktop dispatch worker requires an explicit parent fixture', () => {});
} else {
  test('starts or observes one exact shared dispatch', async () => {
    const readyPath = path.join(rootPath, `worker-${workerIndex}.ready`);
    const otherReadyPath = path.join(rootPath, `worker-${workerIndex === '0' ? '1' : '0'}.ready`);
    const resultPath = path.join(rootPath, `worker-${workerIndex}.result.json`);
    await writeFile(readyPath, 'ready\n', 'utf8');
    for (let attempt = 0; attempt < 400; attempt += 1) {
      try {
        await access(otherReadyPath);
        break;
      } catch {
        if (attempt === 399) throw new Error('cross_process_barrier_timeout');
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    let startCalls = 0;
    const adapter: CanonicalCodexAdapter = {
      createThread: async () => { throw new Error('unexpected_create_thread'); },
      resumeThread: async (input) => ({
        ok: true,
        thread_id: input.threadId,
        runtime_profile: {
          cwd: (input.params as { cwd?: unknown } | undefined)?.cwd ?? null,
          runtime_workspace_roots: (input.params as { runtimeWorkspaceRoots?: unknown } | undefined)?.runtimeWorkspaceRoots ?? null,
          instruction_sources: []
        }
      }),
      setThreadName: async (input) => ({ ok: true, thread_id: input.threadId }),
      startTurn: async (input) => {
        startCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 75));
        return { ok: true, thread_id: input.threadId, turn_id: 'turn-process-proof' };
      },
      interruptTurn: async () => ({ ok: true }),
      readThread: async (input) => ({ ok: true, thread_id: input.threadId, thread: { id: input.threadId, turns: [] } }),
      runtimeInfo: async () => ({ ok: true, provider_connection_id: 'provider-process-proof' }),
      respondToApproval: async () => ({ ok: true }),
      shutdown: async () => ({ ok: true }),
      subscribeEvents: async () => ({ ok: true, subscription: { unsubscribe: () => undefined } })
    };
    const input = {
      correlationId: 'corr-process-proof',
      messageId: 'message-process-proof',
      projectId: 'repo-process-proof',
      rootPath,
      threadId: null,
      targetAgentId: 'implementation-process-proof',
      text: 'Start exactly one provider turn.',
      attachments: [],
      recommendedModel: null,
      requestedModel: null
    };
    const fingerprint = await dispatchActionFingerprintForSend(input);
    let status = 'fulfilled';
    let errorCode: string | null = null;
    try {
      const result = await new DesktopCodexService({ adapter, messageLedger: new MessageLedger() }).sendMessage(input);
      expect(result.threadId).toBe('thread-process-proof');
    } catch (error) {
      status = 'rejected';
      errorCode = String((error as { code?: unknown })?.code ?? (error as Error).message);
      expect(errorCode).toBe('dispatch_outcome_unknown');
    }
    await writeFile(resultPath, `${JSON.stringify({
      worker: Number(workerIndex),
      status,
      error_code: errorCode,
      start_calls: startCalls,
      fingerprint
    })}\n`, 'utf8');
  });
}
