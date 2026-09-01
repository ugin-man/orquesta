import { mkdir, mkdtemp, readdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';

import {
  DesktopCodexService,
  approvalActionFingerprint,
  dispatchActionFingerprintForSend,
  providerThreadSourceIdentity,
  projectConversation,
  projectLucaConversation,
  type CanonicalCodexAdapter
} from './desktop-codex-service';
import { MessageLedger as FixedMessageLedger } from './message-ledger-v2';

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

function adapterApprovalId(hexCharacter = 'a'): string {
  return `adapter-approval-${hexCharacter.repeat(64)}`;
}

function approvalEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'approval_requested',
    provider_connection_id: 'provider-test',
    correlation_id: 'corr-approval',
    thread_id: 'thread-new',
    turn_id: 'turn-1',
    request_id: adapterApprovalId(),
    method: 'item/fileChange/requestApproval',
    reason: '[redacted approval reason]',
    requested_effect: { kind: 'file_change', item_id: 'item-1' },
    response_options: ['accept', 'acceptForSession', 'decline', 'cancel'],
    ...overrides
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
        runtime_workspace_roots: input.params?.runtimeWorkspaceRoots ?? null,
        instruction_sources: [],
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
        runtime_workspace_roots: input.params?.runtimeWorkspaceRoots ?? null,
        instruction_sources: [],
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
    steerTurn: vi.fn(async (input) => ({ ok: true, thread_id: input.threadId, turn_id: input.turnId })),
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
      user_agent: probe ? 'codex-cli/0.144.5' : null,
      provider_connection_id: probe ? 'provider-generation-a' : null
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

function expectedProjectThreadBoundary(rootPath = 'C:\\repo') {
  return {
    cwd: rootPath,
    runtimeWorkspaceRoots: [rootPath],
    config: {
      project_root_markers: [],
      notify: [],
      features: { memories: false },
      memories: { generate_memories: false, use_memories: false }
    }
  };
}

describe('DesktopCodexService', () => {
  test('forwards connection observations before queued thread work without admitting a thread', async () => {
    const double = createAdapterDouble();
    const service = new DesktopCodexService({ adapter: double.adapter });
    const notifications: unknown[] = [];
    const unsubscribe = service.subscribe((notification) => notifications.push(notification));
    await service.getRuntimeInfo({ probe: false });
    double.emit({ type: 'provider_connection', provider_connection_id: 'provider-a', state: 'connected' });
    double.emit({ type: 'provider_connection', provider_connection_id: 'provider-a', state: 'disconnected' });
    double.emit({ type: 'provider_connection', provider_connection_id: 'bad id', state: 'connected' });
    expect(notifications).toEqual([
      { kind: 'provider_connection', providerConnectionId: 'provider-a', state: 'connected' },
      { kind: 'provider_connection', providerConnectionId: 'provider-a', state: 'disconnected' },
    ]);
    expect(double.adapter.createThread).not.toHaveBeenCalled();
    unsubscribe();
    await service.shutdown();
  });
  test('domain-separates provider thread recovery identity by message as well as semantic content', () => {
    const base = { projectId: 'project-a', messageId: 'message-a', actionFingerprint: 'a'.repeat(64) };
    const identity = providerThreadSourceIdentity(base);
    expect(identity).toMatch(/^orquesta:[a-f0-9]{64}$/u);
    expect(providerThreadSourceIdentity(base)).toBe(identity);
    expect(providerThreadSourceIdentity({ ...base, messageId: 'message-b' })).not.toBe(identity);
    expect(providerThreadSourceIdentity({ ...base, projectId: 'project-b' })).not.toBe(identity);
  });

  test('domain-separates the project and full approval binding in the public identity', () => {
    const identity = {
      adapterRequestId: adapterApprovalId(),
      projectId: 'repo-1',
      providerConnectionId: 'provider-test',
      method: 'item/fileChange/requestApproval',
      correlationId: 'corr-1',
      threadId: 'thread-1',
      turnId: 'turn-1',
      targetAgentId: 'orchestrator',
      requestedEffect: { kind: 'file_change', itemId: 'item-1' },
      responseOptions: ['accept', 'decline']
    };
    const fingerprint = approvalActionFingerprint(identity);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(approvalActionFingerprint({ ...identity, projectId: 'repo-2' })).not.toBe(fingerprint);
    expect(approvalActionFingerprint({
      ...identity,
      requestedEffect: { ...identity.requestedEffect, itemId: 'item-2' }
    })).not.toBe(fingerprint);
    expect(approvalActionFingerprint({ ...identity, responseOptions: ['decline', 'accept'] })).not.toBe(fingerprint);
  });

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

    expect(messages.map((message) => message.text)).toEqual(['画面を直すタスクです。']);
    expect(messages.every((message) => message.targetAgentId === 'orquesta-admin')).toBe(true);
  });

  test('keeps Foundation acceptance receipts out of user-visible conversation history', () => {
    const thread = {
      turns: [{
        id: 'turn-foundation', startedAt: 1, completedAt: 2,
        items: [
          {
            id: 'user-foundation', type: 'userMessage',
            content: [{
              type: 'text',
              text: '<orquesta_target agent_id="orchestrator">\n<orquesta_foundation_assignment version="1">\nassignment\n</orquesta_foundation_assignment>\n</orquesta_target>'
            }]
          },
          {
            id: 'agent-foundation', type: 'agentMessage',
            text: '<orquesta_foundation_receipt version="1" agent_id="orchestrator" status="accepted" />'
          }
        ]
      }]
    };

    expect(projectConversation(thread, new Date('2026-08-28T00:00:00.000Z'), 'orchestrator')).toEqual([]);
    expect(projectConversation(
      thread,
      new Date('2026-08-28T00:00:00.000Z'),
      'orchestrator',
      { includeFoundationReceipts: true }
    ).map((message) => message.text)).toEqual([
      '<orquesta_foundation_receipt version="1" agent_id="orchestrator" status="accepted" />'
    ]);
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
        ...expectedProjectThreadBoundary(), sandbox: 'read-only', approvalPolicy: 'never', webSearchMode: 'live'
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

  test('starts each workflow attempt as a fresh read-only thread without Web search', async () => {
    const double = createAdapterDouble();
    const service = new DesktopCodexService({ adapter: double.adapter });

    await expect(service.startWorkflowRun({
      correlationId: 'workflow-1', projectId: 'repo-1', rootPath: 'C:\\repo', prompt: 'Run once.'
    })).resolves.toMatchObject({
      threadId: 'thread-new', turnId: 'turn-1',
      runtimeBoundary: { sandbox: 'read-only', approvalPolicy: 'never', webSearchMode: 'disabled' }
    });
    expect(double.adapter.createThread).toHaveBeenCalledWith({
      correlationId: 'workflow-1:thread',
      params: { ...expectedProjectThreadBoundary(), sandbox: 'read-only', approvalPolicy: 'never', webSearchMode: 'disabled' }
    });
    expect(double.adapter.resumeThread).not.toHaveBeenCalled();
  });

  test('rejects an inspection runtime profile mismatch before starting the turn', async () => {
    const double = createAdapterDouble();
    double.adapter.createThread.mockResolvedValue({
      ok: true,
      thread_id: 'thread-unsafe',
      runtime_profile: {
        cwd: 'C:\\repo', runtime_workspace_roots: ['C:\\repo'], instruction_sources: [],
        sandbox: 'workspace-write', approval_policy: 'never', requested_web_search_mode: 'live'
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

  test('reports inspection turn status separately from partial agent output', async () => {
    const double = createAdapterDouble();
    double.adapter.listThreadTurns.mockResolvedValue({
      ok: true,
      turns: [{
        id: 'turn-7', status: 'failed',
        items: [{ type: 'agentMessage', id: 'message-1', text: 'partial response' }]
      }],
      next_cursor: null
    });
    const service = new DesktopCodexService({ adapter: double.adapter });

    await expect(service.readInspectionThread({ correlationId: 'inspect-read', threadId: 'thread-9' }))
      .resolves.toEqual({ finalResponse: 'partial response', status: 'failed' });
  });

  test('creates a coordinator thread, routes the target privately, and keeps model evidence separate', async () => {
    const double = createAdapterDouble();
    const service = new DesktopCodexService({ adapter: double.adapter });
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'orquesta-service-attachment-'));
    const attachmentStoreHandle = randomUUID();
    const imagePath = path.join(temporaryDirectory, attachmentStoreHandle);
    const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await writeFile(imagePath, imageBytes);
    await service.selectAttachmentAuthority(temporaryDirectory);
    const result = await service.sendMessage({
      correlationId: 'corr-send',
      projectId: 'repo-1',
      rootPath: 'C:\\repo',
      threadId: null,
      targetAgentId: 'implementation-002',
      threadTitle: 'Orquesta 実装係 2',
      text: 'Implement the accepted slice.',
      attachments: [{
        attachmentStoreHandle,
        kind: 'image',
        displayName: 'reference.png',
        mediaType: 'image/png',
        sealedAbsolutePath: imagePath,
        sizeBytes: imageBytes.length,
        sha256: createHash('sha256').update(imageBytes).digest('hex'),
        encoding: null
      }],
      recommendedModel: 'recommended-model',
      requestedModel: 'requested-model',
      effort: 'medium'
    });

    expect(double.adapter.createThread).toHaveBeenCalledWith({
      correlationId: 'corr-send:thread',
      recommendedModel: 'recommended-model',
      requestedModel: 'requested-model',
      params: {
        ...expectedProjectThreadBoundary(),
        model: 'requested-model',
        threadSource: expect.stringMatching(/^orquesta:[a-f0-9]{64}$/u),
        dynamicTools: [expect.objectContaining({ name: 'orquesta_attachment_read', type: 'function' })]
      }
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
        { type: 'localImage', path: imagePath }
      ],
      params: { clientUserMessageId: 'corr-send', effort: 'medium' },
      dynamicToolHandlerFactory: null
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
      attachmentToolState: 'supported',
      modelEvidence: {
        recommendedModel: 'recommended-model',
        requestedModel: 'requested-model',
        appliedModel: 'requested-model',
        actualModel: null,
        actualModelEvidence: 'unknown'
      }
    });
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  test('rejects a Provider project-root mismatch before starting a normal turn', async () => {
    const double = createAdapterDouble();
    double.adapter.createThread.mockResolvedValue({
      ok: true,
      thread_id: 'thread-wrong-root',
      runtime_profile: {
        cwd: 'C:\\other', runtime_workspace_roots: ['C:\\repo'], instruction_sources: [],
        sandbox: 'workspace-write', approval_policy: 'on-request', requested_web_search_mode: null
      },
      model_evidence: {}
    });
    const service = new DesktopCodexService({ adapter: double.adapter });

    await expect(service.sendMessage({
      correlationId: 'corr-wrong-root', projectId: 'repo-1', rootPath: 'C:\\repo', threadId: null,
      targetAgentId: 'orchestrator', text: 'Continue.', attachments: [],
      recommendedModel: null, requestedModel: null
    })).rejects.toThrow('provider_project_root_mismatch');
    expect(double.adapter.startTurn).not.toHaveBeenCalled();
  });

  test('rejects extra Provider workspace roots before starting a normal turn', async () => {
    const double = createAdapterDouble();
    double.adapter.createThread.mockResolvedValue({
      ok: true,
      thread_id: 'thread-extra-root',
      runtime_profile: {
        cwd: 'C:\\repo', runtime_workspace_roots: ['C:\\repo', 'C:\\other'], instruction_sources: [],
        sandbox: 'workspace-write', approval_policy: 'on-request', requested_web_search_mode: null
      },
      model_evidence: {}
    });
    const service = new DesktopCodexService({ adapter: double.adapter });

    await expect(service.sendMessage({
      correlationId: 'corr-extra-root', projectId: 'repo-1', rootPath: 'C:\\repo', threadId: null,
      targetAgentId: 'orchestrator', text: 'Continue.', attachments: [], recommendedModel: null, requestedModel: null
    })).rejects.toThrow('provider_workspace_roots_mismatch');
    expect(double.adapter.startTurn).not.toHaveBeenCalled();
  });

  test('rejects an instruction source above the selected project before starting a normal turn', async () => {
    const double = createAdapterDouble();
    double.adapter.createThread.mockResolvedValue({
      ok: true,
      thread_id: 'thread-ancestor-instructions',
      runtime_profile: {
        cwd: 'C:\\repo\\starter', runtime_workspace_roots: ['C:\\repo\\starter'],
        instruction_sources: ['C:\\repo\\AGENTS.md'], sandbox: 'workspace-write',
        approval_policy: 'on-request', requested_web_search_mode: null
      },
      model_evidence: {}
    });
    const service = new DesktopCodexService({ adapter: double.adapter });

    await expect(service.sendMessage({
      correlationId: 'corr-ancestor-instructions', projectId: 'repo-1', rootPath: 'C:\\repo\\starter',
      threadId: null, targetAgentId: 'orchestrator', text: 'Continue.', attachments: [],
      recommendedModel: null, requestedModel: null
    })).rejects.toThrow('provider_ancestor_instruction_source');
    expect(double.adapter.startTurn).not.toHaveBeenCalled();
  });

  test('relays an ordinary text attachment only through the bounded dynamic tool without exposing private identity', async () => {
    const double = createAdapterDouble();
    const service = new DesktopCodexService({ adapter: double.adapter });
    const sealedRoot = await mkdtemp(path.join(os.tmpdir(), 'orquesta-service-text-attachment-'));
    const attachmentStoreHandle = randomUUID();
    const sealedAbsolutePath = path.join(sealedRoot, attachmentStoreHandle);
    const bytes = Buffer.from('first line\nsecond line\n', 'utf8');
    await writeFile(sealedAbsolutePath, bytes);
    await service.selectAttachmentAuthority(sealedRoot);
    let serializedProviderInput = '';
    let serializedToolResponse = '';
    double.adapter.startTurn.mockImplementation(async (input: any) => {
      serializedProviderInput = JSON.stringify(input.input);
      const guide = input.input[1]?.text as string;
      const capability = /"capability":"([a-f0-9]{64})"/u.exec(guide)?.[1];
      if (!capability) throw new Error('attachment capability missing');
      const handler = input.dynamicToolHandlerFactory({
        providerConnectionId: 'provider-1',
        correlationId: input.correlationId,
        threadId: input.threadId,
        turnId: 'turn-1'
      });
      const handled = await handler.handle({
        method: 'item/tool/call',
        tool: 'orquesta_attachment_read',
        arguments: { capability, cursor: null }
      });
      serializedToolResponse = JSON.stringify(handled.response);
      return { ok: true, thread_id: input.threadId, turn_id: 'turn-1' };
    });
    await expect(service.sendMessage({
      correlationId: 'corr-text-send', projectId: 'repo-1', rootPath: 'C:\\repo', threadId: null,
      targetAgentId: 'implementation-002', text: 'Read the selected file.',
      attachments: [{
        attachmentStoreHandle,
        kind: 'text',
        displayName: 'notes.txt',
        mediaType: 'text/plain',
        sealedAbsolutePath,
        sizeBytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        encoding: 'utf-8'
      }],
      recommendedModel: null,
      requestedModel: null
    })).resolves.toMatchObject({ attachmentToolState: 'supported' });
    expect(serializedProviderInput).toContain('notes.txt');
    expect(serializedProviderInput).toContain('orquesta_attachment_read');
    expect(serializedToolResponse).toContain('first line');
    for (const secret of [sealedAbsolutePath, attachmentStoreHandle, createHash('sha256').update(bytes).digest('hex')]) {
      expect(serializedProviderInput).not.toContain(secret);
      expect(serializedToolResponse).not.toContain(secret);
    }
    await rm(sealedRoot, { recursive: true, force: true });
  });

  test('keeps a removed attachment path, handle, and digest out of dispatch failure and ledger projection', async () => {
    const double = createAdapterDouble();
    const ledgerRecords: Array<Record<string, unknown>> = [];
    const service = new DesktopCodexService({
      adapter: double.adapter,
      messageLedger: { record: vi.fn(async (entry) => { ledgerRecords.push({ ...entry }); return true; }) }
    });
    const sealedRoot = await mkdtemp(path.join(os.tmpdir(), 'orquesta-service-private-failure-'));
    const attachmentStoreHandle = randomUUID();
    const sealedAbsolutePath = path.join(sealedRoot, attachmentStoreHandle);
    const bytes = Buffer.from('PRIVATE_FILE_CONTENT_SENTINEL', 'utf8');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await writeFile(sealedAbsolutePath, bytes);
    await service.selectAttachmentAuthority(sealedRoot);
    await unlink(sealedAbsolutePath);
    let serializedFailure = '';
    try {
      await service.sendMessage({
        correlationId: 'corr-private-failure', projectId: 'repo-1', rootPath: 'C:\repo', threadId: null,
        targetAgentId: 'implementation-002', text: 'Read the selected file.',
        attachments: [{
          attachmentStoreHandle,
          kind: 'text',
          displayName: 'notes.txt',
          mediaType: 'text/plain',
          sealedAbsolutePath,
          sizeBytes: bytes.length,
          sha256,
          encoding: 'utf-8'
        }],
        recommendedModel: null,
        requestedModel: null
      });
    } catch (error) {
      serializedFailure = JSON.stringify({
        reason: error instanceof Error ? error.message : String(error),
        cause: error instanceof Error && error.cause instanceof Error ? error.cause.message : null
      });
    }
    expect(serializedFailure).toContain('attachment_read_failed');
    expect(double.adapter.runtimeInfo).not.toHaveBeenCalled();
    expect(double.adapter.createThread).not.toHaveBeenCalled();
    expect(double.adapter.resumeThread).not.toHaveBeenCalled();
    expect(double.adapter.startTurn).not.toHaveBeenCalled();
    expect(ledgerRecords.map((record) => record.state)).toEqual(['queued', 'failed']);
    expect(ledgerRecords.at(-1)).toMatchObject({ errorCode: 'attachment_read_failed' });
    const serializedProjection = JSON.stringify({ failure: serializedFailure, ledgerRecords });
    for (const secret of [sealedRoot, sealedAbsolutePath, attachmentStoreHandle, sha256, 'PRIVATE_FILE_CONTENT_SENTINEL']) {
      expect(serializedProjection).not.toContain(secret);
    }
    await rm(sealedRoot, { recursive: true, force: true });
  });

  test('treats a replaced sealed root as a definitive pre-Provider attachment failure', async () => {
    const double = createAdapterDouble();
    const ledgerRecords: Array<Record<string, unknown>> = [];
    const service = new DesktopCodexService({
      adapter: double.adapter,
      messageLedger: { record: vi.fn(async (entry) => { ledgerRecords.push({ ...entry }); return true; }) }
    });
    const base = await mkdtemp(path.join(os.tmpdir(), 'orquesta-service-replaced-root-'));
    const sealedRoot = path.join(base, 'sealed');
    const oldRoot = path.join(base, 'sealed-old');
    await mkdir(sealedRoot);
    const attachmentStoreHandle = randomUUID();
    const sealedAbsolutePath = path.join(sealedRoot, attachmentStoreHandle);
    const bytes = Buffer.from('PRIVATE_ROOT_REPLACED_SENTINEL', 'utf8');
    await writeFile(sealedAbsolutePath, bytes);
    await service.selectAttachmentAuthority(sealedRoot);
    await rename(sealedRoot, oldRoot);
    await mkdir(sealedRoot);
    let reason = '';
    try {
      await service.sendMessage({
        correlationId: 'corr-root-replaced', projectId: 'repo-1', rootPath: 'C:\repo', threadId: null,
        targetAgentId: 'implementation-002', text: 'Read it.',
        attachments: [{
          attachmentStoreHandle, kind: 'text', displayName: 'notes.txt', mediaType: 'text/plain',
          sealedAbsolutePath, sizeBytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'), encoding: 'utf-8'
        }],
        recommendedModel: null, requestedModel: null
      });
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }
    expect(reason).toBe('attachment_sealed_root_changed');
    expect(double.adapter.runtimeInfo).not.toHaveBeenCalled();
    expect(double.adapter.startTurn).not.toHaveBeenCalled();
    expect(ledgerRecords.map((record) => record.state)).toEqual(['queued', 'failed']);
    expect(ledgerRecords.at(-1)).toMatchObject({ errorCode: 'attachment_sealed_root_changed' });
    await rm(base, { recursive: true, force: true });
  });

  test('treats a digest mismatch as a definitive pre-Provider attachment failure', async () => {
    const double = createAdapterDouble();
    const ledgerRecords: Array<Record<string, unknown>> = [];
    const service = new DesktopCodexService({
      adapter: double.adapter,
      messageLedger: { record: vi.fn(async (entry) => { ledgerRecords.push({ ...entry }); return true; }) }
    });
    const sealedRoot = await mkdtemp(path.join(os.tmpdir(), 'orquesta-service-digest-failure-'));
    const attachmentStoreHandle = randomUUID();
    const sealedAbsolutePath = path.join(sealedRoot, attachmentStoreHandle);
    const bytes = Buffer.from('PRIVATE_DIGEST_MISMATCH_SENTINEL', 'utf8');
    await writeFile(sealedAbsolutePath, bytes);
    await service.selectAttachmentAuthority(sealedRoot);
    let reason = '';
    try {
      await service.sendMessage({
        correlationId: 'corr-digest-mismatch', projectId: 'repo-1', rootPath: 'C:\repo', threadId: null,
        targetAgentId: 'implementation-002', text: 'Read it.',
        attachments: [{
          attachmentStoreHandle, kind: 'text', displayName: 'notes.txt', mediaType: 'text/plain',
          sealedAbsolutePath, sizeBytes: bytes.length, sha256: 'f'.repeat(64), encoding: 'utf-8'
        }],
        recommendedModel: null, requestedModel: null
      });
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }
    expect(reason).toBe('attachment_digest_mismatch');
    expect(double.adapter.runtimeInfo).not.toHaveBeenCalled();
    expect(double.adapter.startTurn).not.toHaveBeenCalled();
    expect(ledgerRecords.map((record) => record.state)).toEqual(['queued', 'failed']);
    expect(ledgerRecords.at(-1)).toMatchObject({ errorCode: 'attachment_digest_mismatch' });
    await rm(sealedRoot, { recursive: true, force: true });
  });

  test('persists adapter attachment preflight rejection as definitive without outcome-unknown wrapping', async () => {
    const double = createAdapterDouble();
    const ledgerRecords: Array<Record<string, unknown>> = [];
    double.adapter.startTurn.mockResolvedValue({
      ok: false,
      thread_id: null,
      turn_id: null,
      error: { code: 'attachment_dispatch_binding_invalid', message: 'attachment_dispatch_binding_invalid' },
      evidence: { dispatch_accepted: false, turn_started: false, actual_model: null }
    });
    const service = new DesktopCodexService({
      adapter: double.adapter,
      messageLedger: { record: vi.fn(async (entry) => { ledgerRecords.push({ ...entry }); return true; }) }
    });
    const sealedRoot = await mkdtemp(path.join(os.tmpdir(), 'orquesta-service-preflight-failure-'));
    const attachmentStoreHandle = randomUUID();
    const sealedAbsolutePath = path.join(sealedRoot, attachmentStoreHandle);
    const bytes = Buffer.from('preflight', 'utf8');
    await writeFile(sealedAbsolutePath, bytes);
    await service.selectAttachmentAuthority(sealedRoot);
    let observed: unknown = null;
    try {
      await service.sendMessage({
        correlationId: 'corr-preflight-failure', projectId: 'repo-1', rootPath: 'C:\repo', threadId: null,
        targetAgentId: 'implementation-002', text: 'Read it.',
        attachments: [{
          attachmentStoreHandle, kind: 'text', displayName: 'notes.txt', mediaType: 'text/plain',
          sealedAbsolutePath, sizeBytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'), encoding: 'utf-8'
        }],
        recommendedModel: null, requestedModel: null
      });
    } catch (error) {
      observed = error;
    }
    expect(observed).toMatchObject({
      name: 'AttachmentPreDispatchError',
      code: 'attachment_dispatch_binding_invalid',
      outcomeUnknown: false
    });
    expect(ledgerRecords.at(-1)).toMatchObject({ state: 'failed', errorCode: 'attachment_dispatch_binding_invalid' });
    await rm(sealedRoot, { recursive: true, force: true });
  });

  test('routes a Foundation assignment without adding the ordinary orchestrator work contract', async () => {
    const double = createAdapterDouble();
    const service = new DesktopCodexService({ adapter: double.adapter });
    const assignment = [
      '<orquesta_foundation_assignment version="1">',
      '  <agent_id>orchestrator</agent_id>',
      '</orquesta_foundation_assignment>'
    ].join('\n');

    await service.sendMessage({
      correlationId: 'foundation-orchestrator', projectId: 'repo-1', rootPath: 'C:\\repo', threadId: null,
      targetAgentId: 'orchestrator', text: assignment, attachments: [], recommendedModel: null, requestedModel: null
    });

    const routedText = double.adapter.startTurn.mock.calls[0]?.[0]?.input?.[0]?.text;
    expect(routedText).toBe(`<orquesta_target agent_id="orchestrator">\n${assignment}\n</orquesta_target>`);
    expect(routedText).not.toContain('<orquesta_runtime_contract');
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
      targetAgentId: 'implementation-002', text: 'Continue.', attachments: [], recommendedModel: null, requestedModel: null
    });
    double.emit({
      type: 'turn_started', correlation_id: 'message-1', thread_id: 'thread-existing', turn_id: 'turn-1'
    });
    double.emit({
      type: 'turn_completed', correlation_id: 'message-1', thread_id: 'thread-existing', turn_id: 'turn-1', status: 'completed'
    });
    await vi.waitFor(() => expect(records.map((record) => record.state)).toEqual([
      'queued', 'thread_ready', 'turn_starting', 'dispatch_accepted', 'turn_started', 'completed'
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
      attachments: [],
      recommendedModel: 'Sol',
      requestedModel: null,
      onThreadReady: async (threadId) => {
        order.push(`thread:${threadId}`);
      }
    });

    expect(order).toEqual(['thread:thread-new', 'turn']);
    const routedText = double.adapter.startTurn.mock.calls[0][0].input[0].text;
    expect(routedText).toContain('does not yet expose the canonical PlacementIntent execution operation');
    expect(routedText).toContain('Do not invent a specialist, emit a storage template, or mutate project state');
    expect(routedText).toContain('SessionBinding confirms an accepted current owner');
    expect(routedText).toContain('<orquesta_user_message>\nBootstrap.\n</orquesta_user_message>');
  });

  test('durably records an exact Provider receipt when dynamic tool admission fails after turn acceptance', async () => {
    const double = createAdapterDouble();
    double.adapter.startTurn.mockResolvedValue({
      ok: false,
      status: 'failed',
      thread_id: 'thread-new',
      turn_id: 'turn-accepted',
      evidence: { dispatch_accepted: true, turn_started: false, actual_model: null },
      error: { code: 'runtime_outcome_unknown', message: 'dynamic handler commit failed' }
    });
    const records: Array<Record<string, unknown>> = [];
    const service = new DesktopCodexService({
      adapter: double.adapter,
      messageLedger: { record: vi.fn(async (input) => { records.push({ ...input }); return true; }) }
    });
    await expect(service.sendMessage({
      correlationId: 'corr-post-accept', messageId: 'message-post-accept', projectId: 'repo-1',
      rootPath: 'C:\\repo', threadId: null, targetAgentId: 'implementation-002',
      text: 'Read the attachment.', attachments: [], recommendedModel: null, requestedModel: null
    })).rejects.toMatchObject({
      code: 'dispatch_outcome_unknown',
      outcomeUnknown: true,
      details: { providerAccepted: true, threadId: 'thread-new', turnId: 'turn-accepted' }
    });
    expect(records.map((record) => record.state)).toEqual([
      'queued', 'thread_ready', 'turn_starting', 'dispatch_accepted'
    ]);
    expect(records.at(-1)).toMatchObject({ threadId: 'thread-new', turnId: 'turn-accepted' });
  });

  test('steers the exact active turn through the canonical App Server adapter', async () => {
    const double = createAdapterDouble();
    const service = new DesktopCodexService({ adapter: double.adapter });

    await expect(service.steerTurn({
      correlationId: 'steer-1', projectId: 'repo-1', rootPath: 'C:\\repo',
      targetAgentId: 'frontend', threadId: 'thread-9', turnId: 'turn-7', text: 'Check the root cause.'
    })).resolves.toEqual({ threadId: 'thread-9', turnId: 'turn-7' });
    expect(double.adapter.steerTurn).toHaveBeenCalledWith({
      correlationId: 'steer-1', threadId: 'thread-9', turnId: 'turn-7',
      input: [{
        type: 'text',
        text: '<orquesta_target agent_id="frontend">\nCheck the root cause.\n</orquesta_target>',
        text_elements: []
      }]
    });
    expect(double.adapter.startTurn).not.toHaveBeenCalled();
  });

  test('blocks an automatic retry when a durable queued dispatch has an unknown provider outcome', async () => {
    const double = createAdapterDouble();
    const input = {
      correlationId: 'corr-restart',
      messageId: 'message-restart',
      projectId: 'repo-1',
      rootPath: 'C:\\repo',
      threadId: null,
      targetAgentId: 'implementation-002',
      text: 'Create this specialist once.',
      attachments: [],
      recommendedModel: null,
      requestedModel: null
    };
    const fingerprint = await dispatchActionFingerprintForSend(input);
    const record = vi.fn(async () => true);
    const service = new DesktopCodexService({
      adapter: double.adapter,
      messageLedger: {
        record,
        read: vi.fn(async () => ({
          schema_version: 2 as const,
          message_id: input.messageId,
          action_fingerprint: fingerprint,
          correlation_id: input.correlationId,
          project_id: input.projectId,
          target_agent_id: input.targetAgentId,
          thread_id: null,
          turn_id: null,
          state: 'queued' as const,
          observed_at: '2026-08-24T06:00:00.000Z',
          error_code: null
        }))
      },
      attachmentToolState: 'supported'
    });

    await expect(service.sendMessage(input)).rejects.toMatchObject({
      code: 'dispatch_outcome_unknown',
      outcomeUnknown: true
    });
    expect(double.adapter.createThread).not.toHaveBeenCalled();
    expect(double.adapter.startTurn).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  test('resumes one schema-v3 thread_ready dispatch without creating a second thread', async () => {
    const double = createAdapterDouble();
    const input = {
      correlationId: 'corr-thread-ready',
      messageId: 'message-thread-ready',
      projectId: 'repo-1', rootPath: 'C:\\repo', threadId: null,
      targetAgentId: 'implementation-002', text: 'Start the accepted specialist assignment.',
      attachments: [], recommendedModel: null, requestedModel: null
    };
    const fingerprint = await dispatchActionFingerprintForSend(input);
    const recorded: Array<Record<string, unknown>> = [];
    const service = new DesktopCodexService({
      adapter: double.adapter,
      messageLedger: {
        read: vi.fn(async () => ({
          schema_version: 3 as const,
          message_id: input.messageId,
          action_fingerprint: fingerprint,
          correlation_id: input.correlationId,
          project_id: input.projectId,
          target_agent_id: input.targetAgentId,
          thread_id: 'thread-recovered',
          turn_id: null,
          state: 'thread_ready' as const,
          observed_at: '2026-08-24T06:00:00.000Z',
          error_code: null
        })),
        record: vi.fn(async (entry) => { recorded.push({ ...entry }); return true; })
      }
    });

    await expect(service.sendMessage(input)).resolves.toMatchObject({
      threadId: 'thread-recovered', turnId: 'turn-1'
    });
    expect(double.adapter.createThread).not.toHaveBeenCalled();
    expect(double.adapter.resumeThread).toHaveBeenCalledWith(expect.objectContaining({
      threadId: 'thread-recovered'
    }));
    expect(double.adapter.startTurn).toHaveBeenCalledWith(expect.objectContaining({
      threadId: 'thread-recovered',
      params: { clientUserMessageId: input.messageId }
    }));
    expect(recorded.map((entry) => entry.state)).toEqual([
      'thread_ready', 'turn_starting', 'dispatch_accepted'
    ]);
  });

  test('does not call turn/start when another process wins the thread_ready claim', async () => {
    const double = createAdapterDouble();
    const input = {
      correlationId: 'corr-thread-race', messageId: 'message-thread-race', projectId: 'repo-1',
      rootPath: 'C:\\repo', threadId: null, targetAgentId: 'implementation-002',
      text: 'Start this once.', attachments: [], recommendedModel: null, requestedModel: null
    };
    const fingerprint = await dispatchActionFingerprintForSend(input);
    const threadReady = {
      schema_version: 3 as const, message_id: input.messageId, action_fingerprint: fingerprint,
      correlation_id: input.correlationId, project_id: input.projectId,
      target_agent_id: input.targetAgentId, thread_id: 'thread-recovered', turn_id: null,
      state: 'thread_ready' as const, observed_at: '2026-08-24T06:00:00.000Z', error_code: null
    };
    const service = new DesktopCodexService({
      adapter: double.adapter,
      messageLedger: {
        read: vi.fn(async () => threadReady),
        record: vi.fn(async (entry) => entry.state !== 'turn_starting')
      }
    });

    await expect(service.sendMessage(input)).rejects.toMatchObject({
      code: 'dispatch_outcome_unknown', outcomeUnknown: true
    });
    expect(double.adapter.startTurn).not.toHaveBeenCalled();
  });

  test('returns a concurrent accepted turn without calling turn/start again', async () => {
    const double = createAdapterDouble();
    const input = {
      correlationId: 'corr-thread-recovered', messageId: 'message-thread-recovered', projectId: 'repo-1',
      rootPath: 'C:\\repo', threadId: null, targetAgentId: 'implementation-002',
      text: 'Start this once.', attachments: [], recommendedModel: null, requestedModel: null
    };
    const fingerprint = await dispatchActionFingerprintForSend(input);
    let reads = 0;
    const service = new DesktopCodexService({
      adapter: double.adapter,
      messageLedger: {
        read: vi.fn(async () => {
          reads += 1;
          return {
            schema_version: 3 as const, message_id: input.messageId, action_fingerprint: fingerprint,
            correlation_id: input.correlationId, project_id: input.projectId,
            target_agent_id: input.targetAgentId, thread_id: 'thread-recovered',
            turn_id: reads === 1 ? null : 'turn-concurrent',
            state: reads === 1 ? 'thread_ready' as const : 'dispatch_accepted' as const,
            observed_at: '2026-08-24T06:00:00.000Z', error_code: null
          };
        }),
        record: vi.fn(async (entry) => entry.state !== 'turn_starting')
      }
    });

    await expect(service.sendMessage(input)).resolves.toMatchObject({
      threadId: 'thread-recovered', turnId: 'turn-concurrent'
    });
    expect(double.adapter.startTurn).not.toHaveBeenCalled();
  });

  test('starts one turn across two services sharing the fixed per-message ledger', async () => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'orquesta-service-cross-instance-'));
    try {
      const input = {
        correlationId: 'corr-fixed-ledger', messageId: 'message-fixed-ledger', projectId: 'repo-1',
        rootPath, threadId: null, targetAgentId: 'implementation-002',
        text: 'Start exactly one turn.', attachments: [], recommendedModel: null, requestedModel: null
      };
      const fingerprint = await dispatchActionFingerprintForSend(input);
      const seed = new FixedMessageLedger();
      await seed.record({
        rootPath, messageId: input.messageId, actionFingerprint: fingerprint,
        correlationId: input.correlationId, projectId: input.projectId,
        targetAgentId: input.targetAgentId, threadId: null, turnId: null, state: 'queued'
      });
      await seed.record({
        rootPath, messageId: input.messageId, actionFingerprint: fingerprint,
        correlationId: input.correlationId, projectId: input.projectId,
        targetAgentId: input.targetAgentId, threadId: 'thread-recovered', turnId: null, state: 'thread_ready'
      });
      const left = createAdapterDouble();
      const right = createAdapterDouble();
      const services = [left, right].map((double) => new DesktopCodexService({
        adapter: double.adapter,
        messageLedger: new FixedMessageLedger()
      }));

      const results = await Promise.allSettled(services.map((service) => service.sendMessage(input)));
      expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
      expect(left.adapter.startTurn.mock.calls.length + right.adapter.startTurn.mock.calls.length).toBe(1);
      await expect(new FixedMessageLedger().read({ rootPath, messageId: input.messageId }))
        .resolves.toMatchObject({ state: 'dispatch_accepted', thread_id: 'thread-recovered', turn_id: 'turn-1' });
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  test('durably queues a new message before binding an existing thread', async () => {
    const rootPath = await mkdtemp(path.join(os.tmpdir(), 'orquesta-service-existing-thread-'));
    try {
      const double = createAdapterDouble();
      const input = {
        correlationId: 'corr-existing-thread', messageId: 'message-existing-thread', projectId: 'repo-1',
        rootPath, threadId: 'thread-saved', targetAgentId: 'orchestrator',
        text: 'Continue the existing conversation.', attachments: [],
        recommendedModel: null, requestedModel: null
      };
      const service = new DesktopCodexService({
        adapter: double.adapter,
        messageLedger: new FixedMessageLedger()
      });

      await expect(service.sendMessage(input)).resolves.toMatchObject({
        threadId: 'thread-saved', turnId: 'turn-1'
      });
      expect(double.adapter.resumeThread).toHaveBeenCalledTimes(1);
      await expect(new FixedMessageLedger().read({ rootPath, messageId: input.messageId }))
        .resolves.toMatchObject({
          state: 'dispatch_accepted',
          thread_id: 'thread-saved',
          turn_id: 'turn-1'
        });
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  test('durably admits a created thread before optional naming and continues when naming fails', async () => {
    const double = createAdapterDouble();
    const states: string[] = [];
    double.adapter.setThreadName.mockRejectedValue(new Error('rename unavailable'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const service = new DesktopCodexService({
      adapter: double.adapter,
      messageLedger: { record: vi.fn(async (entry) => { states.push(entry.state); return true; }) }
    });
    await expect(service.sendMessage({
      correlationId: 'corr-name-failure', projectId: 'repo-1', rootPath: 'C:\\repo', threadId: null,
      targetAgentId: 'implementation-002', threadTitle: 'Optional name', text: 'Continue.',
      attachments: [], recommendedModel: null, requestedModel: null
    })).resolves.toMatchObject({ threadId: 'thread-new', turnId: 'turn-1' });
    expect(states).toEqual(['queued', 'thread_ready', 'turn_starting', 'dispatch_accepted']);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  test('resumes the saved coordinator thread and never restarts it unnecessarily', async () => {
    const double = createAdapterDouble();
    const service = new DesktopCodexService({ adapter: double.adapter });
    const result = await service.sendMessage({
      correlationId: 'corr-resume', projectId: 'repo-1', rootPath: 'C:\\repo', threadId: 'thread-saved',
      targetAgentId: 'orchestrator', text: 'Continue.', attachments: [], recommendedModel: null, requestedModel: null
    });

    expect(double.adapter.resumeThread).toHaveBeenCalledWith({
      correlationId: 'corr-resume:thread',
      threadId: 'thread-saved',
      recommendedModel: null,
      requestedModel: null,
      params: { ...expectedProjectThreadBoundary(), excludeTurns: true }
    });
    expect(double.adapter.createThread).not.toHaveBeenCalled();
    expect(result.threadId).toBe('thread-saved');
  });

  test('reuses a task already loaded in the same App Server process', async () => {
    const double = createAdapterDouble();
    const service = new DesktopCodexService({ adapter: double.adapter });
    const base = {
      projectId: 'repo-1', rootPath: 'C:\\repo', threadId: 'thread-saved',
      targetAgentId: 'orchestrator', attachments: [], recommendedModel: null, requestedModel: null
    };

    await service.sendMessage({ ...base, correlationId: 'corr-first', text: 'First.' });
    await service.sendMessage({ ...base, correlationId: 'corr-second', text: 'Second.' });

    expect(double.adapter.resumeThread).toHaveBeenCalledTimes(1);
    expect(double.adapter.startTurn).toHaveBeenCalledTimes(2);
  });

  test('resumes an existing thread before turn/start after the Provider connection generation changes', async () => {
    const double = createAdapterDouble();
    let providerConnectionId = 'provider-generation-a';
    double.adapter.runtimeInfo.mockImplementation(async () => ({
      ok: true,
      provider_connection_id: providerConnectionId
    }));
    const service = new DesktopCodexService({ adapter: double.adapter });
    const base = {
      projectId: 'repo-1', rootPath: 'C:\\repo', threadId: 'thread-saved',
      targetAgentId: 'orchestrator', attachments: [], recommendedModel: null, requestedModel: null
    };
    await service.sendMessage({ ...base, correlationId: 'corr-generation-a', text: 'First.' });
    providerConnectionId = 'provider-generation-b';
    await service.sendMessage({ ...base, correlationId: 'corr-generation-b', text: 'Second.' });
    expect(double.adapter.resumeThread).toHaveBeenCalledTimes(2);
    expect(double.adapter.startTurn).toHaveBeenCalledTimes(2);
    expect(double.adapter.resumeThread.mock.invocationCallOrder[1])
      .toBeLessThan(double.adapter.startTurn.mock.invocationCallOrder[1]);
  });

  test('only model_observed proves the actual model', async () => {
    const double = createAdapterDouble();
    const notifications: Array<Record<string, unknown>> = [];
    const service = new DesktopCodexService({ adapter: double.adapter });
    service.subscribe((notification) => notifications.push(notification));
    await service.sendMessage({
      correlationId: 'corr-model', projectId: 'repo-1', rootPath: 'C:\\repo', threadId: null,
      targetAgentId: 'orchestrator', text: 'Continue.', attachments: [], recommendedModel: null, requestedModel: 'requested-model'
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

  test('drops every event from an unadmitted App Server thread before it can hijack delivery or projection', async () => {
    const double = createAdapterDouble();
    const notifications: Array<Record<string, unknown>> = [];
    const approvals: Array<Record<string, unknown>> = [];
    const records: Array<Record<string, unknown>> = [];
    const service = new DesktopCodexService({
      adapter: double.adapter,
      messageLedger: { record: vi.fn(async (input) => { records.push({ ...input }); return true; }) }
    });
    service.subscribe((notification) => notifications.push(notification));
    service.subscribeApprovals((approval) => approvals.push(approval));
    await service.sendMessage({
      correlationId: 'corr-owned', projectId: 'repo-1', rootPath: 'C:\\repo', threadId: null,
      targetAgentId: 'orchestrator', text: 'Continue.', attachments: [], recommendedModel: null, requestedModel: null
    });

    double.emit({
      type: 'provider_event', correlation_id: 'corr-owned', thread_id: 'thread-foreign', turn_id: 'turn-foreign',
      provider_event: { event_type: 'turn.started' }
    });
    double.emit({
      type: 'model_observed', correlation_id: 'corr-owned', thread_id: 'thread-foreign', turn_id: 'turn-foreign',
      model: 'foreign-model'
    });
    double.emit({
      type: 'turn_started', correlation_id: 'corr-owned', thread_id: 'thread-foreign', turn_id: 'turn-foreign'
    });
    double.emit(approvalEvent({
      correlation_id: 'corr-owned', thread_id: 'thread-foreign', turn_id: 'turn-foreign',
      request_id: adapterApprovalId('8')
    }));
    double.emit({
      type: 'turn_completed', correlation_id: 'corr-owned', thread_id: 'thread-foreign', turn_id: 'turn-foreign',
      status: 'completed'
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(notifications).toEqual([]);
    expect(approvals).toEqual([]);
    expect(double.adapter.listThreadTurns).not.toHaveBeenCalled();
    expect(records.map((record) => record.state)).toEqual([
      'queued', 'thread_ready', 'turn_starting', 'dispatch_accepted'
    ]);

    double.emit({
      type: 'turn_completed', correlation_id: 'corr-owned', thread_id: 'thread-new', turn_id: 'turn-1',
      status: 'completed'
    });
    await vi.waitFor(() => expect(notifications.at(-1)?.kind).toBe('turn_completed'));
    expect(records.at(-1)).toMatchObject({
      state: 'completed', threadId: 'thread-new', turnId: 'turn-1'
    });
  });

  test('keeps an explicitly admitted ownerless inspection thread available to its controller', async () => {
    const double = createAdapterDouble();
    const notifications: Array<Record<string, unknown>> = [];
    const service = new DesktopCodexService({ adapter: double.adapter });
    service.subscribe((notification) => notifications.push(notification));
    await service.startInspection({
      correlationId: 'inspect-owned', projectId: 'repo-1', rootPath: 'C:\\repo',
      kind: 'adversarial_audit', prompt: 'Audit.'
    });

    double.emit({
      type: 'turn_started', correlation_id: 'inspect-owned', thread_id: 'thread-new', turn_id: 'turn-1'
    });
    double.emit({
      type: 'turn_completed', correlation_id: 'inspect-owned', thread_id: 'thread-new', turn_id: 'turn-1',
      status: 'completed'
    });

    await vi.waitFor(() => expect(notifications.at(-1)?.kind).toBe('turn_completed'));
    expect(notifications).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'turn_started', targetAgentId: null }),
      expect.objectContaining({ kind: 'turn_completed', targetAgentId: null })
    ]));
  });

  test('reads the completed thread before emitting one real agent message and never invents one from progress', async () => {
    const double = createAdapterDouble();
    const notifications: Array<Record<string, unknown>> = [];
    const service = new DesktopCodexService({ adapter: double.adapter, now: () => new Date('2026-07-18T00:00:00.000Z') });
    service.subscribe((notification) => notifications.push(notification));
    await service.sendMessage({
      correlationId: 'corr-turn', projectId: 'repo-1', rootPath: 'C:\\repo', threadId: null,
      targetAgentId: 'implementation-002', text: 'Implement.', attachments: [], recommendedModel: null, requestedModel: null
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
    expect(page.items.map((item) => item.text)).toEqual(['Implemented.']);
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
      items: [expect.objectContaining({ id: 'agent-2', text: '完了しました' })],
      nextCursor: 'older-turns'
    });
    const older = await service.listConversation({
      correlationId: 'history-older', threadId: 'thread-history', targetAgentId: 'worker', cursor: newest.nextCursor, limit: 2
    });
    expect(older).toEqual({
      items: [
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

  test('extracts complete bounded structured activities from full provider history', async () => {
    const double = createAdapterDouble();
    double.adapter.listThreadTurns.mockResolvedValue({
      ok: true,
      turns: [{
        id: 'turn-activity', status: 'completed', startedAt: 1_755_388_800, completedAt: 1_755_388_802,
        items: [
          { id: 'user-activity', type: 'userMessage', content: [{ type: 'text', text: '<orquesta_target agent_id="worker">\nDo the work\n</orquesta_target>' }] },
          {
            id: 'command-activity', type: 'commandExecution', status: 'completed', command: 'powershell.exe --token must-not-cross',
            cwd: 'C:\\Users\\kouki\\private', commandActions: [{ type: 'read' }], aggregatedOutput: 'SAFE_ACTIVITY_OUTPUT',
            exitCode: 0, durationMs: 25,
          },
          {
            id: 'file-activity', type: 'fileChange', status: 'completed',
            changes: [{ path: 'C:\\Users\\kouki\\private\\app.ts', kind: 'update', diff: '-old secret\n+new secret' }],
          },
          {
            id: 'tool-activity', type: 'mcpToolCall', status: 'completed', server: 'safe-server', tool: 'lookup',
            arguments: { token: 'must-not-cross' }, result: { content: 'must-not-cross' }, durationMs: 12, success: true,
          },
          { id: 'plan-activity', type: 'plan', text: 'Inspect the contract, then implement the safe card.' },
          { id: 'reasoning-activity', type: 'reasoning', summary: ['must-not-cross'] },
          { id: 'agent-activity', type: 'agentMessage', text: 'Done.' },
        ],
      }],
      next_cursor: null,
      backwards_cursor: null,
    });
    const service = new DesktopCodexService({ adapter: double.adapter });

    const page = await service.listLogicalConversation({
      correlationId: 'history-activity', targetAgentId: 'worker',
      generations: [{
        sessionId: 'session-activity', threadId: 'thread-activity', agentId: 'worker', generation: 1,
        rotationState: 'active', ownershipStatus: 'owner', bindingStatus: 'bound', createdAt: null, updatedAt: null,
      }],
      cursor: null, limit: 50, includeStructuredActivities: true,
    });

    expect(page.structuredActivitiesComplete).toBe(true);
    expect(page.activities?.map((activity) => activity.eventType)).toEqual([
      'command.completed', 'file.change.completed', 'tool.completed', 'plan.updated', 'diff.updated',
    ]);
    expect(page.activities?.every((activity) => activity.targetAgentId === 'worker')).toBe(true);
    expect(page.activities?.find((activity) => activity.eventType === 'plan.updated')?.payload).toMatchObject({
      activity_kind: 'plan', text: 'Inspect the contract, then implement the safe card.', visibility: 'public',
    });
    expect(page.activities?.find((activity) => activity.eventType === 'command.completed')?.payload).toMatchObject({
      activity_kind: 'command', output_text: 'SAFE_ACTIVITY_OUTPUT', output_truncated: false, output_redacted: false,
    });
    const serialized = JSON.stringify(page.activities);
    expect(serialized).not.toContain('must-not-cross');
    expect(serialized).not.toContain('Users\\\\kouki');
    expect(serialized).not.toContain('aggregatedOutput');
    expect(serialized).not.toContain('"arguments":');
    expect(double.adapter.listThreadTurns).toHaveBeenCalledWith(expect.objectContaining({ itemsView: 'full' }));
  });

  test('fails closed instead of declaring malformed structured history complete', async () => {
    const malformedPages = [
      { turns: null, next_cursor: null },
      { turns: [{ status: 'completed', items: [] }], next_cursor: null },
      { turns: [{ id: 'turn-1', status: 'completed', items: null }], next_cursor: null },
      { turns: [{ id: 'turn-1', status: 'completed', items: [{ type: 'commandExecution' }] }], next_cursor: null },
    ];
    for (const malformed of malformedPages) {
      const double = createAdapterDouble();
      double.adapter.listThreadTurns.mockResolvedValue({ ok: true, ...malformed });
      const service = new DesktopCodexService({ adapter: double.adapter });
      await expect(service.listConversation({
        correlationId: 'malformed-history', threadId: 'thread-1', targetAgentId: 'worker',
        cursor: null, limit: 50, includeStructuredActivities: true,
      })).rejects.toThrow(/invalid bounded turn page|incomplete turn/iu);
    }
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
    expect(newest.items.map((item) => item.kind)).toEqual(['message']);
    expect(newest.items[0]).toMatchObject({ id: 'thread-new:agent-1', threadId: 'thread-new', sessionGeneration: 2 });
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
    expect(older.items.map((item) => item.kind)).toEqual(['message', 'session_boundary']);
    expect(older.items[0]).toMatchObject({ id: 'thread-old:agent-1', threadId: 'thread-old', sessionGeneration: 1 });
    expect(older.items[1]).toMatchObject({
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
      status: 'ready', platformFamily: 'windows', userAgent: 'codex-cli/0.144.5',
      providerConnectionId: 'provider-generation-a'
    });
    const serialized = JSON.stringify(await service.getRuntimeInfo({ probe: false }));
    expect(serialized).not.toContain('codexHome');
    expect(serialized).not.toContain('executable');

    await Promise.all([service.shutdown(), service.shutdown()]);
    expect(double.adapter.shutdown).toHaveBeenCalledTimes(1);
  });

  test('drains an admitted ledger write without spawning an adapter after shutdown starts', async () => {
    const double = createAdapterDouble();
    const states: string[] = [];
    let releaseQueued!: () => void;
    const queuedGate = new Promise<void>((resolve) => { releaseQueued = resolve; });
    const service = new DesktopCodexService({
      adapter: double.adapter,
      messageLedger: {
        record: vi.fn(async (entry) => {
          states.push(entry.state);
          if (entry.state === 'queued') await queuedGate;
          return true;
        })
      }
    });
    const send = service.sendMessage({
      correlationId: 'corr-shutdown-race', messageId: 'message-shutdown-race',
      projectId: 'repo-1', rootPath: 'C:\\repo', threadId: null,
      targetAgentId: 'orchestrator', text: 'Do not spawn after shutdown.',
      attachments: [], recommendedModel: null, requestedModel: null
    });
    await vi.waitFor(() => expect(states).toEqual(['queued']));

    const shutdown = service.shutdown();
    releaseQueued();
    await expect(send).rejects.toMatchObject({ code: 'runtime_shutting_down' });
    await expect(shutdown).resolves.toBeUndefined();
    expect(states).toEqual(['queued', 'failed']);
    expect(double.adapter.createThread).not.toHaveBeenCalled();
    expect(double.adapter.startTurn).not.toHaveBeenCalled();
    expect(double.adapter.shutdown).not.toHaveBeenCalled();
  });

  test('reports a terminal event ledger drain failure instead of silently clearing it', async () => {
    const double = createAdapterDouble();
    const service = new DesktopCodexService({
      adapter: double.adapter,
      messageLedger: {
        record: vi.fn(async (entry) => {
          if (entry.state === 'completed') throw new Error('ledger fsync failed');
          return true;
        })
      }
    });
    await service.sendMessage({
      correlationId: 'corr-ledger-drain', projectId: 'repo-1', rootPath: 'C:\\repo', threadId: null,
      targetAgentId: 'orchestrator', text: 'Complete.', attachments: [], recommendedModel: null, requestedModel: null
    });
    double.emit({
      type: 'turn_completed', correlation_id: 'corr-ledger-drain',
      thread_id: 'thread-new', turn_id: 'turn-1', status: 'completed'
    });

    await expect(service.shutdown()).rejects.toThrow('event and ledger drain failed');
    expect(double.adapter.shutdown).toHaveBeenCalledTimes(1);
  });

  test('relays only an exact pending approval response and consumes it once', async () => {
    const double = createAdapterDouble();
    const approvals: Array<Record<string, unknown>> = [];
    const service = new DesktopCodexService({ adapter: double.adapter });
    service.subscribeApprovals((approval) => approvals.push(approval));
    await service.sendMessage({
      correlationId: 'corr-approval', projectId: 'repo-1', rootPath: 'C:\\repo', threadId: null,
      targetAgentId: 'orchestrator', text: 'Edit.', attachments: [], recommendedModel: null, requestedModel: null
    });
    double.emit(approvalEvent());
    await vi.waitFor(() => expect(approvals).toHaveLength(1));
    const publicRequestId = String(approvals[0].requestId);
    expect(publicRequestId).toMatch(/^approval-[a-f0-9]{64}$/u);
    expect(publicRequestId).not.toBe(adapterApprovalId());
    expect(approvals[0]).toMatchObject({
      projectId: 'repo-1', correlationId: 'corr-approval', requestId: publicRequestId,
      method: 'item/fileChange/requestApproval', threadId: 'thread-new', turnId: 'turn-1',
      requestedEffect: { kind: 'file_change', itemId: 'item-1' },
      reason: '[redacted approval reason]', responseOptions: ['accept', 'acceptForSession', 'decline', 'cancel'],
      actionFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u)
    });
    expect(JSON.stringify(approvals[0])).not.toContain('adapterRequestId');

    await expect(service.respondToApproval({
      correlationId: 'respond-1', requestId: publicRequestId,
      providerConnectionId: 'provider-test', decision: 'acceptForSession'
    })).resolves.toEqual({ requestId: publicRequestId, providerConnectionId: 'provider-test', decision: 'acceptForSession' });
    expect(double.adapter.respondToApproval).toHaveBeenCalledWith({
      correlationId: 'corr-approval', requestId: adapterApprovalId(), method: 'item/fileChange/requestApproval',
      threadId: 'thread-new', turnId: 'turn-1', decision: 'acceptForSession'
    });
    await expect(service.respondToApproval({
      correlationId: 'respond-2', requestId: publicRequestId,
      providerConnectionId: 'provider-test', decision: 'accept'
    })).rejects.toThrow('previously submitted decision');
  });

  test('retries a definitive provider preflight failure with a new decision', async () => {
    const double = createAdapterDouble();
    vi.mocked(double.adapter.respondToApproval)
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'runtime_failed', message: 'preflight mismatch' },
        evidence: { approval_response_phase: 'pre_provider' },
      } as never)
      .mockResolvedValueOnce({ ok: true } as never);
    const approvals: Array<Record<string, unknown>> = [];
    const service = new DesktopCodexService({ adapter: double.adapter });
    service.subscribeApprovals((approval) => approvals.push(approval));
    await service.sendMessage({
      correlationId: 'corr-preflight', projectId: 'repo-1', rootPath: 'C:\\repo', threadId: null,
      targetAgentId: 'orchestrator', text: 'Edit.', attachments: [], recommendedModel: null, requestedModel: null
    });
    double.emit(approvalEvent({ correlation_id: 'corr-preflight' }));
    await vi.waitFor(() => expect(approvals).toHaveLength(1));
    const requestId = String(approvals[0].requestId);
    await expect(service.respondToApproval({
      correlationId: 'first', requestId, providerConnectionId: 'provider-test', decision: 'decline'
    })).rejects.toMatchObject({ name: 'ApprovalPreflightError' });
    await expect(service.respondToApproval({
      correlationId: 'second', requestId, providerConnectionId: 'provider-test', decision: 'accept'
    })).resolves.toEqual({ requestId, providerConnectionId: 'provider-test', decision: 'accept' });
    expect(double.adapter.respondToApproval).toHaveBeenCalledTimes(2);
  });

  test('rejects an invented approval option and never auto-responds during shutdown', async () => {
    const double = createAdapterDouble();
    const service = new DesktopCodexService({ adapter: double.adapter });
    const approvals: Array<Record<string, unknown>> = [];
    service.subscribeApprovals((approval) => approvals.push(approval));
    await service.sendMessage({
      correlationId: 'corr-approval', projectId: 'repo-1', rootPath: 'C:\\repo', threadId: null,
      targetAgentId: 'orchestrator', text: 'Edit.', attachments: [], recommendedModel: null, requestedModel: null
    });
    double.emit(approvalEvent({ request_id: adapterApprovalId('b'), response_options: ['accept', 'decline'] }));
    await vi.waitFor(() => expect(approvals).toHaveLength(1));

    await expect(service.respondToApproval({
      correlationId: 'respond-invalid', requestId: String(approvals[0].requestId),
      providerConnectionId: 'provider-test', decision: 'allow'
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
      targetAgentId: 'orchestrator', text: 'Continue.', attachments: [], recommendedModel: null, requestedModel: null
    });
    const adapterId = adapterApprovalId(decision === 'accept' ? 'c' : decision === 'decline' ? 'd' : 'e');
    double.emit(approvalEvent({
      correlation_id: `corr-${decision}`,
      request_id: adapterId,
      method: 'item/commandExecution/requestApproval',
      requested_effect: { kind: 'command_execution', item_id: `item-${decision}` },
      response_options: ['accept', 'decline', 'cancel']
    }));
    await vi.waitFor(() => expect(approvals).toHaveLength(1));
    await service.respondToApproval({
      correlationId: `respond-${decision}`, requestId: String(approvals[0].requestId),
      providerConnectionId: 'provider-test', decision
    });
    expect(double.adapter.respondToApproval).toHaveBeenCalledWith(expect.objectContaining({ requestId: adapterId, decision }));
    await service.shutdown();
  });

  test('single-flights an exact approval retry and writes one adapter response', async () => {
    const double = createAdapterDouble();
    const approvals: Array<Record<string, unknown>> = [];
    const service = new DesktopCodexService({ adapter: double.adapter });
    service.subscribeApprovals((approval) => approvals.push(approval));
    await service.sendMessage({
      correlationId: 'corr-single-flight', projectId: 'repo-1', rootPath: 'C:\\repo', threadId: null,
      targetAgentId: 'orchestrator', text: 'Continue.', attachments: [], recommendedModel: null, requestedModel: null
    });
    double.emit(approvalEvent({
      correlation_id: 'corr-single-flight',
      request_id: adapterApprovalId('f')
    }));
    await vi.waitFor(() => expect(approvals).toHaveLength(1));
    const requestId = String(approvals[0].requestId);

    await expect(Promise.all([
      service.respondToApproval({ correlationId: 'ui-1', requestId, providerConnectionId: 'provider-test', decision: 'decline' }),
      service.respondToApproval({ correlationId: 'ui-2', requestId, providerConnectionId: 'provider-test', decision: 'decline' })
    ])).resolves.toEqual([
      { requestId, providerConnectionId: 'provider-test', decision: 'decline' },
      { requestId, providerConnectionId: 'provider-test', decision: 'decline' }
    ]);
    expect(double.adapter.respondToApproval).toHaveBeenCalledTimes(1);
  });

  test.each([
    { type: 'turn_completed', status: 'completed' },
    { type: 'runtime_error', will_retry: false },
    { type: 'approval_expired', reason: 'provider_connection_lost' }
  ])('expires service approval identity before a terminal $type response', async (terminal) => {
    const double = createAdapterDouble();
    const approvals: Array<Record<string, unknown>> = [];
    const expirations = vi.fn();
    const service = new DesktopCodexService({ adapter: double.adapter });
    service.subscribeApprovals((approval) => approvals.push(approval));
    service.subscribeApprovalExpirations(expirations);
    await service.sendMessage({
      correlationId: 'corr-terminal', projectId: 'repo-1', rootPath: 'C:\\repo', threadId: null,
      targetAgentId: 'orchestrator', text: 'Continue.', attachments: [], recommendedModel: null, requestedModel: null
    });
    double.emit(approvalEvent({
      correlation_id: 'corr-terminal',
      request_id: adapterApprovalId('9')
    }));
    await vi.waitFor(() => expect(approvals).toHaveLength(1));
    double.emit({
      ...terminal,
      correlation_id: 'corr-terminal',
      thread_id: 'thread-new',
      turn_id: 'turn-1'
    });
    await vi.waitFor(() => expect(expirations).toHaveBeenCalledWith('thread-new', 'turn-1'));

    await expect(service.respondToApproval({
      correlationId: 'ui-after-terminal',
      requestId: String(approvals[0].requestId),
      decision: 'decline'
    })).rejects.toThrow('pending');
    expect(double.adapter.respondToApproval).not.toHaveBeenCalled();
  });

  test('rejects a non-canonical adapter approval ID instead of forwarding provider identity', async () => {
    const double = createAdapterDouble();
    const approvals = vi.fn();
    const service = new DesktopCodexService({ adapter: double.adapter });
    service.subscribeApprovals(approvals);
    await service.sendMessage({
      correlationId: 'corr-raw-id', projectId: 'repo-1', rootPath: 'C:\\repo', threadId: null,
      targetAgentId: 'orchestrator', text: 'Continue.', attachments: [], recommendedModel: null, requestedModel: null
    });
    double.emit(approvalEvent({ correlation_id: 'corr-raw-id', request_id: 'raw-provider-id' }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(approvals).not.toHaveBeenCalled();
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
