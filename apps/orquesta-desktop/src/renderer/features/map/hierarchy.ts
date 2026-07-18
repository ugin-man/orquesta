import type { AgentUiModel } from '../../../contracts/orquesta-ui';

export type HierarchyParentId = string | 'user';
export type HierarchyDiagnosticKind = 'missing_parent' | 'cycle' | 'self_parent';

export interface AgentHierarchy {
  rootIds: string[];
  parentByAgentId: Map<string, HierarchyParentId>;
  childrenByParentId: Map<HierarchyParentId, string[]>;
  depthByAgentId: Map<string, number>;
  diagnostics: Array<{ agentId: string; kind: HierarchyDiagnosticKind }>;
}

export function buildAgentHierarchy(agents: AgentUiModel[]): AgentHierarchy {
  const uniqueAgents: AgentUiModel[] = [];
  const agentById = new Map<string, AgentUiModel>();
  for (const item of agents) {
    if (agentById.has(item.id)) continue;
    agentById.set(item.id, item);
    uniqueAgents.push(item);
  }

  const orderById = new Map(uniqueAgents.map((item, index) => [item.id, index]));
  const hasOrchestrator = agentById.has('orchestrator');
  const parentByAgentId = new Map<string, HierarchyParentId>();
  const diagnosticByAgentId = new Map<string, HierarchyDiagnosticKind>();
  const fallbackParent = (agentId: string): HierarchyParentId =>
    hasOrchestrator && agentId !== 'orchestrator' ? 'orchestrator' : 'user';

  for (const item of uniqueAgents) {
    if (item.id === 'orchestrator') {
      parentByAgentId.set(item.id, 'user');
      continue;
    }

    const candidate = item.assignedByAgentId;
    if (!candidate) {
      parentByAgentId.set(item.id, fallbackParent(item.id));
    } else if (candidate === 'user') {
      parentByAgentId.set(item.id, 'user');
    } else if (candidate === item.id) {
      parentByAgentId.set(item.id, fallbackParent(item.id));
      diagnosticByAgentId.set(item.id, 'self_parent');
    } else if (!agentById.has(candidate)) {
      parentByAgentId.set(item.id, fallbackParent(item.id));
      diagnosticByAgentId.set(item.id, 'missing_parent');
    } else {
      parentByAgentId.set(item.id, candidate);
    }
  }

  const visitState = new Map<string, 'visiting' | 'visited'>();
  const stack: string[] = [];
  const cycleAgentIds = new Set<string>();
  const visit = (agentId: string) => {
    if (visitState.get(agentId) === 'visited') return;
    if (visitState.get(agentId) === 'visiting') {
      const cycleStart = stack.lastIndexOf(agentId);
      for (const cycleId of stack.slice(cycleStart)) cycleAgentIds.add(cycleId);
      return;
    }

    visitState.set(agentId, 'visiting');
    stack.push(agentId);
    const parentId = parentByAgentId.get(agentId);
    if (parentId && parentId !== 'user') visit(parentId);
    stack.pop();
    visitState.set(agentId, 'visited');
  };

  for (const item of uniqueAgents) visit(item.id);
  for (const item of uniqueAgents) {
    if (!cycleAgentIds.has(item.id)) continue;
    parentByAgentId.set(item.id, fallbackParent(item.id));
    diagnosticByAgentId.set(item.id, 'cycle');
  }

  const childrenByParentId = new Map<HierarchyParentId, string[]>();
  childrenByParentId.set('user', []);
  for (const item of uniqueAgents) childrenByParentId.set(item.id, []);
  for (const item of uniqueAgents) {
    const parentId = parentByAgentId.get(item.id) ?? fallbackParent(item.id);
    const children = childrenByParentId.get(parentId) ?? [];
    children.push(item.id);
    childrenByParentId.set(parentId, children);
  }
  for (const children of childrenByParentId.values()) {
    children.sort((left, right) =>
      (orderById.get(left) ?? Number.MAX_SAFE_INTEGER) - (orderById.get(right) ?? Number.MAX_SAFE_INTEGER)
      || left.localeCompare(right));
  }

  const depthByAgentId = new Map<string, number>();
  const queue = (childrenByParentId.get('user') ?? []).map((agentId) => ({ agentId, depth: 1 }));
  while (queue.length) {
    const current = queue.shift()!;
    if (depthByAgentId.has(current.agentId)) continue;
    depthByAgentId.set(current.agentId, current.depth);
    for (const childId of childrenByParentId.get(current.agentId) ?? []) {
      queue.push({ agentId: childId, depth: current.depth + 1 });
    }
  }

  return {
    rootIds: [...(childrenByParentId.get('user') ?? [])],
    parentByAgentId,
    childrenByParentId,
    depthByAgentId,
    diagnostics: uniqueAgents.flatMap((item) => {
      const kind = diagnosticByAgentId.get(item.id);
      return kind ? [{ agentId: item.id, kind }] : [];
    })
  };
}
