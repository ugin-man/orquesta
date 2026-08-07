import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import {
  ConversationProjectionStore,
  conversationProjectionPaths
} from './conversation-projection-store';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function jsonl(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function user(id: string, timestamp: string, text: string, image = false): string {
  return jsonl({
    timestamp,
    type: 'response_item',
    payload: {
      type: 'message', id, role: 'user',
      content: [
        { type: 'input_text', text },
        { type: 'input_text', text: '# AGENTS.md instructions\ninternal context' },
        ...(image ? [{ type: 'input_image', image_url: `data:image/png;base64,${'a'.repeat(20_000)}` }] : [])
      ]
    }
  });
}

function assistant(id: string, timestamp: string, phase: 'commentary' | 'final_answer', text: string): string {
  return jsonl({
    timestamp,
    type: 'response_item',
    payload: {
      type: 'message', id, role: 'assistant', phase,
      content: [{ type: 'output_text', text }]
    }
  });
}

async function fixture(): Promise<{ source: string; storage: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'orquesta-conversation-projection-'));
  roots.push(root);
  return { source: path.join(root, 'rollout.jsonl'), storage: path.join(root, 'desktop-data') };
}

describe('ConversationProjectionStore', () => {
  test('extracts only user text and final answers without embedded images or work records', async () => {
    const { source, storage } = await fixture();
    await writeFile(source, [
      user('user-1', '2026-08-03T00:00:00.000Z', '<orquesta_target agent_id="worker">\n依頼本文\n</orquesta_target>', true),
      jsonl({ timestamp: '2026-08-03T00:00:01.000Z', type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'secret-reasoning' } }),
      jsonl({ timestamp: '2026-08-03T00:00:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', output: 'large tool output' } }),
      assistant('comment-1', '2026-08-03T00:00:03.000Z', 'commentary', '途中の説明'),
      assistant('agent-1', '2026-08-03T00:00:04.000Z', 'final_answer', '最終回答')
    ].join(''), 'utf8');
    const store = new ConversationProjectionStore({
      storageRoot: storage,
      resolveRolloutPath: async () => source
    });

    const page = await store.listPage({ threadId: 'thread-1', targetAgentId: 'worker', cursor: null, limit: 40 });

    expect(page).toEqual({
      items: [
        expect.objectContaining({ id: 'user-1', role: 'user', text: '依頼本文', targetAgentId: 'worker' }),
        expect.objectContaining({ id: 'agent-1', role: 'agent', text: '最終回答', targetAgentId: 'worker' })
      ],
      nextCursor: null
    });
    const persisted = await readFile(conversationProjectionPaths(storage, 'thread-1').messages, 'utf8');
    expect(persisted).not.toContain('data:image');
    expect(persisted).not.toContain('secret-reasoning');
    expect(persisted).not.toContain('large tool output');
    expect(persisted).not.toContain('途中の説明');
  });

  test('reads only newly appended rollout bytes and keeps projection records idempotent', async () => {
    const { source, storage } = await fixture();
    await writeFile(source, [
      user('user-1', '2026-08-03T00:00:00.000Z', '最初の依頼'),
      assistant('agent-1', '2026-08-03T00:00:01.000Z', 'final_answer', '最初の回答')
    ].join(''), 'utf8');
    const scans: Array<{ startOffset: number; endOffset: number }> = [];
    const store = new ConversationProjectionStore({
      storageRoot: storage,
      resolveRolloutPath: async () => source,
      onScan: (event) => scans.push(event)
    });

    await store.listPage({ threadId: 'thread-2', targetAgentId: 'orchestrator', cursor: null, limit: 40 });
    const firstSize = Buffer.byteLength(await readFile(source, 'utf8'));
    await appendFile(source, [
      user('user-2', '2026-08-03T00:00:02.000Z', '追加の依頼'),
      assistant('agent-2', '2026-08-03T00:00:03.000Z', 'final_answer', '追加の回答')
    ].join(''), 'utf8');
    const page = await store.listPage({ threadId: 'thread-2', targetAgentId: 'orchestrator', cursor: null, limit: 40 });
    await store.listPage({ threadId: 'thread-2', targetAgentId: 'orchestrator', cursor: null, limit: 40 });

    expect(page?.items.map((item) => item.id)).toEqual(['user-1', 'agent-1', 'user-2', 'agent-2']);
    expect(scans).toEqual([
      expect.objectContaining({ startOffset: 0, endOffset: firstSize }),
      expect.objectContaining({ startOffset: firstSize })
    ]);
    const persisted = (await readFile(conversationProjectionPaths(storage, 'thread-2').messages, 'utf8')).trim().split(/\r?\n/u);
    expect(persisted).toHaveLength(4);
  });

  test('pages the light projection without rescanning unchanged history', async () => {
    const { source, storage } = await fixture();
    await writeFile(source, [
      user('user-1', '2026-08-03T00:00:00.000Z', '一'),
      assistant('agent-1', '2026-08-03T00:00:01.000Z', 'final_answer', '二'),
      user('user-2', '2026-08-03T00:00:02.000Z', '三'),
      assistant('agent-2', '2026-08-03T00:00:03.000Z', 'final_answer', '四'),
      user('user-3', '2026-08-03T00:00:04.000Z', '五')
    ].join(''), 'utf8');
    let resolutions = 0;
    let scans = 0;
    const store = new ConversationProjectionStore({
      storageRoot: storage,
      resolveRolloutPath: async () => { resolutions += 1; return source; },
      onScan: () => { scans += 1; }
    });

    const newest = await store.listPage({ threadId: 'thread-3', targetAgentId: 'orchestrator', cursor: null, limit: 2 });
    const older = await store.listPage({ threadId: 'thread-3', targetAgentId: 'orchestrator', cursor: newest?.nextCursor, limit: 2 });

    expect(newest?.items.map((item) => item.text)).toEqual(['四', '五']);
    expect(older?.items.map((item) => item.text)).toEqual(['二', '三']);
    expect(older?.nextCursor).not.toBeNull();
    expect(resolutions).toBe(2);
    expect(scans).toBe(1);
  });

  test('continues from the saved byte offset when Codex archives the rollout', async () => {
    const { storage } = await fixture();
    const threadId = 'thread-4';
    const fileName = `rollout-2026-08-03T00-00-00-${threadId}.jsonl`;
    const active = path.join(path.dirname(storage), 'sessions', fileName);
    const archived = path.join(path.dirname(storage), 'archived_sessions', fileName);
    await mkdir(path.dirname(active), { recursive: true });
    await writeFile(active, [
      user('user-1', '2026-08-03T00:00:00.000Z', '移動前'),
      assistant('agent-1', '2026-08-03T00:00:01.000Z', 'final_answer', '回答前')
    ].join(''), 'utf8');
    let source = active;
    const scans: number[] = [];
    const store = new ConversationProjectionStore({
      storageRoot: storage,
      resolveRolloutPath: async () => source,
      onScan: (event) => scans.push(event.startOffset)
    });

    await store.listPage({ threadId, targetAgentId: 'orchestrator', cursor: null, limit: 40 });
    const firstSize = Buffer.byteLength(await readFile(active, 'utf8'));
    await mkdir(path.dirname(archived), { recursive: true });
    await rename(active, archived);
    source = archived;
    await appendFile(archived, [
      user('user-2', '2026-08-03T00:00:02.000Z', '移動後'),
      assistant('agent-2', '2026-08-03T00:00:03.000Z', 'final_answer', '回答後')
    ].join(''), 'utf8');

    const page = await store.listPage({ threadId, targetAgentId: 'orchestrator', cursor: null, limit: 40 });
    expect(scans).toEqual([0, firstSize]);
    expect(page?.items.map((item) => item.text)).toEqual(['移動前', '回答前', '移動後', '回答後']);
  });

  test('returns null when neither a Codex rollout nor a projection exists', async () => {
    const { storage } = await fixture();
    const store = new ConversationProjectionStore({
      storageRoot: storage,
      resolveRolloutPath: async () => null
    });
    await expect(store.listPage({
      threadId: 'thread-missing', targetAgentId: 'orchestrator', cursor: null, limit: 40
    })).resolves.toBeNull();
  });
});
