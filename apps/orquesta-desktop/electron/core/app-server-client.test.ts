import { EventEmitter } from 'node:events';
import { describe, expect, test, vi } from 'vitest';
import { AppServerClient, type AppServerProcess } from './app-server-client';

class FakeStream extends EventEmitter {
  write = vi.fn((_source: string) => true);
  end = vi.fn();
}

class FakeProcess extends EventEmitter implements AppServerProcess {
  readonly stdin = new FakeStream();
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  readonly kill = vi.fn(() => true);
}

function written(process: FakeProcess): Array<Record<string, unknown>> {
  return process.stdin.write.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
}

describe('AppServerClient', () => {
  test('initializes once and correlates stable JSONL requests', async () => {
    const process = new FakeProcess();
    process.stdin.write.mockImplementation((source: string) => {
      const message = JSON.parse(source) as { id?: number; method: string };
      if (message.method === 'initialize') queueMicrotask(() => process.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: message.id, result: { userAgent: 'codex' } })}\n`)));
      if (message.method === 'thread/start') queueMicrotask(() => process.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: message.id, result: { thread: { id: 'thread-1' }, model: 'gpt-current' } })}\n`)));
      return true;
    });
    const client = new AppServerClient({ executablePath: 'codex.exe', spawn: vi.fn(() => process) });

    await client.start();
    await expect(client.request('thread/start', { cwd: 'C:\\repo' })).resolves.toMatchObject({ thread: { id: 'thread-1' } });

    expect(written(process).map((message) => message.method)).toEqual(['initialize', 'initialized', 'thread/start']);
  });

  test('forwards notifications and rejects unsupported server requests without hanging', async () => {
    const process = new FakeProcess();
    process.stdin.write.mockImplementation((source: string) => {
      const message = JSON.parse(source) as { id?: number; method: string };
      if (message.method === 'initialize') queueMicrotask(() => process.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: message.id, result: {} })}\n`)));
      return true;
    });
    const client = new AppServerClient({ executablePath: 'codex.exe', spawn: () => process });
    const listener = vi.fn();
    client.subscribe(listener);
    await client.start();

    process.stdout.emit('data', Buffer.from(`${JSON.stringify({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } })}\n`));
    process.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: 77, method: 'item/commandExecution/requestApproval', params: { itemId: 'item-1' } })}\n`));

    expect(listener).toHaveBeenCalledWith({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } });
    expect(written(process).at(-1)).toEqual({ id: 77, error: { code: -32601, message: 'Client request is not supported by Orquesta Desktop' } });
  });

  test('rejects pending requests when the process exits', async () => {
    const process = new FakeProcess();
    process.stdin.write.mockImplementation((source: string) => {
      const message = JSON.parse(source) as { id?: number; method: string };
      if (message.method === 'initialize') queueMicrotask(() => process.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: message.id, result: {} })}\n`)));
      return true;
    });
    const client = new AppServerClient({ executablePath: 'codex.exe', spawn: () => process });
    await client.start();

    const pending = client.request('thread/read', { threadId: 'thread-1' });
    await vi.waitFor(() => expect(written(process).some((message) => message.method === 'thread/read')).toBe(true));
    process.emit('exit', 1, null);
    await expect(pending).rejects.toThrow('exited');
  });

  test('closes stdin first and avoids a forced kill when app-server exits cleanly', async () => {
    const process = new FakeProcess();
    process.stdin.write.mockImplementation((source: string) => {
      const message = JSON.parse(source) as { id?: number; method: string };
      if (message.method === 'initialize') queueMicrotask(() => process.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: message.id, result: {} })}\n`)));
      return true;
    });
    const client = new AppServerClient({ executablePath: 'codex.exe', spawn: () => process });
    await client.start();

    const stopped = client.stop();
    expect(process.stdin.end).toHaveBeenCalledOnce();
    expect(process.kill).not.toHaveBeenCalled();
    process.emit('exit', 0, null);
    await stopped;
    expect(process.kill).not.toHaveBeenCalled();
  });
});
