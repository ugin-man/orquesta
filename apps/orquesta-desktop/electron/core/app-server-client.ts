import { spawn as nodeSpawn } from 'node:child_process';

type JsonObject = Record<string, unknown>;

interface WritableProcessStream {
  write(source: string): boolean;
  end(): void;
}

interface ReadableProcessStream {
  on(event: 'data', listener: (chunk: Buffer | string) => void): this;
}

export interface AppServerProcess {
  stdin: WritableProcessStream;
  stdout: ReadableProcessStream;
  stderr: ReadableProcessStream;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  kill(): boolean;
}

export interface AppServerClientOptions {
  executablePath: string;
  argsPrefix?: string[];
  spawn?: (executablePath: string, args: string[]) => AppServerProcess;
  requestTimeoutMs?: number;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

function object(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

function defaultSpawn(executablePath: string, args: string[]): AppServerProcess {
  return nodeSpawn(executablePath, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  }) as AppServerProcess;
}

export class AppServerClient {
  readonly #options: Required<Pick<AppServerClientOptions, 'requestTimeoutMs' | 'spawn'>> & AppServerClientOptions;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #listeners = new Set<(notification: JsonObject) => void>();
  #process: AppServerProcess | null = null;
  #startPromise: Promise<void> | null = null;
  #nextId = 1;
  #stdoutBuffer = '';
  #stderrTail = '';
  #stopping = false;
  #stopPromise: Promise<void> | null = null;
  #resolveStop: (() => void) | null = null;
  #stopTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: AppServerClientOptions) {
    this.#options = {
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
      spawn: options.spawn ?? defaultSpawn,
      ...options
    };
  }

  subscribe(listener: (notification: JsonObject) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.#process && this.#startPromise) return this.#startPromise;
    if (this.#startPromise) return this.#startPromise;
    this.#stopping = false;
    this.#startPromise = this.#startInternal();
    try {
      await this.#startPromise;
    } catch (error) {
      this.#startPromise = null;
      throw error;
    }
  }

  async #startInternal(): Promise<void> {
    let process: AppServerProcess;
    try {
      process = this.#options.spawn(this.#options.executablePath, [...(this.#options.argsPrefix ?? []), 'app-server', '--listen', 'stdio://']);
    } catch (error) {
      throw new Error(`Could not start Codex App Server: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.#process = process;
    process.stdout.on('data', (chunk) => this.#acceptStdout(chunk));
    process.stderr.on('data', (chunk) => {
      this.#stderrTail = `${this.#stderrTail}${String(chunk)}`.slice(-4_000);
    });
    process.on('error', (error) => this.#failProcess(new Error(`Codex App Server process error: ${error.message}`)));
    process.on('exit', (code, signal) => {
      if (this.#stopping) return this.#failProcess(new Error('Codex App Server stopped'));
      const detail = this.#stderrTail.trim();
      this.#failProcess(new Error(`Codex App Server exited (${code ?? signal ?? 'unknown'})${detail ? `: ${detail}` : ''}`));
    });

    await this.#requestWithoutStart('initialize', {
      clientInfo: { name: 'orquesta_desktop', title: 'Orquesta Desktop', version: '0.1.0' }
    });
    this.notify('initialized', {});
  }

  async request(method: string, params: unknown): Promise<unknown> {
    await this.start();
    return this.#requestWithoutStart(method, params);
  }

  #requestWithoutStart(method: string, params: unknown): Promise<unknown> {
    if (!this.#process) return Promise.reject(new Error('Codex App Server is not running'));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Codex App Server request timed out: ${method}`));
      }, this.#options.requestTimeoutMs);
      this.#pending.set(id, { resolve, reject, timeout });
      this.#write({ method, id, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.#process) throw new Error('Codex App Server is not running');
    this.#write({ method, params });
  }

  #write(message: JsonObject): void {
    this.#process?.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #acceptStdout(chunk: Buffer | string): void {
    this.#stdoutBuffer += String(chunk);
    if (this.#stdoutBuffer.length > 32 * 1024 * 1024) {
      this.#failProcess(new Error('Codex App Server emitted an oversized unterminated message'));
      return;
    }
    const lines = this.#stdoutBuffer.split(/\r?\n/u);
    this.#stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try { this.#acceptMessage(JSON.parse(line)); } catch { /* Ignore malformed diagnostic output on stdout. */ }
    }
  }

  #acceptMessage(value: unknown): void {
    const message = object(value);
    if (!message) return;
    const numericId = typeof message.id === 'number' ? message.id : null;
    if (numericId !== null && typeof message.method !== 'string') {
      const pending = this.#pending.get(numericId);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.#pending.delete(numericId);
      const error = object(message.error);
      if (error) pending.reject(new Error(typeof error.message === 'string' ? error.message : 'Codex App Server request failed'));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && typeof message.method === 'string') {
      this.#write({ id: message.id, error: { code: -32601, message: 'Client request is not supported by Orquesta Desktop' } });
      return;
    }
    if (typeof message.method === 'string') {
      for (const listener of this.#listeners) listener(structuredClone(message));
    }
  }

  #failProcess(error: Error): void {
    this.#process = null;
    this.#startPromise = null;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
    if (this.#stopTimer) clearTimeout(this.#stopTimer);
    this.#stopTimer = null;
    this.#resolveStop?.();
    this.#resolveStop = null;
    this.#stopPromise = null;
  }

  async stop(): Promise<void> {
    const process = this.#process;
    if (!process) return;
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopping = true;
    this.#stopPromise = new Promise((resolve) => { this.#resolveStop = resolve; });
    process.stdin.end();
    this.#stopTimer = setTimeout(() => {
      process.kill();
      this.#failProcess(new Error('Codex App Server stopped after shutdown timeout'));
    }, 1_500);
    this.#listeners.clear();
    return this.#stopPromise;
  }
}
