import { randomUUID as nodeRandomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { access, mkdir, readFile, readdir, realpath, rename, rm, rmdir, stat } from 'node:fs/promises';
import path from 'node:path';
import git from 'isomorphic-git';
import http from 'isomorphic-git/http/node';
import { isSetupSourceDraft, type SetupSourceDraft } from '../../src/contracts/setup';

interface CloneRepositoryInput {
  url: string;
  dir: string;
  depth: 1;
}

interface SetupSourceServiceOptions {
  cloneRepository?: (input: CloneRepositoryInput) => Promise<void>;
  randomUUID?: () => string;
}

export interface MaterializedSetupSource {
  rootPath: string;
  createdByApp: boolean;
  rollback(): Promise<void>;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function canonicalDirectory(directoryPath: string, label: string): Promise<string> {
  if (!path.isAbsolute(directoryPath)) throw new Error(`${label} must be an absolute path`);
  const resolved = await realpath(directoryPath);
  if (!(await stat(resolved)).isDirectory()) throw new Error(`${label} must be a directory`);
  return resolved;
}

async function prepareDestinationParent(parentPath: string): Promise<{ path: string; created: boolean }> {
  if (!path.isAbsolute(parentPath)) throw new Error('Project destination must be an absolute path');
  const created = !await exists(parentPath);
  if (created) await mkdir(parentPath, { recursive: true });
  try {
    return { path: await canonicalDirectory(parentPath, 'Project destination'), created };
  } catch (error) {
    if (created) await rm(parentPath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function repositoryName(repositoryUrl: string): string {
  const parsed = new URL(repositoryUrl);
  return parsed.pathname.split('/').filter(Boolean).at(-1)!.replace(/\.git$/iu, '');
}

function childPath(parentPath: string, folderName: string): string {
  const target = path.resolve(parentPath, folderName);
  const relative = path.relative(parentPath, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Project folder must be inside the selected destination');
  return target;
}

async function findLfsAttributes(rootPath: string): Promise<string | null> {
  const visit = async (directory: string): Promise<string | null> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        const nested = await visit(entryPath);
        if (nested) return nested;
      } else if (entry.isFile() && entry.name === '.gitattributes') {
        const contents = await readFile(entryPath, 'utf8');
        if (/(?:filter|diff|merge)\s*=\s*lfs\b/iu.test(contents)) return entryPath;
      }
    }
    return null;
  };
  return visit(rootPath);
}

async function defaultCloneRepository(input: CloneRepositoryInput): Promise<void> {
  await git.clone({
    fs,
    http,
    dir: input.dir,
    url: input.url,
    singleBranch: true,
    depth: input.depth,
    noTags: true
  });
}

function rollbackFor(rootPath: string, createdParentPath: string | null): () => Promise<void> {
  let active = true;
  return async () => {
    if (!active) return;
    active = false;
    await rm(rootPath, { recursive: true, force: true });
    if (createdParentPath) await rmdir(createdParentPath).catch(() => undefined);
  };
}

export class SetupSourceService {
  readonly #cloneRepository: (input: CloneRepositoryInput) => Promise<void>;
  readonly #randomUUID: () => string;

  constructor(options: SetupSourceServiceOptions = {}) {
    this.#cloneRepository = options.cloneRepository ?? defaultCloneRepository;
    this.#randomUUID = options.randomUUID ?? nodeRandomUUID;
  }

  async materialize(source: SetupSourceDraft): Promise<MaterializedSetupSource> {
    if (!isSetupSourceDraft(source)) throw new TypeError('Invalid setup source');
    if (source.kind === 'detected_root' || source.kind === 'existing_folder') {
      const rootPath = await canonicalDirectory(source.rootPath, 'Project root');
      return { rootPath, createdByApp: false, rollback: async () => undefined };
    }

    const destination = await prepareDestinationParent(source.parentPath);
    const parentPath = destination.path;
    const folderName = source.kind === 'new_project' ? source.folderName : repositoryName(source.repositoryUrl);
    const rootPath = childPath(parentPath, folderName);
    if (await exists(rootPath)) {
      if (destination.created) await rmdir(parentPath).catch(() => undefined);
      throw new Error(`Project destination already exists: ${rootPath}`);
    }

    if (source.kind === 'new_project') {
      try {
        await mkdir(rootPath, { recursive: false });
        return { rootPath, createdByApp: true, rollback: rollbackFor(rootPath, destination.created ? parentPath : null) };
      } catch (error) {
        if (destination.created) await rmdir(parentPath).catch(() => undefined);
        throw error;
      }
    }

    const stagingRoot = path.join(parentPath, `.orquesta-source-${this.#randomUUID()}.tmp`);
    if (await exists(stagingRoot)) throw new Error('A setup source staging directory already exists');
    try {
      try {
        await this.#cloneRepository({ url: source.repositoryUrl, dir: stagingRoot, depth: 1 });
      } catch (error) {
        throw new Error('GitHub repository could not be downloaded. Use a public HTTPS repository or choose an already downloaded folder.', { cause: error });
      }
      if (await exists(path.join(stagingRoot, '.gitmodules'))) {
        throw new Error('GitHub repositories with submodules are not supported during initial setup');
      }
      if (await findLfsAttributes(stagingRoot)) {
        throw new Error('Git LFS repositories are not supported during initial setup');
      }
      await rename(stagingRoot, rootPath);
      return { rootPath, createdByApp: true, rollback: rollbackFor(rootPath, destination.created ? parentPath : null) };
    } catch (error) {
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
      if (destination.created) await rmdir(parentPath).catch(() => undefined);
      throw error;
    }
  }
}
