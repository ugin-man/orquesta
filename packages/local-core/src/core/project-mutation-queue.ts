import path from 'node:path';

/**
 * Orders project-local read/modify/write operations without rejecting concurrent
 * user actions. The project writer lease protects processes; this queue protects
 * independent actions inside the one Desktop Core process.
 */
export class ProjectMutationQueue {
  readonly #tails = new Map<string, Promise<void>>();

  async run<T>(rootPath: string, operation: () => Promise<T>): Promise<T> {
    const key = path.resolve(rootPath);
    const prior = this.#tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => { release = resolve; });
    const tail = prior.catch(() => undefined).then(() => turn);
    this.#tails.set(key, tail);
    await prior.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    }
  }
}
