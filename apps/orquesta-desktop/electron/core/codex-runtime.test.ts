import { describe, expect, test, vi } from 'vitest';
import { CodexRuntime, type AppServerRpc } from './codex-runtime';

function rpc(responses: Record<string, unknown>): AppServerRpc {
  return {
    start: vi.fn(async () => undefined),
    request: vi.fn(async (method: string) => responses[method]),
    subscribe: vi.fn(() => () => undefined),
    stop: vi.fn(async () => undefined)
  };
}

describe('CodexRuntime', () => {
  test('starts one project coordinator thread and accepts a turn only after app-server does', async () => {
    const client = rpc({
      'thread/start': { thread: { id: 'thread-1' }, model: 'gpt-current' },
      'turn/start': { turn: { id: 'turn-1', status: 'inProgress' } }
    });
    const runtime = new CodexRuntime(client);

    await expect(runtime.sendMessage({
      projectId: 'repo-1', rootPath: 'C:\\repo', threadId: null, targetAgentId: 'orchestrator', text: 'Continue the work.', localImagePaths: ['C:\\images\\map.png']
    })).resolves.toEqual({ threadId: 'thread-1', turnId: 'turn-1', actualModel: 'gpt-current' });

    expect(client.request).toHaveBeenNthCalledWith(1, 'thread/start', expect.objectContaining({
      cwd: 'C:\\repo', approvalPolicy: 'never', sandbox: 'workspace-write'
    }));
    expect(client.request).toHaveBeenNthCalledWith(2, 'turn/start', {
      threadId: 'thread-1',
      input: [
        { type: 'text', text: 'Continue the work.', text_elements: [] },
        { type: 'localImage', path: 'C:\\images\\map.png' }
      ]
    });
  });

  test('resumes the saved thread and preserves target routing metadata', async () => {
    const client = rpc({
      'thread/resume': { thread: { id: 'thread-1' }, model: 'gpt-current' },
      'turn/start': { turn: { id: 'turn-2', status: 'inProgress' } }
    });
    const runtime = new CodexRuntime(client);

    await runtime.sendMessage({ projectId: 'repo-1', rootPath: 'C:\\repo', threadId: 'thread-1', targetAgentId: 'reviewer', text: 'Review this.', localImagePaths: [] });

    expect(client.request).toHaveBeenNthCalledWith(1, 'thread/resume', expect.objectContaining({ threadId: 'thread-1', cwd: 'C:\\repo' }));
    expect(client.request).toHaveBeenNthCalledWith(2, 'turn/start', expect.objectContaining({
      input: [{ type: 'text', text: '<orquesta_target agent_id="reviewer">\nReview this.\n</orquesta_target>', text_elements: [] }]
    }));
  });

  test('projects user and agent items from thread history without exposing routing wrappers', async () => {
    const client = rpc({
      'thread/read': { thread: { turns: [{ id: 'turn-1', startedAt: 1_721_300_000, completedAt: 1_721_300_030, items: [
        { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: '<orquesta_target agent_id="reviewer">\nReview this.\n</orquesta_target>' }] },
        { type: 'agentMessage', id: 'a1', text: 'Done.', phase: 'final_answer' }
      ] }] } }
    });
    const runtime = new CodexRuntime(client);

    await expect(runtime.listConversation({ threadId: 'thread-1', targetAgentId: 'reviewer', limit: 20 })).resolves.toEqual({
      items: [
        expect.objectContaining({ id: 'u1', role: 'user', targetAgentId: 'reviewer', text: 'Review this.' }),
        expect.objectContaining({ id: 'a1', role: 'agent', targetAgentId: 'reviewer', text: 'Done.' })
      ],
      nextCursor: null
    });
  });
});
