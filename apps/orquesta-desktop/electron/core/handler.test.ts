import { describe, expect, test, vi } from 'vitest';
import { handleCoreRequest } from './handler';

describe('handleCoreRequest', () => {
  test('answers a bounded ping with a matching pong', () => {
    const send = vi.fn();
    const stop = vi.fn();

    expect(handleCoreRequest({ type: 'core.ping', correlationId: 'ping-1' }, { send, stop })).toBe(true);
    expect(send).toHaveBeenCalledWith({ type: 'core.pong', correlationId: 'ping-1' });
    expect(stop).not.toHaveBeenCalled();
  });

  test('stops only for a valid shutdown request', () => {
    const send = vi.fn();
    const stop = vi.fn();

    expect(handleCoreRequest({ type: 'core.shutdown' }, { send, stop })).toBe(true);
    expect(stop).toHaveBeenCalledOnce();
    expect(handleCoreRequest({ type: 'core.execute', command: 'whoami' }, { send, stop })).toBe(false);
  });
});
