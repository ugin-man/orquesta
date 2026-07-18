import { describe, expect, test, vi } from 'vitest';
import { DESKTOP_IPC } from '../shared/host-contract';
import { createDesktopHostApi } from './host-api';

describe('createDesktopHostApi', () => {
  test('exposes bounded methods instead of raw IPC', async () => {
    const invoke = vi.fn(async (channel: string, input?: unknown) => {
      if (channel === DESKTOP_IPC.getHostInfo) return { platform: 'win32', coreStatus: 'ready' };
      return input;
    });
    const api = createDesktopHostApi(invoke);

    await expect(api.getHostInfo()).resolves.toEqual({ platform: 'win32', coreStatus: 'ready' });
    await expect(api.pingCore('ping-1')).resolves.toEqual({ correlationId: 'ping-1' });
    expect(invoke.mock.calls).toEqual([
      [DESKTOP_IPC.getHostInfo],
      [DESKTOP_IPC.pingCore, { correlationId: 'ping-1' }]
    ]);
    expect(api).not.toHaveProperty('invoke');
    expect(api).not.toHaveProperty('send');
  });

  test('rejects an empty correlation id before IPC', async () => {
    const invoke = vi.fn();
    const api = createDesktopHostApi(invoke);

    await expect(api.pingCore('')).rejects.toThrow('correlationId');
    expect(invoke).not.toHaveBeenCalled();
  });
});
