import { EventEmitter } from 'node:events';
import { describe, expect, test, vi } from 'vitest';
import { fixtureCatalog } from '../../src/fixtures';
import { CoreHost, type CoreChildProcess } from './core-host';

class FakeCoreChild extends EventEmitter implements CoreChildProcess {
  readonly postMessage = vi.fn();
  readonly kill = vi.fn(() => true);
}

describe('CoreHost', () => {
  test('starts Core lazily on the first request', async () => {
    const child = new FakeCoreChild();
    const fork = vi.fn(() => child);
    const host = new CoreHost({ coreEntryPath: 'core.cjs', fork });

    const pending = host.ping('lazy-ping');
    expect(host.status()).toBe('starting');
    expect(fork).toHaveBeenCalledOnce();
    child.emit('message', { type: 'core.ready', version: 1 });
    await Promise.resolve();
    child.emit('message', { type: 'core.pong', correlationId: 'lazy-ping' });

    await expect(pending).resolves.toEqual({ correlationId: 'lazy-ping' });
  });

  test('becomes ready only after a validated ready event', () => {
    const child = new FakeCoreChild();
    const fork = vi.fn(() => child);
    const host = new CoreHost({ coreEntryPath: 'core.cjs', fork });

    host.start();
    expect(fork).toHaveBeenCalledWith('core.cjs');
    expect(host.status()).toBe('starting');

    child.emit('message', { type: 'core.ready', version: '1' });
    expect(host.status()).toBe('starting');

    child.emit('message', { type: 'core.ready', version: 1 });
    expect(host.status()).toBe('ready');
  });

  test('resolves a ping only from the matching pong', async () => {
    const child = new FakeCoreChild();
    const host = new CoreHost({ coreEntryPath: 'core.cjs', fork: () => child });
    host.start();
    child.emit('message', { type: 'core.ready', version: 1 });

    const pending = host.ping('ping-1');
    expect(child.postMessage).toHaveBeenCalledWith({ type: 'core.ping', correlationId: 'ping-1' });

    child.emit('message', { type: 'core.pong', correlationId: 'other' });
    child.emit('message', { type: 'core.pong', correlationId: 'ping-1' });

    await expect(pending).resolves.toEqual({ correlationId: 'ping-1' });
  });

  test('accepts a runtime dispatch only after the Core returns thread and turn evidence', async () => {
    const child = new FakeCoreChild();
    const host = new CoreHost({ coreEntryPath: 'core.cjs', fork: () => child });
    host.start();
    child.emit('message', { type: 'core.ready', version: 1 });

    const pending = host.sendMessage({ projectId: 'repo-1', rootPath: 'C:\\repo', threadId: null, targetAgentId: 'orchestrator', text: 'Continue.', localImagePaths: [] });
    const request = child.postMessage.mock.calls.at(-1)?.[0] as { correlationId: string };
    const modelEvidence = {
      recommendedModel: null, requestedModel: 'requested', appliedModel: 'requested', actualModel: null,
      actualModelEvidence: 'unknown'
    };
    child.emit('message', { type: 'runtime.dispatch.accepted', correlationId: request.correlationId, threadId: 'thread-1', turnId: 'turn-1', modelEvidence });

    await expect(pending).resolves.toEqual({ correlationId: request.correlationId, threadId: 'thread-1', turnId: 'turn-1', modelEvidence });
  });

  test('sends Luca through its dedicated Core request', async () => {
    const child = new FakeCoreChild();
    const host = new CoreHost({ coreEntryPath: 'core.cjs', fork: () => child });
    host.start();
    child.emit('message', { type: 'core.ready', version: 1 });

    const pending = host.sendLucaQuestion({
      projectId: 'repo-1', rootPath: 'C:\\repo', threadId: null,
      prompt: '{"protocol":"orquesta.luca.ask.v1"}'
    });
    const request = child.postMessage.mock.calls.at(-1)?.[0] as { correlationId: string };
    expect(request).toMatchObject({
      type: 'runtime.luca.send', projectId: 'repo-1', rootPath: 'C:\\repo', threadId: null
    });
    const modelEvidence = {
      recommendedModel: 'Luna', requestedModel: 'gpt-5.6-luna', appliedModel: 'gpt-5.6-luna', actualModel: null,
      actualModelEvidence: 'unknown'
    };
    child.emit('message', {
      type: 'runtime.dispatch.accepted', correlationId: request.correlationId,
      threadId: 'thread-luca', turnId: 'turn-luca', modelEvidence
    });

    await expect(pending).resolves.toMatchObject({ threadId: 'thread-luca', turnId: 'turn-luca' });
  });

  test('returns typed runtime information without exposing the Core request channel', async () => {
    const child = new FakeCoreChild();
    const host = new CoreHost({ coreEntryPath: 'core.cjs', fork: () => child });
    host.start();
    child.emit('message', { type: 'core.ready', version: 1 });

    const pending = host.getRuntimeInfo({ probe: false });
    const request = child.postMessage.mock.calls.at(-1)?.[0] as { correlationId: string };
    expect(request).toMatchObject({ type: 'runtime.info', probe: false });
    const info = {
      status: 'not_started' as const, adapter: 'app_server' as const, sdkVersion: '0.144.5', codexVersion: '0.144.5',
      runtimeVersion: '0.144.5-win32-x64', targetTriple: 'x86_64-pc-windows-msvc',
      platformFamily: null, platformOs: null, userAgent: null, integrity: 'verified' as const
    };
    child.emit('message', { type: 'runtime.info.result', correlationId: request.correlationId, info });

    await expect(pending).resolves.toEqual(info);
  });

  test('binds setup account reads and login starts to matching Core results', async () => {
    const child = new FakeCoreChild();
    const host = new CoreHost({ coreEntryPath: 'core.cjs', fork: () => child });
    host.start();
    child.emit('message', { type: 'core.ready', version: 1 });

    const account = host.readSetupAccount();
    const accountRequest = child.postMessage.mock.calls.at(-1)?.[0] as { correlationId: string };
    expect(accountRequest).toMatchObject({ type: 'setup.account.read' });
    child.emit('message', {
      type: 'setup.account.result', correlationId: accountRequest.correlationId,
      account: { status: 'authenticated', accountType: 'chatgpt', requiresOpenaiAuth: true }
    });
    await expect(account).resolves.toMatchObject({ status: 'authenticated', accountType: 'chatgpt' });

    const login = host.startSetupLogin();
    const loginRequest = child.postMessage.mock.calls.at(-1)?.[0] as { correlationId: string };
    expect(loginRequest).toMatchObject({ type: 'setup.account.login.start' });
    child.emit('message', {
      type: 'setup.account.login.started', correlationId: loginRequest.correlationId,
      login: { type: 'chatgpt', loginId: 'login-1', authUrl: 'https://auth.openai.com/authorize' }
    });
    await expect(login).resolves.toMatchObject({ type: 'chatgpt', loginId: 'login-1' });
  });

  test('forwards bounded runtime notifications and conversation pages', async () => {
    const child = new FakeCoreChild();
    const host = new CoreHost({ coreEntryPath: 'core.cjs', fork: () => child });
    host.start();
    child.emit('message', { type: 'core.ready', version: 1 });
    const listener = vi.fn();
    host.subscribeRuntime(listener);

    const pending = host.listConversation({ threadId: 'thread-1', targetAgentId: 'orchestrator', limit: 20 });
    const request = child.postMessage.mock.calls.at(-1)?.[0] as { correlationId: string };
    child.emit('message', { type: 'runtime.conversation.result', correlationId: request.correlationId, page: { items: [], nextCursor: null } });
    const notification = {
      kind: 'turn_started' as const, threadId: 'thread-1', turnId: 'turn-1', text: null, targetAgentId: null,
      modelEvidence: { recommendedModel: null, requestedModel: null, appliedModel: null, actualModel: null, actualModelEvidence: 'unknown' as const }
    };
    child.emit('message', { type: 'runtime.notification', notification });

    await expect(pending).resolves.toEqual({ items: [], nextCursor: null });
    expect(listener).toHaveBeenCalledWith(notification);
  });

  test('starts lazily for repository selection and forwards Core snapshot changes', async () => {
    const child = new FakeCoreChild();
    const host = new CoreHost({ coreEntryPath: 'core.cjs', fork: () => child });
    const listener = vi.fn();
    host.subscribeRepository(listener);

    const pending = host.selectRepository('repo-1', 'C:\\repo');
    expect(host.status()).toBe('starting');
    child.emit('message', { type: 'core.ready', version: 1 });
    await Promise.resolve();
    const request = child.postMessage.mock.calls.at(-1)?.[0] as { correlationId: string };
    expect(request).toMatchObject({ type: 'repository.select', projectId: 'repo-1', rootPath: 'C:\\repo' });
    const snapshot = fixtureCatalog['active-project'].snapshot;
    child.emit('message', { type: 'repository.snapshot.result', correlationId: request.correlationId, snapshot });
    await expect(pending).resolves.toEqual(snapshot);

    child.emit('message', { type: 'repository.snapshot.changed', snapshot });
    expect(listener).toHaveBeenCalledWith(snapshot);
  });

  test('binds approval responses and resolved attention history to matching Core results', async () => {
    const child = new FakeCoreChild();
    const host = new CoreHost({ coreEntryPath: 'core.cjs', fork: () => child });
    host.start();
    child.emit('message', { type: 'core.ready', version: 1 });

    const response = host.respondRuntimeApproval({ attentionId: 'runtime-approval-1', decision: 'decline' });
    const responseRequest = child.postMessage.mock.calls.at(-1)?.[0] as { correlationId: string };
    expect(responseRequest).toMatchObject({
      type: 'runtime.approval.respond', attentionId: 'runtime-approval-1', decision: 'decline'
    });
    child.emit('message', {
      type: 'runtime.approval.accepted', correlationId: responseRequest.correlationId,
      attentionId: 'runtime-approval-1', decision: 'decline'
    });
    await expect(response).resolves.toMatchObject({ correlationId: responseRequest.correlationId, decision: 'decline' });

    const history = host.listAttentionHistory();
    const historyRequest = child.postMessage.mock.calls.at(-1)?.[0] as { correlationId: string };
    child.emit('message', {
      type: 'repository.attention-history.result', correlationId: historyRequest.correlationId, items: []
    });
    await expect(history).resolves.toEqual([]);
  });

  test('binds inspection start, cancel and report reads to matching Core results', async () => {
    const child = new FakeCoreChild();
    const host = new CoreHost({ coreEntryPath: 'core.cjs', fork: () => child });
    host.start();
    child.emit('message', { type: 'core.ready', version: 1 });

    const started = host.startInspection({
      projectId: 'repo-1', rootPath: 'C:\\repo', kind: 'external_benchmark',
      target: { kind: 'project', ids: [] }, focus: 'cost'
    });
    const startRequest = child.postMessage.mock.calls.at(-1)?.[0] as { correlationId: string };
    expect(startRequest).toMatchObject({ type: 'inspection.start', projectId: 'repo-1', rootPath: 'C:\\repo' });
    child.emit('message', { type: 'inspection.action.accepted', correlationId: startRequest.correlationId, runId: 'BENCH-001' });
    await expect(started).resolves.toEqual({ correlationId: startRequest.correlationId, runId: 'BENCH-001' });

    const cancelled = host.cancelInspection({ projectId: 'repo-1', rootPath: 'C:\\repo', runId: 'BENCH-001' });
    const cancelRequest = child.postMessage.mock.calls.at(-1)?.[0] as { correlationId: string };
    child.emit('message', { type: 'inspection.action.accepted', correlationId: cancelRequest.correlationId, runId: 'BENCH-001' });
    await expect(cancelled).resolves.toEqual({ correlationId: cancelRequest.correlationId, runId: 'BENCH-001' });

    const report = host.readInspectionReport({ projectId: 'repo-1', rootPath: 'C:\\repo', runId: 'BENCH-001' });
    const reportRequest = child.postMessage.mock.calls.at(-1)?.[0] as { correlationId: string };
    child.emit('message', {
      type: 'inspection.report.result', correlationId: reportRequest.correlationId,
      runId: 'BENCH-001', markdown: '# Benchmark'
    });
    await expect(report).resolves.toEqual({ runId: 'BENCH-001', markdown: '# Benchmark' });
  });

  test('requests a clean shutdown and kills after the bounded timeout', async () => {
    vi.useFakeTimers();
    const child = new FakeCoreChild();
    const host = new CoreHost({ coreEntryPath: 'core.cjs', fork: () => child, shutdownTimeoutMs: 25 });
    host.start();

    const stopped = host.stop();
    expect(child.postMessage).toHaveBeenCalledWith({ type: 'core.shutdown' });
    await vi.advanceTimersByTimeAsync(25);
    await stopped;

    expect(child.kill).toHaveBeenCalledOnce();
    expect(host.status()).toBe('stopped');
    vi.useRealTimers();
  });

  test('can stop a new child after a completed stop and restart', async () => {
    const firstChild = new FakeCoreChild();
    const secondChild = new FakeCoreChild();
    const children = [firstChild, secondChild];
    const host = new CoreHost({ coreEntryPath: 'core.cjs', fork: () => children.shift()! });

    host.start();
    const firstStop = host.stop();
    firstChild.emit('message', { type: 'core.stopped' });
    await firstStop;

    host.start();
    const secondStop = host.stop();
    expect(secondChild.postMessage).toHaveBeenCalledWith({ type: 'core.shutdown' });
    secondChild.emit('message', { type: 'core.stopped' });
    await secondStop;
  });

  test('ignores a late exit from the previous child after restart', async () => {
    const firstChild = new FakeCoreChild();
    const secondChild = new FakeCoreChild();
    const children = [firstChild, secondChild];
    const host = new CoreHost({ coreEntryPath: 'core.cjs', fork: () => children.shift()! });

    host.start();
    const firstStop = host.stop();
    firstChild.emit('message', { type: 'core.stopped' });
    await firstStop;

    host.start();
    firstChild.emit('exit', 0);
    expect(host.status()).toBe('starting');

    secondChild.emit('message', { type: 'core.ready', version: 1 });
    expect(host.status()).toBe('ready');
  });
});
