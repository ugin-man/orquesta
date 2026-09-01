export type WorkspaceLoadKey = 'business' | 'workflow';

type WorkspaceLoadMode = 'join' | 'refresh_after_current';

interface WorkspaceLoadEntry {
  ownerKey: string;
  operation: () => Promise<void>;
  refreshRequested: boolean;
  promise: Promise<void>;
}

/**
 * Coalesces projection reads for one runtime owner without losing a refresh
 * requested after an authoritative mutation or snapshot change.
 */
export class WorkspaceLoadCoordinator {
  readonly #entries = new Map<WorkspaceLoadKey, WorkspaceLoadEntry>();

  run(
    key: WorkspaceLoadKey,
    ownerKey: string,
    mode: WorkspaceLoadMode,
    operation: () => Promise<void>,
  ): Promise<void> {
    const current = this.#entries.get(key);
    if (current?.ownerKey === ownerKey) {
      if (mode === 'refresh_after_current') {
        current.operation = operation;
        current.refreshRequested = true;
      }
      return current.promise;
    }

    const entry: WorkspaceLoadEntry = {
      ownerKey,
      operation,
      refreshRequested: false,
      promise: Promise.resolve(),
    };
    entry.promise = this.#drain(key, entry);
    this.#entries.set(key, entry);
    return entry.promise;
  }

  async #drain(key: WorkspaceLoadKey, entry: WorkspaceLoadEntry): Promise<void> {
    try {
      do {
        entry.refreshRequested = false;
        const operation = entry.operation;
        await operation();
      } while (entry.refreshRequested);
    } finally {
      if (this.#entries.get(key) === entry) this.#entries.delete(key);
    }
  }
}
