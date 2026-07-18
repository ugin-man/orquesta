import { randomUUID } from 'node:crypto';
import type { ConversationPage, RuntimeInfoUi } from '../../src/contracts/bridge';
import type { OrquestaUiSnapshot } from '../../src/contracts/orquesta-ui';
import type { CoreEvent, CoreRequest, RuntimeModelEvidence, RuntimeNotification } from '../core/protocol';
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
  runtimeTimeoutMs?: number;
}

export type CoreHostStatus = 'stopped' | 'starting' | 'ready' | 'stopping';

interface PendingPing {
  resolve(value: { correlationId: string }): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

interface PendingReady {
  resolve(): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

interface PendingRuntime<T> {
  resolve(value: T): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

export class CoreHost {
  readonly #options: Required<Pick<CoreHostOptions, 'shutdownTimeoutMs' | 'pingTimeoutMs' | 'runtimeTimeoutMs'>> & CoreHostOptions;
  readonly #pendingPings = new Map<string, PendingPing>();
  readonly #pendingReady = new Set<PendingReady>();
  readonly #pendingDispatches = new Map<string, PendingRuntime<{ correlationId: string; threadId: string; turnId: string; modelEvidence: RuntimeModelEvidence }>>();
  readonly #pendingConversations = new Map<string, PendingRuntime<ConversationPage>>();
  readonly #pendingRuntimeInfo = new Map<string, PendingRuntime<RuntimeInfoUi>>();
  readonly #pendingRepositorySnapshots = new Map<string, PendingRuntime<OrquestaUiSnapshot>>();
  readonly #runtimeListeners = new Set<(notification: RuntimeNotification) => void>();
  readonly #repositoryListeners = new Set<(snapshot: OrquestaUiSnapshot) => void>();
  #child: CoreChildProcess | null = null;
  #status: CoreHostStatus = 'stopped';
  #stopPromise: Promise<void> | null = null;
  #resolveStop: (() => void) | null = null;
  #shutdownTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(options: CoreHostOptions) {
    this.#options = {
      shutdownTimeoutMs: options.shutdownTimeoutMs ?? 2_000,
      pingTimeoutMs: options.pingTimeoutMs ?? 5_000,
      runtimeTimeoutMs: options.runtimeTimeoutMs ?? 60_000,
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
    if (this.#status !== 'ready' || !this.#child) return this.#ensureReady().then(() => this.ping(correlationId));
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

  sendMessage(input: { projectId: string; rootPath: string; threadId: string | null; targetAgentId: string; text: string; localImagePaths: string[] }): Promise<{ correlationId: string; threadId: string; turnId: string; modelEvidence: RuntimeModelEvidence }> {
    if (this.#status !== 'ready' || !this.#child) return this.#ensureReady().then(() => this.sendMessage(input));
    const correlationId = randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pendingDispatches.delete(correlationId);
        reject(new Error('Codex runtime dispatch timed out'));
      }, this.#options.runtimeTimeoutMs);
      this.#pendingDispatches.set(correlationId, { resolve, reject, timeout });
      this.#child?.postMessage({ type: 'runtime.send', correlationId, ...input });
    });
  }

  listConversation(input: { threadId: string; targetAgentId: string; limit: number }): Promise<ConversationPage> {
    if (this.#status !== 'ready' || !this.#child) return this.#ensureReady().then(() => this.listConversation(input));
    const correlationId = randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pendingConversations.delete(correlationId);
        reject(new Error('Codex runtime conversation read timed out'));
      }, this.#options.runtimeTimeoutMs);
      this.#pendingConversations.set(correlationId, { resolve, reject, timeout });
      this.#child?.postMessage({ type: 'runtime.conversation', correlationId, ...input });
    });
  }

