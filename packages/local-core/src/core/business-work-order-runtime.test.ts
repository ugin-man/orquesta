import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { readBusinessWorkOrders } from './business-work-order-runtime';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function request() {
  return {
    projectId: 'native-project',
    consumer: {
      name: 'orquesta.business-work-orders.read',
      major: 1,
      minMinor: 0,
      requiredFeatures: [
        'journal-prefix-continuity.v1',
        'root-journal-all-business-project-refs.v1',
        'work-order-index.v1'
      ]
    },
    afterCursor: null,
    query: { kind: 'index', limit: 25, afterKey: null }
  };
}

describe('Business Work Order runtime', () => {
  test('reads only the selected root journal through the bounded public model', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'orquesta-business-read-'));
    roots.push(root);
    await mkdir(path.join(root, '.orquesta', 'v4'), { recursive: true });
    const result = await readBusinessWorkOrders({
      request: request(),
      runtimeProjectId: 'native-project',
      rootPath: root
    });
    expect(result.runtimeProjectId).toBe('native-project');
    expect(result.continuity).toBe('initial');
    expect(result.page).toEqual({ kind: 'index', items: [], nextAfterKey: null });
  });
});
