import type { CoreEvent, CoreRequest } from '../core/protocol';
import { isCoreEvent } from '../core/protocol';

export interface CoreChildProcess {
  postMessage(message: CoreRequest): void;
  on(event: 'message', listener: (message: unknown) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  kill(): boolean;
}

export interface CoreHostOptions {
  coreEntryPath: string;
  fork(coreEntryPath: string): CoreChildProcess;
  shutdownTimeoutMs?: number;
  pingTimeoutMs?: number;
}

export type CoreHostStatus = 'stopped' | 'starting' | 'ready' | 'stopping';

interface PendingPing {
  resolve(value: { correlationId: string }): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

export class CoreHost {
  readonly #options: Required<Pick<CoreHostOptions, 'shutdownTimeoutMs' | 'pingTimeoutMs'>> & CoreHostOptions;
  readonly #pendingPings = new Map<string, PendingPing>();
  #child: CoreChildProcess | null = null;
  #status: CoreHostStatus = 'stopped';
  #stopPromise: Promise<void> | null = null;
  #resolveStop: (() => void) | null = null;
  #shutdownTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(options: CoreHostOptions) {
    this.#options = {
      shutdownTimeoutMs: options.shutdownTimeoutMs ?? 2_000,
      pingTimeoutMs: options.pingTimeoutMs ?? 5_000,
      ...options
    };
  }

  status(): CoreHostStatus {
    return this.#status;
  }

  start(): void {
    if (this.#child) return;
    this.#status = 'starting';
    const child = this.#options.fork(this.#options.coreEntryPath);
    this.#child = child;
    child.on('message', (message) => {
      if (this.#child === child) this.#acceptEvent(message);
    });
    child.on('exit', () => {
      if (this.#child === child) this.#finishStop();
    });
  }

  ping(correlationId: string): Promise<{ correlationId: string }> {
    if (!correlationId || correlationId.length > 128) {
      return Promise.reject(new Error('correlationId must contain 1-128 characters'));
    }
    if (this.#status !== 'ready' || !this.#child) {
      return Promise.reject(new Error('Orquesta Core is not ready'));
    }
    if (this.#pendingPings.has(correlationId)) {
      return Promise.reject(new Error(`Duplicate correlationId: ${correlationId}`));
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pendingPings.delete(correlationId);
        reject(new Error(`Orquesta Core ping timed out: ${correlationId}`));
      }, this.#options.pingTimeoutMs);
      this.#pendingPings.set(correlationId, { resolve, reject, timeout });
      this.#child?.postMessage({ type: 'core.ping', correlationId });
    });
  }

  stop(): Promise<void> {
    if (!this.#child) {
      this.#status = 'stopped';
      return Promise.resolve();
    }
    if (this.#stopPromise) return this.#stopPromise;

    this.#status = 'stopping';
    this.#stopPromise = new Promise((resolve) => {
      this.#resolveStop = resolve;
    });
    const child = this.#child;
    child.postMessage({ type: 'core.shutdown' });
    this.#shutdownTimeout = setTimeout(() => {
      if (this.#child !== child) return;
      child.kill();
      this.#finishStop();
    }, this.#options.shutdownTimeoutMs);
    return this.#stopPromise;
  }

  #acceptEvent(message: unknown): void {
    if (!isCoreEvent(message)) return;
    this.#handleEvent(message);
  }

  #handleEvent(event: CoreEvent): void {
    if (event.type === 'core.ready') {
      if (this.#status === 'starting') this.#status = 'ready';
      return;
    }
    if (event.type === 'core.pong') {
      const pending = this.#pendingPings.get(event.correlationId);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.#pendingPings.delete(event.correlationId);
      pending.resolve({ correlationId: event.correlationId });
      return;
    }
    this.#finishStop();
  }

  #finishStop(): void {
    if (this.#shutdownTimeout) clearTimeout(this.#shutdownTimeout);
    this.#shutdownTimeout = null;
    this.#child = null;
    this.#status = 'stopped';
    for (const pending of this.#pendingPings.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Orquesta Core stopped'));
    }
    this.#pendingPings.clear();
    const resolveStop = this.#resolveStop;
    this.#resolveStop = null;
    this.#stopPromise = null;
    resolveStop?.();
  }
}
