import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { MessageLedger, messageLedgerPath } from '../src/core/message-ledger-v2';

const MESSAGE_ID = 'message-scale-target';
const WRITE_BATCH_SIZE = 250;

export async function verifyTargetIgnoresMalformedSiblings(artifactCount: number): Promise<void> {
  assert.equal(Number.isSafeInteger(artifactCount) && artifactCount > 0, true);
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'orquesta-message-ledger-v2-scale-'));
  const input = {
    rootPath,
    messageId: MESSAGE_ID,
    actionFingerprint: 'a'.repeat(64),
    correlationId: MESSAGE_ID,
    projectId: 'project-1',
    targetAgentId: 'orchestrator'
  };

  try {
    const ledger = new MessageLedger();
    await ledger.record({ ...input, threadId: null, turnId: null, state: 'queued' });
    const targetShard = path.dirname(messageLedgerPath(rootPath, input.messageId));
    await mkdir(targetShard, { recursive: true });
    for (let offset = 0; offset < artifactCount; offset += WRITE_BATCH_SIZE) {
      const batchSize = Math.min(WRITE_BATCH_SIZE, artifactCount - offset);
      await Promise.all(Array.from({ length: batchSize }, (_, index) => (
        writeFile(path.join(targetShard, `unrelated-${offset + index}.json`), '{malformed-unrelated', 'utf8')
      )));
    }
    assert.equal(await ledger.record({
      ...input,
      threadId: 'thread-scale-target',
      turnId: null,
      state: 'thread_ready'
    }), true);
    assert.equal((await ledger.read({ rootPath, messageId: input.messageId }))?.state, 'thread_ready');
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
}
