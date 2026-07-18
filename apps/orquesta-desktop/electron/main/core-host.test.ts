import { EventEmitter } from 'node:events';
import { describe, expect, test, vi } from 'vitest';
import { CoreHost, type CoreChildProcess } from './core-host';

class FakeCoreChild extends EventEmitter implements CoreChildProcess {
  readonly postMessage = vi.fn();
  readonly kill = vi.fn(() => true);
}

describe('CoreHost', () => {
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
});
