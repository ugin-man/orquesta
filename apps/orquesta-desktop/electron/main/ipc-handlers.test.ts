import { describe, expect, test, vi } from 'vitest';
import { DESKTOP_IPC } from '../shared/host-contract';
import { registerDesktopIpc } from './ipc-handlers';

describe('registerDesktopIpc', () => {
  test('registers only the bounded desktop channels', async () => {
    const handlers = new Map<string, (event: unknown, input?: unknown) => unknown>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (event: unknown, input?: unknown) => unknown) => {
        handlers.set(channel, handler);
      })
    };
    const coreHost = {
      status: vi.fn(() => 'ready' as const),
      ping: vi.fn(async (correlationId: string) => ({ correlationId }))
    };

    registerDesktopIpc(ipcMain, coreHost);

    expect([...handlers.keys()]).toEqual([DESKTOP_IPC.getHostInfo, DESKTOP_IPC.pingCore]);
    await expect(handlers.get(DESKTOP_IPC.getHostInfo)?.({})).resolves.toEqual({
      platform: 'win32',
      coreStatus: 'ready'
    });
    await expect(handlers.get(DESKTOP_IPC.pingCore)?.({}, { correlationId: 'ping-1' })).resolves.toEqual({
      correlationId: 'ping-1'
    });
  });

  test('rejects malformed ping input without reaching Core', async () => {
    const handlers = new Map<string, (event: unknown, input?: unknown) => unknown>();
    const ipcMain = {
      handle(channel: string, handler: (event: unknown, input?: unknown) => unknown) {
        handlers.set(channel, handler);
      }
    };
    const coreHost = { status: () => 'ready' as const, ping: vi.fn() };
    registerDesktopIpc(ipcMain, coreHost);

    await expect(handlers.get(DESKTOP_IPC.pingCore)?.({}, { correlationId: '' })).rejects.toThrow('correlationId');
    expect(coreHost.ping).not.toHaveBeenCalled();
  });
});
