import { describe, expect, test, vi } from 'vitest';
import { handleCoreRequest } from './handler';

describe('handleCoreRequest', () => {
  test('answers a bounded ping with a matching pong', () => {
    const send = vi.fn();
    const stop = vi.fn();
    const dispatch = vi.fn();

    expect(handleCoreRequest({ type: 'core.ping', correlationId: 'ping-1' }, { send, stop, dispatch })).toBe(true);
    expect(send).toHaveBeenCalledWith({ type: 'core.pong', correlationId: 'ping-1' });
    expect(stop).not.toHaveBeenCalled();
  });

  test('stops only for a valid shutdown request', () => {
    const send = vi.fn();
    const stop = vi.fn();
    const dispatch = vi.fn();

    expect(handleCoreRequest({ type: 'core.shutdown' }, { send, stop, dispatch })).toBe(true);
    expect(stop).toHaveBeenCalledOnce();
    expect(handleCoreRequest({ type: 'core.execute', command: 'whoami' }, { send, stop, dispatch })).toBe(false);
  });

  test('dispatches only validated runtime requests', () => {
    const handlers = { send: vi.fn(), stop: vi.fn(), dispatch: vi.fn() };
    const request = {
      type: 'runtime.send', correlationId: 'send-1', projectId: 'repo-1', rootPath: 'C:\\repo', threadId: null,
      targetAgentId: 'orchestrator', text: 'Continue.', localImagePaths: []
    };
    expect(handleCoreRequest(request, handlers)).toBe(true);
    expect(handlers.dispatch).toHaveBeenCalledWith(request);
    expect(handleCoreRequest({ ...request, rootPath: '' }, handlers)).toBe(false);
  });

  test('dispatches a typed non-secret runtime information request', () => {
    const handlers = { send: vi.fn(), stop: vi.fn(), dispatch: vi.fn() };
    const request = { type: 'runtime.info', correlationId: 'info-1', probe: false } as const;
    expect(handleCoreRequest(request, handlers)).toBe(true);
    expect(handlers.dispatch).toHaveBeenCalledWith(request);
    expect(handleCoreRequest({ ...request, probe: 'yes' }, handlers)).toBe(false);
  });
});
