import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { ComposerAttachment } from '../../src/contracts/bridge';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGES = 4;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

interface AttachmentServiceOptions {
  choosePaths(): Promise<string[]>;
  inspect?(filePath: string): Promise<{ isFile: boolean; size: number }>;
  createId?(): string;
}

export class AttachmentService {
  readonly #options: AttachmentServiceOptions;
  readonly #paths = new Map<string, string>();

  constructor(options: AttachmentServiceOptions) {
    this.#options = options;
  }

  async chooseImages(): Promise<ComposerAttachment[]> {
    const selected = (await this.#options.choosePaths()).slice(0, MAX_IMAGES);
    const attachments: ComposerAttachment[] = [];
    for (const filePath of selected) {
      if (!path.isAbsolute(filePath) || !IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
        throw new Error('Choose a PNG, JPEG, GIF, or WebP image.');
      }
      const metadata = this.#options.inspect
        ? await this.#options.inspect(filePath)
        : await stat(filePath).then((value) => ({ isFile: value.isFile(), size: value.size }));
      if (!metadata.isFile) throw new Error('The selected attachment is not a file.');
      if (metadata.size > MAX_IMAGE_BYTES) throw new Error('Each image attachment must be 20 MB or smaller.');
      const id = this.#options.createId?.() ?? randomUUID();
      this.#paths.set(id, filePath);
      attachments.push({ id, name: path.basename(filePath), kind: 'image', sizeBytes: metadata.size });
    }
    return attachments;
  }

  resolveImagePaths(ids: string[]): string[] {
    if (ids.length > MAX_IMAGES) throw new Error(`Attach no more than ${MAX_IMAGES} images.`);
    return ids.map((id) => {
      const filePath = this.#paths.get(id);
      if (!filePath) throw new Error('An attachment is no longer available. Choose it again.');
      return filePath;
    });
  }
}
