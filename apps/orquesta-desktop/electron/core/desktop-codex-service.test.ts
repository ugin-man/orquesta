import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';

import { DesktopCodexService, type CanonicalCodexAdapter } from './desktop-codex-service';

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
      model_evidence: {
        recommended_model: input.recommendedModel ?? null,
        requested_model: input.requestedModel ?? null,
        applied_model: input.params?.model ?? null,
        actual_model: null
      }
    })),
    startTurn: vi.fn(async (input) => ({ ok: true, thread_id: input.threadId, turn_id: 'turn-1' })),
    readThread: vi.fn(async (input) => ({ ok: true, thread_id: input.threadId, thread: thread(input.threadId) })),
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
  test('creates a coordinator thread, routes the target privately, and keeps model evidence separate', async () => {
    const double = createAdapterDouble();
    const service = new DesktopCodexService({ adapter: double.adapter });
    const result = await service.sendMessage({
      correlationId: 'corr-send',
      projectId: 'repo-1',
      rootPath: 'C:\\repo',
      threadId: null,
      targetAgentId: 'implementation-002',
      text: 'Implement the accepted slice.',
      localImagePaths: ['C:\\images\\reference.png'],
      recommendedModel: 'recommended-model',
      requestedModel: 'requested-model'
    });

    expect(double.adapter.createThread).toHaveBeenCalledWith({
      correlationId: 'corr-send:thread',
      recommendedModel: 'recommended-model',
      requestedModel: 'requested-model',
      params: { cwd: 'C:\\repo', model: 'requested-model' }
    });
    expect(double.adapter.startTurn).toHaveBeenCalledWith({
      correlationId: 'corr-send',
      threadId: 'thread-new',
      input: [
        { type: 'text', text: '<orquesta_target agent_id="implementation-002">\nImplement the accepted slice.\n</orquesta_target>', text_elements: [] },
        { type: 'localImage', path: 'C:\\images\\reference.png' }
      ]
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
      params: { cwd: 'C:\\repo' }
    });
    expect(double.adapter.createThread).not.toHaveBeenCalled();
    expect(result.threadId).toBe('thread-saved');
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

    double.emit({ type: 'progress_observed', correlation_id: 'corr-turn', thread_id: 'thread-new', turn_id: 'turn-1', item: { text: 'not a reply' } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(notifications.some((item) => item.kind === 'agent_message')).toBe(false);

    double.emit({ type: 'turn_completed', correlation_id: 'corr-turn', thread_id: 'thread-new', turn_id: 'turn-1' });
    await vi.waitFor(() => expect(notifications.map((item) => item.kind)).toEqual(['agent_message', 'turn_completed']));
    expect(notifications[0]).toMatchObject({ kind: 'agent_message', text: 'Implemented.', targetAgentId: 'implementation-002' });
    expect(double.adapter.readThread).toHaveBeenCalledTimes(1);

    const page = await service.listConversation({
      correlationId: 'corr-history', threadId: 'thread-new', targetAgentId: 'implementation-002', limit: 20
    });
    expect(page.items.map((item) => item.text)).toEqual(['Implement.', 'Implemented.']);
    expect(JSON.stringify(page)).not.toContain('orquesta_target');
    expect(notifications.map((item) => item.kind)).toEqual(['agent_message', 'turn_completed']);
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
