import path from 'node:path';
import type { ProvisioningBatch } from './specialist-provisioner';

export interface CoordinatedProvisioningInput {
  rootPath: string;
  projectId: string;
  batch: ProvisioningBatch;
}

export function createSpecialistProvisioningCoordinator(
  provision: (input: CoordinatedProvisioningInput) => Promise<ProvisioningBatch>
) {
  const active = new Map<string, Promise<ProvisioningBatch>>();
  return (input: CoordinatedProvisioningInput): Promise<ProvisioningBatch> => {
    const key = `${path.resolve(input.rootPath).toLocaleLowerCase('en-US')}\u0000${input.batch.provisioning_batch_id}`;
    const existing = active.get(key);
    if (existing) return existing;
    const operation = provision(input).finally(() => active.delete(key));
    active.set(key, operation);
    return operation;
  };
}
