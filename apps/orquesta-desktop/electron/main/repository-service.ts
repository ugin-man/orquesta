import { randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ProjectSummary, UiActionResult } from '../../src/contracts/bridge';
import type { OrquestaUiSnapshot } from '../../src/contracts/orquesta-ui';
import { readRepositorySnapshot } from './repository-reader';

interface RegistryEntry extends ProjectSummary {
  rootPath: string;
}

interface RegistryDocument {
  version: 1;
  currentProjectId: string | null;
  projects: RegistryEntry[];
}

export interface RepositoryServiceOptions {
  registryPath: string;
  initialRootPath?: string | null;
  chooseDirectory?: () => Promise<string | null>;
  now?: () => Date;
}

function correlationId(): string {
  return randomUUID();
}

function result(status: 'accepted'): UiActionResult;
function result(status: 'rejected' | 'failed' | 'unavailable', reason: string, retryable?: boolean): UiActionResult;
function result(status: 'accepted' | 'rejected' | 'failed' | 'unavailable', reason = '', retryable = false): UiActionResult {
  return status === 'accepted'
    ? { status, correlationId: correlationId() }
    : { status, correlationId: correlationId(), reason, retryable };
}

function emptySnapshot(): OrquestaUiSnapshot {
  return {
    project: {
      id: 'no-project', title: 'No Orquesta project selected', rootPathLabel: null, status: 'offline',
      connectionLabel: 'Choose a project folder to begin', isDemoData: false, lastSyncedAt: null,
      currentPhaseId: null, agentCount: 0, provenWorkingAgentCount: 0,
      summary: 'No repository state is loaded.', nextMilestone: 'Open an Orquesta project folder'
    },
    agents: [], tasks: [], attention: [], phases: [], recentEvents: []
  };
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

function validRegistry(value: unknown): RegistryDocument | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const document = value as Record<string, unknown>;
  if (document.version !== 1 || !Array.isArray(document.projects)) return null;
  const projects = document.projects.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const entry = item as Record<string, unknown>;
    if (typeof entry.id !== 'string' || typeof entry.title !== 'string' || typeof entry.rootPath !== 'string' || typeof entry.lastOpenedAt !== 'string') return [];
    return [{
      id: entry.id,
      title: entry.title,
      rootPath: entry.rootPath,
      rootPathLabel: typeof entry.rootPathLabel === 'string' ? entry.rootPathLabel : entry.rootPath,
      status: ['ready', 'working', 'blocked', 'offline', 'unknown'].includes(String(entry.status)) ? entry.status as ProjectSummary['status'] : 'unknown',
      connectionLabel: typeof entry.connectionLabel === 'string' ? entry.connectionLabel : 'Saved project',
      lastOpenedAt: entry.lastOpenedAt
    }];
  });
  return {
    version: 1,
    currentProjectId: typeof document.currentProjectId === 'string' ? document.currentProjectId : null,
    projects
  };
}

export class RepositoryService {
  private readonly options: RepositoryServiceOptions;
  private registry: RegistryDocument = { version: 1, currentProjectId: null, projects: [] };
  private snapshot: OrquestaUiSnapshot = emptySnapshot();
  private currentRoot: string | null = null;
  private readonly listeners = new Set<(snapshot: OrquestaUiSnapshot) => void>();
  private watchers: FSWatcher[] = [];
  private refreshTimer: NodeJS.Timeout | null = null;

  constructor(options: RepositoryServiceOptions) {
    this.options = options;
  }

  async initialize(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.options.registryPath, 'utf8'));
      this.registry = validRegistry(parsed) ?? this.registry;
    } catch {
      // A missing or invalid app registry must not prevent first launch.
    }

    if (this.options.initialRootPath) {
      await this.selectRoot(this.options.initialRootPath);
      return;
    }
    const current = this.registry.projects.find((project) => project.id === this.registry.currentProjectId);
    if (current) {
      const selected = await this.selectRoot(current.rootPath);
      if (selected.status === 'accepted') return;
    }
    this.emit();
  }

  subscribe(listener: (snapshot: OrquestaUiSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener(structuredClone(this.snapshot));
  }

  async getSnapshot(): Promise<OrquestaUiSnapshot> {
    return structuredClone(this.snapshot);
  }

  async listProjects(): Promise<ProjectSummary[]> {
    return this.registry.projects.map(({ rootPath: _rootPath, ...project }) => structuredClone(project));
  }

  async openProject(): Promise<UiActionResult> {
    if (!this.options.chooseDirectory) return result('unavailable', 'Directory picker is unavailable.', true);
    const root = await this.options.chooseDirectory();
    if (!root) return result('rejected', 'No project folder was selected.');
    return this.selectRoot(root);
  }

  async selectRoot(rootPath: string): Promise<UiActionResult> {
    try {
      const next = await readRepositorySnapshot(rootPath, { now: this.options.now?.() });
      this.snapshot = next;
      this.currentRoot = next.project.rootPathLabel;
      const now = (this.options.now?.() ?? new Date()).toISOString();
      const entry: RegistryEntry = {
        id: next.project.id,
        title: next.project.title,
        rootPath: this.currentRoot!,
        rootPathLabel: next.project.rootPathLabel,
        status: next.project.status,
        connectionLabel: next.project.connectionLabel,
        lastOpenedAt: now
      };
      this.registry.projects = [entry, ...this.registry.projects.filter((project) => project.id !== entry.id)].slice(0, 24);
      this.registry.currentProjectId = entry.id;
      await this.persistRegistry();
      await this.startWatching(this.currentRoot!);
      this.emit();
      return result('accepted');
    } catch (error) {
      return result('rejected', error instanceof Error ? error.message : String(error));
    }
  }

  async switchProject(projectId: string): Promise<UiActionResult> {
    const project = this.registry.projects.find((item) => item.id === projectId);
    if (!project) return result('rejected', 'Unknown saved project.');
    return this.selectRoot(project.rootPath);
  }

  async refresh(): Promise<void> {
    if (!this.currentRoot) return;
    try {
      const next = await readRepositorySnapshot(this.currentRoot, { now: this.options.now?.() });
      this.snapshot = next;
      const entry = this.registry.projects.find((project) => project.id === next.project.id);
      if (entry) {
        entry.status = next.project.status;
        entry.connectionLabel = next.project.connectionLabel;
      }
    } catch (error) {
      this.snapshot = offlineSnapshot(this.snapshot, error instanceof Error ? error.message : String(error));
    }
    this.emit();
  }

  private async persistRegistry(): Promise<void> {
    await mkdir(path.dirname(this.options.registryPath), { recursive: true });
    await writeFile(this.options.registryPath, `${JSON.stringify(this.registry, null, 2)}\n`, 'utf8');
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, 180);
  }

  private async startWatching(root: string): Promise<void> {
    this.closeWatchers();
    const directories = [
      path.join(root, '.orquesta', 'state'),
      path.join(root, '.orquesta', 'vision'),
      path.join(root, '.orquesta', 'failures')
    ];
    for (const directory of directories) {
      try {
        if (!(await stat(directory)).isDirectory()) continue;
        const watcher = watch(directory, { persistent: false }, () => this.scheduleRefresh());
        watcher.on('error', () => undefined);
        this.watchers.push(watcher);
      } catch {
        // Optional directories can be absent in a valid minimum project.
      }
    }
  }

  private closeWatchers(): void {
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
  }

  async stop(): Promise<void> {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.closeWatchers();
    this.listeners.clear();
  }
}
