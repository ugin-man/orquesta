import { describe, expect, test, vi } from 'vitest';
import type { ProvisioningBatch } from './specialist-provisioner';
import { createSpecialistProvisioningCoordinator } from './specialist-provisioning-coordinator';

const batch: ProvisioningBatch = {
  provisioning_batch_id: 'BATCH-1',
  organization_revision: 1,
  max_concurrent_provisioning: 1,
  requests: [],
  created_at: '2026-07-22T00:00:00.000Z'
};

describe('specialist provisioning coordinator', () => {
  test('coalesces runner and repository requests for the same batch', async () => {
    let release!: () => void;
    const operation = new Promise<ProvisioningBatch>((resolve) => { release = () => resolve(batch); });
    const provision = vi.fn(async () => operation);
    const coordinator = createSpecialistProvisioningCoordinator(provision);
    const input = { rootPath: 'C:\\repo', projectId: 'demo', batch };

    const fromRunner = coordinator(input);
    const fromRepository = coordinator(input);

    expect(provision).toHaveBeenCalledOnce();
    release();
    await expect(Promise.all([fromRunner, fromRepository])).resolves.toEqual([batch, batch]);
  });
});
