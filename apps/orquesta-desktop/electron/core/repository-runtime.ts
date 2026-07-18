import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import type { OrquestaUiSnapshot } from '../../src/contracts/orquesta-ui';
import { readRepositorySnapshot } from './repository-reader';

interface CloseableWatcher {
  close(): void;
}

export interface RepositoryRuntimeOptions {
  readSnapshot?: (rootPath: string) => Promise<OrquestaUiSnapshot>;
  watchDirectory?: (directory: string, onChange: () => void) => CloseableWatcher;
  debounceMs?: number;
}

function defaultWatchDirectory(directory: string, onChange: () => void): FSWatcher {
  const watcher = watch(directory, { persistent: false }, onChange);
  watcher.on('error', () => undefined);
  return watcher;
}

function offlineSnapshot(snapshot: OrquestaUiSnapshot, reason: string): OrquestaUiSnapshot {
  return {
    ...structuredClone(snapshot),
    project: {
      ...snapshot.project,
      status: 'offline',
      provenWorkingAgentCount: 0,
      connectionLabel: `State read failed · ${reason.slice(0, 160)}`
    },
    agents: snapshot.agents.map((agent) => ({
      ...agent,
      status: agent.status === 'standby' ? 'standby' : 'stale',
      statusLabel: agent.status === 'standby' ? 'Idle' : 'Stale evidence',
      statusEvidence: agent.status === 'standby' ? agent.statusEvidence : 'unknown'
    }))
  };
}

export class RepositoryRuntime {
  readonly #readSnapshot: (rootPath: string) => Promise<OrquestaUiSnapshot>;
  readonly #watchDirectory: (directory: string, onChange: () => void) => CloseableWatcher;
  readonly #debounceMs: number;
  readonly #listeners = new Set<(snapshot: OrquestaUiSnapshot) => void>();
  #snapshot: OrquestaUiSnapshot | null = null;
  #rootPath: string | null = null;
  #watchers: CloseableWatcher[] = [];
  #refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: RepositoryRuntimeOptions = {}) {
    this.#readSnapshot = options.readSnapshot ?? ((rootPath) => readRepositorySnapshot(rootPath));
    this.#watchDirectory = options.watchDirectory ?? defaultWatchDirectory;
    this.#debounceMs = options.debounceMs ?? 180;
  }

  subscribe(listener: (snapshot: OrquestaUiSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async select(input: { projectId: string; rootPath: string }): Promise<OrquestaUiSnapshot> {
    this.#closeWatchers();
    this.#clearRefreshTimer();
    const next = await this.#readSnapshot(input.rootPath);
    this.#snapshot = structuredClone(next);
    this.#rootPath = next.project.rootPathLabel ?? input.rootPath;
    this.#startWatching(this.#rootPath);
    return structuredClone(next);
  }

  getSnapshot(): OrquestaUiSnapshot {
    if (!this.#snapshot) throw new Error('No Orquesta repository is selected');
    return structuredClone(this.#snapshot);
  }

  async refresh(): Promise<OrquestaUiSnapshot> {
    if (!this.#rootPath || !this.#snapshot) throw new Error('No Orquesta repository is selected');
    try {
      this.#snapshot = await this.#readSnapshot(this.#rootPath);
    } catch (error) {
      this.#snapshot = offlineSnapshot(this.#snapshot, error instanceof Error ? error.message : String(error));
    }
    this.#emit();
    return structuredClone(this.#snapshot);
  }

  async stop(): Promise<void> {
    this.#clearRefreshTimer();
    this.#closeWatchers();
    this.#listeners.clear();
    this.#rootPath = null;
    this.#snapshot = null;
  }

  #startWatching(rootPath: string): void {
    for (const directory of ['state', 'vision', 'failures', 'v4']) {
      try {
        this.#watchers.push(this.#watchDirectory(
          path.join(rootPath, '.orquesta', directory),
          () => this.#scheduleRefresh()
        ));
      } catch {
        // Optional canonical directories can be absent in a minimum project.
      }
    }
  }

  #scheduleRefresh(): void {
    this.#clearRefreshTimer();
    this.#refreshTimer = setTimeout(() => {
      this.#refreshTimer = null;
      void this.refresh();
    }, this.#debounceMs);
  }

  #clearRefreshTimer(): void {
    if (this.#refreshTimer) clearTimeout(this.#refreshTimer);
    this.#refreshTimer = null;
  }

  #closeWatchers(): void {
    for (const watcher of this.#watchers) watcher.close();
    this.#watchers = [];
  }

  #emit(): void {
    if (!this.#snapshot) return;
    for (const listener of this.#listeners) listener(structuredClone(this.#snapshot));
  }
}
