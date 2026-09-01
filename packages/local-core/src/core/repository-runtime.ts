import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import type { OrquestaUiSnapshot } from '../contracts/orquesta-ui';
import { readRepositorySnapshot } from './repository-reader';

interface CloseableWatcher {
  close(): void;
}

interface WatchOptions {
  recursive?: boolean;
}

export interface RepositoryRuntimeOptions {
  readSnapshot?: (rootPath: string, projectId?: string) => Promise<OrquestaUiSnapshot>;
  watchDirectory?: (
    directory: string,
    onChange: (changedPath?: string) => void,
    onError: (error: Error) => void,
    options?: WatchOptions
  ) => CloseableWatcher;
  debounceMs?: number;
}

function defaultWatchDirectory(
  directory: string,
  onChange: (changedPath?: string) => void,
  onError: (error: Error) => void,
  options: WatchOptions = {}
): FSWatcher {
  const watcher = watch(directory, { persistent: false, recursive: options.recursive ?? false }, (_eventType, filename) => {
    onChange(filename === null ? undefined : String(filename));
  });
  watcher.on('error', onError);
  return watcher;
}

function offlineSnapshot(snapshot: OrquestaUiSnapshot, reason: string): OrquestaUiSnapshot {
  return {
    ...structuredClone(snapshot),
    project: {
      ...snapshot.project,
      status: 'offline',
      repositoryDisplayState: 'offline',
      provenWorkingAgentCount: 0,
      connectionLabel: `State read failed · ${reason.slice(0, 160)}`
    },
    agents: snapshot.agents.map((agent) => ({
      ...agent,
      status: agent.status === 'standby' ? 'standby' : 'stale',
      statusEvidence: agent.status === 'standby' ? agent.statusEvidence : 'unknown'
    }))
  };
}

export class RepositoryRuntime {
  readonly #readSnapshot: (rootPath: string, projectId?: string) => Promise<OrquestaUiSnapshot>;
  readonly #watchDirectory: NonNullable<RepositoryRuntimeOptions['watchDirectory']>;
  readonly #debounceMs: number;
  readonly #listeners = new Set<(snapshot: OrquestaUiSnapshot) => void>();
  #snapshot: OrquestaUiSnapshot | null = null;
  #projectId: string | null = null;
  #rootPath: string | null = null;
  #watchers: CloseableWatcher[] = [];
  #refreshTimer: ReturnType<typeof setTimeout> | null = null;
  #watchGeneration = 0;
  readonly #activeRefreshes = new Set<Promise<OrquestaUiSnapshot>>();

  constructor(options: RepositoryRuntimeOptions = {}) {
    this.#readSnapshot = options.readSnapshot ?? ((rootPath, projectId) => readRepositorySnapshot(rootPath, { projectId }));
    this.#watchDirectory = options.watchDirectory ?? defaultWatchDirectory;
    this.#debounceMs = options.debounceMs ?? 180;
  }

  subscribe(listener: (snapshot: OrquestaUiSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async select(input: { projectId: string; rootPath: string }): Promise<OrquestaUiSnapshot> {
    const watchGeneration = ++this.#watchGeneration;
    this.#closeWatchers();
    this.#clearRefreshTimer();
    this.#projectId = input.projectId;
    this.#rootPath = input.rootPath;
    const next = await this.#projectSnapshot(input.rootPath, input.projectId);
    if (next.project.id !== input.projectId) throw new Error('repository_project_identity_mismatch');
    this.#projectId = input.projectId;
    this.#snapshot = structuredClone(next);
    this.#rootPath = next.project.rootPathLabel ?? input.rootPath;
    if (this.#startWatching(this.#rootPath, watchGeneration)) {
      this.#snapshot.project.repositoryDisplayState = 'watching';
    }
    return structuredClone(this.#snapshot);
  }

  selectUninitialized(input: { projectId: string; rootPath: string }): OrquestaUiSnapshot {
    this.#watchGeneration += 1;
    this.#closeWatchers();
    this.#clearRefreshTimer();
    this.#projectId = input.projectId;
    this.#rootPath = input.rootPath;
    this.#snapshot = {
      project: {
        id: input.projectId,
        title: path.basename(input.rootPath) || input.rootPath,
        rootPathLabel: input.rootPath,
        status: 'ready',
        connectionLabel: 'Folder selected · project bootstrap is available',
        isDemoData: false,
        repositoryDisplayState: 'snapshot',
        lastSyncedAt: null,
        currentPhaseId: null,
        agentCount: 0,
        provenWorkingAgentCount: 0,
        summary: 'This folder has no Orquesta state yet.',
        nextMilestone: null
      },
      participants: [],
      agents: [],
      tasks: [],
      attention: [],
      failures: [],
      phases: [],
      recentEvents: [],
      inspectionTemplates: [],
      inspectionRuns: []
    };
    return structuredClone(this.#snapshot);
  }

  getSnapshot(): OrquestaUiSnapshot {
    if (!this.#snapshot) throw new Error('No Orquesta repository is selected');
    return structuredClone(this.#snapshot);
  }

  async refresh(): Promise<OrquestaUiSnapshot> {
    const refresh = (async () => {
      if (!this.#rootPath || !this.#snapshot) throw new Error('No Orquesta repository is selected');
      try {
        this.#snapshot = await this.#projectSnapshot(this.#rootPath, this.#projectId);
        if (this.#watchers.length) this.#snapshot.project.repositoryDisplayState = 'watching';
      } catch (error) {
        this.#snapshot = offlineSnapshot(this.#snapshot, error instanceof Error ? error.message : String(error));
      }
      this.#emit();
      return structuredClone(this.#snapshot);
    })();
    this.#activeRefreshes.add(refresh);
    try {
      return await refresh;
    } finally {
      this.#activeRefreshes.delete(refresh);
    }
  }

  async stop(): Promise<void> {
    this.#watchGeneration += 1;
    this.#clearRefreshTimer();
    this.#closeWatchers();
    await Promise.allSettled([
      ...this.#activeRefreshes
    ]);
    this.#listeners.clear();
    this.#projectId = null;
    this.#rootPath = null;
    this.#snapshot = null;
  }

  #startWatching(rootPath: string, watchGeneration: number): boolean {
    try {
      this.#watchers.push(this.#watchDirectory(
        path.join(rootPath, '.orquesta'),
        (changedPath) => {
          if (watchGeneration === this.#watchGeneration) this.#scheduleRefresh(changedPath);
        },
        (error) => this.#handleWatchError(error, watchGeneration),
        { recursive: true }
      ));
    } catch {
      // A project without canonical Orquesta state remains a point-in-time snapshot.
    }
    return this.#watchers.length > 0;
  }

  #handleWatchError(error: Error, watchGeneration: number): void {
    if (!this.#snapshot || watchGeneration !== this.#watchGeneration) return;
    this.#watchGeneration += 1;
    this.#closeWatchers();
    this.#snapshot = structuredClone(this.#snapshot);
    this.#snapshot.project.repositoryDisplayState = 'snapshot';
    this.#snapshot.project.connectionLabel = `Watcher stopped · ${error.message.slice(0, 160)}`;
    this.#emit();
  }

  async #projectSnapshot(rootPath: string, projectId?: string | null): Promise<OrquestaUiSnapshot> {
    return this.#readSnapshot(rootPath, projectId ?? undefined);
  }

  #scheduleRefresh(changedPath?: string): void {
    void changedPath;
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
