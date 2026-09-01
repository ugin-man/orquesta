import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { dispatchActionFingerprintForSend } from './desktop-codex-service';
import { MessageLedger, messageLedgerLockPath } from './message-ledger-v2';

async function runWorker(packageRoot: string, rootPath: string, index: number): Promise<void> {
  const vitestEntry = path.resolve(packageRoot, '..', '..', 'node_modules', 'vitest', 'vitest.mjs');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [
      vitestEntry,
      'run',
      'src/core/desktop-codex-message-race.process-worker.test.ts',
      '--pool=forks',
      '--maxWorkers=1'
    ], {
      cwd: packageRoot,
      env: {
        ...process.env,
        ORQUESTA_MESSAGE_RACE_ROOT: rootPath,
        ORQUESTA_MESSAGE_RACE_INDEX: String(index)
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Message race child ${index} failed (${code}): ${stdout}\n${stderr}`));
    });
  });
}

describe('Desktop cross-process exact provider dispatch', () => {
  test('starts one provider turn for one durable message identity', async () => {
    const packageRoot = path.resolve(import.meta.dirname, '..', '..');
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'orquesta-message-race-'));
    try {
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
      const ledger = new MessageLedger();
      await ledger.record({
        rootPath, messageId: input.messageId, actionFingerprint: fingerprint,
        correlationId: input.correlationId, projectId: input.projectId,
        targetAgentId: input.targetAgentId, threadId: null, turnId: null, state: 'queued'
      });
      await ledger.record({
        rootPath, messageId: input.messageId, actionFingerprint: fingerprint,
        correlationId: input.correlationId, projectId: input.projectId,
        targetAgentId: input.targetAgentId, threadId: 'thread-process-proof', turnId: null, state: 'thread_ready'
      });

      await Promise.all([runWorker(packageRoot, rootPath, 0), runWorker(packageRoot, rootPath, 1)]);
      const results = await Promise.all([0, 1].map(async (index) => (
        JSON.parse(await readFile(path.join(rootPath, `worker-${index}.result.json`), 'utf8'))
      )));
      expect(results.reduce((total, result) => total + result.start_calls, 0)).toBe(1);
      expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
      await expect(new MessageLedger().read({ rootPath, messageId: input.messageId })).resolves.toMatchObject({
        state: 'dispatch_accepted',
        thread_id: 'thread-process-proof',
        turn_id: 'turn-process-proof'
      });
      await expect(access(messageLedgerLockPath(rootPath, input.messageId))).rejects.toMatchObject({ code: 'ENOENT' });
      const stateEntries = await readdir(path.join(rootPath, '.orquesta', 'state'), { recursive: true });
      expect(stateEntries.some((entry) => String(entry).includes('.candidate-') || String(entry).endsWith('.lock'))).toBe(false);
      const runtimeEntries = await readdir(path.join(rootPath, '.orquesta', 'runtime', 'message-ledger-v1'), { recursive: true });
      expect(runtimeEntries.some((entry) => {
        const name = String(entry);
        return name.includes('.candidate-') || name.includes('.recovery-') || name.endsWith('.lock');
      })).toBe(false);
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  }, 30_000);
});
