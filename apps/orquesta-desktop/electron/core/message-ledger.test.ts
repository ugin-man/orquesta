import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

import { MessageLedger, messageLedgerPath } from './message-ledger';

describe('MessageLedger', () => {
  test('persists monotonic delivery evidence without message bodies', async () => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'orquesta-message-ledger-'));
    const ledger = new MessageLedger({ now: () => new Date('2026-08-02T00:00:00.000Z') });
    const base = {
      rootPath,
      messageId: 'message-1',
      correlationId: 'message-1',
      projectId: 'project-1',
      targetAgentId: 'orchestrator',
      threadId: 'thread-1',
      turnId: 'turn-1'
    };

    await expect(ledger.record({ ...base, state: 'queued' })).resolves.toBe(true);
    await expect(ledger.record({ ...base, state: 'turn_started' })).resolves.toBe(true);
    await expect(ledger.record({ ...base, state: 'dispatch_accepted' })).resolves.toBe(false);
    await expect(ledger.record({ ...base, state: 'completed' })).resolves.toBe(true);
    await expect(ledger.record({ ...base, state: 'failed', errorCode: 'late_failure' })).resolves.toBe(false);

    const records = (await readFile(messageLedgerPath(rootPath), 'utf8')).trim().split(/\r?\n/u).map((line) => JSON.parse(line));
    expect(records.map((record) => record.state)).toEqual(['queued', 'turn_started', 'completed']);
    expect(JSON.stringify(records)).not.toContain('prompt');
    expect(JSON.stringify(records)).not.toContain('message body');
  });

  test('rehydrates terminal state and ignores duplicate completion after restart', async () => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'orquesta-message-ledger-restart-'));
    const input = {
      rootPath,
      messageId: 'message-2',
      correlationId: 'message-2',
      projectId: 'project-1',
      targetAgentId: 'worker',
      threadId: 'thread-2',
      turnId: 'turn-2',
      state: 'completed' as const
    };
    await new MessageLedger().record(input);
    await expect(new MessageLedger().record(input)).resolves.toBe(false);
    const records = (await readFile(messageLedgerPath(rootPath), 'utf8')).trim().split(/\r?\n/u);
    expect(records).toHaveLength(1);
  });
});
