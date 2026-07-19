import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { emptyV4OperationsSnapshot, type OrquestaUiSnapshot, type V4OperationsSnapshot } from '../../src/contracts/orquesta-ui';
import type { AttentionUiItem } from '../../src/contracts/orquesta-ui';
import type { RuntimeApprovalRequest } from './protocol';
import { readRepositorySnapshot } from './repository-reader';
import { projectV4Operations } from './v4-operations-projection';

interface CloseableWatcher {
  close(): void;
}

export interface RepositoryRuntimeOptions {
  readSnapshot?: (rootPath: string) => Promise<OrquestaUiSnapshot>;
  readV4Operations?: (rootPath: string) => Promise<V4OperationsSnapshot>;
  watchDirectory?: (directory: string, onChange: () => void, onError: (error: Error) => void) => CloseableWatcher;
  debounceMs?: number;
}

function defaultWatchDirectory(directory: string, onChange: () => void, onError: (error: Error) => void): FSWatcher {
  const watcher = watch(directory, { persistent: false }, onChange);
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
      statusLabel: agent.status === 'standby' ? 'Idle' : 'Stale evidence',
      statusEvidence: agent.status === 'standby' ? agent.statusEvidence : 'unknown'
    }))
  };
}

export class RepositoryRuntime {
  readonly #readSnapshot: (rootPath: string) => Promise<OrquestaUiSnapshot>;
  readonly #readV4Operations: (rootPath: string) => Promise<V4OperationsSnapshot>;
  readonly #watchDirectory: (directory: string, onChange: () => void, onError: (error: Error) => void) => CloseableWatcher;
  readonly #debounceMs: number;
  readonly #listeners = new Set<(snapshot: OrquestaUiSnapshot) => void>();
  readonly #runtimeApprovals = new Map<string, RuntimeApprovalRequest>();
  readonly #runtimeApprovalCreatedAt = new Map<string, string>();
  readonly #resolvedHistory: Array<{ projectId: string; item: AttentionUiItem }> = [];
  #snapshot: OrquestaUiSnapshot | null = null;
  #projectId: string | null = null;
  #rootPath: string | null = null;
  #watchers: CloseableWatcher[] = [];
  #refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: RepositoryRuntimeOptions = {}) {
    this.#readSnapshot = options.readSnapshot ?? ((rootPath) => readRepositorySnapshot(rootPath));
    this.#readV4Operations = options.readV4Operations ?? projectV4Operations;
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
    const next = await this.#projectSnapshot(input.rootPath);
    this.#projectId = next.project.id;
    this.#snapshot = this.#withRuntimeApprovals(next);
    this.#rootPath = next.project.rootPathLabel ?? input.rootPath;
    if (this.#startWatching(this.#rootPath)) {
      this.#snapshot.project.repositoryDisplayState = 'watching';
    }
    return structuredClone(this.#snapshot);
  }

