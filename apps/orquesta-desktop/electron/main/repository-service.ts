import { randomUUID } from 'node:crypto';
import type { ProjectSummary, UiActionResult } from '../../src/contracts/bridge';
import type { OrquestaUiSnapshot } from '../../src/contracts/orquesta-ui';
import { ProjectRegistry, projectIdForRoot } from './project-registry';

export interface RepositoryProjectionHost {
  selectRepository(projectId: string, rootPath: string): Promise<OrquestaUiSnapshot>;
  getRepositorySnapshot(): Promise<OrquestaUiSnapshot>;
  subscribeRepository(listener: (snapshot: OrquestaUiSnapshot) => void): () => void;
}

export interface RepositoryServiceOptions {
  registryPath: string;
  coreHost: RepositoryProjectionHost;
  initialRootPath?: string | null;
  chooseDirectory?: () => Promise<string | null>;
  now?: () => Date;
}

function result(status: 'accepted'): UiActionResult;
function result(status: 'rejected' | 'failed' | 'unavailable', reason: string, retryable?: boolean): UiActionResult;
function result(status: 'accepted' | 'rejected' | 'failed' | 'unavailable', reason = '', retryable = false): UiActionResult {
  return status === 'accepted'
    ? { status, correlationId: randomUUID() }
    : { status, correlationId: randomUUID(), reason, retryable };
}

function emptySnapshot(): OrquestaUiSnapshot {
  return {
    project: {
      id: 'no-project',
      title: 'No Orquesta project selected',
      rootPathLabel: null,
      status: 'offline',
      connectionLabel: 'Choose a project folder to begin',
      isDemoData: false,
      lastSyncedAt: null,
      currentPhaseId: null,
      agentCount: 0,
      provenWorkingAgentCount: 0,
      summary: 'No repository state is loaded.',
      nextMilestone: 'Open an Orquesta project folder'
    },
    agents: [],
    tasks: [],
    attention: [],
    phases: [],
    recentEvents: []
  };
}

export class RepositoryService {
  readonly #options: RepositoryServiceOptions;
  readonly #registry: ProjectRegistry;
  readonly #listeners = new Set<(snapshot: OrquestaUiSnapshot) => void>();
  #snapshot = emptySnapshot();
  #unsubscribeCore: (() => void) | null = null;

  constructor(options: RepositoryServiceOptions) {
    this.#options = options;
    this.#registry = new ProjectRegistry({
      registryPath: options.registryPath,
      chooseDirectory: options.chooseDirectory,
      now: options.now
    });
  }

  async initialize(): Promise<void> {
    await this.#registry.initialize();
    this.#unsubscribeCore = this.#options.coreHost.subscribeRepository((snapshot) => {
      this.#snapshot = structuredClone(snapshot);
      void this.#registry.updateProjection(snapshot);
      this.#emit();
    });

    if (this.#options.initialRootPath) {
      await this.selectRoot(this.#options.initialRootPath);
      return;
    }
    const current = this.#registry.currentProject();
    if (current) {
      const selected = await this.selectRoot(current.rootPath);
      if (selected.status === 'accepted') return;
    }
    this.#emit();
  }

  subscribe(listener: (snapshot: OrquestaUiSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async getSnapshot(): Promise<OrquestaUiSnapshot> {
    return structuredClone(this.#snapshot);
  }

  listProjects(): Promise<ProjectSummary[]> {
    return this.#registry.listProjects();
  }

  getCurrentRuntimeContext(): { projectId: string; rootPath: string; threadId: string | null } | null {
    return this.#registry.getCurrentRuntimeContext();
  }

  setCoordinatorThread(projectId: string, threadId: string): Promise<void> {
    return this.#registry.setCoordinatorThread(projectId, threadId);
  }

  async openProject(): Promise<UiActionResult> {
    const rootPath = await this.#registry.chooseRoot();
    if (!rootPath) return result('rejected', 'No project folder was selected.');
    return this.selectRoot(rootPath);
  }

  async selectRoot(rootPath: string): Promise<UiActionResult> {
    try {
      const next = await this.#options.coreHost.selectRepository(projectIdForRoot(rootPath), rootPath);
      this.#snapshot = structuredClone(next);
      await this.#registry.remember(next);
      this.#emit();
      return result('accepted');
    } catch (error) {
      return result('rejected', error instanceof Error ? error.message : String(error));
    }
  }

  async switchProject(projectId: string): Promise<UiActionResult> {
    const project = this.#registry.project(projectId);
    if (!project) return result('rejected', 'Unknown saved project.');
    return this.selectRoot(project.rootPath);
  }

  async refresh(): Promise<void> {
    try {
      this.#snapshot = await this.#options.coreHost.getRepositorySnapshot();
      await this.#registry.updateProjection(this.#snapshot);
      this.#emit();
    } catch {
      // RepositoryRuntime owns the last-good offline projection.
    }
  }

  async stop(): Promise<void> {
    this.#unsubscribeCore?.();
    this.#unsubscribeCore = null;
    this.#listeners.clear();
  }

  #emit(): void {
    for (const listener of this.#listeners) listener(structuredClone(this.#snapshot));
  }
}
