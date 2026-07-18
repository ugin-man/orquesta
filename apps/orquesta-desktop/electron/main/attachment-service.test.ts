import { describe, expect, test } from 'vitest';
import { AttachmentService } from './attachment-service';

describe('AttachmentService', () => {
  test('returns opaque image ids and resolves only files chosen in this session', async () => {
    const service = new AttachmentService({
      choosePaths: async () => ['C:\\images\\map.png'],
      inspect: async () => ({ isFile: true, size: 1024 }),
      createId: () => 'attachment-1'
    });

    await expect(service.chooseImages()).resolves.toEqual([
      { id: 'attachment-1', name: 'map.png', kind: 'image', sizeBytes: 1024 }
    ]);
    expect(service.resolveImagePaths(['attachment-1'])).toEqual(['C:\\images\\map.png']);
    expect(() => service.resolveImagePaths(['unknown'])).toThrow('no longer available');
  });

  test('rejects oversized files before they reach the runtime', async () => {
    const service = new AttachmentService({
      choosePaths: async () => ['C:\\images\\huge.png'],
      inspect: async () => ({ isFile: true, size: 21 * 1024 * 1024 })
    });
    await expect(service.chooseImages()).rejects.toThrow('20 MB');
  });
});
