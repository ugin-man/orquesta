import type { RuntimeStatus } from '../../domain/models';

export function statusChanged(left: RuntimeStatus | null, right: RuntimeStatus): boolean {
  return !left
    || left.lifecycle !== right.lifecycle
    || left.projectId !== right.projectId
    || left.activationToken !== right.activationToken
    || left.runtimeGeneration !== right.runtimeGeneration
    || left.rendererSessionId !== right.rendererSessionId
    || left.rendererGeneration !== right.rendererGeneration
    || left.statusRevision !== right.statusRevision;
}

export function sameRuntimeIncarnation(left: RuntimeStatus | null, right: RuntimeStatus): boolean {
  return Boolean(left)
    && left?.projectId === right.projectId
    && left?.activationToken === right.activationToken
    && left?.runtimeGeneration === right.runtimeGeneration
    && left?.rendererSessionId === right.rendererSessionId
    && left?.rendererGeneration === right.rendererGeneration;
}

export function sameRuntimeStatus(left: RuntimeStatus, right: RuntimeStatus): boolean {
  return !statusChanged(left, right) && left.failureReason === right.failureReason;
}
