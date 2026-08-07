import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';

import { DesktopCodexService, projectConversation, projectLucaConversation, type CanonicalCodexAdapter } from './desktop-codex-service';

function thread(id: string, routedText = 'Hello', agentText = 'Done.') {
  return {
    id,
    turns: [{
      startedAt: 1,
      completedAt: 2,
      items: [
        { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: routedText }] },
        { id: 'agent-1', type: 'agentMessage', text: agentText }
      ]
    }]
  };
}

function createAdapterDouble() {
  let eventListener: ((event: Record<string, unknown>) => void) | null = null;
  const adapter = {
    createThread: vi.fn(async (input) => ({
      ok: true,
      thread_id: 'thread-new',
      runtime_profile: {
        cwd: input.params?.cwd ?? null,
        sandbox: input.params?.sandbox ?? 'workspace-write',
        approval_policy: input.params?.approvalPolicy ?? 'on-request',
        requested_web_search_mode: input.params?.webSearchMode ?? null
      },
      model_evidence: {
        recommended_model: input.recommendedModel ?? null,
        requested_model: input.requestedModel ?? null,
        applied_model: input.params?.model ?? null,
        actual_model: null
      }
    })),
    resumeThread: vi.fn(async (input) => ({
      ok: true,
      thread_id: input.threadId,
      runtime_profile: {
        cwd: input.params?.cwd ?? null,
        sandbox: input.params?.sandbox ?? 'workspace-write',
        approval_policy: input.params?.approvalPolicy ?? 'on-request',
        requested_web_search_mode: input.params?.webSearchMode ?? null
      },
      model_evidence: {
        recommended_model: input.recommendedModel ?? null,
        requested_model: input.requestedModel ?? null,
        applied_model: input.params?.model ?? null,
        actual_model: null
      }
    })),
    setThreadName: vi.fn(async (input) => ({
      ok: true,
      thread_id: input.threadId,
      name: input.name
    })),
    listThreads: vi.fn(async (input) => ({
      ok: true,
      threads: input.params.archived
        ? [{
            id: 'thread-archived',
            cwd: input.params.cwd,
            name: 'Old worker',
            status: { type: 'idle' },
            updatedAt: 1_785_283_100
          }]
        : [{
            id: 'thread-live',
            cwd: input.params.cwd,
            name: 'Current worker',
            status: { type: 'active', activeFlags: [] },
            updatedAt: 1_785_283_200
          }],
      next_cursor: null
    })),
    startTurn: vi.fn(async (input) => ({ ok: true, thread_id: input.threadId, turn_id: 'turn-1' })),
    interruptTurn: vi.fn(async (input) => ({ ok: true, thread_id: input.threadId, turn_id: input.turnId })),
    readThread: vi.fn(async (input) => ({ ok: true, thread_id: input.threadId, thread: thread(input.threadId) })),
    listThreadTurns: vi.fn(async (input) => ({
      ok: true,
      thread_id: input.threadId,
      turns: [...thread(input.threadId).turns].reverse(),
      next_cursor: null,
      backwards_cursor: null
    })),
    runtimeInfo: vi.fn(async ({ probe }) => ({
      ok: true,
      sdk_version: '0.144.5',
      codex_version: '0.144.5',
      runtime_package_version: '0.144.5-win32-x64',
      target_triple: 'x86_64-pc-windows-msvc',
      platform_family: probe ? 'windows' : null,
      platform_os: probe ? 'windows' : null,
      user_agent: probe ? 'codex-cli/0.144.5' : null
    })),
    readAccount: vi.fn(async () => ({
      ok: true,
      account_type: 'chatgpt',
      requires_openai_auth: true
    })),
    startLogin: vi.fn(async () => ({
      ok: true,
      login_type: 'chatgpt',
      login_id: 'login-1',
      auth_url: 'https://auth.openai.com/authorize'
    })),
    respondToApproval: vi.fn(async (input) => ({
      ok: true, thread_id: input.threadId, turn_id: input.turnId, approval_id: input.requestId
    })),
    shutdown: vi.fn(async () => ({ ok: true, status: 'completed' })),
    subscribeEvents: vi.fn(async ({ listener }) => {
      eventListener = listener;
      return { ok: true, subscription: { unsubscribe: vi.fn() } };
    })
  } as unknown as CanonicalCodexAdapter;
  return {
    adapter,
    emit(event: Record<string, unknown>) {
      if (!eventListener) throw new Error('service did not subscribe to adapter events');
      eventListener(event);
    }
  };
}

