import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import path from 'node:path';
import type { ProjectSummary, UiActionResult } from '../../src/contracts/bridge';
import { emptyV4OperationsSnapshot, INSPECTION_TEMPLATE_DEFINITIONS, type OrquestaUiSnapshot } from '../../src/contracts/orquesta-ui';
import type { SetupSourceDraft } from '../../src/contracts/setup';
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
  prepareSetupSource?: (source: Extract<SetupSourceDraft, { kind: 'detected_root' | 'existing_folder' }>) => Promise<void>;
  requiresSetup?: (rootPath: string) => Promise<boolean>;
  now?: () => Date;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function defaultRequiresSetup(rootPath: string): Promise<boolean> {
  const setupState = path.join(rootPath, '.orquesta', 'setup', 'setup_state.json');
  if (await exists(setupState)) return false;
  const stateRoot = path.join(rootPath, '.orquesta', 'state');
  const [hasAgents, hasTasks] = await Promise.all([
    exists(path.join(stateRoot, 'agents.json')),
    exists(path.join(stateRoot, 'tasks.json'))
  ]);
  return !hasAgents || !hasTasks;
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
      repositoryDisplayState: 'offline',
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
    failures: [],
    phases: [],
    recentEvents: [],
    v4Operations: emptyV4OperationsSnapshot(),
    inspectionTemplates: INSPECTION_TEMPLATE_DEFINITIONS.map((template) => ({ ...template, activeRunId: null, lastReportRunId: null })),
    inspectionRuns: []
  };
}

export class RepositoryService {
  readonly #options: RepositoryServiceOptions;
  readonly #registry: ProjectRegistry;
  readonly #listeners = new Set<(snapshot: OrquestaUiSnapshot) => void>();
  #snapshot = emptySnapshot();
  #snapshotError: string | null = null;
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
      const selected = await this.selectRoot(this.#options.initialRootPath, 'detected_root');
      if (selected.status !== 'accepted') this.#snapshotError = selected.reason;
      return;
    }
    const current = this.#registry.currentProject();
    if (current) {
      const selected = await this.selectRoot(current.rootPath);
      if (selected.status === 'accepted') return;
      this.#snapshotError = selected.reason;
      return;
    }
    this.#emit();
  }

  subscribe(listener: (snapshot: OrquestaUiSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async getSnapshot(): Promise<OrquestaUiSnapshot> {
    if (this.#snapshotError) throw new Error(this.#snapshotError);
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

  getLucaRuntimeContext(): { projectId: string; rootPath: string; threadId: string | null } | null {
    return this.#registry.getLucaRuntimeContext();
  }

  setLucaThread(projectId: string, threadId: string): Promise<void> {
    return this.#registry.setLucaThread(projectId, threadId);
  }

  getLastLucaHomeSeenAt(projectId: string): string | null {
    return this.#registry.getLastLucaHomeSeenAt(projectId);
  }

  markLucaHomeSeen(projectId: string, at: string): Promise<void> {
    return this.#registry.markLucaHomeSeen(projectId, at);
  }

  async openProject(): Promise<UiActionResult> {
    const rootPath = await this.#registry.chooseRoot();
    if (!rootPath) return result('rejected', 'No project folder was selected.');
    return this.selectRoot(rootPath);
  }

  async selectRoot(rootPath: string, sourceKind: 'detected_root' | 'existing_folder' = 'existing_folder'): Promise<UiActionResult> {
    try {
      const requiresSetup = await (this.#options.requiresSetup ?? defaultRequiresSetup)(rootPath);
      if (requiresSetup && this.#options.prepareSetupSource) {
        await this.#options.prepareSetupSource({ kind: sourceKind, rootPath });
        this.#snapshot = emptySnapshot();
        this.#snapshotError = null;
        this.#emit();
        return result('accepted');
      }
      const next = await this.#options.coreHost.selectRepository(projectIdForRoot(rootPath), rootPath);
      this.#snapshot = structuredClone(next);
      this.#snapshotError = null;
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
