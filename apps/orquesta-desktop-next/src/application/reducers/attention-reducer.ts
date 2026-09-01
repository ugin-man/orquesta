import type { ApplicationState } from '../state';
import type {
  AttentionItem,
  ProjectedPendingRequest,
  ProjectedResolvedRequest,
} from '../../domain/models';

function projectedApprovalItem(
  request: ProjectedPendingRequest | ProjectedResolvedRequest,
  resolution: null | { resolvedAt: string; decision: string },
): AttentionItem | null {
  if (request.requestKind !== 'attention.approval_requested') return null;
  return {
    id: request.requestKey,
    sourceKind: 'runtime_approval',
    type: 'approval',
    actionKind: 'approve',
    priority: 'blocker',
    title: null,
    summary: null,
    sourceAgentId: request.agentId,
    taskId: null,
    blocking: resolution === null,
    createdAt: request.createdAt,
    resolvedAt: resolution?.resolvedAt ?? null,
    resolutionDecision: resolution?.decision ?? null,
    runtimeApproval: {
      requestedEffectKind: request.requestedEffectKind ?? 'other',
      responseOptions: [...request.responseOptions],
    },
  };
}

export function openAttentionItems(
  canonical: AttentionItem[],
  pending: ProjectedPendingRequest[],
): AttentionItem[] {
  const runtime = pending.flatMap((request) => {
    if (request.recoveryState !== 'actionable') return [];
    const item = projectedApprovalItem(request, null);
    return item ? [item] : [];
  });
  return [...runtime, ...canonical];
}

export function resolvedAttentionItems(resolved: ProjectedResolvedRequest[]): AttentionItem[] {
  return resolved.flatMap((request) => {
    const item = projectedApprovalItem(request, {
      resolvedAt: request.resolvedAt,
      decision: request.responseDecision,
    });
    return item ? [item] : [];
  });
}