  getRuntimeInfo(input: { probe: boolean }): Promise<RuntimeInfoUi> {
    if (this.#status !== 'ready' || !this.#child) return this.#ensureReady().then(() => this.getRuntimeInfo(input));
    const correlationId = randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pendingRuntimeInfo.delete(correlationId);
        reject(new Error('Codex runtime information request timed out'));
      }, this.#options.runtimeTimeoutMs);
      this.#pendingRuntimeInfo.set(correlationId, { resolve, reject, timeout });
      this.#child?.postMessage({ type: 'runtime.info', correlationId, probe: input.probe });
    });
  }

  selectRepository(projectId: string, rootPath: string): Promise<OrquestaUiSnapshot> {
    if (this.#status !== 'ready' || !this.#child) return this.#ensureReady().then(() => this.selectRepository(projectId, rootPath));
    const correlationId = randomUUID();
    return this.#requestRepositorySnapshot(correlationId, {
      type: 'repository.select', correlationId, projectId, rootPath
    });
  }

  getRepositorySnapshot(): Promise<OrquestaUiSnapshot> {
    if (this.#status !== 'ready' || !this.#child) return this.#ensureReady().then(() => this.getRepositorySnapshot());
    const correlationId = randomUUID();
    return this.#requestRepositorySnapshot(correlationId, { type: 'repository.get-snapshot', correlationId });
  }

  subscribeRepository(listener: (snapshot: OrquestaUiSnapshot) => void): () => void {
    this.#repositoryListeners.add(listener);
    return () => this.#repositoryListeners.delete(listener);
  }

  subscribeRuntime(listener: (notification: RuntimeNotification) => void): () => void {
    this.#runtimeListeners.add(listener);
    return () => this.#runtimeListeners.delete(listener);
  }

  #requestRepositorySnapshot(
    correlationId: string,
    request: Extract<CoreRequest, { type: 'repository.select' | 'repository.get-snapshot' }>
  ): Promise<OrquestaUiSnapshot> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pendingRepositorySnapshots.delete(correlationId);
        reject(new Error('Orquesta repository projection timed out'));
      }, this.#options.runtimeTimeoutMs);
      this.#pendingRepositorySnapshots.set(correlationId, { resolve, reject, timeout });
      this.#child?.postMessage(request);
    });
  }

  #ensureReady(): Promise<void> {
    if (this.#status === 'ready' && this.#child) return Promise.resolve();
    if (this.#status === 'stopped') this.start();
    if (this.#status === 'ready' && this.#child) return Promise.resolve();
    if (this.#status !== 'starting') return Promise.reject(new Error('Orquesta Core is not available'));
    return new Promise((resolve, reject) => {
      const pending: PendingReady = {
        resolve: () => resolve(),
        reject,
        timeout: setTimeout(() => {
          this.#pendingReady.delete(pending);
          reject(new Error('Orquesta Core startup timed out'));
        }, this.#options.pingTimeoutMs)
      };
      this.#pendingReady.add(pending);
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
      if (this.#status === 'starting') {
        this.#status = 'ready';
        for (const pending of this.#pendingReady) {
          clearTimeout(pending.timeout);
          pending.resolve();
        }
        this.#pendingReady.clear();
      }
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
    if (event.type === 'runtime.dispatch.accepted') {
      const pending = this.#pendingDispatches.get(event.correlationId);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.#pendingDispatches.delete(event.correlationId);
      pending.resolve({ correlationId: event.correlationId, threadId: event.threadId, turnId: event.turnId, modelEvidence: event.modelEvidence });
      return;
    }
    if (event.type === 'runtime.conversation.result') {
      const pending = this.#pendingConversations.get(event.correlationId);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.#pendingConversations.delete(event.correlationId);
      pending.resolve(event.page);
      return;
    }
    if (event.type === 'runtime.info.result') {
      const pending = this.#pendingRuntimeInfo.get(event.correlationId);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.#pendingRuntimeInfo.delete(event.correlationId);
      pending.resolve(event.info);
      return;
    }
    if (event.type === 'repository.snapshot.result') {
      const pending = this.#pendingRepositorySnapshots.get(event.correlationId);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.#pendingRepositorySnapshots.delete(event.correlationId);
      pending.resolve(structuredClone(event.snapshot));
      return;
    }
    if (event.type === 'runtime.request.failed') {
      const pending = this.#pendingDispatches.get(event.correlationId)
        ?? this.#pendingConversations.get(event.correlationId)
        ?? this.#pendingRuntimeInfo.get(event.correlationId)
        ?? this.#pendingRepositorySnapshots.get(event.correlationId);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.#pendingDispatches.delete(event.correlationId);
      this.#pendingConversations.delete(event.correlationId);
      this.#pendingRuntimeInfo.delete(event.correlationId);
      this.#pendingRepositorySnapshots.delete(event.correlationId);
      pending.reject(new Error(event.reason));
      return;
    }
    if (event.type === 'runtime.notification') {
      for (const listener of this.#runtimeListeners) listener(structuredClone(event.notification));
      return;
    }
    if (event.type === 'repository.snapshot.changed') {
      for (const listener of this.#repositoryListeners) listener(structuredClone(event.snapshot));
      return;
    }
    this.#finishStop();
  }

  #finishStop(): void {
    if (this.#shutdownTimeout) clearTimeout(this.#shutdownTimeout);
    this.#shutdownTimeout = null;
    this.#child = null;
    this.#status = 'stopped';
    for (const pending of this.#pendingReady) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Orquesta Core stopped before it became ready'));
    }
    this.#pendingReady.clear();
    for (const pending of this.#pendingPings.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Orquesta Core stopped'));
    }
    this.#pendingPings.clear();
    for (const pending of [
      ...this.#pendingDispatches.values(),
      ...this.#pendingConversations.values(),
      ...this.#pendingRuntimeInfo.values(),
      ...this.#pendingRepositorySnapshots.values()
    ]) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Orquesta Core stopped'));
    }
    this.#pendingDispatches.clear();
    this.#pendingConversations.clear();
    this.#pendingRuntimeInfo.clear();
    this.#pendingRepositorySnapshots.clear();
    this.#runtimeListeners.clear();
    this.#repositoryListeners.clear();
    const resolveStop = this.#resolveStop;
    this.#resolveStop = null;
    this.#stopPromise = null;
    resolveStop?.();
  }
}