describe('DesktopCodexService', () => {
  test('lists active and archived Codex threads for the exact project cwd', async () => {
    const double = createAdapterDouble();
    const service = new DesktopCodexService({ adapter: double.adapter });

    await expect(service.listProjectThreads('C:\\repo')).resolves.toEqual([
      expect.objectContaining({ id: 'thread-live', cwd: 'C:\\repo', archived: false, status: 'active' }),
      expect.objectContaining({ id: 'thread-archived', cwd: 'C:\\repo', archived: true, status: 'idle' })
    ]);
    expect(double.adapter.listThreads).toHaveBeenCalledTimes(2);
    expect(double.adapter.listThreads).toHaveBeenNthCalledWith(1, expect.objectContaining({
      params: expect.objectContaining({ cwd: 'C:\\repo', archived: false, limit: 100, useStateDbOnly: true })
    }));
    expect(double.adapter.listThreads).toHaveBeenNthCalledWith(2, expect.objectContaining({
      params: expect.objectContaining({ cwd: 'C:\\repo', archived: true, limit: 100, useStateDbOnly: true })
    }));
  });

  test('projects App Server account state without exposing account details', async () => {
    const double = createAdapterDouble();
    const service = new DesktopCodexService({ adapter: double.adapter });

    await expect(service.readAccount()).resolves.toEqual({
      status: 'authenticated', accountType: 'chatgpt', requiresOpenaiAuth: true
    });
    await expect(service.startChatGptLogin()).resolves.toEqual({
      type: 'chatgpt', loginId: 'login-1', authUrl: 'https://auth.openai.com/authorize'
    });
    expect(double.adapter.readAccount).toHaveBeenCalledWith({ correlationId: expect.any(String) });
    expect(double.adapter.startLogin).toHaveBeenCalledWith({ correlationId: expect.any(String), loginType: 'chatgpt' });
  });

  test('routes Luca through the same persistent-agent transport and existing thread', async () => {
    const double = createAdapterDouble();
    const service = new DesktopCodexService({ adapter: double.adapter });

    const result = await service.sendLucaQuestion({
      correlationId: 'corr-luca', projectId: 'repo-1', rootPath: 'C:\\repo', threadId: 'thread-luca',
      prompt: '{"protocol":"orquesta.luca.ask.v1"}'
    });

    expect(double.adapter.resumeThread).toHaveBeenCalledWith({
      correlationId: 'corr-luca:thread',
      threadId: 'thread-luca',
      recommendedModel: null,
      requestedModel: null,
      params: { cwd: 'C:\\repo', excludeTurns: true }
    });
    expect(double.adapter.startTurn).toHaveBeenCalledWith({
      correlationId: 'corr-luca', threadId: 'thread-luca',
      input: [{
        type: 'text',
        text: '<orquesta_target agent_id="orquesta-admin">\n{"protocol":"orquesta.luca.ask.v1"}\n</orquesta_target>',
        text_elements: []
      }]
    });
    expect(double.adapter.createThread).not.toHaveBeenCalled();
    expect(result).toMatchObject({ threadId: 'thread-luca', turnId: 'turn-1' });
  });

  test('projects internal Luca envelopes as visible conversation text', () => {
    const messages = projectLucaConversation({
      turns: [{
        startedAt: 1, completedAt: 2,
        items: [
          {
            id: 'user-luca', type: 'userMessage',
            content: [{ type: 'text', text: JSON.stringify({
              protocol: 'orquesta.luca.ask.v1', request: { displayQuestion: 'このタスクを簡単に説明して' }
            }) }]
          },
          {
            id: 'agent-luca', type: 'agentMessage', text: JSON.stringify({
              answer: '画面を直すタスクです。', points: [], uncertainties: [], references: []
            })
          }
        ]
      }]
    }, new Date('2026-07-22T00:00:00.000Z'));

    expect(messages.map((message) => message.text)).toEqual([
      'このタスクを簡単に説明して',
      '画面を直すタスクです。'
    ]);
    expect(messages.every((message) => message.targetAgentId === 'orquesta-admin')).toBe(true);
  });

  test('starts external inspection in a fresh read-only thread with live Web search', async () => {
    const double = createAdapterDouble();
    const service = new DesktopCodexService({ adapter: double.adapter });

    await expect(service.startInspection({
      correlationId: 'inspect-external',
      projectId: 'repo-1',
      rootPath: 'C:\\repo',
      kind: 'external_benchmark',
      prompt: 'Inspect the project.'
    })).resolves.toEqual({
      threadId: 'thread-new',
      turnId: 'turn-1',
      runtimeBoundary: {
        sandbox: 'read-only', approvalPolicy: 'never', webSearchMode: 'live'
      }
    });
    expect(double.adapter.createThread).toHaveBeenCalledWith({
      correlationId: 'inspect-external:thread',
      params: {
        cwd: 'C:\\repo', sandbox: 'read-only', approvalPolicy: 'never', webSearchMode: 'live'
      }
    });
    expect(double.adapter.resumeThread).not.toHaveBeenCalled();
    expect(double.adapter.startTurn).toHaveBeenCalledWith({
      correlationId: 'inspect-external',
      threadId: 'thread-new',
      input: [{ type: 'text', text: 'Inspect the project.', text_elements: [] }]
    });
  });

  test('starts adversarial inspection with Web search disabled', async () => {
    const double = createAdapterDouble();
    const service = new DesktopCodexService({ adapter: double.adapter });

    await service.startInspection({
      correlationId: 'inspect-audit', projectId: 'repo-1', rootPath: 'C:\\repo',
      kind: 'adversarial_audit', prompt: 'Audit the project.'
    });

    expect(double.adapter.createThread).toHaveBeenCalledWith(expect.objectContaining({
      params: expect.objectContaining({ webSearchMode: 'disabled' })
    }));
  });

  test('rejects an inspection runtime profile mismatch before starting the turn', async () => {
    const double = createAdapterDouble();
    double.adapter.createThread.mockResolvedValue({
      ok: true,
      thread_id: 'thread-unsafe',
      runtime_profile: {
        cwd: 'C:\\repo', sandbox: 'workspace-write', approval_policy: 'never', requested_web_search_mode: 'live'
      }
    });
    const service = new DesktopCodexService({ adapter: double.adapter });

    await expect(service.startInspection({
      correlationId: 'inspect-mismatch', projectId: 'repo-1', rootPath: 'C:\\repo',
      kind: 'external_benchmark', prompt: 'Inspect.'
    })).rejects.toThrow('read_only_boundary_violation');
    expect(double.adapter.startTurn).not.toHaveBeenCalled();
  });

  test('interrupts an inspection using its exact thread and turn ids', async () => {
    const double = createAdapterDouble();
    const service = new DesktopCodexService({ adapter: double.adapter });

    await expect(service.interruptInspection({
      correlationId: 'inspect-cancel', threadId: 'thread-9', turnId: 'turn-7'
    })).resolves.toBeUndefined();
    expect(double.adapter.interruptTurn).toHaveBeenCalledWith({
      correlationId: 'inspect-cancel', threadId: 'thread-9', turnId: 'turn-7'
    });
  });

  test('creates a coordinator thread, routes the target privately, and keeps model evidence separate', async () => {
    const double = createAdapterDouble();
    const service = new DesktopCodexService({ adapter: double.adapter });
    const result = await service.sendMessage({
      correlationId: 'corr-send',
      projectId: 'repo-1',
      rootPath: 'C:\\repo',
      threadId: null,
      targetAgentId: 'implementation-002',
      threadTitle: 'Orquesta 実装係 2',
      text: 'Implement the accepted slice.',
      localImagePaths: ['C:\\images\\reference.png'],
      recommendedModel: 'recommended-model',
      requestedModel: 'requested-model',
      effort: 'medium'
    });

    expect(double.adapter.createThread).toHaveBeenCalledWith({
      correlationId: 'corr-send:thread',
      recommendedModel: 'recommended-model',
      requestedModel: 'requested-model',
      params: { cwd: 'C:\\repo', model: 'requested-model' }
    });
    expect(double.adapter.setThreadName).toHaveBeenCalledWith({
      correlationId: 'corr-send:name',
      threadId: 'thread-new',
      name: 'Orquesta 実装係 2'
    });
    expect(double.adapter.startTurn).toHaveBeenCalledWith({
      correlationId: 'corr-send',
      threadId: 'thread-new',
      input: [
        { type: 'text', text: '<orquesta_target agent_id="implementation-002">\nImplement the accepted slice.\n</orquesta_target>', text_elements: [] },
        { type: 'localImage', path: 'C:\\images\\reference.png' }
      ],
      params: { effort: 'medium' }
    });
    const serializedCalls = JSON.stringify([
      double.adapter.createThread.mock.calls,
      double.adapter.startTurn.mock.calls
    ]);
    expect(serializedCalls).not.toContain('approvalPolicy');
    expect(serializedCalls).not.toContain('sandbox');
    expect(result).toEqual({
      threadId: 'thread-new',
      turnId: 'turn-1',
      modelEvidence: {
        recommendedModel: 'recommended-model',
        requestedModel: 'requested-model',
        appliedModel: 'requested-model',
        actualModel: null,
        actualModelEvidence: 'unknown'
      }
    });
  });

  test('records one monotonic delivery lifecycle for a Desktop-originated message', async () => {
    const double = createAdapterDouble();
    const records: Array<Record<string, unknown>> = [];
    const service = new DesktopCodexService({
      adapter: double.adapter,
      messageLedger: { record: vi.fn(async (input) => { records.push({ ...input }); return true; }) }
    });

    await service.sendMessage({
      correlationId: 'message-1', projectId: 'repo-1', rootPath: 'C:\\repo', threadId: 'thread-existing',
      targetAgentId: 'implementation-002', text: 'Continue.', localImagePaths: [], recommendedModel: null, requestedModel: null
    });
    double.emit({
      type: 'turn_started', correlation_id: 'message-1', thread_id: 'thread-existing', turn_id: 'turn-1'
    });
    double.emit({
      type: 'turn_completed', correlation_id: 'message-1', thread_id: 'thread-existing', turn_id: 'turn-1', status: 'completed'
    });
    await vi.waitFor(() => expect(records.map((record) => record.state)).toEqual([
      'queued', 'dispatch_accepted', 'turn_started', 'completed'
    ]));
    expect(records.every((record) => !Object.hasOwn(record, 'text'))).toBe(true);
    expect(records.at(-1)).toMatchObject({
      messageId: 'message-1', targetAgentId: 'implementation-002', threadId: 'thread-existing', turnId: 'turn-1'
    });
  });

  test('attributes raw Codex messages to the specialist that owns the thread', () => {
    const messages = projectConversation(
      thread('thread-specialist', 'Please continue the UI fix.', 'The UI fix is complete.'),
      new Date('2026-07-22T00:00:00.000Z'),
      'implementation-002'
    );

    expect(messages).toEqual([
      expect.objectContaining({
        role: 'user', targetAgentId: 'implementation-002', text: 'Please continue the UI fix.'
      }),
      expect.objectContaining({
        role: 'agent', targetAgentId: 'implementation-002', authorLabel: 'implementation-002'
      })
    ]);
  });

  test('reports the durable thread boundary before starting the first turn', async () => {
    const double = createAdapterDouble();
    const order: string[] = [];
    double.adapter.startTurn.mockImplementation(async (input) => {
      order.push('turn');
      return { ok: true, thread_id: input.threadId, turn_id: 'turn-1' };
    });
    const service = new DesktopCodexService({ adapter: double.adapter });

    await service.sendMessage({
      correlationId: 'corr-foundation',
      projectId: 'repo-1',
      rootPath: 'C:\\repo',
      threadId: null,
      targetAgentId: 'orchestrator',
      text: 'Bootstrap.',
      localImagePaths: [],
      recommendedModel: 'Sol',
      requestedModel: null,
      onThreadReady: async (threadId) => {
        order.push(`thread:${threadId}`);
      }
    });

    expect(order).toEqual(['thread:thread-new', 'turn']);
  });

  test('resumes the saved coordinator thread and never restarts it unnecessarily', async () => {
    const double = createAdapterDouble();
    const service = new DesktopCodexService({ adapter: double.adapter });
    const result = await service.sendMessage({
      correlationId: 'corr-resume', projectId: 'repo-1', rootPath: 'C:\\repo', threadId: 'thread-saved',
      targetAgentId: 'orchestrator', text: 'Continue.', localImagePaths: [], recommendedModel: null, requestedModel: null
    });

    expect(double.adapter.resumeThread).toHaveBeenCalledWith({
      correlationId: 'corr-resume:thread',
      threadId: 'thread-saved',
      recommendedModel: null,
      requestedModel: null,
      params: { cwd: 'C:\\repo', excludeTurns: true }
    });
    expect(double.adapter.createThread).not.toHaveBeenCalled();
    expect(result.threadId).toBe('thread-saved');
  });

  test('reuses a task already loaded in the same App Server process', async () => {
    const double = createAdapterDouble();
    const service = new DesktopCodexService({ adapter: double.adapter });
    const base = {
      projectId: 'repo-1', rootPath: 'C:\\repo', threadId: 'thread-saved',
      targetAgentId: 'orchestrator', localImagePaths: [], recommendedModel: null, requestedModel: null
    };

    await service.sendMessage({ ...base, correlationId: 'corr-first', text: 'First.' });
    await service.sendMessage({ ...base, correlationId: 'corr-second', text: 'Second.' });

    expect(double.adapter.resumeThread).toHaveBeenCalledTimes(1);
    expect(double.adapter.startTurn).toHaveBeenCalledTimes(2);
  });

  test('only model_observed proves the actual model', async () => {
    const double = createAdapterDouble();
    const notifications: Array<Record<string, unknown>> = [];
    const service = new DesktopCodexService({ adapter: double.adapter });
    service.subscribe((notification) => notifications.push(notification));
    await service.sendMessage({
      correlationId: 'corr-model', projectId: 'repo-1', rootPath: 'C:\\repo', threadId: null,
      targetAgentId: 'orchestrator', text: 'Continue.', localImagePaths: [], recommendedModel: null, requestedModel: 'requested-model'
    });

    double.emit({ type: 'progress_observed', correlation_id: 'corr-model', thread_id: 'thread-new', turn_id: 'turn-1', model: 'must-not-count' });
    double.emit({ type: 'turn_started', correlation_id: 'corr-model', thread_id: 'thread-new', turn_id: 'turn-1' });
    await vi.waitFor(() => expect(notifications.at(-1)?.modelEvidence).toMatchObject({ actualModel: null, actualModelEvidence: 'unknown' }));

    double.emit({ type: 'model_observed', correlation_id: 'corr-model', thread_id: 'thread-new', turn_id: 'turn-1', model: 'observed-model' });
    await vi.waitFor(() => expect(notifications.at(-1)).toMatchObject({
        kind: 'model_observed',
        modelEvidence: { actualModel: 'observed-model', actualModelEvidence: 'proven' }
      }));
  });

  test('reads the completed thread before emitting one real agent message and never invents one from progress', async () => {
    const double = createAdapterDouble();
    const notifications: Array<Record<string, unknown>> = [];
    const service = new DesktopCodexService({ adapter: double.adapter, now: () => new Date('2026-07-18T00:00:00.000Z') });
    service.subscribe((notification) => notifications.push(notification));
    await service.sendMessage({
      correlationId: 'corr-turn', projectId: 'repo-1', rootPath: 'C:\\repo', threadId: null,
      targetAgentId: 'implementation-002', text: 'Implement.', localImagePaths: [], recommendedModel: null, requestedModel: null
    });
    double.adapter.readThread.mockResolvedValue({
      ok: true,
      thread_id: 'thread-new',
      thread: thread('thread-new', '<orquesta_target agent_id="implementation-002">\nImplement.\n</orquesta_target>', 'Implemented.')
    });
    double.adapter.listThreadTurns.mockResolvedValue({
      ok: true,
      thread_id: 'thread-new',
      turns: thread('thread-new', '<orquesta_target agent_id="implementation-002">\nImplement.\n</orquesta_target>', 'Implemented.').turns,
      next_cursor: null,
      backwards_cursor: null
    });

    double.emit({ type: 'progress_observed', correlation_id: 'corr-turn', thread_id: 'thread-new', turn_id: 'turn-1', item: { text: 'not a reply' } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(notifications.some((item) => item.kind === 'agent_message')).toBe(false);

    double.emit({ type: 'turn_completed', correlation_id: 'corr-turn', thread_id: 'thread-new', turn_id: 'turn-1' });
    await vi.waitFor(() => expect(notifications.map((item) => item.kind)).toEqual(['agent_message', 'turn_completed']));
    expect(notifications[0]).toMatchObject({ kind: 'agent_message', text: 'Implemented.', targetAgentId: 'implementation-002' });
    expect(double.adapter.readThread).not.toHaveBeenCalled();
    expect(double.adapter.listThreadTurns).toHaveBeenCalledWith(expect.objectContaining({
      threadId: 'thread-new', limit: 1, sortDirection: 'desc', itemsView: 'summary'
    }));

    const page = await service.listConversation({
      correlationId: 'corr-history', threadId: 'thread-new', targetAgentId: 'implementation-002', limit: 20
    });
    expect(page.items.map((item) => item.text)).toEqual(['Implement.', 'Implemented.']);
    expect(JSON.stringify(page)).not.toContain('orquesta_target');
    expect(notifications.map((item) => item.kind)).toEqual(['agent_message', 'turn_completed']);
  });

  test('projects stable server-paged history without loading the full thread', async () => {
    const double = createAdapterDouble();
    double.adapter.listThreadTurns.mockImplementation(async ({ cursor }: { cursor?: string | null }) => ({
      ok: true,
      thread_id: 'thread-history',
      turns: cursor === 'older-turns'
        ? [
          {
            startedAt: 1, completedAt: 2,
            items: [
              { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: '<orquesta_target agent_id="worker">\n最初の指示\n</orquesta_target>' }] },
              { id: 'system-1', type: 'systemMessage', text: 'System checkpoint' },
              { id: 'agent-1', type: 'agentMessage', text: '最初の回答' }
            ]
          }
        ]
        : [
          {
            startedAt: 3, completedAt: 4,
            items: [
              { id: 'user-2', type: 'userMessage', content: [{ type: 'text', text: '<orquesta_target agent_id="worker">\n続けて\n</orquesta_target>' }] },
              { id: 'agent-2', type: 'agentMessage', text: '完了しました' }
            ]
          }
        ],
      next_cursor: cursor === 'older-turns' ? null : 'older-turns',
      backwards_cursor: null
    }));
    const service = new DesktopCodexService({ adapter: double.adapter });

    const newest = await service.listConversation({
      correlationId: 'history-newest', threadId: 'thread-history', targetAgentId: 'worker', cursor: null, limit: 2
    });
    expect(newest).toEqual({
      items: [expect.objectContaining({ id: 'user-2', text: '続けて' }), expect.objectContaining({ id: 'agent-2', text: '完了しました' })],
      nextCursor: 'older-turns'
    });
    const older = await service.listConversation({
      correlationId: 'history-older', threadId: 'thread-history', targetAgentId: 'worker', cursor: newest.nextCursor, limit: 2
    });
    expect(older).toEqual({
      items: [
        expect.objectContaining({ id: 'user-1', text: '最初の指示' }),
        expect.objectContaining({ id: 'system-1', role: 'system' }),
        expect.objectContaining({ id: 'agent-1', text: '最初の回答' })
      ],
      nextCursor: null
    });
    expect(JSON.stringify([newest, older])).not.toContain('orquesta_target');
    expect(Object.hasOwn(newest, 'turns')).toBe(false);
    expect(Object.hasOwn(older, 'turns')).toBe(false);
    expect(double.adapter.readThread).not.toHaveBeenCalled();
    expect(double.adapter.listThreadTurns).toHaveBeenNthCalledWith(1, expect.objectContaining({
      threadId: 'thread-history', cursor: null, limit: 2, sortDirection: 'desc', itemsView: 'summary'
    }));
    await expect(service.listConversation({
      correlationId: 'history-limit', threadId: 'thread-history', targetAgentId: 'worker', cursor: null, limit: 201
    })).rejects.toThrow('limit');
  });

  test('serves projected history without starting an App Server history read', async () => {
    const double = createAdapterDouble();
    const conversationProjection = {
      listPage: vi.fn(async () => ({
        items: [
          {
            id: 'projected-user', role: 'user' as const, text: '軽い履歴を表示して',
            createdAt: '2026-08-03T00:00:00.000Z', targetAgentId: 'worker'
          },
          {
            id: 'projected-agent', role: 'agent' as const, text: '表示しました。',
            createdAt: '2026-08-03T00:00:01.000Z', targetAgentId: 'worker'
          }
        ],
        nextCursor: 'projection:40'
      }))
    };
    const service = new DesktopCodexService({
      adapter: double.adapter,
      conversationProjection,
      now: () => new Date('2026-08-03T00:00:00.000Z')
    });

    await expect(service.listConversation({
      correlationId: 'projected-history', threadId: 'thread-history', targetAgentId: 'worker', cursor: null, limit: 40
    })).resolves.toEqual({
      items: [
        expect.objectContaining({ id: 'projected-user', text: '軽い履歴を表示して' }),
        expect.objectContaining({ id: 'projected-agent', text: '表示しました。' })
      ],
      nextCursor: 'projection:40'
    });
    expect(double.adapter.listThreadTurns).not.toHaveBeenCalled();
    expect(double.adapter.readThread).not.toHaveBeenCalled();
    expect(double.adapter.subscribeEvents).not.toHaveBeenCalled();
  });

  test('reads the projected final answer on completion without another App Server history request', async () => {
    const double = createAdapterDouble();
    const notifications: Array<Record<string, unknown>> = [];
    const conversationProjection = {
      listPage: vi.fn(async () => ({
        items: [{
          id: 'projected-final', role: 'agent' as const, text: '投影から完了を取得しました。',
          createdAt: '2026-08-03T00:00:01.000Z', targetAgentId: 'worker'
        }],
        nextCursor: null
      }))
    };
    const service = new DesktopCodexService({
      adapter: double.adapter,
      conversationProjection,
      now: () => new Date('2026-08-03T00:00:00.000Z')
    });
    service.subscribe((notification) => notifications.push(notification));
    await service.sendMessage({
      correlationId: 'projected-turn', projectId: 'repo-1', rootPath: 'C:\\repo', threadId: 'thread-history',
      targetAgentId: 'worker', text: '続けて', localImagePaths: [], recommendedModel: null, requestedModel: null
    });

    double.emit({
      type: 'turn_completed', correlation_id: 'projected-turn', thread_id: 'thread-history', turn_id: 'turn-1'
    });
    await vi.waitFor(() => expect(notifications.map((item) => item.kind)).toEqual(['agent_message', 'turn_completed']));
    expect(notifications[0]).toMatchObject({ text: '投影から完了を取得しました。', targetAgentId: 'worker' });
    expect(double.adapter.listThreadTurns).not.toHaveBeenCalled();
    expect(double.adapter.readThread).not.toHaveBeenCalled();
  });

  test('projects session generations as separate logical pages with provenance and a boundary', async () => {
    const double = createAdapterDouble();
    double.adapter.listThreadTurns.mockImplementation(async ({ threadId }: { threadId: string }) => ({
      ok: true,
      thread_id: threadId,
      turns: thread(
        threadId,
        `<orquesta_target agent_id="worker">\n${threadId} user\n</orquesta_target>`,
        `${threadId} agent`
      ).turns,
      next_cursor: null
    }));
    const service = new DesktopCodexService({ adapter: double.adapter });

    const newest = await service.listLogicalConversation({
      correlationId: 'history-logical',
      targetAgentId: 'worker',
      generations: [
        {
          sessionId: 'session-old', threadId: 'thread-old', agentId: 'worker', generation: 1,
          rotationState: 'superseded', ownershipStatus: 'superseded', bindingStatus: 'archived', createdAt: null, updatedAt: null
        },
        {
          sessionId: 'session-new', threadId: 'thread-new', agentId: 'worker', generation: 2,
          rotationState: 'active', ownershipStatus: 'owner', bindingStatus: 'bound', createdAt: '2026-07-31T00:00:00.000Z', updatedAt: null
        }
      ],
      cursor: null,
      limit: 10
    });

    expect(newest.nextCursor).toMatch(/^logical:/u);
    expect(newest.items.map((item) => item.kind)).toEqual(['message', 'message']);
    expect(newest.items[0]).toMatchObject({ id: 'thread-new:user-1', threadId: 'thread-new', sessionGeneration: 2 });
    expect(double.adapter.listThreadTurns).toHaveBeenCalledTimes(1);

    const older = await service.listLogicalConversation({
      correlationId: 'history-logical-older',
      targetAgentId: 'worker',
      generations: [
        {
          sessionId: 'session-old', threadId: 'thread-old', agentId: 'worker', generation: 1,
          rotationState: 'superseded', ownershipStatus: 'superseded', bindingStatus: 'archived', createdAt: null, updatedAt: null
        },
        {
          sessionId: 'session-new', threadId: 'thread-new', agentId: 'worker', generation: 2,
          rotationState: 'active', ownershipStatus: 'owner', bindingStatus: 'bound', createdAt: '2026-07-31T00:00:00.000Z', updatedAt: null
        }
      ],
      cursor: newest.nextCursor,
      limit: 10
    });
    expect(older.nextCursor).toBeNull();
    expect(older.items.map((item) => item.kind)).toEqual(['message', 'message', 'session_boundary']);
    expect(older.items[0]).toMatchObject({ id: 'thread-old:user-1', threadId: 'thread-old', sessionGeneration: 1 });
    expect(older.items[2]).toMatchObject({
      sessionBoundary: { fromGeneration: 1, toGeneration: 2 },
      role: 'system'
    });
    expect(double.adapter.listThreadTurns).toHaveBeenCalledTimes(2);
  });

  test('does not read an archived predecessor when a short current generation is below the requested limit', async () => {
    const double = createAdapterDouble();
    double.adapter.listThreadTurns.mockImplementation(async ({ threadId }: { threadId: string }) => {
      if (threadId === 'thread-old') throw new Error('archived predecessor must remain unopened');
      return {
        ok: true,
        thread_id: threadId,
        turns: thread(
          threadId,
          `<orquesta_target agent_id="worker">\n${threadId} user\n</orquesta_target>`,
          `${threadId} agent`
        ).turns,
        next_cursor: null
      };
    });
    const service = new DesktopCodexService({ adapter: double.adapter });
    const generations = [
      {
        sessionId: 'session-old', threadId: 'thread-old', agentId: 'worker', generation: 1,
        rotationState: 'superseded', ownershipStatus: 'superseded', bindingStatus: 'archived', createdAt: null, updatedAt: null
      },
      {
        sessionId: 'session-new', threadId: 'thread-new', agentId: 'worker', generation: 2,
        rotationState: 'active', ownershipStatus: 'owner', bindingStatus: 'bound', createdAt: null, updatedAt: null
      }
    ];

    const newest = await service.listLogicalConversation({
      correlationId: 'history-lazy-new', targetAgentId: 'worker', generations, cursor: null, limit: 100
    });
    expect(newest.items.every((item) => item.threadId === 'thread-new')).toBe(true);
    expect(newest.nextCursor).toMatch(/^logical:/u);
    expect(double.adapter.listThreadTurns).toHaveBeenCalledTimes(1);
  });

  test('returns bounded runtime information and invokes adapter shutdown only once', async () => {
    const double = createAdapterDouble();
    const service = new DesktopCodexService({ adapter: double.adapter });
    await expect(service.getRuntimeInfo({ probe: false })).resolves.toMatchObject({
      status: 'not_started', adapter: 'app_server', sdkVersion: '0.144.5', integrity: 'unverified'
    });
    await expect(service.getRuntimeInfo({ probe: true })).resolves.toMatchObject({
      status: 'ready', platformFamily: 'windows', userAgent: 'codex-cli/0.144.5'
    });
    const serialized = JSON.stringify(await service.getRuntimeInfo({ probe: false }));
    expect(serialized).not.toContain('codexHome');
    expect(serialized).not.toContain('executable');

    await Promise.all([service.shutdown(), service.shutdown()]);
    expect(double.adapter.shutdown).toHaveBeenCalledTimes(1);
  });

  test('relays only an exact pending approval response and consumes it once', async () => {
    const double = createAdapterDouble();
    const approvals: Array<Record<string, unknown>> = [];
    const service = new DesktopCodexService({ adapter: double.adapter });
    service.subscribeApprovals((approval) => approvals.push(approval));
    await service.sendMessage({
      correlationId: 'corr-approval', projectId: 'repo-1', rootPath: 'C:\\repo', threadId: null,
      targetAgentId: 'orchestrator', text: 'Edit.', localImagePaths: [], recommendedModel: null, requestedModel: null
    });
    double.emit({
      type: 'approval_requested', correlation_id: 'corr-approval', thread_id: 'thread-new', turn_id: 'turn-1',
      request_id: 'approval-1', method: 'item/fileChange/requestApproval', reason: '[redacted approval reason]',
      response_options: ['accept', 'acceptForSession', 'decline', 'cancel']
    });
    await vi.waitFor(() => expect(approvals).toHaveLength(1));
    expect(approvals[0]).toEqual({
      projectId: 'repo-1', correlationId: 'corr-approval', requestId: 'approval-1', method: 'item/fileChange/requestApproval',
      threadId: 'thread-new', turnId: 'turn-1', reason: '[redacted approval reason]',
      responseOptions: ['accept', 'acceptForSession', 'decline', 'cancel']
    });

    await expect(service.respondToApproval({
      correlationId: 'respond-1', requestId: 'approval-1', decision: 'acceptForSession'
    })).resolves.toEqual({ requestId: 'approval-1', decision: 'acceptForSession' });
    expect(double.adapter.respondToApproval).toHaveBeenCalledWith({
      correlationId: 'corr-approval', requestId: 'approval-1', method: 'item/fileChange/requestApproval',
      threadId: 'thread-new', turnId: 'turn-1', decision: 'acceptForSession'
    });
    await expect(service.respondToApproval({
      correlationId: 'respond-2', requestId: 'approval-1', decision: 'accept'
    })).rejects.toThrow('pending');
  });

  test('rejects an invented approval option and never auto-responds during shutdown', async () => {
    const double = createAdapterDouble();
    const service = new DesktopCodexService({ adapter: double.adapter });
    const approvals: Array<Record<string, unknown>> = [];
    service.subscribeApprovals((approval) => approvals.push(approval));
    await service.sendMessage({
      correlationId: 'corr-approval', projectId: 'repo-1', rootPath: 'C:\\repo', threadId: null,
      targetAgentId: 'orchestrator', text: 'Edit.', localImagePaths: [], recommendedModel: null, requestedModel: null
    });
    double.emit({
      type: 'approval_requested', correlation_id: 'corr-approval', thread_id: 'thread-new', turn_id: 'turn-1',
      request_id: 'approval-2', method: 'item/fileChange/requestApproval', response_options: ['accept', 'decline']
    });
    await vi.waitFor(() => expect(approvals).toHaveLength(1));

    await expect(service.respondToApproval({
      correlationId: 'respond-invalid', requestId: 'approval-2', decision: 'allow'
    })).rejects.toThrow('response option');
    await service.shutdown();
    expect(double.adapter.respondToApproval).not.toHaveBeenCalled();
  });

  test.each(['accept', 'decline', 'cancel'])('passes through the exact %s response option', async (decision) => {
    const double = createAdapterDouble();
    const approvals: Array<Record<string, unknown>> = [];
    const service = new DesktopCodexService({ adapter: double.adapter });
    service.subscribeApprovals((approval) => approvals.push(approval));
    await service.sendMessage({
      correlationId: `corr-${decision}`, projectId: 'repo-1', rootPath: 'C:\\repo', threadId: null,
      targetAgentId: 'orchestrator', text: 'Continue.', localImagePaths: [], recommendedModel: null, requestedModel: null
    });
    double.emit({
      type: 'approval_requested', correlation_id: `corr-${decision}`, thread_id: 'thread-new', turn_id: 'turn-1',
      request_id: `approval-${decision}`, method: 'item/commandExecution/requestApproval',
      response_options: ['accept', 'decline', 'cancel']
    });
    await vi.waitFor(() => expect(approvals).toHaveLength(1));
    await service.respondToApproval({
      correlationId: `respond-${decision}`, requestId: `approval-${decision}`, decision
    });
    expect(double.adapter.respondToApproval).toHaveBeenCalledWith(expect.objectContaining({ decision }));
    await service.shutdown();
  });

  test('verifies a packaged runtime once before constructing the canonical adapter', async () => {
    const double = createAdapterDouble();
    const verifyIntegrity = vi.fn(async () => ({ integrity: 'verified' as const, filesVerified: 4 }));
    const adapterFactory = vi.fn(() => double.adapter);
    const service = new DesktopCodexService({
      packaged: true,
      appRoot: 'ignored',
      resourcesPath: 'C:\\Program Files\\Orquesta\\resources',
      verifyIntegrity,
      adapterFactory
    });

    await expect(service.getRuntimeInfo({ probe: false })).resolves.toMatchObject({ integrity: 'verified' });
    await service.getRuntimeInfo({ probe: false });
    expect(verifyIntegrity).toHaveBeenCalledTimes(1);
    expect(verifyIntegrity).toHaveBeenCalledWith({
      runtimeRoot: 'C:\\Program Files\\Orquesta\\resources\\codex-runtime'
    });
    expect(adapterFactory).toHaveBeenCalledTimes(1);
    expect(adapterFactory).toHaveBeenCalledWith({
      sdkPackageRoot: 'C:\\Program Files\\Orquesta\\resources\\codex-runtime\\node_modules\\@openai\\codex-sdk'
    });
  });

  test('reports failed integrity and never constructs an adapter for a damaged package', async () => {
    const adapterFactory = vi.fn();
    const service = new DesktopCodexService({
      packaged: true,
      resourcesPath: 'C:\\Program Files\\Orquesta\\resources',
      verifyIntegrity: vi.fn(async () => { throw new Error('integrity mismatch'); }),
      adapterFactory
    });

    await expect(service.getRuntimeInfo({ probe: true })).resolves.toMatchObject({
      status: 'unavailable', integrity: 'failed'
    });
    expect(adapterFactory).not.toHaveBeenCalled();
  });
});

async function productionElectronSources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return productionElectronSources(entryPath);
    return entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [entryPath] : [];
  }));
  return nested.flat();
}

test('Desktop production code has one canonical runtime and protocol implementation', async () => {
  const electronRoot = path.resolve(import.meta.dirname, '..');
  const sources = await productionElectronSources(electronRoot);
  const forbiddenSourcePatterns = [
    /ORQUESTA_CODEX_PATH/u,
    /WindowsApps/u,
    /where\.exe/u,
    /shell\s*:\s*true/u,
    /from\s+['"].*\/(?:app-server-client|codex-executable|codex-runtime)['"]/u
  ];
  for (const sourcePath of sources) {
    const source = await readFile(sourcePath, 'utf8');
    for (const pattern of forbiddenSourcePatterns) expect(source, `${sourcePath}: ${pattern}`).not.toMatch(pattern);
  }
  for (const deletedModule of ['app-server-client.ts', 'codex-executable.ts', 'codex-runtime.ts']) {
    expect(sources.some((sourcePath) => sourcePath.endsWith(deletedModule))).toBe(false);
  }
});
