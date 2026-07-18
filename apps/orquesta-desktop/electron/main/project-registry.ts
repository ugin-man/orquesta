import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ProjectSummary } from '../../src/contracts/bridge';
import type { OrquestaUiSnapshot } from '../../src/contracts/orquesta-ui';

interface RegistryEntry extends ProjectSummary {
  rootPath: string;
  coordinatorThreadId: string | null;
}

interface RegistryDocument {
  version: 1;
  currentProjectId: string | null;
  projects: RegistryEntry[];
}

export interface ProjectRegistryOptions {
  registryPath: string;
  chooseDirectory?: () => Promise<string | null>;
  now?: () => Date;
}

function validRegistry(value: unknown): RegistryDocument | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const document = value as Record<string, unknown>;
  if (document.version !== 1 || !Array.isArray(document.projects)) return null;
  const projects = document.projects.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const entry = item as Record<string, unknown>;
    if (typeof entry.id !== 'string' || typeof entry.title !== 'string'
      || typeof entry.rootPath !== 'string' || typeof entry.lastOpenedAt !== 'string') return [];
    return [{
      id: entry.id,
      title: entry.title,
      rootPath: entry.rootPath,
      rootPathLabel: typeof entry.rootPathLabel === 'string' ? entry.rootPathLabel : entry.rootPath,
      status: ['ready', 'working', 'blocked', 'offline', 'unknown'].includes(String(entry.status))
        ? entry.status as ProjectSummary['status'] : 'unknown',
      connectionLabel: typeof entry.connectionLabel === 'string' ? entry.connectionLabel : 'Saved project',
      lastOpenedAt: entry.lastOpenedAt,
      coordinatorThreadId: typeof entry.coordinatorThreadId === 'string'
        && /^[a-zA-Z0-9._:-]{1,128}$/u.test(entry.coordinatorThreadId) ? entry.coordinatorThreadId : null
    }];
  });
  return {
    version: 1,
    currentProjectId: typeof document.currentProjectId === 'string' ? document.currentProjectId : null,
    projects
  };
}

export function projectIdForRoot(rootPath: string): string {
  const normalized = path.resolve(rootPath).replaceAll('\\', '/').toLowerCase();
  return `repo-${createHash('sha256').update(normalized).digest('hex').slice(0, 16)}`;
}

export class ProjectRegistry {
  readonly #options: ProjectRegistryOptions;
  #document: RegistryDocument = { version: 1, currentProjectId: null, projects: [] };

  constructor(options: ProjectRegistryOptions) {
    this.#options = options;
  }

  async initialize(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.#options.registryPath, 'utf8'));
      this.#document = validRegistry(parsed) ?? this.#document;
    } catch {
      // A missing or invalid app-owned registry is a valid first-launch state.
    }
  }

  async chooseRoot(): Promise<string | null> {
    return this.#options.chooseDirectory?.() ?? null;
  }

  currentProject(): RegistryEntry | null {
    const project = this.#document.projects.find((item) => item.id === this.#document.currentProjectId);
    return project ? structuredClone(project) : null;
  }

  project(projectId: string): RegistryEntry | null {
    const project = this.#document.projects.find((item) => item.id === projectId);
    return project ? structuredClone(project) : null;
  }

  async remember(snapshot: OrquestaUiSnapshot): Promise<void> {
    const rootPath = snapshot.project.rootPathLabel;
    if (!rootPath) throw new Error('Projected repository root is unavailable');
    const existing = this.#document.projects.find((item) => item.id === snapshot.project.id);
    const entry: RegistryEntry = {
      id: snapshot.project.id,
      title: snapshot.project.title,
      rootPath,
      rootPathLabel: rootPath,
      status: snapshot.project.status,
      connectionLabel: snapshot.project.connectionLabel,
      lastOpenedAt: (this.#options.now?.() ?? new Date()).toISOString(),
      coordinatorThreadId: existing?.coordinatorThreadId ?? null
    };
    this.#document.projects = [entry, ...this.#document.projects.filter((item) => item.id !== entry.id)].slice(0, 24);
    this.#document.currentProjectId = entry.id;
    await this.#persist();
  }

  async updateProjection(snapshot: OrquestaUiSnapshot): Promise<void> {
    const project = this.#document.projects.find((item) => item.id === snapshot.project.id);
    if (!project) return;
    project.status = snapshot.project.status;
    project.connectionLabel = snapshot.project.connectionLabel;
    await this.#persist();
  }

  async listProjects(): Promise<ProjectSummary[]> {
    return this.#document.projects.map(({ rootPath: _rootPath, coordinatorThreadId: _threadId, ...project }) => structuredClone(project));
  }

  getCurrentRuntimeContext(): { projectId: string; rootPath: string; threadId: string | null } | null {
    const project = this.#document.projects.find((item) => item.id === this.#document.currentProjectId);
    return project ? { projectId: project.id, rootPath: project.rootPath, threadId: project.coordinatorThreadId } : null;
  }

  async setCoordinatorThread(projectId: string, threadId: string): Promise<void> {
    if (!/^[a-zA-Z0-9._:-]{1,128}$/u.test(threadId)) throw new Error('Invalid coordinator thread id');
    const project = this.#document.projects.find((item) => item.id === projectId);
    if (!project) throw new Error('Unknown project for coordinator thread');
    project.coordinatorThreadId = threadId;
    await this.#persist();
  }

  async #persist(): Promise<void> {
    await mkdir(path.dirname(this.#options.registryPath), { recursive: true });
    await writeFile(this.#options.registryPath, `${JSON.stringify(this.#document, null, 2)}\n`, 'utf8');
  }
}
