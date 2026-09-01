import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { PROJECT_STORAGE, projectStoragePath } from './project-storage-layout';

interface LeaseMetadata {
  schema_version: 1;
  pid: number;
  nonce: string;
  project_id: string;
  canonical_root: string;
  acquired_at: string;
}

interface ActiveLease {
  projectId: string;
  canonicalRoot: string;
  lockDirectory: string;
  nonce: string;
}

async function existingPathIsSymlink(filePath: string): Promise<boolean> {
  try {
    return (await lstat(filePath)).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function canonicalProjectRoot(rootPath: string): Promise<string> {
  const canonicalRoot = await realpath(path.resolve(rootPath));
  const orquestaRoot = path.join(canonicalRoot, '.orquesta');
  const stateRoot = projectStoragePath(canonicalRoot, PROJECT_STORAGE.canonicalState);
  if (await existingPathIsSymlink(orquestaRoot)) throw new Error('project_writer_symlink_boundary');
  await mkdir(orquestaRoot, { recursive: true });
  if (await existingPathIsSymlink(stateRoot)) throw new Error('project_writer_symlink_boundary');
  await mkdir(stateRoot, { recursive: true });
  const canonicalState = await realpath(stateRoot);
  const relative = path.relative(canonicalRoot, canonicalState);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('project_writer_root_escape');
  return canonicalRoot;
}

export class ProjectWriterLease {
  #lease: ActiveLease | null = null;
  #activeOperations = 0;
  #closing = false;
  #poisoned = false;
  #transitionCount = 0;
  #transition: Promise<void> = Promise.resolve();
  #drainWaiters = new Set<() => void>();

  get selectedProjectId(): string | null {
    return this.#lease?.projectId ?? null;
  }

  get selectedRootPath(): string | null {
    return this.#lease?.canonicalRoot ?? null;
  }

  hasSelectedWriter(): boolean {
    return this.#lease !== null && !this.#closing && !this.#poisoned;
  }

  select(rootPath: string, projectId: string): Promise<string> {
    this.#transitionCount += 1;
    this.#closing = true;
    return this.#enqueueTransition(async () => {
      try {
        const canonicalRoot = await canonicalProjectRoot(rootPath);
        if (this.#lease?.canonicalRoot === canonicalRoot && this.#lease.projectId === projectId) {
          return canonicalRoot;
        }
        await this.#drain();
        await this.#removeCurrentLease();
        return await this.#acquire(canonicalRoot, projectId);
      } catch (error) {
        if (this.#lease) this.#poisoned = true;
        throw error;
      } finally {
        this.#transitionCount -= 1;
        this.#closing = this.#transitionCount > 0 || this.#poisoned;
      }
    });
  }

  async #acquire(canonicalRoot: string, projectId: string): Promise<string> {
    const lockDirectory = projectStoragePath(canonicalRoot, PROJECT_STORAGE.writerLease);
    const nonce = randomUUID();
    const metadata: LeaseMetadata = {
      schema_version: 1,
      pid: process.pid,
      nonce,
      project_id: projectId,
      canonical_root: canonicalRoot,
      acquired_at: new Date().toISOString()
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let created = false;
      try {
        await mkdir(lockDirectory);
        created = true;
        if (await realpath(lockDirectory) !== lockDirectory) throw new Error('project_writer_symlink_boundary');
        const ownerPath = path.join(lockDirectory, 'owner.json');
        const ownerHandle = await open(
          ownerPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600
        );
        try {
          await ownerHandle.writeFile(`${JSON.stringify(metadata)}\n`, 'utf8');
          await ownerHandle.sync();
        } finally {
          await ownerHandle.close();
        }
        if ((await lstat(ownerPath)).isSymbolicLink()) throw new Error('project_writer_symlink_boundary');
        this.#lease = { projectId, canonicalRoot, lockDirectory, nonce };
        this.#poisoned = false;
        return canonicalRoot;
      } catch (error) {
        if (created) {
          await rm(lockDirectory, { recursive: true, force: true }).catch(() => undefined);
          throw new Error('project_writer_lease_unavailable', { cause: error });
        }
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt > 0) {
          throw new Error('project_writer_lease_unavailable', { cause: error });
        }
        let owner: Partial<LeaseMetadata> | null = null;
        try {
          owner = JSON.parse(await readFile(path.join(lockDirectory, 'owner.json'), 'utf8')) as Partial<LeaseMetadata>;
        } catch {
          throw new Error('project_writer_lease_identity_unknown');
        }
        if (processIsAlive(Number(owner.pid))) throw new Error('project_writer_lease_held');
        try {
          await writeFile(path.join(lockDirectory, 'reap.claim'), nonce, { encoding: 'utf8', flag: 'wx' });
        } catch (claimError) {
          if ((claimError as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new Error('project_writer_lease_reap_in_progress');
          }
          throw claimError;
        }
        const claimedOwner = JSON.parse(await readFile(path.join(lockDirectory, 'owner.json'), 'utf8')) as Partial<LeaseMetadata>;
        if (claimedOwner.nonce !== owner.nonce) throw new Error('project_writer_lease_identity_changed');
        await rm(lockDirectory, { recursive: true, force: true });
      }
    }
    throw new Error('project_writer_lease_unavailable');
  }

  run<T>(rootPath: string, projectId: string, operation: (canonicalRoot: string) => Promise<T>): Promise<T> {
    const reservedLease = this.#lease;
    if (!reservedLease || this.#closing || this.#poisoned || reservedLease.projectId !== projectId) {
      return Promise.reject(new Error('project_writer_lease_not_selected'));
    }
    this.#activeOperations += 1;
    return (async () => {
      try {
        const canonicalRoot = await realpath(path.resolve(rootPath));
        if (this.#lease !== reservedLease || canonicalRoot !== reservedLease.canonicalRoot) {
          throw new Error('project_writer_root_mismatch');
        }
        const canonicalState = await realpath(projectStoragePath(canonicalRoot, PROJECT_STORAGE.canonicalState));
        if (path.dirname(reservedLease.lockDirectory) !== canonicalState) {
          throw new Error('project_writer_symlink_boundary');
        }
        return await operation(canonicalRoot);
      } finally {
        this.#activeOperations -= 1;
        if (this.#activeOperations === 0) {
          for (const resolve of this.#drainWaiters) resolve();
          this.#drainWaiters.clear();
        }
      }
    })();
  }

  async runSelected<T>(operation: (lease: { projectId: string; rootPath: string }) => Promise<T>): Promise<T> {
    const lease = this.#lease;
    if (!lease) throw new Error('project_writer_lease_not_selected');
    return this.run(lease.canonicalRoot, lease.projectId, () => operation({
      projectId: lease.projectId,
      rootPath: lease.canonicalRoot
    }));
  }

  release(): Promise<void> {
    this.#transitionCount += 1;
    this.#closing = true;
    return this.#enqueueTransition(async () => {
      try {
        await this.#drain();
        await this.#removeCurrentLease();
      } catch (error) {
        if (this.#lease) this.#poisoned = true;
        throw error;
      } finally {
        this.#transitionCount -= 1;
        this.#closing = this.#transitionCount > 0 || this.#poisoned;
      }
    });
  }

  close<T>(operation: () => Promise<T>): Promise<T> {
    this.#transitionCount += 1;
    this.#closing = true;
    return this.#enqueueTransition(async () => {
      try {
        await this.#drain();
        const result = await operation();
        await this.#removeCurrentLease();
        return result;
      } catch (error) {
        if (this.#lease) this.#poisoned = true;
        throw error;
      } finally {
        this.#transitionCount -= 1;
        this.#closing = this.#transitionCount > 0 || this.#poisoned;
      }
    });
  }

  async #drain(): Promise<void> {
    if (this.#activeOperations > 0) {
      await new Promise<void>((resolve) => this.#drainWaiters.add(resolve));
    }
  }

  async #removeCurrentLease(): Promise<void> {
    const lease = this.#lease;
    if (!lease) return;
    const owner = JSON.parse(await readFile(path.join(lease.lockDirectory, 'owner.json'), 'utf8')) as Partial<LeaseMetadata>;
    if (owner.nonce !== lease.nonce) throw new Error('project_writer_lease_identity_changed');
    await rm(lease.lockDirectory, { recursive: true, force: false });
    if (this.#lease === lease) this.#lease = null;
    this.#poisoned = false;
  }

  #enqueueTransition<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#transition.then(operation);
    this.#transition = result.then(() => undefined, () => undefined);
    return result;
  }
}