  getSnapshot(): OrquestaUiSnapshot {
    if (!this.#snapshot) throw new Error('No Orquesta repository is selected');
    return structuredClone(this.#snapshot);
  }

  addRuntimeApproval(approval: RuntimeApprovalRequest): void {
    const attentionId = `runtime-approval-${approval.requestId}`;
    this.#runtimeApprovals.set(attentionId, structuredClone(approval));
    if (!this.#runtimeApprovalCreatedAt.has(attentionId)) {
      this.#runtimeApprovalCreatedAt.set(attentionId, new Date().toISOString());
    }
    if (!this.#snapshot || this.#projectId !== approval.projectId) return;
    this.#snapshot = this.#withRuntimeApprovals(this.#snapshot);
    this.#emit();
  }

  runtimeApproval(attentionId: string): RuntimeApprovalRequest | null {
    const approval = this.#runtimeApprovals.get(attentionId);
    return approval ? structuredClone(approval) : null;
  }

  resolveRuntimeApproval(attentionId: string, decision: string): void {
    const approval = this.#runtimeApprovals.get(attentionId);
    if (!approval) throw new Error('Runtime approval is no longer pending');
    const item = this.#runtimeApprovalItem(attentionId, approval);
    this.#runtimeApprovals.delete(attentionId);
    this.#runtimeApprovalCreatedAt.delete(attentionId);
    this.#resolvedHistory.unshift({
      projectId: approval.projectId,
      item: { ...item, resolvedAt: new Date().toISOString(), resolutionLabel: decision }
    });
    if (this.#resolvedHistory.length > 200) this.#resolvedHistory.length = 200;
    if (this.#snapshot && this.#projectId === approval.projectId) {
      this.#snapshot = this.#withRuntimeApprovals(this.#snapshot);
      this.#emit();
    }
  }

  listAttentionHistory(): AttentionUiItem[] {
    return this.#resolvedHistory
      .filter((entry) => entry.projectId === this.#projectId)
      .map((entry) => structuredClone(entry.item));
  }

  async refresh(): Promise<OrquestaUiSnapshot> {
    if (!this.#rootPath || !this.#snapshot) throw new Error('No Orquesta repository is selected');
    try {
      this.#snapshot = this.#withRuntimeApprovals(await this.#projectSnapshot(this.#rootPath));
      if (this.#watchers.length) this.#snapshot.project.repositoryDisplayState = 'watching';
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
    this.#runtimeApprovals.clear();
    this.#runtimeApprovalCreatedAt.clear();
    this.#resolvedHistory.splice(0);
    this.#projectId = null;
    this.#rootPath = null;
    this.#snapshot = null;
  }

  #startWatching(rootPath: string): boolean {
    for (const directory of ['state', 'vision', 'failures', 'v4']) {
      try {
        this.#watchers.push(this.#watchDirectory(
          path.join(rootPath, '.orquesta', directory),
          () => this.#scheduleRefresh(),
          (error) => this.#handleWatchError(error)
        ));
      } catch {
        // Optional canonical directories can be absent in a minimum project.
      }
    }
    return this.#watchers.length > 0;
  }

  #handleWatchError(error: Error): void {
    if (!this.#snapshot) return;
    this.#closeWatchers();
    this.#snapshot = structuredClone(this.#snapshot);
    this.#snapshot.project.repositoryDisplayState = 'snapshot';
    this.#snapshot.project.connectionLabel = `Watcher stopped · ${error.message.slice(0, 160)}`;
    this.#emit();
  }

  async #projectSnapshot(rootPath: string): Promise<OrquestaUiSnapshot> {
    const snapshot = await this.#readSnapshot(rootPath);
    let v4Operations: V4OperationsSnapshot;
    try {
      v4Operations = await this.#readV4Operations(rootPath);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      v4Operations = emptyV4OperationsSnapshot(`V4 journal unavailable · ${reason.slice(0, 160)}`);
    }
    return { ...snapshot, v4Operations };
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

  #withRuntimeApprovals(snapshot: OrquestaUiSnapshot): OrquestaUiSnapshot {
    const next = structuredClone(snapshot);
    const canonicalAttention = next.attention.filter((item) => !item.runtimeApproval);
    const runtimeAttention = [...this.#runtimeApprovals.entries()]
      .filter(([, approval]) => approval.projectId === next.project.id)
      .map(([attentionId, approval]) => this.#runtimeApprovalItem(attentionId, approval));
    next.attention = [...runtimeAttention, ...canonicalAttention];
    return next;
  }

  #runtimeApprovalItem(attentionId: string, approval: RuntimeApprovalRequest): AttentionUiItem {
    return {
      id: attentionId,
      type: 'approval',
      priority: 'blocker',
      title: 'Codex approval required',
      summary: approval.reason ?? 'Codex requires an explicit response before continuing.',
      sourceAgentId: 'orchestrator',
      taskId: null,
      blocking: true,
      primaryActionLabel: 'Review request',
      createdAt: this.#runtimeApprovalCreatedAt.get(attentionId) ?? new Date().toISOString(),
      resolvedAt: null,
      resolutionLabel: null,
      runtimeApproval: {
        requestId: approval.requestId,
        method: approval.method,
        threadId: approval.threadId,
        turnId: approval.turnId,
        responseOptions: [...approval.responseOptions]
      }
    };
  }
}
