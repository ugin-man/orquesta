import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseSetupDraft, type SetupDraft } from '../../src/contracts/setup';

interface SetupDraftDocument {
  version: 1;
  draft: SetupDraft;
}

export class SetupDraftStore {
  readonly #storePath: string;

  constructor(options: { storePath: string }) {
    this.#storePath = options.storePath;
  }

  async read(): Promise<SetupDraft | null> {
    try {
      const value = JSON.parse(await readFile(this.#storePath, 'utf8')) as Partial<SetupDraftDocument>;
      if (value.version !== 1) return null;
      return parseSetupDraft(value.draft);
    } catch {
      return null;
    }
  }

  async save(input: SetupDraft): Promise<void> {
    const draft = parseSetupDraft(input);
    const directory = path.dirname(this.#storePath);
    const temporaryPath = `${this.#storePath}.${process.pid}.${Date.now()}.tmp`;
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(temporaryPath, `${JSON.stringify({ version: 1, draft }, null, 2)}\n`, 'utf8');
      await rename(temporaryPath, this.#storePath);
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  async clear(): Promise<void> {
    await rm(this.#storePath, { force: true });
  }
}
